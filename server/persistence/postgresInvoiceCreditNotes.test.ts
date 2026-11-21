// Phase 4.0 M7B-CREDITNOTES-P1 (doc 16, migration 038) — the PostgreSQL side of credit notes, below the database: the four
// routine-audited mutators (one fixed call each, the identity checks, the refusal words, the recent sign-in judged again on the
// database clock for the sensitive three), the proof, attempts and list read adapters (the strict row decoders, the names only
// when visible) and the proof's commit-and-retry-once rule. The routines themselves are proved against a real cluster by the
// DB and HTTP suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  INVOICE_CREDIT_NOTE_ISSUE_MUTATOR, INVOICE_CREDIT_NOTE_REGISTER_MUTATOR, INVOICE_CREDIT_NOTE_SETTLE_MUTATOR, INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR,
  createPostgresInvoiceCreditNotes, creditNoteAttemptsAnswerOf, creditNoteProofAnswerOf, creditNotesListAnswerOf, storeCreditActivityAnswerOf,
} from './postgresInvoiceCreditNotes.js';
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
const CREDIT_NOTE = randomUUID();
const AUDIT_EVENT = randomUUID();
const CORRELATION = randomUUID();
/** A synthetic proof: 64 lowercase hex digits (never a real MAC). */
const PROOF = '9a'.repeat(32);
const DEADLINE = Date.now() + 600_000;
const STORE_SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv', scope: 'store', tenant: TENANT, store: STORE, membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
});
const FRESH = [{ fresh: true }];
const STALE = [{ fresh: false }];

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
  ({ context: { ...STORE_SCOPE, ...over }, sessionKey: KEY, authNotAfter: DEADLINE, correlationId: CORRELATION, ...extra }) as unknown as MutationAuthority;
const mutation = (kind: string, aggregateType: string, aggregateId: unknown, expectedVersion: unknown, changes: Record<string, unknown>): TransactionMutation =>
  Object.freeze({ kind, aggregateType, aggregateId: aggregateId as string, expectedVersion: expectedVersion as null, changes: Object.freeze(changes) }) as unknown as TransactionMutation;

const WRITER_OUT = (aggregate: string) => ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', aggregate, 'o_invoice_id', 'o_audit_event_id'];
const applied = (aggregate: string, id: string, over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, [aggregate]: id, o_invoice_id: INVOICE,
  o_audit_event_id: AUDIT_EVENT, ...over,
});

test('ICP-01 the four mutators: routine-audited store-scope commands, the registration and issue declaring the credit refusals; a tenant store builds with all four', () => {
  assert.deepEqual([INVOICE_CREDIT_NOTE_REGISTER_MUTATOR, INVOICE_CREDIT_NOTE_ISSUE_MUTATOR, INVOICE_CREDIT_NOTE_SETTLE_MUTATOR, INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR]
    .map((m) => [m.kind, m.mode, m.aggregateType, m.contextScope, m.paymentRefusals, m.routineAudited, Object.isFrozen(m)]), [
    ['store.invoice_credit_note.register', 'create', 'invoice_credit_note_registration', 'store', 'credit', true, true],
    ['store.invoice_credit_note.issue', 'create', 'invoice_credit_note', 'store', 'credit', true, true],
    ['store.invoice_credit_note.settle', 'update', 'invoice_credit_note_registration', 'store', undefined, true, true],
    ['store.invoice_credit_note.withdraw', 'update', 'invoice_credit_note', 'store', undefined, true, true],
  ]);
  const client = { transaction: async () => { throw new Error('unused'); }, end: async () => undefined } as unknown as SupervisedPgClient;
  assert.doesNotThrow(() => createPostgresTransactionalStore({ client, mutators: [INVOICE_CREDIT_NOTE_REGISTER_MUTATOR, INVOICE_CREDIT_NOTE_ISSUE_MUTATOR,
    INVOICE_CREDIT_NOTE_SETTLE_MUTATOR, INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR], contextScope: 'tenant', revalidate: async () => true }));
  // routineAudited is the closed list's alone: the same kind without it refuses to build.
  const { routineAudited: _dropped, ...unaudited } = INVOICE_CREDIT_NOTE_ISSUE_MUTATOR;
  assert.throws(() => createPostgresTransactionalStore({ client, mutators: [unaudited as never], contextScope: 'tenant', revalidate: async () => true }));
});

test('ICP-02 the registration and the issue: ONE fixed call each, every value bound; applied only with this identity and an audit id and a sign-in still fresh on the database clock; every refusal word mapped; anything else mismatch', async () => {
  const REG_OUT = WRITER_OUT('o_registration_id');
  const regMutation = (over: Record<string, unknown> = {}, id: unknown = REGISTRATION, version: unknown = null) => mutation('store.invoice_credit_note.register',
    'invoice_credit_note_registration', id, version, { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, grossCents: 2000, reason: 'goodwill', ...over });
  let r = recorder([applied('o_registration_id', REGISTRATION)], FRESH);
  assert.equal(await INVOICE_CREDIT_NOTE_REGISTER_MUTATOR.apply(r.sql, regMutation(), authority()), 'applied');
  assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_registration_id, o_invoice_id, o_audit_event_id '
    + 'from tmpos_invoice_credit_note.m7b_invoice_credit_note_register(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::text, ?::uuid)');
  assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, TENANT, REGISTRATION, ATTEMPT, '2000', 'goodwill', CORRELATION]);
  assert.match(r.texts[1], /clock_timestamp/, 'the deadline judged again on the database clock');
  assert.equal(await INVOICE_CREDIT_NOTE_REGISTER_MUTATOR.apply(recorder([applied('o_registration_id', REGISTRATION)], STALE).sql, regMutation(), authority()), 'refused');
  for (const [word, answer] of [['tenant_mismatch', 'precondition_failed'], ['not_found', 'not_found'], ['already_issued', 'already_issued'],
    ['invalid_state', 'invalid_state'], ['conflict', 'conflict'], ['refused', 'refused'], ['amount_exceeds_remaining', 'mismatch'], ['already_recorded', 'mismatch']] as const) {
    const each = recorder([{ o_outcome: word, ...nulls(REG_OUT) }]);
    assert.equal(await INVOICE_CREDIT_NOTE_REGISTER_MUTATOR.apply(each.sql, regMutation(), authority()), answer, word);
    assert.equal(each.texts.length, 1, `${word}: a refusal asks no clock`);
  }

  const ISS_OUT = WRITER_OUT('o_credit_note_id');
  const issMutation = (over: Record<string, unknown> = {}, id: unknown = CREDIT_NOTE, version: unknown = null) => mutation('store.invoice_credit_note.issue',
    'invoice_credit_note', id, version, { invoiceId: INVOICE, expectedTenant: TENANT, registrationId: REGISTRATION, attemptId: ATTEMPT, grossCents: 2000,
      reason: 'goodwill', registrationProof: PROOF, ...over });
  r = recorder([applied('o_credit_note_id', CREDIT_NOTE)], FRESH);
  assert.equal(await INVOICE_CREDIT_NOTE_ISSUE_MUTATOR.apply(r.sql, issMutation(), authority()), 'applied');
  assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_credit_note_id, o_invoice_id, o_audit_event_id '
    + 'from tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::text, ?::text, ?::uuid)');
  assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, TENANT, CREDIT_NOTE, REGISTRATION, ATTEMPT, '2000', 'goodwill', PROOF, CORRELATION]);
  for (const word of ['not_found', 'already_issued', 'invalid_state', 'conflict', 'amount_exceeds_remaining', 'refused']) {
    assert.equal(await INVOICE_CREDIT_NOTE_ISSUE_MUTATOR.apply(recorder([{ o_outcome: word, ...nulls(ISS_OUT) }]).sql, issMutation(), authority()), word, word);
  }
  for (const [label, rows] of [
    ['another tenant', [applied('o_credit_note_id', CREDIT_NOTE, { o_tenant_id: randomUUID() })]],
    ['another store', [applied('o_credit_note_id', CREDIT_NOTE, { o_store_id: randomUUID() })]],
    ['another actor', [applied('o_credit_note_id', CREDIT_NOTE, { o_actor_id: randomUUID() })]],
    ['another grant', [applied('o_credit_note_id', CREDIT_NOTE, { o_membership_id: randomUUID() })]],
    ['another credit note', [applied('o_credit_note_id', randomUUID())]], ['another invoice', [applied('o_credit_note_id', CREDIT_NOTE, { o_invoice_id: randomUUID() })]],
    ['no audit id', [applied('o_credit_note_id', CREDIT_NOTE, { o_audit_event_id: null })]],
    ['a refusal naming a credit note', [{ o_outcome: 'conflict', ...nulls(ISS_OUT), o_credit_note_id: CREDIT_NOTE }]],
    ['a number column', [{ ...applied('o_credit_note_id', CREDIT_NOTE), o_credit_note_number: '1' }]], ['two rows', [applied('o_credit_note_id', CREDIT_NOTE), applied('o_credit_note_id', CREDIT_NOTE)]],
    ['no row', []], ['an unknown word', [{ o_outcome: 'payments_recorded', ...nulls(ISS_OUT) }]],
  ] as const) {
    assert.equal(await INVOICE_CREDIT_NOTE_ISSUE_MUTATOR.apply(recorder([...rows], FRESH).sql, issMutation(), authority()), 'mismatch', label);
  }
  for (const [label, m, auth] of [
    ['no authority', issMutation(), undefined], ['no deadline (sensitive)', issMutation(), authority({}, { authNotAfter: null })],
    ['no key', issMutation(), authority({}, { sessionKey: null })], ['a correlation id that is not v4', issMutation(), authority({}, { correlationId: '00000000-0000-1000-8000-000000000000' })],
    ['a tenant context', issMutation(), authority({ scope: 'tenant', store: null })], ['a version', issMutation({}, CREDIT_NOTE, 1), authority()],
    ['a zero amount', issMutation({ grossCents: 0 }), authority()], ['an unknown reason', issMutation({ reason: 'refund' }), authority()],
    ['a bad proof', issMutation({ registrationProof: PROOF.toUpperCase() }), authority()], ['no registration', issMutation({ registrationId: null }), authority()],
  ] as const) {
    const each = recorder([applied('o_credit_note_id', CREDIT_NOTE)], FRESH);
    assert.equal(await INVOICE_CREDIT_NOTE_ISSUE_MUTATOR.apply(each.sql, m, auth), 'unavailable', label);
    assert.equal(each.texts.length, 0, `${label}: nothing called`);
  }
  assert.equal(await INVOICE_CREDIT_NOTE_REGISTER_MUTATOR.apply(recorder([]).sql, regMutation({}, REGISTRATION, null), authority({}, { authNotAfter: null })), 'unavailable');
});

test('ICP-03 the settlement and the withdrawal: the fixed calls; settlement applied and unchanged at version 3 with and without an audit id; the withdrawal pinned at version 1, applied only while the sign-in is fresh', async () => {
  const SET_OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id', 'o_audit_event_id'];
  const setMutation = (version: unknown = 1, over: Record<string, unknown> = {}, id: unknown = ATTEMPT) => mutation('store.invoice_credit_note.settle',
    'invoice_credit_note_registration', id, version, { invoiceId: INVOICE, expectedTenant: TENANT, attemptId: ATTEMPT, ...over });
  const settled = (over: Record<string, unknown> = {}) => ({ o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR,
    o_membership_id: MEMBERSHIP, o_version: '3', o_invoice_id: INVOICE, o_audit_event_id: AUDIT_EVENT, ...over });
  const noDeadline = authority({}, { authNotAfter: null });
  const r = recorder([settled()]);
  assert.equal(await INVOICE_CREDIT_NOTE_SETTLE_MUTATOR.apply(r.sql, setMutation(2), noDeadline), 'applied');
  assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id, o_audit_event_id '
    + 'from tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::uuid)');
  assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, TENANT, ATTEMPT, '2', CORRELATION]);
  assert.equal(r.texts.length, 1, 'the settlement asks no clock');
  assert.equal(await INVOICE_CREDIT_NOTE_SETTLE_MUTATOR.apply(recorder([settled({ o_outcome: 'unchanged', o_audit_event_id: null })]).sql, setMutation(), noDeadline), 'unchanged');
  for (const [label, row] of [['unchanged with an audit id', settled({ o_outcome: 'unchanged' })], ['applied without one', settled({ o_audit_event_id: null })],
    ['version 2', settled({ o_version: '2' })], ['another invoice', settled({ o_invoice_id: randomUUID() })]] as const) {
    assert.equal(await INVOICE_CREDIT_NOTE_SETTLE_MUTATOR.apply(recorder([row]).sql, setMutation(), noDeadline), 'mismatch', label);
  }
  for (const [word, answer] of [['tenant_mismatch', 'precondition_failed'], ['not_found', 'not_found'], ['conflict', 'conflict'], ['refused', 'refused'], ['invalid_state', 'mismatch']] as const) {
    assert.equal(await INVOICE_CREDIT_NOTE_SETTLE_MUTATOR.apply(recorder([{ o_outcome: word, ...nulls(SET_OUT) }]).sql, setMutation(), noDeadline), answer, word);
  }
  for (const m of [setMutation(3), setMutation(1, {}, randomUUID()), setMutation(1, { expectedTenant: 'x' })]) {
    assert.equal(await INVOICE_CREDIT_NOTE_SETTLE_MUTATOR.apply(recorder([settled()]).sql, m, noDeadline), 'unavailable');
  }

  const WD_OUT = WRITER_OUT('o_credit_note_id');
  const wdMutation = (version: unknown = 1, over: Record<string, unknown> = {}) => mutation('store.invoice_credit_note.withdraw', 'invoice_credit_note', CREDIT_NOTE,
    version, { invoiceId: INVOICE, expectedTenant: TENANT, reason: 'wrong_amount', ...over });
  const w = recorder([applied('o_credit_note_id', CREDIT_NOTE)], FRESH);
  assert.equal(await INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR.apply(w.sql, wdMutation(), authority()), 'applied');
  assert.equal(squash(w.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_credit_note_id, o_invoice_id, o_audit_event_id '
    + 'from tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::text, ?::uuid)');
  assert.deepEqual(w.values[0], [KEY, STORE, INVOICE, TENANT, CREDIT_NOTE, '1', 'wrong_amount', CORRELATION]);
  assert.equal(await INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR.apply(recorder([applied('o_credit_note_id', CREDIT_NOTE)], STALE).sql, wdMutation(), authority()), 'refused');
  for (const word of ['not_found', 'invalid_state', 'conflict', 'refused']) {
    assert.equal(await INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR.apply(recorder([{ o_outcome: word, ...nulls(WD_OUT) }]).sql, wdMutation(), authority()), word, word);
  }
  for (const [m, auth] of [[wdMutation(2), authority()], [wdMutation(1, { reason: 'goodwill' }), authority()], [wdMutation(), noDeadline]] as const) {
    const each = recorder([applied('o_credit_note_id', CREDIT_NOTE)], FRESH);
    assert.equal(await INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR.apply(each.sql, m, auth), 'unavailable');
    assert.equal(each.texts.length, 0);
  }
});

// --- the reads ---------------------------------------------------------------------------------------------------------

const PROOF_COLUMNS = ['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_registration_id', 'o_attempt_id', 'o_proof'];
const proofRow = (over: Record<string, unknown> = {}) => ({ o_outcome: 'proof', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: INVOICE,
  o_registration_id: REGISTRATION, o_attempt_id: ATTEMPT, o_proof: PROOF, ...over });
const ATTEMPT_COLUMNS = ['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_invoice_number', 'o_attempt_id', 'o_state', 'o_version', 'o_registered_at', 'o_settled_at',
  'o_gross_cents', 'o_reason_code', 'o_credit_note_id', 'o_issued_at', 'o_withdrawn_at'];
const TIME = (n: number) => `2026-11-15T10:00:${String(n).padStart(2, '0')}.000000Z`;
const attemptRow = (over: Record<string, unknown> = {}) => ({ o_outcome: 'attempt', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: INVOICE,
  o_invoice_number: '7', o_attempt_id: ATTEMPT, o_state: 'open', o_version: '1', o_registered_at: TIME(1), o_settled_at: null, o_gross_cents: '2000',
  o_reason_code: 'billing_error', o_credit_note_id: null, o_issued_at: null, o_withdrawn_at: null, ...over });
const LIST_NOTE = ['o_credit_note_id', 'o_credit_note_number', 'o_gross_cents', 'o_tax_cents', 'o_net_cents', 'o_reason_code', 'o_issued_at', 'o_issued_by_name',
  'o_withdrawn_at', 'o_withdrawal_reason_code', 'o_withdrawn_by_name'];
const LIST_ALL = ['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_names_visible', ...LIST_NOTE];
const listRow = (visible: boolean, over: Record<string, unknown> = {}) => ({ o_outcome: 'credit_notes', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: INVOICE,
  o_names_visible: visible, o_credit_note_id: CREDIT_NOTE, o_credit_note_number: '1', o_gross_cents: '1100', o_tax_cents: '100', o_net_cents: '1000',
  o_reason_code: 'pricing_error', o_issued_at: TIME(2), o_issued_by_name: null, o_withdrawn_at: null, o_withdrawal_reason_code: null, o_withdrawn_by_name: null, ...over });

test('ICP-04 the row decoders: the proof echoes this scope; the attempts carry their credit note; the list names only when visible, the empty page, the refusals, and every fault one bounded message', () => {
  assert.deepEqual(creditNoteProofAnswerOf([proofRow()], STORE_SCOPE, INVOICE, REGISTRATION),
    { outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF });
  for (const word of ['denied', 'not_found']) assert.deepEqual(creditNoteProofAnswerOf([{ o_outcome: word, ...nulls(PROOF_COLUMNS) }], STORE_SCOPE, INVOICE, REGISTRATION), { outcome: word });
  for (const rows of [[proofRow({ o_store_id: randomUUID() })], [proofRow({ o_registration_id: randomUUID() })], [proofRow({ o_proof: 'x' })],
    [{ o_outcome: 'refused', ...nulls(PROOF_COLUMNS) }], [{ o_outcome: 'denied', ...nulls(PROOF_COLUMNS), o_proof: PROOF }], [], [proofRow(), proofRow()]]) {
    assert.throws(() => creditNoteProofAnswerOf(rows, STORE_SCOPE, INVOICE, REGISTRATION), /^Error: invoice credit notes answer invalid$/);
  }

  assert.deepEqual(creditNoteAttemptsAnswerOf([attemptRow()], STORE_SCOPE, null), { outcome: 'attempts', attempts: [{ invoiceId: INVOICE, invoiceNumber: 7,
    attemptId: ATTEMPT, state: 'open', version: 1, registeredAt: TIME(1), settledAt: null, grossCents: 2000, reason: 'billing_error', creditNote: null }] });
  const issued = creditNoteAttemptsAnswerOf([attemptRow({ o_state: 'confirmed', o_version: '3', o_settled_at: TIME(4), o_credit_note_id: CREDIT_NOTE, o_issued_at: TIME(2),
    o_withdrawn_at: TIME(3) })], STORE_SCOPE, null) as { attempts: { creditNote: unknown }[] };
  assert.deepEqual(issued.attempts[0].creditNote, { id: CREDIT_NOTE, issuedAt: TIME(2), withdrawnAt: TIME(3) });
  assert.deepEqual(creditNoteAttemptsAnswerOf([], STORE_SCOPE, null), { outcome: 'attempts', attempts: [] });
  assert.deepEqual(creditNoteAttemptsAnswerOf([{ o_outcome: 'denied', ...nulls(ATTEMPT_COLUMNS) }], STORE_SCOPE, null), { outcome: 'denied' });
  for (const [label, rows, after] of [
    ['cursor_unknown without a cursor', [{ o_outcome: 'cursor_unknown', ...nulls(ATTEMPT_COLUMNS) }], null],
    ['another store', [attemptRow({ o_store_id: randomUUID() })], null], ['an issued time with no credit note', [attemptRow({ o_issued_at: TIME(2) })], null],
    ['a gross as a number', [attemptRow({ o_gross_cents: 2000 })], null], ['a state the decoder refuses', [attemptRow({ o_state: 'recorded' })], null],
    ['a payment column', [{ ...attemptRow(), o_payment_id: null }], null],
  ] as const) {
    assert.throws(() => creditNoteAttemptsAnswerOf(rows, STORE_SCOPE, after), /answer invalid/, label);
  }

  const hidden = creditNotesListAnswerOf([listRow(false)], STORE_SCOPE, INVOICE, null) as { namesVisible: boolean; creditNotes: Record<string, unknown>[] };
  assert.deepEqual(hidden, { outcome: 'credit_notes', invoiceId: INVOICE, namesVisible: false, creditNotes: [{ id: CREDIT_NOTE, number: 1, grossCents: 1100,
    taxCents: 100, netCents: 1000, reason: 'pricing_error', issuedAt: TIME(2), issuedByName: null, withdrawal: null }] });
  const shown = creditNotesListAnswerOf([listRow(true, { o_issued_by_name: 'Ana', o_withdrawn_at: TIME(5), o_withdrawal_reason_code: 'wrong_invoice', o_withdrawn_by_name: 'Bo' })],
    STORE_SCOPE, INVOICE, null) as { creditNotes: Record<string, unknown>[] };
  assert.deepEqual(shown.creditNotes[0].withdrawal, { withdrawnAt: TIME(5), reason: 'wrong_invoice', withdrawnByName: 'Bo' });
  assert.deepEqual(creditNotesListAnswerOf([{ ...listRow(true), ...nulls(LIST_NOTE) }], STORE_SCOPE, INVOICE, null),
    { outcome: 'credit_notes', invoiceId: INVOICE, namesVisible: true, creditNotes: [] }, 'the empty page');
  for (const word of ['denied', 'not_found']) assert.deepEqual(creditNotesListAnswerOf([{ o_outcome: word, ...nulls(LIST_ALL) }], STORE_SCOPE, INVOICE, null), { outcome: word });
  assert.deepEqual(creditNotesListAnswerOf([{ o_outcome: 'cursor_unknown', ...nulls(LIST_ALL) }], STORE_SCOPE, INVOICE, CREDIT_NOTE), { outcome: 'cursor_unknown' });
  for (const [label, rows] of [
    ['a name while not visible', [listRow(false, { o_issued_by_name: 'Ana' })]], ['a withdrawal name with no withdrawal', [listRow(true, { o_withdrawn_by_name: 'Bo' })]],
    ['net that does not add up', [listRow(false, { o_net_cents: '999' })]], ['another invoice', [listRow(false, { o_invoice_id: randomUUID() })]],
    ['visibility not a boolean', [listRow(false, { o_names_visible: null })]], ['two visibilities', [listRow(false), listRow(true, { o_credit_note_id: randomUUID(), o_credit_note_number: '2', o_issued_at: TIME(3) })]],
    ['a refusal naming a note', [{ o_outcome: 'denied', ...nulls(LIST_ALL), o_credit_note_id: CREDIT_NOTE }]], ['cursor_unknown without a cursor', [{ o_outcome: 'cursor_unknown', ...nulls(LIST_ALL) }]],
    ['no row', []], ['an id column', [{ ...listRow(false), o_issued_by: ACTOR }]],
  ] as const) {
    assert.throws(() => creditNotesListAnswerOf(rows, STORE_SCOPE, INVOICE, null), /answer invalid/, label);
  }
});

interface Recorded { bounds: TransactionBounds[]; texts: string[]; values: unknown[][] }
function fakeClient(...answers: unknown[][]): { client: SupervisedPgClient; seen: Recorded } {
  const seen: Recorded = { bounds: [], texts: [], values: [] };
  let call = 0;
  const client = {
    async transaction<T>(_signal: AbortSignal, bounds: TransactionBounds, body: (sql: PgTransactionScope) => Promise<T>): Promise<T> {
      seen.bounds.push(bounds);
      const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
        seen.texts.push(strings.join('?'));
        seen.values.push(args);
        return Promise.resolve(answers[Math.min(call++, answers.length - 1)]);
      }) as unknown as PgTransactionScope;
      return body(sql);
    },
    end: async () => undefined,
  } as unknown as SupervisedPgClient;
  return { client, seen };
}

test('ICP-05 the read adapter: the three fixed calls under the read bounds; the proof commits a not_durable and asks once more, a second is the outage; a malformed scope or key is refused before any statement', async () => {
  const signal = new AbortController().signal;
  let f = fakeClient([proofRow()]);
  let port = createPostgresInvoiceCreditNotes({ client: f.client });
  assert.deepEqual(await port.proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, signal, 3000), { outcome: 'proof', registrationId: REGISTRATION, invoiceId: INVOICE, attemptId: ATTEMPT, proof: PROOF });
  assert.equal(squash(f.seen.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_registration_id, o_attempt_id, o_proof '
    + 'from tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::integer)');
  assert.deepEqual(f.seen.values[0].slice(0, 5), [KEY, STORE, INVOICE, TENANT, REGISTRATION]);
  assert.ok(Number.isSafeInteger(f.seen.values[0][5]) && (f.seen.values[0][5] as number) <= 1000, 'a bounded wait');
  assert.deepEqual(f.seen.bounds, [INVOICE_DRAFT_READ_BOUNDS]);
  const notDurable = { o_outcome: 'not_durable', ...nulls(PROOF_COLUMNS) };
  f = fakeClient([notDurable], [proofRow()]);
  port = createPostgresInvoiceCreditNotes({ client: f.client });
  assert.equal(((await port.proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, signal, 3000)) as { outcome: string }).outcome, 'proof');
  assert.equal(f.seen.bounds.length, 2, 'two transactions: the first committed with its not_durable');
  f = fakeClient([notDurable], [notDurable], [proofRow()]);
  port = createPostgresInvoiceCreditNotes({ client: f.client });
  await assert.rejects(async () => port.proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, signal, 3000), /not yet durable/);
  assert.equal(f.seen.bounds.length, 2, 'never a third');

  f = fakeClient([attemptRow()]);
  port = createPostgresInvoiceCreditNotes({ client: f.client });
  const cursor = { invoiceId: randomUUID(), attemptId: randomUUID() };
  await port.attempts(STORE_SCOPE, KEY, cursor, signal);
  assert.equal(squash(f.seen.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_invoice_number, o_attempt_id, o_state, o_version, o_registered_at, '
    + 'o_settled_at, o_gross_cents, o_reason_code, o_credit_note_id, o_issued_at, o_withdrawn_at '
    + 'from tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::integer)');
  assert.deepEqual(f.seen.values[0], [KEY, STORE, TENANT, cursor.invoiceId, cursor.attemptId, 51]);

  f = fakeClient([listRow(false)]);
  port = createPostgresInvoiceCreditNotes({ client: f.client });
  await port.list(STORE_SCOPE, KEY, INVOICE, null, signal);
  assert.equal(squash(f.seen.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_names_visible, o_credit_note_id, o_credit_note_number, o_gross_cents, '
    + 'o_tax_cents, o_net_cents, o_reason_code, o_issued_at, o_issued_by_name, o_withdrawn_at, o_withdrawal_reason_code, o_withdrawn_by_name '
    + 'from tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(?::text, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::integer)');
  assert.deepEqual(f.seen.values[0], [KEY, TENANT, STORE, INVOICE, null, 51]);

  f = fakeClient([listRow(false)]);
  port = createPostgresInvoiceCreditNotes({ client: f.client });
  await assert.rejects(async () => port.list({ ...STORE_SCOPE, scope: 'tenant', store: null } as TrustedScope, KEY, INVOICE, null, signal), /answer invalid/);
  await assert.rejects(async () => port.list(STORE_SCOPE, 'short', INVOICE, null, signal), /answer invalid/);
  await assert.rejects(async () => port.list(STORE_SCOPE, KEY, 'x', null, signal), /answer invalid/);
  await assert.rejects(async () => port.attempts(STORE_SCOPE, KEY, { invoiceId: 'x', attemptId: ATTEMPT }, signal), /answer invalid/);
  await assert.rejects(async () => port.proof(STORE_SCOPE, KEY, INVOICE, REGISTRATION, signal, 0), /answer invalid/);
  assert.equal(f.seen.texts.length, 0, 'nothing sent');
  assert.throws(() => createPostgresInvoiceCreditNotes({} as never), /options invalid/);
});

// --- the store credit activity (docs/phase-4/18, migration 039) ---------------------------------------------------------
// WRITTEN — NOT RUN (doc 18 implementation slice, local authoring only).

const ACTIVITY_COLUMNS = ['o_tenant_id', 'o_store_id', 'o_credit_note_id', 'o_credit_note_number', 'o_invoice_id', 'o_invoice_number', 'o_gross_cents',
  'o_reason_code', 'o_issued_at', 'o_issued_by_name', 'o_withdrawn_at', 'o_withdrawal_reason_code', 'o_withdrawn_by_name'];
const activityRow = (n: number, over: Record<string, unknown> = {}) => ({ o_outcome: 'credit_note', o_tenant_id: TENANT, o_store_id: STORE,
  o_credit_note_id: `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, o_credit_note_number: String(n), o_invoice_id: INVOICE,
  o_invoice_number: '7', o_gross_cents: '1100', o_reason_code: 'pricing_error', o_issued_at: TIME(2), o_issued_by_name: null, o_withdrawn_at: null,
  o_withdrawal_reason_code: null, o_withdrawn_by_name: null, ...over });

test('ICP-06 (doc 18 §6.6; supports CA-01, CA-11, CA-12): the activity row decoder — every row this scope\'s tenant and store, exact bigints, a withdrawal only with its time, the empty page as no row, the refusals as one all-null row, every fault one bounded message; the adapter\'s ONE fixed call under the read bounds, refused before any statement for a malformed scope, key or cursor', async () => {
  assert.deepEqual(storeCreditActivityAnswerOf([activityRow(2, { o_issued_by_name: 'Ana', o_withdrawn_at: TIME(5), o_withdrawal_reason_code: 'wrong_invoice', o_withdrawn_by_name: null }),
    activityRow(1)], STORE_SCOPE, null), { outcome: 'credit_notes', storeId: STORE, creditNotes: [
    { id: activityRow(2).o_credit_note_id, number: 2, invoiceId: INVOICE, invoiceNumber: 7, grossCents: 1100, reason: 'pricing_error', issuedAt: TIME(2), issuedByName: 'Ana',
      withdrawal: { withdrawnAt: TIME(5), reason: 'wrong_invoice', withdrawnByName: null } },
    { id: activityRow(1).o_credit_note_id, number: 1, invoiceId: INVOICE, invoiceNumber: 7, grossCents: 1100, reason: 'pricing_error', issuedAt: TIME(2), issuedByName: null,
      withdrawal: null },
  ] });
  assert.deepEqual(storeCreditActivityAnswerOf([], STORE_SCOPE, null), { outcome: 'credit_notes', storeId: STORE, creditNotes: [] }, 'no row is the empty page');
  assert.deepEqual(storeCreditActivityAnswerOf([{ o_outcome: 'denied', ...nulls(ACTIVITY_COLUMNS) }], STORE_SCOPE, null), { outcome: 'denied' });
  assert.deepEqual(storeCreditActivityAnswerOf([{ o_outcome: 'cursor_unknown', ...nulls(ACTIVITY_COLUMNS) }], STORE_SCOPE, CREDIT_NOTE), { outcome: 'cursor_unknown' });
  for (const [label, rows, after] of [
    ['cursor_unknown without a cursor', [{ o_outcome: 'cursor_unknown', ...nulls(ACTIVITY_COLUMNS) }], null],
    ['a refusal naming a note', [{ o_outcome: 'denied', ...nulls(ACTIVITY_COLUMNS), o_credit_note_id: CREDIT_NOTE }], null],
    ['a refusal beside a row', [{ o_outcome: 'denied', ...nulls(ACTIVITY_COLUMNS) }, activityRow(1)], null],
    ['a row after a refusal word', [activityRow(1), { o_outcome: 'denied', ...nulls(ACTIVITY_COLUMNS) }], null],
    ['another store', [activityRow(1, { o_store_id: randomUUID() })], null], ['another tenant', [activityRow(1, { o_tenant_id: randomUUID() })], null],
    ['a gross as a number', [activityRow(1, { o_gross_cents: 1100 })], null], ['a number over 2^53 - 1', [activityRow(1, { o_credit_note_number: '9007199254740992' })], null],
    ['a withdrawal reason with no withdrawal', [activityRow(1, { o_withdrawal_reason_code: 'wrong_amount' })], null],
    ['a withdrawer named with no withdrawal', [activityRow(1, { o_withdrawn_by_name: 'Bo' })], null],
    ['ascending numbers', [activityRow(1), activityRow(2)], null], ['a name over 1,000 characters', [activityRow(1, { o_issued_by_name: 'a'.repeat(1001) })], null],
    ['a control character', [activityRow(1, { o_issued_by_name: 'A\u0007' })], null], ['the cursor served', [activityRow(1)], activityRow(1).o_credit_note_id],
    ['a tax column', [{ ...activityRow(1), o_tax_cents: '0' }], null], ['an actor id column', [{ ...activityRow(1), o_issued_by: ACTOR }], null],
    ['over the ask', Array.from({ length: 52 }, (_, i) => activityRow(52 - i)), null], ['not an array', 'rows', null],
  ] as const) {
    assert.throws(() => storeCreditActivityAnswerOf(rows, STORE_SCOPE, after), /^Error: invoice credit notes answer invalid$/, label);
  }

  const signal = new AbortController().signal;
  let f = fakeClient([activityRow(1)]);
  let port = createPostgresInvoiceCreditNotes({ client: f.client });
  await port.storeActivity(STORE_SCOPE, KEY, CREDIT_NOTE, signal);
  assert.equal(squash(f.seen.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_credit_note_id, o_credit_note_number, o_invoice_id, o_invoice_number, o_gross_cents, '
    + 'o_reason_code, o_issued_at, o_issued_by_name, o_withdrawn_at, o_withdrawal_reason_code, o_withdrawn_by_name '
    + 'from tmpos_invoice_credit_note.m7b_store_credit_activity(?::text, ?::uuid, ?::uuid, ?::uuid, ?::integer)');
  assert.deepEqual(f.seen.values[0], [KEY, TENANT, STORE, CREDIT_NOTE, 51], 'the session key, the trusted tenant and store, the cursor and 51');
  assert.deepEqual(f.seen.bounds, [INVOICE_DRAFT_READ_BOUNDS]);
  f = fakeClient([activityRow(1)]);
  port = createPostgresInvoiceCreditNotes({ client: f.client });
  await assert.rejects(async () => port.storeActivity({ ...STORE_SCOPE, scope: 'tenant', store: null } as TrustedScope, KEY, null, signal), /answer invalid/);
  await assert.rejects(async () => port.storeActivity(STORE_SCOPE, 'short', null, signal), /answer invalid/);
  await assert.rejects(async () => port.storeActivity(STORE_SCOPE, KEY, `${CREDIT_NOTE}x`, signal), /answer invalid/);
  assert.equal(f.seen.texts.length, 0, 'nothing sent');
});
