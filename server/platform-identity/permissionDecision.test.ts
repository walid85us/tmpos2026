// Phase 4.0 M5-GAP11-P1-R1 — the DEV control plane's permission decision (docs/phase-4/04 §3 safeguard #4).
//
// Two things are proved here, and they pull in opposite directions, so each has its own oracle:
//   1. DENY-BY-DEFAULT. Every role, feature, domain, sub-permission, level and explicit grant the
//      catalog does not declare is a denial — wrong case, padding, NUL and control characters,
//      non-strings, inherited names, all of it. The expectations are written out here, not read back.
//   2. NOTHING VALID MOVED. For every canonical input the new decision equals the old one. The oracle
//      is the pre-R1 algorithm itself, copied verbatim below from the commit it replaced, so "same as
//      before" is checked against what before actually was.
// And a positive defect control: the harness that proves (1) is run against the pre-R1 comparator and
// must catch it — an unknown REQUIRED level ranked as `none` is exactly the defect R1 closes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  meetsPermissionLevel,
  platformPermissionMeets,
  requirePlatformPermission,
  requireSubPermission,
  requireTenantPermission,
  type DecisionResult,
  type SubPermissionContext,
} from './permissionDecision';
import {
  PLATFORM_FEATURE_KEYS,
  TENANT_PERMISSION_DOMAINS,
  TENANT_SUB_PERMISSIONS,
  materializePlatformPermissions,
  materializeTenantPermissions,
  materializeTenantSubPermissions,
} from './permissionCatalog';
import { PERMISSION_LEVEL_VALUES, PLATFORM_ROLE_IDS, TENANT_ROLE_IDS } from './authorizationConstants';
import type { PermissionLevel, PermissionSnapshot, RequestContext, ScopeType } from './requestContext';

// =============================================================================
// Fixtures
// =============================================================================

/** The orderings, written out from docs/phase-4/04 §3 — never imported from the code under test. */
const TENANT_WRITTEN = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'] as const;
const PLATFORM_WRITTEN = ['none', 'view', 'create', 'edit', 'approve', 'manage', 'full'] as const;

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

/** Every class of non-canonical level value a JavaScript caller can hand over. */
const MALFORMED_LEVELS: readonly (readonly [string, unknown])[] = [
  ['unknown token', 'admin'],
  ['empty string', ''],
  ['wrong case', 'VIEW'],
  ['title case', 'View'],
  ['leading space', ' view'],
  ['trailing space', 'view '],
  ['tab', 'view\t'],
  ['NUL', `view${NUL}`],
  ['control character', `view${SOH}`],
  ['undefined', undefined],
  ['null', null],
  ['zero', 0],
  ['number', 5],
  ['boolean', true],
  ['object', {}],
  ['empty array', []],
  ['array holding a level', ['view']],
  ['function', () => 'view'],
  ['symbol', Symbol('view')],
  ['constructor', 'constructor'],
  ['__proto__', '__proto__'],
  ['toString', 'toString'],
  ['hasOwnProperty', 'hasOwnProperty'],
  ['valueOf', 'valueOf'],
];

/** Non-canonical names for a role, feature, domain or sub-permission. */
const MALFORMED_NAMES: readonly (readonly [string, unknown])[] = [
  ['unknown', 'not_in_the_catalog'],
  ['empty', ''],
  ['wrong case', 'Team_Management'],
  ['padded', ' team_management'],
  ['NUL', `team_management${NUL}`],
  ['control', `team_management${SOH}`],
  ['constructor', 'constructor'],
  ['__proto__', '__proto__'],
  ['toString', 'toString'],
  ['undefined', undefined],
  ['null', null],
  ['number', 7],
  ['array', ['team_management']],
  ['object', {}],
];

function ctx(
  scopeType: ScopeType,
  snapshot: Partial<PermissionSnapshot> | null,
  opts: { tenantId?: string | null; authState?: RequestContext['authState'] } = {},
): RequestContext {
  const tenantId = opts.tenantId === undefined ? (scopeType === 'platform' ? null : 'tenant-1') : opts.tenantId;
  return {
    requestId: 'req-1',
    source: 'dev-diagnostic',
    environment: 'dev',
    authState: opts.authState ?? 'dev-asserted',
    actor: { internalUserId: null, authProvider: 'firebase', authProviderUid: 'dev', email: null, actorType: 'dev_actor' },
    scope: { scopeType, tenantId, storeId: scopeType === 'store' ? 'store-1' : null, platformScope: scopeType === 'platform' },
    permissionSnapshot: snapshot === null ? null : {
      source: 'dev_asserted_snapshot', platformRoleId: null, tenantRoleId: null, permissions: {}, subPermissions: {},
      ...snapshot,
    } as PermissionSnapshot,
    identityResolution: 'skipped_config_incomplete',
  };
}

const subDefOf = (id: string, planAvailable = true): SubPermissionContext => {
  const def = TENANT_SUB_PERMISSIONS.find((s) => s.id === id)!;
  return { parentDomain: def.parentDomain, minModuleLevel: def.minModuleLevel, defaultLevel: def.defaultLevel, planAvailable };
};

// =============================================================================
// The pre-R1 algorithm, verbatim (b61612d9:server/platform-identity/permissionDecision.ts) — the
// preservation oracle. Its only use is to say what the answer WAS for an input.
// =============================================================================

const LEGACY_TENANT: PermissionLevel[] = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
const LEGACY_PLATFORM: PermissionLevel[] = ['none', 'view', 'create', 'edit', 'approve', 'manage', 'full'];
function legacyLevelIndex(order: PermissionLevel[], level: string | undefined | null): number {
  const idx = order.indexOf((level ?? 'none') as PermissionLevel);
  return idx < 0 ? 0 : idx; // unknown level ⇒ treated as 'none'
}
const legacyMeets = (actual: string, required: PermissionLevel): boolean =>
  legacyLevelIndex(LEGACY_TENANT, actual) >= legacyLevelIndex(LEGACY_TENANT, required);
const legacyPlatformMeets = (actual: string, threshold: PermissionLevel): boolean =>
  legacyLevelIndex(LEGACY_PLATFORM, actual) >= legacyLevelIndex(LEGACY_PLATFORM, threshold);
const legacyAuthenticated = (c: RequestContext): boolean => c.authState === 'dev-asserted' && !!c.permissionSnapshot;
const d = (decision: 'allow' | 'deny', reasonCode: string) => ({ decision, reasonCode });

function legacyPlatform(c: RequestContext, featureKey: string, threshold: PermissionLevel) {
  if (!legacyAuthenticated(c)) return d('deny', 'denied_unauthenticated');
  if (c.scope.scopeType !== 'platform' || !c.scope.platformScope) return d('deny', 'denied_scope_mismatch');
  const snap = c.permissionSnapshot!;
  if (snap.platformRoleId === 'system_owner') return d('allow', 'allowed_system_owner');
  const actual = snap.permissions[featureKey] ?? 'none';
  return legacyPlatformMeets(actual, threshold) ? d('allow', 'allowed_permission_met') : d('deny', 'denied_missing_permission');
}
function legacyTenant(c: RequestContext, domain: string, level: PermissionLevel) {
  if (!legacyAuthenticated(c)) return d('deny', 'denied_unauthenticated');
  if (c.scope.scopeType !== 'tenant' && c.scope.scopeType !== 'store') return d('deny', 'denied_scope_mismatch');
  if (!c.scope.tenantId) return d('deny', 'denied_missing_tenant');
  const snap = c.permissionSnapshot!;
  if (snap.tenantRoleId === 'store_owner') return d('allow', 'allowed_store_owner');
  const actual = snap.permissions[domain] ?? 'none';
  return legacyMeets(actual, level) ? d('allow', 'allowed_permission_met') : d('deny', 'denied_missing_permission');
}
function legacySub(c: RequestContext, id: string, sub: SubPermissionContext) {
  if (!legacyAuthenticated(c)) return d('deny', 'denied_unauthenticated');
  if (c.scope.scopeType !== 'tenant' && c.scope.scopeType !== 'store') return d('deny', 'denied_scope_mismatch');
  if (!c.scope.tenantId) return d('deny', 'denied_missing_tenant');
  const snap = c.permissionSnapshot!;
  if (!sub.planAvailable) return d('deny', 'denied_plan_locked');
  if (snap.platformRoleId === 'system_owner' || snap.tenantRoleId === 'store_owner') return d('allow', 'allowed_owner');
  const parentLevel = snap.permissions[sub.parentDomain] ?? 'none';
  if (!legacyMeets(parentLevel, sub.minModuleLevel)) return d('deny', 'denied_parent_level');
  if (Object.prototype.hasOwnProperty.call(snap.subPermissions, id)) {
    return snap.subPermissions[id] ? d('allow', 'allowed_explicit_grant') : d('deny', 'denied_explicit_revoke');
  }
  return legacyMeets(parentLevel, sub.defaultLevel) ? d('allow', 'allowed_default') : d('deny', 'denied_default');
}

const pick = (r: DecisionResult) => ({ decision: r.decision, reasonCode: r.reasonCode });

// =============================================================================
// The comparisons
// =============================================================================

test('the tenant comparison is the documented ordering — all 49 pairs pinned', () => {
  for (const [ai, actual] of TENANT_WRITTEN.entries()) {
    for (const [ri, required] of TENANT_WRITTEN.entries()) {
      assert.equal(meetsPermissionLevel(actual, required), ai >= ri, `${actual} vs ${required}`);
    }
  }
  // The two pairs that distinguish the tenant ordering from the platform one.
  assert.equal(meetsPermissionLevel('approve', 'manage'), true);
  assert.equal(meetsPermissionLevel('manage', 'approve'), false);
});

test('the platform comparison is the documented ordering — all 49 pairs pinned', () => {
  for (const [ai, actual] of PLATFORM_WRITTEN.entries()) {
    for (const [ti, threshold] of PLATFORM_WRITTEN.entries()) {
      assert.equal(platformPermissionMeets(actual, threshold), ai >= ti, `${actual} vs ${threshold}`);
    }
  }
  assert.equal(platformPermissionMeets('manage', 'approve'), true);
  assert.equal(platformPermissionMeets('approve', 'manage'), false);
});

/**
 * Every (held, required) pair where one side is malformed and the comparison nonetheless passes. The
 * harness returns violations rather than asserting, so it can be pointed at a known-bad comparator.
 */
function levelViolations(meets: (a: string, r: PermissionLevel) => boolean): string[] {
  const out: string[] = [];
  for (const [why, bad] of MALFORMED_LEVELS) {
    for (const good of PERMISSION_LEVEL_VALUES) {
      if (meets(good, bad as PermissionLevel)) out.push(`required ${why} cleared by ${good}`);
      if (meets(bad as string, good)) out.push(`held ${why} clears ${good}`);
    }
    if (meets(bad as string, bad as PermissionLevel)) out.push(`${why} clears itself`);
  }
  return out;
}

test('an unknown or malformed level denies on either side — even against a `none` requirement', () => {
  assert.deepEqual(levelViolations(meetsPermissionLevel), []);
  assert.deepEqual(levelViolations(platformPermissionMeets), []);
  // And a canonical holder still clears `none`: the rule rejects vocabulary, not the lowest level.
  for (const l of PERMISSION_LEVEL_VALUES) {
    assert.equal(meetsPermissionLevel(l, 'none'), true, l);
    assert.equal(platformPermissionMeets(l, 'none'), true, l);
  }
});

test('control: the harness catches the pre-R1 comparators, which ranked an unknown level as `none`', () => {
  const tenant = levelViolations(legacyMeets);
  const platform = levelViolations(legacyPlatformMeets);
  // Mapping an unknown REQUIRED level to `none` lets every holder clear it: the harness must say so.
  assert.ok(tenant.includes('required unknown token cleared by none'), tenant.slice(0, 5).join('; '));
  assert.ok(tenant.includes('required NUL cleared by full'));
  assert.ok(platform.includes('required undefined cleared by view'));
  assert.ok(tenant.length > 0 && platform.length > 0);
});

// =============================================================================
// requirePlatformPermission
// =============================================================================

test('platform: every canonical decision is unchanged from before R1', () => {
  let n = 0;
  for (const role of PLATFORM_ROLE_IDS) {
    const maps: Record<string, string>[] = [materializePlatformPermissions(role, false), materializePlatformPermissions(role, true), {}];
    for (const f of PLATFORM_FEATURE_KEYS) for (const l of PERMISSION_LEVEL_VALUES) maps.push({ [f]: l });
    for (const permissions of maps) {
      const c = ctx('platform', { platformRoleId: role, permissions });
      for (const feature of PLATFORM_FEATURE_KEYS) {
        for (const level of PERMISSION_LEVEL_VALUES) {
          assert.deepEqual(pick(requirePlatformPermission(c, feature, level)), legacyPlatform(c, feature, level),
            `${role} ${feature}:${level} over ${JSON.stringify(permissions)}`);
          n += 1;
        }
      }
    }
  }
  assert.equal(n, 5 * 80 * 11 * 7);
});

test('platform: an unknown feature or threshold is refused — before the owner short-circuit', () => {
  const owner = ctx('platform', { platformRoleId: 'system_owner' });
  assert.equal(requirePlatformPermission(owner, 'team_management', 'full').decision, 'allow', 'control: the owner is allowed');
  for (const [why, feature] of MALFORMED_NAMES) {
    const r = requirePlatformPermission(owner, feature as string, 'view');
    assert.deepEqual(pick(r), { decision: 'deny', reasonCode: 'denied_invalid_requirement' }, `feature ${why}`);
  }
  for (const [why, level] of MALFORMED_LEVELS) {
    const r = requirePlatformPermission(owner, 'team_management', level as PermissionLevel);
    assert.deepEqual(pick(r), { decision: 'deny', reasonCode: 'denied_invalid_requirement' }, `threshold ${why}`);
  }
  // A tenant domain is not a platform feature.
  assert.equal(requirePlatformPermission(owner, 'sales', 'view').reasonCode, 'denied_invalid_requirement');
});

test('platform: the gap R1 closes — an unknown threshold was an allowance, it is now a denial', () => {
  const empty = ctx('platform', { platformRoleId: 'support_admin', permissions: {} });
  assert.deepEqual(legacyPlatform(empty, 'team_management', 'FULL' as PermissionLevel), d('allow', 'allowed_permission_met'),
    'the pre-R1 decision allowed a holder of nothing');
  assert.equal(requirePlatformPermission(empty, 'team_management', 'FULL' as PermissionLevel).decision, 'deny');
  // The same holder against the real lowest level: the unknown one is not treated as `none`.
  assert.equal(requirePlatformPermission(empty, 'team_management', 'none').decision, 'allow');
});

test('platform: an unknown, missing or misplaced role denies; a malformed held level denies', () => {
  const base = { permissions: { team_management: 'full' } };
  assert.equal(requirePlatformPermission(ctx('platform', { ...base, platformRoleId: 'support_admin' }), 'team_management', 'view').decision,
    'allow', 'control: a known role holding the level is allowed');
  for (const [why, role] of MALFORMED_NAMES) {
    if (role === null) continue; // null is "no role", covered below
    const r = requirePlatformPermission(ctx('platform', { ...base, platformRoleId: role as string }), 'team_management', 'view');
    assert.deepEqual(pick(r), { decision: 'deny', reasonCode: 'denied_unknown_role' }, `role ${why}`);
  }
  for (const role of ['System_Owner', ' system_owner', 'manager', 'store_owner']) {
    assert.equal(requirePlatformPermission(ctx('platform', { ...base, platformRoleId: role }), 'team_management', 'view').decision, 'deny', role);
  }
  assert.equal(requirePlatformPermission(ctx('platform', { ...base, platformRoleId: null }), 'team_management', 'view').reasonCode,
    'denied_unknown_role', 'a platform action needs a platform role');
  assert.equal(requirePlatformPermission(ctx('platform', { ...base, platformRoleId: 'support_admin', tenantRoleId: 'bogus' }),
    'team_management', 'view').reasonCode, 'denied_unknown_role', 'an unknown role in either slot denies');
  for (const [why, held] of MALFORMED_LEVELS) {
    const c = ctx('platform', { platformRoleId: 'support_admin', permissions: { team_management: held as string } });
    for (const level of PERMISSION_LEVEL_VALUES) {
      assert.equal(requirePlatformPermission(c, 'team_management', level).decision, 'deny', `held ${why} vs ${level}`);
    }
  }
});

test('platform: a malformed snapshot map denies, and an inherited key is not a held level', () => {
  for (const [why, permissions] of [['null', null], ['array', []], ['string', 'full'], ['number', 1]] as const) {
    const c = ctx('platform', { platformRoleId: 'support_admin', permissions: permissions as never });
    assert.deepEqual(pick(requirePlatformPermission(c, 'team_management', 'none')),
      { decision: 'deny', reasonCode: 'denied_malformed_snapshot' }, why);
  }
  const c = ctx('platform', { platformRoleId: 'support_admin', subPermissions: null as never });
  assert.equal(requirePlatformPermission(c, 'team_management', 'none').reasonCode, 'denied_malformed_snapshot');
  // An entry that exists only on the prototype chain is no entry: absent means `none`, not a level.
  const inherited = Object.create({ team_management: 'full' }) as Record<string, string>;
  const r = requirePlatformPermission(ctx('platform', { platformRoleId: 'support_admin', permissions: inherited }), 'team_management', 'view');
  assert.equal(r.decision, 'deny');
});

test('platform: an unauthenticated or out-of-scope request is refused as before', () => {
  const snap = { platformRoleId: 'system_owner' };
  assert.equal(requirePlatformPermission(ctx('platform', null), 'team_management', 'view').reasonCode, 'denied_unauthenticated');
  assert.equal(requirePlatformPermission(ctx('platform', snap, { authState: 'authenticated' }), 'team_management', 'view').reasonCode,
    'denied_unauthenticated');
  assert.equal(requirePlatformPermission(ctx('tenant', snap), 'team_management', 'view').reasonCode, 'denied_scope_mismatch');
});

test('a refusal never echoes the value it refused', () => {
  const owner = ctx('platform', { platformRoleId: 'system_owner' });
  const marker = 'victim@example.com';
  for (const r of [
    requirePlatformPermission(owner, marker, 'view'),
    requirePlatformPermission(owner, 'team_management', marker as PermissionLevel),
    requirePlatformPermission(ctx('platform', { platformRoleId: marker }), 'team_management', 'view'),
    requireTenantPermission(ctx('tenant', { tenantRoleId: 'manager' }), marker, 'view'),
    requireSubPermission(ctx('tenant', { tenantRoleId: 'manager' }), marker, subDefOf('approve_refunds')),
  ]) {
    assert.equal(r.decision, 'deny');
    assert.ok(!r.humanReadableReason.includes(marker), r.humanReadableReason);
  }
  // A symbol cannot even be interpolated; the refusal must not try.
  assert.doesNotThrow(() => requirePlatformPermission(owner, 'team_management', Symbol('x') as never));
});

// =============================================================================
// requireTenantPermission
// =============================================================================

const FULL_TENANT_ENTITLEMENTS: Record<string, boolean> = Object.fromEntries([
  'repairs', 'inventory', 'employees', 'warranties', 'refunds', 'services', 'reports', 'prospects', 'marketing',
  'suggestive_sales', 'settings', 'supply-chain', 'integrations', 'widgets', 'shipping', 'returns',
  'shipping_providers', 'shipping_automation_rules', 'batch_labels', 'packing_workflows', 'pickup_requests',
  'service_points', 'carrier_analytics', 'carrier_scorecards', 'shipping_sla_optimization',
].map((k) => [k, true]));

test('tenant: every canonical decision is unchanged from before R1', () => {
  let n = 0;
  for (const role of TENANT_ROLE_IDS) {
    const maps: Record<string, string>[] = [
      materializeTenantPermissions(role, FULL_TENANT_ENTITLEMENTS, false), materializeTenantPermissions(role, {}, true), {},
    ];
    for (const dm of TENANT_PERMISSION_DOMAINS) for (const l of PERMISSION_LEVEL_VALUES) maps.push({ [dm]: l });
    for (const permissions of maps) {
      for (const scope of ['tenant', 'store'] as const) {
        const c = ctx(scope, { tenantRoleId: role, permissions });
        for (const domain of TENANT_PERMISSION_DOMAINS) {
          for (const level of PERMISSION_LEVEL_VALUES) {
            assert.deepEqual(pick(requireTenantPermission(c, domain, level)), legacyTenant(c, domain, level),
              `${scope} ${role} ${domain}:${level}`);
            n += 1;
          }
        }
      }
    }
  }
  assert.equal(n, 4 * (3 + 21 * 7) * 2 * 21 * 7);
});

test('tenant: unknown domains, levels and roles deny — the store owner included', () => {
  const owner = ctx('tenant', { tenantRoleId: 'store_owner' });
  assert.equal(requireTenantPermission(owner, 'refunds', 'full').decision, 'allow', 'control');
  for (const [why, domain] of MALFORMED_NAMES) {
    assert.equal(requireTenantPermission(owner, domain as string, 'view').reasonCode, 'denied_invalid_requirement', `domain ${why}`);
  }
  for (const [why, level] of MALFORMED_LEVELS) {
    assert.equal(requireTenantPermission(owner, 'refunds', level as PermissionLevel).reasonCode, 'denied_invalid_requirement', `level ${why}`);
  }
  assert.equal(requireTenantPermission(owner, 'team_management', 'view').reasonCode, 'denied_invalid_requirement',
    'a platform feature is not a tenant domain');
  for (const [why, role] of MALFORMED_NAMES) {
    if (role === null) continue;
    assert.equal(requireTenantPermission(ctx('tenant', { tenantRoleId: role as string, permissions: { refunds: 'full' } }), 'refunds', 'view')
      .reasonCode, 'denied_unknown_role', `role ${why}`);
  }
  assert.equal(requireTenantPermission(ctx('tenant', { tenantRoleId: null, platformRoleId: 'system_owner', permissions: { refunds: 'full' } }),
    'refunds', 'view').reasonCode, 'denied_unknown_role', 'a tenant action needs a tenant role');
  // A malformed held level denies even against `none`.
  const held = ctx('tenant', { tenantRoleId: 'manager', permissions: { refunds: 'FULL' } });
  assert.equal(requireTenantPermission(held, 'refunds', 'none').decision, 'deny');
  assert.equal(requireTenantPermission(ctx('tenant', { tenantRoleId: 'manager', permissions: {} }), 'refunds', 'none').decision, 'allow',
    'control: an absent entry is no grant, which clears only `none`');
  // Tenant id still required, as before.
  assert.equal(requireTenantPermission(ctx('tenant', { tenantRoleId: 'store_owner' }, { tenantId: null }), 'refunds', 'view').reasonCode,
    'denied_missing_tenant');
});

test('tenant: the gap R1 closes — an unknown level was an allowance for a holder of nothing', () => {
  const c = ctx('tenant', { tenantRoleId: 'sales_staff', permissions: {} });
  assert.deepEqual(legacyTenant(c, 'sales', 'admin' as PermissionLevel), d('allow', 'allowed_permission_met'));
  assert.equal(requireTenantPermission(c, 'sales', 'admin' as PermissionLevel).decision, 'deny');
});

// =============================================================================
// requireSubPermission
// =============================================================================

test('sub-permission: every canonical decision is unchanged from before R1', () => {
  const actors: { platformRoleId: string | null; tenantRoleId: string | null }[] = [
    ...TENANT_ROLE_IDS.map((r) => ({ platformRoleId: null, tenantRoleId: r as string })),
    { platformRoleId: 'system_owner', tenantRoleId: null },
  ];
  let n = 0;
  for (const actor of actors) {
    const role = actor.tenantRoleId ?? 'store_owner';
    const levelMaps: Record<string, string>[] = [materializeTenantPermissions(role, FULL_TENANT_ENTITLEMENTS, false), {}];
    const subMaps: Record<string, boolean>[] = [materializeTenantSubPermissions(role, FULL_TENANT_ENTITLEMENTS, false), {}];
    for (const sub of TENANT_SUB_PERMISSIONS) {
      const perParent = [...levelMaps, ...PERMISSION_LEVEL_VALUES.map((l) => ({ [sub.parentDomain]: l }))];
      const explicit = [...subMaps, { [sub.id]: true }, { [sub.id]: false }];
      for (const permissions of perParent) {
        for (const subPermissions of explicit) {
          for (const planAvailable of [true, false]) {
            const c = ctx('store', { ...actor, permissions, subPermissions });
            const def = subDefOf(sub.id, planAvailable);
            assert.deepEqual(pick(requireSubPermission(c, sub.id, def)), legacySub(c, sub.id, def), `${JSON.stringify(actor)} ${sub.id}`);
            n += 1;
          }
        }
      }
    }
  }
  assert.equal(n, 5 * TENANT_SUB_PERMISSIONS.length * 9 * 4 * 2);
});

test('sub-permission: an unknown id, or a definition that disagrees with the catalog, is refused', () => {
  const owner = ctx('tenant', { tenantRoleId: 'store_owner' });
  assert.equal(requireSubPermission(owner, 'approve_refunds', subDefOf('approve_refunds')).decision, 'allow', 'control');
  for (const [why, id] of MALFORMED_NAMES) {
    assert.equal(requireSubPermission(owner, id as string, subDefOf('approve_refunds')).reasonCode, 'denied_invalid_requirement', `id ${why}`);
  }
  // Two sources of configured authority that disagree are ambiguous, and ambiguity denies.
  const def = subDefOf('approve_refunds');
  const variants: readonly (readonly [string, unknown])[] = [
    ['another parent domain', { ...def, parentDomain: 'sales' }],
    ['a lower minimum level', { ...def, minModuleLevel: 'none' }],
    ['a lower default level', { ...def, defaultLevel: 'view' }],
    ['a missing minimum level', (({ minModuleLevel: _m, ...rest }) => rest)(def)],
    ['a missing default level', (({ defaultLevel: _d, ...rest }) => rest)(def)],
    ['an unknown minimum level', { ...def, minModuleLevel: 'bogus' }],
    ['a truthy string for plan availability', { ...def, planAvailable: 'false' }],
    ['a number for plan availability', { ...def, planAvailable: 1 }],
    ['a missing plan availability', (({ planAvailable: _p, ...rest }) => rest)(def)],
    ['null', null],
    ['an array', []],
  ];
  for (const [why, bad] of variants) {
    assert.equal(requireSubPermission(owner, 'approve_refunds', bad as SubPermissionContext).reasonCode, 'denied_invalid_requirement', why);
  }
});

test('sub-permission: an explicit grant must be a boolean — anything else is malformed and denies', () => {
  const at = (subPermissions: Record<string, unknown>) =>
    requireSubPermission(ctx('tenant', { tenantRoleId: 'manager', permissions: { refunds: 'approve' }, subPermissions: subPermissions as never }),
      'approve_refunds', subDefOf('approve_refunds'));
  assert.equal(at({ approve_refunds: true }).reasonCode, 'allowed_explicit_grant', 'control');
  assert.equal(at({ approve_refunds: false }).reasonCode, 'denied_explicit_revoke', 'control');
  assert.equal(at({}).reasonCode, 'allowed_default', 'control: no entry falls through to the default');
  for (const bad of ['true', 'false', 1, 0, null, undefined, {}, [], 'yes']) {
    assert.deepEqual(pick(at({ approve_refunds: bad })), { decision: 'deny', reasonCode: 'denied_malformed_snapshot' }, JSON.stringify(bad));
  }
  // Pre-R1 a truthy non-boolean was a grant: the oracle confirms the gap was real.
  const c = ctx('tenant', { tenantRoleId: 'manager', permissions: { refunds: 'approve' }, subPermissions: { approve_refunds: 'false' } as never });
  assert.deepEqual(legacySub(c, 'approve_refunds', subDefOf('approve_refunds')), d('allow', 'allowed_explicit_grant'));
});

test('sub-permission: roles — a tenant role or the System Owner; nothing else, nothing unknown', () => {
  const def = subDefOf('approve_refunds');
  assert.equal(requireSubPermission(ctx('store', { platformRoleId: 'system_owner' }), 'approve_refunds', def).reasonCode, 'allowed_owner',
    'the System Owner keeps its tenant short-circuit, as the frontend grants it');
  assert.equal(requireSubPermission(ctx('store', { platformRoleId: 'support_admin', permissions: { refunds: 'full' } }), 'approve_refunds', def)
    .reasonCode, 'denied_unknown_role', 'a platform role other than the owner holds no tenant capability');
  for (const [why, role] of MALFORMED_NAMES) {
    if (role === null) continue;
    assert.equal(requireSubPermission(ctx('store', { tenantRoleId: role as string, permissions: { refunds: 'full' } }), 'approve_refunds', def)
      .reasonCode, 'denied_unknown_role', `role ${why}`);
  }
  // Plan lock still runs before the owner short-circuit.
  assert.equal(requireSubPermission(ctx('store', { tenantRoleId: 'store_owner' }), 'approve_refunds', subDefOf('approve_refunds', false))
    .reasonCode, 'denied_plan_locked');
});

test('the inputs the decision reads are read once — a getter cannot answer the check and the use differently', () => {
  let reads = 0;
  const shifting = {
    parentDomain: 'refunds', minModuleLevel: 'view', defaultLevel: 'approve',
    get planAvailable() { reads += 1; return reads === 1 ? false : true; },
  };
  // Read once as `false`: plan-locked, even for the owner who would otherwise be allowed.
  assert.equal(requireSubPermission(ctx('tenant', { tenantRoleId: 'store_owner' }), 'approve_refunds', shifting as never).reasonCode,
    'denied_plan_locked');
  assert.equal(reads, 1);
});

test('two roles for one decision are ambiguous, and a snapshot map must be a plain record', () => {
  const c = (snap: Record<string, unknown>) => ctx('store', snap as never);
  assert.equal(requireSubPermission(c({ platformRoleId: 'system_owner' }), 'approve_refunds', subDefOf('approve_refunds')).decision, 'allow', 'control');
  const both = requireSubPermission(c({ platformRoleId: 'system_owner', tenantRoleId: 'sales_staff', subPermissions: { approve_refunds: false } }),
    'approve_refunds', subDefOf('approve_refunds'));
  assert.deepEqual(pick(both), { decision: 'deny', reasonCode: 'denied_ambiguous_role' }, 'the owner slot cannot override the tenant slot');
  assert.equal(requireTenantPermission(c({ platformRoleId: 'support_admin', tenantRoleId: 'store_owner' }), 'refunds', 'view').reasonCode,
    'denied_ambiguous_role');
  assert.equal(requirePlatformPermission(ctx('platform', { platformRoleId: 'system_owner', tenantRoleId: 'manager' }), 'team_management', 'view')
    .reasonCode, 'denied_ambiguous_role');
  for (const [why, permissions] of [['Date', new Date(0)], ['Map', new Map([['team_management', 'full']])], ['class instance', new (class X {})()]] as const) {
    const r = requirePlatformPermission(ctx('platform', { platformRoleId: 'support_admin', permissions: permissions as never }), 'team_management', 'none');
    assert.equal(r.reasonCode, 'denied_malformed_snapshot', why);
  }
  // A null-prototype record is still a record.
  const bare = Object.assign(Object.create(null) as Record<string, string>, { team_management: 'view' });
  assert.equal(requirePlatformPermission(ctx('platform', { platformRoleId: 'support_admin', permissions: bare }), 'team_management', 'view').decision, 'allow');
});
