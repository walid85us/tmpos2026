// Phase 4.0 M7A-CUSTOMERS-P7 — tenant customer edit through the runtime: the planner's input contract (every body shape),
// the plan and its sealed 200s, the route's and the contract's registration, the target-bound idempotency fingerprint
// (pinned, beside the create's unchanged pin), and the enforced chain over real loopback sockets on the TENANT boundary —
// the target judged after the chain and before acquisition, the same key sent to another customer refused as the 422,
// and the update outcomes (applied, unchanged, the sealed 409 conflict, the unsealed 404).
//
// Synthetic principals, sessions, keys and ports only. The transaction port here is a recording stand-in whose lease
// check is the idempotency store's own; the PostgreSQL store, its tenant revalidation and migration 024 are proved
// elsewhere (server/persistence, tests/db).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import { CUSTOMER_CREATE_ROUTE } from './customerCreate.js';
import { CUSTOMER_DETAIL_PATH, CUSTOMER_EMAIL_MAX_CHARACTERS, CUSTOMER_NAME_MAX_CHARACTERS, CUSTOMER_PHONE_MAX_CHARACTERS } from './customerDirectory.js';
import {
  CUSTOMER_UPDATE_CONTRACT, CUSTOMER_UPDATE_PERMISSION, CUSTOMER_UPDATE_REQUIREMENT, CUSTOMER_UPDATE_ROUTE, planCustomerUpdate,
} from './customerUpdate.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyState, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { createIdempotencyKeyring } from './idempotency.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, defineRoutes, sessionPaths } from './routes.js';
import type { CommandPlan } from './routes.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const MEMBERSHIP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const T1 = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const CID = '4d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
const OTHER_CID = '8e7d6c5b-4a39-4281-9f0e-1d2c3b4a5968';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: T1, store: null, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const ABSENT = Symbol('no target');
const plan = (body: unknown, targetId: string | undefined | typeof ABSENT = CID) =>
  planCustomerUpdate(Object.freeze(targetId === ABSENT
    ? { audience: 'tenant' as const, body, newAggregateId: randomUUID() }
    : { audience: 'tenant' as const, body, newAggregateId: randomUUID(), targetId: targetId as string }));
const changesOf = (body: unknown): unknown => (plan(body) as CommandPlan).changes;

// --- 1. the planner's input contract ----------------------------------------------------------------------------------------

test('a body without expectedVersion or name, or with any other key, plans nothing', () => {
  for (const [label, body] of [
    ['no name (D-1: name is required in every edit)', { expectedVersion: 1 }],
    ['no name, a phone', { expectedVersion: 1, phone: '+1 555 0100' }],
    ['no version', { name: 'Ada Lovelace' }],
    ['an empty object', {}],
    ['the id', { expectedVersion: 1, name: 'Ada', id: CID }],
    ['a tenant', { expectedVersion: 1, name: 'Ada', tenantId: T1 }],
    ['a creation time', { expectedVersion: 1, name: 'Ada', createdAt: '2026-09-30T08:15:42.123Z' }],
    ['a version spelled as the response does', { expectedVersion: 1, name: 'Ada', version: 2 }],
    ['the response flag', { expectedVersion: 1, name: 'Ada', changed: true }],
    ['a nested customer', { expectedVersion: 1, name: 'Ada', customer: { name: 'Ada' } }],
    ['a mis-cased key', { expectedVersion: 1, Name: 'Ada' }],
    ['a set-flag key', { expectedVersion: 1, name: 'Ada', setPhone: true }],
  ] as const) {
    assert.equal(plan(body), COMMAND_REQUEST_INVALID, label);
  }
});

test('expectedVersion is a safe integer from 1 to Number.MAX_SAFE_INTEGER - 1, and nothing else', () => {
  for (const expectedVersion of [1, 2, 1_000_000, Number.MAX_SAFE_INTEGER - 1]) {
    assert.equal((plan({ expectedVersion, name: 'Ada' }) as CommandPlan).expectedVersion, expectedVersion, String(expectedVersion));
  }
  for (const expectedVersion of [0, -1, -0.5, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, '1', '01', null, true, [1], { v: 1 }]) {
    assert.equal(plan({ expectedVersion, name: 'Ada' }), COMMAND_REQUEST_INVALID, JSON.stringify(expectedVersion) ?? String(expectedVersion));
  }
});

test('name is normalized exactly as the create does: trimmed, 1-200 scalars, refused classes and invisible-only names refused', () => {
  assert.equal((changesOf({ expectedVersion: 1, name: '  Ada  Lovelace ' }) as { name: string }).name, 'Ada  Lovelace');
  const longest = ch(0x1f600).repeat(CUSTOMER_NAME_MAX_CHARACTERS);
  assert.equal((changesOf({ expectedVersion: 1, name: longest }) as { name: string }).name, longest, '200 astral scalars');
  for (const name of ['', '   ', null, 7, ['Ada'], 'x'.repeat(CUSTOMER_NAME_MAX_CHARACTERS + 1), `A${ch(0)}da`, `A${ch(0x202e)}da`, ch(0x200b), ch(0x2800)]) {
    assert.equal(plan({ expectedVersion: 1, name }), COMMAND_REQUEST_INVALID, JSON.stringify(name));
  }
});

test('phone and email: absent is not written; null or blank clears; a valid value is stored as the create stores it; anything else refused', () => {
  assert.deepEqual(changesOf({ expectedVersion: 3, name: 'Ada' }), { name: 'Ada', setPhone: false, phone: '', setEmail: false, email: '' }, 'neither written');
  assert.deepEqual(changesOf({ expectedVersion: 3, name: 'Ada', phone: null, email: '  ' }),
    { name: 'Ada', setPhone: true, phone: '', setEmail: true, email: '' }, 'null and blank clear: written as the empty string');
  assert.deepEqual(changesOf({ expectedVersion: 3, name: 'Ada', phone: ' +1 555 0100 ', email: 'ada@example.test' }),
    { name: 'Ada', setPhone: true, phone: '+1 555 0100', setEmail: true, email: 'ada@example.test' }, 'trimmed, kept as typed');
  assert.deepEqual(changesOf({ expectedVersion: 3, name: 'Ada', email: '' }), { name: 'Ada', setPhone: false, phone: '', setEmail: true, email: '' },
    'each contact independent');
  const longestPhone = '1'.repeat(CUSTOMER_PHONE_MAX_CHARACTERS);
  const longestEmail = `${'a'.repeat(CUSTOMER_EMAIL_MAX_CHARACTERS - 12)}@example.tst`;
  assert.deepEqual(changesOf({ expectedVersion: 3, name: 'Ada', phone: longestPhone, email: longestEmail }),
    { name: 'Ada', setPhone: true, phone: longestPhone, setEmail: true, email: longestEmail }, 'the longest of each');
  for (const [label, over] of [
    ['a phone with no digit', { phone: 'call me' }], ['a numeric phone', { phone: 5550100 }], ['a phone of 65 scalars', { phone: '1'.repeat(65) }],
    ['a Bidi control in the phone', { phone: `1${ch(0x202e)}2` }], ['a phone that is an object', { phone: {} }], ['a phone that is false', { phone: false }],
    ['an email with a space', { email: 'ada @example.test' }], ['an email with two @', { email: 'a@b@example.test' }], ['an email with no @', { email: 'ada' }],
    ['an email of 255 scalars', { email: `${'a'.repeat(127)}@${'b'.repeat(127)}` }], ['a numeric email', { email: 1 }], ['an email array', { email: ['a@b'] }],
  ] as const) {
    assert.equal(plan({ expectedVersion: 3, name: 'Ada', ...over }), COMMAND_REQUEST_INVALID, label);
  }
});

test('a body that is not one JSON object, or a target outside the outbox aggregate-id shape, plans nothing', () => {
  for (const body of [null, undefined, [], [{ expectedVersion: 1, name: 'Ada' }], 'Ada', 1, true]) {
    assert.equal(plan(body), COMMAND_REQUEST_INVALID, JSON.stringify(body) ?? 'undefined');
  }
  const good = { expectedVersion: 1, name: 'Ada' };
  assert.equal(plan(good, ABSENT), COMMAND_REQUEST_INVALID, 'no target at all (a literal route never hands one)');
  for (const targetId of [
    '', '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa', CID.toUpperCase(), `{${CID}}`, `${CID} `, '{id}', 'x',
  ]) {
    assert.equal(plan(good, targetId), COMMAND_REQUEST_INVALID, `target ${String(targetId)}: readable perhaps, never editable`);
  }
  for (const targetId of [CID, 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-8aaa-baaa-aaaaaaaaaaaa']) {
    assert.notEqual(plan(good, targetId), COMMAND_REQUEST_INVALID, targetId);
  }
});

test('the plan: the target as the aggregate at the expected version, the change set, no event, and the two sealed 200s in their exact key order', () => {
  const p = plan({ email: null, name: ' Ada Lovelace ', phone: '+1 555 0100', expectedVersion: 4 }) as CommandPlan;
  assert.deepEqual(Object.keys(p), ['aggregateId', 'expectedVersion', 'changes', 'events', 'response', 'unchanged']);
  assert.equal(p.aggregateId, CID);
  assert.equal(p.expectedVersion, 4);
  assert.deepEqual(p.changes, { name: 'Ada Lovelace', setPhone: true, phone: '+1 555 0100', setEmail: true, email: '' });
  assert.deepEqual(Object.keys(p.changes), ['name', 'setPhone', 'phone', 'setEmail', 'email']);
  assert.deepEqual(p.events, []);
  assert.equal(JSON.stringify(p.response), JSON.stringify({ status: 200, body: { customer: { id: CID, name: 'Ada Lovelace' }, version: 5, changed: true } }));
  assert.equal(JSON.stringify(p.unchanged), JSON.stringify({ status: 200, body: { customer: { id: CID, name: 'Ada Lovelace' }, version: 4, changed: false } }));
  assert.ok(!('audit' in p), 'no annex: the audit reason stays command_committed');
  assert.ok(!JSON.stringify(p.response).includes('555') && !JSON.stringify(p.unchanged).includes('555'), 'no contact in either 200');
  const largest = plan({ expectedVersion: Number.MAX_SAFE_INTEGER - 1, name: 'Ada' }) as CommandPlan;
  assert.equal((largest.response.body as { version: number }).version, Number.MAX_SAFE_INTEGER, 'the largest version a row can reach');
});

// --- 2. registration ----------------------------------------------------------------------------------------------------------

test('the route registers as the one templated PATCH behind the tenant session and edit_customers, requiring idempotency and a trusted context', () => {
  assert.equal(CUSTOMER_UPDATE_PERMISSION, 'edit_customers');
  assert.deepEqual(CUSTOMER_UPDATE_REQUIREMENT, { scope: 'tenant', permission: 'edit_customers' });
  const r = CUSTOMER_UPDATE_ROUTE;
  assert.deepEqual([r.method, r.path, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding], ['PATCH', '/api/v1/customers/{id}', 'required', 'required', 'none', undefined]);
  assert.equal(r.path, CUSTOMER_DETAIL_PATH);
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'edit_customers' } });
  assert.deepEqual(r.body, { kind: 'json', maxBytes: 8_192, required: true });
  assert.ok('command' in r && r.command.contract === CUSTOMER_UPDATE_CONTRACT && r.command.plan === planCustomerUpdate);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.policy) && Object.isFrozen(r.body));
  const table = defineRoutes([CUSTOMER_CREATE_ROUTE, CUSTOMER_UPDATE_ROUTE]);
  assert.equal(table.lookup('PATCH', `/api/v1/customers/${CID}`)?.path, '/api/v1/customers/{id}');
  assert.equal(table.lookup('POST', `/api/v1/customers/${CID}`), undefined);
});

test('the contract: an update of a customer with no event, its five fields within the record caps, and the outbox accepts every field name', () => {
  assert.deepEqual(CUSTOMER_UPDATE_CONTRACT, {
    kind: 'tenant.customer.update', mode: 'update', aggregateType: 'customer', contextScope: 'tenant',
    changes: {
      name: { type: 'string', maxLength: 400 }, setPhone: { type: 'boolean' }, phone: { type: 'string', maxLength: 128 },
      setEmail: { type: 'boolean' }, email: { type: 'string', maxLength: 508 },
    },
    events: [],
  });
  const commands = defineCommands([CUSTOMER_UPDATE_CONTRACT], defineOutboxEvents([]));
  assert.deepEqual(commands.contract('tenant.customer.update'), CUSTOMER_UPDATE_CONTRACT, 'registers beside no event contract');
  // The worst plan prepares: every field at its longest, astral where a scalar may be.
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const operation = keyring.operationOf(randomUUID(), { authProvider: 'synthetic', authProviderUid: 'uid' }, {
    method: 'PATCH', path: CUSTOMER_DETAIL_PATH, audience: 'tenant', tenant: T1, store: null, actor: ACTOR, body: Buffer.from('{}'), target: CID,
  });
  const p = plan({
    expectedVersion: 9, name: ch(0x1f600).repeat(200), phone: `1${ch(0x1f4de).repeat(63)}`, email: `${ch(0x1f4e7).repeat(250)}@b.c`,
  });
  assert.notEqual(p, COMMAND_REQUEST_INVALID);
  const prepared = prepareCommand(CUSTOMER_UPDATE_CONTRACT, defineOutboxEvents([]), p, {
    scope: operation.scope, lease: 'l'.repeat(43), newAggregateId: randomUUID(), authorization: { scope: 'tenant', permission: 'edit_customers' },
    context: SCOPE, authNotAfter: null, sessionKey: 'k'.repeat(43), seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'the longest plan prepares');
  assert.deepEqual([prepared.command.mutation.kind, prepared.command.mutation.aggregateId, prepared.command.mutation.expectedVersion], ['tenant.customer.update', CID, 9]);
  assert.ok(prepared.command.unchanged !== null, 'an update seals its unchanged 200');
  assert.deepEqual({ ...prepared.command.audit, correlationId: '' }, {
    action: 'tenant.customer.update', permission: 'edit_customers', scope: 'tenant', tenant: T1, store: null, actor: ACTOR, correlationId: '',
    reasonCode: null, reason: null,
  }, 'the audit record carries the trusted scope and no name, phone or email');
});

// --- 3. the fingerprint: the target is bound, the create's is unchanged ---------------------------------------------------

// Assembled at run time so no key-shaped literal sits in the source (secret scanning).
const PIN_KEY = ['0b6f1d2e', '3c4a', '4b5c', '8d6e', '7f8091a2b3c4'].join('-');
const PIN_PRINCIPAL = Object.freeze({ authProvider: 'synthetic', authProviderUid: 'uid-customers' });

test('the target-bound fingerprint is pinned; a literal route\'s is the contract-version-2 one; another target is another fingerprint', () => {
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const binding = {
    method: 'PATCH', path: CUSTOMER_DETAIL_PATH, audience: 'tenant', tenant: T1, store: null, actor: ACTOR,
    body: Buffer.from('{"expectedVersion":1,"name":"Ada Lovelace"}'),
  } as const;
  // Computed with this repository's code at M7A-CUSTOMERS-P7 and written out; assembled from two halves so no scanner reads a
  // token literal. Any change to the target slot's place or framing moves it.
  const pinned = ['TSYMuJILcxa-hWiwZCwm', 'NdWwsbYbd_TkX3PbiNHJcjk'].join('');
  assert.equal(keyring.operationOf(PIN_KEY, PIN_PRINCIPAL, { ...binding, target: CID }).fingerprint, pinned);
  // The create's pinned vector (customerCreate.test.ts) is re-derived here too: a literal route never carries a target.
  const create = keyring.operationOf(PIN_KEY, PIN_PRINCIPAL, {
    method: 'POST', path: '/api/v1/customers', audience: 'tenant', tenant: T1, store: null, actor: ACTOR, body: Buffer.from('{"name":"Ada Lovelace"}'),
  });
  assert.equal(create.fingerprint, ['jNmrjvWu3XnY6Zbou', 'QMNeh5VfHOl7vZjA2g3II2kZYQ'].join(''));
  const absent = keyring.operationOf(PIN_KEY, PIN_PRINCIPAL, binding);
  assert.equal(keyring.operationOf(PIN_KEY, PIN_PRINCIPAL, { ...binding, target: null }).fingerprint, absent.fingerprint, 'null is absent');
  assert.notEqual(absent.fingerprint, pinned, 'no target is not the target');
  const other = keyring.operationOf(PIN_KEY, PIN_PRINCIPAL, { ...binding, target: OTHER_CID });
  assert.notEqual(other.fingerprint, pinned, 'another target, another fingerprint');
  assert.equal(other.scope, absent.scope, 'one record per key and principal: the second target is the 422 conflict, never a second record');
  for (const target of [CID.toUpperCase(), '', 'x', `${CID} `, 7, {}, '{id}']) {
    assert.throws(() => keyring.operationOf(PIN_KEY, PIN_PRINCIPAL, { ...binding, target: target as never }), /idempotency_binding_invalid/, String(target));
  }
});

// --- 4. the chain over real loopback sockets, on the tenant boundary -------------------------------------------------------

const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
type Answer = 'committed' | 'unchanged' | 'conflict' | 'not_found' | 'unavailable';

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
  commits: TransactionCommand[]; authorizations: unknown[][]; logs: string[]; storeKey: string; records: () => number;
  setScope(scope: TrustedScope | false): void;
  setAnswer(answer: Answer): void;
  patch(over?: { id?: string; body?: string; key?: string | null; cookie?: boolean }): Promise<Reply>;
}

async function withChain(fn: (h: Harness) => Promise<void>): Promise<void> {
  const commits: TransactionCommand[] = [];
  const authorizations: unknown[][] = [];
  const logs: string[] = [];
  let scope: TrustedScope | false = SCOPE;
  let answer: Answer = 'committed';
  const state = createMemoryIdempotencyState();
  const inner = createMemoryIdempotencyStore(state);
  // Commits through the idempotency store's own lease check, recording the completion each update outcome seals.
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      const sealed = answer === 'committed' ? c.response : answer === 'unchanged' ? c.unchanged : answer === 'conflict' ? c.rejected.conflict : null;
      if (sealed === null) return { outcome: answer };
      const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: sealed }), s);
      if ((done as { outcome?: unknown }).outcome !== 'completed') return { outcome: 'lease_lost' };
      return { outcome: answer };
    },
    probe: () => true,
  };
  const boundary: SessionBoundaryDeps = {
    trustedOrigins: [TENANT_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-customers', authenticatedAt: Date.now(), secondFactor: null }
          : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
    authorizer: { authorize: (...args: unknown[]) => { authorizations.push(args); return scope === false ? false : { granted: true, context: scope }; } },
    store: createMemorySessionStore(),
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (line: string) => { logs.push(line); } }, sessions: { tenant: boundary }, routes: [CUSTOMER_CREATE_ROUTE, CUSTOMER_UPDATE_ROUTE],
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
    const sid = pair.slice(pair.indexOf('=') + 1);
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    const storeKey = createHash('sha256').update(sid).digest('base64url');
    authorizations.length = 0;
    const patch: Harness['patch'] = ({ id = CID, body = JSON.stringify({ expectedVersion: 4, name: 'Ada Lovelace' }), key = randomUUID(), cookie = true } = {}) =>
      request(p, 'PATCH', `/api/v1/customers/${id}`, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        ...(cookie ? { cookie: `${SESSION_COOKIES.tenant}=${sid}`, [SESSION_CSRF_HEADER]: csrf } : {}),
        'content-length': String(Buffer.byteLength(body)), ...(key === null ? {} : { 'idempotency-key': key }),
      }, body);
    await fn({
      commits, authorizations, logs, storeKey, records: () => state.records.size, patch,
      setScope: (s) => { scope = s; }, setAnswer: (a) => { answer = a; },
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const errorOf = (r: Reply): unknown => (JSON.parse(r.body) as { error?: unknown }).error;

test('a committed edit answers 200 {customer:{id,name},version,changed:true}; the port receives the target, the trusted scope and the presenting session', async () => {
  await withChain(async (h) => {
    const r = await h.patch({ body: JSON.stringify({ expectedVersion: 4, name: ' Ada Lovelace ', phone: '+1 555 0100', email: null }) });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.body, JSON.stringify({ customer: { id: CID, name: 'Ada Lovelace' }, version: 5, changed: true }), 'exact bytes and key order');
    assert.equal(r.headers.etag, undefined, 'a sealed response carries no ETag (the version is in the body)');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(h.authorizations.map((a) => [a[1], a[2]]), [[{ scope: 'tenant', permission: 'edit_customers' },
      { method: 'PATCH', path: '/api/v1/customers/{id}', audience: 'tenant' }]], 'the declared requirement on the TEMPLATE\'s view, never the id');
    assert.equal(h.commits.length, 1);
    const [c] = h.commits;
    assert.deepEqual(c.mutation, {
      kind: 'tenant.customer.update', aggregateType: 'customer', aggregateId: CID, expectedVersion: 4,
      changes: { name: 'Ada Lovelace', setPhone: true, phone: '+1 555 0100', setEmail: true, email: '' },
    });
    assert.deepEqual(c.context, SCOPE);
    assert.equal(c.sessionKey, h.storeKey);
    assert.deepEqual([c.audit.action, c.audit.permission, c.audit.scope, c.audit.tenant, c.audit.actor], ['tenant.customer.update', 'edit_customers', 'tenant', T1, ACTOR]);
    assert.deepEqual(c.events, []);
    for (const line of h.logs) {
      for (const secret of [CID, 'Ada', '555 0100', h.storeKey]) assert.ok(!line.includes(secret), `no log line carries ${secret}`);
    }
  });
});

test('the target is judged after the chain and before anything is reserved: unauthenticated is 401 for any segment; authorized but malformed is the 400', async () => {
  await withChain(async (h) => {
    for (const id of [CID, 'x', CID.toUpperCase(), '{id}']) {
      const r = await h.patch({ id, cookie: false });
      assert.equal(r.status, 401, `${id}: the chain's refusal first, no id-shape oracle`);
    }
    assert.equal(h.authorizations.length, 0);
    for (const id of ['x', CID.toUpperCase(), '{id}', `${CID}0`, CID.slice(1), '%7Bid%7D']) {
      const r = await h.patch({ id });
      assert.deepEqual([r.status, errorOf(r)], [400, 'invalid_request'], `${id}: ${r.body}`);
      assert.deepEqual(Object.keys(JSON.parse(r.body) as object), ['error', 'requestId']);
    }
    assert.equal(h.records(), 0, 'no idempotency record was reserved');
    assert.equal(h.commits.length, 0);
    assert.ok(h.authorizations.length > 0, 'each was authorized first');
    // A canonical uuid outside the outbox aggregate-id shape passes the router's check and is the planner's 400.
    const v0 = await h.patch({ id: '00000000-0000-0000-0000-000000000000' });
    assert.deepEqual([v0.status, errorOf(v0)], [400, 'invalid_request'], v0.body);
    assert.equal(h.commits.length, 0);
    const lines = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'request' && l.status === 400);
    assert.ok(lines.some((l) => l.reason === 'command_target_invalid') && lines.some((l) => l.reason === 'command_request_invalid'));
  });
});

test('one key sent to two customers is the 422, never a replay of the first customer\'s response; the first still replays its own', async () => {
  await withChain(async (h) => {
    const key = randomUUID();
    const body = JSON.stringify({ expectedVersion: 4, name: 'Ada Lovelace' });
    const first = await h.patch({ key, body });
    assert.equal(first.status, 200, first.body);
    const elsewhere = await h.patch({ key, body, id: OTHER_CID });
    assert.deepEqual([elsewhere.status, errorOf(elsewhere)], [422, 'idempotency_key_reused'], elsewhere.body);
    assert.ok(!elsewhere.body.includes(CID), 'nothing of the first customer\'s record reaches the second');
    const replay = await h.patch({ key, body });
    assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed']], [200, first.body, 'true']);
    assert.equal(h.commits.length, 1, 'one commit for the key');
    const changed = await h.patch({ key, body: JSON.stringify({ expectedVersion: 4, name: 'Ada Lovelace', phone: null }) });
    assert.deepEqual([changed.status, errorOf(changed)], [422, 'idempotency_key_reused'], 'another spelling under the key');
  });
});

test('outcomes: unchanged is the sealed 200 changed:false; a stale version the sealed 409 that replays; a missing or foreign customer the unsealed 404; a fault the 503', async () => {
  await withChain(async (h) => {
    h.setAnswer('unchanged');
    const same = await h.patch({ body: JSON.stringify({ expectedVersion: 4, name: 'Ada Lovelace' }) });
    assert.deepEqual([same.status, same.body], [200, JSON.stringify({ customer: { id: CID, name: 'Ada Lovelace' }, version: 4, changed: false })]);

    h.setAnswer('conflict');
    const key = randomUUID();
    const stale = await h.patch({ key, body: JSON.stringify({ expectedVersion: 2, name: 'Ada Lovelace' }) });
    assert.deepEqual([stale.status, stale.body], [409, JSON.stringify({ error: 'write_conflict' })]);
    h.setAnswer('committed');
    const again = await h.patch({ key, body: JSON.stringify({ expectedVersion: 2, name: 'Ada Lovelace' }) });
    assert.deepEqual([again.status, again.body, again.headers['idempotent-replayed']], [409, stale.body, 'true'], 'the same key replays the 409');

    h.setAnswer('not_found');
    const missing = await h.patch({ id: OTHER_CID });
    assert.deepEqual([missing.status, errorOf(missing)], [404, 'not_found'], missing.body);
    assert.deepEqual(Object.keys(JSON.parse(missing.body) as object), ['error', 'requestId']);

    h.setAnswer('unavailable');
    const down = await h.patch();
    assert.deepEqual([down.status, errorOf(down)], [503, 'service_unavailable']);
  });
});

test('refusals before the store: a denial, no key, a body the contract refuses — none commits, and none names a value', async () => {
  await withChain(async (h) => {
    h.setScope(false);
    assert.equal((await h.patch()).status, 403);
    h.setScope(SCOPE);
    const noKey = await h.patch({ key: null });
    assert.deepEqual([noKey.status, errorOf(noKey)], [400, 'invalid_request']);
    for (const body of [
      JSON.stringify({ expectedVersion: 4 }), JSON.stringify({ name: 'Ada' }), JSON.stringify({ expectedVersion: 0, name: 'Ada' }),
      JSON.stringify({ expectedVersion: 4, name: 'Ada', id: CID }), JSON.stringify({ expectedVersion: 4, name: 'Ada', email: 'not an email' }),
      JSON.stringify([{ expectedVersion: 4, name: 'Ada' }]), 'null',
    ]) {
      const r = await h.patch({ body });
      assert.deepEqual([r.status, errorOf(r)], [400, 'invalid_request'], body);
      assert.ok(!r.body.includes('Ada') && !r.body.includes('email'), 'the refusal names no value');
    }
    assert.equal(h.commits.length, 0);
  });
});
