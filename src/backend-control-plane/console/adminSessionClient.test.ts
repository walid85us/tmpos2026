// Phase 4.0 M4 — the administration session client against a scripted fetch: what it sends,
// what it keeps, and which answers it believes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_SESSION_PATHS, createAdminSessionClient } from './adminSessionClient';

const CSRF = 'c'.repeat(43);
const FRESH_CSRF = 'f'.repeat(43);
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQtc3ludGhldGljIn0.c2lnbmF0dXJl';

type Reply = Response | Error | (() => Promise<Response>);
interface Sent {
  readonly method: string;
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
}

const json = (status: number, body: unknown, type = 'application/json'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const active = (csrf = CSRF): Response => json(200, { status: 'active', csrfToken: csrf });
const refused = (status: number): Response => json(status, { error: 'refused', requestId: 'r1' });
const noContent = (): Response => new Response(null, { status: 204 });

/** A fetch that answers from a script, records every request and, like a browser, rejects on abort. */
function scripted(replies: Reply[], { honourAbort = true } = {}) {
  const sent: Sent[] = [];
  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ method: init.method ?? 'GET', url: String(input), init, headers: new Headers(init.headers) });
    const reply = replies.shift();
    return new Promise<Response>((resolve, reject) => {
      if (honourAbort) init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      if (reply === undefined) return reject(new Error('unscripted request'));
      if (reply instanceof Error) return reject(reply);
      Promise.resolve(typeof reply === 'function' ? reply() : reply).then(resolve, reject);
    });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

/** A reply the test answers later. */
function held(): { reply: () => Promise<Response>; answer: (response: Response) => void } {
  let answer!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  return { reply: () => pending, answer };
}

const ADMIN_PATHS: readonly string[] = Object.values(ADMIN_SESSION_PATHS);
function assertAdminBoundaryOnly(sent: readonly Sent[]): void {
  for (const request of sent) {
    assert.ok(ADMIN_PATHS.includes(request.url), `left the admin session boundary: ${request.url}`);
    assert.equal(request.headers.get('cookie'), null, 'a cookie header was constructed by script');
  }
}

const signedOut = (notice: string | null) => ({ phase: 'signed-out', notice });
const ACTIVE = { phase: 'active', interrupted: false, signOutFailed: false };

test('an active session is published without its CSRF token, read same-origin with credentials', async () => {
  const net = scripted([active()]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  assert.deepEqual(client.getState(), { phase: 'checking' });
  await client.bootstrap();
  assert.deepEqual(client.getState(), ACTIVE);
  assert.ok(!JSON.stringify(client.getState()).includes(CSRF));
  const [read] = net.sent;
  assert.equal(read.method, 'GET');
  assert.equal(read.url, ADMIN_SESSION_PATHS.current);
  assert.equal(read.init.credentials, 'include');
  assert.equal(read.init.mode, 'same-origin');
  assert.equal(read.init.cache, 'no-store');
  assert.equal(read.init.redirect, 'error');
  assert.equal(read.headers.get('authorization'), null);
  assert.equal(read.headers.get('x-tmpos-session-csrf'), null);
  assertAdminBoundaryOnly(net.sent);
});

const FIRST_READS: ReadonlyArray<[string, () => Reply, unknown]> = [
  ['401 is simply signed out', () => refused(401), signedOut(null)],
  ['403 is the generic denial', () => refused(403), signedOut('denied')],
  ['429 is a rate limit', () => refused(429), signedOut('rate-limited')],
  ['503 is an outage', () => refused(503), signedOut('unavailable')],
  ['a 200 that is not JSON (an SPA fallback page) is an outage', () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }), signedOut('unavailable')],
  ['a 200 without a well-formed token is an outage', () => json(200, { status: 'active', csrfToken: 'short' }), signedOut('unavailable')],
  // Exact media type: a JSON-suffixed type is not JSON, however valid its body looks.
  ['a 200 typed application/json-patch+json is not a confirmation', () => json(200, { status: 'active', csrfToken: CSRF }, 'application/json-patch+json'), signedOut('unavailable')],
  ['a 200 typed application/json with parameters is a confirmation', () => json(200, { status: 'active', csrfToken: CSRF }, 'Application/JSON ; charset=utf-8'), ACTIVE],
  ['a network failure is an outage', () => new TypeError('network'), signedOut('unavailable')],
];
for (const [name, reply, expected] of FIRST_READS) {
  test(`first read: ${name}`, async () => {
    const client = createAdminSessionClient({ fetch: scripted([reply()]).fetch });
    await client.bootstrap();
    assert.deepEqual(client.getState(), expected);
  });
}

test('an unconfirmed re-read hides a held session without ending it; a later 401 reads as an expiry', async () => {
  const client = createAdminSessionClient({ fetch: scripted([active(), refused(503), active(), refused(401)]).fetch });
  await client.bootstrap();
  await client.bootstrap();
  assert.deepEqual(client.getState(), { phase: 'active', interrupted: true, signOutFailed: false });
  await client.bootstrap();
  assert.deepEqual(client.getState(), ACTIVE);
  await client.bootstrap();
  assert.deepEqual(client.getState(), signedOut('expired'));
});

test('the login exchange is one bodiless POST with the Bearer and the intent header; the token goes nowhere else', async () => {
  const net = scripted([refused(401), active(), active(), noContent()]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.bootstrap();
  const exchanged = client.exchange(ID_TOKEN);
  assert.deepEqual(client.getState(), { phase: 'signing-in' });
  await exchanged;
  assert.deepEqual(client.getState(), ACTIVE);
  const login = net.sent[1];
  assert.equal(login.method, 'POST');
  assert.equal(login.url, ADMIN_SESSION_PATHS.login);
  assert.equal(login.headers.get('authorization'), `Bearer ${ID_TOKEN}`);
  assert.equal(login.headers.get('x-tmpos-csrf'), '1');
  assert.equal(login.headers.get('content-type'), null);
  assert.equal(login.init.body, undefined);
  assert.equal(login.init.credentials, 'include');
  await client.logout();
  assert.deepEqual(
    net.sent.map((request) => `${request.method} ${request.url}`),
    ['GET /admin/v1/session', 'POST /admin/v1/session/login', 'GET /admin/v1/session', 'POST /admin/v1/session/logout'],
  );
  for (const request of [net.sent[0], net.sent[2], net.sent[3]]) assert.equal(request.headers.get('authorization'), null);
  assert.ok(!JSON.stringify(client.getState()).includes(ID_TOKEN));
  assertAdminBoundaryOnly(net.sent);
});

const LOGIN_ANSWERS: ReadonlyArray<[string, () => Reply, string]> = [
  ['401', () => refused(401), 'denied'],
  ['403', () => refused(403), 'denied'],
  ['429', () => refused(429), 'rate-limited'],
  ['503', () => refused(503), 'unavailable'],
  ['a network failure', () => new TypeError('network'), 'unavailable'],
  ['a 200 without a token', () => json(200, { status: 'active' }), 'unavailable'],
];
for (const [name, reply, notice] of LOGIN_ANSWERS) {
  test(`a login answered with ${name} ends signed out (${notice}) holding nothing to log out with`, async () => {
    const net = scripted([reply()]);
    const client = createAdminSessionClient({ fetch: net.fetch });
    await client.exchange(ID_TOKEN);
    assert.deepEqual(client.getState(), signedOut(notice));
    await client.logout();
    assert.equal(net.sent.length, 1);
  });
}

/** Let queued promise work settle until `check` holds (bounded). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a login is published only once a session read confirms it, and the read supplies the CSRF token', async () => {
  const confirm = held();
  const net = scripted([active(), confirm.reply, noContent()]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  const exchanged = client.exchange(ID_TOKEN);
  await until(() => net.sent.length === 2);
  assert.deepEqual(client.getState(), { phase: 'signing-in' });
  const read = net.sent[1];
  assert.equal(`${read.method} ${read.url}`, 'GET /admin/v1/session');
  assert.equal(read.headers.get('authorization'), null);
  confirm.answer(active(FRESH_CSRF));
  await exchanged;
  assert.deepEqual(client.getState(), ACTIVE);
  await client.logout();
  assert.equal(net.sent[2].headers.get('x-tmpos-session-csrf'), FRESH_CSRF);
});

const CONFIRMING_READS: ReadonlyArray<[string, () => Reply, string]> = [
  ['401 (the session never reached the browser)', () => refused(401), 'unavailable'],
  ['403', () => refused(403), 'denied'],
  ['429', () => refused(429), 'rate-limited'],
  ['503', () => refused(503), 'unavailable'],
  ['a network failure', () => new TypeError('network'), 'unavailable'],
];
for (const [name, reply, notice] of CONFIRMING_READS) {
  test(`a login whose confirming read is answered with ${name} ends signed out (${notice}) and never resends the token`, async () => {
    const net = scripted([active(), reply()]);
    const client = createAdminSessionClient({ fetch: net.fetch });
    await client.exchange(ID_TOKEN);
    assert.deepEqual(client.getState(), signedOut(notice));
    assert.deepEqual(net.sent.map((request) => `${request.method} ${request.url}`), ['POST /admin/v1/session/login', 'GET /admin/v1/session']);
  });
}

test('a malformed provider token is refused without any request', async () => {
  const net = scripted([]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.exchange('not a token\r\nX-Injected: 1');
  await client.exchange('a'.repeat(4097));
  assert.equal(net.sent.length, 0);
  assert.deepEqual(client.getState(), signedOut('denied'));
});

test('a second exchange while one is in flight sends nothing', async () => {
  const slow = held();
  const net = scripted([slow.reply, active()]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  const first = client.exchange(ID_TOKEN);
  const second = client.exchange(`${ID_TOKEN}x`);
  assert.equal(net.sent.length, 1);
  slow.answer(active());
  await Promise.all([first, second]);
  assert.deepEqual(net.sent.map((request) => request.method), ['POST', 'GET']); // one login, then its confirming read
  assert.equal(net.sent[0].headers.get('authorization'), `Bearer ${ID_TOKEN}`);
  assert.deepEqual(client.getState(), ACTIVE);
});

test('a slow re-read cannot restore a session that a logout has ended', async () => {
  const slow = held();
  const client = createAdminSessionClient({ fetch: scripted([active(), slow.reply, noContent()], { honourAbort: false }).fetch });
  await client.bootstrap();
  const reread = client.bootstrap();
  await client.logout();
  assert.deepEqual(client.getState(), signedOut('logged-out'));
  slow.answer(active(FRESH_CSRF));
  await reread;
  assert.deepEqual(client.getState(), signedOut('logged-out'));
});

test('a slow first read cannot overturn a newer login', async () => {
  const slow = held();
  const client = createAdminSessionClient({ fetch: scripted([slow.reply, active(), active()], { honourAbort: false }).fetch });
  const firstRead = client.bootstrap();
  await client.exchange(ID_TOKEN);
  slow.answer(refused(401));
  await firstRead;
  assert.deepEqual(client.getState(), ACTIVE);
});

test('abort() abandons an in-flight read, and its answer is ignored', async () => {
  const slow = held();
  const net = scripted([slow.reply], { honourAbort: false });
  const client = createAdminSessionClient({ fetch: net.fetch });
  const read = client.bootstrap();
  client.abort();
  slow.answer(active());
  await read;
  assert.equal(net.sent[0].init.signal?.aborted, true);
  assert.deepEqual(client.getState(), { phase: 'checking' });
});

test('a request that outlives the client timeout is an outage, not a verdict', async () => {
  const never = (): Promise<Response> => new Promise<Response>(() => undefined);
  const client = createAdminSessionClient({ fetch: scripted([never]).fetch, timeoutMs: 20 });
  await client.bootstrap();
  assert.deepEqual(client.getState(), signedOut('unavailable'));
});

test('logout carries the session CSRF token and the intent header, never the Bearer, then holds nothing', async () => {
  const net = scripted([active(), noContent()]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.bootstrap();
  await client.logout();
  const logout = net.sent[1];
  assert.equal(logout.method, 'POST');
  assert.equal(logout.url, ADMIN_SESSION_PATHS.logout);
  assert.equal(logout.headers.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(logout.headers.get('x-tmpos-csrf'), '1');
  assert.equal(logout.headers.get('authorization'), null);
  assert.equal(logout.init.body, undefined);
  assert.deepEqual(client.getState(), signedOut('logged-out'));
  await client.logout();
  assert.equal(net.sent.length, 2);
});

test('a logout refused for a stale token re-reads the session and retries once with the fresh token', async () => {
  const net = scripted([active(), refused(403), active(FRESH_CSRF), noContent()]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.bootstrap();
  await client.logout();
  assert.deepEqual(
    net.sent.map((request) => `${request.method} ${request.url}`),
    ['GET /admin/v1/session', 'POST /admin/v1/session/logout', 'GET /admin/v1/session', 'POST /admin/v1/session/logout'],
  );
  assert.equal(net.sent[3].headers.get('x-tmpos-session-csrf'), FRESH_CSRF);
  assert.deepEqual(client.getState(), signedOut('logged-out'));
  assertAdminBoundaryOnly(net.sent);
});

const LOGOUT_OUTCOMES: ReadonlyArray<[string, () => Reply[], unknown]> = [
  ['a first POST answered 401 means it had already ended', () => [refused(401)], signedOut('logged-out')],
  ['a stale-token refusal after which no session remains is a confirmed sign-out', () => [refused(403), refused(401)], signedOut('logged-out')],
  ['a 503 after which no session remains is a sign-out on this device only', () => [refused(503), refused(401)], signedOut('logged-out-unconfirmed')],
  ['a lost answer after which no session remains is a sign-out on this device only', () => [new TypeError('network'), refused(401)], signedOut('logged-out-unconfirmed')],
  ['a 503 whose re-read fails too leaves the session held but hidden', () => [refused(503), refused(503)], { phase: 'active', interrupted: true, signOutFailed: true }],
  ['a retry that fails after a confirming re-read leaves the session held but hidden', () => [new TypeError('network'), active(), refused(503)], { phase: 'active', interrupted: true, signOutFailed: true }],
];
for (const [name, replies, expected] of LOGOUT_OUTCOMES) {
  test(`logout outcome: ${name}`, async () => {
    const client = createAdminSessionClient({ fetch: scripted([active(), ...replies()]).fetch });
    await client.bootstrap();
    await client.logout();
    assert.deepEqual(client.getState(), expected);
  });
}

test('subscribers hear each published state until they unsubscribe', async () => {
  const client = createAdminSessionClient({ fetch: scripted([active(), refused(401)]).fetch });
  const heard: string[] = [];
  const unsubscribe = client.subscribe(() => heard.push(client.getState().phase));
  await client.bootstrap();
  unsubscribe();
  await client.bootstrap();
  assert.deepEqual(heard, ['active']);
});

const REREADS: ReadonlyArray<[string, () => Reply, unknown]> = [
  ['429 keeps the held session, hidden', () => refused(429), { phase: 'active', interrupted: true, signOutFailed: false }],
  ['403 ends it with the generic denial', () => refused(403), signedOut('denied')],
];
for (const [name, reply, expected] of REREADS) {
  test(`a re-read of a held session answered ${name}`, async () => {
    const client = createAdminSessionClient({ fetch: scripted([active(), reply()]).fetch });
    await client.bootstrap();
    await client.bootstrap();
    assert.deepEqual(client.getState(), expected);
  });
}

test('a re-read while a logout is in flight sends nothing and cannot undo it', async () => {
  const slow = held();
  const net = scripted([active(), slow.reply]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.bootstrap();
  const leaving = client.logout();
  const reread = client.bootstrap();
  assert.equal(net.sent.length, 2);
  slow.answer(noContent());
  await Promise.all([leaving, reread]);
  assert.deepEqual(client.getState(), signedOut('logged-out'));
});

test('abort() during an exchange drops its answer, and a later exchange sends its own request', async () => {
  const slow = held();
  const net = scripted([slow.reply, active(), active()], { honourAbort: false });
  const client = createAdminSessionClient({ fetch: net.fetch });
  const first = client.exchange(ID_TOKEN);
  client.abort();
  slow.answer(active());
  await first;
  assert.notEqual(client.getState().phase, 'active');
  await client.exchange(ID_TOKEN);
  assert.deepEqual(net.sent.map((request) => request.method), ['POST', 'POST', 'GET']); // the abandoned login sent no read
  assert.deepEqual(client.getState(), ACTIVE);
});

test('after a sign-out, a later read that finds no session carries no expiry notice', async () => {
  const client = createAdminSessionClient({ fetch: scripted([active(), noContent(), refused(401)]).fetch });
  await client.bootstrap();
  await client.logout();
  await client.bootstrap();
  assert.deepEqual(client.getState(), signedOut(null));
});

test('expire() ends an active session with the expiry notice and sends nothing', async () => {
  const net = scripted([active()]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.bootstrap();
  client.expire();
  assert.deepEqual(client.getState(), signedOut('expired'));
  assert.equal(net.sent.length, 1);
});

test('expire() is a no-op while signed out, and while an exchange or a logout runs, that operation decides', async () => {
  const idleNet = scripted([refused(401)]);
  const idle = createAdminSessionClient({ fetch: idleNet.fetch });
  await idle.bootstrap();
  idle.expire();
  assert.deepEqual(idle.getState(), signedOut(null));
  assert.equal(idleNet.sent.length, 1);

  const slow = held();
  const net = scripted([active(), slow.reply]);
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.bootstrap();
  const leaving = client.logout();
  client.expire();
  assert.deepEqual(client.getState(), { phase: 'signing-out' });
  slow.answer(noContent());
  await leaving;
  assert.deepEqual(client.getState(), signedOut('logged-out'));
  assert.equal(net.sent.length, 2);

  const login = held();
  const loginNet = scripted([login.reply, active()]);
  const signingIn = createAdminSessionClient({ fetch: loginNet.fetch });
  const exchanged = signingIn.exchange(ID_TOKEN);
  signingIn.expire();
  assert.deepEqual(signingIn.getState(), { phase: 'signing-in' });
  login.answer(active());
  await exchanged;
  assert.deepEqual(signingIn.getState(), ACTIVE);
  assert.equal(loginNet.sent.length, 2); // the login and its confirming read, nothing more
});

test('a stale read that answers after expire() cannot resurrect the session', async () => {
  const slow = held();
  const net = scripted([active(), slow.reply], { honourAbort: false });
  const client = createAdminSessionClient({ fetch: net.fetch });
  await client.bootstrap();
  const reread = client.bootstrap();
  client.expire();
  assert.equal(net.sent[1].init.signal?.aborted, true); // superseded, not merely ignored
  slow.answer(active(FRESH_CSRF));
  await reread;
  assert.deepEqual(client.getState(), signedOut('expired'));
  assert.equal(net.sent.length, 2);
});
