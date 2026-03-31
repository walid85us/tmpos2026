import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { TradeInItem, RefurbishmentJob, InventoryTransfer, InventoryCount, BillPayment, GiftCard, InventoryBundle } from '../types';
import { useStoreLocalState, StockItem } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import ContextualHelp from './ContextualHelp';

const Inventory: React.FC = () => {
  const { approvedStockItems, pendingStockItems, addStockItem, updateStockItem } = useStoreLocalState();
  const { canAccess, session } = useAccess();
  const hasInventoryPermission = (() => {
    if (!session) return false;
    if (session.role === 'system_owner' || session.role === 'store_owner' || session.role === 'manager') return true;
    if (session.role === 'technician') return true;
    return false;
  })();
  const [activeTab, setActiveTab] = useState<string>('inventory');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddProductModalOpen, setIsAddProductModalOpen] = useState(false);

  const [newProductName, setNewProductName] = useState('');
  const [newProductCategory, setNewProductCategory] = useState('Parts');
  const [newProductSku, setNewProductSku] = useState('');
  const [newProductCost, setNewProductCost] = useState('');
  const [newProductPrice, setNewProductPrice] = useState('');
  const [newProductQty, setNewProductQty] = useState('1');
  const [addProductSuccess, setAddProductSuccess] = useState(false);

  const resetAddProductForm = () => {
    setNewProductName(''); setNewProductCategory('Parts'); setNewProductSku('');
    setNewProductCost(''); setNewProductPrice(''); setNewProductQty('1');
    setAddProductSuccess(false);
  };

  const [tradeIns] = useState<TradeInItem[]>([
    { id: 'T1', customerId: 'C1', customerName: 'John Doe', device: 'iPhone 12', condition: 'Good', buybackPrice: 250, status: 'In Inventory', createdAt: '2024-03-15' },
    { id: 'T2', customerId: 'C2', customerName: 'Jane Smith', device: 'Samsung S21', condition: 'Fair', buybackPrice: 180, status: 'Refurbishing', createdAt: '2024-03-18' },
  ]);

  const [refurbJobs] = useState<RefurbishmentJob[]>([
    { id: 'R1', itemId: 'T2', itemName: 'Samsung S21', technicianId: 'E1', technicianName: 'Mike Tech', status: 'In Progress', notes: 'Replacing battery and back glass', partsUsed: [{ name: 'S21 Battery', cost: 15 }], totalCost: 35, createdAt: '2024-03-18' },
  ]);

  const [transfers] = useState<InventoryTransfer[]>([
    { id: 'TR1', fromStore: 'Main Warehouse', toStore: 'Downtown Branch', items: [{ productId: '1', name: 'iPhone 14 Pro Screen', quantity: 5 }], status: 'Sent', createdAt: '2024-03-19' },
  ]);

  const [counts] = useState<InventoryCount[]>([
    { id: 'IC1', date: '2024-03-01', status: 'Completed', items: [], performedBy: 'Admin' },
  ]);

  const [bills] = useState<BillPayment[]>([
    { id: 'B1', vendorName: 'Global Parts Inc', amount: 1250.00, dueDate: '2024-04-05', status: 'Unpaid', paymentHistory: [], remindersSent: 0 },
  ]);

  const [giftCards] = useState<GiftCard[]>([
    { id: 'G1', cardNumber: 'RD-8829-1102', initialBalance: 100, currentBalance: 75, customerName: 'Alice Brown', expiryDate: '2025-12-31', status: 'Active', createdAt: '2024-01-10' },
  ]);

  const [bundles] = useState<InventoryBundle[]>([
    { id: 'BN1', name: 'iPhone 13 Repair Bundle', items: [{ productId: '2', name: 'iPhone 13 Battery', quantity: 1 }], price: 45.00, sku: 'BND-I13-REP' },
  ]);

  const tabs = [
    { id: 'inventory', label: 'Inventory', icon: 'inventory_2' },
    { id: 'suggestive', label: 'Suggestive Sales', icon: 'lightbulb' },
    { id: 'trade-in', label: 'Trade-In', icon: 'swap_horiz' },
    { id: 'refurb', label: 'Refurbishment', icon: 'build_circle' },
    { id: 'transfer', label: 'Transfers', icon: 'local_shipping' },
    { id: 'count', label: 'Stock Count', icon: 'checklist' },
    { id: 'bills', label: 'Bill Payments', icon: 'payments' },
    { id: 'giftcards', label: 'Gift Cards', icon: 'card_giftcard' },
    { id: 'bundles', label: 'Bundles', icon: 'inventory' },
  ];

  const allInventoryItems = approvedStockItems;
  const filteredProducts = allInventoryItems.filter(p => {
    if (searchQuery.startsWith('cat:')) {
      return p.category === searchQuery.slice(4);
    }
    return p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      p.sku.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const handleSaveProduct = () => {
    if (!newProductName.trim()) return;
    const item: StockItem = {
      id: `stk-${Date.now()}`,
      name: newProductName.trim(),
      sku: newProductSku || `SKU-${Date.now().toString().slice(-6)}`,
      qty: parseInt(newProductQty) || 1,
      cost: parseFloat(newProductCost) || 0,
      price: parseFloat(newProductPrice) || 0,
      category: newProductCategory,
      addedAt: new Date().toISOString(),
      status: hasInventoryPermission ? 'approved' : 'pending_approval',
    };
    addStockItem(item);
    setAddProductSuccess(true);
    setTimeout(() => { setIsAddProductModalOpen(false); resetAddProductForm(); }, 1500);
  };

  const renderInventory = () => (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="relative w-full md:w-96">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">search</span>
          <input
            type="text"
            placeholder="Search products, SKU..."
            className="w-full pl-12 pr-4 py-3 bg-white/50 backdrop-blur-md border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <select
            value={searchQuery.startsWith('cat:') ? searchQuery.slice(4) : ''}
            onChange={(e) => setSearchQuery(e.target.value ? `cat:${e.target.value}` : '')}
            className="flex-1 md:flex-none px-6 py-3 bg-white border border-slate-200 text-primary font-black text-xs rounded-2xl hover:bg-slate-50 transition-all uppercase tracking-widest appearance-none cursor-pointer"
          >
            <option value="">All Categories</option>
            {[...new Set(allInventoryItems.map(p => p.category))].map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          <button onClick={() => window.print()} className="flex-1 md:flex-none px-6 py-3 bg-white border border-slate-200 text-primary font-black text-xs rounded-2xl hover:bg-slate-50 transition-all uppercase tracking-widest flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">file_download</span>
            Export
          </button>
          <button 
            onClick={() => { resetAddProductForm(); setIsAddProductModalOpen(true); }}
            className="flex-1 md:flex-none px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Add Product
          </button>
        </div>
      </div>

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
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Product Details</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">SKU</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Price</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Stock</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-8 py-12 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center">
                        <span className="material-symbols-outlined text-3xl text-slate-300">inventory_2</span>
                      </div>
                      <p className="text-sm font-bold text-slate-400">No inventory items found</p>
                      <p className="text-xs text-slate-300">Add products via "Add Product" or Quick Add Stock from Dashboard/POS</p>
                    </div>
                  </td>
                </tr>
              ) : filteredProducts.map((product) => (
                <tr key={product.id} className="group hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center">
                        <span className="material-symbols-outlined text-slate-400">
                          {product.category === 'Parts' ? 'build' : product.category === 'Accessories' ? 'cable' : product.category === 'Devices' ? 'smartphone' : 'inventory_2'}
                        </span>
                      </div>
                      <div>
                        <p className="font-bold text-slate-900">{product.name}</p>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{product.category}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    <span className="px-3 py-1 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-lg">
                      {product.category}
                    </span>
                  </td>
                  <td className="px-8 py-6">
                    <p className="font-mono text-xs font-bold text-slate-500">{product.sku}</p>
                  </td>
                  <td className="px-8 py-6">
                    <p className="font-black text-primary">${product.price.toFixed(2)}</p>
                    <p className="text-[10px] text-slate-400 font-bold">Cost: ${product.cost.toFixed(2)}</p>
                  </td>
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 bg-slate-100 h-1.5 rounded-full overflow-hidden w-24">
                        <div 
                          className={`h-full transition-all duration-500 ${product.qty <= 5 ? 'bg-orange-500' : 'bg-lime-500'}`} 
                          style={{ width: `${Math.min((product.qty / 30) * 100, 100)}%` }}
                        ></div>
                      </div>
                      <span className={`text-sm font-black ${product.qty <= 5 ? 'text-orange-600' : 'text-primary'}`}>
                        {product.qty}
                      </span>
                    </div>
                  </td>
                  <td className="px-8 py-6 text-right">
                    <div className="flex justify-end gap-2">
                      <button className="p-2 hover:bg-white rounded-xl transition-all text-slate-400 hover:text-primary" title="Edit Product">
                        <span className="material-symbols-outlined text-sm">edit</span>
                      </button>
                      <button onClick={() => window.print()} className="p-2 hover:bg-white rounded-xl transition-all text-slate-400 hover:text-primary" title="Print Barcode">
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
    </div>
  );

  const renderTradeIn = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Buyback & Trade-In</h2>
        <button onClick={() => setIsAddProductModalOpen(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>
          New Trade-In
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {tradeIns.map((item) => (
          <div key={item.id} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm hover:shadow-md transition-all">
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${
                  item.status === 'In Inventory' ? 'bg-lime-400/10 text-lime-700 border-lime-400/20' : 'bg-orange-400/10 text-orange-700 border-orange-400/20'
                }`}>
                  {item.status}
                </span>
                <h3 className="text-lg font-black text-primary tracking-tight mt-2">{item.device}</h3>
              </div>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{item.createdAt}</span>
            </div>
            <div className="space-y-3 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 font-bold">Customer</span>
                <span className="text-slate-900 font-black">{item.customerName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 font-bold">Condition</span>
                <span className="text-slate-900 font-black">{item.condition}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 font-bold">Buyback Price</span>
                <span className="text-primary font-black">${item.buybackPrice}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setActiveTab('refurb')} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                Refurbish
              </button>
              <button onClick={() => setActiveTab('products')} className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95">
                Move to Stock
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderRefurb = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Refurbishment Module</h2>
        <div className="flex gap-2">
          <span className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black text-slate-500 uppercase tracking-widest">
            Active Jobs: {refurbJobs.length}
          </span>
        </div>
      </div>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Device</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Technician</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Cost</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {refurbJobs.map((job) => (
              <tr key={job.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-6 font-bold text-slate-900">{job.itemName}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{job.technicianName}</td>
                <td className="px-8 py-6">
                  <span className="px-3 py-1 bg-orange-400/10 text-orange-600 text-[10px] font-black uppercase tracking-widest rounded-lg border border-orange-400/20">
                    {job.status}
                  </span>
                </td>
                <td className="px-8 py-6 font-black text-primary">${job.totalCost}</td>
                <td className="px-8 py-6 text-right">
                  <button onClick={() => setActiveTab('products')} className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 active:scale-95 transition-all">
                    Complete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderTransfers = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Inventory Transfers</h2>
        <button onClick={() => setIsAddProductModalOpen(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>
          New Transfer
        </button>
      </div>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Transfer ID</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">From / To</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Items</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Date</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-6 font-black text-primary text-xs">{t.id}</td>
                <td className="px-8 py-6">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">{t.fromStore}</span>
                    <span className="material-symbols-outlined text-slate-300 text-sm">arrow_forward</span>
                    <span className="text-sm font-bold text-slate-900">{t.toStore}</span>
                  </div>
                </td>
                <td className="px-8 py-6">
                  <span className="text-sm font-bold text-slate-600">{t.items.length} items</span>
                </td>
                <td className="px-8 py-6">
                  <span className="px-3 py-1 bg-primary/10 text-primary text-[10px] font-black uppercase tracking-widest rounded-lg border border-primary/20">
                    {t.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {t.createdAt}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderBills = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Bill Payments</h2>
        <button onClick={() => setIsAddProductModalOpen(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>
          Add Bill
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {bills.map((bill) => (
          <div key={bill.id} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Vendor</p>
                <h3 className="text-lg font-black text-primary tracking-tight">{bill.vendorName}</h3>
              </div>
              <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${
                bill.status === 'Overdue' ? 'bg-red-400/10 text-red-700 border-red-400/20' : 'bg-slate-100 text-slate-600 border-slate-200'
              }`}>
                {bill.status}
              </span>
            </div>
            <div className="flex justify-between items-end">
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Due Date</p>
                <p className="text-sm font-bold text-slate-900">{bill.dueDate}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Amount Due</p>
                <p className="text-2xl font-black text-primary">${bill.amount.toFixed(2)}</p>
              </div>
            </div>
            <button onClick={(e) => { const btn = e.currentTarget; btn.textContent = 'Payment Processed!'; btn.classList.replace('bg-primary', 'bg-emerald-500'); setTimeout(() => { btn.textContent = 'Process Payment'; btn.classList.replace('bg-emerald-500', 'bg-primary'); }, 2000); }} className="w-full mt-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 active:scale-95 transition-all">
              Process Payment
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderGiftCards = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Gift Cards</h2>
        <button onClick={() => setIsAddProductModalOpen(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>
          Issue Gift Card
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {giftCards.map((card) => (
          <div key={card.id} className="bg-gradient-to-br from-teal-900 to-teal-950 p-6 rounded-[2.5rem] shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-32 h-32 bg-lime-400/10 rounded-full -mr-16 -mt-16 blur-2xl group-hover:bg-lime-400/20 transition-all"></div>
            <div className="relative z-10 space-y-8">
              <div className="flex justify-between items-start">
                <span className="material-symbols-outlined text-lime-400 text-3xl">card_giftcard</span>
                <span className="text-[10px] font-black text-lime-400 uppercase tracking-widest bg-lime-400/10 px-3 py-1 rounded-lg border border-lime-400/20">
                  {card.status}
                </span>
              </div>
              <div>
                <p className="text-[10px] font-black text-teal-400/60 uppercase tracking-widest mb-1">Card Number</p>
                <p className="text-xl font-black text-white tracking-widest">{card.cardNumber}</p>
              </div>
              <div className="flex justify-between items-end">
                <div>
                  <p className="text-[10px] font-black text-teal-400/60 uppercase tracking-widest mb-1">Holder</p>
                  <p className="text-sm font-bold text-white">{card.customerName || 'Guest'}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-black text-teal-400/60 uppercase tracking-widest mb-1">Balance</p>
                  <p className="text-2xl font-black text-lime-400">${card.currentBalance.toFixed(2)}</p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderBundles = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Inventory Bundles</h2>
        <button onClick={() => setIsAddProductModalOpen(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>
          Create Bundle
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {bundles.map((bundle) => (
          <div key={bundle.id} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-black text-primary tracking-tight">{bundle.name}</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">SKU: {bundle.sku}</p>
              </div>
              <span className="text-xl font-black text-primary">${bundle.price.toFixed(2)}</span>
            </div>
            <div className="space-y-2">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Included Items</p>
              {bundle.items.map((item, i) => (
                <div key={i} className="flex justify-between items-center bg-slate-50 p-3 rounded-xl border border-slate-100">
                  <span className="text-sm font-bold text-slate-700">{item.name}</span>
                  <span className="text-[10px] font-black text-primary uppercase tracking-widest">Qty: {item.quantity}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderCount = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Inventory Count & Audits</h2>
        <button onClick={() => setIsAddProductModalOpen(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2 active:scale-95">
          <span className="material-symbols-outlined text-sm">add</span>
          Start New Count
        </button>
      </div>
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Audit ID</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Performed By</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Discrepancies</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-6 font-black text-primary text-xs">{c.id}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-900">{c.date}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{c.performedBy}</td>
                <td className="px-8 py-6">
                  <span className="px-3 py-1 bg-lime-400/10 text-lime-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-lime-400/20">
                    {c.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right">
                  <span className="font-black text-slate-400">0 Items</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderPlaceholder = (title: string) => (
    <div className="flex flex-col items-center justify-center py-20 bg-white/50 backdrop-blur-xl rounded-[3rem] border-2 border-dashed border-slate-200">
      <span className="material-symbols-outlined text-6xl text-slate-200 mb-4">construction</span>
      <h3 className="text-xl font-black text-primary tracking-tight mb-2">{title} Module</h3>
      <p className="text-slate-400 font-medium text-center max-w-md">
        This feature is currently being integrated with the full inventory management system.
      </p>
    </div>
  );

  return (
    <div className="p-8 max-w-[1600px] mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-4xl font-black text-primary tracking-tight mb-2">Inventory Management</h1>
          <p className="text-slate-500 font-medium">Track stock, trade-ins, and refurbishments across all locations.</p>
        </div>
        <div className="flex items-center gap-4 bg-white/80 backdrop-blur-xl p-2 rounded-3xl border border-slate-200 shadow-sm">
          <div className="px-6 py-3 text-center border-r border-slate-100">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Value</p>
            <p className="text-xl font-black text-primary">$42,850.00</p>
          </div>
          <div className="px-6 py-3 text-center">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Low Stock</p>
            <p className="text-xl font-black text-orange-500">12 Items</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-6 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-3 transition-all whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-primary text-white shadow-lg shadow-primary/20'
                : 'bg-white text-slate-400 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            <span className="material-symbols-outlined text-lg">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content Area */}
      <motion.div
        key={activeTab}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        {activeTab === 'inventory' && renderInventory()}
        {activeTab === 'suggestive' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black text-primary">Suggestive Sales Items</h3>
                <p className="text-xs text-slate-400 mt-1">Toggle items to appear as quick-add suggestions during POS checkout</p>
              </div>
            </div>
            <div className="space-y-3">
              {approvedStockItems.map(item => (
                <div key={item.id} className="flex items-center justify-between p-5 bg-white rounded-2xl ghost-border shadow-sm hover:shadow-md transition-all">
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${item.isSuggestiveSale ? 'bg-lime-100 text-lime-700' : 'bg-slate-100 text-slate-400'}`}>
                      <span className="material-symbols-outlined text-lg">lightbulb</span>
                    </div>
                    <div>
                      <p className="font-bold text-sm text-slate-900">{item.name}</p>
                      <p className="text-xs text-slate-500">{item.sku} &bull; {item.category} &bull; ${item.price.toFixed(2)} &bull; {item.qty} in stock</p>
                    </div>
                  </div>
                  <button
                    onClick={() => updateStockItem(item.id, { isSuggestiveSale: !item.isSuggestiveSale })}
                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${item.isSuggestiveSale ? 'bg-lime-500' : 'bg-slate-200'}`}
                  >
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform ${item.isSuggestiveSale ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              ))}
              {approvedStockItems.length === 0 && (
                <div className="py-12 text-center">
                  <p className="text-sm font-bold text-slate-400">No approved stock items</p>
                  <p className="text-xs text-slate-300 mt-1">Add items to inventory first</p>
                </div>
              )}
            </div>
            <div className="p-4 bg-teal-50 rounded-2xl border border-teal-100">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-teal-600 text-sm">info</span>
                <span className="text-[10px] font-black text-teal-700 uppercase tracking-widest">How It Works</span>
              </div>
              <p className="text-xs text-teal-600">Enabled items appear as suggestive sale prompts in the POS checkout flow, encouraging add-on sales. Customers see these recommendations before finalizing their purchase.</p>
            </div>
          </div>
        )}
        {activeTab === 'trade-in' && renderTradeIn()}
        {activeTab === 'refurb' && renderRefurb()}
        {activeTab === 'transfer' && renderTransfers()}
        {activeTab === 'count' && renderCount()}
        {activeTab === 'bills' && renderBills()}
        {activeTab === 'giftcards' && renderGiftCards()}
        {activeTab === 'bundles' && renderBundles()}
      </motion.div>

      {/* Contextual Help Section */}
      <ContextualHelp 
        title="Inventory Knowledge Hub"
        items={[
          { title: 'Inventory vs Service Items', description: 'Inventory items track physical stock, while service items represent labor and repairs.', icon: 'category' },
          { title: 'Serialized Inventory', description: 'Track unique items using IMEI or Serial Numbers for precise history and warranty tracking.', icon: 'barcode' },
          { title: 'Transfer Inventory', description: 'Move stock between multiple store locations with full audit trails and real-time updates.', icon: 'local_shipping' },
          { title: 'Special Part Order', description: 'Efficiently order specific parts for a customer that aren\'t currently in your regular stock.', icon: 'shopping_cart' },
          { title: 'Warranty for Parts', description: 'Define duration and terms for individual inventory items to automate claim processing.', icon: 'verified' }
        ]}
        accentColor="primary"
      />

      {/* Add Product Modal */}
      <AnimatePresence>
        {isAddProductModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h2 className="text-2xl font-black text-primary tracking-tight">Add New Product</h2>
                  <p className="text-slate-500 text-sm font-medium">Enter product details to add to inventory.</p>
                </div>
                <button 
                  onClick={() => { setIsAddProductModalOpen(false); resetAddProductForm(); }}
                  className="w-12 h-12 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary transition-all"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              {addProductSuccess ? (
                <div className="p-12 text-center space-y-4">
                  <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto">
                    <span className="material-symbols-outlined text-3xl text-lime-600" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                  </div>
                  <p className="text-lg font-black text-primary">{hasInventoryPermission ? 'Added to Inventory' : 'Submitted for Approval'}</p>
                  <p className="text-xs text-slate-500">{approvedStockItems.length} approved item{approvedStockItems.length !== 1 ? 's' : ''} in inventory{pendingStockItems.length > 0 ? ` · ${pendingStockItems.length} pending approval` : ''}</p>
                </div>
              ) : (
                <>
                  <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Product Name *</label>
                      <input type="text" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="e.g. iPhone 15 Screen" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Category</label>
                        <select value={newProductCategory} onChange={(e) => setNewProductCategory(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                          <option>Parts</option>
                          <option>Accessories</option>
                          <option>Devices</option>
                          <option>Other</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">SKU</label>
                        <input type="text" value={newProductSku} onChange={(e) => setNewProductSku(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono text-sm font-bold" placeholder="Auto-generated if blank" />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Cost Price</label>
                        <div className="relative">
                          <span className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                          <input type="number" step="0.01" value={newProductCost} onChange={(e) => setNewProductCost(e.target.value)} className="w-full pl-10 pr-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="0.00" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Sell Price</label>
                        <div className="relative">
                          <span className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                          <input type="number" step="0.01" value={newProductPrice} onChange={(e) => setNewProductPrice(e.target.value)} className="w-full pl-10 pr-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="0.00" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Quantity</label>
                        <input type="number" min="1" value={newProductQty} onChange={(e) => setNewProductQty(e.target.value)} className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="1" />
                      </div>
                    </div>
                  </div>
                  <div className="p-8 bg-slate-50 border-t border-slate-100 flex justify-end gap-4">
                    <button 
                      onClick={() => { setIsAddProductModalOpen(false); resetAddProductForm(); }}
                      className="px-8 py-4 bg-white border border-slate-200 text-slate-500 font-black text-xs rounded-2xl hover:bg-slate-100 transition-all uppercase tracking-widest"
                    >
                      Cancel
                    </button>
                    <button disabled={!newProductName.trim()} onClick={handleSaveProduct} className="px-8 py-4 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed">
                      {hasInventoryPermission ? 'Save Product' : 'Submit for Approval'}
                    </button>
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
