// M7A-CUSTOMERS-P3-R2 — the shop's tenant session client against a scripted fetch: what it sends, what it keeps for
// which user, and which answers it believes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TENANT_SESSION_PATHS, createTenantSessionClient } from './tenantSessionClient';

const CSRF = 'c'.repeat(43);
const ROTATED = 'r'.repeat(43);
// Synthetic JWT-shaped ID tokens, assembled at run time so no token-shaped literal sits in the source (secret scanning):
// header {alg: RS256}, payload {sub: <uid>}, and a signature segment that is only the word "sig". No key signed them.
const segment = (value: unknown): string => btoa(JSON.stringify(value)).replace(/=+$/, '');
const syntheticIdToken = (uid: string): string => [segment({ alg: 'RS256' }), segment({ sub: uid }), btoa('sig')].join('.');
const TOKEN_A = syntheticIdToken('uid-a');
const TOKEN_B = syntheticIdToken('uid-b');

type Reply = Response | Error | (() => Promise<Response>);
interface Sent { readonly method: string; readonly url: string; readonly init: RequestInit; readonly headers: Headers }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const active = (csrf = CSRF): Response => json(200, { status: 'active', csrfToken: csrf });
const refused = (status: number): Response => json(status, { error: 'refused', requestId: 'r1' });

function scripted(replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ method: init.method ?? 'GET', url: String(input), init, headers: new Headers(init.headers) });
    const reply = replies.shift();
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      if (reply === undefined) return reject(new Error('unscripted request'));
      if (reply instanceof Error) return reject(reply);
      Promise.resolve(typeof reply === 'function' ? reply() : reply).then(resolve, reject);
    });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

function held(): { reply: () => Promise<Response>; answer: (r: Response) => void } {
  let answer!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => { answer = resolve; });
  return { reply: () => pending, answer };
}

const PATHS: readonly string[] = Object.values(TENANT_SESSION_PATHS);
function assertBoundaryOnly(sent: readonly Sent[]): void {
  for (const r of sent) {
    assert.ok(PATHS.includes(r.url), `left the tenant session boundary: ${r.url}`);
    assert.equal(r.headers.get('cookie'), null, 'a cookie header was constructed by script');
    assert.equal(r.init.credentials, 'include');
    assert.equal(r.init.mode, 'same-origin');
    assert.equal(r.init.cache, 'no-store');
    assert.equal(r.init.redirect, 'error');
  }
}

test('TSC-01. a first ensure logs in with the Bearer and intent header only, then confirms by a session read', async () => {
  const net = scripted([active('x'.repeat(43)), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const result = await client.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(result, { kind: 'ok', csrf: CSRF }); // the confirming read's token is the one kept
  const [login, check] = net.sent;
  assert.equal(login.method, 'POST');
  assert.equal(login.url, TENANT_SESSION_PATHS.login);
  assert.equal(login.headers.get('authorization'), `Bearer ${TOKEN_A}`);
  assert.equal(login.headers.get('x-tmpos-csrf'), '1');
  assert.equal(login.headers.get('x-tmpos-reauthenticate'), null);
  assert.equal(login.init.body, undefined); // the login has no body: no client-asserted identity
  assert.equal(check.method, 'GET');
  assert.equal(check.url, TENANT_SESSION_PATHS.current);
  assert.equal(check.headers.get('authorization'), null); // the bearer is sent once
  assertBoundaryOnly(net.sent);
});

test('TSC-02. the same user reuses the session after a read confirms it; a 401 read signs in again', async () => {
  const net = scripted([active(), active(), active(ROTATED), refused(401), active(), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  let tokens = 0;
  const idToken = async () => { tokens += 1; return TOKEN_A; };
  await client.ensure('uid-a', idToken);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ok', csrf: ROTATED }); // another tab rotated it
  assert.equal(tokens, 1);
  assert.deepEqual(net.sent.slice(2).map((r) => r.url), [TENANT_SESSION_PATHS.current]);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ok', csrf: CSRF }); // expired: logged in again
  assert.equal(tokens, 2);
  assert.deepEqual(net.sent.slice(3).map((r) => `${r.method} ${r.url}`), [
    `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`,
  ]);
});

test('TSC-03. a different user never reuses the previous user session: it logs in with its own token', async () => {
  const net = scripted([active(), active(), active(ROTATED), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  const result = await client.ensure('uid-b', async () => TOKEN_B);
  assert.deepEqual(result, { kind: 'ok', csrf: ROTATED });
  assert.equal(net.sent[2].method, 'POST'); // no session read first: that cookie is the previous user's
  assert.equal(net.sent[2].headers.get('authorization'), `Bearer ${TOKEN_B}`);
});

test('TSC-04. no signed-in user sends nothing; refusals, rate limits, outages and malformed answers are never ok', async () => {
  const none = scripted([]);
  assert.deepEqual(await createTenantSessionClient({ fetch: none.fetch }).ensure('uid-a', async () => null), { kind: 'no-identity' });
  assert.equal(none.sent.length, 0);
  const malformedToken = scripted([]);
  assert.deepEqual(await createTenantSessionClient({ fetch: malformedToken.fetch }).ensure('uid-a', async () => 'not a token'), { kind: 'refused' });
  assert.equal(malformedToken.sent.length, 0);
  const cases: Array<[Reply[], string]> = [
    [[refused(401)], 'refused'],
    [[refused(403)], 'refused'],
    [[refused(429)], 'rate-limited'],
    [[refused(503)], 'unavailable'],
    [[new Error('network')], 'unavailable'],
    [[json(200, { status: 'active', csrfToken: 'short' })], 'unavailable'],
    [[new Response('{"status":"active"}', { status: 200, headers: { 'content-type': 'application/json-patch+json' } })], 'unavailable'],
    [[active(), refused(401)], 'refused'], // the cookie did not stick: nothing confirmed it
  ];
  for (const [replies, kind] of cases) {
    const net = scripted(replies);
    assert.deepEqual(await createTenantSessionClient({ fetch: net.fetch }).ensure('uid-a', async () => TOKEN_A), { kind }, kind);
  }
});

test('TSC-05. reset supersedes a login in flight: its late answer establishes nothing', async () => {
  const late = held();
  const net = scripted([late.reply, active(ROTATED), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const first = client.ensure('uid-a', async () => TOKEN_A);
  await new Promise((r) => setTimeout(r, 0));
  client.reset();
  assert.deepEqual(await first, { kind: 'unavailable' });
  late.answer(active());
  // The next ensure logs in again (no remembered session), rather than trusting the abandoned exchange.
  assert.deepEqual(await client.ensure('uid-a', async () => TOKEN_A), { kind: 'ok', csrf: ROTATED });
  assert.equal(net.sent[1].method, 'POST');
});

test('TSC-06. concurrent ensures for one user share one login', async () => {
  const net = scripted([active(), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const [a, b] = await Promise.all([client.ensure('uid-a', async () => TOKEN_A), client.ensure('uid-a', async () => TOKEN_A)]);
  assert.deepEqual(a, b);
  assert.equal(net.sent.length, 2);
});

test('TSC-07. reauthenticate sends the fresh token in re-authentication mode and keeps the rotated session token', async () => {
  const net = scripted([active(), active(), active('n'.repeat(43)), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_B), { kind: 'ok', csrf: ROTATED });
  const login = net.sent[2];
  assert.equal(login.url, TENANT_SESSION_PATHS.login);
  assert.equal(login.headers.get('authorization'), `Bearer ${TOKEN_B}`);
  assert.equal(login.headers.get('x-tmpos-reauthenticate'), '1');
  assert.equal(login.headers.get('x-tmpos-csrf'), '1');
  assertBoundaryOnly(net.sent);
});

test('TSC-08. a refused re-authentication is not ok even when the prior session still stands; none held sends nothing', async () => {
  const net = scripted([active(), active(), refused(401), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_B), { kind: 'refused' });
  const fresh = scripted([]);
  assert.deepEqual(await createTenantSessionClient({ fetch: fresh.fetch }).reauthenticate('uid-a', TOKEN_B), { kind: 'refused' });
  assert.equal(fresh.sent.length, 0);
});

test('TSC-09. logout sends the kept CSRF token, forgets the session whatever the answer, and never throws', async () => {
  const net = scripted([active(), active(), refused(503), active(), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  await client.logout();
  const post = net.sent[2];
  assert.equal(post.method, 'POST');
  assert.equal(post.url, TENANT_SESSION_PATHS.logout);
  assert.equal(post.headers.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(post.headers.get('x-tmpos-csrf'), '1');
  // Forgotten: the next ensure signs in rather than reusing the ended session.
  await client.ensure('uid-a', async () => TOKEN_A);
  assert.equal(net.sent[3].method, 'POST');
  assertBoundaryOnly(net.sent);
});

test('TSC-10. logout with nothing remembered asks for a surviving session first; no session sends no logout', async () => {
  const survived = scripted([active(), new Response(null, { status: 204 })]);
  await createTenantSessionClient({ fetch: survived.fetch }).logout();
  assert.deepEqual(survived.sent.map((r) => `${r.method} ${r.url}`), [`GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.logout}`]);
  assert.equal(survived.sent[1].headers.get('x-tmpos-session-csrf'), CSRF);
  const gone = scripted([refused(401)]);
  await createTenantSessionClient({ fetch: gone.fetch }).logout();
  assert.equal(gone.sent.length, 1);
  const offline = scripted([new Error('network')]);
  await createTenantSessionClient({ fetch: offline.fetch }).logout(); // never throws
});

test('TSC-11. a user switch: the logout in flight finishes before the next user reads or logs in (AM4)', async () => {
  const ended = held();
  const net = scripted([active(), active(), ended.reply, active(ROTATED), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  const logout = client.logout(); // user A's session, with A's remembered CSRF token
  const next = client.ensure('uid-b', async () => TOKEN_B);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(net.sent.slice(2).map((r) => `${r.method} ${r.url}`), [`POST ${TENANT_SESSION_PATHS.logout}`]); // B waits
  client.reset(); // a later reset does not abandon the running logout
  ended.answer(new Response(null, { status: 204 }));
  await logout;
  assert.deepEqual(await next, { kind: 'unavailable' }); // superseded by the reset, after the logout finished
  assert.deepEqual(await client.ensure('uid-b', async () => TOKEN_B), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(net.sent.slice(2).map((r) => `${r.method} ${r.url}`), [
    `POST ${TENANT_SESSION_PATHS.logout}`, `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`,
  ]);
  assert.equal(net.sent[2].headers.get('x-tmpos-session-csrf'), CSRF); // A's token ended A's session
  assert.equal(net.sent[3].headers.get('authorization'), `Bearer ${TOKEN_B}`);
  assertBoundaryOnly(net.sent);
});

test('TSC-12. an ensure started before a logout is abandoned; logouts run one after another', async () => {
  const login = held();
  const first = held();
  // A's login is in flight when the sign-out comes; its late answer establishes nothing.
  const net = scripted([login.reply, first.reply, new Response(null, { status: 204 }), refused(401)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const early = client.ensure('uid-a', async () => TOKEN_A);
  await new Promise((r) => setTimeout(r, 0));
  const one = client.logout(); // nothing remembered: it reads the current session first
  const two = client.logout();
  assert.deepEqual(await early, { kind: 'unavailable' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(net.sent.length, 2); // the second logout has not started: the first is still reading
  first.answer(active());
  await one;
  await two;
  login.answer(active());
  assert.deepEqual(net.sent.map((r) => `${r.method} ${r.url}`), [
    `POST ${TENANT_SESSION_PATHS.login}`, `GET ${TENANT_SESSION_PATHS.current}`, `POST ${TENANT_SESSION_PATHS.logout}`,
    `GET ${TENANT_SESSION_PATHS.current}`, // the second logout, only after the first ended: no session left, nothing more
  ]);
});

// M7A-CUSTOMERS-P5 — a rate-limited session carries the server's delay only when the 429 named a valid one.
const limited = (retryAfter?: string): Response =>
  new Response(JSON.stringify({ error: 'rate_limited', requestId: 'r1' }), {
    status: 429, headers: { 'content-type': 'application/json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) },
  });

test('TSC-13. a 429 with a valid Retry-After is rate-limited with that delay, at every step that can be limited', async () => {
  const at = async (replies: Reply[], act: (c: ReturnType<typeof createTenantSessionClient>) => Promise<unknown>) => {
    const client = createTenantSessionClient({ fetch: scripted(replies).fetch });
    return act(client);
  };
  const ensure = (c: ReturnType<typeof createTenantSessionClient>) => c.ensure('uid-a', async () => TOKEN_A);
  // The login, the confirming read after it, the read of a remembered session, and a re-authentication.
  assert.deepEqual(await at([limited('7')], ensure), { kind: 'rate-limited', retryAfterSeconds: 7 });
  assert.deepEqual(await at([active(), limited('12')], ensure), { kind: 'rate-limited', retryAfterSeconds: 12 });
  assert.deepEqual(await at([active(), active(), limited('30')], async (c) => { await ensure(c); return ensure(c); }), { kind: 'rate-limited', retryAfterSeconds: 30 });
  assert.deepEqual(
    await at([active(), active(), limited('45')], async (c) => { await ensure(c); return c.reauthenticate('uid-a', TOKEN_B); }),
    { kind: 'rate-limited', retryAfterSeconds: 45 },
  );
  // Whole seconds, clamped to 1..300.
  assert.deepEqual(await at([limited('0')], ensure), { kind: 'rate-limited', retryAfterSeconds: 1 });
  assert.deepEqual(await at([limited('300')], ensure), { kind: 'rate-limited', retryAfterSeconds: 300 });
  assert.deepEqual(await at([limited('86400')], ensure), { kind: 'rate-limited', retryAfterSeconds: 300 });
  assert.ok(Object.isFrozen(await at([limited('7')], ensure)));
});

test('TSC-14. a 429 with no Retry-After, or one that is not whole seconds, carries no delay key at all', async () => {
  for (const header of [undefined, '', 'soon', '1.5', '-1', '+5', '5s', '1e2', '1234567890', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    const result = await createTenantSessionClient({ fetch: scripted([limited(header)]).fetch }).ensure('uid-a', async () => TOKEN_A);
    assert.deepEqual(result, { kind: 'rate-limited' }, JSON.stringify(header)); // strict: an undefined key would differ
    assert.equal('retryAfterSeconds' in result, false, JSON.stringify(header));
  }
  // A Retry-After on any other status is not a rate limit and is not carried.
  const outage = new Response(JSON.stringify({ error: 'service_unavailable' }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '9' } });
  assert.deepEqual(await createTenantSessionClient({ fetch: scripted([outage]).fetch }).ensure('uid-a', async () => TOKEN_A), { kind: 'unavailable' });
});
