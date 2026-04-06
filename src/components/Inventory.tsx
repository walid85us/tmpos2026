import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState, StockItem } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { StockMovement } from '../types';
import ContextualHelp from './ContextualHelp';

type InventoryTab = 'inventory' | 'movements' | 'suggestive' | 'trade-in' | 'refurb' | 'transfer' | 'count' | 'bills' | 'giftcards' | 'bundles';
type FilterType = 'all' | 'serialized' | 'non-serialized' | 'handset';

const Inventory: React.FC = () => {
  const {
    approvedStockItems, pendingStockItems, addStockItem, updateStockItem, deleteStockItem,
    stockMovements, addStockMovement,
    inventoryTransfers, addInventoryTransfer, updateInventoryTransfer,
    inventoryCounts, addInventoryCount, updateInventoryCount,
    tradeIns, addTradeIn, updateTradeIn,
    refurbishmentJobs, addRefurbishmentJob, updateRefurbishmentJob,
    suppliers, customers,
  } = useStoreLocalState();
  const { checkPermission } = useAccess();
  const hasInventoryPermission = checkPermission('inventory', 'manage');

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

  const getItemMovements = (itemId: string) => stockMovements.filter(m => m.stockItemId === itemId).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

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
    if (!adjustItem || !adjustQty) return;
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
      case 'Received': case 'Completed': case 'In Inventory': return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
      case 'Sent': case 'In Transit': case 'In Progress': case 'Refurbishing': case 'Testing': return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
      case 'Draft': case 'Pending': case 'Evaluated': return 'bg-primary/10 text-primary border-primary/20';
      case 'Cancelled': return 'bg-rose-500/10 text-rose-600 border-rose-500/20';
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
          <button onClick={() => { resetAddProductForm(); setIsAddProductModalOpen(true); }} className="flex-1 md:flex-none px-5 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">add</span>Add Product
          </button>
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
                        <button onClick={() => { setAdjustItem(product); setAdjustType('increase'); setAdjustQty(''); setAdjustReason(''); setAdjustNotes(''); setShowAdjustModal(true); }} className="p-2 hover:bg-emerald-50 rounded-xl text-slate-400 hover:text-emerald-600" title="Adjust Stock">
                          <span className="material-symbols-outlined text-sm">tune</span>
                        </button>
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

  const renderTradeIn = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Buyback & Trade-In</h2>
        <button onClick={() => setShowCreateTradeIn(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>New Trade-In
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {tradeIns.map((item) => (
          <div key={item.id} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(item.status)}`}>{item.status}</span>
                <h3 className="text-lg font-black text-primary tracking-tight mt-2">{item.device}</h3>
              </div>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{item.createdAt}</span>
            </div>
            <div className="space-y-2 mb-4 text-sm">
              <div className="flex justify-between"><span className="text-slate-500 font-bold">Customer</span><span className="text-slate-900 font-black">{item.customerName}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 font-bold">Condition</span><span className="text-slate-900 font-black">{item.condition}</span></div>
              <div className="flex justify-between"><span className="text-slate-500 font-bold">Buyback</span><span className="text-primary font-black">${item.buybackPrice}</span></div>
              {item.resalePrice && <div className="flex justify-between"><span className="text-slate-500 font-bold">Resale</span><span className="text-emerald-600 font-black">${item.resalePrice}</span></div>}
              {item.gradeNotes && <p className="text-xs text-slate-400 italic pt-1">{item.gradeNotes}</p>}
            </div>
            {item.status === 'Pending' && (
              <div className="flex gap-2">
                <button onClick={() => updateTradeIn(item.id, { status: 'Evaluated' })} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">Evaluate</button>
                <button onClick={() => {
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
            {item.status === 'Evaluated' && (
              <div className="flex gap-2">
                <button onClick={() => {
                  addRefurbishmentJob({
                    id: `rfb-${Date.now()}`, itemId: item.id, itemName: item.device,
                    technicianId: '', technicianName: 'Unassigned', status: 'Pending',
                    notes: item.gradeNotes || '', partsUsed: [], totalCost: 0,
                    createdAt: new Date().toISOString(),
                  });
                  updateTradeIn(item.id, { status: 'Refurbishing' });
                }} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">Send to Refurb</button>
                <button onClick={() => {
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
                  <p className="font-bold text-slate-900">{job.itemName}</p>
                  <p className="text-[10px] text-slate-400">{job.notes}</p>
                </td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{job.technicianName}</td>
                <td className="px-6 py-5"><span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(job.status)}`}>{job.status}</span></td>
                <td className="px-6 py-5 text-xs text-slate-600">{job.partsUsed.length > 0 ? job.partsUsed.map(p => p.name).join(', ') : '—'}</td>
                <td className="px-6 py-5 font-black text-primary">${job.totalCost.toFixed(2)}</td>
                <td className="px-6 py-5 text-right">
                  {job.status !== 'Completed' ? (
                    <button onClick={() => {
                      const tradeIn = tradeIns.find(t => t.id === job.itemId);
                      const newItem: StockItem = {
                        id: `stk-rfb-${Date.now()}`, name: `${job.itemName} (Refurbished)`,
                        sku: `RFB-${Date.now().toString().slice(-6)}`, qty: 1,
                        cost: (tradeIn?.buybackPrice || 0) + job.totalCost,
                        price: tradeIn?.resalePrice || ((tradeIn?.buybackPrice || 0) + job.totalCost) * 1.5,
                        category: 'Devices', type: 'serialized', isRepairPart: false, isHiddenOnPOS: false,
                        addedAt: new Date().toISOString(), status: 'approved',
                      };
                      addStockItem(newItem);
                      addStockMovement({
                        id: `sm-${Date.now()}`, stockItemId: newItem.id, stockItemName: newItem.name,
                        type: 'refurbishment_complete', quantityChange: 1, previousQty: 0, newQty: 1,
                        referenceId: job.id, referenceType: 'refurbishment',
                        performedBy: 'Current User', timestamp: new Date().toISOString(),
                        reason: `Refurbishment of ${job.itemName} completed`,
                      });
                      updateRefurbishmentJob(job.id, { status: 'Completed', completedAt: new Date().toISOString(), resultingProductId: newItem.id });
                      if (tradeIn) updateTradeIn(tradeIn.id, { status: 'In Inventory', movedToInventoryId: newItem.id });
                    }} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 active:scale-95 transition-all">Complete</button>
                  ) : (
                    <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Done</span>
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

  const renderTransfers = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Inventory Transfers</h2>
        <button onClick={() => setShowCreateTransfer(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>New Transfer
        </button>
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
              <tr key={t.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-5 font-black text-primary text-xs">{t.transferNumber}</td>
                <td className="px-6 py-5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">{t.fromStore}</span>
                    <span className="material-symbols-outlined text-slate-300 text-sm">arrow_forward</span>
                    <span className="text-sm font-bold text-slate-900">{t.toStore}</span>
                  </div>
                </td>
                <td className="px-6 py-5 text-sm font-bold text-slate-600">{t.items.length} item{t.items.length !== 1 ? 's' : ''}</td>
                <td className="px-6 py-5"><span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(t.status)}`}>{t.status}</span></td>
                <td className="px-6 py-5 text-sm font-bold text-slate-500">{t.requestedBy || '—'}</td>
                <td className="px-6 py-5 text-right">
                  <div className="flex justify-end gap-2">
                    {t.status === 'Draft' && <button onClick={() => updateInventoryTransfer(t.id, { status: 'Sent', sentAt: new Date().toISOString() })} className="px-3 py-1.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90">Send</button>}
                    {t.status === 'Sent' && <button onClick={() => updateInventoryTransfer(t.id, { status: 'In Transit' })} className="px-3 py-1.5 bg-amber-500 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-amber-600">In Transit</button>}
                    {(t.status === 'Sent' || t.status === 'In Transit') && <button onClick={() => {
                      updateInventoryTransfer(t.id, { status: 'Received', receivedAt: new Date().toISOString() });
                      t.items.forEach(item => {
                        addStockMovement({
                          id: `sm-${Date.now()}-${item.productId}`, stockItemId: item.productId, stockItemName: item.name,
                          type: 'transfer_in', quantityChange: item.quantity, previousQty: 0, newQty: item.quantity,
                          referenceId: t.id, referenceType: 'transfer',
                          performedBy: 'Current User', timestamp: new Date().toISOString(),
                          reason: `Received from transfer ${t.transferNumber}`,
                        });
                      });
                    }} className="px-3 py-1.5 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-emerald-600">Receive</button>}
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

  const renderCount = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Stock Count & Audits</h2>
        <button onClick={() => setShowCreateCount(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>Start New Count
        </button>
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
                  <td className="px-8 py-5 font-black text-primary text-xs">{c.countNumber}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-900">{c.date}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-600">{c.performedBy}</td>
                  <td className="px-6 py-5 text-sm font-bold text-slate-600">{c.items.length}</td>
                  <td className="px-6 py-5"><span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(c.status)}`}>{c.status}</span></td>
                  <td className="px-6 py-5"><span className={`font-black ${discrepancies > 0 ? 'text-red-600' : 'text-slate-400'}`}>{discrepancies} item{discrepancies !== 1 ? 's' : ''}</span></td>
                  <td className="px-6 py-5 text-right">
                    {c.status === 'In Progress' && (
                      <button onClick={() => {
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
                        updateInventoryCount(c.id, { status: 'Completed', completedAt: new Date().toISOString() });
                      }} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 active:scale-95 transition-all">Complete Count</button>
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
        {/* Item Detail Modal */}
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
                {(['info', 'movements', 'edit'] as const).map(tab => (
                  <button key={tab} onClick={() => setDetailTab(tab)} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${detailTab === tab ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-slate-400 hover:text-slate-600'}`}>
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
                      <button onClick={() => { setAdjustItem(selectedItem); setAdjustType('increase'); setAdjustQty(''); setAdjustReason(''); setAdjustNotes(''); setShowAdjustModal(true); }} className="flex-1 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">Adjust Stock</button>
                      <button onClick={() => setDetailTab('edit')} className="flex-1 py-3 bg-slate-100 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-slate-200 active:scale-95 transition-all">Edit Item</button>
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
                {detailTab === 'edit' && (
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Name</label>
                      <input type="text" defaultValue={selectedItem.name} onBlur={(e) => updateStockItem(selectedItem.id, { name: e.target.value })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" />
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
              </div>
            </motion.div>
          </div>
        )}

        {/* Stock Adjust Modal */}
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

        {/* Add Product Modal */}
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
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Manufacturer</label>
                      <input type="text" value={newProductManufacturer} onChange={(e) => setNewProductManufacturer(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Brand" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Supplier</label>
                      <select value={newProductSupplierId} onChange={(e) => setNewProductSupplierId(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                        <option value="">None</option>
                        {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Min Stock</label>
                      <input type="number" value={newProductMinStock} onChange={(e) => setNewProductMinStock(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Max Stock</label>
                      <input type="number" value={newProductMaxStock} onChange={(e) => setNewProductMaxStock(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="0" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Location</label>
                      <input type="text" value={newProductLocation} onChange={(e) => setNewProductLocation(e.target.value)} className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Shelf" />
                    </div>
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

        {/* Create Trade-In Modal */}
        {showCreateTradeIn && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-xl font-black text-primary tracking-tight">New Trade-In</h2>
              </div>
              <form className="p-8 space-y-4" onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const cust = customers.find(c => c.id === fd.get('customer'));
                addTradeIn({
                  id: `ti-${Date.now()}`, customerId: fd.get('customer') as string, customerName: cust?.name || 'Walk-in',
                  device: fd.get('device') as string, condition: fd.get('condition') as any, gradeNotes: fd.get('notes') as string || undefined,
                  buybackPrice: parseFloat(fd.get('buyback') as string) || 0, status: 'Pending', createdAt: new Date().toISOString().split('T')[0],
                });
                setShowCreateTradeIn(false);
              }}>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Customer</label>
                  <select name="customer" required className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                    {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
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

        {/* Create Transfer Modal */}
        {showCreateTransfer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-md overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h2 className="text-xl font-black text-primary tracking-tight">New Transfer</h2>
              </div>
              <form className="p-8 space-y-4" onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const itemId = fd.get('item') as string;
                const item = approvedStockItems.find(i => i.id === itemId);
                if (!item) return;
                const qty = parseInt(fd.get('qty') as string) || 1;
                addInventoryTransfer({
                  id: `tr-${Date.now()}`, transferNumber: `TRF-${new Date().getFullYear()}-${String(inventoryTransfers.length + 1).padStart(3, '0')}`,
                  fromStore: fd.get('from') as string, toStore: fd.get('to') as string,
                  items: [{ productId: itemId, name: item.name, quantity: qty }],
                  status: 'Draft', requestedBy: 'Current User', notes: fd.get('notes') as string || undefined,
                  createdAt: new Date().toISOString().split('T')[0],
                });
                setShowCreateTransfer(false);
              }}>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">From</label>
                    <input name="from" defaultValue="Main Warehouse" required className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">To</label>
                    <input name="to" required className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" placeholder="Branch name" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Item</label>
                  <select name="item" required className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold">
                    {approvedStockItems.filter(i => i.qty > 0).map(i => <option key={i.id} value={i.id}>{i.name} ({i.qty} in stock)</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Quantity</label>
                  <input name="qty" type="number" min="1" defaultValue="1" required className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                  <textarea name="notes" className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl font-bold h-16 resize-none" />
                </div>
                <div className="flex gap-4 pt-2">
                  <button type="button" onClick={() => setShowCreateTransfer(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                  <button type="submit" className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-primary/20">Create</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {/* Create Count Modal */}
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

        {/* Edit Suggestive Item Modal */}
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
