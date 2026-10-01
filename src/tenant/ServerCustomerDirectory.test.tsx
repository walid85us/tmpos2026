// M7A-CUSTOMERS-P5 — the shop's server-backed Customer directory in jsdom: the REAL tenant session and customers clients
// over one fake tenant server at the network boundary (synthetic tenants, users and names only). The fake is as strict
// as the server where the page could be wrong about it: a distinct CSRF token per session and a 403 for a POST whose
// token is not that session's; the intent header and a v4 Idempotency-Key required; the name judged AFTER the key is
// acquired (a 400 keeps the lease, and the same key then answers 409); 422 for other bytes or another tenant; a sealed
// 201 with Location, replayed with Idempotent-Replayed: true; real 23-character cursors over byte-order pages; sessions
// bound to tenants. Its name rule, cursor codec and page order are the server's own modules. Every assertion about a
// request is made on what the fake recorded — the wire — never on what the page believes it sent.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Navigate, RouterProvider, createMemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => {
  let value: { uid: string | null; canCreate: boolean } = { uid: 'uid-a', canCreate: true };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Partial<{ uid: string | null; canCreate: boolean }>) { value = { ...value, ...next }; for (const l of [...listeners]) l(); },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
});
vi.mock('../firebase', () => ({ auth: { currentUser: null } }));
// The routed page reads the signed-in user and the local create hint from the access context: a switchable stand-in.
vi.mock('../context/AccessContext', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAccess: () => {
      const v = useSyncExternalStore(access.subscribe, access.get);
      return { session: v.uid === null ? null : { user: { id: v.uid } }, hasPermission: (perm: string) => perm === 'customers' && v.canCreate };
    },
  };
});

import {
  CHECK_CUTOFF_MS, CONNECTION_CHANGED_TEXT, CustomerDirectoryPage, EMPTY_TEXT, LAST_KNOWN_TEXT, NAME_RULE_TEXT, NOT_FOUND_TEXT,
  savedEarlierText, STOP_WARNING_TEXT, createHoldStore, unresolvedText, type HoldStore,
} from './ServerCustomerDirectory';
import { createTenantSessionClient, TENANT_SESSION_PATHS } from './tenantSessionClient';
import { CUSTOMERS_PATH, createCustomersClient } from './customersClient';
import { normalizeCustomerName as serverNormalizeCustomerName } from '../../server/runtime/customerCreate';
import { decodeCustomerCursor, encodeCustomerCursor, inCustomerPageOrder } from '../../server/runtime/customerDirectory';
import { sessionSubjectOf } from '../../server/runtime/sessions';

/** The tenant session 200 as the server writes it (M7A-CUSTOMERS-P5-R1): its token and whose session it is. */
const activeBody = (uid: string, csrfToken: string) =>
  ({ status: 'active', csrfToken, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });

const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i; // server/runtime/idempotency.ts
const CANONICAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

// How the fake server answers the next POST that reaches its store. `commit-*` creates the customer, seals the 201 for
// the key, then answers otherwise; `rollback-503` acquires the key and commits nothing (the lease stays); `lost-before`
// never reaches the server. A number is a refusal decided BEFORE the key is acquired (nothing reserved) — a 429 before
// the session is even read, as in the real chain.
type PostPlan =
  | 'ok' | 'lost-after-commit' | 'lost-before' | 'commit-then-503' | 'commit-then-409' | 'rollback-503'
  | 'commit-other-name' | 'commit-bad-body' | 'commit-200' | number;
type ReadPlan = number | 'html' | 'lost' | { readonly limited: string }; // `limited`: a 429 with its own Retry-After
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined; readonly signal: AbortSignal | null }
interface User { uid: string; tenant: string; view: boolean; create: boolean }
interface Row { id: string; name: string }
type Late = Response | 'drop' | undefined;

/** One fake tenant server. `cookie` is the session the browser currently presents; a login replaces it. */
function fakeServer() {
  const users: Record<string, User> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, view: true, create: true },
    'tok-b': { uid: 'uid-b', tenant: TENANT_B, view: true, create: true },
  };
  const sessions = new Map<string, { user: User; tenant: string; csrf: string }>();
  const rows: Record<string, Row[]> = { [TENANT_A]: [], [TENANT_B]: [] };
  const records = new Map<string, { fingerprint: string; leased: boolean; sealed: Row | null }>();
  let sessionCount = 0;
  let idCount = 0xa00; // ids carry a hex letter, so an uppercase spelling is a different string
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? headers : { 'content-type': 'application/json; charset=utf-8', ...headers } });
  const refuse = (status: number, error: string, headers: Record<string, string> = {}): Response => reply(status, { error, requestId: 'req-synthetic' }, headers);
  const WORDS: Record<number, string> = {
    400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'request_in_progress', 413: 'content_too_large',
    415: 'unsupported_media_type', 422: 'idempotency_key_reused', 429: 'rate_limited', 500: 'internal_error', 503: 'service_unavailable',
  };
  const ordered = (tenant: string): Row[] => [...rows[tenant]].sort((x, y) =>
    Buffer.compare(Buffer.from(x.name, 'utf8'), Buffer.from(y.name, 'utf8')) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const openSession = (user: User): string => {
    sessionCount += 1;
    const id = `session-${sessionCount}`;
    sessions.set(id, { user, tenant: user.tenant, csrf: `${'s'.repeat(40)}${String(sessionCount).padStart(3, '0')}` });
    return id;
  };

  const server = {
    sent: [] as Sent[],
    users,
    rows,
    sessions,
    cookie: null as string | null,
    pageSize: 50,
    retryAfter: '1' as string | null, // the Retry-After every 429 carries
    posts: [] as PostPlan[],
    reads: [] as ReadPlan[], // the next customer reads (list or detail)
    logins: [] as number[], // the next logins
    checks: [] as number[], // the next session reads
    hold: { reads: 0, posts: 0, checks: 0 }, // answers to hold (checks: session reads): computed on arrival, released by the test
    held: [] as Array<{ url: string; release: (late?: Late) => void }>,
    down: false, // every request fails with no answer
    swapOnRead: null as string | null,
    /** Customers already stored for a tenant. */
    seed(tenant: string, names: readonly string[]): Row[] {
      const made = names.map((name) => ({ id: uuid(++idCount), name }));
      rows[tenant].push(...made);
      return made;
    },
    csrfOfCookie: (): string | null => (server.cookie === null ? null : sessions.get(server.cookie)?.csrf ?? null),
    /** Another tab signed in: the browser's cookie now names a NEW session of `token`'s user (the old one still stands). */
    otherTab(token: string): void { server.cookie = openSession(users[token]); },
    /** The account's grant moved: its sessions end, and its next login is admitted to `tenant`. */
    moveGrant(token: string, tenant: string): void {
      users[token].tenant = tenant;
      for (const [id, s] of sessions) if (s.user === users[token]) sessions.delete(id);
    },
    /** Every unfinished attempt's lease has run out: the same key is reclaimed and planned again. */
    expireLeases(): void { for (const r of records.values()) if (r.sealed === null) r.leased = false; },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : undefined;
      server.sent.push({ method, url, headers, body, signal: init.signal ?? null });
      if (server.down) throw new TypeError('network');
      // Another tab of this browser signs in as `swapOnRead`'s user just before the next customer read arrives: the
      // read leaves with the page's token and arrives with the other session's cookie (M7A-CUSTOMERS-P5-R1).
      if (method === 'GET' && url.startsWith(CUSTOMERS_PATH) && server.swapOnRead !== null) {
        const token = server.swapOnRead;
        server.swapOnRead = null;
        server.otherTab(token);
      }
      const limited = (): Response => refuse(429, WORDS[429], server.retryAfter === null ? {} : { 'retry-after': server.retryAfter });
      const held = async (kind: 'reads' | 'posts' | 'checks', answer: Response | 'lost'): Promise<Response> => {
        if (server.hold[kind] > 0) {
          server.hold[kind] -= 1;
          const late = await new Promise<Late>((release) => { server.held.push({ url, release }); });
          if (late === 'drop') throw new TypeError('network');
          if (late !== undefined) return late;
        }
        if (answer === 'lost') throw new TypeError('network');
        return answer;
      };

      if (url === TENANT_SESSION_PATHS.login && method === 'POST') {
        const plan = server.logins.shift();
        if (plan !== undefined) return plan === 429 ? limited() : refuse(plan, WORDS[plan] ?? 'refused');
        if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, WORDS[403]);
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return refuse(401, WORDS[401]);
        server.cookie = openSession(user);
        return reply(200, activeBody(user.uid, sessions.get(server.cookie)!.csrf));
      }
      const session = server.cookie === null ? undefined : sessions.get(server.cookie);
      if (url === TENANT_SESSION_PATHS.current && method === 'GET') {
        const plan = server.checks.shift();
        const answer = plan !== undefined ? (plan === 429 ? limited() : refuse(plan, WORDS[plan] ?? 'refused'))
          : session === undefined ? refuse(401, WORDS[401]) : reply(200, activeBody(session.user.uid, session.csrf));
        return server.hold.checks > 0 ? held('checks', answer) : answer;
      }
      if (url === TENANT_SESSION_PATHS.logout && method === 'POST') {
        if (server.cookie !== null) sessions.delete(server.cookie);
        server.cookie = null;
        return reply(204);
      }

      const path = url.split('?')[0];
      if (method === 'GET' && (path === CUSTOMERS_PATH || path.startsWith(`${CUSTOMERS_PATH}/`))) {
        // Decided on arrival, as the server does; a held answer is the state when the request arrived.
        const decide = (): Response | 'lost' => {
          const plan = server.reads.shift();
          if (plan === 429) return limited(); // before any session is read
          if (typeof plan === 'object') return refuse(429, WORDS[429], { 'retry-after': plan.limited });
          if (session === undefined) return refuse(401, WORDS[401]);
          // M7A-CUSTOMERS-P5-R1: a read names its session; another session's token (or none) is refused, as by the chain.
          if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, WORDS[403]);
          if (!session.user.view) return refuse(403, WORDS[403]);
          if (plan === 'lost') return 'lost';
          if (plan === 'html') return new Response('<!doctype html><title>Shop</title>', { status: 200, headers: { 'content-type': 'text/html' } });
          if (plan !== undefined) return refuse(plan, WORDS[plan] ?? 'refused');
          if (path !== CUSTOMERS_PATH) {
            if (url.includes('?')) return refuse(400, WORDS[400]);
            const id = path.slice(CUSTOMERS_PATH.length + 1);
            if (id.includes('/') || id.length === 0) return refuse(404, WORDS[404]); // no route
            if (!CANONICAL_ID_RE.test(id)) return refuse(400, WORDS[400]);
            const found = rows[session.tenant].find((r) => r.id === id); // another tenant's id is simply not here
            return found === undefined ? refuse(404, WORDS[404]) : reply(200, { customer: { id: found.id, name: found.name } });
          }
          const all = ordered(session.tenant);
          let start = 0;
          if (url !== CUSTOMERS_PATH) {
            const m = /^\?cursor=([A-Za-z0-9_-]{1,32})$/.exec(url.slice(CUSTOMERS_PATH.length)); // the page sends no other query
            const id = m === null ? null : decodeCustomerCursor(m[1]);
            const at = id === null ? -1 : all.findIndex((r) => r.id === id);
            if (at < 0) return refuse(400, WORDS[400]); // malformed, foreign or deleted: one answer
            start = at + 1;
          }
          const slice = all.slice(start, start + server.pageSize);
          const more = all.length > start + server.pageSize;
          return reply(200, { customers: slice.map((r) => ({ id: r.id, name: r.name })), nextCursor: more ? encodeCustomerCursor(slice[slice.length - 1].id) : null });
        };
        return held('reads', decide());
      }

      if (method === 'POST' && url === CUSTOMERS_PATH) {
        const decide = (): Response | 'lost' => {
          const plan = server.posts.shift() ?? 'ok';
          if (plan === 'lost-before') return 'lost';
          if (plan === 429) return limited();
          if (!/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(headers.get('content-type') ?? '')) return refuse(415, WORDS[415]);
          if (headers.get('x-tmpos-csrf') !== '1') return refuse(403, WORDS[403]);
          if (session === undefined) return refuse(401, WORDS[401]);
          if (headers.get('x-tmpos-session-csrf') !== session.csrf) return refuse(403, WORDS[403]); // not this session's token
          if (!session.user.create) return refuse(403, WORDS[403]);
          let parsed: unknown;
          try { parsed = JSON.parse(body ?? ''); } catch { return refuse(400, WORDS[400]); }
          const idempotencyKey = headers.get('idempotency-key') ?? '';
          if (!KEY_RE.test(idempotencyKey)) return refuse(400, WORDS[400]);
          if (typeof plan === 'number') return plan === 200 ? reply(200, { customer: { id: uuid(1), name: 'x' } }) : refuse(plan, WORDS[plan] ?? 'refused');
          // The key's scope is (key, principal); its fingerprint binds the tenant, the actor and the exact bytes.
          const scope = `${idempotencyKey.toLowerCase()}|${session.user.uid}`;
          const fingerprint = `${session.tenant}|${session.user.uid}|${body}`;
          const record = records.get(scope);
          if (record !== undefined && record.fingerprint !== fingerprint) return refuse(422, WORDS[422]);
          if (record !== undefined && record.sealed !== null) {
            return reply(201, { customer: record.sealed }, { location: `${CUSTOMERS_PATH}/${record.sealed.id}`, 'idempotent-replayed': 'true' });
          }
          if (record !== undefined && record.leased) return refuse(409, WORDS[409]);
          const mine = { fingerprint, leased: true, sealed: null as Row | null };
          records.set(scope, mine);
          // Only now is the body judged: a refused name keeps the lease.
          const shape = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed) : [];
          const name = shape.length === 1 && shape[0] === 'name' ? serverNormalizeCustomerName((parsed as { name: unknown }).name) : null;
          if (name === null) return refuse(400, WORDS[400]);
          if (plan === 'rollback-503') return refuse(503, WORDS[503]);
          const customer = { id: uuid(++idCount), name };
          rows[session.tenant].push(customer);
          mine.sealed = customer;
          if (plan === 'lost-after-commit') return 'lost';
          if (plan === 'commit-then-503') return refuse(503, WORDS[503]);
          if (plan === 'commit-then-409') return refuse(409, WORDS[409]);
          if (plan === 'commit-other-name') return reply(201, { customer: { id: customer.id, name: 'Someone Else' } }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
          if (plan === 'commit-bad-body') return reply(201, { customer: { ...customer, tenant: session.tenant } }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
          if (plan === 'commit-200') return reply(200, { customer }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
          return reply(201, { customer }, { location: `${CUSTOMERS_PATH}/${customer.id}` });
        };
        return held('posts', decide());
      }
      return refuse(404, WORDS[404]);
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

interface MountOptions {
  readonly path?: string;
  readonly keys?: string[];
  readonly holds?: HoldStore;
  readonly defaultHolds?: boolean; // mount WITHOUT an injected hold store: the page's own module-level one
  readonly now?: () => number;
  readonly tokens?: Record<string, string>;
}
function mount(server: Server, options: MountOptions = {}) {
  const tokens = options.tokens ?? { 'uid-a': 'tok-a', 'uid-b': 'tok-b' };
  const made: string[] = [];
  let n = 0;
  const newKey = (): string => {
    const next = options.keys?.[n] ?? key((n % 9) + 1);
    n += 1;
    made.push(next);
    return next;
  };
  const holds = options.holds ?? createHoldStore();
  const page = (
    <CustomerDirectoryPage
      session={createTenantSessionClient({ fetch: server.fetch })}
      customers={createCustomersClient({ fetch: server.fetch })}
      identity={{ idToken: async (uid) => tokens[uid] ?? null }}
      holds={options.defaultHolds === true ? undefined : holds}
      newKey={newKey}
      now={options.now}
    />
  );
  const router = createMemoryRouter([
    { path: '/customers/directory/:id?', element: page },
    { path: '/customers/:id', element: <Navigate to="/customers" replace /> }, // App.tsx's redirect, below the directory
    { path: '/customers', element: <p data-testid="local-customers">local customers</p> },
    { path: '/elsewhere', element: <p data-testid="elsewhere">elsewhere</p> },
  ], { initialEntries: [options.path ?? '/customers/directory'] });
  const view = render(<RouterProvider router={router} />);
  const go = (to: string) => act(async () => { await router.navigate(to); });
  return { ...view, router, holds, made, go };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
const state = () => screen.getByTestId('directory-state');
const phase = (): string | null => state().getAttribute('data-phase');
const ready = () => waitFor(() => expect(phase()).toBe('ready'));
const names = (): string[] => screen.queryAllByTestId('directory-row').map((r) => r.textContent ?? '');
const hold = () => screen.getByTestId('directory-hold');
const addButton = () => screen.getByTestId('directory-add');
const nameInput = () => screen.getByTestId('directory-name') as HTMLInputElement;
const createStatus = () => screen.getByTestId('directory-create-status');
const posts = (s: Server) => s.sent.filter((r) => r.method === 'POST' && r.url === CUSTOMERS_PATH);
const lists = (s: Server) => s.sent.filter((r) => r.method === 'GET' && r.url.split('?')[0] === CUSTOMERS_PATH);
const details = (s: Server) => s.sent.filter((r) => r.method === 'GET' && r.url.startsWith(`${CUSTOMERS_PATH}/`));
const logins = (s: Server) => s.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login);
const click = async (testId: string) => { await userEvent.setup().click(screen.getByTestId(testId)); };
const typeName = async (name: string) => {
  const user = userEvent.setup();
  await user.clear(nameInput());
  if (name !== '') await user.type(nameInput(), name);
};
const addCustomer = async (name: string) => {
  await typeName(name);
  await click('directory-add');
};
const focusWindow = async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
};
const unresolved = () => waitFor(() => expect(hold()).toHaveAttribute('data-state', 'unresolved'));
const page = (): string => screen.getByTestId('customer-directory').textContent ?? '';

/** Nothing on the wire selects or asserts a tenant, store, role or actor: the session is the only source of scope. */
const SELECTOR_RE = /tenant|store|role|actor|uid|user/i;
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'authorization', 'x-tmpos-csrf', 'x-tmpos-session-csrf', 'idempotency-key']);
function expectNoSelector(server: Server): void {
  expect(server.sent.length).toBeGreaterThan(0);
  for (const r of server.sent) {
    expect(r.url).not.toMatch(SELECTOR_RE);
    for (const [name] of r.headers) expect(ALLOWED_HEADERS.has(name), `header ${name} on ${r.method} ${r.url}`).toBe(true);
    if (r.headers.has('authorization')) expect(r.url).toBe(TENANT_SESSION_PATHS.login);
    if (r.url.startsWith(CUSTOMERS_PATH)) {
      if (r.method === 'GET') {
        expect([...r.headers].map(([name]) => name)).toEqual(['accept', 'x-tmpos-session-csrf']); // the session it names (P5-R1)
        expect(r.headers.get('x-tmpos-session-csrf')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(r.body).toBeUndefined();
        expect(r.url).not.toMatch(/limit=/);
      } else {
        expect(Object.keys(JSON.parse(r.body ?? 'null') as object)).toEqual(['name']);
      }
    }
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  access.set({ uid: 'uid-a', canCreate: true });
});

describe('ServerCustomerDirectory (M7A-CUSTOMERS-P5)', () => {
  it('SCD-00. the fake server is as strict as the real one where the page could be wrong about it', async () => {
    const server = fakeServer();
    const send = (method: string, url: string, headers: Record<string, string> = {}, body?: string) => server.fetch(url, { method, headers, body });
    const login = await send('POST', TENANT_SESSION_PATHS.login, { authorization: 'Bearer tok-a', 'x-tmpos-csrf': '1' });
    const csrfA = ((await login.json()) as { csrfToken: string }).csrfToken;
    expect(csrfA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const post = (k: string, body: string, csrf = csrfA, more: Record<string, string> = {}) =>
      send('POST', CUSTOMERS_PATH, { 'content-type': 'application/json', 'x-tmpos-csrf': '1', 'x-tmpos-session-csrf': csrf, 'idempotency-key': k, ...more }, body);
    const good = JSON.stringify({ name: 'Ada Lovelace' });
    expect((await post(key(1), good, 'x'.repeat(43))).status).toBe(403); // another session's token
    expect((await send('POST', CUSTOMERS_PATH, { 'content-type': 'application/json', 'x-tmpos-session-csrf': csrfA, 'idempotency-key': key(1) }, good)).status).toBe(403); // no intent header
    expect((await post(key(1), good, csrfA, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post('not-a-key', good)).status).toBe(400);
    expect((await post(uuid(7).replace('-4000-', '-1000-'), good)).status).toBe(400); // a v1-shaped key
    expect(server.rows[TENANT_A]).toEqual([]); // nothing so far reserved or created anything
    // A refused name is decided AFTER the key is acquired: the 400 keeps the lease, so the same key is then in progress.
    expect((await post(key(2), JSON.stringify({ name: '   ' }))).status).toBe(400);
    expect((await post(key(2), JSON.stringify({ name: '   ' }))).status).toBe(409);
    expect((await post(key(2), good)).status).toBe(422); // the same key with other bytes
    expect((await post(key(3), JSON.stringify({ name: 'Ada', tenantId: TENANT_B }))).status).toBe(400); // exactly { name }
    // A 201 with Location; the same key and bytes replay it, marked; other bytes are refused.
    const first = await post(key(4), good);
    const made = ((await first.json()) as { customer: Row }).customer;
    expect(first.status).toBe(201);
    expect(first.headers.get('location')).toBe(`${CUSTOMERS_PATH}/${made.id}`);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    const replay = await post(key(4), good);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as { customer: Row }).customer).toEqual(made);
    expect((await post(key(4), JSON.stringify({ name: 'Ada  Lovelace' }))).status).toBe(422);
    expect(server.rows[TENANT_A]).toEqual([made]);
    // Byte-order pages behind real cursors; a cursor naming no customer of this tenant is one 400.
    const seeded = server.seed(TENANT_A, ['Zoe', 'adam', String.fromCodePoint(0xc9, 0x6d, 0x69, 0x6c, 0x65), 'Bob']);
    server.pageSize = 2;
    // A read names its session (M7A-CUSTOMERS-P5-R1): without the token, or with another session's, it is refused.
    const bound = { 'x-tmpos-session-csrf': csrfA };
    expect((await send('GET', CUSTOMERS_PATH)).status).toBe(403);
    expect((await send('GET', CUSTOMERS_PATH, { 'x-tmpos-session-csrf': 'x'.repeat(43) })).status).toBe(403);
    const one = (await (await send('GET', CUSTOMERS_PATH, bound)).json()) as { customers: Row[]; nextCursor: string };
    expect(one.nextCursor).toMatch(/^[A-Za-z0-9_-]{23}$/);
    expect((await send('GET', `${CUSTOMERS_PATH}?cursor=${one.nextCursor}`)).status).toBe(403);
    const two = (await (await send('GET', `${CUSTOMERS_PATH}?cursor=${one.nextCursor}`, bound)).json()) as { customers: Row[]; nextCursor: string };
    const three = (await (await send('GET', `${CUSTOMERS_PATH}?cursor=${two.nextCursor}`, bound)).json()) as { customers: Row[]; nextCursor: string | null };
    const walked = [...one.customers, ...two.customers, ...three.customers];
    expect(walked.map((r) => r.name)).toEqual(['Ada Lovelace', 'Bob', 'Zoe', 'adam', String.fromCodePoint(0xc9, 0x6d, 0x69, 0x6c, 0x65)]);
    expect(inCustomerPageOrder(walked)).toBe(true); // the server's own order predicate
    expect(three.nextCursor).toBeNull();
    const [foreign] = server.seed(TENANT_B, ['Foreign']);
    expect((await send('GET', `${CUSTOMERS_PATH}?cursor=${encodeCustomerCursor(foreign.id)}`, bound)).status).toBe(400);
    expect((await send('GET', `${CUSTOMERS_PATH}?limit=10`, bound)).status).toBe(400);
    expect((await send('GET', `${CUSTOMERS_PATH}/${foreign.id}`, bound)).status).toBe(404); // another tenant's id == a missing one
    expect((await send('GET', `${CUSTOMERS_PATH}/${uuid(0xdead)}`, bound)).status).toBe(404);
    expect((await send('GET', `${CUSTOMERS_PATH}/${seeded[0].id}`)).status).toBe(403); // a detail names its session too
    expect((await send('GET', `${CUSTOMERS_PATH}/${seeded[0].id.toUpperCase()}X`, bound)).status).toBe(400);
    // Sessions are bound to tenants, each with its own token; the same key under another tenant is refused.
    server.moveGrant('tok-a', TENANT_B);
    expect((await send('GET', CUSTOMERS_PATH)).status).toBe(401);
    const again = await send('POST', TENANT_SESSION_PATHS.login, { authorization: 'Bearer tok-a', 'x-tmpos-csrf': '1' });
    const csrfB = ((await again.json()) as { csrfToken: string }).csrfToken;
    expect(csrfB).not.toBe(csrfA);
    expect((await post(key(4), good, csrfA)).status).toBe(403);
    expect((await post(key(4), good, csrfB)).status).toBe(422);
    expect(server.rows[TENANT_B]).toEqual([foreign]);
  });

  it('SCD-01. loading, then the empty directory: one login, one page-one read, nothing that names a store', async () => {
    const server = fakeServer();
    server.hold.reads = 1;
    mount(server);
    expect(screen.getByRole('heading', { level: 1, name: 'Customer directory' })).toBeInTheDocument();
    expect(page()).toContain("Saved on the server for this store. Only the customer's name is stored here.");
    expect(page()).toContain('held only in this browser\'s memory and are not linked');
    expect(phase()).toBe('loading');
    expect(screen.queryByTestId('directory-empty')).toBeNull(); // never before a list answer
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(phase()).toBe('loading');
    expect(addButton()).toBeDisabled();
    expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('Available once the list has loaded from the server.');
    server.held[0].release();
    await ready();
    expect(screen.getByTestId('directory-empty')).toHaveTextContent(EMPTY_TEXT);
    expect(screen.queryByTestId('directory-list')).toBeNull();
    // The session this browser holds is read first (none here: 401), and only then does the page sign in (P5-R1).
    expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`,
    ]);
    expect(addButton()).toBeEnabled();
    expectNoSelector(server);
  });

  it('SCD-02. rows are shown in the order they arrive (the server\'s byte order), each a link named by the customer', async () => {
    const server = fakeServer();
    const accented = String.fromCodePoint(0xc9, 0x6d, 0x69, 0x6c, 0x65); // sorts last in bytes, among the E's in a locale order
    const seeded = server.seed(TENANT_A, ['adam', accented, 'Zoe', 'Bob']);
    server.seed(TENANT_B, ['Foreign']);
    mount(server);
    await ready();
    expect(names()).toEqual(['Bob', 'Zoe', 'adam', accented]);
    expect([...names()].sort((x, y) => x.localeCompare(y))).not.toEqual(names()); // a re-sort would show another order
    expect(screen.getByTestId('directory-list').tagName).toBe('UL');
    const bob = seeded.find((r) => r.name === 'Bob')!;
    const row = screen.getAllByTestId('directory-row')[0];
    expect(row).toHaveAttribute('data-id', bob.id);
    expect(within(row).getByRole('link', { name: 'Bob' })).toHaveAttribute('href', `/customers/directory/${bob.id}`);
    expect(page()).not.toContain('Foreign');
    expect(screen.queryByTestId('directory-empty')).toBeNull();
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
  });

  it('SCD-03. 60 customers: 50, then "Load more" sends the server\'s cursor verbatim and shows 60 with no duplicate', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    expect(names()).toHaveLength(50);
    const cursor = encodeCustomerCursor(screen.getAllByTestId('directory-row')[49].getAttribute('data-id')!);
    // The second page arrives carrying an id already shown (a row that moved): it is appended once.
    server.hold.reads = 1;
    await click('directory-load-more');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(screen.getByTestId('directory-load-more')).toBeDisabled(); // one list read at a time
    expect(screen.getByTestId('directory-refresh')).toBeDisabled();
    const shown = screen.getAllByTestId('directory-row')[3];
    const second = [...server.rows[TENANT_A]].sort((x, y) => (x.name < y.name ? -1 : 1)).slice(50);
    const dup = { id: shown.getAttribute('data-id')!, name: shown.textContent! };
    server.held[0].release(new Response(JSON.stringify({ customers: [dup, ...second], nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(lists(server).map((r) => r.url)).toEqual([CUSTOMERS_PATH, `${CUSTOMERS_PATH}?cursor=${cursor}`]);
    const ids = screen.getAllByTestId('directory-row').map((r) => r.getAttribute('data-id'));
    expect(new Set(ids).size).toBe(60);
    expect(names()).toEqual(Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`)); // arrival order kept
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    expectNoSelector(server);
  });

  it('SCD-04. a cursor the server no longer accepts: ONE reload from page one, with a note, and no loop', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    // The customer the cursor names is deleted: the server answers its one 400 for that cursor.
    const last = screen.getAllByTestId('directory-row')[49].getAttribute('data-id')!;
    server.rows[TENANT_A] = server.rows[TENANT_A].filter((r) => r.id !== last);
    await click('directory-load-more');
    await waitFor(() => expect(screen.getByTestId('directory-list-note')).toHaveTextContent('loaded again from the start'));
    await ready();
    expect(lists(server).map((r) => r.url)).toEqual([CUSTOMERS_PATH, `${CUSTOMERS_PATH}?cursor=${encodeCustomerCursor(last)}`, CUSTOMERS_PATH]);
    expect(names()).toHaveLength(50);
    expect(names()).not.toContain('Customer 49');
    await settle();
    expect(lists(server)).toHaveLength(3); // the reload did not trigger itself again
    // A page one that itself answers 400 is an outage, never another reload.
    server.reads.push(400);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    await settle();
    expect(lists(server)).toHaveLength(4);
  });

  it('SCD-05. "Load more" that fails is a failed refresh: the rows stay under the last-known label and "Try again" reads page one (L1)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    for (const plan of [503, 'lost', 'html'] as ReadPlan[]) {
      server.reads.push(plan);
      await click('directory-load-more');
      await waitFor(() => expect(phase()).toBe('unavailable'));
      expect(names()).toHaveLength(50);
      expect(screen.getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
      expect(screen.queryByTestId('directory-list-note')).toBeNull();
      expect(screen.queryByTestId('directory-load-more')).toBeNull();
      expect(addButton()).toBeDisabled();
      await click('directory-retry'); // page one again
      await ready();
      expect(names()).toHaveLength(50);
    }
    await click('directory-load-more');
    await waitFor(() => expect(names()).toHaveLength(60));
    expect(screen.queryByTestId('directory-list-note')).toBeNull();
  });

  it('SCD-06. a 401 on the list, and a sign-in the server refuses: no rows, "Reconnect" runs the load again', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.reads.push(401);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(names()).toEqual([]); // nothing of the server's stays on screen
    expect(screen.queryByTestId('directory-last-known')).toBeNull();
    expect(screen.getByTestId('directory-retry')).toHaveTextContent('Reconnect');
    expect(addButton()).toBeDisabled();
    await click('directory-retry');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    // The session is gone: Refresh finds it ended and signs nothing in (M7A-CUSTOMERS-P6); nothing is read.
    server.sessions.clear();
    server.logins.push(401);
    const before = lists(server).length;
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent('Your server session ended. Reconnect');
    expect(names()).toEqual([]);
    expect(lists(server)).toHaveLength(before);
    expect(logins(server)).toHaveLength(1);
    expect(server.logins).toEqual([401]); // the planned refusal is still unused: no login was sent
    // Reconnect signs in, and the server refuses the sign-in: the same state, and nothing is read.
    await click('directory-retry');
    await waitFor(() => expect(state()).toHaveTextContent('did not accept this sign-in'));
    expect(phase()).toBe('signed-out');
    expect(names()).toEqual([]);
    expect(lists(server)).toHaveLength(before);
    expect(logins(server)).toHaveLength(2);
    await click('directory-retry'); // Reconnect: ensure() signs in again
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(addButton()).toBeEnabled();
    expect(logins(server)).toHaveLength(3);
  });

  it('SCD-07. a 403 on the list is the denied state: rows cleared, no local fallback, no create', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.users['tok-a'].view = false; // the owner narrowed this role to None
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(state()).toHaveTextContent('This account may not view');
    expect(state()).toHaveAttribute('role', 'alert');
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-list')).toBeNull();
    expect(screen.queryByTestId('directory-empty')).toBeNull(); // a refusal is not an empty directory
    expect(addButton()).toBeDisabled();
    expect(screen.queryByTestId('directory-retry')).toBeNull();
    server.users['tok-a'].view = true;
    await click('directory-refresh');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
  });

  it('SCD-08. a 429 on the list: the wait in seconds, last-known rows, and a retry that is disabled until the wait has passed', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Too many requests. Wait 1 second, then try again.');
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(screen.getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
    expect(screen.getByTestId('directory-retry')).toHaveTextContent('Try again');
    expect(screen.getByTestId('directory-retry')).toBeDisabled();
    expect(addButton()).toBeDisabled();
    const before = server.sent.length;
    await waitFor(() => expect(screen.getByTestId('directory-retry')).toBeEnabled(), { timeout: 3000 });
    expect(server.sent).toHaveLength(before); // the wait re-enables the button; it sends nothing
    await click('directory-retry');
    await ready();
    expect(screen.queryByTestId('directory-last-known')).toBeNull();
    // Without a Retry-After the wait is a minute.
    server.retryAfter = null;
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Wait 60 seconds');
  });

  it('SCD-09. a 503, no answer, an HTML 200 and a 404: "Try again"; confirmed rows stay as last known, none confirmed shows none', async () => {
    for (const plan of [503, 'lost', 'html', 404] as ReadPlan[]) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Ada', 'Bob']);
      server.reads.push(plan);
      mount(server);
      await waitFor(() => expect(phase()).toBe('unavailable'));
      expect(state()).toHaveTextContent('The customer directory is unavailable right now.'); // S1: true whether or not the server answered
      expect(state()).not.toHaveTextContent('could not be reached');
      expect(names()).toEqual([]); // nothing confirmed in this generation
      expect(screen.queryByTestId('directory-last-known')).toBeNull();
      expect(screen.queryByTestId('directory-empty')).toBeNull(); // a failure is never an empty directory
      expect(screen.getByTestId('directory-retry')).toHaveTextContent('Try again');
      await click('directory-retry');
      await ready();
      expect(names()).toEqual(['Ada', 'Bob']);
      server.seed(TENANT_A, ['Cy']);
      server.reads.push(plan);
      await click('directory-refresh');
      await waitFor(() => expect(phase()).toBe('unavailable'));
      expect(names()).toEqual(['Ada', 'Bob']);
      expect(screen.getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
      expect(addButton()).toBeDisabled();
      await click('directory-retry');
      await ready();
      expect(names()).toEqual(['Ada', 'Bob', 'Cy']);
      expect(addButton()).toBeEnabled();
      cleanup();
    }
    // The server cannot be reached for the session either.
    const offline = fakeServer();
    offline.down = true;
    mount(offline);
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(lists(offline)).toHaveLength(0);
    offline.down = false;
    await click('directory-retry');
    await ready();
  });

  it('SCD-10. a detail by click shows its OWN answer, takes focus, and "Back" returns to the same list without reading it again', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    server.rows[TENANT_A].find((r) => r.id === ada.id)!.name = 'Ada Byron'; // renamed since the list was read
    await userEvent.setup().click(screen.getByRole('link', { name: 'Ada' }));
    const detail = await screen.findByTestId('directory-detail');
    await waitFor(() => expect(detail).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Byron$/); // never the list row's name
    expect(screen.getByTestId('directory-detail-id')).toHaveTextContent(ada.id);
    expect(screen.getByRole('heading', { level: 2, name: 'Customer' })).toHaveFocus();
    expect(details(server).map((r) => r.url)).toEqual([`${CUSTOMERS_PATH}/${ada.id}`]);
    expect(screen.queryByTestId('directory-state')).toBeNull();
    const listReads = lists(server).length;
    await userEvent.setup().click(screen.getByTestId('directory-back'));
    await waitFor(() => expect(screen.queryByTestId('directory-detail')).toBeNull());
    expect(phase()).toBe('ready');
    expect(names()).toEqual(['Ada', 'Bob']); // the list as it was read: it survived the detail
    expect(lists(server)).toHaveLength(listReads);
    expect(screen.getByRole('heading', { level: 2, name: 'Customers on the server' })).toHaveFocus();
    expectNoSelector(server);
  });

  it('SCD-11. a detail by direct address also reads the list, so "Back" shows a real list state', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server, { path: `/customers/directory/${ada.id}` });
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada');
    await waitFor(() => expect(lists(server)).toHaveLength(1)); // started on mount, whatever the route
    expect(logins(server)).toHaveLength(1); // one sign-in serves both reads
    expect(screen.getByTestId('directory-back')).toHaveAttribute('href', '/customers/directory');
    await userEvent.setup().click(screen.getByTestId('directory-back'));
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(lists(server)).toHaveLength(1);
  });

  it('SCD-12. a missing id, another store\'s id and a malformed id show ONE text; a malformed id is never sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    const [foreign] = server.seed(TENANT_B, ['Foreign']);
    const seen: string[] = [];
    const view = mount(server, { path: `/customers/directory/${uuid(0xdead)}` });
    for (const id of [uuid(0xdead), foreign.id]) {
      await view.go(`/customers/directory/${id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found'));
      seen.push(screen.getByTestId('directory-detail').textContent ?? '');
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    }
    expect(details(server).map((r) => r.url)).toEqual([`${CUSTOMERS_PATH}/${uuid(0xdead)}`, `${CUSTOMERS_PATH}/${foreign.id}`]);
    await settle();
    const before = server.sent.length;
    for (const bad of ['new', foreign.id.toUpperCase(), `${foreign.id}x`, 'c1700000000000', '..%2Fsession%2Flogout', 'a%3Fcursor%3Dx']) {
      await view.go(`/customers/directory/${bad}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found'));
      seen.push(screen.getByTestId('directory-detail').textContent ?? '');
    }
    await settle();
    expect(details(server)).toHaveLength(2); // no request was built from a malformed id
    expect(server.sent).toHaveLength(before); // nothing at all was sent for one: not even a session read
    expect(new Set(seen).size).toBe(1); // identical, word for word
    expect(screen.getByTestId('directory-not-found')).toHaveTextContent(NOT_FOUND_TEXT);
    expect(page()).not.toContain('Foreign');
    expect(server.sent.every((r) => !r.url.includes('logout') && !r.url.includes('cursor'))).toBe(true);
  });

  it('SCD-13. a detail 200 that is not exactly this customer is never shown', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const bodies: unknown[] = [
      { customer: { id: bob.id, name: 'Bob' } }, // another customer's answer
      { customer: { id: ada.id, name: 'Ada', email: 'ada@synthetic.test' } },
      { customer: { id: ada.id, name: 'Ada' }, tenant: TENANT_A },
      { customers: [{ id: ada.id, name: 'Ada' }], nextCursor: null },
    ];
    for (const body of bodies) {
      server.hold.reads = 2; // the list read and the detail read
      mount(server, { path: `/customers/directory/${ada.id}` });
      await waitFor(() => expect(server.held).toHaveLength(2));
      for (const h of server.held) {
        h.release(h.url === CUSTOMERS_PATH ? undefined : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      server.held.length = 0;
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'unavailable'));
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
      expect(screen.queryByTestId('directory-detail-id')).toBeNull();
      expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Try again');
      cleanup();
    }
  });

  it('SCD-14. a late answer for another id is dropped: only the id the address names is shown', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const view = mount(server);
    await ready();
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(1)); // Ada's read is out
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    expect(details(server)[0].signal?.aborted).toBe(true); // the superseded read was cancelled
    server.held[0].release(); // Ada's answer arrives anyway
    await settle();
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    expect(screen.getByTestId('directory-detail-id')).toHaveTextContent(bob.id);
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready');
    // Leaving the detail while its read is out: the answer is not applied to the list page either.
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(2));
    await view.go('/customers/directory');
    server.held[1].release();
    await settle();
    expect(screen.queryByTestId('directory-detail')).toBeNull();
    expect(names()).toEqual(['Ada', 'Bob']);
  });

  it('SCD-15. a detail answered 401, 403, 429 or 503: its own state; an answer already shown for the same id stays as last known only when the server cannot be asked', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const view = mount(server, { path: `/customers/directory/${ada.id}` });
    const detail = () => screen.getByTestId('directory-detail');
    const reopen = async (id: string) => {
      await view.go('/customers/directory');
      await view.go(`/customers/directory/${id}`);
    };
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(screen.queryByTestId('directory-detail-retry')).toBeNull(); // ready: nothing to retry
    // 503 on a return to the SAME id: Ada's own earlier answer stays, labelled.
    server.reads.push(503);
    await reopen(ada.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'unavailable'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada$/);
    expect(screen.getByTestId('directory-detail-last-known')).toHaveTextContent('Last known');
    expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Try again');
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    // 429: the same, with the wait; the retry is disabled until it has passed.
    server.reads.push(429);
    await reopen(ada.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'rate-limited'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent('Too many requests. Wait 1 second, then try again.');
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada$/);
    expect(screen.getByTestId('directory-detail-last-known')).toBeInTheDocument();
    expect(screen.getByTestId('directory-detail-retry')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('directory-detail-retry')).toBeEnabled(), { timeout: 3000 });
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    // ANOTHER id that cannot be read shows nothing: Ada's answer is never Bob's last known.
    server.reads.push(503);
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'unavailable'));
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(page()).not.toContain('Ada');
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    // 403: the denied state shows nothing, even for the id just shown.
    server.users['tok-a'].view = false;
    await reopen(bob.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'denied'));
    expect(screen.getByTestId('directory-detail-state')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent('This account may not view');
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-retry')).toBeNull();
    server.users['tok-a'].view = true;
    await reopen(bob.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    // 401: the session ended — nothing shown; Reconnect reads again.
    server.reads.push(401);
    await reopen(bob.id);
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Reconnect');
    await click('directory-detail-retry');
    await waitFor(() => expect(detail()).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Bob$/);
    expect(details(server).every((r) => r.url === `${CUSTOMERS_PATH}/${ada.id}` || r.url === `${CUSTOMERS_PATH}/${bob.id}`)).toBe(true);
  });

  it('SCD-16. a create: ONE POST with the normalized name, this session\'s token and a fresh key; "Saved on the server" only after the 201', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('  Ada Lovelace  ');
    await waitFor(() => expect(server.held).toHaveLength(1));
    // Sent, not answered: held as "sending", and nothing says saved.
    expect(hold()).toHaveAttribute('data-state', 'sending');
    expect(screen.queryByTestId('directory-saved')).toBeNull();
    expect(screen.queryByTestId('directory-check-again')).toBeNull(); // the card's buttons exist only once unresolved
    expect(screen.queryByTestId('directory-stop-tracking')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), body: '{"name":"Ada Lovelace"}', name: 'Ada Lovelace', state: 'sending' });
    server.held[0].release();
    const saved = await screen.findByTestId('directory-saved');
    expect(saved).toHaveTextContent('Saved on the server: "Ada Lovelace".');
    expect(saved).toHaveFocus();
    const made = server.rows[TENANT_A].find((r) => r.name === 'Ada Lovelace')!;
    expect(screen.getByTestId('directory-saved-link')).toHaveAttribute('href', `/customers/directory/${made.id}`);
    const [post] = posts(server);
    expect(posts(server)).toHaveLength(1);
    expect(post.body).toBe('{"name":"Ada Lovelace"}'); // the trimmed name, exactly these bytes
    expect(post.headers.get('idempotency-key')).toBe(key(1));
    expect(post.headers.get('x-tmpos-session-csrf')).toBe(server.csrfOfCookie());
    expect(post.headers.get('x-tmpos-csrf')).toBe('1');
    expect(post.headers.get('content-type')).toBe('application/json');
    await ready();
    expect(names()).toEqual(['Ada Lovelace', 'Bob']); // page one was read again
    expect(nameInput().value).toBe('');
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(view.holds.get('uid-a')).toBeUndefined();
    expect(addButton()).toBeEnabled();
    // The next customer is a new request under a new key; the same name again is a second customer.
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(posts(server)).toHaveLength(2));
    expect(posts(server)[1].headers.get('idempotency-key')).toBe(key(2));
    await waitFor(() => expect(names()).toEqual(['Ada Lovelace', 'Ada Lovelace', 'Bob']));
    expect(server.rows[TENANT_A].filter((r) => r.name === 'Ada Lovelace')).toHaveLength(2);
    // The saved notice's link opens that customer's own answer.
    await userEvent.setup().click(screen.getByTestId('directory-saved-link'));
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent(/^Ada Lovelace$/);
    expectNoSelector(server);
  });

  it('SCD-17. a name the server would refuse is refused here: an inline error, NO request and NO key', async () => {
    const server = fakeServer();
    const view = mount(server);
    await ready();
    const before = server.sent.length;
    const refused = ['', '   ', 'x'.repeat(201), `Ada${String.fromCodePoint(0x202e)}`, `Ada${String.fromCodePoint(0x0)}`, `Ada\tLovelace`, String.fromCodePoint(0x2800), String.fromCodePoint(0x200b)];
    for (const raw of refused) {
      fireEvent.change(nameInput(), { target: { value: raw } });
      await click('directory-add');
      const error = await screen.findByTestId('directory-name-error');
      expect(error).toHaveTextContent(NAME_RULE_TEXT);
      expect(error).toHaveAttribute('role', 'alert');
      expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
      expect(nameInput()).toHaveAttribute('aria-describedby', 'directory-name-error');
      expect(nameInput().value).toBe(raw); // the draft is kept
      expect(addButton()).toBeEnabled();
    }
    await settle();
    expect(server.sent).toHaveLength(before); // not even a session read
    expect(view.made).toEqual([]); // no key was taken
    expect(view.holds.get('uid-a')).toBeUndefined();
    // Editing clears the error; a valid name then goes out.
    fireEvent.change(nameInput(), { target: { value: 'x'.repeat(200) } });
    expect(screen.queryByTestId('directory-name-error')).toBeNull();
    expect(nameInput()).toHaveAttribute('aria-invalid', 'false');
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-18. a double click, and Enter with a click, send ONE POST', async () => {
    const server = fakeServer();
    const view = mount(server);
    await ready();
    server.hold.posts = 1;
    await typeName('Ada Lovelace');
    const button = addButton();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.submit(button.closest('form')!);
    });
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { fireEvent.submit(button.closest('form')!); });
    await settle();
    expect(posts(server)).toHaveLength(1);
    expect(view.made).toHaveLength(1);
    server.held[0].release();
    await screen.findByTestId('directory-saved');
    await settle();
    expect(posts(server)).toHaveLength(1);
    expect(server.rows[TENANT_A]).toHaveLength(1);
  });

  it('SCD-19. a first send the server refuses outright ends the attempt with its own text, keeps the draft, and never says saved', async () => {
    const cases: Array<[number, RegExp]> = [
      [403, /^Refused by the server\./],
      [400, /^The server did not accept this name\./],
      [413, /^The server did not accept this name\./],
      [415, /^The server did not accept this name\./],
      [404, /does not offer adding customers here/],
      [422, /^The server rejected this request\.$/],
    ];
    for (const [status, text] of cases) {
      const server = fakeServer();
      server.posts.push(status);
      const view = mount(server, { keys: [key(1), key(2)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(createStatus()).toHaveTextContent(text));
      expect(createStatus()).toHaveAttribute('role', 'alert');
      expect(page()).not.toMatch(/Saved on the server:/);
      expect(screen.queryByTestId('directory-hold')).toBeNull(); // conclusive: nothing to check again
      expect(view.holds.get('uid-a')).toBeUndefined();
      expect(nameInput().value).toBe('Ada Lovelace');
      expect(server.rows[TENANT_A]).toEqual([]);
      await ready();
      if (status === 403) expect(lists(server)).toHaveLength(2); // the list was read again at once
      await waitFor(() => expect(addButton()).toBeEnabled()); // the form is not left disabled
      await click('directory-add');
      await screen.findByTestId('directory-saved');
      expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]); // a new request, a new key
      expect(createStatus()).toHaveTextContent('');
      cleanup();
    }
  });

  it('SCD-20. a first send answered 401: not sent through — rows cleared, Reconnect, the draft kept, then a new key', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    server.posts.push(401);
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(createStatus()).toHaveTextContent('Not sent through: your server session ended. Reconnect, then add again.');
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('Available once the list has loaded from the server.');
    expect(nameInput().value).toBe('Ada Lovelace');
    await settle();
    expect(posts(server)).toHaveLength(1); // nothing is re-sent on its own
    await click('directory-retry');
    await ready();
    expect(posts(server)).toHaveLength(1); // reconnecting reads; it never sends the create
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
  });

  it('SCD-21. a first send answered 429: the wait is shown, Add is disabled until it has passed, and nothing is sent meanwhile', async () => {
    const server = fakeServer();
    server.posts.push(429);
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(createStatus()).toHaveTextContent('Not sent through: too many requests. Wait 1 second. Then add again.'));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('Wait 1 second.');
    expect(nameInput().value).toBe('Ada Lovelace');
    const before = server.sent.length;
    await waitFor(() => expect(addButton()).toBeEnabled(), { timeout: 3000 });
    expect(server.sent).toHaveLength(before); // the timer sends nothing
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
  });

  it('SCD-22. an undecided first send is UNRESOLVED — never saved, never "not saved" — and nothing is sent again on its own', async () => {
    const plans: PostPlan[] = ['rollback-503', 'commit-then-503', 'commit-then-409', 'commit-other-name', 'commit-bad-body', 'commit-200', 'lost-after-commit', 'lost-before', 500, 409];
    for (const plan of plans) {
      const server = fakeServer();
      server.posts.push(plan);
      const view = mount(server, { keys: [key(1)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
      expect(hold()).toHaveTextContent('Not confirmed yet: "Ada Lovelace". The server may have saved it.');
      expect(hold()).toHaveAttribute('data-detached', 'false');
      expect(page()).not.toMatch(/not saved/i);
      expect(page()).not.toMatch(/Saved on the server:/);
      expect(screen.queryByTestId('directory-saved')).toBeNull();
      expect(hold()).toHaveTextContent(STOP_WARNING_TEXT);
      expect(screen.getByTestId('directory-check-again')).toBeEnabled();
      expect(screen.getByTestId('directory-stop-tracking')).toBeEnabled();
      // The form: the field stays editable and keeps the draft; Add says why it is unavailable.
      expect(nameInput()).toBeEnabled();
      expect(nameInput().value).toBe('Ada Lovelace');
      expect(addButton()).toBeDisabled();
      expect(screen.getByTestId('directory-add-hint')).toHaveTextContent('An earlier customer is not confirmed yet.');
      expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), body: '{"name":"Ada Lovelace"}', state: 'unresolved' });
      // No timer, focus or refresh sends it again.
      await focusWindow();
      await click('directory-refresh');
      await ready();
      await settle();
      expect(posts(server)).toHaveLength(1);
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('SCD-23. the reply is lost after the commit: "Check again" sends the SAME key and bytes, the replay confirms, and ONE customer exists', async () => {
    const server = fakeServer();
    server.posts.push('lost-after-commit');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('No answer from the server.');
    expect(server.rows[TENANT_A]).toHaveLength(1); // it did commit; the page cannot know
    server.hold.posts = 1;
    const check = screen.getByTestId('directory-check-again');
    await act(async () => { // a double click before the card can re-render
      fireEvent.click(check);
      fireEvent.click(check);
    });
    await waitFor(() => expect(server.held).toHaveLength(1));
    await settle();
    expect(posts(server)).toHaveLength(2); // the first send and ONE check
    expect(hold()).toHaveAttribute('data-state', 'checking');
    expect(screen.queryByTestId('directory-check-again')).toBeNull(); // no second check while one is out
    expect(screen.queryByTestId('directory-stop-tracking')).toBeNull();
    server.held[0].release();
    const saved = await screen.findByTestId('directory-saved');
    expect(saved).toHaveTextContent('Saved on the server: "Ada Lovelace".');
    const [first, second] = posts(server);
    expect(posts(server)).toHaveLength(2);
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
    expect(second.headers.get('idempotency-key')).toBe(key(1));
    expect(second.body).toBe(first.body);
    expect(second.headers.get('x-tmpos-session-csrf')).toBe(first.headers.get('x-tmpos-session-csrf'));
    expect(view.made).toEqual([key(1)]); // no new key was taken for the check
    expect(server.rows[TENANT_A]).toHaveLength(1);
    await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(screen.getByTestId('directory-saved-link')).toHaveAttribute('href', `/customers/directory/${server.rows[TENANT_A][0].id}`);
    await waitFor(() => expect(addButton()).toBeEnabled());
    expectNoSelector(server);
  });

  it('SCD-24. unresolved, then the name is edited: "Check again" still sends the ORIGINAL bytes and key', async () => {
    const server = fakeServer();
    server.posts.push('rollback-503');
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await typeName('Grace Hopper'); // the field is never what is re-sent
    // Inside the lease the same key is still in progress.
    await click('directory-check-again');
    await waitFor(() => expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('The server is still working on it.'));
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(page()).not.toMatch(/not saved/i);
    server.expireLeases(); // the lease ran out: the same key is planned again and commits once
    await click('directory-check-again');
    const saved = await screen.findByTestId('directory-saved');
    expect(saved).toHaveTextContent('"Ada Lovelace"');
    expect(posts(server)).toHaveLength(3);
    expect(new Set(posts(server).map((r) => r.body))).toEqual(new Set(['{"name":"Ada Lovelace"}']));
    expect(new Set(posts(server).map((r) => r.headers.get('idempotency-key')))).toEqual(new Set([key(1)]));
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Ada Lovelace']);
    expect(nameInput().value).toBe('Grace Hopper'); // R2: a confirmation clears the draft only when it still is the confirmed name
  });

  it('SCD-25. a check that does not confirm stays unresolved with its reason — a 401, 403, 429, 503, 422 or another name never says "not saved"', async () => {
    const cases: Array<[PostPlan, RegExp]> = [
      [401, /Sign-in needed/],
      [403, /The server refused this check\./],
      [429, /Too many requests\. Wait 1 second\./],
      [503, /The server answered, but not with a result\./],
      ['lost-before', /No answer from the server\./],
      [422, /no longer accepts this as the same request/],
      [400, /did not accept this check/],
      [404, /does not offer this check here/],
      [409, /still working on it/],
      [200, /The server answered, but not with a result\./],
    ];
    for (const [plan, reason] of cases) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bob']);
      server.posts.push('commit-then-503', plan);
      const view = mount(server, { keys: [key(1), key(2)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      const listsBefore = lists(server).length;
      await click('directory-check-again');
      await waitFor(() => expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent(reason));
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
      expect(page()).not.toMatch(/not saved/i);
      expect(page()).not.toMatch(/Saved on the server:/);
      expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'unresolved' }); // still held, whatever the answer
      if (plan === 401) {
        await waitFor(() => expect(phase()).toBe('signed-out')); // the list handling: nothing of the server's stays
        expect(names()).toEqual([]);
        await click('directory-retry');
      } else if (plan === 403) {
        await waitFor(() => expect(lists(server).length).toBe(listsBefore + 1)); // view access re-proved at once
      } else if (plan === 429) {
        expect(screen.getByTestId('directory-check-again')).toBeDisabled();
        await waitFor(() => expect(screen.getByTestId('directory-check-again')).toBeEnabled(), { timeout: 3000 });
      }
      await ready();
      // The key still decides it: the sealed 201 of the first send.
      await click('directory-check-again');
      await screen.findByTestId('directory-saved');
      expect(new Set(posts(server).map((r) => `${r.headers.get('idempotency-key')} ${r.body}`)).size).toBe(1);
      expect(server.rows[TENANT_A].filter((r) => r.name === 'Ada Lovelace')).toHaveLength(1);
      cleanup();
    }
  });

  it('SCD-26. unresolved, then the account\'s grant moves: "Check again" sends NOTHING under the new connection and the attempt is detached for good', async () => {
    const server = fakeServer();
    server.seed(TENANT_B, ['Bea']);
    server.posts.push('lost-before'); // it never reached the server: the key is absent, so another tenant would accept it
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    server.moveGrant('tok-a', TENANT_B);
    // The move ended the session: "Check again" finds it ended and sends nothing — no login, no POST (M7A-CUSTOMERS-P6).
    await click('directory-check-again');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(hold()).toHaveAttribute('data-detached', 'false');
    expect(logins(server)).toHaveLength(1);
    expect(posts(server)).toHaveLength(1);
    await click('directory-retry'); // Reconnect: the new session is the other store's
    await waitFor(() => expect(hold()).toHaveAttribute('data-detached', 'true'));
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(posts(server)).toHaveLength(1); // NO POST under the new session
    expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']); // and no row in the other tenant
    expect(server.rows[TENANT_A]).toEqual([]);
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(screen.getByTestId('directory-hold-detached')).toHaveTextContent('It was sent under an earlier connection and cannot be checked from here.');
    expect(screen.getByTestId('directory-hold-detached')).toHaveTextContent('a row with the same name is not proof');
    expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT);
    expect(names()).toEqual(['Bea']); // the rows of the store that answers now
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), csrf: null, state: 'unresolved' }); // its token is dropped
    expect(page()).not.toMatch(/not saved/i);
    expect(addButton()).toBeDisabled(); // still tracked: adding the same name again could make a second customer
    // Going back to a session of the first store does not re-attach it: detached for good.
    server.moveGrant('tok-a', TENANT_A);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('signed-out')); // ended again: Refresh signs nothing in
    expect(logins(server)).toHaveLength(2);
    await click('directory-retry');
    await ready();
    expect(logins(server)).toHaveLength(3);
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    await focusWindow();
    await settle();
    expect(posts(server)).toHaveLength(1);
    // "Stop tracking" is the way on: the next add is a new request under a new key.
    await click('directory-stop-tracking');
    await ready();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
    expectNoSelector(server);
  });

  it('SCD-27. a session another tab replaced is noticed on focus: rows cleared and read again, the attempt detached, nothing sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    server.posts.push('commit-then-503');
    mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Cy');
    await unresolved();
    const first = server.csrfOfCookie();
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a'); // the cookie now names a session of another store; the old session still stands
    expect(server.csrfOfCookie()).not.toBe(first);
    const before = posts(server).length;
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await ready();
    expect(names()).toEqual(['Bea']);
    expect(page()).not.toContain('Ada');
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(posts(server)).toHaveLength(before);
    expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']);
    // A hidden tab does not connect at all.
    const sent = server.sent.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(server.sent).toHaveLength(sent);
  });

  it('SCD-28. the session changes while the list read is out: the old read is cancelled and its late answer shows nothing', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Alan']);
    server.seed(TENANT_B, ['Bea']);
    mount(server);
    await ready();
    server.hold.reads = 1;
    await click('directory-refresh'); // store A's rows, decided on arrival, answer held
    await waitFor(() => expect(server.held).toHaveLength(1));
    const old = lists(server)[lists(server).length - 1];
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a');
    await focusWindow();
    await waitFor(() => expect(names()).toEqual(['Bea']));
    expect(old.signal?.aborted).toBe(true);
    server.held[0].release(); // the old store's page arrives now
    await settle();
    expect(names()).toEqual(['Bea']);
    expect(phase()).toBe('ready');
    expect(page()).not.toContain('Ada');
    expect(screen.getByTestId('directory-refresh')).toBeEnabled(); // no read flag was left set
    expect(addButton()).toBeEnabled();
  });

  it('SCD-29. a newer list read supersedes an older one in the same connection: the late page is not appended', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    server.hold.reads = 1;
    await click('directory-load-more');
    await waitFor(() => expect(server.held).toHaveLength(1));
    const more = lists(server)[1];
    await addCustomer('Ada Lovelace'); // confirmed: page one is read again while "Load more" is still out
    await screen.findByTestId('directory-saved');
    await waitFor(() => expect(names()[0]).toBe('Ada Lovelace'));
    expect(more.signal?.aborted).toBe(true);
    expect(names()).toHaveLength(50);
    server.held[0].release(); // the superseded second page arrives
    await settle();
    expect(names()).toHaveLength(50);
    expect(names()[0]).toBe('Ada Lovelace');
    expect(screen.getByTestId('directory-load-more')).toBeEnabled();
  });

  it('SCD-30. the session changes while a detail read is out: the old answer is never shown under the new connection', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    const view = mount(server);
    await ready();
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a');
    await focusWindow();
    // The new connection reads the same address: in the other store this id is not available.
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found'));
    server.held[0].release(); // store A's 200 for Ada arrives
    await settle();
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'not-found');
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(page()).not.toContain('Ada');
    expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument();
  });

  it('SCD-31. Add under a connection that has changed sends NOTHING: a note, the draft kept, and a create only after a new click', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.users['tok-a'].tenant = TENANT_B;
    server.otherTab('tok-a'); // unnoticed so far: the page still shows store A
    expect(names()).toEqual(['Ada']);
    await addCustomer('Cy');
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await ready();
    await settle();
    expect(posts(server)).toHaveLength(0); // nothing was sent, under either token
    expect(view.made).toEqual([]);
    expect(view.holds.get('uid-a')).toBeUndefined();
    expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']);
    expect(names()).toEqual(['Bea']); // the list to check first
    expect(nameInput().value).toBe('Cy');
    expect(addButton()).toBeEnabled();
    // A deliberate second click creates it in the store the page now shows.
    await click('directory-add');
    await screen.findByTestId('directory-saved');
    expect(posts(server)).toHaveLength(1);
    expect(posts(server)[0].headers.get('x-tmpos-session-csrf')).toBe(server.csrfOfCookie());
    expect(server.rows[TENANT_B].map((r) => r.name).sort()).toEqual(['Bea', 'Cy']);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Ada']);
    expect(screen.queryByTestId('directory-connection-changed')).toBeNull();
  });

  it('SCD-32. the connection changes while a create is out: its late 201 is a plain notice with no link, and a late undecided answer stays detached', async () => {
    for (const late of ['201', '503'] as const) {
      const server = fakeServer();
      server.seed(TENANT_B, ['Bea']);
      if (late === '503') server.posts.push('commit-then-503');
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace'); // executed by store A on arrival; the answer is held
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.users['tok-a'].tenant = TENANT_B;
      server.otherTab('tok-a');
      await focusWindow(); // a focus connect never runs while a create is out
      await settle();
      expect(screen.queryByTestId('directory-connection-changed')).toBeNull();
      await click('directory-refresh'); // a read notices the new connection
      await waitFor(() => expect(names()).toEqual(['Bea']));
      expect(hold()).toHaveAttribute('data-state', 'sending');
      expect(hold()).toHaveAttribute('data-detached', 'true');
      server.held[0].release();
      if (late === '201') {
        await waitFor(() => expect(screen.getByTestId('directory-saved-earlier')).toHaveTextContent(savedEarlierText('Ada Lovelace')));
        expect(screen.queryByTestId('directory-saved')).toBeNull();
        expect(screen.queryByTestId('directory-saved-link')).toBeNull(); // no address of another store's customer
        expect(screen.queryByTestId('directory-hold')).toBeNull();
        expect(view.holds.get('uid-a')).toBeUndefined(); // the late answer was reconciled by key, not dropped
      } else {
        await unresolved();
        expect(hold()).toHaveAttribute('data-detached', 'true');
        expect(screen.queryByTestId('directory-check-again')).toBeNull();
        expect(page()).not.toMatch(/not saved/i);
      }
      await settle();
      expect(names()).toEqual(['Bea']); // the late answer moved nothing in the new store's list
      expect(page()).not.toContain('"Ada Lovelace". View');
      expect(posts(server)).toHaveLength(1);
      expect(server.rows[TENANT_B].map((r) => r.name)).toEqual(['Bea']);
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('SCD-33. an attempt older than 23 hours cannot be checked: no button, no request', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    let t = 1_000;
    mount(server, { keys: [key(1)], now: () => t });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    t += CHECK_CUTOFF_MS - 1;
    await click('directory-refresh');
    await ready();
    expect(screen.getByTestId('directory-check-again')).toBeEnabled(); // one millisecond inside the cutoff
    t += 1;
    // The clock passes the cutoff with the button still on screen: a click sends nothing and the card says why.
    await click('directory-check-again');
    await waitFor(() => expect(screen.queryByTestId('directory-check-again')).toBeNull());
    expect(screen.getByTestId('directory-hold-detached')).toHaveTextContent('It was sent too long ago and cannot be checked from here.');
    expect(hold()).toHaveAttribute('data-detached', 'false'); // too old, not detached
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    await settle();
    expect(posts(server)).toHaveLength(1);
    expect(page()).not.toMatch(/not saved/i);
    expect(screen.getByTestId('directory-stop-tracking')).toBeEnabled();
  });

  it('SCD-34. "Stop tracking" warns first, forgets the attempt, reads page one, and the next add is a new key', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    const stop = screen.getByTestId('directory-stop-tracking');
    expect(document.getElementById(stop.getAttribute('aria-describedby')!)).toHaveTextContent(STOP_WARNING_TEXT);
    expect(STOP_WARNING_TEXT).toMatch(/does not cancel the request/);
    expect(STOP_WARNING_TEXT).toMatch(/can create a second customer/);
    const before = lists(server).length;
    await click('directory-stop-tracking');
    await waitFor(() => expect(screen.queryByTestId('directory-hold')).toBeNull());
    expect(view.holds.get('uid-a')).toBeUndefined();
    await waitFor(() => expect(lists(server)).toHaveLength(before + 1));
    await waitFor(() => expect(names()).toEqual(['Ada Lovelace'])); // it had committed: the directory shows it
    expect(posts(server)).toHaveLength(1); // stopping sent nothing
    await waitFor(() => expect(addButton()).toBeEnabled());
    await click('directory-add'); // the same name again, deliberately: a second customer under a new key
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([key(1), key(2)]);
    expect(server.rows[TENANT_A]).toHaveLength(2);
  });

  it('SCD-35. an unresolved attempt survives leaving the page and coming back, and can still be checked with its own key and bytes', async () => {
    const server = fakeServer();
    server.posts.push('lost-after-commit');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await view.go('/elsewhere');
    expect(screen.queryByTestId('customer-directory')).toBeNull();
    await settle();
    expect(posts(server)).toHaveLength(1); // nothing is sent because the page went away
    await view.go('/customers/directory');
    await ready();
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(hold()).toHaveAttribute('data-detached', 'false'); // the same session answers: the same token
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    expect(nameInput().value).toBe(''); // only the attempt is kept, not the draft
    expect(addButton()).toBeDisabled();
    await settle();
    expect(posts(server)).toHaveLength(1); // a remount sends nothing either
    await click('directory-check-again');
    await screen.findByTestId('directory-saved');
    expect(posts(server).map((r) => `${r.headers.get('idempotency-key')} ${r.body}`)).toEqual([`${key(1)} {"name":"Ada Lovelace"}`, `${key(1)} {"name":"Ada Lovelace"}`]);
    expect(server.rows[TENANT_A]).toHaveLength(1);
  });

  it('SCD-36. an answer that arrives after the page has gone settles the attempt in the store only: nothing is read or sent by the old page', async () => {
    for (const late of ['201', '503'] as const) {
      const server = fakeServer();
      if (late === '503') server.posts.push('commit-then-503');
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere'); // the create is not cancelled by leaving
      expect(posts(server)[0].signal?.aborted ?? false).toBe(false);
      expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'sending' });
      const sent = server.sent.length;
      server.held[0].release();
      await settle();
      expect(server.sent).toHaveLength(sent); // the page that left reads nothing and sends nothing
      if (late === '201') expect(view.holds.get('uid-a')).toBeUndefined(); // confirmed: not dropped
      else expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'unresolved' });
      await view.go('/customers/directory');
      await ready();
      if (late === '201') {
        expect(screen.queryByTestId('directory-hold')).toBeNull();
        expect(names()).toEqual(['Ada Lovelace']);
        expect(addButton()).toBeEnabled();
      } else {
        expect(hold()).toHaveAttribute('data-state', 'unresolved');
        expect(screen.getByTestId('directory-check-again')).toBeEnabled();
      }
      expect(posts(server)).toHaveLength(1);
      cleanup();
    }
  });

  it('SCD-37. one user\'s attempt is never shown to another, and comes back with its own user', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.seed(TENANT_B, ['Bea']);
    server.posts.push('commit-then-503');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Cy');
    await unresolved();
    act(() => access.set({ uid: 'uid-b' }));
    // The first render after the switch already shows nothing of the previous user.
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(names()).toEqual([]);
    expect(nameInput().value).toBe('');
    await waitFor(() => expect(names()).toEqual(['Bea']));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(page()).not.toContain('Cy');
    expect(addButton()).toBeEnabled(); // user B is not blocked by user A's attempt
    expect(view.holds.get('uid-b')).toBeUndefined();
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), state: 'unresolved' });
    act(() => access.set({ uid: 'uid-a' }));
    await waitFor(() => expect(names()).toEqual(['Ada', 'Cy']));
    expect(hold()).toHaveTextContent(unresolvedText('Cy'));
    // Signed in again, user A has another session: the attempt is detached and cannot be re-sent from here.
    expect(hold()).toHaveAttribute('data-detached', 'true');
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-38. nobody signed in: the sign-in-needed state and no request at all', async () => {
    const server = fakeServer();
    access.set({ uid: null });
    mount(server);
    await settle();
    expect(phase()).toBe('signed-out');
    expect(state()).toHaveTextContent('Sign in with your store account');
    expect(screen.queryByTestId('directory-retry')).toBeNull();
    expect(screen.queryByTestId('directory-refresh')).toBeNull();
    expect(addButton()).toBeDisabled();
    expect(server.sent).toHaveLength(0);
    // A signed-in user this browser holds no identity for: the same state, nothing sent, and a way to try again.
    cleanup();
    access.set({ uid: 'uid-a' });
    const none = fakeServer();
    mount(none, { tokens: {} });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    // Only the session read (none held: 401) leaves; no login is sent without the user's own ID token (P5-R1).
    expect(none.sent.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(screen.getByTestId('directory-retry')).toHaveTextContent('Reconnect');
  });

  it('SCD-39. a rate-limited sign-in shows the server\'s delay when it names one, and a minute when it does not', async () => {
    const server = fakeServer();
    server.retryAfter = '2';
    server.logins.push(429);
    mount(server);
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Too many requests. Wait 2 seconds, then try again.');
    expect(screen.getByTestId('directory-retry')).toBeDisabled();
    expect(lists(server)).toHaveLength(0);
    cleanup();
    const silent = fakeServer();
    silent.retryAfter = null;
    silent.logins.push(429);
    mount(silent);
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(state()).toHaveTextContent('Wait 60 seconds');
    // The session read before a create is limited: nothing is sent, the draft stays.
    cleanup();
    const busy = fakeServer();
    mount(busy);
    await ready();
    busy.checks.push(429);
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(createStatus()).toHaveTextContent('Not sent. Too many requests. Wait 1 second, then try again.');
    expect(posts(busy)).toHaveLength(0);
    expect(nameInput().value).toBe('Ada Lovelace');
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('directory-retry')).toBeEnabled(), { timeout: 3000 });
    await click('directory-retry');
    await ready();
    await waitFor(() => expect(addButton()).toBeEnabled());
  });

  it('SCD-40. the permission is narrowed while the page is open: the create is refused with no customer, then None is the denied state', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bob']);
    mount(server, { keys: [key(1), key(2)] });
    await ready();
    server.users['tok-a'].create = false; // narrowed to View on the server; the page's hint still says it may add
    expect(addButton()).toBeEnabled();
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(createStatus()).toHaveTextContent(/^Refused by the server\./));
    expect(page()).not.toMatch(/Saved on the server:/);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Bob']);
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(nameInput().value).toBe('Ada Lovelace');
    await ready();
    expect(names()).toEqual(['Bob']); // the list is not hidden: viewing is still allowed
    expect(lists(server)).toHaveLength(2);
    // The local hint follows: no form, only a note — the server was the one that decided.
    act(() => access.set({ canCreate: false }));
    expect(screen.queryByTestId('directory-add')).toBeNull();
    expect(screen.queryByTestId('directory-name')).toBeNull();
    expect(screen.getByTestId('directory-create-unavailable')).toHaveTextContent('does not include adding customers');
    server.users['tok-a'].view = false; // narrowed to None
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(names()).toEqual([]);
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-41. the unresolved card is shown even when the local hint no longer offers the form', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    act(() => access.set({ canCreate: false }));
    expect(screen.queryByTestId('directory-add')).toBeNull();
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    await click('directory-check-again');
    await screen.findByTestId('directory-saved');
    expect(posts(server)).toHaveLength(2);
    expect(server.rows[TENANT_A]).toHaveLength(1);
  });

  it('SCD-42. focus connects read only: no list read and no create, and overlapping focus events share the session client\'s one in-flight read', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    const before = server.sent.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(screen.queryByTestId('directory-connection-changed')).toBeNull(); // the same token: nothing changes
    expect(names()).toEqual(['Ada']);
    // A later focus sends its own read once the first is judged. That takes a Web Crypto digest whose time varies with
    // load, and a focus before then shares the first read, so focus until one is sent rather than guess the turns.
    for (let i = 0; i < 50 && server.sent.length - before < 2; i++) {
      await focusWindow();
      await settle();
    }
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`, `GET ${TENANT_SESSION_PATHS.current}`]);
  });

  it('SCD-45. a page that mounts while a create is still out does not connect on focus until that create has answered', async () => {
    const server = fakeServer();
    server.posts.push('commit-then-503');
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await view.go('/customers/directory'); // a new page instance; the earlier one's create is still out
    await ready();
    expect(hold()).toHaveAttribute('data-state', 'sending');
    expect(addButton()).toBeDisabled();
    const before = server.sent.length;
    await focusWindow();
    await settle();
    expect(server.sent).toHaveLength(before); // no connect while a create is out
    server.held[0].release();
    await unresolved();
    await focusWindow();
    await settle();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]); // answered: reads only
    expect(posts(server)).toHaveLength(1);
  });

  it('SCD-46. a create that settles after its page has gone is shown by the page that is mounted (or mounts) meanwhile: never silently dropped (R1, T2)', async () => {
    // A 201 that settles while a NEW page instance is mounted: the notice, and page one is read again.
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      expect(hold()).toHaveAttribute('data-state', 'sending');
      const reads = lists(server).length;
      server.held[0].release();
      const notice = await screen.findByTestId('directory-saved');
      expect(notice).toHaveTextContent('Saved on the server: "Ada Lovelace".');
      expect(screen.getByTestId('directory-saved-link')).toBeInTheDocument();
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
      // The row was already on page one (the fake commits before it holds the answer), so wait for the re-read itself:
      // it follows the page's session check.
      await waitFor(() => expect(lists(server)).toHaveLength(reads + 1)); // page one was read again, once
      expect(screen.queryByTestId('directory-hold')).toBeNull();
      expect(posts(server)).toHaveLength(1);
      cleanup();
    }
    // A conclusive refusal that settles the same way shows its text, naming the customer, and never "saved".
    {
      const server = fakeServer();
      server.posts.push(403);
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      server.held[0].release();
      await waitFor(() => expect(createStatus()).toHaveTextContent('"Ada Lovelace" was not added: the server refused that request.'));
      expect(createStatus()).toHaveAttribute('role', 'alert');
      expect(screen.queryByTestId('directory-saved')).toBeNull();
      expect(page()).not.toMatch(/Saved on the server: /i);
      expect(screen.queryByTestId('directory-hold')).toBeNull();
      cleanup();
    }
    // Settled while NO page was mounted: the next page to hold a session token shows it, once.
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      server.held[0].release();
      await settle();
      expect(view.holds.get('uid-a')).toBeUndefined();
      await view.go('/customers/directory');
      expect(await screen.findByTestId('directory-saved')).toHaveTextContent('"Ada Lovelace"');
      await ready();
      expect(names()).toEqual(['Ada Lovelace']);
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      expect(screen.queryByTestId('directory-saved')).toBeNull(); // shown once, then forgotten
      cleanup();
    }
    // Sent under another connection than the one the page now holds: the "earlier connection" notice, and a read.
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      server.otherTab('tok-a'); // a new session of the same store; the old one still stands
      server.held[0].release();
      await settle();
      await view.go('/customers/directory');
      expect(await screen.findByTestId('directory-saved-earlier')).toHaveTextContent(savedEarlierText('Ada Lovelace'));
      expect(screen.queryByTestId('directory-saved-link')).toBeNull();
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
    }
  });

  it('SCD-47. a confirmation from an earlier connection names the customer, reads page one again, and clears the draft only when it still is that name (R2)', async () => {
    for (const typed of ['Zed', null] as const) {
      const server = fakeServer();
      server.seed(TENANT_B, ['Bea']);
      mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.users['tok-a'].tenant = TENANT_B;
      server.otherTab('tok-a');
      await click('directory-refresh'); // a read notices the new connection
      await waitFor(() => expect(names()).toEqual(['Bea']));
      if (typed !== null) await typeName(typed);
      const reads = lists(server).length;
      server.held[0].release();
      await waitFor(() => expect(screen.getByTestId('directory-saved-earlier')).toHaveTextContent('"Ada Lovelace" was saved on the server under the earlier connection.'));
      await waitFor(() => expect(lists(server)).toHaveLength(reads + 1)); // page one is read again
      expect(nameInput().value).toBe(typed ?? ''); // another name typed meanwhile stays; the confirmed one is cleared
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('SCD-48. a 403 or 401 clears BOTH the list and the detail, whichever read got it (R3, T1)', async () => {
    for (const refusal of [403, 401] as const) {
      const denied = refusal === 403;
      const wanted = denied ? 'denied' : 'signed-out';
      const detailServer = fakeServer();
      const [bea] = detailServer.seed(TENANT_A, ['Bea', 'Cy']);
      const direct = mount(detailServer);
      await ready();
      await direct.go(`/customers/directory/${bea.id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
      await direct.go('/customers/directory');
      await ready();
      if (denied) detailServer.users['tok-a'].view = false; else detailServer.reads.push(401);
      await direct.go(`/customers/directory/${bea.id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', wanted));
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
      await click('directory-back');
      expect(phase()).toBe(wanted);
      expect(names()).toEqual([]);
      expect(screen.queryByTestId('directory-list')).toBeNull();
      expect(screen.queryByTestId('directory-load-more')).toBeNull();
      expect(addButton()).toBeDisabled();
      cleanup();
      // A list read answered 403 / 401 while a detail is shown: the detail shows nothing of the customer.
      const both = fakeServer();
      const [dee] = both.seed(TENANT_A, ['Dee']);
      both.posts.push('rollback-503');
      const page2 = mount(both, { keys: [key(1)] });
      await ready();
      await addCustomer('Ed');
      await unresolved();
      await page2.go(`/customers/directory/${dee.id}`);
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
      expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Dee');
      if (denied) both.users['tok-a'].view = false; else both.reads.push(401);
      await click('directory-stop-tracking'); // reads page one again, which is refused
      await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', wanted));
      expect(screen.queryByTestId('directory-detail-name')).toBeNull();
      expect(page()).not.toContain('Dee');
      cleanup();
    }
  });

  it('SCD-49. "Load more" answered 403, 401 or 429 (T3)', async () => {
    const seeded = (): Server => {
      const server = fakeServer();
      server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
      return server;
    };
    const denied = seeded();
    mount(denied);
    await ready();
    denied.users['tok-a'].view = false;
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('denied'));
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    cleanup();
    const out = seeded();
    mount(out);
    await ready();
    out.reads.push(401);
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-load-more')).toBeNull();
    await click('directory-retry'); // Reconnect reads page one
    await ready();
    expect(names()).toHaveLength(50);
    expect(lists(out).at(-1)?.url).toBe(CUSTOMERS_PATH);
    cleanup();
    const limitedServer = seeded();
    mount(limitedServer);
    await ready();
    limitedServer.reads.push(429);
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    expect(names()).toHaveLength(50); // the rows stay, under the last-known label
    expect(screen.getByTestId('directory-last-known')).toBeInTheDocument();
    expect(screen.getByTestId('directory-retry')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('directory-retry')).toBeEnabled(), { timeout: 3000 });
  });

  it('SCD-50. a focus check that finds the session definitely gone clears the page; one the server cannot answer changes nothing (R4, T4)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    for (const plan of [503, 429]) { // unavailable / rate-limited teach nothing
      server.checks.push(plan);
      await focusWindow();
      await settle();
      expect(phase()).toBe('ready');
      expect(names()).toEqual(['Ada']);
      expect(screen.queryByTestId('directory-connection-changed')).toBeNull();
    }
    // The session has ended: no rows any more, and the focus check signs nothing in (M7A-CUSTOMERS-P6) — the planned
    // refusal stays unused. Its Reconnect is what signs in: refused here, the same state.
    server.sessions.clear();
    server.logins.push(401);
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent('Your server session ended. Reconnect');
    expect(names()).toEqual([]);
    expect(addButton()).toBeDisabled();
    expect(logins(server)).toHaveLength(1);
    expect(server.logins).toEqual([401]);
    await click('directory-retry');
    await waitFor(() => expect(state()).toHaveTextContent('did not accept this sign-in'));
    expect(names()).toEqual([]);
    expect(logins(server)).toHaveLength(2);
    // With no identity to sign in with, the same: ended on focus (no ID token asked), and the Reconnect finds nobody.
    cleanup();
    const tokens: Record<string, string> = { 'uid-a': 'tok-a' };
    const other = fakeServer();
    other.seed(TENANT_A, ['Ada']);
    mount(other, { tokens });
    await ready();
    other.sessions.clear();
    delete tokens['uid-a'];
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent('Your server session ended. Reconnect');
    expect(names()).toEqual([]);
    await click('directory-retry');
    await waitFor(() => expect(state()).toHaveTextContent('Sign in with your store account'));
    expect(names()).toEqual([]);
    expect(logins(other)).toHaveLength(1); // the first load's only
  });

  it('SCD-51. a shorter Retry-After never shortens a running wait, and "Stop tracking" during a wait reads nothing (R6, T5)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.reads.push({ limited: '60' }, { limited: '1' }); // the list and the detail are read together on a direct address
    mount(server, { path: `/customers/directory/${ada.id}` });
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'rate-limited'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent('Wait 60 seconds'); // Z5: the wait that runs, not the answer's 1
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(screen.getByTestId('directory-detail-retry')).toBeDisabled(); // the 60-second wait still runs
    cleanup();
    // A check answered 429 starts a wait; stopping tracking meanwhile sends no read.
    const held = fakeServer();
    held.retryAfter = '30';
    held.posts.push('rollback-503', 429);
    mount(held, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await click('directory-check-again');
    await waitFor(() => expect(screen.getByTestId('directory-check-again')).toBeDisabled());
    const before = held.sent.length;
    await click('directory-stop-tracking');
    await settle();
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(held.sent).toHaveLength(before);
  });

  it('SCD-52. no read starts during a rate limit\'s wait: a detail opened then shows the wait and sends nothing (S3)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.retryAfter = '30';
    mount(server);
    await ready();
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    const before = server.sent.length;
    await userEvent.setup().click(screen.getByRole('link', { name: 'Ada' })); // the rows stay as last known
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'rate-limited'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent(/Too many requests\. Wait \d+ seconds?, then try again\./);
    expect(screen.getByTestId('directory-detail-retry')).toBeDisabled();
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    await settle();
    expect(server.sent).toHaveLength(before);
    expect(details(server)).toHaveLength(0);
    expect(ada.name).toBe('Ada');
  });

  it('SCD-53. the page\'s own store is the module-level one: an unresolved attempt survives leaving and coming back with no injected store (T6)', async () => {
    access.set({ uid: 'uid-default-store' });
    const server = fakeServer();
    server.users['tok-c'] = { uid: 'uid-default-store', tenant: TENANT_A, view: true, create: true };
    server.posts.push('lost-after-commit');
    const view = mount(server, { defaultHolds: true, tokens: { 'uid-default-store': 'tok-c' }, keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await view.go('/elsewhere');
    await view.go('/customers/directory');
    await ready();
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(hold()).toHaveTextContent(unresolvedText('Ada Lovelace'));
    await click('directory-stop-tracking'); // leave the module-level store clean for the other cases
    expect(screen.queryByTestId('directory-hold')).toBeNull();
  });

  it('SCD-54. React holds no session token: the hold snapshot is a token-free view (R5)', async () => {
    const server = fakeServer();
    server.posts.push('lost-after-commit');
    mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    const csrf = server.csrfOfCookie()!;
    expect(csrf).not.toBe('');
    type Fiber = { return: Fiber | null; child: Fiber | null; sibling: Fiber | null; type: unknown; memoizedState: { memoizedState: unknown; queue: { getSnapshot?: unknown } | null; next: unknown } | null };
    const root = screen.getByTestId('customer-directory');
    const fiberKey = Object.keys(root).find((k) => k.startsWith('__reactFiber$'))!;
    let top = (root as unknown as Record<string, Fiber>)[fiberKey];
    while (top.return !== null) top = top.return;
    const snapshots: string[] = [];
    const walk = (fiber: Fiber | null): void => {
      for (let f = fiber; f !== null; f = f.sibling) {
        if (typeof f.type === 'function') {
          for (let h = f.memoizedState; h !== null && h !== undefined; h = h.next as typeof h) {
            if (h.queue !== null && typeof h.queue === 'object' && typeof h.queue.getSnapshot === 'function') snapshots.push(JSON.stringify(h.memoizedState) ?? '');
          }
        }
        walk(f.child);
      }
    };
    walk(top);
    expect(snapshots.some((text) => text.includes(key(1)))).toBe(true); // the walk does see the attempt's snapshot
    for (const text of snapshots) expect(text).not.toContain(csrf);
  });

  it('SCD-55. the empty message and both last-known labels live inside the existing status paragraphs; a row link is a 24 px block target (A1, A2)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    expect(screen.getByRole('link', { name: 'Ada' }).className).toMatch(/\bblock\b/);
    expect(screen.getByRole('link', { name: 'Ada' }).className).toContain('min-h-[24px]');
    server.rows[TENANT_A].length = 0;
    await click('directory-refresh');
    await waitFor(() => expect(within(state()).getByTestId('directory-empty')).toHaveTextContent(EMPTY_TEXT));
    const [ada] = server.seed(TENANT_A, ['Ada']);
    await click('directory-refresh');
    await waitFor(() => expect(names()).toEqual(['Ada']));
    server.reads.push(503);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(within(state()).getByTestId('directory-last-known')).toHaveTextContent(LAST_KNOWN_TEXT);
    expect(screen.getAllByRole('status').filter((el) => el.contains(screen.getByTestId('directory-last-known')))).toHaveLength(1);
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    server.reads.push(503);
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'unavailable'));
    expect(within(screen.getByTestId('directory-detail-state')).getByTestId('directory-detail-last-known')).toHaveTextContent('Last known');
  });

  it('SCD-56. a page-one read blocked by a rate-limit wait runs once when the wait ends: after a confirmed create and after a first-send refusal (Z1)', async () => {
    for (const planned of ['ok', 403] as const) {
      const server = fakeServer();
      server.retryAfter = '2';
      if (planned === 403) server.posts.push(403);
      mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      server.reads.push(429);
      await click('directory-refresh'); // a wait starts while the create is out
      await waitFor(() => expect(phase()).toBe('rate-limited'));
      const before = lists(server).length;
      server.held[0].release();
      if (planned === 'ok') {
        await screen.findByTestId('directory-saved'); // the notice does not wait
        expect(names()).toEqual([]);
      } else {
        await waitFor(() => expect(createStatus()).toHaveTextContent('Refused by the server.'));
      }
      await settle();
      expect(lists(server)).toHaveLength(before); // nothing is read during the wait
      await waitFor(() => expect(phase()).toBe('ready'), { timeout: 4000 });
      expect(lists(server)).toHaveLength(before + 1); // ONE read when it ended, with no click
      if (planned === 'ok') expect(names()).toEqual(['Ada Lovelace']);
      expect(posts(server)).toHaveLength(1); // a read, never a create
      cleanup();
    }
  }, 15_000); // two real 2 s waits: above the 5 s default

  it('SCD-57. a refusal supersedes reads already in flight: a late 200 repaints neither the list nor the detail (Z2)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.hold.reads = 1;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.sessions.clear();
    server.logins.push(401);
    await focusWindow(); // the session is definitely gone: found ended, with no login (M7A-CUSTOMERS-P6)
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(logins(server)).toHaveLength(1);
    expect(server.logins).toEqual([401]); // unused
    server.held[0].release(); // the read answered 200 before the session ended
    await settle();
    expect(phase()).toBe('signed-out');
    expect(names()).toEqual([]);
    cleanup();
    const both = fakeServer();
    const [dee] = both.seed(TENANT_A, ['Dee']);
    both.posts.push('rollback-503');
    const view = mount(both, { keys: [key(1)] });
    await ready();
    await addCustomer('Ed');
    await unresolved();
    both.hold.reads = 1;
    await view.go(`/customers/directory/${dee.id}`);
    await waitFor(() => expect(both.held).toHaveLength(1)); // the detail read is out
    both.reads.push(403);
    await click('directory-stop-tracking'); // the list read that follows is refused
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied'));
    both.held[0].release();
    await settle();
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied');
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
  });

  it('SCD-58. a refused list does not stamp its refusal on a customer opened later (Z3)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    await ready();
    server.users['tok-a'].view = false;
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    server.users['tok-a'].view = true;
    const rendered: string[] = []; // every text a text node held before it was replaced
    const observer = new MutationObserver((records) => { for (const r of records) if (r.oldValue !== null) rendered.push(r.oldValue); });
    observer.observe(document.body, { subtree: true, characterData: true, characterDataOldValue: true });
    server.hold.reads = 1;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(server.held).toHaveLength(1));
    await flush();
    observer.disconnect();
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'loading');
    expect(rendered.join('|')).not.toContain('may not view');
    server.held[0].release();
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
  });

  it('SCD-59. an outcome shown from the store does not steal focus from the name field (Z4)', async () => {
    const server = fakeServer();
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('Ada Lovelace');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/elsewhere');
    await view.go('/customers/directory');
    await ready();
    act(() => { nameInput().focus(); });
    expect(document.activeElement).toBe(nameInput());
    server.held[0].release();
    await screen.findByTestId('directory-saved');
    await settle();
    expect(document.activeElement).toBe(nameInput());
  });

  it('SCD-60. a focus during a rate-limit wait sends no session check (Z6)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    server.retryAfter = '30';
    mount(server);
    await ready();
    server.reads.push(429);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('rate-limited'));
    const before = server.sent.length;
    await focusWindow();
    await settle();
    expect(server.sent).toHaveLength(before);
  });

  it('SCD-61. a first-send refusal that settles while a customer is open is visible there (Z9)', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    server.posts.push(403);
    const view = mount(server, { keys: [key(1)] });
    await ready();
    server.hold.posts = 1;
    await addCustomer('Bob');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    server.held[0].release();
    await waitFor(() => expect(createStatus()).toHaveTextContent('Refused by the server.'));
    expect(createStatus()).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada');
  });

  it('SCD-43. the directory writes nothing into local customer state, browser storage or the console, and holds no store of its own there', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const before = { local: window.localStorage.length, session: window.sessionStorage.length, cookie: document.cookie };
    const server = fakeServer();
    const [bob] = server.seed(TENANT_A, ['Bob']);
    server.posts.push('lost-after-commit');
    const view = mount(server);
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await click('directory-check-again');
    await screen.findByTestId('directory-saved');
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    server.reads.push(503);
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(before.local);
    expect(window.sessionStorage.length).toBe(before.session);
    expect(document.cookie).toBe(before.cookie);
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    // No name, id, key or token rides an address: the only query the page ever builds is the server's cursor.
    expect(view.router.state.location.search).toBe('');
    for (const r of server.sent) if (r.url.includes('?')) expect(r.url).toMatch(/^\/api\/v1\/customers\?cursor=[A-Za-z0-9_-]{23}$/);
    // The shipped modules reach none of those sinks, and never the local customer state.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['ServerCustomerDirectory.tsx', 'customersClient.ts']) {
      const source = readFileSync(resolve(here, file), 'utf8');
      expect(source).not.toMatch(/StoreLocalState|useStoreLocalState|localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
      expect(source).not.toMatch(/from\s+['"][^'"]*server\//); // nothing of the server's is bundled
    }
  });

  it('SCD-44. App.tsx routes the list and the detail as ONE guarded route, which the /customers/:id redirect does not swallow', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const app = readFileSync(resolve(here, '../App.tsx'), 'utf8');
    expect(app).toContain(`{ path: '/customers/directory/:id?', element: <AccessGuard feature="customers"><CustomerDirectoryPage /></AccessGuard> }`);
    expect(app.match(/CustomerDirectoryPage \/>/g)).toHaveLength(1);
    // The same two patterns in a router: the directory wins over the older redirect, with and without an id.
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    expect(screen.queryByTestId('local-customers')).toBeNull();
    const pageBefore = screen.getByTestId('customer-directory');
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('customer-directory')).toBe(pageBefore); // one mounted page for both
    await view.go('/customers/something-else');
    expect(screen.getByTestId('local-customers')).toBeInTheDocument(); // the old redirect still stands for every other id
  });

  // M7A-CUSTOMERS-P5-R1 (DA-138) — a read names the session the page checked; another session's cookie reads nothing.
  it('SCD-62. another user signs in in another tab between the session check and the list read: the read is refused, nothing of theirs is shown, and the page reconnects as its own user', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    server.seed(TENANT_B, ['Mallory', 'Trent']);
    mount(server);
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    const before = server.sent.length;
    server.swapOnRead = 'tok-b';
    await click('directory-refresh');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']); // A's rows, read again under A's new session
    expect(page()).not.toContain('Mallory');
    expect(page()).not.toContain('Trent');
    const after = server.sent.slice(before).map((r) => `${r.method} ${r.url}`);
    expect(after).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, // checked A, then the read arrived with B's cookie: 403
      `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`, // B's session is not A's: A signs in
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, // a new connection checks, then reads again
    ]);
    expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument();
    expectNoSelector(server);
  });

  it('SCD-63. the same for a customer opened by address: the detail read is refused, and only the page\'s own customer is shown', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const [mallory] = server.seed(TENANT_B, ['Mallory']);
    const view = mount(server);
    await ready();
    server.swapOnRead = 'tok-b';
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    expect(screen.getByTestId('directory-detail')).toHaveTextContent('Ada');
    expect(page()).not.toContain('Mallory');
    expect(details(server).every((r) => !r.url.endsWith(mallory.id))).toBe(true);
    expect(details(server).length).toBeGreaterThanOrEqual(2); // the refused read, then the new connection's
  });

  it('SCD-64. a 403 under the session the page holds is a real refusal: ONE session check, then the denied state, and no loop', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.users['tok-a'].view = false;
    const before = server.sent.length;
    await click('directory-refresh');
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1); // the first load's only
  });
  // M7A-CUSTOMERS-P5-R1 — the one session check after a 403: a check that cannot decide never keeps a refused read's data.
  const deniedThenCheck = async (server: Server, check: number): Promise<number> => {
    server.users['tok-a'].view = false;
    server.hold.reads = 1;
    const before = server.sent.length;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.checks.push(check); // the check sent AFTER the 403, not the one before the read
    await act(async () => { server.held[0].release(); });
    return before;
  };

  it('SCD-65. a list read refused 403 whose session check answers 503: the list is cleared, no login, no further read', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    const before = await deniedThenCheck(server, 503);
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(names()).toEqual([]);
    expect(screen.queryByTestId('directory-list')).toBeNull();
    expect(screen.queryByTestId('directory-last-known')).toBeNull();
    expect(page()).not.toContain('Ada');
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1); // the first load's only
  });

  it('SCD-66. the same with a 429 on the check: the list is cleared, the check\'s wait runs and is shown, no login', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    server.retryAfter = '2';
    mount(server);
    await ready();
    const before = await deniedThenCheck(server, 429);
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(names()).toEqual([]);
    expect(page()).not.toContain('Ada');
    expect(screen.getByTestId('directory-refresh')).toBeDisabled(); // the wait runs
    expect(document.getElementById('directory-busy-hint')).toHaveTextContent('Wait 2 seconds.');
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-67. a detail read refused 403 whose session check answers 503: the customer shown before is not shown', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready'));
    await view.go('/customers/directory');
    await ready();
    server.users['tok-a'].view = false;
    server.hold.reads = 1;
    const before = server.sent.length;
    await view.go(`/customers/directory/${ada.id}`); // the same id: its last answer would be the fallback
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.checks.push(503);
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied'));
    await settle();
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.queryByTestId('directory-detail-last-known')).toBeNull();
    expect(page()).not.toContain('Ada');
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}/${ada.id}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-68. "Load more" refused 403 under the session the page holds: denied after exactly one session check', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
    mount(server);
    await ready();
    server.users['tok-a'].view = false;
    const before = server.sent.length;
    await click('directory-load-more');
    await waitFor(() => expect(phase()).toBe('denied'));
    await settle();
    expect(names()).toEqual([]);
    const after = server.sent.slice(before).map((r) => `${r.method} ${r.url}`);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
    expect(after[1]).toMatch(/^GET \/api\/v1\/customers\?cursor=[A-Za-z0-9_-]{23}$/);
    expect(after[2]).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-69. a detail read refused 403 under the session the page holds: denied after exactly one session check', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    server.users['tok-a'].view = false;
    const before = server.sent.length;
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'denied'));
    await settle();
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(server.sent.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}/${ada.id}`, `GET ${TENANT_SESSION_PATHS.current}`,
    ]);
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-70. a reopened page with a new session client reuses the session the browser holds: one login overall', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    const starts: number[] = [];
    for (let open = 0; open < 3; open++) {
      starts.push(server.sent.length);
      mount(server); // a new session client each time, over the same browser cookie
      await ready();
      expect(names()).toEqual(['Ada', 'Bob']);
      cleanup();
    }
    for (const at of starts) expect(`${server.sent[at].method} ${server.sent[at].url}`).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
    expect(logins(server)).toHaveLength(1);
    expect(server.sent.slice(starts[1]).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${CUSTOMERS_PATH}`,
    ]);
  });

  it('SCD-71. a first session read answered 429 or 503 at mount signs nothing in and reads nothing', async () => {
    for (const [check, wanted] of [[429, 'rate-limited'], [503, 'unavailable']] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, ['Ada']);
      server.checks.push(check);
      mount(server);
      await waitFor(() => expect(phase()).toBe(wanted));
      await settle();
      expect(server.sent.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
      expect(logins(server)).toHaveLength(0);
      expect(names()).toEqual([]);
      cleanup();
    }
  });
  it('SCD-72. the session check after a 403 is a read sent AFTER it: a check already in flight with the old token does not answer for it', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada', 'Bob']);
    mount(server);
    await ready();
    const oldCsrf = server.csrfOfCookie();
    // The Refresh's list read is parked; meanwhile a focus reconnect sends a session read, answered (and parked) with the old token.
    server.hold.reads = 1;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(2));
    const [listRead, inFlight] = server.held;
    expect(inFlight.url).toBe(TENANT_SESSION_PATHS.current);
    // Another tab replaces the cookie with a new session of the same user; the parked list read then arrives refused.
    server.otherTab('tok-a');
    const newCsrf = server.csrfOfCookie();
    expect(newCsrf).not.toBe(oldCsrf);
    const sessionReads = () => server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.current).length;
    const readsBefore = sessionReads();
    await act(async () => { listRead.release(new Response(JSON.stringify({ error: 'forbidden', requestId: 'req-synthetic' }), { status: 403, headers: { 'content-type': 'application/json' } })); });
    await settle();
    expect(sessionReads()).toBe(readsBefore); // the check waits for the read already out; it does not join its answer
    await act(async () => { inFlight.release(); }); // the old token
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toBeInTheDocument());
    await ready();
    expect(sessionReads()).toBeGreaterThan(readsBefore); // a session read sent after the 403
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(lists(server).at(-1)?.headers.get('x-tmpos-session-csrf')).toBe(newCsrf); // the new session's answer is the one acted on
    expect(logins(server)).toHaveLength(1);
  });

  // M7A-CUSTOMERS-P6 — a session this page confirmed that the server then ends (expiry, revocation, a logout elsewhere) is
  // never re-established on its own: everything the page does by itself finds it ended and signs nothing in; only a
  // Reconnect click logs in, once. `server.sessions.clear()` is the real end (a customer read's 401 alone keeps the session).
  const ENDED = 'Your server session ended. Reconnect to see the customers saved on the server.';
  const tabReturn = async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  it('SCD-73. a confirmed session that ends: Refresh, Load more, a focus, a tab return and Add each find it ended — NO login, nothing of the server\'s shown, Reconnect offered — and only Reconnect logs in, once', async () => {
    for (const trigger of ['refresh', 'more', 'focus', 'visibility', 'add'] as const) {
      const server = fakeServer();
      server.seed(TENANT_A, Array.from({ length: 60 }, (_, i) => `Customer ${String(i).padStart(2, '0')}`));
      mount(server);
      await ready();
      expect(names()).toHaveLength(50);
      expect(logins(server)).toHaveLength(1);
      if (trigger === 'add') await typeName('Ada Lovelace');
      server.sessions.clear(); // expired or revoked in the store; the browser still presents its cookie
      const before = lists(server).length;
      if (trigger === 'refresh') await click('directory-refresh');
      if (trigger === 'more') await click('directory-load-more');
      if (trigger === 'focus') await focusWindow();
      if (trigger === 'visibility') await tabReturn();
      if (trigger === 'add') await click('directory-add');
      await waitFor(() => expect(phase(), trigger).toBe('signed-out'));
      expect(state(), trigger).toHaveTextContent(ENDED);
      expect(names(), trigger).toEqual([]); // rows and cursor cleared
      expect(screen.queryByTestId('directory-load-more'), trigger).toBeNull();
      expect(screen.queryByTestId('directory-last-known'), trigger).toBeNull();
      expect(screen.getByTestId('directory-retry'), trigger).toHaveTextContent('Reconnect');
      expect(addButton(), trigger).toBeDisabled();
      expect(lists(server), trigger).toHaveLength(before); // nothing read without a session
      if (trigger === 'add') {
        expect(createStatus()).toHaveTextContent(`Not sent. ${ENDED}`);
        expect(nameInput()).toHaveValue('Ada Lovelace'); // the draft kept
      }
      // Nothing else that runs on its own signs in either.
      await focusWindow();
      await tabReturn();
      await settle();
      expect(phase(), trigger).toBe('signed-out');
      expect(logins(server), trigger).toHaveLength(1);
      expect(posts(server), trigger).toHaveLength(0);
      // Reconnect: exactly one login, and the rows are back.
      await click('directory-retry');
      await ready();
      expect(logins(server), trigger).toHaveLength(2);
      expect(names(), trigger).toHaveLength(50);
      expect(posts(server), trigger).toHaveLength(0);
      cleanup();
    }
  });

  it('SCD-74. a customer opened after the session ended sends NO login and shows nothing of it, through route changes and a focus; its Reconnect logs in once and shows it', async () => {
    const server = fakeServer();
    const [ada, bob] = server.seed(TENANT_A, ['Ada', 'Bob']);
    const view = mount(server);
    await ready();
    server.sessions.clear(); // not yet noticed by the page
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    expect(screen.getByTestId('directory-detail-state')).toHaveTextContent(ENDED);
    expect(screen.queryByTestId('directory-detail-name')).toBeNull();
    expect(screen.getByTestId('directory-detail-retry')).toHaveTextContent('Reconnect');
    await view.go('/customers/directory'); // back to the list: cleared by the same refusal
    expect(phase()).toBe('signed-out');
    expect(names()).toEqual([]);
    await view.go(`/customers/directory/${bob.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    await focusWindow();
    await settle();
    expect(logins(server)).toHaveLength(1);
    expect(details(server)).toHaveLength(0);
    await click('directory-detail-retry');
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Bob'));
    expect(logins(server)).toHaveLength(2);
    await view.go('/customers/directory');
    await ready();
    expect(names()).toEqual(['Ada', 'Bob']);
    expect(logins(server)).toHaveLength(2);
  });

  it('SCD-75. an uncertain create, then the session ends: "Check again" and "Stop tracking" send NO login and NO POST; Reconnect logs in once and detaches the attempt — never re-sent', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Bea']);
    server.posts.push('lost-before');
    const view = mount(server, { keys: [key(1), key(2)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    server.sessions.clear();
    await click('directory-check-again');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(ENDED);
    expect(hold()).toHaveAttribute('data-state', 'unresolved');
    expect(hold()).toHaveAttribute('data-detached', 'false');
    expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent(`Not checked. ${ENDED}`);
    expect(names()).toEqual([]);
    expect(logins(server)).toHaveLength(1);
    expect(posts(server)).toHaveLength(1);
    await click('directory-retry'); // Reconnect
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(hold()).toHaveAttribute('data-detached', 'true'); // the new connection is not the attempt's: detached for good
    expect(screen.queryByTestId('directory-check-again')).toBeNull();
    expect(view.holds.get('uid-a')).toMatchObject({ key: key(1), csrf: null, state: 'unresolved' });
    expect(posts(server)).toHaveLength(1);
    // It ends again: "Stop tracking" forgets the attempt, and the page-one read it starts signs nothing in.
    server.sessions.clear();
    await click('directory-stop-tracking');
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(screen.queryByTestId('directory-hold')).toBeNull();
    expect(logins(server)).toHaveLength(2);
    await click('directory-retry');
    await ready();
    expect(names()).toEqual(['Bea']);
    expect(logins(server)).toHaveLength(3);
    expect(posts(server)).toHaveLength(1);
    expect(server.rows[TENANT_A].map((r) => r.name)).toEqual(['Bea']);
  });

  it('SCD-76. a read refused 403 whose session check finds the session ended: no login, the ended state, nothing shown', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.reads.push(403);
    server.hold.reads = 1;
    await click('directory-refresh');
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.sessions.clear(); // the session ends while the refused read is on its way back
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(state()).toHaveTextContent(ENDED);
    expect(names()).toEqual([]);
    await settle();
    expect(logins(server)).toHaveLength(1);
  });

  it('SCD-77. after the session ended, a valid session of the same user (another tab signed in) is reused on focus: no login, the rows read under it', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(logins(server)).toHaveLength(1);
    server.otherTab('tok-a');
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('directory-connection-changed')).toHaveTextContent(CONNECTION_CHANGED_TEXT));
    await ready();
    expect(names()).toEqual(['Ada']);
    expect(logins(server)).toHaveLength(1);
    expect(lists(server).at(-1)?.headers.get('x-tmpos-session-csrf')).toBe(server.csrfOfCookie());
  });

  it('SCD-78. the stated residual: a page opened afresh while the cookie names an ended session signs in once, as a first load (the 401 does not say "expired", and nothing is stored to tell)', async () => {
    const server = fakeServer();
    server.seed(TENANT_A, ['Ada']);
    mount(server);
    await ready();
    cleanup();
    server.sessions.clear();
    mount(server); // a reload: a new session client that has confirmed nothing yet
    await ready();
    expect(logins(server)).toHaveLength(2);
    expect(names()).toEqual(['Ada']);
  });

  it('SCD-79. an automatic session check that answers `ended` while a Reconnect waits on it never cancels that Reconnect: the list, then a customer, each come back with exactly one more login', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(phase()).toBe('signed-out'));
    // A focus check is out when Reconnect is pressed; the check answers `ended` first, then the Reconnect logs in.
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-retry');
    await act(async () => { server.held[0].release(); });
    await ready();
    expect(names()).toEqual(['Ada']);
    expect(logins(server)).toHaveLength(2);
    // The same for a customer opened after the session ended again: a tab return is out when its Reconnect is pressed.
    server.held.length = 0;
    server.sessions.clear();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    server.hold.checks = 1;
    await tabReturn();
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-detail-retry');
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada'));
    await settle();
    expect(logins(server)).toHaveLength(3);
    expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'ready');
  });

  it('SCD-80. a saved notice does not outlive the session: once a focus finds it ended, neither "Saved on the server" nor the earlier-connection notice stays', async () => {
    {
      const server = fakeServer();
      server.seed(TENANT_A, ['Bea']);
      mount(server, { keys: [key(1)] });
      await ready();
      await addCustomer('Ada Lovelace'); // a validated 201
      await waitFor(() => expect(screen.getByTestId('directory-saved')).toHaveTextContent('Saved on the server: "Ada Lovelace".'));
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace', 'Bea']));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(screen.queryByTestId('directory-saved')).toBeNull();
      expect(screen.queryByTestId('directory-saved-link')).toBeNull();
      expect(names()).toEqual([]);
      expect(logins(server)).toHaveLength(1);
      cleanup();
    }
    {
      const server = fakeServer();
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      server.otherTab('tok-a');
      server.held[0].release();
      await settle();
      await view.go('/customers/directory');
      expect(await screen.findByTestId('directory-saved-earlier')).toHaveTextContent(savedEarlierText('Ada Lovelace'));
      await waitFor(() => expect(names()).toEqual(['Ada Lovelace']));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(screen.queryByTestId('directory-saved-earlier')).toBeNull();
      expect(logins(server)).toHaveLength(1);
      cleanup();
    }
    // A settled refusal names the customer too: it does not outlive the session either.
    {
      const server = fakeServer();
      server.posts.push(403);
      const view = mount(server, { keys: [key(1)] });
      await ready();
      server.hold.posts = 1;
      await addCustomer('Ada Lovelace');
      await waitFor(() => expect(server.held).toHaveLength(1));
      await view.go('/elsewhere');
      await view.go('/customers/directory');
      await ready();
      server.held[0].release();
      await waitFor(() => expect(createStatus()).toHaveTextContent('"Ada Lovelace" was not added: the server refused that request.'));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(createStatus().textContent).toBe('');
      expect(page()).not.toMatch(/Ada Lovelace/);
      expect(logins(server)).toHaveLength(1);
      cleanup();
    }
    // What must stay does: the hold of an uncertain create and its reason outlive the session's end.
    {
      const server = fakeServer();
      server.posts.push('rollback-503');
      mount(server, { keys: [key(1)] });
      await ready();
      await addCustomer('Ada Lovelace');
      await unresolved();
      await click('directory-check-again'); // inside the lease: still in progress
      await waitFor(() => expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('The server is still working on it.'));
      server.sessions.clear();
      await focusWindow();
      await waitFor(() => expect(phase()).toBe('signed-out'));
      expect(hold()).toHaveAttribute('data-state', 'unresolved');
      expect(screen.getByTestId('directory-hold-reason')).toHaveTextContent('The server is still working on it.');
      expect(logins(server)).toHaveLength(1);
    }
  });

  it('SCD-81. a plain read of the OTHER view that finds the session ended never cancels a Reconnect already pressed: the customer comes back with exactly one more login, and nothing is re-sent', async () => {
    const server = fakeServer();
    const [bea] = server.seed(TENANT_A, ['Bea']);
    server.posts.push('lost-before');
    const view = mount(server, { keys: [key(1)] });
    await ready();
    await addCustomer('Ada Lovelace');
    await unresolved();
    await view.go(`/customers/directory/${bea.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Bea'));
    server.sessions.clear();
    await focusWindow();
    await waitFor(() => expect(screen.getByTestId('directory-detail')).toHaveAttribute('data-phase', 'signed-out'));
    server.hold.checks = 1;
    await click('directory-stop-tracking'); // a plain page-one read of the list, whose session read is held
    await waitFor(() => expect(server.held).toHaveLength(1));
    await click('directory-detail-retry'); // Reconnect, before that read answers
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Bea'));
    await settle();
    expect(logins(server)).toHaveLength(2);
    expect(posts(server)).toHaveLength(1);
    await view.go('/customers/directory');
    await ready();
    expect(names()).toEqual(['Bea']);
    expect(logins(server)).toHaveLength(2);
  });

  it('SCD-82. a focus check that finds the session ended after "Back to directory" (a route change, no read) still clears: the old rows never come back as ready, and nothing logs in', async () => {
    const server = fakeServer();
    const [ada] = server.seed(TENANT_A, ['Ada']);
    const view = mount(server);
    await ready();
    await view.go(`/customers/directory/${ada.id}`);
    await waitFor(() => expect(screen.getByTestId('directory-detail-name')).toHaveTextContent('Ada'));
    server.sessions.clear();
    server.hold.checks = 1;
    await focusWindow();
    await waitFor(() => expect(server.held).toHaveLength(1));
    await view.go('/customers/directory'); // leaving the detail moves its read counter and starts no read
    await act(async () => { server.held[0].release(); });
    await waitFor(() => expect(phase()).toBe('signed-out'));
    expect(names()).toEqual([]);
    expect(page()).not.toMatch(/Ada/);
    await settle();
    expect(logins(server)).toHaveLength(1);
  });
});
