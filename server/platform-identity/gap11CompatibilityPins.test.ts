// Phase 4.0 M5-GAP11-P3 — owner decision D3 in the candidate: thirteen ordering-compatibility pins.
//
// D3: the owner rejected every one of the thirteen changes the unified ordering makes (the P2 artifact,
// sha256 f49ca74b…). Each tuple keeps today's answer — the twelve widened rows stay denied, the
// manager's `refunds` `manage` gate stays allowed — so the candidate a cutover would install
// (evaluatePinnedCandidate) answers exactly as the shipped authority. The pins are not money-action
// classifications and not a rule. A pin table that is not exactly the committed one makes the
// candidate invalid; it never falls back to the unified ordering's widened or narrowed answer.
//
// As in the matrix and D2 suites, the expectations are PINNED AS LITERAL DATA, written out by hand from
// the owner's decision, so a defect that moved the table and the evaluator together could not make this
// suite agree with itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CANONICAL_GRANT_UNIVERSE,
  CANONICAL_DIFF_CONTEXT,
  FULLY_ENTITLED,
  D2_EXPLICIT_MONEY_ACTION_GRANTS,
  D3_COMPATIBILITY_PINS,
  auditCompatibilityPins,
  auditExplicitMoneyGrants,
  computePinnedGrantDiff,
  computeRepinnedGrantDiff,
  evaluateAfterRepinCandidate,
  evaluateBefore,
  evaluatePinnedCandidate,
  normalizedAuthorizationInputs,
  type CanonicalGrantTuple,
  type D3CompatibilityPin,
  type GrantEvaluationContext,
} from './gap11GrantDiff';
import { KNOWN_TENANT_ENTITLEMENT_KEYS } from './permissionCatalog';

const CTX = CANONICAL_DIFF_CONTEXT;
const label = (t: { plane: string; stratum: string; role: string; scope: string; action: string }): string =>
  `${t.plane}/${t.stratum}/${t.role}/${t.scope}/${t.action}`;
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// =============================================================================
// Pinned by hand — the owner's D3 decision
// =============================================================================

/** The thirteen rejected changes and the authoritative answer each keeps (true = allowed). */
const PINNED_D3: Readonly<Record<string, boolean>> = {
  'tenant/domain_threshold/manager/employees/require:approve': false,
  'tenant/domain_threshold/manager/integrations/require:approve': false,
  'tenant/domain_threshold/manager/inventory/require:approve': false,
  'tenant/domain_threshold/manager/marketing/require:approve': false,
  'tenant/domain_threshold/manager/refunds/require:manage': true,
  'tenant/domain_threshold/manager/returns/require:approve': false,
  'tenant/domain_threshold/manager/settings/require:approve': false,
  'tenant/domain_threshold/manager/shipping/require:approve': false,
  'tenant/domain_threshold/manager/suggestive_sales/require:approve': false,
  'tenant/domain_threshold/manager/supply_chain/require:approve': false,
  'tenant/domain_threshold/manager/warranties/require:approve': false,
  'tenant/domain_threshold/manager/widgets/require:approve': false,
  'tenant/domain_threshold/technician/repairs/require:approve': false,
};
const PINNED_LABELS = Object.keys(PINNED_D3);
const REFUNDS_MANAGE = 'tenant/domain_threshold/manager/refunds/require:manage';

const tupleAt = (l: string): CanonicalGrantTuple => {
  const t = CANONICAL_GRANT_UNIVERSE.find((x) => label(x) === l);
  assert.ok(t !== undefined, `no tuple ${l}`);
  return t;
};
const PINNED_TUPLES: readonly CanonicalGrantTuple[] = PINNED_LABELS.map(tupleAt);

/** The committed table with one entry replaced (or removed, when `replacement` is undefined). */
const withEntry = (l: string, replacement?: unknown): unknown[] => {
  const out: unknown[] = [];
  for (const p of D3_COMPATIBILITY_PINS) {
    if (label(p) !== l) out.push(p);
    else if (replacement !== undefined) out.push(replacement);
  }
  return out;
};
const pinAt = (l: string): D3CompatibilityPin => {
  const p = D3_COMPATIBILITY_PINS.find((x) => label(x) === l);
  assert.ok(p !== undefined, `no pin ${l}`);
  return p;
};

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

/**
 * Every way a table can differ from the committed one, each with a problem it must report. Built from
 * the committed entries, so each case differs from it in exactly the way its name says.
 */
function invalidTables(): { why: string; table: unknown; problem: string }[] {
  const cases: { why: string; table: unknown; problem: string }[] = [];
  for (const l of PINNED_LABELS) {
    cases.push({ why: `removed ${l}`, table: withEntry(l), problem: 'missing pin' });
    cases.push({ why: `changed ${l}`, table: withEntry(l, { ...pinAt(l), granted: !PINNED_D3[l] }), problem: 'does not keep the authoritative answer' });
  }
  const first = PINNED_LABELS[0];
  const unrelated = tupleAt('tenant/domain_threshold/manager/sales/require:view');
  const money = tupleAt('tenant/domain_threshold/manager/refunds/require:approve');
  const fourteenth = (t: CanonicalGrantTuple, granted: boolean): unknown =>
    ({ plane: t.plane, stratum: t.stratum, role: t.role, scope: t.scope, action: t.action, granted });
  cases.push(
    { why: 'duplicated', table: [...D3_COMPATIBILITY_PINS, pinAt(first)], problem: 'duplicate pin' },
    { why: 'a fourteenth pin on an unchanged tuple, carrying its authoritative answer', table: [...D3_COMPATIBILITY_PINS, fourteenth(unrelated, true)], problem: 'does not change' },
    { why: 'a fourteenth pin on a money action, carrying its authoritative answer', table: [...D3_COMPATIBILITY_PINS, fourteenth(money, true)], problem: 'money action' },
    { why: 'a string value', table: withEntry(first, { ...pinAt(first), granted: 'false' }), problem: 'not a boolean' },
    { why: 'a missing value', table: withEntry(first, { ...pinAt(first), granted: undefined }), problem: 'not a boolean' },
    { why: 'a null entry', table: withEntry(first, null), problem: 'not an object' },
    { why: 'an entry naming no tuple', table: withEntry(first, { ...pinAt(first), role: 'Manager' }), problem: 'names no canonical tuple' },
    { why: 'a separator smuggled across fields', table: withEntry(first, { ...pinAt(first), role: `manager${String.fromCharCode(0)}employees`, scope: '' }), problem: 'names no canonical tuple' },
    { why: 'an entry that throws when read', table: withEntry(first, Object.defineProperty({}, 'plane', { enumerable: true, get() { throw new Error('boom'); } })), problem: 'cannot be read' },
    { why: 'an entry labelling itself a money action', table: withEntry(first, { ...pinAt(first), d2Classification: 'money_action' }), problem: 'exactly the six pin fields' },
    { why: 'an entry carrying a rule', table: withEntry(first, { ...pinAt(first), rule: 'manage satisfies approve' }), problem: 'exactly the six pin fields' },
    { why: 'an entry carrying a non-enumerable extra', table: withEntry(first, Object.defineProperty({ ...pinAt(first) }, 'rule', { value: 'x', enumerable: false })), problem: 'exactly the six pin fields' },
    { why: 'an entry carrying a symbol-keyed extra', table: withEntry(first, { ...pinAt(first), [Symbol('rule')]: true }), problem: 'exactly the six pin fields' },
    { why: 'an entry lacking a field of its own', table: withEntry(first, (({ granted: _g, ...rest }) => rest)(pinAt(first))), problem: 'exactly the six pin fields' },
    { why: 'an empty table', table: [], problem: 'missing pin' },
    { why: 'not an array', table: { ...D3_COMPATIBILITY_PINS }, problem: 'not an array' },
    { why: 'null', table: null, problem: 'not an array' },
  );
  return cases;
}

// =============================================================================
// The table
// =============================================================================

test('the compatibility table is exactly the thirteen pins D3 authorized, each with its authoritative value', () => {
  assert.deepEqual(D3_COMPATIBILITY_PINS.map((p) => `${label(p)}=${p.granted}`),
    PINNED_LABELS.map((l) => `${l}=${PINNED_D3[l]}`), 'the committed table, in universe order');
  assert.equal(D3_COMPATIBILITY_PINS.length, 13);
  assert.equal(D3_COMPATIBILITY_PINS.filter((p) => p.granted).length, 1, 'one allowing pin, twelve denying');
  assert.deepEqual(auditCompatibilityPins(D3_COMPATIBILITY_PINS), { ok: true, problems: [] });
  assert.equal(Object.isFrozen(D3_COMPATIBILITY_PINS), true);
  assert.ok(D3_COMPATIBILITY_PINS.every((p) => Object.isFrozen(p)));
  // Each value is the shipped authority's answer, and the unified ordering alone would flip it.
  for (const t of PINNED_TUPLES) {
    assert.equal(evaluateBefore(t, CTX) === 'granted', PINNED_D3[label(t)], `authority: ${label(t)}`);
    assert.notEqual(evaluateAfterRepinCandidate(t, CTX), evaluateBefore(t, CTX), `the ordering moves it: ${label(t)}`);
  }
});

test('the pins are exactly the thirteen rows the post-D2 diff changed — found by behaviour, not by name', () => {
  // The P2 artifact's net changes, which D3 rejected: the post-D2 diff in the canonical context.
  assert.deepEqual(computeRepinnedGrantDiff(CTX).rows.map(label), PINNED_LABELS);
  // Nothing about a name decides it: no other tuple with the same role, scope or level is pinned.
  const pinned = new Set(PINNED_LABELS);
  const siblings = CANONICAL_GRANT_UNIVERSE.filter((t) => !pinned.has(label(t))
    && PINNED_TUPLES.some((p) => p.role === t.role && p.stratum === t.stratum && (p.scope === t.scope || p.action === t.action)));
  assert.ok(siblings.length > 100, 'control: many tuples share a role and a scope or level with a pin');
  for (const t of siblings) {
    assert.equal(evaluatePinnedCandidate(t, CTX), evaluateAfterRepinCandidate(t, CTX), `a sibling reads no pin: ${label(t)}`);
  }
});

// =============================================================================
// The behaviour
// =============================================================================

test('the twelve former widenings stay denied and manager/refunds/require:manage stays allowed, in every swept context', () => {
  let allowed = 0;
  for (const t of PINNED_TUPLES) {
    const canonical = evaluatePinnedCandidate(t, CTX);
    assert.equal(canonical, PINNED_D3[label(t)] ? 'granted' : 'denied', label(t));
    if (canonical === 'granted') allowed += 1;
    for (const ctx of sweepContexts()) {
      assert.equal(evaluatePinnedCandidate(t, ctx), evaluateBefore(t, ctx), `${label(t)} in ${JSON.stringify(ctx)}`);
    }
  }
  assert.equal(allowed, 1);
});

test('the pinned candidate equals the shipped authority on all 1,659 tuples in every context the suites sweep', () => {
  let compared = 0;
  for (const ctx of sweepContexts()) {
    for (const t of CANONICAL_GRANT_UNIVERSE) {
      assert.equal(evaluatePinnedCandidate(t, ctx), evaluateBefore(t, ctx), `${label(t)} in ${JSON.stringify(ctx)}`);
      compared += 1;
    }
  }
  assert.equal(compared, sweepContexts().length * 1659);
  // And against the authoritative vector pinned from the P2 entry bytes (four contexts, every tuple).
  const contexts: GrantEvaluationContext[] = [
    CTX, { entitlements: {}, limitation: 'none' },
    { entitlements: FULLY_ENTITLED, limitation: 'read_only' }, { entitlements: {}, limitation: 'read_only' },
  ];
  const vector = createHash('sha256').update(contexts.map((c) => CANONICAL_GRANT_UNIVERSE
    .map((t) => (evaluatePinnedCandidate(t, c) === 'granted' ? '1' : '0')).join('')).join('|')).digest('hex');
  assert.equal(vector, '22d64b70ed5e7d3866a2f8166780043f28fdd0c31e64f5087120e9399100e8b6');
});

test('each pin moves exactly its own tuple: post-D2 and pinned differ on the thirteen and nowhere else', () => {
  const moved = CANONICAL_GRANT_UNIVERSE.filter((t) => evaluatePinnedCandidate(t, CTX) !== evaluateAfterRepinCandidate(t, CTX));
  assert.deepEqual(moved.map(label), PINNED_LABELS, 'each pin moves its tuple, and only the pins move anything');
  const pinned = new Set(PINNED_LABELS);
  for (const ctx of sweepContexts()) {
    for (const t of CANONICAL_GRANT_UNIVERSE) {
      if (pinned.has(label(t))) continue;
      assert.equal(evaluatePinnedCandidate(t, ctx), evaluateAfterRepinCandidate(t, ctx), `${label(t)} in ${JSON.stringify(ctx)}`);
    }
  }
});

test('a pin replaces only the level comparison: the plan gate and the read-only cap still deny the allowing pin', () => {
  const t = tupleAt(REFUNDS_MANAGE);
  assert.equal(evaluatePinnedCandidate(t, CTX), 'granted', 'control');
  const noRefunds: GrantEvaluationContext = { entitlements: { ...FULLY_ENTITLED, refunds: false }, limitation: 'none' };
  const readOnly: GrantEvaluationContext = { entitlements: FULLY_ENTITLED, limitation: 'read_only' };
  for (const ctx of [noRefunds, readOnly]) {
    assert.equal(evaluatePinnedCandidate(t, ctx), 'denied', JSON.stringify(ctx));
    assert.equal(evaluateBefore(t, ctx), 'denied', `and so does the authority: ${JSON.stringify(ctx)}`);
  }
  // A denying pin denies whatever the role holds — the held level neither grants nor blocks it.
  for (const l of PINNED_LABELS.filter((x) => !PINNED_D3[x])) {
    for (const ctx of [CTX, noRefunds, readOnly]) assert.equal(evaluatePinnedCandidate(tupleAt(l), ctx), 'denied', l);
  }
});

test('no pin is a money action, and the D2 grants and their seventeen outcomes are unchanged', () => {
  for (const t of PINNED_TUPLES) assert.notEqual(t.d2Classification, 'money_action', label(t));
  // The D2 table is byte-for-byte the one P2 committed, and still audits clean.
  assert.equal(sha256(JSON.stringify(D2_EXPLICIT_MONEY_ACTION_GRANTS)),
    '9827e078cbb9f57ac78e3ecf6a7b3ed7206d70e6e6e9b6f3fb4dd9ebeec14dee');
  assert.equal(auditExplicitMoneyGrants(D2_EXPLICIT_MONEY_ACTION_GRANTS).ok, true);
  const money = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action');
  assert.equal(money.length, 17);
  for (const t of money) {
    for (const ctx of sweepContexts()) {
      const pinned = evaluatePinnedCandidate(t, ctx);
      assert.equal(pinned, evaluateAfterRepinCandidate(t, ctx), `post-D2: ${label(t)}`);
      assert.equal(pinned, evaluateBefore(t, ctx), `authority: ${label(t)}`);
    }
  }
});

test('no unresolved mapping is reclassified: 188 unresolved, the twelve denying pins among them, the allowing one not_money_action', () => {
  const unresolved = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'unresolved');
  assert.equal(unresolved.length, 188);
  assert.equal(sha256(unresolved.map(label).join('\n')),
    '0cc0a297ba975e5d8b400102c93995d45da812f224b0678872ffb713b6beebb0', 'the same 188 tuples as before the pins');
  assert.equal(CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action').length, 17);
  for (const t of PINNED_TUPLES) {
    assert.equal(t.d2Classification, label(t) === REFUNDS_MANAGE ? 'not_money_action' : 'unresolved', label(t));
  }
  // A pin is not a classification: the universe's tuples are frozen, so nothing the pins do can rewrite one.
  assert.ok(CANONICAL_GRANT_UNIVERSE.every((t) => Object.isFrozen(t)));
});

// =============================================================================
// Closure and fail-closed invalidity
// =============================================================================

test('a removed, duplicated, corrupted or changed pin, and a fourteenth pin, are each refused', () => {
  const cases = invalidTables();
  assert.ok(cases.length >= 43);
  for (const { why, table, problem } of cases) {
    const audit = auditCompatibilityPins(table);
    assert.equal(audit.ok, false, why);
    assert.ok(audit.problems.some((p) => p.includes(problem)), `${why}: ${audit.problems.join('; ')}`);
    assert.throws(() => computePinnedGrantDiff(CTX, table), /pins are invalid/, why);
  }
});

test('an invalid candidate has no answers: it never falls back to the widened or narrowed answer, on any tuple', () => {
  for (const { why, table } of invalidTables()) {
    for (const t of PINNED_TUPLES) {
      const v = evaluatePinnedCandidate(t, CTX, table);
      assert.equal(v, 'invalid', `${why}: ${label(t)}`);
      assert.notEqual(v, evaluateAfterRepinCandidate(t, CTX), `${why}: not the unified ordering's answer`);
    }
  }
  // Every tuple of the universe, not only the pinned ones, and an unknown tuple too.
  const [removed] = invalidTables();
  assert.ok(CANONICAL_GRANT_UNIVERSE.every((t) => evaluatePinnedCandidate(t, CTX, removed.table) === 'invalid'));
  assert.equal(evaluatePinnedCandidate({ junk: true }, CTX, removed.table), 'invalid');
});

test('no caller-provided object can add, remove or rewrite a pin', () => {
  // A fresh copy with the committed content is the same table: validity is by content, not identity.
  const copy = JSON.parse(JSON.stringify(D3_COMPATIBILITY_PINS)) as unknown[];
  assert.equal(auditCompatibilityPins(copy).ok, true);
  for (const t of PINNED_TUPLES) assert.equal(evaluatePinnedCandidate(t, CTX, copy), evaluatePinnedCandidate(t, CTX));
  // Every other table — each rewrite, removal or addition above — only invalidates.
  for (const { table } of invalidTables()) {
    for (const t of PINNED_TUPLES) assert.equal(evaluatePinnedCandidate(t, CTX, table), 'invalid');
  }
  // An omitted table is the committed one (a default parameter), never an empty or permissive one.
  assert.equal(auditCompatibilityPins(undefined).ok, false, 'as a value, undefined is no table');
  for (const t of PINNED_TUPLES) assert.equal(evaluatePinnedCandidate(t, CTX, undefined), evaluateBefore(t, CTX));
  // A context or a tuple carrying pin-shaped data changes nothing.
  const smuggling = { ...CTX, pins: [], compatibilityPins: [], granted: true } as unknown as GrantEvaluationContext;
  for (const t of PINNED_TUPLES) {
    assert.equal(evaluatePinnedCandidate(t, smuggling), evaluateBefore(t, CTX), `context: ${label(t)}`);
    assert.equal(evaluatePinnedCandidate({ ...t, granted: !PINNED_D3[label(t)], pin: true }, CTX), evaluateBefore(t, CTX), `tuple: ${label(t)}`);
  }
  // Polluting Object.prototype with a pinned key's value cannot reach the null-prototype records.
  const sep = String.fromCharCode(0);
  const key = ['tenant', 'domain_threshold', 'manager', 'employees', 'require:approve'].join(sep);
  const proto = Object.prototype as Record<string, unknown>;
  proto[key] = true;
  try {
    assert.equal(evaluatePinnedCandidate(tupleAt(PINNED_LABELS[0]), CTX), 'denied');
    assert.equal(auditCompatibilityPins(withEntry(PINNED_LABELS[0])).ok, false, 'a removed pin is not supplied by the prototype');
  } finally {
    delete proto[key];
  }
  // And the committed table cannot be edited in place.
  assert.throws(() => { (D3_COMPATIBILITY_PINS as D3CompatibilityPin[]).push(pinAt(PINNED_LABELS[0])); }, TypeError);
  assert.throws(() => { (pinAt(REFUNDS_MANAGE) as { granted: boolean }).granted = false; }, TypeError);
});

test('an entry read through a getter is read once: it cannot pass the audit with one value and act with another', () => {
  let reads = 0;
  const l = PINNED_LABELS[0];
  const shifting = Object.defineProperty({ ...pinAt(l) }, 'granted', {
    enumerable: true, get() { reads += 1; return reads === 1 ? PINNED_D3[l] : !PINNED_D3[l]; },
  });
  const table = withEntry(l, shifting);
  assert.equal(evaluatePinnedCandidate(tupleAt(l), CTX, table), 'denied', 'the first read is the only one');
  assert.equal(reads, 1);
});

test('unknown roles, levels, domains and actions fail closed on the pinned candidate', () => {
  const t = tupleAt(REFUNDS_MANAGE);
  assert.equal(evaluatePinnedCandidate(t, CTX), 'granted', 'control');
  for (const bad of [
    { ...t, role: 'owner' }, { ...t, role: 'Manager' }, { ...t, scope: 'refund' }, { ...t, action: 'require:superuser' },
    { ...t, requiredLevel: 'superuser' }, { ...t, requiredLevel: 'none' }, { ...t, plane: 'store' }, { ...t, stratum: 'grant' },
    { ...t, d2Classification: 'unresolved' }, null, undefined, 42, 'tuple', [], {},
  ]) {
    assert.equal(evaluatePinnedCandidate(bad, CTX), 'denied', JSON.stringify(bad));
  }
  for (const ctx of [null, undefined, {}, { entitlements: FULLY_ENTITLED, limitation: 'unknown' }, { entitlements: null, limitation: 'none' }]) {
    assert.equal(evaluatePinnedCandidate(t, ctx as never), 'denied', JSON.stringify(ctx));
  }
});

// =============================================================================
// The final diff
// =============================================================================

test('the final diff: 1,659 evaluated, 1,659 unchanged, 0 widened, 0 narrowed — in every swept context', () => {
  const d = computePinnedGrantDiff(CTX);
  assert.equal(d.view, 'post_pins');
  assert.deepEqual({ e: d.summary.evaluated, u: d.summary.unchanged, w: d.summary.widened, n: d.summary.narrowed },
    { e: 1659, u: 1659, w: 0, n: 0 });
  assert.deepEqual(d.rows, []);
  assert.deepEqual({ ...d.summary.byD2Classification }, { money_action: 0, not_money_action: 0, unresolved: 0 });
  for (const ctx of sweepContexts()) assert.equal(computePinnedGrantDiff(ctx).rows.length, 0, JSON.stringify(ctx));
  // Non-vacuous: the same machinery reports the thirteen before the pins.
  assert.equal(computeRepinnedGrantDiff(CTX).rows.length, 13);
});

test('a malformed context makes the pinned diff throw — never an empty diff that compared nothing', () => {
  for (const ctx of [null, {}, { entitlements: FULLY_ENTITLED, limitation: 'readonly' }, { entitlements: null, limitation: 'none' }]) {
    assert.throws(() => computePinnedGrantDiff(ctx as never), /context is malformed/, JSON.stringify(ctx));
  }
  // The context is read once: a getter that is valid on the first read cannot fail a second one.
  let reads = 0;
  const shifting = { entitlements: FULLY_ENTITLED, get limitation() { reads += 1; return reads === 1 ? 'none' : 'bogus'; } };
  const d = computePinnedGrantDiff(shifting as never);
  assert.equal(reads, 1);
  assert.deepEqual({ ...d.context }, { entitlements: d.context?.entitlements, limitation: 'none' });
  assert.equal(d.rows.length, 0);
});

test('the final diff is deterministic and frozen, and the pins are fingerprinted into the artifact inputs', () => {
  assert.equal(JSON.stringify(computePinnedGrantDiff(CTX)), JSON.stringify(computePinnedGrantDiff(CTX)));
  const d = computePinnedGrantDiff(CTX);
  assert.equal(Object.isFrozen(d), true);
  assert.equal(Object.isFrozen(d.rows), true);
  const inputs = JSON.parse(normalizedAuthorizationInputs()) as { d3: { compatibilityPins: D3CompatibilityPin[] } };
  assert.deepEqual(inputs.d3.compatibilityPins.map((p) => `${label(p)}=${p.granted}`),
    D3_COMPATIBILITY_PINS.map((p) => `${label(p)}=${p.granted}`), 'a changed pin is a stale artifact');
});
