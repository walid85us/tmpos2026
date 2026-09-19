// M5-GAP11-P5 — the canonical permission-family contract (docs/phase-4/10 ADR-19).
//
// THERE IS NO UNIVERSAL ORDERING OF THE SEVEN PERMISSION LEVELS. The product uses two families with
// different semantics, and they disagree about exactly one pair:
//   * tenant/store operational permissions:  none < view < create < edit < manage < approve < full
//   * platform governance permissions:       none < view < create < edit < approve < manage < full
// A single global ordering was tried as the GAP-11 candidate (P2/P3) and rejected in P4: whichever way
// `manage` and `approve` are ranked, one family's product answers change. So every comparison names
// its family explicitly, and the family comes from the permission being checked — the catalog entry
// the caller is evaluating — never from the role holding it, its default level, whether an owner
// edited it, or whether it is a custom role.
//
// ONE TABLE PER FAMILY, HERE ONLY. Both the client (accessConfig, platformPermissionsConfig, the role
// editors) and the DEV-only server spine (permissionCatalog, permissionDecision) compare levels
// through this module; nothing else carries a rank table.
//
// DENY BY DEFAULT: an unknown or malformed family, held level or required level denies. A comparison
// across families is refused, never coerced into either ordering.
//
// PURE: no imports at runtime, no DOM, no storage, no side effects — safe to import from the server.
import type { PermissionLevel } from '../types';

export type PermissionFamily = 'tenant_store' | 'platform';

/** Tenant/store operational ordering: `approve` satisfies `manage`; `manage` does not satisfy `approve`. */
export const TENANT_STORE_ORDERING: readonly PermissionLevel[] = Object.freeze([
  'none', 'view', 'create', 'edit', 'manage', 'approve', 'full',
] as const);

/** Platform governance ordering: `manage` satisfies `approve`; `approve` does not satisfy `manage`. */
export const PLATFORM_ORDERING: readonly PermissionLevel[] = Object.freeze([
  'none', 'view', 'create', 'edit', 'approve', 'manage', 'full',
] as const);

const ORDERING_BY_FAMILY: ReadonlyMap<string, readonly PermissionLevel[]> = new Map<string, readonly PermissionLevel[]>([
  ['tenant_store', TENANT_STORE_ORDERING],
  ['platform', PLATFORM_ORDERING],
]);

export const PERMISSION_FAMILIES: readonly PermissionFamily[] = Object.freeze(['tenant_store', 'platform'] as const);

/** Exactly one of the two family names — no trimming, no case folding, no inherited property name. */
export function isPermissionFamily(value: unknown): value is PermissionFamily {
  return typeof value === 'string' && ORDERING_BY_FAMILY.has(value);
}

/** Exactly one of the seven canonical level strings. The vocabulary is the same in both families. */
export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === 'string' && (TENANT_STORE_ORDERING as readonly string[]).includes(value);
}

/** The level's rank within the family, or -1 for an unknown family or a non-canonical level. */
export function permissionLevelRank(family: PermissionFamily, level: unknown): number {
  const ordering = typeof family === 'string' ? ORDERING_BY_FAMILY.get(family) : undefined;
  if (ordering === undefined || !isPermissionLevel(level)) return -1;
  return ordering.indexOf(level);
}

/** A level together with the family whose ordering gives it meaning. */
export interface FamilyLevel {
  readonly family: PermissionFamily;
  readonly level: PermissionLevel;
}

/**
 * The one comparison: does the held level satisfy the required level? Both sides carry their family,
 * and a held level from one family never answers a requirement from the other — that comparison is
 * refused (false), not converted. Each field is read once; a malformed side denies.
 */
export function meetsPermissionRequirement(held: FamilyLevel, required: FamilyLevel): boolean {
  if (typeof held !== 'object' || held === null || typeof required !== 'object' || required === null) return false;
  const heldFamily: unknown = held.family;
  const requiredFamily: unknown = required.family;
  if (!isPermissionFamily(heldFamily) || !isPermissionFamily(requiredFamily)) return false;
  if (heldFamily !== requiredFamily) return false; // cross-family: refused
  const h = permissionLevelRank(heldFamily, held.level);
  const r = permissionLevelRank(requiredFamily, required.level);
  return h >= 0 && r >= 0 && h >= r;
}

/** Same-family convenience: the held and required level are both read in `family`. */
export function meetsFamilyLevel(family: PermissionFamily, held: unknown, required: unknown): boolean {
  return meetsPermissionRequirement(
    { family, level: held as PermissionLevel },
    { family, level: required as PermissionLevel },
  );
}
