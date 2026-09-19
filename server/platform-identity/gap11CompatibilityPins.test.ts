// Phase 4.0 M5-GAP11-P5 — historical record of owner decision D3, and the convergence check that
// replaces it.
//
// D3 (M5-GAP11-P3) rejected all thirteen changes the (now superseded) global-ordering candidate would
// have made: the twelve widened rows stayed denied, the manager's `refunds` `manage` gate stayed
// allowed. That decision is preserved here as data (PINNED_D3) and checked against the shipped
// authority, which still answers exactly as D3 recorded — and against the post-D2 candidate
// (evaluateAfterRepinCandidate), which still differs on every one of the thirteen: that candidate is
// the rejected global-ordering proposal, and D3's rejection is exactly why it changed those rows.
//
// The D3 compatibility-pin MACHINERY itself (D3_COMPATIBILITY_PINS, evaluatePinnedCandidate,
// computePinnedGrantDiff, auditCompatibilityPins) is RETIRED as of M5-GAP11-P5: family-specific
// orderings (src/authorization/permissionFamilies.ts) make an ordering-compatibility pin meaningless,
// because there is no longer one global ordering to be compatible with. A tripwire below asserts none
// of it is exported any more.
//
// This suite also keeps the D2 default-grant checks (now BUILT-IN DEFAULTS, not runtime authority) and
// adds the convergence check M5-GAP11-P5 requires: the historical D2 table must still agree with the
// live defaults in src/authorization/moneyCapabilities.ts, so the history and the runtime default never
// silently drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as gap11 from './gap11GrantDiff';
import {
  CANONICAL_GRANT_UNIVERSE,
  CANONICAL_DIFF_CONTEXT,
  D2_DEFAULT_MONEY_ACTION_GRANTS,
  auditExplicitMoneyGrants,
  evaluateAfterRepinCandidate,
  evaluateBefore,
  type CanonicalGrantTuple,
} from './gap11GrantDiff';
import { BUILT_IN_MONEY_GRANT_DEFAULTS } from '../../src/authorization/moneyCapabilities';

const CTX = CANONICAL_DIFF_CONTEXT;
const label = (t: { plane: string; stratum: string; role: string; scope: string; action: string }): string =>
  `${t.plane}/${t.stratum}/${t.role}/${t.scope}/${t.action}`;
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// =============================================================================
// Pinned by hand — the owner's (historical) D3 decision
// =============================================================================

/** The thirteen rejected changes and the authoritative answer each kept (true = allowed). Historical. */
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

const tupleAt = (l: string): CanonicalGrantTuple => {
  const t = CANONICAL_GRANT_UNIVERSE.find((x) => label(x) === l);
  assert.ok(t !== undefined, `no tuple ${l}`);
  return t;
};
const PINNED_TUPLES: readonly CanonicalGrantTuple[] = PINNED_LABELS.map(tupleAt);

// =============================================================================
// The retirement of the D3 pin machinery
// =============================================================================

test('tripwire: gap11GrantDiff exports no D3 pin machinery any more', () => {
  const gone = ['D3_COMPATIBILITY_PINS', 'evaluatePinnedCandidate', 'computePinnedGrantDiff', 'auditCompatibilityPins'];
  for (const name of gone) {
    assert.equal(Object.prototype.hasOwnProperty.call(gap11, name), false, `${name} must not be exported`);
  }
});

// =============================================================================
// D3's rejection, still true of the shipped authority
// =============================================================================

test('the shipped authority still answers exactly as D3 recorded, on each of the thirteen historical rows', () => {
  for (const t of PINNED_TUPLES) {
    assert.equal(evaluateBefore(t, CTX) === 'granted', PINNED_D3[label(t)], `authority: ${label(t)}`);
  }
});

test('the post-D2 (rejected global-ordering) candidate still differs from the authority on each of the thirteen', () => {
  // This is exactly why D3 rejected the cutover: the candidate keeps disagreeing. If it ever agreed,
  // the global-ordering proposal would have stopped changing anything — which is not what happened.
  let checked = 0;
  for (const t of PINNED_TUPLES) {
    assert.notEqual(evaluateAfterRepinCandidate(t, CTX), evaluateBefore(t, CTX), `${label(t)} still diverges`);
    checked += 1;
  }
  assert.equal(checked, 13);
});

test('no pinned tuple is a money action, and it stays not_money_action or unresolved as before', () => {
  const REFUNDS_MANAGE = 'tenant/domain_threshold/manager/refunds/require:manage';
  for (const t of PINNED_TUPLES) {
    assert.notEqual(t.d2Classification, 'money_action', label(t));
    assert.equal(t.d2Classification, label(t) === REFUNDS_MANAGE ? 'not_money_action' : 'unresolved', label(t));
  }
});

// =============================================================================
// D2 — historical record, now the record of the BUILT-IN DEFAULTS (M5-GAP11-P5)
// =============================================================================

test('the D2 table is byte-for-byte the historical one, and still audits clean', () => {
  assert.equal(sha256(JSON.stringify(D2_DEFAULT_MONEY_ACTION_GRANTS)),
    '9827e078cbb9f57ac78e3ecf6a7b3ed7206d70e6e6e9b6f3fb4dd9ebeec14dee');
  assert.equal(auditExplicitMoneyGrants(D2_DEFAULT_MONEY_ACTION_GRANTS).ok, true);
  const money = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'money_action');
  assert.equal(money.length, 17);
});

test('all seventeen documented money actions still keep the D2/historical answer, unaffected by retiring D3', () => {
  for (const t of CANONICAL_GRANT_UNIVERSE) {
    if (t.d2Classification !== 'money_action') continue;
    const grant = D2_DEFAULT_MONEY_ACTION_GRANTS.find((g) => label(g) === label(t));
    assert.ok(grant !== undefined, label(t));
    const expected = grant!.granted ? 'granted' : 'denied';
    assert.equal(evaluateAfterRepinCandidate(t, CTX), expected, `post-D2: ${label(t)}`);
    assert.equal(evaluateBefore(t, CTX), expected, `authority: ${label(t)}`);
  }
});

test('the 188 unresolved tuples are the same set as before D3 was retired', () => {
  const unresolved = CANONICAL_GRANT_UNIVERSE.filter((t) => t.d2Classification === 'unresolved');
  assert.equal(unresolved.length, 188);
  assert.equal(sha256(unresolved.map(label).join('\n')),
    '0cc0a297ba975e5d8b400102c93995d45da812f224b0678872ffb713b6beebb0');
});

// =============================================================================
// Convergence — the historical D2 table must still agree with the live built-in defaults
// =============================================================================

test('BUILT_IN_MONEY_GRANT_DEFAULTS agrees with the historical D2 table for every sub_permission entry', () => {
  const subGrants = D2_DEFAULT_MONEY_ACTION_GRANTS.filter((g) => g.stratum === 'sub_permission');
  assert.equal(subGrants.length, 13, 'control: 8 tenant + 5 platform sub_permission money grants');
  for (const g of subGrants) {
    const defaults = BUILT_IN_MONEY_GRANT_DEFAULTS[g.role] as Record<string, boolean> | undefined;
    assert.ok(defaults !== undefined, `${g.role} has built-in defaults`);
    assert.equal(defaults[g.action], g.granted, `${g.role}/${g.action}: default vs historical D2`);
  }
});

test('every tenant refunds require:approve D2 entry equals the approve_refunds default for that role', () => {
  const thresholdGrants = D2_DEFAULT_MONEY_ACTION_GRANTS.filter((g) =>
    g.stratum === 'domain_threshold' && g.scope === 'refunds' && g.action === 'require:approve');
  assert.equal(thresholdGrants.length, 4, 'control: manager, sales_staff, store_owner, technician');
  for (const g of thresholdGrants) {
    const defaults = BUILT_IN_MONEY_GRANT_DEFAULTS[g.role] as Record<string, boolean> | undefined;
    assert.ok(defaults !== undefined, `${g.role} has built-in defaults`);
    assert.equal(defaults.approve_refunds, g.granted,
      `${g.role}: refunds/require:approve (historical) vs approve_refunds default (converged capability)`);
  }
});
