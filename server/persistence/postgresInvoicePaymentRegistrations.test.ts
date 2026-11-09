// Phase 4.0 M7B-PAYMENTS-P2 (PRQ-1, migration 037) — the PostgreSQL side of the payment registration, below the database: the
// registration's and the settlement's routine-audited mutators (one fixed call each, the identity checks, the refusal words),
// the proof and attempts read adapters (the strict row decoders) and the startup key probe. The routines themselves are proved
// against a real cluster by IRR and IRH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  INVOICE_PAYMENT_REGISTER_MUTATOR, INVOICE_PAYMENT_SETTLE_MUTATOR, createPostgresInvoicePaymentRegistrations, invoicePaymentAttemptsAnswerOf,
  probePaymentProofKey, registrationProofAnswerOf,
} from './postgresInvoicePayments.js';
import { INVOICE_DRAFT_READ_BOUNDS } from './postgresInvoiceDrafts.js';
import { createPostgresTransactionalStore } from './postgresTransactionalStore.js';
import type { MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import type { TrustedScope } from '../runtime/principals.js';

const KEY = 'k'.repeat(43);
const TENANT = randomUUID();
const STORE = randomUUID();
const ACTOR = randomUUID();
const MEMBERSHIP = randomUUID();
const INVOICE = randomUUID();
const REGISTRATION = randomUUID();
const ATTEMPT = randomUUID();
const PAYMENT = randomUUID();
const AUDIT_EVENT = randomUUID();
const CORRELATION = randomUUID();
/** A synthetic proof: 64 lowercase hex digits (never a real MAC). */
const PROOF = 'ef'.repeat(32);
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
const authority = (over: Partial<TrustedScope> = {}, extra: Record<string, unknown> = {}): MutationAuthority =>
  ({ context: { ...STORE_SCOPE, ...over }, sessionKey: KEY, authNotAfter: null, correlationId: CORRELATION, ...extra }) as unknown as MutationAuthority;

// --- the registration ---------------------------------------------------------------------------------------------------

const REG_OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_registration_id', 'o_invoice_id', 'o_audit_event_id'];
const registerMutation = (over: Record<string, unknown> = {}, aggregateId: unknown = REGISTRATION, expectedVersion: unknown = null): TransactionMutation => Object.freeze({
  kind: 'store.invoice_payment.register', aggregateType: 'invoice_payment_registration', aggregateId: aggregateId as string, expectedVersion: expectedVersion as null,
  changes: Object.freeze({ invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, ...over }),
});
const registered = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_registration_id: REGISTRATION,
  o_invoice_id: INVOICE, o_audit_event_id: AUDIT_EVENT, ...over,
});

test('IPG-01 the registration mutator: a routine-audited store-scope CREATE declaring the record refusals; ONE fixed call binding the key, the REVALIDATED store, the invoice, the tenant, the registration, the attempt and the correlation id; applied only with this identity and an audit id; every refusal word mapped; anything else mismatch; nothing called outside the planner\'s bounds', async () => {
  assert.deepEqual([INVOICE_PAYMENT_REGISTER_MUTATOR.kind, INVOICE_PAYMENT_REGISTER_MUTATOR.mode, INVOICE_PAYMENT_REGISTER_MUTATOR.aggregateType,
    INVOICE_PAYMENT_REGISTER_MUTATOR.contextScope, INVOICE_PAYMENT_REGISTER_MUTATOR.paymentRefusals, INVOICE_PAYMENT_REGISTER_MUTATOR.routineAudited],
  ['store.invoice_payment.register', 'create', 'invoice_payment_registration', 'store', 'record', true]);
  assert.ok(Object.isFrozen(INVOICE_PAYMENT_REGISTER_MUTATOR));
  const client = { transaction: async () => { throw new Error('unused'); }, end: async () => undefined } as unknown as SupervisedPgClient;
  assert.doesNotThrow(() => createPostgresTransactionalStore({ client, mutators: [INVOICE_PAYMENT_REGISTER_MUTATOR, INVOICE_PAYMENT_SETTLE_MUTATOR], contextScope: 'tenant', revalidate: async () => true }));
  const r = recorder([registered()]);
  assert.equal(await INVOICE_PAYMENT_REGISTER_MUTATOR.apply(r.sql, registerMutation(), authority()), 'applied');
  assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_registration_id, o_invoice_id, o_audit_event_id '
    + 'from tmpos_invoice_payment.m7b_invoice_payment_register(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid)');
  assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, TENANT, REGISTRATION, ATTEMPT, CORRELATION]);
  for (const [word, answer] of [['tenant_mismatch', 'precondition_failed'], ['not_found', 'not_found'], ['already_recorded', 'already_recorded'],
    ['invalid_state', 'invalid_state'], ['conflict', 'conflict'], ['refused', 'refused']] as const) {
    assert.equal(await INVOICE_PAYMENT_REGISTER_MUTATOR.apply(recorder([{ o_outcome: word, ...nulls(REG_OUT) }]).sql, registerMutation(), authority()), answer, word);
  }
  for (const [label, rows] of [
    ['another tenant', [registered({ o_tenant_id: randomUUID() })]], ['another store', [registered({ o_store_id: randomUUID() })]],
    ['another actor', [registered({ o_actor_id: randomUUID() })]], ['another grant', [registered({ o_membership_id: randomUUID() })]],
    ['another registration', [registered({ o_registration_id: randomUUID() })]], ['another invoice', [registered({ o_invoice_id: randomUUID() })]],
    ['no audit id', [registered({ o_audit_event_id: null })]], ['the record\'s word', [{ o_outcome: 'amount_exceeds_remaining', ...nulls(REG_OUT) }]],
    ['a refusal naming a registration', [{ o_outcome: 'conflict', ...nulls(REG_OUT), o_registration_id: REGISTRATION }]],
    ['a proof column', [{ ...registered(), o_proof: PROOF }]], ['two rows', [registered(), registered()]], ['no row', []],
  ] as const) {
    assert.equal(await INVOICE_PAYMENT_REGISTER_MUTATOR.apply(recorder([...rows]).sql, registerMutation(), authority()), 'mismatch', label);
  }
  for (const [label, mutation, auth] of [
    ['no authority', registerMutation(), undefined], ['no key', registerMutation(), authority({}, { sessionKey: null })],
    ['a correlation id that is not v4', registerMutation(), authority({}, { correlationId: '00000000-0000-1000-8000-000000000000' })],
    ['a tenant context', registerMutation(), authority({ scope: 'tenant', store: null })], ['a version', registerMutation({}, REGISTRATION, 1), authority()],
    ['a bad registration', registerMutation({}, 'x'), authority()], ['a bad attempt', registerMutation({ attemptId: null }), authority()],
    ['a bad tenant', registerMutation({ expectedTenant: TENANT.toUpperCase() }), authority()],
  ] as const) {
    const each = recorder([registered()]);
    assert.equal(await INVOICE_PAYMENT_REGISTER_MUTATOR.apply(each.sql, mutation, auth), 'unavailable', label);
    assert.equal(each.texts.length, 0, `${label}: nothing called`);
  }
});

// --- the settlement -----------------------------------------------------------------------------------------------------

const SET_OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id', 'o_audit_event_id'];
const settleMutation = (expectedVersion: unknown = 1, over: Record<string, unknown> = {}, aggregateId: unknown = ATTEMPT): TransactionMutation => Object.freeze({
  kind: 'store.invoice_payment.settle', aggregateType: 'invoice_payment_registration', aggregateId: aggregateId as string, expectedVersion: expectedVersion as number,
  changes: Object.freeze({ invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, ...over }),
});
const settled = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_version: '3', o_invoice_id: INVOICE,
  o_audit_event_id: AUDIT_EVENT, ...over,
});

test('IPG-02 the settlement mutator: a routine-audited store-scope UPDATE of the caller\'s registration of the body\'s attempt at version 1 or 2; ONE fixed call; applied (version 3, an audit id) and unchanged (version 3, no audit id) with this identity; every refusal word mapped; anything else mismatch; never the key bytes', async () => {
  assert.deepEqual([INVOICE_PAYMENT_SETTLE_MUTATOR.kind, INVOICE_PAYMENT_SETTLE_MUTATOR.mode, INVOICE_PAYMENT_SETTLE_MUTATOR.aggregateType,
    INVOICE_PAYMENT_SETTLE_MUTATOR.contextScope, INVOICE_PAYMENT_SETTLE_MUTATOR.paymentRefusals, INVOICE_PAYMENT_SETTLE_MUTATOR.routineAudited],
  ['store.invoice_payment.settle', 'update', 'invoice_payment_registration', 'store', undefined, true]);
  for (const version of [1, 2]) {
    const r = recorder([settled()]);
    assert.equal(await INVOICE_PAYMENT_SETTLE_MUTATOR.apply(r.sql, settleMutation(version), authority()), 'applied', `version ${version}`);
    assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id, o_audit_event_id '
      + 'from tmpos_invoice_payment.m7b_invoice_payment_settle(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::uuid)');
    assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, TENANT, ATTEMPT, String(version), CORRELATION]);
  }
  assert.equal(await INVOICE_PAYMENT_SETTLE_MUTATOR.apply(recorder([settled({ o_outcome: 'unchanged', o_audit_event_id: null })]).sql, settleMutation(2), authority()), 'unchanged');
  for (const [word, answer] of [['tenant_mismatch', 'precondition_failed'], ['not_found', 'not_found'], ['conflict', 'conflict'], ['refused', 'refused']] as const) {
    assert.equal(await INVOICE_PAYMENT_SETTLE_MUTATOR.apply(recorder([{ o_outcome: word, ...nulls(SET_OUT) }]).sql, settleMutation(), authority()), answer, word);
  }
  for (const [label, rows] of [
    ['applied without an audit id', [settled({ o_audit_event_id: null })]], ['unchanged with an audit id', [settled({ o_outcome: 'unchanged' })]],
    ['another version', [settled({ o_version: '2' })]], ['a numeric version', [settled({ o_version: 3 })]], ['another invoice', [settled({ o_invoice_id: randomUUID() })]],
    ['another actor', [settled({ o_actor_id: randomUUID() })]], ['another grant', [settled({ o_membership_id: randomUUID() })]],
    ['invalid_state (not the settlement\'s)', [{ o_outcome: 'invalid_state', ...nulls(SET_OUT) }]],
    ['a refusal naming a version', [{ o_outcome: 'conflict', ...nulls(SET_OUT), o_version: '3' }]], ['no row', []], ['two rows', [settled(), settled()]],
  ] as const) {
    assert.equal(await INVOICE_PAYMENT_SETTLE_MUTATOR.apply(recorder([...rows]).sql, settleMutation(), authority()), 'mismatch', label);
  }
  for (const [label, mutation] of [['version 3', settleMutation(3)], ['version 0', settleMutation(0)], ['no version', settleMutation(null)],
    ['the aggregate is not the attempt', settleMutation(1, {}, randomUUID())], ['a bad invoice', settleMutation(1, { invoiceId: 'x' })],
    ['a bad tenant', settleMutation(1, { expectedTenant: null })]] as const) {
    const each = recorder([settled()]);
    assert.equal(await INVOICE_PAYMENT_SETTLE_MUTATOR.apply(each.sql, mutation, authority()), 'unavailable', label);
    assert.equal(each.texts.length, 0, `${label}: nothing called`);
  }
});

// --- the reads and the key probe ----------------------------------------------------------------------------------------

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
  }) as unknown as SupervisedPgClient;
  return { client, statements, bounds };
}
const PROOF_COLS = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_registration_id', 'o_attempt_id', 'o_proof'];
const proofRow = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'proof', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: INVOICE, o_registration_id: REGISTRATION, o_attempt_id: ATTEMPT, o_proof: PROOF, ...over,
});

test('IPG-03 the proof read: one statement under the drafts\' read bounds binding the key, the TRUSTED store and tenant, the invoice and the registration; the row decoded strictly (each refusal its one all-null row); every fault one bounded message that names no value', async () => {
  const k = kernel(() => [proofRow()]);
  const port = createPostgresInvoicePaymentRegistrations({ client: k.client });
  assert.deepEqual(await port.proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 3000),
    { outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF });
  assert.deepEqual(k.bounds, [INVOICE_DRAFT_READ_BOUNDS]);
  assert.equal(squash(k.statements[0].text), 'select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_registration_id, o_attempt_id, o_proof '
    + 'from tmpos_invoice_payment.m7b_invoice_payment_registration_proof(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::integer)');
  assert.deepEqual(k.statements[0].values, [KEY, STORE, INVOICE, TENANT, REGISTRATION, 1000], 'the full 1000 ms wait under a 3 s deadline');
  for (const word of ['denied', 'not_found', 'not_durable']) {
    assert.deepEqual(registrationProofAnswerOf([{ ...Object.fromEntries(PROOF_COLS.map((c) => [c, null])), o_outcome: word }], STORE_SCOPE, INVOICE, REGISTRATION), { outcome: word });
  }
  for (const [label, rows] of [
    ['another tenant', [proofRow({ o_tenant_id: randomUUID() })]], ['another store', [proofRow({ o_store_id: randomUUID() })]],
    ['another invoice', [proofRow({ o_invoice_id: randomUUID() })]], ['another registration', [proofRow({ o_registration_id: randomUUID() })]],
    ['an uppercase proof', [proofRow({ o_proof: PROOF.toUpperCase() })]], ['a short proof', [proofRow({ o_proof: PROOF.slice(2) })]],
    ['a bad attempt', [proofRow({ o_attempt_id: 'x' })]], ['a refusal naming a proof', [{ ...proofRow({ o_outcome: 'not_found' }) }]],
    ['an unknown word', [proofRow({ o_outcome: 'cursor_unknown' })]], ['two rows', [proofRow(), proofRow()]], ['no row', []],
    ['not_durable naming a value', [{ ...Object.fromEntries(PROOF_COLS.map((c) => [c, null])), o_outcome: 'not_durable', o_attempt_id: ATTEMPT }]],
    ['an extra column', [{ ...proofRow(), o_key: 'x' }]],
  ] as const) {
    assert.throws(() => registrationProofAnswerOf([...rows], STORE_SCOPE, INVOICE, REGISTRATION), (err: Error) => err.message === 'invoice payment registrations answer invalid'
      && !err.message.includes(PROOF), label);
  }
  for (const [label, args] of [['a bad key', [STORE_SCOPE, 'k', INVOICE, REGISTRATION]], ['a tenant scope', [{ ...STORE_SCOPE, scope: 'tenant', store: null }, KEY, INVOICE, REGISTRATION]],
    ['a bad invoice', [STORE_SCOPE, KEY, 'x', REGISTRATION]], ['a bad registration', [STORE_SCOPE, KEY, INVOICE, REGISTRATION.toUpperCase()]]] as const) {
    const each = kernel(() => [proofRow()]);
    const reader = createPostgresInvoicePaymentRegistrations({ client: each.client });
    await assert.rejects(async () => reader.proof(...(args as unknown as [TrustedScope, string, string, string]), live(), 3000), label);
    assert.equal(each.statements.length, 0, `${label}: no statement`);
  }
  for (const deadline of [0, -1, 1.5, Number.NaN, undefined, '3000']) {
    const each = kernel(() => [proofRow()]);
    const reader = createPostgresInvoicePaymentRegistrations({ client: each.client });
    await assert.rejects(async () => reader.proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), deadline as number), (err: Error) => err.message === 'invoice payment registrations answer invalid', `deadline ${String(deadline)}`);
    assert.equal(each.statements.length, 0, `deadline ${String(deadline)}: no statement`);
  }
});

// --- the proof's durability retry (O1) -----------------------------------------------------------------------------------

/** A kernel that records, per transaction, whether its body resolved (COMMIT) or threw (ROLLBACK), and each statement's wait. */
function committing(answers: Array<unknown[] | Error>, holdMs = 0, queueMs = 0) {
  const outcomes: string[] = [];
  const waits: unknown[] = [];
  const begunAfterEnd: boolean[] = [];
  const statements: string[][] = [];
  let open = false;
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <R>(_signal: AbortSignal, _b: TransactionBounds, work: (scope: PgTransactionScope) => Promise<R>): Promise<R> => {
      // queueMs: the pool's queue before the connection is held and BEGIN has run (the body is invoked only after it).
      if (queueMs > 0) await new Promise((resolve) => setTimeout(resolve, queueMs));
      begunAfterEnd.push(!open);
      open = true;
      const mine: string[] = [];
      statements.push(mine);
      const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        mine.push(strings.join('$').replace(/\s+/g, ' ').trim());
        waits.push(values[5]);
        if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
        const next = answers.shift();
        if (next === undefined) throw new Error('no more answers');
        if (next instanceof Error) throw next;
        return next;
      }) as unknown as PgTransactionScope;
      try {
        const result = await work(sql);
        outcomes.push('commit');
        return result;
      } catch (err) {
        outcomes.push('rollback');
        throw err;
      } finally {
        open = false;
      }
    },
    end: async (): Promise<void> => undefined,
  }) as unknown as SupervisedPgClient;
  return { client, outcomes, waits, begunAfterEnd, statements };
}
const notDurable = () => [{ ...Object.fromEntries(PROOF_COLS.map((c) => [c, null])), o_outcome: 'not_durable' }];
const refusal = (word: string) => [{ ...Object.fromEntries(PROOF_COLS.map((c) => [c, null])), o_outcome: word }];
const PROOF_ANSWER = { outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF };

test('IPG-06 (O1) the proof\'s durability retry: not_durable is RETURNED so its transaction COMMITS, then ONE fresh transaction asks again; a second not_durable (or too little time) is one bounded throw after exactly two committed transactions; a raise is never retried; each wait clamped to the remaining deadline', async () => {
  // not_durable -> commit -> a second transaction (begun after the first ended) issues.
  const a = committing([notDurable(), [proofRow()]]);
  assert.deepEqual(await createPostgresInvoicePaymentRegistrations({ client: a.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 3000), PROOF_ANSWER);
  assert.deepEqual(a.outcomes, ['commit', 'commit'], 'the not_durable transaction committed; the second committed');
  assert.deepEqual(a.begunAfterEnd, [true, true], 'the second began only after the first had ended');
  // Each transaction ran the proof select and nothing else: no session write, no other statement, on either attempt.
  const PROOF_SELECT = 'select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_registration_id, o_attempt_id, o_proof '
    + 'from tmpos_invoice_payment.m7b_invoice_payment_registration_proof($::text, $::uuid, $::uuid, $::uuid, $::uuid, $::integer)';
  assert.deepEqual(a.statements, [[PROOF_SELECT], [PROOF_SELECT]], 'one proof select per transaction');
  assert.equal(a.waits[0], 1000);
  assert.ok(typeof a.waits[1] === 'number' && a.waits[1] === 1000, `the second's wait clamped to the remaining budget: ${String(a.waits[1])}`);

  // not_durable twice -> exactly two committed transactions, then the fixed bounded throw (never the routine's text).
  const b = committing([notDurable(), notDurable(), [proofRow()]]);
  await assert.rejects(async () => createPostgresInvoicePaymentRegistrations({ client: b.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 3000),
    (err: Error) => err.message === 'invoice payment registration proof not yet durable');
  assert.deepEqual(b.outcomes, ['commit', 'commit'], 'exactly two transactions, both committed — never a third');
  assert.deepEqual(b.statements, [[PROOF_SELECT], [PROOF_SELECT]], 'one proof select per transaction');

  // The second attempt's refusals are answered as they come.
  for (const word of ['denied', 'not_found']) {
    const c = committing([notDurable(), refusal(word)]);
    assert.deepEqual(await createPostgresInvoicePaymentRegistrations({ client: c.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 3000), { outcome: word }, word);
    assert.deepEqual(c.outcomes, ['commit', 'commit'], word);
  }

  // A raise (037's 55000: no key, fsync off, layout, isolation) rolls back and is never retried.
  const d = committing([Object.assign(new Error('migration 037 proof: the payment proof key is not installed'), { code: '55000' }), [proofRow()]]);
  await assert.rejects(async () => createPostgresInvoicePaymentRegistrations({ client: d.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 3000), /not installed/);
  assert.deepEqual(d.outcomes, ['rollback'], 'one transaction, rolled back, no retry');
  // A malformed second answer is the fault, after the committed first.
  const e = committing([notDurable(), [proofRow({ o_proof: 'x' })]]);
  await assert.rejects(async () => createPostgresInvoicePaymentRegistrations({ client: e.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 3000), /answer invalid/);
  assert.deepEqual(e.outcomes, ['commit', 'rollback']);

  // A small deadline: the wait is clamped to it (less the reserve), and no time is left for a second attempt.
  const f = committing([notDurable(), [proofRow()]], 200);
  const started = Date.now();
  await assert.rejects(async () => createPostgresInvoicePaymentRegistrations({ client: f.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 400),
    (err: Error) => err.message === 'invoice payment registration proof not yet durable');
  assert.deepEqual(f.outcomes, ['commit'], 'one attempt only');
  assert.ok(typeof f.waits[0] === 'number' && f.waits[0] <= 150 && f.waits[0] >= 100, `the wait clamped to 400 - 250 ms: ${String(f.waits[0])}`);
  assert.ok(Date.now() - started < 400, 'settled within the deadline');
  // A deadline at or below the reserve still asks once, with no wait (the strict comparison alone).
  const g = committing([notDurable(), [proofRow()]]);
  await assert.rejects(async () => createPostgresInvoicePaymentRegistrations({ client: g.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 200), /not yet durable/);
  assert.deepEqual([g.outcomes, g.waits], [['commit'], [0]]);
  // The second attempt's wait is the remaining budget less the reserve when that is below 1000 ms.
  const h = committing([notDurable(), [proofRow()]], 200);
  assert.deepEqual(await createPostgresInvoicePaymentRegistrations({ client: h.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 1000), PROOF_ANSWER);
  assert.ok(typeof h.waits[0] === 'number' && h.waits[0] <= 750 && h.waits[0] >= 700, `first: ${String(h.waits[0])}`);
  assert.ok(typeof h.waits[1] === 'number' && h.waits[1] <= 550 && h.waits[1] >= 480, `second clamped to what remains: ${String(h.waits[1])}`);

  // The wait is measured inside the transaction: time spent queueing for a pooled connection is subtracted from it.
  const q = committing([notDurable(), [proofRow()]], 0, 300);
  assert.deepEqual(await createPostgresInvoicePaymentRegistrations({ client: q.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 1000), PROOF_ANSWER);
  assert.deepEqual(q.outcomes, ['commit', 'commit']);
  assert.ok(typeof q.waits[0] === 'number' && q.waits[0] <= 450 && q.waits[0] >= 380, `first less the 300 ms queue: ${String(q.waits[0])}`);
  assert.ok(typeof q.waits[1] === 'number' && q.waits[1] <= 150 && q.waits[1] >= 60, `second less both queues: ${String(q.waits[1])}`);
  // A queue that eats the budget leaves no wait (the strict comparison alone) and no second attempt.
  const z = committing([notDurable(), [proofRow()]], 0, 300);
  await assert.rejects(async () => createPostgresInvoicePaymentRegistrations({ client: z.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 500), /not yet durable/);
  assert.deepEqual([z.outcomes, z.waits], [['commit'], [0]]);

  // A first answer other than not_durable is final: exactly one transaction, never a second.
  for (const [label, first, expected] of [
    ['denied', refusal('denied'), { outcome: 'denied' }],
    ['not_found', refusal('not_found'), { outcome: 'not_found' }],
    ['proof', [proofRow()], PROOF_ANSWER],
  ] as const) {
    const one = committing([first as unknown[], [proofRow()]]);
    assert.deepEqual(await createPostgresInvoicePaymentRegistrations({ client: one.client }).proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, live(), 3000), expected, label);
    assert.deepEqual([one.outcomes, one.statements], [['commit'], [[PROOF_SELECT]]], `${label}: one transaction, the proof select alone`);
  }
});

const ATT_COLS = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_invoice_number', 'o_attempt_id', 'o_state', 'o_version', 'o_registered_at',
  'o_settled_at', 'o_payment_id', 'o_amount_cents', 'o_method', 'o_recorded_at', 'o_reversed_at', 'o_reason_code'];
const T = (s: number) => `2026-11-09T10:00:${String(s).padStart(2, '0')}.123456Z`;
const attRow = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'attempt', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: INVOICE, o_invoice_number: '7', o_attempt_id: ATTEMPT, o_state: 'open', o_version: '1',
  o_registered_at: T(1), o_settled_at: null, o_payment_id: null, o_amount_cents: null, o_method: null, o_recorded_at: null, o_reversed_at: null, o_reason_code: null, ...over,
});

test('IPG-04 the attempts read: one statement binding the key, the TRUSTED store and tenant, the cursor pair (or two NULLs) and the ask of 51; no row is the empty page; each row decoded strictly (bigint text exact) and the runtime decoder must accept the page; each refusal its one all-null row', async () => {
  const recorded = attRow({ o_invoice_id: randomUUID(), o_state: 'recorded', o_version: '2', o_registered_at: T(2), o_payment_id: PAYMENT, o_amount_cents: '1250',
    o_method: 'cash', o_recorded_at: T(3) });
  const k = kernel(() => [attRow(), recorded]);
  const port = createPostgresInvoicePaymentRegistrations({ client: k.client });
  const answer = await port.attempts(STORE_SCOPE, KEY, null, live()) as { outcome: string; attempts: Array<Record<string, unknown>> };
  assert.equal(answer.outcome, 'attempts');
  assert.deepEqual(answer.attempts[0], { invoiceId: INVOICE, invoiceNumber: 7, attemptId: ATTEMPT, state: 'open', version: 1, registeredAt: T(1), settledAt: null, payment: null });
  assert.deepEqual(answer.attempts[1].payment, { id: PAYMENT, amountCents: 1250, method: 'cash', recordedAt: T(3), reversal: null });
  assert.equal(squash(k.statements[0].text), 'select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_invoice_number, o_attempt_id, o_state, o_version, o_registered_at, '
    + 'o_settled_at, o_payment_id, o_amount_cents, o_method, o_recorded_at, o_reversed_at, o_reason_code '
    + 'from tmpos_invoice_payment.m7b_invoice_payment_attempts(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::integer)');
  assert.deepEqual(k.statements[0].values, [KEY, STORE, TENANT, null, null, 51]);
  const after = { invoiceId: INVOICE, attemptId: randomUUID() };
  const c = kernel(() => []);
  assert.deepEqual(await createPostgresInvoicePaymentRegistrations({ client: c.client }).attempts(STORE_SCOPE, KEY, after, live()), { outcome: 'attempts', attempts: [] }, 'no row: the empty page');
  assert.deepEqual(c.statements[0].values.slice(3), [after.invoiceId, after.attemptId, 51]);
  for (const [word, cursor] of [['denied', null], ['cursor_unknown', after]] as const) {
    assert.deepEqual(invoicePaymentAttemptsAnswerOf([{ ...Object.fromEntries(ATT_COLS.map((col) => [col, null])), o_outcome: word }], STORE_SCOPE, cursor), { outcome: word });
  }
  for (const [label, rows, cursor] of [
    ['cursor_unknown without a cursor', [{ ...Object.fromEntries(ATT_COLS.map((col) => [col, null])), o_outcome: 'cursor_unknown' }], null],
    ['another tenant', [attRow({ o_tenant_id: randomUUID() })], null], ['another store', [attRow({ o_store_id: randomUUID() })], null],
    ['an open row with a payment column', [attRow({ o_amount_cents: '1' })], null], ['an inexact number', [attRow({ o_invoice_number: '07' })], null],
    ['a numeric version', [attRow({ o_version: 1 })], null], ['open at version 2', [attRow({ o_version: '2' })], null],
    ['a reversal time without a reason', [{ ...recorded, o_reversed_at: T(4) }], null], ['out of order', [recorded, attRow()], null],
    ['a registration id column', [{ ...attRow(), o_registration_id: REGISTRATION }], null], ['a refusal among rows', [attRow(), { ...attRow(), o_outcome: 'denied' }], null],
    ['too many', Array.from({ length: 52 }, (_, i) => attRow({ o_attempt_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })), null],
  ] as const) {
    assert.throws(() => invoicePaymentAttemptsAnswerOf([...rows], STORE_SCOPE, cursor), /invoice payment registrations answer invalid/, label);
  }
});

test('IPG-05 the startup key probe: one statement under the read bounds; present only with a positive generation as exact text, absent only with false and NULL; anything else a throw — never the key bytes', async () => {
  const k = kernel(() => [{ o_present: true, o_generation: '3' }]);
  assert.equal(await probePaymentProofKey(k.client, live()), 'present');
  assert.equal(squash(k.statements[0].text), 'select o_present, o_generation from tmpos_invoice_payment.m7b_payment_proof_key_probe()');
  assert.deepEqual([k.statements[0].values, k.bounds], [[], [INVOICE_DRAFT_READ_BOUNDS]]);
  assert.equal(await probePaymentProofKey(kernel(() => [{ o_present: false, o_generation: null }]).client, live()), 'absent');
  for (const [label, rows] of [['present without a generation', [{ o_present: true, o_generation: null }]], ['generation 0', [{ o_present: true, o_generation: '0' }]],
    ['a numeric generation', [{ o_present: true, o_generation: 3 }]], ['absent with a generation', [{ o_present: false, o_generation: '1' }]],
    ['a key column', [{ o_present: true, o_generation: '1', o_key: 'x' }]], ['no row', []], ['two rows', [{ o_present: false, o_generation: null }, { o_present: false, o_generation: null }]],
    ['a text flag', [{ o_present: 'true', o_generation: '1' }]]] as const) {
    await assert.rejects(probePaymentProofKey(kernel(() => [...rows]).client, live()), /payment proof key probe malformed/, label);
  }
});
