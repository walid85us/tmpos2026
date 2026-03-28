import React, { createContext, useContext, useState, useCallback } from 'react';
import { Customer } from '../types';

export interface StockItem {
  id: string;
  name: string;
  sku: string;
  qty: number;
  cost: number;
  category: string;
  addedAt: string;
}

interface StoreLocalStateContextType {
  customers: Customer[];
  addCustomer: (c: Customer) => void;
  stockItems: StockItem[];
  addStockItem: (item: StockItem) => void;
}

const SEED_CUSTOMERS: Customer[] = [
  { id: 'c1', name: 'Alexander Wright', phone: '555-0123', email: 'alex@example.com', totalSpent: 1240, lastVisit: '2026-03-25' },
  { id: 'c2', name: 'Sarah Jenkins', phone: '555-0456', email: 'sarah@example.com', totalSpent: 890, lastVisit: '2026-03-22' },
  { id: 'c3', name: 'Mike Rodriguez', phone: '555-0789', email: 'mike@example.com', totalSpent: 320, lastVisit: '2026-03-20' },
  { id: 'c4', name: 'Emma Chen', phone: '555-0321', email: 'emma@example.com', totalSpent: 560, lastVisit: '2026-03-18' },
];

const StoreLocalStateContext = createContext<StoreLocalStateContextType | null>(null);

export function StoreLocalStateProvider({ children }: { children: React.ReactNode }) {
  const [customers, setCustomers] = useState<Customer[]>(SEED_CUSTOMERS);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);

  const addCustomer = useCallback((c: Customer) => {
    setCustomers(prev => [...prev, c]);
  }, []);

  const addStockItem = useCallback((item: StockItem) => {
    setStockItems(prev => [...prev, item]);
  }, []);

  return (
    <StoreLocalStateContext.Provider value={{ customers, addCustomer, stockItems, addStockItem }}>
      {children}
    </StoreLocalStateContext.Provider>
  );
}

export function useStoreLocalState() {
  const ctx = useContext(StoreLocalStateContext);
  if (!ctx) throw new Error('useStoreLocalState must be used within StoreLocalStateProvider');
  return ctx;
}
