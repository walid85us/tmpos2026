import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TenantDetailPage, { getTenantCreditEligibleInvoices } from './TenantDetailPage';
import { PLATFORM_PERMISSIONS_STORAGE_KEY } from './platformPermissionsConfig';

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

// M5-GAP11-P5-R1 — "Revoke + Refund" is a billing refund: revoke_addon_override for the revoke and the
// approve_billing_actions money capability for the refund. The page offers the refund only when the
// grant is held, and the handler decides both again before acting. Client-side only.
let mockSession: { role: string; userType: 'platform' | 'tenant' } | null = null;
vi.mock('../context/AccessContext', () => ({ useAccess: () => ({ session: mockSession }) }));

describe('TenantDetailPage Revoke + Refund (M5-GAP11-P5-R1)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    window.sessionStorage.clear();
    // A paid override charged two days before the page's pinned date: inside the 7-day refund window.
    window.sessionStorage.setItem('tenant_overrides_data', JSON.stringify([
      { tenantId: 't1', featureId: 'domains', type: 'paid_override', addedDate: '2026-03-24', addedBy: 'System Owner', price: 25, pricingModel: 'monthly', addOnId: null },
    ]));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    window.sessionStorage.clear();
    mockSession = null;
  });

  const openRevokeModal = (role: string) => {
    mockSession = { role, userType: 'platform' };
    render(
      <MemoryRouter initialEntries={['/owner/tenants/t1']}>
        <Routes><Route path="/owner/tenants/:id" element={<TenantDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Features' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('button', { name: 'Revoke Only' })).toBeInTheDocument(); // control: the refund window is open
  };
  const revokeBillingGrant = (role: string) =>
    window.sessionStorage.setItem(PLATFORM_PERMISSIONS_STORAGE_KEY, JSON.stringify({ [role]: { grants: { approve_billing_actions: false } } }));

  it('is offered with the explicit grant and issues the refund (control)', () => {
    openRevokeModal('billing_admin');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke + Refund' }));
    expect(screen.getByText('Custom Domains revoked — refund issued')).toBeInTheDocument();
  });

  it('is not offered when the owner has revoked the grant; the revoke alone still is', () => {
    revokeBillingGrant('billing_admin');
    openRevokeModal('billing_admin');
    expect(screen.queryByRole('button', { name: 'Revoke + Refund' })).toBeNull();
  });

  it('the handler decides again: a grant revoked after the modal opened denies the refund', () => {
    openRevokeModal('billing_admin');
    revokeBillingGrant('billing_admin');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke + Refund' }));
    expect(warn).toHaveBeenCalledWith('[tenant-detail] permission denied: approve_billing_actions');
    expect(screen.queryByText('Custom Domains revoked — refund issued')).toBeNull();
  });
});

// Applying and voiding a tenant credit are billing credit actions (approve_billing_actions), from the
// credits list row and from the credit detail: offered only with the grant, and decided again on click.
// Tenant t1 carries one issued credit, CR-2026-0005.
describe('TenantDetailPage credit apply and void (M5-GAP11-P5-R1)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    window.sessionStorage.clear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    window.sessionStorage.clear();
    mockSession = null;
  });

  const openBilling = (role: string) => {
    mockSession = { role, userType: 'platform' };
    render(
      <MemoryRouter initialEntries={['/owner/tenants/t1']}>
        <Routes><Route path="/owner/tenants/:id" element={<TenantDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(screen.getByText('CR-2026-0005')).toBeInTheDocument(); // control: the issued credit is listed
  };
  const revokeBillingGrant = () =>
    window.sessionStorage.setItem(PLATFORM_PERMISSIONS_STORAGE_KEY, JSON.stringify({ billing_admin: { grants: { approve_billing_actions: false } } }));
  // The apply toast (t1 has no overdue invoice, so the handler reports that) — not the detail's static hint.
  const applied = () => screen.queryByText(/^(Credit CR-2026-0005 applied to .+|No invoices with overdue or pending status to apply this credit to)$/);
  const openDetail = () => {
    fireEvent.click(screen.getByText('CR-2026-0005'));
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeInTheDocument(); // control: the detail is open
  };

  it('offers apply and void, in the list row and the detail, only with the grant', () => {
    openBilling('billing_admin');
    expect(screen.getAllByRole('button', { name: /^Apply$/ })).toHaveLength(1); // control
    expect(screen.getAllByRole('button', { name: /^Void$/ })).toHaveLength(1); // control
    cleanup();
    revokeBillingGrant();
    openBilling('billing_admin');
    expect(screen.queryAllByRole('button', { name: /^Apply$/ })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /^Void$/ })).toEqual([]);
    openDetail();
    expect(screen.queryByRole('button', { name: /Apply Credit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Void/ })).toBeNull();
  });

  it('the list-row Apply decides again: a grant revoked after the page rendered applies nothing', () => {
    openBilling('billing_admin');
    revokeBillingGrant();
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
    expect(warn).toHaveBeenCalledWith('[tenant-detail] permission denied: approve_billing_actions');
    expect(applied()).toBeNull();
  });

  it('the list-row Apply applies with the grant (control)', () => {
    openBilling('billing_admin');
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
    expect(applied()).toBeInTheDocument();
  });

  it('the detail Apply Credit decides again: a grant revoked after the detail opened applies nothing', () => {
    openBilling('billing_admin');
    openDetail();
    revokeBillingGrant();
    fireEvent.click(screen.getByRole('button', { name: /Apply Credit/ }));
    expect(warn).toHaveBeenCalledWith('[tenant-detail] permission denied: approve_billing_actions');
    expect(applied()).toBeNull();
  });

  it('Void Credit decides again at confirmation: a grant revoked after the dialog opened voids nothing', () => {
    openBilling('billing_admin');
    fireEvent.click(screen.getByRole('button', { name: /^Void$/ }));
    revokeBillingGrant();
    fireEvent.click(screen.getByRole('button', { name: 'Void Credit' }));
    expect(warn).toHaveBeenCalledWith('[tenant-detail] permission denied: approve_billing_actions');
    expect(screen.queryByText('CR-2026-0005 has been voided')).toBeNull();
  });

  it('Void Credit voids with the grant (control)', () => {
    openBilling('billing_admin');
    fireEvent.click(screen.getByRole('button', { name: /^Void$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Void Credit' }));
    expect(screen.getByText('CR-2026-0005 has been voided')).toBeInTheDocument();
  });
});
