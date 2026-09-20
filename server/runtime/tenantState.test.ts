// Phase 4.0 M5-GIAM-D1-P2 — the one tenant-state decision (GAP-13): every status of 002's closed domain,
// the widest-restriction rule across a tenant and its store, the fail-closed answer for anything else, and
// the access-version comparison a tenant/store session is re-admitted against.
//
// Also proves the decision is the one the scope selection applies: a suspended tenant selects no scope at
// all, whatever grant it carries, so no later check can forget it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectScope } from './principals.js';
import type { TrustedMembership, TrustedPrincipal } from './principals.js';
import { decideStatus, decideTenantState, tenantAccessAdmitted } from './tenantState.js';

const TENANT = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const STORE = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const ACTOR = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const MEMBERSHIP = '5c4b3a29-1807-4f6e-9d5c-4b3a29180706';

/** The six values migration 002 pins for tenant.status and store.status, and nothing else. */
const DOMAIN_002: readonly string[] = ['active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation'];

test('every status of 002\'s closed domain has exactly one decision, and the three groups are disjoint', () => {
  assert.deepEqual(DOMAIN_002.map((s) => [s, decideStatus(s)]), [
    ['active', 'active'],
    ['trialing', 'active'],
    ['overdue', 'read_only'],
    ['suspended', 'denied'],
    ['read_only', 'read_only'],
    ['pending_activation', 'denied'],
  ]);
  // Suspension withdraws access; it is not a softer form of it.
  assert.equal(decideStatus('suspended'), 'denied', 'a suspended tenant is denied, never merely read-only');
});

test('anything outside that domain is denied: a new value, a near miss, a wrong type, an absent one', () => {
  const foreign = [
    'provisioning', 'pending', 'closed', 'deleted', 'archived', 'ACTIVE', 'Active', 'active ', ' active', '',
    'act', 'activee', 'suspended_pending', 'read-only', 'readonly',
  ];
  for (const s of foreign) assert.equal(decideStatus(s), 'denied', `an unrecognised status: ${JSON.stringify(s)}`);
  for (const s of [null, undefined, 1, 0, true, false, {}, [], ['active']]) {
    assert.equal(decideStatus(s), 'denied', `not a status at all: ${String(s)}`);
  }
  // A later migration that widens 002's CHECK without teaching this module the new value is denied, not allowed.
  assert.equal(decideStatus('grace_period'), 'denied', 'a value a future migration might add');
});

test('the widest restriction wins across a tenant and its store, and a scope with no status is unaffected', () => {
  assert.equal(decideTenantState(null, null), 'active', 'a platform request carries neither status');
  assert.equal(decideTenantState('active', null), 'active', 'a tenant-scope request carries no store status');
  assert.equal(decideTenantState('read_only', null), 'read_only');
  assert.equal(decideTenantState('suspended', null), 'denied');
  const pairs: Array<[string, string, string]> = [
    ['active', 'active', 'active'],
    ['trialing', 'active', 'active'],
    ['read_only', 'active', 'read_only'],
    ['active', 'read_only', 'read_only'],
    ['overdue', 'trialing', 'read_only'],
    ['suspended', 'active', 'denied'],
    ['active', 'suspended', 'denied'],
    ['read_only', 'suspended', 'denied'],
    ['suspended', 'read_only', 'denied'],
    ['suspended', 'suspended', 'denied'],
    ['active', 'pending_activation', 'denied'],
    ['active', 'not_a_status', 'denied'],
    ['not_a_status', 'active', 'denied'],
  ];
  for (const [tenant, store, expected] of pairs) {
    assert.equal(decideTenantState(tenant, store), expected, `tenant ${tenant} + store ${store}`);
  }
});

test('the access version admits only an exact, well-formed match: anything missing, malformed or moved is stale', () => {
  assert.equal(tenantAccessAdmitted('7', '7'), true, 'the version the session was admitted under');
  assert.equal(tenantAccessAdmitted('7', '8'), false, 'a suspension moved it');
  assert.equal(tenantAccessAdmitted('7', '9'), false, 'a suspension and a reactivation moved it twice');
  assert.equal(tenantAccessAdmitted('8', '7'), false, 'a version that went backwards is no match either');
  for (const [bound, current] of [
    [null, '7'], ['7', null], [undefined, '7'], ['7', undefined], [7, '7'], ['7', 7], ['', ''], ['', '7'], ['7', ''],
    [{}, '7'], [['7'], '7'], [true, '7'],
  ] as const) {
    assert.equal(tenantAccessAdmitted(bound, current), false, `bound ${String(bound)} / current ${String(current)}`);
  }
});

// --- the decision is the one the runtime actually applies ---------------------------------------------------

const membership = (over: Partial<TrustedMembership> = {}): TrustedMembership => Object.freeze({
  membershipId: MEMBERSHIP, scopeType: 'tenant', tenant: TENANT, store: null, roleId: 'store_owner',
  tenantStatus: 'active', storeStatus: null, ...over,
});
const principal = (m: TrustedMembership): TrustedPrincipal => Object.freeze({
  actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: 'sv1', memberships: Object.freeze([m]),
});

test('scope selection applies the one decision: a suspended or unrecognised tenant selects nothing, a read-only one selects a limited scope', () => {
  const select = (m: TrustedMembership, store: string | null = null) =>
    selectScope(principal(m), store === null ? 'tenant' : 'store', { tenant: TENANT, store });
  assert.equal(select(membership()).outcome, 'selected', 'an active tenant selects');
  assert.equal(select(membership({ tenantStatus: 'trialing' })).outcome, 'selected');
  // Denied outright — not selected and then limited, which a later check could forget.
  for (const tenantStatus of ['suspended', 'pending_activation', 'closed', 'provisioning']) {
    assert.equal(select(membership({ tenantStatus })).outcome, 'refused', `tenant ${JSON.stringify(tenantStatus)} selects nothing`);
  }
  // Read-only statuses still select, and carry the limitation the store refuses a write under.
  for (const tenantStatus of ['read_only', 'overdue']) {
    const selection = select(membership({ tenantStatus }));
    assert.equal(selection.outcome, 'selected', tenantStatus);
    assert.equal(selection.outcome === 'selected' && selection.scope.limitation, 'read_only', tenantStatus);
  }
  // A store inherits its tenant's restriction, and adds its own.
  const storeGrant = (tenantStatus: string, storeStatus: string): TrustedMembership =>
    membership({ scopeType: 'store', store: STORE, tenantStatus, storeStatus });
  assert.equal(select(storeGrant('active', 'suspended'), STORE).outcome, 'refused', 'a suspended store under an active tenant');
  assert.equal(select(storeGrant('suspended', 'active'), STORE).outcome, 'refused', 'an active store under a suspended tenant');
  const limited = select(storeGrant('read_only', 'active'), STORE);
  assert.equal(limited.outcome === 'selected' && limited.scope.limitation, 'read_only', 'a store under a read-only tenant is read-only');
  // A platform grant carries no status, so the decision never limits it.
  const platform = selectScope(
    principal(membership({ scopeType: 'platform', tenant: null, store: null, roleId: 'operations_admin', tenantStatus: null })),
    'platform', { tenant: null, store: null });
  assert.equal(platform.outcome, 'selected');
  assert.equal(platform.outcome === 'selected' && platform.scope.limitation, 'none');
});
