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

export type ShipmentStatus = 'Draft' | 'Ready' | 'Label Created' | 'Packed' | 'Dispatched' | 'In Transit' | 'Delivered' | 'Exception' | 'Rejected' | 'Returned' | 'Cancelled';
export type ShipmentType = 'customer_delivery' | 'repair_return' | 'store_transfer' | 'rma_outbound' | 'rma_return';
export type ShipmentSourceType = 'invoice' | 'repair' | 'transfer' | 'rma';

export interface ShipmentPackage {
  id: string;
  weight?: number;
  weightUnit?: 'lb' | 'kg';
  length?: number;
  width?: number;
  height?: number;
  dimensionUnit?: 'in' | 'cm';
  contentsSummary?: string;
  declaredValue?: number;
  insuredValue?: number;
}

export interface ShipmentEvent {
  id: string;
  timestamp: string;
  status: string;
  location?: string;
  description: string;
  performedBy?: string;
}

export interface ShipmentAddress {
  name: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email?: string;
}

export type AddressValidationStatus = 'pending' | 'validated' | 'corrected' | 'failed' | 'skipped';

export interface AddressValidationResult {
  status: AddressValidationStatus;
  validatedAt?: string;
  originalAddress: ShipmentAddress;
  suggestedAddress?: ShipmentAddress;
  messages?: string[];
  providerRef?: string;
  accepted?: boolean;
  // Carrier-/provider-specific deliverability diagnostics. For EasyPost this
  // carries the verifications.delivery.details payload (DPV match code,
  // dpv_footnotes, latitude/longitude, time_zone, etc.) so the operator can
  // see exactly why a delivery-validated address may still not be acceptable
  // for pickup booking.
  details?: Record<string, unknown>;
  // Provider error rows (DPV warnings, missing secondary info, …) returned
  // even when delivery success is true. Surfaced verbatim so we never claim
  // an address is fully verified while there are unresolved warnings.
  warnings?: { code?: string; message: string; field?: string }[];
}

export interface ShippingRate {
  id: string;
  providerId: string;
  carrier: string;
  serviceName: string;
  serviceCode: string;
  rate: number;
  currency: string;
  estimatedDays?: number;
  estimatedDelivery?: string;
  isGuaranteed?: boolean;
  providerRateRef?: string;
}

export interface LabelArtifact {
  id: string;
  format: 'pdf' | 'png' | 'zpl' | 'epl';
  url: string;
  pdfUrl?: string;
  originalFormat?: string;
  trackingNumber: string;
  carrier: string;
  service: string;
  purchasedAt: string;
  providerLabelRef?: string;
  providerShipmentRef?: string;
  cost: number;
  isReturn?: boolean;
}

export interface ProviderTrackingEvent {
  id: string;
  timestamp: string;
  status: string;
  statusDetail?: string;
  location?: string;
  description: string;
  source: 'provider' | 'manual' | 'test_provider' | 'webhook' | 'replay';
  providerEventRef?: string;
  receivedAt?: string;
  processingResult?: 'processed' | 'ignored' | 'duplicate' | 'failed';
  webhookEventId?: string;
}

export interface WebhookEventRecord {
  id: string;
  providerId: string;
  providerEventId?: string;
  eventType: string;
  trackingNumber?: string;
  shipmentRef?: string;
  receivedAt: string;
  processedAt?: string;
  processingResult: 'processed' | 'ignored' | 'duplicate' | 'failed' | 'pending';
  processingError?: string;
  mappedStatus?: string;
  source: 'webhook' | 'sync' | 'replay' | 'simulation';
  isTestMode: boolean;
  signatureVerified: boolean;
  retryCount: number;
}

export type ShippingProviderStatus = 'not_configured' | 'configured' | 'active' | 'error';

export interface ShippingProviderCredentials {
  apiKey?: string;
  apiSecret?: string;
  accountId?: string;
  environment?: 'test' | 'production';
  webhookSecret?: string;
}

export interface ShippingProviderConfig {
  providerId: string;
  providerName: string;
  status: ShippingProviderStatus;
  isDefault: boolean;
  credentials: ShippingProviderCredentials;
  credentialsMasked?: {
    apiKey?: string;
    apiSecret?: string;
    accountId?: string;
  };
  environment?: 'test' | 'production';
  configuredAt?: string;
  configuredBy?: string;
  updatedAt?: string;
  lastTestedAt?: string;
  testResult?: 'success' | 'failure';
  testMessage?: string;
}

export interface ShippingProvidersState {
  providers: ShippingProviderConfig[];
  activeProviderId: string | null;
}

export interface Shipment {
  id: string;
  shipmentNumber: string;
  type: ShipmentType;
  status: ShipmentStatus;
  sourceType: ShipmentSourceType;
  sourceId: string;
  sourceNumber: string;
  originAddress: ShipmentAddress;
  destinationAddress: ShipmentAddress;
  packages: ShipmentPackage[];
  carrier?: string;
  serviceLevel?: string;
  trackingNumber?: string;
  shippingCost?: number;
  estimatedDelivery?: string;
  events: ShipmentEvent[];
  notes?: string;
  labelUrl?: string;
  packingSlipUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  deliveredAt?: string;
  addressValidation?: AddressValidationResult;
  originAddressValidation?: AddressValidationResult;
  // Phase 2.6 — pickup-only address/contact override. Used ONLY for the
  // carrier pickup driver dispatch; never written to the printed label.
  // After label purchase, originAddress is locked but the operator may
  // still recover from a pickup-eligibility failure by supplying a
  // dispatch-only override (e.g. correct suite/dock/door, or a different
  // unit on the same property). resolvePickupAddress returns the override
  // when present, otherwise originAddress.
  pickupOverrideAddress?: ShipmentAddress;
  pickupOverrideAddressValidation?: AddressValidationResult;
  // Free-text dispatch detail for the pickup driver (suite, dock, door
  // code, building name, hours). Merged into address.line2 if line2 is
  // empty AND prepended to pickup instructions for provider visibility.
  pickupLocationDetail?: string;
  selectedRate?: ShippingRate;
  shipmentMode?: 'provider' | 'manual';
  label?: LabelArtifact;
  providerShipmentId?: string;
  providerTrackingId?: string;
  providerTrackingEvents?: ProviderTrackingEvent[];
  lastTrackingSyncAt?: string;
  ratesRetrievedAt?: string;
  availableRates?: ShippingRate[];

  lastWebhookEventAt?: string;
  webhookEventsCount?: number;
  syncFailureCount?: number;
  lastSyncError?: string;

  // Phase 3: automation/batch foundation. All optional — present only when
  // an Automation Rule has fired against the shipment or an operator has
  // assembled it into a batch. Truthful: rules cannot purchase labels or
  // change status; they can only flag, queue, prioritize, and annotate.
  flags?: string[];
  priority?: 'normal' | 'high' | 'urgent';
  reviewNeeded?: { reason?: string; ruleId?: string; ruleName?: string; markedAt: string } | null;
  batchQueueState?: 'ready_for_batch' | 'batched' | null;
  batchQueueMarkedAt?: string;
  batchQueueRuleId?: string;
  internalNotes?: ShipmentInternalNote[];
  customsInfo?: {
    contentsType?: string;
    contentsExplanation?: string;
    declaredValue?: number;
    currency?: string;
    hsCode?: string;
    originCountry?: string;
  };
  insuranceInfo?: {
    insured?: boolean;
    insuredValue?: number;
    currency?: string;
    provider?: string;
  };
  returnInfo?: {
    isReturn?: boolean;
    originalShipmentId?: string;
    returnReason?: string;
    returnRequestedAt?: string;
    returnLabelUrl?: string;
  };
  pickupInfo?: {
    pickupRequested?: boolean;
    pickupScheduledAt?: string;
    pickupConfirmationNumber?: string;
    servicePointId?: string;
  };
  // Phase 2: structured Service Point selection (drop-off location). When set, the
  // operator has chosen to hand the parcel off at a carrier-operated service point
  // rather than direct carrier handoff or carrier pickup. Provider-capability gated.
  servicePoint?: ServicePoint;
  // Phase 2: structured Pickup Request record. When set, the operator has scheduled
  // a carrier pickup for this shipment. Lifecycle-aware and provider-capability gated.
  pickupRequest?: PickupRequest;
  slaInfo?: {
    targetDeliveryAt?: string;
    slaType?: string;
    slaMet?: boolean;
    transitBusinessDays?: number;
  };
  batchId?: string;
}

// =====================================================================================
// Service Points & Pickup Requests (Phase 2)
// =====================================================================================
// These two domains add carrier handoff alternatives to the Shipping Center: a shipment
// can be dropped off at a carrier service point, picked up by the carrier at the origin
// address, or handed off directly. They are provider-capability gated — manual mode and
// providers without service-point or pickup APIs surface honest "not supported" UI.
//
// Forward-compatibility: every record below carries a `metadata?: Record<string, unknown>`
// extension slot so future Phase 2 additions (customs docs, insurance rules, carrier
// analytics) and Phase 3 additions (automation rules, batch labels, packing workflows,
// SLA optimization, carrier scorecards) can attach without a breaking schema change.

export interface ServicePointHours {
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  open?: string;
  close?: string;
  closed?: boolean;
}

export interface ServicePoint {
  id: string;                              // provider-assigned service-point id
  carrier: string;                         // 'UPS', 'FedEx', 'USPS', 'DHL', etc.
  providerId?: string;                     // app provider id ('easypost' | 'shippo' | 'shipstation')
  name: string;                            // 'UPS Access Point — 5th Ave Pharmacy'
  type?: 'access_point' | 'locker' | 'parcel_locker' | 'office' | 'retail_partner' | 'other';
  source?: 'live_locator' | 'manual' | 'preview';   // provenance of the selection
  address: ShipmentAddress;
  distanceKm?: number;                     // distance from origin if known
  hours?: ServicePointHours[];
  contactPhone?: string;
  contactEmail?: string;
  notes?: string;
  selectedAt?: string;                     // ISO timestamp of operator selection
  selectedBy?: string;                     // operator id/name
  selectionNotes?: string;                 // operator-entered context (e.g. "customer prefers")
  metadata?: Record<string, unknown>;      // forward-compat: customs/insurance/analytics
}

export type PickupRequestStatus =
  | 'requested'      // sent to provider, awaiting confirmation
  | 'scheduled'      // provider acknowledged, scheduled
  | 'confirmed'      // confirmation number issued
  | 'completed'      // pickup occurred (carrier scan)
  | 'cancelled'      // operator cancelled before pickup
  | 'failed'         // provider/carrier rejected at create time
  // Phase 2.6.1 — provider create succeeded and we have a providerPickupId,
  // but the rate-purchase / booking confirmation step failed (or returned
  // no rates). The pickup is NOT booked with the carrier — no
  // confirmation number was issued. Distinct from 'requested' so the UI
  // never shows a misleading booked/scheduled state for this case. The
  // provider pickup record is preserved so the operator can cancel it.
  | 'partial_failed'
  | 'rejected';      // carrier refused (e.g. weight, location)

export interface PickupRequest {
  id: string;                              // app-internal pickup request id
  shipmentId: string;
  providerId?: string;                     // app provider id
  carrier: string;                         // resolved carrier
  status: PickupRequestStatus;
  confirmationNumber?: string;             // provider/carrier confirmation
  providerPickupId?: string;               // provider-side pickup id (e.g. EasyPost pickup id) — required for cancel
  providerPickupCost?: number;             // pickup fee charged by carrier (when applicable)
  providerPickupCurrency?: string;
  // Phase 2.9 — exact carrier/service the operator selected at the
  // pickup_rates step (may differ from the shipment's selectedRate
  // service when the carrier returns multiple pickup-eligible options).
  providerPickupService?: string;
  providerPickupRateId?: string;           // provider-side rate id that was bought
  source?: 'live_provider' | 'local_only'; // honesty marker — local_only means no real carrier API call was made
  requestedDate: string;                   // ISO date — pickup day
  windowStart?: string;                    // 'HH:MM' earliest ready
  windowEnd?: string;                      // 'HH:MM' latest available
  pickupAddress: ShipmentAddress;          // usually shipment.originAddress
  contactName?: string;
  contactPhone?: string;
  packageCount?: number;
  totalWeight?: number;                    // pounds, summed across packages
  handlingNotes?: string;
  requestedAt: string;                     // operator action timestamp
  requestedBy: string;                     // operator id/name
  confirmedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancellationReason?: string;
  failureReason?: string;                  // surface from provider on failed/rejected
  metadata?: Record<string, unknown>;      // forward-compat: customs/insurance/analytics
}

export type ReturnStatus = 'Draft' | 'Requested' | 'Approved' | 'Ready' | 'Label Created' | 'Packed' | 'Dispatched' | 'In Transit' | 'Delivered' | 'Received' | 'Inspecting' | 'Completed' | 'Rejected' | 'Cancelled';

export type ReturnReason =
  | 'defective'
  | 'wrong_item'
  | 'not_as_described'
  | 'damaged_in_transit'
  | 'customer_changed_mind'
  | 'warranty_claim'
  | 'repair_return'
  | 'exchange_request'
  | 'missing_parts'
  | 'other';

export type ReturnResolution =
  | 'refund'
  | 'exchange'
  | 'repair'
  | 'store_credit'
  | 'inspection_only'
  | 'send_back'
  | 'dispose';

export type ReturnSourceType = 'invoice' | 'repair' | 'shipment' | 'rma' | 'walk_in';

export type ReturnDisposition =
  | 'restock'
  | 'refurbish'
  | 'dispose'
  | 'return_to_vendor'
  | 'send_back_to_customer'
  | 'warranty_replacement';

export interface ReturnItem {
  id: string;
  productId?: string;
  name: string;
  sku?: string;
  quantity: number;
  maxQuantity?: number;
  unitPrice?: number;
  condition?: 'New' | 'Like New' | 'Good' | 'Fair' | 'Poor' | 'Damaged' | 'Defective';
  reason?: ReturnReason;
  notes?: string;
  inspectionNotes?: string;
  disposition?: ReturnDisposition;
}

export interface ReturnStatusHistoryEntry {
  id: string;
  status: ReturnStatus;
  timestamp: string;
  performedBy: string;
  notes?: string;
}

export interface Return {
  id: string;
  returnNumber: string;
  status: ReturnStatus;

  sourceType: ReturnSourceType;
  sourceId: string;
  sourceNumber: string;

  customerId: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;

  reason: ReturnReason;
  reasonDetails?: string;
  requestedResolution: ReturnResolution;

  items: ReturnItem[];

  originalShipmentId?: string;
  returnShipmentId?: string;

  receivedAt?: string;
  receivedBy?: string;
  inspectionNotes?: string;
  inspectionCompletedAt?: string;
  inspectedBy?: string;
  itemCondition?: string;

  finalResolution?: ReturnResolution;
  finalDisposition?: ReturnDisposition;
  dispositionNotes?: string;
  dispositionCompletedAt?: string;
  dispositionCompletedBy?: string;

  refundAmount?: number;
  storeCreditAmount?: number;
  restockingFee?: number;

  servicePointId?: string;
  customsInfo?: Record<string, unknown>;
  pickupRequestId?: string;
  insuranceClaimId?: string;

  createdBy: string;
  createdAt: string;
  updatedAt: string;
  statusHistory: ReturnStatusHistoryEntry[];
  notes?: string;
}

export type LogoPlacement = 'top-left' | 'top-center' | 'top-right';

export interface StoreBranding {
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
}

export type AutomationTriggerType =
  | 'shipment_created'
  | 'shipment_updated'
  | 'status_changed'
  | 'label_purchased'
  | 'pickup_requested'
  | 'pickup_confirmed'
  | 'pickup_cancelled'
  | 'tracking_synced'
  | 'return_shipment_created';

export type AutomationConditionField =
  | 'mode'
  | 'status'
  | 'sourceType'
  | 'carrier'
  | 'serviceLevel'
  | 'addressValidationState'
  | 'hasLabel'
  | 'hasPickup'
  | 'shippingCost';

export type AutomationConditionOp =
  | 'eq' | 'neq' | 'in' | 'notIn'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'truthy' | 'falsy';

export interface AutomationCondition {
  field: AutomationConditionField;
  op: AutomationConditionOp;
  value?: any;
}

export type AutomationActionType =
  | 'add_flag'
  | 'add_internal_note'
  | 'mark_review_needed'
  | 'mark_ready_for_batch'
  | 'set_priority';

export interface AutomationAction {
  type: AutomationActionType;
  params?: Record<string, any>;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTriggerType;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  description?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  lastRunAt?: string;
  runCount?: number;
  matchCount?: number;
}

export interface AutomationLogEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  shipmentId: string;
  shipmentNumber: string;
  trigger: AutomationTriggerType;
  matched: boolean;
  actionsApplied: string[];
  reason?: string;
  timestamp: string;
}

export type BatchStatus = 'draft' | 'processing' | 'completed' | 'completed_with_errors' | 'cancelled';

export type BatchOutcome = 'success' | 'failed' | 'skipped';

export interface BatchLabelResult {
  shipmentId: string;
  shipmentNumber: string;
  outcome: BatchOutcome;
  reason?: string;
  trackingNumber?: string;
  carrier?: string;
  service?: string;
  cost?: number;
  timestamp: string;
}

export interface ShipmentBatch {
  id: string;
  name: string;
  status: BatchStatus;
  shipmentIds: string[];
  results: BatchLabelResult[];
  createdAt: string;
  createdBy: string;
  startedAt?: string;
  completedAt?: string;
  notes?: string;
}

export interface ShipmentInternalNote {
  id: string;
  text: string;
  timestamp: string;
  source: 'rule' | 'operator';
  ruleId?: string;
  ruleName?: string;
}
