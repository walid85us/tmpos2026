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
// under a platform-scope requirement, precisely because M5 has not landed.
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
import {
  PLATFORM_PERMISSION_DEPENDENCIES,
  PLATFORM_ROLE_FEATURE_DEFAULTS,
  PLATFORM_SUB_PERMISSIONS,
  TENANT_SUB_PERMISSIONS,
  isPermissionLevel,
  meetsPlatformPermissionLevel,
} from './permissionCatalog';
import { PLATFORM_ROLE_IDS } from './authorizationConstants';
import type { PermissionLevelValue } from './authorizationConstants';
import {
  PLATFORM_MONEY_PARENT_MINIMUM,
  builtInMoneyGrants,
  hasExplicitMoneyGrant,
  isPlatformMoneyCapability,
} from '../../src/authorization/moneyCapabilities';

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

/** The one message a refusal to evaluate the tenant plane carries, so every caller says the same thing. */
export const GAP_11_TENANT_ORDERING_UNRESOLVED =
  'tenant and store permissions are undecidable until owner decision D1 defines a specific route and its authoritative product rules (docs/phase-4/04 section 3, M5-GAP11-P5)';

/**
 * The canonical permission for (scope, key), or null. Exact and case-sensitive: no trimming, no
 * lowercasing, no alias, no prefix match. A platform scope reads the platform plane; tenant and store
 * scopes read the tenant plane, which is the same plane for both (a store role is a tenant role). Any
 * other scope names no plane, so nothing is found in it (M5-GAP11-P1-R1: it used to read the tenant
 * plane, as if an unknown scope were a tenant one).
 */
export function canonicalPermission(scope: CanonicalPermissionScope, key: unknown): CanonicalPermission | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (scope === 'platform') return CANONICAL_PLATFORM_PERMISSIONS.get(key) ?? null;
  if (scope === 'tenant' || scope === 'store') return CANONICAL_TENANT_PERMISSIONS.get(key) ?? null;
  return null;
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
 */
export function evaluateCanonicalPermission(input: {
  readonly scope: CanonicalPermissionScope;
  readonly roleId: string;
  readonly permission: string;
  readonly limitation: 'none' | 'read_only';
  readonly roles?: ReadonlyMap<string, PlatformRoleDefinition>;
}): 'granted' | 'denied' | 'undecidable' {
  const { scope, roleId, permission, limitation, roles } = input;
  const entry = canonicalPermission(scope, permission);
  if (entry === null) return 'denied';
  if (limitation !== 'none' && limitation !== 'read_only') return 'denied';
  if (scope !== 'platform') return 'undecidable';
  const definitions = roles ?? BUILT_IN_PLATFORM_ROLES;
  const role = typeof roleId === 'string' && definitions instanceof Map ? definitions.get(roleId) : undefined;
  if (role === undefined || role === null || typeof role !== 'object') return 'denied';
  if (!platformSubGranted(role, entry.key, new Set())) return 'denied';
  if (limitation === 'read_only' && (entry.threshold !== 'view' || entry.sensitive)) return 'denied';
  return 'granted';
}
