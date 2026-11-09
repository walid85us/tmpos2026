// Phase 4.0 M7B-PAYMENTS-P1 — the PostgreSQL side of the payment record and reversal and the payments read, DATABASE-FREE
// (docs/phase-4/15 §12.5): what each routine-audited mutator hands 036's routine (one fixed statement, every value bound,
// bigints as text, the revalidated store, the command's correlation id) and how it reads the one row back — each word, the
// identity and audit-id echo, every malformed or mismatched row a mismatch — then (the reversal) the recent sign-in judged
// again on the database clock; the read adapter's statement, rows and refusals; and the readiness probe. The routines
// themselves are proved against a real cluster by the stage's database suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  INVOICE_PAYMENT_RECORD_MUTATOR, INVOICE_PAYMENT_REGISTER_MUTATOR, INVOICE_PAYMENT_REVERSE_MUTATOR, INVOICE_PAYMENT_SETTLE_MUTATOR,
  createPostgresInvoicePayments, invoicePaymentsAnswerOf, probeInvoicePayments,
} from './postgresInvoicePayments.js';
import { INVOICE_DRAFT_READ_BOUNDS } from './postgresInvoiceDrafts.js';
import { ROUTINE_AUDITED_KINDS, createPostgresTransactionalStore } from './postgresTransactionalStore.js';
import type { MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { INVOICE_PAYMENT_METHODS, INVOICE_PAYMENT_REVERSAL_REASON_CODES } from '../runtime/invoicePayments.js';
import type { TrustedScope } from '../runtime/principals.js';

const MAX = Number.MAX_SAFE_INTEGER;
const KEY = 'k'.repeat(43);
const TENANT = randomUUID();
const STORE = randomUUID();
const ACTOR = randomUUID();
const MEMBERSHIP = randomUUID();
const INVOICE = randomUUID();
const PAYMENT = randomUUID();
const ATTEMPT = randomUUID();
const AUDIT_EVENT = randomUUID();
const CORRELATION = randomUUID();
// M7B-PAYMENTS-P2 (record v2): the registration the record names and a synthetic proof (64 hex digits, never a real MAC).
const REGISTRATION = randomUUID();
const PROOF = 'cd'.repeat(32);
const DEADLINE = 1_800_000_000_000;
const STORE_SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv', scope: 'store', tenant: TENANT, store: STORE, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});

function recorder(...answers: unknown[][]): { sql: PgStatement; texts: string[]; values: unknown[][] } {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    texts.push(strings.join('?'));
    values.push(args);
    return Promise.resolve(answers[Math.min(texts.length - 1, answers.length - 1)]);
  }) as unknown as PgStatement;
  return { sql, texts, values };
}
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const nulls = (columns: readonly string[]) => Object.fromEntries(columns.map((c) => [c, null]));
const authority = (over: Partial<TrustedScope> = {}, extra: Partial<Record<'sessionKey' | 'authNotAfter' | 'correlationId', unknown>> = {}): MutationAuthority =>
  Object.freeze({ context: Object.freeze({ ...STORE_SCOPE, ...over }), sessionKey: KEY, authNotAfter: DEADLINE, correlationId: CORRELATION, ...extra } as MutationAuthority);
const FRESH = [{ fresh: true }];

// --- the record ------------------------------------------------------------------------------------------------------------

const REC_OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_payment_id', 'o_invoice_id', 'o_audit_event_id'];
const recordMutation = (over: Record<string, unknown> = {}, aggregateId: unknown = PAYMENT, expectedVersion: unknown = null): TransactionMutation => Object.freeze({
  kind: 'store.invoice_payment.record', aggregateType: 'invoice_payment', aggregateId: aggregateId as string, expectedVersion: expectedVersion as null,
  changes: Object.freeze({ invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, amountCents: 1250, method: 'cash', registrationId: REGISTRATION,
    registrationProof: PROOF, ...over }),
});
const recorded = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_payment_id: PAYMENT, o_invoice_id: INVOICE,
  o_audit_event_id: AUDIT_EVENT, ...over,
});

test('IPP-01 the record mutator: a routine-audited store-scope CREATE of an invoice_payment declaring the record refusals; ONE fixed call (037\'s record v2, M7B-PAYMENTS-P2) binding the key, the REVALIDATED store, the invoice, the tenant, the payment, the registration, the attempt, the amount as bigint text, the method, the proof and the correlation id; applied only with this identity and an audit id; it never asks the clock', async () => {
  assert.deepEqual([INVOICE_PAYMENT_RECORD_MUTATOR.kind, INVOICE_PAYMENT_RECORD_MUTATOR.mode, INVOICE_PAYMENT_RECORD_MUTATOR.aggregateType, INVOICE_PAYMENT_RECORD_MUTATOR.contextScope,
    INVOICE_PAYMENT_RECORD_MUTATOR.paymentRefusals, INVOICE_PAYMENT_RECORD_MUTATOR.routineAudited, INVOICE_PAYMENT_RECORD_MUTATOR.auditSubjects],
  ['store.invoice_payment.record', 'create', 'invoice_payment', 'store', 'record', true, undefined]);
  assert.deepEqual([INVOICE_PAYMENT_REVERSE_MUTATOR.kind, INVOICE_PAYMENT_REVERSE_MUTATOR.mode, INVOICE_PAYMENT_REVERSE_MUTATOR.aggregateType, INVOICE_PAYMENT_REVERSE_MUTATOR.contextScope,
    INVOICE_PAYMENT_REVERSE_MUTATOR.paymentRefusals, INVOICE_PAYMENT_REVERSE_MUTATOR.routineAudited, INVOICE_PAYMENT_REVERSE_MUTATOR.auditSubjects],
  ['store.invoice_payment.reverse', 'update', 'invoice_payment', 'store', undefined, true, undefined]);
  assert.ok(Object.isFrozen(INVOICE_PAYMENT_RECORD_MUTATOR) && Object.isFrozen(INVOICE_PAYMENT_REVERSE_MUTATOR));
  // M7B-PAYMENTS-P2: the registration and the settlement joined the routine-audited kinds (postgresInvoicePaymentRegistrations.test.ts).
  assert.deepEqual([INVOICE_PAYMENT_RECORD_MUTATOR.kind, INVOICE_PAYMENT_REVERSE_MUTATOR.kind, INVOICE_PAYMENT_REGISTER_MUTATOR.kind, INVOICE_PAYMENT_SETTLE_MUTATOR.kind],
    [...ROUTINE_AUDITED_KINDS], 'exactly the routine-audited kinds');
  // The store builds over both (the mutator table's I2 check).
  const client = { transaction: async () => { throw new Error('unused'); }, end: async () => undefined } as unknown as SupervisedPgClient;
  assert.doesNotThrow(() => createPostgresTransactionalStore({ client, mutators: [INVOICE_PAYMENT_RECORD_MUTATOR, INVOICE_PAYMENT_REVERSE_MUTATOR,
    INVOICE_PAYMENT_REGISTER_MUTATOR, INVOICE_PAYMENT_SETTLE_MUTATOR], contextScope: 'tenant', revalidate: async () => true }));
  const r = recorder([recorded()]);
  assert.equal(await INVOICE_PAYMENT_RECORD_MUTATOR.apply(r.sql, recordMutation(), authority()), 'applied');
  assert.equal(r.texts.length, 1, 'one statement, no clock');
  assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_payment_id, o_invoice_id, o_audit_event_id '
    + 'from tmpos_invoice_payment.m7b_invoice_payment_record_v2(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::text, ?::text, ?::uuid)',
  'the exact statement: 037\'s record v2, never 036\'s nine-argument record');
  assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, TENANT, PAYMENT, REGISTRATION, ATTEMPT, '1250', 'cash', PROOF, CORRELATION]);
  for (const method of INVOICE_PAYMENT_METHODS) {
    for (const amount of [1, MAX]) {
      const each = recorder([recorded()]);
      assert.equal(await INVOICE_PAYMENT_RECORD_MUTATOR.apply(each.sql, recordMutation({ method, amountCents: amount }), authority()), 'applied');
      assert.deepEqual([each.values[0][7], each.values[0][8]], [String(amount), method], `${method} ${amount}: exact text`);
    }
  }
  // Every refusal word: the tenant precondition rolled back, the rest passed through; nothing else names anything.
  for (const [word, answer] of [['tenant_mismatch', 'precondition_failed'], ['not_found', 'not_found'], ['already_recorded', 'already_recorded'],
    ['invalid_state', 'invalid_state'], ['amount_exceeds_remaining', 'amount_exceeds_remaining'], ['refused', 'refused']] as const) {
    const each = recorder([{ o_outcome: word, ...nulls(REC_OUT) }]);
    assert.equal(await INVOICE_PAYMENT_RECORD_MUTATOR.apply(each.sql, recordMutation(), authority()), answer, word);
  }
});

test('IPP-02 every malformed or mismatched record row is mismatch: another tenant, store, actor, grant, payment or invoice; no or a malformed audit id; a refusal naming anything; a word that is not the record\'s; no row or two; a column more or less', async () => {
  const cases: Array<[string, unknown[]]> = [
    ['another tenant', [recorded({ o_tenant_id: randomUUID() })]], ['another store', [recorded({ o_store_id: randomUUID() })]],
    ['another actor', [recorded({ o_actor_id: randomUUID() })]], ['another grant', [recorded({ o_membership_id: randomUUID() })]],
    ['another payment', [recorded({ o_payment_id: randomUUID() })]], ['another invoice', [recorded({ o_invoice_id: randomUUID() })]],
    ['no audit id', [recorded({ o_audit_event_id: null })]], ['an uppercase audit id', [recorded({ o_audit_event_id: AUDIT_EVENT.toUpperCase() })]],
    ['an audit id that is no uuid', [recorded({ o_audit_event_id: 'audit' })]],
    ...REC_OUT.map((c): [string, unknown[]] => [`a refusal naming ${c}`, [{ o_outcome: 'already_recorded', ...nulls(REC_OUT), [c]: PAYMENT }]]),
    ['the void\'s word', [{ o_outcome: 'payments_recorded', ...nulls(REC_OUT) }]], ['conflict (not the record\'s)', [{ o_outcome: 'conflict', ...nulls(REC_OUT) }]],
    ['an unknown word', [{ o_outcome: 'recorded', ...nulls(REC_OUT) }]], ['a null word', [{ o_outcome: null, ...nulls(REC_OUT) }]],
    ['two rows', [recorded(), recorded()]], ['no row', []], ['an extra column', [{ ...recorded(), o_amount_cents: '1250' }]],
    ['a missing column', [Object.fromEntries(Object.entries(recorded()).filter(([k]) => k !== 'o_audit_event_id'))]],
  ];
  for (const [label, rows] of cases) {
    assert.equal(await INVOICE_PAYMENT_RECORD_MUTATOR.apply(recorder(rows).sql, recordMutation(), authority()), 'mismatch', label);
  }
});

test('IPP-03 the record calls nothing without the revalidated store context, its key and a version-4 correlation id, or for a value outside the planner\'s bounds', async () => {
  const cases: Array<[string, TransactionMutation, MutationAuthority | undefined]> = [
    ['no authority', recordMutation(), undefined], ['no key', recordMutation(), authority({}, { sessionKey: null })],
    ['no correlation id', recordMutation(), authority({}, { correlationId: undefined })], ['a correlation id that is not v4', recordMutation(), authority({}, { correlationId: '00000000-0000-1000-8000-000000000000' })],
    ['an uppercase correlation id', recordMutation(), authority({}, { correlationId: CORRELATION.toUpperCase() })],
    ['a blank correlation id', recordMutation(), authority({}, { correlationId: '' })], ['a null correlation id', recordMutation(), authority({}, { correlationId: null })],
    ['a tenant context', recordMutation(), authority({ scope: 'tenant', store: null })], ['a null store', recordMutation(), authority({ store: null })],
    ['a version', recordMutation({}, PAYMENT, 1), authority()], ['a bad payment', recordMutation({}, 'x'), authority()],
    ['a bad invoice', recordMutation({ invoiceId: 'x' }), authority()], ['a bad tenant', recordMutation({ expectedTenant: TENANT.toUpperCase() }), authority()],
    ['a bad attempt', recordMutation({ attemptId: null }), authority()], ['amount 0', recordMutation({ amountCents: 0 }), authority()],
    ['an unsafe amount', recordMutation({ amountCents: MAX + 1 }), authority()], ['an amount as text', recordMutation({ amountCents: '1250' }), authority()],
    ['an unknown method', recordMutation({ method: 'card' }), authority()],
    // M7B-PAYMENTS-P2 (record v2): the registration and the proof exactly as the planner admits them.
    ['no registration', recordMutation({ registrationId: undefined }), authority()], ['a bad registration', recordMutation({ registrationId: REGISTRATION.toUpperCase() }), authority()],
    ['no proof', recordMutation({ registrationProof: undefined }), authority()], ['an uppercase proof', recordMutation({ registrationProof: PROOF.toUpperCase() }), authority()],
    ['a short proof', recordMutation({ registrationProof: PROOF.slice(1) }), authority()], ['a proof as a number', recordMutation({ registrationProof: 7 }), authority()],
  ];
  for (const [label, mutation, auth] of cases) {
    const r = recorder([recorded()]);
    assert.equal(await INVOICE_PAYMENT_RECORD_MUTATOR.apply(r.sql, mutation, auth), 'unavailable', label);
    assert.equal(r.texts.length, 0, `${label}: nothing called`);
  }
});

// --- the reversal ------------------------------------------------------------------------------------------------------------

const REV_OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_payment_id', 'o_audit_event_id'];
const reverseMutation = (over: Record<string, unknown> = {}, expectedVersion: unknown = 1, aggregateId: unknown = PAYMENT): TransactionMutation => Object.freeze({
  kind: 'store.invoice_payment.reverse', aggregateType: 'invoice_payment', aggregateId: aggregateId as string, expectedVersion: expectedVersion as number,
  changes: Object.freeze({ invoiceId: INVOICE, expectedTenant: TENANT, reasonCode: 'duplicate', ...over }),
});
const reversed = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_version: '2', o_payment_id: PAYMENT,
  o_audit_event_id: AUDIT_EVENT, ...over,
});

test('IPP-04 the reversal mutator: ONE fixed call binding the key, the REVALIDATED store, the invoice, the payment, the tenant, the version as bigint text, the reason and the correlation id; applied with this identity, version 2 and an audit id — then the deadline on the database clock (stale: refused); each refusal passed through without the clock', async () => {
  const r = recorder([reversed()], FRESH);
  assert.equal(await INVOICE_PAYMENT_REVERSE_MUTATOR.apply(r.sql, reverseMutation(), authority()), 'applied');
  assert.equal(r.texts.length, 2, 'the routine, then the clock');
  assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_payment_id, o_audit_event_id '
    + 'from tmpos_invoice_payment.m7b_invoice_payment_reverse(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::text, ?::uuid)', 'the exact statement');
  assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, PAYMENT, TENANT, '1', 'duplicate', CORRELATION]);
  assert.equal(squash(r.texts[1]), 'select (pg_catalog.clock_timestamp() <= pg_catalog.to_timestamp(?::bigint / 1000.0)) as fresh');
  assert.deepEqual(r.values[1], [String(DEADLINE)]);
  for (const code of INVOICE_PAYMENT_REVERSAL_REASON_CODES) {
    const each = recorder([reversed()], FRESH);
    assert.equal(await INVOICE_PAYMENT_REVERSE_MUTATOR.apply(each.sql, reverseMutation({ reasonCode: code }), authority()), 'applied', code);
    assert.equal(each.values[0][6], code);
  }
  const stale = recorder([reversed()], [{ fresh: false }]);
  assert.equal(await INVOICE_PAYMENT_REVERSE_MUTATOR.apply(stale.sql, reverseMutation(), authority()), 'refused', 'a sign-in that went stale during the wait');
  await assert.rejects(INVOICE_PAYMENT_REVERSE_MUTATOR.apply(recorder([reversed()], []).sql, reverseMutation(), authority()), /session store unavailable/, 'an unanswerable clock');
  for (const [word, answer] of [['tenant_mismatch', 'precondition_failed'], ['not_found', 'not_found'], ['invalid_state', 'invalid_state'], ['conflict', 'conflict'],
    ['refused', 'refused']] as const) {
    const each = recorder([{ o_outcome: word, ...nulls(REV_OUT) }], [{ fresh: false }]);
    assert.equal(await INVOICE_PAYMENT_REVERSE_MUTATOR.apply(each.sql, reverseMutation(), authority()), answer, word);
    assert.equal(each.texts.length, 1, `${word}: no clock`);
  }
  const mismatches: Array<[string, unknown[]]> = [
    ['another tenant', [reversed({ o_tenant_id: randomUUID() })]], ['another store', [reversed({ o_store_id: randomUUID() })]],
    ['another actor', [reversed({ o_actor_id: randomUUID() })]], ['another grant', [reversed({ o_membership_id: randomUUID() })]],
    ['another payment', [reversed({ o_payment_id: randomUUID() })]], ['version 1', [reversed({ o_version: '1' })]], ['version 3', [reversed({ o_version: '3' })]],
    ['a numeric version', [reversed({ o_version: 2 })]], ['no audit id', [reversed({ o_audit_event_id: null })]],
    ['an uppercase audit id', [reversed({ o_audit_event_id: AUDIT_EVENT.toUpperCase() })]], ['an audit id that is no uuid', [reversed({ o_audit_event_id: 'audit' })]],
    ...REV_OUT.map((c): [string, unknown[]] => [`a refusal naming ${c}`, [{ o_outcome: 'invalid_state', ...nulls(REV_OUT), [c]: c === 'o_version' ? '2' : PAYMENT }]]),
    ['the record\'s word', [{ o_outcome: 'already_recorded', ...nulls(REV_OUT) }]], ['the void\'s word', [{ o_outcome: 'payments_recorded', ...nulls(REV_OUT) }]],
    ['two rows', [reversed(), reversed()]], ['no row', []], ['an extra column', [{ ...reversed(), o_invoice_id: INVOICE }]],
  ];
  for (const [label, rows] of mismatches) {
    const each = recorder(rows, FRESH);
    assert.equal(await INVOICE_PAYMENT_REVERSE_MUTATOR.apply(each.sql, reverseMutation(), authority()), 'mismatch', label);
    assert.equal(each.texts.length, 1, `${label}: no clock`);
  }
  for (const [label, mutation, auth] of [
    ['no deadline', reverseMutation(), authority({}, { authNotAfter: null })], ['a text deadline', reverseMutation(), authority({}, { authNotAfter: String(DEADLINE) })],
    ['no correlation id', reverseMutation(), authority({}, { correlationId: null })], ['no key', reverseMutation(), authority({}, { sessionKey: null })],
    ['an absent correlation id', reverseMutation(), authority({}, { correlationId: undefined })], ['a blank correlation id', reverseMutation(), authority({}, { correlationId: '' })],
    ['version 0', reverseMutation({}, 0), authority()], ['version 2', reverseMutation({}, 2), authority()], ['version 2^53 - 1', reverseMutation({}, MAX), authority()], ['a bad payment', reverseMutation({}, 1, 'x'), authority()],
    ['a bad invoice', reverseMutation({ invoiceId: 'x' }), authority()], ['an unknown reason', reverseMutation({ reasonCode: 'refund' }), authority()],
  ] as const) {
    const each = recorder([reversed()], FRESH);
    assert.equal(await INVOICE_PAYMENT_REVERSE_MUTATOR.apply(each.sql, mutation, auth), 'unavailable', label);
    assert.equal(each.texts.length, 0, `${label}: nothing called`);
  }
});

// --- the read and readiness ----------------------------------------------------------------------------------------------

const HEADER = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_status', 'o_currency', 'o_total_cents', 'o_due_cents', 'o_applied_cents',
  'o_remaining_cents', 'o_payment_status'];
const PAY = ['o_payment_id', 'o_attempt_id', 'o_amount_cents', 'o_method', 'o_recorded_at', 'o_reversed_at', 'o_reason_code'];
const T = (s: number) => `2026-11-07T10:00:${String(s).padStart(2, '0')}.123456Z`;
const header = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'payments', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: INVOICE, o_status: 'issued', o_currency: 'USD', o_total_cents: '1000',
  o_due_cents: '1000', o_applied_cents: '400', o_remaining_cents: '600', o_payment_status: 'recorded_partly', ...over,
});
const row = (n: number, over: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => ({
  ...header(head), o_payment_id: `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, o_attempt_id: ATTEMPT, o_amount_cents: '400', o_method: 'cash',
  o_recorded_at: T(n), o_reversed_at: null, o_reason_code: null, ...over,
});
const empty = (head: Record<string, unknown> = {}) => ({ ...header({ o_applied_cents: '0', o_remaining_cents: '1000', o_payment_status: 'no_payment_recorded', ...head }), ...nulls(PAY) });
const live = (): AbortSignal => new AbortController().signal;

function kernel(answer: (text: string) => unknown) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const bounds: TransactionBounds[] = [];
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <R>(_signal: AbortSignal, b: TransactionBounds, work: (scope: PgTransactionScope) => Promise<R>): Promise<R> => {
      bounds.push(b);
      const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?');
        statements.push({ text, values });
        return Promise.resolve(answer(text));
      }) as unknown as PgTransactionScope;
      return work(sql);
    },
    end: async (): Promise<void> => undefined,
  });
  return { client, statements, bounds };
}

test('IPP-05 the read\'s rows: a page, a reversal and the empty page read through as the runtime\'s answer; each refusal is its one all-null row; every header disagreement, scope or invoice mismatch, malformed value, extra row or word the runtime refuses is a fault', () => {
  const page = invoicePaymentsAnswerOf([row(1), row(2, { o_reversed_at: T(3), o_reason_code: 'wrong_amount', o_method: 'external_card_terminal' })], STORE_SCOPE, INVOICE, null) as Record<string, unknown>;
  assert.deepEqual(page, {
    outcome: 'payments', invoice: { id: INVOICE, status: 'issued' }, currency: 'USD', totalCents: 1000, dueCents: 1000, appliedCents: 400, remainingCents: 600,
    paymentStatus: 'recorded_partly', payments: [
      { id: row(1).o_payment_id, attemptId: ATTEMPT, amountCents: 400, method: 'cash', recordedAt: T(1), reversal: null },
      { id: row(2).o_payment_id, attemptId: ATTEMPT, amountCents: 400, method: 'external_card_terminal', recordedAt: T(2), reversal: { reversedAt: T(3), reasonCode: 'wrong_amount' } },
    ],
  });
  assert.deepEqual((invoicePaymentsAnswerOf([empty()], STORE_SCOPE, INVOICE, null) as { payments: unknown[] }).payments, [], 'the empty page');
  for (const word of ['denied', 'not_found']) {
    assert.deepEqual(invoicePaymentsAnswerOf([{ o_outcome: word, ...nulls([...HEADER.slice(1), ...PAY]) }], STORE_SCOPE, INVOICE, null), { outcome: word });
  }
  assert.deepEqual(invoicePaymentsAnswerOf([{ o_outcome: 'cursor_unknown', ...nulls([...HEADER.slice(1), ...PAY]) }], STORE_SCOPE, INVOICE, randomUUID()), { outcome: 'cursor_unknown' });
  const faults: Array<[string, unknown, string | null]> = [
    ['cursor_unknown on a first page', [{ o_outcome: 'cursor_unknown', ...nulls([...HEADER.slice(1), ...PAY]) }], null],
    ['a refusal naming the tenant', [{ o_outcome: 'denied', ...nulls([...HEADER.slice(1), ...PAY]), o_tenant_id: TENANT }], null],
    ['another tenant', [row(1, {}, { o_tenant_id: randomUUID() })], null], ['another store', [row(1, {}, { o_store_id: randomUUID() })], null],
    ['another invoice', [row(1, {}, { o_invoice_id: randomUUID() })], null], ['headers that differ', [row(1), row(2, {}, { o_applied_cents: '800', o_remaining_cents: '200' })], null],
    ['an amount as a number', [row(1, { o_amount_cents: 400 })], null], ['a padded amount', [row(1, { o_amount_cents: '0400' })], null],
    ['a negative applied', [row(1, {}, { o_applied_cents: '-1' })], null], ['an unsafe total', [row(1, {}, { o_total_cents: '9007199254740992' })], null],
    ['a reversal time without a reason', [row(1, { o_reversed_at: T(3) })], null], ['a null payment id beside a payment', [row(1, { o_payment_id: null })], null],
    ['an empty page beside a payment', [empty(), row(1)], null], ['a word the runtime refuses', [row(1, {}, { o_payment_status: 'recorded_in_full' })], null],
    ['an unknown status', [row(1, {}, { o_status: 'paid' })], null], ['52 rows', Array.from({ length: 52 }, (_, i) => row(i + 1)), null], ['no row', [], null],
    ['an extra column', [{ ...row(1), o_recorded_by: ACTOR }], null], ['a missing column', [Object.fromEntries(Object.entries(row(1)).filter(([k]) => k !== 'o_reason_code'))], null],
    ['not an array', 'rows', null],
  ];
  for (const [label, rows, after] of faults) assert.throws(() => invoicePaymentsAnswerOf(rows, STORE_SCOPE, INVOICE, after), /invoice payments answer invalid/, label);
});

test('IPP-06 the read adapter: one statement in one short read with the drafts\' bounds — the key, the TRUSTED tenant and store, the invoice, the cursor and the ask of 51; refused before a statement otherwise; the probe asks 036\'s read with a random key and is ready only for its one all-null denied row', async () => {
  const k = kernel(() => [row(1)]);
  const port = createPostgresInvoicePayments({ client: k.client });
  assert.ok(Object.isFrozen(port));
  const after = randomUUID();
  await port.payments(STORE_SCOPE, KEY, INVOICE, after, live());
  assert.equal(squash(k.statements[0].text), 'select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_status, o_currency, o_total_cents, o_due_cents, o_applied_cents, '
    + 'o_remaining_cents, o_payment_status, o_payment_id, o_attempt_id, o_amount_cents, o_method, o_recorded_at, o_reversed_at, o_reason_code '
    + 'from tmpos_invoice_payment.m7b_invoice_payments_get(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::integer)');
  assert.deepEqual(k.statements[0].values, [KEY, TENANT, STORE, INVOICE, after, 51]);
  assert.deepEqual(k.bounds, [INVOICE_DRAFT_READ_BOUNDS]);
  await port.payments(STORE_SCOPE, KEY, INVOICE, null, live());
  assert.equal(k.statements[1].values[4], null, 'no cursor: null');
  for (const [label, scope, key, invoice, cursor] of [
    ['a tenant scope', { ...STORE_SCOPE, scope: 'tenant', store: null }, KEY, INVOICE, null], ['no store', { ...STORE_SCOPE, store: null }, KEY, INVOICE, null],
    ['a key of another shape', STORE_SCOPE, 'k', INVOICE, null], ['a bad invoice', STORE_SCOPE, KEY, 'x', null], ['a bad cursor', STORE_SCOPE, KEY, INVOICE, 'x'],
  ] as const) {
    const idle = kernel(() => [row(1)]);
    await assert.rejects(async () => createPostgresInvoicePayments({ client: idle.client }).payments(scope as TrustedScope, key, invoice, cursor, live()), /invoice payments answer invalid/, label);
    assert.equal(idle.statements.length, 0, `${label}: nothing asked`);
  }
  assert.throws(() => createPostgresInvoicePayments({} as never), TypeError);
  const denied = [{ o_outcome: 'denied', ...nulls([...HEADER.slice(1), ...PAY]) }];
  const ready = kernel(() => denied);
  assert.equal(await probeInvoicePayments(ready.client, live()), true);
  assert.equal(ready.statements.length, 1);
  assert.match(ready.statements[0].text, /from tmpos_invoice_payment\.m7b_invoice_payments_get\(/);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(ready.statements[0].values[0] as string), 'a random key of the session-key shape');
  assert.deepEqual(ready.statements[0].values.slice(4), [null, 1]);
  for (const [label, rows] of [['not_found', [{ ...denied[0], o_outcome: 'not_found' }]], ['a page', [row(1)]], ['two rows', [...denied, ...denied]],
    ['a denied row naming the tenant', [{ ...denied[0], o_tenant_id: TENANT }]], ['no row', []]] as const) {
    assert.equal(await probeInvoicePayments(kernel(() => rows).client, live()), false, label);
  }
  assert.equal(await probeInvoicePayments(kernel(() => { throw new Error('down'); }).client, live()), false, 'an outage');
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await probeInvoicePayments(ready.client, aborted.signal), false, 'aborted');
});
