// Phase 4.0 M5-GIAM-D1-P3 — the platform tenant directory through the runtime: the query and cursor contract, the
// validation of the port's untrusted answer, the route's registration, and the whole enforced chain over real loopback
// sockets — admin session, the authorizer's trusted scope, every refusal, the bounded page and its continuation.
//
// Synthetic principals, sessions and ports only. The directory port here is an in-memory stand-in; the real PostgreSQL
// adapter and migration 012 are proved in tests/db/tenantDirectory.integration, together with the canonical authorizer
// deciding View, Edit and Manage over the real resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import { SESSION_COOKIES } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import {
  TENANT_DIRECTORY_DEFAULT_LIMIT, TENANT_DIRECTORY_MAX_LIMIT, TENANT_DIRECTORY_MAX_NAME_UNITS, TENANT_DIRECTORY_PATH, TENANT_LIFECYCLE_STATUSES,
  createTenantDirectoryRoute, decodeTenantCursor, encodeTenantCursor, parseTenantDirectoryQuery, tenantDirectoryPageOf,
} from './tenantDirectory.js';
import type { PlatformPermits, TenantDirectoryPort, TenantDirectoryQuery } from './tenantDirectory.js';

const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const MEMBERSHIP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const T1 = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const BEARER = 'synthetic-admin-bearer';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'platform', tenant: null, store: null, membershipId: MEMBERSHIP, roleId: 'support_admin', limitation: 'none',
});
const GRANTED = Object.freeze({ granted: true, context: SCOPE });

/** Synthetic tenant ids in page order: canonical v4 UUIDs, distinct, generated from an index. */
const idOf = (i: number): string => `${(0x10000000 + i).toString(16)}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const tenant = (i: number, over: Record<string, unknown> = {}) =>
  ({ tenantId: idOf(i), displayName: `Tenant ${i}`, status: i % 5 === 0 ? 'suspended' : 'active', version: i + 1, ...over });

// --- 1. the query and the cursor ------------------------------------------------------------------------------------------

test('the cursor is 23 base64url characters naming one tenant, accepted only in its one canonical spelling', () => {
  const c = encodeTenantCursor(T1);
  assert.match(c, /^[A-Za-z0-9_-]{23}$/);
  assert.equal(decodeTenantCursor(c), T1, 'round trip');
  for (let i = 0; i < 40; i++) assert.equal(decodeTenantCursor(encodeTenantCursor(idOf(i))), idOf(i));
  // The last character carries 4 bits and 2 unused ones: any other spelling of the same bytes is refused.
  const last = c.at(-1) as string;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const sibling = alphabet[alphabet.indexOf(last) ^ 1];
  assert.equal(decodeTenantCursor(c.slice(0, -1) + sibling), null, 'a non-canonical spelling');
  for (const [label, bad] of [
    ['empty', ''], ['too short', c.slice(1)], ['too long', `${c}A`], ['padding', `${c}=`], ['a plus', `${c.slice(0, -1)}+`],
    ['a slash', `${c.slice(0, -1)}/`], ['a space', `${c.slice(0, -1)} `], ['a percent', `${c.slice(0, -1)}%`],
  ] as const) assert.equal(decodeTenantCursor(bad), null, label);
  // Another version byte, and 16 bytes that are no RFC 4122 identifier, are refused too.
  const bytes = Buffer.from(c, 'base64url');
  bytes[0] = 2;
  assert.equal(decodeTenantCursor(bytes.toString('base64url')), null, 'another cursor version');
  const nil = Buffer.concat([Buffer.from([1]), Buffer.alloc(16)]).toString('base64url');
  assert.equal(decodeTenantCursor(nil), null, 'the nil UUID is no tenant id');
});

test('the query takes limit and cursor at most once each, and refuses everything else before any port is asked', () => {
  const c = encodeTenantCursor(T1);
  assert.deepEqual(parseTenantDirectoryQuery(TENANT_DIRECTORY_PATH), { after: null, limit: TENANT_DIRECTORY_DEFAULT_LIMIT });
  assert.deepEqual(parseTenantDirectoryQuery(`${TENANT_DIRECTORY_PATH}?limit=1`), { after: null, limit: 1 });
  assert.deepEqual(parseTenantDirectoryQuery(`${TENANT_DIRECTORY_PATH}?limit=${TENANT_DIRECTORY_MAX_LIMIT}`), { after: null, limit: 50 });
  assert.deepEqual(parseTenantDirectoryQuery(`${TENANT_DIRECTORY_PATH}?cursor=${c}`), { after: T1, limit: 25 });
  assert.deepEqual(parseTenantDirectoryQuery(`${TENANT_DIRECTORY_PATH}?cursor=${c}&limit=7`), { after: T1, limit: 7 });
  assert.deepEqual(parseTenantDirectoryQuery(`${TENANT_DIRECTORY_PATH}?limit=7&cursor=${c}`), { after: T1, limit: 7 });
  for (const q of [
    '?', '?&', '?limit=', '?limit=0', '?limit=51', '?limit=100', '?limit=01', '?limit=-1', '?limit=1.5', '?limit=1e1', '?limit=+1', '?limit=%31',
    '?limit=1&limit=2', `?cursor=${c}&cursor=${c}`, '?cursor=', '?cursor=abc', `?cursor=${c}x`, '?LIMIT=1', '?Limit=1', '?limit',
    '?limit=1&', '?&limit=1', '?limit=1&&cursor=x', `?tenantId=${T1}`, `?limit=1&tenantId=${T1}`, '?scope=platform', '?role=system_owner',
    '?limit=1;cursor=x', '?limit=1#x', `?limit=1&x=${'a'.repeat(200)}`, `?${'limit=1&'.repeat(20)}`,
  ]) assert.equal(parseTenantDirectoryQuery(`${TENANT_DIRECTORY_PATH}${q}`), null, q);
});

// --- 2. the port's answer is untrusted ------------------------------------------------------------------------------------

const Q = (over: Partial<TenantDirectoryQuery> = {}): TenantDirectoryQuery => ({ after: null, limit: 3, ...over });

test('only an exactly shaped answer becomes a page: every field is checked and copied, and anything else is null', () => {
  const page = tenantDirectoryPageOf({ outcome: 'page', tenants: [tenant(1), tenant(2, { displayName: null })], hasMore: false }, Q());
  assert.deepEqual(page, { tenants: [tenant(1), tenant(2, { displayName: null })], hasMore: false });
  assert.deepEqual(tenantDirectoryPageOf({ outcome: 'page', tenants: [tenant(1), tenant(2), tenant(3)], hasMore: true }, Q()),
    { tenants: [tenant(1), tenant(2), tenant(3)], hasMore: true });
  assert.deepEqual(tenantDirectoryPageOf({ outcome: 'page', tenants: [], hasMore: false }, Q()), { tenants: [], hasMore: false });
  for (const status of TENANT_LIFECYCLE_STATUSES) {
    assert.ok(tenantDirectoryPageOf({ outcome: 'page', tenants: [tenant(1, { status })], hasMore: false }, Q()) !== null, status);
  }
  assert.equal(tenantDirectoryPageOf({ outcome: 'denied' }, Q()), 'denied');
  assert.equal(tenantDirectoryPageOf({ outcome: 'cursor_unknown' }, Q({ after: T1 })), 'cursor_unknown');
  const name = (n: number) => 'x'.repeat(n);
  // An array whose length reads `shown` for the first two reads and its true length after: the bound checked must be the
  // bound the copy runs to.
  const growing = (entries: unknown[], shown: number) => {
    let reads = 0;
    return new Proxy(entries, { get: (target, key, receiver) => (key === 'length' && reads++ < 2 ? shown : Reflect.get(target, key, receiver)) });
  };
  const cases: Array<[string, unknown, TenantDirectoryQuery?]> = [
    ['null', null], ['an array', []], ['a string', 'page'], ['a Map', new Map()], ['a class instance', new (class P { outcome = 'page'; })()],
    ['no outcome', { tenants: [], hasMore: false }], ['an unknown outcome', { outcome: 'ok', tenants: [], hasMore: false }],
    ['a denial with a payload', { outcome: 'denied', tenants: [] }], ['cursor_unknown without a cursor', { outcome: 'cursor_unknown' }],
    ['an extra page key', { outcome: 'page', tenants: [], hasMore: false, total: 9 }], ['no hasMore', { outcome: 'page', tenants: [] }],
    ['hasMore as a string', { outcome: 'page', tenants: [], hasMore: 'false' }], ['tenants as an object', { outcome: 'page', tenants: {}, hasMore: false }],
    ['more tenants than the limit', { outcome: 'page', tenants: [tenant(1), tenant(2), tenant(3), tenant(4)], hasMore: false }],
    ['hasMore behind a short page', { outcome: 'page', tenants: [tenant(1)], hasMore: true }],
    ['a repeated tenant', { outcome: 'page', tenants: [tenant(1), tenant(1)], hasMore: false }],
    ['the cursor\'s own tenant', { outcome: 'page', tenants: [tenant(1)], hasMore: false }, Q({ after: idOf(1) })],
    ['an extra entry key', { outcome: 'page', tenants: [{ ...tenant(1), accessVersion: '4' }], hasMore: false }],
    ['a role on an entry', { outcome: 'page', tenants: [{ ...tenant(1), roleId: 'system_owner' }], hasMore: false }],
    ['a missing entry key', { outcome: 'page', tenants: [{ tenantId: idOf(1), displayName: 'x', status: 'active' }], hasMore: false }],
    ['an uppercase id', { outcome: 'page', tenants: [tenant(10, { tenantId: idOf(10).toUpperCase() })], hasMore: false }],
    ['a non-UUID id', { outcome: 'page', tenants: [tenant(1, { tenantId: 'tenant-1' })], hasMore: false }],
    ['a numeric name', { outcome: 'page', tenants: [tenant(1, { displayName: 7 })], hasMore: false }],
    ['an overlong name', { outcome: 'page', tenants: [tenant(1, { displayName: name(TENANT_DIRECTORY_MAX_NAME_UNITS + 1) })], hasMore: false }],
    ['an unknown status', { outcome: 'page', tenants: [tenant(1, { status: 'closed' })], hasMore: false }],
    ['a capitalised status', { outcome: 'page', tenants: [tenant(1, { status: 'Active' })], hasMore: false }],
    ['version 0', { outcome: 'page', tenants: [tenant(1, { version: 0 })], hasMore: false }],
    ['version as text', { outcome: 'page', tenants: [tenant(1, { version: '2' })], hasMore: false }],
    ['version 1.5', { outcome: 'page', tenants: [tenant(1, { version: 1.5 })], hasMore: false }],
    ['version MAX_SAFE_INTEGER', { outcome: 'page', tenants: [tenant(1, { version: Number.MAX_SAFE_INTEGER })], hasMore: false }],
    ['an entry as an array', { outcome: 'page', tenants: [[idOf(1), 'x', 'active', 1]], hasMore: false }],
    ['a throwing getter', { outcome: 'page', get tenants() { throw new Error('secret'); }, hasMore: false }],
    ['a throwing proxy', new Proxy({}, { ownKeys() { throw new Error('secret'); }, getPrototypeOf() { return Object.prototype; } })],
  ];
  for (const [label, raw, query] of cases) assert.equal(tenantDirectoryPageOf(raw, query ?? Q()), null, label);
  const grown = tenantDirectoryPageOf({ outcome: 'page', tenants: growing([tenant(1), tenant(2), tenant(3), tenant(4), tenant(5)], 3), hasMore: true }, Q());
  assert.ok(grown !== null && typeof grown === 'object');
  assert.deepEqual(grown.tenants.map((t) => t.tenantId), [idOf(1), idOf(2), idOf(3)], 'a length that grows after the check never carries more than the limit');
  assert.ok(tenantDirectoryPageOf({ outcome: 'page', tenants: [tenant(1, { displayName: name(TENANT_DIRECTORY_MAX_NAME_UNITS) })], hasMore: false }, Q()) !== null,
    'a name exactly at the bound is shown as stored');
});

test('the route is a GET under the admin boundary, view_tenants at platform scope, a resolved actor required, no body and no key', () => {
  const route = createTenantDirectoryRoute({ tenantDirectory: { page: () => ({ outcome: 'page', tenants: [], hasMore: false }) }, permits: () => false });
  assert.equal(route.method, 'GET');
  assert.equal(route.path, TENANT_DIRECTORY_PATH);
  assert.deepEqual(route.policy, { access: 'session', audience: 'admin', authorization: { scope: 'platform', permission: 'view_tenants' } });
  assert.deepEqual([route.body, route.idempotency, route.trustedContext, route.recentAuth], [{ kind: 'none' }, 'none', 'required', 'none']);
  assert.ok(Object.isFrozen(route));
  assert.equal(defineRoutes([route]).list().length, 1, 'the runtime\'s own route table accepts it');
  for (const ports of [undefined, {}, { tenantDirectory: {}, permits: () => true }, { tenantDirectory: { page: () => null } }, { tenantDirectory: { page: () => null }, permits: 'yes' }]) {
    assert.throws(() => createTenantDirectoryRoute(ports as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid');
  }
  for (const deadlineMs of [0, -1, 1.5, 3_001, Number.NaN]) {
    assert.throws(() => createTenantDirectoryRoute({ tenantDirectory: { page: () => null }, permits: () => true }, { deadlineMs }),
      (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid', String(deadlineMs));
  }
});

// --- 3. the whole chain over loopback sockets -----------------------------------------------------------------------------

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string>): Promise<Reply> {
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

interface Harness {
  calls: Array<{ scope: TrustedScope; query: TenantDirectoryQuery }>;
  authorizations: unknown[][];
  logs: string[];
  get(target?: string, headers?: Record<string, string | null>): Promise<Reply>;
  send(method: string, target: string, headers?: Record<string, string>): Promise<Reply>;
}
interface Setup {
  answer?: (query: TenantDirectoryQuery, signal: AbortSignal) => unknown;
  authorize?: (...args: unknown[]) => unknown;
  permits?: PlatformPermits;
  deadlineMs?: number;
}

function adminBoundary(authorizations: unknown[][], authorize: (...args: unknown[]) => unknown): SessionBoundaryDeps {
  return {
    trustedOrigins: [ADMIN_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-directory', authenticatedAt: Date.now(), secondFactor: 'totp' }
          : null;
      },
    },
    // The administrative login attributes its session to the scope admission names (M6-ADMIN-AUDIT-P1).
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', context: SCOPE }) },
    authorizer: { authorize: (...args: unknown[]) => { authorizations.push(args); return authorize(...args); } },
    store: createMemorySessionStore(),
  };
}

async function withRoute(setup: Setup, fn: (h: Harness) => Promise<void>): Promise<void> {
  const calls: Harness['calls'] = [];
  const authorizations: unknown[][] = [];
  const logs: string[] = [];
  const port: TenantDirectoryPort = {
    page(scope, query, signal) {
      calls.push({ scope, query });
      return (setup.answer ?? (() => ({ outcome: 'page', tenants: [tenant(1)], hasMore: false })))(query, signal);
    },
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(line); } },
    sessions: { admin: adminBoundary(authorizations, setup.authorize ?? (() => GRANTED)) },
    routes: [createTenantDirectoryRoute({ tenantDirectory: port, permits: setup.permits ?? (() => false) }, { deadlineMs: setup.deadlineMs })],
    limits: testRequestLimits(),
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = (server.address() as AddressInfo).port;
    const login = await request(p, 'POST', sessionPaths('admin').login, {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
    });
    assert.equal(login.status, 200, `admin login: ${login.body}`);
    const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const id = pair.slice(pair.indexOf('=') + 1);
    const cookie = `${SESSION_COOKIES.admin}=${id}`;
    const get: Harness['get'] = (target = TENANT_DIRECTORY_PATH, headers = {}) => {
      const all: Record<string, string | null> = { cookie, ...headers };
      return request(p, 'GET', target, Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== null)));
    };
    const send: Harness['send'] = (method, target, headers = {}) => request(p, method, target, { cookie, ...headers });
    authorizations.length = 0;
    await fn({ calls, authorizations, logs, get, send });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

function assertRefusal(r: Reply, status: number, error: string, label: string): void {
  assert.equal(r.status, status, `${label}: ${r.body}`);
  const body = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], label);
  assert.equal(body.error, error, label);
}

const reasonsOf = (logs: string[]): unknown[] => logs.map((l) => (JSON.parse(l) as { reason?: unknown }).reason).filter((r) => r !== undefined);

test('no session, a denial, a bare true and an authorizer outage are refused before the port is asked', async () => {
  await withRoute({}, async (h) => {
    assertRefusal(await h.get(TENANT_DIRECTORY_PATH, { cookie: null }), 401, 'unauthenticated', 'no session');
    assertRefusal(await h.get(TENANT_DIRECTORY_PATH, { cookie: `${SESSION_COOKIES.admin}=${'A'.repeat(43)}` }), 401, 'unauthenticated', 'an unknown session');
    assert.equal(h.authorizations.length, 0, 'neither reached the authorizer');
    assert.equal(h.calls.length, 0, 'nor the port');
  });
  for (const [label, authorize, status, error] of [
    ['a denial (no view_tenants)', () => false, 403, 'forbidden'],
    ['a bare true: authorized, but no actor resolved', () => true, 403, 'forbidden'],
    ['a non-boolean answer', () => 'yes', 403, 'forbidden'],
    ['an authorizer that throws', () => { throw new Error('authz-secret-detail'); }, 503, 'service_unavailable'],
  ] as const) {
    await withRoute({ authorize }, async (h) => {
      const r = await h.get();
      assertRefusal(r, status, error, label);
      assert.ok(!r.body.includes('secret'), `${label}: no port detail crosses the boundary`);
      assert.equal(h.calls.length, 0, `${label}: the directory was never asked`);
    });
  }
});

test('the authorizer is asked for view_tenants at platform scope, and the port is handed exactly its trusted scope — nothing the request carried', async () => {
  await withRoute({}, async (h) => {
    const r = await h.get(TENANT_DIRECTORY_PATH, {
      'x-internal-user-id': 'f'.repeat(8), 'x-role': 'system_owner', 'x-tenant-id': T1, 'x-scope': 'tenant', authorization: 'Bearer forged',
    });
    assert.equal(r.status, 200, r.body);
    assert.equal(h.authorizations.length, 1);
    assert.deepEqual(h.authorizations[0][1], { scope: 'platform', permission: 'view_tenants' }, 'the declared requirement, never one the request names');
    assert.deepEqual((h.authorizations[0][2] as { path: string }).path, TENANT_DIRECTORY_PATH);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].scope, SCOPE, 'the authorizer\'s own trusted scope reaches the port, unchanged by any header');
    assert.deepEqual(h.calls[0].query, { after: null, limit: 25 });
    // A request that tries to name a tenant, a role or a scope in the query is refused outright, before the port.
    for (const q of [`?tenantId=${T1}`, '?scope=tenant', '?role=system_owner', `?limit=5&tenant=${T1}`]) {
      assertRefusal(await h.get(`${TENANT_DIRECTORY_PATH}${q}`), 400, 'invalid_request', q);
    }
    assert.equal(h.calls.length, 1, 'none of those reached the port');
  });
});

test('a 200 page carries exactly tenants, nextCursor and actions — the ids, names, statuses and versions, and nothing internal', async () => {
  const answer = () => ({ outcome: 'page', tenants: [tenant(1), tenant(2, { displayName: null, status: 'read_only' }), tenant(3)], hasMore: true });
  await withRoute({ answer, permits: (scope, permission) => scope.actor === ACTOR && scope.membershipId === MEMBERSHIP && permission === 'edit_tenant_profile' }, async (h) => {
    const r = await h.get(`${TENANT_DIRECTORY_PATH}?limit=3`);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers['cache-control'], 'no-store', 'never cached');
    assert.match(String(r.headers['content-type']), /^application\/json/);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['tenants', 'nextCursor', 'actions']);
    assert.deepEqual(body.tenants, [tenant(1), tenant(2, { displayName: null, status: 'read_only' }), tenant(3)]);
    assert.equal(decodeTenantCursor(body.nextCursor as string), idOf(3), 'the continuation names the last tenant of this page');
    assert.deepEqual(body.actions, { editDisplayName: true, changeStatus: false }, 'the canonical decision for this scope, as presentation');
    for (const word of ['access', 'witness', 'role', 'membership', 'securityVersion', 'sv-1', ACTOR, MEMBERSHIP, 'legal', 'plan']) {
      assert.ok(!r.body.includes(word), `the page carries no ${word}`);
    }
  });
  await withRoute({ answer: () => ({ outcome: 'page', tenants: [], hasMore: false }), permits: () => { throw new Error('boom'); } }, async (h) => {
    const r = await h.get();
    assert.deepEqual(JSON.parse(r.body), { tenants: [], nextCursor: null, actions: { editDisplayName: false, changeStatus: false } },
      'an empty directory, and a decision that throws presents nothing');
  });
});

test('pages walk the whole directory once: bounded, stable, never repeating a tenant, and the continuation is followed exactly', async () => {
  const all = Array.from({ length: 11 }, (_, i) => tenant(i + 1));
  // An in-memory directory ordered as migration 012 orders it; a continuation is the position after its tenant.
  const answer = (query: TenantDirectoryQuery) => {
    const start = query.after === null ? 0 : all.findIndex((t) => t.tenantId === query.after) + 1;
    if (query.after !== null && start === 0) return { outcome: 'cursor_unknown' };
    const rows = all.slice(start, start + query.limit + 1);
    return { outcome: 'page', tenants: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  };
  await withRoute({ answer }, async (h) => {
    const seen: string[] = [];
    const sizes: number[] = [];
    let target = `${TENANT_DIRECTORY_PATH}?limit=4`;
    for (let guard = 0; guard < 10; guard++) {
      const body = JSON.parse((await h.get(target)).body) as { tenants: Array<{ tenantId: string }>; nextCursor: string | null };
      sizes.push(body.tenants.length);
      seen.push(...body.tenants.map((t) => t.tenantId));
      if (body.nextCursor === null) break;
      target = `${TENANT_DIRECTORY_PATH}?limit=4&cursor=${body.nextCursor}`;
    }
    assert.deepEqual(sizes, [4, 4, 3], 'bounded pages, the last one short');
    assert.deepEqual(seen, all.map((t) => t.tenantId), 'every tenant exactly once, in order');
    // The same continuation read twice answers the same page: the order does not move under a re-read.
    const again = await h.get(`${TENANT_DIRECTORY_PATH}?limit=4&cursor=${encodeTenantCursor(idOf(4))}`);
    assert.deepEqual((JSON.parse(again.body) as { tenants: Array<{ tenantId: string }> }).tenants.map((t) => t.tenantId), [5, 6, 7, 8].map(idOf));
    // A continuation naming no tenant is a 400, not a restart from the beginning.
    assertRefusal(await h.get(`${TENANT_DIRECTORY_PATH}?cursor=${encodeTenantCursor(T1)}`), 400, 'invalid_request', 'an unknown continuation');
    assert.deepEqual(reasonsOf(h.logs).at(-1), 'tenant_directory_cursor_unknown');
  });
});

test('a malformed limit or cursor is a 400 decided before the port is asked; no other method and no body is ever served', async () => {
  await withRoute({}, async (h) => {
    for (const q of ['?limit=0', '?limit=51', '?limit=abc', '?cursor=x', `?cursor=${encodeTenantCursor(T1)}&cursor=${encodeTenantCursor(T1)}`, '?limit=1&limit=1', '?']) {
      assertRefusal(await h.get(`${TENANT_DIRECTORY_PATH}${q}`), 400, 'invalid_request', q);
    }
    assert.equal(h.calls.length, 0, 'the port was never asked');
    assert.ok(reasonsOf(h.logs).every((r) => r === 'tenant_directory_query_invalid'));
    // Only GET is registered: any other method on the path is the terminal 404, with nothing read.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await h.send(method, TENANT_DIRECTORY_PATH, { origin: ADMIN_ORIGIN, 'content-length': '0' });
      assertRefusal(r, 404, 'not_found', method);
    }
    // A GET that declares a body is refused by the route's body policy, before any port.
    const r = await h.get(TENANT_DIRECTORY_PATH, { 'content-length': '2', 'content-type': 'application/json' });
    assert.equal(r.status, 400, r.body);
    assert.equal(h.calls.length, 0);
  });
});

test('the port\'s refusals and faults are bounded: denied is the generic 403, a throw, an overrun or a malformed answer a 503 that says nothing', async () => {
  const cases: Array<[string, Setup['answer'], number, string, string]> = [
    ['denied', () => ({ outcome: 'denied' }), 403, 'forbidden', 'tenant_directory_denied'],
    ['a throw', () => { throw new Error('connection to db-secret.internal refused'); }, 503, 'service_unavailable', 'tenant_directory_unavailable'],
    ['a rejection', () => Promise.reject(new Error('password authentication failed for user secret')), 503, 'service_unavailable', 'tenant_directory_unavailable'],
    ['an overrun', (_q, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ outcome: 'page', tenants: [], hasMore: false })); }), 503, 'service_unavailable', 'tenant_directory_timeout'],
    ['a malformed answer', () => ({ outcome: 'page', tenants: [{ ...tenant(1), secret: 'x' }], hasMore: false }), 503, 'service_unavailable', 'tenant_directory_answer_invalid'],
    ['an answer of the wrong kind', () => 'SELECT * FROM tenant', 503, 'service_unavailable', 'tenant_directory_answer_invalid'],
  ];
  for (const [label, answer, status, error, reason] of cases) {
    await withRoute({ answer, deadlineMs: 50 }, async (h) => {
      const r = await h.get();
      assertRefusal(r, status, error, label);
      // The random request id is taken out first: a UUID can itself contain "db-" (e.g. "…0adb-…").
      const bodyText = r.body.replace(String(JSON.parse(r.body).requestId), '');
      assert.ok(!/secret|db-|password|SELECT|tenant_directory/.test(bodyText), `${label}: nothing about the port crosses the boundary`);
      assert.deepEqual(reasonsOf(h.logs).at(-1), reason, `${label}: the bounded reason goes to the request log alone`);
    });
  }
});
