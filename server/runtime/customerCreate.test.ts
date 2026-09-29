// Phase 4.0 M7A-CUSTOMERS-P3 — tenant customer creation through the runtime: the name rule and its parity with migration
// 017's CHECK (every code point swept), the planner's input contract, the route's and the contract's registration, and the
// enforced chain over real loopback sockets on the TENANT boundary — session, CSRF, the authorizer's trusted scope, the
// command handed to the transaction port, replay, and a key bound to the trusted tenant and actor.
//
// Synthetic principals, sessions, keys and ports only. The transaction port here is a recording stand-in whose lease check
// is the idempotency store's own; the PostgreSQL store, its tenant revalidation and migration 019 are proved elsewhere
// (server/persistence, tests/db). Special characters are built from code points so this source stays ASCII.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import {
  CUSTOMER_CREATE_CONTRACT, CUSTOMER_CREATE_PERMISSION, CUSTOMER_CREATE_ROUTE, normalizeCustomerName, planCustomerCreate,
} from './customerCreate.js';
import { CUSTOMER_DIRECTORY_PATH, CUSTOMER_NAME_MAX_CHARACTERS, createCustomerDirectoryRoute } from './customerDirectory.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyState, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { IDEMPOTENCY_POLICY, createIdempotencyKeyring, envelopeFromOutcome } from './idempotency.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { UUID_V4_RE, defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, defineRoutes, sessionPaths } from './routes.js';
import type { CommandPlan } from './routes.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ACTOR = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MEMBERSHIP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const T1 = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const T2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: T1, store: null, membershipId: MEMBERSHIP, roleId: 'sales_staff', limitation: 'none',
});
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const unit = (code: number): string => String.fromCharCode(code); // a lone UTF-16 unit, for surrogates
const plan = (body: unknown) => planCustomerCreate({ audience: 'tenant', body, newAggregateId: randomUUID() });

// --- 1. the name rule, and its parity with migration 017's CHECK -----------------------------------------------------------

const MIGRATION_017 = readFileSync(new URL('../platform-identity/migrations/017_m7a_customer_directory.up.sql', import.meta.url), 'utf8');
/** The code points of one bracket class written as 017 writes it: \uXXXX escapes and \uXXXX-\uXXXX ranges, nothing else. */
function classOf(text: string): Set<number> {
  const out = new Set<number>();
  const re = /\\u([0-9a-f]{4})(?:-\\u([0-9a-f]{4}))?/y;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const from = parseInt(m[1], 16);
    const to = m[2] === undefined ? from : parseInt(m[2], 16);
    for (let c = from; c <= to; c++) out.add(c);
    if (re.lastIndex === text.length) return out;
  }
  throw new Error(`017 class not fully read: ${text}`);
}
const check017 = (() => {
  const constraint = /constraint customer_name_chk check \(([\s\S]*?)\n\);/.exec(MIGRATION_017)?.[1] ?? '';
  const anywhere = [...constraint.matchAll(/and name !~ '\[([^\]]+)\]'\n/g)].map((m) => classOf(m[1]));
  const edge = /and name !~ '\^\[([^\]]+)\]\|\[([^\]]+)\]\$'\)$/.exec(constraint);
  const length = /char_length\(name\) between 1 and (\d+)/.exec(constraint);
  return { rules: (constraint.match(/name !~/g) ?? []).length, anywhere, edge, length };
})();

test('migration 017\'s CHECK reads as this test expects: a length, two anywhere classes and one edge class', () => {
  assert.equal(check017.rules, 3, 'exactly three character rules');
  assert.equal(check017.anywhere.length, 2);
  assert.ok(check017.edge !== null && check017.edge[1] === check017.edge[2], 'the same class at either edge');
  assert.equal(Number(check017.length?.[1]), CUSTOMER_NAME_MAX_CHARACTERS, '1-200 characters');
});

test('ES trim strips EXACTLY 017\'s 25 edge-whitespace code points, at either edge: swept over every scalar value', () => {
  const edge = classOf((check017.edge as RegExpExecArray)[1]);
  assert.equal(edge.size, 25);
  const wrong: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue; // no scalar value
    const s = String.fromCodePoint(c);
    const stripped = (s + 'a').trim() === 'a' && ('a' + s).trim() === 'a';
    const kept = (s + 'a').trim() === s + 'a' && ('a' + s).trim() === 'a' + s;
    if (edge.has(c) ? !stripped : !kept) wrong.push(c);
  }
  assert.deepEqual(wrong, [], 'so a trimmed name never has an edge character 017 refuses, and trimming removes nothing 017 allows');
  // And the normalizer trims them: every one at either edge of a name is gone.
  for (const c of edge) assert.equal(normalizeCustomerName(`${ch(c)}Ada${ch(c)}`), 'Ada', c.toString(16));
});

test('inside a name the refused set is EXACTLY 017\'s two anywhere classes plus NUL: swept over every scalar value', () => {
  const [controls, bidi] = check017.anywhere;
  assert.equal(bidi.size, 12, 'the twelve Bidi_Control characters');
  const wrong: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const refused = normalizeCustomerName(`a${ch(c)}a`) === null;
    if (refused !== (c === 0 || controls.has(c) || bidi.has(c))) wrong.push(c);
  }
  assert.deepEqual(wrong, [], 'the runtime refuses every character 017 refuses anywhere, NUL besides, and nothing else between visible ones');
  // A lone surrogate is no scalar value: 017 cannot see one (the driver would send U+FFFD); the runtime refuses it.
  for (const lone of [unit(0xd800), unit(0xdbff), unit(0xdc00), unit(0xdfff), unit(0xdc00) + unit(0xd800)]) {
    assert.equal(normalizeCustomerName(`a${lone}a`), null, `lone ${lone.charCodeAt(0).toString(16)}`);
    assert.equal(normalizeCustomerName(lone), null);
  }
  assert.equal(normalizeCustomerName(`a${ch(0x1f600)}a`), `a${ch(0x1f600)}a`, 'a well-formed surrogate pair is one scalar (control)');
});

test('a name must hold at least one visible scalar: whitespace, default-ignorables, format characters, marks and U+2800 alone are refused', () => {
  const invisible: Array<[string, string]> = [
    ['empty', ''], ['spaces', '   '], ['NBSP and ideographic space', `${ch(0xa0)}${ch(0x3000)}`],
    ['ZWSP', ch(0x200b)], ['ZWNJ', ch(0x200c)], ['ZWJ', ch(0x200d)], ['word joiner', ch(0x2060)], ['soft hyphen', ch(0xad)],
    ['combining grapheme joiner', ch(0x34f)], ['a variation selector', ch(0xfe0f)], ['a tag character', ch(0xe0041)],
    ['Hangul choseong filler', ch(0x115f)], ['Hangul jungseong filler', ch(0x1160)], ['Hangul filler', ch(0x3164)],
    ['halfwidth Hangul filler', ch(0xffa0)], ['Mongolian vowel separator', ch(0x180e)], ['braille blank', ch(0x2800)],
    ['a combining mark alone', ch(0x301)], ['an enclosing mark alone', ch(0x20dd)], ['mixed', `${ch(0x200b)} ${ch(0x2800)}${ch(0x301)}${ch(0xfe0f)}`],
  ];
  for (const [label, name] of invisible) assert.equal(normalizeCustomerName(name), null, label);
  // One visible scalar is enough, and the invisible ones beside it are kept exactly.
  for (const [label, name] of [
    ['a letter', 'A'], ['a digit', '7'], ['a symbol', '#'], ['a ZWJ emoji', ch(0x1f468, 0x200d, 0x1f527)], ['a combining acute on e', `e${ch(0x301)}`],
    ['a private-use scalar (visible by choice)', ch(0xe000)], ['an unassigned scalar (visible by choice)', ch(0x0378)], ['CJK', ch(0x4fee, 0x7406)],
    ['a letter beside a ZWSP', `A${ch(0x200b)}`], ['right-to-left text', ch(0x5e9, 0x5dc, 0x5d5, 0x5dd)],
  ] as const) {
    assert.equal(normalizeCustomerName(name), name, label);
  }
});

test('the length is 1-200 scalars after trimming, astral scalars included, and padding does not count', () => {
  const astral = ch(0x1f600);
  assert.equal(normalizeCustomerName('A'), 'A', 'one scalar');
  assert.equal(normalizeCustomerName('a'.repeat(200)), 'a'.repeat(200), '200 scalars');
  assert.equal(normalizeCustomerName('a'.repeat(201)), null, '201 scalars');
  assert.equal(normalizeCustomerName(astral.repeat(200)), astral.repeat(200), '200 astral scalars are 400 UTF-16 units, and allowed');
  assert.equal(normalizeCustomerName(astral.repeat(201)), null, '201 astral scalars');
  assert.equal(normalizeCustomerName(`${'a'.repeat(199)}${astral}`), `${'a'.repeat(199)}${astral}`, 'a mix is counted in scalars');
  assert.equal(normalizeCustomerName(`${' '.repeat(300)}${'b'.repeat(200)}${ch(0x3000).repeat(300)}`), 'b'.repeat(200), 'padding is trimmed first');
  assert.equal(normalizeCustomerName('Ada  Lovelace'), 'Ada  Lovelace', 'internal whitespace is kept exactly');
  assert.equal(normalizeCustomerName(`Ada${ch(0xa0)}Lovelace`), `Ada${ch(0xa0)}Lovelace`, 'an internal NBSP is kept');
  assert.equal(normalizeCustomerName(`Cafe${ch(0x301)}`), `Cafe${ch(0x301)}`, 'no normalization: NFD stays NFD');
  assert.equal(normalizeCustomerName('Bob\n'), 'Bob', 'a trailing newline is edge whitespace, trimmed');
  assert.equal(normalizeCustomerName(`a${ch(0x2028)}b`), null, 'a separator inside a name is refused');
  for (const raw of [undefined, null, 1, true, {}, ['A'], { toString: () => 'A' }]) assert.equal(normalizeCustomerName(raw), null, String(raw));
});

// --- 2. the planner ------------------------------------------------------------------------------------------------------

test('a body the contract refuses plans nothing: exactly { name } and a valid name, or COMMAND_REQUEST_INVALID', () => {
  const invalid: Array<[string, unknown]> = [
    ['null', null], ['undefined', undefined], ['an array', [{ name: 'A' }]], ['an empty array', []], ['a string', 'A'], ['a number', 1], ['true', true],
    ['no field', {}], ['a tenant selector', { name: 'A', tenantId: T2 }], ['a client id', { name: 'A', id: randomUUID() }],
    ['an actor', { name: 'A', actor: ACTOR }], ['a contact field', { name: 'A', email: 'a@example.test' }], ['only another field', { title: 'A' }],
    ['a number for the name', { name: 1 }], ['null for the name', { name: null }], ['an object for the name', { name: { first: 'A' } }],
    ['an array for the name', { name: ['A'] }], ['an empty name', { name: '' }], ['a blank name', { name: '   ' }],
    ['an invisible name', { name: ch(0x200b) }], ['a Bidi override', { name: `a${ch(0x202e)}b` }], ['a C1 control', { name: `a${ch(0x85)}b` }],
    ['201 scalars', { name: 'a'.repeat(201) }], ['a lone surrogate', { name: `a${unit(0xd800)}` }],
    ['an own __proto__ key', JSON.parse('{"name":"A","__proto__":{"x":1}}')], ['__proto__ in place of name', JSON.parse('{"__proto__":"A"}')],
  ];
  for (const [label, body] of invalid) assert.equal(plan(body), COMMAND_REQUEST_INVALID, label);
});

test('the plan: the runtime\'s new id as the aggregate, no version, the stored name alone, no event, and the 201 representation', () => {
  const newAggregateId = randomUUID();
  const p = planCustomerCreate({ audience: 'tenant', body: { name: '  Ada  Lovelace ' }, newAggregateId });
  assert.deepEqual(p, {
    aggregateId: newAggregateId, expectedVersion: null, changes: { name: 'Ada  Lovelace' }, events: [],
    response: { status: 201, body: { customer: { id: newAggregateId, name: 'Ada  Lovelace' } }, headers: { location: `/api/v1/customers/${newAggregateId}` } },
  });
  // M7A-CUSTOMERS-P4: the detail route exists, so the 201 names it — the one allowlisted, sealed header, and nothing else.
  assert.deepEqual(Object.keys((p as CommandPlan).response.headers ?? {}), ['location']);
  // The planner reads the body alone: the same body under another audience plans the same command.
  assert.deepEqual(planCustomerCreate({ audience: null, body: { name: 'Ada' }, newAggregateId }), planCustomerCreate({ audience: 'tenant', body: { name: 'Ada' }, newAggregateId }));
});

// --- 3. registration -----------------------------------------------------------------------------------------------------

test('the route registers as one POST behind the tenant session and create_customers, requiring idempotency and a trusted context', () => {
  const [route] = defineRoutes([CUSTOMER_CREATE_ROUTE]).list();
  assert.deepEqual({
    method: route.method, path: route.path, policy: route.policy, body: route.body, idempotency: route.idempotency,
    trustedContext: route.trustedContext, recentAuth: route.recentAuth, sessionBinding: route.sessionBinding,
  }, {
    method: 'POST', path: '/api/v1/customers', idempotency: 'required', trustedContext: 'required', recentAuth: 'none', sessionBinding: 'none',
    policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'create_customers' } },
    body: { kind: 'json', maxBytes: 4096, required: true },
  });
  assert.equal(CUSTOMER_CREATE_PERMISSION, 'create_customers');
  assert.ok('command' in route && route.command.contract === CUSTOMER_CREATE_CONTRACT && route.command.plan === planCustomerCreate);
  assert.ok('command' in CUSTOMER_CREATE_ROUTE);
  for (const part of [CUSTOMER_CREATE_ROUTE, CUSTOMER_CREATE_ROUTE.policy, CUSTOMER_CREATE_ROUTE.body, CUSTOMER_CREATE_ROUTE.command,
    CUSTOMER_CREATE_CONTRACT, CUSTOMER_CREATE_CONTRACT.changes, CUSTOMER_CREATE_CONTRACT.events]) {
    assert.ok(Object.isFrozen(part), 'the shared definition is frozen throughout: no importer can change another\'s');
  }
  assert.ok(Object.isFrozen((CUSTOMER_CREATE_ROUTE.policy as { authorization: object }).authorization));
  // Beside the directory's GET on the same literal path: two distinct keys, one table.
  const both = defineRoutes([createCustomerDirectoryRoute({ customers: { page: () => ({ outcome: 'page', customers: [], hasMore: false }) } }), CUSTOMER_CREATE_ROUTE]);
  assert.deepEqual(both.list().map((r) => `${r.method} ${r.path}`), ['GET /api/v1/customers', 'POST /api/v1/customers']);
  assert.equal(CUSTOMER_DIRECTORY_PATH, route.path);
});

test('the contract registers with no event contract at all, and declares the name as 400 UTF-16 units — the record cap it needs', () => {
  const [contract] = defineCommands([CUSTOMER_CREATE_CONTRACT], defineOutboxEvents([])).list();
  assert.deepEqual(contract, {
    kind: 'tenant.customer.create', mode: 'create', aggregateType: 'customer', changes: { name: { type: 'string', maxLength: 400 } }, events: [],
  });
  // The longest legal name — 200 astral scalars — plans, and the runtime prepares it for the store: the schema admits it.
  const newAggregateId = randomUUID();
  const longest = ch(0x1f600).repeat(200);
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const operation = keyring.operationOf(randomUUID(), { authProvider: 'synthetic', authProviderUid: 'uid-a' }, {
    method: 'POST', path: CUSTOMER_DIRECTORY_PATH, audience: 'tenant', tenant: T1, store: null, actor: ACTOR, body: Buffer.from('{}'),
  });
  const prepared = prepareCommand(contract, defineOutboxEvents([]), planCustomerCreate({ audience: 'tenant', body: { name: longest }, newAggregateId }), {
    scope: operation.scope, lease: 'l'.repeat(43), newAggregateId, authorization: { scope: 'tenant', permission: 'create_customers' },
    context: SCOPE, authNotAfter: null, sessionKey: 'k'.repeat(43), seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'prepared');
  assert.deepEqual(prepared.command.mutation, { kind: 'tenant.customer.create', aggregateType: 'customer', aggregateId: newAggregateId, expectedVersion: null, changes: { name: longest } });
  assert.deepEqual({ ...prepared.command.audit, correlationId: '' }, {
    action: 'tenant.customer.create', permission: 'create_customers', scope: 'tenant', tenant: T1, store: null, actor: ACTOR, correlationId: '',
    reasonCode: null, reason: null,
  }, 'the audit record carries the trusted scope and no name');
  assert.deepEqual(prepared.command.events, []);
});

// --- 4. the chain over real loopback sockets, on the tenant boundary --------------------------------------------------------

const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
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
  commits: TransactionCommand[]; authorizations: unknown[][]; logs: string[]; id: string; storeKey: string;
  /** What the authorizer answers from now on; the default is SCOPE, granted. */
  setScope(scope: TrustedScope | false): void;
  setAnswer(answer: 'committed' | 'unavailable'): void;
  /** Preseed a COMPLETED idempotency record for this key and body, holding `sealed` as its response — as an earlier build left it. */
  seedCompleted(key: string, body: string, sealed: (operation: { scope: string; fingerprint: string }) => string): void;
  post(over?: { body?: string; key?: string | null; headers?: Record<string, string> }): Promise<Reply>;
}

async function withChain(fn: (h: Harness) => Promise<void>): Promise<void> {
  const commits: TransactionCommand[] = [];
  const authorizations: unknown[][] = [];
  const logs: string[] = [];
  let scope: TrustedScope | false = SCOPE;
  let answer: 'committed' | 'unavailable' = 'committed';
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const state = createMemoryIdempotencyState();
  const inner = createMemoryIdempotencyStore(state);
  const seedCompleted: Harness['seedCompleted'] = (key, body, sealed) => {
    // The operation this chain derives for the key, principal, trusted scope and exact body bytes (app.ts).
    const operation = keyring.operationOf(key, { authProvider: 'synthetic', authProviderUid: 'uid-customers' }, {
      method: 'POST', path: CUSTOMER_DIRECTORY_PATH, audience: 'tenant', tenant: SCOPE.tenant, store: null, actor: ACTOR, body: Buffer.from(body),
    });
    const t = Date.now();
    state.records.set(operation.scope, {
      fingerprint: operation.fingerprint, lease: 'l'.repeat(43), leaseExpiresAt: t, expiresAt: t + IDEMPOTENCY_POLICY.retentionMs, response: sealed(operation),
    });
  };
  // Commits through the idempotency store's own lease check, as the one-database adapter does.
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      if (answer !== 'committed') return { outcome: answer };
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
    readiness, log: { log: (line: string) => { logs.push(line); } }, sessions: { tenant: boundary }, routes: [CUSTOMER_CREATE_ROUTE],
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
    // The store key the chain derives from the identifier, computed here independently (sessions.ts digestOf).
    const storeKey = createHash('sha256').update(id).digest('base64url');
    authorizations.length = 0;
    const post: Harness['post'] = ({ body = JSON.stringify({ name: 'Ada Lovelace' }), key = randomUUID(), headers = {} } = {}) => request(p, 'POST', CUSTOMER_DIRECTORY_PATH, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: `${SESSION_COOKIES.tenant}=${id}`, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(body)),
      ...(key === null ? {} : { 'idempotency-key': key }), ...headers,
    }, body);
    await fn({ commits, authorizations, logs, id, storeKey, post, setScope: (s) => { scope = s; }, setAnswer: (a) => { answer = a; }, seedCompleted });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const errorOf = (r: Reply): unknown => (JSON.parse(r.body) as { error?: unknown }).error;

test('a committed create answers 201 { customer: { id, name } }, and the port receives the trusted scope and the presenting session', async () => {
  await withChain(async (h) => {
    const r = await h.post({ body: JSON.stringify({ name: '  Ada  Lovelace ' }), headers: { 'x-tenant-id': T2, 'x-role': 'store_owner' } });
    assert.equal(r.status, 201, r.body);
    const { customer } = JSON.parse(r.body) as { customer: { id: string; name: string } };
    assert.deepEqual(Object.keys(JSON.parse(r.body) as object), ['customer']);
    assert.deepEqual(Object.keys(customer), ['id', 'name']);
    assert.match(customer.id, UUID_V4_RE, 'a server-generated v4 id');
    assert.equal(customer.name, 'Ada  Lovelace', 'the name as stored');
    assert.equal(r.headers.location, `/api/v1/customers/${customer.id}`, 'Location names the detail route of the new id (M7A-CUSTOMERS-P4)');
    assert.equal(r.headers['idempotent-replayed'], undefined);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[name.toLowerCase()], value, name);
    assert.deepEqual(h.authorizations.map((a) => a[1]), [{ scope: 'tenant', permission: 'create_customers' }], 'the declared requirement, never one the request names');
    assert.equal(h.commits.length, 1);
    const [c] = h.commits;
    assert.deepEqual(c.mutation, { kind: 'tenant.customer.create', aggregateType: 'customer', aggregateId: customer.id, expectedVersion: null, changes: { name: 'Ada  Lovelace' } });
    assert.deepEqual(c.context, SCOPE, 'the authorizer\'s scope, unchanged by any header');
    assert.equal(c.sessionKey, h.storeKey, 'the presenting session\'s store key, for the store to hold and hand its routine');
    assert.deepEqual([c.audit.action, c.audit.permission, c.audit.scope, c.audit.tenant, c.audit.store, c.audit.actor], ['tenant.customer.create', 'create_customers', 'tenant', T1, null, ACTOR]);
    assert.deepEqual(c.events, []);
    assert.equal(c.unchanged, null, 'a create has no unchanged response');
  });
});

test('the key is bound to the trusted tenant and actor: a same-principal retry replays, the same key in another tenant or as another actor is the 422', async () => {
  await withChain(async (h) => {
    const key = randomUUID();
    const body = JSON.stringify({ name: 'Grace Hopper' });
    const first = await h.post({ key, body });
    assert.equal(first.status, 201, first.body);
    const replay = await h.post({ key, body });
    assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed']], [201, first.body, 'true'], 'replayed byte for byte');
    assert.equal(replay.headers.location, first.headers.location, 'the sealed Location replays with it');
    assert.equal(first.headers.location, `/api/v1/customers/${(JSON.parse(first.body) as { customer: { id: string } }).customer.id}`);
    // The same principal, key and body, after the principal's one tenant grant moved from T1 to T2 — never T1's customer.
    h.setScope({ ...SCOPE, tenant: T2 });
    const moved = await h.post({ key, body });
    assert.deepEqual([moved.status, errorOf(moved)], [422, 'idempotency_key_reused'], moved.body);
    assert.ok(!moved.body.includes((JSON.parse(first.body) as { customer: { id: string } }).customer.id), 'nothing of T1\'s record reaches T2');
    h.setScope({ ...SCOPE, actor: OTHER_ACTOR });
    const other = await h.post({ key, body });
    assert.deepEqual([other.status, errorOf(other)], [422, 'idempotency_key_reused'], 'another resolved actor');
    h.setScope(SCOPE);
    assert.equal((await h.post({ key, body })).body, first.body, 'the original context still replays its own');
    assert.equal(h.commits.length, 1, 'one commit for the key');
    // Two keys with one name are two customers: no uniqueness rule exists.
    const second = await h.post({ body });
    assert.equal(second.status, 201, second.body);
    assert.notEqual(second.body, first.body, 'a distinct id');
    assert.equal(h.commits.length, 2);
  });
});

test('refusals before the store: a denial, a missing or malformed key, a body the contract refuses, malformed JSON — none commits', async () => {
  await withChain(async (h) => {
    const cases: Array<[string, Parameters<Harness['post']>[0], number, string]> = [
      ['no key', { key: null }, 400, 'invalid_request'], ['a malformed key', { key: 'not-a-uuid' }, 400, 'invalid_request'],
      ['a tenant selector', { body: JSON.stringify({ name: 'A', tenantId: T2 }) }, 400, 'invalid_request'],
      ['a client id', { body: JSON.stringify({ name: 'A', id: randomUUID() }) }, 400, 'invalid_request'],
      ['an array', { body: '[]' }, 400, 'invalid_request'], ['an invisible name', { body: JSON.stringify({ name: ch(0x2800) }) }, 400, 'invalid_request'],
      ['a lone surrogate escape', { body: '{"name":"a\\ud800"}' }, 400, 'invalid_request'], ['malformed JSON', { body: '{"name":' }, 400, 'invalid_request'],
      ['no session CSRF', { headers: { [SESSION_CSRF_HEADER]: 'wrong' } }, 403, 'forbidden'],
      ['a cross-site request', { headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'forbidden'],
      ['another origin', { headers: { origin: 'http://admin.trusted.test' } }, 403, 'forbidden'],
      ['an oversized body', { body: JSON.stringify({ name: 'a'.repeat(4_100) }) }, 413, 'content_too_large'],
    ];
    for (const [label, over, status, error] of cases) {
      const r = await h.post(over);
      assert.deepEqual([r.status, errorOf(r)], [status, error], `${label}: ${r.body}`);
      assert.deepEqual(Object.keys(JSON.parse(r.body) as object).sort(), ['error', 'requestId'], `${label}: bounded`);
    }
    h.setScope(false);
    const denied = await h.post();
    assert.deepEqual([denied.status, errorOf(denied)], [403, 'forbidden'], 'an authorizer denial (the real create_customers decision: m5CanonicalPermissions.test.ts)');
    assert.equal(h.commits.length, 0, 'nothing reached the transaction port');
  });
});

test('a refusal inside the transaction is a bounded 503 that is never replayed, and no log line carries the name, key, cookie or session key', async () => {
  await withChain(async (h) => {
    const name = 'Canary Quux 7f3a';
    const key = randomUUID();
    h.setAnswer('unavailable');
    const refused = await h.post({ key, body: JSON.stringify({ name }) });
    assert.deepEqual([refused.status, errorOf(refused)], [503, 'service_unavailable'], refused.body);
    assert.ok(!refused.body.includes(name), 'the 503 names nothing');
    h.setAnswer('committed');
    const retry = await h.post({ key, body: JSON.stringify({ name }) });
    assert.deepEqual([retry.status, errorOf(retry), h.commits.length], [409, 'request_in_progress', 1], 'no replay and no second commit while the lease holds');
    const created = await h.post({ body: JSON.stringify({ name }) });
    assert.equal(created.status, 201, created.body);
    assert.ok(h.logs.length > 0 && h.logs.some((line) => line.includes(String(created.headers['x-request-id']))), 'the chain logged its requests (control)');
    for (const line of h.logs) {
      for (const secret of [name, key, h.id, h.storeKey]) assert.ok(!line.includes(secret), `a log line carries ${secret.slice(0, 6)}...`);
    }
  });
});

test('a completion sealed BEFORE M7A-CUSTOMERS-P4 replays on its first request with this build: 201, the sealed body, no Location, nothing committed', async () => {
  await withChain(async (h) => {
    const key = randomUUID();
    const body = JSON.stringify({ name: 'Legacy Customer' });
    const id = randomUUID();
    const sealedBody = JSON.stringify({ customer: { id, name: 'Legacy Customer' } });
    // EXACTLY what the pre-change build sealed for a create, written out as a literal — not derived from this build's plan.
    // Before M7A-CUSTOMERS-P4 the plan's response was { status: 201, body } with no `headers`, and idempotency.ts (unchanged
    // by this change) recorded it as the four fields { status, contentType, headers, body } with `headers` the EMPTY object
    // (envelopeFromOutcome: `headers === undefined ? {} : headers`). A sealed envelope with no `headers` member at all was
    // never written by any build: envelopeOf refuses one on read, so it could not replay (asserted below).
    const preChange = { status: 201, contentType: 'application/json; charset=utf-8', headers: {}, body: sealedBody };
    assert.deepEqual(envelopeFromOutcome({ status: 201, body: { customer: { id, name: 'Legacy Customer' } } }), preChange,
      'the literal is the pre-change plan\'s envelope, byte for byte');
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    let operation: { scope: string; fingerprint: string } | null = null;
    h.seedCompleted(key, body, (op) => { operation = op; return keyring.seal(preChange, op); });
    assert.ok(operation !== null);
    assert.equal(keyring.unseal(keyring.seal({ status: 201, contentType: preChange.contentType, body: sealedBody } as never, operation), operation), null,
      'an envelope lacking `headers` does not unseal: no build could have left one to replay');
    // The FIRST request with the key is a replay: the sealed 201, no Location, no commit, no port call.
    const first = await h.post({ key, body });
    assert.deepEqual([first.status, first.body, first.headers['idempotent-replayed']], [201, sealedBody, 'true'], first.body);
    assert.equal(first.headers.location, undefined, 'a pre-change completion replays without Location, exactly as committed');
    assert.equal(h.commits.length, 0, 'nothing planned, committed or sent to the port');
    // A key sealed by this build replays its Location.
    const newKey = randomUUID();
    const fresh = await h.post({ key: newKey, body });
    const again = await h.post({ key: newKey, body });
    assert.equal(fresh.headers.location, `/api/v1/customers/${(JSON.parse(fresh.body) as { customer: { id: string } }).customer.id}`);
    assert.deepEqual([again.headers['idempotent-replayed'], again.headers.location, again.body], ['true', fresh.headers.location, fresh.body]);
    assert.equal(h.commits.length, 1, 'one commit: the new key\'s first request');
  });
});
