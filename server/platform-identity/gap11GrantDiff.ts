// Phase 4.0 M5 — GAP-11 safeguard #2: the before/after effective-grant diff (docs/phase-4/04 §3).
//
// WHAT THIS IS. docs/phase-4/04 §3 records two conflicting level orderings — the tenant engine ranks
// `manage < approve`, the platform engine ranks `approve < manage` — and adopts the platform ordering
// as canonical. That migration "changes effective grants by construction", so 04 §3 binds it to six
// safeguards. This module is safeguard #2: it enumerates every canonical (role, scope, action) tuple
// and evaluates it twice, under the ordering that ships today and under the unified candidate, so the
// owner can see every changed grant before deciding anything.
//
// WHAT THIS IS NOT. It re-pins nothing (safeguard #1, blocked on owner decision D2), approves nothing
// (safeguard #3, blocked on D3), and cuts nothing over. THE CANDIDATE EVALUATOR IS OBSERVATIONAL. It
// is never consulted for a real authorization decision: `materializeTenant*` / `materializePlatform*`
// in permissionCatalog.ts remain the sole authority, and nothing here is imported by a request path.
//
// WHY THE TWO EVALUATORS ARE BUILT DIFFERENTLY, ON PURPOSE. A single `evaluate(ordering)` parameterised
// twice would be worthless evidence: one defect in it makes every comparison agree, and "no grants
// changed" would be indistinguishable from "the comparison is broken". So BEFORE *delegates to the
// shipped production functions* — it is the authoritative behaviour, not a copy of it — while
// AFTER-CANDIDATE is an independent implementation carrying its own rank table. They share only the
// vocabulary they must share (the catalog's roles, domains, features, actions), never a decision path.
//
// THE BUILT-IN POSITIVE CONTROL. The platform plane ALREADY uses the unified ordering, so for every
// platform tuple the candidate must reproduce the authoritative answer exactly. A candidate that is
// broken in general cannot pass that, which is what makes a reported "no change" on the other planes
// evidence rather than silence. `PLATFORM_PLANE_IS_ORDERING_STABLE` asserts it.
//
// PURE AND INERT: no database, no environment, no network, no I/O, no logging, no side effect, no
// clock, no randomness. It imports only the inert catalog and constants.
import {
  TENANT_PERMISSION_DOMAINS,
  TENANT_SUB_PERMISSIONS,
  TENANT_ROLE_PERMISSION_DEFAULTS,
  TENANT_ROLE_SUBPERMISSION_DEFAULTS,
  TENANT_DOMAIN_ENTITLEMENT,
  TENANT_FEATURE_PERMISSION_DEPENDENCIES,
  FEATURE_KEY_ALIASES,
  KNOWN_TENANT_ENTITLEMENT_KEYS,
  TENANT_ORDERING,
  PLATFORM_ORDERING,
  PLATFORM_FEATURE_KEYS,
  PLATFORM_SUB_PERMISSIONS,
  PLATFORM_ROLE_FEATURE_DEFAULTS,
  PLATFORM_PERMISSION_DEPENDENCIES,
  materializeTenantPermissions,
  materializeTenantSubPermissions,
  materializePlatformPermissions,
  materializePlatformSubPermissions,
  meetsTenantPermissionLevel,
  meetsPlatformPermissionLevel,
} from './permissionCatalog';
import {
  TENANT_ROLE_IDS,
  PLATFORM_ROLE_IDS,
  PERMISSION_LEVEL_VALUES,
} from './authorizationConstants';
import type { PermissionLevelValue, TenantRoleId, PlatformRoleId } from './authorizationConstants';
import type { FeatureEntitlements } from './authorizationContract';

type Level = PermissionLevelValue;

// =============================================================================
// The candidate ordering — declared here, never imported from the catalog
// =============================================================================

/**
 * The unified ordering docs/phase-4/04 §3 names canonical: `approve` BELOW `manage`. Written out in
 * full rather than aliased to PLATFORM_ORDERING so the candidate does not inherit the authoritative
 * module's table — if the catalog's platform ordering were ever edited, this diff would report the
 * divergence instead of silently moving with it.
 */
export const UNIFIED_CANDIDATE_ORDERING: readonly Level[] = Object.freeze([
  'none', 'view', 'create', 'edit', 'approve', 'manage', 'full',
] as const) as readonly Level[];

const UNIFIED_RANK: ReadonlyMap<string, number> = Object.freeze(
  new Map(UNIFIED_CANDIDATE_ORDERING.map((l, i) => [l as string, i] as const)),
);

/**
 * The candidate comparator — safeguard #4 applied to both sides, never a thrown error.
 *
 * An unknown level on EITHER side denies outright — even against a `none` requirement, which only a
 * recognised level clears. That is deliberately stricter than the shipped comparators: `rankIn` in
 * permissionCatalog.ts (and its mirror in permissionDecision.ts) maps an unknown level to rank 0, so a
 * requirement nobody can name is satisfied by everyone — including a `none` holder. No catalog-defined
 * level is unknown today, so no effective grant depends on the difference and the diff is unaffected;
 * but "any level not in the unified catalog denies" (04 §3 #4) is the rule the unified evaluator has
 * to meet, so this one meets it.
 */
export function candidateMeetsLevel(actual: unknown, required: unknown): boolean {
  if (typeof actual !== 'string' || typeof required !== 'string') return false;
  const a = UNIFIED_RANK.get(actual);
  const r = UNIFIED_RANK.get(required);
  if (a === undefined || r === undefined) return false; // unrecognised is not weaker — it denies
  return a >= r;
}

/** The candidate's own read-only cap: anything above `view` collapses to `view`. */
function candidateCapForReadOnly(level: Level): Level {
  return (UNIFIED_RANK.get(level) ?? 0) > (UNIFIED_RANK.get('view') ?? 1) ? 'view' : level;
}

// =============================================================================
// The canonical grant universe
// =============================================================================

export type GrantPlane = 'tenant' | 'platform';
/**
 * `sub_permission` — a named boolean capability. `domain_threshold` — whether a role's level on a
 * domain/feature satisfies a required level. The ordering flip is a statement about LEVEL COMPARISON,
 * so a diff that enumerated only named capabilities would miss every threshold check and report a
 * false "nothing changed".
 */
export type GrantStratum = 'sub_permission' | 'domain_threshold';
export type GrantOutcome = 'granted' | 'denied';
export type ChangeClass = 'widened' | 'narrowed';

/**
 * The ordering flip is not a broad reshuffle: exactly two comparisons change truth value, because
 * `manage` and `approve` swap rank and every other level keeps its index. Every changed row is
 * therefore one of these two, and naming which one is what makes a row reviewable.
 *   - `manage_satisfies_approve`  — a `manage`-holder newly clears an `approve` gate (widening).
 *   - `approve_no_longer_satisfies_manage` — an `approve`-holder stops clearing a `manage` gate
 *     (narrowing). 04 §3 warns only about the first; the second is just as real and cuts the
 *     other way, which is why the diff classifies rather than summarises.
 */
export type FlipPair = 'manage_satisfies_approve' | 'approve_no_longer_satisfies_manage';

export interface CanonicalGrantTuple {
  readonly plane: GrantPlane;
  readonly stratum: GrantStratum;
  readonly role: string;
  /** Parent domain (tenant) or feature group (platform). */
  readonly scope: string;
  /** Sub-permission id, or `require:<level>` for a threshold tuple. One action string per tuple. */
  readonly action: string;
  /** Non-null only on `domain_threshold`. */
  readonly requiredLevel: Level | null;
  /**
   * On a `sub_permission` tuple this is the shipped catalog's own classification, carried through
   * unchanged (`mutating` on the tenant plane, `sensitive` on the platform plane). On a
   * `domain_threshold` tuple the catalog classifies nothing — a bare threshold is not a capability —
   * so it is declared here as "any required level above `view`", i.e. a write-or-higher gate. The two
   * are not the same kind of fact and the artifact does not present them as one.
   */
  readonly sensitive: boolean;
  /** True when the tuple's decisive required level is `approve` — the level the flip moves. */
  readonly approveGated: boolean;
}

/** Stable, documented ordering: plane, stratum, role, scope, action — all lexical, no locale. */
export function grantTupleKey(t: CanonicalGrantTuple): string {
  return `${t.plane}\u0000${t.stratum}\u0000${t.role}\u0000${t.scope}\u0000${t.action}`;
}

function compareTuples(a: CanonicalGrantTuple, b: CanonicalGrantTuple): number {
  const ka = grantTupleKey(a);
  const kb = grantTupleKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Every canonical tuple, exactly once, in stable order. Built by enumerating the catalog — never by
 * re-listing a vocabulary here, so an action added or removed there is added or removed from the
 * universe with it, and the asserted counts below fail rather than drift.
 */
export const CANONICAL_GRANT_UNIVERSE: readonly CanonicalGrantTuple[] = (() => {
  const out: CanonicalGrantTuple[] = [];

  for (const role of TENANT_ROLE_IDS) {
    for (const sub of TENANT_SUB_PERMISSIONS) {
      out.push(Object.freeze({
        plane: 'tenant' as const, stratum: 'sub_permission' as const, role: role as string,
        scope: sub.parentDomain, action: sub.id, requiredLevel: null,
        sensitive: sub.mutating, approveGated: sub.defaultLevel === 'approve',
      }));
    }
    for (const domain of TENANT_PERMISSION_DOMAINS) {
      for (const required of PERMISSION_LEVEL_VALUES) {
        out.push(Object.freeze({
          plane: 'tenant' as const, stratum: 'domain_threshold' as const, role: role as string,
          scope: domain, action: `require:${required}`, requiredLevel: required,
          sensitive: required !== 'none' && required !== 'view', approveGated: required === 'approve',
        }));
      }
    }
  }

  for (const role of PLATFORM_ROLE_IDS) {
    for (const sub of PLATFORM_SUB_PERMISSIONS) {
      out.push(Object.freeze({
        plane: 'platform' as const, stratum: 'sub_permission' as const, role: role as string,
        scope: sub.feature, action: sub.id, requiredLevel: null,
        sensitive: sub.sensitive, approveGated: sub.threshold === 'approve',
      }));
    }
    for (const feature of PLATFORM_FEATURE_KEYS) {
      for (const required of PERMISSION_LEVEL_VALUES) {
        out.push(Object.freeze({
          plane: 'platform' as const, stratum: 'domain_threshold' as const, role: role as string,
          scope: feature, action: `require:${required}`, requiredLevel: required,
          sensitive: required !== 'none' && required !== 'view', approveGated: required === 'approve',
        }));
      }
    }
  }

  out.sort(compareTuples);
  return Object.freeze(out);
})();

/**
 * The counts the universe must have. Asserted rather than derived: a silently shrinking universe is
 * exactly the failure that would make an empty diff look like good news.
 */
export const UNIVERSE_SHAPE = Object.freeze({
  tenantRoles: TENANT_ROLE_IDS.length,
  tenantDomains: TENANT_PERMISSION_DOMAINS.length,
  tenantSubPermissions: TENANT_SUB_PERMISSIONS.length,
  platformRoles: PLATFORM_ROLE_IDS.length,
  platformFeatures: PLATFORM_FEATURE_KEYS.length,
  platformSubPermissions: PLATFORM_SUB_PERMISSIONS.length,
  levels: PERMISSION_LEVEL_VALUES.length,
  tenantSubTuples: TENANT_ROLE_IDS.length * TENANT_SUB_PERMISSIONS.length,
  tenantThresholdTuples:
    TENANT_ROLE_IDS.length * TENANT_PERMISSION_DOMAINS.length * PERMISSION_LEVEL_VALUES.length,
  platformSubTuples: PLATFORM_ROLE_IDS.length * PLATFORM_SUB_PERMISSIONS.length,
  platformThresholdTuples:
    PLATFORM_ROLE_IDS.length * PLATFORM_FEATURE_KEYS.length * PERMISSION_LEVEL_VALUES.length,
  total:
    TENANT_ROLE_IDS.length * TENANT_SUB_PERMISSIONS.length +
    TENANT_ROLE_IDS.length * TENANT_PERMISSION_DOMAINS.length * PERMISSION_LEVEL_VALUES.length +
    PLATFORM_ROLE_IDS.length * PLATFORM_SUB_PERMISSIONS.length +
    PLATFORM_ROLE_IDS.length * PLATFORM_FEATURE_KEYS.length * PERMISSION_LEVEL_VALUES.length,
});

const CANONICAL_BY_KEY: ReadonlyMap<string, CanonicalGrantTuple> = new Map(
  CANONICAL_GRANT_UNIVERSE.map((t) => [grantTupleKey(t), t] as const),
);

/**
 * The canonical tuple a value names, or null. Shared by both evaluators and the shadow comparator as
 * VOCABULARY parsing — it decides nothing about grants, only whether the input is one of the tuples
 * the universe defines. Every field must match exactly (so a caller cannot smuggle a field boundary
 * through the key separator), each caller-supplied field is read exactly once (so a getter cannot
 * answer differently on a second read), and what is returned is the universe's own frozen tuple — a
 * caller's object never flows further than this function.
 */
export function canonicalTupleFor(value: unknown): CanonicalGrantTuple | null {
  if (typeof value !== 'object' || value === null) return null;
  let fields: Record<string, unknown>;
  try {
    const { plane, stratum, role, scope, action, requiredLevel, sensitive, approveGated } =
      value as Record<string, unknown>;
    fields = { plane, stratum, role, scope, action, requiredLevel, sensitive, approveGated };
  } catch {
    return null; // a tuple that throws while being read (a trap, a revoked proxy) is malformed
  }
  const { plane, stratum, role, scope, action, requiredLevel, sensitive, approveGated } = fields;
  if (typeof plane !== 'string' || typeof stratum !== 'string' || typeof role !== 'string'
    || typeof scope !== 'string' || typeof action !== 'string') return null;
  const t = CANONICAL_BY_KEY.get(`${plane}\u0000${stratum}\u0000${role}\u0000${scope}\u0000${action}`);
  if (t === undefined) return null;
  if (t.plane !== plane || t.stratum !== stratum || t.role !== role || t.scope !== scope
    || t.action !== action || t.requiredLevel !== requiredLevel
    || t.sensitive !== sensitive || t.approveGated !== approveGated) return null;
  return t;
}

// =============================================================================
// The evaluation context
// =============================================================================

/**
 * A frozen copy of the context, or `null`. Each caller-supplied field is read exactly once, so a
 * getter cannot answer the validation differently from the evaluation; a context that throws while
 * being read is malformed. An unrecognised limitation is not "no limitation": both evaluators deny
 * rather than treat an unknown account state as unrestricted.
 *
 * The entitlement field is read only for a TENANT tuple (the platform materializers never receive it,
 * so for a platform tuple not even the field is touched), and the map is then read by exactly the
 * operation the catalog performs on it — Object.entries, once — and by nothing else, so no getter or
 * proxy trap production never fires can run caller code in between. That is why there is
 * no "plain record" check: whatever the container, only its own enumerable string properties count,
 * exactly as in production, and entitlements are cap-only (a gate can only remove a grant). Only null
 * and undefined are refused — the values production's own read throws on — by a check that fires no
 * trap.
 */
export function snapshotContext(ctx: unknown, plane: GrantPlane = 'tenant'): GrantEvaluationContext | null {
  try {
    if (typeof ctx !== 'object' || ctx === null) return null;
    const fields = ctx as Record<string, unknown>;
    const limitation = fields.limitation;
    if (limitation !== 'none' && limitation !== 'read_only') return null;
    // A platform tuple never consults entitlements, so the field is not even read.
    if (plane !== 'tenant') return Object.freeze({ entitlements: NO_ENTITLEMENTS, limitation });
    const entitlements = fields.entitlements;
    if (entitlements === null || entitlements === undefined) return null;
    // Own enumerable STRING keys, never symbols. Only `=== true` enables a gate in the catalog, so
    // storing that comparison keeps parity and makes the type true.
    const copy = Object.freeze(Object.fromEntries(
      Object.entries(entitlements).map(([k, v]) => [k, v === true] as const),
    )) as FeatureEntitlements;
    return Object.freeze({ entitlements: copy, limitation });
  } catch {
    return null;
  }
}

export interface GrantEvaluationContext {
  /** Tenant entitlement map. Platform tuples ignore it — the platform plane has no plan gating. */
  readonly entitlements: FeatureEntitlements;
  /** `read_only` applies the status cap. */
  readonly limitation: 'none' | 'read_only';
}

/** What a platform tuple carries instead of the caller's map: the platform plane never reads one. */
const NO_ENTITLEMENTS: FeatureEntitlements = Object.freeze({});

/** Every known entitlement enabled — the MAXIMAL-grant context, where a flip has the most room. */
export const FULLY_ENTITLED: FeatureEntitlements = Object.freeze(
  Object.fromEntries([...KNOWN_TENANT_ENTITLEMENT_KEYS].sort().map((k) => [k, true])),
);

/**
 * The context the committed artifact is computed in. Declared, not implied: a diff without its
 * context is not decidable evidence. Maximal grant, so nothing is masked by plan gating or the
 * read-only cap — and the suite proves no other context produces a change outside this one's set.
 */
export const CANONICAL_DIFF_CONTEXT: GrantEvaluationContext = Object.freeze({
  entitlements: FULLY_ENTITLED,
  limitation: 'none' as const,
});

// =============================================================================
// BEFORE — the authoritative behaviour, by delegation to the shipped evaluators
// =============================================================================

/**
 * The grant that ships today. Every answer comes from permissionCatalog.ts, so this cannot drift from
 * production: if it is wrong, production is wrong, and the existing catalog suites fail first. A
 * tuple that is not exactly a canonical one is denied before production is consulted — the shipped
 * materializers key a sub-permission by action alone, so a tuple with a mismatched scope or level
 * would otherwise borrow a real grant.
 */
export function evaluateBefore(tuple: unknown, context: GrantEvaluationContext): GrantOutcome {
  const t = canonicalTupleFor(tuple);
  const ctx = t === null ? null : snapshotContext(context, t.plane);
  if (t === null || ctx === null) return 'denied';
  const limited = ctx.limitation === 'read_only';
  if (t.plane === 'tenant') {
    if (t.stratum === 'sub_permission') {
      const subs = materializeTenantSubPermissions(t.role as TenantRoleId, ctx.entitlements, limited);
      return subs[t.action] === true ? 'granted' : 'denied';
    }
    const perms = materializeTenantPermissions(t.role as TenantRoleId, ctx.entitlements, limited);
    const level = perms[t.scope];
    if (level === undefined) return 'denied'; // unknown domain ⇒ fail closed
    return meetsTenantPermissionLevel(level, t.requiredLevel as Level) ? 'granted' : 'denied';
  }
  if (t.stratum === 'sub_permission') {
    const subs = materializePlatformSubPermissions(t.role as PlatformRoleId, limited);
    return subs[t.action] === true ? 'granted' : 'denied';
  }
  const perms = materializePlatformPermissions(t.role as PlatformRoleId, limited);
  const level = perms[t.scope];
  if (level === undefined) return 'denied';
  return meetsPlatformPermissionLevel(level, t.requiredLevel as Level) ? 'granted' : 'denied';
}

// =============================================================================
// AFTER-CANDIDATE — an independent implementation on the unified ordering
// =============================================================================
//
// Re-derived from the catalog's DATA, never from its decision functions, so a defect in one evaluator
// cannot hide itself in the other. The precedence it reproduces is the one permissionCatalog.ts
// documents and the one the frontend engine implements: entitlement gate, owner short-circuit,
// parent minimum level, explicit per-role grant, default-by-level, read-only cap. That includes the
// entitlement layer — which gates a sub-permission needs, and how an alias key such as `supply_chain`
// counts for its canonical gate `supply-chain` — so that a defect in the catalog's own gate helpers
// cannot make both evaluators agree.

/**
 * Whether an entitlement gate is enabled, reproducing the catalog's normalization independently: a
 * gate counts when it is set `true` under its own name (unless that name is itself an alias) or under
 * any alias that maps to it. Own enumerable keys only, as the catalog reads them.
 */
function candidateEntitled(ent: FeatureEntitlements, gate: string): boolean {
  const aliases = FEATURE_KEY_ALIASES as Record<string, string>;
  const own = (k: string): boolean => Object.prototype.propertyIsEnumerable.call(ent, k) && ent[k] === true;
  if (!Object.prototype.hasOwnProperty.call(aliases, gate) && own(gate)) return true;
  for (const alias of Object.keys(aliases)) {
    if (aliases[alias] === gate && own(alias)) return true;
  }
  return false;
}

/** The gates a tenant sub needs: its parent domain's plan gate, if any, and every feature listing it. */
function candidateGatesFor(subId: string, parentDomain: string): string[] {
  const gates: string[] = [];
  const domainGate = (TENANT_DOMAIN_ENTITLEMENT as Record<string, string | null>)[parentDomain];
  if (domainGate) gates.push(domainGate);
  for (const feature of Object.keys(TENANT_FEATURE_PERMISSION_DEPENDENCIES)) {
    if (TENANT_FEATURE_PERMISSION_DEPENDENCIES[feature].includes(subId)) gates.push(feature);
  }
  return gates;
}

function candidateTenantDomainLevel(
  role: string, domain: string, ctx: GrantEvaluationContext, applyCap: boolean,
): Level {
  let base: Level;
  if (role === 'store_owner') base = 'full';
  else {
    const map = (TENANT_ROLE_PERMISSION_DEFAULTS as unknown as Record<string, Record<string, Level>>)[role];
    base = (map?.[domain] ?? 'none') as Level;
  }
  if (base !== 'none') {
    const gate = (TENANT_DOMAIN_ENTITLEMENT as Record<string, string | null>)[domain];
    if (gate && !candidateEntitled(ctx.entitlements, gate)) base = 'none';
  }
  if (applyCap && ctx.limitation === 'read_only') base = candidateCapForReadOnly(base);
  return base;
}

function candidatePlatformFeatureLevel(
  role: string, feature: string, ctx: GrantEvaluationContext, applyCap: boolean,
): Level {
  let base: Level;
  if (role === 'system_owner') base = 'full';
  else {
    const map = (PLATFORM_ROLE_FEATURE_DEFAULTS as unknown as Record<string, Record<string, Level>>)[role];
    base = (map?.[feature] ?? 'none') as Level;
  }
  if (applyCap && ctx.limitation === 'read_only') base = candidateCapForReadOnly(base);
  return base;
}

function candidatePlatformSub(role: string, subId: string, visiting: ReadonlySet<string>): boolean {
  const def = PLATFORM_SUB_PERMISSIONS.find((s) => s.id === subId);
  if (def === undefined) return false; // unknown sub ⇒ fail closed
  const level = role === 'system_owner'
    ? ('full' as Level)
    : (((PLATFORM_ROLE_FEATURE_DEFAULTS as unknown as Record<string, Record<string, Level>>)[role]?.[def.feature]
        ?? 'none') as Level);
  if (!candidateMeetsLevel(level, def.threshold)) return false;
  const deps = (PLATFORM_PERMISSION_DEPENDENCIES as Record<string, readonly string[]>)[subId] ?? [];
  for (const dep of deps) {
    if (visiting.has(dep)) continue; // cycle guard
    const next = new Set(visiting);
    next.add(subId);
    if (!candidatePlatformSub(role, dep, next)) return false;
  }
  return true;
}

/**
 * The grant the unified ordering WOULD produce, before any owner-approved re-pin. Observational.
 * Anything that is not exactly a canonical tuple — an unknown role, scope, action or level, or a
 * mismatched combination of known ones — is denied (04 §3 #4).
 */
export function evaluateAfterCandidate(tuple: unknown, context: GrantEvaluationContext): GrantOutcome {
  const t = canonicalTupleFor(tuple);
  const ctx = t === null ? null : snapshotContext(context, t.plane);
  if (t === null || ctx === null) return 'denied';
  const limited = ctx.limitation === 'read_only';
  if (t.plane === 'tenant') {
    if (t.stratum === 'sub_permission') {
      const sub = TENANT_SUB_PERMISSIONS.find((s) => s.id === t.action);
      if (sub === undefined) return 'denied';
      let granted: boolean;
      const gates = candidateGatesFor(sub.id, sub.parentDomain);
      if (!gates.every((g) => candidateEntitled(ctx.entitlements, g))) granted = false;
      else if (t.role === 'store_owner') granted = true;
      else {
        const parent = candidateTenantDomainLevel(t.role, sub.parentDomain, ctx, false);
        if (!candidateMeetsLevel(parent, sub.minModuleLevel)) granted = false;
        else {
          const explicitMap =
            (TENANT_ROLE_SUBPERMISSION_DEFAULTS as unknown as Record<string, Record<string, boolean>>)[t.role];
          const explicit = explicitMap ? explicitMap[sub.id] : undefined;
          granted = explicit !== undefined ? explicit : candidateMeetsLevel(parent, sub.defaultLevel);
        }
      }
      if (limited && sub.mutating) granted = false;
      return granted ? 'granted' : 'denied';
    }
    const level = candidateTenantDomainLevel(t.role, t.scope, ctx, true);
    return candidateMeetsLevel(level, t.requiredLevel) ? 'granted' : 'denied';
  }

  if (t.stratum === 'sub_permission') {
    const def = PLATFORM_SUB_PERMISSIONS.find((s) => s.id === t.action);
    if (def === undefined) return 'denied';
    let granted = candidatePlatformSub(t.role, t.action, new Set<string>());
    if (limited && granted && (def.threshold !== 'view' || def.sensitive)) granted = false;
    return granted ? 'granted' : 'denied';
  }
  const level = candidatePlatformFeatureLevel(t.role, t.scope, ctx, true);
  return candidateMeetsLevel(level, t.requiredLevel) ? 'granted' : 'denied';
}

// =============================================================================
// The diff
// =============================================================================

export interface GrantDiffRow {
  readonly plane: GrantPlane;
  readonly stratum: GrantStratum;
  readonly role: string;
  readonly scope: string;
  readonly action: string;
  readonly requiredLevel: Level | null;
  /**
   * The level the role actually holds on `scope`, as the authoritative evaluator materializes it.
   * Without it a row says a grant moved but not why; with it the owner can read the flip directly
   * (`holds manage, gate is approve`) instead of reconstructing it. A level token, nothing more.
   */
  readonly heldLevel: Level | null;
  readonly before: GrantOutcome;
  readonly after: GrantOutcome;
  readonly change: ChangeClass;
  /** Which of the two flipping comparisons produced this row. */
  readonly flipPair: FlipPair;
  readonly sensitive: boolean;
  readonly approveGated: boolean;
  /** True when the row waits on decision D2, the open re-pin policy choice (04 §3 safeguard #1). */
  readonly blockedOnD2: boolean;
}

export interface GrantDiffSummary {
  readonly evaluated: number;
  readonly unchanged: number;
  readonly widened: number;
  readonly narrowed: number;
  readonly blockedOnD2: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly byScope: Readonly<Record<string, number>>;
  readonly byAction: Readonly<Record<string, number>>;
}

export interface GrantDiff {
  /** The context the diff was computed in, or `null` when the one given was malformed (then no row exists). */
  readonly context: GrantEvaluationContext | null;
  readonly shape: typeof UNIVERSE_SHAPE;
  readonly rows: readonly GrantDiffRow[];
  readonly summary: GrantDiffSummary;
}

/**
 * Capabilities docs/phase-4/04 §2 declares satisfiable ONLY by their specific named grant, so that a
 * broad `manage`/`full` level can never confer them. 04 §2 folds them into the §3 re-pin + grant-diff
 * safeguard by name, so a changed row touching one is an owner decision even when the ordering did
 * not move it. None is present in the shipped catalog today; the list is carried so that adding one
 * lands it in the D2 bucket instead of passing unnoticed.
 */
export const D2_NAMED_GRANT_ONLY_ACTIONS: readonly string[] = Object.freeze([
  'activate_payment_gateway',
  'disconnect_payment_gateway',
  'manage_payment_gateway_connections',
  'manage_payment_terminals',
]);

/**
 * Whether a CHANGED row waits on decision D2 — the open policy choice 04 §3 safeguard #1 leaves
 * unmade: how an `approve`-gated action is re-pinned (`≥ manage`, or an explicit per-role grant).
 *
 * That choice governs rows whose gate IS `approve`, plus the capabilities 04 §2 folds into the same
 * safeguard by name. A changed row gated at `manage` — the one narrowing, an `approve`-holder that
 * stops clearing a `manage` gate — is not a re-pin question: it is part of the diff safeguard #3
 * requires the owner to approve (D3), and D2's choice can make it matter more or less, but D2 does
 * not settle it. Every changed row waits on D3; only these wait on D2 as well.
 */
function isBlockedOnD2(t: CanonicalGrantTuple): boolean {
  return t.approveGated || D2_NAMED_GRANT_ONLY_ACTIONS.includes(t.action);
}

/** Compute the full diff. Deterministic: same inputs, same rows, same order, every time. */
export function computeGrantDiff(context: GrantEvaluationContext = CANONICAL_DIFF_CONTEXT): GrantDiff {
  // One copy for every read below. A malformed context is never read again: an empty stand-in is one
  // both evaluators deny, so no row is produced.
  const snapshot = snapshotContext(context);
  const ctx = snapshot ?? (Object.freeze({}) as GrantEvaluationContext);
  const rows: GrantDiffRow[] = [];
  const byRole: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let widened = 0;
  let narrowed = 0;
  let blocked = 0;

  for (const t of CANONICAL_GRANT_UNIVERSE) {
    const before = evaluateBefore(t, ctx);
    const after = evaluateAfterCandidate(t, ctx);
    if (before === after) continue;
    const change: ChangeClass = before === 'denied' ? 'widened' : 'narrowed';
    const flipPair: FlipPair = change === 'widened'
      ? 'manage_satisfies_approve'
      : 'approve_no_longer_satisfies_manage';
    if (change === 'widened') widened += 1; else narrowed += 1;
    const blockedOnD2 = isBlockedOnD2(t);
    if (blockedOnD2) blocked += 1;
    byRole[t.role] = (byRole[t.role] ?? 0) + 1;
    byScope[t.scope] = (byScope[t.scope] ?? 0) + 1;
    byAction[t.action] = (byAction[t.action] ?? 0) + 1;
    rows.push(Object.freeze({
      plane: t.plane, stratum: t.stratum, role: t.role, scope: t.scope, action: t.action,
      requiredLevel: t.requiredLevel, heldLevel: heldLevelFor(t, ctx),
      before, after, change, flipPair,
      sensitive: t.sensitive, approveGated: t.approveGated, blockedOnD2,
    }));
  }

  const sortRecord = (r: Record<string, number>): Readonly<Record<string, number>> =>
    Object.freeze(Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]])));

  return Object.freeze({
    context: snapshot,
    shape: UNIVERSE_SHAPE,
    rows: Object.freeze(rows),
    summary: Object.freeze({
      evaluated: CANONICAL_GRANT_UNIVERSE.length,
      unchanged: CANONICAL_GRANT_UNIVERSE.length - rows.length,
      widened,
      narrowed,
      blockedOnD2: blocked,
      byRole: sortRecord(byRole),
      byScope: sortRecord(byScope),
      byAction: sortRecord(byAction),
    }),
  });
}

/**
 * The platform plane already ranks `approve` below `manage`, so the cutover cannot move it. Exported
 * so the suite can assert it rather than assume it — and so a candidate that is broken in general is
 * caught by a plane where the right answer is known independently.
 */
export const PLATFORM_PLANE_IS_ORDERING_STABLE = true;

/**
 * Fail-closed integrity check over a candidate universe. Pure over its input so the controls that
 * prove it works can feed it a deliberately broken list — a duplicate-detector that is only ever run
 * on a correct universe has never been shown to detect anything.
 *
 * Reports, never throws: the caller decides whether a problem is fatal.
 */
export function auditUniverse(
  tuples: readonly CanonicalGrantTuple[],
): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];

  const seen = new Set<string>();
  for (const t of tuples) {
    const k = grantTupleKey(t);
    if (seen.has(k)) problems.push(`duplicate tuple: ${k.replace(/\u0000/g, '/')}`);
    seen.add(k);
  }

  const expected = new Set(CANONICAL_GRANT_UNIVERSE.map(grantTupleKey));
  for (const k of expected) {
    if (!seen.has(k)) problems.push(`missing tuple: ${k.replace(/\u0000/g, '/')}`);
  }
  for (const k of seen) {
    if (!expected.has(k)) problems.push(`unexpected tuple: ${k.replace(/\u0000/g, '/')}`);
  }

  if (tuples.length !== UNIVERSE_SHAPE.total) {
    problems.push(`tuple count ${tuples.length} does not equal the asserted shape ${UNIVERSE_SHAPE.total}`);
  }

  for (let i = 1; i < tuples.length; i += 1) {
    if (compareTuples(tuples[i - 1], tuples[i]) > 0) {
      problems.push(`unstable ordering at index ${i}`);
      break;
    }
  }

  return { ok: problems.length === 0, problems: Object.freeze(problems) };
}

/**
 * A stable, canonical serialization of every catalog input the diff reads. Pure: it hashes nothing
 * and touches nothing — the caller fingerprints it — so this module keeps its "no imports beyond the
 * inert catalog" property. Keys are sorted at every level, so the string depends on the catalog's
 * CONTENT and never on its declaration order or on the host.
 */
export function normalizedAuthorizationInputs(): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(src).sort().map((k) => [k, stable(src[k])]));
    }
    return v;
  };
  return JSON.stringify(stable({
    orderings: {
      tenant: [...TENANT_ORDERING],
      platform: [...PLATFORM_ORDERING],
      unifiedCandidate: [...UNIFIED_CANDIDATE_ORDERING],
    },
    levels: [...PERMISSION_LEVEL_VALUES],
    tenant: {
      roles: [...TENANT_ROLE_IDS],
      domains: [...TENANT_PERMISSION_DOMAINS],
      domainEntitlement: TENANT_DOMAIN_ENTITLEMENT,
      subPermissions: TENANT_SUB_PERMISSIONS.map((s) => ({
        id: s.id, parentDomain: s.parentDomain, minModuleLevel: s.minModuleLevel,
        defaultLevel: s.defaultLevel, mutating: s.mutating,
      })),
      featurePermissionDependencies: TENANT_FEATURE_PERMISSION_DEPENDENCIES,
      featureKeyAliases: FEATURE_KEY_ALIASES,
      rolePermissionDefaults: TENANT_ROLE_PERMISSION_DEFAULTS,
      roleSubPermissionDefaults: TENANT_ROLE_SUBPERMISSION_DEFAULTS,
    },
    platform: {
      roles: [...PLATFORM_ROLE_IDS],
      features: [...PLATFORM_FEATURE_KEYS],
      subPermissions: PLATFORM_SUB_PERMISSIONS.map((s) => ({
        id: s.id, feature: s.feature, threshold: s.threshold, sensitive: s.sensitive,
      })),
      roleFeatureDefaults: PLATFORM_ROLE_FEATURE_DEFAULTS,
      dependencies: PLATFORM_PERMISSION_DEPENDENCIES,
    },
  }));
}

/**
 * The level a role holds on a tuple's scope, read from the authoritative materializers so the row
 * reports what production believes, not what the candidate assumes. `null` when the scope is not a
 * domain/feature the role's plane knows.
 */
export function heldLevelFor(tuple: CanonicalGrantTuple, context: GrantEvaluationContext): Level | null {
  const t = canonicalTupleFor(tuple);
  const ctx = t === null ? null : snapshotContext(context, t.plane);
  if (t === null || ctx === null) return null;
  const limited = ctx.limitation === 'read_only';
  const perms: Record<string, Level> = t.plane === 'tenant'
    ? materializeTenantPermissions(t.role as TenantRoleId, ctx.entitlements, limited)
    : materializePlatformPermissions(t.role as PlatformRoleId, limited);
  return Object.prototype.hasOwnProperty.call(perms, t.scope) ? perms[t.scope] : null;
}
