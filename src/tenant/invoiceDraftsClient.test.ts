// M7B-INVOICES-P1 — the shop's invoice drafts client against a scripted fetch: what each request carries (path, headers,
// the exact body bytes), the exact answers it accepts, and the one outcome every other answer maps to; and the shop's own
// checks before a create: exact dollar-to-cent parsing (BigInt, no float anywhere), whole quantities, the 2^53-1 bound on
// every line and on the subtotal, the description rule (the customer name rule at 256) and the body's 64 KiB in exact UTF-8
// bytes. Every accepted answer is one server/runtime/invoiceDrafts.ts and storeDirectory.ts would serve, and nothing they
// would refuse to serve is accepted. Ids are built at run time (secret scanning), special characters from code points, so
// the test data stays ASCII.
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_BODY_MAX_BYTES, DRAFT_PAGE_LIMIT, MAX_CENTS, STORES_PATH, createInvoiceDraftsClient, draftBody, draftPathOf, draftsPathOf, formatCents,
  isDraftBodyTooLarge, isDraftCreatedAt, normalizeDraftDescription, parsePriceCents, parseQuantity,
} from './invoiceDraftsClient';
import { normalizeCustomerName } from './customersClient';

const cp = (code: number): string => String.fromCodePoint(code);
const unit = (code: number): string => String.fromCharCode(code);
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const STORE = uuid(0x5a1);
const TENANT = uuid(0x7e1);
const CUSTOMER = uuid(0xc51);
const DRAFT = uuid(0xd41);
const KEY = ['7c5e7a9b', '1d2f', '4a6b', '9c8d', '0e1f2a3b4c5d'].join('-');
const CSRF = 'c'.repeat(43);
/** The server's continuation (invoiceDrafts.ts encodeInvoiceDraftCursor): tag byte 0x01, then the anchor's 16 id bytes. */
const cursorOf = (id: string, tag = 0x01): string => Buffer.concat([Buffer.from([tag]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url');
const CURSOR = cursorOf(uuid(0xd099));
const MAX = Number.MAX_SAFE_INTEGER;

interface Call { readonly url: string; readonly init: RequestInit }
/** A fetch that records each call and answers from `script` (a Response, or a thrown error for no answer). */
function scripted(...script: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = script.shift();
    if (next === undefined) throw new Error('unscripted');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { calls, client: createInvoiceDraftsClient({ fetch }) };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
/** A JSON answer whose text is `body` with `from` replaced by `to` (for what JSON.stringify never writes, like -0). */
const raw = (body: unknown, from: string, to: string): Response => {
  const text = JSON.stringify(body);
  assert.ok(text.includes(from), from);
  return new Response(text.replace(from, to), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
};
const headersOf = (call: Call): Headers => new Headers(call.init.headers);
/** A refusal exactly as the server sends one (app.ts refuse, invoiceDrafts.ts refuse, sessions.ts): `{ error, requestId }`. */
const refused = (status: number, error: string, headers: Record<string, string> = {}): Response => json(status, { error, requestId: 'req-synthetic' }, headers);

const storeRow = (n: number, extra: Record<string, unknown> = {}) => ({ id: uuid(0x5000 + n), tenantId: TENANT, name: `Store ${String(n).padStart(3, '0')}`, readOnly: false, ...extra });
const at = (second: number, micros = 0): string => `2026-10-04T12:00:${String(second).padStart(2, '0')}.${String(micros).padStart(6, '0')}Z`;
const summary = (n: number, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ id: uuid(0xd000 + n), customerId: CUSTOMER, status: 'draft', currency: 'USD', lineCount: 1, subtotalCents: 100, createdAt, ...extra });
const detailBody = (extra: Record<string, unknown> = {}, lines?: unknown[]) => ({
  draft: {
    id: DRAFT, storeId: STORE, customerId: CUSTOMER, status: 'draft', currency: 'USD', version: 1, createdAt: at(1, 123456), subtotalCents: 2550,
    lines: lines ?? [
      { position: 1, description: 'Screen repair', quantity: 1, unitPriceCents: 2000, lineTotalCents: 2000 },
      { position: 2, description: 'Cable', quantity: 2, unitPriceCents: 275, lineTotalCents: 550 },
    ],
    ...extra,
  },
});

test('IDC-01. every request is same-origin, credentialed, uncached, never redirected, with no referrer; reads carry the session token and nothing else', async () => {
  const { calls, client } = scripted(json(200, { stores: [] }), json(200, { drafts: [], nextCursor: null }), refused(404, 'not_found'));
  await client.listStores(CSRF);
  await client.listDrafts(STORE, null, CSRF);
  await client.getDraft(STORE, DRAFT, CSRF);
  assert.deepEqual(calls.map((c) => c.url), [STORES_PATH, `${draftsPathOf(STORE)}?limit=${DRAFT_PAGE_LIMIT}`, draftPathOf(STORE, DRAFT)]);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.mode, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    const h = headersOf(call);
    assert.equal(h.get('x-tmpos-session-csrf'), CSRF);
    assert.equal(h.get('idempotency-key'), null);
    assert.equal(h.get('x-tmpos-csrf'), null);
    assert.equal(call.init.body, undefined);
  }
});

test('IDC-02. stores: the exact entries in the server order (a null name too); any other shape, a repeat, more than 200, a wrong type is unavailable', async () => {
  const rows = [storeRow(1), storeRow(2, { name: null, readOnly: true })];
  const ok = await scripted(json(200, { stores: rows })).client.listStores(CSRF);
  assert.deepEqual(ok, { kind: 'ok', stores: rows });
  assert.ok(Object.isFrozen(ok) && ok.kind === 'ok' && Object.isFrozen(ok.stores[0]));
  // The server's order (storeDirectory.ts): name in UTF-8 byte order — code point order, NOT UTF-16 order: U+FFFD sorts
  // before an astral name although its code unit is larger — equal names by id, unnamed stores last by id.
  const ordered = [
    storeRow(9, { name: 'Alpha' }), storeRow(3, { name: 'Beta' }), storeRow(4, { name: 'Beta' }), storeRow(1, { name: cp(0xfffd) }),
    storeRow(2, { name: cp(0x1f600) }), storeRow(5, { name: null }), storeRow(6, { name: null }),
  ];
  assert.equal((await scripted(json(200, { stores: ordered })).client.listStores(CSRF)).kind, 'ok');
  // A name of 256 scalars is served (256 astral scalars are 512 UTF-16 units); 257, or an empty name, never is.
  assert.equal((await scripted(json(200, { stores: [storeRow(1, { name: cp(0x1f600).repeat(256) })] })).client.listStores(CSRF)).kind, 'ok');
  const swap = (i: number) => ordered.map((row, j) => (j === i ? ordered[i + 1] : j === i + 1 ? ordered[i] : row));
  const bad: unknown[] = [
    { stores: rows, more: false }, { stores: [{ ...storeRow(1), extra: 1 }] }, { stores: [storeRow(1), storeRow(1)] },
    { stores: [storeRow(1, { id: STORE.toUpperCase() })] }, { stores: [storeRow(1, { tenantId: 'x' })] }, { stores: [storeRow(1, { readOnly: 'no' })] },
    { stores: [storeRow(1, { name: 7 })] }, { stores: [storeRow(1, { name: unit(0xd800) })] }, { stores: [storeRow(1, { name: 'x'.repeat(1025) })] },
    { stores: [storeRow(1, { name: '' })] }, { stores: [storeRow(1, { name: 'x'.repeat(257) })] }, { stores: [storeRow(1, { name: cp(0x1f600).repeat(257) })] },
    ...[0, 1, 2, 3, 4, 5].map((i) => ({ stores: swap(i) })), // each neighbouring pair out of order (3: UTF-16 order, not the server's)
    { stores: [storeRow(1, { name: 'A' }), storeRow(1, { name: 'B' })] }, // one id twice, the names in order
    { stores: Array.from({ length: 201 }, (_, i) => storeRow(i)) }, { stores: {} }, [],
  ];
  for (const body of bad) assert.deepEqual(await scripted(json(200, body)).client.listStores(CSRF), { kind: 'unavailable' }, JSON.stringify(body).slice(0, 80));
  assert.equal((await scripted(json(200, { stores: Array.from({ length: 200 }, (_, i) => storeRow(i)) })).client.listStores(CSRF)).kind, 'ok');
  assert.deepEqual(await scripted(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })).client.listStores(CSRF), { kind: 'unavailable' });
  assert.deepEqual(await scripted(refused(401, 'unauthenticated')).client.listStores(CSRF), { kind: 'signed-out' });
  assert.deepEqual(await scripted(refused(403, 'forbidden')).client.listStores(CSRF), { kind: 'denied' });
  assert.deepEqual(await scripted(refused(429, 'rate_limited', { 'retry-after': '7' })).client.listStores(CSRF), { kind: 'rate-limited', retryAfterSeconds: 7 });
  assert.deepEqual(await scripted(refused(429, 'rate_limited')).client.listStores(CSRF), { kind: 'rate-limited', retryAfterSeconds: 60 });
  assert.deepEqual(await scripted(refused(503, 'service_unavailable')).client.listStores(CSRF), { kind: 'unavailable' });
  assert.deepEqual(await scripted(new Error('offline')).client.listStores(CSRF), { kind: 'unavailable' });
});

test('IDC-03. a page: newest first by (createdAt, id) — equal times tie on the id — a cursor only behind a full page, naming its last draft; the cursor rides verbatim; nothing else is a page', async () => {
  const full = Array.from({ length: DRAFT_PAGE_LIMIT }, (_, i) => summary(100 - i, at(30))); // one shared microsecond: ids decide
  const NEXT = cursorOf(full[full.length - 1].id); // what the server writes behind a full page: its last draft
  const { calls, client } = scripted(json(200, { drafts: full, nextCursor: NEXT }), json(200, { drafts: [summary(1, at(1))], nextCursor: null }));
  const first = await client.listDrafts(STORE, null, CSRF);
  assert.equal(first.kind, 'ok');
  assert.equal(first.kind === 'ok' && first.nextCursor, NEXT);
  const second = await client.listDrafts(STORE, NEXT, CSRF);
  assert.deepEqual(second, { kind: 'ok', drafts: [summary(1, at(1))], nextCursor: null });
  assert.equal(calls[1].url, `${draftsPathOf(STORE)}?limit=${DRAFT_PAGE_LIMIT}&cursor=${NEXT}`); // the anchor only: no timestamp is ever sent
  // The page after an anchor never holds the anchor itself (invoiceDraftPageOf refuses it).
  assert.deepEqual(await scripted(json(200, { drafts: [summary(1, at(1))], nextCursor: null })).client.listDrafts(STORE, cursorOf(summary(1, at(1)).id), CSRF), { kind: 'unavailable' });
  const page = (drafts: unknown[], nextCursor: unknown = null) => ({ drafts, nextCursor });
  const bad: unknown[] = [
    page([summary(1, at(1)), summary(2, at(2))]), // oldest first
    page([summary(1, at(5)), summary(2, at(5))]), // equal time, ids ascending
    page([summary(1, at(5)), summary(1, at(5))]), // a repeat
    page([summary(1, at(6)), summary(1, at(5))]), // a repeat at another time (still in order)
    page([summary(1, at(1))], CURSOR), // a cursor behind a short page
    page([], CURSOR), page(Array.from({ length: DRAFT_PAGE_LIMIT + 1 }, (_, i) => summary(200 - i, at(1)))),
    page([summary(1, at(1))], 'short'), page([summary(1, '2026-10-04T12:00:01.123Z')]), page([summary(1, '2026-02-30T12:00:01.000000Z')]),
    page([summary(1, at(1), { status: 'issued' })]), page([summary(1, at(1), { currency: 'EUR' })]), page([summary(1, at(1), { lineCount: 0 })]),
    page([summary(1, at(1), { lineCount: 51 })]), page([summary(1, at(1), { subtotalCents: MAX + 1 })]), page([summary(1, at(1), { subtotalCents: 1.5 })]),
    page([summary(1, at(1), { subtotalCents: '100' })]), page([summary(1, at(1), { extra: true })]), page([summary(1, at(1), { customerId: 'c1' })]),
    { drafts: [], nextCursor: null, more: false },
    page(full, CURSOR), page(full, cursorOf(full[0].id)), // a well-formed cursor that does not name the page's last draft
    page(full, cursorOf(full[full.length - 1].id, 0x0d)), page(full, 'A'.repeat(23)), // another tag
    page(full, `${CURSOR.slice(0, -1)}${CURSOR.endsWith('B') ? 'C' : 'B'}`), // a second spelling: the unused low bits set
  ];
  for (const body of bad) assert.deepEqual(await scripted(json(200, body)).client.listDrafts(STORE, null, CSRF), { kind: 'unavailable' }, JSON.stringify(body).slice(0, 120));
  // -0 is JSON the server never writes (its isWhole refuses it): never an amount or a count here.
  for (const [from, to] of [['"subtotalCents":100', '"subtotalCents":-0'], ['"lineCount":1', '"lineCount":-0']]) {
    assert.deepEqual(await scripted(raw(page([summary(1, at(1))]), from, to)).client.listDrafts(STORE, null, CSRF), { kind: 'unavailable' }, to);
  }
  assert.deepEqual(await scripted(refused(400, 'invalid_request')).client.listDrafts(STORE, CURSOR, CSRF), { kind: 'bad-cursor' });
  assert.deepEqual(await scripted(refused(400, 'invalid_request')).client.listDrafts(STORE, null, CSRF), { kind: 'unavailable' });
  assert.deepEqual(await scripted(refused(403, 'forbidden')).client.listDrafts(STORE, null, CSRF), { kind: 'denied' });
  assert.deepEqual(await scripted(refused(401, 'unauthenticated')).client.listDrafts(STORE, null, CSRF), { kind: 'signed-out' });
  assert.deepEqual(await scripted(refused(429, 'rate_limited', { 'retry-after': '3' })).client.listDrafts(STORE, null, CSRF), { kind: 'rate-limited', retryAfterSeconds: 3 });
});

test('IDC-04. a store id or a cursor outside its grammar is never put into a request', async () => {
  const { calls, client } = scripted();
  for (const store of ['', 'store-1', STORE.toUpperCase(), `${STORE}/x`, '../stores']) {
    assert.deepEqual(await client.listDrafts(store, null, CSRF), { kind: 'denied' });
    assert.deepEqual(await client.getDraft(store, DRAFT, CSRF), { kind: 'not-found' });
    assert.deepEqual(await client.createDraft(store, '{"lines":[]}', KEY, CSRF), { kind: 'invalid' });
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = `${CURSOR.slice(0, -1)}${alphabet[alphabet.indexOf(CURSOR.slice(-1)) ^ 1]}`; // invoiceDraftsHttp IDH-11's second spelling
  for (const cursor of ['', 'A'.repeat(22), 'A'.repeat(24), `${'A'.repeat(22)}=`, `${'A'.repeat(21)}&x`, 'A'.repeat(23), 'x'.repeat(23),
    cursorOf(uuid(0xd099), 0x02), cursorOf(uuid(0xd099), 0x0d), cursorOf(uuid(0xd099), 0x00), alias]) {
    assert.deepEqual(await client.listDrafts(STORE, cursor, CSRF), { kind: 'bad-cursor' });
  }
  assert.deepEqual(await client.getDraft(STORE, 'd1', CSRF), { kind: 'not-found' });
  assert.deepEqual(calls, []);
});

test('IDC-05. a draft: exactly its fields for the store and id asked, lines 1..n in order, every total its own BigInt product, the subtotal their sum', async () => {
  const ok = await scripted(json(200, detailBody())).client.getDraft(STORE, DRAFT, CSRF);
  assert.equal(ok.kind, 'ok');
  assert.deepEqual(ok.kind === 'ok' && ok.draft.lines.map((l) => l.lineTotalCents), [2000, 550]);
  // The largest exact amounts: one line of 2^53-1 cents.
  const big = await scripted(json(200, detailBody({ subtotalCents: MAX }, [{ position: 1, description: 'x', quantity: 1, unitPriceCents: MAX, lineTotalCents: MAX }]))).client.getDraft(STORE, DRAFT, CSRF);
  assert.equal(big.kind, 'ok');
  const line = (extra: Record<string, unknown>) => [{ position: 1, description: 'Screen repair', quantity: 1, unitPriceCents: 2550, lineTotalCents: 2550, ...extra }];
  const bad: unknown[] = [
    detailBody({ id: uuid(0xd42) }), detailBody({ storeId: uuid(0x5a2) }), detailBody({ status: 'issued' }), detailBody({ currency: 'USD ' }),
    detailBody({ version: 0 }), detailBody({ createdAt: '2026-10-04T12:00:01Z' }), detailBody({ subtotalCents: 2551 }), detailBody({ extra: 1 }),
    detailBody({}, []), detailBody({ subtotalCents: 2550 }, line({ position: 2 })), detailBody({ subtotalCents: 2550 }, line({ lineTotalCents: 2549 })),
    detailBody({ subtotalCents: 2550 }, line({ description: ' padded' })), detailBody({ subtotalCents: 2550 }, line({ description: `a${cp(0x202e)}b` })),
    detailBody({ subtotalCents: 2550 }, line({ quantity: 0, lineTotalCents: 0 })), detailBody({ subtotalCents: 2550 }, line({ note: 'x' })),
    detailBody({ subtotalCents: 0 }, [{ position: 1, description: 'x', quantity: 3, unitPriceCents: MAX, lineTotalCents: MAX }]),
    { draft: detailBody().draft, more: 1 },
    detailBody({ version: 2 }), detailBody({ version: '1' }), // the server serves version 1 only (a draft is never edited)
  ];
  for (const body of bad) assert.deepEqual(await scripted(json(200, body)).client.getDraft(STORE, DRAFT, CSRF), { kind: 'unavailable' }, JSON.stringify(body).slice(0, 160));
  const zero = detailBody({ subtotalCents: 0 }, [{ position: 1, description: 'x', quantity: 1, unitPriceCents: 0, lineTotalCents: 0 }]);
  assert.equal((await scripted(json(200, zero)).client.getDraft(STORE, DRAFT, CSRF)).kind, 'ok');
  for (const [from, to] of [['"unitPriceCents":0', '"unitPriceCents":-0'], ['"lineTotalCents":0', '"lineTotalCents":-0'], ['"subtotalCents":0', '"subtotalCents":-0']]) {
    assert.deepEqual(await scripted(raw(zero, from, to)).client.getDraft(STORE, DRAFT, CSRF), { kind: 'unavailable' }, to);
  }
  assert.deepEqual(await scripted(refused(404, 'not_found')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'not-found' });
  assert.deepEqual(await scripted(refused(403, 'forbidden')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'denied' });
  assert.deepEqual(await scripted(refused(401, 'unauthenticated')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'signed-out' });
  assert.deepEqual(await scripted(refused(500, 'internal_error')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'unavailable' });
});

const BODY = draftBody(TENANT, CUSTOMER, [{ description: '  Screen repair ', quantity: '1', unitPrice: '20' }, { description: 'Cable', quantity: '2', unitPrice: '2.75' }]);
const created = (extra: Record<string, unknown> = {}) => ({ draft: { id: DRAFT, status: 'draft', currency: 'USD', lineCount: 2, subtotalCents: 2550, ...extra } });

test('IDC-06. the create body is built once in a fixed key order with exact cents, and sent as those exact bytes with the intent, session and key headers', async () => {
  assert.equal(BODY.kind, 'ok');
  if (BODY.kind !== 'ok') return;
  assert.equal(BODY.body, JSON.stringify({
    expectedTenant: TENANT, customerId: CUSTOMER, currency: 'USD',
    lines: [{ description: 'Screen repair', quantity: 1, unitPriceCents: 2000 }, { description: 'Cable', quantity: 2, unitPriceCents: 275 }],
  }));
  assert.deepEqual([BODY.lineCount, BODY.subtotalCents], [2, 2550]);
  const { calls, client } = scripted(json(201, created(), { location: draftPathOf(STORE, DRAFT) }));
  const result = await client.createDraft(STORE, BODY.body, KEY, CSRF);
  assert.deepEqual(result, { kind: 'created', draft: created().draft, replayed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, draftsPathOf(STORE));
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, BODY.body); // the very string: never re-serialized
  const h = headersOf(calls[0]);
  assert.equal(h.get('idempotency-key'), KEY);
  assert.equal(h.get('x-tmpos-csrf'), '1');
  assert.equal(h.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(h.get('content-type'), 'application/json');
  assert.equal(calls[0].init.credentials, 'include');
});

test('IDC-07. created ONLY on an exact 201 whose Location is this draft at this store and whose counts equal what was sent; a replay says so', async () => {
  if (BODY.kind !== 'ok') return assert.fail('body');
  const send = (res: Response) => scripted(res).client.createDraft(STORE, BODY.body, KEY, CSRF);
  const loc = { location: draftPathOf(STORE, DRAFT) };
  assert.deepEqual(await send(json(201, created(), { ...loc, 'idempotent-replayed': 'true' })), { kind: 'created', draft: created().draft, replayed: true });
  const unknown = { kind: 'unknown', responded: true };
  for (const [body, headers] of [
    [created(), { ...loc, 'idempotent-replayed': 'false' }], [created(), { ...loc, 'idempotent-replayed': 'TRUE' }], // the server says only "true"
    [created(), {}], [created(), { location: draftPathOf(uuid(0x5a2), DRAFT) }], [created(), { location: `${draftPathOf(STORE, DRAFT)}/` }],
    [created({ lineCount: 1 }), loc], [created({ subtotalCents: 2551 }), loc], [created({ status: 'issued' }), loc], [created({ extra: 1 }), loc],
    [{ ...created(), more: 1 }, loc], [created({ id: 'd1' }), { location: draftPathOf(STORE, 'd1') }],
  ] as Array<[unknown, Record<string, string>]>) {
    assert.deepEqual(await send(json(201, body, headers)), unknown, JSON.stringify([body, headers]).slice(0, 160));
  }
});

test('IDC-08. every other answer maps to one outcome, told apart by status AND error word; anything undecided is unknown', async () => {
  if (BODY.kind !== 'ok') return assert.fail('body');
  const send = (res: Response | Error) => scripted(res).client.createDraft(STORE, BODY.body, KEY, CSRF);
  const cases: Array<[Response | Error, unknown]> = [
    // Each word only in the shape the server answers it (app.ts refuse: { error, requestId }; a recorded completion: { error }).
    [json(422, { error: 'customer_not_found' }), { kind: 'customer-not-found' }], // sealed: exactly '{"error":"customer_not_found"}'
    [json(422, { error: 'customer_not_found', requestId: 'r' }), { kind: 'unknown', responded: true }], // never the chain's
    [json(422, { error: 'idempotency_key_reused', requestId: 'r' }), { kind: 'key-reused' }],
    [json(422, { error: 'idempotency_key_reused' }), { kind: 'unknown', responded: true }], // never sealed
    [json(409, { error: 'request_in_progress' }), { kind: 'unknown', responded: true }], // never sealed
    [json(409, { error: 'write_conflict' }), { kind: 'conflict' }], // sealed: a create whose new id already exists (transaction_conflict)
    [json(422, { error: 'unprocessable', requestId: 'r' }), { kind: 'unknown', responded: true }],
    [json(422, { error: 'customer_not_found', requestId: 'r', extra: true }), { kind: 'unknown', responded: true }], // only an exact refusal body decides
    [json(422, { error: 'customer_not_found', requestId: 7 }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'write_conflict', detail: 'x' }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'write_conflict', requestId: 'r' }), { kind: 'conflict' }],
    [json(409, { error: 'request_in_progress', requestId: 'r' }), { kind: 'in-progress' }],
    [json(409, { error: 'invalid_state', requestId: 'r' }), { kind: 'unknown', responded: true }],
    // The chain's own refusals (app.ts refuse, sessions.ts): exactly { error, requestId }, one word per status.
    [json(401, { error: 'unauthenticated', requestId: 'r' }), { kind: 'signed-out' }],
    [json(403, { error: 'forbidden', requestId: 'r' }), { kind: 'denied' }],
    [json(400, { error: 'invalid_request', requestId: 'r' }), { kind: 'invalid' }],
    [json(413, { error: 'content_too_large', requestId: 'r' }), { kind: 'invalid' }], // app.ts: a body over 64 KiB
    [json(415, { error: 'unsupported_media_type', requestId: 'r' }), { kind: 'invalid' }],
    [json(429, { error: 'rate_limited', requestId: 'r' }, { 'retry-after': '3' }), { kind: 'rate-limited', retryAfterSeconds: 3 }],
    // The same statuses in a body this server never answers them with decide nothing: a missing requestId (the sealed
    // shape), another word, another key, or no JSON at all.
    ...([
      [401, { error: 'unauthenticated' }], [403, { error: 'forbidden' }], [400, { error: 'invalid_request' }], [413, { error: 'content_too_large' }],
      [415, { error: 'unsupported_media_type' }], [429, { error: 'rate_limited' }], [401, { error: 'forbidden', requestId: 'r' }],
      [403, { error: 'step_up', requestId: 'r' }], [400, { error: 'content_too_large', requestId: 'r' }], [413, { error: 'invalid_request', requestId: 'r' }],
      [415, { error: 'invalid_request', requestId: 'r' }], [429, { error: 'too_many', requestId: 'r' }], [400, { error: 'invalid_request', requestId: 'r', detail: 'x' }],
    ] as Array<[number, unknown]>).map(([status, body]): [Response, unknown] => [json(status, body), { kind: 'unknown', responded: true }]),
    ...[400, 401, 403, 413, 415, 429].map((status): [Response, unknown] => [new Response('<html>', { status, headers: { 'content-type': 'text/html' } }), { kind: 'unknown', responded: true }]),
    [json(404, { error: 'not_found' }), { kind: 'unknown', responded: true }],
    [json(503, { error: 'service_unavailable' }), { kind: 'unknown', responded: true }],
    [json(500, { error: 'internal' }), { kind: 'unknown', responded: true }],
    [json(200, created()), { kind: 'unknown', responded: true }],
    [new Response('<html>', { status: 422, headers: { 'content-type': 'text/html' } }), { kind: 'unknown', responded: true }],
    [new Error('offline'), { kind: 'unknown', responded: false }],
  ];
  for (const [res, expected] of cases) {
    const label = res instanceof Response ? `${res.status} ${res.headers.get('content-type')}` : 'no answer';
    assert.deepEqual(await send(res), expected, `${label} -> ${(expected as { kind: string }).kind}`);
  }
});

test('IDC-09. prices are parsed EXACTLY to cents (BigInt): two decimals at most, no sign, exponent, grouping or leading zero; 2^53-1 cents is the ceiling', () => {
  const ok: Array<[string, bigint]> = [
    ['0', 0n], ['0.5', 50n], ['0.05', 5n], ['0.1', 10n], ['12', 1200n], ['12.3', 1230n], ['12.34', 1234n], [' 7.10 ', 710n],
    ['90071992547409.91', MAX_CENTS], ['90071992547409.9', 9007199254740990n],
  ];
  for (const [raw, cents] of ok) assert.equal(parsePriceCents(raw), cents, raw);
  for (const raw of ['', '.5', '5.', '01', '00', '1.234', '-1', '+1', '1e3', '1,000', '1 000', '$5', '0x10', 'NaN', 'Infinity', '90071992547409.92', '9'.repeat(40), `1${cp(0x0660)}`]) {
    assert.equal(parsePriceCents(raw), null, raw);
  }
  // Floats would say 0.1 + 0.2 = 0.30000000000000004: three lines of 0.10 are exactly 30 cents.
  const three = draftBody(TENANT, CUSTOMER, [{ description: 'a', quantity: '3', unitPrice: '0.1' }]);
  assert.equal(three.kind === 'ok' && three.subtotalCents, 30);
});

test('IDC-10. quantities are whole numbers from 1 to 2^53-1; formatting is digit arithmetic', () => {
  for (const [raw, value] of [['1', 1n], ['007', 7n], [' 2 ', 2n], ['9007199254740991', MAX_CENTS]] as Array<[string, bigint]>) assert.equal(parseQuantity(raw), value, raw);
  for (const raw of ['', '0', '00', '-1', '1.0', '1.5', '1e2', '9007199254740992', 'two']) assert.equal(parseQuantity(raw), null, raw);
  assert.deepEqual([0, 5, 99, 100, 123456, 100000000].map((c) => formatCents(c)), ['$0.00', '$0.05', '$0.99', '$1.00', '$1,234.56', '$1,000,000.00']);
  assert.equal(formatCents(MAX), '$90,071,992,547,409.91');
  assert.equal(formatCents(MAX_CENTS), '$90,071,992,547,409.91');
});

test('IDC-11. the size checks come BEFORE any body exists: a line or a sum over 2^53-1 cents, no line or more than 50, an invalid field — all refused, each said', () => {
  const line = (unitPrice: string, quantity = '1', description = 'x') => ({ description, quantity, unitPrice });
  const atMax = draftBody(TENANT, CUSTOMER, [line('90071992547409.91')]);
  assert.equal(atMax.kind === 'ok' && atMax.subtotalCents, MAX);
  const lineOver = draftBody(TENANT, CUSTOMER, [line('45035996273704.96', '2')]);
  assert.deepEqual(lineOver, { kind: 'invalid', lines: [{ description: false, quantity: false, unitPrice: false, total: true }], subtotal: false, count: false, tooLarge: false });
  const sumOver = draftBody(TENANT, CUSTOMER, [line('90071992547409.91'), line('0.01')]);
  assert.equal(sumOver.kind === 'invalid' && sumOver.subtotal, true);
  assert.deepEqual(sumOver.kind === 'invalid' && sumOver.lines, [
    { description: false, quantity: false, unitPrice: false, total: false }, { description: false, quantity: false, unitPrice: false, total: false },
  ]);
  assert.equal(draftBody(TENANT, CUSTOMER, Array.from({ length: 50 }, () => line('1'))).kind, 'ok');
  const tooMany = draftBody(TENANT, CUSTOMER, Array.from({ length: 51 }, () => line('1')));
  assert.equal(tooMany.kind === 'invalid' && tooMany.count, true);
  assert.equal(draftBody(TENANT, CUSTOMER, []).kind, 'invalid');
  const fields = draftBody(TENANT, CUSTOMER, [line('1.999', '0', '  ')]);
  assert.deepEqual(fields.kind === 'invalid' && fields.lines, [{ description: true, quantity: true, unitPrice: true, total: false }]);
  assert.equal(draftBody('tenant-1', CUSTOMER, [line('1')]).kind, 'invalid');
  assert.equal(draftBody(TENANT, 'c1', [line('1')]).kind, 'invalid');
});

test('IDC-12. a description is the customer name rule at 256 scalars: trimmed, a visible scalar, no control, line/paragraph separator, Bidi_Control or lone surrogate', () => {
  const astral = cp(0x1f600);
  assert.equal(normalizeDraftDescription(astral.repeat(256)), astral.repeat(256));
  assert.equal(normalizeDraftDescription(astral.repeat(257)), null);
  assert.equal(normalizeDraftDescription('  Screen  '), 'Screen');
  for (const raw of ['', '   ', `a${unit(0)}b`, `a${cp(0x85)}b`, `a${cp(0x2028)}b`, `a${cp(0x200e)}b`, `a${cp(0x2066)}b`, `a${unit(0xdc00)}b`, cp(0x200b), 7, null]) {
    assert.equal(normalizeDraftDescription(raw), null, JSON.stringify(raw));
  }
  // The same rule as a customer name wherever both limits allow it.
  for (const raw of ['Ada', ' Ada ', `x${cp(0x202e)}`, cp(0x2800), `${cp(0x301)}`, 'a'.repeat(200), 'a'.repeat(201)]) {
    const name = normalizeCustomerName(raw);
    if (name !== null) assert.equal(normalizeDraftDescription(raw), name);
    else if ([...raw.trim()].length <= 200) assert.equal(normalizeDraftDescription(raw), null);
  }
});

test('IDC-13. createdAt: exactly UTC with six fractional digits, naming a real instant', () => {
  assert.equal(isDraftCreatedAt(at(1, 999999)), true);
  assert.equal(isDraftCreatedAt('2024-02-29T23:59:59.000001Z'), true);
  for (const value of ['2026-10-04T12:00:01.123Z', '2026-10-04T12:00:01.1234567Z', '2026-10-04T12:00:01.123456+00:00', '2026-13-01T00:00:00.000000Z', '2025-02-29T00:00:00.000000Z', 1, null]) {
    assert.equal(isDraftCreatedAt(value), false, String(value));
  }
});

test('IDC-14. a body is measured in exact UTF-8 bytes against the server\'s 64 KiB before any key exists; 50 lines of 256 four-byte scalars still fit', () => {
  // The largest body the rules admit: 50 lines of 256 astral scalars (4 UTF-8 bytes each; JSON.stringify escapes none of
  // them) and the widest amounts (quantity 2^53-1 at a price of 0, so the subtotal stays 0).
  const astral = cp(0x1f4f1);
  const widest = draftBody(TENANT, CUSTOMER, Array.from({ length: 50 }, () => ({ description: astral.repeat(256), quantity: String(MAX), unitPrice: '0' })));
  assert.equal(widest.kind, 'ok');
  if (widest.kind !== 'ok') return;
  assert.equal(widest.lineCount, 50);
  assert.equal(Buffer.byteLength(widest.body, 'utf8'), 54_636); // what fetch sends: every valid draft is below the bound
  assert.equal(new TextEncoder().encode(widest.body).length, 54_636);
  assert.equal(isDraftBodyTooLarge(widest.body), false);
  // Mixed 2-, 3- and 4-byte scalars and the characters JSON escapes (2 bytes each) stay well inside too.
  const mixed = draftBody(TENANT, CUSTOMER, Array.from({ length: 50 }, (_, i) => ({ description: `${cp(0xe9)}${cp(0x20ac)}${astral}"\\`.repeat(51) + String(i % 10), quantity: '1', unitPrice: '0.01' })));
  assert.equal(mixed.kind === 'ok' && isDraftBodyTooLarge(mixed.body), false);
  // The bound itself, in bytes (app.ts: more than 64 KiB is the 413): exactly 65,536 passes, one byte more does not —
  // whatever the UTF-16 length says.
  assert.equal(DRAFT_BODY_MAX_BYTES, 65_536);
  for (const [scalar, bytes] of [[cp(0xe9), 2], [cp(0x20ac), 3], [astral, 4], ['x', 1]] as Array<[string, number]>) {
    const exact = scalar.repeat(Math.floor(DRAFT_BODY_MAX_BYTES / bytes)) + 'x'.repeat(DRAFT_BODY_MAX_BYTES % bytes);
    assert.equal(Buffer.byteLength(exact, 'utf8'), DRAFT_BODY_MAX_BYTES);
    assert.equal(isDraftBodyTooLarge(exact), false, `${bytes}-byte scalars at the bound`);
    assert.equal(isDraftBodyTooLarge(`${exact}x`), true, `${bytes}-byte scalars one byte over`);
  }
  assert.equal(isDraftBodyTooLarge(cp(0x20ac).repeat(21_846)), true); // 21,846 UTF-16 units, 65,538 bytes
});

test('IDC-15. a create sends nothing for a body the server\'s planner would refuse (invoiceDraftsHttp IDH-06): every key, id, currency, line, description and amount rule, and 64 KiB', async () => {
  if (BODY.kind !== 'ok') return assert.fail('body');
  const parsed = JSON.parse(BODY.body) as { expectedTenant: string; customerId: string; currency: string; lines: unknown[] };
  const { calls, client } = scripted();
  const only = parsed.lines[0] as Record<string, unknown>;
  const withLine = (extra: Record<string, unknown>): string => JSON.stringify({ ...parsed, lines: [{ ...only, ...extra }] });
  const noPrice = { description: only.description, quantity: only.quantity };
  for (const body of [
    '{"lines":[]}', JSON.stringify({ ...parsed, lines: [] }), JSON.stringify({ ...parsed, lines: Array.from({ length: 51 }, () => only) }),
    JSON.stringify({ ...parsed, extra: 1 }), JSON.stringify({ customerId: parsed.customerId, currency: 'USD', lines: parsed.lines }), 'not json', '',
    JSON.stringify({ ...parsed, lines: [{ ...only, description: 'x'.repeat(DRAFT_BODY_MAX_BYTES) }] }),
    JSON.stringify([parsed]), JSON.stringify({ ...parsed, lines: [null] }), JSON.stringify({ ...parsed, lines: {} }),
    JSON.stringify({ ...parsed, expectedTenant: TENANT.toUpperCase() }), JSON.stringify({ ...parsed, customerId: 'c1' }), JSON.stringify({ ...parsed, currency: 'EUR' }),
    withLine({ lineTotalCents: 2000 }), JSON.stringify({ ...parsed, lines: [noPrice] }), // a line key too many, one too few
    withLine({ description: '  ' }), withLine({ description: 'x'.repeat(257) }), withLine({ description: `a${unit(7)}b` }),
    withLine({ description: `a${cp(0x202e)}b` }), withLine({ description: `a${unit(0xd800)}b` }), withLine({ description: 7 }),
    withLine({ quantity: 0 }), withLine({ quantity: 1.5 }), withLine({ quantity: '1' }), withLine({ unitPriceCents: -1 }), withLine({ unitPriceCents: '1.00' }),
    withLine({ unitPriceCents: MAX + 1 }), withLine({ quantity: 2, unitPriceCents: Math.ceil(MAX / 2) }), // a line over 2^53-1 cents
    JSON.stringify({ ...parsed, lines: [{ ...only, quantity: 1, unitPriceCents: MAX }, { ...only, quantity: 1, unitPriceCents: 1 }] }), // the sum over it
    withLine({ unitPriceCents: 0 }).replace('"unitPriceCents":0', '"unitPriceCents":-0'), // -0, which JSON.stringify never writes
  ]) assert.deepEqual(await client.createDraft(STORE, body, KEY, CSRF), { kind: 'invalid' }, body.slice(0, 80));
  assert.deepEqual(calls, []);
  // What the server takes is sent as given, untrimmed edges included (it trims; the planner's own rule): no over-refusal.
  const untrimmed = withLine({ description: '  Screen repair  ' });
  const sent = scripted(json(201, created({ lineCount: 1, subtotalCents: 2000 }), { location: draftPathOf(STORE, DRAFT) }));
  assert.equal((await sent.client.createDraft(STORE, untrimmed, KEY, CSRF)).kind, 'created');
  assert.equal(sent.calls[0].init.body, untrimmed);
});

test('IDC-16. a read refusal decides only in the server\'s exact { error, requestId } with its status\'s word: any other body (HTML, no requestId, a sealed { error }, another word, an extra key) is unavailable', async () => {
  const html = (status: number): Response => new Response('<html>denied</html>', { status, headers: { 'content-type': 'text/html' } });
  // Every status the reads decide on, each in the shapes the server never answers it with.
  const offShape = (status: number, word: string): Response[] => [
    html(status), json(status, { error: word }), json(status, { error: word, requestId: 7 }), json(status, { error: word, requestId: 'r', extra: true }),
    json(status, { error: `${word}x`, requestId: 'r' }), json(status, { requestId: 'r' }), json(status, []),
    new Response(JSON.stringify({ error: word, requestId: 'r' }), { status, headers: { 'content-type': 'text/plain' } }),
  ];
  const words: Array<[number, string]> = [[401, 'unauthenticated'], [403, 'forbidden'], [429, 'rate_limited']];
  for (const [status, word] of words) {
    for (const res of offShape(status, word)) assert.deepEqual(await scripted(res).client.listStores(CSRF), { kind: 'unavailable' }, `stores ${status}`);
    for (const res of offShape(status, word)) assert.deepEqual(await scripted(res).client.listDrafts(STORE, null, CSRF), { kind: 'unavailable' }, `list ${status}`);
    for (const res of offShape(status, word)) assert.deepEqual(await scripted(res).client.getDraft(STORE, DRAFT, CSRF), { kind: 'unavailable' }, `get ${status}`);
  }
  // One status's word under another status decides nothing either (a 401 saying forbidden, a 403 saying unauthenticated).
  assert.deepEqual(await scripted(refused(401, 'forbidden')).client.listStores(CSRF), { kind: 'unavailable' });
  assert.deepEqual(await scripted(refused(403, 'unauthenticated')).client.listDrafts(STORE, null, CSRF), { kind: 'unavailable' });
  assert.deepEqual(await scripted(refused(403, 'step_up_required')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'unavailable' });
  // A cursor's 400 and a draft's 404, likewise: only the exact envelope with invalid_request / not_found.
  for (const res of offShape(400, 'invalid_request')) assert.deepEqual(await scripted(res).client.listDrafts(STORE, CURSOR, CSRF), { kind: 'unavailable' }, 'cursor 400');
  assert.deepEqual(await scripted(refused(400, 'not_found')).client.listDrafts(STORE, CURSOR, CSRF), { kind: 'unavailable' });
  for (const res of offShape(404, 'not_found')) assert.deepEqual(await scripted(res).client.getDraft(STORE, DRAFT, CSRF), { kind: 'unavailable' }, 'get 404');
  assert.deepEqual(await scripted(refused(404, 'forbidden')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'unavailable' });
  // And the exact envelopes still decide.
  assert.deepEqual(await scripted(refused(400, 'invalid_request')).client.listDrafts(STORE, CURSOR, CSRF), { kind: 'bad-cursor' });
  assert.deepEqual(await scripted(refused(404, 'not_found')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'not-found' });
  assert.deepEqual(await scripted(refused(429, 'rate_limited')).client.getDraft(STORE, DRAFT, CSRF), { kind: 'rate-limited', retryAfterSeconds: 60 });
});
