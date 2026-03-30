import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Customer, HeldOrder } from '../types';

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
}

const SEED_CUSTOMERS: Customer[] = [
  { id: 'c1', name: 'Alexander Wright', phone: '555-0123', email: 'alex@example.com', totalSpent: 1240, lastVisit: '2026-03-25', loyaltyPoints: 1240 },
  { id: 'c2', name: 'Sarah Jenkins', phone: '555-0456', email: 'sarah@example.com', totalSpent: 890, lastVisit: '2026-03-22', loyaltyPoints: 890 },
  { id: 'c3', name: 'Mike Rodriguez', phone: '555-0789', email: 'mike@example.com', totalSpent: 320, lastVisit: '2026-03-20', loyaltyPoints: 320 },
  { id: 'c4', name: 'Emma Chen', phone: '555-0321', email: 'emma@example.com', totalSpent: 560, lastVisit: '2026-03-18', loyaltyPoints: 560 },
];

const SEED_STOCK_ITEMS: StockItem[] = [
  { id: 'stk-001', name: 'iPhone 13 Screen', sku: 'IP13-SCR-001', qty: 12, cost: 45.00, price: 89.00, category: 'Parts', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-002', name: 'USB-C Charging Cable', sku: 'USB-C-CBL-01', qty: 50, cost: 3.50, price: 12.99, category: 'Accessories', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-003', name: 'Samsung S21 Battery', sku: 'SAM-S21-BAT', qty: 8, cost: 22.00, price: 45.00, category: 'Parts', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-004', name: 'Tempered Glass Protector', sku: 'TG-UNIV-001', qty: 100, cost: 2.00, price: 9.99, category: 'Accessories', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-005', name: 'iPad Air 5 Digitizer', sku: 'IPAD-A5-DIG', qty: 4, cost: 65.00, price: 129.00, category: 'Parts', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
];

const StoreLocalStateContext = createContext<StoreLocalStateContextType | null>(null);

export function StoreLocalStateProvider({ children }: { children: React.ReactNode }) {
  const [customers, setCustomers] = useState<Customer[]>(SEED_CUSTOMERS);
  const [stockItems, setStockItems] = useState<StockItem[]>(SEED_STOCK_ITEMS);
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);

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

  return (
    <StoreLocalStateContext.Provider value={{ customers, addCustomer, updateCustomer, stockItems, addStockItem, updateStockItem, approvedStockItems, pendingStockItems, heldOrders, addHeldOrder, removeHeldOrder }}>
      {children}
    </StoreLocalStateContext.Provider>
  );
}

export function useStoreLocalState() {
  const ctx = useContext(StoreLocalStateContext);
  if (!ctx) throw new Error('useStoreLocalState must be used within StoreLocalStateProvider');
  return ctx;
}
