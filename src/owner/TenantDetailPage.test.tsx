import { describe, it, expect } from 'vitest';
import { getTenantCreditEligibleInvoices } from './TenantDetailPage';

// Behaviour-touching fix (TS2367 dead comparison): the invoice status domain is
// 'void' | 'paid' | 'overdue'. The former filter also tested `status === 'pending'`,
// which is not a member of that domain, so the branch was unreachable. A credit note
// can only be applied to an invoice with an outstanding balance — an overdue invoice.
// This mirrors getCreditEligibleInvoices in BillingPage, which already fixed the same
// dead comparison.
describe('getTenantCreditEligibleInvoices', () => {
  const inv = (status: string, id: string) => ({ status, id });

  it('returns only overdue invoices across every valid status, preserving order', () => {
    const invoices = [
      inv('overdue', 'INV-1'),
      inv('paid', 'INV-2'),
      inv('void', 'INV-3'),
      inv('overdue', 'INV-4'),
    ];
    expect(getTenantCreditEligibleInvoices(invoices).map((i) => i.id)).toEqual(['INV-1', 'INV-4']);
  });

  it('returns empty when there are no invoices', () => {
    expect(getTenantCreditEligibleInvoices([])).toEqual([]);
  });

  it('does not treat the removed pending branch as eligible', () => {
    // 'pending' is not part of the invoice status domain; if such a value ever reached
    // this filter it must not silently become credit-eligible.
    expect(getTenantCreditEligibleInvoices([inv('pending', 'INV-1')])).toEqual([]);
  });
});
