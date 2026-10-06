// M7A-CUSTOMERS-P3-R2 — the shop's tenant session client against a scripted fetch: what it sends, what it keeps for
// which user, and which answers it believes. M7A-CUSTOMERS-P5-R1: every ensure reads the session first and reuses one
// the server names as that user's (`subject`), so a page load signs in only when there is no such session.
// M7A-CUSTOMERS-P6: a session the client confirmed that then ends is `ended` — no login until a reconnect (TSC-25..31).
// M7B-INVOICES-P1 (closing round): every logout and reset tells the `onSessionEnd` listeners first, before anything is
// sent or awaited, and a listener that throws stops neither — its error is rethrown unchanged in a queued microtask once
// every listener has run (TSC-32); the header's holder list names the drafts section and every module that listens (TSC-33);
// `sessionEndsSoFar` counts the ends and has moved before any listener runs (TSC-34).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { TENANT_SESSION_PATHS, createTenantSessionClient, onSessionEnd, sessionEndsSoFar, sessionSubjectOf } from './tenantSessionClient';
import { sessionSubjectOf as serverSubjectOf } from '../../server/runtime/sessions';

const CSRF = 'c'.repeat(43);
const ROTATED = 'r'.repeat(43);
// Synthetic JWT-shaped ID tokens, assembled at run time so no token-shaped literal sits in the source (secret scanning):
// header {alg: RS256}, payload {sub: <uid>}, and a signature segment that is only the word "sig". No key signed them.
const segment = (value: unknown): string => btoa(JSON.stringify(value)).replace(/=+$/, '');
const syntheticIdToken = (uid: string): string => [segment({ alg: 'RS256' }), segment({ sub: uid }), btoa('sig')].join('.');
const TOKEN_A = syntheticIdToken('uid-a');
const TOKEN_B = syntheticIdToken('uid-b');

// `deaf`: an answer that arrives even after the client abandoned the request (it ignores the abort signal), as a late
// network answer can.
interface Deaf { readonly deaf: () => Promise<Response> }
type Reply = Response | Error | (() => Promise<Response>) | Deaf;
const isDeaf = (reply: Reply | undefined): reply is Deaf => typeof reply === 'object' && 'deaf' in reply;
interface Sent { readonly method: string; readonly url: string; readonly init: RequestInit; readonly headers: Headers }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The tenant session 200 as the server writes it (M7A-CUSTOMERS-P5-R1): whose session it is rides along as `subject`. */
const subjectOf = (uid: string): string => createHash('sha256').update(`tmpos-session-subject:v1\nfirebase\n${uid}`).digest('base64url');
const active = (csrf = CSRF, uid = 'uid-a'): Response => json(200, { status: 'active', csrfToken: csrf, subject: subjectOf(uid) });
const refused = (status: number): Response => json(status, { error: 'refused', requestId: 'r1' });
const NONE = (): Response => refused(401); // the session read when this browser holds no session
const ticks = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function scripted(replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ method: init.method ?? 'GET', url: String(input), init, headers: new Headers(init.headers) });
    const reply = replies.shift();
    if (isDeaf(reply)) return reply.deaf(); // answered whatever the signal says
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
const lines = (sent: readonly Sent[]): string[] => sent.map((r) => `${r.method} ${r.url}`);
const READ = `GET ${TENANT_SESSION_PATHS.current}`;
const LOGIN = `POST ${TENANT_SESSION_PATHS.login}`;
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

test('TSC-01. a first ensure reads the session, finds none, logs in with the Bearer and intent header only, then confirms by a session read', async () => {
  const net = scripted([NONE(), active('x'.repeat(43)), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const result = await client.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(result, { kind: 'ok', csrf: CSRF }); // the confirming read's token is the one kept
  const [first, login, check] = net.sent;
  assert.deepEqual(lines(net.sent), [READ, LOGIN, READ]);
  assert.equal(first.headers.get('authorization'), null);
  assert.equal(login.headers.get('authorization'), `Bearer ${TOKEN_A}`);
  assert.equal(login.headers.get('x-tmpos-csrf'), '1');
  assert.equal(login.headers.get('x-tmpos-reauthenticate'), null);
  assert.equal(login.init.body, undefined); // the login has no body: no client-asserted identity
  assert.equal(check.headers.get('authorization'), null); // the bearer is sent once
  for (const r of net.sent) assert.equal(r.headers.get('x-tmpos-session-subject'), null); // the digest is never sent
  assertBoundaryOnly(net.sent);
});

// M7A-CUSTOMERS-P6: a 401 after a confirmed session is `ended` (no login); only a reconnect signs in again (TSC-25).
test('TSC-02. the same user reuses the session a read names as theirs; a 401 read then ends it, and only a reconnect signs in again', async () => {
  const net = scripted([NONE(), active(), active(), active(ROTATED), NONE(), NONE(), active(), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  let tokens = 0;
  const idToken = async () => { tokens += 1; return TOKEN_A; };
  await client.ensure('uid-a', idToken);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ok', csrf: ROTATED }); // another tab rotated it
  assert.equal(tokens, 1);
  assert.deepEqual(lines(net.sent.slice(3)), [READ]);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' }); // expired: nothing signs in on its own
  assert.equal(tokens, 1);
  assert.deepEqual(lines(net.sent.slice(4)), [READ]);
  assert.deepEqual(await client.ensure('uid-a', idToken, { reconnect: true }), { kind: 'ok', csrf: CSRF }); // the Reconnect: logged in again
  assert.equal(tokens, 2);
  assert.deepEqual(lines(net.sent.slice(5)), [READ, LOGIN, READ]);
});

test('TSC-03. a different user never reuses the previous user session: the read names another identity, so it logs in with its own token', async () => {
  const net = scripted([NONE(), active(), active(), active(CSRF, 'uid-a'), active(ROTATED, 'uid-b'), active(ROTATED, 'uid-b')]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  const result = await client.ensure('uid-b', async () => TOKEN_B);
  assert.deepEqual(result, { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(net.sent.slice(3)), [READ, LOGIN, READ]); // A's cookie was read, and never taken as B's
  assert.equal(net.sent[4].headers.get('authorization'), `Bearer ${TOKEN_B}`);
});

test('TSC-04. no signed-in user logs nothing in; refusals, rate limits, outages and malformed answers are never ok, and a first read that decides nothing signs nothing in', async () => {
  const none = scripted([NONE()]);
  assert.deepEqual(await createTenantSessionClient({ fetch: none.fetch }).ensure('uid-a', async () => null), { kind: 'no-identity' });
  assert.deepEqual(lines(none.sent), [READ]); // the read only: no login without the user's own token
  const malformedToken = scripted([NONE()]);
  assert.deepEqual(await createTenantSessionClient({ fetch: malformedToken.fetch }).ensure('uid-a', async () => 'not a token'), { kind: 'refused' });
  assert.deepEqual(lines(malformedToken.sent), [READ]);
  // The login's answers.
  const afterLogin: Array<[Reply[], string]> = [
    [[NONE(), refused(401)], 'refused'],
    [[NONE(), refused(403)], 'refused'],
    [[NONE(), refused(429)], 'rate-limited'],
    [[NONE(), refused(503)], 'unavailable'],
    [[NONE(), new Error('network')], 'unavailable'],
    [[NONE(), json(200, { status: 'active', csrfToken: 'short' })], 'unavailable'],
    [[NONE(), new Response('{"status":"active"}', { status: 200, headers: { 'content-type': 'application/json-patch+json' } })], 'unavailable'],
    [[NONE(), active(), refused(401)], 'refused'], // the cookie did not stick: nothing confirmed it
    [[NONE(), active(), active(CSRF, 'uid-b')], 'unavailable'], // another sign-in replaced it: nothing confirmed
    [[NONE(), active(), json(200, { status: 'active', csrfToken: CSRF })], 'unavailable'], // a confirmation naming nobody
  ];
  for (const [replies, kind] of afterLogin) {
    const net = scripted(replies);
    assert.deepEqual(await createTenantSessionClient({ fetch: net.fetch }).ensure('uid-a', async () => TOKEN_A), { kind }, kind);
  }
  // The first read's answers that decide nothing: an outage stays an outage, and no login is tried (no loop).
  const firstRead: Array<[Reply, string]> = [
    [refused(429), 'rate-limited'],
    [refused(503), 'unavailable'],
    [refused(403), 'unavailable'],
    [new Error('network'), 'unavailable'],
    [json(200, { status: 'active', csrfToken: CSRF }), 'unavailable'], // no subject
    [json(200, { status: 'active', csrfToken: CSRF, subject: 'short' }), 'unavailable'],
    [json(200, { status: 'active', csrfToken: CSRF, subject: 7 }), 'unavailable'],
    [new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'unavailable'],
  ];
  for (const [reply, kind] of firstRead) {
    const net = scripted([reply]);
    let asked = 0;
    assert.deepEqual(await createTenantSessionClient({ fetch: net.fetch }).ensure('uid-a', async () => { asked += 1; return TOKEN_A; }), { kind }, kind);
    assert.deepEqual(lines(net.sent), [READ], kind);
    assert.equal(asked, 0, kind); // not even an ID token was asked for
  }
});

test('TSC-05. reset supersedes a login in flight: its late answer establishes nothing', async () => {
  const late = held();
  const net = scripted([NONE(), late.reply, NONE(), active(ROTATED), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const first = client.ensure('uid-a', async () => TOKEN_A);
  await ticks();
  assert.deepEqual(lines(net.sent), [READ, LOGIN]);
  client.reset();
  assert.deepEqual(await first, { kind: 'unavailable' });
  late.answer(active());
  // The next ensure asks again, rather than trusting the abandoned exchange.
  assert.deepEqual(await client.ensure('uid-a', async () => TOKEN_A), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(net.sent.slice(2)), [READ, LOGIN, READ]);
});

test('TSC-06. concurrent ensures for one user share one attempt: one login, or one reuse read', async () => {
  const net = scripted([NONE(), active(), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const [a, b] = await Promise.all([client.ensure('uid-a', async () => TOKEN_A), client.ensure('uid-a', async () => TOKEN_A)]);
  assert.deepEqual(a, b);
  assert.deepEqual(lines(net.sent), [READ, LOGIN, READ]);
  const reuse = scripted([active()]);
  const fresh = createTenantSessionClient({ fetch: reuse.fetch });
  const both = await Promise.all([fresh.ensure('uid-a', async () => TOKEN_A), fresh.ensure('uid-a', async () => TOKEN_A)]);
  assert.deepEqual(both, [{ kind: 'ok', csrf: CSRF }, { kind: 'ok', csrf: CSRF }]);
  assert.deepEqual(lines(reuse.sent), [READ]);
});

test('TSC-07. reauthenticate sends the fresh token in re-authentication mode and keeps the rotated session token', async () => {
  const net = scripted([NONE(), active(), active(), active('n'.repeat(43)), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_B), { kind: 'ok', csrf: ROTATED });
  const login = net.sent[3];
  assert.equal(login.url, TENANT_SESSION_PATHS.login);
  assert.equal(login.headers.get('authorization'), `Bearer ${TOKEN_B}`);
  assert.equal(login.headers.get('x-tmpos-reauthenticate'), '1');
  assert.equal(login.headers.get('x-tmpos-csrf'), '1');
  assertBoundaryOnly(net.sent);
});

test('TSC-08. a refused re-authentication is not ok even when the prior session still stands; none held sends nothing', async () => {
  const net = scripted([NONE(), active(), active(), refused(401), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_B), { kind: 'refused' });
  const fresh = scripted([]);
  assert.deepEqual(await createTenantSessionClient({ fetch: fresh.fetch }).reauthenticate('uid-a', TOKEN_B), { kind: 'refused' });
  assert.equal(fresh.sent.length, 0);
});

test('TSC-09. logout sends the kept CSRF token, forgets the session whatever the answer, and never throws', async () => {
  const net = scripted([NONE(), active(), active(), refused(503), NONE(), active(), active()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  await client.logout();
  const post = net.sent[3];
  assert.equal(post.method, 'POST');
  assert.equal(post.url, TENANT_SESSION_PATHS.logout);
  assert.equal(post.headers.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(post.headers.get('x-tmpos-csrf'), '1');
  // Forgotten: nothing to re-authenticate, and the next ensure asks the server again.
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_B), { kind: 'refused' });
  assert.equal(net.sent.length, 4);
  await client.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(lines(net.sent.slice(4)), [READ, LOGIN, READ]);
  assertBoundaryOnly(net.sent);
});

test('TSC-10. logout with nothing remembered asks for a surviving session first; no session sends no logout', async () => {
  const survived = scripted([active(), new Response(null, { status: 204 })]);
  await createTenantSessionClient({ fetch: survived.fetch }).logout();
  assert.deepEqual(lines(survived.sent), [READ, `POST ${TENANT_SESSION_PATHS.logout}`]);
  assert.equal(survived.sent[1].headers.get('x-tmpos-session-csrf'), CSRF);
  const gone = scripted([refused(401)]);
  await createTenantSessionClient({ fetch: gone.fetch }).logout();
  assert.equal(gone.sent.length, 1);
  const offline = scripted([new Error('network')]);
  await createTenantSessionClient({ fetch: offline.fetch }).logout(); // never throws
});

test('TSC-11. a user switch: the logout in flight finishes before the next user reads or logs in (AM4)', async () => {
  const ended = held();
  const net = scripted([NONE(), active(), active(), ended.reply, NONE(), active(ROTATED, 'uid-b'), active(ROTATED, 'uid-b')]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  const logout = client.logout(); // user A's session, with A's remembered CSRF token
  const next = client.ensure('uid-b', async () => TOKEN_B);
  await ticks();
  assert.deepEqual(lines(net.sent.slice(3)), [`POST ${TENANT_SESSION_PATHS.logout}`]); // B waits, not even reading
  client.reset(); // a later reset does not abandon the running logout
  ended.answer(new Response(null, { status: 204 }));
  await logout;
  assert.deepEqual(await next, { kind: 'unavailable' }); // superseded by the reset, after the logout finished
  assert.deepEqual(await client.ensure('uid-b', async () => TOKEN_B), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(net.sent.slice(3)), [`POST ${TENANT_SESSION_PATHS.logout}`, READ, LOGIN, READ]);
  assert.equal(net.sent[3].headers.get('x-tmpos-session-csrf'), CSRF); // A's token ended A's session
  assert.equal(net.sent[5].headers.get('authorization'), `Bearer ${TOKEN_B}`);
  assertBoundaryOnly(net.sent);
});

test('TSC-12. an ensure started before a logout is abandoned; logouts run one after another', async () => {
  const early = held();
  const first = held();
  // A's first session read is in flight when the sign-out comes; its late answer establishes nothing.
  const net = scripted([early.reply, first.reply, new Response(null, { status: 204 }), refused(401)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const started = client.ensure('uid-a', async () => TOKEN_A);
  await ticks(1);
  const one = client.logout(); // nothing remembered: it reads the current session first
  const two = client.logout();
  assert.deepEqual(await started, { kind: 'unavailable' });
  await ticks(1);
  assert.equal(net.sent.length, 2); // the second logout has not started: the first is still reading
  first.answer(active());
  await one;
  await two;
  early.answer(active());
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_B), { kind: 'refused' }); // the late read kept nothing
  assert.deepEqual(lines(net.sent), [
    READ, READ, `POST ${TENANT_SESSION_PATHS.logout}`,
    READ, // the second logout, only after the first ended: no session left, nothing more
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
  // The first session read, the login, the confirming read after it, the read of a remembered session, and a re-authentication.
  assert.deepEqual(await at([limited('7')], ensure), { kind: 'rate-limited', retryAfterSeconds: 7 });
  assert.deepEqual(await at([NONE(), limited('12')], ensure), { kind: 'rate-limited', retryAfterSeconds: 12 });
  assert.deepEqual(await at([NONE(), active(), limited('20')], ensure), { kind: 'rate-limited', retryAfterSeconds: 20 });
  assert.deepEqual(await at([NONE(), active(), active(), limited('30')], async (c) => { await ensure(c); return ensure(c); }), { kind: 'rate-limited', retryAfterSeconds: 30 });
  assert.deepEqual(
    await at([NONE(), active(), active(), limited('45')], async (c) => { await ensure(c); return c.reauthenticate('uid-a', TOKEN_B); }),
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

// M7A-CUSTOMERS-P5-R1 (DA-143) — a page load reuses the signed-in user's session, and only that user's.
test('TSC-15. the subject the client recomputes equals the server\'s for the same user, and differs between users', async () => {
  for (const uid of ['uid-a', 'uid-b', 'Zx9_long-firebase-uid-0000000000000', 'ünïcødé-uid']) {
    const mine = await sessionSubjectOf(uid);
    assert.equal(mine, serverSubjectOf({ authProvider: 'firebase', authProviderUid: uid }), uid);
    assert.equal(mine, subjectOf(uid), uid); // and an independent digest of the documented label
    assert.match(mine, /^[A-Za-z0-9_-]{43}$/);
  }
  assert.notEqual(await sessionSubjectOf('uid-a'), await sessionSubjectOf('uid-b'));
  // Labelled: never the storage key (SHA-256 over provider and UID alone).
  assert.notEqual(await sessionSubjectOf('uid-a'), createHash('sha256').update('firebase\nuid-a').digest('base64url'));
});

test('TSC-16. every page load that finds this user\'s session reuses it: one read each, no login, no ID token asked', async () => {
  for (let load = 1; load <= 7; load++) {
    const net = scripted([active(`${load}`.padEnd(43, 'k'))]);
    let asked = 0;
    const result = await createTenantSessionClient({ fetch: net.fetch }).ensure('uid-a', async () => { asked += 1; return TOKEN_A; });
    assert.deepEqual(result, { kind: 'ok', csrf: `${load}`.padEnd(43, 'k') }, `load ${load}`);
    assert.deepEqual(lines(net.sent), [READ], `load ${load}`);
    assert.equal(asked, 0, `load ${load}`);
  }
});

test('TSC-17. a session another identity left in this browser is never reused: this user logs in, and the login must be confirmed as theirs', async () => {
  const net = scripted([active(CSRF, 'uid-a'), active(ROTATED, 'uid-b'), active(ROTATED, 'uid-b')]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  assert.deepEqual(await client.ensure('uid-b', async () => TOKEN_B), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(net.sent), [READ, LOGIN, READ]);
  assert.equal(net.sent[1].headers.get('authorization'), `Bearer ${TOKEN_B}`);
  // With no identity to present, another identity's session is not taken either: nothing is kept.
  const stranded = scripted([active(CSRF, 'uid-a')]);
  const other = createTenantSessionClient({ fetch: stranded.fetch });
  assert.deepEqual(await other.ensure('uid-b', async () => null), { kind: 'no-identity' });
  assert.deepEqual(await other.reauthenticate('uid-b', TOKEN_B), { kind: 'refused' }); // nothing remembered
  assert.deepEqual(lines(stranded.sent), [READ]);
});

test('TSC-18. a late session read from an earlier initialization never answers for the current one', async () => {
  const late = held();
  const net = scripted([{ deaf: late.reply }, NONE(), active(ROTATED, 'uid-b'), active(ROTATED, 'uid-b')]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const first = client.ensure('uid-a', async () => TOKEN_A);
  await ticks(1);
  const second = client.ensure('uid-b', async () => TOKEN_B); // a user switch supersedes A's read in flight
  assert.deepEqual(await second, { kind: 'ok', csrf: ROTATED });
  late.answer(active(CSRF, 'uid-a')); // A's answer IS delivered, after B's session was established
  assert.deepEqual(await first, { kind: 'unavailable' });
  await ticks();
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_A), { kind: 'refused' }); // A was never remembered
  assert.deepEqual(lines(net.sent), [READ, READ, LOGIN, READ]);
});

test('TSC-19. a subject that cannot be computed confirms nothing and signs nothing in', async () => {
  const net = scripted([active()]);
  const client = createTenantSessionClient({ fetch: net.fetch, subjectOf: async () => { throw new Error('no digest'); } });
  assert.deepEqual(await client.ensure('uid-a', async () => TOKEN_A), { kind: 'unavailable' });
  assert.deepEqual(lines(net.sent), [READ]);
});

test('TSC-20. a fresh ensure waits for the attempt in flight for its user, then reads again; a plain ensure still shares that attempt', async () => {
  const first = held();
  const net = scripted([first.reply, active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const started = client.ensure('uid-a', async () => TOKEN_A);
  await ticks(1);
  const shared = client.ensure('uid-a', async () => TOKEN_A);
  const fresh = client.ensure('uid-a', async () => TOKEN_A, { fresh: true });
  await ticks();
  assert.deepEqual(lines(net.sent), [READ]); // the fresh call has sent nothing while the first read is out
  first.answer(active(CSRF));
  assert.deepEqual(await started, { kind: 'ok', csrf: CSRF });
  assert.deepEqual(await shared, { kind: 'ok', csrf: CSRF });
  assert.deepEqual(await fresh, { kind: 'ok', csrf: ROTATED }); // the answer of its own read, sent after the first ended
  assert.deepEqual(lines(net.sent), [READ, READ]);
});

test('TSC-21. a fresh ensure waiting on its user\'s attempt answers unavailable and sends nothing when another user, or a reset, comes first', async () => {
  const first = held();
  const net = scripted([first.reply, NONE(), active(ROTATED, 'uid-b'), active(ROTATED, 'uid-b')]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const started = client.ensure('uid-a', async () => TOKEN_A);
  await ticks(1);
  // This half guards the epoch check after the wait (a plain, shared call would answer unavailable here too); TSC-20 is the one that fails without `fresh`.
  const fresh = client.ensure('uid-a', async () => TOKEN_A, { fresh: true });
  const other = client.ensure('uid-b', async () => TOKEN_B);
  assert.deepEqual(await fresh, { kind: 'unavailable' });
  assert.deepEqual(await started, { kind: 'unavailable' });
  assert.deepEqual(await other, { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(net.sent), [READ, READ, LOGIN, READ]); // nothing more for uid-a after the switch
  assert.equal(net.sent[2].headers.get('authorization'), `Bearer ${TOKEN_B}`);
  const reset = held();
  const quiet = scripted([reset.reply]);
  const again = createTenantSessionClient({ fetch: quiet.fetch });
  void again.ensure('uid-a', async () => TOKEN_A);
  await ticks(1);
  const waiting = again.ensure('uid-a', async () => TOKEN_A, { fresh: true });
  again.reset();
  assert.deepEqual(await waiting, { kind: 'unavailable' });
  await ticks();
  assert.deepEqual(lines(quiet.sent), [READ]);
});

test('TSC-22. a reset or a user switch while the subject digest is pending: the read it was made for keeps nothing', async () => {
  let release!: (subject: string) => void;
  const digest = new Promise<string>((resolve) => { release = resolve; });
  const net = scripted([active()]);
  const client = createTenantSessionClient({ fetch: net.fetch, subjectOf: () => digest });
  const started = client.ensure('uid-a', async () => TOKEN_A);
  await ticks();
  assert.deepEqual(lines(net.sent), [READ]); // answered: the digest is what is pending
  client.reset();
  release(subjectOf('uid-a'));
  assert.deepEqual(await started, { kind: 'unavailable' });
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_A), { kind: 'refused' }); // nothing kept, nothing sent
  assert.deepEqual(lines(net.sent), [READ]);
  // The same window closed by another user's ensure.
  let releaseA!: (subject: string) => void;
  const digestA = new Promise<string>((resolve) => { releaseA = resolve; });
  const switched = scripted([active(CSRF, 'uid-a'), active(ROTATED, 'uid-b')]);
  const shared = createTenantSessionClient({ fetch: switched.fetch, subjectOf: (uid) => (uid === 'uid-a' ? digestA : Promise.resolve(subjectOf(uid))) });
  const a = shared.ensure('uid-a', async () => TOKEN_A);
  await ticks();
  const b = shared.ensure('uid-b', async () => TOKEN_B);
  assert.deepEqual(await b, { kind: 'ok', csrf: ROTATED });
  releaseA(subjectOf('uid-a')); // A's digest ends after B's session was kept
  assert.deepEqual(await a, { kind: 'unavailable' });
  assert.deepEqual(await shared.reauthenticate('uid-a', TOKEN_A), { kind: 'refused' }); // A was never remembered
  assert.deepEqual(lines(switched.sent), [READ, READ]);
});

test('TSC-23. after a 401 read, a subject that cannot be computed signs nothing in: no ID token asked, no login', async () => {
  const net = scripted([NONE()]);
  let asked = 0;
  const client = createTenantSessionClient({ fetch: net.fetch, subjectOf: async () => { throw new Error('no digest'); } });
  assert.deepEqual(await client.ensure('uid-a', async () => { asked += 1; return TOKEN_A; }), { kind: 'unavailable' });
  assert.deepEqual(lines(net.sent), [READ]);
  assert.equal(asked, 0);
});

test('TSC-24. a fresh ensure for a user this client has moved on from answers unavailable at once, sends nothing and supersedes nothing', async () => {
  const read = held();
  const net = scripted([read.reply]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const b = client.ensure('uid-b', async () => TOKEN_B);
  await ticks(1);
  let asked = 0;
  assert.deepEqual(await client.ensure('uid-a', async () => { asked += 1; return TOKEN_A; }, { fresh: true }), { kind: 'unavailable' });
  assert.deepEqual(lines(net.sent), [READ]); // B's read only: nothing for uid-a
  read.answer(active(ROTATED, 'uid-b'));
  assert.deepEqual(await b, { kind: 'ok', csrf: ROTATED }); // B's attempt was not superseded
  // A session kept for uid-b: a fresh uid-a check is refused the same way, with nothing sent and B's session kept.
  assert.deepEqual(await client.ensure('uid-a', async () => { asked += 1; return TOKEN_A; }, { fresh: true }), { kind: 'unavailable' });
  assert.deepEqual(lines(net.sent), [READ]);
  assert.equal(asked, 0);
  // B is still remembered: its re-authentication is sent (unscripted here, so unavailable) rather than refused unsent.
  assert.deepEqual(await client.reauthenticate('uid-b', TOKEN_B), { kind: 'unavailable' });
  assert.deepEqual(lines(net.sent), [READ, LOGIN, READ]);
});

// M7A-CUSTOMERS-P6 — a session this client confirmed that the server then ends (expiry, revocation, a logout elsewhere)
// is never re-established on its own: only an explicit reconnect logs in again.
test('TSC-25. a confirmed session that ends answers `ended`: no ID token asked, no login, again and again, until a reconnect logs in exactly once', async () => {
  const net = scripted([NONE(), active(), active(), NONE(), NONE(), NONE(), NONE(), active(ROTATED), active(ROTATED), NONE()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  let tokens = 0;
  const idToken = async () => { tokens += 1; return TOKEN_A; };
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ok', csrf: CSRF }); // the first establishment logs in
  assert.equal(tokens, 1);
  const ended = await client.ensure('uid-a', idToken);
  assert.deepEqual(ended, { kind: 'ended' });
  assert.ok(Object.isFrozen(ended));
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' }); // the marker stands
  assert.deepEqual(await client.ensure('uid-a', idToken, { fresh: true }), { kind: 'ended' }); // a check after a 403 too
  assert.equal(tokens, 1); // not even an ID token was asked for
  assert.deepEqual(lines(net.sent.slice(3)), [READ, READ, READ]);
  assert.deepEqual(await client.reauthenticate('uid-a', TOKEN_B), { kind: 'refused' }); // no session left to renew: sent nowhere
  assert.equal(net.sent.length, 6);
  // The Reconnect: one read, one login, one confirming read.
  assert.deepEqual(await client.ensure('uid-a', idToken, { reconnect: true }), { kind: 'ok', csrf: ROTATED });
  assert.equal(tokens, 2);
  assert.deepEqual(lines(net.sent.slice(6)), [READ, LOGIN, READ]);
  // Confirmed again: its end is again `ended`, with nothing sent but the read.
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  assert.deepEqual(lines(net.sent.slice(9)), [READ]);
  assert.equal(tokens, 2);
  assertBoundaryOnly(net.sent);
});

test('TSC-26. after an end, a valid session of the same user that a read finds (another tab signed in) is reused with no login', async () => {
  const net = scripted([NONE(), active(), active(), NONE(), active(ROTATED), active(ROTATED), NONE()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  let tokens = 0;
  const idToken = async () => { tokens += 1; return TOKEN_A; };
  await client.ensure('uid-a', idToken);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ok', csrf: ROTATED }); // another tab's session
  assert.deepEqual(await client.ensure('uid-a', idToken, { reconnect: true }), { kind: 'ok', csrf: ROTATED }); // a reconnect reuses it too
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  assert.equal(tokens, 1);
  assert.deepEqual(lines(net.sent.slice(3)), [READ, READ, READ, READ]);
});

test('TSC-27. what the end does not change: another identity\'s session still logs this user in; outages and 429s still log nothing in', async () => {
  const net = scripted([NONE(), active(), active(), NONE(), active(CSRF, 'uid-b'), active(ROTATED), active(ROTATED), refused(503), limited('9'), NONE()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  let tokens = 0;
  const idToken = async () => { tokens += 1; return TOKEN_A; };
  await client.ensure('uid-a', idToken);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  // Another identity's session in this browser: this user logs in as themselves, as before (TSC-17).
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(net.sent.slice(4)), [READ, LOGIN, READ]);
  assert.equal(tokens, 2);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'unavailable' });
  assert.deepEqual(await client.ensure('uid-a', idToken, { reconnect: true }), { kind: 'rate-limited', retryAfterSeconds: 9 });
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  assert.deepEqual(lines(net.sent.slice(7)), [READ, READ, READ]);
  assert.equal(tokens, 2);
});

test('TSC-28. a reset, a logout or another user starts afresh: a 401 read then logs in as a first establishment', async () => {
  const afterReset = scripted([NONE(), active(), active(), NONE(), active(ROTATED), active(ROTATED)]);
  const reset = createTenantSessionClient({ fetch: afterReset.fetch });
  await reset.ensure('uid-a', async () => TOKEN_A);
  reset.reset();
  assert.deepEqual(await reset.ensure('uid-a', async () => TOKEN_A), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(afterReset.sent.slice(3)), [READ, LOGIN, READ]);
  const afterLogout = scripted([NONE(), active(), active(), new Response(null, { status: 204 }), NONE(), active(ROTATED), active(ROTATED)]);
  const out = createTenantSessionClient({ fetch: afterLogout.fetch });
  await out.ensure('uid-a', async () => TOKEN_A);
  await out.logout();
  assert.deepEqual(await out.ensure('uid-a', async () => TOKEN_A), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(afterLogout.sent.slice(4)), [READ, LOGIN, READ]);
  const switched = scripted([NONE(), active(), active(), NONE(), active(ROTATED, 'uid-b'), active(ROTATED, 'uid-b')]);
  const other = createTenantSessionClient({ fetch: switched.fetch });
  await other.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(await other.ensure('uid-b', async () => TOKEN_B), { kind: 'ok', csrf: ROTATED }); // B never had a session here
  assert.deepEqual(lines(switched.sent.slice(3)), [READ, LOGIN, READ]);
  // Another user's turn that ends with nothing kept (nobody to present) still forgets the first user's confirmation:
  // the first user's next 401 is a first establishment, not `ended`.
  const passed = scripted([NONE(), active(), active(), NONE(), NONE(), active(ROTATED), active(ROTATED)]);
  const turn = createTenantSessionClient({ fetch: passed.fetch });
  await turn.ensure('uid-a', async () => TOKEN_A);
  assert.deepEqual(await turn.ensure('uid-b', async () => null), { kind: 'no-identity' });
  assert.deepEqual(await turn.ensure('uid-a', async () => TOKEN_A), { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(passed.sent.slice(3)), [READ, READ, LOGIN, READ]);
});

test('TSC-29. a reconnect that does not establish a session leaves the end standing: the next plain ensure still logs nothing in', async () => {
  const net = scripted([NONE(), active(), active(), NONE(), NONE(), refused(401), NONE(), NONE(), NONE()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  let token: string | null = TOKEN_A;
  let tokens = 0;
  const idToken = async () => { tokens += 1; return token; };
  await client.ensure('uid-a', idToken);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  assert.deepEqual(await client.ensure('uid-a', idToken, { reconnect: true }), { kind: 'refused' }); // the login was refused
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  token = null;
  assert.deepEqual(await client.ensure('uid-a', idToken, { reconnect: true }), { kind: 'no-identity' }); // nobody to present
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' });
  assert.equal(tokens, 3);
  assert.deepEqual(lines(net.sent.slice(3)), [READ, READ, LOGIN, READ, READ, READ]);
});

test('TSC-30. a reconnect that arrives while a plain attempt is out is not answered by that attempt\'s end: it waits, then logs in', async () => {
  const first = held();
  const net = scripted([NONE(), active(), active(), first.reply, NONE(), active(ROTATED), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  const plain = client.ensure('uid-a', async () => TOKEN_A);
  await ticks(1);
  const reconnect = client.ensure('uid-a', async () => TOKEN_A, { reconnect: true });
  await ticks();
  assert.deepEqual(lines(net.sent.slice(3)), [READ]); // nothing more while the plain read is out
  first.answer(NONE());
  assert.deepEqual(await plain, { kind: 'ended' });
  assert.deepEqual(await reconnect, { kind: 'ok', csrf: ROTATED });
  assert.deepEqual(lines(net.sent.slice(3)), [READ, READ, LOGIN, READ]);
});

test('TSC-31. after an end, a fresh check for another user sends nothing and answers unavailable: the end stands, and the confirmed user still logs nothing in', async () => {
  const net = scripted([NONE(), active(), active(), NONE(), NONE(), active(ROTATED), active(ROTATED)]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  let tokens = 0;
  const idToken = async () => { tokens += 1; return TOKEN_A; };
  await client.ensure('uid-a', idToken);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' }); // nothing kept now: no memo, nothing in flight
  let asked = 0;
  assert.deepEqual(await client.ensure('uid-b', async () => { asked += 1; return TOKEN_B; }, { fresh: true }), { kind: 'unavailable' });
  assert.equal(net.sent.length, 4); // nothing sent for uid-b
  assert.equal(asked, 0);
  assert.deepEqual(await client.ensure('uid-a', idToken), { kind: 'ended' }); // the stale check cleared nothing
  assert.deepEqual(lines(net.sent.slice(3)), [READ, READ]);
  assert.equal(tokens, 1);
});

test('TSC-32. onSessionEnd: every logout and reset tells each listener synchronously, before anything is sent; a listener that throws stops neither the logout nor the others, and its error is rethrown as it was in a queued microtask once all have run; an unsubscribed one hears nothing', async () => {
  const net = scripted([NONE(), active(), active(), new Response(null, { status: 204 }), NONE()]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  await client.ensure('uid-a', async () => TOKEN_A);
  // queueMicrotask is captured only around each synchronous call that ends a session, and restored in `finally`: what a
  // call queued is kept unrun here, so the rethrown error is caught by this case instead of failing the run as uncaught.
  const queued: Array<() => void> = [];
  const capturing = <T>(call: () => T): T => {
    const real = globalThis.queueMicrotask;
    Object.assign(globalThis, { queueMicrotask: (task: () => void) => { queued.push(task); } });
    try { return call(); } finally { Object.assign(globalThis, { queueMicrotask: real }); }
  };
  const rethrown = (task: () => void): unknown => { try { task(); } catch (error) { return error; } return undefined; };
  const failure = new Error('a holder failed');
  const heard: string[] = [];
  const offs = [
    onSessionEnd(() => { heard.push(`first:${net.sent.length}`); }),
    onSessionEnd(() => { throw failure; }),
    onSessionEnd(() => { heard.push(`last:${net.sent.length}:${queued.length}`); }), // nothing is queued before the last ran
  ];
  try {
    const logout = capturing(() => client.logout());
    assert.deepEqual(heard, ['first:3', 'last:3:0']); // told before logout() returned, with nothing of it sent yet
    assert.equal(queued.length, 1); // the failure, surfaced after every listener ran
    assert.equal(rethrown(queued[0]), failure); // the ORIGINAL error object, nothing of ours around it
    await logout;
    assert.deepEqual(lines(net.sent.slice(3)), [`POST ${TENANT_SESSION_PATHS.logout}`]); // the logout still ran, with the kept token
    assert.equal(net.sent[3].headers.get('x-tmpos-session-csrf'), CSRF);
    capturing(() => client.reset());
    assert.deepEqual(heard, ['first:3', 'last:3:0', 'first:4', 'last:4:1']); // a reset tells them too, and sends nothing
    assert.equal(queued.length, 2);
    assert.equal(rethrown(queued[1]), failure);
    offs[0]();
    await capturing(() => client.logout()); // nothing remembered: one read finds no session, so no logout is sent
    assert.deepEqual(heard, ['first:3', 'last:3:0', 'first:4', 'last:4:1', 'last:4:2']);
    assert.equal(queued.length, 3);
    assert.equal(rethrown(queued[2]), failure);
  } finally {
    for (const off of offs) off();
  }
  assert.equal(net.sent.length, 5);
});

test('TSC-33. the header names every in-memory holder of the token: the drafts section as the fourth (commit 15110e4), and every module that listens to onSessionEnd — since M7B-INVOICES-P1-R2 the directory too (DA-200)', () => {
  const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');
  const header = read('./tenantSessionClient.ts').split('\nexport const TENANT_SESSION_PATHS')[0];
  assert.match(header, /The Invoices page's server drafts section \(ServerInvoiceDrafts\.tsx, M7B-INVOICES-P1\), fourth/);
  assert.match(header, /in an open new-draft dialog's state, to send that dialog's save \(the one\s+\/\/\s+React-state exception\)/);
  for (const file of ['ServerInvoiceDrafts.tsx', 'ServerCustomerPicker.tsx', 'ServerCustomerDirectory.tsx']) {
    const listens = /\bonSessionEnd\(/.test(read(`./${file}`));
    assert.ok(header.includes(file), `${file} is a token holder the header must name`);
    // A listener is named as one, and a holder that does not listen says so (DA-198's residual stays visible here).
    if (!listens) assert.match(header, new RegExp(`${file.replace('.', '\\.')}[^]*?It does not hear \`onSessionEnd\``));
  }
  // Every production module under src/ that calls onSessionEnd, found by walking the tree (not a fixed list), is named.
  const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [new URL(e.name, dir).pathname] : []);
  const listeners = walk(new URL('../', import.meta.url))
    .filter((path) => !path.endsWith('/tenantSessionClient.ts') && /\bonSessionEnd\(/.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(path.lastIndexOf('/') + 1));
  assert.deepEqual(listeners.sort(), ['ServerCustomerDirectory.tsx', 'ServerCustomerPicker.tsx', 'ServerInvoiceDrafts.tsx']);
  for (const file of listeners) assert.ok(header.includes(file), `${file} listens to onSessionEnd, so the header must name it`);
  assert.match(header, /`onSessionEnd` takes it\s+\/\/\s+from every user's attempt/);
  assert.match(header, /until the last draft field unmounts or `onSessionEnd` is heard/);
  // DA-200's residual is gone from the header: the directory's create hold store hears the sign-out from its module's load.
  assert.match(header, /Its create hold store hears `onSessionEnd` from its\s+\/\/\s+module's load/);
  assert.doesNotMatch(header, /ServerCustomerDirectory\.tsx[^]*?It does not hear `onSessionEnd`/);
});

test('TSC-34. sessionEndsSoFar counts every logout and reset, and has moved before their listeners run: a confirmation that answered just before a sign-out began is told apart from one asked for after it', async () => {
  const net = scripted([active(), new Response(null, { status: 204 })]);
  const client = createTenantSessionClient({ fetch: net.fetch });
  const before = sessionEndsSoFar();
  assert.deepEqual(await client.ensure('uid-a', async () => TOKEN_A), { kind: 'ok', csrf: CSRF }); // answered, then...
  const seen: number[] = [];
  const off = onSessionEnd(() => { seen.push(sessionEndsSoFar()); });
  try {
    const out = client.logout(); // ...a sign-out began: whoever compares the count now sees it moved
    assert.equal(sessionEndsSoFar(), before + 1);
    assert.deepEqual(seen, [before + 1]); // already moved when the listeners ran
    await out;
    assert.equal(sessionEndsSoFar(), before + 1); // the logout's own answer counts nothing more
    client.reset();
    assert.deepEqual([sessionEndsSoFar(), seen], [before + 2, [before + 1, before + 2]]);
  } finally {
    off();
  }
  assert.deepEqual(lines(net.sent), [READ, `POST ${TENANT_SESSION_PATHS.logout}`]);
});
