// Phase 4.0 M7a — an owner's durable edit of a built-in tenant role's Customers level: the first tenant IAM command, and the
// server-authoritative configuration the customer routes are decided on (M7A-CUSTOMERS-P3-R1; G-IAM, G-IDEMPOT, G-AUDIT,
// DA-85; migration 020).
//
// PUT /api/v1/roles/levels — a session route of the TENANT boundary. The path carries no tenant, and neither may the body:
// the tenant is the one the owner's session is admitted to, derived in the database from the presenting session's key.
//
// Request  { roleId, domain, level, reason } — exactly these four fields.
// Response 200 { roleLevel: { roleId, domain, level } } — the level as stored. The server's authoritative read is the one
//          every customer decision makes (tenantAuthorization.ts); since M7A-CUSTOMERS-P3-R2 the owner reads the stored
//          levels back, each beside its catalog default, at GET on this same path (roleLevelDirectory.ts).
//
// WHAT CAN BE EDITED, AND WHY SO LITTLE. roleId is one of the three built-in roles an owner may edit — manager, technician,
// sales_staff; the owner role itself is locked (Full everywhere, never edited). domain is exactly 'customers': the one
// domain the server decides (GET and POST /api/v1/customers), since storing a level the server does not enforce would read
// as enforced. level is one of the seven canonical levels. A stored level REPLACES the role's catalog default for that
// domain, in that tenant only; until edited, a role keeps its default. No custom role, no deletion, no other domain and no
// delegated editor exists here: each is an owner decision this stage records rather than invents.
//
// AUTHORITY. The route requires edit_role_levels — the OWNER RULE (m5CanonicalPermissions.ts): the selected tenant grant's
// role is the catalog's owner role, and the limitation is 'none'. The client's delegated editing (a manager holding
// manage_role_permissions) is refused on the server. The chain proves the tenant session and asks the tenant authorizer
// before this module runs, the route declares `trustedContext: 'required'`, and it requires idempotency at tenant scope:
// app.ts binds the scope's tenant and actor into the fingerprint, and the tenant store re-proves them, under the presenting
// session, inside the committing transaction before the mutator writes (server/persistence). Nothing in the body is
// authority: the role it names is the TARGET of the edit, never the caller's role.
//
// STEP-UP. A role change is a sensitive action (docs/phase-4/03: "status change, entitlement grant, role change … require
// recent-login/step-up re-authentication"). The route declares `recentAuth: 'required'`: the chain refuses it (403
// step_up_required) unless the session carries the provider's own verified authentication time, bound at login, no older
// than RECENT_AUTH_MAX_AGE_MS, and the committing transaction judges the same deadline on the database's clock.
//
// INPUT. reason is trimmed and must then hold 10-500 Unicode scalar values with no control character (C0, NUL included, DEL,
// C1), no line or paragraph separator, no lone surrogate and no Bidi_Control character — the tenant status command's rule
// (tenantStatus.ts), restated rather than imported because that module is administrative and never ships here. Anything
// else, or any other field, is a 400 invalid_request, decided once the idempotency record is acquired; it commits and
// records nothing, and the attempt's lease waits out its time.
//
// WHAT IT RECORDS. The level, in migration 020's row for (tenant, role, domain), and one audit record at tenant scope: the
// reason code role_<role>_customers_to_<level> names the edit and the reason is the owner's own words. The level before an
// edit can be rebuilt from the audit history (the first one the catalog default) ONLY for edits made through this route: a
// holder of the runtime role with a live store-owner key can call 020's set routine directly, which writes no audit record
// (migration 020's residual, a G-AUDIT exception). A create-mode command: each edit is its own aggregate (a fresh
// server id, type tenant_role_level, never the tenant — so the audit record names no subject tenant beyond its scope). No
// outbox event: no approved contract exists, and none is invented.
//
// PURE AND PORTABLE: part of the emitted tenant runtime artifact, importing only the runtime. The planner holds no
// infrastructure, reads nothing but the body and writes nothing.
import type { CommandContract } from './commandTransaction.js';
import { COMMAND_REQUEST_INVALID } from './routes.js';
import type { AuthorizationRequirement, CommandContext, CommandPlan, RouteDefinition } from './routes.js';

export const ROLE_LEVELS_PATH = '/api/v1/roles/levels';
/** The owner-only tenant route permission (m5CanonicalPermissions.ts). */
export const ROLE_LEVELS_PERMISSION = 'edit_role_levels';
export const ROLE_LEVELS_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: ROLE_LEVELS_PERMISSION });
/** The built-in tenant roles an owner may edit: every one but the owner role (migration 020's CHECK restates them). */
export const EDITABLE_TENANT_ROLES: readonly string[] = Object.freeze(['manager', 'technician', 'sales_staff']);
/** The domains the server decides, and so the only ones a level is stored for. */
export const ROLE_LEVEL_DOMAINS: readonly string[] = Object.freeze(['customers']);
/**
 * The seven canonical level WORDS (permissionCatalog.ts PERMISSION_TOKENS, which this runtime module may not import), kept
 * alphabetically: a vocabulary the body is checked against, never an ordering — the one ordering is the family contract's
 * (src/authorization/permissionFamilies.ts), and no second copy of it may exist (authorizationContainment.test.ts D5).
 */
export const ROLE_LEVELS: readonly string[] = Object.freeze(['approve', 'create', 'edit', 'full', 'manage', 'none', 'view']);
/** The shortest and longest reason, in Unicode scalar values. */
export const ROLE_LEVEL_REASON_MIN_SCALARS = 10;
export const ROLE_LEVEL_REASON_MAX_SCALARS = 500;
/** A bounded body: four fields, a reason of at most 500 scalars in any JSON spelling, and room for padding. */
const MAX_BODY_BYTES = 8_192;

const enumOf = (values: readonly string[]) => Object.freeze({ type: 'enum', values } as const);

export const ROLE_LEVEL_UPDATE_CONTRACT: CommandContract = Object.freeze({
  kind: 'tenant.role.level.update',
  mode: 'create',
  aggregateType: 'tenant_role_level',
  changes: Object.freeze({ roleId: enumOf(EDITABLE_TENANT_ROLES), domain: enumOf(ROLE_LEVEL_DOMAINS), level: enumOf(ROLE_LEVELS) }),
  events: Object.freeze([]),
});

const BODY_FIELDS: readonly string[] = ['roleId', 'domain', 'level', 'reason'];
// Exactly the tenant status command's refused set (tenantStatus.ts): C0 controls (NUL included), DEL, C1 controls, the line
// and paragraph separators, a lone surrogate and every Bidi_Control character.
const REFUSED_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Bidi_Control}/u;

/** The reason as it is recorded — trimmed, 10-500 Unicode scalar values, no refused character — or null. */
export function normalizeRoleLevelReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (REFUSED_CHARACTER_RE.test(trimmed)) return null;
  const scalars = [...trimmed].length; // code points; with no lone surrogate, exactly the scalar values
  return scalars >= ROLE_LEVEL_REASON_MIN_SCALARS && scalars <= ROLE_LEVEL_REASON_MAX_SCALARS ? trimmed : null;
}

/** The command's plan from the body alone, or COMMAND_REQUEST_INVALID: the runtime's new id, the edit, its audit annex. */
export function planRoleLevelUpdate(ctx: CommandContext): CommandPlan | typeof COMMAND_REQUEST_INVALID {
  const body: unknown = ctx.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return COMMAND_REQUEST_INVALID;
  // A parsed JSON object: own enumerable data properties only, so its keys are exactly what was sent.
  const keys = Object.keys(body);
  if (keys.length !== BODY_FIELDS.length || !BODY_FIELDS.every((field) => keys.includes(field))) return COMMAND_REQUEST_INVALID;
  const { roleId, domain, level, reason } = body as Record<string, unknown>;
  if (typeof roleId !== 'string' || !EDITABLE_TENANT_ROLES.includes(roleId)) return COMMAND_REQUEST_INVALID;
  if (typeof domain !== 'string' || !ROLE_LEVEL_DOMAINS.includes(domain)) return COMMAND_REQUEST_INVALID;
  if (typeof level !== 'string' || !ROLE_LEVELS.includes(level)) return COMMAND_REQUEST_INVALID;
  const text = normalizeRoleLevelReason(reason);
  if (text === null) return COMMAND_REQUEST_INVALID;
  return {
    aggregateId: ctx.newAggregateId,
    expectedVersion: null,
    changes: { roleId, domain, level },
    events: [],
    response: { status: 200, body: { roleLevel: { roleId, domain, level } } },
    audit: { reasonCode: `role_${roleId}_${domain}_to_${level}`, reason: text },
  };
}

// Frozen throughout: one module-level definition is shared by every importer before registration copies it.
const ROUTE: RouteDefinition = {
  method: 'PUT',
  path: ROLE_LEVELS_PATH,
  policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: ROLE_LEVELS_REQUIREMENT } as const),
  body: Object.freeze({ kind: 'json', maxBytes: MAX_BODY_BYTES, required: true } as const),
  idempotency: 'required',
  // A role change commits only under a RESOLVED actor and grant (DA-31), on fresh authentication. No session key reaches a
  // handler: the store binds it.
  trustedContext: 'required',
  recentAuth: 'required',
  command: Object.freeze({ contract: ROLE_LEVEL_UPDATE_CONTRACT, plan: planRoleLevelUpdate }),
};

/** The route, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const ROLE_LEVEL_UPDATE_ROUTE: RouteDefinition = Object.freeze(ROUTE);
