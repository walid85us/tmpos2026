// Phase 4.0 M7B-INVOICES-P2 — the draft edit through the runtime: the update contract and its event as the runtime registers
// them, the planner's closed input and its bounds (AC-15, the runtime side), the shared line helper the save uses too, the edit
// eligibility's declaration and handler, and the edit over the enforced chain on real loopback sockets — the draft id bound as
// the fingerprint's target beside the trusted store, the save's fingerprint unchanged beside it, each store answer's status and
// body exactly (the sealed 200s, the sealed 409s, the unsealed 404, the unsealed precondition 409, the 503), the 413 at 64 KiB,
// and the edit eligibility's answer byte-equal to the creation eligibility's (IEU-01..IEU-08).
//
// Synthetic principals, sessions and ports only (identifiers built at run time). The PostgreSQL side is proved database-free in
// server/persistence/postgresInvoiceDrafts.test.ts and postgresTransactionalStore.test.ts, and against a real cluster in
// tests/db/invoiceDraftEditHttp.integration.test.mjs.
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
  INVOICE_DRAFTS_PATH, INVOICE_DRAFT_CREATE_CONTRACT, INVOICE_DRAFT_CREATE_ROUTE, INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH, INVOICE_DRAFT_EDIT_REQUIREMENT,
  INVOICE_DRAFT_EVENTS, INVOICE_DRAFT_MAX_BODY_BYTES, INVOICE_DRAFT_PATH, INVOICE_DRAFT_UPDATE_CONTRACT, INVOICE_DRAFT_UPDATE_ROUTE,
  createInvoiceDraftEditEligibilityRoute, createInvoiceDraftEligibilityRoute, draftLinesOf, planInvoiceDraftCreate, planInvoiceDraftUpdate,
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
const PRINCIPAL = Object.freeze({ authProvider: 'synthetic', authProviderUid: 'uid-edit' });
/** A canonical lowercase uuid that is NOT a versioned RFC uuid (its version nibble is 0): the outbox refuses it as an aggregate id. */
const UNVERSIONED = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
const scopeAt = (store: string, over: Partial<TrustedScope> = {}): TrustedScope => Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'store', tenant: TENANT, store, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none', ...over,
});
const line = (over: Record<string, unknown> = {}) => ({ description: 'Screen repair', quantity: 2, unitPriceCents: 4_999, ...over });
const edit = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, expectedVersion: 3, customerId: CUSTOMER, lines: [line()], ...over });
const planEdit = (b: unknown, targetId: string | null = DRAFT, storeId: string | null = STORE) => planInvoiceDraftUpdate(Object.freeze({
  audience: 'tenant' as const, body: b, newAggregateId: randomUUID(), ...(targetId === null ? {} : { targetId }), ...(storeId === null ? {} : { storeId }),
}));
const sealWith = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString('base64url');

// --- 1. the contract, the event and the route as the runtime registers them --------------------------------------------------

test('IEU-01 AC-05 (D3, D5): the update contract registers against its one event at store scope with the save\'s change set and no typed refusal; the route is the store PATCH template under a key, its body bounded at 64 KiB', () => {
  const events = defineOutboxEvents(INVOICE_DRAFT_EVENTS);
  const commands = defineCommands([INVOICE_DRAFT_CREATE_CONTRACT, INVOICE_DRAFT_UPDATE_CONTRACT], events);
  const contract = commands.contract('store.invoice_draft.update');
  assert.ok(contract !== undefined, 'registered');
  assert.deepEqual([contract.mode, contract.aggregateType, contract.contextScope, contract.sealedRefusal], ['update', 'invoice_draft', 'store', undefined]);
  assert.deepEqual(contract.events, [{ type: 'invoice_draft.updated', version: 1 }]);
  assert.deepEqual(contract.changes, commands.contract('store.invoice_draft.create')?.changes, 'the save\'s change set, field for field');
  assert.equal(INVOICE_DRAFT_UPDATE_CONTRACT.changes, INVOICE_DRAFT_CREATE_CONTRACT.changes, 'one declaration, shared');
  assert.deepEqual(events.contract('invoice_draft.updated', 1)?.payload, events.contract('invoice_draft.created', 1)?.payload, 'identifiers and a count only');
  assert.throws(() => defineCommands([{ ...INVOICE_DRAFT_UPDATE_CONTRACT, sealedRefusal: 'customer_not_found' }], events),
    (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_registry_invalid', 'an update may not opt into the typed 422');
  assert.throws(() => defineCommands([INVOICE_DRAFT_UPDATE_CONTRACT], defineOutboxEvents([INVOICE_DRAFT_EVENTS[0]])),
    (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_registry_invalid', 'its event must be registered');
  const r = INVOICE_DRAFT_UPDATE_ROUTE;
  assert.deepEqual([r.method, r.path, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding], ['PATCH', INVOICE_DRAFT_PATH, 'required', 'required', 'none', undefined]);
  assert.equal(r.policy.access === 'session' ? r.policy.authorization : null, INVOICE_DRAFT_EDIT_REQUIREMENT, 'the edit requirement object itself');
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'edit_invoice_drafts' } });
  assert.deepEqual(r.body, { kind: 'json', maxBytes: INVOICE_DRAFT_MAX_BODY_BYTES, required: true });
  assert.equal(INVOICE_DRAFT_MAX_BODY_BYTES, 65_536);
  assert.ok(Object.isFrozen(r) && 'command' in r && r.command.contract === INVOICE_DRAFT_UPDATE_CONTRACT && r.command.plan === planInvoiceDraftUpdate, 'the contract and planner');
  assert.deepEqual(defineRoutes([INVOICE_DRAFT_CREATE_ROUTE, r, createInvoiceDraftEditEligibilityRoute()]).list().map((d) => `${d.method} ${d.path}`),
    [`POST ${INVOICE_DRAFTS_PATH}`, `PATCH ${INVOICE_DRAFT_PATH}`, `GET ${INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH}`], 'the runtime\'s own table accepts all three');
});

// --- 2. the planner -----------------------------------------------------------------------------------------------------------

test('IEU-02 AC-05 AC-06 (D3): the planner maps a valid body to the path\'s draft and store, the save\'s normalized lines and BigInt subtotal, one event, and both 200s built from the plan alone', () => {
  const out = planEdit(edit({ expectedVersion: 7, lines: [line({ description: '  Glass  ' }), line({ description: 'Labour', quantity: 1, unitPriceCents: 0 })] }));
  assert.deepEqual(out, {
    aggregateId: DRAFT, expectedVersion: 7,
    changes: { storeId: STORE, expectedTenant: TENANT, customerId: CUSTOMER, subtotalCents: 9_998, lines: [
      { description: 'Glass', quantity: 2, unitPriceCents: 4_999 }, { description: 'Labour', quantity: 1, unitPriceCents: 0 },
    ] },
    events: [{ type: 'invoice_draft.updated', payload: { storeId: STORE, customerId: CUSTOMER, lineCount: 2 } }],
    response: { status: 200, body: { draftId: DRAFT, version: 8, changed: true } },
    unchanged: { status: 200, body: { draftId: DRAFT, version: 7, changed: false } },
  });
  // The version bounds: 1 and 2^53 - 2 plan, the next version still exact.
  for (const [expectedVersion, next] of [[1, 2], [MAX - 1, MAX]] as const) {
    const p = planEdit(edit({ expectedVersion })) as CommandPlan;
    assert.deepEqual([p.expectedVersion, p.response.body, p.unchanged?.body], [expectedVersion, { draftId: DRAFT, version: next, changed: true },
      { draftId: DRAFT, version: expectedVersion, changed: false }]);
  }
  // The amount bounds are the save's: one line at exactly 2^53 - 1, fifty lines summing to exactly it, 256 astral scalars.
  const fifty = Array.from({ length: 50 }, (_, i) => line({ description: `L${i}`, quantity: 1, unitPriceCents: i === 0 ? MAX - 49 : 1 }));
  assert.equal((planEdit(edit({ lines: fifty })) as CommandPlan).changes.subtotalCents, MAX);
  assert.notEqual(planEdit(edit({ lines: [line({ quantity: MAX, unitPriceCents: 1 })] })), COMMAND_REQUEST_INVALID);
  assert.notEqual(planEdit(edit({ lines: [line({ description: String.fromCodePoint(0x1f600).repeat(256) })] })), COMMAND_REQUEST_INVALID);
  // The plan is in contract: the runtime prepares it as an update — unchanged and invalid_state sealed, no 422, its event at
  // the next version.
  const prepared = prepareCommand(INVOICE_DRAFT_UPDATE_CONTRACT, defineOutboxEvents(INVOICE_DRAFT_EVENTS), planEdit(edit({ lines: fifty })), {
    scope: 's'.repeat(43), lease: 'l'.repeat(43), newAggregateId: randomUUID(), authorization: INVOICE_DRAFT_EDIT_REQUIREMENT,
    context: scopeAt(STORE), authNotAfter: null, sessionKey: SESSION_KEY, seal: sealWith,
  });
  assert.ok(prepared !== null, 'in contract');
  assert.deepEqual(prepared.unchanged, { status: 200, contentType: 'application/json; charset=utf-8', headers: {}, body: `{"draftId":"${DRAFT}","version":3,"changed":false}` });
  assert.deepEqual(prepared.response.body, `{"draftId":"${DRAFT}","version":4,"changed":true}`);
  assert.deepEqual(prepared.rejected.conflict.body, '{"error":"write_conflict"}');
  assert.deepEqual(prepared.rejected.invalidState?.body, '{"error":"invalid_state"}');
  assert.equal(prepared.rejected.customerNotFound, null);
  assert.deepEqual([prepared.command.mutation.kind, prepared.command.mutation.aggregateId, prepared.command.mutation.expectedVersion], ['store.invoice_draft.update', DRAFT, 3]);
  assert.deepEqual([prepared.command.audit.action, prepared.command.audit.permission, prepared.command.audit.store], ['store.invoice_draft.update', 'edit_invoice_drafts', STORE]);
  assert.deepEqual([prepared.command.events.length, prepared.command.events[0].aggregateVersion, prepared.command.events[0].payload],
    [1, 4, { storeId: STORE, customerId: CUSTOMER, lineCount: 50 }]);
});

test('IEU-03 AC-15 (D3): every invalid edit is COMMAND_REQUEST_INVALID — the closed four-key body (a currency, a total, an id, a status or a creation time included), the version bounds, the ids, the line contract, the path\'s draft and store', () => {
  const without = (key: string) => Object.fromEntries(Object.entries(edit()).filter(([k]) => k !== key));
  const invalid: Array<[string, unknown] | [string, unknown, string | null, string | null]> = [
    ['not an object', [edit()]], ['null', null], ['a string', 'x'],
    ['no expectedTenant', without('expectedTenant')], ['no expectedVersion', without('expectedVersion')], ['no customerId', without('customerId')], ['no lines', without('lines')],
    ['a currency', edit({ currency: 'USD' })], ['a subtotal', edit({ subtotalCents: 9_998 })], ['a total', edit({ totalCents: 9_998 })],
    ['an id', edit({ id: DRAFT })], ['a draft id', edit({ draftId: DRAFT })], ['a status', edit({ status: 'draft' })], ['a creation time', edit({ createdAt: '2026-10-04T12:00:00.000000Z' })],
    ['a creator', edit({ createdBy: ACTOR })], ['a store', edit({ storeId: STORE })], ['a tenant id', edit({ tenantId: TENANT })], ['a version', edit({ version: 3 })],
    ['a line count', edit({ lineCount: 1 })],
    ['version 0', edit({ expectedVersion: 0 })], ['version -1', edit({ expectedVersion: -1 })], ['version 2^53 - 1', edit({ expectedVersion: MAX })],
    ['version 2^53', edit({ expectedVersion: MAX + 1 })], ['version 1.5', edit({ expectedVersion: 1.5 })], ['version as text', edit({ expectedVersion: '3' })],
    ['version null', edit({ expectedVersion: null })], ['version true', edit({ expectedVersion: true })], ['version -0', edit({ expectedVersion: -0 })],
    ['a non-canonical tenant', edit({ expectedTenant: TENANT.toUpperCase() })], ['a tenant that is no uuid', edit({ expectedTenant: 'tenant' })],
    ['a non-canonical customer', edit({ customerId: `{${CUSTOMER}}` })], ['a numeric customer', edit({ customerId: 7 })], ['no customer', edit({ customerId: null })],
    ['an empty line list', edit({ lines: [] })], ['51 lines', edit({ lines: Array.from({ length: 51 }, () => line()) })], ['lines not an array', edit({ lines: line() })],
    ['a line with a position', edit({ lines: [line({ position: 1 })] })], ['a line with a total', edit({ lines: [line({ lineTotalCents: 9_998 })] })],
    ['a line missing a key', edit({ lines: [{ description: 'x', quantity: 1 }] })], ['an empty description', edit({ lines: [line({ description: '' })] })],
    ['257 scalars', edit({ lines: [line({ description: 'x'.repeat(257) })] })], ['a control', edit({ lines: [line({ description: 'a\u0007b' })] })],
    ['a Bidi control', edit({ lines: [line({ description: 'a‮b' })] })], ['quantity 0', edit({ lines: [line({ quantity: 0 })] })],
    ['a fractional quantity', edit({ lines: [line({ quantity: 1.5 })] })], ['a negative price', edit({ lines: [line({ unitPriceCents: -1 })] })],
    ['-0', edit({ lines: [line({ unitPriceCents: -0 })] })], ['a dollar string', edit({ lines: [line({ unitPriceCents: '1.00' })] })],
    ['a product above 2^53 - 1', edit({ lines: [line({ quantity: 2, unitPriceCents: Math.ceil(MAX / 2) })] })],
    ['a sum above 2^53 - 1', edit({ lines: [line({ quantity: 1, unitPriceCents: MAX }), line({ quantity: 1, unitPriceCents: 1 })] })],
    ['no draft id', edit(), null, STORE], ['a non-canonical draft id', edit(), DRAFT.toUpperCase(), STORE],
    ['a draft id outside the outbox\'s aggregate-id shape', edit(), UNVERSIONED, STORE], ['a draft id that is no uuid', edit(), 'draft', STORE],
    ['no store', edit(), DRAFT, null], ['a non-canonical store', edit(), DRAFT, STORE.toUpperCase()],
  ];
  for (const c of invalid) {
    assert.equal(c.length === 4 ? planEdit(c[1], c[2], c[3]) : planEdit(c[1]), COMMAND_REQUEST_INVALID, c[0]);
  }
  assert.match(UNVERSIONED, /^[0-9a-f]{8}-[0-9a-f]{4}-0[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the unversioned id is canonical lowercase (the path accepts it)');
});

test('IEU-04 AC-15 (design §2): the save and the edit share ONE line helper — for every line list, both planners accept exactly what draftLinesOf accepts, with the same rows and subtotal', () => {
  const lists: unknown[] = [
    [line()], [line({ description: ' a ' }), line({ quantity: MAX, unitPriceCents: 0 })], [], [line({ quantity: 0 })], [line({ description: 'a\u0000b' })],
    [line({ unitPriceCents: MAX }), line({ unitPriceCents: 1, quantity: 1 })], Array.from({ length: 50 }, () => line({ unitPriceCents: 1 })),
    Array.from({ length: 51 }, () => line()), [line({ extra: 1 })], 'x', null,
  ];
  for (const lines of lists) {
    const helper = draftLinesOf(lines);
    const created = planInvoiceDraftCreate({ audience: 'tenant', newAggregateId: randomUUID(), targetId: STORE,
      body: { expectedTenant: TENANT, customerId: CUSTOMER, currency: 'USD', lines } });
    const edited = planEdit(edit({ lines }));
    const label = JSON.stringify(lines).slice(0, 60);
    if (helper === null) {
      assert.deepEqual([created, edited], [COMMAND_REQUEST_INVALID, COMMAND_REQUEST_INVALID], label);
    } else {
      assert.ok(created !== COMMAND_REQUEST_INVALID && edited !== COMMAND_REQUEST_INVALID, label);
      for (const p of [created, edited]) assert.deepEqual([p.changes.lines, p.changes.subtotalCents], [helper.rows, helper.subtotalCents], label);
    }
  }
});

// --- 3. the edit eligibility, its declaration and its handler -------------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }
async function runHandler(route: ReturnType<typeof createInvoiceDraftEditEligibilityRoute>, path: string, opts: { url?: string; trusted?: TrustedScope | null; sessionKey?: string | null } = {}) {
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

test('IEU-05 AC-04 (D2): the edit eligibility is a session-bound STORE-scope GET under the edit\'s own requirement object; its handler refuses a query (400), a scope not at the path\'s store (403), then a malformed id (400) — and otherwise answers exactly the creation eligibility\'s body, for any well-formed id', async () => {
  const r = createInvoiceDraftEditEligibilityRoute();
  assert.equal(INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH, '/api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility');
  assert.deepEqual([r.method, r.path, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding], ['GET', INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH, 'none', 'required', 'none', 'required']);
  assert.deepEqual(r.body, { kind: 'none' });
  assert.ok(r.policy.access === 'session' && r.policy.authorization === INVOICE_DRAFT_EDIT_REQUIREMENT, 'the PATCH\'s own requirement object');
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.policy) && Object.isFrozen(INVOICE_DRAFT_EDIT_REQUIREMENT), 'frozen');
  const create = createInvoiceDraftEligibilityRoute();
  assert.ok(create.policy.access === 'session' && create.policy.authorization !== INVOICE_DRAFT_EDIT_REQUIREMENT, 'the creation eligibility keeps the create requirement');
  const at = (id: string, store: string = STORE) => `/api/v1/stores/${store}/invoice-drafts/${id}/edit-eligibility`;
  for (const url of [`${at(DRAFT)}?`, `${at(DRAFT)}?x=1`, `${at('x')}?x=1`]) {
    const out = await runHandler(r, at(DRAFT), { url });
    assert.deepEqual([out.status, out.body, out.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, 'invoice_draft_edit_eligibility_query_invalid'], url);
  }
  for (const [label, path, opts] of [
    ['no trusted scope', at(DRAFT), { trusted: null }], ['a tenant scope', at(DRAFT), { trusted: scopeAt(STORE, { scope: 'tenant', store: null }) }],
    ['the trusted store is not the path\'s', at(DRAFT), { trusted: scopeAt(OTHER_STORE) }], ['no session key', at(DRAFT), { sessionKey: null }],
    ['a non-canonical path store', at(DRAFT, STORE.toUpperCase()), {}], ['the scope first, before a malformed id', at('x'), { trusted: null }],
  ] as const) {
    const out = await runHandler(r, path, opts);
    assert.deepEqual([out.status, out.body, out.locals.refusal], [403, { error: 'forbidden', requestId: 'req-9' }, 'authz_context_missing'], label);
  }
  for (const id of [DRAFT.toUpperCase(), 'x', '{id}', `${DRAFT}0`, 'eligibility', 'edit-eligibility']) {
    const out = await runHandler(r, at(id));
    assert.deepEqual([out.status, out.body, out.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, 'invoice_draft_id_invalid'], id);
  }
  // No draft is read: any well-formed id — a draft, another, a random one, an unversioned one — is the same answer, the
  // creation eligibility's very body.
  const created = await runHandler(create, `/api/v1/stores/${STORE}/invoice-drafts/eligibility`);
  for (const id of [DRAFT, OTHER_DRAFT, randomUUID(), UNVERSIONED]) {
    const out = await runHandler(r, at(id));
    assert.deepEqual([out.status, out.body, out.locals.refusal], [200, { eligibility: 'allowed' }, undefined], id);
    assert.equal(JSON.stringify(out.body), JSON.stringify(created.body), 'byte-equal to the creation eligibility\'s');
  }
});

// --- 4. the edit over the enforced chain ------------------------------------------------------------------------------------

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
type Answer = 'committed' | 'unchanged' | 'conflict' | 'invalid_state' | 'not_found' | 'precondition_failed' | 'unavailable';
interface Chain {
  commits: TransactionCommand[];
  views: unknown[];
  requirements: unknown[];
  records: Map<string, { readonly fingerprint: string; readonly response: string | null }>;
  logs: Record<string, unknown>[];
  answer: (a: Answer) => void;
  setScopeFor: (scopeFor: ((storeTarget: string | null) => TrustedScope | false) | null) => void;
  patch: (store: string, draft: string, payload: string, key: string) => Promise<Reply>;
  post: (store: string, payload: string, key: string) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
}
async function withChain(fn: (h: Chain) => Promise<void>): Promise<void> {
  const commits: TransactionCommand[] = [];
  const views: unknown[] = [];
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
      if (next === 'unchanged') return complete(c, c.unchanged, s, 'unchanged');
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
      views.push(view);
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
    routes: [INVOICE_DRAFT_CREATE_ROUTE, INVOICE_DRAFT_UPDATE_ROUTE, createInvoiceDraftEligibilityRoute(), createInvoiceDraftEditEligibilityRoute()],
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
    views.length = 0;
    requirements.length = 0;
    const unsafe = (method: string, path: string, payload: string, key: string) => request(p, method, path, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': key,
    }, payload);
    await fn({
      commits, views, requirements, records: state.records, logs, answer: (a) => { next = a; }, setScopeFor: (f) => { scopeFor = f; },
      patch: (store, draft, payload, key) => unsafe('PATCH', `/api/v1/stores/${store}/invoice-drafts/${draft}`, payload, key),
      post: (store, payload, key) => unsafe('POST', `/api/v1/stores/${store}/invoice-drafts`, payload, key),
      get: (path) => request(p, 'GET', path, { cookie, [SESSION_CSRF_HEADER]: csrf }),
    });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const reasonOf = (h: Chain, r: Reply): unknown => h.logs.find((l) => l.event === 'request' && l.requestId === r.headers['x-request-id'])?.reason;

test('IEU-06 AC-05 AC-06 AC-07 AC-10 (D3): over the chain, each store answer is its exact status and body — the sealed 200s and 409s replayed byte for byte under their key; the 404 and the precondition 409 unsealed, their lease kept; 503 otherwise', async () => {
  await withChain(async (h) => {
    const payload = JSON.stringify(edit());
    const cases: Array<[Answer, number, string | null, boolean]> = [
      // answer, status, exact body (null: the chain's { error, requestId }), sealed (replayed under the key)
      ['committed', 200, `{"draftId":"${DRAFT}","version":4,"changed":true}`, true],
      ['unchanged', 200, `{"draftId":"${DRAFT}","version":3,"changed":false}`, true],
      ['conflict', 409, '{"error":"write_conflict"}', true],
      ['invalid_state', 409, '{"error":"invalid_state"}', true],
      ['not_found', 404, null, false],
      ['precondition_failed', 409, null, false],
      ['unavailable', 503, null, false],
    ];
    for (const [answer, status, exact, sealed] of cases) {
      h.answer(answer);
      const key = randomUUID();
      const first = await h.patch(STORE, DRAFT, payload, key);
      assert.equal(first.status, status, `${answer}: ${first.body}`);
      if (exact !== null) {
        assert.equal(first.body, exact, `${answer}: the exact sealed body`);
      } else {
        const parsed = JSON.parse(first.body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(parsed), ['error', 'requestId'], answer);
        assert.equal(parsed.error, { not_found: 'not_found', precondition_failed: 'write_conflict', unavailable: 'service_unavailable' }[answer as string], answer);
      }
      assert.equal(first.headers['cache-control'], 'no-store', answer);
      const commits = h.commits.length;
      h.answer('committed'); // a retry that planned again would now be the changed 200: a replay never plans
      const retry = await h.patch(STORE, DRAFT, payload, key);
      if (sealed) {
        assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [status, first.body, 'true'], `${answer}: replayed`);
      } else {
        assert.deepEqual([retry.status, JSON.parse(retry.body).error], [409, 'request_in_progress'], `${answer}: nothing recorded, the lease kept`);
      }
      assert.equal(h.commits.length, commits, `${answer}: the retry planned and committed nothing`);
    }
    // The unsealed precondition is the runtime's own reason, by kind; a not_found the update's.
    h.answer('precondition_failed');
    const pre = await h.patch(STORE, DRAFT, payload, randomUUID());
    assert.equal(reasonOf(h, pre), 'transaction_precondition_failed');
    h.answer('not_found');
    assert.equal(reasonOf(h, await h.patch(STORE, DRAFT, payload, randomUUID())), 'transaction_not_found');
    // The command the store was handed: the draft, the expected version, the store from the path (the trusted one), the event.
    const c = h.commits[0];
    assert.deepEqual([c.mutation.kind, c.mutation.aggregateId, c.mutation.expectedVersion, (c.mutation.changes as { storeId?: unknown }).storeId],
      ['store.invoice_draft.update', DRAFT, 3, STORE]);
    assert.deepEqual([c.context?.scope, c.context?.store, c.audit.permission, c.events[0].type, c.events[0].aggregateVersion, c.events[0].payload],
      ['store', STORE, 'edit_invoice_drafts', 'invoice_draft.updated', 4, { storeId: STORE, customerId: CUSTOMER, lineCount: 1 }]);
    assert.deepEqual(h.requirements.at(-1), INVOICE_DRAFT_EDIT_REQUIREMENT, 'the PATCH is decided under the edit requirement');
  });
});

test('IEU-07 AC-12 (D4): the PATCH binds its DRAFT id as the fingerprint\'s target beside the trusted store — one key at two drafts or with other bytes is the 422 — while the save, beside it, still binds its store; a malformed id or a scope at another store reserves nothing; an unversioned id is the planner\'s 400', async () => {
  await withChain(async (h) => {
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    const payload = JSON.stringify(edit());
    const key = randomUUID();
    const edited = await h.patch(STORE, DRAFT, payload, key);
    assert.equal(edited.status, 200, edited.body);
    const [c] = h.commits;
    const binding = { method: 'PATCH' as const, path: INVOICE_DRAFT_PATH, audience: 'tenant' as const, tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from(payload) };
    const expected = keyring.operationOf(key, PRINCIPAL, { ...binding, target: DRAFT });
    assert.equal(c.scope, expected.scope);
    assert.equal(h.records.get(c.scope)?.fingerprint, expected.fingerprint, 'the reserved fingerprint carries the draft as its target');
    for (const target of [STORE, null, OTHER_DRAFT]) {
      assert.notEqual(keyring.operationOf(key, PRINCIPAL, { ...binding, target }).fingerprint, expected.fingerprint, `non-vacuous: target ${String(target)}`);
    }
    // One key: the same bytes at another draft, and other bytes (another version, other line order) at this draft, are each
    // another request — the 422 before any commit, never this draft's answer replayed.
    const commits = h.commits.length;
    const reordered = JSON.stringify(edit({ lines: [line({ description: 'B' }), line({ description: 'A' })] }));
    for (const [label, draft, bytes] of [['another draft', OTHER_DRAFT, payload], ['another version', DRAFT, JSON.stringify(edit({ expectedVersion: 4 }))],
      ['the same JSON value re-spaced', DRAFT, JSON.stringify(edit(), null, 1)], ['another line order', DRAFT, reordered]] as const) {
      const reused = await h.patch(STORE, draft, bytes, key);
      assert.deepEqual([reused.status, JSON.parse(reused.body).error], [422, 'idempotency_key_reused'], label);
    }
    assert.equal(h.commits.length, commits, 'nothing planned or committed');
    // The save beside it still binds its STORE as the target (its fingerprint unchanged by this stage).
    const saveKey = randomUUID();
    const saveBytes = JSON.stringify({ expectedTenant: TENANT, customerId: CUSTOMER, currency: 'USD', lines: [line()] });
    const saved = await h.post(STORE, saveBytes, saveKey);
    assert.equal(saved.status, 201, saved.body);
    const s = h.commits.at(-1) as TransactionCommand;
    assert.equal(h.records.get(s.scope)?.fingerprint, keyring.operationOf(saveKey, PRINCIPAL,
      { method: 'POST', path: INVOICE_DRAFTS_PATH, audience: 'tenant', tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from(saveBytes), target: STORE }).fingerprint,
    'the save\'s fingerprint target is still its store');
    assert.equal((s.mutation.changes as { storeId?: unknown }).storeId, STORE);
    // A malformed draft segment: the target's 400 before the body or a key — nothing reserved.
    const records = h.records.size;
    for (const segment of [DRAFT.toUpperCase(), 'x', '{id}', `${DRAFT}0`, 'eligibility']) {
      const bad = await h.patch(STORE, segment, payload, randomUUID());
      assert.deepEqual([bad.status, JSON.parse(bad.body).error, reasonOf(h, bad)], [400, 'invalid_request', 'command_target_invalid'], segment);
    }
    // A scope the authorizer resolved at another store than the path's: the 403 before the body or a key.
    h.setScopeFor(() => scopeAt(OTHER_STORE));
    const elsewhere = await h.patch(STORE, DRAFT, payload, randomUUID());
    assert.deepEqual([elsewhere.status, reasonOf(h, elsewhere)], [403, 'authz_context_missing']);
    h.setScopeFor(null);
    assert.equal(h.records.size, records, 'no idempotency record was reserved');
    // A canonical id outside the outbox's aggregate-id shape: the planner's 400 once the key is reserved, committing nothing.
    const commitsBefore = h.commits.length;
    const unversioned = await h.patch(STORE, UNVERSIONED, payload, randomUUID());
    assert.deepEqual([unversioned.status, JSON.parse(unversioned.body).error, reasonOf(h, unversioned)], [400, 'invalid_request', 'command_request_invalid']);
    assert.deepEqual([h.records.size, h.commits.length], [records + 1, commitsBefore]);
  });
});

test('IEU-08 AC-15 AC-04 (D2, D3): the PATCH body is bounded at exactly 64 KiB (the 413 one byte over, reserving nothing); the edit eligibility answers over the chain under the edit requirement, byte-equal to the creation eligibility\'s answer, reserving and committing nothing', async () => {
  await withChain(async (h) => {
    const base = JSON.stringify(edit());
    // Whitespace is JSON: pad a valid body to exactly the bound, then one byte past it.
    const atBound = base.slice(0, -1) + ' '.repeat(INVOICE_DRAFT_MAX_BODY_BYTES - Buffer.byteLength(base)) + '}';
    assert.equal(Buffer.byteLength(atBound), 65_536);
    const ok = await h.patch(STORE, DRAFT, atBound, randomUUID());
    assert.equal(ok.status, 200, ok.body);
    const records = h.records.size;
    const commits = h.commits.length;
    const over = await h.patch(STORE, DRAFT, `${atBound} `, randomUUID());
    assert.deepEqual([over.status, JSON.parse(over.body).error], [413, 'content_too_large']);
    assert.deepEqual([h.records.size, h.commits.length], [records, commits], 'the 413 reserves nothing');
    // The two eligibility answers: each under its own command's requirement, the same bytes.
    h.requirements.length = 0;
    const editable = await h.get(`/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/edit-eligibility`);
    const creatable = await h.get(`/api/v1/stores/${STORE}/invoice-drafts/eligibility`);
    assert.deepEqual([editable.status, creatable.status], [200, 200], `${editable.body} ${creatable.body}`);
    assert.equal(editable.body, '{"eligibility":"allowed"}');
    assert.equal(editable.body, creatable.body, 'byte-equal answers');
    assert.deepEqual(h.requirements, [INVOICE_DRAFT_EDIT_REQUIREMENT, { scope: 'store', permission: 'create_invoice_drafts' }]);
    assert.equal(editable.headers['cache-control'], 'no-store');
    // Denied by the authorizer: the chain's 403 for the edit eligibility, its handler never reached; a malformed id is the 400.
    h.setScopeFor(() => false);
    const denied = await h.get(`/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/edit-eligibility`);
    h.setScopeFor(null);
    assert.deepEqual([denied.status, JSON.parse(denied.body).error, reasonOf(h, denied)], [403, 'forbidden', 'authz_denied']);
    const malformed = await h.get(`/api/v1/stores/${STORE}/invoice-drafts/x/edit-eligibility`);
    assert.deepEqual([malformed.status, JSON.parse(malformed.body).error, reasonOf(h, malformed)], [400, 'invalid_request', 'invoice_draft_id_invalid']);
    // A PATCH on the edit eligibility, or another suffix after the id, is no route.
    const records2 = h.records.size;
    assert.equal((await h.patch(STORE, `${DRAFT}/edit-eligibility`, atBound, randomUUID())).status, 404);
    assert.equal((await h.get(`/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/eligibility`)).status, 404);
    assert.deepEqual([h.records.size, h.commits.length], [records2, commits], 'no eligibility answer reserves or commits anything');
  });
});
