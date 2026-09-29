// M7A-CUSTOMERS-P3-R2 — the shop's server-backed Customers levels panel in jsdom: the real session and role-levels
// clients over one fake tenant server at the network boundary (synthetic tenants and users only). The server decides
// everything; these tests prove the panel says "Saved" only after the server confirmed AND a read-back showed the level,
// and that no late or foreign answer replaces the current user's and tenant's state.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../firebase', () => ({ auth: { currentUser: null } }));

import ServerCustomerLevels, { DENIED_NOTE, DIFFERENT_STORE_NOTICE, REFRESH_FAILED_NOTE, type ShopIdentity } from './ServerCustomerLevels';
import { createTenantSessionClient, TENANT_SESSION_PATHS } from './tenantSessionClient';
import { createRoleLevelsClient, ROLE_LEVELS_PATH, type RoleLevelsClient } from './roleLevelsClient';

const CSRF = 's'.repeat(43);
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const DEFAULTS = { manager: 'full', technician: 'view', sales_staff: 'create' } as const;
type Editable = keyof typeof DEFAULTS;
const REASON = 'Sales staff no longer create customers';

// How the fake server answers the next PUT. `commit-then-*` applies the change and records its key as executed (a later
// PUT under that key replays the 200), then answers otherwise — a 409 while that key is still in progress, a 5xx, or a
// 200 whose body this request cannot name. `ok-then-switch` commits and then hands the browser's session to tenant B.
// `step-up` is the chain's step-up refusal.
type PutPlan =
  | 'ok' | 'lost-after-commit' | 'lost-before-commit' | 'ok-then-other-writer' | 'ok-then-switch'
  | 'commit-then-409' | 'commit-then-503' | 'commit-bad-body' | 'step-up' | number;
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined }

/** One fake tenant server: a login decides the user (and so the tenant) of the session the browser holds. */
function fakeServer() {
  const users: Record<string, { tenant: string; owner: boolean }> = {
    'tok-a': { tenant: TENANT_A, owner: true },
    'tok-b': { tenant: TENANT_B, owner: true },
    'tok-m': { tenant: TENANT_A, owner: false },
  };
  const stored: Record<string, Partial<Record<Editable, string>>> = { [TENANT_A]: { sales_staff: 'view' }, [TENANT_B]: {} };
  const server = {
    sent: [] as Sent[],
    session: null as null | { tenant: string; owner: boolean },
    puts: [] as PutPlan[],
    held: [] as Array<{ resolve: (late?: Response) => void }>, // reads to hold, in order (released with their answer or `late`)
    holdReads: 0,
    heldPuts: [] as Array<{ resolve: () => void }>, // PUTs to hold before they execute, in order
    holdPuts: 0,
    done: new Map<string, { roleId: string; level: string }>(), // executed Idempotency-Keys and what they answered
    down: false, // every request fails with no answer
    stored,
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      server.sent.push({ method, url, headers, body: typeof init.body === 'string' ? init.body : undefined });
      if (server.down) throw new TypeError('network');
      const reply = (status: number, body?: unknown): Response =>
        new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { 'content-type': 'application/json' } });
      if (method === 'POST' && url === TENANT_SESSION_PATHS.login) {
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return reply(401, { error: 'unauthenticated' });
        server.session = user;
        return reply(200, { status: 'active', csrfToken: CSRF });
      }
      if (method === 'GET' && url === TENANT_SESSION_PATHS.current) {
        return server.session === null ? reply(401, { error: 'unauthenticated' }) : reply(200, { status: 'active', csrfToken: CSRF });
      }
      if (method === 'POST' && url === TENANT_SESSION_PATHS.logout) {
        server.session = null;
        return reply(204);
      }
      if (url !== ROLE_LEVELS_PATH || server.session === null) return reply(401, { error: 'unauthenticated' });
      const session = server.session;
      if (!session.owner) return reply(403, { error: 'forbidden' });
      if (method === 'GET') {
        // Snapshot now, answer (maybe) later: a held read is a read of the state when it arrived.
        const body = levelsOf(session.tenant);
        if (server.holdReads > 0) {
          server.holdReads -= 1;
          const late = await new Promise<Response | undefined>((resolve) => server.held.push({ resolve }));
          if (late !== undefined) return late;
        }
        return reply(200, body);
      }
      const change = JSON.parse(String(init.body)) as { roleId: Editable; level: string };
      const key = headers.get('idempotency-key') ?? '';
      const executed = server.done.get(key);
      if (executed !== undefined) return reply(200, { roleLevel: { ...executed, domain: 'customers' } }); // the replay
      if (server.holdPuts > 0) {
        server.holdPuts -= 1;
        await new Promise<void>((resolve) => server.heldPuts.push({ resolve }));
      }
      const plan = server.puts.shift() ?? 'ok';
      if (typeof plan === 'number') return reply(plan, { error: plan === 403 ? 'forbidden' : 'refused' });
      if (plan === 'step-up') return reply(403, { error: 'step_up_required', requestId: 'r' });
      if (plan === 'lost-before-commit') throw new TypeError('network');
      stored[session.tenant][change.roleId] = change.level;
      server.done.set(key, { roleId: change.roleId, level: change.level });
      if (plan === 'lost-after-commit') throw new TypeError('network');
      if (plan === 'commit-then-409') return reply(409, { error: 'request_in_progress' });
      if (plan === 'commit-then-503') return reply(503, { error: 'service_unavailable' });
      if (plan === 'commit-bad-body') return reply(200, { roleLevel: { roleId: change.roleId, domain: 'inventory', level: change.level } });
      if (plan === 'ok-then-other-writer') stored[session.tenant][change.roleId] = 'edit';
      if (plan === 'ok-then-switch') server.session = users['tok-b'];
      return reply(200, { roleLevel: { roleId: change.roleId, domain: 'customers', level: change.level } });
    }) as typeof globalThis.fetch,
  };
  function levelsOf(tenant: string) {
    const row = (roleId: Editable) => {
      const s = stored[tenant][roleId];
      return { roleId, level: s ?? DEFAULTS[roleId], defaultLevel: DEFAULTS[roleId], source: s === undefined ? 'default' : 'stored', editable: true };
    };
    return {
      tenant, domain: 'customers',
      roles: [{ roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false }, row('manager'), row('technician'), row('sales_staff')],
    };
  }
  return server;
}

function identityFor(tokens: Record<string, string>, reauth: { method: 'password' | 'google' | null; token: string | null } = { method: 'password', token: null }) {
  const calls: Array<{ uid: string; password: string | null }> = [];
  const identity: ShopIdentity = {
    idToken: async (uid) => tokens[uid] ?? null,
    reauthMethod: () => reauth.method,
    reauthenticate: async (uid, password) => { calls.push({ uid, password }); return reauth.token; },
  };
  return { identity, calls };
}

function mount(
  uid: string | null, server: ReturnType<typeof fakeServer>, identity: ShopIdentity, keys: string[] = [],
  wrap: (inner: RoleLevelsClient) => RoleLevelsClient = (inner) => inner,
) {
  let n = 0;
  const newKey = () => keys[n++] ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const session = createTenantSessionClient({ fetch: server.fetch });
  const levels = wrap(createRoleLevelsClient({ fetch: server.fetch }));
  const view = render(<ServerCustomerLevels uid={uid} session={session} levels={levels} identity={identity} newKey={newKey} />);
  const again = (next: string | null) =>
    view.rerender(<ServerCustomerLevels uid={next} session={session} levels={levels} identity={identity} newKey={newKey} />);
  return { ...view, again };
}

const state = () => screen.getByTestId('server-levels-state');
const levelReads = (server: ReturnType<typeof fakeServer>) => server.sent.filter((r) => r.method === 'GET' && r.url === ROLE_LEVELS_PATH).length;
const focusRefresh = async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
};
const status = (roleId: Editable) => screen.getByTestId(`server-level-status-${roleId}`);
const row = (roleId: string) => screen.getByTestId(`server-level-row-${roleId}`);
const puts = (server: ReturnType<typeof fakeServer>) => server.sent.filter((r) => r.method === 'PUT');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function edit(roleId: Editable, level: string, reason = REASON) {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByTestId(`server-level-select-${roleId}`), level);
  await user.clear(screen.getByTestId(`server-level-reason-${roleId}`));
  await user.type(screen.getByTestId(`server-level-reason-${roleId}`), reason);
  await user.click(screen.getByTestId(`server-level-save-${roleId}`));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ServerCustomerLevels (M7A-CUSTOMERS-P3-R2)', () => {
  it('SCL-01. an owner sees the server levels: fixed owner, defaults and a stored override', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(state()).toHaveAttribute('data-state', 'ready');
    expect(row('store_owner')).toHaveTextContent('Full — fixed');
    expect(row('manager')).toHaveTextContent('Full Access');
    expect(row('manager')).toHaveTextContent('Default');
    expect(row('sales_staff')).toHaveTextContent('View Only');
    expect(row('sales_staff')).toHaveTextContent('Custom');
    expect(screen.getByLabelText(/New level/, { selector: '#server-level-select-technician' })).toBeInTheDocument();
    expect(screen.getByTestId('server-level-save-technician')).toBeDisabled(); // nothing changed yet
  });

  it('SCL-02. Saved only after the PUT answered and a read-back shows the level; one key per change', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    const reads = () => server.sent.filter((r) => r.method === 'GET' && r.url === ROLE_LEVELS_PATH).length;
    const before = reads();
    await edit('technician', 'none', 'Technicians no longer see customers');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(reads()).toBe(before + 1); // the read-back
    expect(server.stored[TENANT_A].technician).toBe('none');
    expect(row('technician')).toHaveTextContent('Custom');
    const [put] = puts(server);
    expect(put.headers.get('idempotency-key')).toBe('11111111-1111-4111-8111-111111111111');
    expect(put.headers.get('x-tmpos-session-csrf')).toBe(CSRF);
    expect(put.body).toBe('{"roleId":"technician","domain":"customers","level":"none","reason":"Technicians no longer see customers"}');
    await edit('technician', 'view', 'Technicians may view customers again');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server)[1].headers.get('idempotency-key')).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('SCL-03. a PUT answered 200 but the read-back shows another writer: not saved, the server value shown', async () => {
    const server = fakeServer();
    server.puts.push('ok-then-other-writer');
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'view', 'Managers view customers only');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'stale'));
    expect(status('manager')).toHaveTextContent('Changed elsewhere — the server now has Edit');
    expect(status('manager')).not.toHaveTextContent('Saved');
    expect(row('manager')).toHaveTextContent('Server level: Edit');
  });

  it('SCL-04. no answer: one automatic retry of the same payload under the same key; its 200 and the read-back → Saved', async () => {
    const server = fakeServer();
    server.puts.push('lost-after-commit'); // committed, answer lost: the retry is the server's replay of that 200
    const keys = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server)).toHaveLength(2);
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[0]]);
    expect(puts(server)[1].body).toBe(puts(server)[0].body); // the same bytes

    server.puts.push('lost-before-commit'); // never reached the server: the retry executes it once
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(puts(server).slice(2).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[1], keys[1]]);
    expect(server.stored[TENANT_A].manager).toBe('view');
  });

  it('SCL-05. 401, 403, 400, 409, 422 and 503 never say Saved; the draft stays; a 409 keeps the key, any other answer settles it', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'signed-out', 'Not saved: your server session ended. Reconnect, then save again.'],
      [403, 'denied', 'Not saved: the server refused this change. Only the store owner can change these levels.'],
      [400, 'failed', 'Not saved: the server refused this change. The reason must be 10–500 characters.'],
      [409, 'failed', 'Not saved yet: the server is still working on this save and has View Only. Press Save again to check.'],
      [422, 'failed', 'Not saved: the server could not match this attempt. Try again.'],
      [503, 'failed', 'Not saved by this attempt. The server has View Only.'],
    ];
    for (const [code, tone, text] of cases) {
      const server = fakeServer();
      server.puts.push(code);
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      await edit('sales_staff', 'none');
      await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', tone));
      expect(status('sales_staff')).toHaveTextContent(text);
      expect(status('sales_staff')).not.toHaveTextContent('Saved');
      expect(server.stored[TENANT_A].sales_staff).toBe('view');
      expect(screen.getByTestId('server-level-select-sales_staff')).toHaveValue('none');
      if (code !== 401) {
        await userEvent.setup().click(screen.getByTestId('server-level-save-sales_staff'));
        await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
        // A 409 keeps the key (that key is still in progress: pressing Save replays it); any other answer settled it.
        expect(puts(server)[1].headers.get('idempotency-key'))
          .toBe(code === 409 ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
      } else {
        expect(screen.getByTestId('server-levels-retry')).toHaveTextContent('Reconnect');
      }
      cleanup();
    }
  });

  it('SCL-06. step-up: re-authentication with the password, the session renewed, then Save sends a new key', async () => {
    const server = fakeServer();
    const stepUpFetch = server.fetch; // the first PUT answers the chain's step-up refusal; everything else is the server
    let first = true;
    server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT' && first) {
        first = false;
        server.sent.push({ method: 'PUT', url: String(input), headers: new Headers(init.headers), body: String(init.body) });
        return new Response(JSON.stringify({ error: 'step_up_required', requestId: 'r' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      return stepUpFetch(input, init);
    }) as typeof globalThis.fetch;
    const { identity, calls } = identityFor({ 'uid-a': 'tok-a' }, { method: 'password', token: 'tok-a' });
    mount('uid-a', server, identity, ['ffffffff-ffff-4fff-8fff-ffffffffffff', '12121212-1212-4212-8212-121212121212']);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'step-up'));
    expect(status('sales_staff')).toHaveTextContent('Not saved: sign in again to save this change.');
    // AM7: a labelled group whose password field takes focus; Confirm names what is missing.
    const group = screen.getByRole('group', { name: 'Confirm your sign-in to save this change' });
    expect(group).toContainElement(screen.getByTestId('server-level-reauth-password'));
    await waitFor(() => expect(screen.getByTestId('server-level-reauth-password')).toHaveFocus());
    expect(screen.getByTestId('server-level-reauth-confirm')).toBeDisabled();
    expect(screen.getByTestId('server-level-reauth-confirm')).toHaveAccessibleDescription('Enter your password to confirm your sign-in.');
    const user = userEvent.setup();
    await user.type(screen.getByTestId('server-level-reauth-password'), 'synthetic-password');
    await user.click(screen.getByTestId('server-level-reauth-confirm'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent('Signed in again'));
    expect(calls).toEqual([{ uid: 'uid-a', password: 'synthetic-password' }]);
    const reauth = server.sent.filter((r) => r.headers.get('x-tmpos-reauthenticate') === '1');
    expect(reauth).toHaveLength(1);
    expect(reauth[0].headers.get('authorization')).toBe('Bearer tok-a');
    expect(server.stored[TENANT_A].sales_staff).toBe('view'); // nothing saved by the re-authentication
    await user.click(screen.getByTestId('server-level-save-sales_staff'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual(['ffffffff-ffff-4fff-8fff-ffffffffffff', '12121212-1212-4212-8212-121212121212']);
    expect(document.body.textContent).not.toContain('synthetic-password');
  });

  it('SCL-07. a manager sees the server refusal as denied, with no editable server controls', async () => {
    const server = fakeServer();
    mount('uid-m', server, identityFor({ 'uid-m': 'tok-m' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Denied'));
    expect(screen.getByTestId('server-customer-levels')).toHaveTextContent(DENIED_NOTE);
    expect(screen.queryByTestId('server-level-select-sales_staff')).toBeNull();
    expect(puts(server)).toHaveLength(0);
  });

  it('SCL-08. a late tenant-A read after a user switch never replaces tenant B; nothing tenant-A remains', async () => {
    const server = fakeServer();
    server.holdReads = 1;
    const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity);
    await waitFor(() => expect(server.held).toHaveLength(1)); // tenant A's read is in flight
    view.again('uid-b');
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(row('sales_staff')).toHaveTextContent('Server level: Create'); // tenant B: the default
    const requests = server.sent.length;
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(server.sent.length).toBe(requests); // discarded outright: it did not even restart the panel
    expect(row('sales_staff')).toHaveTextContent('Server level: Create');
    expect(row('sales_staff')).not.toHaveTextContent('Server level: View Only'); // tenant A's stored override
    expect(row('sales_staff')).not.toHaveTextContent('Custom');
    expect(server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login).map((r) => r.headers.get('authorization'))).toEqual(['Bearer tok-a', 'Bearer tok-b']);
  });

  it('SCL-09. a read that names another tenant than the first one is discarded and the panel starts over', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await userEvent.setup().selectOptions(screen.getByTestId('server-level-select-manager'), 'view');
    server.session = { tenant: TENANT_B, owner: true }; // the browser's session now answers for another tenant
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: Create'));
    expect(screen.getByTestId('server-level-select-manager')).toHaveValue('full'); // tenant A's draft is gone
  });

  it('SCL-10. sign-out clears the panel; no user sends nothing; an outage is unavailable with a retry', async () => {
    const server = fakeServer();
    const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    view.again(null);
    expect(state()).toHaveTextContent('Signed out');
    expect(screen.queryByTestId('server-level-row-sales_staff')).toBeNull();
    cleanup();

    const quiet = fakeServer();
    mount('uid-x', quiet, identityFor({}).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Signed out'));
    expect(quiet.sent).toHaveLength(0);
    cleanup();

    const down = fakeServer();
    down.fetch = (async () => { throw new TypeError('network'); }) as typeof globalThis.fetch;
    mount('uid-a', down, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Unavailable'));
    expect(screen.getByTestId('server-levels-retry')).toHaveTextContent('Try again');
  });

  it('SCL-11. Save stays disabled for an unchanged level or a reason the server would refuse', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    const user = userEvent.setup();
    const save = screen.getByTestId('server-level-save-technician');
    // AM7: the Save button is described by a visible hint naming what is missing.
    expect(save).toHaveAccessibleDescription('To save, choose a new level and enter a reason of 10–500 characters.');
    await user.selectOptions(screen.getByTestId('server-level-select-technician'), 'none');
    expect(status('technician')).toHaveTextContent('Not saved yet.');
    expect(save).toHaveAccessibleDescription('To save, enter a reason of 10–500 characters.');
    await user.type(screen.getByTestId('server-level-reason-technician'), 'too short');
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId('server-level-reason-technician'), ' — now long enough');
    expect(save).toBeEnabled();
    expect(screen.getByTestId('server-level-hint-technician')).toHaveTextContent(/^$/);
    await user.selectOptions(screen.getByTestId('server-level-select-technician'), 'view');
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('To save, choose a new level.');
    expect(puts(server)).toHaveLength(0);
  });

  it('SCL-12. no answer twice: never Saved; the key is kept, so pressing Save again replays it and confirms', async () => {
    const server = fakeServer();
    server.puts.push('lost-before-commit', 'lost-before-commit'); // nothing reached the server
    const keys = ['13131313-1313-4313-8313-131313131313', '14141414-1414-4414-8414-141414141414'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'failed'));
    expect(status('manager')).toHaveTextContent('Not confirmed: the server did not answer, and it has Full Access. Press Save again to check.');
    expect(screen.getByTestId('server-level-select-manager')).toHaveValue('view'); // the draft stays
    await userEvent.setup().click(screen.getByTestId('server-level-save-manager'));
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[0], keys[0]]);

    // Committed, then no answer to the attempt nor to its retry: the server shows the level, but this save is not
    // confirmed — Save stays usable for the held payload, and its replay confirms it.
    server.puts.push('lost-after-commit');
    const replayed = server.fetch;
    let silenced = 0;
    server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT' && silenced < 2) {
        silenced += 1;
        const answer = replayed(input, init); // reaches the server (the first commits); the answer is lost
        await answer.catch(() => undefined);
        throw new TypeError('network');
      }
      return replayed(input, init);
    }) as typeof globalThis.fetch;
    cleanup();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys.slice(1));
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    expect(status('technician')).toHaveTextContent('The server now has None, but this save is not confirmed yet. Press Save again to confirm.');
    expect(status('technician')).not.toHaveTextContent(/^Saved/);
    expect(row('technician')).toHaveTextContent('Server level: None');
    expect(screen.getByTestId('server-level-save-technician')).toBeEnabled(); // equal to the server's, still confirmable
    await userEvent.setup().click(screen.getByTestId('server-level-save-technician'));
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server).slice(3).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[1], keys[1], keys[1]]);
  });

  it('SCL-13. a 409 whose read-back coincidentally shows the level is not Saved; pressing Save replays the same key → Saved', async () => {
    const server = fakeServer();
    server.puts.push('commit-then-409');
    const keys = ['15151515-1515-4515-8515-151515151515', '16161616-1616-4616-8616-161616161616'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm'));
    expect(status('sales_staff')).toHaveTextContent('The server now has None, but this save is not confirmed yet. Press Save again to confirm.');
    expect(screen.getByTestId('server-level-select-sales_staff')).toHaveValue('none');
    expect(screen.getByTestId('server-level-reason-sales_staff')).toHaveValue(REASON); // the held payload stays
    await userEvent.setup().click(screen.getByTestId('server-level-save-sales_staff'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[0]]);
    expect(puts(server)[1].body).toBe(puts(server)[0].body);
  });

  it('SCL-14. a 5xx or an unnameable 200 whose read-back shows the level is not Saved; the key is settled', async () => {
    for (const plan of ['commit-then-503', 'commit-bad-body'] as const) {
      const server = fakeServer();
      server.puts.push(plan);
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      await edit('technician', 'none');
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'failed'));
      expect(status('technician')).toHaveTextContent('Not saved by this attempt. The server has None — it may have been set elsewhere.');
      expect(row('technician')).toHaveTextContent('Server level: None');
      expect(screen.getByTestId('server-level-save-technician')).toBeDisabled(); // nothing left to change or confirm
      expect(puts(server)).toHaveLength(1);
      cleanup();
    }
  });

  it('SCL-15. step-up failures never save: no confirmation, a thrown provider, a refused renewal; Google and no method', async () => {
    const stepUpFirst = (server: ReturnType<typeof fakeServer>) => {
      const inner = server.fetch;
      let first = true;
      server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (init.method === 'PUT' && first) {
          first = false;
          return new Response(JSON.stringify({ error: 'step_up_required', requestId: 'r' }), { status: 403, headers: { 'content-type': 'application/json' } });
        }
        return inner(input, init);
      }) as typeof globalThis.fetch;
    };
    // The provider does not confirm (null), then throws: the prompt stays and nothing reaches the session.
    const server = fakeServer();
    stepUpFirst(server);
    const outcomes: Array<string | null | Error> = [null, new Error('popup closed')];
    const identity: ShopIdentity = {
      idToken: async () => 'tok-a',
      reauthMethod: () => 'password',
      reauthenticate: async () => { const next = outcomes.shift(); if (next instanceof Error) throw next; return next ?? null; },
    };
    mount('uid-a', server, identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'step-up'));
    const user = userEvent.setup();
    for (let n = 0; n < 2; n += 1) {
      await user.type(screen.getByTestId('server-level-reauth-password'), 'synthetic-password');
      await user.click(screen.getByTestId('server-level-reauth-confirm'));
      await waitFor(() => expect(status('sales_staff')).toHaveTextContent('Not saved: your sign-in was not confirmed. Try again.'));
    }
    expect(server.sent.filter((r) => r.headers.get('x-tmpos-reauthenticate') === '1')).toHaveLength(0);
    expect(server.stored[TENANT_A].sales_staff).toBe('view');
    cleanup();

    // The provider confirms but the server refuses the renewal (unknown token): not saved, prompt kept.
    const refused = fakeServer();
    stepUpFirst(refused);
    mount('uid-a', refused, identityFor({ 'uid-a': 'tok-a' }, { method: 'password', token: 'tok-unknown' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'step-up'));
    await user.type(screen.getByTestId('server-level-reauth-password'), 'synthetic-password');
    await user.click(screen.getByTestId('server-level-reauth-confirm'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent('Not saved: the store server did not confirm your sign-in. Try again.'));
    expect(screen.getByTestId('server-level-reauth-group')).toBeInTheDocument();
    cleanup();

    // Google: the confirm button takes focus and re-authenticates with no password.
    const google = fakeServer();
    stepUpFirst(google);
    const g = identityFor({ 'uid-a': 'tok-a' }, { method: 'google', token: 'tok-a' });
    mount('uid-a', google, g.identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(screen.getByTestId('server-level-reauth-confirm')).toHaveFocus());
    expect(screen.getByTestId('server-level-reauth-confirm')).toHaveTextContent('Sign in with Google again');
    expect(screen.queryByTestId('server-level-reauth-password')).toBeNull();
    await user.click(screen.getByTestId('server-level-reauth-confirm'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent('Signed in again'));
    expect(g.calls).toEqual([{ uid: 'uid-a', password: null }]);
    cleanup();

    // No method available here: an explanation, no control.
    const none = fakeServer();
    stepUpFirst(none);
    mount('uid-a', none, identityFor({ 'uid-a': 'tok-a' }, { method: null, token: null }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(screen.getByTestId('server-level-reauth-group')).toHaveTextContent('Sign out and sign in again, then save this change.'));
    expect(screen.queryByTestId('server-level-reauth-confirm')).toBeNull();
    expect(none.stored[TENANT_A].sales_staff).toBe('view');
  });

  it('SCL-16. a later read that changes a role replaces its former Saved with "Changed elsewhere" and clears an idle note', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    await userEvent.setup().selectOptions(screen.getByTestId('server-level-select-manager'), 'edit');
    expect(status('manager')).toHaveTextContent('Not saved yet.');
    server.stored[TENANT_A].technician = 'edit'; // another tab or person
    server.stored[TENANT_A].manager = 'edit';
    await focusRefresh();
    await waitFor(() => expect(status('technician')).toHaveTextContent('Changed elsewhere — the server now has Edit.'));
    expect(status('technician')).toHaveAttribute('data-status', 'stale');
    expect(status('technician')).not.toHaveTextContent('Saved');
    expect(status('manager')).toHaveTextContent(/^$/);
    expect(row('manager')).toHaveTextContent('Server level: Edit');
    // A read that does not change a role leaves its status alone.
    expect(status('sales_staff')).toHaveTextContent(/^$/);
  });

  it('SCL-17. refreshes wait while a sign-in is pending; a refresh that cannot reach the server keeps the rows', async () => {
    const server = fakeServer();
    const inner = server.fetch;
    let stepUp = true;
    server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT' && stepUp) {
        stepUp = false;
        return new Response(JSON.stringify({ error: 'step_up_required', requestId: 'r' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      return inner(input, init);
    }) as typeof globalThis.fetch;
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(screen.getByTestId('server-level-reauth-group')).toBeInTheDocument());
    const before = server.sent.length;
    await focusRefresh();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(server.sent.length).toBe(before); // nothing read while the prompt is open
    cleanup();

    const flaky = fakeServer();
    mount('uid-a', flaky, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await userEvent.setup().selectOptions(screen.getByTestId('server-level-select-manager'), 'view');
    flaky.down = true;
    await focusRefresh();
    await waitFor(() => expect(screen.getByTestId('server-customer-levels')).toHaveTextContent(REFRESH_FAILED_NOTE));
    expect(state()).toHaveTextContent('Ready');
    expect(row('sales_staff')).toHaveTextContent('Server level: View Only');
    expect(screen.getByTestId('server-level-select-manager')).toHaveValue('view'); // the draft stays too
    flaky.down = false;
    await focusRefresh();
    await waitFor(() => expect(screen.getByTestId('server-customer-levels')).not.toHaveTextContent(REFRESH_FAILED_NOTE));
  });

  it('SCL-18. a late PUT or read-back for the previous user after a user switch changes nothing', async () => {
    const server = fakeServer();
    server.holdPuts = 1;
    const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(server.heldPuts).toHaveLength(1)); // tenant A's PUT is in flight
    view.again('uid-b');
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(row('sales_staff')).toHaveTextContent('Server level: Create');
    const requests = server.sent.length;
    server.session = { tenant: TENANT_A, owner: true }; // even if the late answer could read tenant A again
    await act(async () => { server.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(server.sent.length).toBe(requests); // no read-back: the answer was dropped
    expect(status('sales_staff')).toHaveTextContent(/^$/);
    expect(row('sales_staff')).toHaveTextContent('Server level: Create');
    cleanup();

    const later = fakeServer();
    const again = mount('uid-a', later, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    later.holdReads = 1; // the read-back
    await edit('sales_staff', 'none');
    await waitFor(() => expect(later.held).toHaveLength(1));
    again.again('uid-b');
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await act(async () => { later.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(status('sales_staff')).not.toHaveTextContent('Saved');
    expect(row('sales_staff')).toHaveTextContent('Server level: Create'); // tenant B, not tenant A's None
  });

  it('SCL-19. Reconnect after a 401 logs in again and re-reads, keeping the draft and its reason', async () => {
    const server = fakeServer();
    server.puts.push(401);
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'signed-out'));
    server.session = null; // the server session really ended
    const logins = () => server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login).length;
    const [loginsBefore, readsBefore] = [logins(), levelReads(server)];
    await userEvent.setup().click(screen.getByTestId('server-levels-retry'));
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(logins()).toBe(loginsBefore + 1);
    expect(levelReads(server)).toBe(readsBefore + 1);
    expect(screen.getByTestId('server-level-select-technician')).toHaveValue('none');
    expect(screen.getByTestId('server-level-reason-technician')).toHaveValue(REASON);
    expect(screen.queryByTestId('server-levels-retry')).toBeNull();
    await userEvent.setup().click(screen.getByTestId('server-level-save-technician'));
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
  });

  it('SCL-20. a save whose read-back names another store restarts the panel with a notice; later saves keep it, a user switch clears it', async () => {
    const server = fakeServer();
    server.puts.push('ok-then-switch');
    const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(screen.getByTestId('server-levels-notice')).toHaveTextContent(DIFFERENT_STORE_NOTICE));
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(row('technician')).toHaveTextContent('Server level: View Only'); // tenant B's default, shown fresh
    expect(status('technician')).not.toHaveTextContent('Saved');
    expect(screen.getByTestId('server-levels-notice')).toHaveTextContent(DIFFERENT_STORE_NOTICE); // it survived the restart
    await edit('manager', 'view'); // a later save (here, in the store that answered) does not clear it: only a user switch
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(screen.getByTestId('server-levels-notice')).toHaveTextContent(DIFFERENT_STORE_NOTICE);
    view.again('uid-b');
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(screen.queryByTestId('server-levels-notice')).toBeNull();
  });

  it('SCL-21. a user switch landing after a read-back returned, before the save resumed, leaves the new user untouched', async () => {
    for (const plan of ['ok', 503] as const) {
      const server = fakeServer();
      let trap: (() => void) | null = null;
      // The next read to answer after `trap` is armed queues it while the read-back's own continuation runs: it lands
      // after the read-back returned (and passed its own generation check) and before save() resumes.
      const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity, [], (inner) => ({
        put: inner.put,
        async read(signal) {
          const answer = await inner.read(signal);
          const armed = trap;
          if (armed === null || answer.kind !== 'ok') return answer;
          trap = null;
          let once = true;
          return Object.defineProperty({ ...answer }, 'kind', {
            get: () => { if (once) { once = false; queueMicrotask(armed); } return 'ok' as const; },
          });
        },
      }));
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      server.puts.push(plan);
      server.holdReads = 1; // the read-back
      await edit('technician', 'none');
      await waitFor(() => expect(server.held).toHaveLength(1));
      trap = () => view.again('uid-b');
      server.held[0].resolve(); // outside act: the switch renders synchronously inside that microtask
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      await waitFor(() => expect(row('technician')).toHaveTextContent('Server level: View Only')); // tenant B's default
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(status('technician')).toHaveTextContent(/^$/);
      expect(status('technician')).toHaveAttribute('data-status', 'idle');
      expect(screen.getByTestId('server-level-save-technician')).toBeDisabled();
      expect(server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login).map((r) => r.headers.get('authorization'))).toEqual(['Bearer tok-a', 'Bearer tok-b']);
      cleanup();
    }
  });

  it('SCL-22. one refresh at a time; an older refresh answer arriving after a newer read never demotes or re-notes', async () => {
    for (const late of [403, 503] as const) {
      const server = fakeServer();
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      server.holdReads = 1;
      await focusRefresh();
      await waitFor(() => expect(server.held).toHaveLength(1)); // the first refresh is in flight
      const reads = levelReads(server);
      await focusRefresh(); // a second focus while it is in flight starts nothing
      expect(levelReads(server)).toBe(reads);
      await edit('technician', 'none'); // a newer read: this save's read-back
      await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
      expect(levelReads(server)).toBe(reads + 1);
      await act(async () => {
        server.held[0].resolve(json(late, { error: late === 403 ? 'forbidden' : 'service_unavailable' }));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(state()).toHaveTextContent('Ready');
      const panel = screen.getByTestId('server-customer-levels');
      expect(panel).not.toHaveTextContent(DENIED_NOTE);
      expect(panel).not.toHaveTextContent(REFRESH_FAILED_NOTE);
      expect(status('technician')).toHaveTextContent(/^Saved$/);
      expect(row('technician')).toHaveTextContent('Server level: None');
      await focusRefresh(); // the in-flight flag was cleared: a later focus refreshes again
      await waitFor(() => expect(levelReads(server)).toBe(reads + 2));
      cleanup();
    }
  });

  it('SCL-23. a later read that moves the level under a failed, stale or unconfirmed save says so; the held key still replays', async () => {
    const server = fakeServer();
    server.puts.push(503, 'ok-then-other-writer', 'commit-then-409');
    const keys = ['17171717-1717-4717-8717-171717171717', '18181818-1818-4818-8818-181818181818', '19191919-1919-4919-8919-191919191919'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'failed')); // the server kept Full Access
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'stale')); // another writer: Edit
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm')); // None, unconfirmed
    Object.assign(server.stored[TENANT_A], { manager: 'edit', technician: 'create', sales_staff: 'view' });
    await focusRefresh();
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: View Only'));
    const expected: Array<[Editable, string, string]> = [['manager', 'Edit', 'view'], ['technician', 'Create', 'none'], ['sales_staff', 'View Only', 'none']];
    for (const [roleId, label, draft] of expected) {
      expect(status(roleId)).toHaveAttribute('data-status', 'stale');
      expect(status(roleId).textContent).toBe(`The server now has ${label}. Your change is not saved.`);
      expect(screen.getByTestId(`server-level-select-${roleId}`)).toHaveValue(draft); // the draft stays
    }
    // The confirm hold ended, but its draft, reason and key stay: Save replays the held key (the server answers the
    // replay 200) and the read-back tells the truth.
    expect(screen.getByTestId('server-level-reason-sales_staff')).toHaveValue(REASON);
    await userEvent.setup().click(screen.getByTestId('server-level-save-sales_staff'));
    await waitFor(() => expect(status('sales_staff').textContent).toBe('Changed elsewhere — the server now has View Only. Your change is not saved.'));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[1], keys[2], keys[2]]);
  });

  it('SCL-24. a later read leaves saving, step-up, signed-out and denied statuses alone: they carry an action', async () => {
    const server = fakeServer();
    server.puts.push('step-up', 401, 403);
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'step-up'));
    await edit('manager', 'view'); // a new save closes the sign-in prompt
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'signed-out'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'denied'));
    const before = (['manager', 'technician', 'sales_staff'] as const).map((id) => [status(id).dataset.status, status(id).textContent]);
    Object.assign(server.stored[TENANT_A], { manager: 'edit', technician: 'create', sales_staff: 'edit' });
    await focusRefresh();
    await waitFor(() => expect(row('manager')).toHaveTextContent('Server level: Edit'));
    expect(row('technician')).toHaveTextContent('Server level: Create');
    expect((['manager', 'technician', 'sales_staff'] as const).map((id) => [status(id).dataset.status, status(id).textContent])).toEqual(before);
    cleanup();

    // Saving: a refresh already in flight when the save starts answers while the PUT is held.
    const busy = fakeServer();
    mount('uid-a', busy, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    busy.stored[TENANT_A].technician = 'edit';
    busy.holdReads = 1;
    await focusRefresh();
    await waitFor(() => expect(busy.held).toHaveLength(1));
    busy.holdPuts = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(busy.heldPuts).toHaveLength(1));
    await act(async () => { busy.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(row('technician')).toHaveTextContent('Server level: Edit'); // the refresh applied
    expect(status('technician')).toHaveAttribute('data-status', 'saving');
    expect(status('technician')).toHaveTextContent('Saving to the server…');
    await act(async () => { busy.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
  });

  it('SCL-25. a refusal on the automatic retry speaks for itself even when the read-back shows the level', async () => {
    const cases: Array<[number, string, string, string]> = [
      [403, 'forbidden', 'denied', 'Not saved: the server refused this change. Only the store owner can change these levels.'],
      [403, 'step_up_required', 'step-up', 'Not saved: sign in again to save this change.'],
      [401, 'unauthenticated', 'signed-out', 'Not saved: your server session ended. Reconnect, then save again.'],
      [400, 'invalid_request', 'failed', 'Not saved: the server refused this change. The reason must be 10–500 characters.'],
      [422, 'idempotency_key_reused', 'failed', 'Not saved: the server could not match this attempt. Try again.'],
      // Only an answer that decides nothing uses the "Not saved by this attempt" wording.
      [503, 'service_unavailable', 'failed', 'Not saved by this attempt. The server has None — it may have been set elsewhere.'],
    ];
    for (const [code, error, tone, text] of cases) {
      const server = fakeServer();
      const inner = server.fetch;
      let attempts = 0;
      server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (init.method !== 'PUT') return inner(input, init);
        attempts += 1;
        if (attempts === 1) {
          await inner(input, init); // committed; the answer is lost
          throw new TypeError('network');
        }
        return json(code, { error, requestId: 'r' }); // the retry is refused before it reaches the replay
      }) as typeof globalThis.fetch;
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      await edit('technician', 'none');
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', tone));
      expect(status('technician').textContent).toBe(text);
      expect(row('technician')).toHaveTextContent('Server level: None'); // the read-back ran and matches the draft
      expect(attempts).toBe(2);
      cleanup();
    }
  });
});
