import {
  ActivationMode,
  CommercialInvoice,
  CommercialInvoiceLineItem,
  CommercialInvoiceStatus,
  TenantFeatureOverride,
  commercialInvoices,
} from './mockData';

const INVOICES_KEY = 'commercial_invoices_data';

export function readInvoices(): CommercialInvoice[] {
  if (typeof sessionStorage === 'undefined') return commercialInvoices;
  try {
    const raw = sessionStorage.getItem(INVOICES_KEY);
    if (!raw) return commercialInvoices;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return commercialInvoices;
    return parsed as CommercialInvoice[];
  } catch {
    return commercialInvoices;
  }
}

export function writeInvoices(rows: CommercialInvoice[]): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(INVOICES_KEY, JSON.stringify(rows));
  } catch {
    // best-effort
  }
}

export function getInvoiceById(invoiceId: string): CommercialInvoice | undefined {
  return readInvoices().find(i => i.invoiceId === invoiceId);
}

export function getInvoicesForTenant(tenantId: string): CommercialInvoice[] {
  return readInvoices().filter(i => i.tenantId === tenantId);
}

export function getOpenInvoiceForFeature(tenantId: string, featureId: string): CommercialInvoice | undefined {
  return readInvoices().find(
    i =>
      i.tenantId === tenantId &&
      i.featureId === featureId &&
      (i.status === 'open' || i.status === 'overdue'),
  );
}

// Compute the user-visible status for an invoice. `open` invoices flip
// to `overdue` once their dueDate has passed; `paid` and `cancelled`
// are terminal. The stored row keeps its raw status field; this helper
// just derives display state from `nowMs`.
export function deriveInvoiceUiStatus(
  inv: CommercialInvoice,
  nowMs: number = Date.now(),
): CommercialInvoiceStatus {
  if (inv.status === 'paid' || inv.status === 'cancelled') return inv.status;
  if (inv.status === 'overdue') return 'overdue';
  // open → overdue once past dueDate
  const due = Date.parse(inv.dueDate);
  if (!Number.isNaN(due) && due < nowMs) return 'overdue';
  return 'open';
}

interface CreateInvoiceArgs {
  tenantId: string;
  featureId: string;
  featureName: string;
  addOnId?: string | null;
  amount: number;
  cadence: 'monthly' | 'annual' | 'one_time';
  dueDate: string;
  activationMode: ActivationMode;
  createdBy: string;
  notes?: string;
}

let invoiceCounter = 0;
function nextInvoiceId(): string {
  invoiceCounter += 1;
  // Composite suffix uses time + counter to stay unique across grants
  // within a session without leaking PII.
  const stamp = Date.now().toString(36).slice(-5).toUpperCase();
  return `CINV-${new Date().getFullYear()}-${stamp}${invoiceCounter.toString(36).toUpperCase()}`;
}

export function createInvoiceForOverride(args: CreateInvoiceArgs): CommercialInvoice {
  const cadenceLabel = args.cadence === 'monthly' ? 'monthly' : args.cadence === 'annual' ? 'annual' : 'one-time';
  const lineItem: CommercialInvoiceLineItem = {
    description: `${args.featureName} ${args.addOnId ? 'add-on' : 'paid override'} (${cadenceLabel})`,
    amount: args.amount,
    featureId: args.featureId,
    addOnId: args.addOnId ?? undefined,
  };
  const invoice: CommercialInvoice = {
    invoiceId: nextInvoiceId(),
    tenantId: args.tenantId,
    status: 'open',
    invoiceType: args.addOnId ? 'addon' : 'paid_override',
    amount: args.amount,
    currency: 'USD',
    cadence: args.cadence,
    dueDate: args.dueDate,
    issuedDate: new Date().toISOString().slice(0, 10),
    lineItems: [lineItem],
    notes: args.notes,
    overrideId: `${args.tenantId}:${args.featureId}`,
    featureId: args.featureId,
    addOnId: args.addOnId ?? undefined,
    activationMode: args.activationMode,
    createdBy: args.createdBy,
  };
  const next = [invoice, ...readInvoices()];
  writeInvoices(next);
  return invoice;
}

export function markInvoicePaid(invoiceId: string): CommercialInvoice | undefined {
  const rows = readInvoices();
  const idx = rows.findIndex(i => i.invoiceId === invoiceId);
  if (idx === -1) return undefined;
  const updated: CommercialInvoice = {
    ...rows[idx],
    status: 'paid',
    paidDate: new Date().toISOString().slice(0, 10),
  };
  rows[idx] = updated;
  writeInvoices(rows);
  return updated;
}

export function cancelInvoice(invoiceId: string): CommercialInvoice | undefined {
  const rows = readInvoices();
  const idx = rows.findIndex(i => i.invoiceId === invoiceId);
  if (idx === -1) return undefined;
  const updated: CommercialInvoice = {
    ...rows[idx],
    status: 'cancelled',
    cancelledDate: new Date().toISOString().slice(0, 10),
  };
  rows[idx] = updated;
  writeInvoices(rows);
  return updated;
}

// Helper used by the Features tab to know whether a paid override that
// is currently `paid_override` (immediate-activation mode) should ALSO
// surface an "Invoice Open / Payment Due" badge.
export function getOverrideInvoiceUiState(
  override: TenantFeatureOverride,
  nowMs: number = Date.now(),
): { invoice: CommercialInvoice; uiStatus: CommercialInvoiceStatus } | null {
  if (!override.invoiceId) return null;
  const invoice = getInvoiceById(override.invoiceId);
  if (!invoice) return null;
  return { invoice, uiStatus: deriveInvoiceUiStatus(invoice, nowMs) };
}
