import { describe, it, expect } from 'vitest';
import { getCreditEligibleInvoices } from './BillingPage';

// Behavior-touching fix (TS2367 dead comparison): invoice status domain is
// 'void' | 'paid' | 'overdue'. The old filter also tested `status === 'pending'`,
// an impossible value (dead branch). A credit note can only be applied to an
// invoice with an outstanding balance, i.e. an OVERDUE invoice for that tenant.
describe('getCreditEligibleInvoices', () => {
  const inv = (tenant: string, status: string, invoiceNo: string) => ({ tenant, status, invoiceNo });

  it('returns only overdue invoices for the tenant (paid and void excluded)', () => {
    const invoices = [
      inv('Acme', 'overdue', 'INV-1'),
      inv('Acme', 'paid', 'INV-2'),
      inv('Acme', 'void', 'INV-3'),
      inv('Other', 'overdue', 'INV-4'),
    ];
    const eligible = getCreditEligibleInvoices(invoices, 'Acme');
    expect(eligible.map((i) => i.invoiceNo)).toEqual(['INV-1']);
  });

  it('returns empty when the tenant has no overdue invoices', () => {
    const invoices = [inv('Acme', 'paid', 'INV-1'), inv('Acme', 'void', 'INV-2')];
    expect(getCreditEligibleInvoices(invoices, 'Acme')).toEqual([]);
  });
});
