// M7A-CUSTOMERS-P9 — the server-customer picker and the draft's server-customer field in jsdom: the REAL tenant session
// and customers clients over one reduced fake tenant server at the network boundary (synthetic tenants, users and names
// only), copied from ServerCustomerDirectory.test.tsx's: a distinct CSRF token per session, a read refused 403 unless it
// carries its session's own token, sessions bound to tenants, and the list read with the server's own query parser,
// cursor codec and page order. Ordering is controlled with the fake's hold/release (no sleeps). Every assertion about a
// request is made on what the fake recorded — the wire — never on what the picker believes it sent. M7B-INVOICES-P1: two
// fields mounted at once (the invoice form's, closing, and the server draft dialog's) and a host's invalid mark (SCP-58);
// closing round: a sign-out heard by the open dialog — a read out when it begins, a Select after it, a 403's one fresh
// check that answered just before it, a rate limit's wait — and by a closed field's check that answered just before
// it, with the module's (UID, token) pair looked at, never made (SCP-59..63). M7B-INVOICES-P1-R2 (DA-202): a CLOSED
// field hears a sign-out itself, once, under StrictMode too and not after it unmounts, and a field that mounts holding a
// reference of a session that is over drops it at once (SCP-64..67).
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../firebase', () => ({ auth: { currentUser: null } }));
// The directory module (whose texts the picker shares) reads the access context; the picker never does.
vi.mock('../context/AccessContext', () => ({ useAccess: () => { throw new Error('the picker reads no access context'); } }));

import {
  NOT_AVAILABLE_TEXT, PICK_CHANGED_TEXT, PICK_DENIED_TEXT, PICK_ENDED_TEXT, PICKER_TEXT, ServerCustomerField, ServerCustomerPicker,
  hasSessionPair, idEndingText, isContextOf, isLiveContext, pickerWaitText, sessionContextOf,
} from './ServerCustomerPicker';
import {
  NO_CUSTOMER, localCustomerIdOf, localCustomerReference, serverCustomerReference, type ServerCustomerReference, type SessionContext,
} from './customerReference';
import { EMPTY_TEXT, LAST_KNOWN_TEXT, SEARCH_RULE_TEXT, searchMatchingText, searchNoneText } from './ServerCustomerDirectory';
import { createTenantSessionClient, sessionEndsSoFar, TENANT_SESSION_PATHS, type EnsureOptions, type TenantSessionClient } from './tenantSessionClient';
import { CUSTOMERS_PATH, createCustomersClient, type CustomerEntry } from './customersClient';
import { encodeCustomerCursor, encodeCustomerSearchCursor, parseCustomerDirectoryQuery } from '../../server/runtime/customerDirectory';
import { sessionSubjectOf } from '../../server/runtime/sessions';

const activeBody = (uid: string, csrfToken: string) =>
  ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);

type ReadPlan = number | 'html' | { readonly limited: string };
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly signal: AbortSignal | null }
interface User { uid: string; tenant: string; view: boolean }
type Late = Response | undefined;

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
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers } });
  const refuse = (status: number, headers: Record<string, string> = {}): Response => reply(status, { error: `e${status}`, requestId: 'req-synthetic' }, headers);
  const byteOrder = (x: CustomerEntry, y: CustomerEntry): number =>
    Buffer.compare(Buffer.from(x.name, 'utf8'), Buffer.from(y.name, 'utf8')) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const openSession = (user: User): string => {
    sessionCount += 1;
    const id = `session-${sessionCount}`;
    sessions.set(id, { user, csrf: `${'s'.repeat(40)}${String(sessionCount).padStart(3, '0')}` });
    return id;
  };

  const server = {
    sent: [] as Sent[],
    users,
    sessions,
    cookie: null as string | null,
    pageSize: 50,
    retryAfter: '1' as string | null,
    reads: [] as ReadPlan[], // the next list reads
    hold: { reads: 0, checks: 0 }, // answers to hold (checks: session reads): computed on arrival, released by the test
    held: [] as Array<{ url: string; release: (late?: Late) => void }>,
    down: false, // every request fails with no answer
    swapOnRead: null as string | null, // another tab signs in as this token's user just before the next list read arrives
    seed(tenant: string, names: readonly string[]): CustomerEntry[] {
      const made = names.map((name) => ({ id: uuid(++idCount), name }));
      rows[tenant].push(...made);
      return made;
    },
    /** Another tab signed in: the browser's cookie now names a NEW session of `token`'s user. */
    otherTab(token: string): void { server.cookie = openSession(users[token]); },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      server.sent.push({ method, url, headers, signal: init.signal ?? null });
      if (server.down) throw new TypeError('network');
      if (method === 'GET' && url.startsWith(CUSTOMERS_PATH) && server.swapOnRead !== null) {
        const token = server.swapOnRead;
        server.swapOnRead = null;
        server.otherTab(token);
      }
      const held = async (kind: 'reads' | 'checks', answer: Response): Promise<Response> => {
        if (server.hold[kind] > 0) {
          server.hold[kind] -= 1;
          const late = await new Promise<Late>((release) => { server.held.push({ url, release }); });
          if (late !== undefined) return late;
        }
        return answer;
      };
      if (url === TENANT_SESSION_PATHS.login && method === 'POST') {
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403);
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return refuse(401);
        server.cookie = openSession(user);
        return reply(200, activeBody(user.uid, sessions.get(server.cookie)!.csrf));
      }
      const session = server.cookie === null ? undefined : sessions.get(server.cookie);
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') {
        return held('checks', session === undefined ? refuse(401) : reply(200, activeBody(session.user.uid, session.csrf)));
      }
      if (method === 'GET' && url.split('?')[0] === CUSTOMERS_PATH) {
        const decide = (): Response => { // decided on arrival, as the server does
          const plan = server.reads.shift();
          if (plan === 429) return refuse(429, server.retryAfter === null ? {} : { 'retry-after': server.retryAfter });
          if (typeof plan === 'object') return refuse(429, { 'retry-after': plan.limited });
          if (session === undefined) return refuse(401);
          if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403); // another session's token
          if (!session.user.view) return refuse(403);
          if (plan === 'html') return new Response('<!doctype html><title>Shop</title>', { status: 200, headers: { 'content-type': 'text/html' } });
          if (typeof plan === 'number') return refuse(plan);
          const query = parseCustomerDirectoryQuery(url); // the server's own: q, cursor kinds, bounds
          if (query === null) return refuse(400);
          const all = [...rows[session.user.tenant]].sort(byteOrder);
          const anchor = query.after === null ? null : all.find((r) => r.id === query.after);
          if (anchor === undefined) return refuse(400);
          const { search } = query;
          const matching = search === null ? all : all.filter((r) => r.name.toUpperCase().includes(search.toUpperCase()));
          const rest = anchor === null ? matching : matching.filter((r) => byteOrder(r, anchor) > 0);
          const slice = rest.slice(0, server.pageSize);
          const last = slice[slice.length - 1];
          const next = rest.length <= server.pageSize ? null : search === null ? encodeCustomerCursor(last.id) : encodeCustomerSearchCursor(last.id, search);
          return reply(200, { customers: slice, nextCursor: next });
        };
        return held('reads', decide());
      }
      return refuse(404); // nothing else exists here: a write would be recorded, and refused
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

/** The real clients over `server`, and the signed-in user's ID tokens: made ONCE per test (stable injectables). */
function clients(server: Server, tokens: Record<string, string> = { 'uid-a': 'tok-a', 'uid-b': 'tok-b' }) {
  return {
    session: createTenantSessionClient({ fetch: server.fetch }),
    customers: createCustomersClient({ fetch: server.fetch }),
    identity: { idToken: async (uid: string) => tokens[uid] ?? null },
  };
}
type Clients = ReturnType<typeof clients>;

function mountPicker(server: Server, options: { tokens?: Record<string, string>; uid?: string; now?: () => number } = {}) {
  const calls = { select: [] as ServerCustomerReference[], cancel: 0, lost: [] as string[], context: [] as SessionContext[] };
  const view = render(
    <ServerCustomerPicker
      uid={options.uid ?? 'uid-a'}
      onSelect={(ref) => { calls.select.push(ref); }}
      onCancel={() => { calls.cancel += 1; }}
      onLost={(why) => { calls.lost.push(why); }}
      onContext={(context) => { calls.context.push(context); }}
      {...clients(server, options.tokens)}
      now={options.now}
    />,
  );
  return { ...view, calls };
}

type Why = Parameters<Parameters<typeof ServerCustomerField>[0]['onChange']>[1];
/** The draft side: holds the value the field reports, as a parent would. */
function Draft({ uid, canView = true, inject, log }: { uid: string | null; canView?: boolean; inject: Clients; log: Array<{ next: ServerCustomerReference | null; why: Why }> }) {
  const [value, setValue] = useState<ServerCustomerReference | null>(null);
  return <ServerCustomerField uid={uid} value={value} canView={canView} onChange={(next, why) => { log.push({ next, why }); setValue(next); }} {...inject} />;
}
function mountField(server: Server, options: { uid?: string | null; canView?: boolean; inject?: Clients } = {}) {
  const inject = options.inject ?? clients(server);
  const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
  const uid = options.uid === undefined ? 'uid-a' : options.uid;
  const draft = (props: { uid?: string | null; canView?: boolean; draftKey?: string } = {}) => (
    <Draft key={props.draftKey ?? 'draft-1'} uid={props.uid === undefined ? uid : props.uid} canView={props.canView ?? options.canView ?? true} inject={inject} log={log} />
  );
  const view = render(draft());
  return { ...view, log, inject, again: (props: Parameters<typeof draft>[0]) => view.rerender(draft(props)) };
}

const realSetTimeout = globalThis.setTimeout; // the fake clock's tests still drain promises on a real macrotask
const flush = () => act(async () => { await new Promise((r) => realSetTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
/** The microtask on which the last field's unmount forgets the pair (M7B-INVOICES-P1-R2). */
const microtask = () => act(async () => { await Promise.resolve(); });
const state = () => screen.getByTestId('picker-state');
const phase = (): string | null => state().getAttribute('data-phase');
const ready = () => waitFor(() => expect(phase()).toBe('ready'));
const rows = () => screen.queryAllByTestId('picker-row');
const names = (): string[] => rows().map((r) => r.querySelector('p')?.textContent ?? '');
const ids = (): string[] => rows().map((r) => r.getAttribute('data-id') ?? '');
const searchInput = () => screen.getByTestId('picker-search-input') as HTMLInputElement;
const click = async (testId: string) => { await userEvent.setup().click(screen.getByTestId(testId)); };
const selectRow = async (id: string) => {
  const row = rows().find((r) => r.getAttribute('data-id') === id)!;
  await userEvent.setup().click(within(row).getByTestId('picker-select'));
};
/** Put `text` in the search box (no request), then apply it by the Search button or by Enter. */
const searchFor = async (text: string, how: 'button' | 'enter' = 'button') => {
  fireEvent.change(searchInput(), { target: { value: text } });
  if (how === 'button') await click('picker-search-submit');
  else await userEvent.setup().type(searchInput(), '{Enter}');
};
const lists = (s: Server) => s.sent.filter((r) => r.method === 'GET' && r.url.split('?')[0] === CUSTOMERS_PATH);
const listUrls = (s: Server, from = 0) => lists(s).slice(from).map((r) => r.url);
const logins = (s: Server) => s.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login);
const checks = (s: Server) => s.sent.filter((r) => r.method === 'GET' && r.url === TENANT_SESSION_PATHS.current);
const writes = (s: Server) => s.sent.filter((r) => r.method !== 'GET' && r.url.startsWith(CUSTOMERS_PATH));
const dialog = () => screen.queryByTestId('picker-dialog');
const focusWindow = async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
};
const numbered = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix} ${String(i).padStart(2, '0')}`);
const SAMPLE_NAMES = ['Alexander Wright', 'Sarah Jenkins', 'Mike Rodriguez', 'Emma Chen', 'David Park']; // the local seed list
/** A late answer that WOULD reach the draft if a stale guard were missing: the read refused 401 (signed out → onLost). */
const late401 = (): Response => new Response(JSON.stringify({ error: 'e401', requestId: 'req-synthetic' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } });
/** A fake clock for the rate limit's wait (timers and Date; `now` reads it), driven only by `advance` — never waitFor. */
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** waitFor for the fake clock's tests: re-check after each real macrotask (bounded), never on a faked timer. */
const until = async (check: () => void) => {
  for (let i = 0; ; i++) {
    try { check(); return; } catch (error) { if (i >= 200) throw error; await flush(); }
  }
};
const controls = () => ['picker-search-submit', 'picker-search-clear', 'picker-retry'].map((id) => screen.getByTestId(id));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('customerReference (M7A-CUSTOMERS-P9)', () => {
  it('SCP-01. a draft names none, a local customer or a server customer — frozen; a server reference copies only the id and the name, and only of a server id with a name', () => {
    expect(NO_CUSTOMER).toEqual({ source: 'none' });
    expect(Object.isFrozen(NO_CUSTOMER)).toBe(true);
    expect(localCustomerReference('')).toBe(NO_CUSTOMER); // the select's "Select Customer…"
    const local = localCustomerReference('c1');
    expect(local).toEqual({ source: 'local', id: 'c1' });
    expect(Object.isFrozen(local)).toBe(true);
    expect(localCustomerIdOf(local)).toBe('c1');
    expect(localCustomerIdOf(NO_CUSTOMER)).toBe('');
    const context = sessionContextOf('uid-a', 'x'.repeat(43), sessionEndsSoFar());
    const entry = { id: uuid(0xa01), name: 'Ada Lovelace', phone: '555-0100', email: 'ada@example.test' } as CustomerEntry;
    const ref = serverCustomerReference(entry, 'uid-a', context);
    expect(ref).toEqual({ source: 'server', id: entry.id, name: 'Ada Lovelace', uid: 'uid-a', context });
    expect(Object.keys(ref!).sort()).toEqual(['context', 'id', 'name', 'source', 'uid']); // no contact field rides along
    expect(ref!.context).toBe(context);
    expect(Object.isFrozen(ref)).toBe(true);
    expect(localCustomerIdOf(ref!)).toBe(''); // never a local id
    expect(serverCustomerReference({ id: 'c1', name: 'Ada' }, 'uid-a', context)).toBeNull(); // a local id is not a server id
    expect(serverCustomerReference({ id: entry.id.toUpperCase(), name: 'Ada' }, 'uid-a', context)).toBeNull();
    expect(serverCustomerReference({ id: entry.id, name: '' }, 'uid-a', context)).toBeNull();
    expect(serverCustomerReference({ id: entry.id, name: 7 as unknown as string }, 'uid-a', context)).toBeNull();
  });

  it('SCP-02. sessionContextOf: the same frozen opaque object for the same (UID, token) as the last call, a new one otherwise; only the latest pair is kept; a comparison (isContextOf) creates nothing; after a sign-out a session confirmed before it gets an object kept nowhere', () => {
    const [tokA, tokB] = ['a'.repeat(43), 'b'.repeat(43)];
    const now = sessionEndsSoFar;
    const first = sessionContextOf('uid-a', tokA, now());
    expect(sessionContextOf('uid-a', tokA, now())).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.ownKeys(first)).toEqual([]); // no token, nothing inside
    expect(JSON.stringify(first)).toBe('{}');
    expect(isContextOf(first, 'uid-a', tokA)).toBe(true);
    expect([isContextOf(first, 'uid-a', tokB), isContextOf(first, 'uid-b', tokA)]).toEqual([false, false]);
    expect(isContextOf(first, 'uid-a', tokA)).toBe(true); // those comparisons replaced nothing
    const other = sessionContextOf('uid-a', tokB, now());
    expect(other).not.toBe(first);
    expect(sessionContextOf('uid-a', tokA, now())).not.toBe(first); // the earlier pair was not kept
    expect(sessionContextOf('uid-b', tokA, now())).not.toBe(sessionContextOf('uid-a', tokA, now())); // another user is another context
    // A sign-out (here a reset: it tells the same listeners, and sends nothing) forgets the pair; a token confirmed by an
    // answer asked for before it mints a context kept nowhere — a new one on every call, matching nothing, no pair kept.
    const before = now();
    const kept = sessionContextOf('uid-a', tokA, before);
    createTenantSessionClient({ fetch: async () => { throw new Error('nothing is sent'); } }).reset();
    expect(hasSessionPair()).toBe(false);
    const late = sessionContextOf('uid-a', tokA, before);
    expect(late).not.toBe(kept);
    expect(sessionContextOf('uid-a', tokA, before)).not.toBe(late);
    expect(Object.isFrozen(late)).toBe(true);
    expect([hasSessionPair(), isContextOf(late, 'uid-a', tokA), isContextOf(kept, 'uid-a', tokA)]).toEqual([false, false, false]);
    expect(isContextOf(sessionContextOf('uid-a', tokA, now()), 'uid-a', tokA)).toBe(true); // confirmed since: kept again
  });
});

describe('ServerCustomerPicker (M7A-CUSTOMERS-P9)', () => {
  it('SCP-03. a labelled modal dialog: focus in the search box, page one read like the directory (session first, one login), nothing chosen on its own; Escape and Cancel cancel', async () => {
    const server = fakeServer();
    const [solo] = server.seed(TENANT_A, ['Solo']);
    const { calls } = mountPicker(server);
    const box = screen.getByRole('dialog', { name: 'Select a customer' });
    expect(box).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(searchInput());
    expect(screen.getByRole('search')).toContainElement(searchInput());
    expect(screen.getByLabelText('Search customers by name')).toBe(searchInput());
    await ready();
    expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`,
    ]);
    expect(names()).toEqual(['Solo']);
    expect(within(rows()[0]).getByText(idEndingText(solo.id))).toBeInTheDocument();
    expect(within(rows()[0]).getByRole('button', { name: 'Select Solo' })).toBeEnabled();
    expect(calls.select).toEqual([]); // a single match is never chosen for the user
    expect(calls.context).toHaveLength(1);
    await userEvent.setup().keyboard('{Escape}');
    expect(calls.cancel).toBe(1);
    await click('picker-cancel');
    expect(calls.cancel).toBe(2);
    expect(calls.select).toEqual([]);
    expect(calls.lost).toEqual([]);
  });

  it('SCP-04. AC-01: a customer beyond page one is reached by Load more (rows appended once per id, in arrival order) and the exact id is chosen, bound to this user and session', async () => {
    const server = fakeServer();
    const seeded = server.seed(TENANT_A, numbered('Customer', 60));
    const { calls } = mountPicker(server);
    await ready();
    expect(names()).toEqual(numbered('Customer', 50));
    const target = seeded[55];
    expect(ids()).not.toContain(target.id);
    // The next page arrives carrying a row already shown (it moved): it is appended once.
    server.hold.reads = 1;
    await click('picker-load-more');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(server.held[0].url).toMatch(/^\/api\/v1\/customers\?cursor=[A-Za-z0-9_-]{23}$/);
    await act(async () => {
      server.held[0].release(new Response(JSON.stringify({ customers: [seeded[49], ...seeded.slice(50)], nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(names()).toEqual(numbered('Customer', 60));
    expect(screen.queryByTestId('picker-load-more')).toBeNull();
    await selectRow(target.id);
    expect(calls.select).toHaveLength(1);
    expect(calls.select[0]).toEqual({ source: 'server', id: target.id, name: 'Customer 55', uid: 'uid-a', context: calls.context[0] });
    expect(Object.isFrozen(calls.select[0])).toBe(true);
  });

  it('SCP-05. AC-01: a search (Enter) reaches a customer beyond page one; typing alone sends nothing; the exact id is chosen', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, numbered('Kestrel', 60));
    const [plover] = server.seed(TENANT_A, ['Zed Plover']);
    const { calls } = mountPicker(server);
    await ready();
    expect(ids()).not.toContain(plover.id);
    const before = lists(server).length;
    fireEvent.change(searchInput(), { target: { value: '  plover ' } });
    await settle();
    expect(lists(server)).toHaveLength(before); // the draft is not a search
    await userEvent.setup().type(searchInput(), '{Enter}');
    await waitFor(() => expect(names()).toEqual(['Zed Plover']));
    expect(listUrls(server, before)).toEqual([`${CUSTOMERS_PATH}?q=plover`]); // trimmed, applied
    expect(screen.getByTestId('picker-search-summary')).toHaveTextContent(searchMatchingText('plover'));
    await selectRow(plover.id);
    expect(calls.select.map((r) => [r.id, r.name])).toEqual([[plover.id, 'Zed Plover']]);
  });

  it('SCP-06. AC-02: two customers with the same name stay distinguishable by their id ending, and the chosen one is the one bound', async () => {
    const server = fakeServer();
    const [first, second] = server.seed(TENANT_A, ['Sam Lee', 'Sam Lee', 'Other']);
    const { calls } = mountPicker(server);
    await ready();
    expect(names()).toEqual(['Other', 'Sam Lee', 'Sam Lee']);
    const sams = rows().filter((r) => r.getAttribute('data-id') !== null && r.textContent!.includes('Sam Lee'));
    expect(sams.map((r) => r.getAttribute('data-id'))).toEqual([first.id, second.id]);
    expect(within(sams[0]).getByText(idEndingText(first.id))).toBeInTheDocument();
    expect(within(sams[1]).getByText(idEndingText(second.id))).toBeInTheDocument();
    expect(idEndingText(first.id)).not.toBe(idEndingText(second.id));
    await selectRow(second.id);
    expect(calls.select.map((r) => r.id)).toEqual([second.id]);
  });

  it('SCP-07. Load more reads the APPLIED search with its own cursor, whatever the box says; a new search drops the rows and the cursor', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, numbered('Kestrel', 60));
    server.seed(TENANT_A, numbered('Plover', 5));
    mountPicker(server);
    await ready();
    const from = lists(server).length;
    await searchFor('kes');
    await waitFor(() => expect(names()).toEqual(numbered('Kestrel', 50)));
    fireEvent.change(searchInput(), { target: { value: 'plo' } }); // a draft only
    await click('picker-load-more');
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(screen.getByTestId('picker-search-summary')).toHaveTextContent(searchMatchingText('kes'));
    const [first, more] = listUrls(server, from);
    expect(first).toBe(`${CUSTOMERS_PATH}?q=kes`);
    expect(more).toMatch(/^\/api\/v1\/customers\?q=kes&cursor=[A-Za-z0-9_-]{44}$/);
    await click('picker-search-submit'); // now 'plo' is applied
    await waitFor(() => expect(names()).toEqual(numbered('Plover', 5)));
    expect(listUrls(server, from).slice(2)).toEqual([`${CUSTOMERS_PATH}?q=plo`]);
    expect(screen.queryByTestId('picker-load-more')).toBeNull();
  });

  it('SCP-08. a search text the server would refuse is said and nothing is sent; Clear empties the box and the applied search and reads page one', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    mountPicker(server);
    await ready();
    await searchFor('Bea');
    await waitFor(() => expect(names()).toEqual(['Bea']));
    const before = server.sent.length;
    await searchFor('Ada\u0007');
    expect(screen.getByTestId('picker-search-error')).toHaveTextContent(SEARCH_RULE_TEXT);
    expect(searchInput()).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(searchInput());
    expect(server.sent).toHaveLength(before); // nothing at all left
    expect(names()).toEqual(['Bea']); // the applied search still stands
    await click('picker-search-clear');
    await waitFor(() => expect(names()).toEqual(['Ada', 'Bea']));
    expect(searchInput().value).toBe('');
    expect(listUrls(server).at(-1)).toBe(CUSTOMERS_PATH);
    expect(screen.queryByTestId('picker-search-summary')).toBeNull();
    expect(screen.queryByTestId('picker-search-error')).toBeNull();
  });

  it('SCP-09. AC-07: loading, then the empty store (never before an answer), and a search with no match — each its own text, and no sample customer anywhere', async () => {
    const server = fakeServer();
    server.hold.reads = 1;
    mountPicker(server);
    expect(phase()).toBe('loading');
    expect(state()).toHaveTextContent(PICKER_TEXT.loading);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(screen.queryByTestId('picker-empty')).toBeNull();
    await act(async () => { server.held[0].release(); });
    await ready();
    expect(screen.getByTestId('picker-empty')).toHaveTextContent(EMPTY_TEXT);
    expect(screen.queryByTestId('picker-search-none')).toBeNull();
    await searchFor('zz');
    await waitFor(() => expect(screen.getByTestId('picker-search-none')).toHaveTextContent(searchNoneText('zz')));
    expect(screen.queryByTestId('picker-empty')).toBeNull();
    const text = dialog()!.textContent ?? '';
    for (const sample of SAMPLE_NAMES) expect(text).not.toContain(sample);
    expect(rows()).toHaveLength(0);
  });

  it('SCP-10. AC-07: a rate-limited page one disables Search, Clear and Try again until EXACTLY the Retry-After has passed (still disabled 1 ms before), keeps saying what to do, reads nothing on its own; no Retry-After waits 60 s', async () => {
    fakeClock();
    const server = fakeServer();
    server.retryAfter = '3';
    server.reads.push(429);
    mountPicker(server, { now: () => Date.now() });
    await until(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent(pickerWaitText(3));
    expect(pickerWaitText(1)).toBe('Too many requests. Wait 1 second, then try again.');
    expect(pickerWaitText(30)).toBe('Too many requests. Wait 30 seconds, then try again.');
    fireEvent.change(searchInput(), { target: { value: 'Ada' } });
    for (const control of controls()) expect(control).toBeDisabled();
    expect(screen.getByTestId('picker-search-hint')).toHaveTextContent('Wait 3 seconds.');
    expect(screen.queryByTestId('picker-empty')).toBeNull();
    const after = lists(server).length;
    await advance(2999);
    for (const control of controls()) expect(control).toBeDisabled();
    await advance(1);
    for (const control of controls()) expect(control).toBeEnabled();
    expect(state()).toHaveTextContent(pickerWaitText(3)); // still true once the wait is over
    await advance(120_000);
    await settle();
    expect(lists(server)).toHaveLength(after); // the wait's end reads nothing
    // A 429 with no Retry-After: the default 60 s, to the millisecond.
    server.retryAfter = null;
    server.reads.push(429);
    fireEvent.click(screen.getByTestId('picker-retry'));
    await until(() => expect(state()).toHaveTextContent(pickerWaitText(60)));
    expect(lists(server)).toHaveLength(after + 1);
    await advance(59_999);
    for (const control of controls()) expect(control).toBeDisabled();
    await advance(1);
    for (const control of controls()) expect(control).toBeEnabled();
    fireEvent.click(screen.getByTestId('picker-retry'));
    await until(() => expect(phase()).toBe('ready'));
    expect(lists(server)).toHaveLength(after + 2);
  });

  it('SCP-11. AC-07: a rate-limited Load more keeps the rows under the last-known label, offers no Load more, and Try again — enabled exactly at the Retry-After — reads page one of the applied search', async () => {
    fakeClock();
    const server = fakeServer();
    server.seed(TENANT_A, numbered('Kestrel', 60));
    mountPicker(server, { now: () => Date.now() });
    await until(() => expect(phase()).toBe('ready'));
    fireEvent.change(searchInput(), { target: { value: 'kes' } });
    fireEvent.submit(screen.getByTestId('picker-search'));
    await until(() => expect(screen.getByTestId('picker-search-summary')).toHaveTextContent(searchMatchingText('kes')));
    expect(names()).toHaveLength(50);
    server.reads.push({ limited: '2' });
    fireEvent.click(screen.getByTestId('picker-load-more'));
    await until(() => expect(phase()).toBe('rate-limited'));
    expect(names()).toHaveLength(50);
    expect(screen.getByTestId('picker-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
    expect(screen.queryByTestId('picker-load-more')).toBeNull();
    await advance(1999);
    expect(screen.getByTestId('picker-retry')).toBeDisabled();
    await advance(1);
    expect(screen.getByTestId('picker-retry')).toBeEnabled();
    const from = lists(server).length;
    fireEvent.click(screen.getByTestId('picker-retry'));
    await until(() => expect(phase()).toBe('ready'));
    expect(listUrls(server, from)).toEqual([`${CUSTOMERS_PATH}?q=kes`]);
  });

  it('SCP-12. AC-07: an outage is "unavailable" with Try again — never the empty or no-match text — and Try again recovers', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    server.down = true;
    mountPicker(server);
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(state()).toHaveTextContent(PICKER_TEXT.unavailable);
    expect(screen.queryByTestId('picker-empty')).toBeNull();
    expect(screen.queryByTestId('picker-search-none')).toBeNull();
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Try again');
    server.down = false;
    await click('picker-retry');
    await ready();
    expect(names()).toEqual(['Bob']);
  });

  it('SCP-13. AC-07: a malformed 200 and a 503 are "unavailable" too, never an empty list', async () => {
    const server = fakeServer();
    server.reads.push('html', 503);
    mountPicker(server);
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(screen.queryByTestId('picker-empty')).toBeNull();
    await click('picker-retry');
    await waitFor(() => expect(lists(server)).toHaveLength(2));
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(screen.queryByTestId('picker-empty')).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('SCP-14. AC-07: nobody signed in with the store (no ID token): signed out, the draft told "ended", Reconnect offered, no login sent', async () => {
    const server = fakeServer();
    const { calls } = mountPicker(server, { tokens: {} });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(PICKER_TEXT.noIdentity);
    expect(calls.lost).toEqual(['ended']);
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Reconnect');
    expect(screen.getByTestId('picker-search-submit')).toBeDisabled();
    expect(screen.getByTestId('picker-search-hint')).toHaveTextContent('Reconnect to search.');
    expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(screen.queryByTestId('picker-empty')).toBeNull();
  });

  it('SCP-15. AC-07: a list read refused 401 clears the rows, the applied search and the search box, and tells the draft "ended"', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    const { calls } = mountPicker(server);
    await ready();
    server.reads.push(401);
    await searchFor('Bea');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(PICKER_TEXT.ended);
    expect(rows()).toHaveLength(0);
    expect(searchInput().value).toBe('');
    expect(screen.queryByTestId('picker-search-summary')).toBeNull();
    expect(calls.lost).toEqual(['ended']);
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Reconnect');
  });

  it('SCP-16. AC-05: a session that ended: a search finds it ended with NO login and clears everything; only Reconnect logs in (once), with a new context and no "connection changed"', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    const { calls } = mountPicker(server);
    await ready();
    expect(logins(server)).toHaveLength(1);
    server.sessions.clear(); // expired or revoked in the store; the browser still presents its cookie
    await searchFor('Bea');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(PICKER_TEXT.ended);
    expect(logins(server)).toHaveLength(1); // never re-established on its own
    expect(rows()).toHaveLength(0);
    expect(searchInput().value).toBe('');
    expect(calls.lost).toEqual(['ended']);
    expect(screen.getByTestId('picker-search-submit')).toBeDisabled();
    await click('picker-retry');
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(names()).toEqual(['Ada', 'Bea']); // unfiltered
    // The Reconnect's token is a FIRST token after a confirmed end: a new context, not a "connection changed".
    expect(calls.lost).toEqual(['ended']);
    expect(calls.context).toHaveLength(2);
    expect(calls.context[1]).not.toBe(calls.context[0]);
    expect(screen.queryByTestId('picker-connection-changed')).toBeNull();
  });

  it('SCP-17. AC-05: the session token changes while a read is out — the old answer is discarded, the draft told "changed" once, and page one read again under the new token', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    const { calls } = mountPicker(server);
    await ready();
    server.hold.reads = 1;
    await searchFor('Bea');
    await waitFor(() => expect(server.held).toHaveLength(1));
    const old = lists(server).at(-1)!;
    server.otherTab('tok-a'); // another tab signed in: a new session (and token) for the same user
    fireEvent.change(searchInput(), { target: { value: 'Ad' } });
    await click('picker-search-submit');
    await ready();
    expect(calls.lost).toEqual(['changed']);
    expect(calls.context).toHaveLength(2);
    expect(screen.getByTestId('picker-connection-changed')).toHaveTextContent(PICKER_TEXT.connection);
    expect(names()).toEqual(['Ada', 'Bea']); // a new generation starts unfiltered
    expect(searchInput().value).toBe('');
    expect(old.signal?.aborted).toBe(true);
    await act(async () => { server.held[0].release(); });
    await settle();
    expect(names()).toEqual(['Ada', 'Bea']);
    expect(screen.queryByTestId('picker-search-summary')).toBeNull();
    expect(lists(server).at(-1)!.headers.get('x-tmpos-session-csrf')).not.toBe(old.headers.get('x-tmpos-session-csrf'));
  });

  it('SCP-18. AC-06: a read refused 403 because another tab replaced the cookie: ONE fresh session check finds the new token — a new connection, never "denied"', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    const { calls } = mountPicker(server);
    await ready();
    const before = checks(server).length;
    server.swapOnRead = 'tok-a';
    await searchFor('Ad');
    await ready();
    expect(checks(server).length - before).toBe(3); // the read's own, the one check after the 403, the new generation's read
    expect(calls.lost).toEqual(['changed']);
    expect(names()).toEqual(['Ada']);
    expect(logins(server)).toHaveLength(1); // the other tab's session is taken with no login
  });

  it('SCP-19. AC-06: a user who may not view: the 403 is confirmed by one fresh check of the SAME token — denied, nothing shown, the draft told "denied"', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    server.users['tok-a'].view = false;
    const { calls } = mountPicker(server);
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(state()).toHaveAttribute('role', 'alert');
    expect(state()).toHaveTextContent(PICKER_TEXT.denied);
    expect(rows()).toHaveLength(0);
    expect(screen.queryByTestId('picker-empty')).toBeNull();
    expect(calls.lost).toEqual(['denied']);
    expect(checks(server)).toHaveLength(3); // the first read's two (before and after the login), and the one fresh check
    expect(logins(server)).toHaveLength(1);
  });

  it('SCP-20. AC-06: access lost while the dialog is open (Load more refused 403): the rows, the cursor and the applied search go, and the draft is told "denied"', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, numbered('Kestrel', 60));
    const { calls } = mountPicker(server);
    await ready();
    await searchFor('kes');
    await waitFor(() => expect(names()).toHaveLength(50));
    server.users['tok-a'].view = false;
    await click('picker-load-more');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(rows()).toHaveLength(0);
    expect(screen.queryByTestId('picker-load-more')).toBeNull();
    expect(screen.queryByTestId('picker-search-summary')).toBeNull();
    expect(calls.lost).toEqual(['denied']);
    expect(calls.select).toEqual([]);
  });

  it('SCP-21. a cursor the server no longer accepts on Load more: ONE page-one reload with a note; the reload refused again is unavailable, never a loop', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, numbered('Customer', 60));
    mountPicker(server);
    await ready();
    server.reads.push(400);
    await click('picker-load-more');
    await waitFor(() => expect(screen.getByTestId('picker-note')).toHaveTextContent(PICKER_TEXT.reloaded));
    await ready();
    expect(names()).toEqual(numbered('Customer', 50));
    expect(lists(server)).toHaveLength(3);
    server.reads.push(400, 400);
    await click('picker-load-more');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    await settle();
    expect(lists(server)).toHaveLength(5); // the refused continuation and its one reload
    expect(lists(server)[4].url).toBe(CUSTOMERS_PATH);
  });

  it('SCP-22. AC-08: an older search\'s answer that arrives after a newer one changes nothing', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    mountPicker(server);
    await ready();
    server.hold.reads = 2;
    await searchFor('Ada');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await searchFor('Bea');
    await waitFor(() => expect(server.held).toHaveLength(2));
    const [older, newer] = server.held;
    expect(older.url).toBe(`${CUSTOMERS_PATH}?q=Ada`);
    expect(lists(server).at(-2)!.signal?.aborted).toBe(true);
    await act(async () => { newer.release(); });
    await waitFor(() => expect(names()).toEqual(['Bea']));
    await act(async () => { older.release(); });
    await settle();
    expect(names()).toEqual(['Bea']);
    expect(screen.getByTestId('picker-search-summary')).toHaveTextContent(searchMatchingText('Bea'));
  });

  it('SCP-23. AC-08: unmounting aborts the read in flight, and its later answer — a 401 that would say "ended" — changes nothing and reports nothing', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    server.hold.reads = 1;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = mountPicker(server);
    await waitFor(() => expect(server.held).toHaveLength(1));
    view.unmount();
    expect(lists(server)[0].signal?.aborted).toBe(true);
    expect(dialog()).toBeNull();
    await act(async () => { server.held[0].release(late401()); });
    await settle();
    expect(view.calls.select).toEqual([]);
    expect(view.calls.lost).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('ServerCustomerField (M7A-CUSTOMERS-P9)', () => {
  it('SCP-24. no signed-in user: nothing; a role that may not view: one muted line and no entry point; otherwise "Select a server customer"', async () => {
    const server = fakeServer();
    const { container, again } = mountField(server, { uid: null });
    expect(container).toBeEmptyDOMElement();
    again({ uid: 'uid-a', canView: false });
    expect(screen.getByTestId('picker-unavailable')).toHaveTextContent(NOT_AVAILABLE_TEXT);
    expect(screen.queryByTestId('picker-open')).toBeNull();
    again({ uid: 'uid-a', canView: true });
    expect(screen.getByTestId('picker-open')).toHaveTextContent('Select a server customer');
    expect(screen.queryByTestId('picker-unavailable')).toBeNull();
    expect(server.sent).toEqual([]); // nothing is read before the dialog opens
  });

  it('SCP-25. AC-04: selecting fills the draft with an unmistakable server customer (badge, name, id ending, Change, Remove), focus on Change — and nothing is written', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    expect(document.activeElement).toBe(searchInput());
    await ready();
    await selectRow(bob.id);
    expect(dialog()).toBeNull();
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected']]);
    const card = screen.getByTestId('picker-value');
    expect(card).toHaveAttribute('data-id', bob.id);
    expect(within(card).getByTestId('picker-value-badge')).toHaveTextContent('Server customer');
    expect(within(card).getByTestId('picker-value-name')).toHaveTextContent('Bob');
    expect(card).toHaveTextContent(idEndingText(bob.id));
    expect(document.activeElement).toBe(screen.getByTestId('picker-change'));
    expect(screen.getByTestId('picker-remove')).toBeInTheDocument();
    expect(screen.queryByTestId('picker-notice')).toBeNull();
    expect(writes(server)).toEqual([]);
  });

  it('SCP-26. AC-04: Change then Escape keeps the customer (focus back on Change); Change then another row replaces it — nothing is written', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    await click('picker-change');
    await ready();
    await userEvent.setup().keyboard('{Escape}');
    expect(dialog()).toBeNull();
    expect(log).toHaveLength(1);
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bob.id);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('picker-change')));
    await click('picker-change');
    await ready();
    await selectRow(ada.id);
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [ada.id, 'selected']]);
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada.id);
    expect(writes(server)).toEqual([]);
  });

  it('SCP-27. AC-04: Remove clears the draft\'s server customer (focus on "Select a server customer"), with no notice and nothing written', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    await click('picker-remove');
    expect(log.map((e) => [e.next, e.why])).toEqual([[expect.objectContaining({ id: bob.id }), 'selected'], [null, 'removed']]);
    expect(screen.queryByTestId('picker-value')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('picker-open')));
    expect(screen.queryByTestId('picker-notice')).toBeNull();
    expect(writes(server)).toEqual([]);
  });

  it('SCP-28. AC-05: the session ended — reopening finds it ended: the customer is removed with the ended notice, once, and the dialog stays open on its own Reconnect', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.sessions.clear();
    await click('picker-change');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'ended']]);
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(screen.getByTestId('picker-notice')).toHaveAttribute('role', 'alert');
    expect(dialog()).not.toBeNull();
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Reconnect');
    expect(logins(server)).toHaveLength(1);
  });

  it('SCP-29. AC-05: reopened under another session (another tab signed in): its first context is not the customer\'s — removed with the changed notice, once', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.otherTab('tok-a');
    await click('picker-change');
    await ready();
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'changed']]);
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_CHANGED_TEXT);
    expect(names()).toEqual(['Bob']); // the dialog itself simply reads under the session it found
  });

  it('SCP-39. AC-05: the connection changes while the dialog is open on the customer\'s own session: a new context and "changed" both arrive, and the customer is removed exactly once', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob', 'Bobby']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    await click('picker-change');
    await ready();
    expect(log).toHaveLength(1); // the same session: the customer stays while the dialog is open
    server.otherTab('tok-a');
    await searchFor('Bobby');
    await waitFor(() => expect(screen.getByTestId('picker-connection-changed')).toBeInTheDocument());
    await ready();
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'changed']]);
    expect(screen.getAllByTestId('picker-notice')).toHaveLength(1);
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_CHANGED_TEXT);
  });

  it('SCP-30. AC-06: reopened by a user who may no longer view: the customer is removed with the denied notice', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.users['tok-a'].view = false;
    await click('picker-change');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'denied']]);
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_DENIED_TEXT);
  });

  it('SCP-31. AC-05: with the dialog closed, a window focus checks the session once (plain): undecided keeps the customer, another token removes it as "changed"', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    const before = checks(server).length;
    server.down = true;
    await focusWindow();
    await settle();
    expect(checks(server)).toHaveLength(before + 1);
    expect(log).toHaveLength(1); // an outage decides nothing
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bob.id);
    server.down = false;
    await focusWindow(); // the same session again: nothing changes
    await settle();
    expect(log).toHaveLength(1);
    server.otherTab('tok-a');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(log.map((e) => e.why)).toEqual(['selected', 'changed']));
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_CHANGED_TEXT);
    expect(logins(server)).toHaveLength(1);
    expect(writes(server)).toEqual([]);
  });

  it('SCP-32. AC-05: with the dialog closed, a focus that finds the session ended removes the customer as "ended" and signs nothing in', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'ended']]));
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(logins(server)).toHaveLength(1);
  });

  it('SCP-33. AC-08: a focus check still out when the field goes away: its answer changes nothing, and the listener is gone', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log, unmount } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.sessions.clear();
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1));
    unmount();
    await act(async () => { server.held[0].release(); });
    await settle();
    const sent = server.sent.length;
    await focusWindow();
    await settle();
    expect(server.sent).toHaveLength(sent); // no listener left
    expect(log.map((e) => e.why)).toEqual(['selected']);
  });

  it('SCP-34. AC-08: a dialog that has closed leaves nothing to choose with: its Select buttons are gone from the page, and nothing is bound', async () => {
    // A click on the detached button would reach no React handler at all, so it would prove nothing about select()'s
    // own guard (that is SCP-35..37's late answers): what this shows is that Cancel takes every control with it.
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    const stale = screen.getByTestId('picker-select');
    await click('picker-cancel');
    expect(dialog()).toBeNull();
    expect(stale.isConnected).toBe(false);
    expect(screen.queryAllByTestId('picker-select')).toEqual([]);
    await settle();
    expect(log).toEqual([]);
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
  });

  it('SCP-35. AC-08: a previous field instance (an earlier draft) cannot bind or drop: its read answered (401) after the new draft mounted reaches nobody', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log, again } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.hold.reads = 1;
    await click('picker-change');
    await waitFor(() => expect(server.held).toHaveLength(1));
    again({ draftKey: 'draft-2' }); // the draft was reset: a new instance
    expect(dialog()).toBeNull();
    await act(async () => { server.held[0].release(late401()); }); // would say "ended" to the old draft
    await settle();
    expect(log.map((e) => e.why)).toEqual(['selected']);
    expect(dialog()).toBeNull();
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(screen.queryByTestId('picker-notice')).toBeNull();
    expect(screen.getByTestId('picker-open')).toBeInTheDocument();
  });

  it('SCP-36. AC-05: a user switch: the previous user\'s customer is never shown, their open dialog closes, the next user reads only their own store, and the old read\'s late 401 never drops the next user\'s customer', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const [zoe] = server.seed(TENANT_B, ['Zoe']);
    const { log, again } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.hold.reads = 1;
    await click('picker-change');
    await waitFor(() => expect(server.held).toHaveLength(1));
    again({ uid: 'uid-b' });
    expect(dialog()).toBeNull();
    expect(screen.queryByTestId('picker-value')).toBeNull(); // chosen by uid-a: not shown to uid-b
    await click('picker-open');
    await ready();
    expect(names()).toEqual(['Zoe']);
    await selectRow(zoe.id);
    expect(log.at(-1)!.next).toEqual(expect.objectContaining({ id: zoe.id, uid: 'uid-b' }));
    // uid-a's read answers now, refused 401: were it heard, it would drop uid-b's customer as "ended".
    await act(async () => { server.held[0].release(late401()); });
    await settle();
    expect(log.map((e) => e.why)).toEqual(['selected', 'selected']);
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', zoe.id);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
  });

  it('SCP-37. AC-06: view access lost while the dialog is open: the dialog closes, the muted line shows, and the read still out (a late 401) reaches nobody once access is back', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log, again } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    server.hold.reads = 1;
    await click('picker-change');
    await waitFor(() => expect(server.held).toHaveLength(1));
    again({ canView: false });
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('picker-unavailable')).toHaveTextContent(NOT_AVAILABLE_TEXT);
    again({ canView: true });
    expect(dialog()).toBeNull(); // regained access does not reopen it on its own
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bob.id); // this test's draft kept it
    await act(async () => { server.held[0].release(late401()); }); // would drop it as "ended" were it heard
    await settle();
    expect(log.map((e) => e.why)).toEqual(['selected']);
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bob.id);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
  });

  it('SCP-38. wire hygiene: reads only, each naming its session and nothing of tenant, store, role or user; no browser storage, cookie or console; the shipped modules reach none of them', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const before = { local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie };
    const server = fakeServer();
    const seeded = server.seed(TENANT_A, numbered('Kestrel', 60));
    mountField(server);
    await click('picker-open');
    await ready();
    await click('picker-load-more');
    await waitFor(() => expect(names()).toHaveLength(60));
    await searchFor('kestrel 5');
    await waitFor(() => expect(names()).toHaveLength(10));
    await selectRow(seeded[55].id);
    await focusWindow();
    await settle();
    await click('picker-remove');
    expect(writes(server)).toEqual([]);
    for (const r of server.sent) {
      expect(r.url).not.toMatch(/tenant|store|role|actor|uid|user/i);
      if (r.headers.has('authorization')) expect(r.url).toBe(TENANT_SESSION_PATHS.login);
      if (r.url.startsWith(CUSTOMERS_PATH)) {
        expect(r.method).toBe('GET');
        expect([...r.headers].map(([name]) => name)).toEqual(['accept', 'x-tmpos-session-csrf']);
        expect(r.headers.get('x-tmpos-session-csrf')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      }
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(before.local);
    expect(window.sessionStorage.length).toBe(before.session);
    expect(document.cookie).toBe(before.cookie);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['ServerCustomerPicker.tsx', 'customerReference.ts']) {
      const source = readFileSync(resolve(here, file), 'utf8');
      expect(source).not.toMatch(/StoreLocalState|localStorage|sessionStorage|indexedDB|document\.cookie|console/);
      expect(source).not.toMatch(/from\s+['"][^'"]*server\//); // nothing of the server's is bundled
    }
  });
});

describe('ServerCustomerPicker review fixes (M7A-CUSTOMERS-P9)', () => {
  it('SCP-40. AC-05: the token changed while the dialog was open and the tab returns: ONE plain check, the old rows go, a new generation reads page one, the draft is told "changed", and a Select binds the NEW context', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    const first = log[0].next!.context;
    await click('picker-change');
    await ready();
    expect(log).toHaveLength(1);
    server.otherTab('tok-a'); // another tab signed in while this dialog sat open
    server.hold.reads = 1;
    const before = { checks: checks(server).length, logins: logins(server).length };
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1)); // the new generation's page one is out
    expect(rows()).toHaveLength(0); // the old generation's rows are gone at once
    expect(phase()).toBe('loading');
    expect(screen.getByTestId('picker-connection-changed')).toHaveTextContent(PICKER_TEXT.connection);
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'changed']]);
    await act(async () => { server.held[0].release(); });
    await ready();
    expect(checks(server).length - before.checks).toBe(2); // the focus's one check and the new read's own
    expect(logins(server)).toHaveLength(before.logins); // never signs in
    await selectRow(bob.id);
    expect(log.at(-1)!.why).toBe('selected');
    expect(log.at(-1)!.next!.context).not.toBe(first);
    expect(lists(server).at(-1)!.headers.get('x-tmpos-session-csrf')).toBe(server.sessions.get(server.cookie!)!.csrf);
  });

  it('SCP-47. AC-05: a return to the tab while a read is out is checked when that read settles: the rows it brought under the old token go, and the draft is told "changed"', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob', 'Bea']);
    const { log } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    await click('picker-change');
    await ready();
    server.hold.reads = 1;
    await searchFor('Be'); // a read under the first token, held at the server
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.otherTab('tok-a'); // another tab signed in while that read was out
    const before = checks(server).length;
    await focusWindow(); // a read is out: the check waits for it
    expect(checks(server)).toHaveLength(before);
    server.hold.reads = 1;
    await act(async () => { server.held[0].release(); }); // the old token's rows arrive...
    await waitFor(() => expect(server.held).toHaveLength(2)); // ...the deferred check finds another token: page one again
    expect(checks(server).length).toBeGreaterThan(before);
    expect(rows()).toHaveLength(0);
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'changed']]);
    await act(async () => { server.held[1].release(); });
    await ready();
    expect(logins(server)).toHaveLength(1); // never signs in
  });

  it('SCP-41. AC-05: a return to the tab while the dialog is open: Select waits for the check; an undecided check keeps the rows and starts no wait; an ended session signs the dialog out (rows gone, "ended", Reconnect) and later focuses send nothing', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    const { calls } = mountPicker(server);
    await ready();
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1));
    for (const select of screen.getAllByTestId('picker-select')) expect(select).toBeDisabled(); // nothing chosen on a session in doubt
    await act(async () => { server.held[0].release(); }); // the same token
    await settle();
    for (const select of screen.getAllByTestId('picker-select')) expect(select).toBeEnabled();
    expect(names()).toEqual(['Ada', 'Bea']);
    server.down = true;
    const sent = checks(server).length;
    await focusWindow();
    await settle();
    expect(checks(server)).toHaveLength(sent + 1);
    expect(phase()).toBe('ready'); // an outage decides nothing
    expect(names()).toEqual(['Ada', 'Bea']);
    expect(screen.getByTestId('picker-search-submit')).toBeEnabled(); // and starts no wait
    expect(screen.getByTestId('picker-search-hint')).toBeEmptyDOMElement();
    expect(calls.lost).toEqual([]);
    server.down = false;
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(PICKER_TEXT.ended);
    expect(rows()).toHaveLength(0);
    expect(calls.lost).toEqual(['ended']);
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Reconnect');
    expect(logins(server)).toHaveLength(1);
    const after = server.sent.length;
    await focusWindow(); // signed out: only Reconnect reads now
    await settle();
    expect(server.sent).toHaveLength(after);
    expect(calls.select).toEqual([]);
  });

  it('SCP-42. AC-08: a focus check still out when the dialog goes away: its answer (an ended session) changes nothing, and the listener is gone', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    const view = mountPicker(server);
    await ready();
    server.sessions.clear();
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1));
    view.unmount();
    await act(async () => { server.held[0].release(); }); // 401: would sign the dialog out and say "ended"
    await settle();
    expect(view.calls.lost).toEqual([]);
    const sent = server.sent.length;
    await focusWindow();
    await settle();
    expect(server.sent).toHaveLength(sent);
  });

  it('SCP-43. a new generation during a rate limit\'s wait ends that wait and reads page one — never stuck loading', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    const { calls } = mountPicker(server);
    await ready();
    server.reads.push({ limited: '600' });
    await searchFor('Ada');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(screen.getByTestId('picker-search-submit')).toBeDisabled();
    server.otherTab('tok-a');
    const from = lists(server).length;
    await focusWindow();
    await ready();
    expect(names()).toEqual(['Ada', 'Bea']);
    expect(listUrls(server, from)).toEqual([CUSTOMERS_PATH]);
    expect(calls.lost).toEqual(['changed']);
    expect(screen.getByTestId('picker-search-submit')).toBeEnabled();
    expect(screen.getByTestId('picker-search-hint')).toBeEmptyDOMElement();
  });

  it('SCP-44. the user\'s own Reconnect after an end is not a "connection changed": an earlier banner goes with the end and does not come back', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    const { calls } = mountPicker(server);
    await ready();
    server.otherTab('tok-a');
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('picker-connection-changed')).toBeInTheDocument());
    await ready();
    server.sessions.clear();
    await searchFor('Ad');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(screen.queryByTestId('picker-connection-changed')).toBeNull();
    await click('picker-retry');
    await ready();
    expect(names()).toEqual(['Ada']);
    expect(calls.lost).toEqual(['changed', 'ended']);
    expect(calls.context).toHaveLength(3); // the first, the changed one, and the Reconnect's (reported, not "changed")
    expect(screen.queryByTestId('picker-connection-changed')).toBeNull();
  });

  it('SCP-45. sessionContextOf: stable while the field is mounted, forgotten when it unmounts (a new object for the same pair)', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log, unmount } = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    const csrf = lists(server).at(-1)!.headers.get('x-tmpos-session-csrf')!;
    const context = log[0].next!.context;
    expect(isContextOf(context, 'uid-a', csrf)).toBe(true);
    unmount();
    await microtask(); // forgotten on a microtask once no field has mounted again (M7B-INVOICES-P1-R2)
    expect(hasSessionPair()).toBe(false);
    expect(sessionContextOf('uid-a', csrf, sessionEndsSoFar())).not.toBe(context);
  });

  it('SCP-46. focus stays in the dialog when the focused control goes away: Load more on the last page, and Try again after it succeeds', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, numbered('Customer', 60));
    server.down = true;
    mountPicker(server);
    await waitFor(() => expect(phase()).toBe('unavailable'));
    server.down = false;
    await click('picker-retry');
    await ready();
    expect(screen.queryByTestId('picker-retry')).toBeNull();
    expect(document.activeElement).toBe(searchInput());
    await click('picker-load-more');
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(screen.queryByTestId('picker-load-more')).toBeNull();
    expect(document.activeElement).toBe(searchInput());
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M7A-CUSTOMERS-P10 — the dialog as a keyboard modal (DA-178) and a refusal whose one fresh check is undecided
// ---------------------------------------------------------------------------------------------------------------------

/** The real clients over `server`, with the session's `ensure` recording the mode of every call (undefined: plain). */
function recording(server: Server) {
  const inject = clients(server);
  const modes: Array<EnsureOptions | undefined> = [];
  const session = Object.freeze({
    ...inject.session,
    ensure: (uid: string, idToken: () => Promise<string | null>, options?: EnsureOptions) => {
      modes.push(options);
      return inject.session.ensure(uid, idToken, options);
    },
  });
  return { inject: { ...inject, session }, modes };
}

type Log = Array<{ next: ServerCustomerReference | null; why: Why }>;
/** A host dialog around the field, as the invoice and repair forms are: its OWN Escape closes it, and it has controls before and after the field. */
function HostDialog({ inject, log, keys }: { inject: Clients; log: Log; keys: string[] }) {
  const [open, setOpen] = useState(true);
  if (!open) return <p data-testid="host-closed">The host dialog closed.</p>;
  return (
    <div role="dialog" aria-label="New ticket" data-testid="host" onKeyDown={(e) => { keys.push(e.key); if (e.key === 'Escape') setOpen(false); }}>
      <button type="button" data-testid="host-before">Before</button>
      <Draft uid="uid-a" inject={inject} log={log} />
      <button type="button" data-testid="host-after">After</button>
    </div>
  );
}
function mountHost(server: Server) {
  const log: Log = [];
  const keys: string[] = []; // every key the host's own handler saw
  return { ...render(<HostDialog inject={clients(server)} log={log} keys={keys} />), log, keys };
}
const active = () => document.activeElement;
const tab = async (shift = false) => { await userEvent.setup().tab({ shift }); };
const selectOf = (id: string) => within(rows().find((r) => r.getAttribute('data-id') === id)!).getByTestId('picker-select');
const refusal = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error: `e${status}`, requestId: 'req-synthetic' }), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/**
 * A field holding a server customer is reopened (Change); read 1 (allowed: its rows held at the server) is superseded by
 * read 2, refused 403 because the store took the user's view away, and a return to the tab while read 2 is out is
 * checked once it settles. The ONE fresh session check after the 403 gets `fresh` — an undecided answer — so the
 * refusal stands: the dialog says denied with no row and no Select, the field drops its customer with the denied notice,
 * and the session was asked plain, plain, fresh, then plain (the deferred focus check, still out on return).
 */
async function deniedWithUndecidedCheck(fresh: Response) {
  const server = fakeServer();
  const [ada] = server.seed(TENANT_A, ['Ada', 'Bea']);
  const { inject, modes } = recording(server);
  const { log } = mountField(server, { inject });
  await click('picker-open');
  await ready();
  await selectRow(ada.id);
  await click('picker-change');
  await ready();
  modes.length = 0;
  const signedIn = logins(server).length;
  server.hold.reads = 2;
  await searchFor('Ad'); // read 1: allowed, decided on arrival — its rows wait at the server
  await waitFor(() => expect(server.held).toHaveLength(1));
  server.users['tok-a'].view = false; // the store takes this user's view away
  await searchFor('Be'); // read 2 supersedes read 1, and is refused 403
  await waitFor(() => expect(server.held).toHaveLength(2));
  await focusWindow(); // a return to the tab while read 2 is out: checked once it settles
  server.hold.checks = 2; // the one fresh check after the 403, and that deferred focus check
  await act(async () => { server.held[1].release(); });
  await waitFor(() => expect(server.held).toHaveLength(3));
  expect(server.held[2].url).toBe(TENANT_SESSION_PATHS.current);
  await act(async () => { server.held[2].release(fresh); }); // the fresh check decides nothing
  await waitFor(() => expect(phase()).toBe('denied'));
  await waitFor(() => expect(server.held).toHaveLength(4)); // the deferred focus check is out
  expect(state()).toHaveTextContent(PICKER_TEXT.denied);
  expect(state()).toHaveAttribute('role', 'alert');
  expect(rows()).toHaveLength(0);
  expect(screen.queryAllByTestId('picker-select')).toEqual([]);
  expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[ada.id, 'selected'], [null, 'denied']]);
  expect(screen.queryByTestId('picker-value')).toBeNull();
  expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_DENIED_TEXT);
  expect(modes).toEqual([undefined, undefined, { fresh: true }, undefined]); // never a reconnect
  return { server, log, modes, signedIn };
}

/** Then the late answers: the focus check's "ok" (the same token) and read 1's rows. Neither restores a row or a choice. */
async function lateAnswersChangeNothing({ server, log, modes, signedIn }: Awaited<ReturnType<typeof deniedWithUndecidedCheck>>) {
  const listed = lists(server).length;
  server.users['tok-a'].view = true; // the server would answer rows again now: nothing may ask it on its own
  await act(async () => { server.held[3].release(); }); // the deferred focus check: ok, the same token
  await act(async () => { server.held[0].release(); }); // read 1's rows (Ada), superseded
  await settle();
  expect(phase()).toBe('denied');
  expect(rows()).toHaveLength(0);
  expect(screen.queryAllByTestId('picker-select')).toEqual([]);
  expect(lists(server)).toHaveLength(listed); // nothing was read again
  expect(log.map((e) => e.why)).toEqual(['selected', 'denied']);
  expect(screen.queryByTestId('picker-value')).toBeNull();
  expect(modes.some((mode) => mode?.reconnect === true)).toBe(false);
  expect(logins(server)).toHaveLength(signedIn);
}

describe('ServerCustomerPicker refusals and keyboard (M7A-CUSTOMERS-P10)', () => {
  it('SCP-48. AC-06: a 403 whose one fresh check is UNAVAILABLE: the refusal stands (denied, no row, no Select), the draft drops its customer with the denied notice, the session was never asked to reconnect, and late answers restore nothing', async () => {
    const context = await deniedWithUndecidedCheck(refusal(503));
    await lateAnswersChangeNothing(context);
    expect(screen.getByTestId('picker-search-submit')).toBeEnabled(); // no wait: the user may try again
    expect(screen.getByTestId('picker-search-hint')).toBeEmptyDOMElement();
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Try again');
    expect(screen.getByTestId('picker-retry')).toBeEnabled();
  });

  it('SCP-49. AC-06: a 403 whose one fresh check is RATE-LIMITED: the refusal stands and the check\'s wait runs (Search, Clear and Try again disabled, the hint says the wait); late answers restore nothing', async () => {
    const context = await deniedWithUndecidedCheck(refusal(429, { 'retry-after': '30' }));
    for (const control of controls()) expect(control).toBeDisabled();
    expect(screen.getByTestId('picker-search-hint')).toHaveTextContent('Wait 30 seconds.');
    await lateAnswersChangeNothing(context);
    for (const control of controls()) expect(control).toBeDisabled(); // the wait still runs after the check settled
    expect(screen.getByTestId('picker-search-hint')).toHaveTextContent('Wait 30 seconds.');
    expect(state()).toHaveTextContent(PICKER_TEXT.denied);
  });

  it('SCP-50. AC-05: after a confirmed session END nothing signs in on its own — a window focus, a return to the tab and reopening the dialog send no login and pass no reconnect; only the Reconnect click does', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { inject, modes } = recording(server);
    const { log } = mountField(server, { inject });
    await click('picker-open'); // no session confirmed yet for this user: the plain read signs in, once
    await ready();
    expect(logins(server)).toHaveLength(1);
    await selectRow(bob.id);
    server.sessions.clear(); // the confirmed session ends in the store (expiry, revocation, a logout elsewhere)
    await focusWindow(); // the dialog is closed: the field's one plain check finds it ended
    await waitFor(() => expect(log.map((e) => e.why)).toEqual(['selected', 'ended']));
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    let sent = server.sent.length;
    await focusWindow();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(server.sent).toHaveLength(sent); // no customer held: nothing to check
    await click('picker-open'); // reopened: its plain read finds the session ended
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(PICKER_TEXT.ended);
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Reconnect');
    sent = server.sent.length;
    await focusWindow();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(server.sent).toHaveLength(sent); // signed out: only Reconnect reads
    expect(logins(server)).toHaveLength(1);
    expect(modes).toEqual([undefined, undefined, undefined]); // the first read, the focus check, the reopened read
    await click('picker-retry');
    await ready();
    expect(names()).toEqual(['Bob']);
    expect(logins(server)).toHaveLength(2);
    expect(modes).toEqual([undefined, undefined, undefined, { reconnect: true }]);
  });

  it('SCP-51. Tab and Shift+Tab stay in the dialog: from its last enabled control to its first and back, and from a focused text that is no Tab stop to the first or the last — never to the host dialog\'s controls around it', async () => {
    const server = fakeServer();
    const [, bea] = server.seed(TENANT_A, ['Ada', 'Bea']);
    mountHost(server);
    await click('picker-open');
    expect(active()).toBe(searchInput()); // on open
    await ready();
    // The stops, in order: Cancel, the search box, Search, Select Ada, Select Bea (Clear is disabled: nothing to clear).
    const cancel = screen.getByTestId('picker-cancel');
    const last = selectOf(bea.id);
    last.focus();
    await tab();
    expect(active()).toBe(cancel);
    await tab(true);
    expect(active()).toBe(last);
    await tab();
    expect(active()).toBe(cancel);
    await tab(); // inside, Tab moves on as usual
    expect(active()).toBe(searchInput());
    // Focus on a text inside the dialog that is no Tab stop (where a script or an assistive tool may put it).
    state().setAttribute('tabindex', '-1');
    state().focus();
    expect(active()).toBe(state());
    await tab();
    expect(active()).toBe(cancel);
    state().focus();
    await tab(true);
    expect(active()).toBe(last);
    expect(screen.getByTestId('host')).toBeInTheDocument();
  });

  it('SCP-52. a disabled control is no Tab stop: during a rate limit\'s wait (Search, Clear, Try again) and while a check is out (Select, Load more) the wrap skips them', async () => {
    const limited = fakeServer();
    limited.reads.push({ limited: '600' });
    const view = mountPicker(limited);
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    for (const control of controls()) expect(control).toBeDisabled();
    searchInput().focus(); // the stops: Cancel and the search box only
    await tab();
    expect(active()).toBe(screen.getByTestId('picker-cancel'));
    await tab(true);
    expect(active()).toBe(searchInput());
    view.unmount();

    const server = fakeServer();
    server.seed(TENANT_A, numbered('Customer', 60));
    mountPicker(server);
    await ready();
    server.hold.checks = 1;
    await focusWindow(); // a return to the tab: Select and Load more wait for its check
    await waitFor(() => expect(server.held).toHaveLength(1));
    for (const select of screen.getAllByTestId('picker-select')) expect(select).toBeDisabled();
    expect(screen.getByTestId('picker-load-more')).toBeDisabled();
    expect(screen.getByTestId('picker-search-clear')).toBeDisabled();
    const cancel = screen.getByTestId('picker-cancel');
    const submit = screen.getByTestId('picker-search-submit');
    submit.focus(); // the stops: Cancel, the search box and Search
    await tab();
    expect(active()).toBe(cancel);
    await tab(true);
    expect(active()).toBe(submit);
    await act(async () => { server.held[0].release(); });
    await settle();
    const more = screen.getByTestId('picker-load-more');
    expect(more).toBeEnabled(); // the check answered: Load more is the last stop again
    cancel.focus();
    await tab(true);
    expect(active()).toBe(more);
    await tab();
    expect(active()).toBe(cancel);
  });

  it('SCP-53. while the dialog is open everything else in <body> is inert; closing it — Cancel, Escape, a Select, a user switch — removes exactly what it set, and a node that was inert before stays inert', async () => {
    const outer = document.createElement('div');
    outer.setAttribute('inert', ''); // an outer layer's: not this dialog's to restore
    const plain = document.createElement('div');
    document.body.append(outer, plain);
    try {
      const server = fakeServer();
      const [bob] = server.seed(TENANT_A, ['Bob']);
      const { container, again } = mountField(server);
      const others = () => [...document.body.children].filter((node) => node !== dialog()?.parentElement);
      const opened = async (testId: string) => {
        await click(testId);
        await ready();
        expect(dialog()!.parentElement!.parentElement).toBe(document.body);
        expect(dialog()!.closest('[inert]')).toBeNull(); // the dialog itself never is
        expect(others()).toEqual(expect.arrayContaining([container, outer, plain]));
        for (const node of others()) expect(node).toHaveAttribute('inert');
      };
      const closed = () => {
        expect(dialog()).toBeNull();
        expect(container).not.toHaveAttribute('inert');
        expect(plain).not.toHaveAttribute('inert');
        expect(outer).toHaveAttribute('inert');
      };
      await opened('picker-open');
      await click('picker-cancel');
      closed();
      await opened('picker-open');
      await userEvent.setup().keyboard('{Escape}');
      closed();
      await opened('picker-open');
      await selectRow(bob.id);
      closed();
      await waitFor(() => expect(active()).toBe(screen.getByTestId('picker-change'))); // on a node no longer inert
      await opened('picker-change');
      again({ uid: 'uid-b' }); // a user switch unmounts the dialog
      closed();
    } finally {
      outer.remove();
      plain.remove();
    }
  });

  it('SCP-54. Escape inside a host dialog that closes on its own Escape closes the picker ONLY: the host never sees it and stays open, and focus returns to "Select a server customer", then to Change once a customer is held', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { keys } = mountHost(server);
    await click('picker-open');
    await ready();
    await userEvent.setup().keyboard('{Escape}');
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('host')).toBeInTheDocument();
    expect(keys).not.toContain('Escape');
    await waitFor(() => expect(active()).toBe(screen.getByTestId('picker-open')));
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    await click('picker-change');
    await ready();
    expect(fireEvent.keyDown(searchInput(), { key: 'Escape' })).toBe(false); // its default is prevented too
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('host')).toBeInTheDocument();
    expect(keys).not.toContain('Escape');
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bob.id); // Escape kept the customer
    await waitFor(() => expect(active()).toBe(screen.getByTestId('picker-change')));
    await userEvent.setup().keyboard('{Escape}'); // outside the picker the host's own Escape is live
    expect(keys).toContain('Escape');
    expect(screen.getByTestId('host-closed')).toBeInTheDocument();
  });

  it('SCP-55. a press on the backdrop is default-prevented, so focus never leaves the dialog for <body> (where Escape and Tab would be lost); a press inside the dialog is not', async () => {
    const server = fakeServer();
    mountPicker(server);
    await ready();
    const backdrop = dialog()!.parentElement!;
    expect(backdrop.parentElement).toBe(document.body);
    expect(fireEvent.mouseDown(backdrop)).toBe(false);
    expect(fireEvent.mouseDown(dialog()!)).toBe(true);
    expect(fireEvent.mouseDown(searchInput())).toBe(true);
    expect(active()).toBe(searchInput());
  });

  it('SCP-56. a press on the dialog\'s own text (its heading, a row\'s name) focuses the dialog itself, never <body>: from there Escape closes the picker ONLY and Tab and Shift+Tab land on its first and last enabled control', async () => {
    const server = fakeServer();
    const [, bea] = server.seed(TENANT_A, ['Ada', 'Bea']);
    const { keys } = mountHost(server);
    await click('picker-open');
    await ready();
    const panel = dialog()!;
    // The press is not default-prevented, so a browser moves focus to its nearest focusable ancestor — the dialog. jsdom
    // moves no focus on mousedown, so the press's result is made directly: it takes only if the dialog can hold focus.
    expect(fireEvent.mouseDown(within(panel).getByRole('heading'))).toBe(true);
    expect(fireEvent.mouseDown(within(rows()[0]).getByText('Ada'))).toBe(true);
    panel.focus();
    expect(active()).toBe(panel);
    await focusWindow(); // a return to the tab re-renders (busy, then not): the dialog is focus INSIDE, so it stays
    await settle();
    expect(active()).toBe(panel);
    await tab();
    expect(active()).toBe(screen.getByTestId('picker-cancel'));
    panel.focus();
    await tab(true);
    expect(active()).toBe(selectOf(bea.id));
    panel.focus();
    await userEvent.setup().keyboard('{Escape}');
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('host')).toBeInTheDocument();
    expect(keys).not.toContain('Escape');
    await waitFor(() => expect(active()).toBe(screen.getByTestId('picker-open')));
  });

  it.each([
    ['Change', 'picker-change', 'picker-open'],
    ['Remove', 'picker-remove', 'picker-open'],
    ['a host control (not the field\'s)', 'host-before', 'host-before'],
  ])('SCP-57. AC-05: a closed-dialog check that drops the customer while focus is on %s: focus goes to "Select a server customer" when it was in the dropped block, and is left alone when it was elsewhere', async (_, focused, after) => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const { log } = mountHost(server);
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    await waitFor(() => expect(active()).toBe(screen.getByTestId('picker-change')));
    screen.getByTestId(focused).focus();
    expect(active()).toBe(screen.getByTestId(focused));
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[bob.id, 'selected'], [null, 'ended']]));
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(screen.queryByTestId('picker-value')).toBeNull();
    await waitFor(() => expect(active()).toBe(screen.getByTestId(after)));
    await settle();
    expect(active()).toBe(screen.getByTestId(after));
  });
});

describe('ServerCustomerField in the server draft dialog (M7B-INVOICES-P1)', () => {
  it('SCP-58. two fields mounted at once share one context per session: the one that goes first leaves the pair to the other, the last one forgets it; a host\'s `invalid` marks "Select a server customer" and points it at the host\'s error (off by default)', async () => {
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const inject = clients(server);
    const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    const two = (both: boolean) => (
      <>
        {both && <Draft key="closing" uid="uid-a" inject={inject} log={[]} />}
        <Draft key="dialog" uid="uid-a" inject={inject} log={log} />
      </>
    );
    const view = render(two(true));
    await userEvent.setup().click(screen.getAllByTestId('picker-open')[1]);
    await ready();
    await selectRow(bob.id);
    const csrf = lists(server).at(-1)!.headers.get('x-tmpos-session-csrf')!;
    const context = log[0].next!.context;
    expect(isContextOf(context, 'uid-a', csrf)).toBe(true);
    view.rerender(two(false)); // the closing field goes; the dialog's still holds Bob under that context
    expect(isContextOf(context, 'uid-a', csrf)).toBe(true);
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', bob.id);
    view.unmount(); // the last field goes: the pair with it (on a microtask)
    await microtask();
    expect(hasSessionPair()).toBe(false);

    const marked = render(<ServerCustomerField uid="uid-a" value={null} canView invalid errorId="host-error" onChange={() => {}} {...inject} />);
    expect(screen.getByTestId('picker-open')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('picker-open')).toHaveAttribute('aria-describedby', 'host-error');
    marked.unmount();
    render(<ServerCustomerField uid="uid-a" value={null} canView errorId="host-error" onChange={() => {}} {...inject} />);
    expect(screen.getByTestId('picker-open')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByTestId('picker-open')).not.toHaveAttribute('aria-describedby');
    expect(writes(server)).toEqual([]);
  });
});

describe('A sign-out heard by the picker (M7B-INVOICES-P1 closing round)', () => {
  /** The real clients, and a draft-side record of what the dialog says. */
  function openDialog(server: Server) {
    const inject = clients(server);
    const calls = { select: [] as ServerCustomerReference[], lost: [] as string[] };
    render(<ServerCustomerPicker uid="uid-a" onSelect={(ref) => { calls.select.push(ref); }} onCancel={() => {}} onLost={(why) => { calls.lost.push(why); }} onContext={() => {}} {...inject} />);
    return { inject, calls };
  }

  it('SCP-59. a sign-out while the dialog\'s list read is out ends the dialog at once — the ended state, the draft told — and the read\'s late answer, released after it, shows no row and sends nothing: no login, no read again, nothing but the logout', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bea']);
    server.hold.reads = 1;
    const { inject, calls } = openDialog(server);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(hasSessionPair()).toBe(true); // the first token fixed the generation and made its context
    const mark = server.sent.length;
    await act(async () => { void inject.session.logout(); });
    expect(phase()).toBe('signed-out');
    expect(state()).toHaveTextContent(PICKER_TEXT.ended);
    expect(calls.lost).toEqual(['ended']);
    expect(hasSessionPair()).toBe(false);
    await act(async () => { server.held.shift()!.release(); });
    await settle();
    expect(rows()).toEqual([]);
    expect(phase()).toBe('signed-out');
    expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    expect(screen.getByTestId('picker-retry')).toBeEnabled(); // Reconnect: the user's own press (its busy state given back)
    expect(calls.select).toEqual([]);
  });

  it('SCP-60. Select after a sign-out makes no reference: the rows the dialog read go with the session the moment it ends, so no Select is left; the draft holds no customer, no (UID, token) pair is kept, and nothing but the logout is sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    const { log, inject } = mountField(server);
    await click('picker-open');
    await ready();
    expect(screen.getAllByTestId('picker-select')).toHaveLength(1);
    const mark = server.sent.length;
    await act(async () => { void inject.session.logout(); });
    expect(screen.queryAllByTestId('picker-select')).toEqual([]);
    expect(phase()).toBe('signed-out');
    expect(log).toEqual([]); // nothing was chosen before, and nothing could be after
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(hasSessionPair()).toBe(false);
    await settle();
    expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
  });

  it('SCP-61. a closed-dialog check whose session answered just before a sign-out began drops the customer as ENDED and makes no (UID, token) pair again: the comparison creates nothing, and the ended token is kept nowhere', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    const real = clients(server);
    let trip = false;
    // The sign-out begins after the check's session confirmation has answered, before the check's continuation runs.
    const session: TenantSessionClient = { ...real.session, ensure: async (...args) => { const s = await real.session.ensure(...args); if (trip) { trip = false; void real.session.logout(); } return s; } };
    const { log } = mountField(server, { inject: { ...real, session } });
    await click('picker-open');
    await ready();
    await selectRow(bob.id);
    expect(log.map((e) => e.why)).toEqual(['selected']);
    trip = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(trip).toBe(false);
    expect(log.map((e) => [e.next, e.why])).toEqual([[log[0].next, 'selected'], [null, 'ended']]);
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(hasSessionPair()).toBe(false);
  });

  it('SCP-62. a 403\'s one fresh check whose session answered just before a sign-out began takes nothing from that answer: the dialog stays ended, and the user\'s Reconnect is a FIRST token — no "connection changed", nothing dropped as changed', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.reads.push(403); // the first list read is refused: one fresh check follows
    const real = clients(server);
    let trip = true;
    const session: TenantSessionClient = {
      ...real.session,
      ensure: async (uid, idToken, options) => { const s = await real.session.ensure(uid, idToken, options); if (trip && options?.fresh === true) { trip = false; void real.session.logout(); } return s; },
    };
    const calls = { lost: [] as string[] };
    render(<ServerCustomerPicker uid="uid-a" onSelect={() => {}} onCancel={() => {}} onLost={(why) => { calls.lost.push(why); }} onContext={() => {}} {...real} session={session} />);
    await waitFor(() => expect(trip).toBe(false));
    await settle();
    expect(phase()).toBe('signed-out');
    expect(calls.lost).toEqual(['ended']);
    server.sessions.clear(); // the server ended that session (this fake has no logout route): Reconnect gets a new token
    await click('picker-retry'); // Reconnect
    await ready();
    expect(screen.queryByTestId('picker-connection-changed')).toBeNull();
    expect(calls.lost).toEqual(['ended']);
  });

  it('SCP-63. a sign-out during a rate limit\'s wait ends that wait with the session that was asked to wait: Reconnect is offered at once, and reads', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.retryAfter = '60';
    server.reads.push(429);
    const { inject } = openDialog(server);
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(screen.getByTestId('picker-retry')).toBeDisabled(); // the 60-second wait
    await act(async () => { void inject.session.logout(); });
    expect(phase()).toBe('signed-out');
    expect(screen.getByTestId('picker-retry')).toHaveTextContent('Reconnect');
    expect(screen.getByTestId('picker-retry')).toBeEnabled(); // at once: the ended session's wait went with it
    server.sessions.clear(); // the server ended that session (this fake has no logout route): Reconnect signs in again
    await click('picker-retry');
    await ready();
    expect(ids()).toEqual([ada.id]);
  });
});

describe('A closed field hears a sign-out (M7B-INVOICES-P1-R2, DA-202)', () => {
  /** The draft side as a host holds it: a value it was given (or null), what the field reports, and the field mounted or not. */
  function Host({ initial, shown, inject, log, fieldKey = 'f1', install }: {
    initial: ServerCustomerReference | null; shown: boolean; inject: Clients; log: Array<{ next: ServerCustomerReference | null; why: Why }>; fieldKey?: string;
    install?: (set: (next: ServerCustomerReference | null) => void) => void; // hands the test the host's own setter
  }) {
    const [value, setValue] = useState<ServerCustomerReference | null>(initial);
    install?.(setValue);
    return (
      <>
        <output data-testid="host-value">{value === null ? '' : value.id}</output>
        {shown && <ServerCustomerField key={fieldKey} uid="uid-a" value={value} canView onChange={(next, why) => { log.push({ next, why }); setValue(next); }} {...inject} />}
      </>
    );
  }
  /** A customer chosen in the dialog, the dialog closed: the field shows it, the draft holds it. */
  async function chosen(server: Server) {
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const mounted = mountField(server);
    await click('picker-open');
    await ready();
    await selectRow(ada.id);
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada.id);
    return { ...mounted, ada };
  }

  it('SCP-64. a sign-out with the dialog CLOSED drops the chosen customer at once — no focus, no tab return — with the ended notice: the draft is told once (`ended`), no (UID, token) pair stays, nothing but the logout is sent, and the next session shows no customer until one is chosen again', async () => {
    const server = fakeServer();
    const { log, inject, ada } = await chosen(server);
    const mark = server.sent.length;
    await act(async () => { await inject.session.logout(); });
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(log.map((e) => [e.next?.id ?? null, e.why])).toEqual([[ada.id, 'selected'], [null, 'ended']]);
    expect(hasSessionPair()).toBe(false);
    await settle();
    expect(server.sent.slice(mark).map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${TENANT_SESSION_PATHS.logout}`]);
    // A new session: the dialog reads again under a NEW context, and the draft is still empty until a new choice.
    server.sessions.clear();
    await click('picker-open');
    await ready();
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(log).toHaveLength(2);
    await selectRow(ada.id);
    expect(log[2].why).toBe('selected');
    expect(log[2].next!.context).not.toBe(log[0].next!.context);
    expect(isLiveContext(log[2].next!.context)).toBe(true);
    expect(isLiveContext(log[0].next!.context)).toBe(false);
  });

  it('SCP-65. the field\'s listener lives as long as the field: under StrictMode\'s setup, cleanup, setup one sign-out tells the draft exactly once; once the field has unmounted a sign-out tells it nothing', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const inject = clients(server);
    const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    const view = render(<StrictMode><Draft uid="uid-a" inject={inject} log={log} /></StrictMode>);
    await click('picker-open');
    await ready();
    await selectRow(ada.id);
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada.id);
    await act(async () => { await inject.session.logout(); });
    expect(log.map((e) => e.why)).toEqual(['selected', 'ended']);
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    view.unmount();
    await act(async () => { await inject.session.logout(); });
    expect(log.map((e) => e.why)).toEqual(['selected', 'ended']);
  });

  it('SCP-66. a field that MOUNTS holding a reference whose session is over drops it at once (ended, the host told, its copy cleared): ended by a sign-out, or replaced by another session\'s context; a live one is kept', async () => {
    const server = fakeServer();
    const inject = clients(server);
    const entry = { id: uuid(0xc01), name: 'Ada' };
    const T1 = `${'s'.repeat(40)}901`;
    for (const how of ['live', 'signed-out', 'replaced'] as const) {
      const ref = serverCustomerReference(entry, 'uid-a', sessionContextOf('uid-a', T1, sessionEndsSoFar()));
      if (how === 'signed-out') await act(async () => { await inject.session.logout(); });
      if (how === 'replaced') sessionContextOf('uid-a', `${'s'.repeat(40)}902`, sessionEndsSoFar()); // a later session's
      const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
      render(<Host initial={ref} shown inject={inject} log={log} />);
      if (how === 'live') {
        expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', entry.id);
        expect(screen.getByTestId('host-value')).toHaveTextContent(entry.id);
        expect(log).toEqual([]);
        expect(screen.queryByTestId('picker-notice')).toBeNull();
      } else {
        expect(screen.queryByTestId('picker-value')).toBeNull();
        expect(screen.getByTestId('host-value').textContent).toBe('');
        expect(log).toEqual([{ next: null, why: 'ended' }]);
        expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
      }
      cleanup();
    }
    expect(server.sent.filter((r) => r.url !== TENANT_SESSION_PATHS.logout && r.url !== TENANT_SESSION_PATHS.current)).toEqual([]);
  });

  it('SCP-67. a draft that keeps its customer while its field is unmounted (the last field gone, the pair with it) gets it back dropped, not shown, when the field mounts again', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const inject = clients(server);
    const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    const view = render(<Host initial={null} shown inject={inject} log={log} />);
    await click('picker-open');
    await ready();
    await selectRow(ada.id);
    expect(screen.getByTestId('host-value')).toHaveTextContent(ada.id);
    view.rerender(<Host initial={null} shown={false} inject={inject} log={log} />); // the last field unmounts
    await microtask(); // the pair goes with it, on a microtask
    expect(hasSessionPair()).toBe(false);
    expect(screen.getByTestId('host-value')).toHaveTextContent(ada.id); // the host still holds it
    view.rerender(<Host initial={null} shown inject={inject} log={log} />);
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(screen.getByTestId('host-value').textContent).toBe('');
    expect(log.map((e) => e.why)).toEqual(['selected', 'ended']);
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
  });

  it('SCP-68. a field mounted under StrictMode (setup, cleanup, setup) whose host ALREADY holds a live server reference keeps it: no drop, no notice, nothing told, the context still live', async () => {
    const server = fakeServer();
    const inject = clients(server);
    const ref = serverCustomerReference({ id: uuid(0xc11), name: 'Ada' }, 'uid-a', sessionContextOf('uid-a', `${'s'.repeat(40)}911`, sessionEndsSoFar()));
    const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    render(<StrictMode><Host initial={ref} shown inject={inject} log={log} /></StrictMode>);
    await microtask();
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ref.id);
    expect(screen.getByTestId('host-value')).toHaveTextContent(ref.id);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
    expect(log).toEqual([]);
    expect(isLiveContext(ref.context)).toBe(true);
  });

  it('SCP-69. the only field unmounting with nothing mounted again forgets the pair on the microtask after it: the reference it held is then live nowhere', async () => {
    const server = fakeServer();
    const inject = clients(server);
    const ref = serverCustomerReference({ id: uuid(0xc12), name: 'Ada' }, 'uid-a', sessionContextOf('uid-a', `${'s'.repeat(40)}912`, sessionEndsSoFar()));
    const view = render(<Host initial={ref} shown inject={inject} log={[]} />);
    expect(isLiveContext(ref.context)).toBe(true);
    view.unmount();
    await microtask();
    expect(hasSessionPair()).toBe(false);
    expect(isLiveContext(ref.context)).toBe(false);
  });

  it('SCP-70. a host that switches its field\'s key (the old field unmounts, the new one mounts in one commit) keeps a live customer: the new field shows it and nothing is dropped', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const inject = clients(server);
    const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    const view = render(<Host initial={null} shown inject={inject} log={log} fieldKey="k1" />);
    await click('picker-open');
    await ready();
    await selectRow(ada.id);
    view.rerender(<Host initial={null} shown inject={inject} log={log} fieldKey="k2" />);
    await microtask();
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada.id);
    expect(log.map((e) => e.why)).toEqual(['selected']);
    expect(isLiveContext(log[0].next!.context)).toBe(true);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
  });

  it('SCP-71. another session\'s context handed out while a CLOSED field holds a customer: the field drops it (ended, the host told once) on the microtask after — no focus or tab-return check needed; and a customer SELECTED by a real (native, un-act-wrapped) click in the same task as a replacement its own Select makes is kept when that replacement is told', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const inject = clients(server);
    const T1 = `${'s'.repeat(40)}921`;
    const T2 = `${'s'.repeat(40)}922`;
    const old = serverCustomerReference({ id: uuid(0xc21), name: 'Old' }, 'uid-a', sessionContextOf('uid-a', T1, sessionEndsSoFar()));
    const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    render(<Host initial={old} shown inject={inject} log={log} />);
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', old.id);
    act(() => { sessionContextOf('uid-a', T2, sessionEndsSoFar()); });
    await microtask();
    expect(screen.queryByTestId('picker-value')).toBeNull();
    expect(screen.getByTestId('picker-notice')).toHaveTextContent(PICK_ENDED_TEXT);
    expect(log).toEqual([{ next: null, why: 'ended' }]);
    cleanup();

    // The race: the dialog is open on the real session (its generation's token); the field holds a customer under ANOTHER
    // pair that is the kept one (installed by the host). The dialog's Select then makes its own context — replacing that
    // pair, whose replacement is told on a microtask — and hands the field the new customer in the same task. Measured
    // (M7B-INVOICES-P1-R2 round 2): React commits a click's update before that microtask, so this case passes with or
    // without the field's synchronous `held.current = ref` in onSelect — it pins the outcome, not that assignment.
    const log2: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    let setHost!: (next: ServerCustomerReference | null) => void;
    render(<Host initial={null} shown inject={inject} log={log2} install={(set) => { setHost = set; }} />);
    await click('picker-open');
    await ready();
    const other = serverCustomerReference({ id: uuid(0xc23), name: 'Other' }, 'uid-a', sessionContextOf('uid-a', `${'s'.repeat(40)}923`, sessionEndsSoFar()));
    await microtask();
    act(() => { setHost(other); });
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', other.id);
    expect(isLiveContext(other.context)).toBe(true);
    const select = within(rows().find((r) => r.getAttribute('data-id') === ada.id)!).getByTestId('picker-select');
    const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnv.IS_REACT_ACT_ENVIRONMENT = false; // a real click: React schedules and commits on its own
    try {
      select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0)); // one real task: the microtasks and React's commit run
    } finally {
      actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await microtask();
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', ada.id);
    expect(log2.map((e) => e.why)).toEqual(['selected']);
    expect(isLiveContext(log2[0].next!.context)).toBe(true);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
  });

  it('SCP-72. a context made in the same task as the last field\'s unmount (before that unmount\'s forget runs), for a field still to mount: the forget leaves it, and the field mounted with it after the microtask keeps a live customer — the one a send checks (isContextOf) still matches', async () => {
    const server = fakeServer();
    const inject = clients(server);
    const T1 = `${'s'.repeat(40)}931`;
    const T2 = `${'s'.repeat(40)}932`;
    const old = serverCustomerReference({ id: uuid(0xc31), name: 'Old' }, 'uid-a', sessionContextOf('uid-a', T1, sessionEndsSoFar()));
    const view = render(<Host initial={old} shown inject={inject} log={[]} />);
    view.unmount(); // the last field: its forget is queued
    const fresh = serverCustomerReference({ id: uuid(0xc32), name: 'Fresh' }, 'uid-a', sessionContextOf('uid-a', T2, sessionEndsSoFar()));
    await microtask();
    expect(hasSessionPair()).toBe(true);
    const log: Array<{ next: ServerCustomerReference | null; why: Why }> = [];
    render(<Host initial={fresh} shown inject={inject} log={log} />);
    await microtask();
    expect(screen.getByTestId('picker-value')).toHaveAttribute('data-id', fresh.id);
    expect(log).toEqual([]);
    expect(isLiveContext(fresh.context)).toBe(true);
    expect(isContextOf(fresh.context, 'uid-a', T2)).toBe(true);
    expect(screen.queryByTestId('picker-notice')).toBeNull();
  });
});
