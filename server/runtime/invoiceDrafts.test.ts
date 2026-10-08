// Phase 4.0 M7B-INVOICES-P1 — store-owned invoice drafts through the runtime: the command contract and its one event as the
// runtime registers them, the planner's closed input and exact BigInt arithmetic, the read routes' cursor, query and strict
// answer validation, each handler's outcomes, and the save over the enforced chain on real loopback sockets — the store
// target bound into the fingerprint, the sealed 201 with its Location, the typed sealed 422 and its replay, the unsealed
// 409 precondition and the store scope the authorizer selects at the path's store — the planner, the fingerprint's target
// and the trusted store one store, a trusted scope at any other store refused before a key is reserved (R4).
//
// Synthetic principals, sessions and ports only (identifiers built at run time). The PostgreSQL side is proved
// database-free in server/persistence/postgresInvoiceDrafts.test.ts and against a real cluster in
// tests/db/invoiceDraftRoutine.integration.test.mjs and tests/db/invoiceDraftsHttp.integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyState, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { createIdempotencyKeyring } from './idempotency.js';
import {
  INVOICE_DRAFTS_PATH, INVOICE_DRAFT_CREATE_CONTRACT, INVOICE_DRAFT_CREATE_REQUIREMENT, INVOICE_DRAFT_CREATE_ROUTE, INVOICE_DRAFT_ELIGIBILITY_PATH, INVOICE_DRAFT_EVENTS,
  INVOICE_DRAFT_PATH, createInvoiceDraftDetailRoute, createInvoiceDraftEligibilityRoute, createInvoiceDraftListRoute, decodeInvoiceDraftCursor, encodeInvoiceDraftCursor, inInvoiceDraftOrder,
  invoiceDraftOf, invoiceDraftPageOf, isDraftCreatedAt, normalizeDraftDescription, parseInvoiceDraftListQuery, planInvoiceDraftCreate,
} from './invoiceDrafts.js';
import type { InvoiceDraftReadPort } from './invoiceDrafts.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import type { RouteContext } from './routes.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const MAX = Number.MAX_SAFE_INTEGER;
const ACTOR = randomUUID();
const TENANT = randomUUID();
const STORE = randomUUID();
const OTHER_STORE = randomUUID();
const CUSTOMER = randomUUID();
const MEMBERSHIP = randomUUID();
const SESSION_KEY = 'k'.repeat(43);
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
const scopeAt = (store: string, over: Partial<TrustedScope> = {}): TrustedScope => Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'store', tenant: TENANT, store, membershipId: MEMBERSHIP, roleId: 'sales_staff', limitation: 'none', ...over,
});
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const unit = (code: number): string => String.fromCharCode(code);
const line = (over: Record<string, unknown> = {}) => ({ description: 'Screen repair', quantity: 2, unitPriceCents: 4_999, ...over });
const body = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, customerId: CUSTOMER, currency: 'USD', lines: [line()], ...over });
/** The planner's context for `b`; a null target is a context carrying none. */
const plan = (b: unknown, targetId: string | null = STORE) =>
  planInvoiceDraftCreate(Object.freeze({ audience: 'tenant' as const, body: b, newAggregateId: randomUUID(), ...(targetId === null ? {} : { targetId }) }));
/** Draft ids in descending order of i (the page's order is newest first, id descending on equal times). */
const D = (i: number): string => `${(0x70000000 - i).toString(16)}-0000-4000-8000-${(1_000_000 - i).toString(16).padStart(12, '0')}`;
const AT = '2026-10-04T12:00:00.123456Z';

// --- 1. the contract, the event and the route as the runtime registers them --------------------------------------------------

test('AC-06 AC-09: the contract registers against its one event — store scope, the typed sealed refusal, the rows field — and the route is the store POST template under a key', () => {
  const events = defineOutboxEvents(INVOICE_DRAFT_EVENTS);
  const commands = defineCommands([INVOICE_DRAFT_CREATE_CONTRACT], events);
  const contract = commands.contract('store.invoice_draft.create');
  assert.ok(contract !== undefined);
  assert.deepEqual([contract.mode, contract.aggregateType, contract.contextScope, contract.sealedRefusal], ['create', 'invoice_draft', 'store', 'customer_not_found']);
  assert.deepEqual(contract.events, [{ type: 'invoice_draft.created', version: 1 }]);
  assert.deepEqual(Object.keys(contract.changes).sort(), ['customerId', 'expectedTenant', 'lines', 'storeId', 'subtotalCents']);
  assert.deepEqual(contract.changes.lines, { type: 'rows', maxRows: 50, fields: {
    description: { type: 'string', maxLength: 512 }, quantity: { type: 'integer', min: 1, max: MAX }, unitPriceCents: { type: 'integer', min: 0, max: MAX },
  } });
  // M7B-INVOICES-P2: the registry also carries the edit's invoice_draft.updated — the same identifiers and count.
  assert.deepEqual(INVOICE_DRAFT_EVENTS.map((e) => [e.type, e.version, e.aggregateType, Object.keys(e.payload)]),
    [['invoice_draft.created', 1, 'invoice_draft', ['storeId', 'customerId', 'lineCount']], ['invoice_draft.updated', 1, 'invoice_draft', ['storeId', 'customerId', 'lineCount']]],
    'identifiers and a count only');
  // An event registry never admits a rows field: the payload of a draft event cannot carry a line.
  assert.throws(() => defineOutboxEvents([{ ...INVOICE_DRAFT_EVENTS[0], payload: { ...INVOICE_DRAFT_EVENTS[0].payload, lines: INVOICE_DRAFT_CREATE_CONTRACT.changes.lines } }]),
    (e: unknown) => e instanceof EnforcementSetupError && e.code === 'outbox_registry_invalid');
  const r = INVOICE_DRAFT_CREATE_ROUTE;
  assert.deepEqual([r.method, r.path, r.idempotency, r.trustedContext, r.recentAuth], ['POST', '/api/v1/stores/{storeId}/invoice-drafts', 'required', 'required', 'none']);
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'create_invoice_drafts' } });
  assert.deepEqual(r.body, { kind: 'json', maxBytes: 65_536, required: true });
  assert.equal(defineRoutes([r]).list().length, 1, 'the runtime\'s own table accepts it');
  for (const route of [createInvoiceDraftListRoute({ invoiceDrafts: { page: () => null, get: () => null } }),
    createInvoiceDraftDetailRoute({ invoiceDrafts: { page: () => null, get: () => null } })]) {
    assert.deepEqual(route.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'view_invoice_drafts' } });
    assert.deepEqual([route.method, route.idempotency, route.trustedContext, route.recentAuth, route.sessionBinding], ['GET', 'none', 'required', 'none', 'required']);
    assert.ok(Object.isFrozen(route));
  }
  assert.deepEqual([INVOICE_DRAFTS_PATH, INVOICE_DRAFT_PATH], ['/api/v1/stores/{storeId}/invoice-drafts', '/api/v1/stores/{storeId}/invoice-drafts/{id}']);
  for (const ports of [undefined, {}, { invoiceDrafts: { page: () => null } }, { invoiceDrafts: { get: () => null } }]) {
    for (const build of [createInvoiceDraftListRoute, createInvoiceDraftDetailRoute]) {
      assert.throws(() => build(ports as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid');
    }
  }
  assert.throws(() => createInvoiceDraftListRoute({ invoiceDrafts: { page: () => null, get: () => null } }, { deadlineMs: 3_001 }),
    (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid');
});

// --- 2. the planner -----------------------------------------------------------------------------------------------------------

test('AC-06: the planner maps a valid body to the store, the values and the lines in order, a BigInt subtotal, one event and the sealed 201 with its Location', () => {
  const id = randomUUID();
  const out = planInvoiceDraftCreate({ audience: 'tenant', newAggregateId: id, targetId: STORE, body: body({ lines: [
    line({ description: '  Glass  ' }), line({ description: 'Labour', quantity: 1, unitPriceCents: 0 }), line({ description: 'Parts ' + ch(0x1f600), quantity: 3, unitPriceCents: 1 }),
  ] }) });
  assert.notEqual(out, COMMAND_REQUEST_INVALID);
  assert.deepEqual(out, {
    aggregateId: id, expectedVersion: null,
    changes: { storeId: STORE, expectedTenant: TENANT, customerId: CUSTOMER, subtotalCents: 9_998 + 0 + 3, lines: [
      { description: 'Glass', quantity: 2, unitPriceCents: 4_999 }, { description: 'Labour', quantity: 1, unitPriceCents: 0 },
      { description: 'Parts ' + ch(0x1f600), quantity: 3, unitPriceCents: 1 },
    ] },
    events: [{ type: 'invoice_draft.created', payload: { storeId: STORE, customerId: CUSTOMER, lineCount: 3 } }],
    response: { status: 201, body: { draft: { id, status: 'draft', currency: 'USD', lineCount: 3, subtotalCents: 10_001 } },
      headers: { location: `/api/v1/stores/${STORE}/invoice-drafts/${id}` } },
  });
  // The boundaries: a single line at exactly 2^53 - 1, and fifty lines whose sum is exactly 2^53 - 1.
  assert.notEqual(plan(body({ lines: [line({ quantity: MAX, unitPriceCents: 1 })] })), COMMAND_REQUEST_INVALID, 'a product of exactly 2^53 - 1');
  assert.notEqual(plan(body({ lines: [line({ quantity: 1, unitPriceCents: MAX })] })), COMMAND_REQUEST_INVALID);
  const fifty = Array.from({ length: 50 }, (_, i) => line({ description: `L${i}`, quantity: 1, unitPriceCents: i === 0 ? MAX - 49 : 1 }));
  const big = plan(body({ lines: fifty }));
  assert.ok(big !== COMMAND_REQUEST_INVALID && big.changes.subtotalCents === MAX, 'fifty lines summing to exactly 2^53 - 1');
  assert.notEqual(plan(body({ lines: [line({ description: 'x'.repeat(256) })] })), COMMAND_REQUEST_INVALID, '256 scalars');
  assert.notEqual(plan(body({ lines: [line({ description: ch(0x1f600).repeat(256) })] })), COMMAND_REQUEST_INVALID, '256 astral scalars (512 units)');
  // The planned values pass the runtime's own contract check, rows and all, and mint the sealed 422 only for this create.
  const ok = plan(body({ lines: fifty }));
  const prepared = prepareCommand(INVOICE_DRAFT_CREATE_CONTRACT, defineOutboxEvents(INVOICE_DRAFT_EVENTS), ok, {
    scope: 's'.repeat(43), lease: 'l'.repeat(43), newAggregateId: (ok as { aggregateId: string }).aggregateId,
    authorization: { scope: 'store', permission: 'create_invoice_drafts' }, context: scopeAt(STORE), authNotAfter: null, sessionKey: SESSION_KEY,
    seal: (envelope) => Buffer.from(JSON.stringify(envelope)).toString('base64url'),
  });
  assert.ok(prepared !== null, 'in contract');
  assert.deepEqual(prepared.rejected.customerNotFound, { status: 422, contentType: 'application/json; charset=utf-8', headers: {}, body: '{"error":"customer_not_found"}' });
  assert.equal((prepared.command.mutation.changes.lines as readonly unknown[]).length, 50);
  assert.ok(Object.isFrozen(prepared.command.mutation.changes.lines) && Object.isFrozen((prepared.command.mutation.changes.lines as readonly object[])[0]), 'deep-frozen rows');
  assert.deepEqual([prepared.command.audit.scope, prepared.command.audit.tenant, prepared.command.audit.store], ['store', TENANT, STORE]);
  assert.deepEqual(prepared.command.events[0].payload, { storeId: STORE, customerId: CUSTOMER, lineCount: 50 });
});

test('AC-06: every invalid input is COMMAND_REQUEST_INVALID — closed keys, ids, currency, 1-50 lines, descriptions, whole amounts, overflow, the target', () => {
  const invalid: Array<[string, unknown] | [string, unknown, string | null]> = [
    ['not an object', [body()]], ['null', null], ['a string', 'x'],
    ['a missing key', (({ currency: _c, ...rest }) => rest)(body())], ['an unknown key', body({ subtotalCents: 1 })],
    ['a server field', body({ status: 'draft' })], ['an id', body({ id: randomUUID() })],
    ['a non-canonical tenant', body({ expectedTenant: TENANT.toUpperCase() })], ['a tenant that is no uuid', body({ expectedTenant: 'tenant' })],
    ['a non-canonical customer', body({ customerId: `{${CUSTOMER}}` })], ['a numeric customer', body({ customerId: 7 })],
    ['another currency', body({ currency: 'usd' })], ['EUR', body({ currency: 'EUR' })], ['no currency', body({ currency: null })],
    ['no lines', body({ lines: [] })], ['51 lines', body({ lines: Array.from({ length: 51 }, () => line()) })], ['lines not an array', body({ lines: line() })],
    ['a line with an extra key', body({ lines: [line({ position: 1 })] })], ['a line missing a key', body({ lines: [{ description: 'x', quantity: 1 }] })],
    ['a line that is no object', body({ lines: ['x'] })],
    ['an empty description', body({ lines: [line({ description: '' })] })], ['a blank description', body({ lines: [line({ description: '  ' + ch(0x3000) })] })],
    ['an invisible description', body({ lines: [line({ description: ch(0x200b, 0x2800) })] })],
    ['257 scalars', body({ lines: [line({ description: 'x'.repeat(257) })] })], ['a control', body({ lines: [line({ description: 'a\u0007b' })] })],
    ['NUL', body({ lines: [line({ description: 'a\u0000b' })] })], ['a Bidi control', body({ lines: [line({ description: 'a‮b' })] })],
    ['a line separator', body({ lines: [line({ description: 'a b' })] })], ['a lone surrogate', body({ lines: [line({ description: 'a' + unit(0xd800) })] })],
    ['a numeric description', body({ lines: [line({ description: 5 })] })],
    ['quantity 0', body({ lines: [line({ quantity: 0 })] })], ['a negative quantity', body({ lines: [line({ quantity: -1 })] })],
    ['a fractional quantity', body({ lines: [line({ quantity: 1.5 })] })], ['a string quantity', body({ lines: [line({ quantity: '2' })] })],
    ['an unsafe quantity', body({ lines: [line({ quantity: MAX + 1 })] })],
    ['a negative price', body({ lines: [line({ unitPriceCents: -1 })] })], ['a fractional price', body({ lines: [line({ unitPriceCents: 0.5 })] })],
    ['-0', body({ lines: [line({ unitPriceCents: -0 })] })], ['a dollar string', body({ lines: [line({ unitPriceCents: '1.00' })] })],
    ['a product above 2^53 - 1', body({ lines: [line({ quantity: 2, unitPriceCents: Math.ceil(MAX / 2) })] })],
    ['a sum above 2^53 - 1', body({ lines: [line({ quantity: 1, unitPriceCents: MAX }), line({ quantity: 1, unitPriceCents: 1 })] })],
    ['no target', body(), null], ['a non-canonical target', body(), STORE.toUpperCase()],
  ];
  for (const c of invalid) assert.equal(plan(c[1], c.length === 3 ? c[2] as string | null : STORE), COMMAND_REQUEST_INVALID, c[0]);
  assert.equal(normalizeDraftDescription('  a  b  '), 'a  b', 'edges trimmed, the inside kept exactly');
  assert.equal(normalizeDraftDescription('é'.normalize('NFD')), 'é'.normalize('NFD'), 'no normalization');
});

// --- 3. the reads: cursor, query, answer validation ---------------------------------------------------------------------------

test('AC-12: the cursor is the canonical 23-character spelling of tag 0x01 and the anchor id; every other spelling is no cursor', () => {
  const id = randomUUID();
  const cursor = encodeInvoiceDraftCursor(id);
  assert.match(cursor, /^[A-Za-z0-9_-]{23}$/);
  assert.equal(Buffer.from(cursor, 'base64url')[0], 0x01);
  assert.equal(decodeInvoiceDraftCursor(cursor), id);
  // 17 bytes in 23 characters leave the last character's two low bits unused: flipping one spells the SAME bytes again.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = cursor.slice(0, -1) + alphabet[alphabet.indexOf(cursor.at(-1) as string) ^ 1];
  assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(cursor, 'base64url'), 'the alias names the same bytes');
  for (const bad of ['', cursor.slice(1), `${cursor}A`, `${cursor.slice(0, -1)}=`, alias, `${cursor.slice(0, -1)}+`,
    Buffer.concat([Buffer.from([0x02]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url')]) {
    assert.equal(decodeInvoiceDraftCursor(bad), null, bad);
  }
  const base = INVOICE_DRAFTS_PATH;
  assert.deepEqual(parseInvoiceDraftListQuery(base), { after: null, limit: 20 }, 'default 20');
  assert.deepEqual(parseInvoiceDraftListQuery(`${base}?limit=50&cursor=${cursor}`), { after: id, limit: 50 });
  assert.deepEqual(parseInvoiceDraftListQuery(`${base}?cursor=${cursor}`), { after: id, limit: 20 });
  for (const q of ['?', '?limit=51', '?limit=0', '?limit=01', '?limit=', '?limit=5&limit=5', '?cursor=', `?cursor=${cursor}&cursor=${cursor}`, '?q=a',
    '?limit=5&', '?&limit=5', `?cursor=${alias}`, `?limit=1${'0'.repeat(200)}`]) {
    assert.equal(parseInvoiceDraftListQuery(`${base}${q}`), null, q);
  }
});

test('AC-12: a page is only an exactly shaped, newest-first, bounded list; a draft only its own id at the trusted store with consistent lines', () => {
  const summary = (i: number, over: Record<string, unknown> = {}) =>
    ({ id: D(i), customerId: CUSTOMER, status: 'draft', currency: 'USD', lineCount: 1, subtotalCents: 100, createdAt: AT, ...over });
  const q = { after: null, limit: 3 };
  assert.deepEqual(invoiceDraftPageOf({ outcome: 'page', drafts: [summary(1), summary(2)], hasMore: false }, q), { drafts: [summary(1), summary(2)], hasMore: false });
  assert.deepEqual(invoiceDraftPageOf({ outcome: 'page', drafts: [summary(1, { createdAt: '2026-10-04T12:00:00.999999Z' }), summary(2)], hasMore: false }, q),
    { drafts: [summary(1, { createdAt: '2026-10-04T12:00:00.999999Z' }), summary(2)], hasMore: false }, 'a later time first');
  assert.equal(invoiceDraftPageOf({ outcome: 'denied' }, q), 'denied');
  assert.equal(invoiceDraftPageOf({ outcome: 'cursor_unknown' }, { after: D(1), limit: 3 }), 'cursor_unknown');
  for (const [label, raw] of [
    ['cursor_unknown without a cursor', { outcome: 'cursor_unknown' }], ['more than the limit', { outcome: 'page', drafts: [summary(1), summary(2), summary(3), summary(4)], hasMore: false }],
    ['hasMore behind a short page', { outcome: 'page', drafts: [summary(1)], hasMore: true }], ['ascending', { outcome: 'page', drafts: [summary(2), summary(1)], hasMore: false }],
    ['a draft twice', { outcome: 'page', drafts: [summary(1), summary(1)], hasMore: false }], ['an extra key', { outcome: 'page', drafts: [summary(1, { storeId: STORE })], hasMore: false }],
    ['another status', { outcome: 'page', drafts: [summary(1, { status: 'issued' })], hasMore: false }],
    ['a millisecond time', { outcome: 'page', drafts: [summary(1, { createdAt: '2026-10-04T12:00:00.123Z' })], hasMore: false }],
    ['an unsafe subtotal', { outcome: 'page', drafts: [summary(1, { subtotalCents: MAX + 1 })], hasMore: false }],
    ['51 lines', { outcome: 'page', drafts: [summary(1, { lineCount: 51 })], hasMore: false }], ['a denial with more', { outcome: 'denied', why: 'x' }],
  ] as const) assert.equal(invoiceDraftPageOf(raw, q), null, label);
  assert.equal(invoiceDraftPageOf({ outcome: 'page', drafts: [summary(1)], hasMore: false }, { after: D(1), limit: 3 }), null, 'the anchor itself never comes back');
  assert.ok(isDraftCreatedAt(AT) && !isDraftCreatedAt('2026-02-30T00:00:00.000000Z') && !isDraftCreatedAt('2026-10-04 12:00:00.123456Z'));
  assert.ok(inInvoiceDraftOrder([{ id: D(1), createdAt: AT }, { id: D(2), createdAt: AT }]) && !inInvoiceDraftOrder([{ id: D(2), createdAt: AT }, { id: D(1), createdAt: AT }]));

  const id = randomUUID();
  const lines = [{ position: 1, description: 'Glass', quantity: 2, unitPriceCents: 50, lineTotalCents: 100 }, { position: 2, description: 'Labour', quantity: 1, unitPriceCents: 0, lineTotalCents: 0 }];
  const draft = { id, storeId: STORE, customerId: CUSTOMER, status: 'draft', currency: 'USD', version: 1, createdAt: AT, subtotalCents: 100, lines };
  assert.deepEqual(invoiceDraftOf({ outcome: 'draft', draft }, id, STORE), draft);
  // M7B-INVOICES-P2: an edit steps the version, so any safe integer from 1 is a version; nothing else is.
  for (const version of [2, 3, MAX - 1, MAX]) assert.deepEqual(invoiceDraftOf({ outcome: 'draft', draft: { ...draft, version } }, id, STORE), { ...draft, version });
  for (const word of ['denied', 'not_found'] as const) assert.equal(invoiceDraftOf({ outcome: word }, id, STORE), word);
  for (const [label, raw] of [
    ['another id', { outcome: 'draft', draft: { ...draft, id: randomUUID() } }], ['another store', { outcome: 'draft', draft: { ...draft, storeId: OTHER_STORE } }],
    ['version 0', { outcome: 'draft', draft: { ...draft, version: 0 } }], ['version -1', { outcome: 'draft', draft: { ...draft, version: -1 } }],
    ['version 2^53', { outcome: 'draft', draft: { ...draft, version: MAX + 1 } }], ['version 1.5', { outcome: 'draft', draft: { ...draft, version: 1.5 } }],
    ['version as text', { outcome: 'draft', draft: { ...draft, version: '2' } }], ['version -0', { outcome: 'draft', draft: { ...draft, version: -0 } }],
    ['a wrong subtotal', { outcome: 'draft', draft: { ...draft, subtotalCents: 101 } }],
    ['a wrong total', { outcome: 'draft', draft: { ...draft, lines: [{ ...lines[0], lineTotalCents: 99 }, lines[1]] } }],
    ['positions out of order', { outcome: 'draft', draft: { ...draft, lines: [lines[1], lines[0]] } }], ['no lines', { outcome: 'draft', draft: { ...draft, lines: [] } }],
    ['a description with a control', { outcome: 'draft', draft: { ...draft, lines: [{ ...lines[0], description: 'a\u0007' }, lines[1]] } }],
    ['a tenant passed through', { outcome: 'draft', draft: { ...draft, tenantId: TENANT } }],
  ] as const) assert.equal(invoiceDraftOf(raw, id, STORE), null, label);
});

// --- 4. the read handlers, called directly -----------------------------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }
async function runRead(kind: 'list' | 'get', opts: { url?: string; path?: string; trusted?: TrustedScope | null; sessionKey?: string | null; answer?: () => unknown } = {}) {
  const calls: unknown[][] = [];
  const answer = opts.answer ?? (() => ({ outcome: 'denied' }));
  const port: InvoiceDraftReadPort = {
    page: (...args) => { calls.push(args); return answer(); },
    get: (...args) => { calls.push(args); return answer(); },
  };
  const route = kind === 'list' ? createInvoiceDraftListRoute({ invoiceDrafts: port }) : createInvoiceDraftDetailRoute({ invoiceDrafts: port });
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = { locals: out.locals, status(code: number) { out.status = code; return res; }, json(b: unknown) { out.body = b; return res; } };
  const ctx = {
    requestId: 'req-7', principal: null, session: null, authenticatedAt: null, body: undefined,
    trusted: 'trusted' in opts ? opts.trusted : scopeAt(STORE), sessionKey: 'sessionKey' in opts ? opts.sessionKey : SESSION_KEY,
  } as unknown as RouteContext;
  const path = opts.path ?? (kind === 'list' ? `/api/v1/stores/${STORE}/invoice-drafts` : `/api/v1/stores/${STORE}/invoice-drafts/${D(1)}`);
  if (route.idempotency !== 'none') throw new Error('a read');
  await route.handler({ url: opts.url ?? path, path } as unknown as Request, res as unknown as Response, ctx);
  return { out, calls };
}

test('AC-02 AC-12: list handler — a bad query 400 and a missing or mismatched store scope 403 before the port; the exact 200 with nextCursor only behind a full page; cursor_unknown the same 400', async () => {
  const bad = await runRead('list', { url: `/api/v1/stores/${STORE}/invoice-drafts?limit=51` });
  assert.deepEqual([bad.out.status, bad.out.body, bad.out.locals.refusal, bad.calls.length], [400, { error: 'invalid_request', requestId: 'req-7' }, 'invoice_draft_list_query_invalid', 0]);
  for (const [label, opts] of [
    ['no trusted scope', { trusted: null }], ['a tenant scope', { trusted: scopeAt(STORE, { scope: 'tenant', store: null }) }],
    ['the trusted store is not the path\'s', { trusted: scopeAt(OTHER_STORE) }], ['no session key', { sessionKey: null }],
  ] as const) {
    const r = await runRead('list', opts);
    assert.deepEqual([r.out.status, r.out.locals.refusal, r.calls.length], [403, 'authz_context_missing', 0], label);
  }
  const summary = (i: number) => ({ id: D(i), customerId: CUSTOMER, status: 'draft', currency: 'USD', lineCount: 2, subtotalCents: 150, createdAt: AT });
  const full = await runRead('list', { url: `/api/v1/stores/${STORE}/invoice-drafts?limit=2`, answer: () => ({ outcome: 'page', drafts: [summary(1), summary(2)], hasMore: true }) });
  assert.equal(full.out.status, 200);
  assert.deepEqual(full.out.body, { drafts: [summary(1), summary(2)], nextCursor: encodeInvoiceDraftCursor(D(2)) });
  assert.deepEqual(full.calls[0].slice(0, 3), [scopeAt(STORE), SESSION_KEY, { after: null, limit: 2 }], 'the trusted scope, the key and the validated query');
  const lastPage = await runRead('list', { answer: () => ({ outcome: 'page', drafts: [summary(1)], hasMore: false }) });
  assert.deepEqual(lastPage.out.body, { drafts: [summary(1)], nextCursor: null });
  const unknown = await runRead('list', { url: `/api/v1/stores/${STORE}/invoice-drafts?cursor=${encodeInvoiceDraftCursor(D(9))}`, answer: () => ({ outcome: 'cursor_unknown' }) });
  assert.deepEqual([unknown.out.status, unknown.out.body], [400, bad.out.body], 'an unknown or foreign anchor: the malformed cursor\'s very body');
  for (const [answer, status, reason] of [
    [() => ({ outcome: 'denied' }), 403, 'invoice_draft_list_denied'], [() => { throw new Error('db host 10.0.0.1 secret'); }, 503, 'invoice_draft_list_unavailable'],
    [() => ({ outcome: 'page', drafts: [{ ...summary(1), tenantId: TENANT }], hasMore: false }), 503, 'invoice_draft_list_answer_invalid'],
  ] as const) {
    const r = await runRead('list', { answer });
    assert.deepEqual([r.out.status, r.out.locals.refusal], [status, reason]);
    assert.ok(!JSON.stringify(r.out.body).includes('secret'));
  }
});

test('AC-02: get handler — a query 400, a malformed id 400, missing and foreign the same 404, denied 403, out of shape 503, the exact 200', async () => {
  const q = await runRead('get', { url: `/api/v1/stores/${STORE}/invoice-drafts/${D(1)}?x=1` });
  assert.deepEqual([q.out.status, q.out.locals.refusal, q.calls.length], [400, 'invoice_draft_query_invalid', 0]);
  const malformed = await runRead('get', { path: `/api/v1/stores/${STORE}/invoice-drafts/${D(1).toUpperCase()}` });
  assert.deepEqual([malformed.out.status, malformed.out.locals.refusal, malformed.calls.length], [400, 'invoice_draft_id_invalid', 0]);
  const missing = await runRead('get', { answer: () => ({ outcome: 'not_found' }) });
  assert.deepEqual([missing.out.status, missing.out.body, missing.out.locals.refusal], [404, { error: 'not_found', requestId: 'req-7' }, 'invoice_draft_not_found']);
  assert.deepEqual(missing.calls[0].slice(0, 3), [scopeAt(STORE), SESSION_KEY, D(1)]);
  const denied = await runRead('get', { answer: () => ({ outcome: 'denied' }) });
  assert.deepEqual([denied.out.status, denied.out.locals.refusal], [403, 'invoice_draft_denied']);
  const lines = [{ position: 1, description: 'Glass', quantity: 3, unitPriceCents: 7, lineTotalCents: 21 }];
  const draft = { id: D(1), storeId: STORE, customerId: CUSTOMER, status: 'draft', currency: 'USD', version: 1, createdAt: AT, subtotalCents: 21, lines };
  const ok = await runRead('get', { answer: () => ({ outcome: 'draft', draft }) });
  assert.deepEqual([ok.out.status, ok.out.body], [200, { draft }]);
  assert.deepEqual(Object.keys((ok.out.body as { draft: object }).draft), ['id', 'storeId', 'customerId', 'status', 'currency', 'version', 'createdAt', 'subtotalCents', 'lines']);
  const foreign = await runRead('get', { answer: () => ({ outcome: 'draft', draft: { ...draft, storeId: OTHER_STORE } }) });
  assert.deepEqual([foreign.out.status, foreign.out.locals.refusal], [503, 'invoice_draft_answer_invalid'], 'a draft of another store is a fault, never an answer');
});

// --- 4b. the creation eligibility (M7B-INVOICES-P1-R2, DA-201): its declaration and its handler, called directly -----------

test('DA-201 AC-11: the eligibility route is a session-bound STORE-scope GET under the save\'s own requirement object — no body, no key, no recent sign-in — and the runtime registers it', () => {
  const r = createInvoiceDraftEligibilityRoute();
  assert.equal(INVOICE_DRAFT_ELIGIBILITY_PATH, '/api/v1/stores/{storeId}/invoice-drafts/eligibility');
  assert.deepEqual([r.method, r.path, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding], ['GET', INVOICE_DRAFT_ELIGIBILITY_PATH, 'none', 'required', 'none', 'required']);
  assert.deepEqual(r.body, { kind: 'none' });
  assert.ok(r.policy.access === 'session' && INVOICE_DRAFT_CREATE_ROUTE.policy.access === 'session');
  // ONE requirement, one evaluator: the very object the save declares, so the chain's authorizer decides both the same way.
  assert.equal(r.policy.authorization, INVOICE_DRAFT_CREATE_REQUIREMENT, 'the create requirement object itself');
  assert.equal(r.policy.authorization, INVOICE_DRAFT_CREATE_ROUTE.policy.authorization, 'the save\'s own requirement object');
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'create_invoice_drafts' } });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.policy) && Object.isFrozen(r.body) && Object.isFrozen(INVOICE_DRAFT_CREATE_REQUIREMENT));
  const table = defineRoutes([createInvoiceDraftListRoute({ invoiceDrafts: { page: () => null, get: () => null } }),
    createInvoiceDraftDetailRoute({ invoiceDrafts: { page: () => null, get: () => null } }), r, INVOICE_DRAFT_CREATE_ROUTE]);
  assert.equal(table.lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/eligibility`)?.path, INVOICE_DRAFT_ELIGIBILITY_PATH, 'never the draft read');
  assert.equal(table.lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/eligible`)?.path, INVOICE_DRAFT_PATH, 'any other segment is still a draft id');
  assert.notEqual(createInvoiceDraftEligibilityRoute(), r, 'a fresh definition per build');
});

async function runEligibility(opts: { url?: string; path?: string; trusted?: TrustedScope | null; sessionKey?: string | null } = {}) {
  const route = createInvoiceDraftEligibilityRoute();
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = { locals: out.locals, status(code: number) { out.status = code; return res; }, json(b: unknown) { out.body = b; return res; } };
  const ctx = {
    requestId: 'req-8', principal: null, session: null, authenticatedAt: null, body: undefined,
    trusted: 'trusted' in opts ? opts.trusted : scopeAt(STORE), sessionKey: 'sessionKey' in opts ? opts.sessionKey : SESSION_KEY,
  } as unknown as RouteContext;
  const path = opts.path ?? `/api/v1/stores/${STORE}/invoice-drafts/eligibility`;
  if (route.idempotency !== 'none') throw new Error('a read');
  await route.handler({ url: opts.url ?? path, path } as unknown as Request, res as unknown as Response, ctx);
  return out;
}

test('DA-201 AC-11 AC-12: eligibility handler — any query is the 400; a missing, tenant or other-store scope or no session key is the 403; otherwise exactly { eligibility: "allowed" }', async () => {
  const at = `/api/v1/stores/${STORE}/invoice-drafts/eligibility`;
  for (const url of [`${at}?`, `${at}?x=1`, `${at}?eligibility=allowed`, `${at}?storeId=${OTHER_STORE}`]) {
    const r = await runEligibility({ url });
    assert.deepEqual([r.status, r.body, r.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-8' }, 'invoice_draft_eligibility_query_invalid'], url);
  }
  for (const [label, opts] of [
    ['no trusted scope', { trusted: null }], ['a tenant scope', { trusted: scopeAt(STORE, { scope: 'tenant', store: null }) }],
    ['a store scope without its tenant', { trusted: scopeAt(STORE, { tenant: null }) }],
    ['the trusted store is not the path\'s', { trusted: scopeAt(OTHER_STORE) }], ['no session key', { sessionKey: null }],
    ['a non-canonical path store', { path: `/api/v1/stores/${STORE.toUpperCase()}/invoice-drafts/eligibility` }],
  ] as const) {
    const r = await runEligibility(opts);
    assert.deepEqual([r.status, r.body, r.locals.refusal], [403, { error: 'forbidden', requestId: 'req-8' }, 'authz_context_missing'], label);
  }
  // The handler is reached only once the chain granted create_invoice_drafts; it answers the closed positive body and nothing
  // else — no role, level, grant, tenant, store, token or customer — whatever the trusted scope carries.
  for (const trusted of [scopeAt(STORE), scopeAt(STORE, { roleId: 'store_owner' }), scopeAt(STORE, { roleId: 'manager', limitation: 'read_only' })]) {
    const ok = await runEligibility({ trusted });
    assert.deepEqual([ok.status, ok.body, ok.locals.refusal], [200, { eligibility: 'allowed' }, undefined]);
    assert.deepEqual(Object.keys(ok.body as object), ['eligibility']);
    const text = JSON.stringify(ok.body);
    for (const secret of [TENANT, STORE, ACTOR, MEMBERSHIP, SESSION_KEY, 'sales_staff', 'store_owner']) assert.ok(!text.includes(secret), secret);
  }
});

// --- 5. the save over the enforced chain ---------------------------------------------------------------------------------------

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
function request(port: number, method: string, path: string, headers: Record<string, string>, payload?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * The real app over a memory idempotency store and a port that answers by the body's customer: MISSING is the typed refusal
 * (its sealed 422 recorded as the completion, as the PostgreSQL store does), WRONG_TENANT the rolled-back precondition, and
 * anything else commits (the sealed 201 recorded). The authorizer selects a store scope at the view's storeTarget only —
 * unless a test hands it `scopeFor`, the scope it should answer for a storeTarget (false: denied).
 */
interface Chain {
  commits: TransactionCommand[];
  views: unknown[];
  /** The requirement the authorizer was handed, per call, beside `views`. */
  requirements: unknown[];
  /** The memory idempotency records, by scope: what the chain reserved and with which fingerprint. */
  records: Map<string, { readonly fingerprint: string }>;
  /** Every line the runtime logged, parsed. */
  logs: Record<string, unknown>[];
  post: (store: string, payload: string, key: string) => Promise<Reply>;
  /** A GET of the eligibility path (or `suffix` in its place) as the signed-in client sends it; `headers` override. */
  eligibility: (store: string, opts?: { suffix?: string; headers?: Record<string, string | undefined> }) => Promise<Reply>;
  setScopeFor: (scopeFor: ((storeTarget: string | null) => TrustedScope | false) | null) => void;
}
async function withChain(fn: (h: Chain) => Promise<void>, outcomes: { missing: string; wrongTenant: string }): Promise<void> {
  const commits: TransactionCommand[] = [];
  const views: unknown[] = [];
  const requirements: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  let scopeFor: ((storeTarget: string | null) => TrustedScope | false) | null = null;
  const state = createMemoryIdempotencyState();
  const inner = createMemoryIdempotencyStore(state);
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      const customer = (c.mutation.changes as { customerId: string }).customerId;
      if (customer === outcomes.wrongTenant) return { outcome: 'precondition_failed' };
      const sealed = customer === outcomes.missing ? c.rejected.customerNotFound : c.response;
      if (sealed === null) return { outcome: 'unavailable' };
      const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: sealed }), s);
      if ((done as { outcome?: unknown }).outcome !== 'completed') return { outcome: 'lease_lost' };
      return { outcome: customer === outcomes.missing ? 'customer_not_found' : 'committed' };
    },
    probe: () => true,
  };
  const boundary: SessionBoundaryDeps = {
    trustedOrigins: [TENANT_ORIGIN],
    verifier: { async verify(credential) {
      return credential.bearerToken === BEARER ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-drafts', authenticatedAt: Date.now(), secondFactor: null } : null;
    } },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
    authorizer: { authorize: (_principal: unknown, requirement: unknown, view: { storeTarget?: string | null }) => {
      views.push(view);
      requirements.push(requirement);
      if (scopeFor !== null) {
        const scope = scopeFor(view.storeTarget ?? null);
        return scope === false ? false : { granted: true, context: scope };
      }
      return typeof view.storeTarget === 'string' ? { granted: true, context: scopeAt(view.storeTarget) } : false;
    } },
    store: createMemorySessionStore(),
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); } }, sessions: { tenant: boundary },
    routes: [INVOICE_DRAFT_CREATE_ROUTE, createInvoiceDraftEligibilityRoute()], events: INVOICE_DRAFT_EVENTS,
    limits: testRequestLimits(), idempotency: { store: inner, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = (server.address() as AddressInfo).port;
    const login = await request(p, 'POST', sessionPaths('tenant').login, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
    });
    assert.equal(login.status, 200, login.body);
    const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const id = pair.slice(pair.indexOf('=') + 1);
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    views.length = 0;
    requirements.length = 0;
    const eligibility = (store: string, opts: { suffix?: string; headers?: Record<string, string | undefined> } = {}) => {
      const headers: Record<string, string | undefined> = { cookie: `${SESSION_COOKIES.tenant}=${id}`, [SESSION_CSRF_HEADER]: csrf, ...opts.headers };
      return request(p, 'GET', `/api/v1/stores/${store}/invoice-drafts${opts.suffix ?? '/eligibility'}`,
        Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined)));
    };
    await fn({ commits, views, requirements, records: state.records, logs, eligibility, setScopeFor: (f) => { scopeFor = f; }, post: (store, payload, key) => request(p, 'POST', `/api/v1/stores/${store}/invoice-drafts`, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: `${SESSION_COOKIES.tenant}=${id}`, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': key,
    }, payload) });
    assert.equal(createHash('sha256').update(id).digest('base64url').length, 43);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

test('AC-05 AC-09: over the chain — a sealed 201 with its Location that replays; the typed sealed 422 that replays byte for byte; the unsealed 409 precondition; the store bound into the fingerprint', async () => {
  const MISSING = randomUUID();
  const WRONG = randomUUID();
  await withChain(async (h) => {
    const payload = JSON.stringify(body());
    const key = randomUUID();
    const created = await h.post(STORE, payload, key);
    assert.equal(created.status, 201, created.body);
    const draft = (JSON.parse(created.body) as { draft: { id: string } }).draft;
    assert.deepEqual(JSON.parse(created.body), { draft: { id: draft.id, status: 'draft', currency: 'USD', lineCount: 1, subtotalCents: 9_998 } });
    assert.equal(created.headers.location, `/api/v1/stores/${STORE}/invoice-drafts/${draft.id}`);
    assert.deepEqual(h.views.map((v) => (v as { storeTarget?: unknown }).storeTarget), [STORE], 'the authorizer was handed the path\'s store');
    const c = h.commits[0];
    assert.deepEqual([c.context?.scope, c.context?.store, c.audit.scope, c.audit.store, c.audit.tenant], ['store', STORE, 'store', STORE, TENANT]);
    assert.ok(c.rejected.customerNotFound !== null && c.rejected.invalidState === null);
    const again = await h.post(STORE, payload, key);
    assert.deepEqual([again.status, again.body, again.headers.location, again.headers['idempotent-replayed']], [201, created.body, created.headers.location, 'true']);
    assert.equal(h.commits.length, 1, 'the retry replayed: nothing was planned again');
    // One key, one body, another store: the store is in the fingerprint, so it is another request under the key — the
    // reuse refusal before any commit, never store A's answer replayed for store B. A fresh key there saves there.
    const commitsSoFar = h.commits.length;
    const elsewhere = await h.post(OTHER_STORE, payload, key);
    assert.deepEqual([elsewhere.status, JSON.parse(elsewhere.body).error, elsewhere.headers.location], [422, 'idempotency_key_reused', undefined]);
    assert.equal(h.commits.length, commitsSoFar);
    const there = await h.post(OTHER_STORE, payload, randomUUID());
    assert.equal(there.status, 201, there.body);
    assert.equal(there.headers.location?.startsWith(`/api/v1/stores/${OTHER_STORE}/invoice-drafts/`), true);
    // The typed sealed 422: exact bytes, no correlator, replayed under its key.
    const missingKey = randomUUID();
    const missingBody = JSON.stringify(body({ customerId: MISSING }));
    const refused = await h.post(STORE, missingBody, missingKey);
    assert.deepEqual([refused.status, refused.body, refused.headers.location], [422, '{"error":"customer_not_found"}', undefined]);
    const replayed = await h.post(STORE, missingBody, missingKey);
    assert.deepEqual([replayed.status, replayed.body, replayed.headers['idempotent-replayed']], [422, refused.body, 'true']);
    // A changed body under that key is the 422 key-reused refusal, before any commit.
    const before = h.commits.length;
    const reused = await h.post(STORE, JSON.stringify(body()), missingKey);
    assert.deepEqual([reused.status, JSON.parse(reused.body).error], [422, 'idempotency_key_reused']);
    assert.equal(h.commits.length, before);
    // The precondition: rolled back, so the runtime's own unsealed 409 in the chain's shape.
    const wrong = await h.post(STORE, JSON.stringify(body({ customerId: WRONG })), randomUUID());
    assert.equal(wrong.status, 409, wrong.body);
    assert.deepEqual(Object.keys(JSON.parse(wrong.body)).sort(), ['error', 'requestId']);
    assert.equal(JSON.parse(wrong.body).error, 'write_conflict');
    // An invalid body is the 400 after the key, committing nothing.
    const commitsBefore = h.commits.length;
    const invalid = await h.post(STORE, JSON.stringify(body({ currency: 'EUR' })), randomUUID());
    assert.deepEqual([invalid.status, JSON.parse(invalid.body).error, h.commits.length], [400, 'invalid_request', commitsBefore]);
    // A non-canonical store segment selects no grant: the authorizer is handed null and the request is the 403.
    const upper = await h.post(STORE.toUpperCase(), payload, randomUUID());
    assert.equal(upper.status, 403, upper.body);
    assert.equal((h.views.at(-1) as { storeTarget?: unknown }).storeTarget, null);
  }, { missing: MISSING, wrongTenant: WRONG });
});

test('AC-02 AC-09 (R4): the store command\'s target is the validated path store — the planner\'s change set and Location, the idempotency fingerprint\'s target and the trusted store are one store; a scope at another store is the 403 before any key; a non-canonical segment is the authorizer\'s 403', async () => {
  await withChain(async (h) => {
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    const principal = { authProvider: 'synthetic', authProviderUid: 'uid-drafts' };
    const payload = JSON.stringify(body());
    const key = randomUUID();
    const created = await h.post(STORE, payload, key);
    assert.equal(created.status, 201, created.body);
    const draftId = (JSON.parse(created.body) as { draft: { id: string } }).draft.id;
    const [c] = h.commits;
    // The planner received the store as its target: the change set the mutator binds and the Location both name it.
    assert.equal((c.mutation.changes as { storeId?: unknown }).storeId, STORE, 'the planner\'s change set names the path store');
    assert.equal(created.headers.location, `/api/v1/stores/${STORE}/invoice-drafts/${draftId}`);
    assert.deepEqual([c.context?.scope, c.context?.store, c.context?.tenant], ['store', STORE, TENANT], 'the trusted store is that same store');
    // The operation the chain reserved: its fingerprint binds the trusted tenant, store and actor AND the store as target.
    const binding = { method: 'POST' as const, path: INVOICE_DRAFTS_PATH, audience: 'tenant' as const, tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from(payload) };
    const expected = keyring.operationOf(key, principal, { ...binding, target: STORE });
    assert.equal(c.scope, expected.scope, 'the record the command completes is this key\'s');
    assert.equal(h.records.get(c.scope)?.fingerprint, expected.fingerprint, 'the reserved fingerprint carries the store as its target');
    assert.notEqual(keyring.operationOf(key, principal, { ...binding, target: null }).fingerprint, expected.fingerprint,
      'non-vacuous: without the target the fingerprint differs');
    // An authorizer whose trusted scope names ANOTHER store than the path never reaches the planner or the store: app.ts
    // requires the target to be the trusted store (authz_context_missing), before the body is read or a key reserved. A
    // store scope naming no store, or a scope at another level, is no grant at all (access.ts: authz_denied).
    const recordsBefore = h.records.size;
    const commitsBefore = h.commits.length;
    for (const [label, scope, reason] of [
      ['a scope at another store', scopeAt(OTHER_STORE), 'authz_context_missing'],
      ['a store scope naming no store', scopeAt(STORE, { store: null }), 'authz_denied'],
      ['a tenant scope', scopeAt(STORE, { scope: 'tenant', store: null }), 'authz_denied'],
    ] as const) {
      h.setScopeFor(() => scope);
      const refused = await h.post(STORE, payload, randomUUID());
      assert.deepEqual([refused.status, JSON.parse(refused.body).error], [403, 'forbidden'], `${label}: ${refused.body}`);
      assert.deepEqual(Object.keys(JSON.parse(refused.body)), ['error', 'requestId']);
      const line = h.logs.filter((l) => l.event === 'request').at(-1);
      assert.equal(line?.reason, reason, label);
    }
    assert.equal(h.records.size, recordsBefore, 'no idempotency record was reserved');
    assert.equal(h.commits.length, commitsBefore, 'nothing was planned or committed');
    // A non-canonical store segment: the authorizer is handed no store and denies — its own 403, never the target's 400.
    h.setScopeFor(null);
    for (const segment of [STORE.toUpperCase(), `{${STORE}}`, `${STORE}0`]) {
      const upper = await h.post(segment, payload, randomUUID());
      assert.deepEqual([upper.status, JSON.parse(upper.body).error], [403, 'forbidden'], `${segment}: ${upper.body}`);
      assert.equal((h.views.at(-1) as { storeTarget?: unknown }).storeTarget, null, `${segment}: no store selected`);
      assert.notEqual(h.logs.filter((l) => l.event === 'request').at(-1)?.reason, 'command_target_invalid', segment);
    }
    assert.equal(h.records.size, recordsBefore);
    assert.equal(h.commits.length, commitsBefore);
  }, { missing: randomUUID(), wrongTenant: randomUUID() });
});

test('AC-09: a store command answering customer_not_found without the opted-in slot, or an update answering it, is never sealed', () => {
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const events = defineOutboxEvents(INVOICE_DRAFT_EVENTS);
  const { sealedRefusal: _drop, ...plain } = INVOICE_DRAFT_CREATE_CONTRACT;
  const contract = defineCommands([plain], events).contract(plain.kind);
  assert.ok(contract !== undefined && contract.sealedRefusal === undefined);
  const ok = plan(body());
  assert.notEqual(ok, COMMAND_REQUEST_INVALID);
  const operation = keyring.operationOf(randomUUID(), { authProvider: 'x', authProviderUid: 'y' }, {
    method: 'POST', path: INVOICE_DRAFTS_PATH, audience: 'tenant', tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from('{}'), target: STORE,
  });
  const prepared = prepareCommand(contract, events, ok, {
    scope: operation.scope, lease: 'l'.repeat(43), newAggregateId: (ok as { aggregateId: string }).aggregateId,
    authorization: { scope: 'store', permission: 'create_invoice_drafts' }, context: scopeAt(STORE), authNotAfter: null, sessionKey: SESSION_KEY,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null && prepared.rejected.customerNotFound === null && prepared.command.rejected.customerNotFound === null,
    'a contract that did not opt in carries no sealed 422');
  assert.throws(() => defineCommands([{ ...INVOICE_DRAFT_CREATE_CONTRACT, mode: 'update' }], events), (e: unknown) => e instanceof EnforcementSetupError,
    'an update may not opt into the typed refusal');
  assert.throws(() => defineCommands([{ ...INVOICE_DRAFT_CREATE_CONTRACT, sealedRefusal: 'not_found' }], events), (e: unknown) => e instanceof EnforcementSetupError);
  assert.throws(() => defineCommands([{ ...INVOICE_DRAFT_CREATE_CONTRACT, contextScope: 'shop' }], events), (e: unknown) => e instanceof EnforcementSetupError);
});

test('DA-201 AC-10 AC-11 AC-12: eligibility over the chain — the save\'s requirement and the path\'s store reach the authorizer; 200 is the closed body; a denial, a foreign or non-canonical store and a session-CSRF mismatch are one 403; 401, 400; an authorizer outage 503; no-store; nothing reserved or committed', async () => {
  await withChain(async (h) => {
    const ok = await h.eligibility(STORE);
    assert.deepEqual([ok.status, ok.body], [200, '{"eligibility":"allowed"}']);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.deepEqual(h.requirements, [{ scope: 'store', permission: 'create_invoice_drafts' }], 'the save\'s requirement, never the view\'s');
    assert.deepEqual(h.views, [{ method: 'GET', path: INVOICE_DRAFT_ELIGIBILITY_PATH, audience: 'tenant', storeTarget: STORE }]);
    // The POST is decided under the very same requirement value.
    const saved = await h.post(STORE, JSON.stringify(body()), randomUUID());
    assert.equal(saved.status, 201, saved.body);
    assert.deepEqual(h.requirements[1], h.requirements[0], 'one requirement for both');
    const commits = h.commits.length;
    const records = h.records.size;
    // Denied by the authorizer: the chain's generic 403, the handler never reached.
    h.setScopeFor(() => false);
    const denied = await h.eligibility(STORE);
    assert.equal(denied.status, 403, denied.body);
    assert.deepEqual(Object.keys(JSON.parse(denied.body)), ['error', 'requestId']);
    assert.equal(JSON.parse(denied.body).error, 'forbidden');
    assert.equal(denied.headers['cache-control'], 'no-store');
    // A foreign store selects no grant (here the authorizer answers for STORE only); a non-canonical segment is a null target.
    h.setScopeFor((target) => (target === STORE ? scopeAt(STORE) : false));
    const foreign = await h.eligibility(OTHER_STORE);
    const upper = await h.eligibility(STORE.toUpperCase());
    assert.equal((h.views.at(-1) as { storeTarget?: unknown }).storeTarget, null, 'the non-canonical segment selects nothing');
    // A scope the authorizer resolved at another store than the path's: the handler's own 403.
    h.setScopeFor(() => scopeAt(OTHER_STORE));
    const mismatched = await h.eligibility(STORE);
    h.setScopeFor(null);
    // The presenting session's CSRF token is required on this GET: missing or another value is the same 403, before the authorizer.
    const asked = h.views.length;
    const noCsrf = await h.eligibility(STORE, { headers: { [SESSION_CSRF_HEADER]: undefined } });
    const wrongCsrf = await h.eligibility(STORE, { headers: { [SESSION_CSRF_HEADER]: 'x'.repeat(43) } });
    assert.equal(h.views.length, asked, 'a session-CSRF refusal never reaches the authorizer');
    for (const [label, r] of [['foreign', foreign], ['non-canonical', upper], ['other-store scope', mismatched], ['no CSRF', noCsrf], ['wrong CSRF', wrongCsrf]] as const) {
      assert.equal(r.status, 403, `${label}: ${r.body}`);
      assert.deepEqual([Object.keys(JSON.parse(r.body)), JSON.parse(r.body).error], [['error', 'requestId'], 'forbidden'], label);
    }
    // Which 403 is which, in the log alone: the authorizer's denial, the handler's own re-check, the session-CSRF refusal.
    const reasonOf = (r: Reply) => h.logs.find((l) => l.event === 'request' && l.requestId === r.headers['x-request-id'])?.reason;
    assert.deepEqual([reasonOf(denied), reasonOf(mismatched)], ['authz_denied', 'authz_context_missing']);
    assert.deepEqual([reasonOf(noCsrf), reasonOf(wrongCsrf)], ['csrf_session_missing', 'csrf_session_invalid'], 'the session-CSRF refusals, by name');
    // No session: 401. A query: 400. A trailing segment: no route, 404 (a POST's 404: tenantEntry.test.ts M7TU and IDH-18).
    const anon = await h.eligibility(STORE, { headers: { cookie: undefined, [SESSION_CSRF_HEADER]: undefined } });
    assert.equal(anon.status, 401, anon.body);
    const query = await h.eligibility(STORE, { suffix: '/eligibility?x=1' });
    assert.deepEqual([query.status, JSON.parse(query.body).error], [400, 'invalid_request']);
    assert.equal((await h.eligibility(STORE, { suffix: '/eligibility/x' })).status, 404);
    // An authorizer that cannot answer (here its role-levels read throws) is the outage's 503 — never the handler's allowed body.
    h.setScopeFor(() => { throw new Error('role levels read failed: db host 10.0.0.1'); });
    const outage = await h.eligibility(STORE);
    h.setScopeFor(null);
    assert.deepEqual([outage.status, JSON.parse(outage.body).error, Object.keys(JSON.parse(outage.body))], [503, 'service_unavailable', ['error', 'requestId']]);
    assert.notEqual(outage.body, ok.body);
    assert.equal(reasonOf(outage), 'authz_unavailable', 'the authorizer\'s outage, decided before any handler');
    assert.equal(outage.headers['cache-control'], 'no-store');
    assert.ok(!outage.body.includes('10.0.0.1'));
    // Nothing reserved, nothing committed, by any eligibility answer.
    assert.deepEqual([h.commits.length, h.records.size], [commits, records], 'no idempotency record and no commit');
  }, { missing: randomUUID(), wrongTenant: randomUUID() });
});
