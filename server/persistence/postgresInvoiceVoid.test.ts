// Phase 4.0 M7B-INVOICES-VOID-P1 — the PostgreSQL side of the invoice void, DATABASE-FREE: what the void's mutator hands
// migration 035's routine (one fixed statement, every value bound, the version as bigint text, the revalidated store) and how
// it reads the one row back — each word, the identity echo, every malformed or mismatched row a mismatch (R-BR-07, R-BR-09) —
// then the recent sign-in judged again on the database clock after the routine (R-SEC-02's adapter half), and nothing called
// without the deadline. The routine itself is proved against a real cluster by this stage's database suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { INVOICE_VOID_MUTATOR } from './postgresInvoiceVoid.js';
import type { MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { INVOICE_VOID_REASON_CODES } from '../runtime/invoiceVoid.js';
import type { TrustedScope } from '../runtime/principals.js';

const MAX = Number.MAX_SAFE_INTEGER;
const KEY = 'k'.repeat(43);
const TENANT = randomUUID();
const STORE = randomUUID();
const ACTOR = randomUUID();
const MEMBERSHIP = randomUUID();
const INVOICE = randomUUID();
const DEADLINE = 1_800_000_000_000;
const STORE_SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv', scope: 'store', tenant: TENANT, store: STORE, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});

/** A statement recorder answering each statement in turn from `answers` (the last repeats). */
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
const OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id'];
const nulls = (columns: readonly string[]) => Object.fromEntries(columns.map((c) => [c, null]));
const voidMutation = (over: Record<string, unknown> = {}, expectedVersion: unknown = 1, aggregateId: unknown = INVOICE): TransactionMutation => Object.freeze({
  kind: 'store.invoice.void', aggregateType: 'issued_invoice', aggregateId: aggregateId as string, expectedVersion: expectedVersion as number,
  changes: Object.freeze({ expectedTenant: TENANT, reasonCode: 'issued_in_error', ...over }),
});
const authority = (over: Partial<TrustedScope> = {}, authNotAfter: unknown = DEADLINE, key: string | null = KEY): MutationAuthority =>
  Object.freeze({ context: Object.freeze({ ...STORE_SCOPE, ...over }), sessionKey: key, authNotAfter: authNotAfter as number });
const applied = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_version: '2', o_invoice_id: INVOICE, ...over,
});
const refusal = (outcome: string) => ({ o_outcome: outcome, ...nulls(OUT) });
const FRESH = [{ fresh: true }];

test('IVP-01 the void mutator: store scope, update of the issued invoice, the voided-invoice audit subject, no issuing opt-in; ONE fixed call binding the key, the REVALIDATED store, the invoice, the tenant, the version as bigint text and the code — then the deadline on the database clock', async () => {
  assert.deepEqual([INVOICE_VOID_MUTATOR.kind, INVOICE_VOID_MUTATOR.mode, INVOICE_VOID_MUTATOR.aggregateType, INVOICE_VOID_MUTATOR.contextScope,
    INVOICE_VOID_MUTATOR.auditSubjects, INVOICE_VOID_MUTATOR.issuingRefusals], ['store.invoice.void', 'update', 'issued_invoice', 'store', 'voided_invoice', undefined]);
  assert.ok(Object.isFrozen(INVOICE_VOID_MUTATOR));
  const r = recorder([applied()], FRESH);
  assert.equal(await INVOICE_VOID_MUTATOR.apply(r.sql, voidMutation(), authority()), 'applied', 'the bare word: the audit names the invoice alone');
  assert.equal(r.texts.length, 2, 'the routine, then the clock');
  assert.equal(squash(r.texts[0]), 'select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id '
    + 'from tmpos_invoice_void.m7b_invoice_void(?::text, ?::uuid, ?::uuid, ?::uuid, ?::bigint, ?::text)', 'the exact statement');
  assert.deepEqual(r.values[0], [KEY, STORE, INVOICE, TENANT, '1', 'issued_in_error']);
  assert.equal(squash(r.texts[1]), 'select (pg_catalog.clock_timestamp() <= pg_catalog.to_timestamp(?::bigint / 1000.0)) as fresh', 'the deadline, after the routine');
  assert.deepEqual(r.values[1], [String(DEADLINE)]);
  // Every code is bound as the routine's text argument, beside the same revalidated store.
  for (const code of INVOICE_VOID_REASON_CODES) {
    const each = recorder([applied()], FRESH);
    assert.equal(await INVOICE_VOID_MUTATOR.apply(each.sql, voidMutation({ reasonCode: code }), authority()), 'applied', code);
    assert.deepEqual([each.values[0][1], each.values[0][5]], [STORE, code], `${code}: bound as text`);
  }
  // The largest version the routine accepts, still exact text, and its successor echoed.
  const top = recorder([applied({ o_version: String(MAX) })], FRESH);
  assert.equal(await INVOICE_VOID_MUTATOR.apply(top.sql, voidMutation({}, MAX - 1), authority()), 'applied');
  assert.equal(top.values[0][4], String(MAX - 1));
});

test('IVP-02 a sign-in that went stale while the routine waited refuses the void (rolled back); an unanswerable clock throws (the kernel\'s 503); a refusal never asks the clock', async () => {
  const stale = recorder([applied()], [{ fresh: false }]);
  assert.equal(await INVOICE_VOID_MUTATOR.apply(stale.sql, voidMutation(), authority()), 'refused');
  assert.ok(stale.texts[0].includes('m7b_invoice_void') && stale.texts[1].includes('clock_timestamp'), 'the routine first, the deadline after its wait');
  for (const clock of [[], [{ fresh: 'true' }], [{ fresh: null }], [{ fresh: true }, { fresh: true }]]) {
    await assert.rejects(INVOICE_VOID_MUTATOR.apply(recorder([applied()], clock).sql, voidMutation(), authority()), /session store unavailable/, JSON.stringify(clock));
  }
  for (const [word, answer] of [['tenant_mismatch', 'precondition_failed'], ['not_found', 'not_found'], ['invalid_state', 'invalid_state'], ['conflict', 'conflict'],
    ['refused', 'refused']] as const) {
    const r = recorder([refusal(word)], [{ fresh: false }]);
    assert.equal(await INVOICE_VOID_MUTATOR.apply(r.sql, voidMutation(), authority()), answer, word);
    assert.equal(r.texts.length, 1, `${word}: no clock`);
  }
});

test('IVP-03 (R-BR-07, R-BR-09) every malformed or mismatched row is mismatch, before the clock: another tenant, store, actor, grant or invoice; a version other than expectedVersion + 1 or not exact text; a refusal naming anything; an unknown word; no row or two; a column more or less', async () => {
  const mismatches: Array<[string, unknown[]]> = [
    ['another tenant', [applied({ o_tenant_id: randomUUID() })]], ['another store', [applied({ o_store_id: randomUUID() })]],
    ['another actor', [applied({ o_actor_id: randomUUID() })]], ['another grant', [applied({ o_membership_id: randomUUID() })]],
    ['another invoice', [applied({ o_invoice_id: randomUUID() })]], ['a null invoice', [applied({ o_invoice_id: null })]],
    ['the same version', [applied({ o_version: '1' })]], ['two steps on', [applied({ o_version: '3' })]], ['a numeric version', [applied({ o_version: 2 })]],
    ['a padded version', [applied({ o_version: '02' })]], ['a null version', [applied({ o_version: null })]], ['an uppercase tenant', [applied({ o_tenant_id: TENANT.toUpperCase() })]],
    ...OUT.map((c): [string, unknown[]] => [`a refusal naming ${c}`, [{ ...refusal('invalid_state'), [c]: c === 'o_version' ? '2' : INVOICE }]]),
    ['tenant_mismatch naming the tenant', [{ ...refusal('tenant_mismatch'), o_tenant_id: TENANT }]],
    ['an unknown word', [refusal('voided')]], ['unchanged (never a void answer)', [refusal('unchanged')]], ['precondition_failed spelled by the routine', [refusal('precondition_failed')]],
    ['the issue\'s word', [refusal('issuing_not_configured')]], ['a null word', [refusal(null as unknown as string)]], ['an uppercase word', [applied({ o_outcome: 'APPLIED' })]],
    ['two rows', [applied(), applied()]], ['no row', []], ['an extra column', [{ ...applied(), o_voided_by: ACTOR }]],
    ['a missing column', [Object.fromEntries(Object.entries(applied()).filter(([k]) => k !== 'o_invoice_id'))]], ['a row that is no object', ['applied']],
  ];
  for (const [label, rows] of mismatches) {
    const r = recorder(rows, FRESH);
    assert.equal(await INVOICE_VOID_MUTATOR.apply(r.sql, voidMutation(), authority()), 'mismatch', label);
    assert.equal(r.texts.length, 1, `${label}: no clock`);
  }
  // R-BR-09: the echo is expectedVersion + 1 for the version asked, whatever it is.
  assert.equal(await INVOICE_VOID_MUTATOR.apply(recorder([applied({ o_version: '2' })], FRESH).sql, voidMutation({}, 2), authority()), 'mismatch', '2 asked, 2 echoed');
  assert.equal(await INVOICE_VOID_MUTATOR.apply(recorder([applied({ o_version: '3' })], FRESH).sql, voidMutation({}, 2), authority()), 'applied', '2 asked, 3 echoed');
});

test('IVP-04 the void mutator calls nothing without the revalidated store context, its key and a numeric sign-in deadline, or for a value outside the planner\'s bounds', async () => {
  const cases: Array<[string, TransactionMutation, MutationAuthority | undefined]> = [
    ['no authority', voidMutation(), undefined], ['no key', voidMutation(), authority({}, DEADLINE, null)],
    ['no deadline', voidMutation(), authority({}, null)], ['a zero deadline', voidMutation(), authority({}, 0)], ['a fractional deadline', voidMutation(), authority({}, 1.5)],
    ['a text deadline', voidMutation(), authority({}, String(DEADLINE))], ['an unsafe deadline', voidMutation(), authority({}, MAX + 1)],
    ['a tenant context', voidMutation(), authority({ scope: 'tenant', store: null })], ['a null store', voidMutation(), authority({ store: null })],
    ['a non-uuid store', voidMutation(), authority({ store: 'store' })], ['a non-uuid tenant context', voidMutation(), authority({ tenant: 'tenant' })],
    ['a bad invoice id', voidMutation({}, 1, 'x'), authority()], ['an uppercase invoice id', voidMutation({}, 1, INVOICE.toUpperCase()), authority()],
    ['a bad tenant', voidMutation({ expectedTenant: 'x' }), authority()], ['no tenant', voidMutation({ expectedTenant: null }), authority()],
    ['an unknown code', voidMutation({ reasonCode: 'refund' }), authority()], ['a label for a code', voidMutation({ reasonCode: 'Other reason' }), authority()],
    ['no code', voidMutation({ reasonCode: undefined }), authority()],
    ['version 0', voidMutation({}, 0), authority()], ['version 2^53 - 1', voidMutation({}, MAX), authority()], ['version null', voidMutation({}, null), authority()],
    ['version 1.5', voidMutation({}, 1.5), authority()], ['version as text', voidMutation({}, '1'), authority()],
  ];
  for (const [label, mutation, auth] of cases) {
    const r = recorder([applied()], FRESH);
    assert.equal(await INVOICE_VOID_MUTATOR.apply(r.sql, mutation, auth), 'unavailable', label);
    assert.equal(r.texts.length, 0, `${label}: nothing called`);
  }
});
