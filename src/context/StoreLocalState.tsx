import React, { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Customer, HeldOrder, CartItem, PaymentMethod, Discount, RepairTicket, RepairTicketStatus, Invoice, RepairService, RepairCategory, DocumentTemplate, StoreBranding, LogoPlacement, Supplier, StockMovement, StockMovementType, PurchaseOrder, GoodsReceivedNote, RMA, InventoryTransfer, InventoryCount, TradeInItem, RefurbishmentJob, SupplierRefundEntry, Shipment, ShippingProviderConfig, Return, AutomationRule, AutomationLogEntry, ShipmentBatch, PackingException, PackingExceptionType, PackingHistoryEntry, PackingItemVerification, PackingPackageVerification, PackingHistoryAction } from '../types';
import { useAccess } from './AccessContext';
import { buildTemplateHtml, getDefaultEnabledTags } from '../utils/templateBuilder';

export interface StockItem {
  id: string;
  name: string;
  sku: string;
  upc?: string;
  qty: number;
  cost: number;
  price: number;
  category: string;
  type: 'serialized' | 'non-serialized' | 'handset';
  manufacturer?: string;
  isRepairPart: boolean;
  isHiddenOnPOS: boolean;
  serialNumbers?: string[];
  minStockLevel?: number;
  maxStockLevel?: number;
  location?: string;
  taxId?: string;
  description?: string;
  images?: string[];
  supplierId?: string;
  supplierName?: string;
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
  deviceName?: string;
  imei?: string;
  serialNumber?: string;
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

export interface LoyaltyTier {
  id: string;
  name: string;
  minPoints: number;
  status: 'active' | 'inactive';
  description?: string;
  privileges?: string[];
}

export interface LoyaltyProgramConfig {
  enabled: boolean;
  pointsPerDollar: number;
  tiers: LoyaltyTier[];
}

export interface LoyaltyAdjustment {
  id: string;
  customerId: string;
  adjustment: number;
  reason: string;
  adjustedBy: string;
  timestamp: string;
}

export interface POSOperator {
  id: string;
  name: string;
  role: string;
  pin: string;
}

/**
 * Phase 4.0 M3 — runtime reachability of the Shipping backend, held SEPARATELY from
 * `shippingProviderConfig` (which is what the store has CONFIGURED, not what is reachable).
 *
 * Deliberately three-valued. Reachability was previously a page-local `useState(false)`
 * boolean, which cannot distinguish "not probed yet" from "probed, and reachable" — so the
 * whole pre-probe window read as available and let backend-backed writes through.
 * `unknown` is the initial state and callers must treat it as fail-closed.
 *
 * Availability NEVER rewrites configuration: an unreachable service says nothing about
 * what the store configured, so `unavailable` must not be recorded as "no provider
 * configured". That conflation is what forced operators to re-enter credentials that
 * were never actually lost.
 */
export type ShippingServiceAvailability = 'unknown' | 'available' | 'unavailable';

interface StoreLocalStateContextType {
  customers: Customer[];
  addCustomer: (c: Customer) => void;
  updateCustomer: (id: string, updates: Partial<Customer>) => void;
  stockItems: StockItem[];
  addStockItem: (item: StockItem) => void;
  updateStockItem: (id: string, updates: Partial<StockItem>) => void;
  deleteStockItem: (id: string) => void;
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
  repairTickets: RepairTicket[];
  addRepairTicket: (ticket: RepairTicket) => void;
  updateRepairTicket: (id: string, updates: Partial<RepairTicket>) => void;
  deleteRepairTicket: (id: string) => void;
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
  loyaltyConfig: LoyaltyProgramConfig;
  updateLoyaltyConfig: (updates: Partial<LoyaltyProgramConfig>) => void;
  loyaltyAdjustments: LoyaltyAdjustment[];
  addLoyaltyAdjustment: (adj: LoyaltyAdjustment) => void;
  documentTemplates: DocumentTemplate[];
  updateDocumentTemplate: (id: string, updates: Partial<DocumentTemplate>) => void;
  resetDocumentTemplate: (id: string) => void;
  storeBranding: StoreBranding;
  updateStoreBranding: (updates: Partial<StoreBranding>) => void;
  suppliers: Supplier[];
  addSupplier: (s: Supplier) => void;
  updateSupplier: (id: string, updates: Partial<Supplier>) => void;
  stockMovements: StockMovement[];
  addStockMovement: (m: StockMovement) => void;
  purchaseOrders: PurchaseOrder[];
  addPurchaseOrder: (po: PurchaseOrder) => void;
  updatePurchaseOrder: (id: string, updates: Partial<PurchaseOrder>) => void;
  goodsReceivedNotes: GoodsReceivedNote[];
  addGoodsReceivedNote: (grn: GoodsReceivedNote) => void;
  rmas: RMA[];
  addRMA: (rma: RMA) => void;
  updateRMA: (id: string, updates: Partial<RMA>) => void;
  inventoryTransfers: InventoryTransfer[];
  addInventoryTransfer: (t: InventoryTransfer) => void;
  updateInventoryTransfer: (id: string, updates: Partial<InventoryTransfer>) => void;
  inventoryCounts: InventoryCount[];
  addInventoryCount: (c: InventoryCount) => void;
  updateInventoryCount: (id: string, updates: Partial<InventoryCount>) => void;
  tradeIns: TradeInItem[];
  addTradeIn: (t: TradeInItem) => void;
  updateTradeIn: (id: string, updates: Partial<TradeInItem>) => void;
  deleteTradeIn: (id: string) => void;
  refurbishmentJobs: RefurbishmentJob[];
  addRefurbishmentJob: (j: RefurbishmentJob) => void;
  updateRefurbishmentJob: (id: string, updates: Partial<RefurbishmentJob>) => void;
  supplierRefundEntries: SupplierRefundEntry[];
  addSupplierRefundEntry: (entry: SupplierRefundEntry) => void;
  shipments: Shipment[];
  addShipment: (s: Shipment) => void;
  updateShipment: (id: string, updates: Partial<Shipment>) => void;
  // Phase 3 correction — atomic resolve for the automation review-needed
  // state. Sets resolved fields on `reviewNeeded` (preserving the original
  // rule source for audit) and appends an internal audit note in the same
  // setter so the resolution is auditable end-to-end.
  resolveShipmentReview: (id: string, args: { resolvedBy: string; note?: string }) => void;
  // Phase 3 correction #3 — generalized review-outcome setter. Resolution
  // 'resolve' clears a review-needed badge (legacy behavior, observational
  // rules); 'approve' approves a guardrail exception so a flagged action can
  // proceed; 'override' overrides a still-failing block; 'dismiss' marks a
  // review needed as no-op (false alarm). Each writes its own audit note and
  // sets the matching state on `Shipment.reviewNeeded`.
  setReviewOutcome: (id: string, args: {
    resolution: 'resolve' | 'approve' | 'override' | 'dismiss';
    actor: string;
    note?: string;
  }) => void;
  // Phase 3 Pass #10 — Packing Workflows mutators. Each call writes the
  // matching packing field(s), appends a PackingHistoryEntry, and appends a
  // matching internal-note audit row in the same setShipments transaction so
  // the audit trail is atomic. The UI is responsible for firing the matching
  // observational automation trigger AFTER calling the mutator.
  startPacking: (id: string, args: { actor: string; note?: string }) => { ok: boolean };
  recordPackingItemVerification: (id: string, args: {
    sourceItemKey: string; name: string; expectedQty: number; verifiedQty: number;
    actor: string; note?: string;
  }) => void;
  recordPackingPackageVerification: (id: string, args: {
    packageId: string; weightConfirmed: boolean; dimensionsConfirmed: boolean;
    actor: string; note?: string;
  }) => void;
  addPackingException: (id: string, args: {
    type: PackingExceptionType; description: string; actor: string;
    packageId?: string; sourceItemKey?: string;
  }) => string | null;
  resolvePackingException: (id: string, args: {
    exceptionId: string; actor: string; resolutionNote: string;
  }) => void;
  completePackingForShipment: (id: string, args: {
    actor: string; note?: string; override?: boolean; overrideReason?: string;
    expectedSourceItems?: { key: string; expectedQty: number }[];
  }) => { ok: true } | { ok: false; reason: string };
  reopenPacking: (id: string, args: { actor: string; note: string }) => void;
  markPackingNotRequired: (id: string, args: { actor: string; note: string }) => void;
  automationRules: AutomationRule[];
  addAutomationRule: (rule: AutomationRule) => void;
  updateAutomationRule: (id: string, updates: Partial<AutomationRule>) => void;
  deleteAutomationRule: (id: string) => void;
  bumpAutomationRuleStats: (entries: { ruleId: string; runDelta: number; matchDelta: number; lastEvaluation?: AutomationRule['lastEvaluation'] }[], lastRunAt: string) => void;
  automationLogs: AutomationLogEntry[];
  appendAutomationLogs: (entries: AutomationLogEntry[]) => void;
  shipmentBatches: ShipmentBatch[];
  addShipmentBatch: (batch: ShipmentBatch) => void;
  updateShipmentBatch: (id: string, updates: Partial<ShipmentBatch>) => void;
  shippingProviderConfig: ShippingProviderConfig | null;
  setShippingProviderConfig: (config: ShippingProviderConfig | null) => void;
  shippingServiceAvailability: ShippingServiceAvailability;
  setShippingServiceAvailability: (availability: ShippingServiceAvailability) => void;
  returns: Return[];
  addReturn: (r: Return) => void;
  updateReturn: (id: string, updates: Partial<Return>) => void;
  storeLocations: string[];
  getItemMovements: (stockItemId: string) => StockMovement[];
}

const SEED_CUSTOMERS: Customer[] = [
  { id: 'c1', name: 'Alexander Wright', phone: '555-0123', email: 'alex@wright.com', phoneLabel: 'Mobile', totalSpent: 1240, lastVisit: '2026-03-25', loyaltyPoints: 2450, tier: 'Platinum', group: 'VIP Corporate', tags: ['VIP', 'Corporate'], notes: [{ id: 'n1', text: 'Customer prefers original parts only.', date: '2026-03-15', flagged: true }, { id: 'n2', text: 'Always pays via corporate card.', date: '2026-02-10', flagged: false }], assets: [{ id: 'a1', model: 'iPhone 15 Pro', serial: 'SN-99283-X', type: 'Smartphone' }, { id: 'a2', model: 'MacBook Pro 14"', serial: 'SN-11223-M', type: 'Laptop' }], customFields: [{ label: 'Company Name', value: 'Wright Tech Solutions' }, { label: 'Referred By', value: 'Google Search' }], gdprCompliant: true, campaignerStatus: 'Subscribed', thirdPartyBilling: true, createdAt: '2025-08-10' },
  { id: 'c2', name: 'Sarah Jenkins', phone: '555-0456', email: 'sarah.j@gmail.com', phoneLabel: 'Home', totalSpent: 890, lastVisit: '2026-03-22', loyaltyPoints: 1200, tier: 'Gold', group: 'Retail', tags: ['Retail'], notes: [], assets: [], customFields: [], gdprCompliant: true, campaignerStatus: 'Pending', createdAt: '2025-11-20' },
  { id: 'c3', name: 'Mike Rodriguez', phone: '555-0789', email: 'mike@example.com', phoneLabel: 'Mobile', totalSpent: 320, lastVisit: '2026-03-20', loyaltyPoints: 320, tier: 'Silver', group: 'Retail', tags: ['Walk-in'], notes: [{ id: 'n3', text: 'Frequently brings in devices for battery swaps.', date: '2026-03-01', flagged: false }], assets: [{ id: 'a3', model: 'Samsung S21', serial: 'SN-44521-S', type: 'Smartphone' }], customFields: [], gdprCompliant: true, campaignerStatus: 'Subscribed', createdAt: '2026-01-05' },
  { id: 'c4', name: 'Emma Chen', phone: '555-0321', email: 'emma@example.com', phoneLabel: 'Mobile', totalSpent: 560, lastVisit: '2026-03-18', loyaltyPoints: 560, tier: 'Silver', group: 'Retail', tags: [], notes: [], assets: [{ id: 'a4', model: 'iPad Air 5', serial: 'SN-88712-A', type: 'Tablet' }], customFields: [{ label: 'Referred By', value: 'Friend' }], gdprCompliant: true, campaignerStatus: 'Unsubscribed', createdAt: '2026-02-12' },
  { id: 'c5', name: 'David Park', phone: '555-0555', email: 'david.park@techco.io', phoneLabel: 'Work', totalSpent: 2100, lastVisit: '2026-03-28', loyaltyPoints: 3100, tier: 'Platinum', group: 'VIP Corporate', tags: ['VIP', 'Corporate', 'Bulk'], notes: [{ id: 'n4', text: 'Manages fleet of 20+ devices for TechCo.', date: '2026-02-20', flagged: true }], assets: [{ id: 'a5', model: 'iPhone 14 Pro Max', serial: 'SN-77234-X', type: 'Smartphone' }, { id: 'a6', model: 'MacBook Air M2', serial: 'SN-33102-M', type: 'Laptop' }], customFields: [{ label: 'Company Name', value: 'TechCo Industries' }, { label: 'Account Manager', value: 'Sarah J.' }], gdprCompliant: true, campaignerStatus: 'Subscribed', thirdPartyBilling: true, createdAt: '2025-06-15' },
];

const SEED_STOCK_ITEMS: StockItem[] = [
  { id: 'stk-001', name: 'iPhone 13 Screen', sku: 'IP13-SCR-001', qty: 12, cost: 45.00, price: 89.00, category: 'Parts', type: 'non-serialized', isRepairPart: true, isHiddenOnPOS: false, manufacturer: 'Apple OEM', minStockLevel: 5, maxStockLevel: 30, location: 'Shelf A-1', supplierId: 'sup-001', supplierName: 'Global Parts Inc.', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-002', name: 'USB-C Charging Cable', sku: 'USB-C-CBL-01', upc: '012345678901', qty: 50, cost: 3.50, price: 12.99, category: 'Accessories', type: 'non-serialized', isRepairPart: false, isHiddenOnPOS: false, manufacturer: 'Anker', minStockLevel: 10, maxStockLevel: 100, addedAt: '2026-03-20T10:00:00Z', status: 'approved', isSuggestiveSale: true },
  { id: 'stk-003', name: 'Samsung S21 Battery', sku: 'SAM-S21-BAT', qty: 8, cost: 22.00, price: 45.00, category: 'Parts', type: 'non-serialized', isRepairPart: true, isHiddenOnPOS: false, manufacturer: 'Samsung OEM', minStockLevel: 3, maxStockLevel: 20, location: 'Shelf B-2', supplierId: 'sup-001', supplierName: 'Global Parts Inc.', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-004', name: 'Tempered Glass Protector', sku: 'TG-UNIV-001', upc: '012345678902', qty: 100, cost: 2.00, price: 9.99, category: 'Accessories', type: 'non-serialized', isRepairPart: false, isHiddenOnPOS: false, minStockLevel: 20, maxStockLevel: 200, addedAt: '2026-03-20T10:00:00Z', status: 'approved', isSuggestiveSale: true },
  { id: 'stk-005', name: 'iPad Air 5 Digitizer', sku: 'IPAD-A5-DIG', qty: 4, cost: 65.00, price: 129.00, category: 'Parts', type: 'non-serialized', isRepairPart: true, isHiddenOnPOS: false, manufacturer: 'Apple OEM', minStockLevel: 2, maxStockLevel: 15, location: 'Shelf A-3', supplierId: 'sup-002', supplierName: 'Tech Sourcing Co.', addedAt: '2026-03-20T10:00:00Z', status: 'approved' },
  { id: 'stk-006', name: 'iPhone 14 Pro OLED Screen', sku: 'IP14P-OLED-001', qty: 6, cost: 95.00, price: 189.00, category: 'Parts', type: 'non-serialized', isRepairPart: true, isHiddenOnPOS: false, manufacturer: 'Apple OEM', minStockLevel: 3, maxStockLevel: 15, location: 'Shelf A-2', supplierId: 'sup-001', supplierName: 'Global Parts Inc.', addedAt: '2026-03-18T10:00:00Z', status: 'approved' },
  { id: 'stk-007', name: 'iPhone 15 Pro Refurbished', sku: 'IP15P-REF-001', qty: 2, cost: 650.00, price: 899.00, category: 'Devices', type: 'serialized', isRepairPart: false, isHiddenOnPOS: false, manufacturer: 'Apple', serialNumbers: ['IMEI-352901234567890', 'IMEI-352901234567891'], minStockLevel: 1, maxStockLevel: 5, location: 'Display Case', addedAt: '2026-03-15T10:00:00Z', status: 'approved' },
  { id: 'stk-008', name: 'Samsung Galaxy S23 Back Glass', sku: 'SAM-S23-BG', qty: 15, cost: 18.00, price: 35.00, category: 'Parts', type: 'non-serialized', isRepairPart: true, isHiddenOnPOS: true, manufacturer: 'Samsung OEM', minStockLevel: 5, maxStockLevel: 30, location: 'Shelf B-3', supplierId: 'sup-001', supplierName: 'Global Parts Inc.', addedAt: '2026-03-10T10:00:00Z', status: 'approved' },
  { id: 'stk-009', name: 'Lightning Cable (MFi)', sku: 'LTN-CBL-MFI', upc: '012345678903', qty: 35, cost: 5.00, price: 14.99, category: 'Accessories', type: 'non-serialized', isRepairPart: false, isHiddenOnPOS: false, minStockLevel: 10, maxStockLevel: 60, addedAt: '2026-03-08T10:00:00Z', status: 'approved' },
  { id: 'stk-010', name: 'Wireless Charger Pad', sku: 'WC-PAD-001', upc: '012345678904', qty: 20, cost: 12.00, price: 29.99, category: 'Accessories', type: 'non-serialized', isRepairPart: false, isHiddenOnPOS: false, minStockLevel: 5, maxStockLevel: 40, addedAt: '2026-03-05T10:00:00Z', status: 'approved', isSuggestiveSale: true },
  { id: 'stk-011', name: 'PS5 HDMI Port IC', sku: 'PS5-HDMI-IC', qty: 3, cost: 8.00, price: 25.00, category: 'Parts', type: 'non-serialized', isRepairPart: true, isHiddenOnPOS: true, manufacturer: 'Generic', minStockLevel: 2, maxStockLevel: 10, location: 'Shelf C-1', supplierId: 'sup-002', supplierName: 'Tech Sourcing Co.', addedAt: '2026-03-01T10:00:00Z', status: 'approved' },
  { id: 'stk-012', name: 'MacBook Air M1 Battery', sku: 'MBA-M1-BAT', qty: 0, cost: 80.00, price: 159.00, category: 'Parts', type: 'non-serialized', isRepairPart: true, isHiddenOnPOS: true, manufacturer: 'Apple OEM', minStockLevel: 2, maxStockLevel: 8, location: 'Shelf A-4', supplierId: 'sup-002', supplierName: 'Tech Sourcing Co.', addedAt: '2026-02-28T10:00:00Z', status: 'approved' },
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
  {
    id: 'ord-005', invoiceNumber: 'INV-1005', customerId: 'c1', customerName: 'Alexander Wright', customerPhone: '555-0123', customerEmail: 'alex@example.com',
    items: [
      { id: 'oi-8', name: 'iPhone 12 Back Glass Repair', qty: 1, unitPrice: 149.00, type: 'repair', warrantyPeriod: '90 days' },
      { id: 'oi-9', name: 'Lightning Cable', qty: 1, unitPrice: 14.99, type: 'product', warrantyPeriod: '30 days' },
    ],
    subtotal: 163.99, discountTotal: 0, tax: 13.53, total: 177.52,
    payments: [{ method: 'Cash', amount: 177.52 }],
    status: 'Paid', createdAt: '2025-11-15T10:30:00Z', operatorName: 'Sarah J.',
  },
  {
    id: 'ord-006', invoiceNumber: 'INV-1006', customerId: 'c3', customerName: 'Mike Rodriguez', customerPhone: '555-0789', customerEmail: 'mike@example.com',
    items: [
      { id: 'oi-10', name: 'Samsung Galaxy S20 Screen Replacement', qty: 1, unitPrice: 179.00, type: 'repair', warrantyPeriod: '90 days' },
      { id: 'oi-11', name: 'Wireless Charger Pad', qty: 1, unitPrice: 29.99, type: 'product', warrantyPeriod: '30 days' },
    ],
    subtotal: 208.99, discountTotal: 0, tax: 17.24, total: 226.23,
    payments: [{ method: 'Card Terminal', amount: 226.23 }],
    status: 'Paid', createdAt: '2025-10-20T14:00:00Z', operatorName: 'Mike R.',
  },
];

const SEED_POS_OPERATORS: POSOperator[] = [
  { id: 'op-1', name: 'Sarah Johnson', role: 'Manager', pin: '1234' },
  { id: 'op-2', name: 'Mike Torres', role: 'Sales Associate', pin: '5678' },
  { id: 'op-3', name: 'Alex Kim', role: 'Technician', pin: '9012' },
  { id: 'op-4', name: 'Dana Lee', role: 'Sales Associate', pin: '3456' },
];

export { SEED_POS_OPERATORS };

const SEED_LOYALTY_CONFIG: LoyaltyProgramConfig = {
  enabled: true,
  pointsPerDollar: 10,
  tiers: [
    { id: 'lt-1', name: 'Bronze', minPoints: 0, status: 'active', description: 'Entry tier for all customers', privileges: ['Earn points on purchases'] },
    { id: 'lt-2', name: 'Silver', minPoints: 500, status: 'active', description: 'Unlocked at 500 points', privileges: ['Earn points on purchases', '5% off repairs'] },
    { id: 'lt-3', name: 'Gold', minPoints: 2000, status: 'active', description: 'Unlocked at 2000 points', privileges: ['Earn points on purchases', '10% off repairs', 'Priority service'] },
    { id: 'lt-4', name: 'Platinum', minPoints: 5000, status: 'active', description: 'Top tier at 5000 points', privileges: ['Earn points on purchases', '15% off repairs', 'Priority service', 'Free diagnostics'] },
  ],
};

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

const SEED_REPAIR_TICKETS: RepairTicket[] = [
  {
    id: 'rt-1', ticketNumber: 'T-1001', customerId: 'c1', customerName: 'Alexander Wright', customerPhone: '(555) 012-3456', customerEmail: 'alexander.wright@example.com',
    device: 'iPhone 14 Pro', deviceCategory: 'Smartphones', brand: 'Apple', model: '14 Pro', issue: 'Screen Replacement',
    status: 'In Progress', priority: 'High', createdAt: '2026-03-15T10:00:00Z', updatedAt: '2026-03-15T10:00:00Z',
    estimatedCost: 249, technicianId: 'op-3', technicianName: 'Alex Kim', location: 'Shelf A-1',
    diagnosticNotes: 'Screen is cracked, digitizer unresponsive. FaceID seems intact.',
    intakeNotes: 'Customer dropped phone from 2nd floor balcony. Needs ASAP.',
    preRepairCondition: ['Cracked Screen', 'Scratched Frame', 'Power On'],
    imei: '351234567890123', network: 'Verizon',
    serviceLineItems: [{ id: 'sli-1', serviceId: 's4', name: 'iPhone 15 Pro Screen Replacement', price: 249.99, cost: 95.00, warrantyPeriod: '90 days' }],
    history: [
      { id: 'h1', action: 'Ticket Created', performedBy: 'System', timestamp: '2026-03-15T10:00:00Z' },
      { id: 'h2', action: 'Assigned to Alex Kim', performedBy: 'Admin', timestamp: '2026-03-15T10:05:00Z' },
      { id: 'h3', action: 'Status → In Progress', performedBy: 'Alex Kim', timestamp: '2026-03-15T11:00:00Z' }
    ],
    comments: [
      { id: 'com1', authorId: 'op-3', authorName: 'Alex Kim', text: 'Part ordered from primary supplier. ETA 2 days.', createdAt: '2026-03-15T11:00:00Z', isInternal: true },
      { id: 'com2', authorId: 'op-1', authorName: 'Sarah Johnson', text: 'Customer approved the repair cost.', createdAt: '2026-03-15T14:00:00Z', isInternal: false }
    ]
  },
  {
    id: 'rt-2', ticketNumber: 'T-1002', customerId: 'c2', customerName: 'Sarah Jenkins', customerPhone: '(555) 045-6789',
    device: 'MacBook Pro 14"', deviceCategory: 'Laptops', brand: 'Apple', model: 'Pro 14"', issue: 'Battery Replacement',
    status: 'Diagnosed', priority: 'Medium', createdAt: '2026-03-16T14:30:00Z', updatedAt: '2026-03-16T14:30:00Z',
    estimatedCost: 199, technicianId: 'op-3', technicianName: 'Alex Kim', location: 'Bench 2',
    diagnosticNotes: 'Battery health at 42%. Cycle count: 1,200. Recommend full replacement.',
    intakeNotes: 'Battery drains within 2 hours even with minimal usage.',
    preRepairCondition: ['Working Display', 'Normal Boot', 'Battery Swollen'],
    serialNumber: 'C02X12345678',
    serviceLineItems: [{ id: 'sli-2', serviceId: 's2', name: 'MacBook Air M1 Battery Replacement', price: 199.99, cost: 80.00, warrantyPeriod: '180 days' }],
    history: [
      { id: 'h4', action: 'Ticket Created', performedBy: 'System', timestamp: '2026-03-16T14:30:00Z' },
      { id: 'h5', action: 'Assigned to Alex Kim', performedBy: 'Admin', timestamp: '2026-03-16T14:35:00Z' },
      { id: 'h6', action: 'Status → Diagnosed', performedBy: 'Alex Kim', timestamp: '2026-03-16T15:30:00Z' }
    ]
  },
  {
    id: 'rt-3', ticketNumber: 'T-1003', customerId: 'c3', customerName: 'Mike Rodriguez', customerPhone: '(555) 078-9012',
    device: 'Samsung Galaxy S21', deviceCategory: 'Smartphones', brand: 'Samsung', model: 'Galaxy S21', issue: 'Battery Replacement',
    status: 'Completed', priority: 'Low', createdAt: '2026-03-17T09:15:00Z', updatedAt: '2026-03-18T16:00:00Z',
    estimatedCost: 79.99, actualCost: 79.99, technicianId: 'op-3', technicianName: 'Alex Kim', location: 'Completed Shelf',
    diagnosticNotes: 'Battery health critical. Device shutting down at 40%.',
    intakeNotes: 'Phone dies too quickly. Wants battery replacement.',
    preRepairCondition: ['Working Display', 'Power On', 'Battery Issues'],
    postRepairCondition: ['Working Display', 'Power On', 'Battery Health 100%'],
    imei: '352109876543210', network: 'AT&T',
    serviceLineItems: [{ id: 'sli-3', serviceId: 's6', name: 'Samsung S21 Battery Replacement', price: 79.99, cost: 22.00, warrantyPeriod: '90 days' }],
    partsUsed: [{ itemId: 'stk-003', name: 'Samsung S21 Battery', price: 45.00, quantity: 1 }],
    linkedInvoiceId: 'inv-rt3',
    history: [
      { id: 'h7', action: 'Ticket Created', performedBy: 'System', timestamp: '2026-03-17T09:15:00Z' },
      { id: 'h8', action: 'Status → Completed', performedBy: 'Alex Kim', timestamp: '2026-03-18T16:00:00Z' }
    ]
  },
  {
    id: 'rt-4', ticketNumber: 'T-1004', customerId: 'c4', customerName: 'Emma Chen', customerPhone: '(555) 032-1456',
    device: 'Samsung Galaxy S23', deviceCategory: 'Smartphones', brand: 'Samsung', model: 'Galaxy S23', issue: 'Back Glass Replacement',
    status: 'Ready for Pickup', priority: 'Medium', createdAt: '2026-03-19T11:20:00Z', updatedAt: '2026-03-19T16:45:00Z',
    estimatedCost: 89, actualCost: 79.99, technicianId: 'op-3', technicianName: 'Alex Kim', location: 'Pickup Counter',
    diagnosticNotes: 'Back glass shattered. Camera module intact.',
    intakeNotes: 'Customer sat on phone. Back glass is cracked but phone works fine.',
    preRepairCondition: ['Shattered Back Glass', 'Working Display', 'Power On'],
    postRepairCondition: ['New Back Glass', 'Working Display', 'Power On'],
    imei: '352567890123456', network: 'T-Mobile',
    serviceLineItems: [{ id: 'sli-4', serviceId: 's6', name: 'Samsung S21 Battery Replacement', price: 79.99, cost: 22.00, warrantyPeriod: '90 days' }],
    partsUsed: [{ itemId: 'stk-008', name: 'Samsung Galaxy S23 Back Glass', price: 35.00, quantity: 1 }],
    history: [
      { id: 'h9', action: 'Ticket Created', performedBy: 'System', timestamp: '2026-03-19T11:20:00Z' },
      { id: 'h10', action: 'Assigned to Alex Kim', performedBy: 'Admin', timestamp: '2026-03-19T11:25:00Z' },
      { id: 'h11', action: 'Status → In Progress', performedBy: 'Alex Kim', timestamp: '2026-03-19T12:00:00Z' },
      { id: 'h12', action: 'Part Added: Samsung S23 Back Glass OEM', performedBy: 'Alex Kim', timestamp: '2026-03-19T13:00:00Z' },
      { id: 'h13', action: 'Status → Ready for Pickup', performedBy: 'Alex Kim', timestamp: '2026-03-19T16:45:00Z' }
    ]
  },
  {
    id: 'rt-5', ticketNumber: 'T-1005', customerId: 'c1', customerName: 'Alexander Wright',
    device: 'PS5 Console', deviceCategory: 'Game Consoles', brand: 'Sony', model: 'PS5 Disc Edition', issue: 'HDMI Port Not Working',
    status: 'Pending', priority: 'Medium', createdAt: '2026-03-20T10:00:00Z', updatedAt: '2026-03-20T10:00:00Z',
    estimatedCost: 149.99, location: 'Intake Shelf',
    intakeNotes: 'No video output. Audio works through headset. Customer suspects HDMI port damage.',
    preRepairCondition: ['No Video Output', 'Power On', 'Audio OK'],
    serialNumber: 'CFI-1215A-78901',
    history: [
      { id: 'h14', action: 'Ticket Created', performedBy: 'System', timestamp: '2026-03-20T10:00:00Z' }
    ]
  }
];

const SEED_SUPPLIERS: Supplier[] = [
  { id: 'sup-001', name: 'Global Parts Inc.', contactName: 'James Wilson', email: 'orders@globalparts.com', phone: '800-555-0100', address: '123 Parts Ave, Los Angeles, CA 90001', status: 'Active', createdAt: '2025-01-15' },
  { id: 'sup-002', name: 'Tech Sourcing Co.', contactName: 'Lisa Chen', email: 'supply@techsourcing.com', phone: '800-555-0200', address: '456 Tech Blvd, San Jose, CA 95110', website: 'https://techsourcing.com', status: 'Active', createdAt: '2025-02-20' },
  { id: 'sup-003', name: 'Premium Displays Ltd.', contactName: 'Mark Thompson', email: 'sales@premiumdisplays.com', phone: '800-555-0300', status: 'Active', createdAt: '2025-06-10' },
];

const SEED_STOCK_MOVEMENTS: StockMovement[] = [
  { id: 'sm-001', stockItemId: 'stk-001', stockItemName: 'iPhone 13 Screen', type: 'initial_stock', quantityChange: 12, previousQty: 0, newQty: 12, performedBy: 'System', timestamp: '2026-03-20T10:00:00Z', notes: 'Initial stock load' },
  { id: 'sm-002', stockItemId: 'stk-003', stockItemName: 'Samsung S21 Battery', type: 'repair_consumption', quantityChange: -1, previousQty: 9, newQty: 8, referenceId: 'rt-3', referenceType: 'repair_ticket', performedBy: 'Alex Kim', timestamp: '2026-03-17T14:00:00Z', reason: 'Used in repair T-1003' },
  { id: 'sm-003', stockItemId: 'stk-008', stockItemName: 'Samsung Galaxy S23 Back Glass', type: 'repair_consumption', quantityChange: -1, previousQty: 16, newQty: 15, referenceId: 'rt-4', referenceType: 'repair_ticket', performedBy: 'Alex Kim', timestamp: '2026-03-19T13:00:00Z', reason: 'Used in repair T-1004' },
  { id: 'sm-004', stockItemId: 'stk-004', stockItemName: 'Tempered Glass Protector', type: 'sale', quantityChange: -1, previousQty: 101, newQty: 100, referenceId: 'ord-001', referenceType: 'order', performedBy: 'Sarah J.', timestamp: '2026-03-19T14:30:00Z', reason: 'Sold in order INV-1001' },
  { id: 'sm-005', stockItemId: 'stk-006', stockItemName: 'iPhone 14 Pro OLED Screen', type: 'receiving', quantityChange: 6, previousQty: 0, newQty: 6, referenceId: 'po-001', referenceType: 'purchase_order', performedBy: 'Sarah Johnson', timestamp: '2026-03-18T10:00:00Z', reason: 'Received from PO-2026-001' },
];

const SEED_PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    id: 'po-001', poNumber: 'PO-2026-001', supplierId: 'sup-001', supplierName: 'Global Parts Inc.',
    status: 'Partially Received',
    items: [
      { productId: 'stk-001', name: 'iPhone 13 Screen', sku: 'IP13-SCR-001', orderedQuantity: 10, receivedQuantity: 6, costPrice: 45.00 },
      { productId: 'stk-003', name: 'Samsung S21 Battery', sku: 'SAM-S21-BAT', orderedQuantity: 15, receivedQuantity: 0, costPrice: 22.00 },
    ],
    totalAmount: 780.00, createdAt: '2026-03-10', orderedAt: '2026-03-11', expectedDate: '2026-03-25', createdBy: 'Sarah Johnson',
    notes: 'Priority order for Q2 stock replenishment'
  },
  {
    id: 'po-002', poNumber: 'PO-2026-002', supplierId: 'sup-002', supplierName: 'Tech Sourcing Co.',
    status: 'Ordered',
    items: [
      { productId: 'stk-012', name: 'MacBook Air M1 Battery', sku: 'MBA-M1-BAT', orderedQuantity: 5, receivedQuantity: 0, costPrice: 80.00 },
      { productId: 'stk-005', name: 'iPad Air 5 Digitizer', sku: 'IPAD-A5-DIG', orderedQuantity: 8, receivedQuantity: 0, costPrice: 65.00 },
    ],
    totalAmount: 920.00, createdAt: '2026-03-18', orderedAt: '2026-03-19', expectedDate: '2026-04-01', createdBy: 'Sarah Johnson'
  },
  {
    id: 'po-003', poNumber: 'PO-2026-003', supplierId: 'sup-003', supplierName: 'Premium Displays Ltd.',
    status: 'Draft',
    items: [
      { productId: 'stk-006', name: 'iPhone 14 Pro OLED Screen', sku: 'IP14P-OLED-001', orderedQuantity: 10, receivedQuantity: 0, costPrice: 95.00 },
    ],
    totalAmount: 950.00, createdAt: '2026-03-22', expectedDate: '2026-04-05', createdBy: 'Sarah Johnson'
  },
];

const SEED_GRNS: GoodsReceivedNote[] = [
  {
    id: 'grn-001', grnNumber: 'GRN-2026-001', poId: 'po-001', poNumber: 'PO-2026-001', supplierId: 'sup-001', supplierName: 'Global Parts Inc.',
    items: [{ productId: 'stk-001', name: 'iPhone 13 Screen', orderedQty: 10, quantity: 6, costPrice: 45.00 }],
    receivedAt: '2026-03-18', receivedBy: 'Sarah Johnson', notes: 'Partial shipment — remaining 4 screens expected next week'
  },
];

const SEED_RMAS: RMA[] = [
  {
    id: 'rma-001', rmaNumber: 'RMA-2026-001', supplierId: 'sup-001', supplierName: 'Global Parts Inc.', poId: 'po-001', poNumber: 'PO-2026-001',
    items: [{ productId: 'stk-001', name: 'iPhone 13 Screen', quantity: 1, reason: 'Defective digitizer — dead zones in upper-right corner' }],
    status: 'Pending', createdAt: '2026-03-20', createdBy: 'Alex Kim', notes: 'Defect discovered during repair T-1001'
  },
];

const SEED_SHIPMENTS: Shipment[] = [
  {
    id: 'shp-001', shipmentNumber: 'SHP-2026-001', type: 'customer_delivery', status: 'Delivered',
    sourceType: 'invoice', sourceId: 'inv-001', sourceNumber: 'INV-1001',
    originAddress: { name: 'Main Warehouse', line1: '100 Commerce Dr', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', phone: '512-555-0100' },
    destinationAddress: { name: 'Alexander Wright', company: 'Wright Tech Solutions', line1: '500 Corporate Blvd', city: 'Austin', state: 'TX', postalCode: '78702', country: 'US', phone: '512-555-0123', email: 'alex@wright.com' },
    packages: [{ id: 'pkg-001', weight: 2.5, weightUnit: 'lb', length: 12, width: 8, height: 4, dimensionUnit: 'in', contentsSummary: 'iPhone 15 Pro + accessories' }],
    carrier: 'UPS', serviceLevel: 'Ground', trackingNumber: '1Z999AA10123456784', shippingCost: 12.50,
    label: {
      id: 'lbl-001', format: 'pdf', url: 'https://easypost-files.s3-us-west-2.amazonaws.com/files/postage_label/demo_label.pdf',
      trackingNumber: '1Z999AA10123456784', carrier: 'UPS', service: 'Ground',
      purchasedAt: '2026-03-20T12:00:00Z', cost: 12.50, providerLabelRef: 'el_demo001',
    },
    events: [
      { id: 'evt-001', timestamp: '2026-03-20T10:00:00Z', status: 'Created', description: 'Shipment created', performedBy: 'Sarah Johnson' },
      { id: 'evt-002', timestamp: '2026-03-20T14:00:00Z', status: 'Packed', description: 'Package packed and labeled', performedBy: 'Sarah Johnson' },
      { id: 'evt-003', timestamp: '2026-03-21T09:00:00Z', status: 'Dispatched', description: 'Handed off to UPS', performedBy: 'Mike Torres' },
      { id: 'evt-004', timestamp: '2026-03-22T11:30:00Z', status: 'In Transit', description: 'In transit — Austin sorting facility' },
      { id: 'evt-005', timestamp: '2026-03-23T14:15:00Z', status: 'Delivered', description: 'Delivered — signed by A. Wright' },
    ],
    createdBy: 'Sarah Johnson', createdAt: '2026-03-20T10:00:00Z', updatedAt: '2026-03-23T14:15:00Z', dispatchedAt: '2026-03-21T09:00:00Z', deliveredAt: '2026-03-23T14:15:00Z',
  },
  {
    id: 'shp-002', shipmentNumber: 'SHP-2026-002', type: 'repair_return', status: 'In Transit',
    sourceType: 'repair', sourceId: 'rep-001', sourceNumber: 'REP-1001',
    originAddress: { name: 'Downtown Branch', line1: '200 Main St', city: 'Austin', state: 'TX', postalCode: '78703', country: 'US', phone: '512-555-0200' },
    destinationAddress: { name: 'Sarah Jenkins', line1: '350 Oak Lane', city: 'Austin', state: 'TX', postalCode: '78704', country: 'US', phone: '512-555-0456', email: 'sarah.j@gmail.com' },
    packages: [{ id: 'pkg-002', weight: 1.0, weightUnit: 'lb', length: 8, width: 6, height: 3, dimensionUnit: 'in', contentsSummary: 'Repaired Samsung S21', declaredValue: 450 }],
    carrier: 'FedEx', serviceLevel: 'Priority Overnight', trackingNumber: '794644790138', shippingCost: 24.95, estimatedDelivery: '2026-04-10',
    events: [
      { id: 'evt-006', timestamp: '2026-04-07T09:00:00Z', status: 'Created', description: 'Return shipment created for completed repair', performedBy: 'Alex Kim' },
      { id: 'evt-007', timestamp: '2026-04-07T15:00:00Z', status: 'Dispatched', description: 'Picked up by FedEx', performedBy: 'Alex Kim' },
      { id: 'evt-008', timestamp: '2026-04-08T08:00:00Z', status: 'In Transit', description: 'In transit — FedEx Memphis hub' },
    ],
    createdBy: 'Alex Kim', createdAt: '2026-04-07T09:00:00Z', updatedAt: '2026-04-08T08:00:00Z', dispatchedAt: '2026-04-07T15:00:00Z',
  },
  {
    id: 'shp-003', shipmentNumber: 'SHP-2026-003', type: 'store_transfer', status: 'Ready',
    sourceType: 'transfer', sourceId: 'tr-001', sourceNumber: 'TRF-2026-001',
    originAddress: { name: 'Main Warehouse', line1: '100 Commerce Dr', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', phone: '512-555-0100' },
    destinationAddress: { name: 'Downtown Branch', line1: '200 Main St', city: 'Austin', state: 'TX', postalCode: '78703', country: 'US', phone: '512-555-0200' },
    packages: [{ id: 'pkg-003', weight: 5.0, weightUnit: 'lb', length: 18, width: 12, height: 6, dimensionUnit: 'in', contentsSummary: '3x iPhone 13 Screen, 10x Tempered Glass' }],
    carrier: 'Internal Courier', serviceLevel: 'Same Day',
    events: [
      { id: 'evt-009', timestamp: '2026-04-08T08:00:00Z', status: 'Created', description: 'Transfer shipment created', performedBy: 'Sarah Johnson' },
      { id: 'evt-010', timestamp: '2026-04-08T10:00:00Z', status: 'Ready', description: 'Package prepared for pickup', performedBy: 'Sarah Johnson' },
    ],
    createdBy: 'Sarah Johnson', createdAt: '2026-04-08T08:00:00Z', updatedAt: '2026-04-08T10:00:00Z',
  },
  {
    id: 'shp-004', shipmentNumber: 'SHP-2026-004', type: 'rma_outbound', status: 'Dispatched',
    sourceType: 'rma', sourceId: 'rma-001', sourceNumber: 'RMA-2026-001',
    originAddress: { name: 'Main Warehouse', line1: '100 Commerce Dr', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', phone: '512-555-0100' },
    destinationAddress: { name: 'Global Parts Inc.', company: 'Global Parts Inc.', line1: '800 Industrial Pkwy', city: 'Dallas', state: 'TX', postalCode: '75201', country: 'US', phone: '214-555-9000' },
    packages: [{ id: 'pkg-004', weight: 0.5, weightUnit: 'lb', length: 6, width: 4, height: 2, dimensionUnit: 'in', contentsSummary: '1x Defective iPhone 13 Screen' }],
    carrier: 'USPS', serviceLevel: 'Priority Mail', trackingNumber: '9400111899223100001234', shippingCost: 8.75,
    label: {
      id: 'lbl-004', format: 'pdf', url: 'https://easypost-files.s3-us-west-2.amazonaws.com/files/postage_label/demo_usps.pdf',
      trackingNumber: '9400111899223100001234', carrier: 'USPS', service: 'Priority Mail',
      purchasedAt: '2026-04-05T14:00:00Z', cost: 8.75, providerLabelRef: 'el_demo004',
    },
    events: [
      { id: 'evt-011', timestamp: '2026-04-05T11:00:00Z', status: 'Created', description: 'RMA return shipment created', performedBy: 'Alex Kim' },
      { id: 'evt-012', timestamp: '2026-04-06T09:00:00Z', status: 'Dispatched', description: 'Dropped off at USPS', performedBy: 'Alex Kim' },
    ],
    createdBy: 'Alex Kim', createdAt: '2026-04-05T11:00:00Z', updatedAt: '2026-04-06T09:00:00Z', dispatchedAt: '2026-04-06T09:00:00Z',
  },
  {
    id: 'shp-005', shipmentNumber: 'SHP-2026-005', type: 'customer_delivery', status: 'Draft',
    sourceType: 'invoice', sourceId: 'inv-002', sourceNumber: 'INV-1002',
    originAddress: { name: 'Main Warehouse', line1: '100 Commerce Dr', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', phone: '512-555-0100' },
    destinationAddress: { name: 'Mike Rodriguez', line1: '720 Elm Street', city: 'Austin', state: 'TX', postalCode: '78705', country: 'US', phone: '512-555-0789' },
    packages: [],
    events: [
      { id: 'evt-013', timestamp: '2026-04-08T14:00:00Z', status: 'Created', description: 'Shipment drafted for invoice INV-1002', performedBy: 'Sarah Johnson' },
    ],
    createdBy: 'Sarah Johnson', createdAt: '2026-04-08T14:00:00Z', updatedAt: '2026-04-08T14:00:00Z',
  },
];

const SEED_STORE_LOCATIONS: string[] = ['Main Warehouse', 'Downtown Branch', 'Eastside Location', 'Airport Kiosk'];

const SEED_TRANSFERS: InventoryTransfer[] = [
  {
    id: 'tr-001', transferNumber: 'TRF-2026-001', fromStore: 'Main Warehouse', toStore: 'Downtown Branch',
    items: [{ productId: 'stk-001', name: 'iPhone 13 Screen', quantity: 3 }, { productId: 'stk-004', name: 'Tempered Glass Protector', quantity: 10 }],
    status: 'Sent', requestedBy: 'Sarah Johnson', notes: 'Restocking downtown branch for weekend rush',
    createdAt: '2026-03-19', sentAt: '2026-03-20'
  },
  {
    id: 'tr-002', transferNumber: 'TRF-2026-002', fromStore: 'Downtown Branch', toStore: 'Main Warehouse',
    items: [{ productId: 'stk-011', name: 'PS5 HDMI Port IC', quantity: 2 }],
    status: 'Received', requestedBy: 'Mike Torres', notes: 'Consolidating repair parts to main location',
    createdAt: '2026-03-15', sentAt: '2026-03-16', receivedAt: '2026-03-17'
  },
];

const SEED_COUNTS: InventoryCount[] = [
  {
    id: 'ic-001', countNumber: 'CNT-2026-001', date: '2026-03-01', status: 'Completed',
    items: [
      { productId: 'stk-001', name: 'iPhone 13 Screen', sku: 'IP13-SCR-001', expected: 14, actual: 12, discrepancy: -2 },
      { productId: 'stk-002', name: 'USB-C Charging Cable', sku: 'USB-C-CBL-01', expected: 50, actual: 50, discrepancy: 0 },
      { productId: 'stk-004', name: 'Tempered Glass Protector', sku: 'TG-UNIV-001', expected: 102, actual: 100, discrepancy: -2 },
    ],
    performedBy: 'Sarah Johnson', notes: '2 iPhone screens unaccounted for — likely used in repairs without logging', completedAt: '2026-03-01T17:00:00Z'
  },
];

const SEED_TRADE_INS: TradeInItem[] = [
  { id: 'ti-001', customerId: 'c3', customerName: 'Mike Rodriguez', device: 'iPhone 12 64GB', imei: '352678901234567', condition: 'Good', gradeNotes: 'Minor scratches on frame, screen in great condition. Battery health 82%.', buybackPrice: 180, resalePrice: 299, status: 'In Inventory', movedToInventoryId: 'stk-007', createdAt: '2026-03-10' },
  { id: 'ti-002', customerId: 'c4', customerName: 'Emma Chen', device: 'Samsung Galaxy S21 128GB', imei: '352789012345678', serialNumber: 'RF8N30XXXXX', condition: 'Fair', gradeNotes: 'Screen has light burn-in. Back glass intact. Battery health 68%.', buybackPrice: 120, status: 'Refurbishing', createdAt: '2026-03-18' },
  { id: 'ti-003', customerId: 'c1', customerName: 'Alexander Wright', device: 'iPad Air 4 256GB', serialNumber: 'DMXW20XXXXX', condition: 'Excellent', gradeNotes: 'Like new. Comes with original box and accessories.', buybackPrice: 280, resalePrice: 399, status: 'Pending', createdAt: '2026-03-22' },
];

const SEED_REFURB_JOBS: RefurbishmentJob[] = [
  {
    id: 'rfb-001', itemId: 'ti-002', itemName: 'Samsung Galaxy S21 128GB',
    technicianId: 'op-3', technicianName: 'Alex Kim',
    status: 'In Progress', notes: 'Replacing battery and addressing screen burn-in. Will test all sensors after.',
    partsUsed: [{ name: 'Samsung S21 Battery', cost: 22.00 }, { name: 'Screen Burn-in Fix Kit', cost: 15.00 }],
    totalCost: 37.00, estimatedCompletion: '2026-03-25', createdAt: '2026-03-19'
  },
];

function makeDefaultTemplate(id: string, type: import('../types').TemplateType, name: string): DocumentTemplate {
  const enabledTags = getDefaultEnabledTags(type);
  return {
    id,
    type,
    name,
    content: buildTemplateHtml(type, enabledTags),
    enabledTags,
    isDefault: true,
    updatedAt: new Date().toISOString(),
  };
}

const DEFAULT_TEMPLATES: DocumentTemplate[] = [
  makeDefaultTemplate('tmpl-invoice', 'invoice', 'Invoice Template'),
  makeDefaultTemplate('tmpl-ticket', 'ticket', 'Repair Ticket'),
  makeDefaultTemplate('tmpl-label', 'label', 'Inventory Label'),
  makeDefaultTemplate('tmpl-receipt', 'receipt', 'Sales Receipt'),
  makeDefaultTemplate('tmpl-estimate', 'estimate', 'Price Estimate'),
];

const SEED_RETURNS: Return[] = [
  {
    id: 'ret-001',
    returnNumber: 'RTN-2026-001',
    status: 'Completed',
    sourceType: 'invoice',
    sourceId: 'inv-001',
    sourceNumber: 'INV-2026-0042',
    customerId: 'c1',
    customerName: 'Alexander Wright',
    customerEmail: 'alex@wright.com',
    customerPhone: '512-555-0123',
    reason: 'defective',
    reasonDetails: 'Screen flickering after 2 weeks of use',
    requestedResolution: 'refund',
    items: [
      { id: 'ri-001', productId: 'stk-002', name: 'USB-C Charging Cable', sku: 'USB-C-CBL-01', quantity: 1, condition: 'Defective', reason: 'defective', notes: 'Cable fraying at connector end' }
    ],
    originalShipmentId: 'shp-001',
    receivedAt: '2026-04-02T14:00:00Z',
    receivedBy: 'Marcus Chen',
    inspectionNotes: 'Confirmed cable defect at USB-C connector. Manufacturing fault.',
    inspectionCompletedAt: '2026-04-02T15:30:00Z',
    inspectedBy: 'Marcus Chen',
    itemCondition: 'Defective',
    finalResolution: 'refund',
    finalDisposition: 'return_to_vendor',
    dispositionNotes: 'Returned to supplier for credit. Batch defect reported.',
    dispositionCompletedAt: '2026-04-03T10:00:00Z',
    dispositionCompletedBy: 'Marcus Chen',
    refundAmount: 12.99,
    createdBy: 'Marcus Chen',
    createdAt: '2026-03-30T09:00:00Z',
    updatedAt: '2026-04-03T10:00:00Z',
    statusHistory: [
      { id: 'rsh-001', status: 'Draft', timestamp: '2026-03-30T09:00:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-002', status: 'Requested', timestamp: '2026-03-30T09:05:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-003', status: 'Approved', timestamp: '2026-03-30T11:00:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-004', status: 'Received', timestamp: '2026-04-02T14:00:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-005', status: 'Inspecting', timestamp: '2026-04-02T14:30:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-006', status: 'Completed', timestamp: '2026-04-03T10:00:00Z', performedBy: 'Marcus Chen' },
    ],
  },
  {
    id: 'ret-002',
    returnNumber: 'RTN-2026-002',
    status: 'In Transit',
    sourceType: 'invoice',
    sourceId: 'inv-002',
    sourceNumber: 'INV-2026-0045',
    customerId: 'c2',
    customerName: 'Sarah Jenkins',
    customerEmail: 'sarah.j@gmail.com',
    customerPhone: '512-555-0456',
    reason: 'wrong_item',
    reasonDetails: 'Received Samsung cable instead of iPhone cable',
    requestedResolution: 'exchange',
    items: [
      { id: 'ri-002', name: 'Lightning Cable (wrong item sent)', quantity: 1, condition: 'New', reason: 'wrong_item' }
    ],
    originalShipmentId: 'shp-002',
    returnShipmentId: 'shp-003',
    createdBy: 'Marcus Chen',
    createdAt: '2026-04-08T11:00:00Z',
    updatedAt: '2026-04-10T08:00:00Z',
    statusHistory: [
      { id: 'rsh-010', status: 'Draft', timestamp: '2026-04-08T11:00:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-011', status: 'Requested', timestamp: '2026-04-08T11:15:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-012', status: 'Approved', timestamp: '2026-04-08T14:00:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-013', status: 'Label Created', timestamp: '2026-04-09T09:00:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-014', status: 'In Transit', timestamp: '2026-04-10T08:00:00Z', performedBy: 'System' },
    ],
  },
  {
    id: 'ret-003',
    returnNumber: 'RTN-2026-003',
    status: 'Requested',
    sourceType: 'repair',
    sourceId: 'tk-001',
    sourceNumber: 'TK-2026-001',
    customerId: 'c3',
    customerName: 'Mike Rodriguez',
    customerEmail: 'mike@example.com',
    customerPhone: '512-555-0789',
    reason: 'repair_return',
    reasonDetails: 'Device needs to be shipped back after screen repair',
    requestedResolution: 'send_back',
    items: [
      { id: 'ri-003', name: 'Samsung S21 (repaired)', quantity: 1, condition: 'Good', reason: 'repair_return', notes: 'Screen replacement completed' }
    ],
    createdBy: 'Marcus Chen',
    createdAt: '2026-04-12T10:00:00Z',
    updatedAt: '2026-04-12T10:00:00Z',
    statusHistory: [
      { id: 'rsh-020', status: 'Draft', timestamp: '2026-04-12T10:00:00Z', performedBy: 'Marcus Chen' },
      { id: 'rsh-021', status: 'Requested', timestamp: '2026-04-12T10:30:00Z', performedBy: 'Marcus Chen' },
    ],
  },
  {
    id: 'ret-004',
    returnNumber: 'RTN-2026-004',
    status: 'Draft',
    sourceType: 'walk_in',
    sourceId: 'walk-001',
    sourceNumber: 'WALK-001',
    customerId: 'c4',
    customerName: 'Emma Chen',
    customerEmail: 'emma@example.com',
    customerPhone: '512-555-0321',
    reason: 'customer_changed_mind',
    requestedResolution: 'store_credit',
    items: [
      { id: 'ri-004', productId: 'stk-004', name: 'iPhone 14 Case', quantity: 1, condition: 'New', reason: 'customer_changed_mind' }
    ],
    createdBy: 'Marcus Chen',
    createdAt: '2026-04-14T16:00:00Z',
    updatedAt: '2026-04-14T16:00:00Z',
    statusHistory: [
      { id: 'rsh-030', status: 'Draft', timestamp: '2026-04-14T16:00:00Z', performedBy: 'Marcus Chen' },
    ],
  },
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
  const [repairTickets, setRepairTickets] = useState<RepairTicket[]>(SEED_REPAIR_TICKETS);
  const [warrantyRepairTickets, setWarrantyRepairTickets] = useState<RepairTicket[]>([]);
  const [pendingReplacements, setPendingReplacements] = useState<{ warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number; type?: 'replacement' | 'repair_return' }[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>(SEED_INVOICES);
  const [services, setServices] = useState<RepairService[]>(SEED_SERVICES);
  const [serviceCategories, setServiceCategories] = useState<RepairCategory[]>(SEED_SERVICE_CATEGORIES);
  const [loyaltyConfig, setLoyaltyConfig] = useState<LoyaltyProgramConfig>(SEED_LOYALTY_CONFIG);
  const [loyaltyAdjustments, setLoyaltyAdjustments] = useState<LoyaltyAdjustment[]>([]);
  const [documentTemplates, setDocumentTemplates] = useState<DocumentTemplate[]>(DEFAULT_TEMPLATES);
  const [storeBranding, setStoreBranding] = useState<StoreBranding>({ logoUrl: null, logoPlacement: 'top-left' });
  const [suppliers, setSuppliers] = useState<Supplier[]>(SEED_SUPPLIERS);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>(SEED_STOCK_MOVEMENTS);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>(SEED_PURCHASE_ORDERS);
  const [goodsReceivedNotes, setGoodsReceivedNotes] = useState<GoodsReceivedNote[]>(SEED_GRNS);
  const [rmas, setRmas] = useState<RMA[]>(SEED_RMAS);
  const [inventoryTransfers, setInventoryTransfers] = useState<InventoryTransfer[]>(SEED_TRANSFERS);
  const [inventoryCounts, setInventoryCounts] = useState<InventoryCount[]>(SEED_COUNTS);
  const [tradeIns, setTradeIns] = useState<TradeInItem[]>(SEED_TRADE_INS);
  const [refurbishmentJobs, setRefurbishmentJobs] = useState<RefurbishmentJob[]>(SEED_REFURB_JOBS);
  const [supplierRefundEntries, setSupplierRefundEntries] = useState<SupplierRefundEntry[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>(SEED_SHIPMENTS);
  const [shippingProviderConfig, setShippingProviderConfig] = useState<ShippingProviderConfig | null>(null);
  // Starts `unknown`, never `available`: nothing has probed the service yet, and callers
  // must fail closed until something has.
  const [shippingServiceAvailability, setShippingServiceAvailability] = useState<ShippingServiceAvailability>('unknown');
  const storeLocations = SEED_STORE_LOCATIONS;

  const getItemMovements = useCallback((stockItemId: string) => {
    return stockMovements.filter(m => m.stockItemId === stockItemId).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [stockMovements]);

  const updateDocumentTemplate = useCallback((id: string, updates: Partial<DocumentTemplate>) => {
    setDocumentTemplates(prev => prev.map(t => t.id === id ? { ...t, ...updates, isDefault: false, updatedAt: new Date().toISOString() } : t));
  }, []);

  const resetDocumentTemplate = useCallback((id: string) => {
    const defaultTmpl = DEFAULT_TEMPLATES.find(t => t.id === id);
    if (defaultTmpl) {
      setDocumentTemplates(prev => prev.map(t => t.id === id ? { ...defaultTmpl, updatedAt: new Date().toISOString() } : t));
    }
  }, []);

  const updateStoreBranding = useCallback((updates: Partial<StoreBranding>) => {
    setStoreBranding(prev => ({ ...prev, ...updates }));
  }, []);

  const prevSessionRoleRef = useRef(session?.role);
  useEffect(() => {
    if (prevSessionRoleRef.current !== undefined && session?.role !== prevSessionRoleRef.current) {
      setPosOperatorState(null);
    }
    prevSessionRoleRef.current = session?.role;
  }, [session?.role]);

  const addCustomer = useCallback((c: Customer) => { setCustomers(prev => [...prev, c]); }, []);
  const updateCustomer = useCallback((id: string, updates: Partial<Customer>) => { setCustomers(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c)); }, []);

  const addStockItem = useCallback((item: StockItem) => { setStockItems(prev => [...prev, item]); }, []);
  const updateStockItem = useCallback((id: string, updates: Partial<StockItem>) => { setStockItems(prev => prev.map(si => si.id === id ? { ...si, ...updates } : si)); }, []);
  const deleteStockItem = useCallback((id: string) => { setStockItems(prev => prev.filter(si => si.id !== id)); }, []);

  const approvedStockItems = useMemo(() => stockItems.filter(si => si.status === 'approved'), [stockItems]);
  const pendingStockItems = useMemo(() => stockItems.filter(si => si.status === 'pending_approval'), [stockItems]);

  const addHeldOrder = useCallback((order: HeldOrder) => { setHeldOrders(prev => [...prev, order]); }, []);
  const removeHeldOrder = useCallback((id: string) => { setHeldOrders(prev => prev.filter(o => o.id !== id)); }, []);
  const addSuggestiveSaleItem = useCallback((item: SuggestiveSaleItem) => { setSuggestiveSalesItems(prev => [...prev, item]); }, []);
  const removeSuggestiveSaleItem = useCallback((id: string) => { setSuggestiveSalesItems(prev => prev.filter(i => i.id !== id)); }, []);
  const setDraftCart = useCallback((draft: DraftCart) => { setDraftCartState(draft); }, []);
  const clearDraftCart = useCallback(() => { setDraftCartState(EMPTY_DRAFT); }, []);
  const addCompletedOrder = useCallback((order: CompletedOrder) => { setCompletedOrders(prev => [order, ...prev]); }, []);
  const updateCompletedOrder = useCallback((id: string, updates: Partial<CompletedOrder>) => { setCompletedOrders(prev => prev.map(o => o.id === id ? { ...o, ...updates } : o)); }, []);
  const addRefundRecord = useCallback((record: RefundRecord) => { setRefundRecords(prev => [record, ...prev]); }, []);
  const addWarrantyClaim = useCallback((claim: WarrantyClaimRecord) => { setWarrantyClaims(prev => [claim, ...prev]); }, []);
  const updateWarrantyClaim = useCallback((id: string, updates: Partial<WarrantyClaimRecord>) => { setWarrantyClaims(prev => prev.map(wc => wc.id === id ? { ...wc, ...updates } : wc)); }, []);
  const setPosOperator = useCallback((op: POSOperator | null) => { setPosOperatorState(op); }, []);
  const addRepairTicket = useCallback((ticket: RepairTicket) => { setRepairTickets(prev => [ticket, ...prev]); }, []);
  const updateRepairTicket = useCallback((id: string, updates: Partial<RepairTicket>) => { setRepairTickets(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t)); }, []);
  const deleteRepairTicket = useCallback((id: string) => { setRepairTickets(prev => prev.filter(t => t.id !== id)); }, []);
  const addWarrantyRepairTicket = useCallback((ticket: RepairTicket) => { setWarrantyRepairTickets(prev => [ticket, ...prev]); }, []);
  const updateWarrantyRepairTicket = useCallback((id: string, updates: Partial<RepairTicket>) => { setWarrantyRepairTickets(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t)); }, []);

  const addPendingReplacement = useCallback((r: { warrantyClaimId: string; itemName: string; customerName: string; customerId: string; originalPrice: number; type?: 'replacement' | 'repair_return' }) => {
    setPendingReplacements(prev => {
      if (prev.some(p => p.warrantyClaimId === r.warrantyClaimId)) return prev;
      return [...prev, r];
    });
  }, []);
  const removePendingReplacement = useCallback((warrantyClaimId: string) => { setPendingReplacements(prev => prev.filter(r => r.warrantyClaimId !== warrantyClaimId)); }, []);

  const addInvoice = useCallback((inv: Invoice) => { setInvoices(prev => [inv, ...prev]); }, []);
  const updateInvoice = useCallback((id: string, updates: Partial<Invoice>) => { setInvoices(prev => prev.map(inv => inv.id === id ? { ...inv, ...updates } : inv)); }, []);
  const deleteInvoice = useCallback((id: string) => { setInvoices(prev => prev.filter(inv => inv.id !== id)); }, []);
  const addService = useCallback((s: RepairService) => { setServices(prev => [...prev, s]); }, []);
  const updateService = useCallback((id: string, updates: Partial<RepairService>) => { setServices(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s)); }, []);
  const deleteService = useCallback((id: string) => { setServices(prev => prev.filter(s => s.id !== id)); }, []);
  const addServiceCategory = useCallback((c: RepairCategory) => { setServiceCategories(prev => [...prev, c]); }, []);
  const updateServiceCategory = useCallback((id: string, updates: Partial<RepairCategory>) => { setServiceCategories(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c)); }, []);
  const deleteServiceCategory = useCallback((id: string) => { setServiceCategories(prev => prev.filter(c => c.id !== id)); }, []);
  const updateLoyaltyConfig = useCallback((updates: Partial<LoyaltyProgramConfig>) => { setLoyaltyConfig(prev => ({ ...prev, ...updates })); }, []);
  const addLoyaltyAdjustment = useCallback((adj: LoyaltyAdjustment) => { setLoyaltyAdjustments(prev => [adj, ...prev]); }, []);

  const addSupplier = useCallback((s: Supplier) => { setSuppliers(prev => [...prev, s]); }, []);
  const updateSupplier = useCallback((id: string, updates: Partial<Supplier>) => { setSuppliers(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s)); }, []);
  const addStockMovement = useCallback((m: StockMovement) => { setStockMovements(prev => [m, ...prev]); }, []);
  const addPurchaseOrder = useCallback((po: PurchaseOrder) => { setPurchaseOrders(prev => [po, ...prev]); }, []);
  const updatePurchaseOrder = useCallback((id: string, updates: Partial<PurchaseOrder>) => { setPurchaseOrders(prev => prev.map(po => po.id === id ? { ...po, ...updates } : po)); }, []);
  const addGoodsReceivedNote = useCallback((grn: GoodsReceivedNote) => { setGoodsReceivedNotes(prev => [grn, ...prev]); }, []);
  const addRMA = useCallback((rma: RMA) => { setRmas(prev => [rma, ...prev]); }, []);
  const updateRMA = useCallback((id: string, updates: Partial<RMA>) => { setRmas(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r)); }, []);
  const addInventoryTransfer = useCallback((t: InventoryTransfer) => { setInventoryTransfers(prev => [t, ...prev]); }, []);
  const updateInventoryTransfer = useCallback((id: string, updates: Partial<InventoryTransfer>) => { setInventoryTransfers(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t)); }, []);
  const addInventoryCount = useCallback((c: InventoryCount) => { setInventoryCounts(prev => [c, ...prev]); }, []);
  const updateInventoryCount = useCallback((id: string, updates: Partial<InventoryCount>) => { setInventoryCounts(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c)); }, []);
  const addTradeIn = useCallback((t: TradeInItem) => { setTradeIns(prev => [t, ...prev]); }, []);
  const updateTradeIn = useCallback((id: string, updates: Partial<TradeInItem>) => { setTradeIns(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t)); }, []);
  const deleteTradeIn = useCallback((id: string) => { setTradeIns(prev => prev.filter(t => t.id !== id)); }, []);
  const addSupplierRefundEntry = useCallback((entry: SupplierRefundEntry) => { setSupplierRefundEntries(prev => [entry, ...prev]); }, []);
  const addRefurbishmentJob = useCallback((j: RefurbishmentJob) => { setRefurbishmentJobs(prev => [j, ...prev]); }, []);
  const updateRefurbishmentJob = useCallback((id: string, updates: Partial<RefurbishmentJob>) => { setRefurbishmentJobs(prev => prev.map(j => j.id === id ? { ...j, ...updates } : j)); }, []);
  const addShipment = useCallback((s: Shipment) => { setShipments(prev => [s, ...prev]); }, []);
  const updateShipment = useCallback((id: string, updates: Partial<Shipment>) => { setShipments(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s)); }, []);
  // Phase 3 correction #3 — generalized review-outcome setter. Each
  // resolution writes the matching state machine value, the matching audit
  // note, and the matching actor/timestamp pair. Treats anything with
  // resolved===true OR state!=='pending' as a no-op so a re-click cannot
  // overwrite an existing terminal outcome (audit integrity).
  const setReviewOutcome = useCallback((id: string, args: {
    resolution: 'resolve' | 'approve' | 'override' | 'dismiss';
    actor: string;
    note?: string;
  }) => {
    const now = new Date().toISOString();
    const noteText = args.note?.trim() || undefined;
    const actionLabel: Record<typeof args.resolution, string> = {
      resolve: 'Review resolved',
      approve: 'Guardrail exception approved',
      override: 'Guardrail block overridden',
      dismiss: 'Review dismissed',
    };
    const stateValue: Record<typeof args.resolution, NonNullable<Shipment['reviewNeeded']>['state']> = {
      resolve: 'resolved', approve: 'approved', override: 'overridden', dismiss: 'dismissed',
    };
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      const rn = s.reviewNeeded;
      if (!rn) return s;
      // Phase 3 correction #5 — only true terminal states block resolution.
      // 'pending' AND 'approval_requested' are both pending-of-approver and
      // must remain resolvable; previously 'approval_requested' was treated
      // as terminal which made the Resolve modal a no-op for approvers.
      const TERMINAL: Array<NonNullable<Shipment['reviewNeeded']>['state']> = ['resolved', 'approved', 'overridden', 'dismissed'];
      const alreadyTerminal = rn.resolved === true || (rn.state ? TERMINAL.includes(rn.state) : false);
      if (alreadyTerminal) return s;
      const updatedReview: NonNullable<Shipment['reviewNeeded']> = {
        ...rn,
        state: stateValue[args.resolution],
        // Keep `resolved` true for any terminal outcome so existing UI that
        // only checks `resolved` continues to clear the badge.
        resolved: true,
        ...(args.resolution === 'resolve' || args.resolution === 'dismiss'
          ? { resolvedAt: now, resolvedBy: args.actor, resolutionNote: noteText }
          : {}),
        // Phase 3 correction #5 — persist approverNote distinctly from any
        // legacy resolutionNote so requester/approver history stays clear.
        ...(args.resolution === 'approve'
          ? { approvedAt: now, approvedBy: args.actor, approverNote: noteText, resolutionNote: noteText }
          : {}),
        ...(args.resolution === 'override'
          ? { overriddenAt: now, overriddenBy: args.actor, approverNote: noteText, resolutionNote: noteText }
          : {}),
        ...(args.resolution === 'dismiss'
          ? { dismissedAt: now, dismissedBy: args.actor }
          : {}),
      };
      const auditNote = {
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: `${actionLabel[args.resolution]} by ${args.actor}${noteText ? ` — ${noteText}` : ''} (rule: ${rn.ruleName || 'unknown'})`,
        timestamp: now,
        source: 'system' as const,
        ruleId: rn.ruleId,
        ruleName: rn.ruleName,
      };
      // Phase 3 correction #5 — close the approval loop. When approve or
      // override clears a pending request, append the approvalContextKey
      // (rule + shipment + selected rate signature) to the shipment's
      // approvedGuardrailContexts so evaluateGuardrails recognizes the
      // same rule + rate combination as already cleared and skips it on
      // a subsequent purchase attempt. Required for resolve-modal flow
      // parity with the pre-label modal's recordOutcomeAndPurchase.
      const shouldRegisterApproval = (args.resolution === 'approve' || args.resolution === 'override')
        && rn.approvalContextKey
        && (rn.kind === 'approval' || rn.kind === 'block');
      const approvedContexts = shouldRegisterApproval
        ? Array.from(new Set([...(s.approvedGuardrailContexts || []), rn.approvalContextKey!]))
        : s.approvedGuardrailContexts;
      return {
        ...s,
        reviewNeeded: updatedReview,
        internalNotes: [...(s.internalNotes || []), auditNote],
        ...(shouldRegisterApproval ? { approvedGuardrailContexts: approvedContexts } : {}),
      };
    }));
  }, []);
  // Back-compat wrapper for existing call sites — delegates to the
  // generalized setter with resolution='resolve'.
  const resolveShipmentReview = useCallback((id: string, args: { resolvedBy: string; note?: string }) => {
    setReviewOutcome(id, { resolution: 'resolve', actor: args.resolvedBy, note: args.note });
  }, [setReviewOutcome]);
  // Phase 3 Pass #10 — Packing Workflows mutators. Each writes the matching
  // packing field(s) AND appends a PackingHistoryEntry AND appends a matching
  // internal-note audit entry inside the same setShipments transaction so
  // every packing action is auditable atomically.
  const buildPackingHistoryEntry = (action: PackingHistoryAction, actor: string, note?: string, ref?: PackingHistoryEntry['ref']): PackingHistoryEntry => ({
    id: `ph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action, actor, at: new Date().toISOString(),
    ...(note ? { note } : {}),
    ...(ref ? { ref } : {}),
  });
  // Phase 3 Pass #12 — packing audits use source='packing' (not 'system')
  // so the Automation Outcomes panel (which surfaces 'rule' + 'system'
  // notes) no longer leaks normal packing history into a section reserved
  // for automation-rule outcomes. Packing audits remain visible in the
  // Packing tab's Packing History surface.
  const buildPackingAuditNote = (text: string) => ({
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    timestamp: new Date().toISOString(),
    source: 'packing' as const,
  });
  // Compute next packingStatus when an exception is added or resolved. If any
  // open exception exists → 'exception'. Otherwise preserve the prior
  // operational state (in_progress when packing has been started, packed
  // when already complete, not_required when explicitly marked, or
  // not_started when nothing has happened yet).
  const recomputePackingStatusForExceptions = (s: Shipment, nextExceptions: PackingException[]) => {
    const hasOpen = nextExceptions.some(e => !e.resolvedAt);
    if (hasOpen) return 'exception' as const;
    // No open exceptions — fall back to the underlying operational state.
    if (s.packingStatus === 'packed') return 'packed' as const;
    if (s.packingStatus === 'not_required') return 'not_required' as const;
    if (s.packingStartedAt || s.packingItemVerifications?.length || s.packingPackageVerifications?.length) {
      return 'in_progress' as const;
    }
    return 'not_started' as const;
  };
  // Phase 3 Pass #10 correction — mutators that can no-op (idempotent /
  // already-in-state) now return a result so the caller can avoid firing an
  // observational automation trigger ('packing_started' / 'packing_exception_created')
  // for events that did not actually transition state. This closes the
  // false-trigger window the architect flagged where a rapid double-click
  // or call from a state that disallows the transition would still fire
  // automations.
  const startPacking = useCallback((id: string, args: { actor: string; note?: string }): { ok: boolean } => {
    let result = { ok: false };
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      // Idempotent: re-starting a shipment that's already in_progress / packed /
      // exception is a no-op (audit-preserving). Allow re-start from
      // not_required (operator changed their mind) and from not_started.
      if (s.packingStatus && s.packingStatus !== 'not_started' && s.packingStatus !== 'not_required') return s;
      const now = new Date().toISOString();
      const history = buildPackingHistoryEntry('started', args.actor, args.note, { kind: 'shipment', id: s.id });
      const noteText = args.note?.trim() ? ` — ${args.note.trim()}` : '';
      const audit = buildPackingAuditNote(`Packing started by ${args.actor}${noteText}`);
      result = { ok: true };
      return {
        ...s,
        packingStatus: 'in_progress',
        packingStartedBy: args.actor,
        packingStartedAt: now,
        packingHistory: [...(s.packingHistory || []), history],
        internalNotes: [...(s.internalNotes || []), audit],
      };
    }));
    return result;
  }, []);
  const recordPackingItemVerification = useCallback((id: string, args: {
    sourceItemKey: string; name: string; expectedQty: number; verifiedQty: number;
    actor: string; note?: string;
  }) => {
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      // Auto-promote to in_progress on the first verification action so the
      // packing lifecycle stays internally consistent even if the operator
      // forgot to click Start. Preserves 'exception' / 'packed' if already set.
      const now = new Date().toISOString();
      const existing = s.packingItemVerifications || [];
      const idx = existing.findIndex(v => v.sourceItemKey === args.sourceItemKey);
      const next: PackingItemVerification = {
        sourceItemKey: args.sourceItemKey,
        name: args.name,
        expectedQty: args.expectedQty,
        verifiedQty: args.verifiedQty,
        verifiedBy: args.actor,
        verifiedAt: now,
        ...(args.note ? { note: args.note } : {}),
      };
      const nextVerifications = idx >= 0
        ? existing.map((v, i) => i === idx ? next : v)
        : [...existing, next];
      const status = (s.packingStatus === 'packed' || s.packingStatus === 'exception')
        ? s.packingStatus
        : 'in_progress';
      const history = buildPackingHistoryEntry('item_verified', args.actor, `${args.name}: ${args.verifiedQty}/${args.expectedQty}${args.note ? ` — ${args.note}` : ''}`, { kind: 'item', id: args.sourceItemKey });
      const audit = buildPackingAuditNote(`Item verified by ${args.actor} — ${args.name} ${args.verifiedQty}/${args.expectedQty}${args.note ? ` (${args.note})` : ''}`);
      return {
        ...s,
        packingStatus: status,
        ...(s.packingStartedAt ? {} : { packingStartedAt: now, packingStartedBy: args.actor }),
        packingItemVerifications: nextVerifications,
        packingHistory: [...(s.packingHistory || []), history],
        internalNotes: [...(s.internalNotes || []), audit],
      };
    }));
  }, []);
  const recordPackingPackageVerification = useCallback((id: string, args: {
    packageId: string; weightConfirmed: boolean; dimensionsConfirmed: boolean;
    actor: string; note?: string;
  }) => {
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      const now = new Date().toISOString();
      const existing = s.packingPackageVerifications || [];
      const idx = existing.findIndex(v => v.packageId === args.packageId);
      // Phase 3 Pass #11 — snapshot the package's current physical fields
      // at the moment of verification, so a later edit to weight/length/
      // width/height (or unit) makes the verification reactively stale at
      // the UI layer without needing a separate invalidation hook.
      const pkg = (s.packages || []).find(p => p.id === args.packageId);
      const next: PackingPackageVerification = {
        packageId: args.packageId,
        weightConfirmed: args.weightConfirmed,
        dimensionsConfirmed: args.dimensionsConfirmed,
        verifiedBy: args.actor,
        verifiedAt: now,
        ...(args.note ? { note: args.note } : {}),
        ...(pkg ? {
          ...(typeof pkg.weight === 'number' ? { snapshotWeight: pkg.weight } : {}),
          ...(pkg.weightUnit ? { snapshotWeightUnit: pkg.weightUnit } : {}),
          ...(typeof pkg.length === 'number' ? { snapshotLength: pkg.length } : {}),
          ...(typeof pkg.width === 'number' ? { snapshotWidth: pkg.width } : {}),
          ...(typeof pkg.height === 'number' ? { snapshotHeight: pkg.height } : {}),
          ...(pkg.dimensionUnit ? { snapshotDimensionUnit: pkg.dimensionUnit } : {}),
        } : {}),
      };
      const nextVerifications = idx >= 0
        ? existing.map((v, i) => i === idx ? next : v)
        : [...existing, next];
      const status = (s.packingStatus === 'packed' || s.packingStatus === 'exception')
        ? s.packingStatus
        : 'in_progress';
      const summary = `Package ${args.packageId} weight=${args.weightConfirmed ? 'ok' : 'missing'} dim=${args.dimensionsConfirmed ? 'ok' : 'missing'}`;
      const history = buildPackingHistoryEntry('package_verified', args.actor, summary, { kind: 'package', id: args.packageId });
      const audit = buildPackingAuditNote(`Package verified by ${args.actor} — ${summary}`);
      return {
        ...s,
        packingStatus: status,
        ...(s.packingStartedAt ? {} : { packingStartedAt: now, packingStartedBy: args.actor }),
        packingPackageVerifications: nextVerifications,
        packingHistory: [...(s.packingHistory || []), history],
        internalNotes: [...(s.internalNotes || []), audit],
      };
    }));
  }, []);
  const addPackingException = useCallback((id: string, args: {
    type: PackingExceptionType; description: string; actor: string;
    packageId?: string; sourceItemKey?: string;
  }): string | null => {
    const exceptionId = `pe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let created = false;
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      created = true;
      const now = new Date().toISOString();
      const exc: PackingException = {
        id: exceptionId,
        type: args.type,
        description: args.description,
        createdBy: args.actor,
        createdAt: now,
        ...(args.packageId ? { packageId: args.packageId } : {}),
        ...(args.sourceItemKey ? { sourceItemKey: args.sourceItemKey } : {}),
      };
      const nextExceptions = [...(s.packingExceptions || []), exc];
      const nextStatus = recomputePackingStatusForExceptions(s, nextExceptions);
      const history = buildPackingHistoryEntry('exception_created', args.actor, `[${args.type}] ${args.description}`, { kind: 'exception', id: exceptionId });
      const audit = buildPackingAuditNote(`Packing exception created by ${args.actor} — [${args.type}] ${args.description}`);
      return {
        ...s,
        packingStatus: nextStatus,
        packingExceptions: nextExceptions,
        packingHistory: [...(s.packingHistory || []), history],
        internalNotes: [...(s.internalNotes || []), audit],
      };
    }));
    return created ? exceptionId : null;
  }, []);
  const resolvePackingException = useCallback((id: string, args: {
    exceptionId: string; actor: string; resolutionNote: string;
  }) => {
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      const existing = s.packingExceptions || [];
      const target = existing.find(e => e.id === args.exceptionId);
      if (!target || target.resolvedAt) return s; // no-op for unknown / already-resolved
      const now = new Date().toISOString();
      const nextExceptions = existing.map(e => e.id === args.exceptionId
        ? { ...e, resolvedBy: args.actor, resolvedAt: now, resolutionNote: args.resolutionNote }
        : e);
      const nextStatus = recomputePackingStatusForExceptions(s, nextExceptions);
      const history = buildPackingHistoryEntry('exception_resolved', args.actor, `[${target.type}] resolved — ${args.resolutionNote}`, { kind: 'exception', id: args.exceptionId });
      const audit = buildPackingAuditNote(`Packing exception resolved by ${args.actor} — [${target.type}] ${args.resolutionNote}`);
      return {
        ...s,
        packingStatus: nextStatus,
        packingExceptions: nextExceptions,
        packingHistory: [...(s.packingHistory || []), history],
        internalNotes: [...(s.internalNotes || []), audit],
      };
    }));
  }, []);
  const completePackingForShipment = useCallback((id: string, args: {
    actor: string; note?: string; override?: boolean; overrideReason?: string;
    // Phase 3 Pass #10 correction — caller supplies the source-item
    // expectations it computed (the data layer can't see invoices/repairs/
    // transfers/RMAs). When provided and !override, the mutator validates
    // every key has a verification with verifiedQty >= expectedQty. When
    // omitted (e.g. source item list unavailable), this prereq is skipped
    // — same semantics as the UI shows ("N/A — source items unavailable").
    expectedSourceItems?: { key: string; expectedQty: number }[];
  }): { ok: true } | { ok: false; reason: string } => {
    // Phase 3 Pass #10 correction — defense-in-depth: the override path
    // requires a non-empty reason at the mutator layer too (the UI also
    // enforces this, but a future programmatic caller could bypass UI).
    if (args.override) {
      const overrideText = (args.overrideReason || args.note || '').trim();
      if (!overrideText) return { ok: false, reason: 'override_reason_required' };
    }
    let result: { ok: true } | { ok: false; reason: string } = { ok: false, reason: 'shipment_not_found' };
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      // Idempotent: already-packed is a no-op-success.
      if (s.packingStatus === 'packed') { result = { ok: true }; return s; }
      // Prerequisite checks (skipped only when override=true).
      const openExceptions = (s.packingExceptions || []).filter(e => !e.resolvedAt);
      const packageVerifications = s.packingPackageVerifications || [];
      const itemVerifications = s.packingItemVerifications || [];
      const allPackagesVerified = s.packages.every(p => {
        const v = packageVerifications.find(pv => pv.packageId === p.id);
        return !!v && v.weightConfirmed && v.dimensionsConfirmed;
      });
      // Phase 3 Pass #10 correction — validate caller-supplied source items
      // at the data layer so packingStatus='packed' cannot be reached
      // through a programmatic call that skipped the UI's checklist.
      const allItemsVerified = !args.expectedSourceItems || args.expectedSourceItems.every(si => {
        const v = itemVerifications.find(iv => iv.sourceItemKey === si.key);
        return !!v && v.verifiedQty >= si.expectedQty;
      });
      if (!args.override) {
        if (openExceptions.length > 0) { result = { ok: false, reason: 'open_exceptions' }; return s; }
        if (!allPackagesVerified) { result = { ok: false, reason: 'packages_unverified' }; return s; }
        if (!allItemsVerified) { result = { ok: false, reason: 'items_unverified' }; return s; }
      }
      const now = new Date().toISOString();
      const baseHistory: PackingHistoryEntry[] = [...(s.packingHistory || [])];
      const baseNotes: any[] = [...(s.internalNotes || [])];
      if (args.override) {
        const reason = (args.overrideReason || args.note || '').trim();
        baseHistory.push(buildPackingHistoryEntry('override_used', args.actor, `Completion override — ${reason} (open exceptions: ${openExceptions.length}, packages verified: ${allPackagesVerified ? 'yes' : 'no'}, items verified: ${allItemsVerified ? 'yes' : 'no'})`, { kind: 'shipment', id: s.id }));
        baseNotes.push(buildPackingAuditNote(`Packing completion override used by ${args.actor} — ${reason} (open exceptions: ${openExceptions.length}, packages verified: ${allPackagesVerified ? 'yes' : 'no'}, items verified: ${allItemsVerified ? 'yes' : 'no'})`));
      }
      const noteText = args.note?.trim() ? ` — ${args.note.trim()}` : '';
      baseHistory.push(buildPackingHistoryEntry('completed', args.actor, args.note, { kind: 'shipment', id: s.id }));
      baseNotes.push(buildPackingAuditNote(`Packing completed by ${args.actor}${noteText}`));
      // Phase 3 Pass #12 Part A — flip shipment.status to 'Packed' when
      // packing completes. Snapshots the prior status into prePackingStatus
      // so reopenPacking can revert. Skipped when status is already 'Packed'
      // (no-op) or when a label has been purchased (defense-in-depth — UI
      // also blocks packing completion after label purchase, but a
      // programmatic caller could bypass UI). The snapshot is also skipped
      // when the prior status is downstream of pre-dispatch (Dispatched,
      // Delivered, etc.) so we never overwrite a terminal/in-flight status.
      const PRE_DISPATCH_FOR_PACK: Shipment['status'][] = ['Draft', 'Ready', 'Label Created'];
      const shouldFlipStatus = !s.label
        && s.status !== 'Packed'
        && PRE_DISPATCH_FOR_PACK.includes(s.status);
      const statusUpdates: Partial<Shipment> = shouldFlipStatus
        ? { status: 'Packed', prePackingStatus: s.status }
        : {};
      result = { ok: true };
      return {
        ...s,
        packingStatus: 'packed',
        packedBy: args.actor,
        packedAt: now,
        ...(args.note ? { packingNotes: args.note } : {}),
        packingHistory: baseHistory,
        internalNotes: baseNotes,
        ...statusUpdates,
      };
    }));
    return result;
  }, []);
  const reopenPacking = useCallback((id: string, args: { actor: string; note: string }) => {
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      // Reopen only meaningful from packed / not_required. From any other
      // state it's a no-op so audit doesn't pile up duplicate entries.
      if (s.packingStatus !== 'packed' && s.packingStatus !== 'not_required') return s;
      // Phase 3 Pass #12 Part C — defense-in-depth: never reopen packing
      // after a label has been purchased. The UI also blocks the reopen
      // button when label exists, but the mutator must hold the line in
      // case a programmatic caller bypasses the UI.
      if (s.label) return s;
      // Recompute base operational status (open exceptions wins).
      const exceptions = s.packingExceptions || [];
      const nextStatus = exceptions.some(e => !e.resolvedAt) ? 'exception' as const : 'in_progress' as const;
      const history = buildPackingHistoryEntry('reopened', args.actor, args.note, { kind: 'shipment', id: s.id });
      const audit = buildPackingAuditNote(`Packing reopened by ${args.actor} — ${args.note}`);
      // Phase 3 Pass #12 Part C — revert the shipment status flip done by
      // completePackingForShipment. Only revert when the current status is
      // 'Packed' (the flip's target) AND a snapshot exists. This keeps the
      // mutator backward-compatible with shipments whose 'Packed' status
      // came from the legacy manual transition (no snapshot present), and
      // never overwrites Dispatched/Delivered/etc. Selected rate is also
      // cleared because Get Rates is going to re-block via Pass #11's
      // packing-readiness gate, and the existing rate is no longer
      // meaningful once the operator chose to reopen the pack-out.
      const shouldRevertStatus = s.status === 'Packed' && !!s.prePackingStatus;
      const statusUpdates: Partial<Shipment> = shouldRevertStatus
        ? { status: s.prePackingStatus!, prePackingStatus: undefined, selectedRate: undefined }
        : { prePackingStatus: undefined };
      return {
        ...s,
        packingStatus: nextStatus,
        packedBy: undefined,
        packedAt: undefined,
        packingHistory: [...(s.packingHistory || []), history],
        internalNotes: [...(s.internalNotes || []), audit],
        ...statusUpdates,
      };
    }));
  }, []);
  const markPackingNotRequired = useCallback((id: string, args: { actor: string; note: string }) => {
    setShipments(prev => prev.map(s => {
      if (s.id !== id) return s;
      // Cannot mark not-required while open exceptions exist — operator must
      // resolve or override first. UI prevents this; server-side guard for safety.
      const openExceptions = (s.packingExceptions || []).filter(e => !e.resolvedAt);
      if (openExceptions.length > 0) return s;
      const history = buildPackingHistoryEntry('override_used', args.actor, `Marked not required — ${args.note}`, { kind: 'shipment', id: s.id });
      const audit = buildPackingAuditNote(`Packing marked not required by ${args.actor} — ${args.note}`);
      return {
        ...s,
        packingStatus: 'not_required',
        packingHistory: [...(s.packingHistory || []), history],
        internalNotes: [...(s.internalNotes || []), audit],
      };
    }));
  }, []);
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const addAutomationRule = useCallback((rule: AutomationRule) => { setAutomationRules(prev => [rule, ...prev]); }, []);
  const updateAutomationRule = useCallback((id: string, updates: Partial<AutomationRule>) => { setAutomationRules(prev => prev.map(r => r.id === id ? { ...r, ...updates, updatedAt: new Date().toISOString() } : r)); }, []);
  const deleteAutomationRule = useCallback((id: string) => { setAutomationRules(prev => prev.filter(r => r.id !== id)); }, []);
  const bumpAutomationRuleStats = useCallback((entries: { ruleId: string; runDelta: number; matchDelta: number; lastEvaluation?: AutomationRule['lastEvaluation'] }[], lastRunAt: string) => {
    if (!entries || entries.length === 0) return;
    const map = new Map(entries.map(e => [e.ruleId, e]));
    setAutomationRules(prev => prev.map(r => {
      const e = map.get(r.id);
      if (!e) return r;
      return {
        ...r,
        runCount: (r.runCount || 0) + e.runDelta,
        matchCount: (r.matchCount || 0) + e.matchDelta,
        lastRunAt,
        lastEvaluation: e.lastEvaluation ?? r.lastEvaluation,
      };
    }));
  }, []);
  const [automationLogs, setAutomationLogs] = useState<AutomationLogEntry[]>([]);
  const appendAutomationLogs = useCallback((entries: AutomationLogEntry[]) => {
    if (!entries || entries.length === 0) return;
    setAutomationLogs(prev => [...entries, ...prev].slice(0, 500));
  }, []);
  const [shipmentBatches, setShipmentBatches] = useState<ShipmentBatch[]>([]);
  const addShipmentBatch = useCallback((batch: ShipmentBatch) => { setShipmentBatches(prev => [batch, ...prev]); }, []);
  const updateShipmentBatch = useCallback((id: string, updates: Partial<ShipmentBatch>) => { setShipmentBatches(prev => prev.map(b => b.id === id ? { ...b, ...updates } : b)); }, []);

  const [returns, setReturns] = useState<Return[]>(SEED_RETURNS);
  const addReturn = useCallback((r: Return) => { setReturns(prev => [r, ...prev]); }, []);
  const updateReturn = useCallback((id: string, updates: Partial<Return>) => { setReturns(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r)); }, []);

  const findDuplicateCustomers = useCallback((name: string, email: string, phone: string) => {
    const e = email.trim().toLowerCase();
    const p = phone.trim();
    const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
    return customers.filter(c => {
      if (e && c.email.toLowerCase() === e) return true;
      if (p && c.phone === p) return true;
      if (n && n.length >= 3) {
        const cn = c.name.trim().toLowerCase().replace(/\s+/g, ' ');
        if (cn === n) {
          if (e || p) return true;
          if (!e && !p) return true;
        }
      }
      return false;
    });
  }, [customers]);

  return (
    <StoreLocalStateContext.Provider value={{
      customers, addCustomer, updateCustomer,
      stockItems, addStockItem, updateStockItem, deleteStockItem, approvedStockItems, pendingStockItems,
      heldOrders, addHeldOrder, removeHeldOrder,
      suggestiveSalesItems, addSuggestiveSaleItem, removeSuggestiveSaleItem,
      draftCart, setDraftCart, clearDraftCart,
      completedOrders, addCompletedOrder, updateCompletedOrder,
      refundRecords, addRefundRecord,
      warrantyClaims, addWarrantyClaim, updateWarrantyClaim,
      posOperator, setPosOperator,
      repairTickets, addRepairTicket, updateRepairTicket, deleteRepairTicket,
      warrantyRepairTickets, addWarrantyRepairTicket, updateWarrantyRepairTicket,
      pendingReplacements, addPendingReplacement, removePendingReplacement,
      invoices, addInvoice, updateInvoice, deleteInvoice,
      services, addService, updateService, deleteService,
      serviceCategories, addServiceCategory, updateServiceCategory, deleteServiceCategory,
      findDuplicateCustomers,
      loyaltyConfig, updateLoyaltyConfig,
      loyaltyAdjustments, addLoyaltyAdjustment,
      documentTemplates, updateDocumentTemplate, resetDocumentTemplate,
      storeBranding, updateStoreBranding,
      suppliers, addSupplier, updateSupplier,
      stockMovements, addStockMovement,
      purchaseOrders, addPurchaseOrder, updatePurchaseOrder,
      goodsReceivedNotes, addGoodsReceivedNote,
      rmas, addRMA, updateRMA,
      inventoryTransfers, addInventoryTransfer, updateInventoryTransfer,
      inventoryCounts, addInventoryCount, updateInventoryCount,
      tradeIns, addTradeIn, updateTradeIn, deleteTradeIn,
      refurbishmentJobs, addRefurbishmentJob, updateRefurbishmentJob,
      supplierRefundEntries, addSupplierRefundEntry,
      shipments, addShipment, updateShipment, resolveShipmentReview, setReviewOutcome,
      startPacking, recordPackingItemVerification, recordPackingPackageVerification,
      addPackingException, resolvePackingException, completePackingForShipment,
      reopenPacking, markPackingNotRequired,
      automationRules, addAutomationRule, updateAutomationRule, deleteAutomationRule, bumpAutomationRuleStats,
      automationLogs, appendAutomationLogs,
      shipmentBatches, addShipmentBatch, updateShipmentBatch,
      shippingProviderConfig, setShippingProviderConfig,
      shippingServiceAvailability, setShippingServiceAvailability,
      returns, addReturn, updateReturn,
      storeLocations, getItemMovements,
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
