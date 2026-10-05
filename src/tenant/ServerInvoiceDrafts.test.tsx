// M7B-INVOICES-P1 — the Invoices page's "Server drafts" section in jsdom: the REAL section over the REAL tenant session,
// invoice drafts and customers clients, each wired to one fake tenant server at the network boundary (sessions, store
// discovery, the store's drafts with an idempotency ledger keyed like the server's, customer reads; synthetic tenants,
// stores, users, customers and drafts only — ids built at run time). Ordering is controlled with the fake's hold/release
// and its per-request scripts (no sleeps; the one rate-limit wait that is timed, SID-36's, runs on a fake clock); clocks
// and keys are injected. Every assertion about a request is made on what
// the fake recorded — the wire — and every assertion about an attempt on the hold store the section was given.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DRAFTS_TEXT, DRAFT_RULE_TEXT, HOLD_TEXT, NOT_SENT_TEXT, REFUSED_TEXT, ServerInvoiceDrafts, createDraftHoldStore, customerFallbackText, storeLabel,
  type DraftHoldStore, type ServerInvoiceDraftsProps,
} from './ServerInvoiceDrafts';
import { STORES_PATH, createInvoiceDraftsClient, draftPathOf, draftsPathOf, type StoreEntry } from './invoiceDraftsClient';
import { CUSTOMERS_PATH, createCustomersClient } from './customersClient';
import { TENANT_SESSION_PATHS, createTenantSessionClient } from './tenantSessionClient';
import { parseCustomerDirectoryQuery } from '../../server/runtime/customerDirectory';
import { sessionSubjectOf } from '../../server/runtime/sessions';

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const STORE_1 = uuid(0x51);
const STORE_2 = uuid(0x52);
const STORE_RO = uuid(0x53);
const at = (second: number, micros = 0): string => `2026-10-04T12:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.${String(micros).padStart(6, '0')}Z`;
const activeBody = (uid: string, csrfToken: string) =>
  ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });
// The server's continuation (server/runtime/invoiceDrafts.ts encodeInvoiceDraftCursor): the tag byte 0x01 and the anchor's
// 16 id bytes, unpadded base64url. The client accepts no other tag.
const cursorOf = (id: string): string => Buffer.concat([Buffer.from([0x01]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url');
const idOfCursor = (cursor: string): string | null => {
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.length !== 17 || bytes[0] !== 0x01) return null;
  const hex = bytes.subarray(1).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined }
interface User { uid: string; tenant: string; view: boolean }
interface Line { position: number; description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }
interface Draft { id: string; storeId: string; customerId: string; createdAt: string; subtotalCents: number; lines: Line[] }
type Kind = 'stores' | 'list' | 'get' | 'names' | 'create' | 'customers' | 'current';
type CreateScript = 'lose' | 'lose-before' | 503 | 'hold' | 'key-reused';

/** One fake tenant server. `cookie` is the session the browser presents. */
function fakeServer() {
  const users: Record<string, User> = { 'tok-a': { uid: 'uid-a', tenant: TENANT_A, view: true }, 'tok-b': { uid: 'uid-b', tenant: TENANT_B, view: true } };
  const sessions = new Map<string, { user: User; csrf: string }>();
  let sessionCount = 0;
  let draftCount = 0xd00;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers } });
  // A refusal as the server sends it: `{ error, requestId }` with the word the server pairs with the status (app.ts refuse,
  // sessions.ts, invoiceDrafts.ts) — the drafts client decides a read's refusal only in that exact envelope. A 429 carries
  // `retryAfter` (seconds, as text) when one is set.
  const WORDS: Record<number, string> = {
    400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited', 500: 'internal_error', 503: 'service_unavailable',
  };
  const refuse = (status: number, error = WORDS[status] ?? `e${status}`): Response =>
    reply(status, { error, requestId: 'req-synthetic' }, status === 429 && server.retryAfter !== null ? { 'retry-after': server.retryAfter } : {});
  const order = (x: Draft, y: Draft): number => (x.createdAt === y.createdAt ? (x.id < y.id ? 1 : -1) : x.createdAt < y.createdAt ? 1 : -1);
  const summaryOf = (d: Draft) => ({ id: d.id, customerId: d.customerId, status: 'draft', currency: 'USD', lineCount: d.lines.length, subtotalCents: d.subtotalCents, createdAt: d.createdAt });
  const detailOf = (d: Draft) => ({ draft: { id: d.id, storeId: d.storeId, customerId: d.customerId, status: 'draft', currency: 'USD', version: 1, createdAt: d.createdAt, subtotalCents: d.subtotalCents, lines: d.lines } });

  const server = {
    sent: [] as Sent[],
    users,
    cookie: null as string | null,
    stores: { 'uid-a': [] as StoreEntry[], 'uid-b': [] as StoreEntry[] } as Record<string, StoreEntry[]>,
    drafts: [] as Draft[],
    customers: new Map<string, { tenant: string; name: string }>(),
    keys: new Map<string, { fingerprint: string; response: { status: number; body: unknown; location?: string } }>(),
    creates: [] as CreateScript[], // what the next creates do, in order (then normally)
    detailStatus: [] as number[], // what the next draft GETs answer instead (500, 404…), in order
    listStatus: [] as number[], // what the next list GETs answer instead (401…), in order
    retryAfter: null as string | null, // the Retry-After a 429 carries
    nameStatus: new Map<string, number>(), // a customer read answered with this status
    nameInFlight: 0,
    nameMaxInFlight: 0,
    second: 100,
    hold: { stores: 0, list: 0, get: 0, names: 0, create: 0, customers: 0, current: 0 } as Record<Kind, number>,
    held: [] as Array<{ kind: Kind; url: string; release: (late?: Response) => void }>,
    seedCustomer(tenant: string, name: string): string {
      const id = uuid(0xc00 + server.customers.size + 1);
      server.customers.set(id, { tenant, name });
      return id;
    },
    seedDraft(storeId: string, customerId: string, createdAt: string, cents = 1250, lines = 1): Draft {
      const each = Array.from({ length: lines }, (_, i) => ({ position: i + 1, description: `Item ${i + 1}`, quantity: 1, unitPriceCents: cents, lineTotalCents: cents }));
      const draft: Draft = { id: uuid(++draftCount), storeId, customerId, createdAt, subtotalCents: cents * lines, lines: each };
      server.drafts.push(draft);
      return draft;
    },
    expire(): void { sessions.clear(); },
    /** Another tab signs `uid` in: a new session (and token) replaces the cookie this browser presents. */
    otherTab(uid: string): void {
      const user = Object.values(users).find((u) => u.uid === uid)!;
      sessionCount += 1;
      server.cookie = `session-${sessionCount}`;
      sessions.set(server.cookie, { user, csrf: `${'t'.repeat(40)}${String(sessionCount).padStart(3, '0')}` });
    },
    posts(): Sent[] { return server.sent.filter((r) => r.method === 'POST' && r.url.startsWith(STORES_PATH)); },
    async maybeHold(kind: Kind, url: string, answer: Response | (() => Response)): Promise<Response> {
      if (server.hold[kind] > 0) {
        server.hold[kind] -= 1;
        const late = await new Promise<Response | undefined>((release) => { server.held.push({ kind, url, release }); });
        if (late !== undefined) return late;
      }
      return typeof answer === 'function' ? answer() : answer;
    },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : undefined;
      server.sent.push({ method, url, headers, body });
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
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') { // every `ensure` reads it first (tenantSessionClient.ts)
        return server.maybeHold('current', url, () => (session === undefined ? refuse(401) : reply(200, activeBody(session.user.uid, session.csrf))));
      }
      const gate = (): Response | null => {
        if (session === undefined) return refuse(401);
        if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, 'forbidden');
        return null;
      };
      const path = url.split('?')[0];
      if (method === 'GET' && path === STORES_PATH) {
        const decided = gate() ?? reply(200, { stores: server.stores[session!.user.uid] ?? [] });
        return server.maybeHold('stores', url, decided);
      }
      if (method === 'GET' && path === CUSTOMERS_PATH) { // the picker's list read
        const decided = gate() ?? (() => {
          const query = parseCustomerDirectoryQuery(url);
          if (query === null) return refuse(400);
          const rows = [...server.customers.entries()].filter(([, c]) => c.tenant === session!.user.tenant).map(([id, c]) => ({ id, name: c.name }));
          return reply(200, { customers: rows.slice(0, 50), nextCursor: null });
        })();
        return server.maybeHold('customers', url, decided);
      }
      const customer = /^\/api\/v1\/customers\/([0-9a-f-]{36})$/.exec(url);
      if (method === 'GET' && customer !== null) {
        const refused = gate();
        server.nameInFlight += 1;
        server.nameMaxInFlight = Math.max(server.nameMaxInFlight, server.nameInFlight);
        try {
          return await server.maybeHold('names', url, () => {
            if (refused !== null) return refused;
            const status = server.nameStatus.get(customer[1]);
            if (status !== undefined) return refuse(status);
            const c = server.customers.get(customer[1]);
            return c === undefined || c.tenant !== session!.user.tenant ? refuse(404, 'not_found') : reply(200, { customer: { id: customer[1], name: c.name } });
          });
        } finally { server.nameInFlight -= 1; }
      }
      const storePath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoice-drafts(?:\/([0-9a-f-]{36}))?$/.exec(path);
      if (storePath !== null) {
        const [, storeId, draftId] = storePath;
        const refused = gate();
        const grant = refused === null ? server.stores[session!.user.uid]?.find((s) => s.id === storeId) : undefined;
        if (method === 'GET' && draftId === undefined) {
          return server.maybeHold('list', url, () => {
            if (refused !== null) return refused;
            if (grant === undefined) return refuse(403, 'forbidden');
            const scripted = server.listStatus.shift();
            if (scripted !== undefined) return refuse(scripted);
            const params = new URLSearchParams(url.split('?')[1] ?? '');
            const limit = Number(params.get('limit') ?? '20');
            const all = server.drafts.filter((d) => d.storeId === storeId).sort(order);
            const cursor = params.get('cursor');
            const anchorId = cursor === null ? null : idOfCursor(cursor);
            const anchor = anchorId === null ? null : all.findIndex((d) => d.id === anchorId);
            if (cursor !== null && (anchor === null || anchor < 0)) return refuse(400, 'invalid_request');
            const rest = anchor === null ? all : all.slice(anchor + 1);
            const page = rest.slice(0, limit);
            return reply(200, { drafts: page.map(summaryOf), nextCursor: rest.length > limit ? cursorOf(page[page.length - 1].id) : null });
          });
        }
        if (method === 'GET' && draftId !== undefined) {
          return server.maybeHold('get', url, () => {
            if (refused !== null) return refused;
            if (grant === undefined) return refuse(403, 'forbidden');
            const scripted = server.detailStatus.shift();
            if (scripted !== undefined) return refuse(scripted);
            const draft = server.drafts.find((d) => d.id === draftId && d.storeId === storeId);
            return draft === undefined ? refuse(404, 'not_found') : reply(200, detailOf(draft));
          });
        }
        if (method === 'POST' && draftId === undefined) {
          const script = server.creates.shift();
          if (script === 'lose-before') throw new TypeError('network');
          if (script === 503) return refuse(503, 'service_unavailable');
          const decide = (): Response => {
            if (refused !== null) return refused;
            if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
            if (grant === undefined || grant.readOnly) return refuse(403, 'forbidden');
            const key = headers.get('idempotency-key') ?? '';
            const fingerprint = `${storeId}\n${body}`;
            const known = server.keys.get(key);
            if (script === 'key-reused' || (known !== undefined && known.fingerprint !== fingerprint)) return refuse(422, 'idempotency_key_reused');
            if (known !== undefined) {
              const r = known.response;
              return reply(r.status, r.body, { 'idempotent-replayed': 'true', ...(r.location !== undefined ? { location: r.location } : {}) });
            }
            const parsed = JSON.parse(body ?? '{}') as { expectedTenant: string; customerId: string; lines: Array<{ description: string; quantity: number; unitPriceCents: number }> };
            if (parsed.expectedTenant !== grant.tenantId) return refuse(409, 'write_conflict'); // unsealed
            const c = server.customers.get(parsed.customerId);
            if (c === undefined || c.tenant !== grant.tenantId) {
              server.keys.set(key, { fingerprint, response: { status: 422, body: { error: 'customer_not_found' } } }); // sealed
              return reply(422, { error: 'customer_not_found' });
            }
            const lines = parsed.lines.map((l, i) => ({ position: i + 1, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.quantity * l.unitPriceCents }));
            const draft: Draft = { id: uuid(++draftCount), storeId, customerId: parsed.customerId, createdAt: at(server.second++, 123456), subtotalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0), lines };
            server.drafts.push(draft);
            const response = { status: 201, body: { draft: { id: draft.id, status: 'draft', currency: 'USD', lineCount: lines.length, subtotalCents: draft.subtotalCents } }, location: draftPathOf(storeId, draft.id) };
            server.keys.set(key, { fingerprint, response });
            return reply(201, response.body, { location: response.location });
          };
          const decided = decide();
          if (script === 'lose') throw new TypeError('network'); // committed, but the answer is lost
          if (script === 'hold') { server.hold.create += 1; }
          return server.maybeHold('create', url, decided);
        }
      }
      return refuse(404, 'not_found');
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

const store = (id: string, name: string | null, readOnly = false, tenantId = TENANT_A): StoreEntry => ({ id, tenantId, name, readOnly });
/** A server with uid-a's three stores (one read-only), in the server's order (name, unnamed last), and two customers of tenant A. */
function seeded() {
  const server = fakeServer();
  server.stores['uid-a'] = [store(STORE_RO, 'Kiosk', true), store(STORE_1, 'Main Street'), store(STORE_2, null)];
  const ada = server.seedCustomer(TENANT_A, 'Ada Customer');
  const bea = server.seedCustomer(TENANT_A, 'Bea Customer');
  return { server, ada, bea };
}

interface Rig { holds: DraftHoldStore; keys: string[]; clock: { mono: number; wall: number }; props: (over?: Partial<ServerInvoiceDraftsProps>) => ServerInvoiceDraftsProps }
function rig(server: Server, holds: DraftHoldStore = createDraftHoldStore()): Rig {
  const keys: string[] = [];
  const clock = { mono: 1_000, wall: Date.UTC(2026, 9, 4, 12) };
  const session = createTenantSessionClient({ fetch: server.fetch });
  const drafts = createInvoiceDraftsClient({ fetch: server.fetch });
  const customers = createCustomersClient({ fetch: server.fetch });
  const identity = { idToken: async (uid: string) => (uid === 'uid-a' ? 'tok-a' : uid === 'uid-b' ? 'tok-b' : null) };
  return {
    holds, keys, clock,
    props: (over = {}) => ({
      uid: 'uid-a', canCreate: true, canViewCustomers: true, handoff: null, onHandoffTaken: () => {}, session, drafts, customers, identity, holds,
      now: () => clock.mono, wallNow: () => clock.wall,
      newKey: () => { const k = ['5e1f0000', '1d2f', '4a6b', '9c8d', String(keys.length + 1).padStart(12, '0')].join('-'); keys.push(k); return k; },
      ...over,
    }),
  };
}

const realSetTimeout = globalThis.setTimeout; // the fake clock's test still drains promises on a real macrotask
const flush = () => act(async () => { await new Promise((r) => realSetTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
/** A fake clock for a rate limit's wait (its timer; the section's own clocks are the rig's), driven only by `advance` — never waitFor (as ServerCustomerPicker.test.tsx). */
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** waitFor for the fake clock's test: re-check after each real macrotask (bounded), never on a faked timer. */
const until = async (check: () => void) => {
  for (let i = 0; ; i++) {
    try { check(); return; } catch (error) { if (i >= 200) throw error; await flush(); }
  }
};
const user = () => userEvent.setup();
const click = async (testId: string) => { await user().click(screen.getByTestId(testId)); };
const storeSelect = () => screen.getByTestId('drafts-store') as HTMLSelectElement;
const rows = () => screen.queryAllByTestId('drafts-row');
const hold = () => screen.queryByTestId('drafts-hold');
const listReady = () => waitFor(() => expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'ready'));
const storesReady = () => waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'ready'));
async function showAndChoose(id: string) {
  if (screen.queryByTestId('drafts-show') !== null) await click('drafts-show');
  await storesReady();
  fireEvent.change(storeSelect(), { target: { value: id } });
  await listReady();
}
/** Open "New server draft", choose `customer` with the picker, fill `lines`. */
async function fillDraft(customer: string, lines: Array<[string, string, string]>) {
  await click('drafts-new');
  await click('picker-open');
  await waitFor(() => expect(screen.getByTestId('picker-state')).toHaveAttribute('data-phase', 'ready'));
  const row = screen.getAllByTestId('picker-row').find((r) => r.getAttribute('data-id') === customer)!;
  await user().click(within(row).getByTestId('picker-select'));
  await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', customer));
  for (let i = 1; i < lines.length; i++) await click('draft-new-add-line');
  for (const [i, [description, quantity, price]] of lines.entries()) {
    fireEvent.change(screen.getAllByTestId('draft-new-description')[i], { target: { value: description } });
    fireEvent.change(screen.getAllByTestId('draft-new-quantity')[i], { target: { value: quantity } });
    fireEvent.change(screen.getAllByTestId('draft-new-price')[i], { target: { value: price } });
  }
}
/** Save one line under a lost first send (it never reached the server), then close the dialog: the attempt is held unresolved in the section. */
async function heldInSection(server: Server, customer: string) {
  await fillDraft(customer, [['Fan', '1', '9.99']]);
  server.creates.push('lose-before');
  await click('draft-new-save');
  await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
  await click('draft-new-cancel');
}
const HOUR = 60 * 60_000;
const bodyOf = (tenant: string, customerId: string, lines: Array<[string, number, number]>) =>
  JSON.stringify({ expectedTenant: tenant, customerId, currency: 'USD', lines: lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity, unitPriceCents })) });
/** A programmatic focus target shows the file's focus-visible ring, never `focus:outline-none` (jsdom has no styles: the classes are what can be checked). */
const ringed = (node: HTMLElement): void => {
  expect(node).toHaveClass('focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-sky-700');
  expect(node).not.toHaveClass('focus:outline-none');
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Server drafts — store choice, list and reopen (M7B-INVOICES-P1)', () => {
  it('SID-01. nothing is read before "Show server drafts"; then the stores are listed by name or ID ending, none preselected, read-only marked', async () => {
    const { server } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await settle();
    expect(server.sent).toEqual([]);
    expect(screen.getByTestId('drafts-section')).toHaveTextContent('Server drafts');
    await click('drafts-show');
    await storesReady();
    const options = [...storeSelect().options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['', 'Choose a store…'], [STORE_RO, 'Kiosk (read-only)'], [STORE_1, 'Main Street'], [STORE_2, `Store, ID ending ${STORE_2.slice(-8)}`],
    ]);
    expect(storeSelect().value).toBe(''); // never preselected
    expect(screen.getByTestId('drafts-choose')).toHaveTextContent(DRAFTS_TEXT.chooseStore);
    expect(server.sent.filter((s) => s.url.includes('/invoice-drafts'))).toEqual([]);
    expect(storeLabel({ id: STORE_2, name: '   ' })).toBe(`Store, ID ending ${STORE_2.slice(-8)}`);
  });

  it('SID-02. even a single store is an explicit choice', async () => {
    const server = fakeServer();
    server.stores['uid-a'] = [store(STORE_1, 'Only Store')];
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    expect(storeSelect().value).toBe('');
    expect(screen.queryByTestId('drafts-list-state')).toBeNull();
    expect(screen.queryByTestId('drafts-new')).toBeNull();
  });

  it('SID-03. a store\'s drafts newest first: created time, customer name, lines and Draft subtotal formatted from cents; no amount owed, number or status wording', async () => {
    const { server, ada, bea } = seeded();
    server.seedDraft(STORE_1, ada, at(10), 1999, 2);
    server.seedDraft(STORE_1, bea, at(20, 5), 123456);
    server.seedDraft(STORE_2, ada, at(30)); // another store's: never shown here
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(screen.getAllByTestId('drafts-row-customer').map((n) => n.textContent)).toEqual(['Bea Customer', 'Ada Customer']));
    expect(screen.getAllByTestId('drafts-row-created').map((n) => n.textContent)).toEqual(['2026-10-04 12:00 UTC', '2026-10-04 12:00 UTC']);
    expect(screen.getAllByTestId('drafts-row-lines').map((n) => n.textContent)).toEqual(['1 line', '2 lines']);
    expect(screen.getAllByTestId('drafts-row-subtotal').map((n) => n.textContent)).toEqual(['Draft subtotal $1,234.56', 'Draft subtotal $39.98']);
    expect(screen.getByTestId('drafts-section').textContent).not.toMatch(/amount due|balance|invoice number|issued|paid|payment|tax|discount/i);
  });

  it('SID-04. Load more over equal timestamps: every draft exactly once in (time, id) order, and the request names only the anchor, never a time', async () => {
    const { server, ada } = seeded();
    const made = Array.from({ length: 25 }, () => server.seedDraft(STORE_1, ada, at(40, 777777)));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    expect(rows()).toHaveLength(20);
    await click('drafts-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual(made.map((d) => d.id).sort().reverse());
    expect(screen.queryByTestId('drafts-load-more')).toBeNull();
    const lists = server.sent.filter((s) => s.method === 'GET' && s.url.startsWith(draftsPathOf(STORE_1)));
    expect(lists.map((s) => s.url.split('?')[1].replace(/cursor=[A-Za-z0-9_-]{23}/, 'cursor=…'))).toEqual(['limit=20', 'limit=20&cursor=…']);
    expect(lists.every((s) => !/2026|T12|%3A/.test(s.url))).toBe(true);
  });

  it('SID-05. a read-only store lists and opens its drafts but offers no new one', async () => {
    const { server, ada } = seeded();
    const draft = server.seedDraft(STORE_RO, ada, at(5), 300, 2);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_RO);
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId('drafts-read-only')).toHaveTextContent(DRAFTS_TEXT.readOnly);
    expect(screen.queryByTestId('drafts-new')).toBeNull();
    await click('drafts-open'); // opened read-only, as at a writable store
    const view = await screen.findByTestId('draft-view');
    await waitFor(() => expect(within(view).getAllByTestId('draft-view-line')).toHaveLength(2));
    expect(within(view).getByTestId('draft-view-subtotal')).toHaveTextContent('Draft subtotal $6.00');
    expect(within(view).getByTestId('draft-view-store')).toHaveTextContent('Kiosk');
    expect(within(view).queryAllByRole('textbox')).toEqual([]);
    expect(server.sent.filter((s) => s.url === draftPathOf(STORE_RO, draft.id))).toHaveLength(1);
  });

  it('SID-06. a store change drops the earlier store\'s late answer; only the chosen store\'s rows are shown', async () => {
    const { server, ada } = seeded();
    const one = server.seedDraft(STORE_1, ada, at(5));
    const two = server.seedDraft(STORE_2, ada, at(6));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady();
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual([two.id]);
    expect(rows().map((r) => r.getAttribute('data-id'))).not.toContain(one.id);
  });

  it('SID-07. names: one read per distinct customer, at most three at a time, a missing one falls back; Customers View absent → no name read at all', async () => {
    const { server } = seeded();
    const ids = Array.from({ length: 6 }, (_, i) => server.seedCustomer(TENANT_A, `Person ${i}`));
    const gone = uuid(0xcff);
    for (let i = 0; i < 12; i++) server.seedDraft(STORE_1, i === 11 ? gone : ids[i % 6], at(50 + i));
    server.hold.names = 6;
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(server.held).toHaveLength(3));
    expect(server.nameInFlight).toBe(3);
    while (server.held.length > 0) { await act(async () => { server.held.shift()!.release(); }); await settle(); }
    await waitFor(() => expect(screen.getAllByTestId('drafts-row-customer')[0]).toHaveTextContent(customerFallbackText(gone)));
    const reads = server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`));
    expect(reads).toHaveLength(7); // six customers and the missing one, once each
    expect(new Set(reads.map((s) => s.url)).size).toBe(7);
    expect(server.nameMaxInFlight).toBeLessThanOrEqual(3);
    expect(screen.getAllByTestId('drafts-row-customer')[1]).toHaveTextContent('Person 4');
    cleanup();
    const quiet = seeded();
    quiet.server.seedDraft(STORE_1, quiet.ada, at(5));
    render(<ServerInvoiceDrafts {...rig(quiet.server).props({ canViewCustomers: false })} />);
    await showAndChoose(STORE_1);
    expect(screen.getByTestId('drafts-row-customer')).toHaveTextContent(customerFallbackText(quiet.ada));
    expect(quiet.server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`))).toEqual([]);
  });

  it('SID-08. a 403 or a 429 on a name stops the name reads — no read starts after it, only the three already out end — and never fails the list', async () => {
    for (const status of [403, 429]) {
      const { server } = seeded();
      const ids = Array.from({ length: 7 }, (_, i) => server.seedCustomer(TENANT_A, `Person ${i}`));
      for (const [i, id] of ids.entries()) { server.seedDraft(STORE_1, id, at(60 + i)); server.nameStatus.set(id, status); }
      server.hold.names = 3; // the three reads the section starts at once wait here
      render(<ServerInvoiceDrafts {...rig(server).props()} />);
      await showAndChoose(STORE_1);
      await waitFor(() => expect(server.held).toHaveLength(3));
      const reads = () => server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`));
      expect(reads()).toHaveLength(3);
      await act(async () => { server.held.shift()!.release(); }); // the first answer: the refusal
      await settle();
      expect(reads()).toHaveLength(3); // nothing started after it, though four names are still unread
      while (server.held.length > 0) { await act(async () => { server.held.shift()!.release(); }); await settle(); }
      await settle();
      expect(reads()).toHaveLength(3);
      expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'ready');
      expect(screen.getAllByTestId('drafts-row-customer').map((n) => n.textContent)).toEqual([...ids].reverse().map(customerFallbackText));
      cleanup();
    }
  });

  it('SID-09. reopen is read-only: the header, the ordered lines and the Draft subtotal; Escape closes it and focus returns to Open', async () => {
    const { server, ada } = seeded();
    const draft = server.seedDraft(STORE_1, ada, at(5), 250, 3);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const open = screen.getByTestId('drafts-open');
    await user().click(open);
    const view = await screen.findByTestId('draft-view');
    expect(view).toHaveAttribute('role', 'dialog');
    expect(view).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(within(view).getAllByTestId('draft-view-line')).toHaveLength(3));
    expect(within(view).getAllByTestId('draft-view-line').map((r) => r.textContent)).toEqual(['1Item 11$2.50$2.50', '2Item 21$2.50$2.50', '3Item 31$2.50$2.50']);
    expect(within(view).getByTestId('draft-view-subtotal')).toHaveTextContent('Draft subtotal $7.50');
    await waitFor(() => expect(within(view).getByTestId('draft-view-customer')).toHaveTextContent('Ada Customer'));
    expect(within(view).getByTestId('draft-view-store')).toHaveTextContent('Main Street');
    expect(within(view).queryAllByRole('textbox')).toEqual([]);
    expect(within(view).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    expect(view.textContent).not.toMatch(/amount due|balance|invoice number|issued|payment|tax|discount/i);
    expect(server.sent.filter((s) => s.url === draftPathOf(STORE_1, draft.id))).toHaveLength(1);
    await user().keyboard('{Escape}');
    await settle();
    expect(screen.queryByTestId('draft-view')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-open'));
  });

  it('SID-10. a draft that is gone says so; an unreadable name in the dialog falls back', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    server.nameStatus.set(ada, 403);
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.detailStatus.push(404);
    await click('drafts-open');
    await waitFor(() => expect(screen.getByTestId('draft-view-state')).toHaveTextContent(DRAFTS_TEXT.draftNotFound));
    await click('draft-view-close');
    await click('drafts-open');
    await waitFor(() => expect(screen.getByTestId('draft-view-customer')).toHaveTextContent(customerFallbackText(ada)));
  });
});

describe('Server drafts — a new draft (M7B-INVOICES-P1)', () => {
  it('SID-11. every invalid field is said (role=alert, aria-invalid, aria-describedby), the first takes focus, and nothing is sent and no key minted', async () => {
    const { server } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await click('drafts-new');
    const dialog = screen.getByTestId('draft-new');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.change(screen.getByTestId('draft-new-quantity'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '1.999' } });
    await click('draft-new-save');
    await settle();
    expect(screen.getByTestId('draft-new-customer-error')).toHaveTextContent(DRAFT_RULE_TEXT.customer);
    expect(screen.getByTestId('draft-new-customer-error')).toHaveAttribute('role', 'alert');
    for (const [id, text] of [['draft-new-description', DRAFT_RULE_TEXT.description], ['draft-new-quantity', DRAFT_RULE_TEXT.quantity], ['draft-new-price', DRAFT_RULE_TEXT.unitPrice]] as const) {
      const field = screen.getByTestId(id);
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAccessibleDescription(text);
    }
    expect(document.activeElement).toBe(screen.getByTestId('picker-open')); // the first invalid: the customer
    // The customer control itself is marked invalid and described by its error (not only the fieldset around it).
    expect(screen.getByTestId('picker-open')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('picker-open')).toHaveAccessibleDescription(DRAFT_RULE_TEXT.customer);
    expect(r.keys).toEqual([]);
    expect(server.posts()).toEqual([]);
  });

  it('SID-12. prices are exact cents: the live Draft subtotal of 3 × 0.10 is $0.30; a line or a sum over 2^53-1 cents is refused before a key exists', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Bolt', '3', '0.1'], ['Nut', '1', '0.2']]);
    expect(screen.getByTestId('draft-new-subtotal')).toHaveTextContent('Draft subtotal $0.50');
    // Only the amount is a live region (atomic): a change announces the new amount, never the label again.
    const amount = within(screen.getByTestId('draft-new-subtotal')).getByTestId('draft-new-subtotal-amount');
    expect(amount).toHaveTextContent(/^\$0\.50$/);
    expect(amount).toHaveAttribute('aria-live', 'polite');
    expect(amount).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByTestId('draft-new-subtotal')).not.toHaveAttribute('aria-live');
    fireEvent.change(screen.getAllByTestId('draft-new-price')[1], { target: { value: '90071992547409.91' } });
    expect(screen.getByTestId('draft-new-subtotal')).toHaveTextContent('Draft subtotal —');
    await click('draft-new-save');
    await settle();
    expect(screen.getByTestId('draft-new-subtotal-error')).toHaveTextContent(DRAFT_RULE_TEXT.subtotal);
    fireEvent.change(screen.getAllByTestId('draft-new-price')[1], { target: { value: '45035996273704.96' } });
    fireEvent.change(screen.getAllByTestId('draft-new-quantity')[1], { target: { value: '2' } });
    await click('draft-new-save');
    await settle();
    expect(screen.getAllByTestId('draft-new-price')[1]).toHaveAccessibleDescription(DRAFT_RULE_TEXT.total);
    expect(document.activeElement).toBe(screen.getAllByTestId('draft-new-price')[1]);
    expect(r.keys).toEqual([]);
    expect(server.posts()).toEqual([]);
  });

  it('SID-13. Save draft sends exactly one POST with the exact bytes; a double click sends no second; 201 closes the dialog, reads it back once and lists it', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['  Screen repair ', '1', '20'], ['Cable', '2', '2.75']]);
    expect(screen.getByTestId('draft-new-subtotal')).toHaveTextContent('Draft subtotal $25.50');
    await user().dblClick(screen.getByTestId('draft-new-save'));
    await waitFor(() => expect(screen.queryByTestId('draft-new')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    const posts = server.posts();
    expect(posts).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
    expect(posts[0].url).toBe(draftsPathOf(STORE_1));
    expect(posts[0].body).toBe(bodyOf(TENANT_A, ada, [['Screen repair', 1, 2000], ['Cable', 2, 275]]));
    expect(posts[0].headers.get('idempotency-key')).toBe(r.keys[0]);
    const made = server.drafts[server.drafts.length - 1];
    expect(server.sent.filter((s) => s.url === draftPathOf(STORE_1, made.id))).toHaveLength(1); // the one read-back
    await waitFor(() => expect(rows().map((n) => n.getAttribute('data-id'))).toEqual([made.id]));
    expect(r.holds.get('uid-a')).toBeUndefined();
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-new'));
  });

  it('SID-31. the list read after a save never disables New: focus goes back to New while that read is still out, and stays there', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.hold.list = 1; // the refresh the read-back starts waits here
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list']));
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'loading');
    expect(screen.getByTestId('drafts-new')).toBeEnabled();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-new'));
    await act(async () => { server.held.shift()!.release(); });
    await waitFor(() => expect(rows()).toHaveLength(1));
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('drafts-new'));
    expect(server.posts()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-32. one dialog at a time: an attempt settling while the reopen dialog is up opens no new draft beside it, nor does a press reaching New; the hand-over then waits for New', async () => {
    const { server, ada, bea } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose'); // committed; its answer is lost
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    // A hand-over waits while the attempt is live.
    view.rerender(<ServerInvoiceDrafts {...r.props({ handoff: { id: bea, name: 'Bea Customer' } })} />);
    await waitFor(() => expect(screen.getByTestId('drafts-handoff')).toHaveTextContent('Bea Customer'));
    server.creates.push('hold');
    await click('drafts-check-again');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    await click('drafts-open');
    await waitFor(() => expect(screen.getByTestId('draft-view-subtotal')).toBeInTheDocument());
    await act(async () => { server.held.shift()!.release(); }); // the replayed 201: created, nothing live any more
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    fireEvent.click(screen.getByTestId('drafts-new')); // a press that reaches New (jsdom does not implement inert)
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('data-testid'))).toEqual(['draft-view']);
    await click('draft-view-close');
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull(); // nothing opens on its own
    expect(screen.getByTestId('drafts-handoff')).toHaveTextContent('Bea Customer');
    await click('drafts-new');
    await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bea));
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('data-testid'))).toEqual(['draft-new']);
    expect(server.posts()).toHaveLength(2);
    expect(r.keys).toHaveLength(1);
  });

  it('SID-14. created, but the read-back fails: said so, and NO second POST', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.detailStatus.push(500);
    await click('draft-new-save');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.savedUnread));
    expect(server.posts()).toHaveLength(1);
    await settle();
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-15. a lost reply is held; only Check again re-sends — the same key and bytes to the same store — and the replayed 201 is created', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    expect(hold()).toHaveTextContent(HOLD_TEXT.unresolved);
    expect(screen.getByTestId('drafts-hold-note')).toHaveTextContent('No answer from the server.');
    expect(r.holds.get('uid-a')?.state).toBe('unresolved');
    await click('drafts-check-again');
    await waitFor(() => expect(screen.queryByTestId('draft-new')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    const posts = server.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toBe(posts[0].body);
    expect(posts[1].url).toBe(posts[0].url);
    expect(posts[1].headers.get('idempotency-key')).toBe(posts[0].headers.get('idempotency-key'));
    expect(r.keys).toHaveLength(1);
    expect(server.drafts.filter((d) => d.storeId === STORE_1)).toHaveLength(1); // one draft, not two
  });

  it('SID-16. repeated unknown and a 503 on Check again stay unresolved with the same key; each press is exactly one POST', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before', 'lose-before', 503);
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    for (const note of ['No answer from the server.', 'The server answered, but not with a result.']) {
      const before = server.posts().length;
      await click('drafts-check-again');
      await waitFor(() => expect(server.posts()).toHaveLength(before + 1));
      await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
      expect(screen.getByTestId('drafts-hold-note')).toHaveTextContent(note);
    }
    expect(new Set(server.posts().map((p) => p.headers.get('idempotency-key'))).size).toBe(1);
    expect(new Set(server.posts().map((p) => p.body)).size).toBe(1);
    expect(server.drafts).toHaveLength(0);
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.drafts).toHaveLength(1);
  });

  it('SID-17. refusals end the attempt with their own text and keep the form: customer_not_found (the customer cleared), write_conflict, key reused, denied', async () => {
    const main = (s: Server, change: Partial<StoreEntry>): void => {
      const i = s.stores['uid-a'].findIndex((x) => x.id === STORE_1);
      s.stores['uid-a'][i] = { ...s.stores['uid-a'][i], ...change };
    };
    const cases: Array<[string, (s: Server, ada: string) => void, string]> = [
      ['customer-not-found', (s, ada) => { s.customers.delete(ada); }, REFUSED_TEXT['customer-not-found']],
      ['conflict', (s) => { main(s, { tenantId: TENANT_B }); }, REFUSED_TEXT.conflict],
      ['key-reused', (s) => { s.creates.push('key-reused'); }, REFUSED_TEXT['key-reused']],
      ['denied', (s) => { main(s, { readOnly: true }); }, REFUSED_TEXT.denied],
    ];
    for (const [name, arrange, text] of cases) {
      const { server, ada } = seeded();
      const r = rig(server);
      render(<ServerInvoiceDrafts {...r.props()} />);
      await showAndChoose(STORE_1);
      await fillDraft(ada, [['Fan', '1', '9.99']]);
      arrange(server, ada);
      await click('draft-new-save');
      await waitFor(() => expect(screen.getByTestId('draft-new-status')).toHaveTextContent(text));
      expect(screen.getByTestId('draft-new-status')).toHaveAttribute('role', 'alert');
      expect(screen.getByTestId('draft-new-description')).toHaveValue('Fan'); // the form stays
      expect(r.holds.get('uid-a')).toBeUndefined();
      expect(hold()).toBeNull();
      if (name === 'customer-not-found') expect(screen.queryByTestId('picker-value')).toBeNull();
      else expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada);
      expect(server.posts()).toHaveLength(1);
      expect(server.drafts).toHaveLength(0);
      cleanup();
    }
  });

  it('SID-18. no timer, focus, tab return or Reconnect re-sends; Reconnect after a confirmed end is explicit and detaches the attempt (a new token)', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel'); // Cancel only hides the dialog
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    r.clock.mono += 60 * 60_000;
    r.clock.wall += 60 * 60_000;
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    await new Promise((res) => setTimeout(res, 50));
    await settle();
    expect(server.posts()).toHaveLength(1);
    const logins = server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.login).length;
    server.expire();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins); // no sign-in on its own
    await click('drafts-retry'); // Reconnect
    await storesReady();
    expect(server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.login)).toHaveLength(logins + 1);
    expect(hold()).toHaveAttribute('data-state', 'detached');
    expect(hold()).toHaveTextContent(HOLD_TEXT.detached);
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ csrf: null, body: '' }));
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-19. another tab\'s session (a token change) detaches the attempt, clears the store view and drops a read in flight; nothing is sent', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(storeSelect().value).toBe('');
    expect(rows()).toEqual([]);
    expect(hold()).toHaveAttribute('data-state', 'detached');
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-20. choosing another store never detaches or re-targets the attempt: Check again goes to its own store', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await listReady();
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.posts().map((p) => p.url)).toEqual([draftsPathOf(STORE_1), draftsPathOf(STORE_1)]);
    expect(server.drafts.map((d) => d.storeId)).toEqual([STORE_1]);
  });

  it('SID-21. a user change detaches the previous user\'s attempt (body cleared); it is never shown to the next user, nor checkable again', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-b' })} />);
    await settle();
    expect(hold()).toBeNull();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ csrf: null, body: '', state: 'unresolved' }));
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-a' })} />);
    await settle();
    expect(hold()).toHaveAttribute('data-state', 'detached');
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    await click('drafts-stop');
    expect(r.holds.get('uid-a')).toBeUndefined();
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-22. a late 201 after the section has gone still lands as created; the next section reads it back under the same session', async () => {
    const { server, ada } = seeded();
    const holds = createDraftHoldStore();
    const r = rig(server, holds);
    const first = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('hold');
    await click('draft-new-save');
    await waitFor(() => expect(server.held.filter((h) => h.kind === 'create')).toHaveLength(1));
    expect(holds.get('uid-a')?.state).toBe('sending');
    first.unmount(); // the page is left while the POST is out
    await act(async () => { server.held.find((h) => h.kind === 'create')!.release(); });
    await settle();
    expect(holds.get('uid-a')?.state).toBe('created');
    render(<ServerInvoiceDrafts {...r.props()} />);
    expect(hold()).toHaveAttribute('data-state', 'created');
    await click('drafts-show');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(holds.get('uid-a')).toBeUndefined();
    expect(server.posts()).toHaveLength(1);
  });

  it('SID-23. past the cutoff — the larger of monotonic and wall-clock elapsed, 23 hours — Check again sends nothing and the card says so', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    r.clock.mono += 60_000; // the monotonic clock barely moved (a suspended tab)…
    r.clock.wall += 23 * 60 * 60_000; // …the wall clock says 23 hours
    await click('drafts-check-again');
    await settle();
    expect(hold()).toHaveTextContent(HOLD_TEXT.tooOld);
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    expect(r.holds.get('uid-a')?.body).toBe('');
    expect(server.posts()).toHaveLength(1);
    cleanup();

    // The cutoff is judged AGAIN right before the POST: pressed in time, but the session confirmation it waits for is
    // held while both clocks pass 23 hours (a slow server, a suspended device) — the body goes and nothing is sent.
    for (const which of ['both', 'mono'] as const) {
      const late = seeded();
      const q = rig(late.server);
      render(<ServerInvoiceDrafts {...q.props()} />);
      await showAndChoose(STORE_1);
      await heldInSection(late.server, late.ada);
      q.clock.mono += 22 * HOUR; // under the cutoff when pressed
      q.clock.wall += 22 * HOUR;
      late.server.hold.current = 1; // Check again's session read waits here
      await click('drafts-check-again');
      await waitFor(() => expect(late.server.held.map((h) => h.kind)).toEqual(['current']));
      expect(hold()).toHaveAttribute('data-state', 'checking');
      q.clock.mono += 2 * HOUR; // past it while held: both clocks, or the monotonic one alone
      if (which === 'both') q.clock.wall += 2 * HOUR;
      await act(async () => { late.server.held.shift()!.release(); });
      await settle();
      expect(late.server.posts()).toHaveLength(1);
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      expect(hold()).toHaveTextContent(HOLD_TEXT.tooOld);
      expect(screen.queryByTestId('drafts-check-again')).toBeNull();
      expect(q.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'unresolved', body: '' }));
      cleanup();
    }
  });

  it('SID-33. the cutoff is the LARGER of monotonic and wall-clock elapsed: 23 hours on the monotonic clock alone sends nothing; just under 23 hours on both, Check again sends one POST with the same key and bytes', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    r.clock.mono += 23 * HOUR; // the monotonic clock says 23 hours…
    r.clock.wall += 60_000; // …the wall clock was set back (or stepped) and says a minute
    await click('drafts-check-again');
    await settle();
    expect(hold()).toHaveTextContent(HOLD_TEXT.tooOld);
    expect(r.holds.get('uid-a')?.body).toBe('');
    expect(server.posts()).toHaveLength(1);
    cleanup();

    const under = seeded();
    const q = rig(under.server);
    render(<ServerInvoiceDrafts {...q.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(under.server, under.ada);
    q.clock.mono += 23 * HOUR - 60_000; // 22 h 59 min on both clocks: still in time
    q.clock.wall += 23 * HOUR - 60_000;
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    const posts = under.server.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1].headers.get('idempotency-key')).toBe(posts[0].headers.get('idempotency-key'));
    expect(posts[1].body).toBe(posts[0].body);
    expect(q.keys).toHaveLength(1);
    expect(under.server.drafts).toHaveLength(1);
  });

  it('SID-34. Check again meets the session first: an ended session sends nothing ("Not checked", the views cleared, Reconnect offered); another session\'s token detaches the attempt and sends nothing', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    server.expire(); // no focus event: Check again is the first to meet the end
    await click('drafts-check-again');
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('drafts-hold-note')).toHaveTextContent(`Not checked. ${DRAFTS_TEXT.ended}`);
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(rows()).toEqual([]);
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    expect(server.posts()).toHaveLength(1);
    cleanup();

    const other = seeded();
    const q = rig(other.server);
    render(<ServerInvoiceDrafts {...q.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(other.server, other.ada);
    other.server.otherTab('uid-a'); // no focus event either: Check again is the first to see the new token
    await click('drafts-check-again');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'detached'));
    expect(screen.queryByTestId('drafts-check-again')).toBeNull();
    expect(q.holds.get('uid-a')).toEqual(expect.objectContaining({ csrf: null, body: '' }));
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    expect(other.server.posts()).toHaveLength(1);
  });

  it('SID-35. a read that meets the session end gives its busy state back: Reconnect is enabled after Load more finds the session ended, and after a list read answered 401', async () => {
    const { server, ada } = seeded();
    for (let i = 0; i < 25; i++) server.seedDraft(STORE_1, ada, at(100 + i));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.expire();
    await click('drafts-load-more'); // its session confirmation finds the session ended
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    await settle();
    expect(screen.getByTestId('drafts-retry')).toHaveTextContent('Reconnect');
    expect(screen.getByTestId('drafts-retry')).toBeEnabled();
    await click('drafts-retry');
    await storesReady();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    server.listStatus.push(401); // the session check passes; the list read itself answers 401
    await click('drafts-load-more');
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    await settle();
    expect(screen.getByTestId('drafts-retry')).toBeEnabled();
    await click('drafts-retry');
    await storesReady();
    expect(server.posts()).toEqual([]);
  });

  it('SID-36. a store chosen during a rate limit\'s wait says so (never a blank list) and offers Try again once the wait has passed', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const two = server.seedDraft(STORE_2, ada, at(6));
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    // The wait's timer runs on the fake clock from here, so only `advance` ends it: a stalled CPU cannot end it before
    // the assertions below (a real one-second timer could), and no user-event or waitFor runs while it is installed.
    fakeClock();
    server.retryAfter = '1';
    server.detailStatus.push(429); // a reopen read is rate limited: a one-second wait starts
    fireEvent.click(screen.getByTestId('drafts-open'));
    await until(() => expect(screen.getByTestId('draft-view-state')).toHaveAttribute('data-phase', 'rate-limited'));
    fireEvent.click(screen.getByTestId('draft-view-close'));
    const reads = server.sent.length;
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await settle();
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited');
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent('Too many requests. Wait 1 second, then try again.');
    expect(screen.getByTestId('drafts-list-retry')).toBeDisabled();
    await advance(999);
    expect(screen.getByTestId('drafts-list-retry')).toBeDisabled(); // still 1 ms before the wait has passed
    expect(server.sent).toHaveLength(reads); // nothing read during the wait
    await advance(1);
    expect(screen.getByTestId('drafts-list-retry')).toBeEnabled();
    expect(server.sent).toHaveLength(reads); // nor at its end: only the press reads
    vi.useRealTimers();
    await click('drafts-list-retry');
    await listReady();
    expect(rows().map((n) => n.getAttribute('data-id'))).toEqual([two.id]);
  });

  it('SID-24. a new draft is never sent under another session than the dialog\'s: the dialog\'s customer and store are re-confirmed and nothing is sent', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.otherTab('uid-a');
    await click('draft-new-save');
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull(); // the new generation closed it: its store was the old session's
    expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument();
    expect(r.keys).toEqual([]);
    expect(server.posts()).toEqual([]);
  });

  it('SID-25. the dialogs: inert page behind, Escape closes only the top one (the picker over the new draft), Tab wraps inside, focus comes back', async () => {
    const { server } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const opener = screen.getByTestId('drafts-new');
    await user().click(opener);
    const dialog = screen.getByTestId('draft-new');
    const appRoot = [...document.body.children].find((n) => n.contains(screen.getByTestId('drafts-section')))!;
    expect(appRoot).toHaveAttribute('inert');
    expect(document.activeElement).toBe(screen.getByTestId('draft-new-description'));
    await click('picker-open');
    await waitFor(() => expect(screen.getByTestId('picker-state')).toHaveAttribute('data-phase', 'ready'));
    await user().keyboard('{Escape}');
    expect(screen.queryByTestId('picker-dialog')).toBeNull();
    expect(screen.getByTestId('draft-new')).toBe(dialog); // still open
    const stops = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    stops[stops.length - 1].focus();
    await user().tab();
    expect(document.activeElement).toBe(stops[0]);
    await user().tab({ shift: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    await user().keyboard('{Escape}');
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    expect(appRoot).not.toHaveAttribute('inert');
    expect(document.activeElement).toBe(opener);
  });

  it('SID-39. focus never falls out of the new draft dialog: a line\'s Remove hands it to the neighbouring line; Save draft and Check again, disabled or removed by their own press, recover it inside without scrolling; Save says why an earlier attempt blocks it; Escape still closes', async () => {
    const { server, ada } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    // Focus never falls out of the open dialog when the user's own press removes or disables the control it is on, and
    // Escape keeps working. A line's Remove (its whole line goes) hands focus to the neighbouring line, where the user is:
    // the next line's Remove, then — one line left, its Remove disabled — that line's description.
    await fillDraft(ada, [['Fan', '1', '9.99'], ['Nut', '1', '1'], ['Bolt', '1', '2']]);
    const dialog = screen.getByTestId('draft-new');
    const inside = (): void => {
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect((document.activeElement as HTMLButtonElement).disabled ?? false).toBe(false);
    };
    await user().click(screen.getAllByTestId('draft-new-remove-line')[1]);
    await settle();
    expect(screen.getAllByTestId('draft-new-description').map((n) => (n as HTMLInputElement).value)).toEqual(['Fan', 'Bolt']);
    expect(document.activeElement).toBe(screen.getAllByTestId('draft-new-remove-line')[1]); // Bolt's, now "Remove line 2"
    inside();
    await user().keyboard('{Enter}'); // the same key again, on the Remove it landed on
    await settle();
    expect(screen.getAllByTestId('draft-new-line')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByTestId('draft-new-description'));
    expect(screen.getByTestId('draft-new-description')).toHaveValue('Fan');
    inside();
    // The recovery itself never scrolls: the dialog body scrolls, and the card and Save sit below the lines.
    const realFocus = HTMLElement.prototype.focus;
    const focused: Array<{ readonly node: HTMLElement; readonly options: FocusOptions | undefined }> = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      focused.push({ node: this, options });
      realFocus.call(this, options);
    });
    const recovered = (): Array<FocusOptions | undefined> => focused.filter((f) => f.node === screen.getByTestId('draft-new-description')).map((f) => f.options);
    // Save draft, disabled while it saves (no reason is given for that: it is this press):
    server.creates.push('hold');
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    await settle();
    expect(screen.getByTestId('draft-new-save')).toBeDisabled();
    expect(screen.getByTestId('draft-new-save')).not.toHaveAttribute('aria-describedby');
    inside();
    expect(recovered()).toEqual([{ preventScroll: true }]);
    const unknown = new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } });
    await act(async () => { server.held.shift()!.release(unknown); }); // committed, outcome unknown: held in the dialog
    await waitFor(() => expect(within(dialog).getByTestId('drafts-hold')).toHaveAttribute('data-state', 'unresolved'));
    // Disabled by the held attempt: Save says why.
    expect(screen.getByTestId('draft-new-save')).toBeDisabled();
    expect(screen.getByTestId('draft-new-save')).toHaveAccessibleDescription(HOLD_TEXT.saveBlocked);
    // Check again (its whole action row goes while the check runs), gated at the server:
    server.creates.push('hold');
    await user().click(within(dialog).getByTestId('drafts-check-again'));
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
    await settle();
    expect(within(dialog).queryByTestId('drafts-check-again')).toBeNull();
    inside();
    expect(recovered()).toEqual([{ preventScroll: true }, { preventScroll: true }]);
    await user().keyboard('{Escape}'); // still reaches the dialog
    await settle();
    expect(screen.queryByTestId('draft-new')).toBeNull();
    await act(async () => { server.held.shift()!.release(); }); // the replay: created
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.posts()).toHaveLength(2);
  });

  it('SID-26. a hand-over (id and name only) opens the section; the dialog confirms its own session and makes its own reference for the chosen store', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const taken = vi.fn();
    const view = render(<ServerInvoiceDrafts {...r.props({ onHandoffTaken: taken })} />);
    view.rerender(<ServerInvoiceDrafts {...r.props({ onHandoffTaken: taken, handoff: { id: ada, name: 'Ada Customer' } })} />);
    await storesReady();
    expect(taken).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('drafts-handoff')).toHaveTextContent('Ada Customer');
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(screen.getByTestId('draft-new')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada));
    fireEvent.change(screen.getByTestId('draft-new-description'), { target: { value: 'Fan' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '5' } });
    await click('draft-new-save');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.saved));
    expect(server.posts()[0].body).toBe(bodyOf(TENANT_A, ada, [['Fan', 1, 500]]));
  });

  it('SID-28. names: the three-read bound holds across pages (Load more while names are out), and Customers View lost hides the names at once', async () => {
    const { server } = seeded();
    const ids = Array.from({ length: 8 }, (_, i) => server.seedCustomer(TENANT_A, `Person ${i}`));
    for (let i = 0; i < 25; i++) server.seedDraft(STORE_1, ids[i < 20 ? i % 4 : 4 + (i % 4)], at(200 - i));
    server.hold.names = 8;
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(server.held).toHaveLength(3));
    await click('drafts-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    await settle();
    expect(server.held).toHaveLength(3); // the second page's names wait in the same queue
    while (server.held.length > 0) { await act(async () => { server.held.shift()!.release(); }); await settle(); }
    expect(server.nameMaxInFlight).toBe(3);
    expect(server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`))).toHaveLength(8);
    await waitFor(() => expect(screen.getAllByTestId('drafts-row-customer')[0]).toHaveTextContent('Person 0'));
    view.rerender(<ServerInvoiceDrafts {...r.props({ canViewCustomers: false })} />);
    expect(screen.getAllByTestId('drafts-row-customer')[0]).toHaveTextContent(customerFallbackText(ids[0]));
    expect(screen.getByTestId('drafts-section').textContent).not.toMatch(/Person \d/);
  });

  it('SID-29. a line\'s error stays with its line when another is removed; a subtotal-only error takes focus; after an unconfirmed save focus goes to the heading, not the disabled opener', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['First', '1', '1'], ['', '1', '1']]);
    await click('draft-new-save');
    await settle();
    expect(screen.getAllByTestId('draft-new-description')[1]).toHaveAttribute('aria-invalid', 'true');
    await user().click(screen.getAllByTestId('draft-new-remove-line')[0]);
    expect(screen.getAllByTestId('draft-new-description')).toHaveLength(1);
    expect(screen.getByTestId('draft-new-description')).toHaveValue('');
    expect(screen.getByTestId('draft-new-description')).toHaveAttribute('aria-invalid', 'true'); // its own error, kept
    fireEvent.change(screen.getByTestId('draft-new-description'), { target: { value: 'Big' } });
    fireEvent.change(screen.getByTestId('draft-new-price'), { target: { value: '90071992547409.91' } });
    await click('draft-new-add-line');
    const descriptions = screen.getAllByTestId('draft-new-description');
    fireEvent.change(descriptions[1], { target: { value: 'More' } });
    fireEvent.change(screen.getAllByTestId('draft-new-price')[1], { target: { value: '0.01' } });
    await click('draft-new-save');
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('draft-new-subtotal-error'));
    ringed(screen.getByTestId('draft-new-subtotal-error'));
    // The size error, the third such target, cannot be reached from the form (a valid draft's body stays near 55 KB, under
    // the 64 KiB bound: invoiceDraftsClient.ts DRAFT_BODY_MAX_BYTES), so its ring is checked in the source (as SID-27 reads it).
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'ServerInvoiceDrafts.tsx'), 'utf8');
    expect(source).toMatch(/data-testid="draft-new-size-error"[^\n]*className=\{`[^`\n]*\$\{focusRing\}`\}/);
    expect(source).not.toMatch(/data-testid="draft-new-size-error"[^\n]*focus:outline-none/);
    fireEvent.change(screen.getAllByTestId('draft-new-price')[0], { target: { value: '1' } });
    server.creates.push('lose-before');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    await click('draft-new-cancel');
    await settle();
    expect(screen.getByTestId('drafts-new')).toBeDisabled();
    expect(screen.getByTestId('drafts-new')).toHaveAccessibleDescription(NOT_SENT_TEXT.pending); // why it is disabled
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Server drafts' }));
    ringed(screen.getByRole('heading', { name: 'Server drafts' }));
    expect(r.keys).toHaveLength(1);
  });

  it('SID-30. a hand-over waiting for a store is dropped by a session change: it is never used under another session', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    view.rerender(<ServerInvoiceDrafts {...r.props({ handoff: { id: ada, name: 'Ada Customer' } })} />);
    await storesReady();
    expect(screen.getByTestId('drafts-handoff')).toBeInTheDocument();
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    await storesReady();
    expect(screen.queryByTestId('drafts-handoff')).toBeNull();
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull(); // "Choose a store." was answered by the choice
    expect(screen.queryByTestId('draft-new')).toBeNull(); // nothing opens on its own
    await click('drafts-new');
    expect(screen.queryByTestId('picker-value')).toBeNull(); // no customer carried over
    // The alert's other end: the session ends while it is up. The end is what the section says now, and the Reconnect's
    // token is a FIRST token (not a "connection changed"), so the alert stays gone after it too.
    server.otherTab('uid-a');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-connection-changed')).toBeInTheDocument());
    server.expire();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    await click('drafts-retry'); // Reconnect
    await storesReady();
    await settle();
    expect(storeSelect()).toHaveValue('');
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    expect(server.posts()).toEqual([]);
  });

  it('SID-37. the attempt\'s card outside the dialog: Check again, Stop tracking and Dismiss hand focus to the section heading; it never falls to <body>', async () => {
    const { server, ada } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    const heading = screen.getByRole('heading', { name: 'Server drafts' });
    // Every DOM change is checked: focus on <body> at any of them (a removed control's) is recorded.
    const fell: string[] = [];
    const watch = new MutationObserver(() => { if (document.activeElement === null || document.activeElement === document.body) fell.push(hold()?.getAttribute('data-state') ?? 'gone'); });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      await heldInSection(server, ada);
      await settle();
      expect(document.activeElement).toBe(heading); // the dialog's own return (SID-29)
      fell.length = 0; // from here only the card's presses move focus
      // Check again: its whole row goes while the check runs (held at the server), and comes back when it stays unknown.
      server.creates.push('hold');
      await user().click(screen.getByTestId('drafts-check-again'));
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['create']));
      await settle();
      expect(hold()).toHaveAttribute('data-state', 'checking');
      expect(screen.queryByTestId('drafts-check-again')).toBeNull();
      expect(document.activeElement).toBe(heading);
      const unknown = new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } });
      await act(async () => { server.held.shift()!.release(unknown); });
      await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
      expect(screen.getByTestId('drafts-check-again')).toBeEnabled();
      expect(document.activeElement).toBe(heading);
      // Stop tracking: the card goes.
      await user().click(screen.getByTestId('drafts-stop'));
      await settle();
      expect(hold()).toBeNull();
      expect(document.activeElement).toBe(heading);
      expect(fell).toEqual([]);
      // Dismiss: a check refused (the key reused) ends the attempt with its own card; Dismiss takes the card away.
      await heldInSection(server, ada);
      await settle();
      fell.length = 0;
      server.creates.push('key-reused');
      await user().click(screen.getByTestId('drafts-check-again'));
      await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'refused'));
      expect(document.activeElement).toBe(heading);
      await user().click(screen.getByTestId('drafts-hold-dismiss'));
      await settle();
      expect(hold()).toBeNull();
      expect(document.activeElement).toBe(heading);
      expect(fell).toEqual([]);
    } finally {
      watch.disconnect();
    }
    expect(server.posts()).toHaveLength(4); // two saves and one check each: nothing re-sent on its own
  });

  it('SID-38. "The store connection changed … Choose a store." is said only while true: not after a stores reload that failed, and once a retried reload has the stores', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { server } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.otherTab('uid-a');
    server.hold.stores = 1; // the new generation's stores read is held, then answered 503
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['stores']));
    expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'loading');
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull(); // nothing to choose from yet
    const outage = new Response(JSON.stringify({ error: 'service_unavailable', requestId: 'r' }), { status: 503, headers: { 'content-type': 'application/json' } });
    await act(async () => { server.held.shift()!.release(outage); });
    await waitFor(() => expect(screen.getByTestId('drafts-stores-state')).toHaveAttribute('data-phase', 'unavailable'));
    await settle();
    expect(screen.queryByTestId('drafts-store')).toBeNull();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull(); // no store list: "Choose a store." would be false
    await click('drafts-retry');
    await storesReady();
    expect(screen.getByTestId('drafts-connection-changed')).toHaveTextContent(DRAFTS_TEXT.connection); // true now
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    expect(screen.queryByTestId('drafts-connection-changed')).toBeNull();
    expect(server.posts()).toEqual([]);
  });

  it('SID-40. a sign-out or a user change takes the session token from a SETTLED attempt too: a created one (then "saved under an earlier connection", never read back) and a refused one', async () => {
    const { server, ada } = seeded();
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    // Created, its read-back held at the server: the created attempt sits in the store with the token it was sent with.
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.hold.get = 1;
    await click('draft-new-save');
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['get']));
    const created = r.holds.get('uid-a')!;
    expect(created).toEqual(expect.objectContaining({ state: 'created', body: '', storeId: STORE_1 }));
    expect(created.csrf).not.toBeNull();
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: null })} />); // sign-out
    await settle();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'created', csrf: null, body: '', storeId: STORE_1, draftId: created.draftId }));
    await act(async () => { server.held.shift()!.release(); }); // the read-back answers a section that is gone: dropped
    await settle();
    // The same user again: the attempt is no session's now, so it is not read back — it says "saved earlier" and goes.
    view.rerender(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await waitFor(() => expect(screen.getByTestId('drafts-notice')).toHaveTextContent(DRAFTS_TEXT.savedEarlier));
    expect(r.holds.get('uid-a')).toBeUndefined();
    expect(server.sent.filter((s) => s.method === 'GET' && s.url === draftPathOf(STORE_1, created.draftId!))).toHaveLength(1); // the dropped one only
    // Refused: a check refused (the key reused) leaves a refused attempt on the card until Dismiss; a user change scrubs it.
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await listReady();
    await heldInSection(server, ada);
    server.creates.push('key-reused');
    await click('drafts-check-again');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'refused'));
    expect(r.holds.get('uid-a')?.csrf).not.toBeNull();
    view.rerender(<ServerInvoiceDrafts {...r.props({ uid: 'uid-b' })} />); // a user change
    await settle();
    expect(r.holds.get('uid-a')).toEqual(expect.objectContaining({ state: 'refused', refusal: 'key-reused', csrf: null, body: '' }));
    expect(server.posts()).toHaveLength(3); // the two saves and the second one's check: nothing re-sent on its own
  });

  it('SID-41. Customers View lost while a list read is out: its late answer queues no customer read (the hint is read as it is when the answer lands)', async () => {
    const { server, ada, bea } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    server.seedDraft(STORE_1, bea, at(6));
    const r = rig(server);
    const view = render(<ServerInvoiceDrafts {...r.props()} />);
    await click('drafts-show');
    await storesReady();
    server.hold.list = 1;
    fireEvent.change(storeSelect(), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['list']));
    view.rerender(<ServerInvoiceDrafts {...r.props({ canViewCustomers: false })} />);
    await act(async () => { server.held.shift()!.release(); });
    await listReady();
    await settle();
    expect(screen.getAllByTestId('drafts-row-customer').map((n) => n.textContent)).toEqual([customerFallbackText(bea), customerFallbackText(ada)]);
    expect(server.sent.filter((s) => s.url.startsWith(`${CUSTOMERS_PATH}/`))).toEqual([]);
  });

  it('SID-42. a rate limit\'s wait: Check again says why it is disabled while the wait lasts and not after; a store chosen 1.5 s into a 5 s wait says the whole seconds left', async () => {
    const { server, ada } = seeded();
    server.seedDraft(STORE_1, ada, at(5));
    const r = rig(server);
    render(<ServerInvoiceDrafts {...r.props()} />);
    await showAndChoose(STORE_1);
    await heldInSection(server, ada);
    await settle();
    expect(screen.getByTestId('drafts-check-again')).toBeEnabled();
    expect(screen.getByTestId('drafts-check-again')).not.toHaveAttribute('aria-describedby');
    // The wait's timer runs on the fake clock from here (as SID-36): only `advance` ends it.
    fakeClock();
    server.retryAfter = '5';
    server.detailStatus.push(429); // a reopen read is rate limited: a five-second wait starts at the rig's monotonic 1000
    fireEvent.click(screen.getByTestId('drafts-open'));
    await until(() => expect(screen.getByTestId('draft-view-state')).toHaveTextContent('Too many requests. Wait 5 seconds, then try again.'));
    fireEvent.click(screen.getByTestId('draft-view-close'));
    await settle();
    expect(screen.getByTestId('drafts-check-again')).toBeDisabled();
    expect(screen.getByTestId('drafts-check-again')).toHaveAccessibleDescription(HOLD_TEXT.waiting);
    r.clock.mono += 1_500; // 3.5 s of the wait left: said as 4 whole seconds, never as the Retry-After again
    fireEvent.change(storeSelect(), { target: { value: STORE_2 } });
    await settle();
    expect(screen.getByTestId('drafts-list-state')).toHaveAttribute('data-phase', 'rate-limited');
    expect(screen.getByTestId('drafts-list-state')).toHaveTextContent('Too many requests. Wait 4 seconds, then try again.');
    await advance(5_000);
    expect(screen.getByTestId('drafts-check-again')).toBeEnabled();
    expect(screen.getByTestId('drafts-check-again')).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('drafts-check-wait')).toBeNull();
    vi.useRealTimers();
    expect(server.posts()).toHaveLength(1); // nothing sent by the wait or its end
  });

  it('SID-27. nothing reaches browser storage or a log, and the sources reach neither', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { server, ada } = seeded();
    render(<ServerInvoiceDrafts {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await fillDraft(ada, [['Fan', '1', '9.99']]);
    server.creates.push('lose');
    await click('draft-new-save');
    await waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('s'.repeat(40)); // no session token in the DOM
    for (const file of ['ServerInvoiceDrafts.tsx', 'invoiceDraftsClient.ts']) {
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|history\.|location\.(href|search|hash)/);
    }
  });
});
