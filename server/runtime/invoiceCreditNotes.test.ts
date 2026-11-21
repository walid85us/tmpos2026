// Phase 4.0 M7B-CREDITNOTES-P1 (doc 16, migration 038) — credit notes below the database: the four contracts and seven route
// declarations, the strict planners, the proof, attempts and list decoders and handlers (names absent unless visible), and
// each store answer over the enforced chain (the sealed already_issued and amount_exceeds_remaining, the withdrawal's second
// id segment, a replacement session's 422, a stale sign-in's 403). The routines are proved against a real cluster by the DB
// and HTTP suites.
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
import {
  INVOICE_CREDIT_NOTES_ASK, INVOICE_CREDIT_NOTES_PATH, INVOICE_CREDIT_NOTES_VIEW_REQUIREMENT, INVOICE_CREDIT_NOTE_ATTEMPTS_PATH,
  INVOICE_CREDIT_NOTE_ISSUE_CONTRACT, INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT, INVOICE_CREDIT_NOTE_ISSUE_ROUTE, INVOICE_CREDIT_NOTE_PROOF_PATH,
  INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT, INVOICE_CREDIT_NOTE_REGISTER_CONTRACT, INVOICE_CREDIT_NOTE_REGISTER_PATH, INVOICE_CREDIT_NOTE_REGISTER_ROUTE,
  INVOICE_CREDIT_NOTE_SETTLE_CONTRACT, INVOICE_CREDIT_NOTE_SETTLE_PATH, INVOICE_CREDIT_NOTE_SETTLE_ROUTE, INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT,
  INVOICE_CREDIT_NOTE_WITHDRAW_PATH, INVOICE_CREDIT_NOTE_WITHDRAW_REQUIREMENT, INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE, INVOICE_CREDIT_NOTE_REASONS,
  INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS, createInvoiceCreditNoteAttemptsRoute, createInvoiceCreditNoteProofRoute, createInvoiceCreditNotesRoute,
  creditNoteProofOf, invoiceCreditNoteAttemptsOf, invoiceCreditNotesOf, parseCreditNoteAttemptsQuery, parseCreditNoteProofQuery,
  parseInvoiceCreditNotesQuery, planInvoiceCreditNoteIssue, planInvoiceCreditNoteRegister, planInvoiceCreditNoteSettle, planInvoiceCreditNoteWithdraw,
} from './invoiceCreditNotes.js';
import type { InvoiceCreditNotesPort } from './invoiceCreditNotes.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { COMMAND_REQUEST_INVALID, defineRoutes, sessionPaths } from './routes.js';
import type { RouteContext, RouteDefinition } from './routes.js';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';

const ACTOR = randomUUID();
const TENANT = randomUUID();
const STORE = randomUUID();
const MEMBERSHIP = randomUUID();
const INVOICE = randomUUID();
const ATTEMPT = randomUUID();
const REGISTRATION = randomUUID();
const CREDIT_NOTE = randomUUID();
const NEW_ID = randomUUID();
const SESSION_KEY = 'k'.repeat(43);
const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-tenant-bearer';
const PRINCIPAL = Object.freeze({ authProvider: 'synthetic', authProviderUid: 'uid-credit-notes' });
const MAX = Number.MAX_SAFE_INTEGER;
/** A synthetic registration proof: 64 lowercase hex digits (never a real MAC). */
const PROOF = 'cd'.repeat(32);
/** A uuid whose version nibble is 0: canonical text, but not the outbox's aggregate-id shape. */
const UNVERSIONED = `${randomUUID().slice(0, 14)}0${randomUUID().slice(15)}`;
const scopeAt = (store: string): TrustedScope => Object.freeze({
  actor: ACTOR, securityVersion: 'v1', scope: 'store', tenant: TENANT, store, membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
});
const TIME = (n: number) => `2026-11-15T10:00:${String(n).padStart(2, '0')}.000000Z`;
const ID = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const registerBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, attemptId: ATTEMPT, grossCents: 2000, reason: 'goodwill', ...over });
const issueBody = (over: Record<string, unknown> = {}) => ({
  expectedTenant: TENANT, registrationId: REGISTRATION, attemptId: ATTEMPT, grossCents: 2000, reason: 'goodwill', registrationProof: PROOF, ...over,
});
const settleBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, attemptId: ATTEMPT, expectedVersion: 1, ...over });
const withdrawBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, expectedVersion: 1, reason: 'entered_in_error', ...over });
const ctxOf = (body: unknown, over: Record<string, unknown> = {}) => Object.freeze({ audience: 'tenant', body, newAggregateId: NEW_ID, targetId: INVOICE, storeId: STORE, ...over }) as never;

test('ICN-01 the four contracts: the registration and the issue CREATEs opting into the credit refusals, the settlement and the withdrawal UPDATEs; no event; the seven routes and their keys, recent sign-in and session binding', () => {
  assert.deepEqual([INVOICE_CREDIT_NOTE_REGISTER_CONTRACT, INVOICE_CREDIT_NOTE_ISSUE_CONTRACT, INVOICE_CREDIT_NOTE_SETTLE_CONTRACT, INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT]
    .map((c) => [c.kind, c.mode, c.aggregateType, c.contextScope, c.events, c.paymentRefusals]), [
    ['store.invoice_credit_note.register', 'create', 'invoice_credit_note_registration', 'store', [], 'credit'],
    ['store.invoice_credit_note.issue', 'create', 'invoice_credit_note', 'store', [], 'credit'],
    ['store.invoice_credit_note.settle', 'update', 'invoice_credit_note_registration', 'store', [], undefined],
    ['store.invoice_credit_note.withdraw', 'update', 'invoice_credit_note', 'store', [], undefined],
  ]);
  assert.deepEqual(INVOICE_CREDIT_NOTE_REASONS, ['pricing_error', 'service_issue', 'goodwill', 'billing_error']);
  assert.deepEqual(INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS, ['entered_in_error', 'wrong_amount', 'wrong_invoice']);
  const json = { kind: 'json', maxBytes: 1024, required: true };
  const policy = (authorization: unknown) => ({ access: 'session', audience: 'tenant', authorization });
  assert.deepEqual([INVOICE_CREDIT_NOTE_REGISTER_ROUTE, INVOICE_CREDIT_NOTE_ISSUE_ROUTE, INVOICE_CREDIT_NOTE_SETTLE_ROUTE, INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE]
    .map((r) => [r.method, r.path, r.policy, r.body, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding]), [
    ['POST', '/api/v1/stores/{storeId}/invoices/{id}/credit-note-registrations', policy(INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT), json, 'required', 'required', 'required', 'required'],
    ['POST', '/api/v1/stores/{storeId}/invoices/{id}/credit-notes', policy(INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT), json, 'required', 'required', 'required', 'required'],
    ['POST', '/api/v1/stores/{storeId}/invoices/{id}/credit-note-settlement', policy(INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT), json, 'required', 'required', 'none', undefined],
    ['POST', '/api/v1/stores/{storeId}/invoices/{id}/credit-notes/{creditNoteId}/withdrawal', policy(INVOICE_CREDIT_NOTE_WITHDRAW_REQUIREMENT), json, 'required', 'required', 'required', undefined],
  ]);
  assert.deepEqual([INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT, INVOICE_CREDIT_NOTE_WITHDRAW_REQUIREMENT, INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT, INVOICE_CREDIT_NOTES_VIEW_REQUIREMENT]
    .map((r) => r.permission), ['issue_invoice_credit_notes', 'withdraw_invoice_credit_notes', 'recover_invoice_credit_notes', 'view_issued_invoices']);
  const port = { proof: () => null, attempts: () => null, list: () => null };
  const reads = [createInvoiceCreditNoteProofRoute({ invoiceCreditNotes: port }), createInvoiceCreditNoteAttemptsRoute({ invoiceCreditNotes: port }),
    createInvoiceCreditNotesRoute({ invoiceCreditNotes: port })];
  assert.deepEqual(reads.map((r) => [r.method, r.path, r.policy, r.idempotency, r.recentAuth, r.sessionBinding, r.trustedContext]), [
    ['GET', INVOICE_CREDIT_NOTE_PROOF_PATH, policy(INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT), 'none', 'none', 'required', 'required'],
    ['GET', INVOICE_CREDIT_NOTE_ATTEMPTS_PATH, policy(INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT), 'none', 'none', 'required', 'required'],
    ['GET', INVOICE_CREDIT_NOTES_PATH, policy(INVOICE_CREDIT_NOTES_VIEW_REQUIREMENT), 'none', 'none', 'required', 'required'],
  ]);
  assert.deepEqual([INVOICE_CREDIT_NOTE_REGISTER_PATH, INVOICE_CREDIT_NOTE_SETTLE_PATH, INVOICE_CREDIT_NOTE_WITHDRAW_PATH], [
    '/api/v1/stores/{storeId}/invoices/{id}/credit-note-registrations', '/api/v1/stores/{storeId}/invoices/{id}/credit-note-settlement',
    '/api/v1/stores/{storeId}/invoices/{id}/credit-notes/{creditNoteId}/withdrawal']);
  assert.doesNotThrow(() => defineRoutes([INVOICE_CREDIT_NOTE_REGISTER_ROUTE, INVOICE_CREDIT_NOTE_ISSUE_ROUTE, INVOICE_CREDIT_NOTE_SETTLE_ROUTE, INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE, ...reads]));
  assert.doesNotThrow(() => defineCommands([INVOICE_CREDIT_NOTE_REGISTER_CONTRACT, INVOICE_CREDIT_NOTE_ISSUE_CONTRACT, INVOICE_CREDIT_NOTE_SETTLE_CONTRACT,
    INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT], defineOutboxEvents([])));
  // The session binding is declared, never defaulted: the registration or the issue unbound fails; the settlement or withdrawal bound fails.
  for (const [label, def] of [['the registration unbound', { ...INVOICE_CREDIT_NOTE_REGISTER_ROUTE, sessionBinding: 'none' }],
    ['the issue undeclared', { ...INVOICE_CREDIT_NOTE_ISSUE_ROUTE, sessionBinding: undefined }],
    ['the settlement bound', { ...INVOICE_CREDIT_NOTE_SETTLE_ROUTE, sessionBinding: 'required' }],
    ['the withdrawal bound', { ...INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE, sessionBinding: 'required' }]] as const) {
    assert.throws(() => defineRoutes([def as RouteDefinition]), /route_session_binding_invalid/, label);
  }
  assert.throws(() => createInvoiceCreditNotesRoute({ invoiceCreditNotes: { proof: () => null, attempts: () => null } } as never), /route_handler_invalid/);
  assert.throws(() => createInvoiceCreditNoteProofRoute({} as never), /route_handler_invalid/);
  assert.throws(() => createInvoiceCreditNoteAttemptsRoute({ invoiceCreditNotes: port }, { deadlineMs: 0 }), /port_deadline_invalid/);
  // The prepared 'credit' command carries exactly its five sealed slots.
  const plan = planInvoiceCreditNoteIssue(ctxOf(issueBody()));
  const prepared = prepareCommand(INVOICE_CREDIT_NOTE_ISSUE_CONTRACT, defineOutboxEvents([]), plan, {
    scope: 's', lease: 'l', newAggregateId: NEW_ID, authorization: INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT, context: scopeAt(STORE), authNotAfter: Date.now() + 60_000,
    sessionKey: SESSION_KEY, seal: (e) => Buffer.from(JSON.stringify(e)).toString('base64url'),
  } as never);
  assert.ok(prepared !== null);
  assert.deepEqual(Object.keys(prepared.rejected).sort(), ['alreadyIssued', 'amountExceedsRemaining', 'conflict', 'customerNotFound', 'invalidState']);
  assert.deepEqual(JSON.parse(prepared.rejected.alreadyIssued?.body ?? 'null'), { error: 'already_issued' });
  assert.equal(prepared.rejected.alreadyIssued?.status, 409);
});

test('ICN-02 the planners: the exact plans (the amount and reason bound, no number in the 201), and every out-of-contract body or context refused', () => {
  assert.deepEqual(planInvoiceCreditNoteRegister(ctxOf(registerBody())), {
    aggregateId: NEW_ID, expectedVersion: null, changes: { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, grossCents: 2000, reason: 'goodwill' },
    events: [], response: { status: 201, body: { registration: { id: NEW_ID, invoiceId: INVOICE, attemptId: ATTEMPT, grossCents: 2000, reason: 'goodwill', state: 'open' } } },
  });
  assert.deepEqual(planInvoiceCreditNoteIssue(ctxOf(issueBody())), {
    aggregateId: NEW_ID, expectedVersion: null,
    changes: { invoiceId: INVOICE, expectedTenant: TENANT, registrationId: REGISTRATION, attemptId: ATTEMPT, grossCents: 2000, reason: 'goodwill', registrationProof: PROOF },
    events: [], response: { status: 201, body: { creditNote: { id: NEW_ID, invoiceId: INVOICE, attemptId: ATTEMPT, grossCents: 2000, reason: 'goodwill' } } },
  });
  for (const v of [1, 2] as const) {
    const response = { status: 200, body: { settlement: { invoiceId: INVOICE, attemptId: ATTEMPT, state: v === 1 ? 'released' : 'confirmed' } } };
    assert.deepEqual(planInvoiceCreditNoteSettle(ctxOf(settleBody({ expectedVersion: v }))), {
      aggregateId: ATTEMPT, expectedVersion: v, changes: { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT }, events: [], response, unchanged: response,
    });
  }
  assert.deepEqual(planInvoiceCreditNoteWithdraw(ctxOf(withdrawBody(), { creditNoteId: CREDIT_NOTE })), {
    aggregateId: CREDIT_NOTE, expectedVersion: 1, changes: { invoiceId: INVOICE, expectedTenant: TENANT, reason: 'entered_in_error' },
    events: [], response: { status: 200, body: { creditNote: { id: CREDIT_NOTE, invoiceId: INVOICE, status: 'withdrawn' } } },
  });
  const badBodies = (base: Record<string, unknown>, extra: Record<string, unknown>[]) => [
    null, [], 'x', { ...base, extra: 1 }, Object.fromEntries(Object.entries(base).slice(1)), { ...base, expectedTenant: TENANT.toUpperCase() }, ...extra];
  for (const body of badBodies(registerBody(), [registerBody({ grossCents: 0 }), registerBody({ grossCents: MAX + 1 }), registerBody({ grossCents: 1.5 }),
    registerBody({ grossCents: '2000' }), registerBody({ reason: 'refund' }), registerBody({ attemptId: 'a' })])) {
    assert.equal(planInvoiceCreditNoteRegister(ctxOf(body)), COMMAND_REQUEST_INVALID, JSON.stringify(body));
  }
  for (const body of badBodies(issueBody(), [issueBody({ registrationProof: PROOF.toUpperCase() }), issueBody({ registrationProof: PROOF.slice(1) }),
    issueBody({ registrationId: null }), issueBody({ reason: 'other' }), issueBody({ grossCents: -1 })])) {
    assert.equal(planInvoiceCreditNoteIssue(ctxOf(body)), COMMAND_REQUEST_INVALID, JSON.stringify(body));
  }
  for (const body of badBodies(settleBody(), [settleBody({ expectedVersion: 3 }), settleBody({ expectedVersion: '1' }), settleBody({ expectedVersion: 0 })])) {
    assert.equal(planInvoiceCreditNoteSettle(ctxOf(body)), COMMAND_REQUEST_INVALID, JSON.stringify(body));
  }
  for (const body of badBodies(withdrawBody(), [withdrawBody({ expectedVersion: 2 }), withdrawBody({ reason: 'goodwill' }), withdrawBody({ expectedVersion: null })])) {
    assert.equal(planInvoiceCreditNoteWithdraw(ctxOf(body, { creditNoteId: CREDIT_NOTE })), COMMAND_REQUEST_INVALID, JSON.stringify(body));
  }
  // Contexts: no target, an unversioned target, no store, a second id where none belongs (or none where one does).
  for (const over of [{ targetId: undefined }, { targetId: UNVERSIONED }, { storeId: undefined }, { paymentId: CREDIT_NOTE }, { creditNoteId: CREDIT_NOTE }]) {
    assert.equal(planInvoiceCreditNoteRegister(ctxOf(registerBody(), over)), COMMAND_REQUEST_INVALID, JSON.stringify(over));
    assert.equal(planInvoiceCreditNoteIssue(ctxOf(issueBody(), over)), COMMAND_REQUEST_INVALID, JSON.stringify(over));
    assert.equal(planInvoiceCreditNoteSettle(ctxOf(settleBody(), over)), COMMAND_REQUEST_INVALID, JSON.stringify(over));
  }
  for (const over of [{}, { creditNoteId: UNVERSIONED }, { creditNoteId: CREDIT_NOTE, paymentId: CREDIT_NOTE }, { creditNoteId: CREDIT_NOTE, targetId: UNVERSIONED }]) {
    assert.equal(planInvoiceCreditNoteWithdraw(ctxOf(withdrawBody(), over)), COMMAND_REQUEST_INVALID, JSON.stringify(over));
  }
});

// --- the decoders ---------------------------------------------------------------------------------------------------------

test('ICN-03 the proof and the queries: exact words only, the registration and invoice echoed, a proof of 64 lowercase hex', () => {
  const good = { outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF };
  assert.deepEqual(creditNoteProofOf(good, INVOICE, REGISTRATION), { attemptId: ATTEMPT, proof: PROOF });
  assert.equal(creditNoteProofOf({ outcome: 'denied' }, INVOICE, REGISTRATION), 'denied');
  assert.equal(creditNoteProofOf({ outcome: 'not_found' }, INVOICE, REGISTRATION), 'not_found');
  for (const bad of [null, { outcome: 'refused' }, { outcome: 'not_durable' }, { outcome: 'denied', proof: PROOF }, { ...good, registrationId: randomUUID() },
    { ...good, invoiceId: randomUUID() }, { ...good, proof: PROOF.toUpperCase() }, { ...good, extra: 1 }, { ...good, attemptId: 'x' }]) {
    assert.equal(creditNoteProofOf(bad, INVOICE, REGISTRATION), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseCreditNoteProofQuery(`/x?registration=${REGISTRATION}`), { registrationId: REGISTRATION });
  for (const q of ['/x', '/x?', `/x?registration=${REGISTRATION}&a=1`, `/x?registration=${REGISTRATION.toUpperCase()}`]) assert.equal(parseCreditNoteProofQuery(q), null, q);
  assert.deepEqual(parseCreditNoteAttemptsQuery('/x'), { after: null });
  assert.deepEqual(parseCreditNoteAttemptsQuery(`/x?after=${INVOICE}.${ATTEMPT}`), { after: { invoiceId: INVOICE, attemptId: ATTEMPT } });
  assert.equal(parseCreditNoteAttemptsQuery(`/x?after=${INVOICE}`), null);
  assert.deepEqual(parseInvoiceCreditNotesQuery('/x'), { after: null });
  assert.deepEqual(parseInvoiceCreditNotesQuery(`/x?after=${CREDIT_NOTE}`), { after: CREDIT_NOTE });
  for (const q of ['/x?', '/x?after=', `/x?after=${CREDIT_NOTE}&b=1`]) assert.equal(parseInvoiceCreditNotesQuery(q), null, q);
});

const attempt = (n: number, over: Record<string, unknown> = {}) => ({
  invoiceId: ID(n), invoiceNumber: n, attemptId: randomUUID(), state: 'open', version: 1, registeredAt: TIME(n), settledAt: null, grossCents: 500,
  reason: 'pricing_error', creditNote: null, ...over,
});

test('ICN-04 the attempts decoder: each state with its version, settlement and credit note; strictly ordered; the page bound; the cursor', () => {
  const issued = { id: CREDIT_NOTE, issuedAt: TIME(2), withdrawnAt: null };
  const rows = [attempt(1), attempt(2, { state: 'issued', version: 2, creditNote: issued }), attempt(3, { state: 'released', version: 3, settledAt: TIME(4) }),
    attempt(4, { state: 'confirmed', version: 3, settledAt: TIME(5), registeredAt: TIME(4), creditNote: { id: randomUUID(), issuedAt: TIME(4), withdrawnAt: TIME(6) } })];
  const page = invoiceCreditNoteAttemptsOf({ outcome: 'attempts', attempts: rows }, null);
  assert.ok(page !== null && typeof page === 'object');
  assert.equal(page.attempts.length, 4);
  assert.equal(page.hasMore, false);
  assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'attempts', attempts: [] }, null) !== null, true);
  assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'denied' }, null), 'denied');
  assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'cursor_unknown' }, null), null, 'cursor_unknown only for a continuation');
  assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'cursor_unknown' }, { invoiceId: INVOICE, attemptId: ATTEMPT }), 'cursor_unknown');
  for (const bad of [
    attempt(1, { version: 2 }), attempt(1, { state: 'withdrawn' }), attempt(1, { state: 'issued', version: 2 }), attempt(1, { settledAt: TIME(2) }),
    attempt(1, { state: 'released', version: 3 }), attempt(1, { creditNote: issued }), attempt(1, { grossCents: 0 }), attempt(1, { reason: 'other' }),
    attempt(1, { state: 'released', version: 3, settledAt: TIME(0), registeredAt: TIME(1) }), attempt(1, { invoiceNumber: 0 }),
    attempt(5, { state: 'issued', version: 2, creditNote: { ...issued, issuedAt: TIME(4) } }),
    attempt(1, { state: 'confirmed', version: 3, settledAt: TIME(2), creditNote: { ...issued, issuedAt: TIME(3) } }),
    attempt(1, { state: 'issued', version: 2, creditNote: { ...issued, withdrawnAt: TIME(0) } }), { ...attempt(1), extra: 1 },
  ]) {
    assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'attempts', attempts: [bad] }, null), null, JSON.stringify(bad));
  }
  assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'attempts', attempts: [attempt(2), attempt(1)] }, null), null, 'out of order');
  const dup = attempt(1);
  assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'attempts', attempts: [dup, dup] }, null), null, 'a pair twice');
  const many = Array.from({ length: 51 }, (_, i) => attempt(i + 1, { registeredAt: TIME(0) }));
  many.sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : 1));
  const full = invoiceCreditNoteAttemptsOf({ outcome: 'attempts', attempts: many }, null);
  assert.ok(full !== null && typeof full === 'object' && full.hasMore && full.attempts.length === 50);
  assert.equal(invoiceCreditNoteAttemptsOf({ outcome: 'attempts', attempts: [...many, attempt(99)] }, null), null, 'over the ask');
});

const note = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n), number: n, grossCents: 1000, taxCents: 91, netCents: 909, reason: 'service_issue', issuedAt: TIME(n), issuedByName: null, withdrawal: null, ...over,
});
const listOf = (creditNotes: unknown[], namesVisible: boolean, over: Record<string, unknown> = {}) => ({ outcome: 'credit_notes', invoiceId: INVOICE, namesVisible, creditNotes, ...over });

test('ICN-05 the list decoder: gross = tax + net, names exactly null when not visible, bounded names when visible, order, distinct numbers, the cursor', () => {
  const visible = invoiceCreditNotesOf(listOf([note(1, { issuedByName: 'Ana' }), note(2, { withdrawal: { withdrawnAt: TIME(3), reason: 'wrong_amount', withdrawnByName: null } })], true), INVOICE, null);
  assert.ok(visible !== null && typeof visible === 'object');
  assert.deepEqual(visible.creditNotes[0], note(1, { issuedByName: 'Ana' }));
  assert.deepEqual(visible.creditNotes[1].withdrawal, { withdrawnAt: TIME(3), reason: 'wrong_amount', withdrawnByName: null });
  const hidden = invoiceCreditNotesOf(listOf([note(1, { withdrawal: { withdrawnAt: TIME(3), reason: 'wrong_invoice', withdrawnByName: null } })], false), INVOICE, null);
  assert.ok(hidden !== null && typeof hidden === 'object');
  assert.equal('issuedByName' in hidden.creditNotes[0], false, 'absent, not null');
  assert.equal('withdrawnByName' in (hidden.creditNotes[0].withdrawal as object), false);
  assert.equal(invoiceCreditNotesOf(listOf([note(1, { issuedByName: 'Ana' })], false), INVOICE, null), null, 'a name when not visible is out of contract');
  assert.equal(invoiceCreditNotesOf(listOf([], true), INVOICE, null) !== null, true, 'the empty page');
  for (const word of ['denied', 'not_found']) assert.equal(invoiceCreditNotesOf({ outcome: word }, INVOICE, null), word);
  assert.equal(invoiceCreditNotesOf({ outcome: 'cursor_unknown' }, INVOICE, null), null);
  assert.equal(invoiceCreditNotesOf({ outcome: 'cursor_unknown' }, INVOICE, CREDIT_NOTE), 'cursor_unknown');
  for (const bad of [note(1, { netCents: 910 }), note(1, { taxCents: 1001, netCents: -1 }), note(1, { grossCents: 0, taxCents: 0, netCents: 0 }), note(1, { number: 0 }),
    note(1, { reason: 'refund' }), note(1, { issuedByName: 'a'.repeat(1001) }), note(1, { issuedByName: 'a\nb' }), note(1, { issuedByName: 7 }),
    note(1, { withdrawal: { withdrawnAt: TIME(0), reason: 'wrong_amount', withdrawnByName: null } }),
    note(1, { withdrawal: { withdrawnAt: TIME(2), reason: 'goodwill', withdrawnByName: null } }), { ...note(1), extra: 1 }]) {
    assert.equal(invoiceCreditNotesOf(listOf([bad], true), INVOICE, null), null, JSON.stringify(bad));
  }
  assert.equal(invoiceCreditNotesOf(listOf([note(2), note(1)], false), INVOICE, null), null, 'out of order');
  assert.equal(invoiceCreditNotesOf(listOf([note(1), note(2, { number: 1 })], false), INVOICE, null), null, 'a number twice');
  assert.equal(invoiceCreditNotesOf(listOf([note(1)], false), INVOICE, ID(1)), null, 'the cursor itself');
  assert.equal(invoiceCreditNotesOf(listOf([note(1)], false, { invoiceId: randomUUID() }), INVOICE, null), null, 'another invoice');
  assert.equal(invoiceCreditNotesOf(listOf([note(1)], 'yes' as never), INVOICE, null), null, 'visibility is a boolean');
  const many = Array.from({ length: INVOICE_CREDIT_NOTES_ASK }, (_, i) => note(i + 1, { issuedAt: TIME(0) }));
  const full = invoiceCreditNotesOf(listOf(many, false), INVOICE, null);
  assert.ok(full !== null && typeof full === 'object' && full.hasMore && full.creditNotes.length === 50);
});

// --- the read handlers ----------------------------------------------------------------------------------------------------

interface Captured { status: number | null; body: unknown; locals: Record<string, unknown> }
async function runHandler(route: RouteDefinition, path: string, opts: { url?: string; trusted?: TrustedScope | null } = {}) {
  const out: Captured = { status: null, body: undefined, locals: {} };
  const res = { locals: out.locals, status(code: number) { out.status = code; return res; }, json(b: unknown) { out.body = b; return res; } };
  const ctx = {
    requestId: 'req-9', principal: null, session: null, authenticatedAt: null, body: undefined,
    trusted: 'trusted' in opts ? opts.trusted : scopeAt(STORE), sessionKey: SESSION_KEY,
  } as unknown as RouteContext;
  if (route.idempotency !== 'none') throw new Error('a read');
  await route.handler({ url: opts.url ?? path, path } as unknown as Request, res as unknown as Response, ctx);
  return out;
}
const portWith = (over: Partial<InvoiceCreditNotesPort>): { invoiceCreditNotes: InvoiceCreditNotesPort } => ({
  invoiceCreditNotes: { proof: () => { throw new Error('unused'); }, attempts: () => { throw new Error('unused'); }, list: () => { throw new Error('unused'); }, ...over },
});
const listPath = `/api/v1/stores/${STORE}/invoices/${INVOICE}/credit-notes`;

test('ICN-06 the list route: names omitted unless visible (a visible null sent as null), the cursor, each refusal\'s status, a fault the 503', async () => {
  let answer: unknown = listOf([note(1)], false);
  const seen: unknown[] = [];
  const route = createInvoiceCreditNotesRoute(portWith({ list: (scope, key, invoice, after) => { seen.push([scope.store, key, invoice, after]); return answer; } }));
  let out = await runHandler(route, listPath);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { invoice: { id: INVOICE }, creditNotes: [{ id: ID(1), number: 1, grossCents: 1000, taxCents: 91, netCents: 909, reason: 'service_issue',
    issuedAt: TIME(1), withdrawal: null }], nextCursor: null });
  assert.deepEqual(seen, [[STORE, SESSION_KEY, INVOICE, null]]);
  answer = listOf([note(1), note(2, { issuedByName: 'Bo', withdrawal: { withdrawnAt: TIME(4), reason: 'wrong_amount', withdrawnByName: 'Cy' } })], true);
  out = await runHandler(route, listPath, { url: `${listPath}?after=${ID(0)}` });
  assert.equal(out.status, 200);
  assert.deepEqual((out.body as { creditNotes: unknown[] }).creditNotes, [
    { id: ID(1), number: 1, grossCents: 1000, taxCents: 91, netCents: 909, reason: 'service_issue', issuedAt: TIME(1), issuedByName: null, withdrawal: null },
    { id: ID(2), number: 2, grossCents: 1000, taxCents: 91, netCents: 909, reason: 'service_issue', issuedAt: TIME(2), issuedByName: 'Bo',
      withdrawal: { withdrawnAt: TIME(4), reason: 'wrong_amount', withdrawnByName: 'Cy' } },
  ]);
  answer = listOf(Array.from({ length: 51 }, (_, i) => note(i + 1, { issuedAt: TIME(0) })), false);
  out = await runHandler(route, listPath);
  assert.equal((out.body as { nextCursor: unknown }).nextCursor, ID(50));
  for (const [raw, status, error, url] of [[{ outcome: 'denied' }, 403, 'forbidden', listPath], [{ outcome: 'not_found' }, 404, 'not_found', listPath],
    [{ outcome: 'cursor_unknown' }, 400, 'invalid_request', `${listPath}?after=${ID(9)}`], [{ outcome: 'refused' }, 503, 'service_unavailable', listPath]] as const) {
    answer = raw;
    out = await runHandler(route, listPath, { url });
    assert.deepEqual([out.status, out.body], [status, { error, requestId: 'req-9' }], JSON.stringify(raw));
  }
  out = await runHandler(route, listPath, { url: `${listPath}?x=1` });
  assert.equal(out.status, 400);
  out = await runHandler(route, listPath, { trusted: null });
  assert.equal(out.status, 403);
  out = await runHandler(route, listPath, { trusted: scopeAt(randomUUID()) });
  assert.equal(out.status, 403, 'another store than the path');
  const failing = createInvoiceCreditNotesRoute(portWith({ list: () => { throw new Error('down'); } }));
  out = await runHandler(failing, listPath);
  assert.equal(out.status, 503);
});

test('ICN-07 the proof and attempts routes: the exact 200 bodies, the refusals, and the outage', async () => {
  const proofPath = `/api/v1/stores/${STORE}/invoices/${INVOICE}/credit-note-registration-proof`;
  let proof: unknown = { outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF };
  const deadlines: number[] = [];
  const proofRoute = createInvoiceCreditNoteProofRoute(portWith({ proof: (_s, _k, _i, _r, _sig, deadline) => { deadlines.push(deadline); return proof; } }));
  let out = await runHandler(proofRoute, proofPath, { url: `${proofPath}?registration=${REGISTRATION}` });
  assert.deepEqual([out.status, out.body], [200, { registration: { id: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT }, proof: PROOF }]);
  assert.deepEqual(deadlines, [3000]);
  for (const [raw, status] of [[{ outcome: 'denied' }, 403], [{ outcome: 'not_found' }, 404], [{ outcome: 'not_durable' }, 503]] as const) {
    proof = raw;
    out = await runHandler(proofRoute, proofPath, { url: `${proofPath}?registration=${REGISTRATION}` });
    assert.equal(out.status, status, JSON.stringify(raw));
  }
  out = await runHandler(proofRoute, proofPath);
  assert.equal(out.status, 400, 'the registration is required');
  const attemptsPath = `/api/v1/stores/${STORE}/credit-note-attempts`;
  const rows = Array.from({ length: 51 }, (_, i) => attempt(i + 1, { registeredAt: TIME(0) })).sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : 1));
  let attempts: unknown = { outcome: 'attempts', attempts: rows };
  const attemptsRoute = createInvoiceCreditNoteAttemptsRoute(portWith({ attempts: () => attempts }));
  out = await runHandler(attemptsRoute, attemptsPath);
  assert.equal(out.status, 200);
  const body = out.body as { attempts: Record<string, unknown>[]; nextCursor: string };
  assert.equal(body.attempts.length, 50);
  assert.deepEqual(Object.keys(body.attempts[0]), ['invoiceId', 'invoiceNumber', 'attemptId', 'state', 'version', 'registeredAt', 'settledAt', 'grossCents', 'reason', 'creditNote']);
  assert.equal(body.nextCursor, `${rows[49].invoiceId}.${rows[49].attemptId}`);
  attempts = { outcome: 'denied' };
  out = await runHandler(attemptsRoute, attemptsPath);
  assert.equal(out.status, 403);
  attempts = { outcome: 'cursor_unknown' };
  out = await runHandler(attemptsRoute, attemptsPath, { url: `${attemptsPath}?after=${INVOICE}.${ATTEMPT}` });
  assert.equal(out.status, 400);
  attempts = { outcome: 'attempts', attempts: [attempt(1, { state: 'withdrawn' })] };
  out = await runHandler(attemptsRoute, attemptsPath);
  assert.equal(out.status, 503);
});

// --- the enforced chain ---------------------------------------------------------------------------------------------------

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

type Answer = 'committed' | 'conflict' | 'invalid_state' | 'already_issued' | 'amount_exceeds_remaining' | 'not_found' | 'precondition_failed' | 'unavailable' | 'unchanged'
  | 'lease_lost' | 'unknown_word';
interface Chain {
  commits: TransactionCommand[];
  plans: unknown[];
  answer: (a: Answer) => void;
  send: (path: string, payload: string, key: string, over?: Record<string, string>) => Promise<Reply>;
  relogin: () => Promise<((path: string, payload: string, key: string, over?: Record<string, string>) => Promise<Reply>) & { get: (path: string) => Promise<Reply> }>;
  /** Doc 18 (written, not run): every log line the chain wrote, every idempotency acquisition, a GET on the session, and a POST with no session. */
  lines: string[];
  acquires: unknown[];
  get: (path: string) => Promise<Reply>;
  anonymous: (path: string, payload: string, key: string) => Promise<Reply>;
  /** Doc 18 CA-46 (written, not run): flips the admission stub — false answers `{ admitted: false }`, as a suspended tenant's does. */
  admit: (admitted: boolean) => void;
}
/** The synthetic instance id the chain is composed with (doc 18 §6.6). */
const INSTANCE = randomUUID();
async function withChain(fn: (h: Chain) => Promise<void>, opts: { authenticatedAt?: number; writes?: 'on' | 'off'; deny?: boolean; throwingWriteSink?: boolean } = {}): Promise<void> {
  const commits: TransactionCommand[] = [];
  const plans: unknown[] = [];
  const lines: string[] = [];
  const acquires: unknown[] = [];
  const authenticatedAt = opts.authenticatedAt ?? Date.now();
  let next: Answer = 'committed';
  let admittedNow = true;
  const inner = createMemoryIdempotencyStore(createMemoryIdempotencyState());
  // The chain's store: the memory store, counting every acquisition (doc 18 §9.3.1: a refused request reserves no key).
  const counted = {
    acquire: (r: Parameters<typeof inner.acquire>[0], s: AbortSignal) => { acquires.push(r); return inner.acquire(r, s); },
    complete: (r: Parameters<typeof inner.complete>[0], s: AbortSignal) => inner.complete(r, s),
    probe: (s: AbortSignal) => inner.probe(s),
  };
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
      if (next === 'already_issued') return complete(c, c.rejected.alreadyIssued, s, 'already_issued');
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
    admission: { admit: () => (admittedNow ? { admitted: true, securityVersion: 'v1', actor: ACTOR } : { admitted: false }) },
    authorizer: { authorize: (_principal: unknown, _requirement: unknown, view: { storeTarget?: string | null }) => (opts.deny !== true && typeof view.storeTarget === 'string'
      ? { granted: true, context: scopeAt(view.storeTarget) } : false) },
    store: createMemorySessionStore(),
  };
  const capture = (route: RouteDefinition): RouteDefinition => ('command' in route
    ? { ...route, command: { ...route.command, plan: (ctx) => { plans.push(ctx); return route.command.plan(ctx); } } } : route);
  const readiness = createReadinessState();
  readiness.setReady();
  // The three reads over fixed synthetic answers, so the chain can show they stay available while writes are off (doc 18 §9.3.1).
  const reads = portWith({
    proof: () => ({ outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF }),
    attempts: () => ({ outcome: 'attempts', attempts: [] }),
    list: () => listOf([], true),
  });
  const app = createApp({
    readiness, sessions: { tenant: boundary },
    // A throwing sink, when asked, for the credit_note_write line only (the request log's 'finish' listener must not throw).
    log: { log: (line) => { if (opts.throwingWriteSink === true && line.includes('"event":"credit_note_write"')) throw new Error('sink down'); lines.push(line); } },
    routes: [capture(INVOICE_CREDIT_NOTE_REGISTER_ROUTE), capture(INVOICE_CREDIT_NOTE_ISSUE_ROUTE), capture(INVOICE_CREDIT_NOTE_SETTLE_ROUTE),
      capture(INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE), createInvoiceCreditNoteProofRoute(reads), createInvoiceCreditNoteAttemptsRoute(reads),
      createInvoiceCreditNotesRoute(reads)],
    events: [], limits: testRequestLimits(), idempotency: { store: counted, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
    // Doc 18 §6.6: the write setting (on unless a case pauses it) and this process's instance id.
    creditNoteWrites: opts.writes ?? 'on', instanceId: INSTANCE,
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
      const send = (path: string, payload: string, key: string, over: Record<string, string> = {}) => request(p, 'POST', path, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
        cookie, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': key, ...over,
      }, payload);
      return Object.assign(send, { get: (path: string) => request(p, 'GET', path, { cookie, [SESSION_CSRF_HEADER]: csrf }) });
    };
    const anonymous = (path: string, payload: string, key: string) => request(p, 'POST', path, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': key,
    }, payload);
    const first = await relogin();
    await fn({ commits, plans, answer: (a) => { next = a; }, send: first, relogin, lines, acquires, get: first.get, anonymous, admit: (a) => { admittedNow = a; } });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const registerAt = `/api/v1/stores/${STORE}/invoices/${INVOICE}/credit-note-registrations`;
const issueAt = `/api/v1/stores/${STORE}/invoices/${INVOICE}/credit-notes`;
const settleAt = `/api/v1/stores/${STORE}/invoices/${INVOICE}/credit-note-settlement`;
const withdrawAt = (creditNote: string) => `/api/v1/stores/${STORE}/invoices/${INVOICE}/credit-notes/${creditNote}/withdrawal`;

test('ICN-08 over the chain: register 201 and its replay; the issue\'s sealed already_issued and amount_exceeds_remaining replayed byte for byte; a replacement session replaying the key is a 422', async () => {
  await withChain(async (h) => {
    const key = randomUUID();
    const first = await h.send(registerAt, JSON.stringify(registerBody()), key);
    assert.equal(first.status, 201, first.body);
    const registered = JSON.parse(first.body) as { registration: { id: string; state: string; grossCents: number } };
    assert.deepEqual([registered.registration.state, registered.registration.grossCents], ['open', 2000]);
    assert.equal(h.commits.length, 1);
    assert.equal(h.commits[0].mutation.kind, 'store.invoice_credit_note.register');
    assert.ok(h.commits[0].authNotAfter !== null, 'a sensitive command carries the recent sign-in deadline');
    const replay = await h.send(registerAt, JSON.stringify(registerBody()), key);
    assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed']], [201, first.body, 'true']);
    assert.equal(h.commits.length, 1, 'the replay commits nothing');
    const other = await h.relogin();
    const reused = await other(registerAt, JSON.stringify(registerBody()), key);
    assert.equal(reused.status, 422, 'a replacement session replaying the key');
    assert.equal(JSON.parse(reused.body).error, 'idempotency_key_reused');

    for (const word of ['already_issued', 'amount_exceeds_remaining', 'invalid_state', 'conflict'] as const) {
      h.answer(word);
      const k = randomUUID();
      const r = await h.send(issueAt, JSON.stringify(issueBody()), k);
      const error = word === 'conflict' ? 'write_conflict' : word;
      assert.deepEqual([r.status, JSON.parse(r.body)], [409, { error }], word);
      const again = await h.send(issueAt, JSON.stringify(issueBody()), k);
      assert.deepEqual([again.status, again.body], [409, r.body], `${word} replayed`);
    }
    for (const [word, status] of [['not_found', 404], ['precondition_failed', 409], ['unavailable', 503]] as const) {
      h.answer(word);
      const r = await h.send(issueAt, JSON.stringify(issueBody()), randomUUID());
      assert.equal(r.status, status, word);
    }
    h.answer('committed');
    const issued = await h.send(issueAt, JSON.stringify(issueBody()), randomUUID());
    assert.equal(issued.status, 201);
    assert.equal('number' in (JSON.parse(issued.body) as { creditNote: object }).creditNote, false, 'no number in the 201');
  });
});

test('ICN-09 over the chain: the withdrawal reads its credit note from the second id segment into ctx.creditNoteId; the settlement\'s unchanged 200; a stale sign-in is 403 on the sensitive routes and never on the settlement', async () => {
  await withChain(async (h) => {
    const r = await h.send(withdrawAt(CREDIT_NOTE), JSON.stringify(withdrawBody()), randomUUID());
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { creditNote: { id: CREDIT_NOTE, invoiceId: INVOICE, status: 'withdrawn' } });
    const ctx = h.plans[0] as Record<string, unknown>;
    assert.deepEqual([ctx.targetId, ctx.creditNoteId, ctx.storeId, 'paymentId' in ctx], [INVOICE, CREDIT_NOTE, STORE, false]);
    assert.deepEqual([h.commits[0].mutation.aggregateId, h.commits[0].mutation.expectedVersion], [CREDIT_NOTE, 1]);
    const bad = await h.send(withdrawAt('not-a-uuid'), JSON.stringify(withdrawBody()), randomUUID());
    assert.equal(bad.status, 400);
    h.answer('invalid_state');
    const twice = await h.send(withdrawAt(CREDIT_NOTE), JSON.stringify(withdrawBody()), randomUUID());
    assert.deepEqual([twice.status, JSON.parse(twice.body)], [409, { error: 'invalid_state' }]);
    h.answer('unchanged');
    const settled = await h.send(settleAt, JSON.stringify(settleBody({ expectedVersion: 2 })), randomUUID());
    assert.deepEqual([settled.status, JSON.parse(settled.body)], [200, { settlement: { invoiceId: INVOICE, attemptId: ATTEMPT, state: 'confirmed' } }]);
  });
  await withChain(async (h) => {
    for (const [path, body] of [[registerAt, registerBody()], [issueAt, issueBody()], [withdrawAt(CREDIT_NOTE), withdrawBody()]] as const) {
      const r = await h.send(path, JSON.stringify(body), randomUUID());
      assert.deepEqual([r.status, JSON.parse(r.body).error], [403, 'step_up_required'], path);
    }
    assert.equal(h.commits.length, 0);
    const settle = await h.send(settleAt, JSON.stringify(settleBody()), randomUUID());
    assert.equal(settle.status, 200, 'the recovery key needs no recent sign-in');
  }, { authenticatedAt: Date.now() - RECENT_AUTH_MAX_AGE_MS - 60_000 });
});

// --- the write setting and the write log line (docs/phase-4/18 §6.6, §9.3.1, §9.3.4; D-CA-14 A, D-CA-18 C) ------------------
// WRITTEN — NOT RUN (doc 18 write setting slice, local authoring only): authored without executing any test, typecheck or build.

const lineRecords = (lines: readonly string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const writeLines = (lines: readonly string[]) => lineRecords(lines).filter((r) => r.event === 'credit_note_write');
const gatedWrites = () => [[registerAt, registerBody()], [issueAt, issueBody()], [withdrawAt(CREDIT_NOTE), withdrawBody()]] as const;

test('ICN-10 CA-35 (U) (doc 18 §6.6, §9.3.1): with the write setting off, the registration, the issue and the withdrawal each answer 503 service_unavailable, logged credit_note_writes_disabled, before the body, the key and the commit — a malformed body, an unknown field, an empty key and a stale sign-in all still get that 503 — with no acquisition, no plan, no commit and no credit_note_write line; the settlement, the proof, the attempts lookup and the list answer as before', async () => {
  await withChain(async (h) => {
    for (const [path, body] of gatedWrites()) {
      for (const [payload, key] of [[JSON.stringify(body), randomUUID()], ['{not json', randomUUID()], [JSON.stringify({ ...body, extra: 1 }), randomUUID()],
        [JSON.stringify(body), '']] as const) {
        const r = await h.send(path, payload, key);
        assert.deepEqual([r.status, JSON.parse(r.body).error], [503, 'service_unavailable'], `${path} ${payload} key=${key === '' ? 'empty' : 'set'}`);
      }
    }
    const refusals = lineRecords(h.lines).filter((r) => r.event === 'request' && r.status === 503);
    assert.equal(refusals.length, 12);
    assert.ok(refusals.every((r) => r.reason === 'credit_note_writes_disabled'), JSON.stringify(refusals));
    assert.deepEqual([h.acquires.length, h.plans.length, h.commits.length], [0, 0, 0], 'no key reserved, nothing planned, nothing committed');
    assert.deepEqual(writeLines(h.lines), [], 'a refused request writes no credit_note_write line');
    // Recovery and every read stay available (doc 18 §9.3.1 table, column A).
    const settled = await h.send(settleAt, JSON.stringify(settleBody()), randomUUID());
    assert.equal(settled.status, 200, settled.body);
    // CA-47 (d)/(i) input: the settlement under off writes its committed line, carrying this (off) instance's id.
    assert.deepEqual(writeLines(h.lines).map((l) => [l.outcome, l.kind, l.instanceId, l.requestId]),
      [['committed', 'settle', INSTANCE, settled.headers['x-request-id']]], 'the settlement\'s committed line');
    for (const path of [`${INVOICE_CREDIT_NOTE_PROOF_PATH.replace('{storeId}', STORE).replace('{id}', INVOICE)}?registration=${REGISTRATION}`,
      `/api/v1/stores/${STORE}/credit-note-attempts`, listPath]) {
      const r = await h.get(path);
      assert.equal(r.status, 200, `${path}: ${r.body}`);
    }
  }, { writes: 'off' });
  // The setting stands before the step-up: a stale sign-in under off is the 503, never step_up_required, and reserves nothing.
  await withChain(async (h) => {
    for (const [path, body] of gatedWrites()) {
      const r = await h.send(path, JSON.stringify(body), randomUUID());
      assert.deepEqual([r.status, JSON.parse(r.body).error], [503, 'service_unavailable'], path);
    }
    assert.deepEqual([h.acquires.length, h.commits.length], [0, 0]);
  }, { writes: 'off', authenticatedAt: Date.now() - RECENT_AUTH_MAX_AGE_MS - 60_000 });
});

test('ICN-11 CA-46 (U) (doc 18 §9.3.1, §6.6): with the write setting off, every refusal of the session or of authorization answers before the setting — no session 401, a suspended tenant\'s session 401 session_admission_denied (the three writes), a wrong session CSRF token 403, a session without the grant 403 authz_denied — each with no acquisition, no plan and no commit', async () => {
  const reasonOf = (h: Chain, reply: Reply) => lineRecords(h.lines).find((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id'])?.reason;
  await withChain(async (h) => {
    for (const [path, body] of gatedWrites()) {
      const r = await h.anonymous(path, JSON.stringify(body), randomUUID());
      assert.equal(r.status, 401, path);
      assert.notEqual(reasonOf(h, r), 'credit_note_writes_disabled', `${path}: the session first`);
    }
    // The session-bound CSRF token is judged before the setting too. Checked before the suspended tenant below, whose
    // admission denials end every session of the principal (sessions.ts revokeAllOf), this first session included.
    for (const [path, body] of gatedWrites()) {
      const r = await h.send(path, JSON.stringify(body), randomUUID(), { [SESSION_CSRF_HEADER]: 'wrong-token' });
      assert.equal(r.status, 403, path);
      assert.match(String(reasonOf(h, r)), /^csrf_session_/, `${path}: the session CSRF refusal, not the setting`);
    }
    // A suspended tenant: admission refuses the principal on its next protected request (sessions.ts:636-638), before the setting.
    for (const [path, body] of gatedWrites()) {
      h.admit(true);
      const send = await h.relogin();
      h.admit(false);
      const r = await send(path, JSON.stringify(body), randomUUID());
      assert.deepEqual([r.status, reasonOf(h, r)], [401, 'session_admission_denied'], `suspended: ${path}`);
    }
    assert.deepEqual([h.acquires.length, h.plans.length, h.commits.length], [0, 0, 0]);
    assert.deepEqual(writeLines(h.lines), []);
  }, { writes: 'off' });
  await withChain(async (h) => {
    for (const [path, body] of gatedWrites()) {
      const r = await h.send(path, JSON.stringify(body), randomUUID());
      assert.deepEqual([r.status, JSON.parse(r.body).error, reasonOf(h, r)], [403, 'forbidden', 'authz_denied'], path);
    }
    assert.deepEqual([h.acquires.length, h.plans.length, h.commits.length], [0, 0, 0]);
  }, { writes: 'off', deny: true });
});

test('ICN-12 CA-47 (a), (b), (g) (U) (doc 18 §9.3.4): one committed credit_note_write line per committed register, issue, settlement and withdrawal, after the commit, with exactly the approved fields matched to the command; none for a replay, a sealed or rolled-back refusal, an invalid body or the unchanged settlement; unconfirmed on the 503 after a commit with no exact answer', async () => {
  await withChain(async (h) => {
    const approved = ['timestamp', 'level', 'event', 'requestId', 'instanceId', 'outcome', 'kind', 'correlationId', 'storeId', 'invoiceId'];
    const expectLine = (reply: Reply, kind: string, subject: Record<string, string>, outcome = 'committed') => {
      const all = writeLines(h.lines);
      assert.equal(all.length, 1, `${kind}: exactly one line`);
      const [line] = all;
      const command = h.commits[h.commits.length - 1];
      assert.deepEqual(Object.keys(line), [...approved, ...Object.keys(subject)], `${kind}: the closed field list`);
      assert.deepEqual([line.level, line.outcome, line.instanceId, line.requestId, line.kind, line.correlationId, line.storeId, line.invoiceId],
        ['info', outcome, INSTANCE, reply.headers['x-request-id'], kind, command.audit.correlationId, STORE, INVOICE], kind);
      for (const [name, value] of Object.entries(subject)) assert.equal(line[name], value, `${kind}: ${name}`);
      const text = h.lines.join('\n');
      assert.ok(!text.includes(PROOF), 'never the registration proof');
      for (const forbidden of ['grossCents', 'reason', 'idempotencyKey', 'scope', 'fingerprint', 'lease', 'sessionKey', 'registrationProof']) {
        assert.ok(!(forbidden in line), `${kind}: no ${forbidden}`);
      }
      h.lines.length = 0;
    };

    // (a) the four committed writes, each with its own subject (doc 18 §9.3.4 "Fields").
    const key = randomUUID();
    const registered = await h.send(registerAt, JSON.stringify(registerBody()), key);
    assert.equal(registered.status, 201, registered.body);
    const registrationId = (JSON.parse(registered.body) as { registration: { id: string } }).registration.id;
    assert.equal(h.commits[0].mutation.aggregateId, registrationId);
    expectLine(registered, 'register', { registrationId });
    const issued = await h.send(issueAt, JSON.stringify(issueBody()), randomUUID());
    assert.equal(issued.status, 201, issued.body);
    expectLine(issued, 'issue', { registrationId: REGISTRATION, creditNoteId: (JSON.parse(issued.body) as { creditNote: { id: string } }).creditNote.id });
    const settled = await h.send(settleAt, JSON.stringify(settleBody()), randomUUID());
    assert.equal(settled.status, 200, settled.body);
    expectLine(settled, 'settle', { attemptId: ATTEMPT });
    const withdrawn = await h.send(withdrawAt(CREDIT_NOTE), JSON.stringify(withdrawBody()), randomUUID());
    assert.equal(withdrawn.status, 200, withdrawn.body);
    expectLine(withdrawn, 'withdraw', { creditNoteId: CREDIT_NOTE });

    // (b) a replay of the completed key: no line, its request line says idempotency_replayed.
    const commitsBefore = h.commits.length;
    const replay = await h.send(registerAt, JSON.stringify(registerBody()), key);
    assert.deepEqual([replay.status, replay.headers['idempotent-replayed']], [201, 'true']);
    assert.equal(h.commits.length, commitsBefore, 'the replay commits nothing');
    assert.deepEqual(writeLines(h.lines), [], 'a replay writes no line');
    assert.ok(lineRecords(h.lines).some((r) => r.event === 'request' && r.reason === 'idempotency_replayed'));
    h.lines.length = 0;

    // No line for any answer that wrote no row: the sealed refusals, the rolled-back 404 and 409, an invalid body, the unchanged settlement.
    for (const word of ['already_issued', 'amount_exceeds_remaining', 'invalid_state', 'conflict', 'not_found', 'precondition_failed'] as const) {
      h.answer(word);
      const r = await h.send(issueAt, JSON.stringify(issueBody()), randomUUID());
      assert.ok(r.status === 404 || r.status === 409, `${word}: ${r.status}`);
      assert.deepEqual(writeLines(h.lines), [], `${word}: no line`);
    }
    h.answer('committed');
    const invalid = await h.send(registerAt, JSON.stringify(registerBody({ grossCents: 0 })), randomUUID());
    assert.equal(invalid.status, 400);
    h.answer('unchanged');
    const again = await h.send(settleAt, JSON.stringify(settleBody({ expectedVersion: 2 })), randomUUID());
    assert.equal(again.status, 200);
    assert.deepEqual(writeLines(h.lines), [], 'neither an invalid body nor the unchanged settlement writes a line');
    h.lines.length = 0;

    // (g) a commit with no exact answer is the 503 and one `unconfirmed` line, for each kind.
    h.answer('unavailable');
    for (const [path, body, kind] of [[registerAt, registerBody(), 'register'], [issueAt, issueBody(), 'issue'], [settleAt, settleBody(), 'settle'],
      [withdrawAt(CREDIT_NOTE), withdrawBody(), 'withdraw']] as const) {
      const r = await h.send(path, JSON.stringify(body), randomUUID());
      assert.equal(r.status, 503, kind);
      const lines = writeLines(h.lines);
      assert.deepEqual([lines.length, lines[0]?.outcome, lines[0]?.kind], [1, 'unconfirmed', kind], kind);
      h.lines.length = 0;
    }

    // (b) remainder: the retry of the unconfirmed register under a new key commits with a NEW correlation id; a further register of
    // that attempt is the routine's sealed refusal (here the store's `conflict`): 409, no line.
    const stalledKey = randomUUID();
    const stalled = await h.send(registerAt, JSON.stringify(registerBody()), stalledKey);
    assert.equal(stalled.status, 503);
    const [unconfirmed] = writeLines(h.lines);
    h.lines.length = 0;
    h.answer('committed');
    const retried = await h.send(registerAt, JSON.stringify(registerBody()), randomUUID());
    assert.equal(retried.status, 201, retried.body);
    const [committed] = writeLines(h.lines);
    assert.deepEqual([committed?.outcome, committed?.kind], ['committed', 'register']);
    assert.notEqual(committed?.correlationId, unconfirmed?.correlationId,'a retry is a new command with its own correlation id');
    h.lines.length = 0;
    h.answer('conflict');
    const second = await h.send(registerAt, JSON.stringify(registerBody()), randomUUID());
    assert.equal(second.status, 409);
    assert.deepEqual(writeLines(h.lines), [], 'a refused second register writes no line');
  });
});

// WRITTEN — NOT RUN (doc 18 §9.3.4 as amended 2026-11-19 on the owner's instruction; scratch/pause/outcome-trace.md).
test('ICN-15 CA-47 (U; doc 18 §9.3.4, amended 2026-11-19): a lost lease still answers 503 service_unavailable with its request log reason transaction_lease_lost and writes no credit_note_write line; an unavailable and a broken answer each still write exactly one unconfirmed line, for all four kinds', async () => {
  const reasons = { lease_lost: 'transaction_lease_lost', unavailable: 'transaction_unavailable', unknown_word: 'transaction_outcome_invalid' } as const;
  await withChain(async (h) => {
    for (const [path, body, kind] of [[registerAt, registerBody(), 'register'], [issueAt, issueBody(), 'issue'], [settleAt, settleBody(), 'settle'],
      [withdrawAt(CREDIT_NOTE), withdrawBody(), 'withdraw']] as const) {
      for (const word of ['lease_lost', 'unavailable', 'unknown_word'] as const) {
        h.answer(word);
        const r = await h.send(path, JSON.stringify(body), randomUUID());
        assert.deepEqual([r.status, JSON.parse(r.body).error], [503, 'service_unavailable'], `${kind} ${word}`);
        const requestLine = lineRecords(h.lines).find((l) => l.event === 'request' && l.requestId === r.headers['x-request-id']);
        assert.equal(requestLine?.reason, reasons[word], `${kind} ${word}: the ordinary request log line is unchanged`);
        assert.deepEqual(writeLines(h.lines).map((l) => [l.outcome, l.kind]), word === 'lease_lost' ? [] : [['unconfirmed', kind]],
          `${kind} ${word}: ${word === 'lease_lost' ? 'no attribution line' : 'unconfirmed'}`);
        h.lines.length = 0;
      }
    }
  });
});

test('ICN-14 (doc 18 §9.3.4) a throwing log sink never changes the answer: the committed register and settlement still answer 201 and 200, and a commit with no exact answer still answers 503 (the lost line leaves the row class 3)', async () => {
  await withChain(async (h) => {
    const registered = await h.send(registerAt, JSON.stringify(registerBody()), randomUUID());
    assert.equal(registered.status, 201, registered.body);
    const settled = await h.send(settleAt, JSON.stringify(settleBody()), randomUUID());
    assert.equal(settled.status, 200, settled.body);
    h.answer('unavailable');
    const stalled = await h.send(issueAt, JSON.stringify(issueBody()), randomUUID());
    assert.deepEqual([stalled.status, JSON.parse(stalled.body).error], [503, 'service_unavailable']);
    assert.equal(h.commits.length, 3, 'every command reached its commit');
    assert.deepEqual(writeLines(h.lines), [], 'the sink lost every credit_note_write line');
  }, { throwingWriteSink: true });
});

test('ICN-13 (doc 18 §6.6) the composition refuses a credit-note writer without its setting or its instance id; routes.ts keeps the write gate to exactly the registration, the issue and the withdrawal', () => {
  const base = {
    readiness: createReadinessState(), log: { log: () => undefined }, events: [], limits: testRequestLimits(),
    idempotency: { store: createMemoryIdempotencyStore(), keySecret: TEST_IDEMPOTENCY_KEY },
    transactions: { port: { commit: () => ({ outcome: 'unavailable' }), probe: () => true } },
    sessions: { tenant: { trustedOrigins: [TENANT_ORIGIN], verifier: { verify: async () => null }, admission: { admit: () => null }, authorizer: { authorize: () => false },
      store: createMemorySessionStore() } as unknown as SessionBoundaryDeps },
  };
  for (const routes of [[INVOICE_CREDIT_NOTE_REGISTER_ROUTE], [INVOICE_CREDIT_NOTE_SETTLE_ROUTE]]) {
    assert.throws(() => createApp({ ...base, routes, instanceId: INSTANCE }), /credit_note_writes_invalid/);
    assert.throws(() => createApp({ ...base, routes, creditNoteWrites: 'paused' as never, instanceId: INSTANCE }), /credit_note_writes_invalid/);
    assert.throws(() => createApp({ ...base, routes, creditNoteWrites: 'off' }), /instance_id_invalid/);
    assert.throws(() => createApp({ ...base, routes, creditNoteWrites: 'off', instanceId: 'host-1' }), /instance_id_invalid/);
    assert.doesNotThrow(() => createApp({ ...base, routes, creditNoteWrites: 'off', instanceId: INSTANCE }));
  }
  assert.deepEqual([INVOICE_CREDIT_NOTE_REGISTER_ROUTE, INVOICE_CREDIT_NOTE_ISSUE_ROUTE, INVOICE_CREDIT_NOTE_SETTLE_ROUTE, INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE]
    .map((r) => defineRoutes([r]).list()[0].writeGate), ['credit_note_write', 'credit_note_write', undefined, 'credit_note_write']);
  for (const [label, def] of [['the registration undeclared', { ...INVOICE_CREDIT_NOTE_REGISTER_ROUTE, writeGate: undefined }],
    ['the withdrawal with another word', { ...INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE, writeGate: 'on' }],
    ['the settlement gated', { ...INVOICE_CREDIT_NOTE_SETTLE_ROUTE, writeGate: 'credit_note_write' }],
    ['a read gated', { ...createInvoiceCreditNotesRoute(portWith({})), writeGate: 'credit_note_write' }]] as const) {
    assert.throws(() => defineRoutes([def as unknown as RouteDefinition]), /route_write_gate_invalid/, label);
  }
});
