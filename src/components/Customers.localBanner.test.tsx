// M7A-CUSTOMERS-P5 — the local Customers screen says where its records live: in this browser only, not on the server,
// with a link to the server-backed Customer directory. Its own create stays local: it writes the local customer state
// under a local id and sends no request at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const addCustomer = vi.fn();
const storeValue = {
  customers: [{
    id: 'c1', name: 'Local Person', email: 'local@synthetic.test', phone: '5550100', totalSpent: 0, lastVisit: '2026-01-01',
    loyaltyPoints: 0, tier: 'Bronze', group: 'Retail', tags: [], notes: [], assets: [], customFields: [],
  }],
  addCustomer, updateCustomer: vi.fn(), completedOrders: [], invoices: [], repairTickets: [], warrantyRepairTickets: [],
  findDuplicateCustomers: () => [], loyaltyConfig: { enabled: false, pointsPerDollar: 1, tiers: [] }, updateLoyaltyConfig: vi.fn(),
  loyaltyAdjustments: [], addLoyaltyAdjustment: vi.fn(),
};
vi.mock('../context/StoreLocalState', () => ({ useStoreLocalState: () => storeValue }));
vi.mock('../context/AccessContext', () => ({ useAccess: () => ({ canAccess: () => false, checkSubPermission: () => false }) }));

import Customers from './Customers';

const mount = () => render(<MemoryRouter initialEntries={['/customers']}><Customers /></MemoryRouter>);

afterEach(() => {
  vi.restoreAllMocks();
  addCustomer.mockClear();
});

describe('Customers — the local-only banner (M7A-CUSTOMERS-P5)', () => {
  it('LCB-01. the banner says the records are held in this browser\'s memory only, lost on reload, and links to the Customer directory', () => {
    mount();
    const banner = screen.getByTestId('customers-local-only-banner');
    expect(banner).toHaveAttribute('role', 'note');
    expect(banner).toHaveTextContent("held in this browser's memory only");
    expect(banner).toHaveTextContent('They are lost when the page is reloaded and are not saved to the server.');
    const link = screen.getByTestId('customers-directory-link');
    expect(banner).toContainElement(link);
    expect(link).toHaveAttribute('href', '/customers/directory');
    expect(link).toHaveTextContent('Customer directory');
    // It stays while a local customer's profile is open: the profile is local too.
    fireEvent.click(screen.getByText('Local Person'));
    expect(screen.getByTestId('customers-local-only-banner')).toBeInTheDocument();
  });

  it('LCB-02. "+ New Customer" still creates a LOCAL record — a local id, the local state — and sends no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('the local screen must not reach the network'); });
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
    mount();
    fireEvent.click(screen.getByRole('button', { name: '+ New Customer' }));
    const field = (label: string): HTMLInputElement => screen.getByText(label).parentElement!.querySelector('input')!;
    fireEvent.change(field('First Name *'), { target: { value: 'Ada' } });
    fireEvent.change(field('Last Name *'), { target: { value: 'Lovelace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Customer' }));
    expect(addCustomer).toHaveBeenCalledTimes(1);
    const created = addCustomer.mock.calls[0][0] as { id: string; name: string };
    expect(created.name).toBe('Ada Lovelace');
    expect(created.id).toMatch(/^c\d+$/); // a local id: never a server customer id
    expect(created.id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(fetchSpy).not.toHaveBeenCalled(); // no /api/ request, nor any other
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('customers-local-only-banner')).toBeInTheDocument();
  });
});
