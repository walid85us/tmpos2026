// Phase 4.0 M5-GIAM-D1-P3 — the Tenant Management workspace in jsdom: the real routes, shell, session client and
// Tenant Management client over one scripted server (synthetic tenants only), plus the client's pure rules and the
// session client's `command`. The server decides everything; these tests prove the page shows only what it answered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { inspect } from 'node:util';
import { MemoryRouter } from 'react-router-dom';
import { ConsoleProvider, ConsoleRoutes } from './AdminConsoleApp';
import type { AdminIdentityProvider } from './adminIdentity';
import { COMMAND_PATHS, createAdminSessionClient } from './adminSessionClient';
import { createCommandCenterClient } from './commandCenterClient';
import {
  DISPLAY_NAME_PATH, PAGE_SIZE, STATUS_PATH, TENANTS_PATH, checkDisplayName, checkReason, commandOutcomeOf, createIntentKeys,
  createTenantManagementClient, isDefinitive, parseTenantPage,
} from './tenantManagementClient';
import type { CommandOutcome, TenantManagementClient } from './tenantManagementClient';

const CSRF = 'q'.repeat(43);
const COOKIE = 'synthetic-admin-cookie-5e71';
const SENSITIVE = [CSRF, COOKIE];
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR = 'nextCursorSynthetic0001';
const LIST_URL = `${TENANTS_PATH}?limit=${PAGE_SIZE}`;

/** A synthetic tenant id: a well-formed version-4 UUID numbered `n`. */
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T1 = uuid(1);
const T2 = uuid(2);
const T3 = uuid(3);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const acme = (over: Json = {}): Json => ({ tenantId: T1, displayName: 'Acme Retail', status: 'active', version: 3, ...over });
const beta = (over: Json = {}): Json => ({ tenantId: T2, displayName: 'Beta Stores', status: 'suspended', version: 7, ...over });
const gamma = (over: Json = {}): Json => ({ tenantId: T3, displayName: null, status: 'trialing', version: 1, ...over });
const VIEW = { editDisplayName: false, changeStatus: false };
const EDIT = { editDisplayName: true, changeStatus: false };
const MANAGE = { editDisplayName: true, changeStatus: true };
const pageOf = (tenants: Json[], actions = MANAGE, nextCursor: string | null = null) => ({ tenants, nextCursor, actions });

const EXPIRED = 'Your session has ended. Sign in again to continue.';
const UNCERTAIN = 'The server did not confirm this change, so it may or may not have been saved. Try again to find out — retrying the same change is safe.';
const CONFLICT = 'This tenant changed after it was loaded, so nothing was saved. The current details are shown; review them and try again.';
const STEP_UP = 'This change needs a recent sign-in. Sign in again, then retry. Nothing was changed.';
const INVALID_STATE = "The tenant's status changed, so this action no longer applies. The current status is shown.";
const SUSPENDED = 'Tenant suspended. Every tenant and store session is refused from its next request.';
const REACTIVATED = 'Tenant reactivated. Its users can sign in again; sessions that ended during the suspension are not restored.';
const CHARACTER = 'Remove control, line-break and text-direction characters.';

const json = (status: number, body: unknown, type = 'application/json'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

type Reply = () => Response | Promise<Response>;
const ok = (body: unknown): Reply => () => json(200, body);
const answer = (status: number, body: unknown = { error: 'refused', requestId: 'r1' }): Reply => () => json(status, body);
const lost: Reply = () => {
  throw new TypeError('Failed to fetch');
};

/** A reply the test answers later. */
function held() {
  let settle!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { reply: (() => pending) as Reply, settle: (response: Response) => act(async () => settle(response)) };
}

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Json;
  readonly init: RequestInit;
}

type Script = Partial<Record<'session' | 'logout' | 'list' | 'rename' | 'status', readonly Reply[]>>;

/** One scripted server for the session, the directory and both commands; each route answers from its queue and repeats its last answer. */
function scriptedServer(script: Script) {
  const sent: Sent[] = [];
  const queues: Record<string, Reply[]> = {
    session: [...(script.session ?? [ok({ status: 'active', csrfToken: CSRF })])],
    logout: [...(script.logout ?? [() => new Response(null, { status: 204 })])],
    list: [...(script.list ?? [])],
    rename: [...(script.rename ?? [])],
    status: [...(script.status ?? [])],
  };
  const route = (method: string, url: string): string | null => {
    if (method === 'GET' && url === '/admin/v1/session') return 'session';
    if (method === 'POST' && url === '/admin/v1/session/logout') return 'logout';
    if (method === 'GET' && url.startsWith(`${TENANTS_PATH}?`)) return 'list';
    if (method === 'PATCH' && url === DISPLAY_NAME_PATH) return 'rename';
    if (method === 'PATCH' && url === STATUS_PATH) return 'status';
    return null;
  };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const url = String(input);
    sent.push({ method, url, headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, init });
    const name = route(method, url);
    const queue = name === null ? [] : queues[name];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      if (reply === undefined) resolve(new Response(null, { status: 404 }));
      else Promise.resolve().then(reply).then(resolve, reject);
    });
  });
  const of = (method: string, match: (url: string) => boolean) => sent.filter((request) => request.method === method && match(request.url));
  return {
    sent,
    fetch,
    lists: () => of('GET', (url) => url.startsWith(`${TENANTS_PATH}?`)),
    renames: () => of('PATCH', (url) => url === DISPLAY_NAME_PATH),
    statuses: () => of('PATCH', (url) => url === STATUS_PATH),
    logouts: () => of('POST', (url) => url === '/admin/v1/session/logout'),
  };
}

function renderPage(script: Script) {
  const server = scriptedServer(script);
  const client = createAdminSessionClient({ fetch: server.fetch as unknown as typeof fetch });
  const tenants: TenantManagementClient = createTenantManagementClient({ session: client, fetch: server.fetch as unknown as typeof fetch });
  const ccFetch = vi.fn(async () => json(503, { error: 'unavailable' }));
  const identity: AdminIdentityProvider = { signIn: vi.fn<AdminIdentityProvider['signIn']>(async () => ({ kind: 'failed', failure: 'unavailable' })) };
  const view = render(
    <ConsoleProvider client={client} identity={identity} commandCenter={createCommandCenterClient({ fetch: ccFetch as unknown as typeof fetch })} tenants={tenants}>
      <MemoryRouter initialEntries={['/admin/tenant-management']}>
        <ConsoleRoutes />
      </MemoryRouter>
    </ConsoleProvider>,
  );
  return { ...view, server, client, tenants, ccFetch, user: userEvent.setup() };
}

const main = () => screen.getByRole('main');
/** The shell's main landmark once the session is confirmed and the workspace title is shown. */
const shown = async () => {
  await screen.findByRole('heading', { level: 1, name: 'Tenant Management' });
  return main();
};
const details = () => document.querySelector<HTMLElement>('section[aria-labelledby="tenant-details-title"]')!;
const rows = () => within(within(main()).getByRole('table')).getAllByRole('row').slice(1);

async function open(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Open details for ${name}` }));
  return details();
}

async function rename(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = within(details()).getByLabelText('New display name');
  await user.clear(input);
  await user.type(input, value);
  await user.click(within(details()).getByRole('button', { name: 'Save display name' }));
}

async function lifecycle(user: ReturnType<typeof userEvent.setup>, trigger: 'Suspend tenant' | 'Reactivate tenant', reason?: string) {
  await user.click(within(details()).getByRole('button', { name: trigger }));
  const dialog = screen.getByRole('dialog');
  if (reason !== undefined) {
    await user.type(within(dialog).getByLabelText('Reason'), reason);
    await user.click(within(dialog).getByRole('button', { name: trigger }));
  }
  return dialog;
}

const statusIn = (element: HTMLElement) => within(element).queryByRole('status');

let setItem: ReturnType<typeof vi.spyOn>;
let cookieRead: ReturnType<typeof vi.spyOn>;
let logged: unknown[][];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = `tmpos_admin_session=${COOKIE}; path=/`; // a cookie the page must never read or render
  setItem = vi.spyOn(Storage.prototype, 'setItem');
  cookieRead = vi.spyOn(Document.prototype, 'cookie', 'get');
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Declared second, so it runs first (vitest runs after-hooks as a stack), while the DOM is still mounted.
afterEach(() => {
  try {
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(cookieRead).not.toHaveBeenCalled();
    const html = document.documentElement.outerHTML;
    const output = logged.map((args) => inspect(args, { depth: 6 })).join('\n');
    for (const secret of SENSITIVE) {
      expect(html).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
  } finally {
    cleanup();
  }
});

describe('Tenant Management: the directory', () => {
  it('shows a loading state until the directory answers, then the list', async () => {
    const reply = held();
    const { server } = renderPage({ list: [reply.reply] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Tenant Management' })).toBeInTheDocument();
    await waitFor(() => expect(within(main()).getAllByText('Loading tenants…')).toHaveLength(2)); // shown and announced
    expect(within(main()).queryByRole('table')).toBeNull();
    await reply.settle(json(200, pageOf([acme()])));
    expect(await within(main()).findByRole('table')).toBeInTheDocument();
    expect(within(main()).queryByText('Loading tenants…')).toBeNull();
    expect(within(main()).getByText('1 tenant loaded.')).toBeInTheDocument();
    expect(server.lists().map((request) => request.url)).toEqual([LIST_URL]);
  });

  it('says so when there are no tenants, with no table', async () => {
    renderPage({ list: [ok(pageOf([]))] });
    expect(await within(await shown()).findAllByText('No tenants to show.')).toHaveLength(2); // the note and its announcement
    expect(within(main()).queryByRole('table')).toBeNull();
    expect(within(main()).getByText('Choose a tenant to see its details.')).toBeInTheDocument();
  });

  it.each<[string, Reply, string]>([
    ['the server fails', answer(503), 'The server did not answer. Nothing was changed.'],
    ['the connection is lost', lost, 'The server did not answer. Nothing was changed.'],
    ['the answer breaks the contract', ok({ tenants: 'all', nextCursor: null, actions: MANAGE }), 'The server did not answer. Nothing was changed.'],
    ['the answer is not JSON', () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'The server did not answer. Nothing was changed.'],
    ['the server is busy', answer(429), 'Too many requests. Wait a moment, then try again.'],
  ])('shows a bounded failure when %s, and Try again reads the list', async (_case, first, text) => {
    const { server, user } = renderPage({ list: [first, ok(pageOf([acme()]))] });
    const alert = await within(await shown()).findByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Tenants could not be loaded' })).toBeInTheDocument();
    expect(alert).toHaveTextContent(text);
    expect(within(main()).queryByRole('table')).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(main()).findByRole('table')).toBeInTheDocument();
    expect(within(main()).queryByRole('alert')).toBeNull();
    expect(server.lists().map((request) => request.url)).toEqual([LIST_URL, LIST_URL]);
  });

  it('shows a 403 as not available: no list, no retry, no action', async () => {
    const { server } = renderPage({ list: [answer(403, { error: 'forbidden' })] });
    const alert = await within(await shown()).findByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Not available' })).toBeInTheDocument();
    expect(alert).toHaveTextContent('Your account does not have access to Tenant Management.');
    expect(within(main()).queryAllByRole('button')).toHaveLength(0);
    expect(within(main()).queryByRole('table')).toBeNull();
    expect(server.sent.map((request) => `${request.method} ${request.url}`)).toEqual(['GET /admin/v1/session', `GET ${LIST_URL}`]);
  });

  it('ends the session on a 401 and returns to sign-in with the expiry notice, sending nothing more', async () => {
    const { server } = renderPage({ list: [answer(401)] });
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in to the Control Plane' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(server.sent.map((request) => `${request.method} ${request.url}`)).toEqual(['GET /admin/v1/session', `GET ${LIST_URL}`]);
  });

  it('offers no Next while the requested page failed to load, so the page count never runs ahead of the pages read', async () => {
    const { user, server } = renderPage({ list: [ok(pageOf([acme()], MANAGE, CURSOR)), answer(503)] });
    await shown();
    await user.click(await within(main()).findByRole('button', { name: 'Next page' }));
    expect(await within(main()).findByText(/The list could not be refreshed/)).toBeInTheDocument();
    expect(within(main()).getByText('Page 2')).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(within(main()).getByRole('button', { name: 'Previous page' })).toBeEnabled();
    expect(server.lists()).toHaveLength(2);
  });

  it('pages with the server cursor: Next sends it, Previous returns, and the page number follows', async () => {
    const { server, user } = renderPage({
      list: [ok(pageOf([acme()], MANAGE, CURSOR)), ok(pageOf([beta()], MANAGE, null)), ok(pageOf([acme()], MANAGE, CURSOR))],
    });
    await within(await shown()).findByRole('table');
    const nav = screen.getByRole('navigation', { name: 'Tenant pages' });
    expect(within(nav).getByText('Page 1')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(within(nav).getByRole('button', { name: 'Next page' }));
    expect(await within(main()).findByText('Beta Stores')).toBeInTheDocument();
    expect(within(nav).getByText('Page 2')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Next page' })).toBeDisabled(); // the server said there is no next page
    await user.click(within(nav).getByRole('button', { name: 'Previous page' }));
    expect(await within(main()).findByText('Acme Retail')).toBeInTheDocument();
    expect(within(nav).getByText('Page 1')).toBeInTheDocument();
    expect(server.lists().map((request) => request.url)).toEqual([LIST_URL, `${LIST_URL}&cursor=${CURSOR}`, LIST_URL]);
  });

  it('conveys every lifecycle status as text', async () => {
    const statuses: Array<[string, string]> = [
      ['active', 'Active'], ['trialing', 'Trial'], ['overdue', 'Overdue'], ['suspended', 'Suspended'], ['read_only', 'Read-only'], ['pending_activation', 'Pending activation'],
    ];
    renderPage({ list: [ok(pageOf(statuses.map(([status], i) => ({ tenantId: uuid(i + 10), displayName: `Tenant ${i}`, status, version: 1 }))))] });
    await within(await shown()).findByRole('table');
    expect(rows().map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual(statuses.map(([, label]) => label));
  });

  it('opens a tenant on selection and moves focus to its details heading', async () => {
    const { user } = renderPage({ list: [ok(pageOf([acme(), gamma()]))] });
    const button = await screen.findByRole('button', { name: 'Open details for Acme Retail' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    await waitFor(() => expect(within(details()).getByRole('heading', { level: 2, name: 'Acme Retail' })).toHaveFocus());
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect([...details().querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['Active', T1, '3']);
    await user.click(screen.getByRole('button', { name: 'Open details for Unnamed tenant' }));
    await waitFor(() => expect(within(details()).getByRole('heading', { level: 2, name: 'Unnamed tenant' })).toHaveFocus());
  });
});

describe('Tenant Management: what a session may see', () => {
  it.each<[string, typeof VIEW, boolean, boolean]>([
    ['View', VIEW, false, false],
    ['Edit', EDIT, true, false],
    ['Manage', MANAGE, true, true],
  ])('shows %s exactly the controls the server hints at, and never a store lifecycle control', async (_role, actions, canRename, canChange) => {
    const { user, server } = renderPage({ list: [ok(pageOf([acme(), beta(), gamma()], actions))] });
    const panel = await open(user, 'Acme Retail');
    expect(within(panel).queryByLabelText('New display name') !== null).toBe(canRename);
    expect(within(panel).queryByRole('button', { name: 'Save display name' }) !== null).toBe(canRename);
    expect(within(panel).queryByRole('button', { name: 'Suspend tenant' }) !== null).toBe(canChange);
    if (!canRename) expect(panel.querySelector('form, input, textarea, select')).toBeNull();
    await open(user, 'Beta Stores');
    expect(within(details()).queryByRole('button', { name: 'Reactivate tenant' }) !== null).toBe(canChange);
    await open(user, 'Unnamed tenant');
    // Neither active nor suspended: the transition is not the console's to offer, so it says why instead.
    expect(within(details()).queryByRole('button', { name: /suspend|reactivate/i })).toBeNull();
    expect(within(details()).queryByText(/available only for active or suspended tenants\. This tenant is trial\./) !== null).toBe(canChange);
    for (const button of within(main()).getAllByRole('button')) expect(button.textContent ?? '').not.toMatch(/store/i);
    expect(server.renames()).toHaveLength(0);
    expect(server.statuses()).toHaveLength(0);
  });

  it('is refused by the server even when a hidden action is invoked directly, and shows nothing as saved', async () => {
    const forbidden = answer(403, { error: 'forbidden', requestId: 'r1' });
    const { user, server, tenants, client } = renderPage({ list: [ok(pageOf([acme()], VIEW))], rename: [forbidden], status: [forbidden] });
    const panel = await open(user, 'Acme Retail');
    expect(panel.querySelector('form, input, textarea')).toBeNull();
    const outcomes: unknown[] = [];
    await act(async () => {
      outcomes.push(await tenants.rename({ tenantId: T1, displayName: 'Hidden Rename', expectedVersion: 3 }, crypto.randomUUID()));
      outcomes.push(await tenants.changeStatus({ tenantId: T1, status: 'suspended', reason: 'Invoked from a console', expectedVersion: 3 }, crypto.randomUUID()));
      outcomes.push(await client.command({ path: COMMAND_PATHS[0], body: { tenantId: T1, displayName: 'Raw Rename', expectedVersion: 3 }, idempotencyKey: crypto.randomUUID() }));
    });
    expect(outcomes).toEqual([{ kind: 'forbidden' }, { kind: 'forbidden' }, { kind: 'response', status: 403, body: { error: 'forbidden', requestId: 'r1' } }]);
    expect(server.renames()).toHaveLength(2);
    expect(server.statuses()).toHaveLength(1);
    expect(statusIn(panel)).toBeNull();
    expect(within(panel).getByRole('heading', { level: 2, name: 'Acme Retail' })).toBeInTheDocument();
    expect(within(panel).getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText(/Hidden Rename|Raw Rename|saved|Tenant suspended/)).toBeNull();
  });
});

describe('Tenant Management: the display name', () => {
  it('sends exactly the trimmed name and the server version, shows the confirmed value, then reads the list again', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()], EDIT)), ok(pageOf([acme({ displayName: 'Acme Retail Group', version: 4 })], EDIT))],
      rename: [ok({ tenantId: T1, displayName: 'Acme Retail Group', version: 4 })],
    });
    await open(user, 'Acme Retail');
    await rename(user, '  Acme Retail Group  ');
    const saved = await within(details()).findByRole('status');
    expect(saved).toHaveTextContent('Display name saved as “Acme Retail Group”.');
    const [sent] = server.renames();
    expect(sent.body).toStrictEqual({ tenantId: T1, displayName: 'Acme Retail Group', expectedVersion: 3 });
    expect(sent.headers.get('idempotency-key')).toMatch(KEY_RE);
    expect(sent.headers.get('x-tmpos-csrf')).toBe('1');
    expect(sent.headers.get('x-tmpos-session-csrf')).toBe(CSRF);
    expect(within(details()).getByLabelText('New display name')).toHaveValue('Acme Retail Group');
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    await waitFor(() => expect([...details().querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['Active', T1, '4']));
    expect(rows()[0]).toHaveTextContent('Acme Retail Group');
  });

  it.each<[string, string, string]>([
    ['empty', '   ', 'Enter a display name.'],
    ['longer than 120 characters', 'x'.repeat(121), 'Use at most 120 characters.'],
    ['a control character', `Acme${String.fromCodePoint(0x07)}Retail`, CHARACTER],
    ['a line separator', `Acme${String.fromCodePoint(0x2028)}Retail`, CHARACTER],
    ['a text-direction character', `Acme${String.fromCodePoint(0x202e)}Retail`, CHARACTER],
  ])('refuses a name that is %s before sending, with a linked error and a persistent label', async (_case, value, message) => {
    const { user, server } = renderPage({ list: [ok(pageOf([acme()], EDIT))] });
    await open(user, 'Acme Retail');
    const input = within(details()).getByLabelText('New display name');
    fireEvent.change(input, { target: { value } });
    await user.click(within(details()).getByRole('button', { name: 'Save display name' }));
    const error = within(details()).getByText(message);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toEqual(['display-name-hint', error.id]);
    expect(input).toHaveAccessibleDescription(`1–120 characters. Spaces at either end are removed. ${message}`);
    expect(within(details()).getByLabelText('New display name')).toBe(input);
    expect(input).toHaveFocus();
    expect(server.renames()).toHaveLength(0);
  });

  it('keeps the entered value on a write conflict, says so, and reads the current details', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()], EDIT)), ok(pageOf([acme({ displayName: 'Acme Renamed Elsewhere', version: 5 })], EDIT))],
      rename: [answer(409, { error: 'write_conflict' })],
    });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme Retail Group');
    expect(await within(details()).findByRole('alert')).toHaveTextContent(CONFLICT);
    expect(within(details()).getByLabelText('New display name')).toHaveValue('Acme Retail Group');
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    await waitFor(() => expect(within(details()).getByRole('heading', { level: 2 })).toHaveTextContent('Acme Renamed Elsewhere'));
    expect(statusIn(details())).toBeNull();
  });

  it('shows nothing as saved before the server answers, and sends one request however often it is submitted', async () => {
    const reply = held();
    const { user, server } = renderPage({ list: [ok(pageOf([acme()], EDIT))], rename: [reply.reply] });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme Retail Group');
    const button = within(details()).getByRole('button', { name: /Saving/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    const form = button.closest('form')!;
    fireEvent.submit(form); // a submission the disabled button cannot stop
    fireEvent.submit(form);
    await user.type(within(details()).getByLabelText('New display name'), '{Enter}');
    expect(server.renames()).toHaveLength(1);
    // No optimistic success: the list, the heading and the version still show the server's last answer.
    expect(rows()[0]).toHaveTextContent('Acme Retail');
    expect(rows()[0]).not.toHaveTextContent('Acme Retail Group');
    expect(within(details()).getByRole('heading', { level: 2 })).toHaveTextContent('Acme Retail');
    expect(statusIn(details())).toBeNull();
    await reply.settle(json(200, { tenantId: T1, displayName: 'Acme Retail Group', version: 4 }));
    expect(await within(details()).findByRole('status')).toHaveTextContent('Display name saved as “Acme Retail Group”.');
    expect(server.renames()).toHaveLength(1);
  });

  it.each<[string, Reply]>([
    ['the connection is lost', lost],
    ['the server fails with 503', answer(503)],
    ['the same request is still running', answer(409, { error: 'request_in_progress' })],
  ])('retries the same change under the same key when %s', async (_case, first) => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()], EDIT))],
      rename: [first, ok({ tenantId: T1, displayName: 'Acme Retail Group', version: 4 })],
    });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme Retail Group');
    const alert = await within(details()).findByRole('alert');
    expect(alert).toHaveTextContent(UNCERTAIN);
    expect(server.lists()).toHaveLength(1); // an unknown outcome settles nothing, so nothing is re-read
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(details()).findByRole('status')).toHaveTextContent('Display name saved as “Acme Retail Group”.');
    const [a, b] = server.renames();
    expect(b.headers.get('idempotency-key')).toBe(a.headers.get('idempotency-key'));
    expect(b.body).toStrictEqual(a.body);
  });

  it('replays the unconfirmed change verbatim on Try again, even after a refresh brought a newer version', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()], EDIT)), ok(pageOf([acme({ version: 4 })], EDIT))],
      rename: [lost, ok({ tenantId: T1, displayName: 'Acme Retail Group', version: 5 })],
    });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme Retail Group');
    const alert = await within(details()).findByRole('alert');
    await user.click(within(main()).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect([...details().querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['Active', T1, '4']));
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(details()).findByRole('status')).toHaveTextContent('Display name saved as “Acme Retail Group”.');
    const [a, b] = server.renames();
    expect(b.body).toStrictEqual(a.body); // the version the change was made against, not the refreshed one
    expect(b.headers.get('idempotency-key')).toBe(a.headers.get('idempotency-key'));
    // The confirmation is also announced through the page's standing live region, with the re-read that follows it.
    await waitFor(() => expect(document.querySelector('p.sr-only[role="status"]')).toHaveTextContent('Display name saved as “Acme Retail Group”. 1 tenant loaded.'));
  });

  it('keeps the name field read-only while a change is pending, so the confirmed value never overwrites newer typing', async () => {
    const reply = held();
    const { user } = renderPage({ list: [ok(pageOf([acme()], EDIT))], rename: [reply.reply] });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme Retail Group');
    const input = within(details()).getByLabelText('New display name');
    expect(input).toHaveAttribute('readonly');
    await reply.settle(json(200, { tenantId: T1, displayName: 'Acme Retail Group', version: 4 }));
    await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
    expect(input).toHaveValue('Acme Retail Group');
  });

  it('re-reads the page shown when a command finishes, not the page it started on', async () => {
    const reply = held();
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()], EDIT, CURSOR)), ok(pageOf([beta()], EDIT))],
      rename: [reply.reply],
    });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme Retail Group');
    await user.click(within(main()).getByRole('button', { name: 'Next page' }));
    await screen.findByRole('button', { name: 'Open details for Beta Stores' });
    await reply.settle(json(200, { tenantId: T1, displayName: 'Acme Retail Group', version: 4 }));
    await waitFor(() => expect(server.lists()).toHaveLength(3));
    expect(server.lists()[2].url).toBe(`${LIST_URL}&cursor=${CURSOR}`);
    expect(within(main()).getByText('Page 2')).toBeInTheDocument();
  });

  it('uses a new key for a new intent: after a definitive answer, and after the value changes', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()], EDIT))],
      rename: [answer(409, { error: 'write_conflict' }), answer(503), ok({ tenantId: T1, displayName: 'Acme Two', version: 4 })],
    });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme One');
    expect(await within(details()).findByRole('alert')).toHaveTextContent(CONFLICT);
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    await user.click(within(details()).getByRole('button', { name: 'Save display name' })); // the same change, now a new intent
    expect(await within(details()).findByRole('alert')).toHaveTextContent(UNCERTAIN);
    await rename(user, 'Acme Two'); // a different change after an uncertain answer
    expect(await within(details()).findByRole('status')).toHaveTextContent('Display name saved as “Acme Two”.');
    const [first, second, third] = server.renames();
    expect(second.body).toStrictEqual(first.body);
    const keys = [first, second, third].map((request) => request.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(KEY_RE);
  });

  it('returns to sign-in when a command answers 401', async () => {
    const { user } = renderPage({ list: [ok(pageOf([acme()], EDIT))], rename: [answer(401)] });
    await open(user, 'Acme Retail');
    await rename(user, 'Acme Retail Group');
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
  });
});

describe('Tenant Management: suspend and reactivate', () => {
  it('confirms a suspension in a modal dialog, requires a reason, and shows the new status only after the server answers', async () => {
    const reply = held();
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()])), ok(pageOf([acme({ status: 'suspended', version: 4 })]))],
      status: [reply.reply],
    });
    await open(user, 'Acme Retail');
    const trigger = within(details()).getByRole('button', { name: 'Suspend tenant' });
    let dialog = await lifecycle(user, 'Suspend tenant');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Suspend Acme Retail?');
    expect(dialog).toHaveAccessibleDescription(/takes effect immediately: every session of this tenant and its stores is refused/);
    const reason = within(dialog).getByLabelText('Reason');
    expect(reason).toHaveFocus();

    // The reason is required: 10 to 500 characters, said in text and linked to the field.
    const confirm = within(dialog).getByRole('button', { name: 'Suspend tenant' });
    await user.click(confirm);
    expect(within(dialog).getByText('Enter a reason of at least 10 characters.')).toBeInTheDocument();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason.getAttribute('aria-describedby')).toBe('lifecycle-reason-hint lifecycle-reason-error');
    await user.type(reason, 'too short');
    await user.click(confirm);
    expect(within(dialog).getByText('Enter a reason of at least 10 characters.')).toBeInTheDocument();

    // Focus stays inside: Tab from the last control wraps to the first, Shift+Tab from the first to the last.
    reason.focus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(reason).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();

    // Escape and Cancel close it without sending, and focus returns to the trigger.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    dialog = await lifecycle(user, 'Suspend tenant');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(server.statuses()).toHaveLength(0);

    dialog = await lifecycle(user, 'Suspend tenant', '  Chargeback fraud under review  ');
    const [sent] = server.statuses();
    expect(sent.body).toStrictEqual({ tenantId: T1, status: 'suspended', reason: 'Chargeback fraud under review', expectedVersion: 3 });
    expect(sent.headers.get('idempotency-key')).toMatch(KEY_RE);
    // Pending: still open, still Active, nothing announced as done.
    expect(within(dialog).getByRole('button', { name: /Sending/ })).toHaveAttribute('aria-busy', 'true');
    expect(within(details()).getAllByText('Active').length).toBeGreaterThan(0);
    expect(statusIn(details())).toBeNull();
    await reply.settle(json(200, { tenantId: T1, status: 'suspended', version: 4 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await within(details()).findByRole('status')).toHaveTextContent(SUSPENDED);
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    await waitFor(() => expect([...details().querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['Suspended', T1, '4']));
    expect(within(details()).getByRole('button', { name: 'Reactivate tenant' })).toBeInTheDocument();
  });

  it('confirms a reactivation, saying it restores no session, and sends the one transition the reported status allows', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([beta()])), ok(pageOf([beta({ status: 'active', version: 8 })]))],
      status: [ok({ tenantId: T2, status: 'active', version: 8 })],
    });
    await open(user, 'Beta Stores');
    const dialog = await lifecycle(user, 'Reactivate tenant');
    expect(dialog).toHaveAccessibleName('Reactivate Beta Stores?');
    expect(dialog).toHaveAccessibleDescription(/does not restore any session that ended while the tenant was suspended/);
    await user.type(within(dialog).getByLabelText('Reason'), 'Payment dispute resolved');
    await user.click(within(dialog).getByRole('button', { name: 'Reactivate tenant' }));
    expect(await within(details()).findByRole('status')).toHaveTextContent(REACTIVATED);
    expect(server.statuses()[0].body).toStrictEqual({ tenantId: T2, status: 'active', reason: 'Payment dispute resolved', expectedVersion: 7 });
    await waitFor(() => expect(server.lists()).toHaveLength(2));
  });

  it.each<[string, string, string]>([
    ['longer than 500 characters', 'r'.repeat(501), 'Use at most 500 characters.'],
    ['a control character', `Fraud review${String.fromCodePoint(0x00)} pending`, CHARACTER],
    ['a text-direction character', `Fraud review${String.fromCodePoint(0x2067)} pending`, CHARACTER],
  ])('refuses a reason that is %s before sending', async (_case, value, message) => {
    const { user, server } = renderPage({ list: [ok(pageOf([acme()]))] });
    await open(user, 'Acme Retail');
    const dialog = await lifecycle(user, 'Suspend tenant');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value } });
    await user.click(within(dialog).getByRole('button', { name: 'Suspend tenant' }));
    expect(within(dialog).getByText(message)).toHaveAttribute('id', 'lifecycle-reason-error');
    expect(within(dialog).getByLabelText('Reason')).toHaveAttribute('aria-invalid', 'true');
    expect(server.statuses()).toHaveLength(0);
  });

  it('retries an unconfirmed status change under the same key from inside the dialog', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()]))],
      status: [lost, ok({ tenantId: T1, status: 'suspended', version: 4 })],
    });
    await open(user, 'Acme Retail');
    const dialog = await lifecycle(user, 'Suspend tenant', 'Chargeback fraud under review');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(UNCERTAIN);
    expect(server.lists()).toHaveLength(1);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(details()).findByRole('status')).toHaveTextContent(SUSPENDED);
    const [a, b] = server.statuses();
    expect(b.headers.get('idempotency-key')).toBe(a.headers.get('idempotency-key'));
    expect(b.body).toStrictEqual(a.body);
  });

  it('sends one status change however often it is confirmed while pending, and keeps the dialog open until the answer', async () => {
    const reply = held();
    const { user, server } = renderPage({ list: [ok(pageOf([acme()]))], status: [reply.reply] });
    await open(user, 'Acme Retail');
    const dialog = await lifecycle(user, 'Suspend tenant', 'Chargeback fraud under review');
    const pending = within(dialog).getByRole('button', { name: /Sending/ });
    expect(pending).toBeDisabled();
    await user.click(pending);
    fireEvent.click(pending);
    await user.keyboard('{Escape}'); // nor does Escape abandon a change in flight
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(server.statuses()).toHaveLength(1);
    await reply.settle(json(200, { tenantId: T1, status: 'suspended', version: 4 }));
    expect(await within(details()).findByRole('status')).toHaveTextContent(SUSPENDED);
    expect(server.statuses()).toHaveLength(1);
  });

  it('asks for a fresh sign-in on step_up_required, synthesizes no evidence, and signs out on request', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()]))],
      status: [answer(403, { error: 'step_up_required', requestId: 'r1' })],
    });
    await open(user, 'Acme Retail');
    await lifecycle(user, 'Suspend tenant', 'Chargeback fraud under review');
    const alert = await within(details()).findByRole('alert');
    expect(alert).toHaveTextContent(STEP_UP);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(details()).getAllByText('Active').length).toBeGreaterThan(0);
    // Exactly the command: no Authorization, no token, no extra field.
    expect(server.statuses()).toHaveLength(1);
    const [sent] = server.statuses();
    expect([...sent.headers.keys()].sort()).toEqual(['accept', 'content-type', 'idempotency-key', 'x-tmpos-csrf', 'x-tmpos-session-csrf']);
    expect(Object.keys(sent.body).sort()).toEqual(['expectedVersion', 'reason', 'status', 'tenantId']);
    await user.click(within(alert).getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByText('You have signed out.')).toBeInTheDocument();
    expect(server.logouts()).toHaveLength(1);
    expect(server.statuses()).toHaveLength(1);
  });

  it('keeps focus in the dialog however late a frame from choosing the tenant runs', async () => {
    // Hold every animation frame, open the dialog, then run them: no deferred focus may take the reason field's focus.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    try {
      const { user } = renderPage({ list: [ok(pageOf([acme()]))] });
      await open(user, 'Acme Retail');
      const dialog = await lifecycle(user, 'Suspend tenant');
      for (const frame of frames.splice(0)) frame(0); // a frame held since the tenant was chosen runs now
      expect(within(dialog).getByLabelText('Reason')).toHaveFocus();
      // Closing restores focus to the trigger at once, not in a later frame...
      await user.keyboard('{Escape}');
      const trigger = within(details()).getByRole('button', { name: 'Suspend tenant' });
      expect(trigger).toHaveFocus();
      // ...and no frame left behind can take focus from where the person moves next.
      const refresh = within(main()).getByRole('button', { name: 'Refresh' });
      refresh.focus();
      for (const frame of frames.splice(0)) frame(0);
      expect(refresh).toHaveFocus();
    } finally {
      raf.mockRestore();
    }
  });

  it('offers the typed reason again when the same transition is reopened after a refusal', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()])), ok(pageOf([acme({ version: 4 })]))],
      status: [answer(409, { error: 'write_conflict' }), ok({ tenantId: T1, status: 'suspended', version: 5 })],
    });
    await open(user, 'Acme Retail');
    await lifecycle(user, 'Suspend tenant', 'Chargeback fraud under review');
    expect(await within(details()).findByRole('alert')).toHaveTextContent(CONFLICT);
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    const again = await lifecycle(user, 'Suspend tenant');
    expect(within(again).getByLabelText('Reason')).toHaveValue('Chargeback fraud under review');
    await user.click(within(again).getByRole('button', { name: 'Suspend tenant' }));
    expect(await within(details()).findByRole('status')).toHaveTextContent(SUSPENDED);
    const [first, second] = server.statuses();
    expect(second.body).toStrictEqual({ ...first.body, expectedVersion: 4 }); // the refreshed version, as a new intent
    expect(second.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'));
  });

  it('isolates a stored name in the confirmation, so a direction control in it cannot reorder the question', async () => {
    const { user } = renderPage({ list: [ok(pageOf([acme({ displayName: 'Acme\u202Eevil' })]))] });
    await open(user, 'Acme\u202Eevil');
    const dialog = await lifecycle(user, 'Suspend tenant');
    const heading = within(dialog).getByRole('heading');
    expect(heading.querySelector('bdi')?.textContent).toBe('Acme\u202Eevil');
  });

  it('refreshes and explains when the status no longer allows the action', async () => {
    const { user, server } = renderPage({
      list: [ok(pageOf([acme()])), ok(pageOf([acme({ status: 'suspended', version: 4 })]))],
      status: [answer(409, { error: 'invalid_state' })],
    });
    await open(user, 'Acme Retail');
    await lifecycle(user, 'Suspend tenant', 'Chargeback fraud under review');
    expect(await within(details()).findByRole('alert')).toHaveTextContent(INVALID_STATE);
    await waitFor(() => expect(server.lists()).toHaveLength(2));
    await waitFor(() => expect([...details().querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['Suspended', T1, '4']));
  });
});

describe('tenantManagementClient', () => {
  const validPage = (): Json => ({
    tenants: [acme(), gamma({ status: 'pending_activation' })],
    nextCursor: CURSOR,
    actions: { editDisplayName: true, changeStatus: false },
  });

  it('parses exactly the directory contract into a frozen page', () => {
    const page = parseTenantPage(validPage())!;
    expect(page).toEqual(validPage());
    expect(Object.isFrozen(page) && Object.isFrozen(page.tenants) && Object.isFrozen(page.tenants[0]) && Object.isFrozen(page.actions)).toBe(true);
    expect(parseTenantPage({ ...validPage(), nextCursor: null, tenants: [] })).toEqual({ tenants: [], nextCursor: null, actions: validPage().actions });
    expect(parseTenantPage({ ...validPage(), tenants: [acme({ displayName: 'x'.repeat(4096) })] })).not.toBeNull();
  });

  it.each<[string, (page: Json) => unknown]>([
    ['null', () => null],
    ['an array', () => []],
    ['a string', () => 'tenants'],
    ['an object with a prototype', (page) => Object.assign(Object.create({ inherited: true }), page)],
    ['an extra top-level key', (page) => ({ ...page, total: 2 })],
    ['a missing key', ({ nextCursor: _omit, ...rest }) => rest],
    ['tenants that are not an array', (page) => ({ ...page, tenants: {} })],
    ['more than 50 tenants', (page) => ({ ...page, tenants: Array.from({ length: 51 }, (_, i) => acme({ tenantId: uuid(i + 100) })) })],
    ['a short cursor', (page) => ({ ...page, nextCursor: 'short' })],
    ['a cursor with a path character', (page) => ({ ...page, nextCursor: `${CURSOR.slice(0, 22)}/` })],
    ['a numeric cursor', (page) => ({ ...page, nextCursor: 7 })],
    ['actions with an extra key', (page) => ({ ...page, actions: { ...page.actions, suspendStore: true } })],
    ['a non-boolean action', (page) => ({ ...page, actions: { editDisplayName: 'yes', changeStatus: false } })],
    ['an entry with an extra key', (page) => ({ ...page, tenants: [acme({ storeId: 's1' })] })],
    ['an entry with a missing key', (page) => ({ ...page, tenants: [{ tenantId: T1, displayName: null, status: 'active' }] })],
    ['an uppercase tenant id', (page) => ({ ...page, tenants: [acme({ tenantId: 'abcdef01-0000-4000-8000-00000000000a'.toUpperCase() })] })],
    ['a duplicate tenant', (page) => ({ ...page, tenants: [acme(), acme({ displayName: 'Again' })] })],
    ['an unknown status', (page) => ({ ...page, tenants: [acme({ status: 'deleted' })] })],
    ['a zero version', (page) => ({ ...page, tenants: [acme({ version: 0 })] })],
    ['a fractional version', (page) => ({ ...page, tenants: [acme({ version: 1.5 })] })],
    ['a string version', (page) => ({ ...page, tenants: [acme({ version: '3' })] })],
    ['an unsafe version', (page) => ({ ...page, tenants: [acme({ version: Number.MAX_SAFE_INTEGER })] })],
    ['a numeric display name', (page) => ({ ...page, tenants: [acme({ displayName: 5 })] })],
    ['a display name past 4096 units', (page) => ({ ...page, tenants: [acme({ displayName: 'x'.repeat(4097) })] })],
  ])('refuses %s as a page', (_case, mutate) => {
    expect(parseTenantPage(mutate(validPage()))).toBeNull();
  });

  const NAME = { tenantId: T1, displayName: 'Acme', expectedVersion: 3 };
  it.each<[number, unknown, CommandOutcome['kind']]>([
    [200, { tenantId: T1, displayName: 'Acme', version: 4 }, 'applied'],
    [200, { tenantId: T2, displayName: 'Acme', version: 4 }, 'uncertain'],
    [200, { tenantId: T1, displayName: 'Acme', version: 4, extra: true }, 'uncertain'],
    [200, { tenantId: T1, displayName: 5, version: 4 }, 'uncertain'],
    [200, { tenantId: T1, displayName: 'Acme', version: 0 }, 'uncertain'],
    [200, { tenantId: T1, status: 'active', version: 4 }, 'uncertain'],
    [200, undefined, 'uncertain'],
    [201, { tenantId: T1, displayName: 'Acme', version: 4 }, 'uncertain'],
    [204, undefined, 'uncertain'],
    [400, { error: 'invalid_request' }, 'invalid'],
    [401, { error: 'unauthenticated' }, 'expired'],
    [403, { error: 'step_up_required' }, 'step-up'],
    [403, { error: 'forbidden' }, 'forbidden'],
    [403, undefined, 'forbidden'],
    [404, { error: 'not_found' }, 'not-found'],
    [409, { error: 'write_conflict' }, 'conflict'],
    [409, { error: 'invalid_state' }, 'invalid-state'],
    [409, { error: 'request_in_progress' }, 'uncertain'],
    [409, undefined, 'uncertain'],
    [418, { error: 'teapot' }, 'uncertain'],
    [422, { error: 'idempotency_key_reused' }, 'key-reused'],
    [429, { error: 'rate_limited' }, 'rate-limited'],
    [500, { error: 'internal' }, 'uncertain'],
    [502, undefined, 'uncertain'],
    [503, { error: 'unavailable' }, 'uncertain'],
    [504, undefined, 'uncertain'],
  ])('maps a rename answer %i %j to %s', (status, body, kind) => {
    const outcome = commandOutcomeOf(status, body, NAME, 'displayName');
    expect(outcome.kind).toBe(kind);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(isDefinitive(outcome)).toBe(kind !== 'uncertain' && kind !== 'rate-limited');
  });

  it('maps a status answer to exactly the confirmed status, and nothing else', () => {
    const request = { tenantId: T1, status: 'suspended', reason: 'Chargeback fraud under review', expectedVersion: 3 };
    expect(commandOutcomeOf(200, { tenantId: T1, status: 'suspended', version: 4 }, request, 'status'))
      .toEqual({ kind: 'applied', tenant: { tenantId: T1, status: 'suspended', version: 4 } });
    expect(commandOutcomeOf(200, { tenantId: T1, status: 'deleted', version: 4 }, request, 'status').kind).toBe('uncertain');
    // A valid status other than the one requested does not confirm this change.
    expect(commandOutcomeOf(200, { tenantId: T1, status: 'active', version: 4 }, request, 'status').kind).toBe('uncertain');
    expect(commandOutcomeOf(200, { tenantId: T1, displayName: 'Acme', version: 4 }, request, 'status').kind).toBe('uncertain');
  });

  it('holds one key per intent until the intent is settled', () => {
    let n = 0;
    const keys = createIntentKeys(() => `key-${++n}`);
    expect(Object.isFrozen(keys)).toBe(true);
    expect([keys.keyFor('a'), keys.keyFor('a'), keys.keyFor('b'), keys.keyFor('a')]).toEqual(['key-1', 'key-1', 'key-2', 'key-3']);
    keys.settle();
    expect(keys.keyFor('a')).toBe('key-4');
    expect(createIntentKeys().keyFor('a')).toMatch(KEY_RE);
  });

  it('restates the server rules for names and reasons', () => {
    expect(checkDisplayName('  Acme  ')).toEqual({ value: 'Acme' });
    expect(checkDisplayName('')).toEqual({ problem: 'empty' });
    expect(checkDisplayName('x'.repeat(120))).toEqual({ value: 'x'.repeat(120) });
    expect(checkDisplayName('x'.repeat(121))).toEqual({ problem: 'too-long' });
    expect(checkDisplayName(`A${String.fromCodePoint(0x9f)}`)).toEqual({ problem: 'character' });
    expect(checkDisplayName(String.fromCharCode(0xd800))).toEqual({ problem: 'character' });
    expect(checkReason('   ')).toEqual({ problem: 'empty' });
    expect(checkReason('123456789')).toEqual({ problem: 'too-short' });
    expect(checkReason(' 1234567890 ')).toEqual({ value: '1234567890' });
    expect(checkReason('r'.repeat(500))).toEqual({ value: 'r'.repeat(500) });
    expect(checkReason('r'.repeat(501))).toEqual({ problem: 'too-long' });
    expect(checkReason(`Fraud review${String.fromCodePoint(0x2029)}pending`)).toEqual({ problem: 'character' });
  });

  describe('list', () => {
    const session = { command: vi.fn() };
    const clientOver = (reply: Reply | 'never', timeoutMs?: number) => {
      const fetch = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          if (reply !== 'never') Promise.resolve().then(reply).then(resolve, reject);
        }));
      return { fetch, tenants: createTenantManagementClient({ session, fetch: fetch as unknown as typeof globalThis.fetch, timeoutMs }) };
    };

    it('reads a page with credentials, no CSRF header and no bearer, and passes the server cursor through', async () => {
      const { fetch, tenants } = clientOver(ok(validPage()));
      expect(await tenants.list(null, new AbortController().signal)).toEqual({ kind: 'ok', page: validPage() });
      expect(await tenants.list(CURSOR, new AbortController().signal)).toEqual({ kind: 'ok', page: validPage() });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([LIST_URL, `${LIST_URL}&cursor=${CURSOR}`]);
      const init = fetch.mock.calls[0][1]!;
      expect(init).toMatchObject({ method: 'GET', credentials: 'include', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      expect([...new Headers(init.headers).keys()]).toEqual(['accept']);
      expect(session.command).not.toHaveBeenCalled();
    });

    it.each<[number, string]>([[400, 'invalid'], [401, 'expired'], [403, 'forbidden'], [429, 'rate-limited'], [404, 'unavailable'], [500, 'unavailable'], [503, 'unavailable']])(
      'maps a %i answer to %s',
      async (status, kind) => {
        const { tenants } = clientOver(answer(status));
        expect(await tenants.list(null, new AbortController().signal)).toEqual({ kind });
      },
    );

    it.each<[string, Reply | 'never']>([
      ['a non-JSON answer', () => new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } })],
      ['an unparseable body', () => new Response('{"tenants":', { status: 200, headers: { 'content-type': 'application/json' } })],
      ['an oversized body', () => json(200, { ...validPage(), pad: 'x'.repeat(262_144) })],
      ['a lost connection', lost],
      ['no answer before the timeout', 'never'],
    ])('reads %s as unavailable', async (_case, reply) => {
      const { tenants } = clientOver(reply, 20);
      expect(await tenants.list(null, new AbortController().signal)).toEqual({ kind: 'unavailable' });
    });

    it('refuses a cursor that is not the server shape without sending, and reports an abort as aborted', async () => {
      const { fetch, tenants } = clientOver('never');
      expect(await tenants.list('../admin', new AbortController().signal)).toEqual({ kind: 'unavailable' });
      expect(await tenants.list(`${CURSOR}&limit=50`, new AbortController().signal)).toEqual({ kind: 'unavailable' });
      const stopped = new AbortController();
      stopped.abort();
      expect(await tenants.list(null, stopped.signal)).toEqual({ kind: 'aborted' });
      expect(fetch).not.toHaveBeenCalled();
      const later = new AbortController();
      const running = tenants.list(null, later.signal);
      later.abort();
      expect(await running).toEqual({ kind: 'aborted' });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  it('sends each command through the session with exactly its contract fields, and maps what the session reports', async () => {
    const command = vi.fn<(request: { path: string; body: unknown; idempotencyKey: string }) => Promise<unknown>>();
    const tenants = createTenantManagementClient({ session: { command: command as never }, fetch: vi.fn() as never });
    const key = crypto.randomUUID();
    command.mockResolvedValueOnce({ kind: 'response', status: 200, body: { tenantId: T1, displayName: 'Acme', version: 4 } });
    expect(await tenants.rename({ ...NAME, extra: 'dropped' } as typeof NAME, key)).toEqual({ kind: 'applied', tenant: { tenantId: T1, displayName: 'Acme', version: 4 } });
    expect(command.mock.calls[0][0]).toStrictEqual({ path: DISPLAY_NAME_PATH, body: NAME, idempotencyKey: key });
    const statusRequest = { tenantId: T1, status: 'suspended' as const, reason: 'Chargeback fraud under review', expectedVersion: 3 };
    command.mockResolvedValueOnce({ kind: 'no-session' });
    expect(await tenants.changeStatus(statusRequest, key)).toEqual({ kind: 'expired' });
    expect(command.mock.calls[1][0]).toStrictEqual({ path: STATUS_PATH, body: statusRequest, idempotencyKey: key });
    command.mockResolvedValueOnce({ kind: 'failed' });
    expect(await tenants.changeStatus(statusRequest, key)).toEqual({ kind: 'uncertain' });
    command.mockRejectedValueOnce(new TypeError('command request invalid'));
    expect(await tenants.rename(NAME, 'not-a-key')).toEqual({ kind: 'uncertain' });
  });
});

describe('the session client command', () => {
  function sessionOver(first: 'active' | number, reply: Reply = ok({ tenantId: T1, displayName: 'Acme', version: 4 })) {
    const sent: Sent[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      sent.push({ method: init.method ?? 'GET', url, headers: new Headers(init.headers), body: init.body, init });
      if (url === '/admin/v1/session') return first === 'active' ? json(200, { status: 'active', csrfToken: CSRF }) : json(first, { error: 'refused' });
      return reply();
    });
    return { sent, fetch, client: createAdminSessionClient({ fetch: fetch as unknown as typeof globalThis.fetch }) };
  }
  const body = { tenantId: T1, displayName: 'Acme', expectedVersion: 3 };

  it('sends a PATCH with the intent header, the session CSRF token and the key, credentials included, and returns the answer', async () => {
    const { client, sent } = sessionOver('active');
    await client.bootstrap();
    const key = crypto.randomUUID();
    const result = await client.command({ path: COMMAND_PATHS[0], body, idempotencyKey: key });
    expect(result).toEqual({ kind: 'response', status: 200, body: { tenantId: T1, displayName: 'Acme', version: 4 } });
    expect(Object.isFrozen(result)).toBe(true);
    const request = sent[1];
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('/admin/v1/tenants/display-name');
    expect(request.headers.get('x-tmpos-csrf')).toBe('1');
    expect(request.headers.get('x-tmpos-session-csrf')).toBe(CSRF);
    expect(request.headers.get('idempotency-key')).toBe(key);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.init).toMatchObject({ credentials: 'include', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(request.body as string)).toStrictEqual(body);
    expect(COMMAND_PATHS).toEqual(['/admin/v1/tenants/display-name', '/admin/v1/tenants/status']);
  });

  it('keeps the status of a non-JSON or oversized answer but not its body', async () => {
    for (const reply of [
      () => new Response('<html>busy</html>', { status: 503, headers: { 'content-type': 'text/html' } }),
      () => json(502, { error: 'x'.repeat(16_384) }),
    ]) {
      const { client } = sessionOver('active', reply);
      await client.bootstrap();
      const result = await client.command({ path: COMMAND_PATHS[1], body, idempotencyKey: crypto.randomUUID() });
      expect(result).toMatchObject({ kind: 'response' });
      expect((result as { body: unknown }).body).toBeUndefined();
    }
  });

  it('drops a command answer that arrives after the session was replaced, and aborts it', async () => {
    const reply = held();
    const { client, sent } = sessionOver('active', reply.reply);
    await client.bootstrap();
    const pending = client.command({ path: COMMAND_PATHS[0], body, idempotencyKey: crypto.randomUUID() });
    client.expire();
    await reply.settle(json(401, { error: 'unauthenticated' }));
    expect(await pending).toEqual({ kind: 'failed' }); // never the old session's 401, which would end the next session
    expect(sent[1].init.signal?.aborted).toBe(true);
  });

  it('reports a lost connection as failed', async () => {
    const { client } = sessionOver('active', lost);
    await client.bootstrap();
    expect(await client.command({ path: COMMAND_PATHS[0], body, idempotencyKey: crypto.randomUUID() })).toEqual({ kind: 'failed' });
  });

  it('sends nothing without an active session', async () => {
    const before = sessionOver('active');
    expect(await before.client.command({ path: COMMAND_PATHS[0], body, idempotencyKey: crypto.randomUUID() })).toEqual({ kind: 'no-session' });
    expect(before.fetch).not.toHaveBeenCalled();
    const refused = sessionOver(401);
    await refused.client.bootstrap();
    expect(await refused.client.command({ path: COMMAND_PATHS[0], body, idempotencyKey: crypto.randomUUID() })).toEqual({ kind: 'no-session' });
    const expired = sessionOver('active');
    await expired.client.bootstrap();
    expired.client.expire();
    expect(await expired.client.command({ path: COMMAND_PATHS[0], body, idempotencyKey: crypto.randomUUID() })).toEqual({ kind: 'no-session' });
    for (const harness of [refused, expired]) expect(harness.sent.map((request) => request.method)).toEqual(['GET']);
  });

  it('refuses any other path or a key that is not a lowercase v4 UUID, sending nothing', async () => {
    const { client, fetch } = sessionOver('active');
    await client.bootstrap();
    const key = crypto.randomUUID();
    for (const path of ['/admin/v1/tenants', '/admin/v1/session/logout', '/admin/v1/tenants/display-name/', '/admin/v1/tenants/status?x=1', '/api/v1/tenants/status', '/admin/v1/stores/status']) {
      await expect(client.command({ path, body, idempotencyKey: key })).rejects.toThrow(TypeError);
    }
    for (const idempotencyKey of ['', 'not-a-key', key.toUpperCase(), '00000000-0000-1000-8000-000000000000', `${key} `]) {
      await expect(client.command({ path: COMMAND_PATHS[0], body, idempotencyKey })).rejects.toThrow(TypeError);
    }
    expect(fetch).toHaveBeenCalledTimes(1); // the session read only
  });
});
