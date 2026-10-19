// M7B-INVOICES-ISSUE-P2 — the shop's client for the seven issuing routes (docs/phase-4/12 §10, ADR-50):
// GET/PUT /api/v1/issuing-settings/{storeId} (the store owner's issuer and tax settings: version 0 and configured false
// when the store has none; every accepted PUT a new version), GET …/invoice-drafts/{id}/issue-eligibility (whether this
// session may issue at that store now; it reads no draft), GET …/invoice-drafts/{id}/issue-preview (the authoritative
// review and, in `expected`, the exact issue body), POST …/invoice-drafts/{id}/issue (the idempotent issue: a 201 names
// the invoice, never its number), GET /api/v1/stores/{storeId}/invoices (newest number first; `?sourceDraft=` is a
// separate one-item lookup mode) and GET /api/v1/stores/{storeId}/invoices/{id} (the issued snapshot, version 1).
//
//   - The server is the authority for everything: who may read, write or issue, which tenant a store belongs to, the
//     amounts, the number and what was stored. This client reports what the server answered and decides nothing.
//   - An answer is untrusted: only a JSON body that matches the contract EXACTLY is a result — no extra key anywhere,
//     every id canonical, every version, number and amount a safe integer in its range (never -0), snapshotVersion 1,
//     status "issued" or "voided" (a voided detail with exactly its `void` member, M7B-INVOICES-VOID-P1), USD, the tax in exactly one of its two shapes, the lines in position order with each total its
//     own BigInt product, the subtotal their sum, the tax (S × R + 50,000) / 100,000 in BigInt and the total S plus it
//     (S alone with no tax), every seller value equal to its own normalized form, an issuedAt in the UTC microsecond form.
//     A read's answer must also name what was asked (the store, the draft, the invoice, the tenant passed in). Anything
//     else is `unavailable` (a read) or `unknown` (a command), never half an answer. A refusal counts only with its exact
//     status and envelope: the chain's `{ error, requestId }` or, for a key's recorded completion, the sealed `{ error }`.
//   - Commands: the settings PUT is `saved` on an exact 200 for the store asked at the version the body SENT plus one,
//     echoing exactly the values sent; the issue is `issued` on an exact 201 naming the draft asked at its version plus one
//     and a `Location` that is exactly that invoice's path at the store asked — compared, never followed. A 503, any
//     other status, a body this client cannot name, a missing or different Location or no answer at all is `unknown`: the
//     outcome is undecided, and only the same key and the same bytes can ask again. Nothing here retries, ever: each
//     method is one fetch.
//   - The body of a command is the caller's exact string, built ONCE (`issuingSettingsBody`, `issueBodyOf`): the server
//     fingerprints the raw bytes, so this module never re-serializes it — and never sends one the server's planner would
//     refuse (`invalid`, nothing sent). It never mints a key either: the caller owns the key's policy.
//   - The value rules restate the server's (server/runtime/issuingSettings.ts, customerCreate.ts normalizePlainText): text
//     trimmed, one visible scalar, no control, U+2028/U+2029, lone surrogate or Bidi_Control; legal name 1-200 scalars,
//     store name 1-120, tax registration id null or 1-64; the postal address 1-8 LF-separated lines of 1-120 (no CR
//     anywhere); a rate an integer 0..100000 thousandths of a percent, typed as a percentage and converted EXACTLY (string
//     arithmetic, never a float); no default mode or rate, and an explicit 0 is not "none".
//   - A store, draft or invoice id, or a cursor, outside its grammar is never put into a request path. A cursor sent is
//     only ever one this client decoded; the sourceDraft lookup stands alone (no limit, no cursor).
//   - Every request carries the session CSRF token the caller was just handed, in a header; a command also carries the
//     intent header and the Idempotency-Key. Nothing is put into a URL but ids, the page size and the opaque cursor.
//   - It keeps nothing: no cache, no storage, no cookie access, no log. Requests are same-origin with credentials, never
//     redirected. No method ever rejects.

import { INTENT_HEADER, JSON_TYPE_RE, REQUEST_TIMEOUT_MS, SESSION_CSRF_HEADER } from './tenantSessionClient';
import { isCustomerId, normalizePlainText, retryAfterSeconds } from './customersClient';
import { MAX_DRAFT_LINES, MAX_EXPECTED_VERSION, STORES_PATH, draftPathOf, isDraftCreatedAt, normalizeDraftDescription, type EligibilityResult } from './invoiceDraftsClient';

export const ISSUING_SETTINGS_PATH = '/api/v1/issuing-settings';
/** One store's issuing settings: only ever built from a canonical store id. */
export const issuingSettingsPathOf = (storeId: string): string => `${ISSUING_SETTINGS_PATH}/${storeId}`;
export const issueEligibilityPathOf = (storeId: string, draftId: string): string => `${draftPathOf(storeId, draftId)}/issue-eligibility`;
export const issuePreviewPathOf = (storeId: string, draftId: string): string => `${draftPathOf(storeId, draftId)}/issue-preview`;
export const issuePathOf = (storeId: string, draftId: string): string => `${draftPathOf(storeId, draftId)}/issue`;
export const issuedInvoicesPathOf = (storeId: string): string => `${STORES_PATH}/${storeId}/invoices`;
/** One issued invoice of one store: what an issue's 201 `Location` must be exactly. */
export const issuedInvoicePathOf = (storeId: string, invoiceId: string): string => `${issuedInvoicesPathOf(storeId)}/${invoiceId}`;

export const LEGAL_NAME_MAX_CHARACTERS = 200;
export const ISSUING_STORE_NAME_MAX_CHARACTERS = 120;
export const TAX_REGISTRATION_ID_MAX_CHARACTERS = 64;
export const POSTAL_ADDRESS_MAX_LINES = 8;
export const POSTAL_ADDRESS_LINE_MAX_CHARACTERS = 120;
/** The largest rate in thousandths of a percent: 100 %. */
export const TAX_RATE_MAX = 100_000;
export const SETTINGS_BODY_MAX_BYTES = 8 * 1024;
export const ISSUE_BODY_MAX_BYTES = 1_024;
export const ISSUED_PAGE_LIMIT = 20; // the server's default page; its maximum is 50
export const TAX_LABEL = 'Tax';
export const NO_TAX_DESCRIPTION = 'No tax calculated';

/** The six void reason codes and their labels (docs/phase-4 contract §2, this order) — the shop's own copy: src/ never imports server/. */
export const INVOICE_VOID_REASONS = Object.freeze({
  issued_in_error: 'Issued by mistake',
  wrong_customer: 'Wrong customer',
  wrong_lines_or_amounts: 'Wrong lines or amounts',
  wrong_seller_details: 'Wrong seller details',
  duplicate: 'Duplicate of another invoice',
  other: 'Other reason',
} as const);
export type InvoiceVoidReasonCode = keyof typeof INVOICE_VOID_REASONS;
const isVoidReasonCode = (value: unknown): value is InvoiceVoidReasonCode => typeof value === 'string' && Object.prototype.hasOwnProperty.call(INVOICE_VOID_REASONS, value);
/** The lifecycle a read reports: its current state only — never which request made it so. */
export type IssuedStatus = 'issued' | 'voided';
const MAX = Number.MAX_SAFE_INTEGER;
const MAX_BIG = BigInt(MAX);
const CUSTOMER_NAME_MAX_CHARACTERS = 200; // customerDirectory.ts isStorableName: a longer name is never served
// A preview or an issued invoice of 50 lines of 256 astral scalars, each escaped as two \uXXXX units, is about 160,000
// characters; a page of 20 summaries a few KiB.
const MAX_BODY_CHARS = 262_144;
const LONE_SURROGATE_RE = /\p{Cs}/u;
const RATE_RE = /^(0|[1-9][0-9]{0,2})(?:\.([0-9]{1,3}))?$/;
// The issued list's continuation: the tag byte 0x04 and the last invoice's 16 id bytes, unpadded base64url in the one
// canonical spelling (invoiceIssuing.ts encodeIssuedInvoiceCursor) — 'B', then 'A'..'P' for the tag's low bits.
const CURSOR_RE = /^B[A-P][A-Za-z0-9_-]{20}[AEIMQUYcgkosw048]$/;

export type TaxSetting = { readonly mode: 'exclusive_rate'; readonly rateMilliPercent: number } | { readonly mode: 'none' };

export type IssuingSettings =
  | { readonly storeId: string; readonly version: 0; readonly configured: false }
  | {
    readonly storeId: string; readonly version: number; readonly configured: true;
    readonly legalName: string; readonly storeName: string; readonly postalAddress: string; readonly taxRegistrationId: string | null; readonly tax: TaxSetting;
  };

/** The values a settings write carries, each as the server stores it. */
export interface SettingsValues {
  readonly legalName: string; readonly storeName: string; readonly postalAddress: string; readonly taxRegistrationId: string | null; readonly tax: TaxSetting;
}

export interface InvoiceLine {
  readonly position: number; readonly description: string; readonly quantity: number; readonly unitPriceCents: number; readonly lineTotalCents: number;
}
export type TaxAmount =
  | { readonly mode: 'exclusive_rate'; readonly label: 'Tax'; readonly rateMilliPercent: number; readonly amountCents: number }
  | { readonly mode: 'none'; readonly description: 'No tax calculated' };
export interface InvoiceAmounts { readonly currency: 'USD'; readonly subtotalCents: number; readonly tax: TaxAmount; readonly totalCents: number }
export interface SnapshotCustomer { readonly id: string; readonly name: string; readonly version: number }
export interface Seller { readonly legalName: string; readonly storeName: string; readonly postalAddress: string; readonly taxRegistrationId: string | null }

/** Exactly the issue body: what POST …/issue sends, built once by `issueBodyOf`. */
export interface IssueExpected {
  readonly expectedTenant: string; readonly expectedVersion: number; readonly expectedSettingsVersion: number; readonly expectedCustomerVersion: number;
}
export interface IssuePreview {
  readonly draft: { readonly id: string; readonly version: number; readonly lines: readonly InvoiceLine[]; readonly subtotalCents: number };
  readonly customer: SnapshotCustomer;
  readonly issuingSettings: Seller & { readonly version: number; readonly tax: TaxSetting };
  readonly amounts: InvoiceAmounts;
  readonly expected: IssueExpected;
}
export interface IssuedSummary {
  readonly id: string; readonly number: number; readonly sourceDraftId: string; readonly customerId: string; readonly customerName: string;
  readonly currency: 'USD'; readonly totalCents: number; readonly issuedAt: string; readonly status: IssuedStatus;
}
export interface IssuedInvoice {
  readonly id: string; readonly number: number; readonly issuedAt: string; readonly status: IssuedStatus;
  /** Null exactly when issued (the wire has no `void` key then); the void's time (issuedAt's form) and reason when voided. */
  readonly void: { readonly voidedAt: string; readonly reasonCode: InvoiceVoidReasonCode } | null;
  readonly sourceDraft: { readonly id: string; readonly version: number };
  readonly seller: Seller; readonly issuingSettingsVersion: number; readonly customer: SnapshotCustomer;
  readonly lines: readonly InvoiceLine[]; readonly amounts: InvoiceAmounts;
}

interface RateLimited { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
type ReadRefusal = { readonly kind: 'signed-out' | 'denied' | 'unavailable' } | RateLimited;

export type SettingsResult = { readonly kind: 'ok'; readonly settings: IssuingSettings } | { readonly kind: 'not-found' } | ReadRefusal;
export type SaveSettingsResult =
  | { readonly kind: 'saved'; readonly settings: Extract<IssuingSettings, { configured: true }>; readonly replayed: boolean }
  | { readonly kind: 'conflict' | 'tenant-changed' | 'in-progress' | 'key-reused' | 'not-found' | 'invalid' | 'step-up' | 'denied' | 'signed-out' }
  | RateLimited
  | { readonly kind: 'unknown'; readonly responded: boolean };
export type PreviewResult =
  | { readonly kind: 'ok'; readonly preview: IssuePreview }
  | { readonly kind: 'not-found' | 'invalid-state' | 'not-configured' | 'out-of-range' }
  | ReadRefusal;
export type IssueResult =
  | { readonly kind: 'issued'; readonly invoiceId: string; readonly draftVersion: number; readonly replayed: boolean }
  | { readonly kind: 'conflict' | 'not-open' | 'not-configured' | 'out-of-range' | 'tenant-changed' | 'in-progress' | 'key-reused' | 'not-found' | 'invalid' | 'denied' | 'signed-out' }
  | RateLimited
  | { readonly kind: 'unknown'; readonly responded: boolean };
export type IssuedPageResult =
  | { readonly kind: 'ok'; readonly invoices: readonly IssuedSummary[]; readonly nextCursor: string | null }
  | { readonly kind: 'bad-cursor' }
  | ReadRefusal;
/** The sourceDraft lookup: the one issued invoice of that draft, or null — "none found yet", never proof it was not issued. */
export type FindIssuedResult = { readonly kind: 'ok'; readonly invoice: IssuedSummary | null } | ReadRefusal;
export type IssuedResult = { readonly kind: 'ok'; readonly invoice: IssuedInvoice } | { readonly kind: 'not-found' } | ReadRefusal;

// ---- text, rates and times ----

/** A postal address as the server stores it — the whole value trimmed, 1-8 LF lines of 1-120 scalars, no CR anywhere — or null. */
export function normalizePostalAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.includes('\r')) return null;
  const lines = raw.trim().split('\n');
  if (lines.length > POSTAL_ADDRESS_MAX_LINES) return null;
  const out: string[] = [];
  for (const line of lines) {
    const text = normalizePlainText(line, POSTAL_ADDRESS_LINE_MAX_CHARACTERS);
    if (text === null) return null;
    out.push(text);
  }
  return out.join('\n');
}

/**
 * A rate typed as a percentage (trimmed; digits, at most three decimals, no sign, exponent or leading zero; 0..100) as
 * an integer of thousandths of a percent — "8.875" is 8875, "0" is 0, "100" is 100000 — or null. String arithmetic only.
 */
export function parseRatePercent(raw: string): number | null {
  const match = RATE_RE.exec(raw.trim());
  if (match === null) return null;
  const value = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  return value <= TAX_RATE_MAX ? value : null;
}

/** Thousandths of a percent as the digits a rate field holds ("8.875", "5", "0", "0.5"): what parseRatePercent reads back. */
export function rateDigits(milli: number): string {
  const fraction = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${Math.floor(milli / 1000)}${fraction === '' ? '' : `.${fraction}`}`;
}
/** Thousandths of a percent as a percentage: "8.875%", "5%", "0%". */
export const rateText = (milli: number): string => `${rateDigits(milli)}%`;

/** A validated `YYYY-MM-DDTHH:MM:SS.ffffffZ` as "YYYY-MM-DD HH:MM:SS UTC": sliced, never parsed into a local time. */
export const utcText = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

// ---- the bodies, built once ----

/** The settings form's fields as typed: the tax mode '' until one is chosen (there is no default). */
export interface IssuingSettingsFields {
  readonly legalName: string; readonly storeName: string; readonly postalAddress: string; readonly taxRegistrationId: string;
  readonly taxMode: '' | 'exclusive_rate' | 'none'; readonly rate: string;
}
/** What is wrong with each field (false when it is fine); `context`: the tenant or version the body would assert is out of range. */
export interface IssuingSettingsErrors {
  readonly legalName: boolean; readonly storeName: boolean; readonly postalAddress: boolean; readonly taxRegistrationId: boolean;
  readonly taxMode: boolean; readonly rate: boolean; readonly context: boolean;
}
export type IssuingSettingsBody =
  | { readonly kind: 'ok'; readonly body: string; readonly values: SettingsValues }
  | { readonly kind: 'invalid'; readonly errors: IssuingSettingsErrors };

/**
 * The PUT body of one settings write, built ONCE: keys expectedTenant (the store's tenant as GET /api/v1/stores answered
 * it), expectedVersion (the version the read reported, 0..2^53-2), legalName, storeName, postalAddress, taxRegistrationId
 * (a blank field is null) and tax — in that order, every value normalized — or which fields the server would refuse.
 */
export function issuingSettingsBody(expectedTenant: string, expectedVersion: number, fields: IssuingSettingsFields): IssuingSettingsBody {
  const legalName = normalizePlainText(fields.legalName, LEGAL_NAME_MAX_CHARACTERS);
  const storeName = normalizePlainText(fields.storeName, ISSUING_STORE_NAME_MAX_CHARACTERS);
  const postalAddress = normalizePostalAddress(fields.postalAddress);
  const taxId = fields.taxRegistrationId.trim() === '' ? null : normalizePlainText(fields.taxRegistrationId, TAX_REGISTRATION_ID_MAX_CHARACTERS);
  const rate = fields.taxMode === 'exclusive_rate' ? parseRatePercent(fields.rate) : null;
  const errors: IssuingSettingsErrors = Object.freeze({
    legalName: legalName === null, storeName: storeName === null, postalAddress: postalAddress === null,
    taxRegistrationId: fields.taxRegistrationId.trim() !== '' && taxId === null,
    taxMode: fields.taxMode !== 'exclusive_rate' && fields.taxMode !== 'none', // no default, and nothing but the two modes
    rate: fields.taxMode === 'exclusive_rate' && rate === null,
    context: !isCustomerId(expectedTenant) || !isCount(expectedVersion, 0, MAX_EXPECTED_VERSION),
  });
  if (Object.values(errors).some(Boolean) || legalName === null || storeName === null || postalAddress === null) return Object.freeze({ kind: 'invalid', errors });
  const tax: TaxSetting = fields.taxMode === 'none' ? Object.freeze({ mode: 'none' }) : Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: rate as number });
  const values: SettingsValues = Object.freeze({ legalName, storeName, postalAddress, taxRegistrationId: taxId, tax });
  const body = JSON.stringify({ expectedTenant, expectedVersion, legalName, storeName, postalAddress, taxRegistrationId: taxId, tax });
  return Object.freeze({ kind: 'ok', body, values });
}

/** The POST body of one issue, built ONCE from a validated preview's `expected`, in its fixed key order; null when the planner would refuse it. */
export function issueBodyOf(expected: IssueExpected): string | null {
  const { expectedTenant, expectedVersion, expectedSettingsVersion, expectedCustomerVersion } = expected;
  if (!isCustomerId(expectedTenant) || !isCount(expectedVersion, 1, MAX_EXPECTED_VERSION) || !isCount(expectedSettingsVersion, 1, MAX)
    || !isCount(expectedCustomerVersion, 1, MAX)) return null;
  const body = JSON.stringify({ expectedTenant, expectedVersion, expectedSettingsVersion, expectedCustomerVersion });
  return bytesOf(body) <= ISSUE_BODY_MAX_BYTES ? body : null;
}

// ---- strict answer parsers ----

type Data = Record<string, unknown>;
const isPlain = (value: unknown): value is Data => {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasKeys = (data: Data, keys: readonly string[]): boolean => {
  const own = Object.keys(data);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
/** A safe integer in [min, max], never -0. */
const isCount = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max && !Object.is(value, -0);
const isCents = (value: unknown): value is number => isCount(value, 0, MAX);
const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
/** A customer name the server would serve (customerDirectory.ts isStorableName): 1-200 well-formed scalars. */
const isStorableName = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= 2 * CUSTOMER_NAME_MAX_CHARACTERS && !LONE_SURROGATE_RE.test(value)
  && [...value].length <= CUSTOMER_NAME_MAX_CHARACTERS;

/** `{ mode: "exclusive_rate", rateMilliPercent }` or `{ mode: "none" }` exactly; otherwise null. */
function taxOf(value: unknown): TaxSetting | null {
  if (!isPlain(value)) return null;
  if (value.mode === 'none') return hasKeys(value, ['mode']) ? Object.freeze({ mode: 'none' }) : null;
  if (value.mode !== 'exclusive_rate' || !hasKeys(value, ['mode', 'rateMilliPercent']) || !isCount(value.rateMilliPercent, 0, TAX_RATE_MAX)) return null;
  return Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: value.rateMilliPercent });
}

/** The four seller values, each exactly its own normalized form (issuingSettings.ts sellerValuesOf); otherwise null. */
function sellerOf(value: Data): Seller | null {
  const { legalName, storeName, postalAddress, taxRegistrationId } = value;
  if (typeof legalName !== 'string' || normalizePlainText(legalName, LEGAL_NAME_MAX_CHARACTERS) !== legalName) return null;
  if (typeof storeName !== 'string' || normalizePlainText(storeName, ISSUING_STORE_NAME_MAX_CHARACTERS) !== storeName) return null;
  if (typeof postalAddress !== 'string' || normalizePostalAddress(postalAddress) !== postalAddress) return null;
  if (taxRegistrationId !== null && (typeof taxRegistrationId !== 'string'
    || normalizePlainText(taxRegistrationId, TAX_REGISTRATION_ID_MAX_CHARACTERS) !== taxRegistrationId)) return null;
  return Object.freeze({ legalName, storeName, postalAddress, taxRegistrationId: taxRegistrationId as string | null });
}

const SETTINGS_KEYS: readonly string[] = ['storeId', 'version', 'configured', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax'];

/** `{ issuingSettings: … }` exactly, for the store asked: version 0 unconfigured, or 1..2^53-1 with every value servable. */
function settingsOf(body: unknown, storeId: string): IssuingSettings | null {
  if (!isPlain(body) || !hasKeys(body, ['issuingSettings'])) return null;
  const view = body.issuingSettings;
  if (!isPlain(view) || view.storeId !== storeId) return null;
  if (view.configured === false) {
    return hasKeys(view, ['storeId', 'version', 'configured']) && view.version === 0 && !Object.is(view.version, -0)
      ? Object.freeze({ storeId, version: 0, configured: false }) : null;
  }
  if (view.configured !== true || !hasKeys(view, SETTINGS_KEYS) || !isCount(view.version, 1, MAX)) return null;
  const seller = sellerOf(view);
  const tax = taxOf(view.tax);
  if (seller === null || tax === null) return null;
  return Object.freeze({ storeId, version: view.version, configured: true, ...seller, tax });
}

const LINE_KEYS: readonly string[] = ['position', 'description', 'quantity', 'unitPriceCents', 'lineTotalCents'];

/** 1-50 lines at positions 1..n, each total its own BigInt product, summing exactly to `subtotal`; otherwise null. */
function linesOf(value: unknown, subtotal: number): readonly InvoiceLine[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DRAFT_LINES) return null;
  const out: InvoiceLine[] = [];
  let sum = 0n;
  for (const [index, line] of (value as unknown[]).entries()) {
    if (!isPlain(line) || !hasKeys(line, LINE_KEYS) || line.position !== index + 1) return null;
    const { description, quantity, unitPriceCents, lineTotalCents } = line;
    if (typeof description !== 'string' || normalizeDraftDescription(description) !== description) return null;
    if (!isCount(quantity, 1, MAX) || !isCents(unitPriceCents) || !isCents(lineTotalCents)) return null;
    if (BigInt(quantity) * BigInt(unitPriceCents) !== BigInt(lineTotalCents)) return null;
    sum += BigInt(lineTotalCents);
    out.push(Object.freeze({ position: index + 1, description, quantity, unitPriceCents, lineTotalCents }));
  }
  return sum === BigInt(subtotal) ? Object.freeze(out) : null;
}

/** The amounts exactly, their arithmetic its own (invoiceIssuing.ts issueAmountsOf), the subtotal `subtotal`; otherwise null. */
function amountsOf(value: unknown, subtotal: number): InvoiceAmounts | null {
  if (!isPlain(value) || !hasKeys(value, ['currency', 'subtotalCents', 'tax', 'totalCents']) || value.currency !== 'USD' || value.subtotalCents !== subtotal) return null;
  const { tax, totalCents } = value;
  if (!isPlain(tax) || !isCents(totalCents)) return null;
  if (tax.mode === 'none') {
    if (!hasKeys(tax, ['mode', 'description']) || tax.description !== NO_TAX_DESCRIPTION || totalCents !== subtotal) return null;
    return Object.freeze({ currency: 'USD', subtotalCents: subtotal, tax: Object.freeze({ mode: 'none', description: NO_TAX_DESCRIPTION }), totalCents });
  }
  if (tax.mode !== 'exclusive_rate' || !hasKeys(tax, ['mode', 'label', 'rateMilliPercent', 'amountCents']) || tax.label !== TAX_LABEL) return null;
  const { rateMilliPercent, amountCents } = tax;
  if (!isCount(rateMilliPercent, 0, TAX_RATE_MAX) || !isCents(amountCents)) return null;
  const amount = (BigInt(subtotal) * BigInt(rateMilliPercent) + 50_000n) / 100_000n;
  if (BigInt(amountCents) !== amount || BigInt(totalCents) !== BigInt(subtotal) + amount || BigInt(totalCents) > MAX_BIG) return null;
  return Object.freeze({
    currency: 'USD', subtotalCents: subtotal, tax: Object.freeze({ mode: 'exclusive_rate', label: TAX_LABEL, rateMilliPercent, amountCents }), totalCents,
  });
}

/** `{ id, name, version }` exactly: a canonical id, a name the directory would serve, a version of 1 or more; otherwise null. */
function customerOf(value: unknown): SnapshotCustomer | null {
  if (!isPlain(value) || !hasKeys(value, ['id', 'name', 'version'])) return null;
  const { id, name, version } = value;
  return isCustomerId(id) && isStorableName(name) && isCount(version, 1, MAX) ? Object.freeze({ id, name, version }) : null;
}

const PREVIEW_SETTINGS_KEYS: readonly string[] = ['version', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax'];
const EXPECTED_KEYS: readonly string[] = ['expectedTenant', 'expectedVersion', 'expectedSettingsVersion', 'expectedCustomerVersion'];

/**
 * `{ preview: … }` exactly, for the draft asked, its amounts under the settings' own tax, and an `expected` that is exactly
 * the issue body for what it shows: the tenant passed in, the draft's version (1..2^53-2), the settings' and the
 * customer's versions; otherwise null.
 */
function previewOf(body: unknown, draftId: string, tenantId: string): IssuePreview | null {
  if (!isPlain(body) || !hasKeys(body, ['preview'])) return null;
  const p = body.preview;
  if (!isPlain(p) || !hasKeys(p, ['draft', 'customer', 'issuingSettings', 'amounts', 'expected'])) return null;
  const { draft, issuingSettings: s, expected: e } = p;
  if (!isPlain(draft) || !hasKeys(draft, ['id', 'version', 'lines', 'subtotalCents']) || draft.id !== draftId) return null;
  if (!isCount(draft.version, 1, MAX_EXPECTED_VERSION) || !isCents(draft.subtotalCents)) return null;
  const lines = linesOf(draft.lines, draft.subtotalCents);
  const customer = customerOf(p.customer);
  if (lines === null || customer === null || !isPlain(s) || !hasKeys(s, PREVIEW_SETTINGS_KEYS) || !isCount(s.version, 1, MAX)) return null;
  const seller = sellerOf(s);
  const tax = taxOf(s.tax);
  const amounts = amountsOf(p.amounts, draft.subtotalCents);
  if (seller === null || tax === null || amounts === null || amounts.tax.mode !== tax.mode) return null;
  if (tax.mode === 'exclusive_rate' && (amounts.tax.mode !== 'exclusive_rate' || amounts.tax.rateMilliPercent !== tax.rateMilliPercent)) return null;
  if (!isPlain(e) || !hasKeys(e, EXPECTED_KEYS) || e.expectedTenant !== tenantId || !isCustomerId(tenantId) || e.expectedVersion !== draft.version
    || e.expectedSettingsVersion !== s.version || e.expectedCustomerVersion !== customer.version) return null;
  return Object.freeze({
    draft: Object.freeze({ id: draftId, version: draft.version, lines, subtotalCents: draft.subtotalCents }),
    customer,
    issuingSettings: Object.freeze({ ...seller, version: s.version, tax }),
    amounts,
    expected: Object.freeze({ expectedTenant: tenantId, expectedVersion: draft.version, expectedSettingsVersion: s.version, expectedCustomerVersion: customer.version }),
  });
}

const SUMMARY_KEYS: readonly string[] = ['id', 'number', 'sourceDraftId', 'customerId', 'customerName', 'currency', 'totalCents', 'issuedAt', 'status', 'snapshotVersion'];

function summaryOf(value: unknown): IssuedSummary | null {
  if (!isPlain(value) || !hasKeys(value, SUMMARY_KEYS)) return null;
  const { id, number, sourceDraftId, customerId, customerName, currency, totalCents, issuedAt, status, snapshotVersion } = value;
  if (!isCustomerId(id) || !isCount(number, 1, MAX) || !isCustomerId(sourceDraftId) || !isCustomerId(customerId) || !isStorableName(customerName)) return null;
  if (currency !== 'USD' || !isCents(totalCents) || !isDraftCreatedAt(issuedAt) || (status !== 'issued' && status !== 'voided') || snapshotVersion !== 1) return null;
  return Object.freeze({ id, number, sourceDraftId, customerId, customerName, currency, totalCents, issuedAt, status });
}

/** The continuation the server writes for a page ending at `invoiceId` (invoiceIssuing.ts encodeIssuedInvoiceCursor). */
const cursorOfInvoice = (invoiceId: string): string =>
  btoa(String.fromCharCode(0x04, ...(invoiceId.replace(/-/g, '').match(/../g) ?? []).map((pair) => parseInt(pair, 16))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * `{ invoices, nextCursor }` exactly: at most `limit`, no id or source draft twice, numbers strictly descending, never the
 * anchor `cursor` names, a cursor only behind a full page naming its last invoice — and, for a sourceDraft lookup
 * (`draftId`), at most one item, of that draft, with no cursor.
 */
function pageOf(body: unknown, limit: number, cursor: string | null, draftId: string | null): { invoices: readonly IssuedSummary[]; nextCursor: string | null } | null {
  if (!isPlain(body) || !hasKeys(body, ['invoices', 'nextCursor'])) return null;
  const { invoices, nextCursor } = body;
  if (!Array.isArray(invoices) || invoices.length > limit) return null;
  const next = nextCursor === null ? null : typeof nextCursor === 'string' && CURSOR_RE.test(nextCursor) ? nextCursor : undefined;
  if (next === undefined || (next !== null && (invoices.length !== limit || draftId !== null))) return null;
  const rows: IssuedSummary[] = [];
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const value of invoices as unknown[]) {
    const row = summaryOf(value);
    if (row === null || ids.has(row.id) || sources.has(row.sourceDraftId) || (rows.length > 0 && rows[rows.length - 1].number <= row.number)) return null;
    if ((cursor !== null && cursorOfInvoice(row.id) === cursor) || (draftId !== null && row.sourceDraftId !== draftId)) return null;
    ids.add(row.id);
    sources.add(row.sourceDraftId);
    rows.push(row);
  }
  if (next !== null && next !== cursorOfInvoice(rows[rows.length - 1].id)) return null;
  return { invoices: Object.freeze(rows), nextCursor: next };
}

const INVOICE_KEYS: readonly string[] = ['id', 'number', 'status', 'snapshotVersion', 'issuedAt', 'sourceDraft', 'seller', 'issuingSettingsVersion', 'customer', 'lines', 'amounts'];

/**
 * `{ invoice: … }` exactly, for the invoice asked: snapshot version 1, its lines and amounts their own arithmetic; issued
 * with no `void` key, or voided with exactly one more, `void: { voidedAt, reasonCode }` (issuedAt's form, not before it;
 * one of the six codes); otherwise null.
 */
function invoiceOf(body: unknown, invoiceId: string): IssuedInvoice | null {
  if (!isPlain(body) || !hasKeys(body, ['invoice'])) return null;
  const v = body.invoice;
  const voided = isPlain(v) && v.status === 'voided';
  if (!isPlain(v) || !hasKeys(v, voided ? [...INVOICE_KEYS, 'void'] : INVOICE_KEYS) || v.id !== invoiceId || (v.status !== 'issued' && !voided) || v.snapshotVersion !== 1) return null;
  const { number, issuedAt, sourceDraft, seller: rawSeller, issuingSettingsVersion, amounts: rawAmounts } = v;
  if (!isCount(number, 1, MAX) || !isDraftCreatedAt(issuedAt) || !isCount(issuingSettingsVersion, 1, MAX)) return null;
  let lifecycle: IssuedInvoice['void'] = null;
  if (voided) {
    const raw = v.void;
    // Same fixed-width UTC form on both sides, so the string order is the time order.
    if (!isPlain(raw) || !hasKeys(raw, ['voidedAt', 'reasonCode']) || !isDraftCreatedAt(raw.voidedAt) || raw.voidedAt < issuedAt || !isVoidReasonCode(raw.reasonCode)) return null;
    lifecycle = Object.freeze({ voidedAt: raw.voidedAt, reasonCode: raw.reasonCode });
  }
  if (!isPlain(sourceDraft) || !hasKeys(sourceDraft, ['id', 'version']) || !isCustomerId(sourceDraft.id) || !isCount(sourceDraft.version, 1, MAX_EXPECTED_VERSION)) return null;
  if (!isPlain(rawSeller) || !hasKeys(rawSeller, ['legalName', 'storeName', 'postalAddress', 'taxRegistrationId']) || !isPlain(rawAmounts)) return null;
  const subtotal = rawAmounts.subtotalCents;
  if (!isCents(subtotal)) return null;
  const seller = sellerOf(rawSeller);
  const customer = customerOf(v.customer);
  const lines = linesOf(v.lines, subtotal);
  const amounts = amountsOf(rawAmounts, subtotal);
  if (seller === null || customer === null || lines === null || amounts === null) return null;
  return Object.freeze({
    id: invoiceId, number, issuedAt, status: voided ? 'voided' : 'issued', void: lifecycle, sourceDraft: Object.freeze({ id: sourceDraft.id, version: sourceDraft.version }), seller, issuingSettingsVersion, customer, lines, amounts,
  });
}

/**
 * What a settings body SENT, read from the caller's own string: its expected version and its values; null when it is not
 * one the server's planner takes (unreadable, over 8 KiB, not exactly the seven keys, a non-canonical tenant, a version
 * outside 0..2^53-2, a value not already in its normalized form, a tax in neither shape) — so nothing is sent.
 */
function settingsSentOf(body: string): { readonly expectedVersion: number; readonly values: SettingsValues } | null {
  try {
    if (bytesOf(body) > SETTINGS_BODY_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(body);
    if (!isPlain(parsed) || !hasKeys(parsed, ['expectedTenant', 'expectedVersion', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax'])) return null;
    const seller = sellerOf(parsed);
    const tax = taxOf(parsed.tax);
    if (!isCustomerId(parsed.expectedTenant) || !isCount(parsed.expectedVersion, 0, MAX_EXPECTED_VERSION) || seller === null || tax === null) return null;
    return { expectedVersion: parsed.expectedVersion, values: Object.freeze({ ...seller, tax }) };
  } catch {
    return null;
  }
}

/** What an issue body SENT: its expected version; null when the planner would refuse it (as issueBodyOf builds it, any key order). */
function issueSentOf(body: string): { readonly expectedVersion: number } | null {
  try {
    if (bytesOf(body) > ISSUE_BODY_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(body);
    if (!isPlain(parsed) || !hasKeys(parsed, EXPECTED_KEYS)) return null;
    const { expectedTenant, expectedVersion, expectedSettingsVersion, expectedCustomerVersion } = parsed;
    if (!isCustomerId(expectedTenant) || !isCount(expectedVersion, 1, MAX_EXPECTED_VERSION) || !isCount(expectedSettingsVersion, 1, MAX)
      || !isCount(expectedCustomerVersion, 1, MAX)) return null;
    return { expectedVersion };
  } catch {
    return null;
  }
}

/** Whether two settings carry exactly the same values. */
export function sameSettingsValues(a: SettingsValues, b: SettingsValues): boolean {
  return a.legalName === b.legalName && a.storeName === b.storeName && a.postalAddress === b.postalAddress && a.taxRegistrationId === b.taxRegistrationId
    && a.tax.mode === b.tax.mode && (a.tax.mode === 'none' || (b.tax.mode === 'exclusive_rate' && a.tax.rateMilliPercent === b.tax.rateMilliPercent));
}

/**
 * A refusal's `error` word and its shape: `sealed` — exactly `{ error }`, the key's recorded completion — or the chain's
 * own, exactly `{ error, requestId }` (strings); otherwise none.
 */
function refusalOf(body: unknown): { readonly error: string; readonly sealed: boolean } | undefined {
  if (!isPlain(body) || typeof body.error !== 'string') return undefined;
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === 'error') return { error: body.error, sealed: true };
  return hasKeys(body, ['error', 'requestId']) && typeof body.requestId === 'string' ? { error: body.error, sealed: false } : undefined;
}

export interface InvoiceIssuingClient {
  /** The store's issuing settings (owner only), on the session whose CSRF token is `csrf`; a malformed id is `denied`, nothing sent. Never rejects. */
  getSettings(storeId: string, csrf: string, signal?: AbortSignal): Promise<SettingsResult>;
  /** One settings write: `body` exactly as given, under `idempotencyKey`; a body or id the server would refuse is `invalid`, nothing sent. Never rejects. */
  saveSettings(storeId: string, body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<SaveSettingsResult>;
  /** Whether this session may issue at `storeId` now (the draft id names the route only); a malformed id is `denied`, nothing sent. Never rejects. */
  issueEligibility(storeId: string, draftId: string, csrf: string, signal?: AbortSignal): Promise<EligibilityResult>;
  /** The review of issuing `draftId`, whose `expected` must name `tenantId` (the store's, as GET /api/v1/stores answered it). Never rejects. */
  issuePreview(storeId: string, draftId: string, tenantId: string, csrf: string, signal?: AbortSignal): Promise<PreviewResult>;
  /** One issue attempt of `draftId`: `body` exactly as given, under `idempotencyKey`; a body or id the server would refuse is `invalid`, nothing sent. Never rejects. */
  issue(storeId: string, draftId: string, body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<IssueResult>;
  /** One page of the store's issued invoices: page one (`cursor` null) or the page after a `nextCursor` this client decoded. Never rejects. */
  listIssued(storeId: string, cursor: string | null, csrf: string, signal?: AbortSignal): Promise<IssuedPageResult>;
  /** The sourceDraft lookup alone: the issued invoice of `draftId` at `storeId`, or none found. Never rejects. */
  findIssued(storeId: string, draftId: string, csrf: string, signal?: AbortSignal): Promise<FindIssuedResult>;
  /** One issued invoice of `storeId`; a malformed id is `not-found` and nothing is sent. Never rejects. */
  getIssued(storeId: string, invoiceId: string, csrf: string, signal?: AbortSignal): Promise<IssuedResult>;
}

interface Answer { readonly status: number; readonly body: unknown; readonly header: (name: string) => string | null }

export function createInvoiceIssuingClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): InvoiceIssuingClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** The answer's status, bounded JSON body and headers, or null when no answer arrived (network failure, timeout, abort). */
  async function exchange(path: string, init: RequestInit, signal?: AbortSignal): Promise<Answer | null> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const res = await send(path, {
        ...init,
        credentials: 'include',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      let body: unknown;
      if (JSON_TYPE_RE.test(res.headers.get('content-type') ?? '')) {
        const text = await res.text().catch(() => '');
        if (text.length <= MAX_BODY_CHARS) {
          try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
        }
      }
      return { status: res.status, body, header: (name) => res.headers.get(name) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const limited = (answer: Answer): RateLimited =>
    Object.freeze({ kind: 'rate-limited', retryAfterSeconds: retryAfterSeconds(answer.header('retry-after')) });
  const read = (path: string, csrf: string, signal?: AbortSignal): Promise<Answer | null> =>
    exchange(path, { method: 'GET', headers: { Accept: 'application/json', [SESSION_CSRF_HEADER]: csrf } }, signal);
  const shapes = (answer: Answer) => {
    const refused = refusalOf(answer.body);
    return {
      sealed: (word: string): boolean => refused?.error === word && refused.sealed,
      chain: (word: string): boolean => refused?.error === word && !refused.sealed,
    };
  };
  /** The refusals every read shares, each only in the chain's envelope with its one word; null for any other answer. */
  function readRefusal(answer: Answer): ReadRefusal | null {
    const { chain } = shapes(answer);
    if (answer.status === 401 && chain('unauthenticated')) return Object.freeze({ kind: 'signed-out' });
    if (answer.status === 403 && chain('forbidden')) return Object.freeze({ kind: 'denied' });
    if (answer.status === 429 && chain('rate_limited')) return limited(answer);
    return null;
  }
  const UNAVAILABLE = Object.freeze({ kind: 'unavailable' as const });
  /** The refusals both commands share, each only in the chain's envelope; null for any other answer. */
  function chainRefusal(answer: Answer): { readonly kind: 'signed-out' | 'denied' | 'invalid' } | RateLimited | null {
    const { status } = answer;
    const { chain } = shapes(answer);
    if (status === 401 && chain('unauthenticated')) return Object.freeze({ kind: 'signed-out' });
    if (status === 403 && chain('forbidden')) return Object.freeze({ kind: 'denied' });
    if ((status === 400 && chain('invalid_request')) || (status === 413 && chain('content_too_large'))
      || (status === 415 && chain('unsupported_media_type'))) return Object.freeze({ kind: 'invalid' });
    if (status === 429 && chain('rate_limited')) return limited(answer);
    return null;
  }
  /** One command: the caller's exact body with the intent, session and key headers; null when no answer arrived. */
  const command = (method: 'PUT' | 'POST', path: string, body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<Answer | null> =>
    exchange(path, {
      method,
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        [INTENT_HEADER]: '1', [SESSION_CSRF_HEADER]: csrf, 'Idempotency-Key': idempotencyKey,
      },
      body, // the caller's exact string: a retry under the same key must send the same bytes
    }, signal);
  /** app.ts sendRecorded: the replay header is absent, or exactly "true" on a replay; anything else names no answer of this server. */
  const replayOf = (answer: Answer): boolean | null => {
    const replay = answer.header('idempotent-replayed');
    return replay === null ? false : replay === 'true' ? true : null;
  };

  async function getSettings(storeId: string, csrf: string, signal?: AbortSignal): Promise<SettingsResult> {
    if (!isCustomerId(storeId)) return Object.freeze({ kind: 'denied' }); // the server's answer to a store it cannot name
    const answer = await read(issuingSettingsPathOf(storeId), csrf, signal);
    if (answer === null) return UNAVAILABLE;
    if (answer.status === 200) {
      const settings = settingsOf(answer.body, storeId);
      return settings === null ? UNAVAILABLE : Object.freeze({ kind: 'ok', settings });
    }
    if (answer.status === 404 && shapes(answer).chain('not_found')) return Object.freeze({ kind: 'not-found' });
    return readRefusal(answer) ?? UNAVAILABLE;
  }

  async function saveSettings(storeId: string, body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<SaveSettingsResult> {
    const sent = settingsSentOf(body);
    if (!isCustomerId(storeId) || sent === null) return Object.freeze({ kind: 'invalid' }); // nothing is sent
    const answer = await command('PUT', issuingSettingsPathOf(storeId), body, idempotencyKey, csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unknown', responded: false });
    const { status } = answer;
    const { sealed, chain } = shapes(answer);
    if (status === 200) {
      const settings = settingsOf(answer.body, storeId);
      const replayed = replayOf(answer);
      if (settings !== null && settings.configured && settings.version === sent.expectedVersion + 1 && sameSettingsValues(settings, sent.values) && replayed !== null) {
        return Object.freeze({ kind: 'saved', settings, replayed });
      }
      return Object.freeze({ kind: 'unknown', responded: true }); // a 200 this client cannot name: only the key can say
    }
    // The sealed 409 is the key's recorded completion (a version mismatch); the chain's 409 write_conflict (another tenant
    // than expectedTenant), its 404 (a missing, foreign or read-only store) and its 422 were rolled back and recorded nothing.
    if (status === 409 && sealed('write_conflict')) return Object.freeze({ kind: 'conflict' });
    if (status === 409 && chain('write_conflict')) return Object.freeze({ kind: 'tenant-changed' });
    if (status === 409 && chain('request_in_progress')) return Object.freeze({ kind: 'in-progress' });
    if (status === 404 && chain('not_found')) return Object.freeze({ kind: 'not-found' });
    if (status === 422 && chain('idempotency_key_reused')) return Object.freeze({ kind: 'key-reused' });
    if (status === 403 && chain('step_up_required')) return Object.freeze({ kind: 'step-up' }); // before any key: nothing acquired
    return chainRefusal(answer) ?? Object.freeze({ kind: 'unknown', responded: true });
  }

  async function issueEligibility(storeId: string, draftId: string, csrf: string, signal?: AbortSignal): Promise<EligibilityResult> {
    if (!isCustomerId(storeId) || !isCustomerId(draftId)) return Object.freeze({ kind: 'denied' }); // nothing is sent
    const answer = await read(issueEligibilityPathOf(storeId, draftId), csrf, signal);
    if (answer === null) return UNAVAILABLE;
    if (answer.status === 200) {
      const allowed = isPlain(answer.body) && hasKeys(answer.body, ['eligibility']) && answer.body.eligibility === 'allowed';
      return allowed ? Object.freeze({ kind: 'allowed' }) : UNAVAILABLE;
    }
    return readRefusal(answer) ?? UNAVAILABLE;
  }

  async function issuePreview(storeId: string, draftId: string, tenantId: string, csrf: string, signal?: AbortSignal): Promise<PreviewResult> {
    if (!isCustomerId(storeId) || !isCustomerId(draftId)) return Object.freeze({ kind: 'not-found' }); // nothing is sent
    const answer = await read(issuePreviewPathOf(storeId, draftId), csrf, signal);
    if (answer === null) return UNAVAILABLE;
    if (answer.status === 200) {
      const preview = previewOf(answer.body, draftId, tenantId);
      return preview === null ? UNAVAILABLE : Object.freeze({ kind: 'ok', preview });
    }
    // The preview's refusals are the chain's shape (nothing is recorded by a read): one 404 for a missing, foreign or no
    // longer open draft, and three 409s in the database's order (a version that cannot step, no settings, a total too large).
    const { chain } = shapes(answer);
    if (answer.status === 404 && chain('not_found')) return Object.freeze({ kind: 'not-found' });
    if (answer.status === 409 && chain('invalid_state')) return Object.freeze({ kind: 'invalid-state' });
    if (answer.status === 409 && chain('issuing_not_configured')) return Object.freeze({ kind: 'not-configured' });
    if (answer.status === 409 && chain('amount_out_of_range')) return Object.freeze({ kind: 'out-of-range' });
    return readRefusal(answer) ?? UNAVAILABLE;
  }

  async function issue(storeId: string, draftId: string, body: string, idempotencyKey: string, csrf: string, signal?: AbortSignal): Promise<IssueResult> {
    const sent = issueSentOf(body);
    if (!isCustomerId(storeId) || !isCustomerId(draftId) || sent === null) return Object.freeze({ kind: 'invalid' }); // nothing is sent
    const answer = await command('POST', issuePathOf(storeId, draftId), body, idempotencyKey, csrf, signal);
    if (answer === null) return Object.freeze({ kind: 'unknown', responded: false });
    const { status, body: got } = answer;
    const { sealed, chain } = shapes(answer);
    if (status === 201) {
      const replayed = replayOf(answer);
      const invoice = isPlain(got) && hasKeys(got, ['invoice', 'draft']) ? got.invoice : undefined;
      const draft = isPlain(got) ? got.draft : undefined;
      if (isPlain(invoice) && hasKeys(invoice, ['id', 'sourceDraftId', 'status']) && isCustomerId(invoice.id) && invoice.sourceDraftId === draftId && invoice.status === 'issued'
        && isPlain(draft) && hasKeys(draft, ['id', 'version', 'status']) && draft.id === draftId && draft.version === sent.expectedVersion + 1 && draft.status === 'issued'
        && answer.header('location') === issuedInvoicePathOf(storeId, invoice.id) && replayed !== null) {
        return Object.freeze({ kind: 'issued', invoiceId: invoice.id, draftVersion: sent.expectedVersion + 1, replayed });
      }
      return Object.freeze({ kind: 'unknown', responded: true }); // a 201 this client cannot name (or whose Location differs): only the key can say
    }
    // The sealed 409s are the key's recorded completion (replayed under it); the chain's were rolled back and recorded nothing.
    if (status === 409 && sealed('write_conflict')) return Object.freeze({ kind: 'conflict' });
    if (status === 409 && sealed('invalid_state')) return Object.freeze({ kind: 'not-open' });
    if (status === 409 && sealed('issuing_not_configured')) return Object.freeze({ kind: 'not-configured' });
    if (status === 409 && sealed('amount_out_of_range')) return Object.freeze({ kind: 'out-of-range' });
    if (status === 409 && chain('write_conflict')) return Object.freeze({ kind: 'tenant-changed' });
    if (status === 409 && chain('request_in_progress')) return Object.freeze({ kind: 'in-progress' });
    if (status === 404 && chain('not_found')) return Object.freeze({ kind: 'not-found' });
    if (status === 422 && chain('idempotency_key_reused')) return Object.freeze({ kind: 'key-reused' });
    return chainRefusal(answer) ?? Object.freeze({ kind: 'unknown', responded: true });
  }

  async function listIssued(storeId: string, cursor: string | null, csrf: string, signal?: AbortSignal): Promise<IssuedPageResult> {
    if (!isCustomerId(storeId)) return Object.freeze({ kind: 'denied' }); // nothing is sent
    if (cursor !== null && !CURSOR_RE.test(cursor)) return Object.freeze({ kind: 'bad-cursor' });
    const query = `limit=${ISSUED_PAGE_LIMIT}${cursor === null ? '' : `&cursor=${cursor}`}`;
    const answer = await read(`${issuedInvoicesPathOf(storeId)}?${query}`, csrf, signal);
    if (answer === null) return UNAVAILABLE;
    if (answer.status === 200) {
      const page = pageOf(answer.body, ISSUED_PAGE_LIMIT, cursor, null);
      return page === null ? UNAVAILABLE : Object.freeze({ kind: 'ok', ...page });
    }
    // The server's one answer to a cursor it cannot use (unknown, another store's, malformed); without a cursor it decides nothing.
    if (cursor !== null && answer.status === 400 && shapes(answer).chain('invalid_request')) return Object.freeze({ kind: 'bad-cursor' });
    return readRefusal(answer) ?? UNAVAILABLE;
  }

  async function findIssued(storeId: string, draftId: string, csrf: string, signal?: AbortSignal): Promise<FindIssuedResult> {
    if (!isCustomerId(storeId) || !isCustomerId(draftId)) return Object.freeze({ kind: 'denied' }); // nothing is sent
    const answer = await read(`${issuedInvoicesPathOf(storeId)}?sourceDraft=${draftId}`, csrf, signal); // the filter stands alone
    if (answer === null) return UNAVAILABLE;
    if (answer.status === 200) {
      const page = pageOf(answer.body, 1, null, draftId);
      return page === null ? UNAVAILABLE : Object.freeze({ kind: 'ok', invoice: page.invoices[0] ?? null });
    }
    return readRefusal(answer) ?? UNAVAILABLE;
  }

  async function getIssued(storeId: string, invoiceId: string, csrf: string, signal?: AbortSignal): Promise<IssuedResult> {
    if (!isCustomerId(storeId) || !isCustomerId(invoiceId)) return Object.freeze({ kind: 'not-found' }); // nothing is sent
    const answer = await read(issuedInvoicePathOf(storeId, invoiceId), csrf, signal);
    if (answer === null) return UNAVAILABLE;
    if (answer.status === 200) {
      const invoice = invoiceOf(answer.body, invoiceId);
      return invoice === null ? UNAVAILABLE : Object.freeze({ kind: 'ok', invoice });
    }
    if (answer.status === 404 && shapes(answer).chain('not_found')) return Object.freeze({ kind: 'not-found' }); // missing, another store's or tenant's alike
    return readRefusal(answer) ?? UNAVAILABLE;
  }

  return Object.freeze({ getSettings, saveSettings, issueEligibility, issuePreview, issue, listIssued, findIssued, getIssued });
}

/** The shop's one issuing client. */
export const invoiceIssuing: InvoiceIssuingClient = createInvoiceIssuingClient();
