// Phase 4.0 M7B-INVOICES-P1 — the store directory through the runtime, and the store templates' target through the chain.
//
// GET /api/v1/stores: its registration as the route table's one closed authorization-free business route, the strict
// validation of the port's untrusted answer, the handler's every outcome, and the enforced chain over real loopback
// sockets on the TENANT boundary — 401 first, the session-binding CSRF witness before the port, NO authorizer, the
// presenting session's key alone reaching the port, the exact 200 and no-store. Then the store templates (routes.ts): the
// chain hands their authorizer the store the path names as RouteView.storeTarget — a canonical uuid, or null for any other
// spelling — while every other route's view stays exactly { method, path, audience }, and a path outside the template
// grammar is the pre-authentication 404.
//
// Synthetic principals, sessions and ports only. The PostgreSQL adapter is proved database-free in
// server/persistence/postgresStoreDirectory.test.ts and against a real cluster in tests/db/storeAccess.integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import type { RouteContext, RouteDefinition } from './routes.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import {
  STORE_DIRECTORY_MAX_ENTRIES, STORE_DIRECTORY_PATH, STORE_NAME_MAX_CHARACTERS, createStoreDirectoryRoute, inStoreDirectoryOrder,
  isServableStoreName, storeDirectoryOf,
} from './storeDirectory.js';
import type { StoreDirectoryPort } from './storeDirectory.js';

const ACTOR = randomUUID();
const TENANT = randomUUID();
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
/** A synthetic session key, in the shape the chain computes one (sessions.ts digestOf). */
const SESSION_KEY = 'k'.repeat(43);
/** Synthetic store ids in id order: canonical, distinct, generated from an index. */
const idOf = (i: number): string => `${(0x10000000 + i).toString(16)}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const store = (i: number, over: Record<string, unknown> = {}) => ({ id: idOf(i), tenantId: TENANT, name: `Store ${String(i).padStart(3, '0')}`, readOnly: false, ...over });

// --- 1. the route's registration -------------------------------------------------------------------------------------------

test('the route is GET /api/v1/stores on the tenant boundary with NO authorization, no trusted context, the session binding required, no body and no key', () => {
  const route = createStoreDirectoryRoute({ stores: { stores: () => ({ outcome: 'stores', stores: [] }) } });
  assert.equal(STORE_DIRECTORY_PATH, '/api/v1/stores');
  assert.deepEqual([route.method, route.path], ['GET', '/api/v1/stores']);
  assert.deepEqual(route.policy, { access: 'session', audience: 'tenant', authorization: null });
  assert.deepEqual([route.body, route.idempotency, route.trustedContext, route.recentAuth, route.sessionBinding], [{ kind: 'none' }, 'none', 'none', 'none', 'required']);
  assert.deepEqual(Object.keys(route).sort(), ['body', 'handler', 'idempotency', 'method', 'path', 'policy', 'recentAuth', 'sessionBinding', 'trustedContext']);
  assert.ok(Object.isFrozen(route) && Object.isFrozen(route.policy) && Object.isFrozen(route.body));
  assert.equal(defineRoutes([route]).list().length, 1, 'the runtime\'s own route table accepts it');
  for (const ports of [undefined, null, {}, { stores: null }, { stores: {} }, { stores: { stores: 'yes' } }, { customers: { page: () => null } }]) {
    assert.throws(() => createStoreDirectoryRoute(ports as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid', JSON.stringify(ports));
  }
  for (const deadlineMs of [0, -1, 1.5, 3_001, Number.NaN, '100']) {
    assert.throws(() => createStoreDirectoryRoute({ stores: { stores: () => null } }, { deadlineMs: deadlineMs as never }),
      (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid', String(deadlineMs));
  }
});

// --- 2. the port's answer is untrusted ------------------------------------------------------------------------------------

test('storeDirectoryOf: only an exactly shaped list becomes the answer — every field checked and copied — and anything else is null', () => {
  const list = storeDirectoryOf({ outcome: 'stores', stores: [store(1), store(2, { name: null, readOnly: true })] });
  assert.deepEqual(list, [store(1), store(2, { name: null, readOnly: true })]);
  assert.ok(Array.isArray(list) && Object.isFrozen(list) && Object.isFrozen(list[0]));
  assert.deepEqual(storeDirectoryOf({ outcome: 'stores', stores: [] }), [], 'no usable store is an empty list');
  assert.equal(storeDirectoryOf({ outcome: 'denied' }), 'denied');
  const full = Array.from({ length: STORE_DIRECTORY_MAX_ENTRIES }, (_, i) => store(i + 1));
  assert.equal((storeDirectoryOf({ outcome: 'stores', stores: full }) as unknown[]).length, 200, 'two hundred stores (the resolver\'s ceiling)');
  const otherTenant = randomUUID();
  assert.deepEqual(storeDirectoryOf({ outcome: 'stores', stores: [store(1), store(2, { tenantId: otherTenant })] }), [store(1), store(2, { tenantId: otherTenant })],
    'stores of two tenants (store grants in two tenants)');
  for (const [label, raw] of [
    ['null', null], ['a string', 'stores'], ['an array', [store(1)]], ['no outcome', { stores: [] }], ['another outcome', { outcome: 'page', stores: [] }],
    ['denied with more', { outcome: 'denied', stores: [] }], ['stores with more', { outcome: 'stores', stores: [], more: false }],
    ['stores not an array', { outcome: 'stores', stores: {} }], ['201 stores', { outcome: 'stores', stores: [...full, store(999)] }],
    ['an entry with an extra key', { outcome: 'stores', stores: [{ ...store(1), roleId: 'manager' }] }],
    ['an entry missing a key', { outcome: 'stores', stores: [{ id: idOf(1), tenantId: TENANT, name: 'x' }] }],
    ['an uppercase id', { outcome: 'stores', stores: [store(1, { id: ['ABCDEF01', '0000', '4000', '8000', '000000000001'].join('-') })] }],
    ['a non-uuid id', { outcome: 'stores', stores: [store(1, { id: 'store-1' })] }],
    ['a non-uuid tenant', { outcome: 'stores', stores: [store(1, { tenantId: 7 })] }],
    ['a store twice', { outcome: 'stores', stores: [store(1), store(1)] }],
    ['an empty name', { outcome: 'stores', stores: [store(1, { name: '' })] }],
    ['a name of 257 characters', { outcome: 'stores', stores: [store(1, { name: 'x'.repeat(257) })] }],
    ['a lone surrogate', { outcome: 'stores', stores: [store(1, { name: 'a\ud800' })] }],
    ['a numeric name', { outcome: 'stores', stores: [store(1, { name: 5 })] }],
    ['a string flag', { outcome: 'stores', stores: [store(1, { readOnly: 'false' })] }],
    ['out of order by name', { outcome: 'stores', stores: [store(2), store(1)] }],
    ['a null name before a named one', { outcome: 'stores', stores: [store(1, { name: null }), store(2)] }],
    ['an entry with a prototype', { outcome: 'stores', stores: [Object.assign(Object.create({ x: 1 }), store(1))] }],
  ] as const) {
    assert.equal(storeDirectoryOf(raw), null, label);
  }
  const hostile = { outcome: 'stores', get stores(): never { throw new Error('trap'); } };
  assert.equal(storeDirectoryOf(hostile), null, 'a throwing getter is never a list');
  assert.ok(isServableStoreName(null) && isServableStoreName('x'.repeat(STORE_NAME_MAX_CHARACTERS)) && isServableStoreName('🙂'.repeat(256)));
  assert.ok(!isServableStoreName('🙂'.repeat(257)) && !isServableStoreName(undefined));
});

test('inStoreDirectoryOrder: by name bytes, unnamed stores last, then id — strictly increasing', () => {
  const s = (id: number, name: string | null) => ({ id: idOf(id), name });
  assert.ok(inStoreDirectoryOrder([]));
  assert.ok(inStoreDirectoryOrder([s(9, 'A'), s(1, 'B'), s(2, null), s(3, null)]));
  assert.ok(inStoreDirectoryOrder([s(1, 'Z'), s(2, 'a')]), 'byte order: upper before lower');
  assert.ok(inStoreDirectoryOrder([s(1, 'é'), s(2, '😀')]), 'UTF-8 byte order, not UTF-16');
  assert.ok(inStoreDirectoryOrder([s(1, 'same'), s(2, 'same')]), 'equal names: by id');
  assert.ok(!inStoreDirectoryOrder([s(2, 'same'), s(1, 'same')]));
  assert.ok(!inStoreDirectoryOrder([s(1, 'same'), s(1, 'same')]), 'never the same store twice');
  assert.ok(!inStoreDirectoryOrder([s(1, null), s(2, 'A')]));
  assert.ok(!inStoreDirectoryOrder([s(2, null), s(1, null)]));
  assert.ok(!inStoreDirectoryOrder([s(1, '😀'), s(2, '￿')]), 'U+FFFF sorts before an astral character in UTF-8');
});

// --- 3. the handler, called directly ---------------------------------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }

async function run(opts: { url?: unknown; sessionKey?: unknown; answer?: (signal: AbortSignal) => unknown; deadlineMs?: number } = {}) {
  const calls: Array<{ sessionKey: string; signal: AbortSignal }> = [];
  const port: StoreDirectoryPort = {
    stores(sessionKey, signal) {
      calls.push({ sessionKey, signal });
      return (opts.answer ?? (() => ({ outcome: 'stores', stores: [store(1)] })))(signal);
    },
  };
  const route = createStoreDirectoryRoute({ stores: port }, opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs });
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = { locals: out.locals, status(code: number) { out.status = code; return res; }, json(body: unknown) { out.body = body; return res; } };
  const ctx = {
    requestId: 'req-9', principal: null, session: null, authenticatedAt: null, body: undefined, trusted: null,
    sessionKey: 'sessionKey' in opts ? opts.sessionKey : SESSION_KEY,
  } as unknown as RouteContext;
  assert.ok(route.idempotency === 'none');
  await route.handler({ url: 'url' in opts ? opts.url : STORE_DIRECTORY_PATH } as unknown as Request, res as unknown as Response, ctx);
  return { out, calls };
}

function assertRefusal(out: Captured, status: number, error: string, reason: string, label: string): void {
  assert.equal(out.status, status, label);
  assert.deepEqual(out.body, { error, requestId: 'req-9' }, label);
  assert.equal(out.locals.refusal, reason, label);
}

test('handler: any query is a 400 and a missing key a 403, each before the port; a list is the exact 200', async () => {
  for (const url of [`${STORE_DIRECTORY_PATH}?`, `${STORE_DIRECTORY_PATH}?limit=1`, `${STORE_DIRECTORY_PATH}?tenantId=${TENANT}`]) {
    const { out, calls } = await run({ url });
    assertRefusal(out, 400, 'invalid_request', 'store_directory_query_invalid', url);
    assert.equal(calls.length, 0, `${url}: the port was never asked`);
  }
  const nokey = await run({ sessionKey: null });
  assertRefusal(nokey.out, 403, 'forbidden', 'authz_context_missing', 'no session key');
  assert.equal(nokey.calls.length, 0);
  const { out, calls } = await run({ answer: () => ({ outcome: 'stores', stores: [store(1), store(2, { name: null, readOnly: true })] }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionKey, SESSION_KEY, 'the chain\'s key, unchanged');
  assert.ok(calls[0].signal instanceof AbortSignal && !calls[0].signal.aborted);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { stores: [store(1), store(2, { name: null, readOnly: true })] });
  assert.deepEqual(Object.keys(out.body as object), ['stores'], 'no continuation, no count: every usable store');
  for (const entry of (out.body as { stores: object[] }).stores) assert.deepEqual(Object.keys(entry), ['id', 'tenantId', 'name', 'readOnly']);
  const empty = await run({ answer: () => ({ outcome: 'stores', stores: [] }) });
  assert.deepEqual([empty.out.status, empty.out.body], [200, { stores: [] }], 'a tenant-only actor: an empty list');
});

test('handler: denied is the generic 403, and a throw, an overrun or an out-of-shape answer a bounded 503', async () => {
  const cases: Array<[string, (signal: AbortSignal) => unknown, number, string, string]> = [
    ['denied', () => ({ outcome: 'denied' }), 403, 'forbidden', 'store_directory_denied'],
    ['a throw', () => { throw new Error('connection to db-secret.internal refused'); }, 503, 'service_unavailable', 'store_directory_unavailable'],
    ['a rejection', () => Promise.reject(new Error('password authentication failed')), 503, 'service_unavailable', 'store_directory_unavailable'],
    ['an overrun', (signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ outcome: 'stores', stores: [] })); }),
      503, 'service_unavailable', 'store_directory_timeout'],
    ['a role passed through', () => ({ outcome: 'stores', stores: [{ ...store(1), roleId: 'manager' }] }), 503, 'service_unavailable', 'store_directory_answer_invalid'],
    ['no answer', () => undefined, 503, 'service_unavailable', 'store_directory_answer_invalid'],
  ];
  for (const [label, answer, status, error, reason] of cases) {
    const { out, calls } = await run({ answer, deadlineMs: 1_000 });
    assert.equal(calls.length, 1, label);
    assertRefusal(out, status, error, reason, label);
    assert.ok(!/secret|password|manager/.test(JSON.stringify(out.body)), `${label}: nothing about the port crosses the boundary`);
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
          ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-stores', authenticatedAt: Date.now(), secondFactor: null }
          : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
    authorizer: { authorize: (...args: unknown[]) => { authorizations.push(args); return authorize(...args); } },
    store: createMemorySessionStore(),
  };
}

async function withChain(
  setup: { answer?: () => unknown; routes?: RouteDefinition[]; authorize?: (...args: unknown[]) => unknown },
  fn: (h: { calls: string[]; authorizations: unknown[][]; logs: string[]; sessionKey: string; csrf: string; cookie: string;
    get: (target?: string, headers?: Record<string, string | string[]>) => Promise<Reply>; raw: (target?: string, headers?: Record<string, string | string[]>) => Promise<Reply>;
    anon: (target?: string) => Promise<Reply> }) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const authorizations: unknown[][] = [];
  const logs: string[] = [];
  const port: StoreDirectoryPort = { stores(sessionKey) { calls.push(sessionKey); return (setup.answer ?? (() => ({ outcome: 'stores', stores: [store(1)] })))(); } };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(line); } },
    sessions: { tenant: tenantBoundary(authorizations, setup.authorize ?? (() => false)) },
    routes: [createStoreDirectoryRoute({ stores: port }), ...(setup.routes ?? [])],
    limits: testRequestLimits({}),
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
    const sessionKey = createHash('sha256').update(id).digest('base64url');
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    authorizations.length = 0;
    await fn({
      calls, authorizations, logs, sessionKey, csrf, cookie,
      get: (target = STORE_DIRECTORY_PATH, headers = {}) => request(p, 'GET', target, { cookie, [SESSION_CSRF_HEADER]: csrf, ...headers }),
      raw: (target = STORE_DIRECTORY_PATH, headers = {}) => request(p, 'GET', target, { cookie, ...headers }),
      anon: (target = STORE_DIRECTORY_PATH) => request(p, 'GET', target, {}),
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

test('over the chain: 401 without a session, 403 without the session CSRF token — both before the port — and with it the session key alone reaches the port, no authorizer asked, an exact no-store 200', async () => {
  await withChain({ answer: () => ({ outcome: 'stores', stores: [store(1), store(2, { name: null, readOnly: true })] }) }, async (h) => {
    const anon = await h.anon();
    assert.equal(anon.status, 401, anon.body);
    assert.deepEqual(Object.keys(JSON.parse(anon.body)).sort(), ['error', 'requestId']);
    for (const [label, headers] of [
      ['no session CSRF header', {}], ['another session\'s token', { [SESSION_CSRF_HEADER]: createHash('sha256').update('x').digest('base64url') }],
      ['two header lines', { [SESSION_CSRF_HEADER]: [h.csrf, h.csrf] }],
    ] as const) {
      const r = await h.raw(STORE_DIRECTORY_PATH, headers as Record<string, string | string[]>);
      assert.equal(r.status, 403, `${label}: ${r.body}`);
      assert.equal(JSON.parse(r.body).error, 'forbidden', label);
    }
    assert.equal(h.calls.length, 0, 'no refusal reached the port');
    const r = await h.get(STORE_DIRECTORY_PATH, { 'x-tenant-id': randomUUID(), 'x-store-id': randomUUID() });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(r.body), { stores: [store(1), store(2, { name: null, readOnly: true })] });
    assert.deepEqual(h.calls, [h.sessionKey], 'the presenting session\'s key, and nothing the request named');
    assert.equal(h.authorizations.length, 0, 'no authorizer runs: the route declares none');
    assert.ok(!r.body.includes(ACTOR), 'no actor in the answer');
    const query = await h.get(`${STORE_DIRECTORY_PATH}?tenant=${TENANT}`);
    assert.equal(query.status, 400, query.body);
    assert.equal(h.calls.length, 1, 'a query never reaches the port');
    for (const line of h.logs) assert.ok(!line.includes(h.sessionKey), 'no log line carries the session key');
  });
  await withChain({ answer: () => ({ outcome: 'denied' }) }, async (h) => {
    const r = await h.get();
    assert.equal(r.status, 403, r.body);
    assert.equal(h.calls.length, 1);
  });
});

// --- 5. the store templates' target through the chain (routes.ts, app.ts, access.ts) ---------------------------------------

const DRAFTS_TEMPLATE = '/api/v1/stores/{storeId}/invoice-drafts';
const DRAFT_TEMPLATE = '/api/v1/stores/{storeId}/invoice-drafts/{id}';
const storeTemplate = (path: string, seen: string[]): RouteDefinition => ({
  method: 'GET', path, policy: { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'view_invoice_drafts' } },
  body: { kind: 'none' }, idempotency: 'none', trustedContext: 'required', recentAuth: 'none', sessionBinding: 'required',
  handler: (_req, res, ctx) => { seen.push(ctx.trusted?.store ?? 'none'); res.status(204).end(); },
});
const literal = (seen: string[]): RouteDefinition => ({
  method: 'GET', path: '/api/v1/probe', policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'view_customers' } },
  body: { kind: 'none' }, idempotency: 'none', trustedContext: 'required', recentAuth: 'none',
  handler: (_req, res) => { seen.push('literal'); res.status(204).end(); },
});

test('store templates: the authorizer is handed the path\'s store as storeTarget (null for any other spelling); every other view is exactly {method, path, audience}; outside the grammar is the 404 before authentication', async () => {
  const STORE = randomUUID();
  const seen: string[] = [];
  const decided = (_principal: unknown, requirement: { scope: string }, route: { storeTarget?: unknown }) =>
    (requirement.scope === 'store' && typeof route.storeTarget === 'string'
      ? { granted: true, context: { actor: ACTOR, securityVersion: 'v1', scope: 'store', tenant: TENANT, store: route.storeTarget, membershipId: randomUUID(), roleId: 'manager', limitation: 'none' } }
      : requirement.scope === 'tenant'
        ? { granted: true, context: { actor: ACTOR, securityVersion: 'v1', scope: 'tenant', tenant: TENANT, store: null, membershipId: randomUUID(), roleId: 'manager', limitation: 'none' } }
        : false);
  await withChain({ routes: [storeTemplate(DRAFTS_TEMPLATE, seen), storeTemplate(DRAFT_TEMPLATE, seen), literal(seen)], authorize: decided }, async (h) => {
    const list = await h.get(`/api/v1/stores/${STORE}/invoice-drafts`);
    assert.equal(list.status, 204, list.body);
    assert.deepEqual(h.authorizations[0][2], { method: 'GET', path: DRAFTS_TEMPLATE, audience: 'tenant', storeTarget: STORE }, 'the template, never the raw path, and the store target');
    assert.ok(Object.isFrozen(h.authorizations[0][2]));
    const one = await h.get(`/api/v1/stores/${STORE}/invoice-drafts/${randomUUID()}`);
    assert.equal(one.status, 204, one.body);
    assert.deepEqual(h.authorizations[1][2], { method: 'GET', path: DRAFT_TEMPLATE, audience: 'tenant', storeTarget: STORE }, 'the store segment, not the draft id');
    assert.deepEqual(seen, [STORE, STORE], 'the handler sees the store the authorizer decided on');
    // Any other spelling of the store segment is a null target: the authorizer selects nothing, the generic 403.
    for (const segment of [STORE.toUpperCase(), STORE.slice(1), `${STORE}x`, '{storeId}', 'x', STORE.replace(/-/g, '%2d')]) {
      const before = h.authorizations.length;
      const r = await h.get(`/api/v1/stores/${segment}/invoice-drafts`);
      assert.equal(r.status, 403, `${segment}: ${r.body}`);
      assert.equal((h.authorizations[before][2] as { storeTarget: unknown }).storeTarget, null, segment);
    }
    // A literal route's view carries no storeTarget key at all.
    const plain = await h.get('/api/v1/probe');
    assert.equal(plain.status, 204, plain.body);
    const view = h.authorizations[h.authorizations.length - 1][2] as object;
    assert.deepEqual(Object.keys(view), ['method', 'path', 'audience'], 'byte-identical to the views before M7B');
    // Outside the template grammar: the terminal 404 before authentication (an anonymous caller learns no more than that).
    const asked = h.authorizations.length;
    for (const miss of [`/api/v1/stores/${STORE}`, `/api/v1/stores/${STORE}/invoice-drafts/`, `/api/v1/stores//invoice-drafts`, `/api/v1/stores/${STORE}/invoices`,
      `/api/v1/stores/${STORE}/invoice-drafts/${STORE}/x`]) {
      assert.equal((await h.anon(miss)).status, 404, miss);
      assert.equal((await h.get(miss)).status, 404, `${miss} (signed in)`);
    }
    assert.equal(h.authorizations.length, asked, 'no path outside the grammar reached the authorizer');
    // Inside the grammar an anonymous caller gets the 401 first, whatever the segment.
    assert.equal((await h.anon(`/api/v1/stores/x/invoice-drafts`)).status, 401);
  });
});
