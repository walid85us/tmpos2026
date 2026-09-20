// Phase 4.0 M5-GIAM-D1-P1 — the tenant display-name command through the runtime: the planner's input contract, the
// route's registration, and the whole enforced chain over real loopback sockets — admin session, CSRF and origin, the
// authorizer's trusted scope, the 400 that records nothing, the command handed to the transaction port,
// every port answer, replay and key reuse, the security headers and the log.
//
// Synthetic principals, keys, stores and ports only. The transaction port here is a recording stand-in whose lease
// check is the idempotency store's own; the real PostgreSQL store is proved in tests/db/tenantDisplayName.integration.
// Special characters are built from code points so this source stays ASCII.
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
import type { CommandPlan } from './routes.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import {
  TENANT_DISPLAY_NAME_CONTRACT, TENANT_DISPLAY_NAME_EVENTS, TENANT_DISPLAY_NAME_PATH, TENANT_DISPLAY_NAME_ROUTE,
  normalizeTenantDisplayName, planTenantDisplayName,
} from './tenantDisplayName.js';

const T0 = 1_700_000_000_000;
const TENANT = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const OTHER_TENANT = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const unit = (code: number): string => String.fromCharCode(code); // a lone UTF-16 unit, for surrogates

// --- 1. the planner's input contract --------------------------------------------------------------------------------------

const plan = (body: unknown) => planTenantDisplayName({ audience: 'admin', body, newAggregateId: randomUUID() });
/** Every code point with the Unicode Bidi_Control property, listed as migration 009's operation lists them. */
const BIDI_CONTROLS: readonly number[] = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ tenantId: TENANT, displayName: 'Acme Repairs', expectedVersion: 3, ...over });

test('a body the contract refuses plans nothing: COMMAND_REQUEST_INVALID for every malformed shape, field and name', () => {
  const invalid: Array<[string, unknown]> = [
    ['null', null], ['an array', [valid()]], ['a string', 'x'], ['a number', 1], ['undefined', undefined], ['true', true],
    ['no tenantId', { displayName: 'A', expectedVersion: 1 }], ['no displayName', { tenantId: TENANT, expectedVersion: 1 }],
    ['no expectedVersion', { tenantId: TENANT, displayName: 'A' }], ['an extra field', valid({ extra: 1 })],
    ['a role', valid({ role: 'system_owner' })], ['an actor', valid({ actor: ACTOR })], ['a scope', valid({ scope: 'platform' })],
    ['a tenant selector', valid({ tenant: OTHER_TENANT })],
    ['an own __proto__ key', JSON.parse(`{"tenantId":"${TENANT}","displayName":"A","expectedVersion":1,"__proto__":{"x":1}}`)],
    ['__proto__ in place of a field', JSON.parse(`{"tenantId":"${TENANT}","displayName":"A","__proto__":1}`)],
    // tenantId: canonical lowercase UUID, versions 1-8, variant 8-b.
    ['an uppercase tenantId', valid({ tenantId: TENANT.toUpperCase() })], ['a non-UUID tenantId', valid({ tenantId: 'not-a-uuid' })],
    ['an empty tenantId', valid({ tenantId: '' })], ['a version-0 tenantId', valid({ tenantId: '3f0c2a8e-9b1d-0c7e-8a2f-5d6e7f8a9b0c' })],
    ['a bad-variant tenantId', valid({ tenantId: '3f0c2a8e-9b1d-4c7e-7a2f-5d6e7f8a9b0c' })], ['a braced tenantId', valid({ tenantId: `{${TENANT}}` })],
    ['a numeric tenantId', valid({ tenantId: 123 })], ['a null tenantId', valid({ tenantId: null })],
    // expectedVersion: a positive safe integer below MAX_SAFE_INTEGER.
    ['version 0', valid({ expectedVersion: 0 })], ['version -1', valid({ expectedVersion: -1 })], ['version 1.5', valid({ expectedVersion: 1.5 })],
    ['version "1"', valid({ expectedVersion: '1' })], ['version MAX_SAFE_INTEGER', valid({ expectedVersion: Number.MAX_SAFE_INTEGER })],
    ['version NaN', valid({ expectedVersion: Number.NaN })], ['version Infinity', valid({ expectedVersion: Number.POSITIVE_INFINITY })],
    ['version null', valid({ expectedVersion: null })], ['version true', valid({ expectedVersion: true })],
    // displayName: a string, 1-120 scalars once trimmed, no control character, separator or lone surrogate.
    ['a numeric name', valid({ displayName: 5 })], ['a null name', valid({ displayName: null })], ['an array name', valid({ displayName: ['A'] })],
    ['an object name', valid({ displayName: {} })], ['an empty name', valid({ displayName: '' })], ['a whitespace-only name', valid({ displayName: ' \t\n ' })],
    ['a 121-scalar name', valid({ displayName: 'a'.repeat(121) })], ['121 astral scalars', valid({ displayName: ch(0x1f600).repeat(121) })],
    ['an inner NUL', valid({ displayName: `A${ch(0)}B` })], ['a leading NUL', valid({ displayName: `${ch(0)}A` })], ['a trailing NUL', valid({ displayName: `A${ch(0)}` })],
    ['a C0 control', valid({ displayName: `A${ch(1)}B` })], ['an inner tab', valid({ displayName: `A${ch(9)}B` })], ['an inner newline', valid({ displayName: `A${ch(10)}B` })],
    ['an inner carriage return', valid({ displayName: `A${ch(13)}B` })], ['DEL', valid({ displayName: `A${ch(0x7f)}B` })],
    ['a C1 control (NEL)', valid({ displayName: `A${ch(0x85)}B` })], ['a leading C1 control', valid({ displayName: `${ch(0x9f)}A` })],
    ['a line separator', valid({ displayName: `A${ch(0x2028)}B` })], ['a paragraph separator', valid({ displayName: `A${ch(0x2029)}B` })],
    ['a lone high surrogate', valid({ displayName: `A${unit(0xd800)}B` })], ['a lone low surrogate', valid({ displayName: `A${unit(0xdc00)}` })],
    // Bidi_Control (M5-GIAM-D1-P1-R1): marks, embeddings, overrides and isolates, anywhere in the name.
    ...BIDI_CONTROLS.map((code): [string, unknown] => [`Bidi_Control U+${code.toString(16).toUpperCase().padStart(4, '0')}`, valid({ displayName: `A${ch(code)}B` })]),
    ['a right-to-left override spoofing an extension', valid({ displayName: `invoice${ch(0x202e)}fdp.exe` })],
    ['a leading left-to-right mark', valid({ displayName: `${ch(0x200e)}Acme` })], ['a trailing isolate terminator', valid({ displayName: `Acme${ch(0x2069)}` })],
  ];
  for (const [label, body] of invalid) assert.equal(plan(body), COMMAND_REQUEST_INVALID, label);
});

test('a valid name is trimmed at its edges and otherwise kept exactly: internal whitespace, Unicode and its bounds', () => {
  const nameOf = (displayName: unknown): unknown => (plan(valid({ displayName })) as CommandPlan).changes.displayName;
  assert.equal(nameOf(`  Acme${ch(9)}${ch(10)}`), 'Acme', 'spaces, a tab and a newline at the edges are trimmed');
  assert.equal(nameOf(`${ch(0xa0)}Acme${ch(0x3000)}`), 'Acme', 'NBSP and an ideographic space at the edges are trimmed');
  assert.equal(nameOf(`${ch(0x2028)}Acme${ch(0x2029)}`), 'Acme', 'a separator at an edge is whitespace, trimmed before the check');
  assert.equal(nameOf('Acme  Repairs'), 'Acme  Repairs', 'a double internal space is kept');
  assert.equal(nameOf(`Acme${ch(0xa0)}Repairs`), `Acme${ch(0xa0)}Repairs`, 'an internal NBSP is kept');
  const unicode = `Caf${ch(0xe9)} ${ch(0x4fee, 0x7406)} ${ch(0x1f527)}`;
  assert.equal(nameOf(unicode), unicode, 'accents, CJK and emoji are kept');
  const nfd = `Cafe${ch(0x301)}`;
  assert.equal(nameOf(nfd), nfd, 'no normalization: NFD stays NFD');
  assert.notEqual(nameOf(nfd), `Caf${ch(0xe9)}`);
  assert.equal(nameOf('A'), 'A', 'one scalar');
  assert.equal(nameOf('a'.repeat(120)), 'a'.repeat(120), '120 scalars');
  const astral = ch(0x1f600).repeat(120);
  assert.equal(astral.length, 240);
  assert.equal(nameOf(astral), astral, '120 astral scalars are 240 UTF-16 units, and allowed');
  assert.equal(nameOf(`${' '.repeat(50)}${'b'.repeat(120)}${' '.repeat(50)}`), 'b'.repeat(120), 'padding does not count toward the bound');
  // The normalizer on its own agrees, and refuses what is not a string.
  for (const raw of [undefined, null, 1, true, {}, ['A']]) assert.equal(normalizeTenantDisplayName(raw), null, String(raw));
  assert.equal(normalizeTenantDisplayName('  Acme '), 'Acme');
});

test('the plan: the tenant as the aggregate at its expected version, the name alone, one event, and both 200 representations', () => {
  const p = plan(valid({ displayName: '  Acme  Repairs ' }));
  assert.deepEqual(p, {
    aggregateId: TENANT,
    expectedVersion: 3,
    changes: { displayName: 'Acme  Repairs' },
    events: [{ type: 'tenant.display_name_changed', payload: { displayName: 'Acme  Repairs' } }],
    response: { status: 200, body: { tenantId: TENANT, displayName: 'Acme  Repairs', version: 4 } },
    unchanged: { status: 200, body: { tenantId: TENANT, displayName: 'Acme  Repairs', version: 3 } },
  });
  const top = plan(valid({ expectedVersion: Number.MAX_SAFE_INTEGER - 1 })) as CommandPlan;
  assert.equal((top.response.body as { version: number }).version, Number.MAX_SAFE_INTEGER, 'the largest version the runtime carries exactly');
  // A name may repeat across tenants: the planner judges one body, never another tenant.
  const other = plan(valid({ tenantId: OTHER_TENANT })) as CommandPlan;
  assert.equal(other.changes.displayName, 'Acme Repairs');
  // The planner reads the body alone: the same body plans the same command whatever the audience or aggregate ID.
  assert.deepEqual(planTenantDisplayName({ audience: null, body: valid(), newAggregateId: randomUUID() }), plan(valid()));
});

// --- 2. registration --------------------------------------------------------------------------------------------------------

test('the route registers as one PATCH behind the admin session and edit_tenant_profile, requiring idempotency, with its command', () => {
  const [route] = defineRoutes([TENANT_DISPLAY_NAME_ROUTE]).list();
  assert.deepEqual({ method: route.method, path: route.path, policy: route.policy, body: route.body, idempotency: route.idempotency }, {
    method: 'PATCH', path: '/admin/v1/tenants/display-name', idempotency: 'required',
    policy: { access: 'session', audience: 'admin', authorization: { scope: 'platform', permission: 'edit_tenant_profile' } },
    body: { kind: 'json', maxBytes: 4096, required: true },
  });
  assert.equal(TENANT_DISPLAY_NAME_PATH, route.path);
  assert.ok('command' in route && route.command.contract === TENANT_DISPLAY_NAME_CONTRACT && route.command.plan === planTenantDisplayName);
  assert.ok(Object.isFrozen(TENANT_DISPLAY_NAME_ROUTE));
  const [contract] = defineCommands([TENANT_DISPLAY_NAME_CONTRACT], defineOutboxEvents(TENANT_DISPLAY_NAME_EVENTS)).list();
  assert.deepEqual(contract, {
    kind: 'platform.tenant.display_name.update', mode: 'update', aggregateType: 'tenant',
    changes: { displayName: { type: 'string', maxLength: 240 } }, events: [{ type: 'tenant.display_name_changed', version: 1 }],
  });
  assert.deepEqual(TENANT_DISPLAY_NAME_EVENTS.map((e) => [e.type, e.version, e.aggregateType, e.payload]),
    [['tenant.display_name_changed', 1, 'tenant', { displayName: { type: 'string', maxLength: 240 } }]]);
});

test('startup refuses the route without its event contracts, and without the transaction port', () => {
  const base = {
    readiness: createReadinessState(), sessions: { admin: adminBoundary({ authorizations: [] }, () => true) }, routes: [TENANT_DISPLAY_NAME_ROUTE],
    limits: testRequestLimits(), idempotency: { store: createMemoryIdempotencyStore(), keySecret: TEST_IDEMPOTENCY_KEY },
  };
  const transactions = { port: { commit: () => ({ outcome: 'committed' }), probe: () => true } };
  assert.throws(() => createApp({ ...base, transactions }), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_registry_invalid');
  assert.throws(() => createApp({ ...base, events: TENANT_DISPLAY_NAME_EVENTS }), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_transaction_required');
  assert.doesNotThrow(() => createApp({ ...base, events: TENANT_DISPLAY_NAME_EVENTS, transactions }));
});

// --- 3. the chain over real loopback sockets ------------------------------------------------------------------------------

const ADMIN_ORIGIN = 'http://admin.trusted.test';
const BEARER = 'tok-admin-5e2a';
const UID = 'uid-admin-5e2a';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-5e2a', scope: 'platform', tenant: null, store: null,
  membershipId: '5c4b3a29-1807-4f6e-9d5c-4b3a29180706', roleId: 'support_admin', limitation: 'none',
});
const GRANTED = Object.freeze({ granted: true, context: SCOPE });

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
type Answer = 'committed' | 'conflict' | 'not_found' | 'unchanged' | 'lease_lost' | 'unavailable' | 'throw';
interface Recorder { authorizations: unknown[][] }

function adminBoundary(rec: Recorder, authorize: (...args: unknown[]) => unknown): SessionBoundaryDeps {
  return {
    trustedOrigins: [ADMIN_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: UID, authenticatedAt: T0, secondFactor: 'totp' }
          : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1' }) },
    authorizer: { authorize: (...args: unknown[]) => { rec.authorizations.push(args); return authorize(...args); } },
    store: createMemorySessionStore(),
  };
}

/** One request on its own connection. `chunks` streams the body chunked, with no Content-Length. */
function request(port: number, method: string, path: string, headers: Record<string, string>, body?: string, chunks?: string[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (chunks !== undefined) { for (const c of chunks) req.write(c); req.end(); } else req.end(body);
  });
}

interface Harness {
  port: number; logs: string[]; rec: Recorder; commits: TransactionCommand[]; storeCalls: string[]; id: string; csrf: string;
  setAnswer(answer: Answer): void;
  /** PATCH the route as the signed-in admin; a header set to null is left out. */
  patch(over?: { body?: string; key?: string | null; headers?: Record<string, string | null>; chunks?: string[] }): Promise<Reply>;
}
interface Setup { answer?: Answer; authorize?: (...args: unknown[]) => unknown; probe?: () => unknown }

async function withRoute(setup: Setup, fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const rec: Recorder = { authorizations: [] };
  const commits: TransactionCommand[] = [];
  const storeCalls: string[] = [];
  const inner = createMemoryIdempotencyStore();
  const store: DurableIdempotencyStore = {
    acquire: (r, s) => { storeCalls.push('acquire'); return inner.acquire(r, s); },
    complete: (r, s) => { storeCalls.push('complete'); return inner.complete(r, s); },
    probe: (s) => { storeCalls.push('probe'); return inner.probe(s); },
  };
  let answer: Answer = setup.answer ?? 'committed';
  // Commits through the idempotency store's own lease check, as the one-database adapter does.
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      if (answer === 'throw') throw new Error('store-secret-detail');
      if (answer === 'unchanged') {
        // As the store does since M5-GIAM-D1-P1-R1: the no-op's sealed response IS the completion, recorded in the one commit.
        if (c.unchanged === null) return { outcome: 'unavailable' };
        const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: c.unchanged }), s);
        return { outcome: (done as { outcome?: unknown }).outcome === 'completed' ? 'unchanged' : 'lease_lost' };
      }
      if (answer !== 'committed') return { outcome: answer };
      const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: c.response }), s);
      return { outcome: (done as { outcome?: unknown }).outcome === 'completed' ? 'committed' : 'lease_lost' };
    },
    probe: () => { storeCalls.push('port.probe'); return setup.probe === undefined ? true : setup.probe(); },
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, now: () => T0, log: { log: (line: string) => { logs.push(line); } },
    sessions: { admin: adminBoundary(rec, setup.authorize ?? (() => GRANTED)) },
    routes: [TENANT_DISPLAY_NAME_ROUTE], events: TENANT_DISPLAY_NAME_EVENTS, limits: testRequestLimits(),
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
    const patch: Harness['patch'] = ({ body = JSON.stringify(valid()), key = randomUUID(), headers = {}, chunks } = {}) => {
      const all: Record<string, string | null> = {
        origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        cookie: `${SESSION_COOKIES.admin}=${id}`, [SESSION_CSRF_HEADER]: csrf, 'idempotency-key': key,
        ...(chunks === undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers,
      };
      const sent = Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== null));
      return request(p, 'PATCH', TENANT_DISPLAY_NAME_PATH, sent, body, chunks);
    };
    storeCalls.length = 0;
    await fn({ port: p, logs, rec, commits, storeCalls, id, csrf, setAnswer: (a) => { answer = a; }, patch });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

function assertPolicyHeaders(r: Reply, label: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[name.toLowerCase()], value, `${label}: ${name}`);
  assert.match(String(r.headers['x-request-id']), /^[A-Za-z0-9._-]{8,128}$/, `${label}: X-Request-Id`);
}
/** A bounded refusal: the status, exactly `{ error, requestId }`, and the header policy. */
function assertRefusal(r: Reply, status: number, error: string, label: string): void {
  assert.equal(r.status, status, `${label}: ${r.body}`);
  const body = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], label);
  assert.equal(body.error, error, label);
  assertPolicyHeaders(r, label);
}
/** The request-log reasons once `count` records have flushed (the login's included). */
async function reasons(logs: string[], count: number): Promise<unknown[]> {
  const records = (): Array<Record<string, unknown>> => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.event === 'request');
  for (let i = 0; i < 200 && records().length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return records().map((r) => r.reason);
}

test('no session, a bad session CSRF, a bad origin or intent, or a denial refuses before the body is read and before any record', async () => {
  const deniedBody = JSON.stringify({ tenantId: 'not-a-uuid', displayName: '', expectedVersion: 0 }); // invalid: never judged
  const oversize = ['{"tenantId":"', 'x'.repeat(5_000), '"}']; // past maxBytes, streamed chunked: judged only once read
  await withRoute({}, async (h) => {
    assertRefusal(await h.patch({ headers: { cookie: null } }), 401, 'unauthenticated', 'no session');
    assertRefusal(await h.patch({ headers: { cookie: `${SESSION_COOKIES.admin}=${'A'.repeat(43)}` } }), 401, 'unauthenticated', 'an unknown session');
    assertRefusal(await h.patch({ headers: { cookie: null }, body: deniedBody }), 401, 'unauthenticated', 'no session, invalid body');
    assertRefusal(await h.patch({ headers: { cookie: null }, chunks: oversize }), 401, 'unauthenticated', 'no session, a streamed oversize body');
    assertRefusal(await h.patch({ headers: { [SESSION_CSRF_HEADER]: null } }), 403, 'forbidden', 'no session CSRF');
    assertRefusal(await h.patch({ headers: { [SESSION_CSRF_HEADER]: 'B'.repeat(43) } }), 403, 'forbidden', 'a wrong session CSRF');
    assertRefusal(await h.patch({ headers: { [CSRF_HEADER]: null } }), 403, 'forbidden', 'no intent header');
    assertRefusal(await h.patch({ headers: { origin: 'http://evil.test' } }), 403, 'forbidden', 'a foreign origin');
    assertRefusal(await h.patch({ headers: { 'sec-fetch-site': 'cross-site' } }), 403, 'forbidden', 'cross-site');
    assert.equal(h.rec.authorizations.length, 0, 'none of these reached the authorizer');
    assert.deepEqual([h.storeCalls, h.commits.length], [[], 0], 'no idempotency record, no commit');
    // A declared Content-Length over the cap is judged from headers alone, ahead of any session (chain step 4):
    // no byte is read and nothing about a tenant is consulted, so it discloses nothing.
    assertRefusal(await h.patch({ headers: { cookie: null }, body: 'x'.repeat(4_097) }), 413, 'content_too_large', 'a declared oversize body');
  });
  for (const [label, authorize, status, error] of [
    ['a denial', () => false, 403, 'forbidden'],
    ['a non-boolean answer', () => 'yes', 403, 'forbidden'],
    ['an authorizer that throws', () => { throw new Error('authz-secret-detail'); }, 503, 'service_unavailable'],
  ] as const) {
    await withRoute({ authorize }, async (h) => {
      assertRefusal(await h.patch(), status, error, label);
      assertRefusal(await h.patch({ body: deniedBody }), status, error, `${label}: an invalid body is never judged`);
      assertRefusal(await h.patch({ chunks: oversize }), status, error, `${label}: a streamed oversize body is never read`);
      assertRefusal(await h.patch({ body: '{"broken":' }), status, error, `${label}: malformed JSON is never parsed`);
      assert.equal(h.rec.authorizations.length, 4, label);
      assert.deepEqual([h.storeCalls, h.commits.length], [[], 0], `${label}: no record, no commit, so no tenant is ever looked up`);
      assert.doesNotMatch(h.logs.join(''), /authz-secret-detail/);
    });
  }
});

test('a body the contract refuses is a 400 that commits and records nothing; a missing or malformed key is refused before any record', async () => {
  await withRoute({}, async (h) => {
    const refused: Array<[string, string]> = [
      ['an extra field', JSON.stringify(valid({ role: 'system_owner' }))], ['an actor', JSON.stringify(valid({ actor: ACTOR }))],
      ['a scope', JSON.stringify(valid({ scope: 'tenant', tenant: OTHER_TENANT }))], ['an uppercase tenantId', JSON.stringify(valid({ tenantId: TENANT.toUpperCase() }))],
      ['version 0', JSON.stringify(valid({ expectedVersion: 0 }))], ['version "1"', JSON.stringify(valid({ expectedVersion: '1' }))],
      ['a blank name', JSON.stringify(valid({ displayName: '   ' }))], ['a 121-scalar name', JSON.stringify(valid({ displayName: 'a'.repeat(121) }))],
      ['a NUL', JSON.stringify(valid({ displayName: `A${ch(0)}B` }))], ['a C1 control', JSON.stringify(valid({ displayName: `A${ch(0x85)}B` }))],
      ['a lone surrogate', `{"tenantId":"${TENANT}","displayName":"A\\ud800B","expectedVersion":3}`], ['an array', '[]'], ['null', 'null'],
    ];
    for (const [label, body] of refused) assertRefusal(await h.patch({ body }), 400, 'invalid_request', label);
    assertRefusal(await h.patch({ body: '{"broken":' }), 400, 'invalid_request', 'malformed JSON');
    assertRefusal(await h.patch({ key: null }), 400, 'invalid_request', 'no Idempotency-Key');
    assertRefusal(await h.patch({ key: 'not-a-uuid' }), 400, 'invalid_request', 'a malformed key');
    assertRefusal(await h.patch({ key: randomUUID().replace(/^(.{14})4/, '$11') }), 400, 'invalid_request', 'a key that is not version 4');
    // Each refused body acquired its own key's record and recorded nothing on it; malformed JSON and a bad key never reach the store.
    assert.deepEqual([h.storeCalls, h.commits.length], [refused.map(() => 'acquire'), 0], 'one acquisition per refused body, no completion, nothing reached the port');
    const logged = await reasons(h.logs, 1 + refused.length + 4);
    assert.deepEqual(logged.slice(1, 1 + refused.length), refused.map(() => 'command_request_invalid'));
    assert.deepEqual(logged.slice(1 + refused.length), ['body_malformed', 'idempotency_key_missing', 'idempotency_key_invalid', 'idempotency_key_invalid']);
    // A valid key in any case still names one operation: an uppercase one is accepted.
    assert.equal((await h.patch({ key: randomUUID().toUpperCase() })).status, 200);
    // A key a refused body holds stays bound to that body: its bytes wait on the lease, anything else is the key-reuse conflict.
    const held = randomUUID();
    const bad = JSON.stringify(valid({ displayName: '   ' }));
    assertRefusal(await h.patch({ key: held, body: bad }), 400, 'invalid_request', 'refused');
    assertRefusal(await h.patch({ key: held, body: bad }), 409, 'request_in_progress', 'same bytes');
    assertRefusal(await h.patch({ key: held }), 422, 'idempotency_key_reused', 'a valid body under the held key');
  });
});

test('a key already spent by a committed update answers any other body — malformed included — with the 422 key-reuse conflict', async () => {
  await withRoute({}, async (h) => {
    const key = randomUUID();
    assert.equal((await h.patch({ key })).status, 200);
    const commits = h.commits.length;
    for (const [label, body] of [
      ['a blank name', JSON.stringify(valid({ displayName: '   ' }))], ['an extra field', JSON.stringify(valid({ role: 'system_owner' }))],
      ['another valid name', JSON.stringify(valid({ displayName: 'Other' }))],
    ] as const) assertRefusal(await h.patch({ key, body }), 422, 'idempotency_key_reused', label);
    assert.equal(h.commits.length, commits, 'nothing else reached the port');
  });
});

test('a committed update answers exactly its representation, and the port receives the authorizer\'s trusted scope and nothing the request named', async () => {
  await withRoute({}, async (h) => {
    const spoof = { 'x-actor-id': randomUUID(), 'x-internal-user-id': randomUUID(), 'x-role': 'system_owner', 'x-tenant-id': OTHER_TENANT, 'x-permission': 'manage_platform_roles' };
    const r = await h.patch({ body: JSON.stringify(valid({ displayName: '  Acme  Repairs ' })), headers: spoof });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.body, JSON.stringify({ tenantId: TENANT, displayName: 'Acme  Repairs', version: 4 }), 'exactly the three fields');
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(r.headers['idempotent-replayed'], undefined);
    assertPolicyHeaders(r, 'success');
    // The authorizer saw the verified principal, the route's own requirement and the route view — never the spoofed headers.
    assert.equal(h.rec.authorizations.length, 1);
    const [principal, requirement, view] = h.rec.authorizations[0];
    assert.deepEqual(principal, { authProvider: 'synthetic', authProviderUid: UID });
    assert.deepEqual(requirement, { scope: 'platform', permission: 'edit_tenant_profile' });
    assert.deepEqual(view, { method: 'PATCH', path: TENANT_DISPLAY_NAME_PATH, audience: 'admin' });
    assert.equal(h.commits.length, 1);
    const [c] = h.commits;
    assert.deepEqual(c.context, SCOPE, 'the command carries the scope the authorizer decided on');
    assert.notEqual(c.context, SCOPE, 'as a copy, never the authorizer\'s own object');
    assert.deepEqual(c.mutation, {
      kind: 'platform.tenant.display_name.update', aggregateType: 'tenant', aggregateId: TENANT, expectedVersion: 3, changes: { displayName: 'Acme  Repairs' },
    }, 'only displayName changes');
    assert.deepEqual({ ...c.audit, correlationId: '' }, {
      action: 'platform.tenant.display_name.update', permission: 'edit_tenant_profile', scope: 'platform', tenant: null, store: null, actor: ACTOR, correlationId: '',
      // This command records no sensitive reason, so the bounded pair stays null and the store writes its fixed one.
      reasonCode: null, reason: null,
    }, 'the audit names the resolved actor, at platform scope');
    assert.equal(c.events.length, 1, 'exactly one event');
    const [e] = c.events;
    assert.deepEqual({ type: e.type, version: e.version, aggregateType: e.aggregateType, aggregateId: e.aggregateId, aggregateVersion: e.aggregateVersion, tenant: e.tenant, store: e.store, actor: e.actor, payload: e.payload }, {
      type: 'tenant.display_name_changed', version: 1, aggregateType: 'tenant', aggregateId: TENANT, aggregateVersion: 4, tenant: null, store: null, actor: null,
      payload: { displayName: 'Acme  Repairs' },
    }, 'the event names no actor: the audit record does');
    assert.equal(e.correlationId, c.audit.correlationId, 'the event and the audit share one correlation');
    const crossed = JSON.stringify(h.commits);
    for (const spoofed of Object.values(spoof)) assert.ok(!crossed.includes(spoofed), `${spoofed} never crosses the port`);
    assert.deepEqual(h.storeCalls, ['acquire'], 'one acquisition; the commit completes the record');
  });
});

test('an exact retry replays the recorded response byte for byte without a second commit; the key with another request is a 422', async () => {
  await withRoute({}, async (h) => {
    const key = randomUUID();
    const body = JSON.stringify(valid());
    const first = await h.patch({ key, body });
    assert.equal(first.status, 200);
    for (const retry of [await h.patch({ key, body }), await h.patch({ key: key.toUpperCase(), body })]) {
      assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [200, first.body, 'true']);
      assertPolicyHeaders(retry, 'replay');
    }
    assert.equal(h.commits.length, 1, 'one commit, whatever the retries');
    for (const changed of [JSON.stringify(valid({ displayName: 'Other' })), JSON.stringify(valid({ tenantId: OTHER_TENANT })), JSON.stringify(valid({ expectedVersion: 4 }))]) {
      assertRefusal(await h.patch({ key, body: changed }), 422, 'idempotency_key_reused', changed);
    }
    assert.equal(h.commits.length, 1, 'a reused key commits nothing');
  });
});

test('each store answer maps to its response: 409, 404, the unchanged 200 (recorded and replayed), and a 503 for everything else', async () => {
  await withRoute({ answer: 'conflict' }, async (h) => {
    assertRefusal(await h.patch(), 409, 'write_conflict', 'another version');
    h.setAnswer('not_found');
    const missing = await h.patch();
    assertRefusal(missing, 404, 'not_found', 'no such tenant');
    const routeMiss = await request(h.port, 'PATCH', '/admin/v1/tenants/no-such-route', {
      origin: ADMIN_ORIGIN, 'content-type': 'application/json', 'content-length': '2',
    }, '{}');
    assertRefusal(routeMiss, 404, 'not_found', 'a route miss');
    assert.deepEqual(Object.keys(JSON.parse(missing.body)).sort(), Object.keys(JSON.parse(routeMiss.body)).sort(), 'a missing tenant reads like any 404');
    h.setAnswer('unchanged');
    const key = randomUUID();
    const unchanged = await h.patch({ key });
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body, JSON.stringify({ tenantId: TENANT, displayName: 'Acme Repairs', version: 3 }), 'the current version: nothing moved');
    assert.equal(unchanged.headers['idempotent-replayed'], undefined);
    assertPolicyHeaders(unchanged, 'unchanged');
    const commitsBefore = h.commits.length;
    assert.deepEqual(h.storeCalls.slice(-1), ['acquire'], 'the runtime makes no completion of its own: the commit recorded it (M5-GIAM-D1-P1-R1)');
    const sealed = h.commits[commitsBefore - 1].unchanged;
    assert.ok(sealed !== null && sealed !== h.commits[commitsBefore - 1].response, 'the command carried the sealed unchanged response');
    const again = await h.patch({ key });
    assert.deepEqual([again.status, again.body, again.headers['idempotent-replayed']], [200, unchanged.body, 'true'], 'and replays');
    assert.equal(h.commits.length, commitsBefore, 'a replay commits nothing');
    for (const answer of ['lease_lost', 'unavailable', 'throw'] as const) {
      h.setAnswer(answer);
      assertRefusal(await h.patch(), 503, 'service_unavailable', answer);
    }
    const logged = await reasons(h.logs, 9);
    assert.deepEqual(logged.slice(1, 3), ['transaction_conflict', 'transaction_not_found']);
    assert.deepEqual(logged.slice(-3), ['transaction_lease_lost', 'transaction_unavailable', 'transaction_unavailable']);
    assert.doesNotMatch(h.logs.join(''), /store-secret-detail/);
  });
});

test('a granted answer is trusted only as a whole trusted scope at the route\'s own scope; a bare true cannot authorize the command', async () => {
  const refused: Array<[string, unknown]> = [
    ['a tenant-scope context', { granted: true, context: { ...SCOPE, scope: 'tenant', tenant: OTHER_TENANT } }],
    ['a store-scope context', { granted: true, context: { ...SCOPE, scope: 'store', tenant: OTHER_TENANT, store: randomUUID() } }],
    ['a malformed actor', { granted: true, context: { ...SCOPE, actor: 'not-a-uuid' } }],
    ['a platform scope naming a tenant', { granted: true, context: { ...SCOPE, tenant: OTHER_TENANT } }],
    ['a context-less grant', { granted: true }], ['a non-true grant', { granted: 'yes', context: SCOPE }],
    ['an extra field', { granted: true, context: SCOPE, role: 'system_owner' }], ['a null context', { granted: true, context: null }],
    ['a class instance', Object.assign(Object.create({ granted: true }), { context: SCOPE })],
  ];
  for (const [label, answer] of refused) {
    await withRoute({ authorize: () => answer }, async (h) => {
      assertRefusal(await h.patch(), 403, 'forbidden', label);
      assert.deepEqual([h.storeCalls, h.commits.length], [[], 0], label);
    });
  }
  // A session route's command commits only under a resolved actor: an authorizer that answers exactly true resolved none,
  // so the command is refused (403) before any idempotency record or commit — the store never audits a missing actor.
  // (A Bearer command route keeps the M6 contract of committing with context null: commandTransaction.test.ts.)
  await withRoute({ authorize: () => true }, async (h) => {
    assertRefusal(await h.patch(), 403, 'forbidden', 'a bare true');
    assert.deepEqual([h.storeCalls, h.commits.length], [[], 0], 'nothing acquired, nothing committed');
    assert.equal((await reasons(h.logs, 2)).at(-1), 'authz_context_missing', 'after the sign-in, the command logs its refusal');
  });
});

test('health never touches the store or the port; readiness answers 200 only while every probe does', async () => {
  await withRoute({}, async (h) => {
    const health = await request(h.port, 'GET', '/health', {});
    assert.deepEqual([health.status, JSON.parse(health.body)], [200, { status: 'alive' }]);
    assertPolicyHeaders(health, 'health');
    assert.deepEqual(h.storeCalls, [], 'health reads nothing');
    const ready = await request(h.port, 'GET', '/readiness', {});
    assert.deepEqual([ready.status, JSON.parse(ready.body)], [200, { status: 'ready' }]);
    assert.ok(h.storeCalls.includes('probe') && h.storeCalls.includes('port.probe'), 'readiness probes both the store and the port');
  });
  await withRoute({ probe: () => false }, async (h) => {
    const ready = await request(h.port, 'GET', '/readiness', {});
    assert.deepEqual([ready.status, JSON.parse(ready.body)], [503, { status: 'unavailable' }]);
    assertPolicyHeaders(ready, 'not ready');
    assert.equal((await request(h.port, 'GET', '/health', {})).status, 200, 'health stays prompt while the store is not ready');
  });
});

test('the log never carries the display name, the idempotency key, the cookie, the CSRF token, the provider UID or the actor', async () => {
  await withRoute({}, async (h) => {
    const name = 'Canary Name 5e2a';
    const key = randomUUID();
    const body = JSON.stringify(valid({ displayName: name }));
    assert.equal((await h.patch({ key, body })).status, 200);
    assert.equal((await h.patch({ key, body })).status, 200, 'the replay');
    h.setAnswer('unchanged');
    assert.equal((await h.patch({ body })).status, 200, 'the unchanged answer');
    assert.equal((await h.patch({ body: JSON.stringify(valid({ displayName: `${name}${ch(1)}` })) })).status, 400, 'a refused name');
    await reasons(h.logs, 5);
    const all = h.logs.join('\n');
    for (const secret of [name, key, key.toUpperCase(), h.id, h.csrf, UID, BEARER, ACTOR, TENANT, 'sv-5e2a']) {
      assert.ok(!all.includes(secret), `${secret} never reaches the log`);
    }
    for (const line of h.logs) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.event === 'request' && record.route !== sessionPaths('admin').login) assert.equal(record.route, 'other', 'the route logs as a bounded class, never its path');
    }
  });
});

test('Bidi_Control is exactly the twelve characters migration 009 lists, and the validator refuses each while allowing every other format character', () => {
  // The engine's own Unicode tables, scanned across every code point, agree with the list the database operation carries.
  const property = /\p{Bidi_Control}/u;
  const found: number[] = [];
  for (let code = 0; code <= 0x10ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (property.test(String.fromCodePoint(code))) found.push(code);
  }
  assert.deepEqual(found, [...BIDI_CONTROLS]);
  for (const code of BIDI_CONTROLS) assert.equal(normalizeTenantDisplayName(`A${ch(code)}B`), null, `U+${code.toString(16)}`);
  // Not every format character: the joiners, the word joiner, the soft hyphen and the variation selector serve real text.
  const kept: Array<[string, string]> = [
    ['a zero-width joiner in an emoji sequence', ch(0x1f469, 0x200d, 0x1f527)],
    ['a zero-width non-joiner in Persian', `${ch(0x0645, 0x06cc)}${ch(0x200c)}${ch(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)}`],
    ['a zero-width space', `Acme${ch(0x200b)}Repairs`], ['a word joiner', `Acme${ch(0x2060)}Repairs`], ['a soft hyphen', `Acme${ch(0xad)}Repairs`],
    ['a variation selector', `${ch(0x2764, 0xfe0f)} Repairs`], ['an Arabic letter mark only in sequence', ch(0x0645, 0x062d, 0x0644)],
  ];
  for (const [label, name] of kept) assert.equal(normalizeTenantDisplayName(name), name, label);
});

test('right-to-left text, combining marks, emoji and internal whitespace stay valid without any directional control', () => {
  const names: Array<[string, string]> = [
    ['Arabic', ch(0x0645, 0x062a, 0x062c, 0x0631, 0x0020, 0x0627, 0x0644, 0x0625, 0x0635, 0x0644, 0x0627, 0x062d)],
    ['Hebrew', ch(0x05ea, 0x05d9, 0x05e7, 0x05d5, 0x05df, 0x0020, 0x05de, 0x05d4, 0x05d9, 0x05e8)],
    ['Hebrew beside Latin and digits', `Acme ${ch(0x05d7, 0x05e0, 0x05d5, 0x05ea)} 24`],
    ['combining marks', `Cafe${ch(0x301)} Re${ch(0x301)}paration${ch(0x323)}`],
    ['emoji with a skin tone', `${ch(0x1f527, 0x1f3fd)} Fix${ch(0x00a0)}It`], ['a double internal space', 'Acme  Repairs'],
  ];
  for (const [label, name] of names) {
    assert.equal(normalizeTenantDisplayName(name), name, label);
    assert.equal((plan(valid({ displayName: ` ${name} ` })) as CommandPlan).changes.displayName, name, `${label}: planned, trimmed only`);
  }
});
