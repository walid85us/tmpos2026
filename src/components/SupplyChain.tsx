import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { PurchaseOrder, RMA, SupplierRefundEntry } from '../types';

type SupplyTab = 'po' | 'grn' | 'rma' | 'suppliers';

export default function SupplyChain() {
  const {
    suppliers, addSupplier, updateSupplier,
    purchaseOrders, addPurchaseOrder, updatePurchaseOrder,
    goodsReceivedNotes, addGoodsReceivedNote,
    rmas, addRMA, updateRMA,
    approvedStockItems, updateStockItem,
    addStockMovement,
    supplierRefundEntries, addSupplierRefundEntry,
  } = useStoreLocalState();
  const { checkSubPermission } = useAccess();
  const canManagePOs = checkSubPermission('manage_purchase_orders');
  const canManageRMAs = checkSubPermission('manage_rmas');
  const canManageSuppliers = checkSubPermission('manage_suppliers');
  const canManageGRNs = checkSubPermission('manage_goods_received_notes');

  const [activeTab, setActiveTab] = useState<SupplyTab>('po');
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreatePO, setShowCreatePO] = useState(false);
  const [showCreateRMA, setShowCreateRMA] = useState(false);
  const [showCreateSupplier, setShowCreateSupplier] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState<string | null>(null);
  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [selectedRMA, setSelectedRMA] = useState<RMA | null>(null);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, number>>({});
  const [editingSupplier, setEditingSupplier] = useState<string | null>(null);
  const [editingDraftPO, setEditingDraftPO] = useState<string | null>(null);

  const [poSupplierId, setPoSupplierId] = useState('');
  const [poItems, setPoItems] = useState<{ productId: string; name: string; sku: string; qty: number; cost: number }[]>([]);
  const [poExpected, setPoExpected] = useState('');
  const [poNotes, setPoNotes] = useState('');
  const [vendorChangeConfirm, setVendorChangeConfirm] = useState<{ newSupplierId: string; itemCount: number } | null>(null);

  const [rmaSupplierId, setRmaSupplierId] = useState('');
  const [rmaPoId, setRmaPoId] = useState('');
  const [rmaItems, setRmaItems] = useState<{ productId: string; name: string; quantity: number; reason: string }[]>([]);
  const [rmaNotes, setRmaNotes] = useState('');

  const [rmaConfirmAction, setRmaConfirmAction] = useState<{ id: string; action: string; label: string } | null>(null);
  const [poConfirmAction, setPoConfirmAction] = useState<{ id: string; action: string; label: string } | null>(null);
  const [rmaRefundAmount, setRmaRefundAmount] = useState('');
  const [rmaReplacementItems, setRmaReplacementItems] = useState<{ productId: string; name: string; quantity: number }[]>([]);

  const [editingPendingRMA, setEditingPendingRMA] = useState<string | null>(null);
  const [rmaRefundTax, setRmaRefundTax] = useState('');
  const [rmaRefundMethod, setRmaRefundMethod] = useState('Credit Note');
  const [rmaRefundNotes, setRmaRefundNotes] = useState('');
  const [rmaDetailTab, setRmaDetailTab] = useState<'overview' | 'items' | 'resolution' | 'finance'>('overview');

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Received': case 'Refunded': case 'Replaced': case 'Active': case 'Closed': return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
      case 'Partially Received': case 'Shipped': case 'Ordered': case 'Partially Resolved': return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
      case 'Pending': case 'Draft': return 'bg-primary/10 text-primary border-primary/20';
      case 'Cancelled': case 'Rejected': case 'Inactive': return 'bg-rose-500/10 text-rose-600 border-rose-500/20';
      default: return 'bg-slate-500/10 text-slate-600 border-slate-500/20';
    }
  };

  const handleReceiveGoods = (poId: string) => {
    if (!canManagePOs || !canManageGRNs) return;
    const po = purchaseOrders.find(p => p.id === poId);
    if (!po) return;
    const grnItems: { productId: string; name: string; orderedQty: number; quantity: number; costPrice: number }[] = [];
    let anyReceived = false;
    const updatedPOItems = po.items.map(item => {
      const rQty = receiveQtys[item.productId] || 0;
      if (rQty > 0) {
        anyReceived = true;
        grnItems.push({ productId: item.productId, name: item.name, orderedQty: item.orderedQuantity, quantity: rQty, costPrice: item.costPrice });
        const stockItem = approvedStockItems.find(si => si.id === item.productId);
        if (stockItem) {
          updateStockItem(stockItem.id, { qty: stockItem.qty + rQty });
          addStockMovement({
            id: `sm-${Date.now()}-${item.productId}`, stockItemId: stockItem.id, stockItemName: stockItem.name,
            type: 'receiving', quantityChange: rQty, previousQty: stockItem.qty, newQty: stockItem.qty + rQty,
            referenceId: po.id, referenceType: 'purchase_order',
            performedBy: 'Current User', timestamp: new Date().toISOString(),
            reason: `Received from ${po.poNumber}`,
          });
        }
        return { ...item, receivedQuantity: item.receivedQuantity + rQty };
      }
      return item;
    });
    if (!anyReceived) return;
    const allFullyReceived = updatedPOItems.every(i => i.receivedQuantity >= i.orderedQuantity);
    const newStatus = allFullyReceived ? 'Received' as const : 'Partially Received' as const;
    updatePurchaseOrder(po.id, { items: updatedPOItems, status: newStatus, ...(allFullyReceived ? { receivedDate: new Date().toISOString().split('T')[0] } : {}) });
    addGoodsReceivedNote({
      id: `grn-${Date.now()}`, grnNumber: `GRN-${new Date().getFullYear()}-${String(goodsReceivedNotes.length + 1).padStart(3, '0')}`,
      poId: po.id, poNumber: po.poNumber, supplierId: po.supplierId, supplierName: po.supplierName,
      items: grnItems, receivedAt: new Date().toISOString().split('T')[0], receivedBy: 'Current User',
    });
    setShowReceiveModal(null);
    setReceiveQtys({});
  };

  const addPOItem = () => {
    const vendorItems = poSupplierId ? approvedStockItems.filter(i => i.supplierId === poSupplierId || !i.supplierId) : approvedStockItems;
    const available = vendorItems.filter(i => !poItems.find(pi => pi.productId === i.id));
    if (available.length === 0) return;
    const item = available[0];
    setPoItems(prev => [...prev, { productId: item.id, name: item.name, sku: item.sku, qty: 1, cost: item.cost }]);
  };

  const handleSupplierChange = (newSupplierId: string) => {
    if (poItems.length > 0 && newSupplierId !== poSupplierId) {
      setVendorChangeConfirm({ newSupplierId, itemCount: poItems.length });
    } else {
      setPoSupplierId(newSupplierId);
    }
  };

  const getItemRMAStatus = (productId: string) => {
    const existing = rmas.find(r => r.status !== 'Rejected' && r.items.some(i => i.productId === productId));
    return existing ? existing.rmaNumber : null;
  };

  const renderPO = () => {
    const filtered = purchaseOrders.filter(po =>
      !searchQuery || po.poNumber.toLowerCase().includes(searchQuery.toLowerCase()) || po.supplierName.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input type="text" placeholder="Search POs..." className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </div>
          {canManagePOs ? (
            <button onClick={() => { setShowCreatePO(true); setPoSupplierId(''); setPoItems([]); setPoExpected(''); setPoNotes(''); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">add</span>Create Purchase Order
            </button>
          ) : (
            <button disabled className="px-6 py-3 bg-slate-200 text-slate-400 font-black text-xs rounded-2xl uppercase tracking-widest flex items-center gap-2 cursor-not-allowed">
              <span className="material-symbols-outlined text-sm">lock</span>Create Purchase Order
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { l: 'Total POs', v: purchaseOrders.length, c: 'text-primary' },
            { l: 'Draft', v: purchaseOrders.filter(p => p.status === 'Draft').length, c: 'text-slate-500' },
            { l: 'Ordered', v: purchaseOrders.filter(p => p.status === 'Ordered' || p.status === 'Partially Received').length, c: 'text-amber-500' },
            { l: 'Total Value', v: `$${purchaseOrders.reduce((s, p) => s + p.totalAmount, 0).toLocaleString()}`, c: 'text-primary' },
          ].map(card => (
            <div key={card.l} className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 p-4 shadow-sm">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{card.l}</p>
              <p className={`text-xl font-black ${card.c} mt-1`}>{card.v}</p>
            </div>
          ))}
        </div>

        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">PO #</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Supplier</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Expected</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Total</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((po) => (
                <tr key={po.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                  <td className="px-8 py-5"><button onClick={() => setSelectedPO(po)} className="font-black text-primary text-xs hover:underline">{po.poNumber}</button></td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-900">{po.supplierName}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-600">{po.createdAt}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-600">{po.expectedDate || '—'}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-600">{po.items.length}</td>
                  <td className="px-6 py-5 text-right font-black text-slate-900">${po.totalAmount.toFixed(2)}</td>
                  <td className="px-6 py-5">
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(po.status)}`}>{po.status}</span>
                  </td>
                  <td className="px-6 py-5 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setSelectedPO(po)} className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="View Details">
                        <span className="material-symbols-outlined text-sm">visibility</span>
                      </button>
                      {canManagePOs && po.status === 'Draft' && (
                        <>
                          <button onClick={() => {
                            setEditingDraftPO(po.id);
                            setPoSupplierId(po.supplierId || '');
                            setPoItems(po.items.map(i => ({ productId: i.productId, name: i.name, sku: i.sku || '', qty: i.orderedQuantity, cost: i.costPrice })));
                            setPoExpected(po.expectedDate || '');
                            setPoNotes(po.notes || '');
                            setShowCreatePO(true);
                          }} className="p-2 hover:bg-primary/10 text-primary rounded-xl transition-colors" title="Edit Draft">
                            <span className="material-symbols-outlined text-sm">edit</span>
                          </button>
                          <button onClick={() => setPoConfirmAction({ id: po.id, action: 'send', label: `Send ${po.poNumber} to supplier?` })} className="p-2 hover:bg-primary/10 text-primary rounded-xl transition-colors" title="Send Order">
                            <span className="material-symbols-outlined text-sm">send</span>
                          </button>
                        </>
                      )}
                      {canManagePOs && canManageGRNs && (po.status === 'Ordered' || po.status === 'Partially Received') && (
                        <button onClick={() => { setShowReceiveModal(po.id); setReceiveQtys({}); }} className="p-2 hover:bg-emerald-50 text-emerald-600 rounded-xl transition-colors" title="Receive Goods">
                          <span className="material-symbols-outlined text-sm">inventory</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="px-8 py-12 text-center text-sm font-bold text-slate-400">No purchase orders found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderGRN = () => (
    <div className="space-y-6">
      <h2 className="text-2xl font-black text-primary tracking-tight">Goods Received Notes</h2>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">GRN #</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">PO Reference</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Supplier</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Received At</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Received By</th>
            </tr>
          </thead>
          <tbody>
            {goodsReceivedNotes.map((grn) => (
              <tr key={grn.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-5 font-black text-primary text-xs">{grn.grnNumber}</td>
                <td className="px-6 py-5 text-sm font-bold text-primary">{grn.poNumber}</td>
                <td className="px-6 py-5 text-sm font-bold text-slate-900">{grn.supplierName}</td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{grn.items.map(i => `${i.name} x${i.quantity}`).join(', ')}</td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{grn.receivedAt}</td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{grn.receivedBy}</td>
              </tr>
            ))}
            {goodsReceivedNotes.length === 0 && (
              <tr><td colSpan={6} className="px-8 py-12 text-center text-sm font-bold text-slate-400">No goods received notes</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderRMA = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">RMA Management</h2>
        {canManageRMAs ? (
          <button onClick={() => { setShowCreateRMA(true); setRmaSupplierId(''); setRmaPoId(''); setRmaItems([]); setRmaNotes(''); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">add</span>Create RMA
          </button>
        ) : (
          <button disabled className="px-6 py-3 bg-slate-200 text-slate-400 font-black text-xs rounded-2xl uppercase tracking-widest flex items-center gap-2 cursor-not-allowed">
            <span className="material-symbols-outlined text-sm">lock</span>Create RMA
          </button>
        )}
      </div>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">RMA #</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Supplier</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">PO Ref</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rmas.map((rma) => (
              <tr key={rma.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                <td className="px-8 py-5"><button onClick={() => { setSelectedRMA(rma); setRmaDetailTab('overview'); }} className="font-black text-primary text-xs hover:underline">{rma.rmaNumber}</button></td>
                <td className="px-6 py-5 text-sm font-bold text-slate-900">{rma.supplierName}</td>
                <td className="px-6 py-5 text-sm font-bold text-primary">{rma.poNumber || '—'}</td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{rma.items.length} item{rma.items.length !== 1 ? 's' : ''}</td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{rma.createdAt}</td>
                <td className="px-6 py-5"><span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(rma.status)}`}>{rma.status}</span></td>
                <td className="px-6 py-5 text-right">
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {canManageRMAs && rma.status === 'Pending' && (
                      <>
                        <button onClick={() => setEditingPendingRMA(editingPendingRMA === rma.id ? null : rma.id)} className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl" title="Edit">
                          <span className="material-symbols-outlined text-sm">edit</span>
                        </button>
                        <button onClick={() => setRmaConfirmAction({ id: rma.id, action: 'ship', label: `Ship RMA ${rma.rmaNumber}?` })} className="px-3 py-1.5 bg-amber-500 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-amber-600">Ship</button>
                      </>
                    )}
                    {canManageRMAs && (rma.status === 'Shipped' || rma.status === 'Partially Resolved') && (
                      <>
                        <button onClick={() => { const openTotal = rma.items.reduce((s, i) => s + (i.quantity - (i.refundedQty || 0) - (i.replacedQty || 0)) * 10, 0); setRmaRefundAmount(openTotal.toString()); setRmaRefundTax(''); setRmaRefundMethod('Credit Note'); setRmaRefundNotes(''); setRmaConfirmAction({ id: rma.id, action: 'refund', label: `Confirm refund for ${rma.rmaNumber}?` }); }} className="px-3 py-1.5 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-emerald-600">Refunded</button>
                        <button onClick={() => { setRmaReplacementItems(rma.items.map(i => ({ productId: i.productId, name: i.name, quantity: Math.max(0, i.quantity - (i.refundedQty || 0) - (i.replacedQty || 0)) }))); setRmaConfirmAction({ id: rma.id, action: 'replace', label: `Confirm replacement for ${rma.rmaNumber}?` }); }} className="px-3 py-1.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90">Replaced</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rmas.length === 0 && (
              <tr><td colSpan={7} className="px-8 py-12 text-center text-sm font-bold text-slate-400">No RMAs</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editingPendingRMA && (() => {
        const rma = rmas.find(r => r.id === editingPendingRMA);
        if (!rma || rma.status !== 'Pending') return null;
        return (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm space-y-4">
            <div className="flex justify-between items-start">
              <h3 className="text-lg font-black text-primary">Edit {rma.rmaNumber}</h3>
              <button onClick={() => setEditingPendingRMA(null)} className="p-2 hover:bg-slate-100 rounded-xl text-slate-400"><span className="material-symbols-outlined text-sm">close</span></button>
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
              <textarea defaultValue={rma.notes || ''} onBlur={(e) => { if (!canManageRMAs) return; updateRMA(rma.id, { notes: e.target.value || undefined }); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm h-20 resize-none" />
            </div>
            <div className="space-y-2">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</p>
              {rma.items.map((item, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <p className="font-bold text-sm text-slate-900">{item.name}</p>
                    <input defaultValue={item.reason} onBlur={(e) => {
                      if (!canManageRMAs) return;
                      const updated = [...rma.items];
                      updated[i] = { ...updated[i], reason: e.target.value };
                      updateRMA(rma.id, { items: updated });
                    }} className="text-xs bg-white border border-slate-200 rounded-lg px-2 py-1 mt-1 font-bold w-full" placeholder="Reason" />
                  </div>
                  <input type="number" min="1" defaultValue={item.quantity} onBlur={(e) => {
                    if (!canManageRMAs) return;
                    const updated = [...rma.items];
                    updated[i] = { ...updated[i], quantity: parseInt(e.target.value) || 1 };
                    updateRMA(rma.id, { items: updated });
                  }} className="w-16 px-2 py-1 bg-white border border-slate-200 rounded-lg text-center font-bold text-sm" />
                </div>
              ))}
            </div>
            <button onClick={() => setEditingPendingRMA(null)} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl">Done Editing</button>
          </motion.div>
        );
      })()}
    </div>
  );

  const renderSuppliers = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Supplier Directory</h2>
        {canManageSuppliers ? (
          <button onClick={() => setShowCreateSupplier(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">add</span>Add Supplier
          </button>
        ) : (
          <button disabled className="px-6 py-3 bg-slate-200 text-slate-400 font-black text-xs rounded-2xl uppercase tracking-widest flex items-center gap-2 cursor-not-allowed">
            <span className="material-symbols-outlined text-sm">lock</span>Add Supplier
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {suppliers.map(sup => (
          <div key={sup.id} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-black text-primary tracking-tight">{sup.name}</h3>
                {sup.contactName && <p className="text-xs text-slate-500 font-bold">{sup.contactName}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(sup.status)}`}>{sup.status}</span>
                {canManageSuppliers && (
                  <button onClick={() => setEditingSupplier(editingSupplier === sup.id ? null : sup.id)} className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-primary transition-colors">
                    <span className="material-symbols-outlined text-sm">edit</span>
                  </button>
                )}
              </div>
            </div>
            {editingSupplier === sup.id ? (
              <div className="space-y-3 mb-4">
                <input defaultValue={sup.contactName || ''} onBlur={(e) => { if (canManageSuppliers) updateSupplier(sup.id, { contactName: e.target.value || undefined }); }} placeholder="Contact Name" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm" />
                <input defaultValue={sup.email || ''} onBlur={(e) => { if (canManageSuppliers) updateSupplier(sup.id, { email: e.target.value || undefined }); }} placeholder="Email" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm" />
                <input defaultValue={sup.phone || ''} onBlur={(e) => { if (canManageSuppliers) updateSupplier(sup.id, { phone: e.target.value || undefined }); }} placeholder="Phone" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm" />
                <input defaultValue={sup.website || ''} onBlur={(e) => { if (canManageSuppliers) updateSupplier(sup.id, { website: e.target.value || undefined }); }} placeholder="Website" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm" />
                <div className="flex gap-2">
                  <button onClick={() => { if (canManageSuppliers) updateSupplier(sup.id, { status: sup.status === 'Active' ? 'Inactive' : 'Active' }); }} className="px-3 py-2 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-200">{sup.status === 'Active' ? 'Deactivate' : 'Activate'}</button>
                  <button onClick={() => setEditingSupplier(null)} className="px-3 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl">Done</button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                {sup.email && <div className="flex items-center gap-2 text-slate-600"><span className="material-symbols-outlined text-sm text-slate-400">email</span><span className="font-bold">{sup.email}</span></div>}
                {sup.phone && <div className="flex items-center gap-2 text-slate-600"><span className="material-symbols-outlined text-sm text-slate-400">phone</span><span className="font-bold">{sup.phone}</span></div>}
                {sup.website && <div className="flex items-center gap-2 text-slate-600"><span className="material-symbols-outlined text-sm text-slate-400">language</span><span className="font-bold">{sup.website}</span></div>}
              </div>
            )}
            <div className="flex gap-2 mt-4 pt-4 border-t border-slate-100">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">POs: {purchaseOrders.filter(p => p.supplierId === sup.id).length}</span>
              <span className="text-slate-200">·</span>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">RMAs: {rmas.filter(r => r.supplierId === sup.id).length}</span>
            </div>
          </div>
        ))}
        {suppliers.length === 0 && (
          <div className="col-span-full flex flex-col items-center py-12">
            <span className="material-symbols-outlined text-4xl text-slate-300 mb-2">business</span>
            <p className="text-sm font-bold text-slate-400">No suppliers added yet</p>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Supply Chain</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Supply Chain</h2>
        </div>
        <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm">
          {[
            { id: 'po' as SupplyTab, label: 'Purchase Orders', icon: 'shopping_bag' },
            { id: 'grn' as SupplyTab, label: 'Received Notes', icon: 'inventory' },
            { id: 'rma' as SupplyTab, label: 'RMA', icon: 'assignment_return' },
            { id: 'suppliers' as SupplyTab, label: 'Suppliers', icon: 'business' },
          ].map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab.id ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'text-slate-400 hover:text-primary hover:bg-slate-50'}`}>
              <span className="material-symbols-outlined text-sm">{tab.icon}</span>{tab.label}
            </button>
          ))}
        </div>
      </header>

      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}>
          {activeTab === 'po' && renderPO()}
          {activeTab === 'grn' && renderGRN()}
          {activeTab === 'rma' && renderRMA()}
          {activeTab === 'suppliers' && renderSuppliers()}
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {showReceiveModal && (() => {
          const po = purchaseOrders.find(p => p.id === showReceiveModal);
          if (!po) return null;
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setShowReceiveModal(null)} />
              <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                  <h3 className="text-2xl font-black text-primary tracking-tight">Receive Goods</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{po.poNumber} · {po.supplierName}</p>
                </div>
                <div className="p-8 space-y-4">
                  {po.items.filter(i => i.receivedQuantity < i.orderedQuantity).map(item => (
                    <div key={item.productId} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl">
                      <div>
                        <p className="font-bold text-sm text-slate-900">{item.name}</p>
                        <p className="text-[10px] text-slate-400">Ordered: {item.orderedQuantity} · Received: {item.receivedQuantity} · Remaining: {item.orderedQuantity - item.receivedQuantity}</p>
                      </div>
                      <input type="number" min="0" max={item.orderedQuantity - item.receivedQuantity} value={receiveQtys[item.productId] || ''} onChange={(e) => setReceiveQtys({ ...receiveQtys, [item.productId]: parseInt(e.target.value) || 0 })} className="w-20 px-3 py-2 bg-white border border-slate-200 rounded-xl text-center font-bold" placeholder="0" />
                    </div>
                  ))}
                  <div className="flex gap-4 pt-4">
                    <button onClick={() => setShowReceiveModal(null)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                    <button onClick={() => handleReceiveGoods(po.id)} className="flex-1 py-4 bg-emerald-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-emerald-500/20 active:scale-95 transition-all">Receive & Update Stock</button>
                  </div>
                </div>
              </motion.div>
            </div>
          );
        })()}

        {selectedPO && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setSelectedPO(null)} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{selectedPO.poNumber}</h3>
                  <p className="text-sm text-slate-500">{selectedPO.supplierName} · Created: {selectedPO.createdAt}{selectedPO.orderedAt ? ` · Ordered: ${selectedPO.orderedAt}` : ''}</p>
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border mt-2 inline-block ${getStatusColor(selectedPO.status)}`}>{selectedPO.status}</span>
                </div>
                <button onClick={() => setSelectedPO(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                {selectedPO.notes && <p className="text-xs text-slate-400 italic">{selectedPO.notes}</p>}
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Line Items</p>
                  <div className="space-y-2">
                    {selectedPO.items.map((item, i) => (
                      <div key={i} className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
                        <div>
                          <p className="font-bold text-sm text-slate-900">{item.name}</p>
                          {item.sku && <p className="text-[10px] text-slate-400 font-mono">{item.sku}</p>}
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-bold text-slate-700">{item.receivedQuantity}/{item.orderedQuantity} received</p>
                          <p className="text-xs text-slate-400">${item.costPrice.toFixed(2)} ea</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {(() => {
                  const poGrns = goodsReceivedNotes.filter(g => g.poId === selectedPO.id);
                  if (poGrns.length === 0) return null;
                  return (
                    <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Receiving History</p>
                      <div className="space-y-2">
                        {poGrns.map(grn => (
                          <div key={grn.id} className="flex items-center justify-between p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                            <div>
                              <p className="font-bold text-xs text-emerald-800">{grn.grnNumber}</p>
                              <p className="text-[10px] text-emerald-600">{grn.items.map(i => `${i.name} x${i.quantity}`).join(', ')}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-emerald-700">{grn.receivedAt}</p>
                              <p className="text-[10px] text-emerald-500">by {grn.receivedBy}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </motion.div>
          </div>
        )}

        {selectedRMA && (() => {
          const liveRMA = rmas.find(r => r.id === selectedRMA.id) || selectedRMA;
          const rmaRefunds = supplierRefundEntries.filter(e => e.rmaId === liveRMA.id);
          return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setSelectedRMA(null)} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{liveRMA.rmaNumber}</h3>
                  <p className="text-sm text-slate-500">{liveRMA.supplierName}{liveRMA.poNumber ? ` · PO: ${liveRMA.poNumber}` : ''}</p>
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border mt-2 inline-block ${getStatusColor(liveRMA.status)}`}>{liveRMA.status}</span>
                </div>
                <button onClick={() => setSelectedRMA(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="flex border-b border-slate-100 shrink-0">
                {(['overview', 'items', 'resolution', 'finance'] as const).map(tab => (
                  <button key={tab} onClick={() => setRmaDetailTab(tab)} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${rmaDetailTab === tab ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-slate-600'}`}>{tab}</button>
                ))}
              </div>
              <div className="p-8 space-y-4 overflow-y-auto flex-1">
                {rmaDetailTab === 'overview' && (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Created</p><p className="font-bold">{liveRMA.createdAt}</p></div>
                      <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Created By</p><p className="font-bold">{liveRMA.createdBy || '—'}</p></div>
                      {liveRMA.trackingNumber && <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Tracking</p><p className="font-bold">{liveRMA.trackingNumber}</p></div>}
                      <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Total Items</p><p className="font-bold">{liveRMA.items.reduce((s, i) => s + i.quantity, 0)}</p></div>
                    </div>
                    {liveRMA.notes && <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase mb-1">Notes</p><p className="text-xs text-slate-600 italic">{liveRMA.notes}</p></div>}
                    {liveRMA.refundAmount != null && liveRMA.refundAmount > 0 && (
                      <div className="bg-emerald-50 rounded-xl p-3 border border-emerald-100">
                        <p className="text-[10px] font-black text-emerald-600 uppercase">Refund Amount</p>
                        <p className="text-lg font-black text-emerald-700">${liveRMA.refundAmount.toFixed(2)}{liveRMA.refundTax ? ` + $${liveRMA.refundTax.toFixed(2)} tax` : ''}</p>
                        {liveRMA.refundMethod && <p className="text-[10px] text-emerald-500 mt-1">Method: {liveRMA.refundMethod}</p>}
                        {liveRMA.refundNotes && <p className="text-[10px] text-slate-400 italic mt-1">{liveRMA.refundNotes}</p>}
                      </div>
                    )}
                  </>
                )}
                {rmaDetailTab === 'items' && (
                  <div className="space-y-2">
                    {liveRMA.items.map((item, i) => {
                      const openQty = item.quantity - (item.refundedQty || 0) - (item.replacedQty || 0);
                      return (
                        <div key={i} className="p-4 bg-slate-50 rounded-xl space-y-2">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-bold text-sm text-slate-900">{item.name}</p>
                              <p className="text-[10px] text-slate-400">{item.reason}{item.serialNumber ? ` · S/N: ${item.serialNumber}` : ''}</p>
                            </div>
                            <p className="text-sm font-bold text-slate-700">Qty: {item.quantity}</p>
                          </div>
                          <div className="flex gap-3 text-[10px]">
                            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded font-black">Shipped: {item.shippedQty ?? item.quantity}</span>
                            <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded font-black">Refunded: {item.refundedQty || 0}</span>
                            <span className="px-2 py-0.5 bg-primary/10 text-primary rounded font-black">Replaced: {item.replacedQty || 0}</span>
                            <span className={`px-2 py-0.5 rounded font-black ${openQty > 0 ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-400'}`}>Open: {openQty}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {rmaDetailTab === 'resolution' && (
                  <div className="space-y-3">
                    {liveRMA.replacementItems && liveRMA.replacementItems.length > 0 && (
                      <div className="bg-primary/5 rounded-xl p-4 border border-primary/10">
                        <p className="text-[10px] font-black text-primary uppercase tracking-widest mb-2">Replacement Items Received</p>
                        {liveRMA.replacementItems.map((ri, idx) => (
                          <div key={idx} className="flex justify-between text-xs py-1">
                            <span className="font-bold text-slate-900">{ri.name}</span>
                            <span className="font-black text-primary">x{ri.quantity}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {canManageRMAs && liveRMA.status !== 'Closed' && liveRMA.status !== 'Rejected' && (
                      <button onClick={() => { updateRMA(liveRMA.id, { status: 'Closed' }); }} className="w-full py-3 bg-emerald-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-emerald-600 active:scale-95 transition-all">Close RMA</button>
                    )}
                  </div>
                )}
                {rmaDetailTab === 'finance' && (
                  <div className="space-y-3">
                    {rmaRefunds.length > 0 ? rmaRefunds.map(entry => (
                      <div key={entry.id} className="bg-emerald-50 rounded-xl p-4 border border-emerald-100 space-y-1">
                        <div className="flex justify-between items-start">
                          <p className="text-sm font-black text-emerald-700">${entry.amount.toFixed(2)}{entry.tax > 0 ? ` + $${entry.tax.toFixed(2)} tax` : ''}</p>
                          <span className="text-[10px] text-slate-400">{new Date(entry.createdAt).toLocaleDateString()}</span>
                        </div>
                        <p className="text-[10px] text-slate-500">Method: {entry.method} · By: {entry.createdBy}</p>
                        {entry.notes && <p className="text-[10px] text-slate-400 italic">{entry.notes}</p>}
                      </div>
                    )) : (
                      <p className="text-sm text-slate-400 text-center py-4">No finance records for this RMA.</p>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          </div>
          );
        })()}

        {showCreatePO && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => { setShowCreatePO(false); setEditingDraftPO(null); }} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 shrink-0">
                <h3 className="text-2xl font-black text-primary tracking-tight">{editingDraftPO ? 'Edit Purchase Order' : 'Create Purchase Order'}</h3>
                {editingDraftPO && <p className="text-xs text-slate-400 mt-1">Editing draft PO. Changes saved on submit.</p>}
              </div>
              <div className="p-8 space-y-5 overflow-y-auto flex-1">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Supplier</label>
                  <select value={poSupplierId} onChange={(e) => handleSupplierChange(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1">
                    <option value="">Select Supplier...</option>
                    {suppliers.filter(s => s.status === 'Active').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Items to Order</label>
                    <button type="button" onClick={addPOItem} className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Item</button>
                  </div>
                  {poItems.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No items added yet. Click "+ Add Item" to begin.</p>}
                  {poItems.map((pi, idx) => {
                    const vendorItems = poSupplierId ? approvedStockItems.filter(i => i.supplierId === poSupplierId || !i.supplierId) : approvedStockItems;
                    return (
                      <div key={idx} className="flex items-center gap-2 mb-2">
                        <select value={pi.productId} onChange={(e) => { const item = approvedStockItems.find(i => i.id === e.target.value); if (item) setPoItems(prev => prev.map((p, i2) => i2 === idx ? { ...p, productId: item.id, name: item.name, sku: item.sku, cost: item.cost } : p)); }} className="flex-1 px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 font-bold text-sm">
                          {vendorItems.map(i => <option key={i.id} value={i.id}>{i.name} (${i.cost.toFixed(2)})</option>)}
                        </select>
                        <input type="number" min="1" value={pi.qty} onChange={(e) => setPoItems(prev => prev.map((p, i2) => i2 === idx ? { ...p, qty: parseInt(e.target.value) || 1 } : p))} className="w-20 px-3 py-3 bg-slate-50 rounded-xl border border-slate-200 font-bold text-center" />
                        <button type="button" onClick={() => setPoItems(prev => prev.filter((_, i2) => i2 !== idx))} className="p-2 text-slate-400 hover:text-red-500"><span className="material-symbols-outlined text-sm">delete</span></button>
                      </div>
                    );
                  })}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Expected Delivery</label>
                    <input type="date" value={poExpected} onChange={(e) => setPoExpected(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1" />
                  </div>
                  <div className="flex items-end">
                    <div className="bg-slate-50 rounded-2xl border border-slate-200 px-6 py-4 w-full">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Total</p>
                      <p className="text-lg font-black text-primary">${poItems.reduce((s, i) => s + i.cost * i.qty, 0).toFixed(2)}</p>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Notes</label>
                  <textarea value={poNotes} onChange={(e) => setPoNotes(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 h-20 mt-1" placeholder="Order notes..." />
                </div>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => { setShowCreatePO(false); setEditingDraftPO(null); }} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                  <button disabled={!poSupplierId || poItems.length === 0} onClick={() => {
                    if (!canManagePOs) return;
                    const sup = suppliers.find(s => s.id === poSupplierId);
                    if (!sup) return;
                    if (editingDraftPO) {
                      updatePurchaseOrder(editingDraftPO, {
                        supplierId: sup.id, supplierName: sup.name,
                        items: poItems.map(pi => ({ productId: pi.productId, name: pi.name, sku: pi.sku, orderedQuantity: pi.qty, receivedQuantity: 0, costPrice: pi.cost })),
                        totalAmount: poItems.reduce((s, i) => s + i.cost * i.qty, 0),
                        expectedDate: poExpected || undefined,
                        notes: poNotes || undefined,
                      });
                    } else {
                      addPurchaseOrder({
                        id: `po-${Date.now()}`, poNumber: `PO-${new Date().getFullYear()}-${String(purchaseOrders.length + 1).padStart(3, '0')}`,
                        supplierId: sup.id, supplierName: sup.name, status: 'Draft',
                        items: poItems.map(pi => ({ productId: pi.productId, name: pi.name, sku: pi.sku, orderedQuantity: pi.qty, receivedQuantity: 0, costPrice: pi.cost })),
                        totalAmount: poItems.reduce((s, i) => s + i.cost * i.qty, 0),
                        createdAt: new Date().toISOString().split('T')[0],
                        expectedDate: poExpected || undefined,
                        notes: poNotes || undefined,
                        createdBy: 'Current User',
                      });
                    }
                    setShowCreatePO(false);
                    setEditingDraftPO(null);
                  }} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all disabled:opacity-40">{editingDraftPO ? 'Save Changes' : 'Create PO'}</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {vendorChangeConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden">
              <div className="p-8 text-center space-y-4">
                <span className="material-symbols-outlined text-4xl text-amber-500">warning</span>
                <p className="text-lg font-black text-primary">Change Supplier?</p>
                <p className="text-sm text-slate-500">Changing the supplier will remove the {vendorChangeConfirm.itemCount} item{vendorChangeConfirm.itemCount !== 1 ? 's' : ''} currently added to this PO, because they may not belong to the new vendor context.</p>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => setVendorChangeConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button onClick={() => { setPoSupplierId(vendorChangeConfirm.newSupplierId); setPoItems([]); setVendorChangeConfirm(null); }} className="flex-1 py-4 bg-amber-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-amber-500/20">Confirm & Reset</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {showCreateRMA && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setShowCreateRMA(false)} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 shrink-0">
                <h3 className="text-2xl font-black text-primary tracking-tight">Create RMA</h3>
              </div>
              <div className="p-8 space-y-5 overflow-y-auto flex-1">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Supplier</label>
                  <select value={rmaSupplierId} onChange={(e) => { setRmaSupplierId(e.target.value); setRmaPoId(''); setRmaItems([]); }} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1">
                    <option value="">Select Supplier...</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">PO Reference</label>
                  <select value={rmaPoId} onChange={(e) => {
                    setRmaPoId(e.target.value);
                    const po = purchaseOrders.find(p => p.id === e.target.value);
                    if (po) {
                      setRmaItems(po.items.filter(i => i.receivedQuantity > 0).map(i => ({ productId: i.productId, name: i.name, quantity: 1, reason: 'Defective' })));
                    } else {
                      setRmaItems([]);
                    }
                  }} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1">
                    <option value="">None (manual entry)</option>
                    {purchaseOrders.filter(p => !rmaSupplierId || p.supplierId === rmaSupplierId).map(po => <option key={po.id} value={po.id}>{po.poNumber} — {po.supplierName}</option>)}
                  </select>
                </div>

                {rmaItems.length === 0 && !rmaPoId && (
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Items</label>
                      <button type="button" onClick={() => {
                        const available = approvedStockItems.filter(i => !rmaItems.find(ri => ri.productId === i.id));
                        if (available.length === 0) return;
                        setRmaItems(prev => [...prev, { productId: available[0].id, name: available[0].name, quantity: 1, reason: 'Defective' }]);
                      }} className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Item</button>
                    </div>
                  </div>
                )}

                {rmaItems.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">RMA Items</p>
                    {rmaItems.map((ri, idx) => {
                      const alreadyInRMA = getItemRMAStatus(ri.productId);
                      return (
                        <div key={idx} className={`p-3 rounded-xl border ${alreadyInRMA ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <p className="font-bold text-sm text-slate-900">{ri.name}</p>
                              {alreadyInRMA && <p className="text-[10px] font-black text-amber-600">Already in {alreadyInRMA}</p>}
                            </div>
                            <div className="flex items-center gap-2">
                              <input type="number" min="1" value={ri.quantity} onChange={(e) => setRmaItems(prev => prev.map((r, i2) => i2 === idx ? { ...r, quantity: parseInt(e.target.value) || 1 } : r))} className="w-14 px-2 py-1 bg-white border border-slate-200 rounded-lg text-center font-bold text-sm" />
                              <button onClick={() => setRmaItems(prev => prev.filter((_, i2) => i2 !== idx))} className="p-1 text-slate-400 hover:text-red-500"><span className="material-symbols-outlined text-sm">delete</span></button>
                            </div>
                          </div>
                          <select value={ri.reason} onChange={(e) => setRmaItems(prev => prev.map((r, i2) => i2 === idx ? { ...r, reason: e.target.value } : r))} className="w-full mt-2 px-3 py-2 bg-white border border-slate-200 rounded-lg font-bold text-xs">
                            <option>Defective</option><option>Wrong Item</option><option>Damaged in Transit</option><option>Quality Issue</option><option>Other</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Notes</label>
                  <textarea value={rmaNotes} onChange={(e) => setRmaNotes(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 h-20 mt-1" placeholder="RMA notes..." />
                </div>

                <div className="flex gap-4 pt-2">
                  <button onClick={() => setShowCreateRMA(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                  <button disabled={rmaItems.length === 0} onClick={() => {
                    if (!canManageRMAs) return;
                    const sup = suppliers.find(s => s.id === rmaSupplierId);
                    const po = purchaseOrders.find(p => p.id === rmaPoId);
                    addRMA({
                      id: `rma-${Date.now()}`, rmaNumber: `RMA-${new Date().getFullYear()}-${String(rmas.length + 1).padStart(3, '0')}`,
                      supplierId: rmaSupplierId || undefined, supplierName: sup?.name || po?.supplierName || 'Unknown',
                      poId: rmaPoId || undefined, poNumber: po?.poNumber,
                      items: rmaItems, status: 'Pending',
                      createdAt: new Date().toISOString().split('T')[0],
                      notes: rmaNotes || undefined,
                      createdBy: 'Current User',
                    });
                    setShowCreateRMA(false);
                  }} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all disabled:opacity-40">Create RMA</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {showCreateSupplier && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={() => setShowCreateSupplier(false)} />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h3 className="text-2xl font-black text-primary tracking-tight">Add Supplier</h3>
              </div>
              <form className="p-8 space-y-4" onSubmit={(e) => {
                e.preventDefault();
                if (!canManageSuppliers) return;
                const fd = new FormData(e.currentTarget);
                addSupplier({
                  id: `sup-${Date.now()}`, name: fd.get('name') as string,
                  contactName: fd.get('contact') as string || undefined,
                  email: fd.get('email') as string || undefined,
                  phone: fd.get('phone') as string || undefined,
                  website: fd.get('website') as string || undefined,
                  status: 'Active', createdAt: new Date().toISOString().split('T')[0],
                });
                setShowCreateSupplier(false);
              }}>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Company Name *</label>
                  <input name="name" required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Contact Name</label>
                  <input name="contact" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Email</label>
                    <input name="email" type="email" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Phone</label>
                    <input name="phone" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Website</label>
                  <input name="website" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 font-bold text-slate-700 mt-1" />
                </div>
                <div className="flex gap-4 pt-2">
                  <button type="button" onClick={() => setShowCreateSupplier(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button type="submit" className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Add Supplier</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {(rmaConfirmAction || poConfirmAction) && (() => {
          const action = rmaConfirmAction || poConfirmAction;
          if (!action) return null;
          const isRefund = rmaConfirmAction?.action === 'refund';
          const isReplace = rmaConfirmAction?.action === 'replace';
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
                <div className="p-8 space-y-4">
                  <div className="text-center">
                    <span className="material-symbols-outlined text-4xl text-primary">help</span>
                    <p className="text-lg font-black text-primary mt-2">{action.label}</p>
                    <p className="text-sm text-slate-500">This action cannot be undone.</p>
                  </div>
                  {isRefund && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Refund Amount</label>
                        <div className="relative">
                          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                          <input type="number" step="0.01" value={rmaRefundAmount} onChange={(e) => setRmaRefundAmount(e.target.value)} className="w-full pl-10 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-lg" placeholder="0.00" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tax</label>
                          <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                            <input type="number" step="0.01" value={rmaRefundTax} onChange={(e) => setRmaRefundTax(e.target.value)} className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold" placeholder="0.00" />
                          </div>
                        </div>
                        <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Method</label>
                          <select value={rmaRefundMethod} onChange={(e) => setRmaRefundMethod(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm">
                            <option>Credit Note</option><option>Bank Transfer</option><option>Check</option><option>Cash</option><option>Original Payment</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                        <textarea value={rmaRefundNotes} onChange={(e) => setRmaRefundNotes(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm h-16 resize-none" placeholder="Refund notes..." />
                      </div>
                    </div>
                  )}
                  {isReplace && (() => {
                    const rmaForReplace = rmas.find(r => r.id === rmaConfirmAction?.id);
                    return (
                    <div className="space-y-2">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Replacement Items (capped by open qty)</p>
                      {rmaReplacementItems.map((ri, idx) => {
                        const rmaItem = rmaForReplace?.items.find(i => i.productId === ri.productId);
                        const openQty = rmaItem ? rmaItem.quantity - (rmaItem.refundedQty || 0) - (rmaItem.replacedQty || 0) : ri.quantity;
                        return (
                        <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                          <div>
                            <span className="font-bold text-sm text-slate-900">{ri.name}</span>
                            <span className="text-[10px] text-slate-400 ml-2">Open: {openQty}</span>
                          </div>
                          <input type="number" min="0" max={openQty} value={ri.quantity} onChange={(e) => { const v = Math.min(parseInt(e.target.value) || 0, openQty); setRmaReplacementItems(prev => prev.map((r, i2) => i2 === idx ? { ...r, quantity: v } : r)); }} className="w-16 px-2 py-1 bg-white border border-slate-200 rounded-lg text-center font-bold text-sm" />
                        </div>
                        );
                      })}
                    </div>
                    );
                  })()}
                  <div className="flex gap-4 pt-2">
                    <button onClick={() => { setRmaConfirmAction(null); setPoConfirmAction(null); setRmaRefundAmount(''); setRmaRefundTax(''); setRmaRefundMethod('Credit Note'); setRmaRefundNotes(''); setRmaReplacementItems([]); }} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                    <button onClick={() => {
                      if (rmaConfirmAction && canManageRMAs) {
                        const rma = rmas.find(r => r.id === rmaConfirmAction.id);
                        if (rmaConfirmAction.action === 'ship') {
                          const shippedItems = rma ? rma.items.map(item => ({ ...item, shippedQty: item.quantity })) : [];
                          updateRMA(rmaConfirmAction.id, { status: 'Shipped', items: shippedItems });
                        } else if (rmaConfirmAction.action === 'refund') {
                          const refundAmt = parseFloat(rmaRefundAmount) || 0;
                          const refundTax = parseFloat(rmaRefundTax) || 0;
                          const updatedItems = rma ? rma.items.map(item => ({
                            ...item,
                            refundedQty: (item.refundedQty || 0) + item.quantity - (item.refundedQty || 0) - (item.replacedQty || 0),
                          })) : [];
                          const allResolved = updatedItems.every(i => (i.refundedQty || 0) + (i.replacedQty || 0) >= i.quantity);
                          updateRMA(rmaConfirmAction.id, {
                            status: allResolved ? 'Refunded' : 'Partially Resolved',
                            refundAmount: (rma?.refundAmount || 0) + refundAmt,
                            refundTax: (rma?.refundTax || 0) + refundTax,
                            refundMethod: rmaRefundMethod,
                            refundNotes: rmaRefundNotes || undefined,
                            items: updatedItems,
                          });
                          if (rma) {
                            addSupplierRefundEntry({
                              id: `sre-${Date.now()}`, rmaId: rma.id, rmaNumber: rma.rmaNumber,
                              supplierId: rma.supplierId || '', supplierName: rma.supplierName,
                              amount: refundAmt, tax: refundTax, method: rmaRefundMethod,
                              notes: rmaRefundNotes || undefined,
                              createdAt: new Date().toISOString(), createdBy: 'Current User',
                            });
                          }
                          rma?.items.forEach(item => {
                            addStockMovement({
                              id: `sm-rma-${Date.now()}-${item.productId}`, stockItemId: item.productId, stockItemName: item.name,
                              type: 'rma_return', quantityChange: 0, previousQty: 0, newQty: 0,
                              referenceId: rmaConfirmAction.id, referenceType: 'rma',
                              performedBy: 'Current User', timestamp: new Date().toISOString(),
                              reason: `RMA ${rma?.rmaNumber} refunded - $${refundAmt.toFixed(2)}`,
                            });
                          });
                        } else if (rmaConfirmAction.action === 'replace') {
                          const updatedItems = rma ? rma.items.map(item => {
                            const replacement = rmaReplacementItems.find(ri => ri.productId === item.productId);
                            return { ...item, replacedQty: (item.replacedQty || 0) + (replacement?.quantity || 0) };
                          }) : [];
                          const allResolved = updatedItems.every(i => (i.refundedQty || 0) + (i.replacedQty || 0) >= i.quantity);
                          updateRMA(rmaConfirmAction.id, { status: allResolved ? 'Replaced' : 'Partially Resolved', replacementItems: rmaReplacementItems, items: updatedItems });
                          rmaReplacementItems.forEach(ri => {
                            if (ri.quantity > 0) {
                              const stockItem = approvedStockItems.find(si => si.id === ri.productId);
                              if (stockItem) {
                                const prevQty = stockItem.qty;
                                const newQty = prevQty + ri.quantity;
                                updateStockItem(stockItem.id, { qty: newQty });
                                addStockMovement({
                                  id: `sm-rma-rep-${Date.now()}-${ri.productId}`, stockItemId: ri.productId, stockItemName: ri.name,
                                  type: 'rma_return', quantityChange: ri.quantity, previousQty: prevQty, newQty,
                                  referenceId: rmaConfirmAction.id, referenceType: 'rma',
                                  performedBy: 'Current User', timestamp: new Date().toISOString(),
                                  reason: `RMA replacement received`,
                                });
                              }
                            }
                          });
                        }
                        setRmaConfirmAction(null);
                        setRmaRefundAmount('');
                        setRmaRefundTax('');
                        setRmaRefundMethod('Credit Note');
                        setRmaRefundNotes('');
                        setRmaReplacementItems([]);
                      }
                      if (poConfirmAction && canManagePOs) {
                        if (poConfirmAction.action === 'send') updatePurchaseOrder(poConfirmAction.id, { status: 'Ordered', orderedAt: new Date().toISOString().split('T')[0] });
                        setPoConfirmAction(null);
                      }
                    }} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Confirm</button>
                  </div>
                </div>
              </motion.div>
            </div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
