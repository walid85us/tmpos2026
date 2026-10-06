// M7A-CUSTOMERS-P9 — the invoice create draft with a customer saved on the server, in jsdom: the REAL Invoices page over a
// plain local store (seed customers c1/c2, spied addInvoice/updateInvoice — nothing persisted), a switchable access
// context, and the shop's tenant session and customers singletons replaced by the REAL clients over one reduced fake
// tenant server at the network boundary (a reduced copy of ServerCustomerPicker.test.tsx's; synthetic tenants, users and
// names only), and the real server-customer field behind a pass-through that records what each render hands it. Ordering
// is controlled with the fake's hold/release (no sleeps). Every assertion about a request is made on what the fake
// recorded — the wire — and every assertion about an invoice on what the page handed the local store.
// M7B-INVOICES-P1: the page's "Server drafts" section (ServerInvoiceDrafts.tsx) rides along with the REAL invoice drafts
// client over the same fake (stores, a store's drafts, one create): a server customer is no longer a dead end — "Save as
// server draft" hands its id and name (only) to that section — and a server draft never reaches the local invoices.
// M7B-INVOICES-P1-R2 (DA-202): a sign-out with the picker closed clears the draft's server customer at once, a local one
// untouched (INV-18); "Save as server draft" never hands on a customer whose session is over and says so (INV-19); a
// later session's context drops a closed field's customer (INV-20); the alert never takes focus moved elsewhere (INV-21).
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { CustomersClient } from '../tenant/customersClient';
import type { TenantSessionClient } from '../tenant/tenantSessionClient';

// `customersFeature`: the plan's customers feature (canAccess('customers'), the directory route's AccessGuard).
interface Access { uid: string | null; invoicesCreate: boolean; invoicesEdit: boolean; customersView: boolean; customersFeature: boolean }
const DEFAULT_ACCESS: Access = { uid: 'uid-a', invoicesCreate: true, invoicesEdit: true, customersView: true, customersFeature: true };
const access = vi.hoisted(() => {
  let value: Access = { uid: 'uid-a', invoicesCreate: true, invoicesEdit: true, customersView: true, customersFeature: true };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Partial<Access>) { value = { ...value, ...next }; for (const l of [...listeners]) l(); },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
});
// The signed-in Firebase user is the access context's: uid-a holds ID token tok-a, uid-b tok-b.
vi.mock('../firebase', () => ({
  auth: {
    get currentUser() {
      const uid = access.get().uid;
      return uid === null ? null : { uid, getIdToken: async () => `tok-${uid.slice(-1)}` };
    },
  },
}));
// The page reads the signed-in user and the local role state's hints: a switchable stand-in.
vi.mock('../context/AccessContext', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAccess: () => {
      const v = useSyncExternalStore(access.subscribe, access.get);
      return {
        session: v.uid === null ? null : { user: { id: v.uid } },
        checkPermission: (domain: string, level: string) =>
          domain === 'invoices' ? (level === 'create' ? v.invoicesCreate : level === 'edit' && v.invoicesEdit) : domain === 'customers' && level === 'view' && v.customersView,
        checkSubPermission: () => false,
        canAccess: (feature: string) => feature === 'customers' && v.customersFeature,
      };
    },
  };
});
// The shop's singletons, as the page uses them by default: each delegates to this test's real client over its fake server.
const net = vi.hoisted(() => {
  const current = { session: null as unknown, customers: null as unknown, drafts: null as unknown };
  const delegate = (key: keyof typeof current) =>
    new Proxy({}, { get: (_, method) => (...args: unknown[]) => (current[key] as Record<PropertyKey, (...a: unknown[]) => unknown>)[method](...args) });
  return { current, session: delegate('session'), customers: delegate('customers'), drafts: delegate('drafts') };
});
vi.mock('../tenant/tenantSessionClient', async (original) => ({
  ...(await original<typeof import('../tenant/tenantSessionClient')>()),
  tenantSession: net.session,
}));
vi.mock('../tenant/customersClient', async (original) => ({
  ...(await original<typeof import('../tenant/customersClient')>()),
  customers: net.customers,
}));
vi.mock('../tenant/invoiceDraftsClient', async (original) => ({
  ...(await original<typeof import('../tenant/invoiceDraftsClient')>()),
  invoiceDrafts: net.drafts,
}));
// The draft's server-customer field, passed through unchanged, recording what each render hands it: no render may hand it
// another user's customer, or any customer once view access is gone (the page treats such a reference as none at once).
const fieldRenders = vi.hoisted(() => [] as Array<{ uid: string | null; canView: boolean; valueUid: string | null }>);
vi.mock('../tenant/ServerCustomerPicker', async (original) => {
  const real = await original<typeof import('../tenant/ServerCustomerPicker')>();
  const { createElement } = await import('react');
  return {
    ...real,
    ServerCustomerField: (props: Parameters<typeof real.ServerCustomerField>[0]) => {
      fieldRenders.push({ uid: props.uid, canView: props.canView, valueUid: props.value?.uid ?? null });
      return createElement(real.ServerCustomerField, props);
    },
  };
});
// The local store: two seed customers, one open invoice, one stock item; nothing persisted, every write spied.
const addInvoice = vi.fn();
const updateInvoice = vi.fn();
const LOCAL = [
  { id: 'c1', name: 'Local Person', email: 'local@synthetic.test', phone: '5550100', totalSpent: 0, lastVisit: '2026-01-01', loyaltyPoints: 0, tier: 'Bronze', group: 'Retail', tags: [], notes: [], assets: [], customFields: [] },
  { id: 'c2', name: 'Other Local', email: 'other@synthetic.test', phone: '5550111', totalSpent: 0, lastVisit: '2026-01-01', loyaltyPoints: 0, tier: 'Bronze', group: 'Retail', tags: [], notes: [], assets: [], customFields: [] },
];
const OPEN_INVOICE = {
  id: 'inv-001', invoiceNumber: 'INV-2026-001', customerId: 'c1', customerName: 'Local Person', customerEmail: 'local@synthetic.test', customerPhone: '5550100',
  items: [{ id: 'ii-1', name: 'Screen repair', quantity: 1, price: 50, type: 'repair' }], subtotal: 50, discount: 0, tax: 4, total: 54, amountPaid: 0,
  balance: 54, status: 'Unpaid', createdAt: '2026-09-01', dueDate: '2026-09-08', paymentHistory: [], remindersSent: 0,
};
const find = vi.fn(function (this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown) { return Array.prototype.find.call(this, predicate); });
const storeValue = {
  invoices: [OPEN_INVOICE], addInvoice, updateInvoice, customers: Object.assign([...LOCAL], { find }), services: [], serviceCategories: [],
  approvedStockItems: [{ id: 'p1', name: 'Screen Protector', sku: 'SKU-1', qty: 5, price: 10 }], storeBranding: { logoUrl: '' }, documentTemplates: [], shipments: [],
};
vi.mock('../context/StoreLocalState', () => ({ useStoreLocalState: () => storeValue, SEED_POS_OPERATORS: [] }));

import Invoices from './Invoices';
import { NOT_AVAILABLE_TEXT, PICK_ENDED_TEXT, SERVER_DRAFT_LIMIT_TEXT, sessionContextOf } from '../tenant/ServerCustomerPicker';
import { CUSTOMERS_PATH, createCustomersClient, type CustomerEntry } from '../tenant/customersClient';
import { createTenantSessionClient, sessionEndsSoFar, TENANT_SESSION_PATHS } from '../tenant/tenantSessionClient';
import { STORES_PATH, createInvoiceDraftsClient, draftPathOf, draftsPathOf, type InvoiceDraftsClient } from '../tenant/invoiceDraftsClient';
import { DRAFTS_TEXT, NOT_SENT_TEXT } from '../tenant/ServerInvoiceDrafts';
import { encodeCustomerCursor, encodeCustomerSearchCursor, parseCustomerDirectoryQuery } from '../../server/runtime/customerDirectory';
import { sessionSubjectOf } from '../../server/runtime/sessions';

const activeBody = (uid: string, csrfToken: string) =>
  ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const STORE = uuid(0x51);

interface Sent { readonly method: string; readonly url: string; readonly headers: Headers }
interface User { uid: string; tenant: string; view: boolean }

/**
 * One fake tenant server, reduced to the session, the customer list read and — M7B-INVOICES-P1 — uid-a's one store with
 * its drafts (list, one create that stores what it was sent, the read-back). `cookie` is the session the browser presents.
 */
function fakeServer() {
  const users: Record<string, User> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, view: true },
    'tok-b': { uid: 'uid-b', tenant: TENANT_B, view: true },
  };
  const sessions = new Map<string, { user: User; csrf: string }>();
  const rows: Record<string, CustomerEntry[]> = { [TENANT_A]: [], [TENANT_B]: [] };
  let sessionCount = 0;
  let idCount = 0xa00;
  const drafts: Array<{ id: string; customerId: string; body: { lines: Array<{ description: string; quantity: number; unitPriceCents: number }> } }> = [];
  const reply = (status: number, body?: unknown, extra: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? extra : { 'content-type': 'application/json; charset=utf-8', ...extra } });
  const refuse = (status: number): Response => reply(status, { error: `e${status}`, requestId: 'req-synthetic' });
  const byteOrder = (x: CustomerEntry, y: CustomerEntry): number =>
    Buffer.compare(Buffer.from(x.name, 'utf8'), Buffer.from(y.name, 'utf8')) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

  const server = {
    sent: [] as Sent[],
    bodies: [] as string[], // what each draft POST sent, as the exact string
    drafts,
    users,
    cookie: null as string | null,
    hold: { reads: 0 }, // list answers to hold: computed on arrival, released by the test (or replaced by a late one)
    held: [] as Array<{ url: string; release: (late?: Response) => void }>,
    seed(tenant: string, names: readonly string[]): CustomerEntry[] {
      const made = names.map((name) => ({ id: uuid(++idCount), name }));
      rows[tenant].push(...made);
      return made;
    },
    /** Every session expires (or is revoked) on the server. */
    expire(): void { sessions.clear(); },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      server.sent.push({ method, url, headers });
      if (url === TENANT_SESSION_PATHS.login && method === 'POST') {
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403);
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return refuse(401);
        sessionCount += 1;
        server.cookie = `session-${sessionCount}`;
        sessions.set(server.cookie, { user, csrf: `${'s'.repeat(40)}${String(sessionCount).padStart(3, '0')}` });
        return reply(200, activeBody(user.uid, sessions.get(server.cookie)!.csrf));
      }
      const session = server.cookie === null ? undefined : sessions.get(server.cookie);
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') return session === undefined ? refuse(401) : reply(200, activeBody(session.user.uid, session.csrf));
      if (method === 'GET' && url.split('?')[0] === CUSTOMERS_PATH) {
        const decide = (): Response => { // decided on arrival, as the server does
          if (session === undefined) return refuse(401);
          if (headers.get('x-tmpos-session-csrf') !== session.csrf || !session.user.view) return refuse(403);
          const query = parseCustomerDirectoryQuery(url); // the server's own: q, cursor kinds, bounds
          if (query === null) return refuse(400);
          const all = [...rows[session.user.tenant]].sort(byteOrder);
          const { search } = query;
          const matching = search === null ? all : all.filter((r) => r.name.toUpperCase().includes(search.toUpperCase()));
          const anchor = query.after === null ? null : matching.find((r) => r.id === query.after);
          if (anchor === undefined) return refuse(400);
          const rest = anchor === null ? matching : matching.filter((r) => byteOrder(r, anchor) > 0);
          const slice = rest.slice(0, 50);
          const last = slice[slice.length - 1];
          const next = rest.length <= 50 ? null : search === null ? encodeCustomerCursor(last.id) : encodeCustomerSearchCursor(last.id, search);
          return reply(200, { customers: slice, nextCursor: next });
        };
        const answer = decide();
        if (server.hold.reads > 0) {
          server.hold.reads -= 1;
          const late = await new Promise<Response | undefined>((release) => { server.held.push({ url, release }); });
          if (late !== undefined) return late;
        }
        return answer;
      }
      if (method === 'GET' && url === STORES_PATH) {
        if (session === undefined) return refuse(401);
        return reply(200, { stores: session.user.uid === 'uid-a' ? [{ id: STORE, tenantId: TENANT_A, name: 'Main Street', readOnly: false }] : [] });
      }
      if (session !== undefined && url.startsWith(draftsPathOf(STORE))) {
        const subtotal = (d: (typeof drafts)[number]) => d.body.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
        if (method === 'POST') {
          const body = String(init.body);
          server.bodies.push(body);
          const draft = { id: uuid(++idCount), customerId: (JSON.parse(body) as { customerId: string }).customerId, body: JSON.parse(body) as (typeof drafts)[number]['body'] };
          drafts.push(draft);
          return reply(201, { draft: { id: draft.id, status: 'draft', currency: 'USD', lineCount: draft.body.lines.length, subtotalCents: subtotal(draft) } }, { location: draftPathOf(STORE, draft.id) });
        }
        const one = drafts.find((d) => url === draftPathOf(STORE, d.id));
        if (one !== undefined) {
          const lines = one.body.lines.map((l, i) => ({ position: i + 1, ...l, lineTotalCents: l.quantity * l.unitPriceCents }));
          return reply(200, { draft: { id: one.id, storeId: STORE, customerId: one.customerId, status: 'draft', currency: 'USD', version: 1, createdAt: '2026-10-04T12:00:00.000001Z', subtotalCents: subtotal(one), lines } });
        }
        const rows = [...drafts].reverse().map((d, i) => ({ id: d.id, customerId: d.customerId, status: 'draft', currency: 'USD', lineCount: d.body.lines.length, subtotalCents: subtotal(d), createdAt: `2026-10-04T12:00:${String(59 - i).padStart(2, '0')}.000001Z` }));
        return reply(200, { drafts: rows, nextCursor: null });
      }
      return refuse(404); // nothing else exists here: a write would be recorded, and refused
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

/** The Invoices page, with the shop's session and customers singletons answered by `server`. */
function mount(server: Server) {
  net.current.session = createTenantSessionClient({ fetch: server.fetch }) satisfies TenantSessionClient;
  net.current.customers = createCustomersClient({ fetch: server.fetch }) satisfies CustomersClient;
  net.current.drafts = createInvoiceDraftsClient({ fetch: server.fetch }) satisfies InvoiceDraftsClient;
  return render(<MemoryRouter initialEntries={['/invoices']}><Invoices /></MemoryRouter>);
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
const click = async (testId: string) => { await userEvent.setup().click(screen.getByTestId(testId)); };
const customerSelect = () => screen.getByTestId('invoice-customer-select') as HTMLSelectElement;
const save = () => screen.getByTestId('invoice-create-save');
const dialog = () => screen.queryByTestId('picker-dialog');
const value = () => screen.queryByTestId('picker-value');
const limit = () => screen.queryByTestId('invoice-server-limit');
const pickerReady = () => waitFor(() => expect(screen.getByTestId('picker-state')).toHaveAttribute('data-phase', 'ready'));
const writes = (s: Server) => s.sent.filter((r) => r.method !== 'GET' && (r.url.startsWith(CUSTOMERS_PATH) || r.url.startsWith(STORES_PATH)));
const pickLocal = (id: string) => fireEvent.change(customerSelect(), { target: { value: id } });
/** A named line item: the first stock item, chosen from the product search. */
const addItem = async () => {
  await userEvent.setup().click(screen.getByPlaceholderText('Search inventory by name or SKU...'));
  await userEvent.setup().click(screen.getByRole('button', { name: /Screen Protector/ }));
};
/** Open the picker in the create draft and choose `id` from page one. */
const chooseServer = async (id: string) => {
  await click('picker-open');
  await pickerReady();
  const row = screen.getAllByTestId('picker-row').find((r) => r.getAttribute('data-id') === id)!;
  await userEvent.setup().click(within(row).getByTestId('picker-select'));
  await waitFor(() => expect(value()).toHaveAttribute('data-id', id));
};
/** The keys an invoice made here has always had (pre-P9): the draft's reference never rides along. */
const INVOICE_KEYS = [
  'amountPaid', 'balance', 'createdAt', 'customerEmail', 'customerId', 'customerName', 'customerPhone', 'discount', 'dueDate', 'id', 'invoiceNumber',
  'isRecurring', 'items', 'notes', 'paymentHistory', 'recurringInterval', 'remindersSent', 'status', 'statusHistory', 'subtotal', 'tax', 'terms', 'total',
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  access.set(DEFAULT_ACCESS);
  addInvoice.mockClear();
  updateInvoice.mockClear();
  find.mockClear();
  fieldRenders.length = 0;
});

describe('Invoices — a server customer in the create draft (M7A-CUSTOMERS-P9)', () => {
  it('INV-01. AC-03: a local customer still creates exactly the invoice it did before — its local snapshot, the same keys — and the draft sends no request', async () => {
    const server = fakeServer();
    mount(server);
    await click('invoice-create-open');
    expect(screen.getByLabelText('Customer *')).toBe(customerSelect()); // the label names the select
    expect(save()).toBeDisabled();
    pickLocal('c1');
    await addItem();
    expect(save()).toBeEnabled();
    expect(limit()).toBeNull();
    await click('invoice-create-save');
    expect(addInvoice).toHaveBeenCalledTimes(1);
    const made = addInvoice.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(made).sort()).toEqual(INVOICE_KEYS);
    expect(made).toEqual(expect.objectContaining({
      customerId: 'c1', customerName: 'Local Person', customerEmail: 'local@synthetic.test', customerPhone: '5550100', status: 'Unpaid', subtotal: 10, total: 10.8,
      items: [expect.objectContaining({ name: 'Screen Protector', quantity: 1, price: 10, type: 'product', stockItemId: 'p1' })],
    }));
    await waitFor(() => expect(screen.queryByText('Create New Invoice')).toBeNull()); // closed, as before
    expect(server.sent).toEqual([]); // the server-customer entry point reads nothing until it is opened
  });

  it('INV-02. AC-03 (M7B-INVOICES-P1): a server customer is shown as the server\'s, Generate stays disabled with the limit text that now points to "Save as server draft", and choosing it reaches neither the local list nor an invoice', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await addItem();
    await chooseServer(ada.id);
    expect(dialog()).toBeNull();
    expect(within(value()!).getByTestId('picker-value-badge')).toHaveTextContent('Server customer');
    expect(within(value()!).getByTestId('picker-value-name')).toHaveTextContent('Ada Server');
    expect(customerSelect().value).toBe(''); // no local customer is named
    expect(save()).toBeDisabled();
    expect(limit()).toHaveAttribute('role', 'status');
    expect(limit()).toHaveTextContent(SERVER_DRAFT_LIMIT_TEXT);
    expect(screen.getByTestId('picker-field')).not.toHaveTextContent(/saved|created/i); // a selection is not a save
    expect(SERVER_DRAFT_LIMIT_TEXT).toMatch(/no invoice can be generated here/);
    expect(SERVER_DRAFT_LIMIT_TEXT).toMatch(/Save as server draft/);
    expect(screen.getByTestId('invoice-server-draft')).toHaveTextContent('Save as server draft'); // offered, not taken
    // React never calls a disabled button's onClick, so a click here would prove nothing more than `disabled`:
    // handleCreateInvoice's own `customer.source === 'local'` guard is defence in depth, recorded as untested.
    expect(addInvoice).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled(); // never looked up in the local list
    expect(writes(server)).toEqual([]);
  });

  it('INV-03. AC-03: choosing a local customer replaces the server customer, and the invoice is the local one\'s', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await addItem();
    await chooseServer(ada.id);
    pickLocal('c2');
    expect(value()).toBeNull();
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
    expect(limit()).toBeNull();
    expect(save()).toBeEnabled();
    await click('invoice-create-save');
    expect(addInvoice).toHaveBeenCalledTimes(1);
    const made = addInvoice.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(made).sort()).toEqual(INVOICE_KEYS);
    expect(made).toEqual(expect.objectContaining({ customerId: 'c2', customerName: 'Other Local', customerEmail: 'other@synthetic.test', customerPhone: '5550111' }));
    expect(JSON.stringify(made)).not.toContain(ada.id);
    expect(writes(server)).toEqual([]);
  });

  it('INV-04. AC-04: select, Change, Remove and Cancel create no invoice and send nothing but reads', async () => {
    const server = fakeServer();
    const [ada, bea] = server.seed(TENANT_A, ['Ada Server', 'Bea Server']);
    mount(server);
    await click('invoice-create-open');
    await addItem();
    await chooseServer(ada.id);
    await click('picker-change');
    await pickerReady();
    await click('picker-cancel'); // cancel keeps the choice
    expect(value()).toHaveAttribute('data-id', ada.id);
    await click('picker-change');
    await pickerReady();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Select Bea Server' }));
    await waitFor(() => expect(value()).toHaveAttribute('data-id', bea.id));
    await click('picker-remove');
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(save()).toBeDisabled(); // no customer at all now
    expect(addInvoice).not.toHaveBeenCalled();
    expect(updateInvoice).not.toHaveBeenCalled();
    expect(writes(server)).toEqual([]);
    expect(server.sent.every((r) => r.method === 'GET' || r.url === TENANT_SESSION_PATHS.login)).toBe(true);
  });

  it('INV-05. AC-05: a user switch drops the previous user\'s server customer in the same render, and switching back does not bring it back', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await addItem();
    await chooseServer(ada.id);
    fieldRenders.length = 0;
    act(() => { access.set({ uid: 'uid-b' }); });
    expect(fieldRenders.filter((r) => r.valueUid !== null && r.valueUid !== r.uid)).toEqual([]); // not even for one render
    expect(fieldRenders.at(-1)).toEqual({ uid: 'uid-b', canView: true, valueUid: null });
    expect(value()).toBeNull(); // never shown to uid-b
    expect(limit()).toBeNull();
    expect(screen.queryByText('Ada Server')).toBeNull();
    expect(save()).toBeDisabled();
    act(() => { access.set({ uid: 'uid-a' }); });
    await settle();
    expect(value()).toBeNull(); // the draft dropped it: it is gone, not hidden
    expect(limit()).toBeNull();
    expect(addInvoice).not.toHaveBeenCalled();
  });

  it('INV-06. AC-05: a reopened draft starts with no customer, and a read the closed draft\'s picker had out (a late 401) never drops the new draft\'s server customer (which still offers "Save as server draft", M7B-INVOICES-P1)', async () => {
    const server = fakeServer();
    const [ada, bea] = server.seed(TENANT_A, ['Ada Server', 'Bea Server']);
    mount(server);
    await click('invoice-create-open');
    await chooseServer(ada.id);
    server.hold.reads = 1;
    await click('picker-change');
    await waitFor(() => expect(server.held).toHaveLength(1));
    // The draft closes under its open picker (the modal's close button), and a new draft opens.
    fireEvent.click(screen.getByText('close').closest('button')!);
    await waitFor(() => expect(screen.queryByText('Create New Invoice')).toBeNull());
    expect(dialog()).toBeNull();
    await click('invoice-create-open');
    expect(value()).toBeNull();
    expect(customerSelect().value).toBe('');
    await chooseServer(bea.id);
    // The closed draft's read answers now, refused 401: were it heard, it would say "ended" and drop Bea.
    await act(async () => { server.held[0].release(new Response(JSON.stringify({ error: 'e401', requestId: 'req-synthetic' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } })); });
    await settle();
    expect(dialog()).toBeNull();
    expect(value()).toHaveAttribute('data-id', bea.id);
    expect(limit()).toHaveTextContent(SERVER_DRAFT_LIMIT_TEXT);
    expect(screen.getByTestId('invoice-server-draft')).toBeInTheDocument();
    expect(screen.queryByTestId('picker-notice')).toBeNull();
  });

  it('INV-07. AC-05: the server session ends while the draft holds a server customer: a window focus removes it with the notice and signs nothing in', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await addItem();
    await chooseServer(ada.id);
    const loginsBefore = server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login).length;
    server.expire();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(value()).toBeNull());
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(limit()).toBeNull();
    expect(save()).toBeDisabled();
    expect(server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login)).toHaveLength(loginsBefore);
    pickLocal('c1');
    expect(save()).toBeEnabled(); // a local customer still makes the invoice
  });

  it('INV-08. AC-06: without Customers View there is no server entry point (the muted line instead), and the local select still works', async () => {
    access.set({ customersView: false });
    const server = fakeServer();
    mount(server);
    await click('invoice-create-open');
    expect(screen.queryByTestId('picker-open')).toBeNull();
    expect(screen.getByTestId('picker-unavailable')).toHaveTextContent(NOT_AVAILABLE_TEXT);
    pickLocal('c1');
    await addItem();
    await click('invoice-create-save');
    expect(addInvoice).toHaveBeenCalledTimes(1);
    expect(server.sent).toEqual([]);
  });

  it('INV-09. AC-06: without Invoices Create there is no Create Invoice button at all', () => {
    access.set({ invoicesCreate: false });
    mount(fakeServer());
    expect(screen.queryByTestId('invoice-create-open')).toBeNull();
    expect(screen.queryByTestId('picker-open')).toBeNull();
  });

  it('INV-10. AC-06: Invoices Create lost while the picker is open: the Select click binds nothing', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await click('picker-open');
    await pickerReady();
    act(() => { access.set({ invoicesCreate: false }); });
    expect(screen.queryByTestId('invoice-create-open')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Select Ada Server' }));
    await settle();
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(screen.queryByText('Ada Server')).toBeNull();
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
  });

  it('INV-11. AC-06: Customers View lost while the draft holds a server customer: it goes in the same render, and regained access does not bring it back', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await chooseServer(ada.id);
    fieldRenders.length = 0;
    act(() => { access.set({ customersView: false }); });
    expect(fieldRenders.filter((r) => r.valueUid !== null && !r.canView)).toEqual([]); // not even for one render
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(screen.getByTestId('picker-unavailable')).toHaveTextContent(NOT_AVAILABLE_TEXT);
    act(() => { access.set({ customersView: true }); });
    await settle();
    expect(value()).toBeNull();
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
  });

  it('INV-12. the edit modal offers no server picker and saves a local customer exactly as before', async () => {
    const server = fakeServer();
    mount(server);
    await userEvent.setup().click(screen.getAllByText('INV-2026-001')[0]);
    await userEvent.setup().click(screen.getByRole('button', { name: /Edit Invoice/ }));
    expect(screen.getByText('Edit Invoice', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByLabelText('Customer *')).toBe(customerSelect());
    expect(customerSelect().value).toBe('c1');
    expect(screen.queryByTestId('picker-field')).toBeNull();
    expect(screen.queryByTestId('picker-open')).toBeNull();
    expect(screen.queryByTestId('picker-unavailable')).toBeNull();
    pickLocal('c2');
    await click('invoice-edit-save');
    expect(updateInvoice).toHaveBeenCalledTimes(1);
    const [id, changes] = updateInvoice.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('inv-001');
    expect(changes).toEqual(expect.objectContaining({ customerId: 'c2', customerName: 'Other Local', customerEmail: 'other@synthetic.test', customerPhone: '5550111' }));
    expect(Object.keys(changes)).not.toContain('customer');
    expect(addInvoice).not.toHaveBeenCalled();
    expect(server.sent).toEqual([]);
  });

  it('INV-14. AC-06: the plan has no customers feature (the directory route\'s gate): no server entry point, and the local select still makes the invoice', async () => {
    access.set({ customersFeature: false });
    const server = fakeServer();
    mount(server);
    await click('invoice-create-open');
    expect(screen.queryByTestId('picker-open')).toBeNull();
    expect(screen.getByTestId('picker-unavailable')).toHaveTextContent(NOT_AVAILABLE_TEXT);
    pickLocal('c1');
    await addItem();
    await click('invoice-create-save');
    expect(addInvoice).toHaveBeenCalledTimes(1);
    expect(addInvoice.mock.calls[0][0]).toEqual(expect.objectContaining({ customerId: 'c1', customerName: 'Local Person' }));
    expect(server.sent).toEqual([]);
  });

  it('INV-15. the disabled Generate is described by the limit text (M7B-INVOICES-P1: naming "Save as server draft") while a server customer is held, and by nothing once a local one replaces it', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await addItem();
    expect(save()).not.toHaveAttribute('aria-describedby');
    await chooseServer(ada.id);
    expect(save()).toBeDisabled();
    expect(save()).toHaveAttribute('aria-describedby', 'invoice-server-limit');
    expect(save()).toHaveAccessibleDescription(SERVER_DRAFT_LIMIT_TEXT);
    expect(screen.getByTestId('invoice-server-draft')).toBeEnabled();
    pickLocal('c1');
    expect(save()).toBeEnabled();
    expect(save()).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('invoice-server-draft')).toBeNull();
  });

  it('INV-16. M7B-INVOICES-P1: "Save as server draft" closes the invoice form and hands ONLY the customer to the Server drafts dialog; the draft saved there never becomes a local invoice', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    const before = screen.getAllByRole('row').length;
    await click('invoice-create-open');
    await addItem(); // a local line with a price: never carried over
    await chooseServer(ada.id);
    await click('invoice-server-draft');
    await waitFor(() => expect(screen.queryByText('Create New Invoice')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('drafts-handoff')).toHaveTextContent('Ada Server'));
    fireEvent.change(screen.getByTestId('drafts-store'), { target: { value: STORE } });
    await waitFor(() => expect(screen.getByTestId('draft-new')).toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByTestId('draft-new')).getByTestId('picker-value')).toHaveAttribute('data-id', ada.id));
    expect(screen.getByTestId('draft-new-description')).toHaveValue(''); // the invoice form's lines stay behind
    expect(screen.getByTestId('draft-new-price')).toHaveValue('');
    fireEvent.change(screen.getByTestId('draft-new-description'), { target: { value: 'Battery' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '49.90' } });
    await click('draft-new-save');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.bodies).toEqual([JSON.stringify({ expectedTenant: TENANT_A, customerId: ada.id, currency: 'USD', lines: [{ description: 'Battery', quantity: 1, unitPriceCents: 4990 }] })]);
    expect(addInvoice).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByTestId('drafts-row')).toHaveLength(1));
    expect(screen.getAllByRole('row')).toHaveLength(before); // the local invoice table is untouched
  });

  it('INV-17. M7B-INVOICES-P1: the Server drafts section reads nothing until shown, and its drafts never reach the local invoice list or its counters', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    server.drafts.push({ id: uuid(0xdd1), customerId: ada.id, body: { lines: [{ description: 'Fan', quantity: 2, unitPriceCents: 999999 }] } });
    mount(server);
    const counters = () => screen.getByText('Total Outstanding').parentElement!.textContent;
    const outstanding = counters();
    const table = () => screen.getAllByRole('row').map((r) => r.textContent);
    const rowsBefore = table();
    await settle();
    expect(server.sent).toEqual([]);
    await click('drafts-show');
    await waitFor(() => expect(screen.getByTestId('drafts-store')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('drafts-store'), { target: { value: STORE } });
    await waitFor(() => expect(screen.getAllByTestId('drafts-row')).toHaveLength(1));
    expect(screen.getByTestId('drafts-row-subtotal')).toHaveTextContent('Draft subtotal $19,999.98');
    expect(table()).toEqual(rowsBefore);
    expect(counters()).toBe(outstanding);
    expect(addInvoice).not.toHaveBeenCalled();
    expect(writes(server)).toEqual([]);
  });

  it('INV-13. the draft writes no browser storage and logs nothing, and the page source reaches neither', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const before = { local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie };
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await chooseServer(ada.id);
    pickLocal('c1');
    await addItem();
    await click('invoice-create-save');
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(before.local);
    expect(window.sessionStorage.length).toBe(before.session);
    expect(document.cookie).toBe(before.cookie);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'Invoices.tsx'), 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });

  it('INV-18. DA-202: a sign-out while the draft holds a server customer and the picker is CLOSED (no focus, no tab return) removes it at once with the notice — no limit text, no "Save as server draft", Generate blocked until a local customer — and sends nothing but the logout; a local customer chosen instead is untouched by the next sign-out', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await addItem();
    await chooseServer(ada.id);
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('invoice-server-draft')).toBeInTheDocument();
    const mark = server.sent.length;
    await act(async () => { await (net.current.session as TenantSessionClient).logout(); });
    expect(value()).toBeNull();
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(limit()).toBeNull();
    expect(screen.queryByTestId('invoice-server-draft')).toBeNull();
    expect(save()).toBeDisabled();
    await settle();
    expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(screen.queryByTestId('drafts-handoff')).toBeNull();
    pickLocal('c1');
    expect(customerSelect().value).toBe('c1');
    expect(save()).toBeEnabled();
    await act(async () => { await (net.current.session as TenantSessionClient).logout(); });
    expect(customerSelect().value).toBe('c1'); // a local customer is not the session's: it stays
    expect(save()).toBeEnabled();
    expect(writes(server)).toEqual([]);
    expect(addInvoice).not.toHaveBeenCalled();
  });

  it('INV-19. DA-202: "Save as server draft" pressed after another session\'s context was handed out but before the field heard it: nothing is handed to the Server drafts section; the customer leaves the draft and a focused alert says to select it again', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await chooseServer(ada.id);
    // A later session's context is handed out, and the press lands before the field is told (one task, no microtask between).
    act(() => {
      sessionContextOf('uid-a', `${'x'.repeat(40)}999`, sessionEndsSoFar());
      screen.getByTestId('invoice-server-draft').click();
    });
    await settle();
    expect(screen.getByText('Create New Invoice')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-server-draft-refused')).toHaveTextContent(NOT_SENT_TEXT.customer);
    expect(screen.getByTestId('invoice-server-draft-refused')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('invoice-server-draft-refused')).toHaveFocus();
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(screen.queryByTestId('drafts-handoff')).toBeNull();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    await chooseServer(ada.id); // choosing again (a new session's context) clears the alert
    expect(screen.queryByTestId('invoice-server-draft-refused')).toBeNull();
    expect(writes(server)).toEqual([]);
  });

  it('INV-20. DA-202: another session\'s context handed out while the draft holds a server customer and the picker is CLOSED: the field drops it with the ended notice — the limit text and "Save as server draft" go — and nothing is written', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await chooseServer(ada.id);
    act(() => { sessionContextOf('uid-a', `${'x'.repeat(40)}998`, sessionEndsSoFar()); });
    await settle();
    expect(value()).toBeNull();
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(limit()).toBeNull();
    expect(screen.queryByTestId('invoice-server-draft')).toBeNull();
    expect(writes(server)).toEqual([]);
  });

  it('INV-21. DA-202: the refusal\'s alert never takes focus the user has moved elsewhere: a press refused, and focus moved to the local customer select before the page commits — focus stays there; the alert is still said', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('invoice-create-open');
    await chooseServer(ada.id);
    act(() => {
      sessionContextOf('uid-a', `${'x'.repeat(40)}997`, sessionEndsSoFar());
      screen.getByTestId('invoice-server-draft').click();
      customerSelect().focus();
    });
    await settle();
    expect(screen.getByTestId('invoice-server-draft-refused')).toHaveTextContent(NOT_SENT_TEXT.customer);
    expect(customerSelect()).toHaveFocus();
    expect(screen.queryByTestId('drafts-handoff')).toBeNull();
    expect(writes(server)).toEqual([]);
  });
});
