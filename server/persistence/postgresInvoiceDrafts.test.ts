// Phase 4.0 M7B-INVOICES-P1 — the PostgreSQL side of invoice drafts, DATABASE-FREE: what the save's mutator hands migration
// 032's create (031's, with the Customers level guarded too: M7B-INVOICES-P1-R4) and how it reads the one row back; what the
// reads hand 028's page and get and what they refuse to read back as an answer; and the readiness probe. The routines
// themselves are proved against a real cluster (tests/db/invoiceDraftRoutine.integration.test.mjs,
// tests/db/invoiceDraftsHttp.integration.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  INVOICE_DRAFT_CREATE_MUTATOR, INVOICE_DRAFT_READ_BOUNDS, INVOICE_DRAFT_UPDATE_MUTATOR, createPostgresInvoiceDrafts, invoiceDraftAnswerOf, invoiceDraftPageAnswerOf,
  probeInvoiceDrafts,
} from './postgresInvoiceDrafts.js';
import type { MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import type { TrustedScope } from '../runtime/principals.js';

const SESSION_KEY = 'k'.repeat(43);
const TENANT = randomUUID();
const STORE = randomUUID();
const OTHER = randomUUID();
const ACTOR = randomUUID();
const MEMBERSHIP = randomUUID();
const CUSTOMER = randomUUID();
const DRAFT = randomUUID();
const AT = '2026-10-04T12:00:00.000001Z';
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv', scope: 'store', tenant: TENANT, store: STORE, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});
const live = (): AbortSignal => new AbortController().signal;
/** Draft ids in descending order of i (newest first, id descending). */
const D = (i: number): string => `${(0x60000000 - i).toString(16)}-0000-4000-8000-${(900_000 - i).toString(16).padStart(12, '0')}`;

// --- the mutator ----------------------------------------------------------------------------------------------------------

function recorder(rows: unknown[]): { sql: PgStatement; texts: string[]; values: unknown[][] } {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    texts.push(strings.join('?'));
    values.push(args);
    return Promise.resolve(rows);
  }) as unknown as PgStatement;
  return { sql, texts, values };
}
const LINES = Object.freeze([Object.freeze({ description: 'Glass', quantity: 2, unitPriceCents: 50 }), Object.freeze({ description: 'Labour', quantity: 1, unitPriceCents: 0 })]);
const mutation = (over: Record<string, unknown> = {}): TransactionMutation => Object.freeze({
  kind: 'store.invoice_draft.create', aggregateType: 'invoice_draft', aggregateId: DRAFT, expectedVersion: null,
  changes: Object.freeze({ storeId: STORE, expectedTenant: TENANT, customerId: CUSTOMER, subtotalCents: 100, lines: LINES, ...over }),
});
const authority = (over: Partial<TrustedScope> = {}, key: string | null = SESSION_KEY): MutationAuthority =>
  Object.freeze({ context: Object.freeze({ ...SCOPE, ...over }), sessionKey: key, authNotAfter: null });
const row = (outcome: string, over: Record<string, unknown> = {}) => (outcome === 'applied'
  ? { o_outcome: outcome, o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, ...over }
  : { o_outcome: outcome, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, ...over });

test('AC-01 AC-06: the mutator is the store-scope create; ONE fixed call binding the key, the REVALIDATED store, the new id, the precondition, the customer, the lines as one jsonb text and the subtotal', async () => {
  assert.deepEqual([INVOICE_DRAFT_CREATE_MUTATOR.kind, INVOICE_DRAFT_CREATE_MUTATOR.mode, INVOICE_DRAFT_CREATE_MUTATOR.aggregateType, INVOICE_DRAFT_CREATE_MUTATOR.contextScope],
    ['store.invoice_draft.create', 'create', 'invoice_draft', 'store']);
  const r = recorder([row('applied')]);
  assert.equal(await INVOICE_DRAFT_CREATE_MUTATOR.apply(r.sql, mutation(), authority()), 'applied');
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /^select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id\s+from tmpos_invoice_edit\.m7b_invoice_draft_create_v3\(\?::text, \?::uuid, \?::uuid,\s+\?::uuid, \?::uuid, \?::text::jsonb, \?::bigint\)$/);
  assert.deepEqual(r.values[0], [SESSION_KEY, STORE, DRAFT, TENANT, CUSTOMER,
    '[{"description":"Glass","quantity":2,"unitPriceCents":50},{"description":"Labour","quantity":1,"unitPriceCents":0}]', '100']);
});

test('AC-02 AC-05: the routine\'s one row decides the answer — applied only for exactly the revalidated identities; tenant_mismatch the precondition; customer_not_found and refused passed through; anything else a mismatch', async () => {
  const cases: Array<[string, unknown[], string]> = [
    ['applied', [row('applied')], 'applied'], ['another tenant', [row('applied', { o_tenant_id: randomUUID() })], 'mismatch'],
    ['another store', [row('applied', { o_store_id: OTHER })], 'mismatch'], ['another actor', [row('applied', { o_actor_id: randomUUID() })], 'mismatch'],
    ['another grant', [row('applied', { o_membership_id: randomUUID() })], 'mismatch'],
    ['tenant_mismatch', [row('tenant_mismatch')], 'precondition_failed'], ['customer_not_found', [row('customer_not_found')], 'customer_not_found'],
    ['refused', [row('refused')], 'refused'], ['a refusal naming a tenant', [row('refused', { o_tenant_id: TENANT })], 'mismatch'],
    ['an unknown word', [row('conflict')], 'mismatch'], ['no row', [], 'mismatch'], ['two rows', [row('applied'), row('applied')], 'mismatch'],
    ['an extra column', [{ ...row('applied'), o_extra: 1 }], 'mismatch'],
  ];
  for (const [label, rows, expected] of cases) assert.equal(await INVOICE_DRAFT_CREATE_MUTATOR.apply(recorder(rows).sql, mutation(), authority()), expected, label);
  // Never a call without the revalidated STORE context and its key, or for a path store that is not the trusted one.
  for (const [label, m, a] of [
    ['no authority', mutation(), undefined], ['a tenant context', mutation(), authority({ scope: 'tenant', store: null })],
    ['no key', mutation(), authority({}, null)], ['the path store is not the trusted store', mutation({ storeId: OTHER }), authority()],
    ['a non-uuid customer', mutation({ customerId: 'x' }), authority()], ['no lines', mutation({ lines: [] }), authority()],
    ['a string subtotal', mutation({ subtotalCents: '100' }), authority()],
  ] as const) {
    const r = recorder([row('applied')]);
    assert.equal(await INVOICE_DRAFT_CREATE_MUTATOR.apply(r.sql, m, a), 'unavailable', label);
    assert.equal(r.texts.length, 0, `${label}: no statement`);
  }
});

// --- the edit's mutator (M7B-INVOICES-P2) ---------------------------------------------------------------------------------

const MAX = Number.MAX_SAFE_INTEGER;
const updateMutation = (expectedVersion: unknown = 4, over: Record<string, unknown> = {}): TransactionMutation => Object.freeze({
  kind: 'store.invoice_draft.update', aggregateType: 'invoice_draft', aggregateId: DRAFT, expectedVersion: expectedVersion as number,
  changes: Object.freeze({ storeId: STORE, expectedTenant: TENANT, customerId: CUSTOMER, subtotalCents: 100, lines: LINES, ...over }),
});
const updateRow = (outcome: string, version: string | null, over: Record<string, unknown> = {}) => (outcome === 'applied' || outcome === 'unchanged'
  ? { o_outcome: outcome, o_tenant_id: TENANT, o_store_id: STORE, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_version: version, ...over }
  : { o_outcome: outcome, o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: version, ...over });

test('M7B-INVOICES-P2 AC-05: the edit\'s mutator is the store-scope update; ONE fixed call binding the key, the REVALIDATED store, the draft, the precondition, the expected version as bigint text, the customer, the lines as one jsonb text and the subtotal', async () => {
  assert.deepEqual([INVOICE_DRAFT_UPDATE_MUTATOR.kind, INVOICE_DRAFT_UPDATE_MUTATOR.mode, INVOICE_DRAFT_UPDATE_MUTATOR.aggregateType, INVOICE_DRAFT_UPDATE_MUTATOR.contextScope],
    ['store.invoice_draft.update', 'update', 'invoice_draft', 'store']);
  assert.ok(Object.isFrozen(INVOICE_DRAFT_UPDATE_MUTATOR), 'frozen');
  const r = recorder([updateRow('applied', '5')]);
  assert.equal(await INVOICE_DRAFT_UPDATE_MUTATOR.apply(r.sql, updateMutation(), authority()), 'applied');
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /^select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version\s+from tmpos_invoice_edit\.m7b_invoice_draft_update_v2\(\?::text, \?::uuid, \?::uuid,\s+\?::uuid, \?::bigint, \?::uuid, \?::text::jsonb, \?::bigint\)$/);
  assert.deepEqual(r.values[0], [SESSION_KEY, STORE, DRAFT, TENANT, '4', CUSTOMER,
    '[{"description":"Glass","quantity":2,"unitPriceCents":50},{"description":"Labour","quantity":1,"unitPriceCents":0}]', '100']);
  // The largest expected version binds exactly, as text: 2^53 - 2, never through a float.
  const top = recorder([updateRow('applied', String(MAX))]);
  assert.equal(await INVOICE_DRAFT_UPDATE_MUTATOR.apply(top.sql, updateMutation(MAX - 1), authority()), 'applied');
  assert.equal(top.values[0][4], String(MAX - 1));
});

test('M7B-INVOICES-P2 AC-05 AC-06 AC-07 AC-10: the edit routine\'s one row decides — applied at expected + 1 and unchanged at expected only for exactly the revalidated identities; every refusal names nothing; tenant_mismatch the precondition; anything else a mismatch', async () => {
  const cases: Array<[string, unknown[], string]> = [
    ['applied', [updateRow('applied', '5')], 'applied'], ['unchanged', [updateRow('unchanged', '4')], 'unchanged'],
    ['applied at the expected version', [updateRow('applied', '4')], 'mismatch'], ['applied two ahead', [updateRow('applied', '6')], 'mismatch'],
    ['applied with a numeric version', [updateRow('applied', 5 as never)], 'mismatch'], ['applied without a version', [updateRow('applied', null)], 'mismatch'],
    ['unchanged one ahead', [updateRow('unchanged', '5')], 'mismatch'], ['unchanged without a version', [updateRow('unchanged', null)], 'mismatch'],
    ['applied for another tenant', [updateRow('applied', '5', { o_tenant_id: randomUUID() })], 'mismatch'],
    ['applied at another store', [updateRow('applied', '5', { o_store_id: OTHER })], 'mismatch'],
    ['applied by another actor', [updateRow('applied', '5', { o_actor_id: randomUUID() })], 'mismatch'],
    ['applied under another grant', [updateRow('applied', '5', { o_membership_id: randomUUID() })], 'mismatch'],
    ['unchanged for another tenant', [updateRow('unchanged', '4', { o_tenant_id: randomUUID() })], 'mismatch'],
    ['unchanged naming no one', [updateRow('unchanged', '4', { o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null })], 'mismatch'],
    ['conflict', [updateRow('conflict', null)], 'conflict'], ['invalid_state', [updateRow('invalid_state', null)], 'invalid_state'],
    ['not_found', [updateRow('not_found', null)], 'not_found'], ['refused', [updateRow('refused', null)], 'refused'],
    ['tenant_mismatch', [updateRow('tenant_mismatch', null)], 'precondition_failed'],
    ['a conflict naming a version', [updateRow('conflict', '4')], 'mismatch'], ['a conflict naming a tenant', [updateRow('conflict', null, { o_tenant_id: TENANT })], 'mismatch'],
    ['a not_found naming a store', [updateRow('not_found', null, { o_store_id: STORE })], 'mismatch'],
    ['a refusal naming an actor', [updateRow('refused', null, { o_actor_id: ACTOR })], 'mismatch'],
    ['a tenant_mismatch naming a grant', [updateRow('tenant_mismatch', null, { o_membership_id: MEMBERSHIP })], 'mismatch'],
    ['the create\'s word', [updateRow('customer_not_found', null)], 'mismatch'], ['an unknown word', [updateRow('denied', null)], 'mismatch'],
    ['no row', [], 'mismatch'], ['two rows', [updateRow('applied', '5'), updateRow('applied', '5')], 'mismatch'],
    ['an extra column', [{ ...updateRow('applied', '5'), o_extra: 1 }], 'mismatch'], ['the create\'s columns', [row('applied')], 'mismatch'],
  ];
  for (const [label, rows, expected] of cases) assert.equal(await INVOICE_DRAFT_UPDATE_MUTATOR.apply(recorder(rows).sql, updateMutation(), authority()), expected, label);
  // Never a call without the revalidated STORE context and its key, for a path store that is not the trusted one, or for a
  // version outside 1..2^53 - 2.
  for (const [label, m, a] of [
    ['no authority', updateMutation(), undefined], ['a tenant context', updateMutation(), authority({ scope: 'tenant', store: null })],
    ['no key', updateMutation(), authority({}, null)], ['the path store is not the trusted store', updateMutation(4, { storeId: OTHER }), authority()],
    ['a non-uuid customer', updateMutation(4, { customerId: 'x' }), authority()], ['a non-uuid tenant', updateMutation(4, { expectedTenant: 'x' }), authority()],
    ['no lines', updateMutation(4, { lines: [] }), authority()], ['a string subtotal', updateMutation(4, { subtotalCents: '100' }), authority()],
    ['version 0', updateMutation(0), authority()], ['version 2^53 - 1', updateMutation(MAX), authority()], ['version null', updateMutation(null), authority()],
    ['version 1.5', updateMutation(1.5), authority()], ['version as text', updateMutation('4'), authority()],
  ] as const) {
    const r = recorder([updateRow('applied', '5')]);
    assert.equal(await INVOICE_DRAFT_UPDATE_MUTATOR.apply(r.sql, m, a), 'unavailable', label);
    assert.equal(r.texts.length, 0, `${label}: no statement`);
  }
});

// --- the reads -----------------------------------------------------------------------------------------------------------

interface Fake extends SupervisedPgClient { readonly statements: string[]; readonly values: unknown[][]; readonly bounds: unknown[] }
function fakeClient(answers: unknown[] | ((i: number) => unknown), fault?: Error): Fake {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const bounds: unknown[] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    const i = statements.length - 1;
    return fault ? Promise.reject(fault) : Promise.resolve((typeof answers === 'function' ? answers(i) : answers) as never);
  }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements, values, bounds,
    transaction: (<T>(_signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => { bounds.push(b); return work(sql); }) as never,
    end: async () => undefined,
  }) as never;
}
const pageRow = (i: number, over: Record<string, unknown> = {}) => ({
  o_outcome: 'draft', o_tenant_id: TENANT, o_store_id: STORE, o_draft_id: D(i), o_customer_id: CUSTOMER, o_status: 'draft', o_currency: 'USD',
  o_line_count: 2, o_subtotal_cents: '100', o_created_at: AT, ...over,
});
const PAGE_NULLS = { o_tenant_id: null, o_store_id: null, o_draft_id: null, o_customer_id: null, o_status: null, o_currency: null, o_line_count: null, o_subtotal_cents: null, o_created_at: null };
const getRow = (position: number, over: Record<string, unknown> = {}) => ({
  o_outcome: 'draft', o_tenant_id: TENANT, o_store_id: STORE, o_draft_id: DRAFT, o_customer_id: CUSTOMER, o_status: 'draft', o_currency: 'USD',
  o_version: '1', o_created_at: AT, o_line_count: 2, o_subtotal_cents: '9007199254740991', o_position: position,
  o_description: position === 1 ? 'Glass' : 'Labour', o_quantity: position === 1 ? '9007199254740991' : '1', o_unit_price_cents: position === 1 ? '1' : '0',
  o_line_total_cents: position === 1 ? '9007199254740991' : '0', ...over,
});
const GET_NULLS = Object.fromEntries(Object.keys(getRow(1)).filter((k) => k !== 'o_outcome').map((k) => [k, null]));

test('AC-12: the page is ONE fixed call with the key and the TRUSTED tenant and store, the anchor id and limit + 1; rows become the page, the lookahead hasMore', async () => {
  const client = fakeClient([pageRow(1), pageRow(2), pageRow(3)]);
  const answer = await createPostgresInvoiceDrafts({ client }).page(SCOPE, SESSION_KEY, { after: D(0), limit: 2 }, live());
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], /from tmpos_invoice_draft\.m7b_invoice_draft_page\(\?::text, \?::uuid, \?::uuid, \?::uuid,\s+\?::integer\)$/);
  assert.deepEqual(client.values[0], [SESSION_KEY, TENANT, STORE, D(0), 3]);
  assert.equal(client.bounds[0], INVOICE_DRAFT_READ_BOUNDS);
  assert.deepEqual(answer, { outcome: 'page', hasMore: true, drafts: [1, 2].map((i) => ({
    id: D(i), customerId: CUSTOMER, status: 'draft', currency: 'USD', lineCount: 2, subtotalCents: 100, createdAt: AT,
  })) });
  assert.deepEqual(await createPostgresInvoiceDrafts({ client: fakeClient([]) }).page(SCOPE, SESSION_KEY, { after: null, limit: 20 }, live()),
    { outcome: 'page', drafts: [], hasMore: false }, 'no row: an empty page');
  assert.deepEqual(invoiceDraftPageAnswerOf([{ o_outcome: 'denied', ...PAGE_NULLS }], SCOPE, { after: null, limit: 5 }), { outcome: 'denied' });
  assert.deepEqual(invoiceDraftPageAnswerOf([{ o_outcome: 'cursor_unknown', ...PAGE_NULLS }], SCOPE, { after: D(1), limit: 5 }), { outcome: 'cursor_unknown' });
});

test('AC-02 AC-12: every row out of shape — another tenant or store above all — is a throw, never a page or a refusal', () => {
  const q = { after: null, limit: 2 };
  const cases: Array<[string, unknown, typeof q | { after: string; limit: number }]> = [
    ['another store', [pageRow(1, { o_store_id: OTHER })], q], ['another tenant', [pageRow(1, { o_tenant_id: randomUUID() })], q],
    ['more than limit + 1', [pageRow(1), pageRow(2), pageRow(3), pageRow(4)], q], ['out of order', [pageRow(2), pageRow(1)], q],
    ['a draft twice', [pageRow(1), pageRow(1)], q], ['the anchor back', [pageRow(1)], { after: D(1), limit: 2 }],
    ['a float amount', [pageRow(1, { o_subtotal_cents: 100 })], q], ['an unsafe amount', [pageRow(1, { o_subtotal_cents: '9007199254740992' })], q],
    ['another status', [pageRow(1, { o_status: 'issued' })], q], ['a millisecond time', [pageRow(1, { o_created_at: '2026-10-04T12:00:00.000Z' })], q],
    ['invalid', [{ o_outcome: 'invalid', ...PAGE_NULLS }], q], ['cursor_unknown without a cursor', [{ o_outcome: 'cursor_unknown', ...PAGE_NULLS }], q],
    ['a refusal naming a store', [{ o_outcome: 'denied', ...PAGE_NULLS, o_store_id: STORE }], q], ['a refusal beside a draft', [{ o_outcome: 'denied', ...PAGE_NULLS }, pageRow(1)], q],
    ['an extra column', [{ ...pageRow(1), o_role_id: 'manager' }], q], ['not an array', { rows: [] }, q],
  ];
  for (const [label, rows, query] of cases) assert.throws(() => invoiceDraftPageAnswerOf(rows, SCOPE, query), /invoice draft answer invalid/, label);
});

test('AC-02 AC-06: the get is ONE fixed call; its rows become the draft with exact amounts up to 2^53 - 1; missing and foreign alike pass as not_found; every inconsistency a throw', async () => {
  const client = fakeClient([getRow(1), getRow(2)]);
  const answer = await createPostgresInvoiceDrafts({ client }).get(SCOPE, SESSION_KEY, DRAFT, live());
  assert.match(client.statements[0], /from tmpos_invoice_draft\.m7b_invoice_draft_get\(\?::text, \?::uuid, \?::uuid, \?::uuid\)$/);
  assert.deepEqual(client.values[0], [SESSION_KEY, TENANT, STORE, DRAFT]);
  assert.deepEqual(answer, { outcome: 'draft', draft: {
    id: DRAFT, storeId: STORE, customerId: CUSTOMER, status: 'draft', currency: 'USD', version: 1, createdAt: AT, subtotalCents: 9007199254740991, lines: [
      { position: 1, description: 'Glass', quantity: 9007199254740991, unitPriceCents: 1, lineTotalCents: 9007199254740991 },
      { position: 2, description: 'Labour', quantity: 1, unitPriceCents: 0, lineTotalCents: 0 },
    ],
  } });
  for (const word of ['not_found', 'denied']) assert.deepEqual(invoiceDraftAnswerOf([{ o_outcome: word, ...GET_NULLS }], SCOPE, DRAFT), { outcome: word });
  // M7B-INVOICES-P2: an edited draft's version is any safe integer from 1, read exactly from its bigint text.
  for (const version of ['2', '17', '9007199254740991']) {
    const edited = invoiceDraftAnswerOf([getRow(1, { o_version: version }), getRow(2, { o_version: version })], SCOPE, DRAFT) as { draft: { version: unknown } };
    assert.equal(edited.draft.version, Number(version), version);
  }
  const cases: Array<[string, unknown]> = [
    ['another store', [getRow(1, { o_store_id: OTHER }), getRow(2, { o_store_id: OTHER })]], ['another draft', [getRow(1, { o_draft_id: D(1) }), getRow(2, { o_draft_id: D(1) })]],
    ['a header that differs between rows', [getRow(1), getRow(2, { o_customer_id: randomUUID() })]], ['a missing line', [getRow(1)]],
    ['positions out of order', [getRow(2), getRow(1)]], ['a wrong line total', [getRow(1, { o_line_total_cents: '1' }), getRow(2)]],
    ['a subtotal not the sum', [getRow(1, { o_subtotal_cents: '1' }), getRow(2, { o_subtotal_cents: '1' })]],
    ['version 0', [getRow(1, { o_version: '0' }), getRow(2, { o_version: '0' })]], ['version 2^53', [getRow(1, { o_version: '9007199254740992' }), getRow(2, { o_version: '9007199254740992' })]],
    ['version as a number', [getRow(1, { o_version: 2 }), getRow(2, { o_version: 2 })]], ['version 01', [getRow(1, { o_version: '01' }), getRow(2, { o_version: '01' })]],
    ['a version that differs between rows', [getRow(1, { o_version: '2' }), getRow(2, { o_version: '3' })]],
    ['a control in a description', [getRow(1, { o_description: 'a\u0007' }), getRow(2)]],
    ['no row', []], ['invalid', [{ o_outcome: 'invalid', ...GET_NULLS }]], ['a refusal naming the draft', [{ o_outcome: 'not_found', ...GET_NULLS, o_draft_id: DRAFT }]],
  ];
  for (const [label, rows] of cases) assert.throws(() => invoiceDraftAnswerOf(rows, SCOPE, DRAFT), /invoice draft answer invalid/, label);
});

test('AC-02: a read is refused before any statement for anything but the trusted store scope, a key of the store-key shape and validated values', async () => {
  const port = (client: Fake) => createPostgresInvoiceDrafts({ client });
  const calls: Array<[string, (c: Fake) => unknown]> = [
    ['a tenant scope', (c) => port(c).page({ ...SCOPE, scope: 'tenant', store: null }, SESSION_KEY, { after: null, limit: 5 }, live())],
    ['a malformed key', (c) => port(c).page(SCOPE, 'k'.repeat(42), { after: null, limit: 5 }, live())],
    ['limit 51', (c) => port(c).page(SCOPE, SESSION_KEY, { after: null, limit: 51 }, live())],
    ['a malformed anchor', (c) => port(c).page(SCOPE, SESSION_KEY, { after: 'x', limit: 5 }, live())],
    ['a malformed draft id', (c) => port(c).get(SCOPE, SESSION_KEY, DRAFT.toUpperCase(), live())],
    ['a scope that is no scope', (c) => port(c).get({ ...SCOPE, actor: 7 } as never, SESSION_KEY, DRAFT, live())],
  ];
  for (const [label, call] of calls) {
    const client = fakeClient([]);
    await assert.rejects(Promise.resolve(call(client)), /invoice draft answer invalid/, label);
    assert.equal(client.statements.length, 0, label);
  }
  await assert.rejects(Promise.resolve(port(fakeClient([], new Error('connection to secret-host refused'))).page(SCOPE, SESSION_KEY, { after: null, limit: 5 }, live())), /secret-host/,
    'a driver fault propagates as an outage (the route answers a bounded 503)');
});

test('readiness: true only when both reads refuse a random key with their one denied row; anything else false', async () => {
  const both = (i: number) => (i === 0 ? [{ o_outcome: 'denied', ...PAGE_NULLS }] : [{ o_outcome: 'denied', ...GET_NULLS }]);
  const client = fakeClient(both);
  assert.equal(await probeInvoiceDrafts(client, live()), true);
  assert.equal(client.statements.length, 2);
  assert.match(client.statements[0], /m7b_invoice_draft_page\(/);
  assert.match(client.statements[1], /m7b_invoice_draft_get\(/);
  assert.match(String(client.values[0][0]), /^[A-Za-z0-9_-]{43}$/, 'a random key of the store-key shape');
  assert.equal(await probeInvoiceDrafts(fakeClient((i) => (i === 0 ? [{ o_outcome: 'denied', ...PAGE_NULLS }] : [{ o_outcome: 'invalid', ...GET_NULLS }])), live()), false);
  assert.equal(await probeInvoiceDrafts(fakeClient([pageRow(1)]), live()), false);
  assert.equal(await probeInvoiceDrafts(fakeClient([], new Error('down')), live()), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await probeInvoiceDrafts(fakeClient(both), aborted.signal), false);
});
