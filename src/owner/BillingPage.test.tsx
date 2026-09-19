import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BillingPage, { getCreditEligibleInvoices } from './BillingPage';
import { PLATFORM_PERMISSIONS_STORAGE_KEY } from './platformPermissionsConfig';

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

// M5-GAP11-P5-R1 — the billing page's refunds and credits are the approve_billing_actions money
// capability: a platform role, Billing at View or above and the explicit grant (the owner's stored edit,
// else the built-in default; System Owner locked to its grant). The page offers them only when it is
// held, and each handler decides again before acting. Client-side only: no server billing route exists.
let mockSession: { role: string; userType: 'platform' | 'tenant' } | null = null;
vi.mock('../context/AccessContext', () => ({ useAccess: () => ({ session: mockSession }) }));

const STORE = PLATFORM_PERMISSIONS_STORAGE_KEY;
const setOverrides = (value: unknown) => {
  window.sessionStorage.setItem(STORE, typeof value === 'string' ? value : JSON.stringify(value));
};
// Every opener the default view renders: header Issue/Apply Credit, transaction Refund, the tenant
// actions' Credit and the unapplied credits' Apply.
const OPENERS = [/Issue Credit/, /Apply Credit/, /^Refund$/, /^Credit$/, /^Apply$/];
const moneyButtons = () => OPENERS.flatMap((name) => screen.queryAllByRole('button', { name }));
const openerKinds = () => OPENERS.filter((name) => screen.queryAllByRole('button', { name }).length > 0).length;

describe('BillingPage money actions (M5-GAP11-P5-R1)', () => {
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

  const platform = (role: string) => ({ role, userType: 'platform' as const });
  it.each([
    ['billing_admin, built-in grant', platform('billing_admin'), undefined, true],
    ['system_owner, its locked explicit grant', platform('system_owner'), undefined, true],
    ['system_owner, a stored revoke is ignored (locked)', platform('system_owner'), { system_owner: { grants: { approve_billing_actions: false } } }, true],
    ['operations_admin, default deny', platform('operations_admin'), undefined, false],
    ['security_admin, default deny', platform('security_admin'), undefined, false],
    ['support_admin, default deny', platform('support_admin'), undefined, false],
    ['operations_admin, owner grant', platform('operations_admin'), { operations_admin: { grants: { approve_billing_actions: true } } }, true],
    ['billing_admin, owner revoke', platform('billing_admin'), { billing_admin: { grants: { approve_billing_actions: false } } }, false],
    ['billing_admin, malformed grant value', platform('billing_admin'), { billing_admin: { grants: { approve_billing_actions: 'true' } } }, false],
    ['billing_admin, malformed grants container', platform('billing_admin'), { billing_admin: { grants: 'yes' } }, false],
    ['billing_admin, corrupt stored overrides', platform('billing_admin'), '{not json', false],
    ['billing_admin, Billing below View', platform('billing_admin'), { billing_admin: { features: { billing_subscriptions: 'none' } } }, false],
    ['a store manager holding store money grants', { role: 'manager', userType: 'tenant' as const }, undefined, false],
    ['no session', null, undefined, false],
  ])('%s', (_label, session, overrides, offered) => {
    mockSession = session;
    if (overrides !== undefined) setOverrides(overrides);
    render(<BillingPage />);
    expect(screen.getByRole('button', { name: /Issue Invoice/ })).toBeInTheDocument(); // control: the page rendered
    if (offered) expect(openerKinds()).toBe(OPENERS.length); // every opener kind is offered
    else expect(moneyButtons()).toEqual([]);
  });

  it('the transaction refund handler decides again: a grant revoked after the dialog opened denies the refund', () => {
    mockSession = platform('billing_admin');
    render(<BillingPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Refund$/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Refund' }));
    expect(screen.getByText(/Refund of \$\d+ initiated/)).toBeInTheDocument(); // control
    fireEvent.click(screen.getAllByRole('button', { name: /^Refund$/ })[0]);
    setOverrides({ billing_admin: { grants: { approve_billing_actions: false } } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Refund' }));
    expect(warn).toHaveBeenCalledWith('[billing] permission denied: approve_billing_actions');
    expect(screen.getAllByText(/Refund of \$\d+ initiated/)).toHaveLength(1); // only the control refund
  });

  it('the credit handler decides again: a grant revoked before confirmation denies the credit note', () => {
    mockSession = platform('billing_admin');
    render(<BillingPage />);
    const issueCredit = (amount: string) => {
      fireEvent.click(screen.getByRole('button', { name: /Issue Credit/ }));
      fireEvent.change(screen.getByDisplayValue('Select tenant...'), { target: { value: 'Tech Repair Pro' } });
      fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: amount } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Credit' }));
    };
    issueCredit('11');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Credit' }));
    expect(screen.getByText('Credit note of $11 created for Tech Repair Pro')).toBeInTheDocument(); // control
    issueCredit('22');
    setOverrides({ billing_admin: { grants: { approve_billing_actions: false } } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Credit' }));
    expect(warn).toHaveBeenCalledWith('[billing] permission denied: approve_billing_actions');
    expect(screen.queryByText('Credit note of $22 created for Tech Repair Pro')).toBeNull();
  });
});
