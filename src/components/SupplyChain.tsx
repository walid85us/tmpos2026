import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { PurchaseOrder, GoodsReceivedNote, RMA } from '../types';

const MOCK_POS: PurchaseOrder[] = [
  {
    id: 'po1',
    poNumber: 'PO-2024-001',
    supplierId: 'sup1',
    supplierName: 'Global Parts Inc.',
    status: 'Pending',
    items: [
      { productId: 'p1', name: 'iPhone 13 Screen', orderedQuantity: 10, receivedQuantity: 0, costPrice: 45.00 }
    ],
    totalAmount: 450.00,
    createdAt: '2024-03-18',
    expectedDate: '2024-03-25'
  },
  {
    id: 'po2',
    poNumber: 'PO-2024-002',
    supplierId: 'sup2',
    supplierName: 'Tech Sourcing Co.',
    status: 'Partially Received',
    items: [
      { productId: 'p2', name: 'MacBook Battery', orderedQuantity: 5, receivedQuantity: 2, costPrice: 80.00 }
    ],
    totalAmount: 400.00,
    createdAt: '2024-03-15',
    expectedDate: '2024-03-22'
  }
];

const MOCK_GRNS: GoodsReceivedNote[] = [
  {
    id: 'grn1',
    grnNumber: 'GRN-2024-001',
    poId: 'po2',
    poNumber: 'PO-2024-002',
    supplierName: 'Tech Sourcing Co.',
    items: [{ productId: 'p2', name: 'MacBook Battery', quantity: 2 }],
    receivedAt: '2024-03-19',
    receivedBy: 'John Doe'
  }
];

const MOCK_RMAS: RMA[] = [
  {
    id: 'rma1',
    rmaNumber: 'RMA-2024-001',
    supplierName: 'Global Parts Inc.',
    items: [{ productId: 'p1', name: 'iPhone 13 Screen', quantity: 1, reason: 'Defective Digitizer' }],
    status: 'Pending',
    createdAt: '2024-03-20'
  }
];

export default function SupplyChain() {
  const [activeTab, setActiveTab] = useState<'po' | 'grn' | 'rma'>('po');
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>(MOCK_POS);
  const [grns, setGrns] = useState<GoodsReceivedNote[]>(MOCK_GRNS);
  const [rmas, setRmas] = useState<RMA[]>(MOCK_RMAS);
  const [searchQuery, setSearchQuery] = useState('');

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Received':
      case 'Refunded':
      case 'Replaced':
        return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
      case 'Partially Received':
      case 'Shipped':
        return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
      case 'Pending':
        return 'bg-primary/10 text-primary border-primary/20';
      case 'Cancelled':
      case 'Rejected':
        return 'bg-rose-500/10 text-rose-600 border-rose-500/20';
      default:
        return 'bg-slate-500/10 text-slate-600 border-slate-500/20';
    }
  };

  const renderPO = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
          <input 
            type="text" 
            placeholder="Search POs..."
            className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
          <span className="material-symbols-outlined text-sm">add</span>
          Create Purchase Order
        </button>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">PO #</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Supplier</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Expected</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Total</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {purchaseOrders.map((po) => (
              <tr key={po.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                <td className="px-8 py-6 font-black text-primary text-xs">{po.poNumber}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-900">{po.supplierName}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{po.createdAt}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{po.expectedDate || 'N/A'}</td>
                <td className="px-8 py-6 text-right font-black text-slate-900">${po.totalAmount.toFixed(2)}</td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(po.status)}`}>
                    {po.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Edit">
                      <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                    <button className="p-2 hover:bg-emerald-50 text-emerald-600 rounded-xl transition-colors" title="Receive Goods">
                      <span className="material-symbols-outlined text-sm">inventory</span>
                    </button>
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Print">
                      <span className="material-symbols-outlined text-sm">print</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderGRN = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Goods Received Notes</h2>
      </div>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">GRN #</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">PO Reference</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Supplier</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Received At</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Received By</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grns.map((grn) => (
              <tr key={grn.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                <td className="px-8 py-6 font-black text-primary text-xs">{grn.grnNumber}</td>
                <td className="px-8 py-6 text-sm font-bold text-primary">{grn.poNumber}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-900">{grn.supplierName}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{grn.receivedAt}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{grn.receivedBy}</td>
                <td className="px-8 py-6 text-right">
                  <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="View Details">
                    <span className="material-symbols-outlined text-sm">visibility</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderRMA = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">RMA Management</h2>
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
          <span className="material-symbols-outlined text-sm">add</span>
          Create RMA
        </button>
      </div>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">RMA #</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Supplier</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date Created</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rmas.map((rma) => (
              <tr key={rma.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                <td className="px-8 py-6 font-black text-primary text-xs">{rma.rmaNumber}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-900">{rma.supplierName}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">
                  {rma.items.length} {rma.items.length === 1 ? 'Item' : 'Items'}
                </td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{rma.createdAt}</td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(rma.status)}`}>
                    {rma.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Edit">
                      <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Print Label">
                      <span className="material-symbols-outlined text-sm">print</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
            { id: 'po', label: 'Purchase Orders', icon: 'shopping_bag' },
            { id: 'grn', label: 'Received Notes', icon: 'inventory' },
            { id: 'rma', label: 'RMA', icon: 'assignment_return' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                activeTab === tab.id 
                  ? 'bg-primary text-white shadow-lg shadow-primary/20' 
                  : 'text-slate-400 hover:text-primary hover:bg-slate-50'
              }`}
            >
              <span className="material-symbols-outlined text-sm">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'po' && renderPO()}
          {activeTab === 'grn' && renderGRN()}
          {activeTab === 'rma' && renderRMA()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
