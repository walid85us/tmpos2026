// Phase 4.0 M7B-PAYMENTS-P2 (PRQ-1, migration 037) — the payment registration, its proof, the settlement and the staff
// member's attempts, below the database: the two contracts and four route declarations, the record v2 body, D-R3-A's session
// slot in the fingerprint, the strict planners, the proof and attempts decoders and handlers, and each store answer over the
// enforced chain (a replacement session's 422 included). The routines are proved against a real cluster by IRR and IRH; the
// P1 record, reversal and read cases stay in invoicePayments.test.ts (whose reviewed fixture line is pinned by the semgrep
// exact inventory, so nothing but the record v2 adaptation is added there).
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
  INVOICE_PAYMENTS_ASK, INVOICE_PAYMENTS_PAGE_SIZE, INVOICE_PAYMENTS_PATH, INVOICE_PAYMENTS_VIEW_REQUIREMENT, INVOICE_PAYMENT_ELIGIBILITY_PATH,
  INVOICE_PAYMENT_MAX_BODY_BYTES, INVOICE_PAYMENT_METHODS, INVOICE_PAYMENT_METHOD_LABELS, INVOICE_PAYMENT_RECORD_CONTRACT, INVOICE_PAYMENT_RECORD_PATH,
  INVOICE_PAYMENT_RECORD_REQUIREMENT, INVOICE_PAYMENT_RECORD_ROUTE, INVOICE_PAYMENT_REVERSAL_ELIGIBILITY_PATH, INVOICE_PAYMENT_REVERSAL_REASON_CODES,
  INVOICE_PAYMENT_REVERSAL_REASON_LABELS, INVOICE_PAYMENT_REVERSE_CONTRACT, INVOICE_PAYMENT_REVERSE_PATH, INVOICE_PAYMENT_REVERSE_REQUIREMENT,
  INVOICE_PAYMENT_REVERSE_ROUTE, INVOICE_PAYMENT_STATUSES, createInvoicePaymentEligibilityRoute, createInvoicePaymentReversalEligibilityRoute,
  createInvoicePaymentsRoute, invoicePaymentsOf, parseInvoicePaymentsQuery, planInvoicePaymentRecord, planInvoicePaymentReverse,
  INVOICE_PAYMENT_ATTEMPTS_ASK, INVOICE_PAYMENT_ATTEMPTS_PATH, INVOICE_PAYMENT_ATTEMPT_STATES, INVOICE_PAYMENT_REGISTER_CONTRACT, INVOICE_PAYMENT_REGISTER_PATH,
  INVOICE_PAYMENT_REGISTER_ROUTE, INVOICE_PAYMENT_REGISTRATION_PROOF_PATH, INVOICE_PAYMENT_SETTLE_CONTRACT, INVOICE_PAYMENT_SETTLE_PATH,
  INVOICE_PAYMENT_SETTLE_ROUTE, createInvoicePaymentAttemptsRoute, createInvoicePaymentRegistrationProofRoute, invoicePaymentAttemptsOf,
  parseInvoicePaymentAttemptsQuery, parseRegistrationProofQuery, planInvoicePaymentRegister, planInvoicePaymentSettle, registrationProofOf,
} from './invoicePayments.js';
import type { InvoicePaymentRegistrationsPort, InvoicePaymentsPort } from './invoicePayments.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, defineRoutes, sessionPaths } from './routes.js';
import type { CommandPlan, RouteContext, RouteDefinition } from './routes.js';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const ACTOR = randomUUID();
const TENANT = randomUUID();
const STORE = randomUUID();
const OTHER_STORE = randomUUID();
const MEMBERSHIP = randomUUID();
const INVOICE = randomUUID();
const OTHER_INVOICE = randomUUID();
const PAYMENT = randomUUID();
const OTHER_PAYMENT = randomUUID();
const ATTEMPT = randomUUID();
const NEW_ID = randomUUID();
const SESSION_KEY = 'k'.repeat(43);
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
const PRINCIPAL = Object.freeze({ authProvider: 'synthetic', authProviderUid: 'uid-payments' });
const MAX = Number.MAX_SAFE_INTEGER;
/** A uuid whose version nibble is 0: canonical text, but not the outbox's aggregate-id shape. */
const UNVERSIONED = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
const scopeAt = (store: string, over: Partial<TrustedScope> = {}): TrustedScope => Object.freeze({
  actor: ACTOR, securityVersion: 'v1', scope: 'store', tenant: TENANT, store, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none', ...over,
});
const REGISTRATION = randomUUID();
/** A synthetic registration proof: 64 lowercase hex digits (never a real MAC). */
const PROOF = 'ab'.repeat(32);
// M7B-PAYMENTS-P2: the record v2 body names its registration and the registration's proof.
const recordBody = (over: Record<string, unknown> = {}) => ({
  expectedTenant: TENANT, registrationId: REGISTRATION, attemptId: ATTEMPT, amountCents: 1250, method: 'cash', registrationProof: PROOF, ...over,
});
const reverseBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, reasonCode: 'duplicate', ...over });
const planRecord = (body: unknown, over: Record<string, unknown> = {}) => planInvoicePaymentRecord(Object.freeze({
  audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE, ...over,
}) as never);
const planReverse = (body: unknown, over: Record<string, unknown> = {}) => planInvoicePaymentReverse(Object.freeze({
  audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE, paymentId: PAYMENT, ...over,
}) as never);
const sealWith = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString('base64url');

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }
async function runHandler(route: RouteDefinition, path: string, opts: { url?: string; trusted?: TrustedScope | null; sessionKey?: string | null } = {}) {
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

const TIME = (n: number) => `2026-11-07T10:00:${String(n).padStart(2, '0')}.000000Z`;
/** One payment as the port answers it, the n-th in order (ids made ascending by their first byte). */
const portPayment = (n: number, over: Record<string, unknown> = {}) => ({
  id: `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, attemptId: randomUUID(), amountCents: 100, method: 'cash', recordedAt: TIME(n % 60),
  reversal: null, ...over,
});
const answerOf = (payments: unknown[], over: Record<string, unknown> = {}) => ({
  outcome: 'payments', invoice: { id: INVOICE, status: 'issued' }, currency: 'USD', totalCents: 1000, dueCents: 1000,
  appliedCents: payments.filter((p) => (p as { reversal: unknown }).reversal === null).reduce((s: number, p) => s + (p as { amountCents: number }).amountCents, 0),
  remainingCents: 0, paymentStatus: 'recorded_partly', payments, ...over,
});
/** A consistent answer: remaining and the word derived from `applied`. */
function consistent(payments: unknown[], over: Record<string, unknown> = {}) {
  const raw = answerOf(payments, over) as Record<string, unknown> & { dueCents: number; appliedCents: number };
  const word = raw.dueCents === 0 ? 'nothing_due' : raw.appliedCents === 0 ? 'no_payment_recorded' : raw.appliedCents === raw.dueCents ? 'recorded_in_full' : 'recorded_partly';
  return { ...raw, remainingCents: raw.dueCents - raw.appliedCents, paymentStatus: word, ...over };
}

// --- the enforced chain ------------------------------------------------------------------------------------

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

type Answer = 'committed' | 'conflict' | 'invalid_state' | 'already_recorded' | 'amount_exceeds_remaining' | 'not_found' | 'precondition_failed' | 'unavailable'
  | 'unchanged';
interface Chain {
  commits: TransactionCommand[];
  plans: unknown[];
  requirements: unknown[];
  records: Map<string, { readonly fingerprint: string; readonly response: string | null }>;
  logs: Record<string, unknown>[];
  authenticatedAt: number;
  answer: (a: Answer) => void;
  send: (path: string, payload: string, key: string) => Promise<Reply>;
  /** A NEW session of the same principal (a re-authentication): its own cookie and CSRF token, the same actor (D-R3-A). */
  relogin: () => Promise<(path: string, payload: string, key: string) => Promise<Reply>>;
}
async function withChain(fn: (h: Chain) => Promise<void>, opts: { authenticatedAt?: number } = {}): Promise<void> {
  const commits: TransactionCommand[] = [];
  const plans: unknown[] = [];
  const requirements: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const authenticatedAt = opts.authenticatedAt ?? Date.now();
  let next: Answer = 'committed';
  const state = createMemoryIdempotencyState();
  const inner = createMemoryIdempotencyStore(state);
  const complete = async (c: TransactionCommand, sealed: string | null | undefined, s: AbortSignal, outcome: string) => {
    if (sealed === null || sealed === undefined) return { outcome: 'unavailable' };
    const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: sealed }), s);
    return (done as { outcome?: unknown }).outcome === 'completed' ? { outcome } : { outcome: 'lease_lost' };
  };
  const port: CommandTransactionPort = {
    async commit(c, s) {
      commits.push(c);
      if (next === 'committed') return complete(c, c.response, s, 'committed');
      if (next === 'conflict') return complete(c, c.rejected.conflict, s, 'conflict');
      if (next === 'invalid_state') return complete(c, c.rejected.invalidState, s, 'invalid_state');
      if (next === 'already_recorded') return complete(c, c.rejected.alreadyRecorded, s, 'already_recorded');
      if (next === 'amount_exceeds_remaining') return complete(c, c.rejected.amountExceedsRemaining, s, 'amount_exceeds_remaining');
      if (next === 'unchanged') return complete(c, c.unchanged, s, 'unchanged');
      return { outcome: next };
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
      return typeof view.storeTarget === 'string' ? { granted: true, context: scopeAt(view.storeTarget) } : false;
    } },
    store: createMemorySessionStore(),
  };
  const capture = (route: RouteDefinition): RouteDefinition => ('command' in route
    ? { ...route, command: { ...route.command, plan: (ctx) => { plans.push(ctx); return route.command.plan(ctx); } } } : route);
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: (l: string) => { logs.push(JSON.parse(l) as Record<string, unknown>); } }, sessions: { tenant: boundary },
    routes: [capture(INVOICE_PAYMENT_RECORD_ROUTE), capture(INVOICE_PAYMENT_REVERSE_ROUTE), createInvoicePaymentEligibilityRoute(), createInvoicePaymentReversalEligibilityRoute(),
      capture(INVOICE_PAYMENT_REGISTER_ROUTE), capture(INVOICE_PAYMENT_SETTLE_ROUTE)],
    events: [], limits: testRequestLimits(), idempotency: { store: inner, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = (server.address() as AddressInfo).port;
    const relogin = async () => {
      const login = await request(p, 'POST', sessionPaths('tenant').login, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
      });
      assert.equal(login.status, 200, login.body);
      const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
      const cookie = `${SESSION_COOKIES.tenant}=${pair.slice(pair.indexOf('=') + 1)}`;
      const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
      return (path: string, payload: string, key: string) => request(p, 'POST', path, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        cookie, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': key,
      }, payload);
    };
    const send = await relogin();
    requirements.length = 0;
    await fn({ commits, plans, requirements, records: state.records, logs, authenticatedAt, answer: (a) => { next = a; }, send, relogin });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const reasonOf = (h: Chain, r: Reply): unknown => h.logs.find((l) => l.event === 'request' && l.requestId === r.headers['x-request-id'])?.reason;
function assertUnsealed(r: Reply, error: string, label: string): void {
  assert.equal(r.body, JSON.stringify({ error, requestId: r.headers['x-request-id'] }), `${label}: the chain's exact bytes`);
}
const recordAt = (invoice: string = INVOICE, store: string = STORE) => `/api/v1/stores/${store}/invoices/${invoice}/payments`;
const reverseAt = (payment: string = PAYMENT, invoice: string = INVOICE) => `/api/v1/stores/${STORE}/invoices/${invoice}/payments/${payment}/reversal`;

// --- the registration, its proof, the settlement and the attempts ---------------------------------------------------------

const registerBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, attemptId: ATTEMPT, ...over });
const settleBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, attemptId: ATTEMPT, expectedVersion: 1, ...over });
const planRegister = (body: unknown, over: Record<string, unknown> = {}) => planInvoicePaymentRegister(Object.freeze({
  audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE, ...over,
}) as never);
const planSettle = (body: unknown, over: Record<string, unknown> = {}) => planInvoicePaymentSettle(Object.freeze({
  audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE, ...over,
}) as never);

test('IRU-01 (PRQ-1): the registration is a store-scope CREATE opting into the record refusals, the settlement an UPDATE; both under record_invoice_payments, no recent sign-in; the registration and the record alone session-bound; the exact plans (never a proof in an answer); the fingerprint\'s session slot', () => {
  assert.deepEqual([INVOICE_PAYMENT_REGISTER_CONTRACT.kind, INVOICE_PAYMENT_REGISTER_CONTRACT.mode, INVOICE_PAYMENT_REGISTER_CONTRACT.aggregateType,
    INVOICE_PAYMENT_REGISTER_CONTRACT.contextScope, INVOICE_PAYMENT_REGISTER_CONTRACT.events, INVOICE_PAYMENT_REGISTER_CONTRACT.paymentRefusals],
  ['store.invoice_payment.register', 'create', 'invoice_payment_registration', 'store', [], 'record']);
  assert.deepEqual([INVOICE_PAYMENT_SETTLE_CONTRACT.kind, INVOICE_PAYMENT_SETTLE_CONTRACT.mode, INVOICE_PAYMENT_SETTLE_CONTRACT.aggregateType,
    INVOICE_PAYMENT_SETTLE_CONTRACT.contextScope, INVOICE_PAYMENT_SETTLE_CONTRACT.events, INVOICE_PAYMENT_SETTLE_CONTRACT.paymentRefusals],
  ['store.invoice_payment.settle', 'update', 'invoice_payment_registration', 'store', [], undefined]);
  for (const c of [INVOICE_PAYMENT_REGISTER_CONTRACT, INVOICE_PAYMENT_SETTLE_CONTRACT]) assert.deepEqual(Object.keys(c.changes), ['invoiceId', 'expectedTenant', 'attemptId']);
  assert.deepEqual([INVOICE_PAYMENT_REGISTER_PATH, INVOICE_PAYMENT_SETTLE_PATH, INVOICE_PAYMENT_REGISTRATION_PROOF_PATH, INVOICE_PAYMENT_ATTEMPTS_PATH], [
    '/api/v1/stores/{storeId}/invoices/{id}/payment-registrations', '/api/v1/stores/{storeId}/invoices/{id}/payment-settlement',
    '/api/v1/stores/{storeId}/invoices/{id}/payment-registration-proof', '/api/v1/stores/{storeId}/payment-attempts']);
  for (const [route, sessionBinding] of [[INVOICE_PAYMENT_REGISTER_ROUTE, 'required'], [INVOICE_PAYMENT_SETTLE_ROUTE, undefined]] as const) {
    assert.ok(Object.isFrozen(route));
    assert.deepEqual([route.method, route.policy, route.body, route.idempotency, route.trustedContext, route.recentAuth, route.sessionBinding],
      ['POST', { access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT }, { kind: 'json', maxBytes: 1024, required: true }, 'required', 'required', 'none', sessionBinding]);
  }
  const port = { proof: () => null, attempts: () => null };
  const reads = [createInvoicePaymentRegistrationProofRoute({ invoicePaymentRegistrations: port }), createInvoicePaymentAttemptsRoute({ invoicePaymentRegistrations: port })];
  assert.deepEqual(reads.map((r) => [r.method, r.path, r.policy, r.idempotency, r.recentAuth, r.sessionBinding, r.trustedContext]), [
    ['GET', INVOICE_PAYMENT_REGISTRATION_PROOF_PATH, { access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT }, 'none', 'none', 'required', 'required'],
    ['GET', INVOICE_PAYMENT_ATTEMPTS_PATH, { access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT }, 'none', 'none', 'required', 'required'],
  ]);
  assert.doesNotThrow(() => defineRoutes([INVOICE_PAYMENT_RECORD_ROUTE, INVOICE_PAYMENT_REVERSE_ROUTE, INVOICE_PAYMENT_REGISTER_ROUTE, INVOICE_PAYMENT_SETTLE_ROUTE, ...reads]));
  assert.doesNotThrow(() => defineCommands([INVOICE_PAYMENT_RECORD_CONTRACT, INVOICE_PAYMENT_REVERSE_CONTRACT, INVOICE_PAYMENT_REGISTER_CONTRACT, INVOICE_PAYMENT_SETTLE_CONTRACT], defineOutboxEvents([])));
  // D-R3-A is declared, never defaulted: the record or the registration without its binding fails registration; the reversal or
  // the settlement with one fails too.
  for (const [label, def] of [['the record unbound', { ...INVOICE_PAYMENT_RECORD_ROUTE, sessionBinding: 'none' }],
    ['the registration undeclared', { ...INVOICE_PAYMENT_REGISTER_ROUTE, sessionBinding: undefined }],
    ['the settlement bound', { ...INVOICE_PAYMENT_SETTLE_ROUTE, sessionBinding: 'required' }], ['the reversal bound', { ...INVOICE_PAYMENT_REVERSE_ROUTE, sessionBinding: 'required' }]] as const) {
    assert.throws(() => defineRoutes([def as RouteDefinition]), /route_session_binding_invalid/, label);
  }
  for (const [label, ports] of [['no port', {}], ['no proof', { invoicePaymentRegistrations: { attempts: () => null } }]] as const) {
    assert.throws(() => createInvoicePaymentRegistrationProofRoute(ports as never), /route_handler_invalid/, label);
  }
  assert.throws(() => createInvoicePaymentAttemptsRoute({ invoicePaymentRegistrations: { proof: () => null } } as never), /route_handler_invalid/);
  assert.throws(() => createInvoicePaymentAttemptsRoute({ invoicePaymentRegistrations: port }, { deadlineMs: 0 }), /port_deadline_invalid/);

  // The registration's plan: the runtime's new id, the path's invoice, the open 201 — no proof, no version.
  assert.deepEqual(planRegister(registerBody()), {
    aggregateId: NEW_ID, expectedVersion: null, changes: { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT }, events: [],
    response: { status: 201, body: { registration: { id: NEW_ID, invoiceId: INVOICE, attemptId: ATTEMPT, state: 'open' } } },
  });
  for (const [label, body] of [['no body', undefined], ['no attempt', { expectedTenant: TENANT }], ['no tenant', { attemptId: ATTEMPT }],
    ['a proof', registerBody({ proof: PROOF })], ['a registration id', registerBody({ registrationId: REGISTRATION })], ['an amount', registerBody({ amountCents: 1 })],
    ['an uppercase attempt', registerBody({ attemptId: ATTEMPT.toUpperCase() })], ['a tenant that is no uuid', registerBody({ expectedTenant: 't' })]] as const) {
    assert.equal(planRegister(body), COMMAND_REQUEST_INVALID, label);
  }
  for (const [label, over] of [['no invoice', { targetId: undefined }], ['an unversioned invoice', { targetId: UNVERSIONED }], ['no store', { storeId: undefined }],
    ['a payment id segment', { paymentId: PAYMENT }], ['a new id that is no uuid', { newAggregateId: 'x' }]] as const) {
    assert.equal(planRegister(registerBody(), over), COMMAND_REQUEST_INVALID, label);
  }
  // The settlement's plan: the body's attempt at the body's version; the same 200 as the planned no-op.
  for (const [expectedVersion, state] of [[1, 'withdrawn'], [2, 'confirmed']] as const) {
    const response = { status: 200, body: { settlement: { invoiceId: INVOICE, attemptId: ATTEMPT, state } } };
    assert.deepEqual(planSettle(settleBody({ expectedVersion })), {
      aggregateId: ATTEMPT, expectedVersion, changes: { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT }, events: [], response, unchanged: response,
    }, state);
  }
  for (const [label, body] of [['version 0', settleBody({ expectedVersion: 0 })], ['version 3', settleBody({ expectedVersion: 3 })],
    ['a version as text', settleBody({ expectedVersion: '1' })], ['no version', { expectedTenant: TENANT, attemptId: ATTEMPT }], ['a registration id', settleBody({ registrationId: REGISTRATION })],
    ['an uppercase attempt', settleBody({ attemptId: ATTEMPT.toUpperCase() })], ['no body', undefined]] as const) {
    assert.equal(planSettle(body), COMMAND_REQUEST_INVALID, label);
  }
  assert.equal(planSettle(settleBody(), { paymentId: PAYMENT }), COMMAND_REQUEST_INVALID, 'a payment id segment');

  // The session slot: appended last, tagged; absent when null or undefined; another session is another fingerprint, the same scope.
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const key = randomUUID();
  const binding = { method: 'POST', path: INVOICE_PAYMENT_RECORD_PATH, audience: 'tenant', tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from('{}'), target: INVOICE } as const;
  const unbound = keyring.operationOf(key, PRINCIPAL, binding);
  const sessionA = keyring.operationOf(key, PRINCIPAL, { ...binding, session: 'a'.repeat(43) });
  const sessionB = keyring.operationOf(key, PRINCIPAL, { ...binding, session: 'b'.repeat(43) });
  assert.equal(keyring.operationOf(key, PRINCIPAL, { ...binding, session: null }).fingerprint, unbound.fingerprint, 'null is absent');
  assert.equal(keyring.operationOf(key, PRINCIPAL, { ...binding, session: undefined }).fingerprint, unbound.fingerprint, 'undefined is absent');
  assert.equal(keyring.operationOf(key, PRINCIPAL, { ...binding, session: 'a'.repeat(43) }).fingerprint, sessionA.fingerprint, 'deterministic');
  for (const [label, other] of [['unbound', unbound], ['another session', sessionB]] as const) {
    assert.notEqual(other.fingerprint, sessionA.fingerprint, label);
    assert.equal(other.scope, sessionA.scope, `${label}: one record per key and principal — the 422`);
  }
  for (const [label, session] of [['a uuid', INVOICE], ['too short', 'a'.repeat(42)], ['padded', `${'a'.repeat(42)}=`], ['a number', 7]] as const) {
    assert.throws(() => keyring.operationOf(key, PRINCIPAL, { ...binding, session: session as never }), /idempotency_binding_invalid/, label);
  }
});

test('IRU-02 (PRQ-1): the proof read — the query exactly ?registration=<uuid> (400), the scope (403), the id (400); the port\'s words are 403 and the uniform 404; out of shape or an outage the 503; else exactly { registration, proof }', async () => {
  assert.deepEqual(parseRegistrationProofQuery(`/x?registration=${REGISTRATION}`), { registrationId: REGISTRATION });
  for (const bad of ['/x', '/x?', `/x?registration=${REGISTRATION.toUpperCase()}`, `/x?registration=${REGISTRATION}&a=1`, `/x?id=${REGISTRATION}`, `/x?registration=${REGISTRATION}.`]) {
    assert.equal(parseRegistrationProofQuery(bad), null, bad);
  }
  const ok = { outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF };
  assert.deepEqual(registrationProofOf(ok, INVOICE, REGISTRATION), { attemptId: ATTEMPT, proof: PROOF });
  for (const [label, raw] of [['another registration', { ...ok, registrationId: randomUUID() }], ['another invoice', { ...ok, invoiceId: OTHER_INVOICE }],
    ['an uppercase proof', { ...ok, proof: PROOF.toUpperCase() }], ['a short proof', { ...ok, proof: PROOF.slice(2) }], ['an extra key', { ...ok, key: 'x' }],
    ['a refusal with a value', { outcome: 'not_found', proof: PROOF }], ['an unknown word', { outcome: 'cursor_unknown' }], ['null', null]] as const) {
    assert.equal(registrationProofOf(raw, INVOICE, REGISTRATION), null, label);
  }
  const path = `/api/v1/stores/${STORE}/invoices/${INVOICE}/payment-registration-proof`;
  const url = `${path}?registration=${REGISTRATION}`;
  const calls: unknown[][] = [];
  const bounds: unknown[][] = [];
  let answer: unknown = ok;
  const portOf = () => ({ invoicePaymentRegistrations: {
    proof: (...args: unknown[]) => {
      calls.push(args.slice(0, 4));
      bounds.push([args[4] instanceof AbortSignal, args[5]]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    attempts: () => null,
  } });
  const route = createInvoicePaymentRegistrationProofRoute(portOf());
  const served = await runHandler(route, path, { url });
  assert.deepEqual([served.status, served.body], [200, { registration: { id: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT }, proof: PROOF }]);
  assert.deepEqual(calls, [[scopeAt(STORE), SESSION_KEY, INVOICE, REGISTRATION]], 'the trusted scope, the presenting session, the path invoice, the query registration');
  assert.deepEqual(bounds, [[true, 3000]], 'the port is handed the signal and the route\'s own deadline (3 s), which bounds its every attempt');
  bounds.length = 0;
  calls.length = 0;
  assert.equal((await runHandler(createInvoicePaymentRegistrationProofRoute(portOf(), { deadlineMs: 1200 }), path, { url })).status, 200);
  assert.deepEqual(bounds, [[true, 1200]], 'a shorter route deadline is the port\'s');
  calls.length = 0;
  for (const [label, opts, status, reason] of [
    ['no query', { url: path }, 400, 'invoice_payment_registration_proof_query_invalid'],
    ['another store\'s scope', { url, trusted: scopeAt(OTHER_STORE) }, 403, 'authz_context_missing'],
    ['no session key', { url, sessionKey: null }, 403, 'authz_context_missing'],
  ] as const) {
    const r = await runHandler(route, path, opts);
    assert.deepEqual([r.status, r.locals.refusal], [status, reason], label);
  }
  const malformed = await runHandler(route, `/api/v1/stores/${STORE}/invoices/X/payment-registration-proof`, { url: `/api/v1/stores/${STORE}/invoices/X/payment-registration-proof?registration=${REGISTRATION}` });
  assert.deepEqual([malformed.status, malformed.locals.refusal], [400, 'issued_invoice_id_invalid']);
  for (const [label, raw, status, error, reason] of [
    ['denied', { outcome: 'denied' }, 403, 'forbidden', 'invoice_payment_registration_proof_denied'],
    ['not found', { outcome: 'not_found' }, 404, 'not_found', 'invoice_payment_registration_not_found'],
    ['out of shape', { ...ok, proof: 'x' }, 503, 'service_unavailable', 'invoice_payment_registration_proof_answer_invalid'],
    ['an outage (the port\'s second not_durable; 037\'s 55000: no key)', new Error('invoice payment registration proof not yet durable'), 503, 'service_unavailable', 'invoice_payment_registration_proof_unavailable'],
  ] as const) {
    answer = raw;
    const r = await runHandler(route, path, { url });
    assert.deepEqual([r.status, r.body, r.locals.refusal], [status, { error, requestId: 'req-9' }, reason], label);
    assert.ok(!JSON.stringify(r.body).includes('037') && !JSON.stringify(r.body).includes(PROOF), `${label}: no routine text, no proof`);
  }
});

const attemptRow = (over: Record<string, unknown> = {}) => ({
  invoiceId: INVOICE, invoiceNumber: 7, attemptId: ATTEMPT, state: 'open', version: 1, registeredAt: '2026-11-09T10:00:00.000001Z', settledAt: null, payment: null, ...over,
});
const recordedPayment = (over: Record<string, unknown> = {}) => ({ id: PAYMENT, amountCents: 1250, method: 'cash', recordedAt: '2026-11-09T10:00:01.000000Z', reversal: null, ...over });

test('IRU-03 (PRQ-1): the attempts read — no query or exactly ?after=<invoice>.<attempt>; each state with its version, settlement time and payment; strictly ordered, at most 51; denied 403, cursor_unknown 400, else exactly { attempts, nextCursor } — never a registration id', async () => {
  assert.deepEqual([...INVOICE_PAYMENT_ATTEMPT_STATES], ['open', 'recorded', 'withdrawn', 'confirmed']);
  assert.deepEqual(parseInvoicePaymentAttemptsQuery('/x'), { after: null });
  assert.deepEqual(parseInvoicePaymentAttemptsQuery(`/x?after=${INVOICE}.${ATTEMPT}`), { after: { invoiceId: INVOICE, attemptId: ATTEMPT } });
  for (const bad of ['/x?', `/x?after=${INVOICE}`, `/x?after=${INVOICE}.${ATTEMPT.toUpperCase()}`, `/x?after=${INVOICE}_${ATTEMPT}`, `/x?after=${INVOICE}.${ATTEMPT}&x=1`]) {
    assert.equal(parseInvoicePaymentAttemptsQuery(bad), null, bad);
  }
  const good = [attemptRow(), attemptRow({ invoiceId: OTHER_INVOICE, state: 'recorded', version: 2, payment: recordedPayment() }),
    attemptRow({ attemptId: randomUUID(), registeredAt: '2026-11-09T10:00:02.000000Z', state: 'withdrawn', version: 3, settledAt: '2026-11-09T10:00:03.000000Z' }),
    attemptRow({ attemptId: randomUUID(), registeredAt: '2026-11-09T10:00:04.000000Z', state: 'confirmed', version: 3, settledAt: '2026-11-09T10:00:05.000000Z',
      payment: recordedPayment({ reversal: { reversedAt: '2026-11-09T10:00:06.000000Z', reasonCode: 'duplicate' } }) })];
  // OTHER_INVOICE must sort after INVOICE at the same registeredAt; order the fixture by the same rule.
  good.sort((a, b) => (a.registeredAt < b.registeredAt ? -1 : a.registeredAt > b.registeredAt ? 1 : a.invoiceId < b.invoiceId ? -1 : 1));
  const page = invoicePaymentAttemptsOf({ outcome: 'attempts', attempts: good }, null);
  assert.ok(page !== null && typeof page === 'object');
  assert.deepEqual([page.attempts.length, page.hasMore], [4, false]);
  assert.deepEqual(invoicePaymentAttemptsOf({ outcome: 'attempts', attempts: [] }, null), { attempts: [], hasMore: false }, 'the empty page');
  for (const [label, rows] of [
    ['open with version 2', [attemptRow({ version: 2 })]], ['open with a payment', [attemptRow({ payment: recordedPayment() })]],
    ['recorded without a payment', [attemptRow({ state: 'recorded', version: 2 })]], ['withdrawn without a settlement', [attemptRow({ state: 'withdrawn', version: 3 })]],
    ['confirmed without a payment', [attemptRow({ state: 'confirmed', version: 3, settledAt: '2026-11-09T10:00:05.000000Z' })]],
    ['settled before registered', [attemptRow({ state: 'withdrawn', version: 3, settledAt: '2026-11-09T09:00:00.000000Z' })]],
    ['an unknown state', [attemptRow({ state: 'pending' })]], ['a registration id', [{ ...attemptRow(), registrationId: REGISTRATION }]],
    ['a duplicate pair', [attemptRow(), attemptRow()]], ['out of order', [good[1], good[0]]],
    ['a reversal before the recording', [attemptRow({ state: 'recorded', version: 2, payment: recordedPayment({ reversal: { reversedAt: '2026-11-09T09:00:00.000000Z', reasonCode: 'duplicate' } }) })]],
    ['too many', Array.from({ length: INVOICE_PAYMENT_ATTEMPTS_ASK + 1 }, (_, i) => attemptRow({ attemptId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))],
  ] as const) {
    assert.equal(invoicePaymentAttemptsOf({ outcome: 'attempts', attempts: rows }, null), null, label);
  }
  assert.equal(invoicePaymentAttemptsOf({ outcome: 'attempts', attempts: [attemptRow()] }, { invoiceId: INVOICE, attemptId: ATTEMPT }), null, 'the cursor row itself');
  assert.equal(invoicePaymentAttemptsOf({ outcome: 'cursor_unknown' }, null), null, 'cursor_unknown only for a continuation');
  const path = `/api/v1/stores/${STORE}/payment-attempts`;
  let answer: unknown = { outcome: 'attempts', attempts: good };
  const calls: unknown[][] = [];
  const route = createInvoicePaymentAttemptsRoute({ invoicePaymentRegistrations: {
    proof: () => null, attempts: (...args: unknown[]) => { calls.push(args.slice(0, 3)); if (answer instanceof Error) throw answer; return answer; },
  } });
  const served = await runHandler(route, path);
  assert.equal(served.status, 200);
  assert.deepEqual(Object.keys(served.body as object), ['attempts', 'nextCursor']);
  assert.equal((served.body as { nextCursor: unknown }).nextCursor, null);
  assert.ok(!JSON.stringify(served.body).includes(REGISTRATION), 'never a registration id');
  assert.deepEqual(calls, [[scopeAt(STORE), SESSION_KEY, null]]);
  const full = Array.from({ length: INVOICE_PAYMENT_ATTEMPTS_ASK }, (_, i) => attemptRow({ attemptId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
  answer = { outcome: 'attempts', attempts: full };
  const more = await runHandler(route, path, { url: `${path}?after=${OTHER_INVOICE}.${ATTEMPT}` });
  assert.deepEqual([more.status, (more.body as { attempts: unknown[] }).attempts.length, (more.body as { nextCursor: unknown }).nextCursor],
    [200, 50, `${INVOICE}.${full[49].attemptId}`], 'fifty, and the fiftieth as the cursor');
  for (const [label, raw, url, status, reason] of [
    ['denied', { outcome: 'denied' }, path, 403, 'invoice_payment_attempts_denied'],
    ['cursor unknown', { outcome: 'cursor_unknown' }, `${path}?after=${INVOICE}.${ATTEMPT}`, 400, 'invoice_payment_attempts_cursor_unknown'],
    ['out of shape', { outcome: 'attempts', attempts: [attemptRow({ version: 9 })] }, path, 503, 'invoice_payment_attempts_answer_invalid'],
    ['an outage', new Error('x'), path, 503, 'invoice_payment_attempts_unavailable'],
    ['a bad query', { outcome: 'denied' }, `${path}?after=x`, 400, 'invoice_payment_attempts_query_invalid'],
  ] as const) {
    answer = raw;
    const r = await runHandler(route, path, { url });
    assert.deepEqual([r.status, r.locals.refusal], [status, reason], label);
  }
});

test('IRU-04 (PRQ-1, D-R3-A): over the chain — the registration\'s sealed 201 and 409s replayed (own unsettled slot = write_conflict), its 404 and precondition 409 unsealed; the settlement\'s 200, its unchanged 200 and write_conflict replayed; a REPLACEMENT session replaying a registration or record key is the 422, the same session the stored answer; the settlement binds no session', async () => {
  await withChain(async (h) => {
    const payload = JSON.stringify(registerBody());
    const at = `/api/v1/stores/${STORE}/invoices/${INVOICE}/payment-registrations`;
    for (const [answer, status, exact, error] of [
      ['committed', 201, null, null], ['already_recorded', 409, '{"error":"already_recorded"}', null], ['invalid_state', 409, '{"error":"invalid_state"}', null],
      ['conflict', 409, '{"error":"write_conflict"}', null], ['not_found', 404, null, 'not_found'], ['precondition_failed', 409, null, 'write_conflict'],
      ['unavailable', 503, null, 'service_unavailable'],
    ] as const) {
      h.answer(answer);
      const key = randomUUID();
      const first = await h.send(at, payload, key);
      assert.equal(first.status, status, `${answer}: ${first.body}`);
      if (answer === 'committed') {
        const id = (h.commits.at(-1) as TransactionCommand).mutation.aggregateId;
        assert.equal(first.body, JSON.stringify({ registration: { id, invoiceId: INVOICE, attemptId: ATTEMPT, state: 'open' } }), 'the sealed 201, no proof');
      } else if (exact !== null) assert.equal(first.body, exact, answer);
      else assertUnsealed(first, error as string, answer);
      h.answer('committed');
      const retry = await h.send(at, payload, key);
      if (answer === 'committed' || exact !== null) assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [status, first.body, 'true'], `${answer}: replayed`);
      else assertUnsealed(retry, 'request_in_progress', `${answer}: the lease kept`);
    }
    const reg = h.commits[0];
    assert.deepEqual([reg.mutation.kind, reg.mutation.aggregateType, reg.mutation.expectedVersion, reg.mutation.changes, reg.audit.permission, reg.authNotAfter],
      ['store.invoice_payment.register', 'invoice_payment_registration', null, { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT }, 'record_invoice_payments', null]);

    const settleAt = `/api/v1/stores/${STORE}/invoices/${INVOICE}/payment-settlement`;
    const settlePayload = JSON.stringify(settleBody({ expectedVersion: 2 }));
    const confirmed = JSON.stringify({ settlement: { invoiceId: INVOICE, attemptId: ATTEMPT, state: 'confirmed' } });
    for (const [answer, status, exact] of [['committed', 200, confirmed], ['unchanged', 200, confirmed], ['conflict', 409, '{"error":"write_conflict"}']] as const) {
      h.answer(answer);
      const key = randomUUID();
      const first = await h.send(settleAt, settlePayload, key);
      assert.deepEqual([first.status, first.body], [status, exact], answer);
      h.answer('committed');
      const retry = await h.send(settleAt, settlePayload, key);
      assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [status, exact, 'true'], `${answer}: replayed`);
    }
    for (const [answer, status, error] of [['not_found', 404, 'not_found'], ['precondition_failed', 409, 'write_conflict'], ['already_recorded', 503, 'service_unavailable']] as const) {
      h.answer(answer);
      const r = await h.send(settleAt, settlePayload, randomUUID());
      assert.equal(r.status, status, answer);
      assertUnsealed(r, error, answer);
    }
    const settle = h.commits.find((c) => c.mutation.kind === 'store.invoice_payment.settle') as TransactionCommand;
    assert.deepEqual([settle.mutation.aggregateId, settle.mutation.expectedVersion, settle.mutation.changes],
      [ATTEMPT, 2, { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT }]);

    // D-R3-A: one key per command, first in this session, then replayed in this session and in a replacement session.
    h.answer('committed');
    const replacement = await h.relogin();
    for (const [label, path, bytes, bound] of [['the registration', at, payload, true], ['the record', recordAt(), JSON.stringify(recordBody()), true],
      ['the settlement', settleAt, settlePayload, false]] as const) {
      const key = randomUUID();
      const first = await h.send(path, bytes, key);
      assert.ok(first.status === 200 || first.status === 201, `${label}: ${first.body}`);
      const commits = h.commits.length;
      const same = await h.send(path, bytes, key);
      assert.deepEqual([same.status, same.body, same.headers['idempotent-replayed']], [first.status, first.body, 'true'], `${label}: the same session replays the original answer`);
      const other = await replacement(path, bytes, key);
      if (bound) {
        assert.equal(other.status, 422, `${label}: the replacement session`);
        assertUnsealed(other, 'idempotency_key_reused', `${label}: no cached body`);
      } else {
        assert.deepEqual([other.status, other.body], [first.status, first.body], `${label}: not session-bound — the stored answer`);
      }
      assert.equal(h.commits.length, commits, `${label}: nothing planned or committed again`);
    }
  });
});

test('IRU-05 (PRQ-1, record v2): the record names its registration and proof exactly — a canonical uuid and 64 lowercase hex digits; the v1 body, a missing, malformed or extra member is COMMAND_REQUEST_INVALID; the record route is session-bound (D-R3-A)', () => {
  const planRecord = (body: unknown) => planInvoicePaymentRecord(Object.freeze({ audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE }) as never);
  const plan = planRecord(recordBody()) as CommandPlan;
  assert.deepEqual(plan.changes, { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, amountCents: 1250, method: 'cash', registrationId: REGISTRATION, registrationProof: PROOF });
  assert.deepEqual(plan.response, { status: 201, body: { payment: { id: NEW_ID, invoiceId: INVOICE, attemptId: ATTEMPT, amountCents: 1250, method: 'cash' } } }, 'never the proof or the registration in the answer');
  for (const [label, body] of [
    ['the v1 body', { expectedTenant: TENANT, attemptId: ATTEMPT, amountCents: 1250, method: 'cash' }],
    ['no registration', Object.fromEntries(Object.entries(recordBody()).filter(([k]) => k !== 'registrationId'))],
    ['no proof', Object.fromEntries(Object.entries(recordBody()).filter(([k]) => k !== 'registrationProof'))],
    ['an uppercase registration', recordBody({ registrationId: REGISTRATION.toUpperCase() })], ['a registration that is no uuid', recordBody({ registrationId: 'r' })],
    ['an uppercase proof', recordBody({ registrationProof: PROOF.toUpperCase() })], ['a short proof', recordBody({ registrationProof: PROOF.slice(1) })],
    ['a long proof', recordBody({ registrationProof: `${PROOF}0` })], ['a non-hex proof', recordBody({ registrationProof: 'g'.repeat(64) })],
    ['a null proof', recordBody({ registrationProof: null })], ['a proof as a number', recordBody({ registrationProof: 1 })],
    ['a proof field by another name', { ...recordBody(), proof: PROOF }],
  ] as const) {
    assert.equal(planRecord(body), COMMAND_REQUEST_INVALID, label);
  }
  assert.equal(INVOICE_PAYMENT_RECORD_ROUTE.sessionBinding, 'required');
  assert.equal(INVOICE_PAYMENT_REVERSE_ROUTE.sessionBinding, undefined, 'the reversal is not session-bound');
});
