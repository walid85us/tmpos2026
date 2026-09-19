// Phase 4.0 M5-GAP11-P5 — HISTORICAL EVIDENCE of the superseded global-ordering candidate (docs/phase-4/04 §3).
//
// SUPERSEDED. The global-ordering cutover this module built evidence for (a single unified
// `manage`/`approve` rank shared by the tenant and platform planes) was REJECTED. M5-GAP11-P5 replaced
// it with family-specific orderings — src/authorization/permissionFamilies.ts — where tenant/store and
// platform permissions each keep their own, disagreeing, ordering, and a comparison always names its
// family. This module is kept ONLY as the historical record of why the global cutover was rejected: it
// is never imported by a request path, and nothing here decides a real authorization outcome.
//
// WHAT THIS STILL IS. docs/phase-4/04 §3 records the two conflicting level orderings and the (rejected)
// proposal to unify them under the platform ordering. This module enumerates every canonical
// (role, scope, action) tuple and evaluates it twice — under the ordering that ships today and under
// the (rejected) unified candidate — so the owner could see every changed grant before deciding.
// docs/phase-4/evidence/gap11-ordering-flip-grant-diff.md and this module's committed suites are the
// frozen record of that analysis; neither is edited to say something the rejected cutover did not.
//
// THE D2 TABLE — NOW A RECORD OF BUILT-IN DEFAULTS, NOT RUNTIME AUTHORITY. During the (rejected)
// candidate analysis the owner decided D2: an approval-gated money action requires an explicit per-role
// grant, and no level — `approve`, `manage`, `full` — grants one by itself. That decision survived the
// rejection of the global ordering and is now implemented directly: D2_DEFAULT_MONEY_ACTION_GRANTS
// below is the historical record of the per-role values D2 fixed, each equal to the authoritative answer
// at the time. Runtime money-approval DEFAULTS now live in src/authorization/moneyCapabilities.ts
// (BUILT_IN_MONEY_GRANT_DEFAULTS), and runtime AUTHORITY is each role's own runtime configuration —
// editable by the owner, never this table by role name. `evaluateAfterRepinCandidate` still consults
// this table, but only to evaluate the rejected candidate; it decides nothing live.
//
// THE D3 PINS — RETIRED. During the same analysis the owner decided D3: every one of the thirteen
// changes the rejected unified ordering would have made is rejected, each tuple keeping today's answer.
// That table (D3_COMPATIBILITY_PINS), its parser, its audit and its candidate view
// (evaluatePinnedCandidate / computePinnedGrantDiff) are RETIRED as of M5-GAP11-P5: family-specific
// orderings make an ordering-compatibility pin meaningless (there is no longer one ordering to be
// compatible with), and none of it is part of the future design. Their history is preserved unedited in
// docs/phase-4/evidence/gap11-ordering-flip-grant-diff.md and in git history at commit 84fa74e9.
//
// WHAT THIS IS NOT. It re-pins nothing in production and cuts nothing over — it never did. THE CANDIDATE
// EVALUATORS REMAIN OBSERVATIONAL. They are never consulted for a real authorization decision:
// `materializeTenant*` / `materializePlatform*` in permissionCatalog.ts remain the sole tenant/platform
// authority, family-specific comparisons in src/authorization/permissionFamilies.ts are the sole level
// comparators, and nothing here is imported by a request path.
//
// WHY THE TWO EVALUATORS WERE BUILT DIFFERENTLY, ON PURPOSE. A single `evaluate(ordering)` parameterised
// twice would have been worthless evidence: one defect in it makes every comparison agree, and "no
// grants changed" would be indistinguishable from "the comparison is broken". So BEFORE *delegates to
// the shipped production functions* — it is the authoritative behaviour, not a copy of it — while
// AFTER-CANDIDATE was an independent implementation carrying its own rank table. They share only the
// vocabulary they must share (the catalog's roles, domains, features, actions), never a decision path.
//
// THE BUILT-IN POSITIVE CONTROL. The platform plane ALREADY used the unified ordering the candidate
// proposed, so for every platform tuple the candidate reproduced the authoritative answer exactly. A
// candidate that was broken in general could not pass that, which is what made a reported "no change" on
// the other planes evidence rather than silence. `PLATFORM_PLANE_IS_ORDERING_STABLE` still asserts it.
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
 * recognised level clears ("any level not in the unified catalog denies", 04 §3 #4). Since
 * M5-GAP11-P1-R1 the shipped comparators in permissionCatalog.ts apply the same rule (before it they
 * ranked an unknown level as `none`), so on vocabulary the two evaluators agree and only the ordering
 * separates them. The rank table stays this module's own, so the candidate shares no decision path.
 */
export function candidateMeetsLevel(actual: unknown, required: unknown): boolean {
  if (typeof actual !== 'string' || typeof required !== 'string') return false;
  const a = UNIFIED_RANK.get(actual);
  const r = UNIFIED_RANK.get(required);
  if (a === undefined || r === undefined) return false; // unrecognised is not weaker — it denies
  return a >= r;
}

/**
 * The candidate's own read-only cap: anything above `view` collapses to `view`. An unrecognised level
 * is returned unchanged, never mistaken for `none`, so candidateMeetsLevel denies it.
 */
function candidateCapForReadOnly(level: Level): Level {
  return (UNIFIED_RANK.get(level) ?? -1) > (UNIFIED_RANK.get('view') ?? 1) ? 'view' : level;
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

/**
 * Whether decision D2 governs a tuple — a CLOSED classification, kept apart from the structural one.
 * D2 is safeguard #1 of 04 §3: the per-action re-pin of `approve`-gated MONEY actions. A tuple's
 * required level says nothing about money, so level alone never makes a tuple D2's (M5-GAP11-P1-R1:
 * P1's `approveGated` flag, read as "a D2 row", overstated exactly that).
 *   - `money_action`     — the tuple is a canonical representation of an operation an authoritative
 *                          document identifies as an approve-gated money action (D2_MONEY_ACTIONS,
 *                          each with its source).
 *   - `unresolved`       — the tuple's decisive level is `approve`, but no authoritative document ties
 *                          it to a money action. Whether D2 covers it is part of D2's open scope, not
 *                          a finding, and it is not counted as a D2 row.
 *   - `not_money_action` — neither: its decisive level is not `approve`, so it cannot be an
 *                          approve-gated action, and no document names it as one.
 */
export type D2Classification = 'money_action' | 'not_money_action' | 'unresolved';

/** Where an authoritative document says so, quoted exactly — the suite checks each quote is there. */
export interface D2Source {
  readonly path: string;
  readonly quote: string;
}

/** One canonical way the catalog represents an operation: a named sub-permission or a domain threshold. */
export interface D2Representation {
  readonly plane: GrantPlane;
  readonly stratum: GrantStratum;
  readonly scope: string;
  readonly action: string;
}

export interface D2MoneyAction {
  readonly operation: string;
  readonly sources: readonly D2Source[];
  readonly representations: readonly D2Representation[];
}

/**
 * Every operation an authoritative document identifies as an approve-gated money action, with every
 * canonical representation the catalog gives it. Nothing here is inferred from a level, a domain name,
 * a widening, or a role: 04 §3 names refund approval (`refunds: approve` / `approve_refunds`) and return
 * approval (`returns: approve_return`) — the domain:level form for refunds, the sub-permission for
 * returns — and the platform catalog defines `approve_billing_actions` as approving refunds, credits
 * and write-offs, which the Phase 1.3 platform access inventory classifies as a financial approval.
 * 04 §3's list says "including", so it is not exhaustive. 04 §2.1 names further payment-operation
 * permissions (D2_UNMAPPED_PAYMENT_OPERATIONS) without calling them approve-gated, and none is in the
 * catalog; should one be added it classifies `unresolved` until a document settles it.
 */
export const D2_MONEY_ACTIONS: readonly D2MoneyAction[] = Object.freeze([
  Object.freeze({
    operation: 'refund_approval',
    sources: Object.freeze([
      Object.freeze({
        path: 'docs/phase-4/04-canonical-iam-and-four-user-migration.md',
        quote: 'including money-sensitive ones (`refunds: approve` / `approve_refunds`, `returns: approve_return`)',
      }),
    ]),
    representations: Object.freeze([
      Object.freeze({ plane: 'tenant' as const, stratum: 'domain_threshold' as const, scope: 'refunds', action: 'require:approve' }),
      Object.freeze({ plane: 'tenant' as const, stratum: 'sub_permission' as const, scope: 'refunds', action: 'approve_refunds' }),
    ]),
  }),
  Object.freeze({
    operation: 'return_approval',
    sources: Object.freeze([
      Object.freeze({
        path: 'docs/phase-4/04-canonical-iam-and-four-user-migration.md',
        quote: 'including money-sensitive ones (`refunds: approve` / `approve_refunds`, `returns: approve_return`)',
      }),
    ]),
    representations: Object.freeze([
      Object.freeze({ plane: 'tenant' as const, stratum: 'sub_permission' as const, scope: 'returns', action: 'approve_return' }),
    ]),
  }),
  Object.freeze({
    operation: 'platform_billing_approval',
    sources: Object.freeze([
      Object.freeze({
        path: 'src/owner/platformPermissionsConfig.ts',
        quote: "id: 'approve_billing_actions', label: 'Approve Billing Actions', description: 'Approve refunds, credits, or write-offs.', threshold: 'approve'",
      }),
      Object.freeze({
        path: 'docs/phase-1.3-platform-access-inventory.md',
        quote: 'financial approval (refund/credit/write-off)',
      }),
    ]),
    representations: Object.freeze([
      Object.freeze({ plane: 'platform' as const, stratum: 'sub_permission' as const, scope: 'billing_subscriptions', action: 'approve_billing_actions' }),
    ]),
  }),
]);

/**
 * Capabilities docs/phase-4/04 §2 declares satisfiable ONLY by their specific named grant, so that a
 * broad `manage`/`full` level can never confer them, and folds by name into the §3 re-pin + grant-diff
 * safeguard. 04 §2.1 classes them as provider CONFIGURATION, separate from payment operations, and no
 * document calls them money actions. None is in the shipped catalog; should one be added, its tuples
 * classify `unresolved` — part of D2's open scope — rather than passing as `not_money_action` unnoticed.
 */
export const D2_NAMED_GRANT_ONLY_ACTIONS: readonly string[] = Object.freeze([
  'activate_payment_gateway',
  'disconnect_payment_gateway',
  'manage_payment_gateway_connections',
  'manage_payment_terminals',
]);

/**
 * Payment-operation permissions 04 §2.1 names to separate operation from configuration, with no level
 * and no statement that they are approve-gated. None is in the catalog. Should one be added, its tuples
 * classify `unresolved` — an open question for D2's scope — never silently `not_money_action`.
 */
export const D2_UNMAPPED_PAYMENT_OPERATIONS: readonly string[] = Object.freeze([
  'accept_payment',
  'approve_high_value_refund',
  'process_payment',
  'refund_payment',
  'view_reconciliation',
  'void_payment',
]);

/**
 * One default per-role money grant for one canonical money-action tuple — historical record of owner
 * decision D2, reclassified by M5-GAP11-P5 as the record of a BUILT-IN DEFAULT (never runtime
 * authority; see src/authorization/moneyCapabilities.ts).
 */
export interface D2DefaultMoneyGrant {
  readonly plane: GrantPlane;
  readonly stratum: GrantStratum;
  readonly role: TenantRoleId | PlatformRoleId;
  readonly scope: string;
  readonly action: string;
  readonly granted: boolean;
}

const moneyGrant = (
  plane: GrantPlane, stratum: GrantStratum, role: TenantRoleId | PlatformRoleId, scope: string, action: string,
  granted: boolean,
): D2DefaultMoneyGrant => Object.freeze({ plane, stratum, role, scope, action, granted });

/**
 * Owner decision D2, PRESERVED AS HISTORY: every tuple classified `money_action` carried one explicit
 * per-role grant in the (rejected) candidate, and only `granted: true` could allow it. Each value is
 * LITERAL — written out, never derived — and equals the authoritative answer the tuple had at the time
 * (the D2 suite checks every one against the shipped evaluators). M5-GAP11-P5 reclassifies this table as
 * the record of the BUILT-IN DEFAULT money grants: live defaults are
 * src/authorization/moneyCapabilities.ts BUILT_IN_MONEY_GRANT_DEFAULTS, and runtime AUTHORITY is each
 * role's own runtime configuration, editable by the owner — never this table by role name. The table
 * stays closed and byte-identical to its committed content (a suite pins its hash) so this history
 * cannot silently drift.
 */
export const D2_DEFAULT_MONEY_ACTION_GRANTS: readonly D2DefaultMoneyGrant[] = Object.freeze([
  moneyGrant('platform', 'sub_permission', 'billing_admin', 'billing_subscriptions', 'approve_billing_actions', true),
  moneyGrant('platform', 'sub_permission', 'operations_admin', 'billing_subscriptions', 'approve_billing_actions', false),
  moneyGrant('platform', 'sub_permission', 'security_admin', 'billing_subscriptions', 'approve_billing_actions', false),
  moneyGrant('platform', 'sub_permission', 'support_admin', 'billing_subscriptions', 'approve_billing_actions', false),
  moneyGrant('platform', 'sub_permission', 'system_owner', 'billing_subscriptions', 'approve_billing_actions', true),
  moneyGrant('tenant', 'domain_threshold', 'manager', 'refunds', 'require:approve', true),
  moneyGrant('tenant', 'domain_threshold', 'sales_staff', 'refunds', 'require:approve', false),
  moneyGrant('tenant', 'domain_threshold', 'store_owner', 'refunds', 'require:approve', true),
  moneyGrant('tenant', 'domain_threshold', 'technician', 'refunds', 'require:approve', false),
  moneyGrant('tenant', 'sub_permission', 'manager', 'refunds', 'approve_refunds', true),
  moneyGrant('tenant', 'sub_permission', 'manager', 'returns', 'approve_return', true),
  moneyGrant('tenant', 'sub_permission', 'sales_staff', 'refunds', 'approve_refunds', false),
  moneyGrant('tenant', 'sub_permission', 'sales_staff', 'returns', 'approve_return', false),
  moneyGrant('tenant', 'sub_permission', 'store_owner', 'refunds', 'approve_refunds', true),
  moneyGrant('tenant', 'sub_permission', 'store_owner', 'returns', 'approve_return', true),
  moneyGrant('tenant', 'sub_permission', 'technician', 'refunds', 'approve_refunds', false),
  moneyGrant('tenant', 'sub_permission', 'technician', 'returns', 'approve_return', false),
]);

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
  /**
   * STRUCTURAL: the tuple's decisive required level is `approve` — the threshold of a threshold tuple,
   * a platform sub-permission's threshold, or a tenant sub-permission's default level. It is the level
   * the flip moves, and nothing more: it is not a statement that the tuple is a money action.
   */
  readonly requiresApproveLevel: boolean;
  /** Whether decision D2 governs the tuple — see D2Classification. Never derived from the level alone. */
  readonly d2Classification: D2Classification;
  /** The operation a `money_action` tuple represents (D2_MONEY_ACTIONS); null otherwise. */
  readonly moneyAction: string | null;
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
 * The D2 classification of one tuple. A money action only by an explicit D2_MONEY_ACTIONS entry; a
 * named-grant-only capability 04 §2 folds into the re-pin safeguard is `unresolved` should the catalog
 * ever carry one (04 §2.1 calls them provider configuration, not money); otherwise the structural
 * level decides only between `unresolved` and `not_money_action`.
 */
export function classifyForD2(
  plane: GrantPlane, stratum: GrantStratum, scope: string, action: string, requiresApproveLevel: boolean,
): { d2Classification: D2Classification; moneyAction: string | null } {
  for (const m of D2_MONEY_ACTIONS) {
    for (const r of m.representations) {
      if (r.plane === plane && r.stratum === stratum && r.scope === scope && r.action === action) {
        return { d2Classification: 'money_action', moneyAction: m.operation };
      }
    }
  }
  if (requiresApproveLevel || D2_NAMED_GRANT_ONLY_ACTIONS.includes(action) || D2_UNMAPPED_PAYMENT_OPERATIONS.includes(action)) {
    return { d2Classification: 'unresolved', moneyAction: null };
  }
  return { d2Classification: 'not_money_action', moneyAction: null };
}

function tuple(
  plane: GrantPlane, stratum: GrantStratum, role: string, scope: string, action: string,
  requiredLevel: Level | null, sensitive: boolean, requiresApproveLevel: boolean,
): CanonicalGrantTuple {
  return Object.freeze({
    plane, stratum, role, scope, action, requiredLevel, sensitive, requiresApproveLevel,
    ...classifyForD2(plane, stratum, scope, action, requiresApproveLevel),
  });
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
      out.push(tuple('tenant', 'sub_permission', role, sub.parentDomain, sub.id, null,
        sub.mutating, sub.defaultLevel === 'approve'));
    }
    for (const domain of TENANT_PERMISSION_DOMAINS) {
      for (const required of PERMISSION_LEVEL_VALUES) {
        out.push(tuple('tenant', 'domain_threshold', role, domain, `require:${required}`, required,
          required !== 'none' && required !== 'view', required === 'approve'));
      }
    }
  }

  for (const role of PLATFORM_ROLE_IDS) {
    for (const sub of PLATFORM_SUB_PERMISSIONS) {
      out.push(tuple('platform', 'sub_permission', role, sub.feature, sub.id, null,
        sub.sensitive, sub.threshold === 'approve'));
    }
    for (const feature of PLATFORM_FEATURE_KEYS) {
      for (const required of PERMISSION_LEVEL_VALUES) {
        out.push(tuple('platform', 'domain_threshold', role, feature, `require:${required}`, required,
          required !== 'none' && required !== 'view', required === 'approve'));
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

/**
 * Every canonical tuple by grantTupleKey, in a null-prototype record built at module load. Looked up
 * with an index, never through Map.prototype.get: a caller's getter runs before the lookup, and a
 * lookup that dispatched through a built-in the getter had rewritten could hand back a tuple of its
 * choosing — a money action classified as something else, say.
 */
const CANONICAL_INDEX: Readonly<Record<string, CanonicalGrantTuple>> = (() => {
  const index = { __proto__: null } as unknown as Record<string, CanonicalGrantTuple>;
  for (const t of CANONICAL_GRANT_UNIVERSE) index[grantTupleKey(t)] = t;
  return Object.freeze(index);
})();

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
    const {
      plane, stratum, role, scope, action, requiredLevel, sensitive, requiresApproveLevel, d2Classification,
      moneyAction,
    } = value as Record<string, unknown>;
    fields = {
      plane, stratum, role, scope, action, requiredLevel, sensitive, requiresApproveLevel, d2Classification,
      moneyAction,
    };
  } catch {
    return null; // a tuple that throws while being read (a trap, a revoked proxy) is malformed
  }
  const {
    plane, stratum, role, scope, action, requiredLevel, sensitive, requiresApproveLevel, d2Classification,
    moneyAction,
  } = fields;
  if (typeof plane !== 'string' || typeof stratum !== 'string' || typeof role !== 'string'
    || typeof scope !== 'string' || typeof action !== 'string') return null;
  const t = CANONICAL_INDEX[`${plane}\u0000${stratum}\u0000${role}\u0000${scope}\u0000${action}`];
  if (t === undefined) return null;
  // Every field, the classifications included: an unknown required level, or a tuple claiming another
  // classification than the universe gives it, is not canonical — it is never read as a `none` gate.
  if (t.plane !== plane || t.stratum !== stratum || t.role !== role || t.scope !== scope
    || t.action !== action || t.requiredLevel !== requiredLevel
    || t.sensitive !== sensitive || t.requiresApproveLevel !== requiresApproveLevel
    || t.d2Classification !== d2Classification || t.moneyAction !== moneyAction) return null;
  return t;
}

// =============================================================================
// The D2 explicit money-action grants — parsed once, audited whole
// =============================================================================

/** Every money-action tuple of the universe, in universe order. */
const MONEY_ACTION_TUPLES: readonly CanonicalGrantTuple[] = Object.freeze(
  CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action'),
);

interface ParsedMoneyGrants {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Keyed by grantTupleKey; a null-prototype record. Only consulted when `ok`. */
  readonly grants: Readonly<Record<string, boolean>>;
}

/**
 * Read a grant table once, whatever it is. Each entry's fields are read exactly once, and an entry
 * counts only if it names a canonical money-action tuple field for field (so a separator smuggled
 * into one field cannot land on another tuple's key) and carries a boolean. Anything else is a
 * problem, and one problem anywhere makes the whole table unsound.
 *
 * WHAT THIS CAN AND CANNOT DEFEND. A getter or proxy trap in the table runs caller code while the
 * table is read. Reading once stops it answering twice; it cannot stop it rewriting JavaScript's
 * own built-ins — code that can do that already runs inside the process, and reaches the shipped
 * evaluator the same way (a plan gate checked with Array.prototype.every, say). So this function
 * guarantees something narrower that holds even then: it reads the table with operators and index
 * access, never a built-in method, counts problems in a primitive, and records grants in a
 * null-prototype record, and builds its messages from template literals — so a grant it reports
 * `true` is a boolean `true` the table itself carried for that tuple, a problem once counted keeps
 * the table unsound, and a rewritten built-in cannot make it throw. (Array.isArray is still called:
 * there is no built-in-free array test, so a rewritten one can admit an array-like table — whose
 * grants are still only the booleans it carries.)
 */
function parseExplicitMoneyGrants(table: unknown): ParsedMoneyGrants {
  const grants = { __proto__: null } as unknown as Record<string, boolean>;
  const problems: string[] = [];
  let count = 0;
  const problem = (why: string): void => {
    count += 1;
    try { problems.push(why); } catch { /* the message is for people; the count decides */ }
  };
  const done = (): ParsedMoneyGrants => ({ ok: count === 0, problems, grants });

  let length: unknown;
  try {
    if (!Array.isArray(table)) { problem('the grant table is not an array'); return done(); }
    length = (table as { length: unknown }).length;
  } catch {
    problem('the grant table cannot be read');
    return done();
  }
  if (typeof length !== 'number' || !(length >= 0 && length <= 1024) || length % 1 !== 0) {
    problem('the grant table has no usable length');
    return done();
  }
  for (let i = 0; i < length; i += 1) {
    let plane: unknown; let stratum: unknown; let role: unknown; let scope: unknown; let action: unknown;
    let granted: unknown;
    try {
      const entry: unknown = (table as Record<number, unknown>)[i];
      if (typeof entry !== 'object' || entry === null) { problem(`entry ${i} is not an object`); continue; }
      ({ plane, stratum, role, scope, action, granted } = entry as Record<string, unknown>);
    } catch {
      problem(`entry ${i} cannot be read`);
      continue;
    }
    if (typeof plane !== 'string' || typeof stratum !== 'string' || typeof role !== 'string'
      || typeof scope !== 'string' || typeof action !== 'string') {
      problem(`entry ${i} does not name a tuple`);
      continue;
    }
    const key = `${plane}\u0000${stratum}\u0000${role}\u0000${scope}\u0000${action}`;
    const t = CANONICAL_INDEX[key];
    if (t === undefined || t.plane !== plane || t.stratum !== stratum || t.role !== role
      || t.scope !== scope || t.action !== action) {
      problem(`entry ${i} names no canonical tuple`);
      continue;
    }
    if (t.d2Classification !== 'money_action') {
      problem(`entry ${i} names a tuple that is not a money action: ${plane}/${stratum}/${role}/${scope}/${action}`);
      continue;
    }
    if (typeof granted !== 'boolean') {
      problem(`entry ${i} grant is not a boolean: ${plane}/${stratum}/${role}/${scope}/${action}`);
      continue;
    }
    if (key in grants) {
      problem(`duplicate grant: ${plane}/${stratum}/${role}/${scope}/${action}`);
      continue;
    }
    grants[key] = granted;
  }
  for (let i = 0; i < MONEY_ACTION_TUPLES.length; i += 1) {
    const m = MONEY_ACTION_TUPLES[i];
    if (!(grantTupleKey(m) in grants)) problem(`missing grant: ${m.plane}/${m.stratum}/${m.role}/${m.scope}/${m.action}`);
  }
  return done();
}

/**
 * Fail-closed integrity check over a grant table. Reports, never throws. Sound means: an array, one
 * well-formed entry per money-action tuple, no entry for anything else, and every value a boolean.
 */
export function auditExplicitMoneyGrants(table: unknown): { readonly ok: boolean; readonly problems: readonly string[] } {
  const { ok, problems } = parseExplicitMoneyGrants(table);
  return { ok, problems };
}

/**
 * The explicit grant `table` gives a money-action tuple: `true` or `false` from a sound table, `null`
 * when the tuple is not a money action or the table is unsound. Only `true` can allow.
 */
export function explicitMoneyGrantFor(table: unknown, tuple: unknown): boolean | null {
  const t = canonicalTupleFor(tuple);
  if (t === null || t.d2Classification !== 'money_action') return null;
  const parsed = parseExplicitMoneyGrants(table);
  if (!parsed.ok) return null;
  const v = parsed.grants[grantTupleKey(t)];
  return typeof v === 'boolean' ? v : null;
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
  return candidatePlatformDependenciesMet(role, subId, visiting);
}

/** Every prerequisite of a platform sub-permission holds, each by its own rules. */
function candidatePlatformDependenciesMet(role: string, subId: string, visiting: ReadonlySet<string>): boolean {
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
 * The candidate's decision on a canonical tuple and a context copy.
 *
 * `explicit` is `null` for the unified-ordering rules alone. Under the D2 re-pin it is the tuple's
 * explicit money-action grant, and it replaces EXACTLY the step that confers the grant — a threshold
 * tuple's level comparison; for a tenant sub-permission the owner short-circuit, the per-role explicit
 * map and the default-by-level path; for a platform sub-permission its threshold. Every other step
 * keeps its place and can only deny: the plan gates, a non-owner's parent-module minimum, platform
 * dependencies, and the read-only limitation. So no level grants a money action by itself, and the
 * explicit grant is necessary but never sufficient.
 */
function candidateDecision(t: CanonicalGrantTuple, ctx: GrantEvaluationContext, explicit: boolean | null): boolean {
  const limited = ctx.limitation === 'read_only';
  if (t.plane === 'tenant') {
    if (t.stratum === 'sub_permission') {
      const sub = TENANT_SUB_PERMISSIONS.find((s) => s.id === t.action);
      if (sub === undefined) return false;
      let granted: boolean;
      const gates = candidateGatesFor(sub.id, sub.parentDomain);
      if (!gates.every((g) => candidateEntitled(ctx.entitlements, g))) granted = false;
      else if (t.role === 'store_owner') granted = explicit ?? true;
      else {
        const parent = candidateTenantDomainLevel(t.role, sub.parentDomain, ctx, false);
        if (!candidateMeetsLevel(parent, sub.minModuleLevel)) granted = false;
        else if (explicit !== null) granted = explicit;
        else {
          const explicitMap =
            (TENANT_ROLE_SUBPERMISSION_DEFAULTS as unknown as Record<string, Record<string, boolean>>)[t.role];
          const mapped = explicitMap ? explicitMap[sub.id] : undefined;
          granted = mapped !== undefined ? mapped : candidateMeetsLevel(parent, sub.defaultLevel);
        }
      }
      if (limited && sub.mutating) granted = false;
      return granted;
    }
    if (explicit === null) {
      return candidateMeetsLevel(candidateTenantDomainLevel(t.role, t.scope, ctx, true), t.requiredLevel);
    }
    // Re-pinned threshold: the plan gate still zeroes the domain, and the read-only cap still leaves
    // at most `view`, so it still refuses any gate `view` does not clear. Only the comparison goes.
    const gate = (TENANT_DOMAIN_ENTITLEMENT as Record<string, string | null>)[t.scope];
    if (gate && !candidateEntitled(ctx.entitlements, gate)) return false;
    if (limited && !candidateMeetsLevel('view', t.requiredLevel)) return false;
    return explicit;
  }

  if (t.stratum === 'sub_permission') {
    const def = PLATFORM_SUB_PERMISSIONS.find((s) => s.id === t.action);
    if (def === undefined) return false;
    let granted = explicit === null
      ? candidatePlatformSub(t.role, t.action, new Set<string>())
      : explicit && candidatePlatformDependenciesMet(t.role, t.action, new Set<string>());
    if (limited && granted && (def.threshold !== 'view' || def.sensitive)) granted = false;
    return granted;
  }
  if (explicit === null) {
    return candidateMeetsLevel(candidatePlatformFeatureLevel(t.role, t.scope, ctx, true), t.requiredLevel);
  }
  // No platform threshold is a documented money action (the D2 suite asserts it). Should one ever be
  // registered, it is denied until its own re-pin is written and tested — never decided by a guess.
  return false;
}

/**
 * The grant the unified ordering WOULD produce, before the D2 re-pin. Observational. Anything that is
 * not exactly a canonical tuple — an unknown role, scope, action or level, or a mismatched combination
 * of known ones — is denied (04 §3 #4).
 */
export function evaluateAfterCandidate(tuple: unknown, context: GrantEvaluationContext): GrantOutcome {
  const t = canonicalTupleFor(tuple);
  const ctx = t === null ? null : snapshotContext(context, t.plane);
  if (t === null || ctx === null) return 'denied';
  return candidateDecision(t, ctx, null) ? 'granted' : 'denied';
}

/**
 * The grant the unified ordering WOULD produce AFTER the D2 re-pin, before D3's compatibility pins.
 * Observational. A tuple that is not a money action goes through exactly the rules of
 * evaluateAfterCandidate and never reads the grant table. A money action is allowed only by an
 * explicit `true` in a table that audits clean; a missing, `false`, malformed or unknown grant, or an
 * unsound table, denies — and a `true` still has to clear every other constraint (candidateDecision).
 * `grants` is a parameter so the suite can prove a corrupted table fails closed; nothing but that
 * suite passes anything but the default.
 */
export function evaluateAfterRepinCandidate(
  tuple: unknown,
  context: GrantEvaluationContext,
  grants: unknown = D2_DEFAULT_MONEY_ACTION_GRANTS,
): GrantOutcome {
  const t = canonicalTupleFor(tuple);
  const ctx = t === null ? null : snapshotContext(context, t.plane);
  if (t === null || ctx === null) return 'denied';
  if (t.d2Classification !== 'money_action') return candidateDecision(t, ctx, null) ? 'granted' : 'denied';
  const parsed = parseExplicitMoneyGrants(grants);
  const explicit = parsed.ok && parsed.grants[grantTupleKey(t)] === true;
  return candidateDecision(t, ctx, explicit) ? 'granted' : 'denied';
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
  /** The candidate view this diff compares against — pre-re-pin or post-re-pin (GrantDiff.view). */
  readonly after: GrantOutcome;
  readonly change: ChangeClass;
  /**
   * What decided the candidate's answer: the unified (rejected) ordering; for a money action in the
   * post-re-pin view, its D2 default grant.
   */
  readonly decidedBy: 'level_ordering' | 'explicit_grant';
  /** Which of the two flipping comparisons produced this row; null when a grant or a pin decided it. */
  readonly flipPair: FlipPair | null;
  /**
   * The D2 explicit grant the post-re-pin view read: a boolean only on a row `decidedBy` an explicit
   * grant whose table audits clean. Null in the pre-re-pin view, off money actions, and on a money
   * action decided against an unsound table (which honors no grant, so the row is a denial).
   */
  readonly explicitGrant: boolean | null;
  readonly sensitive: boolean;
  /** Structural: the row's decisive required level is `approve`. Not a money classification. */
  readonly requiresApproveLevel: boolean;
  /** Whether D2 governs the row — the tuple's own classification, carried unchanged. */
  readonly d2Classification: D2Classification;
  readonly moneyAction: string | null;
}

export interface GrantDiffSummary {
  readonly evaluated: number;
  readonly unchanged: number;
  readonly widened: number;
  readonly narrowed: number;
  /** Changed rows whose decisive required level is `approve` — a STRUCTURAL count. */
  readonly requiresApproveLevel: number;
  /** Changed rows by D2 classification — every class present, zero included. Kept apart from the above. */
  readonly byD2Classification: Readonly<Record<D2Classification, number>>;
  readonly byRole: Readonly<Record<string, number>>;
  readonly byScope: Readonly<Record<string, number>>;
  readonly byAction: Readonly<Record<string, number>>;
}

/**
 * `pre_repin` — authority against the unified ordering alone (evaluateAfterCandidate).
 * `post_repin` — authority against the unified ordering with the D2 default grants (evaluateAfterRepinCandidate).
 * Both views are historical: the unified ordering they compare against was rejected (M5-GAP11-P5).
 */
export type CandidateView = 'pre_repin' | 'post_repin';

export interface GrantDiff {
  readonly view: CandidateView;
  /** The context the diff was computed in, or `null` when the one given was malformed (then no row exists). */
  readonly context: GrantEvaluationContext | null;
  readonly shape: typeof UNIVERSE_SHAPE;
  readonly rows: readonly GrantDiffRow[];
  readonly summary: GrantDiffSummary;
}

/**
 * The full diff against the unified ordering BEFORE the D2 re-pin — the structural ordering diff.
 * Deterministic: same inputs, same rows, same order, every time.
 */
export function computeGrantDiff(context: GrantEvaluationContext = CANONICAL_DIFF_CONTEXT): GrantDiff {
  return diffAgainst('pre_repin', context, D2_DEFAULT_MONEY_ACTION_GRANTS);
}

/**
 * The full diff against the candidate AFTER the D2 re-pin, before D3's pins — the thirteen net changes
 * the P2 artifact listed and D3 rejected. `grants` defaults to the committed table; the suite passes a
 * corrupted one to prove a changed value surfaces here as a row decided by an explicit grant.
 */
export function computeRepinnedGrantDiff(
  context: GrantEvaluationContext = CANONICAL_DIFF_CONTEXT,
  grants: unknown = D2_DEFAULT_MONEY_ACTION_GRANTS,
): GrantDiff {
  return diffAgainst('post_repin', context, grants);
}

function diffAgainst(
  view: CandidateView, context: GrantEvaluationContext, grants: unknown,
): GrantDiff {
  // One copy for every read below. A malformed context is never read again: an empty stand-in is one
  // every evaluator denies, so no row is produced.
  const snapshot = snapshotContext(context);
  const ctx = snapshot ?? (Object.freeze({}) as GrantEvaluationContext);
  const rows: GrantDiffRow[] = [];
  const byRole: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let widened = 0;
  let narrowed = 0;
  let approveLevel = 0;
  const byD2: Record<D2Classification, number> = { money_action: 0, not_money_action: 0, unresolved: 0 };

  for (const t of CANONICAL_GRANT_UNIVERSE) {
    const before = evaluateBefore(t, ctx);
    const after: GrantOutcome = view === 'pre_repin'
      ? evaluateAfterCandidate(t, ctx)
      : evaluateAfterRepinCandidate(t, ctx, grants);
    if (before === after) continue;
    const change: ChangeClass = before === 'denied' ? 'widened' : 'narrowed';
    const byGrant = view !== 'pre_repin' && t.d2Classification === 'money_action';
    const flipPair: FlipPair | null = byGrant ? null : change === 'widened'
      ? 'manage_satisfies_approve'
      : 'approve_no_longer_satisfies_manage';
    if (change === 'widened') widened += 1; else narrowed += 1;
    if (t.requiresApproveLevel) approveLevel += 1;
    byD2[t.d2Classification] += 1;
    byRole[t.role] = (byRole[t.role] ?? 0) + 1;
    byScope[t.scope] = (byScope[t.scope] ?? 0) + 1;
    byAction[t.action] = (byAction[t.action] ?? 0) + 1;
    rows.push(Object.freeze({
      plane: t.plane, stratum: t.stratum, role: t.role, scope: t.scope, action: t.action,
      requiredLevel: t.requiredLevel, heldLevel: heldLevelFor(t, ctx),
      before, after, change,
      decidedBy: byGrant ? 'explicit_grant' as const : 'level_ordering' as const,
      flipPair,
      explicitGrant: byGrant ? explicitMoneyGrantFor(grants, t) : null,
      sensitive: t.sensitive, requiresApproveLevel: t.requiresApproveLevel,
      d2Classification: t.d2Classification, moneyAction: t.moneyAction,
    }));
  }

  const sortRecord = (r: Record<string, number>): Readonly<Record<string, number>> =>
    Object.freeze(Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]])));

  return Object.freeze({
    view,
    context: snapshot,
    shape: UNIVERSE_SHAPE,
    rows: Object.freeze(rows),
    summary: Object.freeze({
      evaluated: CANONICAL_GRANT_UNIVERSE.length,
      unchanged: CANONICAL_GRANT_UNIVERSE.length - rows.length,
      widened,
      narrowed,
      requiresApproveLevel: approveLevel,
      byD2Classification: Object.freeze(byD2),
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
    // The D2 classification's own inputs: which operations are identified money actions, where the
    // documents say so, and the named-grant-only list — so a changed classification is a stale artifact.
    // And D2's explicit per-role grants, so a changed grant value is a stale artifact too.
    d2: {
      moneyActions: D2_MONEY_ACTIONS,
      namedGrantOnly: [...D2_NAMED_GRANT_ONLY_ACTIONS],
      unmappedPaymentOperations: [...D2_UNMAPPED_PAYMENT_OPERATIONS],
      explicitGrants: D2_DEFAULT_MONEY_ACTION_GRANTS,
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
