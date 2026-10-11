// Phase 4.0 M7B-INVOICES-DISCARD-P1 — the draft discard through the runtime: the discard contract (no event) and its route as
// the runtime registers them, the planner's closed two-key body and its bounds, the discard eligibility's declaration and its
// target-blind handler, and the discard over the enforced chain on real loopback sockets — each store answer's status and body
// exactly (the sealed 200 and 409s, the unsealed 404, the unsealed precondition 409, the 503), the draft id bound as the
// fingerprint's target and read before the matched route's own '/discard' suffix, the save's and the edit's targets
// unchanged beside it, and the 413 at 1 KiB (IDU-01..IDU-07; doc 11 DSC-06, DSC-09, DSC-10, DSC-19 at the unit layer).
//
// Synthetic principals, sessions and ports only (identifiers built at run time). The PostgreSQL side is proved database-free in
// server/persistence/postgresInvoiceDrafts.test.ts and postgresTransactionalStore.test.ts, and against a real cluster in
// tests/db/invoiceDraftDiscardRoutine.integration.test.mjs and tests/db/invoiceDraftDiscardHttp.integration.test.mjs.
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
import {
  INVOICE_DRAFTS_PATH, INVOICE_DRAFT_CREATE_CONTRACT, INVOICE_DRAFT_CREATE_ROUTE, INVOICE_DRAFT_DISCARD_CONTRACT, INVOICE_DRAFT_DISCARD_ELIGIBILITY_PATH,
  INVOICE_DRAFT_DISCARD_MAX_BODY_BYTES, INVOICE_DRAFT_DISCARD_PATH, INVOICE_DRAFT_DISCARD_REQUIREMENT, INVOICE_DRAFT_DISCARD_ROUTE, INVOICE_DRAFT_EDIT_REQUIREMENT,
  INVOICE_DRAFT_EVENTS, INVOICE_DRAFT_PATH, INVOICE_DRAFT_UPDATE_CONTRACT, INVOICE_DRAFT_UPDATE_ROUTE, createInvoiceDraftDetailRoute,
  createInvoiceDraftDiscardEligibilityRoute, createInvoiceDraftEditEligibilityRoute, createInvoiceDraftEligibilityRoute, createInvoiceDraftListRoute,
  planInvoiceDraftDiscard,
} from './invoiceDrafts.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import type { CommandPlan, RouteContext } from './routes.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const MAX = Number.MAX_SAFE_INTEGER;
const ACTOR = randomUUID();
const TENANT = randomUUID();
const STORE = randomUUID();
const OTHER_STORE = randomUUID();
const CUSTOMER = randomUUID();
const MEMBERSHIP = randomUUID();
const DRAFT = randomUUID();
const OTHER_DRAFT = randomUUID();
const SESSION_KEY = 'k'.repeat(43);
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
const PRINCIPAL = Object.freeze({ authProvider: 'synthetic', authProviderUid: 'uid-discard' });
/** A canonical lowercase uuid that is NOT a versioned RFC uuid (its version nibble is 0): the outbox refuses it as an aggregate id. */
const UNVERSIONED = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
const scopeAt = (store: string, over: Partial<TrustedScope> = {}): TrustedScope => Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'store', tenant: TENANT, store, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none', ...over,
});
const discard = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, expectedVersion: 3, ...over });
const planDiscard = (b: unknown, targetId: string | null = DRAFT, storeId: string | null = STORE) => planInvoiceDraftDiscard(Object.freeze({
  audience: 'tenant' as const, body: b, newAggregateId: randomUUID(), ...(targetId === null ? {} : { targetId }), ...(storeId === null ? {} : { storeId }),
}));
const sealWith = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString('base64url');
const line = { description: 'Screen repair', quantity: 2, unitPriceCents: 4_999 };

// --- 1. the contract and the routes as the runtime registers them ----------------------------------------------------------

test('IDU-01 DSC-23 (D-DIS-2, D-DIS-4): the discard contract registers as a store-scope update of the draft aggregate with NO event and no typed refusal; the route is the store POST {id}/discard template under a key, bounded at 1 KiB, under its own Manage requirement; the eligibility is a session-bound GET under the same object', () => {
  const events = defineOutboxEvents(INVOICE_DRAFT_EVENTS);
  assert.deepEqual(INVOICE_DRAFT_EVENTS.map((e) => `${e.type}@${e.version}`), ['invoice_draft.created@1', 'invoice_draft.updated@1'], 'no discard event is registered');
  const commands = defineCommands([INVOICE_DRAFT_CREATE_CONTRACT, INVOICE_DRAFT_UPDATE_CONTRACT, INVOICE_DRAFT_DISCARD_CONTRACT], events);
  const contract = commands.contract('store.invoice_draft.discard');
  assert.ok(contract !== undefined, 'registered');
  assert.deepEqual([contract.kind, contract.mode, contract.aggregateType, contract.contextScope, contract.sealedRefusal],
    ['store.invoice_draft.discard', 'update', 'invoice_draft', 'store', undefined]);
  assert.deepEqual(contract.events, [], 'no event (D-DIS-4)');
  assert.deepEqual(contract.changes, { storeId: { type: 'string', maxLength: 36 }, expectedTenant: { type: 'string', maxLength: 36 } },
    'the path\'s store and the expected tenant alone');
  assert.ok(Object.isFrozen(INVOICE_DRAFT_DISCARD_CONTRACT) && Object.isFrozen(INVOICE_DRAFT_DISCARD_CONTRACT.events));
  assert.throws(() => defineCommands([{ ...INVOICE_DRAFT_DISCARD_CONTRACT, sealedRefusal: 'customer_not_found' }], events),
    (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_registry_invalid', 'an update may not opt into the typed 422');
  const r = INVOICE_DRAFT_DISCARD_ROUTE;
  assert.equal(INVOICE_DRAFT_DISCARD_PATH, '/api/v1/stores/{storeId}/invoice-drafts/{id}/discard');
  assert.deepEqual([r.method, r.path, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding], ['POST', INVOICE_DRAFT_DISCARD_PATH, 'required', 'required', 'none', undefined]);
  assert.equal(r.policy.access === 'session' ? r.policy.authorization : null, INVOICE_DRAFT_DISCARD_REQUIREMENT, 'the discard requirement object itself');
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'discard_invoice_drafts' } });
  assert.notEqual(INVOICE_DRAFT_DISCARD_REQUIREMENT, INVOICE_DRAFT_EDIT_REQUIREMENT);
  assert.deepEqual(r.body, { kind: 'json', maxBytes: INVOICE_DRAFT_DISCARD_MAX_BODY_BYTES, required: true });
  assert.equal(INVOICE_DRAFT_DISCARD_MAX_BODY_BYTES, 1_024);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(INVOICE_DRAFT_DISCARD_REQUIREMENT) && 'command' in r && r.command.contract === INVOICE_DRAFT_DISCARD_CONTRACT
    && r.command.plan === planInvoiceDraftDiscard, 'the contract and planner');
  const e = createInvoiceDraftDiscardEligibilityRoute();
  assert.equal(INVOICE_DRAFT_DISCARD_ELIGIBILITY_PATH, '/api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility');
  assert.deepEqual([e.method, e.path, e.idempotency, e.trustedContext, e.recentAuth, e.sessionBinding], ['GET', INVOICE_DRAFT_DISCARD_ELIGIBILITY_PATH, 'none', 'required', 'none', 'required']);
  assert.deepEqual(e.body, { kind: 'none' });
  assert.ok(e.policy.access === 'session' && e.policy.authorization === INVOICE_DRAFT_DISCARD_REQUIREMENT, 'the POST\'s own requirement object');
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.policy), 'frozen');
  // The runtime's own table accepts all eight store templates together, beside nothing else.
  const reader = { invoiceDrafts: { page: () => undefined, get: () => undefined } };
  const table = defineRoutes([createInvoiceDraftListRoute(reader), createInvoiceDraftDetailRoute(reader), createInvoiceDraftEligibilityRoute(), INVOICE_DRAFT_CREATE_ROUTE,
    INVOICE_DRAFT_UPDATE_ROUTE, createInvoiceDraftEditEligibilityRoute(), e, r]);
  assert.deepEqual(table.list().map((d) => `${d.method} ${d.path}`).slice(-2), [`GET ${INVOICE_DRAFT_DISCARD_ELIGIBILITY_PATH}`, `POST ${INVOICE_DRAFT_DISCARD_PATH}`]);
  assert.deepEqual([table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard`)?.path, table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard`)?.idempotency],
    [INVOICE_DRAFT_DISCARD_PATH, 'required']);
  assert.equal(table.lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard-eligibility`)?.path, INVOICE_DRAFT_DISCARD_ELIGIBILITY_PATH);
});

// --- 2. the planner -----------------------------------------------------------------------------------------------------------

test('IDU-02 DSC-06 DSC-10 (D-DIS-3): the planner maps exactly { expectedTenant, expectedVersion } to the path\'s draft and store, no event and the one sealed 200 — never an unchanged answer; every other body, version, id or store is COMMAND_REQUEST_INVALID', () => {
  assert.deepEqual(planDiscard(discard({ expectedVersion: 7 })), {
    aggregateId: DRAFT, expectedVersion: 7, changes: { storeId: STORE, expectedTenant: TENANT }, events: [],
    response: { status: 200, body: { draftId: DRAFT, version: 8, status: 'discarded' } },
  });
  assert.ok(!('unchanged' in (planDiscard(discard()) as CommandPlan)), 'a discard is never a no-op');
  for (const [expectedVersion, next] of [[1, 2], [MAX - 1, MAX]] as const) {
    const p = planDiscard(discard({ expectedVersion })) as CommandPlan;
    assert.deepEqual([p.expectedVersion, p.response.body], [expectedVersion, { draftId: DRAFT, version: next, status: 'discarded' }]);
  }
  const without = (key: string) => Object.fromEntries(Object.entries(discard()).filter(([k]) => k !== key));
  const invalid: Array<[string, unknown] | [string, unknown, string | null, string | null]> = [
    ['not an object', [discard()]], ['null', null], ['a string', 'x'], ['an empty object', {}],
    ['no expectedTenant', without('expectedTenant')], ['no expectedVersion', without('expectedVersion')],
    ['a customer', discard({ customerId: CUSTOMER })], ['lines', discard({ lines: [line] })], ['a status', discard({ status: 'discarded' })],
    ['a reason', discard({ reason: 'duplicate' })], ['a version', discard({ version: 3 })], ['a draft id', discard({ draftId: DRAFT })],
    ['a store', discard({ storeId: STORE })], ['a currency', discard({ currency: 'USD' })],
    ['version 0', discard({ expectedVersion: 0 })], ['version -1', discard({ expectedVersion: -1 })], ['version 2^53 - 1', discard({ expectedVersion: MAX })],
    ['version 2^53', discard({ expectedVersion: MAX + 1 })], ['version 1.5', discard({ expectedVersion: 1.5 })], ['version as text', discard({ expectedVersion: '3' })],
    ['version null', discard({ expectedVersion: null })], ['version true', discard({ expectedVersion: true })], ['version -0', discard({ expectedVersion: -0 })],
    ['a non-canonical tenant', discard({ expectedTenant: TENANT.toUpperCase() })], ['a tenant that is no uuid', discard({ expectedTenant: 'tenant' })],
    ['a numeric tenant', discard({ expectedTenant: 7 })], ['no tenant', discard({ expectedTenant: null })],
    ['no draft id', discard(), null, STORE], ['a non-canonical draft id', discard(), DRAFT.toUpperCase(), STORE],
    ['a draft id outside the outbox\'s aggregate-id shape', discard(), UNVERSIONED, STORE], ['the suffix as a draft id', discard(), 'discard', STORE],
    ['no store', discard(), DRAFT, null], ['a non-canonical store', discard(), DRAFT, STORE.toUpperCase()],
  ];
  for (const c of invalid) assert.equal(c.length === 4 ? planDiscard(c[1], c[2], c[3]) : planDiscard(c[1]), COMMAND_REQUEST_INVALID, c[0]);
  // The plan is in contract: the runtime prepares it as an update — conflict and invalid_state sealed, no unchanged, no 422,
  // no event; the audit record is the discard's kind under the discard's permission at the trusted store.
  const prepared = prepareCommand(INVOICE_DRAFT_DISCARD_CONTRACT, defineOutboxEvents(INVOICE_DRAFT_EVENTS), planDiscard(discard()), {
    scope: 's'.repeat(43), lease: 'l'.repeat(43), newAggregateId: randomUUID(), authorization: INVOICE_DRAFT_DISCARD_REQUIREMENT,
    context: scopeAt(STORE), authNotAfter: null, sessionKey: SESSION_KEY, seal: sealWith,
  });
  assert.ok(prepared !== null, 'in contract');
  assert.equal(prepared.response.body, `{"draftId":"${DRAFT}","version":4,"status":"discarded"}`);
  assert.equal(prepared.unchanged, null, 'no unchanged answer');
  assert.deepEqual([prepared.rejected.conflict.body, prepared.rejected.invalidState?.body, prepared.rejected.customerNotFound],
    ['{"error":"write_conflict"}', '{"error":"invalid_state"}', null]);
  assert.deepEqual([prepared.command.mutation.kind, prepared.command.mutation.aggregateId, prepared.command.mutation.expectedVersion, prepared.command.mutation.changes],
    ['store.invoice_draft.discard', DRAFT, 3, { storeId: STORE, expectedTenant: TENANT }]);
  assert.deepEqual([prepared.command.audit.action, prepared.command.audit.permission, prepared.command.audit.scope, prepared.command.audit.tenant, prepared.command.audit.store,
    prepared.command.audit.actor], ['store.invoice_draft.discard', 'discard_invoice_drafts', 'store', TENANT, STORE, ACTOR]);
  assert.deepEqual(prepared.command.events, [], 'nothing to enqueue');
  // A plan naming an event is out of contract: the discard may enqueue none.
  const withEvent = { ...(planDiscard(discard()) as CommandPlan), events: [{ type: 'invoice_draft.updated', payload: { storeId: STORE, customerId: CUSTOMER, lineCount: 1 } }] };
  assert.equal(prepareCommand(INVOICE_DRAFT_DISCARD_CONTRACT, defineOutboxEvents(INVOICE_DRAFT_EVENTS), withEvent, {
    scope: 's'.repeat(43), lease: 'l'.repeat(43), newAggregateId: randomUUID(), authorization: INVOICE_DRAFT_DISCARD_REQUIREMENT,
    context: scopeAt(STORE), authNotAfter: null, sessionKey: SESSION_KEY, seal: sealWith,
  }), null, 'no event, not even the edit\'s');
});

// --- 3. the discard eligibility, its handler and over the chain -------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }
async function runHandler(route: ReturnType<typeof createInvoiceDraftDiscardEligibilityRoute>, path: string, opts: { url?: string; trusted?: TrustedScope | null; sessionKey?: string | null } = {}) {
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
  answer: (a: Answer) => void;
  setScopeFor: (scopeFor: ((storeTarget: string | null) => TrustedScope | false) | null) => void;
  discard: (store: string, draft: string, payload: string, key: string) => Promise<Reply>;
  send: (method: string, path: string, payload: string, key: string) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
}
async function withChain(fn: (h: Chain) => Promise<void>): Promise<void> {
  const commits: TransactionCommand[] = [];
  const requirements: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
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
      return token.bearerToken === BEARER ? { verified: true, authProvider: PRINCIPAL.authProvider, authProviderUid: PRINCIPAL.authProviderUid, authenticatedAt: Date.now(), secondFactor: null } : null;
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
    routes: [INVOICE_DRAFT_CREATE_ROUTE, INVOICE_DRAFT_UPDATE_ROUTE, INVOICE_DRAFT_DISCARD_ROUTE, createInvoiceDraftEligibilityRoute(),
      createInvoiceDraftEditEligibilityRoute(), createInvoiceDraftDiscardEligibilityRoute()],
    events: INVOICE_DRAFT_EVENTS, limits: testRequestLimits(), idempotency: { store: inner, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
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
      commits, requirements, records: state.records, logs, answer: (a) => { next = a; }, setScopeFor: (f) => { scopeFor = f; },
      discard: (store, draft, payload, key) => send('POST', `/api/v1/stores/${store}/invoice-drafts/${draft}/discard`, payload, key),
      send,
      get: (path) => request(p, 'GET', path, { cookie, [SESSION_CSRF_HEADER]: csrf }),
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const reasonOf = (h: Chain, r: Reply): unknown => h.logs.find((l) => l.event === 'request' && l.requestId === r.headers['x-request-id'])?.reason;
/** An answer's headers without the two that differ per request. */
const stableHeaders = (r: Reply): Record<string, unknown> =>
  Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== 'x-request-id' && k !== 'date').sort(([a], [b]) => a.localeCompare(b)));

test('IDU-03 DSC-19 (D-DIS-2): the discard eligibility is target-blind — its handler refuses a query (400), a scope not at the path\'s store (403), then a malformed id (400), and otherwise answers the edit eligibility\'s exact body for any well-formed id, reading no draft; over the chain it is decided under the discard requirement with the edit eligibility\'s very headers (no-store), reserving and committing nothing', async () => {
  const r = createInvoiceDraftDiscardEligibilityRoute();
  const at = (id: string, store: string = STORE) => `/api/v1/stores/${store}/invoice-drafts/${id}/discard-eligibility`;
  for (const url of [`${at(DRAFT)}?`, `${at(DRAFT)}?x=1`, `${at('x')}?x=1`]) {
    const out = await runHandler(r, at(DRAFT), { url });
    assert.deepEqual([out.status, out.body, out.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, 'invoice_draft_discard_eligibility_query_invalid'], url);
  }
  for (const [label, path, opts] of [
    ['no trusted scope', at(DRAFT), { trusted: null }], ['a tenant scope', at(DRAFT), { trusted: scopeAt(STORE, { scope: 'tenant', store: null }) }],
    ['the trusted store is not the path\'s', at(DRAFT), { trusted: scopeAt(OTHER_STORE) }], ['no session key', at(DRAFT), { sessionKey: null }],
    ['a non-canonical path store', at(DRAFT, STORE.toUpperCase()), {}], ['the scope first, before a malformed id', at('x'), { trusted: null }],
  ] as const) {
    const out = await runHandler(r, path, opts);
    assert.deepEqual([out.status, out.body, out.locals.refusal], [403, { error: 'forbidden', requestId: 'req-9' }, 'authz_context_missing'], label);
  }
  for (const id of [DRAFT.toUpperCase(), 'x', '{id}', `${DRAFT}0`, 'eligibility', 'discard', 'discard-eligibility']) {
    const out = await runHandler(r, at(id));
    assert.deepEqual([out.status, out.body, out.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, 'invoice_draft_id_invalid'], id);
  }
  const edited = await runHandler(createInvoiceDraftEditEligibilityRoute(), `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/edit-eligibility`);
  for (const id of [DRAFT, OTHER_DRAFT, randomUUID(), UNVERSIONED]) {
    const out = await runHandler(r, at(id));
    assert.deepEqual([out.status, out.body, out.locals.refusal], [200, { eligibility: 'allowed' }, undefined], id);
    assert.equal(JSON.stringify(out.body), JSON.stringify(edited.body), 'byte-equal to the edit eligibility\'s');
  }
  await withChain(async (h) => {
    const discardable = await h.get(at(DRAFT));
    const editable = await h.get(`/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/edit-eligibility`);
    assert.deepEqual([discardable.status, discardable.body], [200, '{"eligibility":"allowed"}']);
    assert.deepEqual(h.requirements, [INVOICE_DRAFT_DISCARD_REQUIREMENT, INVOICE_DRAFT_EDIT_REQUIREMENT], 'each under its own command\'s requirement');
    assert.equal(discardable.headers['cache-control'], 'no-store');
    assert.deepEqual(stableHeaders(discardable), stableHeaders(editable), 'the edit eligibility\'s exact headers');
    h.setScopeFor(() => false);
    const denied = await h.get(at(DRAFT));
    h.setScopeFor(null);
    assert.deepEqual([denied.status, JSON.parse(denied.body).error, reasonOf(h, denied)], [403, 'forbidden', 'authz_denied']);
    const malformed = await h.get(at('x'));
    assert.deepEqual([malformed.status, JSON.parse(malformed.body).error, reasonOf(h, malformed)], [400, 'invalid_request', 'invoice_draft_id_invalid']);
    assert.deepEqual([h.records.size, h.commits.length], [0, 0], 'no eligibility answer reserves or commits anything');
  });
});

// --- 4. the discard over the enforced chain ------------------------------------------------------------------------------------

test('IDU-04 DSC-06 DSC-10 (D-DIS-3): over the chain, each store answer is its exact status and body — the sealed 200 and both sealed 409s replayed byte for byte with Idempotent-Replayed; the 404 and the precondition 409 unsealed, their lease kept; 503 otherwise — and the command handed the store is the draft, the path\'s store, the discard\'s audit and no event', async () => {
  await withChain(async (h) => {
    const payload = JSON.stringify(discard());
    const cases: Array<[Answer, number, string | null, boolean]> = [
      // answer, status, exact body (null: the chain's { error, requestId }), sealed (replayed under the key)
      ['committed', 200, `{"draftId":"${DRAFT}","version":4,"status":"discarded"}`, true],
      ['conflict', 409, '{"error":"write_conflict"}', true],
      ['invalid_state', 409, '{"error":"invalid_state"}', true],
      ['not_found', 404, null, false],
      ['precondition_failed', 409, null, false],
      ['unavailable', 503, null, false],
    ];
    for (const [answer, status, exact, sealed] of cases) {
      h.answer(answer);
      const key = randomUUID();
      const first = await h.discard(STORE, DRAFT, payload, key);
      assert.equal(first.status, status, `${answer}: ${first.body}`);
      if (exact !== null) {
        assert.equal(first.body, exact, `${answer}: the exact sealed body`);
      } else {
        const parsed = JSON.parse(first.body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(parsed), ['error', 'requestId'], answer);
        assert.equal(parsed.error, { not_found: 'not_found', precondition_failed: 'write_conflict', unavailable: 'service_unavailable' }[answer as string], answer);
      }
      assert.equal(first.headers['cache-control'], 'no-store', answer);
      assert.equal(first.headers['idempotent-replayed'], undefined, `${answer}: the first answer is no replay`);
      const commits = h.commits.length;
      h.answer('committed'); // a retry that planned again would now be the 200: a replay never plans
      const retry = await h.discard(STORE, DRAFT, payload, key);
      if (sealed) {
        assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [status, first.body, 'true'], `${answer}: replayed`);
      } else {
        assert.deepEqual([retry.status, JSON.parse(retry.body).error], [409, 'request_in_progress'], `${answer}: nothing recorded, the lease kept`);
      }
      assert.equal(h.commits.length, commits, `${answer}: the retry planned and committed nothing`);
    }
    // The unsealed precondition is the runtime's own 409 for the discard's kind (app.ts PRECONDITION_UPDATE_KINDS), never the 503.
    h.answer('precondition_failed');
    const pre = await h.discard(STORE, DRAFT, payload, randomUUID());
    assert.deepEqual([pre.status, JSON.parse(pre.body).error, reasonOf(h, pre)], [409, 'write_conflict', 'transaction_precondition_failed']);
    h.answer('not_found');
    assert.equal(reasonOf(h, await h.discard(STORE, DRAFT, payload, randomUUID())), 'transaction_not_found');
    const c = h.commits[0];
    assert.deepEqual([c.mutation.kind, c.mutation.aggregateType, c.mutation.aggregateId, c.mutation.expectedVersion, c.mutation.changes],
      ['store.invoice_draft.discard', 'invoice_draft', DRAFT, 3, { storeId: STORE, expectedTenant: TENANT }]);
    assert.deepEqual([c.context?.scope, c.context?.store, c.audit.action, c.audit.permission, c.audit.scope, c.audit.store, c.events.length, c.unchanged],
      ['store', STORE, 'store.invoice_draft.discard', 'discard_invoice_drafts', 'store', STORE, 0, null]);
    assert.deepEqual(h.requirements.at(-1), INVOICE_DRAFT_DISCARD_REQUIREMENT, 'the POST is decided under the discard requirement');
  });
});

test('IDU-05 DSC-09 (D-DIS-3): the discard binds its DRAFT id as the fingerprint\'s target beside the trusted store — never the store, no target or another draft; one key at two drafts or with other bytes is the 422; a save or edit key reused on the discard, and a discard key reused on the edit, are the 422 too', async () => {
  await withChain(async (h) => {
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    const payload = JSON.stringify(discard());
    const key = randomUUID();
    const discarded = await h.discard(STORE, DRAFT, payload, key);
    assert.equal(discarded.status, 200, discarded.body);
    const [c] = h.commits;
    const binding = { method: 'POST' as const, path: INVOICE_DRAFT_DISCARD_PATH, audience: 'tenant' as const, tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from(payload) };
    const expected = keyring.operationOf(key, PRINCIPAL, { ...binding, target: DRAFT });
    assert.equal(c.scope, expected.scope);
    assert.equal(h.records.get(c.scope)?.fingerprint, expected.fingerprint, 'the reserved fingerprint carries the draft as its target');
    for (const target of [STORE, null, OTHER_DRAFT]) {
      assert.notEqual(keyring.operationOf(key, PRINCIPAL, { ...binding, target }).fingerprint, expected.fingerprint, `non-vacuous: target ${String(target)}`);
    }
    const commits = h.commits.length;
    for (const [label, draft, bytes] of [['another draft', OTHER_DRAFT, payload], ['another version', DRAFT, JSON.stringify(discard({ expectedVersion: 4 }))],
      ['the same JSON value re-spaced', DRAFT, JSON.stringify(discard(), null, 1)], ['the keys reordered', DRAFT, JSON.stringify({ expectedVersion: 3, expectedTenant: TENANT })]] as const) {
      const reused = await h.discard(STORE, draft, bytes, key);
      assert.deepEqual([reused.status, JSON.parse(reused.body).error], [422, 'idempotency_key_reused'], label);
    }
    assert.equal(h.commits.length, commits, 'nothing planned or committed');
    // An edit key on the discard, and a discard key on the edit: another method and template, so another request — the 422.
    const editKey = randomUUID();
    const editBytes = JSON.stringify({ expectedTenant: TENANT, expectedVersion: 3, customerId: CUSTOMER, lines: [line] });
    assert.equal((await h.send('PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}`, editBytes, editKey)).status, 200);
    for (const [label, reply] of [
      ['the edit\'s key on the discard', await h.discard(STORE, DRAFT, payload, editKey)],
      ['the edit\'s key and bytes on the discard', await h.discard(STORE, DRAFT, editBytes, editKey)],
      ['the discard\'s key on the edit', await h.send('PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}`, editBytes, key)],
    ] as const) {
      assert.deepEqual([reply.status, JSON.parse(reply.body).error], [422, 'idempotency_key_reused'], label);
    }
    const saveKey = randomUUID();
    assert.equal((await h.send('POST', `/api/v1/stores/${STORE}/invoice-drafts`, JSON.stringify({ expectedTenant: TENANT, customerId: CUSTOMER, currency: 'USD', lines: [line] }), saveKey)).status, 201);
    const saveReused = await h.discard(STORE, DRAFT, payload, saveKey);
    assert.deepEqual([saveReused.status, JSON.parse(saveReused.body).error], [422, 'idempotency_key_reused'], 'the save\'s key on the discard');
    assert.equal(h.commits.length, commits + 2, 'only the edit and the save committed');
  });
});

test('IDU-06 DSC-09 AC-04: the target is read before the MATCHED route\'s own suffix — another suffix after the id is no route; a malformed id is the 400 command_target_invalid before the body is read or a key acquired; the save\'s and the edit\'s fingerprint targets are unchanged beside the discard\'s', async () => {
  await withChain(async (h) => {
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    const payload = JSON.stringify(discard());
    // Another suffix — or another method — after the draft id never reaches the command: no route, nothing reserved.
    for (const [method, path] of [
      ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/edit-eligibility`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard-eligibility`],
      ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discards`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/Discard`],
      ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard/`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard/x`],
      ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/x/discard`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/discard`],
      ['POST', `/api/v1/stores/${STORE}/discard`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}`],
      ['PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard`], ['PUT', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard`],
      ['DELETE', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard`],
    ] as const) {
      assert.equal((await h.send(method, path, payload, randomUUID())).status, 404, `${method} ${path}`);
    }
    assert.equal((await h.get(`/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard`)).status, 404, 'no GET names the discard');
    assert.deepEqual([h.records.size, h.commits.length], [0, 0], 'no such route reserves or commits anything');
    // A malformed draft segment on the discard template: the target's 400, before the body (even unparseable JSON) or a key.
    for (const segment of [DRAFT.toUpperCase(), 'x', '{id}', `${DRAFT}0`, 'eligibility', 'edit-eligibility', 'discard', 'discard-eligibility']) {
      for (const bytes of [payload, '{']) {
        const bad = await h.discard(STORE, segment, bytes, randomUUID());
        assert.deepEqual([bad.status, JSON.parse(bad.body).error, reasonOf(h, bad)], [400, 'invalid_request', 'command_target_invalid'], `${segment} ${bytes}`);
      }
    }
    // A scope the authorizer resolved at another store than the path's: the 403 before the body or a key.
    h.setScopeFor(() => scopeAt(OTHER_STORE));
    const elsewhere = await h.discard(STORE, DRAFT, payload, randomUUID());
    assert.deepEqual([elsewhere.status, reasonOf(h, elsewhere)], [403, 'authz_context_missing']);
    h.setScopeFor(null);
    assert.deepEqual([h.records.size, h.commits.length], [0, 0], 'no idempotency record was reserved');
    // A canonical id outside the outbox's aggregate-id shape: the planner's 400 once the key is reserved, committing nothing.
    const unversioned = await h.discard(STORE, UNVERSIONED, payload, randomUUID());
    assert.deepEqual([unversioned.status, JSON.parse(unversioned.body).error, reasonOf(h, unversioned)], [400, 'invalid_request', 'command_request_invalid']);
    assert.deepEqual([h.records.size, h.commits.length], [1, 0]);
    // The targets the chain hands the idempotency port, pinned for all three store commands: the save its STORE, the edit and
    // the discard their DRAFT — each fingerprint equal to the keyring's over exactly that target, and to no other.
    const principalBinding = (method: 'POST' | 'PATCH', path: string, bytes: string) =>
      ({ method, path, audience: 'tenant' as const, tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from(bytes) });
    const saveBytes = JSON.stringify({ expectedTenant: TENANT, customerId: CUSTOMER, currency: 'USD', lines: [line] });
    const editBytes = JSON.stringify({ expectedTenant: TENANT, expectedVersion: 3, customerId: CUSTOMER, lines: [line] });
    for (const [label, method, path, template, bytes, status, target] of [
      ['the save', 'POST', `/api/v1/stores/${STORE}/invoice-drafts`, INVOICE_DRAFTS_PATH, saveBytes, 201, STORE],
      ['the edit', 'PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}`, INVOICE_DRAFT_PATH, editBytes, 200, DRAFT],
      ['the discard', 'POST', `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/discard`, INVOICE_DRAFT_DISCARD_PATH, payload, 200, DRAFT],
    ] as const) {
      const key = randomUUID();
      const reply = await h.send(method, path, bytes, key);
      assert.equal(reply.status, status, `${label}: ${reply.body}`);
      const committed = h.commits.at(-1) as TransactionCommand;
      const binding = principalBinding(method, template, bytes);
      assert.equal(h.records.get(committed.scope)?.fingerprint, keyring.operationOf(key, PRINCIPAL, { ...binding, target }).fingerprint, `${label}: its target`);
      for (const other of [STORE, DRAFT, OTHER_DRAFT, null].filter((t) => t !== target)) {
        assert.notEqual(h.records.get(committed.scope)?.fingerprint, keyring.operationOf(key, PRINCIPAL, { ...binding, target: other }).fingerprint, `${label}: not ${String(other)}`);
      }
    }
  });
});

test('IDU-07 DSC-09 (doc 11 §5 B): the discard body is bounded at exactly 1 KiB — the 413 one byte over, reserving nothing; at the bound it commits', async () => {
  await withChain(async (h) => {
    const base = JSON.stringify(discard());
    // Whitespace is JSON: pad a valid body to exactly the bound, then one byte past it.
    const atBound = base.slice(0, -1) + ' '.repeat(INVOICE_DRAFT_DISCARD_MAX_BODY_BYTES - Buffer.byteLength(base)) + '}';
    assert.equal(Buffer.byteLength(atBound), 1_024);
    const ok = await h.discard(STORE, DRAFT, atBound, randomUUID());
    assert.equal(ok.status, 200, ok.body);
    const records = h.records.size;
    const commits = h.commits.length;
    const over = await h.discard(STORE, DRAFT, `${atBound} `, randomUUID());
    assert.deepEqual([over.status, JSON.parse(over.body).error], [413, 'content_too_large']);
    assert.deepEqual([h.records.size, h.commits.length], [records, commits], 'the 413 reserves nothing');
  });
});
