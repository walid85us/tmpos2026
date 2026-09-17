// Phase 4.0 M5-ID-P1 — server-derived scope selection: a selector narrows, it never grants.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isTrustedPrincipal, isTrustedScope, selectScope } from './principals.js';
import type { AuthorizationScope } from './routes.js';
import type { ScopeSelector, TrustedMembership, TrustedPrincipal, TrustedScope } from './principals.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const STORE_A = '44444444-4444-4444-8444-444444444444';
const VERSION = 'a'.repeat(64);

let nextId = 0;
const grant = (over: Partial<TrustedMembership>): TrustedMembership => Object.freeze({
  membershipId: `55555555-5555-4555-8555-${String(++nextId).padStart(12, '0')}`,
  scopeType: 'platform' as AuthorizationScope, tenant: null, store: null, roleId: 'system_owner',
  tenantStatus: null, storeStatus: null, ...over,
});

const principal = (memberships: readonly TrustedMembership[], over: Partial<TrustedPrincipal> = {}): TrustedPrincipal =>
  Object.freeze({ actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: VERSION, memberships, ...over });

const PLATFORM = grant({});
const TENANT = grant({ scopeType: 'tenant', tenant: TENANT_A, roleId: 'manager', tenantStatus: 'active' });
const STORE = grant({ scopeType: 'store', tenant: TENANT_A, store: STORE_A, roleId: 'technician', tenantStatus: 'active', storeStatus: 'active' });

test('a request acts only under a grant the database already recorded, at exactly the route\'s scope', () => {
  const p = principal([PLATFORM, TENANT, STORE]);

  const platform = selectScope(p, 'platform', { tenant: null, store: null });
  assert.equal(platform.outcome, 'selected');
  assert.deepEqual(platform.outcome === 'selected' ? platform.scope : null, {
    actor: ACTOR, securityVersion: VERSION, scope: 'platform', tenant: null, store: null,
    roleId: 'system_owner', limitation: 'none',
  });

  const tenant = selectScope(p, 'tenant', { tenant: TENANT_A, store: null });
  assert.equal(tenant.outcome === 'selected' && tenant.scope.roleId, 'manager');

  const store = selectScope(p, 'store', { tenant: TENANT_A, store: STORE_A });
  assert.equal(store.outcome === 'selected' && store.scope.roleId, 'technician');
});

test('a selector that names something the actor does not hold is refused, whatever it names', () => {
  const p = principal([PLATFORM, TENANT, STORE]);
  const cases: [string, AuthorizationScope, ScopeSelector][] = [
    ['a tenant with no grant', 'tenant', { tenant: TENANT_B, store: null }],
    ['a store under the wrong tenant', 'store', { tenant: TENANT_B, store: STORE_A }],
    ['a store the actor does not hold', 'store', { tenant: TENANT_A, store: TENANT_B }],
    ['a tenant selector on a platform route', 'platform', { tenant: TENANT_A, store: null }],
    ['no tenant selector on a tenant route', 'tenant', { tenant: null, store: null }],
    ['a store selector on a tenant route', 'tenant', { tenant: TENANT_A, store: STORE_A }],
    ['no store selector on a store route', 'store', { tenant: TENANT_A, store: null }],
    ['a malformed tenant id', 'tenant', { tenant: 'not-a-uuid', store: null }],
  ];
  for (const [label, required, selector] of cases) {
    assert.deepEqual(selectScope(p, required, selector), { outcome: 'refused' }, label);
  }
});

test('an actor with no grant at the required scope never falls back to a scope it does hold', () => {
  // Holding platform authority must not answer a tenant route, and holding a tenant must not answer
  // a platform one: a missing selector is never read as "the platform".
  assert.deepEqual(selectScope(principal([PLATFORM]), 'tenant', { tenant: TENANT_A, store: null }), { outcome: 'refused' });
  assert.deepEqual(selectScope(principal([TENANT]), 'platform', { tenant: null, store: null }), { outcome: 'refused' });
  assert.deepEqual(selectScope(principal([TENANT]), 'store', { tenant: TENANT_A, store: STORE_A }), { outcome: 'refused' });
});

test('two grants at one scope tuple are ambiguous, and no default is invented', () => {
  // The documents fix where scope comes from and never say which of several to prefer, so neither
  // does this: an ambiguous selection is refused exactly like an absent one.
  const twice = principal([
    grant({ scopeType: 'tenant', tenant: TENANT_A, roleId: 'manager', tenantStatus: 'active' }),
    grant({ scopeType: 'tenant', tenant: TENANT_A, roleId: 'store_owner', tenantStatus: 'active' }),
  ]);
  assert.deepEqual(selectScope(twice, 'tenant', { tenant: TENANT_A, store: null }), { outcome: 'refused' });
});

test('read-only limiting takes the widest of the account, the tenant and the store', () => {
  const cases: [string, Partial<TrustedPrincipal>, Partial<TrustedMembership>, 'none' | 'read_only'][] = [
    ['nothing limited', {}, {}, 'none'],
    ['a read_only account', { limitation: 'read_only' }, {}, 'read_only'],
    ['an overdue tenant', {}, { tenantStatus: 'overdue' }, 'read_only'],
    ['a read_only tenant', {}, { tenantStatus: 'read_only' }, 'read_only'],
    ['a read_only store', {}, { storeStatus: 'read_only' }, 'read_only'],
  ];
  for (const [label, overPrincipal, overGrant, expected] of cases) {
    const g = grant({
      scopeType: 'store', tenant: TENANT_A, store: STORE_A, roleId: 'technician',
      tenantStatus: 'active', storeStatus: 'active', ...overGrant,
    });
    const selection = selectScope(principal([g], overPrincipal), 'store', { tenant: TENANT_A, store: STORE_A });
    assert.equal(selection.outcome === 'selected' && selection.scope.limitation, expected, label);
  }
});

test('a principal the resolver could not have produced is not a principal', () => {
  const good = principal([PLATFORM]);
  assert.equal(isTrustedPrincipal(good), true);
  const broken: unknown[] = [
    null, 'principal', { ...good, actor: 'not-a-uuid' }, { ...good, securityVersion: '' },
    { ...good, securityVersion: 'has space' }, { ...good, securityVersion: 'x'.repeat(129) },
    { ...good, limitation: 'partial' }, { ...good, accountStatus: 'Active' },
    { ...good, memberships: 'none' },
    // A platform grant may not carry a scope id, a tenant grant may not carry a store, and a store
    // grant needs both — migration 002's own scope-consistency CHECK, re-read at the boundary.
    { ...good, memberships: [grant({ tenant: TENANT_A })] },
    { ...good, memberships: [grant({ scopeType: 'tenant', tenant: TENANT_A, store: STORE_A })] },
    { ...good, memberships: [grant({ scopeType: 'store', tenant: TENANT_A })] },
    { ...good, memberships: [grant({ scopeType: 'everything' as never })] },
    // Two grants sharing one id are one row read twice; the boundary refuses the whole principal.
    { ...good, memberships: [PLATFORM, PLATFORM] },
  ];
  for (const value of broken) assert.equal(isTrustedPrincipal(value), false, String(JSON.stringify(value)).slice(0, 80));
  // A principal that is not one cannot be narrowed into a scope either.
  assert.deepEqual(
    selectScope({ ...good, actor: 'nope' } as TrustedPrincipal, 'platform', { tenant: null, store: null }),
    { outcome: 'refused' },
  );
});

test('a scope the store is asked to revalidate must be one selection could have produced', () => {
  const selected = selectScope(principal([STORE]), 'store', { tenant: TENANT_A, store: STORE_A });
  assert.equal(selected.outcome, 'selected');
  const scope = (selected.outcome === 'selected' ? selected.scope : null) as TrustedScope;
  assert.equal(isTrustedScope(scope), true);
  for (const broken of [
    null, { ...scope, actor: 'x' }, { ...scope, securityVersion: 'has space' },
    { ...scope, scope: 'platform' }, // a platform scope may not carry ids
    { ...scope, store: null }, //      a store scope must carry both
    { ...scope, roleId: 'Technician' },
    { ...scope, limitation: 'partial' },
  ]) assert.equal(isTrustedScope(broken), false, String(JSON.stringify(broken)).slice(0, 80));
});
