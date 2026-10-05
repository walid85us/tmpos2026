// Phase 4.0 M7a — tenant customer creation: the first tenant business COMMAND, a customer with a server-generated id and
// a name, created in the tenant a session is admitted to (M7A-CUSTOMERS-P3; G-IAM, G-PERSIST, G-IDEMPOT, G-AUDIT;
// docs/phase-4/10 ADR-34).
//
// POST /api/v1/customers — a session route of the TENANT boundary, beside the directory's GET on the same literal path
// (customerDirectory.ts). The path carries no tenant, and neither may the body.
//
// Request  { name, phone?, email? } — name required, the two contacts optional (M7A-CUSTOMERS-P6), no other field.
// Response 201 { customer: { id, name } } — the new id and the name as stored — with Location: /api/v1/customers/<id>, the
// detail route's path (M7A-CUSTOMERS-P4). The header is part of the sealed idempotent response: a same-key replay sends
// the same Location, and a response sealed before this build replays without one, exactly as it was committed. The body
// never carries a contact, sent or not: the profile read (GET /api/v1/customers/{id}/profile) is where they are read.
//
// AUTHORITY. The route requires create_customers — the canonical Customers domain at Create or above
// (m5CanonicalPermissions.ts): store_owner, manager and sales_staff hold it; a technician, a read_only limitation, a store
// or platform scope and every unknown role do not. The chain proves the tenant session and asks the tenant authorizer
// before this module runs, and the route declares `trustedContext: 'required'`, so the authorizer's trusted scope — the
// app-owned actor and the ONE tenant grant it decided on — is the only thing that says whose customer this is. The route
// requires idempotency (routes.ts admits a tenant-scoped key on a tenant-session route only): app.ts binds that scope's
// tenant and actor into the fingerprint, and the tenant store re-proves both, under the presenting session, inside the
// committing transaction before the mutator writes (server/persistence). Nothing in the body is authority.
//
// INPUT. name must be a string; its edges are trimmed (ES trim strips exactly the 25 edge-whitespace code points
// migration 017's CHECK refuses at an edge — customerCreate.test.ts sweeps every code point to prove it); the trimmed
// value must hold 1-200 Unicode scalar values (017's char_length), with no C0 control (NUL included), DEL, C1 control,
// line or paragraph separator, lone surrogate or Bidi_Control character — 017's CHECK, plus NUL and the lone surrogate
// it cannot see — and at least one VISIBLE scalar: one outside White_Space, Default_Ignorable_Code_Point, Cf, M and
// U+2800 BRAILLE PATTERN BLANK, so an invisible-only name is refused. Private-use and unassigned scalars count as visible
// (a recorded product choice). So the runtime is at least as strict as the column's CHECK, and the database never
// refuses a name this module admits. Internal whitespace and every other character are kept exactly — no case folding,
// no normalization — and stored names are never rewritten. Names may repeat: two keys with one name are two customers.
// Anything else is a 400 invalid_request, decided once the idempotency record is acquired; it commits and records
// nothing, and the attempt's lease waits out its time.
//
// CONTACTS (M7A-CUSTOMERS-P6). phone and email are each optional: omitted, JSON null, or a string that trim() leaves
// empty is "not provided" (stored NULL); any other non-string is a 400. A provided value is stored trimmed, exactly as
// typed otherwise — no case folding, normalization, country or E.164 form — and must hold no refused character (the
// name's set above: C0 incl. NUL, DEL, C1, LS/PS, lone surrogate, Bidi_Control). phone: 1-64 scalars with at least one
// ASCII digit; internal spaces and punctuation are kept. email: 1-254 scalars, no White_Space anywhere, and exactly one
// '@' between a non-empty local part and a non-empty domain. Migration 023's CHECKs and its create restate both rules,
// so the database never refuses a contact this module admits. Nothing is verified, deduplicated, matched or merged, and
// no contact value ever reaches a log line, a refusal reason, the audit record (its metadata stays {}) or an
// idempotency diagnostic: a refusal is the same bounded 400 for every field.
//
// THE FINGERPRINT IS THE BYTES. app.ts binds the idempotency fingerprint to the exact request body bytes, so a name-only
// body keeps the fingerprint it had before contacts existed, and any change to the phone or email bytes under one key is
// the changed-request refusal (422 idempotency_key_reused) — never a re-plan. IDEMPOTENCY_CONTRACT_VERSION is unchanged.
//
// OUTCOMES. Once committed: the customer, its audit record and the idempotency completion, atomically; no outbox event
// (no approved customer event contract exists, and none is invented). Any refusal inside the transaction — lost
// authority, a duplicate id, a store fault — rolls everything back and is a 503; a retry replays or re-plans a fresh id.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but the body and writes nothing.
import type { CommandContract } from './commandTransaction.js';
import {
  CONTACT_REFUSED, CUSTOMER_DIRECTORY_PATH, CUSTOMER_EMAIL_MAX_CHARACTERS, CUSTOMER_NAME_MAX_CHARACTERS, CUSTOMER_PHONE_MAX_CHARACTERS,
  REFUSED_CHARACTER_RE, normalizeCustomerEmail, normalizeCustomerPhone,
} from './customerDirectory.js';
import { COMMAND_REQUEST_INVALID } from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteDefinition } from './routes.js';

/** The canonical tenant route permission: the Customers domain at Create or above. */
export const CUSTOMER_CREATE_PERMISSION = 'create_customers';
export const CUSTOMER_CREATE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: CUSTOMER_CREATE_PERMISSION });
/**
 * A bounded body: the worst canonical spelling of a full request — every scalar astral, escaped as two \uXXXX units, 12
 * bytes — is 6249 bytes with its three fields (name 2411, phone 779, email 3059), which leaves room for trimmable padding.
 */
const MAX_BODY_BYTES = 8_192;

/** Each field in UTF-16 code units, which is how a record schema counts: every scalar is one or two (outbox.ts). */
const NAME_FIELD = Object.freeze({ type: 'string', maxLength: CUSTOMER_NAME_MAX_CHARACTERS * 2 } as const);
const PHONE_FIELD = Object.freeze({ type: 'string', maxLength: CUSTOMER_PHONE_MAX_CHARACTERS * 2 } as const);
const EMAIL_FIELD = Object.freeze({ type: 'string', maxLength: CUSTOMER_EMAIL_MAX_CHARACTERS * 2 } as const);

/**
 * The change set always carries all three strings — a record holds no null (outbox.ts) — so an absent contact is ''
 * here, never a value a user sent (a provided contact is never empty), and the mutator binds '' as SQL NULL.
 */
export const CUSTOMER_CREATE_CONTRACT: CommandContract = Object.freeze({
  kind: 'tenant.customer.create',
  mode: 'create',
  aggregateType: 'customer',
  // The scope of the trusted context it commits under, declared (M7B-INVOICES-P1, design R4: required, never defaulted).
  contextScope: 'tenant',
  changes: Object.freeze({ name: NAME_FIELD, phone: PHONE_FIELD, email: EMAIL_FIELD }),
  events: Object.freeze([]),
});

/** One scalar that renders: not White_Space, Default_Ignorable_Code_Point, a format character, a mark or U+2800. */
const VISIBLE_RE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\u2800]/u;

/**
 * Plain text as it is stored — trimmed, 1 to `maxScalars` scalars, no refused character, at least one visible scalar — or
 * null: the customer name's pipeline, which M7B-INVOICES-P1's invoice draft line description shares at 256 scalars
 * (invoiceDrafts.ts) under migration 028's restatement of 017's CHECK.
 */
export function normalizePlainText(raw: unknown, maxScalars: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (REFUSED_CHARACTER_RE.test(text) || !VISIBLE_RE.test(text)) return null;
  const scalars = [...text].length; // code points; with no lone surrogate, exactly the scalar values (017's char_length)
  return scalars >= 1 && scalars <= maxScalars ? text : null;
}

/** The name as it is stored — trimmed, 1-200 scalars, no refused character, at least one visible scalar — or null. */
export function normalizeCustomerName(raw: unknown): string | null {
  return normalizePlainText(raw, CUSTOMER_NAME_MAX_CHARACTERS);
}

const BODY_KEYS: readonly string[] = ['name', 'phone', 'email'];

/** The command's plan from the body alone, or COMMAND_REQUEST_INVALID: the runtime's new id, the name and contacts, no event. */
export function planCustomerCreate(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const body: unknown = ctx.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return COMMAND_REQUEST_INVALID;
  // A parsed JSON object: own enumerable data properties only ("__proto__" too). A repeated key keeps its last value, as
  // everywhere in the chain (JSON.parse); the fingerprint binds the exact bytes sent.
  const keys = Object.keys(body);
  if (!keys.includes('name') || !keys.every((key) => BODY_KEYS.includes(key))) return COMMAND_REQUEST_INVALID;
  const fields = body as Record<string, unknown>;
  const name = normalizeCustomerName(fields.name);
  // Only an own key is read: an omitted contact is absent, whatever a prototype might carry.
  const phone = normalizeCustomerPhone(keys.includes('phone') ? fields.phone : undefined);
  const email = normalizeCustomerEmail(keys.includes('email') ? fields.email : undefined);
  if (name === null || phone === CONTACT_REFUSED || email === CONTACT_REFUSED) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: ctx.newAggregateId,
    expectedVersion: null,
    changes: { name, phone: phone ?? '', email: email ?? '' },
    events: [],
    response: { status: 201, body: { customer: { id: ctx.newAggregateId, name } }, headers: { location: `${CUSTOMER_DIRECTORY_PATH}/${ctx.newAggregateId}` } },
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const ROUTE: RouteDefinition = {
  method: 'POST',
  path: CUSTOMER_DIRECTORY_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: CUSTOMER_CREATE_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // A state-changing business route commits only under a RESOLVED actor and grant (DA-31); creating a customer is not
  // sensitive enough to demand a fresh authentication. No session key reaches a handler: the store binds it.
  trustedContext: 'required',
  recentAuth: 'none',
  command: Object.freeze({ contract: CUSTOMER_CREATE_CONTRACT, plan: planCustomerCreate }),
};

/** The route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const CUSTOMER_CREATE_ROUTE: RouteDefinition = Object.freeze(ROUTE);
