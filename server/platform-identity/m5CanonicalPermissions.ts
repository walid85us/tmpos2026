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
// PURE AND INERT: no database, no environment, no network, no I/O, no logging, no side effect. It
// imports only the inert catalog and constants.
import {
  PLATFORM_SUB_PERMISSIONS,
  TENANT_SUB_PERMISSIONS,
  materializePlatformSubPermissions,
} from './permissionCatalog';
import { PLATFORM_ROLE_IDS } from './authorizationConstants';
import type { PermissionLevelValue } from './authorizationConstants';

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
  'tenant and store permissions are undecidable until the GAP-11 ordering unification and its six safeguards land (docs/phase-4/04 section 3)';

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
 * Whether a role holds a canonical permission at a scope.
 *
 * 'granted' / 'denied' are decisions. 'undecidable' is NOT a denial a caller may cache or report as
 * one: it means this stage cannot answer, and the only correct response is to refuse the route at
 * startup rather than serve it. Every unknown — an unknown key, scope or role, a role that does not
 * belong to the scope's plane, a limitation that is neither 'none' nor 'read_only' — is 'denied',
 * fail-closed. An unrecognised limitation is not "no limitation". Each input field is read once.
 *
 * The platform evaluation is the existing one, unchanged: materializePlatformSubPermissions applies
 * the role's default feature levels, the sub's threshold on the platform ordering, its prerequisites,
 * and the read-only cap that leaves only non-sensitive view-threshold grants standing. `system_owner`
 * keeps its locked Full short-circuit inside that function.
 */
export function evaluateCanonicalPermission(input: {
  readonly scope: CanonicalPermissionScope;
  readonly roleId: string;
  readonly permission: string;
  readonly limitation: 'none' | 'read_only';
}): 'granted' | 'denied' | 'undecidable' {
  const { scope, roleId, permission, limitation } = input;
  const entry = canonicalPermission(scope, permission);
  if (entry === null) return 'denied';
  if (limitation !== 'none' && limitation !== 'read_only') return 'denied';
  if (scope !== 'platform') return 'undecidable';
  if (!(PLATFORM_ROLE_IDS as readonly string[]).includes(roleId)) return 'denied';
  const granted = materializePlatformSubPermissions(roleId, limitation === 'read_only');
  return granted[entry.key] === true ? 'granted' : 'denied';
}
