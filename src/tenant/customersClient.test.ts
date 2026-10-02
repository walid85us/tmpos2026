// M7A-CUSTOMERS-P5 — the shop's customers client against a scripted fetch: what each request carries, the exact
// answers it accepts, and the one outcome every other answer maps to. The name rule and the id rule are swept against
// the server's own (server/runtime/customerCreate.ts, server/runtime/routes.ts), and since M7A-CUSTOMERS-P6 the phone and
// email rules too (server/runtime/customerDirectory.ts), with the profile read's exact shape; since M7A-CUSTOMERS-P7 the
// profile's version from its ETag and the edit (PATCH): its bytes, its headers and the one outcome of every answer. Special
// characters are built from code points, so this source stays ASCII.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTACT_INVALID, CUSTOMERS_PATH, createCustomersClient, customerEditBody, isCustomerId, normalizeCustomerEmail, normalizeCustomerName,
  normalizeCustomerPhone, retryAfterSeconds, versionOfEtag,
} from './customersClient';
import { normalizeCustomerName as serverNormalizeCustomerName } from '../../server/runtime/customerCreate';
import {
  CONTACT_REFUSED, CUSTOMER_DIRECTORY_PATH, decodeCustomerCursor, encodeCustomerCursor, isCustomerCreatedAt,
  normalizeCustomerEmail as serverNormalizeCustomerEmail, normalizeCustomerPhone as serverNormalizeCustomerPhone,
} from '../../server/runtime/customerDirectory';
import { pathIdOf } from '../../server/runtime/routes';

const cp = (code: number): string => String.fromCodePoint(code);
const unit = (code: number): string => String.fromCharCode(code); // a lone surrogate is one UTF-16 unit
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ID = uuid(0xa51); // with hex letters, so an uppercase spelling is a different string
const OTHER = uuid(0xb52);
// A synthetic v4 Idempotency-Key, assembled at run time so no key-shaped literal sits in the source (secret scanning).
const KEY = ['3c5e7a9b', '1d2f', '4a6b', '9c8d', '0e1f2a3b4c5d'].join('-');
const CSRF = 'c'.repeat(43);
const CURSOR = encodeCustomerCursor(ID); // a real 23-character continuation
const BODY = JSON.stringify({ name: 'Ada Lovelace' });

interface Sent { readonly url: string; readonly init: RequestInit; readonly headers: Headers }
type Reply = Response | Error | (() => Response);

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const refusal = (status: number, error = 'refused', headers: Record<string, string> = {}): Response =>
  json(status, { error, requestId: 'r1' }, headers);
const created = (id = ID, name = 'Ada Lovelace', headers: Record<string, string> = { location: `${CUSTOMERS_PATH}/${id}` }): Response =>
  json(201, { customer: { id, name } }, headers);
const page = (customers: unknown, nextCursor: unknown = null): Response => json(200, { customers, nextCursor });

function once(reply: Reply, timeoutMs?: number) {
  const sent: Sent[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ url: String(input), init, headers: new Headers(init.headers) });
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  };
  return { sent, client: createCustomersClient({ fetch: fetch as typeof globalThis.fetch, timeoutMs }) };
}

/** A fetch that never answers until its signal aborts. */
function hanging(timeoutMs?: number) {
  const sent: Sent[] = [];
  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ url: String(input), init, headers: new Headers(init.headers) });
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
  return { sent, client: createCustomersClient({ fetch: fetch as typeof globalThis.fetch, timeoutMs }) };
}

const SELECTOR_RE = /tenant|store|role|actor|user|uid/i;
function assertSameOriginOnly(r: Sent): void {
  assert.equal(r.init.credentials, 'include');
  assert.equal(r.init.mode, 'same-origin');
  assert.equal(r.init.cache, 'no-store');
  assert.equal(r.init.redirect, 'error');
  assert.equal(r.init.referrerPolicy, 'no-referrer');
  assert.equal(r.headers.get('cookie'), null, 'a cookie header was constructed by script');
  assert.equal(r.headers.get('authorization'), null);
  assert.doesNotMatch(r.url, SELECTOR_RE, 'a selector rode the URL');
  for (const [name] of r.headers) assert.doesNotMatch(name, SELECTOR_RE, `a selector header was sent: ${name}`);
}
const headerNames = (r: Sent): string[] => [...r.headers].map(([name]) => name).sort();

test('CDC-01. page one is a GET of the bare path with Accept and the session CSRF header only: no limit, no selector, no body', async () => {
  const rows = [{ id: ID, name: 'Ada Lovelace' }, { id: OTHER, name: 'Grace Hopper' }];
  const { sent, client } = once(page(rows, CURSOR));
  const result = await client.list(null, CSRF);
  assert.deepEqual(result, { kind: 'ok', customers: rows, nextCursor: CURSOR });
  assert.ok(result.kind === 'ok' && Object.isFrozen(result) && Object.isFrozen(result.customers) && Object.isFrozen(result.customers[0]));
  assert.equal(sent.length, 1);
  const [r] = sent;
  assert.equal(r.url, CUSTOMERS_PATH);
  assert.equal(CUSTOMERS_PATH, CUSTOMER_DIRECTORY_PATH); // the server's own literal
  assert.equal(r.init.method, 'GET');
  assert.equal(r.init.body, undefined);
  assert.deepEqual(headerNames(r), ['accept', 'x-tmpos-session-csrf']);
  assert.equal(r.headers.get('accept'), 'application/json');
  assertSameOriginOnly(r);
});

test('CDC-02. a cursor rides the query verbatim; one outside the grammar is never sent', async () => {
  const next = once(page([], null));
  assert.deepEqual(await next.client.list(CURSOR, CSRF), { kind: 'ok', customers: [], nextCursor: null });
  assert.equal(next.sent[0].url, `${CUSTOMERS_PATH}?cursor=${CURSOR}`);
  assert.deepEqual(headerNames(next.sent[0]), ['accept', 'x-tmpos-session-csrf']);
  assertSameOriginOnly(next.sent[0]);
  for (const bad of ['', 'short', `${CURSOR}A`, CURSOR.slice(1), `${CURSOR.slice(0, 22)}=`, `${CURSOR.slice(0, 22)}&`, `${CURSOR.slice(0, 20)}%2F`, '../../session/logout?x=']) {
    const none = once(page([], null));
    assert.deepEqual(await none.client.list(bad, CSRF), { kind: 'bad-cursor' }, JSON.stringify(bad));
    assert.equal(none.sent.length, 0, `a malformed cursor reached the network: ${JSON.stringify(bad)}`);
  }
});

test('CDC-03. a list 200 is a result only when it is exactly the contract', async () => {
  const row = { id: ID, name: 'Ada Lovelace' };
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), name: `Customer ${i}` }));
  const full = once(page(many(100), CURSOR));
  const ok = await full.client.list(null, CSRF);
  assert.ok(ok.kind === 'ok' && ok.customers.length === 100 && ok.nextCursor === CURSOR);
  const refused: Array<[string, Response]> = [
    ['an extra top-level key', json(200, { customers: [row], nextCursor: null, tenant: uuid(9) })],
    ['a missing nextCursor', json(200, { customers: [row] })],
    ['a missing customers', json(200, { nextCursor: null })],
    ['customers not an array', page({ 0: row })],
    ['101 rows', page(many(101))],
    ['an extra row key', page([{ ...row, email: 'a@synthetic.test' }])],
    ['a row without a name', page([{ id: ID }])],
    ['an uppercase id', page([{ id: ID.toUpperCase(), name: 'A' }])],
    ['a non-uuid id', page([{ id: 'c1700000000000', name: 'A' }])],
    ['a numeric id', page([{ id: 7, name: 'A' }])],
    ['a non-string name', page([{ id: ID, name: null }])],
    ['a row that is an array', page([[ID, 'A']])],
    ['a null row', page([null])],
    ['a page that repeats an id', page([row, { id: ID, name: 'Other' }])], // S2
    ['an empty page that carries a cursor', page([], CURSOR)], // S2: the server sets a cursor only behind a full page
    ['a short cursor', page([row], CURSOR.slice(1))],
    ['a cursor outside the alphabet', page([row], `${CURSOR.slice(0, 22)}=`)],
    ['a numeric cursor', page([row], 23)],
    ['an undefined cursor', json(200, { customers: [row], nextCursor: undefined })],
    ['a top-level array', json(200, [row])],
    ['null', json(200, null)],
    ['a non-JSON 200 (a static host fallback)', new Response('<!doctype html><title>Shop</title>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['JSON under another media type', new Response(JSON.stringify({ customers: [], nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json-patch+json' } })],
    ['a truncated body', new Response('{"customers":[', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['a 204', new Response(null, { status: 204 })],
    ['a 206 with the contract body', json(206, { customers: [row], nextCursor: null })],
    ['a 201 with the contract body', json(201, { customers: [row], nextCursor: null })],
  ];
  for (const [label, reply] of refused) {
    assert.deepEqual(await once(reply).client.list(null, CSRF), { kind: 'unavailable' }, label);
  }
});

test('CDC-04. every other list answer maps to one outcome; a 400 is a bad cursor only when one was sent', async () => {
  assert.deepEqual(await once(refusal(400, 'invalid_request')).client.list(CURSOR, CSRF), { kind: 'bad-cursor' });
  assert.deepEqual(await once(refusal(400, 'invalid_request')).client.list(null, CSRF), { kind: 'unavailable' }); // page one
  const cases: Array<[Reply, unknown]> = [
    [refusal(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refusal(403, 'forbidden'), { kind: 'denied' }],
    [refusal(404, 'not_found'), { kind: 'unavailable' }], // the route is absent on this host
    [refusal(429, 'rate_limited', { 'retry-after': '7' }), { kind: 'rate-limited', retryAfterSeconds: 7 }],
    [refusal(429, 'rate_limited'), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refusal(500, 'internal_error'), { kind: 'unavailable' }],
    [refusal(503, 'service_unavailable'), { kind: 'unavailable' }],
    [refusal(409, 'request_in_progress'), { kind: 'unavailable' }],
    [new TypeError('network'), { kind: 'unavailable' }],
    [() => { throw new Error('sync'); }, { kind: 'unavailable' }],
  ];
  for (const [reply, expected] of cases) {
    for (const cursor of [null, CURSOR]) assert.deepEqual(await once(reply instanceof Response ? reply.clone() : reply).client.list(cursor, CSRF), expected);
  }
  // No answer in time, and a caller's abort before or during the request: never a rejection, never a result.
  assert.deepEqual(await hanging(5).client.list(null, CSRF), { kind: 'unavailable' });
  const before = new AbortController();
  before.abort();
  const unsent = hanging();
  assert.deepEqual(await unsent.client.list(null, CSRF, before.signal), { kind: 'unavailable' });
  assert.equal(unsent.sent.length, 0);
  const during = new AbortController();
  const out = hanging();
  const pending = out.client.list(null, CSRF, during.signal);
  during.abort();
  assert.deepEqual(await pending, { kind: 'unavailable' });
});

test('CDC-05. Retry-After is whole seconds clamped to 1..300; missing or unparseable is 60', () => {
  const cases: Array<[string | null, number]> = [
    ['1', 1], ['7', 7], ['60', 60], ['300', 300], ['301', 300], ['999999999', 300], ['0', 1], ['007', 7],
    [null, 60], ['', 60], ['abc', 60], ['1.5', 60], ['-5', 60], ['+5', 60], [' 5', 60], ['5 ', 60], ['5s', 60], ['1e2', 60],
    ['0x10', 60], ['1234567890', 60], ['Wed, 21 Oct 2026 07:28:00 GMT', 60],
  ];
  for (const [header, seconds] of cases) assert.equal(retryAfterSeconds(header), seconds, JSON.stringify(header));
});

test('CDC-06. a full page of 100 long names is read; a body over the cap is not', async () => {
  const astral = cp(0x1f600); // one scalar, two UTF-16 units
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: uuid(i + 1), name: astral.repeat(200) }));
  const raw = JSON.stringify({ customers: rows, nextCursor: CURSOR });
  assert.ok(raw.length > 16_384, 'the fixture must exceed the role-levels client cap');
  // The worst canonical spelling: every scalar escaped as two \uXXXX units.
  const escaped = raw.replace(/[\ud800-\udfff]/g, (u) => `\\u${u.charCodeAt(0).toString(16)}`);
  assert.ok(escaped.length > 240_000 && escaped.length <= 524_288);
  for (const text of [raw, escaped]) {
    const result = await once(new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })).client.list(null, CSRF);
    assert.ok(result.kind === 'ok');
    assert.equal(result.customers.length, 100);
    assert.equal(result.customers[99].name, astral.repeat(200));
    assert.equal(normalizeCustomerName(result.customers[0].name), result.customers[0].name); // a storable name
  }
  const padded = `${' '.repeat(524_289 - raw.length)}${raw}`; // valid JSON, one character over the cap
  assert.equal(padded.length, 524_289);
  assert.deepEqual(await once(new Response(padded, { status: 200, headers: { 'content-type': 'application/json' } })).client.list(null, CSRF), { kind: 'unavailable' });
  const atCap = `${' '.repeat(524_288 - raw.length)}${raw}`;
  assert.equal((await once(new Response(atCap, { status: 200, headers: { 'content-type': 'application/json' } })).client.list(null, CSRF)).kind, 'ok');
});

test('CDC-07. detail: a malformed id sends nothing; the 200 must name exactly the id asked for', async () => {
  const good = once(json(200, { customer: { id: ID, name: 'Ada Lovelace' } }));
  const result = await good.client.detail(ID, CSRF);
  assert.deepEqual(result, { kind: 'ok', customer: { id: ID, name: 'Ada Lovelace' } });
  assert.ok(result.kind === 'ok' && Object.isFrozen(result.customer));
  assert.equal(good.sent[0].url, `${CUSTOMERS_PATH}/${ID}`);
  assert.equal(good.sent[0].init.method, 'GET');
  assert.deepEqual(headerNames(good.sent[0]), ['accept', 'x-tmpos-session-csrf']);
  assertSameOriginOnly(good.sent[0]);
  for (const bad of ['', 'new', 'c1700000000000', ID.toUpperCase(), `{${ID}}`, `${ID}/`, `${ID}?x=1`, `../session/logout`, `${ID.slice(0, 35)}g`, encodeURIComponent(`${ID} `), `%2e%2e/${ID}`]) {
    const none = once(json(200, { customer: { id: ID, name: 'A' } }));
    assert.deepEqual(await none.client.detail(bad, CSRF), { kind: 'not-found' }, JSON.stringify(bad));
    assert.equal(none.sent.length, 0, `a malformed id reached the network: ${JSON.stringify(bad)}`);
  }
  const cases: Array<[Reply, unknown]> = [
    [json(200, { customer: { id: OTHER, name: 'Ada Lovelace' } }), { kind: 'unavailable' }], // another customer's answer
    [json(200, { customer: { id: ID, name: 'A', email: 'a@synthetic.test' } }), { kind: 'unavailable' }],
    [json(200, { customer: { id: ID, name: 'A' }, tenant: uuid(9) }), { kind: 'unavailable' }],
    [json(200, { customer: { id: ID } }), { kind: 'unavailable' }],
    [json(200, { customer: { id: ID, name: 7 } }), { kind: 'unavailable' }],
    [json(200, { id: ID, name: 'A' }), { kind: 'unavailable' }],
    [json(200, { customers: [{ id: ID, name: 'A' }], nextCursor: null }), { kind: 'unavailable' }],
    [new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }), { kind: 'unavailable' }],
    [json(201, { customer: { id: ID, name: 'A' } }), { kind: 'unavailable' }],
    [refusal(404, 'not_found'), { kind: 'not-found' }],
    [refusal(400, 'invalid_request'), { kind: 'unavailable' }],
    [refusal(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refusal(403, 'forbidden'), { kind: 'denied' }],
    [refusal(429, 'rate_limited', { 'retry-after': '12' }), { kind: 'rate-limited', retryAfterSeconds: 12 }],
    [refusal(429, 'rate_limited', { 'retry-after': 'soon' }), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refusal(503, 'service_unavailable'), { kind: 'unavailable' }],
    [new TypeError('network'), { kind: 'unavailable' }],
  ];
  for (const [reply, expected] of cases) assert.deepEqual(await once(reply).client.detail(ID, CSRF), expected);
  assert.deepEqual(await hanging(5).client.detail(ID, CSRF), { kind: 'unavailable' });
});

test('CDC-08. a create sends the caller\'s exact bytes with the five headers and nothing that selects a tenant', async () => {
  // Not what JSON.stringify would produce: padding, an escape and a trailing space must all survive untouched.
  const exact = '{ "name" : "Ada \\u004covelace" } ';
  const { sent, client } = once(created());
  await client.create(exact, KEY, CSRF);
  assert.equal(sent.length, 1);
  const [r] = sent;
  assert.equal(r.url, CUSTOMERS_PATH);
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.body, exact);
  assert.deepEqual(headerNames(r), ['accept', 'content-type', 'idempotency-key', 'x-tmpos-csrf', 'x-tmpos-session-csrf']);
  assert.equal(r.headers.get('accept'), 'application/json');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('x-tmpos-csrf'), '1');
  assert.equal(r.headers.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(r.headers.get('idempotency-key'), KEY);
  assertSameOriginOnly(r);
});

test('CDC-09. created is a validated 201 only: a 200, another 2xx, a malformed body or a foreign Location is unknown', async () => {
  assert.deepEqual(await once(created()).client.create(BODY, KEY, CSRF), { kind: 'created', customer: { id: ID, name: 'Ada Lovelace' }, replayed: false });
  // The sealed replay: the same 201 with Idempotent-Replayed: true.
  assert.deepEqual(
    await once(created(ID, 'Ada Lovelace', { location: `${CUSTOMERS_PATH}/${ID}`, 'idempotent-replayed': 'true' })).client.create(BODY, KEY, CSRF),
    { kind: 'created', customer: { id: ID, name: 'Ada Lovelace' }, replayed: true },
  );
  // A response sealed before the detail route existed replays without Location.
  assert.deepEqual(await once(created(ID, 'Ada Lovelace', {})).client.create(BODY, KEY, CSRF), { kind: 'created', customer: { id: ID, name: 'Ada Lovelace' }, replayed: false });
  // Only the literal `true` marks a replay; the name is the caller's to compare (another name is still `created`).
  const odd = await once(created(ID, 'Someone Else', { 'idempotent-replayed': 'TRUE' })).client.create(BODY, KEY, CSRF);
  assert.deepEqual(odd, { kind: 'created', customer: { id: ID, name: 'Someone Else' }, replayed: false });
  const unknown: Array<[string, Response]> = [
    ['a 200 with the exact body', json(200, { customer: { id: ID, name: 'Ada Lovelace' } }, { location: `${CUSTOMERS_PATH}/${ID}` })],
    ['a 202', json(202, { customer: { id: ID, name: 'Ada Lovelace' } })],
    ['a 204', new Response(null, { status: 204 })],
    ['a 201 with an extra key', json(201, { customer: { id: ID, name: 'Ada Lovelace' }, tenant: uuid(9) })],
    ['a 201 with an extra customer key', json(201, { customer: { id: ID, name: 'Ada Lovelace', createdAt: 'now' } })],
    ['a 201 with no customer', json(201, { id: ID, name: 'Ada Lovelace' })],
    ['a 201 with a non-canonical id', json(201, { customer: { id: ID.toUpperCase(), name: 'Ada Lovelace' } })],
    ['a 201 with a non-string name', json(201, { customer: { id: ID, name: 1 } })],
    ['a 201 with no body', new Response(null, { status: 201 })],
    ['a 201 that is not JSON', new Response('created', { status: 201, headers: { 'content-type': 'text/plain' } })],
    ['a Location naming another customer', created(ID, 'Ada Lovelace', { location: `${CUSTOMERS_PATH}/${OTHER}` })],
    ['an absolute Location', created(ID, 'Ada Lovelace', { location: `https://shop.synthetic.test${CUSTOMERS_PATH}/${ID}` })],
    ['a Location with a query', created(ID, 'Ada Lovelace', { location: `${CUSTOMERS_PATH}/${ID}?x=1` })],
    ['an empty Location', created(ID, 'Ada Lovelace', { location: '' })],
  ];
  for (const [label, reply] of unknown) {
    assert.deepEqual(await once(reply).client.create(BODY, KEY, CSRF), { kind: 'unknown', responded: true }, label);
  }
});

test('CDC-10. every other create answer maps to one outcome, and no answer is never a refusal', async () => {
  const cases: Array<[Reply, unknown]> = [
    [refusal(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refusal(403, 'forbidden'), { kind: 'denied' }],
    [refusal(400, 'invalid_request'), { kind: 'invalid' }],
    [refusal(413, 'content_too_large'), { kind: 'invalid' }],
    [refusal(415, 'unsupported_media_type'), { kind: 'invalid' }],
    [refusal(404, 'not_found'), { kind: 'absent' }],
    [refusal(422, 'idempotency_key_reused'), { kind: 'key-reused' }],
    [refusal(429, 'rate_limited', { 'retry-after': '3' }), { kind: 'rate-limited', retryAfterSeconds: 3 }],
    [refusal(429, 'rate_limited'), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refusal(409, 'request_in_progress'), { kind: 'in-progress' }],
    [json(409, { error: 'request_in_progress' }), { kind: 'in-progress' }],
    [refusal(409, 'write_conflict'), { kind: 'unknown', responded: true }], // never "refused": undecided
    [new Response(null, { status: 409 }), { kind: 'unknown', responded: true }],
    [new Response('request_in_progress', { status: 409, headers: { 'content-type': 'text/plain' } }), { kind: 'unknown', responded: true }],
    [refusal(500, 'internal_error'), { kind: 'unknown', responded: true }],
    [refusal(503, 'service_unavailable'), { kind: 'unknown', responded: true }],
    [refusal(417, 'expectation_failed'), { kind: 'unknown', responded: true }],
    [new Response(null, { status: 304 }), { kind: 'unknown', responded: true }],
    [new TypeError('network'), { kind: 'unknown', responded: false }],
    [() => { throw new Error('sync'); }, { kind: 'unknown', responded: false }],
  ];
  for (const [reply, expected] of cases) assert.deepEqual(await once(reply).client.create(BODY, KEY, CSRF), expected);
  assert.deepEqual(await hanging(5).client.create(BODY, KEY, CSRF), { kind: 'unknown', responded: false }); // a timeout
  const during = new AbortController();
  const out = hanging();
  const pending = out.client.create(BODY, KEY, CSRF, during.signal);
  during.abort();
  assert.deepEqual(await pending, { kind: 'unknown', responded: false });
  assert.equal(out.sent.length, 1); // it left: the outcome is undecided, not "not sent"
  // A body that cannot be read after the status line is still an answer.
  const broken = new Response(new ReadableStream({ start(c) { c.error(new Error('reset')); } }), { status: 201, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await once(broken).client.create(BODY, KEY, CSRF), { kind: 'unknown', responded: true });
});

test('CDC-11. the name rule accepts, refuses and normalizes exactly as the server\'s does', () => {
  const astral = cp(0x1f600);
  const corpus: unknown[] = [
    '', ' ', '   ', 'A', ' A ', 'Ada Lovelace', '  Ada  Lovelace  ', `\tAda\n`, `Ada\tLovelace`, `Ada\nLovelace`,
    'x'.repeat(199), 'x'.repeat(200), 'x'.repeat(201), ` ${'x'.repeat(200)} `, ` ${'x'.repeat(201)} `,
    astral, astral.repeat(199), astral.repeat(200), astral.repeat(201), `${'x'.repeat(199)}${astral}`, `${'x'.repeat(200)}${astral}`,
    `Caf${cp(0xe9)} ${cp(0x4e2d)}${cp(0x6587)} ${cp(0x5d0)}${cp(0x5d1)}`, `e${cp(0x301)}`, cp(0x301), `${cp(0x301)}${cp(0x302)}`,
    cp(0x2800), `${cp(0x2800)}${cp(0x2800)}`, `A${cp(0x2800)}`, cp(0x200b), `${cp(0x200b)}${cp(0x200d)}`, `A${cp(0x200b)}`, cp(0xfeff), `${cp(0xfeff)}A`,
    cp(0xad), cp(0x3164), cp(0x115f), cp(0xe000), cp(0x10fffd), cp(0x378), cp(0xe0001), cp(0xe0100), cp(0x1d173),
    unit(0xd83d) + unit(0xde00), unit(0xde00) + unit(0xd83d), `A${unit(0xd800)}`, `${unit(0xdfff)}A`,
    null, undefined, 0, 7, true, {}, [], ['Ada'], { name: 'Ada' },
  ];
  // Every BMP code point alone, at each edge of a name and inside one: the trim set, the refused set and the visible
  // set all meet here.
  for (let code = 0; code <= 0xffff; code++) {
    const ch = unit(code);
    corpus.push(ch, `${ch}Ada`, `Ada${ch}`, `A${ch}da`);
  }
  for (const code of [0x10000, 0x1f600, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef, 0x1bca0, 0x1d173, 0x1d17a, 0x10ffff]) {
    corpus.push(cp(code), `${cp(code)}Ada`, `Ada${cp(code)}`, `A${cp(code)}da`);
  }
  let accepted = 0;
  let refused = 0;
  for (const raw of corpus) {
    const theirs = serverNormalizeCustomerName(raw);
    const mine = normalizeCustomerName(raw);
    if (mine !== theirs) {
      const shown = typeof raw === 'string' ? [...raw].map((c) => c.codePointAt(0)!.toString(16)).slice(0, 8).join(' ') : String(raw);
      assert.fail(`the name rules disagree on [${shown}]: server ${theirs === null ? 'refuses' : 'accepts'}, client ${mine === null ? 'refuses' : 'accepts'}`);
    }
    if (theirs === null) refused += 1; else accepted += 1;
  }
  assert.ok(accepted > 100_000 && refused > 1_000, `the sweep must exercise both answers (accepted ${accepted}, refused ${refused})`);
  // Anchors, so the sweep is not two copies of one mistake.
  assert.equal(normalizeCustomerName('  Ada  Lovelace  '), 'Ada  Lovelace');
  assert.equal(normalizeCustomerName(astral.repeat(200)), astral.repeat(200));
  assert.equal(normalizeCustomerName(astral.repeat(201)), null);
  assert.equal(normalizeCustomerName(`Ada${cp(0x202e)}`), null); // a bidi control
  assert.equal(normalizeCustomerName(cp(0x2800)), null); // nothing visible
  assert.equal(normalizeCustomerName(`Ada${unit(0xd800)}`), null); // a lone surrogate
});

test('CDC-12. the id rule is the server\'s canonical form, and the cursor grammar admits the server\'s continuations', async () => {
  const ids = [
    ID, OTHER, uuid(0), 'ffffffff-ffff-ffff-ffff-ffffffffffff', '00000000-0000-0000-0000-000000000000', '0b6f1d2e-3c4a-1b5c-0d6e-7f8091a2b3c4',
    ID.toUpperCase(), ID.replace(/-/g, ''), `{${ID}}`, ` ${ID}`, `${ID} `, `${ID}\n`, ID.slice(1), `${ID}0`, ID.replace('-', '_'),
    `${ID.slice(0, 35)}g`, 'new', '', 'c1700000000000', `urn:uuid:${ID}`,
  ];
  for (const id of ids) {
    assert.equal(isCustomerId(id), pathIdOf(`${CUSTOMER_DIRECTORY_PATH}/${id}`) === id, JSON.stringify(id));
  }
  assert.equal(isCustomerId(ID), true);
  for (const bad of [null, undefined, 7, {}, [ID]]) assert.equal(isCustomerId(bad), false);
  // Every continuation the server encodes is sent; the server decodes what was sent back to the same id.
  for (const id of [ID, OTHER, 'ffffffff-ffff-ffff-ffff-ffffffffffff', '00000000-0000-0000-0000-000000000000']) {
    const cursor = encodeCustomerCursor(id);
    const { sent, client } = once(page([], null));
    await client.list(cursor, CSRF);
    assert.equal(sent.length, 1);
    assert.equal(decodeCustomerCursor(sent[0].url.slice(`${CUSTOMERS_PATH}?cursor=`.length)), id);
  }
});

test('CDC-13. a read names its session in X-TMPOS-Session-CSRF: page one, a cursor page and a detail send Accept and that header only, never in the URL', async () => {
  const token = 'Zx9-_'.repeat(9).slice(0, 43); // a synthetic 43-character token, distinct from the shared one
  assert.equal(token.length, 43);
  const sends = [
    (c: ReturnType<typeof once>['client']) => c.list(null, token),
    (c: ReturnType<typeof once>['client']) => c.list(CURSOR, token),
    (c: ReturnType<typeof once>['client']) => c.detail(ID, token),
  ];
  for (const go of sends) {
    const { sent, client } = once(() => json(200, { customers: [], nextCursor: null }));
    await go(client);
    assert.equal(sent.length, 1);
    const [r] = sent;
    assert.equal(r.init.method, 'GET');
    assert.deepEqual(headerNames(r), ['accept', 'x-tmpos-session-csrf']);
    assert.equal(r.headers.get('accept'), 'application/json');
    assert.equal(r.headers.get('x-tmpos-session-csrf'), token);
    assert.ok(!r.url.includes(token), 'the session token rode the URL');
    assertSameOriginOnly(r);
  }
});

const PROFILE = { id: ID, name: 'Ada Lovelace', phone: '+1 555 0100', email: 'ada@example.test', createdAt: '2026-09-30T12:34:56.789Z' };
/** A profile 200 as the server writes it since M7A-CUSTOMERS-P7: the body and its row version as one strong ETag. */
const profiled = (body: unknown, etag: string | null = '"3"'): Response => json(200, body, etag === null ? {} : { etag });

test('CDC-14. profile: a malformed id sends nothing; the 200 must be exactly this customer\'s contact record, or it is unavailable', async () => {
  const good = once(profiled({ customer: PROFILE }));
  const result = await good.client.profile(ID, CSRF);
  assert.deepEqual(result, { kind: 'ok', customer: PROFILE, version: 3 });
  assert.ok(result.kind === 'ok' && Object.isFrozen(result) && Object.isFrozen(result.customer));
  assert.equal(good.sent.length, 1);
  assert.equal(good.sent[0].url, `${CUSTOMERS_PATH}/${ID}/profile`);
  assert.equal(good.sent[0].init.method, 'GET');
  assert.equal(good.sent[0].init.body, undefined);
  assert.deepEqual(headerNames(good.sent[0]), ['accept', 'x-tmpos-session-csrf']);
  assert.equal(good.sent[0].headers.get('x-tmpos-session-csrf'), CSRF);
  assert.ok(!good.sent[0].url.includes(CSRF), 'the session token rode the URL');
  assertSameOriginOnly(good.sent[0]);
  // A customer created before the server kept contacts or a creation time: every one null.
  const legacy = { id: ID, name: 'Ada', phone: null, email: null, createdAt: null };
  assert.deepEqual(await once(profiled({ customer: legacy })).client.profile(ID, CSRF), { kind: 'ok', customer: legacy, version: 3 });
  for (const bad of ['', 'new', ID.toUpperCase(), `${ID}/`, `${ID}/profile`, `../session/logout`, `${ID.slice(0, 35)}g`, `%2e%2e/${ID}`]) {
    const none = once(profiled({ customer: PROFILE }));
    assert.deepEqual(await none.client.profile(bad, CSRF), { kind: 'not-found' }, JSON.stringify(bad));
    assert.equal(none.sent.length, 0, `a malformed id reached the network: ${JSON.stringify(bad)}`);
  }
  const unavailable: unknown[] = [
    { customer: { ...PROFILE, id: OTHER } }, // another customer's record
    { customer: { id: ID, name: 'Ada Lovelace' } }, // the detail's shape is not a profile
    { customer: { ...PROFILE, loyalty: 3 } },
    { customer: PROFILE, tenant: uuid(9) },
    { customer: { id: ID, name: 'A', phone: null, email: null } },
    { customer: { ...PROFILE, name: 7 } },
    { customer: { ...PROFILE, name: '' } }, // not a name the server could have stored
    { customer: { ...PROFILE, name: 'x'.repeat(201) } },
    { customer: { ...PROFILE, name: cp(0x1f600).repeat(201) } },
    { customer: { ...PROFILE, name: `Ada${unit(0xd800)}` } }, // a lone surrogate
    { customer: { ...PROFILE, name: `${unit(0xdfff)}Ada` } },
    { customer: { ...PROFILE, phone: 15550100 } },
    { customer: { ...PROFILE, email: {} } },
    { customer: { ...PROFILE, phone: '' } }, // absent is null, never an empty string
    { customer: { ...PROFILE, phone: ' +1 555 0100' } }, // not as stored: untrimmed
    { customer: { ...PROFILE, phone: 'no digits' } },
    { customer: { ...PROFILE, phone: `+1 555${cp(0x202e)}0100` } },
    { customer: { ...PROFILE, phone: '1'.repeat(65) } }, // over the bound
    { customer: { ...PROFILE, email: 'ada example.test' } },
    { customer: { ...PROFILE, email: 'ada@@example.test' } },
    { customer: { ...PROFILE, email: '@example.test' } },
    { customer: { ...PROFILE, email: `${'a'.repeat(242)}@example.test` } }, // 255 characters
    { customer: { ...PROFILE, createdAt: '2026-09-30T12:34:56Z' } }, // no milliseconds
    { customer: { ...PROFILE, createdAt: '2026-09-30T12:34:56.789+00:00' } },
    { customer: { ...PROFILE, createdAt: '2026-09-30t12:34:56.789z' } },
    { customer: { ...PROFILE, createdAt: '2026-02-30T00:00:00.000Z' } }, // not an instant that spells itself back
    { customer: { ...PROFILE, createdAt: '+002026-09-30T12:34:56.789Z' } },
    { customer: { ...PROFILE, createdAt: 1790000000000 } },
    { customer: { ...PROFILE, createdAt: '' } },
    { customers: [PROFILE], nextCursor: null },
  ];
  for (const body of unavailable) assert.deepEqual(await once(profiled(body)).client.profile(ID, CSRF), { kind: 'unavailable' }, JSON.stringify(body));
  // At the bounds, a stored value is a value: a 200-scalar name (astral too), and the longest contacts.
  for (const name of ['x'.repeat(200), cp(0x1f600).repeat(200), 'A']) {
    assert.equal((await once(profiled({ customer: { ...PROFILE, name } })).client.profile(ID, CSRF)).kind, 'ok', `${[...name].length} scalars`);
  }
  const edge = { ...PROFILE, phone: '1'.repeat(64), email: `${'a'.repeat(241)}@example.test` };
  assert.equal(edge.email.length, 254);
  assert.equal((await once(profiled({ customer: edge })).client.profile(ID, CSRF)).kind, 'ok');
  const cases: Array<[Reply, unknown]> = [
    [new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html', etag: '"3"' } }), { kind: 'unavailable' }],
    [json(201, { customer: PROFILE }, { etag: '"3"' }), { kind: 'unavailable' }],
    [refusal(404, 'not_found'), { kind: 'not-found' }],
    [refusal(400, 'invalid_request'), { kind: 'unavailable' }],
    [refusal(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refusal(403, 'forbidden'), { kind: 'denied' }],
    [refusal(429, 'rate_limited', { 'retry-after': '12' }), { kind: 'rate-limited', retryAfterSeconds: 12 }],
    [refusal(429, 'rate_limited'), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refusal(503, 'service_unavailable'), { kind: 'unavailable' }],
    [new TypeError('network'), { kind: 'unavailable' }],
  ];
  for (const [reply, expected] of cases) assert.deepEqual(await once(reply).client.profile(ID, CSRF), expected);
  assert.deepEqual(await hanging(5).client.profile(ID, CSRF), { kind: 'unavailable' });
});

test('CDC-15. the phone and email rules accept, refuse and normalize exactly as the server\'s do; the creation-time grammar is the server\'s', async () => {
  const astral = cp(0x1f600);
  const phones: unknown[] = [
    '', ' ', '+1 555 0100', '  +1 555 0100  ', '(555) 010-0100 ext. 7', '0', 'x', 'phone', '+', `${cp(0x661)}`, // an Arabic-Indic digit is no ASCII digit
    '1'.repeat(64), '1'.repeat(65), ` ${'1'.repeat(64)} `, `1${astral.repeat(63)}`, `1${astral.repeat(64)}`, `+1\t555`, `+1\n555`,
  ];
  const emails: unknown[] = [
    '', ' ', 'ada@example.test', '  ada@example.test  ', 'Ada.Lovelace+tag@Example.TEST', 'a@b', 'ada', '@example.test', 'ada@', 'ada@@example.test',
    'a@b@c', 'ada @example.test', `ada${cp(0xa0)}@example.test`, `ada${cp(0x3000)}@example.test`, `${'a'.repeat(241)}@example.test`,
    `${'a'.repeat(242)}@example.test`, `${astral.repeat(250)}@b.c`, `${astral.repeat(251)}@b.c`, `ada@example.test${cp(0x200b)}`,
  ];
  for (const other of [null, undefined, 0, 7, true, {}, [], ['+1 555 0100']]) { phones.push(other); emails.push(other); }
  for (let code = 0; code <= 0xffff; code++) {
    const ch = unit(code);
    phones.push(ch, `${ch}+1 555 0100`, `+1 555 0100${ch}`, `+1 555${ch}0100`);
    emails.push(ch, `${ch}ada@example.test`, `ada@example.test${ch}`, `ada${ch}@example.test`, `ada@exa${ch}mple.test`);
  }
  for (const code of [0x10000, 0x1f600, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0x1d173, 0x10ffff]) {
    phones.push(`${cp(code)}1`, `1${cp(code)}`);
    emails.push(`${cp(code)}a@b`, `a@b${cp(code)}`);
  }
  for (const [label, corpus, mine, theirs] of [
    ['phone', phones, normalizeCustomerPhone, serverNormalizeCustomerPhone],
    ['email', emails, normalizeCustomerEmail, serverNormalizeCustomerEmail],
  ] as const) {
    const tally = { value: 0, absent: 0, invalid: 0 };
    for (const raw of corpus) {
      const server = theirs(raw);
      const client = mine(raw);
      const same = server === CONTACT_REFUSED ? client === CONTACT_INVALID : client === server;
      if (!same) {
        const shown = typeof raw === 'string' ? [...raw].map((c) => c.codePointAt(0)!.toString(16)).slice(0, 8).join(' ') : String(raw);
        assert.fail(`the ${label} rules disagree on [${shown}]: server ${String(server)}, client ${String(client)}`);
      }
      if (server === CONTACT_REFUSED) tally.invalid += 1; else if (server === null) tally.absent += 1; else tally.value += 1;
    }
    assert.ok(tally.value > 100_000 && tally.invalid > 1_000 && tally.absent > 10, `the ${label} sweep must exercise every answer ${JSON.stringify(tally)}`);
  }
  // Anchors, so the sweep is not two copies of one mistake.
  assert.equal(normalizeCustomerPhone('  +1 555 0100  '), '+1 555 0100');
  assert.equal(normalizeCustomerPhone('   '), null);
  assert.equal(normalizeCustomerPhone(null), null);
  assert.equal(normalizeCustomerPhone('no digits'), CONTACT_INVALID);
  assert.equal(normalizeCustomerPhone('1'.repeat(65)), CONTACT_INVALID);
  assert.equal(normalizeCustomerPhone(7), CONTACT_INVALID);
  assert.equal(normalizeCustomerEmail(' ada@example.test '), 'ada@example.test');
  assert.equal(normalizeCustomerEmail(''), null);
  assert.equal(normalizeCustomerEmail('ada example@test'), CONTACT_INVALID);
  assert.equal(normalizeCustomerEmail('a@b@c'), CONTACT_INVALID);
  assert.equal(normalizeCustomerEmail(`ada@example.test${cp(0x202e)}`), CONTACT_INVALID);
  // The profile's createdAt grammar is exactly the runtime's.
  const times: unknown[] = [
    null, '2026-09-30T12:34:56.789Z', '1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', '2024-02-29T00:00:00.000Z', '2026-02-29T00:00:00.000Z',
    '2026-09-30T12:34:56Z', '2026-09-30T24:00:00.000Z', '2026-09-30T12:34:60.000Z', '2026-13-01T00:00:00.000Z', '2026-09-30 12:34:56.789Z',
    '+002026-09-30T12:34:56.789Z', '2026-09-30T12:34:56.789+00:00', '', 0, undefined,
  ];
  let admitted = 0;
  for (const at of times) {
    const answer = await once(profiled({ customer: { ...PROFILE, createdAt: at } })).client.profile(ID, CSRF);
    assert.equal(answer.kind === 'ok', isCustomerCreatedAt(at), JSON.stringify(at)); // undefined: the key is missing
    if (answer.kind === 'ok') admitted += 1;
  }
  assert.equal(admitted, 5);
});

// M7A-CUSTOMERS-P7 — the profile's version, and the edit.
const ROW = { id: ID, name: 'Ada King' };
const saved = (body: unknown = { customer: ROW, version: 4, changed: true }, headers: Record<string, string> = {}): Response => json(200, body, headers);
const EDIT = JSON.stringify({ expectedVersion: 3, name: 'Ada King', email: null });

test('CDC-16. profile: the version is the one strong ETag "<n>" (n 1..2^53-1, no leading zero); missing, weak, listed, malformed, out of range or a 304 is unavailable', async () => {
  for (const [etag, version] of [['"1"', 1], ['"3"', 3], ['"10"', 10], [`"${Number.MAX_SAFE_INTEGER}"`, Number.MAX_SAFE_INTEGER]] as const) {
    assert.equal(versionOfEtag(etag), version, etag);
    assert.deepEqual(await once(profiled({ customer: PROFILE }, etag)).client.profile(ID, CSRF), { kind: 'ok', customer: PROFILE, version }, etag);
  }
  const refused: Array<string | null> = [
    null, '', '3', '"0"', '"03"', '"-1"', '"+3"', '"3.0"', '"1e3"', 'W/"3"', 'w/"3"', '"3", "4"', '"3","4"', ' "3"', '"3" ', '"3', '3"', "'3'", '"0x3"',
    `"${Number.MAX_SAFE_INTEGER + 1}"`, '"9999999999999999"', '"12345678901234567"', '"abc"', `"${cp(0x663)}"`,
  ];
  for (const etag of refused) {
    assert.equal(versionOfEtag(etag), null, String(etag));
    // A header value arrives trimmed (Fetch normalizes it), and only as bytes: those two are checked on the parser alone.
    if (etag !== null && (etag.trim() !== etag || /[^\u0000-\u00ff]/.test(etag))) continue;
    assert.deepEqual(await once(profiled({ customer: PROFILE }, etag)).client.profile(ID, CSRF), { kind: 'unavailable' }, String(etag));
  }
  // Two ETag headers arrive as one list: never a version.
  const two = new Response(JSON.stringify({ customer: PROFILE }), { status: 200, headers: [['content-type', 'application/json'], ['etag', '"3"'], ['etag', '"4"']] });
  assert.deepEqual(await once(two).client.profile(ID, CSRF), { kind: 'unavailable' });
  // A 304 (the client never sends a validator) is not a result.
  assert.deepEqual(await once(new Response(null, { status: 304, headers: { etag: '"3"' } })).client.profile(ID, CSRF), { kind: 'unavailable' });
  // No validator is ever sent.
  const read = once(profiled({ customer: PROFILE }));
  await read.client.profile(ID, CSRF);
  assert.equal(read.sent[0].headers.get('if-none-match'), null);
  assert.equal(read.sent[0].headers.get('if-match'), null);
});

test('CDC-17. update: a PATCH of the caller\'s exact bytes to this customer, with the five headers of a create; a malformed id sends nothing', async () => {
  const r = once(saved());
  const body = ` ${EDIT}`; // whatever the caller built, byte for byte
  await r.client.update(ID, body, KEY, CSRF);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].url, `${CUSTOMERS_PATH}/${ID}`);
  assert.equal(r.sent[0].init.method, 'PATCH');
  assert.equal(r.sent[0].init.body, body);
  assert.deepEqual(headerNames(r.sent[0]), ['accept', 'content-type', 'idempotency-key', 'x-tmpos-csrf', 'x-tmpos-session-csrf']);
  assert.equal(r.sent[0].headers.get('content-type'), 'application/json');
  assert.equal(r.sent[0].headers.get('idempotency-key'), KEY);
  assert.equal(r.sent[0].headers.get('x-tmpos-csrf'), '1');
  assert.equal(r.sent[0].headers.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(r.sent[0].headers.get('if-match'), null);
  assertSameOriginOnly(r.sent[0]);
  for (const bad of ['', 'new', ID.toUpperCase(), `${ID}/`, `${ID}/profile`, `../session/logout`, `%2e%2e/${ID}`]) {
    const none = once(saved());
    assert.deepEqual(await none.client.update(bad, EDIT, KEY, CSRF), { kind: 'not-found' }, JSON.stringify(bad));
    assert.equal(none.sent.length, 0, `a malformed id reached the network: ${JSON.stringify(bad)}`);
  }
});

test('CDC-18. update: saved is an exactly-shaped 200 for this customer only; every other answer maps to one outcome, and no answer is never a refusal', async () => {
  const ok = await once(saved()).client.update(ID, EDIT, KEY, CSRF);
  assert.deepEqual(ok, { kind: 'saved', customer: ROW, version: 4, changed: true });
  assert.ok(Object.isFrozen(ok) && ok.kind === 'saved' && Object.isFrozen(ok.customer));
  assert.deepEqual(await once(saved({ customer: ROW, version: 3, changed: false })).client.update(ID, EDIT, KEY, CSRF), { kind: 'saved', customer: ROW, version: 3, changed: false });
  assert.deepEqual(await once(saved(undefined, { 'idempotent-replayed': 'true' })).client.update(ID, EDIT, KEY, CSRF), { kind: 'saved', customer: ROW, version: 4, changed: true });
  const undecided: unknown[] = [
    { customer: { id: OTHER, name: 'Ada King' }, version: 4, changed: true }, // another customer
    { customer: { id: ID.toUpperCase(), name: 'Ada King' }, version: 4, changed: true },
    { customer: { ...ROW, phone: '+1 555 0100' }, version: 4, changed: true }, // the 200 names no contact
    { customer: ROW, version: 4, changed: true, tenant: uuid(9) },
    { customer: ROW, version: 4 },
    { customer: ROW, changed: true },
    { customer: ROW, version: 0, changed: true },
    { customer: ROW, version: -1, changed: true },
    { customer: ROW, version: 4.5, changed: true },
    { customer: ROW, version: '4', changed: true },
    { customer: ROW, version: Number.MAX_SAFE_INTEGER + 1, changed: true },
    { customer: ROW, version: 4, changed: 'true' },
    { customer: ROW, version: 4, changed: null },
    { customer: { name: 'Ada King' }, version: 4, changed: true },
    { customer: { ...ROW, name: 7 }, version: 4, changed: true },
    [],
    null,
  ];
  for (const body of undecided) assert.deepEqual(await once(saved(body)).client.update(ID, EDIT, KEY, CSRF), { kind: 'unknown', responded: true }, JSON.stringify(body));
  const cases: Array<[Reply, unknown]> = [
    [new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }), { kind: 'unknown', responded: true }],
    [json(201, { customer: ROW, version: 4, changed: true }), { kind: 'unknown', responded: true }],
    [new Response(null, { status: 204 }), { kind: 'unknown', responded: true }],
    [refusal(409, 'write_conflict'), { kind: 'conflict' }],
    [refusal(409, 'request_in_progress'), { kind: 'in-progress' }],
    [refusal(409, 'conflict'), { kind: 'unknown', responded: true }],
    [new Response('conflict', { status: 409 }), { kind: 'unknown', responded: true }],
    [refusal(404, 'not_found'), { kind: 'not-found' }],
    [refusal(400, 'invalid_request'), { kind: 'invalid' }],
    [refusal(413, 'content_too_large'), { kind: 'invalid' }],
    [refusal(415, 'unsupported_media_type'), { kind: 'invalid' }],
    [refusal(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refusal(403, 'forbidden'), { kind: 'denied' }],
    [refusal(422, 'idempotency_key_reused'), { kind: 'key-reused' }],
    [refusal(429, 'rate_limited', { 'retry-after': '12' }), { kind: 'rate-limited', retryAfterSeconds: 12 }],
    [refusal(429, 'rate_limited'), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refusal(500, 'internal_error'), { kind: 'unknown', responded: true }],
    [refusal(503, 'service_unavailable'), { kind: 'unknown', responded: true }],
    [refusal(412, 'precondition_failed'), { kind: 'unknown', responded: true }],
    [new TypeError('network'), { kind: 'unknown', responded: false }],
  ];
  for (const [reply, expected] of cases) assert.deepEqual(await once(reply).client.update(ID, EDIT, KEY, CSRF), expected);
  assert.deepEqual(await hanging(5).client.update(ID, EDIT, KEY, CSRF), { kind: 'unknown', responded: false });
  const aborted = new AbortController();
  aborted.abort();
  const early = once(saved());
  assert.deepEqual(await early.client.update(ID, EDIT, KEY, CSRF, aborted.signal), { kind: 'unknown', responded: false });
  assert.equal(early.sent.length, 0);
});

test('CDC-19. the edit body: expectedVersion, name (always), then only the contacts that differ from the profile — a blank one clears (null); invalid fields send nothing; a form equal to the profile is unchanged', () => {
  const base = { id: ID, name: 'Ada Lovelace', phone: '+1 555 0100', email: 'ada@example.test', createdAt: null };
  const of = (name: string, phone: string, email: string) => customerEditBody(base, 3, { name, phone, email });
  assert.deepEqual(of('Ada Lovelace', '+1 555 0100', 'ada@example.test'), { kind: 'unchanged' });
  assert.deepEqual(of(' Ada Lovelace ', ' +1 555 0100 ', '  ada@example.test'), { kind: 'unchanged' }); // as normalized
  assert.deepEqual(of('Ada King', '+1 555 0100', 'ada@example.test'), { kind: 'ok', body: '{"expectedVersion":3,"name":"Ada King"}', name: 'Ada King' });
  assert.deepEqual(of('Ada Lovelace', '', 'ada@example.test'), { kind: 'ok', body: '{"expectedVersion":3,"name":"Ada Lovelace","phone":null}', name: 'Ada Lovelace' });
  assert.deepEqual(of(' Ada King ', ' +1 555 0199 ', '   '), {
    kind: 'ok', body: '{"expectedVersion":3,"name":"Ada King","phone":"+1 555 0199","email":null}', name: 'Ada King',
  });
  assert.deepEqual(of('Ada Lovelace', '+1 555 0100', 'ada.k@example.test'), {
    kind: 'ok', body: '{"expectedVersion":3,"name":"Ada Lovelace","email":"ada.k@example.test"}', name: 'Ada Lovelace',
  });
  assert.deepEqual(of('   ', 'no digits', 'a@@b'), { kind: 'invalid', name: true, phone: true, email: true });
  assert.deepEqual(of('Ada', '1'.repeat(65), 'ada@example.test'), { kind: 'invalid', name: false, phone: true, email: false });
  assert.deepEqual(of(`Ada${cp(0x202e)}`, '', ''), { kind: 'invalid', name: true, phone: false, email: false });
  // A customer with no contacts: a blank field is no change, a value is set.
  const legacy = { ...base, phone: null, email: null };
  assert.deepEqual(customerEditBody(legacy, 1, { name: 'Ada Lovelace', phone: ' ', email: '' }), { kind: 'unchanged' });
  assert.deepEqual(customerEditBody(legacy, 1, { name: 'Ada Lovelace', phone: '+1 555 0100', email: '' }), {
    kind: 'ok', body: '{"expectedVersion":1,"name":"Ada Lovelace","phone":"+1 555 0100"}', name: 'Ada Lovelace',
  });
  // The body is built once: the same inputs give the same bytes, and the keys are in the one order.
  const built = of('Ada King', '', 'ada.k@example.test');
  assert.ok(built.kind === 'ok');
  assert.equal(built.body, (of('Ada King', '', 'ada.k@example.test') as { body: string }).body);
  assert.deepEqual(Object.keys(JSON.parse(built.body) as object), ['expectedVersion', 'name', 'phone', 'email']);
});
