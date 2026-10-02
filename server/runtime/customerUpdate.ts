// Phase 4.0 M7a — tenant customer edit: the second tenant customer COMMAND, a versioned change of one customer's name,
// phone and email in the tenant a session is admitted to (M7A-CUSTOMERS-P7; G-IAM, G-PERSIST, G-IDEMPOT, G-AUDIT).
//
// PATCH /api/v1/customers/{id} — a session route of the TENANT boundary, beside the detail GET on the same template
// (customerDirectory.ts). It is the one templated command the route table admits (routes.ts IDEMPOTENT_TEMPLATED_ROUTES):
// the runtime judges the path id only after the chain has authenticated and authorized the request, binds the canonical
// id into the idempotency fingerprint (so one key sent to two customers is the 422 changed-request refusal, never a
// replay of one customer's response for the other) and hands it to the planner as ctx.targetId (app.ts). The path names
// the customer; it is never authority, and neither is the body.
//
// Request  { expectedVersion, name, phone?, email? } — expectedVersion and name required, no other field.
// Response 200 { customer: { id, name }, version, changed } — the id, the name as stored, the version the customer is now
// at, and whether anything moved: changed:true at expectedVersion + 1 once a change committed; changed:false at
// expectedVersion when every value already held (no customer change, no version moved, no audit record and no outbox
// event — but the sealed changed:false response is recorded as the key's idempotency completion in the same transaction,
// so a retry replays it). Never a contact:
// the profile read (GET /api/v1/customers/{id}/profile) is where they are read, with the version as its strong ETag.
//
// NAME IS REQUIRED (a stated deviation: the brief made every field optional). The kernel seals the 200 from the plan before the
// commit (commandTransaction.ts), and only values cross the store port, so a planner cannot know a stored name it was not
// sent; requiring name keeps the response exactly the stored name without widening the kernel. phone and email stay
// optional: omitted leaves the stored value as it is; JSON null or a string that trim() leaves empty clears it (SQL NULL);
// any other string is normalized exactly as the create does (customerDirectory.ts), and a refused one is a 400.
//
// VERSION. expectedVersion is the customer's row version as the profile read's ETag reported it: a safe integer from 1 to
// Number.MAX_SAFE_INTEGER - 1. The database compares it FIRST, under the row lock: another version is the sealed 409
// write_conflict (it records only its own completion — nothing changes, no version moves, no audit record — so a same-key
// retry replays the 409 and a deliberate re-save after review needs a new key). A missing customer and another tenant's
// customer are the same 404 not_found (rolled back, unsealed; the lease waits out its time).
//
// AUTHORITY. The route requires edit_customers — the canonical Customers domain at Edit or above, on the owner's durable
// edits of the role (m5CanonicalPermissions.ts): read_only, a View or Create-only role, a store or platform scope and
// every unknown role are denied. The chain proves the tenant session and asks the tenant authorizer before this module
// runs; the route declares `trustedContext: 'required'`; the tenant store re-proves the scope under the presenting session
// inside the committing transaction, and the database routine restates the Edit threshold against the same levels.
//
// TARGET. ctx.targetId must match the outbox's aggregate-id shape (outbox.ts UUID_RE: a versioned, RFC-variant uuid), or
// the request is the 400 invalid_request: a stored customer id outside that shape is readable but not editable (a recorded
// residual — migration 017 lets the writer choose the id, and every id this runtime mints is a v4).
//
// OUTCOMES. Once committed: the customer's values and version, one audit record (action tenant.customer.update, the target
// customer as its typed subject, metadata {} — changed field names are not recorded) and the idempotency completion,
// atomically; no outbox event. Anything else rolls back and is a 503. No name, phone or email ever reaches a log line, a
// refusal reason, the audit record or an idempotency diagnostic: a refusal is the same bounded 400 for every field.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but the body and the validated target, and writes nothing.
import type { CommandContract } from './commandTransaction.js';
import { normalizeCustomerName } from './customerCreate.js';
import {
  CONTACT_REFUSED, CUSTOMER_DETAIL_PATH, CUSTOMER_EMAIL_MAX_CHARACTERS, CUSTOMER_NAME_MAX_CHARACTERS, CUSTOMER_PHONE_MAX_CHARACTERS,
  normalizeCustomerEmail, normalizeCustomerPhone,
} from './customerDirectory.js';
import type { CustomerContact } from './customerDirectory.js';
import { UUID_RE } from './outbox.js';
import { COMMAND_REQUEST_INVALID } from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteDefinition } from './routes.js';

/** The canonical tenant route permission: the Customers domain at Edit or above. */
export const CUSTOMER_UPDATE_PERMISSION = 'edit_customers';
export const CUSTOMER_UPDATE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: CUSTOMER_UPDATE_PERMISSION });
/** The create's bound (6249 bytes worst case for three fields) plus well under 100 bytes for expectedVersion. */
const MAX_BODY_BYTES = 8_192;

/** Each string field in UTF-16 code units, which is how a record schema counts: every scalar is one or two (outbox.ts). */
const NAME_FIELD = Object.freeze({ type: 'string', maxLength: CUSTOMER_NAME_MAX_CHARACTERS * 2 } as const);
const PHONE_FIELD = Object.freeze({ type: 'string', maxLength: CUSTOMER_PHONE_MAX_CHARACTERS * 2 } as const);
const EMAIL_FIELD = Object.freeze({ type: 'string', maxLength: CUSTOMER_EMAIL_MAX_CHARACTERS * 2 } as const);
const FLAG_FIELD = Object.freeze({ type: 'boolean' } as const);

/**
 * A record holds no null and no optional field (outbox.ts), so the change set always carries all five: setPhone/setEmail
 * say whether the contact is written at all; a written contact of '' is SQL NULL (a cleared contact — a provided one is
 * never empty), and an unwritten one is '' and ignored. The mutator binds exactly that.
 */
export const CUSTOMER_UPDATE_CONTRACT: CommandContract = Object.freeze({
  kind: 'tenant.customer.update',
  mode: 'update',
  aggregateType: 'customer',
  changes: Object.freeze({ name: NAME_FIELD, setPhone: FLAG_FIELD, phone: PHONE_FIELD, setEmail: FLAG_FIELD, email: EMAIL_FIELD }),
  events: Object.freeze([]),
});

const BODY_KEYS: readonly string[] = ['expectedVersion', 'name', 'phone', 'email'];

/** An optional contact: absent is not written; null or blank clears; a string is normalized; anything else refused. */
function contactChange(keys: readonly string[], fields: Record<string, unknown>, key: 'phone' | 'email',
  normalize: (raw: unknown) => CustomerContact): { readonly set: boolean; readonly value: string } | typeof CONTACT_REFUSED {
  if (!keys.includes(key)) return { set: false, value: '' };
  const value = normalize(fields[key]);
  if (value === CONTACT_REFUSED) return CONTACT_REFUSED;
  return { set: true, value: value ?? '' };
}

/**
 * The command's plan from the body and the validated target alone, or COMMAND_REQUEST_INVALID. The response is the
 * committed representation (the version the edit produces); `unchanged` is the one the store sends when every value
 * already holds at the expected version, so nothing moved.
 */
export function planCustomerUpdate(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const id = ctx.targetId;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return COMMAND_REQUEST_INVALID;
  const body: unknown = ctx.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return COMMAND_REQUEST_INVALID;
  // A parsed JSON object: own enumerable data properties only ("__proto__" too). A repeated key keeps its last value, as
  // everywhere in the chain (JSON.parse); the fingerprint binds the exact bytes sent.
  const keys = Object.keys(body);
  if (!keys.includes('expectedVersion') || !keys.includes('name') || !keys.every((key) => BODY_KEYS.includes(key))) {
    return COMMAND_REQUEST_INVALID;
  }
  const fields = body as Record<string, unknown>;
  const expectedVersion = fields.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || expectedVersion > Number.MAX_SAFE_INTEGER - 1) return COMMAND_REQUEST_INVALID;
  const name = normalizeCustomerName(fields.name);
  const phone = contactChange(keys, fields, 'phone', normalizeCustomerPhone);
  const email = contactChange(keys, fields, 'email', normalizeCustomerEmail);
  if (name === null || phone === CONTACT_REFUSED || email === CONTACT_REFUSED) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: id,
    expectedVersion,
    changes: { name, setPhone: phone.set, phone: phone.value, setEmail: email.set, email: email.value },
    events: [],
    response: { status: 200, body: { customer: { id, name }, version: expectedVersion + 1, changed: true } },
    unchanged: { status: 200, body: { customer: { id, name }, version: expectedVersion, changed: false } },
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const ROUTE: RouteDefinition = {
  method: 'PATCH',
  path: CUSTOMER_DETAIL_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: CUSTOMER_UPDATE_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // A state-changing business route commits only under a RESOLVED actor and grant (DA-31); editing a customer is not
  // sensitive enough to demand a fresh authentication. No session binding is declared (routes.ts refuses one beside
  // idempotency): an unsafe method already requires the session CSRF header, and the store binds the presenting session.
  trustedContext: 'required',
  recentAuth: 'none',
  command: Object.freeze({ contract: CUSTOMER_UPDATE_CONTRACT, plan: planCustomerUpdate }),
};

/** The route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const CUSTOMER_UPDATE_ROUTE: RouteDefinition = Object.freeze(ROUTE);
