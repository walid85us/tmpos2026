// M5-GAP11-P5 (B) — explicit, editable money capabilities: approve_refunds, approve_return (store) and
// approve_billing_actions (platform). Built-in defaults are written out here from the owner decision.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILT_IN_MONEY_GRANT_DEFAULTS,
  MONEY_CAPABILITIES,
  builtInMoneyGrants,
  hasExplicitMoneyGrant,
  isPlatformMoneyCapability,
  isRetiredMoneyLevelForm,
  isTenantMoneyCapability,
} from './moneyCapabilities';
import { PERMISSION_DOMAINS, SUB_PERMISSIONS, tenantRoles } from '../context/accessConfig';
import {
  decideSupervisorRefundApproval,
  decideTenantMoneyCapability,
  decideTenantPermission,
  decideTenantSubPermission,
  subPermissionMatrixStatus,
  type TenantDecisionInput,
} from '../context/tenantAccessDecisions';
import { explainAccessDecision, findSubPermissionDef, getPlatformMoneyGrant, type PlatformPermissionsOverrides } from '../owner/platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import type { EmployeeRole, PermissionLevel } from '../types';
import {
  materializePlatformSubPermissions,
  materializeTenantSubPermissions,
} from '../../server/platform-identity/permissionCatalog';
import { requireSubPermission, requireTenantPermission } from '../../server/platform-identity/permissionDecision';
import type { PermissionSnapshot, RequestContext } from '../../server/platform-identity/requestContext';

const WRITTEN_DEFAULTS: Record<string, Record<string, boolean>> = {
  store_owner: { approve_refunds: true, approve_return: true },
  manager: { approve_refunds: true, approve_return: true },
  sales_staff: { approve_refunds: false, approve_return: false },
  technician: { approve_refunds: false, approve_return: false },
  system_owner: { approve_billing_actions: true },
  billing_admin: { approve_billing_actions: true },
  operations_admin: { approve_billing_actions: false },
  security_admin: { approve_billing_actions: false },
  support_admin: { approve_billing_actions: false },
};
const GROWTH = { id: 'tenant-1', plan: 'growth' } as const;
const input = (roles: EmployeeRole[], effectiveRole: string, tenant: TenantDecisionInput['tenant'] = GROWTH, hasSession = true): TenantDecisionInput =>
  ({ hasSession, effectiveRole, roles, tenant });
const builtIn = (id: string): EmployeeRole => {
  const r = tenantRoles.find((x) => x.id === id)!;
  return { ...r, permissions: Array.isArray(r.permissions) ? [...r.permissions] : { ...r.permissions }, subPermissions: { ...(r.subPermissions ?? {}) } };
};
const withGrant = (role: EmployeeRole, cap: string, value: unknown): EmployeeRole => ({ ...role, subPermissions: { ...(role.subPermissions ?? {}), [cap]: value as boolean } });
const withLevel = (role: EmployeeRole, domain: string, level: PermissionLevel): EmployeeRole => ({ ...role, permissions: { ...(role.permissions as Record<string, PermissionLevel>), [domain]: level } });
const decide = (role: EmployeeRole, cap: 'approve_refunds' | 'approve_return', tenant: TenantDecisionInput['tenant'] = GROWTH) =>
  decideTenantMoneyCapability({ hasSession: true, tenant, roleConfig: role }, cap);

test('B1. the built-in defaults are exactly the owner-approved values, and nothing else carries a default', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(BUILT_IN_MONEY_GRANT_DEFAULTS)), WRITTEN_DEFAULTS);
  assert.deepEqual(MONEY_CAPABILITIES.map((c) => c.id), ['approve_refunds', 'approve_return', 'approve_billing_actions']);
  // The table agrees with the guards and the catalogs the decisions read (it cannot drift silently).
  for (const c of MONEY_CAPABILITIES) {
    assert.equal(isTenantMoneyCapability(c.id), c.plane === 'tenant', c.id);
    assert.equal(isPlatformMoneyCapability(c.id), c.plane === 'platform', c.id);
    assert.equal(c.family, c.plane === 'tenant' ? 'tenant_store' : 'platform', c.id);
    assert.equal(c.parent, c.plane === 'tenant' ? SUB_PERMISSIONS.find((s) => s.id === c.id)?.parentDomain : findSubPermissionDef(c.id)?.feature, c.id);
  }
  for (const id of ['custom_role', 'Manager', '', 'constructor', '__proto__', 'toString']) assert.deepEqual(builtInMoneyGrants(id), {}, id);
  // The runtime built-in store roles are initialized from the defaults (their configuration carries them).
  for (const role of ['store_owner', 'manager', 'sales_staff', 'technician']) {
    for (const cap of ['approve_refunds', 'approve_return'] as const) {
      assert.equal(builtIn(role).subPermissions![cap], WRITTEN_DEFAULTS[role][cap], `${role} ${cap}`);
      assert.equal(decide(builtIn(role), cap), WRITTEN_DEFAULTS[role][cap], `decision ${role} ${cap}`);
    }
  }
});

test('B2. only an explicit `true` grants; absent, false and malformed grants deny', () => {
  assert.equal(hasExplicitMoneyGrant({ approve_refunds: true }, 'approve_refunds'), true, 'control');
  const proto = Object.create({ approve_refunds: true });
  for (const bad of [{}, { approve_refunds: false }, { approve_refunds: 'true' }, { approve_refunds: 1 }, { approve_refunds: null },
    { approve_refunds: undefined }, proto, null, undefined, 'true', true, [], new Map([['approve_refunds', true]]),
    { approve_return: true }]) {
    assert.equal(hasExplicitMoneyGrant(bad, 'approve_refunds'), false, JSON.stringify(bad));
  }
  const manager = builtIn('manager');
  for (const bad of ['true', 1, null, {}, [], 'yes']) {
    assert.equal(decide(withGrant(manager, 'approve_refunds', bad), 'approve_refunds'), false, `malformed ${JSON.stringify(bad)}`);
    assert.equal(decide(withGrant(manager, 'approve_return', bad), 'approve_return'), false, `malformed ${JSON.stringify(bad)}`);
  }
});

test('B3. owner edits: true grants, false revokes — manager refund revocation is honoured in both refund forms', () => {
  const revoked = withGrant(builtIn('manager'), 'approve_refunds', false);
  const roles = [revoked, builtIn('store_owner')];
  assert.equal(decideTenantSubPermission(input(roles, 'manager'), 'approve_refunds'), false);
  assert.equal(decideSupervisorRefundApproval(input(roles, 'manager'), 'manager'), false);
  assert.equal(decideSupervisorRefundApproval(input(roles, 'manager'), 'store_owner'), true, 'control: another supervisor still can');
  const regranted = withGrant(revoked, 'approve_refunds', true);
  assert.equal(decideSupervisorRefundApproval(input([regranted], 'manager'), 'manager'), true);
  assert.equal(decide(withGrant(builtIn('manager'), 'approve_return', false), 'approve_return'), false, 'return revocation honoured');
});

test('B4. granting return approval to technician and sales_staff is honoured when every other gate passes', () => {
  for (const id of ['technician', 'sales_staff']) {
    const base = builtIn(id);
    assert.equal(decide(base, 'approve_return'), false, `${id} default denied`);
    const granted = withGrant(base, 'approve_return', true);
    assert.equal(decide(granted, 'approve_return'), false, `${id}: the parent minimum (Returns Manage) still denies at View`);
    for (const level of ['manage', 'approve', 'full'] as const) {
      assert.equal(decide(withLevel(granted, 'returns', level), 'approve_return'), true, `${id} returns=${level} with grant`);
      assert.equal(decide(withLevel(base, 'returns', level), 'approve_return'), false, `${id} returns=${level} without grant`);
    }
    const refunder = withLevel(withGrant(base, 'approve_refunds', true), 'refunds', 'view');
    assert.equal(decideSupervisorRefundApproval(input([refunder], id), id), true, `${id} refund grant honoured`);
  }
});

test('B5. custom roles: an explicit grant grants, a missing one denies — a high level alone never grants', () => {
  const allFull: Record<string, PermissionLevel> = Object.fromEntries(PERMISSION_DOMAINS.map((d) => [d.id, 'full']));
  const custom: EmployeeRole = { id: 'custom_money', name: 'Custom', permissions: allFull, subPermissions: {} };
  for (const cap of ['approve_refunds', 'approve_return'] as const) {
    assert.equal(decide(custom, cap), false, `${cap}: Full everywhere, no grant`);
    assert.equal(decideTenantSubPermission(input([custom], 'custom_money'), cap), false);
    assert.equal(decide(withGrant(custom, cap, true), cap), true, `${cap}: explicit grant`);
    assert.equal(decide(withGrant(custom, cap, false), cap), false, `${cap}: explicit denial`);
  }
  assert.equal(decideSupervisorRefundApproval(input([custom], 'custom_money'), 'custom_money'), false);
  const noSubs: EmployeeRole = { id: 'custom_nosubs', name: 'No subs', permissions: allFull };
  assert.equal(decide(noSubs, 'approve_refunds'), false, 'no subPermissions at all');
  // Array-form permissions (a custom role created from an approval request): a listed domain is Full.
  const arr: EmployeeRole = { id: 'custom_arr', name: 'Array', permissions: ['refunds', 'returns_read'], subPermissions: {} };
  assert.equal(decide(arr, 'approve_refunds'), false, 'array form: Full, no grant');
  assert.equal(decide(withGrant(arr, 'approve_refunds', true), 'approve_refunds'), true, 'array form: Full + grant');
  assert.equal(decide(withGrant(arr, 'approve_return', true), 'approve_return'), false, 'array form: returns_read is View, below the Returns minimum');
  assert.equal(decideTenantPermission(input([arr], 'custom_arr'), 'refunds', 'full'), true, 'array form: listed domain is Full');
  assert.equal(decideTenantPermission(input([arr], 'custom_arr'), 'returns', 'create'), false, 'array form: _read is View');
  assert.equal(decideTenantPermission(input([arr], 'custom_arr'), 'inventory', 'view'), false, 'array form: unlisted is None');
  // Approve, Manage or Full never grant by themselves — for every level of the parent module.
  for (const level of ['view', 'create', 'edit', 'manage', 'approve', 'full'] as const) {
    assert.equal(decide({ ...custom, permissions: { refunds: level, returns: level } }, 'approve_refunds'), false, level);
    assert.equal(decide({ ...custom, permissions: { refunds: level, returns: level } }, 'approve_return'), false, level);
  }
});

test('B6. a true grant does not bypass the other gates: session, tenant, plan, parent module, role, System Owner', () => {
  const manager = builtIn('manager');
  assert.equal(decide(manager, 'approve_refunds'), true, 'control');
  assert.equal(decideTenantMoneyCapability({ hasSession: false, tenant: GROWTH, roleConfig: manager }, 'approve_refunds'), false, 'no session');
  // No store context, no money approval (the DEV spine answers denied_missing_tenant for the same input).
  assert.equal(decide(manager, 'approve_refunds', null), false, 'no tenant');
  assert.equal(decide(manager, 'approve_return', null), false, 'no tenant');
  assert.equal(decideSupervisorRefundApproval(input([manager], 'sales_staff', null), 'manager'), false, 'no tenant: supervisor check');
  assert.equal(decide(manager, 'approve_refunds', { id: 't', plan: 'starter' }), false, 'plan without refunds');
  assert.equal(decide(manager, 'approve_return', { id: 't', plan: 'starter' }), false, 'plan without returns');
  assert.equal(decide(withLevel(manager, 'refunds', 'none'), 'approve_refunds'), false, 'below the Refunds minimum');
  assert.equal(decide(withLevel(manager, 'returns', 'edit'), 'approve_return'), false, 'below the Returns minimum');
  assert.equal(decideTenantMoneyCapability({ hasSession: true, tenant: GROWTH, roleConfig: undefined }, 'approve_refunds'), false, 'no role');
  // The platform System Owner has no store role, so it holds no store money capability (owner decision).
  const roles = tenantRoles.map((r) => ({ ...r }));
  assert.equal(decideTenantSubPermission(input(roles, 'system_owner', null), 'approve_return'), false);
  assert.equal(decideTenantSubPermission(input(roles, 'system_owner', null), 'approve_refunds'), false);
  assert.equal(decideTenantSubPermission(input(roles, 'system_owner', null), 'process_refunds'), true, 'control: non-money owner shortcut unchanged');
  assert.equal(decideSupervisorRefundApproval(input(roles, 'store_owner'), 'system_owner'), false);
});

test('B7. the two refund-approval forms give one answer for every reachable refund configuration', () => {
  let compared = 0;
  const grants: unknown[] = ['absent', true, false, 'true'];
  for (const base of ['manager', 'technician', 'sales_staff', 'store_owner', 'custom_x']) {
    for (const level of PERMISSION_DOMAINS.find((d) => d.id === 'refunds')!.levels) {
      for (const g of grants) {
        let role: EmployeeRole = base === 'custom_x' ? { id: 'custom_x', name: 'X', permissions: {}, subPermissions: {} } : builtIn(base);
        if (base !== 'store_owner') role = withLevel(role, 'refunds', level);
        const subs = { ...(role.subPermissions ?? {}) } as Record<string, unknown>;
        if (g === 'absent') delete subs.approve_refunds; else subs.approve_refunds = g;
        role = { ...role, subPermissions: subs as Record<string, boolean> };
        // The sub-permission form is asked with the role as the effective role; the supervisor form names it.
        const viaSub = base === 'store_owner'
          ? decideTenantMoneyCapability({ hasSession: true, tenant: GROWTH, roleConfig: role }, 'approve_refunds')
          : decideTenantSubPermission(input([role], role.id), 'approve_refunds');
        assert.equal(decideSupervisorRefundApproval(input([role], 'sales_staff'), role.id), viaSub, `${base} refunds=${level} grant=${String(g)}`);
        compared += 1;
      }
    }
  }
  assert.equal(compared, 5 * 5 * 4);
  // The retired level form is refused everywhere, owners included.
  assert.equal(isRetiredMoneyLevelForm('refunds', 'approve'), true);
  assert.equal(decideTenantPermission(input(tenantRoles.map((r) => ({ ...r })), 'store_owner'), 'refunds', 'approve'), false);
  assert.equal(decideTenantPermission(input(tenantRoles.map((r) => ({ ...r })), 'store_owner'), 'refunds', 'full'), true, 'control');
});

test('B8. equivalent runtime data gives the same decision whatever its provenance (built-in, edited, custom, fixture)', () => {
  for (const source of ['manager', 'technician', 'sales_staff']) {
    const original = builtIn(source);
    const clone: EmployeeRole = { ...original, id: `custom_clone_of_${source}`, name: 'Clone' };
    const a = input([original], original.id);
    const b = input([clone], clone.id);
    for (const sub of SUB_PERMISSIONS) {
      assert.equal(decideTenantSubPermission(b, sub.id), decideTenantSubPermission(a, sub.id), `${source} ${sub.id}`);
      assert.equal(subPermissionMatrixStatus(clone, sub), subPermissionMatrixStatus(original, sub), `matrix ${source} ${sub.id}`);
    }
    for (const d of PERMISSION_DOMAINS) for (const level of ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'] as const) {
      assert.equal(decideTenantPermission(b, d.id, level), decideTenantPermission(a, d.id, level), `${source} ${d.id}:${level}`);
    }
    assert.equal(decideSupervisorRefundApproval(b, clone.id), decideSupervisorRefundApproval(a, original.id));
  }
});

test('B9. the role editors show the runtime answer: money rows show the explicit grant only', () => {
  const custom: EmployeeRole = { id: 'c', name: 'C', permissions: { refunds: 'full', returns: 'full' }, subPermissions: {} };
  const def = (id: string) => SUB_PERMISSIONS.find((s) => s.id === id)!;
  assert.equal(subPermissionMatrixStatus(custom, def('approve_refunds')), 'denied', 'Full level alone is not a grant');
  assert.equal(subPermissionMatrixStatus(custom, def('approve_return')), 'denied');
  assert.equal(subPermissionMatrixStatus(custom, def('process_refunds')), 'granted', 'control: non-money default by level');
  assert.equal(subPermissionMatrixStatus(withGrant(custom, 'approve_refunds', true), def('approve_refunds')), 'granted');
  assert.equal(subPermissionMatrixStatus({ ...custom, permissions: { returns: 'edit' } }, def('approve_return')), 'na', 'below the minimum');
  assert.equal(subPermissionMatrixStatus(withGrant(custom, 'process_refunds', 'yes'), def('process_refunds')), 'denied', 'a present non-boolean is not a grant');
});

test('B10. platform billing approval: the explicit grant decides; a level never grants; a malformed grant denies', () => {
  const allow = (role: string, ov?: PlatformPermissionsOverrides) => explainAccessDecision(role as Role, 'approve_billing_actions', ov ?? {}).allowed;
  for (const role of ['system_owner', 'billing_admin', 'operations_admin', 'security_admin', 'support_admin']) {
    assert.equal(allow(role), WRITTEN_DEFAULTS[role].approve_billing_actions, `${role} default`);
    assert.equal(getPlatformMoneyGrant(role as Role, 'approve_billing_actions', {}), WRITTEN_DEFAULTS[role].approve_billing_actions);
  }
  assert.equal(allow('operations_admin', { operations_admin: { grants: { approve_billing_actions: true } } }), true, 'owner grant');
  assert.equal(allow('billing_admin', { billing_admin: { grants: { approve_billing_actions: false } } }), false, 'owner revoke');
  assert.equal(allow('system_owner', { system_owner: { grants: { approve_billing_actions: false } } }), true, 'System Owner is locked');
  for (const ov of [{ billing_admin: { grants: { approve_billing_actions: 'true' } } }, { billing_admin: { grants: [] } }, { billing_admin: [] }, []] as unknown[]) {
    assert.equal(allow('billing_admin', ov as PlatformPermissionsOverrides), false, `malformed ${JSON.stringify(ov)}`);
  }
  // Levels never grant it: Full on the sub or the parent, with no grant, is still denied.
  assert.equal(allow('operations_admin', { operations_admin: { subs: { approve_billing_actions: 'full' }, features: { billing_subscriptions: 'full' } } }), false);
  // A revocation the pre-P5 matrix stored as a sub level stays a revocation; a stored level never grants.
  assert.equal(allow('billing_admin', { billing_admin: { subs: { approve_billing_actions: 'none' } } }), false, 'legacy revocation');
  assert.equal(allow('billing_admin', { billing_admin: { subs: { approve_billing_actions: 'edit' } } }), false, 'legacy level below Approve');
  assert.equal(allow('billing_admin', { billing_admin: { subs: { approve_billing_actions: 'bogus' } } } as never), false, 'legacy malformed');
  assert.equal(allow('billing_admin', { billing_admin: { subs: { approve_billing_actions: 'full' } } }), true, 'legacy level at/above Approve: the default applies');
  for (const lvl of ['approve', 'manage', 'full'] as const) {
    assert.equal(allow('operations_admin', { operations_admin: { subs: { approve_billing_actions: lvl } } }), false, `legacy ${lvl} never grants a role whose default is denied`);
  }
  assert.equal(allow('billing_admin', { billing_admin: { subs: [] } } as never), false, 'legacy malformed subs container');
  assert.equal(allow('billing_admin', { billing_admin: { subs: { view_billing: 'none' } } }), true, 'an unrelated sub entry is not a revocation');
  assert.equal(allow('billing_admin', { billing_admin: { subs: { approve_billing_actions: 'none' }, grants: { approve_billing_actions: true } } }), true, 'an explicit grant wins');
  // The parent minimum (View on Billing) still denies a granted role.
  assert.equal(allow('billing_admin', { billing_admin: { features: { billing_subscriptions: 'none' } } }), false, 'no billing access');
  for (const role of ['store_owner', 'manager', 'custom_x', '']) assert.equal(allow(role, { [role]: { grants: { approve_billing_actions: true } } } as never), false, role);
  // Platform non-money semantics unchanged: Manage satisfies an Approve threshold.
  assert.equal(explainAccessDecision('security_admin', 'export_audit_csv', { security_admin: { features: { audit_security: 'manage' } } }).allowed, true);
});

test('B11. the server catalog materializes money capabilities from the explicit defaults only', () => {
  const FULL: Record<string, boolean> = Object.fromEntries(['refunds', 'returns', 'repairs', 'inventory', 'employees', 'warranties', 'services',
    'reports', 'prospects', 'marketing', 'suggestive_sales', 'settings', 'supply-chain', 'integrations', 'widgets', 'shipping'].map((k) => [k, true]));
  for (const role of ['store_owner', 'manager', 'sales_staff', 'technician']) {
    const subs = materializeTenantSubPermissions(role, FULL, false);
    assert.equal(subs.approve_refunds, WRITTEN_DEFAULTS[role].approve_refunds, `${role} refunds`);
    assert.equal(subs.approve_return, WRITTEN_DEFAULTS[role].approve_return, `${role} returns`);
    assert.equal(materializeTenantSubPermissions(role, {}, false).approve_refunds, false, `${role}: plan gate`);
  }
  for (const role of ['system_owner', 'billing_admin', 'operations_admin', 'security_admin', 'support_admin']) {
    assert.equal(materializePlatformSubPermissions(role, false).approve_billing_actions, WRITTEN_DEFAULTS[role].approve_billing_actions, role);
    assert.equal(materializePlatformSubPermissions(role, true).approve_billing_actions, false, `${role}: read-only cap`);
  }
});

test('B12. the DEV spine decides store money capabilities by the explicit grant and refuses the level form', () => {
  const ctx = (snap: Partial<PermissionSnapshot>): RequestContext => ({
    requestId: 'r', source: 'dev-diagnostic', environment: 'dev', authState: 'dev-asserted',
    actor: { internalUserId: null, authProvider: 'firebase', authProviderUid: 'dev', email: null, actorType: 'dev_actor' },
    scope: { scopeType: 'store', tenantId: 't', storeId: 's', platformScope: false },
    permissionSnapshot: { source: 'dev_asserted_snapshot', platformRoleId: null, tenantRoleId: null, permissions: {}, subPermissions: {}, ...snap } as PermissionSnapshot,
    identityResolution: 'skipped_config_incomplete',
  });
  const def = (id: string) => { const s = SUB_PERMISSIONS.find((x) => x.id === id)!; return { parentDomain: s.parentDomain, minModuleLevel: s.minModuleLevel, defaultLevel: s.defaultLevel, planAvailable: true }; };
  const r = (snap: Partial<PermissionSnapshot>, id = 'approve_refunds') => requireSubPermission(ctx(snap), id, def(id)).reasonCode;
  assert.equal(r({ tenantRoleId: 'store_owner', permissions: { refunds: 'full' }, subPermissions: { approve_refunds: true } }), 'allowed_explicit_grant');
  assert.equal(r({ tenantRoleId: 'store_owner', permissions: { refunds: 'full' } }), 'denied_missing_grant', 'no owner short-circuit for money');
  assert.equal(r({ tenantRoleId: 'manager', permissions: { refunds: 'full' } }), 'denied_missing_grant', 'no default-by-level');
  assert.equal(r({ tenantRoleId: 'technician', permissions: { returns: 'manage' }, subPermissions: { approve_return: true } }, 'approve_return'), 'allowed_explicit_grant');
  assert.equal(r({ platformRoleId: 'system_owner', permissions: { refunds: 'full' }, subPermissions: { approve_refunds: true } }), 'denied_no_store_role');
  assert.equal(requireTenantPermission(ctx({ tenantRoleId: 'store_owner' }), 'refunds', 'approve').reasonCode, 'denied_money_level_form');
});
