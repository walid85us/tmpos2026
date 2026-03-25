export interface CartItem {
  id: string;
  name: string;
  description: string;
  price: number;
  icon: string;
  type: 'product' | 'repair' | 'special' | 'deposit';
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

export interface TradeInItem {
  id: string;
  customerId: string;
  customerName: string;
  device: string;
  imei?: string;
  serialNumber?: string;
  condition: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Broken';
  buybackPrice: number;
  resalePrice?: number;
  status: 'Pending' | 'In Inventory' | 'Sold' | 'Refurbishing';
  createdAt: string;
}

export interface RefurbishmentJob {
  id: string;
  itemId: string; // Reference to TradeInItem or Product
  itemName: string;
  technicianId: string;
  technicianName: string;
  status: 'Pending' | 'In Progress' | 'Testing' | 'Completed';
  notes: string;
  partsUsed: { name: string; cost: number }[];
  totalCost: number;
  createdAt: string;
  completedAt?: string;
}

export interface InventoryTransfer {
  id: string;
  fromStore: string;
  toStore: string;
  items: { productId: string; name: string; quantity: number; isSerialized?: boolean; serials?: string[] }[];
  status: 'Draft' | 'Sent' | 'Received' | 'Cancelled';
  createdAt: string;
  receivedAt?: string;
}

export interface InventoryCount {
  id: string;
  date: string;
  status: 'In Progress' | 'Completed';
  items: { productId: string; name: string; expected: number; actual: number; discrepancy: number }[];
  performedBy: string;
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

export interface RepairTicket {
  id: string;
  ticketNumber: string;
  customerId: string;
  customerName: string;
  device: string;
  issue: string;
  status: 'Pending' | 'In Progress' | 'Completed' | 'Delivered' | 'Cancelled' | 'Awaiting Parts';
  priority: 'Low' | 'Medium' | 'High' | 'Rush';
  createdAt: string;
  updatedAt: string;
  estimatedCost: number;
  actualCost?: number;
  profit?: number;
  technicianId?: string;
  technicianName?: string;
  location?: string;
  diagnosticNotes?: string;
  preRepairCondition?: string[];
  postRepairCondition?: string[];
  attachments?: TicketAttachment[];
  comments?: TicketComment[];
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
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  totalSpent: number;
  lastVisit: string;
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
    type: 'product' | 'repair' | 'service' 
  }[];
  subtotal: number;
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
  remindersSent: number;
}

export interface RepairService {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  price: number;
  cost?: number;
  estimatedTime?: number; // in minutes
  flagNotes?: string;
  image?: string;
  sku?: string;
  warrantyPeriod?: string;
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
  status: 'Draft' | 'Pending' | 'Partially Received' | 'Received' | 'Cancelled';
  items: PurchaseOrderItem[];
  totalAmount: number;
  createdAt: string;
  expectedDate?: string;
  notes?: string;
}

export interface GoodsReceivedNote {
  id: string;
  grnNumber: string;
  poId: string;
  poNumber: string;
  supplierName: string;
  items: { productId: string; name: string; quantity: number; serials?: string[] }[];
  receivedAt: string;
  receivedBy: string;
}

export interface RMAItem {
  productId: string;
  name: string;
  quantity: number;
  reason: string;
  serialNumber?: string;
}

export interface RMA {
  id: string;
  rmaNumber: string;
  supplierName: string;
  items: RMAItem[];
  status: 'Pending' | 'Shipped' | 'Refunded' | 'Replaced' | 'Rejected';
  createdAt: string;
  trackingNumber?: string;
}

export type PermissionLevel = 'none' | 'view' | 'create' | 'edit' | 'approve' | 'manage' | 'full';

export interface EmployeeRole {
  id: string;
  name: string;
  permissions: Record<string, PermissionLevel> | string[];
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
  commissionRate?: number; // percentage or flat amount
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
