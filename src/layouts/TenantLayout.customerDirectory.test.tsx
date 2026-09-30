// M7A-CUSTOMERS-P5 — the shop sidebar's "Customer Directory" entry: gated by the SAME access feature as the local
// Customers screen (its own id is only a React key). The highlight is an exact match for every item, as at entry; only
// the Customer Directory entry is also active on its sub-paths.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({
  allowed: new Set<string>(),
  asked: [] as string[],
  activated: true,
  plan: 'growth',
}));
vi.mock('../firebase', () => ({ auth: {}, db: {} }));
vi.mock('../context/AccessContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/AccessContext')>()),
  useAccess: () => ({
    loading: false,
    canAccess: (feature: string) => { h.asked.push(feature); return h.allowed.has(feature); },
    isStoreActivated: () => h.activated,
    session: { userType: 'tenant' },
    tenant: { plan: h.plan },
  }),
}));
vi.mock('../components/TenantHeader', () => ({ default: () => null }));
vi.mock('../components/AccountStatusBanner', () => ({ default: () => null }));
vi.mock('../components/DevSessionSwitcher', () => ({ default: () => null }));
vi.mock('../context/StoreLocalState', () => ({ StoreLocalStateProvider: ({ children }: { children: unknown }) => children }));

import TenantLayout from './TenantLayout';

const ID = '0a000001-0000-4000-8000-00000a000001';
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<TenantLayout />}>
          <Route path="*" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}
const current = (): string[] => screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent ?? '');
const lit = (): string[] => screen.getAllByRole('link').filter((a) => a.className.includes('text-lime-400')).map((a) => a.textContent ?? '');
const ALL = ['dashboard', 'sales', 'customers', 'settings', 'support'];

afterEach(() => {
  h.allowed = new Set();
  h.asked = [];
  h.activated = true;
  h.plan = 'growth';
});

describe('TenantLayout — the Customer Directory entry (M7A-CUSTOMERS-P5)', () => {
  it('NAV-01. "Customer Directory" links to /customers/directory and is offered exactly when the customers feature is', () => {
    h.allowed = new Set(ALL);
    const view = at('/');
    const entry = screen.getByRole('link', { name: /Customer Directory/ });
    expect(entry).toHaveAttribute('href', '/customers/directory');
    expect(screen.getByRole('link', { name: /Customers$/ })).toHaveAttribute('href', '/customers'); // the local screen keeps its entry
    // The entry's own id is never asked about: it is not an access feature.
    expect(h.asked).toContain('customers');
    expect(h.asked).not.toContain('customer-directory');
    view.unmount();
    h.allowed = new Set(['dashboard', 'sales', 'settings', 'support']);
    at('/');
    expect(screen.queryByRole('link', { name: /Customer Directory/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Customers$/ })).toBeNull();
    expect(h.asked).not.toContain('customer-directory');
  });

  it('NAV-02. the highlight is an exact match as at entry; only the Customer Directory entry is also active below its path', () => {
    h.allowed = new Set(ALL);
    const cases: Array<[string, string[]]> = [
      ['/', ['Dashboard']],
      ['/customers', ['Customers']],
      ['/customers/directory', ['Customer Directory']],
      [`/customers/directory/${ID}`, ['Customer Directory']],
      ['/customers/new', []], // as at entry: no item is exact here
      ['/sales/new', []], // as at entry: Sales is not lit below /sales
      ['/salesforce', []], // not a whole-segment prefix of /sales
      ['/customers-archive', []],
      ['/reports', []], // not accessible here, and "/" does not stand in for it
    ];
    for (const [path, expected] of cases) {
      const view = at(path);
      expect(current().map((t) => t.replace(/^[a-z_0-9]+/, '')), path).toEqual(expected);
      expect(lit().map((t) => t.replace(/^[a-z_0-9]+/, '')), path).toEqual(expected); // the visible highlight follows the same rule
      view.unmount();
    }
  });

  it('NAV-03. before activation the entry is locked with its feature\'s plan, never its own id', () => {
    h.activated = false;
    h.allowed = new Set(['dashboard', 'settings', 'support']);
    const view = at('/');
    expect(screen.queryByRole('link', { name: /Customer Directory/ })).toBeNull();
    // Locked items are listed by FEATURE: the plan holds `customers`, never the entry's own id.
    const locked = [...document.querySelectorAll('[title="Complete activation to unlock"]')].map((el) => el.textContent ?? '');
    expect(locked.some((t) => t.includes('Customer Directory'))).toBe(true);
    expect(locked.some((t) => /Customers/.test(t) && !t.includes('Directory'))).toBe(true);
    expect(h.asked).not.toContain('customer-directory');
  });

  it('NAV-04. a plan without the customers feature locks neither entry', () => {
    h.activated = false;
    h.plan = 'no-such-plan';
    h.allowed = new Set(['dashboard', 'settings', 'support']);
    at('/');
    expect(document.querySelectorAll('[title="Complete activation to unlock"]')).toHaveLength(0);
    expect(screen.queryByText('Customer Directory')).toBeNull();
  });
});
