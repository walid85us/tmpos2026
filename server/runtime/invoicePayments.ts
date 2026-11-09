// Phase 4.0 M7b — recording payments against an issued store invoice: the record and reversal commands, their action-only
// eligibilities and the payments read (M7B-PAYMENTS-P1; docs/phase-4/15 §12, ADR-52, D-PAY-1..10; G-IAM, G-ISOLATION,
// G-PERSIST, G-IDEMPOT, G-AUDIT; migration 036, schema tmpos_invoice_payment).
//
// THE FIVE ROUTES, the route table's closed STORE templates (routes.ts), each a session route of the TENANT boundary under a
// STORE-scope permission (m5CanonicalPermissions.ts STORE_ROUTE_PERMISSIONS), the path's {storeId} a REQUESTED TARGET the
// tenant authorizer narrows the actor's own store grants with (invoiceVoid.ts, restated):
//   GET  /api/v1/stores/{storeId}/invoices/{id}/payment-eligibility                — record_invoice_payments, action-only
//   POST /api/v1/stores/{storeId}/invoices/{id}/payments                           — record_invoice_payments, a CREATE under a key
//   GET  /api/v1/stores/{storeId}/invoices/{id}/payment-reversal-eligibility       — reverse_invoice_payments, action-only
//   POST /api/v1/stores/{storeId}/invoices/{id}/payments/{paymentId}/reversal      — reverse_invoice_payments (SENSITIVE), an UPDATE
//   GET  /api/v1/stores/{storeId}/invoices/{id}/payments                           — view_issued_invoices, the payments read
// and, M7B-PAYMENTS-P2 (PRQ-1, migration 037; the last section below), four more, each under record_invoice_payments:
//   POST /api/v1/stores/{storeId}/invoices/{id}/payment-registrations              — the registration, a CREATE under a key
//   GET  /api/v1/stores/{storeId}/invoices/{id}/payment-registration-proof         — its proof, ?registration=<id>
//   POST /api/v1/stores/{storeId}/invoices/{id}/payment-settlement                 — the settlement, an UPDATE under a key
//   GET  /api/v1/stores/{storeId}/payment-attempts                                 — the caller's own registrations
//
// THE RECORD (§12.3; v2 since M7B-PAYMENTS-P2). Body exactly { expectedTenant, registrationId, attemptId, amountCents, method,
// registrationProof }, at most 1 KiB: expectedTenant, registrationId and attemptId canonical lowercase uuids, amountCents a
// JSON safe integer 1..2^53 - 1, method one of INVOICE_PAYMENT_METHODS, registrationProof 64 lowercase hex digits (037's
// m7b_invoice_payment_record_v2 decides; a mismatched registration, attempt, session or proof is the uniform 404). The
// session's digest joins the fingerprint (D-R3-A): another session replaying the key is a 422.
// Anything else — a missing or extra key, a version, an actor, a time, a reference, a card-shaped field — is the 400
// invalid_request after the key is taken. A CREATE of an invoice_payment (store.invoice_payment.record, context scope store)
// whose aggregate id is the runtime's new id (the payment id); its change set carries the path invoice. No recent sign-in.
// Sealed: 201 { "payment": { "id", "invoiceId", "attemptId", "amountCents", "method" } } (built from the plan alone, nothing
// read back, no Location), and the 409s already_recorded, invalid_state (voided), amount_exceeds_remaining and write_conflict
// (carried by every command, unreachable here) — the contract declares paymentRefusals 'record'.
//
// THE REVERSAL (§12.3). Body exactly { expectedTenant, reasonCode } (one of INVOICE_PAYMENT_REVERSAL_REASON_CODES). An UPDATE
// of the payment (store.invoice_payment.reverse) at expectedVersion 1 always: a payment's lifecycle version is 1 while active
// and 2 once reversed, derived by 036, never stored. The route's one template with TWO id segments: app.ts reads the invoice
// and the payment from the matched template's literals and binds both into the fingerprint, invoice then payment. A recent
// sign-in (10 minutes) is required, judged by the chain (403 step_up_required), the revalidator, 036's routine and the mutator
// after the routine on the database clock. Sealed: 200 { "payment": { "id", "invoiceId", "status": "reversed" } }, 409
// invalid_state (already reversed) and write_conflict (unreachable: the planner pins 1).
//
// NO AUDIT ANNEX, NO EVENT. Both kinds are ROUTINE-AUDITED (postgresTransactionalStore.ts ROUTINE_AUDITED_KINDS, D-PAY-8): 036's
// routine writes the one audit record itself, in the command's transaction, under the command's correlation id, with its own
// fixed reason code and sentence (the labels below are the same text). Neither enqueues an event (§12.1 clarification 3).
//
// THE ELIGIBILITIES. invoiceVoid.ts's form, restated: action-only and target-blind, recentAuth none — 200
// { "eligibility": "allowed" } says the chain admits the permission at that store now, and NOTHING about the invoice or a
// payment, nor that the sign-in is recent enough for the reversal.
//
// THE PAYMENTS READ (§12.3). No query, or exactly ?after=<payment id>; 036's m7b_invoice_payments_get through the port
// (asked INVOICE_PAYMENTS_ASK rows). The strict decoder re-derives due, applied, remaining and the status word from the
// invoice's status and Total and refuses any mismatch, negative or unsafe value (503). 200 exactly { invoice, amounts,
// paymentStatus, payments, nextCursor } in that order; no staff id, audit field or correlation id. 400 for any other query,
// a bad id or an unknown cursor; 403 forbidden; 404 not_found (missing, another store's, another tenant's alike); 503.
//
// DA-118 / DA-119 STAY OPEN (widened, doc 15 §12.9): a runtime-role holder with a live session key at the levels can call
// 036's routines directly; they then still write their own audit record, but none of these HTTP checks apply.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. invoiceIssuing.ts's private
// helpers are restated, as invoiceVoid.ts restates them.
import type { Response } from 'express';
import type { CommandContract } from './commandTransaction.js';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { INVOICE_DRAFT_CURRENCY, isDraftCreatedAt } from './invoiceDrafts.js';
import { UUID_RE as AGGREGATE_ID_RE } from './outbox.js';
import type { TrustedScope } from './principals.js';
import {
  COMMAND_REQUEST_INVALID, EnforcementSetupError, PATH_ID_SEGMENT, PAYMENT_ID_SEGMENT, STORE_DIRECTORY_PATH, STORE_SEGMENT, pathIdBeforeSuffixOf,
  storeTargetOf,
} from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteContext, RouteDefinition, RouteHandler } from './routes.js';

/** The closed methods (D-PAY-3), in their one order: 036's CHECK, this enum and the audit text hold the same two. */
export const INVOICE_PAYMENT_METHODS = Object.freeze(['cash', 'external_card_terminal'] as const);
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];
export const INVOICE_PAYMENT_METHOD_LABELS: Readonly<Record<InvoicePaymentMethod, string>> = Object.freeze({
  cash: 'Cash',
  external_card_terminal: 'Card on a separate terminal',
});
/** The closed reversal reasons (D-PAY-4), in their one order. */
export const INVOICE_PAYMENT_REVERSAL_REASON_CODES = Object.freeze(['recorded_in_error', 'wrong_amount', 'wrong_method', 'wrong_invoice', 'duplicate', 'other'] as const);
export type InvoicePaymentReversalReasonCode = (typeof INVOICE_PAYMENT_REVERSAL_REASON_CODES)[number];
export const INVOICE_PAYMENT_REVERSAL_REASON_LABELS: Readonly<Record<InvoicePaymentReversalReasonCode, string>> = Object.freeze({
  recorded_in_error: 'Recorded by mistake',
  wrong_amount: 'Wrong amount',
  wrong_method: 'Wrong method',
  wrong_invoice: 'Wrong invoice',
  duplicate: 'Payment recorded twice',
  other: 'Other reason',
});
/** The payments read's status words (§3 D-PAY-1), in 036's order. */
export const INVOICE_PAYMENT_STATUSES = Object.freeze(['voided', 'nothing_due', 'no_payment_recorded', 'recorded_in_full', 'recorded_partly'] as const);
export type InvoicePaymentStatus = (typeof INVOICE_PAYMENT_STATUSES)[number];
export const isInvoicePaymentMethod = (v: unknown): v is InvoicePaymentMethod =>
  typeof v === 'string' && (INVOICE_PAYMENT_METHODS as readonly string[]).includes(v);
export const isInvoicePaymentReversalReasonCode = (v: unknown): v is InvoicePaymentReversalReasonCode =>
  typeof v === 'string' && (INVOICE_PAYMENT_REVERSAL_REASON_CODES as readonly string[]).includes(v);

const PAYMENTS_SUFFIX = '/payments';
const PAYMENT_ELIGIBILITY_SUFFIX = '/payment-eligibility';
const REVERSAL_ELIGIBILITY_SUFFIX = '/payment-reversal-eligibility';
const INVOICE_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoices${PATH_ID_SEGMENT}`;
/** The five templates (routes.ts STORE_TEMPLATED_ROUTES); the record and the read share one path. */
export const INVOICE_PAYMENTS_PATH = `${INVOICE_PATH}${PAYMENTS_SUFFIX}`;
export const INVOICE_PAYMENT_RECORD_PATH = INVOICE_PAYMENTS_PATH;
export const INVOICE_PAYMENT_ELIGIBILITY_PATH = `${INVOICE_PATH}${PAYMENT_ELIGIBILITY_SUFFIX}`;
export const INVOICE_PAYMENT_REVERSE_PATH = `${INVOICE_PAYMENTS_PATH}${PAYMENT_ID_SEGMENT}/reversal`;
export const INVOICE_PAYMENT_REVERSAL_ELIGIBILITY_PATH = `${INVOICE_PATH}${REVERSAL_ELIGIBILITY_SUFFIX}`;
/** The store route permissions (m5CanonicalPermissions.ts); each eligibility shares its command's. */
export const INVOICE_PAYMENT_RECORD_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'record_invoice_payments' });
export const INVOICE_PAYMENT_REVERSE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'reverse_invoice_payments' });
export const INVOICE_PAYMENTS_VIEW_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'view_issued_invoices' });
/** Each command's body bound: 1 KiB. */
export const INVOICE_PAYMENT_MAX_BODY_BYTES = 1024;
/** The read's page (at most 50 payments) and what it asks 036 for: one more, to know whether more exist. */
export const INVOICE_PAYMENTS_PAGE_SIZE = 50;
export const INVOICE_PAYMENTS_ASK = INVOICE_PAYMENTS_PAGE_SIZE + 1;
export const INVOICE_PAYMENT_REVERSED_STATUS = 'reversed';
/** The lifecycle version the reversal always expects: an active payment's (2 once reversed, never stored). */
const ACTIVE_PAYMENT_VERSION = 1;
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

/** A canonical lowercase uuid of any version. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasExactly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
const isAmount = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= MAX_AMOUNT;
/** A registration proof (M7B-PAYMENTS-P2): exactly 64 lowercase hex digits, as 037's proof routine answers it. */
export const INVOICE_PAYMENT_PROOF_LENGTH = 64;
const PROOF_RE = /^[0-9a-f]{64}$/;
const isProof = (v: unknown): v is string => typeof v === 'string' && PROOF_RE.test(v);

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

const ID_FIELD = Object.freeze({ type: 'string', maxLength: 36 } as const);

/** The record: a CREATE of an invoice_payment that enqueues NO event and seals the payment refusals (header: THE RECORD). */
export const INVOICE_PAYMENT_RECORD_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_payment.record',
  mode: 'create',
  aggregateType: 'invoice_payment',
  contextScope: 'store',
  changes: Object.freeze({
    invoiceId: ID_FIELD,
    expectedTenant: ID_FIELD,
    attemptId: ID_FIELD,
    amountCents: Object.freeze({ type: 'integer', min: 1, max: MAX_AMOUNT } as const),
    method: Object.freeze({ type: 'enum', values: INVOICE_PAYMENT_METHODS } as const),
    // M7B-PAYMENTS-P2 (record v2): the registration this record settles and its proof. Neither reaches an answer or an audit row.
    registrationId: ID_FIELD,
    registrationProof: Object.freeze({ type: 'string', maxLength: INVOICE_PAYMENT_PROOF_LENGTH } as const),
  }),
  events: Object.freeze([]),
  paymentRefusals: 'record',
});

const RECORD_BODY_KEYS: readonly string[] = ['expectedTenant', 'registrationId', 'attemptId', 'amountCents', 'method', 'registrationProof'];

/**
 * The record's plan from its context alone, or COMMAND_REQUEST_INVALID: the runtime's new id as the payment, the path's
 * invoice in the outbox's aggregate-id shape, the four body values, no event, no annex, and the sealed 201.
 */
export function planInvoicePaymentRecord(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = ctx.targetId;
  const paymentId = ctx.newAggregateId;
  if (typeof invoiceId !== 'string' || !AGGREGATE_ID_RE.test(invoiceId) || !isUuid(ctx.storeId) || ctx.paymentId !== undefined
    || !isUuid(paymentId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, RECORD_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, registrationId, attemptId, amountCents, method, registrationProof } = body;
  if (!isUuid(expectedTenant) || !isUuid(registrationId) || !isUuid(attemptId) || !isAmount(amountCents, 1) || !isInvoicePaymentMethod(method)
    || !isProof(registrationProof)) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: paymentId,
    expectedVersion: null,
    changes: { invoiceId, expectedTenant, attemptId, amountCents, method, registrationId, registrationProof },
    events: [],
    response: { status: 201, body: { payment: { id: paymentId, invoiceId, attemptId, amountCents, method } } },
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const RECORD_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_PAYMENT_RECORD_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_PAYMENT_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  // D-PAY-6: recording needs no recent sign-in.
  recentAuth: 'none',
  // M7B-PAYMENTS-P2 (D-R3-A): the session's digest joins the fingerprint, so another session replaying this key is a 422.
  sessionBinding: 'required',
  command: Object.freeze({ contract: INVOICE_PAYMENT_RECORD_CONTRACT, plan: planInvoicePaymentRecord }),
};
/** The record route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_PAYMENT_RECORD_ROUTE: RouteDefinition = Object.freeze(RECORD_ROUTE);

// ---------------------------------------------------------------------------
// The reversal
// ---------------------------------------------------------------------------

/** The reversal: an UPDATE of the payment at version 1, no event, the update vocabulary's sealed refusals (header). */
export const INVOICE_PAYMENT_REVERSE_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_payment.reverse',
  mode: 'update',
  aggregateType: 'invoice_payment',
  contextScope: 'store',
  changes: Object.freeze({
    invoiceId: ID_FIELD,
    expectedTenant: ID_FIELD,
    reasonCode: Object.freeze({ type: 'enum', values: INVOICE_PAYMENT_REVERSAL_REASON_CODES } as const),
  }),
  events: Object.freeze([]),
});

const REVERSE_BODY_KEYS: readonly string[] = ['expectedTenant', 'reasonCode'];

/**
 * The reversal's plan from its context alone, or COMMAND_REQUEST_INVALID: the path's payment at version 1, the path's
 * invoice and the two body values, no event, no annex, and the sealed 200.
 */
export function planInvoicePaymentReverse(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = ctx.targetId;
  const paymentId = ctx.paymentId;
  if (typeof invoiceId !== 'string' || !AGGREGATE_ID_RE.test(invoiceId) || typeof paymentId !== 'string' || !AGGREGATE_ID_RE.test(paymentId)
    || !isUuid(ctx.storeId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, REVERSE_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, reasonCode } = body;
  if (!isUuid(expectedTenant) || !isInvoicePaymentReversalReasonCode(reasonCode)) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: paymentId,
    expectedVersion: ACTIVE_PAYMENT_VERSION,
    changes: { invoiceId, expectedTenant, reasonCode },
    events: [],
    response: { status: 200, body: { payment: { id: paymentId, invoiceId, status: INVOICE_PAYMENT_REVERSED_STATUS } } },
  };
}

const REVERSE_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_PAYMENT_REVERSE_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_REVERSE_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_PAYMENT_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  // D-PAY-6: the reversal is sensitive — the chain refuses a stale sign-in with 403 step_up_required before the body is read.
  recentAuth: 'required',
  command: Object.freeze({ contract: INVOICE_PAYMENT_REVERSE_CONTRACT, plan: planInvoicePaymentReverse }),
};
/** The reversal route, as the tenant inventory registers it. */
export const INVOICE_PAYMENT_REVERSE_ROUTE: RouteDefinition = Object.freeze(REVERSE_ROUTE);

// ---------------------------------------------------------------------------
// The eligibilities and the read
// ---------------------------------------------------------------------------

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The trusted STORE scope and session key a store read needs, or null (invoiceIssuing.ts readerOf, restated). */
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

const pathOf = (req: { path?: unknown }): string => (typeof req.path === 'string' ? req.path : '');
const urlOf = (req: { url?: unknown }): string => (typeof req.url === 'string' ? req.url : '');

/** An action-only eligibility (header: THE ELIGIBILITIES): the query, the scope, then the id segment. Target-blind. */
function eligibilityRoute(path: string, suffix: string, requirement: AuthorizationRequirement, name: string): RouteDefinition {
  return readRoute(path, requirement, (req, res, ctx) => {
    if (urlOf(req).includes('?')) return refuse(res, ctx, 400, 'invalid_request', `${name}_query_invalid`);
    if (readerOf(req, ctx) === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    if (pathIdBeforeSuffixOf(pathOf(req), suffix) === null) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_id_invalid');
    res.status(200).json({ eligibility: 'allowed' });
  });
}

/** Whether the session's actor may record a payment at the path's store now, under the record's own requirement. */
export function createInvoicePaymentEligibilityRoute(): RouteDefinition {
  return eligibilityRoute(INVOICE_PAYMENT_ELIGIBILITY_PATH, PAYMENT_ELIGIBILITY_SUFFIX, INVOICE_PAYMENT_RECORD_REQUIREMENT, 'invoice_payment_eligibility');
}

/** Whether the session's actor may reverse a payment at the path's store now, under the reversal's own requirement. */
export function createInvoicePaymentReversalEligibilityRoute(): RouteDefinition {
  return eligibilityRoute(INVOICE_PAYMENT_REVERSAL_ELIGIBILITY_PATH, REVERSAL_ELIGIBILITY_SUFFIX, INVOICE_PAYMENT_REVERSE_REQUIREMENT,
    'invoice_payment_reversal_eligibility');
}

/**
 * The port to 036's session-bound payments read, handed the trusted STORE scope (its tenant and store are the routine's
 * expected ones), the presenting session's key (a SQL parameter only), the path's invoice and the cursor (null or a payment
 * id); it asks INVOICE_PAYMENTS_ASK rows. Answers are untrusted input, expected to be
 *   { outcome: 'payments', invoice: { id, status }, currency, totalCents, dueCents, appliedCents, remainingCents, paymentStatus,
 *     payments: { id, attemptId, amountCents, method, recordedAt, reversal: null | { reversedAt, reasonCode } }[] (at most 51) }
 *   | { outcome: 'denied' | 'not_found' | 'cursor_unknown' }.
 * A throw is an outage.
 */
export interface InvoicePaymentsPort {
  payments(scope: TrustedScope, sessionKey: string, invoiceId: string, after: string | null, signal: AbortSignal): unknown;
}
/** What the read route is built from. */
export interface InvoicePaymentsPorts {
  readonly invoicePayments: InvoicePaymentsPort;
}

/** One recorded payment as the read serves it. */
export interface InvoicePayment {
  readonly id: string;
  readonly attemptId: string;
  readonly amountCents: number;
  readonly method: InvoicePaymentMethod;
  readonly recordedAt: string;
  readonly reversal: Readonly<{ reversedAt: string; reasonCode: InvoicePaymentReversalReasonCode }> | null;
}
/** One validated page of the payments read. */
export interface InvoicePaymentsPage {
  readonly invoice: Readonly<{ id: string; status: 'issued' | 'voided' }>;
  readonly dueCents: number;
  readonly appliedCents: number;
  readonly remainingCents: number;
  readonly paymentStatus: InvoicePaymentStatus;
  readonly payments: readonly InvoicePayment[];
  readonly hasMore: boolean;
}

const AFTER_RE = /^after=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The read's query: none ({ after: null }), or exactly `after=<canonical uuid>`; null for anything else, a bare `?` included. */
export function parseInvoicePaymentsQuery(target: string): { readonly after: string | null } | null {
  if (typeof target !== 'string') return null;
  const at = target.indexOf('?');
  if (at < 0) return Object.freeze({ after: null });
  const match = AFTER_RE.exec(target.slice(at + 1));
  return match === null ? null : Object.freeze({ after: match[1] });
}

const ANSWER_KEYS: readonly string[] = ['outcome', 'invoice', 'currency', 'totalCents', 'dueCents', 'appliedCents', 'remainingCents', 'paymentStatus', 'payments'];
const PAYMENT_KEYS: readonly string[] = ['id', 'attemptId', 'amountCents', 'method', 'recordedAt', 'reversal'];

/** The status word the invoice's status, due and applied amounts derive (036's rule, restated). */
function statusWordOf(status: 'issued' | 'voided', due: number, applied: number): InvoicePaymentStatus {
  if (status === 'voided') return 'voided';
  if (due === 0) return 'nothing_due';
  if (applied === 0) return 'no_payment_recorded';
  return applied === due ? 'recorded_in_full' : 'recorded_partly';
}

function paymentOf(raw: unknown): InvoicePayment | null {
  if (!isRecord(raw) || !hasExactly(raw, PAYMENT_KEYS)) return null;
  const { id, attemptId, amountCents, method, recordedAt, reversal } = raw;
  if (!isUuid(id) || !isUuid(attemptId) || !isAmount(amountCents, 1) || !isInvoicePaymentMethod(method) || !isDraftCreatedAt(recordedAt)) return null;
  if (reversal === null) return Object.freeze({ id, attemptId, amountCents, method, recordedAt, reversal: null });
  if (!isRecord(reversal) || !hasExactly(reversal, ['reversedAt', 'reasonCode'])) return null;
  const { reversedAt, reasonCode } = reversal;
  // A reversal at or after its recording (036's guard): the fixed-width UTC text orders as the instants do.
  if (!isDraftCreatedAt(reversedAt) || reversedAt < recordedAt || !isInvoicePaymentReversalReasonCode(reasonCode)) return null;
  return Object.freeze({ id, attemptId, amountCents, method, recordedAt, reversal: Object.freeze({ reversedAt, reasonCode }) });
}

/**
 * The port's answer as a validated page, 'denied', 'not_found', 'cursor_unknown' — or null for anything out of shape (header:
 * THE PAYMENTS READ). Never throws. Re-derives due (the Total while issued, 0 once voided), remaining and the status word,
 * checks applied against due and against the page's unreversed payments (equal when the page is the whole history), and the
 * page's order, uniqueness and bound.
 */
export function invoicePaymentsOf(raw: unknown, invoiceId: string, after: string | null): InvoicePaymentsPage | 'denied' | 'not_found' | 'cursor_unknown' | null {
  try {
    if (!isRecord(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found' || outcome === 'cursor_unknown') {
      return hasExactly(raw, ['outcome']) && (outcome !== 'cursor_unknown' || after !== null) ? outcome : null;
    }
    if (outcome !== 'payments' || !hasExactly(raw, ANSWER_KEYS)) return null;
    const { invoice, currency, totalCents, dueCents, appliedCents, remainingCents, paymentStatus, payments } = raw;
    if (!isRecord(invoice) || !hasExactly(invoice, ['id', 'status']) || invoice.id !== invoiceId) return null;
    const status = invoice.status;
    if ((status !== 'issued' && status !== 'voided') || currency !== INVOICE_DRAFT_CURRENCY) return null;
    if (!isAmount(totalCents, 0) || !isAmount(dueCents, 0) || !isAmount(appliedCents, 0) || !isAmount(remainingCents, 0)) return null;
    const due = status === 'voided' ? 0 : totalCents;
    if (dueCents !== due || appliedCents > due || remainingCents !== due - appliedCents) return null;
    if (status === 'voided' && appliedCents !== 0) return null;
    const word = statusWordOf(status, dueCents, appliedCents);
    if (paymentStatus !== word) return null;
    if (!Array.isArray(payments) || payments.length > INVOICE_PAYMENTS_ASK) return null;
    const page: InvoicePayment[] = [];
    const seen = new Set<string>();
    let active = 0n;
    // inv: page holds a checked copy of each payment below i, ids distinct and none the cursor, strictly ordered by (recordedAt, id).
    for (let i = 0; i < payments.length; i++) {
      const p = paymentOf(payments[i]);
      if (p === null || seen.has(p.id) || p.id === after) return null;
      const prev = page[page.length - 1];
      if (prev !== undefined && !(prev.recordedAt < p.recordedAt || (prev.recordedAt === p.recordedAt && prev.id < p.id))) return null;
      seen.add(p.id);
      page.push(p);
      if (p.reversal === null) active += BigInt(p.amountCents);
    }
    // A voided invoice holds no unreversed payment (A2); the page's unreversed sum never exceeds the whole history's, and
    // equals it when the page IS the whole history (no cursor, nothing more).
    if (status === 'voided' && active !== 0n) return null;
    const hasMore = page.length > INVOICE_PAYMENTS_PAGE_SIZE;
    if (active > BigInt(appliedCents) || (after === null && !hasMore && active !== BigInt(appliedCents))) return null;
    return Object.freeze({
      invoice: Object.freeze({ id: invoiceId, status }), dueCents, appliedCents, remainingCents, paymentStatus: word,
      payments: Object.freeze(hasMore ? page.slice(0, INVOICE_PAYMENTS_PAGE_SIZE) : page), hasMore,
    });
  } catch {
    return null; // a hostile getter: not in contract
  }
}

/** One issued invoice's payments over `ports` (header: THE PAYMENTS READ); refused at construction without its port. */
export function createInvoicePaymentsRoute(ports: InvoicePaymentsPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.invoicePayments;
  if (typeof reader?.payments !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) throw new EnforcementSetupError('port_deadline_invalid');
  return readRoute(INVOICE_PAYMENTS_PATH, INVOICE_PAYMENTS_VIEW_REQUIREMENT, async (req, res, ctx) => {
    const query = parseInvoicePaymentsQuery(urlOf(req));
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_payments_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const invoiceId = pathIdBeforeSuffixOf(pathOf(req), PAYMENTS_SUFFIX);
    if (invoiceId === null) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.payments(reading.scope, reading.sessionKey, invoiceId, query.after, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_payments', err));
    }
    const page = invoicePaymentsOf(raw, invoiceId, query.after);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_payments_denied');
    // Missing, another store's and another tenant's alike: one status, one body shape, one reason.
    if (page === 'not_found') return refuse(res, ctx, 404, 'not_found', 'invoice_payments_not_found');
    // A cursor that is not a payment of this invoice: the bad query's own 400, the same body.
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'invoice_payments_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_payments_answer_invalid');
    const last = page.payments[page.payments.length - 1];
    res.status(200).json({
      invoice: { id: page.invoice.id, status: page.invoice.status },
      amounts: { currency: INVOICE_DRAFT_CURRENCY, dueCents: page.dueCents, appliedCents: page.appliedCents, remainingCents: page.remainingCents },
      paymentStatus: page.paymentStatus,
      payments: page.payments.map((p) => ({
        id: p.id, attemptId: p.attemptId, amountCents: p.amountCents, method: p.method, recordedAt: p.recordedAt,
        reversal: p.reversal === null ? null : { reversedAt: p.reversal.reversedAt, reasonCode: p.reversal.reasonCode },
      })),
      nextCursor: page.hasMore && last !== undefined ? last.id : null,
    });
  });
}

// ---------------------------------------------------------------------------
// M7B-PAYMENTS-P2 (PRQ-1, migration 037): the registration, its proof, the settlement and the staff member's attempts
// ---------------------------------------------------------------------------
//
// A payment is recorded only through a REGISTRATION: POST …/payment-registrations opens one (the runtime's new id), GET
// …/payment-registration-proof?registration=<id> answers its proof once it is committed and durable (037's proof routine),
// and the record (above) names both. GET /api/v1/stores/{storeId}/payment-attempts lists the caller's own registrations
// (never a registration id), and POST …/payment-settlement withdraws an open one (expectedVersion 1) or confirms a recorded
// one (expectedVersion 2). All four require record_invoice_payments at the trusted store and no recent sign-in. The proof is
// never in a command's answer, a stored answer, an audit row or a log line: only in the proof GET's body, which nothing stores.
// 037's 55000 raises (no key, fsync off, an unverified WAL layout) reach no body: a command's is the kernel's bounded 503
// (nothing written), a read's the port's outage, the same 503. The proof's 'not durable' is the routine's not_durable answer,
// the port's alone: committed, asked once more in a fresh transaction, and a second one is the port's bounded outage (the 503).

const PAYMENT_REGISTRATIONS_SUFFIX = '/payment-registrations';
const REGISTRATION_PROOF_SUFFIX = '/payment-registration-proof';
const PAYMENT_SETTLEMENT_SUFFIX = '/payment-settlement';
export const INVOICE_PAYMENT_REGISTER_PATH = `${INVOICE_PATH}${PAYMENT_REGISTRATIONS_SUFFIX}`;
export const INVOICE_PAYMENT_REGISTRATION_PROOF_PATH = `${INVOICE_PATH}${REGISTRATION_PROOF_SUFFIX}`;
export const INVOICE_PAYMENT_SETTLE_PATH = `${INVOICE_PATH}${PAYMENT_SETTLEMENT_SUFFIX}`;
export const INVOICE_PAYMENT_ATTEMPTS_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/payment-attempts`;
/** The attempts read's page (at most 50) and what it asks 037 for: one more, to know whether more exist. */
export const INVOICE_PAYMENT_ATTEMPTS_PAGE_SIZE = 50;
export const INVOICE_PAYMENT_ATTEMPTS_ASK = INVOICE_PAYMENT_ATTEMPTS_PAGE_SIZE + 1;
/** A registration's states and their lifecycle versions (037: open 1, recorded 2, withdrawn and confirmed 3). */
export const INVOICE_PAYMENT_ATTEMPT_STATES = Object.freeze(['open', 'recorded', 'withdrawn', 'confirmed'] as const);
export type InvoicePaymentAttemptState = (typeof INVOICE_PAYMENT_ATTEMPT_STATES)[number];
const STATE_VERSIONS: Readonly<Record<InvoicePaymentAttemptState, number>> = Object.freeze({ open: 1, recorded: 2, withdrawn: 3, confirmed: 3 });
/** The settlement's two expected versions and the state each settles to. */
const SETTLED_STATES: Readonly<Record<number, InvoicePaymentAttemptState>> = Object.freeze({ 1: 'withdrawn', 2: 'confirmed' });

/** The registration: a CREATE of an invoice_payment_registration, no event, the record's refusal set (header). */
export const INVOICE_PAYMENT_REGISTER_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_payment.register',
  mode: 'create',
  aggregateType: 'invoice_payment_registration',
  contextScope: 'store',
  changes: Object.freeze({ invoiceId: ID_FIELD, expectedTenant: ID_FIELD, attemptId: ID_FIELD }),
  events: Object.freeze([]),
  paymentRefusals: 'record',
});

const REGISTER_BODY_KEYS: readonly string[] = ['expectedTenant', 'attemptId'];

/**
 * The registration's plan from its context alone, or COMMAND_REQUEST_INVALID: the runtime's new id as the registration, the
 * path's invoice, the two body values, no event, and the sealed 201 — which never carries a proof.
 */
export function planInvoicePaymentRegister(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = ctx.targetId;
  const registrationId = ctx.newAggregateId;
  if (typeof invoiceId !== 'string' || !AGGREGATE_ID_RE.test(invoiceId) || !isUuid(ctx.storeId) || ctx.paymentId !== undefined
    || !isUuid(registrationId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, REGISTER_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, attemptId } = body;
  if (!isUuid(expectedTenant) || !isUuid(attemptId)) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: registrationId,
    expectedVersion: null,
    changes: { invoiceId, expectedTenant, attemptId },
    events: [],
    response: { status: 201, body: { registration: { id: registrationId, invoiceId, attemptId, state: 'open' } } },
  };
}

const REGISTER_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_PAYMENT_REGISTER_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_PAYMENT_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  recentAuth: 'none',
  // D-R3-A: the session's digest joins the fingerprint (routes.ts SESSION_BOUND_STORE_COMMANDS).
  sessionBinding: 'required',
  command: Object.freeze({ contract: INVOICE_PAYMENT_REGISTER_CONTRACT, plan: planInvoicePaymentRegister }),
};
/** The registration route, as the tenant inventory registers it. */
export const INVOICE_PAYMENT_REGISTER_ROUTE: RouteDefinition = Object.freeze(REGISTER_ROUTE);

/** The settlement: an UPDATE of the caller's registration of one attempt at version 1 or 2, no event (header). */
export const INVOICE_PAYMENT_SETTLE_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_payment.settle',
  mode: 'update',
  aggregateType: 'invoice_payment_registration',
  contextScope: 'store',
  changes: Object.freeze({ invoiceId: ID_FIELD, expectedTenant: ID_FIELD, attemptId: ID_FIELD }),
  events: Object.freeze([]),
});

const SETTLE_BODY_KEYS: readonly string[] = ['expectedTenant', 'attemptId', 'expectedVersion'];

/**
 * The settlement's plan, or COMMAND_REQUEST_INVALID: the body's attempt (the aggregate: one per caller per invoice) at the
 * body's version, 1 ("I saw it open") or 2 ("I saw it recorded"); the sealed 200, also the answer for the same settlement
 * already in place (037's 'unchanged', no audit record).
 */
export function planInvoicePaymentSettle(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = ctx.targetId;
  if (typeof invoiceId !== 'string' || !AGGREGATE_ID_RE.test(invoiceId) || !isUuid(ctx.storeId) || ctx.paymentId !== undefined) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, SETTLE_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, attemptId, expectedVersion } = body;
  if (!isUuid(expectedTenant) || !isUuid(attemptId) || (expectedVersion !== 1 && expectedVersion !== 2)) return COMMAND_REQUEST_INVALID;
  const response = { status: 200, body: { settlement: { invoiceId, attemptId, state: SETTLED_STATES[expectedVersion] } } };
  return {
    aggregateId: attemptId,
    expectedVersion,
    changes: { invoiceId, expectedTenant, attemptId },
    events: [],
    response,
    unchanged: response,
  };
}

const SETTLE_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_PAYMENT_SETTLE_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_PAYMENT_RECORD_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_PAYMENT_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  recentAuth: 'none',
  command: Object.freeze({ contract: INVOICE_PAYMENT_SETTLE_CONTRACT, plan: planInvoicePaymentSettle }),
};
/** The settlement route, as the tenant inventory registers it. */
export const INVOICE_PAYMENT_SETTLE_ROUTE: RouteDefinition = Object.freeze(SETTLE_ROUTE);

/**
 * The port to 037's two session-bound reads, each handed the trusted STORE scope (its tenant and store are the routine's
 * expected ones) and the presenting session's key (a SQL parameter only). Answers are untrusted input, expected to be
 *   proof:    { outcome: 'proof', registrationId, invoiceId, attemptId, proof } | { outcome: 'denied' | 'not_found' }
 *   attempts: { outcome: 'attempts', attempts: InvoicePaymentAttempt-shaped[] (at most 51) } | { outcome: 'denied' | 'cursor_unknown' }
 * (it asks INVOICE_PAYMENT_ATTEMPTS_ASK rows). A throw — 037's fail-closed raises included — is an outage. The proof is handed
 * the route's own deadline (`deadlineMs`, the bound `signal` aborts at) and settles within it: the routine's 'not_durable' is
 * the port's alone (it commits that transaction and may ask once more in a fresh one); a second one is a throw, never an answer.
 */
export interface InvoicePaymentRegistrationsPort {
  proof(scope: TrustedScope, sessionKey: string, invoiceId: string, registrationId: string, signal: AbortSignal, deadlineMs: number): unknown;
  attempts(scope: TrustedScope, sessionKey: string, after: InvoicePaymentAttemptsCursor | null, signal: AbortSignal): unknown;
}
/** What the proof and attempts routes are built from. */
export interface InvoicePaymentRegistrationsPorts {
  readonly invoicePaymentRegistrations: InvoicePaymentRegistrationsPort;
}
/** The attempts read's cursor: the last row's invoice and attempt. */
export interface InvoicePaymentAttemptsCursor {
  readonly invoiceId: string;
  readonly attemptId: string;
}

const REGISTRATION_QUERY_RE = /^registration=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The proof read's query: exactly `registration=<canonical uuid>`; null for anything else, none included. */
export function parseRegistrationProofQuery(target: string): { readonly registrationId: string } | null {
  if (typeof target !== 'string') return null;
  const at = target.indexOf('?');
  if (at < 0) return null;
  const match = REGISTRATION_QUERY_RE.exec(target.slice(at + 1));
  return match === null ? null : Object.freeze({ registrationId: match[1] });
}

/** The proof port's answer, 'denied', 'not_found', or null for anything out of shape. Never throws. */
export function registrationProofOf(raw: unknown, invoiceId: string, registrationId: string):
  Readonly<{ attemptId: string; proof: string }> | 'denied' | 'not_found' | null {
  try {
    if (!isRecord(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found') return hasExactly(raw, ['outcome']) ? outcome : null;
    if (outcome !== 'proof' || !hasExactly(raw, ['outcome', 'registrationId', 'invoiceId', 'attemptId', 'proof'])) return null;
    const { attemptId, proof } = raw;
    if (raw.registrationId !== registrationId || raw.invoiceId !== invoiceId || !isUuid(attemptId) || !isProof(proof)) return null;
    return Object.freeze({ attemptId, proof });
  } catch {
    return null; // a hostile getter: not in contract
  }
}

/** One registration of the caller as the attempts read serves it (never its id). */
export interface InvoicePaymentAttempt {
  readonly invoiceId: string;
  readonly invoiceNumber: number;
  readonly attemptId: string;
  readonly state: InvoicePaymentAttemptState;
  readonly version: number;
  readonly registeredAt: string;
  readonly settledAt: string | null;
  readonly payment: Readonly<{
    id: string; amountCents: number; method: InvoicePaymentMethod; recordedAt: string;
    reversal: Readonly<{ reversedAt: string; reasonCode: InvoicePaymentReversalReasonCode }> | null;
  }> | null;
}

const ATTEMPT_KEYS: readonly string[] = ['invoiceId', 'invoiceNumber', 'attemptId', 'state', 'version', 'registeredAt', 'settledAt', 'payment'];
const ATTEMPT_PAYMENT_KEYS: readonly string[] = ['id', 'amountCents', 'method', 'recordedAt', 'reversal'];

function attemptOf(raw: unknown): InvoicePaymentAttempt | null {
  if (!isRecord(raw) || !hasExactly(raw, ATTEMPT_KEYS)) return null;
  const { invoiceId, invoiceNumber, attemptId, state, version, registeredAt, settledAt, payment } = raw;
  if (!isUuid(invoiceId) || !isAmount(invoiceNumber, 1) || !isUuid(attemptId) || !isDraftCreatedAt(registeredAt)) return null;
  if (typeof state !== 'string' || !(INVOICE_PAYMENT_ATTEMPT_STATES as readonly string[]).includes(state)) return null;
  const word = state as InvoicePaymentAttemptState;
  // The state, its version, its settlement time and its payment agree (037's derivation): settled iff withdrawn or confirmed,
  // a payment iff recorded or confirmed; a settlement at or after the registration.
  const settled = word === 'withdrawn' || word === 'confirmed';
  const paid = word === 'recorded' || word === 'confirmed';
  if (version !== STATE_VERSIONS[word] || (settledAt === null) === settled || (payment === null) === paid) return null;
  let settledText: string | null = null;
  if (settledAt !== null) {
    if (!isDraftCreatedAt(settledAt) || settledAt < registeredAt) return null;
    settledText = settledAt;
  }
  if (payment === null) return Object.freeze({ invoiceId, invoiceNumber, attemptId, state: word, version, registeredAt, settledAt: settledText, payment: null });
  if (!isRecord(payment) || !hasExactly(payment, ATTEMPT_PAYMENT_KEYS)) return null;
  const { id, amountCents, method, recordedAt, reversal } = payment;
  if (!isUuid(id) || !isAmount(amountCents, 1) || !isInvoicePaymentMethod(method) || !isDraftCreatedAt(recordedAt)) return null;
  let checkedReversal: Readonly<{ reversedAt: string; reasonCode: InvoicePaymentReversalReasonCode }> | null = null;
  if (reversal !== null) {
    if (!isRecord(reversal) || !hasExactly(reversal, ['reversedAt', 'reasonCode'])) return null;
    const { reversedAt, reasonCode } = reversal;
    if (!isDraftCreatedAt(reversedAt) || reversedAt < recordedAt || !isInvoicePaymentReversalReasonCode(reasonCode)) return null;
    checkedReversal = Object.freeze({ reversedAt, reasonCode });
  }
  return Object.freeze({
    invoiceId, invoiceNumber, attemptId, state: word, version, registeredAt, settledAt: settledText,
    payment: Object.freeze({ id, amountCents, method, recordedAt, reversal: checkedReversal }),
  });
}

/**
 * The attempts port's answer as a validated page ({ attempts, hasMore }), 'denied', 'cursor_unknown', or null for anything out
 * of shape. Never throws. The page is strictly ordered by (registeredAt, invoiceId, attemptId), each pair once, at most 51.
 */
export function invoicePaymentAttemptsOf(raw: unknown, after: InvoicePaymentAttemptsCursor | null):
  Readonly<{ attempts: readonly InvoicePaymentAttempt[]; hasMore: boolean }> | 'denied' | 'cursor_unknown' | null {
  try {
    if (!isRecord(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'cursor_unknown') {
      return hasExactly(raw, ['outcome']) && (outcome !== 'cursor_unknown' || after !== null) ? outcome : null;
    }
    if (outcome !== 'attempts' || !hasExactly(raw, ['outcome', 'attempts'])) return null;
    const { attempts } = raw;
    if (!Array.isArray(attempts) || attempts.length > INVOICE_PAYMENT_ATTEMPTS_ASK) return null;
    const page: InvoicePaymentAttempt[] = [];
    const seen = new Set<string>();
    // inv: page holds a checked copy of each row below i, (invoice, attempt) pairs distinct and none the cursor's, strictly ordered.
    for (let i = 0; i < attempts.length; i++) {
      const a = attemptOf(attempts[i]);
      if (a === null) return null;
      const pair = `${a.invoiceId}.${a.attemptId}`;
      if (seen.has(pair) || (after !== null && pair === `${after.invoiceId}.${after.attemptId}`)) return null;
      const prev = page[page.length - 1];
      if (prev !== undefined && !(prev.registeredAt < a.registeredAt || (prev.registeredAt === a.registeredAt
        && (prev.invoiceId < a.invoiceId || (prev.invoiceId === a.invoiceId && prev.attemptId < a.attemptId))))) return null;
      seen.add(pair);
      page.push(a);
    }
    const hasMore = page.length > INVOICE_PAYMENT_ATTEMPTS_PAGE_SIZE;
    return Object.freeze({ attempts: Object.freeze(hasMore ? page.slice(0, INVOICE_PAYMENT_ATTEMPTS_PAGE_SIZE) : page), hasMore });
  } catch {
    return null; // a hostile getter: not in contract
  }
}

const ATTEMPTS_QUERY_RE = /^after=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The attempts read's query: none ({ after: null }), or exactly `after=<invoice uuid>.<attempt uuid>` (the served nextCursor). */
export function parseInvoicePaymentAttemptsQuery(target: string): { readonly after: InvoicePaymentAttemptsCursor | null } | null {
  if (typeof target !== 'string') return null;
  const at = target.indexOf('?');
  if (at < 0) return Object.freeze({ after: null });
  const match = ATTEMPTS_QUERY_RE.exec(target.slice(at + 1));
  return match === null ? null : Object.freeze({ after: Object.freeze({ invoiceId: match[1], attemptId: match[2] }) });
}

function registrationsPortOf(ports: InvoicePaymentRegistrationsPorts, method: 'proof' | 'attempts', deadlineMs: number): InvoicePaymentRegistrationsPort {
  const port = ports?.invoicePaymentRegistrations;
  if (typeof port?.[method] !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) throw new EnforcementSetupError('port_deadline_invalid');
  return port;
}

/**
 * One registration's proof (header): the query exactly `registration=<id>`, the scope, the id segment, then 037's proof
 * routine through the port. 200 exactly { registration: { id, invoiceId, attemptId }, proof }; 400; 403; 404 not_found (every
 * mismatch alike); 503 (an outage, not yet durable, no key). The registration id is in the query only, the proof in the body only.
 */
export function createInvoicePaymentRegistrationProofRoute(ports: InvoicePaymentRegistrationsPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  const port = registrationsPortOf(ports, 'proof', deadlineMs);
  return readRoute(INVOICE_PAYMENT_REGISTRATION_PROOF_PATH, INVOICE_PAYMENT_RECORD_REQUIREMENT, async (req, res, ctx) => {
    const query = parseRegistrationProofQuery(urlOf(req));
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_payment_registration_proof_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const invoiceId = pathIdBeforeSuffixOf(pathOf(req), REGISTRATION_PROOF_SUFFIX);
    if (invoiceId === null) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => port.proof(reading.scope, reading.sessionKey, invoiceId, query.registrationId, signal, deadlineMs));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_payment_registration_proof', err));
    }
    const answer = registrationProofOf(raw, invoiceId, query.registrationId);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_payment_registration_proof_denied');
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'invoice_payment_registration_not_found');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_payment_registration_proof_answer_invalid');
    res.status(200).json({ registration: { id: query.registrationId, invoiceId, attemptId: answer.attemptId }, proof: answer.proof });
  });
}

/**
 * The caller's own registrations at the path's store (header): no query or exactly `after=<invoice>.<attempt>`. 200 exactly
 * { attempts, nextCursor }; 400 (a bad query or an unknown cursor); 403; 503. Never a registration id.
 */
export function createInvoicePaymentAttemptsRoute(ports: InvoicePaymentRegistrationsPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  const port = registrationsPortOf(ports, 'attempts', deadlineMs);
  return readRoute(INVOICE_PAYMENT_ATTEMPTS_PATH, INVOICE_PAYMENT_RECORD_REQUIREMENT, async (req, res, ctx) => {
    const query = parseInvoicePaymentAttemptsQuery(urlOf(req));
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_payment_attempts_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => port.attempts(reading.scope, reading.sessionKey, query.after, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_payment_attempts', err));
    }
    const page = invoicePaymentAttemptsOf(raw, query.after);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_payment_attempts_denied');
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'invoice_payment_attempts_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_payment_attempts_answer_invalid');
    const last = page.attempts[page.attempts.length - 1];
    res.status(200).json({
      attempts: page.attempts.map((a) => ({
        invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, attemptId: a.attemptId, state: a.state, version: a.version,
        registeredAt: a.registeredAt, settledAt: a.settledAt,
        payment: a.payment === null ? null : {
          id: a.payment.id, amountCents: a.payment.amountCents, method: a.payment.method, recordedAt: a.payment.recordedAt,
          reversal: a.payment.reversal === null ? null : { reversedAt: a.payment.reversal.reversedAt, reasonCode: a.payment.reversal.reasonCode },
        },
      })),
      nextCursor: page.hasMore && last !== undefined ? `${last.invoiceId}.${last.attemptId}` : null,
    });
  });
}
