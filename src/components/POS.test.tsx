import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import POS, { QUICK_ADD_STOCK_DEFAULTS } from './POS';

// Structural fix (TS2345): StockItem requires `type`, `isRepairPart` and `isHiddenOnPOS`,
// but the three POS quick-add call sites omitted all three. These are real runtime values
// written onto created inventory items — a wrong default would silently hide an item from
// the POS or mis-flag it as a repair part. The exact shape also pins that quick-add never
// invents an id, sku, price or stock quantity.
describe('QUICK_ADD_STOCK_DEFAULTS', () => {
  it('defaults quick-added stock to a visible, non-serialized, non-repair-part item and nothing else', () => {
    expect(QUICK_ADD_STOCK_DEFAULTS).toEqual({
      type: 'non-serialized',
      isRepairPart: false,
      isHiddenOnPOS: false,
    });
  });
});

// M5-GAP11-P5-R1 — the POS refund is re-decided when it executes. The refund authority itself is decided
// by canExecutePosRefund (AccessContext.test.tsx covers it); here it is a switch, so the test can show
// the screen asks again at execution, passes the open refund request, and withholds the final button.
const order = {
  id: 'ord-r1', invoiceNumber: 'INV-R1-0001', customerId: 'c-r1', customerName: 'Refund Customer', customerPhone: '', customerEmail: '',
  items: [{ id: 'it-r1', name: 'Screen Protector', qty: 1, unitPrice: 20, type: 'product' }],
  subtotal: 20, discountTotal: 0, tax: 0, total: 20, payments: [{ method: 'Cash', amount: 20 }],
  status: 'Paid', createdAt: '2026-03-01T00:00:00.000Z', operatorName: 'Sarah',
};
const addRefundRecord = vi.fn();
// Stable singletons, as the real providers return them.
const storeValue = {
  customers: [], addCustomer: vi.fn(), updateCustomer: vi.fn(), stockItems: [], addStockItem: vi.fn(), updateStockItem: vi.fn(),
  approvedStockItems: [], pendingStockItems: [], heldOrders: [], addHeldOrder: vi.fn(), removeHeldOrder: vi.fn(),
  suggestiveSalesItems: [], addSuggestiveSaleItem: vi.fn(), removeSuggestiveSaleItem: vi.fn(),
  draftCart: { cart: [], selectedCustomer: null, payments: [], discounts: [] }, setDraftCart: vi.fn(), clearDraftCart: vi.fn(),
  completedOrders: [order], addCompletedOrder: vi.fn(), updateCompletedOrder: vi.fn(), refundRecords: [], addRefundRecord,
  warrantyClaims: [], addWarrantyClaim: vi.fn(), updateWarrantyClaim: vi.fn(), posOperator: null, setPosOperator: vi.fn(),
  pendingReplacements: [], removePendingReplacement: vi.fn(), updateInvoice: vi.fn(), addStockMovement: vi.fn(),
};
vi.mock('../context/StoreLocalState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/StoreLocalState')>()),
  useStoreLocalState: () => storeValue,
}));
let refundAllowed = true;
const canExecutePosRefund = vi.fn((_request: { operatorKey: string | null; requestId: string | null }) => refundAllowed);
const clearSupervisorRefundAuth = vi.fn();
const accessValue = {
  canAccess: () => true,
  session: { user: { id: 'u-pos', name: 'Till User', email: 'till@synthetic.test' }, userType: 'tenant', role: 'manager', status: 'active' },
  setPosOperatorRole: vi.fn(), effectiveRole: 'manager',
  checkPermission: () => true, checkSubPermission: () => true, getPermissionLevel: () => 'full',
  supervisorRefundAuth: null, requestSupervisorRefundAuth: vi.fn(() => false), canExecutePosRefund, clearSupervisorRefundAuth,
};
vi.mock('../context/AccessContext', () => ({ useAccess: () => accessValue }));

/** Open the refund flow and reach the confirmation step with one item selected. */
function reachConfirmation() {
  render(<MemoryRouter><POS /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /keyboard_return\s*Refund/ }));
  fireEvent.click(screen.getByText('INV-R1-0001'));
  fireEvent.click(screen.getByRole('button', { name: 'add' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Refund' }));
  expect(screen.getByRole('button', { name: 'Process Refund' })).toBeInTheDocument(); // control: the confirmation step
}

describe('POS refund is decided again when it executes (M5-GAP11-P5-R1)', () => {
  beforeEach(() => {
    refundAllowed = true;
    addRefundRecord.mockClear();
    canExecutePosRefund.mockClear();
    clearSupervisorRefundAuth.mockClear();
  });

  it('records the refund while it is authorized, deciding on the open refund request (control)', () => {
    reachConfirmation();
    fireEvent.change(screen.getByDisplayValue('Select reason...'), { target: { value: 'Defective product' } });
    fireEvent.click(screen.getByRole('button', { name: 'Process Refund' }));
    expect(addRefundRecord).toHaveBeenCalledTimes(1);
    // The decision taken immediately before the refund was recorded carries the open refund request.
    const recordedAt = addRefundRecord.mock.invocationCallOrder[0];
    const decidedAt = canExecutePosRefund.mock.invocationCallOrder.filter((n) => n < recordedAt).length - 1;
    const request = canExecutePosRefund.mock.calls[decidedAt][0];
    expect(request.requestId).toMatch(/^refund-\d+-\d+$/);
    expect(request.operatorKey).toBe('u-pos');
  });

  it('records nothing when the authorization is gone at execution, and ends the approval', () => {
    reachConfirmation();
    fireEvent.change(screen.getByDisplayValue('Select reason...'), { target: { value: 'Defective product' } });
    refundAllowed = false; // revoked after the screen last rendered
    clearSupervisorRefundAuth.mockClear(); // the mount effect already cleared once; count only the click
    fireEvent.click(screen.getByRole('button', { name: 'Process Refund' }));
    expect(addRefundRecord).not.toHaveBeenCalled();
    expect(clearSupervisorRefundAuth).toHaveBeenCalledTimes(1);
  });

  it('withholds Process Refund and says why once the refund is no longer authorized', () => {
    reachConfirmation();
    refundAllowed = false;
    fireEvent.change(screen.getByDisplayValue('Select reason...'), { target: { value: 'Defective product' } }); // re-renders
    expect(screen.getByRole('button', { name: 'Process Refund' })).toBeDisabled();
    expect(screen.getByText(/Refund authorization is no longer valid/)).toBeInTheDocument();
  });
});
