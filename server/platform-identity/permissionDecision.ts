// Phase 1.5 M2 — Server-side permission decision contract.
//
// Thin server-side authorization checks that MIRROR the existing, frozen
// client-side permission engine semantics WITHOUT importing or editing the
// frontend config:
//   - tenant 7-level hierarchy + meetsPermissionLevel → src/context/accessConfig.ts
//   - platform threshold semantics                    → src/owner/platformPermissionsConfig.ts
//   - sub-permission precedence                       → src/context/AccessContext.tsx (checkSubPermission)
//
// ONE COMPARISON RULE (M5-GAP11-P1-R1). The two level orderings are no longer
// duplicated here: both comparisons delegate to the server permission catalog
// (permissionCatalog.ts), which holds the orderings and the deny-by-default rule
// of docs/phase-4/04 §3 safeguard #4. Every vocabulary item a check names — the
// feature, domain or sub-permission, the level, the role — must be exactly one the
// catalog declares; anything else is a denial, never a weaker requirement.
//
// M2 evaluates ONLY against the dev-asserted permission snapshot
// (source 'dev_asserted_snapshot'); it does NOT read durable roles. Deny by
// default. Server-side only. Never imported by src/.

import type { PermissionLevel, RequestContext } from './requestContext';
import {
  PLATFORM_FEATURE_KEYS,
  TENANT_PERMISSION_DOMAINS,
  TENANT_SUB_PERMISSIONS,
  isPermissionLevel,
  meetsPlatformPermissionLevel,
  meetsTenantPermissionLevel,
} from './permissionCatalog';
import { PLATFORM_ROLE_IDS, TENANT_ROLE_IDS } from './authorizationConstants';

/** Mirrors accessConfig.meetsPermissionLevel (tenant ordering). Non-canonical on either side ⇒ false. */
export function meetsPermissionLevel(actual: string, required: PermissionLevel): boolean {
  return meetsTenantPermissionLevel(actual as PermissionLevel, required);
}

/** Mirrors platformPermissionsConfig.platformPermissionMeets (platform ordering). Non-canonical ⇒ false. */
export function platformPermissionMeets(actual: string, threshold: PermissionLevel): boolean {
  return meetsPlatformPermissionLevel(actual as PermissionLevel, threshold);
}

export type DecisionOutcome = 'allow' | 'deny' | 'deferred' | 'not_applicable';

export interface DecisionResult {
  decision: DecisionOutcome;
  reasonCode: string;
  humanReadableReason: string; // safe, non-leaking
}

function allow(reasonCode: string, reason: string): DecisionResult {
  return { decision: 'allow', reasonCode, humanReadableReason: reason };
}
function deny(reasonCode: string, reason: string): DecisionResult {
  return { decision: 'deny', reasonCode, humanReadableReason: reason };
}

// These denials never echo the rejected value: it is not vocabulary, so it is not safe text.
export function invalidRequirement(): DecisionResult {
  return deny('denied_invalid_requirement', 'The required permission is not in the permission catalog.');
}
const unknownRole = (): DecisionResult =>
  deny('denied_unknown_role', 'The asserted role is not in the role vocabulary.');
const malformedSnapshot = (): DecisionResult =>
  deny('denied_malformed_snapshot', 'The permission snapshot is malformed.');

/** Sub-permission definition needed to mirror checkSubPermission precedence. */
export interface SubPermissionContext {
  parentDomain: string;
  minModuleLevel: PermissionLevel;
  defaultLevel: PermissionLevel;
  /** Plan availability — supplied (dev-asserted) since the catalog + plan live client-side. */
  planAvailable: boolean;
}

function isAuthenticated(ctx: RequestContext): boolean {
  return ctx.authState === 'dev-asserted' && !!ctx.permissionSnapshot;
}

/** A plain record — not an array, a Date, a Map or any other object whose own keys are not the data. */
const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const hasOwn = (map: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);

/** An own entry of a snapshot map, or undefined. An inherited name ('constructor') is no entry. */
function ownEntry(map: Record<string, unknown>, key: string): unknown {
  return hasOwn(map, key) ? map[key] : undefined;
}

/**
 * The level the snapshot holds for `key`. An ABSENT entry is no grant, `none`, exactly as the frontend
 * reads a role without that domain; a PRESENT entry is returned as stored — even `undefined` — so a
 * non-canonical value reaches the comparison and is denied there rather than being mistaken for `none`.
 */
function heldLevel(map: Record<string, unknown>, key: string): string {
  return (hasOwn(map, key) ? map[key] : 'none') as string;
}

/** A role slot is either empty or exactly one of the vocabulary's ids; anything else is unknown. */
function roleSlotIsValid(v: unknown, vocabulary: readonly string[]): boolean {
  return v === null || (typeof v === 'string' && vocabulary.includes(v));
}

interface SnapshotView {
  readonly platformRoleId: string | null;
  readonly tenantRoleId: string | null;
  readonly permissions: Record<string, unknown>;
  readonly subPermissions: Record<string, unknown>;
}

/**
 * The snapshot, read once: both maps must be plain records, both role slots empty or a known role, and
 * at most one of them filled. Otherwise the denial to return.
 */
function readSnapshot(ctx: RequestContext): SnapshotView | DecisionResult {
  const { platformRoleId, tenantRoleId, permissions, subPermissions } =
    ctx.permissionSnapshot as unknown as Record<string, unknown>;
  if (!isRecord(permissions) || !isRecord(subPermissions)) return malformedSnapshot();
  if (!roleSlotIsValid(platformRoleId, PLATFORM_ROLE_IDS) || !roleSlotIsValid(tenantRoleId, TENANT_ROLE_IDS)) {
    return unknownRole();
  }
  // One actor, one role: a platform role AND a tenant role for one decision is ambiguous authority —
  // the catalog's materializeCapabilities refuses the same — so neither short-circuit may pick one.
  if (platformRoleId !== null && tenantRoleId !== null) {
    return deny('denied_ambiguous_role', 'The snapshot asserts more than one role.');
  }
  return {
    platformRoleId: platformRoleId as string | null,
    tenantRoleId: tenantRoleId as string | null,
    permissions,
    subPermissions,
  };
}

const isDecision = (v: SnapshotView | DecisionResult): v is DecisionResult => 'decision' in v;

/**
 * Platform action check. Mirrors:
 *   - scope disjointness (platform actions require platform scope)
 *   - System Owner short-circuit (accessConfig: system_owner ⇒ all; locked Full)
 *   - platform threshold semantics
 * Order: authenticated → scope → requirement vocabulary → role vocabulary → owner short-circuit →
 * permission. The requirement is checked before the owner short-circuit, so not even the owner clears
 * a feature or level the catalog does not declare.
 */
export function requirePlatformPermission(
  ctx: RequestContext,
  featureKey: string,
  threshold: PermissionLevel,
): DecisionResult {
  if (!isAuthenticated(ctx)) {
    return deny('denied_unauthenticated', 'No authenticated actor or permission snapshot.');
  }
  if (ctx.scope.scopeType !== 'platform' || !ctx.scope.platformScope) {
    return deny('denied_scope_mismatch', 'Platform action requires platform scope.');
  }
  if (typeof featureKey !== 'string' || !PLATFORM_FEATURE_KEYS.includes(featureKey) || !isPermissionLevel(threshold)) {
    return invalidRequirement();
  }
  const snap = readSnapshot(ctx);
  if (isDecision(snap)) return snap;
  if (snap.platformRoleId === null) return unknownRole(); // a platform action needs a platform role
  if (snap.platformRoleId === 'system_owner') {
    return allow('allowed_system_owner', 'System Owner has full platform access.');
  }
  return platformPermissionMeets(heldLevel(snap.permissions, featureKey), threshold)
    ? allow('allowed_permission_met', `Actor meets ${featureKey}:${threshold}.`)
    : deny('denied_missing_permission', `Actor lacks ${featureKey}:${threshold}.`);
}

/**
 * Tenant / store action check. Mirrors AccessContext getPermissionLevel /
 * checkPermission:
 *   - tenant/store scope + tenant_id required
 *   - store_owner short-circuit ⇒ full
 *   - 7-level tenant hierarchy
 * Order: authenticated → scope → tenant id → requirement vocabulary → role vocabulary → owner
 * short-circuit → permission.
 */
export function requireTenantPermission(
  ctx: RequestContext,
  domain: string,
  level: PermissionLevel,
): DecisionResult {
  if (!isAuthenticated(ctx)) {
    return deny('denied_unauthenticated', 'No authenticated actor or permission snapshot.');
  }
  if (ctx.scope.scopeType !== 'tenant' && ctx.scope.scopeType !== 'store') {
    return deny('denied_scope_mismatch', 'Tenant action requires tenant or store scope.');
  }
  if (!ctx.scope.tenantId) {
    return deny('denied_missing_tenant', 'Tenant action requires a resolvable tenant.');
  }
  if (typeof domain !== 'string' || !TENANT_PERMISSION_DOMAINS.includes(domain) || !isPermissionLevel(level)) {
    return invalidRequirement();
  }
  const snap = readSnapshot(ctx);
  if (isDecision(snap)) return snap;
  if (snap.tenantRoleId === null) return unknownRole(); // a tenant action needs a tenant role
  if (snap.tenantRoleId === 'store_owner') {
    return allow('allowed_store_owner', 'Store Owner has full tenant access.');
  }
  return meetsPermissionLevel(heldLevel(snap.permissions, domain), level)
    ? allow('allowed_permission_met', `Actor meets ${domain}:${level}.`)
    : deny('denied_missing_permission', `Actor lacks ${domain}:${level}.`);
}

/**
 * The caller's sub-permission definition, read once, when it is exactly the catalog's own definition
 * of `subPermissionId`; otherwise null. Two sources of configured authority that disagree — a route's
 * definition and the catalog's — are ambiguous, and ambiguity denies. `planAvailable` must be a real
 * boolean: a truthy string is not a plan.
 */
function canonicalSubDefinition(subPermissionId: unknown, subDef: unknown): SubPermissionContext | null {
  if (typeof subPermissionId !== 'string' || !isRecord(subDef)) return null;
  const def = TENANT_SUB_PERMISSIONS.find((s) => s.id === subPermissionId);
  if (def === undefined) return null;
  const { parentDomain, minModuleLevel, defaultLevel, planAvailable } = subDef;
  if (parentDomain !== def.parentDomain || minModuleLevel !== def.minModuleLevel
    || defaultLevel !== def.defaultLevel || typeof planAvailable !== 'boolean') return null;
  return { parentDomain: def.parentDomain, minModuleLevel: def.minModuleLevel, defaultLevel: def.defaultLevel, planAvailable };
}

/**
 * Sub-permission check. Mirrors AccessContext.checkSubPermission precedence:
 *   1. plan availability (deny if plan-locked) — runs BEFORE the owner short-circuit
 *   2. system_owner / store_owner short-circuit
 *   3. parent-domain minimum module level
 *   4. explicit per-role sub-permission grant — exactly `true` allows, exactly `false` revokes, and
 *      anything else stored there is malformed and denies (it never falls through to the default)
 *   5. default level fallback
 * (scope + tenant_id are server-side preconditions, checked first; then the requirement, then the
 * snapshot's role vocabulary.)
 */
export function requireSubPermission(
  ctx: RequestContext,
  subPermissionId: string,
  subDef: SubPermissionContext,
): DecisionResult {
  if (!isAuthenticated(ctx)) {
    return deny('denied_unauthenticated', 'No authenticated actor or permission snapshot.');
  }
  if (ctx.scope.scopeType !== 'tenant' && ctx.scope.scopeType !== 'store') {
    return deny('denied_scope_mismatch', 'Sub-permission action requires tenant or store scope.');
  }
  if (!ctx.scope.tenantId) {
    return deny('denied_missing_tenant', 'Sub-permission action requires a resolvable tenant.');
  }
  const def = canonicalSubDefinition(subPermissionId, subDef);
  if (def === null) return invalidRequirement();
  const snap = readSnapshot(ctx);
  if (isDecision(snap)) return snap;
  // A tenant role, or the System Owner's platform role, which the frontend grants every tenant capability.
  if (snap.tenantRoleId === null && snap.platformRoleId !== 'system_owner') return unknownRole();
  // 1. Plan availability runs BEFORE the owner short-circuit (mirrors the frontend).
  if (!def.planAvailable) {
    return deny('denied_plan_locked', 'Capability is not available on the current plan.');
  }
  // 2. Owner short-circuit.
  if (snap.platformRoleId === 'system_owner' || snap.tenantRoleId === 'store_owner') {
    return allow('allowed_owner', 'Owner role grants this sub-permission.');
  }
  // 3. Parent-domain minimum level.
  const parentLevel = heldLevel(snap.permissions, def.parentDomain);
  if (!meetsPermissionLevel(parentLevel, def.minModuleLevel)) {
    return deny('denied_parent_level', 'Actor lacks the required module level.');
  }
  // 4. Explicit grant — presence decides, so an own entry holding `undefined` is malformed, not absent.
  if (hasOwn(snap.subPermissions, subPermissionId)) {
    const explicit = ownEntry(snap.subPermissions, subPermissionId);
    if (explicit === true) return allow('allowed_explicit_grant', 'Sub-permission explicitly granted.');
    if (explicit === false) return deny('denied_explicit_revoke', 'Sub-permission explicitly revoked.');
    return malformedSnapshot();
  }
  // 5. Default fallback.
  return meetsPermissionLevel(parentLevel, def.defaultLevel)
    ? allow('allowed_default', 'Sub-permission granted by default for module level.')
    : deny('denied_default', 'Sub-permission not granted by default.');
}
