// Phase 4.0 M4 — the Command Center page in jsdom: the real routes, shell, session client and
// Command Center client over scripted servers (contract v2, .workflow/scratch/m4ui-p2-cc-contract.md).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { inspect } from 'node:util';
import { MemoryRouter } from 'react-router-dom';
import { ConsoleProvider, ConsoleRoutes } from './AdminConsoleApp';
import type { AdminIdentityProvider } from './adminIdentity';
import { createAdminSessionClient } from './adminSessionClient';
import { COMMAND_CENTER_PATH, createCommandCenterClient, type CommandCenterClient, type CommandCenterOutcome } from './commandCenterClient';
import { CONSOLE_MODULES, modulePath } from './navigation';

const CSRF = 'k'.repeat(43);
const COOKIE = 'synthetic-admin-cookie-9d2c';
const SENSITIVE = [CSRF, COOKIE];
const MINUTE = 60_000;

const EXPIRED = 'Your session has ended. Sign in again to continue.';
const FORBIDDEN = "The Command Center isn't available for this account.";
const RATE_LIMITED = 'Too many requests. Wait a moment, then refresh.';
const PARTIAL = 'Some sources are unavailable or not configured. Their sections show no figures.';
const MUTATION = /approve|provision|migrat|repair|delete|create|edit|disable|enable|suspend/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const iso = (ms: number): string => new Date(ms).toISOString();
/** The page's clock format: local HH:MM. */
const hhmm = (ms: number): string => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** A complete, valid view generated at `at`, every section read at `asOf`. */
function fullView(at = Date.now(), asOf = at): Json {
  const fresh = { status: 'available', asOf: iso(asOf), stale: false };
  return {
    schemaVersion: 1,
    generatedAt: iso(at),
    sections: {
      posture: {
        ...fresh,
        metrics: [{ key: 'tenants', value: 12 }, { key: 'stores', value: 48 }, { key: 'pending_approvals', value: 7 }, { key: 'critical_alerts', value: 5 }],
      },
      attention: {
        ...fresh,
        items: [
          { severity: 'critical', area: 'security', count: 1 },
          { severity: 'warning', area: 'provisioning', count: 3 },
          { severity: 'info', area: 'billing', count: 2 },
        ],
      },
      governance: {
        ...fresh,
        signals: [{ key: 'production_locked', state: 'ok' }, { key: 'approvals_enforced', state: 'attention' }, { key: 'audit_recording', state: 'unknown' }],
      },
      services: {
        ...fresh,
        services: [
          { key: 'auth', state: 'healthy' }, { key: 'pos', state: 'warning' }, { key: 'repairs', state: 'off' }, { key: 'inventory', state: 'unknown' },
          { key: 'identity_link', state: 'healthy' }, { key: 'audit', state: 'healthy' }, { key: 'worker', state: 'warning' },
        ],
      },
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Reply = () => Response | Promise<Response>;
const ok = (view: Json): Reply => () => json(200, view);
const refused = (status: number): Reply => () => json(status, { error: 'refused', requestId: 'r1' });

/** A reply the test answers later. */
function held() {
  let answer!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  return { reply: (() => pending) as Reply, answer };
}

/** The Command Center's own scripted server: each request takes the next reply, the last one repeats. */
function commandCenterServer(replies: readonly Reply[]) {
  const queue = [...replies];
  const sent: RequestInit[] = [];
  const fetch = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push(init);
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      Promise.resolve().then(reply).then(resolve, reject);
    });
  });
  return { sent, fetch };
}

function sessionServer(answers: ReadonlyArray<'active' | number>) {
  const queue = [...answers];
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    return answer === 'active' ? json(200, { status: 'active', csrfToken: CSRF }) : json(answer, { error: 'refused', requestId: 'r1' });
  });
}

function renderPage(
  replies: readonly Reply[],
  options: { session?: ReadonlyArray<'active' | number>; strict?: boolean; commandCenter?: CommandCenterClient } = {},
) {
  const cc = commandCenterServer(replies);
  const session = sessionServer(options.session ?? ['active']);
  const identity: AdminIdentityProvider = { signIn: vi.fn<AdminIdentityProvider['signIn']>(async () => ({ kind: 'failed', failure: 'unavailable' })) };
  const tree = (
    <ConsoleProvider
      client={createAdminSessionClient({ fetch: session as unknown as typeof fetch })}
      identity={identity}
      commandCenter={options.commandCenter ?? createCommandCenterClient({ fetch: cc.fetch as unknown as typeof fetch })}
    >
      <MemoryRouter initialEntries={['/admin']}>
        <ConsoleRoutes />
      </MemoryRouter>
    </ConsoleProvider>
  );
  const view = render(options.strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
  return { ...view, cc, session, user: userEvent.setup() };
}

const main = () => screen.getByRole('main');
const liveRegion = () => within(main()).getByRole('status');
const region = (name: string) => screen.getByRole('region', { name });
const DATA_SECTIONS = ['Platform summary', 'Needs attention', 'Governance signals', 'Service health'];

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

describe('Command Center', () => {
  it('shows every section of a complete view with its labels and values, under the one page heading', async () => {
    const at = Date.now();
    const { cc } = renderPage([ok(fullView(at))]);
    const summary = await screen.findByRole('region', { name: 'Platform summary' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();

    const time = within(main()).getByText(hhmm(at), { selector: 'time' });
    expect(time).toHaveAttribute('datetime', iso(at));
    expect(time.parentElement).toHaveTextContent(`Updated ${hhmm(at)}`);
    expect(screen.getByText('4 of 4 sources available')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent(`Command Center updated at ${hhmm(at)}`);

    for (const [label, value] of [['Tenants', '12'], ['Stores', '48'], ['Pending approvals', '7'], ['Critical alerts', '5']]) {
      const card = within(summary).getByText(label).parentElement as HTMLElement;
      expect(within(card).getByText(value)).toHaveClass('tabular-nums');
    }

    const items = within(region('Needs attention')).getAllByRole('listitem');
    const expected = [
      ['Critical', '1 critical', 'Audit & Security', '/admin/audit-security'],
      ['Warning', '3 warnings', 'Provisioning', '/admin/provisioning'],
      ['Info', '2 info', 'Billing & Subscriptions', '/admin/billing-subscriptions'],
    ];
    expect(items).toHaveLength(expected.length);
    expected.forEach(([badge, count, workspace, path], index) => {
      expect(within(items[index]).getByText(badge)).toBeInTheDocument();
      expect(items[index]).toHaveTextContent(count);
      expect(within(items[index]).getByRole('link', { name: `Open ${workspace}` })).toHaveAttribute('href', path);
    });

    const governance = region('Governance signals');
    expect([...governance.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Production changes', 'Approval policy', 'Audit trail']);
    expect([...governance.querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['Locked', 'Not enforced', 'Unknown']);

    const services = within(region('Service health')).getAllByRole('listitem').map((item) => item.textContent);
    expect(services).toEqual([
      'Authentication Healthy', 'POS Warning', 'Repairs Off', 'Inventory Unknown',
      'Identity link Healthy', 'Audit Healthy', 'Background jobs Warning',
    ]);

    expect(within(region('Workspaces')).getAllByText('Coming later')).toHaveLength(CONSOLE_MODULES.length);
    expect(screen.queryByText(PARTIAL)).toBeNull();
    for (const state of ['Unavailable', 'Not configured', 'Out of date']) expect(screen.queryByText(state)).toBeNull();
    expect(cc.fetch).toHaveBeenCalledTimes(1);
    expect(cc.fetch.mock.calls[0][0]).toBe(COMMAND_CENTER_PATH);
  });

  it('says which sources are missing and shows no figure for them', async () => {
    const view = fullView();
    view.sections.posture = { status: 'unavailable' };
    view.sections.attention = { status: 'not_configured' };
    view.sections.services = { status: 'unavailable' };
    renderPage([ok(view)]);
    expect(await screen.findByText(PARTIAL)).toBeInTheDocument();
    expect(screen.getByText('1 of 4 sources available')).toBeInTheDocument();
    const absent: Array<[string, string]> = [['Platform summary', 'Unavailable'], ['Needs attention', 'Not configured'], ['Service health', 'Unavailable']];
    for (const [name, state] of absent) {
      const section = region(name);
      expect(section.textContent).not.toMatch(/\d/); // never a number: not 0, not a count
      expect(within(section).getAllByText(state).length).toBeGreaterThan(0);
      expect(within(section).queryByRole('link')).toBeNull();
    }
    // The state text stands in for each value: the chip and the four cards.
    expect(within(region('Platform summary')).getAllByText('Unavailable')).toHaveLength(5);
    expect(within(region('Governance signals')).getByText('Locked')).toBeInTheDocument();
  });

  it('says so when nothing needs attention', async () => {
    const view = fullView();
    view.sections.attention.items = [];
    renderPage([ok(view)]);
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByText('Nothing needs attention right now.')).toBeInTheDocument();
    expect(within(attention).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('says so when governance or services report an empty list, and renders no empty list shell', async () => {
    const view = fullView();
    view.sections.governance.signals = [];
    view.sections.services.services = [];
    renderPage([ok(view)]);
    const governance = await screen.findByRole('region', { name: 'Governance signals' });
    expect(within(governance).getByText('No signals reported.')).toBeInTheDocument();
    expect(governance.querySelector('dl, dt, dd')).toBeNull();
    const services = region('Service health');
    expect(within(services).getByText('No services reported.')).toBeInTheDocument();
    expect(services.querySelector('ul, li')).toBeNull();
    expect(screen.getByText('4 of 4 sources available')).toBeInTheDocument();
    expect(screen.queryByText(PARTIAL)).toBeNull();
  });

  it('labels a section the server calls stale "Out of date" and still shows its values, even when the page clock lags the server', async () => {
    const now = Date.now();
    const view = fullView(now + 30 * MINUTE); // the server clock runs half an hour ahead of this page
    view.sections.services.asOf = iso(now + 10 * MINUTE); // twenty minutes old by the server's clock
    view.sections.services.stale = true;
    renderPage([ok(view)]);
    const services = await screen.findByRole('region', { name: 'Service health' });
    expect(within(services).getByText('Out of date')).toBeInTheDocument();
    expect(within(services).getByText('Authentication')).toBeInTheDocument();
    expect(screen.getAllByText('Out of date')).toHaveLength(1);
  });

  it('never polls: ten minutes after the first load one request has been sent, and the UI clock only re-ages the sections', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.UTC(2026, 8, 12, 10, 30) });
    const now = Date.now();
    const { cc, unmount } = renderPage([ok(fullView(now, now - 6 * MINUTE))]);
    await screen.findByRole('region', { name: 'Platform summary' });
    expect(screen.queryByText('Out of date')).toBeNull();
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await act(async () => {
      vi.advanceTimersByTime(10 * MINUTE);
    });
    // Sixteen minutes old by the page's clock: every available section re-ages, with no request.
    expect(screen.getAllByText('Out of date')).toHaveLength(4);
    expect(cc.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0); // the clock stops with the page
    expect(cc.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['in step with the page', 0],
    ['two hours ahead of the page', 120 * MINUTE],
    ['two hours behind the page', -120 * MINUTE],
  ])('turns a reading aged past 24 hours into Unavailable, with the server clock %s: no figures, and still no request', async (_clock, skew) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.UTC(2026, 8, 12, 10, 30) });
    const server = Date.now() + skew; // ageing runs on the server's clock, so a skewed page clock changes nothing
    const view = fullView(server, server - 24 * 60 * MINUTE + MINUTE); // one minute inside the server's 24 h bound
    for (const section of Object.values(view.sections) as Json[]) section.stale = true;
    const { cc } = renderPage([ok(view)]);
    await screen.findByRole('region', { name: 'Platform summary' });
    expect(within(region('Platform summary')).getByText('48')).toBeInTheDocument();
    expect(screen.getAllByText('Out of date')).toHaveLength(4);
    await act(async () => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    // Past 24 hours by the page's clock: what the server would no longer serve is not shown either.
    expect(within(region('Platform summary')).queryByText('48')).toBeNull();
    expect(within(region('Service health')).queryByText('Authentication')).toBeNull();
    expect(screen.queryByText('Out of date')).toBeNull();
    expect(screen.getByText(PARTIAL)).toBeInTheDocument();
    expect(screen.getByText('0 of 4 sources available')).toBeInTheDocument();
    expect(cc.fetch).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body); // nothing was focused, so nothing is moved
  });

  it('moves focus to the page heading when the UI clock ages out the focused attention link', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.UTC(2026, 8, 12, 10, 30) });
    const now = Date.now();
    const view = fullView(now, now - 24 * 60 * MINUTE + MINUTE);
    for (const section of Object.values(view.sections) as Json[]) section.stale = true;
    renderPage([ok(view)]);
    const link = await screen.findByRole('link', { name: 'Open Audit & Security' });
    link.focus();
    expect(document.activeElement).toBe(link);
    await act(async () => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    expect(link.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('page-title'));
  });

  it('keeps ageing when the page clock is set back, because elapsed time also runs on a monotonic clock', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'], now: Date.UTC(2026, 8, 12, 10, 30) });
    const now = Date.now();
    const view = fullView(now, now - 24 * 60 * MINUTE + MINUTE);
    for (const section of Object.values(view.sections) as Json[]) section.stale = true;
    renderPage([ok(view)]);
    await screen.findByRole('region', { name: 'Platform summary' });
    vi.setSystemTime(now - 60 * MINUTE); // the page's wall clock jumps back an hour
    await act(async () => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    expect(within(region('Platform summary')).queryByText('48')).toBeNull();
    expect(screen.getByText('0 of 4 sources available')).toBeInTheDocument();
  });

  it('ages a kept view from its original arrival when a later refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.UTC(2026, 8, 12, 10, 30) });
    const now = Date.now();
    const view = fullView(now, now - 24 * 60 * MINUTE + 3 * MINUTE); // three minutes inside the bound
    for (const section of Object.values(view.sections) as Json[]) section.stale = true;
    const { user } = renderPage([ok(view), refused(503)]);
    await screen.findByRole('region', { name: 'Platform summary' });
    await act(async () => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findAllByText(/^Refresh failed/)).length).toBeGreaterThan(0);
    expect(within(region('Platform summary')).getByText('48')).toBeInTheDocument(); // still a minute inside the bound
    await act(async () => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    expect(within(region('Platform summary')).queryByText('48')).toBeNull(); // aged from the first arrival, not the failed refresh
  });

  it('ages the 15-minute "Out of date" chip on the server clock too, with the page clock two hours behind', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.UTC(2026, 8, 12, 10, 30) });
    const server = Date.now() + 120 * MINUTE;
    renderPage([ok(fullView(server, server - 14 * MINUTE))]); // fresh: fourteen minutes old on the server's clock
    await screen.findByRole('region', { name: 'Platform summary' });
    expect(screen.queryByText('Out of date')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    expect(screen.getAllByText('Out of date')).toHaveLength(4);
  });

  it('shows skeleton cards and says it is loading; Refresh is busy, stays focusable, and ignores clicks', async () => {
    const pending = held();
    const { cc, user } = renderPage([pending.reply]);
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    expect(liveRegion()).toHaveTextContent('Loading the Command Center…');
    const skeletons = main().querySelectorAll('.motion-safe\\:animate-pulse');
    expect(skeletons.length).toBeGreaterThanOrEqual(4);
    for (const skeleton of skeletons) expect(skeleton.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(refresh).toHaveAttribute('aria-disabled', 'true');
    expect(refresh).toBeEnabled(); // aria-disabled, never disabled: it keeps keyboard focus
    await user.click(refresh);
    expect(cc.fetch).toHaveBeenCalledTimes(1);
    await act(async () => pending.answer(json(200, fullView())));
    await screen.findByRole('region', { name: 'Platform summary' });
    expect(refresh).not.toHaveAttribute('aria-busy', 'true');
    expect(refresh).not.toHaveAttribute('aria-disabled', 'true');
  });

  it.each([
    ['a 503', refused(503)],
    ['a malformed view', ok({ ...fullView(), requestId: 'r1' })],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ] as const)('offers Try again after %s, then moves focus to the page heading once it recovers', async (_name, failure) => {
    const { cc, user } = renderPage([failure, ok(fullView())]);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(within(region('Command Center unavailable')).getByText("The Command Center didn't load. Try again in a moment.")).toBeInTheDocument();
    for (const name of DATA_SECTIONS) expect(screen.queryByRole('region', { name })).toBeNull(); // never half a view
    await user.click(retry);
    await screen.findByRole('region', { name: 'Platform summary' });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Command Center' })).toHaveFocus();
    expect(cc.fetch).toHaveBeenCalledTimes(2);
  });

  it('shows one generic panel, and no reason, when the account may not see the Command Center', async () => {
    renderPage([refused(403)]);
    const panel = await screen.findByRole('region', { name: 'Not available' });
    expect(panel).toHaveTextContent(FORBIDDEN);
    expect(liveRegion()).toHaveTextContent(FORBIDDEN);
    expect(main().textContent).not.toMatch(/permission|view_command_center|forbidden|\b403\b/i);
    for (const name of DATA_SECTIONS) expect(screen.queryByRole('region', { name })).toBeNull();
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('asks to wait after a rate limit, and keeps the data already shown', async () => {
    const { user } = renderPage([refused(429), ok(fullView()), refused(429)]);
    const panel = await screen.findByRole('region', { name: 'Please wait' });
    expect(panel).toHaveTextContent(RATE_LIMITED);
    expect(liveRegion()).toHaveTextContent(RATE_LIMITED);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const summary = await screen.findByRole('region', { name: 'Platform summary' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(liveRegion()).toHaveTextContent(RATE_LIMITED));
    expect(within(main()).getByText(RATE_LIMITED, { selector: 'p' })).toBeInTheDocument();
    expect(within(summary).getByText('12')).toBeInTheDocument();
  });

  it.each([
    ['the first load', [refused(401)], false],
    ['a refresh', [ok(fullView()), refused(401)], true],
  ] as const)('ends the page in sign-in with the expiry notice when %s answers 401', async (_name, replies, refresh) => {
    const { user } = renderPage(replies);
    if (refresh) {
      await screen.findByRole('region', { name: 'Platform summary' });
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
    }
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in to the Control Plane' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Control plane' })).toBeNull();
  });

  it('never lets an older answer replace a newer one: each load aborts the load before it', async () => {
    const calls: Array<{ signal: AbortSignal; settle: (outcome: CommandCenterOutcome) => void }> = [];
    const commandCenter: CommandCenterClient = {
      load: (signal) => new Promise<CommandCenterOutcome>((settle) => {
        calls.push({ signal, settle });
      }),
    };
    renderPage([], { strict: true, commandCenter }); // StrictMode mounts, unmounts and remounts the page
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);
    const newer = fullView();
    newer.sections.posture.metrics[0].value = 222;
    const older = fullView();
    older.sections.posture.metrics[0].value = 111;
    await act(async () => calls[1].settle({ kind: 'ok', view: newer }));
    expect(await screen.findByText('222')).toBeInTheDocument();
    await act(async () => calls[0].settle({ kind: 'ok', view: older })); // the slow first answer, last
    expect(screen.getByText('222')).toBeInTheDocument();
    expect(screen.queryByText('111')).toBeNull();
  });

  it('treats a client that rejects as unavailable, never a page stuck busy', async () => {
    const commandCenter: CommandCenterClient = { load: vi.fn(async (): Promise<CommandCenterOutcome> => Promise.reject(new Error('contract broken'))) };
    renderPage([], { commandCenter });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(retry).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy', 'true');
  });

  it('aborts the pending request when the page unmounts or the administrator navigates away', async () => {
    const first = renderPage([held().reply]);
    await waitFor(() => expect(first.cc.sent).toHaveLength(1));
    first.unmount();
    expect(first.cc.sent[0].signal?.aborted).toBe(true);

    const second = renderPage([held().reply]);
    await waitFor(() => expect(second.cc.sent).toHaveLength(1));
    await second.user.click(within(screen.getByRole('navigation', { name: 'Control plane' })).getByRole('link', { name: 'Domains' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Domains' })).toBeInTheDocument();
    expect(second.cc.sent[0].signal?.aborted).toBe(true);
    expect(second.cc.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the data it has when a refresh fails, says so, and leaves focus on Refresh', async () => {
    const at = Date.now();
    const { cc, user } = renderPage([ok(fullView(at)), refused(503)]);
    const summary = await screen.findByRole('region', { name: 'Platform summary' });
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    await user.click(refresh);
    await waitFor(() => expect(liveRegion()).toHaveTextContent(`Refresh failed — showing data from ${hhmm(at)}`));
    expect(within(main()).getByText('Refresh failed — showing data from', { selector: 'p' })).toHaveTextContent(hhmm(at));
    expect(within(summary).getByText('12')).toBeInTheDocument();
    expect(refresh).toHaveFocus();
    expect(cc.fetch).toHaveBeenCalledTimes(2);
  });

  it('announces each load in one persistent status region, and keeps focus on Refresh', async () => {
    const first = Date.now() - 5 * MINUTE;
    const second = Date.now();
    const pending = held();
    const { user } = renderPage([ok(fullView(first)), pending.reply]);
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    const status = liveRegion();
    await waitFor(() => expect(status).toHaveTextContent(`Command Center updated at ${hhmm(first)}`));
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    await user.click(refresh);
    expect(status).toHaveTextContent('Loading the Command Center…');
    await act(async () => pending.answer(json(200, fullView(second))));
    await waitFor(() => expect(status).toHaveTextContent(`Command Center updated at ${hhmm(second)}`));
    expect(liveRegion()).toBe(status);
    expect(refresh).toHaveFocus();
  });

  it('moves focus to the page heading when a refresh removes the focused element, and leaves it on a live one', async () => {
    const pending = held();
    const gone = fullView();
    gone.sections.attention.items = gone.sections.attention.items.filter((item: Json) => item.area !== 'security');
    const { user } = renderPage([ok(fullView()), pending.reply, ok(gone)]);
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    await user.click(refresh);
    const link = within(attention).getByRole('link', { name: 'Open Audit & Security' });
    act(() => link.focus()); // the administrator moves on while the refresh runs
    expect(link).toHaveFocus();
    await act(async () => pending.answer(json(200, gone)));
    await waitFor(() => expect(within(region('Needs attention')).queryByRole('link', { name: 'Open Audit & Security' })).toBeNull());
    expect(document.activeElement).toBe(document.getElementById('page-title'));
    expect(screen.getByRole('heading', { level: 1, name: 'Command Center' })).toHaveFocus();

    await user.click(refresh); // a plain refresh whose button survives keeps its focus
    await waitFor(() => expect(refresh).not.toHaveAttribute('aria-busy', 'true'));
    expect(refresh).toHaveFocus();
  });

  it('offers no action beyond Refresh and Try again, and links only to console workspaces', async () => {
    const { user } = renderPage([refused(503), ok(fullView())]);
    await screen.findByRole('button', { name: 'Try again' });
    const inMain = () => within(main()).getAllByRole('button').map((button) => button.textContent?.trim());
    expect(new Set(inMain())).toEqual(new Set(['Refresh', 'Try again']));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('region', { name: 'Platform summary' });
    expect(inMain()).toEqual(['Refresh']);
    for (const button of screen.getAllByRole('button', { hidden: true })) {
      expect(`${button.textContent} ${button.getAttribute('aria-label') ?? ''}`).not.toMatch(MUTATION);
    }
    expect(main().querySelector('form, input, select, textarea')).toBeNull();
    const workspaces = new Set(['/admin', ...CONSOLE_MODULES.map(modulePath)]);
    for (const link of within(main()).getAllByRole('link')) expect(workspaces.has(link.getAttribute('href') ?? '')).toBe(true);
  });
});
