// Phase 4.0 M5-GAP11-P1-R1 — deny-by-default at the remaining shipped server entry points
// (docs/phase-4/04 §3 safeguard #4). permissionDecision.test.ts and protectedAction.test.ts cover the
// DEV decision spine; m5CanonicalPermissions.test.ts the route catalog; the gap11 suites the evidence
// evaluators. This suite covers everything else that accepts or derives a role, plane, feature,
// domain, action, level, status or explicit value on its way to an authorization answer:
//   * the catalog's comparators, read-only caps, feature-key normalization and materializers;
//   * the durable-state resolver that selects a role and a status disposition;
//   * the BCP pilot's action guard and the translation that builds its principal.
// Every denial is preceded by a control proving the same call answers for the canonical value.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSION_TOKENS,
  capPlatformLevelForReadOnly,
  capTenantLevelForReadOnly,
  isPermissionLevel,
  materializeCapabilities,
  materializePlatformPermissions,
  materializePlatformSubPermissions,
  materializeTenantPermissions,
  materializeTenantSubPermissions,
  meetsPlatformPermissionLevel,
  meetsTenantPermissionLevel,
  normalizeFeatureKey,
} from './permissionCatalog';
import {
  AUTHORIZATION_RESOLVER_REASON_CODES as RC,
  resolveAuthorization,
  type AuthorizationResolverInput,
  type MembershipSnapshot,
} from './authorizationResolver';
import { PERMISSION_LEVEL_VALUES } from './authorizationConstants';
import { BCP_CONTROLLED_ACTION_KEYS, authorizeBcpAction, type ActionGuardRequest } from '../bcp-pilot/bcpActionAuthorizationGuard';
import { BCP_ACTION_ACK_KEY } from '../bcp-pilot/bcpActionAcknowledgeReadinessReview';
import { PLATFORM_FEATURE_KEYS } from './permissionCatalog';
import { translateToBcpActionPrincipal, type CanonicalAuthzView } from '../bcp-pilot/bcpActionLivePrincipalResolver';

const NUL = String.fromCharCode(0);
const MALFORMED: readonly unknown[] = [
  'admin', '', 'FULL', 'Full', ' full', 'full ', `full${NUL}`, `full${String.fromCharCode(1)}`,
  undefined, null, 0, 6, true, {}, [], ['full'], () => 'full', 'constructor', '__proto__', 'toString', 'valueOf',
];

// =============================================================================
// permissionCatalog.ts — comparators, caps, normalization, materializers
// =============================================================================

test('catalog: isPermissionLevel admits exactly the seven tokens', () => {
  assert.deepEqual([...PERMISSION_TOKENS].sort(), [...PERMISSION_LEVEL_VALUES].sort());
  for (const l of PERMISSION_LEVEL_VALUES) assert.equal(isPermissionLevel(l), true, l);
  for (const v of MALFORMED) assert.equal(isPermissionLevel(v), false, String(v));
});

test('catalog: both comparators deny a malformed level on either side, including against `none`', () => {
  for (const good of PERMISSION_LEVEL_VALUES) {
    assert.equal(meetsTenantPermissionLevel(good, 'none'), true, `control: ${good} clears none`);
    assert.equal(meetsPlatformPermissionLevel(good, 'none'), true, `control: ${good} clears none`);
    for (const bad of MALFORMED) {
      assert.equal(meetsTenantPermissionLevel(good, bad as never), false, `tenant required ${String(bad)}`);
      assert.equal(meetsTenantPermissionLevel(bad as never, good), false, `tenant held ${String(bad)}`);
      assert.equal(meetsPlatformPermissionLevel(good, bad as never), false, `platform threshold ${String(bad)}`);
      assert.equal(meetsPlatformPermissionLevel(bad as never, good), false, `platform held ${String(bad)}`);
    }
  }
  // The two orderings are still the two documented ones.
  assert.equal(meetsTenantPermissionLevel('approve', 'manage'), true);
  assert.equal(meetsPlatformPermissionLevel('approve', 'manage'), false);
});

test('catalog: the read-only caps never turn an unknown level into a canonical one', () => {
  // Control: a write level caps to view, view and none stay.
  assert.equal(capTenantLevelForReadOnly('full'), 'view');
  assert.equal(capPlatformLevelForReadOnly('manage'), 'view');
  assert.equal(capTenantLevelForReadOnly('none'), 'none');
  for (const bad of MALFORMED) {
    const t = capTenantLevelForReadOnly(bad as never);
    const p = capPlatformLevelForReadOnly(bad as never);
    // Returned unchanged, so the comparison it reaches denies it — never `none` or `view`.
    assert.equal(Object.is(t, bad) && Object.is(p, bad), true, String(bad));
    assert.equal(meetsTenantPermissionLevel(t, 'none'), false);
    assert.equal(meetsPlatformPermissionLevel(p, 'none'), false);
  }
});

test('catalog: feature-key normalization follows declared aliases only, never an inherited name', () => {
  assert.equal(normalizeFeatureKey('supply_chain'), 'supply-chain', 'control: the declared alias');
  assert.equal(normalizeFeatureKey('refunds'), 'refunds');
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(normalizeFeatureKey(key), key, `${key} normalizes to itself, not to an Object member`);
  }
});

test('catalog: a limitation flag that is not a boolean materializes nothing — it is not "unlimited"', () => {
  assert.notDeepEqual(materializeTenantPermissions('manager', {}, false), {}, 'control');
  assert.notDeepEqual(materializePlatformPermissions('support_admin', false), {}, 'control');
  for (const limited of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
    assert.deepEqual(materializeTenantPermissions('manager', {}, limited as never), {}, `tenant ${String(limited)}`);
    assert.deepEqual(materializeTenantSubPermissions('manager', {}, limited as never), {}, `tenant subs ${String(limited)}`);
    assert.deepEqual(materializePlatformPermissions('support_admin', limited as never), {}, `platform ${String(limited)}`);
    assert.deepEqual(materializePlatformSubPermissions('support_admin', limited as never), {}, `platform subs ${String(limited)}`);
  }
});

test('catalog: an unknown role materializes nothing, and two roles for one decision are ambiguous', () => {
  for (const role of ['constructor', '__proto__', 'Manager', ' manager', '', 'platform_admin']) {
    assert.deepEqual(materializeTenantPermissions(role, {}, false), {}, role);
    assert.deepEqual(materializePlatformPermissions(role, false), {}, role);
  }
  const one = materializeCapabilities({ platformRoleId: 'support_admin', tenantRoleId: null, entitlements: {}, limited: false });
  assert.ok(Object.keys(one.permissions).length > 0, 'control: one role materializes');
  const both = materializeCapabilities({ platformRoleId: 'support_admin', tenantRoleId: 'manager', entitlements: {}, limited: false });
  assert.deepEqual(both, { permissions: {}, subPermissions: {} });
});

// =============================================================================
// authorizationResolver.ts — role, status, identity, ambiguity
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const STORE = '00000000-0000-4000-8000-0000000000bb';

function membership(over: Partial<MembershipSnapshot>): MembershipSnapshot {
  return {
    membership_id: 'm-1', internal_user_id: USER, tenant_id: null, store_id: null,
    scope_type: 'platform', role_id: 'support_admin', status: 'active', ...over,
  } as MembershipSnapshot;
}

function input(over: Partial<AuthorizationResolverInput> = {}): AuthorizationResolverInput {
  return {
    identity: { internalUserId: USER, authProvider: 'supabase', authProviderUid: 'uid', email: null },
    appUser: { internal_user_id: USER, status: 'active', display_name: null },
    memberships: [membership({})],
    tenant: null,
    store: null,
    entitlements: [],
    requestedContext: { scopeType: 'platform' },
    ...over,
  };
}

test('resolver: a role id outside the vocabulary is unresolvable — an inherited name included', () => {
  assert.equal(resolveAuthorization(input()).decision, 'allow', 'control');
  assert.equal(resolveAuthorization(input({ memberships: [membership({ role_id: 'platform_support' })] })).decision, 'allow',
    'control: a declared legacy id still resolves');
  for (const role_id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Support_Admin', ' support_admin', '']) {
    const r = resolveAuthorization(input({ memberships: [membership({ role_id })] }));
    assert.equal(r.decision, 'deny', role_id);
    assert.equal(r.reasonCode, RC.DENIED_UNRESOLVABLE_ROLE, role_id);
    assert.equal(r.authorization, null);
  }
  const tenantScope = input({
    memberships: [membership({ scope_type: 'tenant', tenant_id: TENANT, role_id: 'constructor' })],
    tenant: { tenant_id: TENANT, plan_key: 'growth', status: 'active' },
    requestedContext: { scopeType: 'tenant', tenantId: TENANT },
  });
  assert.equal(resolveAuthorization(tenantScope).reasonCode, RC.DENIED_UNRESOLVABLE_ROLE);
});

test('resolver: a status outside the vocabulary denies — it is never read as "active"', () => {
  for (const status of ['SUSPENDED', 'Suspended', ' suspended', 'deleted', 'disabled', '', undefined, null, 'constructor']) {
    const u = resolveAuthorization(input({ appUser: { internal_user_id: USER, status: status as never, display_name: null } }));
    assert.deepEqual({ decision: u.decision, reasonCode: u.reasonCode }, { decision: 'deny', reasonCode: RC.DENIED_ACCOUNT_STATUS_UNRECOGNIZED },
      `account ${String(status)}`);
    const tenant = input({
      memberships: [membership({ scope_type: 'tenant', tenant_id: TENANT, role_id: 'store_owner' })],
      tenant: { tenant_id: TENANT, plan_key: 'growth', status: status as never },
      requestedContext: { scopeType: 'tenant', tenantId: TENANT },
    });
    assert.equal(resolveAuthorization(tenant).reasonCode, RC.DENIED_TENANT_STATUS, `tenant ${String(status)}`);
    const store = input({
      memberships: [membership({ scope_type: 'store', tenant_id: TENANT, store_id: STORE, role_id: 'manager' })],
      tenant: { tenant_id: TENANT, plan_key: 'growth', status: 'active' },
      store: { store_id: STORE, tenant_id: TENANT, status: status as never },
      requestedContext: { scopeType: 'store', tenantId: TENANT, storeId: STORE },
    });
    assert.equal(resolveAuthorization(store).reasonCode, RC.DENIED_STORE_STATUS, `store ${String(status)}`);
  }
  // Controls: the canonical statuses keep their dispositions.
  assert.equal(resolveAuthorization(input({ appUser: { internal_user_id: USER, status: 'read_only', display_name: null } })).reasonCode,
    RC.RESOLVED_READ_ONLY);
  assert.equal(resolveAuthorization(input({ appUser: { internal_user_id: USER, status: 'suspended', display_name: null } })).reasonCode,
    RC.DENIED_ACCOUNT_SUSPENDED);
});

test('resolver: two active memberships at one scope are ambiguous, not a choice', () => {
  const two = input({ memberships: [membership({ membership_id: 'a', role_id: 'support_admin' }), membership({ membership_id: 'b', role_id: 'billing_admin' })] });
  assert.equal(resolveAuthorization(two).reasonCode, RC.DENIED_AMBIGUOUS_MEMBERSHIP);
  // Order does not matter: the old `find` would have picked whichever came first.
  const reversed = input({ memberships: [...two.memberships].reverse() });
  assert.equal(resolveAuthorization(reversed).reasonCode, RC.DENIED_AMBIGUOUS_MEMBERSHIP);
  // Control: one active plus one suspended is not ambiguous.
  const oneActive = input({ memberships: [membership({ membership_id: 'a' }), membership({ membership_id: 'b', role_id: 'billing_admin', status: 'suspended' })] });
  assert.equal(resolveAuthorization(oneActive).decision, 'allow');
  const tenantTwo = input({
    memberships: [
      membership({ membership_id: 'a', scope_type: 'tenant', tenant_id: TENANT, role_id: 'manager' }),
      membership({ membership_id: 'b', scope_type: 'tenant', tenant_id: TENANT, role_id: 'technician' }),
    ],
    tenant: { tenant_id: TENANT, plan_key: 'growth', status: 'active' },
    requestedContext: { scopeType: 'tenant', tenantId: TENANT },
  });
  assert.equal(resolveAuthorization(tenantTwo).reasonCode, RC.DENIED_AMBIGUOUS_MEMBERSHIP);
});

test('resolver: a missing identity id is no identity — `undefined === undefined` is not a match', () => {
  const r = resolveAuthorization(input({
    identity: { internalUserId: undefined as never, authProvider: 'supabase', authProviderUid: 'uid', email: null },
    appUser: { internal_user_id: undefined as never, status: 'active', display_name: null },
    memberships: [membership({ internal_user_id: undefined as never })],
  }));
  assert.deepEqual({ decision: r.decision, reasonCode: r.reasonCode }, { decision: 'deny', reasonCode: RC.DENIED_NO_APP_USER });
  assert.equal(resolveAuthorization(input({
    identity: { internalUserId: '', authProvider: 'supabase', authProviderUid: 'uid', email: null },
    appUser: { internal_user_id: '', status: 'active', display_name: null },
  })).reasonCode, RC.DENIED_NO_APP_USER);
});

// =============================================================================
// BCP pilot — the controlled-action guard and its principal translation
// =============================================================================

function guardRequest(over: Partial<ActionGuardRequest> = {}, principal: Record<string, unknown> = {}): ActionGuardRequest {
  return {
    actionKey: 'bcp.action.acknowledge_readiness_review',
    isDevEnvironment: true,
    featureEnabled: true,
    principal: {
      source: 'server_derived', internalUserId: USER, authProvider: 'firebase', verified: true,
      scopeType: 'platform', parityState: 'ready', visibilityClass: 'system_owner', ...principal,
    } as never,
    platformPermissionLevel: 'full',
    ...over,
  };
}

test('bcp guard: every boolean gate is `=== true` — a truthy non-boolean is not a yes', () => {
  assert.equal(authorizeBcpAction(guardRequest()).decision, 'allow', 'control');
  for (const v of ['false', 'true', 1, {}, [], 'yes']) {
    assert.equal(authorizeBcpAction(guardRequest({ isDevEnvironment: v as never })).reasonCode, 'production_forbidden', `dev ${String(v)}`);
    assert.equal(authorizeBcpAction(guardRequest({ featureEnabled: v as never })).reasonCode, 'feature_disabled', `flag ${String(v)}`);
    assert.equal(authorizeBcpAction(guardRequest({}, { verified: v })).reasonCode, 'unverified_principal', `verified ${String(v)}`);
  }
});

test('bcp guard: a controlled action is a platform action — any other or unknown plane is refused', () => {
  for (const scopeType of ['tenant', 'store', 'none', 'Platform', 'global', '', undefined]) {
    const r = authorizeBcpAction(guardRequest({}, { scopeType }));
    assert.deepEqual(r, { decision: 'deny', reasonCode: 'scope_mismatch' }, String(scopeType));
  }
});

test('bcp guard: an unknown permission level clears nothing, and the read-only cap does not rescue it', () => {
  for (const level of MALFORMED) {
    if (level === undefined || level === null) continue; // absent: its own 'insufficient_permission' path
    assert.equal(authorizeBcpAction(guardRequest({ platformPermissionLevel: level as never })).reasonCode, 'insufficient_permission', String(level));
  }
  assert.equal(authorizeBcpAction(guardRequest({ platformPermissionLevel: 'full', planReadOnly: true })).reasonCode, 'insufficient_permission',
    'control: read-only caps full to view, below the manage floor');
});

function authzView(over: Partial<CanonicalAuthzView> = {}): CanonicalAuthzView {
  return {
    decision: 'allow', reasonCode: 'resolved', limitation: 'none', platformRoleId: 'system_owner',
    permissions: Object.fromEntries(PLATFORM_FEATURE_KEYS.map((k) => [k, 'full'])), statusValues: ['active'], scopeType: 'platform', ...over,
  };
}

test('bcp translation: an unknown role is no class at all, and an array is not a permission map', () => {
  assert.equal(translateToBcpActionPrincipal(USER, authzView()).principal.visibilityClass, 'system_owner', 'control');
  assert.equal(translateToBcpActionPrincipal(USER, authzView({ platformRoleId: 'support_admin' })).principal.visibilityClass, 'overview_viewer',
    'control: a canonical platform role');
  for (const platformRoleId of ['constructor', 'platform_admin', 'System_Owner', 'manager', '']) {
    assert.equal(translateToBcpActionPrincipal(USER, authzView({ platformRoleId })).principal.visibilityClass, 'none', platformRoleId);
  }
  assert.equal(translateToBcpActionPrincipal(USER, authzView()).platformPermissionLevel, 'full', 'control');
  assert.equal(translateToBcpActionPrincipal(USER, authzView({ permissions: ['full'] as never })).platformPermissionLevel, null);
  assert.equal(translateToBcpActionPrincipal(USER, authzView({ permissions: { ...authzView().permissions, audit_security: 'FULL' } })).platformPermissionLevel, null);
  // A partial map, or one keyed outside the catalog, is not a floor over the catalog.
  assert.equal(translateToBcpActionPrincipal(USER, authzView({ permissions: { command_center: 'full' } })).platformPermissionLevel, null);
  assert.equal(translateToBcpActionPrincipal(USER, authzView({ permissions: { ...authzView().permissions, bogus: 'full' } })).platformPermissionLevel, null);
  // The ambiguity denial is an unresolved parity, like the other "could not be established" codes.
  assert.equal(translateToBcpActionPrincipal(USER, authzView({ decision: 'deny', reasonCode: RC.DENIED_AMBIGUOUS_MEMBERSHIP })).principal.parityState,
    'unresolved');
});

test('bcp guard: only a declared controlled action is authorized, and each request field is read once', () => {
  assert.ok(BCP_CONTROLLED_ACTION_KEYS.includes(BCP_ACTION_ACK_KEY), 'the shipped action key is declared');
  for (const actionKey of ['not.a.real.action', 'BCP.ACTION.ACKNOWLEDGE_READINESS_REVIEW', ' bcp.action.acknowledge_readiness_review', '', 'constructor', undefined]) {
    assert.deepEqual(authorizeBcpAction(guardRequest({ actionKey: actionKey as never })), { decision: 'deny', reasonCode: 'unknown_action' }, String(actionKey));
  }
  let reads = 0;
  const shifting = guardRequest();
  Object.defineProperty(shifting, 'platformPermissionLevel', { get() { reads += 1; return reads === 1 ? 'garbage' : 'full'; } });
  assert.equal(authorizeBcpAction(shifting).reasonCode, 'insufficient_permission', 'the level as first read decides');
  assert.equal(reads, 1);
  const throwing = Object.defineProperty(guardRequest(), 'principal', { get() { throw new Error('trap'); } });
  assert.equal(authorizeBcpAction(throwing).decision, 'deny');
});

test('bcp guard: a malformed plan flag restricts — only exactly false or absent lifts the cap', () => {
  assert.equal(authorizeBcpAction(guardRequest({ planReadOnly: false, planOverdue: false })).decision, 'allow', 'control');
  for (const v of [0, '', 'false', null, 'no', {}]) {
    assert.equal(authorizeBcpAction(guardRequest({ planReadOnly: v as never })).reasonCode, 'insufficient_permission', `planReadOnly ${String(v)}`);
    assert.equal(authorizeBcpAction(guardRequest({ planOverdue: v as never })).reasonCode, 'insufficient_permission', `planOverdue ${String(v)}`);
  }
});

test('bcp translation: only a resolved allow over known statuses is ready; an unknown limitation caps', () => {
  assert.equal(translateToBcpActionPrincipal(USER, authzView()).principal.parityState, 'ready', 'control');
  assert.equal(translateToBcpActionPrincipal(USER, authzView({ reasonCode: 'resolved_read_only', limitation: 'read_only' })).principal.parityState, 'ready');
  // Preservation: every status an allow can carry (the written vocabulary minus the two that deny before any role).
  for (const s of ['active', 'trialing', 'overdue', 'read_only']) {
    assert.equal(translateToBcpActionPrincipal(USER, authzView({ statusValues: [s, s, s] })).principal.parityState, 'ready', s);
  }
  for (const over of [{ reasonCode: 'something_else' }, { statusValues: [] }, { statusValues: ['suspended'] }, { statusValues: ['Active'] },
    { statusValues: 'active' as never }, { statusValues: ['active', 7 as never] }]) {
    assert.equal(translateToBcpActionPrincipal(USER, authzView(over)).principal.parityState, 'blocked', JSON.stringify(over));
  }
  assert.equal(translateToBcpActionPrincipal(USER, authzView()).planReadOnly, false, 'control: exactly none is unlimited');
  for (const limitation of ['bogus', 'READ_ONLY', '', undefined, 'read_only']) {
    assert.equal(translateToBcpActionPrincipal(USER, authzView({ limitation: limitation as never })).planReadOnly, true, String(limitation));
  }
});

test('resolver: each status and the identity id are read once — a getter cannot pass the check and differ in use', () => {
  let reads = 0;
  const appUser = { internal_user_id: USER, display_name: null, get status() { reads += 1; return reads === 1 ? 'active' : 'suspended'; } };
  const r = resolveAuthorization(input({ appUser: appUser as never }));
  assert.equal(reads, 1);
  assert.equal(r.decision, 'allow');
  assert.equal(r.authorization?.status.user, 'active', 'the status used is the status checked');
});

test('resolver: two active store memberships at one store are ambiguous', () => {
  const store = input({
    memberships: [
      membership({ membership_id: 'a', scope_type: 'store', tenant_id: TENANT, store_id: STORE, role_id: 'manager' }),
      membership({ membership_id: 'b', scope_type: 'store', tenant_id: TENANT, store_id: STORE, role_id: 'sales_staff' }),
    ],
    tenant: { tenant_id: TENANT, plan_key: 'growth', status: 'active' },
    store: { store_id: STORE, tenant_id: TENANT, status: 'active' },
    requestedContext: { scopeType: 'store', tenantId: TENANT, storeId: STORE },
  });
  assert.equal(resolveAuthorization(store).reasonCode, RC.DENIED_AMBIGUOUS_MEMBERSHIP);
  assert.equal(resolveAuthorization({ ...store, memberships: [store.memberships[0]] }).decision, 'allow', 'control: one active store membership');
});
