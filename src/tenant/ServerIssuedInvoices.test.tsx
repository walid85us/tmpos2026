// M7B-INVOICES-ISSUE-P2 — the Invoices page's "Issued invoices" section in jsdom: the store choice and the owner's issuing
// settings (commit A, SII-01..44), the issued list and one issued invoice (commit B, SII-45..60 and its review fixes
// SII-61..68, over the fake's issued store: pages newest number first with the server's cursor, the detail, a refused role). The REAL section over the REAL tenant session, drafts (its store list) and issuing clients, each wired
// to one fake tenant server at the network boundary: sessions (a reauthentication login renews a stale sign-in), store
// discovery and one store's issuing settings with an idempotency ledger keyed like the server's (key, store, exact bytes;
// a sealed 409 write_conflict and the 200 replay under their key; the tenant precondition, a read-only store's 404 and a
// stale sign-in's 403 step_up_required record nothing), the owner rule (a manager is refused 403). Synthetic tenants,
// stores and users only, ids built at run time. Ordering is controlled with the fake's hold/release and its per-request
// scripts (no sleeps; the one timed wait runs on a fake clock); the monotonic and wall clocks and the keys are injected.
// Every assertion about a request is made on what the fake recorded — the wire.
import { readFileSync } from 'node:fs';
import { StrictMode } from 'react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ISSUED_TEXT, LIST_TEXT, SETTINGS_RULE_TEXT, SETTINGS_TEXT, ServerIssuedInvoices, VIEW_TEXT, type ServerIssuedInvoicesProps } from './ServerIssuedInvoices';
import { createInvoiceIssuingClient, issuingSettingsPathOf, type IssuedSummary } from './invoiceIssuingClient';
import { STORES_PATH, createInvoiceDraftsClient, type StoreEntry } from './invoiceDraftsClient';
import { TENANT_SESSION_PATHS, createTenantSessionClient } from './tenantSessionClient';
import type { ShopIdentity } from './ServerCustomerLevels';
import { pickerWaitText } from './ServerCustomerPicker';
import { sessionSubjectOf } from '../../server/runtime/sessions';

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const STORE_1 = uuid(0x51);
const STORE_2 = uuid(0x52);
const STORE_RO = uuid(0x53);
const HOUR = 60 * 60_000;
const activeBody = (uid: string, csrfToken: string) => ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });

/** One request as it reached the fake: `signal` is the fetch's own, so a test sees whether the page cancelled it. */
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined; readonly signal: AbortSignal | null }
interface User { uid: string; tenant: string; role: 'owner' | 'manager' }
type View = { storeId: string; version: number; configured: true; legalName: string; storeName: string; postalAddress: string; taxRegistrationId: string | null; tax: { mode: 'none' } | { mode: 'exclusive_rate'; rateMilliPercent: number } };
type Kind = 'stores' | 'settings' | 'put' | 'current' | 'list' | 'detail';
type TaxWire = { mode: 'none' } | { mode: 'exclusive_rate'; rateMilliPercent: number };
type LineWire = { position: number; description: string; quantity: number; unitPriceCents: number; lineTotalCents: number };
/** One issued invoice as the fake stores it (commit B): what the list summarizes and the detail answers. */
interface Issued {
  id: string; number: number; sourceDraftId: string; customerId: string; customerName: string; issuedAt: string;
  seller: { legalName: string; storeName: string; postalAddress: string; taxRegistrationId: string | null }; lines: LineWire[]; tax: TaxWire;
}
/** What the next PUTs do: lose the answer after deciding (committed), lose the request, answer a status in the chain's envelope, or a whole answer. */
type PutScript = 'lose' | 'lose-before' | number | Response;

function fakeServer() {
  const users: Record<string, User> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, role: 'owner' }, 'tok-m': { uid: 'uid-m', tenant: TENANT_A, role: 'manager' }, 'tok-b': { uid: 'uid-b', tenant: TENANT_B, role: 'owner' },
  };
  const sessions = new Map<string, { user: User; csrf: string; fresh: boolean }>();
  let sessionCount = 0;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers } });
  const WORDS: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited', 503: 'service_unavailable' };
  const refuse = (status: number, error = WORDS[status] ?? `e${status}`): Response =>
    reply(status, { error, requestId: 'req-synthetic' }, status === 429 && server.retryAfter !== null ? { 'retry-after': server.retryAfter } : {});
  const login = (user: User, fresh: boolean): Response => {
    sessionCount += 1;
    server.cookie = `session-${sessionCount}`;
    sessions.set(server.cookie, { user, csrf: `${'s'.repeat(40)}${String(sessionCount).padStart(3, '0')}`, fresh });
    return reply(200, activeBody(user.uid, sessions.get(server.cookie)!.csrf));
  };
  const server = {
    sent: [] as Sent[],
    cookie: null as string | null,
    stores: { 'uid-a': [] as StoreEntry[], 'uid-m': [] as StoreEntry[], 'uid-b': [] as StoreEntry[] } as Record<string, StoreEntry[]>,
    settings: new Map<string, View>(),
    keys: new Map<string, { fingerprint: string; status: number; body: unknown }>(),
    puts: [] as PutScript[],
    getStatus: [] as Array<number | Response>, // what the next settings GETs answer instead
    issued: new Map<string, Issued[]>(), // store -> its issued invoices (served newest number first)
    issuedDenied: new Set<string>(), // users whose role lacks the issued reads (Invoices View AND Customers View)
    listStatus: [] as Array<number | Response>, // what the next list GETs answer instead
    detailStatus: [] as Array<number | Response>, // what the next detail GETs answer instead
    currentStatus: [] as number[],
    loginStatus: [] as number[], // what the next logins answer instead (in the chain's envelope): nothing is signed in
    retryAfter: null as string | null,
    staleLogins: false, // a plain login's sign-in is older than the recent-auth window (a reauthentication's never is)
    hold: { stores: 0, settings: 0, put: 0, current: 0, list: 0, detail: 0 } as Record<Kind, number>,
    held: [] as Array<{ kind: Kind; url: string; release: (late?: Response) => void }>,
    puts_(): Sent[] { return server.sent.filter((r) => r.method === 'PUT'); },
    reads(storeId?: string): Sent[] { return server.sent.filter((r) => r.method === 'GET' && r.url.startsWith('/api/v1/issuing-settings/') && (storeId === undefined || r.url === issuingSettingsPathOf(storeId))); },
    logins(): Sent[] { return server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login); },
    /** The issued-list reads (path and query), of one store when given. */
    lists(storeId?: string): string[] {
      return server.sent.filter((r) => r.method === 'GET' && /^\/api\/v1\/stores\/[^/]+\/invoices(\?|$)/.test(r.url) && (storeId === undefined || r.url.startsWith(`${STORES_PATH}/${storeId}/invoices?`))).map((r) => r.url);
    },
    /** The issued-invoice reads (detail paths) that reached the fake, as sent. */
    detailRequests(): Sent[] { return server.sent.filter((r) => r.method === 'GET' && /^\/api\/v1\/stores\/[^/]+\/invoices\/[^/?]+$/.test(r.url)); },
    details(): string[] { return server.detailRequests().map((r) => r.url); },
    /** Every request that is not a session, store-list or settings read: what commit B must never send on its own. */
    writes(): string[] { return server.sent.filter((r) => r.method !== 'GET').filter((r) => !r.url.startsWith('/api/v1/session')).map((r) => `${r.method} ${r.url}`); },
    /** Another writer saved a new version (another tab, the owner elsewhere). */
    bump(storeId: string, over: Partial<View> = {}): View {
      const was = server.settings.get(storeId);
      const next: View = { storeId, version: (was?.version ?? 0) + 1, configured: true, legalName: 'Other Seller LLC', storeName: 'Other Name', postalAddress: '9 Elsewhere', taxRegistrationId: null, tax: { mode: 'none' }, ...was, ...over };
      next.version = (was?.version ?? 0) + 1;
      server.settings.set(storeId, next);
      return next;
    },
    expire(): void { sessions.clear(); },
    otherTab(uid: string): void { login(Object.values(users).find((u) => u.uid === uid)!, true); },
    async maybeHold(kind: Kind, url: string, answer: () => Response): Promise<Response> {
      if (server.hold[kind] > 0) {
        server.hold[kind] -= 1;
        const late = await new Promise<Response | undefined>((release) => { server.held.push({ kind, url, release }); });
        if (late !== undefined) return late;
      }
      return answer();
    },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : undefined;
      server.sent.push({ method, url, headers, body, signal: init.signal ?? null });
      if (url === TENANT_SESSION_PATHS.login && method === 'POST') {
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403);
        const scripted = server.loginStatus.shift();
        if (scripted !== undefined) return refuse(scripted);
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return refuse(401);
        return login(user, headers.get('x-tmpos-reauthenticate') === '1' || !server.staleLogins);
      }
      const session = server.cookie === null ? undefined : sessions.get(server.cookie);
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') {
        const scripted = server.currentStatus.shift();
        if (scripted !== undefined) return refuse(scripted);
        return server.maybeHold('current', url, () => (session === undefined ? refuse(401) : reply(200, activeBody(session.user.uid, session.csrf))));
      }
      if (url === TENANT_SESSION_PATHS.logout) { if (server.cookie !== null) sessions.delete(server.cookie); return new Response(null, { status: 204 }); }
      const gate = (): Response | null => {
        if (session === undefined) return refuse(401);
        if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, 'forbidden');
        return null;
      };
      if (method === 'GET' && url === STORES_PATH) return server.maybeHold('stores', url, () => gate() ?? reply(200, { stores: server.stores[session!.user.uid] ?? [] }));
      const listPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\?(.*)$/.exec(url);
      const detailPath = /^\/api\/v1\/stores\/([0-9a-f-]{36})\/invoices\/([0-9a-f-]{36})$/.exec(url);
      if (method === 'GET' && (listPath !== null || detailPath !== null)) {
        const kind: Kind = listPath !== null ? 'list' : 'detail';
        return server.maybeHold(kind, url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const scripted = (kind === 'list' ? server.listStatus : server.detailStatus).shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          const storeId = (listPath ?? detailPath)![1];
          if (server.issuedDenied.has(session!.user.uid) || !server.stores[session!.user.uid]?.some((s) => s.id === storeId)) return refuse(403, 'forbidden');
          const all = [...(server.issued.get(storeId) ?? [])].sort((a, b) => b.number - a.number);
          if (detailPath !== null) {
            const found = all.find((i) => i.id === detailPath[2]);
            return found === undefined ? refuse(404, 'not_found') : reply(200, detailOf(found));
          }
          const query = new URLSearchParams(listPath![2]);
          const limit = Number(query.get('limit') ?? '20');
          const cursor = query.get('cursor');
          const start = cursor === null ? 0 : all.findIndex((i) => cursorOf(i.id) === cursor) + 1;
          if (start === 0 && cursor !== null) return refuse(400, 'invalid_request'); // an anchor this store does not hold
          const page = all.slice(start, start + limit);
          return reply(200, { invoices: page.map(summaryOf), nextCursor: start + limit < all.length ? cursorOf(page[page.length - 1].id) : null });
        });
      }
      const settingsPath = /^\/api\/v1\/issuing-settings\/([0-9a-f-]{36})$/.exec(url);
      if (settingsPath === null) return refuse(404);
      const storeId = settingsPath[1];
      const grant = (u: User) => server.stores[u.uid]?.find((s) => s.id === storeId);
      if (method === 'GET') {
        return server.maybeHold('settings', url, () => {
          const refused = gate();
          if (refused !== null) return refused;
          const scripted = server.getStatus.shift();
          if (scripted !== undefined) return typeof scripted === 'number' ? refuse(scripted) : scripted;
          if (session!.user.role !== 'owner') return refuse(403, 'forbidden'); // the owner rule
          if (grant(session!.user) === undefined) return refuse(404, 'not_found');
          return reply(200, { issuingSettings: server.settings.get(storeId) ?? { storeId, version: 0, configured: false } });
        });
      }
      if (method !== 'PUT') return refuse(404);
      const script = server.puts.shift();
      if (script === 'lose-before') throw new TypeError('network');
      if (typeof script === 'number') return refuse(script);
      if (script instanceof Response) return script;
      const decide = (): Response => {
        const refused = gate();
        if (refused !== null) return refused;
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, 'forbidden');
        if (session!.user.role !== 'owner') return refuse(403, 'forbidden');
        if (!session!.fresh) return refuse(403, 'step_up_required'); // before any key: nothing acquired
        const key = headers.get('idempotency-key') ?? '';
        const fingerprint = `${session!.user.uid}\n${storeId}\n${body}`;
        const known = server.keys.get(key);
        if (known !== undefined && known.fingerprint !== fingerprint) return refuse(422, 'idempotency_key_reused');
        if (known !== undefined) return reply(known.status, known.body, { 'idempotent-replayed': 'true' });
        const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
        expect(Object.keys(parsed)).toEqual(['expectedTenant', 'expectedVersion', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax']);
        const store = grant(session!.user);
        if (store === undefined || parsed.expectedTenant !== store.tenantId) return parsed.expectedTenant !== session!.user.tenant ? refuse(409, 'write_conflict') : refuse(404, 'not_found');
        if (store.readOnly) return refuse(404, 'not_found');
        const seal = (status: number, sealed: unknown): Response => { server.keys.set(key, { fingerprint, status, body: sealed }); return reply(status, sealed); };
        if ((server.settings.get(storeId)?.version ?? 0) !== parsed.expectedVersion) return seal(409, { error: 'write_conflict' });
        const view = { storeId, version: (parsed.expectedVersion as number) + 1, configured: true as const, legalName: parsed.legalName as string, storeName: parsed.storeName as string,
          postalAddress: parsed.postalAddress as string, taxRegistrationId: parsed.taxRegistrationId as string | null, tax: parsed.tax as View['tax'] };
        server.settings.set(storeId, view);
        return seal(200, { issuingSettings: view });
      };
      const decided = decide();
      if (script === 'lose') throw new TypeError('network'); // committed, but the answer is lost
      return server.maybeHold('put', url, () => decided);
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

/** The server's continuation for a page ending at `id` (invoiceIssuing.ts encodeIssuedInvoiceCursor). */
const cursorOf = (id: string): string => Buffer.concat([Buffer.from([0x04]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url');
/** The amounts a subtotal derives under a tax setting (doc 12 §10.8, BigInt), as the wire shows them. */
function amountsFor(subtotal: number, tax: TaxWire) {
  if (tax.mode === 'none') return { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'none', description: 'No tax calculated' }, totalCents: subtotal };
  const amount = Number((BigInt(subtotal) * BigInt(tax.rateMilliPercent) + 50_000n) / 100_000n);
  return { currency: 'USD', subtotalCents: subtotal, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: tax.rateMilliPercent, amountCents: amount }, totalCents: subtotal + amount };
}
const subtotalOf = (i: Issued): number => i.lines.reduce((n, l) => n + l.lineTotalCents, 0);
const summaryOf = (i: Issued) => ({
  id: i.id, number: i.number, sourceDraftId: i.sourceDraftId, customerId: i.customerId, customerName: i.customerName, currency: 'USD',
  totalCents: amountsFor(subtotalOf(i), i.tax).totalCents, issuedAt: i.issuedAt, status: 'issued', snapshotVersion: 1,
});
const detailOf = (i: Issued) => ({
  invoice: {
    id: i.id, number: i.number, status: 'issued', snapshotVersion: 1, issuedAt: i.issuedAt, sourceDraft: { id: i.sourceDraftId, version: 1 },
    seller: i.seller, issuingSettingsVersion: 1, customer: { id: i.customerId, name: i.customerName, version: 1 }, lines: i.lines, amounts: amountsFor(subtotalOf(i), i.tax),
  },
});
const line = (position: number, description: string, quantity: number, unitPriceCents: number): LineWire => ({ position, description, quantity, unitPriceCents, lineTotalCents: quantity * unitPriceCents });
const SELLER = Object.freeze({ legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1' as string | null });
/** Issued invoice `n` (number `n`) of a store: its own ids and second, one line of 1999 cents at 8.875 % unless `over` says otherwise. */
const invoice = (n: number, over: Partial<Issued> = {}): Issued => ({
  id: uuid(0x1a00 + n), number: n, sourceDraftId: uuid(0xd400 + n), customerId: uuid(0xc5), customerName: 'Ada Customer',
  issuedAt: `2026-10-16T21:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.123456Z`,
  seller: { ...SELLER }, lines: [line(1, 'Screen repair', 1, 1999)], tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over,
});
/** `count` invoices numbered 1..count at `storeId`. */
const issueAt = (server: Server, storeId: string, count: number, over: (n: number) => Partial<Issued> = () => ({})): Issued[] => {
  const made = Array.from({ length: count }, (_, i) => invoice(i + 1, over(i + 1)));
  server.issued.set(storeId, made);
  return made;
};

const store = (id: string, name: string | null, readOnly = false, tenantId = TENANT_A): StoreEntry => ({ id, tenantId, name, readOnly });
function seeded() {
  const server = fakeServer();
  server.stores['uid-a'] = [store(STORE_RO, 'Kiosk', true), store(STORE_1, 'Main Street'), store(STORE_2, null)];
  server.stores['uid-m'] = [store(STORE_1, 'Main Street')];
  server.stores['uid-b'] = [store(uuid(0x61), 'B Store', false, TENANT_B)];
  return server;
}

interface Rig { keys: string[]; clock: { mono: number; wall: number }; reauth: Array<string | null>; props: (over?: Partial<ServerIssuedInvoicesProps>) => ServerIssuedInvoicesProps }
function rig(server: Server): Rig {
  const keys: string[] = [];
  const reauth: Array<string | null> = [];
  const clock = { mono: 1_000, wall: Date.UTC(2026, 9, 16, 12) };
  const session = createTenantSessionClient({ fetch: server.fetch });
  const issuing = createInvoiceIssuingClient({ fetch: server.fetch });
  const drafts = createInvoiceDraftsClient({ fetch: server.fetch });
  const tokens: Record<string, string> = { 'uid-a': 'tok-a', 'uid-m': 'tok-m', 'uid-b': 'tok-b' };
  const identity: ShopIdentity = {
    idToken: async (uid) => tokens[uid] ?? null,
    reauthMethod: () => 'password',
    reauthenticate: async (uid, password) => { reauth.push(password); return password === 'correct horse' ? tokens[uid] ?? null : null; },
  };
  return {
    keys, clock, reauth,
    props: (over = {}) => ({
      uid: 'uid-a', session, issuing, drafts, identity, now: () => clock.mono, wallNow: () => clock.wall,
      newKey: () => { const k = ['5e1f0000', '1d2f', '4a6b', '9c8d', String(keys.length + 1).padStart(12, '0')].join('-'); keys.push(k); return k; },
      ...over,
    }),
  };
}

const realSetTimeout = globalThis.setTimeout;
const flush = () => act(async () => { await new Promise((r) => realSetTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const until = async (check: () => void) => {
  for (let i = 0; ; i++) {
    try { check(); return; } catch (error) { if (i >= 200) throw error; await flush(); }
  }
};
const user = () => userEvent.setup();
const click = async (testId: string) => { await user().click(screen.getByTestId(testId)); };
const tid = (testId: string) => screen.getByTestId(testId);
const storesReady = () => waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready'));
const panelPhase = () => screen.queryByTestId('issued-settings-state')?.getAttribute('data-phase') ?? 'none';
const panelReady = () => waitFor(() => expect(panelPhase()).toBe('ready'));
const status = () => tid('issued-settings-status');
const attemptState = () => screen.queryByTestId('issued-settings-attempt')?.getAttribute('data-state') ?? 'none';
async function showAndChoose(id: string) {
  if (screen.queryByTestId('issued-show') !== null) await click('issued-show');
  await storesReady();
  fireEvent.change(tid('issued-store') as HTMLSelectElement, { target: { value: id } });
}
async function openSettings(id = STORE_1) {
  await showAndChoose(id);
  await click('issued-settings-open');
  await waitFor(() => expect(panelPhase()).not.toBe('loading'));
}
const type = (testId: string, value: string) => fireEvent.change(tid(testId), { target: { value } });
/** Fill every field of the form (an exclusive rate unless `mode` says none). */
function fill(over: { legal?: string; store?: string; address?: string; taxId?: string; mode?: 'rate' | 'none'; rate?: string } = {}) {
  type('issued-settings-legal-name', over.legal ?? 'Example Repairs LLC');
  type('issued-settings-store-name', over.store ?? 'Main Street');
  type('issued-settings-postal-address', over.address ?? '1 Main St\nSpringfield');
  type('issued-settings-tax-id', over.taxId ?? '');
  fireEvent.click(tid(over.mode === 'none' ? 'issued-settings-tax-none' : 'issued-settings-tax-rate'));
  if (over.mode !== 'none') type('issued-settings-rate', over.rate ?? '8.875');
}
const BODY = (version: number, tax: string, taxId: string | null = null) =>
  `{"expectedTenant":"${TENANT_A}","expectedVersion":${version},"legalName":"Example Repairs LLC","storeName":"Main Street","postalAddress":"1 Main St\\nSpringfield","taxRegistrationId":${taxId === null ? 'null' : `"${taxId}"`},"tax":${tax}}`;
const RATE_8875 = '{"mode":"exclusive_rate","rateMilliPercent":8875}';
const focusEvents = async () => { await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }); await settle(); };
/** A refusal in the chain's envelope, for a held request's late answer or a scripted one. */
const chain = (status: number, error: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error, requestId: 'req-synthetic' }), { status, headers: { 'content-type': 'application/json', ...headers } });
/** The texts a control's aria-describedby names, joined. */
const describedBy = (testId: string): string =>
  (tid(testId).getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
/** What the fake recorded from index `from` on, as "METHOD url". */
const sentFrom = (server: Server, from: number): string[] => server.sent.slice(from).map((s) => `${s.method} ${s.url}`);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Issued invoices — the section and the store choice (M7B-INVOICES-ISSUE-P2)', () => {
  it('SII-01. nothing is read before "Show issued invoices" — not on mount, a focus or a tab return; then the stores are listed by name or ID ending, none preselected, read-only marked, and choosing one reads no settings', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await focusEvents();
    expect(server.sent).toEqual([]);
    expect(tid('issued-section')).toHaveTextContent('Issued invoices');
    await click('issued-show');
    await storesReady();
    const select = tid('issued-store') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a store…', 'Kiosk (read-only)', 'Main Street', `Store, ID ending ${STORE_2.slice(-8)}`]);
    fireEvent.change(select, { target: { value: STORE_1 } });
    await settle();
    expect(server.reads()).toHaveLength(0);
    expect(tid('issued-settings-open')).toHaveAttribute('aria-expanded', 'false');
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-02. a user without a uid sees nothing; the section is one per UID — another user\'s section starts over and shows nothing of the first', async () => {
    const server = seeded();
    const r = rig(server);
    const view = render(<ServerIssuedInvoices {...r.props({ uid: null })} />);
    expect(screen.queryByTestId('issued-section')).toBeNull();
    view.rerender(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    view.rerender(<ServerIssuedInvoices {...r.props({ uid: 'uid-b' })} />);
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(screen.getByTestId('issued-show')).toBeInTheDocument();
    expect(server.puts_()).toHaveLength(0);
  });
});

describe('Issued invoices — the owner\'s issuing settings (M7B-INVOICES-ISSUE-P2, AC-02/AC-03)', () => {
  it('SII-03. an unconfigured store (version 0) shows empty fields with NO tax mode chosen and the rate disabled — nothing filled in from this browser; one GET on open, no PUT', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    expect(server.reads(STORE_1)).toHaveLength(1);
    expect(server.reads(STORE_1)[0].headers.get('x-tmpos-session-csrf')).toMatch(/^s{40}\d{3}$/);
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.unconfigured);
    for (const id of ['legal-name', 'store-name', 'postal-address', 'tax-id', 'rate']) expect(tid(`issued-settings-${id}`)).toHaveValue('');
    expect(tid('issued-settings-tax-rate')).not.toBeChecked();
    expect(tid('issued-settings-tax-none')).not.toBeChecked();
    expect(tid('issued-settings-rate')).toBeDisabled();
    expect(tid('issued-settings-no-tax-note')).toHaveTextContent(SETTINGS_TEXT.noTax);
    expect(SETTINGS_TEXT.noTax).toMatch(/owner's own choice: the product does not check whether tax applies/);
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-04. Save sends ONE PUT of the exact bytes (the store\'s tenant, the version read, 8.875 as 8875) under one new key; "Saved" only after a fresh read finds that version with those values', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.hold.settings = 1; // the read-back
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(server.puts_()).toHaveLength(1);
    const put = server.puts_()[0];
    expect(put.body).toBe(BODY(0, RATE_8875));
    expect(put.headers.get('idempotency-key')).toBe(r.keys[0]);
    expect(put.headers.get('x-tmpos-csrf')).toBe('1');
    expect(status()).toHaveTextContent(SETTINGS_TEXT.readingBack(1));
    expect(status()).not.toHaveTextContent(/^Saved:/);
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(status()).toHaveAttribute('data-tone', 'saved');
    expect(server.reads(STORE_1)).toHaveLength(2); // the open, then the read-back
    expect(tid('issued-settings-rate')).toHaveValue('8.875');
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(1));
    expect(r.keys).toHaveLength(1);
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-05. "No tax calculated" sends exactly {"mode":"none"} (the rate field ignored), and an explicit 0 stays a real rate — read back as "0" under Exclusive rate, never as none', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill({ mode: 'none' });
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()[0].body).toBe(BODY(0, '{"mode":"none"}'));
    expect(tid('issued-settings-tax-none')).toBeChecked();
    fireEvent.click(tid('issued-settings-tax-rate'));
    type('issued-settings-rate', '0');
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(2)));
    expect(server.puts_()[1].body).toBe(BODY(1, '{"mode":"exclusive_rate","rateMilliPercent":0}'));
    expect(tid('issued-settings-tax-rate')).toBeChecked();
    expect(tid('issued-settings-rate')).toHaveValue('0');
    expect(server.settings.get(STORE_1)?.tax).toEqual({ mode: 'exclusive_rate', rateMilliPercent: 0 });
  });

  it('SII-06. an invalid form sends NOTHING (no session check, no key): each field says its own rule, marked invalid and described by it, and the first invalid field takes focus', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    const before = server.sent.length;
    type('issued-settings-legal-name', '   ');
    type('issued-settings-store-name', 'x'.repeat(121));
    type('issued-settings-postal-address', 'Line one\n\nLine three');
    type('issued-settings-tax-id', 'x'.repeat(65));
    await click('issued-settings-save');
    await settle();
    expect(server.sent.length).toBe(before);
    expect(r.keys).toEqual([]);
    for (const [id, rule] of [['legal-name', SETTINGS_RULE_TEXT.legalName], ['store-name', SETTINGS_RULE_TEXT.storeName], ['postal-address', SETTINGS_RULE_TEXT.postalAddress], ['tax-id', SETTINGS_RULE_TEXT.taxRegistrationId]] as const) {
      expect(tid(`issued-settings-${id}`)).toHaveAttribute('aria-invalid', 'true');
      expect(tid(`issued-settings-${id}-error`)).toHaveTextContent(rule);
      expect(tid(`issued-settings-${id}`).getAttribute('aria-describedby')).toContain(`issued-settings-${id}-error`);
    }
    expect(tid('issued-settings-tax-mode-error')).toHaveTextContent(SETTINGS_RULE_TEXT.taxMode); // no default tax mode
    expect(document.activeElement).toBe(tid('issued-settings-legal-name'));
    fill({ rate: '8.8755' });
    await click('issued-settings-save');
    await settle();
    expect(tid('issued-settings-rate-error')).toHaveTextContent(SETTINGS_RULE_TEXT.rate);
    expect(server.sent.length).toBe(before);
    type('issued-settings-legal-name', 'Fixed');
    expect(screen.queryByTestId('issued-settings-legal-name-error')).toBeNull(); // editing a field clears its own error
  });

  it('SII-07. a configured store fills the form from the server only (the rate as its exact digits), and a manager is refused: ONE fresh session check, then the owner-only text — no form, no loop, nothing written', async () => {
    const server = seeded();
    server.settings.set(STORE_1, { storeId: STORE_1, version: 4, configured: true, legalName: 'Seller', storeName: 'Shop', postalAddress: 'A\nB', taxRegistrationId: 'TX', tax: { mode: 'exclusive_rate', rateMilliPercent: 500 } });
    const r = rig(server);
    const view = render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    expect(tid('issued-settings-legal-name')).toHaveValue('Seller');
    expect(tid('issued-settings-postal-address')).toHaveValue('A\nB');
    expect(tid('issued-settings-rate')).toHaveValue('0.5');
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(4));
    view.unmount();
    const manager = rig(server);
    render(<ServerIssuedInvoices {...manager.props({ uid: 'uid-m' })} />);
    const reads = server.reads().length;
    const mark = server.sent.length;
    await openSettings();
    await waitFor(() => expect(panelPhase()).toBe('denied'));
    const refusedAt = server.sent.findIndex((s, i) => i >= mark && s.method === 'GET' && s.url === issuingSettingsPathOf(STORE_1));
    expect(tid('issued-settings-state')).toHaveTextContent(SETTINGS_TEXT.denied);
    expect(tid('issued-settings-state')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('issued-settings-legal-name')).toBeNull();
    expect(server.reads().length - reads).toBe(1); // one read, never asked again on its own
    // after the 403: exactly ONE fresh session check (a read, not a login), and nothing else
    expect(server.sent.slice(refusedAt + 1).map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    await focusEvents();
    expect(server.reads().length - reads).toBe(1);
    expect(server.puts_()).toHaveLength(0);
    expect(manager.keys).toEqual([]);
  });

  it('SII-08. a read-only store\'s settings can be read but offer no Save: the fields are disabled and say why', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings(STORE_RO);
    await panelReady();
    expect(tid('issued-settings-read-only')).toHaveTextContent(SETTINGS_TEXT.readOnly);
    expect(screen.queryByTestId('issued-settings-save')).toBeNull();
    expect(tid('issued-settings-legal-name')).toBeDisabled();
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-09. a version conflict (sealed 409) keeps the edits and offers "Load current version": an explicit read that keeps them, shows what the server holds and moves the base; the next Save is a NEW key at that version', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.bump(STORE_1, { legalName: 'Elsewhere LLC' }); // another writer, after this form loaded version 0
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.conflict));
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC'); // the edits are kept
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.conflictBlocked);
    await click('issued-settings-save'); // blocked: nothing sent
    expect(server.puts_()).toHaveLength(1);
    const reads = server.reads().length;
    await click('issued-settings-load-current');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.loadedCurrent(1)));
    expect(server.reads().length - reads).toBe(1);
    expect(tid('issued-settings-server-now')).toHaveTextContent('Elsewhere LLC');
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC');
    expect(server.puts_()).toHaveLength(1); // a read, never a save
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(2)));
    expect(server.puts_()[1].body).toBe(BODY(1, RATE_8875));
    expect(server.puts_()[1].headers.get('idempotency-key')).toBe(r.keys[1]);
    expect(r.keys[1]).not.toBe(r.keys[0]);
  });

  it('SII-10. a confirmed PUT whose read-back fails says so and is NEVER sent again; one that finds a newer version says that; Refresh only reads', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.getStatus.push(503);
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.unread(1)));
    expect(status()).not.toHaveTextContent(/^Saved:/);
    await settle();
    expect(server.puts_()).toHaveLength(1);
    await click('issued-settings-refresh');
    await panelReady();
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(1));
    expect(server.puts_()).toHaveLength(1);
    // A save whose read-back finds a newer version (another writer right after it).
    type('issued-settings-store-name', 'Main Street');
    server.hold.settings = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.bump(STORE_1, { storeName: 'Later Name' });
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.newer(2, 3)));
    expect(tid('issued-settings-store-name')).toHaveValue('Later Name');
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-11. a stale sign-in (403 step_up_required, no key acquired) shows the sign-in group; an explicit sign-in renews the session, re-reads the settings and says "press Save" — nothing is saved until Save is pressed again', async () => {
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    expect(status()).toHaveTextContent(SETTINGS_TEXT.stepUp);
    expect(document.activeElement).toBe(tid('issued-settings-reauth-password'));
    expect(server.keys.size).toBe(0); // nothing recorded
    type('issued-settings-reauth-password', 'wrong');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.reauthFailed));
    expect(server.logins().filter((l) => l.headers.get('x-tmpos-reauthenticate') === '1')).toHaveLength(0);
    const reads = server.reads().length;
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    expect(server.logins().filter((l) => l.headers.get('x-tmpos-reauthenticate') === '1')).toHaveLength(1);
    expect(server.reads().length - reads).toBe(1); // the settings read again under the renewed session
    expect(screen.queryByTestId('issued-settings-reauth-group')).toBeNull();
    expect(document.activeElement).toBe(tid('issued-settings-save'));
    await focusEvents();
    await settle();
    expect(server.puts_()).toHaveLength(1); // never saved on its own after the sign-in
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC');
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(2);
    expect(server.puts_()[1].body).toBe(server.puts_()[0].body);
    expect(server.puts_()[1].headers.get('idempotency-key')).not.toBe(server.puts_()[0].headers.get('idempotency-key'));
    expect(r.reauth).toEqual(['wrong', 'correct horse']);
  });

  it('SII-12. a version that moved while the owner signed in again is a conflict after the sign-in — the save waits for "Load current version"', async () => {
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.bump(STORE_1);
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.conflict));
    expect(tid('issued-settings-load-current')).toBeInTheDocument();
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(server.puts_()).toHaveLength(1);
  });
});

describe('Issued invoices — an unconfirmed settings write (M7B-INVOICES-ISSUE-P2, AC-02, AC-08)', () => {
  it('SII-13. a lost answer leaves the write UNRESOLVED with the form locked (editing cannot change the held body); "Check again" sends the byte-identical body under the SAME key and token, and its replay is then read back', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose'); // committed, the answer lost
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(tid('issued-settings-attempt')).toHaveTextContent(SETTINGS_TEXT.unresolved);
    expect(tid('issued-settings-legal-name')).toBeDisabled();
    fireEvent.change(tid('issued-settings-legal-name'), { target: { value: 'Changed While Held' } });
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.saveBlocked);
    await click('issued-settings-save');
    expect(server.puts_()).toHaveLength(1);
    await click('issued-settings-check-again');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    const [first, second] = server.puts_();
    expect(second.body).toBe(first.body);
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
    expect(second.headers.get('x-tmpos-session-csrf')).toBe(first.headers.get('x-tmpos-session-csrf'));
    expect(r.keys).toHaveLength(1);
    expect(server.settings.get(STORE_1)?.version).toBe(1); // saved once
    expect(screen.queryByTestId('issued-settings-attempt')).toBeNull();
  });

  it('SII-14. request_in_progress and a 503 stay unresolved; past 23 hours from the FIRST send — the larger of monotonic and wall-clock elapsed, judged at the press and again just before sending — Check again sends nothing', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push(503);
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.puts.push(new Response(JSON.stringify({ error: 'request_in_progress', requestId: 'r' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent('still working on it'));
    expect(attemptState()).toBe('unresolved');
    r.clock.wall += 23 * HOUR; // the wall clock alone crosses it
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(server.puts_()).toHaveLength(2);
    expect(screen.queryByTestId('issued-settings-check-again')).toBeNull(); // the body is gone: nothing can be re-sent
    // Judged again just before sending: the cutoff passed during the press's session check.
    cleanup();
    const late = seeded();
    const r2 = rig(late);
    render(<ServerIssuedInvoices {...r2.props()} />);
    await openSettings();
    fill();
    late.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r2.clock.mono += 23 * HOUR - 1;
    late.hold.current = 1;
    await click('issued-settings-check-again');
    await waitFor(() => expect(late.held).toHaveLength(1));
    r2.clock.mono += 1;
    late.held.shift()!.release();
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(late.puts_()).toHaveLength(1);
  });

  it('SII-15. "Stop tracking" sends nothing, reads the settings afresh (the server\'s truth replaces the form), and the next Save is a NEW key at the version read', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose'); // it did commit
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    const reads = server.reads().length;
    await click('issued-settings-stop');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.stopped));
    await panelReady();
    expect(server.reads().length - reads).toBe(1);
    expect(tid('issued-settings-version')).toHaveTextContent(SETTINGS_TEXT.version(1)); // what the lost answer would have said
    expect(server.puts_()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Issuing settings' }));
    type('issued-settings-store-name', 'Renamed');
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(2)));
    expect(server.puts_()[1].headers.get('idempotency-key')).toBe(r.keys[1]);
    expect(JSON.parse(server.puts_()[1].body ?? '{}').expectedVersion).toBe(1);
  });

  it('SII-16. a store change closes the panel and drops an unresolved write (its key, body and token): only a note that it could not be confirmed stays; reopening reads afresh and revives nothing', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(tid('issued-detached')).toHaveTextContent(SETTINGS_TEXT.detached);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    expect(screen.queryByTestId('issued-settings-attempt')).toBeNull();
    expect(tid('issued-settings-legal-name')).toHaveValue(''); // the server's (version 0), not the held body
    await focusEvents();
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-17. a sign-out (onSessionEnd) while a write is unresolved clears the panel at once; focus and a tab return never sign in; only Reconnect does, and nothing is re-sent', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await act(async () => { await r.props().session!.logout(); });
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    expect(tid('issued-detached')).toBeInTheDocument();
    const logins = server.logins().length;
    await focusEvents();
    expect(server.logins()).toHaveLength(logins);
    await click('issued-retry'); // Reconnect
    await storesReady();
    expect(server.logins()).toHaveLength(logins + 1);
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-18. a session ended on the server (401) ends the section; a later focus asks no login; another tab\'s token is a new generation that drops the panel and says the connection changed', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.otherTab('uid-a'); // a new token for the same user
    await focusEvents();
    await waitFor(() => expect(screen.queryByTestId('issued-settings')).toBeNull());
    await storesReady();
    expect(tid('issued-connection-changed')).toHaveTextContent(ISSUED_TEXT.connection);
    expect((tid('issued-store') as HTMLSelectElement).value).toBe('');
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    const logins = server.logins().length;
    server.expire();
    await click('issued-settings-refresh');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    await focusEvents();
    expect(server.logins()).toHaveLength(logins); // a confirmed end: no sign-in on its own
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-19. late answers change nothing: a settings read outrun by a store change, a PUT whose store was changed before it answered (no "Saved", no read-back), a read-back after a sign-out', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    server.hold.settings = 1;
    await click('issued-settings-open');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    fill();
    server.hold.put = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    const reads = server.reads().length;
    server.held.shift()!.release();
    await settle();
    expect(server.reads()).toHaveLength(reads); // no read-back for a dropped attempt
    expect(screen.queryByText(/^Saved:/)).toBeNull();
    // A read-back out when a sign-out begins: its late answer is dropped.
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    type('issued-settings-store-name', 'Again');
    server.hold.settings = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(screen.queryByText(/^Saved:/)).toBeNull();
    expect(tid('issued-notice')).toHaveTextContent(SETTINGS_TEXT.savedEnded(2)); // confirmed, not read back: still said
  });

  it('SII-20. a 429 starts one wait: Save and Check again are held back with their reason, and the timer only gives them back — it sends nothing', async () => {
    const server = seeded();
    server.retryAfter = '30';
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    fakeClock();
    server.puts.push(429);
    fireEvent.click(tid('issued-settings-check-again'));
    await until(() => { expect(attemptState()).toBe('unresolved'); expect(tid('issued-settings-check-again')).toHaveAttribute('aria-disabled', 'true'); }); // a 429 never erases an uncertain attempt
    expect(tid('issued-settings-attempt-note')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-settings-check-again')).toHaveAccessibleDescription(SETTINGS_TEXT.checkWaiting);
    fireEvent.click(tid('issued-settings-check-again'));
    await flush();
    const sent = server.puts_().length;
    await advance(31_000);
    await until(() => expect(tid('issued-settings-check-again')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.puts_()).toHaveLength(sent); // the countdown re-enables; it never submits
    expect(sent).toBe(2);
  });

  it('SII-21. no PUT ever leaves on its own: mount, focus, a tab return, timers, closing and reopening the panel, a denial\'s fresh check, Reconnect and a renewed sign-in all send none', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await focusEvents();
    await openSettings();
    fill();
    await click('issued-settings-open'); // closed
    await click('issued-settings-open'); // reopened: the server's values again (nothing typed survives)
    await panelReady();
    expect(tid('issued-settings-legal-name')).toHaveValue('');
    fill();
    await click('issued-settings-save'); // the one PUT: refused for a stale sign-in
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await focusEvents();
    await new Promise((res) => setTimeout(res, 30));
    await settle();
    server.expire();
    await click('issued-settings-refresh');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    await click('issued-retry');
    await storesReady();
    await settle();
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-22. under StrictMode (setup, cleanup, setup) one Save is one PUT; two presses before React commits the first are still ONE PUT under ONE key', async () => {
    const server = seeded();
    const r = rig(server);
    render(<StrictMode><ServerIssuedInvoices {...r.props()} /></StrictMode>);
    await openSettings();
    fill();
    server.hold.put = 1;
    const save = tid('issued-settings-save');
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(1);
    expect(r.keys).toHaveLength(1);
  });

  it('SII-23. every other first answer is said for what it is and decides the attempt (nothing held): tenant changed, not found, key reused, refused (one fresh check), the session ended', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    const cases: Array<[Response, string]> = [
      [new Response(JSON.stringify({ error: 'write_conflict', requestId: 'r' }), { status: 409, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.tenantChanged],
      [new Response(JSON.stringify({ error: 'not_found', requestId: 'r' }), { status: 404, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.notFoundWrite],
      [new Response(JSON.stringify({ error: 'idempotency_key_reused', requestId: 'r' }), { status: 422, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.keyReused],
      [new Response(JSON.stringify({ error: 'invalid_request', requestId: 'r' }), { status: 400, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.invalid],
      [new Response(JSON.stringify({ error: 'forbidden', requestId: 'r' }), { status: 403, headers: { 'content-type': 'application/json' } }), SETTINGS_TEXT.deniedWrite],
    ];
    fill();
    const logins = server.logins().length;
    for (const [answer, text] of cases) {
      const puts = server.puts_().length;
      server.puts.push(answer);
      await click('issued-settings-save');
      await waitFor(() => expect(status()).toHaveTextContent(text));
      expect(screen.queryByTestId('issued-settings-attempt')).toBeNull();
      await settle();
      expect(server.puts_()).toHaveLength(puts + 1); // one PUT per press, never a second on its own
    }
    // The refusal's one fresh check: after the refused PUT (the last one), exactly ONE session read — no login, no loop.
    expect(sentFrom(server, server.sent.indexOf(server.puts_()[cases.length - 1]) + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.logins()).toHaveLength(logins);
    expect(server.settings.get(STORE_1)).toBeUndefined();
    server.puts.push(new Response(JSON.stringify({ error: 'unauthenticated', requestId: 'r' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-settings')).toBeNull();
  });

  it('SII-24. a Check again refused 403 keeps the attempt unresolved with the refusal standing; a sign-out during the check drops it and its late answer changes nothing', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    server.puts.push(403);
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent('refusal stands'));
    expect(attemptState()).toBe('unresolved');
    server.hold.put = 1;
    await click('issued-settings-check-again');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(screen.queryByText(/^Saved:/)).toBeNull();
    expect(server.puts_()).toHaveLength(3);
  });

  it('SII-25. AC-11: nothing reaches browser storage, the address or a log; no token, key or body in the DOM; the new sources use none of them', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const server = seeded();
    const r = rig(server);
    const href = window.location.href;
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(document.body.innerHTML).not.toContain('s'.repeat(40));
    expect(document.body.innerHTML).not.toContain(r.keys[0]);
    expect(document.body.innerHTML).not.toContain('expectedVersion');
    for (const file of ['ServerIssuedInvoices.tsx', 'invoiceIssuingClient.ts']) {
      const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|history\.|location\.(href|search|hash)|from '[^']*server\//);
    }
  });
});

describe('Issued invoices — review fixes: the Save window, the sign-in and late answers (M7B-INVOICES-ISSUE-P2, AC-02, AC-08, AC-10)', () => {
  it('SII-26. Save locks the form and Refresh from the press — through its session check, before any key — so a Refresh cannot strand the panel loading, and an edit typed meanwhile never sits beside a held body it is not in', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.hold.current = 1; // the Save's session check
    server.puts.push('lose'); // committed, the answer lost: the held body stays on screen
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(server.puts_()).toHaveLength(0); // nothing sent yet
    expect(tid('issued-settings-refresh')).toBeDisabled();
    expect(tid('issued-settings-legal-name')).toBeDisabled();
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.busy);
    fireEvent.change(tid('issued-settings-legal-name'), { target: { value: 'Typed During Save' } });
    fireEvent.click(tid('issued-settings-refresh'));
    const reads = server.reads().length;
    server.held.shift()!.release();
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await settle();
    expect(panelPhase()).toBe('ready');
    expect(server.reads()).toHaveLength(reads); // no Refresh read
    expect(server.puts_()).toHaveLength(1);
    expect(server.puts_()[0].body).toBe(BODY(0, RATE_8875));
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC'); // what the held body says
  });

  it('SII-27. a closed panel\'s request never holds up the next panel: Save on a store chosen after a change sends at once while the first PUT is still out, and that late answer changes nothing', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.hold.put = 1;
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    expect(tid('issued-detached')).toHaveTextContent(SETTINGS_TEXT.detached); // the first one: not confirmed here
    await click('issued-settings-open');
    await panelReady();
    fill({ store: 'Second Store' });
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_().map((p) => p.url)).toEqual([issuingSettingsPathOf(STORE_1), issuingSettingsPathOf(STORE_2)]);
    server.held.shift()!.release();
    await settle();
    expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1));
    expect(tid('issued-settings-store-name')).toHaveValue('Second Store');
  });

  it('SII-28. a 429 on the one fresh check after a refused read starts the section\'s wait even when the panel closed meanwhile: the next panel reads nothing until it has passed', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.hold.settings = 1;
    await click('issued-settings-open');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.hold.current = 1; // the one fresh check after the refusal
    server.held.shift()!.release(chain(403, 'forbidden'));
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } }); // the panel goes before the check answers
    server.held.shift()!.release(chain(429, 'rate_limited', { 'retry-after': '30' }));
    await settle();
    const reads = server.reads().length;
    await click('issued-settings-open');
    await settle();
    expect(panelPhase()).toBe('rate-limited');
    expect(tid('issued-settings-state')).toHaveTextContent('Wait 30 seconds');
    expect(server.reads()).toHaveLength(reads);
  });

  it('SII-29. after an explicit sign-in Save waits until the settings are read under the renewed session: a re-read that fails keeps it waiting with its reason, and only "Check the settings again" — a read — lets it go', async () => {
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.getStatus.push(503); // the re-read after the sign-in
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.loadFailed));
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.rereadBlocked);
    await click('issued-settings-save');
    await settle();
    expect(server.puts_()).toHaveLength(1);
    const reads = server.reads().length;
    await click('issued-settings-reread');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    expect(server.reads().length - reads).toBe(1);
    expect(server.puts_()).toHaveLength(1); // a read, never a save
    expect(screen.queryByTestId('issued-settings-reread')).toBeNull();
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-30. Enter in the sign-in\'s password field confirms the sign-in — it never submits the settings form around it (no PUT, no key)', async () => {
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    const keys = r.keys.length;
    await user().type(tid('issued-settings-reauth-password'), 'correct horse{Enter}');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    expect(r.reauth).toEqual(['correct horse']);
    expect(server.puts_()).toHaveLength(1);
    expect(r.keys).toHaveLength(keys);
  });

  it('SII-31. a control the panel removes while it has focus hands focus to the panel\'s title, not the section heading: Check again whose replay is saved, and Check again judged too old', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    const title = screen.getByRole('heading', { name: 'Issuing settings' });
    await click('issued-settings-check-again');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(document.activeElement).toBe(title);
    type('issued-settings-store-name', 'Again');
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.wall += 23 * HOUR;
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(document.activeElement).toBe(title);
  });

  it('SII-32. every locked or invalid control says why: the rate while no exclusive rate is chosen, every field of a read-only store or under a save not yet confirmed; the tax mode\'s error rides its radios, not the group', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings(STORE_RO);
    await panelReady();
    for (const id of ['legal-name', 'store-name', 'postal-address', 'tax-id', 'tax-rate', 'tax-none']) expect(describedBy(`issued-settings-${id}`)).toContain(SETTINGS_TEXT.readOnly);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    expect(tid('issued-settings-rate')).toBeDisabled();
    expect(describedBy('issued-settings-rate')).toContain(SETTINGS_TEXT.rateOff);
    expect(describedBy('issued-settings-legal-name')).not.toContain(SETTINGS_TEXT.readOnly);
    await click('issued-settings-save'); // nothing filled in: every error, sent nowhere
    await settle();
    expect(tid('issued-settings-tax')).not.toHaveAttribute('aria-invalid');
    for (const id of ['tax-rate', 'tax-none']) {
      expect(tid(`issued-settings-${id}`)).toHaveAttribute('aria-invalid', 'true');
      expect(describedBy(`issued-settings-${id}`)).toContain(SETTINGS_RULE_TEXT.taxMode);
    }
    fill();
    expect(describedBy('issued-settings-rate')).not.toContain(SETTINGS_TEXT.rateOff);
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    for (const id of ['legal-name', 'postal-address', 'rate', 'tax-rate']) expect(describedBy(`issued-settings-${id}`)).toContain(SETTINGS_TEXT.locked);
  });

  it('SII-33. the sign-in keeps focus while it is out (its control says it is busy — never disabled), Refresh and Save wait for it, a failed one gives focus back to the password field; the control is amber-700 (contrast)', async () => {
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    let release: (token: string | null) => void = () => {};
    const identity: ShopIdentity = { ...r.props().identity!, reauthenticate: () => new Promise<string | null>((res) => { release = res; }) };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    expect(tid('issued-settings-reauth-confirm').className).toContain('bg-amber-700');
    type('issued-settings-reauth-password', 'wrong');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(tid('issued-settings-reauth-confirm')).toHaveAttribute('aria-disabled', 'true'));
    expect(document.activeElement).toBe(tid('issued-settings-reauth-confirm'));
    expect(tid('issued-settings-reauth-confirm')).toHaveAccessibleDescription(SETTINGS_TEXT.confirmingSignIn);
    expect(tid('issued-settings-refresh')).toBeDisabled();
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    await act(async () => { release(null); });
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.reauthFailed));
    expect(document.activeElement).toBe(tid('issued-settings-reauth-password'));
    expect(tid('issued-settings-refresh')).not.toBeDisabled();
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-34. "Saved" needs the read-back to find THAT version with THOSE values: the same version with other values, a lower version and an unconfigured answer each say they do not match — never "Saved", never another PUT', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    const view = (over: Record<string, unknown>): Response => new Response(JSON.stringify({ issuingSettings: {
      storeId: STORE_1, version: 1, configured: true, legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: null,
      tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over,
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const cases: Array<[Response, number]> = [
      [view({ legalName: 'Someone Else LLC' }), 1], // the same version, other values
      [view({ version: 1 }), 2], // a lower version than the one saved
      [new Response(JSON.stringify({ issuingSettings: { storeId: STORE_1, version: 0, configured: false } }), { status: 200, headers: { 'content-type': 'application/json' } }), 3],
    ];
    for (const [answer, version] of cases) {
      server.getStatus.push(answer);
      await click('issued-settings-save');
      await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.mismatch(version)));
      await settle();
      expect(status()).not.toHaveTextContent(/^Saved:/);
      expect(server.puts_()).toHaveLength(version);
    }
  });

  it('SII-35. "Issuing settings" cannot close the panel while a write is unresolved: the attempt, its key and body stay (the toggle says why), and Check again then sends the identical request', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.puts.push('lose');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    await click('issued-settings-open');
    await settle();
    expect(tid('issued-settings-attempt')).toBeInTheDocument();
    expect(tid('issued-settings-open')).toHaveAttribute('aria-expanded', 'true');
    expect(tid('issued-settings-open')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-open')).toHaveAccessibleDescription(SETTINGS_TEXT.saveBlocked);
    expect(server.puts_()).toHaveLength(1);
    await click('issued-settings-check-again');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    const [first, second] = server.puts_();
    expect(second.body).toBe(first.body);
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
  });

  it('SII-36. Check again never extends the 23-hour window: with sends 12 hours apart it still ends 23 hours after the FIRST send', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.mono += 12 * HOUR;
    r.clock.wall += 12 * HOUR;
    server.puts.push(503);
    await click('issued-settings-check-again');
    await waitFor(() => expect(server.puts_()).toHaveLength(2));
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.mono += 11 * HOUR; // 23 hours from the first send, 11 from the last
    r.clock.wall += 11 * HOUR;
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-37. a live, unresolved write is never re-sent on its own: a window focus, a tab return and timers past 30 seconds and past 23 hours send no PUT', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    const current = server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.current).length;
    await focusEvents();
    expect(server.sent.filter((s) => s.url === TENANT_SESSION_PATHS.current).length).toBeGreaterThan(current); // the session is checked, and live
    fakeClock();
    await advance(31_000);
    r.clock.mono += 23 * HOUR;
    r.clock.wall += 23 * HOUR;
    await advance(23 * HOUR);
    await focusEvents();
    expect(server.puts_()).toHaveLength(1);
    expect(attemptState()).toBe('unresolved');
  });

  it('SII-38. the panel\'s own read failures say what they are: a 404 that the settings are not available (no form, no retry), a 503 offers Try again — which only reads — and a 429 holds Try again until its wait has passed, reading nothing on its own', async () => {
    const server = seeded();
    server.retryAfter = '30';
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    server.getStatus.push(404);
    await click('issued-settings-open');
    await waitFor(() => expect(panelPhase()).toBe('not-found'));
    expect(tid('issued-settings-state')).toHaveTextContent(SETTINGS_TEXT.notFound);
    expect(tid('issued-settings-state')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('issued-settings-retry')).toBeNull();
    expect(screen.queryByTestId('issued-settings-legal-name')).toBeNull();
    await click('issued-settings-open'); // closed
    server.getStatus.push(503);
    await click('issued-settings-open');
    await waitFor(() => expect(panelPhase()).toBe('unavailable'));
    expect(tid('issued-settings-state')).toHaveTextContent(SETTINGS_TEXT.unavailable);
    const before = server.sent.length;
    await click('issued-settings-retry');
    await panelReady();
    expect(sentFrom(server, before)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${issuingSettingsPathOf(STORE_1)}`]);
    await click('issued-settings-open'); // closed
    fakeClock();
    server.getStatus.push(429);
    fireEvent.click(tid('issued-settings-open'));
    await until(() => expect(panelPhase()).toBe('rate-limited'));
    expect(tid('issued-settings-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-settings-retry')).toBeDisabled();
    const reads = server.reads().length;
    await advance(31_000);
    await until(() => expect(tid('issued-settings-retry')).not.toBeDisabled());
    await flush();
    expect(server.reads()).toHaveLength(reads);
    expect(server.puts_()).toHaveLength(0);
  });

  it('SII-39. the write side\'s waits and failures: a first Save answered 429 holds Save until the wait has passed (the timer sends nothing); "Load current version" that fails keeps the edits and sends nothing; a sign-in the store server did not confirm says so and keeps the sign-in group', async () => {
    const server = seeded();
    server.retryAfter = '30';
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    fakeClock();
    server.puts.push(429);
    fireEvent.click(tid('issued-settings-save'));
    await until(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.rateLimited(pickerWaitText(30))));
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.saveWaiting);
    fireEvent.click(tid('issued-settings-save'));
    await flush();
    expect(server.puts_()).toHaveLength(1);
    await advance(31_000);
    await until(() => expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.puts_()).toHaveLength(1); // the countdown gives Save back; it never saves
    vi.useRealTimers();
    server.bump(STORE_1, { legalName: 'Elsewhere LLC' });
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.conflict));
    server.getStatus.push(503);
    await click('issued-settings-load-current');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.loadFailed));
    expect(tid('issued-settings-legal-name')).toHaveValue('Example Repairs LLC');
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true'); // still the conflict
    expect(server.puts_()).toHaveLength(2);
    cleanup();
    const stale = seeded();
    stale.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(stale).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    stale.loginStatus.push(503); // the renewal login: no answer that renews anything
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.reauthUnconfirmed));
    expect(tid('issued-settings-reauth-group')).toBeInTheDocument();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready');
    expect(stale.puts_()).toHaveLength(1);
  });

  it('SII-40. a sign-in that completes after the store changed, or after another tab\'s session took over, applies nothing and sends nothing: no renewal login, no settings read, no PUT', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    server.staleLogins = true;
    const r = rig(server);
    let release: () => void = () => {};
    const identity: ShopIdentity = { ...r.props().identity!, reauthenticate: (_uid, password) => new Promise<string | null>((res) => { release = () => res(password === 'correct horse' ? 'tok-a' : null); }) };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } }); // 1. the store changes while it is out
    await settle();
    const mark = server.sent.length;
    await act(async () => { release(); });
    await settle();
    expect(sentFrom(server, mark)).toEqual([]);
    expect(screen.queryByText(SETTINGS_TEXT.renewed)).toBeNull();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await click('issued-settings-open');
    await panelReady();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    server.otherTab('uid-a'); // 2. another tab's session takes over while it is out
    await focusEvents();
    await storesReady();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    const mark2 = server.sent.length;
    await act(async () => { release(); });
    await settle();
    expect(sentFrom(server, mark2)).toEqual([]);
    expect(server.logins().filter((l) => l.headers.get('x-tmpos-reauthenticate') === '1')).toHaveLength(0);
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-41. while the sign-in is asked for, and while it is out, Save is held with its reason: no second PUT can leave beside the sign-in', async () => {
    const server = seeded();
    server.staleLogins = true;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    expect(tid('issued-settings-save')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.signInFirst);
    await click('issued-settings-save');
    await settle();
    expect(server.puts_()).toHaveLength(1);
    server.hold.current = 1; // the renewal's confirming session read
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('issued-settings-save');
    await settle();
    expect(server.puts_()).toHaveLength(1);
    server.held.shift()!.release();
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.saved(1)));
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-42. a sign-in the store server refused ends the session at once (the settings cleared, only Reconnect signs in); one it rate-limited starts the section\'s wait, and the sign-in is held back until it passes', async () => {
    const server = seeded();
    server.staleLogins = true;
    server.retryAfter = '30';
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.loginStatus.push(429);
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.rateLimited(pickerWaitText(30))));
    expect(tid('issued-settings-save')).toHaveAccessibleDescription(SETTINGS_TEXT.saveWaiting);
    // During the wait the sign-in is held back with its reason: a press (or Enter) sends no login.
    const logins = server.logins().length;
    type('issued-settings-reauth-password', 'correct horse');
    expect(tid('issued-settings-reauth-confirm')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-settings-reauth-hint')).toHaveTextContent(SETTINGS_TEXT.signInWaiting);
    await click('issued-settings-reauth-confirm');
    fireEvent.keyDown(tid('issued-settings-reauth-password'), { key: 'Enter' });
    await settle();
    expect(server.logins()).toHaveLength(logins);
    cleanup();
    // A second section past the wait: the store server refuses the sign-in outright.
    server.retryAfter = null;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.loginStatus.push(401);
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(tid('issued-stores-state')).toHaveTextContent(ISSUED_TEXT.refused);
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(server.puts_()).toHaveLength(2); // one refused Save per section (step_up_required): no sign-in ever re-sent one
  });

  it('SII-43. a read-back refused 403 gets the reads\' one fresh check before anything is said: the same session says "saved, not read back"; another tab\'s token is a new generation — the panel goes and the save is still reported', async () => {
    const server = seeded();
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    fill();
    server.getStatus.push(403);
    await click('issued-settings-save');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.unread(1)));
    await settle();
    expect(sentFrom(server, server.sent.indexOf(server.puts_()[0]) + 1)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${issuingSettingsPathOf(STORE_1)}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    type('issued-settings-store-name', 'Again');
    server.hold.settings = 1; // the read-back
    await click('issued-settings-save');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('uid-a');
    server.held.shift()!.release(chain(403, 'forbidden'));
    await waitFor(() => expect(screen.queryByTestId('issued-settings')).toBeNull());
    expect(tid('issued-notice')).toHaveTextContent(SETTINGS_TEXT.savedEnded(2));
    await storesReady();
    expect(tid('issued-connection-changed')).toHaveTextContent(ISSUED_TEXT.connection);
    expect(server.puts_()).toHaveLength(2);
  });

  it('SII-44. an unresolved write that aged out (its body gone) still leaves the "could not be confirmed" note when a store change closes its panel', async () => {
    const server = seeded();
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await openSettings();
    fill();
    server.puts.push('lose-before');
    await click('issued-settings-save');
    await waitFor(() => expect(attemptState()).toBe('unresolved'));
    r.clock.wall += 23 * HOUR;
    await click('issued-settings-check-again');
    await waitFor(() => expect(tid('issued-settings-attempt-note')).toHaveTextContent(SETTINGS_TEXT.tooOld));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await settle();
    expect(screen.queryByTestId('issued-settings')).toBeNull();
    expect(tid('issued-detached')).toHaveTextContent(SETTINGS_TEXT.detached);
    expect(server.puts_()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Commit B: the issued list and one issued invoice (M7B-INVOICES-ISSUE-P2, AC-09, AC-10, AC-11, AC-08).

const listPhase = () => screen.queryByTestId('issued-list-state')?.getAttribute('data-phase') ?? 'none';
const listReady = () => waitFor(() => expect(listPhase()).toBe('ready'));
const rows = () => screen.queryAllByTestId('issued-row').map((li) => li.getAttribute('data-id'));
const customersShown = () => screen.queryAllByTestId('issued-row-customer').map((b) => b.textContent);
const openButton = (n: number) => screen.getByRole('button', { name: `Open invoice ${n}` });
const viewPhase = () => (screen.queryByTestId('issued-view-total') !== null ? 'ready' : screen.queryByTestId('issued-view-state')?.getAttribute('data-phase') ?? 'none');
const viewReady = (n: number) => waitFor(() => { expect(viewPhase()).toBe('ready'); expect(tid('issued-view-title')).toHaveTextContent(`Invoice ${n}`); });
const heading = () => screen.getByRole('heading', { name: 'Issued invoices' });
const listPath = (storeId: string, cursor?: string) => `${STORES_PATH}/${storeId}/invoices?limit=20${cursor === undefined ? '' : `&cursor=${cursor}`}`;
/** Words the issued surfaces never use: no payment state, and none of the actions this stage does not offer. */
const FORBIDDEN = /\b(paid|unpaid|due|balance|payment|deposit|receivable|void|print|send|receipt)\b/i;
const MAX = Number.MAX_SAFE_INTEGER;
const MAX_TEXT = '$90,071,992,547,409.91';
const cells = () => screen.getAllByTestId('issued-view-line').map((tr) => [...(tr as HTMLTableRowElement).cells].map((td) => td.textContent));
/** The renewal of SII-11: a stale sign-in's Save, then the explicit sign-in (the section's renew) — its status says "press Save". */
async function renewBySignIn() {
  fill();
  await click('issued-settings-save');
  await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
  type('issued-settings-reauth-password', 'correct horse');
  await click('issued-settings-reauth-confirm');
  await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
}

describe('Issued invoices — the issued list (M7B-INVOICES-ISSUE-P2, AC-09)', () => {
  it('SII-45. choosing a store is what reads its issued list — ONE first page (limit 20), nothing before; each row says "Invoice {number}", the customer as recorded (isolated), the exact Total, the UTC issue time and "Issued", newest number first; no payment wording, no other control, no customer lookup and nothing written', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    issueAt(server, STORE_1, 3, (n) => ({ customerName: n === 2 ? 'שלום Customer' : `Customer ${n}` }));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await click('issued-show');
    await storesReady();
    await focusEvents();
    expect(server.lists()).toEqual([]);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady();
    expect(server.lists()).toEqual([listPath(STORE_1)]);
    expect(screen.getAllByTestId('issued-row-number').map((p) => p.textContent)).toEqual(['Invoice 3', 'Invoice 2', 'Invoice 1']);
    const second = screen.getAllByTestId('issued-row')[1];
    const customer = within(second).getByTestId('issued-row-customer');
    expect(customer.tagName).toBe('BDI');
    expect(customer).toHaveTextContent('שלום Customer');
    expect(within(second).getByTestId('issued-row-total')).toHaveTextContent('Total $21.76'); // 1999 + 177 (8.875 %, rounded half up)
    const time = within(second).getByTestId('issued-row-issued');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', invoice(2).issuedAt);
    expect(time).toHaveTextContent('2026-10-16 21:00:02 UTC');
    expect(within(second).getByTestId('issued-row-status')).toHaveTextContent('Issued');
    expect(openButton(2)).toHaveAccessibleDescription(/שלום Customer · Total \$21\.76 · 2026-10-16 21:00:02 UTC · Issued/);
    expect(within(tid('issued-list')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open', 'Open', 'Open']);
    expect(tid('issued-section').textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    expect(server.sent.filter((r) => r.url.startsWith('/api/v1/customers'))).toEqual([]);
    expect(server.writes()).toEqual([]);
  });

  it('SII-46. "Load more" sends the cursor the server gave for THIS store and nothing else: 45 invoices come as 20, 20 and 5 in order, no row twice; it keeps focus while its read is out (aria-disabled, a press meanwhile sends nothing; a settings read out holds nothing of the list) and the last page hands focus to the first row it brought', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 45);
    const sorted = [...made].sort((a, b) => b.number - a.number);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(rows()).toHaveLength(20);
    // A settings read out is not the list's: Load more is not held, and nothing says the list is loading.
    server.hold.settings = 1;
    await click('issued-settings-open');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(tid('issued-load-more')).toHaveAttribute('aria-disabled', 'false');
    expect(tid('issued-load-more')).not.toHaveAttribute('aria-describedby');
    server.held.shift()!.release();
    await panelReady();
    const more = tid('issued-load-more');
    act(() => more.focus());
    server.hold.list = 1;
    fireEvent.click(more);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(more).toHaveAttribute('aria-disabled', 'true');
    expect(more).toHaveAccessibleDescription(LIST_TEXT.loading); // why it waits, said
    expect(document.activeElement).toBe(more);
    fireEvent.click(more); // nothing while its read is out
    await flush();
    expect(server.lists()).toHaveLength(2);
    server.held.shift()!.release();
    await waitFor(() => expect(rows()).toHaveLength(40));
    expect(document.activeElement).toBe(tid('issued-load-more'));
    expect(tid('issued-load-more')).not.toHaveAttribute('aria-describedby');
    fireEvent.click(tid('issued-load-more'));
    await waitFor(() => expect(rows()).toHaveLength(45));
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById(`issued-open-${made[4].id}`))); // number 5: the last page's first row
    expect(rows()).toEqual(sorted.map((i) => i.id));
    expect(server.lists()).toEqual([listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id)), listPath(STORE_1, cursorOf(sorted[39].id))]);
  });

  it('SII-47. pages belong to their store and generation: a Load more page held across a store change never joins the new store\'s rows, a first page outrun by a store change shows nothing, the other store never gets this store\'s cursor, and coming back reads page one afresh', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 25);
    const sorted = [...made].sort((a, b) => b.number - a.number);
    server.issued.set(STORE_2, [1, 2].map((n) => invoice(n, { id: uuid(0x2a00 + n), customerName: `Second store ${n}` })));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    server.hold.list = 1;
    fireEvent.click(tid('issued-load-more'));
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await listReady();
    expect(customersShown()).toEqual(['Second store 2', 'Second store 1']);
    server.held.shift()!.release(); // store 1's page 2
    await settle();
    expect(customersShown()).toEqual(['Second store 2', 'Second store 1']);
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    server.hold.list = 1;
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(listPhase()).toBe('loading');
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await listReady();
    server.held.shift()!.release(); // store 1's outrun first page
    await settle();
    expect(customersShown()).toEqual(['Second store 2', 'Second store 1']);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady();
    expect(rows()).toEqual(sorted.slice(0, 20).map((i) => i.id));
    expect(server.lists(STORE_2)).toEqual([listPath(STORE_2), listPath(STORE_2)]);
    expect(server.lists(STORE_1)).toEqual([listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id)), listPath(STORE_1), listPath(STORE_1)]);
  });

  it('SII-48. the list says what it has: no invoice yet; an outage with Try again (which reads page one, once per press); a failed Load more keeps the rows as last known; a 429 holds Try again with its reason until the wait has passed, and the timer reads nothing', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_2, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(tid('issued-empty')).toHaveTextContent(LIST_TEXT.empty);
    expect(screen.queryByTestId('issued-list-retry')).toBeNull();
    server.listStatus.push(503);
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.unavailable);
    expect(screen.queryByTestId('issued-row')).toBeNull();
    await click('issued-list-retry');
    await listReady();
    expect(server.lists(STORE_2)).toEqual([listPath(STORE_2), listPath(STORE_2)]);
    server.listStatus.push(503);
    await click('issued-load-more');
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    expect(rows()).toHaveLength(20);
    expect(tid('issued-last-known')).toHaveTextContent(LIST_TEXT.lastKnown);
    fakeClock();
    server.listStatus.push(429);
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('rate-limited'));
    expect(tid('issued-list-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-list-retry')).toHaveAccessibleDescription(LIST_TEXT.waiting);
    const sent = server.lists().length;
    fireEvent.click(tid('issued-list-retry')); // held back: nothing is read
    await flush();
    await advance(31_000);
    await until(() => expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.lists()).toHaveLength(sent); // the countdown gives Try again back; it never reads
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('ready'));
    expect(server.lists()).toHaveLength(sent + 1);
  });

  it('SII-49. a role the server refuses the issued reads (no Customers View) gets ONE fresh session check, then "You cannot view issued invoices at this store." — no rows, no loop, no login; Try again is one read again', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 3);
    server.issuedDenied.add('uid-a');
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await waitFor(() => expect(listPhase()).toBe('denied'));
    const refused = server.sent.findIndex((r) => r.url.startsWith(`${STORES_PATH}/${STORE_1}/invoices?`));
    expect(sentFrom(server, refused + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.denied);
    expect(tid('issued-list-state')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('issued-row')).toBeNull();
    const logins = server.logins().length;
    await settle();
    expect(server.lists()).toHaveLength(1);
    await click('issued-list-retry');
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    await waitFor(() => expect(listPhase()).toBe('denied'));
    await settle();
    const again = server.sent.map((r) => r.url).lastIndexOf(listPath(STORE_1));
    expect(sentFrom(server, again + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.logins()).toHaveLength(logins);
    expect(server.lists()).toHaveLength(2);
  });

  it('SII-50. a continuation the server no longer takes (400 on Load more) reloads ONCE from page one and says the list changed', async () => {
    const server = seeded();
    const sorted = issueAt(server, STORE_1, 25).sort((a, b) => b.number - a.number);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    server.listStatus.push(400);
    await click('issued-load-more');
    await waitFor(() => expect(tid('issued-list-note')).toHaveTextContent(LIST_TEXT.reloaded));
    await listReady();
    await settle();
    expect(server.lists()).toEqual([listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id)), listPath(STORE_1)]);
    expect(rows()).toEqual(sorted.slice(0, 20).map((i) => i.id));
  });
});

describe('Issued invoices — one issued invoice (M7B-INVOICES-ISSUE-P2, AC-09, AC-10)', () => {
  it('SII-51. Open reads the invoice ONCE and shows its version-1 snapshot as recorded: "Invoice 7", Close focused, Issued, the UTC time, the seller (each value isolated, the address on its own lines, the tax ID), the customer, the lines in order, Subtotal, "Tax (8.875%)" with its amount, Total and the snapshot note', async () => {
    const server = seeded();
    const seller = { legalName: 'Example Repairs LLC', storeName: 'Main Street Shop', postalAddress: '1 Main St\nSpringfield\nMA 01101', taxRegistrationId: 'TX-1' };
    const lines = [line(1, 'Screen repair', 1, 1999), line(2, 'Battery', 2, 4550), line(3, 'Labour', 3, 2500)];
    const made = issueAt(server, STORE_1, 7, (n) => (n === 7 ? { lines, seller, customerName: 'Ada Customer' } : {}));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(7));
    await viewReady(7);
    const dialog = screen.getByRole('dialog', { name: 'Invoice 7' });
    expect(document.activeElement).toBe(tid('issued-view-close'));
    expect(server.details()).toEqual([`${STORES_PATH}/${STORE_1}/invoices/${made[6].id}`]);
    expect(tid('issued-view-status')).toHaveTextContent('Issued');
    expect(tid('issued-view-issued-at').tagName).toBe('TIME');
    expect(tid('issued-view-issued-at')).toHaveAttribute('datetime', made[6].issuedAt);
    expect(tid('issued-view-issued-at')).toHaveTextContent('2026-10-16 21:00:07 UTC');
    expect(tid('issued-view-seller-legal')).toHaveTextContent('Example Repairs LLC');
    expect(tid('issued-view-seller-store')).toHaveTextContent('Main Street Shop');
    expect(tid('issued-view-seller-address').textContent).toBe('1 Main St\nSpringfield\nMA 01101');
    expect(tid('issued-view-seller-address')).toHaveClass('whitespace-pre-line');
    expect(tid('issued-view-seller-tax-id')).toHaveTextContent('Tax registration ID TX-1');
    expect(tid('issued-view-customer')).toHaveTextContent('Ada Customer');
    for (const id of ['issued-view-seller-legal', 'issued-view-seller-store', 'issued-view-seller-address', 'issued-view-seller-tax-id', 'issued-view-customer']) {
      expect(tid(id).querySelector('bdi'), id).not.toBeNull();
    }
    expect(cells()).toEqual([['1', 'Screen repair', '1', '$19.99', '$19.99'], ['2', 'Battery', '2', '$45.50', '$91.00'], ['3', 'Labour', '3', '$25.00', '$75.00']]);
    expect(within(dialog).getByRole('region', { name: 'Invoice lines' })).toHaveAttribute('tabindex', '0');
    // 18599 cents at 8.875 %: (18599 × 8875 + 50000) / 100000 = 1651 cents of tax.
    expect(tid('issued-view-subtotal')).toHaveTextContent('Subtotal $185.99');
    expect(tid('issued-view-tax')).toHaveTextContent('Tax (8.875%) $16.51');
    expect(tid('issued-view-total')).toHaveTextContent('Total $202.50');
    expect(tid('issued-view-note')).toHaveTextContent(VIEW_TEXT.note);
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    expect(dialog.textContent).not.toMatch(FORBIDDEN);
    expect(server.sent.filter((r) => r.url.startsWith('/api/v1/customers'))).toEqual([]);
    expect(server.writes()).toEqual([]);
  });

  it('SII-52. the tax line keeps its meanings apart: "No tax calculated" alone (no amount; Total = Subtotal), an explicit 0 % as "Tax (0%) $0.00" — never the same line — and a seller without a tax registration ID shows no such line', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2, (n) => (n === 1 ? { tax: { mode: 'none' }, seller: { ...SELLER, taxRegistrationId: null } } : { tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } }));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(1));
    await viewReady(1);
    expect(tid('issued-view-tax').textContent).toBe('No tax calculated');
    expect(tid('issued-view-subtotal')).toHaveTextContent('Subtotal $19.99');
    expect(tid('issued-view-total')).toHaveTextContent('Total $19.99');
    expect(screen.queryByTestId('issued-view-seller-tax-id')).toBeNull();
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await user().click(openButton(2));
    await viewReady(2);
    expect(tid('issued-view-tax').textContent).toBe('Tax (0%) $0.00');
    expect(tid('issued-view-total')).toHaveTextContent('Total $19.99');
    expect(tid('issued-view-seller-tax-id')).toHaveTextContent('Tax registration ID TX-1');
  });

  it('SII-53. money is exact across the safe range: 2^53-1 cents reads $90,071,992,547,409.91 in its row and in every amount of the dialog, each amount unbreakable; 0, 1 and 99 cents read $0.00, $0.01 and $0.99', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 4, (n) => ({ tax: { mode: 'none' }, lines: [line(1, `Line ${n}`, 1, [MAX, 0, 1, 99][n - 1])] }));
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    expect(screen.getAllByTestId('issued-row-total').map((s) => s.textContent)).toEqual(['Total $0.99', 'Total $0.01', 'Total $0.00', `Total ${MAX_TEXT}`]);
    await user().click(openButton(1));
    await viewReady(1);
    expect(cells()).toEqual([['1', 'Line 1', '1', MAX_TEXT, MAX_TEXT]]);
    expect(tid('issued-view-subtotal')).toHaveTextContent(`Subtotal ${MAX_TEXT}`);
    expect(tid('issued-view-total')).toHaveTextContent(`Total ${MAX_TEXT}`);
    for (const id of ['issued-view-subtotal', 'issued-view-total']) expect(within(tid(id)).getByText(MAX_TEXT)).toHaveClass('whitespace-nowrap');
    for (const td of screen.getAllByTestId('issued-view-line').flatMap((tr) => [...(tr as HTMLTableRowElement).cells].slice(2))) expect(td).toHaveClass('whitespace-nowrap');
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await user().click(openButton(3));
    await viewReady(3);
    expect(cells()).toEqual([['1', 'Line 3', '1', '$0.01', '$0.01']]);
  });

  it('SII-54. Escape and Close close the dialog and give focus back to the row\'s Open; Tab stays inside it (Close, the lines region, Close); when that row is gone — the session ended while it was open — focus goes to the section heading, never the page body', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(1));
    await viewReady(1);
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-lines-scroll'));
    await user().tab();
    expect(document.activeElement).toBe(tid('issued-view-close'));
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openButton(1)));
    await user().click(openButton(2));
    await viewReady(2);
    await click('issued-view-close');
    await waitFor(() => expect(document.activeElement).toBe(openButton(2)));
    await user().click(openButton(1));
    await viewReady(1);
    await act(async () => { await r.props().session!.logout(); });
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(screen.queryByTestId('issued-row')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });

  it('SII-55. a late answer changes nothing: an invoice answered after Close (Close cancels that GET; reopening reads afresh), one answered after a store change closed its dialog, and a first page answered after a sign-out (a 429 whose wait would hold the next choice: after Reconnect the store is read at once)', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    server.issued.set(STORE_2, [invoice(1, { id: uuid(0x2a01), customerName: 'Second store 1' })]);
    const r = rig(server);
    render(<ServerIssuedInvoices {...r.props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    server.hold.detail = 1;
    await user().click(openButton(2));
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(tid('issued-view-state')).toHaveAttribute('data-phase', 'loading');
    expect(server.detailRequests()[0].signal?.aborted).toBe(false);
    await click('issued-view-close');
    expect(server.detailRequests()[0].signal?.aborted).toBe(true); // Close cancels the GET it had out
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-view')).toBeNull();
    await user().click(openButton(2));
    await viewReady(2);
    expect(server.details()).toHaveLength(2);
    await click('issued-view-close');
    server.hold.detail = 1;
    await user().click(openButton(1));
    await waitFor(() => expect(server.held).toHaveLength(1));
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } }); // the page behind is inert to a user; a change still reaches it
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await listReady();
    server.held.shift()!.release();
    await settle();
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(customersShown()).toEqual(['Second store 1']);
    server.hold.list = 1;
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { await r.props().session!.logout(); });
    server.held.shift()!.release(chain(429, 'rate_limited', { 'retry-after': '30' }));
    await settle();
    expect(screen.queryByTestId('issued-row')).toBeNull();
    expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out');
    const before = server.lists(STORE_1).length;
    await click('issued-retry'); // Reconnect
    await storesReady();
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await listReady(); // no wait: the late 429 started none
    expect(server.lists(STORE_1)).toHaveLength(before + 1);
    expect(rows()).toHaveLength(2);
    expect(tid('issued-list-state')).not.toHaveTextContent('Wait');
    expect(server.writes()).toEqual([]);
  });

  it('SII-56. the dialog says what the server answered: 404 "This invoice is not available."; a 403 after ONE fresh session check (no loop); a 503 offers Try again — one GET per press; a 429 holds Try again with its reason until the wait has passed (the timer reads nothing); a 401 ends the session — the dialog and the list go', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 1);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    const close = async () => { await click('issued-view-close'); await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull()); };
    server.detailStatus.push(404);
    await user().click(openButton(1));
    await waitFor(() => expect(viewPhase()).toBe('not-found'));
    expect(tid('issued-view-state')).toHaveTextContent(VIEW_TEXT.notFound);
    expect(screen.queryByTestId('issued-view-retry')).toBeNull();
    await close();
    server.detailStatus.push(403);
    const logins = server.logins().length;
    await user().click(openButton(1));
    await waitFor(() => expect(viewPhase()).toBe('denied'));
    expect(tid('issued-view-state')).toHaveTextContent(VIEW_TEXT.denied);
    const refused = server.sent.map((x) => x.url).lastIndexOf(server.details().slice(-1)[0]);
    expect(sentFrom(server, refused + 1)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(server.logins()).toHaveLength(logins);
    await close();
    server.detailStatus.push(503);
    await user().click(openButton(1));
    await waitFor(() => expect(viewPhase()).toBe('unavailable'));
    expect(tid('issued-view-state')).toHaveTextContent(VIEW_TEXT.unavailable);
    const before = server.details().length;
    await click('issued-view-retry');
    await viewReady(1);
    expect(server.details()).toHaveLength(before + 1);
    await close();
    fakeClock();
    server.detailStatus.push(429);
    fireEvent.click(openButton(1));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    expect(tid('issued-view-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-retry')).toHaveAccessibleDescription(VIEW_TEXT.waiting);
    const sent = server.details().length;
    fireEvent.click(tid('issued-view-retry'));
    await flush();
    await advance(31_000);
    await until(() => expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.details()).toHaveLength(sent);
    fireEvent.click(tid('issued-view-close'));
    await advance(10);
    vi.useRealTimers();
    server.detailStatus.push(401);
    await user().click(openButton(1));
    await waitFor(() => expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('issued-view')).toBeNull();
    expect(screen.queryByTestId('issued-row')).toBeNull();
  });

  it('SII-57. nothing is read or written on its own: with the list and an invoice shown, a window focus, a tab return and timers past a minute send no list, invoice, settings or write request; under StrictMode a store choice is one first page and one Open is ONE GET at the fake (StrictMode\'s first mount cancels its read before it is sent; the one that arrives is never cancelled), and reopening reads once more', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = seeded();
    issueAt(server, STORE_1, 2);
    render(<StrictMode><ServerIssuedInvoices {...rig(server).props()} /></StrictMode>);
    await showAndChoose(STORE_1);
    await listReady();
    await settle();
    expect(server.lists()).toHaveLength(1);
    // StrictMode mounts the dialog, unmounts it and mounts it again: the first mount's read is cancelled by its cleanup
    // before it is sent, so the fake receives ONE GET — the second mount's, never cancelled — and nothing after it.
    server.hold.detail = 1;
    await user().click(openButton(1));
    await waitFor(() => expect(server.held).toHaveLength(1));
    await settle();
    expect(server.details()).toHaveLength(1);
    expect(server.detailRequests()[0].signal?.aborted).toBe(false);
    server.held.shift()!.release();
    await viewReady(1);
    await settle();
    expect(server.details()).toHaveLength(1);
    expect(server.detailRequests()[0].signal?.aborted).toBe(false);
    const quietCount = () => server.sent.filter((x) => !x.url.startsWith('/api/v1/session')).length;
    const before = quietCount();
    await focusEvents();
    fakeClock();
    await advance(65_000);
    vi.useRealTimers();
    await focusEvents();
    expect(quietCount()).toBe(before);
    await click('issued-view-close');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await user().click(openButton(1));
    await viewReady(1);
    await settle();
    expect(server.details()).toHaveLength(2);
    expect(server.lists()).toHaveLength(1);
    expect(server.reads()).toHaveLength(0);
    expect(server.writes()).toEqual([]);
  });

  it('SII-58. an explicit sign-in (the settings\' step-up) renews the token, and the list read under the old one goes: its pages and cursor are cleared, the store stays chosen and the list says so with Try again — nothing is read on its own; Try again reads page one under the renewed token, and Load more then sends that page\'s cursor', async () => {
    const server = seeded();
    server.staleLogins = true;
    const sorted = issueAt(server, STORE_1, 25).sort((a, b) => b.number - a.number);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    await listReady();
    expect(rows()).toHaveLength(20);
    await renewBySignIn();
    expect(rows()).toEqual([]);
    expect(screen.queryByTestId('issued-load-more')).toBeNull();
    expect(listPhase()).toBe('unavailable');
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.renewed);
    expect(tid('issued-store')).toHaveValue(STORE_1);
    await settle();
    expect(server.lists()).toEqual([listPath(STORE_1)]); // nothing read on its own
    const old = server.sent.find((x) => x.url === listPath(STORE_1))!.headers.get('x-tmpos-session-csrf');
    const renewed = server.reads().at(-1)!.headers.get('x-tmpos-session-csrf'); // the settings' re-read after the sign-in
    expect(renewed).not.toBe(old);
    await click('issued-list-retry');
    await listReady();
    const firstPages = server.sent.filter((x) => x.url === listPath(STORE_1));
    expect(firstPages.map((x) => x.headers.get('x-tmpos-session-csrf'))).toEqual([old, renewed]);
    expect(rows()).toEqual(sorted.slice(0, 20).map((i) => i.id));
    await click('issued-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    expect(server.lists()).toEqual([listPath(STORE_1), listPath(STORE_1), listPath(STORE_1, cursorOf(sorted[19].id))]);
    expect(server.puts_()).toHaveLength(1); // the refused one only: nothing saved on its own
  });

  it('SII-59. a first page cancelled by that sign-in is never left "Loading": the list says it was cleared by the sign-in, with Try again; its late page changes nothing; Try again reads page one under the renewed session', async () => {
    const server = seeded();
    server.staleLogins = true;
    issueAt(server, STORE_1, 3);
    server.listStatus.push(503);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await openSettings();
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    server.hold.list = 1;
    await click('issued-list-retry');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(listPhase()).toBe('loading');
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm');
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await waitFor(() => expect(listPhase()).toBe('unavailable'));
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.renewed);
    server.held.shift()!.release();
    await settle();
    expect(listPhase()).toBe('unavailable');
    expect(screen.queryByTestId('issued-row')).toBeNull();
    await click('issued-list-retry');
    await listReady();
    expect(rows()).toHaveLength(3);
    expect(server.lists()).toHaveLength(3);
    expect(server.puts_()).toHaveLength(1);
  });

  it('SII-60. AC-11: listing and opening invoices use no browser storage, history, address or log; no token in the DOM; the section and the dialog never name a payment state or offer send, print, void, edit or delete', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const server = seeded();
    issueAt(server, STORE_1, 25, (n) => (n % 2 === 0 ? { tax: { mode: 'none' } } : {}));
    const href = window.location.href;
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    await click('issued-load-more');
    await waitFor(() => expect(rows()).toHaveLength(25));
    for (const n of [2, 3]) {
      await user().click(openButton(n));
      await viewReady(n);
      const dialog = tid('issued-view');
      expect(dialog.textContent).not.toMatch(FORBIDDEN);
      expect(within(dialog).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
      await click('issued-view-close');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    }
    expect(tid('issued-section').textContent).not.toMatch(FORBIDDEN);
    expect(within(tid('issued-section')).getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Open')).toEqual(['Issuing settings']);
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(document.body.innerHTML).not.toContain('s'.repeat(40));
    expect(document.body.innerHTML).not.toContain(cursorOf(invoice(6).id));
  });
});

describe('Issued invoices — review fixes: continuations, late answers, refusals, focus and waits (M7B-INVOICES-ISSUE-P2, AC-08, AC-09, AC-10)', () => {
  it('SII-61. a continuation that does not continue the rows shown is refused whole — an invoice already shown (under another number), a source draft already shown, an invoice or a source draft twice in the page itself, or a number not below the last one shown: nothing joins, its cursor is not taken, nothing more is read on its own, and the list is unavailable with the rows as last known (Try again reads page one)', async () => {
    const server = seeded();
    const made = issueAt(server, STORE_1, 25); // page one: 25..6
    // A page repeating itself never passes the issuing client's own one-page check: those pages are handed to the section
    // as the client's answer (after the real request), to show the section refuses them too.
    const real = createInvoiceIssuingClient({ fetch: server.fetch });
    let handed: IssuedSummary[] | null = null;
    const issuing = { ...real, listIssued: async (...args: Parameters<typeof real.listIssued>) => {
      const answer = await real.listIssued(...args);
      const invoices = handed;
      handed = null;
      return invoices === null ? answer : { kind: 'ok' as const, invoices, nextCursor: null };
    } };
    render(<ServerIssuedInvoices {...rig(server).props({ issuing })} />);
    await showAndChoose(STORE_1);
    await listReady();
    const shown = rows();
    const [five, four, ...rest] = [5, 4, 3, 2, 1].map((n) => summaryOf(made[n - 1]));
    const page = (invoices: Array<ReturnType<typeof summaryOf>>): Response =>
      new Response(JSON.stringify({ invoices, nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    const malformed = [
      { invoices: [{ ...summaryOf(made[24]), number: 5, sourceDraftId: uuid(0xdeee) }, four, ...rest] }, // invoice 25's id again, under number 5
      { invoices: [{ ...five, sourceDraftId: made[24].sourceDraftId }, four, ...rest] }, // invoice 25's source draft again
      { invoices: [{ ...five, number: 6 }, four, ...rest] }, // not below 6, the last number shown
      { invoices: [five, { ...four, id: five.id, sourceDraftId: uuid(0xdeef) }, ...rest], within: true }, // invoice 5's id twice in the page
      { invoices: [five, { ...four, sourceDraftId: five.sourceDraftId }, ...rest], within: true }, // invoice 5's source draft twice in the page
    ];
    for (const { invoices, within } of malformed) {
      const sent = server.lists().length;
      if (within === true) handed = invoices as unknown as IssuedSummary[];
      else server.listStatus.push(page(invoices));
      await click('issued-load-more');
      await waitFor(() => expect(listPhase()).toBe('unavailable'));
      await settle();
      expect(rows()).toEqual(shown);
      expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.unavailable);
      expect(tid('issued-last-known')).toHaveTextContent(LIST_TEXT.lastKnown);
      expect(screen.queryByTestId('issued-load-more')).toBeNull();
      expect(server.lists()).toHaveLength(sent + 1);
      await click('issued-list-retry');
      await listReady();
      expect(server.lists().at(-1)).toBe(listPath(STORE_1));
      expect(rows()).toEqual(shown);
    }
  });

  it('SII-62. a closed dialog\'s read answers nothing, even once the same invoice is open again: its late 401 ends no session and its late 429 starts no wait', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    for (const late of [chain(401, 'unauthenticated'), chain(429, 'rate_limited', { 'retry-after': '30' })]) {
      server.hold.detail = 1;
      await user().click(openButton(25));
      await waitFor(() => expect(server.held).toHaveLength(1));
      await click('issued-view-close');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
      await user().click(openButton(25)); // the same invoice again: its own read answers
      await viewReady(25);
      server.held.shift()!.release(late);
      await settle();
      expect(viewPhase()).toBe('ready');
      expect(tid('issued-stores-state')).toHaveAttribute('data-phase', 'ready');
      expect(rows()).toHaveLength(20);
      expect(tid('issued-load-more')).toHaveAttribute('aria-disabled', 'false');
      expect(tid('issued-load-more')).not.toHaveAttribute('aria-describedby');
      await click('issued-view-close');
      await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    }
    expect(server.logins()).toHaveLength(1);
  });

  it('SII-63. a 403 on the list takes every row and the cursor away at once — before its one fresh check has answered, and whatever that check then says: an outage says unavailable, a 429 the wait — with no row of this store left on screen and no Load more', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    for (const check of [503, 429]) {
      server.hold.list = 1;
      fireEvent.click(tid('issued-load-more'));
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.hold.current = 1; // the one fresh session check after the 403, held
      server.held.shift()!.release(chain(403, 'forbidden'));
      await waitFor(() => expect(server.held.map((h) => h.kind)).toEqual(['current']));
      // Gone already, while that check has not answered.
      expect(rows()).toEqual([]);
      expect(screen.queryByTestId('issued-last-known')).toBeNull();
      expect(screen.queryByTestId('issued-load-more')).toBeNull();
      server.held.shift()!.release(check === 503 ? chain(503, 'service_unavailable') : chain(429, 'rate_limited', { 'retry-after': '30' }));
      await waitFor(() => expect(listPhase()).toBe(check === 503 ? 'unavailable' : 'rate-limited'));
      await settle();
      expect(rows()).toEqual([]);
      expect(screen.queryByTestId('issued-last-known')).toBeNull();
      expect(screen.queryByTestId('issued-load-more')).toBeNull();
      expect(tid('issued-list-state')).toHaveTextContent(check === 503 ? LIST_TEXT.unavailable : 'Wait 30 seconds');
      if (check === 503) {
        await click('issued-list-retry');
        await listReady();
        expect(rows()).toHaveLength(20);
      }
    }
  });

  it('SII-64. a Load more that fails hands its focus to the list\'s Try again — where the user tries again, not the section heading or the page body: an outage, then a 429', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    for (const status of [503, 429]) {
      const more = tid('issued-load-more');
      act(() => more.focus());
      server.listStatus.push(status);
      fireEvent.click(more);
      await waitFor(() => expect(listPhase()).toBe(status === 503 ? 'unavailable' : 'rate-limited'));
      await waitFor(() => expect(document.activeElement).toBe(tid('issued-list-retry')));
      expect(rows()).toHaveLength(20);
      if (status === 503) {
        await click('issued-list-retry');
        await listReady();
      }
    }
  });

  it('SII-65. under StrictMode (effects set up, cleaned up and set up again) Escape and Close still give focus back to the row\'s Open, not the section heading', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    render(<StrictMode><ServerIssuedInvoices {...rig(server).props()} /></StrictMode>);
    await showAndChoose(STORE_1);
    await listReady();
    await user().click(openButton(1));
    await viewReady(1);
    expect(document.activeElement).toBe(tid('issued-view-close'));
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openButton(1)));
    await user().click(openButton(2));
    await viewReady(2);
    await click('issued-view-close');
    await waitFor(() => expect(document.activeElement).toBe(openButton(2)));
  });

  it('SII-66. the status regions exist before their first text: the list\'s from the moment a store can be chosen (empty, a status), so choosing one changes its text to "Loading…" in place; the dialog\'s is in the dialog before "Loading this invoice…" is written into it', async () => {
    const server = seeded();
    issueAt(server, STORE_1, 2);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await click('issued-show');
    await storesReady();
    const region = tid('issued-list-state');
    expect(region).toHaveAttribute('role', 'status');
    expect(region.textContent).toBe('');
    expect(region).not.toHaveAttribute('data-phase');
    server.hold.list = 1;
    fireEvent.change(tid('issued-store'), { target: { value: STORE_1 } });
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(tid('issued-list-state')).toBe(region);
    expect(region).toHaveTextContent(LIST_TEXT.loading);
    server.held.shift()!.release();
    await listReady();
    expect(tid('issued-list-state')).toBe(region);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => { records.push(...list); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    server.hold.detail = 1;
    await user().click(openButton(1));
    await waitFor(() => expect(server.held).toHaveLength(1));
    const said = tid('issued-view-state');
    expect(said).toHaveTextContent(VIEW_TEXT.loading);
    await flush();
    observer.disconnect();
    // A record whose target is the region (or its text) means the text came after the region: it was not inserted with it.
    expect(records.some((r) => r.target === said || r.target.parentNode === said)).toBe(true);
    server.held.shift()!.release();
    await viewReady(1);
  });

  it('SII-67. the 429 wait is the whole section\'s: a list\'s 429 holds an Open (its dialog waits, no GET) and its Try again until the wait has passed; a dialog\'s 429 holds Load more (its reason said; a press reads nothing), another Open (no GET) and a store change (the wait said, Try again held, no list read); the timer reads nothing, and only a press reads again', async () => {
    const server = seeded();
    server.retryAfter = '30';
    issueAt(server, STORE_1, 25);
    server.issued.set(STORE_2, [invoice(1, { id: uuid(0x2a01), customerName: 'Second store 1' })]);
    render(<ServerIssuedInvoices {...rig(server).props()} />);
    await showAndChoose(STORE_1);
    await listReady();
    fakeClock();
    // A list's 429: the dialog of an Open waits with it.
    server.listStatus.push(429);
    fireEvent.click(tid('issued-load-more'));
    await until(() => expect(listPhase()).toBe('rate-limited'));
    fireEvent.click(openButton(25));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    expect(server.details()).toEqual([]);
    expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-view-retry')).toHaveAccessibleDescription(VIEW_TEXT.waiting);
    fireEvent.click(tid('issued-view-retry'));
    await flush();
    await advance(31_000);
    await until(() => expect(tid('issued-view-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.details()).toEqual([]); // the timer reads nothing
    fireEvent.click(tid('issued-view-retry'));
    await until(() => expect(viewPhase()).toBe('ready'));
    expect(server.details()).toHaveLength(1);
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('ready'));
    // A dialog's 429: Load more, another Open and a store change wait with it.
    server.detailStatus.push(429);
    fireEvent.click(openButton(25));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    const lists = server.lists().length;
    const details = server.details().length;
    expect(tid('issued-load-more')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-load-more')).toHaveAccessibleDescription(LIST_TEXT.waiting);
    fireEvent.click(tid('issued-load-more'));
    await flush();
    fireEvent.click(openButton(24));
    await until(() => expect(viewPhase()).toBe('rate-limited'));
    expect(tid('issued-view-state')).toHaveTextContent('Wait 30 seconds');
    fireEvent.click(tid('issued-view-close'));
    await until(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    fireEvent.change(tid('issued-store'), { target: { value: STORE_2 } });
    await until(() => expect(listPhase()).toBe('rate-limited'));
    expect(tid('issued-list-state')).toHaveTextContent('Wait 30 seconds');
    expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'true');
    expect(tid('issued-list-retry')).toHaveAccessibleDescription(LIST_TEXT.waiting);
    await flush();
    expect(server.lists()).toHaveLength(lists);
    expect(server.details()).toHaveLength(details);
    await advance(31_000);
    await until(() => expect(tid('issued-list-retry')).toHaveAttribute('aria-disabled', 'false'));
    await flush();
    expect(server.lists()).toHaveLength(lists); // the countdown gives Try again back; it never reads
    fireEvent.click(tid('issued-list-retry'));
    await until(() => expect(listPhase()).toBe('ready'));
    expect(server.lists(STORE_2)).toEqual([listPath(STORE_2)]);
    expect(customersShown()).toEqual(['Second store 1']);
  });

  it('SII-68. an invoice still open when an explicit sign-in renews the token closes together with the list read under the old token; focus is not left on the page body, and nothing is saved on its own', async () => {
    const server = seeded();
    server.staleLogins = true;
    issueAt(server, STORE_1, 3);
    const r = rig(server);
    const base = r.props().identity!;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const identity: ShopIdentity = { ...base, reauthenticate: async (uid, password) => { await gate; return base.reauthenticate(uid, password); } };
    render(<ServerIssuedInvoices {...r.props({ identity })} />);
    await openSettings();
    await listReady();
    fill();
    await click('issued-settings-save');
    await waitFor(() => expect(tid('issued-settings-reauth-group')).toBeInTheDocument());
    type('issued-settings-reauth-password', 'correct horse');
    await click('issued-settings-reauth-confirm'); // the sign-in is out
    await user().click(openButton(3));
    await viewReady(3);
    await act(async () => { release(); });
    await waitFor(() => expect(status()).toHaveTextContent(SETTINGS_TEXT.renewed));
    await waitFor(() => expect(screen.queryByTestId('issued-view')).toBeNull());
    expect(rows()).toEqual([]);
    expect(tid('issued-list-state')).toHaveTextContent(LIST_TEXT.renewed);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(server.puts_()).toHaveLength(1);
  });
});
