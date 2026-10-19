// Phase 4.0 M7B-INVOICES-VOID-P1 — the invoice void through the runtime, DATABASE-FREE: the void contract (no event) and its
// two routes as the runtime registers them (the POST on a recent sign-in, the eligibility without one), the closed reason
// codes and their labels, the planner's closed two-key body, its target guard and its audit annex, the sealed 200's exact
// bytes and the sealed 409s', the eligibility's target-blind handler, and the void over the enforced chain on real loopback
// sockets — each store answer's status and body exactly (the sealed 200 and 409s replayed byte for byte, the unsealed 404,
// precondition 409 and 503 in the chain's { error, requestId } shape, 409 request_in_progress, 422 idempotency_key_reused),
// the recent sign-in's 403 before any key, the deadline handed to the store, the invoice id as the fingerprint's target and
// the 413 at 1 KiB (IVU-01..IVU-07; doc 13 VOID-01, VOID-05, VOID-13 at the unit layer).
//
// Synthetic principals, sessions and ports only (identifiers built at run time). The PostgreSQL side is proved database-free in
// server/persistence/postgresInvoiceVoid.test.ts and postgresTransactionalStore.test.ts, and against a real cluster by this
// stage's database suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyState, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { createIdempotencyKeyring } from './idempotency.js';
import { INVOICE_ISSUE_ROUTE, createIssuedInvoiceDetailRoute, createIssuedInvoiceListRoute } from './invoiceIssuing.js';
import {
  INVOICE_VOIDED_STATUS, INVOICE_VOID_CONTRACT, INVOICE_VOID_ELIGIBILITY_PATH, INVOICE_VOID_MAX_BODY_BYTES, INVOICE_VOID_PATH, INVOICE_VOID_REASON_CODES,
  INVOICE_VOID_REASON_LABELS, INVOICE_VOID_REQUIREMENT, INVOICE_VOID_ROUTE, createInvoiceVoidEligibilityRoute, isInvoiceVoidReasonCode, planInvoiceVoid,
} from './invoiceVoid.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, defineRoutes, sessionPaths } from './routes.js';
import type { CommandPlan, RouteContext } from './routes.js';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const ACTOR = randomUUID();
const TENANT = randomUUID();
const STORE = randomUUID();
const OTHER_STORE = randomUUID();
const MEMBERSHIP = randomUUID();
const INVOICE = randomUUID();
const OTHER_INVOICE = randomUUID();
const SESSION_KEY = 'k'.repeat(43);
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
const PRINCIPAL = Object.freeze({ authProvider: 'synthetic', authProviderUid: 'uid-void' });
/** A canonical lowercase uuid that is NOT a versioned RFC uuid (its version nibble is 0): the outbox refuses it as an aggregate id. */
const UNVERSIONED = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
const NIL = '00000000-0000-0000-0000-000000000000';
const scopeAt = (store: string, over: Partial<TrustedScope> = {}): TrustedScope => Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'store', tenant: TENANT, store, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none', ...over,
});
const voidBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, reasonCode: 'issued_in_error', ...over });
const planVoid = (b: unknown, targetId: string | null = INVOICE, storeId: string | null = STORE) => planInvoiceVoid(Object.freeze({
  audience: 'tenant' as const, body: b, newAggregateId: randomUUID(), ...(targetId === null ? {} : { targetId }), ...(storeId === null ? {} : { storeId }),
}));
const sealWith = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString('base64url');

// --- 1. the codes, the contract and the routes as the runtime registers them ---------------------------------------------

test('IVU-01 VOID-01 (D-VOID-2, D-VOID-4): six closed codes in their one order with their labels; the contract is a store-scope update of the issued invoice with NO event; the POST is the store {id}/void template under a key, bounded at 1 KiB, on a RECENT sign-in; the eligibility a session-bound GET under the same requirement object WITHOUT one; the table resolves both beside the issued reads', () => {
  assert.deepEqual([...INVOICE_VOID_REASON_CODES], ['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other']);
  assert.deepEqual(INVOICE_VOID_REASON_CODES.map((c) => INVOICE_VOID_REASON_LABELS[c]),
    ['Issued by mistake', 'Wrong customer', 'Wrong lines or amounts', 'Wrong seller details', 'Duplicate of another invoice', 'Other reason']);
  assert.deepEqual(Object.keys(INVOICE_VOID_REASON_LABELS), [...INVOICE_VOID_REASON_CODES], 'one label per code, nothing else');
  assert.ok(Object.isFrozen(INVOICE_VOID_REASON_CODES) && Object.isFrozen(INVOICE_VOID_REASON_LABELS));
  for (const c of INVOICE_VOID_REASON_CODES) assert.equal(isInvoiceVoidReasonCode(c), true, c);
  for (const v of ['Other', 'OTHER', ' other', 'other ', 'void', '', null, undefined, 0, ['other'], 'toString', '__proto__', 'constructor']) {
    assert.equal(isInvoiceVoidReasonCode(v), false, String(v));
  }
  const commands = defineCommands([INVOICE_VOID_CONTRACT], defineOutboxEvents([]));
  const contract = commands.contract('store.invoice.void');
  assert.ok(contract !== undefined, 'registered beside no event contract');
  assert.deepEqual([contract.kind, contract.mode, contract.aggregateType, contract.contextScope, contract.issuingRefusals, contract.sealedRefusal, contract.events],
    ['store.invoice.void', 'update', 'issued_invoice', 'store', undefined, undefined, []]);
  assert.deepEqual(contract.changes, {
    expectedTenant: { type: 'string', maxLength: 36 }, reasonCode: { type: 'enum', values: [...INVOICE_VOID_REASON_CODES] },
  }, 'the expected tenant and the code alone');
  const r = INVOICE_VOID_ROUTE;
  assert.equal(INVOICE_VOID_PATH, '/api/v1/stores/{storeId}/invoices/{id}/void');
  assert.deepEqual([r.method, r.path, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding], ['POST', INVOICE_VOID_PATH, 'required', 'required', 'required', undefined]);
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'void_issued_invoices' } });
  assert.equal(r.policy.access === 'session' ? r.policy.authorization : null, INVOICE_VOID_REQUIREMENT, 'the void requirement object itself');
  assert.deepEqual(r.body, { kind: 'json', maxBytes: 1_024, required: true });
  assert.equal(INVOICE_VOID_MAX_BODY_BYTES, 1_024);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(INVOICE_VOID_REQUIREMENT) && 'command' in r && r.command.contract === INVOICE_VOID_CONTRACT && r.command.plan === planInvoiceVoid);
  const e = createInvoiceVoidEligibilityRoute();
  assert.equal(INVOICE_VOID_ELIGIBILITY_PATH, '/api/v1/stores/{storeId}/invoices/{id}/void-eligibility');
  assert.deepEqual([e.method, e.path, e.idempotency, e.trustedContext, e.recentAuth, e.sessionBinding], ['GET', INVOICE_VOID_ELIGIBILITY_PATH, 'none', 'required', 'none', 'required']);
  assert.deepEqual(e.body, { kind: 'none' });
  assert.ok(e.policy.access === 'session' && e.policy.audience === 'tenant' && e.policy.authorization === INVOICE_VOID_REQUIREMENT, 'the POST\'s own requirement object');
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.policy));
  // The runtime's own table accepts both beside the issued list and detail; none shadows another.
  const reader = { invoiceIssuing: { preview: () => undefined, page: () => undefined, invoice: () => undefined } };
  const table = defineRoutes([createIssuedInvoiceListRoute(reader), createIssuedInvoiceDetailRoute(reader), e, r]);
  assert.equal(table.lookup('POST', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void`)?.path, INVOICE_VOID_PATH);
  assert.equal(table.lookup('GET', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void-eligibility`)?.path, INVOICE_VOID_ELIGIBILITY_PATH);
  assert.equal(table.lookup('GET', `/api/v1/stores/${STORE}/invoices/${INVOICE}`)?.path, '/api/v1/stores/{storeId}/invoices/{id}');
  assert.equal(table.lookup('GET', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void`), undefined, 'a GET of the void is no route');
  assert.equal(table.lookup('POST', `/api/v1/stores/${STORE}/invoices/${INVOICE}`), undefined, 'a POST of the detail is no route');
});

// --- 2. the planner -----------------------------------------------------------------------------------------------------------

test('IVU-02 VOID-01 VOID-05 (D-VOID-1, D-VOID-4): the planner maps exactly { expectedTenant, reasonCode } to the path\'s invoice at lifecycle version 1, no event, the audit annex for every code and the one sealed 200; the runtime prepares it — the 200\'s and both sealed 409s\' exact bytes, no requestId, no unchanged answer', () => {
  for (const code of INVOICE_VOID_REASON_CODES) {
    assert.deepEqual(planVoid(voidBody({ reasonCode: code })), {
      aggregateId: INVOICE, expectedVersion: 1, changes: { expectedTenant: TENANT, reasonCode: code }, events: [],
      response: { status: 200, body: { invoice: { id: INVOICE, status: 'voided' } } },
      audit: { reasonCode: `invoice_void_${code}`, reason: `Issued invoice voided. Reason: ${INVOICE_VOID_REASON_LABELS[code]}.` },
    }, code);
  }
  assert.deepEqual((planVoid(voidBody({ reasonCode: 'wrong_lines_or_amounts' })) as CommandPlan).audit,
    { reasonCode: 'invoice_void_wrong_lines_or_amounts', reason: 'Issued invoice voided. Reason: Wrong lines or amounts.' }, 'one annex spelled out');
  assert.equal(INVOICE_VOIDED_STATUS, 'voided');
  assert.ok(!('unchanged' in (planVoid(voidBody()) as CommandPlan)), 'a void is never a no-op');
  const events = defineOutboxEvents([]);
  for (const code of INVOICE_VOID_REASON_CODES) {
    const prepared = prepareCommand(INVOICE_VOID_CONTRACT, events, planVoid(voidBody({ reasonCode: code })), {
      scope: 's'.repeat(43), lease: 'l'.repeat(43), newAggregateId: randomUUID(), authorization: INVOICE_VOID_REQUIREMENT,
      context: scopeAt(STORE), authNotAfter: Date.now() + 60_000, sessionKey: SESSION_KEY, seal: sealWith,
    });
    assert.ok(prepared !== null, `${code}: in contract (the annex passes the kernel's reason-code and reason rules)`);
    assert.deepEqual([prepared.response.status, prepared.response.body], [200, `{"invoice":{"id":"${INVOICE}","status":"voided"}}`], code);
    assert.deepEqual(prepared.response.headers, {}, 'no Location');
    assert.equal(prepared.unchanged, null);
    assert.deepEqual([prepared.rejected.conflict.status, prepared.rejected.conflict.body, prepared.rejected.invalidState?.status, prepared.rejected.invalidState?.body,
      prepared.rejected.customerNotFound, 'issuingNotConfigured' in prepared.rejected], [409, '{"error":"write_conflict"}', 409, '{"error":"invalid_state"}', null, false],
    'exactly the two sealed 409s, each without a requestId');
    const c = prepared.command;
    assert.deepEqual([c.mutation.kind, c.mutation.aggregateType, c.mutation.aggregateId, c.mutation.expectedVersion, c.mutation.changes],
      ['store.invoice.void', 'issued_invoice', INVOICE, 1, { expectedTenant: TENANT, reasonCode: code }]);
    assert.deepEqual([c.audit.action, c.audit.permission, c.audit.scope, c.audit.tenant, c.audit.store, c.audit.actor, c.audit.reasonCode, c.audit.reason],
      ['store.invoice.void', 'void_issued_invoices', 'store', TENANT, STORE, ACTOR, `invoice_void_${code}`, `Issued invoice voided. Reason: ${INVOICE_VOID_REASON_LABELS[code]}.`]);
    assert.deepEqual(c.events, [], 'nothing to enqueue');
  }
  // A plan naming an event is out of contract: the void may enqueue none.
  const withEvent = { ...(planVoid(voidBody()) as CommandPlan), events: [{ type: 'invoice.voided', payload: {} }] };
  assert.equal(prepareCommand(INVOICE_VOID_CONTRACT, events, withEvent, {
    scope: 's'.repeat(43), lease: 'l'.repeat(43), newAggregateId: randomUUID(), authorization: INVOICE_VOID_REQUIREMENT,
    context: scopeAt(STORE), authNotAfter: Date.now() + 60_000, sessionKey: SESSION_KEY, seal: sealWith,
  }), null, 'no event');
});

test('IVU-03 VOID-13 (R-K3, R-BR-08): every other body, code, tenant, target or store is COMMAND_REQUEST_INVALID — an extra field of any kind (a version, an auth time, an actor, a store, free text), a missing key, an unknown or respelled code, a non-canonical tenant, a nil or version-0 target', () => {
  const without = (key: string) => Object.fromEntries(Object.entries(voidBody()).filter(([k]) => k !== key));
  const invalid: Array<[string, unknown] | [string, unknown, string | null, string | null]> = [
    ['null', null], ['an array', [voidBody()]], ['a string', 'x'], ['a number', 1], ['-0', -0], ['true', true], ['an empty object', {}],
    ['a class instance', Object.assign(new (class Body {})(), voidBody())],
    ['no expectedTenant', without('expectedTenant')], ['no reasonCode', without('reasonCode')],
    ['a version', voidBody({ expectedVersion: 1 })], ['a lifecycle version', voidBody({ version: 1 })], ['an auth time', voidBody({ authenticatedAt: Date.now() })],
    ['an auth deadline', voidBody({ authNotAfter: Date.now() })], ['an actor', voidBody({ actor: ACTOR })], ['a voidedBy', voidBody({ voidedBy: ACTOR })],
    ['a store', voidBody({ storeId: STORE })], ['an invoice id', voidBody({ invoiceId: INVOICE })], ['a tenant id', voidBody({ tenantId: TENANT })],
    ['free text', voidBody({ reason: 'customer asked' })], ['a note beside other', voidBody({ reasonCode: 'other', note: 'x' })], ['a status', voidBody({ status: 'voided' })],
    ['a voided time', voidBody({ voidedAt: '2026-10-18T00:00:00.000000Z' })],
    ['an unknown code', voidBody({ reasonCode: 'refund' })], ['an uppercase code', voidBody({ reasonCode: 'OTHER' })], ['a padded code', voidBody({ reasonCode: 'other ' })],
    ['the label for a code', voidBody({ reasonCode: 'Other reason' })], ['the audit code for a code', voidBody({ reasonCode: 'invoice_void_other' })],
    ['a numeric code', voidBody({ reasonCode: 5 })], ['a null code', voidBody({ reasonCode: null })], ['an array code', voidBody({ reasonCode: ['other'] })],
    ['an inherited-name code', voidBody({ reasonCode: 'toString' })],
    ['a non-canonical tenant', voidBody({ expectedTenant: TENANT.toUpperCase() })], ['a braced tenant', voidBody({ expectedTenant: `{${TENANT}}` })],
    ['a tenant without hyphens', voidBody({ expectedTenant: TENANT.replace(/-/g, '') })], ['a tenant that is no uuid', voidBody({ expectedTenant: 'tenant' })],
    ['a numeric tenant', voidBody({ expectedTenant: 7 })], ['no tenant', voidBody({ expectedTenant: null })],
    ['no target', voidBody(), null, STORE], ['the nil uuid as target', voidBody(), NIL, STORE], ['a version-0 target', voidBody(), UNVERSIONED, STORE],
    ['a non-canonical target', voidBody(), INVOICE.toUpperCase(), STORE], ['the suffix as a target', voidBody(), 'void', STORE],
    ['a target with a trailing character', voidBody(), `${INVOICE}0`, STORE],
    ['no store', voidBody(), INVOICE, null], ['a non-canonical store', voidBody(), INVOICE, STORE.toUpperCase()], ['a store that is no uuid', voidBody(), INVOICE, 'store'],
  ];
  for (const c of invalid) assert.equal(c.length === 4 ? planVoid(c[1], c[2], c[3]) : planVoid(c[1]), COMMAND_REQUEST_INVALID, c[0]);
  // A null-prototype object of exactly the two keys is a plain body (JSON.parse never makes one, but it is not refused for that).
  assert.notEqual(planVoid(Object.assign(Object.create(null), voidBody())), COMMAND_REQUEST_INVALID);
  // Any canonical uuid version is a tenant (034's columns accept every uuid); a versioned uuid of any version is a target.
  assert.notEqual(planVoid(voidBody({ expectedTenant: UNVERSIONED })), COMMAND_REQUEST_INVALID);
});

// --- 3. the eligibility, its handler and over the chain -----------------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }
async function runHandler(path: string, opts: { url?: string; trusted?: TrustedScope | null; sessionKey?: string | null } = {}) {
  const route = createInvoiceVoidEligibilityRoute();
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = { locals: out.locals, status(code: number) { out.status = code; return res; }, json(b: unknown) { out.body = b; return res; } };
  const ctx = {
    requestId: 'req-9', principal: null, session: null, authenticatedAt: null, body: undefined,
    trusted: 'trusted' in opts ? opts.trusted : scopeAt(STORE), sessionKey: 'sessionKey' in opts ? opts.sessionKey : SESSION_KEY,
  } as unknown as RouteContext;
  if (route.idempotency !== 'none') throw new Error('a read');
  await route.handler({ url: opts.url ?? path, path } as unknown as Request, res as unknown as Response, ctx);
  return out;
}

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

/** What the port answers for a command: by its outcome word, recording the matching sealed completion as the PostgreSQL store does. */
type Answer = 'committed' | 'conflict' | 'invalid_state' | 'not_found' | 'precondition_failed' | 'unavailable';
interface Chain {
  commits: TransactionCommand[];
  requirements: unknown[];
  records: Map<string, { readonly fingerprint: string; readonly response: string | null }>;
  logs: Record<string, unknown>[];
  authenticatedAt: number;
  answer: (a: Answer) => void;
  setScopeFor: (scopeFor: ((storeTarget: string | null) => TrustedScope | false) | null) => void;
  voidAt: (store: string, invoice: string, payload: string, key: string) => Promise<Reply>;
  send: (method: string, path: string, payload: string, key: string) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
}
async function withChain(fn: (h: Chain) => Promise<void>, opts: { authenticatedAt?: number } = {}): Promise<void> {
  const commits: TransactionCommand[] = [];
  const requirements: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const authenticatedAt = opts.authenticatedAt ?? Date.now();
  let scopeFor: ((storeTarget: string | null) => TrustedScope | false) | null = null;
  let next: Answer = 'committed';
  const state = createMemoryIdempotencyState();
  const inner = createMemoryIdempotencyStore(state);
  const complete = async (c: TransactionCommand, sealed: string | null, s: AbortSignal, outcome: string) => {
    if (sealed === null) return { outcome: 'unavailable' };
    const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: sealed }), s);
    return (done as { outcome?: unknown }).outcome === 'completed' ? { outcome } : { outcome: 'lease_lost' };
  };
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      if (next === 'committed') return complete(c, c.response, s, 'committed');
      if (next === 'conflict') return complete(c, c.rejected.conflict, s, 'conflict');
      if (next === 'invalid_state') return complete(c, c.rejected.invalidState, s, 'invalid_state');
      return { outcome: next }; // not_found, precondition_failed, unavailable: rolled back, nothing recorded
    },
    probe: () => true,
  };
  const boundary: SessionBoundaryDeps = {
    trustedOrigins: [TENANT_ORIGIN],
    verifier: { async verify(token) {
      return token.bearerToken === BEARER ? { verified: true, authProvider: PRINCIPAL.authProvider, authProviderUid: PRINCIPAL.authProviderUid, authenticatedAt, secondFactor: null } : null;
    } },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: ACTOR }) },
    authorizer: { authorize: (_principal: unknown, requirement: unknown, view: { storeTarget?: string | null }) => {
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
    readiness, log: { log: (l: string) => { logs.push(JSON.parse(l) as Record<string, unknown>); } }, sessions: { tenant: boundary },
    routes: [INVOICE_ISSUE_ROUTE, INVOICE_VOID_ROUTE, createInvoiceVoidEligibilityRoute()],
    events: [], limits: testRequestLimits(), idempotency: { store: inner, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
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
    const cookie = `${SESSION_COOKIES.tenant}=${pair.slice(pair.indexOf('=') + 1)}`;
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    requirements.length = 0;
    const send = (method: string, path: string, payload: string, key: string) => request(p, method, path, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': key,
    }, payload);
    await fn({
      commits, requirements, records: state.records, logs, authenticatedAt, answer: (a) => { next = a; }, setScopeFor: (f) => { scopeFor = f; },
      voidAt: (store, invoice, payload, key) => send('POST', `/api/v1/stores/${store}/invoices/${invoice}/void`, payload, key),
      send,
      get: (path) => request(p, 'GET', path, { cookie, [SESSION_CSRF_HEADER]: csrf }),
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const reasonOf = (h: Chain, r: Reply): unknown => h.logs.find((l) => l.event === 'request' && l.requestId === r.headers['x-request-id'])?.reason;
/** The chain's own unsealed shape: exactly { error, requestId }, the request id the response header's. */
function assertUnsealed(r: Reply, error: string, label: string): void {
  const parsed = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['error', 'requestId'], label);
  assert.equal(parsed.error, error, label);
  assert.equal(r.body, JSON.stringify({ error, requestId: r.headers['x-request-id'] }), `${label}: the exact bytes`);
}

test('IVU-04 (R-K7, R-P1-001): the void eligibility is target-blind and action-only — its handler refuses a query (400), a scope not at the path\'s store (403), then a malformed id (400), and otherwise answers exactly { eligibility: "allowed" } for any well-formed id, reading nothing; over the chain it is decided under the void requirement, needs no recent sign-in, and reserves and commits nothing', async () => {
  const at = (id: string, store: string = STORE) => `/api/v1/stores/${store}/invoices/${id}/void-eligibility`;
  for (const url of [`${at(INVOICE)}?`, `${at(INVOICE)}?x=1`, `${at('x')}?x=1`]) {
    const out = await runHandler(at(INVOICE), { url });
    assert.deepEqual([out.status, out.body, out.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, 'invoice_void_eligibility_query_invalid'], url);
  }
  for (const [label, path, opts] of [
    ['no trusted scope', at(INVOICE), { trusted: null }], ['a tenant scope', at(INVOICE), { trusted: scopeAt(STORE, { scope: 'tenant', store: null }) }],
    ['the trusted store is not the path\'s', at(INVOICE), { trusted: scopeAt(OTHER_STORE) }], ['no session key', at(INVOICE), { sessionKey: null }],
    ['a non-canonical path store', at(INVOICE, STORE.toUpperCase()), {}], ['the scope first, before a malformed id', at('x'), { trusted: null }],
  ] as const) {
    const out = await runHandler(path, opts);
    assert.deepEqual([out.status, out.body, out.locals.refusal], [403, { error: 'forbidden', requestId: 'req-9' }, 'authz_context_missing'], label);
  }
  for (const id of [INVOICE.toUpperCase(), 'x', '{id}', `${INVOICE}0`, 'void', 'void-eligibility']) {
    const out = await runHandler(at(id));
    assert.deepEqual([out.status, out.body, out.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, 'issued_invoice_id_invalid'], id);
  }
  for (const id of [INVOICE, OTHER_INVOICE, randomUUID(), UNVERSIONED]) {
    const out = await runHandler(at(id));
    assert.deepEqual([out.status, out.body, out.locals.refusal], [200, { eligibility: 'allowed' }, undefined], id);
  }
  // A sign-in older than the void's window: the eligibility still answers (recentAuth none) — the POST alone needs it.
  await withChain(async (h) => {
    const r = await h.get(at(INVOICE));
    assert.deepEqual([r.status, r.body, r.headers['cache-control']], [200, '{"eligibility":"allowed"}', 'no-store']);
    assert.deepEqual(h.requirements, [INVOICE_VOID_REQUIREMENT], 'under the void\'s own requirement');
    h.setScopeFor(() => false);
    const denied = await h.get(at(INVOICE));
    h.setScopeFor(null);
    assert.deepEqual([denied.status, reasonOf(h, denied)], [403, 'authz_denied']);
    assertUnsealed(denied, 'forbidden', 'denied');
    const malformed = await h.get(at('x'));
    assert.deepEqual([malformed.status, reasonOf(h, malformed)], [400, 'issued_invoice_id_invalid']);
    assert.deepEqual([h.records.size, h.commits.length], [0, 0], 'no eligibility answer reserves or commits anything');
  }, { authenticatedAt: Date.now() - RECENT_AUTH_MAX_AGE_MS - 60_000 });
});

// --- 4. the void over the enforced chain ------------------------------------------------------------------------------------

test('IVU-05 VOID-05 (R-P1-004, R-K1): over the chain, each store answer is its exact status and bytes — the sealed 200 and both sealed 409s (no requestId) replayed byte for byte with Idempotent-Replayed; the 404, the precondition 409 and the 503 the chain\'s { error, requestId }, nothing recorded and the lease kept (409 request_in_progress); the command handed the store carries the invoice, the code, the annex and the sign-in deadline', async () => {
  await withChain(async (h) => {
    const payload = JSON.stringify(voidBody());
    const cases: Array<[Answer, number, string | null, string | null]> = [
      // answer, status, exact sealed body (null: unsealed), the unsealed error word
      ['committed', 200, `{"invoice":{"id":"${INVOICE}","status":"voided"}}`, null],
      ['invalid_state', 409, '{"error":"invalid_state"}', null],
      ['conflict', 409, '{"error":"write_conflict"}', null],
      ['not_found', 404, null, 'not_found'],
      ['precondition_failed', 409, null, 'write_conflict'],
      ['unavailable', 503, null, 'service_unavailable'],
    ];
    for (const [answer, status, exact, error] of cases) {
      h.answer(answer);
      const key = randomUUID();
      const first = await h.voidAt(STORE, INVOICE, payload, key);
      assert.equal(first.status, status, `${answer}: ${first.body}`);
      if (exact !== null) assert.equal(first.body, exact, `${answer}: the exact sealed bytes`);
      else assertUnsealed(first, error as string, answer);
      assert.equal(first.headers['cache-control'], 'no-store', answer);
      assert.equal(first.headers['idempotent-replayed'], undefined, `${answer}: the first answer is no replay`);
      const commits = h.commits.length;
      h.answer('committed'); // a retry that planned again would now be the 200: a replay never plans
      const retry = await h.voidAt(STORE, INVOICE, payload, key);
      if (exact !== null) {
        assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [status, first.body, 'true'], `${answer}: replayed`);
      } else {
        assert.equal(retry.status, 409, `${answer}: nothing recorded, the lease kept`);
        assertUnsealed(retry, 'request_in_progress', `${answer}: retry`);
      }
      assert.equal(h.commits.length, commits, `${answer}: the retry planned and committed nothing`);
    }
    h.answer('precondition_failed');
    assert.equal(reasonOf(h, await h.voidAt(STORE, INVOICE, payload, randomUUID())), 'transaction_precondition_failed');
    h.answer('not_found');
    assert.equal(reasonOf(h, await h.voidAt(STORE, INVOICE, payload, randomUUID())), 'transaction_not_found');
    const c = h.commits[0];
    assert.deepEqual([c.mutation.kind, c.mutation.aggregateType, c.mutation.aggregateId, c.mutation.expectedVersion, c.mutation.changes],
      ['store.invoice.void', 'issued_invoice', INVOICE, 1, { expectedTenant: TENANT, reasonCode: 'issued_in_error' }]);
    assert.deepEqual([c.context?.scope, c.context?.store, c.audit.action, c.audit.permission, c.audit.scope, c.audit.store, c.audit.reasonCode, c.audit.reason,
      c.events.length, c.unchanged], ['store', STORE, 'store.invoice.void', 'void_issued_invoices', 'store', STORE, 'invoice_void_issued_in_error',
      'Issued invoice voided. Reason: Issued by mistake.', 0, null]);
    assert.equal(c.authNotAfter, h.authenticatedAt + RECENT_AUTH_MAX_AGE_MS, 'the deadline the store re-judges on the database clock');
    assert.equal(c.sessionKey !== null && /^[A-Za-z0-9_-]{43}$/.test(c.sessionKey), true, 'the presenting session\'s key, for the routine');
    assert.deepEqual(h.requirements.at(-1), INVOICE_VOID_REQUIREMENT, 'the POST is decided under the void requirement');
    // A body the planner refuses: the 400 after the key is taken, nothing committed, never the 500.
    for (const bytes of [JSON.stringify(voidBody({ expectedVersion: 1 })), JSON.stringify(voidBody({ reasonCode: 'refund' })), JSON.stringify({ expectedTenant: TENANT })]) {
      const records = h.records.size;
      const commits = h.commits.length;
      const bad = await h.voidAt(STORE, INVOICE, bytes, randomUUID());
      assert.deepEqual([bad.status, reasonOf(h, bad)], [400, 'command_request_invalid'], bytes);
      assertUnsealed(bad, 'invalid_request', bytes);
      assert.deepEqual([h.records.size, h.commits.length], [records + 1, commits], `${bytes}: the key taken, nothing committed`);
    }
    // A version-0 (unversioned) target: the planner's 400 after the key, never command_plan_invalid.
    const unversioned = await h.voidAt(STORE, UNVERSIONED, payload, randomUUID());
    assert.deepEqual([unversioned.status, reasonOf(h, unversioned)], [400, 'command_request_invalid']);
  });
});

test('IVU-06 VOID-03 VOID-05 (D-VOID-2, R-K1): a sign-in older than 10 minutes is 403 step_up_required before the body is read or a key taken; the invoice id is the fingerprint\'s target — one key at another invoice, with other bytes, or an issue key on the void is the 422 idempotency_key_reused', async () => {
  await withChain(async (h) => {
    const stale = await h.voidAt(STORE, INVOICE, JSON.stringify(voidBody()), randomUUID());
    assert.deepEqual([stale.status, reasonOf(h, stale)], [403, 'recent_auth_required']);
    assertUnsealed(stale, 'step_up_required', 'stale sign-in');
    const unparseable = await h.voidAt(STORE, INVOICE, '{', randomUUID());
    assert.equal(unparseable.status, 403, 'before the body is read');
    assert.deepEqual([h.records.size, h.commits.length], [0, 0], 'no key reserved, nothing committed');
  }, { authenticatedAt: Date.now() - RECENT_AUTH_MAX_AGE_MS - 1_000 });
  await withChain(async (h) => {
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    const payload = JSON.stringify(voidBody());
    const key = randomUUID();
    const voided = await h.voidAt(STORE, INVOICE, payload, key);
    assert.equal(voided.status, 200, voided.body);
    const [c] = h.commits;
    const binding = { method: 'POST' as const, path: INVOICE_VOID_PATH, audience: 'tenant' as const, tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from(payload) };
    const expected = keyring.operationOf(key, PRINCIPAL, { ...binding, target: INVOICE });
    assert.equal(c.scope, expected.scope);
    assert.equal(h.records.get(c.scope)?.fingerprint, expected.fingerprint, 'the reserved fingerprint carries the invoice as its target');
    for (const target of [STORE, null, OTHER_INVOICE]) {
      assert.notEqual(keyring.operationOf(key, PRINCIPAL, { ...binding, target }).fingerprint, expected.fingerprint, `non-vacuous: target ${String(target)}`);
    }
    const commits = h.commits.length;
    for (const [label, invoice, bytes] of [['another invoice', OTHER_INVOICE, payload], ['another code', INVOICE, JSON.stringify(voidBody({ reasonCode: 'other' }))],
      ['the same JSON value re-spaced', INVOICE, JSON.stringify(voidBody(), null, 1)], ['the keys reordered', INVOICE, JSON.stringify({ reasonCode: 'issued_in_error', expectedTenant: TENANT })]] as const) {
      const reused = await h.voidAt(STORE, invoice, bytes, key);
      assert.equal(reused.status, 422, label);
      assertUnsealed(reused, 'idempotency_key_reused', label);
    }
    // An issue key reused on the void: another route, so another request — the 422.
    const issueKey = randomUUID();
    const issueBytes = JSON.stringify({ expectedTenant: TENANT, expectedVersion: 2, expectedSettingsVersion: 1, expectedCustomerVersion: 1 });
    assert.equal((await h.send('POST', `/api/v1/stores/${STORE}/invoice-drafts/${randomUUID()}/issue`, issueBytes, issueKey)).status, 201);
    const issueReused = await h.voidAt(STORE, INVOICE, payload, issueKey);
    assert.equal(issueReused.status, 422);
    assertUnsealed(issueReused, 'idempotency_key_reused', 'an issue key on the void');
    assert.equal(h.commits.length, commits + 1, 'only the issue committed');
    // The route alone: one key and the void's exact bytes, first at the issue's template for the same id X (the planner's
    // 400, its lease live), then at the void's for that X — the 422, not the 409 the same request would get.
    const routeKey = randomUUID();
    const sameId = randomUUID();
    const atIssue = await h.send('POST', `/api/v1/stores/${STORE}/invoice-drafts/${sameId}/issue`, payload, routeKey);
    assert.deepEqual([atIssue.status, reasonOf(h, atIssue)], [400, 'command_request_invalid']);
    const atVoid = await h.voidAt(STORE, sameId, payload, routeKey);
    assert.equal(atVoid.status, 422, 'another route is another request');
    assertUnsealed(atVoid, 'idempotency_key_reused', 'the same key, id and bytes on another route');
    const again = await h.send('POST', `/api/v1/stores/${STORE}/invoice-drafts/${sameId}/issue`, payload, routeKey);
    assert.equal(again.status, 409, 'non-vacuous: the same route, id and bytes is the live lease');
    assertUnsealed(again, 'request_in_progress', 'the same request again');
    assert.equal(h.commits.length, commits + 1, 'nothing more committed');
  });
});

test('IVU-07 VOID-13: the void body is bounded at exactly 1 KiB — the 413 one byte over, reserving nothing; at the bound it commits; another method or suffix on the void template is no route', async () => {
  await withChain(async (h) => {
    const base = JSON.stringify(voidBody());
    const atBound = base.slice(0, -1) + ' '.repeat(INVOICE_VOID_MAX_BODY_BYTES - Buffer.byteLength(base)) + '}';
    assert.equal(Buffer.byteLength(atBound), 1_024);
    const ok = await h.voidAt(STORE, INVOICE, atBound, randomUUID());
    assert.equal(ok.status, 200, ok.body);
    const records = h.records.size;
    const commits = h.commits.length;
    const over = await h.voidAt(STORE, INVOICE, `${atBound} `, randomUUID());
    assert.deepEqual([over.status, JSON.parse(over.body).error], [413, 'content_too_large']);
    for (const [method, path] of [
      ['PUT', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void`], ['PATCH', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void`],
      ['DELETE', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void`], ['POST', `/api/v1/stores/${STORE}/invoices/${INVOICE}/voids`],
      ['POST', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void/`], ['POST', `/api/v1/stores/${STORE}/invoices/${INVOICE}/void-eligibility`],
      ['POST', `/api/v1/stores/${STORE}/invoices/void`], ['POST', `/api/v1/stores/${STORE}/invoices/${INVOICE}`],
    ] as const) {
      assert.equal((await h.send(method, path, base, randomUUID())).status, 404, `${method} ${path}`);
    }
    assert.equal((await h.get(`/api/v1/stores/${STORE}/invoices/${INVOICE}/void`)).status, 404, 'no GET names the void');
    assert.deepEqual([h.records.size, h.commits.length], [records, commits], 'the 413 and the non-routes reserve nothing');
  });
});
