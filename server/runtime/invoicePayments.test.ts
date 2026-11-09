// Phase 4.0 M7B-PAYMENTS-P1 — the payment record and reversal routes, their eligibilities and the payments read, below the
// database (docs/phase-4/15 §12.3, §12.5): the closed codes and labels, the two contracts and route declarations, the strict
// planners and their sealed bytes, the reversal's two fingerprint targets, the eligibilities' action-only form, the read's
// strict decoder and exact 200, and each store answer over the enforced chain. The routines are proved against a real
// cluster by the stage's database suites (IPR, IPH).
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
} from './invoicePayments.js';
import type { InvoicePaymentsPort } from './invoicePayments.js';
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
const recordBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, registrationId: REGISTRATION, attemptId: ATTEMPT, amountCents: 1250, method: 'cash', registrationProof: PROOF, ...over });
const reverseBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, reasonCode: 'duplicate', ...over });
const planRecord = (body: unknown, over: Record<string, unknown> = {}) => planInvoicePaymentRecord(Object.freeze({
  audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE, ...over,
}) as never);
const planReverse = (body: unknown, over: Record<string, unknown> = {}) => planInvoicePaymentReverse(Object.freeze({
  audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE, paymentId: PAYMENT, ...over,
}) as never);
const sealWith = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString('base64url');

// --- 1. the closed codes, the contracts and the routes ------------------------------------------------------------------

test('IPU-01 (§12.2, §12.3): the two methods and six reasons in their one order with their labels; the record is a store-scope CREATE of an invoice_payment opting into the record refusals, the reversal an UPDATE; five store templates with their permissions, bodies, keys and recent sign-in; every route and contract registers', () => {
  assert.deepEqual([...INVOICE_PAYMENT_METHODS], ['cash', 'external_card_terminal']);
  assert.deepEqual(INVOICE_PAYMENT_METHOD_LABELS, { cash: 'Cash', external_card_terminal: 'Card on a separate terminal' });
  assert.deepEqual([...INVOICE_PAYMENT_REVERSAL_REASON_CODES], ['recorded_in_error', 'wrong_amount', 'wrong_method', 'wrong_invoice', 'duplicate', 'other']);
  assert.deepEqual(Object.values(INVOICE_PAYMENT_REVERSAL_REASON_LABELS), ['Recorded by mistake', 'Wrong amount', 'Wrong method', 'Wrong invoice', 'Payment recorded twice', 'Other reason']);
  assert.deepEqual([...INVOICE_PAYMENT_STATUSES], ['voided', 'nothing_due', 'no_payment_recorded', 'recorded_in_full', 'recorded_partly']);
  for (const frozen of [INVOICE_PAYMENT_METHODS, INVOICE_PAYMENT_METHOD_LABELS, INVOICE_PAYMENT_REVERSAL_REASON_CODES, INVOICE_PAYMENT_REVERSAL_REASON_LABELS,
    INVOICE_PAYMENT_RECORD_CONTRACT, INVOICE_PAYMENT_REVERSE_CONTRACT, INVOICE_PAYMENT_RECORD_ROUTE, INVOICE_PAYMENT_REVERSE_ROUTE]) assert.ok(Object.isFrozen(frozen));
  assert.deepEqual([INVOICE_PAYMENT_RECORD_CONTRACT.kind, INVOICE_PAYMENT_RECORD_CONTRACT.mode, INVOICE_PAYMENT_RECORD_CONTRACT.aggregateType,
    INVOICE_PAYMENT_RECORD_CONTRACT.contextScope, INVOICE_PAYMENT_RECORD_CONTRACT.events, INVOICE_PAYMENT_RECORD_CONTRACT.paymentRefusals],
  ['store.invoice_payment.record', 'create', 'invoice_payment', 'store', [], 'record']);
  assert.deepEqual(Object.keys(INVOICE_PAYMENT_RECORD_CONTRACT.changes), ['invoiceId', 'expectedTenant', 'attemptId', 'amountCents', 'method', 'registrationId', 'registrationProof'], 'record v2 (M7B-PAYMENTS-P2): its registration and proof, last');
  assert.deepEqual(INVOICE_PAYMENT_RECORD_CONTRACT.changes.amountCents, { type: 'integer', min: 1, max: MAX });
  assert.deepEqual([INVOICE_PAYMENT_REVERSE_CONTRACT.kind, INVOICE_PAYMENT_REVERSE_CONTRACT.mode, INVOICE_PAYMENT_REVERSE_CONTRACT.aggregateType,
    INVOICE_PAYMENT_REVERSE_CONTRACT.contextScope, INVOICE_PAYMENT_REVERSE_CONTRACT.events, INVOICE_PAYMENT_REVERSE_CONTRACT.paymentRefusals],
  ['store.invoice_payment.reverse', 'update', 'invoice_payment', 'store', [], undefined]);
  assert.deepEqual(Object.keys(INVOICE_PAYMENT_REVERSE_CONTRACT.changes), ['invoiceId', 'expectedTenant', 'reasonCode']);
  assert.equal(INVOICE_PAYMENT_RECORD_PATH, '/api/v1/stores/{storeId}/invoices/{id}/payments');
  assert.equal(INVOICE_PAYMENTS_PATH, INVOICE_PAYMENT_RECORD_PATH);
  assert.equal(INVOICE_PAYMENT_REVERSE_PATH, '/api/v1/stores/{storeId}/invoices/{id}/payments/{paymentId}/reversal');
  assert.equal(INVOICE_PAYMENT_ELIGIBILITY_PATH, '/api/v1/stores/{storeId}/invoices/{id}/payment-eligibility');
  assert.equal(INVOICE_PAYMENT_REVERSAL_ELIGIBILITY_PATH, '/api/v1/stores/{storeId}/invoices/{id}/payment-reversal-eligibility');
  assert.deepEqual(INVOICE_PAYMENT_RECORD_REQUIREMENT, { scope: 'store', permission: 'record_invoice_payments' });
  assert.deepEqual(INVOICE_PAYMENT_REVERSE_REQUIREMENT, { scope: 'store', permission: 'reverse_invoice_payments' });
  assert.deepEqual(INVOICE_PAYMENTS_VIEW_REQUIREMENT, { scope: 'store', permission: 'view_issued_invoices' });
  assert.deepEqual([INVOICE_PAYMENTS_PAGE_SIZE, INVOICE_PAYMENTS_ASK, INVOICE_PAYMENT_MAX_BODY_BYTES], [50, 51, 1024]);
  for (const [route, requirement, recentAuth] of [[INVOICE_PAYMENT_RECORD_ROUTE, INVOICE_PAYMENT_RECORD_REQUIREMENT, 'none'],
    [INVOICE_PAYMENT_REVERSE_ROUTE, INVOICE_PAYMENT_REVERSE_REQUIREMENT, 'required']] as const) {
    assert.deepEqual([route.method, route.policy, route.body, route.idempotency, route.trustedContext, route.recentAuth],
      ['POST', { access: 'session', audience: 'tenant', authorization: requirement }, { kind: 'json', maxBytes: 1024, required: true }, 'required', 'required', recentAuth]);
  }
  const reads = [createInvoicePaymentEligibilityRoute(), createInvoicePaymentReversalEligibilityRoute(), createInvoicePaymentsRoute({ invoicePayments: { payments: () => null } })];
  assert.deepEqual(reads.map((r) => [r.method, r.path, r.policy, r.idempotency, r.recentAuth, r.sessionBinding, r.trustedContext]), [
    ['GET', INVOICE_PAYMENT_ELIGIBILITY_PATH, { access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT }, 'none', 'none', 'required', 'required'],
    ['GET', INVOICE_PAYMENT_REVERSAL_ELIGIBILITY_PATH, { access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_REVERSE_REQUIREMENT }, 'none', 'none', 'required', 'required'],
    ['GET', INVOICE_PAYMENTS_PATH, { access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENTS_VIEW_REQUIREMENT }, 'none', 'none', 'required', 'required'],
  ]);
  assert.doesNotThrow(() => defineRoutes([INVOICE_PAYMENT_RECORD_ROUTE, INVOICE_PAYMENT_REVERSE_ROUTE, ...reads]));
  assert.doesNotThrow(() => defineCommands([INVOICE_PAYMENT_RECORD_CONTRACT, INVOICE_PAYMENT_REVERSE_CONTRACT], defineOutboxEvents([])));
  assert.throws(() => createInvoicePaymentsRoute({} as never), /route_handler_invalid/);
  assert.throws(() => createInvoicePaymentsRoute({ invoicePayments: { payments: () => null } }, { deadlineMs: 0 }), /port_deadline_invalid/);
});

// --- 2. the planners ---------------------------------------------------------------------------------------------------------

test('IPU-02 (§12.3; record v2, M7B-PAYMENTS-P2): the record plans exactly { expectedTenant, registrationId, attemptId, amountCents, method, registrationProof } into the runtime\'s new payment of the path\'s invoice — no event, no annex, the sealed 201 built from the plan alone; prepared, it carries the record\'s five slots', () => {
  for (const method of INVOICE_PAYMENT_METHODS) {
    for (const amountCents of [1, 1250, MAX]) {
      const plan = planRecord(recordBody({ method, amountCents })) as CommandPlan;
      assert.notEqual(plan, COMMAND_REQUEST_INVALID);
      assert.deepEqual(plan, {
        aggregateId: NEW_ID, expectedVersion: null, changes: { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, amountCents, method, registrationId: REGISTRATION, registrationProof: PROOF }, events: [],
        response: { status: 201, body: { payment: { id: NEW_ID, invoiceId: INVOICE, attemptId: ATTEMPT, amountCents, method } } },
      }, `${method} ${amountCents}`);
      assert.deepEqual(Object.keys((plan.response.body as { payment: object }).payment), ['id', 'invoiceId', 'attemptId', 'amountCents', 'method'], 'its member order');
    }
  }
  const plan = planRecord(recordBody());
  const prepared = prepareCommand(INVOICE_PAYMENT_RECORD_CONTRACT, defineOutboxEvents([]), plan, {
    scope: 's'.repeat(43), lease: 'l'.repeat(43), newAggregateId: NEW_ID, authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT, context: scopeAt(STORE),
    authNotAfter: null, sessionKey: SESSION_KEY, seal: sealWith,
  });
  assert.ok(prepared !== null, 'in contract');
  assert.deepEqual(Object.keys(prepared.rejected).sort(), ['alreadyRecorded', 'amountExceedsRemaining', 'conflict', 'customerNotFound', 'invalidState']);
  assert.deepEqual([prepared.command.audit.reasonCode, prepared.command.audit.reason, prepared.command.events.length, prepared.response.headers], [null, null, 0, {}],
    'no annex (the routine writes its own record), no event, no Location');
  assert.equal(prepared.response.body, JSON.stringify({ payment: { id: NEW_ID, invoiceId: INVOICE, attemptId: ATTEMPT, amountCents: 1250, method: 'cash' } }));
});

test('IPU-03 (§12.3): every other record body or target is COMMAND_REQUEST_INVALID — a missing or extra key (a version, an actor, a time, a reference, a card field), a non-canonical uuid, an amount out of 1..2^53 - 1 or not a JSON integer, an unknown method, a malformed invoice, no store, a payment id segment', () => {
  const bodies: Array<[string, unknown]> = [
    ['no body', undefined], ['null', null], ['an array', [recordBody()]], ['a string', JSON.stringify(recordBody())],
    ['a class instance', Object.assign(new (class Body {})(), recordBody())],
    ...['expectedTenant', 'registrationId', 'attemptId', 'amountCents', 'method', 'registrationProof'].map((k): [string, unknown] => [`no ${k}`, Object.fromEntries(Object.entries(recordBody()).filter(([key]) => key !== k))]),
    ...['expectedVersion', 'actor', 'recordedAt', 'reference', 'cardNumber', 'cvv', 'tendered', 'change', 'invoiceId', 'paymentId'].map((k): [string, unknown] => [`an extra ${k}`, recordBody({ [k]: 1 })]),
    ['an uppercase tenant', recordBody({ expectedTenant: TENANT.toUpperCase() })], ['a tenant that is no uuid', recordBody({ expectedTenant: 'tenant' })],
    ['an uppercase attempt', recordBody({ attemptId: ATTEMPT.toUpperCase() })], ['a null attempt', recordBody({ attemptId: null })],
    ['amount 0', recordBody({ amountCents: 0 })], ['a negative amount', recordBody({ amountCents: -1 })], ['a fractional amount', recordBody({ amountCents: 1.5 })],
    ['an unsafe amount', recordBody({ amountCents: MAX + 1 })], ['an amount as text', recordBody({ amountCents: '1250' })], ['an amount as bigint text', recordBody({ amountCents: '9007199254740991' })],
    ['NaN', recordBody({ amountCents: Number.NaN })], ['Infinity', recordBody({ amountCents: Infinity })],
    ['an unknown method', recordBody({ method: 'card' })], ['a label for a method', recordBody({ method: 'Cash' })], ['an uppercase method', recordBody({ method: 'CASH' })],
  ];
  for (const [label, body] of bodies) assert.equal(planRecord(body), COMMAND_REQUEST_INVALID, label);
  for (const [label, over] of [
    ['no invoice', { targetId: undefined }], ['an uppercase invoice', { targetId: INVOICE.toUpperCase() }], ['an unversioned invoice', { targetId: UNVERSIONED }],
    ['a nil invoice', { targetId: '00000000-0000-0000-0000-000000000000' }], ['no store', { storeId: undefined }], ['a store that is no uuid', { storeId: 'x' }],
    ['a payment id segment (never the record\'s)', { paymentId: PAYMENT }], ['a new id that is no uuid', { newAggregateId: 'x' }],
  ] as const) {
    assert.equal(planRecord(recordBody(), over), COMMAND_REQUEST_INVALID, label);
  }
});

test('IPU-04 (§12.3): the reversal plans exactly { expectedTenant, reasonCode } into the path\'s payment at version 1 — the invoice in its change set, no event, no annex, the sealed 200; every other body or target is COMMAND_REQUEST_INVALID', () => {
  for (const reasonCode of INVOICE_PAYMENT_REVERSAL_REASON_CODES) {
    assert.deepEqual(planReverse(reverseBody({ reasonCode })), {
      aggregateId: PAYMENT, expectedVersion: 1, changes: { invoiceId: INVOICE, expectedTenant: TENANT, reasonCode }, events: [],
      response: { status: 200, body: { payment: { id: PAYMENT, invoiceId: INVOICE, status: 'reversed' } } },
    }, reasonCode);
  }
  for (const [label, body] of [
    ['no body', undefined], ['an array', [reverseBody()]], ['no reason', { expectedTenant: TENANT }], ['no tenant', { reasonCode: 'duplicate' }],
    ['an expected version', reverseBody({ expectedVersion: 1 })], ['free text', reverseBody({ note: 'x' })], ['an unknown reason', reverseBody({ reasonCode: 'refund' })],
    ['a label for a reason', reverseBody({ reasonCode: 'Payment recorded twice' })], ['the void\'s reason', reverseBody({ reasonCode: 'issued_in_error' })],
    ['an uppercase tenant', reverseBody({ expectedTenant: TENANT.toUpperCase() })],
  ] as const) {
    assert.equal(planReverse(body), COMMAND_REQUEST_INVALID, label);
  }
  for (const [label, over] of [
    ['no payment', { paymentId: undefined }], ['an uppercase payment', { paymentId: PAYMENT.toUpperCase() }], ['an unversioned payment', { paymentId: UNVERSIONED }],
    ['no invoice', { targetId: undefined }], ['an unversioned invoice', { targetId: UNVERSIONED }], ['no store', { storeId: undefined }],
  ] as const) {
    assert.equal(planReverse(reverseBody(), over), COMMAND_REQUEST_INVALID, label);
  }
});

test('IPU-05 (§12.3): the reversal\'s fingerprint appends the invoice and then the payment — another payment, another invoice or the two swapped is another fingerprint; a null second target is absent; a second target without a first, or malformed, is refused; the reversal binds no session (the record adds its session slot, D-R3-A: invoicePaymentRegistrations.test.ts IRU-01)', () => {
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const key = randomUUID();
  const binding = { method: 'POST', path: INVOICE_PAYMENT_REVERSE_PATH, audience: 'tenant', tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from('{}') } as const;
  const both = keyring.operationOf(key, PRINCIPAL, { ...binding, target: INVOICE, secondTarget: PAYMENT });
  const invoiceOnly = keyring.operationOf(key, PRINCIPAL, { ...binding, target: INVOICE });
  assert.equal(keyring.operationOf(key, PRINCIPAL, { ...binding, target: INVOICE, secondTarget: null }).fingerprint, invoiceOnly.fingerprint, 'null is absent');
  assert.equal(keyring.operationOf(key, PRINCIPAL, { ...binding, target: INVOICE, secondTarget: undefined }).fingerprint, invoiceOnly.fingerprint, 'undefined is absent');
  for (const [label, other] of [['the invoice alone', invoiceOnly], ['another payment', keyring.operationOf(key, PRINCIPAL, { ...binding, target: INVOICE, secondTarget: OTHER_PAYMENT })],
    ['another invoice', keyring.operationOf(key, PRINCIPAL, { ...binding, target: OTHER_INVOICE, secondTarget: PAYMENT })],
    ['swapped', keyring.operationOf(key, PRINCIPAL, { ...binding, target: PAYMENT, secondTarget: INVOICE })]] as const) {
    assert.notEqual(other.fingerprint, both.fingerprint, label);
    assert.equal(other.scope, both.scope, `${label}: one record per key and principal — the 422, never a second record`);
  }
  for (const [label, target, second] of [['no first target', undefined, PAYMENT], ['a null first target', null, PAYMENT], ['an uppercase second', INVOICE, PAYMENT.toUpperCase()],
    ['a second that is no uuid', INVOICE, 'x'], ['a numeric second', INVOICE, 7]] as const) {
    assert.throws(() => keyring.operationOf(key, PRINCIPAL, { ...binding, target: target as never, secondTarget: second as never }), /idempotency_binding_invalid/, label);
  }
});

// --- 3. the eligibilities and the read's handler -----------------------------------------------------------------------------

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

test('IPU-06 (§12.3): each eligibility is target-blind and action-only — a query (400), a scope not at the path\'s store (403), then a malformed id (400), otherwise exactly { eligibility: "allowed" }', async () => {
  for (const [route, suffix, name] of [[createInvoicePaymentEligibilityRoute(), 'payment-eligibility', 'invoice_payment_eligibility'],
    [createInvoicePaymentReversalEligibilityRoute(), 'payment-reversal-eligibility', 'invoice_payment_reversal_eligibility']] as const) {
    const at = (id: string, store: string = STORE) => `/api/v1/stores/${store}/invoices/${id}/${suffix}`;
    for (const url of [`${at(INVOICE)}?`, `${at(INVOICE)}?x=1`]) {
      const out = await runHandler(route, at(INVOICE), { url });
      assert.deepEqual([out.status, out.body, out.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, `${name}_query_invalid`], url);
    }
    for (const [label, path, opts] of [['no trusted scope', at(INVOICE), { trusted: null }], ['another store', at(INVOICE), { trusted: scopeAt(OTHER_STORE) }],
      ['no session key', at(INVOICE), { sessionKey: null }], ['a tenant scope', at(INVOICE), { trusted: scopeAt(STORE, { scope: 'tenant', store: null }) }]] as const) {
      const out = await runHandler(route, path, opts);
      assert.deepEqual([out.status, out.locals.refusal], [403, 'authz_context_missing'], `${suffix}: ${label}`);
    }
    for (const id of [INVOICE.toUpperCase(), 'x', '{id}']) {
      const out = await runHandler(route, at(id));
      assert.deepEqual([out.status, out.locals.refusal], [400, 'issued_invoice_id_invalid'], `${suffix}: ${id}`);
    }
    for (const id of [INVOICE, OTHER_INVOICE, UNVERSIONED]) {
      const out = await runHandler(route, at(id));
      assert.deepEqual([out.status, out.body], [200, { eligibility: 'allowed' }], `${suffix}: ${id}`);
    }
  }
});

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

test('IPU-07 (§12.3): the read\'s query is none or exactly ?after=<canonical uuid>; its strict decoder re-derives due, remaining and the word, checks applied against due and the page, the order, uniqueness and bound — and refuses any mismatch, negative or unsafe value (null: the 503)', () => {
  assert.deepEqual(parseInvoicePaymentsQuery('/p'), { after: null });
  assert.deepEqual(parseInvoicePaymentsQuery(`/p?after=${PAYMENT}`), { after: PAYMENT });
  for (const bad of ['/p?', '/p?after=', `/p?after=${PAYMENT.toUpperCase()}`, `/p?after=${PAYMENT}&x=1`, `/p?x=1&after=${PAYMENT}`, `/p?limit=5`, `/p?after=${PAYMENT}#`,
    `/p?after=${PAYMENT}&after=${PAYMENT}`, `/p?cursor=${PAYMENT}`, `/p?after=%20${PAYMENT}`]) {
    assert.equal(parseInvoicePaymentsQuery(bad), null, bad);
  }
  // The refusals: exactly one key; cursor_unknown only for a continuation.
  assert.equal(invoicePaymentsOf({ outcome: 'denied' }, INVOICE, null), 'denied');
  assert.equal(invoicePaymentsOf({ outcome: 'not_found' }, INVOICE, PAYMENT), 'not_found');
  assert.equal(invoicePaymentsOf({ outcome: 'cursor_unknown' }, INVOICE, PAYMENT), 'cursor_unknown');
  assert.equal(invoicePaymentsOf({ outcome: 'cursor_unknown' }, INVOICE, null), null);
  assert.equal(invoicePaymentsOf({ outcome: 'denied', more: 1 }, INVOICE, null), null);
  // Good answers: every word.
  const one = portPayment(1, { amountCents: 400 });
  const page = invoicePaymentsOf(consistent([one]), INVOICE, null);
  assert.ok(page !== null && typeof page === 'object');
  assert.deepEqual([page.dueCents, page.appliedCents, page.remainingCents, page.paymentStatus, page.hasMore], [1000, 400, 600, 'recorded_partly', false]);
  assert.equal((invoicePaymentsOf(consistent([portPayment(1, { amountCents: 1000 })]), INVOICE, null) as { paymentStatus: string }).paymentStatus, 'recorded_in_full');
  assert.equal((invoicePaymentsOf(consistent([]), INVOICE, null) as { paymentStatus: string }).paymentStatus, 'no_payment_recorded');
  assert.equal((invoicePaymentsOf(consistent([], { totalCents: 0, dueCents: 0 }), INVOICE, null) as { paymentStatus: string }).paymentStatus, 'nothing_due');
  const reversed = portPayment(1, { reversal: { reversedAt: TIME(2), reasonCode: 'duplicate' } });
  const voided = { ...consistent([reversed]), invoice: { id: INVOICE, status: 'voided' }, dueCents: 0, appliedCents: 0, remainingCents: 0, paymentStatus: 'voided' };
  assert.equal((invoicePaymentsOf(voided, INVOICE, null) as { paymentStatus: string }).paymentStatus, 'voided');
  // A continuation's page holds only part of the history: its unreversed sum may be below applied, never above it.
  assert.ok(invoicePaymentsOf(consistent([one], { appliedCents: 900, remainingCents: 100 }), INVOICE, PAYMENT) !== null, 'a later page');
  const good = consistent([one]);
  const bad: Array<[string, unknown, string | null]> = [
    ['another invoice', { ...good, invoice: { id: OTHER_INVOICE, status: 'issued' } }, null], ['another status', { ...good, invoice: { id: INVOICE, status: 'draft' } }, null],
    ['an extra invoice member', { ...good, invoice: { id: INVOICE, status: 'issued', number: 1 } }, null], ['another currency', { ...good, currency: 'EUR' }, null],
    ['due is not the Total', { ...good, dueCents: 999, remainingCents: 599 }, null], ['remaining mismatch', { ...good, remainingCents: 601 }, null],
    ['applied above due', consistent([portPayment(1, { amountCents: 1001 })]), null], ['another word', { ...good, paymentStatus: 'recorded_in_full' }, null],
    ['an unknown word', { ...good, paymentStatus: 'unpaid' }, null], ['a negative amount', { ...good, totalCents: -1 }, null],
    ['an unsafe amount', { ...good, totalCents: MAX + 1 }, null], ['an amount as text', { ...good, appliedCents: '400' }, null],
    ['a voided invoice with applied', { ...voided, appliedCents: 1, remainingCents: 0 }, null],
    ['a voided invoice with an unreversed payment', { ...voided, payments: [one] }, null],
    ['the page sum is not applied (whole history)', { ...good, appliedCents: 300, remainingCents: 700 }, null],
    ['the page sum above applied (continuation)', { ...good, appliedCents: 300, remainingCents: 700 }, PAYMENT],
    ['out of order', consistent([portPayment(2), portPayment(1)]), null], ['a duplicate id', consistent([one, { ...one, attemptId: randomUUID() }]), null],
    ['the cursor on its own page', consistent([portPayment(1, { id: PAYMENT })]), PAYMENT],
    ['a reversal before its recording', consistent([portPayment(5, { reversal: { reversedAt: TIME(4), reasonCode: 'duplicate' } })]), null],
    ['an unknown reversal reason', consistent([portPayment(1, { reversal: { reversedAt: TIME(2), reasonCode: 'refund' } })]), null],
    ['a payment with a staff id', consistent([{ ...one, recordedBy: ACTOR }]), null], ['an unknown method', consistent([portPayment(1, { method: 'card' })]), null],
    ['a zero amount', consistent([portPayment(1, { amountCents: 0 })]), null], ['a millisecond time', consistent([portPayment(1, { recordedAt: '2026-11-07T10:00:01.000Z' })]), null],
    ['52 payments', consistent(Array.from({ length: 52 }, (_, i) => portPayment(i + 1, { amountCents: 1, recordedAt: TIME(0) })), { totalCents: 100, dueCents: 100 }), null],
    ['a missing member', Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'paymentStatus')), null], ['an extra member', { ...good, nextCursor: null }, null],
    ['payments not an array', { ...good, payments: {} }, null], ['no object', 'payments', null],
  ];
  for (const [label, raw, after] of bad) assert.equal(invoicePaymentsOf(raw, INVOICE, after), null, label);
});

test('IPU-08 (§12.3): the read refuses a query (400), a scope (403), a malformed id (400) in that order; the port\'s words are 403/404/400 and anything out of shape or an outage 503; the 200 is exactly { invoice, amounts, paymentStatus, payments, nextCursor } in order — 50 payments and the 50th id as the cursor when 51 came back — with no staff id', async () => {
  const seen: unknown[][] = [];
  let next: unknown = null;
  const port: InvoicePaymentsPort = { payments: (...args) => { seen.push(args.slice(0, 4)); if (next instanceof Error) throw next; return next; } };
  const route = createInvoicePaymentsRoute({ invoicePayments: port });
  const at = (id: string = INVOICE) => `/api/v1/stores/${STORE}/invoices/${id}/payments`;
  const run = (opts: Parameters<typeof runHandler>[2] = {}, path = at()) => runHandler(route, path, opts);
  assert.deepEqual([(await run({ url: `${at()}?limit=1` })).status, (await run({ url: `${at()}?limit=1` })).locals.refusal], [400, 'invoice_payments_query_invalid']);
  assert.deepEqual((await run({ trusted: null, url: `${at()}?x` })).status, 400, 'the query first');
  assert.deepEqual([(await run({ trusted: null })).status, (await run({ trusted: null })).locals.refusal], [403, 'authz_context_missing']);
  assert.deepEqual([(await run({}, at('x'))).status, (await run({}, at('x'))).locals.refusal], [400, 'issued_invoice_id_invalid']);
  assert.equal(seen.length, 0, 'nothing asked yet');
  for (const [answer, status, reason] of [[{ outcome: 'denied' }, 403, 'invoice_payments_denied'], [{ outcome: 'not_found' }, 404, 'invoice_payments_not_found'],
    [{ outcome: 'payments' }, 503, 'invoice_payments_answer_invalid'], [new Error('down'), 503, 'invoice_payments_failed']] as const) {
    next = answer;
    const out = await run();
    assert.equal(out.status, status, reason);
    if (reason !== 'invoice_payments_failed') assert.equal(out.locals.refusal, reason);
  }
  next = { outcome: 'cursor_unknown' };
  const unknown = await run({ url: `${at()}?after=${PAYMENT}` });
  assert.deepEqual([unknown.status, unknown.body, unknown.locals.refusal], [400, { error: 'invalid_request', requestId: 'req-9' }, 'invoice_payments_cursor_unknown']);
  assert.deepEqual(seen.at(-1), [scopeAt(STORE), SESSION_KEY, INVOICE, PAYMENT], 'the trusted scope, the key, the path invoice and the cursor');
  // A full page: 51 came back, 50 served, the 50th id the cursor.
  const many = Array.from({ length: 51 }, (_, i) => portPayment(i + 1, { amountCents: 1, recordedAt: TIME(0) }));
  next = consistent(many, { totalCents: 100, dueCents: 100, appliedCents: 60, remainingCents: 40, paymentStatus: 'recorded_partly' });
  const full = await run();
  const body = full.body as { payments: Array<{ id: string }>; nextCursor: string };
  assert.equal(full.status, 200);
  assert.deepEqual(Object.keys(full.body as object), ['invoice', 'amounts', 'paymentStatus', 'payments', 'nextCursor'], 'the five members in order');
  assert.deepEqual([body.payments.length, body.nextCursor], [50, many[49].id]);
  // A last page: exactly the bytes.
  const reversal = { reversedAt: TIME(3), reasonCode: 'wrong_amount' };
  const last = [portPayment(1, { amountCents: 400, method: 'external_card_terminal' }), portPayment(2, { amountCents: 50, reversal })];
  next = consistent(last);
  const one = await run();
  assert.deepEqual(one.body, {
    invoice: { id: INVOICE, status: 'issued' },
    amounts: { currency: 'USD', dueCents: 1000, appliedCents: 400, remainingCents: 600 },
    paymentStatus: 'recorded_partly',
    payments: [
      { id: last[0].id, attemptId: last[0].attemptId, amountCents: 400, method: 'external_card_terminal', recordedAt: TIME(1), reversal: null },
      { id: last[1].id, attemptId: last[1].attemptId, amountCents: 50, method: 'cash', recordedAt: TIME(2), reversal },
    ],
    nextCursor: null,
  });
  assert.deepEqual(Object.keys((one.body as { amounts: object }).amounts), ['currency', 'dueCents', 'appliedCents', 'remainingCents']);
  assert.deepEqual(Object.keys((one.body as { payments: object[] }).payments[0]), ['id', 'attemptId', 'amountCents', 'method', 'recordedAt', 'reversal']);
  assert.ok(!JSON.stringify(one.body).includes(ACTOR), 'no staff id');
});

// --- 4. the commands over the enforced chain ------------------------------------------------------------------------------------

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

type Answer = 'committed' | 'conflict' | 'invalid_state' | 'already_recorded' | 'amount_exceeds_remaining' | 'not_found' | 'precondition_failed' | 'unavailable';
interface Chain {
  commits: TransactionCommand[];
  plans: unknown[];
  requirements: unknown[];
  records: Map<string, { readonly fingerprint: string; readonly response: string | null }>;
  logs: Record<string, unknown>[];
  authenticatedAt: number;
  answer: (a: Answer) => void;
  send: (path: string, payload: string, key: string) => Promise<Reply>;
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
    routes: [capture(INVOICE_PAYMENT_RECORD_ROUTE), capture(INVOICE_PAYMENT_REVERSE_ROUTE), createInvoicePaymentEligibilityRoute(), createInvoicePaymentReversalEligibilityRoute()],
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
    const send = (path: string, payload: string, key: string) => request(p, 'POST', path, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': key,
    }, payload);
    await fn({ commits, plans, requirements, records: state.records, logs, authenticatedAt, answer: (a) => { next = a; }, send });
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

test('IPU-09 (§12.3, §12.7): the record over the chain — the sealed 201 and its 409s (already_recorded, invalid_state, amount_exceeds_remaining, write_conflict) replayed byte for byte; the 404, the precondition 409 and the 503 the chain\'s { error, requestId }, the lease kept; the command carries the payment, the invoice, no annex and no deadline; a bad body is the 400 after the key', async () => {
  await withChain(async (h) => {
    const payload = JSON.stringify(recordBody());
    for (const [answer, status, exact, error] of [
      ['committed', 201, null, null], ['already_recorded', 409, '{"error":"already_recorded"}', null], ['invalid_state', 409, '{"error":"invalid_state"}', null],
      ['amount_exceeds_remaining', 409, '{"error":"amount_exceeds_remaining"}', null], ['conflict', 409, '{"error":"write_conflict"}', null],
      ['not_found', 404, null, 'not_found'], ['precondition_failed', 409, null, 'write_conflict'], ['unavailable', 503, null, 'service_unavailable'],
    ] as const) {
      h.answer(answer);
      const key = randomUUID();
      const first = await h.send(recordAt(), payload, key);
      assert.equal(first.status, status, `${answer}: ${first.body}`);
      const created = answer === 'committed';
      if (created) {
        const id = (h.commits.at(-1) as TransactionCommand).mutation.aggregateId;
        assert.equal(first.body, JSON.stringify({ payment: { id, invoiceId: INVOICE, attemptId: ATTEMPT, amountCents: 1250, method: 'cash' } }), 'the sealed 201');
        assert.equal(first.headers.location, undefined, 'no Location');
      } else if (exact !== null) assert.equal(first.body, exact, `${answer}: the exact sealed bytes`);
      else assertUnsealed(first, error as string, answer);
      const commits = h.commits.length;
      h.answer('committed');
      const retry = await h.send(recordAt(), payload, key);
      if (created || exact !== null) assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [status, first.body, 'true'], `${answer}: replayed`);
      else assertUnsealed(retry, 'request_in_progress', `${answer}: the lease kept`);
      assert.equal(h.commits.length, commits, `${answer}: the retry planned and committed nothing`);
    }
    const c = h.commits[0];
    assert.deepEqual([c.mutation.kind, c.mutation.aggregateType, c.mutation.expectedVersion, c.mutation.changes],
      ['store.invoice_payment.record', 'invoice_payment', null, { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, amountCents: 1250, method: 'cash', registrationId: REGISTRATION, registrationProof: PROOF }]);
    assert.deepEqual([c.context?.store, c.audit.action, c.audit.permission, c.audit.reasonCode, c.audit.reason, c.events.length, c.authNotAfter],
      [STORE, 'store.invoice_payment.record', 'record_invoice_payments', null, null, 0, null]);
    assert.deepEqual(h.requirements.at(-1), INVOICE_PAYMENT_RECORD_REQUIREMENT);
    // A new key reusing the attempt is the store's decision (already_recorded above); a body the planner refuses is the 400.
    for (const bytes of [JSON.stringify(recordBody({ amountCents: 0 })), JSON.stringify(recordBody({ cvv: '123' })), JSON.stringify(recordBody({ method: 'card' }))]) {
      const records = h.records.size;
      const bad = await h.send(recordAt(), bytes, randomUUID());
      assert.deepEqual([bad.status, reasonOf(h, bad)], [400, 'command_request_invalid'], bytes);
      assert.equal(h.records.size, records + 1, `${bytes}: the key taken`);
    }
    // A malformed invoice segment: the 400 before the key is taken.
    const records = h.records.size;
    const malformed = await h.send(recordAt('X'), payload, randomUUID());
    assert.deepEqual([malformed.status, reasonOf(h, malformed)], [400, 'command_target_invalid']);
    assert.equal(h.records.size, records, 'no key reserved');
    // One key sent to another invoice is the 422, never a replay.
    const key = randomUUID();
    assert.equal((await h.send(recordAt(), payload, key)).status, 201);
    const elsewhere = await h.send(recordAt(OTHER_INVOICE), payload, key);
    assert.equal(elsewhere.status, 422);
    assertUnsealed(elsewhere, 'idempotency_key_reused', 'another invoice');
  });
});

test('IPU-10 (§12.3): the reversal over the chain — a sign-in older than 10 minutes is 403 step_up_required before the body or a key; otherwise the sealed 200, invalid_state and write_conflict replayed; both path ids reach the planner and the fingerprint (another payment under the key is the 422); a malformed payment id is the 400 before the key', async () => {
  await withChain(async (h) => {
    const stale = await h.send(reverseAt(), JSON.stringify(reverseBody()), randomUUID());
    assert.deepEqual([stale.status, reasonOf(h, stale)], [403, 'recent_auth_required']);
    assertUnsealed(stale, 'step_up_required', 'stale');
    assert.deepEqual([h.records.size, h.commits.length], [0, 0]);
  }, { authenticatedAt: Date.now() - RECENT_AUTH_MAX_AGE_MS - 1_000 });
  await withChain(async (h) => {
    const payload = JSON.stringify(reverseBody());
    for (const [answer, status, exact] of [['committed', 200, JSON.stringify({ payment: { id: PAYMENT, invoiceId: INVOICE, status: 'reversed' } })],
      ['invalid_state', 409, '{"error":"invalid_state"}'], ['conflict', 409, '{"error":"write_conflict"}']] as const) {
      h.answer(answer);
      const key = randomUUID();
      const first = await h.send(reverseAt(), payload, key);
      assert.deepEqual([first.status, first.body], [status, exact], answer);
      h.answer('committed');
      const retry = await h.send(reverseAt(), payload, key);
      assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [status, exact, 'true'], `${answer}: replayed`);
    }
    for (const [answer, status, error] of [['not_found', 404, 'not_found'], ['precondition_failed', 409, 'write_conflict'], ['already_recorded', 503, 'service_unavailable']] as const) {
      h.answer(answer);
      const r = await h.send(reverseAt(), payload, randomUUID());
      assert.equal(r.status, status, answer);
      assertUnsealed(r, error, answer);
    }
    const ctx = h.plans[0] as { targetId: string; paymentId: string; storeId: string };
    assert.deepEqual([ctx.targetId, ctx.paymentId, ctx.storeId], [INVOICE, PAYMENT, STORE], 'the invoice, the payment and the store, from the template\'s literals');
    const c = h.commits[0];
    assert.deepEqual([c.mutation.kind, c.mutation.aggregateId, c.mutation.expectedVersion, c.mutation.changes],
      ['store.invoice_payment.reverse', PAYMENT, 1, { invoiceId: INVOICE, expectedTenant: TENANT, reasonCode: 'duplicate' }]);
    assert.equal(c.authNotAfter, h.authenticatedAt + RECENT_AUTH_MAX_AGE_MS, 'the deadline the mutator re-judges');
    assert.deepEqual(h.requirements.at(-1), INVOICE_PAYMENT_REVERSE_REQUIREMENT);
    // The fingerprint: invoice, then payment.
    const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
    h.answer('committed');
    const key = randomUUID();
    assert.equal((await h.send(reverseAt(), payload, key)).status, 200);
    const binding = { method: 'POST' as const, path: INVOICE_PAYMENT_REVERSE_PATH, audience: 'tenant' as const, tenant: TENANT, store: STORE, actor: ACTOR, body: Buffer.from(payload) };
    const expected = keyring.operationOf(key, PRINCIPAL, { ...binding, target: INVOICE, secondTarget: PAYMENT });
    assert.equal(h.records.get(expected.scope)?.fingerprint, expected.fingerprint, 'the reserved fingerprint carries both targets');
    for (const [label, path] of [['another payment', reverseAt(OTHER_PAYMENT)], ['another invoice', reverseAt(PAYMENT, OTHER_INVOICE)]] as const) {
      const reused = await h.send(path, payload, key);
      assert.equal(reused.status, 422, label);
      assertUnsealed(reused, 'idempotency_key_reused', label);
    }
    const records = h.records.size;
    for (const path of [reverseAt('X'), reverseAt(PAYMENT.toUpperCase()), reverseAt(PAYMENT, 'x')]) {
      const r = await h.send(path, payload, randomUUID());
      assert.deepEqual([r.status, reasonOf(h, r)], [400, 'command_target_invalid'], path);
    }
    assert.equal(h.records.size, records, 'no key reserved for a malformed target');
  });
});

// M7B-PAYMENTS-P2 (record v2): the registration the record names and a synthetic 64-hex proof (never a real MAC). Defined last —
// every use runs inside a test body, after this module has evaluated — so the owner-approved fixture line stays at :499.
const REGISTRATION = randomUUID();
const PROOF = 'ab'.repeat(32);
