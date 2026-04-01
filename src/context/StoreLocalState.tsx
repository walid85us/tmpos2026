import React, { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Customer, HeldOrder, CartItem, PaymentMethod, Discount, RepairTicket, Invoice, RepairService, RepairCategory } from '../types';
import { useAccess } from './AccessContext';

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
  repairReturnSentToPOS?: boolean;
  repairReturnOrderId?: string;
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
  pendingReplacements: { warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number; type?: 'replacement' | 'repair_return' }[];
  addPendingReplacement: (r: { warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number; type?: 'replacement' | 'repair_return' }) => void;
  removePendingReplacement: (warrantyClaimId: string) => void;
  invoices: Invoice[];
  addInvoice: (inv: Invoice) => void;
  updateInvoice: (id: string, updates: Partial<Invoice>) => void;
  deleteInvoice: (id: string) => void;
  services: RepairService[];
  addService: (s: RepairService) => void;
  updateService: (id: string, updates: Partial<RepairService>) => void;
  deleteService: (id: string) => void;
  serviceCategories: RepairCategory[];
  addServiceCategory: (c: RepairCategory) => void;
  updateServiceCategory: (id: string, updates: Partial<RepairCategory>) => void;
  deleteServiceCategory: (id: string) => void;
  findDuplicateCustomers: (name: string, email: string, phone: string) => Customer[];
}

const SEED_CUSTOMERS: Customer[] = [
  { id: 'c1', name: 'Alexander Wright', phone: '555-0123', email: 'alex@wright.com', phoneLabel: 'Mobile', totalSpent: 1240, lastVisit: '2026-03-25', loyaltyPoints: 2450, tier: 'Platinum', group: 'VIP Corporate', tags: ['VIP', 'Corporate'], notes: [{ id: 'n1', text: 'Customer prefers original parts only.', date: '2026-03-15', flagged: true }, { id: 'n2', text: 'Always pays via corporate card.', date: '2026-02-10', flagged: false }], assets: [{ id: 'a1', model: 'iPhone 15 Pro', serial: 'SN-99283-X', type: 'Smartphone' }, { id: 'a2', model: 'MacBook Pro 14"', serial: 'SN-11223-M', type: 'Laptop' }], customFields: [{ label: 'Company Name', value: 'Wright Tech Solutions' }, { label: 'Referred By', value: 'Google Search' }], gdprCompliant: true, campaignerStatus: 'Subscribed', thirdPartyBilling: true, createdAt: '2025-08-10' },
  { id: 'c2', name: 'Sarah Jenkins', phone: '555-0456', email: 'sarah.j@gmail.com', phoneLabel: 'Home', totalSpent: 890, lastVisit: '2026-03-22', loyaltyPoints: 1200, tier: 'Gold', group: 'Retail', tags: ['Retail'], notes: [], assets: [], customFields: [], gdprCompliant: true, campaignerStatus: 'Pending', createdAt: '2025-11-20' },
  { id: 'c3', name: 'Mike Rodriguez', phone: '555-0789', email: 'mike@example.com', phoneLabel: 'Mobile', totalSpent: 320, lastVisit: '2026-03-20', loyaltyPoints: 320, tier: 'Silver', group: 'Retail', tags: ['Walk-in'], notes: [{ id: 'n3', text: 'Frequently brings in devices for battery swaps.', date: '2026-03-01', flagged: false }], assets: [{ id: 'a3', model: 'Samsung S21', serial: 'SN-44521-S', type: 'Smartphone' }], customFields: [], gdprCompliant: true, campaignerStatus: 'Subscribed', createdAt: '2026-01-05' },
  { id: 'c4', name: 'Emma Chen', phone: '555-0321', email: 'emma@example.com', phoneLabel: 'Mobile', totalSpent: 560, lastVisit: '2026-03-18', loyaltyPoints: 560, tier: 'Silver', group: 'Retail', tags: [], notes: [], assets: [{ id: 'a4', model: 'iPad Air 5', serial: 'SN-88712-A', type: 'Tablet' }], customFields: [{ label: 'Referred By', value: 'Friend' }], gdprCompliant: true, campaignerStatus: 'Unsubscribed', createdAt: '2026-02-12' },
  { id: 'c5', name: 'David Park', phone: '555-0555', email: 'david.park@techco.io', phoneLabel: 'Work', totalSpent: 2100, lastVisit: '2026-03-28', loyaltyPoints: 3100, tier: 'Platinum', group: 'VIP Corporate', tags: ['VIP', 'Corporate', 'Bulk'], notes: [{ id: 'n4', text: 'Manages fleet of 20+ devices for TechCo.', date: '2026-02-20', flagged: true }], assets: [{ id: 'a5', model: 'iPhone 14 Pro Max', serial: 'SN-77234-X', type: 'Smartphone' }, { id: 'a6', model: 'MacBook Air M2', serial: 'SN-33102-M', type: 'Laptop' }], customFields: [{ label: 'Company Name', value: 'TechCo Industries' }, { label: 'Account Manager', value: 'Sarah J.' }], gdprCompliant: true, campaignerStatus: 'Subscribed', thirdPartyBilling: true, createdAt: '2025-06-15' },
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

const SEED_INVOICES: Invoice[] = [
  {
    id: 'inv-001', invoiceNumber: 'INV-2026-001', customerId: 'c1', customerName: 'Alexander Wright', customerEmail: 'alex@wright.com', customerPhone: '555-0123',
    items: [
      { id: 'ii-1', name: 'iPhone 15 Pro Screen Repair', quantity: 1, price: 249.99, type: 'repair' },
      { id: 'ii-2', name: 'Tempered Glass Protector', quantity: 2, price: 9.99, type: 'product' }
    ],
    subtotal: 269.97, discount: 0, tax: 21.60, total: 291.57, amountPaid: 291.57, balance: 0,
    status: 'Paid', createdAt: '2026-03-15', dueDate: '2026-03-15',
    paymentHistory: [{ id: 'pay-1', amount: 291.57, method: 'Credit Card', timestamp: '2026-03-15 14:30' }],
    remindersSent: 0
  },
  {
    id: 'inv-002', invoiceNumber: 'INV-2026-002', customerId: 'c2', customerName: 'Sarah Jenkins', customerEmail: 'sarah.j@gmail.com',
    items: [
      { id: 'ii-3', name: 'MacBook Air M1 Battery Replacement', quantity: 1, price: 199.99, type: 'repair' }
    ],
    subtotal: 199.99, discount: 10.00, tax: 15.20, total: 205.19, amountPaid: 100.00, balance: 105.19,
    status: 'Partially Paid', createdAt: '2026-03-18', dueDate: '2026-03-25',
    paymentHistory: [{ id: 'pay-2', amount: 100.00, method: 'Cash', timestamp: '2026-03-18 10:15' }],
    remindersSent: 1
  },
  {
    id: 'inv-003', invoiceNumber: 'INV-2026-003', customerId: 'c3', customerName: 'Mike Rodriguez',
    items: [
      { id: 'ii-4', name: 'Monthly Maintenance Plan', quantity: 1, price: 49.99, type: 'service' }
    ],
    subtotal: 49.99, discount: 0, tax: 4.00, total: 53.99, amountPaid: 0, balance: 53.99,
    status: 'Unpaid', createdAt: '2026-03-20', dueDate: '2026-03-27',
    isRecurring: true, recurringInterval: 'monthly',
    paymentHistory: [], remindersSent: 0
  },
  {
    id: 'inv-004', invoiceNumber: 'INV-2026-004', customerId: 'c5', customerName: 'David Park', customerEmail: 'david.park@techco.io', customerPhone: '555-0555',
    items: [
      { id: 'ii-5', name: 'iPad Pro 11 Charging Port Repair', quantity: 2, price: 89.99, type: 'repair' },
      { id: 'ii-6', name: 'USB-C Charging Cable', quantity: 5, price: 12.99, type: 'product' }
    ],
    subtotal: 244.93, discount: 24.49, tax: 17.64, total: 238.08, amountPaid: 0, balance: 238.08,
    status: 'Overdue', createdAt: '2026-03-10', dueDate: '2026-03-17',
    notes: 'Corporate fleet maintenance order.',
    paymentHistory: [], remindersSent: 2
  }
];

const SEED_SERVICE_CATEGORIES: RepairCategory[] = [
  { id: 'cat1', name: 'Smartphones', icon: 'smartphone' },
  { id: 'cat2', name: 'Laptops', icon: 'laptop_mac' },
  { id: 'cat3', name: 'Tablets', icon: 'tablet_mac' },
  { id: 'cat4', name: 'Game Consoles', icon: 'videogame_asset' }
];

const SEED_SERVICES: RepairService[] = [
  { id: 's1', name: 'iPhone 13 Screen Replacement', categoryId: 'cat1', categoryName: 'Smartphones', price: 129.99, cost: 45.00, estimatedTime: 45, flagNotes: 'Handle OLED with care. Check FaceID after repair.', status: 'Active', sku: 'SRV-IP13-SCR', warrantyPeriod: '90 days', warrantyType: 'labor' },
  { id: 's2', name: 'MacBook Air M1 Battery Replacement', categoryId: 'cat2', categoryName: 'Laptops', price: 199.99, cost: 80.00, estimatedTime: 60, status: 'Active', sku: 'SRV-MBA-BAT', warrantyPeriod: '180 days', warrantyType: 'parts-and-labor' },
  { id: 's3', name: 'iPad Pro 11 Charging Port Repair', categoryId: 'cat3', categoryName: 'Tablets', price: 89.99, cost: 15.00, estimatedTime: 90, flagNotes: 'Requires micro-soldering.', status: 'Active', sku: 'SRV-IPP-CHG', warrantyPeriod: '90 days', warrantyType: 'labor' },
  { id: 's4', name: 'iPhone 15 Pro Screen Replacement', categoryId: 'cat1', categoryName: 'Smartphones', price: 249.99, cost: 95.00, estimatedTime: 50, flagNotes: 'Dynamic Island alignment critical.', status: 'Active', sku: 'SRV-IP15P-SCR', warrantyPeriod: '90 days', warrantyType: 'parts-and-labor' },
  { id: 's5', name: 'PS5 HDMI Port Repair', categoryId: 'cat4', categoryName: 'Game Consoles', price: 149.99, cost: 25.00, estimatedTime: 120, flagNotes: 'Micro-soldering required. Test with 4K output.', status: 'Active', sku: 'SRV-PS5-HDMI', warrantyPeriod: '30 days', warrantyType: 'labor' },
  { id: 's6', name: 'Samsung S21 Battery Replacement', categoryId: 'cat1', categoryName: 'Smartphones', price: 79.99, cost: 22.00, estimatedTime: 40, status: 'Active', sku: 'SRV-SS21-BAT', warrantyPeriod: '90 days', warrantyType: 'parts-and-labor' },
];

const EMPTY_DRAFT: DraftCart = { cart: [], selectedCustomer: null, payments: [], discounts: [] };

const StoreLocalStateContext = createContext<StoreLocalStateContextType | null>(null);

export function StoreLocalStateProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAccess();
  const [customers, setCustomers] = useState<Customer[]>(SEED_CUSTOMERS);
  const [stockItems, setStockItems] = useState<StockItem[]>(SEED_STOCK_ITEMS);
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);
  const [suggestiveSalesItems, setSuggestiveSalesItems] = useState<SuggestiveSaleItem[]>(SEED_SUGGESTIVE_SALES);
  const [draftCart, setDraftCartState] = useState<DraftCart>(EMPTY_DRAFT);
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>(SEED_COMPLETED_ORDERS);
  const [refundRecords, setRefundRecords] = useState<RefundRecord[]>([]);
  const [warrantyClaims, setWarrantyClaims] = useState<WarrantyClaimRecord[]>(SEED_WARRANTY_CLAIMS);
  const [posOperator, setPosOperatorState] = useState<POSOperator | null>(null);
  const [warrantyRepairTickets, setWarrantyRepairTickets] = useState<RepairTicket[]>([]);
  const [pendingReplacements, setPendingReplacements] = useState<{ warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number; type?: 'replacement' | 'repair_return' }[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>(SEED_INVOICES);
  const [services, setServices] = useState<RepairService[]>(SEED_SERVICES);
  const [serviceCategories, setServiceCategories] = useState<RepairCategory[]>(SEED_SERVICE_CATEGORIES);

  const prevSessionRoleRef = useRef(session?.role);
  useEffect(() => {
    if (prevSessionRoleRef.current !== undefined && session?.role !== prevSessionRoleRef.current) {
      setPosOperatorState(null);
    }
    prevSessionRoleRef.current = session?.role;
  }, [session?.role]);

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

  const addPendingReplacement = useCallback((r: { warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number; type?: 'replacement' | 'repair_return' }) => {
    setPendingReplacements(prev => {
      if (prev.some(p => p.warrantyClaimId === r.warrantyClaimId)) return prev;
      return [...prev, r];
    });
  }, []);

  const removePendingReplacement = useCallback((warrantyClaimId: string) => {
    setPendingReplacements(prev => prev.filter(r => r.warrantyClaimId !== warrantyClaimId));
  }, []);

  const addInvoice = useCallback((inv: Invoice) => {
    setInvoices(prev => [inv, ...prev]);
  }, []);

  const updateInvoice = useCallback((id: string, updates: Partial<Invoice>) => {
    setInvoices(prev => prev.map(inv => inv.id === id ? { ...inv, ...updates } : inv));
  }, []);

  const deleteInvoice = useCallback((id: string) => {
    setInvoices(prev => prev.filter(inv => inv.id !== id));
  }, []);

  const addService = useCallback((s: RepairService) => {
    setServices(prev => [...prev, s]);
  }, []);

  const updateService = useCallback((id: string, updates: Partial<RepairService>) => {
    setServices(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const deleteService = useCallback((id: string) => {
    setServices(prev => prev.filter(s => s.id !== id));
  }, []);

  const addServiceCategory = useCallback((c: RepairCategory) => {
    setServiceCategories(prev => [...prev, c]);
  }, []);

  const updateServiceCategory = useCallback((id: string, updates: Partial<RepairCategory>) => {
    setServiceCategories(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  }, []);

  const deleteServiceCategory = useCallback((id: string) => {
    setServiceCategories(prev => prev.filter(c => c.id !== id));
  }, []);

  const findDuplicateCustomers = useCallback((name: string, email: string, phone: string) => {
    const n = name.trim().toLowerCase();
    const e = email.trim().toLowerCase();
    const p = phone.trim();
    return customers.filter(c => {
      if (e && c.email.toLowerCase() === e) return true;
      if (p && c.phone === p) return true;
      if (n && c.name.toLowerCase() === n) return true;
      return false;
    });
  }, [customers]);

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
      invoices, addInvoice, updateInvoice, deleteInvoice,
      services, addService, updateService, deleteService,
      serviceCategories, addServiceCategory, updateServiceCategory, deleteServiceCategory,
      findDuplicateCustomers,
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
