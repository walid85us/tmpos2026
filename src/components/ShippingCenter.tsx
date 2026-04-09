import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { Shipment, ShipmentStatus, ShipmentSourceType, ShipmentType, ShipmentAddress, ShipmentPackage, ShipmentEvent } from '../types';
import PageShell from './PageShell';

const STATUS_ORDER: ShipmentStatus[] = ['Draft', 'Ready', 'Label Created', 'Packed', 'Dispatched', 'In Transit', 'Delivered', 'Exception', 'Cancelled'];

const STATUS_COLORS: Record<ShipmentStatus, string> = {
  'Draft': 'bg-slate-100 text-slate-600 border-slate-200',
  'Ready': 'bg-blue-50 text-blue-700 border-blue-200',
  'Label Created': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'Packed': 'bg-violet-50 text-violet-700 border-violet-200',
  'Dispatched': 'bg-amber-50 text-amber-700 border-amber-200',
  'In Transit': 'bg-sky-50 text-sky-700 border-sky-200',
  'Delivered': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Exception': 'bg-red-50 text-red-700 border-red-200',
  'Cancelled': 'bg-slate-50 text-slate-400 border-slate-200',
};

const TYPE_LABELS: Record<ShipmentType, string> = {
  'customer_delivery': 'Customer Delivery',
  'repair_return': 'Repair Return',
  'store_transfer': 'Store Transfer',
  'rma_outbound': 'RMA Outbound',
  'rma_return': 'RMA Return',
};

const SOURCE_LABELS: Record<ShipmentSourceType, string> = {
  'invoice': 'Invoice',
  'repair': 'Repair',
  'transfer': 'Transfer',
  'rma': 'RMA',
};

const SOURCE_ICONS: Record<ShipmentSourceType, string> = {
  'invoice': 'receipt_long',
  'repair': 'build',
  'transfer': 'swap_horiz',
  'rma': 'assignment_return',
};

const CARRIERS = ['UPS', 'FedEx', 'USPS', 'DHL', 'Internal Courier', 'Other'];
const SERVICE_LEVELS = ['Ground', 'Express', 'Priority Overnight', 'Priority Mail', '2-Day', 'Same Day', 'Economy', 'Freight'];

function formatAddress(addr: ShipmentAddress): string {
  const parts = [addr.name];
  if (addr.company) parts.push(addr.company);
  parts.push(addr.line1);
  if (addr.line2) parts.push(addr.line2);
  parts.push(`${addr.city}, ${addr.state} ${addr.postalCode}`);
  return parts.join(', ');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function ShippingCenter() {
  const { shipments, addShipment, updateShipment } = useStoreLocalState();
  const { checkPermission, checkSubPermission } = useAccess();

  const canView = checkPermission('shipping', 'view');
  const canCreate = checkSubPermission('create_shipment');
  const canEditPreDispatch = checkSubPermission('edit_shipment_pre_dispatch');
  const canDispatch = checkSubPermission('dispatch_shipment');
  const canUpdateTracking = checkSubPermission('update_tracking_events');
  const canCancel = checkSubPermission('cancel_shipment');
  const canViewCosts = checkSubPermission('view_shipping_costs');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ShipmentStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<ShipmentSourceType | 'all'>('all');
  const [selectedShipment, setSelectedShipment] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'tracking' | 'packages'>('overview');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingShipment, setEditingShipment] = useState<string | null>(null);
  const [showStatusConfirm, setShowStatusConfirm] = useState<{ id: string; newStatus: ShipmentStatus; label: string } | null>(null);
  const [addEventModal, setAddEventModal] = useState<string | null>(null);
  const [eventDescription, setEventDescription] = useState('');
  const [eventLocation, setEventLocation] = useState('');

  const [newCarrier, setNewCarrier] = useState('');
  const [newService, setNewService] = useState('');
  const [newTracking, setNewTracking] = useState('');
  const [newCost, setNewCost] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newOrigin, setNewOrigin] = useState<ShipmentAddress>({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
  const [newDest, setNewDest] = useState<ShipmentAddress>({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
  const [newSourceType, setNewSourceType] = useState<ShipmentSourceType>('invoice');
  const [newSourceNumber, setNewSourceNumber] = useState('');
  const [newType, setNewType] = useState<ShipmentType>('customer_delivery');
  const [newPackages, setNewPackages] = useState<ShipmentPackage[]>([]);

  const filtered = useMemo(() => {
    let items = [...shipments];
    if (statusFilter !== 'all') items = items.filter(s => s.status === statusFilter);
    if (sourceFilter !== 'all') items = items.filter(s => s.sourceType === sourceFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(s =>
        s.shipmentNumber.toLowerCase().includes(q) ||
        (s.trackingNumber && s.trackingNumber.toLowerCase().includes(q)) ||
        s.destinationAddress.name.toLowerCase().includes(q) ||
        s.sourceNumber.toLowerCase().includes(q) ||
        (s.carrier && s.carrier.toLowerCase().includes(q))
      );
    }
    return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [shipments, statusFilter, sourceFilter, search]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: shipments.length };
    STATUS_ORDER.forEach(s => { counts[s] = shipments.filter(sh => sh.status === s).length; });
    return counts;
  }, [shipments]);

  const isPreDispatch = (status: ShipmentStatus) => ['Draft', 'Ready', 'Label Created', 'Packed'].includes(status);

  function handleStatusTransition(id: string, newStatus: ShipmentStatus) {
    const now = new Date().toISOString();
    const updates: Partial<Shipment> = { status: newStatus, updatedAt: now };
    const shipment = shipments.find(s => s.id === id);
    if (!shipment) return;

    if (newStatus === 'Dispatched') updates.dispatchedAt = now;
    if (newStatus === 'Delivered') updates.deliveredAt = now;

    const newEvent: ShipmentEvent = {
      id: `evt-${Date.now()}`,
      timestamp: now,
      status: newStatus,
      description: `Status changed to ${newStatus}`,
      performedBy: 'Current User',
    };
    updates.events = [...shipment.events, newEvent];
    updateShipment(id, updates);
    setShowStatusConfirm(null);
  }

  function handleCreateShipment() {
    const now = new Date().toISOString();
    const shipment: Shipment = {
      id: `shp-${Date.now()}`,
      shipmentNumber: `SHP-${new Date().getFullYear()}-${String(shipments.length + 1).padStart(3, '0')}`,
      type: newType,
      status: 'Draft',
      sourceType: newSourceType,
      sourceId: `src-${Date.now()}`,
      sourceNumber: newSourceNumber || 'N/A',
      originAddress: newOrigin,
      destinationAddress: newDest,
      packages: newPackages,
      carrier: newCarrier || undefined,
      serviceLevel: newService || undefined,
      trackingNumber: newTracking || undefined,
      shippingCost: newCost ? parseFloat(newCost) : undefined,
      notes: newNotes || undefined,
      events: [{ id: `evt-${Date.now()}`, timestamp: now, status: 'Created', description: 'Shipment created', performedBy: 'Current User' }],
      createdBy: 'Current User',
      createdAt: now,
      updatedAt: now,
    };
    addShipment(shipment);
    resetCreateForm();
    setShowCreateModal(false);
  }

  function handleSaveEdit() {
    if (!editingShipment) return;
    const now = new Date().toISOString();
    updateShipment(editingShipment, {
      carrier: newCarrier || undefined,
      serviceLevel: newService || undefined,
      trackingNumber: newTracking || undefined,
      shippingCost: newCost ? parseFloat(newCost) : undefined,
      notes: newNotes || undefined,
      updatedAt: now,
    });
    setEditingShipment(null);
  }

  function handleAddEvent(shipmentId: string) {
    if (!eventDescription.trim()) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    const newEvent: ShipmentEvent = {
      id: `evt-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: shipment.status,
      description: eventDescription,
      location: eventLocation || undefined,
      performedBy: 'Current User',
    };
    updateShipment(shipmentId, { events: [...shipment.events, newEvent], updatedAt: new Date().toISOString() });
    setAddEventModal(null);
    setEventDescription('');
    setEventLocation('');
  }

  function resetCreateForm() {
    setNewCarrier(''); setNewService(''); setNewTracking(''); setNewCost(''); setNewNotes('');
    setNewOrigin({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
    setNewDest({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
    setNewSourceType('invoice'); setNewSourceNumber(''); setNewType('customer_delivery'); setNewPackages([]);
  }

  function openEditModal(s: Shipment) {
    setNewCarrier(s.carrier || ''); setNewService(s.serviceLevel || '');
    setNewTracking(s.trackingNumber || ''); setNewCost(s.shippingCost?.toString() || '');
    setNewNotes(s.notes || '');
    setEditingShipment(s.id);
  }

  function getNextStatuses(current: ShipmentStatus): ShipmentStatus[] {
    const transitions: Record<ShipmentStatus, ShipmentStatus[]> = {
      'Draft': ['Ready', 'Cancelled'],
      'Ready': ['Label Created', 'Packed', 'Cancelled'],
      'Label Created': ['Packed', 'Cancelled'],
      'Packed': ['Dispatched', 'Cancelled'],
      'Dispatched': ['In Transit'],
      'In Transit': ['Delivered', 'Exception'],
      'Delivered': [],
      'Exception': ['In Transit', 'Cancelled'],
      'Cancelled': [],
    };
    return transitions[current] || [];
  }

  function canDoTransition(status: ShipmentStatus, newStatus: ShipmentStatus): boolean {
    if (newStatus === 'Cancelled') return canCancel;
    if (newStatus === 'Dispatched') return canDispatch;
    if (['In Transit', 'Delivered', 'Exception'].includes(newStatus)) return canUpdateTracking;
    return canEditPreDispatch;
  }

  if (!canView) {
    return (
      <PageShell title="Shipping Center">
        <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center">
          <span className="material-symbols-outlined text-4xl text-slate-300 mb-4">lock</span>
          <p className="text-sm font-bold text-slate-400">You do not have permission to view the Shipping Center.</p>
        </div>
      </PageShell>
    );
  }

  const selectedShip = selectedShipment ? shipments.find(s => s.id === selectedShipment) : null;

  return (
    <PageShell title="Shipping Center">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="relative flex-1 max-w-md">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg">search</span>
              <input
                type="text"
                placeholder="Search shipments, tracking, recipient..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-11 pr-4 py-3 bg-white/80 backdrop-blur-xl border border-slate-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>
          {canCreate && (
            <button
              onClick={() => { resetCreateForm(); setShowCreateModal(true); }}
              className="px-6 py-3 bg-primary text-white font-black text-[10px] uppercase tracking-widest rounded-2xl hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-2 shadow-lg shadow-primary/20"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              New Shipment
            </button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {(['all', ...STATUS_ORDER] as const).map(status => (
            <button
              key={status}
              onClick={() => setStatusFilter(status as ShipmentStatus | 'all')}
              className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest whitespace-nowrap transition-all ${
                statusFilter === status
                  ? 'bg-primary text-white shadow-lg shadow-primary/20'
                  : 'bg-white/80 text-slate-500 hover:bg-slate-100 border border-slate-200'
              }`}
            >
              {status === 'all' ? 'All' : status} {statusCounts[status] ? `(${statusCounts[status]})` : ''}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          {(['all', 'invoice', 'repair', 'transfer', 'rma'] as const).map(src => (
            <button
              key={src}
              onClick={() => setSourceFilter(src as ShipmentSourceType | 'all')}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                sourceFilter === src
                  ? 'bg-slate-800 text-white'
                  : 'bg-white/60 text-slate-400 hover:text-slate-600 border border-slate-200'
              }`}
            >
              {src === 'all' ? 'All Sources' : SOURCE_LABELS[src]}
            </button>
          ))}
        </div>

        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center py-16">
              <span className="material-symbols-outlined text-4xl text-slate-300 mb-3">local_shipping</span>
              <p className="text-sm font-bold text-slate-400">No shipments found</p>
              <p className="text-xs text-slate-400 mt-1">Create a new shipment or adjust your filters</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filtered.map(s => (
                <div
                  key={s.id}
                  onClick={() => { setSelectedShipment(s.id); setDetailTab('overview'); }}
                  className="px-8 py-5 hover:bg-slate-50/80 cursor-pointer transition-all flex items-center gap-6"
                >
                  <div className="w-10 h-10 rounded-2xl bg-primary/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-primary text-lg">{SOURCE_ICONS[s.sourceType]}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-sm font-black text-slate-800">{s.shipmentNumber}</span>
                      <span className={`px-2.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-lg border ${STATUS_COLORS[s.status]}`}>{s.status}</span>
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{TYPE_LABELS[s.type]}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">{SOURCE_ICONS[s.sourceType]}</span>
                        {s.sourceNumber}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">person</span>
                        {s.destinationAddress.name}
                      </span>
                      {s.carrier && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs">local_shipping</span>{s.carrier}</span>}
                      {s.trackingNumber && <span className="font-mono text-[10px] text-slate-400">{s.trackingNumber.slice(0, 15)}{s.trackingNumber.length > 15 ? '...' : ''}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {canViewCosts && s.shippingCost !== undefined && (
                      <p className="text-sm font-black text-primary">${s.shippingCost.toFixed(2)}</p>
                    )}
                    <p className="text-[10px] text-slate-400">{formatDate(s.createdAt)}</p>
                  </div>
                  <span className="material-symbols-outlined text-slate-300 text-lg">chevron_right</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selectedShip && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-3xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h2 className="text-xl font-black text-primary">{selectedShip.shipmentNumber}</h2>
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_COLORS[selectedShip.status]}`}>{selectedShip.status}</span>
                  </div>
                  <p className="text-sm text-slate-500">{TYPE_LABELS[selectedShip.type]} · {SOURCE_LABELS[selectedShip.sourceType]} {selectedShip.sourceNumber}</p>
                </div>
                <div className="flex items-center gap-2">
                  {canEditPreDispatch && isPreDispatch(selectedShip.status) && (
                    <button onClick={(e) => { e.stopPropagation(); openEditModal(selectedShip); }} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary transition-all">
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
                  )}
                  <button onClick={() => setSelectedShipment(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>

              <div className="flex border-b border-slate-100 bg-slate-50/30 shrink-0">
                {(['overview', 'tracking', 'packages'] as const).map(tab => (
                  <button key={tab} onClick={() => setDetailTab(tab)} className={`flex-1 py-3.5 text-[10px] font-black uppercase tracking-widest transition-all ${detailTab === tab ? 'text-primary border-b-2 border-primary bg-white/50' : 'text-slate-400 hover:text-slate-600'}`}>
                    {tab === 'overview' ? 'Overview' : tab === 'tracking' ? 'Tracking & Events' : 'Packages'}
                  </button>
                ))}
              </div>

              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                {detailTab === 'overview' && (
                  <>
                    <div className="grid grid-cols-2 gap-6">
                      <div className="bg-slate-50 rounded-2xl p-5 space-y-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">location_on</span>Origin</p>
                        <div className="text-sm text-slate-700 space-y-0.5">
                          <p className="font-black">{selectedShip.originAddress.name}</p>
                          {selectedShip.originAddress.company && <p className="text-slate-500">{selectedShip.originAddress.company}</p>}
                          <p>{selectedShip.originAddress.line1}</p>
                          {selectedShip.originAddress.line2 && <p>{selectedShip.originAddress.line2}</p>}
                          <p>{selectedShip.originAddress.city}, {selectedShip.originAddress.state} {selectedShip.originAddress.postalCode}</p>
                          {selectedShip.originAddress.phone && <p className="text-slate-400 text-xs">{selectedShip.originAddress.phone}</p>}
                        </div>
                      </div>
                      <div className="bg-slate-50 rounded-2xl p-5 space-y-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">flag</span>Destination</p>
                        <div className="text-sm text-slate-700 space-y-0.5">
                          <p className="font-black">{selectedShip.destinationAddress.name}</p>
                          {selectedShip.destinationAddress.company && <p className="text-slate-500">{selectedShip.destinationAddress.company}</p>}
                          <p>{selectedShip.destinationAddress.line1}</p>
                          {selectedShip.destinationAddress.line2 && <p>{selectedShip.destinationAddress.line2}</p>}
                          <p>{selectedShip.destinationAddress.city}, {selectedShip.destinationAddress.state} {selectedShip.destinationAddress.postalCode}</p>
                          {selectedShip.destinationAddress.phone && <p className="text-slate-400 text-xs">{selectedShip.destinationAddress.phone}</p>}
                          {selectedShip.destinationAddress.email && <p className="text-slate-400 text-xs">{selectedShip.destinationAddress.email}</p>}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {selectedShip.carrier && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Carrier</span><span className="text-xs font-black text-slate-700">{selectedShip.carrier}</span></div>
                      )}
                      {selectedShip.serviceLevel && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Service</span><span className="text-xs font-black text-slate-700">{selectedShip.serviceLevel}</span></div>
                      )}
                      {selectedShip.trackingNumber && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Tracking</span><span className="text-xs font-black text-slate-700 font-mono">{selectedShip.trackingNumber}</span></div>
                      )}
                      {canViewCosts && selectedShip.shippingCost !== undefined && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Cost</span><span className="text-xs font-black text-primary">${selectedShip.shippingCost.toFixed(2)}</span></div>
                      )}
                      {selectedShip.estimatedDelivery && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Est. Delivery</span><span className="text-xs font-black text-slate-700">{formatDate(selectedShip.estimatedDelivery)}</span></div>
                      )}
                      <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Created</span><span className="text-xs font-black text-slate-700">{formatDateTime(selectedShip.createdAt)}</span></div>
                      {selectedShip.dispatchedAt && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Dispatched</span><span className="text-xs font-black text-slate-700">{formatDateTime(selectedShip.dispatchedAt)}</span></div>
                      )}
                      {selectedShip.deliveredAt && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Delivered</span><span className="text-xs font-black text-emerald-600">{formatDateTime(selectedShip.deliveredAt)}</span></div>
                      )}
                    </div>

                    {selectedShip.notes && (
                      <div className="bg-amber-50 rounded-xl p-4 border border-amber-100">
                        <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-1">Notes</p>
                        <p className="text-xs text-amber-800">{selectedShip.notes}</p>
                      </div>
                    )}

                    {getNextStatuses(selectedShip.status).length > 0 && (
                      <div className="flex gap-2 flex-wrap">
                        {getNextStatuses(selectedShip.status).map(next => (
                          canDoTransition(selectedShip.status, next) && (
                            <button
                              key={next}
                              onClick={() => setShowStatusConfirm({ id: selectedShip.id, newStatus: next, label: `Move shipment to "${next}"?` })}
                              className={`px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 ${
                                next === 'Cancelled'
                                  ? 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100'
                                  : next === 'Dispatched'
                                    ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90'
                                    : next === 'Delivered'
                                      ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-600'
                                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              {next}
                            </button>
                          )
                        ))}
                      </div>
                    )}
                  </>
                )}

                {detailTab === 'tracking' && (
                  <>
                    {canUpdateTracking && selectedShip.status !== 'Delivered' && selectedShip.status !== 'Cancelled' && (
                      <button onClick={() => { setEventDescription(''); setEventLocation(''); setAddEventModal(selectedShip.id); }} className="px-4 py-2.5 bg-primary/10 text-primary font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-primary/20 transition-all flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">add</span>Add Event
                      </button>
                    )}
                    <div className="relative pl-8 space-y-0">
                      <div className="absolute left-3 top-2 bottom-2 w-px bg-slate-200" />
                      {[...selectedShip.events].reverse().map((evt, i) => (
                        <div key={evt.id} className="relative pb-6 last:pb-0">
                          <div className={`absolute left-[-23px] top-1 w-5 h-5 rounded-full border-2 flex items-center justify-center ${i === 0 ? 'bg-primary border-primary' : 'bg-white border-slate-300'}`}>
                            {i === 0 && <div className="w-2 h-2 rounded-full bg-white" />}
                          </div>
                          <div className="ml-2">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-xs font-black text-slate-700">{evt.status}</span>
                              <span className="text-[10px] text-slate-400">{formatDateTime(evt.timestamp)}</span>
                            </div>
                            <p className="text-xs text-slate-600">{evt.description}</p>
                            {evt.location && <p className="text-[10px] text-slate-400 mt-0.5">{evt.location}</p>}
                            {evt.performedBy && <p className="text-[10px] text-slate-400">by {evt.performedBy}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {detailTab === 'packages' && (
                  <>
                    {selectedShip.packages.length === 0 ? (
                      <div className="flex flex-col items-center py-8">
                        <span className="material-symbols-outlined text-3xl text-slate-300 mb-2">inventory_2</span>
                        <p className="text-sm font-bold text-slate-400">No packages added</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {selectedShip.packages.map((pkg, i) => (
                          <div key={pkg.id} className="bg-slate-50 rounded-2xl p-5">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Package {i + 1}</p>
                            <div className="grid grid-cols-2 gap-3 text-xs">
                              {pkg.weight && <div><span className="text-slate-400 font-bold">Weight</span> <span className="font-black text-slate-700">{pkg.weight} {pkg.weightUnit || 'lb'}</span></div>}
                              {(pkg.length && pkg.width && pkg.height) && <div><span className="text-slate-400 font-bold">Dimensions</span> <span className="font-black text-slate-700">{pkg.length} x {pkg.width} x {pkg.height} {pkg.dimensionUnit || 'in'}</span></div>}
                              {pkg.declaredValue && <div><span className="text-slate-400 font-bold">Declared Value</span> <span className="font-black text-slate-700">${pkg.declaredValue}</span></div>}
                              {pkg.insuredValue && <div><span className="text-slate-400 font-bold">Insured Value</span> <span className="font-black text-slate-700">${pkg.insuredValue}</span></div>}
                              {pkg.contentsSummary && <div className="col-span-2"><span className="text-slate-400 font-bold">Contents</span> <span className="font-black text-slate-700">{pkg.contentsSummary}</span></div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {showStatusConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm p-8 text-center">
              <span className="material-symbols-outlined text-4xl text-primary mb-4">help</span>
              <p className="text-sm font-bold text-slate-700 mb-6">{showStatusConfirm.label}</p>
              <div className="flex gap-3">
                <button onClick={() => setShowStatusConfirm(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button onClick={() => handleStatusTransition(showStatusConfirm.id, showStatusConfirm.newStatus)} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20">Confirm</button>
              </div>
            </motion.div>
          </div>
        )}

        {addEventModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8">
              <h3 className="text-lg font-black text-primary mb-6">Add Tracking Event</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Description *</label>
                  <input value={eventDescription} onChange={e => setEventDescription(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="e.g. Package arrived at sorting facility" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Location</label>
                  <input value={eventLocation} onChange={e => setEventLocation(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="e.g. Austin, TX" />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button onClick={() => setAddEventModal(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button onClick={() => handleAddEvent(addEventModal)} disabled={!eventDescription.trim()} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 disabled:opacity-50">Add Event</button>
              </div>
            </motion.div>
          </div>
        )}

        {editingShipment && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg p-8 max-h-[85vh] overflow-y-auto">
              <h3 className="text-lg font-black text-primary mb-6">Edit Shipment</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Carrier</label>
                  <select value={newCarrier} onChange={e => setNewCarrier(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                    <option value="">Select carrier...</option>
                    {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Service Level</label>
                  <select value={newService} onChange={e => setNewService(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                    <option value="">Select service...</option>
                    {SERVICE_LEVELS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tracking Number</label>
                  <input value={newTracking} onChange={e => setNewTracking(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono" placeholder="Enter tracking number" />
                </div>
                {canViewCosts && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Shipping Cost ($)</label>
                    <input type="number" step="0.01" value={newCost} onChange={e => setNewCost(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="0.00" />
                  </div>
                )}
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                  <textarea value={newNotes} onChange={e => setNewNotes(e.target.value)} rows={3} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none" placeholder="Internal notes..." />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button onClick={() => setEditingShipment(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button onClick={handleSaveEdit} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20">Save Changes</button>
              </div>
            </motion.div>
          </div>
        )}

        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                <div>
                  <h2 className="text-xl font-black text-primary">New Shipment</h2>
                  <p className="text-sm text-slate-500 mt-1">Create a new shipment record</p>
                </div>
                <button onClick={() => setShowCreateModal(false)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Shipment Type *</label>
                    <select value={newType} onChange={e => setNewType(e.target.value as ShipmentType)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Source Type *</label>
                    <select value={newSourceType} onChange={e => setNewSourceType(e.target.value as ShipmentSourceType)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Source Reference Number</label>
                  <input value={newSourceNumber} onChange={e => setNewSourceNumber(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="e.g. INV-1001, REP-1001, TRF-2026-001" />
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Origin Address</p>
                    <input value={newOrigin.name} onChange={e => setNewOrigin({ ...newOrigin, name: e.target.value })} placeholder="Name *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <input value={newOrigin.line1} onChange={e => setNewOrigin({ ...newOrigin, line1: e.target.value })} placeholder="Address Line 1 *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newOrigin.city} onChange={e => setNewOrigin({ ...newOrigin, city: e.target.value })} placeholder="City *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                      <input value={newOrigin.state} onChange={e => setNewOrigin({ ...newOrigin, state: e.target.value })} placeholder="State *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <input value={newOrigin.postalCode} onChange={e => setNewOrigin({ ...newOrigin, postalCode: e.target.value })} placeholder="Postal Code *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                  </div>
                  <div className="space-y-3">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Destination Address</p>
                    <input value={newDest.name} onChange={e => setNewDest({ ...newDest, name: e.target.value })} placeholder="Name *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <input value={newDest.line1} onChange={e => setNewDest({ ...newDest, line1: e.target.value })} placeholder="Address Line 1 *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newDest.city} onChange={e => setNewDest({ ...newDest, city: e.target.value })} placeholder="City *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                      <input value={newDest.state} onChange={e => setNewDest({ ...newDest, state: e.target.value })} placeholder="State *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <input value={newDest.postalCode} onChange={e => setNewDest({ ...newDest, postalCode: e.target.value })} placeholder="Postal Code *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Carrier</label>
                    <select value={newCarrier} onChange={e => setNewCarrier(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      <option value="">Select carrier...</option>
                      {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Service Level</label>
                    <select value={newService} onChange={e => setNewService(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      <option value="">Select service...</option>
                      {SERVICE_LEVELS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tracking Number</label>
                    <input value={newTracking} onChange={e => setNewTracking(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono" placeholder="Enter if available" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Shipping Cost ($)</label>
                    <input type="number" step="0.01" value={newCost} onChange={e => setNewCost(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="0.00" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                  <textarea value={newNotes} onChange={e => setNewNotes(e.target.value)} rows={2} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none" placeholder="Internal notes..." />
                </div>
              </div>
              <div className="p-8 border-t border-slate-100 bg-slate-50/30 flex gap-3 shrink-0">
                <button onClick={() => setShowCreateModal(false)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button
                  onClick={handleCreateShipment}
                  disabled={!newOrigin.name || !newOrigin.line1 || !newDest.name || !newDest.line1}
                  className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  Create Shipment
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
