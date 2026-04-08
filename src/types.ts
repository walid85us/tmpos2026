export interface CartItem {
  id: string;
  name: string;
  description: string;
  price: number;
  qty?: number;
  icon: string;
  type: 'product' | 'repair' | 'special' | 'deposit';
  stockItemId?: string;
  imei?: string;
  passcode?: string;
  serialNumber?: string;
  network?: string;
  patternLock?: string;
  customFields?: Record<string, string>;
  warrantyPeriod?: string;
}

export interface PaymentMethod {
  id: string;
  method: string;
  amount: number;
  icon: string;
  detail?: string;
  locked?: boolean;
}

export interface Discount {
  id: string;
  name: string;
  type: 'percent' | 'fixed';
  value: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  costPrice?: number;
  stock: number;
  sku: string;
  upc?: string;
  type: 'serialized' | 'non-serialized' | 'handset' | 'service' | 'bundle';
  manufacturer?: string;
  attributes?: Record<string, string>;
  variants?: string[];
  minStockLevel?: number;
  maxStockLevel?: number;
  location?: string;
  taxId?: string;
  isHiddenOnPOS?: boolean;
  images?: string[];
  description?: string;
}

export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  website?: string;
  notes?: string;
  status: 'Active' | 'Inactive';
  createdAt: string;
}

export type StockMovementType =
  | 'adjustment_increase'
  | 'adjustment_decrease'
  | 'sale'
  | 'refund_restock'
  | 'repair_consumption'
  | 'repair_return'
  | 'transfer_out'
  | 'transfer_in'
  | 'receiving'
  | 'trade_in_conversion'
  | 'refurbishment_complete'
  | 'rma_return'
  | 'initial_stock'
  | 'count_adjustment';

export interface StockMovement {
  id: string;
  stockItemId: string;
  stockItemName: string;
  type: StockMovementType;
  quantityChange: number;
  previousQty: number;
  newQty: number;
  reason?: string;
  referenceId?: string;
  referenceType?: 'purchase_order' | 'transfer' | 'repair_ticket' | 'order' | 'rma' | 'count' | 'trade_in' | 'refurbishment';
  performedBy: string;
  timestamp: string;
  notes?: string;
}

export interface TradeInItem {
  id: string;
  customerId: string;
  customerName: string;
  device: string;
  imei?: string;
  serialNumber?: string;
  condition: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Broken';
  gradeNotes?: string;
  buybackPrice: number;
  resalePrice?: number;
  status: 'Pending' | 'Evaluated' | 'In Inventory' | 'Sold' | 'Refurbishing';
  movedToInventoryId?: string;
  isWalkIn?: boolean;
  idPhotoUrl?: string;
  createdAt: string;
}

export interface RefurbishmentJob {
  id: string;
  itemId: string;
  itemName: string;
  technicianId: string;
  technicianName: string;
  status: 'Pending' | 'In Progress' | 'Testing' | 'Completed';
  notes: string;
  refurbNotes?: string;
  partsUsed: { name: string; cost: number }[];
  totalCost: number;
  estimatedCompletion?: string;
  resultingProductId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface TransferLineItem {
  productId: string;
  name: string;
  sku?: string;
  quantity: number;
  receivedQty?: number;
  variance?: number;
  condition?: 'Good' | 'Damaged' | 'Missing';
  discrepancyNote?: string;
  isSerialized?: boolean;
  serials?: string[];
  receivedSerials?: string[];
  supplierId?: string;
  supplierName?: string;
}

export interface InventoryTransfer {
  id: string;
  transferNumber: string;
  fromStore: string;
  toStore: string;
  items: TransferLineItem[];
  status: 'Draft' | 'Sent' | 'In Transit' | 'Received' | 'Partially Received' | 'Discrepancy Detected' | 'Cancelled';
  requestedBy: string;
  notes?: string;
  createdAt: string;
  sentAt?: string;
  receivedAt?: string;
  reconciledBy?: string;
}

export interface InventoryCount {
  id: string;
  countNumber: string;
  date: string;
  status: 'In Progress' | 'Completed' | 'Closed' | 'Cancelled';
  items: { productId: string; name: string; sku: string; expected: number; actual: number; discrepancy: number }[];
  performedBy: string;
  notes?: string;
  completedAt?: string;
  adjustedAt?: string;
  adjustedBy?: string;
}

export interface BillPayment {
  id: string;
  vendorName: string;
  amount: number;
  dueDate: string;
  status: 'Unpaid' | 'Partially Paid' | 'Paid' | 'Overdue';
  paymentHistory: { date: string; amount: number; method: string }[];
  remindersSent: number;
}

export interface GiftCard {
  id: string;
  cardNumber: string;
  initialBalance: number;
  currentBalance: number;
  customerId?: string;
  customerName?: string;
  expiryDate: string;
  status: 'Active' | 'Expired' | 'Redeemed' | 'Cancelled';
  createdAt: string;
}

export interface InventoryBundle {
  id: string;
  name: string;
  items: { productId: string; name: string; quantity: number }[];
  price: number;
  sku: string;
}

export interface TicketAttachment {
  id: string;
  name: string;
  url: string;
  type: 'image' | 'document';
  uploadedAt: string;
}

export interface TicketComment {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: string;
  isInternal: boolean;
}

export interface TicketHistory {
  id: string;
  action: string;
  performedBy: string;
  timestamp: string;
  details?: string;
}

export type RepairTicketStatus = 'Pending' | 'Diagnosed' | 'In Progress' | 'Awaiting Parts' | 'Ready for Pickup' | 'Completed' | 'Delivered' | 'Cancelled';

export interface RepairServiceLineItem {
  id: string;
  serviceId: string;
  name: string;
  price: number;
  cost: number;
  warrantyPeriod?: string;
}

export interface RepairTicket {
  id: string;
  ticketNumber: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  device: string;
  deviceCategory?: string;
  brand?: string;
  model?: string;
  issue: string;
  status: RepairTicketStatus;
  priority: 'Low' | 'Medium' | 'High' | 'Rush';
  createdAt: string;
  updatedAt: string;
  estimatedCost: number;
  actualCost?: number;
  profit?: number;
  technicianId?: string;
  technicianName?: string;
  location?: string;
  intakeNotes?: string;
  diagnosticNotes?: string;
  internalNotes?: string;
  preRepairCondition?: string[];
  postRepairCondition?: string[];
  attachments?: TicketAttachment[];
  comments?: TicketComment[];
  serviceLineItems?: RepairServiceLineItem[];
  partsUsed?: { itemId: string; name: string; price: number; quantity: number }[];
  billableHours?: number;
  isRushJob?: boolean;
  estimates?: { name: string; price: number }[];
  imei?: string;
  serialNumber?: string;
  passcode?: string;
  network?: string;
  patternLock?: string;
  unlockingDetails?: string;
  storeLocationId?: string;
  history?: TicketHistory[];
  customFields?: Record<string, string>;
  linkedInvoiceId?: string;
  linkedWarrantyClaimId?: string;
  isWarrantyRepair?: boolean;
}

export interface CustomerNote {
  id: string;
  text: string;
  date: string;
  flagged: boolean;
}

export interface CustomerAsset {
  id: string;
  model: string;
  serial: string;
  type: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  phoneLabel?: string;
  address?: string;
  totalSpent: number;
  lastVisit: string;
  loyaltyPoints?: number;
  tier?: 'Platinum' | 'Gold' | 'Silver' | 'Bronze';
  group?: string;
  tags?: string[];
  notes?: CustomerNote[];
  assets?: CustomerAsset[];
  customFields?: { label: string; value: string }[];
  gdprCompliant?: boolean;
  campaignerStatus?: 'Subscribed' | 'Unsubscribed' | 'Pending';
  thirdPartyBilling?: boolean;
  createdAt?: string;
}

export interface Sale {
  id: string;
  items: { productId: string; quantity: number; price: number }[];
  total: number;
  timestamp: string;
  customerId?: string;
}

export interface Shift {
  id: string;
  employeeId: string;
  startTime: string;
  endTime?: string;
  openingBalance: number;
  closingBalance?: number;
  status: 'Open' | 'Closed';
}

export interface RegisterTransaction {
  id: string;
  shiftId: string;
  type: 'Cash In' | 'Cash Out' | 'Sale' | 'Refund' | 'Expense';
  amount: number;
  reason?: string;
  timestamp: string;
  category?: string;
  paymentMethod?: string;
}

export interface WarrantyClaim {
  id: string;
  originalInvoiceId: string;
  customerId: string;
  itemId: string;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  createdAt: string;
}

export interface Expense {
  id: string;
  amount: number;
  category: string;
  description: string;
  date: string;
  paymentMethod: string;
}

export interface HeldOrder {
  id: string;
  customerId?: string;
  customerName?: string;
  items: CartItem[];
  total: number;
  createdAt: string;
  note?: string;
  payments?: PaymentMethod[];
  discounts?: Discount[];
  customer?: Customer | null;
}

export interface SpecialPartOrder {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  estimatedPrice: number;
  depositPaid: number;
  customerId: string;
  status: 'Pending' | 'Ordered' | 'Received' | 'Cancelled';
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  items: { 
    id: string; 
    name: string; 
    quantity: number; 
    price: number; 
    type: 'product' | 'repair' | 'service';
    stockItemId?: string;
  }[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  amountPaid: number;
  balance: number;
  status: 'Unpaid' | 'Partially Paid' | 'Paid' | 'Overdue' | 'Cancelled';
  createdAt: string;
  dueDate: string;
  notes?: string;
  terms?: string;
  isRecurring?: boolean;
  recurringInterval?: 'monthly' | 'weekly' | 'yearly';
  paymentHistory: {
    id: string;
    amount: number;
    method: string;
    timestamp: string;
    transactionId?: string;
  }[];
  statusHistory?: {
    id: string;
    action: 'created' | 'paid' | 'partially_paid' | 'reopened' | 'cancelled' | 'reopened_supervisor';
    fromStatus: string;
    toStatus: string;
    timestamp: string;
    actor?: string;
    note?: string;
  }[];
  remindersSent: number;
}

export interface RepairService {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  price: number;
  cost?: number;
  estimatedTime?: number;
  flagNotes?: string;
  image?: string;
  sku?: string;
  warrantyPeriod?: string;
  warrantyType?: 'none' | 'labor' | 'parts-and-labor';
  taxId?: string;
  status: 'Active' | 'Inactive';
}

export interface RepairCategory {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  parentCategoryId?: string;
}

export interface PurchaseOrderItem {
  productId: string;
  name: string;
  sku?: string;
  orderedQuantity: number;
  receivedQuantity: number;
  costPrice: number;
  isSerialized?: boolean;
  serials?: string[];
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  status: 'Draft' | 'Ordered' | 'Partially Received' | 'Received' | 'Cancelled';
  items: PurchaseOrderItem[];
  totalAmount: number;
  createdAt: string;
  orderedAt?: string;
  expectedDate?: string;
  receivedDate?: string;
  notes?: string;
  createdBy?: string;
}

export interface GoodsReceivedNote {
  id: string;
  grnNumber: string;
  poId: string;
  poNumber: string;
  supplierId?: string;
  supplierName: string;
  items: { productId: string; name: string; orderedQty?: number; quantity: number; costPrice?: number; serials?: string[] }[];
  receivedAt: string;
  receivedBy: string;
  notes?: string;
}

export interface RMAItem {
  productId: string;
  name: string;
  quantity: number;
  reason: string;
  serialNumber?: string;
  shippedQty?: number;
  refundedQty?: number;
  replacedQty?: number;
}

export interface RMA {
  id: string;
  rmaNumber: string;
  supplierId?: string;
  supplierName: string;
  poId?: string;
  poNumber?: string;
  items: RMAItem[];
  status: 'Pending' | 'Shipped' | 'Refunded' | 'Replaced' | 'Rejected' | 'Partially Resolved' | 'Closed';
  createdAt: string;
  trackingNumber?: string;
  notes?: string;
  createdBy?: string;
  refundAmount?: number;
  refundTax?: number;
  refundMethod?: string;
  refundNotes?: string;
  replacementItems?: { productId: string; name: string; quantity: number }[];
}

export interface SupplierRefundEntry {
  id: string;
  rmaId: string;
  rmaNumber: string;
  supplierId: string;
  supplierName: string;
  amount: number;
  tax: number;
  method: string;
  notes?: string;
  createdAt: string;
  createdBy: string;
}

export type PermissionLevel = 'none' | 'view' | 'create' | 'edit' | 'manage' | 'approve' | 'full';

export interface EmployeeRole {
  id: string;
  name: string;
  permissions: Record<string, PermissionLevel> | string[];
  subPermissions?: Record<string, boolean>;
  description?: string;
}

export interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  roleId: string;
  roleName: string;
  pin: string;
  avatar?: string;
  status: 'Active' | 'Inactive' | 'Suspended' | 'Pending Invite';
  payRate: number;
  payType: 'Hourly' | 'Salary';
  commissionEnabled?: boolean;
  commissionType?: 'flat' | 'percentage';
  commissionRate?: number;
  is2FAEnabled?: boolean;
  createdAt: string;
  lastLogin?: string;
}

export interface EmployeeTimeLog {
  id: string;
  employeeId: string;
  employeeName: string;
  clockIn: string;
  clockOut?: string;
  totalHours?: number;
  breakStart?: string;
  breakEnd?: string;
  totalBreakMinutes?: number;
  status: 'Clocked In' | 'Clocked Out' | 'On Break';
}

export interface EmployeeActivityLog {
  id: string;
  employeeId: string;
  employeeName: string;
  action: string;
  details: string;
  timestamp: string;
  ipAddress?: string;
}

export interface EmployeeCommission {
  id: string;
  employeeId: string;
  saleId?: string;
  ticketId?: string;
  amount: number;
  status: 'Pending' | 'Paid';
  createdAt: string;
}

export interface EmployeePayroll {
  id: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  regularHours: number;
  overtimeHours: number;
  grossPay: number;
  commissions: number;
  deductions: number;
  netPay: number;
  status: 'Draft' | 'Paid';
  paidAt?: string;
}

export interface StoreSettings {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  currency: string;
  taxRate: number;
  taxNumber?: string;
  timezone: string;
  timeFormat: '12h' | '24h';
  decimalSeparator: '.' | ',';
  language: string;
  storeType: string;
  is2FAEnabled: boolean;
  notifications: {
    desktop: boolean;
    email: boolean;
    sms: boolean;
  };
}

export interface HardwareConfig {
  id: string;
  type: 'Printer' | 'Scanner' | 'Cash Drawer';
  name: string;
  connection: 'USB' | 'Network' | 'Cloud';
  status: 'Connected' | 'Disconnected';
}

export type View = 
  | 'dashboard' 
  | 'pos' 
  | 'repairs' 
  | 'inventory' 
  | 'customers' 
  | 'marketing' 
  | 'reports' 
  | 'employees'
  | 'ledger'
  | 'invoices'
  | 'services'
  | 'supply-chain'
  | 'integrations'
  | 'widgets'
  | 'prospects'
  | 'app-store'
  | 'mail-in'
  | 'settings' 
  | 'support';

export type TemplateType = 'invoice' | 'ticket' | 'label' | 'receipt' | 'estimate';

export interface TemplateMacro {
  tag: string;
  label: string;
  category: string;
}

export interface DocumentTemplate {
  id: string;
  type: TemplateType;
  name: string;
  content: string;
  enabledTags: string[];
  isDefault: boolean;
  updatedAt: string;
}

export type LogoPlacement = 'top-left' | 'top-center' | 'top-right';

export interface StoreBranding {
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
}
