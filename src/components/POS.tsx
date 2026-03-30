import React, { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { 
  CartItem, 
  PaymentMethod, 
  Discount, 
  Shift, 
  HeldOrder, 
  Customer 
} from '../types';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import ContextualHelp from './ContextualHelp';

const TAX_RATE = 0.0825;

const PROMO_CODES: Record<string, { name: string; type: 'percent' | 'fixed'; value: number }> = {
  'SAVE10': { name: '10% Off (SAVE10)', type: 'percent', value: 10 },
  'SAVE20': { name: '20% Off (SAVE20)', type: 'percent', value: 20 },
  'FLAT5': { name: '$5 Off (FLAT5)', type: 'fixed', value: 5 },
  'FLAT15': { name: '$15 Off (FLAT15)', type: 'fixed', value: 15 },
  'VIP25': { name: '25% VIP Discount', type: 'percent', value: 25 },
};

const POINTS_VALUE_RATIO = 0.01;

export const POS: React.FC = () => {
  const location = useLocation();
  const { canAccess } = useAccess();
  const { customers: sharedCustomers, addCustomer, updateCustomer, stockItems: sharedStockItems, addStockItem, approvedStockItems, pendingStockItems, heldOrders, addHeldOrder, removeHeldOrder } = useStoreLocalState();
  const hasInventoryPermission = canAccess('inventory');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [payments, setPayments] = useState<PaymentMethod[]>([]);
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentUserPin, setCurrentUserPin] = useState('');
  const [repairValidationError, setRepairValidationError] = useState('');
  const [customerValidationError, setCustomerValidationError] = useState('');

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
  const [isDiscountModalOpen, setIsDiscountModalOpen] = useState(false);
  const [isRedeemPointsOpen, setIsRedeemPointsOpen] = useState(false);
  const [discountCode, setDiscountCode] = useState('');
  const [storeCreditId, setStoreCreditId] = useState('');
  const [storeCreditVerified, setStoreCreditVerified] = useState(false);

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

  const [holdToast, setHoldToast] = useState('');

  const [newCustMode, setNewCustMode] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [stockSaved, setStockSaved] = useState(false);

  const [redeemPointsAmount, setRedeemPointsAmount] = useState('');
  const [promoCodeError, setPromoCodeError] = useState('');
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositReason, setDepositReason] = useState('');
  const [isAddMethodModalOpen, setIsAddMethodModalOpen] = useState(false);
  const [specialPartName, setSpecialPartName] = useState('');
  const [specialPartPrice, setSpecialPartPrice] = useState('');
  const [addStockName, setAddStockName] = useState('');
  const [addStockSku, setAddStockSku] = useState('');
  const [addStockQty, setAddStockQty] = useState('1');
  const [addStockCost, setAddStockCost] = useState('');
  const [addStockPrice, setAddStockPrice] = useState('');
  const [addStockCategory, setAddStockCategory] = useState('Parts');
  const [addStockSuccess, setAddStockSuccess] = useState<string | null>(null);

  const locationHandled = useRef(false);
  useEffect(() => {
    if (locationHandled.current) return;
    const state = location.state as { autoQuickCheckIn?: boolean; openHeldOrders?: boolean; autoRepairItem?: CartItem; addToCart?: CartItem; resumeHeldOrderId?: string } | null;
    if (!state) return;
    if (state.autoQuickCheckIn) {
      locationHandled.current = true;
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
      window.history.replaceState({}, document.title);
    }
    if (state.openHeldOrders) {
      locationHandled.current = true;
      setIsHeldOrdersOpen(true);
      window.history.replaceState({}, document.title);
    }
    if (state.resumeHeldOrderId) {
      locationHandled.current = true;
      const order = heldOrders.find(o => o.id === state.resumeHeldOrderId);
      if (order) {
        resumeOrder(order);
      }
      window.history.replaceState({}, document.title);
    }
    if (state.autoRepairItem) {
      locationHandled.current = true;
      setCart(prev => [...prev, { ...state.autoRepairItem!, id: `${state.autoRepairItem!.id}-${Date.now()}` }]);
      window.history.replaceState({}, document.title);
    }
    if (state.addToCart) {
      locationHandled.current = true;
      setCart(prev => [...prev, { ...state.addToCart!, id: `SCAN-${Date.now()}` }]);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  const subtotal = cart.reduce((acc, item) => acc + item.price * (item.qty || 1), 0);
  const discountTotal = discounts.reduce((acc, d) => {
    if (d.type === 'percent') return acc + (subtotal * (d.value / 100));
    return acc + d.value;
  }, 0);
  const afterDiscount = Math.max(0, subtotal - discountTotal);
  const tax = afterDiscount * TAX_RATE;
  const total = parseFloat((afterDiscount + tax).toFixed(2));
  const manualAllocated = payments.filter(p => !p.locked).reduce((acc, p) => acc + p.amount, 0);
  const hasCardMethod = payments.some(p => p.locked);
  const cardAutoAmount = hasCardMethod ? Math.max(0, parseFloat((total - manualAllocated).toFixed(2))) : 0;
  const totalAllocated = parseFloat((manualAllocated + cardAutoAmount).toFixed(2));
  const remaining = parseFloat((total - totalAllocated).toFixed(2));
  const changeDue = totalAllocated > total && total > 0 ? parseFloat((totalAllocated - total).toFixed(2)) : 0;
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
        setRepairValidationError('IMEI, Passcode, and Network are mandatory for repair tickets.');
        return;
      }
      setRepairValidationError('');
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
    setDepositAmount('');
    setDepositReason('');
    setIsDepositModalOpen(true);
  };

  const confirmDeposit = () => {
    const amt = parseFloat(depositAmount) || 0;
    if (amt <= 0) return;
    const depositItem: CartItem = {
      id: `DEP-${Date.now()}`,
      name: 'Deposit',
      description: depositReason.trim() || 'Customer deposit',
      price: amt,
      icon: 'payments',
      type: 'deposit'
    };
    setCart([...cart, depositItem]);
    setIsDepositModalOpen(false);
    setDepositAmount('');
    setDepositReason('');
  };

  const removeItem = (id: string) => setCart(cart.filter(i => i.id !== id));
  
  const removePayment = (id: string) => {
    const p = payments.find(pm => pm.id === id);
    if (!p) return;
    setPayments(payments.filter(pm => pm.id !== id));
  };

  const handleHoldOrder = () => {
    if (cart.length === 0) return;
    const newHeldOrder: HeldOrder = {
      id: `HOLD-${Date.now()}`,
      customerName: selectedCustomer?.name || 'Walk-in Customer',
      items: [...cart],
      total,
      createdAt: new Date().toISOString(),
      payments: [...payments],
      discounts: [...discounts],
      customer: selectedCustomer,
    };
    addHeldOrder(newHeldOrder);
    setCart([]);
    setDiscounts([]);
    setSelectedCustomer(null);
    setPayments([]);
    setHoldToast('Order held successfully');
    setTimeout(() => setHoldToast(''), 3000);
  };

  const resumeOrder = (order: HeldOrder) => {
    setCart(order.items);
    setPayments(order.payments ?? []);
    setDiscounts(order.discounts ?? []);
    setSelectedCustomer(order.customer ?? null);
    removeHeldOrder(order.id);
    setIsHeldOrdersOpen(false);
  };

  const [finalTotal, setFinalTotal] = useState(0);
  const [finalTxId, setFinalTxId] = useState('');

  const handleFinalize = async () => {
    if (!selectedCustomer) {
      setCustomerValidationError('Customer information is mandatory for this transaction.');
      setIsCustomerModalOpen(true);
      return;
    }
    setCustomerValidationError('');
    setIsProcessing(true);
    const txId = `TX-${Date.now().toString().slice(-5)}`;
    setFinalTotal(total);
    setFinalTxId(txId);
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (selectedCustomer && selectedCustomer.id !== 'walk-in') {
      const pointsEarned = Math.floor(total * 10);
      const pointsRedeemed = discounts
        .filter(d => d.name.startsWith('Points Redemption'))
        .reduce((sum, d) => sum + Math.round(d.value / POINTS_VALUE_RATIO), 0);
      const currentPoints = selectedCustomer.loyaltyPoints ?? 0;
      const newPoints = Math.max(0, currentPoints - pointsRedeemed + pointsEarned);
      updateCustomer(selectedCustomer.id, {
        loyaltyPoints: newPoints,
        totalSpent: (selectedCustomer.totalSpent || 0) + total,
        lastVisit: new Date().toISOString().split('T')[0],
      });
      setSelectedCustomer(prev => prev ? { ...prev, loyaltyPoints: newPoints, totalSpent: (prev.totalSpent || 0) + total } : prev);
    }

    setIsProcessing(false);
    setIsSuccess(true);
    setCart([]);
    setDiscounts([]);
    setPayments([]);
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
    setEditQty(item.qty || 1);
    setIsEditItemModalOpen(true);
  };

  const saveEditedItem = () => {
    if (editingItem) {
      setCart(cart.map(i => i.id === editingItem.id ? { ...i, price: editPrice, qty: editQty } : i));
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

  const handleApplyDiscount = () => {
    if (discountCode.trim()) {
      const code = discountCode.trim().toUpperCase();
      const promo = PROMO_CODES[code];
      if (promo) {
        if (!discounts.some(d => d.name === promo.name)) {
          setDiscounts([...discounts, { id: `d-code-${Date.now()}`, name: promo.name, type: promo.type, value: promo.value }]);
          setDiscountCode('');
          return;
        }
      }
    }
    setIsDiscountModalOpen(true);
  };

  const handleRedeemPoints = () => {
    setIsRedeemPointsOpen(true);
  };

  const handleAddPaymentMethod = () => {
    setIsAddMethodModalOpen(true);
  };

  const addPaymentMethodByType = (type: 'Cash' | 'Card') => {
    const existing = payments.find(p => p.method === (type === 'Cash' ? 'Cash' : 'Card Terminal'));
    if (existing) {
      setIsAddMethodModalOpen(false);
      return;
    }
    const newMethod: PaymentMethod = type === 'Cash'
      ? { id: `p-cash-${Date.now()}`, method: 'Cash', amount: 0, icon: 'payments' }
      : { id: `p-card-${Date.now()}`, method: 'Card Terminal', amount: 0, icon: 'credit_card', detail: 'Terminal', locked: true };
    setPayments([...payments, newMethod]);
    setIsAddMethodModalOpen(false);
  };

  const handleVerifyStoreCredit = () => {
    if (storeCreditId.trim()) {
      setStoreCreditVerified(true);
      const creditMethod: PaymentMethod = {
        id: `sc-${Date.now()}`,
        method: 'Store Credit',
        amount: 0,
        icon: 'account_balance_wallet',
        detail: `Credit #${storeCreditId}`
      };
      setPayments([...payments, creditMethod]);
      setStoreCreditId('');
      setTimeout(() => setStoreCreditVerified(false), 2000);
    }
  };

  const handleAddSuggestiveItem = (name: string, price: number) => {
    const item: CartItem = {
      id: `SUG-${Date.now()}`,
      name,
      description: 'Suggestive sale item',
      price,
      icon: 'add_shopping_cart',
      type: 'product'
    };
    setCart([...cart, item]);
  };

  const handleAddTaskType = () => {
    // placeholder - shows confirmation visual
  };

  const handleAddCategory = () => {
    // placeholder - shows confirmation visual
  };

  return (
    <div className="space-y-8 relative">
      <AnimatePresence>
        {holdToast && (
          <motion.div initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }} className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] bg-teal-950 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4">
            <span className="material-symbols-outlined text-lime-400">pause_circle</span>
            <span className="font-bold">{holdToast}</span>
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
            {selectedCustomer && selectedCustomer.id !== 'walk-in' && (
              <span className="ml-2 px-2 py-0.5 bg-lime-100 text-lime-700 text-[9px] font-black rounded-full uppercase">
                {(selectedCustomer.loyaltyPoints ?? 0).toLocaleString()} pts
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
                      {(item.qty || 1) > 1 && <span className="text-xs text-slate-400 font-bold">×{item.qty}</span>}
                      <span className="font-bold text-primary">${(item.price * (item.qty || 1)).toFixed(2)}</span>
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
              {discountTotal > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-lime-600 font-medium flex items-center gap-1">
                    <span className="material-symbols-outlined text-xs">sell</span>
                    Discount
                  </span>
                  <span className="font-bold text-lime-600">-${discountTotal.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-slate-500 font-medium">Tax ({(TAX_RATE * 100).toFixed(2)}%)</span>
                <span className="font-bold text-slate-900">${tax.toFixed(2)}</span>
              </div>
              {discounts.length > 0 && (
                <div className="flex flex-wrap gap-1.5 py-1">
                  {discounts.map(d => (
                    <span key={d.id} className="inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 bg-lime-50 text-lime-700 rounded-full border border-lime-200 uppercase tracking-widest">
                      {d.name}
                      <button onClick={() => setDiscounts(discounts.filter(x => x.id !== d.id))} className="hover:text-red-500 transition-colors">
                        <span className="material-symbols-outlined" style={{ fontSize: '10px' }}>close</span>
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex justify-between items-center pt-3">
                <span className="text-lg font-black text-primary uppercase tracking-tighter">Total Amount</span>
                <span className="text-3xl font-black text-primary tracking-tighter">${total.toFixed(2)}</span>
              </div>
              {selectedCustomer && selectedCustomer.id !== 'walk-in' && total > 0 && (
                <div className="flex items-center gap-2 mt-2 p-2 bg-teal-50 rounded-xl border border-teal-100">
                  <span className="material-symbols-outlined text-teal-600 text-sm">stars</span>
                  <span className="text-[10px] font-black text-teal-700 uppercase tracking-widest">
                    Earns {Math.floor(total * 10).toLocaleString()} pts on this sale
                  </span>
                </div>
              )}
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
                <input value={discountCode} onChange={(e) => setDiscountCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') { handleApplyDiscount(); } }} className="w-full bg-white/5 border-white/10 rounded-2xl pl-12 pr-4 py-4 text-sm font-bold text-white focus:ring-secondary focus:bg-white/10 transition-all placeholder:text-white/20" placeholder="Enter Promo Code..." type="text" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={handleApplyDiscount} className="py-3 bg-white/5 hover:bg-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest border border-white/10 transition-all">Apply Discount</button>
                <button onClick={handleRedeemPoints} disabled={!selectedCustomer || selectedCustomer.id === 'walk-in' || (selectedCustomer.loyaltyPoints ?? 0) < 100} className="py-3 bg-teal-500 text-teal-950 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-teal-500/20 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed" title={!selectedCustomer ? 'Select a customer first' : (selectedCustomer.loyaltyPoints ?? 0) < 100 ? 'Minimum 100 points required' : ''}>Redeem Points</button>
              </div>
            </div>
          </section>
        </div>

        <div className="col-span-12 lg:col-span-7 space-y-6">
          <section className="bg-white rounded-[2rem] p-8 ghost-border shadow-sm flex flex-col h-full">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-sm font-extrabold uppercase tracking-widest text-slate-400">Payment Allocation</h3>
              <button onClick={handleAddPaymentMethod} className="text-[10px] font-black text-secondary uppercase tracking-widest flex items-center gap-1 hover:bg-secondary/10 px-2 py-1 rounded-lg transition-colors">
                <span className="material-symbols-outlined text-xs">add_card</span>
                Add Method
              </button>
            </div>

            <div className="flex-1 space-y-4">
              {payments.length === 0 && (
                <div className="py-8 text-center border-2 border-dashed border-slate-200 rounded-2xl">
                  <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                    <span className="material-symbols-outlined text-2xl text-slate-300">add_card</span>
                  </div>
                  <p className="text-sm font-bold text-slate-400">No payment methods added</p>
                  <p className="text-xs text-slate-300 mt-1">Use "Add Method" above to add Cash or Card</p>
                </div>
              )}
              <AnimatePresence>
                {payments.map((p) => (
                  <motion.div key={p.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm">
                      <span className="material-symbols-outlined">{p.icon}</span>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-extrabold text-slate-900">{p.method}</p>
                        {p.locked && <span className="text-[10px] font-bold text-secondary">Auto-calculated</span>}
                      </div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">{p.locked ? 'Covers exact remaining balance' : 'Manual entry'}</p>
                    </div>
                    <div className="w-32">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">$</span>
                        <input
                          disabled={p.locked}
                          className={`w-full bg-white border-none rounded-lg pl-6 pr-3 py-1 text-sm font-black text-right focus:ring-secondary shadow-sm ${p.locked ? 'text-slate-400 cursor-not-allowed bg-slate-50' : 'text-primary'}`}
                          type="number"
                          step="0.01"
                          min="0"
                          value={p.locked ? (cardAutoAmount || '') : (p.amount || '')}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            setPayments(payments.map(pm => pm.id === p.id ? { ...pm, amount: val } : pm));
                          }}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                    <button onClick={() => removePayment(p.id)} className="text-slate-300 hover:text-red-500 transition-colors">
                      <span className="material-symbols-outlined text-lg">cancel</span>
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
                  <input value={storeCreditId} onChange={(e) => setStoreCreditId(e.target.value)} className="flex-1 bg-slate-50 border-none rounded-xl px-4 py-3 text-sm focus:ring-secondary shadow-inner" placeholder="Credit ID" type="text" />
                  <button onClick={handleVerifyStoreCredit} className={`px-6 py-3 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-teal-900/20 transition-all ${storeCreditVerified ? 'bg-emerald-500 text-white' : 'bg-primary text-white'}`}>{storeCreditVerified ? 'Verified!' : 'Verify'}</button>
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
                  {changeDue > 0 && (
                    <span className="block text-sm font-black text-lime-600 mt-1">Change: ${changeDue.toFixed(2)}</span>
                  )}
                </div>
              </div>
              <div className="w-full bg-slate-100 h-4 rounded-full overflow-hidden mb-12 shadow-inner">
                <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, progress)}%` }} className={`h-full transition-all duration-500 shadow-lg ${progress >= 100 ? 'bg-lime-500' : 'bg-secondary'}`}></motion.div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <button disabled={remaining > 0.005 || isProcessing || cart.length === 0 || payments.length === 0} onClick={handleFinalize} className={`py-6 rounded-2xl text-white font-black text-lg flex flex-col items-center justify-center gap-2 shadow-xl transition-all ${remaining <= 0.005 && cart.length > 0 && payments.length > 0 ? 'signature-gradient shadow-teal-900/30 active:scale-[0.98]' : 'bg-slate-300 cursor-not-allowed shadow-none'} ${isProcessing ? 'opacity-80' : ''}`}>
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
              <p className="text-slate-500 font-medium mb-2">Receipt #{finalTxId} has been sent to {selectedCustomer?.name || 'Customer'}.</p>
              <p className="text-2xl font-black text-primary mb-8">${finalTotal.toFixed(2)}</p>
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

        {isHeldOrdersOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Held Orders</h3>
                <button onClick={() => setIsHeldOrdersOpen(false)} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              {heldOrders.length === 0 ? (
                <div className="py-12 text-center">
                  <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <span className="material-symbols-outlined text-3xl text-slate-300">pause_circle</span>
                  </div>
                  <p className="text-sm font-bold text-slate-400">No held orders</p>
                  <p className="text-xs text-slate-300 mt-1">Hold a sale to suspend it for later</p>
                </div>
              ) : (
                <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
                  {heldOrders.map(order => (
                    <div key={order.id} className="p-6 bg-slate-50 rounded-3xl border border-slate-100 hover:bg-white hover:shadow-lg transition-all">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-slate-900">{order.id}</p>
                            <span className="text-[9px] font-black px-2 py-0.5 rounded uppercase bg-amber-100 text-amber-700">Held</span>
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">{order.customerName} &bull; {new Date(order.createdAt).toLocaleString()}</p>
                        </div>
                        <p className="text-lg font-black text-primary">${order.total.toFixed(2)}</p>
                      </div>
                      <div className="flex flex-wrap gap-2 mb-4">
                        {order.items.map((item, idx) => (
                          <span key={idx} className="text-[10px] font-bold bg-white px-2 py-1 rounded-lg border border-slate-100 text-slate-600">{item.name}</span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => resumeOrder(order)} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2">
                          <span className="material-symbols-outlined text-sm">play_arrow</span>
                          Resume Sale
                        </button>
                        <button onClick={() => removeHeldOrder(order.id)} className="py-3 px-4 bg-slate-100 text-slate-500 rounded-xl hover:bg-red-50 hover:text-red-500 transition-all">
                          <span className="material-symbols-outlined text-sm">delete</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                {(() => {
                  const baseItems: { id: string; name: string; price: number; icon: string; type: 'repair' | 'product'; category: string; description: string; sku?: string; isExact?: boolean }[] = [
                    { id: 'svc-screen', name: 'iPhone 13 Screen Repair', price: 189.00, icon: 'smartphone', type: 'repair', category: 'Repairs', description: 'Screen replacement service' },
                    { id: 'svc-battery', name: 'Battery Replacement Service', price: 79.00, icon: 'battery_charging_full', type: 'repair', category: 'Repairs', description: 'Battery swap service' },
                    { id: 'svc-port', name: 'Charging Port Repair', price: 99.00, icon: 'electrical_services', type: 'repair', category: 'Repairs', description: 'Port replacement service' },
                  ];
                  const fromStock = approvedStockItems
                    .map(si => ({
                      id: si.id,
                      name: si.name,
                      price: si.price,
                      icon: si.category === 'Parts' ? 'build' : si.category === 'Accessories' ? 'cable' : 'inventory_2',
                      type: 'product' as const,
                      category: si.category,
                      description: `SKU: ${si.sku} · ${si.qty} in stock`,
                      sku: si.sku,
                    }));
                  const allItems = [...baseItems, ...fromStock];
                  const q = searchQuery.toLowerCase().trim();
                  const filtered = allItems.filter(i =>
                    (searchCategory === 'All Categories' || i.category === searchCategory) &&
                    (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || (i.sku && i.sku.toLowerCase().includes(q)))
                  );
                  if (q) {
                    const exact = filtered.filter(i => i.sku && i.sku.toLowerCase() === q).map(i => ({ ...i, isExact: true }));
                    const rest = filtered.filter(i => !(i.sku && i.sku.toLowerCase() === q));
                    return [...exact, ...rest];
                  }
                  return filtered;
                })().map((item) => (
                  <button key={item.id} onClick={() => addItemToCart(item)} className={`flex items-center gap-4 p-4 hover:bg-white hover:shadow-xl rounded-2xl text-left transition-all group ${item.isExact ? 'bg-teal-50 border-2 border-teal-200' : 'bg-slate-50'}`}>
                    <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm group-hover:bg-secondary group-hover:text-white transition-all">
                      <span className="material-symbols-outlined">{item.icon}</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-slate-900">{item.name}</p>
                        {item.isExact && <span className="text-[8px] font-black bg-teal-600 text-white px-1.5 py-0.5 rounded uppercase">Exact Match</span>}
                      </div>
                      <p className="text-xs text-secondary font-black">${item.price.toFixed(2)}</p>
                      <p className="text-[10px] text-slate-400">{item.description}</p>
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
                    <button key={i} onClick={() => handleAddSuggestiveItem(s.name, s.price)} className="flex items-center gap-3 px-4 py-2 bg-lime-50 rounded-xl border border-lime-100 hover:bg-lime-100 transition-all active:scale-95">
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
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Repair Intake Form</h3>
                <button onClick={() => { setIsRepairDetailsModalOpen(false); setPendingRepairItem(null); setRepairValidationError(''); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
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
              {repairValidationError && (
                <div className="flex items-center gap-2 p-3 bg-rose-50 border border-rose-200 rounded-xl mb-4">
                  <span className="material-symbols-outlined text-rose-500 text-sm">error</span>
                  <p className="text-xs font-bold text-rose-600">{repairValidationError}</p>
                </div>
              )}
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
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Quick Add Stock</h3>
                <button onClick={() => { setIsAddInventoryModalOpen(false); setAddStockSuccess(null); setAddStockName(''); setAddStockSku(''); setAddStockQty('1'); setAddStockCost(''); setAddStockPrice(''); setAddStockCategory('Parts'); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              {addStockSuccess ? (
                <div className="py-8 text-center space-y-4">
                  <div className="w-16 h-16 bg-lime-100 rounded-full flex items-center justify-center mx-auto">
                    <span className="material-symbols-outlined text-3xl text-lime-600" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                  </div>
                  <p className="text-lg font-black text-primary">{addStockSuccess}</p>
                  <p className="text-xs text-slate-500">{approvedStockItems.length} approved item{approvedStockItems.length !== 1 ? 's' : ''} in inventory{pendingStockItems.length > 0 ? ` · ${pendingStockItems.length} pending approval` : ''}</p>
                  <button onClick={() => { setIsAddInventoryModalOpen(false); setAddStockSuccess(null); setAddStockName(''); setAddStockSku(''); setAddStockQty('1'); setAddStockCost(''); setAddStockPrice(''); setAddStockCategory('Parts'); }} className="px-8 py-3 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest">Done</button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Product Name *</label>
                    <input value={addStockName} onChange={(e) => setAddStockName(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="iPhone 13 Screen" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">SKU</label>
                      <input value={addStockSku} onChange={(e) => setAddStockSku(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="IP13-SCR-001" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Quantity</label>
                      <input value={addStockQty} onChange={(e) => setAddStockQty(e.target.value)} type="number" min="1" className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Cost Price</label>
                      <input value={addStockCost} onChange={(e) => setAddStockCost(e.target.value)} type="number" step="0.01" className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="0.00" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Sell Price</label>
                      <input value={addStockPrice} onChange={(e) => setAddStockPrice(e.target.value)} type="number" step="0.01" className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="0.00" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Category</label>
                      <select value={addStockCategory} onChange={(e) => setAddStockCategory(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary">
                        <option>Parts</option>
                        <option>Accessories</option>
                        <option>Devices</option>
                        <option>Other</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <button type="button" disabled={!addStockName.trim()} onClick={() => {
                      const price = parseFloat(addStockPrice) || 0;
                      setCart(prev => [...prev, {
                        id: `QADD-${Date.now()}`,
                        name: addStockName.trim(),
                        description: addStockSku ? `SKU: ${addStockSku}` : 'Quick add item',
                        price,
                        icon: 'add_shopping_cart',
                        type: 'product' as const,
                      }]);
                      setIsAddInventoryModalOpen(false);
                      setAddStockName(''); setAddStockSku(''); setAddStockQty('1'); setAddStockCost(''); setAddStockPrice(''); setAddStockCategory('Parts');
                    }} className="py-4 bg-slate-100 text-slate-700 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all flex flex-col items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
                      <span className="material-symbols-outlined text-sm">add_shopping_cart</span>
                      Add to Cart
                    </button>
                    {hasInventoryPermission ? (
                      <button type="button" disabled={!addStockName.trim()} onClick={() => {
                        const price = parseFloat(addStockPrice) || 0;
                        const cost = parseFloat(addStockCost) || 0;
                        addStockItem({
                          id: `stk-${Date.now()}`,
                          name: addStockName.trim(),
                          sku: addStockSku || `SKU-${Date.now().toString().slice(-6)}`,
                          qty: parseInt(addStockQty) || 1,
                          cost,
                          price,
                          category: addStockCategory,
                          addedAt: new Date().toISOString(),
                          status: 'approved',
                        });
                        setAddStockSuccess('Added to Inventory');
                      }} className="py-4 bg-primary text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg active:scale-95 transition-all flex flex-col items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
                        <span className="material-symbols-outlined text-sm">inventory_2</span>
                        Add to Inventory
                      </button>
                    ) : (
                      <button type="button" disabled={!addStockName.trim()} onClick={() => {
                        const price = parseFloat(addStockPrice) || 0;
                        const cost = parseFloat(addStockCost) || 0;
                        addStockItem({
                          id: `stk-${Date.now()}`,
                          name: addStockName.trim(),
                          sku: addStockSku || `SKU-${Date.now().toString().slice(-6)}`,
                          qty: parseInt(addStockQty) || 1,
                          cost,
                          price,
                          category: addStockCategory,
                          addedAt: new Date().toISOString(),
                          status: 'pending_approval',
                        });
                        setAddStockSuccess('Submitted for Approval');
                      }} className="py-4 bg-amber-500 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg active:scale-95 transition-all flex flex-col items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
                        <span className="material-symbols-outlined text-sm">pending_actions</span>
                        Submit for Approval
                      </button>
                    )}
                  </div>
                  <p className="text-[9px] text-center text-slate-400">{hasInventoryPermission ? '"Add to Cart" adds to order only. "Add to Inventory" makes it immediately available in POS.' : '"Add to Cart" adds to order only. "Submit for Approval" sends to manager for review.'}</p>
                </div>
              )}
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
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Special Part Order</h3>
                <button onClick={() => { setIsSpecialPartModalOpen(false); setSpecialPartName(''); setSpecialPartPrice(''); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Part Name *</label>
                  <input value={specialPartName} onChange={(e) => setSpecialPartName(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="e.g. Samsung S22 Flex Cable" type="text" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Price</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-black text-slate-300">$</span>
                    <input value={specialPartPrice} onChange={(e) => setSpecialPartPrice(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl pl-8 pr-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="0.00" type="number" step="0.01" min="0" />
                  </div>
                </div>
                <p className="text-[9px] text-slate-400 ml-4">Non-catalogued item — will appear in Order Summary</p>
                <button
                  disabled={!specialPartName.trim()}
                  onClick={() => {
                    setCart([...cart, {
                      id: `SP-${Date.now()}`,
                      name: specialPartName.trim(),
                      description: 'Non-catalogued item',
                      price: parseFloat(specialPartPrice) || 0,
                      icon: 'inventory_2',
                      type: 'special'
                    }]);
                    setIsSpecialPartModalOpen(false);
                    setSpecialPartName('');
                    setSpecialPartPrice('');
                  }}
                  className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >Add to Order</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isCustomerModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-black text-primary tracking-tight">Customer Management</h3>
                <button onClick={() => { setIsCustomerModalOpen(false); setNewCustMode(false); setCustomerSearch(''); }} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              {customerValidationError && (
                <div className="flex items-center gap-2 p-3 bg-rose-50 border border-rose-200 rounded-xl mb-4">
                  <span className="material-symbols-outlined text-rose-500 text-sm">error</span>
                  <p className="text-xs font-bold text-rose-600">{customerValidationError}</p>
                </div>
              )}

              {!newCustMode ? (
                <div className="space-y-4">
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400 text-sm">search</span>
                    <input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} className="w-full bg-slate-50 border-none rounded-2xl pl-11 pr-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="Search customers..." />
                  </div>

                  <button onClick={() => { setSelectedCustomer({ id: 'walk-in', name: 'Walk-in Customer', email: '', phone: '', totalSpent: 0, lastVisit: '' }); setCustomerValidationError(''); setIsCustomerModalOpen(false); }} className="w-full p-4 bg-slate-100 hover:bg-slate-200 rounded-2xl text-left transition-all flex items-center gap-3">
                    <div className="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center">
                      <span className="material-symbols-outlined text-slate-500">person_outline</span>
                    </div>
                    <div>
                      <p className="font-bold text-slate-700">Walk-in Customer</p>
                      <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">No customer record needed</p>
                    </div>
                  </button>

                  <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                    {sharedCustomers.filter(c => c.name.toLowerCase().includes(customerSearch.toLowerCase()) || c.phone.includes(customerSearch)).map((c) => (
                      <button key={c.id} onClick={() => { setSelectedCustomer(c); setCustomerValidationError(''); setIsCustomerModalOpen(false); setCustomerSearch(''); }} className="w-full p-4 bg-slate-50 hover:bg-secondary hover:text-white rounded-2xl text-left transition-all group">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-bold">{c.name}</p>
                            <p className="text-xs opacity-60">{c.phone} &bull; {c.email}</p>
                          </div>
                          <span className="material-symbols-outlined text-slate-300 group-hover:text-white/60">chevron_right</span>
                        </div>
                      </button>
                    ))}
                  </div>

                  <button onClick={() => setNewCustMode(true)} className="w-full py-3 border-2 border-dashed border-slate-200 rounded-2xl text-xs font-black text-secondary uppercase tracking-widest hover:border-secondary hover:bg-secondary/5 transition-all flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-sm">person_add</span>
                    Create New Customer
                  </button>
                </div>
              ) : (
                <form onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const newCust: Customer = {
                    id: `c-${Date.now()}`,
                    name: `${fd.get('firstName')} ${fd.get('lastName')}`,
                    phone: fd.get('phone') as string || '',
                    email: fd.get('email') as string || '',
                    totalSpent: 0,
                    lastVisit: '',
                    loyaltyPoints: 0,
                  };
                  addCustomer(newCust);
                  setSelectedCustomer(newCust);
                  setCustomerValidationError('');
                  setNewCustMode(false);
                  setIsCustomerModalOpen(false);
                }} className="space-y-4">
                  <button type="button" onClick={() => setNewCustMode(false)} className="text-xs font-bold text-secondary flex items-center gap-1 hover:underline">
                    <span className="material-symbols-outlined text-sm">arrow_back</span>
                    Back to search
                  </button>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">First Name</label>
                      <input name="firstName" required className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 text-sm" placeholder="John" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Last Name</label>
                      <input name="lastName" required className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 text-sm" placeholder="Doe" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Phone</label>
                    <input name="phone" className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 text-sm" placeholder="555-0000" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Email</label>
                    <input name="email" type="email" className="w-full px-4 py-3 bg-slate-50 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 text-sm" placeholder="john@example.com" />
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button type="button" onClick={() => setNewCustMode(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-colors">Cancel</button>
                    <button type="submit" className="flex-1 py-3 bg-secondary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-all">Create & Select</button>
                  </div>
                </form>
              )}
            </motion.div>
          </motion.div>
        )}

        {isDiscountModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[150] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Apply Discount</h3>
                <button onClick={() => { setIsDiscountModalOpen(false); setPromoCodeError(''); setDiscountCode(''); }} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Promo Code</label>
                  <input value={discountCode} onChange={(e) => { setDiscountCode(e.target.value.toUpperCase()); setPromoCodeError(''); }} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="e.g. SAVE10, FLAT5, VIP25" />
                  {promoCodeError && (
                    <p className="text-xs font-bold text-rose-500 ml-4 flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">error</span>
                      {promoCodeError}
                    </p>
                  )}
                  <p className="text-[10px] text-slate-400 ml-4">Valid codes: SAVE10, SAVE20, FLAT5, FLAT15, VIP25</p>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[5, 10, 15].map(pct => (
                    <button key={pct} onClick={() => {
                      setDiscounts([...discounts, { id: `d-${Date.now()}-${pct}`, name: `${pct}% Off`, type: 'percent', value: pct }]);
                      setIsDiscountModalOpen(false); setDiscountCode(''); setPromoCodeError('');
                    }} className="py-3 bg-slate-50 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 hover:bg-primary hover:text-white transition-all">{pct}% Off</button>
                  ))}
                </div>
                <button onClick={() => {
                  const code = discountCode.trim().toUpperCase();
                  if (!code) return;
                  const promo = PROMO_CODES[code];
                  if (!promo) {
                    setPromoCodeError(`"${code}" is not a valid promo code.`);
                    return;
                  }
                  if (discounts.some(d => d.name === promo.name)) {
                    setPromoCodeError('This code has already been applied.');
                    return;
                  }
                  setDiscounts([...discounts, { id: `d-code-${Date.now()}`, name: promo.name, type: promo.type, value: promo.value }]);
                  setIsDiscountModalOpen(false); setDiscountCode(''); setPromoCodeError('');
                }} disabled={!discountCode.trim()} className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">Apply Code</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isRedeemPointsOpen && (() => {
          const availablePoints = selectedCustomer?.loyaltyPoints ?? 0;
          const maxCreditValue = availablePoints * POINTS_VALUE_RATIO;
          const pointsNum = parseInt(redeemPointsAmount) || 0;
          const creditValue = Math.min(pointsNum, availablePoints) * POINTS_VALUE_RATIO;
          const pointsValid = pointsNum >= 100 && pointsNum <= availablePoints;
          const alreadyRedeemed = discounts.some(d => d.name.startsWith('Points Redemption'));
          return (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[150] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Redeem Points</h3>
                <button onClick={() => { setIsRedeemPointsOpen(false); setRedeemPointsAmount(''); }} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>
              <div className="space-y-6">
                <div className="p-6 bg-teal-50 rounded-2xl border border-teal-100 text-center">
                  <span className="text-[10px] font-black text-teal-600 uppercase tracking-widest block mb-1">{selectedCustomer?.name}</span>
                  <span className="text-[10px] font-black text-teal-600 uppercase tracking-widest block mb-2">Available Points</span>
                  <span className="text-4xl font-black text-teal-700">{availablePoints.toLocaleString()}</span>
                  <p className="text-xs text-teal-500 mt-1">= ${maxCreditValue.toFixed(2)} credit value (1pt = ${POINTS_VALUE_RATIO})</p>
                  <p className="text-[10px] text-teal-400 mt-1">Minimum 100 points to redeem</p>
                </div>
                {alreadyRedeemed ? (
                  <div className="p-4 bg-amber-50 rounded-2xl border border-amber-200 text-center">
                    <p className="text-sm font-bold text-amber-700">Points already redeemed on this order.</p>
                    <p className="text-xs text-amber-500 mt-1">Remove the existing points discount to redeem a different amount.</p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Points to Redeem (min 100)</label>
                      <input type="number" min="100" max={availablePoints} step="50" value={redeemPointsAmount} onChange={(e) => setRedeemPointsAmount(e.target.value)} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder={`100 – ${availablePoints.toLocaleString()}`} />
                      {pointsNum > 0 && (
                        <p className="text-xs font-bold text-teal-600 ml-4">{pointsValid ? `= $${creditValue.toFixed(2)} discount` : pointsNum < 100 ? 'Minimum 100 points required' : `Max ${availablePoints.toLocaleString()} points`}</p>
                      )}
                    </div>
                    <button onClick={() => {
                      if (pointsValid) {
                        setDiscounts([...discounts, { id: `d-pts-${Date.now()}`, name: `Points Redemption (${pointsNum.toLocaleString()}pts)`, type: 'fixed', value: creditValue }]);
                        setIsRedeemPointsOpen(false);
                        setRedeemPointsAmount('');
                      }
                    }} disabled={!pointsValid} className="w-full py-4 bg-teal-600 text-white font-black text-sm rounded-2xl shadow-lg shadow-teal-600/20 uppercase tracking-widest hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed">Apply ${creditValue.toFixed(2)} Discount</button>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
          );
        })()}

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

        {isDepositModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[150] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Add Deposit</h3>
                <button onClick={() => setIsDepositModalOpen(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Deposit Amount *</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-black text-slate-300">$</span>
                    <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} className="w-full bg-slate-50 border-none rounded-2xl pl-10 pr-4 py-4 text-2xl font-black text-primary focus:ring-secondary" placeholder="0.00" type="number" step="0.01" min="0.01" autoFocus />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Description / Reason</label>
                  <input value={depositReason} onChange={(e) => setDepositReason(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary" placeholder="e.g. Bench fee, diagnostic deposit" type="text" />
                </div>
                <button onClick={confirmDeposit} disabled={!depositAmount || parseFloat(depositAmount) <= 0} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed">Add to Order</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isAddMethodModalOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[150] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-sm w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Add Payment Method</h3>
                <button onClick={() => setIsAddMethodModalOpen(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="space-y-3">
                <button onClick={() => addPaymentMethodByType('Cash')} className="w-full p-4 bg-slate-50 hover:bg-primary hover:text-white rounded-2xl text-left transition-all group flex items-center gap-4">
                  <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm group-hover:bg-white/20 group-hover:text-white transition-all">
                    <span className="material-symbols-outlined">payments</span>
                  </div>
                  <div>
                    <p className="font-bold text-sm">Cash</p>
                    <p className="text-[10px] opacity-60">Manual cash payment</p>
                  </div>
                </button>
                <button onClick={() => addPaymentMethodByType('Card')} className="w-full p-4 bg-slate-50 hover:bg-primary hover:text-white rounded-2xl text-left transition-all group flex items-center gap-4">
                  <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm group-hover:bg-white/20 group-hover:text-white transition-all">
                    <span className="material-symbols-outlined">credit_card</span>
                  </div>
                  <div>
                    <p className="font-bold text-sm">Credit / Debit Card</p>
                    <p className="text-[10px] opacity-60">Card terminal processing</p>
                  </div>
                </button>
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
