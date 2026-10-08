// Phase 4.0 M7b — store-owned invoice drafts: save one, list a store's, reopen one read-only (M7B-INVOICES-P1; G-IAM,
// G-ISOLATION, G-PERSIST, G-IDEMPOT, G-AUDIT; docs/phase-4/10), and edit a saved one (M7B-INVOICES-P2; see THE EDIT).
//
// THE SIX ROUTES, the route table's closed STORE templates (routes.ts), each a session route of the TENANT boundary
// requiring a STORE-scope permission (m5CanonicalPermissions.ts STORE_ROUTE_PERMISSIONS):
//   POST  /api/v1/stores/{storeId}/invoice-drafts              create_invoice_drafts — save a draft (a command, under a key)
//   GET   /api/v1/stores/{storeId}/invoice-drafts              view_invoice_drafts   — the store's drafts, newest first
//   GET   /api/v1/stores/{storeId}/invoice-drafts/{id}         view_invoice_drafts   — one draft and its lines (read-only)
//   GET   /api/v1/stores/{storeId}/invoice-drafts/eligibility  create_invoice_drafts — whether a save would be authorized now
//                                                                                     (M7B-INVOICES-P1-R2; see THE ELIGIBILITY)
//   PATCH /api/v1/stores/{storeId}/invoice-drafts/{id}         edit_invoice_drafts   — replace a draft's customer and lines
//                                                                                     (M7B-INVOICES-P2; a command, under a key)
//   GET   /api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility
//                                                              edit_invoice_drafts   — whether an edit would be authorized now
// The {storeId} segment is a REQUESTED TARGET: the chain hands it to the tenant authorizer, which selects the actor's OWN
// active store-scope grant at exactly that store (no tenant-to-store inheritance; none, two roles at one store, a foreign
// or missing store and a non-canonical segment are all the same 403), decides the permission on that grant's role and its
// TENANT's owner-edited levels, and hands the routes a STORE trusted scope. That scope's tenant and store are the only ones
// anything here treats as authority; the path is never read for authority.
//
// AUTHORITY. View or above on Invoices lists and reopens; Create or above on Invoices AND View or above on Customers (the
// same role: a draft names a customer of the store's tenant) saves. store_owner is Full at a store where it holds a store
// grant, and nowhere else; manager Full, technician View, sales_staff Create by default; a browser-only custom role has no
// server authority (a membership admits the four built-in roles only). A read-only account, tenant or store reads only.
// Inside the save's transaction the tenant store re-proves the store scope (the presenting session held, the actor's
// standing held and re-read, the grant at the trusted scope's own store re-selected, the levels re-decided), and migration
// 028's routine decides again under locks; the reads' routines re-derive everything from the session key.
//
// THE SAVE. Request { expectedTenant, customerId, currency: "USD", lines: [ { description, quantity, unitPriceCents } ] },
// no other key at either level. expectedTenant — the tenant GET /api/v1/stores answered for the store — is a PRECONDITION,
// never authority: another tenant is the unsealed 409 write_conflict, rolled back. customerId names a server customer of
// the store's tenant: a missing one and another tenant's are ONE sealed 422 { "error": "customer_not_found" } — decided
// after authority is established and before anything is written; its idempotency completion is all that commits, and a
// retry under the key replays it. Both ids are canonical lowercase uuids. 1-50 lines, in order. description: the customer
// name's pipeline (customerCreate.ts normalizePlainText) at 256 — trimmed, 1-256 Unicode scalar values, no C0 control (NUL
// included), DEL, C1 control, line or paragraph separator, lone surrogate or Bidi_Control character, at least one VISIBLE
// scalar. Migration 028's CHECK restates every rule PostgreSQL can represent; the RUNTIME-ONLY ones are NUL and the lone
// surrogate (text cannot hold either) and the visible-scalar rule. quantity: a safe integer >= 1; unitPriceCents: a safe
// integer >= 0 (-0 is refused, as every record refuses it); every quantity x unitPriceCents and their sum at most
// 9007199254740991 — computed in BigInt, never a float. The server derives the id, status, currency, version, creation
// time and subtotal; none is accepted. Any violation is the bounded 400 invalid_request (command_request_invalid), the
// attempt's lease waiting out its time. The body is bounded at 64 KiB (a worst-case escaped 50 x 256-scalar body does not
// fit: such a request is the 413).
//
// THE COMMAND (store.invoice_draft.create, mode create, aggregate invoice_draft, context scope store). Its change set carries
// values only: the store the path selected (which the mutator requires to equal the revalidated trusted store), the
// expected tenant, the customer, the subtotal and the lines as ONE bounded `rows` field (outbox.ts) — no SQL, relation or
// program. In ONE transaction (server/persistence/postgresTransactionalStore.ts): the lease fence; the store-scope
// revalidation; the mutator's one call into migration 028 (the customer check, the header and every line); one audit record
// (scope store, its tenant and store, the actor, the draft as subject_invoice_draft_id, metadata {}); one outbox event
// invoice_draft.created v1 { storeId, customerId, lineCount } (identifiers and a count; its envelope's tenant, store and
// actor slots stay null); the sealed 201 completion; COMMIT. 201 only after COMMIT: { "draft": { "id", "status": "draft",
// "currency": "USD", "lineCount", "subtotalCents" } } with Location /api/v1/stores/{storeId}/invoice-drafts/{id}. app.ts
// binds the trusted tenant, store and actor, the store target and the exact body bytes into the idempotency fingerprint. A
// lost COMMIT answer is the bounded 503 (outcome unknown; the lease is neither released nor replaced): a same-key retry
// replays what landed, or waits 409 until the lease expires and re-plans — with the current authority required each time.
//
// THE READS. List: query `limit` (1-50, default 20) and `cursor` only, each at most once; nothing else. Newest first by
// (createdAt, id). The cursor is opaque: the unpadded base64url of a tag byte (0x01) and the last served draft's 16 id
// bytes — 23 characters, its canonical spelling only. It carries no time and no authority: migration 028's routine
// re-reads that anchor's creation time INSIDE the trusted tenant and store, so precision is kept, equal times are ordered
// by id and neither dropped nor repeated, and an unknown, foreign or malformed cursor is the same bounded 400. Answer
// { "drafts": [ { "id", "customerId", "status", "currency", "lineCount", "subtotalCents", "createdAt" } ], "nextCursor" },
// nextCursor only behind a full page. Get: { "draft": { "id", "storeId", "customerId", "status", "currency", "version",
// "createdAt", "subtotalCents", "lines": [ { "position", "description", "quantity", "unitPriceCents", "lineTotalCents" } ]
// } }; a missing id and another store's or tenant's are the same 404 not_found. createdAt is the database's UTC time with
// microseconds (YYYY-MM-DDTHH:MM:SS.ffffffZ). A draft names its customer by id only: a display name is the existing
// Customers-authorized read's to resolve. Both reads declare the session binding (the presenting session's CSRF token in
// X-TMPOS-Session-CSRF, even on GET) and hand their routine the session key; every answer is validated again here before
// it reaches a response, and anything out of shape is a bounded 503. No read writes an audit record (the customer reads'
// owner decision). Chain-wide headers mark every answer no-store.
//
// THE ELIGIBILITY (M7B-INVOICES-P1-R2, DA-201). A read-only answer to "may this session's actor save a draft at this store
// now?", decided by the SAME requirement object the save declares (INVOICE_DRAFT_CREATE_REQUIREMENT), so the chain's one
// tenant authorizer decides both with one evaluator: admission, the actor's own grant at exactly the path's store, that
// grant's role on its tenant's current server-saved levels (Invoices Create or above AND Customers View or above), a
// read-only or overdue account, tenant or store denied. It is a literal store template, so the segment 'eligibility' is never
// read as a draft id. Session-bound (the presenting session's CSRF token in X-TMPOS-Session-CSRF), no body, no idempotency,
// no recent sign-in, and no port: the handler refuses any query (400 invalid_request), states the trusted store scope at the
// path's store again (else 403 authz_context_missing) and answers 200 with exactly { "eligibility": "allowed" } — no role,
// level, grant, tenant, token or customer. Every refusal of the actor or the store is one 403 forbidden, the same body as
// the handler's own re-check: a denied role, a foreign, unknown or non-canonical store and a session-CSRF mismatch are the
// chain's (only the logged reason differs). 401 an invalid session, 429 the request limit (Retry-After),
// 503 an outage, 404 another host or path. It writes no business row: no draft, line, audit record, outbox event, lease,
// idempotency completion or role-level row; like every authorized read, a 200 refreshes the session's lastSeenAt, and each
// request spends the request limit. It is a snapshot: the save decides again, under locks, when it commits (the transaction
// revalidator and migration 028's routine), and an "allowed" answer covers none of the save's own checks — its request
// security (Origin, Sec-Fetch-Site, X-TMPOS-CSRF), its body and customer, or its Idempotency-Key and lease.
//
// THE EDIT (M7B-INVOICES-P2). PATCH replaces the editable part of one saved draft: its customer and its COMPLETE ordered
// lines. Authority: edit_invoice_drafts — Invoices at Edit or above on the store grant's role, and nothing else (no
// Customers level; read-only never). Request { expectedTenant, expectedVersion, customerId, lines }, no other key at either
// level (a currency, a total, an id, a status or a creation time is the 400): expectedTenant is the save's precondition
// (another tenant is the same unsealed 409 write_conflict, rolled back); expectedVersion is the version the detail read
// reported, a safe integer from 1 to 2^53 - 2; customerId and the lines follow the save's contract exactly — the same
// helper validates both (draftLinesOf) and the server computes the subtotal. The path's draft id must match the outbox's
// aggregate-id shape (outbox.ts UUID_RE: a versioned, RFC-variant uuid) or the request is the 400: a stored id outside that
// shape is readable but not editable (a recorded residual — every id this runtime mints is a v4). The body is bounded at
// 64 KiB like the save's. app.ts binds the path's DRAFT id as the fingerprint's target and the trusted tenant, store and
// actor beside it, so one key at two drafts is the 422 and never a replay. In ONE transaction: the lease fence; the
// store-scope revalidation (Invoices Edit decided again); the mutator's one call into migration 029's routine, which
// decides authority again, then locks the draft header in the trusted tenant and store and judges its state and its version
// BEFORE the contents, then the replacement customer, then whether anything changes (and, only for a change, its role's
// Invoices level again under a lock). A real change replaces the lines, sets the customer and
// subtotal and steps the version by exactly one, with one audit record (action store.invoice_draft.update, the draft as
// its subject) and one outbox event invoice_draft.updated v1 { storeId, customerId, lineCount } (its envelope's aggregate
// version is the new version), and the sealed 200 { "draftId", "version": expectedVersion + 1, "changed": true }. The same
// customer and the same ordered lines (equal totals alone are not equal; reordering is a change) at the current version
// write nothing but the sealed 200 { "draftId", "version": expectedVersion, "changed": false } — no version step, no audit
// record, no event. Another version — a stale no-op included — is the sealed 409 { "error": "write_conflict" }; a draft
// whose state admits no edit is the sealed 409 { "error": "invalid_state" } (unreachable while migration 028 pins the status
// to draft); a missing draft, another store's or tenant's, and a missing or another tenant's customer are ONE unsealed 404
// not_found, rolled back. Each sealed answer is the key's completion: a retry under the key replays it, even after a later
// edit moved the version. A lost COMMIT answer is the bounded 503, as for the save.
//
// THE EDIT ELIGIBILITY (M7B-INVOICES-P2). The edit's counterpart of THE ELIGIBILITY above, decided by the edit's own
// requirement object (INVOICE_DRAFT_EDIT_REQUIREMENT) with exactly its conventions; the handler also refuses a draft id
// segment that is not a canonical lowercase uuid (the 400 the reopen route answers), after the chain's refusals and the
// scope check. It reads no draft, so its answer is the same for every well-formed id: it never tells whether a draft exists.
// The creation eligibility is unchanged and proves Create only; neither answer authorizes the other's route.
//
// NOT HERE (deferred, owner decisions): discarding or deleting a draft, issuing and numbering, tax, discounts, shipping,
// payments, fractional quantities, catalog prices, legacy customer or invoice mapping, retention and privacy.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but its context and writes nothing; the reads' port is handed in by the composition root.
import { Buffer } from 'node:buffer';
import type { Response } from 'express';
import type { CommandContract } from './commandTransaction.js';
import { normalizePlainText } from './customerCreate.js';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { UUID_RE as AGGREGATE_ID_RE } from './outbox.js';
import type { EventContract } from './outbox.js';
import type { TrustedScope } from './principals.js';
import {
  COMMAND_REQUEST_INVALID, EnforcementSetupError, PATH_ID_SEGMENT, STORE_DIRECTORY_PATH, STORE_SEGMENT, pathIdBeforeSuffixOf, pathIdOf, storeTargetOf,
} from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteContext, RouteDefinition, RouteHandler } from './routes.js';

/** The templates (routes.ts STORE_TEMPLATED_ROUTES). */
export const INVOICE_DRAFTS_PATH = `${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts`;
export const INVOICE_DRAFT_PATH = `${INVOICE_DRAFTS_PATH}${PATH_ID_SEGMENT}`;
/** The creation-eligibility template (M7B-INVOICES-P1-R2): a literal last segment, matched before INVOICE_DRAFT_PATH. */
export const INVOICE_DRAFT_ELIGIBILITY_PATH = `${INVOICE_DRAFTS_PATH}/eligibility`;
/** The edit-eligibility template's last segment, after the draft id (M7B-INVOICES-P2). */
const EDIT_ELIGIBILITY_SUFFIX = '/edit-eligibility';
/** The edit-eligibility template (M7B-INVOICES-P2): the draft's {id}, then one literal segment. */
export const INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH = `${INVOICE_DRAFT_PATH}${EDIT_ELIGIBILITY_SUFFIX}`;
/**
 * The store route permissions (m5CanonicalPermissions.ts): Invoices View; Invoices Create with Customers View; Invoices Edit
 * (M7B-INVOICES-P2: the edit and its eligibility share this one object).
 */
export const INVOICE_DRAFT_VIEW_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'view_invoice_drafts' });
export const INVOICE_DRAFT_CREATE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'create_invoice_drafts' });
export const INVOICE_DRAFT_EDIT_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'edit_invoice_drafts' });

/** Lines per draft, and a line description's length in Unicode scalar values (migration 028's CHECKs). */
export const INVOICE_DRAFT_MAX_LINES = 50;
export const INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS = 256;
/** The largest amount the API exposes: 2^53 - 1, the largest integer a JavaScript number holds exactly. */
export const INVOICE_DRAFT_MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
/** The save's body bound (the stage brief): 64 KiB. */
export const INVOICE_DRAFT_MAX_BODY_BYTES = 64 * 1024;
/** The list's page sizes. */
export const INVOICE_DRAFT_DEFAULT_LIMIT = 20;
export const INVOICE_DRAFT_MAX_LIMIT = 50;
export const INVOICE_DRAFT_CURRENCY = 'USD';
export const INVOICE_DRAFT_STATUS = 'draft';

/** A canonical lowercase uuid of any version: 028's columns accept every uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ---------------------------------------------------------------------------
// The command: its contract, its one event, its planner and its route
// ---------------------------------------------------------------------------

const ID_FIELD = Object.freeze({ type: 'string', maxLength: 36 } as const);
const AMOUNT_FIELD = Object.freeze({ type: 'integer', min: 0, max: INVOICE_DRAFT_MAX_AMOUNT } as const);

/** The one event a save enqueues (M7B-INVOICES-P1): identifiers and a count only — no description, amount or contact. */
export const INVOICE_DRAFT_CREATED_EVENT: EventContract = Object.freeze({
  type: 'invoice_draft.created',
  version: 1,
  aggregateType: 'invoice_draft',
  payload: Object.freeze({
    storeId: ID_FIELD, customerId: ID_FIELD, lineCount: Object.freeze({ type: 'integer', min: 1, max: INVOICE_DRAFT_MAX_LINES } as const),
  }),
});
/** The one event an edit that changed something enqueues (M7B-INVOICES-P2): the same identifiers and count, after the edit. */
export const INVOICE_DRAFT_UPDATED_EVENT: EventContract = Object.freeze({
  type: 'invoice_draft.updated',
  version: 1,
  aggregateType: 'invoice_draft',
  payload: INVOICE_DRAFT_CREATED_EVENT.payload,
});
/** The registry the tenant entry composes (its two event contracts; tenantEntry.ts). */
export const INVOICE_DRAFT_EVENTS: readonly EventContract[] = Object.freeze([INVOICE_DRAFT_CREATED_EVENT, INVOICE_DRAFT_UPDATED_EVENT]);

/**
 * The change set of the save and of the edit: the store the path selected, the expected tenant, the customer, the subtotal and
 * the lines as ONE rows field (outbox.ts). A description is bounded at 512 UTF-16 units here — 256 scalars at two units each
 * — and at 256 scalars by the planner.
 */
const DRAFT_CHANGES = Object.freeze({
  storeId: ID_FIELD,
  expectedTenant: ID_FIELD,
  customerId: ID_FIELD,
  subtotalCents: AMOUNT_FIELD,
  lines: Object.freeze({
    type: 'rows',
    maxRows: INVOICE_DRAFT_MAX_LINES,
    fields: Object.freeze({
      description: Object.freeze({ type: 'string', maxLength: INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS * 2 } as const),
      quantity: Object.freeze({ type: 'integer', min: 1, max: INVOICE_DRAFT_MAX_AMOUNT } as const),
      unitPriceCents: AMOUNT_FIELD,
    }),
  } as const),
});

export const INVOICE_DRAFT_CREATE_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_draft.create',
  mode: 'create',
  aggregateType: 'invoice_draft',
  changes: DRAFT_CHANGES,
  events: Object.freeze([Object.freeze({ type: INVOICE_DRAFT_CREATED_EVENT.type, version: INVOICE_DRAFT_CREATED_EVENT.version })]),
  contextScope: 'store',
  sealedRefusal: 'customer_not_found',
});

/**
 * The edit (M7B-INVOICES-P2): an update of the same aggregate with the save's change set, and its one event. No typed sealed
 * refusal: a missing or foreign customer is the update's unsealed 404, the same as a missing draft.
 */
export const INVOICE_DRAFT_UPDATE_CONTRACT: CommandContract = Object.freeze({
  kind: 'store.invoice_draft.update',
  mode: 'update',
  aggregateType: 'invoice_draft',
  changes: DRAFT_CHANGES,
  events: Object.freeze([Object.freeze({ type: INVOICE_DRAFT_UPDATED_EVENT.type, version: INVOICE_DRAFT_UPDATED_EVENT.version })]),
  contextScope: 'store',
});

/** A line description as it is stored, or null: the customer name's pipeline at 256 scalars. */
export function normalizeDraftDescription(raw: unknown): string | null {
  return normalizePlainText(raw, INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS);
}

const BODY_KEYS: readonly string[] = ['currency', 'customerId', 'expectedTenant', 'lines'];
const LINE_KEYS: readonly string[] = ['description', 'quantity', 'unitPriceCents'];
const MAX = BigInt(INVOICE_DRAFT_MAX_AMOUNT);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Exactly `keys` as own enumerable keys, in any order (a parsed JSON object: own data properties only). */
const hasKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
/** A safe integer at or above `min`, never -0. */
const isWhole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && !Object.is(v, -0);

/** A draft's lines as the save and the edit accept them, and their server-computed subtotal. */
export interface DraftLines {
  readonly rows: readonly { readonly description: string; readonly quantity: number; readonly unitPriceCents: number }[];
  readonly subtotalCents: number;
}

/**
 * The lines of a save or an edit body, validated and normalized, with their subtotal — or null for anything the line contract
 * refuses: 1-50 objects of exactly { description, quantity, unitPriceCents }, each description normalized, each quantity a
 * safe integer >= 1 and price a safe integer >= 0 (never -0), every line total and their sum at most 2^53 - 1 in BigInt.
 */
export function draftLinesOf(lines: unknown): DraftLines | null {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > INVOICE_DRAFT_MAX_LINES) return null;
  const rows: { description: string; quantity: number; unitPriceCents: number }[] = [];
  let sum = 0n;
  // inv: rows holds each line below i, validated, and sum their totals, each and the sum at most 2^53 - 1; term: i rises to lines.length.
  for (let i = 0; i < lines.length; i++) {
    const line: unknown = lines[i];
    if (!isObject(line) || !hasKeys(line, LINE_KEYS)) return null;
    const description = normalizeDraftDescription(line.description);
    const { quantity, unitPriceCents } = line;
    if (description === null || !isWhole(quantity, 1) || !isWhole(unitPriceCents, 0)) return null;
    const total = BigInt(quantity) * BigInt(unitPriceCents);
    sum += total;
    if (total > MAX || sum > MAX) return null;
    rows.push({ description, quantity, unitPriceCents });
  }
  return { rows, subtotalCents: Number(sum) }; // exact: at most 2^53 - 1
}

/** The save's plan from its context alone, or COMMAND_REQUEST_INVALID: the runtime's new id, the values, one event. */
export function planInvoiceDraftCreate(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  // The store the path selected (app.ts): the target the authorizer chose the grant at; the mutator requires it to be the
  // revalidated trusted store, so the Location below names the store the draft is saved at.
  const storeId = ctx.targetId;
  if (!isUuid(storeId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isObject(body) || !hasKeys(body, BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, customerId, currency, lines } = body;
  if (!isUuid(expectedTenant) || !isUuid(customerId) || currency !== INVOICE_DRAFT_CURRENCY) return COMMAND_REQUEST_INVALID;
  const valid = draftLinesOf(lines);
  if (valid === null) return COMMAND_REQUEST_INVALID;
  const { rows, subtotalCents } = valid;
  const id = ctx.newAggregateId;
  return {
    aggregateId: id,
    expectedVersion: null,
    changes: { storeId, expectedTenant, customerId, subtotalCents, lines: rows },
    events: [{ type: INVOICE_DRAFT_CREATED_EVENT.type, payload: { storeId, customerId, lineCount: rows.length } }],
    response: {
      status: 201,
      body: { draft: { id, status: INVOICE_DRAFT_STATUS, currency: INVOICE_DRAFT_CURRENCY, lineCount: rows.length, subtotalCents } },
      headers: { location: `${STORE_DIRECTORY_PATH}/${storeId}/invoice-drafts/${id}` },
    },
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const CREATE_ROUTE: RouteDefinition = {
  method: 'POST',
  path: INVOICE_DRAFTS_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_DRAFT_CREATE_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_DRAFT_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // A state-changing business route commits only under a RESOLVED actor and store grant; saving an unissued draft is not
  // sensitive enough to demand a fresh authentication. No session key reaches a handler: the store binds it.
  trustedContext: 'required',
  recentAuth: 'none',
  command: Object.freeze({ contract: INVOICE_DRAFT_CREATE_CONTRACT, plan: planInvoiceDraftCreate }),
};

/** The save route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_DRAFT_CREATE_ROUTE: RouteDefinition = Object.freeze(CREATE_ROUTE);

const UPDATE_BODY_KEYS: readonly string[] = ['customerId', 'expectedTenant', 'expectedVersion', 'lines'];

/**
 * The edit's plan from its context alone, or COMMAND_REQUEST_INVALID (M7B-INVOICES-P2; see THE EDIT): the path's draft and
 * store, the values, one event, and both 200s — built from the plan alone, so each is deterministic and sealed.
 */
export function planInvoiceDraftUpdate(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  // The path's draft id (app.ts: canonical lowercase), in the outbox's aggregate-id shape, so a bad id is this 400 and never
  // the 500 an unpreparable plan would be; and the path's store, which app.ts proved is the trusted scope's.
  const id = ctx.targetId;
  const storeId = ctx.storeId;
  if (typeof id !== 'string' || !AGGREGATE_ID_RE.test(id) || !isUuid(storeId)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (!isObject(body) || !hasKeys(body, UPDATE_BODY_KEYS)) return COMMAND_REQUEST_INVALID;
  const { expectedTenant, expectedVersion, customerId, lines } = body;
  if (!isUuid(expectedTenant) || !isUuid(customerId)) return COMMAND_REQUEST_INVALID;
  // 1..2^53 - 2, so expectedVersion + 1 is still exact and within the column's bound: a version is never wrapped or reset.
  if (!isWhole(expectedVersion, 1) || expectedVersion > Number.MAX_SAFE_INTEGER - 1) return COMMAND_REQUEST_INVALID;
  const valid = draftLinesOf(lines);
  if (valid === null) return COMMAND_REQUEST_INVALID;
  const { rows, subtotalCents } = valid;
  return {
    aggregateId: id,
    expectedVersion,
    changes: { storeId, expectedTenant, customerId, subtotalCents, lines: rows },
    events: [{ type: INVOICE_DRAFT_UPDATED_EVENT.type, payload: { storeId, customerId, lineCount: rows.length } }],
    response: { status: 200, body: { draftId: id, version: expectedVersion + 1, changed: true } },
    unchanged: { status: 200, body: { draftId: id, version: expectedVersion, changed: false } },
  };
}

// Frozen throughout, as the save's.
const UPDATE_ROUTE: RouteDefinition = {
  method: 'PATCH',
  path: INVOICE_DRAFT_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_DRAFT_EDIT_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: INVOICE_DRAFT_MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // As the save: a resolved actor and store grant, no fresh authentication; the store binds the presenting session.
  trustedContext: 'required',
  recentAuth: 'none',
  command: Object.freeze({ contract: INVOICE_DRAFT_UPDATE_CONTRACT, plan: planInvoiceDraftUpdate }),
};

/** The edit route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_DRAFT_UPDATE_ROUTE: RouteDefinition = Object.freeze(UPDATE_ROUTE);

// ---------------------------------------------------------------------------
// The reads: the cursor, the query, the answers' validation and the two routes
// ---------------------------------------------------------------------------

/** 17 bytes — a tag byte and a 16-byte draft id — as unpadded base64url. */
const CURSOR_RE = /^[A-Za-z0-9_-]{23}$/;
/** The drafts list's continuation tag (the shop client pins it). */
const CURSOR_TAG = 0x01;
const QUERY_PAIR_RE = /^(limit|cursor)=(.*)$/s;
const LIMIT_RE = /^[1-9][0-9]?$/;
/** One bound on the whole raw query: two keys, a two-digit limit and a 23-character cursor fit well inside it. */
const MAX_QUERY_LENGTH = 128;
/** The database's UTC creation time with microseconds (migration 028's rendering). */
const CREATED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const idBytesOf = (draftId: string): Buffer => Buffer.from(draftId.replace(/-/g, ''), 'hex');
function idOfBytes(bytes: Buffer): string | null {
  const hex = bytes.toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(id) ? id : null;
}

/** The opaque continuation for a page that ends at `draftId`. */
export function encodeInvoiceDraftCursor(draftId: string): string {
  return Buffer.concat([Buffer.from([CURSOR_TAG]), idBytesOf(draftId)]).toString('base64url');
}

/** The draft id a continuation names, or null unless it is exactly the canonical spelling of one. */
export function decodeInvoiceDraftCursor(cursor: string): string | null {
  if (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)) return null;
  const bytes = Buffer.from(cursor, 'base64url');
  // Canonical only: decoding ignores the unused low bits of the last character, so a re-encoding that differs means a
  // second spelling of the same bytes, which is refused rather than accepted.
  if (bytes.length !== 17 || bytes[0] !== CURSOR_TAG || bytes.toString('base64url') !== cursor) return null;
  return idOfBytes(bytes.subarray(1));
}

/** A list request, validated: the anchor a continuation names (or null for the first page) and the page size. */
export interface InvoiceDraftListQuery {
  readonly after: string | null;
  readonly limit: number;
}

/** The request target's query as a validated list query, or null for anything the contract refuses. */
export function parseInvoiceDraftListQuery(target: string): InvoiceDraftListQuery | null {
  const at = typeof target === 'string' ? target.indexOf('?') : -1;
  if (at < 0) return Object.freeze({ after: null, limit: INVOICE_DRAFT_DEFAULT_LIMIT });
  const raw = target.slice(at + 1);
  if (raw.length > MAX_QUERY_LENGTH) return null;
  let after: string | null = null;
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
      if (limit > INVOICE_DRAFT_MAX_LIMIT) return null;
    } else {
      after = decodeInvoiceDraftCursor(match[2]);
      if (after === null) return null;
    }
  }
  return Object.freeze({ after, limit: limit ?? INVOICE_DRAFT_DEFAULT_LIMIT });
}

/** One draft as the list shows it. */
export interface InvoiceDraftSummary {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
  readonly currency: string;
  readonly lineCount: number;
  readonly subtotalCents: number;
  readonly createdAt: string;
}

/** One line as a reopened draft shows it. */
export interface InvoiceDraftLine {
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

/** One draft as the get shows it. */
export interface InvoiceDraft {
  readonly id: string;
  readonly storeId: string;
  readonly customerId: string;
  readonly status: string;
  readonly currency: string;
  readonly version: number;
  readonly createdAt: string;
  readonly subtotalCents: number;
  readonly lines: readonly InvoiceDraftLine[];
}

/**
 * The port to migration 028's two session-bound reads, each handed the trusted STORE scope (its tenant and store are the
 * routine's expected ones), the presenting session's session key (a SQL parameter it never logs, echoes or stores) and the
 * request's validated values. Answers are untrusted input, expected to be
 *   page: { outcome: 'page', drafts: InvoiceDraftSummary[], hasMore } | { outcome: 'denied' } | { outcome: 'cursor_unknown' };
 *   get:  { outcome: 'draft', draft: InvoiceDraft } | { outcome: 'denied' } | { outcome: 'not_found' }.
 * A throw is an outage.
 */
export interface InvoiceDraftReadPort {
  page(scope: TrustedScope, sessionKey: string, query: InvoiceDraftListQuery, signal: AbortSignal): unknown;
  get(scope: TrustedScope, sessionKey: string, draftId: string, signal: AbortSignal): unknown;
}

/** What the two read routes are built from. */
export interface InvoiceDraftPorts {
  readonly invoiceDrafts: InvoiceDraftReadPort;
}

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
const isAmount = (v: unknown, min: number): v is number => isWhole(v, min) && v <= INVOICE_DRAFT_MAX_AMOUNT;

/** Whether `value` is a UTC creation time with microseconds that names a real instant (migration 028's rendering). */
export function isDraftCreatedAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = CREATED_AT_RE.exec(value);
  if (m === null) return false;
  // The millisecond prefix must survive a round trip through Date: no 13th month, 31st of April or 25th hour.
  const millis = `${value.slice(0, 23)}Z`;
  const t = Date.parse(millis);
  return Number.isFinite(t) && new Date(t).toISOString() === millis;
}

/** A description this route serves: what the save stores, re-judged on the way out. */
const isServableDescription = (v: unknown): v is string => typeof v === 'string' && normalizeDraftDescription(v) === v;

const SUMMARY_KEYS: readonly string[] = ['id', 'customerId', 'status', 'currency', 'lineCount', 'subtotalCents', 'createdAt'];
const PAGE_KEYS: readonly string[] = ['outcome', 'drafts', 'hasMore'];

/** Strictly newest first: createdAt descending (fixed-width text), then id descending. */
export function inInvoiceDraftOrder(drafts: readonly { readonly id: string; readonly createdAt: string }[]): boolean {
  // inv: drafts[0..i) is strictly decreasing; term: i rises to drafts.length.
  for (let i = 1; i < drafts.length; i++) {
    const before = drafts[i - 1];
    const after = drafts[i];
    if (before.createdAt < after.createdAt || (before.createdAt === after.createdAt && before.id <= after.id)) return false;
  }
  return true;
}

type PageAnswer = { readonly drafts: readonly InvoiceDraftSummary[]; readonly hasMore: boolean } | 'denied' | 'cursor_unknown';

/** The port's page as a validated page, 'denied', 'cursor_unknown' — or null for anything out of shape. Never throws. */
export function invoiceDraftPageOf(raw: unknown, query: InvoiceDraftListQuery): PageAnswer | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied') return hasExactly(raw, ['outcome']) ? 'denied' : null;
    if (outcome === 'cursor_unknown') return hasExactly(raw, ['outcome']) && query.after !== null ? 'cursor_unknown' : null;
    if (outcome !== 'page' || !hasExactly(raw, PAGE_KEYS)) return null;
    const { drafts, hasMore } = raw;
    if (!Array.isArray(drafts) || typeof hasMore !== 'boolean') return null;
    // The length is read once, so the bound checked is the bound the loop runs to.
    const count = drafts.length;
    if (count > query.limit) return null;
    // A next page exists only behind a full one: the port read one row more than it returned.
    if (hasMore && count !== query.limit) return null;
    const seen = new Set<string>();
    const out: InvoiceDraftSummary[] = [];
    // inv: out holds a validated copy of each entry below i, and seen their ids; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const entry: unknown = drafts[i];
      if (!isPlain(entry) || !hasExactly(entry, SUMMARY_KEYS)) return null;
      // Read once each, so a value validated is the value copied.
      const { id, customerId, status, currency, lineCount, subtotalCents, createdAt } = entry;
      if (!isUuid(id) || seen.has(id) || id === query.after || !isUuid(customerId)) return null;
      if (status !== INVOICE_DRAFT_STATUS || currency !== INVOICE_DRAFT_CURRENCY) return null;
      if (!isWhole(lineCount, 1) || lineCount > INVOICE_DRAFT_MAX_LINES || !isAmount(subtotalCents, 0) || !isDraftCreatedAt(createdAt)) return null;
      seen.add(id);
      out.push(Object.freeze({ id, customerId, status, currency, lineCount, subtotalCents, createdAt }));
    }
    if (!inInvoiceDraftOrder(out)) return null;
    return Object.freeze({ drafts: Object.freeze(out), hasMore });
  } catch {
    return null; // a throwing getter or proxy trap is never a page
  }
}

const DRAFT_KEYS: readonly string[] = ['id', 'storeId', 'customerId', 'status', 'currency', 'version', 'createdAt', 'subtotalCents', 'lines'];
const LINE_OUT_KEYS: readonly string[] = ['position', 'description', 'quantity', 'unitPriceCents', 'lineTotalCents'];

/**
 * The port's answer as a validated draft, 'not_found' or 'denied' — or null for anything out of shape: the draft asked for,
 * at the trusted store; status draft, USD, a version that is a safe integer >= 1 (M7B-INVOICES-P2: an edit steps it);
 * 1-50 lines at positions 1..n in order, each total exactly quantity x unit price and the subtotal exactly their sum
 * (BigInt), every amount within 2^53 - 1. Never throws.
 */
export function invoiceDraftOf(raw: unknown, draftId: string, storeId: string): InvoiceDraft | 'not_found' | 'denied' | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found') return hasExactly(raw, ['outcome']) ? outcome : null;
    if (outcome !== 'draft' || !hasExactly(raw, ['outcome', 'draft'])) return null;
    const draft: unknown = raw.draft;
    if (!isPlain(draft) || !hasExactly(draft, DRAFT_KEYS)) return null;
    const { id, storeId: store, customerId, status, currency, version, createdAt, subtotalCents, lines } = draft;
    if (id !== draftId || !isUuid(id) || store !== storeId || !isUuid(store) || !isUuid(customerId)) return null;
    if (status !== INVOICE_DRAFT_STATUS || currency !== INVOICE_DRAFT_CURRENCY || !isWhole(version, 1) || !isDraftCreatedAt(createdAt)) return null;
    if (!isAmount(subtotalCents, 0) || !Array.isArray(lines)) return null;
    const count = lines.length;
    if (count < 1 || count > INVOICE_DRAFT_MAX_LINES) return null;
    const out: InvoiceDraftLine[] = [];
    let sum = 0n;
    // inv: out holds a validated copy of each line below i, at positions 1..i, and sum their totals; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const line: unknown = lines[i];
      if (!isPlain(line) || !hasExactly(line, LINE_OUT_KEYS)) return null;
      const { position, description, quantity, unitPriceCents, lineTotalCents } = line;
      if (position !== i + 1 || !isServableDescription(description) || !isAmount(quantity, 1) || !isAmount(unitPriceCents, 0)
        || !isAmount(lineTotalCents, 0) || BigInt(quantity) * BigInt(unitPriceCents) !== BigInt(lineTotalCents)) return null;
      sum += BigInt(lineTotalCents);
      out.push(Object.freeze({ position, description, quantity, unitPriceCents, lineTotalCents }));
    }
    if (sum !== BigInt(subtotalCents)) return null;
    return Object.freeze({
      id, storeId: store, customerId, status, currency, version, createdAt, subtotalCents, lines: Object.freeze(out),
    });
  } catch {
    return null; // a throwing getter or proxy trap is never a draft
  }
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/**
 * The trusted STORE scope and session key a read needs, or null: the chain refused the request already unless the
 * authorizer resolved a store scope for exactly the store the path names, and handed the key; this states both again.
 */
function readerOf(req: { path?: unknown }, ctx: RouteContext): { scope: TrustedScope; sessionKey: string } | null {
  const scope = ctx.trusted;
  if (scope === null || scope.scope !== 'store' || scope.tenant === null || scope.store === null) return null;
  if (storeTargetOf(typeof req.path === 'string' ? req.path : '') !== scope.store || ctx.sessionKey === null) return null;
  return { scope, sessionKey: ctx.sessionKey };
}

function checkedDeadline(options: { deadlineMs?: number }): number {
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) throw new EnforcementSetupError('port_deadline_invalid');
  return deadlineMs;
}

/** The read routes' shared declaration: a session read under a resolved store scope, bound to the presenting session. */
function readRoute(path: string, handler: RouteHandler): RouteDefinition {
  const route: RouteDefinition = {
    method: 'GET',
    path,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_DRAFT_VIEW_REQUIREMENT } as const),
    body: Object.freeze({ kind: 'none' } as const),
    idempotency: 'none',
    // The routine re-derives that exact store grant from the session and reads only its tenant and store.
    trustedContext: 'required',
    recentAuth: 'none',
    // The database binds the read to the presenting minted session, so the handler is handed its session key.
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

/** The store's drafts, newest first, over `ports`; refused at construction without its port. */
export function createInvoiceDraftListRoute(ports: InvoiceDraftPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.invoiceDrafts;
  if (typeof reader?.page !== 'function' || typeof reader?.get !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = checkedDeadline(options);
  return readRoute(INVOICE_DRAFTS_PATH, async (req, res, ctx) => {
    const query = parseInvoiceDraftListQuery(typeof req.url === 'string' ? req.url : '');
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_list_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.page(reading.scope, reading.sessionKey, query, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_draft_list', err));
    }
    const page = invoiceDraftPageOf(raw, query);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_draft_list_denied');
    // Unknown, another store's or another tenant's anchor: the malformed cursor's own 400, the same body.
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_draft_list_answer_invalid');
    const last = page.drafts[page.drafts.length - 1];
    res.status(200).json({
      drafts: page.drafts.map((d) => ({
        id: d.id, customerId: d.customerId, status: d.status, currency: d.currency, lineCount: d.lineCount, subtotalCents: d.subtotalCents, createdAt: d.createdAt,
      })),
      nextCursor: page.hasMore && last !== undefined ? encodeInvoiceDraftCursor(last.id) : null,
    });
  });
}

/** One draft and its lines, read-only, over `ports`; refused at construction without its port. */
export function createInvoiceDraftDetailRoute(ports: InvoiceDraftPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.invoiceDrafts;
  if (typeof reader?.page !== 'function' || typeof reader?.get !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = checkedDeadline(options);
  return readRoute(INVOICE_DRAFT_PATH, async (req, res, ctx) => {
    // No query is part of this contract: any at all, an empty one included, is refused.
    if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_query_invalid');
    const reading = readerOf(req, ctx);
    if (reading === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    // The same req.path the table matched; anything but one canonical lowercase uuid as its last segment is a bounded 400.
    const id = pathIdOf(typeof req.path === 'string' ? req.path : '');
    if (id === null) return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.get(reading.scope, reading.sessionKey, id, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('invoice_draft', err));
    }
    const answer = invoiceDraftOf(raw, id, reading.scope.store as string);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'invoice_draft_denied');
    // Missing, another store's and another tenant's alike: one status, one body shape (the terminal 404's), one reason.
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'invoice_draft_not_found');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'invoice_draft_answer_invalid');
    res.status(200).json({
      draft: {
        id: answer.id, storeId: answer.storeId, customerId: answer.customerId, status: answer.status, currency: answer.currency,
        version: answer.version, createdAt: answer.createdAt, subtotalCents: answer.subtotalCents,
        lines: answer.lines.map((l) => ({
          position: l.position, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents,
        })),
      },
    });
  });
}

/**
 * Whether the session's actor may save a draft at the path's store now (M7B-INVOICES-P1-R2; see THE ELIGIBILITY). The chain
 * decides it under INVOICE_DRAFT_CREATE_REQUIREMENT — the save's own requirement object — before this handler runs; the
 * handler reads no port and writes no business row.
 */
export function createInvoiceDraftEligibilityRoute(): RouteDefinition {
  const route: RouteDefinition = {
    method: 'GET',
    path: INVOICE_DRAFT_ELIGIBILITY_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_DRAFT_CREATE_REQUIREMENT } as const),
    body: Object.freeze({ kind: 'none' } as const),
    idempotency: 'none',
    trustedContext: 'required',
    recentAuth: 'none',
    // The client names the session it checked: an answer is bound to the presenting session's CSRF token (DA-138).
    sessionBinding: 'required',
    handler: (req, res, ctx) => {
      // No query is part of this contract: any at all, an empty one included, is refused.
      if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_eligibility_query_invalid');
      if (readerOf(req, ctx) === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
      res.status(200).json({ eligibility: 'allowed' });
    },
  };
  return Object.freeze(route);
}

/**
 * Whether the session's actor may edit a draft at the path's store now (M7B-INVOICES-P2; see THE EDIT ELIGIBILITY). The
 * chain decides it under INVOICE_DRAFT_EDIT_REQUIREMENT — the edit's own requirement object — before this handler runs; the
 * handler reads no port and writes no business row, and checks the id segment's shape only, never whether a draft exists.
 */
export function createInvoiceDraftEditEligibilityRoute(): RouteDefinition {
  const route: RouteDefinition = {
    method: 'GET',
    path: INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: INVOICE_DRAFT_EDIT_REQUIREMENT } as const),
    body: Object.freeze({ kind: 'none' } as const),
    idempotency: 'none',
    trustedContext: 'required',
    recentAuth: 'none',
    sessionBinding: 'required',
    handler: (req, res, ctx) => {
      // The reopen route's order: the query, the scope, then the id segment (one canonical lowercase uuid).
      if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_edit_eligibility_query_invalid');
      if (readerOf(req, ctx) === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
      if (pathIdBeforeSuffixOf(typeof req.path === 'string' ? req.path : '', EDIT_ELIGIBILITY_SUFFIX) === null) {
        return refuse(res, ctx, 400, 'invalid_request', 'invoice_draft_id_invalid');
      }
      res.status(200).json({ eligibility: 'allowed' });
    },
  };
  return Object.freeze(route);
}
