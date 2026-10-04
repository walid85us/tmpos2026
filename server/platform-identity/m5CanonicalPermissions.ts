// Phase 4.0 M5 — the canonical route-permission catalog (M5 phase (i); docs/phase-4/04 §2-§3,
// docs/phase-4/03 §6).
//
// ONE DEFINITION PER PERMISSION, AND IT IS NOT A NEW ONE. Every key this module knows is already
// declared in permissionCatalog.ts, which mirrors the frozen client engines by read-only parity. This
// file adds no permission, renames none, and changes no role's grants: it is the single place that
// says WHICH strings are permissions a route may require, and answers whether a role holds one. No
// handler writes a permission literal of its own — it names a key from here, or startup refuses it.
//
// A ROUTE PERMISSION IS A NAMED SUB-PERMISSION, COMPARED EXACTLY. A route declares one string
// (routes.ts AuthorizationRequirement). The catalog admits only SUB-PERMISSION ids — the named,
// boolean grants — and matches them exactly and case-sensitively: 'View_Command_Center' is not
// 'view_command_center', and an unknown key is not a weaker permission but no permission at all. A
// bare FEATURE or DOMAIN key ('command_center', 'sales') is deliberately NOT a route permission: it
// names a level, and a level without a threshold is not a decidable requirement.
//
// M5-GAP11-P5 UPDATE. The one-global-ordering plan described below was superseded: tenant/store and
// platform permissions keep family-specific orderings (src/authorization/permissionFamilies.ts) and
// money actions are explicit editable grants. The tenant/store refusal STAYS: a store-scope route is
// undecidable here until owner decision D1 names a specific route and its authoritative product rules
// — the catalogue is not broadened merely to close GAP-11. The history of the refusal follows.
//
// GAP-11 — WHY TENANT AND STORE SCOPES ARE UNDECIDABLE HERE. docs/phase-4/04 §3 records two
// conflicting level orderings: the tenant engine ranks `manage < approve`, the platform engine ranks
// `approve < manage`, and the canonical decision is to adopt ONE ordering — the platform one. That
// migration "changes effective grants by construction" (04 §3), so 04 §3 binds it to six mandatory
// M5 phase (i) safeguards, including a per-action RE-PIN of approve-gated money actions (1) and
// EXPLICIT OWNER APPROVAL of the before/after grant diff (3). Neither is this stage's to make, and
// inventing either would silently widen real grants. So:
//   * a PLATFORM-scope permission is decided here, on the platform ordering, which 04 §3 already
//     declares canonical — nothing changes for it;
//   * a TENANT- or STORE-scope permission is UNDECIDABLE, and composition refuses such a route at
//     startup rather than guessing. It is a refusal to answer, never an answer of 'allow'.
// This matches what the runtime already enforces: routes.ts admits an idempotency-required route only
// under a platform-scope requirement, precisely because M5 has not landed (M7A-CUSTOMERS-P3: or a
// tenant-scope one on a tenant-session route, whose permission — create_customers, and since M7A-CUSTOMERS-P3-R1 edit_role_levels — is decided here).
//
// M5-GIAM-D1-P1 UPDATE. The platform decision reads a role through its DEFINITION — levels and money
// grants as data (PlatformRoleDefinition) — rather than through its id, so owner decision D1's rules hold
// by construction: no role-name shortcut, System Owner decided by the same rule as every role, and a
// custom platform role with sufficient authority granted like a built-in one. The built-in definitions
// are the catalog's defaults, so every built-in answer is unchanged. The first route to depend on this is
// PATCH /admin/v1/tenants/display-name (edit_tenant_profile), decided by the canonical platform
// authorizer (server/composition/platformAuthorization.ts).
//
// PURE AND INERT: no database, no environment, no network, no I/O, no logging, no side effect. It
// imports only the inert catalog, the constants and the pure money-capability contract
// (src/authorization/moneyCapabilities.ts, which itself imports nothing at runtime).
//
// M7A-CUSTOMERS-P1 UPDATE. Owner decision D1 named the first tenant route — GET /api/v1/customers — and its
// authoritative rule: the canonical Customers domain at View or above. That ONE tenant route permission,
// view_customers, is decidable here; every other tenant and store key stays 'undecidable'. It is decided by the
// catalog's own tenant materializer (materializeTenantPermissions — the role defaults, the entitlement gate and the
// read-only cap the client engines mirror), compared on the tenant family ordering: no second evaluator, no role id
// read as a shortcut, and no default widened.
//
// M7A-CUSTOMERS-P3 UPDATE. The second tenant route permission, create_customers, is the Customers domain at Create or
// above — the canonical Customers Create authority the owner brief names for POST /api/v1/customers (docs/phase-4/10
// ADR-34). It is decided exactly as view_customers is, by the same materializer and ordering, with no role default
// changed: store_owner, manager and sales_staff hold it, technician (Customers View) does not. It is the first route
// permission above View, so the read_only rule is stated where it is enforced: a read_only limitation grants a tenant
// route permission at View only, and denies every threshold above it.
//
// M7A-CUSTOMERS-P3-R1 UPDATE. A tenant route permission is decided on the role's CURRENT definition, not its default: the
// caller must hand the owner's durable edits of the selected role (`levels`, read from the database for that grant's tenant
// and role — migration 020), and the materializer applies them before the entitlement gate and the read-only cap. The
// levels are REQUIRED on that branch: absent, not a plain object, naming an unknown domain or holding a non-canonical level,
// the permission is denied — never decided on the defaults as if no owner had edited the role. The one sensitive tenant
// route permission, edit_role_levels (PUT /api/v1/roles/levels), is decided by the OWNER RULE instead of a level: the
// selected grant's role is the catalog's owner role (TENANT_OWNER_ROLE_ID — the only built-in tenant role the catalog makes
// Full everywhere and the product never lets anyone edit) and the limitation is 'none'. It is deliberately not Employees at
// some level: Employees is plan-gated and the server holds no entitlement set, so that rule would deny everyone; and the
// client's delegated editing (manage_role_permissions) is refused on the server until the owner decides its parity rules —
// its grant is itself owner-editable only in client memory.
//
// M7A-CUSTOMERS-P7 UPDATE. The fourth tenant route permission, edit_customers, is the Customers domain at Edit or above
// (edit, manage, approve, full on the tenant family ordering) for PATCH /api/v1/customers/{id}. It is decided exactly as
// create_customers is — same materializer, same owner-edited levels, no role default changed, no role-name shortcut —
// and the read_only rule denies it like every threshold above View. The load-time threshold set widens to exactly View,
// Create and Edit; nothing above Edit is admitted except the owner rule.
//
// M7B-INVOICES-P1 UPDATE — THE FIRST STORE ROUTE PERMISSIONS. The owner's stage brief makes invoice drafts owned by a real
// store, decided by an explicit active STORE-scope grant at exactly the requested store (no tenant-to-store inheritance).
// So two STORE route permissions are decidable here, at STORE scope ONLY (STORE_ROUTE_PERMISSIONS): view_invoice_drafts,
// the Invoices domain at View or above, and create_invoice_drafts, the Invoices domain at Create or above AND the Customers
// domain at View or above on the SAME role (its `corequisite`: a draft names a customer of the store's tenant). Each is
// decided by the same tenant materializer, ordering, owner-edited levels and read_only rule as the tenant route permissions
// — the store grant's role is one of the four tenant roles, and its levels are its TENANT's (no store-level edits exist).
// Neither is a tenant key: canonicalPermission('tenant', k) does not find them, so a tenant route naming one names nothing,
// and the tenant route permissions stay undecidable at store scope. No key, default or ordering of the catalog changes, no
// sub-permission (reopen_invoice included) is reused, and no money approval is implied by any level.
import {
  PLATFORM_PERMISSION_DEPENDENCIES,
  PLATFORM_ROLE_FEATURE_DEFAULTS,
  PLATFORM_SUB_PERMISSIONS,
  TENANT_OWNER_ROLE_ID,
  TENANT_SUB_PERMISSIONS,
  isPermissionLevel,
  materializeTenantPermissions,
  meetsPlatformPermissionLevel,
  meetsTenantPermissionLevel,
} from './permissionCatalog.js';
import { PLATFORM_ROLE_IDS } from './authorizationConstants.js';
import type { PermissionLevelValue } from './authorizationConstants.js';
import {
  PLATFORM_MONEY_PARENT_MINIMUM,
  builtInMoneyGrants,
  hasExplicitMoneyGrant,
  isPlatformMoneyCapability,
} from '../../src/authorization/moneyCapabilities.js';

/** The scope a permission is evaluated at — identical to routes.ts AuthorizationScope. */
export type CanonicalPermissionScope = 'platform' | 'tenant' | 'store';

/** One canonical permission: its key, the plane it belongs to, and how it is classified. */
export interface CanonicalPermission {
  readonly key: string;
  /** 'platform' keys are evaluated from a platform role; 'tenant' keys from a tenant/store role. */
  readonly plane: 'platform' | 'tenant';
  /** The parent feature (platform) or domain (tenant) whose level gates it. */
  readonly parent: string;
  /** Sensitive permissions keep the classification the existing catalog gives them. */
  readonly sensitive: boolean;
  /** The parent level this grant is gated behind, for the platform plane. */
  readonly threshold: PermissionLevelValue | null;
  /**
   * A second domain the SAME role must hold at the given level for this permission to be granted — present only on a store
   * route permission that names one (M7B-INVOICES-P1: create_invoice_drafts requires Customers at View). One permission,
   * one decision: the authorizer, the revalidator and the database routine all evaluate both conditions.
   */
  readonly corequisite?: Readonly<{ parent: string; threshold: PermissionLevelValue }>;
}

/**
 * The platform plane's canonical permissions, derived from the one catalog — never re-listed here, so
 * a key added or removed there is added or removed from this catalog with it.
 */
export const CANONICAL_PLATFORM_PERMISSIONS: ReadonlyMap<string, CanonicalPermission> = Object.freeze(
  new Map(PLATFORM_SUB_PERMISSIONS.map((sub) => [
    sub.id,
    Object.freeze({
      key: sub.id, plane: 'platform' as const, parent: sub.feature,
      sensitive: sub.sensitive, threshold: sub.threshold as PermissionLevelValue,
    }),
  ] as const)),
);

/**
 * The tenant plane's canonical permissions. They are recognised — a route naming one is naming a real
 * permission, not a typo — but they cannot be EVALUATED until GAP-11's safeguards land, so they carry
 * no threshold and evaluation answers 'undecidable' for them.
 */
export const CANONICAL_TENANT_PERMISSIONS: ReadonlyMap<string, CanonicalPermission> = Object.freeze(
  new Map(TENANT_SUB_PERMISSIONS.map((sub) => [
    sub.id,
    Object.freeze({
      key: sub.id, plane: 'tenant' as const, parent: sub.parentDomain,
      sensitive: sub.mutating, threshold: null,
    }),
  ] as const)),
);

/**
 * The tenant plane's ROUTE permissions (M7A-CUSTOMERS-P1, -P3): each names exactly one tenant DOMAIN and the level a role
 * must hold on it, as the owner fixed it for one route. They are the only tenant keys this module decides, and only at
 * TENANT scope: a store-scope route naming one is naming nothing (store scope decides only STORE_ROUTE_PERMISSIONS,
 * M7B-INVOICES-P1). A route permission
 * never shares a key with a sub-permission, and every one but the owner-only edit_role_levels is non-sensitive at View,
 * Create or Edit — the module refuses to load otherwise.
 *   * view_customers   — GET /api/v1/customers: the Customers domain at View or above.
 *   * create_customers — POST /api/v1/customers: the Customers domain at Create or above (ADR-34).
 *   * edit_customers   — PATCH /api/v1/customers/{id} (M7A-CUSTOMERS-P7): the Customers domain at Edit or above.
 *   * edit_role_levels — PUT /api/v1/roles/levels (M7A-CUSTOMERS-P3-R1): the OWNER RULE (header), sensitive. Its parent and
 *     threshold record where the product edits roles (Employees) and the level the owner holds there; neither is compared.
 */
export const TENANT_ROUTE_PERMISSIONS: ReadonlyMap<string, CanonicalPermission> = Object.freeze(new Map<string, CanonicalPermission>([
  ['view_customers', Object.freeze({ key: 'view_customers', plane: 'tenant' as const, parent: 'customers', sensitive: false, threshold: 'view' as const })],
  ['create_customers', Object.freeze({ key: 'create_customers', plane: 'tenant' as const, parent: 'customers', sensitive: false, threshold: 'create' as const })],
  ['edit_customers', Object.freeze({ key: 'edit_customers', plane: 'tenant' as const, parent: 'customers', sensitive: false, threshold: 'edit' as const })],
  ['edit_role_levels', Object.freeze({ key: 'edit_role_levels', plane: 'tenant' as const, parent: 'employees', sensitive: true, threshold: 'full' as const })],
]));

/** The tenant route permissions decided by the owner rule rather than a level: exactly edit_role_levels. */
const OWNER_ONLY_ROUTE_PERMISSIONS: ReadonlySet<string> = new Set<string>(['edit_role_levels']);

/**
 * The thresholds a tenant route permission may carry. THE READ_ONLY RULE: a read_only limitation grants a tenant route
 * permission only at threshold View — the materializer caps every domain at View, and evaluateCanonicalPermission
 * denies every threshold above View under read_only before anything is materialized — so a Create or Edit permission
 * is DENIED under read_only. A sensitive permission, or one above Edit, needs its own rule before it is added: the one
 * such rule is the owner rule, admitted here for exactly the sensitive, Full-threshold edit_role_levels and nothing else.
 */
const TENANT_ROUTE_THRESHOLDS: ReadonlySet<PermissionLevelValue> = new Set<PermissionLevelValue>(['view', 'create', 'edit']);
for (const [key, entry] of TENANT_ROUTE_PERMISSIONS) {
  if (CANONICAL_TENANT_PERMISSIONS.has(key)) throw new Error('tenant route permission collides with a tenant sub-permission');
  if (OWNER_ONLY_ROUTE_PERMISSIONS.has(key)) {
    if (!entry.sensitive || entry.threshold !== 'full') throw new Error('an owner-only tenant route permission is not sensitive at Full');
    continue;
  }
  if (entry.sensitive || entry.threshold === null || !TENANT_ROUTE_THRESHOLDS.has(entry.threshold)) {
    throw new Error('tenant route permission is not a non-sensitive View, Create or Edit threshold');
  }
}

/**
 * The STORE route permissions (M7B-INVOICES-P1): decided at STORE scope only, for a store-scope grant at exactly the
 * requested store (tenantAuthorization.ts). Each names one tenant DOMAIN and the level the store grant's role must hold on
 * it — its tenant's owner-edited level, the catalog default otherwise — and, where a draft also names a customer, a
 * corequisite domain the same role must hold. The module refuses to load unless each is non-sensitive at View or Create,
 * shares no key with a sub-permission or a tenant route permission, and any corequisite is View on a different domain.
 *   * view_invoice_drafts   — GET /api/v1/stores/{storeId}/invoice-drafts[/{id}]: the Invoices domain at View or above.
 *   * create_invoice_drafts — POST /api/v1/stores/{storeId}/invoice-drafts: the Invoices domain at Create or above AND the
 *     Customers domain at View or above.
 */
export const STORE_ROUTE_PERMISSIONS: ReadonlyMap<string, CanonicalPermission> = Object.freeze(new Map<string, CanonicalPermission>([
  ['view_invoice_drafts', Object.freeze({ key: 'view_invoice_drafts', plane: 'tenant' as const, parent: 'invoices', sensitive: false, threshold: 'view' as const })],
  ['create_invoice_drafts', Object.freeze({
    key: 'create_invoice_drafts', plane: 'tenant' as const, parent: 'invoices', sensitive: false, threshold: 'create' as const,
    corequisite: Object.freeze({ parent: 'customers', threshold: 'view' as const }),
  })],
]));

const STORE_ROUTE_THRESHOLDS: ReadonlySet<PermissionLevelValue> = new Set<PermissionLevelValue>(['view', 'create']);
for (const [key, entry] of STORE_ROUTE_PERMISSIONS) {
  if (CANONICAL_TENANT_PERMISSIONS.has(key) || TENANT_ROUTE_PERMISSIONS.has(key)) throw new Error('store route permission collides with a tenant permission');
  if (entry.sensitive || entry.threshold === null || !STORE_ROUTE_THRESHOLDS.has(entry.threshold)) {
    throw new Error('store route permission is not a non-sensitive View or Create threshold');
  }
  const corequisite = entry.corequisite;
  if (corequisite !== undefined && (corequisite.threshold !== 'view' || corequisite.parent === entry.parent)) {
    throw new Error('a store route permission corequisite is not View on another domain');
  }
}

/** The one message a refusal to evaluate the tenant plane carries, so every caller says the same thing. */
export const GAP_11_TENANT_ORDERING_UNRESOLVED =
  'tenant and store permissions are undecidable until owner decision D1 defines a specific route and its authoritative product rules (docs/phase-4/04 section 3, M5-GAP11-P5)';

/**
 * The canonical permission for (scope, key), or null. Exact and case-sensitive: no trimming, no
 * lowercasing, no alias, no prefix match. A platform scope reads the platform plane; tenant and store
 * scopes read the tenant plane, which is the same plane for both (a store role is a tenant role). Any
 * other scope names no plane, so nothing is found in it (M5-GAP11-P1-R1: it used to read the tenant
 * plane, as if an unknown scope were a tenant one). Each route-permission map is read at its own scope alone: the tenant
 * route permissions at tenant scope, the store route permissions (M7B-INVOICES-P1) at store scope.
 */
export function canonicalPermission(scope: CanonicalPermissionScope, key: unknown): CanonicalPermission | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (scope === 'platform') return CANONICAL_PLATFORM_PERMISSIONS.get(key) ?? null;
  if (scope === 'tenant') return CANONICAL_TENANT_PERMISSIONS.get(key) ?? TENANT_ROUTE_PERMISSIONS.get(key) ?? null;
  if (scope === 'store') return CANONICAL_TENANT_PERMISSIONS.get(key) ?? STORE_ROUTE_PERMISSIONS.get(key) ?? null;
  return null;
}

/**
 * Whether (scope, key) is a permission this module DECIDES — answers 'granted' or 'denied' for, never 'undecidable':
 * every platform key, the tenant route permissions at tenant scope, and the store route permissions at store scope
 * (M7B-INVOICES-P1). A deployment serves only routes whose permission this answers true for (productionTransactions.ts
 * uncataloguedRoutePermissions).
 */
export function isDecidablePermission(scope: CanonicalPermissionScope, key: unknown): boolean {
  if (typeof key !== 'string') return false;
  if (scope === 'platform') return CANONICAL_PLATFORM_PERMISSIONS.has(key);
  if (scope === 'tenant') return TENANT_ROUTE_PERMISSIONS.has(key);
  if (scope === 'store') return STORE_ROUTE_PERMISSIONS.has(key);
  return false;
}

/**
 * A platform role as the canonical decision reads it: its level on each platform feature and its
 * explicit money grants (M5-GIAM-D1-P1). DATA, NEVER A NAME. The decision reads a role only through its
 * definition, so a built-in role and a custom role holding the same definition are decided identically,
 * and no role id is a shortcut — System Owner included, whose definition is Full on every feature with
 * its locked money grant. A level that is not a canonical one, a grant that is not exactly `true`, and a
 * key read through a prototype all deny.
 */
export interface PlatformRoleDefinition {
  readonly levels: Readonly<Record<string, PermissionLevelValue>>;
  readonly moneyGrants: Readonly<Record<string, boolean>>;
}

/**
 * The five built-in platform roles' definitions: the catalog's own role defaults and built-in money
 * grants, unchanged — so for them this decision answers exactly what materializePlatformSubPermissions
 * answers (m5CanonicalPermissions.test.ts proves it for every role, permission and limitation). This is
 * the only source a deployment has: the server holds no custom platform role, since migration 003's
 * user_membership_role_scope_chk admits the five built-in ids alone and no durable role store exists.
 */
export const BUILT_IN_PLATFORM_ROLES: ReadonlyMap<string, PlatformRoleDefinition> = Object.freeze(new Map(
  PLATFORM_ROLE_IDS.map((roleId) => [roleId, Object.freeze({
    levels: Object.freeze({ ...PLATFORM_ROLE_FEATURE_DEFAULTS[roleId] }),
    moneyGrants: Object.freeze({ ...builtInMoneyGrants(roleId) }) as Readonly<Record<string, boolean>>,
  })] as const),
));

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const isPlainRecord = (v: unknown): v is Readonly<Record<string, unknown>> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** The role's own level on `feature`, or 'none' for an absent, inherited or non-canonical one. */
function featureLevelOf(role: PlatformRoleDefinition, feature: string): PermissionLevelValue {
  const levels: unknown = role.levels;
  if (!isPlainRecord(levels) || !hasOwn(levels, feature)) return 'none';
  const level = levels[feature];
  return isPermissionLevel(level) ? level : 'none';
}

/**
 * Whether the role's definition grants the platform sub-permission: the parent feature's level meets the
 * sub's threshold on the platform ordering — or, for a money capability, meets the View minimum AND the
 * role holds the explicit grant — and every prerequisite is granted in turn (transitive, cycle-safe).
 * The same rule materializePlatformSubPermissions applies to the built-in defaults.
 */
function platformSubGranted(role: PlatformRoleDefinition, key: string, visiting: ReadonlySet<string>): boolean {
  const entry = CANONICAL_PLATFORM_PERMISSIONS.get(key);
  if (entry === undefined || entry.threshold === null) return false;
  const level = featureLevelOf(role, entry.parent);
  if (isPlatformMoneyCapability(key)) {
    if (!meetsPlatformPermissionLevel(level, PLATFORM_MONEY_PARENT_MINIMUM)) return false;
    if (!hasExplicitMoneyGrant(role.moneyGrants, key)) return false;
  } else if (!meetsPlatformPermissionLevel(level, entry.threshold)) {
    return false;
  }
  const prerequisites = hasOwn(PLATFORM_PERMISSION_DEPENDENCIES, key) ? PLATFORM_PERMISSION_DEPENDENCIES[key] : [];
  for (const prerequisite of prerequisites) {
    if (visiting.has(prerequisite)) continue; // cycle guard
    if (!platformSubGranted(role, prerequisite, new Set([...visiting, key]))) return false;
  }
  return true;
}

/**
 * Whether a role holds a canonical permission at a scope.
 *
 * 'granted' / 'denied' are decisions. 'undecidable' is NOT a denial a caller may cache or report as
 * one: it means this stage cannot answer, and the only correct response is to refuse the route at
 * startup rather than serve it. Every unknown — an unknown key, scope or role, a role that does not
 * belong to the scope's plane, a limitation that is neither 'none' nor 'read_only' — is 'denied',
 * fail-closed. An unrecognised limitation is not "no limitation". Each input field is read once.
 *
 * The platform evaluation decides the role through its DEFINITION (`roles`, the built-in definitions
 * unless a caller supplies others): the sub's threshold on the platform ordering against the role's
 * level on the parent feature, the explicit grant for a money capability, every prerequisite, and the
 * read-only cap that leaves only non-sensitive view-threshold grants standing. No role id is special:
 * System Owner is granted because its definition is Full everywhere, through this same rule.
 *
 * A tenant ROUTE permission (M7A-CUSTOMERS-P1) is decided by the catalog's tenant materializer: the role's level on the
 * permission's domain — its default, removed if the domain's plan gate is not entitled (the empty entitlement set here,
 * so a plan-gated domain materializes 'none' and denies; Customers is a core domain and never gated), capped to View
 * for a read-only limitation — must meet the threshold on the tenant family ordering. A role the materializer does not
 * know (a platform role, a custom or misspelled id) materializes nothing and is denied. A store ROUTE permission
 * (M7B-INVOICES-P1) is decided the same way at store scope, its corequisite domain (if any) on the same materialized role.
 * Every other tenant or store key remains 'undecidable'.
 *
 * M7A-CUSTOMERS-P3-R1: on that branch `levels` — the owner's durable edits of the selected role, as the database answered
 * them — are REQUIRED and replace the role's defaults for the domains they name; missing or malformed, the permission is
 * denied. An owner-only permission (edit_role_levels) is granted only to the owner role at limitation 'none', its levels
 * still required to be readable. Every other branch ignores `levels`.
 */
export function evaluateCanonicalPermission(input: {
  readonly scope: CanonicalPermissionScope;
  readonly roleId: string;
  readonly permission: string;
  readonly limitation: 'none' | 'read_only';
  readonly roles?: ReadonlyMap<string, PlatformRoleDefinition>;
  readonly levels?: unknown;
}): 'granted' | 'denied' | 'undecidable' {
  const { scope, roleId, permission, limitation, roles, levels } = input;
  const entry = canonicalPermission(scope, permission);
  if (entry === null) return 'denied';
  if (limitation !== 'none' && limitation !== 'read_only') return 'denied';
  // M7B-INVOICES-P1: a store route permission is decided exactly as a tenant one — the same required levels, read_only rule,
  // materializer and ordering — and, when it names a corequisite, the same materialized role must meet that too.
  if (scope === 'store' && STORE_ROUTE_PERMISSIONS.get(entry.key) === entry) {
    if (typeof roleId !== 'string' || !isPlainRecord(levels)) return 'denied';
    if (limitation === 'read_only' && (entry.threshold !== 'view' || entry.sensitive)) return 'denied';
    const materialized = materializeTenantPermissions(roleId, {}, limitation === 'read_only', levels);
    const meets = (parent: string, threshold: PermissionLevelValue | null): boolean => {
      const level = hasOwn(materialized, parent) ? materialized[parent] : 'none';
      return isPermissionLevel(level) && threshold !== null && meetsTenantPermissionLevel(level, threshold);
    };
    const corequisite = entry.corequisite;
    if (!meets(entry.parent, entry.threshold) || (corequisite !== undefined && !meets(corequisite.parent, corequisite.threshold))) return 'denied';
    return 'granted';
  }
  if (scope === 'tenant' && TENANT_ROUTE_PERMISSIONS.get(entry.key) === entry) {
    if (typeof roleId !== 'string') return 'denied';
    // The role's current definition is required: no edits read is not "no edits" (R3).
    if (!isPlainRecord(levels)) return 'denied';
    // THE READ_ONLY RULE (TENANT_ROUTE_THRESHOLDS): View only — create_customers, edit_customers and the sensitive
    // edit_role_levels are denied here. It also holds for a sensitive entry added to the (surface-frozen) map after the load-time check.
    if (limitation === 'read_only' && (entry.threshold !== 'view' || entry.sensitive)) return 'denied';
    // The materializer applies the edits (and refuses malformed ones with {}) before the gate and the cap.
    const materialized = materializeTenantPermissions(roleId, {}, limitation === 'read_only', levels);
    const level = hasOwn(materialized, entry.parent) ? materialized[entry.parent] : 'none';
    // THE OWNER RULE (header): the owner role, unlimited, whose edits were readable (the materializer answered its
    // complete map, not {}) — decided by role, never by a level.
    if (OWNER_ONLY_ROUTE_PERMISSIONS.has(entry.key)) {
      return roleId === TENANT_OWNER_ROLE_ID && limitation === 'none' && hasOwn(materialized, entry.parent) ? 'granted' : 'denied';
    }
    if (!isPermissionLevel(level) || entry.threshold === null || !meetsTenantPermissionLevel(level, entry.threshold)) return 'denied';
    return 'granted';
  }
  if (scope !== 'platform') return 'undecidable';
  const definitions = roles ?? BUILT_IN_PLATFORM_ROLES;
  const role = typeof roleId === 'string' && definitions instanceof Map ? definitions.get(roleId) : undefined;
  if (role === undefined || role === null || typeof role !== 'object') return 'denied';
  if (!platformSubGranted(role, entry.key, new Set())) return 'denied';
  if (limitation === 'read_only' && (entry.threshold !== 'view' || entry.sensitive)) return 'denied';
  return 'granted';
}
