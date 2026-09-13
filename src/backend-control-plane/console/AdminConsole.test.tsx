// Phase 4.0 M4 — the administration console end to end in jsdom: the real session client over a
// scripted server, a scripted identity provider, and the real routes and shell.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { inspect } from 'node:util';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AdminConsoleApp, { ConsoleProvider, ConsoleRoutes } from './AdminConsoleApp';
import type { AdminIdentityProvider, IdentityOutcome, SecondFactorChallenge } from './adminIdentity';
import { createAdminSessionClient } from './adminSessionClient';
import { currentSurface } from './adminSurface';
import { createCommandCenterClient } from './commandCenterClient';
import { CONSOLE_MODULES, modulePath } from './navigation';

const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQtc3ludGhldGljLTdmM2EifQ.c2lnbmF0dXJl';
const UID = 'uid-synthetic-7f3a';
const CSRF = 'k'.repeat(43);
const EMAIL = 'ops@tmpos.test';
const PASSWORD = 'correct horse';
const CODE = '482915';
const WRONG_CODE = '730264';
// The provider port carries only coarse outcomes, so provider error text cannot reach this layer
// (firebaseAdminIdentity.test.tsx proves the reduction); nothing typed into the sign-in form (the
// email, the password, a code) may be rendered into the markup or logged.
const SENSITIVE = [ID_TOKEN, UID, CSRF, EMAIL, PASSWORD, CODE, WRONG_CODE];

const DENIED = 'Sign-in failed. Check your details and try again.';
const RATE_LIMITED = 'Too many attempts. Wait a few minutes, then try again.';
const UNAVAILABLE = 'Sign-in is temporarily unavailable.';

const GET = 'GET /admin/v1/session';
const LOGIN = 'POST /admin/v1/session/login';
const LOGOUT = 'POST /admin/v1/session/logout';

type Answer = number | 'active';
type Script = Readonly<Record<string, readonly Answer[]>>;
interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** A scripted server keyed by "METHOD path"; each key answers from its queue and repeats the last answer. */
function fakeServer(script: Script) {
  const sent: Sent[] = [];
  const queues = new Map(Object.entries(script).map(([key, answers]) => [key, [...answers]]));
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const url = String(input);
    sent.push({ method, url, headers: new Headers(init.headers), body: init.body });
    const queue = queues.get(`${method} ${url}`) ?? [];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer === undefined) return new Response(null, { status: 404 });
    if (answer === 'active') {
      return new Response(JSON.stringify({ status: 'active', csrfToken: CSRF }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(answer === 204 ? null : JSON.stringify({ error: 'refused', requestId: 'r1' }), {
      status: answer,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { sent, fetch };
}

const identityOf = (outcome: IdentityOutcome | (() => Promise<IdentityOutcome>)) => ({
  signIn: vi.fn<AdminIdentityProvider['signIn']>(async () => (typeof outcome === 'function' ? outcome() : outcome)),
});

function challengeOf(result: IdentityOutcome, factors: SecondFactorChallenge['factors'] = ['totp']) {
  return {
    factors,
    verify: vi.fn<SecondFactorChallenge['verify']>(async () => result),
    cancel: vi.fn<SecondFactorChallenge['cancel']>(async () => undefined),
  };
}

const TOKEN_OUTCOME: IdentityOutcome = { kind: 'token', idToken: ID_TOKEN };

/**
 * The Command Center rides its own scripted fetch, so the session request sequences below stay
 * exact. It answers every read with a view whose sources are all not configured
 * (CommandCenter.test.tsx covers the page itself).
 */
function commandCenterServer() {
  const absent = { status: 'not_configured' };
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), sections: { posture: absent, attention: absent, governance: absent, services: absent } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  return { fetch, client: createCommandCenterClient({ fetch: fetch as unknown as typeof globalThis.fetch }) };
}

function renderConsole(
  script: Script,
  identity: AdminIdentityProvider = identityOf({ kind: 'failed', failure: 'unavailable' }),
  path: string | { pathname: string; state: unknown } = '/admin',
) {
  const server = fakeServer(script);
  const commandCenter = commandCenterServer();
  const client = createAdminSessionClient({ fetch: server.fetch as unknown as typeof fetch });
  const view = render(
    <ConsoleProvider client={client} identity={identity} commandCenter={commandCenter.client}>
      <MemoryRouter initialEntries={[path]}>
        <ConsoleRoutes />
      </MemoryRouter>
    </ConsoleProvider>,
  );
  return { ...view, server, commandCenter, user: userEvent.setup() };
}

const requests = (sent: readonly Sent[], key: string) => sent.filter((request) => `${request.method} ${request.url}` === key);

/** What is typed lives only in the fields' values: never in an attribute, so never in the markup. */
function expectNothingTypedInMarkup(...typed: string[]) {
  const html = document.documentElement.outerHTML;
  for (const value of [EMAIL, PASSWORD, ...typed]) expect(html).not.toContain(value);
}

/** A native submission (an extension calling form.submit() skips onSubmit) would carry nothing: no field is named. */
function expectNothingSubmittable(button: HTMLElement) {
  expect([...new FormData(button.closest('form') as HTMLFormElement).keys()]).toEqual([]);
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Email'), EMAIL);
  await user.type(screen.getByLabelText('Password'), PASSWORD);
  expect(screen.getByLabelText('Email')).toHaveValue(EMAIL);
  expectNothingTypedInMarkup();
  const submit = screen.getByRole('button', { name: 'Sign in' });
  expectNothingSubmittable(submit);
  await user.click(submit);
}

async function verifyCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const field = await screen.findByLabelText('Verification code');
  expect(field).toHaveValue(''); // never inherits another field's value (e.g. the email)
  await user.type(field, code);
  expect(field).toHaveValue(code);
  expectNothingTypedInMarkup(code);
  const verify = screen.getByRole('button', { name: 'Verify' });
  expectNothingSubmittable(verify);
  await user.click(verify);
}

const sidebar = () => screen.getByRole('navigation', { name: 'Control plane' });

let setItem: ReturnType<typeof vi.spyOn>;
let cookieRead: ReturnType<typeof vi.spyOn>;
let logged: unknown[][];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Declared second, so it runs first (vitest runs after-hooks as a stack), while the DOM is still mounted.
afterEach(() => {
  try {
    // Nothing the console handled — the ID token, the provider UID, the session CSRF token, a
    // provider error — was stored, rendered or logged, and the HttpOnly cookie was never read.
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
    cleanup(); // a failed check must not leave this console mounted under the next test
  }
});

describe('console sign-in', () => {
  it('checks the session first, then offers sign-in when there is none', async () => {
    renderConsole({ [GET]: [401] });
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
    expect(await screen.findByRole('heading', { name: 'Sign in to the Control Plane' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.queryByRole('navigation', { name: 'Control plane' })).toBeNull();
  });

  it('exchanges the provider token for a server session and shows the shell only once the server confirms it', async () => {
    const identity = identityOf(TOKEN_OUTCOME);
    const { server, user } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identity);
    await signIn(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();
    // The shell focuses the heading in an effect after the commit that renders it (ConsoleShell), so wait for it.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Command Center' })).toHaveFocus()); // arriving from sign-in
    expect(identity.signIn).toHaveBeenCalledWith({ method: 'password', email: EMAIL, password: PASSWORD });
    const [login] = requests(server.sent, LOGIN);
    expect(requests(server.sent, LOGIN)).toHaveLength(1);
    expect(login.headers.get('authorization')).toBe(`Bearer ${ID_TOKEN}`);
    expect(login.headers.get('x-tmpos-csrf')).toBe('1');
    expect(login.body).toBeUndefined();
    expect(server.sent.map((request) => `${request.method} ${request.url}`)).toEqual([GET, LOGIN, GET]); // the read that confirms it
  });

  it('loads the shell only once a session read after the login confirms it', async () => {
    const { server, user } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identityOf(TOKEN_OUTCOME));
    await screen.findByLabelText('Email'); // the first read has answered
    const answer = server.fetch.getMockImplementation()!;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.fetch.mockImplementation(async (input, init = {}) => {
      if ((init.method ?? 'GET') === 'GET') await released;
      return answer(input, init);
    });
    await signIn(user);
    await waitFor(() => expect(server.fetch).toHaveBeenCalledTimes(3)); // the first read, the login, the confirming read
    expect(screen.queryByRole('navigation', { name: 'Control plane' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Signing in…');
    await act(async () => release());
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();
    expect(server.sent.map((request) => `${request.method} ${request.url}`)).toEqual([GET, LOGIN, GET]);
  });

  it('starts one sign-in however often the form is submitted', async () => {
    let finish!: (outcome: IdentityOutcome) => void;
    const identity = identityOf(() => new Promise<IdentityOutcome>((resolve) => { finish = resolve; }));
    const { server, user } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identity);
    await user.type(await screen.findByLabelText('Email'), 'ops@tmpos.test');
    await user.type(screen.getByLabelText('Password'), 'pw');
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(identity.signIn).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Password')).toHaveValue(''); // not kept once submitted
    expect(screen.getByRole('status')).toHaveTextContent('Signing in…');
    await act(async () => finish(TOKEN_OUTCOME));
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    expect(requests(server.sent, LOGIN)).toHaveLength(1);
  });

  it('asks for the second factor when the provider requires it, then signs in with the verified token', async () => {
    const challenge = challengeOf(TOKEN_OUTCOME);
    const { user } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identityOf({ kind: 'second-factor', challenge }));
    await signIn(user);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Two-step verification' })).toHaveFocus()); // focused by a post-commit effect
    expect(screen.getByText('Enter the 6-digit code from your authenticator app.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull(); // one enrolment: nothing to choose
    const field = screen.getByLabelText('Verification code');
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await user.type(field, '12a');
    expect(field).toHaveValue('12'); // digits only
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the 6-digit code.');
    expect(challenge.verify).not.toHaveBeenCalled();
    await user.clear(field);
    await user.paste(`${CODE.slice(0, 3)} ${CODE.slice(3)}`); // as an authenticator app displays it
    expect(field).toHaveValue(CODE); // no digit lost to a separator
    expectNothingTypedInMarkup(CODE);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(challenge.verify).toHaveBeenCalledWith(0, CODE);
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();
  });

  it('offers authenticator-app codes only: a choice between enrolments, the code cleared on each switch and once submitted', async () => {
    let finish!: (outcome: IdentityOutcome) => void;
    const challenge = challengeOf(TOKEN_OUTCOME, ['totp', 'totp']);
    challenge.verify.mockImplementationOnce(() => new Promise<IdentityOutcome>((resolve) => { finish = resolve; }));
    const { user } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identityOf({ kind: 'second-factor', challenge }));
    await signIn(user);
    const methods = await screen.findByRole('radiogroup', { name: 'Verification method' });
    expect(screen.queryByText(/text message|send code/i)).toBeNull();
    await user.type(screen.getByLabelText('Verification code'), '48');
    await user.click(within(methods).getAllByRole('radio', { name: 'Authenticator app' })[1]);
    expect(screen.getByLabelText('Verification code')).toHaveValue('');
    await verifyCode(user, CODE);
    expect(challenge.verify).toHaveBeenCalledWith(1, CODE);
    expect(screen.getByLabelText('Verification code')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Verifying…');
    await act(async () => finish(TOKEN_OUTCOME));
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();
  });

  it.each([
    ['the provider rejects the credentials', () => identityOf({ kind: 'failed', failure: 'rejected' }), { [GET]: [401] }],
    // The provider refuses a phone-only account as 'rejected' (firebaseAdminIdentity.test.tsx: no reCAPTCHA is created).
    ['the provider refuses a phone-only account', () => identityOf({ kind: 'failed', failure: 'rejected' }), { [GET]: [401] }],
    ['the server refuses the exchange with 401', () => identityOf(TOKEN_OUTCOME), { [GET]: [401], [LOGIN]: [401] }],
    ['the server refuses the exchange with 403', () => identityOf(TOKEN_OUTCOME), { [GET]: [401], [LOGIN]: [403] }],
    ['the session read after the login is refused with 403', () => identityOf(TOKEN_OUTCOME), { [LOGIN]: ['active'], [GET]: [401, 403] }],
  ] as const)('reads the same whatever failed: %s', async (_name, identity, script) => {
    const { user } = renderConsole(script, identity());
    await signIn(user);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toBe(DENIED);
    expectNothingTypedInMarkup(); // after a failed attempt as well as while typing
    expect(screen.queryByRole('navigation', { name: 'Control plane' })).toBeNull();
  });

  it('treats a failed second factor as the same generic denial and starts over', async () => {
    const challenge = challengeOf({ kind: 'failed', failure: 'rejected' });
    const { user } = renderConsole({ [GET]: [401] }, identityOf({ kind: 'second-factor', challenge }));
    await signIn(user);
    await verifyCode(user, WRONG_CODE);
    expect((await screen.findByRole('alert')).textContent).toBe(DENIED);
    expect(screen.getByRole('heading', { name: 'Sign in to the Control Plane' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue(EMAIL); // offered again, as the field's value only
    expectNothingTypedInMarkup(WRONG_CODE);
  });

  it.each([
    ['the server rate-limits the exchange', () => identityOf(TOKEN_OUTCOME), { [GET]: [401], [LOGIN]: [429] }, RATE_LIMITED],
    ['the provider rate-limits the sign-in', () => identityOf({ kind: 'failed', failure: 'rate-limited' }), { [GET]: [401] }, RATE_LIMITED],
    ['the provider is unreachable', () => identityOf({ kind: 'failed', failure: 'unavailable' }), { [GET]: [401] }, UNAVAILABLE],
    ['the session service fails the exchange', () => identityOf(TOKEN_OUTCOME), { [GET]: [401], [LOGIN]: [503] }, UNAVAILABLE],
    ['the session read after the login finds no session', () => identityOf(TOKEN_OUTCOME), { [LOGIN]: ['active'], [GET]: [401] }, UNAVAILABLE],
  ] as const)('keeps a rate limit or an outage distinct from a denial: %s', async (_name, identity, script, text) => {
    const { user } = renderConsole(script, identity());
    await signIn(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText(DENIED)).toBeNull();
    expectNothingTypedInMarkup();
  });

  it('disables sign-in while the session service is unavailable, until a retry reaches it', async () => {
    const { user } = renderConsole({ [GET]: [503, 401] });
    expect(await screen.findByRole('alert')).toHaveTextContent(UNAVAILABLE);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('returns an expired session to sign-in and resumes the page afterwards', async () => {
    const { user } = renderConsole({ [GET]: ['active', 401, 'active'], [LOGIN]: ['active'] }, identityOf(TOKEN_OUTCOME), '/admin/audit-security');
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit & Security' })).toBeInTheDocument();
    await user.click(within(sidebar()).getByRole('link', { name: 'Support Tools' }));
    expect(await screen.findByText('Your session has ended. Sign in again to continue.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in to the Control Plane' })).toHaveFocus()); // focused by a post-commit effect
    await signIn(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Support Tools' })).toBeInTheDocument();
  });

  it('sends an unknown console address to the Command Center', async () => {
    const { user } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identityOf(TOKEN_OUTCOME), '/admin/not-a-page');
    await signIn(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();
  });

  it('never shows a console page for an API address, and never redirects it, signed in or not', async () => {
    // In-page navigation follows the one canonical rule too: the tenant namespace and an encoded
    // separator are API addresses, never the console home.
    const cases = [
      ['/admin/v1', 401], ['/admin/v1/session', 'active'], ['/ADMIN/V1/session/login', 401],
      ['/api/v1/session', 'active'], ['/admin%2Fv1/session', 401],
    ] as const;
    for (const [path, answer] of cases) {
      const server = fakeServer({ [GET]: [answer] });
      const client = createAdminSessionClient({ fetch: server.fetch as unknown as typeof fetch });
      const commandCenter = commandCenterServer();
      const seen: string[] = [];
      function Where() {
        seen.push(useLocation().pathname);
        return null;
      }
      const { unmount } = render(
        <ConsoleProvider client={client} identity={identityOf(TOKEN_OUTCOME)} commandCenter={commandCenter.client}>
          <MemoryRouter initialEntries={[path]}>
            <ConsoleRoutes />
            <Where />
          </MemoryRouter>
        </ConsoleProvider>,
      );
      await waitFor(() => expect(client.getState().phase).not.toBe('checking')); // the session read has answered
      expect(screen.getByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Control plane' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Sign in to the Control Plane' })).toBeNull();
      expect(new Set(seen)).toEqual(new Set([path])); // the address was never rewritten
      expect(commandCenter.fetch).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('ignores a return path that is not exactly a console page', async () => {
    const hostile = { pathname: '/admin/sign-in', state: { returnTo: '/admin/command-center?next=//evil.test' } };
    const { user } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identityOf(TOKEN_OUTCOME), hostile);
    await signIn(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();
  });

  it('discards the provider session when the second factor is abandoned or the page goes away', async () => {
    const challenge = challengeOf(TOKEN_OUTCOME);
    const { user, unmount } = renderConsole({ [GET]: [401] }, identityOf({ kind: 'second-factor', challenge }));
    await signIn(user);
    await user.click(await screen.findByRole('button', { name: 'Use a different account' }));
    expect(challenge.cancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in to the Control Plane' })).toHaveFocus()); // focused by a post-commit effect
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Two-step verification' });
    unmount();
    expect(challenge.cancel).toHaveBeenCalledTimes(2);
  });

  it('never exchanges a token that arrives after the page is gone', async () => {
    let finish!: (outcome: IdentityOutcome) => void;
    const identity = identityOf(() => new Promise<IdentityOutcome>((resolve) => { finish = resolve; }));
    const { server, user, unmount } = renderConsole({ [GET]: [401, 'active'], [LOGIN]: ['active'] }, identity);
    await signIn(user);
    unmount();
    await act(async () => finish(TOKEN_OUTCOME));
    expect(server.sent.some((request) => request.method === 'POST')).toBe(false);
  });
});

describe('console shell', () => {
  it('signs out with the session CSRF token and the intent header, then forgets the session', async () => {
    const { server, user } = renderConsole({ [GET]: ['active'], [LOGOUT]: [204] });
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    const account = screen.getByRole('button', { name: 'Account menu' });
    await user.click(account);
    expect(account).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Administrator session')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You have signed out.')).toBeInTheDocument();
    const [logout] = requests(server.sent, LOGOUT);
    expect(logout.headers.get('x-tmpos-session-csrf')).toBe(CSRF);
    expect(logout.headers.get('x-tmpos-csrf')).toBe('1');
    expect(logout.headers.get('authorization')).toBeNull();
    expect(logout.body).toBeUndefined();
  });

  it('keeps the session hidden and says so when a sign-out cannot be confirmed, and while it is retried', async () => {
    const { server, user } = renderConsole({ [GET]: ['active', 503], [LOGOUT]: [503] });
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText("Sign-out didn't complete. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Control plane unavailable' })).toBeInTheDocument();
    expect(screen.getByText('Session unconfirmed')).toBeInTheDocument();
    // The retry's answer is held back: the unconfirmed session's content stays hidden meanwhile.
    server.fetch.mockImplementationOnce(
      (_input, init = {}) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Signing out…')).toBeInTheDocument();
    expect(screen.queryAllByText('Coming later')).toHaveLength(0);
    // Nor does the header call the session active while it is being ended.
    expect(screen.getByText('Signing out')).toBeInTheDocument();
    expect(screen.queryByText('Session active')).toBeNull();
  });

  it('closes the account menu and the navigation drawer on Escape and returns focus to their buttons', async () => {
    const { user } = renderConsole({ [GET]: ['active'] });
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    const account = screen.getByRole('button', { name: 'Account menu' });
    await user.click(account);
    await user.keyboard('{Escape}');
    expect(account).toHaveAttribute('aria-expanded', 'false');
    expect(account).toHaveFocus();
    const open = screen.getByRole('button', { name: 'Open navigation' });
    await user.click(open);
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('button', { name: 'Close navigation' })).toHaveFocus();
    expect(open).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveFocus();
  });

  it('navigates from the drawer, closes it, and moves focus to the new page title', async () => {
    const { user } = renderConsole({ [GET]: ['active'] });
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    await user.click(within(drawer).getByRole('link', { name: 'Domains' }));
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Domains' })).toHaveFocus());
  });

  it('offers a skip link first, then the navigation, with every landmark labelled', async () => {
    const { user } = renderConsole({ [GET]: ['active'] });
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
    await user.tab();
    expect(within(sidebar()).getByRole('link', { name: 'Command Center' })).toHaveFocus();
    await user.tab();
    expect(within(sidebar()).getByRole('link', { name: 'Audit & Security' })).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('shows every workspace as coming later, with no action and no request beyond the session read', async () => {
    for (const module of CONSOLE_MODULES) {
      const { server, commandCenter, unmount } = renderConsole({ [GET]: ['active'] }, undefined, modulePath(module));
      expect(await screen.findByRole('heading', { level: 1, name: module.label })).toBeInTheDocument();
      const main = screen.getByRole('main');
      expect(within(main).getAllByText('Coming later').length).toBeGreaterThan(0);
      expect(within(main).queryAllByRole('button')).toHaveLength(0);
      expect(main.querySelector('form, input, select, textarea')).toBeNull();
      for (const link of within(main).getAllByRole('link')) expect(link.getAttribute('href')).toMatch(/^\/admin(\/[a-z-]+)?$/);
      expect(server.sent.map((request) => `${request.method} ${request.url}`)).toEqual([GET]);
      expect(commandCenter.fetch).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('opens on the one Command Center, where an old Command Center address also lands', async () => {
    for (const path of ['/admin', '/admin/command-center']) {
      const commandCenter = commandCenterServer();
      const where: string[] = [];
      function Path() {
        where.push(useLocation().pathname);
        return null;
      }
      const client = createAdminSessionClient({ fetch: fakeServer({ [GET]: ['active'] }).fetch as unknown as typeof fetch });
      const { unmount } = render(
        <ConsoleProvider client={client} identity={identityOf(TOKEN_OUTCOME)} commandCenter={commandCenter.client}>
          <MemoryRouter initialEntries={[path]}>
            <ConsoleRoutes />
            <Path />
          </MemoryRouter>
        </ConsoleProvider>,
      );
      expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeInTheDocument();
      await waitFor(() => expect(where.at(-1)).toBe('/admin')); // the redirect runs once the session is confirmed
      expect(within(sidebar()).getAllByRole('link', { name: 'Command Center' })).toHaveLength(1);
      expect(within(sidebar()).getByRole('link', { name: 'Command Center' })).toHaveAttribute('aria-current', 'page');
      expect(await screen.findByText('0 of 4 sources available')).toBeInTheDocument();
      expect(commandCenter.fetch).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('hides workspace content while the server cannot confirm the session, and restores it on retry', async () => {
    const { user } = renderConsole({ [GET]: ['active', 503, 'active'] });
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    await user.click(within(sidebar()).getByRole('link', { name: 'Domains' }));
    expect(await screen.findByRole('heading', { name: 'Control plane unavailable' })).toBeInTheDocument();
    expect(screen.queryByText('Coming later')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Coming later')).toBeInTheDocument();
  });

  it('is never authenticated by a tenant session, and never asks the tenant boundary', async () => {
    const { server } = renderConsole({ 'GET /api/v1/session': ['active'], [GET]: [401] });
    expect(await screen.findByRole('heading', { name: 'Sign in to the Control Plane' })).toBeInTheDocument();
    expect(server.sent.length).toBeGreaterThan(0);
    expect(server.sent.every((request) => request.url.startsWith('/admin/v1/session'))).toBe(true);
  });

  it('refuses on a non-administration address without making any request', () => {
    const fetchSpy = vi.fn();
    render(
      <AdminConsoleApp
        surface="admin-refused"
        services={{
          client: createAdminSessionClient({ fetch: fetchSpy as unknown as typeof fetch }),
          identity: identityOf(TOKEN_OUTCOME),
          commandCenter: createCommandCenterClient({ fetch: fetchSpy as unknown as typeof fetch }),
        }}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Not available on this address' })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('surface selection', () => {
  it('follows the production rule unless the Vite dev server itself serves the page', () => {
    // Vitest serves modules through Vite's dev module runner, so import.meta.hot exists here as it does
    // under the dev server; every build folds it to undefined, and the build check and the browser
    // suite prove the branch is absent from production bundles.
    expect(import.meta.hot).toBeDefined();
    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');
    expect(currentSurface({ origin: 'http://127.0.0.1:5000', pathname: '/admin' })).toBe('admin');
    vi.stubEnv('MODE', 'production'); // a build run with a stray NODE_ENV=development
    expect(currentSurface({ origin: 'http://127.0.0.1:5000', pathname: '/admin' })).toBe('admin-refused');
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ADMIN_CONSOLE_ORIGINS', 'https://admin.tmpos.test');
    expect(currentSurface({ origin: 'http://127.0.0.1:5000', pathname: '/admin' })).toBe('admin-refused');
    expect(currentSurface({ origin: 'https://admin.tmpos.test', pathname: '/' })).toBe('admin');
    expect(currentSurface({ origin: 'https://tenant.tmpos.test', pathname: '/' })).toBe('tenant');
  });

  it('settles an API address before every other rule, under the dev server and in production', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');
    for (const pathname of ['/admin/v1', '/admin/v1/session', '/api/v1/session', '/ADMIN/V1%2fsession']) {
      expect(currentSurface({ origin: 'http://127.0.0.1:5000', pathname })).toBe('api-path');
    }
    expect(currentSurface({ origin: 'http://127.0.0.1:5000', pathname: '/admin/sign-in' })).toBe('admin');
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ADMIN_CONSOLE_ORIGINS', 'https://admin.tmpos.test');
    for (const origin of ['https://admin.tmpos.test', 'https://tenant.tmpos.test', 'http://127.0.0.1:5000']) {
      for (const pathname of ['/admin/v1', '/admin/v1/session/login', '/api/v1/session', '//admin/v1/session']) {
        expect(currentSurface({ origin, pathname }), `${origin}${pathname}`).toBe('api-path');
      }
    }
    expect(currentSurface({ origin: 'https://admin.tmpos.test', pathname: '/admin/v10' })).toBe('admin');
    expect(currentSurface({ origin: 'https://tenant.tmpos.test', pathname: '/api/v2' })).toBe('tenant');
  });
});
