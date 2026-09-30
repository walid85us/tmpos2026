// Phase 4.0 M7A-CUSTOMERS-P1 — the tenant customer directory through the runtime: the query and cursor contract, the
// validation of the port's untrusted answer, the route's registration, the handler's every outcome, and the enforced
// chain over real loopback sockets on the TENANT boundary — session, the authorizer's trusted scope, the bounded page.
//
// Synthetic principals, sessions and ports only. The directory port here is an in-memory stand-in; the real PostgreSQL
// adapter is proved database-free in server/persistence/postgresCustomerDirectory.test.ts, and the canonical decision
// of view_customers in server/platform-identity/m5CanonicalPermissions.test.ts and tenantAuthorization.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import type { RouteContext } from './routes.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import { decodeTenantCursor, encodeTenantCursor } from './tenantDirectory.js';
import {
  CUSTOMER_DETAIL_PATH, CUSTOMER_DIRECTORY_DEFAULT_LIMIT, CUSTOMER_DIRECTORY_MAX_LIMIT, CUSTOMER_DIRECTORY_PATH, CUSTOMER_NAME_MAX_CHARACTERS,
  createCustomerDetailRoute, createCustomerDirectoryRoute, customerDetailOf, customerDirectoryPageOf, decodeCustomerCursor, encodeCustomerCursor,
  inCustomerPageOrder, parseCustomerDirectoryQuery,
} from './customerDirectory.js';
import type { CustomerDetailPort, CustomerDirectoryPort, CustomerDirectoryQuery } from './customerDirectory.js';

const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const MEMBERSHIP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const T1 = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const STORE = '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f';
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: T1, store: null, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});
const GRANTED = Object.freeze({ granted: true, context: SCOPE });
/** A synthetic session store key, in the shape the chain computes one (sessions.ts digestOf). */
const SESSION_KEY = 'k'.repeat(43);

/** Synthetic customer ids in page order: canonical v4 UUIDs, distinct, generated from an index. */
const idOf = (i: number): string => `${(0x10000000 + i).toString(16)}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const customer = (i: number, over: Record<string, unknown> = {}) => ({ id: idOf(i), name: `Customer ${i}`, ...over });

// --- 1. the query and the cursor ------------------------------------------------------------------------------------------

test('the cursor is 23 base64url characters naming one customer, accepted only in its one canonical spelling', () => {
  const c = encodeCustomerCursor(T1);
  assert.match(c, /^[A-Za-z0-9_-]{23}$/);
  assert.equal(decodeCustomerCursor(c), T1, 'round trip');
  for (let i = 0; i < 40; i++) assert.equal(decodeCustomerCursor(encodeCustomerCursor(idOf(i))), idOf(i));
  for (let i = 0; i < 20; i++) { const id = randomUUID(); assert.equal(decodeCustomerCursor(encodeCustomerCursor(id)), id, id); }
  assert.equal(Buffer.from(c, 'base64url')[0], 0x02, 'the customer directory\'s own tag byte');
  // The last character carries 4 bits and 2 unused ones: any other spelling of the same bytes is refused.
  const last = c.at(-1) as string;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const flip of [1, 2, 3]) {
    const sibling = c.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ flip];
    assert.deepEqual(Buffer.from(sibling, 'base64url'), Buffer.from(c, 'base64url'), 'the same bytes (control)');
    assert.equal(decodeCustomerCursor(sibling), null, `a non-canonical spelling (low bits ^${flip})`);
  }
  for (const [label, bad] of [
    ['empty', ''], ['too short', c.slice(1)], ['too long', `${c}A`], ['padding', `${c}=`], ['a plus', `${c.slice(0, -1)}+`],
    ['a slash', `${c.slice(0, -1)}/`], ['a space', `${c.slice(0, -1)} `], ['a percent', `${c.slice(0, -1)}%`], ['a dot', `${c.slice(0, -1)}.`],
    ['24 characters of 18 bytes', Buffer.concat([Buffer.from([2]), Buffer.from(T1.replace(/-/g, ''), 'hex'), Buffer.from([0])]).toString('base64url')],
    ['16 bytes without a tag', Buffer.from(T1.replace(/-/g, ''), 'hex').toString('base64url')],
  ] as const) assert.equal(decodeCustomerCursor(bad), null, label);
  // Another tag byte — the tenant directory's continuation for the same id — is not this route's cursor, either way round.
  const tenantCursor = encodeTenantCursor(T1);
  assert.equal(decodeTenantCursor(tenantCursor), T1, 'a valid tenant-directory cursor (control)');
  assert.equal(decodeCustomerCursor(tenantCursor), null, 'a tenant-directory cursor is not a customer cursor');
  assert.equal(decodeTenantCursor(c), null, 'nor is a customer cursor a tenant-directory one');
  for (const tag of [0, 1, 3, 0x82, 0xff]) {
    const bytes = Buffer.from(c, 'base64url');
    bytes[0] = tag;
    assert.equal(decodeCustomerCursor(bytes.toString('base64url')), null, `tag ${tag}`);
  }
  // Migration 017's column holds ANY uuid, so every 16 bytes are a customer id: no version or variant is required, and a
  // continuation naming such an id round-trips rather than stranding the page after it.
  for (const id of ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '12345678-9abc-0def-7123-456789abcdef']) {
    assert.equal(decodeCustomerCursor(encodeCustomerCursor(id)), id, `a non-RFC-4122 uuid round-trips: ${id}`);
  }
});

test('the query takes limit and cursor at most once each, and refuses everything else before any port is asked', () => {
  const c = encodeCustomerCursor(T1);
  const P = CUSTOMER_DIRECTORY_PATH;
  assert.equal(CUSTOMER_DIRECTORY_DEFAULT_LIMIT, 50);
  assert.equal(CUSTOMER_DIRECTORY_MAX_LIMIT, 100);
  assert.deepEqual(parseCustomerDirectoryQuery(P), { after: null, limit: 50 });
  assert.ok(Object.isFrozen(parseCustomerDirectoryQuery(P)));
  assert.deepEqual(parseCustomerDirectoryQuery(`${P}?limit=1`), { after: null, limit: 1 });
  assert.deepEqual(parseCustomerDirectoryQuery(`${P}?limit=100`), { after: null, limit: 100 });
  assert.deepEqual(parseCustomerDirectoryQuery(`${P}?limit=99`), { after: null, limit: 99 });
  assert.deepEqual(parseCustomerDirectoryQuery(`${P}?cursor=${c}`), { after: T1, limit: 50 });
  assert.deepEqual(parseCustomerDirectoryQuery(`${P}?cursor=${c}&limit=7`), { after: T1, limit: 7 });
  assert.deepEqual(parseCustomerDirectoryQuery(`${P}?limit=7&cursor=${c}`), { after: T1, limit: 7 });
  for (const q of [
    '?', '?&', '?limit=', '?limit=0', '?limit=101', '?limit=999', '?limit=1000', '?limit=01', '?limit=-1', '?limit=1.0', '?limit=1.5',
    '?limit=abc', '?limit=1e1', '?limit=+1', '?limit=%31', '?limit=%35%30', '?limit', '?cursor', '?LIMIT=1', '?Limit=1',
    '?limit=1&limit=2', '?limit=5&limit=5', `?cursor=${c}&cursor=${c}`, `?limit=5&cursor=${c}&limit=5`, '?cursor=', '?cursor=abc',
    `?cursor=${c}x`, `?cursor=${encodeTenantCursor(T1)}`, '?limit=5&', '?&limit=5', '?limit=5&&cursor=x', `?tenantId=${T1}`,
    `?limit=1&tenantId=${T1}`, '?scope=tenant', '?role=store_owner', '?email=a', '?limit=1;cursor=x', '?limit=1#x', '?limit=1?limit=2',
    '?limit=1 ', '?%6cimit=1', `?limit=1&x=${'a'.repeat(200)}`, `?${'limit=1&'.repeat(20)}`, `?limit=1&${'a'.repeat(128)}`,
  ]) assert.equal(parseCustomerDirectoryQuery(`${P}${q}`), null, q);
  // The bound is on the query alone: 129 characters are refused before any pair is read.
  assert.equal(parseCustomerDirectoryQuery(`${P}?${'x'.repeat(129)}`), null, 'an overlong query');
});

// --- 2. the port's answer is untrusted ------------------------------------------------------------------------------------

const Q = (over: Partial<CustomerDirectoryQuery> = {}): CustomerDirectoryQuery => ({ after: null, limit: 3, ...over });

test('only an exactly shaped answer becomes a page: every field is checked and copied, and anything else is null', () => {
  const page = customerDirectoryPageOf({ outcome: 'page', customers: [customer(1), customer(2)], hasMore: false }, Q());
  assert.deepEqual(page, { customers: [customer(1), customer(2)], hasMore: false });
  assert.ok(page !== null && typeof page === 'object' && Object.isFrozen(page) && Object.isFrozen(page.customers) && Object.isFrozen(page.customers[0]));
  assert.deepEqual(customerDirectoryPageOf({ outcome: 'page', customers: [customer(1), customer(2), customer(3)], hasMore: true }, Q()),
    { customers: [customer(1), customer(2), customer(3)], hasMore: true });
  assert.deepEqual(customerDirectoryPageOf({ outcome: 'page', customers: [], hasMore: false }, Q()), { customers: [], hasMore: false });
  assert.deepEqual(customerDirectoryPageOf({ outcome: 'page', customers: [customer(2)], hasMore: false }, Q({ after: idOf(1) })),
    { customers: [customer(2)], hasMore: false }, 'a page after a cursor, not naming it');
  assert.equal(customerDirectoryPageOf({ outcome: 'denied' }, Q()), 'denied');
  assert.equal(customerDirectoryPageOf({ outcome: 'cursor_unknown' }, Q({ after: T1 })), 'cursor_unknown');
  const name = (n: number) => 'x'.repeat(n);
  // An array whose length reads `shown` for the first two reads and its true length after: the bound checked must be the
  // bound the copy runs to.
  const growing = (entries: unknown[], shown: number) => {
    let reads = 0;
    return new Proxy(entries, { get: (target, key, receiver) => (key === 'length' && reads++ < 2 ? shown : Reflect.get(target, key, receiver)) });
  };
  const cases: Array<[string, unknown, CustomerDirectoryQuery?]> = [
    ['null', null], ['undefined', undefined], ['an array', []], ['a string', 'page'], ['a Map', new Map()],
    ['a class instance', new (class P { outcome = 'page'; customers = []; hasMore = false; })()],
    ['an object with another prototype', Object.create({ outcome: 'page', customers: [], hasMore: false })],
    ['no outcome', { customers: [], hasMore: false }], ['an unknown outcome', { outcome: 'ok', customers: [], hasMore: false }],
    ['a capitalised outcome', { outcome: 'Page', customers: [], hasMore: false }],
    ['a denial with a payload', { outcome: 'denied', customers: [] }], ['a denial with a reason', { outcome: 'denied', reason: 'x' }],
    ['cursor_unknown with a payload', { outcome: 'cursor_unknown', customers: [] }, Q({ after: T1 })],
    ['cursor_unknown without a cursor', { outcome: 'cursor_unknown' }],
    ['an extra page key', { outcome: 'page', customers: [], hasMore: false, total: 9 }], ['no hasMore', { outcome: 'page', customers: [] }],
    ['hasMore as a string', { outcome: 'page', customers: [], hasMore: 'false' }], ['customers as an object', { outcome: 'page', customers: {}, hasMore: false }],
    ['more customers than the limit', { outcome: 'page', customers: [customer(1), customer(2), customer(3), customer(4)], hasMore: false }],
    ['more customers than the limit, with hasMore', { outcome: 'page', customers: [customer(1), customer(2), customer(3), customer(4)], hasMore: true }],
    ['hasMore behind a short page', { outcome: 'page', customers: [customer(1)], hasMore: true }],
    ['hasMore behind an empty page', { outcome: 'page', customers: [], hasMore: true }],
    ['a repeated customer', { outcome: 'page', customers: [customer(1), customer(1)], hasMore: false }],
    ['a repeated customer under another name', { outcome: 'page', customers: [customer(1), customer(1, { name: 'Other' })], hasMore: false }],
    ['the cursor\'s own customer', { outcome: 'page', customers: [customer(1)], hasMore: false }, Q({ after: idOf(1) })],
    ['an email on an entry', { outcome: 'page', customers: [{ ...customer(1), email: 'a@b.test' }], hasMore: false }],
    ['a phone on an entry', { outcome: 'page', customers: [{ ...customer(1), phone: '555' }], hasMore: false }],
    ['a tenant on an entry', { outcome: 'page', customers: [{ ...customer(1), tenantId: T1 }], hasMore: false }],
    ['a missing name', { outcome: 'page', customers: [{ id: idOf(1) }], hasMore: false }],
    ['a missing id', { outcome: 'page', customers: [{ name: 'x' }], hasMore: false }],
    ['an uppercase id', { outcome: 'page', customers: [customer(10, { id: idOf(10).toUpperCase() })], hasMore: false }],
    ['a non-UUID id', { outcome: 'page', customers: [customer(1, { id: 'customer-1' })], hasMore: false }],
    ['a non-hex id', { outcome: 'page', customers: [customer(1, { id: 'gggggggg-0000-4000-8000-000000000001' })], hasMore: false }],
    ['an id with braces', { outcome: 'page', customers: [customer(1, { id: `{${idOf(1)}}` })], hasMore: false }],
    ['an id without hyphens', { outcome: 'page', customers: [customer(1, { id: idOf(1).replace(/-/g, '') })], hasMore: false }],
    ['a numeric id', { outcome: 'page', customers: [customer(1, { id: 1 })], hasMore: false }],
    ['a numeric name', { outcome: 'page', customers: [customer(1, { name: 7 })], hasMore: false }],
    ['a null name', { outcome: 'page', customers: [customer(1, { name: null })], hasMore: false }],
    ['an empty name', { outcome: 'page', customers: [customer(1, { name: '' })], hasMore: false }],
    ['201 BMP characters', { outcome: 'page', customers: [customer(1, { name: name(CUSTOMER_NAME_MAX_CHARACTERS + 1) })], hasMore: false }],
    ['300 ASCII characters (accepted under the old 400-unit bound)', { outcome: 'page', customers: [customer(1, { name: name(300) })], hasMore: false }],
    ['401 UTF-16 units', { outcome: 'page', customers: [customer(1, { name: name(401) })], hasMore: false }],
    ['201 astral characters (402 units)', { outcome: 'page', customers: [customer(1, { name: '\u{1F600}'.repeat(201) })], hasMore: false }],
    ['200 BMP and 1 astral character (201 characters, 202 units)', { outcome: 'page', customers: [customer(1, { name: `${name(200)}\u{1F600}` })], hasMore: false }],
    ['a lone high surrogate', { outcome: 'page', customers: [customer(1, { name: 'A\uD83D' })], hasMore: false }],
    ['a lone low surrogate', { outcome: 'page', customers: [customer(1, { name: '\uDE00B' })], hasMore: false }],
    ['a reversed surrogate pair', { outcome: 'page', customers: [customer(1, { name: '\uDE00\uD83D' })], hasMore: false }],
    ['an entry as an array', { outcome: 'page', customers: [[idOf(1), 'x']], hasMore: false }],
    ['an entry as a class instance', { outcome: 'page', customers: [new (class E { id = idOf(1); name = 'x'; })()], hasMore: false }],
    ['a null entry', { outcome: 'page', customers: [null], hasMore: false }],
    ['a throwing getter', { outcome: 'page', get customers() { throw new Error('secret'); }, hasMore: false }],
    ['a throwing entry getter', { outcome: 'page', customers: [{ id: idOf(1), get name() { throw new Error('secret'); } }], hasMore: false }],
    ['a throwing proxy', new Proxy({}, { ownKeys() { throw new Error('secret'); }, getPrototypeOf() { return Object.prototype; } })],
    ['a proxy whose prototype trap throws', new Proxy({}, { getPrototypeOf() { throw new Error('secret'); } })],
  ];
  for (const [label, raw, query] of cases) {
    let answer: unknown;
    assert.doesNotThrow(() => { answer = customerDirectoryPageOf(raw, query ?? Q()); }, label);
    assert.equal(answer, null, label);
  }
  const grown = customerDirectoryPageOf({ outcome: 'page', customers: growing([customer(1), customer(2), customer(3), customer(4), customer(5)], 3), hasMore: true }, Q());
  assert.ok(grown !== null && typeof grown === 'object');
  assert.deepEqual(grown.customers.map((c) => c.id), [idOf(1), idOf(2), idOf(3)], 'a length that grows after the check never carries more than the limit');
  // The bound is migration 017's: 200 characters (code points), whatever their width.
  assert.equal(CUSTOMER_NAME_MAX_CHARACTERS, 200);
  for (const [label, n] of [['200 BMP characters', 'é'.repeat(200)], ['200 ASCII characters', name(200)], ['200 astral characters (400 units)', '\u{1F600}'.repeat(200)],
    ['a valid surrogate pair', 'A\u{1F600}B'], ['one character', 'x'], ['199 ASCII and 1 astral character (200 characters, 201 units)', `${name(199)}\u{1F600}`]] as const) {
    assert.deepEqual(customerDirectoryPageOf({ outcome: 'page', customers: [customer(1, { name: n })], hasMore: false }, Q()),
      { customers: [customer(1, { name: n })], hasMore: false }, `${label}: shown as stored`);
  }
  // Any uuid the column can hold is a customer id, in PostgreSQL's lowercase text form: no version or variant required.
  // (Equal names, so the ids are in ascending order, as the routine answers them.)
  const nonRfc = ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
  assert.deepEqual(customerDirectoryPageOf({ outcome: 'page', customers: nonRfc.map((id) => ({ id, name: 'N' })), hasMore: true }, Q()),
    { customers: nonRfc.map((id) => ({ id, name: 'N' })), hasMore: true }, 'non-RFC-4122 ids are accepted');
  assert.equal(customerDirectoryPageOf({ outcome: 'page', customers: [{ id: nonRfc[2].toUpperCase(), name: 'N' }], hasMore: false }, Q()), null,
    'but only in lowercase');
});

test('a page is in the routine\'s order — name as UTF-8 bytes, then id — strictly increasing, or it is null', () => {
  const Q5 = Q({ limit: 5 });
  const page = (entries: Array<[number, string]>) =>
    customerDirectoryPageOf({ outcome: 'page', customers: entries.map(([i, name]) => ({ id: idOf(i), name })), hasMore: false }, Q5);
  const ok = (entries: Array<[number, string]>, label: string) =>
    assert.deepEqual(page(entries), { customers: entries.map(([i, name]) => ({ id: idOf(i), name })), hasMore: false }, label);
  ok([[7, 'Only']], 'a single entry');
  ok([[1, 'Ann'], [2, 'Bob'], [3, 'Cy']], 'ascending names');
  ok([[1, 'Same'], [2, 'Same'], [3, 'Same']], 'equal names, ids ascending');
  ok([[9, 'Ann'], [1, 'Bob']], 'the name decides before the id');
  assert.equal(page([[2, 'Bob'], [1, 'Ann']]), null, 'out-of-order names');
  assert.equal(page([[1, 'Ann'], [3, 'Cy'], [2, 'Bob']]), null, 'one entry out of order in the middle');
  assert.equal(page([[2, 'Same'], [1, 'Same']]), null, 'equal names, ids descending');
  // Byte order, not locale order: uppercase ASCII sorts before lowercase, and a multi-byte character after all of ASCII.
  ok([[1, 'Zed'], [2, 'alice']], "'Zed' before 'alice'");
  assert.equal(page([[1, 'alice'], [2, 'Zed']]), null, "'alice' before 'Zed' is locale order, not the routine's");
  ok([[1, 'zoe'], [2, 'Émile']], "'zoe' before 'Émile' (0xC3 > 0x7A)");
  assert.equal(page([[1, 'Émile'], [2, 'zoe']]), null, "'Émile' before 'zoe' is not byte order");
  // UTF-8 bytes, not UTF-16 units: U+FF5E (EF BD 9E) sorts before U+1F600 (F0 9F 98 80), though its UTF-16 unit is larger.
  ok([[1, '～'], [2, '\u{1F600}']], 'UTF-8 byte order over UTF-16 unit order');
  assert.equal(page([[1, '\u{1F600}'], [2, '～']]), null, 'UTF-16 unit order is refused');
  ok([[1, 'Ann'], [2, 'Anna']], 'a prefix sorts first');
  assert.equal(page([[1, 'Anna'], [2, 'Ann']]), null, 'a prefix after its extension');
});

test('inCustomerPageOrder: strictly increasing by name bytes, then id', () => {
  const e = (i: number, name: string) => ({ id: idOf(i), name });
  assert.equal(inCustomerPageOrder([]), true, 'empty');
  assert.equal(inCustomerPageOrder([e(1, 'x')]), true, 'single');
  assert.equal(inCustomerPageOrder([e(1, 'Ann'), e(2, 'Bob')]), true, 'ascending names');
  assert.equal(inCustomerPageOrder([e(2, 'Bob'), e(1, 'Ann')]), false, 'descending names');
  assert.equal(inCustomerPageOrder([e(1, 'Same'), e(2, 'Same')]), true, 'equal names, ids ascending');
  assert.equal(inCustomerPageOrder([e(2, 'Same'), e(1, 'Same')]), false, 'equal names, ids descending');
  assert.equal(inCustomerPageOrder([e(1, 'Same'), e(1, 'Same')]), false, 'equal name and equal id');
  assert.equal(inCustomerPageOrder([e(9, 'Ann'), e(1, 'Bob')]), true, 'the name decides before the id');
  assert.equal(inCustomerPageOrder([e(1, 'Zed'), e(2, 'alice')]), true, "'Zed' before 'alice'");
  assert.equal(inCustomerPageOrder([e(1, 'alice'), e(2, 'Zed')]), false, 'locale order is not byte order');
  assert.equal(inCustomerPageOrder([e(1, 'zoe'), e(2, 'Émile')]), true, "'zoe' before 'Émile' (0xC3 > 0x7A)");
  assert.equal(inCustomerPageOrder([e(1, 'Émile'), e(2, 'zoe')]), false, "'Émile' before 'zoe'");
  assert.equal(inCustomerPageOrder([e(1, '～'), e(2, '\u{1F600}')]), true, 'UTF-8 byte order (EF.. < F0..)');
  assert.equal(inCustomerPageOrder([e(1, '\u{1F600}'), e(2, '～')]), false, 'UTF-16 unit order is not it');
  assert.equal(inCustomerPageOrder([e(1, 'Ann'), e(2, 'Anna')]), true, 'a prefix first');
  assert.equal(inCustomerPageOrder([e(1, 'Ann'), e(3, 'Cy'), e(2, 'Bob')]), false, 'only the last pair out of order');
});

test('the route is a GET under the tenant boundary, view_customers at tenant scope, a resolved scope and the session binding required, no body and no key', () => {
  const route = createCustomerDirectoryRoute({ customers: { page: () => ({ outcome: 'page', customers: [], hasMore: false }) } });
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/v1/customers');
  assert.equal(CUSTOMER_DIRECTORY_PATH, '/api/v1/customers');
  assert.deepEqual(route.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'view_customers' } });
  assert.deepEqual([route.body, route.idempotency, route.trustedContext, route.recentAuth], [{ kind: 'none' }, 'none', 'required', 'none']);
  assert.ok(route.idempotency === 'none' && typeof route.handler === 'function');
  assert.equal(route.sessionBinding, 'required', 'the handler is handed the presenting session\'s store key (M7A-CUSTOMERS-P2)');
  assert.deepEqual(Object.keys(route).sort(), ['body', 'handler', 'idempotency', 'method', 'path', 'policy', 'recentAuth', 'sessionBinding', 'trustedContext']);
  assert.ok(Object.isFrozen(route) && Object.isFrozen(route.policy) && Object.isFrozen(route.body));
  assert.ok(route.policy.access === 'session' && Object.isFrozen(route.policy.authorization));
  assert.equal(defineRoutes([route]).list().length, 1, 'the runtime\'s own route table accepts it');
  for (const ports of [undefined, null, {}, { customers: null }, { customers: {} }, { customers: { page: 'yes' } }, { tenantDirectory: { page: () => null } }]) {
    assert.throws(() => createCustomerDirectoryRoute(ports as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid', JSON.stringify(ports));
  }
  for (const deadlineMs of [0, -1, 1.5, 3_001, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
    assert.throws(() => createCustomerDirectoryRoute({ customers: { page: () => null } }, { deadlineMs: deadlineMs as never }),
      (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid', String(deadlineMs));
  }
  for (const deadlineMs of [1, 3_000]) assert.ok(createCustomerDirectoryRoute({ customers: { page: () => null } }, { deadlineMs }), `${deadlineMs} (control)`);
});

// --- 3. the handler, called directly ---------------------------------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }

/** Run the route's handler once over a minimal request, response and context, recording what the port was handed. */
async function run(opts: { url?: unknown; trusted?: unknown; sessionKey?: unknown; answer?: (query: CustomerDirectoryQuery, signal: AbortSignal) => unknown; deadlineMs?: number } = {}) {
  const calls: Array<{ scope: TrustedScope; sessionKey: string; query: CustomerDirectoryQuery; signal: AbortSignal }> = [];
  const port: CustomerDirectoryPort = {
    page(scope, sessionKey, query, signal) {
      calls.push({ scope, sessionKey, query, signal });
      return (opts.answer ?? (() => ({ outcome: 'page', customers: [customer(1)], hasMore: false })))(query, signal);
    },
  };
  const route = createCustomerDirectoryRoute({ customers: port }, opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs });
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = {
    locals: out.locals,
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  };
  const ctx = {
    requestId: 'req-7', principal: null, session: null, authenticatedAt: null, body: undefined,
    trusted: 'trusted' in opts ? opts.trusted : SCOPE,
    sessionKey: 'sessionKey' in opts ? opts.sessionKey : SESSION_KEY,
  } as unknown as RouteContext;
  assert.ok(route.idempotency === 'none', 'a handler route');
  await route.handler({ url: 'url' in opts ? opts.url : CUSTOMER_DIRECTORY_PATH } as unknown as Request, res as unknown as Response, ctx);
  return { out, calls, ctx };
}

function assertHandlerRefusal(out: Captured, status: number, error: string, reason: string, label: string): void {
  assert.equal(out.status, status, label);
  assert.deepEqual(out.body, { error, requestId: 'req-7' }, `${label}: exactly the error word and the request id`);
  assert.equal(out.locals.refusal, reason, `${label}: the bounded reason, for the request log alone`);
}

test('a malformed query is a 400 decided before the port is asked', async () => {
  for (const url of [`${CUSTOMER_DIRECTORY_PATH}?limit=0`, `${CUSTOMER_DIRECTORY_PATH}?limit=abc`, `${CUSTOMER_DIRECTORY_PATH}?cursor=x`,
    `${CUSTOMER_DIRECTORY_PATH}?limit=5&limit=5`, `${CUSTOMER_DIRECTORY_PATH}?`, `${CUSTOMER_DIRECTORY_PATH}?tenantId=${T1}`,
    `${CUSTOMER_DIRECTORY_PATH}?cursor=${encodeTenantCursor(T1)}`]) {
    const { out, calls } = await run({ url });
    assertHandlerRefusal(out, 400, 'invalid_request', 'customer_directory_query_invalid', url);
    assert.equal(calls.length, 0, `${url}: the port was never asked`);
  }
  // No target at all reads as the bare path: the default page, never a refusal of its own.
  const { out, calls } = await run({ url: undefined });
  assert.equal(out.status, 200);
  assert.deepEqual(calls[0].query, { after: null, limit: 50 });
});

test('without a resolved TENANT scope naming a tenant the handler refuses 403 and never asks the port', async () => {
  const cases: Array<[string, unknown]> = [
    ['no trusted scope', null],
    ['a platform scope', { ...SCOPE, scope: 'platform', tenant: null, roleId: 'system_owner' }],
    ['a store scope', { ...SCOPE, scope: 'store', store: STORE }],
    ['a tenant scope with no tenant', { ...SCOPE, tenant: null }],
  ];
  for (const [label, trusted] of cases) {
    const { out, calls } = await run({ trusted });
    assertHandlerRefusal(out, 403, 'forbidden', 'authz_context_missing', label);
    assert.equal(calls.length, 0, `${label}: the port was never asked`);
  }
});

test('without the presenting session\'s store key the handler refuses 403 and never asks the port', async () => {
  const { out, calls } = await run({ sessionKey: null });
  assertHandlerRefusal(out, 403, 'forbidden', 'authz_context_missing', 'no session key');
  assert.equal(calls.length, 0, 'the port was never asked');
});

test('the port is handed exactly the trusted scope, the session key and the parsed query, and a 200 carries exactly customers and nextCursor', async () => {
  const c = encodeCustomerCursor(idOf(9));
  const { out, calls, ctx } = await run({
    url: `${CUSTOMER_DIRECTORY_PATH}?limit=2&cursor=${c}`,
    answer: () => ({ outcome: 'page', customers: [customer(10), customer(11)], hasMore: true }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, ctx.trusted, 'the very scope object the chain resolved, not a copy the request shaped');
  assert.equal(calls[0].sessionKey, SESSION_KEY, 'the chain\'s key, unchanged');
  assert.deepEqual(calls[0].query, { after: idOf(9), limit: 2 });
  assert.ok(calls[0].signal instanceof AbortSignal && !calls[0].signal.aborted, 'a live deadline signal');
  assert.equal(out.status, 200);
  assert.equal(out.locals.refusal, undefined, 'a page is no refusal');
  const body = out.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['customers', 'nextCursor']);
  assert.deepEqual(body.customers, [{ id: idOf(10), name: 'Customer 10' }, { id: idOf(11), name: 'Customer 11' }]);
  for (const entry of body.customers as object[]) assert.deepEqual(Object.keys(entry), ['id', 'name']);
  assert.equal(body.nextCursor, encodeCustomerCursor(idOf(11)), 'the continuation names the last customer of this page');
  assert.equal(decodeCustomerCursor(body.nextCursor as string), idOf(11));
  // A last page (hasMore false) carries no continuation, full or short, and an empty directory is an empty page.
  for (const [label, answer, url] of [
    ['a full last page', { outcome: 'page', customers: [customer(1), customer(2)], hasMore: false }, `${CUSTOMER_DIRECTORY_PATH}?limit=2`],
    ['a short last page', { outcome: 'page', customers: [customer(1)], hasMore: false }, `${CUSTOMER_DIRECTORY_PATH}?limit=2`],
    ['an empty directory', { outcome: 'page', customers: [], hasMore: false }, CUSTOMER_DIRECTORY_PATH],
  ] as const) {
    const r = await run({ url, answer: () => answer });
    assert.equal(r.out.status, 200, label);
    assert.deepEqual(r.out.body, { customers: answer.customers, nextCursor: null }, label);
  }
  // A page ending on a non-RFC-4122 id continues from it: its cursor decodes back to that id.
  const odd = '00000000-0000-0000-0000-000000000001';
  const r = await run({ url: `${CUSTOMER_DIRECTORY_PATH}?limit=1`, answer: () => ({ outcome: 'page', customers: [{ id: odd, name: 'Z' }], hasMore: true }) });
  assert.equal(r.out.status, 200);
  assert.equal(decodeCustomerCursor((r.out.body as { nextCursor: string }).nextCursor), odd);
});

test('the port\'s refusals and faults are bounded: denied is the generic 403, an unknown cursor a 400, and a throw, an overrun or an out-of-shape answer a 503', async () => {
  const c = `${CUSTOMER_DIRECTORY_PATH}?cursor=${encodeCustomerCursor(T1)}`;
  const cases: Array<[string, (q: CustomerDirectoryQuery, s: AbortSignal) => unknown, number, string, string, string?]> = [
    ['denied', () => ({ outcome: 'denied' }), 403, 'forbidden', 'customer_directory_denied'],
    ['an unknown cursor', () => ({ outcome: 'cursor_unknown' }), 400, 'invalid_request', 'customer_directory_cursor_unknown', c],
    ['cursor_unknown with no cursor sent', () => ({ outcome: 'cursor_unknown' }), 503, 'service_unavailable', 'customer_directory_answer_invalid'],
    ['a throw', () => { throw new Error('connection to db-secret.internal refused'); }, 503, 'service_unavailable', 'customer_directory_unavailable'],
    ['a rejection', () => Promise.reject(new Error('password authentication failed for user secret')), 503, 'service_unavailable', 'customer_directory_unavailable'],
    ['an overrun', (_q, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ outcome: 'page', customers: [], hasMore: false })); }),
      503, 'service_unavailable', 'customer_directory_timeout'],
    ['an email passed through', () => ({ outcome: 'page', customers: [{ ...customer(1), email: 'secret@x.test' }], hasMore: false }), 503, 'service_unavailable', 'customer_directory_answer_invalid'],
    ['contact and money fields', () => ({ outcome: 'page', customers: [{ ...customer(1), phone: '555', totalSpent: 12 }], hasMore: false }), 503, 'service_unavailable', 'customer_directory_answer_invalid'],
    ['an answer of the wrong kind', () => 'SELECT * FROM customer', 503, 'service_unavailable', 'customer_directory_answer_invalid'],
    ['no answer', () => undefined, 503, 'service_unavailable', 'customer_directory_answer_invalid'],
    ['more than the limit', () => ({ outcome: 'page', customers: Array.from({ length: 51 }, (_, i) => customer(i + 1)), hasMore: true }), 503, 'service_unavailable', 'customer_directory_answer_invalid'],
  ];
  for (const [label, answer, status, error, reason, url] of cases) {
    // Wide enough that an immediate answer never loses to the deadline on a loaded host; only the overrun waits it out.
    const { out, calls } = await run({ answer, deadlineMs: 1_000, ...(url === undefined ? {} : { url }) });
    assert.equal(calls.length, 1, `${label}: asked once`);
    assertHandlerRefusal(out, status, error, reason, label);
    assert.ok(!/secret|SELECT|password|customer_directory/.test(JSON.stringify(out.body)), `${label}: nothing about the port crosses the boundary`);
  }
});

// --- 4. the whole chain over loopback sockets, on the tenant boundary ------------------------------------------------------

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string | string[]>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end();
  });
}

function tenantBoundary(authorizations: unknown[][], authorize: (...args: unknown[]) => unknown): SessionBoundaryDeps {
  return {
    trustedOrigins: [TENANT_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-customers', authenticatedAt: Date.now(), secondFactor: null }
          : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
    authorizer: { authorize: (...args: unknown[]) => { authorizations.push(args); return authorize(...args); } },
    store: countingIdleRefreshes(createMemorySessionStore()),
  };
}

/** Idle-window refreshes (an `update` carrying `lastSeenAt`) the chain asked of the session store, across this file's chains. */
let idleRefreshes = 0;
function countingIdleRefreshes<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'update' || typeof value !== 'function') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return (...args: unknown[]) => {
        if ((args[1] as { lastSeenAt?: unknown } | undefined)?.lastSeenAt !== undefined) idleRefreshes += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

async function withChain(
  setup: { answer?: (query: CustomerDirectoryQuery) => unknown; authorize?: (...args: unknown[]) => unknown },
  fn: (h: {
    calls: Array<{ scope: TrustedScope; sessionKey: string; query: CustomerDirectoryQuery }>; authorizations: unknown[][]; logs: string[];
    probes: Array<string | null>; storeKey: string; csrf: string; get: (target?: string, headers?: Record<string, string>) => Promise<Reply>;
    raw: (target?: string, headers?: Record<string, string | string[]>) => Promise<Reply>; anon: (target?: string) => Promise<Reply>;
  }) => Promise<void>,
): Promise<void> {
  const calls: Array<{ scope: TrustedScope; sessionKey: string; query: CustomerDirectoryQuery }> = [];
  const authorizations: unknown[][] = [];
  const logs: string[] = [];
  // ctx.sessionKey as a tenant session route that declares no binding sees it.
  const probes: Array<string | null> = [];
  const port: CustomerDirectoryPort = {
    page(scope, sessionKey, query) {
      calls.push({ scope, sessionKey, query });
      return (setup.answer ?? (() => ({ outcome: 'page', customers: [customer(1)], hasMore: false })))(query);
    },
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(line); } },
    sessions: { tenant: tenantBoundary(authorizations, setup.authorize ?? (() => GRANTED)) },
    routes: [createCustomerDirectoryRoute({ customers: port }), {
      method: 'GET', path: '/api/v1/unbound-probe', policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'view_customers' } },
      body: { kind: 'none' }, idempotency: 'none', trustedContext: 'required', recentAuth: 'none',
      handler: (_req, res, ctx) => { probes.push(ctx.sessionKey); res.status(204).end(); },
    }],
    limits: testRequestLimits(),
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = (server.address() as AddressInfo).port;
    const login = await request(p, 'POST', sessionPaths('tenant').login, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
    });
    assert.equal(login.status, 200, `tenant login: ${login.body}`);
    const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const id = pair.slice(pair.indexOf('=') + 1);
    const cookie = `${SESSION_COOKIES.tenant}=${id}`;
    authorizations.length = 0;
    // The store key the chain derives from the identifier, computed here independently (sessions.ts digestOf).
    const storeKey = createHash('sha256').update(id).digest('base64url');
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    await fn({
      calls, authorizations, logs, probes, storeKey, csrf,
      // A customer read names the session it checked (M7A-CUSTOMERS-P5-R1): `get` sends the presenting session's own token; `raw` sends nothing it is not told.
      get: (target = CUSTOMER_DIRECTORY_PATH, headers = {}) => request(p, 'GET', target, { cookie, [SESSION_CSRF_HEADER]: csrf, ...headers }),
      raw: (target = CUSTOMER_DIRECTORY_PATH, headers = {}) => request(p, 'GET', target, { cookie, ...headers }),
      anon: (target = CUSTOMER_DIRECTORY_PATH) => request(p, 'GET', target, {}),
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

test('over the enforced chain: the authorizer is asked for view_customers at tenant scope, and only its trusted scope reaches the port', async () => {
  await withChain({ answer: () => ({ outcome: 'page', customers: [customer(1), customer(2)], hasMore: true }) }, async (h) => {
    const r = await h.get(`${CUSTOMER_DIRECTORY_PATH}?limit=2`, { 'x-tenant-id': '44444444-4444-4444-8444-444444444444', 'x-role': 'store_owner' });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers['cache-control'], 'no-store', 'never cached');
    assert.deepEqual(JSON.parse(r.body), { customers: [customer(1), customer(2)], nextCursor: encodeCustomerCursor(idOf(2)) });
    assert.equal(h.authorizations.length, 1);
    assert.deepEqual(h.authorizations[0][1], { scope: 'tenant', permission: 'view_customers' }, 'the declared requirement, never one the request names');
    assert.deepEqual(h.calls, [{ scope: SCOPE, sessionKey: h.storeKey, query: { after: null, limit: 2 } }],
      'the authorizer\'s scope, unchanged by any header, and the presenting session\'s store key');
    for (const word of [ACTOR, MEMBERSHIP, T1, 'manager', 'sv-1', 'tenant']) assert.ok(!r.body.includes(word), `the page carries no ${word}`);
    // A malformed query is a 400 before the port; a scope-less grant and a denial are refused by the chain itself.
    const bad = await h.get(`${CUSTOMER_DIRECTORY_PATH}?limit=101`);
    assert.equal(bad.status, 400, bad.body);
    assert.equal(h.calls.length, 1, 'the malformed query never reached the port');
    // A tenant session route declaring no binding is handed no key, whatever it declares otherwise.
    const probe = await h.get('/api/v1/unbound-probe');
    assert.equal(probe.status, 204, probe.body);
    assert.deepEqual(h.probes, [null], 'ctx.sessionKey is null on a route that does not declare sessionBinding');
    // The key reaches the port and nothing else: no request log line carries it, the cookie's identifier or the cursor.
    assert.ok(h.logs.length > 0, 'the chain logged its requests (control)');
    for (const line of h.logs) {
      assert.ok(!line.includes(h.storeKey), 'no log line carries the session key');
      assert.ok(!line.includes(encodeCustomerCursor(idOf(2))), 'nor the continuation');
    }
  });
  for (const [label, authorize] of [['a denial', () => false], ['a bare true: no scope resolved', () => true]] as const) {
    await withChain({ authorize }, async (h) => {
      const r = await h.get();
      assert.equal(r.status, 403, `${label}: ${r.body}`);
      assert.equal(h.calls.length, 0, `${label}: the port was never asked`);
    });
  }
});

// --- 5. the customer detail read, GET /api/v1/customers/{id} (M7A-CUSTOMERS-P4) --------------------------------------------

const CID = idOf(42);
/** Segments the template reaches but the handler refuses after authentication: anything but one canonical lowercase uuid. */
const MALFORMED_IDS: readonly string[] = [
  CID.toUpperCase(), CID.replace(/-/g, '%2d'), CID.replace('-', '%2D'), '{id}', 'x', '..', CID.slice(1), `${CID}0`, CID.replace(/-/g, ''),
  'a'.repeat(128), `%7B${CID}%7D`,
];

test('the detail route is a GET of the one template, the list\'s permission, trusted context and session binding, no body and no key', () => {
  const route = createCustomerDetailRoute({ customerDetail: { get: () => ({ outcome: 'not_found' }) } });
  assert.equal(CUSTOMER_DETAIL_PATH, '/api/v1/customers/{id}');
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/v1/customers/{id}');
  assert.deepEqual(route.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'view_customers' } });
  assert.deepEqual([route.body, route.idempotency, route.trustedContext, route.recentAuth, route.sessionBinding], [{ kind: 'none' }, 'none', 'required', 'none', 'required']);
  assert.deepEqual(Object.keys(route).sort(), ['body', 'handler', 'idempotency', 'method', 'path', 'policy', 'recentAuth', 'sessionBinding', 'trustedContext']);
  assert.ok(Object.isFrozen(route) && Object.isFrozen(route.policy) && Object.isFrozen(route.body));
  const list = createCustomerDirectoryRoute({ customers: { page: () => null } });
  assert.equal(defineRoutes([list, route]).list().length, 2, 'the runtime\'s own table accepts it beside the list');
  for (const ports of [undefined, null, {}, { customerDetail: null }, { customerDetail: {} }, { customerDetail: { get: 'yes' } }, { customers: { page: () => null } }]) {
    assert.throws(() => createCustomerDetailRoute(ports as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid', JSON.stringify(ports));
  }
  for (const deadlineMs of [0, -1, 1.5, 3_001, Number.NaN, '100']) {
    assert.throws(() => createCustomerDetailRoute({ customerDetail: { get: () => null } }, { deadlineMs: deadlineMs as never }),
      (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid', String(deadlineMs));
  }
  for (const deadlineMs of [1, 3_000]) assert.ok(createCustomerDetailRoute({ customerDetail: { get: () => null } }, { deadlineMs }), `${deadlineMs} (control)`);
});

test('customerDetailOf: only an exactly shaped answer for the id asked is a customer; refusals carry nothing; anything else is null', () => {
  assert.deepEqual(customerDetailOf({ outcome: 'customer', id: CID, name: 'Ada' }, CID), { id: CID, name: 'Ada' });
  assert.ok(Object.isFrozen(customerDetailOf({ outcome: 'customer', id: CID, name: 'Ada' }, CID)));
  assert.equal(customerDetailOf({ outcome: 'not_found' }, CID), 'not_found');
  assert.equal(customerDetailOf({ outcome: 'denied' }, CID), 'denied');
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
  for (const [label, raw] of [
    ['another id', { outcome: 'customer', id: idOf(43), name: 'Ada' }],
    ['an uppercase id', { outcome: 'customer', id: CID.toUpperCase(), name: 'Ada' }],
    ['an extra key', { outcome: 'customer', id: CID, name: 'Ada', email: 'a@x.test' }],
    ['a tenant beside it', { outcome: 'customer', id: CID, name: 'Ada', tenant: T1 }],
    ['no name', { outcome: 'customer', id: CID }],
    ['an empty name', { outcome: 'customer', id: CID, name: '' }],
    ['a 201-character name', { outcome: 'customer', id: CID, name: 'x'.repeat(CUSTOMER_NAME_MAX_CHARACTERS + 1) }],
    ['a lone surrogate', { outcome: 'customer', id: CID, name: 'a\ud800' }],
    ['not_found with a field', { outcome: 'not_found', id: CID }],
    ['denied with a field', { outcome: 'denied', name: 'x' }],
    ['a page', { outcome: 'page', customers: [], hasMore: false }],
    ['invalid', { outcome: 'invalid' }],
    ['an array', [{ outcome: 'customer', id: CID, name: 'Ada' }]],
    ['a class instance', Object.assign(new (class X {})(), { outcome: 'not_found' })],
    ['a string', 'not_found'], ['null', null], ['undefined', undefined], ['a hostile proxy', hostile],
  ] as const) {
    assert.equal(customerDetailOf(raw, CID), null, label);
  }
});

/** Run the detail handler once over a minimal request, response and context, recording what the port was handed. */
async function runDetail(opts: { path?: string; url?: unknown; trusted?: unknown; sessionKey?: unknown; answer?: (id: string, signal: AbortSignal) => unknown; deadlineMs?: number } = {}) {
  const calls: Array<{ scope: TrustedScope; sessionKey: string; id: string; signal: AbortSignal }> = [];
  const port: CustomerDetailPort = {
    get(scope, sessionKey, id, signal) {
      calls.push({ scope, sessionKey, id, signal });
      return (opts.answer ?? ((asked) => ({ outcome: 'customer', id: asked, name: 'Customer 42' })))(id, signal);
    },
  };
  const route = createCustomerDetailRoute({ customerDetail: port }, opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs });
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = {
    locals: out.locals,
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  };
  const ctx = {
    requestId: 'req-7', principal: null, session: null, authenticatedAt: null, body: undefined,
    trusted: 'trusted' in opts ? opts.trusted : SCOPE,
    sessionKey: 'sessionKey' in opts ? opts.sessionKey : SESSION_KEY,
  } as unknown as RouteContext;
  assert.ok(route.idempotency === 'none', 'a handler route');
  const path = opts.path ?? `${CUSTOMER_DIRECTORY_PATH}/${CID}`;
  await route.handler({ path, url: 'url' in opts ? opts.url : path } as unknown as Request, res as unknown as Response, ctx);
  return { out, calls, ctx };
}

test('detail handler: any query — a bare ? included — and any non-canonical id are 400 invalid_request before the port is asked', async () => {
  for (const url of [`${CUSTOMER_DIRECTORY_PATH}/${CID}?`, `${CUSTOMER_DIRECTORY_PATH}/${CID}?x=1`, `${CUSTOMER_DIRECTORY_PATH}/${CID}?tenantId=${T1}`]) {
    const { out, calls } = await runDetail({ url });
    assertHandlerRefusal(out, 400, 'invalid_request', 'customer_detail_query_invalid', url);
    assert.equal(calls.length, 0, `${url}: the port was never asked`);
  }
  for (const segment of MALFORMED_IDS) {
    const { out, calls } = await runDetail({ path: `${CUSTOMER_DIRECTORY_PATH}/${segment}` });
    assertHandlerRefusal(out, 400, 'invalid_request', 'customer_detail_id_invalid', segment);
    assert.equal(calls.length, 0, `${segment}: the port was never asked`);
  }
});

test('detail handler: without a resolved tenant scope or the session key it refuses 403 and never asks the port', async () => {
  for (const [label, opts] of [
    ['no trusted scope', { trusted: null }],
    ['a platform scope', { trusted: { ...SCOPE, scope: 'platform', tenant: null, roleId: 'system_owner' } }],
    ['a store scope', { trusted: { ...SCOPE, scope: 'store', store: STORE } }],
    ['a tenant scope with no tenant', { trusted: { ...SCOPE, tenant: null } }],
    ['no session key', { sessionKey: null }],
  ] as const) {
    const { out, calls } = await runDetail(opts);
    assertHandlerRefusal(out, 403, 'forbidden', 'authz_context_missing', label);
    assert.equal(calls.length, 0, `${label}: the port was never asked`);
  }
});

test('detail handler: a canonical id makes exactly one port call with (scope, key, id), and 200 carries exactly {customer:{id,name}}', async () => {
  for (const id of [CID, '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-8fff-bfff-ffffffffffff']) {
    const { out, calls, ctx } = await runDetail({ path: `${CUSTOMER_DIRECTORY_PATH}/${id}` });
    assert.equal(calls.length, 1, id);
    assert.equal(calls[0].scope, ctx.trusted, 'the very scope the chain resolved');
    assert.equal(calls[0].sessionKey, SESSION_KEY);
    assert.equal(calls[0].id, id);
    assert.ok(calls[0].signal instanceof AbortSignal && !calls[0].signal.aborted);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { customer: { id, name: 'Customer 42' } });
    assert.deepEqual(Object.keys(out.body as object), ['customer']);
    assert.deepEqual(Object.keys((out.body as { customer: object }).customer), ['id', 'name']);
    assert.equal(out.locals.refusal, undefined);
  }
});

test('detail handler: denied is the list\'s 403, not_found one bounded 404, and a throw, an overrun or an out-of-shape answer a 503', async () => {
  const cases: Array<[string, (id: string, s: AbortSignal) => unknown, number, string, string]> = [
    ['denied', () => ({ outcome: 'denied' }), 403, 'forbidden', 'customer_detail_denied'],
    ['not_found', () => ({ outcome: 'not_found' }), 404, 'not_found', 'customer_not_found'],
    ['a throw', () => { throw new Error('connection to db-secret.internal refused'); }, 503, 'service_unavailable', 'customer_detail_unavailable'],
    ['a rejection', () => Promise.reject(new Error('password authentication failed for user secret')), 503, 'service_unavailable', 'customer_detail_unavailable'],
    ['an overrun', (_id, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ outcome: 'not_found' })); }),
      503, 'service_unavailable', 'customer_detail_timeout'],
    ['another id', () => ({ outcome: 'customer', id: idOf(43), name: 'secret other' }), 503, 'service_unavailable', 'customer_detail_answer_invalid'],
    ['an extra key', (id) => ({ outcome: 'customer', id, name: 'Ada', email: 'secret@x.test' }), 503, 'service_unavailable', 'customer_detail_answer_invalid'],
    ['a 201-character name', (id) => ({ outcome: 'customer', id, name: 'x'.repeat(201) }), 503, 'service_unavailable', 'customer_detail_answer_invalid'],
    ['no answer', () => undefined, 503, 'service_unavailable', 'customer_detail_answer_invalid'],
    ['invalid', () => ({ outcome: 'invalid' }), 503, 'service_unavailable', 'customer_detail_answer_invalid'],
  ];
  for (const [label, answer, status, error, reason] of cases) {
    const { out, calls } = await runDetail({ answer, deadlineMs: 1_000 });
    assert.equal(calls.length, 1, `${label}: asked once`);
    assertHandlerRefusal(out, status, error, reason, label);
    assert.ok(!/secret|password|customer_detail/.test(JSON.stringify(out.body)), `${label}: nothing about the port crosses the boundary`);
  }
});

async function withDetailChain(
  answer: (id: string) => unknown,
  fn: (h: { calls: Array<{ scope: TrustedScope; sessionKey: string; id: string }>; authorizations: unknown[][]; logs: string[]; storeKey: string; csrf: string;
    raw: (target: string, headers?: Record<string, string | string[]>) => Promise<Reply>;
    get: (target: string, headers?: Record<string, string>, method?: string) => Promise<Reply>; anon: (target: string, method?: string) => Promise<Reply> }) => Promise<void>,
): Promise<void> {
  const calls: Array<{ scope: TrustedScope; sessionKey: string; id: string }> = [];
  const authorizations: unknown[][] = [];
  const logs: string[] = [];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(line); } },
    sessions: { tenant: tenantBoundary(authorizations, () => GRANTED) },
    routes: [
      createCustomerDirectoryRoute({ customers: { page: () => ({ outcome: 'page', customers: [], hasMore: false }) } }),
      createCustomerDetailRoute({ customerDetail: { get: (scope, sessionKey, id) => { calls.push({ scope, sessionKey, id }); return answer(id); } } }),
    ],
    limits: testRequestLimits(),
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = (server.address() as AddressInfo).port;
    const login = await request(p, 'POST', sessionPaths('tenant').login, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
    });
    assert.equal(login.status, 200, `tenant login: ${login.body}`);
    const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const sid = pair.slice(pair.indexOf('=') + 1);
    const cookie = `${SESSION_COOKIES.tenant}=${sid}`;
    authorizations.length = 0;
    const storeKey = createHash('sha256').update(sid).digest('base64url');
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    await fn({
      calls, authorizations, logs, storeKey, csrf,
      get: (target, headers = {}, method = 'GET') => request(p, method, target, { cookie, [SESSION_CSRF_HEADER]: csrf, ...headers }),
      raw: (target, headers = {}) => request(p, 'GET', target, { cookie, ...headers }),
      anon: (target, method = 'GET') => request(p, method, target, {}),
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

test('detail over the enforced chain: 401 before any id is judged; after authorization a malformed id is 400 and a canonical one reaches the port once', async () => {
  const FOREIGN = idOf(77);
  const names = new Map([[CID, 'Grace Hopper']]);
  await withDetailChain((id) => (names.has(id) ? { outcome: 'customer', id, name: names.get(id) } : { outcome: 'not_found' }), async (h) => {
    // No session: the chain's 401 for every segment the template reaches, well-formed or not — no id-shape oracle.
    for (const segment of [CID, ...MALFORMED_IDS]) {
      const r = await h.anon(`${CUSTOMER_DIRECTORY_PATH}/${segment}`);
      assert.equal(r.status, 401, `${segment}: ${r.body}`);
    }
    assert.equal(h.calls.length, 0, 'no unauthenticated request reached the port');
    assert.equal(h.authorizations.length, 0, 'nor the authorizer');
    // Own customer: 200, the authorizer asked for view_customers on the TEMPLATE's view, never the id.
    const own = await h.get(`${CUSTOMER_DIRECTORY_PATH}/${CID}`, { 'x-tenant-id': '44444444-4444-4444-8444-444444444444' });
    assert.equal(own.status, 200, own.body);
    assert.equal(own.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(own.body), { customer: { id: CID, name: 'Grace Hopper' } });
    assert.equal(h.authorizations.length, 1);
    assert.deepEqual(h.authorizations[0][1], { scope: 'tenant', permission: 'view_customers' });
    assert.deepEqual(h.authorizations[0][2], { method: 'GET', path: '/api/v1/customers/{id}', audience: 'tenant' }, 'the template path, never the id');
    assert.deepEqual(h.calls, [{ scope: SCOPE, sessionKey: h.storeKey, id: CID }]);
    // Malformed ids after authorization: the list's 400, the port never asked.
    for (const segment of MALFORMED_IDS) {
      const r = await h.get(`${CUSTOMER_DIRECTORY_PATH}/${segment}`);
      assert.equal(r.status, 400, `${segment}: ${r.body}`);
      assert.deepEqual(Object.keys(JSON.parse(r.body)), ['error', 'requestId']);
      assert.equal(JSON.parse(r.body).error, 'invalid_request');
    }
    const query = await h.get(`${CUSTOMER_DIRECTORY_PATH}/${CID}?`);
    assert.equal(query.status, 400, 'a bare query');
    assert.equal(h.calls.length, 1, 'no malformed request reached the port');
    // A foreign id and a missing id: one status, one body shape, one header set, one log reason.
    const foreign = await h.get(`${CUSTOMER_DIRECTORY_PATH}/${FOREIGN}`);
    const missing = await h.get(`${CUSTOMER_DIRECTORY_PATH}/${randomUUID()}`);
    for (const r of [foreign, missing]) {
      assert.equal(r.status, 404, r.body);
      const body = JSON.parse(r.body);
      assert.deepEqual(Object.keys(body), ['error', 'requestId']);
      assert.equal(body.error, 'not_found');
    }
    // The ETag is Express's weak hash of the body, which differs only in its request id: its presence is compared, not its value.
    const headersOf = (r: Reply): Record<string, unknown> => Object.fromEntries(Object.entries(r.headers)
      .map(([k, v]) => [k, k === 'etag' ? typeof v : v]).filter(([k]) => k !== 'x-request-id' && k !== 'date'));
    assert.deepEqual(headersOf(foreign), headersOf(missing), 'identical header names and values modulo the request id, date and body hash');
    assert.equal(h.calls.length, 3, 'each canonical id made exactly one port call');
    // The terminal 404 (no route) is the same body shape, before any session: empty, too long, extra and trailing segments, HEAD.
    for (const [target, method] of [
      [`${CUSTOMER_DIRECTORY_PATH}/`, 'GET'], [`${CUSTOMER_DIRECTORY_PATH}/${'a'.repeat(129)}`, 'GET'], [`${CUSTOMER_DIRECTORY_PATH}/${CID}/`, 'GET'],
      [`${CUSTOMER_DIRECTORY_PATH}/${CID}/x`, 'GET'], [`${CUSTOMER_DIRECTORY_PATH}//${CID}`, 'GET'], [`/API/v1/customers/${CID}`, 'GET'],
      [`${CUSTOMER_DIRECTORY_PATH}/${CID}`, 'HEAD'], [`${CUSTOMER_DIRECTORY_PATH}/${CID}`, 'DELETE'],
    ] as const) {
      const r = await h.anon(target, method);
      assert.equal(r.status, 404, `${method} ${target}`);
      if (method !== 'HEAD') assert.deepEqual(Object.keys(JSON.parse(r.body)), ['error', 'requestId']);
    }
    assert.equal(h.calls.length, 3);
    // The request log: the route class 'other' and the one reason for both 404s; never an id, a name or the key.
    const lines = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.event === 'request');
    const notFound = lines.filter((l) => l.status === 404 && l.reason === 'customer_not_found');
    assert.equal(notFound.length, 2, 'the foreign and the missing 404 logged alike');
    for (const l of notFound) assert.equal(l.route, 'other');
    for (const line of h.logs) {
      for (const secret of [CID, FOREIGN, 'Grace Hopper', h.storeKey]) assert.ok(!line.includes(secret), `no log line carries ${secret}`);
    }
  });
});

// --- 6. the read binding (M7A-CUSTOMERS-P5-R1, DA-138): a bound read must name the session it presents -----------------------

const reasonOf = (logs: string[], reply: Reply): unknown => {
  const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'request' && l.requestId === reply.headers['x-request-id']);
  assert.equal(lines.length, 1, 'exactly one request log line');
  return lines[0].reason;
};
const assertForbidden = (r: Reply, label: string): void => {
  assert.equal(r.status, 403, `${label}: ${r.body}`);
  const body = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], label);
  assert.equal(body.error, 'forbidden', label);
  assert.equal(body.requestId, r.headers['x-request-id'], label);
};

test('list and cursor page over the enforced chain: a missing, repeated, malformed or another session\'s CSRF token is a 403 before the authorizer, the port and the idle refresh; 401 still wins; the right token reads', async () => {
  await withChain({}, async (h) => {
    const cursor = encodeCustomerCursor(idOf(0));
    const good = await h.raw(CUSTOMER_DIRECTORY_PATH, { [SESSION_CSRF_HEADER]: h.csrf });
    assert.equal(good.status, 200, good.body);
    assert.equal(h.calls.length, 1);
    const refreshesAfterGood = idleRefreshes;
    assert.ok(refreshesAfterGood > 0, 'control: a successful read slides the idle window');
    const other = createHash('sha256').update('another session').digest('base64url');
    const cases: Array<[string, Record<string, string | string[]>, string]> = [
      ['no header', {}, 'csrf_session_missing'],
      ['two header lines', { [SESSION_CSRF_HEADER]: [h.csrf, h.csrf] }, 'csrf_session_duplicate'],
      ['another session\'s token', { [SESSION_CSRF_HEADER]: other }, 'csrf_session_invalid'],
      ['a malformed token (wrong alphabet)', { [SESSION_CSRF_HEADER]: '*'.repeat(43) }, 'csrf_session_invalid'],
      ['a malformed token (wrong length)', { [SESSION_CSRF_HEADER]: 'abc' }, 'csrf_session_invalid'],
      ['an empty token', { [SESSION_CSRF_HEADER]: '' }, 'csrf_session_invalid'],
    ];
    const authorizedBefore = h.authorizations.length;
    for (const target of [CUSTOMER_DIRECTORY_PATH, `${CUSTOMER_DIRECTORY_PATH}?limit=2`, `${CUSTOMER_DIRECTORY_PATH}?cursor=${cursor}`]) {
      for (const [label, headers, reason] of cases) {
        const r = await h.raw(target, headers);
        assertForbidden(r, `${target} ${label}`);
        assert.equal(reasonOf(h.logs, r), reason, `${target} ${label}`);
        assert.ok(!('customers' in JSON.parse(r.body)), `${label}: no customers`);
      }
    }
    assert.equal(h.authorizations.length, authorizedBefore, 'the authorizer was never asked');
    assert.equal(h.calls.length, 1, 'the port was never asked');
    assert.equal(idleRefreshes, refreshesAfterGood, 'no refusal slid the idle window');
    // 401 wins when there is no cookie at all, whatever the header says.
    const anon = await h.anon();
    assert.equal(anon.status, 401, anon.body);
    // The right token on a cursor page reads as before.
    const page = await h.raw(`${CUSTOMER_DIRECTORY_PATH}?cursor=${cursor}`, { [SESSION_CSRF_HEADER]: h.csrf });
    assert.equal(page.status, 200, page.body);
    assert.equal(h.calls.length, 2);
    // A route that declares no sessionBinding is unaffected by the header's absence (and presence).
    assert.equal((await h.raw('/api/v1/unbound-probe')).status, 204);
    assert.equal((await h.raw(sessionPaths('tenant').current)).status, 200, 'GET /api/v1/session needs no header');
    assert.equal((await h.raw('/api/v1/unbound-probe', { [SESSION_CSRF_HEADER]: other })).status, 204);
  });
});

test('detail over the enforced chain: the same refusals before the authorizer, the port and the idle refresh; 401 wins; a foreign id with the right token is still the 404', async () => {
  await withDetailChain((id) => (id === CID ? { outcome: 'customer', id, name: 'Grace Hopper' } : { outcome: 'not_found' }), async (h) => {
    const target = `${CUSTOMER_DIRECTORY_PATH}/${CID}`;
    const good = await h.raw(target, { [SESSION_CSRF_HEADER]: h.csrf });
    assert.equal(good.status, 200, good.body);
    assert.deepEqual(JSON.parse(good.body), { customer: { id: CID, name: 'Grace Hopper' } });
    const refreshesAfterGood = idleRefreshes;
    const authorizedBefore = h.authorizations.length;
    const other = createHash('sha256').update('another session').digest('base64url');
    for (const [label, headers, reason] of [
      ['no header', {}, 'csrf_session_missing'],
      ['two header lines', { [SESSION_CSRF_HEADER]: [h.csrf, h.csrf] }, 'csrf_session_duplicate'],
      ['another session\'s token', { [SESSION_CSRF_HEADER]: other }, 'csrf_session_invalid'],
      ['a malformed token', { [SESSION_CSRF_HEADER]: '*'.repeat(43) }, 'csrf_session_invalid'],
    ] as Array<[string, Record<string, string | string[]>, string]>) {
      const r = await h.raw(target, headers);
      assertForbidden(r, label);
      assert.equal(reasonOf(h.logs, r), reason, label);
      assert.ok(!('customer' in JSON.parse(r.body)), `${label}: no customer`);
      // Even a malformed id is judged only after the token: the 403 wins over the handler's 400.
      assertForbidden(await h.raw(`${CUSTOMER_DIRECTORY_PATH}/x`, headers), `${label} malformed id`);
    }
    assert.equal(h.authorizations.length, authorizedBefore, 'the authorizer was never asked');
    assert.equal(h.calls.length, 1, 'the port was never asked');
    assert.equal(idleRefreshes, refreshesAfterGood, 'no refusal slid the idle window');
    assert.equal((await h.anon(target)).status, 401, 'no cookie: 401 wins');
    const foreign = await h.raw(`${CUSTOMER_DIRECTORY_PATH}/${idOf(77)}`, { [SESSION_CSRF_HEADER]: h.csrf });
    assert.equal(foreign.status, 404, foreign.body);
    assert.equal(JSON.parse(foreign.body).error, 'not_found');
  });
});
