// M7A-CUSTOMERS-P3-R2 — the shop's server-backed Customers levels panel in jsdom: the real session and role-levels
// clients over one fake tenant server at the network boundary (synthetic tenants and users only). The server decides
// everything; these tests prove the panel says "Saved" only after the server confirmed AND a read-back showed the level,
// and that no late or foreign answer replaces the current user's and tenant's state. M7A-CUSTOMERS-P4: the fake server
// keeps a version per level and refuses a PUT whose asserted tenant or version no longer holds (409 write_conflict,
// nothing written); the panel turns a stale draft into a conflict with Discard/Reapply, never carries a draft across a
// store, and reports a save sent to a store it has left only as a notice about that previous store. M7B-INVOICES-P1:
// both domains' panels side by side, as the Employees screen shows them, each with its own copy (SCL-63).
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../firebase', () => ({ auth: { currentUser: null } }));

import ServerCustomerLevels, { DENIED_NOTE, PREVIOUS_STORE, REFRESH_FAILED_NOTE, STORE_CHANGED_NOTICE, ServerInvoiceLevels, type ShopIdentity } from './ServerCustomerLevels';
import { createTenantSessionClient, TENANT_SESSION_PATHS } from './tenantSessionClient';
import { sessionSubjectOf } from '../../server/runtime/sessions';
import { createRoleLevelsClient, ROLE_LEVELS_PATH, type RoleLevelsClient } from './roleLevelsClient';

const CSRF = 's'.repeat(43);
const activeBody = (uid: string) => ({ status: 'active', csrfToken: CSRF, subject: sessionSubjectOf({ authProvider: 'firebase', authProviderUid: uid }) });
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT_A = uuid(0xa);
const TENANT_B = uuid(0xb);
const DEFAULTS = { manager: 'full', technician: 'view', sales_staff: 'create' } as const;
type Editable = keyof typeof DEFAULTS;
const REASON = 'Sales staff no longer create customers';

// How the fake server answers the next PUT. `commit-then-*` applies the change and records its key as executed (a later
// PUT under that key replays the 200), then answers otherwise — a 409 while that key is still in progress, a 5xx, or a
// 200 whose body this request cannot name. `ok-then-switch` commits and then hands the browser's session to tenant B.
// `step-up` is the chain's step-up refusal; `conflict-sealed` is the sealed `{error:'write_conflict'}` shape, nothing
// written. Every plan that reaches the store first checks the asserted tenant and version (the runtime 409 shape).
// Like the server, the fake fingerprints each key's body on first sight: the same key with other bytes is 422.
type PutPlan =
  | 'ok' | 'lost-after-commit' | 'lost-before-commit' | 'ok-then-other-writer' | 'ok-then-switch'
  | 'commit-then-409' | 'commit-then-503' | 'commit-bad-body' | 'step-up' | 'conflict-sealed' | number;
interface Sent { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string | undefined }

/** One fake tenant server: a login decides the user (and so the tenant) of the session the browser holds. */
function fakeServer() {
  const users: Record<string, { uid: string; tenant: string; owner: boolean }> = {
    'tok-a': { uid: 'uid-a', tenant: TENANT_A, owner: true },
    'tok-b': { uid: 'uid-b', tenant: TENANT_B, owner: true },
    'tok-m': { uid: 'uid-m', tenant: TENANT_A, owner: false },
  };
  const stored: Record<string, Partial<Record<Editable, string>>> = { [TENANT_A]: { sales_staff: 'view' }, [TENANT_B]: {} };
  // A per-row counter: absent ⇒ 0; every effective edit (a restore of the default included) is exactly +1.
  const versions: Record<string, Partial<Record<Editable, number>>> = { [TENANT_A]: { sales_staff: 1 }, [TENANT_B]: {} };
  const versionOf = (tenant: string, roleId: Editable): number => versions[tenant][roleId] ?? 0;
  const set = (tenant: string, roleId: Editable, level: string): number => {
    stored[tenant][roleId] = level;
    versions[tenant][roleId] = versionOf(tenant, roleId) + 1;
    return versionOf(tenant, roleId);
  };
  const server = {
    sent: [] as Sent[],
    session: null as null | { uid: string; tenant: string; owner: boolean },
    puts: [] as PutPlan[],
    held: [] as Array<{ resolve: (late?: Response) => void }>, // reads to hold, in order (released with their answer or `late`)
    holdReads: 0,
    heldPuts: [] as Array<{ resolve: () => void }>, // PUTs to hold before they execute, in order
    holdPuts: 0,
    done: new Map<string, { roleId: string; level: string; version: number }>(), // executed Idempotency-Keys and what they answered
    bodies: new Map<string, string>(), // each Idempotency-Key's body, as first sent
    down: false, // every request fails with no answer
    stored,
    versions,
    set, // another tab or person changes a level (its version moves)
    levelsOf: (tenant: string) => levelsOf(tenant),
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
        return reply(200, activeBody(user.uid));
      }
      if (method === 'GET' && url === TENANT_SESSION_PATHS.current) {
        return server.session === null ? reply(401, { error: 'unauthenticated' }) : reply(200, activeBody(server.session.uid));
      }
      if (method === 'POST' && url === TENANT_SESSION_PATHS.logout) {
        server.session = null;
        return reply(204);
      }
      if (url !== ROLE_LEVELS_PATH || server.session === null) return reply(401, { error: 'unauthenticated' });
      let session = server.session;
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
      const change = JSON.parse(String(init.body)) as { roleId: Editable; level: string; expectedTenant: string; expectedVersion: number };
      const key = headers.get('idempotency-key') ?? '';
      const first = server.bodies.get(key);
      if (first !== undefined && first !== init.body) return reply(422, { error: 'idempotency_key_reused' });
      server.bodies.set(key, String(init.body));
      const executed = server.done.get(key);
      if (executed !== undefined) { // the replay of the sealed 200
        return reply(200, { roleLevel: { roleId: executed.roleId, domain: 'customers', level: executed.level, version: executed.version } });
      }
      if (server.holdPuts > 0) {
        server.holdPuts -= 1;
        await new Promise<void>((resolve) => server.heldPuts.push({ resolve }));
        session = server.session ?? session; // a held request is decided by the session it finally reaches the store with
      }
      const plan = server.puts.shift() ?? 'ok';
      if (typeof plan === 'number') return reply(plan, { error: plan === 403 ? 'forbidden' : plan === 409 ? 'request_in_progress' : 'refused' });
      if (plan === 'step-up') return reply(403, { error: 'step_up_required', requestId: 'r' });
      if (plan === 'lost-before-commit') throw new TypeError('network');
      if (plan === 'conflict-sealed') return reply(409, { error: 'write_conflict' });
      // The preconditions, in the committing transaction: the session's tenant and the row's version, or nothing written.
      if (change.expectedTenant !== session.tenant || change.expectedVersion !== versionOf(session.tenant, change.roleId)) {
        return reply(409, { error: 'write_conflict', requestId: 'r' });
      }
      const version = set(session.tenant, change.roleId, change.level);
      server.done.set(key, { roleId: change.roleId, level: change.level, version });
      if (plan === 'lost-after-commit') throw new TypeError('network');
      if (plan === 'commit-then-409') return reply(409, { error: 'request_in_progress' });
      if (plan === 'commit-then-503') return reply(503, { error: 'service_unavailable' });
      if (plan === 'commit-bad-body') return reply(200, { roleLevel: { roleId: change.roleId, domain: 'inventory', level: change.level, version } });
      if (plan === 'ok-then-other-writer') set(session.tenant, change.roleId, 'edit');
      if (plan === 'ok-then-switch') server.session = { ...users['tok-b'], uid: session.uid }; // the same user's session, now selecting tenant B
      return reply(200, { roleLevel: { roleId: change.roleId, domain: 'customers', level: change.level, version } });
    }) as typeof globalThis.fetch,
  };
  function levelsOf(tenant: string) {
    const row = (roleId: Editable) => {
      const s = stored[tenant][roleId];
      return {
        roleId, level: s ?? DEFAULTS[roleId], defaultLevel: DEFAULTS[roleId], source: s === undefined ? 'default' : 'stored', editable: true,
        version: versionOf(tenant, roleId),
      };
    };
    return {
      tenant, domain: 'customers',
      roles: [{ roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null }, row('manager'), row('technician'), row('sales_staff')],
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
const LABEL: Record<string, string> = { none: 'None', view: 'View Only', create: 'Create', edit: 'Edit', full: 'Full Access' };
const conflictText = (level: string) => `Changed elsewhere — the server now has ${LABEL[level]}. Your change is not saved.`;
const notConfirmed = (level: string) => `Not confirmed yet — press Save again to check. The server has ${LABEL[level]}.`;
const sentBody = (r: Sent) => JSON.parse(r.body ?? 'null') as { expectedTenant: string; expectedVersion: number; level: string };
const click = async (testId: string) => { await userEvent.setup().click(screen.getByTestId(testId)); };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

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
    // The six fields in a fixed order: the tenant and version of the read this draft was made against.
    expect(put.body).toBe(`{"roleId":"technician","domain":"customers","level":"none","reason":"Technicians no longer see customers","expectedTenant":"${TENANT_A}","expectedVersion":0}`);
    await edit('technician', 'view', 'Technicians may view customers again'); // a restore of the default: a new version
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server)[1].headers.get('idempotency-key')).toBe('22222222-2222-4222-8222-222222222222');
    expect(sentBody(puts(server)[1]).expectedVersion).toBe(1);
    expect(server.versions[TENANT_A].technician).toBe(2);
  });

  it('SCL-03. a PUT answered 200 but the read-back shows a later version: "acknowledged, then changed elsewhere", never Saved', async () => {
    const server = fakeServer();
    server.puts.push('ok-then-other-writer');
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'view', 'Managers view customers only');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'stale'));
    expect(status('manager').textContent).toBe('Your change was acknowledged, then changed elsewhere: the server now has Edit.');
    expect(status('manager')).not.toHaveTextContent(/Saved/); // "Saved" only for the exact read-back (R2-1)
    expect(row('manager')).toHaveTextContent('Server level: Edit');
    expect(screen.getByTestId('server-level-select-manager')).toHaveValue('edit'); // the committed draft is gone
    expect(screen.queryByTestId('server-level-unsaved-manager')).toBeNull();
  });

  it('SCL-04. no answer: nothing is re-sent on its own; the row is held, and Save sends the same payload under the same key; its 200 and the read-back → Saved', async () => {
    const server = fakeServer();
    server.puts.push('lost-after-commit'); // committed, answer lost: the explicit Save is the server's replay of that 200
    const keys = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    expect(status('technician').textContent).toBe(notConfirmed('none'));
    expect(puts(server)).toHaveLength(1); // no automatic retry
    await click('server-level-save-technician');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server)).toHaveLength(2);
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[0]]);
    expect(puts(server)[1].body).toBe(puts(server)[0].body); // the same bytes

    server.puts.push('lost-before-commit'); // never reached the server: the explicit Save executes it once
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    expect(status('manager').textContent).toBe(notConfirmed('full'));
    expect(puts(server)).toHaveLength(3);
    await click('server-level-save-manager');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(puts(server).slice(2).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[1], keys[1]]);
    expect(server.stored[TENANT_A].manager).toBe('view');
  });

  it('SCL-05. 401, 403, 400, 409, 422 and 503 never say Saved; the draft stays; a 409 or a 503 keeps the key, any other answer settles it', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'signed-out', 'Not saved: your server session ended. Reconnect, then save again.'],
      [403, 'denied', 'Not saved: the server refused this change. Only the store owner can change these levels.'],
      [400, 'failed', 'Not saved: the server refused this change. The reason must be 10–500 characters.'],
      [409, 'confirm', 'Not confirmed yet — press Save again to check. The server has View Only.'], // request_in_progress
      [422, 'failed', 'Not saved: the server could not match this attempt. Try again.'],
      [503, 'confirm', 'Not confirmed yet — press Save again to check. The server has View Only.'], // undecided: may have committed
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
        // An undecided answer keeps the key (pressing Save replays it or executes it once); any other answer settled it.
        expect(puts(server)[1].headers.get('idempotency-key'))
          .toBe(code === 409 || code === 503 ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
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
    server.session = { uid: 'uid-a', tenant: TENANT_B, owner: true }; // the browser's session now answers for another tenant
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: Create'));
    expect(screen.getByTestId('server-level-select-manager')).toHaveValue('full'); // tenant A's draft is gone
    expect(screen.queryByTestId('server-level-unsaved-manager')).toBeNull();
    expect(screen.getByTestId('server-levels-store-changed')).toHaveTextContent(STORE_CHANGED_NOTICE);
    expect(puts(server)).toHaveLength(0);
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
    // Nobody signed in here: the one thing sent is the session read (a 401); no login, no token, nothing else.
    expect(quiet.sent.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${TENANT_SESSION_PATHS.current}`]);
    expect(quiet.sent[0].headers.get('authorization')).toBeNull();
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
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    expect(status('manager').textContent).toBe(notConfirmed('full'));
    expect(screen.getByTestId('server-level-select-manager')).toHaveValue('view'); // the draft stays
    expect(puts(server)).toHaveLength(1); // no automatic retry
    await userEvent.setup().click(screen.getByTestId('server-level-save-manager')); // lost again: still held
    await waitFor(() => expect(puts(server)).toHaveLength(2));
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    expect(status('manager').textContent).toBe(notConfirmed('full'));
    await userEvent.setup().click(screen.getByTestId('server-level-save-manager'));
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[0], keys[0]]);

    // Committed, then no answer to the attempt nor to its explicit retry: the server shows the level, but this save is
    // not confirmed — Save stays usable for the held payload, and its replay confirms it.
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
    expect(puts(server)).toHaveLength(4);
    await userEvent.setup().click(screen.getByTestId('server-level-save-technician')); // the replay's answer is lost too
    await waitFor(() => expect(puts(server)).toHaveLength(5));
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    expect(status('technician').textContent).toBe(notConfirmed('none'));
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
    expect(status('sales_staff').textContent).toBe(notConfirmed('none'));
    expect(screen.getByTestId('server-level-select-sales_staff')).toHaveValue('none');
    expect(screen.getByTestId('server-level-reason-sales_staff')).toHaveValue(REASON); // the held payload stays
    await userEvent.setup().click(screen.getByTestId('server-level-save-sales_staff'));
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[0]]);
    expect(puts(server)[1].body).toBe(puts(server)[0].body);
  });

  it('SCL-14. a 5xx or an unnameable 200 whose read-back shows the level is not Saved; the key is held and its replay confirms it', async () => {
    for (const plan of ['commit-then-503', 'commit-bad-body'] as const) {
      const server = fakeServer();
      server.puts.push(plan);
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      await edit('technician', 'none');
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
      expect(status('technician').textContent).toBe(notConfirmed('none'));
      expect(row('technician')).toHaveTextContent('Server level: None');
      expect(screen.getByTestId('server-level-save-technician')).toBeEnabled(); // the held payload, still confirmable
      expect(puts(server)).toHaveLength(1);
      await click('server-level-save-technician');
      await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
      expect(puts(server)[1].headers.get('idempotency-key')).toBe(puts(server)[0].headers.get('idempotency-key'));
      expect(puts(server)[1].body).toBe(puts(server)[0].body);
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

  it('SCL-16. a later read that moves a role replaces its former Saved with "Changed elsewhere"; a draft the server now matches is dropped', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    await userEvent.setup().selectOptions(screen.getByTestId('server-level-select-manager'), 'edit');
    expect(status('manager')).toHaveTextContent('Not saved yet.');
    server.set(TENANT_A, 'technician', 'edit'); // another tab or person
    server.set(TENANT_A, 'manager', 'edit');
    await focusRefresh();
    await waitFor(() => expect(status('technician')).toHaveTextContent('Changed elsewhere — the server now has Edit.'));
    expect(status('technician')).toHaveAttribute('data-status', 'stale');
    expect(status('technician')).not.toHaveTextContent('Saved');
    // The manager's unsaved Edit was made at the old version; the server now has Edit from elsewhere: not this tab's save.
    expect(status('manager').textContent).toBe('Changed elsewhere — the server now has Edit.');
    expect(screen.queryByTestId('server-level-unsaved-manager')).toBeNull();
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
    server.session = { uid: 'uid-a', tenant: TENANT_A, owner: true }; // even if the late answer could read tenant A again
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

  it('SCL-20. a save whose read-back names another store is never that store\'s save: a store-changed notice, a previous-store notice; a user switch clears both', async () => {
    const server = fakeServer();
    server.puts.push('ok-then-switch'); // committed on A, then the browser's session is handed to tenant B
    const view = mount('uid-a', server, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(screen.getByTestId('server-levels-store-changed')).toHaveTextContent(STORE_CHANGED_NOTICE));
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(screen.getByTestId('server-levels-previous-store').textContent).toBe(PREVIOUS_STORE.acknowledged);
    expect(row('technician')).toHaveTextContent('Server level: View Only'); // tenant B's default, shown fresh
    expect(status('technician')).toHaveTextContent(/^$/);
    expect([server.stored[TENANT_A].technician, server.stored[TENANT_B].technician]).toEqual(['none', undefined]);
    await edit('manager', 'view'); // a later save in the store that answered keeps both notices: only a user switch clears them
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(sentBody(puts(server)[1]).expectedTenant).toBe(TENANT_B);
    expect(screen.getByTestId('server-levels-store-changed')).toBeInTheDocument();
    expect(screen.getByTestId('server-levels-previous-store')).toBeInTheDocument();
    view.again('uid-b');
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(screen.queryByTestId('server-levels-store-changed')).toBeNull();
    expect(screen.queryByTestId('server-levels-previous-store')).toBeNull();
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

  it('SCL-23. a later read that moves the level under a draft makes it a conflict; a held key stays held and its replay says "acknowledged, then changed elsewhere"', async () => {
    const server = fakeServer();
    server.puts.push(400, 'ok-then-other-writer', 'commit-then-409');
    const keys = ['17171717-1717-4717-8717-171717171717', '18181818-1818-4818-8818-181818181818', '19191919-1919-4919-8919-191919191919'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'failed')); // refused: the server kept Full Access
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'stale')); // saved, then another writer: Edit
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm')); // None at v2, unconfirmed
    server.set(TENANT_A, 'manager', 'edit');
    server.set(TENANT_A, 'technician', 'create');
    server.set(TENANT_A, 'sales_staff', 'view');
    await focusRefresh();
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: View Only'));
    expect(status('manager')).toHaveAttribute('data-status', 'conflict');
    expect(status('manager').textContent).toBe(conflictText('edit'));
    expect(screen.getByTestId('server-level-conflict-manager')).toHaveTextContent('The server now has Edit. Your unsaved choice: View Only.');
    expect(screen.getByTestId('server-level-select-manager')).toHaveValue('view'); // the choice is shown, not sent
    expect(screen.getByTestId('server-level-save-manager')).toBeDisabled();
    expect(status('technician').textContent).toBe('Changed elsewhere — the server now has Create.');
    // The held key's row stays held (A2.6): its draft, reason and key are kept for the confirming replay.
    expect(status('sales_staff')).toHaveAttribute('data-status', 'confirm');
    expect(screen.queryByTestId('server-level-conflict-sales_staff')).toBeNull();
    expect(screen.getByTestId('server-level-reason-sales_staff')).toHaveValue(REASON);
    await click('server-level-save-sales_staff');
    await waitFor(() => expect(status('sales_staff').textContent).toBe('Your change was acknowledged, then changed elsewhere: the server now has View Only.'));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[1], keys[2], keys[2]]);
    expect(puts(server)[3].body).toBe(puts(server)[2].body);
  });

  it('SCL-24. a later read turns every refused draft whose version moved into a conflict; a background refresh never moves a role with a save in flight', async () => {
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
    server.set(TENANT_A, 'manager', 'edit');
    server.set(TENANT_A, 'technician', 'create');
    server.set(TENANT_A, 'sales_staff', 'edit');
    await focusRefresh();
    await waitFor(() => expect(row('manager')).toHaveTextContent('Server level: Edit'));
    for (const [roleId, level] of [['manager', 'edit'], ['technician', 'create'], ['sales_staff', 'edit']] as const) {
      expect(status(roleId)).toHaveAttribute('data-status', 'conflict');
      expect(status(roleId).textContent).toBe(conflictText(level));
      expect(screen.getByTestId(`server-level-conflict-${roleId}`)).toBeInTheDocument();
    }
    cleanup();

    // A refresh already in flight when the save starts answers while the PUT is held: it moves the other roles, never
    // the one being saved. The held PUT then reaches the server at the old version and is refused: nothing written.
    const busy = fakeServer();
    mount('uid-a', busy, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    busy.set(TENANT_A, 'technician', 'edit');
    busy.set(TENANT_A, 'manager', 'view');
    busy.holdReads = 1;
    await focusRefresh();
    await waitFor(() => expect(busy.held).toHaveLength(1));
    busy.holdPuts = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(busy.heldPuts).toHaveLength(1));
    await act(async () => { busy.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(row('manager')).toHaveTextContent('Server level: View Only'); // the refresh applied to the others
    expect(row('technician')).toHaveTextContent('Last known level: View Only'); // not to the role with an attempt in flight
    expect(status('technician')).toHaveAttribute('data-status', 'saving');
    expect(status('technician')).toHaveTextContent('Saving to the server…');
    await act(async () => { busy.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'conflict'));
    expect(status('technician').textContent).toBe(conflictText('edit'));
    expect(busy.stored[TENANT_A].technician).toBe('edit');
    expect(busy.versions[TENANT_A].technician).toBe(1);
  });

  it('SCL-25. a refusal of the explicit retry does not say what the lost first attempt did: the key stays held, never "Not saved"', async () => {
    const cases: Array<[number, string, string, string]> = [
      [403, 'forbidden', 'confirm', 'Not confirmed yet — the server refused the check. Only the store owner can change these levels.'],
      [403, 'step_up_required', 'confirm', 'Not confirmed yet — sign in again, then press Save again to check.'],
      [401, 'unauthenticated', 'confirm', 'Not confirmed yet — your server session ended. Reconnect, then press Save again to check.'],
      [400, 'invalid_request', 'confirm', 'Not confirmed yet — the server could not match the check. Press Save again to check.'],
      [422, 'idempotency_key_reused', 'confirm', 'Not confirmed yet — the server could not match the check. Press Save again to check.'],
      [503, 'service_unavailable', 'confirm', 'Not confirmed yet — press Save again to check. The server has None.'],
    ];
    for (const [code, error, tone, text] of cases) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
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
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
      expect(status('technician').textContent).toBe(notConfirmed('none'));
      expect(attempts).toBe(1); // no automatic retry
      await click('server-level-save-technician'); // the explicit retry
      await waitFor(() => expect(attempts).toBe(2));
      await waitFor(() => expect(status('technician').textContent).toBe(text));
      expect(status('technician')).toHaveAttribute('data-status', tone);
      expect(status('technician').textContent).toBe(text);
      expect(row('technician')).toHaveTextContent('Server level: None'); // the read-back ran and matches the draft
      expect(screen.getByTestId('server-level-save-technician')).toBeEnabled(); // the held key can still be checked
      await act(async () => { await vi.advanceTimersByTimeAsync(600_000); }); // a late automatic PUT would be counted
      for (let i = 0; i < 4; i++) await flush();
      expect(attempts).toBe(2);
      cleanup();
      vi.useRealTimers();
    }
  }, 30_000);
  it('SCL-26. a stale draft is refused in both 409 write_conflict shapes: nothing written, a conflict with the server level and the choice, never Saved', async () => {
    for (const plan of ['ok', 'conflict-sealed'] as const) {
      const server = fakeServer();
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      await userEvent.setup().selectOptions(screen.getByTestId('server-level-select-manager'), 'create');
      expect(screen.getByTestId('server-level-unsaved-manager')).toHaveTextContent('Unsaved: Create');
      expect(row('manager')).toHaveTextContent('Server level: Full Access'); // no optimistic display
      if (plan === 'ok') server.set(TENANT_A, 'manager', 'view'); // another tab: the runtime {error, requestId} refusal
      else server.puts.push(plan); // the sealed {error} shape
      await edit('manager', 'create');
      await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'conflict'));
      const now = plan === 'ok' ? 'view' : 'full';
      expect(status('manager').textContent).toBe(conflictText(now));
      expect(screen.getByTestId('server-level-conflict-manager')).toHaveTextContent(`The server now has ${LABEL[now]}. Your unsaved choice: Create.`);
      expect(screen.getByTestId('server-level-save-manager')).toBeDisabled();
      expect(screen.getByTestId('server-level-select-manager')).toBeDisabled();
      expect(screen.getByTestId('server-level-hint-manager')).toHaveTextContent('To save, discard your choice or reapply it to the current server level.');
      expect(server.stored[TENANT_A].manager).toBe(plan === 'ok' ? 'view' : undefined);
      expect(server.done.size).toBe(0);
      expect(puts(server)).toHaveLength(1); // never resubmitted silently
      cleanup();
    }
  });

  it('SCL-27. conflict → Discard drops the choice and its reason; nothing is sent', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await userEvent.setup().selectOptions(screen.getByTestId('server-level-select-technician'), 'create');
    server.set(TENANT_A, 'technician', 'none');
    await focusRefresh();
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'conflict'));
    await click('server-level-discard-technician');
    expect(screen.queryByTestId('server-level-conflict-technician')).toBeNull();
    expect(screen.queryByTestId('server-level-unsaved-technician')).toBeNull();
    expect(screen.getByTestId('server-level-select-technician')).toHaveValue('none');
    expect(screen.getByTestId('server-level-reason-technician')).toHaveValue('');
    expect(status('technician')).toHaveTextContent(/^$/);
    expect(screen.getByTestId('server-level-save-technician')).toBeDisabled();
    expect(puts(server)).toHaveLength(0);
  });

  it('SCL-28. conflict → Reapply rebases onto the version just read; only an explicit Save sends it, under a new key → Saved', async () => {
    const server = fakeServer();
    const keys = ['20202020-2020-4020-8020-202020202020', '21212121-2121-4121-8121-212121212121'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.set(TENANT_A, 'sales_staff', 'create'); // v2, unseen by this tab
    await edit('sales_staff', 'none'); // asserts v1: refused
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'conflict'));
    await click('server-level-reapply-sales_staff');
    expect(status('sales_staff').textContent).toBe('Reapplied to the current server level. Not saved yet.');
    expect(screen.queryByTestId('server-level-conflict-sales_staff')).toBeNull();
    expect(screen.getByTestId('server-level-select-sales_staff')).toHaveValue('none');
    expect(screen.getByTestId('server-level-reason-sales_staff')).toHaveValue(REASON);
    expect(puts(server)).toHaveLength(1); // Reapply sends nothing
    await click('server-level-save-sales_staff');
    await waitFor(() => expect(status('sales_staff')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual(keys);
    expect(puts(server).map((r) => sentBody(r).expectedVersion)).toEqual([1, 2]);
    expect([server.stored[TENANT_A].sales_staff, server.versions[TENANT_A].sales_staff]).toEqual(['none', 3]);
  });

  it('SCL-29. the session switched to another store before Save: refused, nothing written to either store, the panel clears and says so', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    const before = JSON.stringify([server.stored, server.versions]);
    server.session = { uid: 'uid-a', tenant: TENANT_B, owner: true }; // the same owner's session now selects tenant B
    await edit('technician', 'none');
    await waitFor(() => expect(screen.getByTestId('server-levels-store-changed')).toHaveTextContent(STORE_CHANGED_NOTICE));
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(sentBody(puts(server)[0]).expectedTenant).toBe(TENANT_A);
    expect(JSON.stringify([server.stored, server.versions])).toBe(before); // neither A nor B changed
    expect(screen.getByTestId('server-levels-previous-store').textContent).toBe(PREVIOUS_STORE.notSaved);
    expect(row('sales_staff')).toHaveTextContent('Server level: Create'); // tenant B
    expect(screen.getByTestId('server-level-select-technician')).toHaveValue('view');
    expect(status('technician')).toHaveTextContent(/^$/);
    expect(screen.getByTestId('server-customer-levels')).not.toHaveTextContent('Saved');
  });

  it('SCL-30. a save in flight when the store changes is reported only as a notice about the previous store; its late answer never touches the new rows', async () => {
    for (const variant of ['committed-on-A', 'refused'] as const) {
      const server = fakeServer();
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      // committed-on-A: the PUT executes on A at once and only its answer is late; refused: the PUT reaches the server late.
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, [], (inner) => ({
        read: inner.read,
        async put(...args) { const answer = await inner.put(...args); if (variant === 'committed-on-A') await gate; return answer; },
      }));
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      server.holdReads = 1;
      await focusRefresh(); // a refresh already in flight
      await waitFor(() => expect(server.held).toHaveLength(1));
      if (variant === 'refused') server.holdPuts = 1;
      await edit('technician', 'none');
      if (variant === 'refused') await waitFor(() => expect(server.heldPuts).toHaveLength(1));
      else await waitFor(() => expect(server.stored[TENANT_A].technician).toBe('none'));
      server.session = { uid: 'uid-a', tenant: TENANT_B, owner: true };
      await act(async () => { server.held[0].resolve(json(200, server.levelsOf(TENANT_B))); await new Promise((r) => setTimeout(r, 0)); });
      await waitFor(() => expect(screen.getByTestId('server-levels-store-changed')).toBeInTheDocument());
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      expect(row('technician')).toHaveTextContent('Server level: View Only');
      expect(status('technician')).toHaveAttribute('data-status', 'idle');
      if (variant === 'refused') await act(async () => { server.heldPuts[0].resolve(); });
      else await act(async () => { release!(); });
      await waitFor(() => expect(screen.getByTestId('server-levels-previous-store')).toBeInTheDocument());
      await flush();
      expect(screen.getByTestId('server-levels-previous-store').textContent)
        .toBe(variant === 'committed-on-A' ? PREVIOUS_STORE.acknowledged : PREVIOUS_STORE.notSaved);
      expect(server.stored[TENANT_B].technician).toBeUndefined(); // B untouched either way
      expect(server.stored[TENANT_A].technician).toBe(variant === 'committed-on-A' ? 'none' : undefined);
      expect(status('technician')).toHaveTextContent(/^$/); // the stale attempt's outcome never reached B's row
      expect(row('technician')).toHaveTextContent('Server level: View Only');
      expect(screen.getByTestId('server-level-save-technician')).toBeDisabled();
      cleanup();
    }
  });

  it('SCL-31. no answer, then 409 in progress: the draft and key stay; each Save re-sends the same key and bytes until the 200 → Saved', async () => {
    const server = fakeServer();
    server.puts.push('lost-before-commit', 409);
    const keys = ['22222222-3333-4333-8333-222222222222', '23232323-2323-4323-8323-232323232323'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    expect(status('technician').textContent).toBe(notConfirmed('view'));
    expect(puts(server)).toHaveLength(1); // no automatic retry
    await click('server-level-save-technician'); // the server answers: that key is still in progress
    await waitFor(() => expect(puts(server)).toHaveLength(2));
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    expect(status('technician').textContent).toBe(notConfirmed('view'));
    await click('server-level-save-technician');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(new Set(puts(server).map((r) => r.headers.get('idempotency-key')))).toEqual(new Set([keys[0]]));
    expect(new Set(puts(server).map((r) => r.body)).size).toBe(1);
    expect(puts(server)).toHaveLength(3);
  });

  it('SCL-32. a read showing the requested level at the next version without the 200 stays "Not confirmed", through refreshes', async () => {
    const server = fakeServer();
    server.puts.push('lost-after-commit');
    const inner = server.fetch;
    let silenced = 0;
    server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT' && silenced < 2) {
        silenced += 1;
        await inner(input, init).catch(() => undefined); // the first commits; both answers are lost
        throw new TypeError('network');
      }
      return inner(input, init);
    }) as typeof globalThis.fetch;
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'none');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    expect(silenced).toBe(1); // no automatic retry
    await click('server-level-save-manager'); // the explicit replay's answer is lost too
    await waitFor(() => expect(silenced).toBe(2));
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    expect([server.stored[TENANT_A].manager, server.versions[TENANT_A].manager]).toEqual(['none', 1]); // it did commit
    await focusRefresh();
    await flush();
    expect(status('manager').textContent).toBe(notConfirmed('none'));
    expect(status('manager')).not.toHaveTextContent(/Saved/);
    expect(screen.getByTestId('server-level-unsaved-manager')).toHaveTextContent('Unsaved: None');
    expect(screen.getByTestId('server-level-save-manager')).toBeEnabled();
    await click('server-level-save-manager'); // the replay of the sealed 200 is what confirms it
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
  });

  it('SCL-33. a restore of the default is a new version: a draft read before an edit-and-restore elsewhere cannot succeed (no ABA)', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.set(TENANT_A, 'technician', 'none'); // elsewhere: narrowed...
    server.set(TENANT_A, 'technician', 'view'); // ...then restored to the very level this tab read
    await edit('technician', 'create'); // drafted at v0, the level unchanged since: still refused
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'conflict'));
    expect(status('technician').textContent).toBe(conflictText('view'));
    expect([server.stored[TENANT_A].technician, server.versions[TENANT_A].technician]).toEqual(['view', 2]);
    expect(sentBody(puts(server)[0]).expectedVersion).toBe(0);
    expect(server.done.size).toBe(0);
  });

  it('SCL-34. any undecided answer — a 503, a 200 it cannot name, a lost attempt whose explicit retry answers 503 — holds the key; the confirm replays it at the original version, and Saved waits for the read-back', async () => {
    for (const variant of ['commit-then-503', 'commit-bad-body', 'lost-then-503'] as const) {
      const server = fakeServer();
      const inner = server.fetch;
      let sent = 0;
      if (variant === 'lost-then-503') {
        server.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
          if (init.method !== 'PUT') return inner(input, init);
          sent += 1;
          if (sent === 1) { await inner(input, init); throw new TypeError('network'); } // committed; the answer is lost
          if (sent === 2) { server.sent.push({ method: 'PUT', url: String(input), headers: new Headers(init.headers), body: String(init.body) }); return json(503, { error: 'service_unavailable' }); }
          return inner(input, init);
        }) as typeof globalThis.fetch;
      } else {
        server.puts.push(variant);
      }
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      await edit('technician', 'none');
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
      if (variant === 'lost-then-503') {
        expect(sent).toBe(1); // no automatic retry
        await click('server-level-save-technician'); // the explicit retry answers 503: still undecided
        await waitFor(() => expect(sent).toBe(2));
        await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
      }
      expect(status('technician').textContent).toBe(notConfirmed('none')); // it did commit: the read-back shows v1
      expect(status('technician')).not.toHaveTextContent(/Not saved/);
      expect(screen.getByTestId('server-level-unsaved-technician')).toHaveTextContent('Unsaved: None');
      server.holdReads = 1; // the confirm's read-back
      await click('server-level-save-technician');
      await waitFor(() => expect(server.held).toHaveLength(1));
      expect(status('technician')).toHaveAttribute('data-status', 'saving'); // the 200 alone is not Saved
      await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
      await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
      expect(new Set(puts(server).map((r) => r.headers.get('idempotency-key'))).size).toBe(1);
      expect(puts(server).map((r) => sentBody(r).expectedVersion)).toEqual(puts(server).map(() => 0)); // never rebased
      expect([server.stored[TENANT_A].technician, server.versions[TENANT_A].technician]).toEqual(['none', 1]); // once
      cleanup();
    }
  });

  it('SCL-35. a 409 whose read-back fails: the current level is unknown — no stale "server now has", Reapply off (never onto a cached version); a later read enables it', async () => {
    const server = fakeServer();
    server.puts.push('conflict-sealed');
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.holdReads = 1; // the read-back
    await edit('technician', 'none');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { server.held[0].resolve(json(503, { error: 'service_unavailable' })); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'conflict'));
    expect(status('technician').textContent).toBe('Changed elsewhere — your change is not saved, and the current level could not be read back.');
    const group = screen.getByTestId('server-level-conflict-technician');
    expect(group).toHaveTextContent('The current server level could not be read. Your unsaved choice: None.');
    expect(group).not.toHaveTextContent('The server now has');
    expect(row('technician')).toHaveTextContent('Last known level: View Only'); // not established by a read (R2-5)
    expect(row('technician')).not.toHaveTextContent('Server level:');
    expect(screen.getByTestId('server-level-reapply-technician')).toBeDisabled();
    expect(screen.getByTestId('server-level-discard-technician')).toBeEnabled();
    expect(screen.getByTestId('server-level-hint-technician')).toHaveTextContent('The current server level could not be read. To continue, discard your choice.');
    server.set(TENANT_A, 'technician', 'edit'); // v1
    await focusRefresh();
    await waitFor(() => expect(screen.getByTestId('server-level-conflict-technician')).toHaveTextContent('The server now has Edit. Your unsaved choice: None.'));
    expect(row('technician')).toHaveTextContent('Server level: Edit');
    await click('server-level-reapply-technician');
    await click('server-level-save-technician');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => sentBody(r).expectedVersion)).toEqual([0, 1]); // rebased onto the version read, not v0
  });

  it('SCL-36. a sign-in confirmation never clears a conflict that arrived while its prompt was open', async () => {
    const server = fakeServer();
    server.puts.push('step-up');
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }, { method: 'password', token: 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.set(TENANT_A, 'sales_staff', 'edit'); // v2, unseen by this tab
    server.holdReads = 1;
    await focusRefresh(); // a refresh in flight before the save
    await waitFor(() => expect(server.held).toHaveLength(1));
    await edit('sales_staff', 'none');
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'step-up'));
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); }); // lands during the prompt
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'conflict'));
    const user = userEvent.setup();
    await user.type(screen.getByTestId('server-level-reauth-password'), 'synthetic-password');
    await user.click(screen.getByTestId('server-level-reauth-confirm'));
    await waitFor(() => expect(screen.queryByTestId('server-level-reauth-group')).toBeNull()); // signed in again
    expect(status('sales_staff')).toHaveAttribute('data-status', 'conflict');
    expect(status('sales_staff').textContent).toBe(conflictText('edit'));
    expect(screen.getByTestId('server-level-conflict-sales_staff')).toBeInTheDocument();
    expect(screen.getByTestId('server-level-save-sales_staff')).toBeDisabled();
    expect(puts(server)).toHaveLength(1);
  });

  it('SCL-37. a 409 whose read-back already shows the chosen level says only what the server has, never who changed it', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.set(TENANT_A, 'technician', 'none'); // perhaps this owner's own earlier save
    await edit('technician', 'none'); // drafted at v0
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'stale'));
    expect(status('technician').textContent).toBe('Not saved by this attempt: the server already has None.');
    expect(status('technician')).not.toHaveTextContent(/elsewhere|Saved$/);
    expect(screen.queryByTestId('server-level-unsaved-technician')).toBeNull();
    expect(server.done.size).toBe(0);
  });

  it('SCL-38. a 200 whose read-back shows an older version, or this version with another level, is "Not confirmed: the server shows X"', async () => {
    for (const variant of ['older', 'other-level'] as const) {
      const server = fakeServer();
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      const before = JSON.parse(JSON.stringify(server.levelsOf(TENANT_A))) as ReturnType<typeof server.levelsOf>;
      server.holdReads = 1; // the read-back
      await edit('technician', 'none');
      await waitFor(() => expect(server.held).toHaveLength(1));
      const after = server.levelsOf(TENANT_A);
      after.roles[2] = { ...after.roles[2], level: 'edit' }; // technician at v1, another level
      await act(async () => { server.held[0].resolve(json(200, variant === 'older' ? before : after)); await new Promise((r) => setTimeout(r, 0)); });
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'failed'));
      expect(status('technician').textContent).toBe(`Not confirmed: the server shows ${variant === 'older' ? 'View Only' : 'Edit'}.`);
      expect(status('technician')).not.toHaveTextContent(/Saved/);
      cleanup();
    }
  });

  it('SCL-39. a save whose store connection goes A → B → A while it is out: its answer is a detached acknowledgement naming no store relation', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.holdReads = 1;
    await focusRefresh(); // a refresh in flight before the save
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.holdPuts = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(server.heldPuts).toHaveLength(1));
    server.session = { uid: 'uid-a', tenant: TENANT_B, owner: true }; // → B
    await act(async () => { server.held[0].resolve(json(200, server.levelsOf(TENANT_B))); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: Create'));
    server.session = { uid: 'uid-a', tenant: TENANT_A, owner: true }; // → A again
    await focusRefresh();
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: View Only'));
    await act(async () => { server.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); }); // committed on A
    await waitFor(() => expect(screen.getByTestId('server-levels-previous-store')).toBeInTheDocument());
    await flush();
    const notice = screen.getByTestId('server-levels-previous-store').textContent ?? '';
    expect(notice).toBe(PREVIOUS_STORE.acknowledged);
    expect(notice).not.toMatch(/previous store|saved there/);
    expect(screen.getByTestId('server-levels-store-changed')).toHaveTextContent(STORE_CHANGED_NOTICE);
    // R2-7: says only what it knows — unsent changes cleared, nothing sent to the store now connected — which the
    // acknowledgement of a change sent before the switch cannot contradict.
    expect(STORE_CHANGED_NOTICE).toBe('The store server now answers for a different store. Unsent changes were cleared. No change was sent to the newly connected store.');
    expect(server.stored[TENANT_A].technician).toBe('none');
    expect(status('technician')).toHaveTextContent(/^$/); // never this panel's Saved
  });

  it('SCL-40. a conflict\'s buttons name the role; Discard returns focus to the level, Reapply to Save', async () => {
    const fresh = fakeServer(); // two unsent drafts made into conflicts by a later read
    mount('uid-a', fresh, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('server-level-select-technician'), 'none');
    await user.selectOptions(screen.getByTestId('server-level-select-sales_staff'), 'none');
    await user.type(screen.getByTestId('server-level-reason-sales_staff'), REASON);
    fresh.set(TENANT_A, 'technician', 'edit');
    fresh.set(TENANT_A, 'sales_staff', 'edit');
    await focusRefresh();
    await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', 'conflict'));
    expect(screen.getByRole('button', { name: 'Discard my choice for Technician' })).toBe(screen.getByTestId('server-level-discard-technician'));
    expect(screen.getByRole('button', { name: 'Reapply to the current level for Sales Associate' })).toBe(screen.getByTestId('server-level-reapply-sales_staff'));
    await click('server-level-discard-technician');
    await waitFor(() => expect(screen.getByTestId('server-level-select-technician')).toHaveFocus());
    await click('server-level-reapply-sales_staff');
    await waitFor(() => expect(screen.getByTestId('server-level-save-sales_staff')).toHaveFocus());
    expect(screen.getByTestId('server-level-save-sales_staff')).toBeEnabled();
    expect(puts(fresh)).toHaveLength(0);
  });

  it('SCL-41. a held key is never reused once the draft changes: the fake refuses other bytes under a key (422), and the panel sends a new key', async () => {
    // The fake's fingerprint: the same key with another body is refused, as the server refuses it.
    const probe = fakeServer();
    probe.session = { uid: 'uid-a', tenant: TENANT_A, owner: true };
    const client = createRoleLevelsClient({ fetch: probe.fetch });
    const change = { roleId: 'technician', level: 'none', reason: REASON, expectedTenant: TENANT_A, expectedVersion: 0 } as const;
    const key = ['31313131', '3131', '4131', '8131', '313131313131'].join('-');
    expect(await client.put(change, key, CSRF)).toEqual({ kind: 'ok', level: 'none', version: 1 });
    expect(await client.put({ ...change, reason: `${REASON}.` }, key, CSRF)).toEqual({ kind: 'key-reused' });

    // Level changed away and back while the key is held (nothing reached the server): a new key.
    const server = fakeServer();
    server.puts.push('lost-before-commit');
    const keys = ['32323232-3232-4232-8232-323232323232', '33333333-3333-4333-8333-333333333333', '34343434-3434-4434-8434-343434343434'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('server-level-select-manager'), 'edit');
    await user.selectOptions(screen.getByTestId('server-level-select-manager'), 'view');
    await click('server-level-save-manager');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[1]]);

  });

  it('SCL-42. a held attempt stays held through a session failure before the PUT and a refusal of its replay: never "Not saved", the same key until it is decided', async () => {
    const server = fakeServer();
    server.puts.push('lost-before-commit', 401);
    const keys = ['42424242-4242-4242-8242-424242424242', '43434343-4343-4343-8343-434343434343'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    server.down = true; // the session check before the PUT fails: nothing is sent
    await click('server-level-save-manager');
    await waitFor(() => expect(status('manager').textContent).toBe('Not confirmed yet — the store server could not be reached. Press Save again to check.'));
    expect(status('manager')).toHaveAttribute('data-status', 'confirm');
    expect(screen.getByTestId('server-level-save-manager')).toBeEnabled();
    expect(screen.getByTestId('server-level-unsaved-manager')).toHaveTextContent('Unsaved: View Only');
    server.down = false;
    await click('server-level-save-manager'); // the replay is refused (401) before it reaches the key's record
    await waitFor(() => expect(status('manager').textContent).toBe('Not confirmed yet — your server session ended. Reconnect, then press Save again to check.'));
    expect(status('manager')).not.toHaveTextContent(/Not saved/);
    await click('server-level-save-manager');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(puts(server).map((r) => r.headers.get('idempotency-key'))).toEqual([keys[0], keys[0], keys[0]]); // the down check sent none
    expect(new Set(puts(server).map((r) => r.body)).size).toBe(1);
  });

  it('SCL-43. a user switch renders nothing of the previous user, even on its first render; after A → B → A the first A session\'s late answer is dropped', async () => {
    const server = fakeServer();
    const seen: Array<{ rows: number; state: string | null; unsaved: boolean }> = [];
    let recording = false;
    function Probe() {
      useLayoutEffect(() => { // after the DOM of each commit, before any passive effect
        if (!recording) return;
        seen.push({
          rows: document.querySelectorAll('[data-testid^="server-level-row-"]').length,
          state: document.querySelector('[data-testid="server-levels-state"]')?.textContent ?? null,
          unsaved: document.querySelector('[data-testid^="server-level-unsaved-"]') !== null,
        });
      });
      return null;
    }
    const session = createTenantSessionClient({ fetch: server.fetch });
    const levels = createRoleLevelsClient({ fetch: server.fetch });
    const { identity } = identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' });
    const ui = (uid: string) => <><ServerCustomerLevels uid={uid} session={session} levels={levels} identity={identity} /><Probe /></>;
    const view = render(ui('uid-a'));
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await userEvent.setup().selectOptions(screen.getByTestId('server-level-select-manager'), 'view');
    recording = true;
    view.rerender(ui('uid-b'));
    recording = false;
    expect(seen[0]).toEqual({ rows: 0, state: 'Loading', unsaved: false }); // the very first commit for uid-b
    cleanup();

    const again = fakeServer();
    again.holdPuts = 1;
    const panel = mount('uid-a', again, identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(again.heldPuts).toHaveLength(1));
    panel.again('uid-b');
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: Create'));
    panel.again('uid-a');
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: View Only'));
    await act(async () => { again.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    await flush();
    expect(again.stored[TENANT_A].technician).toBe('none'); // the server did commit it
    expect(screen.queryByTestId('server-levels-previous-store')).toBeNull(); // but it answers the first A session only
    expect(status('technician')).toHaveTextContent(/^$/);
  });

  it('SCL-44. changing the reason ends a held confirmation at once: an ordinary unsaved draft, or a conflict when its version moved; never the held key', async () => {
    const server = fakeServer();
    server.puts.push('lost-before-commit', 'lost-before-commit');
    const keys = ['44444444-4444-4444-8444-444444444444', '45454545-4545-4545-8545-454545454545', '46464646-4646-4646-8646-464646464646', '47474747-4747-4747-8747-474747474747'];
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity, keys);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    const user = userEvent.setup();
    // The version did not move: an ordinary unsaved draft, sent under a new key at its own version.
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    await user.type(screen.getByTestId('server-level-reason-technician'), '!');
    expect(status('technician')).toHaveAttribute('data-status', 'idle');
    expect(status('technician').textContent).toBe('Not saved yet.');
    // The version moved under a held draft: the reason change makes it a conflict — no Save until Discard or Reapply.
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    server.set(TENANT_A, 'manager', 'edit'); // v1
    await focusRefresh();
    await waitFor(() => expect(row('manager')).toHaveTextContent('Server level: Edit'));
    expect(status('manager')).toHaveAttribute('data-status', 'confirm'); // a read alone never ends a held attempt
    await user.type(screen.getByTestId('server-level-reason-manager'), '!');
    expect(status('manager')).toHaveAttribute('data-status', 'conflict');
    expect(screen.getByTestId('server-level-conflict-manager')).toHaveTextContent('The server now has Edit. Your unsaved choice: View Only.');
    expect(screen.getByTestId('server-level-save-manager')).toBeDisabled();
    await click('server-level-save-technician');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    await click('server-level-reapply-manager');
    await click('server-level-save-manager');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    const byKey = puts(server).map((r) => [r.headers.get('idempotency-key'), sentBody(r).expectedVersion]);
    expect(byKey).toEqual([[keys[0], 0], [keys[1], 0], [keys[2], 0], [keys[3], 1]]); // one PUT per Save
  });

  it('SCL-45. a 200 whose read-back fails shows the level as last known, never as the server level, until a read establishes it', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.holdReads = 1; // the read-back
    await edit('technician', 'none');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { server.held[0].resolve(json(503, { error: 'service_unavailable' })); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'failed'));
    expect(row('technician')).toHaveTextContent('Last known level: View Only');
    expect(row('technician')).not.toHaveTextContent('Server level:');
    expect(row('manager')).toHaveTextContent('Server level: Full Access'); // other rows were not affected
    await focusRefresh();
    await waitFor(() => expect(row('technician')).toHaveTextContent('Server level: None'));
  });

  it('SCL-46. a read that arrives while a role\'s save is in flight is not lost when that save ends without its own read-back', async () => {
    const server = fakeServer();
    server.puts.push(403);
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.set(TENANT_A, 'technician', 'edit'); // v1, unseen by this tab
    server.holdReads = 1;
    await focusRefresh(); // a refresh in flight before the save (it reads v1)
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.holdPuts = 1;
    await edit('technician', 'none'); // drafted at v0
    await waitFor(() => expect(server.heldPuts).toHaveLength(1));
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(row('technician')).toHaveTextContent('Last known level: View Only'); // deferred: the save owns the row
    await act(async () => { server.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); }); // 403: no read-back
    await waitFor(() => expect(row('technician')).toHaveTextContent('Server level: Edit')); // read again
    expect(status('technician')).toHaveAttribute('data-status', 'conflict');
    expect(status('technician').textContent).toBe(conflictText('edit'));
  });

  it('SCL-47. a held key whose confirmation is refused after the store connection changed is reported unconfirmed, never "not saved"', async () => {
    const server = fakeServer();
    server.puts.push(503); // undecided: the key is held
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    server.holdReads = 1;
    await focusRefresh(); // a refresh in flight before the confirmation
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.holdPuts = 1;
    server.puts.push(403);
    await click('server-level-save-technician'); // the confirmation, under the held key
    await waitFor(() => expect(server.heldPuts).toHaveLength(1));
    server.session = { uid: 'uid-a', tenant: TENANT_B, owner: true };
    await act(async () => { server.held[0].resolve(json(200, server.levelsOf(TENANT_B))); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(screen.getByTestId('server-levels-store-changed')).toBeInTheDocument());
    await act(async () => { server.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); }); // 403 for the confirmation
    await waitFor(() => expect(screen.getByTestId('server-levels-previous-store')).toBeInTheDocument());
    expect(screen.getByTestId('server-levels-previous-store').textContent).toBe(PREVIOUS_STORE.unconfirmed);
  });

  it('SCL-48. a read deferred by a save in flight makes the row "last known" at once, and it stays so until a later read succeeds', async () => {
    const server = fakeServer();
    server.puts.push(403); // refused outright: no read-back
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.set(TENANT_A, 'technician', 'edit'); // v1, unseen by this tab
    server.holdReads = 1;
    await focusRefresh();
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.holdPuts = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(server.heldPuts).toHaveLength(1));
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(row('technician')).toHaveTextContent('Last known level: View Only'); // a newer read says otherwise
    expect(row('manager')).toHaveTextContent('Server level: Full Access'); // unchanged by it: still current
    server.holdReads = 1; // the re-read after the save
    await act(async () => { server.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(server.held).toHaveLength(2));
    const reads = levelReads(server);
    await act(async () => { server.held[1].resolve(json(503, { error: 'service_unavailable' })); await new Promise((r) => setTimeout(r, 0)); });
    await flush();
    expect(row('technician')).toHaveTextContent('Last known level: View Only'); // the failed re-read established nothing
    expect(row('technician')).not.toHaveTextContent('Server level:');
    expect(levelReads(server)).toBe(reads); // one re-read per deferral, no retry loop
    await focusRefresh();
    await waitFor(() => expect(row('technician')).toHaveTextContent('Server level: Edit'));
    expect(status('technician')).toHaveAttribute('data-status', 'conflict');
  });

  it('SCL-49. an exact 200 whose read-back shows an older version, or its version with another level, is never applied: the row stays last known and is read again', async () => {
    for (const variant of ['older', 'other-level'] as const) {
      const server = fakeServer();
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      const before = JSON.parse(JSON.stringify(server.levelsOf(TENANT_A))) as ReturnType<typeof server.levelsOf>;
      server.holdReads = 1;
      await edit('technician', 'none');
      await waitFor(() => expect(server.held).toHaveLength(1));
      const after = server.levelsOf(TENANT_A);
      after.roles[2] = { ...after.roles[2], level: 'edit' };
      server.holdReads = 1; // the read the panel still owes
      await act(async () => { server.held[0].resolve(json(200, variant === 'older' ? before : after)); await new Promise((r) => setTimeout(r, 0)); });
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'failed'));
      expect(row('technician')).toHaveTextContent('Last known level: View Only'); // the inconsistent read was not installed
      expect(row('technician')).not.toHaveTextContent('Server level:');
      expect(row('manager')).toHaveTextContent('Server level: Full Access'); // it still applied to the other roles
      await waitFor(() => expect(server.held).toHaveLength(2)); // read again once the save ended
      await act(async () => { server.held[1].resolve(); await new Promise((r) => setTimeout(r, 0)); }); // v1 None
      await waitFor(() => expect(row('technician')).toHaveTextContent('Server level: None'));
      expect(status('technician').textContent).toMatch(/^Not confirmed: the server shows/); // never re-attributed to elsewhere
      cleanup();
    }
  });

  it('SCL-50. a conflict whose level could not be read learns it from the next successful read, even at the draft\'s own version', async () => {
    const server = fakeServer();
    server.puts.push('conflict-sealed'); // refused; the server stays at v0
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.holdReads = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { server.held[0].resolve(json(503, { error: 'service_unavailable' })); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(screen.getByTestId('server-level-conflict-technician')).toHaveTextContent('The current server level could not be read.'));
    await focusRefresh(); // reads v0: the draft's own base version
    await waitFor(() => expect(screen.getByTestId('server-level-conflict-technician')).toHaveTextContent('The server now has View Only. Your unsaved choice: None.'));
    expect(status('technician').textContent).toBe(conflictText('view'));
    expect(row('technician')).toHaveTextContent('Server level: View Only');
    expect(screen.getByTestId('server-level-reapply-technician')).toBeEnabled();
  });

  it('SCL-51. a read taken while a save is in flight makes that row last known even when it shows the same level', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    server.holdReads = 1;
    await focusRefresh(); // the same snapshot this tab already shows
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.holdPuts = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(server.heldPuts).toHaveLength(1));
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(row('technician')).toHaveTextContent('Last known level: View Only'); // the PUT may already have moved it
    expect(row('manager')).toHaveTextContent('Server level: Full Access');
    await act(async () => { server.heldPuts[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(row('technician')).toHaveTextContent('Server level: None');
  });

  it('SCL-52. after a store change, the new store\'s first deferred read is read again (the re-read count starts over)', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    let pendingPut: (() => void) | undefined;
    const release = async () => { await act(async () => { pendingPut?.(); await new Promise((r) => setTimeout(r, 0)); }); };
    // Store A: one deferral, re-read once the save ends.
    server.puts.push(403);
    server.holdReads = 1;
    await focusRefresh();
    await waitFor(() => expect(server.held).toHaveLength(1));
    server.holdPuts = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(server.heldPuts).toHaveLength(1));
    await act(async () => { server.held[0].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    pendingPut = server.heldPuts[0].resolve;
    await release();
    await waitFor(() => expect(row('technician')).toHaveTextContent('Server level: View Only'));
    // Store B: the panel starts over; its first deferral must be read again too.
    server.session = { uid: 'uid-a', tenant: TENANT_B, owner: true };
    await focusRefresh();
    await waitFor(() => expect(screen.getByTestId('server-levels-store-changed')).toBeInTheDocument());
    await waitFor(() => expect(row('sales_staff')).toHaveTextContent('Server level: Create'));
    server.puts.push(403);
    server.holdReads = 1;
    await focusRefresh();
    await waitFor(() => expect(server.held).toHaveLength(2));
    server.holdPuts = 1;
    await edit('technician', 'none');
    await waitFor(() => expect(server.heldPuts).toHaveLength(2));
    await act(async () => { server.held[1].resolve(); await new Promise((r) => setTimeout(r, 0)); });
    expect(row('technician')).toHaveTextContent('Last known level: View Only');
    const reads = levelReads(server);
    pendingPut = server.heldPuts[1].resolve;
    await release();
    await waitFor(() => expect(levelReads(server)).toBe(reads + 1)); // the re-read
    await waitFor(() => expect(row('technician')).toHaveTextContent('Server level: View Only'));
  });
  // M7A-CUSTOMERS-P5-R1 (DA-143) — the panel reopened over the session this browser already holds signs nothing in.
  it('SCL-53. a reopened panel with a new session client reuses the same user\'s session: one login overall, and the levels shown', async () => {
    const server = fakeServer();
    const starts: number[] = [];
    for (let open = 0; open < 3; open++) {
      starts.push(server.sent.length);
      mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity); // a new session client each time
      await waitFor(() => expect(state()).toHaveTextContent('Ready'));
      expect(row('sales_staff')).toHaveTextContent('View Only');
      cleanup();
    }
    for (const at of starts) expect(`${server.sent[at].method} ${server.sent[at].url}`).toBe(`GET ${TENANT_SESSION_PATHS.current}`);
    expect(server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login)).toHaveLength(1);
    expect(server.sent.slice(starts[1]).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${TENANT_SESSION_PATHS.current}`, `GET ${ROLE_LEVELS_PATH}`, `GET ${TENANT_SESSION_PATHS.current}`, `GET ${ROLE_LEVELS_PATH}`,
    ]);
  });

  // M7A-CUSTOMERS-P6 — a session this panel confirmed that the server then ends is never re-established on its own: Save
  // and the focus refresh find it ended and sign nothing in; only the Reconnect click logs in, once.
  const ENDED_NOTE = 'Your server session ended. Reconnect to see server-enforced Customers access.';
  const logins = (server: ReturnType<typeof fakeServer>) => server.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login).length;
  const settled = async () => { for (let i = 0; i < 4; i++) await flush(); };

  it('SCL-54. the session ends under a ready panel: Save, Save again and a focus refresh send NO login and NO PUT; only Reconnect logs in, once, keeping the draft', async () => {
    const server = fakeServer();
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(logins(server)).toBe(1);
    server.session = null; // expired or revoked in the store
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'signed-out'));
    expect(status('technician')).toHaveTextContent('Not saved: your server session ended. Reconnect, then save again.');
    expect(screen.getByTestId('server-levels-retry')).toHaveTextContent('Reconnect');
    await click('server-level-save-technician'); // Save again: still nothing
    await settled();
    expect(status('technician')).toHaveAttribute('data-status', 'signed-out');
    expect(puts(server)).toHaveLength(0);
    expect(logins(server)).toBe(1);
    await focusRefresh();
    await waitFor(() => expect(state()).toHaveTextContent('Signed out'));
    expect(screen.getByText(ENDED_NOTE)).toBeInTheDocument();
    expect(screen.queryByTestId('server-level-row-technician')).toBeNull();
    expect(puts(server)).toHaveLength(0);
    expect(logins(server)).toBe(1);
    expect(levelReads(server)).toBe(1);
    await click('server-levels-retry');
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(logins(server)).toBe(2);
    expect(screen.getByTestId('server-level-select-technician')).toHaveValue('none');
    expect(screen.getByTestId('server-level-reason-technician')).toHaveValue(REASON);
    await click('server-level-save-technician');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(logins(server)).toBe(2);
  });

  it('SCL-55. a PUT refused 401 whose session really ended: the focus refresh that follows signs nothing in; Reconnect reuses another tab\'s valid session with no login', async () => {
    const server = fakeServer();
    server.puts.push(401);
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }).identity);
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'signed-out'));
    const user = server.session;
    server.session = null; // the server session really ended
    await focusRefresh();
    await waitFor(() => expect(state()).toHaveTextContent('Signed out'));
    expect(screen.getByText(ENDED_NOTE)).toBeInTheDocument();
    await focusRefresh();
    await settled();
    expect(logins(server)).toBe(1);
    server.session = user; // another tab of this browser signed the same user in
    await click('server-levels-retry');
    await waitFor(() => expect(state()).toHaveTextContent('Ready'));
    expect(logins(server)).toBe(1);
    expect(screen.getByTestId('server-level-select-technician')).toHaveValue('none');
  });
});

// M5-INVOICES-AUTH-P1-R1 — a save never re-sends its PUT by itself. A PUT with no answer at all leaves the row held
// ("Not confirmed yet — press Save again to check.", the draft and the key kept); only a click on Save sends it again,
// under the same key with the same bytes. Rerenders, focus and visibility refreshes, expired timers, session checks
// and refusals (401/403/429 with Retry-After) send no PUT.
describe('ServerCustomerLevels: no automatic PUT resend (M5-INVOICES-AUTH-P1-R1)', () => {
  type Server = ReturnType<typeof fakeServer>;
  type Mode = 'before' | 'after';
  // While `lose.on`, every PUT gets no answer: 'before' — it never reaches the server; 'after' — it commits (or replays),
  // then the answer is lost. Installed before mount, so both clients use it.
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
  const K1 = '56565656-5656-4656-8656-565656565656';
  const K2 = '57575757-5757-4757-8757-575757575757';
  const owner = () => identityFor({ 'uid-a': 'tok-a', 'uid-b': 'tok-b' }).identity;
  const ready = () => waitFor(() => expect(state()).toHaveTextContent('Ready'));
  const keysOf = (server: Server) => puts(server).map((r) => r.headers.get('idempotency-key'));
  // Every timer the panel or its clients could have set (Retry-After's 1..300 s clamp, request timeouts) runs out.
  const expireTimers = () => act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
  const visible = async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  afterEach(() => { vi.useRealTimers(); });

  it('SCL-56. one Save whose PUT gets no answer sends exactly ONE PUT and holds the row; rerender, focus, visibility and expired timers send none', async () => {
    for (const mode of ['before', 'after'] as const) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const server = fakeServer();
      const lose = losing(server, mode);
      const view = mount('uid-a', server, owner(), [K1, K2]);
      await ready();
      await edit('technician', 'none');
      await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
      await expireTimers();
      await settle();
      expect(keysOf(server)).toEqual([K1]); // AC-01: one PUT, no automatic second one
      expect(status('technician').textContent).toBe(notConfirmed(mode === 'after' ? 'none' : 'view'));
      expect(screen.getByTestId('server-level-select-technician')).toHaveValue('none'); // the draft is kept
      expect(screen.getByTestId('server-level-save-technician')).toBeEnabled(); // the explicit retry
      lose.on = false; // the network is back: still nothing is sent without a click (AC-04)
      const reads = levelReads(server);
      view.again('uid-a');
      await focusRefresh();
      await settle();
      await visible();
      await expireTimers();
      await settle();
      expect(levelReads(server)).toBeGreaterThan(reads); // reads are allowed
      expect(keysOf(server)).toEqual([K1]);
      expect(status('technician')).toHaveAttribute('data-status', 'confirm');
      expect(server.stored[TENANT_A].technician).toBe(mode === 'after' ? 'none' : undefined);
      cleanup();
      vi.useRealTimers();
    }
  }, 30_000);

  it('SCL-57. Save again on a held row sends exactly one more PUT, same key and identical bytes; if that is lost too it stays held until the next click', async () => {
    for (const mode of ['before', 'after'] as const) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const server = fakeServer();
      const lose = losing(server, mode);
      mount('uid-a', server, owner(), [K1, K2]);
      await ready();
      await edit('manager', 'view');
      await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
      expect(keysOf(server)).toEqual([K1]);
      await click('server-level-save-manager'); // AC-02 + AC-03: the explicit retry, lost as well
      await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
      await expireTimers();
      await settle();
      expect(keysOf(server)).toEqual([K1, K1]);
      expect(puts(server)[1].body).toBe(puts(server)[0].body); // the raw bytes
      expect(status('manager').textContent).toBe(notConfirmed(mode === 'after' ? 'view' : 'full'));
      expect(screen.getByTestId('server-level-select-manager')).toHaveValue('view');
      lose.on = false;
      await click('server-level-save-manager');
      await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
      expect(keysOf(server)).toEqual([K1, K1, K1]);
      expect(new Set(puts(server).map((r) => r.body)).size).toBe(1);
      expect([server.stored[TENANT_A].manager, server.versions[TENANT_A].manager]).toEqual(['view', 1]); // executed once
      cleanup();
      vi.useRealTimers();
    }
  }, 30_000);

  it('SCL-58. a PUT 200 whose read-back fails sends no second PUT and never says Saved, through a refresh and expired timers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer();
    mount('uid-a', server, owner(), [K1, K2]);
    await ready();
    server.holdReads = 1; // the read-back
    await edit('technician', 'none');
    await waitFor(() => expect(server.held).toHaveLength(1));
    await act(async () => { server.held[0].resolve(json(503, { error: 'service_unavailable' })); });
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'failed'));
    await expireTimers();
    await focusRefresh();
    await settle();
    expect(keysOf(server)).toEqual([K1]);
    expect(status('technician')).not.toHaveTextContent(/Saved/);
  });

  it('SCL-59. a held row is dropped with its user or store: no PUT on the switch, and the next context sends its own new key', async () => {
    const server = fakeServer();
    const lose = losing(server, 'before');
    const view = mount('uid-a', server, owner(), [K1, K2]);
    await ready();
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    const sentA = puts(server).length;
    lose.on = false;
    server.session = { ...server.session!, uid: 'uid-b', tenant: TENANT_B }; // uid-b's session (tenant B)
    view.again('uid-b');
    await ready();
    await settle();
    expect(puts(server)).toHaveLength(sentA); // the switch re-sent nothing
    expect(screen.queryByTestId('server-level-unsaved-technician')).toBeNull();
    expect(status('technician')).toHaveTextContent(/^$/);
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(puts(server).slice(sentA).map((r) => r.headers.get('idempotency-key'))).toEqual([K2]); // never the held key
    expect(sentBody(puts(server)[sentA]).expectedTenant).toBe(TENANT_B);
    cleanup();

    // The same user's session moves to another store while a row is held: the store change drops it, nothing is sent.
    const moved = fakeServer();
    const off = losing(moved, 'before');
    mount('uid-a', moved, owner(), [K1, K2]);
    await ready();
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    const sent = puts(moved).length;
    off.on = false;
    moved.session = { uid: 'uid-a', tenant: TENANT_B, owner: true };
    await focusRefresh();
    await waitFor(() => expect(screen.getByTestId('server-levels-store-changed')).toBeInTheDocument());
    await settle();
    expect(puts(moved)).toHaveLength(sent);
    expect(screen.queryByTestId('server-level-unsaved-manager')).toBeNull();
    expect(moved.stored[TENANT_B].manager).toBeUndefined();
  });

  it('SCL-60. a PUT refused 401, 403, step-up or 429 (Retry-After) is never re-sent on its own: not after the wait, a refresh or a rerender', async () => {
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
      const view = mount('uid-a', server, owner(), [K1, K2]);
      await ready();
      await edit('sales_staff', 'none');
      await waitFor(() => expect(status('sales_staff')).toHaveAttribute('data-status', tone));
      await expireTimers(); // past the Retry-After
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

  it('SCL-61. Save pressed twice quickly while the first PUT hangs sends exactly one PUT', async () => {
    const server = fakeServer();
    server.holdPuts = 1;
    mount('uid-a', server, owner(), [K1, K2]);
    await ready();
    await edit('technician', 'none');
    await waitFor(() => expect(server.heldPuts).toHaveLength(1));
    await userEvent.setup().click(screen.getByTestId('server-level-save-technician'));
    await userEvent.setup().click(screen.getByTestId('server-level-save-technician'));
    await settle();
    expect(keysOf(server)).toEqual([K1]);
    await act(async () => { server.heldPuts[0].resolve(); });
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    await settle();
    expect(keysOf(server)).toEqual([K1]);
  });

  it('SCL-62. a held row stays held through a step-up re-authentication and through a session end and Reconnect: neither re-sends; only Save does, same key and bytes', async () => {
    // Step-up: the prompt only comes from a PUT's answer, so the held row's first explicit check is answered step-up.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer();
    const lose = losing(server, 'before');
    mount('uid-a', server, identityFor({ 'uid-a': 'tok-a' }, { method: 'password', token: 'tok-a' }).identity, [K1, K2]);
    await ready();
    await edit('technician', 'none');
    await waitFor(() => expect(status('technician')).toHaveAttribute('data-status', 'confirm'));
    lose.on = false;
    server.puts.push('step-up');
    await click('server-level-save-technician');
    await waitFor(() => expect(screen.getByTestId('server-level-reauth-password')).toBeInTheDocument());
    expect(keysOf(server)).toEqual([K1, K1]);
    const user = userEvent.setup();
    await user.type(screen.getByTestId('server-level-reauth-password'), 'synthetic-password');
    await user.click(screen.getByTestId('server-level-reauth-confirm'));
    await waitFor(() => expect(status('technician')).toHaveTextContent('Signed in again'));
    await expireTimers();
    await focusRefresh();
    await settle();
    expect(keysOf(server)).toEqual([K1, K1]); // the re-authentication re-sent nothing
    expect(status('technician')).toHaveAttribute('data-status', 'confirm');
    await click('server-level-save-technician');
    await waitFor(() => expect(status('technician')).toHaveTextContent(/^Saved$/));
    expect(keysOf(server)).toEqual([K1, K1, K1]);
    expect(new Set(puts(server).map((r) => r.body)).size).toBe(1);
    cleanup();

    // The session ends under a held row; Reconnect signs in again and re-sends nothing.
    const ended = fakeServer();
    const off = losing(ended, 'before');
    mount('uid-a', ended, owner(), [K1, K2]);
    await ready();
    await edit('manager', 'view');
    await waitFor(() => expect(status('manager')).toHaveAttribute('data-status', 'confirm'));
    off.on = false;
    ended.session = null;
    await focusRefresh();
    await waitFor(() => expect(state()).toHaveTextContent('Signed out'));
    const logins = ended.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login).length;
    await click('server-levels-retry');
    await ready();
    expect(ended.sent.filter((r) => r.url === TENANT_SESSION_PATHS.login).length).toBe(logins + 1); // signed in again
    await expireTimers();
    await focusRefresh();
    await settle();
    expect(keysOf(ended)).toEqual([K1]); // Reconnect itself re-sent nothing
    expect(status('manager')).toHaveAttribute('data-status', 'confirm');
    await click('server-level-save-manager');
    await waitFor(() => expect(status('manager')).toHaveTextContent(/^Saved$/));
    expect(keysOf(ended)).toEqual([K1, K1]);
    expect(puts(ended)[1].body).toBe(puts(ended)[0].body);
  }, 30_000);
});

describe('ServerCustomerLevels: the two domains on one screen (M7B-INVOICES-P1)', () => {
  it('SCL-63. the Invoices panel says the server decides the server drafts (save, list, open at a store) by its level and that other invoices stay in this browser; the Customers panel keeps its own copy; no id is shared', () => {
    const sent: string[] = [];
    const session = createTenantSessionClient({ fetch: async (input) => { sent.push(String(input)); return new Response(null, { status: 503 }); } });
    const levels = createRoleLevelsClient({ fetch: async (input) => { sent.push(String(input)); return new Response(null, { status: 503 }); } });
    const { identity } = identityFor({});
    const { container } = render(
      <>
        <ServerCustomerLevels uid={null} session={session} levels={levels} identity={identity} />
        <ServerInvoiceLevels uid={null} session={session} levels={levels} identity={identity} />
      </>,
    );
    const invoices = screen.getByTestId('server-invoice-levels');
    expect(invoices).toHaveTextContent('Saved on the store server: only the Invoices level of the built-in roles (store owner fixed).');
    expect(invoices).toHaveTextContent('The server uses it to decide who may save, list, open and edit server drafts at a store, and (at Manage or above — Full Access in this picker) discard them.');
    expect(invoices).toHaveTextContent('Other invoices are still saved in this browser and are not checked by the server.');
    expect(invoices.textContent).not.toMatch(/invoice actions are not enforced by the server/); // the M5-INVOICES-AUTH-P1 copy, untrue since server drafts
    const customers = screen.getByTestId('server-customer-levels');
    expect(customers).toHaveTextContent('Stored on the store server and enforced on every customer view and create request. Covers the Customers module of the built-in roles only.');
    expect(customers.textContent).not.toMatch(/server drafts/);
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sent).toEqual([]); // nobody signed in: nothing is read
  });
});
