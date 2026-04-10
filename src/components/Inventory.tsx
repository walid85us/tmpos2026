import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState, StockItem } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { StockMovement, RefurbishmentJob, TransferLineItem } from '../types';
import type { ShipmentPrefill } from './ShippingCenter';
import ContextualHelp from './ContextualHelp';

type InventoryTab = 'inventory' | 'movements' | 'suggestive' | 'trade-in' | 'refurb' | 'transfer' | 'count' | 'bills' | 'giftcards' | 'bundles';
type FilterType = 'all' | 'serialized' | 'non-serialized' | 'handset';

const Inventory: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    approvedStockItems, pendingStockItems, addStockItem, updateStockItem, deleteStockItem,
    stockMovements, addStockMovement,
    inventoryTransfers, addInventoryTransfer, updateInventoryTransfer,
    inventoryCounts, addInventoryCount, updateInventoryCount,
    tradeIns, addTradeIn, updateTradeIn, deleteTradeIn,
    refurbishmentJobs, addRefurbishmentJob, updateRefurbishmentJob,
    suppliers, customers, storeLocations, getItemMovements,
    shipments,
  } = useStoreLocalState();
  const { checkPermission, checkSubPermission, canAccess } = useAccess();
  const navigate = useNavigate();
  const hasInventoryPermission = checkPermission('inventory', 'manage');
  const hasInventoryEdit = checkPermission('inventory', 'edit');
  const hasInventoryView = checkPermission('inventory', 'view');
  const canAdjustStock = checkSubPermission('adjust_stock');
  const canManageTransfers = checkSubPermission('manage_transfers');
  const canManageTradeIns = checkSubPermission('manage_trade_ins');
  const canManageRefurbishment = checkSubPermission('manage_refurbishment');
  const canManageStockCounts = checkSubPermission('manage_stock_counts');
  const canCreateInventoryItems = checkSubPermission('create_inventory_items');

  const [activeTab, setActiveTab] = useState<InventoryTab>('inventory');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [showRepairParts, setShowRepairParts] = useState(false);
  const [showLowStock, setShowLowStock] = useState(false);
  const [showHiddenPOS, setShowHiddenPOS] = useState(false);

  const [isAddProductModalOpen, setIsAddProductModalOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<StockItem | null>(null);
  const [detailTab, setDetailTab] = useState<'info' | 'movements' | 'edit'>('info');

  useEffect(() => {
    const itemId = searchParams.get('item');
    const action = searchParams.get('action');
    if (itemId) {
      const match = approvedStockItems.find(si => si.id === itemId);
      if (match) {
        setActiveTab('inventory');
        setSelectedItem(match);
        setDetailTab('info');
        if (action === 'adjust' && canAdjustStock) {
          setAdjustItem(match);
          setAdjustType('increase');
          setAdjustQty('');
          setAdjustReason('Restock');
          setAdjustNotes('');
          setShowAdjustModal(true);
        }
      }
      setSearchParams({}, { replace: true });
    }
  }, []);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustItem, setAdjustItem] = useState<StockItem | null>(null);
  const [adjustType, setAdjustType] = useState<'increase' | 'decrease'>('increase');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustNotes, setAdjustNotes] = useState('');

  const [newProductName, setNewProductName] = useState('');
  const [newProductCategory, setNewProductCategory] = useState('Parts');
  const [newProductSku, setNewProductSku] = useState('');
  const [newProductUpc, setNewProductUpc] = useState('');
  const [newProductCost, setNewProductCost] = useState('');
  const [newProductPrice, setNewProductPrice] = useState('');
  const [newProductQty, setNewProductQty] = useState('1');
  const [newProductType, setNewProductType] = useState<'serialized' | 'non-serialized' | 'handset'>('non-serialized');
  const [newProductIsRepairPart, setNewProductIsRepairPart] = useState(false);
  const [newProductIsHiddenOnPOS, setNewProductIsHiddenOnPOS] = useState(false);
  const [newProductManufacturer, setNewProductManufacturer] = useState('');
  const [newProductMinStock, setNewProductMinStock] = useState('');
  const [newProductMaxStock, setNewProductMaxStock] = useState('');
  const [newProductLocation, setNewProductLocation] = useState('');
  const [newProductSupplierId, setNewProductSupplierId] = useState('');
  const [newProductSuggestive, setNewProductSuggestive] = useState(false);
  const [addProductSuccess, setAddProductSuccess] = useState(false);

  const [showCreateTransfer, setShowCreateTransfer] = useState(false);
  const [showCreateCount, setShowCreateCount] = useState(false);
  const [showCreateTradeIn, setShowCreateTradeIn] = useState(false);

  const [editingSuggestiveItem, setEditingSuggestiveItem] = useState<StockItem | null>(null);
  const [editSugName, setEditSugName] = useState('');
  const [editSugPrice, setEditSugPrice] = useState('');
  const [editSugCategory, setEditSugCategory] = useState('');
  const [editSugSaveSuccess, setEditSugSaveSuccess] = useState(false);

  const [selectedTransfer, setSelectedTransfer] = useState<string | null>(null);
  const [transferConfirmAction, setTransferConfirmAction] = useState<{ id: string; action: string; label: string } | null>(null);
  const [transferReceiveModal, setTransferReceiveModal] = useState<string | null>(null);
  const [transferReceiveQtys, setTransferReceiveQtys] = useState<Record<number, number>>({});
  const [transferReceiveConditions, setTransferReceiveConditions] = useState<Record<number, string>>({});
  const [transferReceiveNotes, setTransferReceiveNotes] = useState<Record<number, string>>({});
  const [editingTransfer, setEditingTransfer] = useState<string | null>(null);
  const [editTransferFrom, setEditTransferFrom] = useState('');
  const [editTransferTo, setEditTransferTo] = useState('');
  const [editTransferNotes, setEditTransferNotes] = useState('');
  const [editTransferItems, setEditTransferItems] = useState<{ productId: string; name: string; sku: string; quantity: number; isSerialized: boolean }[]>([]);
  const [createTransferFrom, setCreateTransferFrom] = useState('');
  const [createTransferTo, setCreateTransferTo] = useState('');
  const [createTransferNotes, setCreateTransferNotes] = useState('');
  const [createTransferItems, setCreateTransferItems] = useState<{ productId: string; name: string; sku: string; quantity: number; isSerialized: boolean }[]>([]);

  const [selectedCount, setSelectedCount] = useState<string | null>(null);
  const [countActuals, setCountActuals] = useState<Record<string, number>>({});
  const [countConfirmComplete, setCountConfirmComplete] = useState(false);

  const [selectedRefurbJob, setSelectedRefurbJob] = useState<RefurbishmentJob | null>(null);
  const [refurbConfirmComplete, setRefurbConfirmComplete] = useState(false);
  const [refurbCompletionNote, setRefurbCompletionNote] = useState('');
  const [refurbNewResale, setRefurbNewResale] = useState('');

  const [tradeInSearch, setTradeInSearch] = useState('');
  const [tradeInIsWalkIn, setTradeInIsWalkIn] = useState(false);
  const [tradeInSelectedCustomerId, setTradeInSelectedCustomerId] = useState('');
  const [editingTradeIn, setEditingTradeIn] = useState<string | null>(null);
  const [tradeInConfirm, setTradeInConfirm] = useState<{ id: string; action: string; label: string; notes?: boolean } | null>(null);
  const [tradeInConfirmNotes, setTradeInConfirmNotes] = useState('');
  const [deleteTradeInConfirm, setDeleteTradeInConfirm] = useState<string | null>(null);

  const idPhotoCaptureRef = useRef<HTMLInputElement>(null);
  const [capturedIdPhoto, setCapturedIdPhoto] = useState<string>('');
  const [viewingTradeIn, setViewingTradeIn] = useState<string | null>(null);
  const [editTradeInPhoto, setEditTradeInPhoto] = useState<string>('');
  const editIdPhotoRef = useRef<HTMLInputElement>(null);
  const [countReAdjustMode, setCountReAdjustMode] = useState(false);

  const resetAddProductForm = () => {
    setNewProductName(''); setNewProductCategory('Parts'); setNewProductSku('');
    setNewProductUpc(''); setNewProductCost(''); setNewProductPrice(''); setNewProductQty('1');
    setNewProductType('non-serialized'); setNewProductIsRepairPart(false);
    setNewProductIsHiddenOnPOS(false); setNewProductManufacturer('');
    setNewProductMinStock(''); setNewProductMaxStock(''); setNewProductLocation('');
    setNewProductSupplierId(''); setNewProductSuggestive(false); setAddProductSuccess(false);
  };

  const allInventoryItems = approvedStockItems;
  const categories = useMemo(() => [...new Set(allInventoryItems.map(p => p.category))], [allInventoryItems]);

  const filteredProducts = useMemo(() => {
    return allInventoryItems.filter(p => {
      if (categoryFilter && p.category !== categoryFilter) return false;
      if (typeFilter !== 'all' && p.type !== typeFilter) return false;
      if (showRepairParts && !p.isRepairPart) return false;
      if (showLowStock && p.qty > (p.minStockLevel || 5)) return false;
      if (showHiddenPOS && !p.isHiddenOnPOS) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.upc && p.upc.toLowerCase().includes(q));
      }
      return true;
    });
  }, [allInventoryItems, categoryFilter, typeFilter, showRepairParts, showLowStock, showHiddenPOS, searchQuery]);

  const stats = useMemo(() => {
    const totalItems = allInventoryItems.reduce((sum, i) => sum + i.qty, 0);
    const totalValue = allInventoryItems.reduce((sum, i) => sum + (i.cost * i.qty), 0);
    const lowStock = allInventoryItems.filter(i => i.qty > 0 && i.qty <= (i.minStockLevel || 5)).length;
    const outOfStock = allInventoryItems.filter(i => i.qty === 0).length;
    return { totalItems, totalValue, lowStock, outOfStock };
  }, [allInventoryItems]);

  const handleSaveProduct = () => {
    if (!newProductName.trim()) return;
    const sup = suppliers.find(s => s.id === newProductSupplierId);
    const item: StockItem = {
      id: `stk-${Date.now()}`,
      name: newProductName.trim(),
      sku: newProductSku || `SKU-${Date.now().toString().slice(-6)}`,
      upc: newProductUpc || undefined,
      qty: parseInt(newProductQty) || 1,
      cost: parseFloat(newProductCost) || 0,
      price: parseFloat(newProductPrice) || 0,
      category: newProductCategory,
      type: newProductType,
      isRepairPart: newProductIsRepairPart,
      isHiddenOnPOS: newProductIsHiddenOnPOS,
      manufacturer: newProductManufacturer || undefined,
      minStockLevel: newProductMinStock ? parseInt(newProductMinStock) : undefined,
      maxStockLevel: newProductMaxStock ? parseInt(newProductMaxStock) : undefined,
      location: newProductLocation || undefined,
      supplierId: newProductSupplierId || undefined,
      supplierName: sup?.name,
      addedAt: new Date().toISOString(),
      status: hasInventoryPermission ? 'approved' : 'pending_approval',
      isSuggestiveSale: newProductSuggestive,
    };
    addStockItem(item);
    if (item.status === 'approved' && item.qty > 0) {
      addStockMovement({
        id: `sm-${Date.now()}`, stockItemId: item.id, stockItemName: item.name,
        type: 'initial_stock', quantityChange: item.qty, previousQty: 0, newQty: item.qty,
        performedBy: 'Current User', timestamp: new Date().toISOString(), notes: 'Initial stock on product creation',
      });
    }
    setAddProductSuccess(true);
    setTimeout(() => { setIsAddProductModalOpen(false); resetAddProductForm(); }, 1200);
  };

  const handleAdjustStock = () => {
    if (!canAdjustStock || !adjustItem || !adjustQty) return;
    const qty = parseInt(adjustQty);
    if (qty <= 0) return;
    const change = adjustType === 'increase' ? qty : -qty;
    const newQty = Math.max(0, adjustItem.qty + change);
    updateStockItem(adjustItem.id, { qty: newQty });
    addStockMovement({
      id: `sm-${Date.now()}`, stockItemId: adjustItem.id, stockItemName: adjustItem.name,
      type: adjustType === 'increase' ? 'adjustment_increase' : 'adjustment_decrease',
      quantityChange: change, previousQty: adjustItem.qty, newQty,
      reason: adjustReason || (adjustType === 'increase' ? 'Manual stock increase' : 'Manual stock decrease'),
      performedBy: 'Current User', timestamp: new Date().toISOString(), notes: adjustNotes || undefined,
    });
    setShowAdjustModal(false);
    setAdjustItem(null); setAdjustQty(''); setAdjustReason(''); setAdjustNotes('');
    if (selectedItem?.id === adjustItem.id) {
      setSelectedItem({ ...adjustItem, qty: newQty });
    }
  };

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case 'Parts': return 'build';
      case 'Accessories': return 'cable';
      case 'Devices': return 'smartphone';
      default: return 'inventory_2';
    }
  };

  const getMovementLabel = (type: string) => {
    const labels: Record<string, string> = {
      adjustment_increase: 'Stock Increase', adjustment_decrease: 'Stock Decrease',
      sale: 'Sale', refund_restock: 'Refund Restock',
      repair_consumption: 'Repair Usage', repair_return: 'Repair Return',
      transfer_out: 'Transfer Out', transfer_in: 'Transfer In',
      receiving: 'PO Receiving', trade_in_conversion: 'Trade-In',
      refurbishment_complete: 'Refurbishment', rma_return: 'RMA Return',
      initial_stock: 'Initial Stock', count_adjustment: 'Count Adjustment',
    };
    return labels[type] || type;
  };

  const getMovementColor = (type: string) => {
    if (type.includes('increase') || type === 'receiving' || type === 'refund_restock' || type === 'transfer_in' || type === 'trade_in_conversion' || type === 'refurbishment_complete' || type === 'initial_stock' || type === 'repair_return') {
      return 'text-emerald-600';
    }
    return 'text-red-600';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Received': case 'Completed': case 'Closed': case 'In Inventory': return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
      case 'Sent': case 'In Transit': case 'In Progress': case 'Refurbishing': case 'Testing': return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
      case 'Draft': case 'Pending': case 'Evaluated': return 'bg-primary/10 text-primary border-primary/20';
      case 'Cancelled': return 'bg-rose-500/10 text-rose-600 border-rose-500/20';
      case 'Partially Received': return 'bg-orange-500/10 text-orange-600 border-orange-500/20';
      case 'Discrepancy Detected': return 'bg-red-500/10 text-red-600 border-red-500/20';
      default: return 'bg-slate-500/10 text-slate-600 border-slate-500/20';
    }
  };

  const tabs = [
    { id: 'inventory' as InventoryTab, label: 'Inventory', icon: 'inventory_2' },
    { id: 'movements' as InventoryTab, label: 'Movements', icon: 'swap_vert' },
    { id: 'suggestive' as InventoryTab, label: 'Suggestive Sales', icon: 'lightbulb' },
    { id: 'trade-in' as InventoryTab, label: 'Trade-In', icon: 'swap_horiz' },
    { id: 'refurb' as InventoryTab, label: 'Refurbishment', icon: 'build_circle' },
    { id: 'transfer' as InventoryTab, label: 'Transfers', icon: 'local_shipping' },
    { id: 'count' as InventoryTab, label: 'Stock Count', icon: 'checklist' },
  ];

  const renderSummaryCards = () => (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {[
        { label: 'Total Units', value: stats.totalItems.toLocaleString(), icon: 'inventory_2', color: 'text-primary' },
        { label: 'Inventory Value', value: `$${stats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, icon: 'attach_money', color: 'text-primary' },
        { label: 'Low Stock', value: stats.lowStock.toString(), icon: 'warning', color: stats.lowStock > 0 ? 'text-orange-500' : 'text-slate-400' },
        { label: 'Out of Stock', value: stats.outOfStock.toString(), icon: 'block', color: stats.outOfStock > 0 ? 'text-red-500' : 'text-slate-400' },
      ].map((card) => (
        <div key={card.label} className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <span className={`material-symbols-outlined text-sm ${card.color}`}>{card.icon}</span>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{card.label}</p>
          </div>
          <p className={`text-xl font-black ${card.color}`}>{card.value}</p>
        </div>
      ))}
    </div>
  );

  const renderFilterBar = () => (
    <div className="flex flex-wrap gap-2 items-center">
      <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="px-4 py-2.5 bg-white border border-slate-200 text-sm font-bold rounded-xl">
        <option value="">All Categories</option>
        {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
      </select>
      <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as FilterType)} className="px-4 py-2.5 bg-white border border-slate-200 text-sm font-bold rounded-xl">
        <option value="all">All Types</option>
        <option value="serialized">Serialized</option>
        <option value="non-serialized">Non-Serialized</option>
        <option value="handset">Handset</option>
      </select>
      {[
        { active: showRepairParts, toggle: () => setShowRepairParts(!showRepairParts), label: 'Repair Parts', icon: 'build' },
        { active: showLowStock, toggle: () => setShowLowStock(!showLowStock), label: 'Low Stock', icon: 'warning' },
        { active: showHiddenPOS, toggle: () => setShowHiddenPOS(!showHiddenPOS), label: 'Hidden on POS', icon: 'visibility_off' },
      ].map(f => (
        <button key={f.label} onClick={f.toggle} className={`px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-1.5 border transition-all ${f.active ? 'bg-primary text-white border-primary shadow-md' : 'bg-white text-slate-500 border-slate-200 hover:border-primary/30'}`}>
          <span className="material-symbols-outlined text-sm">{f.icon}</span>{f.label}
        </button>
      ))}
    </div>
  );

  const renderInventory = () => (
    <div className="space-y-5">
      {renderSummaryCards()}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="relative w-full md:w-96">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">search</span>
          <input type="text" placeholder="Search name, SKU, UPC..." className="w-full pl-12 pr-4 py-3 bg-white/50 backdrop-blur-md border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <button onClick={() => window.print()} className="flex-1 md:flex-none px-5 py-3 bg-white border border-slate-200 text-primary font-black text-xs rounded-2xl hover:bg-slate-50 transition-all uppercase tracking-widest flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">file_download</span>Export
          </button>
          {canCreateInventoryItems ? (
            <button onClick={() => { resetAddProductForm(); setIsAddProductModalOpen(true); }} className="flex-1 md:flex-none px-5 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center justify-center gap-2">
              <span className="material-symbols-outlined text-sm">add</span>Add Product
            </button>
          ) : (
            <button disabled className="flex-1 md:flex-none px-5 py-3 bg-slate-200 text-slate-400 font-black text-xs rounded-2xl uppercase tracking-widest flex items-center justify-center gap-2 cursor-not-allowed">
              <span className="material-symbols-outlined text-sm">lock</span>Add Product
            </button>
          )}
        </div>
      </div>

      {renderFilterBar()}

      {hasInventoryPermission && pendingStockItems.length > 0 && (
        <div className="bg-amber-50 rounded-[2.5rem] border border-amber-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="material-symbols-outlined text-amber-600">pending_actions</span>
            <h3 className="text-sm font-black text-amber-800 uppercase tracking-widest">Pending Approval ({pendingStockItems.length})</h3>
          </div>
          <div className="space-y-2">
            {pendingStockItems.map(item => (
              <div key={item.id} className="flex items-center justify-between p-4 bg-white rounded-2xl border border-amber-100">
                <div>
                  <p className="font-bold text-slate-900">{item.name}</p>
                  <p className="text-[10px] text-slate-400">SKU: {item.sku} · Qty: {item.qty} · ${item.price.toFixed(2)}</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => updateStockItem(item.id, { status: 'approved' })} className="px-4 py-2 bg-lime-500 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-lime-600 transition-all">Approve</button>
                  <button onClick={() => updateStockItem(item.id, { status: 'rejected' })} className="px-4 py-2 bg-slate-200 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-red-100 hover:text-red-600 transition-all">Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Product Details</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Type</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">SKU</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Price</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Stock</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Flags</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-8 py-12 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center"><span className="material-symbols-outlined text-3xl text-slate-300">inventory_2</span></div>
                      <p className="text-sm font-bold text-slate-400">No inventory items found</p>
                    </div>
                  </td>
                </tr>
              ) : filteredProducts.map((product) => {
                const isLow = product.qty > 0 && product.qty <= (product.minStockLevel || 5);
                return (
                  <tr key={product.id} className="group hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 cursor-pointer" onClick={() => { setSelectedItem(product); setDetailTab('info'); }}>
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-4">
                        <div className="w-11 h-11 bg-slate-100 rounded-xl flex items-center justify-center shrink-0">
                          <span className="material-symbols-outlined text-slate-400">{getCategoryIcon(product.category)}</span>
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-slate-900 truncate">{product.name}</p>
                          <p className="text-[10px] font-bold text-slate-400">{product.category}{product.manufacturer ? ` · ${product.manufacturer}` : ''}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-5">
                      <span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">{product.type}</span>
                    </td>
                    <td className="px-6 py-5"><p className="font-mono text-xs font-bold text-slate-500">{product.sku}</p></td>
                    <td className="px-6 py-5">
                      <p className="font-black text-primary">${product.price.toFixed(2)}</p>
                      <p className="text-[10px] text-slate-400 font-bold">Cost: ${product.cost.toFixed(2)}</p>
                    </td>
                    <td className="px-6 py-5">
                      {product.qty === 0 ? (
                        <span className="px-2.5 py-1 bg-red-100 text-red-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-red-200 inline-flex items-center gap-1">
                          <span className="material-symbols-outlined text-xs">block</span>Out of Stock
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-slate-100 h-1.5 rounded-full overflow-hidden">
                            <div className={`h-full transition-all ${product.qty <= (product.minStockLevel || 5) ? 'bg-red-500' : product.qty <= (product.minStockLevel || 5) * 2 ? 'bg-orange-500' : 'bg-lime-500'}`} style={{ width: `${Math.min((product.qty / (product.maxStockLevel || 30)) * 100, 100)}%` }}></div>
                          </div>
                          <span className={`text-sm font-black ${isLow ? 'text-red-600' : 'text-primary'}`}>{product.qty}</span>
                          {isLow && <span className="text-[9px] font-black text-red-500 uppercase">Low</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-5">
                      <div className="flex gap-1">
                        {product.isRepairPart && <span className="material-symbols-outlined text-sm text-orange-500" title="Repair Part">build</span>}
                        {product.isHiddenOnPOS && <span className="material-symbols-outlined text-sm text-slate-400" title="Hidden on POS">visibility_off</span>}
                        {product.isSuggestiveSale && <span className="material-symbols-outlined text-sm text-lime-500" title="Suggestive Sale">lightbulb</span>}
                      </div>
                    </td>
                    <td className="px-6 py-5 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {canAdjustStock && <button onClick={() => { setAdjustItem(product); setAdjustType('increase'); setAdjustQty(''); setAdjustReason(''); setAdjustNotes(''); setShowAdjustModal(true); }} className="p-2 hover:bg-emerald-50 rounded-xl text-slate-400 hover:text-emerald-600" title="Adjust Stock">
                          <span className="material-symbols-outlined text-sm">tune</span>
                        </button>}
                        <button onClick={() => { setSelectedItem(product); setDetailTab('info'); }} className="p-2 hover:bg-white rounded-xl text-slate-400 hover:text-primary" title="View Details">
                          <span className="material-symbols-outlined text-sm">visibility</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const renderMovements = () => {
    const sorted = [...stockMovements].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-black text-primary tracking-tight">Stock Movement Log</h2>
          <span className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black text-slate-500 uppercase tracking-widest">{sorted.length} Records</span>
        </div>
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Item</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Type</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Change</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Qty After</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">By</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reason</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(m => (
                <tr key={m.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                  <td className="px-8 py-5 text-xs font-bold text-slate-500">{new Date(m.timestamp).toLocaleDateString()} {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-900">{m.stockItemName}</td>
                  <td className="px-6 py-5"><span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">{getMovementLabel(m.type)}</span></td>
                  <td className={`px-6 py-5 font-black ${getMovementColor(m.type)}`}>{m.quantityChange > 0 ? '+' : ''}{m.quantityChange}</td>
                  <td className="px-6 py-5 font-bold text-slate-700">{m.newQty}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-500">{m.performedBy}</td>
                  <td className="px-6 py-5 text-xs text-slate-400 max-w-[200px] truncate">{m.reason || m.notes || '—'}</td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={7} className="px-8 py-12 text-center text-sm font-bold text-slate-400">No stock movements recorded yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const filteredCustomers = useMemo(() => {
    if (!tradeInSearch.trim()) return customers;
    const q = tradeInSearch.toLowerCase();
    return customers.filter(c => c.name.toLowerCase().includes(q) || c.phone?.toLowerCase().includes(q));
  }, [customers, tradeInSearch]);

  const renderTradeIn = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Buyback & Trade-In</h2>
        {canManageTradeIns ? (
          <button onClick={() => { setShowCreateTradeIn(true); setTradeInIsWalkIn(false); setTradeInSearch(''); setTradeInSelectedCustomerId(''); setCapturedIdPhoto(''); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
            <span className="material-symbols-outlined text-sm">add</span>New Trade-In
          </button>
        ) : (
          <button disabled className="px-6 py-3 bg-slate-200 text-slate-400 font-black text-xs rounded-2xl uppercase tracking-widest flex items-center gap-2 cursor-not-allowed">
            <span className="material-symbols-outlined text-sm">lock</span>New Trade-In
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {tradeIns.map((item) => (
          <div key={item.id} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(item.status)}`}>{item.status}</span>
                <h3 className="text-lg font-black text-primary tracking-tight mt-2">{item.device}</h3>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{item.createdAt}</span>
                {canManageTradeIns && (item.status === 'Pending' || item.status === 'Evaluated') && (
                  <>
                    <button onClick={() => { setEditingTradeIn(item.id); setEditTradeInPhoto(item.idPhotoUrl || ''); }} className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-primary transition-colors" title="Edit">
                      <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                    <button onClick={() => setDeleteTradeInConfirm(item.id)} className="p-1.5 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-500 transition-colors" title="Delete">
                      <span className="material-symbols-outlined text-sm">delete</span>
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="space-y-2 mb-4 text-sm">
              <div className="flex justify-between"><span className="text-slate-500 font-bold">Customer</span><span className="text-slate-900 font-black">{item.isWalkIn ? 'Walk-in Customer' : item.customerName}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 font-bold">Condition</span><span className="text-slate-900 font-black">{item.condition}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 font-bold">Buyback</span><span className="text-primary font-black">${item.buybackPrice}</span></div>
              {item.resalePrice && <div className="flex justify-between"><span className="text-slate-500 font-bold">Resale</span><span className="text-emerald-600 font-black">${item.resalePrice}</span></div>}
              {item.idPhotoUrl && <div className="flex justify-between"><span className="text-slate-500 font-bold">ID Photo</span><span className="text-emerald-600 font-black text-[10px]">Captured</span></div>}
              {item.gradeNotes && <p className="text-xs text-slate-400 italic pt-1">{item.gradeNotes}</p>}
            </div>
            <div className="flex gap-2 mb-3">
              <button onClick={() => setViewingTradeIn(item.id)} className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-1">
                <span className="material-symbols-outlined text-sm">visibility</span>View Details
              </button>
            </div>
            {canManageTradeIns && item.status === 'Pending' && (
              <div className="flex gap-2">
                <button onClick={() => setTradeInConfirm({ id: item.id, action: 'evaluate', label: `Evaluate trade-in for ${item.device}?` })} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">Evaluate</button>
                <button onClick={() => {
                  if (!canManageTradeIns) return;
                  const newItem: StockItem = {
                    id: `stk-ti-${Date.now()}`, name: `${item.device} (Trade-In)`, sku: `TI-${Date.now().toString().slice(-6)}`,
                    qty: 1, cost: item.buybackPrice, price: item.resalePrice || item.buybackPrice * 1.5,
                    category: 'Devices', type: 'serialized', isRepairPart: false, isHiddenOnPOS: false,
                    serialNumbers: item.imei ? [item.imei] : item.serialNumber ? [item.serialNumber] : undefined,
                    addedAt: new Date().toISOString(), status: 'approved',
                  };
                  addStockItem(newItem);
                  addStockMovement({
                    id: `sm-${Date.now()}`, stockItemId: newItem.id, stockItemName: newItem.name,
                    type: 'trade_in_conversion', quantityChange: 1, previousQty: 0, newQty: 1,
                    referenceId: item.id, referenceType: 'trade_in',
                    performedBy: 'Current User', timestamp: new Date().toISOString(),
                    reason: `Trade-in from ${item.customerName}`,
                  });
                  updateTradeIn(item.id, { status: 'In Inventory', movedToInventoryId: newItem.id });
                }} className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">Move to Stock</button>
              </div>
            )}
            {canManageTradeIns && item.status === 'Evaluated' && (
              <div className="flex gap-2">
                <button onClick={() => setTradeInConfirm({ id: item.id, action: 'refurb', label: `Send ${item.device} to refurbishment?`, notes: true })} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">Send to Refurb</button>
                <button onClick={() => {
                  if (!canManageTradeIns) return;
                  const newItem: StockItem = {
                    id: `stk-ti-${Date.now()}`, name: `${item.device} (Trade-In)`, sku: `TI-${Date.now().toString().slice(-6)}`,
                    qty: 1, cost: item.buybackPrice, price: item.resalePrice || item.buybackPrice * 1.5,
                    category: 'Devices', type: 'serialized', isRepairPart: false, isHiddenOnPOS: false,
                    addedAt: new Date().toISOString(), status: 'approved',
                  };
                  addStockItem(newItem);
                  addStockMovement({
                    id: `sm-${Date.now()}`, stockItemId: newItem.id, stockItemName: newItem.name,
                    type: 'trade_in_conversion', quantityChange: 1, previousQty: 0, newQty: 1,
                    referenceId: item.id, referenceType: 'trade_in',
                    performedBy: 'Current User', timestamp: new Date().toISOString(),
                    reason: `Trade-in from ${item.customerName}`,
                  });
                  updateTradeIn(item.id, { status: 'In Inventory', movedToInventoryId: newItem.id });
                }} className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">Move to Stock</button>
              </div>
            )}
          </div>
        ))}
        {tradeIns.length === 0 && (
          <div className="col-span-full flex flex-col items-center py-12">
            <span className="material-symbols-outlined text-4xl text-slate-300 mb-2">swap_horiz</span>
            <p className="text-sm font-bold text-slate-400">No trade-ins yet</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderRefurb = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Refurbishment Jobs</h2>
        <span className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black text-slate-500 uppercase tracking-widest">Active: {refurbishmentJobs.filter(j => j.status !== 'Completed').length}</span>
      </div>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Device</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Technician</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Parts</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Cost</th>
              <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {refurbishmentJobs.map((job) => (
              <tr key={job.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-5">
                  <button onClick={() => { setSelectedRefurbJob(job); setRefurbConfirmComplete(false); setRefurbCompletionNote(''); const ti = tradeIns.find(t => t.id === job.itemId); setRefurbNewResale(ti?.resalePrice?.toString() || ''); }} className="text-left">
                    <p className="font-bold text-slate-900 hover:text-primary transition-colors">{job.itemName}</p>
                    <p className="text-[10px] text-slate-400">{job.notes}</p>
                  </button>
                </td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{job.technicianName}</td>
                <td className="px-6 py-5"><span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(job.status)}`}>{job.status}</span></td>
                <td className="px-6 py-5 text-xs text-slate-600">{job.partsUsed.length > 0 ? job.partsUsed.map(p => p.name).join(', ') : '—'}</td>
                <td className="px-6 py-5 font-black text-primary">${job.totalCost.toFixed(2)}</td>
                <td className="px-6 py-5 text-right">
                  {canManageRefurbishment && job.status !== 'Completed' ? (
                    <button onClick={() => { setSelectedRefurbJob(job); setRefurbConfirmComplete(true); setRefurbCompletionNote(''); const ti = tradeIns.find(t => t.id === job.itemId); setRefurbNewResale(ti?.resalePrice?.toString() || ((ti?.buybackPrice || 0) + job.totalCost * 1.5).toFixed(0)); }} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 active:scale-95 transition-all">Complete</button>
                  ) : job.status === 'Completed' ? (
                    <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Done</span>
                  ) : (
                    <button disabled className="px-4 py-2 bg-slate-100 text-slate-400 text-[10px] font-black uppercase tracking-widest rounded-xl cursor-not-allowed flex items-center gap-1"><span className="material-symbols-outlined text-xs">lock</span>Complete</button>
                  )}
                </td>
              </tr>
            ))}
            {refurbishmentJobs.length === 0 && (
              <tr><td colSpan={6} className="px-8 py-12 text-center text-sm font-bold text-slate-400">No refurbishment jobs</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderTransfers = () => {
    const hasDiscrepancy = (t: typeof inventoryTransfers[0]) => t.items.some(i => i.receivedQty !== undefined && i.receivedQty !== i.quantity);
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-black text-primary tracking-tight">Inventory Transfers</h2>
          {canManageTransfers ? (
            <button onClick={() => { setShowCreateTransfer(true); setCreateTransferFrom(storeLocations[0] || ''); setCreateTransferTo(storeLocations[1] || ''); setCreateTransferNotes(''); setCreateTransferItems([]); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
              <span className="material-symbols-outlined text-sm">add</span>New Transfer
            </button>
          ) : (
            <button disabled className="px-6 py-3 bg-slate-200 text-slate-400 font-black text-xs rounded-2xl uppercase tracking-widest flex items-center gap-2 cursor-not-allowed">
              <span className="material-symbols-outlined text-sm">lock</span>New Transfer
            </button>
          )}
        </div>
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Transfer #</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">From / To</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Requested By</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {inventoryTransfers.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                  <td className="px-8 py-5">
                    <button onClick={() => setSelectedTransfer(t.id)} className="font-black text-primary text-xs hover:underline flex items-center gap-1">
                      {t.transferNumber}
                      {hasDiscrepancy(t) && <span className="material-symbols-outlined text-red-500 text-xs">error</span>}
                    </button>
                  </td>
                  <td className="px-6 py-5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900">{t.fromStore}</span>
                      <span className="material-symbols-outlined text-slate-300 text-sm">arrow_forward</span>
                      <span className="text-sm font-bold text-slate-900">{t.toStore}</span>
                    </div>
                  </td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-600">{t.items.length} item{t.items.length !== 1 ? 's' : ''}</td>
                  <td className="px-6 py-5">
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(t.status)}`}>{t.status}</span>
                    {hasDiscrepancy(t) && <span className="ml-1 px-2 py-0.5 bg-red-100 text-red-700 text-[9px] font-black rounded uppercase">Mismatch</span>}
                  </td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-500">{t.requestedBy || '—'}</td>
                  <td className="px-6 py-5 text-right">
                    <div className="flex justify-end gap-2">
                      {canManageTransfers && t.status === 'Draft' && <button onClick={() => setTransferConfirmAction({ id: t.id, action: 'send', label: `Send transfer ${t.transferNumber}?` })} className="px-3 py-1.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90">Send</button>}
                      {canManageTransfers && t.status === 'Sent' && <button onClick={() => setTransferConfirmAction({ id: t.id, action: 'transit', label: `Mark ${t.transferNumber} as In Transit?` })} className="px-3 py-1.5 bg-amber-500 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-amber-600">In Transit</button>}
                      {canManageTransfers && (t.status === 'Sent' || t.status === 'In Transit') && <button onClick={() => { setTransferReceiveModal(t.id); const qtys: Record<number, number> = {}; const conds: Record<number, string> = {}; const notes: Record<number, string> = {}; t.items.forEach((item, idx) => { qtys[idx] = item.quantity; conds[idx] = 'Good'; notes[idx] = ''; }); setTransferReceiveQtys(qtys); setTransferReceiveConditions(conds); setTransferReceiveNotes(notes); }} className="px-3 py-1.5 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-emerald-600">Receive</button>}
                    </div>
                  </td>
                </tr>
              ))}
              {inventoryTransfers.length === 0 && (
                <tr><td colSpan={6} className="px-8 py-12 text-center text-sm font-bold text-slate-400">No transfers</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderCount = () => {
    const totalDiscrepancies = inventoryCounts.reduce((sum, c) => sum + c.items.filter(i => i.discrepancy !== 0).length, 0);
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-black text-primary tracking-tight">Stock Count & Audits</h2>
            {totalDiscrepancies > 0 && <p className="text-xs text-orange-600 font-bold mt-1">{totalDiscrepancies} total discrepancies found across all counts</p>}
          </div>
          {canManageStockCounts ? (
            <button onClick={() => setShowCreateCount(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
              <span className="material-symbols-outlined text-sm">add</span>Start New Count
            </button>
          ) : (
            <button disabled className="px-6 py-3 bg-slate-200 text-slate-400 font-black text-xs rounded-2xl uppercase tracking-widest flex items-center gap-2 cursor-not-allowed">
              <span className="material-symbols-outlined text-sm">lock</span>Start New Count
            </button>
          )}
        </div>
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Count #</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Performed By</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Discrepancies</th>
                <th className="px-6 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {inventoryCounts.map((c) => {
                const discrepancies = c.items.filter(i => i.discrepancy !== 0).length;
                return (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                    <td className="px-8 py-5"><button onClick={() => { setSelectedCount(c.id); setCountConfirmComplete(false); const actuals: Record<string, number> = {}; c.items.forEach(i => { actuals[i.productId] = i.actual; }); setCountActuals(actuals); }} className="font-black text-primary text-xs hover:underline">{c.countNumber}</button></td>
                    <td className="px-6 py-5 text-sm font-bold text-slate-900">{c.date}</td>
                    <td className="px-6 py-5 text-sm font-bold text-slate-600">{c.performedBy}</td>
                    <td className="px-6 py-5 text-sm font-bold text-slate-600">{c.items.length}</td>
                    <td className="px-6 py-5"><span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(c.status)}`}>{c.status}</span></td>
                    <td className="px-6 py-5"><span className={`font-black ${discrepancies > 0 ? 'text-red-600' : 'text-slate-400'}`}>{discrepancies} item{discrepancies !== 1 ? 's' : ''}</span></td>
                    <td className="px-6 py-5 text-right">
                      {canManageStockCounts && c.status === 'In Progress' && (
                        <button onClick={() => { setSelectedCount(c.id); setCountConfirmComplete(false); const actuals: Record<string, number> = {}; c.items.forEach(i => { actuals[i.productId] = i.actual; }); setCountActuals(actuals); }} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 active:scale-95 transition-all">Review</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {inventoryCounts.length === 0 && (
                <tr><td colSpan={7} className="px-8 py-12 text-center text-sm font-bold text-slate-400">No stock counts</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderSuggestive = () => (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-black text-primary">Suggestive Sales Items</h3>
          <p className="text-xs text-slate-400 mt-1">Toggle items to appear as quick-add suggestions during POS checkout</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-lime-50 border border-lime-200 rounded-xl">
          <span className="material-symbols-outlined text-lime-600 text-sm">lightbulb</span>
          <span className="text-xs font-black text-lime-700">{approvedStockItems.filter(i => i.isSuggestiveSale).length} Active</span>
        </div>
      </div>
      {approvedStockItems.filter(i => i.isSuggestiveSale).length > 0 && (
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] ghost-border overflow-hidden">
          <div className="px-6 py-4 bg-lime-50/50 border-b border-lime-100">
            <p className="text-[10px] font-black text-lime-700 uppercase tracking-widest">Active Suggestive Items</p>
          </div>
          <div className="divide-y divide-slate-50">
            {approvedStockItems.filter(i => i.isSuggestiveSale).map(item => (
              <div key={item.id} className="flex items-center justify-between p-5 hover:bg-slate-50 transition-all">
                <button onClick={() => { setEditingSuggestiveItem(item); setEditSugName(item.name); setEditSugPrice(item.price.toString()); setEditSugCategory(item.category); setEditSugSaveSuccess(false); }} className="flex items-center gap-4 text-left flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-lime-100 text-lime-700"><span className="material-symbols-outlined text-lg">lightbulb</span></div>
                  <div className="min-w-0">
                    <p className="font-bold text-sm text-slate-900">{item.name}</p>
                    <p className="text-xs text-slate-500">{item.sku} · {item.category} · ${item.price.toFixed(2)} · {item.qty} in stock</p>
                  </div>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => { setEditingSuggestiveItem(item); setEditSugName(item.name); setEditSugPrice(item.price.toString()); setEditSugCategory(item.category); setEditSugSaveSuccess(false); }} className="p-2 hover:bg-white rounded-xl transition-all text-slate-400 hover:text-primary" title="Edit"><span className="material-symbols-outlined text-sm">edit</span></button>
                  <button onClick={() => updateStockItem(item.id, { isSuggestiveSale: false })} className="p-2 hover:bg-red-50 rounded-xl transition-all text-slate-400 hover:text-red-500" title="Remove"><span className="material-symbols-outlined text-sm">delete</span></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] ghost-border overflow-hidden">
        <div className="px-6 py-4 bg-slate-50/50 border-b border-slate-100">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">All Inventory Items</p>
        </div>
        <div className="divide-y divide-slate-50">
          {approvedStockItems.map(item => (
            <div key={item.id} className="flex items-center justify-between p-5 hover:bg-slate-50 transition-all">
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${item.isSuggestiveSale ? 'bg-lime-100 text-lime-700' : 'bg-slate-100 text-slate-400'}`}>
                  <span className="material-symbols-outlined text-lg">lightbulb</span>
                </div>
                <div>
                  <p className="font-bold text-sm text-slate-900">{item.name}</p>
                  <p className="text-xs text-slate-500">{item.sku} · {item.category} · ${item.price.toFixed(2)} · {item.qty === 0 ? <span className="text-red-500 font-black">Out of Stock</span> : <>{item.qty} in stock</>}</p>
                </div>
              </div>
              <button onClick={() => updateStockItem(item.id, { isSuggestiveSale: !item.isSuggestiveSale })} className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${item.isSuggestiveSale ? 'bg-lime-500' : 'bg-slate-200'}`}>
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform ${item.isSuggestiveSale ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          ))}
          {approvedStockItems.length === 0 && (
            <div className="py-12 text-center"><p className="text-sm font-bold text-slate-400">No approved stock items</p></div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-8 max-w-[1600px] mx-auto space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-4xl font-black text-primary tracking-tight mb-2">Inventory Management</h1>
          <p className="text-slate-500 font-medium">Track stock, trade-ins, and refurbishments across all locations.</p>
        </div>
        {stats.lowStock > 0 && (
          <button onClick={() => { setActiveTab('inventory'); setShowLowStock(true); }} className="flex items-center gap-3 px-5 py-3 bg-orange-50 border border-orange-200 rounded-2xl hover:bg-orange-100 transition-all">
            <span className="material-symbols-outlined text-orange-500">warning</span>
            <span className="text-sm font-black text-orange-700">{stats.lowStock} Low Stock Alert{stats.lowStock !== 1 ? 's' : ''}</span>
          </button>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`px-5 py-3.5 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2.5 transition-all whitespace-nowrap ${activeTab === tab.id ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'bg-white text-slate-400 hover:bg-slate-50 border border-slate-200'}`}>
            <span className="material-symbols-outlined text-lg">{tab.icon}</span>{tab.label}
            {tab.id === 'movements' && <span className="ml-1 px-1.5 py-0.5 bg-white/20 rounded text-[9px]">{stockMovements.length}</span>}
          </button>
        ))}
      </div>

      <motion.div key={activeTab} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
        {activeTab === 'inventory' && renderInventory()}
        {activeTab === 'movements' && renderMovements()}
        {activeTab === 'suggestive' && renderSuggestive()}
        {activeTab === 'trade-in' && renderTradeIn()}
        {activeTab === 'refurb' && renderRefurb()}
        {activeTab === 'transfer' && renderTransfers()}
        {activeTab === 'count' && renderCount()}
      </motion.div>

      <ContextualHelp
        title="Inventory Knowledge Hub"
        items={[
          { title: 'Inventory vs Service Items', description: 'Inventory items track physical stock, while service items represent labor and repairs.', icon: 'category' },
          { title: 'Serialized Inventory', description: 'Track unique items using IMEI or Serial Numbers for precise history and warranty tracking.', icon: 'barcode' },
          { title: 'Stock Movements', description: 'Every stock change is logged — adjustments, sales, repairs, receiving, and transfers all create audit entries.', icon: 'swap_vert' },
          { title: 'Transfer Inventory', description: 'Move stock between multiple store locations with full audit trails and real-time updates.', icon: 'local_shipping' },
          { title: 'Trade-In & Refurb', description: 'Accept customer trade-ins, evaluate condition, refurbish, and convert to sellable inventory.', icon: 'swap_horiz' },
        ]}
        accentColor="primary"
      />

      <AnimatePresence>
        {selectedItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <div>
                  <h2 className="text-xl font-black text-primary tracking-tight">{selectedItem.name}</h2>
                  <p className="text-slate-500 text-xs font-medium">SKU: {selectedItem.sku}{selectedItem.upc ? ` · UPC: ${selectedItem.upc}` : ''}</p>
                </div>
                <button onClick={() => setSelectedItem(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="flex border-b border-slate-100 shrink-0">
                {(['info', 'movements', ...(hasInventoryEdit ? ['edit' as const] : [])] as const).map(tab => (
                  <button key={tab} onClick={() => setDetailTab(tab as any)} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${detailTab === tab ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-slate-400 hover:text-slate-600'}`}>
                    {tab === 'info' ? 'Details' : tab === 'movements' ? 'Movements' : 'Edit'}
                  </button>
                ))}
              </div>
              <div className="p-8 overflow-y-auto flex-1">
                {detailTab === 'info' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      {[
                        { l: 'Category', v: selectedItem.category },
                        { l: 'Type', v: selectedItem.type },
                        { l: 'Price', v: `$${selectedItem.price.toFixed(2)}` },
                        { l: 'Cost', v: `$${selectedItem.cost.toFixed(2)}` },
                        { l: 'Quantity', v: selectedItem.qty.toString() },
                        { l: 'Min Stock', v: selectedItem.minStockLevel?.toString() || '—' },
                        { l: 'Max Stock', v: selectedItem.maxStockLevel?.toString() || '—' },
                        { l: 'Manufacturer', v: selectedItem.manufacturer || '—' },
                        { l: 'Location', v: selectedItem.location || '—' },
                        { l: 'Supplier', v: selectedItem.supplierName || '—' },
                      ].map(row => (
                        <div key={row.l} className="bg-slate-50 rounded-xl p-3">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{row.l}</p>
                          <p className="text-sm font-bold text-slate-900 mt-1">{row.v}</p>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {selectedItem.isRepairPart && <span className="px-3 py-1 bg-orange-50 text-orange-600 text-[10px] font-black uppercase tracking-widest rounded-lg border border-orange-200">Repair Part</span>}
                      {selectedItem.isHiddenOnPOS && <span className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg border border-slate-200">Hidden on POS</span>}
                      {selectedItem.isSuggestiveSale && <span className="px-3 py-1 bg-lime-50 text-lime-600 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-200">Suggestive Sale</span>}
                    </div>
                    {selectedItem.serialNumbers && selectedItem.serialNumbers.length > 0 && (
                      <div className="bg-slate-50 rounded-xl p-4">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Serial Numbers</p>
                        <div className="space-y-1">{selectedItem.serialNumbers.map((sn, i) => <p key={i} className="text-xs font-mono text-slate-600">{sn}</p>)}</div>
                      </div>
                    )}
                    <div className="flex gap-2 pt-2">
                      {canAdjustStock ? (
                        <button onClick={() => { setAdjustItem(selectedItem); setAdjustType('increase'); setAdjustQty(''); setAdjustReason(''); setAdjustNotes(''); setShowAdjustModal(true); }} className="flex-1 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">Adjust Stock</button>
                      ) : (
                        <button disabled className="flex-1 py-3 bg-slate-100 text-slate-400 font-black text-[10px] rounded-xl uppercase tracking-widest cursor-not-allowed flex items-center justify-center gap-1"><span className="material-symbols-outlined text-xs">lock</span>Adjust Stock</button>
                      )}
                      {hasInventoryEdit ? (
                        <button onClick={() => setDetailTab('edit')} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-slate-200 active:scale-95 transition-all">Edit Item</button>
                      ) : (
                        <button disabled className="flex-1 py-3 bg-slate-100 text-slate-400 font-black text-[10px] rounded-xl uppercase tracking-widest cursor-not-allowed flex items-center justify-center gap-1"><span className="material-symbols-outlined text-xs">lock</span>Edit Item</button>
                      )}
                    </div>
                  </div>
                )}
                {detailTab === 'movements' && (() => {
                  const movements = getItemMovements(selectedItem.id);
                  return (
                    <div className="space-y-3">
                      {movements.length === 0 ? (
                        <p className="text-sm text-slate-400 text-center py-8">No movement history for this item</p>
                      ) : movements.map(m => (
                        <div key={m.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
                          <div>
                            <p className="text-xs font-bold text-slate-900">{getMovementLabel(m.type)}</p>
                            <p className="text-[10px] text-slate-400">{new Date(m.timestamp).toLocaleString()} · {m.performedBy}</p>
                            {m.reason && <p className="text-[10px] text-slate-500 mt-0.5">{m.reason}</p>}
                          </div>
                          <span className={`font-black text-sm ${getMovementColor(m.type)}`}>{m.quantityChange > 0 ? '+' : ''}{m.quantityChange}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {detailTab === 'edit' && hasInventoryEdit && (
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Name</label>
                      <input type="text" defaultValue={selectedItem.name} onBlur={(e) => updateStockItem(selectedItem.id, { name: e.target.value })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Type</label>
                        <select defaultValue={selectedItem.type} onChange={(e) => updateStockItem(selectedItem.id, { type: e.target.value as any })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                          <option value="non-serialized">Non-Serialized</option>
                          <option value="serialized">Serialized</option>
                          <option value="handset">Handset</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Category</label>
                        <select defaultValue={selectedItem.category} onChange={(e) => updateStockItem(selectedItem.id, { category: e.target.value })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                          <option>Parts</option><option>Accessories</option><option>Devices</option><option>Other</option>
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Cost</label>
                        <input type="number" step="0.01" defaultValue={selectedItem.cost} onBlur={(e) => updateStockItem(selectedItem.id, { cost: parseFloat(e.target.value) || 0 })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Price</label>
                        <input type="number" step="0.01" defaultValue={selectedItem.price} onBlur={(e) => updateStockItem(selectedItem.id, { price: parseFloat(e.target.value) || 0 })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Min Stock</label>
                        <input type="number" defaultValue={selectedItem.minStockLevel || ''} onBlur={(e) => updateStockItem(selectedItem.id, { minStockLevel: parseInt(e.target.value) || undefined })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Max Stock</label>
                        <input type="number" defaultValue={selectedItem.maxStockLevel || ''} onBlur={(e) => updateStockItem(selectedItem.id, { maxStockLevel: parseInt(e.target.value) || undefined })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Location</label>
                      <input type="text" defaultValue={selectedItem.location || ''} onBlur={(e) => updateStockItem(selectedItem.id, { location: e.target.value || undefined })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Supplier</label>
                      <select defaultValue={selectedItem.supplierId || ''} onChange={(e) => { const sup = suppliers.find(s => s.id === e.target.value); updateStockItem(selectedItem.id, { supplierId: e.target.value || undefined, supplierName: sup?.name }); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                        <option value="">None</option>
                        {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" defaultChecked={selectedItem.isRepairPart} onChange={(e) => updateStockItem(selectedItem.id, { isRepairPart: e.target.checked })} className="w-4 h-4 rounded" />
                        <span className="text-xs font-bold text-slate-600">Repair Part</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" defaultChecked={selectedItem.isHiddenOnPOS} onChange={(e) => updateStockItem(selectedItem.id, { isHiddenOnPOS: e.target.checked })} className="w-4 h-4 rounded" />
                        <span className="text-xs font-bold text-slate-600">Hidden on POS</span>
                      </label>
                    </div>
                    <button onClick={() => { setSelectedItem(null); }} className="w-full py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all mt-4">Done</button>
                  </div>
                )}
                {detailTab === 'edit' && !hasInventoryEdit && (
                  <div className="flex flex-col items-center py-12 gap-3">
                    <span className="material-symbols-outlined text-4xl text-slate-300">lock</span>
                    <p className="text-sm font-bold text-slate-400">You don't have permission to edit inventory items</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {showAdjustModal && adjustItem && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-xl font-black text-primary tracking-tight">Adjust Stock</h2>
                <p className="text-xs font-bold text-slate-400">{adjustItem.name} · Current: {adjustItem.qty}</p>
              </div>
              <div className="p-8 space-y-5">
                <div className="flex gap-2">
                  <button onClick={() => setAdjustType('increase')} className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${adjustType === 'increase' ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-500'}`}>Increase</button>
                  <button onClick={() => setAdjustType('decrease')} className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${adjustType === 'decrease' ? 'bg-red-500 text-white' : 'bg-slate-100 text-slate-500'}`}>Decrease</button>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Quantity</label>
                  <input type="number" min="1" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-lg" placeholder="Enter quantity..." />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Reason</label>
                  <select value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                    <option value="">Select reason...</option>
                    <option>Recount correction</option>
                    <option>Damaged/Defective</option>
                    <option>Returned to supplier</option>
                    <option>Found in stock</option>
                    <option>Theft/Loss</option>
                    <option>Other</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes (Optional)</label>
                  <textarea value={adjustNotes} onChange={(e) => setAdjustNotes(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold h-20 resize-none" placeholder="Additional details..." />
                </div>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => setShowAdjustModal(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                  <button onClick={handleAdjustStock} disabled={!adjustQty || parseInt(adjustQty) <= 0} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all disabled:opacity-40">Apply Adjustment</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {isAddProductModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                <div>
                  <h2 className="text-xl font-black text-primary tracking-tight">Add Product</h2>
                  <p className="text-slate-500 text-xs font-medium">Add a new item to inventory</p>
                </div>
                <button onClick={() => { setIsAddProductModalOpen(false); resetAddProductForm(); }} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              {addProductSuccess ? (
                <div className="p-12 text-center space-y-4">
                  <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto"><span className="material-symbols-outlined text-3xl text-lime-600" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span></div>
                  <p className="text-lg font-black text-primary">Product Added</p>
                  {!hasInventoryPermission && <p className="text-xs text-slate-400">Sent for manager approval</p>}
                </div>
              ) : (
                <div className="p-8 space-y-5 overflow-y-auto flex-1">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Product Name *</label>
                    <input type="text" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="e.g. iPhone 15 Screen" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Category</label>
                      <select value={newProductCategory} onChange={(e) => setNewProductCategory(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                        <option>Parts</option><option>Accessories</option><option>Devices</option><option>Other</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Type</label>
                      <select value={newProductType} onChange={(e) => setNewProductType(e.target.value as any)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                        <option value="non-serialized">Non-Serialized</option><option value="serialized">Serialized</option><option value="handset">Handset</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">SKU</label>
                      <input type="text" value={newProductSku} onChange={(e) => setNewProductSku(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Auto-generated" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">UPC</label>
                      <input type="text" value={newProductUpc} onChange={(e) => setNewProductUpc(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Barcode" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Cost</label>
                      <input type="number" step="0.01" value={newProductCost} onChange={(e) => setNewProductCost(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0.00" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Price</label>
                      <input type="number" step="0.01" value={newProductPrice} onChange={(e) => setNewProductPrice(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0.00" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Qty</label>
                      <input type="number" value={newProductQty} onChange={(e) => setNewProductQty(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Manufacturer</label>
                      <input type="text" value={newProductManufacturer} onChange={(e) => setNewProductManufacturer(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Brand" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Min Stock</label>
                      <input type="number" value={newProductMinStock} onChange={(e) => setNewProductMinStock(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Max Stock</label>
                      <input type="number" value={newProductMaxStock} onChange={(e) => setNewProductMaxStock(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Location</label>
                    <input type="text" value={newProductLocation} onChange={(e) => setNewProductLocation(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Shelf" />
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={newProductIsRepairPart} onChange={(e) => setNewProductIsRepairPart(e.target.checked)} className="w-4 h-4 rounded" /><span className="text-xs font-bold text-slate-600">Repair Part</span></label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={newProductIsHiddenOnPOS} onChange={(e) => setNewProductIsHiddenOnPOS(e.target.checked)} className="w-4 h-4 rounded" /><span className="text-xs font-bold text-slate-600">Hidden on POS</span></label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={newProductSuggestive} onChange={(e) => setNewProductSuggestive(e.target.checked)} className="w-4 h-4 rounded" /><span className="text-xs font-bold text-slate-600">Suggestive Sale</span></label>
                  </div>
                  <div className="flex gap-4 pt-2">
                    <button onClick={() => { setIsAddProductModalOpen(false); resetAddProductForm(); }} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                    <button onClick={handleSaveProduct} disabled={!newProductName.trim()} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 active:scale-95 transition-all disabled:opacity-40">Save Product</button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        )}

        {showCreateTradeIn && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 shrink-0">
                <h2 className="text-xl font-black text-primary tracking-tight">New Trade-In</h2>
              </div>
              <form className="p-8 space-y-4 overflow-y-auto flex-1" onSubmit={(e) => {
                e.preventDefault();
                if (!canManageTradeIns) return;
                const fd = new FormData(e.currentTarget);
                const custId = tradeInIsWalkIn ? 'walk-in' : tradeInSelectedCustomerId;
                const cust = tradeInIsWalkIn ? null : customers.find(c => c.id === custId);
                if (!tradeInIsWalkIn && !custId) return;
                addTradeIn({
                  id: `ti-${Date.now()}`, customerId: custId, customerName: tradeInIsWalkIn ? 'Walk-in Customer' : (cust?.name || 'Unknown'),
                  device: fd.get('device') as string, condition: fd.get('condition') as any, gradeNotes: fd.get('notes') as string || undefined,
                  buybackPrice: parseFloat(fd.get('buyback') as string) || 0,
                  resalePrice: parseFloat(fd.get('resale') as string) || undefined,
                  isWalkIn: tradeInIsWalkIn,
                  idPhotoUrl: capturedIdPhoto || (fd.get('idPhoto') as string) || undefined,
                  status: 'Pending', createdAt: new Date().toISOString().split('T')[0],
                });
                setShowCreateTradeIn(false);
              }}>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={tradeInIsWalkIn} onChange={(e) => setTradeInIsWalkIn(e.target.checked)} className="w-4 h-4 rounded" />
                  <span className="text-xs font-bold text-slate-600">Walk-in Customer (no account)</span>
                </label>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Customer</label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
                    <input type="text" value={tradeInSearch} onChange={(e) => setTradeInSearch(e.target.value)} disabled={tradeInIsWalkIn} placeholder="Search by name or phone..." className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed" />
                  </div>
                  {!tradeInIsWalkIn && tradeInSearch.trim() && (
                    <div className="mt-2 max-h-32 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-sm">
                      {filteredCustomers.length > 0 ? filteredCustomers.slice(0, 5).map(c => (
                        <button type="button" key={c.id} onClick={() => { setTradeInSearch(c.name); setTradeInSelectedCustomerId(c.id); }} className={`w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 ${tradeInSelectedCustomerId === c.id ? 'bg-primary/5' : ''}`}>
                          <p className="text-sm font-bold text-slate-900">{c.name}</p>
                          <p className="text-[10px] text-slate-400">{c.phone} · {c.email}</p>
                        </button>
                      )) : (
                        <p className="px-4 py-3 text-xs text-slate-400">No customers found</p>
                      )}
                    </div>
                  )}
                  {!tradeInIsWalkIn && tradeInSelectedCustomerId && (
                    <input type="hidden" name="customer" value={tradeInSelectedCustomerId} />
                  )}
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Device</label>
                  <input name="device" required className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="e.g. iPhone 12 64GB" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Condition</label>
                    <select name="condition" className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                      <option>Excellent</option><option>Good</option><option>Fair</option><option>Poor</option><option>Broken</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Buyback Price</label>
                    <input name="buyback" type="number" step="0.01" required className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0.00" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Resale Price (Optional)</label>
                  <input name="resale" type="number" step="0.01" className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Estimated resale value" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">ID Photo</label>
                  <input ref={idPhotoCaptureRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onloadend = () => setCapturedIdPhoto(reader.result as string);
                      reader.readAsDataURL(file);
                    }
                  }} />
                  {capturedIdPhoto ? (
                    <div className="relative">
                      <img src={capturedIdPhoto} alt="ID Photo" className="w-full h-40 object-contain rounded-2xl border border-slate-200 bg-slate-50" />
                      <div className="absolute top-2 right-2 flex gap-1">
                        <button type="button" onClick={() => idPhotoCaptureRef.current?.click()} className="p-2 bg-white/90 backdrop-blur rounded-xl text-slate-600 hover:text-primary shadow-sm" title="Replace"><span className="material-symbols-outlined text-sm">edit</span></button>
                        <button type="button" onClick={() => setCapturedIdPhoto('')} className="p-2 bg-white/90 backdrop-blur rounded-xl text-slate-600 hover:text-red-500 shadow-sm" title="Remove"><span className="material-symbols-outlined text-sm">close</span></button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => {
                        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                          navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
                            stream.getTracks().forEach(t => t.stop());
                            const input = document.createElement('input');
                            input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
                            input.onchange = (ev) => { const file = (ev.target as HTMLInputElement).files?.[0]; if (file) { const reader = new FileReader(); reader.onloadend = () => setCapturedIdPhoto(reader.result as string); reader.readAsDataURL(file); } };
                            document.body.appendChild(input); input.click(); document.body.removeChild(input);
                          }).catch(() => { alert('Camera not available on this device. Please use Upload instead.'); });
                        } else { alert('Camera not supported on this device. Please use Upload instead.'); }
                      }} className="flex-1 py-3.5 bg-primary text-white rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-primary/90">
                        <span className="material-symbols-outlined text-sm">photo_camera</span>Camera
                      </button>
                      <button type="button" onClick={() => idPhotoCaptureRef.current?.click()} className="py-3.5 px-4 bg-slate-50 border border-slate-200 rounded-2xl text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1 hover:bg-slate-100 transition-all">
                        <span className="material-symbols-outlined text-sm">upload</span>Upload
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Grade Notes</label>
                  <textarea name="notes" className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold h-20 resize-none" placeholder="Condition details..." />
                </div>
                <div className="flex gap-4 pt-2">
                  <button type="button" onClick={() => setShowCreateTradeIn(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button type="submit" className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Create</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {showCreateTransfer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 shrink-0">
                <h2 className="text-xl font-black text-primary tracking-tight">New Transfer</h2>
              </div>
              <div className="p-8 space-y-4 overflow-y-auto flex-1">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">From</label>
                    <select value={createTransferFrom} onChange={(e) => { setCreateTransferFrom(e.target.value); if (e.target.value === createTransferTo) setCreateTransferTo(storeLocations.find(l => l !== e.target.value) || ''); }} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                      {storeLocations.filter(loc => loc !== createTransferTo).map(loc => <option key={loc} value={loc}>{loc}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">To</label>
                    <select value={createTransferTo} onChange={(e) => { setCreateTransferTo(e.target.value); if (e.target.value === createTransferFrom) setCreateTransferFrom(storeLocations.find(l => l !== e.target.value) || ''); }} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                      {storeLocations.filter(loc => loc !== createTransferFrom).map(loc => <option key={loc} value={loc}>{loc}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Items to Transfer</label>
                    <button type="button" onClick={() => {
                      const available = approvedStockItems.filter(i => i.qty > 0 && !createTransferItems.find(ti => ti.productId === i.id));
                      if (available.length === 0) return;
                      const item = available[0];
                      setCreateTransferItems(prev => [...prev, { productId: item.id, name: item.name, sku: item.sku, quantity: 1, isSerialized: item.type === 'serialized' }]);
                    }} className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Item</button>
                  </div>
                  {createTransferItems.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No items added yet.</p>}
                  {createTransferItems.map((ti, idx) => (
                    <div key={idx} className="flex items-center gap-2 mb-2">
                      <select value={ti.productId} onChange={(e) => { const item = approvedStockItems.find(i => i.id === e.target.value); if (item) setCreateTransferItems(prev => prev.map((p, i2) => i2 === idx ? { ...p, productId: item.id, name: item.name, sku: item.sku, isSerialized: item.type === 'serialized' } : p)); }} className="flex-1 px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 font-bold text-sm">
                        {approvedStockItems.filter(i => i.qty > 0).map(i => <option key={i.id} value={i.id}>{i.name} ({i.qty})</option>)}
                      </select>
                      <input type="number" min="1" value={ti.quantity} onChange={(e) => setCreateTransferItems(prev => prev.map((p, i2) => i2 === idx ? { ...p, quantity: parseInt(e.target.value) || 1 } : p))} className="w-20 px-3 py-3 bg-slate-50 rounded-xl border border-slate-200 font-bold text-center" />
                      <button type="button" onClick={() => setCreateTransferItems(prev => prev.filter((_, i2) => i2 !== idx))} className="p-2 text-slate-400 hover:text-red-500"><span className="material-symbols-outlined text-sm">delete</span></button>
                    </div>
                  ))}
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                  <textarea value={createTransferNotes} onChange={(e) => setCreateTransferNotes(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold h-16 resize-none" />
                </div>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => setShowCreateTransfer(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button disabled={createTransferItems.length === 0 || !createTransferFrom || !createTransferTo} onClick={() => {
                    if (!canManageTransfers) return;
                    addInventoryTransfer({
                      id: `tr-${Date.now()}`, transferNumber: `TRF-${new Date().getFullYear()}-${String(inventoryTransfers.length + 1).padStart(3, '0')}`,
                      fromStore: createTransferFrom, toStore: createTransferTo,
                      items: createTransferItems.map(ti => ({ productId: ti.productId, name: ti.name, sku: ti.sku, quantity: ti.quantity, isSerialized: ti.isSerialized })),
                      status: 'Draft', requestedBy: 'Current User', notes: createTransferNotes || undefined,
                      createdAt: new Date().toISOString().split('T')[0],
                    });
                    setShowCreateTransfer(false);
                  }} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20 disabled:opacity-40">Create</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {showCreateCount && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-xl font-black text-primary tracking-tight">Start New Count</h2>
                <p className="text-xs text-slate-400 mt-1">All approved items will be included. Enter actual quantities after starting.</p>
              </div>
              <div className="p-8 space-y-4">
                <p className="text-sm text-slate-600">{approvedStockItems.length} items will be included in this count.</p>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => setShowCreateCount(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button onClick={() => {
                    if (!canManageStockCounts) return;
                    addInventoryCount({
                      id: `ic-${Date.now()}`, countNumber: `CNT-${new Date().getFullYear()}-${String(inventoryCounts.length + 1).padStart(3, '0')}`,
                      date: new Date().toISOString().split('T')[0], status: 'In Progress',
                      items: approvedStockItems.map(si => ({ productId: si.id, name: si.name, sku: si.sku, expected: si.qty, actual: si.qty, discrepancy: 0 })),
                      performedBy: 'Current User',
                    });
                    setShowCreateCount(false);
                  }} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Start Count</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {transferConfirmAction && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden">
              <div className="p-8 text-center space-y-4">
                <span className="material-symbols-outlined text-4xl text-primary">help</span>
                <p className="text-lg font-black text-primary">{transferConfirmAction.label}</p>
                <p className="text-sm text-slate-500">This action cannot be undone.</p>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => setTransferConfirmAction(null)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button onClick={() => {
                    if (!canManageTransfers) return;
                    if (transferConfirmAction.action === 'send') {
                      const tr = inventoryTransfers.find(t => t.id === transferConfirmAction.id);
                      if (tr) {
                        const aggregated = new Map<string, { totalQty: number; name: string }>();
                        tr.items.forEach(item => {
                          const existing = aggregated.get(item.productId);
                          if (existing) { existing.totalQty += item.quantity; }
                          else { aggregated.set(item.productId, { totalQty: item.quantity, name: item.name }); }
                        });
                        for (const [productId, { totalQty, name }] of aggregated) {
                          const stockItem = approvedStockItems.find(si => si.id === productId);
                          if (stockItem) {
                            const prevQty = stockItem.qty;
                            const newQty = Math.max(0, prevQty - totalQty);
                            updateStockItem(stockItem.id, { qty: newQty });
                            addStockMovement({
                              id: `sm-tout-${Date.now()}-${productId}`, stockItemId: productId, stockItemName: name,
                              type: 'transfer_out', quantityChange: -totalQty, previousQty: prevQty, newQty,
                              referenceId: tr.id, referenceType: 'transfer',
                              performedBy: 'Current User', timestamp: new Date().toISOString(),
                              reason: `Sent via transfer ${tr.transferNumber} to ${tr.toStore}`,
                            });
                          }
                        }
                      }
                      updateInventoryTransfer(transferConfirmAction.id, { status: 'Sent', sentAt: new Date().toISOString() });
                    }
                    else if (transferConfirmAction.action === 'transit') updateInventoryTransfer(transferConfirmAction.id, { status: 'In Transit' });
                    setTransferConfirmAction(null);
                  }} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Confirm</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {transferReceiveModal && (() => {
          const t = inventoryTransfers.find(tr => tr.id === transferReceiveModal);
          if (!t) return null;
          const hasVariance = t.items.some((item, i) => {
            const recv = transferReceiveQtys[i] ?? item.quantity;
            return recv !== item.quantity;
          });
          const hasOverage = t.items.some((item, i) => (transferReceiveQtys[i] ?? item.quantity) > item.quantity);
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50 shrink-0">
                  <h2 className="text-xl font-black text-primary tracking-tight">Receive & Reconcile Transfer</h2>
                  <div className="grid grid-cols-2 gap-4 mt-3 text-xs">
                    <div className="bg-white rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Transfer #</p>
                      <p className="font-bold text-primary">{t.transferNumber}</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Status</p>
                      <p className="font-bold text-slate-900">{t.status}</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase">From</p>
                      <p className="font-bold text-slate-900">{t.fromStore}</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase">To</p>
                      <p className="font-bold text-slate-900">{t.toStore}</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Sent</p>
                      <p className="font-bold text-slate-900">{t.sentAt ? new Date(t.sentAt).toLocaleDateString() : '—'}</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 border border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Requested By</p>
                      <p className="font-bold text-slate-900">{t.requestedBy}</p>
                    </div>
                  </div>
                </div>
                <div className="p-8 space-y-4 overflow-y-auto flex-1">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Line Item Reconciliation</p>
                  <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase">Item</th>
                          <th className="px-3 py-3 text-[10px] font-black text-slate-400 uppercase text-center">Expected</th>
                          <th className="px-3 py-3 text-[10px] font-black text-slate-400 uppercase text-center">Received</th>
                          <th className="px-3 py-3 text-[10px] font-black text-slate-400 uppercase text-center">Variance</th>
                          <th className="px-3 py-3 text-[10px] font-black text-slate-400 uppercase">Condition</th>
                          <th className="px-3 py-3 text-[10px] font-black text-slate-400 uppercase">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.items.map((item, i) => {
                          const recv = transferReceiveQtys[i] ?? item.quantity;
                          const variance = recv - item.quantity;
                          const stockItem = approvedStockItems.find(si => si.id === item.productId);
                          return (
                            <tr key={i} className={`border-b border-slate-50 ${variance !== 0 ? 'bg-red-50/50' : ''}`}>
                              <td className="px-4 py-3">
                                <p className="font-bold text-slate-900">{item.name}</p>
                                <p className="text-[10px] text-slate-400">{item.sku || ''}{item.isSerialized ? ' · Serialized' : ''}{item.supplierName ? ` · ${item.supplierName}` : ''}</p>
                              </td>
                              <td className="px-3 py-3 text-center font-bold text-slate-700">{item.quantity}</td>
                              <td className="px-3 py-3 text-center">
                                <input type="number" min="0" value={recv} onChange={(e) => setTransferReceiveQtys(prev => ({ ...prev, [i]: parseInt(e.target.value) || 0 }))} className="w-16 px-2 py-1 bg-white border border-slate-200 rounded-lg text-center font-bold" />
                              </td>
                              <td className="px-3 py-3 text-center">
                                <span className={`font-black ${variance === 0 ? 'text-slate-400' : variance > 0 ? 'text-amber-600' : 'text-red-600'}`}>{variance > 0 ? '+' : ''}{variance}</span>
                              </td>
                              <td className="px-3 py-3">
                                <select value={transferReceiveConditions[i] || 'Good'} onChange={(e) => setTransferReceiveConditions(prev => ({ ...prev, [i]: e.target.value }))} className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold w-24">
                                  <option>Good</option><option>Damaged</option><option>Missing</option>
                                </select>
                              </td>
                              <td className="px-3 py-3">
                                <input type="text" value={transferReceiveNotes[i] || ''} onChange={(e) => setTransferReceiveNotes(prev => ({ ...prev, [i]: e.target.value }))} placeholder="Note..." className="w-full px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold" />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {hasVariance && (
                    <div className={`rounded-xl p-3 border ${hasOverage ? 'bg-amber-50 border-amber-200' : 'bg-orange-50 border-orange-200'}`}>
                      <p className="text-xs font-bold text-orange-700">
                        {hasOverage ? 'Overage detected — extra received quantities require confirmation.' : 'Shortage detected — received quantity differs from expected.'}
                      </p>
                    </div>
                  )}
                  <div className="flex gap-4 pt-2">
                    <button onClick={() => setTransferReceiveModal(null)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                    <button onClick={() => {
                      if (!canManageTransfers) return;
                      let anyVariance = false;
                      const recvAgg = new Map<string, { totalRecv: number; name: string }>();
                      const reconciledItems = t.items.map((item, i) => {
                        const receivedQty = transferReceiveQtys[i] ?? item.quantity;
                        const variance = receivedQty - item.quantity;
                        if (variance !== 0) anyVariance = true;
                        if (receivedQty > 0) {
                          const existing = recvAgg.get(item.productId);
                          if (existing) { existing.totalRecv += receivedQty; }
                          else { recvAgg.set(item.productId, { totalRecv: receivedQty, name: item.name }); }
                        }
                        return {
                          ...item,
                          receivedQty,
                          variance,
                          condition: (transferReceiveConditions[i] || 'Good') as TransferLineItem['condition'],
                          discrepancyNote: transferReceiveNotes[i] || undefined,
                        };
                      });
                      for (const [productId, { totalRecv, name }] of recvAgg) {
                        const stockItem = approvedStockItems.find(si => si.id === productId);
                        const prevQty = stockItem?.qty || 0;
                        const newQty = prevQty + totalRecv;
                        if (stockItem) { updateStockItem(stockItem.id, { qty: newQty }); }
                        addStockMovement({
                          id: `sm-${Date.now()}-${productId}`, stockItemId: productId, stockItemName: name,
                          type: 'transfer_in', quantityChange: totalRecv, previousQty: prevQty, newQty,
                          referenceId: t.id, referenceType: 'transfer',
                          performedBy: 'Current User', timestamp: new Date().toISOString(),
                          reason: `Received from transfer ${t.transferNumber}`,
                        });
                      }
                      const allFullyReceived = reconciledItems.every(i => (i.receivedQty ?? 0) >= i.quantity);
                      let newStatus: typeof t.status;
                      if (!anyVariance) {
                        newStatus = 'Received';
                      } else if (allFullyReceived) {
                        newStatus = 'Discrepancy Detected';
                      } else {
                        newStatus = 'Partially Received';
                      }
                      updateInventoryTransfer(t.id, { status: newStatus, receivedAt: new Date().toISOString(), items: reconciledItems, reconciledBy: 'Current User' });
                      setTransferReceiveModal(null);
                      setTransferReceiveQtys({});
                    }} className="flex-1 py-4 bg-emerald-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-emerald-500/20">Finalize Reconciliation</button>
                  </div>
                </div>
              </motion.div>
            </div>
          );
        })()}

        {selectedTransfer && (() => {
          const t = inventoryTransfers.find(tr => tr.id === selectedTransfer);
          if (!t) return null;
          const isEditable = canManageTransfers && (t.status === 'Draft' || t.status === 'Sent' || t.status === 'In Transit' || t.status === 'Partially Received' || t.status === 'Discrepancy Detected');
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                  <div>
                    <h3 className="text-2xl font-black text-primary tracking-tight">{t.transferNumber}</h3>
                    <p className="text-sm text-slate-500">{t.fromStore} → {t.toStore}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(t.status)}`}>{t.status}</span>
                      {t.items.some(i => i.receivedQty !== undefined && i.receivedQty !== i.quantity) && (
                        <span className="px-2 py-0.5 bg-red-100 text-red-700 text-[9px] font-black rounded uppercase">Discrepancy</span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => setSelectedTransfer(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
                </div>
                <div className="p-8 overflow-y-auto flex-1 space-y-4">
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Created</p><p className="font-bold">{t.createdAt}</p></div>
                    {t.sentAt && <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Sent</p><p className="font-bold">{new Date(t.sentAt).toLocaleDateString()}</p></div>}
                    {t.receivedAt && <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Received</p><p className="font-bold">{new Date(t.receivedAt).toLocaleDateString()}</p></div>}
                    <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Requested By</p><p className="font-bold">{t.requestedBy}</p></div>
                    {t.reconciledBy && <div className="bg-slate-50 rounded-xl p-3"><p className="text-[10px] font-black text-slate-400 uppercase">Reconciled By</p><p className="font-bold">{t.reconciledBy}</p></div>}
                  </div>
                  {t.notes && <p className="text-xs text-slate-400 italic">{t.notes}</p>}
                  {canAccess('shipping') && checkSubPermission('create_shipment') && t.status !== 'Received' && t.status !== 'Cancelled' && (() => {
                    const linkedShipments = shipments.filter(s => s.sourceType === 'transfer' && s.sourceNumber === t.transferNumber);
                    const itemsSummary = t.items.map(i => `${i.name} x${i.quantity}`).join(', ');
                    return (
                      <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                        <p className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-1"><span className="material-symbols-outlined text-xs">package_2</span> Shipping</p>
                        {linkedShipments.length > 0 ? (
                          linkedShipments.map(sh => (
                            <div key={sh.id} className="flex justify-between items-center bg-white p-2.5 rounded-lg border border-slate-100">
                              <div>
                                <p className="text-xs font-bold text-primary">{sh.shipmentNumber}</p>
                                <p className="text-[10px] text-slate-400">{sh.carrier || 'No carrier'}</p>
                              </div>
                              <span className="text-[9px] font-black uppercase text-sky-700 bg-sky-50 px-2 py-0.5 rounded-lg border border-sky-200">{sh.status}</span>
                            </div>
                          ))
                        ) : (
                          <button onClick={() => {
                            const prefill: ShipmentPrefill = {
                              sourceType: 'transfer',
                              sourceId: t.id,
                              sourceNumber: t.transferNumber,
                              type: 'store_transfer',
                              originAddress: { name: t.fromStore, line1: '123 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
                              destinationAddress: { name: t.toStore, line1: '', city: '', state: '', postalCode: '', country: 'US' },
                              notes: `Transfer ${t.transferNumber}: ${t.fromStore} → ${t.toStore}`,
                              sourceItems: t.items.map(i => ({ id: `trf-item-${i.name}`, name: i.name, quantity: i.quantity })),
                            };
                            navigate('/shipping', { state: { openCreate: true, prefill } });
                          }}
                            className="w-full py-2 bg-white text-primary border border-slate-200 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all flex items-center justify-center gap-1.5">
                            <span className="material-symbols-outlined text-sm">add</span> Create Shipment
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Items</p>
                    <div className="space-y-2">
                      {t.items.map((item, i) => {
                        const hasVar = item.receivedQty !== undefined && item.receivedQty !== item.quantity;
                        return (
                          <div key={i} className={`flex items-center justify-between p-4 rounded-xl ${hasVar ? 'bg-red-50 border border-red-100' : 'bg-slate-50'}`}>
                            <div>
                              <p className="font-bold text-sm text-slate-900">{item.name}</p>
                              {item.sku && <p className="text-[10px] text-slate-400 font-mono">{item.sku}</p>}
                              {item.discrepancyNote && <p className="text-[10px] text-red-500 mt-0.5">{item.discrepancyNote}</p>}
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-bold text-slate-700">Shipped: {item.quantity}</p>
                              {item.receivedQty !== undefined && (
                                <p className={`text-xs font-black ${hasVar ? 'text-red-600' : 'text-emerald-600'}`}>Received: {item.receivedQty} {hasVar && `(${(item.variance || 0) > 0 ? '+' : ''}${item.variance})`}</p>
                              )}
                              {item.condition && item.condition !== 'Good' && (
                                <p className="text-[10px] font-black text-amber-600 uppercase">{item.condition}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {isEditable && (
                    <div className="flex gap-2 pt-2">
                      <button onClick={() => {
                        setEditingTransfer(t.id);
                        setEditTransferFrom(t.fromStore);
                        setEditTransferTo(t.toStore);
                        setEditTransferNotes(t.notes || '');
                        setEditTransferItems(t.items.map(item => ({ productId: item.productId || '', name: item.name, sku: item.sku || '', quantity: item.quantity, isSerialized: item.isSerialized ?? false })));
                      }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-slate-200 flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined text-sm">edit</span>
                        Edit Transfer
                      </button>
                    </div>
                  )}
                  {canManageTransfers && (t.status === 'Discrepancy Detected' || t.status === 'Partially Received') && (
                    <div className="flex gap-2 pt-2">
                      <button onClick={() => {
                        setSelectedTransfer(null);
                        setTransferReceiveModal(t.id);
                        const qtys: Record<number, number> = {};
                        const conds: Record<number, string> = {};
                        const notes: Record<number, string> = {};
                        t.items.forEach((item, idx) => {
                          qtys[idx] = item.receivedQty ?? item.quantity;
                          conds[idx] = item.condition || 'Good';
                          notes[idx] = item.discrepancyNote || '';
                        });
                        setTransferReceiveQtys(qtys);
                        setTransferReceiveConditions(conds);
                        setTransferReceiveNotes(notes);
                      }} className="flex-1 py-3 bg-amber-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-amber-600 active:scale-95 transition-all">Re-Reconcile</button>
                      <button onClick={() => {
                        updateInventoryTransfer(t.id, { status: 'Received', reconciledBy: 'Current User' });
                        setSelectedTransfer(null);
                      }} className="flex-1 py-3 bg-emerald-500 text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-emerald-600 active:scale-95 transition-all">Accept & Close</button>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          );
        })()}

        {editingTransfer && (() => {
          const t = inventoryTransfers.find(tr => tr.id === editingTransfer);
          if (!t) return null;
          const showCaution = t.status !== 'Draft';
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                  <div>
                    <h3 className="text-2xl font-black text-primary tracking-tight">Edit {t.transferNumber}</h3>
                    <p className="text-sm text-slate-500">{showCaution ? `Status: ${t.status} — changes may affect logistics` : 'All fields editable'}</p>
                  </div>
                  <button onClick={() => setEditingTransfer(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
                </div>
                <div className="p-8 space-y-5 overflow-y-auto flex-1">
                  {showCaution && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                      <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">warning</span>
                      <p className="text-xs text-amber-700 font-bold">This transfer is already <span className="font-black">{t.status}</span>. Changing locations or items may require re-coordination with the receiving store.</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">From</label>
                      <select value={editTransferFrom} onChange={(e) => { setEditTransferFrom(e.target.value); if (e.target.value === editTransferTo) setEditTransferTo(storeLocations.find(l => l !== e.target.value) || ''); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm">
                        {storeLocations.filter(loc => loc !== editTransferTo).map(loc => <option key={loc} value={loc}>{loc}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">To</label>
                      <select value={editTransferTo} onChange={(e) => { setEditTransferTo(e.target.value); if (e.target.value === editTransferFrom) setEditTransferFrom(storeLocations.find(l => l !== e.target.value) || ''); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm">
                        {storeLocations.filter(loc => loc !== editTransferFrom).map(loc => <option key={loc} value={loc}>{loc}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                    <textarea value={editTransferNotes} onChange={(e) => setEditTransferNotes(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm h-20 resize-none" placeholder="Transfer notes..." />
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</label>
                      <button type="button" onClick={() => {
                        const available = approvedStockItems.filter(i => i.qty > 0 && !editTransferItems.find(ti => ti.productId === i.id));
                        if (available.length === 0) return;
                        const item = available[0];
                        setEditTransferItems(prev => [...prev, { productId: item.id, name: item.name, sku: item.sku, quantity: 1, isSerialized: item.type === 'serialized' }]);
                      }} className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline">+ Add Item</button>
                    </div>
                    <div className="space-y-2">
                      {editTransferItems.map((item, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <select value={item.productId} onChange={(e) => { const si = approvedStockItems.find(s => s.id === e.target.value); if (si) { const updated = [...editTransferItems]; updated[i] = { ...updated[i], productId: si.id, name: si.name, sku: si.sku, isSerialized: si.type === 'serialized' }; setEditTransferItems(updated); } }} className="flex-1 px-4 py-3 bg-slate-50 rounded-xl border border-slate-200 font-bold text-sm">
                            {approvedStockItems.filter(s => s.qty > 0 || s.id === item.productId).map(s => <option key={s.id} value={s.id}>{s.name} ({s.qty})</option>)}
                          </select>
                          <input type="number" min="1" value={item.quantity} onChange={(e) => {
                            const updated = [...editTransferItems];
                            updated[i] = { ...updated[i], quantity: Math.max(1, parseInt(e.target.value) || 1) };
                            setEditTransferItems(updated);
                          }} className="w-16 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-center font-bold text-sm" />
                          <button onClick={() => setEditTransferItems(editTransferItems.filter((_, idx) => idx !== i))} className="p-1.5 hover:bg-red-50 text-slate-400 hover:text-red-500 rounded-lg"><span className="material-symbols-outlined text-sm">close</span></button>
                        </div>
                      ))}
                      {editTransferItems.length === 0 && <p className="text-xs text-slate-400 text-center py-3">No items — use + Add Item above</p>}
                    </div>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button onClick={() => setEditingTransfer(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                    <button onClick={() => {
                      updateInventoryTransfer(t.id, {
                        notes: editTransferNotes || undefined,
                        fromStore: editTransferFrom,
                        toStore: editTransferTo,
                        items: editTransferItems.map(item => ({ productId: item.productId, name: item.name, sku: item.sku, quantity: item.quantity, isSerialized: item.isSerialized })),
                      });
                      setEditingTransfer(null);
                    }} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20">Save Changes</button>
                  </div>
                </div>
              </motion.div>
            </div>
          );
        })()}

        {selectedCount && (() => {
          const c = inventoryCounts.find(ct => ct.id === selectedCount);
          if (!c) return null;
          const discItems = c.items.filter(i => i.discrepancy !== 0);
          const showOnlyDisc = (c.status === 'Completed' || c.status === 'Closed') && !countReAdjustMode;
          const displayItems = showOnlyDisc ? discItems : c.items;
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                  <div>
                    <h3 className="text-2xl font-black text-primary tracking-tight">{c.countNumber}</h3>
                    <p className="text-sm text-slate-500">{c.date} · {c.performedBy}</p>
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border mt-2 inline-block ${getStatusColor(c.status)}`}>{c.status}</span>
                    {discItems.length > 0 && <span className="ml-2 px-2 py-0.5 bg-red-100 text-red-700 text-[9px] font-black rounded uppercase">{discItems.length} discrepanc{discItems.length !== 1 ? 'ies' : 'y'}</span>}
                  </div>
                  <button onClick={() => { setSelectedCount(null); setCountConfirmComplete(false); setCountReAdjustMode(false); setCountActuals({}); }} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
                </div>
                <div className="p-8 space-y-4 overflow-y-auto flex-1">
                  {showOnlyDisc && c.adjustedAt && (
                    <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-100 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-emerald-600 text-sm">check_circle</span>
                        <p className="text-xs font-black text-emerald-700 uppercase tracking-widest">Adjustment Summary</p>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-xs">
                        <div className="bg-white rounded-lg p-2 text-center"><p className="text-[10px] text-slate-400 font-bold">Total Items</p><p className="font-black text-slate-900">{c.items.length}</p></div>
                        <div className="bg-white rounded-lg p-2 text-center"><p className="text-[10px] text-slate-400 font-bold">Adjusted</p><p className="font-black text-amber-600">{discItems.length}</p></div>
                        <div className="bg-white rounded-lg p-2 text-center"><p className="text-[10px] text-slate-400 font-bold">Net Change</p><p className={`font-black ${discItems.reduce((s, i) => s + i.discrepancy, 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{discItems.reduce((s, i) => s + i.discrepancy, 0) > 0 ? '+' : ''}{discItems.reduce((s, i) => s + i.discrepancy, 0)}</p></div>
                      </div>
                      <p className="text-[10px] text-slate-400">Adjusted by {c.adjustedBy} on {new Date(c.adjustedAt).toLocaleDateString()}</p>
                    </div>
                  )}
                  {showOnlyDisc && discItems.length === 0 && <p className="text-sm text-slate-500 text-center py-4">No discrepancies found in this count.</p>}
                  {showOnlyDisc && <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Discrepancies Only</p>}
                  {!showOnlyDisc && <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">All Items ({c.items.length})</p>}
                  <div className="space-y-2">
                    {displayItems.map((item) => (
                      <div key={item.productId} className={`flex items-center justify-between p-4 rounded-xl ${item.discrepancy !== 0 ? 'bg-red-50 border border-red-100' : 'bg-slate-50'}`}>
                        <div>
                          <p className="font-bold text-sm text-slate-900">{item.name}</p>
                          <p className="text-[10px] text-slate-400 font-mono">{item.sku}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className="text-[10px] font-black text-slate-400 uppercase">Expected</p>
                            <p className="text-sm font-bold">{item.expected}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] font-black text-slate-400 uppercase">Actual</p>
                            {((c.status === 'In Progress') || (c.status === 'Completed' && countReAdjustMode)) && canManageStockCounts ? (
                              <input type="number" min="0" value={countActuals[item.productId] ?? item.actual} onChange={(e) => {
                                const val = parseInt(e.target.value) || 0;
                                setCountActuals(prev => ({ ...prev, [item.productId]: val }));
                                if (c.status === 'In Progress') {
                                  const disc = val - item.expected;
                                  updateInventoryCount(c.id, { items: c.items.map(i => i.productId === item.productId ? { ...i, actual: val, discrepancy: disc } : i) });
                                }
                              }} className="w-16 px-2 py-1 bg-white border border-slate-200 rounded-lg text-center font-bold text-sm" />
                            ) : (
                              <p className="text-sm font-bold">{item.actual}</p>
                            )}
                          </div>
                          {item.discrepancy !== 0 && (
                            <div className="text-right">
                              <p className="text-[10px] font-black text-red-400 uppercase">Diff</p>
                              <p className={`text-sm font-black ${item.discrepancy > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{item.discrepancy > 0 ? '+' : ''}{item.discrepancy}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {c.status === 'In Progress' && canManageStockCounts && !countConfirmComplete && (
                    <div className="flex gap-4 pt-2">
                      <button onClick={() => setCountConfirmComplete(true)} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Review & Complete</button>
                    </div>
                  )}
                  {countConfirmComplete && (
                    <div className="bg-amber-50 rounded-2xl border border-amber-200 p-6 space-y-4">
                      <p className="text-sm font-bold text-amber-800">Confirm Count Completion</p>
                      {discItems.length > 0 ? (
                        <>
                          <p className="text-xs text-amber-700">{discItems.length} item{discItems.length !== 1 ? 's' : ''} will be adjusted to match actual counts:</p>
                          <div className="space-y-1">
                            {discItems.map(item => (
                              <div key={item.productId} className="flex justify-between text-xs bg-white rounded-lg p-2">
                                <span className="font-bold text-slate-900">{item.name}</span>
                                <span className={`font-black ${item.discrepancy > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{item.expected} → {item.actual} ({item.discrepancy > 0 ? '+' : ''}{item.discrepancy})</span>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-amber-700">No discrepancies found. All items match expected quantities.</p>
                      )}
                      <div className="flex gap-4">
                        <button onClick={() => setCountConfirmComplete(false)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-xs uppercase tracking-widest border border-slate-200">Back</button>
                        <button onClick={() => {
                          if (!canManageStockCounts) return;
                          c.items.forEach(item => {
                            if (item.discrepancy !== 0) {
                              const stockItem = approvedStockItems.find(si => si.id === item.productId);
                              if (stockItem) {
                                updateStockItem(stockItem.id, { qty: item.actual });
                                addStockMovement({
                                  id: `sm-cnt-${Date.now()}-${item.productId}`, stockItemId: item.productId, stockItemName: item.name,
                                  type: 'count_adjustment', quantityChange: item.discrepancy,
                                  previousQty: item.expected, newQty: item.actual,
                                  referenceId: c.id, referenceType: 'count',
                                  performedBy: 'Current User', timestamp: new Date().toISOString(),
                                  reason: `Stock count ${c.countNumber} adjustment`,
                                });
                              }
                            }
                          });
                          updateInventoryCount(c.id, { status: 'Completed', completedAt: new Date().toISOString(), adjustedAt: new Date().toISOString(), adjustedBy: 'Current User' });
                          setCountConfirmComplete(false);
                          setCountReAdjustMode(false);
                          setCountActuals({});
                          setSelectedCount(null);
                        }} className="flex-1 py-3 bg-emerald-500 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-xl shadow-emerald-500/20">Confirm & Apply</button>
                      </div>
                    </div>
                  )}
                  {c.status === 'Completed' && countReAdjustMode && canManageStockCounts && (
                    <div className="bg-amber-50 rounded-2xl border border-amber-200 p-5 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-amber-500 text-sm">edit_note</span>
                        <p className="text-xs font-black text-amber-700 uppercase tracking-widest">Re-Adjust Mode</p>
                      </div>
                      <p className="text-xs text-amber-600">Edit the actual quantities above to correct any mistakes. Stock will be updated when you save.</p>
                      <div className="flex gap-3">
                        <button onClick={() => { setCountReAdjustMode(false); setCountActuals({}); }} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                        <button onClick={() => {
                          c.items.forEach(item => {
                            const newActual = countActuals[item.productId] ?? item.actual;
                            if (newActual !== item.actual) {
                              const delta = newActual - item.actual;
                              const stockItem = approvedStockItems.find(si => si.id === item.productId);
                              if (stockItem) {
                                updateStockItem(stockItem.id, { qty: stockItem.qty + delta });
                                addStockMovement({
                                  id: `sm-readj-${Date.now()}-${item.productId}`, stockItemId: item.productId, stockItemName: item.name,
                                  type: 'count_adjustment', quantityChange: delta,
                                  previousQty: stockItem.qty, newQty: stockItem.qty + delta,
                                  referenceId: c.id, referenceType: 'count',
                                  performedBy: 'Current User', timestamp: new Date().toISOString(),
                                  reason: `Stock count ${c.countNumber} re-adjustment`,
                                });
                              }
                            }
                          });
                          updateInventoryCount(c.id, {
                            items: c.items.map(item => {
                              const newActual = countActuals[item.productId] ?? item.actual;
                              return { ...item, actual: newActual, discrepancy: newActual - item.expected };
                            }),
                            adjustedAt: new Date().toISOString(), adjustedBy: 'Current User',
                          });
                          setCountReAdjustMode(false);
                          setCountActuals({});
                        }} className="flex-1 py-3 bg-emerald-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/20">Save Re-Adjustments</button>
                      </div>
                    </div>
                  )}
                  {c.status === 'Completed' && !countReAdjustMode && canManageStockCounts && (
                    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-5 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-slate-500 text-sm">task_alt</span>
                        <p className="text-xs font-black text-slate-600 uppercase tracking-widest">Close Out Count</p>
                      </div>
                      <p className="text-xs text-slate-500">
                        {discItems.length > 0
                          ? `${discItems.length} discrepanc${discItems.length !== 1 ? 'ies were' : 'y was'} adjusted. Acknowledge and close this count to finalize.`
                          : 'No discrepancies found. Close this count to finalize.'}
                      </p>
                      <div className="flex gap-3">
                        <button onClick={() => { setCountReAdjustMode(true); setCountActuals({}); }} className="flex-1 py-3 bg-amber-100 text-amber-700 rounded-xl font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-amber-200 transition-all">
                          <span className="material-symbols-outlined text-sm">edit_note</span>
                          Re-Adjust
                        </button>
                        <button onClick={() => {
                          updateInventoryCount(c.id, { status: 'Closed' as 'Closed' });
                          setSelectedCount(null);
                          setCountReAdjustMode(false);
                          setCountActuals({});
                        }} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 flex items-center justify-center gap-2">
                          <span className="material-symbols-outlined text-sm">lock</span>
                          Close Count
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          );
        })()}

        {selectedRefurbJob && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center shrink-0">
                <div>
                  <h2 className="text-xl font-black text-primary tracking-tight">{selectedRefurbJob.itemName}</h2>
                  <p className="text-xs font-bold text-slate-400">Refurbishment Job · {selectedRefurbJob.status}</p>
                </div>
                <button onClick={() => { setSelectedRefurbJob(null); setRefurbConfirmComplete(false); }} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="p-8 space-y-4 overflow-y-auto flex-1">
                {!refurbConfirmComplete ? (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-slate-50 rounded-xl p-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase">Technician</p>
                        <p className="text-sm font-bold text-slate-900 mt-1">{selectedRefurbJob.technicianName}</p>
                      </div>
                      <div className="bg-slate-50 rounded-xl p-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase">Total Cost</p>
                        <p className="text-sm font-bold text-primary mt-1">${selectedRefurbJob.totalCost.toFixed(2)}</p>
                      </div>
                    </div>
                    {selectedRefurbJob.notes && (
                      <div className="bg-slate-50 rounded-xl p-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase">Notes</p>
                        <p className="text-sm text-slate-600 mt-1">{selectedRefurbJob.notes}</p>
                      </div>
                    )}
                    {selectedRefurbJob.partsUsed.length > 0 && (
                      <div>
                        <p className="text-[10px] font-black text-slate-400 uppercase mb-2">Parts Used</p>
                        {selectedRefurbJob.partsUsed.map((p, i) => (
                          <div key={i} className="flex justify-between p-3 bg-slate-50 rounded-xl mb-1">
                            <span className="text-sm font-bold text-slate-900">{p.name}</span>
                            <span className="text-sm font-bold text-primary">${p.cost.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {selectedRefurbJob.estimatedCompletion && (
                      <div className="bg-slate-50 rounded-xl p-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase">Est. Completion</p>
                        <p className="text-sm font-bold text-slate-900 mt-1">{selectedRefurbJob.estimatedCompletion}</p>
                      </div>
                    )}
                    {canManageRefurbishment && selectedRefurbJob.status !== 'Completed' && (
                      <div className="flex gap-2 pt-2">
                        <button onClick={() => setRefurbConfirmComplete(true)} className="flex-1 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">Complete Job</button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-sm font-bold text-slate-700">Confirm completion and set resale price for the refurbished item.</p>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Resale Price</label>
                      <input type="number" step="0.01" value={refurbNewResale} onChange={(e) => setRefurbNewResale(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0.00" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Completion Note</label>
                      <textarea value={refurbCompletionNote} onChange={(e) => setRefurbCompletionNote(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold h-20 resize-none" placeholder="Final notes on refurbishment..." />
                    </div>
                    <div className="flex gap-4 pt-2">
                      <button onClick={() => setRefurbConfirmComplete(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Back</button>
                      <button onClick={() => {
                        if (!canManageRefurbishment) return;
                        const tradeIn = tradeIns.find(t => t.id === selectedRefurbJob.itemId);
                        const resale = parseFloat(refurbNewResale) || (tradeIn?.resalePrice || ((tradeIn?.buybackPrice || 0) + selectedRefurbJob.totalCost) * 1.5);
                        const newItem: StockItem = {
                          id: `stk-rfb-${Date.now()}`, name: `${selectedRefurbJob.itemName} (Refurbished)`,
                          sku: `RFB-${Date.now().toString().slice(-6)}`, qty: 1,
                          cost: (tradeIn?.buybackPrice || 0) + selectedRefurbJob.totalCost,
                          price: resale,
                          category: 'Devices', type: 'serialized', isRepairPart: false, isHiddenOnPOS: false,
                          addedAt: new Date().toISOString(), status: 'approved',
                        };
                        addStockItem(newItem);
                        addStockMovement({
                          id: `sm-${Date.now()}`, stockItemId: newItem.id, stockItemName: newItem.name,
                          type: 'refurbishment_complete', quantityChange: 1, previousQty: 0, newQty: 1,
                          referenceId: selectedRefurbJob.id, referenceType: 'refurbishment',
                          performedBy: 'Current User', timestamp: new Date().toISOString(),
                          reason: `Refurbishment of ${selectedRefurbJob.itemName} completed${refurbCompletionNote ? ': ' + refurbCompletionNote : ''}`,
                        });
                        updateRefurbishmentJob(selectedRefurbJob.id, { status: 'Completed', completedAt: new Date().toISOString(), resultingProductId: newItem.id, refurbNotes: refurbCompletionNote || undefined });
                        if (tradeIn) updateTradeIn(tradeIn.id, { status: 'In Inventory', movedToInventoryId: newItem.id, resalePrice: resale });
                        setSelectedRefurbJob(null);
                        setRefurbConfirmComplete(false);
                      }} className="flex-1 py-4 bg-emerald-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-emerald-500/20">Confirm & Complete</button>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {tradeInConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden">
              <div className="p-8 text-center space-y-4">
                <span className="material-symbols-outlined text-4xl text-primary">help</span>
                <p className="text-lg font-black text-primary">{tradeInConfirm.label}</p>
                {tradeInConfirm.notes && (
                  <div className="text-left">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Refurbishment Notes</label>
                    <textarea value={tradeInConfirmNotes} onChange={(e) => setTradeInConfirmNotes(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm h-20 resize-none" placeholder="What needs refurbishment..." />
                  </div>
                )}
                <div className="flex gap-4 pt-2">
                  <button onClick={() => { setTradeInConfirm(null); setTradeInConfirmNotes(''); }} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button onClick={() => {
                    if (!canManageTradeIns) return;
                    const item = tradeIns.find(t => t.id === tradeInConfirm.id);
                    if (!item) return;
                    if (tradeInConfirm.action === 'evaluate') {
                      updateTradeIn(item.id, { status: 'Evaluated' });
                    } else if (tradeInConfirm.action === 'refurb') {
                      addRefurbishmentJob({
                        id: `rfb-${Date.now()}`, itemId: item.id, itemName: item.device,
                        technicianId: '', technicianName: 'Unassigned', status: 'Pending',
                        notes: tradeInConfirmNotes || item.gradeNotes || '', partsUsed: [], totalCost: 0,
                        createdAt: new Date().toISOString(),
                      });
                      updateTradeIn(item.id, { status: 'Refurbishing' });
                    }
                    setTradeInConfirm(null);
                    setTradeInConfirmNotes('');
                  }} className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Confirm</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {deleteTradeInConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm overflow-hidden">
              <div className="p-8 text-center space-y-4">
                <span className="material-symbols-outlined text-4xl text-red-500">delete</span>
                <p className="text-lg font-black text-primary">Delete this trade-in?</p>
                <p className="text-sm text-slate-500">This action cannot be undone.</p>
                <div className="flex gap-4 pt-2">
                  <button onClick={() => setDeleteTradeInConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button onClick={() => { if (canManageTradeIns) { deleteTradeIn(deleteTradeInConfirm); } setDeleteTradeInConfirm(null); }} className="flex-1 py-4 bg-red-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-red-500/20">Delete</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {viewingTradeIn && (() => {
          const item = tradeIns.find(t => t.id === viewingTradeIn);
          if (!item) return null;
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                  <div>
                    <h3 className="text-xl font-black text-primary tracking-tight">{item.device}</h3>
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border mt-2 inline-block ${getStatusColor(item.status)}`}>{item.status}</span>
                  </div>
                  <button onClick={() => setViewingTradeIn(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
                </div>
                <div className="p-8 space-y-4 overflow-y-auto flex-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Customer</p>
                      <p className="text-sm font-bold text-slate-900 mt-1">{item.isWalkIn ? 'Walk-in Customer' : item.customerName}</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Condition</p>
                      <p className="text-sm font-bold text-slate-900 mt-1">{item.condition}</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Buyback Price</p>
                      <p className="text-sm font-black text-primary mt-1">${item.buybackPrice.toFixed(2)}</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Resale Price</p>
                      <p className="text-sm font-black text-emerald-600 mt-1">{item.resalePrice ? `$${item.resalePrice.toFixed(2)}` : '—'}</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase">Created</p>
                      <p className="text-sm font-bold text-slate-900 mt-1">{item.createdAt}</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase">IMEI / Serial</p>
                      <p className="text-sm font-bold text-slate-900 mt-1">{item.imei || item.serialNumber || '—'}</p>
                    </div>
                  </div>
                  {item.gradeNotes && (
                    <div className="bg-slate-50 rounded-xl p-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Grade Notes</p>
                      <p className="text-sm text-slate-600">{item.gradeNotes}</p>
                    </div>
                  )}
                  {item.idPhotoUrl && (
                    <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase mb-2">ID Photo</p>
                      <img src={item.idPhotoUrl} alt="ID Photo" className="w-full h-48 object-contain rounded-2xl border border-slate-200 bg-slate-50" />
                    </div>
                  )}
                  <div className="flex gap-3 pt-2">
                    {canManageTradeIns && (item.status === 'Pending' || item.status === 'Evaluated') && (
                      <button onClick={() => { setViewingTradeIn(null); setEditingTradeIn(item.id); setEditTradeInPhoto(item.idPhotoUrl || ''); }} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined text-sm">edit</span>Edit
                      </button>
                    )}
                    <button onClick={() => setViewingTradeIn(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest">Close</button>
                  </div>
                </div>
              </motion.div>
            </div>
          );
        })()}

        {editingTradeIn && (() => {
          const item = tradeIns.find(t => t.id === editingTradeIn);
          if (!item) return null;
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col">
                <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                  <div>
                    <h3 className="text-xl font-black text-primary tracking-tight">Edit Trade-In</h3>
                    <p className="text-sm text-slate-500">{item.device}</p>
                  </div>
                  <button onClick={() => setEditingTradeIn(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
                </div>
                <form className="p-8 space-y-5 overflow-y-auto flex-1" onSubmit={(e) => {
                  e.preventDefault();
                  if (!canManageTradeIns) return;
                  const fd = new FormData(e.currentTarget);
                  updateTradeIn(item.id, {
                    device: fd.get('device') as string || item.device,
                    condition: fd.get('condition') as any || item.condition,
                    buybackPrice: parseFloat(fd.get('buyback') as string) || item.buybackPrice,
                    resalePrice: parseFloat(fd.get('resale') as string) || item.resalePrice,
                    gradeNotes: fd.get('notes') as string || undefined,
                    idPhotoUrl: editTradeInPhoto || undefined,
                  });
                  setEditingTradeIn(null);
                }}>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Device</label>
                    <input name="device" defaultValue={item.device} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm" placeholder="Device" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Condition</label>
                    <select name="condition" defaultValue={item.condition} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm">
                      <option>Excellent</option><option>Good</option><option>Fair</option><option>Poor</option><option>Broken</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Buyback Price</label>
                      <input name="buyback" type="number" step="0.01" defaultValue={item.buybackPrice} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Resale Price</label>
                      <input name="resale" type="number" step="0.01" defaultValue={item.resalePrice || ''} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Grade Notes</label>
                    <textarea name="notes" defaultValue={item.gradeNotes || ''} placeholder="Condition details..." className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-sm h-20 resize-none" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">ID Photo</label>
                    <input ref={editIdPhotoRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => setEditTradeInPhoto(reader.result as string);
                        reader.readAsDataURL(file);
                      }
                    }} />
                    {editTradeInPhoto ? (
                      <div className="relative">
                        <img src={editTradeInPhoto} alt="ID Photo" className="w-full h-40 object-contain rounded-2xl border border-slate-200 bg-slate-50" />
                        <div className="absolute top-2 right-2 flex gap-1">
                          <button type="button" onClick={() => editIdPhotoRef.current?.click()} className="p-2 bg-white/90 backdrop-blur rounded-xl text-slate-600 hover:text-primary shadow-sm" title="Replace"><span className="material-symbols-outlined text-sm">edit</span></button>
                          <button type="button" onClick={() => setEditTradeInPhoto('')} className="p-2 bg-white/90 backdrop-blur rounded-xl text-slate-600 hover:text-red-500 shadow-sm" title="Remove"><span className="material-symbols-outlined text-sm">close</span></button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button type="button" onClick={() => {
                          if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                            navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
                              stream.getTracks().forEach(t => t.stop());
                              const input = document.createElement('input');
                              input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
                              input.onchange = (ev) => { const file = (ev.target as HTMLInputElement).files?.[0]; if (file) { const reader = new FileReader(); reader.onloadend = () => setEditTradeInPhoto(reader.result as string); reader.readAsDataURL(file); } };
                              document.body.appendChild(input); input.click(); document.body.removeChild(input);
                            }).catch(() => { alert('Camera not available on this device. Please use Upload instead.'); });
                          } else { alert('Camera not supported on this device. Please use Upload instead.'); }
                        }} className="flex-1 py-3.5 bg-primary text-white rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-primary/90">
                          <span className="material-symbols-outlined text-sm">photo_camera</span>Camera
                        </button>
                        <button type="button" onClick={() => editIdPhotoRef.current?.click()} className="py-3.5 px-4 bg-slate-50 border border-slate-200 rounded-2xl text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1 hover:bg-slate-100 transition-all">
                          <span className="material-symbols-outlined text-sm">upload</span>Upload
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button type="button" onClick={() => setEditingTradeIn(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                    <button type="submit" className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20">Save Changes</button>
                  </div>
                </form>
              </motion.div>
            </div>
          );
        })()}

        {editingSuggestiveItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden">
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h2 className="text-xl font-black text-primary tracking-tight">Edit Suggestive Item</h2>
                  <p className="text-slate-500 text-xs font-medium">Update item details</p>
                </div>
                <button onClick={() => setEditingSuggestiveItem(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              {editSugSaveSuccess ? (
                <div className="p-12 text-center space-y-4">
                  <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto"><span className="material-symbols-outlined text-3xl text-lime-600" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span></div>
                  <p className="text-lg font-black text-primary">Item Updated</p>
                </div>
              ) : (
                <>
                  <div className="p-8 space-y-5">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Item Name</label>
                      <input type="text" value={editSugName} onChange={(e) => setEditSugName(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Sell Price</label>
                        <div className="relative">
                          <span className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                          <input type="number" step="0.01" value={editSugPrice} onChange={(e) => setEditSugPrice(e.target.value)} className="w-full pl-10 pr-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Category</label>
                        <select value={editSugCategory} onChange={(e) => setEditSugCategory(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                          <option>Parts</option><option>Accessories</option><option>Devices</option><option>Other</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  <div className="p-8 bg-slate-50 border-t border-slate-100 flex justify-between">
                    <button onClick={() => { updateStockItem(editingSuggestiveItem.id, { isSuggestiveSale: false }); setEditingSuggestiveItem(null); }} className="px-6 py-4 bg-white border border-red-200 text-red-600 font-black text-xs rounded-2xl hover:bg-red-50 transition-all uppercase tracking-widest flex items-center gap-2">
                      <span className="material-symbols-outlined text-sm">delete</span>Remove
                    </button>
                    <button onClick={() => {
                      updateStockItem(editingSuggestiveItem.id, { name: editSugName, price: parseFloat(editSugPrice) || editingSuggestiveItem.price, category: editSugCategory });
                      setEditSugSaveSuccess(true);
                      setTimeout(() => setEditingSuggestiveItem(null), 1200);
                    }} className="px-8 py-4 bg-primary text-white font-black text-xs rounded-2xl shadow-xl shadow-primary/20 active:scale-95 transition-all uppercase tracking-widest">Save Changes</button>
                  </div>
                </>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Inventory;
