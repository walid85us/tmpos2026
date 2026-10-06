// M7A-CUSTOMERS-P10 — the NEW repair ticket dialog with a customer saved on the server, in jsdom: the REAL RepairTickets
// page over a plain local store (local customers c1..c3, a spied addRepairTicket — nothing persisted), a switchable
// access context, and the shop's tenant session and customers singletons replaced by the REAL clients over one reduced
// fake tenant server at the network boundary (the same reduced copy Invoices.serverCustomer.test.tsx uses; synthetic
// tenants, users and names only), and the real server-customer field behind a pass-through that records what each
// render hands it. Ordering is controlled with the fake's hold/release (no sleeps). Every assertion about a request is
// made on what the fake recorded — the wire — and every assertion about a ticket on what the page handed the local store.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { CustomersClient } from '../tenant/customersClient';
import type { TenantSessionClient } from '../tenant/tenantSessionClient';
import type { ServerCustomerReference } from '../tenant/customerReference';

// `customersFeature`: the plan's customers feature (canAccess('customers'), the directory route's AccessGuard).
interface Access { uid: string | null; repairsCreate: boolean; customersView: boolean; customersFeature: boolean; role: string }
const DEFAULT_ACCESS: Access = { uid: 'uid-a', repairsCreate: true, customersView: true, customersFeature: true, role: 'manager' };
const access = vi.hoisted(() => {
  let value: Access = { uid: 'uid-a', repairsCreate: true, customersView: true, customersFeature: true, role: 'manager' };
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
// The page reads the signed-in user, the effective role and the local role state's hints: a switchable stand-in.
vi.mock('../context/AccessContext', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAccess: () => {
      const v = useSyncExternalStore(access.subscribe, access.get);
      return {
        session: v.uid === null ? null : { user: { id: v.uid } },
        effectiveRole: v.role,
        checkPermission: (domain: string, level: string) =>
          domain === 'repairs' ? level === 'create' && v.repairsCreate : domain === 'customers' && level === 'view' && v.customersView,
        checkSubPermission: () => false,
        canAccess: (feature: string) => feature === 'customers' && v.customersFeature,
      };
    },
  };
});
// The shop's singletons, as the page uses them by default: each delegates to this test's real client over its fake server.
const net = vi.hoisted(() => {
  const current = { session: null as unknown, customers: null as unknown };
  const delegate = (key: keyof typeof current) =>
    new Proxy({}, { get: (_, method) => (...args: unknown[]) => (current[key] as Record<PropertyKey, (...a: unknown[]) => unknown>)[method](...args) });
  return { current, session: delegate('session'), customers: delegate('customers') };
});
vi.mock('../tenant/tenantSessionClient', async (original) => ({
  ...(await original<typeof import('../tenant/tenantSessionClient')>()),
  tenantSession: net.session,
}));
vi.mock('../tenant/customersClient', async (original) => ({
  ...(await original<typeof import('../tenant/customersClient')>()),
  customers: net.customers,
}));
// The dialog's server-customer field, passed through unchanged, recording what each render hands it (including the
// draft's report callback, so a test can replay a CLOSED draft's late report): no render may hand it another user's
// customer, or any customer once view access is gone.
type Report = (next: ServerCustomerReference | null, why: 'selected' | 'removed' | 'ended' | 'denied' | 'changed') => void;
const fieldRenders = vi.hoisted(() => [] as Array<{ uid: string | null; canView: boolean; valueUid: string | null; value: unknown; onChange: unknown }>);
vi.mock('../tenant/ServerCustomerPicker', async (original) => {
  const real = await original<typeof import('../tenant/ServerCustomerPicker')>();
  const { createElement } = await import('react');
  return {
    ...real,
    ServerCustomerField: (props: Parameters<typeof real.ServerCustomerField>[0]) => {
      fieldRenders.push({ uid: props.uid, canView: props.canView, valueUid: props.value?.uid ?? null, value: props.value, onChange: props.onChange });
      return createElement(real.ServerCustomerField, props);
    },
  };
});
// The local store: three local customers (c3 shares its name with server customers), no tickets; every write spied.
const addRepairTicket = vi.fn();
const LOCAL = [
  { id: 'c1', name: 'Local Person', email: 'local@synthetic.test', phone: '5550100', totalSpent: 0, lastVisit: '2026-01-01', loyaltyPoints: 0, tier: 'Bronze', group: 'Retail', tags: [], notes: [], assets: [], customFields: [] },
  { id: 'c2', name: 'Other Local', email: 'other@synthetic.test', phone: '5550111', totalSpent: 0, lastVisit: '2026-01-01', loyaltyPoints: 0, tier: 'Bronze', group: 'Retail', tags: [], notes: [], assets: [], customFields: [] },
  { id: 'c3', name: 'Sam Same', email: 'same@synthetic.test', phone: '5550122', totalSpent: 0, lastVisit: '2026-01-01', loyaltyPoints: 0, tier: 'Bronze', group: 'Retail', tags: [], notes: [], assets: [], customFields: [] },
];
// The page's only reads of its local customer list: `find` (ticket detail) and `filter` (the customer box's search).
const find = vi.fn(function (this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown) { return Array.prototype.find.call(this, predicate); });
const filter = vi.fn(function (this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown) { return Array.prototype.filter.call(this, predicate); });
const storeValue = {
  repairTickets: [], addRepairTicket, updateRepairTicket: vi.fn(), deleteRepairTicket: vi.fn(),
  warrantyRepairTickets: [], updateWarrantyRepairTicket: vi.fn(), warrantyClaims: [], updateWarrantyClaim: vi.fn(),
  customers: Object.assign([...LOCAL], { find, filter }), services: [], serviceCategories: [], approvedStockItems: [],
  invoices: [], addInvoice: vi.fn(), posOperator: null, updateStockItem: vi.fn(), addStockMovement: vi.fn(), shipments: [],
};
vi.mock('../context/StoreLocalState', () => ({ useStoreLocalState: () => storeValue, SEED_POS_OPERATORS: [] }));

import RepairTickets, { SERVER_REPAIR_LIMIT_TEXT } from './RepairTickets';
import { NOT_AVAILABLE_TEXT, PICK_ENDED_TEXT, idEndingText } from '../tenant/ServerCustomerPicker';
import { CUSTOMERS_PATH, createCustomersClient, type CustomerEntry } from '../tenant/customersClient';
import { createTenantSessionClient, TENANT_SESSION_PATHS } from '../tenant/tenantSessionClient';
import { encodeCustomerCursor, encodeCustomerSearchCursor, parseCustomerDirectoryQuery } from '../../server/runtime/customerDirectory';
import { sessionSubjectOf } from '../../server/runtime/sessions';

const activeBody = (uid: string, csrfToken: string) =>
  ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);

interface Sent { readonly method: string; readonly url: string; readonly headers: Headers }
interface User { uid: string; tenant: string; view: boolean }

/** One fake tenant server, reduced to the session and the list read. `cookie` is the session the browser presents. */
function fakeServer() {
  const users: Record<string, User> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, view: true },
    'tok-b': { uid: 'uid-b', tenant: TENANT_B, view: true },
  };
  const sessions = new Map<string, { user: User; csrf: string }>();
  const rows: Record<string, CustomerEntry[]> = { [TENANT_A]: [], [TENANT_B]: [] };
  let sessionCount = 0;
  let idCount = 0xa00;
  const reply = (status: number, body?: unknown): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' } });
  const refuse = (status: number): Response => reply(status, { error: `e${status}`, requestId: 'req-synthetic' });
  const byteOrder = (x: CustomerEntry, y: CustomerEntry): number =>
    Buffer.compare(Buffer.from(x.name, 'utf8'), Buffer.from(y.name, 'utf8')) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

  const server = {
    sent: [] as Sent[],
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
      return refuse(404); // nothing else exists here: a write would be recorded, and refused
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

/** Where the page's router is: a draft may never move it (no query, no hash, no state of its own). */
function LocationProbe() {
  const at = useLocation();
  return <output data-testid="location">{`${at.pathname}${at.search}${at.hash}`}</output>;
}

/** The Repairs page, with the shop's session and customers singletons answered by `server`. */
function mount(server: Server) {
  net.current.session = createTenantSessionClient({ fetch: server.fetch }) satisfies TenantSessionClient;
  net.current.customers = createCustomersClient({ fetch: server.fetch }) satisfies CustomersClient;
  return render(<MemoryRouter initialEntries={['/repairs']}><RepairTickets /><LocationProbe /></MemoryRouter>);
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
const click = async (testId: string) => { await userEvent.setup().click(screen.getByTestId(testId)); };
const dialogPanel = () => screen.queryByTestId('repair-create-dialog');
const customerBox = () => screen.getByTestId('repair-customer-search') as HTMLInputElement;
const device = () => screen.getByTestId('repair-device') as HTMLInputElement;
const issue = () => screen.getByTestId('repair-issue') as HTMLTextAreaElement;
const save = () => screen.getByTestId('repair-create-save');
const picker = () => screen.queryByTestId('picker-dialog');
const value = () => screen.queryByTestId('picker-value');
const limit = () => screen.queryByTestId('repair-server-limit');
const pickerReady = () => waitFor(() => expect(screen.getByTestId('picker-state')).toHaveAttribute('data-phase', 'ready'));
const writes = (s: Server) => s.sent.filter((r) => r.method !== 'GET' && r.url.startsWith(CUSTOMERS_PATH));
/** Only list reads, session reads and the one login: no customer write, nothing naming a repair. */
const readsOnly = (s: Server) => s.sent.every((r) => (r.method === 'GET' || r.url === TENANT_SESSION_PATHS.login) && !/repair|ticket/i.test(r.url));
const fillDeviceAndIssue = () => {
  fireEvent.change(device(), { target: { value: 'Synthetic Phone 1' } });
  fireEvent.change(issue(), { target: { value: 'Cracked synthetic screen' } });
};
/** Type into the customer box: a walk-in name, or a search of this browser's list. */
const typeCustomer = (text: string) => fireEvent.change(customerBox(), { target: { value: text } });
/** Search this browser's list and pick the local customer named `name` from the dropdown. */
const pickLocal = async (search: string, name: string) => {
  typeCustomer(search);
  await userEvent.setup().click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
};
/** Open the picker in the new-ticket draft and choose `id` from page one. */
const chooseServer = async (id: string) => {
  await click('picker-open');
  await pickerReady();
  const row = screen.getAllByTestId('picker-row').find((r) => r.getAttribute('data-id') === id)!;
  await userEvent.setup().click(within(row).getByTestId('picker-select'));
  await waitFor(() => expect(value()).toHaveAttribute('data-id', id));
};
const waitClosed = () => waitFor(() => expect(dialogPanel()).toBeNull());
/** The keys a ticket made here has always had (pre-P10): the draft's reference never rides along. */
const TICKET_KEYS = [
  'brand', 'comments', 'createdAt', 'customerEmail', 'customerId', 'customerName', 'customerPhone', 'device', 'deviceCategory', 'estimatedCost',
  'history', 'id', 'imei', 'intakeNotes', 'isRushJob', 'issue', 'location', 'model', 'network', 'passcode', 'preRepairCondition', 'priority',
  'serialNumber', 'serviceLineItems', 'status', 'technicianId', 'technicianName', 'ticketNumber', 'updatedAt',
];
const made = (): Record<string, unknown> => addRepairTicket.mock.calls[0][0] as Record<string, unknown>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  access.set(DEFAULT_ACCESS);
  addRepairTicket.mockClear();
  find.mockClear();
  filter.mockClear();
  fieldRenders.length = 0;
});

describe('RepairTickets — a server customer in the new ticket draft (M7A-CUSTOMERS-P10)', () => {
  it('REP-01. a local customer still creates exactly the ticket it did before — its local snapshot, the same keys — and the draft sends no request', async () => {
    const server = fakeServer();
    mount(server);
    await click('repair-create-open');
    expect(screen.getByLabelText('Customer')).toBe(customerBox()); // the label names the customer box
    fillDeviceAndIssue();
    expect(save()).toBeDisabled(); // no customer yet
    await pickLocal('Local', 'Local Person');
    expect(customerBox().value).toBe('Local Person');
    expect(save()).toBeEnabled();
    expect(save()).not.toHaveAttribute('aria-describedby');
    expect(limit()).toBeNull();
    await click('repair-create-save');
    expect(addRepairTicket).toHaveBeenCalledTimes(1);
    expect(Object.keys(made()).sort()).toEqual(TICKET_KEYS);
    expect(made()).toEqual(expect.objectContaining({
      customerId: 'c1', customerName: 'Local Person', customerPhone: '5550100', customerEmail: 'local@synthetic.test',
      device: 'Synthetic Phone 1', issue: 'Cracked synthetic screen', status: 'Pending', priority: 'Medium', isRushJob: false,
      estimatedCost: 0, technicianId: undefined, technicianName: undefined, location: 'Intake Shelf', comments: [],
    }));
    expect(made().history).toEqual([expect.objectContaining({ action: 'Ticket Created', performedBy: 'Current User' })]);
    await waitClosed(); // closed, as before
    expect(server.sent).toEqual([]); // the server-customer entry point reads nothing until it is opened
  });

  it('REP-02. a typed walk-in name still creates a walk-in ticket: an id minted at save, the typed name, no contact', async () => {
    const server = fakeServer();
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    typeCustomer('Walk In Person');
    expect(save()).toBeEnabled();
    await click('repair-create-save');
    expect(addRepairTicket).toHaveBeenCalledTimes(1);
    expect(Object.keys(made()).sort()).toEqual(TICKET_KEYS);
    expect(made().customerId).toMatch(/^walk-in-\d+$/);
    expect(made()).toEqual(expect.objectContaining({ customerName: 'Walk In Person', customerPhone: '', customerEmail: '' }));
    await waitClosed();
    expect(server.sent).toEqual([]);
  });

  it('REP-03. a technician\'s new ticket is still assigned to them automatically', async () => {
    access.set({ role: 'technician' });
    mount(fakeServer());
    await click('repair-create-open');
    fillDeviceAndIssue();
    typeCustomer('Walk In Person');
    await click('repair-create-save');
    expect(made()).toEqual(expect.objectContaining({ technicianId: 'uid-a', technicianName: 'Current User' }));
    expect((made().history as Array<{ action: string }>).map((h) => h.action)).toEqual(['Ticket Created', 'Assigned to Current User (auto)']);
  });

  it('REP-04. among identical names the chosen server customer keeps its own id, shown with its name and ID ending, and is never looked up or matched in the local list', async () => {
    const server = fakeServer();
    const [first, second] = server.seed(TENANT_A, ['Sam Same', 'Sam Same']); // and local c3 is "Sam Same" too
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    find.mockClear();
    filter.mockClear();
    await chooseServer(second.id);
    expect(picker()).toBeNull();
    expect(within(value()!).getByTestId('picker-value-badge')).toHaveTextContent('Server customer');
    expect(within(value()!).getByTestId('picker-value-name')).toHaveTextContent('Sam Same');
    expect(value()).toHaveTextContent(idEndingText(second.id));
    expect(value()).not.toHaveTextContent(idEndingText(first.id));
    expect(customerBox().value).toBe(''); // no local name, and no local search
    expect(screen.queryByText('5550122 • same@synthetic.test')).toBeNull(); // local c3 is not offered
    expect(find).not.toHaveBeenCalled();
    expect(filter).not.toHaveBeenCalled();
    expect(addRepairTicket).not.toHaveBeenCalled();
    expect(writes(server)).toEqual([]);
  });

  it('REP-05. a server customer with Device and Issue filled: Create is disabled and described by the limit text, and no path makes a ticket', async () => {
    // M7A-CUSTOMERS-P10: pins "a server reference ⇒ an empty customerName snapshot"; AC-04's two guards (Create disabled, handleCreateTicket's early return) are defence in depth over it.
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    await userEvent.setup().type(customerBox(), 'Walk In Person'); // a TYPED walk-in name first: choosing the server customer replaces it
    expect(customerBox().value).toBe('Walk In Person');
    expect(save()).toBeEnabled();
    expect(save()).not.toHaveAttribute('aria-describedby');
    await chooseServer(ada.id);
    expect(customerBox().value).toBe('');
    expect(save()).toBeDisabled();
    expect(save()).toHaveAttribute('aria-describedby', 'repair-server-limit');
    expect(save()).toHaveAccessibleDescription(SERVER_REPAIR_LIMIT_TEXT);
    expect(limit()).toHaveAttribute('role', 'status');
    expect(limit()).toHaveTextContent(SERVER_REPAIR_LIMIT_TEXT);
    // Enter in the fields submits nothing (there is no form).
    const user = userEvent.setup();
    await user.click(device());
    await user.keyboard('{Enter}');
    await user.click(issue());
    await user.keyboard('{Enter}');
    await user.click(save()); // a real press on the disabled Create
    // React never calls a disabled button's onClick: reach the handler through the button's own React props.
    const propsKey = Object.keys(save()).find((k) => k.startsWith('__reactProps$'))!;
    act(() => { (save() as unknown as Record<string, { onClick: () => void }>)[propsKey].onClick(); });
    await settle();
    expect(addRepairTicket).not.toHaveBeenCalled();
    expect(dialogPanel()).not.toBeNull(); // not closed
    expect(device().value).toBe('Synthetic Phone 1'); // not reset
    expect(value()).toHaveAttribute('data-id', ada.id);
    expect(writes(server)).toEqual([]);
    expect(readsOnly(server)).toBe(true);
    // The snapshot itself is empty, not only the box: with the reference removed, Device and Issue filled and nothing
    // else changed, Create stays disabled for want of a customer name (and is no longer described by the limit).
    await click('picker-remove');
    expect(limit()).toBeNull();
    expect(save()).toBeDisabled();
    expect(save()).not.toHaveAttribute('aria-describedby');
    // Control: a local customer in the same draft enables Create, so the disabled states above were the customer's.
    await pickLocal('Local', 'Local Person');
    expect(save()).toBeEnabled();
    expect(save()).not.toHaveAttribute('aria-describedby');
    expect(addRepairTicket).not.toHaveBeenCalled();
  });

  it('REP-06. Change → Cancel keeps the choice, Change → Select replaces it, and Remove clears only the binding', async () => {
    const server = fakeServer();
    const [ada, bea] = server.seed(TENANT_A, ['Ada Server', 'Bea Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    fireEvent.change(screen.getByPlaceholderText('e.g. Apple, Samsung'), { target: { value: 'Synthetic Brand' } });
    await pickLocal('Local', 'Local Person'); // a local customer first: choosing the server customer replaces its snapshot
    await chooseServer(ada.id);
    expect(customerBox().value).toBe('');
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
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
    expect(device().value).toBe('Synthetic Phone 1'); // the rest of the draft is untouched
    expect(issue().value).toBe('Cracked synthetic screen');
    expect((screen.getByPlaceholderText('e.g. Apple, Samsung') as HTMLInputElement).value).toBe('Synthetic Brand');
    expect(customerBox().value).toBe('');
    expect(save()).toBeDisabled(); // no customer at all now: the earlier local snapshot went with the server choice
    expect(save()).not.toHaveAttribute('aria-describedby');
    expect(addRepairTicket).not.toHaveBeenCalled();
    expect(writes(server)).toEqual([]);
    expect(readsOnly(server)).toBe(true);
  });

  it('REP-07. typing a walk-in name replaces the server customer, and the ticket is the walk-in\'s', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    await chooseServer(ada.id);
    typeCustomer('Walk In Person');
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
    expect(save()).toBeEnabled();
    await click('repair-create-save');
    expect(addRepairTicket).toHaveBeenCalledTimes(1);
    expect(Object.keys(made()).sort()).toEqual(TICKET_KEYS);
    expect(made().customerId).toMatch(/^walk-in-\d+$/);
    expect(made()).toEqual(expect.objectContaining({ customerName: 'Walk In Person', customerPhone: '', customerEmail: '' }));
    expect(JSON.stringify(made())).not.toContain(ada.id);
    expect(writes(server)).toEqual([]);
  });

  it('REP-08. picking a local customer replaces the server customer, and the ticket is the local one\'s', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    await chooseServer(ada.id);
    await pickLocal('Other', 'Other Local');
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(save()).toBeEnabled();
    await click('repair-create-save');
    expect(addRepairTicket).toHaveBeenCalledTimes(1);
    expect(Object.keys(made()).sort()).toEqual(TICKET_KEYS);
    expect(made()).toEqual(expect.objectContaining({ customerId: 'c2', customerName: 'Other Local', customerPhone: '5550111', customerEmail: 'other@synthetic.test' }));
    expect(JSON.stringify(made())).not.toContain(ada.id);
    expect(writes(server)).toEqual([]);
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByTestId('repair-create-cancel'))],
    ['the backdrop', () => fireEvent.click(dialogPanel()!.previousElementSibling!)],
  ])('REP-09. closed through %s and reopened, the draft starts with no customer', async (_, close) => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    await chooseServer(ada.id);
    close();
    await waitClosed();
    expect(picker()).toBeNull();
    fieldRenders.length = 0;
    await click('repair-create-open');
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(customerBox().value).toBe('');
    expect(device().value).toBe('');
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
    expect(fieldRenders.every((r) => r.value === null)).toBe(true);
    expect(addRepairTicket).not.toHaveBeenCalled();
  });

  it('REP-10. a closed draft\'s late report binds nothing into the new draft, and drops nothing from it', async () => {
    const server = fakeServer();
    const [ada, bea] = server.seed(TENANT_A, ['Ada Server', 'Bea Server']);
    mount(server);
    await click('repair-create-open');
    await chooseServer(ada.id);
    const closed = fieldRenders.at(-1)!; // what the closed draft's field would report through
    const adaRef = closed.value as ServerCustomerReference;
    expect(adaRef.id).toBe(ada.id);
    await click('repair-create-cancel');
    await waitClosed();
    await click('repair-create-open');
    act(() => { (closed.onChange as Report)(adaRef, 'selected'); }); // a late selection from the closed draft
    await settle();
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    await chooseServer(bea.id);
    act(() => { (closed.onChange as Report)(null, 'ended'); }); // a late "ended" from the closed draft
    await settle();
    expect(value()).toHaveAttribute('data-id', bea.id);
    expect(limit()).toHaveTextContent(SERVER_REPAIR_LIMIT_TEXT);
  });

  it('REP-11. a read the closed draft\'s picker had out (a late 401) never drops the reopened draft\'s server customer', async () => {
    const server = fakeServer();
    const [ada, bea] = server.seed(TENANT_A, ['Ada Server', 'Bea Server']);
    mount(server);
    await click('repair-create-open');
    await chooseServer(ada.id);
    server.hold.reads = 1;
    await click('picker-change');
    await waitFor(() => expect(server.held).toHaveLength(1));
    // The draft closes under its open picker (the backdrop), and a new draft opens.
    fireEvent.click(dialogPanel()!.previousElementSibling!);
    await waitClosed();
    expect(picker()).toBeNull();
    await click('repair-create-open');
    expect(value()).toBeNull();
    await chooseServer(bea.id);
    await act(async () => { server.held[0].release(new Response(JSON.stringify({ error: 'e401', requestId: 'req-synthetic' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } })); });
    await settle();
    expect(picker()).toBeNull();
    expect(value()).toHaveAttribute('data-id', bea.id);
    expect(limit()).toHaveTextContent(SERVER_REPAIR_LIMIT_TEXT);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
  });

  it('REP-18. a draft reopened before the close animation ends is a NEW draft: its field keeps nothing of the closed one (no notice, no reference)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    await chooseServer(ada.id);
    server.expire();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('picker-notice')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('repair-create-cancel'));
    fireEvent.click(screen.getByTestId('repair-create-open')); // at once: the closing dialog may still be on screen
    await settle();
    expect(screen.getAllByTestId('repair-create-dialog')).toHaveLength(1);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
    expect(value()).toBeNull();
  });

  it('REP-12. a user switch drops the previous user\'s server customer in the same render, and switching back does not bring it back', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    await chooseServer(ada.id);
    fieldRenders.length = 0;
    act(() => { access.set({ uid: 'uid-b' }); });
    expect(fieldRenders.filter((r) => r.valueUid !== null && r.valueUid !== r.uid)).toEqual([]); // not even for one render
    expect(fieldRenders.at(-1)).toEqual(expect.objectContaining({ uid: 'uid-b', canView: true, valueUid: null }));
    expect(value()).toBeNull(); // never shown to uid-b
    expect(limit()).toBeNull();
    expect(screen.queryByText('Ada Server')).toBeNull();
    expect(save()).toBeDisabled();
    act(() => { access.set({ uid: 'uid-a' }); });
    await settle();
    expect(value()).toBeNull(); // the draft dropped it: it is gone, not hidden
    expect(limit()).toBeNull();
    expect(addRepairTicket).not.toHaveBeenCalled();
  });

  it('REP-13. Customers View lost while the draft holds a server customer: it goes in the same render with the notice, and regained access does not bring it back', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
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

  it('REP-14. Repairs Create lost while the picker is open: the Select click binds nothing', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    await click('picker-open');
    await pickerReady();
    act(() => { access.set({ repairsCreate: false }); });
    expect(screen.queryByTestId('repair-create-open')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Select Ada Server' }));
    await settle();
    expect(value()).toBeNull();
    expect(limit()).toBeNull();
    expect(screen.queryByText('Ada Server')).toBeNull();
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
  });

  it('REP-15. without Repairs Create there is no New Ticket button and no picker', () => {
    access.set({ repairsCreate: false });
    mount(fakeServer());
    expect(screen.queryByTestId('repair-create-open')).toBeNull();
    expect(screen.queryByTestId('picker-open')).toBeNull();
  });

  it.each([
    ['the plan has no customers feature', { customersFeature: false }],
    ['the role lacks Customers View', { customersView: false }],
  ])('REP-16. %s: no server entry point (the muted line instead), and a walk-in still creates a ticket', async (_, denied) => {
    access.set(denied);
    const server = fakeServer();
    mount(server);
    await click('repair-create-open');
    expect(screen.queryByTestId('picker-open')).toBeNull();
    expect(screen.getByTestId('picker-unavailable')).toHaveTextContent(NOT_AVAILABLE_TEXT);
    fillDeviceAndIssue();
    typeCustomer('Walk In Person');
    await click('repair-create-save');
    expect(addRepairTicket).toHaveBeenCalledTimes(1);
    expect(made().customerId).toMatch(/^walk-in-\d+$/);
    expect(server.sent).toEqual([]);
  });

  it('REP-17. the draft writes no browser storage, moves no URL and logs nothing, and the page source reaches neither storage nor a log', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const before = { local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie, href: window.location.href };
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    await chooseServer(ada.id);
    await pickLocal('Local', 'Local Person');
    await click('repair-create-save');
    expect(addRepairTicket).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(before.local);
    expect(window.sessionStorage.length).toBe(before.session);
    expect(document.cookie).toBe(before.cookie);
    expect(window.location.href).toBe(before.href);
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/repairs$/);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'RepairTickets.tsx'), 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });

  it('REP-19. DA-202: a sign-out while the new ticket holds a server customer and the picker is CLOSED (no focus, no tab return) removes it at once with the notice — no limit text — the device and issue stay, a local customer can be picked instead, and nothing but the logout is sent', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada Server']);
    mount(server);
    await click('repair-create-open');
    fillDeviceAndIssue();
    await chooseServer(ada.id);
    expect(picker()).toBeNull();
    expect(limit()).toBeInTheDocument();
    const mark = server.sent.length;
    await act(async () => { await (net.current.session as TenantSessionClient).logout(); });
    expect(value()).toBeNull();
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(limit()).toBeNull();
    expect(device().value).toBe('Synthetic Phone 1');
    expect(issue().value).toBe('Cracked synthetic screen');
    await settle();
    expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    await pickLocal('Local', 'Local Person');
    expect(customerBox().value).toBe('Local Person');
    await act(async () => { await (net.current.session as TenantSessionClient).logout(); });
    expect(customerBox().value).toBe('Local Person'); // a local customer is not the session's: it stays
    expect(writes(server)).toEqual([]);
    expect(addRepairTicket).not.toHaveBeenCalled();
  });
});
