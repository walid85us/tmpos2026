// Phase 4.0 M7b — voiding an issued store invoice: the void command and its action-only eligibility (M7B-INVOICES-VOID-P1;
// docs/phase-4/13, ADR-51, D-VOID-1..6; G-IAM, G-ISOLATION, G-PERSIST, G-IDEMPOT, G-AUDIT; migration 035, schema
// tmpos_invoice_void).
//
// THE TWO ROUTES, the route table's closed STORE templates (routes.ts), each a session route of the TENANT boundary
// requiring the STORE-scope permission void_issued_invoices (m5CanonicalPermissions.ts STORE_ROUTE_PERMISSIONS):
//   GET  /api/v1/stores/{storeId}/invoices/{id}/void-eligibility — whether a void would be authorized at that store now
//   POST /api/v1/stores/{storeId}/invoices/{id}/void             — void the issued invoice (a command, under a key, on a recent sign-in)
// The {storeId} segment is a REQUESTED TARGET, exactly as for the issue (invoiceIssuing.ts): the tenant authorizer selects
// the actor's own store grant at exactly that store and hands a STORE trusted scope, the only tenant and store anything
// here treats as authority. void_issued_invoices: the store grant's role at Invoices Approve or above AND Customers View or
// above (the same role), never under read-only; store_owner is Full where it holds a store grant. No role-name, System Owner
// or creator shortcut, no plan gate. It is SENSITIVE: the POST declares a recent sign-in (10 minutes), judged by the chain
// on the runtime clock, by the revalidator, by 035's routine itself and by the mutator after the routine on the database
// clock (postgresInvoiceVoid.ts). Every path id selects a resource; none grants.
//
// THE VOID (D-VOID-1). A terminal logical void, once: the invoice keeps its number, its issued snapshot and its source
// draft; nothing is refunded, credited, reversed or erased, and there is no unvoid. Request exactly { expectedTenant,
// reasonCode } — no version, no other key: expectedTenant a canonical lowercase uuid (a PRECONDITION: another tenant is the
// unsealed 409 write_conflict, rolled back); reasonCode one of INVOICE_VOID_REASON_CODES (no free text exists anywhere).
// Any other body is the 400 invalid_request, after the key is taken. The path's invoice id must match the outbox's
// aggregate-id shape, as the issue's draft id. The body is bounded at 1 KiB. An UPDATE of the issued invoice
// (store.invoice.void, aggregate issued_invoice, context scope store) at expectedVersion 1 always: an issued invoice's
// lifecycle version is 1 while issued and 2 once voided — derived by 035 from its void record, never stored, never on the
// wire — and the routine decides already-void BEFORE the version (034's terminal-state precedent). In ONE transaction
// (postgresTransactionalStore.ts): the lease fence; the store-scope revalidation (void_issued_invoices decided again, its
// deadline required and judged on the database clock); the mutator's one call into tmpos_invoice_void.m7b_invoice_void, which
// re-derives the caller as 034's issue does, locks the issued header FOR UPDATE and decides, in order: authority (the 503) →
// expectedTenant (409, unsealed) → a missing, another store's or another tenant's invoice (one 404, rolled back) → a stale
// session or sign-in after the waits (the 503) → already void (sealed 409 invalid_state) → a lifecycle version other than 1
// (sealed 409 write_conflict, unreachable through HTTP: the planner pins 1) → one void record (reason code, the database's
// clock_timestamp(), the actor); the deadline judged once more; one audit record naming the issued invoice alone at store
// scope with the annex below; NO outbox event; the sealed 200; COMMIT. 200 { "invoice": { "id", "status": "voided" } } —
// built by the planner, nothing read back. A sealed refusal ({ "error": "invalid_state" } or { "error": "write_conflict" },
// no requestId) commits its completion and nothing else and is replayed for the same key and bytes under the chain's
// current checks; every other refusal is the chain's own { error, requestId } and commits nothing; a lost COMMIT answer is
// the bounded 503 (outcome unknown, the lease kept). A new key on a voided invoice is the sealed invalid_state (D-VOID-5).
// The key's own answers stand as for every command (idempotency.ts): a replay of a sealed answer carries Idempotent-Replayed:
// true; the same key while an unsealed attempt's lease is live is 409 request_in_progress, and with other bytes, another
// target or another route (an issue key on the void) 422 idempotency_key_reused — both the chain's { error, requestId }. No
// refusal releases or replaces a lease. A target or body the planner refuses is 400 invalid_request after the key is taken,
// never a 500.
//
// THE AUDIT ANNEX (D-VOID-4). reasonCode `invoice_void_<code>`; reason the fixed sentence "Issued invoice voided. Reason:
// <label>." from INVOICE_VOID_REASON_LABELS — never a customer, seller or line text. The audit record's time is the
// transaction's (audit_event.occurred_at's default); the void record's is clock_timestamp() after the routine's last lock:
// they differ, and nothing claims they are equal.
//
// THE ELIGIBILITY. The issue eligibility's form (invoiceIssuing.ts createInvoiceIssueEligibilityRoute, restated: that module
// imports this one, so this one may not import it): decided by the void's own requirement object, no query, the scope at
// the path's store, a canonical id segment, then 200 { "eligibility": "allowed" }. recentAuth 'none' (the sensitive
// settings read's precedent, issuingSettings.ts): action-only, it says the chain admits void_issued_invoices at that store
// now (levels, corequisite, standing) and NOTHING about the invoice — not that it exists, is this store's, is not already
// void, or that the sign-in is recent enough for the POST, which answers 403 step_up_required past 10 minutes. The detail
// read is the resource-specific review; the POST decides again. Target-blind: it reads no invoice and acquires no lease.
//
// DA-118 AND DA-119 STAY OPEN, WIDENED (R-SEC-01): a runtime-role holder with a live session key at Invoices >= Approve and
// Customers >= View can call 035's void routine directly and void with no audit record, no idempotency completion and none
// of these HTTP checks (the void record still names its actor); the routine's own sign-in check is minted evidence an
// issuer-key holder can mint fresh. Nothing here claims a direct routine call has the command path's audit coupling.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but its context and writes nothing.
import type { Response } from 'express';
import type { CommandContract } from './commandTransaction.js';
import { UUID_RE as AGGREGATE_ID_RE } from './outbox.js';
import type { TrustedScope } from './principals.js';
import {
  COMMAND_REQUEST_INVALID, PATH_ID_SEGMENT, STORE_DIRECTORY_PATH, STORE_SEGMENT, pathIdBeforeSuffixOf, storeTargetOf,
} from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteContext, RouteDefinition } from './routes.js';

/**
 * The closed reason codes, in their one order (contract §2): migration 035's CHECK, this enum and the shop's label map hold
 * the same six in the same order.
 */
export const INVOICE_VOID_REASON_CODES = Object.freeze(['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other'] as const);
export type InvoiceVoidReasonCode = (typeof INVOICE_VOID_REASON_CODES)[number];
/** Each code's label: the shop's text and the audit sentence's. */
export const INVOICE_VOID_REASON_LABELS: Readonly<Record<InvoiceVoidReasonCode, string>> = Object.freeze({
  issued_in_error: 'Issued by mistake',
  wrong_customer: 'Wrong customer',
  wrong_lines_or_amounts: 'Wrong lines or amounts',
  wrong_seller_details: 'Wrong seller details',
  duplicate: 'Duplicate of another invoice',
  other: 'Other reason',
});
/** Whether `v` is exactly one of the six codes. */
export const isInvoiceVoidReasonCode = (v: unknown): v is InvoiceVoidReasonCode =>
  typeof v === 'string' && (INVOICE_VOID_REASON_CODES as readonly string[]).includes(v);

const VOID_SUFFIX = '/void';
const VOID_ELIGIBILITY_SUFFIX = '/void-eligibility';
/** The two templates (routes.ts STORE_TEMPLATED_ROUTES), under the issued invoice's own path. */
export const INVOICE_VOID_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoices${PATH_ID_SEGMENT}${VOID_SUFFIX}`;
export const INVOICE_VOID_ELIGIBILITY_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoices${PATH_ID_SEGMENT}${VOID_ELIGIBILITY_SUFFIX}`;
/** The store route permission (m5CanonicalPermissions.ts): the void and its eligibility share it. */
export const INVOICE_VOID_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'void_issued_invoices' });
/** The void's body bound: 1 KiB — two keys, a uuid and a code fit well inside it. */
export const INVOICE_VOID_MAX_BODY_BYTES = 1024;
/** A voided invoice's status, on the 200 and on the issued reads. */
export const INVOICE_VOIDED_STATUS = 'voided';
/** The lifecycle version the void always expects: an issued invoice's (2 once voided, never stored). */
const ISSUED_LIFECYCLE_VERSION = 1;

/** A canonical lowercase uuid of any version: 034's and 035's columns accept every uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
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
// The void: its contract, its planner and its route
// ---------------------------------------------------------------------------

/**
 * The void: an update of the issued invoice that enqueues NO event (D-VOID-4) and opts into nothing — its sealed refusals
 * are the update vocabulary's own (invalid_state, conflict). Its change set carries the expected tenant and the reason code.
 */
export const INVOICE_VOID_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice.void',
  mode: 'update',
  aggregateType: 'issued_invoice',
  contextScope: 'store',
  changes: Object.freeze({
    expectedTenant: Object.freeze({ type: 'string', maxLength: 36 } as const),
    reasonCode: Object.freeze({ type: 'enum', values: INVOICE_VOID_REASON_CODES } as const),
  }),
  events: Object.freeze([]),
});

const VOID_BODY_KEYS: readonly string[] = ['expectedTenant', 'reasonCode'];

/**
 * The void's plan from its context alone, or COMMAND_REQUEST_INVALID (header: THE VOID): the path's invoice at lifecycle
 * version 1, the precondition and the code, no event, the audit annex and the sealed 200 — built from the plan alone, so it
 * is deterministic and sealed.
 */
export function planInvoiceVoid(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  // As the issue: the path's invoice id (read by app.ts before the route's own '/void' suffix) in the outbox's aggregate-id
  // shape, and the path's store, which app.ts proved is the trusted scope's.
  const invoiceId = ctx.targetId;
  if (typeof invoiceId !== 'string' || !AGGREGATE_ID_RE.test(invoiceId) || !isUuid(ctx.storeId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isPlain(body) || !hasExactly(body, VOID_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, reasonCode } = body;
  if (!isUuid(expectedTenant) || !isInvoiceVoidReasonCode(reasonCode)) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: invoiceId,
    expectedVersion: ISSUED_LIFECYCLE_VERSION,
    changes: { expectedTenant, reasonCode },
    events: [],
    response: { status: 200, body: { invoice: { id: invoiceId, status: INVOICE_VOIDED_STATUS } } },
    audit: { reasonCode: `invoice_void_${reasonCode}`, reason: `Issued invoice voided. Reason: ${INVOICE_VOID_REASON_LABELS[reasonCode]}.` },
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const VOID_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_VOID_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_VOID_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_VOID_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // As the issue: a resolved actor and store grant; the store binds the presenting session. Unlike the issue, a recent
  // sign-in (D-VOID-2): the chain refuses a stale one with 403 step_up_required before the body is read or a key taken.
  trustedContext: 'required',
  recentAuth: 'required',
  command: Object.freeze({ contract: INVOICE_VOID_CONTRACT, plan: planInvoiceVoid }),
};

/** The void route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_VOID_ROUTE: RouteDefinition = Object.freeze(VOID_ROUTE);

// ---------------------------------------------------------------------------
// The eligibility
// ---------------------------------------------------------------------------

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** Whether the trusted STORE scope and session key a store read needs are present (invoiceIssuing.ts readerOf, restated). */
function readable(req: { path?: unknown }, ctx: RouteContext): boolean {
  const scope: TrustedScope | null = ctx.trusted;
  if (scope === null || scope.scope !== 'store' || scope.tenant === null || scope.store === null) return false;
  return storeTargetOf(typeof req.path === 'string' ? req.path : '') === scope.store && ctx.sessionKey !== null;
}

/**
 * Whether the session's actor may void an issued invoice at the path's store now (header: THE ELIGIBILITY), decided under
 * INVOICE_VOID_REQUIREMENT — the void's own requirement object — with no recent sign-in. Target-blind: the same answer for
 * every well-formed id.
 */
export function createInvoiceVoidEligibilityRoute(): RouteDefinition {
  const route: RouteDefinition = {
    method: 'GET',
    path: INVOICE_VOID_ELIGIBILITY_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_VOID_REQUIREMENT } as const),
    body: Object.freeze({ kind: 'none' } as const),
    idempotency: 'none',
    trustedContext: 'required',
    recentAuth: 'none',
    sessionBinding: 'required',
    handler: (req, res, ctx) => {
      // The issue eligibility's order: the query, the scope, then the id segment (one canonical lowercase uuid).
      if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'invoice_void_eligibility_query_invalid');
      if (!readable(req, ctx)) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
      if (pathIdBeforeSuffixOf(typeof req.path === 'string' ? req.path : '', VOID_ELIGIBILITY_SUFFIX) === null) {
        return refuse(res, ctx, 400, 'invalid_request', 'issued_invoice_id_invalid');
      }
      res.status(200).json({ eligibility: 'allowed' });
    },
  };
  return Object.freeze(route);
}
