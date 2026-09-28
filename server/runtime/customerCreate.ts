// Phase 4.0 M7a — tenant customer creation: the first tenant business COMMAND, a customer with a server-generated id and
// a name, created in the tenant a session is admitted to (M7A-CUSTOMERS-P3; G-IAM, G-PERSIST, G-IDEMPOT, G-AUDIT;
// docs/phase-4/10 ADR-34).
//
// POST /api/v1/customers — a session route of the TENANT boundary, beside the directory's GET on the same literal path
// (customerDirectory.ts). The path carries no tenant, and neither may the body.
//
// Request  { name } — exactly this one field.
// Response 201 { customer: { id, name } } — the new id and the name as stored; no Location header (no detail route).
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
// OUTCOMES. Once committed: the customer, its audit record and the idempotency completion, atomically; no outbox event
// (no approved customer event contract exists, and none is invented). Any refusal inside the transaction — lost
// authority, a duplicate id, a store fault — rolls everything back and is a 503; a retry replays or re-plans a fresh id.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but the body and writes nothing.
import type { CommandContract } from './commandTransaction.js';
import { CUSTOMER_DIRECTORY_PATH, CUSTOMER_NAME_MAX_CHARACTERS } from './customerDirectory.js';
import { COMMAND_REQUEST_INVALID } from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteDefinition } from './routes.js';

/** The canonical tenant route permission: the Customers domain at Create or above. */
export const CUSTOMER_CREATE_PERMISSION = 'create_customers';
export const CUSTOMER_CREATE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: CUSTOMER_CREATE_PERMISSION });
/**
 * A bounded body: the worst canonical spelling of a 200-scalar name — every scalar astral, escaped as two \uXXXX units —
 * is 2411 bytes with its field, which leaves room for trimmable padding.
 */
const MAX_BODY_BYTES = 4_096;

/** The name in UTF-16 code units, which is how a record schema counts: every scalar is one or two (outbox.ts). */
const NAME_FIELD = Object.freeze({ type: 'string', maxLength: CUSTOMER_NAME_MAX_CHARACTERS * 2 } as const);

export const CUSTOMER_CREATE_CONTRACT: CommandContract = Object.freeze({
  kind: 'tenant.customer.create',
  mode: 'create',
  aggregateType: 'customer',
  changes: Object.freeze({ name: NAME_FIELD }),
  events: Object.freeze([]),
});

// C0 controls (NUL included), DEL, C1 controls, and the line and paragraph separators; a lone surrogate is no Unicode
// scalar value at all; and every Bidi_Control character — tenantDisplayName.ts's set, which 017's CHECK restates.
const REFUSED_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Bidi_Control}/u;
/** One scalar that renders: not White_Space, Default_Ignorable_Code_Point, a format character, a mark or U+2800. */
const VISIBLE_RE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\u2800]/u;

/** The name as it is stored — trimmed, 1-200 scalars, no refused character, at least one visible scalar — or null. */
export function normalizeCustomerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (REFUSED_CHARACTER_RE.test(name) || !VISIBLE_RE.test(name)) return null;
  const scalars = [...name].length; // code points; with no lone surrogate, exactly the scalar values (017's char_length)
  return scalars >= 1 && scalars <= CUSTOMER_NAME_MAX_CHARACTERS ? name : null;
}

/** The command's plan from the body alone, or COMMAND_REQUEST_INVALID: the runtime's new id, the name, no event. */
export function planCustomerCreate(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const body: unknown = ctx.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return COMMAND_REQUEST_INVALID;
  // A parsed JSON object: own enumerable data properties only ("__proto__" too). A repeated key keeps its last value, as
  // everywhere in the chain (JSON.parse); the fingerprint binds the exact bytes sent.
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'name') return COMMAND_REQUEST_INVALID;
  const name = normalizeCustomerName((body as Record<string, unknown>).name);
  if (name === null) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: ctx.newAggregateId,
    expectedVersion: null,
    changes: { name },
    events: [],
    response: { status: 201, body: { customer: { id: ctx.newAggregateId, name } } },
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
