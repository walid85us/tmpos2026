// Phase 4.0 M5-GAP11-P2 — owner decision D2 in the candidate: explicit per-role money-action grants.
//
// D2: an approval-gated money action requires an explicit per-role grant. An explicit `true` is
// required; `false`, missing, malformed or unknown denies; no level — `approve`, `manage`, `full` —
// and no ordering comparison grants one by itself; the grant is necessary but never sufficient; and
// the initial values preserve today's authoritative answer. This suite proves each of those against
// the candidate (evaluateAfterRepinCandidate), which stays observational.
//
// As in the matrix suite, the expectations are PINNED AS LITERAL DATA — the seventeen tuples and their
// values are written out by hand — so a defect that moved the table and the evaluator together could
// not make this suite agree with itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CANONICAL_GRANT_UNIVERSE,
  CANONICAL_DIFF_CONTEXT,
  FULLY_ENTITLED,
  D2_EXPLICIT_MONEY_ACTION_GRANTS,
  D2_MONEY_ACTIONS,
  auditExplicitMoneyGrants,
  candidateMeetsLevel,
  computeGrantDiff,
  computeRepinnedGrantDiff,
  evaluateAfterCandidate,
  evaluateAfterRepinCandidate,
  evaluateBefore,
  explicitMoneyGrantFor,
  heldLevelFor,
  normalizedAuthorizationInputs,
  type CanonicalGrantTuple,
  type D2ExplicitMoneyGrant,
  type GrantEvaluationContext,
} from './gap11GrantDiff';
import {
  KNOWN_TENANT_ENTITLEMENT_KEYS,
  PLATFORM_PERMISSION_DEPENDENCIES,
  TENANT_ROLE_SUBPERMISSION_DEFAULTS,
} from './permissionCatalog';

const CTX = CANONICAL_DIFF_CONTEXT;
const label = (t: { plane: string; stratum: string; role: string; scope: string; action: string }): string =>
  `${t.plane}/${t.stratum}/${t.role}/${t.scope}/${t.action}`;

// =============================================================================
// Pinned by hand — docs/phase-4/04 §3, the platform catalog, and today's authoritative answers
// =============================================================================

/** The seventeen documented money-action tuples and the explicit value each carries. */
const PINNED_EXPLICIT: Readonly<Record<string, boolean>> = {
  'platform/sub_permission/billing_admin/billing_subscriptions/approve_billing_actions': true,
  'platform/sub_permission/operations_admin/billing_subscriptions/approve_billing_actions': false,
  'platform/sub_permission/security_admin/billing_subscriptions/approve_billing_actions': false,
  'platform/sub_permission/support_admin/billing_subscriptions/approve_billing_actions': false,
  'platform/sub_permission/system_owner/billing_subscriptions/approve_billing_actions': true,
  'tenant/domain_threshold/manager/refunds/require:approve': true,
  'tenant/domain_threshold/sales_staff/refunds/require:approve': false,
  'tenant/domain_threshold/store_owner/refunds/require:approve': true,
  'tenant/domain_threshold/technician/refunds/require:approve': false,
  'tenant/sub_permission/manager/refunds/approve_refunds': true,
  'tenant/sub_permission/manager/returns/approve_return': true,
  'tenant/sub_permission/sales_staff/refunds/approve_refunds': false,
  'tenant/sub_permission/sales_staff/returns/approve_return': false,
  'tenant/sub_permission/store_owner/refunds/approve_refunds': true,
  'tenant/sub_permission/store_owner/returns/approve_return': true,
  'tenant/sub_permission/technician/refunds/approve_refunds': false,
  'tenant/sub_permission/technician/returns/approve_return': false,
};

const MONEY: readonly CanonicalGrantTuple[] = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action');
const GRANTED_MONEY = MONEY.filter((t) => PINNED_EXPLICIT[label(t)] === true);

const tupleAt = (l: string): CanonicalGrantTuple => {
  const t = CANONICAL_GRANT_UNIVERSE.find((x) => label(x) === l);
  assert.ok(t !== undefined, `no tuple ${l}`);
  return t;
};

const entryAt = (l: string): D2ExplicitMoneyGrant => {
  const g = D2_EXPLICIT_MONEY_ACTION_GRANTS.find((x) => label(x) === l);
  assert.ok(g !== undefined, `no grant ${l}`);
  return g;
};

/** The committed table with one entry replaced (or removed, when `replacement` is undefined). */
const withEntry = (l: string, replacement?: unknown): unknown[] => {
  const out: unknown[] = [];
  for (const g of D2_EXPLICIT_MONEY_ACTION_GRANTS) {
    if (label(g) !== l) out.push(g);
    else if (replacement !== undefined) out.push(replacement);
  }
  return out;
};

/** The committed table with one value set. */
const withValue = (l: string, granted: boolean): unknown[] => withEntry(l, { ...entryAt(l), granted });

/** Every context the matrix suite sweeps: the extremes, an alias-keyed map, every one-off and one-on. */
function sweepContexts(): GrantEvaluationContext[] {
  const keys = [...KNOWN_TENANT_ENTITLEMENT_KEYS].sort();
  const aliased = Object.fromEntries(Object.entries(FULLY_ENTITLED)
    .map(([k, v]) => [k === 'supply-chain' ? 'supply_chain' : k, v]));
  const contexts: GrantEvaluationContext[] = [];
  for (const limitation of ['none', 'read_only'] as const) {
    contexts.push({ entitlements: FULLY_ENTITLED, limitation });
    contexts.push({ entitlements: {}, limitation });
    contexts.push({ entitlements: aliased, limitation });
    for (const k of keys) {
      contexts.push({ entitlements: { ...FULLY_ENTITLED, [k]: false }, limitation });
      contexts.push({ entitlements: { [k]: true }, limitation });
    }
  }
  return contexts;
}

// =============================================================================
// The catalogue and the table
// =============================================================================

test('the money-action catalogue is exactly the seventeen documented tuples, and the table covers exactly them', () => {
  assert.deepEqual(MONEY.map(label).sort(), Object.keys(PINNED_EXPLICIT).sort());
  // 8 refund approval (two representations × 4 tenant roles), 4 return approval, 5 platform billing.
  const byOp = (op: string): number => MONEY.filter((t) => t.moneyAction === op).length;
  assert.deepEqual({ refund: byOp('refund_approval'), ret: byOp('return_approval'), billing: byOp('platform_billing_approval') },
    { refund: 8, ret: 4, billing: 5 });

  assert.deepEqual(Object.fromEntries(D2_EXPLICIT_MONEY_ACTION_GRANTS.map((g) => [label(g), g.granted])), PINNED_EXPLICIT);
  assert.deepEqual(auditExplicitMoneyGrants(D2_EXPLICIT_MONEY_ACTION_GRANTS), { ok: true, problems: [] });
  // One entry per tuple, in universe order, frozen at every level, every value a real boolean.
  assert.deepEqual(D2_EXPLICIT_MONEY_ACTION_GRANTS.map(label), MONEY.map(label));
  assert.equal(Object.isFrozen(D2_EXPLICIT_MONEY_ACTION_GRANTS), true);
  for (const g of D2_EXPLICIT_MONEY_ACTION_GRANTS) {
    assert.equal(Object.isFrozen(g), true);
    assert.equal(typeof g.granted, 'boolean');
  }
});

test('each explicit value equals the shipped authority, and the catalog\'s own per-role grants agree with it', () => {
  for (const t of MONEY) {
    const pinned = PINNED_EXPLICIT[label(t)];
    assert.equal(evaluateBefore(t, CTX), pinned ? 'granted' : 'denied', `authority: ${label(t)}`);
    assert.equal(explicitMoneyGrantFor(D2_EXPLICIT_MONEY_ACTION_GRANTS, t), pinned, `table: ${label(t)}`);
  }
  // The non-owner tenant roles already carry explicit catalog booleans for the two money subs; the D2
  // table repeats them, so the re-pin changes how those tuples are decided, not their answer.
  const maps = TENANT_ROLE_SUBPERMISSION_DEFAULTS as unknown as Record<string, Record<string, boolean>>;
  for (const role of ['manager', 'sales_staff', 'technician']) {
    assert.equal(maps[role].approve_refunds, PINNED_EXPLICIT[`tenant/sub_permission/${role}/refunds/approve_refunds`], role);
    assert.equal(maps[role].approve_return, PINNED_EXPLICIT[`tenant/sub_permission/${role}/returns/approve_return`], role);
  }
});

test('preservation: the post-re-pin candidate reproduces the shipped authority on all seventeen, in every context', () => {
  const contexts = sweepContexts();
  assert.ok(contexts.length > 40, 'the sweep is not empty');
  let checked = 0;
  for (const ctx of contexts) {
    for (const t of MONEY) {
      assert.equal(evaluateAfterRepinCandidate(t, ctx), evaluateBefore(t, ctx),
        `${label(t)} under ${ctx.limitation}/${Object.keys(ctx.entitlements).length} keys`);
      checked += 1;
    }
  }
  assert.equal(checked, contexts.length * 17);
});

// =============================================================================
// No level grants a money action — and no level makes one
// =============================================================================

test('no approve-level mapping becomes a money action by its threshold, and no other tuple ever reads the table', () => {
  const unresolved = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'unresolved');
  assert.equal(unresolved.length, 188);
  assert.ok(unresolved.every((t) => t.requiresApproveLevel), 'unresolved means approve-level and undocumented');
  // A table that throws on any access: a tuple that is not a money action answers without touching it.
  const boom = (): never => { throw new Error('the grant table was read'); };
  const poisoned = new Proxy([], { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom });
  let answered = 0;
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.d2Classification === 'money_action') continue;
    assert.equal(evaluateAfterRepinCandidate(t, CTX, poisoned), evaluateAfterCandidate(t, CTX), label(t));
    answered += 1;
  }
  assert.equal(answered, 1659 - 17);
  // A grant written for an approve-level tuple no document names is refused, and cannot allow it.
  const rogue = { plane: 'tenant', stratum: 'domain_threshold', role: 'sales_staff', scope: 'returns', action: 'require:approve', granted: true };
  const audit = auditExplicitMoneyGrants([...D2_EXPLICIT_MONEY_ACTION_GRANTS, rogue]);
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.includes('not a money action')), audit.problems.join('; '));
  const t = tupleAt('tenant/domain_threshold/sales_staff/returns/require:approve');
  assert.equal(t.d2Classification, 'unresolved');
  assert.equal(evaluateAfterRepinCandidate(t, CTX, [...D2_EXPLICIT_MONEY_ACTION_GRANTS, rogue]), 'denied');
});

test('every money action needs its explicit grant: `approve`, `manage` and `full` holders are denied without one', () => {
  // The unified ordering alone would grant each of these eight — that is what the re-pin takes away.
  assert.equal(GRANTED_MONEY.length, 8);
  for (const t of GRANTED_MONEY) {
    assert.equal(evaluateAfterCandidate(t, CTX), 'granted', `control: the unified ordering grants ${label(t)}`);
    assert.equal(evaluateAfterRepinCandidate(t, CTX, withValue(label(t), false)), 'denied', `explicit false: ${label(t)}`);
  }
  // By the level each holds: `full` (the owners, billing_admin), `approve` (the manager on refunds), and
  // `manage` (the manager on returns, which the unified ordering says clears `approve`).
  const held = (l: string): string | null => heldLevelFor(tupleAt(l), CTX);
  assert.equal(held('tenant/domain_threshold/store_owner/refunds/require:approve'), 'full');
  assert.equal(held('platform/sub_permission/system_owner/billing_subscriptions/approve_billing_actions'), 'full');
  assert.equal(held('platform/sub_permission/billing_admin/billing_subscriptions/approve_billing_actions'), 'full');
  assert.equal(held('tenant/domain_threshold/manager/refunds/require:approve'), 'approve');
  assert.equal(held('tenant/sub_permission/manager/returns/approve_return'), 'manage');
  assert.equal(candidateMeetsLevel('manage', 'approve'), true, 'control: manage clears approve on the unified ordering');
  const allFalse = D2_EXPLICIT_MONEY_ACTION_GRANTS.map((g) => ({ ...g, granted: false }));
  assert.equal(auditExplicitMoneyGrants(allFalse).ok, true, 'a sound table that grants nothing');
  for (const t of MONEY) assert.equal(evaluateAfterRepinCandidate(t, CTX, allFalse), 'denied', label(t));
});

test('missing, false, malformed and unknown grants deny — and an unsound table honors no grant at all', () => {
  for (const t of GRANTED_MONEY) assert.equal(evaluateAfterRepinCandidate(t, CTX), 'granted', `control: ${label(t)}`);

  const first = label(GRANTED_MONEY[0]);
  const entry = entryAt(first);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const throwingGrant = Object.defineProperty({ ...entry }, 'granted', { get() { throw new Error('boom'); } });
  const tables: readonly (readonly [string, unknown, string])[] = [
    ['missing', withEntry(first), 'missing grant'],
    ['string true', withEntry(first, { ...entry, granted: 'true' }), 'not a boolean'],
    ['number 1', withEntry(first, { ...entry, granted: 1 }), 'not a boolean'],
    ['null', withEntry(first, { ...entry, granted: null }), 'not a boolean'],
    ['absent value', withEntry(first, { ...entry, granted: undefined }), 'not a boolean'],
    ['boxed true', withEntry(first, { ...entry, granted: Object(true) }), 'not a boolean'],
    ['throwing getter', withEntry(first, throwingGrant), 'cannot be read'],
    ['not an object', withEntry(first, 'grant'), 'not an object'],
    ['duplicate, same value', [...D2_EXPLICIT_MONEY_ACTION_GRANTS, entry], 'duplicate grant'],
    ['unknown role', [...D2_EXPLICIT_MONEY_ACTION_GRANTS, { ...entry, role: 'super_admin' }], 'names no canonical tuple'],
    ['unknown action', [...D2_EXPLICIT_MONEY_ACTION_GRANTS, { ...entry, action: 'approve_everything' }], 'names no canonical tuple'],
    ['padded role', [...D2_EXPLICIT_MONEY_ACTION_GRANTS, { ...entry, role: ` ${entry.role}` }], 'names no canonical tuple'],
    ['NUL in a field', [...D2_EXPLICIT_MONEY_ACTION_GRANTS, { ...entry, scope: `${entry.scope}${String.fromCharCode(0)}` }], 'names no canonical tuple'],
    ['wrong plane', [...D2_EXPLICIT_MONEY_ACTION_GRANTS, { ...entry, plane: entry.plane === 'tenant' ? 'platform' : 'tenant' }], 'names no canonical tuple'],
  ];
  for (const [why, table, problem] of tables) {
    const audit = auditExplicitMoneyGrants(table);
    assert.equal(audit.ok, false, why);
    assert.ok(audit.problems.some((p) => p.includes(problem)), `${why}: ${audit.problems.join('; ')}`);
    for (const t of GRANTED_MONEY) {
      assert.equal(evaluateAfterRepinCandidate(t, CTX, table), 'denied', `${why}: ${label(t)}`);
      assert.equal(explicitMoneyGrantFor(table, t), null, `${why}: no grant is read from an unsound table`);
    }
  }
  // Not a table at all. (`undefined` is audited but not passed to the evaluator: there it is JavaScript's
  // "no argument", which selects the committed table — the default the shadow comparator relies on.)
  assert.equal(auditExplicitMoneyGrants(undefined).ok, false);
  for (const table of [null, {}, 'grants', 42, true, revoked.proxy,
    new Proxy([], { get() { throw new Error('boom'); } })]) {
    assert.equal(auditExplicitMoneyGrants(table).ok, false, typeof table);
    for (const t of GRANTED_MONEY) assert.equal(evaluateAfterRepinCandidate(t, CTX, table), 'denied', label(t));
  }
});

// =============================================================================
// Necessary, never sufficient — every other constraint keeps its place
// =============================================================================

test('an explicit grant cannot bypass the plan gate, the read-only limitation, the parent-module minimum or the tuple\'s scope', () => {
  // Plan gate: the refunds domain is plan-gated; with it off, the owner's and manager's explicit
  // grants allow nothing — exactly as the shipped authority says.
  const noRefunds: GrantEvaluationContext = { entitlements: { ...FULLY_ENTITLED, refunds: false }, limitation: 'none' };
  for (const role of ['store_owner', 'manager']) {
    for (const l of [`tenant/domain_threshold/${role}/refunds/require:approve`, `tenant/sub_permission/${role}/refunds/approve_refunds`]) {
      assert.equal(PINNED_EXPLICIT[l], true, `control: ${l} is explicitly granted`);
      assert.equal(evaluateAfterRepinCandidate(tupleAt(l), noRefunds), 'denied', `plan gate: ${l}`);
      assert.equal(evaluateBefore(tupleAt(l), noRefunds), 'denied', `authority agrees: ${l}`);
    }
  }
  // Read-only: every money action is a write, and the limitation still refuses it, grant or no grant.
  const readOnly: GrantEvaluationContext = { entitlements: FULLY_ENTITLED, limitation: 'read_only' };
  for (const t of MONEY) assert.equal(evaluateAfterRepinCandidate(t, readOnly), 'denied', `read-only: ${label(t)}`);

  // Parent-module minimum: `approve_return` needs `returns` at `manage` before any grant is read. A
  // grant written for a role holding `view` there still allows nothing; the manager's does.
  const salesReturn = 'tenant/sub_permission/sales_staff/returns/approve_return';
  const flipped = withValue(salesReturn, true);
  assert.equal(auditExplicitMoneyGrants(flipped).ok, true, 'a sound table, only the value differs');
  assert.equal(heldLevelFor(tupleAt(salesReturn), CTX), 'view');
  assert.equal(evaluateAfterRepinCandidate(tupleAt(salesReturn), CTX, flipped), 'denied', 'minimum `manage` not met');
  assert.equal(evaluateAfterRepinCandidate(tupleAt('tenant/sub_permission/manager/returns/approve_return'), CTX, flipped), 'granted', 'control');

  // Scope: a grant belongs to one exact tuple. The manager's refund-approval grant is not a grant on
  // another plane, scope, stratum or role, and a tuple that is not canonical is denied outright.
  const mgr = tupleAt('tenant/sub_permission/manager/refunds/approve_refunds');
  for (const spoof of [
    { ...mgr, scope: 'returns' }, { ...mgr, plane: 'platform' }, { ...mgr, stratum: 'domain_threshold' },
    { ...mgr, role: 'store_manager' }, { ...mgr, moneyAction: 'return_approval' }, { ...mgr, d2Classification: 'unresolved' },
  ]) {
    assert.equal(evaluateAfterRepinCandidate(spoof, CTX), 'denied', JSON.stringify(spoof));
  }
  assert.equal(evaluateAfterRepinCandidate(tupleAt('tenant/sub_permission/technician/refunds/approve_refunds'), CTX), 'denied',
    'the manager\'s grant is not the technician\'s');
});

test('the explicit grant replaces only the grant step: on a re-pinned threshold the held level neither grants nor blocks', () => {
  // Pinned semantics of the re-pin, so a later change to them is visible. A sound table that grants
  // the sales_staff refund-approval threshold allows it although the role holds `refunds` at `none`;
  // one that withholds the owner's denies it although the owner holds `full`.
  const salesThreshold = 'tenant/domain_threshold/sales_staff/refunds/require:approve';
  const ownerThreshold = 'tenant/domain_threshold/store_owner/refunds/require:approve';
  assert.equal(heldLevelFor(tupleAt(salesThreshold), CTX), 'none');
  assert.equal(evaluateAfterRepinCandidate(tupleAt(salesThreshold), CTX, withValue(salesThreshold, true)), 'granted');
  assert.equal(evaluateAfterRepinCandidate(tupleAt(ownerThreshold), CTX, withValue(ownerThreshold, false)), 'denied');
  // The same for the platform approval: `view` on billing does not block a grant, `full` does not replace one.
  const ops = 'platform/sub_permission/operations_admin/billing_subscriptions/approve_billing_actions';
  assert.equal(heldLevelFor(tupleAt(ops), CTX), 'view');
  assert.equal(evaluateAfterRepinCandidate(tupleAt(ops), CTX, withValue(ops, true)), 'granted');
  // `approve_billing_actions` has no platform prerequisite, and no prerequisite anywhere is a money
  // action — so no tuple reaches a money action through a dependency, re-pinned or not.
  const moneyIds = new Set(MONEY.map((t) => t.action));
  assert.deepEqual(PLATFORM_PERMISSION_DEPENDENCIES.approve_billing_actions ?? [], []);
  for (const [sub, deps] of Object.entries(PLATFORM_PERMISSION_DEPENDENCIES)) {
    assert.ok(!deps.some((d) => moneyIds.has(d)), `${sub} depends on a money action`);
  }
});

test('every one of the seventeen grants is read: flipping it moves exactly that tuple — pinned per role', () => {
  // Written by hand. Set to `true`, a grant allows its tuple unless a constraint that is not a grant
  // blocks it: `approve_refunds` needs `refunds` at `view` and `approve_return` needs `returns` at
  // `manage` before any grant is read, which sales_staff (refunds none, returns view) and technician
  // (the same) do not hold. Set to `false`, every grant denies. So a candidate that bypassed D2 for any
  // single role or representation fails here.
  const BLOCKED_WHEN_TRUE = new Set([
    'tenant/sub_permission/sales_staff/refunds/approve_refunds',
    'tenant/sub_permission/technician/refunds/approve_refunds',
    'tenant/sub_permission/sales_staff/returns/approve_return',
    'tenant/sub_permission/technician/returns/approve_return',
  ]);
  for (const t of MONEY) {
    const l = label(t);
    const asTrue = evaluateAfterRepinCandidate(t, CTX, withValue(l, true));
    const asFalse = evaluateAfterRepinCandidate(t, CTX, withValue(l, false));
    assert.equal(asTrue, BLOCKED_WHEN_TRUE.has(l) ? 'denied' : 'granted', `true: ${l}`);
    assert.equal(asFalse, 'denied', `false: ${l}`);
    // And no other money action moves when this one does.
    for (const other of MONEY) {
      if (other === t) continue;
      assert.equal(evaluateAfterRepinCandidate(other, CTX, withValue(l, !PINNED_EXPLICIT[l])),
        evaluateAfterRepinCandidate(other, CTX), `${l} flip moved ${label(other)}`);
    }
  }
});

test('a getter that rewrites JavaScript built-ins cannot make a table grant what it does not carry', () => {
  // The boundary this candidate states: caller code run by a getter can rewrite built-ins (and could
  // reach the shipped evaluator the same way), but a money action is still allowed only by a boolean
  // `true` the table itself carries — the grant table and the tuple index are read without dispatching
  // through a built-in. Two regressions, each of which granted before the index and the record replaced
  // Map lookups. Every built-in is restored before anything is asserted.
  const saved = {
    get: Map.prototype.get, push: Array.prototype.push, every: Array.prototype.every,
    freeze: Object.freeze, replace: String.prototype.replace,
  };
  const restore = (): void => {
    Map.prototype.get = saved.get; Array.prototype.push = saved.push; Array.prototype.every = saved.every;
    Object.freeze = saved.freeze; String.prototype.replace = saved.replace;
  };
  let viaTable = '';
  let viaTuple = '';
  let missing: { ok: boolean } | string = 'not run';
  try {
    // 1. An all-`false` table whose first entry's getter rewrites Map lookups to answer `true`, drops
    //    every push and passes every `every` — while itself reading `false`.
    const allFalse = D2_EXPLICIT_MONEY_ACTION_GRANTS.map((g) => ({ ...g, granted: false }));
    Object.defineProperty(allFalse[0], 'granted', {
      get() {
        Map.prototype.get = function poisoned() { return true; } as never;
        Array.prototype.push = function poisoned() { return 0; } as never;
        Array.prototype.every = function poisoned() { return true; } as never;
        return false;
      },
    });
    for (const t of MONEY) viaTable += evaluateAfterRepinCandidate(t, CTX, allFalse) === 'granted' ? 'G' : '-';
    restore();
    // 2. A tuple that claims store_owner's refund approval is not a money action, and whose getter
    //    rewrites Map lookups to hand back a tuple agreeing with that claim.
    const real = tupleAt('tenant/sub_permission/store_owner/refunds/approve_refunds');
    const spoof: Record<string, unknown> = { ...real, d2Classification: 'not_money_action', moneyAction: null };
    const fake = Object.freeze({ ...spoof });
    Object.defineProperty(spoof, 'role', {
      get() { Map.prototype.get = function poisoned() { return fake; } as never; return 'store_owner'; },
      enumerable: true,
    });
    viaTuple = evaluateAfterRepinCandidate(spoof, CTX, allFalse);
    restore();
    // 3. A table missing its last entry, whose first getter drops every push, fakes every freeze as a
    //    clean audit and makes every string replace throw: it must still audit unsound, without throwing.
    const short = D2_EXPLICIT_MONEY_ACTION_GRANTS.slice(0, 16).map((g) => ({ ...g }));
    Object.defineProperty(short[0], 'granted', {
      get() {
        Array.prototype.push = function poisoned() { return 0; } as never;
        Object.freeze = function poisoned() { return { ok: true, problems: [] }; } as never;
        String.prototype.replace = function poisoned() { throw new Error('poisoned replace'); } as never;
        return true;
      },
    });
    try { missing = { ok: auditExplicitMoneyGrants(short).ok }; } catch (e) { missing = `threw: ${String(e)}`; }
  } finally {
    restore();
  }
  assert.deepEqual(missing, { ok: false }, 'a missing entry keeps the table unsound, whatever was rewritten');
  assert.equal(viaTable, '-'.repeat(17), 'no money action granted from a table that carries no true');
  assert.equal(viaTuple, 'denied', 'a money action is classified from the universe, not from a lookup a getter can rewrite');
  assert.equal(evaluateAfterRepinCandidate(tupleAt('tenant/sub_permission/store_owner/refunds/approve_refunds'), CTX),
    'granted', 'control: the committed grant still allows it');
});

test('tripwires: no platform threshold is a money action, and no platform money action has a prerequisite', () => {
  // The candidate denies a re-pinned platform threshold outright, and keeps platform prerequisites on
  // re-pinned platform sub-permissions — but no data reaches either path today. If either assertion
  // fails, that path has become live and needs its own tests before this suite can pass again.
  for (const m of D2_MONEY_ACTIONS) {
    for (const r of m.representations) {
      assert.ok(!(r.plane === 'platform' && r.stratum === 'domain_threshold'), `${m.operation} is a platform threshold`);
      if (r.plane === 'platform') {
        assert.deepEqual(PLATFORM_PERMISSION_DEPENDENCIES[r.action] ?? [], [], `${r.action} has platform prerequisites`);
      }
    }
  }
});

test('the two refund-approval representations agree for every role in every context under the committed table', () => {
  // D2 re-pins both `refunds/require:approve` and `approve_refunds`. The sub-permission keeps its
  // `refunds` minimum; the threshold has none (its comparison is the grant step). With today's values
  // they agree everywhere; a changed value should be set on both together (see the data-model note).
  for (const ctx of sweepContexts()) {
    for (const role of ['manager', 'sales_staff', 'store_owner', 'technician']) {
      assert.equal(
        evaluateAfterRepinCandidate(tupleAt(`tenant/domain_threshold/${role}/refunds/require:approve`), ctx),
        evaluateAfterRepinCandidate(tupleAt(`tenant/sub_permission/${role}/refunds/approve_refunds`), ctx),
        `${role} under ${ctx.limitation}/${Object.keys(ctx.entitlements).length} keys`);
    }
  }
});

test('row invariant: flipPair is null exactly when an explicit grant decided the row, and only then can explicitGrant be set', () => {
  const l = 'tenant/sub_permission/manager/refunds/approve_refunds';
  const diffs = [computeGrantDiff(CTX), computeRepinnedGrantDiff(CTX), computeRepinnedGrantDiff(CTX, withValue(l, false)),
    computeRepinnedGrantDiff(CTX, withEntry(l))];
  let byGrant = 0;
  for (const d of diffs) {
    for (const r of d.rows) {
      assert.equal(r.flipPair === null, r.decidedBy === 'explicit_grant', `${d.view} ${label(r)}`);
      if (r.decidedBy !== 'explicit_grant') assert.equal(r.explicitGrant, null, `${d.view} ${label(r)}`);
      else { byGrant += 1; assert.equal(r.d2Classification, 'money_action'); assert.equal(d.view, 'post_repin'); }
    }
  }
  assert.equal(byGrant, 1 + 8, 'control: the corrupted tables do produce explicit-grant rows');
});

test('unknown roles, levels, domains and actions fail closed on the post-re-pin candidate', () => {
  const t = tupleAt('tenant/domain_threshold/manager/refunds/require:approve');
  assert.equal(evaluateAfterRepinCandidate(t, CTX), 'granted', 'control');
  for (const bad of [
    { ...t, role: 'owner' }, { ...t, role: 'Manager' }, { ...t, scope: 'refund' }, { ...t, action: 'require:superuser' },
    { ...t, requiredLevel: 'superuser' }, { ...t, requiredLevel: 'none' }, { ...t, plane: 'store' }, { ...t, stratum: 'grant' },
    null, undefined, 42, 'tuple', [], {},
  ]) {
    assert.equal(evaluateAfterRepinCandidate(bad, CTX), 'denied', JSON.stringify(bad));
  }
  for (const ctx of [null, undefined, {}, { entitlements: FULLY_ENTITLED, limitation: 'unknown' }, { entitlements: null, limitation: 'none' }]) {
    assert.equal(evaluateAfterRepinCandidate(t, ctx as never), 'denied', JSON.stringify(ctx));
  }
});

// =============================================================================
// The three views and the post-D2 diff (the thirteen changes D3 rejected; the D3 suite pins them)
// =============================================================================

/** The thirteen rows the ordering flip changes — pinned by hand in the matrix suite, repeated here. */
const PINNED_CHANGED = [
  'tenant/domain_threshold/manager/employees/require:approve=widened',
  'tenant/domain_threshold/manager/integrations/require:approve=widened',
  'tenant/domain_threshold/manager/inventory/require:approve=widened',
  'tenant/domain_threshold/manager/marketing/require:approve=widened',
  'tenant/domain_threshold/manager/refunds/require:manage=narrowed',
  'tenant/domain_threshold/manager/returns/require:approve=widened',
  'tenant/domain_threshold/manager/settings/require:approve=widened',
  'tenant/domain_threshold/manager/shipping/require:approve=widened',
  'tenant/domain_threshold/manager/suggestive_sales/require:approve=widened',
  'tenant/domain_threshold/manager/supply_chain/require:approve=widened',
  'tenant/domain_threshold/manager/warranties/require:approve=widened',
  'tenant/domain_threshold/manager/widgets/require:approve=widened',
  'tenant/domain_threshold/technician/repairs/require:approve=widened',
];

test('the post-re-pin diff: 1659 evaluated, 1646 unchanged, 12 widened, 1 narrowed — the same thirteen rows, none decided by a grant', () => {
  const pre = computeGrantDiff(CTX);
  const post = computeRepinnedGrantDiff(CTX);
  for (const d of [pre, post]) {
    assert.deepEqual({ e: d.summary.evaluated, u: d.summary.unchanged, w: d.summary.widened, n: d.summary.narrowed },
      { e: 1659, u: 1646, w: 12, n: 1 }, d.view);
    assert.deepEqual(d.rows.map((r) => `${label(r)}=${r.change}`), PINNED_CHANGED, d.view);
    assert.deepEqual({ ...d.summary.byD2Classification }, { money_action: 0, not_money_action: 1, unresolved: 12 }, d.view);
    for (const r of d.rows) {
      assert.equal(r.decidedBy, 'level_ordering');
      assert.equal(r.explicitGrant, null);
      assert.notEqual(r.flipPair, null);
    }
  }
  assert.equal(pre.view, 'pre_repin');
  assert.equal(post.view, 'post_repin');
  // Across the three views, tuple by tuple: the re-pin moves no answer the ordering did not already.
  let preVsPost = 0;
  for (const t of CANONICAL_GRANT_UNIVERSE) if (evaluateAfterCandidate(t, CTX) !== evaluateAfterRepinCandidate(t, CTX)) preVsPost += 1;
  assert.equal(preVsPost, 0);
  // And in every other context the post-re-pin diff stays inside the canonical thirteen.
  const canonical = new Set(post.rows.map(label));
  for (const ctx of sweepContexts()) {
    for (const r of computeRepinnedGrantDiff(ctx).rows) assert.ok(canonical.has(label(r)), `outside the canonical diff: ${label(r)}`);
  }
});

test('the production evaluator is unchanged over the canonical decision space — pinned from the entry bytes', () => {
  // Every authoritative answer, every tuple, four contexts (full/empty entitlements × none/read_only),
  // fingerprinted. The value was captured at 4d61b117, before this stage changed anything; the
  // pre-re-pin candidate is pinned the same way, so the refactor that made its grant step replaceable
  // is proven not to have moved it.
  const contexts: GrantEvaluationContext[] = [
    CTX, { entitlements: {}, limitation: 'none' },
    { entitlements: FULLY_ENTITLED, limitation: 'read_only' }, { entitlements: {}, limitation: 'read_only' },
  ];
  const vector = (f: (t: CanonicalGrantTuple, c: GrantEvaluationContext) => string): string =>
    createHash('sha256').update(contexts.map((c) => CANONICAL_GRANT_UNIVERSE.map((t) => (f(t, c) === 'granted' ? '1' : '0')).join('')).join('|')).digest('hex');
  assert.equal(vector(evaluateBefore), '22d64b70ed5e7d3866a2f8166780043f28fdd0c31e64f5087120e9399100e8b6');
  assert.equal(vector(evaluateAfterCandidate), 'b853f82a3bb950a6669c042d9047a9ab88d6b16838ba066830a9abe36fbc5289');
});

test('control: a removed or corrupted explicit grant surfaces in the post-D2 diff and breaks preservation', () => {
  // Break the table on purpose and require the machinery to notice — a preservation test that could
  // not fail would prove nothing.
  const l = 'tenant/sub_permission/manager/refunds/approve_refunds';
  const d = computeRepinnedGrantDiff(CTX, withValue(l, false));
  assert.equal(d.rows.length, 14);
  const row = d.rows.find((r) => label(r) === l)!;
  assert.deepEqual({ change: row.change, by: row.decidedBy, flip: row.flipPair, explicit: row.explicitGrant, d2: row.d2Classification },
    { change: 'narrowed', by: 'explicit_grant', flip: null, explicit: false, d2: 'money_action' });
  assert.notEqual(evaluateAfterRepinCandidate(tupleAt(l), CTX, withValue(l, false)), evaluateBefore(tupleAt(l), CTX));

  // A removed grant makes the table unsound: all eight granted money actions narrow at once.
  const removed = computeRepinnedGrantDiff(CTX, withEntry(l)).rows.filter((r) => r.decidedBy === 'explicit_grant');
  assert.equal(removed.length, 8);
  assert.ok(removed.every((r) => r.change === 'narrowed' && r.explicitGrant === null));

  // A widening grant is caught just the same, and an untouched grant does not move.
  const t = 'platform/sub_permission/support_admin/billing_subscriptions/approve_billing_actions';
  const rows = computeRepinnedGrantDiff(CTX, withValue(t, true)).rows;
  const w = rows.find((r) => label(r) === t)!;
  assert.deepEqual({ change: w.change, by: w.decidedBy, explicit: w.explicitGrant }, { change: 'widened', by: 'explicit_grant', explicit: true });
  assert.equal(rows.filter((r) => r.decidedBy === 'explicit_grant').length, 1, 'control: only the changed grant moves');
});

test('the table and the post-D2 diff are deterministic, frozen, and fingerprinted into the artifact inputs', () => {
  assert.equal(JSON.stringify(computeRepinnedGrantDiff(CTX)), JSON.stringify(computeRepinnedGrantDiff(CTX)));
  const d = computeRepinnedGrantDiff(CTX);
  assert.equal(Object.isFrozen(d), true);
  assert.equal(Object.isFrozen(d.rows), true);
  assert.ok(d.rows.every((r) => Object.isFrozen(r)));
  const inputs = JSON.parse(normalizedAuthorizationInputs()) as { d2: { explicitGrants: D2ExplicitMoneyGrant[] } };
  assert.deepEqual(inputs.d2.explicitGrants.map((g) => `${label(g)}=${g.granted}`),
    D2_EXPLICIT_MONEY_ACTION_GRANTS.map((g) => `${label(g)}=${g.granted}`), 'a changed grant value is a stale artifact');
});
