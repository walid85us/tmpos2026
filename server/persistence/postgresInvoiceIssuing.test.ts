// Phase 4.0 M7B-INVOICES-ISSUE-P1 — the PostgreSQL side of issuing, DATABASE-FREE: what the issue's and the settings write's
// mutators hand migration 034's routines and how they read the one row back (the settings write's recent sign-in judged
// again on the database clock after the routine); what the four reads hand their routines and what they refuse to read
// back as an answer; and the readiness probe. The routines themselves are proved against a real cluster by the database
// suites of this stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  INVOICE_ISSUE_MUTATOR, ISSUING_SETTINGS_UPDATE_MUTATOR, createPostgresInvoiceIssuing, createPostgresIssuingSettings, invoiceIssuePreviewAnswerOf,
  issuedInvoiceAnswerOf, issuedInvoicePageAnswerOf, issuingSettingsAnswerOf, probeInvoiceIssuing,
} from './postgresInvoiceIssuing.js';
import { INVOICE_DRAFT_READ_BOUNDS } from './postgresInvoiceDrafts.js';
import type { MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import type { TrustedScope } from '../runtime/principals.js';

const MAX = Number.MAX_SAFE_INTEGER;
const KEY = 'k'.repeat(43);
const TENANT = randomUUID();
const STORE = randomUUID();
const ACTOR = randomUUID();
const MEMBERSHIP = randomUUID();
const DRAFT = randomUUID();
const INVOICE = randomUUID();
const CUSTOMER = randomUUID();
const AT = '2026-10-16T09:30:00.123456Z';
const STORE_SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv', scope: 'store', tenant: TENANT, store: STORE, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});
const TENANT_SCOPE: TrustedScope = Object.freeze({ ...STORE_SCOPE, scope: 'tenant', store: null, roleId: 'store_owner' });
const live = (): AbortSignal => new AbortController().signal;

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
const nulls = (columns: readonly string[]) => Object.fromEntries(columns.map((c) => [c, null]));

// --- 1. the issue's mutator ------------------------------------------------------------------------------------------------

const ISSUE_OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id', 'o_customer_id', 'o_number'];
const issueMutation = (over: Record<string, unknown> = {}, expectedVersion: unknown = 2): TransactionMutation => Object.freeze({
  kind: 'store.invoice.issue', aggregateType: 'invoice_draft', aggregateId: DRAFT, expectedVersion: expectedVersion as number,
  changes: Object.freeze({ expectedTenant: TENANT, expectedSettingsVersion: 3, expectedCustomerVersion: 4, invoiceId: INVOICE, ...over }),
});
const storeAuthority = (over: Partial<TrustedScope> = {}, key: string | null = KEY): MutationAuthority =>
  Object.freeze({ context: Object.freeze({ ...STORE_SCOPE, ...over }), sessionKey: key, authNotAfter: null });
const applied = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_version: '3', o_invoice_id: INVOICE,
  o_customer_id: CUSTOMER, o_number: '42', ...over,
});
const refusal = (outcome: string, columns: readonly string[] = ISSUE_OUT) => ({ o_outcome: outcome, ...nulls(columns) });

test('ISS-P01 the issue mutator: store scope, update, the issuing opt-in and its audit subjects; ONE fixed call binding the key, the REVALIDATED store, the draft, the preconditions as bigint text and the invoice id', async () => {
  assert.deepEqual([INVOICE_ISSUE_MUTATOR.kind, INVOICE_ISSUE_MUTATOR.mode, INVOICE_ISSUE_MUTATOR.aggregateType, INVOICE_ISSUE_MUTATOR.contextScope,
    INVOICE_ISSUE_MUTATOR.issuingRefusals, INVOICE_ISSUE_MUTATOR.auditSubjects], ['store.invoice.issue', 'update', 'invoice_draft', 'store', true, 'issued_invoice']);
  const r = recorder([applied()]);
  assert.deepEqual(await INVOICE_ISSUE_MUTATOR.apply(r.sql, issueMutation(), storeAuthority()), { outcome: 'applied', subjectCustomerId: CUSTOMER });
  assert.equal(r.texts.length, 1, 'one statement');
  assert.match(r.texts[0], /from tmpos_invoice_issue\.m7b_invoice_issue\(\?::text, \?::uuid, \?::uuid, \?::uuid,\s+\?::bigint, \?::bigint, \?::bigint, \?::uuid\)$/);
  assert.deepEqual(r.values[0], [KEY, STORE, DRAFT, TENANT, '2', '3', '4', INVOICE]);
  // The largest versions, still exact text.
  const top = recorder([applied({ o_version: String(MAX) })]);
  assert.deepEqual(await INVOICE_ISSUE_MUTATOR.apply(top.sql, issueMutation({ expectedSettingsVersion: MAX, expectedCustomerVersion: MAX }, MAX - 1), storeAuthority()),
    { outcome: 'applied', subjectCustomerId: CUSTOMER });
  assert.deepEqual(top.values[0].slice(4, 7), [String(MAX - 1), String(MAX), String(MAX)]);
});

test('ISS-P02 the issue mutator\'s answers: each refusal exactly, tenant_mismatch as precondition_failed; any other identity, version, id, number or shape is mismatch', async () => {
  for (const word of ['not_found', 'invalid_state', 'conflict', 'issuing_not_configured', 'amount_out_of_range', 'refused']) {
    assert.equal(await INVOICE_ISSUE_MUTATOR.apply(recorder([refusal(word)]).sql, issueMutation(), storeAuthority()), word, word);
  }
  assert.equal(await INVOICE_ISSUE_MUTATOR.apply(recorder([refusal('tenant_mismatch')]).sql, issueMutation(), storeAuthority()), 'precondition_failed');
  const mismatches: Array<[string, unknown[]]> = [
    ['another tenant', [applied({ o_tenant_id: randomUUID() })]], ['another store', [applied({ o_store_id: randomUUID() })]],
    ['another actor', [applied({ o_actor_id: randomUUID() })]], ['another grant', [applied({ o_membership_id: randomUUID() })]],
    ['the same version', [applied({ o_version: '2' })]], ['a numeric version', [applied({ o_version: 3 })]], ['another invoice', [applied({ o_invoice_id: randomUUID() })]],
    ['no customer', [applied({ o_customer_id: null })]], ['number 0', [applied({ o_number: '0' })]], ['number 2^53', [applied({ o_number: '9007199254740992' })]],
    ['a numeric number', [applied({ o_number: 42 })]], ['a padded number', [applied({ o_number: '042' })]],
    ['a refusal naming the invoice', [{ ...refusal('conflict'), o_invoice_id: INVOICE }]], ['an unknown word', [refusal('discarded')]],
    ['unchanged (never an issue answer)', [refusal('unchanged')]], ['two rows', [applied(), applied()]], ['no row', []],
    ['an extra column', [{ ...applied(), o_issued_by: ACTOR }]], ['a missing column', [Object.fromEntries(Object.entries(applied()).filter(([k]) => k !== 'o_number'))]],
  ];
  for (const [label, rows] of mismatches) assert.equal(await INVOICE_ISSUE_MUTATOR.apply(recorder(rows).sql, issueMutation(), storeAuthority()), 'mismatch', label);
});

test('ISS-P03 the issue mutator calls nothing without the revalidated store context, its key, uuids and the planner\'s version bounds', async () => {
  const cases: Array<[string, TransactionMutation, MutationAuthority | undefined]> = [
    ['no authority', issueMutation(), undefined], ['no key', issueMutation(), storeAuthority({}, null)],
    ['a tenant context', issueMutation(), storeAuthority({ scope: 'tenant', store: null })],
    ['a null store', issueMutation(), storeAuthority({ store: null })], ['a bad invoice id', issueMutation({ invoiceId: 'x' }), storeAuthority()],
    ['a bad tenant', issueMutation({ expectedTenant: 'x' }), storeAuthority()], ['version 0', issueMutation({}, 0), storeAuthority()],
    ['version 2^53 - 1', issueMutation({}, MAX), storeAuthority()], ['version null', issueMutation({}, null), storeAuthority()],
    ['settings version 0', issueMutation({ expectedSettingsVersion: 0 }), storeAuthority()], ['customer version 1.5', issueMutation({ expectedCustomerVersion: 1.5 }), storeAuthority()],
  ];
  for (const [label, mutation, authority] of cases) {
    const r = recorder([applied()]);
    assert.equal(await INVOICE_ISSUE_MUTATOR.apply(r.sql, mutation, authority), 'unavailable', label);
    assert.equal(r.texts.length, 0, `${label}: nothing called`);
  }
});

// --- 2. the settings write's mutator ---------------------------------------------------------------------------------------

const SET_OUT = ['o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version'];
const settingsMutation = (over: Record<string, unknown> = {}): TransactionMutation => Object.freeze({
  kind: 'tenant.issuing_settings.update', aggregateType: 'store_issuing_settings_change', aggregateId: randomUUID(), expectedVersion: null,
  changes: Object.freeze({
    storeId: STORE, expectedTenant: TENANT, expectedVersion: 0, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown',
    postalAddress: Object.freeze([Object.freeze({ line: '1 Main St' }), Object.freeze({ line: 'Springfield' })]), hasTaxRegistrationId: true,
    taxRegistrationId: 'TX-1', taxMode: 'exclusive_rate', taxRateMilliPercent: 8875, ...over,
  }),
});
const tenantAuthority = (over: Partial<TrustedScope> = {}, authNotAfter: unknown = Date.now() + 60_000, key: string | null = KEY): MutationAuthority =>
  Object.freeze({ context: Object.freeze({ ...TENANT_SCOPE, ...over }), sessionKey: key, authNotAfter: authNotAfter as number });
const setApplied = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'applied', o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_version: '1', ...over,
});

test('ISS-P04 the settings mutator: tenant scope, create, the store subject; ONE call binding the address joined by LF, the id or NULL, the rate or NULL; then the database clock', async () => {
  assert.deepEqual([ISSUING_SETTINGS_UPDATE_MUTATOR.kind, ISSUING_SETTINGS_UPDATE_MUTATOR.mode, ISSUING_SETTINGS_UPDATE_MUTATOR.aggregateType,
    ISSUING_SETTINGS_UPDATE_MUTATOR.contextScope, ISSUING_SETTINGS_UPDATE_MUTATOR.auditSubjects, ISSUING_SETTINGS_UPDATE_MUTATOR.issuingRefusals],
  ['tenant.issuing_settings.update', 'create', 'store_issuing_settings_change', 'tenant', 'store', undefined]);
  const r = recorder([setApplied()], [{ fresh: true }]);
  assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(r.sql, settingsMutation(), tenantAuthority()), 'applied');
  assert.match(r.texts[0], /from tmpos_invoice_issue\.m7b_issuing_settings_set\(\?::text, \?::uuid, \?::uuid, \?::bigint,\s+\?::text, \?::text, \?::text, \?::text, \?::text,\s+\?::integer\)$/);
  assert.deepEqual(r.values[0], [KEY, STORE, TENANT, '0', 'Acme Repairs LLC', 'Acme Downtown', '1 Main St\nSpringfield', 'TX-1', 'exclusive_rate', 8875]);
  assert.match(r.texts[1], /clock_timestamp\(\) <=/, 'the deadline, on the database clock, after the routine');
  const none = recorder([setApplied({ o_version: '8' })], [{ fresh: true }]);
  assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(none.sql,
    settingsMutation({ expectedVersion: 7, hasTaxRegistrationId: false, taxRegistrationId: '', taxMode: 'none', taxRateMilliPercent: 0 }), tenantAuthority()), 'applied');
  assert.deepEqual(none.values[0].slice(3), ['7', 'Acme Repairs LLC', 'Acme Downtown', '1 Main St\nSpringfield', null, 'none', null], 'NULL id, NULL rate');
});

test('ISS-P05 a recent sign-in that went stale while the routine waited refuses the write; a refusal never asks the clock', async () => {
  const stale = recorder([setApplied()], [{ fresh: false }]);
  assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(stale.sql, settingsMutation(), tenantAuthority()), 'refused');
  assert.ok(stale.texts[0].includes('m7b_issuing_settings_set') && stale.texts[1].includes('clock_timestamp'), 'the routine first, the deadline after its wait');
  for (const [rows, answer] of [[[refusal('tenant_mismatch', SET_OUT)], 'precondition_failed'], [[refusal('not_found', SET_OUT)], 'not_found'],
    [[refusal('conflict', SET_OUT)], 'conflict'], [[refusal('refused', SET_OUT)], 'refused'], [[setApplied({ o_store_id: randomUUID() })], 'mismatch']] as const) {
    const r = recorder(rows as unknown as unknown[], [{ fresh: false }]);
    assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(r.sql, settingsMutation(), tenantAuthority()), answer, answer);
    assert.equal(r.texts.length, 1, `${answer}: no clock`);
  }
  const mismatches: Array<[string, unknown[]]> = [
    ['another tenant', [setApplied({ o_tenant_id: randomUUID() })]], ['another actor', [setApplied({ o_actor_id: randomUUID() })]],
    ['another grant', [setApplied({ o_membership_id: randomUUID() })]], ['a skipped version', [setApplied({ o_version: '2' })]],
    ['a refusal naming the store', [{ ...refusal('conflict', SET_OUT), o_store_id: STORE }]], ['an unknown word', [refusal('version_conflict', SET_OUT)]],
    ['no row', []], ['two rows', [setApplied(), setApplied()]],
  ];
  for (const [label, rows] of mismatches) assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(recorder(rows, [{ fresh: true }]).sql, settingsMutation(), tenantAuthority()), 'mismatch', label);
});

test('ISS-P06 the settings mutator calls nothing without the tenant context, its key and a deadline, or for an inconsistent change set', async () => {
  const cases: Array<[string, TransactionMutation, MutationAuthority | undefined]> = [
    ['no authority', settingsMutation(), undefined], ['no deadline', settingsMutation(), tenantAuthority({}, null)],
    ['a zero deadline', settingsMutation(), tenantAuthority({}, 0)], ['no key', settingsMutation(), tenantAuthority({}, Date.now(), null)],
    ['a store context', settingsMutation(), tenantAuthority({ scope: 'store', store: STORE })],
    ['a bad store', settingsMutation({ storeId: 'x' }), tenantAuthority()], ['version 2^53 - 1', settingsMutation({ expectedVersion: MAX }), tenantAuthority()],
    ['no address', settingsMutation({ postalAddress: [] }), tenantAuthority()], ['nine lines', settingsMutation({ postalAddress: Array(9).fill({ line: 'a' }) }), tenantAuthority()],
    ['an id flagged absent', settingsMutation({ hasTaxRegistrationId: false }), tenantAuthority()],
    ['an empty id flagged present', settingsMutation({ taxRegistrationId: '' }), tenantAuthority()],
    ['a rate under none', settingsMutation({ taxMode: 'none', taxRateMilliPercent: 5 }), tenantAuthority()],
    ['an unknown mode', settingsMutation({ taxMode: 'inclusive_rate' }), tenantAuthority()], ['a rate past 100 %', settingsMutation({ taxRateMilliPercent: 100_001 }), tenantAuthority()],
  ];
  for (const [label, mutation, authority] of cases) {
    const r = recorder([setApplied()], [{ fresh: true }]);
    assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(r.sql, mutation, authority), 'unavailable', label);
    assert.equal(r.texts.length, 0, `${label}: nothing called`);
  }
});

test('ISS-P06b the settings mutator binds only a change set of exactly the contract\'s keys and plain { line } address rows, at most 8; anything else calls nothing', async () => {
  const withChanges = (changes: Record<string, unknown>): TransactionMutation =>
    Object.freeze({ ...settingsMutation(), changes: Object.freeze(changes) as TransactionMutation['changes'] });
  const missing: Record<string, unknown> = { ...settingsMutation().changes };
  delete missing.taxMode;
  const cases: Array<[string, TransactionMutation]> = [
    ['an extra key', withChanges({ ...settingsMutation().changes, extra: 'x' })],
    ['a missing key', withChanges(missing)],
    ['a row with an extra key', settingsMutation({ postalAddress: [{ line: '1 Main St', note: 'x' }] })],
    ['a non-string line', settingsMutation({ postalAddress: [{ line: 7 }] })],
    ['a row that is no plain object', settingsMutation({ postalAddress: [Object.assign(Object.create({ inherited: true }), { line: 'a' })] })],
    ['9 rows', settingsMutation({ postalAddress: Array.from({ length: 9 }, (_, i) => ({ line: `line ${i}` })) })],
  ];
  for (const [label, mutation] of cases) {
    const r = recorder([setApplied()], [{ fresh: true }]);
    assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(r.sql, mutation, tenantAuthority()), 'unavailable', label);
    assert.equal(r.texts.length, 0, `${label}: no SQL`);
  }
  // A value is read once: a getter that would answer differently on a second read is refused, never invoked.
  let reads = 0;
  const changes = { ...settingsMutation().changes };
  Object.defineProperty(changes, 'legalName', { enumerable: true, get: () => (reads++ === 0 ? 'Acme Repairs LLC' : 7) });
  const r = recorder([setApplied()], [{ fresh: true }]);
  assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(r.sql, withChanges(changes), tenantAuthority()), 'unavailable', 'a getter');
  assert.deepEqual([r.texts.length, reads], [0, 0], 'a getter: no SQL, never read');
  // Eight rows is the bound, still bound.
  const eight = recorder([setApplied()], [{ fresh: true }]);
  assert.equal(await ISSUING_SETTINGS_UPDATE_MUTATOR.apply(eight.sql,
    settingsMutation({ postalAddress: Array.from({ length: 8 }, (_, i) => ({ line: `line ${i}` })) }), tenantAuthority()), 'applied', '8 rows');
});

// --- 3. the reads ----------------------------------------------------------------------------------------------------------

const SETTINGS_COLS = ['o_tenant_id', 'o_store_id', 'o_version', 'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id', 'o_tax_mode', 'o_tax_rate'];
const settingsRow = (over: Record<string, unknown> = {}) => ({
  o_outcome: 'settings', o_tenant_id: TENANT, o_store_id: STORE, o_version: '3', o_legal_name: 'Acme Repairs LLC', o_store_name: 'Acme Downtown',
  o_postal_address: '1 Main St\nSpringfield', o_tax_registration_id: null, o_tax_mode: 'exclusive_rate', o_tax_rate: 8875, ...over,
});

test('ISS-P07 the settings read\'s rows: none at version 0, a configured row, the two refusals; anything else a fault', () => {
  assert.deepEqual(issuingSettingsAnswerOf([{ o_outcome: 'none', ...nulls(SETTINGS_COLS), o_tenant_id: TENANT, o_store_id: STORE, o_version: '0' }], TENANT_SCOPE, STORE),
    { outcome: 'settings', issuingSettings: { storeId: STORE, version: 0, configured: false } });
  assert.deepEqual(issuingSettingsAnswerOf([settingsRow()], TENANT_SCOPE, STORE), { outcome: 'settings', issuingSettings: {
    storeId: STORE, version: 3, configured: true, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield',
    taxRegistrationId: null, tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 } } });
  assert.deepEqual((issuingSettingsAnswerOf([settingsRow({ o_tax_mode: 'none', o_tax_rate: null })], TENANT_SCOPE, STORE) as { issuingSettings: { tax: unknown } })
    .issuingSettings.tax, { mode: 'none' });
  for (const word of ['denied', 'not_found']) {
    assert.deepEqual(issuingSettingsAnswerOf([{ o_outcome: word, ...nulls(SETTINGS_COLS) }], TENANT_SCOPE, STORE), { outcome: word });
  }
  const faults: Array<[string, unknown]> = [
    ['no row', []], ['two rows', [settingsRow(), settingsRow()]], ['another tenant', [settingsRow({ o_tenant_id: randomUUID() })]],
    ['another store', [settingsRow({ o_store_id: randomUUID() })]], ['none at version 1', [{ o_outcome: 'none', ...nulls(SETTINGS_COLS), o_tenant_id: TENANT, o_store_id: STORE, o_version: '1' }]],
    ['none with a name', [{ o_outcome: 'none', ...nulls(SETTINGS_COLS), o_tenant_id: TENANT, o_store_id: STORE, o_version: '0', o_legal_name: 'A' }]],
    ['a rate under none', [settingsRow({ o_tax_mode: 'none', o_tax_rate: 0 })]], ['no rate under exclusive', [settingsRow({ o_tax_rate: null })]],
    ['a rate past 100 %', [settingsRow({ o_tax_rate: 100_001 })]], ['version 0 configured', [settingsRow({ o_version: '0' })]],
    ['a numeric version', [settingsRow({ o_version: 3 })]], ['a padded name', [settingsRow({ o_legal_name: 'Acme ' })]],
    ['a refusal naming the tenant', [{ o_outcome: 'denied', ...nulls(SETTINGS_COLS), o_tenant_id: TENANT }]], ['another word', [{ o_outcome: 'invalid', ...nulls(SETTINGS_COLS) }]],
    ['an extra column', [{ ...settingsRow(), o_created_at: AT }]],
  ];
  for (const [label, rows] of faults) assert.throws(() => issuingSettingsAnswerOf(rows, TENANT_SCOPE, STORE), /invoice issuing answer invalid/, label);
});

const LINE_COLS = ['o_position', 'o_description', 'o_quantity', 'o_unit_price_cents', 'o_line_total_cents'];
const PREVIEW_HEADER_COLS = ['o_tenant_id', 'o_store_id', 'o_draft_id', 'o_draft_version', 'o_customer_id', 'o_customer_name', 'o_customer_version', 'o_settings_version',
  'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id', 'o_tax_mode', 'o_tax_rate', 'o_currency', 'o_line_count', 'o_subtotal_cents', 'o_tax_cents',
  'o_total_cents'];
const previewRow = (position: number, over: Record<string, unknown> = {}) => ({
  o_outcome: 'line', o_tenant_id: TENANT, o_store_id: STORE, o_draft_id: DRAFT, o_draft_version: '2', o_customer_id: CUSTOMER, o_customer_name: 'Dana Customer',
  o_customer_version: '4', o_settings_version: '3', o_legal_name: 'Acme Repairs LLC', o_store_name: 'Acme Downtown', o_postal_address: '1 Main St', o_tax_registration_id: 'TX-1',
  o_tax_mode: 'exclusive_rate', o_tax_rate: 5000, o_currency: 'USD', o_line_count: 2, o_subtotal_cents: '20', o_tax_cents: '1', o_total_cents: '21',
  o_position: position, o_description: `Line ${position}`, o_quantity: '1', o_unit_price_cents: '10', o_line_total_cents: '10', ...over,
});

test('ISS-P08 the preview\'s rows: one header on every line row, positions 1..n, the tax and total the runtime derives; each refusal; anything else a fault', () => {
  const answer = invoiceIssuePreviewAnswerOf([previewRow(1), previewRow(2)], STORE_SCOPE, DRAFT) as { preview: Record<string, unknown> };
  assert.deepEqual(answer.preview, {
    draft: { id: DRAFT, version: 2, subtotalCents: 20, lines: [
      { position: 1, description: 'Line 1', quantity: 1, unitPriceCents: 10, lineTotalCents: 10 }, { position: 2, description: 'Line 2', quantity: 1, unitPriceCents: 10, lineTotalCents: 10 },
    ] },
    customer: { id: CUSTOMER, name: 'Dana Customer', version: 4 },
    issuingSettings: { version: 3, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St', taxRegistrationId: 'TX-1',
      tax: { mode: 'exclusive_rate', rateMilliPercent: 5000 } },
    currency: 'USD', taxCents: 1, totalCents: 21,
  });
  for (const word of ['denied', 'not_found', 'invalid_state', 'issuing_not_configured', 'amount_out_of_range']) {
    assert.deepEqual(invoiceIssuePreviewAnswerOf([{ o_outcome: word, ...nulls([...PREVIEW_HEADER_COLS, ...LINE_COLS]) }], STORE_SCOPE, DRAFT), { outcome: word });
  }
  const none = { o_tax_mode: 'none', o_tax_rate: null, o_tax_cents: null, o_total_cents: '20' };
  assert.ok(invoiceIssuePreviewAnswerOf([previewRow(1, none), previewRow(2, none)], STORE_SCOPE, DRAFT));
  const faults: Array<[string, unknown]> = [
    ['no row', []], ['another tenant', [previewRow(1, { o_tenant_id: randomUUID() }), previewRow(2, { o_tenant_id: randomUUID() })]],
    ['another draft', [previewRow(1, { o_draft_id: randomUUID() }), previewRow(2)]], ['headers differ', [previewRow(1), previewRow(2, { o_customer_name: 'Other' })]],
    ['a line missing', [previewRow(1)]], ['out of order', [previewRow(2), previewRow(1)]], ['the tax per line', [previewRow(1, { o_tax_cents: '2', o_total_cents: '22' }),
      previewRow(2, { o_tax_cents: '2', o_total_cents: '22' })]], ['a refusal with a value', [{ o_outcome: 'denied', ...nulls([...PREVIEW_HEADER_COLS, ...LINE_COLS]), o_draft_id: DRAFT }]],
    ['a refusal beside a line', [{ o_outcome: 'denied', ...nulls([...PREVIEW_HEADER_COLS, ...LINE_COLS]) }, previewRow(1)]],
    ['an unsafe subtotal', [previewRow(1, { o_subtotal_cents: '9007199254740992' }), previewRow(2, { o_subtotal_cents: '9007199254740992' })]],
    ['a numeric amount', [previewRow(1, { o_quantity: 1 }), previewRow(2)]], ['an extra column', [{ ...previewRow(1), o_issued_by: ACTOR }, previewRow(2)]],
  ];
  for (const [label, rows] of faults) assert.throws(() => invoiceIssuePreviewAnswerOf(rows, STORE_SCOPE, DRAFT), /invoice issuing answer invalid/, label);
});

const PAGE_COLS = ['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_number', 'o_source_draft_id', 'o_customer_id', 'o_customer_name', 'o_currency', 'o_total_cents',
  'o_issued_at', 'o_snapshot_version'];
const I = (i: number): string => `${(0x40000000 - i).toString(16)}-0000-4000-8000-${(700_000 - i).toString(16).padStart(12, '0')}`;
const pageRow = (i: number, over: Record<string, unknown> = {}) => ({
  o_outcome: 'invoice', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: I(i), o_number: String(100 - i), o_source_draft_id: randomUUID(), o_customer_id: CUSTOMER,
  o_customer_name: 'Dana Customer', o_currency: 'USD', o_total_cents: '2176', o_issued_at: AT, o_snapshot_version: 1, ...over,
});

test('ISS-P09 the issued page\'s rows: the look-ahead judged then dropped, hasMore only from it; refusals; the filter alone; anything else a fault', () => {
  const page = issuedInvoicePageAnswerOf([pageRow(1), pageRow(2), pageRow(3)], STORE_SCOPE, { after: null, sourceDraft: null, limit: 2 }) as { invoices: unknown[]; hasMore: boolean };
  assert.deepEqual([page.invoices.length, page.hasMore], [2, true]);
  assert.deepEqual((issuedInvoicePageAnswerOf([], STORE_SCOPE, { after: null, sourceDraft: null, limit: 2 }) as { invoices: unknown[] }).invoices, []);
  const filter = randomUUID();
  assert.deepEqual((issuedInvoicePageAnswerOf([pageRow(1, { o_source_draft_id: filter })], STORE_SCOPE, { after: null, sourceDraft: filter, limit: 1 }) as { hasMore: boolean }).hasMore, false);
  assert.deepEqual(issuedInvoicePageAnswerOf([{ o_outcome: 'denied', ...nulls(PAGE_COLS) }], STORE_SCOPE, { after: null, sourceDraft: null, limit: 2 }), { outcome: 'denied' });
  assert.deepEqual(issuedInvoicePageAnswerOf([{ o_outcome: 'cursor_unknown', ...nulls(PAGE_COLS) }], STORE_SCOPE, { after: I(0), sourceDraft: null, limit: 2 }), { outcome: 'cursor_unknown' });
  const faults: Array<[string, unknown, { after: string | null; sourceDraft: string | null; limit: number }]> = [
    ['more than limit + 1', [pageRow(1), pageRow(2), pageRow(3), pageRow(4)], { after: null, sourceDraft: null, limit: 2 }],
    ['the look-ahead out of order', [pageRow(1), pageRow(2), pageRow(0)], { after: null, sourceDraft: null, limit: 2 }],
    ['the look-ahead repeating a number', [pageRow(1), pageRow(2), pageRow(3, { o_number: '98' })], { after: null, sourceDraft: null, limit: 2 }],
    ['cursor_unknown without a cursor', [{ o_outcome: 'cursor_unknown', ...nulls(PAGE_COLS) }], { after: null, sourceDraft: null, limit: 2 }],
    ['two rows for the filter', [pageRow(1, { o_source_draft_id: filter }), pageRow(2, { o_source_draft_id: filter })], { after: null, sourceDraft: filter, limit: 1 }],
    ['another source draft for the filter', [pageRow(1)], { after: null, sourceDraft: filter, limit: 1 }],
    ['another store', [pageRow(1, { o_store_id: randomUUID() })], { after: null, sourceDraft: null, limit: 2 }],
    ['snapshot 2', [pageRow(1, { o_snapshot_version: 2 })], { after: null, sourceDraft: null, limit: 2 }],
    ['an issued time without microseconds', [pageRow(1, { o_issued_at: '2026-10-16T09:30:00Z' })], { after: null, sourceDraft: null, limit: 2 }],
    ['a row beside a refusal', [{ o_outcome: 'denied', ...nulls(PAGE_COLS) }, pageRow(1)], { after: null, sourceDraft: null, limit: 2 }],
  ];
  for (const [label, rows, query] of faults) assert.throws(() => issuedInvoicePageAnswerOf(rows, STORE_SCOPE, query), /invoice issuing answer invalid/, label);
});

const GET_HEADER_COLS = ['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_number', 'o_snapshot_version', 'o_issued_at', 'o_source_draft_id', 'o_source_draft_version',
  'o_settings_version', 'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id', 'o_customer_id', 'o_customer_name', 'o_customer_version', 'o_currency',
  'o_line_count', 'o_subtotal_cents', 'o_tax_mode', 'o_tax_rate', 'o_tax_cents', 'o_total_cents'];
const getRow = (position: number, over: Record<string, unknown> = {}) => ({
  o_outcome: 'line', o_tenant_id: TENANT, o_store_id: STORE, o_invoice_id: INVOICE, o_number: '7', o_snapshot_version: 1, o_issued_at: AT, o_source_draft_id: DRAFT,
  o_source_draft_version: '2', o_settings_version: '3', o_legal_name: 'Acme Repairs LLC', o_store_name: 'Acme Downtown', o_postal_address: '1 Main St', o_tax_registration_id: null,
  o_customer_id: CUSTOMER, o_customer_name: 'Dana Customer', o_customer_version: '4', o_currency: 'USD', o_line_count: 1, o_subtotal_cents: '1999', o_tax_mode: 'exclusive_rate',
  o_tax_rate: 8875, o_tax_cents: '177', o_total_cents: '2176', o_position: position, o_description: 'Screen', o_quantity: '1', o_unit_price_cents: '1999',
  o_line_total_cents: '1999', ...over,
});

test('ISS-P10 the issued get\'s rows: the snapshot as one header, its lines, the stored amounts the runtime derives; refusals; anything else a fault', () => {
  const answer = issuedInvoiceAnswerOf([getRow(1)], STORE_SCOPE, INVOICE) as { invoice: Record<string, unknown> };
  assert.deepEqual(answer.invoice, {
    id: INVOICE, number: 7, snapshotVersion: 1, issuedAt: AT, sourceDraft: { id: DRAFT, version: 2 },
    seller: { legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St', taxRegistrationId: null }, issuingSettingsVersion: 3,
    customer: { id: CUSTOMER, name: 'Dana Customer', version: 4 }, currency: 'USD', subtotalCents: 1999, tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 },
    taxCents: 177, totalCents: 2176, lines: [{ position: 1, description: 'Screen', quantity: 1, unitPriceCents: 1999, lineTotalCents: 1999 }],
  });
  for (const word of ['denied', 'not_found']) {
    assert.deepEqual(issuedInvoiceAnswerOf([{ o_outcome: word, ...nulls([...GET_HEADER_COLS, ...LINE_COLS]) }], STORE_SCOPE, INVOICE), { outcome: word });
  }
  const faults: Array<[string, unknown]> = [
    ['another invoice', [getRow(1, { o_invoice_id: randomUUID() })]], ['another tenant', [getRow(1, { o_tenant_id: randomUUID() })]],
    ['a tax off by one', [getRow(1, { o_tax_cents: '178', o_total_cents: '2177' })]], ['a line count off', [getRow(1, { o_line_count: 2 })]],
    ['snapshot 2', [getRow(1, { o_snapshot_version: 2 })]], ['an actor column', [{ ...getRow(1), o_issued_by: ACTOR }]], ['no row', []],
    ['a word for data', [getRow(1, { o_outcome: 'invoice' })]],
  ];
  for (const [label, rows] of faults) assert.throws(() => issuedInvoiceAnswerOf(rows, STORE_SCOPE, INVOICE), /invoice issuing answer invalid/, label);
});

/** A fake kernel recording each transaction's bounds and statements, answering every statement from `answer`. */
function kernel(answer: (text: string) => unknown) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const bounds: TransactionBounds[] = [];
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(_signal: AbortSignal, b: TransactionBounds, work: (scope: PgTransactionScope) => Promise<T>): Promise<T> => {
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

test('ISS-P11 the adapters: one statement each in one short read with the drafts\' bounds, the key and the TRUSTED tenant and store bound; refused before a statement otherwise', async () => {
  const k = kernel((text) => (text.includes('m7b_issuing_settings_get') ? [settingsRow()] : text.includes('m7b_invoice_issue_preview') ? [previewRow(1), previewRow(2)]
    : text.includes('m7b_issued_invoice_page') ? [pageRow(1)] : [getRow(1)]));
  const settings = createPostgresIssuingSettings({ client: k.client });
  const issuing = createPostgresInvoiceIssuing({ client: k.client });
  await settings.settings(TENANT_SCOPE, KEY, STORE, live());
  await issuing.preview(STORE_SCOPE, KEY, DRAFT, live());
  await issuing.page(STORE_SCOPE, KEY, { after: I(0), sourceDraft: null, limit: 5 }, live());
  await assert.rejects(async () => issuing.page(STORE_SCOPE, KEY, { after: null, sourceDraft: DRAFT, limit: 1 }, live()), /invoice issuing answer invalid/,
    'the filtered row\'s source draft differs: a fault');
  await issuing.invoice(STORE_SCOPE, KEY, INVOICE, live());
  assert.deepEqual(k.statements.map((s) => s.values), [
    [KEY, TENANT, STORE], [KEY, TENANT, STORE, DRAFT], [KEY, TENANT, STORE, I(0), null, 6], [KEY, TENANT, STORE, null, DRAFT, 2], [KEY, TENANT, STORE, INVOICE],
  ]);
  assert.match(k.statements[0].text, /from tmpos_invoice_issue\.m7b_issuing_settings_get\(\?::text, \?::uuid, \?::uuid\)$/);
  assert.match(k.statements[1].text, /from tmpos_invoice_issue\.m7b_invoice_issue_preview\(\?::text, \?::uuid, \?::uuid, \?::uuid\)$/);
  assert.match(k.statements[2].text, /from tmpos_invoice_issue\.m7b_issued_invoice_page\(\?::text, \?::uuid, \?::uuid, \?::uuid,\s+\?::uuid, \?::integer\)$/);
  assert.match(k.statements[4].text, /from tmpos_invoice_issue\.m7b_issued_invoice_get\(\?::text, \?::uuid, \?::uuid, \?::uuid\)$/);
  assert.ok(k.bounds.every((b) => b === INVOICE_DRAFT_READ_BOUNDS), 'the drafts\' read bounds');
  k.statements.length = 0;
  const refused: Array<[string, () => unknown]> = [
    ['settings at store scope', () => settings.settings(STORE_SCOPE, KEY, STORE, live())], ['settings with a short key', () => settings.settings(TENANT_SCOPE, 'k', STORE, live())],
    ['settings for a bad store', () => settings.settings(TENANT_SCOPE, KEY, 'x', live())], ['preview at tenant scope', () => issuing.preview(TENANT_SCOPE, KEY, DRAFT, live())],
    ['preview for a bad draft', () => issuing.preview(STORE_SCOPE, KEY, 'x', live())], ['a page past 50', () => issuing.page(STORE_SCOPE, KEY, { after: null, sourceDraft: null, limit: 51 }, live())],
    ['a filter beside a cursor', () => issuing.page(STORE_SCOPE, KEY, { after: I(0), sourceDraft: DRAFT, limit: 1 }, live())],
    ['a filter with a page of 2', () => issuing.page(STORE_SCOPE, KEY, { after: null, sourceDraft: DRAFT, limit: 2 }, live())],
    ['an invoice for a bad id', () => issuing.invoice(STORE_SCOPE, KEY, 'x', live())],
  ];
  for (const [label, call] of refused) await assert.rejects(async () => call(), /invoice issuing answer invalid/, label);
  assert.equal(k.statements.length, 0, 'no refused call sent a statement');
});

test('ISS-P11b the page read copies its query once: an extra key, or a getter whose value changes between reads, is refused before a statement', async () => {
  const k = kernel(() => [pageRow(1)]);
  const issuing = createPostgresInvoiceIssuing({ client: k.client });
  let reads = 0;
  const shifting = { after: null, sourceDraft: null } as Record<string, unknown>;
  Object.defineProperty(shifting, 'limit', { enumerable: true, get: () => (reads++ === 0 ? 5 : 1_000_000) });
  const refused: Array<[string, unknown]> = [
    ['an extra key', { after: null, sourceDraft: null, limit: 5, extra: true }],
    ['a getter that changes its value', shifting],
  ];
  for (const [label, query] of refused) {
    await assert.rejects(async () => issuing.page(STORE_SCOPE, KEY, query as never, live()), /invoice issuing answer invalid/, label);
  }
  assert.equal(reads, 0, 'the getter is never invoked');
  assert.equal(k.statements.length, 0, 'no statement');
  await issuing.page(STORE_SCOPE, KEY, { after: null, sourceDraft: null, limit: 5 }, live());
  assert.deepEqual(k.statements.map((s) => s.values), [[KEY, TENANT, STORE, null, null, 6]], 'the plain query still reads');
});

test('ISS-P12 readiness: the four reads\' one refusal of an absent key, in order, each all-null; anything else, or a throw, is false', async () => {
  const deniedFor = (text: string): unknown => {
    const cols = text.includes('m7b_issuing_settings_get') ? SETTINGS_COLS : text.includes('m7b_invoice_issue_preview') ? [...PREVIEW_HEADER_COLS, ...LINE_COLS]
      : text.includes('m7b_issued_invoice_page') ? PAGE_COLS : [...GET_HEADER_COLS, ...LINE_COLS];
    return [{ o_outcome: 'denied', ...nulls(cols) }];
  };
  const ready = kernel(deniedFor);
  assert.equal(await probeInvoiceIssuing(ready.client, live()), true);
  assert.deepEqual(ready.statements.map((s) => /m7b_\w+/.exec(s.text)?.[0]),
    ['m7b_issuing_settings_get', 'm7b_invoice_issue_preview', 'm7b_issued_invoice_page', 'm7b_issued_invoice_get']);
  assert.ok(ready.statements.every((s) => typeof s.values[0] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s.values[0] as string)), 'a random key of the session-key shape');
  assert.deepEqual(ready.statements[2].values.slice(3), [null, null, 1]);
  const notFound = kernel((text) => (text.includes('m7b_issued_invoice_get') ? [{ o_outcome: 'not_found', ...nulls([...GET_HEADER_COLS, ...LINE_COLS]) }] : deniedFor(text)));
  assert.equal(await probeInvoiceIssuing(notFound.client, live()), false);
  const shortCircuit = kernel((text) => (text.includes('m7b_issuing_settings_get') ? [] : deniedFor(text)));
  assert.equal(await probeInvoiceIssuing(shortCircuit.client, live()), false);
  assert.equal(shortCircuit.statements.length, 1, 'nothing more is asked once one read is not ready');
  const throwing = kernel(() => { throw new Error('down'); });
  assert.equal(await probeInvoiceIssuing(throwing.client, live()), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await probeInvoiceIssuing(ready.client, aborted.signal), false);
});
