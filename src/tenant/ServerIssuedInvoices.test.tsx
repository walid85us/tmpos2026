// M7B-INVOICES-ISSUE-P2 — the Invoices page's "Issued invoices" section in jsdom, commit A: the store choice and the owner's
// issuing settings. The REAL section over the REAL tenant session, drafts (its store list) and issuing clients, each wired
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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ISSUED_TEXT, SETTINGS_RULE_TEXT, SETTINGS_TEXT, ServerIssuedInvoices, type ServerIssuedInvoicesProps } from './ServerIssuedInvoices';
import { createInvoiceIssuingClient, issuingSettingsPathOf } from './invoiceIssuingClient';
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

interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined }
interface User { uid: string; tenant: string; role: 'owner' | 'manager' }
type View = { storeId: string; version: number; configured: true; legalName: string; storeName: string; postalAddress: string; taxRegistrationId: string | null; tax: { mode: 'none' } | { mode: 'exclusive_rate'; rateMilliPercent: number } };
type Kind = 'stores' | 'settings' | 'put' | 'current';
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
    currentStatus: [] as number[],
    loginStatus: [] as number[], // what the next logins answer instead (in the chain's envelope): nothing is signed in
    retryAfter: null as string | null,
    staleLogins: false, // a plain login's sign-in is older than the recent-auth window (a reauthentication's never is)
    hold: { stores: 0, settings: 0, put: 0, current: 0 } as Record<Kind, number>,
    held: [] as Array<{ kind: Kind; url: string; release: (late?: Response) => void }>,
    puts_(): Sent[] { return server.sent.filter((r) => r.method === 'PUT'); },
    reads(storeId?: string): Sent[] { return server.sent.filter((r) => r.method === 'GET' && r.url.startsWith('/api/v1/issuing-settings/') && (storeId === undefined || r.url === issuingSettingsPathOf(storeId))); },
    logins(): Sent[] { return server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login); },
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
      server.sent.push({ method, url, headers, body });
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
