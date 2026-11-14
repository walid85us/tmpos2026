// M7B-INVOICES-ISSUE-P2 — the shop's issuing client against a scripted fetch: what each of the seven routes' requests
// carries (path, query, headers, options, the exact body bytes), the exact answers it accepts, and the one outcome every
// other answer maps to — a refusal only with its exact status and envelope (the chain's `{ error, requestId }` or the
// sealed `{ error }`), a command's undecided answer `unknown`, each call ONE fetch (nothing is retried: an outage, no answer
// or a timeout included). The shop's own checks: the settings body built once in its fixed key order from normalized
// values (swept against the server's own normalizers, server/runtime/issuingSettings.ts), the issue body from a validated
// preview's `expected`, the rate converted exactly (8.875 is 8875; string arithmetic), the tax and totals in BigInt
// (half a cent rounding up, swept against the server's own arithmetic, server/runtime/invoiceIssuing.ts), exact cents to
// 2^53-1 and the UTC text. Ids are built at run time (secret scanning); special characters from code points.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVOICE_PAYMENT_METHODS, INVOICE_PAYMENT_REVERSAL_REASONS, INVOICE_PAYMENT_STATUSES, INVOICE_VOID_REASONS, ISSUE_BODY_MAX_BYTES, PAYMENTS_PAGE_SIZE, paymentsPathOf, ISSUED_PAGE_LIMIT, SETTINGS_BODY_MAX_BYTES, VOID_REASON_CODES, createInvoiceIssuingClient, issueBodyOf, issueEligibilityPathOf, issuePathOf,
  issuePreviewPathOf, issuedInvoicePathOf, issuedInvoicesPathOf, issuingSettingsBody, issuingSettingsPathOf, normalizePostalAddress, parseRatePercent, rateDigits, rateText,
  isVoidTarget, sameSettingsValues, utcText, voidBodyOf, voidEligibilityPathOf, voidPathOf, type IssuingSettingsFields,
} from './invoiceIssuingClient';
import {
  PAYMENT_ATTEMPTS_PAGE_SIZE, PAYMENT_ATTEMPT_VERSIONS, paymentAmountOf, paymentAttemptsPathOf, paymentEligibilityPathOf, paymentProofPathOf, paymentRegistrationsPathOf,
  paymentSettlementPathOf, recordBodyOf, registerBodyOf, settleBodyOf, type RecordFields,
} from './invoiceIssuingClient';
import { paymentReversalEligibilityPathOf, paymentReversalPathOf, reverseBodyOf } from './invoiceIssuingClient';
import { formatCents } from './invoiceDraftsClient';
import { normalizeIssuingStoreName, normalizeLegalName, normalizePostalAddress as serverPostalAddress, normalizeTaxRegistrationId, taxSettingOf } from '../../server/runtime/issuingSettings';
import { invoiceTaxOf, issueAmountsOf } from '../../server/runtime/invoiceIssuing';
import { INVOICE_VOID_REASON_CODES, INVOICE_VOID_REASON_LABELS } from '../../server/runtime/invoiceVoid';
import {
  INVOICE_PAYMENTS_PAGE_SIZE, INVOICE_PAYMENT_METHODS as SERVER_PAYMENT_METHODS, INVOICE_PAYMENT_METHOD_LABELS, INVOICE_PAYMENT_REVERSAL_REASON_CODES, INVOICE_PAYMENT_REVERSAL_REASON_LABELS,
  INVOICE_PAYMENT_STATUSES as SERVER_PAYMENT_STATUSES, INVOICE_PAYMENT_ATTEMPTS_PAGE_SIZE, INVOICE_PAYMENT_ATTEMPT_STATES,
  INVOICE_PAYMENT_REVERSAL_ELIGIBILITY_PATH, INVOICE_PAYMENT_REVERSE_PATH,
} from '../../server/runtime/invoicePayments';

const cp = (code: number): string => String.fromCodePoint(code);
const unit = (code: number): string => String.fromCharCode(code);
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const STORE = uuid(0x5a1);
const OTHER_STORE = uuid(0x5a2);
const TENANT = uuid(0x7e1);
const DRAFT = uuid(0xd41);
const INVOICE = uuid(0x1a1);
const CUSTOMER = uuid(0xc51);
const KEY = ['7c5e7a9b', '1d2f', '4a6b', '9c8d', '0e1f2a3b4c5d'].join('-');
const CSRF = 'c'.repeat(43);
const MAX = Number.MAX_SAFE_INTEGER;
const ISSUED_AT = '2026-10-16T21:45:00.123456Z';
/** The server's continuation (invoiceIssuing.ts encodeIssuedInvoiceCursor): tag byte 0x04, then the anchor's 16 id bytes. */
const cursorOf = (id: string, tag = 0x04): string => Buffer.concat([Buffer.from([tag]), Buffer.from(id.replace(/-/g, ''), 'hex')]).toString('base64url');

interface Call { readonly url: string; readonly init: RequestInit }
/** A fetch that records each call and answers from `script` (a Response, or a thrown error for no answer). */
function scripted(...script: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = script.shift();
    if (next === undefined) throw new Error('unscripted');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { calls, client: createInvoiceIssuingClient({ fetch }) };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
/** A JSON answer whose text is `body` with `from` replaced by `to` (for what JSON.stringify never writes, like -0). */
const raw = (status: number, body: unknown, from: string, to: string, headers: Record<string, string> = {}): Response => {
  const text = JSON.stringify(body);
  assert.ok(text.includes(from), from);
  return new Response(text.replace(from, to), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
};
const headersOf = (call: Call): Headers => new Headers(call.init.headers);
/** The chain's refusal (app.ts refuse): `{ error, requestId }`. */
const refused = (status: number, error: string, headers: Record<string, string> = {}): Response => json(status, { error, requestId: 'req-synthetic' }, headers);
/** A key's recorded completion (idempotency.ts refusalEnvelope): exactly `{ error }`. */
const sealed = (status: number, error: string): Response => json(status, { error });
const network = () => new TypeError('network');

const SETTINGS = Object.freeze({
  storeId: STORE, version: 3, configured: true, legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1',
  tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 },
});
const FIELDS: IssuingSettingsFields = Object.freeze({
  legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1', taxMode: 'exclusive_rate', rate: '8.875',
});
const settingsBody = (expectedVersion = 2, fields: IssuingSettingsFields = FIELDS): string => {
  const built = issuingSettingsBody(TENANT, expectedVersion, fields);
  assert.equal(built.kind, 'ok');
  return built.kind === 'ok' ? built.body : '';
};
const LINES = [
  { position: 1, description: 'Screen repair', quantity: 1, unitPriceCents: 1999, lineTotalCents: 1999 },
];
const previewBody = (over: { draft?: object; customer?: object; settings?: object; amounts?: object; expected?: object } = {}) => ({
  preview: {
    draft: { id: DRAFT, version: 4, lines: LINES, subtotalCents: 1999, ...over.draft },
    customer: { id: CUSTOMER, name: 'Ada Customer', version: 2, ...over.customer },
    issuingSettings: { version: 3, legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: null, tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over.settings },
    amounts: { currency: 'USD', subtotalCents: 1999, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 177 }, totalCents: 2176, ...over.amounts },
    expected: { expectedTenant: TENANT, expectedVersion: 4, expectedSettingsVersion: 3, expectedCustomerVersion: 2, ...over.expected },
  },
});
const NONE_AMOUNTS = { currency: 'USD', subtotalCents: 1999, tax: { mode: 'none', description: 'No tax calculated' }, totalCents: 1999 };
const ISSUE_BODY = JSON.stringify({ expectedTenant: TENANT, expectedVersion: 4, expectedSettingsVersion: 3, expectedCustomerVersion: 2 });
const created = (over: { invoice?: object; draft?: object } = {}) => ({
  invoice: { id: INVOICE, sourceDraftId: DRAFT, status: 'issued', ...over.invoice }, draft: { id: DRAFT, version: 5, status: 'issued', ...over.draft },
});
const LOCATION = `/api/v1/stores/${STORE}/invoices/${INVOICE}`;
const summary = (n: number, number: number, over: Record<string, unknown> = {}) => ({
  id: uuid(0x1000 + n), number, sourceDraftId: uuid(0xd000 + n), customerId: CUSTOMER, customerName: 'Ada Customer', currency: 'USD', totalCents: 2176,
  issuedAt: ISSUED_AT, status: 'issued', snapshotVersion: 1, ...over,
});
const detailBody = (over: Record<string, unknown> = {}) => ({
  invoice: {
    id: INVOICE, number: 7, status: 'issued', snapshotVersion: 1, issuedAt: ISSUED_AT, sourceDraft: { id: DRAFT, version: 4 },
    seller: { legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1' },
    issuingSettingsVersion: 3, customer: { id: CUSTOMER, name: 'Ada Customer', version: 2 }, lines: LINES,
    amounts: { currency: 'USD', subtotalCents: 1999, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 177 }, totalCents: 2176 },
    ...over,
  },
});

test('IIC-01. every request of the seven routes is same-origin, credentialed, uncached, never redirected, with no referrer; reads carry the session token only, commands the intent, session and key headers', async () => {
  const { calls, client } = scripted(...Array.from({ length: 9 }, () => refused(503, 'service_unavailable')));
  const body = settingsBody();
  await client.getSettings(STORE, CSRF);
  await client.saveSettings(STORE, body, KEY, CSRF);
  await client.issueEligibility(STORE, DRAFT, CSRF);
  await client.issuePreview(STORE, DRAFT, TENANT, CSRF);
  await client.issue(STORE, DRAFT, ISSUE_BODY, KEY, CSRF);
  await client.listIssued(STORE, null, CSRF);
  await client.listIssued(STORE, cursorOf(uuid(0x1099)), CSRF);
  await client.findIssued(STORE, DRAFT, CSRF);
  await client.getIssued(STORE, INVOICE, CSRF);
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [
    `GET /api/v1/issuing-settings/${STORE}`,
    `PUT /api/v1/issuing-settings/${STORE}`,
    `GET /api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/issue-eligibility`,
    `GET /api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/issue-preview`,
    `POST /api/v1/stores/${STORE}/invoice-drafts/${DRAFT}/issue`,
    `GET /api/v1/stores/${STORE}/invoices?limit=${ISSUED_PAGE_LIMIT}`,
    `GET /api/v1/stores/${STORE}/invoices?limit=${ISSUED_PAGE_LIMIT}&cursor=${cursorOf(uuid(0x1099))}`,
    `GET /api/v1/stores/${STORE}/invoices?sourceDraft=${DRAFT}`,
    `GET /api/v1/stores/${STORE}/invoices/${INVOICE}`,
  ]);
  assert.equal(issuingSettingsPathOf(STORE), `/api/v1/issuing-settings/${STORE}`);
  assert.equal(issueEligibilityPathOf(STORE, DRAFT), calls[2].url);
  assert.equal(issuePreviewPathOf(STORE, DRAFT), calls[3].url);
  assert.equal(issuePathOf(STORE, DRAFT), calls[4].url);
  assert.equal(issuedInvoicesPathOf(STORE), `/api/v1/stores/${STORE}/invoices`);
  assert.equal(issuedInvoicePathOf(STORE, INVOICE), calls[8].url);
  for (const call of calls) {
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.mode, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.ok(call.init.signal instanceof AbortSignal);
    const h = headersOf(call);
    assert.equal(h.get('x-tmpos-session-csrf'), CSRF);
    assert.equal(h.get('accept'), 'application/json');
    assert.equal(h.get('cookie'), null);
    assert.equal(h.get('origin'), null);
    assert.ok(!call.url.includes(CSRF));
    const command = call.init.method !== 'GET';
    assert.equal(h.get('x-tmpos-csrf'), command ? '1' : null);
    assert.equal(h.get('idempotency-key'), command ? KEY : null);
    assert.equal(h.get('content-type'), command ? 'application/json' : null);
    assert.equal(call.init.body, command ? (call.init.method === 'PUT' ? body : ISSUE_BODY) : undefined);
    assert.equal([...h.keys()].length, command ? 5 : 2);
  }
});

test('IIC-02. the settings read: exactly the unconfigured `{ storeId, version: 0, configured: false }` or a configured view for the store asked, in either tax shape; anything else is unavailable', async () => {
  const none = { ...SETTINGS, version: 1, taxRegistrationId: null, tax: { mode: 'none' } };
  const zero = { ...SETTINGS, tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } };
  const ok = scripted(
    json(200, { issuingSettings: { storeId: STORE, version: 0, configured: false } }), json(200, { issuingSettings: SETTINGS }), json(200, { issuingSettings: none }),
    json(200, { issuingSettings: zero }),
  );
  assert.deepEqual(await ok.client.getSettings(STORE, CSRF), { kind: 'ok', settings: { storeId: STORE, version: 0, configured: false } });
  assert.deepEqual(await ok.client.getSettings(STORE, CSRF), { kind: 'ok', settings: SETTINGS });
  assert.deepEqual(await ok.client.getSettings(STORE, CSRF), { kind: 'ok', settings: none });
  assert.deepEqual(await ok.client.getSettings(STORE, CSRF), { kind: 'ok', settings: zero }); // an explicit 0 is a rate, not "none"
  const bad: Array<Response> = [
    json(200, { issuingSettings: { ...SETTINGS, storeId: OTHER_STORE } }),
    json(200, { issuingSettings: { storeId: STORE, version: 1, configured: false } }),
    json(200, { issuingSettings: { storeId: STORE, version: 0, configured: false, legalName: 'x' } }),
    raw(200, { issuingSettings: { storeId: STORE, version: 0, configured: false } }, '"version":0', '"version":-0'),
    json(200, { issuingSettings: { ...SETTINGS, version: 0 } }),
    json(200, { issuingSettings: { ...SETTINGS, version: MAX + 1 } }),
    json(200, { issuingSettings: { ...SETTINGS, version: '3' } }),
    json(200, { issuingSettings: { ...SETTINGS, extra: 1 } }),
    json(200, { issuingSettings: { ...SETTINGS, configured: 'true' } }),
    json(200, { issuingSettings: SETTINGS, more: 1 }),
    json(200, { issuingSettings: [SETTINGS] }),
    json(200, { issuingSettings: { ...SETTINGS, legalName: ' Example' } }), // not its own normalized form
    json(200, { issuingSettings: { ...SETTINGS, legalName: `Exa${unit(0x0a)}mple` } }),
    json(200, { issuingSettings: { ...SETTINGS, legalName: `Exa${cp(0x202e)}mple` } }),
    json(200, { issuingSettings: { ...SETTINGS, legalName: 'x'.repeat(201) } }),
    json(200, { issuingSettings: { ...SETTINGS, storeName: 'x'.repeat(121) } }),
    json(200, { issuingSettings: { ...SETTINGS, postalAddress: `1 Main St${unit(0x0d)}${unit(0x0a)}Springfield` } }),
    json(200, { issuingSettings: { ...SETTINGS, postalAddress: '1 Main St\n\nSpringfield' } }),
    json(200, { issuingSettings: { ...SETTINGS, postalAddress: Array.from({ length: 9 }, (_, i) => `L${i}`).join('\n') } }),
    json(200, { issuingSettings: { ...SETTINGS, taxRegistrationId: '' } }),
    json(200, { issuingSettings: { ...SETTINGS, taxRegistrationId: 'x'.repeat(65) } }),
    json(200, { issuingSettings: { ...SETTINGS, tax: { mode: 'none', rateMilliPercent: 0 } } }),
    json(200, { issuingSettings: { ...SETTINGS, tax: { mode: 'exclusive_rate' } } }),
    json(200, { issuingSettings: { ...SETTINGS, tax: { mode: 'exclusive_rate', rateMilliPercent: 100001 } } }),
    json(200, { issuingSettings: { ...SETTINGS, tax: { mode: 'exclusive_rate', rateMilliPercent: 1.5 } } }),
    json(200, { issuingSettings: { ...SETTINGS, tax: { mode: 'flat', rateMilliPercent: 1 } } }),
    json(200, { issuingSettings: { ...SETTINGS, tax: null } }),
    new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response(JSON.stringify({ issuingSettings: SETTINGS }), { status: 200, headers: { 'content-type': 'application/json-patch+json' } }),
  ];
  const { calls, client } = scripted(...bad);
  for (let i = 0; i < bad.length; i++) assert.deepEqual(await client.getSettings(STORE, CSRF), { kind: 'unavailable' }, `case ${i}`);
  assert.equal(calls.length, bad.length);
});

test('IIC-03. the settings read\'s refusals, each only in the chain\'s exact envelope with its word: 401 signed-out, 403 denied, 404 not-found, 429 rate-limited (Retry-After, else 60); anything else unavailable; a store id outside its grammar sends nothing', async () => {
  const { calls, client } = scripted(
    refused(401, 'unauthenticated'), refused(403, 'forbidden'), refused(404, 'not_found'), refused(429, 'rate_limited', { 'retry-after': '7' }), refused(429, 'rate_limited'),
    sealed(403, 'forbidden'), refused(403, 'step_up_required'), json(404, { error: 'not_found', requestId: 'r', more: 1 }), refused(401, 'forbidden'),
    refused(400, 'invalid_request'), refused(503, 'service_unavailable'), new Response('denied', { status: 403 }), network(),
  );
  const kinds = [];
  for (let i = 0; i < 13; i++) kinds.push(await client.getSettings(STORE, CSRF));
  assert.deepEqual(kinds, [
    { kind: 'signed-out' }, { kind: 'denied' }, { kind: 'not-found' }, { kind: 'rate-limited', retryAfterSeconds: 7 }, { kind: 'rate-limited', retryAfterSeconds: 60 },
    ...Array.from({ length: 8 }, () => ({ kind: 'unavailable' })),
  ]);
  assert.equal(calls.length, 13);
  for (const id of ['', STORE.toUpperCase(), `${STORE}/x`, '../x', `${STORE}?q`]) assert.deepEqual(await client.getSettings(id, CSRF), { kind: 'denied' });
  assert.equal(calls.length, 13);
});

test('IIC-04. the settings body is built ONCE in its fixed key order from normalized values — trimmed text, the address\'s lines trimmed and joined by one LF, a blank registration id null — with "none" exactly { "mode": "none" } and an explicit 0 kept as a rate', () => {
  const built = issuingSettingsBody(TENANT, 0, {
    legalName: '  Example Repairs LLC  ', storeName: '\tMain Street ', postalAddress: `\n  1 Main St  \n\tSpringfield${cp(0x3000)}\n`, taxRegistrationId: '   ', taxMode: 'exclusive_rate', rate: ' 0 ',
  });
  assert.equal(built.kind, 'ok');
  if (built.kind !== 'ok') return;
  assert.equal(built.body, JSON.stringify({
    expectedTenant: TENANT, expectedVersion: 0, legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: null,
    tax: { mode: 'exclusive_rate', rateMilliPercent: 0 },
  }));
  assert.deepEqual(Object.keys(JSON.parse(built.body)), ['expectedTenant', 'expectedVersion', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax']);
  assert.deepEqual(built.values.tax, { mode: 'exclusive_rate', rateMilliPercent: 0 });
  const none = issuingSettingsBody(TENANT, 5, { ...FIELDS, taxMode: 'none', rate: 'not a rate' }); // the rate field is ignored under none
  assert.equal(none.kind === 'ok' && none.body.endsWith('"tax":{"mode":"none"}}'), true);
  assert.equal(none.kind === 'ok' && JSON.parse(none.body).taxRegistrationId, 'TX-1');
  assert.equal(settingsBody(2), JSON.stringify({ expectedTenant: TENANT, expectedVersion: 2, legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\nSpringfield', taxRegistrationId: 'TX-1', tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 } }));
  // Every field is judged; nothing is built when any is wrong, and the errors say which.
  const errorsOf = (fields: Partial<IssuingSettingsFields>, tenant = TENANT, version = 0) => {
    const out = issuingSettingsBody(tenant, version, { ...FIELDS, ...fields });
    return out.kind === 'invalid' ? Object.entries(out.errors).filter(([, bad]) => bad).map(([field]) => field) : [];
  };
  assert.deepEqual(errorsOf({}), []);
  assert.deepEqual(errorsOf({ legalName: '   ' }), ['legalName']);
  assert.deepEqual(errorsOf({ legalName: 'x'.repeat(201) }), ['legalName']);
  assert.deepEqual(errorsOf({ legalName: cp(0x1f600).repeat(200) }), []); // 200 astral scalars are 400 UTF-16 units
  assert.deepEqual(errorsOf({ legalName: `A${unit(0x0a)}B` }), ['legalName']);
  assert.deepEqual(errorsOf({ storeName: 'x'.repeat(121) }), ['storeName']);
  assert.deepEqual(errorsOf({ storeName: `A${cp(0x200f)}B` }), ['storeName']);
  assert.deepEqual(errorsOf({ postalAddress: '' }), ['postalAddress']);
  assert.deepEqual(errorsOf({ postalAddress: 'Line one\n\nLine three' }), ['postalAddress']);
  assert.deepEqual(errorsOf({ postalAddress: `Line one${unit(0x0d)}` }), ['postalAddress']); // a CR is refused, never trimmed away
  assert.deepEqual(errorsOf({ postalAddress: Array.from({ length: 8 }, () => 'x'.repeat(120)).join('\n') }), []);
  assert.deepEqual(errorsOf({ postalAddress: Array.from({ length: 9 }, () => 'x').join('\n') }), ['postalAddress']);
  assert.deepEqual(errorsOf({ postalAddress: `${'x'.repeat(121)}\nB` }), ['postalAddress']);
  assert.deepEqual(errorsOf({ taxRegistrationId: 'x'.repeat(65) }), ['taxRegistrationId']);
  assert.deepEqual(errorsOf({ taxRegistrationId: 'x'.repeat(64) }), []);
  assert.deepEqual(errorsOf({ taxMode: '' }), ['taxMode']); // no default mode
  // Nothing but the two modes: a mode the form never offers (or none at all) is refused, never built as a rate-less rate.
  assert.deepEqual(errorsOf({ taxMode: 'exclusive' as unknown as IssuingSettingsFields['taxMode'] }), ['taxMode']);
  assert.deepEqual(errorsOf({ taxMode: undefined as unknown as IssuingSettingsFields['taxMode'] }), ['taxMode']);
  assert.deepEqual(errorsOf({ rate: '' }), ['rate']);
  assert.deepEqual(errorsOf({ rate: '100.001' }), ['rate']);
  assert.deepEqual(errorsOf({}, 'not-a-tenant'), ['context']);
  assert.deepEqual(errorsOf({}, TENANT, -1), ['context']);
  assert.deepEqual(errorsOf({}, TENANT, MAX), ['context']); // the next version would not be exact
  assert.deepEqual(errorsOf({ legalName: '', storeName: '', postalAddress: '', taxMode: '' }), ['legalName', 'storeName', 'postalAddress', 'taxMode']);
});

test('IIC-05. the settings rules restate the server\'s exactly: one corpus through both normalizers, and every built body\'s values are what the server would store', () => {
  const text = [
    '', ' ', 'a', ' a ', '\ta\t', `a${unit(0x09)}b`, `a${unit(0x0a)}b`, `a${unit(0x00)}`, `a${unit(0x7f)}`, `a${unit(0x85)}`, `a${cp(0x2028)}b`, `a${cp(0x200e)}`, `a${cp(0x2066)}b`,
    `a${unit(0xd800)}`, cp(0x200b), cp(0x2800), `${cp(0x0301)}`, `a${cp(0x0301)}`, cp(0x3000), `${cp(0x3000)}a${cp(0x3000)}`, 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(120),
    'x'.repeat(121), 'x'.repeat(200), 'x'.repeat(201), cp(0x1f600).repeat(120), cp(0x1f600).repeat(121), 'Café Ünïcode', 'שלום', '"quoted" \\ back',
  ];
  for (const value of text) {
    const fields = (over: Partial<IssuingSettingsFields>) => issuingSettingsBody(TENANT, 0, { ...FIELDS, ...over });
    const legal = fields({ legalName: value });
    assert.equal(legal.kind === 'ok' ? legal.values.legalName : null, normalizeLegalName(value), `legal ${JSON.stringify(value)}`);
    const store = fields({ storeName: value });
    assert.equal(store.kind === 'ok' ? store.values.storeName : null, normalizeIssuingStoreName(value), `store ${JSON.stringify(value)}`);
    const taxId = fields({ taxRegistrationId: value });
    // A blank field is the optional value left out (null); anything else is judged as the server judges a present one.
    const expected = value.trim() === '' ? null : normalizeTaxRegistrationId(value) ?? 'refused';
    assert.equal(taxId.kind === 'ok' ? taxId.values.taxRegistrationId : 'refused', expected, `tax id ${JSON.stringify(value)}`);
  }
  const addresses = [
    ...text, 'L1\nL2', '\n  L1  \n\tL2　\n', 'L1\n\nL3', 'L1\r\nL2', 'L1\rL2', '\r', '\n', 'L1\n \nL3', Array.from({ length: 8 }, (_, i) => `L${i}`).join('\n'),
    Array.from({ length: 9 }, (_, i) => `L${i}`).join('\n'), `L1\n${'x'.repeat(121)}`, `L1\nL${cp(0x202a)}2`,
  ];
  for (const value of addresses) assert.equal(normalizePostalAddress(value), serverPostalAddress(value), JSON.stringify(value));
  // The built tax is one the server's taxSettingOf takes unchanged, in both shapes.
  for (const fields of [FIELDS, { ...FIELDS, rate: '0' }, { ...FIELDS, rate: '100' }, { ...FIELDS, taxMode: 'none' as const }]) {
    const out = issuingSettingsBody(TENANT, 1, fields);
    assert.equal(out.kind, 'ok');
    if (out.kind === 'ok') assert.deepEqual(taxSettingOf(JSON.parse(out.body).tax), out.values.tax);
  }
  assert.equal(sameSettingsValues(
    { legalName: 'a', storeName: 'b', postalAddress: 'c', taxRegistrationId: null, tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } },
    { legalName: 'a', storeName: 'b', postalAddress: 'c', taxRegistrationId: null, tax: { mode: 'none' } },
  ), false); // an explicit 0 is never "none"
});

test('IIC-06. a settings write is ONE PUT of the exact bytes; saved ONLY on an exact 200 for the store asked at the version SENT plus one, echoing exactly the values sent; a replay says so', async () => {
  const body = settingsBody(2);
  const saved = { issuingSettings: SETTINGS }; // version 3 = 2 + 1
  const { calls, client } = scripted(json(200, saved), json(200, saved, { 'idempotent-replayed': 'true' }));
  assert.deepEqual(await client.saveSettings(STORE, body, KEY, CSRF), { kind: 'saved', settings: SETTINGS, replayed: false });
  assert.deepEqual(await client.saveSettings(STORE, body, KEY, CSRF), { kind: 'saved', settings: SETTINGS, replayed: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.body, body); // the caller's exact string, never re-serialized
  const unnamed: Response[] = [
    json(200, { issuingSettings: { ...SETTINGS, version: 4 } }), // another version than SENT + 1
    json(200, { issuingSettings: { ...SETTINGS, version: 2 } }),
    json(200, { issuingSettings: { ...SETTINGS, storeId: OTHER_STORE } }),
    json(200, { issuingSettings: { ...SETTINGS, legalName: 'Other LLC' } }), // values the body did not send
    json(200, { issuingSettings: { ...SETTINGS, tax: { mode: 'exclusive_rate', rateMilliPercent: 8876 } } }),
    json(200, { issuingSettings: { ...SETTINGS, tax: { mode: 'none' } } }),
    json(200, { issuingSettings: { ...SETTINGS, taxRegistrationId: null } }),
    json(200, { issuingSettings: { storeId: STORE, version: 0, configured: false } }),
    json(200, saved, { 'idempotent-replayed': 'yes' }),
    json(201, saved), new Response(null, { status: 204 }), json(200, { ...saved, extra: true }),
    new Response('<html>saved</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ];
  const second = scripted(...unnamed);
  for (let i = 0; i < unnamed.length; i++) assert.deepEqual(await second.client.saveSettings(STORE, body, KEY, CSRF), { kind: 'unknown', responded: true }, `case ${i}`);
  assert.equal(second.calls.length, unnamed.length);
  // A first write (expectedVersion 0) is saved at version 1.
  const first = scripted(json(200, { issuingSettings: { ...SETTINGS, version: 1 } }));
  assert.equal((await first.client.saveSettings(STORE, settingsBody(0), KEY, CSRF)).kind, 'saved');
});

test('IIC-07. every other settings answer maps to ONE outcome by status AND word AND shape — sealed 409 conflict, the chain\'s 409s, 404, 422, 403 step_up_required, the shared refusals — anything undecided unknown; each is one fetch, never retried', async () => {
  const body = settingsBody(2);
  const table: Array<[Response | Error, unknown]> = [
    [sealed(409, 'write_conflict'), { kind: 'conflict' }],
    [refused(409, 'write_conflict'), { kind: 'tenant-changed' }],
    [refused(409, 'request_in_progress'), { kind: 'in-progress' }],
    [sealed(409, 'request_in_progress'), { kind: 'unknown', responded: true }],
    [refused(409, 'invalid_state'), { kind: 'unknown', responded: true }],
    [refused(404, 'not_found'), { kind: 'not-found' }],
    [sealed(404, 'not_found'), { kind: 'unknown', responded: true }],
    [refused(422, 'idempotency_key_reused'), { kind: 'key-reused' }],
    [sealed(422, 'idempotency_key_reused'), { kind: 'unknown', responded: true }],
    [refused(403, 'step_up_required'), { kind: 'step-up' }],
    [sealed(403, 'step_up_required'), { kind: 'unknown', responded: true }],
    [refused(403, 'forbidden'), { kind: 'denied' }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refused(400, 'invalid_request'), { kind: 'invalid' }],
    [refused(413, 'content_too_large'), { kind: 'invalid' }],
    [refused(415, 'unsupported_media_type'), { kind: 'invalid' }],
    [refused(429, 'rate_limited', { 'retry-after': '12' }), { kind: 'rate-limited', retryAfterSeconds: 12 }],
    [refused(429, 'rate_limited', { 'retry-after': 'soon' }), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refused(503, 'service_unavailable'), { kind: 'unknown', responded: true }],
    [refused(500, 'internal_error'), { kind: 'unknown', responded: true }],
    [refused(401, 'forbidden'), { kind: 'unknown', responded: true }],
    [new Response('Forbidden', { status: 403 }), { kind: 'unknown', responded: true }],
    [network(), { kind: 'unknown', responded: false }],
  ];
  for (const [reply, outcome] of table) {
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.saveSettings(STORE, body, KEY, CSRF), outcome, JSON.stringify(outcome));
    assert.equal(calls.length, 1); // one fetch: nothing re-sends on its own
  }
  // A timeout is no answer too, and is not retried.
  let hung = 0;
  const hanging = createInvoiceIssuingClient({ timeoutMs: 5, fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    hung += 1;
    return new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
  }) as typeof globalThis.fetch });
  assert.deepEqual(await hanging.saveSettings(STORE, body, KEY, CSRF), { kind: 'unknown', responded: false });
  assert.equal(hung, 1);
});

test('IIC-08. a settings write sends nothing for a body or a store id the server would refuse: unreadable, a missing or extra key, a version outside 0..2^53-2, a value not in its stored form, a tax in neither shape, over 8 KiB', async () => {
  const good = JSON.parse(settingsBody(2)) as Record<string, unknown>;
  const variants: string[] = [
    'not json', '[]', JSON.stringify({ ...good, extra: 1 }), JSON.stringify(Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'tax'))),
    JSON.stringify({ ...good, expectedVersion: -1 }), JSON.stringify({ ...good, expectedVersion: MAX }), JSON.stringify({ ...good, expectedVersion: '2' }),
    JSON.stringify(good).replace('"expectedVersion":2', '"expectedVersion":-0'),
    JSON.stringify({ ...good, expectedTenant: TENANT.toUpperCase() }), JSON.stringify({ ...good, legalName: ' Example' }), JSON.stringify({ ...good, storeName: '' }),
    JSON.stringify({ ...good, postalAddress: '1 Main St\n\nX' }), JSON.stringify({ ...good, taxRegistrationId: '' }),
    JSON.stringify({ ...good, tax: { mode: 'none', rateMilliPercent: 0 } }), JSON.stringify({ ...good, tax: { mode: 'exclusive_rate', rateMilliPercent: 100001 } }),
    `${JSON.stringify(good)}${' '.repeat(SETTINGS_BODY_MAX_BYTES)}`,
  ];
  const { calls, client } = scripted();
  for (const body of variants) assert.deepEqual(await client.saveSettings(STORE, body, KEY, CSRF), { kind: 'invalid' }, body.slice(0, 60));
  assert.deepEqual(await client.saveSettings('store-1', settingsBody(2), KEY, CSRF), { kind: 'invalid' });
  assert.equal(calls.length, 0);
  // Any key order of exact values is the planner's too (the server reads keys, not their order).
  const reordered = JSON.stringify({ tax: good.tax, ...good });
  const once = scripted(json(200, { issuingSettings: SETTINGS }));
  assert.equal((await once.client.saveSettings(STORE, reordered, KEY, CSRF)).kind, 'saved');
});

test('IIC-09. issue eligibility: allowed ONLY for a 200 whose body is exactly { eligibility: "allowed" }; its refusals the reads\' in their envelope; anything else unavailable; an id outside its grammar sends nothing', async () => {
  const answers: Array<[Response | Error, string]> = [
    [json(200, { eligibility: 'allowed' }), 'allowed'], [json(200, { eligibility: 'denied' }), 'unavailable'], [json(200, { eligibility: 'allowed', more: 1 }), 'unavailable'],
    [json(200, {}), 'unavailable'], [refused(401, 'unauthenticated'), 'signed-out'], [refused(403, 'forbidden'), 'denied'], [refused(429, 'rate_limited'), 'rate-limited'],
    [sealed(403, 'forbidden'), 'unavailable'], [refused(404, 'not_found'), 'unavailable'], [refused(503, 'service_unavailable'), 'unavailable'], [network(), 'unavailable'],
  ];
  for (const [reply, kind] of answers) {
    const { calls, client } = scripted(reply);
    assert.equal((await client.issueEligibility(STORE, DRAFT, CSRF)).kind, kind);
    assert.equal(calls.length, 1);
  }
  const { calls, client } = scripted();
  assert.deepEqual(await client.issueEligibility('x', DRAFT, CSRF), { kind: 'denied' });
  assert.deepEqual(await client.issueEligibility(STORE, DRAFT.toUpperCase(), CSRF), { kind: 'denied' });
  assert.equal(calls.length, 0);
});

test('IIC-10. the preview: exactly its body for the draft asked, its amounts the BigInt arithmetic under the settings\' own tax, and `expected` exactly the issue body for what it shows (the tenant passed in, the draft\'s, settings\' and customer\'s versions)', async () => {
  const none = previewBody({ settings: { tax: { mode: 'none' } }, amounts: NONE_AMOUNTS });
  const zero = previewBody({ settings: { tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } }, amounts: { tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 0, amountCents: 0 }, totalCents: 1999 } });
  const half = previewBody({
    draft: { lines: [{ position: 1, description: 'A', quantity: 1, unitPriceCents: 10, lineTotalCents: 10 }, { position: 2, description: 'B', quantity: 1, unitPriceCents: 10, lineTotalCents: 10 }], subtotalCents: 20 },
    settings: { tax: { mode: 'exclusive_rate', rateMilliPercent: 5000 } }, amounts: { subtotalCents: 20, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 5000, amountCents: 1 }, totalCents: 21 },
  }); // 20 cents at 5 %: exactly one cent (the half-cent cases are IIC-22's)
  const ok = scripted(json(200, previewBody()), json(200, none), json(200, zero), json(200, half));
  const got = await ok.client.issuePreview(STORE, DRAFT, TENANT, CSRF);
  assert.equal(got.kind, 'ok');
  if (got.kind === 'ok') {
    assert.deepEqual(got.preview.amounts, { currency: 'USD', subtotalCents: 1999, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 177 }, totalCents: 2176 });
    assert.deepEqual(got.preview.expected, { expectedTenant: TENANT, expectedVersion: 4, expectedSettingsVersion: 3, expectedCustomerVersion: 2 });
    assert.equal(issueBodyOf(got.preview.expected), ISSUE_BODY);
    assert.deepEqual(got.preview.customer, { id: CUSTOMER, name: 'Ada Customer', version: 2 });
    assert.equal(got.preview.issuingSettings.taxRegistrationId, null);
  }
  for (let i = 0; i < 3; i++) assert.equal((await ok.client.issuePreview(STORE, DRAFT, TENANT, CSRF)).kind, 'ok');
  const variants: Array<Parameters<typeof previewBody>[0] | Record<string, unknown>> = [
    { draft: { id: uuid(0xd42) } }, { draft: { version: MAX } }, { draft: { version: 0 } }, { draft: { subtotalCents: 2000 } },
    { draft: { lines: [{ ...LINES[0], position: 2 }] } }, { draft: { lines: [{ ...LINES[0], lineTotalCents: 1998 }] } }, { draft: { lines: [] } },
    { draft: { lines: [{ ...LINES[0], description: ' Screen' }] } }, { draft: { extra: 1 } },
    { customer: { name: '' } }, { customer: { name: `A${unit(0xdc00)}` } }, { customer: { name: 'x'.repeat(201) } }, { customer: { version: 0 } }, { customer: { id: 'c-1' } },
    { settings: { version: 0 } }, { settings: { legalName: 'x'.repeat(201) } }, { settings: { tax: { mode: 'none' } } }, // the amounts still say a rate
    { settings: { tax: { mode: 'exclusive_rate', rateMilliPercent: 8000 } } },
    { amounts: { currency: 'EUR' } }, { amounts: { totalCents: 2177 } }, { amounts: { tax: { mode: 'exclusive_rate', label: 'VAT', rateMilliPercent: 8875, amountCents: 177 } } },
    { amounts: { tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 178 }, totalCents: 2177 } },
    { amounts: { tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875 } } },
    { settings: { tax: { mode: 'none' } }, amounts: { ...NONE_AMOUNTS, tax: { mode: 'none', description: 'No tax' } } },
    { settings: { tax: { mode: 'none' } }, amounts: { ...NONE_AMOUNTS, totalCents: 2000 } },
    // The amounts' own subtotal must be the draft's: the tax and Total below still derive from 1999.
    { amounts: { subtotalCents: 2000 } }, { settings: { tax: { mode: 'none' } }, amounts: { ...NONE_AMOUNTS, subtotalCents: 2000 } },
    { expected: { expectedTenant: uuid(0x7e2) } }, { expected: { expectedVersion: 3 } }, { expected: { expectedSettingsVersion: 2 } }, { expected: { expectedCustomerVersion: 3 } },
    { expected: { extra: 1 } },
  ];
  const bad = scripted(...variants.map((v) => json(200, previewBody(v as Parameters<typeof previewBody>[0]))), json(200, { ...previewBody(), more: 1 }));
  for (let i = 0; i <= variants.length; i++) assert.deepEqual(await bad.client.issuePreview(STORE, DRAFT, TENANT, CSRF), { kind: 'unavailable' }, `case ${i}`);
  // The tenant passed in must be the one `expected` names (and a canonical one).
  const other = scripted(json(200, previewBody()), json(200, previewBody()));
  assert.deepEqual(await other.client.issuePreview(STORE, DRAFT, uuid(0x7e2), CSRF), { kind: 'unavailable' });
  assert.deepEqual(await other.client.issuePreview(STORE, DRAFT, TENANT.toUpperCase(), CSRF), { kind: 'unavailable' });
});

test('IIC-11. the preview\'s refusals in the chain\'s envelope: 404 not-found, 409 invalid_state / issuing_not_configured / amount_out_of_range, the reads\' 401/403/429; a sealed shape, another word or status, no answer — unavailable; an id outside its grammar sends nothing', async () => {
  const table: Array<[Response | Error, string]> = [
    [refused(404, 'not_found'), 'not-found'], [refused(409, 'invalid_state'), 'invalid-state'], [refused(409, 'issuing_not_configured'), 'not-configured'],
    [refused(409, 'amount_out_of_range'), 'out-of-range'], [refused(401, 'unauthenticated'), 'signed-out'], [refused(403, 'forbidden'), 'denied'], [refused(429, 'rate_limited'), 'rate-limited'],
    [sealed(409, 'issuing_not_configured'), 'unavailable'], [refused(409, 'write_conflict'), 'unavailable'], [refused(400, 'invalid_request'), 'unavailable'],
    [refused(503, 'service_unavailable'), 'unavailable'], [network(), 'unavailable'],
  ];
  for (const [reply, kind] of table) {
    const { calls, client } = scripted(reply);
    assert.equal((await client.issuePreview(STORE, DRAFT, TENANT, CSRF)).kind, kind);
    assert.equal(calls.length, 1);
  }
  const { calls, client } = scripted();
  assert.deepEqual(await client.issuePreview(STORE, 'd-1', TENANT, CSRF), { kind: 'not-found' });
  assert.equal(calls.length, 0);
});

test('IIC-12. the issue body is built ONCE from `expected` in its fixed key order, at most 1 KiB, or nothing for a value the planner refuses; an issue is ONE POST of those exact bytes', async () => {
  const expected = { expectedTenant: TENANT, expectedVersion: 4, expectedSettingsVersion: 3, expectedCustomerVersion: 2 };
  assert.equal(issueBodyOf(expected), ISSUE_BODY);
  assert.deepEqual(Object.keys(JSON.parse(ISSUE_BODY)), ['expectedTenant', 'expectedVersion', 'expectedSettingsVersion', 'expectedCustomerVersion']);
  assert.ok(new TextEncoder().encode(issueBodyOf({ ...expected, expectedVersion: MAX - 1, expectedSettingsVersion: MAX, expectedCustomerVersion: MAX }) ?? '').length <= ISSUE_BODY_MAX_BYTES);
  for (const over of [{ expectedTenant: 'x' }, { expectedVersion: 0 }, { expectedVersion: MAX }, { expectedVersion: -0 }, { expectedSettingsVersion: 0 }, { expectedCustomerVersion: 1.5 }]) {
    assert.equal(issueBodyOf({ ...expected, ...over }), null, JSON.stringify(over));
  }
  const { calls, client } = scripted(json(201, created(), { location: LOCATION }));
  assert.deepEqual(await client.issue(STORE, DRAFT, ISSUE_BODY, KEY, CSRF), { kind: 'issued', invoiceId: INVOICE, draftVersion: 5, replayed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, ISSUE_BODY);
  // What the client never sends: a body the planner refuses, an id outside its grammar.
  const none = scripted();
  const good = JSON.parse(ISSUE_BODY) as Record<string, unknown>;
  for (const body of [
    'nope', JSON.stringify({ ...good, extra: 1 }), JSON.stringify({ ...good, expectedVersion: 0 }), JSON.stringify({ ...good, expectedVersion: MAX }),
    JSON.stringify({ ...good, expectedSettingsVersion: 0 }), JSON.stringify({ ...good, expectedCustomerVersion: '2' }), ISSUE_BODY.replace('"expectedVersion":4', '"expectedVersion":-0'),
    JSON.stringify({ ...good, expectedTenant: TENANT.toUpperCase() }), `${ISSUE_BODY}${' '.repeat(ISSUE_BODY_MAX_BYTES)}`, settingsBody(2),
  ]) assert.deepEqual(await none.client.issue(STORE, DRAFT, body, KEY, CSRF), { kind: 'invalid' }, body.slice(0, 50));
  assert.deepEqual(await none.client.issue('s', DRAFT, ISSUE_BODY, KEY, CSRF), { kind: 'invalid' });
  assert.deepEqual(await none.client.issue(STORE, `${DRAFT}x`, ISSUE_BODY, KEY, CSRF), { kind: 'invalid' });
  assert.equal(none.calls.length, 0);
});

test('IIC-13. issued ONLY on an exact 201 naming the draft asked at its version SENT plus one, with a Location exactly that invoice\'s path at the store asked — compared, never followed; a missing or different Location is unknown', async () => {
  const replay = scripted(json(201, created(), { location: LOCATION, 'idempotent-replayed': 'true' }));
  assert.deepEqual(await replay.client.issue(STORE, DRAFT, ISSUE_BODY, KEY, CSRF), { kind: 'issued', invoiceId: INVOICE, draftVersion: 5, replayed: true });
  assert.equal(replay.calls.length, 1); // no request to the Location
  const unnamed: Response[] = [
    json(201, created()), // no Location
    json(201, created(), { location: `/api/v1/stores/${OTHER_STORE}/invoices/${INVOICE}` }),
    json(201, created(), { location: `https://shop.tmpos.test${LOCATION}` }),
    json(201, created(), { location: `${LOCATION}/` }),
    json(201, created(), { location: `/api/v1/stores/${STORE}/invoices/${uuid(0x1a2)}` }),
    json(201, created({ draft: { version: 4 } }), { location: LOCATION }),
    json(201, created({ draft: { version: 6 } }), { location: LOCATION }),
    json(201, created({ draft: { id: uuid(0xd42) } }), { location: LOCATION }),
    json(201, created({ invoice: { sourceDraftId: uuid(0xd42) } }), { location: LOCATION }),
    json(201, created({ invoice: { status: 'draft' } }), { location: LOCATION }),
    json(201, created({ draft: { status: 'draft' } }), { location: LOCATION }),
    json(201, created({ invoice: { number: 1 } }), { location: LOCATION }),
    json(201, { ...created(), extra: 1 }, { location: LOCATION }),
    json(201, { invoice: created().invoice }, { location: LOCATION }),
    json(201, created(), { location: LOCATION, 'idempotent-replayed': 'false' }),
    json(200, created(), { location: LOCATION }),
    new Response('created', { status: 201, headers: { location: LOCATION } }),
  ];
  const { calls, client } = scripted(...unnamed);
  for (let i = 0; i < unnamed.length; i++) assert.deepEqual(await client.issue(STORE, DRAFT, ISSUE_BODY, KEY, CSRF), { kind: 'unknown', responded: true }, `case ${i}`);
  assert.equal(calls.length, unnamed.length);
  assert.ok(calls.every((c) => c.init.method === 'POST' && c.url === issuePathOf(STORE, DRAFT)));
});

test('IIC-14. every other issue answer maps to ONE outcome by status AND word AND shape — the four sealed 409s, the chain\'s 409s, 404 and 422, the shared refusals — anything undecided (a 503, no answer) unknown; each ONE fetch, never retried', async () => {
  const table: Array<[Response | Error, unknown]> = [
    [sealed(409, 'write_conflict'), { kind: 'conflict' }],
    [sealed(409, 'invalid_state'), { kind: 'not-open' }],
    [sealed(409, 'issuing_not_configured'), { kind: 'not-configured' }],
    [sealed(409, 'amount_out_of_range'), { kind: 'out-of-range' }],
    [refused(409, 'write_conflict'), { kind: 'tenant-changed' }],
    [refused(409, 'request_in_progress'), { kind: 'in-progress' }],
    [refused(409, 'invalid_state'), { kind: 'unknown', responded: true }], // the chain never answers it here
    [refused(409, 'issuing_not_configured'), { kind: 'unknown', responded: true }],
    [refused(404, 'not_found'), { kind: 'not-found' }],
    [refused(422, 'idempotency_key_reused'), { kind: 'key-reused' }],
    [sealed(422, 'customer_not_found'), { kind: 'unknown', responded: true }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refused(403, 'forbidden'), { kind: 'denied' }],
    [refused(403, 'step_up_required'), { kind: 'unknown', responded: true }], // the issue needs no recent sign-in
    [refused(400, 'invalid_request'), { kind: 'invalid' }],
    [refused(413, 'content_too_large'), { kind: 'invalid' }],
    [refused(415, 'unsupported_media_type'), { kind: 'invalid' }],
    [refused(429, 'rate_limited', { 'retry-after': '3' }), { kind: 'rate-limited', retryAfterSeconds: 3 }],
    [refused(503, 'service_unavailable'), { kind: 'unknown', responded: true }],
    [new Response(null, { status: 502 }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'invalid_state', requestId: 7 }), { kind: 'unknown', responded: true }],
    [network(), { kind: 'unknown', responded: false }],
  ];
  for (const [reply, outcome] of table) {
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.issue(STORE, DRAFT, ISSUE_BODY, KEY, CSRF), outcome, JSON.stringify(outcome));
    assert.equal(calls.length, 1);
  }
});

test('IIC-15. one call is one fetch on every route: a 503 or no answer is never retried, and an aborted signal sends nothing', async () => {
  const body = settingsBody(2);
  const run = (client: ReturnType<typeof createInvoiceIssuingClient>, signal?: AbortSignal) => [
    () => client.getSettings(STORE, CSRF, signal), () => client.saveSettings(STORE, body, KEY, CSRF, signal), () => client.issueEligibility(STORE, DRAFT, CSRF, signal),
    () => client.issuePreview(STORE, DRAFT, TENANT, CSRF, signal), () => client.issue(STORE, DRAFT, ISSUE_BODY, KEY, CSRF, signal), () => client.listIssued(STORE, null, CSRF, signal),
    () => client.findIssued(STORE, DRAFT, CSRF, signal), () => client.getIssued(STORE, INVOICE, CSRF, signal),
  ];
  for (const failure of [() => refused(503, 'service_unavailable'), network]) {
    for (const call of run(scripted().client).keys()) {
      const { calls, client } = scripted(failure());
      const out = await run(client)[call]();
      assert.equal(calls.length, 1, `route ${call}`);
      assert.ok(out.kind === 'unavailable' || out.kind === 'unknown', `route ${call}: ${out.kind}`);
    }
  }
  const aborted = new AbortController();
  aborted.abort();
  const { calls, client } = scripted();
  for (const call of run(client, aborted.signal)) await call();
  assert.equal(calls.length, 0);
});

test('IIC-16. the issued list: newest number first, no id or source draft twice, a cursor only behind a full page naming its last invoice, never the anchor; every summary field exact; the cursor rides verbatim and only in its grammar', async () => {
  const page = Array.from({ length: ISSUED_PAGE_LIMIT }, (_, i) => summary(i, 100 - i));
  const next = cursorOf(page[page.length - 1].id);
  const ok = scripted(json(200, { invoices: page, nextCursor: next }), json(200, { invoices: [summary(30, 5)], nextCursor: null }), json(200, { invoices: [], nextCursor: null }));
  const first = await ok.client.listIssued(STORE, null, CSRF);
  assert.equal(first.kind === 'ok' && first.nextCursor, next);
  assert.equal(first.kind === 'ok' && first.invoices.length, ISSUED_PAGE_LIMIT);
  assert.deepEqual(first.kind === 'ok' && first.invoices[0], {
    id: uuid(0x1000), number: 100, sourceDraftId: uuid(0xd000), customerId: CUSTOMER, customerName: 'Ada Customer', currency: 'USD', totalCents: 2176, issuedAt: ISSUED_AT,
    status: 'issued', // M7B-INVOICES-VOID-P1: the lifecycle is now part of the decoded summary
  });
  const after = await ok.client.listIssued(STORE, next, CSRF);
  assert.equal(after.kind === 'ok' && after.nextCursor, null);
  assert.deepEqual(await ok.client.listIssued(STORE, null, CSRF), { kind: 'ok', invoices: [], nextCursor: null });
  assert.equal(ok.calls[1].url, `${issuedInvoicesPathOf(STORE)}?limit=${ISSUED_PAGE_LIMIT}&cursor=${next}`);
  const bad: unknown[] = [
    { invoices: [summary(0, 5), summary(1, 5)], nextCursor: null }, // a number twice
    { invoices: [summary(0, 5), summary(1, 6)], nextCursor: null }, // ascending
    { invoices: [summary(0, 6), { ...summary(1, 5), id: uuid(0x1000) }], nextCursor: null },
    { invoices: [summary(0, 6), { ...summary(1, 5), sourceDraftId: uuid(0xd000) }], nextCursor: null },
    { invoices: [summary(0, 5)], nextCursor: cursorOf(uuid(0x1000)) }, // a cursor behind a short page
    { invoices: page, nextCursor: cursorOf(page[0].id) }, // a cursor that names another invoice
    { invoices: page, nextCursor: cursorOf(page[page.length - 1].id, 0x01) }, // another tag (the drafts')
    { invoices: [summary(0, 5, { status: 'paid' })], nextCursor: null },
    { invoices: [summary(0, 5, { snapshotVersion: 2 })], nextCursor: null },
    { invoices: [summary(0, 5, { currency: 'EUR' })], nextCursor: null },
    { invoices: [summary(0, 5, { issuedAt: '2026-10-16T21:45:00.123Z' })], nextCursor: null },
    { invoices: [summary(0, 5, { number: 0 })], nextCursor: null },
    { invoices: [summary(0, 5, { totalCents: MAX + 1 })], nextCursor: null },
    { invoices: [summary(0, 5, { customerName: '' })], nextCursor: null },
    { invoices: [summary(0, 5, { balanceCents: 0 })], nextCursor: null },
    { invoices: [...page, summary(99, 1)], nextCursor: null }, // more than the limit
    { invoices: [], nextCursor: null, total: 0 },
  ];
  const { calls, client } = scripted(...bad.map((b) => json(200, b)), json(200, { invoices: [summary(0, 9, { id: uuid(0x1099) })], nextCursor: null }));
  for (let i = 0; i < bad.length; i++) assert.deepEqual(await client.listIssued(STORE, null, CSRF), { kind: 'unavailable' }, `case ${i}`);
  assert.deepEqual(await client.listIssued(STORE, cursorOf(uuid(0x1099)), CSRF), { kind: 'unavailable' }); // the anchor itself is never on the page after it
  assert.equal(calls.length, bad.length + 1);
  // A cursor outside its grammar is never sent; the server's cursor 400 is bad-cursor only when a cursor was sent.
  const none = scripted(refused(400, 'invalid_request'), refused(400, 'invalid_request'), refused(401, 'unauthenticated'), refused(403, 'forbidden'), refused(429, 'rate_limited'));
  for (const cursor of ['', 'x', cursorOf(uuid(1), 0x01), `${cursorOf(uuid(1))}=`, cursorOf(uuid(1)).replace(/.$/, 'B')]) {
    assert.deepEqual(await none.client.listIssued(STORE, cursor, CSRF), { kind: 'bad-cursor' }, cursor);
  }
  assert.deepEqual(await none.client.listIssued('x', null, CSRF), { kind: 'denied' });
  assert.equal(none.calls.length, 0);
  assert.deepEqual(await none.client.listIssued(STORE, next, CSRF), { kind: 'bad-cursor' });
  assert.deepEqual(await none.client.listIssued(STORE, null, CSRF), { kind: 'unavailable' });
  assert.deepEqual((await none.client.listIssued(STORE, null, CSRF)).kind, 'signed-out');
  assert.deepEqual((await none.client.listIssued(STORE, null, CSRF)).kind, 'denied');
  assert.deepEqual((await none.client.listIssued(STORE, null, CSRF)).kind, 'rate-limited');
});

test('IIC-17. the sourceDraft lookup stands alone (no limit, no cursor): at most one invoice, OF THAT DRAFT, with no cursor — an empty answer is "none found", never more; another draft\'s, two, or a cursor is unavailable', async () => {
  const mine = summary(1, 7, { sourceDraftId: DRAFT });
  const ok = scripted(json(200, { invoices: [mine], nextCursor: null }), json(200, { invoices: [], nextCursor: null }));
  const found = await ok.client.findIssued(STORE, DRAFT, CSRF);
  assert.equal(found.kind === 'ok' && found.invoice?.number, 7);
  assert.deepEqual(await ok.client.findIssued(STORE, DRAFT, CSRF), { kind: 'ok', invoice: null });
  assert.deepEqual(ok.calls.map((c) => c.url), [`${issuedInvoicesPathOf(STORE)}?sourceDraft=${DRAFT}`, `${issuedInvoicesPathOf(STORE)}?sourceDraft=${DRAFT}`]);
  const bad = [
    { invoices: [summary(1, 7)], nextCursor: null }, { invoices: [mine, { ...summary(2, 6), sourceDraftId: DRAFT }], nextCursor: null },
    { invoices: [mine], nextCursor: cursorOf(mine.id) }, { invoices: [{ ...mine, status: 'draft' }], nextCursor: null },
  ];
  const { calls, client } = scripted(...bad.map((b) => json(200, b)), refused(401, 'unauthenticated'), refused(403, 'forbidden'), refused(429, 'rate_limited'), refused(400, 'invalid_request'), network());
  for (let i = 0; i < bad.length; i++) assert.deepEqual(await client.findIssued(STORE, DRAFT, CSRF), { kind: 'unavailable' }, `case ${i}`);
  assert.deepEqual((await Promise.all([0, 1, 2, 3, 4].map(() => client.findIssued(STORE, DRAFT, CSRF)))).map((r) => r.kind), ['signed-out', 'denied', 'rate-limited', 'unavailable', 'unavailable']);
  assert.equal(calls.length, bad.length + 5);
  const none = scripted();
  assert.deepEqual(await none.client.findIssued(STORE, 'd', CSRF), { kind: 'denied' });
  assert.deepEqual(await none.client.findIssued(`${STORE}x`, DRAFT, CSRF), { kind: 'denied' });
  assert.equal(none.calls.length, 0);
});

test('IIC-18. the issued invoice: exactly its snapshot (version 1, issued) for the invoice asked — seller values in their stored form, lines and amounts their own arithmetic, the reviewed draft version, no field it never serves; 404 not-found; anything else unavailable', async () => {
  const none = detailBody({ amounts: NONE_AMOUNTS, seller: { legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St', taxRegistrationId: null } });
  const ok = scripted(json(200, detailBody()), json(200, none));
  const got = await ok.client.getIssued(STORE, INVOICE, CSRF);
  assert.equal(got.kind, 'ok');
  if (got.kind === 'ok') {
    assert.equal(got.invoice.number, 7);
    assert.deepEqual(got.invoice.sourceDraft, { id: DRAFT, version: 4 });
    assert.deepEqual(got.invoice.amounts.tax, { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 8875, amountCents: 177 });
    assert.equal(got.invoice.seller.postalAddress, '1 Main St\nSpringfield');
  }
  const noTax = await ok.client.getIssued(STORE, INVOICE, CSRF);
  assert.deepEqual(noTax.kind === 'ok' && noTax.invoice.amounts.tax, { mode: 'none', description: 'No tax calculated' });
  const variants: Array<Record<string, unknown>> = [
    { id: uuid(0x1a2) }, { status: 'paid' }, { snapshotVersion: 2 }, { number: 0 }, { issuedAt: '2026-10-16 21:45:00' }, { sourceDraft: { id: DRAFT, version: MAX } },
    { sourceDraft: { id: DRAFT } }, { issuingSettingsVersion: 0 }, { seller: { legalName: 'Example Repairs LLC', storeName: 'Main Street', postalAddress: '1 Main St\n', taxRegistrationId: null } },
    { seller: { legalName: 'Example', storeName: 'Main Street', postalAddress: '1 Main St', taxRegistrationId: null, phone: '1' } }, { customer: { id: CUSTOMER, name: 'Ada', version: 2, email: 'a@b' } },
    { lines: [{ ...LINES[0], unitPriceCents: 1998 }] }, { amounts: { ...detailBody().invoice.amounts, totalCents: 2175 } }, { amounts: { ...NONE_AMOUNTS, subtotalCents: 1998 } },
    { actor: 'uid-a' }, { amountDueCents: 2176 },
  ];
  const { calls, client } = scripted(...variants.map((v) => json(200, detailBody(v))), json(200, { ...detailBody(), more: 1 }), refused(404, 'not_found'), sealed(404, 'not_found'),
    refused(403, 'forbidden'), refused(401, 'unauthenticated'), refused(429, 'rate_limited'), refused(503, 'service_unavailable'), network());
  for (let i = 0; i <= variants.length; i++) assert.deepEqual(await client.getIssued(STORE, INVOICE, CSRF), { kind: 'unavailable' }, `case ${i}`);
  const kinds = [];
  for (let i = 0; i < 7; i++) kinds.push((await client.getIssued(STORE, INVOICE, CSRF)).kind);
  assert.deepEqual(kinds, ['not-found', 'unavailable', 'denied', 'signed-out', 'rate-limited', 'unavailable', 'unavailable']);
  assert.equal(calls.length, variants.length + 8);
  const nothing = scripted();
  assert.deepEqual(await nothing.client.getIssued(STORE, 'i-1', CSRF), { kind: 'not-found' });
  assert.equal(nothing.calls.length, 0);
});

test('IIC-19. rates: a percentage converts EXACTLY to thousandths (8.875 is 8875, 0 is 0, 100 is 100000) and back; unsupported precision, range, signs, exponents and leading zeros are refused', () => {
  const accepted: Array<[string, number]> = [
    ['8.875', 8875], ['0', 0], ['0.0', 0], ['0.000', 0], ['100', 100000], ['100.000', 100000], ['5', 5000], ['0.5', 500], ['0.001', 1], ['12.34', 12340], [' 7.25 ', 7250], ['99.999', 99999],
  ];
  for (const [text, milli] of accepted) assert.equal(parseRatePercent(text), milli, text);
  for (const text of ['', ' ', '100.001', '101', '8.8755', '1e2', '-1', '+1', '08', '00', '.5', '5.', '5,5', '0x10', 'NaN', 'Infinity', '1 000', `5${cp(0x066b)}5`, '５', '1000']) {
    assert.equal(parseRatePercent(text), null, JSON.stringify(text));
  }
  const shown: Array<[number, string]> = [[8875, '8.875%'], [5000, '5%'], [0, '0%'], [500, '0.5%'], [1, '0.001%'], [100000, '100%'], [12340, '12.34%'], [99999, '99.999%']];
  for (const [milli, text] of shown) assert.equal(rateText(milli), text);
  for (let milli = 0; milli <= 100000; milli += 37) assert.equal(parseRatePercent(rateDigits(milli)), milli); // a round trip, sampled
  assert.equal(parseRatePercent(rateDigits(100000)), 100000);
});

test('IIC-20. money is exact cents to 2^53-1 (digit arithmetic, never a float) through a decoded invoice, and the issue time is the stored UTC, sliced', async () => {
  for (const [cents, text] of [[0, '$0.00'], [1, '$0.01'], [99, '$0.99'], [100, '$1.00'], [MAX, '$90,071,992,547,409.91'], [MAX - 1, '$90,071,992,547,409.90']] as const) {
    assert.equal(formatCents(cents), text);
  }
  // The largest total an invoice can carry, decoded and formatted without losing its last cent.
  const big = detailBody({
    lines: [{ position: 1, description: 'All of it', quantity: 1, unitPriceCents: MAX, lineTotalCents: MAX }],
    amounts: { currency: 'USD', subtotalCents: MAX, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 0, amountCents: 0 }, totalCents: MAX },
  });
  const over = detailBody({
    lines: [{ position: 1, description: 'All of it', quantity: 1, unitPriceCents: MAX, lineTotalCents: MAX }],
    amounts: { currency: 'USD', subtotalCents: MAX, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: 1, amountCents: 90071992547 }, totalCents: MAX },
  });
  const { client } = scripted(json(200, big), json(200, over));
  const got = await client.getIssued(STORE, INVOICE, CSRF);
  assert.equal(got.kind === 'ok' && formatCents(got.invoice.amounts.totalCents), '$90,071,992,547,409.91');
  assert.deepEqual(await client.getIssued(STORE, INVOICE, CSRF), { kind: 'unavailable' }); // a total past 2^53-1 is never an answer
  assert.equal(utcText(ISSUED_AT), '2026-10-16 21:45:00 UTC');
  assert.equal(utcText('2026-01-02T03:04:05.000000Z'), '2026-01-02 03:04:05 UTC');
});

test('IIC-21. the client keeps nothing and logs nothing: no storage, cookie, history, location or console in its source, and no server module imported', () => {
  const source = readFileSync(new URL('./invoiceIssuingClient.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|history\.|location\.(href|search|hash)/);
  assert.doesNotMatch(source, /from '[^']*server\//);
});

test('IIC-22. the tax rounds half a cent UP exactly as the server does (invoiceIssuing.ts invoiceTaxOf): 10 cents at 5 % is 1, 9 cents 0, 30 cents 2, one cent at 50 % is 1 and at 49.999 % 0 — and across a sweep of subtotals and rates the preview takes exactly the server\'s amounts, never a cent off', async () => {
  const previewAt = (subtotal: number, rate: number, amounts: object) => previewBody({
    draft: { lines: [{ position: 1, description: 'A', quantity: 1, unitPriceCents: subtotal, lineTotalCents: subtotal }], subtotalCents: subtotal },
    settings: { tax: { mode: 'exclusive_rate', rateMilliPercent: rate } }, amounts,
  });
  const decode = async (subtotal: number, rate: number, amounts: object) => scripted(json(200, previewAt(subtotal, rate, amounts))).client.issuePreview(STORE, DRAFT, TENANT, CSRF);
  const taxed = (subtotal: number, rate: number, amountCents: number) => ({
    currency: 'USD', subtotalCents: subtotal, tax: { mode: 'exclusive_rate', label: 'Tax', rateMilliPercent: rate, amountCents }, totalCents: subtotal + amountCents,
  });
  for (const [subtotal, rate, tax] of [[10, 5000, 1], [9, 5000, 0], [30, 5000, 2], [1, 50_000, 1], [1, 49_999, 0], [20, 5000, 1]] as const) {
    assert.equal(invoiceTaxOf(BigInt(subtotal), rate), BigInt(tax), `the server's tax of ${subtotal} at ${rate}`);
    assert.equal((await decode(subtotal, rate, taxed(subtotal, rate, tax))).kind, 'ok', `${subtotal} at ${rate} is ${tax}`);
    assert.deepEqual(await decode(subtotal, rate, taxed(subtotal, rate, tax + 1)), { kind: 'unavailable' }, `${subtotal} at ${rate} is not ${tax + 1}`);
    if (tax > 0) assert.deepEqual(await decode(subtotal, rate, taxed(subtotal, rate, tax - 1)), { kind: 'unavailable' }, `${subtotal} at ${rate} is not ${tax - 1}`);
  }
  const subtotals = [1, 2, 3, 9, 10, 11, 19, 20, 21, 29, 30, 99, 100, 101, 999, 1999, 12_345, 99_999, 1_000_001, 2 ** 31 + 7, 2 ** 40 + 3];
  const rates = [0, 1, 2, 4999, 5000, 5001, 8875, 12_500, 49_999, 50_000, 50_001, 99_999, 100_000];
  let swept = 0;
  for (const subtotal of subtotals) {
    for (const rate of rates) {
      const server = issueAmountsOf(subtotal, { mode: 'exclusive_rate', rateMilliPercent: rate });
      assert.notEqual(server, 'amount_out_of_range');
      if (server === 'amount_out_of_range') continue;
      const got = await decode(subtotal, rate, JSON.parse(JSON.stringify(server)));
      assert.equal(got.kind, 'ok', `${subtotal} at ${rate}`);
      if (got.kind === 'ok') assert.deepEqual(got.preview.amounts, server, `${subtotal} at ${rate}`);
      swept += 1;
    }
  }
  assert.equal(swept, subtotals.length * rates.length);
});

// M7B-INVOICES-VOID-P1 — the lifecycle on the two existing reads: list rows and the lookup carry `issued` or `voided` (keys
// unchanged); a detail is issued with NO `void` key, or voided with exactly `void: { voidedAt, reasonCode }`. Everything else
// is still unavailable, and one bad row still sinks the whole page.
const VOIDED_AT = '2026-10-17T08:00:00.000001Z';
const voidedDetail = (voidMember: unknown = { voidedAt: VOIDED_AT, reasonCode: 'wrong_customer' }, over: Record<string, unknown> = {}) =>
  detailBody({ status: 'voided', void: voidMember, ...over });

test('IIC-23. the issued list and the sourceDraft lookup accept status "voided" exactly as "issued" (same ten keys) and say which; any other status, or one bad row on a mixed page, is unavailable', async () => {
  const mixed = [summary(0, 9), summary(1, 8, { status: 'voided' }), summary(2, 7)];
  const mine = summary(3, 6, { sourceDraftId: DRAFT, status: 'voided' });
  const ok = scripted(json(200, { invoices: mixed, nextCursor: null }), json(200, { invoices: [mine], nextCursor: null }));
  const page = await ok.client.listIssued(STORE, null, CSRF);
  assert.deepEqual(page.kind === 'ok' && page.invoices.map((row) => [row.number, row.status]), [[9, 'issued'], [8, 'voided'], [7, 'issued']]);
  const found = await ok.client.findIssued(STORE, DRAFT, CSRF);
  assert.deepEqual(found.kind === 'ok' && found.invoice, {
    id: mine.id, number: 6, sourceDraftId: DRAFT, customerId: CUSTOMER, customerName: 'Ada Customer', currency: 'USD', totalCents: 2176, issuedAt: ISSUED_AT, status: 'voided',
  });
  const bad: unknown[] = [
    { invoices: [summary(0, 9), summary(1, 8, { status: 'void' }), summary(2, 7)], nextCursor: null },
    { invoices: [summary(0, 9), summary(1, 8, { status: 'Voided' }), summary(2, 7)], nextCursor: null },
    { invoices: [summary(0, 9, { status: 'voided', void: { voidedAt: VOIDED_AT, reasonCode: 'other' } })], nextCursor: null }, // a row never carries the void
    { invoices: [summary(0, 9, { status: 'voided', voidedAt: VOIDED_AT })], nextCursor: null },
    { invoices: [summary(0, 9, { status: null })], nextCursor: null },
  ];
  const { calls, client } = scripted(...bad.map((b) => json(200, b)), json(200, { invoices: [{ ...mine, status: 'refunded' }], nextCursor: null }));
  for (let i = 0; i < bad.length; i++) assert.deepEqual(await client.listIssued(STORE, null, CSRF), { kind: 'unavailable' }, `case ${i}`);
  assert.deepEqual(await client.findIssued(STORE, DRAFT, CSRF), { kind: 'unavailable' });
  assert.equal(calls.length, bad.length + 1);
});

test('IIC-24. the issued invoice\'s lifecycle: issued has void null and no `void` key; voided has exactly { voidedAt, reasonCode } (issuedAt\'s form, not before it, one of the six codes); every other combination is unavailable', async () => {
  const codes = Object.keys(INVOICE_VOID_REASONS);
  assert.deepEqual(codes, ['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other']);
  assert.deepEqual(Object.values(INVOICE_VOID_REASONS), ['Issued by mistake', 'Wrong customer', 'Wrong lines or amounts', 'Wrong seller details', 'Duplicate of another invoice', 'Other reason']);
  const accepted = [...codes.map((code) => voidedDetail({ voidedAt: VOIDED_AT, reasonCode: code })), voidedDetail({ voidedAt: ISSUED_AT, reasonCode: 'other' })];
  const ok = scripted(json(200, detailBody()), ...accepted.map((body) => json(200, body)));
  const issued = await ok.client.getIssued(STORE, INVOICE, CSRF);
  assert.deepEqual(issued.kind === 'ok' && [issued.invoice.status, issued.invoice.void], ['issued', null]);
  for (const [i, code] of [...codes, 'other'].entries()) {
    const got = await ok.client.getIssued(STORE, INVOICE, CSRF);
    assert.deepEqual(got.kind === 'ok' && [got.invoice.status, got.invoice.void], ['voided', { voidedAt: i < codes.length ? VOIDED_AT : ISSUED_AT, reasonCode: code }], code);
    assert.equal(got.kind === 'ok' && got.invoice.number, 7); // the snapshot is unchanged beside it
  }
  const bad: unknown[] = [
    detailBody({ void: { voidedAt: VOIDED_AT, reasonCode: 'other' } }), // issued with a void key
    detailBody({ void: null }), // issued with an empty one
    detailBody({ status: 'voided' }), // voided without it
    voidedDetail(null),
    voidedDetail({ voidedAt: VOIDED_AT }),
    voidedDetail({ reasonCode: 'other' }),
    voidedDetail({ voidedAt: VOIDED_AT, reasonCode: 'other', actor: 'uid-a' }), // an extra key in void
    voidedDetail({ voidedAt: VOIDED_AT, reasonCode: 'other', note: 'x' }),
    voidedDetail({ voidedAt: VOIDED_AT, reasonCode: 'Other reason' }), // a label is not a code
    voidedDetail({ voidedAt: VOIDED_AT, reasonCode: 'invoice_void_other' }), // the audit's form is not the wire's
    voidedDetail({ voidedAt: VOIDED_AT, reasonCode: 'refunded' }),
    voidedDetail({ voidedAt: VOIDED_AT, reasonCode: 'toString' }), // an inherited name is not one of the six
    voidedDetail({ voidedAt: VOIDED_AT, reasonCode: 1 }),
    voidedDetail({ voidedAt: '2026-10-17T08:00:00.000Z', reasonCode: 'other' }), // not issuedAt's encoding
    voidedDetail({ voidedAt: '2026-10-17 08:00:00', reasonCode: 'other' }),
    voidedDetail({ voidedAt: '2026-02-30T08:00:00.000000Z', reasonCode: 'other' }), // no such instant
    voidedDetail({ voidedAt: '2026-10-16T21:45:00.123455Z', reasonCode: 'other' }), // a microsecond before the issue
    voidedDetail({ voidedAt: '2025-12-31T23:59:59.999999Z', reasonCode: 'other' }),
    voidedDetail({ voidedAt: null, reasonCode: 'other' }),
    voidedDetail([VOIDED_AT, 'other']),
    voidedDetail(undefined, { status: 'void' }),
    voidedDetail(undefined, { status: 'issued' }), // the void member under the issued status
    voidedDetail(undefined, { snapshotVersion: 2 }), // the lifecycle is not a snapshot version
    voidedDetail(undefined, { voidedAt: VOIDED_AT }), // a second lifecycle member at the top
    { ...voidedDetail(), more: 1 },
  ];
  const { calls, client } = scripted(...bad.map((b) => json(200, b)));
  for (let i = 0; i < bad.length; i++) assert.deepEqual(await client.getIssued(STORE, INVOICE, CSRF), { kind: 'unavailable' }, `case ${i}`);
  assert.equal(calls.length, bad.length);
});

test('IIC-25. the shop\'s six void reasons are the server\'s (server/runtime/invoiceVoid.ts): the same codes in INVOICE_VOID_REASON_CODES\'s order, and each the same label as INVOICE_VOID_REASON_LABELS, in that order', () => {
  assert.deepEqual(Object.keys(INVOICE_VOID_REASONS), [...INVOICE_VOID_REASON_CODES]);
  assert.deepEqual(Object.keys(INVOICE_VOID_REASON_LABELS), [...INVOICE_VOID_REASON_CODES]);
  assert.deepEqual(Object.entries(INVOICE_VOID_REASONS), Object.entries(INVOICE_VOID_REASON_LABELS));
});

// M7B-INVOICES-VOID-P2 — the void's two routes (server/runtime/invoiceVoid.ts, doc 13 §12.4): the action-only eligibility
// read and the void command. The body is exactly {"expectedTenant","reasonCode"} (no version), sent byte for byte or not at
// all; the 200 counts only for the invoice asked; a refusal only by status AND word AND envelope; one fetch per call, the
// POST never aborted by its caller.
const VOID_BODY = `{"expectedTenant":"${TENANT}","reasonCode":"wrong_customer"}`;
const VOID_PATH = `/api/v1/stores/${STORE}/invoices/${INVOICE}/void`;
const voidedAnswer = (over: Record<string, unknown> = {}) => ({ invoice: { id: INVOICE, status: 'voided', ...over } });
/** Canonical lowercase uuids the void planner still refuses (server/runtime/outbox.ts UUID_RE: version 1-8, variant 10xx). */
const NOT_VOID_TARGETS = [
  '00000000-0000-0000-0000-000000000000', // the nil uuid
  '000001a1-0000-0000-8000-0000000001a1', '000001a1-0000-9000-8000-0000000001a1', '000001a1-0000-f000-8000-0000000001a1', // version 0, 9, f
  '000001a1-0000-4000-7000-0000000001a1', '000001a1-0000-4000-c000-0000000001a1', '000001a1-0000-4000-f000-0000000001a1', // variant 0xxx, 110x, 111x
];
/** A table row's name for its assertion message: the status, the exact body and any header but the content type. */
const rowName = async (reply: Response | Error): Promise<string> => (reply instanceof Response
  ? `${reply.status} ${await reply.clone().text()}${[...reply.headers].filter(([name]) => name !== 'content-type').map(([name, value]) => ` ${name}: ${value}`).join('')}`
  : `no answer (${reply.message})`);

test('IIC-26. the void\'s two requests: GET …/void-eligibility with the session token alone, POST …/void with exactly the five command headers and the body\'s exact bytes — same-origin, credentialed, uncached, never redirected, no referrer; one fetch each; the POST takes no signal of its caller\'s', async () => {
  const { calls, client } = scripted(refused(503, 'service_unavailable'), refused(503, 'service_unavailable'));
  await client.voidEligibility(STORE, INVOICE, CSRF);
  await client.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF);
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [`GET ${VOID_PATH}-eligibility`, `POST ${VOID_PATH}`]);
  assert.equal(voidEligibilityPathOf(STORE, INVOICE), `${issuedInvoicePathOf(STORE, INVOICE)}/void-eligibility`);
  assert.equal(voidPathOf(STORE, INVOICE), VOID_PATH);
  for (const call of calls) {
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.mode, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.ok(call.init.signal instanceof AbortSignal); // the client's own timeout, never the caller's
    assert.ok(!call.url.includes(CSRF) && !call.url.includes('?'));
  }
  const [read, post] = calls.map(headersOf);
  assert.deepEqual([...read.entries()], [['accept', 'application/json'], ['x-tmpos-session-csrf', CSRF]]);
  assert.deepEqual([...post.entries()], [
    ['accept', 'application/json'], ['content-type', 'application/json'], ['idempotency-key', KEY], ['x-tmpos-csrf', '1'], ['x-tmpos-session-csrf', CSRF],
  ]);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[1].init.body, VOID_BODY); // the caller's string itself, never re-serialized
  assert.equal(client.voidInvoice.length, 5); // (storeId, invoiceId, key, body, csrf): no AbortSignal parameter
  // An aborted signal sends no eligibility read.
  const aborted = new AbortController();
  aborted.abort();
  const none = scripted();
  assert.deepEqual(await none.client.voidEligibility(STORE, INVOICE, CSRF, aborted.signal), { kind: 'unavailable' });
  assert.equal(none.calls.length, 0);
});

test('IIC-27. the void body is built ONCE in its fixed key order — exactly {"expectedTenant","reasonCode"}, no version or other key — for a canonical tenant and one of the six codes in their one order; anything else is null', () => {
  assert.equal(voidBodyOf(TENANT, 'wrong_customer'), VOID_BODY);
  assert.deepEqual([...VOID_REASON_CODES], ['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other']);
  assert.deepEqual([...VOID_REASON_CODES], [...INVOICE_VOID_REASON_CODES]); // the server's order
  assert.deepEqual([...VOID_REASON_CODES], Object.keys(INVOICE_VOID_REASONS)); // the label map's own keys
  assert.ok(Object.isFrozen(VOID_REASON_CODES));
  for (const code of VOID_REASON_CODES) {
    const body = voidBodyOf(TENANT, code);
    assert.equal(body, `{"expectedTenant":"${TENANT}","reasonCode":"${code}"}`);
    assert.deepEqual(Object.keys(JSON.parse(body ?? '{}')), ['expectedTenant', 'reasonCode']);
    assert.ok(new TextEncoder().encode(body ?? '').length <= 1024);
  }
  for (const [tenant, code] of [
    [TENANT.toUpperCase(), 'other'], ['t-1', 'other'], ['', 'other'], [` ${TENANT}`, 'other'], [`${TENANT}x`, 'other'],
    [TENANT, ''], [TENANT, 'Other reason'], [TENANT, 'Other'], [TENANT, ' other'], [TENANT, 'invoice_void_other'], [TENANT, 'refunded'], [TENANT, 'toString'],
    [TENANT, '__proto__'], [TENANT, 'void'],
  ]) assert.equal(voidBodyOf(tenant, code), null, `${tenant} ${code}`);
  assert.equal(voidBodyOf(TENANT, 7 as unknown as string), null);
  assert.equal(voidBodyOf(null as unknown as string, 'other'), null);
});

test('IIC-28. a void sends NOTHING (`not-sent`, which no server answer can be) unless its body is byte for byte voidBodyOf\'s, its store id canonical and its invoice id the planner\'s target grammar (version 1-8, variant 10xx) — the nil uuid, another version or variant, or (body, key) swapped included; the exact body is ONE POST', async () => {
  const good = { expectedTenant: TENANT, reasonCode: 'wrong_customer' };
  const { calls, client } = scripted();
  for (const body of [
    '', 'nope', '[]', 'null', JSON.stringify({ reasonCode: 'wrong_customer', expectedTenant: TENANT }), JSON.stringify(good, null, 1), `${VOID_BODY} `, ` ${VOID_BODY}`, `${VOID_BODY}\n`,
    JSON.stringify({ ...good, expectedVersion: 1 }), JSON.stringify({ ...good, snapshotVersion: 1 }), JSON.stringify({ ...good, note: '' }), JSON.stringify({ expectedTenant: TENANT }),
    JSON.stringify({ reasonCode: 'other' }), JSON.stringify({ ...good, expectedTenant: TENANT.toUpperCase() }), JSON.stringify({ ...good, reasonCode: 'Wrong customer' }),
    JSON.stringify({ ...good, reasonCode: 'toString' }), JSON.stringify({ ...good, reasonCode: ['other'] }), VOID_BODY.replace('"wrong_customer"', '"wrong\\u005fcustomer"'),
    ISSUE_BODY, settingsBody(2), `${VOID_BODY}${' '.repeat(1024)}`,
  ]) assert.deepEqual(await client.voidInvoice(STORE, INVOICE, KEY, body, CSRF), { kind: 'not-sent' }, body.slice(0, 60));
  for (const [store, invoice] of [
    ['s', INVOICE], [STORE, 'i-1'], [STORE.toUpperCase(), INVOICE], [STORE, INVOICE.toUpperCase()], [STORE, `${INVOICE}/`], [`${STORE}/x`, INVOICE],
    ...NOT_VOID_TARGETS.map((id) => [STORE, id]), // the planner's target grammar: it would take the key only to answer 400
  ]) {
    assert.deepEqual(await client.voidInvoice(store, invoice, KEY, VOID_BODY, CSRF), { kind: 'not-sent' }, `${store} ${invoice}`);
  }
  assert.deepEqual(await client.voidInvoice(STORE, INVOICE, VOID_BODY, KEY, CSRF), { kind: 'not-sent' }); // (body, key) swapped: a key is never a body
  assert.equal(calls.length, 0);
  for (const id of NOT_VOID_TARGETS) assert.equal(isVoidTarget(id), false, id);
  const once = scripted(json(200, voidedAnswer()));
  assert.deepEqual(await once.client.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF), { kind: 'voided', replayed: false });
  assert.equal(once.calls.length, 1);
  assert.equal(once.calls[0].init.body, VOID_BODY);
  // Versions 1-8 with a variant of 10xx are the planner's: each is sent, once.
  const targets = ['000001a1-0000-1000-8000-0000000001a1', '000001a1-0000-8000-b000-0000000001a1', '000001a1-0000-7fff-9fff-0000000001a1'];
  const sent = scripted(...targets.map((id) => json(200, { invoice: { id, status: 'voided' } })));
  for (const id of targets) {
    assert.equal(isVoidTarget(id), true, id);
    assert.deepEqual(await sent.client.voidInvoice(STORE, id, KEY, VOID_BODY, CSRF), { kind: 'voided', replayed: false }, id);
  }
  assert.deepEqual(sent.calls.map((c) => c.url), targets.map((id) => voidPathOf(STORE, id)));
});

test('IIC-29. voided ONLY on an exact 200 { invoice: { id, status: "voided" } } naming the invoice asked, the replay header absent or exactly "true"; any other 200 (another id, an extra key, another status, another replay header, no JSON) is unknown, never success', async () => {
  const first = scripted(json(200, voidedAnswer()), json(200, voidedAnswer(), { 'idempotent-replayed': 'true' }));
  assert.deepEqual(await first.client.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF), { kind: 'voided', replayed: false });
  assert.deepEqual(await first.client.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF), { kind: 'voided', replayed: true });
  const unnamed: Response[] = [
    json(200, voidedAnswer({ id: uuid(0x1a2) })), // another invoice
    json(200, voidedAnswer({ id: INVOICE.toUpperCase() })),
    json(200, voidedAnswer({ status: 'issued' })), json(200, voidedAnswer({ status: 'void' })), json(200, voidedAnswer({ status: 'Voided' })),
    json(200, voidedAnswer({ voidedAt: '2026-10-17T08:00:00.000001Z' })), json(200, voidedAnswer({ reasonCode: 'other' })), // the 200 carries neither
    json(200, { ...voidedAnswer(), requestId: 'req-synthetic' }), json(200, { invoice: { id: INVOICE } }), json(200, { id: INVOICE, status: 'voided' }),
    json(200, { invoice: [INVOICE, 'voided'] }), json(200, {}), json(200, null),
    json(200, voidedAnswer(), { 'idempotent-replayed': 'false' }), json(200, voidedAnswer(), { 'idempotent-replayed': 'TRUE' }),
    json(200, voidedAnswer(), { 'idempotent-replayed': '1' }), json(200, voidedAnswer(), { 'idempotent-replayed': '' }),
    json(201, voidedAnswer()), new Response(JSON.stringify(voidedAnswer()), { status: 200 }), // no JSON content type
    new Response('{"invoice":', { status: 200, headers: { 'content-type': 'application/json' } }), // malformed
  ];
  const { calls, client } = scripted(...unnamed);
  for (let i = 0; i < unnamed.length; i++) assert.deepEqual(await client.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF), { kind: 'unknown', responded: true }, `case ${i}`);
  assert.equal(calls.length, unnamed.length);
  assert.ok(calls.every((c) => c.init.method === 'POST' && c.url === VOID_PATH && c.init.body === VOID_BODY));
});

test('IIC-30. every other void answer is ONE outcome by status AND word AND envelope: sealed 409 invalid_state already-void and write_conflict version-conflict (replayed too), never confused with the chain\'s; the chain\'s 409s, 422, 404, 403 step_up_required vs any other 403, 401, 429 with its wait, 400/413/415; a 503, an unnamed word or shape, no answer or a timeout is unknown — each ONE fetch, never retried', async () => {
  const table: Array<[Response | Error, unknown]> = [
    [sealed(409, 'invalid_state'), { kind: 'already-void' }],
    [json(409, { error: 'invalid_state' }, { 'idempotent-replayed': 'true' }), { kind: 'already-void' }], // its replay under the key
    [refused(409, 'invalid_state'), { kind: 'unknown', responded: true }], // the chain never says it: not "already void"
    [sealed(409, 'write_conflict'), { kind: 'version-conflict' }],
    [json(409, { error: 'write_conflict' }, { 'idempotent-replayed': 'true' }), { kind: 'version-conflict' }],
    [refused(409, 'write_conflict'), { kind: 'tenant-conflict' }], // the chain's: another tenant, rolled back — never the sealed one
    [refused(409, 'request_in_progress'), { kind: 'in-progress' }],
    [sealed(409, 'request_in_progress'), { kind: 'unknown', responded: true }],
    [json(409, { error: 'invalid_state', requestId: 7 }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'write_conflict', requestId: 'req-synthetic', more: 1 }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'invalid_state', more: 1 }), { kind: 'unknown', responded: true }],
    [refused(409, 'conflict'), { kind: 'unknown', responded: true }], // an unnamed word
    [refused(422, 'idempotency_key_reused'), { kind: 'key-reused' }],
    [sealed(422, 'idempotency_key_reused'), { kind: 'unknown', responded: true }],
    [refused(422, 'invalid_request'), { kind: 'unknown', responded: true }],
    [refused(404, 'not_found'), { kind: 'not-found' }],
    [sealed(404, 'not_found'), { kind: 'unknown', responded: true }],
    [refused(404, 'forbidden'), { kind: 'unknown', responded: true }],
    [refused(403, 'step_up_required'), { kind: 'step-up' }],
    [sealed(403, 'step_up_required'), { kind: 'unknown', responded: true }],
    [refused(403, 'forbidden'), { kind: 'denied' }],
    [refused(403, 'authz_context_missing'), { kind: 'denied' }],
    [refused(403, 'csrf_invalid'), { kind: 'denied' }], // any other chain 403
    [sealed(403, 'forbidden'), { kind: 'unknown', responded: true }],
    [new Response('Forbidden', { status: 403 }), { kind: 'unknown', responded: true }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refused(401, 'forbidden'), { kind: 'unknown', responded: true }],
    [sealed(401, 'unauthenticated'), { kind: 'unknown', responded: true }],
    [refused(429, 'rate_limited', { 'retry-after': '7' }), { kind: 'rate-limited', retryAfterSeconds: 7 }],
    [refused(429, 'rate_limited'), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refused(429, 'rate_limited', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), { kind: 'rate-limited', retryAfterSeconds: 60 }],
    [refused(429, 'forbidden', { 'retry-after': '7' }), { kind: 'unknown', responded: true }],
    [sealed(429, 'rate_limited'), { kind: 'unknown', responded: true }],
    [refused(400, 'invalid_request'), { kind: 'invalid' }],
    [refused(413, 'content_too_large'), { kind: 'invalid' }],
    [refused(415, 'unsupported_media_type'), { kind: 'invalid' }],
    [sealed(400, 'invalid_request'), { kind: 'unknown', responded: true }],
    [refused(413, 'invalid_request'), { kind: 'unknown', responded: true }],
    [sealed(413, 'content_too_large'), { kind: 'unknown', responded: true }],
    [refused(415, 'invalid_request'), { kind: 'unknown', responded: true }],
    [sealed(415, 'unsupported_media_type'), { kind: 'unknown', responded: true }],
    [refused(503, 'service_unavailable'), { kind: 'unknown', responded: true }],
    [sealed(503, 'service_unavailable'), { kind: 'unknown', responded: true }],
    [refused(500, 'internal_error'), { kind: 'unknown', responded: true }],
    [new Response(null, { status: 502 }), { kind: 'unknown', responded: true }],
    [new Response('{"error":', { status: 409, headers: { 'content-type': 'application/json' } }), { kind: 'unknown', responded: true }],
    [network(), { kind: 'unknown', responded: false }],
  ];
  for (const [reply, outcome] of table) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF), outcome, name);
    assert.equal(calls.length, 1, name); // one fetch: nothing re-sends on its own
  }
  // A timeout is no answer too (the outcome is unknown, never "cancelled"), and is not retried.
  let hung = 0;
  const hanging = createInvoiceIssuingClient({ timeoutMs: 5, fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    hung += 1;
    return new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
  }) as typeof globalThis.fetch });
  assert.deepEqual(await hanging.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF), { kind: 'unknown', responded: false });
  assert.equal(hung, 1);
});

test('IIC-31. the void eligibility: allowed ONLY for a 200 exactly { eligibility: "allowed" }; any chain 403 is denied whatever its word (it asks for no recent sign-in); 401 signed-out, 429 its wait; anything else unavailable; a store id outside its grammar or an invoice id outside the planner\'s target grammar sends nothing', async () => {
  const answers: Array<[Response | Error, unknown]> = [
    [json(200, { eligibility: 'allowed' }), { kind: 'allowed' }],
    [json(200, { eligibility: 'denied' }), { kind: 'unavailable' }], [json(200, { eligibility: 'allowed', invoice: INVOICE }), { kind: 'unavailable' }],
    [json(200, { eligibility: true }), { kind: 'unavailable' }], [json(200, {}), { kind: 'unavailable' }], [json(200, ['allowed']), { kind: 'unavailable' }],
    [new Response('{"eligibility":"allowed"}', { status: 200 }), { kind: 'unavailable' }], // no JSON content type
    [json(201, { eligibility: 'allowed' }), { kind: 'unavailable' }],
    [refused(403, 'forbidden'), { kind: 'denied' }], [refused(403, 'authz_context_missing'), { kind: 'denied' }], [refused(403, 'step_up_required'), { kind: 'denied' }],
    [sealed(403, 'forbidden'), { kind: 'unavailable' }], [new Response('Forbidden', { status: 403 }), { kind: 'unavailable' }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }], [refused(401, 'forbidden'), { kind: 'unavailable' }],
    [refused(429, 'rate_limited', { 'retry-after': '4' }), { kind: 'rate-limited', retryAfterSeconds: 4 }],
    [refused(404, 'not_found'), { kind: 'unavailable' }], [refused(400, 'invalid_request'), { kind: 'unavailable' }],
    [refused(503, 'service_unavailable'), { kind: 'unavailable' }], [network(), { kind: 'unavailable' }],
  ];
  for (const [reply, outcome] of answers) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.voidEligibility(STORE, INVOICE, CSRF), outcome, name);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].url, `${VOID_PATH}-eligibility`);
  }
  const { calls, client } = scripted();
  assert.deepEqual(await client.voidEligibility('x', INVOICE, CSRF), { kind: 'denied' });
  assert.deepEqual(await client.voidEligibility(STORE, INVOICE.toUpperCase(), CSRF), { kind: 'denied' });
  assert.deepEqual(await client.voidEligibility(STORE, `${INVOICE}?x=1`, CSRF), { kind: 'denied' });
  for (const id of NOT_VOID_TARGETS) assert.deepEqual(await client.voidEligibility(STORE, id, CSRF), { kind: 'denied' }, id);
  assert.equal(calls.length, 0);
});

test('IIC-32. M7B-PAYMENTS-P1: the void\'s sealed 409 exactly {"error":"payments_recorded"} (replayed too) is its own outcome, payments-recorded; the chain\'s envelope, an extra key, another status or a near word is never it — each ONE fetch, never retried', async () => {
  const table: Array<[Response | Error, unknown]> = [
    [sealed(409, 'payments_recorded'), { kind: 'payments-recorded' }],
    [json(409, { error: 'payments_recorded' }, { 'idempotent-replayed': 'true' }), { kind: 'payments-recorded' }], // its replay under the key
    [new Response('{"error":"payments_recorded"}', { status: 409, headers: { 'content-type': 'application/json' } }), { kind: 'payments-recorded' }], // the exact bytes
    [refused(409, 'payments_recorded'), { kind: 'unknown', responded: true }], // the chain never says it
    [json(409, { error: 'payments_recorded', more: 1 }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'payments_recorded', requestId: 7 }), { kind: 'unknown', responded: true }],
    [sealed(409, 'payment_recorded'), { kind: 'unknown', responded: true }],
    [sealed(409, 'PAYMENTS_RECORDED'), { kind: 'unknown', responded: true }],
    [sealed(409, 'already_recorded'), { kind: 'unknown', responded: true }], // the record's word, never the void's
    [sealed(409, 'amount_exceeds_remaining'), { kind: 'unknown', responded: true }],
    [sealed(422, 'payments_recorded'), { kind: 'unknown', responded: true }],
    [sealed(200, 'payments_recorded'), { kind: 'unknown', responded: true }],
    [new Response('{"error":"payments_recorded"}', { status: 409 }), { kind: 'unknown', responded: true }], // no JSON content type
  ];
  for (const [reply, outcome] of table) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.voidInvoice(STORE, INVOICE, KEY, VOID_BODY, CSRF), outcome, name);
    assert.equal(calls.length, 1, name); // one fetch: nothing re-sends on its own
  }
});

// M7B-PAYMENTS-P2A — the payments read (server/runtime/invoicePayments.ts, doc 15 §12.3): GET …/payments[?after=<id>], the
// exact 200 its serializer writes, the read's refusals. Read-only: nothing here records, reverses or proves a payment.
const PAYMENTS_PATH = `/api/v1/stores/${STORE}/invoices/${INVOICE}/payments`;
const at = (n: number): string => `2026-10-17T09:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000001Z`;
const payment = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(0x9000 + n), attemptId: uuid(0xa000 + n), amountCents: 100, method: 'cash', recordedAt: at(n), reversal: null as unknown, ...over,
});
const REVERSAL = { reversedAt: '2026-10-18T10:00:00.000001Z', reasonCode: 'duplicate' };
/** Issued, Total 2176, 300 recorded: 100 cash, 200 on a card terminal, and a reversed 500. */
const paymentsBody = (over: Record<string, unknown> = {}) => ({
  invoice: { id: INVOICE, status: 'issued' },
  amounts: { currency: 'USD', dueCents: 2176, appliedCents: 300, remainingCents: 1876 },
  paymentStatus: 'recorded_partly',
  payments: [payment(1), payment(2, { amountCents: 200, method: 'external_card_terminal' }), payment(3, { amountCents: 500, reversal: REVERSAL })],
  nextCursor: null,
  ...over,
});
const amountsOf = (dueCents: number, appliedCents: number) => ({ currency: 'USD', dueCents, appliedCents, remainingCents: dueCents - appliedCents });
/** A full page of 50 payments of 100 cents (ids 1..50), more after it: the cursor is the last id. */
const fullPage = (applied = 9000, from = 1) => paymentsBody({
  amounts: amountsOf(10_000, applied), payments: Array.from({ length: 50 }, (_, i) => payment(from + i)), nextCursor: uuid(0x9000 + from + 49),
});

test('IIC-33. the payments read: ONE GET of …/invoices/{id}/payments with the session token alone (same-origin, credentialed, uncached, never redirected, no referrer); `?after=<id>` only with a cursor; its 200 decoded exactly and frozen; the labels are doc 15\'s and the server\'s, in its order', async () => {
  assert.equal(paymentsPathOf(STORE, INVOICE), PAYMENTS_PATH);
  assert.equal(PAYMENTS_PAGE_SIZE, INVOICE_PAYMENTS_PAGE_SIZE);
  const { calls, client } = scripted(json(200, paymentsBody()), json(200, paymentsBody({ amounts: amountsOf(2176, 300), payments: [payment(4, { amountCents: 300 })] })));
  const first = await client.getPayments(STORE, INVOICE, null, CSRF);
  assert.deepEqual(first, { kind: 'ok', page: paymentsBody() });
  assert.ok(first.kind === 'ok' && Object.isFrozen(first) && Object.isFrozen(first.page) && Object.isFrozen(first.page.amounts) && Object.isFrozen(first.page.invoice)
    && Object.isFrozen(first.page.payments) && first.page.payments.every((p) => Object.isFrozen(p)) && Object.isFrozen(first.page.payments[2].reversal));
  const after = uuid(0x9003);
  assert.equal((await client.getPayments(STORE, INVOICE, after, CSRF)).kind, 'ok'); // a later page: its unreversed sum need only be within applied
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [`GET ${PAYMENTS_PATH}`, `GET ${PAYMENTS_PATH}?after=${after}`]);
  for (const call of calls) {
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.mode, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.equal(call.init.body, undefined);
    assert.deepEqual([...headersOf(call).entries()], [['accept', 'application/json'], ['x-tmpos-session-csrf', CSRF]]);
    assert.ok(!call.url.includes(CSRF));
  }
  assert.deepEqual(INVOICE_PAYMENT_STATUSES, {
    nothing_due: 'Nothing due', no_payment_recorded: 'No payment recorded', recorded_partly: 'Payment recorded in part', recorded_in_full: 'Payment recorded in full', voided: 'Voided',
  });
  assert.deepEqual(Object.keys(INVOICE_PAYMENT_STATUSES).sort(), [...SERVER_PAYMENT_STATUSES].sort());
  assert.deepEqual(Object.keys(INVOICE_PAYMENT_METHODS), [...SERVER_PAYMENT_METHODS]);
  assert.deepEqual(Object.entries(INVOICE_PAYMENT_METHODS), Object.entries(INVOICE_PAYMENT_METHOD_LABELS));
  assert.deepEqual(Object.keys(INVOICE_PAYMENT_REVERSAL_REASONS), [...INVOICE_PAYMENT_REVERSAL_REASON_CODES]);
  assert.deepEqual(Object.entries(INVOICE_PAYMENT_REVERSAL_REASONS), Object.entries(INVOICE_PAYMENT_REVERSAL_REASON_LABELS));
  for (const map of [INVOICE_PAYMENT_STATUSES, INVOICE_PAYMENT_METHODS, INVOICE_PAYMENT_REVERSAL_REASONS]) assert.ok(Object.isFrozen(map));
  // An aborted signal sends nothing.
  const aborted = new AbortController();
  aborted.abort();
  const none = scripted();
  assert.deepEqual(await none.client.getPayments(STORE, INVOICE, null, CSRF, aborted.signal), { kind: 'unavailable' });
  assert.equal(none.calls.length, 0);
});

test('IIC-34. a payments 200 counts ONLY exactly as the server writes it: every extra or missing key, another invoice, a wrong word for each of the five, -0, an unsafe or out-of-range integer, a bad method, reason or time, a reversal before its recording, the order, a duplicate, the cursor rules, the voided rules and the sum rule are each unavailable', async () => {
  const ok = (body: unknown, after: string | null = null) => [body, after, true] as const;
  const bad = (body: unknown, after: string | null = null) => [body, after, false] as const;
  const p1 = payment(1);
  const voided = (over: Record<string, unknown> = {}) => paymentsBody({ invoice: { id: INVOICE, status: 'voided' }, amounts: amountsOf(0, 0), paymentStatus: 'voided', payments: [payment(1, { reversal: REVERSAL })], ...over });
  const rows: Array<readonly [unknown, string | null, boolean]> = [
    // The five words, each where it applies, and each other word refused there.
    ok(paymentsBody({ amounts: amountsOf(0, 0), paymentStatus: 'nothing_due', payments: [] })),
    ok(paymentsBody({ amounts: amountsOf(2176, 0), paymentStatus: 'no_payment_recorded', payments: [payment(1, { reversal: REVERSAL })] })),
    ok(paymentsBody()), // recorded_partly
    ok(paymentsBody({ amounts: amountsOf(300, 300), paymentStatus: 'recorded_in_full' })),
    ok(voided()), ok(voided({ payments: [] })),
    ...['no_payment_recorded', 'recorded_partly', 'recorded_in_full', 'voided'].map((w) => bad(paymentsBody({ amounts: amountsOf(0, 0), paymentStatus: w, payments: [] }))),
    ...['nothing_due', 'recorded_partly', 'recorded_in_full', 'voided'].map((w) => bad(paymentsBody({ amounts: amountsOf(2176, 0), paymentStatus: w, payments: [] }))),
    ...['nothing_due', 'no_payment_recorded', 'recorded_in_full', 'voided'].map((w) => bad(paymentsBody({ paymentStatus: w }))),
    ...['nothing_due', 'no_payment_recorded', 'recorded_partly', 'voided'].map((w) => bad(paymentsBody({ amounts: amountsOf(300, 300), paymentStatus: w }))),
    ...['nothing_due', 'no_payment_recorded', 'recorded_partly', 'recorded_in_full', 'paid', 'unpaid', 'VOIDED', null].map((w) => bad(voided({ paymentStatus: w }))),
    // Keys and shapes.
    bad({ ...paymentsBody(), extra: 1 }), bad((({ nextCursor: _n, ...rest }) => rest)(paymentsBody())), bad([paymentsBody()]), bad(null),
    bad(paymentsBody({ invoice: { id: INVOICE, status: 'issued', number: 7 } })), bad(paymentsBody({ invoice: { id: INVOICE } })),
    bad(paymentsBody({ invoice: { id: OTHER_STORE, status: 'issued' } })), bad(paymentsBody({ invoice: { id: INVOICE.toUpperCase(), status: 'issued' } })),
    bad(paymentsBody({ invoice: { id: INVOICE, status: 'draft' } })),
    bad(paymentsBody({ amounts: { ...amountsOf(2176, 300), currency: 'EUR' } })), bad(paymentsBody({ amounts: { ...amountsOf(2176, 300), extra: 0 } })),
    bad(paymentsBody({ amounts: { currency: 'USD', dueCents: 2176, appliedCents: 300 } })),
    bad(paymentsBody({ amounts: { ...amountsOf(2176, 300), remainingCents: 1875 } })), // remaining is due − applied
    bad(paymentsBody({ amounts: { currency: 'USD', dueCents: 200, appliedCents: 300, remainingCents: -100 }, paymentStatus: 'recorded_in_full' })), // applied above due
    bad(paymentsBody({ amounts: { ...amountsOf(2176, 300), dueCents: 2176.5 } })), bad(paymentsBody({ amounts: { ...amountsOf(2176, 300), dueCents: '2176' } })),
    bad(paymentsBody({ amounts: amountsOf(MAX + 1, 300) })), ok(paymentsBody({ amounts: amountsOf(MAX, 300) })),
    bad(voided({ amounts: amountsOf(2176, 0) })), bad(voided({ amounts: amountsOf(100, 100) })), // voided: due, applied and remaining 0
    bad(voided({ payments: [payment(1)] })), // a voided invoice holds no unreversed payment
    // Each payment exactly.
    bad(paymentsBody({ payments: [{ ...p1, extra: 1 }], amounts: amountsOf(2176, 100) })), bad(paymentsBody({ payments: [(({ attemptId: _a, ...rest }) => rest)(p1)], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { id: 'x' })], amounts: amountsOf(2176, 100) })), bad(paymentsBody({ payments: [payment(1, { attemptId: INVOICE.toUpperCase() })], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { amountCents: 0 })], amounts: amountsOf(2176, 0), paymentStatus: 'no_payment_recorded' })),
    bad(paymentsBody({ payments: [payment(1, { amountCents: MAX + 1 })], amounts: amountsOf(MAX, MAX), paymentStatus: 'recorded_in_full' })),
    ok(paymentsBody({ payments: [payment(1, { amountCents: MAX })], amounts: amountsOf(MAX, MAX), paymentStatus: 'recorded_in_full' })),
    bad(paymentsBody({ payments: [payment(1, { amountCents: 1.5 })], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { method: 'card' })], amounts: amountsOf(2176, 100) })), bad(paymentsBody({ payments: [payment(1, { method: 'Cash' })], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { method: 'toString' })], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { recordedAt: '2026-10-17T09:00:01.000001+00:00' })], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { recordedAt: '2026-10-17T09:00:01.000Z' })], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { recordedAt: '2026-02-30T09:00:01.000001Z' })], amounts: amountsOf(2176, 100) })),
    bad(paymentsBody({ payments: [payment(1, { reversal: { ...REVERSAL, reasonCode: 'mistake' } })], amounts: amountsOf(2176, 0), paymentStatus: 'no_payment_recorded' })),
    bad(paymentsBody({ payments: [payment(1, { reversal: { ...REVERSAL, extra: 1 } })], amounts: amountsOf(2176, 0), paymentStatus: 'no_payment_recorded' })),
    bad(paymentsBody({ payments: [payment(1, { reversal: { reasonCode: 'duplicate' } })], amounts: amountsOf(2176, 0), paymentStatus: 'no_payment_recorded' })),
    bad(paymentsBody({ payments: [payment(1, { reversal: { ...REVERSAL, reversedAt: '2026-10-17T09:00:00.999999Z' } })], amounts: amountsOf(2176, 0), paymentStatus: 'no_payment_recorded' })), // before its recording
    ok(paymentsBody({ payments: [payment(1, { reversal: { ...REVERSAL, reversedAt: at(1) } })], amounts: amountsOf(2176, 0), paymentStatus: 'no_payment_recorded' })), // at it
    bad(paymentsBody({ payments: [payment(1, { reversal: false })], amounts: amountsOf(2176, 100) })),
    // Order, uniqueness, the cursor.
    bad(paymentsBody({ payments: [payment(2), payment(1)], amounts: amountsOf(2176, 200) })),
    bad(paymentsBody({ payments: [payment(1), payment(1)], amounts: amountsOf(2176, 200) })),
    bad(paymentsBody({ payments: [payment(1), payment(2, { id: uuid(0x9001) })], amounts: amountsOf(2176, 200) })),
    ok(paymentsBody({ payments: [payment(2, { recordedAt: at(1) }), payment(3, { recordedAt: at(1) })], amounts: amountsOf(2176, 200) })), // same time: by id
    bad(paymentsBody({ payments: [payment(3, { recordedAt: at(1) }), payment(2, { recordedAt: at(1) })], amounts: amountsOf(2176, 200) })),
    bad(paymentsBody({ payments: [payment(1)], amounts: amountsOf(2176, 100) }), uuid(0x9001)), // never the cursor's own payment
    ok(paymentsBody({ payments: [payment(2)], amounts: amountsOf(2176, 300) }), uuid(0x9001)), // a later page: within applied
    bad(paymentsBody({ payments: [payment(2, { amountCents: 400 })], amounts: amountsOf(2176, 300) }), uuid(0x9001)), // above it
    ok(fullPage()), bad({ ...fullPage(), nextCursor: uuid(0x9001) }), bad({ ...fullPage(), nextCursor: 'B'.repeat(22) }),
    bad(paymentsBody({ nextCursor: uuid(0x9003) })), // a cursor behind a page that is not full
    bad(fullPage(4000)), // the page's unreversed sum (5000) above applied
    ok(paymentsBody({ ...fullPage(5000), nextCursor: null })), bad(paymentsBody({ ...fullPage(6000), nextCursor: null })), // the whole history: equal
    bad(paymentsBody({ amounts: amountsOf(10_000, 5100), payments: Array.from({ length: 51 }, (_, i) => payment(i + 1)), nextCursor: null })), // above 50
  ];
  for (const [body, after, accepted] of rows) {
    const name = JSON.stringify(body).slice(0, 400);
    const { calls, client } = scripted(json(200, body));
    const got = await client.getPayments(STORE, INVOICE, after, CSRF);
    assert.equal(got.kind, accepted ? 'ok' : 'unavailable', name);
    if (accepted) assert.deepEqual(got, { kind: 'ok', page: body }, name);
    assert.equal(calls.length, 1, name);
  }
  // -0 anywhere is not a count (JSON.stringify never writes it).
  for (const [from, to] of [['"dueCents":0', '"dueCents":-0'], ['"appliedCents":0', '"appliedCents":-0'], ['"remainingCents":0', '"remainingCents":-0']]) {
    const { client } = scripted(raw(200, paymentsBody({ amounts: amountsOf(0, 0), paymentStatus: 'nothing_due', payments: [] }), from, to));
    assert.deepEqual(await client.getPayments(STORE, INVOICE, null, CSRF), { kind: 'unavailable' }, to);
  }
});

test('IIC-35. a payments refusal counts only by status AND word AND envelope: 404 not_found is not-found, 401 signed-out, 403 denied, 429 its wait; a 400 (an unknown cursor) and everything else unavailable — each ONE fetch; a store, invoice or cursor id outside its grammar sends nothing', async () => {
  const table: Array<[Response | Error, unknown]> = [
    [refused(404, 'not_found'), { kind: 'not-found' }], [sealed(404, 'not_found'), { kind: 'unavailable' }], [refused(404, 'forbidden'), { kind: 'unavailable' }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }], [refused(401, 'forbidden'), { kind: 'unavailable' }],
    [refused(403, 'forbidden'), { kind: 'denied' }], [sealed(403, 'forbidden'), { kind: 'unavailable' }], [refused(403, 'step_up_required'), { kind: 'unavailable' }],
    [refused(429, 'rate_limited', { 'retry-after': '7' }), { kind: 'rate-limited', retryAfterSeconds: 7 }],
    [refused(400, 'invalid_request'), { kind: 'unavailable' }], [refused(503, 'service_unavailable'), { kind: 'unavailable' }],
    [json(201, paymentsBody()), { kind: 'unavailable' }], [new Response(JSON.stringify(paymentsBody()), { status: 200 }), { kind: 'unavailable' }], // no JSON content type
    [network(), { kind: 'unavailable' }],
  ];
  for (const [reply, outcome] of table) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.getPayments(STORE, INVOICE, uuid(0x9001), CSRF), outcome, name);
    assert.equal(calls.length, 1, name);
  }
  const { calls, client } = scripted();
  for (const [store, invoice, after] of [
    ['x', INVOICE, null], [STORE.toUpperCase(), INVOICE, null], [STORE, `${INVOICE}?x=1`, null], [STORE, INVOICE.toUpperCase(), null], [STORE, '', null],
    [STORE, INVOICE, ''], [STORE, INVOICE, 'B'.repeat(22)], [STORE, INVOICE, `${uuid(0x9001)}&x=1`], [STORE, INVOICE, uuid(0x90ab).toUpperCase()],
  ] as Array<[string, string, string | null]>) {
    assert.deepEqual(await client.getPayments(store, invoice, after, CSRF), { kind: 'unavailable' }, `${store} ${invoice} ${after}`);
  }
  assert.equal(calls.length, 0);
});

// ---- M7B-PAYMENTS-P2B: recording a payment — register, proof, record, settle, the attempts lookup and the eligibility ----
const REG = uuid(0x4e1);
const ATTEMPT = uuid(0xa7e);
const PROOF = ['0123456789abcdef'.repeat(2), 'fedcba9876543210'.repeat(2)].join('');
const BASE = `/api/v1/stores/${STORE}/invoices/${INVOICE}`;
const REGISTER_BODY = `{"expectedTenant":"${TENANT}","attemptId":"${ATTEMPT}"}`;
const RECORD_FIELDS: RecordFields = Object.freeze({ expectedTenant: TENANT, registrationId: REG, attemptId: ATTEMPT, amountCents: 1250, method: 'cash', registrationProof: PROOF });
const RECORD_BODY = `{"expectedTenant":"${TENANT}","registrationId":"${REG}","attemptId":"${ATTEMPT}","amountCents":1250,"method":"cash","registrationProof":"${PROOF}"}`;
const SETTLE_BODY = (v: 1 | 2) => `{"expectedTenant":"${TENANT}","attemptId":"${ATTEMPT}","expectedVersion":${v}}`;
const registered = (over: Record<string, unknown> = {}) => ({ registration: { id: REG, invoiceId: INVOICE, attemptId: ATTEMPT, state: 'open', ...over } });
const proofBody = (over: Record<string, unknown> = {}, proof: unknown = PROOF) => ({ registration: { id: REG, invoiceId: INVOICE, attemptId: ATTEMPT, ...over }, proof });
const recorded = (over: Record<string, unknown> = {}) => ({ payment: { id: uuid(0x9e1), invoiceId: INVOICE, attemptId: ATTEMPT, amountCents: 1250, method: 'cash', ...over } });
const settled = (state: string, over: Record<string, unknown> = {}) => ({ settlement: { invoiceId: INVOICE, attemptId: ATTEMPT, state, ...over } });
const attempt = (n: number, over: Record<string, unknown> = {}) => ({
  invoiceId: INVOICE, invoiceNumber: 7, attemptId: uuid(0xa000 + n), state: 'open', version: 1, registeredAt: at(n), settledAt: null, payment: null as unknown, ...over,
});
const attemptPayment = (over: Record<string, unknown> = {}) => ({ id: uuid(0x9e1), amountCents: 1250, method: 'cash', recordedAt: at(59), reversal: null, ...over });

test('IIC-36. the recording paths and the server\'s constants: payment-eligibility, payment-registrations, payment-registration-proof, payments (the record), payment-settlement under the invoice, payment-attempts under the store; the attempts page 50 and the four states with their versions', () => {
  assert.equal(paymentEligibilityPathOf(STORE, INVOICE), `${BASE}/payment-eligibility`);
  assert.equal(paymentRegistrationsPathOf(STORE, INVOICE), `${BASE}/payment-registrations`);
  assert.equal(paymentProofPathOf(STORE, INVOICE), `${BASE}/payment-registration-proof`);
  assert.equal(paymentsPathOf(STORE, INVOICE), `${BASE}/payments`);
  assert.equal(paymentSettlementPathOf(STORE, INVOICE), `${BASE}/payment-settlement`);
  assert.equal(paymentAttemptsPathOf(STORE), `/api/v1/stores/${STORE}/payment-attempts`);
  assert.equal(PAYMENT_ATTEMPTS_PAGE_SIZE, INVOICE_PAYMENT_ATTEMPTS_PAGE_SIZE);
  assert.deepEqual(Object.keys(PAYMENT_ATTEMPT_VERSIONS), [...INVOICE_PAYMENT_ATTEMPT_STATES]);
  assert.deepEqual(Object.values(PAYMENT_ATTEMPT_VERSIONS), [1, 2, 3, 3]);
});

test('IIC-37. each recording request is ONE fetch: the three commands POST with exactly the five command headers and the caller\'s exact bytes, the proof and the attempts GET with the session token alone; same-origin, credentialed, uncached, never redirected; the commands and the proof take no AbortSignal', async () => {
  const no = () => refused(503, 'service_unavailable');
  const { calls, client } = scripted(no(), no(), no(), no(), no(), no(), no());
  await client.paymentEligibility(STORE, INVOICE, CSRF);
  await client.registerPayment(STORE, INVOICE, KEY, REGISTER_BODY, CSRF);
  await client.paymentProof(STORE, INVOICE, REG, ATTEMPT, CSRF);
  await client.recordPayment(STORE, INVOICE, KEY, RECORD_BODY, CSRF);
  await client.settlePayment(STORE, INVOICE, KEY, SETTLE_BODY(2), CSRF);
  await client.paymentAttempts(STORE, null, CSRF);
  await client.paymentAttempts(STORE, `${INVOICE}.${ATTEMPT}`, CSRF);
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [
    `GET ${BASE}/payment-eligibility`, `POST ${BASE}/payment-registrations`, `GET ${BASE}/payment-registration-proof?registration=${REG}`, `POST ${BASE}/payments`,
    `POST ${BASE}/payment-settlement`, `GET /api/v1/stores/${STORE}/payment-attempts`, `GET /api/v1/stores/${STORE}/payment-attempts?after=${INVOICE}.${ATTEMPT}`,
  ]);
  const READ = [['accept', 'application/json'], ['x-tmpos-session-csrf', CSRF]];
  const COMMAND = [['accept', 'application/json'], ['content-type', 'application/json'], ['idempotency-key', KEY], ['x-tmpos-csrf', '1'], ['x-tmpos-session-csrf', CSRF]];
  calls.forEach((call, i) => {
    assert.equal(call.init.credentials, 'include');
    assert.equal(call.init.mode, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.ok(call.init.signal instanceof AbortSignal);
    // R2 U1: the key and the token are compared, never printed.
    assert.ok(JSON.stringify([...headersOf(call).entries()]) === JSON.stringify(call.init.method === 'POST' ? COMMAND : READ), `headers of request ${i}`);
  });
  assert.ok(calls[1].init.body === REGISTER_BODY && calls[3].init.body === RECORD_BODY && calls[4].init.body === SETTLE_BODY(2), 'the caller\'s exact bytes');
  assert.equal(calls[2].init.body, undefined);
  assert.deepEqual([client.registerPayment.length, client.recordPayment.length, client.settlePayment.length, client.paymentProof.length], [5, 5, 5, 5]);
});

test('IIC-38. the bodies are built ONCE in their fixed key order — register {expectedTenant, attemptId}; record {expectedTenant, registrationId, attemptId, amountCents, method, registrationProof}; settle {expectedTenant, attemptId, expectedVersion 1|2} — and a body not byte for byte its builder\'s, or a bad id, sends NOTHING (not-sent)', async () => {
  assert.ok(registerBodyOf(TENANT, ATTEMPT) === REGISTER_BODY, 'the builder\'s answer');
  assert.ok(recordBodyOf(RECORD_FIELDS) === RECORD_BODY, 'the record bytes in the fixed order');
  assert.ok(settleBodyOf(TENANT, ATTEMPT, 1) === SETTLE_BODY(1), 'the builder\'s answer');
  assert.ok(settleBodyOf(TENANT, ATTEMPT, 2) === SETTLE_BODY(2), 'the builder\'s answer');
  for (const bad of [TENANT.toUpperCase(), 'x', '']) assert.ok(registerBodyOf(bad, ATTEMPT) === null, bad);
  assert.ok(registerBodyOf(TENANT, ATTEMPT.toUpperCase()) === null, 'the builder\'s answer');
  for (const over of [
    { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: MAX + 1 }, { amountCents: '1250' }, { method: 'card' }, { method: 'toString' },
    { registrationProof: PROOF.slice(1) }, { registrationProof: PROOF.toUpperCase() }, { registrationProof: `${PROOF}0` }, { registrationId: 'x' }, { attemptId: REG.toUpperCase() },
  ]) assert.ok(recordBodyOf({ ...RECORD_FIELDS, ...over } as RecordFields) === null, JSON.stringify(Object.keys(over)));
  assert.ok(recordBodyOf({ ...RECORD_FIELDS, amountCents: MAX }) === RECORD_BODY.replace('1250', String(MAX)), 'the largest amount');
  for (const v of [0, 3, '1']) assert.ok(settleBodyOf(TENANT, ATTEMPT, v as 1) === null, String(v));
  const { calls, client } = scripted();
  const notSent = { kind: 'not-sent' };
  for (const [i, body] of [`${REGISTER_BODY} `, `{"attemptId":"${ATTEMPT}","expectedTenant":"${TENANT}"}`, REGISTER_BODY.replace('}', ',"x":1}'), REGISTER_BODY.replace(TENANT, TENANT.toUpperCase()), ''].entries()) {
    assert.deepEqual(await client.registerPayment(STORE, INVOICE, KEY, body, CSRF), notSent, `register body row ${i}`);
  }
  for (const body of [RECORD_BODY.replace('"amountCents":1250', '"amountCents":1250.0'), RECORD_BODY.replace(PROOF, PROOF.toUpperCase()), RECORD_BODY.replace('cash', 'other'), ` ${RECORD_BODY}`]) {
    assert.deepEqual(await client.recordPayment(STORE, INVOICE, KEY, body, CSRF), notSent);
  }
  for (const body of [SETTLE_BODY(1).replace(':1}', ':3}'), SETTLE_BODY(2).replace(':2}', ':"2"}'), `{"attemptId":"${ATTEMPT}","expectedTenant":"${TENANT}","expectedVersion":1}`]) {
    assert.deepEqual(await client.settlePayment(STORE, INVOICE, KEY, body, CSRF), notSent, 'a settle body not the builder\'s');
  }
  for (const [store, invoice] of [['x', INVOICE], [STORE.toUpperCase(), INVOICE], [STORE, 'x'], [STORE, `${INVOICE}/x`]]) {
    assert.deepEqual(await client.registerPayment(store, invoice, KEY, REGISTER_BODY, CSRF), notSent);
    assert.deepEqual(await client.recordPayment(store, invoice, KEY, RECORD_BODY, CSRF), notSent);
    assert.deepEqual(await client.settlePayment(store, invoice, KEY, SETTLE_BODY(1), CSRF), notSent);
    assert.deepEqual(await client.paymentProof(store, invoice, REG, ATTEMPT, CSRF), notSent);
    assert.deepEqual(await client.paymentEligibility(store, invoice, CSRF), { kind: 'denied' });
  }
  assert.deepEqual(await client.paymentProof(STORE, INVOICE, `${REG}&x=1`, ATTEMPT, CSRF), notSent);
  for (const after of ['', 'x', INVOICE, `${INVOICE}.${ATTEMPT}.x`, `${INVOICE}.${ATTEMPT.toUpperCase()}`, `${INVOICE}.${ATTEMPT}&x=1`]) {
    assert.deepEqual(await client.paymentAttempts(STORE, after, CSRF), { kind: 'unavailable' }, after);
  }
  assert.equal(calls.length, 0);
});

test('IIC-39. a success counts ONLY exactly: register 201 naming the invoice, the attempt sent and state open; proof 200 naming the registration and invoice with a 64 lowercase-hex proof; record 201 echoing the attempt, amount and method sent; settle 200 withdrawn for version 1 and confirmed for 2 — the replay header absent or "true"; anything else is unknown (responded)', async () => {
  const one = async <T>(reply: Response, call: (c: ReturnType<typeof scripted>['client']) => Promise<T>): Promise<T> => call(scripted(reply).client);
  const reg = (r: Response) => one(r, (c) => c.registerPayment(STORE, INVOICE, KEY, REGISTER_BODY, CSRF));
  const prf = (r: Response) => one(r, (c) => c.paymentProof(STORE, INVOICE, REG, ATTEMPT, CSRF));
  const rec = (r: Response) => one(r, (c) => c.recordPayment(STORE, INVOICE, KEY, RECORD_BODY, CSRF));
  const stl = (v: 1 | 2, r: Response) => one(r, (c) => c.settlePayment(STORE, INVOICE, KEY, SETTLE_BODY(v), CSRF));
  const ANSWERED = { kind: 'unknown', responded: true };
  assert.deepEqual(await reg(json(201, registered())), { kind: 'registered', registrationId: REG, replayed: false });
  assert.deepEqual(await reg(json(201, registered(), { 'idempotent-replayed': 'true' })), { kind: 'registered', registrationId: REG, replayed: true });
  for (const r of [json(201, registered(), { 'idempotent-replayed': 'false' }), json(200, registered()), json(201, registered({ state: 'recorded' })), json(201, registered({ invoiceId: uuid(9) })),
    json(201, registered({ attemptId: uuid(9) })), json(201, registered({ id: 'x' })), json(201, registered({ proof: PROOF })), json(201, { ...registered(), x: 1 })]) assert.deepEqual(await reg(r), ANSWERED);
  const got = await prf(json(200, proofBody()));
  assert.ok(got.kind === 'proof' && got.proof === PROOF, 'the proof accepted'); // R2 U1: never printed
  for (const r of [json(200, proofBody({ id: uuid(9) })), json(200, proofBody({ invoiceId: uuid(9) })), json(200, proofBody({}, PROOF.toUpperCase())), json(200, proofBody({}, PROOF.slice(2))),
    json(200, proofBody({ state: 'open' })), json(200, { ...proofBody(), x: 1 }), json(201, proofBody())]) assert.deepEqual(await prf(r), ANSWERED);
  assert.deepEqual(await rec(json(201, recorded())), { kind: 'recorded', payment: { id: uuid(0x9e1), amountCents: 1250, method: 'cash' }, replayed: false });
  assert.deepEqual((await rec(json(201, recorded(), { 'idempotent-replayed': 'true' }))).kind, 'recorded');
  for (const r of [json(201, recorded({ amountCents: 1251 })), json(201, recorded({ method: 'external_card_terminal' })), json(201, recorded({ attemptId: uuid(9) })), json(201, recorded({ invoiceId: uuid(9) })),
    json(201, recorded({ registrationProof: PROOF })), json(200, recorded()), json(201, recorded(), { 'idempotent-replayed': 'yes' })]) assert.deepEqual(await rec(r), ANSWERED);
  assert.deepEqual(await stl(1, json(200, settled('withdrawn'))), { kind: 'settled', state: 'withdrawn', replayed: false });
  assert.deepEqual(await stl(2, json(200, settled('confirmed'), { 'idempotent-replayed': 'true' })), { kind: 'settled', state: 'confirmed', replayed: true });
  for (const [v, r] of [[1, json(200, settled('confirmed'))], [2, json(200, settled('withdrawn'))], [2, json(200, settled('confirmed', { attemptId: uuid(9) }))], [2, json(201, settled('confirmed'))],
    [2, json(200, settled('confirmed', { version: 3 }))]] as Array<[1 | 2, Response]>) assert.deepEqual(await stl(v, r), ANSWERED);
});

test('IIC-40. every other recording answer is ONE outcome by status AND word AND envelope — sealed words only exactly {error} (register already_recorded/write_conflict/invalid_state, record already_recorded/invalid_state/amount_exceeds_remaining/write_conflict, settle write_conflict), the chain\'s write_conflict tenant-conflict, request_in_progress, 422, 404, any chain 403, 401, 400/413/415 and the 429 with its Retry-After; a 503, an unnamed word or no answer unknown; ONE fetch each, never a retry; no proof in any outcome but the proof\'s', async () => {
  const common = (): Array<[Response | Error, unknown]> => [
    [refused(409, 'write_conflict'), { kind: 'tenant-conflict' }], [refused(409, 'request_in_progress'), { kind: 'in-progress' }], [sealed(409, 'request_in_progress'), { kind: 'unknown', responded: true }],
    [refused(422, 'idempotency_key_reused'), { kind: 'key-reused' }], [refused(404, 'not_found'), { kind: 'not-found' }], [sealed(404, 'not_found'), { kind: 'unknown', responded: true }],
    [refused(403, 'forbidden'), { kind: 'denied' }], [refused(403, 'csrf_failed'), { kind: 'denied' }], [refused(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refused(400, 'invalid_request'), { kind: 'invalid' }], [refused(413, 'content_too_large'), { kind: 'invalid' }], [refused(415, 'unsupported_media_type'), { kind: 'invalid' }],
    [refused(429, 'rate_limited', { 'retry-after': '9' }), { kind: 'rate-limited', retryAfterSeconds: 9 }], [refused(503, 'service_unavailable'), { kind: 'unknown', responded: true }],
    [refused(409, 'payments_recorded'), { kind: 'unknown', responded: true }], [json(409, { error: 'already_recorded', x: 'y' }), { kind: 'unknown', responded: true }],
    [network(), { kind: 'unknown', responded: false }],
  ];
  const sealedOf: Record<'register' | 'record' | 'settle', Array<[string, string]>> = {
    register: [['already_recorded', 'already-recorded'], ['write_conflict', 'write-conflict'], ['invalid_state', 'invalid-state'], ['amount_exceeds_remaining', '']],
    record: [['already_recorded', 'already-recorded'], ['invalid_state', 'invalid-state'], ['amount_exceeds_remaining', 'amount-exceeds'], ['write_conflict', 'write-conflict']],
    settle: [['write_conflict', 'write-conflict'], ['invalid_state', ''], ['already_recorded', '']],
  };
  const run = { register: (c: ReturnType<typeof scripted>['client']) => c.registerPayment(STORE, INVOICE, KEY, REGISTER_BODY, CSRF),
    record: (c: ReturnType<typeof scripted>['client']) => c.recordPayment(STORE, INVOICE, KEY, RECORD_BODY, CSRF),
    settle: (c: ReturnType<typeof scripted>['client']) => c.settlePayment(STORE, INVOICE, KEY, SETTLE_BODY(1), CSRF) };
  for (const command of ['register', 'record', 'settle'] as const) {
    // The record's 404 is `unmatched` (037 checks the whole scope before already_recorded: it may follow a committed payment).
    // R2 R3: ANY record 404 is `unmatched` (whatever its body); ANY 422 is `key-reused` for every command.
    const fixed = (rows: Array<[Response | Error, unknown]>) => rows.map(([r, o]): [Response | Error, unknown] =>
      [r, r instanceof Response && r.status === 404 && command === 'record' ? { kind: 'unmatched' } : r instanceof Response && r.status === 422 ? { kind: 'key-reused' } : o]);
    const rows: Array<[Response | Error, unknown]> = [...fixed(common()), ...sealedOf[command].map(([word, kind]): [Response, unknown] => [sealed(409, word), kind === '' ? { kind: 'unknown', responded: true } : { kind }])];
    for (const [reply, outcome] of rows) {
      const name = `${command} ${await rowName(reply)}`;
      const { calls, client } = scripted(reply);
      const got = await run[command](client);
      assert.deepEqual(got, outcome, name);
      assert.equal(calls.length, 1, name);
      assert.ok(!JSON.stringify(got).includes(PROOF), name);
    }
  }
  const proofRows: Array<[Response | Error, unknown]> = [
    [refused(404, 'not_found'), { kind: 'not-found' }], [refused(403, 'forbidden'), { kind: 'denied' }], [refused(401, 'unauthenticated'), { kind: 'signed-out' }],
    [refused(400, 'invalid_request'), { kind: 'invalid' }], [refused(429, 'rate_limited', { 'retry-after': '3' }), { kind: 'rate-limited', retryAfterSeconds: 3 }],
    [refused(503, 'service_unavailable'), { kind: 'unknown', responded: true }], [sealed(404, 'not_found'), { kind: 'unknown', responded: true }], [network(), { kind: 'unknown', responded: false }],
  ];
  for (const [reply, outcome] of proofRows) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.paymentProof(STORE, INVOICE, REG, ATTEMPT, CSRF), outcome, name);
    assert.equal(calls.length, 1);
  }
});

test('IIC-41. the payment eligibility: allowed ONLY for a 200 exactly { eligibility: "allowed" }; any chain 403 denied; 401 signed-out, 429 its wait, everything else unavailable; one GET', async () => {
  const table: Array<[Response | Error, unknown]> = [
    [json(200, { eligibility: 'allowed' }), { kind: 'allowed' }], [json(200, { eligibility: 'allowed', x: 1 }), { kind: 'unavailable' }], [json(200, { eligibility: 'denied' }), { kind: 'unavailable' }],
    [refused(403, 'forbidden'), { kind: 'denied' }], [refused(403, 'step_up_required'), { kind: 'denied' }], [sealed(403, 'forbidden'), { kind: 'unavailable' }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }], [refused(429, 'rate_limited', { 'retry-after': '4' }), { kind: 'rate-limited', retryAfterSeconds: 4 }],
    [refused(503, 'service_unavailable'), { kind: 'unavailable' }], [network(), { kind: 'unavailable' }],
  ];
  for (const [reply, outcome] of table) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.paymentEligibility(STORE, INVOICE, CSRF), outcome, name);
    assert.equal(calls.length, 1);
  }
});

test('IIC-42. the attempts page counts ONLY exactly as the server writes it: state and version agree (open 1, recorded 2, withdrawn/confirmed 3), a settlement time iff settled and not before the registration, a payment iff recorded or confirmed (exact keys, no attemptId), ordered by (registeredAt, invoiceId, attemptId), ≤ 50, the cursor only behind a full page naming its last row; refusals by status and word, a 400 unavailable', async () => {
  const page = (attempts: unknown[], nextCursor: string | null = null) => json(200, { attempts, nextCursor });
  const read = async (reply: Response | Error, after: string | null = null) => scripted(reply).client.paymentAttempts(STORE, after, CSRF);
  const rows = [attempt(1), attempt(2, { state: 'recorded', version: 2, payment: attemptPayment() }), attempt(3, { state: 'withdrawn', version: 3, settledAt: at(4) }),
    attempt(5, { state: 'confirmed', version: 3, settledAt: at(60), payment: attemptPayment({ reversal: { reversedAt: at(61), reasonCode: 'duplicate' } }) })];
  const ok = await read(page(rows));
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') {
    assert.deepEqual(ok.attempts.map((a) => [a.state, a.version, a.payment?.amountCents ?? null]), [['open', 1, null], ['recorded', 2, 1250], ['withdrawn', 3, null], ['confirmed', 3, 1250]]);
    assert.equal(ok.nextCursor, null);
  }
  const full = Array.from({ length: 50 }, (_, i) => attempt(i + 1));
  const last = `${INVOICE}.${uuid(0xa000 + 50)}`;
  assert.deepEqual((await read(page(full, last))).kind, 'ok');
  for (const [name, reply] of [
    ['version', page([attempt(1, { version: 2 })])], ['recorded without payment', page([attempt(1, { state: 'recorded', version: 2 })])], ['open with payment', page([attempt(1, { payment: attemptPayment() })])],
    ['settled without time', page([attempt(1, { state: 'withdrawn', version: 3 })])], ['open with time', page([attempt(1, { settledAt: at(2) })])], ['settled before', page([attempt(5, { state: 'withdrawn', version: 3, settledAt: at(1) })])],
    ['state', page([attempt(1, { state: 'reversed' })])], ['extra key', page([attempt(1, { registrationId: REG })])], ['payment attemptId', page([attempt(1, { state: 'recorded', version: 2, payment: { ...attemptPayment(), attemptId: ATTEMPT } })])],
    ['order', page([attempt(2), attempt(1)])], ['twice', page([attempt(1), attempt(1)])], ['51', page([...full, attempt(51)])], ['cursor short page', page([attempt(1)], `${INVOICE}.${uuid(0xa001)}`)],
    ['cursor other row', page(full, `${INVOICE}.${uuid(0xa001)}`)], ['extra', json(200, { attempts: [], nextCursor: null, x: 1 })], ['number', page([attempt(1, { invoiceNumber: 0 })])],
  ] as Array<[string, Response]>) assert.deepEqual(await read(reply), { kind: 'unavailable' }, name);
  assert.deepEqual(await read(page([attempt(1)]), `${INVOICE}.${uuid(0xa001)}`), { kind: 'unavailable' }); // the cursor's own row again
  for (const [reply, outcome] of [
    [refused(403, 'forbidden'), { kind: 'denied' }], [refused(401, 'unauthenticated'), { kind: 'signed-out' }], [refused(429, 'rate_limited', { 'retry-after': '5' }), { kind: 'rate-limited', retryAfterSeconds: 5 }],
    [refused(400, 'invalid_request'), { kind: 'unavailable' }], [refused(503, 'service_unavailable'), { kind: 'unavailable' }], [network(), { kind: 'unavailable' }],
  ] as Array<[Response | Error, unknown]>) { const name = await rowName(reply); assert.deepEqual(await read(reply), outcome, name); }
});

test('IIC-43. the amount typed (G8): trimmed dollars, 1-13 digits and at most two decimals, converted exactly by its digits (never a float) to 1..remaining cents; three decimals, zero, over the remaining and anything else each say which', () => {
  const table: Array<[string, number, unknown]> = [
    ['12.50', 5000, { kind: 'ok', cents: 1250 }], [' 12.5 ', 5000, { kind: 'ok', cents: 1250 }], ['0.01', 1, { kind: 'ok', cents: 1 }], ['50', 5000, { kind: 'ok', cents: 5000 }],
    ['0.29', 100, { kind: 'ok', cents: 29 }], ['1.10', 200, { kind: 'ok', cents: 110 }], ['9999999999999.99', MAX, { kind: 'ok', cents: 999999999999999 }],
    ['50.01', 5000, { kind: 'over' }], ['0', 5000, { kind: 'zero' }], ['0.00', 5000, { kind: 'zero' }], ['1.234', 5000, { kind: 'decimals' }], ['1.2345', 5000, { kind: 'decimals' }],
    ['', 5000, { kind: 'format' }], ['-1', 5000, { kind: 'format' }], ['1e2', 5000, { kind: 'format' }], ['$1', 5000, { kind: 'format' }], ['1,000', 5000, { kind: 'format' }],
    ['.5', 5000, { kind: 'format' }], ['5.', 5000, { kind: 'format' }], ['12345678901234', MAX, { kind: 'format' }], [`1${cp(0x0661)}`, 5000, { kind: 'format' }],
    ['1', MAX + 1, { kind: 'over' }], ['1', 1.5, { kind: 'over' }], ['1', -1, { kind: 'over' }], ['1', Number.NaN, { kind: 'over' }],
  ];
  for (const [raw, remaining, outcome] of table) assert.deepEqual(paymentAmountOf(raw, remaining), outcome, raw);
});

test('IIC-44. R1: a recording command sends NOTHING (not-sent) under an Idempotency-Key that is not a canonical lowercase UUID v4; the proof counts only when its answer names the attempt asked; replays say replayed; a 429\'s Retry-After missing, unreadable or in the date form waits the default 60 seconds', async () => {
  const { calls, client } = scripted();
  for (const [i, key] of [KEY.toUpperCase(), KEY.replace('-4a6b-', '-1a6b-'), KEY.replace('-9c8d-', '-7c8d-'), `${KEY} `, KEY.replace(/-/g, ''), '', 'x'].entries()) {
    assert.equal((await client.registerPayment(STORE, INVOICE, key, REGISTER_BODY, CSRF)).kind, 'not-sent', `key row ${i}`);
    assert.equal((await client.recordPayment(STORE, INVOICE, key, RECORD_BODY, CSRF)).kind, 'not-sent', `key row ${i}`);
    assert.equal((await client.settlePayment(STORE, INVOICE, key, SETTLE_BODY(1), CSRF)).kind, 'not-sent', `key row ${i}`);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.paymentProof(STORE, INVOICE, REG, 'x', CSRF), { kind: 'not-sent' });
  assert.deepEqual(await scripted(json(200, proofBody({ attemptId: uuid(9) }))).client.paymentProof(STORE, INVOICE, REG, ATTEMPT, CSRF), { kind: 'unknown', responded: true });
  assert.deepEqual(await scripted(json(200, proofBody())).client.paymentProof(STORE, INVOICE, REG, uuid(9), CSRF), { kind: 'unknown', responded: true });
  const replay = { 'idempotent-replayed': 'true' };
  assert.deepEqual(await scripted(json(201, recorded(), replay)).client.recordPayment(STORE, INVOICE, KEY, RECORD_BODY, CSRF),
    { kind: 'recorded', payment: { id: uuid(0x9e1), amountCents: 1250, method: 'cash' }, replayed: true });
  assert.deepEqual(await scripted(json(200, settled('withdrawn'), replay)).client.settlePayment(STORE, INVOICE, KEY, SETTLE_BODY(1), CSRF), { kind: 'settled', state: 'withdrawn', replayed: true });
  for (const header of [undefined, 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '-5']) {
    const reply = refused(429, 'rate_limited', header === undefined ? {} : { 'retry-after': header });
    assert.deepEqual(await scripted(reply).client.registerPayment(STORE, INVOICE, KEY, REGISTER_BODY, CSRF), { kind: 'rate-limited', retryAfterSeconds: 60 }, String(header));
  }
});

test('IIC-45. R2: the card method records as "external_card_terminal"; the record and settle builders refuse a non-canonical tenant; the attempts decoder refuses every state/version/time/payment disagreement and honours (registeredAt, invoiceId, attemptId) across invoices; v4 keys of each variant nibble 8/9/a/b are sent; a known chain word under another status is never mapped as that word', async () => {
  const card = recordBodyOf({ ...RECORD_FIELDS, method: 'external_card_terminal' });
  assert.ok(card !== null && card === RECORD_BODY.replace('"method":"cash"', '"method":"external_card_terminal"'), 'the card body');
  const { calls: cardCalls, client: cardClient } = scripted(json(201, recorded({ method: 'external_card_terminal' })));
  const cardAnswer = await cardClient.recordPayment(STORE, INVOICE, KEY, card ?? '', CSRF);
  assert.ok(cardAnswer.kind === 'recorded' && cardAnswer.payment.method === 'external_card_terminal' && cardCalls.length === 1, 'recorded by card');
  for (const tenant of [TENANT.toUpperCase(), 'x', '']) {
    assert.ok(recordBodyOf({ ...RECORD_FIELDS, expectedTenant: tenant }) === null, `record tenant ${tenant.length}`);
    assert.ok(settleBodyOf(tenant, ATTEMPT, 2) === null, `settle tenant ${tenant.length}`);
  }
  const read = async (attempts: unknown[]) => scripted(json(200, { attempts, nextCursor: null })).client.paymentAttempts(STORE, null, CSRF);
  const settledAt = at(9);
  for (const [name, row] of [
    ['confirmed without payment', attempt(1, { state: 'confirmed', version: 3, settledAt })],
    ['withdrawn with payment', attempt(1, { state: 'withdrawn', version: 3, settledAt, payment: attemptPayment() })],
    ['recorded with settledAt', attempt(1, { state: 'recorded', version: 2, settledAt, payment: attemptPayment() })],
    ['confirmed without settledAt', attempt(1, { state: 'confirmed', version: 3, payment: attemptPayment() })],
    ['open version 3', attempt(1, { version: 3 })], ['recorded version 1', attempt(1, { state: 'recorded', version: 1, payment: attemptPayment() })],
    ['confirmed version 2', attempt(1, { state: 'confirmed', version: 2, settledAt, payment: attemptPayment() })], ['version as text', attempt(1, { version: '1' })],
  ] as Array<[string, unknown]>) assert.deepEqual(await read([row]), { kind: 'unavailable' }, name);
  const [low, high] = [uuid(0x1a0), uuid(0x1a9)].sort();
  const same = at(5);
  const mixed = [attempt(1, { invoiceId: low, registeredAt: same, attemptId: uuid(0xa002) }), attempt(2, { invoiceId: high, registeredAt: same, attemptId: uuid(0xa001) }),
    attempt(3, { invoiceId: high, registeredAt: same, attemptId: uuid(0xa003) }), attempt(4, { invoiceId: low, registeredAt: at(6) })];
  assert.equal((await read(mixed)).kind, 'ok');
  assert.deepEqual(await read([mixed[1], mixed[0]]), { kind: 'unavailable' }, 'invoice order within one time');
  assert.deepEqual(await read([mixed[2], mixed[1]]), { kind: 'unavailable' }, 'attempt order within one invoice');
  for (const nibble of ['8', '9', 'a', 'b']) {
    const key = KEY.replace('-9c8d-', `-${nibble}c8d-`);
    const { calls, client } = scripted(refused(503, 'service_unavailable'));
    assert.equal((await client.registerPayment(STORE, INVOICE, key, REGISTER_BODY, CSRF)).kind, 'unknown', `variant ${nibble}`);
    assert.equal(calls.length, 1, `variant ${nibble} sent`);
  }
  for (const [i, reply] of [refused(409, 'not_found'), refused(409, 'idempotency_key_reused'), refused(400, 'rate_limited'), refused(401, 'forbidden'),
    refused(413, 'invalid_request'), refused(429, 'unauthenticated'), refused(404, 'request_in_progress')].entries()) {
    assert.deepEqual(await scripted(reply).client.registerPayment(STORE, INVOICE, KEY, REGISTER_BODY, CSRF), { kind: 'unknown', responded: true }, `row ${i}`);
  }
  // R2 R3: a 422 whatever its body is key-reused, and a record 404 whatever its body unmatched.
  assert.deepEqual(await scripted(json(422, { x: 1 })).client.settlePayment(STORE, INVOICE, KEY, SETTLE_BODY(1), CSRF), { kind: 'key-reused' });
  assert.deepEqual(await scripted(new Response('nope', { status: 404 })).client.recordPayment(STORE, INVOICE, KEY, RECORD_BODY, CSRF), { kind: 'unmatched' });
  // R3-9: a register 422 in no envelope (and in the sealed one) is key-reused too — never undecided.
  for (const [i, reply] of [new Response('busy', { status: 422 }), json(422, { error: 'idempotency_key_reused' }), json(422, { x: 1 })].entries()) {
    assert.deepEqual(await scripted(reply).client.registerPayment(STORE, INVOICE, KEY, REGISTER_BODY, CSRF), { kind: 'key-reused' }, `register 422 row ${i}`);
  }
});

// ---- M7B-PAYMENTS-P2C: the reversal ----

const PAYMENT = uuid(0x9a1);
const REVERSE_BODY = reverseBodyOf(TENANT, 'wrong_amount') as string;
const REVERSED = (overrides: Record<string, unknown> = {}) => ({ payment: { id: PAYMENT, invoiceId: INVOICE, status: 'reversed', ...overrides } });

test('IIC-46. the reversal paths are the server\'s two templates filled in: payment-reversal-eligibility under the invoice, reversal under the payment', () => {
  const fill = (template: string, ids: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_m, name: string) => ids[name]);
  assert.equal(paymentReversalEligibilityPathOf(STORE, INVOICE), `${BASE}/payment-reversal-eligibility`);
  assert.equal(paymentReversalEligibilityPathOf(STORE, INVOICE), fill(INVOICE_PAYMENT_REVERSAL_ELIGIBILITY_PATH, { storeId: STORE, id: INVOICE }));
  assert.equal(paymentReversalPathOf(STORE, INVOICE, PAYMENT), `${BASE}/payments/${PAYMENT}/reversal`);
  assert.equal(paymentReversalPathOf(STORE, INVOICE, PAYMENT), fill(INVOICE_PAYMENT_REVERSE_PATH, { storeId: STORE, id: INVOICE, paymentId: PAYMENT }));
});

test('IIC-47. the reversal eligibility: allowed ONLY for a 200 exactly { eligibility: "allowed" }; any chain 403 denied; 401 signed-out, 429 its wait, a 400 and everything else unavailable; one GET; a bad id sends nothing', async () => {
  const table: Array<[Response | Error, unknown]> = [
    [json(200, { eligibility: 'allowed' }), { kind: 'allowed' }], [json(200, { eligibility: 'allowed', x: 1 }), { kind: 'unavailable' }], [json(200, { eligibility: 'denied' }), { kind: 'unavailable' }],
    [refused(403, 'forbidden'), { kind: 'denied' }], [refused(403, 'step_up_required'), { kind: 'denied' }], [sealed(403, 'forbidden'), { kind: 'unavailable' }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }], [refused(429, 'rate_limited', { 'retry-after': '4' }), { kind: 'rate-limited', retryAfterSeconds: 4 }],
    [refused(400, 'invalid_request'), { kind: 'unavailable' }], [refused(503, 'service_unavailable'), { kind: 'unavailable' }], [network(), { kind: 'unavailable' }],
  ];
  for (const [reply, outcome] of table) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.reversalEligibility(STORE, INVOICE, CSRF), outcome, name);
    assert.equal(calls.length, 1);
    assert.equal(`${calls[0].init.method} ${calls[0].url}`, `GET ${BASE}/payment-reversal-eligibility`);
  }
  const { calls, client } = scripted();
  assert.deepEqual(await client.reversalEligibility('not-a-store', INVOICE, CSRF), { kind: 'denied' });
  assert.deepEqual(await client.reversalEligibility(STORE, INVOICE.toUpperCase(), CSRF), { kind: 'denied' });
  assert.equal(calls.length, 0);
});

test('IIC-48. the reversal body is built ONCE: exactly {"expectedTenant","reasonCode"} for each of the server\'s six reasons, in its order; any other code or a non-canonical tenant is null; a body not byte for byte the builder\'s, a bad id or key sends NOTHING (not-sent)', async () => {
  assert.deepEqual(Object.keys(INVOICE_PAYMENT_REVERSAL_REASONS), [...INVOICE_PAYMENT_REVERSAL_REASON_CODES]);
  for (const code of INVOICE_PAYMENT_REVERSAL_REASON_CODES) {
    assert.equal(reverseBodyOf(TENANT, code), `{"expectedTenant":"${TENANT}","reasonCode":"${code}"}`, code);
  }
  for (const code of ['', 'paid', 'Other', 'issued_in_error', 'toString', '__proto__', ' other']) assert.equal(reverseBodyOf(TENANT, code), null, `code ${JSON.stringify(code)}`);
  for (const tenant of ['', TENANT.toUpperCase(), `${TENANT} `, 'tenant']) assert.equal(reverseBodyOf(tenant, 'other'), null, `tenant ${JSON.stringify(tenant)}`);
  const BAD_KEY_V1 = KEY.replace(/-4/, '-1');
  const rows: Array<[string, string, string, string, string]> = [
    ['not-a-store', INVOICE, PAYMENT, KEY, REVERSE_BODY], [STORE, 'x', PAYMENT, KEY, REVERSE_BODY], [STORE, INVOICE, 'x', KEY, REVERSE_BODY],
    [STORE, INVOICE, PAYMENT.toUpperCase(), KEY, REVERSE_BODY], [STORE, INVOICE, PAYMENT, KEY.toUpperCase(), REVERSE_BODY], [STORE, INVOICE, PAYMENT, BAD_KEY_V1, REVERSE_BODY],
    [STORE, INVOICE, PAYMENT, KEY, REVERSE_BODY.replace(':', ': ')], [STORE, INVOICE, PAYMENT, KEY, JSON.stringify({ reasonCode: 'wrong_amount', expectedTenant: TENANT })],
    [STORE, INVOICE, PAYMENT, KEY, JSON.stringify({ expectedTenant: TENANT, reasonCode: 'wrong_amount', x: 1 })],
    [STORE, INVOICE, PAYMENT, KEY, voidBodyOf(TENANT, 'issued_in_error') as string], [STORE, INVOICE, PAYMENT, KEY, ''],
  ];
  for (const [i, [store, invoice, payment, key, body]] of rows.entries()) {
    const { calls, client } = scripted();
    assert.deepEqual(await client.reversePayment(store, invoice, payment, key, body, CSRF), { kind: 'not-sent' }, `row ${i}`);
    assert.equal(calls.length, 0, `row ${i} sent nothing`);
  }
});

test('IIC-49. a reversal is ONE fetch: POST to the payment\'s reversal path with exactly the five command headers (one Idempotency-Key, the session CSRF token) and the caller\'s exact bytes; same-origin, credentialed, uncached, never redirected; the method takes no AbortSignal', async () => {
  const { calls, client } = scripted(refused(503, 'service_unavailable'));
  await client.reversePayment(STORE, INVOICE, PAYMENT, KEY, REVERSE_BODY, CSRF);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(`${call.init.method} ${call.url}`, `POST ${BASE}/payments/${PAYMENT}/reversal`);
  const COMMAND = [['accept', 'application/json'], ['content-type', 'application/json'], ['idempotency-key', KEY], ['x-tmpos-csrf', '1'], ['x-tmpos-session-csrf', CSRF]];
  // R2 U1: the key and the token are compared, never printed.
  assert.ok(JSON.stringify([...headersOf(call).entries()]) === JSON.stringify(COMMAND), 'exactly the five command headers');
  assert.ok(call.init.body === REVERSE_BODY && REVERSE_BODY === `{"expectedTenant":"${TENANT}","reasonCode":"wrong_amount"}`, 'the caller\'s exact bytes');
  assert.equal(call.init.credentials, 'include');
  assert.equal(call.init.mode, 'same-origin');
  assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.referrerPolicy, 'no-referrer');
  assert.ok(call.init.signal instanceof AbortSignal); // the module's own (its timeout), never a caller's
  assert.equal(client.reversePayment.length, 6);
  assert.equal(client.reversalEligibility.length, 4);
});

test('IIC-50. every reversal answer is ONE outcome by status AND word AND envelope: reversed ONLY for the exact 200 naming the payment and invoice asked (replay header absent or "true"); sealed invalid_state/write_conflict; step_up_required step-up; the chain\'s own; a 503, a timeout, no answer, an unnamed word or any other 200 unknown with its responded flag; never a retry', async () => {
  const table: Array<[Response | Error, unknown]> = [
    [json(200, REVERSED()), { kind: 'reversed', replayed: false }],
    [json(200, REVERSED(), { 'idempotent-replayed': 'true' }), { kind: 'reversed', replayed: true }],
    [json(200, REVERSED(), { 'idempotent-replayed': 'yes' }), { kind: 'unknown', responded: true }],
    [json(200, REVERSED({ id: uuid(0x9a2) })), { kind: 'unknown', responded: true }],
    [json(200, REVERSED({ invoiceId: uuid(0x1a2) })), { kind: 'unknown', responded: true }],
    [json(200, REVERSED({ amountCents: 100 })), { kind: 'unknown', responded: true }],
    [json(200, { ...REVERSED(), requestId: 'r' }), { kind: 'unknown', responded: true }],
    [json(200, { payment: { id: PAYMENT, invoiceId: INVOICE } }), { kind: 'unknown', responded: true }],
    [json(200, REVERSED({ status: 'active' })), { kind: 'unknown', responded: true }],
    [new Response('ok', { status: 200 }), { kind: 'unknown', responded: true }],
    [json(201, REVERSED()), { kind: 'unknown', responded: true }],
    [sealed(409, 'invalid_state'), { kind: 'invalid-state' }], [sealed(409, 'write_conflict'), { kind: 'write-conflict' }],
    [refused(409, 'invalid_state'), { kind: 'unknown', responded: true }], [refused(409, 'write_conflict'), { kind: 'tenant-conflict' }],
    [refused(409, 'request_in_progress'), { kind: 'in-progress' }], [sealed(409, 'already_recorded'), { kind: 'unknown', responded: true }],
    [refused(404, 'not_found'), { kind: 'not-found' }], [sealed(404, 'not_found'), { kind: 'unknown', responded: true }],
    [refused(403, 'step_up_required'), { kind: 'step-up' }], [refused(403, 'forbidden'), { kind: 'denied' }], [sealed(403, 'step_up_required'), { kind: 'unknown', responded: true }],
    [refused(401, 'unauthenticated'), { kind: 'signed-out' }], [refused(429, 'rate_limited', { 'retry-after': '7' }), { kind: 'rate-limited', retryAfterSeconds: 7 }],
    [refused(422, 'idempotency_key_reused'), { kind: 'key-reused' }],
    [refused(400, 'invalid_request'), { kind: 'invalid' }], [refused(413, 'content_too_large'), { kind: 'invalid' }],
    [refused(503, 'service_unavailable'), { kind: 'unknown', responded: true }], [refused(500, 'internal_error'), { kind: 'unknown', responded: true }],
    [network(), { kind: 'unknown', responded: false }],
  ];
  for (const [reply, outcome] of table) {
    const name = await rowName(reply);
    const { calls, client } = scripted(reply);
    assert.deepEqual(await client.reversePayment(STORE, INVOICE, PAYMENT, KEY, REVERSE_BODY, CSRF), outcome, name);
    assert.equal(calls.length, 1, `${name}: one fetch`);
  }
  // A timeout is no answer too (the outcome is unknown, never "cancelled"), and is not retried.
  let hung = 0;
  const hanging = createInvoiceIssuingClient({ timeoutMs: 5, fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    hung += 1;
    return new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
  }) as typeof globalThis.fetch });
  assert.deepEqual(await hanging.reversePayment(STORE, INVOICE, PAYMENT, KEY, REVERSE_BODY, CSRF), { kind: 'unknown', responded: false });
  assert.equal(hung, 1);
});
