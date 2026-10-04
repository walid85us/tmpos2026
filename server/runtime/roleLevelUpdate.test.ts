// Phase 4.0 M7A-CUSTOMERS-P3-R1 — an owner's durable role-level edit through the runtime: the planner's input contract and
// its reason rule, the vocabulary's parity with the catalog, the route's and the contract's registration, and the enforced
// chain over real loopback sockets on the TENANT boundary — session, CSRF, step-up, the authorizer's trusted scope, the
// command handed to the transaction port (its deadline and session included), replay, and the bounded refusals. Since
// M7A-CUSTOMERS-P4 the six-field body (the asserted tenant and version, preconditions only), the 200's committed version,
// and the store's 'precondition_failed' answered as an UNSEALED 409 write_conflict that records nothing.
//
// Synthetic principals, sessions, keys and ports only. The transaction port here is a recording stand-in whose lease check
// is the idempotency store's own; the owner rule is m5CanonicalPermissions.test.ts's, and the PostgreSQL store, the tenant
// revalidator and migration 020 are proved elsewhere (server/composition, server/persistence, tests/db).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { createIdempotencyKeyring } from './idempotency.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import {
  EDITABLE_TENANT_ROLES, ROLE_LEVELS, ROLE_LEVELS_PATH, ROLE_LEVELS_PERMISSION, ROLE_LEVEL_DOMAINS, ROLE_LEVEL_UPDATE_CONTRACT,
  ROLE_LEVEL_UPDATE_ROUTE, normalizeRoleLevelReason, planRoleLevelUpdate,
} from './roleLevelUpdate.js';
import { COMMAND_REQUEST_INVALID, defineRoutes, sessionPaths } from './routes.js';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import { normalizeTenantStatusReason } from './tenantStatus.js';
import { PERMISSION_TOKENS, TENANT_OWNER_ROLE_ID, TENANT_PERMISSION_DOMAINS } from '../platform-identity/permissionCatalog.js';
import { TENANT_ROLE_IDS } from '../platform-identity/authorizationConstants.js';
import { TENANT_ROUTE_PERMISSIONS } from '../platform-identity/m5CanonicalPermissions.js';

const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const MEMBERSHIP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const T1 = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const T2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: T1, store: null, membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
});
const REASON = 'Sales staff no longer onboard customers.';
const BODY = Object.freeze({ roleId: 'sales_staff', domain: 'customers', level: 'view', reason: REASON, expectedTenant: T1, expectedVersion: 3 });
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const plan = (body: unknown) => planRoleLevelUpdate({ audience: 'tenant', body, newAggregateId: randomUUID() });

// --- 1. the vocabulary, the reason and the planner -----------------------------------------------------------------------

test('the vocabulary is the catalog\'s: the seven levels, every built-in tenant role but the owner, and the domains a level-decided route names', () => {
  assert.deepEqual([...ROLE_LEVELS], [...PERMISSION_TOKENS].sort(), 'the seven canonical level words, as a sorted vocabulary — never an ordering');
  assert.deepEqual([...EDITABLE_TENANT_ROLES], TENANT_ROLE_IDS.filter((r) => r !== TENANT_OWNER_ROLE_ID), 'the owner role is never editable');
  // Every domain the server DECIDES is stored; Invoices is stored as configuration only (M5-INVOICES-AUTH-P1: no route decides on it).
  const decidedDomains = [...new Set([...TENANT_ROUTE_PERMISSIONS.values()].filter((e) => !e.sensitive).map((e) => e.parent))];
  assert.deepEqual(decidedDomains, ['customers'], 'the one domain a route decides');
  assert.deepEqual([...ROLE_LEVEL_DOMAINS], [...decidedDomains, 'invoices'], 'the decided domain, then Invoices (configuration only)');
  assert.ok(![...TENANT_ROUTE_PERMISSIONS.values()].some((e) => e.parent === 'invoices'), 'no invoice route permission exists to enforce it');
  for (const domain of ROLE_LEVEL_DOMAINS) assert.ok(TENANT_PERMISSION_DOMAINS.includes(domain), domain);
  for (const list of [ROLE_LEVELS, EDITABLE_TENANT_ROLES, ROLE_LEVEL_DOMAINS]) assert.ok(Object.isFrozen(list));
});

test('the reason is the tenant status command\'s rule exactly: trimmed, 10-500 scalars, no control, separator, lone surrogate or Bidi_Control', () => {
  const samples: unknown[] = [
    REASON, `  ${REASON}  `, 'a'.repeat(9), 'a'.repeat(10), 'a'.repeat(500), 'a'.repeat(501), ch(0x1f600).repeat(10), ch(0x1f600).repeat(501),
    `${REASON}\n`, `ten chars${ch(0)}!`, `ten chars${ch(0x85)}!`, `ten chars${ch(0x2028)}!`, `ten chars${ch(0x202e)}!`, `ten chars${String.fromCharCode(0xd800)}!`,
    '', '          ', 10, null, undefined, ['a reason of words'], { toString: () => REASON },
  ];
  for (const raw of samples) assert.equal(normalizeRoleLevelReason(raw), normalizeTenantStatusReason(raw), JSON.stringify(raw)?.slice(0, 40));
  assert.equal(normalizeRoleLevelReason(`  ${REASON}  `), REASON, 'trimmed');
  // Every code point below U+10000 inside a valid reason: refused exactly where the status command refuses.
  const wrong: number[] = [];
  for (let c = 0; c <= 0xffff; c++) {
    const s = `reason ${String.fromCharCode(c)} here`;
    if (normalizeRoleLevelReason(s) !== normalizeTenantStatusReason(s)) wrong.push(c);
  }
  assert.deepEqual(wrong, []);
});

test('the plan: the runtime\'s new id, no store version, the edit and its two preconditions as the change, no event, a 200 naming the stored level at the next version, and the audit annex', () => {
  const newAggregateId = randomUUID();
  assert.deepEqual(planRoleLevelUpdate({ audience: 'tenant', body: { ...BODY, reason: ` ${REASON} ` }, newAggregateId }), {
    aggregateId: newAggregateId, expectedVersion: null,
    changes: { roleId: 'sales_staff', domain: 'customers', level: 'view', expectedTenant: T1, expectedVersion: 3 }, events: [],
    response: { status: 200, body: { roleLevel: { roleId: 'sales_staff', domain: 'customers', level: 'view', version: 4 } } },
    audit: { reasonCode: 'role_sales_staff_customers_to_view', reason: REASON },
  });
  // A never-edited role is version 0 and commits at 1; any tenant id the database renders — any UUID version — is accepted.
  for (const [expectedTenant, expectedVersion] of [[T1, 0], [T2, Number.MAX_SAFE_INTEGER - 1], ['00000000-0000-0000-0000-000000000000', 7]] as const) {
    const p = plan({ ...BODY, expectedTenant, expectedVersion }) as { changes: Record<string, unknown>; response: { body: { roleLevel: { version: number } } } };
    assert.deepEqual([p.changes.expectedTenant, p.changes.expectedVersion, p.response.body.roleLevel.version], [expectedTenant, expectedVersion, expectedVersion + 1]);
  }
  for (const roleId of EDITABLE_TENANT_ROLES) for (const level of ROLE_LEVELS) {
    const p = plan({ ...BODY, roleId, level });
    assert.notEqual(p, COMMAND_REQUEST_INVALID, `${roleId}/${level}`);
    assert.equal((p as { audit: { reasonCode: string } }).audit.reasonCode, `role_${roleId}_customers_to_${level}`);
  }
});

test('Invoices is accepted for every editable role and level; its reason code and body bytes differ from a Customers edit; unknown domains and roles stay refused', () => {
  const INVOICES_BODY = { ...BODY, domain: 'invoices' };
  for (const roleId of EDITABLE_TENANT_ROLES) for (const level of ROLE_LEVELS) {
    const p = plan({ ...INVOICES_BODY, roleId, level }) as { changes: Record<string, unknown>; audit: { reasonCode: string }; response: { body: unknown } };
    assert.notEqual(p, COMMAND_REQUEST_INVALID, `${roleId}/${level}`);
    assert.equal(p.audit.reasonCode, `role_${roleId}_invoices_to_${level}`);
    assert.equal(p.changes.domain, 'invoices');
  }
  const customers = plan(BODY) as { audit: { reasonCode: string }; response: { body: unknown } };
  const invoices = plan(INVOICES_BODY) as { audit: { reasonCode: string }; response: { body: unknown } };
  assert.notEqual(invoices.audit.reasonCode, customers.audit.reasonCode, 'the reason code names the domain');
  assert.deepEqual(invoices.response.body, { roleLevel: { roleId: 'sales_staff', domain: 'invoices', level: 'view', version: 4 } });
  // The idempotency fingerprint covers the body bytes (app.ts), so the two edits are never one request.
  assert.notEqual(JSON.stringify(INVOICES_BODY), JSON.stringify(BODY));
  for (const domain of ['sales', 'Invoices', 'invoice', 'refunds', '', null, 1]) assert.equal(plan({ ...BODY, domain }), COMMAND_REQUEST_INVALID, String(domain));
  for (const roleId of ['store_owner', 'cashier', 'system_owner']) assert.equal(plan({ ...INVOICES_BODY, roleId }), COMMAND_REQUEST_INVALID, roleId);
});

test('a body the contract refuses plans nothing: exactly the six fields, an editable role, the one domain, a canonical level, a bounded reason and two well-formed preconditions', () => {
  const { expectedTenant: _t, expectedVersion: _v, ...fourFields } = BODY;
  const invalid: Array<[string, unknown]> = [
    ['null', null], ['an array', [BODY]], ['a string', 'x'], ['no field', {}],
    ['a missing reason', { roleId: 'manager', domain: 'customers', level: 'view', expectedTenant: T1, expectedVersion: 0 }],
    ['a tenant selector', { ...BODY, tenantId: T2 }],
    // M7A-CUSTOMERS-P4: the pre-P4 four-field body, either precondition missing, or either one malformed.
    ['the four-field body (no precondition)', fourFields], ['no expected tenant', { ...fourFields, expectedVersion: 0 }],
    ['no expected version', { ...fourFields, expectedTenant: T1 }], ['a null expected tenant', { ...BODY, expectedTenant: null }],
    ['an uppercase expected tenant', { ...BODY, expectedTenant: T1.toUpperCase() }], ['a braced expected tenant', { ...BODY, expectedTenant: `{${T1}}` }],
    ['an expected tenant without dashes', { ...BODY, expectedTenant: T1.replace(/-/g, '') }], ['a padded expected tenant', { ...BODY, expectedTenant: ` ${T1}` }],
    ['an expected tenant that is not a UUID', { ...BODY, expectedTenant: 'store-a' }], ['a numeric expected tenant', { ...BODY, expectedTenant: 1 }],
    ['a negative expected version', { ...BODY, expectedVersion: -1 }], ['a fractional expected version', { ...BODY, expectedVersion: 1.5 }],
    ['an expected version as text', { ...BODY, expectedVersion: '3' }], ['a null expected version', { ...BODY, expectedVersion: null }],
    ['an unsafe expected version', { ...BODY, expectedVersion: 2 ** 53 }], ['an expected version whose successor is unsafe', { ...BODY, expectedVersion: Number.MAX_SAFE_INTEGER }],
    ['an infinite expected version', { ...BODY, expectedVersion: Infinity }], ['a boolean expected version', { ...BODY, expectedVersion: true }],
    ['an actor', { ...BODY, actor: ACTOR }], ['the owner role', { ...BODY, roleId: 'store_owner' }], ['a platform role', { ...BODY, roleId: 'system_owner' }],
    ['a custom role', { ...BODY, roleId: 'cashier' }], ['a cased role', { ...BODY, roleId: 'Sales_Staff' }], ['a padded role', { ...BODY, roleId: ' manager' }],
    ['another domain', { ...BODY, domain: 'sales' }], ['a cased domain', { ...BODY, domain: 'Customers' }], ['no level', { ...BODY, level: '' }],
    ['a cased level', { ...BODY, level: 'View' }], ['an unknown level', { ...BODY, level: 'owner' }], ['a numeric level', { ...BODY, level: 2 }],
    ['a short reason', { ...BODY, reason: 'too short' }], ['a long reason', { ...BODY, reason: 'a'.repeat(501) }],
    ['a Bidi override', { ...BODY, reason: `a reason ${ch(0x202e)} here` }], ['a reason that is not text', { ...BODY, reason: 12345678901 }],
    ['an own __proto__ key', JSON.parse(JSON.stringify(BODY).replace(/\}$/, ',"__proto__":{"x":1}}'))],
  ];
  for (const [label, body] of invalid) assert.equal(plan(body), COMMAND_REQUEST_INVALID, label);
});

// --- 2. registration -----------------------------------------------------------------------------------------------------

test('the route registers as one PUT behind the tenant session and edit_role_levels, requiring idempotency, a trusted context and a recent authentication', () => {
  const [route] = defineRoutes([ROLE_LEVEL_UPDATE_ROUTE]).list();
  assert.deepEqual({
    method: route.method, path: route.path, policy: route.policy, body: route.body, idempotency: route.idempotency,
    trustedContext: route.trustedContext, recentAuth: route.recentAuth, sessionBinding: route.sessionBinding,
  }, {
    method: 'PUT', path: '/api/v1/roles/levels', idempotency: 'required', trustedContext: 'required', recentAuth: 'required', sessionBinding: 'none',
    policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'edit_role_levels' } },
    body: { kind: 'json', maxBytes: 8192, required: true },
  });
  assert.equal(ROLE_LEVELS_PERMISSION, 'edit_role_levels');
  assert.ok('command' in route && route.command.contract === ROLE_LEVEL_UPDATE_CONTRACT && route.command.plan === planRoleLevelUpdate);
  for (const part of [ROLE_LEVEL_UPDATE_ROUTE, ROLE_LEVEL_UPDATE_ROUTE.policy, ROLE_LEVEL_UPDATE_ROUTE.body, ROLE_LEVEL_UPDATE_CONTRACT,
    ROLE_LEVEL_UPDATE_CONTRACT.changes, ROLE_LEVEL_UPDATE_CONTRACT.events]) {
    assert.ok(Object.isFrozen(part), 'the shared definition is frozen throughout');
  }
});

test('the contract registers with no event, as a create of its own aggregate type, and prepares with the audit annex and the deadline', () => {
  const [contract] = defineCommands([ROLE_LEVEL_UPDATE_CONTRACT], defineOutboxEvents([])).list();
  assert.deepEqual(contract, {
    kind: 'tenant.role.level.update', mode: 'create', aggregateType: 'tenant_role_level', events: [],
    changes: { roleId: { type: 'enum', values: ['manager', 'technician', 'sales_staff'] }, domain: { type: 'enum', values: ['customers', 'invoices'] },
      level: { type: 'enum', values: ['approve', 'create', 'edit', 'full', 'manage', 'none', 'view'] },
      expectedTenant: { type: 'string', maxLength: 36 }, expectedVersion: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER } },
  });
  const newAggregateId = randomUUID();
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const operation = keyring.operationOf(randomUUID(), { authProvider: 'synthetic', authProviderUid: 'uid-owner' }, {
    method: 'PUT', path: ROLE_LEVELS_PATH, audience: 'tenant', tenant: T1, store: null, actor: ACTOR, body: Buffer.from('{}'),
  });
  const notAfter = Date.now() + 60_000;
  const prepared = prepareCommand(contract, defineOutboxEvents([]), planRoleLevelUpdate({ audience: 'tenant', body: BODY, newAggregateId }), {
    scope: operation.scope, lease: 'l'.repeat(43), newAggregateId, authorization: { scope: 'tenant', permission: 'edit_role_levels' },
    context: SCOPE, authNotAfter: notAfter, sessionKey: 'k'.repeat(43), seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'prepared');
  assert.deepEqual(prepared.command.mutation, {
    kind: 'tenant.role.level.update', aggregateType: 'tenant_role_level', aggregateId: newAggregateId, expectedVersion: null,
    changes: { roleId: 'sales_staff', domain: 'customers', level: 'view', expectedTenant: T1, expectedVersion: 3 },
  });
  assert.deepEqual({ ...prepared.command.audit, correlationId: '' }, {
    action: 'tenant.role.level.update', permission: 'edit_role_levels', scope: 'tenant', tenant: T1, store: null, actor: ACTOR, correlationId: '',
    reasonCode: 'role_sales_staff_customers_to_view', reason: REASON,
  });
  assert.equal(prepared.command.authNotAfter, notAfter, 'the deadline the store re-judges on the database clock');
  assert.deepEqual(prepared.command.events, []);
});

// --- 3. the chain over real loopback sockets, on the tenant boundary --------------------------------------------------------

const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-owner-bearer';
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

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
  commits: TransactionCommand[]; storeKey: string; authenticatedAt: number;
  setScope(scope: TrustedScope | false): void;
  /** The store's next answers instead of committing: an outcome word, or null to commit again. */
  setAnswer(outcome: string | null): void;
  put(over?: { body?: string; key?: string | null; headers?: Record<string, string> }): Promise<Reply>;
}

/** An owner's tenant session whose provider authentication happened `ageMs` ago, and a PUT over it. */
async function withChain(ageMs: number, fn: (h: Harness) => Promise<void>): Promise<void> {
  const commits: TransactionCommand[] = [];
  let scope: TrustedScope | false = SCOPE;
  let answer: string | null = null;
  const authenticatedAt = Date.now() - ageMs;
  const inner = createMemoryIdempotencyStore();
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      if (answer !== null) return { outcome: answer }; // a rolled-back refusal: nothing completed

      const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: c.response }), s);
      return { outcome: (done as { outcome?: unknown }).outcome === 'completed' ? 'committed' : 'lease_lost' };
    },
    probe: () => true,
  };
  const boundary: SessionBoundaryDeps = {
    trustedOrigins: [TENANT_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-owner', authenticatedAt, secondFactor: null }
          : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
    authorizer: { authorize: () => (scope === false ? false : { granted: true, context: scope }) },
    store: createMemorySessionStore(),
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: () => undefined }, sessions: { tenant: boundary }, routes: [ROLE_LEVEL_UPDATE_ROUTE],
    limits: testRequestLimits(), idempotency: { store: inner, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
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
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    const storeKey = createHash('sha256').update(id).digest('base64url');
    const put: Harness['put'] = ({ body = JSON.stringify(BODY), key = randomUUID(), headers = {} } = {}) => request(p, 'PUT', ROLE_LEVELS_PATH, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: `${SESSION_COOKIES.tenant}=${id}`, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(body)),
      ...(key === null ? {} : { 'idempotency-key': key }), ...headers,
    }, body);
    await fn({ commits, storeKey, authenticatedAt, put, setScope: (s) => { scope = s; }, setAnswer: (o) => { answer = o; } });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const errorOf = (r: Reply): unknown => (JSON.parse(r.body) as { error?: unknown }).error;

test('a committed edit answers 200 { roleLevel }, and the port receives the trusted scope, the session and the recent-authentication deadline', async () => {
  await withChain(1_000, async (h) => {
    const key = randomUUID();
    const r = await h.put({ key, headers: { 'x-tenant-id': T2, 'x-role': 'store_owner' } });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { roleLevel: { roleId: 'sales_staff', domain: 'customers', level: 'view', version: 4 } });
    assert.equal(h.commits.length, 1);
    const [c] = h.commits;
    assert.deepEqual(c.mutation.changes, { roleId: 'sales_staff', domain: 'customers', level: 'view', expectedTenant: T1, expectedVersion: 3 });
    assert.deepEqual(c.context, SCOPE, 'the authorizer\'s scope, unchanged by any header');
    assert.equal(c.sessionKey, h.storeKey);
    assert.equal(c.authNotAfter, h.authenticatedAt + RECENT_AUTH_MAX_AGE_MS, 'the provider authentication bound at login, plus the fixed window');
    assert.deepEqual([c.audit.reasonCode, c.audit.reason, c.audit.permission], ['role_sales_staff_customers_to_view', REASON, 'edit_role_levels']);
    const replay = await h.put({ key });
    assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed']], [200, r.body, 'true'], 'a same-key retry replays');
    const conflict = await h.put({ key, body: JSON.stringify({ ...BODY, level: 'none' }) });
    assert.deepEqual([conflict.status, errorOf(conflict)], [422, 'idempotency_key_reused'], 'the same key with another body');
    for (const over of [{ expectedVersion: 4 }, { expectedTenant: T2 }]) {
      const reasserted = await h.put({ key, body: JSON.stringify({ ...BODY, ...over }) });
      assert.deepEqual([reasserted.status, errorOf(reasserted)], [422, 'idempotency_key_reused'], `another precondition under the key: ${JSON.stringify(over)}`);
    }
    assert.equal(h.commits.length, 1, 'one commit for the key');
  });
});

test('a precondition that no longer holds: the store\'s precondition_failed is an UNSEALED 409 write_conflict — nothing recorded, the lease left — and the asserted tenant is never the scope', async () => {
  await withChain(1_000, async (h) => {
    h.setAnswer('precondition_failed');
    const key = randomUUID();
    // An A draft sent on a session whose scope is T1 asserting T2: the port receives the scope's tenant, the assertion as a change.
    const body = JSON.stringify({ ...BODY, expectedTenant: T2 });
    const r = await h.put({ key, body });
    assert.equal(r.status, 409, r.body);
    const refusal = JSON.parse(r.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(refusal).sort(), ['error', 'requestId'], 'the chain\'s own refusal shape, not a recorded body');
    assert.equal(refusal.error, 'write_conflict');
    assert.equal(refusal.requestId, r.headers['x-request-id'], 'this request\'s own id');
    assert.equal(r.headers['idempotent-replayed'], undefined);
    const [c] = h.commits;
    assert.deepEqual(c.context, SCOPE, 'the authority is the session\'s scope');
    assert.deepEqual([c.audit.tenant, c.mutation.changes.expectedTenant], [T1, T2], 'the assertion is a precondition beside the scope, never a selector');
    // Nothing was completed, so an identical retry waits on the lease instead of replaying a decision.
    const retry = await h.put({ key, body });
    assert.deepEqual([retry.status, errorOf(retry)], [409, 'request_in_progress'], 'unsealed: the key is not terminal');
    assert.equal(h.commits.length, 1, 'the retry never reached the store');
    // A fresh key re-decides; answering committed then is the ordinary 200.
    h.setAnswer(null);
    const again = await h.put();
    assert.deepEqual([again.status, JSON.parse(again.body)], [200, { roleLevel: { roleId: 'sales_staff', domain: 'customers', level: 'view', version: 4 } }]);
  });
});

test('step-up: authentication older than the window is refused before the body is read or a key is acquired — nothing commits', async () => {
  await withChain(RECENT_AUTH_MAX_AGE_MS + 60_000, async (h) => {
    const r = await h.put();
    assert.deepEqual([r.status, errorOf(r)], [403, 'step_up_required'], r.body);
    assert.equal(h.commits.length, 0);
  });
});

test('refusals before the store: a denial, a missing key, a body the contract refuses, CSRF and origin — none commits', async () => {
  await withChain(1_000, async (h) => {
    const cases: Array<[string, Parameters<Harness['put']>[0], number, string]> = [
      ['no key', { key: null }, 400, 'invalid_request'],
      ['the owner role as the target', { body: JSON.stringify({ ...BODY, roleId: 'store_owner' }) }, 400, 'invalid_request'],
      ['another domain', { body: JSON.stringify({ ...BODY, domain: 'sales' }) }, 400, 'invalid_request'],
      ['a short reason', { body: JSON.stringify({ ...BODY, reason: 'short' }) }, 400, 'invalid_request'],
      ['a tenant selector', { body: JSON.stringify({ ...BODY, tenantId: T2 }) }, 400, 'invalid_request'],
      ['malformed JSON', { body: '{"roleId":' }, 400, 'invalid_request'],
      ['no session CSRF', { headers: { [SESSION_CSRF_HEADER]: 'wrong' } }, 403, 'forbidden'],
      ['another origin', { headers: { origin: 'http://admin.trusted.test' } }, 403, 'forbidden'],
      ['an oversized body', { body: JSON.stringify({ ...BODY, reason: 'a'.repeat(8_200) }) }, 413, 'content_too_large'],
    ];
    for (const [label, over, status, error] of cases) {
      const r = await h.put(over);
      assert.deepEqual([r.status, errorOf(r)], [status, error], `${label}: ${r.body}`);
    }
    h.setScope(false);
    const denied = await h.put();
    assert.deepEqual([denied.status, errorOf(denied)], [403, 'forbidden'], 'an authorizer denial (the owner rule: m5CanonicalPermissions.test.ts)');
    assert.equal(h.commits.length, 0, 'nothing reached the transaction port');
  });
});
