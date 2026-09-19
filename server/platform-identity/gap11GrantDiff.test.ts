// Phase 4.0 M5-GAP11-P1 — the authorization matrix, now a HISTORICAL record of the (rejected)
// global-ordering candidate (04 §3 safeguards #2, #4 and #6). M5-GAP11-P5 superseded the global-ordering
// cutover this matrix evaluated with family-specific orderings (src/authorization/permissionFamilies.ts);
// the candidate evaluators here stay observational and decide nothing live.
//
// HOW THIS SUITE AVOIDS CERTIFYING ITSELF. The diff reports that only 13 of 1659 tuples change, and
// most of those 1659 come out identical under both evaluators. A suite that obtained its expected
// values by calling the evaluators would assert nothing at all: every bug that made both agree would
// make the suite pass. So the expectations here are PINNED AS LITERAL DATA — the counts, the two
// flipping comparisons, and all thirteen changed rows are written out by hand from docs/phase-4/04
// §3's semantics, and the code must reproduce them.
//
// And because "nothing changed" is the easiest possible false pass, the controls at the bottom break
// the machinery on purpose and require the suite to notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_GRANT_UNIVERSE,
  UNIVERSE_SHAPE,
  CANONICAL_DIFF_CONTEXT,
  FULLY_ENTITLED,
  UNIFIED_CANDIDATE_ORDERING,
  D2_MONEY_ACTIONS,
  D2_NAMED_GRANT_ONLY_ACTIONS,
  D2_UNMAPPED_PAYMENT_OPERATIONS,
  auditUniverse,
  canonicalTupleFor,
  candidateMeetsLevel,
  classifyForD2,
  computeGrantDiff,
  evaluateAfterCandidate,
  evaluateBefore,
  grantTupleKey,
  heldLevelFor,
  normalizedAuthorizationInputs,
  type CanonicalGrantTuple,
  type GrantEvaluationContext,
} from './gap11GrantDiff';
import {
  TENANT_ORDERING,
  PLATFORM_ORDERING,
  TENANT_SUB_PERMISSIONS,
  TENANT_PERMISSION_DOMAINS,
  PLATFORM_SUB_PERMISSIONS,
  PLATFORM_FEATURE_KEYS,
  KNOWN_TENANT_ENTITLEMENT_KEYS,
  TENANT_ROLE_SUBPERMISSION_DEFAULTS,
  TENANT_ROLE_PERMISSION_DEFAULTS,
  PLATFORM_ROLE_FEATURE_DEFAULTS,
  materializeTenantPermissions,
  materializeTenantSubPermissions,
  materializePlatformPermissions,
  materializePlatformSubPermissions,
  meetsTenantPermissionLevel,
  meetsPlatformPermissionLevel,
} from './permissionCatalog';
import { PERMISSION_LEVEL_VALUES, TENANT_ROLE_IDS, PLATFORM_ROLE_IDS } from './authorizationConstants';

// =============================================================================
// Pinned expectations — written from 04 §3, never read back from the code
// =============================================================================

/** The shape 04 §3 and the catalog agree on. A silent shrink here is a silently emptied diff. */
const PINNED_SHAPE = {
  tenantRoles: 4,
  tenantDomains: 21,
  tenantSubPermissions: 74,
  platformRoles: 5,
  platformFeatures: 11,
  platformSubPermissions: 78,
  levels: 7,
  total: 4 * 74 + 4 * 21 * 7 + 5 * 78 + 5 * 11 * 7, // 296 + 588 + 390 + 385 = 1659
} as const;

/**
 * Every changed row, by hand. `manage` and `approve` swap rank and nothing else moves, so a role
 * holding `manage` newly clears an `approve` gate and a role holding `approve` stops clearing a
 * `manage` gate. These are the only places in the catalog where that happens.
 */
const PINNED_CHANGED_ROWS: readonly {
  role: string; scope: string; requiredLevel: string; heldLevel: string;
  before: 'granted' | 'denied'; after: 'granted' | 'denied'; change: 'widened' | 'narrowed';
}[] = [
  { role: 'manager', scope: 'employees', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'integrations', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'inventory', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'marketing', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'refunds', requiredLevel: 'manage', heldLevel: 'approve', before: 'granted', after: 'denied', change: 'narrowed' },
  { role: 'manager', scope: 'returns', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'settings', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'shipping', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'suggestive_sales', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'supply_chain', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'warranties', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'manager', scope: 'widgets', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
  { role: 'technician', scope: 'repairs', requiredLevel: 'approve', heldLevel: 'manage', before: 'denied', after: 'granted', change: 'widened' },
];

const CTX = CANONICAL_DIFF_CONTEXT;

// =============================================================================
// The universe
// =============================================================================

test('the universe has the pinned shape, and every tuple occurs exactly once', () => {
  assert.equal(UNIVERSE_SHAPE.tenantRoles, PINNED_SHAPE.tenantRoles);
  assert.equal(UNIVERSE_SHAPE.tenantDomains, PINNED_SHAPE.tenantDomains);
  assert.equal(UNIVERSE_SHAPE.tenantSubPermissions, PINNED_SHAPE.tenantSubPermissions);
  assert.equal(UNIVERSE_SHAPE.platformRoles, PINNED_SHAPE.platformRoles);
  assert.equal(UNIVERSE_SHAPE.platformFeatures, PINNED_SHAPE.platformFeatures);
  assert.equal(UNIVERSE_SHAPE.platformSubPermissions, PINNED_SHAPE.platformSubPermissions);
  assert.equal(UNIVERSE_SHAPE.levels, PINNED_SHAPE.levels);
  assert.equal(UNIVERSE_SHAPE.total, PINNED_SHAPE.total);
  assert.equal(CANONICAL_GRANT_UNIVERSE.length, PINNED_SHAPE.total);

  const keys = new Set(CANONICAL_GRANT_UNIVERSE.map(grantTupleKey));
  assert.equal(keys.size, PINNED_SHAPE.total, 'no tuple appears twice');

  const audit = auditUniverse(CANONICAL_GRANT_UNIVERSE);
  assert.deepEqual(audit.problems, [], 'the shipped universe audits clean');
  assert.equal(audit.ok, true);
});

test('every configured role, domain, feature and action is present — nothing is silently excluded', () => {
  const has = (plane: string, stratum: string, role: string, scope: string, action: string): boolean =>
    CANONICAL_GRANT_UNIVERSE.some((t) =>
      t.plane === plane && t.stratum === stratum && t.role === role && t.scope === scope && t.action === action);

  for (const role of TENANT_ROLE_IDS) {
    for (const sub of TENANT_SUB_PERMISSIONS) {
      assert.ok(has('tenant', 'sub_permission', role, sub.parentDomain, sub.id), `${role}/${sub.id}`);
    }
    for (const d of TENANT_PERMISSION_DOMAINS) {
      for (const lvl of PERMISSION_LEVEL_VALUES) {
        assert.ok(has('tenant', 'domain_threshold', role, d, `require:${lvl}`), `${role}/${d}/${lvl}`);
      }
    }
  }
  for (const role of PLATFORM_ROLE_IDS) {
    for (const sub of PLATFORM_SUB_PERMISSIONS) {
      assert.ok(has('platform', 'sub_permission', role, sub.feature, sub.id), `${role}/${sub.id}`);
    }
    for (const f of PLATFORM_FEATURE_KEYS) {
      for (const lvl of PERMISSION_LEVEL_VALUES) {
        assert.ok(has('platform', 'domain_threshold', role, f, `require:${lvl}`), `${role}/${f}/${lvl}`);
      }
    }
  }

  // An unresolved approve-gated action must be IN the universe, not filtered out of it.
  for (const sub of TENANT_SUB_PERMISSIONS.filter((s) => s.defaultLevel === 'approve')) {
    for (const role of TENANT_ROLE_IDS) {
      assert.ok(has('tenant', 'sub_permission', role, sub.parentDomain, sub.id),
        `approve-gated ${sub.id} is present for ${role}`);
    }
  }
});

test('the universe is stably ordered and its ordering does not depend on locale', () => {
  const rendered = CANONICAL_GRANT_UNIVERSE.map(grantTupleKey);
  const resorted = [...rendered].sort();
  assert.deepEqual(rendered, resorted, 'already in the documented lexical order');
});

// =============================================================================
// The ordering flip itself
// =============================================================================

test('exactly two comparisons change truth value under the unified ordering', () => {
  const flipped: string[] = [];
  for (const actual of PERMISSION_LEVEL_VALUES) {
    for (const required of PERMISSION_LEVEL_VALUES) {
      if (meetsTenantPermissionLevel(actual, required) !== candidateMeetsLevel(actual, required)) {
        flipped.push(`${actual}->${required}`);
      }
    }
  }
  assert.deepEqual(flipped.sort(), ['approve->manage', 'manage->approve']);
});

test('the candidate ordering is the one 04 §3 declares canonical, written out independently', () => {
  assert.deepEqual([...UNIFIED_CANDIDATE_ORDERING],
    ['none', 'view', 'create', 'edit', 'approve', 'manage', 'full']);
  // It must match the platform ordering in content while not BEING that array — the diff has to be
  // able to report a divergence if the catalog's platform ordering were ever edited.
  assert.deepEqual([...UNIFIED_CANDIDATE_ORDERING], [...PLATFORM_ORDERING]);
  assert.notEqual(UNIFIED_CANDIDATE_ORDERING as unknown, PLATFORM_ORDERING as unknown);
  assert.notDeepEqual([...UNIFIED_CANDIDATE_ORDERING], [...TENANT_ORDERING]);
});

// =============================================================================
// The matrix — every tuple, both evaluators
// =============================================================================

test('BEFORE reproduces the shipped authority for every tuple', () => {
  // BEFORE must BE production, not resemble it: assert it against the production comparators applied
  // to the production materializers, tuple by tuple.
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.stratum !== 'domain_threshold') continue;
    const held = heldLevelFor(t, CTX);
    const expected = t.plane === 'tenant'
      ? meetsTenantPermissionLevel(held!, t.requiredLevel!)
      : meetsPlatformPermissionLevel(held!, t.requiredLevel!);
    assert.equal(evaluateBefore(t, CTX), expected ? 'granted' : 'denied', grantTupleKey(t));
  }
});

test('the changed set is exactly the pinned thirteen rows', () => {
  const diff = computeGrantDiff(CTX);
  assert.equal(diff.summary.evaluated, PINNED_SHAPE.total);
  assert.equal(diff.rows.length, PINNED_CHANGED_ROWS.length);
  assert.equal(diff.summary.widened, PINNED_CHANGED_ROWS.filter((r) => r.change === 'widened').length);
  assert.equal(diff.summary.narrowed, PINNED_CHANGED_ROWS.filter((r) => r.change === 'narrowed').length);
  assert.equal(diff.summary.unchanged, PINNED_SHAPE.total - PINNED_CHANGED_ROWS.length);

  const actual = diff.rows.map((r) => ({
    role: r.role, scope: r.scope, requiredLevel: r.requiredLevel as string,
    heldLevel: r.heldLevel as string, before: r.before, after: r.after, change: r.change,
  }));
  assert.deepEqual(actual, PINNED_CHANGED_ROWS);

  // Every changed row is a threshold row on the tenant plane — the finding the artifact reports. The
  // twelve widened rows are STRUCTURALLY approve-level; none of them is an identified money action, so
  // all twelve are `unresolved`, not D2 rows. The narrowing is gated at `manage`: `not_money_action`.
  for (const r of diff.rows) {
    assert.equal(r.plane, 'tenant');
    assert.equal(r.stratum, 'domain_threshold');
    assert.equal(r.requiresApproveLevel, r.change === 'widened', `${r.role}/${r.scope}: approve level iff widened`);
    assert.equal(r.d2Classification, r.change === 'widened' ? 'unresolved' : 'not_money_action', `${r.role}/${r.scope}`);
    assert.equal(r.moneyAction, null, `${r.role}/${r.scope}: no changed row represents a money action`);
  }
  assert.equal(diff.summary.requiresApproveLevel, 12);
  assert.deepEqual({ ...diff.summary.byD2Classification }, { money_action: 0, not_money_action: 1, unresolved: 12 });

  // The per-key tallies the artifact prints, pinned rather than recomputed from the rows.
  assert.deepEqual({ ...diff.summary.byRole }, { manager: 12, technician: 1 });
  assert.deepEqual({ ...diff.summary.byAction }, { 'require:approve': 12, 'require:manage': 1 });
  assert.deepEqual({ ...diff.summary.byScope }, Object.fromEntries(
    PINNED_CHANGED_ROWS.map((r) => r.scope).sort().map((s) => [s, 1])));
});

test('no artifact row exists without a real disagreement, and no disagreement without a row', () => {
  const diff = computeGrantDiff(CTX);
  const rowKeys = new Set(diff.rows.map((r) => `${r.plane}/${r.stratum}/${r.role}/${r.scope}/${r.action}`));

  let disagreements = 0;
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    const disagrees = evaluateBefore(t, CTX) !== evaluateAfterCandidate(t, CTX);
    const key = `${t.plane}/${t.stratum}/${t.role}/${t.scope}/${t.action}`;
    if (disagrees) {
      disagreements += 1;
      assert.ok(rowKeys.has(key), `disagreement without a row: ${key}`);
    } else {
      assert.ok(!rowKeys.has(key), `row without a disagreement: ${key}`);
    }
  }
  assert.equal(disagreements, diff.rows.length);
});

test('the sub-permission stratum does not move — and the reason the artifact gives is pinned, not assumed', () => {
  // This is the load-bearing finding for D2, so it is asserted directly rather than inferred from a
  // zero in the summary.
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.stratum !== 'sub_permission') continue;
    assert.equal(evaluateBefore(t, CTX), evaluateAfterCandidate(t, CTX), grantTupleKey(t));
  }
  // The reason: every non-owner role holds an explicit grant for every approve-gated sub, and leaves
  // exactly these three to the default path, none of them at `approve`. store_owner has no map at all.
  const maps = TENANT_ROLE_SUBPERMISSION_DEFAULTS as unknown as Record<string, Record<string, boolean>>;
  assert.deepEqual(Object.keys(maps).sort(), ['manager', 'sales_staff', 'technician']);
  for (const role of Object.keys(maps)) {
    const defaulted = TENANT_SUB_PERMISSIONS.filter((s) => maps[role][s.id] === undefined);
    assert.deepEqual(defaulted.map((s) => s.id).sort(),
      ['cancel_carrier_pickup', 'request_carrier_pickup', 'select_service_point'], role);
    assert.ok(defaulted.every((s) => s.defaultLevel !== 'approve'), `${role} defaults nothing at approve`);
    for (const s of TENANT_SUB_PERMISSIONS.filter((x) => x.defaultLevel === 'approve')) {
      assert.equal(typeof maps[role][s.id], 'boolean', `${role} holds an explicit grant for ${s.id}`);
    }
  }
});

test('the platform plane is ordering-stable — the positive control on the candidate', () => {
  // The platform plane ALREADY ranks approve below manage. If the candidate were broken in general
  // it could not reproduce 775 platform answers exactly, so this is what makes the zeros elsewhere
  // evidence rather than silence.
  let checked = 0;
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.plane !== 'platform') continue;
    assert.equal(evaluateAfterCandidate(t, CTX), evaluateBefore(t, CTX), grantTupleKey(t));
    checked += 1;
  }
  assert.equal(checked, PINNED_SHAPE.platformRoles * PINNED_SHAPE.platformSubPermissions
    + PINNED_SHAPE.platformRoles * PINNED_SHAPE.platformFeatures * PINNED_SHAPE.levels);
});

test('neither evaluator is a constant function', () => {
  const before = new Set(CANONICAL_GRANT_UNIVERSE.map((t) => evaluateBefore(t, CTX)));
  const after = new Set(CANONICAL_GRANT_UNIVERSE.map((t) => evaluateAfterCandidate(t, CTX)));
  assert.deepEqual([...before].sort(), ['denied', 'granted']);
  assert.deepEqual([...after].sort(), ['denied', 'granted']);
});

// =============================================================================
// Safeguard #4 — deny by default on unknowns
// =============================================================================

test('unknown role, scope, action and malformed values all deny, on both evaluators', () => {
  const base = CANONICAL_GRANT_UNIVERSE.find(
    (t) => t.plane === 'tenant' && t.stratum === 'sub_permission' && t.role === 'store_owner',
  )!;
  assert.equal(evaluateBefore(base, CTX), 'granted', 'the control tuple is granted, so a deny below is meaningful');

  const mutate = (over: Partial<CanonicalGrantTuple>): CanonicalGrantTuple =>
    ({ ...base, ...over }) as CanonicalGrantTuple;

  const denials: readonly (readonly [string, CanonicalGrantTuple])[] = [
    ['unknown role', mutate({ role: 'not_a_role' })],
    ['empty role', mutate({ role: '' })],
    ['unknown action', mutate({ action: 'not_an_action' })],
    ['empty action', mutate({ action: '' })],
    ['case-shifted action', mutate({ action: base.action.toUpperCase() })],
    ['whitespace-padded action', mutate({ action: ` ${base.action} ` })],
    ['unknown domain threshold', mutate({ stratum: 'domain_threshold', scope: 'not_a_domain', action: 'require:view', requiredLevel: 'view' })],
    ['unknown platform role', mutate({ plane: 'platform', role: 'not_a_platform_role', scope: 'command_center', action: 'view_command_center' })],
  ];

  // Mismatched combinations of KNOWN parts — each borrowed a real grant before the canonical gate,
  // because the materializers key a sub-permission by action alone and a threshold by scope alone.
  const threshold = CANONICAL_GRANT_UNIVERSE.find((t) =>
    t.plane === 'tenant' && t.stratum === 'domain_threshold' && t.role === 'manager'
    && t.scope === 'sales' && t.action === 'require:view')!;
  assert.equal(evaluateBefore(threshold, CTX), 'granted', 'the threshold control tuple is granted');
  const mismatched: readonly (readonly [string, unknown])[] = [
    ['threshold with a foreign action', { ...threshold, action: 'not_an_action' }],
    ['threshold whose action and level disagree', { ...threshold, action: 'require:full' }],
    ['sub-permission under a foreign scope', { ...base, scope: 'victim@example.com' }],
    ['sub-permission under another real domain', { ...base, scope: 'sales' }],
    ['sub-permission carrying a required level', { ...base, requiredLevel: 'view' }],
    ['sub-permission carrying an unknown level', { ...base, requiredLevel: 'not_a_level' }],
    ['inverted sensitivity', { ...base, sensitive: !base.sensitive }],
    ['a string where a boolean belongs', { ...base, requiresApproveLevel: String(base.requiresApproveLevel) }],
    ['missing classification', (({ sensitive: _s, requiresApproveLevel: _a, ...rest }) => rest)(base)],
    ['a claimed D2 classification the universe does not give', { ...base, d2Classification: 'money_action', moneyAction: 'refund_approval' }],
    ['an unknown D2 classification', { ...base, d2Classification: 'maybe' }],
    ['a missing D2 classification', (({ d2Classification: _d, ...rest }) => rest)(base)],
    ['a key that splices fields across the separator', { ...base, role: `${base.role}\u0000${base.scope}`, scope: base.action }],
    ['a threshold on an inherited property name', { ...threshold, scope: 'constructor' }],
    ['a tuple that throws while being read', Object.defineProperty({ ...base }, 'role', { get(): never { throw new Error('trap'); } })],
    ['a revoked proxy', (() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })()],
    ['not an object', 'tenant/sub_permission/store_owner'],
    ['null', null],
  ];
  for (const [why, t] of [...denials, ...mismatched]) {
    assert.equal(canonicalTupleFor(t), null, `not canonical: ${why}`);
    assert.equal(evaluateAfterCandidate(t, CTX), 'denied', `candidate denies: ${why}`);
    assert.equal(evaluateBefore(t, CTX), 'denied', `authority denies: ${why}`);
    assert.equal(heldLevelFor(t as CanonicalGrantTuple, CTX), null, `no held level: ${why}`);
  }
});

test('an unrecognised evaluation context denies on both evaluators — it is not "unrestricted"', () => {
  const t = CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === 'tenant' && x.stratum === 'sub_permission'
    && x.role === 'store_owner')!;
  assert.equal(evaluateBefore(t, CTX), 'granted', 'granted under a valid context, so a deny below is meaningful');
  const bad: readonly (readonly [string, unknown])[] = [
    ['unknown limitation', { entitlements: FULLY_ENTITLED, limitation: 'overdue' }],
    ['undefined limitation', { entitlements: FULLY_ENTITLED, limitation: undefined }],
    ['missing limitation', { entitlements: FULLY_ENTITLED }],
    ['null entitlements', { entitlements: null, limitation: 'none' }],
    ['missing entitlements', { limitation: 'none' }],
    ['a throwing field', { get entitlements(): never { throw new Error('trap'); }, limitation: 'none' }],
    ['entitlements that throw when copied',
      { entitlements: new Proxy({}, { ownKeys(): never { throw new Error('trap'); } }), limitation: 'none' }],
    ['null', null], ['undefined', undefined], ['a string', 'none'],
  ];
  for (const [why, ctx] of bad) {
    assert.equal(evaluateBefore(t, ctx as GrantEvaluationContext), 'denied', why);
    assert.equal(evaluateAfterCandidate(t, ctx as GrantEvaluationContext), 'denied', why);
    assert.equal(heldLevelFor(t, ctx as GrantEvaluationContext), null, `no held level: ${why}`);
  }
});

test('the context copy reads exactly what the catalog reads — same answers, same traps, nothing more', () => {
  const sc = CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === 'tenant' && x.stratum === 'domain_threshold'
    && x.role === 'manager' && x.scope === 'supply_chain' && x.action === 'require:view')!;
  // An enumerable symbol key the catalog's Object.entries never reads must not be read by the copy.
  const trap = Object.defineProperty({ 'supply-chain': true }, Symbol('trap'), {
    enumerable: true, get(): never { throw new Error('symbol read'); },
  });
  // Explicit expectations, each checked against production itself: the copy must agree with the
  // catalog on every container, including ones that are not records (they enable no gate).
  const bare = Object.assign(Object.create(null) as Record<string, boolean>, { 'supply-chain': true });
  const cases: readonly (readonly [string, unknown, 'granted' | 'denied'])[] = [
    ['symbol key ignored', trap, 'granted'],
    ['null-prototype record', bare, 'granted'],
    ['a record from another realm', runInNewContext('({ "supply-chain": true })'), 'granted'],
    ['an inherited key is not an entitlement', Object.create(bare), 'denied'],
    ['a Date enables no gate', new Date(0), 'denied'],
    ['a Map enables no gate', new Map([['supply-chain', true]]), 'denied'],
    ['an empty array enables no gate', [], 'denied'],
    ['an array carrying an own gate property', Object.assign([], { 'supply-chain': true }), 'granted'],
    ['a function carrying an own gate property', Object.assign(() => false, { 'supply-chain': true }), 'granted'],
    ['a string enables no gate', 'supply-chain', 'denied'],
    ['a number enables no gate', 42, 'denied'],
    ['a truthy non-boolean is not enabled', { 'supply-chain': 1 }, 'denied'],
    ['the string "true" is not enabled', { 'supply-chain': 'true' }, 'denied'],
  ];
  for (const [why, value, expected] of cases) {
    const entitlements = value as Record<string, boolean>;
    const production = meetsTenantPermissionLevel(
      materializeTenantPermissions('manager', entitlements, false).supply_chain, 'view') ? 'granted' : 'denied';
    assert.equal(production, expected, `production: ${why}`);
    assert.equal(evaluateBefore(sc, { entitlements, limitation: 'none' }), expected, `authority: ${why}`);
    assert.equal(evaluateAfterCandidate(sc, { entitlements, limitation: 'none' }), expected, `candidate: ${why}`);
  }

  // Trap for trap: the evaluators perform on the entitlement map exactly the operations production
  // performs, so no extra trap (a prototype check, a second read) can run caller code in between.
  const logged = (log: string[]): Record<string, boolean> => new Proxy({ 'supply-chain': true, returns: false }, {
    ownKeys(t) { log.push('ownKeys'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { log.push(`gOPD:${String(k)}`); return Reflect.getOwnPropertyDescriptor(t, k); },
    get(t, k, r) { log.push(`get:${String(k)}`); return Reflect.get(t, k, r); },
    has(t, k) { log.push(`has:${String(k)}`); return Reflect.has(t, k); },
    getPrototypeOf(t) { log.push('getPrototypeOf'); return Reflect.getPrototypeOf(t); },
  });
  const pick = (plane: string, stratum: string, role: string): CanonicalGrantTuple =>
    CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === plane && x.stratum === stratum && x.role === role)!;
  // What production itself fires for each kind of tuple. The platform materializers never receive
  // the tenant map, so for a platform tuple the only faithful number of traps is zero.
  const kinds: readonly (readonly [string, CanonicalGrantTuple, (m: Record<string, boolean>) => unknown])[] = [
    ['tenant threshold', sc, (m) => materializeTenantPermissions('manager', m, false)],
    ['tenant sub-permission', pick('tenant', 'sub_permission', 'manager'), (m) => materializeTenantSubPermissions('manager', m, false)],
    ['platform threshold', pick('platform', 'domain_threshold', 'system_owner'), () => materializePlatformPermissions('system_owner', false)],
    ['platform sub-permission', pick('platform', 'sub_permission', 'system_owner'), () => materializePlatformSubPermissions('system_owner', false)],
  ];
  for (const [kind, tuple, production] of kinds) {
    const productionLog: string[] = [];
    production(logged(productionLog));
    assert.equal(productionLog.length > 0, kind.startsWith('tenant'), `control: ${kind} production reads the map iff tenant`);
    for (const evaluate of [evaluateBefore, evaluateAfterCandidate]) {
      const log: string[] = [];
      evaluate(tuple, { entitlements: logged(log), limitation: 'none' });
      assert.deepEqual(log, productionLog, `${evaluate.name} fires exactly production's traps: ${kind}`);
    }
  }

  // A platform tuple does not even read the context's entitlement FIELD: a getter that throws there
  // cannot change an answer production computes without it.
  const owner = CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === 'platform' && x.stratum === 'domain_threshold'
    && x.role === 'system_owner' && x.action === 'require:full')!;
  const poisoned = { get entitlements(): never { throw new Error('field read'); }, limitation: 'none' };
  for (const evaluate of [evaluateBefore, evaluateAfterCandidate]) {
    assert.equal(evaluate(owner, poisoned as unknown as GrantEvaluationContext), 'granted', `${evaluate.name}: platform ignores the field`);
  }
});

test('each evaluator reads the context once — a getter cannot answer validation and evaluation differently', () => {
  const full = CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === 'tenant' && x.stratum === 'domain_threshold'
    && x.role === 'store_owner' && x.scope === 'dashboard' && x.action === 'require:full')!;
  const sc = CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === 'tenant' && x.stratum === 'domain_threshold'
    && x.role === 'manager' && x.scope === 'supply_chain' && x.action === 'require:view')!;
  for (const evaluate of [evaluateBefore, evaluateAfterCandidate]) {
    for (const [first, then, expected] of [['read_only', 'none', 'denied'], ['none', 'read_only', 'granted']] as const) {
      let reads = 0;
      const ctx = { entitlements: FULLY_ENTITLED, get limitation() { reads += 1; return reads === 1 ? first : then; } };
      assert.equal(evaluate(full, ctx as GrantEvaluationContext), expected, `${evaluate.name}: limitation ${first} first`);
      assert.equal(reads, 1, `${evaluate.name} reads limitation once`);
    }
    // Regression guard: the catalog already copies the map once, so this half pins that the copy
    // stays single; the limitation half above is the one that failed before the snapshot existed.
    for (const [first, expected] of [[false, 'denied'], [true, 'granted']] as const) {
      let reads = 0;
      const entitlements = { get 'supply-chain'() { reads += 1; return reads === 1 ? first : !first; } };
      assert.equal(evaluate(sc, { entitlements, limitation: 'none' } as GrantEvaluationContext), expected,
        `${evaluate.name}: gate ${first} first`);
      assert.equal(reads, 1, `${evaluate.name} reads the gate once`);
    }
  }

  // The diff reads its context once too: one that fails that read is never consulted again, even if
  // a later read would have looked valid.
  let reads = 0;
  const flaky = {
    get entitlements() { reads += 1; if (reads === 1) throw new Error('first read'); return FULLY_ENTITLED; },
    limitation: 'none',
  };
  const rejected = computeGrantDiff(flaky as unknown as GrantEvaluationContext);
  assert.equal(rejected.rows.length, 0);
  assert.equal(rejected.context, null, 'a malformed context is reported as absent, not as a context');
  assert.equal(reads, 1, 'computeGrantDiff reads the context once');

  // The tuple too: every one of its eight fields is read exactly once, whichever function reads it.
  const tuple = CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === 'tenant' && x.stratum === 'domain_threshold')!;
  for (const read of [canonicalTupleFor, (t: unknown) => evaluateBefore(t, CTX), (t: unknown) => evaluateAfterCandidate(t, CTX),
    (t: unknown) => heldLevelFor(t as CanonicalGrantTuple, CTX)]) {
    const counts: Record<string, number> = {};
    read(new Proxy({ ...tuple }, { get(t, k, r) { counts[String(k)] = (counts[String(k)] ?? 0) + 1; return Reflect.get(t, k, r); } }));
    assert.deepEqual(counts, Object.fromEntries(Object.keys(tuple).sort().map((k) => [k, 1])), 'each tuple field read once');
  }
});

test('the shipped materializers themselves return nothing for an unknown role, action or domain', () => {
  // Safeguard #4 at the authority, not only behind the canonical gate: asserted on the production
  // functions directly.
  assert.deepEqual(materializeTenantSubPermissions('not_a_role', FULLY_ENTITLED, false), {});
  assert.deepEqual(materializeTenantPermissions('not_a_role', FULLY_ENTITLED, false), {});
  assert.deepEqual(materializePlatformSubPermissions('not_a_role', false), {});
  assert.deepEqual(materializePlatformPermissions('not_a_role', false), {});
  const subs = materializeTenantSubPermissions('store_owner', FULLY_ENTITLED, false);
  assert.equal(subs.not_an_action, undefined, 'no entry for an unknown action');
  assert.equal(Object.keys(subs).length, TENANT_SUB_PERMISSIONS.length);
  const perms = materializeTenantPermissions('store_owner', FULLY_ENTITLED, false);
  assert.equal(perms.not_a_domain, undefined, 'no entry for an unknown domain');
  assert.deepEqual(Object.keys(perms).sort(), [...TENANT_PERMISSION_DOMAINS].sort());
});

test('entitlement outcomes are pinned, so a shared gate defect cannot make both evaluators agree', () => {
  // Written from the catalog's DATA by hand: purchase_batch_labels needs the shipping domain gate
  // plus the shipping_providers and batch_labels features; run_shipping_automation_backfill needs
  // shipping plus BOTH shipping_automation_rules and shipping_sla_optimization; the supply_chain
  // domain is gated by 'supply-chain', which the alias 'supply_chain' also satisfies.
  const tupleOf = (stratum: string, role: string, scope: string, action: string): CanonicalGrantTuple =>
    CANONICAL_GRANT_UNIVERSE.find((t) => t.plane === 'tenant' && t.stratum === stratum
      && t.role === role && t.scope === scope && t.action === action)!;
  const pbl = tupleOf('sub_permission', 'manager', 'shipping', 'purchase_batch_labels');
  const back = tupleOf('sub_permission', 'manager', 'shipping', 'run_shipping_automation_backfill');
  const sc = tupleOf('domain_threshold', 'manager', 'supply_chain', 'require:view');
  const ctx = (entitlements: Record<string, boolean>): GrantEvaluationContext => ({ entitlements, limitation: 'none' });
  const cases: readonly (readonly [CanonicalGrantTuple, Record<string, boolean>, 'granted' | 'denied', string])[] = [
    [pbl, { shipping: true, shipping_providers: true, batch_labels: true }, 'granted', 'all three gates'],
    [pbl, { shipping: true, shipping_providers: true }, 'denied', 'batch_labels missing'],
    [pbl, { shipping_providers: true, batch_labels: true }, 'denied', 'domain gate missing'],
    [back, { shipping: true, shipping_automation_rules: true, shipping_sla_optimization: true }, 'granted', 'both feature gates'],
    [back, { shipping: true, shipping_automation_rules: true }, 'denied', 'SLA feature missing'],
    [sc, { 'supply-chain': true }, 'granted', 'canonical key'],
    [sc, { supply_chain: true }, 'granted', 'alias key alone'],
    [sc, { supply_chain: true, 'supply-chain': false }, 'granted', 'alias OR canonical'],
    [sc, { 'supply-chain': false }, 'denied', 'disabled'],
    [sc, {}, 'denied', 'absent'],
  ];
  for (const [t, ent, expected, why] of cases) {
    assert.equal(evaluateBefore(t, ctx(ent)), expected, `authority: ${t.action} ${why}`);
    assert.equal(evaluateAfterCandidate(t, ctx(ent)), expected, `candidate: ${t.action} ${why}`);
  }
});

test('the candidate denies an unknown level on either side — held or required', () => {
  for (const known of PERMISSION_LEVEL_VALUES) {
    // Holding something unrecognised clears nothing — not even a `none` requirement, which every
    // recognised level (including `none` itself) clears.
    assert.equal(candidateMeetsLevel('not_a_level', known), false, `unknown held vs ${known}`);
    assert.equal(candidateMeetsLevel(known, 'none'), true, `${known} clears none`);
    // Requiring something unrecognised DENIES, even for `full`. A requirement nobody can name is not
    // a weaker requirement, and 04 §3 #4 says anything outside the unified catalog denies.
    assert.equal(candidateMeetsLevel(known, 'not_a_level'), false, `${known} vs unknown requirement`);
  }
  for (const malformed of [undefined, null, 42, {}, [], '', 'FULL', ' full']) {
    assert.equal(candidateMeetsLevel('full', malformed), false, `required ${JSON.stringify(malformed)}`);
    assert.equal(candidateMeetsLevel(malformed, 'view'), false, `held ${JSON.stringify(malformed)}`);
  }
});

test('no catalog-defined level is unknown — so deny-by-default moves no canonical grant', () => {
  // Both evaluators deny an unknown level (the shipped comparators since M5-GAP11-P1-R1; before it
  // they ranked one as `none`). That changes no canonical grant only while no real requirement or held
  // default is unknown; assert that premise instead of assuming it.
  const known = new Set<string>(PERMISSION_LEVEL_VALUES);
  const levels = [
    ...TENANT_SUB_PERMISSIONS.flatMap((s) => [s.minModuleLevel, s.defaultLevel]),
    ...PLATFORM_SUB_PERMISSIONS.map((s) => s.threshold),
    ...CANONICAL_GRANT_UNIVERSE.map((t) => t.requiredLevel).filter((l): l is NonNullable<typeof l> => l !== null),
    ...Object.values(TENANT_ROLE_PERMISSION_DEFAULTS).flatMap((m) => Object.values(m)),
    ...Object.values(PLATFORM_ROLE_FEATURE_DEFAULTS).flatMap((m) => Object.values(m)),
  ];
  assert.ok(levels.length > 100, 'the premise is checked over real data');
  assert.deepEqual(levels.filter((l) => !known.has(l)), []);
});

test('sensitive actions keep the classification the shipped catalog gives them', () => {
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.stratum !== 'sub_permission') continue;
    if (t.plane === 'tenant') {
      const sub = TENANT_SUB_PERMISSIONS.find((s) => s.id === t.action)!;
      assert.equal(t.sensitive, sub.mutating, t.action);
    } else {
      const sub = PLATFORM_SUB_PERMISSIONS.find((s) => s.id === t.action)!;
      assert.equal(t.sensitive, sub.sensitive, t.action);
    }
  }
});

// =============================================================================
// The taxonomy — a structural classification and a D2 classification, kept apart (M5-GAP11-P1-R1)
// =============================================================================

/** Written from the catalog by hand: the sub-permissions whose decisive level is `approve`. */
const PINNED_APPROVE_LEVEL_SUBS = {
  tenant: ['approve_inventory', 'approve_refunds', 'approve_requests', 'approve_return'],
  platform: [
    'approve_billing_actions', 'change_escalation_level', 'delete_security_note', 'edit_addon_overrides',
    'export_audit_csv', 'grant_paid_override', 'grant_trial', 'resolve_escalation', 'revoke_addon_override',
    'view_restricted_audit_details',
  ],
} as const;

/**
 * Written from docs/phase-4/04 §3 and the platform catalog by hand: every tuple that represents an
 * identified approve-gated money action. Nothing here comes from a level.
 */
const PINNED_MONEY_ACTION_TUPLES: readonly string[] = [
  ...['manager', 'sales_staff', 'store_owner', 'technician'].flatMap((role) => [
    `tenant/domain_threshold/${role}/refunds/require:approve=refund_approval`,
    `tenant/sub_permission/${role}/refunds/approve_refunds=refund_approval`,
    `tenant/sub_permission/${role}/returns/approve_return=return_approval`,
  ]),
  ...['billing_admin', 'operations_admin', 'security_admin', 'support_admin', 'system_owner'].map((role) =>
    `platform/sub_permission/${role}/billing_subscriptions/approve_billing_actions=platform_billing_approval`),
].sort();

const tupleLabel = (t: CanonicalGrantTuple): string => `${t.plane}/${t.stratum}/${t.role}/${t.scope}/${t.action}`;

test('the structural classification is exactly the decisive level, stratum by stratum', () => {
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    let expected: boolean;
    if (t.stratum === 'domain_threshold') expected = t.requiredLevel === 'approve';
    else if (t.plane === 'tenant') expected = TENANT_SUB_PERMISSIONS.find((s) => s.id === t.action)!.defaultLevel === 'approve';
    else expected = PLATFORM_SUB_PERMISSIONS.find((s) => s.id === t.action)!.threshold === 'approve';
    assert.equal(t.requiresApproveLevel, expected, tupleLabel(t));
  }
  const subs = (plane: string): string[] => [...new Set(CANONICAL_GRANT_UNIVERSE
    .filter((t) => t.plane === plane && t.stratum === 'sub_permission' && t.requiresApproveLevel).map((t) => t.action))].sort();
  assert.deepEqual(subs('tenant'), [...PINNED_APPROVE_LEVEL_SUBS.tenant]);
  assert.deepEqual(subs('platform'), [...PINNED_APPROVE_LEVEL_SUBS.platform]);
  // 4 roles × 21 domains + 5 × 11 features at `approve`, plus 4 × 4 tenant and 5 × 10 platform subs.
  assert.equal(CANONICAL_GRANT_UNIVERSE.filter((t) => t.requiresApproveLevel).length, 84 + 55 + 16 + 50);
});

test('the D2 money actions are exactly the documented representations — never inferred from a level', () => {
  const money = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action')
    .map((t) => `${tupleLabel(t)}=${t.moneyAction}`).sort();
  assert.deepEqual(money, PINNED_MONEY_ACTION_TUPLES);

  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.d2Classification === 'money_action') {
      assert.equal(t.requiresApproveLevel, true, `a money action is approve-level: ${tupleLabel(t)}`);
      assert.notEqual(t.moneyAction, null);
    } else {
      assert.equal(t.moneyAction, null, tupleLabel(t));
      // Everything approve-level that is not documented is unresolved; everything else is not D2's.
      assert.equal(t.d2Classification, t.requiresApproveLevel ? 'unresolved' : 'not_money_action', tupleLabel(t));
    }
  }
  const count = (c: string): number => CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === c).length;
  assert.deepEqual({ money: count('money_action'), unresolved: count('unresolved'), not: count('not_money_action') },
    { money: 17, unresolved: 205 - 17, not: 1659 - 205 });

  // Level alone never makes a money action: approve-level tuples a document does not name stay unresolved.
  const at = (plane: string, stratum: string, role: string, scope: string, action: string): CanonicalGrantTuple =>
    CANONICAL_GRANT_UNIVERSE.find((t) => t.plane === plane && t.stratum === stratum && t.role === role
      && t.scope === scope && t.action === action)!;
  assert.equal(at('tenant', 'sub_permission', 'manager', 'inventory', 'approve_inventory').d2Classification, 'unresolved');
  assert.equal(at('tenant', 'sub_permission', 'manager', 'employees', 'approve_requests').d2Classification, 'unresolved');
  assert.equal(at('tenant', 'domain_threshold', 'manager', 'returns', 'require:approve').d2Classification, 'unresolved',
    'return approval is documented as approve_return, not as the returns domain at approve');
  assert.equal(at('platform', 'sub_permission', 'support_admin', 'addon_governance', 'grant_paid_override').d2Classification, 'unresolved');
  assert.equal(at('tenant', 'domain_threshold', 'manager', 'refunds', 'require:manage').d2Classification, 'not_money_action');
  assert.equal(at('tenant', 'sub_permission', 'manager', 'refunds', 'process_refunds').d2Classification, 'not_money_action',
    'process_refunds moves money but is not approve-gated, so D2 does not govern it');
});

test('every money-action source is quoted exactly from the document it names', () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  assert.deepEqual(D2_MONEY_ACTIONS.map((m) => m.operation), ['refund_approval', 'return_approval', 'platform_billing_approval']);
  for (const m of D2_MONEY_ACTIONS) {
    assert.ok(m.sources.length > 0, `${m.operation} has a source`);
    assert.ok(m.representations.length > 0, `${m.operation} has a representation`);
    for (const s of m.sources) {
      assert.ok(readFileSync(join(repo, s.path), 'utf8').includes(s.quote), `${m.operation}: "${s.quote}" is in ${s.path}`);
    }
    for (const r of m.representations) {
      const roles = r.plane === 'tenant' ? TENANT_ROLE_IDS : PLATFORM_ROLE_IDS;
      for (const role of roles) {
        assert.ok(CANONICAL_GRANT_UNIVERSE.some((t) => t.plane === r.plane && t.stratum === r.stratum
          && t.role === role && t.scope === r.scope && t.action === r.action), `${m.operation}: ${role}/${r.scope}/${r.action} exists`);
      }
    }
  }
});

test('no documented money action changes under the unified ordering — pinned per role', () => {
  // Written by hand: the manager already holds refunds at approve; every non-owner tenant role holds an
  // explicit approve_refunds / approve_return grant (true for the manager only); store_owner is full;
  // on the platform only system_owner and billing_admin (billing_subscriptions full) clear approve.
  const GRANTED = new Set(['manager', 'store_owner', 'system_owner', 'billing_admin']);
  let checked = 0;
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.d2Classification !== 'money_action') continue;
    const expected = GRANTED.has(t.role) ? 'granted' : 'denied';
    assert.equal(evaluateBefore(t, CTX), expected, `BEFORE ${tupleLabel(t)}`);
    assert.equal(evaluateAfterCandidate(t, CTX), expected, `AFTER ${tupleLabel(t)}`);
    checked += 1;
  }
  assert.equal(checked, 17);
});

test('a named-grant-only capability would classify unresolved, never slip through as not_money_action', () => {
  for (const action of [...D2_NAMED_GRANT_ONLY_ACTIONS, ...D2_UNMAPPED_PAYMENT_OPERATIONS]) {
    assert.equal(CANONICAL_GRANT_UNIVERSE.some((t) => t.action === action), false, `${action} is not in the catalog yet`);
    for (const approve of [false, true]) {
      assert.deepEqual(classifyForD2('tenant', 'sub_permission', 'payments', action, approve),
        { d2Classification: 'unresolved', moneyAction: null }, action);
    }
  }
  assert.deepEqual(classifyForD2('tenant', 'sub_permission', 'refunds', 'approve_refunds', true),
    { d2Classification: 'money_action', moneyAction: 'refund_approval' });
  assert.deepEqual(classifyForD2('tenant', 'domain_threshold', 'widgets', 'require:approve', true),
    { d2Classification: 'unresolved', moneyAction: null });
  assert.deepEqual(classifyForD2('tenant', 'domain_threshold', 'widgets', 'require:manage', false),
    { d2Classification: 'not_money_action', moneyAction: null });
  // A representation matches on every field: the same action on another plane or scope is not it.
  assert.deepEqual(classifyForD2('platform', 'sub_permission', 'refunds', 'approve_refunds', true),
    { d2Classification: 'unresolved', moneyAction: null });
});

test('the manager/refunds narrowing is pinned: an approve holder, a manage gate, a threshold only', () => {
  const row = computeGrantDiff(CTX).rows.find((r) => r.change === 'narrowed')!;
  assert.deepEqual(
    { role: row.role, scope: row.scope, action: row.action, held: row.heldLevel, gate: row.requiredLevel,
      before: row.before, after: row.after, flip: row.flipPair, d2: row.d2Classification, money: row.moneyAction },
    { role: 'manager', scope: 'refunds', action: 'require:manage', held: 'approve', gate: 'manage',
      before: 'granted', after: 'denied', flip: 'approve_no_longer_satisfies_manage', d2: 'not_money_action', money: null });
  // Why BEFORE and AFTER differ: approve ranks above manage today, below it under the unified ordering.
  assert.equal(meetsTenantPermissionLevel('approve', 'manage'), true);
  assert.equal(candidateMeetsLevel('approve', 'manage'), false);
  // Why it is a threshold only: no refunds sub-permission compares against manage, and the documented
  // refund-approval representation (refunds at approve) does not move for the manager.
  for (const s of TENANT_SUB_PERMISSIONS.filter((x) => x.parentDomain === 'refunds')) {
    assert.notEqual(s.minModuleLevel, 'manage', s.id);
    assert.notEqual(s.defaultLevel, 'manage', s.id);
  }
  const approveGate = CANONICAL_GRANT_UNIVERSE.find((t) => t.plane === 'tenant' && t.stratum === 'domain_threshold'
    && t.role === 'manager' && t.scope === 'refunds' && t.action === 'require:approve')!;
  assert.equal(approveGate.d2Classification, 'money_action');
  assert.equal(evaluateBefore(approveGate, CTX), 'granted');
  assert.equal(evaluateAfterCandidate(approveGate, CTX), 'granted');
});

test('control: a level-only D2 classification — P1\'s reading of approve-gated as "a D2 row" — is detected', () => {
  // Classifying every approve-level tuple as a money action is exactly the overstatement R1 corrects.
  // The pinned set must reject it, or the taxonomy tests above would not be testing anything.
  const levelOnly = CANONICAL_GRANT_UNIVERSE.filter((t) => t.requiresApproveLevel).map(tupleLabel).sort();
  const pinned = PINNED_MONEY_ACTION_TUPLES.map((s) => s.split('=')[0]).sort();
  assert.notDeepEqual(levelOnly, pinned);
  assert.equal(levelOnly.length - pinned.length, 188, 'a level-only reading would claim 188 extra D2 tuples');
  const diff = computeGrantDiff(CTX);
  assert.equal(diff.rows.filter((r) => r.requiresApproveLevel).length, 12, 'twelve structural approve-level rows…');
  assert.equal(diff.rows.filter((r) => r.d2Classification === 'money_action').length, 0, '…and zero money-action rows');
});

// =============================================================================
// Exhaustiveness across the other axes
// =============================================================================

test('no entitlement or limitation context produces a change the canonical context does not contain', () => {
  // The artifact is computed in one declared context. That is only honest if no other context can
  // surface a row it omits — so sweep the extremes and every single-key variation.
  const canonical = new Set(computeGrantDiff(CTX).rows.map(
    (r) => `${r.plane}/${r.stratum}/${r.role}/${r.scope}/${r.action}`));

  const keys = [...KNOWN_TENANT_ENTITLEMENT_KEYS].sort();
  const aliased = Object.fromEntries(Object.entries(FULLY_ENTITLED)
    .map(([k, v]) => [k === 'supply-chain' ? 'supply_chain' : k, v]));
  const contexts: GrantEvaluationContext[] = [];
  for (const limitation of ['none', 'read_only'] as const) {
    contexts.push({ entitlements: FULLY_ENTITLED, limitation });
    contexts.push({ entitlements: {}, limitation });
    // Alias-keyed entitlement maps: the catalog normalizes `supply_chain` to `supply-chain` and
    // OR-merges, so a context written with the alias must behave exactly like the canonical one.
    contexts.push({ entitlements: aliased, limitation });
    contexts.push({ entitlements: { supply_chain: true }, limitation });
    contexts.push({ entitlements: { ...FULLY_ENTITLED, 'supply-chain': false, supply_chain: true }, limitation });
    contexts.push({ entitlements: { ...aliased, supply_chain: false }, limitation });
    for (const k of keys) {
      contexts.push({ entitlements: { ...FULLY_ENTITLED, [k]: false }, limitation }); // one off
      contexts.push({ entitlements: { [k]: true }, limitation });                     // only one on
    }
  }
  assert.ok(contexts.length >= 4 + 4 * keys.length, 'the sweep is not empty');

  for (const ctx of contexts) {
    for (const r of computeGrantDiff(ctx).rows) {
      const key = `${r.plane}/${r.stratum}/${r.role}/${r.scope}/${r.action}`;
      assert.ok(canonical.has(key), `context-specific change outside the canonical diff: ${key}`);
    }
  }
});

test('the read-only cap removes every change — a limited actor cannot be widened by the flip', () => {
  const diff = computeGrantDiff({ entitlements: FULLY_ENTITLED, limitation: 'read_only' });
  assert.equal(diff.rows.length, 0);
});

// =============================================================================
// Determinism and fingerprints
// =============================================================================

test('the diff and its input fingerprint are stable across calls', () => {
  assert.equal(normalizedAuthorizationInputs(), normalizedAuthorizationInputs());
  assert.equal(JSON.stringify(computeGrantDiff(CTX)), JSON.stringify(computeGrantDiff(CTX)));
});

test('the normalized inputs cover every catalog input the diff reads', () => {
  const s = normalizedAuthorizationInputs();
  for (const role of [...TENANT_ROLE_IDS, ...PLATFORM_ROLE_IDS]) assert.ok(s.includes(role), role);
  for (const d of TENANT_PERMISSION_DOMAINS) assert.ok(s.includes(d), d);
  for (const f of PLATFORM_FEATURE_KEYS) assert.ok(s.includes(f), f);
  for (const sub of TENANT_SUB_PERMISSIONS) assert.ok(s.includes(sub.id), sub.id);
  for (const sub of PLATFORM_SUB_PERMISSIONS) assert.ok(s.includes(sub.id), sub.id);
  for (const lvl of PERMISSION_LEVEL_VALUES) assert.ok(s.includes(lvl), lvl);
});

test('the named-grant-only capabilities 04 §2 tracks are carried, and none is in the catalog yet', () => {
  assert.deepEqual([...D2_NAMED_GRANT_ONLY_ACTIONS].sort(), [
    'activate_payment_gateway',
    'disconnect_payment_gateway',
    'manage_payment_gateway_connections',
    'manage_payment_terminals',
  ]);
  const known = new Set([
    ...TENANT_SUB_PERMISSIONS.map((s) => s.id),
    ...PLATFORM_SUB_PERMISSIONS.map((s) => s.id),
  ]);
  for (const a of D2_NAMED_GRANT_ONLY_ACTIONS) {
    assert.equal(known.has(a), false, `${a} is not in the shipped catalog — the list is forward-looking`);
  }
});

// =============================================================================
// Defect controls — break it on purpose, require the suite to notice
// =============================================================================

test('control: a reversed ordering is detected', () => {
  const reversed = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full']; // the OLD order
  const rank = (l: string): number => { const i = reversed.indexOf(l); return i < 0 ? 0 : i; };
  const brokenMeets = (a: string, r: string): boolean => rank(a) >= rank(r);
  // A candidate built on the old order would report NO flips at all.
  let flips = 0;
  for (const a of PERMISSION_LEVEL_VALUES) {
    for (const r of PERMISSION_LEVEL_VALUES) {
      if (meetsTenantPermissionLevel(a, r) !== brokenMeets(a, r)) flips += 1;
    }
  }
  assert.equal(flips, 0, 'the broken candidate is indistinguishable from BEFORE');
  // …and the real candidate is not that, which is exactly what the assertion above would have hidden.
  let realFlips = 0;
  for (const a of PERMISSION_LEVEL_VALUES) {
    for (const r of PERMISSION_LEVEL_VALUES) {
      if (meetsTenantPermissionLevel(a, r) !== candidateMeetsLevel(a, r)) realFlips += 1;
    }
  }
  assert.equal(realFlips, 2);
});

test('control: an omitted action is detected', () => {
  const omitted = CANONICAL_GRANT_UNIVERSE.filter((_, i) => i !== 0);
  const audit = auditUniverse(omitted);
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.startsWith('missing tuple:')), audit.problems.join('; '));
});

test('control: a duplicate tuple is detected', () => {
  const duped = [...CANONICAL_GRANT_UNIVERSE, CANONICAL_GRANT_UNIVERSE[0]];
  const audit = auditUniverse(duped);
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.startsWith('duplicate tuple:')), audit.problems.join('; '));
});

test('control: an unexpected extra tuple is detected', () => {
  const extra = [...CANONICAL_GRANT_UNIVERSE, {
    ...CANONICAL_GRANT_UNIVERSE[0], action: 'a_tuple_nobody_declared',
  } as CanonicalGrantTuple];
  const audit = auditUniverse(extra);
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.startsWith('unexpected tuple:')), audit.problems.join('; '));
});

test('control: an out-of-order universe is detected', () => {
  const audit = auditUniverse([...CANONICAL_GRANT_UNIVERSE].reverse());
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.startsWith('unstable ordering')), audit.problems.join('; '));
});

test('control: accidental manage-to-approve inheritance in the AUTHORITATIVE engine would be caught', () => {
  // If production started granting `approve` to a `manage` holder, BEFORE would equal the candidate
  // on all twelve widened rows and the diff would collapse to one row. Assert the current, correct
  // behaviour so that regression cannot pass quietly.
  assert.equal(meetsTenantPermissionLevel('manage', 'approve'), false,
    'the shipped tenant engine must still deny manage->approve');
  assert.equal(candidateMeetsLevel('manage', 'approve'), true,
    'the candidate must grant it — that is the whole widening');
  const widened = computeGrantDiff(CTX).rows.filter((r) => r.change === 'widened');
  assert.equal(widened.length, 12);
});

test('control: an accidental candidate cutover would be caught', () => {
  // A cutover means the authority answers what the candidate answers. On the thirteen pinned rows
  // they must still disagree; if they agreed, the cutover has happened.
  const diff = computeGrantDiff(CTX);
  assert.equal(diff.rows.length, 13, 'a cutover would empty this');
  for (const r of diff.rows) {
    assert.notEqual(r.before, r.after, `${r.role}/${r.scope}/${r.action} still diverges`);
  }
  // And the authority still disagrees with the candidate ordering on the two flipping comparisons.
  assert.notEqual(meetsTenantPermissionLevel('manage', 'approve'), candidateMeetsLevel('manage', 'approve'));
  assert.notEqual(meetsTenantPermissionLevel('approve', 'manage'), candidateMeetsLevel('approve', 'manage'));
});

// =============================================================================
// Containment — the candidate cannot become the authority
// =============================================================================

test('the candidate never replaces the authority: BEFORE ignores the candidate entirely', () => {
  // BEFORE is production by delegation. Proven behaviourally: on every pinned row BEFORE returns the
  // shipped answer, which is by construction the one the candidate does NOT return.
  const diff = computeGrantDiff(CTX);
  for (const r of diff.rows) {
    const t = CANONICAL_GRANT_UNIVERSE.find((x) =>
      x.plane === r.plane && x.stratum === r.stratum && x.role === r.role
      && x.scope === r.scope && x.action === r.action)!;
    assert.equal(evaluateBefore(t, CTX), r.before);
    assert.equal(evaluateAfterCandidate(t, CTX), r.after);
    assert.notEqual(evaluateBefore(t, CTX), evaluateAfterCandidate(t, CTX));
  }
});

test('computing the diff does not mutate the universe, the context, or the catalog', () => {
  const beforeUniverse = CANONICAL_GRANT_UNIVERSE.map(grantTupleKey).join('|');
  const beforeInputs = normalizedAuthorizationInputs();
  const beforeCtx = JSON.stringify(CTX);
  computeGrantDiff(CTX);
  computeGrantDiff({ entitlements: {}, limitation: 'read_only' });
  assert.equal(CANONICAL_GRANT_UNIVERSE.map(grantTupleKey).join('|'), beforeUniverse);
  assert.equal(normalizedAuthorizationInputs(), beforeInputs);
  assert.equal(JSON.stringify(CTX), beforeCtx);
});

test('universe tuples and diff rows are frozen', () => {
  assert.equal(Object.isFrozen(CANONICAL_GRANT_UNIVERSE), true);
  assert.equal(Object.isFrozen(CANONICAL_GRANT_UNIVERSE[0]), true);
  const diff = computeGrantDiff(CTX);
  assert.equal(Object.isFrozen(diff), true);
  assert.equal(Object.isFrozen(diff.rows), true);
  assert.equal(Object.isFrozen(diff.rows[0]), true);
  assert.equal(Object.isFrozen(diff.summary), true);
});
