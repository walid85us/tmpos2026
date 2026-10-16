// Phase 4.0 M7b — issuing a saved store invoice draft: the issue command, its eligibility and its preview, and the store's
// issued invoices, listed and read (M7B-INVOICES-ISSUE-P1; docs/phase-4/12 §10, ADR-50; G-IAM, G-ISOLATION, G-PERSIST,
// G-IDEMPOT, G-AUDIT; migration 034, schema tmpos_invoice_issue).
//
// THE FIVE ROUTES, the route table's closed STORE templates (routes.ts), each a session route of the TENANT boundary
// requiring a STORE-scope permission (m5CanonicalPermissions.ts STORE_ROUTE_PERMISSIONS):
//   GET  /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility issue_invoices      — whether an issue would be authorized now
//   GET  /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview     issue_invoices      — the reviewable snapshot and its versions
//   POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue             issue_invoices      — issue the draft (a command, under a key)
//   GET  /api/v1/stores/{storeId}/invoices                              view_issued_invoices — the store's issued invoices, newest number first
//   GET  /api/v1/stores/{storeId}/invoices/{id}                         view_issued_invoices — one issued invoice
// The {storeId} segment is a REQUESTED TARGET, exactly as for the drafts (invoiceDrafts.ts): the tenant authorizer selects
// the actor's own store grant at exactly that store and hands a STORE trusted scope, the only tenant and store anything
// here treats as authority. issue_invoices: the store grant's role at Invoices Approve or above AND Customers View or above
// (the same role), never under read-only; view_issued_invoices: Invoices View and Customers View. store_owner is Full where
// it holds a store grant. Every path id selects a resource; none grants.
//
// THE ISSUE. Request exactly { expectedTenant, expectedVersion, expectedSettingsVersion, expectedCustomerVersion } — the
// "expected" object the preview answered, no other key: expectedTenant a canonical lowercase uuid (a PRECONDITION: another
// tenant is the unsealed 409 write_conflict, rolled back); expectedVersion the draft's version, 1..2^53 - 2;
// expectedSettingsVersion and expectedCustomerVersion the reviewed settings' and customer's versions, 1..2^53 - 1. The
// request carries no total, seller, customer or authority: the database derives and re-checks all of them. The path's
// draft id must match the outbox's aggregate-id shape, as the edit's and the discard's. The body is bounded at 1 KiB. An
// UPDATE of the draft (store.invoice.issue, aggregate invoice_draft, context scope store) that opts into the sealed pair
// issuing_not_configured / amount_out_of_range (commandTransaction.ts `issuingRefusals`); its change set carries the
// preconditions and the runtime's new invoice id. In ONE transaction (postgresTransactionalStore.ts): the lease fence; the
// store-scope revalidation (issue_invoices decided again); the mutator's one call into
// tmpos_invoice_issue.m7b_invoice_issue (postgresInvoiceIssuing.ts), which re-derives the caller, locks in doc 12 §10.7's
// order and decides, in order: authority (the 503) → expectedTenant (409, unsealed) → a missing or another store's draft
// (404, rolled back) → not open (sealed 409 invalid_state) → no settings (sealed 409 issuing_not_configured) → the draft's,
// the settings' and the customer's versions (sealed 409 write_conflict) → a total or the store's number series out of range
// (sealed 409 amount_out_of_range) → the number, the immutable header and lines, the draft at version + 1, 'issued'; one
// audit record naming the draft, the issued invoice and the customer at store scope; NO outbox event; the sealed 201;
// COMMIT. 201 { "invoice": { "id", "sourceDraftId", "status": "issued" }, "draft": { "id", "version": expectedVersion + 1,
// "status": "issued" } } with Location /api/v1/stores/{storeId}/invoices/{invoiceId}. The number is NOT in the 201: the
// kernel seals the response before the transaction allocates it (§10.4); it is read from the invoice the Location names.
// A sealed refusal commits its completion and nothing else; a rolled-back one commits nothing and leaves the lease to
// expire; a lost COMMIT answer is the bounded 503 (outcome unknown, the lease kept), as for the drafts' commands.
//
// THE ELIGIBILITY. The discard eligibility's form (invoiceDrafts.ts idEligibilityRoute, restated: that builder is
// private): decided by the issue's own requirement object, no query, the scope at the path's store, a canonical id
// segment, then 200 { "eligibility": "allowed" }. Target-blind: it reads no draft, acquires no lease, reserves no number.
//
// THE PREVIEW. One STABLE definer read on one snapshot (no lock, lease or number): the draft, its lines and subtotal, its
// customer's id, name and version, the store's issuing settings and their version, and the database's tax and total — all
// validated here in full: lines at positions 1..n, each total exactly quantity x unit price and the subtotal their sum
// (BigInt), the tax recomputed by invoiceTaxOf and equal to the database's, total = subtotal + tax within 2^53 - 1, the tax
// shape by mode; any mismatch is the bounded 503, never served. 200 { "preview": { "draft", "customer", "issuingSettings",
// "amounts", "expected": { "expectedTenant" (the trusted tenant), "expectedVersion", "expectedSettingsVersion",
// "expectedCustomerVersion" } } } — `expected` is exactly the issue body this preview supports. A missing, foreign or
// non-open draft is the 404; a draft at version 2^53 - 1, which no issue can move, 409 invalid_state; a store without
// settings 409 issuing_not_configured; a total above 2^53 - 1 or an exhausted number series 409 amount_out_of_range — 034's
// order, each UNSEALED (a read).
//
// THE ISSUED READS. List: query `limit` (1-50, default 20) and `cursor`, each at most once, or `sourceDraft=<uuid>` alone
// (the recovery filter: at most one item); nothing else, the whole query at most 128 characters. Newest number first. The
// cursor is the unpadded base64url of a tag byte (0x04) and the last served invoice's 16 id bytes, its canonical spelling
// only; the routine re-reads that anchor inside the trusted tenant and store, and an unknown or foreign one is the same
// 400 as a malformed one. An unknown, other-store, open or discarded source draft is the same empty page. Answer {
// "invoices": [ { "id", "number", "sourceDraftId", "customerId", "customerName", "currency", "totalCents", "issuedAt",
// "status": "issued", "snapshotVersion": 1 } ], "nextCursor" }, nextCursor only behind a full page. Detail: { "invoice": {
// "id", "number", "status": "issued", "snapshotVersion": 1, "issuedAt", "sourceDraft": { "id", "version" }, "seller": {
// "legalName", "storeName", "postalAddress", "taxRegistrationId" }, "issuingSettingsVersion", "customer": { "id", "name",
// "version" }, "lines", "amounts" } }; a missing and a foreign id are the same 404. Every row is validated (the amount
// equations, the tax by mode, snapshot version 1, ordering, no duplicates); no read returns the issuing actor (the port has
// no such column), a customer phone or email, or anything labelled due, paid, unpaid or balance. issuedAt is the
// database's UTC time with microseconds. Every read is session-bound and hands its routine the session key; none writes
// an audit record. Chain-wide headers mark every answer no-store.
//
// AMOUNTS (§10.8). tax = floor((S x R + 50,000) / 100,000) for a subtotal S in cents and a rate R in thousandths of a
// percent, in BigInt only (S x R can pass 2^63); total = S + tax, at most 2^53 - 1. Under 'none' there is no rate and no
// tax and total = S. The rate mode's line is labelled "Tax"; the no-tax statement is "No tax calculated" (§10.1 D-ISS-5).
// Total is not an amount due, a balance or a payment status (snapshot contract version 1, §10.5).
//
// DA-118 stays open: a runtime-role holder with a live store session key can call 034's issue routine directly and issue
// without this route's audit record, idempotency completion or HTTP checks (doc 12 §10.10).
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but its context and writes nothing; the reads' port is handed in by the composition root.
import { Buffer } from 'node:buffer';
import type { Response } from 'express';
import type { CommandContract } from './commandTransaction.js';
import { isStorableName } from './customerDirectory.js';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { INVOICE_DRAFT_CURRENCY, INVOICE_DRAFT_MAX_LINES, INVOICE_DRAFT_PATH, isDraftCreatedAt, normalizeDraftDescription } from './invoiceDrafts.js';
import { ISSUING_TAX_RATE_MAX, sellerValuesOf, taxBody, taxSettingOf } from './issuingSettings.js';
import type { SellerValues, TaxSetting } from './issuingSettings.js';
import { UUID_RE as AGGREGATE_ID_RE } from './outbox.js';
import type { TrustedScope } from './principals.js';
import {
  COMMAND_REQUEST_INVALID, EnforcementSetupError, PATH_ID_SEGMENT, STORE_DIRECTORY_PATH, STORE_SEGMENT, pathIdBeforeSuffixOf, pathIdOf, storeTargetOf,
} from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteContext, RouteDefinition, RouteHandler } from './routes.js';

/** The issue command's last segment, after the draft id. */
const ISSUE_SUFFIX = '/issue';
const ISSUE_ELIGIBILITY_SUFFIX = '/issue-eligibility';
const ISSUE_PREVIEW_SUFFIX = '/issue-preview';
/** The five templates (routes.ts STORE_TEMPLATED_ROUTES). */
export const INVOICE_ISSUE_PATH = `${INVOICE_DRAFT_PATH}${ISSUE_SUFFIX}`;
export const INVOICE_ISSUE_ELIGIBILITY_PATH = `${INVOICE_DRAFT_PATH}${ISSUE_ELIGIBILITY_SUFFIX}`;
export const INVOICE_ISSUE_PREVIEW_PATH = `${INVOICE_DRAFT_PATH}${ISSUE_PREVIEW_SUFFIX}`;
export const ISSUED_INVOICES_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoices`;
export const ISSUED_INVOICE_PATH = `${ISSUED_INVOICES_PATH}${PATH_ID_SEGMENT}`;
/** The store route permissions (m5CanonicalPermissions.ts): the issue, its eligibility and its preview share the first. */
export const INVOICE_ISSUE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'issue_invoices' });
export const ISSUED_INVOICE_VIEW_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'view_issued_invoices' });

/** The issue's body bound (§10.3): 1 KiB — four keys, a uuid and three versions fit well inside it. */
export const INVOICE_ISSUE_MAX_BODY_BYTES = 1024;
export const ISSUED_INVOICE_DEFAULT_LIMIT = 20;
export const ISSUED_INVOICE_MAX_LIMIT = 50;
export const ISSUED_INVOICE_STATUS = 'issued';
/** Every issued invoice's snapshot contract version (§10.5). */
export const ISSUED_INVOICE_SNAPSHOT_VERSION = 1;
/** The fixed display words (§10.1 D-ISS-5). */
export const INVOICE_TAX_LABEL = 'Tax';
export const INVOICE_NO_TAX_DESCRIPTION = 'No tax calculated';

const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
const MAX = BigInt(MAX_AMOUNT);
/** A canonical lowercase uuid of any version: 034's columns accept every uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
/** A safe integer at or above `min`, never -0. */
const isWhole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && !Object.is(v, -0);
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

// ---------------------------------------------------------------------------
// The amounts
// ---------------------------------------------------------------------------

/**
 * The tax on a subtotal, in BigInt only: (S x R + 50,000) / 100,000, which for non-negative values truncates exactly to the
 * floor (§10.8) — half a cent rounds up. Throws a RangeError for a negative subtotal or a rate outside 0..100000.
 */
export function invoiceTaxOf(subtotalCents: bigint, rateMilliPercent: number): bigint {
  if (typeof subtotalCents !== 'bigint' || subtotalCents < 0n || !isWhole(rateMilliPercent, 0) || rateMilliPercent > ISSUING_TAX_RATE_MAX) {
    throw new RangeError('invoice tax input invalid');
  }
  return (subtotalCents * BigInt(rateMilliPercent) + 50_000n) / 100_000n;
}

/** The tax part of the amounts (§10.4). */
export type InvoiceTaxAmount =
  | Readonly<{ mode: 'exclusive_rate'; label: string; rateMilliPercent: number; amountCents: number }>
  | Readonly<{ mode: 'none'; description: string }>;

/** An issued or previewed invoice's amounts (§10.4): every amount a safe integer. */
export interface InvoiceAmounts {
  readonly currency: string;
  readonly subtotalCents: number;
  readonly tax: InvoiceTaxAmount;
  readonly totalCents: number;
}

const NO_TAX_AMOUNT: InvoiceTaxAmount = Object.freeze({ mode: 'none', description: INVOICE_NO_TAX_DESCRIPTION });

/**
 * The amounts for a subtotal under a tax setting, or 'amount_out_of_range' when the total would pass 2^53 - 1. Throws a
 * RangeError for a subtotal that is not a safe integer >= 0.
 */
export function issueAmountsOf(subtotalCents: number, tax: TaxSetting): InvoiceAmounts | 'amount_out_of_range' {
  if (!isWhole(subtotalCents, 0)) throw new RangeError('invoice subtotal invalid');
  if (tax.mode === 'none') return Object.freeze({ currency: INVOICE_DRAFT_CURRENCY, subtotalCents, tax: NO_TAX_AMOUNT, totalCents: subtotalCents });
  const amount = invoiceTaxOf(BigInt(subtotalCents), tax.rateMilliPercent);
  const total = BigInt(subtotalCents) + amount;
  if (total > MAX) return 'amount_out_of_range';
  return Object.freeze({
    currency: INVOICE_DRAFT_CURRENCY,
    subtotalCents,
    tax: Object.freeze({ mode: 'exclusive_rate', label: INVOICE_TAX_LABEL, rateMilliPercent: tax.rateMilliPercent, amountCents: Number(amount) }),
    totalCents: Number(total), // exact: at most 2^53 - 1
  });
}

/** Whether the database's tax and total are exactly the ones `amounts` derives: no tax under 'none', the same amount otherwise. */
function amountsAgree(amounts: InvoiceAmounts, taxCents: unknown, totalCents: unknown): boolean {
  if (totalCents !== amounts.totalCents) return false;
  return amounts.tax.mode === 'none' ? taxCents === null : taxCents === amounts.tax.amountCents;
}

/** Amounts as their JSON body. */
const amountsBody = (a: InvoiceAmounts): Record<string, unknown> => ({
  currency: a.currency,
  subtotalCents: a.subtotalCents,
  tax: a.tax.mode === 'none' ? { mode: 'none', description: a.tax.description }
    : { mode: 'exclusive_rate', label: a.tax.label, rateMilliPercent: a.tax.rateMilliPercent, amountCents: a.tax.amountCents },
  totalCents: a.totalCents,
});

/** One line as a preview or an issued invoice shows it. */
export interface InvoiceLine {
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

const LINE_KEYS: readonly string[] = ['position', 'description', 'quantity', 'unitPriceCents', 'lineTotalCents'];
const isAmount = (v: unknown, min: number): v is number => isWhole(v, min) && v <= MAX_AMOUNT;

/**
 * `raw` as 1-50 validated lines whose totals sum exactly to `subtotalCents`, or null: positions 1..n in order, each
 * description servable, each total exactly quantity x unit price (BigInt), every amount within 2^53 - 1.
 */
export function invoiceLinesOf(raw: unknown, subtotalCents: number): readonly InvoiceLine[] | null {
  if (!Array.isArray(raw)) return null;
  const count = raw.length; // read once: the bound checked is the bound the loop runs to
  if (count < 1 || count > INVOICE_DRAFT_MAX_LINES) return null;
  const out: InvoiceLine[] = [];
  let sum = 0n;
  // inv: out holds a validated copy of each line below i, at positions 1..i, and sum their totals; term: i rises to count.
  for (let i = 0; i < count; i++) {
    const line: unknown = raw[i];
    if (!isPlain(line) || !hasExactly(line, LINE_KEYS)) return null;
    const { position, description, quantity, unitPriceCents, lineTotalCents } = line;
    if (position !== i + 1 || typeof description !== 'string' || normalizeDraftDescription(description) !== description) return null;
    if (!isAmount(quantity, 1) || !isAmount(unitPriceCents, 0) || !isAmount(lineTotalCents, 0)
      || BigInt(quantity) * BigInt(unitPriceCents) !== BigInt(lineTotalCents)) return null;
    sum += BigInt(lineTotalCents);
    out.push(Object.freeze({ position, description, quantity, unitPriceCents, lineTotalCents }));
  }
  return sum === BigInt(subtotalCents) ? Object.freeze(out) : null;
}

const linesBody = (lines: readonly InvoiceLine[]): Record<string, unknown>[] => lines.map((l) => ({
  position: l.position, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents,
}));

// ---------------------------------------------------------------------------
// The issue: its contract, its planner and its route
// ---------------------------------------------------------------------------

const ID_FIELD = Object.freeze({ type: 'string', maxLength: 36 } as const);
const VERSION_FIELD = Object.freeze({ type: 'integer', min: 1, max: MAX_AMOUNT } as const);

/**
 * The issue: an update of the draft that opts into the sealed pair issuing_not_configured / amount_out_of_range
 * (commandTransaction.ts `issuingRefusals`, update mode only), and enqueues NO event (§10.1 D-ISS-1). Its change set
 * carries the expected tenant, the reviewed settings' and customer's versions and the runtime's new invoice id.
 */
export const INVOICE_ISSUE_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice.issue',
  mode: 'update',
  aggregateType: 'invoice_draft',
  contextScope: 'store',
  issuingRefusals: true,
  changes: Object.freeze({ expectedTenant: ID_FIELD, expectedSettingsVersion: VERSION_FIELD, expectedCustomerVersion: VERSION_FIELD, invoiceId: ID_FIELD }),
  events: Object.freeze([]),
});

const ISSUE_BODY_KEYS: readonly string[] = ['expectedTenant', 'expectedVersion', 'expectedSettingsVersion', 'expectedCustomerVersion'];

/**
 * The issue's plan from its context alone, or COMMAND_REQUEST_INVALID (header: THE ISSUE): the path's draft, the
 * preconditions, the runtime's new invoice id, no event, and the sealed 201 with its Location — built from the plan alone,
 * so it is deterministic and sealed.
 */
export function planInvoiceIssue(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  // As the discard: the path's draft id (read by app.ts before the route's own '/issue' suffix) in the outbox's aggregate-id
  // shape, and the path's store, which app.ts proved is the trusted scope's.
  const draftId = ctx.targetId;
  const storeId = ctx.storeId;
  if (typeof draftId !== 'string' || !AGGREGATE_ID_RE.test(draftId) || !isUuid(storeId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, ISSUE_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, expectedVersion, expectedSettingsVersion, expectedCustomerVersion } = body;
  if (!isUuid(expectedTenant)) return COMMAND_REQUEST_INVALID;
  // 1..2^53 - 2, as the discard's: expectedVersion + 1 is still exact and within the column's bound.
  if (!isWhole(expectedVersion, 1) || expectedVersion > MAX_AMOUNT - 1) return COMMAND_REQUEST_INVALID;
  // 1..2^53 - 1: a reviewed version is never moved by this command, only compared.
  if (!isWhole(expectedSettingsVersion, 1) || !isWhole(expectedCustomerVersion, 1)) return COMMAND_REQUEST_INVALID;
  const invoiceId = ctx.newAggregateId;
  return {
    aggregateId: draftId,
    expectedVersion,
    changes: { expectedTenant, expectedSettingsVersion, expectedCustomerVersion, invoiceId },
    events: [],
    response: {
      status: 201,
      body: {
        invoice: { id: invoiceId, sourceDraftId: draftId, status: ISSUED_INVOICE_STATUS },
        draft: { id: draftId, version: expectedVersion + 1, status: ISSUED_INVOICE_STATUS },
      },
      headers: { location: `${STORE_DIRECTORY_PATH}/${storeId}/invoices/${invoiceId}` },
    },
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const ISSUE_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_ISSUE_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_ISSUE_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_ISSUE_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // As the drafts' commands: a resolved actor and store grant; no fresh authentication (§10.2); the store binds the
  // presenting session.
  trustedContext: 'required',
  recentAuth: 'none',
  command: Object.freeze({ contract: INVOICE_ISSUE_CONTRACT, plan: planInvoiceIssue }),
};

/** The issue route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_ISSUE_ROUTE: RouteDefinition = Object.freeze(ISSUE_ROUTE);

// ---------------------------------------------------------------------------
// The reads: their port, the answers' validation, the cursor and the query
// ---------------------------------------------------------------------------

/** A validated preview: the reviewed draft, customer and settings, and the amounts they derive. */
export interface InvoiceIssuePreview {
  readonly draft: Readonly<{ id: string; version: number; subtotalCents: number; lines: readonly InvoiceLine[] }>;
  readonly customer: Readonly<{ id: string; name: string; version: number }>;
  readonly issuingSettings: SellerValues & Readonly<{ version: number; tax: TaxSetting }>;
  readonly amounts: InvoiceAmounts;
}

/** One issued invoice as the list shows it. */
export interface IssuedInvoiceSummary {
  readonly id: string;
  readonly number: number;
  readonly sourceDraftId: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly currency: string;
  readonly totalCents: number;
  readonly issuedAt: string;
}

/** One issued invoice as the detail shows it. */
export interface IssuedInvoice {
  readonly id: string;
  readonly number: number;
  readonly issuedAt: string;
  readonly sourceDraft: Readonly<{ id: string; version: number }>;
  readonly seller: SellerValues;
  readonly issuingSettingsVersion: number;
  readonly customer: Readonly<{ id: string; name: string; version: number }>;
  readonly lines: readonly InvoiceLine[];
  readonly amounts: InvoiceAmounts;
}

/** A list request, validated: the anchor a continuation names, the source-draft filter (each or null) and the page size. */
export interface IssuedInvoiceListQuery {
  readonly after: string | null;
  readonly sourceDraft: string | null;
  readonly limit: number;
}

/**
 * The port to migration 034's three session-bound issuing reads, each handed the trusted STORE scope (its tenant and store
 * are the routine's expected ones), the presenting session's key (a SQL parameter it never logs, echoes or stores) and the
 * request's validated values. Answers are untrusted input, expected to be
 *   preview: { outcome: 'preview', preview: { draft: { id, version, subtotalCents, lines }, customer: { id, name, version },
 *            issuingSettings: { version, legalName, storeName, postalAddress, taxRegistrationId, tax }, currency, taxCents
 *            (null under 'none'), totalCents } } | { outcome: 'denied' | 'not_found' | 'invalid_state' | 'issuing_not_configured' | 'amount_out_of_range' };
 *   page:    { outcome: 'page', invoices: (IssuedInvoiceSummary & { snapshotVersion })[], hasMore } | { outcome: 'denied' | 'cursor_unknown' };
 *   invoice: { outcome: 'invoice', invoice: { id, number, snapshotVersion, issuedAt, sourceDraft, seller, issuingSettingsVersion,
 *            customer, currency, subtotalCents, tax, taxCents, totalCents, lines } } | { outcome: 'denied' | 'not_found' }.
 * A throw is an outage.
 */
export interface InvoiceIssueReadPort {
  preview(scope: TrustedScope, sessionKey: string, draftId: string, signal: AbortSignal): unknown;
  page(scope: TrustedScope, sessionKey: string, query: IssuedInvoiceListQuery, signal: AbortSignal): unknown;
  invoice(scope: TrustedScope, sessionKey: string, invoiceId: string, signal: AbortSignal): unknown;
}

/** What the three read routes are built from. */
export interface InvoiceIssuePorts {
  readonly invoiceIssuing: InvoiceIssueReadPort;
}

const PREVIEW_KEYS: readonly string[] = ['draft', 'customer', 'issuingSettings', 'currency', 'taxCents', 'totalCents'];
const PREVIEW_DRAFT_KEYS: readonly string[] = ['id', 'version', 'subtotalCents', 'lines'];
const CUSTOMER_KEYS: readonly string[] = ['id', 'name', 'version'];
const PREVIEW_SETTINGS_KEYS: readonly string[] = ['version', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax'];
const SELLER_KEYS: readonly string[] = ['legalName', 'storeName', 'postalAddress', 'taxRegistrationId'];
const REFUSAL_WORDS: ReadonlySet<string> = new Set(['denied', 'not_found', 'invalid_state', 'issuing_not_configured', 'amount_out_of_range']);

/** A customer as a snapshot names it, or null: a uuid, a name the directory would serve, a version >= 1. */
function customerOf(raw: unknown): Readonly<{ id: string; name: string; version: number }> | null {
  if (!isPlain(raw) || !hasExactly(raw, CUSTOMER_KEYS)) return null;
  const { id, name, version } = raw;
  return isUuid(id) && isStorableName(name) && isWhole(version, 1) ? Object.freeze({ id, name, version }) : null;
}

type PreviewAnswer = InvoiceIssuePreview | 'denied' | 'not_found' | 'invalid_state' | 'issuing_not_configured' | 'amount_out_of_range';

/** The port's preview as a validated preview or one of its five refusal words — or null for anything out of shape. Never throws. */
export function invoiceIssuePreviewOf(raw: unknown, draftId: string): PreviewAnswer | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (typeof outcome === 'string' && REFUSAL_WORDS.has(outcome)) return hasExactly(raw, ['outcome']) ? outcome as PreviewAnswer : null;
    if (outcome !== 'preview' || !hasExactly(raw, ['outcome', 'preview'])) return null;
    const preview: unknown = raw.preview;
    if (!isPlain(preview) || !hasExactly(preview, PREVIEW_KEYS) || preview.currency !== INVOICE_DRAFT_CURRENCY) return null;
    const { draft, customer: rawCustomer, issuingSettings: settings, taxCents, totalCents } = preview;
    if (!isPlain(draft) || !hasExactly(draft, PREVIEW_DRAFT_KEYS) || !isPlain(settings) || !hasExactly(settings, PREVIEW_SETTINGS_KEYS)) return null;
    const { id, version, subtotalCents } = draft;
    if (id !== draftId || !isUuid(id) || !isWhole(version, 1) || !isAmount(subtotalCents, 0)) return null;
    const lines = invoiceLinesOf(draft.lines, subtotalCents);
    const customer = customerOf(rawCustomer);
    const seller = sellerValuesOf(settings);
    const tax = taxSettingOf(settings.tax);
    const settingsVersion = settings.version;
    if (lines === null || customer === null || seller === null || tax === null || !isWhole(settingsVersion, 1)) return null;
    const amounts = issueAmountsOf(subtotalCents, tax);
    // The database decided the preview admits a total: one the runtime would refuse, or another tax or total, is a fault.
    if (amounts === 'amount_out_of_range' || !amountsAgree(amounts, taxCents, totalCents)) return null;
    return Object.freeze({
      draft: Object.freeze({ id, version, subtotalCents, lines }),
      customer,
      issuingSettings: Object.freeze({ ...seller, version: settingsVersion, tax }),
      amounts,
    });
  } catch {
    return null; // a throwing getter or proxy trap is never a preview
  }
}

/** 17 bytes — a tag byte and a 16-byte invoice id — as unpadded base64url. */
const CURSOR_RE = /^[A-Za-z0-9_-]{23}$/;
/** The issued list's continuation tag: distinct from the drafts' (0x01) and the customers' (0x02, 0x03). */
const CURSOR_TAG = 0x04;
const QUERY_PAIR_RE = /^(limit|cursor|sourceDraft)=(.*)$/s;
const LIMIT_RE = /^[1-9][0-9]?$/;
/** One bound on the whole raw query: two keys, a two-digit limit and a 23-character cursor, or one uuid, fit well inside it. */
const MAX_QUERY_LENGTH = 128;

const idBytesOf = (id: string): Buffer => Buffer.from(id.replace(/-/g, ''), 'hex');
function idOfBytes(bytes: Buffer): string | null {
  const hex = bytes.toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(id) ? id : null;
}

/** The opaque continuation for a page that ends at `invoiceId`. */
export function encodeIssuedInvoiceCursor(invoiceId: string): string {
  return Buffer.concat([Buffer.from([CURSOR_TAG]), idBytesOf(invoiceId)]).toString('base64url');
}

/** The invoice id a continuation names, or null unless it is exactly the canonical spelling of one. */
export function decodeIssuedInvoiceCursor(cursor: string): string | null {
  if (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)) return null;
  const bytes = Buffer.from(cursor, 'base64url');
  // Canonical only (invoiceDrafts.ts): a re-encoding that differs is a second spelling of the same bytes, refused.
  if (bytes.length !== 17 || bytes[0] !== CURSOR_TAG || bytes.toString('base64url') !== cursor) return null;
  return idOfBytes(bytes.subarray(1));
}

/** The request target's query as a validated list query, or null for anything the contract refuses (header: THE ISSUED READS). */
export function parseIssuedInvoiceListQuery(target: string): IssuedInvoiceListQuery | null {
  const at = typeof target === 'string' ? target.indexOf('?') : -1;
  if (at < 0) return Object.freeze({ after: null, sourceDraft: null, limit: ISSUED_INVOICE_DEFAULT_LIMIT });
  const raw = target.slice(at + 1);
  if (raw.length > MAX_QUERY_LENGTH) return null;
  let after: string | null = null;
  let sourceDraft: string | null = null;
  let limit: number | null = null;
  const seen = new Set<string>();
  // inv: every pair before this one matched the contract once per key; term: the pairs are finite (at most 128 characters).
  for (const pair of raw.split('&')) {
    const match = QUERY_PAIR_RE.exec(pair);
    if (match === null || seen.has(match[1])) return null;
    seen.add(match[1]);
    if (match[1] === 'limit') {
      if (!LIMIT_RE.test(match[2])) return null;
      limit = Number(match[2]);
      if (limit > ISSUED_INVOICE_MAX_LIMIT) return null;
    } else if (match[1] === 'cursor') {
      after = decodeIssuedInvoiceCursor(match[2]);
      if (after === null) return null;
    } else {
      if (!isUuid(match[2])) return null;
      sourceDraft = match[2];
    }
  }
  // The recovery filter stands alone: at most one item, so no page size and no continuation beside it.
  if (sourceDraft !== null) return seen.size === 1 ? Object.freeze({ after: null, sourceDraft, limit: 1 }) : null;
  return Object.freeze({ after, sourceDraft: null, limit: limit ?? ISSUED_INVOICE_DEFAULT_LIMIT });
}

const SUMMARY_KEYS: readonly string[] = ['id', 'number', 'sourceDraftId', 'customerId', 'customerName', 'currency', 'totalCents', 'issuedAt', 'snapshotVersion'];
const PAGE_KEYS: readonly string[] = ['outcome', 'invoices', 'hasMore'];

type PageAnswer = { readonly invoices: readonly IssuedInvoiceSummary[]; readonly hasMore: boolean } | 'denied' | 'cursor_unknown';

/** The port's page as a validated page, 'denied', 'cursor_unknown' — or null for anything out of shape. Never throws. */
export function issuedInvoicePageOf(raw: unknown, query: IssuedInvoiceListQuery): PageAnswer | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied') return hasExactly(raw, ['outcome']) ? 'denied' : null;
    if (outcome === 'cursor_unknown') return hasExactly(raw, ['outcome']) && query.after !== null ? 'cursor_unknown' : null;
    if (outcome !== 'page' || !hasExactly(raw, PAGE_KEYS)) return null;
    const { invoices, hasMore } = raw;
    if (!Array.isArray(invoices) || typeof hasMore !== 'boolean') return null;
    const count = invoices.length; // read once: the bound checked is the bound the loop runs to
    if (count > query.limit) return null;
    // A next page exists only behind a full one, and never beside the recovery filter.
    if (hasMore && (count !== query.limit || query.sourceDraft !== null)) return null;
    const seen = new Set<string>();
    const sources = new Set<string>();
    const out: IssuedInvoiceSummary[] = [];
    // inv: out holds a validated copy of each entry below i, strictly descending by number, seen their ids and sources their
    // source drafts (one invoice per draft, forever); term: i rises to count.
    for (let i = 0; i < count; i++) {
      const entry: unknown = invoices[i];
      if (!isPlain(entry) || !hasExactly(entry, SUMMARY_KEYS)) return null;
      const { id, number, sourceDraftId, customerId, customerName, currency, totalCents, issuedAt, snapshotVersion } = entry;
      if (!isUuid(id) || seen.has(id) || id === query.after || !isAmount(number, 1) || !isUuid(sourceDraftId) || sources.has(sourceDraftId) || !isUuid(customerId)) return null;
      if (query.sourceDraft !== null && sourceDraftId !== query.sourceDraft) return null;
      if (!isStorableName(customerName) || currency !== INVOICE_DRAFT_CURRENCY || !isAmount(totalCents, 0) || !isDraftCreatedAt(issuedAt)
        || snapshotVersion !== ISSUED_INVOICE_SNAPSHOT_VERSION) return null;
      const before = out[out.length - 1];
      if (before !== undefined && before.number <= number) return null; // newest number first, no number twice
      seen.add(id);
      sources.add(sourceDraftId);
      out.push(Object.freeze({ id, number, sourceDraftId, customerId, customerName, currency, totalCents, issuedAt }));
    }
    return Object.freeze({ invoices: Object.freeze(out), hasMore });
  } catch {
    return null; // a throwing getter or proxy trap is never a page
  }
}

const INVOICE_KEYS: readonly string[] = ['id', 'number', 'snapshotVersion', 'issuedAt', 'sourceDraft', 'seller', 'issuingSettingsVersion', 'customer',
  'currency', 'subtotalCents', 'tax', 'taxCents', 'totalCents', 'lines'];

/**
 * The port's answer as a validated issued invoice, 'not_found' or 'denied' — or null for anything out of shape: the invoice
 * asked for, snapshot version 1, USD, the lines and amounts exactly as THE PREVIEW requires, the tax by mode. Never throws.
 */
export function issuedInvoiceOf(raw: unknown, invoiceId: string): IssuedInvoice | 'not_found' | 'denied' | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found') return hasExactly(raw, ['outcome']) ? outcome : null;
    if (outcome !== 'invoice' || !hasExactly(raw, ['outcome', 'invoice'])) return null;
    const invoice: unknown = raw.invoice;
    if (!isPlain(invoice) || !hasExactly(invoice, INVOICE_KEYS)) return null;
    const { id, number, snapshotVersion, issuedAt, sourceDraft, seller: rawSeller, issuingSettingsVersion, currency, subtotalCents, taxCents, totalCents } = invoice;
    if (id !== invoiceId || !isUuid(id) || !isAmount(number, 1) || snapshotVersion !== ISSUED_INVOICE_SNAPSHOT_VERSION || !isDraftCreatedAt(issuedAt)) return null;
    if (!isPlain(sourceDraft) || !hasExactly(sourceDraft, ['id', 'version'])) return null;
    const { id: draftId, version: draftVersion } = sourceDraft;
    // The source draft's reviewed version: one the issue could step, so at most 2^53 - 2.
    if (!isUuid(draftId) || !isWhole(draftVersion, 1) || draftVersion > MAX_AMOUNT - 1) return null;
    if (!isPlain(rawSeller) || !hasExactly(rawSeller, SELLER_KEYS) || !isWhole(issuingSettingsVersion, 1) || currency !== INVOICE_DRAFT_CURRENCY
      || !isAmount(subtotalCents, 0)) return null;
    const seller = sellerValuesOf(rawSeller);
    const customer = customerOf(invoice.customer);
    const tax = taxSettingOf(invoice.tax);
    const lines = invoiceLinesOf(invoice.lines, subtotalCents);
    if (seller === null || customer === null || tax === null || lines === null) return null;
    const amounts = issueAmountsOf(subtotalCents, tax);
    if (amounts === 'amount_out_of_range' || !amountsAgree(amounts, taxCents, totalCents)) return null;
    return Object.freeze({
      id, number, issuedAt, sourceDraft: Object.freeze({ id: draftId, version: draftVersion }), seller, issuingSettingsVersion, customer, lines, amounts,
    });
  } catch {
    return null; // a throwing getter or proxy trap is never an invoice
  }
}

// ---------------------------------------------------------------------------
// The four read routes
// ---------------------------------------------------------------------------

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The trusted STORE scope and session key a read needs, or null (invoiceDrafts.ts readerOf, restated: it is private). */
function readerOf(req: { path?: unknown }, ctx: RouteContext): { scope: TrustedScope; sessionKey: string } | null {
  const scope = ctx.trusted;
  if (scope === null || scope.scope !== 'store' || scope.tenant === null || scope.store === null) return null;
  if (storeTargetOf(typeof req.path === 'string' ? req.path : '') !== scope.store || ctx.sessionKey === null) return null;
  return { scope, sessionKey: ctx.sessionKey };
}

/** The read routes' shared declaration: a session read under a resolved store scope, bound to the presenting session. */
function readRoute(path: string, authorization: AuthorizationRequirement, handler: RouteHandler): RouteDefinition {
  const route: RouteDefinition = {
    method: 'GET',
    path,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization } as const),
    body: Object.freeze({ kind: 'none' } as const),
    idempotency: 'none',
    trustedContext: 'required',
    recentAuth: 'none',
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

/** The port and deadline a read route is built from; refused at construction without either. */
function readerSetup(ports: InvoiceIssuePorts, options: { deadlineMs?: number }): { reader: InvoiceIssueReadPort; deadlineMs: number } {
  const reader = ports?.invoiceIssuing;
  if (typeof reader?.preview !== 'function' || typeof reader?.page !== 'function' || typeof reader?.invoice !== 'function') {
    throw new EnforcementSetupError('route_handler_invalid');
  }
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) throw new EnforcementSetupError('port_deadline_invalid');
  return { reader, deadlineMs };
}

const hasQuery = (req: { url?: unknown }): boolean => (typeof req.url === 'string' ? req.url : '').includes('?');

/**
 * Whether the session's actor may issue a draft at the path's store now (header: THE ELIGIBILITY), decided under
 * INVOICE_ISSUE_REQUIREMENT — the issue's own requirement object. Target-blind: the same answer for every well-formed id.
 */
export function createInvoiceIssueEligibilityRoute(): RouteDefinition {
  return readRoute(INVOICE_ISSUE_ELIGIBILITY_PATH, INVOICE_ISSUE_REQUIREMENT, (req, res, ctx) => {
    // The reopen route's order: the query, the scope, then the id segment (one canonical lowercase uuid).
    if (hasQuery(req)) return refuse(res, ctx, 400, 'invalid_request', 'invoice_issue_eligibility_query_invalid');
    if (readerOf(req, ctx) === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    if (pathIdBeforeSuffixOf(typeof req.path === 'string' ? req.path : '', ISSUE_ELIGIBILITY_SUFFIX) === null) {
      return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_id_invalid');
    }
    res.status(200).json({ eligibility: 'allowed' });
  });
}

/** The reviewable issue snapshot of one draft over `ports` (header: THE PREVIEW); refused at construction without its port. */
export function createInvoiceIssuePreviewRoute(ports: InvoiceIssuePorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const { reader, deadlineMs } = readerSetup(ports, options);
  return readRoute(INVOICE_ISSUE_PREVIEW_PATH, INVOICE_ISSUE_REQUIREMENT, async (req, res, ctx) => {
    if (hasQuery(req)) return refuse(res, ctx, 400, 'invalid_request', 'invoice_issue_preview_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const draftId = pathIdBeforeSuffixOf(typeof req.path === 'string' ? req.path : '', ISSUE_PREVIEW_SUFFIX);
    if (draftId === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.preview(reading.scope, reading.sessionKey, draftId, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_issue_preview', err));
    }
    const answer = invoiceIssuePreviewOf(raw, draftId);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_issue_preview_denied');
    // Missing, another store's or tenant's, and not open alike: one status, one body shape, one reason.
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'invoice_issue_preview_not_found');
    // A draft at 2^53 - 1 cannot step its version: no issue body could name it (034's preview answers it before the settings).
    if (answer === 'invalid_state') return refuse(res, ctx, 409, 'invalid_state', 'invoice_issue_preview_version_exhausted');
    if (answer === 'issuing_not_configured') return refuse(res, ctx, 409, 'issuing_not_configured', 'invoice_issue_preview_not_configured');
    if (answer === 'amount_out_of_range') return refuse(res, ctx, 409, 'amount_out_of_range', 'invoice_issue_preview_amount_out_of_range');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_issue_preview_answer_invalid');
    // Restated on a served snapshot: a preview never offers a version no issue body could name.
    if (answer.draft.version > MAX_AMOUNT - 1) return refuse(res, ctx, 409, 'invalid_state', 'invoice_issue_preview_version_exhausted');
    const { draft, customer, issuingSettings: s, amounts } = answer;
    res.status(200).json({
      preview: {
        draft: { id: draft.id, version: draft.version, lines: linesBody(draft.lines), subtotalCents: draft.subtotalCents },
        customer: { id: customer.id, name: customer.name, version: customer.version },
        issuingSettings: {
          version: s.version, legalName: s.legalName, storeName: s.storeName, postalAddress: s.postalAddress, taxRegistrationId: s.taxRegistrationId, tax: taxBody(s.tax),
        },
        amounts: amountsBody(amounts),
        expected: {
          expectedTenant: reading.scope.tenant, expectedVersion: draft.version, expectedSettingsVersion: s.version, expectedCustomerVersion: customer.version,
        },
      },
    });
  });
}

/** The store's issued invoices, newest number first, over `ports`; refused at construction without its port. */
export function createIssuedInvoiceListRoute(ports: InvoiceIssuePorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const { reader, deadlineMs } = readerSetup(ports, options);
  return readRoute(ISSUED_INVOICES_PATH, ISSUED_INVOICE_VIEW_REQUIREMENT, async (req, res, ctx) => {
    const query = parseIssuedInvoiceListQuery(typeof req.url === 'string' ? req.url : '');
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_list_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.page(reading.scope, reading.sessionKey, query, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('issued_invoice_list', err));
    }
    const page = issuedInvoicePageOf(raw, query);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'issued_invoice_list_denied');
    // Unknown, another store's or another tenant's anchor: the malformed cursor's own 400, the same body.
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'issued_invoice_list_answer_invalid');
    const last = page.invoices[page.invoices.length - 1];
    res.status(200).json({
      invoices: page.invoices.map((i) => ({
        id: i.id, number: i.number, sourceDraftId: i.sourceDraftId, customerId: i.customerId, customerName: i.customerName, currency: i.currency,
        totalCents: i.totalCents, issuedAt: i.issuedAt, status: ISSUED_INVOICE_STATUS, snapshotVersion: ISSUED_INVOICE_SNAPSHOT_VERSION,
      })),
      nextCursor: page.hasMore && last !== undefined ? encodeIssuedInvoiceCursor(last.id) : null,
    });
  });
}

/** One issued invoice over `ports`; refused at construction without its port. */
export function createIssuedInvoiceDetailRoute(ports: InvoiceIssuePorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const { reader, deadlineMs } = readerSetup(ports, options);
  return readRoute(ISSUED_INVOICE_PATH, ISSUED_INVOICE_VIEW_REQUIREMENT, async (req, res, ctx) => {
    // No query is part of this contract: any at all, an empty one included, is refused.
    if (hasQuery(req)) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const invoiceId = pathIdOf(typeof req.path === 'string' ? req.path : '');
    if (invoiceId === null) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.invoice(reading.scope, reading.sessionKey, invoiceId, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('issued_invoice', err));
    }
    const answer = issuedInvoiceOf(raw, invoiceId);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'issued_invoice_denied');
    // Missing, another store's and another tenant's alike: one status, one body shape, one reason.
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'issued_invoice_not_found');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'issued_invoice_answer_invalid');
    const { seller, customer } = answer;
    res.status(200).json({
      invoice: {
        id: answer.id, number: answer.number, status: ISSUED_INVOICE_STATUS, snapshotVersion: ISSUED_INVOICE_SNAPSHOT_VERSION, issuedAt: answer.issuedAt,
        sourceDraft: { id: answer.sourceDraft.id, version: answer.sourceDraft.version },
        seller: { legalName: seller.legalName, storeName: seller.storeName, postalAddress: seller.postalAddress, taxRegistrationId: seller.taxRegistrationId },
        issuingSettingsVersion: answer.issuingSettingsVersion,
        customer: { id: customer.id, name: customer.name, version: customer.version },
        lines: linesBody(answer.lines),
        amounts: amountsBody(answer.amounts),
      },
    });
  });
}
