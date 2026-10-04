// M5-INVOICES-AUTH-P1 — the shop's server-saved Invoices LEVEL panel in jsdom: the real session and role-levels clients
// (domain 'invoices') over one fake tenant server at the network boundary (synthetic tenants and users only). The fake
// serves both domains from independent per-(tenant, role, domain) rows with versions, so these tests also prove the
// Customers and Invoices panels never affect each other. Only the LEVEL is server-backed: nothing here (or in the panel)
// claims that invoices themselves are saved or enforced on the server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../firebase', () => ({ auth: { currentUser: null } }));

import ServerCustomerLevels, { INVOICES_DENIED_NOTE, PREVIOUS_STORE, ServerInvoiceLevels, STORE_CHANGED_NOTICE, type ShopIdentity } from './ServerCustomerLevels';
import { createTenantSessionClient, TENANT_SESSION_PATHS, type TenantSessionClient } from './tenantSessionClient';
import { sessionSubjectOf } from '../../server/runtime/sessions';
import { createRoleLevelsClient, ROLE_LEVELS_PATH, type RoleLevelsClient } from './roleLevelsClient';

const INVOICES_PATH = `${ROLE_LEVELS_PATH}/invoices`;
const CSRF = 's'.repeat(43);
const activeBody = (uid: string) => ({ status: 'active', csrfToken: CSRF, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const DEFAULTS = { manager: 'full', technician: 'view', sales_staff: 'create' } as const;
type Editable = keyof typeof DEFAULTS;
type Domain = 'customers' | 'invoices';
const REASON = 'Sales staff no longer create invoices';
const LABEL: Record<string, string> = { none: 'None', view: 'View Only', create: 'Create', edit: 'Edit', full: 'Full Access' };

type PutPlan = 'ok' | 'commit-then-503' | 'lost-after-commit' | 'step-up' | 'ok-then-switch' | number;
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined }

function fakeServer() {
  const users: Record<string, { uid: string; tenant: string; owner: boolean }> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, owner: true },
    'tok-b': { uid: 'uid-b', tenant: TENANT_B, owner: true },
    'tok-m': { uid: 'uid-m', tenant: TENANT_A, owner: false },
  };
  const stored: Record<Domain, Record<string, Partial<Record<Editable, string>>>> = {
    customers: { [TENANT_A]: { sales_staff: 'view' }, [TENANT_B]: {} },
    invoices: { [TENANT_A]: { technician: 'none' }, [TENANT_B]: { manager: 'edit' } },
  };
  const versions: Record<Domain, Record<string, Partial<Record<Editable, number>>>> = {
    customers: { [TENANT_A]: { sales_staff: 1 }, [TENANT_B]: {} },
    invoices: { [TENANT_A]: { technician: 2 }, [TENANT_B]: { manager: 1 } },
  };
  const versionOf = (d: Domain, tenant: string, roleId: Editable): number => versions[d][tenant][roleId] ?? 0;
  const set = (d: Domain, tenant: string, roleId: Editable, level: string): number => {
    stored[d][tenant][roleId] = level;
    versions[d][tenant][roleId] = versionOf(d, tenant, roleId) + 1;
    return versionOf(d, tenant, roleId);
  };
  function levelsOf(d: Domain, tenant: string) {
    const row = (roleId: Editable) => {
      const s = stored[d][tenant][roleId];
      return { roleId, level: s ?? DEFAULTS[roleId], defaultLevel: DEFAULTS[roleId], source: s === undefined ? 'default' : 'stored', editable: true, version: versionOf(d, tenant, roleId) };
    };
    return {
      tenant, domain: d,
      roles: [{ roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null }, row('manager'), row('technician'), row('sales_staff')],
    };
  }
  const server = {
    sent: [] as Sent[],
    session: null as null | { uid: string; tenant: string; owner: boolean },
    puts: [] as PutPlan[],
    held: [] as Array<{ resolve: () => void }>,
    holdReads: 0,
    down: false,
    loginStatus: null as null | number, // a login answers this status instead (429 carries Retry-After)
    badInvoiceRead: null as null | ((body: ReturnType<typeof levelsOf>) => unknown),
    done: new Map<string, { roleId: string; level: string; version: number; domain: string }>(),
    stored, versions, users, set,
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const method = init.method ?? 'GET';
      const url = String(input);
      const headers = new Headers(init.headers);
      server.sent.push({ method, url, headers, body: typeof init.body === 'string' ? init.body : undefined });
      if (server.down) throw new TypeError('network');
      const reply = (status: number, body?: unknown, extra: Record<string, string> = {}): Response =>
        new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? extra : { 'content-type': 'application/json', ...extra } });
      if (method === 'POST' && url === TENANT_SESSION_PATHS.login) {
        if (server.loginStatus === 429) return reply(429, { error: 'rate_limited' }, { 'retry-after': '7' });
        const user = users[(headers.get('authorization') ?? '').replace(/^Bearer /, '')];
        if (user === undefined) return reply(401, { error: 'unauthenticated' });
        server.session = user;
        return reply(200, activeBody(user.uid));
      }
      if (method === 'GET' && url === TENANT_SESSION_PATHS.current) {
        return server.session === null ? reply(401, { error: 'unauthenticated' }) : reply(200, activeBody(server.session.uid));
      }
      if (url !== ROLE_LEVELS_PATH && url !== INVOICES_PATH) return reply(404, { error: 'not_found' });
      if (server.session === null) return reply(401, { error: 'unauthenticated' });
      let session = server.session;
      if (!session.owner) return reply(403, { error: 'forbidden' });
      if (method === 'GET') {
        const d: Domain = url === INVOICES_PATH ? 'invoices' : 'customers';
        const body = levelsOf(d, session.tenant);
        if (server.holdReads > 0 && d === 'invoices') {
          server.holdReads -= 1;
          await new Promise<void>((resolve) => server.held.push({ resolve }));
        }
        return reply(200, d === 'invoices' && server.badInvoiceRead !== null ? server.badInvoiceRead(body) : body);
      }
      const change = JSON.parse(String(init.body)) as { roleId: Editable; domain: Domain; level: string; expectedTenant: string; expectedVersion: number };
      const key = headers.get('idempotency-key') ?? '';
      const executed = server.done.get(key);
      if (executed !== undefined) return reply(200, { roleLevel: { roleId: executed.roleId, domain: executed.domain, level: executed.level, version: executed.version } });
      const plan = server.puts.shift() ?? 'ok';
      if (typeof plan === 'number') return reply(plan, { error: plan === 403 ? 'forbidden' : 'refused' });
      if (plan === 'step-up') return reply(403, { error: 'step_up_required', requestId: 'r' });
      if (change.expectedTenant !== session.tenant || change.expectedVersion !== versionOf(change.domain, session.tenant, change.roleId)) {
        return reply(409, { error: 'write_conflict', requestId: 'r' });
      }
      const version = set(change.domain, session.tenant, change.roleId, change.level);
      server.done.set(key, { roleId: change.roleId, level: change.level, version, domain: change.domain });
      if (plan === 'lost-after-commit') throw new TypeError('network');
      if (plan === 'commit-then-503') return reply(503, { error: 'service_unavailable' });
      if (plan === 'ok-then-switch') server.session = { ...users['tok-b'], uid: session.uid };
      return reply(200, { roleLevel: { roleId: change.roleId, domain: change.domain, level: change.level, version } });
    }) as typeof globalThis.fetch,
  };
  return server;
}
type Server = ReturnType<typeof fakeServer>;

function identityFor(tokens: Record<string, string>, reauth: { method: 'password' | 'google' | null; token: string | null } = { method: 'password', token: null }) {
  const identity: ShopIdentity = {
    idToken: async (uid) => tokens[uid] ?? null,
    reauthMethod: () => reauth.method,
    reauthenticate: async () => reauth.token,
  };
  return identity;
}
const A_ONLY = identityFor({ 'uid-a': 'tok-a' });

function mount(uid: string | null, server: Server, identity: ShopIdentity = A_ONLY, keys: string[] = [], both = false) {
  let n = 0;
  const newKey = () => keys[n++] ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const session: TenantSessionClient = createTenantSessionClient({ fetch: server.fetch });
  const inv: RoleLevelsClient = createRoleLevelsClient({ fetch: server.fetch, domain: 'invoices' });
  const cus: RoleLevelsClient = createRoleLevelsClient({ fetch: server.fetch });
  const tree = (u: string | null) => (
    <>
      <ServerInvoiceLevels uid={u} session={session} levels={inv} identity={identity} newKey={newKey} />
      {both && <ServerCustomerLevels uid={u} session={session} levels={cus} identity={identity} newKey={newKey} />}
    </>
  );
  const view = render(tree(uid));
  return { ...view, again: (next: string | null) => view.rerender(tree(next)), session };
}

const state = () => screen.getByTestId('server-invoice-levels-state');
const ready = () => waitFor(() => expect(state()).toHaveTextContent('Ready'));
const status = (roleId: Editable) => screen.getByTestId(`server-invoice-level-status-${roleId}`);
const row = (roleId: string) => screen.getByTestId(`server-invoice-level-row-${roleId}`);
const puts = (server: Server) => server.sent.filter((r) => r.method === 'PUT');
const logins = (server: Server) => server.sent.filter((r) => r.method === 'POST' && r.url === TENANT_SESSION_PATHS.login).length;
const invoiceReads = (server: Server) => server.sent.filter((r) => r.method === 'GET' && r.url === INVOICES_PATH).length;
const focusRefresh = async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
};
const click = async (testId: string) => { await userEvent.setup().click(screen.getByTestId(testId)); };
const conflictText = (level: string) => `Changed elsewhere — the server now has ${LABEL[level]}. Your change is not saved.`;

async function edit(roleId: Editable, level: string, reason = REASON, prefix = 'server-invoice-level') {
  const user = userEvent.setup();
  await user.selectOptions(screen.getByTestId(`${prefix}-select-${roleId}`), level);
  await user.clear(screen.getByTestId(`${prefix}-reason-${roleId}`));
  await user.type(screen.getByTestId(`${prefix}-reason-${roleId}`), reason);
  await user.click(screen.getByTestId(`${prefix}-save-${roleId}`));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ServerInvoiceLevels (M5-INVOICES-AUTH-P1)', () => {
  it('SIL-01. an owner sees the Invoices levels: fixed owner, defaults, a stored override; copy says level only, ids are Invoices-prefixed', async () => {
    const server = fakeServer();
    mount('uid-a', server);
    await ready();
    expect(row('store_owner')).toHaveTextContent('Full — fixed');
    expect(row('manager')).toHaveTextContent('Full Access');
    expect(row('manager')).toHaveTextContent('Default');
    expect(row('technician')).toHaveTextContent('None'); // Invoices' own stored row, not Customers'
    expect(row('technician')).toHaveTextContent('Custom');
    expect(row('sales_staff')).toHaveTextContent('Create');
    expect(row('sales_staff')).toHaveTextContent('Default');
    const section = screen.getByTestId('server-invoice-levels');
    expect(within(section).getByRole('heading', { name: 'Server-saved Invoices level' })).toBeInTheDocument();
    expect(section).toHaveTextContent('Saved on the store server: only the Invoices level of the built-in roles');
    expect(section).toHaveTextContent('Invoices themselves are still saved in this browser');
    expect(section).toHaveTextContent('not enforced by the server');
    expect(section.textContent).not.toMatch(/Customers/);
    expect(invoiceReads(server)).toBe(1);
    expect(server.sent.some((r) => r.url === ROLE_LEVELS_PATH && r.method === 'GET')).toBe(false); // never the Customers read
    expect(document.getElementById('server-level-select-manager')).toBeNull(); // no Customers ids
    expect(screen.getByTestId('server-invoice-level-save-technician')).toBeDisabled();
  });

  it('SIL-02. Saved only after the PUT 200 and a read-back; the exact six-field Invoices body under one key', async () => {
    const server = fakeServer();
    mount('uid-a', server, A_ONLY, ['11111111-1111-4111-8111-111111111111']);
    await ready();
    const before = invoiceReads(server);
    server.holdReads = 1; // the read-back after the PUT is held: the PUT has answered 200, and the row must not say Saved yet
    await edit('sales_staff', 'view');
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(puts(server)).toHaveLength(1);
    expect(server.stored.invoices[TENANT_A].sales_staff).toBe('view'); // committed on the server
    expect(status('sales_staff')).toHaveAttribute('data-status', 'saving');
    expect(status('sales_staff').textContent).toBe('Saving to the server…');
    await act(async () => { server.held[0].resolve(); });
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(invoiceReads(server)).toBe(before + 1); // the read-back
    expect(server.stored.invoices[TENANT_A].sales_staff).toBe('view');
    expect(server.stored.customers[TENANT_A].sales_staff).toBe('view'); // Customers' own stored value was already View; its version did not move
    expect(server.versions.customers[TENANT_A].sales_staff).toBe(1);
    const [put] = puts(server);
    expect(put.url).toBe(ROLE_LEVELS_PATH);
    expect(put.headers.get('idempotency-key')).toBe('11111111-1111-4111-8111-111111111111');
    expect(put.body).toBe(`{"roleId":"sales_staff","domain":"invoices","level":"view","reason":"${REASON}","expectedTenant":"${TENANT_A}","expectedVersion":0}`);
    expect(row('sales_staff')).toHaveTextContent('Custom');
  });

  it('SIL-03. a competing edit: 409 write_conflict writes nothing, shows the server level, needs Discard/Reapply and then a NEW key', async () => {
    const server = fakeServer();
    mount('uid-a', server, A_ONLY, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    await ready();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('server-invoice-level-select-manager'), 'view');
    await user.type(screen.getByTestId('server-invoice-level-reason-manager'), 'Managers only view invoices');
    server.set('invoices', TENANT_A, 'manager', 'edit'); // a second session changes it first
    await user.click(screen.getByTestId('server-invoice-level-save-manager'));
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'conflict'));
    expect(status('manager').textContent).toBe(conflictText('edit'));
    expect(server.stored.invoices[TENANT_A].manager).toBe('edit'); // nothing written by this save
    expect(row('manager')).toHaveTextContent('Server level: Edit'); // the shown value is the server's, not the draft
    expect(screen.getByTestId('server-invoice-level-select-manager')).toBeDisabled();
    expect(screen.getByTestId('server-invoice-level-save-manager')).toBeDisabled();
    expect(puts(server)).toHaveLength(1);
    await click('server-invoice-level-reapply-manager'); // explicit review: rebased onto the version just read
    await click('server-invoice-level-save-manager');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    expect(JSON.parse(puts(server)[1].body ?? '{}')).toMatchObject({ domain: 'invoices', level: 'view', expectedVersion: 1 });
  });

  it('SIL-04. an unknown outcome is held: Save again sends the same key and the same bytes; then Saved', async () => {
    const server = fakeServer();
    server.puts.push('commit-then-503');
    mount('uid-a', server, A_ONLY, ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
    await ready();
    await edit('technician', 'view', 'Technicians view invoices again');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    expect(status('technician')).not.toHaveTextContent('Saved');
    expect(status('technician')).not.toHaveTextContent('Not saved');
    await click('server-invoice-level-save-technician');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server)).toHaveLength(2);
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual(['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
    expect(puts(server)[1].body).toBe(puts(server)[0].body);
    expect(server.versions.invoices[TENANT_A].technician).toBe(3); // executed once
  });

  it('SIL-05. a lost answer is never retried automatically: the row is held, and Save re-sends the identical bytes under the same key', async () => {
    const server = fakeServer();
    server.puts.push('lost-after-commit');
    mount('uid-a', server, A_ONLY, ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
    await ready();
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm'));
    expect(status('sales_staff').textContent).toBe('Not confirmed yet — press Save again to check. The server has None.');
    expect(puts(server)).toHaveLength(1);
    await click('server-invoice-level-save-sales_staff');
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(puts(server)).toHaveLength(2);
    expect(puts(server)[1].body).toBe(puts(server)[0].body);
    expect(new Set(puts(server).map((r) => r.headers.get('idempotency-key'))).size).toBe(1);
  });

  it('SIL-06. a non-owner is denied: the denial note, no rows, no editing', async () => {
    const server = fakeServer();
    mount('uid-m', server, identityFor({ 'uid-m': 'tok-m' }));
    await waitFor(() => expect(state()).toHaveTextContent('Denied'));
    expect(screen.getByRole('status')).toHaveTextContent(INVOICES_DENIED_NOTE);
    expect(INVOICES_DENIED_NOTE).toMatch(/Invoices level/);
    expect(screen.queryByTestId('server-invoice-level-row-manager')).toBeNull();
    expect(puts(server)).toHaveLength(0);
  });

  it('SIL-07. an outage is unavailable (nothing changed) and Try again recovers', async () => {
    const server = fakeServer();
    server.down = true;
    mount('uid-a', server);
    await waitFor(() => expect(state()).toHaveTextContent('Unavailable'));
    expect(screen.getByRole('status')).toHaveTextContent('The store server could not be reached. Nothing was changed.');
    expect(screen.queryByTestId('server-invoice-level-row-manager')).toBeNull();
    server.down = false;
    await click('server-invoice-levels-retry');
    // The button unmounts while the panel reloads; keyboard focus lands on the panel heading, never the page body.
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('server-invoice-levels-title')));
    await ready();
    expect(document.activeElement).toBe(document.getElementById('server-invoice-levels-title'));
  });

  it('SIL-08. a malformed answer is unavailable: never half-rendered (wrong domain, extra key, wrong tenant form)', async () => {
    for (const bad of [
      (b: { tenant: string; domain: string; roles: unknown[] }) => ({ ...b, domain: 'customers' }),
      (b: { tenant: string; domain: string; roles: unknown[] }) => ({ ...b, extra: 1 }),
      (b: { tenant: string; domain: string; roles: unknown[] }) => ({ ...b, tenant: b.tenant.toUpperCase() }),
      (b: { tenant: string; domain: string; roles: unknown[] }) => ({ ...b, roles: b.roles.slice(1) }),
    ]) {
      const server = fakeServer();
      server.badInvoiceRead = bad as Server['badInvoiceRead'];
      mount('uid-a', server);
      await waitFor(() => expect(state()).toHaveTextContent('Unavailable'));
      expect(screen.queryByTestId('server-invoice-level-row-manager')).toBeNull();
      cleanup();
    }
  }, 20_000);

  it('SIL-09. a 429 on the sign-in is unavailable with the wait note, and nothing else is sent', async () => {
    const server = fakeServer();
    server.loginStatus = 429;
    mount('uid-a', server);
    await waitFor(() => expect(state()).toHaveTextContent('Unavailable'));
    expect(screen.getByRole('status')).toHaveTextContent('Too many sign-in attempts. Wait a minute, then try again.');
    expect(invoiceReads(server)).toBe(0);
  });

  it('SIL-10. a read in flight at unmount is cancelled, and its late answer is dropped (no request after it, no error)', async () => {
    // React 19 no longer reports a state update after unmount, so "no error" alone proves nothing: the read's own request
    // signal must be aborted by the unmount, and the answer the fake sends anyway must lead to nothing further.
    const server = fakeServer();
    server.holdReads = 1;
    const signals: Array<AbortSignal | null | undefined> = [];
    const serve = server.fetch;
    server.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === INVOICES_PATH) signals.push(init.signal);
      return serve(input, init);
    }) as typeof globalThis.fetch;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mount('uid-a', server);
    await waitFor(() => expect(server.held).toHaveLength(1));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false); // live while mounted
    view.unmount();
    expect(signals[0]?.aborted).toBe(true); // the unmount cancelled the read at its source
    const sent = server.sent.length;
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(server.sent).toHaveLength(sent); // the late answer started nothing (no login, no re-read)
    expect(errors).not.toHaveBeenCalled();
    expect(screen.queryByTestId('server-invoice-levels')).toBeNull();
  });

  it('SIL-11. a late answer for another user is never shown to the next user (user change)', async () => {
    const server = fakeServer();
    server.holdReads = 1;
    const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }));
    await waitFor(() => expect(server.held).toHaveLength(1)); // uid-a's read (tenant A) is in flight
    server.session = { ...server.users['tok-b'] }; // the server session now belongs to uid-b
    view.again('uid-b');
    await ready();
    expect(row('manager')).toHaveTextContent('Edit'); // tenant B's stored Invoices level
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(row('manager')).toHaveTextContent('Edit');
    expect(row('technician')).toHaveTextContent('View Only'); // not tenant A's stored None
  });

  it('SIL-12. a tenant switch: drafts are cleared, the store-changed notice shows, and a save sent before it is only a detached notice', async () => {
    const server = fakeServer();
    server.puts.push('ok-then-switch');
    mount('uid-a', server, A_ONLY, ['ffffffff-ffff-4fff-8fff-ffffffffffff']);
    await ready();
    await edit('sales_staff', 'none');
    await waitFor(() => expect(screen.getByTestId('server-invoice-levels-store-changed')).toHaveTextContent(STORE_CHANGED_NOTICE));
    expect(screen.getByTestId('server-invoice-levels-previous-store')).toHaveTextContent(PREVIOUS_STORE.acknowledged);
    await ready();
    expect(row('manager')).toHaveTextContent('Edit'); // tenant B's value
    expect(status('sales_staff')).not.toHaveTextContent('Saved');
    expect(screen.queryByTestId('server-invoice-level-unsaved-sales_staff')).toBeNull();
    expect(puts(server)).toHaveLength(1); // nothing was sent to the new store
  });

  it('SIL-13. a confirmed session end: Save sends nothing, no automatic login; only Reconnect logs in again', async () => {
    const server = fakeServer();
    mount('uid-a', server);
    await ready();
    expect(logins(server)).toBe(1);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('server-invoice-level-select-manager'), 'view');
    await user.type(screen.getByTestId('server-invoice-level-reason-manager'), 'Managers only view invoices');
    server.session = null; // the server ended the session
    await user.click(screen.getByTestId('server-invoice-level-save-manager'));
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'signed-out'));
    expect(status('manager')).toHaveTextContent('Not saved: your server session ended. Reconnect, then save again.');
    expect(puts(server)).toHaveLength(0);
    expect(logins(server)).toBe(1); // no automatic reconnect
    await focusRefresh();
    await waitFor(() => expect(state()).toHaveTextContent('Signed out'));
    expect(screen.getByRole('status')).toHaveTextContent('Your server session ended. Reconnect to see the server-saved Invoices level.');
    expect(logins(server)).toBe(1);
    expect(puts(server)).toHaveLength(0); // no resend either
    await click('server-invoice-levels-retry');
    await ready();
    expect(logins(server)).toBe(2);
    expect(puts(server)).toHaveLength(0); // Reconnect never saves by itself
  });

  it('SIL-14. when the session check is unavailable at Save, nothing is sent and the draft stays', async () => {
    const server = fakeServer();
    mount('uid-a', server);
    await ready();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('server-invoice-level-select-manager'), 'view');
    await user.type(screen.getByTestId('server-invoice-level-reason-manager'), 'Managers only view invoices');
    server.down = true;
    await user.click(screen.getByTestId('server-invoice-level-save-manager'));
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'failed'));
    expect(status('manager')).toHaveTextContent('Not saved: the store server could not be reached. Try again.');
    expect(puts(server)).toHaveLength(0);
    expect(screen.getByTestId('server-invoice-level-select-manager')).toHaveValue('view');
  });

  it('SIL-15. Customers and Invoices are independent: a save in one never changes the other', async () => {
    const server = fakeServer();
    mount('uid-a', server, A_ONLY, [], true);
    await ready();
    await waitFor(() => expect(screen.getByTestId('server-levels-state')).toHaveTextContent('Ready'));
    expect(logins(server)).toBe(1); // one shared tenant session
    expect(screen.getByTestId('server-level-row-manager')).toHaveTextContent('Full Access');
    const customersBefore = JSON.stringify(server.stored.customers);
    await edit('manager', 'none', 'Managers lose invoices for now');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(JSON.stringify(server.stored.customers)).toBe(customersBefore);
    expect(server.versions.customers[TENANT_A].manager).toBeUndefined();
    expect(screen.getByTestId('server-level-row-manager')).toHaveTextContent('Full Access'); // the Customers panel still shows its own
    expect(screen.getByTestId('server-level-status-manager')).toHaveTextContent('');
    const invoicesBefore = JSON.stringify(server.stored.invoices);
    await edit('technician', 'none', 'Technicians lose customers for now', 'server-level');
    await waitFor(() => expect(screen.getByTestId('server-level-status-technician')).toHaveTextContent(/^Saved$/));
    expect(JSON.stringify(server.stored.invoices)).toBe(invoicesBefore);
    expect(puts(server).map((r) => JSON.parse(r.body ?? '{}').domain)).toEqual(['invoices', 'customers']);
    expect(row('manager')).toHaveTextContent('None');
  });

  it('SIL-16. step-up: the recent sign-in prompt uses Invoices ids, renews the session, and a new key is used afterwards', async () => {
    const server = fakeServer();
    server.puts.push('step-up');
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }, { method: 'password', token: 'tok-a' }), ['12121212-1212-4212-8212-121212121212', '34343434-3434-4434-8434-343434343434']);
    await ready();
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'step-up'));
    expect(screen.getByTestId('server-invoice-level-reauth-group')).toBeInTheDocument();
    expect(screen.queryByTestId('server-level-reauth-group')).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your password'), 'pw');
    await user.click(screen.getByTestId('server-invoice-level-reauth-confirm'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent('Signed in again. Press "Save to server" to save this change.'));
    await click('server-invoice-level-save-sales_staff');
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual(['12121212-1212-4212-8212-121212121212', '34343434-3434-4434-8434-343434343434']);
  });

  it('SIL-17. two panels, one session: a Reconnect in one frees the other with no login of its own, and it adopts the renewed tenant', async () => {
    const server = fakeServer();
    mount('uid-a', server, A_ONLY, [], true);
    await ready();
    await waitFor(() => expect(screen.getByTestId('server-levels-state')).toHaveTextContent('Ready'));
    expect(logins(server)).toBe(1);
    server.session = null; // ended on the server; both panels learn it on their next refresh
    server.users['tok-a'] = { uid: 'uid-a', tenant: TENANT_B, owner: true }; // a Reconnect would land on another store
    await focusRefresh();
    await waitFor(() => expect(state()).toHaveTextContent('Signed out'));
    await waitFor(() => expect(screen.getByTestId('server-levels-state')).toHaveTextContent('Signed out'));
    expect(logins(server)).toBe(1); // neither reconnected on its own
    await click('server-invoice-levels-retry'); // only the Invoices panel's Reconnect
    await ready();
    await waitFor(() => expect(screen.getByTestId('server-levels-state')).toHaveTextContent('Ready'));
    expect(logins(server)).toBe(2); // exactly one login for both panels
    expect(screen.getByTestId('server-levels-store-changed')).toBeInTheDocument(); // the Customers panel dropped store A's data
    expect(screen.getByTestId('server-invoice-levels-store-changed')).toBeInTheDocument();
    expect(row('manager')).toHaveTextContent('Edit'); // tenant B's Invoices level
    expect(screen.getByTestId('server-level-row-manager')).toHaveTextContent('Full Access'); // tenant B's Customers level
  });

  it('SIL-18. accessibility: a labelled region, labelled controls, polite status messages, a described Save', async () => {
    const server = fakeServer();
    mount('uid-a', server);
    await ready();
    expect(screen.getByRole('region', { name: 'Server-saved Invoices level' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('New level')).toHaveLength(3);
    expect(screen.getByLabelText(/Reason \(required, 10–500 characters\)/, { selector: '#server-invoice-level-reason-manager' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(status('manager')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('server-invoice-level-save-manager')).toHaveAttribute('aria-describedby', 'server-invoice-level-hint-manager');
    expect(document.getElementById('server-invoice-level-hint-manager')).toHaveTextContent('To save, choose a new level and enter a reason of 10–500 characters.');
    const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('SIL-19. a PUT refused outright (403, or 400) is "Not saved" with its reason: nothing written, no read-back, the draft kept, never Saved', async () => {
    for (const [code, tone, text] of [
      [403, 'denied', 'Not saved: the server refused this change. Only the store owner can change these levels.'],
      [400, 'failed', 'Not saved: the server refused this change. The reason must be 10–500 characters.'],
    ] as const) {
      const server = fakeServer();
      server.puts.push(code);
      mount('uid-a', server);
      await ready();
      const reads = invoiceReads(server);
      await edit('sales_staff', 'view');
      await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', tone));
      expect(status('sales_staff').textContent).toBe(text);
      expect(status('sales_staff')).not.toHaveTextContent(/^Saved$/);
      expect(puts(server)).toHaveLength(1);
      expect(server.stored.invoices[TENANT_A].sales_staff).toBeUndefined(); // nothing written
      expect(invoiceReads(server)).toBe(reads); // a definite refusal is not read back as if it might have saved
      expect(screen.getByTestId('server-invoice-level-select-sales_staff')).toHaveValue('view'); // the draft stays
      expect(screen.getByTestId('server-invoice-level-unsaved-sales_staff')).toBeInTheDocument();
      expect(row('sales_staff')).toHaveTextContent('Default'); // the shown level is still the server's
      cleanup();
    }
  });
});

// M5-INVOICES-AUTH-P1-R1 — the Invoices panel never re-sends a PUT by itself: a PUT with no answer holds the row (draft
// and key kept); only a click on Save sends it again, under the same key with the same bytes.
describe('ServerInvoiceLevels: no automatic PUT resend (M5-INVOICES-AUTH-P1-R1)', () => {
  type Mode = 'before' | 'after';
  // While `lose.on`, every PUT gets no answer: 'before' — it never reaches the server; 'after' — it commits (or replays),
  // then the answer is lost. Installed before mount.
  function losing(server: Server, mode: Mode) {
    const inner = server.fetch;
    const lose = { on: true };
    server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method !== 'PUT' || !lose.on) return inner(input, init);
      if (mode === 'after') await inner(input, init);
      else server.sent.push({ method: 'PUT', url: String(input), headers: new Headers(init.headers), body: String(init.body) });
      throw new TypeError('network');
    }) as typeof globalThis.fetch;
    return lose;
  }
  const K1 = '20202020-2020-4020-8020-202020202020';
  const K2 = '21212121-2121-4121-8121-212121212121';
  const notConfirmed = (level: string) => `Not confirmed yet — press Save again to check. The server has ${LABEL[level]}.`;
  const keysOf = (server: Server) => puts(server).map((r) => r.headers.get('idempotency-key'));
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
  const expireTimers = () => act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  const visible = async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  afterEach(() => { vi.useRealTimers(); });

  it('SIL-20. one Save whose PUT gets no answer sends exactly ONE PUT and holds the row; rerender, focus, visibility and expired timers send none', async () => {
    for (const mode of ['before', 'after'] as const) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const server = fakeServer();
      const lose = losing(server, mode);
      const view = mount('uid-a', server, A_ONLY, [K1, K2]);
      await ready();
      await edit('sales_staff', 'none');
      await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm'));
      await expireTimers();
      await settle();
      expect(keysOf(server)).toEqual([K1]); // AC-01
      expect(status('sales_staff').textContent).toBe(notConfirmed(mode === 'after' ? 'none' : 'create'));
      expect(screen.getByTestId('server-invoice-level-select-sales_staff')).toHaveValue('none');
      expect(screen.getByTestId('server-invoice-level-save-sales_staff')).toBeEnabled();
      lose.on = false; // AC-04
      const reads = invoiceReads(server);
      view.again('uid-a');
      await focusRefresh();
      await settle();
      await visible();
      await expireTimers();
      await settle();
      expect(invoiceReads(server)).toBeGreaterThan(reads);
      expect(keysOf(server)).toEqual([K1]);
      expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm');
      expect(server.stored.invoices[TENANT_A].sales_staff).toBe(mode === 'after' ? 'none' : undefined);
      cleanup();
      vi.useRealTimers();
    }
  }, 30_000);

  it('SIL-21. Save again on a held row sends exactly one more PUT, same key and identical bytes; if that is lost too it stays held until the next click', async () => {
    for (const mode of ['before', 'after'] as const) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const server = fakeServer();
      const lose = losing(server, mode);
      mount('uid-a', server, A_ONLY, [K1, K2]);
      await ready();
      await edit('manager', 'view', 'Managers only view invoices');
      await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
      expect(keysOf(server)).toEqual([K1]);
      await click('server-invoice-level-save-manager');
      await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
      await expireTimers();
      await settle();
      expect(keysOf(server)).toEqual([K1, K1]);
      expect(puts(server)[1].body).toBe(puts(server)[0].body);
      expect(status('manager').textContent).toBe(notConfirmed(mode === 'after' ? 'view' : 'full'));
      lose.on = false;
      await click('server-invoice-level-save-manager');
      await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
      expect(keysOf(server)).toEqual([K1, K1, K1]);
      expect(new Set(puts(server).map((r) => r.body)).size).toBe(1);
      expect(server.versions.invoices[TENANT_A].manager).toBe(1); // executed once
      cleanup();
      vi.useRealTimers();
    }
  }, 30_000);

  it('SIL-22. a PUT 200 whose read-back fails sends no second PUT and never says Saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer();
    const inner = server.fetch;
    let failNextRead = false;
    server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT') { const r = await inner(input, init); failNextRead = true; return r; }
      if (failNextRead && String(input) === INVOICES_PATH) {
        failNextRead = false;
        server.sent.push({ method: 'GET', url: String(input), headers: new Headers(init.headers), body: undefined });
        return new Response(JSON.stringify({ error: 'service_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return inner(input, init);
    }) as typeof globalThis.fetch;
    mount('uid-a', server, A_ONLY, [K1, K2]);
    await ready();
    await edit('sales_staff', 'view');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'failed'));
    await expireTimers();
    await focusRefresh();
    await settle();
    expect(keysOf(server)).toEqual([K1]);
    expect(status('sales_staff')).not.toHaveTextContent(/Saved/);
  });

  it('SIL-23. a PUT refused 401, 403, step-up or 429 (Retry-After) is never re-sent on its own: not after the wait, a refresh or a rerender', async () => {
    const cases: Array<[string, number, Record<string, unknown>, Record<string, string>, string]> = [
      ['401', 401, { error: 'unauthenticated' }, {}, 'signed-out'],
      ['403', 403, { error: 'forbidden' }, {}, 'denied'],
      ['step-up', 403, { error: 'step_up_required', requestId: 'r' }, {}, 'step-up'],
      ['429', 429, { error: 'rate_limited' }, { 'retry-after': '2' }, 'confirm'],
    ];
    for (const [name, code, body, extra, tone] of cases) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const server = fakeServer();
      const inner = server.fetch;
      let refused = false;
      server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (init.method !== 'PUT' || refused) return inner(input, init);
        refused = true;
        server.sent.push({ method: 'PUT', url: String(input), headers: new Headers(init.headers), body: String(init.body) });
        return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', ...extra } });
      }) as typeof globalThis.fetch;
      const view = mount('uid-a', server, A_ONLY, [K1, K2]);
      await ready();
      await edit('sales_staff', 'none');
      await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', tone));
      await expireTimers();
      await focusRefresh();
      await settle();
      view.again('uid-a');
      await expireTimers();
      await settle();
      expect({ name, keys: keysOf(server) }).toEqual({ name, keys: [K1] });
      expect(status('sales_staff')).not.toHaveTextContent(/Saved/);
      cleanup();
      vi.useRealTimers();
    }
  }, 30_000);

  it('SIL-24. a held row is dropped with its user: no PUT on the switch, and the next user sends its own new key', async () => {
    const server = fakeServer();
    const lose = losing(server, 'before');
    const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }), [K1, K2]);
    await ready();
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm'));
    const sentA = puts(server).length;
    lose.on = false;
    view.again('uid-b');
    await ready();
    await settle();
    expect(puts(server)).toHaveLength(sentA);
    expect(screen.queryByTestId('server-invoice-level-unsaved-sales_staff')).toBeNull();
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(puts(server).slice(sentA).map((r) => r.headers.get('idempotency-key'))).toEqual([K2]);
    expect(JSON.parse(puts(server)[sentA].body ?? '{}')).toMatchObject({ domain: 'invoices', expectedTenant: TENANT_B });
  });

  it('SIL-25. a held row stays held through a step-up re-authentication and through a session end and Reconnect: neither re-sends; only Save does, same key and bytes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer();
    const lose = losing(server, 'before');
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }, { method: 'password', token: 'tok-a' }), [K1, K2]);
    await ready();
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm'));
    lose.on = false;
    server.puts.push('step-up');
    await click('server-invoice-level-save-sales_staff');
    await waitFor(() => expect(screen.getByTestId('server-invoice-level-reauth-group')).toBeInTheDocument());
    expect(keysOf(server)).toEqual([K1, K1]);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your password'), 'pw');
    await user.click(screen.getByTestId('server-invoice-level-reauth-confirm'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent('Signed in again'));
    await expireTimers();
    await focusRefresh();
    await settle();
    expect(keysOf(server)).toEqual([K1, K1]);
    expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm');
    await click('server-invoice-level-save-sales_staff');
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(keysOf(server)).toEqual([K1, K1, K1]);
    expect(new Set(puts(server).map((r) => r.body)).size).toBe(1);
    cleanup();

    const ended = fakeServer();
    const off = losing(ended, 'before');
    mount('uid-a', ended, A_ONLY, [K1, K2]);
    await ready();
    await edit('manager', 'view', 'Managers only view invoices');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    off.on = false;
    ended.session = null;
    await focusRefresh();
    await waitFor(() => expect(state()).toHaveTextContent('Signed out'));
    const before = logins(ended);
    await click('server-invoice-levels-retry');
    await ready();
    expect(logins(ended)).toBe(before + 1);
    await expireTimers();
    await focusRefresh();
    await settle();
    expect(keysOf(ended)).toEqual([K1]);
    expect(status('manager')).toHaveAttribute('data-status', 'confirm');
    await click('server-invoice-level-save-manager');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(keysOf(ended)).toEqual([K1, K1]);
    expect(puts(ended)[1].body).toBe(puts(ended)[0].body);
  }, 30_000);
});
