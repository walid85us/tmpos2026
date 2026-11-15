// Phase 4.0 M7b — credit notes against an issued store invoice (M7B-CREDITNOTES-P1; docs/phase-4/16 D-CN-1..12, §12 adopted
// bundle; G-IAM, G-ISOLATION, G-PERSIST, G-IDEMPOT, G-AUDIT; migration 038, schema tmpos_invoice_credit_note).
//
// THE SEVEN ROUTES, the route table's closed STORE templates (routes.ts), each a session route of the TENANT boundary under a
// STORE-scope permission (m5CanonicalPermissions.ts): the three credit-note keys are decided by the STORE OWNER RULE (role
// store_owner at store scope, D-CN-7 A), so a manager at Invoices Full is 403 on every one of them.
//   POST /api/v1/stores/{storeId}/invoices/{id}/credit-note-registrations        — issue_invoice_credit_notes (SENSITIVE), a CREATE
//   GET  /api/v1/stores/{storeId}/invoices/{id}/credit-note-registration-proof   — recover_invoice_credit_notes, ?registration=<id>
//   POST /api/v1/stores/{storeId}/invoices/{id}/credit-notes                     — issue_invoice_credit_notes (SENSITIVE), a CREATE
//   GET  /api/v1/stores/{storeId}/credit-note-attempts                           — recover_invoice_credit_notes, the caller's own
//   POST /api/v1/stores/{storeId}/invoices/{id}/credit-note-settlement           — recover_invoice_credit_notes, an UPDATE
//   POST /api/v1/stores/{storeId}/invoices/{id}/credit-notes/{creditNoteId}/withdrawal — withdraw_invoice_credit_notes (SENSITIVE)
//   GET  /api/v1/stores/{storeId}/invoices/{id}/credit-notes                     — view_issued_invoices, the credit-note list
//
// THE RECOVERY CONTRACT (doc 16 "CN-P1 recovery contract", D-CN-9 A) mirrors 037 routine by routine: a registration binds the
// attempt, the amount and the reason; its post-commit proof; the issue presenting both; the caller's attempts; a deliberate
// settlement (expectedVersion 1 releases an unused registration, 2 confirms an issued one). The registration and the issue are
// SESSION-BOUND commands (routes.ts SESSION_BOUND_STORE_COMMANDS): the presenting session's digest joins the fingerprint, so a
// replacement session replaying a key is a 422. Both require a recent sign-in (10 minutes), judged by the chain, the
// revalidator, 038's routine and the mutator after the routine on the database clock; proof, attempts and settlement need
// none (the non-sensitive recover key). The withdrawal requires a recent sign-in too.
//
// SEALED ANSWERS. The registration and the issue declare paymentRefusals 'credit' (commandTransaction.ts): the 409s
// already_issued, invalid_state (a released registration, the voided invoice) and amount_exceeds_remaining (the issue only),
// and write_conflict (an own unsettled registration on the invoice; bound values that differ). The settlement and the withdrawal
// are UPDATEs with the update vocabulary (invalid_state, write_conflict). A 201 carries no credit-note number (doc 16 §8: the
// list shows it). NO AUDIT ANNEX, NO EVENT: every kind is ROUTINE-AUDITED (postgresTransactionalStore.ts ROUTINE_AUDITED_KINDS).
//
// THE LIST. No query or exactly ?after=<credit note id>; 038's m7b_invoice_credit_notes_list. Staff display names reach the
// store owner only: when the routine answers names not visible, the issuedByName and withdrawnByName fields are ABSENT (not
// null); when visible, a NULL name is sent as null (doc 16 D-CN-7, CN-33). Never an id or an email.
//
// Every routine answer is decoded exactly; anything out of shape is the 503. PURE AND PORTABLE: part of the emitted tenant
// runtime artifact, importing only the runtime. invoicePayments.ts's private helpers are restated.
import type { Response } from 'express';
import type { CommandContract } from './commandTransaction.js';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { isDraftCreatedAt } from './invoiceDrafts.js';
import { UUID_RE as AGGREGATE_ID_RE } from './outbox.js';
import type { TrustedScope } from './principals.js';
import {
  COMMAND_REQUEST_INVALID, CREDIT_NOTE_ID_SEGMENT, EnforcementSetupError, PATH_ID_SEGMENT, STORE_DIRECTORY_PATH, STORE_SEGMENT,
  pathIdBeforeSuffixOf, storeTargetOf,
} from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteContext, RouteDefinition, RouteHandler } from './routes.js';

/** The closed issue reasons (D-CN-5, 038's CHECK), in their one order. */
export const INVOICE_CREDIT_NOTE_REASONS = Object.freeze(['pricing_error', 'service_issue', 'goodwill', 'billing_error'] as const);
export type InvoiceCreditNoteReason = (typeof INVOICE_CREDIT_NOTE_REASONS)[number];
/** The closed withdrawal reasons (D-CN-5), in their one order. */
export const INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS = Object.freeze(['entered_in_error', 'wrong_amount', 'wrong_invoice'] as const);
export type InvoiceCreditNoteWithdrawalReason = (typeof INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS)[number];
export const isInvoiceCreditNoteReason = (v: unknown): v is InvoiceCreditNoteReason =>
  typeof v === 'string' && (INVOICE_CREDIT_NOTE_REASONS as readonly string[]).includes(v);
export const isInvoiceCreditNoteWithdrawalReason = (v: unknown): v is InvoiceCreditNoteWithdrawalReason =>
  typeof v === 'string' && (INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS as readonly string[]).includes(v);

const REGISTRATIONS_SUFFIX = '/credit-note-registrations';
const PROOF_SUFFIX = '/credit-note-registration-proof';
const CREDIT_NOTES_SUFFIX = '/credit-notes';
const SETTLEMENT_SUFFIX = '/credit-note-settlement';
const INVOICE_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoices${PATH_ID_SEGMENT}`;
export const INVOICE_CREDIT_NOTE_REGISTER_PATH = `${INVOICE_PATH}${REGISTRATIONS_SUFFIX}`;
export const INVOICE_CREDIT_NOTE_PROOF_PATH = `${INVOICE_PATH}${PROOF_SUFFIX}`;
/** The issue and the list share one path. */
export const INVOICE_CREDIT_NOTES_PATH = `${INVOICE_PATH}${CREDIT_NOTES_SUFFIX}`;
export const INVOICE_CREDIT_NOTE_SETTLE_PATH = `${INVOICE_PATH}${SETTLEMENT_SUFFIX}`;
export const INVOICE_CREDIT_NOTE_WITHDRAW_PATH = `${INVOICE_CREDIT_NOTES_PATH}${CREDIT_NOTE_ID_SEGMENT}/withdrawal`;
export const INVOICE_CREDIT_NOTE_ATTEMPTS_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/credit-note-attempts`;
/** The store route permissions (m5CanonicalPermissions.ts, D-CN-7 A). */
export const INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'issue_invoice_credit_notes' });
export const INVOICE_CREDIT_NOTE_WITHDRAW_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'withdraw_invoice_credit_notes' });
export const INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'recover_invoice_credit_notes' });
export const INVOICE_CREDIT_NOTES_VIEW_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'view_issued_invoices' });
/** Each command's body bound: 1 KiB. */
export const INVOICE_CREDIT_NOTE_MAX_BODY_BYTES = 1024;
/** The list's and the attempts' page (at most 50) and what each asks 038 for: one more, to know whether more exist. */
export const INVOICE_CREDIT_NOTES_PAGE_SIZE = 50;
export const INVOICE_CREDIT_NOTES_ASK = INVOICE_CREDIT_NOTES_PAGE_SIZE + 1;
export const INVOICE_CREDIT_NOTE_ATTEMPTS_PAGE_SIZE = 50;
export const INVOICE_CREDIT_NOTE_ATTEMPTS_ASK = INVOICE_CREDIT_NOTE_ATTEMPTS_PAGE_SIZE + 1;
/** A credit note's lifecycle version: 1 while active, 2 once withdrawn (derived, never stored); the withdrawal expects 1. */
const ACTIVE_CREDIT_NOTE_VERSION = 1;
export const INVOICE_CREDIT_NOTE_WITHDRAWN_STATUS = 'withdrawn';
/** A registration's states and lifecycle versions (038: open 1, issued 2, released and confirmed 3). */
export const INVOICE_CREDIT_NOTE_ATTEMPT_STATES = Object.freeze(['open', 'issued', 'released', 'confirmed'] as const);
export type InvoiceCreditNoteAttemptState = (typeof INVOICE_CREDIT_NOTE_ATTEMPT_STATES)[number];
const STATE_VERSIONS: Readonly<Record<InvoiceCreditNoteAttemptState, number>> = Object.freeze({ open: 1, issued: 2, released: 3, confirmed: 3 });
/** The settlement's two expected versions and the state each settles to. */
const SETTLED_STATES: Readonly<Record<number, InvoiceCreditNoteAttemptState>> = Object.freeze({ 1: 'released', 2: 'confirmed' });
/** A staff display name's bound (public.app_user.display_name has none): a longer one is out of contract, the 503. */
export const INVOICE_CREDIT_NOTE_NAME_MAX_LENGTH = 1000;
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
/** A registration proof: exactly 64 lowercase hex digits (037's shape, 038's label). */
export const INVOICE_CREDIT_NOTE_PROOF_LENGTH = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isProof = (v: unknown): v is string => typeof v === 'string' && PROOF_RE.test(v);
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
const ID_FIELD = Object.freeze({ type: 'string', maxLength: 36 } as const);
const GROSS_FIELD = Object.freeze({ type: 'integer', min: 1, max: MAX_AMOUNT } as const);
const REASON_FIELD = Object.freeze({ type: 'enum', values: INVOICE_CREDIT_NOTE_REASONS } as const);

/** The common command checks: the path invoice in the aggregate-id shape, the store, and no second id. */
const invoiceOf = (ctx: CommandContext): string | null => {
  const invoiceId = ctx.targetId;
  return typeof invoiceId === 'string' && AGGREGATE_ID_RE.test(invoiceId) && isUuid(ctx.storeId) && ctx.paymentId === undefined
    && ctx.creditNoteId === undefined ? invoiceId : null;
};

// ---------------------------------------------------------------------------
// The registration
// ---------------------------------------------------------------------------

/** The registration: a CREATE of an invoice_credit_note_registration, no event, the 'credit' refusals (header). */
export const INVOICE_CREDIT_NOTE_REGISTER_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_credit_note.register',
  mode: 'create',
  aggregateType: 'invoice_credit_note_registration',
  contextScope: 'store',
  changes: Object.freeze({ invoiceId: ID_FIELD, expectedTenant: ID_FIELD, attemptId: ID_FIELD, grossCents: GROSS_FIELD, reason: REASON_FIELD }),
  events: Object.freeze([]),
  paymentRefusals: 'credit',
});

const REGISTER_BODY_KEYS: readonly string[] = ['expectedTenant', 'attemptId', 'grossCents', 'reason'];

/**
 * The registration's plan from its context alone, or COMMAND_REQUEST_INVALID: the runtime's new id as the registration, the
 * path's invoice, the four body values (the amount and the reason BOUND, D-CN-9), no event, and the sealed 201 — never a proof.
 */
export function planInvoiceCreditNoteRegister(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = invoiceOf(ctx);
  const registrationId = ctx.newAggregateId;
  if (invoiceId === null || !isUuid(registrationId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, REGISTER_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, attemptId, grossCents, reason } = body;
  if (!isUuid(expectedTenant) || !isUuid(attemptId) || !isAmount(grossCents, 1) || !isInvoiceCreditNoteReason(reason)) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: registrationId,
    expectedVersion: null,
    changes: { invoiceId, expectedTenant, attemptId, grossCents, reason },
    events: [],
    response: { status: 201, body: { registration: { id: registrationId, invoiceId, attemptId, grossCents, reason, state: 'open' } } },
  };
}

const REGISTER_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_CREDIT_NOTE_REGISTER_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_CREDIT_NOTE_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  // D-CN-7 A / recovery contract: the shop steps up BEFORE registering, so the issue's session is the registering one.
  recentAuth: 'required',
  // D-CN-9 step 1: the session's digest joins the fingerprint (routes.ts SESSION_BOUND_STORE_COMMANDS).
  sessionBinding: 'required',
  command: Object.freeze({ contract: INVOICE_CREDIT_NOTE_REGISTER_CONTRACT, plan: planInvoiceCreditNoteRegister }),
};
/** The registration route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_CREDIT_NOTE_REGISTER_ROUTE: RouteDefinition = Object.freeze(REGISTER_ROUTE);

// ---------------------------------------------------------------------------
// The issue
// ---------------------------------------------------------------------------

/** The issue: a CREATE of an invoice_credit_note (D-CN-9: its kind is in NOT_FOUND_CREATE_KINDS), no event, 'credit'. */
export const INVOICE_CREDIT_NOTE_ISSUE_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_credit_note.issue',
  mode: 'create',
  aggregateType: 'invoice_credit_note',
  contextScope: 'store',
  changes: Object.freeze({
    invoiceId: ID_FIELD, expectedTenant: ID_FIELD, registrationId: ID_FIELD, attemptId: ID_FIELD, grossCents: GROSS_FIELD, reason: REASON_FIELD,
    // The registration's proof: a SQL parameter only; it reaches no answer or audit row.
    registrationProof: Object.freeze({ type: 'string', maxLength: INVOICE_CREDIT_NOTE_PROOF_LENGTH } as const),
  }),
  events: Object.freeze([]),
  paymentRefusals: 'credit',
});

const ISSUE_BODY_KEYS: readonly string[] = ['expectedTenant', 'registrationId', 'attemptId', 'grossCents', 'reason', 'registrationProof'];

/**
 * The issue's plan, or COMMAND_REQUEST_INVALID: the runtime's new id as the credit note, the path's invoice and the six body
 * values, no event, and the sealed 201 — which carries no number (doc 16 §8; the list shows it).
 */
export function planInvoiceCreditNoteIssue(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = invoiceOf(ctx);
  const creditNoteId = ctx.newAggregateId;
  if (invoiceId === null || !isUuid(creditNoteId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, ISSUE_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, registrationId, attemptId, grossCents, reason, registrationProof } = body;
  if (!isUuid(expectedTenant) || !isUuid(registrationId) || !isUuid(attemptId) || !isAmount(grossCents, 1) || !isInvoiceCreditNoteReason(reason)
    || !isProof(registrationProof)) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: creditNoteId,
    expectedVersion: null,
    changes: { invoiceId, expectedTenant, registrationId, attemptId, grossCents, reason, registrationProof },
    events: [],
    response: { status: 201, body: { creditNote: { id: creditNoteId, invoiceId, attemptId, grossCents, reason } } },
  };
}

const ISSUE_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_CREDIT_NOTES_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_CREDIT_NOTE_ISSUE_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_CREDIT_NOTE_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  recentAuth: 'required',
  sessionBinding: 'required',
  command: Object.freeze({ contract: INVOICE_CREDIT_NOTE_ISSUE_CONTRACT, plan: planInvoiceCreditNoteIssue }),
};
/** The issue route, as the tenant inventory registers it. */
export const INVOICE_CREDIT_NOTE_ISSUE_ROUTE: RouteDefinition = Object.freeze(ISSUE_ROUTE);

// ---------------------------------------------------------------------------
// The settlement
// ---------------------------------------------------------------------------

/** The settlement: an UPDATE of the caller's registration of one attempt at version 1 or 2, no event (header). */
export const INVOICE_CREDIT_NOTE_SETTLE_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_credit_note.settle',
  mode: 'update',
  aggregateType: 'invoice_credit_note_registration',
  contextScope: 'store',
  changes: Object.freeze({ invoiceId: ID_FIELD, expectedTenant: ID_FIELD, attemptId: ID_FIELD }),
  events: Object.freeze([]),
});

const SETTLE_BODY_KEYS: readonly string[] = ['expectedTenant', 'attemptId', 'expectedVersion'];

/**
 * The settlement's plan, or COMMAND_REQUEST_INVALID: the body's attempt (the aggregate) at the body's version, 1 ("release
 * the unused registration") or 2 ("confirm the issued one"); the sealed 200, also the answer for the same settlement already in
 * place (038's 'unchanged', no audit record).
 */
export function planInvoiceCreditNoteSettle(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = invoiceOf(ctx);
  if (invoiceId === null) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, SETTLE_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, attemptId, expectedVersion } = body;
  if (!isUuid(expectedTenant) || !isUuid(attemptId) || (expectedVersion !== 1 && expectedVersion !== 2)) return COMMAND_REQUEST_INVALID;
  const response = { status: 200, body: { settlement: { invoiceId, attemptId, state: SETTLED_STATES[expectedVersion] } } };
  return { aggregateId: attemptId, expectedVersion, changes: { invoiceId, expectedTenant, attemptId }, events: [], response, unchanged: response };
}

const SETTLE_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_CREDIT_NOTE_SETTLE_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_CREDIT_NOTE_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  // The recovery contract: settlement moves no value, so it needs no recent sign-in (a non-sensitive key).
  recentAuth: 'none',
  command: Object.freeze({ contract: INVOICE_CREDIT_NOTE_SETTLE_CONTRACT, plan: planInvoiceCreditNoteSettle }),
};
/** The settlement route, as the tenant inventory registers it. */
export const INVOICE_CREDIT_NOTE_SETTLE_ROUTE: RouteDefinition = Object.freeze(SETTLE_ROUTE);

// ---------------------------------------------------------------------------
// The withdrawal
// ---------------------------------------------------------------------------

/** The withdrawal: an UPDATE of the credit note at version 1 (D-CN-9: its kind is in PRECONDITION_UPDATE_KINDS), no event. */
export const INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_credit_note.withdraw',
  mode: 'update',
  aggregateType: 'invoice_credit_note',
  contextScope: 'store',
  changes: Object.freeze({
    invoiceId: ID_FIELD, expectedTenant: ID_FIELD,
    reason: Object.freeze({ type: 'enum', values: INVOICE_CREDIT_NOTE_WITHDRAWAL_REASONS } as const),
  }),
  events: Object.freeze([]),
});

const WITHDRAW_BODY_KEYS: readonly string[] = ['expectedTenant', 'expectedVersion', 'reason'];

/**
 * The withdrawal's plan, or COMMAND_REQUEST_INVALID: the path's credit note at version 1 exactly (the body must say 1), the
 * path's invoice and the reason, no event, and the sealed 200.
 */
export function planInvoiceCreditNoteWithdraw(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const invoiceId = ctx.targetId;
  const creditNoteId = ctx.creditNoteId;
  if (typeof invoiceId !== 'string' || !AGGREGATE_ID_RE.test(invoiceId) || typeof creditNoteId !== 'string' || !AGGREGATE_ID_RE.test(creditNoteId)
    || !isUuid(ctx.storeId) || ctx.paymentId !== undefined) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, WITHDRAW_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, expectedVersion, reason } = body;
  if (!isUuid(expectedTenant) || expectedVersion !== ACTIVE_CREDIT_NOTE_VERSION || !isInvoiceCreditNoteWithdrawalReason(reason)) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: creditNoteId,
    expectedVersion: ACTIVE_CREDIT_NOTE_VERSION,
    changes: { invoiceId, expectedTenant, reason },
    events: [],
    response: { status: 200, body: { creditNote: { id: creditNoteId, invoiceId, status: INVOICE_CREDIT_NOTE_WITHDRAWN_STATUS } } },
  };
}

const WITHDRAW_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_CREDIT_NOTE_WITHDRAW_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_CREDIT_NOTE_WITHDRAW_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_CREDIT_NOTE_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  trustedContext: 'required',
  recentAuth: 'required',
  command: Object.freeze({ contract: INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT, plan: planInvoiceCreditNoteWithdraw }),
};
/** The withdrawal route, as the tenant inventory registers it. */
export const INVOICE_CREDIT_NOTE_WITHDRAW_ROUTE: RouteDefinition = Object.freeze(WITHDRAW_ROUTE);

// ---------------------------------------------------------------------------
// The reads: the proof, the attempts and the list
// ---------------------------------------------------------------------------

/**
 * The port to 038's session-bound reads, each handed the trusted STORE scope (its tenant and store are the routine's expected
 * ones) and the presenting session's key (a SQL parameter only). Answers are untrusted input, expected to be
 *   proof:    { outcome: 'proof', registrationId, invoiceId, attemptId, proof } | { outcome: 'denied' | 'not_found' }
 *   attempts: { outcome: 'attempts', attempts: InvoiceCreditNoteAttempt-shaped[] (at most 51) } | { outcome: 'denied' | 'cursor_unknown' }
 *   list:     { outcome: 'credit_notes', invoiceId, namesVisible, creditNotes: row-shaped[] (at most 51) }
 *             | { outcome: 'denied' | 'not_found' | 'cursor_unknown' }
 * A throw — 038's fail-closed raises included — is an outage. The proof is handed the route's own deadline and settles within
 * it: 038's 'not_durable' is the port's alone (it commits and may ask once more in a fresh transaction).
 */
export interface InvoiceCreditNotesPort {
  proof(scope: TrustedScope, sessionKey: string, invoiceId: string, registrationId: string, signal: AbortSignal, deadlineMs: number): unknown;
  attempts(scope: TrustedScope, sessionKey: string, after: InvoiceCreditNoteAttemptsCursor | null, signal: AbortSignal): unknown;
  list(scope: TrustedScope, sessionKey: string, invoiceId: string, after: string | null, signal: AbortSignal): unknown;
}
/** What the three read routes are built from. */
export interface InvoiceCreditNotesPorts {
  readonly invoiceCreditNotes: InvoiceCreditNotesPort;
}
/** The attempts read's cursor: the last row's invoice and attempt. */
export interface InvoiceCreditNoteAttemptsCursor {
  readonly invoiceId: string;
  readonly attemptId: string;
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The trusted STORE scope and session key a store read needs, or null (invoicePayments.ts readerOf, restated). */
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
const UUID_GROUP = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const queryOf = (target: string): string | null => {
  const at = target.indexOf('?');
  return at < 0 ? null : target.slice(at + 1);
};

function portOf(ports: InvoiceCreditNotesPorts, method: 'proof' | 'attempts' | 'list', deadlineMs: number): InvoiceCreditNotesPort {
  const port = ports?.invoiceCreditNotes;
  if (typeof port?.[method] !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) throw new EnforcementSetupError('port_deadline_invalid');
  return port;
}

// --- The proof -------------------------------------------------------------

const REGISTRATION_QUERY_RE = new RegExp(`^registration=${UUID_GROUP}$`);
/** The proof read's query: exactly `registration=<canonical uuid>`; null for anything else, none included. */
export function parseCreditNoteProofQuery(target: string): { readonly registrationId: string } | null {
  if (typeof target !== 'string') return null;
  const query = queryOf(target);
  const match = query === null ? null : REGISTRATION_QUERY_RE.exec(query);
  return match === null ? null : Object.freeze({ registrationId: match[1] });
}

/** The proof port's answer, 'denied', 'not_found', or null for anything out of shape. Never throws. */
export function creditNoteProofOf(raw: unknown, invoiceId: string, registrationId: string):
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

/**
 * One registration's proof: the query exactly `registration=<id>`, the scope, the id segment, then 038's proof routine. 200
 * exactly { registration: { id, invoiceId, attemptId }, proof }; 400; 403; 404 not_found (every mismatch alike); 503.
 */
export function createInvoiceCreditNoteProofRoute(ports: InvoiceCreditNotesPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  const port = portOf(ports, 'proof', deadlineMs);
  return readRoute(INVOICE_CREDIT_NOTE_PROOF_PATH, INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT, async (req, res, ctx) => {
    const query = parseCreditNoteProofQuery(urlOf(req));
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_credit_note_proof_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const invoiceId = pathIdBeforeSuffixOf(pathOf(req), PROOF_SUFFIX);
    if (invoiceId === null) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => port.proof(reading.scope, reading.sessionKey, invoiceId, query.registrationId, signal, deadlineMs));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_credit_note_proof', err));
    }
    const answer = creditNoteProofOf(raw, invoiceId, query.registrationId);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_credit_note_proof_denied');
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'invoice_credit_note_registration_not_found');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_credit_note_proof_answer_invalid');
    res.status(200).json({ registration: { id: query.registrationId, invoiceId, attemptId: answer.attemptId }, proof: answer.proof });
  });
}

// --- The attempts ----------------------------------------------------------

/** One registration of the caller as the attempts read serves it (never its id). */
export interface InvoiceCreditNoteAttempt {
  readonly invoiceId: string;
  readonly invoiceNumber: number;
  readonly attemptId: string;
  readonly state: InvoiceCreditNoteAttemptState;
  readonly version: number;
  readonly registeredAt: string;
  readonly settledAt: string | null;
  readonly grossCents: number;
  readonly reason: InvoiceCreditNoteReason;
  readonly creditNote: Readonly<{ id: string; issuedAt: string; withdrawnAt: string | null }> | null;
}

const ATTEMPT_KEYS: readonly string[] = ['invoiceId', 'invoiceNumber', 'attemptId', 'state', 'version', 'registeredAt', 'settledAt', 'grossCents', 'reason', 'creditNote'];

function attemptOf(raw: unknown): InvoiceCreditNoteAttempt | null {
  if (!isRecord(raw) || !hasExactly(raw, ATTEMPT_KEYS)) return null;
  const { invoiceId, invoiceNumber, attemptId, state, version, registeredAt, settledAt, grossCents, reason, creditNote } = raw;
  if (!isUuid(invoiceId) || !isAmount(invoiceNumber, 1) || !isUuid(attemptId) || !isDraftCreatedAt(registeredAt)) return null;
  if (!isAmount(grossCents, 1) || !isInvoiceCreditNoteReason(reason)) return null;
  if (typeof state !== 'string' || !(INVOICE_CREDIT_NOTE_ATTEMPT_STATES as readonly string[]).includes(state)) return null;
  const word = state as InvoiceCreditNoteAttemptState;
  // The state, its version, its settlement time and its credit note agree (038's derivation): settled iff released or
  // confirmed, a credit note iff issued or confirmed; a settlement at or after the registration.
  const settled = word === 'released' || word === 'confirmed';
  const issued = word === 'issued' || word === 'confirmed';
  if (version !== STATE_VERSIONS[word] || (settledAt === null) === settled || (creditNote === null) === issued) return null;
  if (settledAt !== null && (!isDraftCreatedAt(settledAt) || settledAt < registeredAt)) return null;
  const base = { invoiceId, invoiceNumber, attemptId, state: word, version, registeredAt, settledAt: settledAt as string | null, grossCents, reason };
  if (creditNote === null) return Object.freeze({ ...base, creditNote: null });
  if (!isRecord(creditNote) || !hasExactly(creditNote, ['id', 'issuedAt', 'withdrawnAt'])) return null;
  const { id, issuedAt, withdrawnAt } = creditNote;
  if (!isUuid(id) || !isDraftCreatedAt(issuedAt) || issuedAt < registeredAt) return null;
  // A confirmation settles an issued registration: never before its credit note was issued.
  if (settledAt !== null && (settledAt as string) < issuedAt) return null;
  if (withdrawnAt !== null && (!isDraftCreatedAt(withdrawnAt) || withdrawnAt < issuedAt)) return null;
  return Object.freeze({ ...base, creditNote: Object.freeze({ id, issuedAt, withdrawnAt: withdrawnAt as string | null }) });
}

/**
 * The attempts port's answer as a validated page ({ attempts, hasMore }), 'denied', 'cursor_unknown', or null for anything out
 * of shape. Never throws. The page is strictly ordered by (registeredAt, invoiceId, attemptId), each pair once, at most 51.
 */
export function invoiceCreditNoteAttemptsOf(raw: unknown, after: InvoiceCreditNoteAttemptsCursor | null):
  Readonly<{ attempts: readonly InvoiceCreditNoteAttempt[]; hasMore: boolean }> | 'denied' | 'cursor_unknown' | null {
  try {
    if (!isRecord(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'cursor_unknown') {
      return hasExactly(raw, ['outcome']) && (outcome !== 'cursor_unknown' || after !== null) ? outcome : null;
    }
    if (outcome !== 'attempts' || !hasExactly(raw, ['outcome', 'attempts'])) return null;
    const { attempts } = raw;
    if (!Array.isArray(attempts) || attempts.length > INVOICE_CREDIT_NOTE_ATTEMPTS_ASK) return null;
    const page: InvoiceCreditNoteAttempt[] = [];
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
    const hasMore = page.length > INVOICE_CREDIT_NOTE_ATTEMPTS_PAGE_SIZE;
    return Object.freeze({ attempts: Object.freeze(hasMore ? page.slice(0, INVOICE_CREDIT_NOTE_ATTEMPTS_PAGE_SIZE) : page), hasMore });
  } catch {
    return null; // a hostile getter: not in contract
  }
}

const ATTEMPTS_QUERY_RE = new RegExp(`^after=${UUID_GROUP}\\.${UUID_GROUP}$`);
/** The attempts read's query: none ({ after: null }), or exactly `after=<invoice uuid>.<attempt uuid>` (the served nextCursor). */
export function parseCreditNoteAttemptsQuery(target: string): { readonly after: InvoiceCreditNoteAttemptsCursor | null } | null {
  if (typeof target !== 'string') return null;
  const query = queryOf(target);
  if (query === null) return Object.freeze({ after: null });
  const match = ATTEMPTS_QUERY_RE.exec(query);
  return match === null ? null : Object.freeze({ after: Object.freeze({ invoiceId: match[1], attemptId: match[2] }) });
}

/**
 * The caller's own credit-note registrations at the path's store: no query or exactly `after=<invoice>.<attempt>`. 200 exactly
 * { attempts, nextCursor }; 400 (a bad query or an unknown cursor); 403; 503. Never a registration id.
 */
export function createInvoiceCreditNoteAttemptsRoute(ports: InvoiceCreditNotesPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  const port = portOf(ports, 'attempts', deadlineMs);
  return readRoute(INVOICE_CREDIT_NOTE_ATTEMPTS_PATH, INVOICE_CREDIT_NOTE_RECOVER_REQUIREMENT, async (req, res, ctx) => {
    const query = parseCreditNoteAttemptsQuery(urlOf(req));
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_credit_note_attempts_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => port.attempts(reading.scope, reading.sessionKey, query.after, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_credit_note_attempts', err));
    }
    const page = invoiceCreditNoteAttemptsOf(raw, query.after);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_credit_note_attempts_denied');
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'invoice_credit_note_attempts_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_credit_note_attempts_answer_invalid');
    const last = page.attempts[page.attempts.length - 1];
    res.status(200).json({
      attempts: page.attempts.map((a) => ({
        invoiceId: a.invoiceId, invoiceNumber: a.invoiceNumber, attemptId: a.attemptId, state: a.state, version: a.version,
        registeredAt: a.registeredAt, settledAt: a.settledAt, grossCents: a.grossCents, reason: a.reason,
        creditNote: a.creditNote === null ? null : { id: a.creditNote.id, issuedAt: a.creditNote.issuedAt, withdrawnAt: a.creditNote.withdrawnAt },
      })),
      nextCursor: page.hasMore && last !== undefined ? `${last.invoiceId}.${last.attemptId}` : null,
    });
  });
}

// --- The list --------------------------------------------------------------

/** One credit note as the list serves it. The two names exist ONLY when the routine said names are visible. */
export interface InvoiceCreditNote {
  readonly id: string;
  readonly number: number;
  readonly grossCents: number;
  readonly taxCents: number;
  readonly netCents: number;
  readonly reason: InvoiceCreditNoteReason;
  readonly issuedAt: string;
  readonly issuedByName?: string | null;
  readonly withdrawal: Readonly<{ withdrawnAt: string; reason: InvoiceCreditNoteWithdrawalReason; withdrawnByName?: string | null }> | null;
}
/** One validated page of the list. */
export interface InvoiceCreditNotesPage {
  readonly namesVisible: boolean;
  readonly creditNotes: readonly InvoiceCreditNote[];
  readonly hasMore: boolean;
}

const LIST_ANSWER_KEYS: readonly string[] = ['outcome', 'invoiceId', 'namesVisible', 'creditNotes'];
const NOTE_KEYS: readonly string[] = ['id', 'number', 'grossCents', 'taxCents', 'netCents', 'reason', 'issuedAt', 'issuedByName', 'withdrawal'];
const WITHDRAWAL_KEYS: readonly string[] = ['withdrawnAt', 'reason', 'withdrawnByName'];
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** A staff display name as the owner may see it: a bounded string with no control character, or null (never set). */
const isName = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v.length <= INVOICE_CREDIT_NOTE_NAME_MAX_LENGTH && !CONTROL_RE.test(v));

function noteOf(raw: unknown, namesVisible: boolean): InvoiceCreditNote | null {
  if (!isRecord(raw) || !hasExactly(raw, NOTE_KEYS)) return null;
  const { id, number, grossCents, taxCents, netCents, reason, issuedAt, issuedByName, withdrawal } = raw;
  if (!isUuid(id) || !isAmount(number, 1) || !isAmount(grossCents, 1) || !isAmount(taxCents, 0) || !isAmount(netCents, 0)) return null;
  // gross = tax + net, each within 0..gross (038's CHECK).
  if (taxCents > grossCents || netCents !== grossCents - taxCents) return null;
  if (!isInvoiceCreditNoteReason(reason) || !isDraftCreatedAt(issuedAt)) return null;
  // Names: exactly null when not visible (the server then omits the field); a bounded name or null when visible.
  if (namesVisible ? !isName(issuedByName) : issuedByName !== null) return null;
  const named = <T extends object>(value: T, key: string, name: unknown): T => (namesVisible ? { ...value, [key]: name } : value);
  if (withdrawal === null) return Object.freeze(named({ id, number, grossCents, taxCents, netCents, reason, issuedAt, withdrawal: null }, 'issuedByName', issuedByName));
  if (!isRecord(withdrawal) || !hasExactly(withdrawal, WITHDRAWAL_KEYS)) return null;
  const { withdrawnAt, reason: withdrawalReason, withdrawnByName } = withdrawal;
  if (!isDraftCreatedAt(withdrawnAt) || withdrawnAt < issuedAt || !isInvoiceCreditNoteWithdrawalReason(withdrawalReason)) return null;
  if (namesVisible ? !isName(withdrawnByName) : withdrawnByName !== null) return null;
  const checkedWithdrawal = Object.freeze(named({ withdrawnAt, reason: withdrawalReason }, 'withdrawnByName', withdrawnByName));
  return Object.freeze(named({ id, number, grossCents, taxCents, netCents, reason, issuedAt, withdrawal: checkedWithdrawal }, 'issuedByName', issuedByName));
}

/**
 * The list port's answer as a validated page, 'denied', 'not_found', 'cursor_unknown' — or null for anything out of shape.
 * Never throws. The page is strictly ordered by (issuedAt, id), ids and numbers distinct, none the cursor, at most 51.
 */
export function invoiceCreditNotesOf(raw: unknown, invoiceId: string, after: string | null):
  InvoiceCreditNotesPage | 'denied' | 'not_found' | 'cursor_unknown' | null {
  try {
    if (!isRecord(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found' || outcome === 'cursor_unknown') {
      return hasExactly(raw, ['outcome']) && (outcome !== 'cursor_unknown' || after !== null) ? outcome : null;
    }
    if (outcome !== 'credit_notes' || !hasExactly(raw, LIST_ANSWER_KEYS) || raw.invoiceId !== invoiceId) return null;
    const { namesVisible, creditNotes } = raw;
    if (typeof namesVisible !== 'boolean' || !Array.isArray(creditNotes) || creditNotes.length > INVOICE_CREDIT_NOTES_ASK) return null;
    const page: InvoiceCreditNote[] = [];
    const ids = new Set<string>();
    const numbers = new Set<number>();
    // inv: page holds a checked copy of each note below i, ids and numbers distinct, none the cursor, strictly ordered by (issuedAt, id).
    for (let i = 0; i < creditNotes.length; i++) {
      const note = noteOf(creditNotes[i], namesVisible);
      if (note === null || ids.has(note.id) || numbers.has(note.number) || note.id === after) return null;
      const prev = page[page.length - 1];
      if (prev !== undefined && !(prev.issuedAt < note.issuedAt || (prev.issuedAt === note.issuedAt && prev.id < note.id))) return null;
      ids.add(note.id);
      numbers.add(note.number);
      page.push(note);
    }
    const hasMore = page.length > INVOICE_CREDIT_NOTES_PAGE_SIZE;
    return Object.freeze({ namesVisible, creditNotes: Object.freeze(hasMore ? page.slice(0, INVOICE_CREDIT_NOTES_PAGE_SIZE) : page), hasMore });
  } catch {
    return null; // a hostile getter: not in contract
  }
}

const LIST_QUERY_RE = new RegExp(`^after=${UUID_GROUP}$`);
/** The list's query: none ({ after: null }), or exactly `after=<canonical uuid>`; null for anything else, a bare `?` included. */
export function parseInvoiceCreditNotesQuery(target: string): { readonly after: string | null } | null {
  if (typeof target !== 'string') return null;
  const query = queryOf(target);
  if (query === null) return Object.freeze({ after: null });
  const match = LIST_QUERY_RE.exec(query);
  return match === null ? null : Object.freeze({ after: match[1] });
}

/**
 * One issued invoice's credit notes (header: THE LIST). 200 exactly { invoice: { id }, creditNotes, nextCursor }; 400 for any
 * other query, a bad id or an unknown cursor; 403; 404 not_found (missing, another store's, another tenant's alike); 503.
 */
export function createInvoiceCreditNotesRoute(ports: InvoiceCreditNotesPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  const port = portOf(ports, 'list', deadlineMs);
  return readRoute(INVOICE_CREDIT_NOTES_PATH, INVOICE_CREDIT_NOTES_VIEW_REQUIREMENT, async (req, res, ctx) => {
    const query = parseInvoiceCreditNotesQuery(urlOf(req));
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_credit_notes_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const invoiceId = pathIdBeforeSuffixOf(pathOf(req), CREDIT_NOTES_SUFFIX);
    if (invoiceId === null) return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => port.list(reading.scope, reading.sessionKey, invoiceId, query.after, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_credit_notes', err));
    }
    const page = invoiceCreditNotesOf(raw, invoiceId, query.after);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_credit_notes_denied');
    if (page === 'not_found') return refuse(res, ctx, 404, 'not_found', 'invoice_credit_notes_not_found');
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'invoice_credit_notes_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_credit_notes_answer_invalid');
    const last = page.creditNotes[page.creditNotes.length - 1];
    // The names are copied only when visible; otherwise the fields are absent from the body (doc 16 CN-33).
    const nameOf = (key: string, value: string | null | undefined): Record<string, string | null> => (page.namesVisible ? { [key]: value ?? null } : {});
    res.status(200).json({
      invoice: { id: invoiceId },
      creditNotes: page.creditNotes.map((n) => ({
        id: n.id, number: n.number, grossCents: n.grossCents, taxCents: n.taxCents, netCents: n.netCents, reason: n.reason, issuedAt: n.issuedAt,
        ...nameOf('issuedByName', n.issuedByName),
        withdrawal: n.withdrawal === null ? null : {
          withdrawnAt: n.withdrawal.withdrawnAt, reason: n.withdrawal.reason, ...nameOf('withdrawnByName', n.withdrawal.withdrawnByName),
        },
      })),
      nextCursor: page.hasMore && last !== undefined ? last.id : null,
    });
  });
}
