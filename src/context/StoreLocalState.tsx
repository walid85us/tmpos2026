import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Customer, HeldOrder, CartItem, PaymentMethod, Discount, RepairTicket } from '../types';

export interface StockItem {
  id: string;
  name: string;
  sku: string;
  qty: number;
  cost: number;
  price: number;
  category: string;
  addedAt: string;
  status: 'approved' | 'pending_approval' | 'rejected';
  isSuggestiveSale?: boolean;
}

export interface SuggestiveSaleItem {
  id: string;
  name: string;
  price: number;
}

export interface DraftCart {
  cart: CartItem[];
  selectedCustomer: Customer | null;
  payments: PaymentMethod[];
  discounts: Discount[];
}

export interface CompletedOrderItem {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
  type: 'product' | 'repair' | 'special' | 'deposit';
  stockItemId?: string;
  warrantyPeriod?: string;
  refundedQty?: number;
}

export interface CompletedOrder {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  items: CompletedOrderItem[];
  subtotal: number;
  discountTotal: number;
  tax: number;
  total: number;
  payments: { method: string; amount: number }[];
  status: 'Paid' | 'Partially Refunded' | 'Fully Refunded';
  createdAt: string;
  operatorName: string;
}

export interface RefundRecord {
  id: string;
  originalOrderId: string;
  invoiceNumber: string;
  customerName: string;
  items: { itemId: string; name: string; qty: number; amount: number }[];
  totalRefunded: number;
  reason: string;
  method: string;
  processedBy: string;
  createdAt: string;
}

export interface WarrantyClaimRecord {
  id: string;
  ticketNumber: string;
  originalOrderId: string;
  invoiceNumber: string;
  customerName: string;
  customerId: string;
  itemName: string;
  itemId: string;
  warrantyType: 'service' | 'part';
  originalDate: string;
  warrantyPeriod: string;
  reason: string;
  notes: string;
  status: 'Submitted' | 'Under Review' | 'Approved' | 'Rejected' | 'In Repair' | 'Replacement Pending' | 'Completed';
  statusHistory: { status: string; date: string; by: string; note?: string }[];
  originalNotes?: string;
  createdAt: string;
  processedBy: string;
  linkedRepairId?: string;
  assignedTechnicianId?: string;
  assignedTechnicianName?: string;
  replacementSentToPOS?: boolean;
  replacementOrderId?: string;
}

export interface POSOperator {
  id: string;
  name: string;
  role: string;
  pin: string;
}

interface StoreLocalStateContextType {
  customers: Customer[];
  addCustomer: (c: Customer) => void;
  updateCustomer: (id: string, updates: Partial<Customer>) => void;
  stockItems: StockItem[];
  addStockItem: (item: StockItem) => void;
  updateStockItem: (id: string, updates: Partial<StockItem>) => void;
  approvedStockItems: StockItem[];
  pendingStockItems: StockItem[];
  heldOrders: HeldOrder[];
  addHeldOrder: (order: HeldOrder) => void;
  removeHeldOrder: (id: string) => void;
  suggestiveSalesItems: SuggestiveSaleItem[];
  addSuggestiveSaleItem: (item: SuggestiveSaleItem) => void;
  removeSuggestiveSaleItem: (id: string) => void;
  draftCart: DraftCart;
  setDraftCart: (draft: DraftCart) => void;
  clearDraftCart: () => void;
  completedOrders: CompletedOrder[];
  addCompletedOrder: (order: CompletedOrder) => void;
  updateCompletedOrder: (id: string, updates: Partial<CompletedOrder>) => void;
  refundRecords: RefundRecord[];
  addRefundRecord: (record: RefundRecord) => void;
  warrantyClaims: WarrantyClaimRecord[];
  addWarrantyClaim: (claim: WarrantyClaimRecord) => void;
  updateWarrantyClaim: (id: string, updates: Partial<WarrantyClaimRecord>) => void;
  posOperator: POSOperator | null;
  setPosOperator: (op: POSOperator | null) => void;
  warrantyRepairTickets: RepairTicket[];
  addWarrantyRepairTicket: (ticket: RepairTicket) => void;
  updateWarrantyRepairTicket: (id: string, updates: Partial<RepairTicket>) => void;
  pendingReplacements: { warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number }[];
  addPendingReplacement: (r: { warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number }) => void;
  removePendingReplacement: (warrantyClaimId: string) => void;
}

const SEED_CUSTOMERS: Customer[] = [
  { id: 'c1', name: 'Alexander Wright', phone: '555-0123', email: 'alex@example.com', totalSpent: 1240, lastVisit: '2026-03-25', loyaltyPoints: 1240 },
  { id: 'c2', name: 'Sarah Jenkins', phone: '555-0456', email: 'sarah@example.com', totalSpent: 890, lastVisit: '2026-03-22', loyaltyPoints: 890 },
  { id: 'c3', name: 'Mike Rodriguez', phone: '555-0789', email: 'mike@example.com', totalSpent: 320, lastVisit: '2026-03-20', loyaltyPoints: 320 },
  { id: 'c4', name: 'Emma Chen', phone: '555-0321', email: 'emma@example.com', totalSpent: 560, lastVisit: '2026-03-18', loyaltyPoints: 560 },
];

const SEED_STOCK_ITEMS: StockItem[] = [
  { id: 'stk-001', name: 'iPhone 13 Screen', sku: 'IP13-SCR-001', qty: 12, cost: 45.00, price: 89.00, category: 'Parts', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-002', name: 'USB-C Charging Cable', sku: 'USB-C-CBL-01', qty: 50, cost: 3.50, price: 12.99, category: 'Accessories', addedAt: '2026-03-20T10:00:00Z', status: 'approved', isSuggestiveSale: true },
  { id: 'stk-003', name: 'Samsung S21 Battery', sku: 'SAM-S21-BAT', qty: 8, cost: 22.00, price: 45.00, category: 'Parts', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-004', name: 'Tempered Glass Protector', sku: 'TG-UNIV-001', qty: 100, cost: 2.00, price: 9.99, category: 'Accessories', addedAt: '2026-03-20T10:00:00Z', status: 'approved', isSuggestiveSale: true },
  { id: 'stk-005', name: 'iPad Air 5 Digitizer', sku: 'IPAD-A5-DIG', qty: 4, cost: 65.00, price: 129.00, category: 'Parts', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
];

const SEED_SUGGESTIVE_SALES: SuggestiveSaleItem[] = [
  { id: 'sug-1', name: 'Tempered Glass', price: 9.99 },
  { id: 'sug-2', name: 'Protective Case', price: 24.99 },
];

const SEED_COMPLETED_ORDERS: CompletedOrder[] = [
  {
    id: 'ord-001', invoiceNumber: 'INV-1001', customerId: 'c1', customerName: 'Alexander Wright', customerPhone: '555-0123', customerEmail: 'alex@example.com',
    items: [
      { id: 'oi-1', name: 'iPhone 13 Screen Repair', qty: 1, unitPrice: 189.00, type: 'repair', warrantyPeriod: '90 days' },
      { id: 'oi-2', name: 'Tempered Glass Protector', qty: 1, unitPrice: 9.99, type: 'product', stockItemId: 'stk-004', warrantyPeriod: '30 days' },
    ],
    subtotal: 198.99, discountTotal: 0, tax: 16.42, total: 215.41,
    payments: [{ method: 'Card Terminal', amount: 215.41 }],
    status: 'Paid', createdAt: '2026-03-19T14:30:00Z', operatorName: 'Sarah J.',
  },
  {
    id: 'ord-002', invoiceNumber: 'INV-1002', customerId: 'c2', customerName: 'Sarah Jenkins', customerPhone: '555-0456', customerEmail: 'sarah@example.com',
    items: [
      { id: 'oi-3', name: 'USB-C Charging Cable', qty: 2, unitPrice: 12.99, type: 'product', stockItemId: 'stk-002', warrantyPeriod: '30 days' },
      { id: 'oi-4', name: 'Samsung S21 Battery', qty: 1, unitPrice: 45.00, type: 'product', stockItemId: 'stk-003', warrantyPeriod: '30 days' },
    ],
    subtotal: 70.98, discountTotal: 7.10, tax: 5.27, total: 69.15,
    payments: [{ method: 'Cash', amount: 70.00 }],
    status: 'Paid', createdAt: '2026-03-18T11:15:00Z', operatorName: 'Mike R.',
  },
  {
    id: 'ord-003', invoiceNumber: 'INV-1003', customerId: 'c3', customerName: 'Mike Rodriguez', customerPhone: '555-0789', customerEmail: 'mike@example.com',
    items: [
      { id: 'oi-5', name: 'Battery Replacement Service', qty: 1, unitPrice: 79.00, type: 'repair', warrantyPeriod: '90 days' },
    ],
    subtotal: 79.00, discountTotal: 0, tax: 6.52, total: 85.52,
    payments: [{ method: 'Card Terminal', amount: 85.52 }],
    status: 'Paid', createdAt: '2026-03-15T09:45:00Z', operatorName: 'Sarah J.',
  },
  {
    id: 'ord-004', invoiceNumber: 'INV-1004', customerId: 'c4', customerName: 'Emma Chen', customerPhone: '555-0321', customerEmail: 'emma@example.com',
    items: [
      { id: 'oi-6', name: 'iPad Air 5 Digitizer', qty: 1, unitPrice: 129.00, type: 'product', stockItemId: 'stk-005', warrantyPeriod: '30 days' },
      { id: 'oi-7', name: 'Charging Port Repair', qty: 1, unitPrice: 99.00, type: 'repair', warrantyPeriod: '90 days' },
    ],
    subtotal: 228.00, discountTotal: 22.80, tax: 16.93, total: 222.13,
    payments: [{ method: 'Cash', amount: 100.00 }, { method: 'Card Terminal', amount: 122.13 }],
    status: 'Paid', createdAt: '2026-03-12T16:20:00Z', operatorName: 'Alexander W.',
  },
];

const SEED_POS_OPERATORS: POSOperator[] = [
  { id: 'op-1', name: 'Sarah Johnson', role: 'Manager', pin: '1234' },
  { id: 'op-2', name: 'Mike Torres', role: 'Sales Associate', pin: '5678' },
  { id: 'op-3', name: 'Alex Kim', role: 'Technician', pin: '9012' },
  { id: 'op-4', name: 'Dana Lee', role: 'Sales Associate', pin: '3456' },
];

export { SEED_POS_OPERATORS };

const SEED_WARRANTY_CLAIMS: WarrantyClaimRecord[] = [
  {
    id: 'wc-seed-001', ticketNumber: 'WC-100001',
    originalOrderId: 'ord-001', invoiceNumber: 'INV-1001',
    customerName: 'Alexander Wright', customerId: 'c1',
    itemName: 'iPhone 13 Screen Repair', itemId: 'oi-1',
    warrantyType: 'service', originalDate: '2026-03-19T14:30:00Z', warrantyPeriod: '90 days',
    reason: 'Screen malfunction', notes: 'Display flickering after 2 weeks of use. Customer reports intermittent black spots.',
    status: 'Under Review',
    statusHistory: [
      { status: 'Submitted', date: '2026-03-25T10:00:00Z', by: 'Sarah J.' },
      { status: 'Under Review', date: '2026-03-26T09:00:00Z', by: 'Mike R.', note: 'Scheduled for diagnostic inspection' },
    ],
    originalNotes: 'iPhone 13 screen replacement - OEM quality part used. Device serial: IP13-XK2948.',
    createdAt: '2026-03-25T10:00:00Z', processedBy: 'Sarah J.',
  },
  {
    id: 'wc-seed-002', ticketNumber: 'WC-100002',
    originalOrderId: 'ord-003', invoiceNumber: 'INV-1003',
    customerName: 'Mike Rodriguez', customerId: 'c3',
    itemName: 'Battery Replacement Service', itemId: 'oi-5',
    warrantyType: 'service', originalDate: '2026-03-15T09:45:00Z', warrantyPeriod: '90 days',
    reason: 'Battery issue', notes: 'Phone shutting down at 30% battery.',
    status: 'Approved',
    statusHistory: [
      { status: 'Submitted', date: '2026-03-28T11:00:00Z', by: 'Mike R.' },
      { status: 'Under Review', date: '2026-03-28T14:00:00Z', by: 'Sarah J.' },
      { status: 'Approved', date: '2026-03-29T10:00:00Z', by: 'Sarah J.', note: 'Confirmed battery defect within warranty period. Approved for free replacement.' },
    ],
    createdAt: '2026-03-28T11:00:00Z', processedBy: 'Mike R.',
  },
  {
    id: 'wc-seed-003', ticketNumber: 'WC-100003',
    originalOrderId: 'ord-002', invoiceNumber: 'INV-1002',
    customerName: 'Sarah Jenkins', customerId: 'c2',
    itemName: 'USB-C Charging Cable', itemId: 'oi-3',
    warrantyType: 'part', originalDate: '2026-03-18T11:15:00Z', warrantyPeriod: '30 days',
    reason: 'Defective product', notes: 'Cable stopped charging after 10 days.',
    status: 'Completed',
    statusHistory: [
      { status: 'Submitted', date: '2026-03-22T09:00:00Z', by: 'Dana L.' },
      { status: 'Approved', date: '2026-03-22T11:00:00Z', by: 'Sarah J.' },
      { status: 'Replacement Pending', date: '2026-03-22T11:30:00Z', by: 'Sarah J.', note: 'Replacement cable pulled from stock.' },
      { status: 'Completed', date: '2026-03-23T10:00:00Z', by: 'Sarah J.', note: 'Customer picked up replacement cable.' },
    ],
    createdAt: '2026-03-22T09:00:00Z', processedBy: 'Dana L.',
  },
];

const EMPTY_DRAFT: DraftCart = { cart: [], selectedCustomer: null, payments: [], discounts: [] };

const StoreLocalStateContext = createContext<StoreLocalStateContextType | null>(null);

export function StoreLocalStateProvider({ children }: { children: React.ReactNode }) {
  const [customers, setCustomers] = useState<Customer[]>(SEED_CUSTOMERS);
  const [stockItems, setStockItems] = useState<StockItem[]>(SEED_STOCK_ITEMS);
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);
  const [suggestiveSalesItems, setSuggestiveSalesItems] = useState<SuggestiveSaleItem[]>(SEED_SUGGESTIVE_SALES);
  const [draftCart, setDraftCartState] = useState<DraftCart>(EMPTY_DRAFT);
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>(SEED_COMPLETED_ORDERS);
  const [refundRecords, setRefundRecords] = useState<RefundRecord[]>([]);
  const [warrantyClaims, setWarrantyClaims] = useState<WarrantyClaimRecord[]>(SEED_WARRANTY_CLAIMS);
  const [posOperator, setPosOperatorState] = useState<POSOperator | null>(SEED_POS_OPERATORS[0]);
  const [warrantyRepairTickets, setWarrantyRepairTickets] = useState<RepairTicket[]>([]);
  const [pendingReplacements, setPendingReplacements] = useState<{ warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number }[]>([]);

  const addCustomer = useCallback((c: Customer) => {
    setCustomers(prev => [...prev, c]);
  }, []);

  const updateCustomer = useCallback((id: string, updates: Partial<Customer>) => {
    setCustomers(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  }, []);

  const addStockItem = useCallback((item: StockItem) => {
    setStockItems(prev => [...prev, item]);
  }, []);

  const updateStockItem = useCallback((id: string, updates: Partial<StockItem>) => {
    setStockItems(prev => prev.map(si => si.id === id ? { ...si, ...updates } : si));
  }, []);

  const approvedStockItems = useMemo(() => stockItems.filter(si => si.status === 'approved'), [stockItems]);
  const pendingStockItems = useMemo(() => stockItems.filter(si => si.status === 'pending_approval'), [stockItems]);

  const addHeldOrder = useCallback((order: HeldOrder) => {
    setHeldOrders(prev => [...prev, order]);
  }, []);

  const removeHeldOrder = useCallback((id: string) => {
    setHeldOrders(prev => prev.filter(o => o.id !== id));
  }, []);

  const addSuggestiveSaleItem = useCallback((item: SuggestiveSaleItem) => {
    setSuggestiveSalesItems(prev => [...prev, item]);
  }, []);

  const removeSuggestiveSaleItem = useCallback((id: string) => {
    setSuggestiveSalesItems(prev => prev.filter(i => i.id !== id));
  }, []);

  const setDraftCart = useCallback((draft: DraftCart) => {
    setDraftCartState(draft);
  }, []);

  const clearDraftCart = useCallback(() => {
    setDraftCartState(EMPTY_DRAFT);
  }, []);

  const addCompletedOrder = useCallback((order: CompletedOrder) => {
    setCompletedOrders(prev => [order, ...prev]);
  }, []);

  const updateCompletedOrder = useCallback((id: string, updates: Partial<CompletedOrder>) => {
    setCompletedOrders(prev => prev.map(o => o.id === id ? { ...o, ...updates } : o));
  }, []);

  const addRefundRecord = useCallback((record: RefundRecord) => {
    setRefundRecords(prev => [record, ...prev]);
  }, []);

  const addWarrantyClaim = useCallback((claim: WarrantyClaimRecord) => {
    setWarrantyClaims(prev => [claim, ...prev]);
  }, []);

  const updateWarrantyClaim = useCallback((id: string, updates: Partial<WarrantyClaimRecord>) => {
    setWarrantyClaims(prev => prev.map(wc => wc.id === id ? { ...wc, ...updates } : wc));
  }, []);

  const setPosOperator = useCallback((op: POSOperator | null) => {
    setPosOperatorState(op);
  }, []);

  const addWarrantyRepairTicket = useCallback((ticket: RepairTicket) => {
    setWarrantyRepairTickets(prev => [ticket, ...prev]);
  }, []);

  const updateWarrantyRepairTicket = useCallback((id: string, updates: Partial<RepairTicket>) => {
    setWarrantyRepairTickets(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  }, []);

  const addPendingReplacement = useCallback((r: { warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number }) => {
    setPendingReplacements(prev => {
      if (prev.some(p => p.warrantyClaimId === r.warrantyClaimId)) return prev;
      return [...prev, r];
    });
  }, []);

  const removePendingReplacement = useCallback((warrantyClaimId: string) => {
    setPendingReplacements(prev => prev.filter(r => r.warrantyClaimId !== warrantyClaimId));
  }, []);

  return (
    <StoreLocalStateContext.Provider value={{
      customers, addCustomer, updateCustomer,
      stockItems, addStockItem, updateStockItem, approvedStockItems, pendingStockItems,
      heldOrders, addHeldOrder, removeHeldOrder,
      suggestiveSalesItems, addSuggestiveSaleItem, removeSuggestiveSaleItem,
      draftCart, setDraftCart, clearDraftCart,
      completedOrders, addCompletedOrder, updateCompletedOrder,
      refundRecords, addRefundRecord,
      warrantyClaims, addWarrantyClaim, updateWarrantyClaim,
      posOperator, setPosOperator,
      warrantyRepairTickets, addWarrantyRepairTicket, updateWarrantyRepairTicket,
      pendingReplacements, addPendingReplacement, removePendingReplacement,
    }}>
      {children}
    </StoreLocalStateContext.Provider>
  );
}

export function useStoreLocalState() {
  const ctx = useContext(StoreLocalStateContext);
  if (!ctx) throw new Error('useStoreLocalState must be used within StoreLocalStateProvider');
  return ctx;
}
