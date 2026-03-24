import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Product, TradeInItem, RefurbishmentJob, InventoryTransfer, InventoryCount, BillPayment, GiftCard, InventoryBundle } from '../types';
import ContextualHelp from './ContextualHelp';

const Inventory: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('inventory');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddProductModalOpen, setIsAddProductModalOpen] = useState(false);

  // Mock Data
  const [products] = useState<Product[]>([
    { id: '1', name: 'iPhone 14 Pro Screen (OEM)', category: 'Screens', price: 189.00, costPrice: 65.00, stock: 12, sku: 'SCR-IP14P', type: 'non-serialized', manufacturer: 'Apple', minStockLevel: 5 },
    { id: '2', name: 'iPhone 13 Battery (High Cap)', category: 'Batteries', price: 35.00, costPrice: 8.00, stock: 3, sku: 'BAT-IP13', type: 'non-serialized', manufacturer: 'Apple', minStockLevel: 10 },
    { id: '3', name: 'MacBook Air M1 Logic Board', category: 'Logic Boards', price: 499.00, costPrice: 320.00, stock: 2, sku: 'BRD-MBA-M1', type: 'serialized', manufacturer: 'Apple', minStockLevel: 1 },
    { id: '4', name: 'USB-C to USB-C Cable 2m', category: 'Accessories', price: 19.00, costPrice: 4.50, stock: 45, sku: 'ACC-USBC-2M', type: 'non-serialized', manufacturer: 'Generic', minStockLevel: 20 },
    { id: '5', name: 'Samsung S23 Ultra Screen', category: 'Screens', price: 299.00, costPrice: 145.00, stock: 4, sku: 'SCR-S23U', type: 'non-serialized', manufacturer: 'Samsung', minStockLevel: 5 },
  ]);

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
    { id: 'trade-in', label: 'Trade-In', icon: 'swap_horiz' },
    { id: 'refurb', label: 'Refurbishment', icon: 'build_circle' },
    { id: 'transfer', label: 'Transfers', icon: 'local_shipping' },
    { id: 'count', label: 'Stock Count', icon: 'checklist' },
    { id: 'bills', label: 'Bill Payments', icon: 'payments' },
    { id: 'giftcards', label: 'Gift Cards', icon: 'card_giftcard' },
    { id: 'bundles', label: 'Bundles', icon: 'inventory' },
  ];

  const filteredProducts = products.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    p.sku.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderInventory = () => (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="relative w-full md:w-96">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">search</span>
          <input
            type="text"
            placeholder="Search products, SKU, UPC..."
            className="w-full pl-12 pr-4 py-3 bg-white/50 backdrop-blur-md border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-3 w-full md:w-auto">
          <button className="flex-1 md:flex-none px-6 py-3 bg-white border border-slate-200 text-primary font-black text-xs rounded-2xl hover:bg-slate-50 transition-all uppercase tracking-widest flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">category</span>
            Categories
          </button>
          <button className="flex-1 md:flex-none px-6 py-3 bg-white border border-slate-200 text-primary font-black text-xs rounded-2xl hover:bg-slate-50 transition-all uppercase tracking-widest flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">file_download</span>
            Export
          </button>
          <button 
            onClick={() => setIsAddProductModalOpen(true)}
            className="flex-1 md:flex-none px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Add Product
          </button>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Product Details</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">SKU / UPC</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Price</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Stock</th>
                <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((product) => (
                <tr key={product.id} className="group hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center relative">
                        <span className="material-symbols-outlined text-slate-400">
                          {product.type === 'serialized' ? 'qr_code_2' : 'inventory_2'}
                        </span>
                        {product.images && product.images.length > 0 && (
                          <img src={product.images[0]} className="absolute inset-0 w-full h-full object-cover rounded-xl" alt="" />
                        )}
                      </div>
                      <div>
                        <p className="font-bold text-slate-900">{product.name}</p>
                        <div className="flex items-center gap-2">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{product.manufacturer}</p>
                          {product.attributes && Object.entries(product.attributes).map(([k, v]) => (
                            <span key={k} className="text-[8px] font-black bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase">{v}</span>
                          ))}
                        </div>
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
                    <p className="font-mono text-[10px] text-slate-300">{product.upc || 'NO UPC'}</p>
                  </td>
                  <td className="px-8 py-6">
                    <p className="font-black text-primary">${product.price.toFixed(2)}</p>
                    <p className="text-[10px] text-slate-400 font-bold">Cost: ${product.costPrice?.toFixed(2)}</p>
                  </td>
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 bg-slate-100 h-1.5 rounded-full overflow-hidden w-24">
                        <div 
                          className={`h-full transition-all duration-500 ${product.stock <= (product.minStockLevel || 0) ? 'bg-orange-500' : 'bg-lime-500'}`} 
                          style={{ width: `${Math.min((product.stock / ((product.minStockLevel || 1) * 3)) * 100, 100)}%` }}
                        ></div>
                      </div>
                      <span className={`text-sm font-black ${product.stock <= (product.minStockLevel || 0) ? 'text-orange-600' : 'text-primary'}`}>
                        {product.stock}
                      </span>
                    </div>
                  </td>
                  <td className="px-8 py-6 text-right">
                    <div className="flex justify-end gap-2">
                      <button className="p-2 hover:bg-white rounded-xl transition-all text-slate-400 hover:text-primary" title="Edit Product">
                        <span className="material-symbols-outlined text-sm">edit</span>
                      </button>
                      <button className="p-2 hover:bg-white rounded-xl transition-all text-slate-400 hover:text-primary" title="Print Barcode">
                        <span className="material-symbols-outlined text-sm">print</span>
                      </button>
                      <button className="p-2 hover:bg-white rounded-xl transition-all text-slate-400 hover:text-orange-500" title="Inventory Adjustment">
                        <span className="material-symbols-outlined text-sm">tune</span>
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
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
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
              <button className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
                Refurbish
              </button>
              <button className="flex-1 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-black text-[10px] rounded-xl uppercase tracking-widest transition-all">
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
                  <button className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 transition-all">
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
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
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
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
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
            <button className="w-full mt-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl uppercase tracking-widest hover:bg-primary/90 transition-all">
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
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
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
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
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
        <button className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2">
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
              className="bg-white rounded-[3rem] shadow-2xl w-full max-w-4xl overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h2 className="text-2xl font-black text-primary tracking-tight">Add New Product</h2>
                  <p className="text-slate-500 text-sm font-medium">Enter product details to add to inventory.</p>
                </div>
                <button 
                  onClick={() => setIsAddProductModalOpen(false)}
                  className="w-12 h-12 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary transition-all"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="p-8 grid grid-cols-2 gap-8 max-h-[60vh] overflow-y-auto">
                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Product Name</label>
                    <input type="text" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="e.g. iPhone 15 Screen" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Category</label>
                      <select className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                        <option>Screens</option>
                        <option>Batteries</option>
                        <option>Accessories</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Type</label>
                      <select className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold">
                        <option>Non-Serialized</option>
                        <option>Serialized</option>
                        <option>Handset</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">SKU</label>
                      <input type="text" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono text-sm font-bold" placeholder="AUTO-GENERATE" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">UPC / Barcode</label>
                      <input type="text" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono text-sm font-bold" placeholder="Scan Barcode" />
                    </div>
                  </div>
                </div>
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Cost Price</label>
                      <div className="relative">
                        <span className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                        <input type="number" className="w-full pl-10 pr-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="0.00" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Retail Price</label>
                      <div className="relative">
                        <span className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                        <input type="number" className="w-full pl-10 pr-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="0.00" />
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Initial Stock</label>
                      <input type="number" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="0" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Min Stock Level</label>
                      <input type="number" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="5" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Manufacturer</label>
                    <input type="text" className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold" placeholder="e.g. Apple" />
                  </div>
                </div>
              </div>
              <div className="p-8 bg-slate-50 border-t border-slate-100 flex justify-end gap-4">
                <button 
                  onClick={() => setIsAddProductModalOpen(false)}
                  className="px-8 py-4 bg-white border border-slate-200 text-slate-500 font-black text-xs rounded-2xl hover:bg-slate-100 transition-all uppercase tracking-widest"
                >
                  Cancel
                </button>
                <button className="px-8 py-4 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest">
                  Save Product
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Inventory;
