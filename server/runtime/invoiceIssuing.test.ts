// Phase 4.0 M7B-INVOICES-ISSUE-P1 — issuing through the runtime, DATABASE-FREE: the issue's contract and route as the runtime
// registers them, its planner's closed input and sealed 201 with its Location; the exact BigInt tax and totals (§10.8's
// examples: 1999 x 8875, two 10-cent lines at 5000, the half-cent tie, an explicit 0 rate against 'none', the largest valid
// totals and the first overflowing ones); the preview's, the issued list's and the issued detail's strict answer validation,
// the cursor and the query; and each read handler's outcomes. Synthetic ports only. The PostgreSQL side is proved in
// server/persistence/postgresInvoiceIssuing.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defineCommands } from './commandTransaction.js';
import {
  INVOICE_ISSUE_CONTRACT, INVOICE_ISSUE_ELIGIBILITY_PATH, INVOICE_ISSUE_PATH, INVOICE_ISSUE_PREVIEW_PATH, INVOICE_ISSUE_REQUIREMENT, INVOICE_ISSUE_ROUTE,
  ISSUED_INVOICES_PATH, ISSUED_INVOICE_PATH, ISSUED_INVOICE_VIEW_REQUIREMENT, createInvoiceIssueEligibilityRoute, createInvoiceIssuePreviewRoute,
  createIssuedInvoiceDetailRoute, createIssuedInvoiceListRoute, decodeIssuedInvoiceCursor, encodeIssuedInvoiceCursor, invoiceIssuePreviewOf, invoiceLinesOf,
  invoiceTaxOf, issueAmountsOf, issuedInvoiceOf, issuedInvoicePageOf, parseIssuedInvoiceListQuery, planInvoiceIssue,
} from './invoiceIssuing.js';
import type { InvoiceIssueReadPort, IssuedInvoiceListQuery } from './invoiceIssuing.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { COMMAND_REQUEST_INVALID, EnforcementSetupError } from './routes.js';
import type { RouteDefinition } from './routes.js';

const MAX = Number.MAX_SAFE_INTEGER;
const TENANT = randomUUID();
const STORE = randomUUID();
const DRAFT = randomUUID();
const INVOICE = randomUUID();
const CUSTOMER = randomUUID();
const KEY = 'k'.repeat(43);
const AT = '2026-10-16T09:30:00.123456Z';
const SCOPE: TrustedScope = Object.freeze({
  actor: randomUUID(), securityVersion: 'sv', scope: 'store', tenant: TENANT, store: STORE, membershipId: randomUUID(), roleId: 'manager', limitation: 'none',
});
const issueBody = (over: Record<string, unknown> = {}) => ({ expectedTenant: TENANT, expectedVersion: 2, expectedSettingsVersion: 3, expectedCustomerVersion: 4, ...over });
const plan = (b: unknown, ids: { targetId?: string; storeId?: string } = { targetId: DRAFT, storeId: STORE }, newAggregateId = INVOICE) =>
  planInvoiceIssue(Object.freeze({ audience: 'tenant' as const, body: b, newAggregateId, ...ids }));

// --- 1. the contract and the route ----------------------------------------------------------------------------------------

test('ISS-R01 the issue is a store-scope UPDATE of the draft opting into the sealed issuing pair, no event; the route is the store POST template under a key', () => {
  assert.deepEqual([INVOICE_ISSUE_CONTRACT.kind, INVOICE_ISSUE_CONTRACT.mode, INVOICE_ISSUE_CONTRACT.aggregateType, INVOICE_ISSUE_CONTRACT.contextScope,
    INVOICE_ISSUE_CONTRACT.issuingRefusals, INVOICE_ISSUE_CONTRACT.events], ['store.invoice.issue', 'update', 'invoice_draft', 'store', true, []]);
  assert.deepEqual(INVOICE_ISSUE_CONTRACT.changes, {
    expectedTenant: { type: 'string', maxLength: 36 }, expectedSettingsVersion: { type: 'integer', min: 1, max: MAX },
    expectedCustomerVersion: { type: 'integer', min: 1, max: MAX }, invoiceId: { type: 'string', maxLength: 36 },
  });
  // The kernel admits the opt-in on an update (commandTransaction.ts, M7B-INVOICES-ISSUE-P1's kernel half).
  const contract = defineCommands([INVOICE_ISSUE_CONTRACT], defineOutboxEvents([])).contract('store.invoice.issue');
  assert.equal(contract?.issuingRefusals, true);
  const r = INVOICE_ISSUE_ROUTE;
  assert.deepEqual([r.method, r.path, r.body, r.idempotency, r.trustedContext, r.recentAuth],
    ['POST', '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue', { kind: 'json', maxBytes: 1024, required: true }, 'required', 'required', 'none']);
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'issue_invoices' } });
  assert.deepEqual([INVOICE_ISSUE_ELIGIBILITY_PATH, INVOICE_ISSUE_PREVIEW_PATH, ISSUED_INVOICES_PATH, ISSUED_INVOICE_PATH, INVOICE_ISSUE_PATH], [
    '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility', '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview',
    '/api/v1/stores/{storeId}/invoices', '/api/v1/stores/{storeId}/invoices/{id}', '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue']);
  assert.deepEqual([INVOICE_ISSUE_REQUIREMENT, ISSUED_INVOICE_VIEW_REQUIREMENT],
    [{ scope: 'store', permission: 'issue_invoices' }, { scope: 'store', permission: 'view_issued_invoices' }]);
});

test('ISS-R02 the plan: the path draft at expectedVersion, the preconditions and the new invoice id, no event, the 201 with Location — no number', () => {
  const p = plan(issueBody());
  assert.notEqual(p, COMMAND_REQUEST_INVALID);
  assert.deepEqual(p, {
    aggregateId: DRAFT, expectedVersion: 2,
    changes: { expectedTenant: TENANT, expectedSettingsVersion: 3, expectedCustomerVersion: 4, invoiceId: INVOICE },
    events: [],
    response: {
      status: 201,
      body: { invoice: { id: INVOICE, sourceDraftId: DRAFT, status: 'issued' }, draft: { id: DRAFT, version: 3, status: 'issued' } },
      headers: { location: `/api/v1/stores/${STORE}/invoices/${INVOICE}` },
    },
  });
  const top = plan(issueBody({ expectedVersion: MAX - 1, expectedSettingsVersion: MAX, expectedCustomerVersion: MAX }));
  assert.notEqual(top, COMMAND_REQUEST_INVALID, 'the largest versions');
});

test('ISS-R03 the issue body refused: keys, the tenant, each version (-0, fractions, 0, out of range, strings), the draft id shape and the store', () => {
  const bad: Array<[string, unknown]> = [
    ['null', null], ['an array', [issueBody()]], ['an extra key', { ...issueBody(), number: 1 }], ['a total', { ...issueBody(), totalCents: 10 }],
    ...(['expectedTenant', 'expectedVersion', 'expectedSettingsVersion', 'expectedCustomerVersion'] as const)
      .map((k): [string, unknown] => [`no ${k}`, Object.fromEntries(Object.entries(issueBody()).filter(([key]) => key !== k))]),
    ['tenant uppercase', issueBody({ expectedTenant: TENANT.toUpperCase() })], ['tenant null', issueBody({ expectedTenant: null })],
    ...(['expectedVersion', 'expectedSettingsVersion', 'expectedCustomerVersion'] as const).flatMap((k): Array<[string, unknown]> => [
      [`${k} 0`, issueBody({ [k]: 0 })], [`${k} -0`, issueBody({ [k]: -0 })], [`${k} -1`, issueBody({ [k]: -1 })], [`${k} 1.5`, issueBody({ [k]: 1.5 })],
      [`${k} 2^53`, issueBody({ [k]: MAX + 1 })], [`${k} '2'`, issueBody({ [k]: '2' })], [`${k} Infinity`, issueBody({ [k]: Number.POSITIVE_INFINITY })],
    ]),
    ['expectedVersion 2^53 - 1', issueBody({ expectedVersion: MAX })],
  ];
  for (const [label, b] of bad) assert.equal(plan(b), COMMAND_REQUEST_INVALID, label);
  // The draft id in the outbox's aggregate-id shape (a versioned, RFC-variant uuid), and a uuid store.
  for (const ids of [{ storeId: STORE }, { targetId: '00000000-0000-0000-0000-000000000000', storeId: STORE }, { targetId: DRAFT.toUpperCase(), storeId: STORE },
    { targetId: DRAFT }, { targetId: DRAFT, storeId: 'store' }]) {
    assert.equal(plan(issueBody(), ids), COMMAND_REQUEST_INVALID, JSON.stringify(ids));
  }
});

// --- 2. the amounts ---------------------------------------------------------------------------------------------------------

const rate = (r: number) => ({ mode: 'exclusive_rate' as const, rateMilliPercent: r });

test('ISS-R04 §10.8\'s examples, exactly: 1999 at 8.875 % is 177 tax and 2176 total; two 10-cent lines at 5 % tax once, 1 not 2; a half cent rounds up', () => {
  assert.equal(invoiceTaxOf(1999n, 8875), 177n);
  assert.deepEqual(issueAmountsOf(1999, rate(8875)), {
    currency: 'USD', subtotalCents: 1999, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 177 }, totalCents: 2176,
  });
  // Tax is computed once on the subtotal: per line it would be 1 + 1.
  assert.equal(invoiceTaxOf(10n, 5000) + invoiceTaxOf(10n, 5000), 2n, 'per line (never done)');
  assert.equal((issueAmountsOf(20, rate(5000)) as { tax: { amountCents: number } }).tax.amountCents, 1);
  assert.equal(invoiceTaxOf(10n, 5000), 1n, '0.5 cent rounds up');
  assert.equal(invoiceTaxOf(9n, 5000), 0n, '0.45 cent rounds down');
  assert.equal(invoiceTaxOf(0n, 100_000), 0n);
  assert.equal(invoiceTaxOf(1n, 100_000), 1n, '100 %');
  // S x R beyond 2^63: BigInt throughout.
  assert.equal(invoiceTaxOf(BigInt(MAX), 100_000), BigInt(MAX));
  for (const [s, r] of [[-1n, 1], [1n, -1], [1n, 100_001], [1n, 1.5], [1n, -0], [1n, Number.NaN]] as const) {
    assert.throws(() => invoiceTaxOf(s, r), RangeError, `${s} at ${r}`);
  }
  assert.throws(() => issueAmountsOf(-1, rate(1)), RangeError);
  assert.throws(() => issueAmountsOf(1.5, { mode: 'none' }), RangeError);
});

test('ISS-R05 an explicit 0 rate and no tax stay distinguishable; the largest valid totals are exact and the next subtotal overflows', () => {
  assert.deepEqual(issueAmountsOf(500, rate(0)), {
    currency: 'USD', subtotalCents: 500, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 0, amountCents: 0 }, totalCents: 500,
  });
  assert.deepEqual(issueAmountsOf(500, { mode: 'none' }), { currency: 'USD', subtotalCents: 500, tax: { mode: 'none', description: 'No tax calculated' }, totalCents: 500 });
  assert.equal(invoiceTaxOf(9_007_199_254_740_991n, 1), 90_071_992_547n, 'the largest subtotal at 0.001 %');
  assert.equal(issueAmountsOf(MAX, rate(1)), 'amount_out_of_range', 'and its total passes 2^53 - 1');
  assert.deepEqual(issueAmountsOf(MAX, { mode: 'none' }), { currency: 'USD', subtotalCents: MAX, tax: { mode: 'none', description: 'No tax calculated' }, totalCents: MAX });
  assert.equal((issueAmountsOf(MAX, rate(0)) as { totalCents: number }).totalCents, MAX);
  for (const [subtotal, r, tax, total] of [
    [9_007_109_183_649_155, 1, 90_071_091_836, MAX], [8_272_972_909_061_760, 8875, 734_226_345_679_231, MAX],
    [4_503_599_627_370_495, 100_000, 4_503_599_627_370_495, MAX - 1],
  ] as const) {
    assert.deepEqual(issueAmountsOf(subtotal, rate(r)), {
      currency: 'USD', subtotalCents: subtotal, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: r, amountCents: tax }, totalCents: total,
    }, `${subtotal} at ${r}`);
    assert.equal(issueAmountsOf(subtotal + 1, rate(r)), 'amount_out_of_range', `${subtotal + 1} at ${r}`);
  }
});

const LINE = (position: number, over: Record<string, unknown> = {}) => ({
  position, description: `Line ${position}`, quantity: 2, unitPriceCents: 50, lineTotalCents: 100, ...over,
});

test('ISS-R06 the lines: positions 1..n, q x p in BigInt, the subtotal their sum, every amount safe, the description servable', () => {
  assert.deepEqual(invoiceLinesOf([LINE(1), LINE(2)], 200), [LINE(1), LINE(2)]);
  assert.deepEqual(invoiceLinesOf([LINE(1, { quantity: MAX, unitPriceCents: 1, lineTotalCents: MAX })], MAX), [LINE(1, { quantity: MAX, unitPriceCents: 1, lineTotalCents: MAX })]);
  const bad: Array<[string, unknown, number]> = [
    ['empty', [], 0], ['not an array', LINE(1), 100], ['51 lines', Array.from({ length: 51 }, (_, i) => LINE(i + 1)), 5100],
    ['position 0', [LINE(0)], 100], ['out of order', [LINE(2), LINE(1)], 200], ['a gap', [LINE(1), LINE(3)], 200],
    ['a wrong total', [LINE(1, { lineTotalCents: 99 })], 99], ['a wrong subtotal', [LINE(1)], 101], ['quantity 0', [LINE(1, { quantity: 0, lineTotalCents: 0 })], 0],
    ['price -0', [LINE(1, { unitPriceCents: -0, lineTotalCents: 0 })], 0], ['an unsafe total', [LINE(1, { quantity: MAX, unitPriceCents: 2, lineTotalCents: MAX * 2 })], MAX * 2],
    ['a padded description', [LINE(1, { description: ' x ' })], 100], ['an extra key', [{ ...LINE(1), customerId: CUSTOMER }], 100],
    ['a text amount', [LINE(1, { quantity: '2' })], 100],
  ];
  for (const [label, lines, subtotal] of bad) assert.equal(invoiceLinesOf(lines, subtotal), null, label);
});

// --- 3. the preview ---------------------------------------------------------------------------------------------------------

const SETTINGS = Object.freeze({
  version: 3, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1', tax: rate(8875),
});
const previewRaw = (over: Record<string, unknown> = {}, draftOver: Record<string, unknown> = {}, settingsOver: Record<string, unknown> = {}) => ({
  outcome: 'preview',
  preview: {
    draft: { id: DRAFT, version: 2, subtotalCents: 1999, lines: [LINE(1, { quantity: 1, unitPriceCents: 1999, lineTotalCents: 1999 })], ...draftOver },
    customer: { id: CUSTOMER, name: 'Dana Customer', version: 4 },
    issuingSettings: { ...SETTINGS, ...settingsOver },
    currency: 'USD', taxCents: 177, totalCents: 2176, ...over,
  },
});

test('ISS-R07 the preview answer: a coherent one validates and derives its amounts; the five refusal words pass; anything out of shape is null', () => {
  const ok = invoiceIssuePreviewOf(previewRaw(), DRAFT);
  assert.ok(ok !== null && typeof ok === 'object');
  assert.deepEqual(ok.amounts, { currency: 'USD', subtotalCents: 1999, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 177 }, totalCents: 2176 });
  const none = invoiceIssuePreviewOf(previewRaw({ taxCents: null, totalCents: 1999 }, {}, { tax: { mode: 'none' }, taxRegistrationId: null }), DRAFT);
  assert.ok(none !== null && typeof none === 'object' && none.amounts.tax.mode === 'none' && none.amounts.totalCents === 1999);
  for (const word of ['denied', 'not_found', 'invalid_state', 'issuing_not_configured', 'amount_out_of_range']) assert.equal(invoiceIssuePreviewOf({ outcome: word }, DRAFT), word);
  const bad: Array<[string, unknown]> = [
    ['a refusal with a value', { outcome: 'denied', preview: null }], ['another word', { outcome: 'conflict' }],
    ['another draft', previewRaw({}, { id: randomUUID() })], ['version 0', previewRaw({}, { version: 0 })],
    ['the database\'s tax differs', previewRaw({ taxCents: 178, totalCents: 2177 })], ['a total not subtotal + tax', previewRaw({ totalCents: 2175 })],
    ['a tax under none', previewRaw({ taxCents: 0, totalCents: 1999 }, {}, { tax: { mode: 'none' } })],
    ['no tax under a rate', previewRaw({ taxCents: null, totalCents: 1999 })],
    ['a total past 2^53 - 1 the database served', previewRaw({ taxCents: 90_071_992_547, totalCents: MAX }, {
      subtotalCents: MAX, lines: [LINE(1, { quantity: 1, unitPriceCents: MAX, lineTotalCents: MAX })] }, { tax: rate(1) })],
    ['another currency', previewRaw({ currency: 'EUR' })], ['an extra key', previewRaw({ number: 1 })],
    ['a line sum off', previewRaw({}, { subtotalCents: 1998 })], ['a seller value padded', previewRaw({}, {}, { legalName: ' Acme' })],
    ['a tax id empty', previewRaw({}, {}, { taxRegistrationId: '' })], ['settings version 0', previewRaw({}, {}, { version: 0 })],
    ['a customer without a version', { ...previewRaw(), preview: { ...previewRaw().preview, customer: { id: CUSTOMER, name: 'D' } } }],
    ['a customer with a phone', { ...previewRaw(), preview: { ...previewRaw().preview, customer: { id: CUSTOMER, name: 'D', version: 1, phone: '1' } } }],
  ];
  for (const [label, raw] of bad) assert.equal(invoiceIssuePreviewOf(raw, DRAFT), null, label);
});

type Reply = { status: number | null; body: unknown; reason: unknown };
async function handle(route: RouteDefinition, url: string, over: Record<string, unknown> = {}): Promise<Reply> {
  const reply: { status: number | null; body: unknown } = { status: null, body: undefined };
  const res = { locals: {} as Record<string, unknown>, status(code: number) { reply.status = code; return res; }, json(b: unknown) { reply.body = b; return res; } };
  assert.ok(route.idempotency === 'none');
  await route.handler({ url, path: url.split('?')[0] } as never, res as never,
    { requestId: 'req-i', principal: null, session: null, authenticatedAt: null, trusted: SCOPE, sessionKey: KEY, body: undefined, ...over } as never);
  return { ...reply, reason: res.locals.refusal };
}
const port = (answers: { preview?: unknown; page?: unknown; invoice?: unknown }, calls: unknown[][] = []): InvoiceIssueReadPort => ({
  preview: (...a: unknown[]) => { calls.push(['preview', ...a.slice(0, 3)]); return answers.preview; },
  page: (...a: unknown[]) => { calls.push(['page', ...a.slice(0, 3)]); return answers.page; },
  invoice: (...a: unknown[]) => { calls.push(['invoice', ...a.slice(0, 3)]); return answers.invoice; },
});
const PREVIEW_URL = `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/issue-preview`;

test('ISS-R08 the preview handler: query, scope, id, then the port; the 200 carries the snapshot, the amounts and exactly the issue body it supports', async () => {
  const calls: unknown[][] = [];
  const route = createInvoiceIssuePreviewRoute({ invoiceIssuing: port({ preview: previewRaw() }, calls) });
  assert.deepEqual([route.method, route.path, route.sessionBinding, route.trustedContext, route.recentAuth, route.policy],
    ['GET', INVOICE_ISSUE_PREVIEW_PATH, 'required', 'required', 'none', { access: 'session', audience: 'tenant', authorization: INVOICE_ISSUE_REQUIREMENT }]);
  const ok = await handle(route, PREVIEW_URL);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { preview: {
    draft: { id: DRAFT, version: 2, lines: [{ position: 1, description: 'Line 1', quantity: 1, unitPriceCents: 1999, lineTotalCents: 1999 }], subtotalCents: 1999 },
    customer: { id: CUSTOMER, name: 'Dana Customer', version: 4 },
    issuingSettings: { version: 3, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1',
      tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 } },
    amounts: { currency: 'USD', subtotalCents: 1999, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 177 }, totalCents: 2176 },
    expected: { expectedTenant: TENANT, expectedVersion: 2, expectedSettingsVersion: 3, expectedCustomerVersion: 4 },
  } });
  assert.deepEqual(calls, [['preview', SCOPE, KEY, DRAFT]]);
  const expected = (ok.body as { preview: { expected: Record<string, unknown> } }).preview.expected;
  assert.notEqual(plan(expected), COMMAND_REQUEST_INVALID, 'expected is exactly an issue body');
  calls.length = 0;
  for (const [url, over, status, reason] of [
    [`${PREVIEW_URL}?`, {}, 400, 'invoice_issue_preview_query_invalid'], [PREVIEW_URL, { trusted: null }, 403, 'authz_context_missing'],
    [PREVIEW_URL, { trusted: { ...SCOPE, store: randomUUID() } }, 403, 'authz_context_missing'], [PREVIEW_URL, { sessionKey: null }, 403, 'authz_context_missing'],
    [`/api/v1/stores/${STORE}/invoice-drafts/NOT-A-UUID/issue-preview`, {}, 400, 'invoice_draft_id_invalid'],
  ] as const) {
    const r = await handle(route, url, over);
    assert.deepEqual([r.status, r.reason], [status, reason], url);
  }
  assert.equal(calls.length, 0);
  for (const [answer, status, error] of [
    [{ outcome: 'denied' }, 403, 'forbidden'], [{ outcome: 'not_found' }, 404, 'not_found'], [{ outcome: 'issuing_not_configured' }, 409, 'issuing_not_configured'],
    [{ outcome: 'amount_out_of_range' }, 409, 'amount_out_of_range'], [{ outcome: 'invalid_state' }, 409, 'invalid_state'], [previewRaw({ taxCents: 1 }), 503, 'service_unavailable'],
    [previewRaw({}, { version: MAX }), 409, 'invalid_state'],
  ] as const) {
    const r = await handle(createInvoiceIssuePreviewRoute({ invoiceIssuing: port({ preview: answer }) }), PREVIEW_URL);
    assert.deepEqual([r.status, r.body], [status, { error, requestId: 'req-i' }], JSON.stringify(answer).slice(0, 80));
  }
  const thrown = await handle(createInvoiceIssuePreviewRoute({ invoiceIssuing: { ...port({}), preview: () => { throw new Error('x'); } } }), PREVIEW_URL);
  assert.deepEqual([thrown.status, thrown.reason], [503, 'invoice_issue_preview_unavailable']);
  assert.throws(() => createInvoiceIssuePreviewRoute({ invoiceIssuing: { preview: () => null } } as never), (e: unknown) => e instanceof EnforcementSetupError);
});

test('ISS-R09 the eligibility: target-blind, under the issue\'s own requirement — the query, the scope, the id shape, then exactly { eligibility: "allowed" }', async () => {
  const route = createInvoiceIssueEligibilityRoute();
  assert.deepEqual([route.method, route.path, route.sessionBinding, route.policy],
    ['GET', INVOICE_ISSUE_ELIGIBILITY_PATH, 'required', { access: 'session', audience: 'tenant', authorization: INVOICE_ISSUE_REQUIREMENT }]);
  const url = `/api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/issue-eligibility`;
  assert.deepEqual((await handle(route, url)).body, { eligibility: 'allowed' });
  assert.deepEqual((await handle(route, `/api/v1/stores/${STORE}/invoice-drafts/${randomUUID()}/issue-eligibility`)).body, { eligibility: 'allowed' });
  assert.equal((await handle(route, `${url}?x`)).status, 400);
  assert.equal((await handle(route, url, { trusted: { ...SCOPE, scope: 'tenant', store: null } })).status, 403);
  assert.equal((await handle(route, `/api/v1/stores/${STORE}/invoice-drafts/nope/issue-eligibility`)).reason, 'invoice_draft_id_invalid');
});

// --- 4. the issued reads ---------------------------------------------------------------------------------------------------

test('ISS-R10 the cursor (tag 0x04, canonical only) and the list query: limit and cursor, or sourceDraft alone, within 128 characters', () => {
  const c = encodeIssuedInvoiceCursor(INVOICE);
  assert.equal(c.length, 23);
  assert.equal(decodeIssuedInvoiceCursor(c), INVOICE);
  assert.equal(Buffer.from(c, 'base64url')[0], 0x04);
  const drafts = Buffer.concat([Buffer.from([0x01]), Buffer.from(INVOICE.replace(/-/g, ''), 'hex')]).toString('base64url');
  assert.equal(decodeIssuedInvoiceCursor(drafts), null, 'the drafts\' tag is not this list\'s');
  const last = c[22];
  const sibling = `${c.slice(0, 22)}${String.fromCharCode(last.charCodeAt(0) ^ 1)}`;
  assert.equal(decodeIssuedInvoiceCursor(sibling), null, 'a second spelling of the same bytes is refused');
  assert.deepEqual(parseIssuedInvoiceListQuery('/api/v1/stores/x/invoices'), { after: null, sourceDraft: null, limit: 20 });
  assert.deepEqual(parseIssuedInvoiceListQuery(`/x?limit=50&cursor=${c}`), { after: INVOICE, sourceDraft: null, limit: 50 });
  assert.deepEqual(parseIssuedInvoiceListQuery(`/x?sourceDraft=${DRAFT}`), { after: null, sourceDraft: DRAFT, limit: 1 });
  for (const q of ['?', '?limit=0', '?limit=51', '?limit=01', '?limit=1&limit=2', `?cursor=${c}&cursor=${c}`, '?cursor=abc', `?sourceDraft=${DRAFT}&limit=1`,
    `?sourceDraft=${DRAFT}&cursor=${c}`, `?sourceDraft=${DRAFT.toUpperCase()}`, '?sourceDraft=x', '?q=a', '?limit=1&', `?limit=1&x=${'y'.repeat(130)}`,
    `?sourceDraft=${DRAFT}&sourceDraft=${DRAFT}`]) {
    assert.equal(parseIssuedInvoiceListQuery(`/x${q}`), null, q);
  }
});

const I = (i: number): string => `${(0x50000000 - i).toString(16)}-0000-4000-8000-${(800_000 - i).toString(16).padStart(12, '0')}`;
const SUMMARY = (i: number, over: Record<string, unknown> = {}) => ({
  id: I(i), number: 100 - i, sourceDraftId: randomUUID(), customerId: CUSTOMER, customerName: 'Dana Customer', currency: 'USD', totalCents: 2176, issuedAt: AT,
  snapshotVersion: 1, ...over,
});
const Q = (over: Partial<IssuedInvoiceListQuery> = {}): IssuedInvoiceListQuery => ({ after: null, sourceDraft: null, limit: 2, ...over });

test('ISS-R11 the issued page: newest number first, unique, within the limit, hasMore only behind a full page and never beside the filter; never the actor', () => {
  const page = issuedInvoicePageOf({ outcome: 'page', invoices: [SUMMARY(1), SUMMARY(2)], hasMore: true }, Q());
  assert.ok(page !== null && typeof page === 'object' && page.invoices.length === 2 && page.hasMore);
  assert.equal('snapshotVersion' in page.invoices[0], false);
  assert.equal(issuedInvoicePageOf({ outcome: 'cursor_unknown' }, Q({ after: I(9) })), 'cursor_unknown');
  const filter = randomUUID();
  assert.ok(issuedInvoicePageOf({ outcome: 'page', invoices: [SUMMARY(1, { sourceDraftId: filter })], hasMore: false }, Q({ sourceDraft: filter, limit: 1 })) !== null);
  assert.ok(issuedInvoicePageOf({ outcome: 'page', invoices: [], hasMore: false }, Q({ sourceDraft: filter, limit: 1 })) !== null, 'the same empty page');
  const bad: Array<[string, unknown, IssuedInvoiceListQuery]> = [
    ['cursor_unknown without a cursor', { outcome: 'cursor_unknown' }, Q()], ['too many', { outcome: 'page', invoices: [SUMMARY(1), SUMMARY(2), SUMMARY(3)], hasMore: false }, Q()],
    ['hasMore behind a short page', { outcome: 'page', invoices: [SUMMARY(1)], hasMore: true }, Q()],
    ['hasMore beside the filter', { outcome: 'page', invoices: [SUMMARY(1, { sourceDraftId: filter })], hasMore: true }, Q({ sourceDraft: filter, limit: 1 })],
    ['another source draft', { outcome: 'page', invoices: [SUMMARY(1)], hasMore: false }, Q({ sourceDraft: filter, limit: 1 })],
    ['oldest first', { outcome: 'page', invoices: [SUMMARY(2), SUMMARY(1)], hasMore: false }, Q()],
    ['one number twice', { outcome: 'page', invoices: [SUMMARY(1), SUMMARY(2, { number: 99 })], hasMore: false }, Q()],
    ['one id twice', { outcome: 'page', invoices: [SUMMARY(1), SUMMARY(1, { number: 98 })], hasMore: false }, Q()],
    ['one source draft twice', { outcome: 'page', invoices: [SUMMARY(1, { sourceDraftId: filter }), SUMMARY(2, { sourceDraftId: filter })], hasMore: false }, Q()],
    ['the anchor itself', { outcome: 'page', invoices: [SUMMARY(1)], hasMore: false }, Q({ after: I(1) })],
    ['an actor column', { outcome: 'page', invoices: [SUMMARY(1, { issuedBy: randomUUID() })], hasMore: false }, Q()],
    ['snapshot version 2', { outcome: 'page', invoices: [SUMMARY(1, { snapshotVersion: 2 })], hasMore: false }, Q()],
    ['number 0', { outcome: 'page', invoices: [SUMMARY(1, { number: 0 })], hasMore: false }, Q()],
    ['a millisecond time', { outcome: 'page', invoices: [SUMMARY(1, { issuedAt: '2026-10-16T09:30:00.123Z' })], hasMore: false }, Q()],
    ['an unsafe total', { outcome: 'page', invoices: [SUMMARY(1, { totalCents: MAX + 1 })], hasMore: false }, Q()],
  ];
  for (const [label, raw, query] of bad) assert.equal(issuedInvoicePageOf(raw, query), null, label);
});

const INVOICE_RAW = (over: Record<string, unknown> = {}) => ({
  outcome: 'invoice',
  invoice: {
    id: INVOICE, number: 7, snapshotVersion: 1, issuedAt: AT, sourceDraft: { id: DRAFT, version: 2 },
    seller: { legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: null },
    issuingSettingsVersion: 3, customer: { id: CUSTOMER, name: 'Dana Customer', version: 4 }, currency: 'USD', subtotalCents: 20, tax: rate(5000), taxCents: 1,
    totalCents: 21, lines: [LINE(1, { quantity: 1, unitPriceCents: 10, lineTotalCents: 10 }), LINE(2, { quantity: 1, unitPriceCents: 10, lineTotalCents: 10 })], ...over,
  },
});

test('ISS-R12 the issued detail: snapshot version 1, the amounts derived and equal to the stored ones, the tax by mode; anything else null', () => {
  const ok = issuedInvoiceOf(INVOICE_RAW(), INVOICE);
  assert.ok(ok !== null && typeof ok === 'object' && ok.amounts.totalCents === 21 && ok.amounts.tax.mode === 'exclusive_rate');
  assert.ok(issuedInvoiceOf(INVOICE_RAW({ tax: { mode: 'none' }, taxCents: null, totalCents: 20 }), INVOICE) !== null);
  for (const word of ['denied', 'not_found']) assert.equal(issuedInvoiceOf({ outcome: word }, INVOICE), word);
  const bad: Array<[string, unknown]> = [
    ['another id', INVOICE_RAW({ id: randomUUID() })], ['snapshot version 2', INVOICE_RAW({ snapshotVersion: 2 })], ['tax per line', INVOICE_RAW({ taxCents: 2, totalCents: 22 })],
    ['a total off', INVOICE_RAW({ totalCents: 20 })], ['no tax under a rate', INVOICE_RAW({ taxCents: null, totalCents: 20 })],
    ['a tax under none', INVOICE_RAW({ tax: { mode: 'none' }, taxCents: 0, totalCents: 20 })], ['an actor', INVOICE_RAW({ issuedBy: randomUUID() })],
    ['a balance', INVOICE_RAW({ balanceCents: 0 })], ['no number', INVOICE_RAW({ number: null })], ['a source draft version 0', INVOICE_RAW({ sourceDraft: { id: DRAFT, version: 0 } })],
    ['a source draft version no issue could step', INVOICE_RAW({ sourceDraft: { id: DRAFT, version: MAX } })],
    ['a seller with an extra key', INVOICE_RAW({ seller: { legalName: 'A', storeName: 'B', postalAddress: 'C', taxRegistrationId: null, phone: '1' } })],
    ['a postal address with CR', INVOICE_RAW({ seller: { legalName: 'A', storeName: 'B', postalAddress: 'C\r\nD', taxRegistrationId: null } })],
    ['a line out of order', INVOICE_RAW({ lines: [LINE(2, { quantity: 1, unitPriceCents: 10, lineTotalCents: 10 }), LINE(1, { quantity: 1, unitPriceCents: 10, lineTotalCents: 10 })] })],
  ];
  for (const [label, raw] of bad) assert.equal(issuedInvoiceOf(raw, INVOICE), null, label);
});

test('ISS-R13 the list and detail handlers: no actor, status "issued", snapshot 1, nextCursor behind a full page, the 400 for an unknown anchor, one 404', async () => {
  const calls: unknown[][] = [];
  const list = createIssuedInvoiceListRoute({ invoiceIssuing: port({ page: { outcome: 'page', invoices: [SUMMARY(1), SUMMARY(2)], hasMore: true } }, calls) });
  assert.deepEqual([list.path, list.policy], [ISSUED_INVOICES_PATH, { access: 'session', audience: 'tenant', authorization: ISSUED_INVOICE_VIEW_REQUIREMENT }]);
  const url = `/api/v1/stores/${STORE}/invoices`;
  const r = await handle(list, `${url}?limit=2`);
  assert.equal(r.status, 200);
  const { invoices, nextCursor } = r.body as { invoices: Record<string, unknown>[]; nextCursor: string };
  assert.deepEqual(invoices[0], { ...SUMMARY(1), status: 'issued', sourceDraftId: invoices[0].sourceDraftId });
  assert.deepEqual(Object.keys(invoices[0]), ['id', 'number', 'sourceDraftId', 'customerId', 'customerName', 'currency', 'totalCents', 'issuedAt', 'status', 'snapshotVersion']);
  assert.equal(decodeIssuedInvoiceCursor(nextCursor), I(2));
  assert.deepEqual(calls, [['page', SCOPE, KEY, { after: null, sourceDraft: null, limit: 2 }]]);
  assert.equal((await handle(list, `${url}?limit=0`)).reason, 'issued_invoice_list_query_invalid');
  const unknown = await handle(createIssuedInvoiceListRoute({ invoiceIssuing: port({ page: { outcome: 'cursor_unknown' } }) }), `${url}?cursor=${encodeIssuedInvoiceCursor(I(5))}`);
  assert.deepEqual([unknown.status, unknown.reason], [400, 'issued_invoice_cursor_unknown']);
  const empty = await handle(createIssuedInvoiceListRoute({ invoiceIssuing: port({ page: { outcome: 'page', invoices: [], hasMore: false } }) }), `${url}?sourceDraft=${DRAFT}`);
  assert.deepEqual(empty.body, { invoices: [], nextCursor: null });
  assert.equal((await handle(createIssuedInvoiceListRoute({ invoiceIssuing: port({ page: { outcome: 'denied' } }) }), url)).status, 403);
  assert.equal((await handle(createIssuedInvoiceListRoute({ invoiceIssuing: port({ page: { outcome: 'page' } }) }), url)).status, 503);

  const detail = createIssuedInvoiceDetailRoute({ invoiceIssuing: port({ invoice: INVOICE_RAW() }) });
  const d = await handle(detail, `${url}/${INVOICE}`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.body, { invoice: {
    id: INVOICE, number: 7, status: 'issued', snapshotVersion: 1, issuedAt: AT, sourceDraft: { id: DRAFT, version: 2 },
    seller: { legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: null },
    issuingSettingsVersion: 3, customer: { id: CUSTOMER, name: 'Dana Customer', version: 4 },
    lines: [{ position: 1, description: 'Line 1', quantity: 1, unitPriceCents: 10, lineTotalCents: 10 }, { position: 2, description: 'Line 2', quantity: 1, unitPriceCents: 10, lineTotalCents: 10 }],
    amounts: { currency: 'USD', subtotalCents: 20, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 5000, amountCents: 1 }, totalCents: 21 },
  } });
  assert.ok(!/issuedBy|actor|due|paid|balance|phone|email/i.test(JSON.stringify(d.body)), 'no actor, contact or payment wording');
  assert.equal((await handle(detail, `${url}/${INVOICE}?`)).status, 400);
  assert.equal((await handle(detail, `${url}/nope`)).reason, 'issued_invoice_id_invalid');
  for (const [answer, status] of [[{ outcome: 'not_found' }, 404], [{ outcome: 'denied' }, 403], [INVOICE_RAW({ number: 0 }), 503]] as const) {
    assert.equal((await handle(createIssuedInvoiceDetailRoute({ invoiceIssuing: port({ invoice: answer }) }), `${url}/${INVOICE}`)).status, status);
  }
});
