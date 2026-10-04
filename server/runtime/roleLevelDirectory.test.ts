// Phase 4.0 M7A-CUSTOMERS-P3-R2 — the owner's read-back of the built-in Customers role levels through the runtime: the
// validation of the port's untrusted answer, the route's declaration, the handler's every outcome, and the enforced chain
// over a real loopback socket on the TENANT boundary — the session, the authorizer's owner requirement, the trusted tenant.
//
// Since M7A-CUSTOMERS-P4 every record carries `version`: null for the owner, 021's edit counter for an editable role.
//
// Synthetic principals, sessions and ports only. The PostgreSQL read is proved database-free in
// server/composition/productionTransactions.test.ts (M7TK-03) and end to end in tests/db/roleLevels.integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import type { RouteContext } from './routes.js';
import {
  INVOICE_ROLE_LEVEL_DIRECTORY_PATH, ROLE_LEVEL_DIRECTORY_PATH, createInvoiceRoleLevelDirectoryRoute, createRoleLevelDirectoryRoute, roleLevelDirectoryOf,
} from './roleLevelDirectory.js';
import type { RoleLevelDirectoryPort } from './roleLevelDirectory.js';

const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const MEMBERSHIP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const T1 = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const T2 = '44444444-4444-4444-8444-444444444444';
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-owner-bearer';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: T1, store: null, membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
});

/** The port's answer in its one valid shape: the owner first, then the three editable roles. */
const answer = (manager: string | null = null, technician: string | null = 'none', sales: string | null = null) => [
  { roleId: 'store_owner', stored: null, defaultLevel: 'full', version: null },
  { roleId: 'manager', stored: manager, defaultLevel: 'full', version: 0 },
  { roleId: 'technician', stored: technician, defaultLevel: 'view', version: 2 },
  { roleId: 'sales_staff', stored: sales, defaultLevel: 'create', version: 0 },
];
const VIEW = [
  { roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null },
  { roleId: 'manager', level: 'full', defaultLevel: 'full', source: 'default', editable: true, version: 0 },
  { roleId: 'technician', level: 'none', defaultLevel: 'view', source: 'stored', editable: true, version: 2 },
  { roleId: 'sales_staff', level: 'create', defaultLevel: 'create', source: 'default', editable: true, version: 0 },
];

// --- 1. the port's answer is untrusted ------------------------------------------------------------------------------------

test('only the exact four-role answer becomes a response: level = stored ?? default, the source named, everything else null', () => {
  const view = roleLevelDirectoryOf(answer());
  assert.deepEqual(view, VIEW);
  assert.ok(view !== null && Object.isFrozen(view) && view.every((r) => Object.isFrozen(r)));
  // A stored level equal to the default is still an override: 'stored'.
  assert.deepEqual(roleLevelDirectoryOf(answer(null, null, 'create'))?.[3], { roleId: 'sales_staff', level: 'create', defaultLevel: 'create', source: 'stored', editable: true, version: 0 });
  // A version is handed through as it is: the largest safe one included.
  assert.equal(roleLevelDirectoryOf([answer()[0], { ...answer()[1], version: Number.MAX_SAFE_INTEGER }, answer()[2], answer()[3]])?.[1].version, Number.MAX_SAFE_INTEGER);
  const owner = answer()[0];
  const bad: Array<[string, unknown]> = [
    ['null', null], ['an object', { roles: answer() }], ['three roles', answer().slice(1)], ['five roles', [...answer(), answer()[1]]],
    ['the owner missing', [answer()[1], ...answer().slice(1)]], ['the owner stored', [{ ...owner, stored: 'view' }, ...answer().slice(1)]],
    ['the owner an editable role', [{ ...owner, roleId: 'manager' }, ...answer().slice(1)]],
    ['the owner not a role word', [{ ...owner, roleId: 'Store Owner' }, ...answer().slice(1)]],
    // AM8: the owner's record is pinned whole — another role word, a lower or unknown fixed level, or a stored level is out.
    ['the owner another role word', [{ ...owner, roleId: 'owner' }, ...answer().slice(1)]],
    ['the owner a custom role word', [{ ...owner, roleId: 'store_owner_2' }, ...answer().slice(1)]],
    ['the owner below Full', [{ ...owner, defaultLevel: 'view' }, ...answer().slice(1)]],
    ['the owner at manage', [{ ...owner, defaultLevel: 'manage' }, ...answer().slice(1)]],
    ['the owner at no default', [{ roleId: 'store_owner', stored: null, version: null }, ...answer().slice(1)]],
    // M7A-CUSTOMERS-P4: the owner is never versioned, and every editable role is — a safe integer of at least 0.
    ['the owner versioned', [{ ...owner, version: 0 }, ...answer().slice(1)]], ['the owner without a version', [{ roleId: 'store_owner', stored: null, defaultLevel: 'full' }, ...answer().slice(1)]],
    ['an editable role without a version', [owner, { roleId: 'manager', stored: null, defaultLevel: 'full' }, answer()[2], answer()[3]]],
    ['a null version', [owner, { ...answer()[1], version: null }, answer()[2], answer()[3]]], ['a negative version', [owner, answer()[1], answer()[2], { ...answer()[3], version: -1 }]],
    ['a fractional version', [owner, answer()[1], { ...answer()[2], version: 1.5 }, answer()[3]]], ['a version as text', [owner, answer()[1], { ...answer()[2], version: '2' }, answer()[3]]],
    ['an unsafe version', [owner, { ...answer()[1], version: 2 ** 53 }, answer()[2], answer()[3]]], ['a bigint version', [owner, { ...answer()[1], version: 1n }, answer()[2], answer()[3]]],
    ['the owner stored at Full', [{ ...owner, stored: 'full' }, ...answer().slice(1)]],
    ['the owner stored undefined', [{ ...owner, stored: undefined }, ...answer().slice(1)]],
    ['the owner with an extra field', [{ ...owner, editable: false }, ...answer().slice(1)]],
    ['the owner last', [...answer().slice(1), owner]],
    ['the owner twice', [owner, owner, answer()[2], answer()[3]]],
    ['roles out of order', [owner, answer()[2], answer()[1], answer()[3]]],
    ['an unknown role', [owner, answer()[1], answer()[2], { ...answer()[3], roleId: 'cashier' }]],
    ['a level outside the seven', answer('owner')], ['a level in another case', answer('View')], ['a numeric level', answer(3 as never)],
    ['no default', [owner, { roleId: 'manager', stored: null, version: 0 }, answer()[2], answer()[3]]],
    ['a default outside the seven', [owner, { ...answer()[1], defaultLevel: 'all' }, answer()[2], answer()[3]]],
    ['an undefined stored level', [owner, { ...answer()[1], stored: undefined }, answer()[2], answer()[3]]],
    ['an extra field', [owner, { ...answer()[1], tenant: T2 }, answer()[2], answer()[3]]],
    ['a class instance', [owner, new (class R { roleId = 'manager'; stored = null; defaultLevel = 'full'; version = 0; })(), answer()[2], answer()[3]]],
    ['a throwing getter', [owner, { roleId: 'manager', stored: null, version: 0, get defaultLevel(): string { throw new Error('x'); } }, answer()[2], answer()[3]]],
  ];
  for (const [label, raw] of bad) assert.equal(roleLevelDirectoryOf(raw), null, label);
});

// --- 2. the route ---------------------------------------------------------------------------------------------------------

test('the route is a GET on the edit\'s path under the tenant boundary, the owner rule (edit_role_levels), a resolved scope, no body, no key, no step-up', () => {
  const route = createRoleLevelDirectoryRoute({ roleLevels: { levels: () => answer() } });
  assert.equal(ROLE_LEVEL_DIRECTORY_PATH, '/api/v1/roles/levels');
  assert.deepEqual([route.method, route.path], ['GET', '/api/v1/roles/levels']);
  assert.deepEqual(route.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'edit_role_levels' } });
  assert.deepEqual([route.body, route.idempotency, route.trustedContext, route.recentAuth, route.sessionBinding], [{ kind: 'none' }, 'none', 'required', 'none', undefined]);
  assert.ok(Object.isFrozen(route) && Object.isFrozen(route.policy) && Object.isFrozen(route.body));
  assert.equal(defineRoutes([route]).list().length, 1, 'the runtime\'s own route table accepts it');
  for (const ports of [undefined, null, {}, { roleLevels: null }, { roleLevels: {} }, { roleLevels: { levels: 'yes' } }, { customers: { page: () => null } }]) {
    assert.throws(() => createRoleLevelDirectoryRoute(ports as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid', JSON.stringify(ports));
  }
  for (const deadlineMs of [0, 3_001, 1.5]) {
    assert.throws(() => createRoleLevelDirectoryRoute({ roleLevels: { levels: () => null } }, { deadlineMs }),
      (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid', String(deadlineMs));
  }
});

// --- 3. the handler, called directly ---------------------------------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }

async function run(opts: { url?: unknown; trusted?: unknown; answer?: (tenant: string, signal: AbortSignal) => unknown } = {}) {
  const calls: string[] = [];
  const port: RoleLevelDirectoryPort = { levels: (tenant, signal) => { calls.push(tenant); return (opts.answer ?? (() => answer()))(tenant, signal); } };
  const route = createRoleLevelDirectoryRoute({ roleLevels: port }, { deadlineMs: 1_000 });
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = { locals: out.locals, status(code: number) { out.status = code; return res; }, json(body: unknown) { out.body = body; return res; } };
  const ctx = { requestId: 'req-9', principal: null, session: null, authenticatedAt: null, body: undefined, sessionKey: null,
    trusted: 'trusted' in opts ? opts.trusted : SCOPE } as unknown as RouteContext;
  assert.ok(route.idempotency === 'none');
  await route.handler({ url: 'url' in opts ? opts.url : ROLE_LEVEL_DIRECTORY_PATH } as unknown as Request, res as unknown as Response, ctx);
  return { out, calls };
}

function refused(out: Captured, status: number, error: string, reason: string, label: string): void {
  assert.equal(out.status, status, label);
  assert.deepEqual(out.body, { error, requestId: 'req-9' }, label);
  assert.equal(out.locals.refusal, reason, label);
}

test('the port is handed the trusted scope\'s tenant alone, and a 200 is exactly { tenant, domain, roles }', async () => {
  const { out, calls } = await run();
  assert.deepEqual(calls, [T1]);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { tenant: T1, domain: 'customers', roles: VIEW });
  assert.equal(out.locals.refusal, undefined);
});

test('any query is a 400 and no resolved tenant scope a 403, both before the port is asked', async () => {
  for (const url of [`${ROLE_LEVEL_DIRECTORY_PATH}?`, `${ROLE_LEVEL_DIRECTORY_PATH}?tenantId=${T2}`, `${ROLE_LEVEL_DIRECTORY_PATH}?role=store_owner`]) {
    const { out, calls } = await run({ url });
    refused(out, 400, 'invalid_request', 'role_level_directory_query_invalid', url);
    assert.equal(calls.length, 0, url);
  }
  for (const [label, trusted] of [['no scope', null], ['a platform scope', { ...SCOPE, scope: 'platform', tenant: null }],
    ['a store scope', { ...SCOPE, scope: 'store' }], ['no tenant', { ...SCOPE, tenant: null }]] as const) {
    const { out, calls } = await run({ trusted });
    refused(out, 403, 'forbidden', 'authz_context_missing', label);
    assert.equal(calls.length, 0, label);
  }
});

test('a throw, an overrun or an out-of-shape answer is a bounded 503 that carries nothing of the port', async () => {
  const cases: Array<[string, (t: string, s: AbortSignal) => unknown, string]> = [
    ['a throw', () => { throw new Error('connection to db-secret.internal refused'); }, 'role_level_directory_unavailable'],
    ['a rejection', () => Promise.reject(new Error('password authentication failed')), 'role_level_directory_unavailable'],
    ['an overrun', (_t, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve(answer())); }), 'role_level_directory_timeout'],
    ['another tenant\'s shape', () => ({ tenant: T2, roles: answer() }), 'role_level_directory_answer_invalid'],
    ['an unknown default', () => [answer()[0], { ...answer()[1], defaultLevel: undefined }, answer()[2], answer()[3]], 'role_level_directory_answer_invalid'],
    ['a malformed owner entry', () => [{ ...answer()[0], defaultLevel: 'view' }, ...answer().slice(1)], 'role_level_directory_answer_invalid'],
    ['another owner word', () => [{ ...answer()[0], roleId: 'owner' }, ...answer().slice(1)], 'role_level_directory_answer_invalid'],
  ];
  for (const [label, port, reason] of cases) {
    const { out } = await run({ answer: port });
    refused(out, 503, 'service_unavailable', reason, label);
    assert.ok(!/secret|password|T2|4444/.test(JSON.stringify(out.body)), `${label}: nothing about the port crosses the boundary`);
  }
});

// --- 4. the whole chain over a loopback socket, on the tenant boundary ------------------------------------------------------

function request(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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

test('over the enforced chain: the authorizer is asked for edit_role_levels, only its tenant reaches the port, no-store; a denial never reaches it', async () => {
  for (const [label, authorize, expected] of [
    ['the owner', () => ({ granted: true, context: SCOPE }), 200],
    ['a denial (a manager)', () => false, 403],
  ] as const) {
    const calls: string[] = [];
    const authorizations: unknown[][] = [];
    const readiness = createReadinessState();
    readiness.setReady();
    const app = createApp({
      readiness,
      sessions: { tenant: {
        trustedOrigins: [TENANT_ORIGIN],
        verifier: { async verify(c) { return c.bearerToken === BEARER ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-owner', authenticatedAt: Date.now(), secondFactor: null } : null; } },
        admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
        authorizer: { authorize: (...args: unknown[]) => { authorizations.push(args); return authorize(); } },
        store: createMemorySessionStore(),
      } },
      routes: [createRoleLevelDirectoryRoute({ roleLevels: { levels: (tenant) => { calls.push(tenant); return answer(); } } })],
      limits: testRequestLimits(),
    });
    const server = createBoundedServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const p = (server.address() as AddressInfo).port;
      const login = await request(p, 'POST', sessionPaths('tenant').login, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
      });
      assert.equal(login.status, 200, login.body);
      const cookie = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
      authorizations.length = 0;
      const r = await request(p, 'GET', ROLE_LEVEL_DIRECTORY_PATH, { cookie, 'x-tenant-id': T2, 'x-role': 'store_owner' });
      assert.equal(r.status, expected, `${label}: ${r.body}`);
      assert.equal(r.headers['cache-control'], 'no-store', `${label}: never cached`);
      assert.deepEqual(authorizations.map((a) => a[1]), [{ scope: 'tenant', permission: 'edit_role_levels' }], `${label}: the declared requirement`);
      if (expected === 200) {
        assert.deepEqual(JSON.parse(r.body), { tenant: T1, domain: 'customers', roles: VIEW });
        assert.deepEqual(calls, [T1], 'the authorizer\'s tenant, never a header\'s');
        for (const word of [ACTOR, MEMBERSHIP, 'sv-1', T2]) assert.ok(!r.body.includes(word), `the answer carries no ${word}`);
      } else {
        assert.deepEqual(calls, [], `${label}: the port was never asked`);
      }
      const anonymous = await request(p, 'GET', ROLE_LEVEL_DIRECTORY_PATH, {});
      assert.equal(anonymous.status, 401, `${label}: no session`);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  }
});

// --- 5. M5-INVOICES-AUTH-P1: the Invoices sibling (configuration only), same rules, its own path, port and domain --------------

async function runInvoices(opts: { url?: unknown; trusted?: unknown; answer?: (tenant: string, signal: AbortSignal) => unknown } = {}) {
  const calls: string[] = [];
  const route = createInvoiceRoleLevelDirectoryRoute({
    invoiceRoleLevels: { levels: (tenant, signal) => { calls.push(tenant); return (opts.answer ?? (() => answer()))(tenant, signal); } },
  }, { deadlineMs: 1_000 });
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = { locals: out.locals, status(code: number) { out.status = code; return res; }, json(body: unknown) { out.body = body; return res; } };
  const ctx = { requestId: 'req-9', principal: null, session: null, authenticatedAt: null, body: undefined, sessionKey: null,
    trusted: 'trusted' in opts ? opts.trusted : SCOPE } as unknown as RouteContext;
  assert.ok(route.idempotency === 'none');
  await route.handler({ url: 'url' in opts ? opts.url : INVOICE_ROLE_LEVEL_DIRECTORY_PATH } as unknown as Request, res as unknown as Response, ctx);
  return { out, calls };
}

test('the Invoices route is its own literal GET under the same owner rule, body, key and step-up requirements, built from its own port alone', () => {
  const route = createInvoiceRoleLevelDirectoryRoute({ invoiceRoleLevels: { levels: () => answer() } });
  assert.equal(INVOICE_ROLE_LEVEL_DIRECTORY_PATH, '/api/v1/roles/levels/invoices');
  assert.deepEqual([route.method, route.path], ['GET', '/api/v1/roles/levels/invoices']);
  assert.deepEqual(route.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'edit_role_levels' } });
  assert.deepEqual([route.body, route.idempotency, route.trustedContext, route.recentAuth, route.sessionBinding], [{ kind: 'none' }, 'none', 'required', 'none', undefined]);
  assert.ok(Object.isFrozen(route) && Object.isFrozen(route.policy) && Object.isFrozen(route.body));
  const customers = createRoleLevelDirectoryRoute({ roleLevels: { levels: () => answer() } });
  assert.equal(defineRoutes([customers, route]).list().length, 2, 'both read-backs sit in one route table');
  // Neither route can be built from the other's port.
  for (const ports of [undefined, null, {}, { roleLevels: { levels: () => answer() } }, { invoiceRoleLevels: {} }, { invoiceRoleLevels: { levels: 'yes' } }]) {
    assert.throws(() => createInvoiceRoleLevelDirectoryRoute(ports as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid', JSON.stringify(ports));
  }
  assert.throws(() => createRoleLevelDirectoryRoute({ invoiceRoleLevels: { levels: () => answer() } } as never), (e: unknown) => e instanceof EnforcementSetupError);
  assert.throws(() => createInvoiceRoleLevelDirectoryRoute({ invoiceRoleLevels: { levels: () => null } }, { deadlineMs: 0 }),
    (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid');
});

test('the Invoices 200 is exactly { tenant, domain: "invoices", roles } with the stored, default and fixed sources; the Customers answer is unchanged', async () => {
  const { out, calls } = await runInvoices({ answer: () => answer('edit', null, null) });
  assert.deepEqual(calls, [T1]);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { tenant: T1, domain: 'invoices', roles: [
    VIEW[0],
    { roleId: 'manager', level: 'edit', defaultLevel: 'full', source: 'stored', editable: true, version: 0 },
    { roleId: 'technician', level: 'view', defaultLevel: 'view', source: 'default', editable: true, version: 2 },
    { roleId: 'sales_staff', level: 'create', defaultLevel: 'create', source: 'default', editable: true, version: 0 },
  ] }, 'owner fixed Full; manager Full / technician View / sales_staff Create by default');
  const customers = await run();
  assert.deepEqual(customers.out.body, { tenant: T1, domain: 'customers', roles: VIEW });
});

test('the Invoices route: any query is a 400, no tenant scope a 403, a throw, overrun or malformed answer a bounded 503 — never the port first', async () => {
  for (const url of [`${INVOICE_ROLE_LEVEL_DIRECTORY_PATH}?`, `${INVOICE_ROLE_LEVEL_DIRECTORY_PATH}?domain=customers`]) {
    const { out, calls } = await runInvoices({ url });
    refused(out, 400, 'invalid_request', 'role_level_directory_query_invalid', url);
    assert.equal(calls.length, 0, url);
  }
  for (const trusted of [null, { ...SCOPE, scope: 'platform', tenant: null }, { ...SCOPE, scope: 'store' }, { ...SCOPE, tenant: null }]) {
    const { out, calls } = await runInvoices({ trusted });
    refused(out, 403, 'forbidden', 'authz_context_missing', JSON.stringify(trusted));
    assert.equal(calls.length, 0);
  }
  const cases: Array<[string, (t: string, s: AbortSignal) => unknown, string]> = [
    ['a throw', () => { throw new Error('connection to db-secret.internal refused'); }, 'role_level_directory_unavailable'],
    ['an overrun', (_t, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve(answer())); }), 'role_level_directory_timeout'],
    ['three roles', () => answer().slice(1), 'role_level_directory_answer_invalid'],
    ['a stored level outside the seven', () => answer('owner'), 'role_level_directory_answer_invalid'],
    ['a malformed owner entry', () => [{ ...answer()[0], defaultLevel: 'view' }, ...answer().slice(1)], 'role_level_directory_answer_invalid'],
    ['an unsafe version', () => [answer()[0], { ...answer()[1], version: 2 ** 53 }, answer()[2], answer()[3]], 'role_level_directory_answer_invalid'],
    ['null', () => null, 'role_level_directory_answer_invalid'],
  ];
  for (const [label, port, reason] of cases) {
    const { out } = await runInvoices({ answer: port });
    refused(out, 503, 'service_unavailable', reason, label);
    assert.ok(!/secret|password/.test(JSON.stringify(out.body)), label);
  }
});

test('over the enforced chain the Invoices read-back asks edit_role_levels: the owner reaches the port with the authorizer\'s tenant, a denial never does', async () => {
  for (const [label, authorize, expected] of [
    ['the owner', () => ({ granted: true, context: SCOPE }), 200],
    ['a denial (a manager)', () => false, 403],
  ] as const) {
    const calls: string[] = [];
    const authorizations: unknown[][] = [];
    const readiness = createReadinessState();
    readiness.setReady();
    const app = createApp({
      readiness,
      sessions: { tenant: {
        trustedOrigins: [TENANT_ORIGIN],
        verifier: { async verify(c) { return c.bearerToken === BEARER ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-owner', authenticatedAt: Date.now(), secondFactor: null } : null; } },
        admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
        authorizer: { authorize: (...args: unknown[]) => { authorizations.push(args); return authorize(); } },
        store: createMemorySessionStore(),
      } },
      routes: [createInvoiceRoleLevelDirectoryRoute({ invoiceRoleLevels: { levels: (tenant) => { calls.push(tenant); return answer(); } } })],
      limits: testRequestLimits(),
    });
    const server = createBoundedServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const p = (server.address() as AddressInfo).port;
      const login = await request(p, 'POST', sessionPaths('tenant').login, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
      });
      assert.equal(login.status, 200, login.body);
      const cookie = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
      authorizations.length = 0;
      const r = await request(p, 'GET', INVOICE_ROLE_LEVEL_DIRECTORY_PATH, { cookie, 'x-tenant-id': T2 });
      assert.equal(r.status, expected, `${label}: ${r.body}`);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.deepEqual(authorizations.map((a) => a[1]), [{ scope: 'tenant', permission: 'edit_role_levels' }], label);
      if (expected === 200) {
        assert.deepEqual(JSON.parse(r.body), { tenant: T1, domain: 'invoices', roles: VIEW });
        assert.deepEqual(calls, [T1]);
      } else {
        assert.deepEqual(calls, []);
      }
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  }
});
