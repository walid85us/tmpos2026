// Phase 4.0 M5-GIAM-D1-P2 — the tenant status command through the runtime: the planner's input contract, the
// route's registration, and the whole enforced chain over real loopback sockets — admin session, CSRF and
// origin, the authorizer's trusted scope, the step-up refusal, the 400 that records nothing, the command
// handed to the transaction port, every port answer including the invalid transition, replay and key reuse.
//
// Synthetic principals, keys, stores and ports only. The transaction port here is a recording stand-in whose
// lease check is the idempotency store's own; the real PostgreSQL store is proved in
// tests/db/tenantStatus.integration. Special characters are built from code points so this source stays ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import type { DurableIdempotencyStore } from './idempotency.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import type { CommandPlan, RouteDefinition } from './routes.js';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import {
  TENANT_STATUS_CONTRACT, TENANT_STATUS_EVENTS, TENANT_STATUS_PATH, TENANT_STATUS_ROUTE,
  normalizeTenantStatusReason, planTenantStatus, tenantStatusPredecessor,
} from './tenantStatus.js';

const T0 = 1_700_000_000_000;
const TENANT = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const OTHER_TENANT = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const REASON = 'Payment dispute escalated by the billing team.';
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const unit = (code: number): string => String.fromCharCode(code); // a lone UTF-16 unit, for surrogates

// --- 1. the planner's input contract ----------------------------------------------------------------------

const plan = (body: unknown) => planTenantStatus({ audience: 'admin', body, newAggregateId: randomUUID() });
/** Every code point with the Unicode Bidi_Control property, as the display-name command lists them. */
const BIDI_CONTROLS: readonly number[] = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ tenantId: TENANT, status: 'suspended', reason: REASON, expectedVersion: 3, ...over });

test('a body the contract refuses plans nothing: COMMAND_REQUEST_INVALID for every malformed shape, field, status and reason', () => {
  const invalid: Array<[string, unknown]> = [
    ['null', null], ['an array', [valid()]], ['a string', 'x'], ['a number', 1], ['undefined', undefined], ['true', true],
    ['no tenantId', { status: 'suspended', reason: REASON, expectedVersion: 1 }],
    ['no status', { tenantId: TENANT, reason: REASON, expectedVersion: 1 }],
    ['no reason', { tenantId: TENANT, status: 'suspended', expectedVersion: 1 }],
    ['no expectedVersion', { tenantId: TENANT, status: 'suspended', reason: REASON }],
    ['an extra field', valid({ extra: 1 })], ['a role', valid({ role: 'system_owner' })], ['an actor', valid({ actor: ACTOR })],
    ['a scope', valid({ scope: 'platform' })], ['a from-status the caller chose', valid({ fromStatus: 'active' })],
    ['an own __proto__ key', JSON.parse(`{"tenantId":"${TENANT}","status":"suspended","reason":"${REASON}","expectedVersion":1,"__proto__":{"x":1}}`)],
    // tenantId: canonical lowercase UUID.
    ['an uppercase tenantId', valid({ tenantId: TENANT.toUpperCase() })], ['a non-UUID tenantId', valid({ tenantId: 'not-a-uuid' })],
    ['an empty tenantId', valid({ tenantId: '' })], ['a numeric tenantId', valid({ tenantId: 123 })], ['a null tenantId', valid({ tenantId: null })],
    // status: exactly the two reachable values. The other four of 002's domain are not transitions this command makes.
    ['status read_only', valid({ status: 'read_only' })], ['status overdue', valid({ status: 'overdue' })],
    ['status trialing', valid({ status: 'trialing' })], ['status pending_activation', valid({ status: 'pending_activation' })],
    ['status provisioning', valid({ status: 'provisioning' })], ['status pending', valid({ status: 'pending' })],
    ['status Active', valid({ status: 'Active' })], ['status SUSPENDED', valid({ status: 'SUSPENDED' })],
    ['an empty status', valid({ status: '' })], ['a numeric status', valid({ status: 1 })], ['a null status', valid({ status: null })],
    // expectedVersion: a positive safe integer below MAX_SAFE_INTEGER.
    ['version 0', valid({ expectedVersion: 0 })], ['version -1', valid({ expectedVersion: -1 })], ['version 1.5', valid({ expectedVersion: 1.5 })],
    ['version "1"', valid({ expectedVersion: '1' })], ['version MAX_SAFE_INTEGER', valid({ expectedVersion: Number.MAX_SAFE_INTEGER })],
    ['version NaN', valid({ expectedVersion: Number.NaN })], ['version null', valid({ expectedVersion: null })],
    // reason: a string, 10-500 scalars once trimmed, no control character, separator or lone surrogate.
    ['a numeric reason', valid({ reason: 5 })], ['a null reason', valid({ reason: null })], ['an array reason', valid({ reason: ['A'] })],
    ['an empty reason', valid({ reason: '' })], ['a whitespace-only reason', valid({ reason: ' \t\n ' })],
    ['a 9-scalar reason', valid({ reason: 'a'.repeat(9) })], ['a 9-scalar reason after trimming', valid({ reason: `   ${'a'.repeat(9)}   ` })],
    ['a 501-scalar reason', valid({ reason: 'a'.repeat(501) })], ['501 astral scalars', valid({ reason: ch(0x1f600).repeat(501) })],
    ['an inner NUL', valid({ reason: `${'a'.repeat(10)}${ch(0)}B` })], ['a C0 control', valid({ reason: `${'a'.repeat(10)}${ch(1)}B` })],
    ['an inner newline', valid({ reason: `${'a'.repeat(10)}${ch(10)}B` })], ['an inner tab', valid({ reason: `${'a'.repeat(10)}${ch(9)}B` })],
    ['DEL', valid({ reason: `${'a'.repeat(10)}${ch(0x7f)}B` })], ['a C1 control', valid({ reason: `${'a'.repeat(10)}${ch(0x85)}B` })],
    ['a line separator', valid({ reason: `${'a'.repeat(10)}${ch(0x2028)}B` })],
    ['a paragraph separator', valid({ reason: `${'a'.repeat(10)}${ch(0x2029)}B` })],
    ['a lone high surrogate', valid({ reason: `${'a'.repeat(10)}${unit(0xd800)}B` })],
    ['a lone low surrogate', valid({ reason: `${'a'.repeat(10)}${unit(0xdc00)}` })],
    ...BIDI_CONTROLS.map((code): [string, unknown] =>
      [`Bidi_Control U+${code.toString(16).toUpperCase().padStart(4, '0')} in the reason`, valid({ reason: `${'a'.repeat(10)}${ch(code)}B` })]),
  ];
  for (const [label, body] of invalid) assert.equal(plan(body), COMMAND_REQUEST_INVALID, label);
});

test('a valid reason is trimmed at its edges and otherwise kept exactly, between its bounds', () => {
  const reasonOf = (reason: unknown): unknown => ((plan(valid({ reason })) as CommandPlan).audit as { reason: string }).reason;
  assert.equal(reasonOf(`  ${'a'.repeat(10)} `), 'a'.repeat(10), 'the shortest reason, padded, is exactly ten scalars');
  assert.equal(reasonOf('a'.repeat(500)), 'a'.repeat(500), '500 scalars');
  const astral = ch(0x1f600).repeat(500);
  assert.equal(astral.length, 1_000, '500 astral scalars are 1000 UTF-16 units');
  assert.equal(reasonOf(astral), astral, 'and are allowed');
  const unicode = `Caf${ch(0xe9)} ${ch(0x4fee, 0x7406)} ${ch(0x1f527)} closed`;
  assert.equal(reasonOf(unicode), unicode, 'accents, CJK and emoji are kept');
  assert.equal(reasonOf('Fraud  review of the account'), 'Fraud  review of the account', 'internal whitespace is kept');
  const nfd = `Cafe${ch(0x301)} closed for review`;
  assert.equal(reasonOf(nfd), nfd, 'no normalization: NFD stays NFD');
  for (const raw of [undefined, null, 1, true, {}, ['A']]) assert.equal(normalizeTenantStatusReason(raw), null, String(raw));
  assert.equal(normalizeTenantStatusReason(`  ${REASON} `), REASON);
});

test('the plan: the tenant at its expected version, the target status alone, one typed event, and the audit annex', () => {
  const suspend = plan(valid({ reason: `  ${REASON} ` })) as CommandPlan;
  assert.deepEqual(suspend, {
    aggregateId: TENANT,
    expectedVersion: 3,
    changes: { status: 'suspended' },
    events: [{ type: 'tenant.suspended', payload: { fromStatus: 'active' } }],
    response: { status: 200, body: { tenantId: TENANT, status: 'suspended', version: 4 } },
    audit: { reasonCode: 'tenant_status_active_to_suspended', reason: REASON },
  });
  assert.ok(!('unchanged' in suspend), 'a target equal to the current status is an invalid transition, never a no-op');
  const reactivate = plan(valid({ status: 'active' })) as CommandPlan;
  assert.deepEqual(reactivate.changes, { status: 'active' });
  assert.deepEqual(reactivate.events, [{ type: 'tenant.reactivated', payload: { fromStatus: 'suspended' } }]);
  assert.deepEqual(reactivate.audit, { reasonCode: 'tenant_status_suspended_to_active', reason: REASON });
  assert.deepEqual(reactivate.response, { status: 200, body: { tenantId: TENANT, status: 'active', version: 4 } });
  // The reason reaches the audit annex and nothing else: not the aggregate, not the event, not the response.
  const serialized = JSON.stringify({ changes: suspend.changes, events: suspend.events, response: suspend.response });
  assert.ok(!serialized.includes(REASON), 'the reason is in no change, event payload or response');
  // The from-status is derived, never taken: exactly the other value, for both directions.
  assert.equal(tenantStatusPredecessor('suspended'), 'active');
  assert.equal(tenantStatusPredecessor('active'), 'suspended');
  const top = plan(valid({ expectedVersion: Number.MAX_SAFE_INTEGER - 1 })) as CommandPlan;
  assert.equal((top.response.body as { version: number }).version, Number.MAX_SAFE_INTEGER, 'the largest version the runtime carries exactly');
  const other = plan(valid({ tenantId: OTHER_TENANT })) as CommandPlan;
  assert.equal(other.aggregateId, OTHER_TENANT, 'the target is the resource, never authority');
  assert.deepEqual(planTenantStatus({ audience: null, body: valid(), newAggregateId: randomUUID() }), plan(valid()),
    'the planner reads the body alone');
});

// --- 2. registration --------------------------------------------------------------------------------------

test('the route registers as one PATCH behind the admin session and change_tenant_status, requiring idempotency, a trusted context and a recent authentication', () => {
  const [route] = defineRoutes([TENANT_STATUS_ROUTE]).list();
  assert.deepEqual({
    method: route.method, path: route.path, policy: route.policy, body: route.body,
    idempotency: route.idempotency, trustedContext: route.trustedContext, recentAuth: route.recentAuth,
  }, {
    method: 'PATCH', path: '/admin/v1/tenants/status', idempotency: 'required',
    trustedContext: 'required', recentAuth: 'required',
    policy: { access: 'session', audience: 'admin', authorization: { scope: 'platform', permission: 'change_tenant_status' } },
    body: { kind: 'json', maxBytes: 8192, required: true },
  });
  assert.equal(TENANT_STATUS_PATH, route.path);
  assert.ok('command' in route && route.command.contract === TENANT_STATUS_CONTRACT && route.command.plan === planTenantStatus);
  assert.ok(Object.isFrozen(TENANT_STATUS_ROUTE));
  const [contract] = defineCommands([TENANT_STATUS_CONTRACT], defineOutboxEvents(TENANT_STATUS_EVENTS)).list();
  assert.deepEqual(contract, {
    kind: 'platform.tenant.status.change', mode: 'update', aggregateType: 'tenant',
    changes: { status: { type: 'enum', values: ['active', 'suspended'] } },
    events: [{ type: 'tenant.suspended', version: 1 }, { type: 'tenant.reactivated', version: 1 }],
  });
  assert.deepEqual(TENANT_STATUS_EVENTS.map((e) => [e.type, e.version, e.aggregateType, e.payload]), [
    ['tenant.suspended', 1, 'tenant', { fromStatus: { type: 'enum', values: ['active', 'suspended'] } }],
    ['tenant.reactivated', 1, 'tenant', { fromStatus: { type: 'enum', values: ['active', 'suspended'] } }],
  ]);
});

test('startup refuses the route without its event contracts, and without the transaction port', () => {
  const base = {
    readiness: createReadinessState(), sessions: { admin: adminBoundary({ authorizations: [] }, () => true) }, routes: [TENANT_STATUS_ROUTE],
    limits: testRequestLimits(), idempotency: { store: createMemoryIdempotencyStore(), keySecret: TEST_IDEMPOTENCY_KEY },
  };
  const transactions = { port: { commit: () => ({ outcome: 'committed' }), probe: () => true } };
  assert.throws(() => createApp({ ...base, transactions }), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_registry_invalid');
  assert.throws(() => createApp({ ...base, events: TENANT_STATUS_EVENTS }), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_transaction_required');
  assert.doesNotThrow(() => createApp({ ...base, events: TENANT_STATUS_EVENTS, transactions }));
});

test('startup refuses a state-changing route that could run without a resolved actor, or that claims a recency it cannot prove', () => {
  const setupCode = (def: unknown): string | undefined => {
    try { defineRoutes([def]); return undefined; } catch (e) { return e instanceof EnforcementSetupError ? e.code : 'other'; }
  };
  const command = TENANT_STATUS_ROUTE as unknown as Record<string, unknown>;
  // DA-31: an idempotency-required route MUST declare its trusted context; omitting it, or declaring none, fails startup.
  const without = { ...command };
  delete without.trustedContext;
  assert.equal(setupCode(without), 'route_trusted_context_invalid', 'a command route that declares no trusted context');
  assert.equal(setupCode({ ...command, trustedContext: 'none' }), 'route_trusted_context_invalid', 'a command route that declares none');
  for (const bad of ['Required', 'REQUIRED', '', true, 1, {}]) {
    assert.equal(setupCode({ ...command, trustedContext: bad }), 'route_trusted_context_invalid', JSON.stringify(bad));
  }
  // A recent authentication is bound to a SESSION: no other boundary may claim one.
  for (const bad of ['Required', '', true, 1, {}]) {
    assert.equal(setupCode({ ...command, recentAuth: bad }), 'route_recent_auth_invalid', JSON.stringify(bad));
  }
  const READ: RouteDefinition = {
    method: 'GET', path: '/admin/v1/tenants', body: { kind: 'none' }, idempotency: 'none',
    trustedContext: 'none', recentAuth: 'none', handler: () => undefined,
    policy: { access: 'session', audience: 'admin', authorization: { scope: 'platform', permission: 'view_tenants' } },
  };
  assert.equal(setupCode({ ...READ, recentAuth: 'required' }), undefined, 'a session route with a requirement may declare one');
  assert.equal(setupCode({
    method: 'POST', path: '/v1/probe', body: { kind: 'none' }, idempotency: 'none', trustedContext: 'none', recentAuth: 'required',
    policy: { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.write' } }, handler: () => undefined,
  }), 'route_recent_auth_invalid', 'a Bearer route carries no session, so no authentication time is bound to it');
});

// --- 3. the chain over real loopback sockets ---------------------------------------------------------------

const ADMIN_ORIGIN = 'http://admin.trusted.test';
const BEARER = 'tok-admin-5e2a';
const UID = 'uid-admin-5e2a';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-5e2a', scope: 'platform', tenant: null, store: null,
  membershipId: '5c4b3a29-1807-4f6e-9d5c-4b3a29180706', roleId: 'operations_admin', limitation: 'none',
});
const GRANTED = Object.freeze({ granted: true, context: SCOPE });

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
type Answer = 'committed' | 'conflict' | 'not_found' | 'invalid_state' | 'unavailable' | 'lease_lost' | 'throw';
interface Recorder { authorizations: unknown[][] }

/**
 * The provider authenticated STRICTLY BEFORE the session was issued — inside the admin login policy's own
 * five-minute window, but not equal to the login instant — so a chain that measured the session's creation
 * instead of the provider's evidence would give a different answer and these tests would fail.
 */
const AUTHENTICATED_AT = T0 - 60_000;

function adminBoundary(rec: Recorder, authorize: (...args: unknown[]) => unknown): SessionBoundaryDeps {
  return {
    trustedOrigins: [ADMIN_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: UID, authenticatedAt: AUTHENTICATED_AT, secondFactor: 'totp' }
          : null;
      },
    },
    // The administrative login attributes its session to the scope admission names (M6-ADMIN-AUDIT-P1).
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', context: SCOPE }) },
    authorizer: { authorize: (...args: unknown[]) => { rec.authorizations.push(args); return authorize(...args); } },
    store: createMemorySessionStore(),
  };
}

function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

interface Harness {
  rec: Recorder; commits: TransactionCommand[]; storeCalls: string[];
  setAnswer(answer: Answer): void;
  /** Move the server's clock; the session's bound authentication ages with it. */
  advance(ms: number): void;
  patch(over?: { body?: string; key?: string | null; headers?: Record<string, string | null> }): Promise<Reply>;
}
interface Setup { answer?: Answer; authorize?: (...args: unknown[]) => unknown; completion?: 'lease_lost' }

async function withRoute(setup: Setup, fn: (h: Harness) => Promise<void>): Promise<void> {
  const rec: Recorder = { authorizations: [] };
  const commits: TransactionCommand[] = [];
  const storeCalls: string[] = [];
  const inner = createMemoryIdempotencyStore();
  const store: DurableIdempotencyStore = {
    acquire: (r, s) => { storeCalls.push('acquire'); return inner.acquire(r, s); },
    complete: (r, s) => { storeCalls.push('complete'); return inner.complete(r, s); },
    probe: (s) => inner.probe(s),
  };
  let answer: Answer = setup.answer ?? 'committed';
  let clock = T0;
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      if (answer === 'throw') throw new Error('store-secret-detail');
      // As the store does since M5-GIAM-D1-P2-R1: each deterministic post-authorization rejection records
      // its own sealed 409 as the completion inside the same commit, so the intent is decided once. A
      // completion that does not hold rolls the whole thing back and records nothing.
      if (answer === 'conflict' || answer === 'invalid_state') {
        const sealed = answer === 'conflict' ? c.rejected.conflict : c.rejected.invalidState;
        if (sealed === null) return { outcome: 'unavailable' };
        // A completion that does not hold — a reclaimed lease, a retention that ended — rolls the whole
        // transaction back, so nothing is recorded and the lease is left exactly as it was.
        if (setup.completion === 'lease_lost') return { outcome: 'unavailable' };
        const recorded = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: sealed }), s);
        return { outcome: (recorded as { outcome?: unknown }).outcome === 'completed' ? answer : 'unavailable' };
      }
      if (answer !== 'committed') return { outcome: answer };
      const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: c.response }), s);
      return { outcome: (done as { outcome?: unknown }).outcome === 'completed' ? 'committed' : 'lease_lost' };
    },
    probe: () => true,
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, now: () => clock, log: { log: () => undefined },
    sessions: { admin: adminBoundary(rec, setup.authorize ?? (() => GRANTED)) },
    routes: [TENANT_STATUS_ROUTE], events: TENANT_STATUS_EVENTS, limits: testRequestLimits(),
    idempotency: { store, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
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
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    const patch: Harness['patch'] = ({ body = JSON.stringify(valid()), key = randomUUID(), headers = {} } = {}) => {
      const all: Record<string, string | null> = {
        origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        cookie: `${SESSION_COOKIES.admin}=${id}`, [SESSION_CSRF_HEADER]: csrf, 'idempotency-key': key,
        'content-length': String(Buffer.byteLength(body)), ...headers,
      };
      const sent = Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== null));
      return request(p, 'PATCH', TENANT_STATUS_PATH, sent, body);
    };
    storeCalls.length = 0;
    await fn({ rec, commits, storeCalls, setAnswer: (a) => { answer = a; }, advance: (ms) => { clock += ms; }, patch });
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

test('no session, a bad session CSRF, a bad origin or a denial refuses before the body is read and before any record', async () => {
  await withRoute({}, async (h) => {
    assertRefusal(await h.patch({ headers: { cookie: null } }), 401, 'unauthenticated', 'no session');
    assertRefusal(await h.patch({ headers: { [SESSION_CSRF_HEADER]: null } }), 403, 'forbidden', 'no session CSRF');
    assertRefusal(await h.patch({ headers: { [CSRF_HEADER]: null } }), 403, 'forbidden', 'no intent header');
    assertRefusal(await h.patch({ headers: { origin: 'http://evil.test' } }), 403, 'forbidden', 'a foreign origin');
    assert.equal(h.rec.authorizations.length, 0, 'none of these reached the authorizer');
    assert.deepEqual([h.storeCalls, h.commits.length], [[], 0], 'no idempotency record, no commit');
  });
  for (const [label, authorize, status, error] of [
    ['a denial', () => false, 403, 'forbidden'],
    ['a bare true: authorized, but no actor resolved', () => true, 403, 'forbidden'],
    ['a non-boolean answer', () => 'yes', 403, 'forbidden'],
    ['an authorizer that throws', () => { throw new Error('authz-secret-detail'); }, 503, 'service_unavailable'],
  ] as const) {
    await withRoute({ authorize }, async (h) => {
      const r = await h.patch();
      assertRefusal(r, status, error, label);
      assert.ok(!r.body.includes('secret'), `${label}: no port detail crosses the boundary`);
      assert.deepEqual([h.storeCalls, h.commits.length], [[], 0], `${label}: nothing acquired, nothing committed`);
    });
  }
});

test('step-up: exactly at ten minutes the bound authentication still holds; past it the command is refused and records nothing', async () => {
  await withRoute({}, async (h) => {
    // The clock reaches exactly the provider's authentication plus the window — not the session's creation
    // plus the window, which is a minute later.
    h.advance(RECENT_AUTH_MAX_AGE_MS - (T0 - AUTHENTICATED_AT));
    assert.equal((await h.patch()).status, 200, 'exactly at the bound the evidence is still recent');
    assert.equal(h.commits.length, 1);
    const acquired = h.storeCalls.filter((c) => c === 'acquire').length;
    h.advance(1);
    const stale = await h.patch();
    assertRefusal(stale, 403, 'step_up_required', 'one millisecond past the bound');
    assert.equal(h.commits.length, 1, 'the refusal committed nothing');
    assert.equal(h.storeCalls.filter((c) => c === 'acquire').length, acquired,
      'and acquired no idempotency record: the refusal stands before the key is spent');
  });
});

test('a body the contract refuses is a 400 that commits nothing', async () => {
  await withRoute({}, async (h) => {
    assertRefusal(await h.patch({ body: JSON.stringify(valid({ status: 'read_only' })) }), 400, 'invalid_request', 'a status this command never sets');
    assertRefusal(await h.patch({ body: JSON.stringify(valid({ reason: 'too short' })) }), 400, 'invalid_request', 'a nine-scalar reason');
    assertRefusal(await h.patch({ body: '{' }), 400, 'invalid_request', 'malformed JSON');
    assert.equal(h.commits.length, 0, 'no command reached the port');
  });
});

test('a committed transition answers exactly its representation, and the port receives the trusted scope, the audit annex and the step-up deadline', async () => {
  await withRoute({}, async (h) => {
    const r = await h.patch();
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { tenantId: TENANT, status: 'suspended', version: 4 });
    assert.equal(h.commits.length, 1);
    const [c] = h.commits;
    assert.deepEqual(c.mutation, {
      kind: 'platform.tenant.status.change', aggregateType: 'tenant', aggregateId: TENANT, expectedVersion: 3, changes: { status: 'suspended' },
    }, 'only the status changes');
    assert.deepEqual(c.context, SCOPE, 'the authorizer\'s own trusted scope');
    assert.notEqual(c.context, SCOPE, 'as a copy, never the authorizer\'s object');
    assert.equal(c.audit.actor, ACTOR, 'the audit names the resolved actor');
    assert.equal(c.audit.permission, 'change_tenant_status');
    assert.equal(c.audit.scope, 'platform');
    assert.equal(c.audit.reasonCode, 'tenant_status_active_to_suspended', 'the reason code names both statuses');
    assert.equal(c.audit.reason, REASON, 'the operator\'s own words reach the audit record');
    assert.equal(c.authNotAfter, AUTHENTICATED_AT + RECENT_AUTH_MAX_AGE_MS,
      'the deadline is the PROVIDER\'s authentication plus the window, never the session\'s creation');
    assert.equal(c.unchanged, null, 'this command carries no unchanged response');
    assert.match(String(c.sessionKey), /^[A-Za-z0-9_-]{43}$/, 'the presenting session\'s store key, for the transaction to hold it (M5-ADMIN-REVOKE-P1)');
    assert.equal(c.events.length, 1, 'exactly one event');
    const [e] = c.events;
    assert.deepEqual({ type: e.type, version: e.version, aggregateType: e.aggregateType, aggregateId: e.aggregateId, aggregateVersion: e.aggregateVersion, payload: e.payload },
      { type: 'tenant.suspended', version: 1, aggregateType: 'tenant', aggregateId: TENANT, aggregateVersion: 4, payload: { fromStatus: 'active' } });
    assert.equal(e.correlationId, c.audit.correlationId, 'the event and the audit share one correlation');
    assert.deepEqual([e.tenant, e.store, e.actor], [null, null, null], 'the event names no identity: the audit record does');
    assert.ok(!JSON.stringify(c.events).includes(REASON), 'no event carries the reason text');
  });
  // The other direction enqueues the other event, and only that one.
  await withRoute({}, async (h) => {
    const r = await h.patch({ body: JSON.stringify(valid({ status: 'active' })) });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { tenantId: TENANT, status: 'active', version: 4 });
    assert.deepEqual(h.commits[0].events.map((e) => [e.type, e.payload]), [['tenant.reactivated', { fromStatus: 'suspended' }]]);
    assert.equal(h.commits[0].audit.reasonCode, 'tenant_status_suspended_to_active');
  });
});

test('every unsealed port answer maps to its own bounded refusal, and no port detail crosses the boundary', async () => {
  for (const [answer, status, error] of [
    ['not_found', 404, 'not_found'],
    ['unavailable', 503, 'service_unavailable'],
    ['lease_lost', 503, 'service_unavailable'],
    ['throw', 503, 'service_unavailable'],
  ] as const) {
    await withRoute({ answer }, async (h) => {
      const r = await h.patch();
      assertRefusal(r, status, error, answer);
      assert.ok(!r.body.includes('secret'), `${answer}: no port detail crosses the boundary`);
      assert.equal(h.commits.length, 1, `${answer}: the command reached the port exactly once`);
    });
  }
});

test('each deterministic rejection is sealed in the commit that decided it: the 409 is sent once, then replayed, and the key can never mutate', async () => {
  for (const [answer, error] of [['conflict', 'write_conflict'], ['invalid_state', 'invalid_state']] as const) {
    await withRoute({ answer }, async (h) => {
      const key = randomUUID();
      const first = await h.patch({ key });
      assert.equal(first.status, 409, `${answer}: ${first.body}`);
      // The store's own record, so it carries the refusal word alone: a request ID inside it would be
      // replayed for a whole day, naming a request long over (M5-GIAM-D1-P2-R1).
      assert.deepEqual(JSON.parse(first.body), { error }, answer);
      assert.equal(first.headers['idempotent-replayed'], undefined, `${answer}: the first answer is the decision`);
      const again = await h.patch({ key });
      assert.deepEqual([again.status, again.body, again.headers['idempotent-replayed']], [409, first.body, 'true'],
        `${answer}: an identical retry replays the exact stored 409`);
      assert.equal(h.commits.length, 1, `${answer}: the replay never reached the port`);
      assertRefusal(await h.patch({ key, body: JSON.stringify(valid({ reason: 'A different reason, stated at length.' })) }), 422, 'idempotency_key_reused',
        `${answer}: the key cannot be reused for a changed request`);
      assert.equal(h.commits.length, 1, `${answer}: and it still committed exactly once`);
    });
  }
});

test('a rejection whose completion does not hold rolls the whole transaction back: a bounded 503, and the lease is left to expire', async () => {
  await withRoute({ answer: 'conflict', completion: 'lease_lost' }, async (h) => {
    const key = randomUUID();
    assertRefusal(await h.patch({ key }), 503, 'service_unavailable', 'the seal did not hold');
    const retry = await h.patch({ key });
    assert.deepEqual([retry.status, (JSON.parse(retry.body) as { error?: unknown }).error], [409, 'request_in_progress'],
      'nothing was recorded: the key waits out its lease, exactly as it did before sealing existed');
  });
});

test('an exact retry replays the recorded response byte for byte; the same key with a different transition is refused', async () => {
  await withRoute({}, async (h) => {
    const key = randomUUID();
    const first = await h.patch({ key });
    assert.equal(first.status, 200, first.body);
    const again = await h.patch({ key });
    assert.equal(again.status, 200);
    assert.equal(again.body, first.body, 'byte for byte');
    assert.equal(h.commits.length, 1, 'the replay committed nothing further');
    for (const [label, body] of [
      ['a different status', valid({ status: 'active' })],
      ['a different tenant', valid({ tenantId: OTHER_TENANT })],
      ['a different reason', valid({ reason: `${REASON} Updated.` })],
      ['a different version', valid({ expectedVersion: 4 })],
    ] as const) {
      assertRefusal(await h.patch({ key, body: JSON.stringify(body) }), 422, 'idempotency_key_reused', label);
    }
    assert.equal(h.commits.length, 1, 'no reuse reached the port');
  });
});
