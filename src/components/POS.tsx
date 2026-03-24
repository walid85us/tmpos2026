import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  CartItem, 
  PaymentMethod, 
  Discount, 
  Shift, 
  HeldOrder, 
  Customer 
} from '../types';
import ContextualHelp from './ContextualHelp';

export const POS: React.FC = () => {
  // State
  const [cart, setCart] = useState<CartItem[]>([]);
  const [payments, setPayments] = useState<PaymentMethod[]>([
    { id: 'p1', method: 'Cash', amount: 0, icon: 'payments' },
    { id: 'p2', method: 'Card Terminal', amount: 0, icon: 'credit_card', detail: 'Awaiting Entry', locked: true }
  ]);
  const [discounts] = useState<Discount[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Advanced POS State
  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentUserPin, setCurrentUserPin] = useState('');

  // Modal States
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
  const [isHeldOrdersOpen, setIsHeldOrdersOpen] = useState(false);
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isSpecialPartModalOpen, setIsSpecialPartModalOpen] = useState(false);
  const [isAddItemModalOpen, setIsAddItemModalOpen] = useState(false);
  const [isRepairDetailsModalOpen, setIsRepairDetailsModalOpen] = useState(false);
  const [isCashInOutModalOpen, setIsCashInOutModalOpen] = useState(false);
  const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
  const [isPinModalOpen, setIsPinModalOpen] = useState(false);
  const [isAddInventoryModalOpen, setIsAddInventoryModalOpen] = useState(false);
  const [isWarrantyModalOpen, setIsWarrantyModalOpen] = useState(false);
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [isPreviousOrdersOpen, setIsPreviousOrdersOpen] = useState(false);
  const [isPatternLockOpen, setIsPatternLockOpen] = useState(false);
  const [isManufacturerModalOpen, setIsManufacturerModalOpen] = useState(false);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isEditItemModalOpen, setIsEditItemModalOpen] = useState(false);
  const [isCashDrawerOpen, setIsCashDrawerOpen] = useState(false);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);

  // Advanced Search & Filter
  const [searchCategory, setSearchCategory] = useState('All');
  const [searchManufacturer, setSearchManufacturer] = useState('All');

  // Editing Item State
  const [editingItem, setEditingItem] = useState<CartItem | null>(null);
  const [editPrice, setEditPrice] = useState(0);
  const [editQty, setEditQty] = useState(1);

  // Pending Repair State
  const [pendingRepairItem, setPendingRepairItem] = useState<CartItem | null>(null);
  const [repairDetails, setRepairDetails] = useState({
    imei: '',
    serialNumber: '',
    passcode: '',
    network: '',
    patternLock: '',
    customFields: {} as Record<string, string>
  });

  // Calculations
  const subtotal = cart.reduce((acc, item) => acc + item.price, 0);
  const discountTotal = discounts.reduce((acc, d) => {
    if (d.type === 'percent') return acc + (subtotal * (d.value / 100));
    return acc + d.value;
  }, 0);
  const total = Math.max(0, subtotal - discountTotal);
  const totalAllocated = payments.reduce((acc, p) => acc + p.amount, 0);
  const remaining = total - totalAllocated;
  const progress = total > 0 ? (totalAllocated / total) * 100 : 0;

  // Handlers
  const addItemToCart = (item: any) => {
    if (item.type === 'repair') {
      setPendingRepairItem(item);
      setIsRepairDetailsModalOpen(true);
      setIsAddItemModalOpen(false);
    } else {
      setCart([...cart, { ...item, id: `${item.id}-${Date.now()}` }]);
      setIsAddItemModalOpen(false);
    }
  };

  const finalizeRepairDetails = () => {
    if (pendingRepairItem) {
      if (!repairDetails.imei || !repairDetails.passcode || !repairDetails.network) {
        alert("IMEI, Passcode, and Network are mandatory for repair tickets.");
        return;
      }
      setCart([...cart, { 
        ...pendingRepairItem, 
        id: `${pendingRepairItem.id}-${Date.now()}`,
        ...repairDetails
      }]);
      setPendingRepairItem(null);
      setRepairDetails({
        imei: '',
        serialNumber: '',
        passcode: '',
        network: '',
        patternLock: '',
        customFields: {}
      });
      setIsRepairDetailsModalOpen(false);
    }
  };

  const handleAddDeposit = () => {
    const depositItem: CartItem = {
      id: `DEP-${Date.now()}`,
      name: 'Bench Fee / Deposit',
      description: 'Initial diagnostic fee',
      price: 25.00,
      icon: 'payments',
      type: 'deposit'
    };
    setCart([...cart, depositItem]);
  };

  const removeItem = (id: string) => setCart(cart.filter(i => i.id !== id));
  
  const removePayment = (id: string) => {
    setPayments(payments.map(p => p.id === id ? { ...p, amount: 0 } : p));
  };

  const handleHoldOrder = () => {
    if (cart.length === 0) return;
    const newHeldOrder: HeldOrder = {
      id: `HOLD-${Date.now()}`,
      customerName: selectedCustomer?.name || 'Walk-in Customer',
      items: [...cart],
      total,
      createdAt: new Date().toISOString()
    };
    setHeldOrders([...heldOrders, newHeldOrder]);
    setCart([]);
    setSelectedCustomer(null);
  };

  const resumeOrder = (order: HeldOrder) => {
    setCart(order.items);
    setHeldOrders(heldOrders.filter(o => o.id !== order.id));
    setIsHeldOrdersOpen(false);
  };

  const handleFinalize = async () => {
    if (!selectedCustomer) {
      alert("Customer information is mandatory for this transaction.");
      setIsCustomerModalOpen(true);
      return;
    }
    setIsProcessing(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    setIsProcessing(false);
    setIsSuccess(true);
    setCart([]);
    setPayments(payments.map(p => ({ ...p, amount: 0 })));
  };

  const handlePrintReceipt = () => {
    setIsPrintModalOpen(true);
    setTimeout(() => setIsPrintModalOpen(false), 3000);
  };

  const handleOpenCashDrawer = () => {
    setIsCashDrawerOpen(true);
    setTimeout(() => setIsCashDrawerOpen(false), 2000);
  };

  const handleEditItem = (item: CartItem) => {
    setEditingItem(item);
    setEditPrice(item.price);
    setEditQty(1); // Default Qty
    setIsEditItemModalOpen(true);
  };

  const saveEditedItem = () => {
    if (editingItem) {
      setCart(cart.map(i => i.id === editingItem.id ? { ...i, price: editPrice } : i));
      setIsEditItemModalOpen(false);
      setEditingItem(null);
    }
  };

  const handleQuickCheckIn = () => {
    const quickRepair: CartItem = {
      id: `QR-${Date.now()}`,
      name: 'Quick Check-in Repair',
      description: 'Standard diagnostic & repair',
      price: 0,
      icon: 'bolt',
      type: 'repair'
    };
    setPendingRepairItem(quickRepair);
    setIsRepairDetailsModalOpen(true);
  };

  const handlePinSubmit = (pin: string) => {
    if (pin === '1234') {
      setIsPinModalOpen(false);
      setCurrentUserPin('');
    }
  };

  return (
    <div className="space-y-8 relative">
      <AnimatePresence>
        {isSuccess && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-primary/20 backdrop-blur-sm p-4"
          >
            <div className="bg-white p-12 rounded-[3rem] shadow-2xl text-center max-w-md w-full ghost-border">
              <div className="w-24 h-24 bg-lime-400 text-teal-950 rounded-full flex items-center justify-center mx-auto mb-8 shadow-xl">
                <span className="material-symbols-outlined text-5xl" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
              </div>
              <h3 className="text-3xl font-black text-primary tracking-tight mb-2">Transaction Complete</h3>
              <p className="text-slate-500 font-medium mb-8">Receipt #TX-99210 has been sent to Alexander Wright.</p>
              <button 
                onClick={() => setIsSuccess(false)}
                className="w-full py-4 bg-primary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-transform"
              >
                New Transaction
              </button>
              <button 
                onClick={handlePrintReceipt}
                className="w-full mt-3 py-4 bg-slate-100 text-slate-600 rounded-2xl font-black uppercase tracking-widest hover:bg-slate-200 transition-all"
              >
                Print Receipt
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isPrintModalOpen && (
          <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] bg-slate-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4">
            <span className="material-symbols-outlined animate-spin">print</span>
            <span className="font-bold">Sending to Star Micronics TSP100...</span>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="flex items-end justify-between">
        <div className="flex items-center gap-6">
          <div>
            <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Transaction ID: #TRX-99210</span>
            <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Checkout & Tender</h2>
          </div>
          <div className="h-12 w-px bg-slate-200"></div>
          <button 
            onClick={() => setIsShiftModalOpen(true)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-all ${
              activeShift ? 'bg-lime-50 border-lime-200 text-lime-700' : 'bg-red-50 border-red-200 text-red-700'
            }`}
          >
            <span className="material-symbols-outlined text-lg">
              {activeShift ? 'lock_open' : 'lock'}
            </span>
            <div className="text-left">
              <p className="text-[10px] font-black uppercase tracking-widest leading-none">Register Shift</p>
              <p className="text-xs font-bold">{activeShift ? 'Shift Active' : 'Shift Closed'}</p>
            </div>
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsHeldOrdersOpen(true)}
            className="flex items-center gap-2 text-slate-500 bg-white border border-slate-200 px-4 py-2 rounded-xl hover:bg-slate-50 transition-all relative"
          >
            <span className="material-symbols-outlined text-sm">pause_circle</span>
            <span className="text-sm font-semibold">Held Orders</span>
            {heldOrders.length > 0 && (
              <span className="absolute -top-2 -right-2 w-5 h-5 bg-secondary text-white text-[10px] font-black flex items-center justify-center rounded-full border-2 border-white">
                {heldOrders.length}
              </span>
            )}
          </button>
          <button 
            onClick={() => setIsCustomerModalOpen(true)}
            className="flex items-center gap-2 text-slate-500 bg-slate-100 px-4 py-2 rounded-xl ghost-border hover:bg-slate-200 transition-all"
          >
            <span className="material-symbols-outlined text-sm">person</span>
            <span className="text-sm font-semibold">
              {selectedCustomer ? selectedCustomer.name : 'Select Customer'}
            </span>
            {selectedCustomer && (
              <span className="ml-2 px-2 py-0.5 bg-lime-100 text-lime-700 text-[9px] font-black rounded-full uppercase">
                {Math.floor(Math.random() * 500)} Points
              </span>
            )}
          </button>
          <button onClick={() => setIsSettingsModalOpen(true)} className="p-2 text-slate-400 hover:text-primary transition-colors">
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 lg:col-span-5 space-y-6">
          <section className="bg-white rounded-[1.5rem] p-6 ghost-border shadow-sm">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-sm font-extrabold uppercase tracking-widest text-slate-400">Order Summary</h3>
              <div className="flex gap-2">
                <button onClick={() => setIsSpecialPartModalOpen(true)} className="text-[10px] font-black text-secondary uppercase tracking-widest flex items-center gap-1 hover:bg-secondary/10 px-2 py-1 rounded-lg transition-colors">
                  <span className="material-symbols-outlined text-xs">inventory_2</span>
                  Special Part
                </button>
                <button onClick={() => setIsAddItemModalOpen(true)} className="text-[10px] font-black text-secondary uppercase tracking-widest flex items-center gap-1 hover:bg-secondary/10 px-2 py-1 rounded-lg transition-colors">
                  <span className="material-symbols-outlined text-xs">add_circle</span>
                  Add Item
                </button>
                <button onClick={handleQuickCheckIn} className="text-[10px] font-black text-secondary uppercase tracking-widest flex items-center gap-1 hover:bg-secondary/10 px-2 py-1 rounded-lg transition-colors">
                  <span className="material-symbols-outlined text-xs">bolt</span>
                  Quick Check-in
                </button>
                <button onClick={handleAddDeposit} className="text-[10px] font-black text-secondary uppercase tracking-widest flex items-center gap-1 hover:bg-secondary/10 px-2 py-1 rounded-lg transition-colors">
                  <span className="material-symbols-outlined text-xs">toll</span>
                  Deposit
                </button>
              </div>
            </div>
            
            <div className="space-y-4">
              <AnimatePresence>
                {cart.map((item) => (
                  <motion.div key={item.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="flex justify-between items-start group cursor-pointer" onClick={() => handleEditItem(item)}>
                    <div className="flex gap-4">
                      <div className="w-12 h-12 bg-slate-100 flex items-center justify-center rounded-xl text-primary group-hover:bg-secondary group-hover:text-white transition-all">
                        <span className="material-symbols-outlined">{item.icon}</span>
                      </div>
                      <div>
                        <p className="font-bold text-slate-900 leading-none group-hover:text-secondary transition-colors">{item.name}</p>
                        <p className="text-xs text-slate-500 mt-1">{item.description}</p>
                        {item.type === 'repair' && (
                          <div className="flex flex-wrap gap-2 mt-1.5">
                            {item.imei && <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase tracking-tighter">IMEI: {item.imei}</span>}
                            {item.serialNumber && <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase tracking-tighter">SN: {item.serialNumber}</span>}
                            {item.passcode && <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase tracking-tighter">PIN: {item.passcode}</span>}
                            {item.network && <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase tracking-tighter">NET: {item.network}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-primary">${item.price.toFixed(2)}</span>
                      <button onClick={(e) => { e.stopPropagation(); removeItem(item.id); }} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition-all">
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {cart.length === 0 && <div className="py-8 text-center text-slate-400 italic text-sm">Cart is empty</div>}
            </div>

            <div className="mt-8 pt-6 border-t border-dashed border-slate-200 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 font-medium">Subtotal</span>
                <span className="font-bold text-slate-900">${subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between items-center pt-3">
                <span className="text-lg font-black text-primary uppercase tracking-tighter">Total Amount</span>
                <span className="text-3xl font-black text-primary tracking-tighter">${total.toFixed(2)}</span>
              </div>
            </div>
          </section>

          <section className="bg-slate-900 rounded-[1.5rem] p-6 text-white shadow-xl shadow-teal-900/20">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xs font-black uppercase tracking-[0.2em] text-teal-400">Promotions & Loyalty</h3>
              <span className="material-symbols-outlined text-teal-400">loyalty</span>
            </div>
            <div className="space-y-4">
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-teal-400/50">confirmation_number</span>
                <input className="w-full bg-white/5 border-white/10 rounded-2xl pl-12 pr-4 py-4 text-sm font-bold focus:ring-secondary focus:bg-white/10 transition-all placeholder:text-white/20" placeholder="Enter Promo Code..." type="text" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button className="py-3 bg-white/5 hover:bg-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest border border-white/10 transition-all">Apply Discount</button>
                <button className="py-3 bg-teal-500 text-teal-950 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-teal-500/20 transition-all active:scale-95">Redeem Points</button>
              </div>
            </div>
          </section>
        </div>

        <div className="col-span-12 lg:col-span-7 space-y-6">
          <section className="bg-white rounded-[2rem] p-8 ghost-border shadow-sm flex flex-col h-full">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-sm font-extrabold uppercase tracking-widest text-slate-400">Payment Allocation</h3>
              <button className="text-[10px] font-black text-secondary uppercase tracking-widest flex items-center gap-1 hover:bg-secondary/10 px-2 py-1 rounded-lg transition-colors">
                <span className="material-symbols-outlined text-xs">add_card</span>
                Add Method
              </button>
            </div>

            <div className="flex-1 space-y-4">
              <AnimatePresence>
                {payments.map((p) => (
                  <motion.div key={p.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm">
                      <span className="material-symbols-outlined">{p.icon}</span>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-extrabold text-slate-900">{p.method}</p>
                        {p.detail && <span className="text-[10px] font-bold text-secondary">{p.detail}</span>}
                      </div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">{p.locked ? 'Automated Deduction' : 'User Applied'}</p>
                    </div>
                    <div className="w-32">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">$</span>
                        <input readOnly={p.locked} className={`w-full bg-white border-none rounded-lg pl-6 pr-3 py-1 text-sm font-black text-right focus:ring-secondary shadow-sm ${p.locked ? 'text-slate-400 cursor-not-allowed' : 'text-primary'}`} type="text" defaultValue={p.amount.toFixed(2)} />
                      </div>
                    </div>
                    <button disabled={p.locked} onClick={() => removePayment(p.id)} className={`${p.locked ? 'text-slate-300 cursor-not-allowed' : 'text-slate-300 hover:text-red-500 transition-colors'}`}>
                      <span className="material-symbols-outlined text-lg">{p.locked ? 'lock' : 'cancel'}</span>
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>

              <div className="p-6 bg-white border-2 border-dashed border-slate-200 rounded-2xl relative overflow-hidden">
                <div className="flex items-center justify-between mb-4">
                  <label className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <span className="material-symbols-outlined text-secondary">account_balance_wallet</span>
                    Redeem Store Credit
                  </label>
                </div>
                <div className="flex gap-4">
                  <input className="flex-1 bg-slate-50 border-none rounded-xl px-4 py-3 text-sm focus:ring-secondary shadow-inner" placeholder="Credit ID" type="text" />
                  <button className="bg-primary text-white px-6 py-3 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-teal-900/20">Verify</button>
                </div>
              </div>
            </div>

            <div className="mt-8 border-t border-dashed border-slate-200 pt-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <span className="text-sm font-bold text-slate-400 uppercase tracking-widest block">Tender Remaining</span>
                  <span className={`text-3xl font-black tracking-tighter transition-colors ${remaining <= 0 ? 'text-lime-600' : 'text-primary'}`}>
                    ${Math.max(0, remaining).toFixed(2)}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-sm font-bold text-secondary uppercase tracking-widest block">Allocated</span>
                  <span className="text-xl font-bold text-slate-900">${totalAllocated.toFixed(2)}</span>
                </div>
              </div>
              <div className="w-full bg-slate-100 h-4 rounded-full overflow-hidden mb-12 shadow-inner">
                <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, progress)}%` }} className={`h-full transition-all duration-500 shadow-lg ${progress >= 100 ? 'bg-lime-500' : 'bg-secondary'}`}></motion.div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <button disabled={remaining > 0 || isProcessing} onClick={handleFinalize} className={`py-6 rounded-2xl text-white font-black text-lg flex flex-col items-center justify-center gap-2 shadow-xl transition-all ${remaining <= 0 ? 'signature-gradient shadow-teal-900/30 active:scale-[0.98]' : 'bg-slate-300 cursor-not-allowed shadow-none'} ${isProcessing ? 'opacity-80' : ''}`}>
                  {isProcessing ? <span>PROCESSING...</span> : <span>FINALIZE SALE</span>}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setIsPinModalOpen(true)} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
                    <span className="material-symbols-outlined text-primary group-hover:scale-110 transition-transform">switch_account</span>
                    <span className="text-[10px] font-bold uppercase tracking-tighter">Switch User</span>
                  </button>
                  <button onClick={() => setIsRefundModalOpen(true)} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
                    <span className="material-symbols-outlined text-primary group-hover:scale-110 transition-transform">keyboard_return</span>
                    <span className="text-[10px] font-bold uppercase tracking-tighter">Refund</span>
                  </button>
                  <button onClick={() => setIsAddInventoryModalOpen(true)} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
                    <span className="material-symbols-outlined text-primary group-hover:scale-110 transition-transform">add_business</span>
                    <span className="text-[10px] font-bold uppercase tracking-tighter">Add Stock</span>
                  </button>
                  <button onClick={() => setIsWarrantyModalOpen(true)} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
                    <span className="material-symbols-outlined text-primary group-hover:scale-110 transition-transform">verified_user</span>
                    <span className="text-[10px] font-bold uppercase tracking-tighter">Warranty</span>
                  </button>
                  <button onClick={() => setIsPreviousOrdersOpen(true)} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
                    <span className="material-symbols-outlined text-primary group-hover:scale-110 transition-transform">receipt_long</span>
                    <span className="text-[10px] font-bold uppercase tracking-tighter">Orders</span>
                  </button>
                  <button onClick={handleHoldOrder} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
                    <span className="material-symbols-outlined text-primary group-hover:scale-110 transition-transform">history</span>
                    <span className="text-[10px] font-bold uppercase tracking-tighter">Hold Sale</span>
                  </button>
                  <button onClick={handleOpenCashDrawer} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
                    <span className="material-symbols-outlined text-primary group-hover:scale-110 transition-transform">point_of_sale</span>
                    <span className="text-[10px] font-bold uppercase tracking-tighter">Drawer</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {isSuccess && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-primary/20 backdrop-blur-sm p-4"
          >
            <div className="bg-white p-12 rounded-[3rem] shadow-2xl text-center max-w-md w-full ghost-border">
              <div className="w-24 h-24 bg-lime-400 text-teal-950 rounded-full flex items-center justify-center mx-auto mb-8 shadow-xl">
                <span className="material-symbols-outlined text-5xl" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
              </div>
              <h3 className="text-3xl font-black text-primary tracking-tight mb-2">Transaction Complete</h3>
              <p className="text-slate-500 font-medium mb-8">Receipt #TX-99210 has been sent to {selectedCustomer?.name || 'Customer'}.</p>
              <div className="space-y-3">
                <button 
                  onClick={() => { setIsSuccess(false); setSelectedCustomer(null); }}
                  className="w-full py-4 bg-primary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-transform"
                >
                  New Transaction
                </button>
                <button 
                  onClick={handlePrintReceipt}
                  className="w-full py-4 bg-slate-100 text-slate-600 rounded-2xl font-black uppercase tracking-widest hover:bg-slate-200 transition-all"
                >
                  Print Receipt
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {isCashDrawerOpen && (
          <motion.div initial={{ opacity: 0, y: 100 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 100 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] bg-teal-950 text-white px-10 py-6 rounded-[2rem] shadow-2xl flex items-center gap-6 border border-teal-800">
            <div className="w-12 h-12 bg-lime-400 text-teal-950 rounded-full flex items-center justify-center animate-bounce">
              <span className="material-symbols-outlined">point_of_sale</span>
            </div>
            <div>
              <p className="text-lg font-black tracking-tight">Cash Drawer Open</p>
              <p className="text-xs text-teal-400 font-bold uppercase tracking-widest">Security Protocol Active</p>
            </div>
          </motion.div>
        )}

        {isShiftModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Register Shift</h3>
                <button onClick={() => setIsShiftModalOpen(false)} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              {!activeShift ? (
                <div className="space-y-6">
                  <input className="w-full bg-slate-50 border-none rounded-2xl px-4 py-4 text-2xl font-black text-primary focus:ring-secondary" placeholder="Opening Balance" type="number" />
                  <button onClick={() => { setActiveShift({ id: 'S1', employeeId: 'E1', startTime: new Date().toISOString(), openingBalance: 150, status: 'Open' }); setIsShiftModalOpen(false); }} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all">Open Register</button>
                  <button onClick={() => setIsScheduleModalOpen(true)} className="w-full py-3 text-slate-400 text-xs font-bold uppercase tracking-widest hover:text-primary transition-colors">View Shift Schedule</button>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => setIsCashInOutModalOpen(true)} className="py-4 bg-slate-100 text-slate-600 rounded-2xl font-bold text-sm hover:bg-slate-200 transition-all flex flex-col items-center gap-1">
                      <span className="material-symbols-outlined">payments</span>
                      Cash In/Out
                    </button>
                    <button onClick={() => setIsExpenseModalOpen(true)} className="py-4 bg-slate-100 text-slate-600 rounded-2xl font-bold text-sm hover:bg-slate-200 transition-all flex flex-col items-center gap-1">
                      <span className="material-symbols-outlined">outbound</span>
                      Add Expense
                    </button>
                  </div>
                  <button onClick={() => { setActiveShift(null); setIsShiftModalOpen(false); }} className="w-full py-4 bg-red-500 text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all">Close Shift</button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}

        {isScheduleModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Shift Schedule</h3>
                <button onClick={() => setIsScheduleModalOpen(false)} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="space-y-4">
                {[
                  { day: 'Monday', shift: '09:00 AM - 05:00 PM', staff: 'Alexander W.' },
                  { day: 'Tuesday', shift: '09:00 AM - 05:00 PM', staff: 'Sarah J.' },
                  { day: 'Wednesday', shift: '10:00 AM - 06:00 PM', staff: 'Mike R.' },
                ].map((s, i) => (
                  <div key={i} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl">
                    <div>
                      <p className="font-black text-primary text-sm">{s.day}</p>
                      <p className="text-xs text-slate-500">{s.shift}</p>
                    </div>
                    <span className="text-[10px] font-black bg-white px-3 py-1 rounded-full border border-slate-100 text-slate-400 uppercase tracking-widest">{s.staff}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}

        {isEditItemModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[150] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Edit Cart Item</h3>
              <div className="space-y-6">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 block">Unit Price</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-black text-slate-300">$</span>
                    <input value={editPrice} onChange={(e) => setEditPrice(Number(e.target.value))} className="w-full bg-slate-50 border-none rounded-2xl pl-10 pr-4 py-4 text-2xl font-black text-primary focus:ring-secondary" type="number" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 block">Quantity</label>
                  <div className="flex items-center gap-4">
                    <button onClick={() => setEditQty(Math.max(1, editQty - 1))} className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center text-primary hover:bg-slate-200 transition-all"><span className="material-symbols-outlined">remove</span></button>
                    <span className="text-2xl font-black text-primary w-12 text-center">{editQty}</span>
                    <button onClick={() => setEditQty(editQty + 1)} className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center text-primary hover:bg-slate-200 transition-all"><span className="material-symbols-outlined">add</span></button>
                  </div>
                </div>
                <button onClick={saveEditedItem} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all">Update Item</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isExpenseModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[130] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Record Expense</h3>
              <div className="space-y-4">
                <input className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="Amount" type="number" />
                <select className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold">
                  <option>Rent</option>
                  <option>Utilities</option>
                  <option>Supplies</option>
                  <option>Marketing</option>
                  <option>Other</option>
                </select>
                <textarea className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-medium min-h-[80px]" placeholder="Description..."></textarea>
                <button onClick={() => setIsExpenseModalOpen(false)} className="w-full py-5 bg-primary text-white rounded-2xl font-black uppercase">Save Expense</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isWarrantyModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Warranty Claim</h3>
              <div className="space-y-6">
                <input className="w-full bg-slate-50 border-none rounded-2xl px-4 py-4 text-sm font-bold" placeholder="Invoice # or Serial #" type="text" />
                <textarea className="w-full bg-slate-50 border-none rounded-2xl px-4 py-4 text-sm font-medium min-h-[100px]" placeholder="Reason for claim..."></textarea>
                <button onClick={() => setIsWarrantyModalOpen(false)} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase">Process Claim</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isPreviousOrdersOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-4xl w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Previous Orders</h3>
                <button onClick={() => setIsPreviousOrdersOpen(false)} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                {[
                  { id: 'INV-1001', customer: 'Alexander Wright', date: '2026-03-19', total: 189.00, status: 'Paid' },
                  { id: 'INV-1002', customer: 'Sarah Jenkins', date: '2026-03-18', total: 45.50, status: 'Refunded' },
                ].map(order => (
                  <div key={order.id} className="flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100 hover:bg-white hover:shadow-lg transition-all">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-slate-900">{order.id}</p>
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded uppercase ${order.status === 'Paid' ? 'bg-lime-100 text-lime-700' : 'bg-red-100 text-red-700'}`}>{order.status}</span>
                      </div>
                      <p className="text-xs text-slate-500">{order.customer} • {order.date}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="font-black text-primary">${order.total.toFixed(2)}</p>
                      <button className="p-2 hover:bg-slate-100 rounded-lg transition-colors"><span className="material-symbols-outlined text-slate-400">print</span></button>
                      <button className="p-2 hover:bg-slate-100 rounded-lg transition-colors"><span className="material-symbols-outlined text-slate-400">visibility</span></button>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}

        {isAddItemModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-4xl w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Add Item</h3>
                <button onClick={() => setIsAddItemModalOpen(false)} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              
              <div className="flex gap-4 mb-8">
                <div className="flex-1 relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400">search</span>
                  <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-slate-50 border-none rounded-2xl pl-12 pr-4 py-4 text-sm font-bold focus:ring-secondary" placeholder="Search by name, SKU, or Serial..." type="text" />
                </div>
                <select value={searchCategory} onChange={(e) => setSearchCategory(e.target.value)} className="bg-slate-50 border-none rounded-2xl px-6 py-4 text-sm font-bold focus:ring-secondary">
                  <option>All Categories</option>
                  <option>Repairs</option>
                  <option>Accessories</option>
                  <option>Parts</option>
                </select>
                <button onClick={() => setIsManufacturerModalOpen(true)} className="bg-slate-100 px-4 rounded-2xl hover:bg-slate-200 transition-all">
                  <span className="material-symbols-outlined">factory</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4 max-h-[50vh] overflow-y-auto pr-2">
                {[
                  { id: 'p3', name: 'iPhone 13 Screen Repair', price: 189.00, icon: 'smartphone', type: 'repair', category: 'Repairs' },
                  { id: 'p4', name: 'USB-C Charging Cable', price: 19.99, icon: 'cable', type: 'product', category: 'Accessories' },
                  { id: 'p5', name: 'Samsung S21 Battery', price: 45.00, icon: 'battery_charging_full', type: 'product', category: 'Parts' },
                ].filter(i => 
                  (searchCategory === 'All Categories' || i.category === searchCategory) &&
                  i.name.toLowerCase().includes(searchQuery.toLowerCase())
                ).map((item) => (
                  <button key={item.id} onClick={() => addItemToCart(item)} className="flex items-center gap-4 p-4 bg-slate-50 hover:bg-white hover:shadow-xl rounded-2xl text-left transition-all group">
                    <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm group-hover:bg-secondary group-hover:text-white transition-all">
                      <span className="material-symbols-outlined">{item.icon}</span>
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">{item.name}</p>
                      <p className="text-xs text-secondary font-black">${item.price.toFixed(2)}</p>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-8 pt-8 border-t border-dashed border-slate-200">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Suggestive Sales</h4>
                <div className="flex gap-4">
                  {[
                    { name: 'Tempered Glass', price: 9.99 },
                    { name: 'Protective Case', price: 24.99 }
                  ].map((s, i) => (
                    <button key={i} className="flex items-center gap-3 px-4 py-2 bg-lime-50 rounded-xl border border-lime-100 hover:bg-lime-100 transition-all">
                      <span className="material-symbols-outlined text-lime-600 text-sm">add_shopping_cart</span>
                      <span className="text-xs font-bold text-lime-700">{s.name} - ${s.price}</span>
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isRepairDetailsModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Repair Intake Form</h3>
              <div className="grid grid-cols-2 gap-6 mb-8">
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Device Identity</label>
                    <input value={repairDetails.imei} onChange={(e) => setRepairDetails({...repairDetails, imei: e.target.value})} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="IMEI Number" type="text" />
                  </div>
                  <input value={repairDetails.serialNumber} onChange={(e) => setRepairDetails({...repairDetails, serialNumber: e.target.value})} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="Serial Number" type="text" />
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Security</label>
                    <input value={repairDetails.passcode} onChange={(e) => setRepairDetails({...repairDetails, passcode: e.target.value})} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="Passcode / PIN" type="text" />
                  </div>
                  <button onClick={() => setIsPatternLockOpen(true)} className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-sm">pattern</span>
                    {repairDetails.patternLock ? 'Pattern Saved' : 'Draw Pattern Lock'}
                  </button>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Network & Carrier</label>
                    <select value={repairDetails.network} onChange={(e) => setRepairDetails({...repairDetails, network: e.target.value})} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold">
                      <option value="">Select Network</option>
                      <option>Verizon</option>
                      <option>AT&T</option>
                      <option>T-Mobile</option>
                      <option>Unlocked</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Custom Fields</label>
                    <input className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold mb-2" placeholder="Color" type="text" />
                    <input className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="Condition" type="text" />
                  </div>
                </div>
              </div>
              <button onClick={finalizeRepairDetails} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-[0.2em] shadow-lg shadow-secondary/20 active:scale-95 transition-all">Finalize Intake</button>
            </motion.div>
          </motion.div>
        )}

        {isPatternLockOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[130] flex items-center justify-center bg-primary/90 backdrop-blur-xl p-4">
            <div className="text-center">
              <h3 className="text-2xl font-black text-white mb-12">Draw Pattern Lock</h3>
              <div className="grid grid-cols-3 gap-8 mb-12">
                {[...Array(9)].map((_, i) => (
                  <div key={i} className="w-6 h-6 bg-white/20 rounded-full border-2 border-white/40"></div>
                ))}
              </div>
              <button onClick={() => { setRepairDetails({...repairDetails, patternLock: 'SAVED'}); setIsPatternLockOpen(false); }} className="px-12 py-4 bg-lime-400 text-teal-950 rounded-2xl font-black uppercase tracking-widest">Save Pattern</button>
            </div>
          </motion.div>
        )}

        {isManufacturerModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[130] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Add Manufacturer</h3>
              <div className="space-y-4">
                <input className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="Manufacturer Name (e.g. Apple, Samsung)" type="text" />
                <button onClick={() => setIsManufacturerModalOpen(false)} className="w-full py-5 bg-primary text-white rounded-2xl font-black uppercase">Add Manufacturer</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isAddInventoryModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Quick Add Stock</h3>
              <div className="space-y-4">
                <input className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="Product Name" type="text" />
                <button onClick={() => setIsAddInventoryModalOpen(false)} className="w-full py-5 bg-primary text-white rounded-2xl font-black uppercase">Save</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isRefundModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Refund / Exchange</h3>
              <input className="w-full bg-slate-50 border-none rounded-2xl px-4 py-4 text-sm font-bold mb-6" placeholder="Invoice #" type="text" />
              <button onClick={() => setIsRefundModalOpen(false)} className="w-full py-4 bg-primary text-white rounded-2xl font-black uppercase">Search</button>
            </motion.div>
          </motion.div>
        )}

        {isCashInOutModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Cash Adjustment</h3>
              <div className="space-y-6">
                <input className="w-full bg-slate-50 border-none rounded-xl px-4 py-4 text-xl font-black text-primary" placeholder="Amount" type="number" />
                <textarea className="w-full bg-slate-50 border-none rounded-xl px-4 py-4 text-sm font-medium min-h-[100px]" placeholder="Reason..."></textarea>
                <button onClick={() => setIsCashInOutModalOpen(false)} className="w-full py-5 bg-primary text-white rounded-2xl font-black uppercase">Record</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isSpecialPartModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-lg w-full p-8 ghost-border">
              <h3 className="text-2xl font-black text-primary mb-8">Special Part Order</h3>
              <div className="space-y-6">
                <input className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold" placeholder="Part Name" type="text" />
                <button onClick={() => { setCart([...cart, { id: `SP-${Date.now()}`, name: 'Special Part Order', description: 'Non-catalogued item', price: 85.00, icon: 'inventory_2', type: 'special' }]); setIsSpecialPartModalOpen(false); }} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase">Add to Basket</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isCustomerModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Customer Management</h3>
                <button onClick={() => setIsCustomerModalOpen(false)} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="space-y-4">
                {[
                  { id: 'c1', name: 'Alexander Wright', phone: '555-0123' },
                  { id: 'c2', name: 'Sarah Jenkins', phone: '555-0456' },
                ].map((c) => (
                  <button key={c.id} onClick={() => { setSelectedCustomer(c as any); setIsCustomerModalOpen(false); }} className="w-full p-4 bg-slate-50 hover:bg-secondary hover:text-white rounded-2xl text-left transition-all">
                    <p className="font-bold">{c.name}</p>
                    <p className="text-xs opacity-60">{c.phone}</p>
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}

        {isSettingsModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[150] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">POS Configuration</h3>
                <button onClick={() => setIsSettingsModalOpen(false)} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="grid grid-cols-2 gap-8">
                <div className="space-y-4">
                  <h4 className="text-xs font-black uppercase tracking-widest text-slate-400">Repair Task Types</h4>
                  <div className="space-y-2">
                    {['Screen Replacement', 'Battery Swap', 'Charging Port', 'Water Damage'].map(t => (
                      <div key={t} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                        <span className="text-sm font-bold">{t}</span>
                        <span className="material-symbols-outlined text-slate-300 text-sm">drag_indicator</span>
                      </div>
                    ))}
                    <button className="w-full py-2 border-2 border-dashed border-slate-200 rounded-xl text-xs font-black text-slate-400 hover:border-secondary hover:text-secondary transition-all">+ Add Task Type</button>
                  </div>
                </div>
                <div className="space-y-4">
                  <h4 className="text-xs font-black uppercase tracking-widest text-slate-400">Repair Categories</h4>
                  <div className="space-y-2">
                    {['Smartphones', 'Tablets', 'Laptops', 'Consoles'].map(c => (
                      <div key={c} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                        <span className="text-sm font-bold">{c}</span>
                        <span className="material-symbols-outlined text-slate-300 text-sm">drag_indicator</span>
                      </div>
                    ))}
                    <button className="w-full py-2 border-2 border-dashed border-slate-200 rounded-xl text-xs font-black text-slate-400 hover:border-secondary hover:text-secondary transition-all">+ Add Category</button>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Customer Terminal Simulation */}
      <div className="fixed bottom-8 right-8 z-[100]">
        <div className="glass-panel ghost-border p-4 rounded-3xl shadow-2xl flex items-center gap-4 pr-6">
          <div className="w-12 h-12 bg-secondary rounded-2xl flex items-center justify-center text-white shadow-lg">
            <span className="material-symbols-outlined">qr_code_2</span>
          </div>
          <div>
            <p className="text-xs font-black text-primary uppercase tracking-widest">Customer Terminal</p>
            <p className="text-[11px] font-medium text-slate-500 leading-none">Awaiting Card Entry...</p>
          </div>
          <div className="ml-4 flex gap-1">
            <span className="w-1.5 h-1.5 bg-secondary rounded-full animate-pulse"></span>
            <span className="w-1.5 h-1.5 bg-secondary/40 rounded-full"></span>
            <span className="w-1.5 h-1.5 bg-secondary/40 rounded-full"></span>
          </div>
        </div>
      </div>

      <ContextualHelp 
        title="POS & Sales Guide"
        items={[
          { title: 'Processing Exchanges', description: 'Swap items in a single transaction by adding the new item and refunding the old one.', icon: 'swap_horiz' },
          { title: 'Returns & Refunds', description: 'Process full or partial refunds back to the original payment method or store credit.', icon: 'keyboard_return' },
          { title: 'Store Credit', description: 'Issue store credit for returns to encourage future purchases and maintain cash flow.', icon: 'account_balance_wallet' },
          { title: 'Shift Management', description: 'Open and close register shifts to track cash flow and employee accountability.', icon: 'lock_open' }
        ]}
        accentColor="secondary"
      />
    </div>
  );
};

export default POS;
