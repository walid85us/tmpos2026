import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { useStoreLocalState, SEED_POS_OPERATORS, type CompletedOrder, type CompletedOrderItem } from '../context/StoreLocalState';
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
  const { canAccess, session } = useAccess();
  const { customers: sharedCustomers, addCustomer, updateCustomer, stockItems: sharedStockItems, addStockItem, updateStockItem: updateStockItemCtx, approvedStockItems, pendingStockItems, heldOrders, addHeldOrder, removeHeldOrder, suggestiveSalesItems, addSuggestiveSaleItem, removeSuggestiveSaleItem, draftCart, setDraftCart, clearDraftCart, completedOrders, addCompletedOrder, updateCompletedOrder, refundRecords, addRefundRecord, warrantyClaims, addWarrantyClaim, posOperator, setPosOperator } = useStoreLocalState();
  const derivedSuggestiveItems = approvedStockItems.filter(s => s.isSuggestiveSale).map(s => ({ id: s.id, name: s.name, price: s.price }));
  const hasInventoryPermission = (() => {
    if (!session) return false;
    if (session.role === 'system_owner' || session.role === 'store_owner' || session.role === 'manager') return true;
    if (session.role === 'technician') return true;
    return false;
  })();
  const [cart, setCart] = useState<CartItem[]>(draftCart.cart);
  const [payments, setPayments] = useState<PaymentMethod[]>(draftCart.payments);
  const [discounts, setDiscounts] = useState<Discount[]>(draftCart.discounts);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(draftCart.selectedCustomer);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSuggestiveSettingsOpen, setIsSuggestiveSettingsOpen] = useState(false);
  const [newSugName, setNewSugName] = useState('');
  const [newSugPrice, setNewSugPrice] = useState('');
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
  const [cashRoundingMode, setCashRoundingMode] = useState<'exact' | 'up' | 'down'>('exact');

  // Advanced Search & Filter
  const [searchCategory, setSearchCategory] = useState('All Categories');
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
  const [isSwitchUserOpen, setIsSwitchUserOpen] = useState(false);
  const [switchPinInput, setSwitchPinInput] = useState('');
  const [switchTarget, setSwitchTarget] = useState<typeof SEED_POS_OPERATORS[0] | null>(null);
  const [switchError, setSwitchError] = useState('');
  const [refundSearch, setRefundSearch] = useState('');
  const [refundSelectedOrder, setRefundSelectedOrder] = useState<CompletedOrder | null>(null);
  const [refundItems, setRefundItems] = useState<Record<string, number>>({});
  const [refundReason, setRefundReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('Original Payment Method');
  const [refundStep, setRefundStep] = useState<'search' | 'detail' | 'confirm'>('search');
  const [refundSuccess, setRefundSuccess] = useState(false);
  const [warrantySearch, setWarrantySearch] = useState('');
  const [warrantySelectedOrder, setWarrantySelectedOrder] = useState<CompletedOrder | null>(null);
  const [warrantySelectedItem, setWarrantySelectedItem] = useState<CompletedOrderItem | null>(null);
  const [warrantyReason, setWarrantyReason] = useState('');
  const [warrantyNotes, setWarrantyNotes] = useState('');
  const [warrantyStep, setWarrantyStep] = useState<'search' | 'select' | 'claim'>('search');
  const [warrantySuccess, setWarrantySuccess] = useState(false);
  const [ordersSearch, setOrdersSearch] = useState('');
  const [ordersSelectedOrder, setOrdersSelectedOrder] = useState<CompletedOrder | null>(null);
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

  useEffect(() => {
    setDraftCart({ cart, selectedCustomer, payments, discounts });
  }, [cart, selectedCustomer, payments, discounts]);

  const handleNewSale = () => {
    setCart([]);
    setPayments([]);
    setDiscounts([]);
    setSelectedCustomer(null);
    setSearchQuery('');
    setDiscountCode('');
    setStoreCreditId('');
    setStoreCreditVerified(false);
    setCashRoundingMode('exact');
    clearDraftCart();
    setIsSuccess(false);
  };

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
  const cashRoundingDiscount = (() => {
    if (cashRoundingMode !== 'down') return 0;
    const cashPayment = payments.find(p => p.method === 'Cash' && !p.locked);
    if (!cashPayment || cashPayment.amount <= 0) return 0;
    const otherTotal = payments.filter(pm => pm.id !== cashPayment.id).reduce((sum, pm) => sum + (pm.locked ? cardAutoAmount : pm.amount || 0), 0);
    const owed = parseFloat((total - otherTotal).toFixed(2));
    const floored = Math.floor(owed);
    if (floored > 0 && floored < owed && cashPayment.amount === floored) return parseFloat((owed - floored).toFixed(2));
    return 0;
  })();
  const remaining = parseFloat((total - totalAllocated - cashRoundingDiscount).toFixed(2));
  const changeDue = totalAllocated > total && total > 0 ? parseFloat((totalAllocated - total).toFixed(2)) : 0;
  const progress = total > 0 ? ((totalAllocated + cashRoundingDiscount) / total) * 100 : 0;

  const getStockAvailable = useCallback((itemId: string): number | null => {
    const baseId = itemId.split('-').slice(0, -1).join('-') || itemId;
    const stockItem = approvedStockItems.find(si => si.id === baseId || si.id === itemId);
    if (!stockItem) return null;
    const inCart = cart.filter(ci => ci.type === 'product' && (ci.id.startsWith(baseId + '-') || ci.id.startsWith(itemId + '-') || ci.id === baseId || ci.id === itemId)).reduce((sum, ci) => sum + (ci.qty || 1), 0);
    return Math.max(0, stockItem.qty - inCart);
  }, [approvedStockItems, cart]);

  // Handlers
  const addItemToCart = (item: any) => {
    if (item.type === 'repair') {
      setPendingRepairItem(item);
      setIsRepairDetailsModalOpen(true);
      setIsAddItemModalOpen(false);
    } else {
      const stockItem = approvedStockItems.find(si => si.id === item.id);
      if (stockItem) {
        const existingCartItem = cart.find(ci => ci.type === 'product' && ((ci as any).stockItemId === item.id));
        const inCartQty = cart.filter(ci => ci.type === 'product' && ((ci as any).stockItemId === item.id)).reduce((sum, ci) => sum + (ci.qty || 1), 0);
        if (inCartQty >= stockItem.qty) return;
        if (existingCartItem) {
          setCart(cart.map(ci => ci.id === existingCartItem.id ? { ...ci, qty: (ci.qty || 1) + 1 } : ci));
          setIsAddItemModalOpen(false);
          return;
        }
      }
      setCart([...cart, { ...item, id: `${item.id}-${Date.now()}`, stockItemId: item.id }]);
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
    const invNum = `INV-${(1000 + completedOrders.length + 1)}`;
    const txId = `TX-${Date.now().toString().slice(-5)}`;
    setFinalTotal(total);
    setFinalTxId(invNum);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const completedItems: CompletedOrderItem[] = cart.map(ci => ({
      id: ci.id,
      name: ci.name || ci.description || 'Item',
      qty: ci.qty || 1,
      unitPrice: ci.price,
      type: (ci.type as any) || 'product',
      stockItemId: (ci as any).stockItemId,
      warrantyPeriod: ci.type === 'repair' ? '90 days' : ci.type === 'product' ? '30 days' : undefined,
    }));

    const newOrder: CompletedOrder = {
      id: `ord-${Date.now()}`,
      invoiceNumber: invNum,
      customerId: selectedCustomer.id,
      customerName: selectedCustomer.name,
      customerPhone: selectedCustomer.phone || '',
      customerEmail: selectedCustomer.email || '',
      items: completedItems,
      subtotal,
      discountTotal: discountTotal + cashRoundingDiscount,
      tax,
      total: parseFloat((total - cashRoundingDiscount).toFixed(2)),
      payments: payments.map(p => ({ method: p.method, amount: p.locked ? (cardAutoAmount ?? 0) : (p.amount || 0) })),
      status: 'Paid',
      createdAt: new Date().toISOString(),
      operatorName: posOperator?.name || 'Unknown',
    };
    addCompletedOrder(newOrder);

    completedItems.forEach(ci => {
      const sid = ci.stockItemId;
      if (sid) {
        const stockItem = approvedStockItems.find(si => si.id === sid);
        if (stockItem) {
          updateStockItemCtx(sid, { qty: Math.max(0, stockItem.qty - (ci.qty || 1)) });
        }
      }
    });

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
    setCashRoundingMode('exact');
    clearDraftCart();
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
      let qty = editQty;
      if (editingItem.type === 'product') {
        const baseId = (editingItem as any).stockItemId || editingItem.id.replace(/-\d+$/, '');
        const stockItem = approvedStockItems.find(si => si.id === baseId);
        if (stockItem) {
          const otherInCart = cart.filter(ci => ci.id !== editingItem.id && ci.type === 'product' && (ci.id.startsWith(baseId + '-') || ci.id === baseId)).reduce((sum, ci) => sum + (ci.qty || 1), 0);
          qty = Math.min(qty, stockItem.qty - otherInCart);
          if (qty < 1) qty = 1;
        }
      }
      setCart(cart.map(i => i.id === editingItem.id ? { ...i, price: editPrice, qty } : i));
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
          {posOperator && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-teal-50 rounded-xl border border-teal-100">
              <div className="w-8 h-8 bg-teal-600 rounded-full flex items-center justify-center text-white text-xs font-black">{posOperator.name.split(' ').map(n => n[0]).join('')}</div>
              <div className="text-left">
                <p className="text-[10px] font-black text-teal-800 uppercase tracking-widest leading-none">{posOperator.name}</p>
                <p className="text-[9px] font-bold text-teal-500">{posOperator.role}</p>
              </div>
            </div>
          )}
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
            onClick={handleNewSale}
            className="flex items-center gap-2 text-white bg-secondary px-4 py-2 rounded-xl hover:bg-secondary/90 transition-all shadow-sm active:scale-95"
          >
            <span className="material-symbols-outlined text-sm">add_circle</span>
            <span className="text-sm font-black uppercase tracking-wider">New Sale</span>
          </button>
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
                      {(() => {
                        const sid = (item as any).stockItemId;
                        if (sid) {
                          const stockItem = approvedStockItems.find(si => si.id === sid);
                          if (stockItem) {
                            const inCart = cart.filter(ci => (ci as any).stockItemId === sid).reduce((s, ci) => s + (ci.qty || 1), 0);
                            const avail = Math.max(0, stockItem.qty - inCart);
                            return <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${avail === 0 ? 'bg-rose-100 text-rose-600' : avail <= 3 ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-400'}`}>{avail} left</span>;
                          }
                        }
                        return null;
                      })()}
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
                {payments.map((p) => {
                  const isCash = p.method === 'Cash';
                  const otherPaymentsTotal = payments.filter(pm => pm.id !== p.id).reduce((sum, pm) => sum + (pm.locked ? (cardAutoAmount ?? 0) : (pm.amount || 0)), 0);
                  const cashOwed = parseFloat((total - otherPaymentsTotal).toFixed(2));
                  const roundedUp = isCash && cashRoundingMode === 'up' && cashOwed > 0 ? Math.ceil(cashOwed) : null;
                  const roundedDown = isCash && cashRoundingMode === 'down' && cashOwed > 0 ? Math.floor(cashOwed) : null;
                  return (
                  <motion.div key={p.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                    <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
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
                    </div>
                    {isCash && (
                      <div className="flex items-center justify-between mt-2 px-4 flex-wrap gap-2">
                        <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-0.5">
                          {([['exact', 'Exact'], ['up', 'Round Up'], ['down', 'Round Down']] as const).map(([mode, label]) => (
                            <button
                              key={mode}
                              onClick={() => {
                                setCashRoundingMode(mode);
                                if (mode === 'exact') {
                                  const otherTotal = payments.filter(pm => pm.id !== p.id).reduce((sum, pm) => sum + (pm.locked ? (cardAutoAmount ?? 0) : (pm.amount || 0)), 0);
                                  const exactOwed = parseFloat((total - otherTotal).toFixed(2));
                                  if (exactOwed > 0) setPayments(payments.map(pm => pm.id === p.id ? { ...pm, amount: exactOwed } : pm));
                                }
                              }}
                              className={`text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-xl transition-all ${cashRoundingMode === mode ? (mode === 'exact' ? 'bg-white text-slate-700 shadow-sm' : 'bg-lime-100 text-lime-700 shadow-sm') : 'text-slate-400 hover:text-slate-600'}`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {roundedUp !== null && roundedUp > 0 && (
                          <button
                            onClick={() => setPayments(payments.map(pm => pm.id === p.id ? { ...pm, amount: roundedUp } : pm))}
                            className="text-[10px] font-black text-lime-700 bg-lime-50 px-3 py-1.5 rounded-xl border border-lime-200 hover:bg-lime-100 transition-all flex items-center gap-1"
                          >
                            <span className="material-symbols-outlined text-xs">arrow_upward</span>
                            Use ${roundedUp.toFixed(2)}
                            {roundedUp - cashOwed > 0.005 && <span className="text-lime-500 ml-1">(+${(roundedUp - cashOwed).toFixed(2)} change)</span>}
                          </button>
                        )}
                        {roundedDown !== null && roundedDown > 0 && roundedDown < cashOwed && (
                          <button
                            onClick={() => setPayments(payments.map(pm => pm.id === p.id ? { ...pm, amount: roundedDown } : pm))}
                            className="text-[10px] font-black text-orange-700 bg-orange-50 px-3 py-1.5 rounded-xl border border-orange-200 hover:bg-orange-100 transition-all flex items-center gap-1"
                          >
                            <span className="material-symbols-outlined text-xs">arrow_downward</span>
                            Use ${roundedDown.toFixed(2)}
                            <span className="text-orange-500 ml-1">(-${(cashOwed - roundedDown).toFixed(2)} discount)</span>
                          </button>
                        )}
                      </div>
                    )}
                  </motion.div>
                  );
                })}
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
                  {cashRoundingDiscount > 0 && (
                    <span className="block text-sm font-black text-orange-600 mt-1">Round-down: -${cashRoundingDiscount.toFixed(2)}</span>
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
                  <button onClick={() => { setIsSwitchUserOpen(true); setSwitchPinInput(''); setSwitchTarget(null); setSwitchError(''); }} className="bg-slate-100 hover:bg-slate-200 rounded-xl flex flex-col items-center justify-center gap-2 transition-all group">
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
                  onClick={() => { setIsSuccess(false); setSelectedCustomer(null); setCashRoundingMode('exact'); }}
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
                  {(() => {
                    const sid = editingItem ? (editingItem as any).stockItemId : null;
                    const stockItem = sid ? approvedStockItems.find(si => si.id === sid) : null;
                    const otherInCart = sid ? cart.filter(ci => ci.id !== editingItem?.id && (ci as any).stockItemId === sid).reduce((s, ci) => s + (ci.qty || 1), 0) : 0;
                    const maxQty = stockItem ? stockItem.qty - otherInCart : Infinity;
                    const atMax = editQty >= maxQty;
                    return (
                      <>
                        <div className="flex items-center gap-4">
                          <button onClick={() => setEditQty(Math.max(1, editQty - 1))} className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center text-primary hover:bg-slate-200 transition-all"><span className="material-symbols-outlined">remove</span></button>
                          <span className="text-2xl font-black text-primary w-12 text-center">{editQty}</span>
                          <button disabled={atMax} onClick={() => setEditQty(editQty + 1)} className={`w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center text-primary hover:bg-slate-200 transition-all ${atMax ? 'opacity-40 cursor-not-allowed' : ''}`}><span className="material-symbols-outlined">add</span></button>
                        </div>
                        {stockItem && (
                          <p className={`text-[10px] font-bold mt-1 ml-1 ${atMax ? 'text-rose-500' : 'text-slate-400'}`}>
                            {atMax ? 'Maximum stock reached' : `${Math.max(0, maxQty - editQty)} remaining in stock`}
                          </p>
                        )}
                      </>
                    );
                  })()}
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
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-8 ghost-border max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Warranty Claim</h3>
                <button onClick={() => { setIsWarrantyModalOpen(false); setWarrantyStep('search'); setWarrantySearch(''); setWarrantySelectedOrder(null); setWarrantySelectedItem(null); setWarrantyReason(''); setWarrantyNotes(''); setWarrantySuccess(false); }} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>

              {warrantySuccess ? (
                <div className="py-12 text-center">
                  <div className="w-20 h-20 bg-lime-100 text-lime-600 rounded-full flex items-center justify-center mx-auto mb-6">
                    <span className="material-symbols-outlined text-4xl" style={{fontVariationSettings: "'FILL' 1"}}>verified_user</span>
                  </div>
                  <h4 className="text-xl font-black text-primary mb-2">Warranty Claim Filed</h4>
                  <p className="text-sm text-slate-500 mb-6">A warranty ticket has been created and assigned.</p>
                  <button onClick={() => { setIsWarrantyModalOpen(false); setWarrantyStep('search'); setWarrantySearch(''); setWarrantySelectedOrder(null); setWarrantySelectedItem(null); setWarrantyReason(''); setWarrantyNotes(''); setWarrantySuccess(false); }} className="px-8 py-3 bg-primary text-white rounded-2xl font-black uppercase tracking-widest">Done</button>
                </div>
              ) : warrantyStep === 'search' ? (
                <div className="space-y-4">
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400 text-sm">search</span>
                    <input value={warrantySearch} onChange={(e) => setWarrantySearch(e.target.value)} className="w-full bg-slate-50 border-none rounded-2xl pl-11 pr-4 py-4 text-sm font-bold focus:ring-secondary" placeholder="Search by invoice #, customer name, or phone..." />
                  </div>
                  <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                    {completedOrders.filter(o => o.status === 'Paid' || o.status === 'Partially Refunded').filter(o => {
                      if (!warrantySearch.trim()) return true;
                      const q = warrantySearch.toLowerCase();
                      return o.invoiceNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q);
                    }).map(o => (
                      <button key={o.id} onClick={() => { setWarrantySelectedOrder(o); setWarrantyStep('select'); }} className="w-full p-4 bg-slate-50 hover:bg-secondary hover:text-white rounded-2xl text-left transition-all group">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold">{o.invoiceNumber}</p>
                              <span className="text-[9px] font-black px-2 py-0.5 rounded bg-lime-100 text-lime-700 group-hover:bg-white/20 group-hover:text-white uppercase">{o.status}</span>
                            </div>
                            <p className="text-xs opacity-60">{o.customerName} &bull; {new Date(o.createdAt).toLocaleDateString()}</p>
                          </div>
                          <span className="material-symbols-outlined text-slate-300 group-hover:text-white/60">chevron_right</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : warrantyStep === 'select' && warrantySelectedOrder ? (
                <div className="space-y-4">
                  <button onClick={() => { setWarrantyStep('search'); setWarrantySelectedOrder(null); }} className="text-xs font-bold text-secondary flex items-center gap-1 hover:underline">
                    <span className="material-symbols-outlined text-sm">arrow_back</span>Back to search
                  </button>
                  <div className="p-4 bg-slate-50 rounded-2xl">
                    <p className="font-bold text-sm">{warrantySelectedOrder.invoiceNumber} — {warrantySelectedOrder.customerName}</p>
                    <p className="text-xs text-slate-500">{new Date(warrantySelectedOrder.createdAt).toLocaleDateString()}</p>
                  </div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Select Warranty-Eligible Item</p>
                  <div className="space-y-2">
                    {warrantySelectedOrder.items.filter(i => i.warrantyPeriod).map(item => (
                      <button key={item.id} onClick={() => { setWarrantySelectedItem(item); setWarrantyStep('claim'); }} className="w-full p-4 bg-slate-50 hover:bg-teal-50 hover:border-teal-200 rounded-2xl text-left transition-all border border-slate-100 flex items-center justify-between">
                        <div>
                          <p className="font-bold text-sm">{item.name}</p>
                          <p className="text-xs text-slate-500">Qty: {item.qty} &bull; ${item.unitPrice.toFixed(2)} &bull; Warranty: {item.warrantyPeriod}</p>
                        </div>
                        <span className="material-symbols-outlined text-slate-300">chevron_right</span>
                      </button>
                    ))}
                    {warrantySelectedOrder.items.filter(i => i.warrantyPeriod).length === 0 && (
                      <div className="py-8 text-center">
                        <p className="text-sm font-bold text-slate-400">No warranty-eligible items on this order</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : warrantyStep === 'claim' && warrantySelectedOrder && warrantySelectedItem ? (
                <div className="space-y-4">
                  <button onClick={() => { setWarrantyStep('select'); setWarrantySelectedItem(null); setWarrantyReason(''); setWarrantyNotes(''); }} className="text-xs font-bold text-secondary flex items-center gap-1 hover:underline">
                    <span className="material-symbols-outlined text-sm">arrow_back</span>Back to items
                  </button>
                  <div className="p-4 bg-teal-50 rounded-2xl border border-teal-100">
                    <p className="font-bold text-sm text-teal-800">{warrantySelectedItem.name}</p>
                    <p className="text-xs text-teal-600">Order {warrantySelectedOrder.invoiceNumber} &bull; Warranty: {warrantySelectedItem.warrantyPeriod}</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Reason for Claim *</label>
                    <select value={warrantyReason} onChange={(e) => setWarrantyReason(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary">
                      <option value="">Select reason...</option>
                      <option>Defective product</option>
                      <option>Manufacturing fault</option>
                      <option>Screen malfunction</option>
                      <option>Battery issue</option>
                      <option>Connectivity problem</option>
                      <option>Other</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Additional Notes</label>
                    <textarea value={warrantyNotes} onChange={(e) => setWarrantyNotes(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-medium min-h-[80px] focus:ring-secondary" placeholder="Describe the issue..." />
                  </div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Warranty Details</p>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div><span className="text-slate-400">Type:</span> <span className="font-bold text-primary">{warrantySelectedItem.type === 'repair' ? 'Service Warranty' : 'Part Warranty'}</span></div>
                      <div><span className="text-slate-400">Period:</span> <span className="font-bold text-primary">{warrantySelectedItem.warrantyPeriod}</span></div>
                      <div><span className="text-slate-400">Purchased:</span> <span className="font-bold text-primary">{new Date(warrantySelectedOrder.createdAt).toLocaleDateString()}</span></div>
                      <div><span className="text-slate-400">Operator:</span> <span className="font-bold text-primary">{warrantySelectedOrder.operatorName}</span></div>
                    </div>
                  </div>
                  <button disabled={!warrantyReason} onClick={() => {
                    const ticketNum = `WC-${Date.now().toString().slice(-6)}`;
                    const now = new Date().toISOString();
                    const operator = posOperator?.name || 'Unknown';
                    addWarrantyClaim({
                      id: `wc-${Date.now()}`,
                      ticketNumber: ticketNum,
                      originalOrderId: warrantySelectedOrder.id,
                      invoiceNumber: warrantySelectedOrder.invoiceNumber,
                      customerName: warrantySelectedOrder.customerName,
                      customerId: warrantySelectedOrder.customerId,
                      itemName: warrantySelectedItem.name,
                      itemId: warrantySelectedItem.id,
                      warrantyType: warrantySelectedItem.type === 'repair' ? 'service' : 'part',
                      originalDate: warrantySelectedOrder.createdAt,
                      warrantyPeriod: warrantySelectedItem.warrantyPeriod || '30 days',
                      reason: warrantyReason,
                      notes: warrantyNotes,
                      status: 'Submitted',
                      statusHistory: [{ status: 'Submitted', date: now, by: operator }],
                      originalNotes: warrantySelectedItem.type === 'repair' ? `Original repair by ${warrantySelectedOrder.operatorName} on ${new Date(warrantySelectedOrder.createdAt).toLocaleDateString()}` : undefined,
                      createdAt: now,
                      processedBy: operator,
                    });
                    setWarrantySuccess(true);
                  }} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    File Warranty Claim
                  </button>
                </div>
              ) : null}
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
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-4xl w-full p-8 ghost-border max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Order History</h3>
                <button onClick={() => { setIsPreviousOrdersOpen(false); setOrdersSearch(''); setOrdersSelectedOrder(null); }} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>

              {ordersSelectedOrder ? (
                <div className="space-y-6">
                  <button onClick={() => setOrdersSelectedOrder(null)} className="text-xs font-bold text-secondary flex items-center gap-1 hover:underline">
                    <span className="material-symbols-outlined text-sm">arrow_back</span>Back to list
                  </button>
                  <div className="flex items-center justify-between p-6 bg-slate-50 rounded-2xl">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-lg font-black text-primary">{ordersSelectedOrder.invoiceNumber}</h4>
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded uppercase ${ordersSelectedOrder.status === 'Paid' ? 'bg-lime-100 text-lime-700' : ordersSelectedOrder.status === 'Fully Refunded' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{ordersSelectedOrder.status}</span>
                      </div>
                      <p className="text-sm text-slate-500">{ordersSelectedOrder.customerName} &bull; {ordersSelectedOrder.customerPhone}</p>
                      <p className="text-xs text-slate-400">{new Date(ordersSelectedOrder.createdAt).toLocaleString()} &bull; Operator: {ordersSelectedOrder.operatorName}</p>
                    </div>
                    <p className="text-2xl font-black text-primary">${ordersSelectedOrder.total.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Line Items</p>
                    <div className="space-y-2">
                      {ordersSelectedOrder.items.map(item => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                          <div>
                            <p className="font-bold text-sm">{item.name}</p>
                            <p className="text-xs text-slate-500">Qty: {item.qty} × ${item.unitPrice.toFixed(2)}{item.warrantyPeriod ? ` • Warranty: ${item.warrantyPeriod}` : ''}</p>
                          </div>
                          <p className="font-bold text-sm">${(item.qty * item.unitPrice).toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-4 bg-slate-50 rounded-2xl">
                    <div><span className="text-[10px] font-black text-slate-400 uppercase block">Subtotal</span><span className="font-bold">${ordersSelectedOrder.subtotal.toFixed(2)}</span></div>
                    <div><span className="text-[10px] font-black text-slate-400 uppercase block">Discount</span><span className="font-bold text-lime-600">-${ordersSelectedOrder.discountTotal.toFixed(2)}</span></div>
                    <div><span className="text-[10px] font-black text-slate-400 uppercase block">Tax</span><span className="font-bold">${ordersSelectedOrder.tax.toFixed(2)}</span></div>
                    <div><span className="text-[10px] font-black text-slate-400 uppercase block">Total</span><span className="font-black text-primary text-lg">${ordersSelectedOrder.total.toFixed(2)}</span></div>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Payments</p>
                    {ordersSelectedOrder.payments.map((pay, i) => (
                      <div key={i} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg mb-1">
                        <span className="text-sm font-bold">{pay.method}</span>
                        <span className="text-sm font-bold">${pay.amount.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  {ordersSelectedOrder.status === 'Paid' && (
                    <div className="flex gap-3">
                      <button onClick={() => { setIsPreviousOrdersOpen(false); setOrdersSelectedOrder(null); setIsRefundModalOpen(true); setRefundSearch(ordersSelectedOrder.invoiceNumber); setRefundSelectedOrder(ordersSelectedOrder); setRefundStep('detail'); }} className="flex-1 py-3 bg-rose-50 text-rose-600 rounded-2xl font-black text-xs uppercase tracking-widest border border-rose-200 hover:bg-rose-100 transition-all flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined text-sm">keyboard_return</span>Initiate Refund
                      </button>
                      <button onClick={() => { setIsPreviousOrdersOpen(false); setOrdersSelectedOrder(null); setIsWarrantyModalOpen(true); setWarrantySearch(ordersSelectedOrder.invoiceNumber); setWarrantySelectedOrder(ordersSelectedOrder); setWarrantyStep('select'); }} className="flex-1 py-3 bg-teal-50 text-teal-600 rounded-2xl font-black text-xs uppercase tracking-widest border border-teal-200 hover:bg-teal-100 transition-all flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined text-sm">verified_user</span>Warranty Claim
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400 text-sm">search</span>
                    <input value={ordersSearch} onChange={(e) => setOrdersSearch(e.target.value)} className="w-full bg-slate-50 border-none rounded-2xl pl-11 pr-4 py-4 text-sm font-bold focus:ring-secondary" placeholder="Search by invoice #, customer, phone..." />
                  </div>
                  <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2">
                    {completedOrders.filter(o => {
                      if (!ordersSearch.trim()) return true;
                      const q = ordersSearch.toLowerCase();
                      return o.invoiceNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q);
                    }).map(order => (
                      <button key={order.id} onClick={() => setOrdersSelectedOrder(order)} className="w-full flex items-center justify-between p-6 bg-slate-50 rounded-3xl border border-slate-100 hover:bg-white hover:shadow-lg transition-all text-left">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-slate-900">{order.invoiceNumber}</p>
                            <span className={`text-[9px] font-black px-2 py-0.5 rounded uppercase ${order.status === 'Paid' ? 'bg-lime-100 text-lime-700' : order.status === 'Fully Refunded' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{order.status}</span>
                          </div>
                          <p className="text-xs text-slate-500">{order.customerName} &bull; {new Date(order.createdAt).toLocaleDateString()}</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <p className="font-black text-primary">${order.total.toFixed(2)}</p>
                          <span className="material-symbols-outlined text-slate-300">chevron_right</span>
                        </div>
                      </button>
                    ))}
                    {completedOrders.length === 0 && (
                      <div className="py-12 text-center">
                        <p className="text-sm font-bold text-slate-400">No completed orders yet</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
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
                  const q = searchQuery.toLowerCase().trim();
                  if (!q && searchCategory === 'All Categories') {
                    return [{ type: 'empty-state' as const }];
                  }
                  const baseItems: { id: string; name: string; price: number; icon: string; type: 'repair' | 'product'; category: string; description: string; sku?: string; isExact?: boolean; stockQty?: number }[] = [
                    { id: 'svc-screen', name: 'iPhone 13 Screen Repair', price: 189.00, icon: 'smartphone', type: 'repair', category: 'Repairs', description: 'Screen replacement service' },
                    { id: 'svc-battery', name: 'Battery Replacement Service', price: 79.00, icon: 'battery_charging_full', type: 'repair', category: 'Repairs', description: 'Battery swap service' },
                    { id: 'svc-port', name: 'Charging Port Repair', price: 99.00, icon: 'electrical_services', type: 'repair', category: 'Repairs', description: 'Port replacement service' },
                  ];
                  const fromStock = approvedStockItems
                    .map(si => {
                      const inCartQty = cart.filter(ci => ci.type === 'product' && ci.id.startsWith(si.id + '-')).reduce((sum, ci) => sum + (ci.qty || 1), 0);
                      return {
                        id: si.id,
                        name: si.name,
                        price: si.price,
                        icon: si.category === 'Parts' ? 'build' : si.category === 'Accessories' ? 'cable' : 'inventory_2',
                        type: 'product' as const,
                        category: si.category,
                        description: `SKU: ${si.sku} · ${si.qty - inCartQty} avail`,
                        sku: si.sku,
                        stockQty: si.qty - inCartQty,
                      };
                    });
                  const allItems = [...baseItems, ...fromStock];
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
                })().map((item: any, idx) => (
                  item.type === 'empty-state' ? (
                    <div key="empty" className="col-span-2 py-12 text-center">
                      <span className="material-symbols-outlined text-4xl text-slate-200 mb-3 block">search</span>
                      <p className="text-sm font-bold text-slate-400">Search by name, SKU, or barcode</p>
                      <p className="text-xs text-slate-300 mt-1">Or select a category to browse</p>
                    </div>
                  ) : (
                  <button key={item.id || idx} disabled={item.type === 'product' && item.stockQty !== undefined && item.stockQty <= 0} onClick={() => addItemToCart(item)} className={`flex items-center gap-4 p-4 hover:bg-white hover:shadow-xl rounded-2xl text-left transition-all group ${item.isExact ? 'bg-teal-50 border-2 border-teal-200' : 'bg-slate-50'} ${item.type === 'product' && item.stockQty !== undefined && item.stockQty <= 0 ? 'opacity-40 cursor-not-allowed' : ''}`}>
                    <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-primary shadow-sm group-hover:bg-secondary group-hover:text-white transition-all">
                      <span className="material-symbols-outlined">{item.icon}</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-slate-900">{item.name}</p>
                        {item.isExact && <span className="text-[8px] font-black bg-teal-600 text-white px-1.5 py-0.5 rounded uppercase">Exact Match</span>}
                        {item.type === 'product' && item.stockQty !== undefined && item.stockQty <= 0 && <span className="text-[8px] font-black bg-red-100 text-red-600 px-1.5 py-0.5 rounded uppercase">Out of stock</span>}
                      </div>
                      <p className="text-xs text-secondary font-black">${item.price.toFixed(2)}</p>
                      <p className="text-[10px] text-slate-400">{item.description}</p>
                    </div>
                  </button>
                  )
                ))}
              </div>

              <div className="mt-8 pt-8 border-t border-dashed border-slate-200">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Suggestive Sales</h4>
                  {hasInventoryPermission && (
                    <button onClick={() => setIsSuggestiveSettingsOpen(true)} className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1 hover:text-primary transition-colors">
                      <span className="material-symbols-outlined text-xs">settings</span>
                      Manage
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {derivedSuggestiveItems.map((s) => (
                    <button key={s.id} onClick={() => handleAddSuggestiveItem(s.name, s.price)} className="flex items-center gap-3 px-4 py-2 bg-lime-50 rounded-xl border border-lime-100 hover:bg-lime-100 transition-all active:scale-95">
                      <span className="material-symbols-outlined text-lime-600 text-sm">add_shopping_cart</span>
                      <span className="text-xs font-bold text-lime-700">{s.name} - ${s.price.toFixed(2)}</span>
                    </button>
                  ))}
                  {derivedSuggestiveItems.length === 0 && <p className="text-xs text-slate-300 italic">No suggestive sales configured</p>}
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
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-2xl w-full p-8 ghost-border max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Refund / Exchange</h3>
                <button onClick={() => { setIsRefundModalOpen(false); setRefundStep('search'); setRefundSearch(''); setRefundSelectedOrder(null); setRefundItems({}); setRefundReason(''); setRefundMethod('Original Payment Method'); setRefundSuccess(false); }} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>

              {refundSuccess ? (
                <div className="py-12 text-center">
                  <div className="w-20 h-20 bg-lime-100 text-lime-600 rounded-full flex items-center justify-center mx-auto mb-6">
                    <span className="material-symbols-outlined text-4xl" style={{fontVariationSettings: "'FILL' 1"}}>check_circle</span>
                  </div>
                  <h4 className="text-xl font-black text-primary mb-2">Refund Processed</h4>
                  <p className="text-sm text-slate-500 mb-6">The refund has been recorded and applied.</p>
                  <button onClick={() => { setIsRefundModalOpen(false); setRefundStep('search'); setRefundSearch(''); setRefundSelectedOrder(null); setRefundItems({}); setRefundReason(''); setRefundMethod('Original Payment Method'); setRefundSuccess(false); }} className="px-8 py-3 bg-primary text-white rounded-2xl font-black uppercase tracking-widest">Done</button>
                </div>
              ) : refundStep === 'search' ? (
                <div className="space-y-4">
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400 text-sm">search</span>
                    <input value={refundSearch} onChange={(e) => setRefundSearch(e.target.value)} className="w-full bg-slate-50 border-none rounded-2xl pl-11 pr-4 py-4 text-sm font-bold focus:ring-secondary" placeholder="Search by invoice #, customer name, or phone..." />
                  </div>
                  <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                    {completedOrders.filter(o => o.status !== 'Fully Refunded').filter(o => {
                      if (!refundSearch.trim()) return true;
                      const q = refundSearch.toLowerCase();
                      return o.invoiceNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q);
                    }).map(o => (
                      <button key={o.id} onClick={() => { setRefundSelectedOrder(o); setRefundStep('detail'); setRefundItems({}); }} className="w-full p-4 bg-slate-50 hover:bg-secondary hover:text-white rounded-2xl text-left transition-all group">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold">{o.invoiceNumber}</p>
                              <span className="text-[9px] font-black px-2 py-0.5 rounded bg-lime-100 text-lime-700 group-hover:bg-white/20 group-hover:text-white uppercase">{o.status}</span>
                            </div>
                            <p className="text-xs opacity-60">{o.customerName} &bull; ${o.total.toFixed(2)} &bull; {new Date(o.createdAt).toLocaleDateString()}</p>
                          </div>
                          <span className="material-symbols-outlined text-slate-300 group-hover:text-white/60">chevron_right</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : refundStep === 'detail' && refundSelectedOrder ? (
                <div className="space-y-4">
                  <button onClick={() => { setRefundStep('search'); setRefundSelectedOrder(null); setRefundItems({}); }} className="text-xs font-bold text-secondary flex items-center gap-1 hover:underline">
                    <span className="material-symbols-outlined text-sm">arrow_back</span>Back to search
                  </button>
                  <div className="p-4 bg-slate-50 rounded-2xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold text-sm">{refundSelectedOrder.invoiceNumber} — {refundSelectedOrder.customerName}</p>
                        <p className="text-xs text-slate-500">{new Date(refundSelectedOrder.createdAt).toLocaleDateString()} &bull; Total: ${refundSelectedOrder.total.toFixed(2)}</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Select Items to Refund</p>
                  <div className="space-y-2">
                    {refundSelectedOrder.items.map(item => {
                      const maxRefundable = item.qty - (item.refundedQty || 0);
                      const selected = refundItems[item.id] || 0;
                      return (
                        <div key={item.id} className={`p-4 rounded-2xl border transition-all ${selected > 0 ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-100'}`}>
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-bold text-sm">{item.name}</p>
                              <p className="text-xs text-slate-500">${item.unitPrice.toFixed(2)} × {item.qty}{item.refundedQty ? ` (${item.refundedQty} already refunded)` : ''}</p>
                            </div>
                            {maxRefundable > 0 ? (
                              <div className="flex items-center gap-2">
                                <button onClick={() => setRefundItems({ ...refundItems, [item.id]: Math.max(0, selected - 1) })} className="w-8 h-8 bg-white rounded-lg flex items-center justify-center text-slate-400 hover:text-primary border"><span className="material-symbols-outlined text-sm">remove</span></button>
                                <span className="w-6 text-center font-bold text-sm">{selected}</span>
                                <button onClick={() => setRefundItems({ ...refundItems, [item.id]: Math.min(maxRefundable, selected + 1) })} className="w-8 h-8 bg-white rounded-lg flex items-center justify-center text-slate-400 hover:text-primary border"><span className="material-symbols-outlined text-sm">add</span></button>
                              </div>
                            ) : (
                              <span className="text-[9px] font-black text-slate-400 uppercase">Fully refunded</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {(() => {
                    const entries = Object.entries(refundItems) as [string, number][];
                    const refundTotal = entries.reduce((sum, [itemId, qty]) => {
                      const item = refundSelectedOrder.items.find(i => i.id === itemId);
                      return sum + (item ? item.unitPrice * qty : 0);
                    }, 0);
                    const hasSelection = (Object.values(refundItems) as number[]).some(q => q > 0);
                    return hasSelection ? (
                      <div className="p-4 bg-rose-50 rounded-2xl border border-rose-200">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-rose-700">Refund Amount</span>
                          <span className="text-xl font-black text-rose-700">${refundTotal.toFixed(2)}</span>
                        </div>
                      </div>
                    ) : null;
                  })()}
                  <button disabled={!(Object.values(refundItems) as number[]).some(q => q > 0)} onClick={() => setRefundStep('confirm')} className="w-full py-4 bg-rose-500 text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed">Continue to Refund</button>
                </div>
              ) : refundStep === 'confirm' && refundSelectedOrder ? (
                <div className="space-y-4">
                  <button onClick={() => setRefundStep('detail')} className="text-xs font-bold text-secondary flex items-center gap-1 hover:underline">
                    <span className="material-symbols-outlined text-sm">arrow_back</span>Back to items
                  </button>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Reason for Refund *</label>
                    <select value={refundReason} onChange={(e) => setRefundReason(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary">
                      <option value="">Select reason...</option>
                      <option>Customer dissatisfied</option>
                      <option>Wrong item sold</option>
                      <option>Defective product</option>
                      <option>Price adjustment</option>
                      <option>Duplicate transaction</option>
                      <option>Other</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Original Payment Method</label>
                    <div className="px-4 py-2 bg-slate-100 rounded-xl mb-2">
                      <p className="text-xs font-bold text-slate-600">{refundSelectedOrder.payments.map(p => `${p.method}: $${p.amount.toFixed(2)}`).join(' + ')}</p>
                    </div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Refund Method</label>
                    <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)} className="w-full bg-slate-50 border-none rounded-xl px-4 py-3 text-sm font-bold focus:ring-secondary">
                      <option>Original Payment Method</option>
                      <option>Store Credit</option>
                      <option>Cash</option>
                    </select>
                    {refundMethod === 'Original Payment Method' && refundSelectedOrder.payments.some(p => p.method === 'Card Terminal') && (
                      <p className="text-[9px] text-amber-600 font-bold ml-4 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[10px]">info</span>
                        Card refund will be processed manually — live terminal integration not connected
                      </p>
                    )}
                  </div>
                  {(() => {
                    const entries2 = Object.entries(refundItems) as [string, number][];
                    const refundTotal = entries2.reduce((sum, [itemId, qty]) => {
                      const item = refundSelectedOrder.items.find(i => i.id === itemId);
                      return sum + (item ? item.unitPrice * qty : 0);
                    }, 0);
                    const refundItemsList = entries2.filter(([, qty]) => qty > 0).map(([itemId, qty]) => {
                      const item = refundSelectedOrder.items.find(i => i.id === itemId)!;
                      return { itemId, name: item.name, qty, amount: item.unitPrice * qty };
                    });
                    return (
                      <>
                        <div className="p-4 bg-rose-50 rounded-2xl border border-rose-200">
                          <p className="text-[10px] font-black text-rose-400 uppercase tracking-widest mb-2">Refund Summary</p>
                          {refundItemsList.map(ri => (
                            <div key={ri.itemId} className="flex justify-between text-sm">
                              <span>{ri.name} × {ri.qty}</span>
                              <span className="font-bold">${ri.amount.toFixed(2)}</span>
                            </div>
                          ))}
                          <div className="flex justify-between text-lg font-black text-rose-700 mt-2 pt-2 border-t border-rose-200">
                            <span>Total Refund</span>
                            <span>${refundTotal.toFixed(2)}</span>
                          </div>
                        </div>
                        <button disabled={!refundReason} onClick={() => {
                          addRefundRecord({
                            id: `ref-${Date.now()}`,
                            originalOrderId: refundSelectedOrder.id,
                            invoiceNumber: refundSelectedOrder.invoiceNumber,
                            customerName: refundSelectedOrder.customerName,
                            items: refundItemsList,
                            totalRefunded: refundTotal,
                            reason: refundReason,
                            method: refundMethod,
                            processedBy: posOperator?.name || 'Unknown',
                            createdAt: new Date().toISOString(),
                          });
                          const updatedItems = refundSelectedOrder.items.map(item => {
                            const refQty = refundItems[item.id] || 0;
                            return refQty > 0 ? { ...item, refundedQty: (item.refundedQty || 0) + refQty } : item;
                          });
                          const allFullyRefunded = updatedItems.every(item => (item.refundedQty || 0) >= item.qty);
                          updateCompletedOrder(refundSelectedOrder.id, {
                            items: updatedItems,
                            status: allFullyRefunded ? 'Fully Refunded' : 'Partially Refunded',
                          });
                          setRefundSuccess(true);
                        }} className="w-full py-5 bg-rose-500 text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed">Process Refund</button>
                      </>
                    );
                  })()}
                </div>
              ) : null}
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

        {isSwitchUserOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[160] flex items-center justify-center bg-primary/40 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-2xl font-black text-primary tracking-tight">Switch Operator</h3>
                <button onClick={() => { setIsSwitchUserOpen(false); setSwitchTarget(null); setSwitchPinInput(''); setSwitchError(''); }} className="text-slate-400 hover:text-primary"><span className="material-symbols-outlined">close</span></button>
              </div>

              {!switchTarget ? (
                <div className="space-y-3">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Select Operator</p>
                  {SEED_POS_OPERATORS.filter(op => op.id !== posOperator?.id).map(op => (
                    <button key={op.id} onClick={() => { setSwitchTarget(op); setSwitchPinInput(''); setSwitchError(''); }} className="w-full p-4 bg-slate-50 hover:bg-secondary hover:text-white rounded-2xl text-left transition-all group flex items-center gap-4">
                      <div className="w-10 h-10 bg-teal-100 text-teal-700 rounded-full flex items-center justify-center font-black text-xs group-hover:bg-white/20 group-hover:text-white transition-all">{op.name.split(' ').map(n => n[0]).join('')}</div>
                      <div>
                        <p className="font-bold">{op.name}</p>
                        <p className="text-xs opacity-60">{op.role}</p>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  <button onClick={() => { setSwitchTarget(null); setSwitchPinInput(''); setSwitchError(''); }} className="text-xs font-bold text-secondary flex items-center gap-1 hover:underline">
                    <span className="material-symbols-outlined text-sm">arrow_back</span>Back to operators
                  </button>
                  <div className="p-4 bg-teal-50 rounded-2xl border border-teal-100 flex items-center gap-3">
                    <div className="w-10 h-10 bg-teal-600 text-white rounded-full flex items-center justify-center font-black text-xs">{switchTarget.name.split(' ').map(n => n[0]).join('')}</div>
                    <div>
                      <p className="font-bold text-sm text-teal-800">{switchTarget.name}</p>
                      <p className="text-xs text-teal-600">{switchTarget.role}</p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Enter PIN</label>
                    <input value={switchPinInput} onChange={(e) => { setSwitchPinInput(e.target.value.replace(/\D/g, '').slice(0, 4)); setSwitchError(''); }} className="w-full bg-slate-50 border-none rounded-2xl px-6 py-4 text-2xl font-black text-primary text-center tracking-[0.5em] focus:ring-secondary" placeholder="••••" type="password" maxLength={4} autoFocus />
                    {import.meta.env.DEV && switchTarget && (
                      <p className="text-[10px] font-medium text-indigo-400 ml-4 flex items-center gap-1 mt-1">
                        <span className="material-symbols-outlined text-[10px]">bug_report</span>
                        Preview mode — test PIN: {switchTarget.pin}
                      </p>
                    )}
                    {switchError && (
                      <p className="text-xs font-bold text-rose-500 ml-4 flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">error</span>{switchError}
                      </p>
                    )}
                  </div>
                  <button disabled={switchPinInput.length < 4} onClick={() => {
                    if (switchPinInput === switchTarget.pin) {
                      setPosOperator(switchTarget);
                      setIsSwitchUserOpen(false);
                      setSwitchTarget(null);
                      setSwitchPinInput('');
                      setSwitchError('');
                    } else {
                      setSwitchError('Incorrect PIN. Please try again.');
                      setSwitchPinInput('');
                    }
                  }} className="w-full py-5 bg-secondary text-white rounded-2xl font-black uppercase tracking-widest shadow-lg active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed">Authenticate & Switch</button>
                </div>
              )}
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

      {isSuggestiveSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black text-primary">Manage Suggestive Sales</h3>
                <p className="text-xs text-slate-400 mt-1">Items shown as quick-add suggestions during checkout</p>
              </div>
              <button onClick={() => setIsSuggestiveSettingsOpen(false)} className="text-slate-300 hover:text-slate-500 transition-colors">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="p-6 space-y-4 max-h-[50vh] overflow-y-auto">
              {derivedSuggestiveItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                  <div>
                    <p className="text-sm font-bold text-slate-900">{item.name}</p>
                    <p className="text-xs text-secondary font-black">${item.price.toFixed(2)}</p>
                  </div>
                  <button onClick={() => updateStockItemCtx(item.id, { isSuggestiveSale: false })} className="text-slate-300 hover:text-red-500 transition-colors">
                    <span className="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              ))}
              {derivedSuggestiveItems.length === 0 && (
                <p className="text-center text-sm text-slate-300 py-4">No suggestive sale items configured</p>
              )}
            </div>
            <div className="p-6 border-t border-slate-100">
              <div className="flex gap-2">
                <input
                  value={newSugName}
                  onChange={(e) => setNewSugName(e.target.value)}
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:ring-secondary focus:border-secondary"
                  placeholder="Item name"
                />
                <div className="relative w-28">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">$</span>
                  <input
                    value={newSugPrice}
                    onChange={(e) => setNewSugPrice(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-6 pr-3 py-2 text-sm focus:ring-secondary focus:border-secondary"
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    min="0"
                  />
                </div>
                <button
                  onClick={() => {
                    const price = parseFloat(newSugPrice);
                    if (newSugName.trim() && price > 0) {
                      addStockItem({
                        id: `stk-sug-${Date.now()}`,
                        name: newSugName.trim(),
                        sku: `SUG-${Date.now().toString().slice(-6)}`,
                        qty: 999,
                        cost: 0,
                        price,
                        category: 'Accessories',
                        addedAt: new Date().toISOString(),
                        status: 'approved',
                        isSuggestiveSale: true,
                      });
                      setNewSugName('');
                      setNewSugPrice('');
                    }
                  }}
                  className="bg-secondary text-white px-4 py-2 rounded-xl font-black text-sm hover:bg-secondary/90 transition-all active:scale-95"
                >
                  Add
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

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
