// Phase 4.0 M5-ID-P1 — the canonical route-permission catalog: exact keys, fail-closed unknowns, and
// an honest refusal to answer where GAP-11 has not been settled.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_PLATFORM_PERMISSIONS,
  CANONICAL_TENANT_PERMISSIONS,
  BUILT_IN_PLATFORM_ROLES,
  TENANT_ROUTE_PERMISSIONS,
  canonicalPermission,
  evaluateCanonicalPermission,
  isDecidablePermission,
} from './m5CanonicalPermissions';
import type { PlatformRoleDefinition } from './m5CanonicalPermissions';
import {
  PLATFORM_SUB_PERMISSIONS, TENANT_DOMAIN_ENTITLEMENT, TENANT_PERMISSION_DOMAINS, TENANT_SUB_PERMISSIONS,
  materializePlatformSubPermissions, materializeTenantPermissions, meetsTenantPermissionLevel,
} from './permissionCatalog';
import { PLATFORM_ROLE_IDS, TENANT_ROLE_IDS } from './authorizationConstants';

test('the catalog is the existing one, not a second copy of it', () => {
  // Every key comes from permissionCatalog.ts, so a key added or removed there moves with it and no
  // permission can be defined twice, with two meanings, in two files.
  assert.equal(CANONICAL_PLATFORM_PERMISSIONS.size, PLATFORM_SUB_PERMISSIONS.length);
  assert.equal(CANONICAL_TENANT_PERMISSIONS.size, TENANT_SUB_PERMISSIONS.length);
  for (const sub of PLATFORM_SUB_PERMISSIONS) {
    assert.deepEqual(canonicalPermission('platform', sub.id),
      { key: sub.id, plane: 'platform', parent: sub.feature, sensitive: sub.sensitive, threshold: sub.threshold });
  }
  for (const sub of TENANT_SUB_PERMISSIONS) {
    const entry = canonicalPermission('tenant', sub.id);
    assert.equal(entry?.parent, sub.parentDomain);
    assert.equal(entry?.sensitive, sub.mutating, 'a mutating tenant sub keeps its existing classification');
  }
});

test('lookup is exact and case-sensitive, and everything else is no permission at all', () => {
  assert.notEqual(canonicalPermission('platform', 'view_command_center'), null);
  for (const key of [
    'View_Command_Center', 'VIEW_COMMAND_CENTER', ' view_command_center', 'view_command_center ',
    'view_command', 'view_command_center_extra', 'command_center', '', 'conformance.write',
  ]) assert.equal(canonicalPermission('platform', key), null, key);
  for (const key of [null, undefined, 42, {}, []]) assert.equal(canonicalPermission('platform', key), null, String(key));
  // A bare FEATURE or DOMAIN key names a level, not a decidable requirement, so it is not a route permission.
  assert.equal(canonicalPermission('tenant', 'sales'), null);
});

test('the two planes are separate: a platform key is not a tenant key', () => {
  assert.notEqual(canonicalPermission('platform', 'view_command_center'), null);
  assert.equal(canonicalPermission('tenant', 'view_command_center'), null);
  assert.equal(canonicalPermission('store', 'view_command_center'), null);
  const tenantKey = TENANT_SUB_PERMISSIONS[0].id;
  assert.equal(canonicalPermission('platform', tenantKey), null);
  // A store scope reads the tenant plane: a store role is a tenant role.
  assert.deepEqual(canonicalPermission('store', tenantKey), canonicalPermission('tenant', tenantKey));
});

test('a platform role is evaluated on the ordering the documents already call canonical', () => {
  // system_owner is locked Full, so it holds every platform sub; a tenant role holds none of them.
  for (const sub of PLATFORM_SUB_PERMISSIONS) {
    assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId: 'system_owner', permission: sub.id, limitation: 'none' }),
      'granted', sub.id);
  }
  for (const roleId of TENANT_ROLE_IDS) {
    assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId, permission: 'view_command_center', limitation: 'none' }),
      'denied', `${roleId} holds no platform authority`);
  }
  // Some platform role must be denied something, or the evaluation is not discriminating at all.
  const denials = PLATFORM_ROLE_IDS.flatMap((roleId) => PLATFORM_SUB_PERMISSIONS
    .filter((sub) => evaluateCanonicalPermission({ scope: 'platform', roleId, permission: sub.id, limitation: 'none' }) === 'denied'));
  assert.ok(denials.length > 0, 'a role that is not the owner holds less than everything');
});

test('a read-only account keeps only its non-sensitive view-threshold grants', () => {
  const sensitive = PLATFORM_SUB_PERMISSIONS.find((s) => s.sensitive);
  assert.ok(sensitive, 'the catalog classifies at least one platform sub as sensitive');
  assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId: 'system_owner', permission: sensitive.id, limitation: 'read_only' }),
    'denied', 'read-only strips a sensitive grant even from the owner');
  assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId: 'system_owner', permission: 'view_command_center', limitation: 'read_only' }),
    'granted', 'a non-sensitive view stays');
});

test('an unknown key or an unknown role grants nothing', () => {
  const cases = [
    { scope: 'platform' as const, roleId: 'system_owner', permission: 'no_such_permission' },
    { scope: 'platform' as const, roleId: 'not_a_role', permission: 'view_command_center' },
    { scope: 'platform' as const, roleId: '', permission: 'view_command_center' },
    { scope: 'platform' as const, roleId: 'System_Owner', permission: 'view_command_center' },
  ];
  for (const c of cases) {
    assert.equal(evaluateCanonicalPermission({ ...c, limitation: 'none' }), 'denied', JSON.stringify(c));
  }
});

test('a tenant or store permission is undecidable, never allowed, until GAP-11 is settled', () => {
  // docs/phase-4/04 section 3 makes the ordering unification an M5 phase (i) migration with six
  // mandatory safeguards, one of which (#3, approval of the grant diff) is explicitly the owner's and
  // one (#1, the per-action re-pin) is still an open policy choice. Answering here would either keep the
  // old tenant ordering (contradicting the canonical decision) or adopt the new one and silently
  // widen every manage-holder's grants. So it answers neither, and composition refuses such a route.
  const key = TENANT_SUB_PERMISSIONS[0].id;
  for (const scope of ['tenant', 'store'] as const) {
    for (const roleId of TENANT_ROLE_IDS) {
      assert.equal(evaluateCanonicalPermission({ scope, roleId, permission: key, limitation: 'none' }), 'undecidable', `${scope}/${roleId}`);
    }
    // An unknown key is still a plain denial: undecidable is reserved for keys that really exist.
    assert.equal(evaluateCanonicalPermission({ scope, roleId: 'manager', permission: 'no_such_permission', limitation: 'none' }), 'denied');
  }
});

// M5-GAP11-P1-R1 — deny-by-default on the two inputs that were still coerced: the scope and the limitation.

test('an unknown scope names no plane: nothing is found in it, and nothing is evaluated', () => {
  const tenantKey = TENANT_SUB_PERMISSIONS[0].id;
  // Control: the same keys are found in their real planes.
  assert.notEqual(canonicalPermission('tenant', tenantKey), null);
  assert.notEqual(canonicalPermission('platform', 'view_command_center'), null);
  for (const scope of ['bogus', 'Platform', 'TENANT', ' store', '', 'none', 'constructor', undefined, null, 1]) {
    // Until R1 any scope that was not 'platform' read the TENANT plane, as if it were a tenant scope.
    assert.equal(canonicalPermission(scope as never, tenantKey), null, `scope ${String(scope)}`);
    assert.equal(canonicalPermission(scope as never, 'view_command_center'), null, `scope ${String(scope)}`);
    assert.equal(evaluateCanonicalPermission({ scope: scope as never, roleId: 'manager', permission: tenantKey, limitation: 'none' }),
      'denied', `denied, not undecidable: scope ${String(scope)}`);
  }
});

test('an unrecognised limitation is not "no limitation": it denies, even for the owner', () => {
  const sensitive = PLATFORM_SUB_PERMISSIONS.find((s) => s.sensitive)!;
  // Control: the owner holds the sensitive grant when the limitation is exactly 'none'.
  assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId: 'system_owner', permission: sensitive.id, limitation: 'none' }), 'granted');
  for (const limitation of ['READ_ONLY', 'readonly', 'read-only', 'None', ' none', '', undefined, null, true, false, 0, 1, {}]) {
    for (const permission of [sensitive.id, 'view_command_center']) {
      assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId: 'system_owner', permission, limitation: limitation as never }),
        'denied', `${permission} under ${JSON.stringify(limitation)}`);
    }
  }
  // Nor for a tenant key: a malformed request is a denial, not an 'undecidable' that invites a retry.
  assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'manager', permission: TENANT_SUB_PERMISSIONS[0].id, limitation: 'READ_ONLY' as never }),
    'denied');
});

test('every input field is read exactly once — a getter cannot answer the check and the use differently', () => {
  const reads: Record<string, number> = {};
  let limitationReads = 0;
  const input = new Proxy({ scope: 'platform', roleId: 'system_owner', permission: 'export_audit_csv' } as Record<string, unknown>, {
    get(t, k, r) {
      reads[String(k)] = (reads[String(k)] ?? 0) + 1;
      if (k === 'limitation') { limitationReads += 1; return limitationReads === 1 ? 'read_only' : 'none'; }
      return Reflect.get(t, k, r);
    },
  });
  // Read once as 'read_only', the sensitive export is denied; a second read would have said 'none'.
  assert.equal(evaluateCanonicalPermission(input as never), 'denied');
  // `roles` (M5-GIAM-D1-P1) is read once too: absent here, so the built-in definitions decide.
  assert.deepEqual(reads, { scope: 1, roleId: 1, permission: 1, limitation: 1, roles: 1 });
});

// --- M5-GIAM-D1-P1: the decision reads a role through its definition, never its name -------------------

test('D1: every built-in answer is unchanged — the definitions decide exactly what the catalog materializes', () => {
  // The rule moved from materializePlatformSubPermissions(roleId) to the role's definition; for the five built-in
  // roles, whose definitions ARE the catalog defaults, not one answer may differ — every role, key and limitation.
  let checked = 0;
  for (const roleId of PLATFORM_ROLE_IDS) for (const limited of [false, true]) {
    const materialized = materializePlatformSubPermissions(roleId, limited);
    for (const sub of PLATFORM_SUB_PERMISSIONS) {
      const decided = evaluateCanonicalPermission({ scope: 'platform', roleId, permission: sub.id, limitation: limited ? 'read_only' : 'none' });
      assert.equal(decided === 'granted', materialized[sub.id] === true, `${roleId} ${sub.id} limited=${limited}`);
      checked += 1;
    }
  }
  assert.equal(checked, PLATFORM_ROLE_IDS.length * PLATFORM_SUB_PERMISSIONS.length * 2);
  assert.deepEqual([...BUILT_IN_PLATFORM_ROLES.keys()].sort(), [...PLATFORM_ROLE_IDS].sort(), 'exactly the five built-in roles');
});

test('D1: Tenants at Edit or above — edit_tenant_profile — follows the role\'s tenant_management level, System Owner by the same rule', () => {
  const decide = (roleId: string, limitation: 'none' | 'read_only' = 'none', roles?: ReadonlyMap<string, PlatformRoleDefinition>) =>
    evaluateCanonicalPermission({ scope: 'platform', roleId, permission: 'edit_tenant_profile', limitation, roles });
  // Built-in levels: system_owner full, operations_admin full, support_admin edit — granted; billing_admin and security_admin view — denied.
  assert.deepEqual(PLATFORM_ROLE_IDS.map((r) => [r, decide(r)]), [
    ['system_owner', 'granted'], ['support_admin', 'granted'], ['billing_admin', 'denied'], ['operations_admin', 'granted'], ['security_admin', 'denied'],
  ]);
  // Read-only denies every write permission, System Owner included.
  for (const r of PLATFORM_ROLE_IDS) assert.equal(decide(r, 'read_only'), 'denied', r);
  // System Owner is decided through its DEFINITION, not its name: the same id with a View definition is denied.
  const viewOwner = new Map([['system_owner', { levels: { tenant_management: 'view' as const }, moneyGrants: {} }]]);
  assert.equal(decide('system_owner', 'none', viewOwner), 'denied', 'no role-name shortcut, not even for System Owner');
  // A custom platform role is decided exactly like a built-in one with the same level: every level at or above Edit
  // on the platform ordering (edit < approve < manage < full) grants; below it denies.
  for (const [level, expected] of [['none', 'denied'], ['view', 'denied'], ['create', 'denied'], ['edit', 'granted'], ['approve', 'granted'], ['manage', 'granted'], ['full', 'granted']] as const) {
    const roles = new Map([['custom_tenant_editor', { levels: { tenant_management: level }, moneyGrants: {} }]]);
    assert.equal(decide('custom_tenant_editor', 'none', roles), expected, `custom role at ${level}`);
    assert.equal(decide('custom_tenant_editor', 'read_only', roles), 'denied', `custom role at ${level}, read-only`);
  }
});

test('D1: unknown or malformed vocabulary denies — a role, a level, a grant or a key the catalog does not define', () => {
  const decide = (roleId: string, roles: ReadonlyMap<string, unknown>, permission = 'edit_tenant_profile') =>
    evaluateCanonicalPermission({ scope: 'platform', roleId, permission, limitation: 'none', roles: roles as ReadonlyMap<string, PlatformRoleDefinition> });
  const one = (definition: unknown) => new Map([['custom_role', definition]]);
  assert.equal(decide('custom_role', new Map()), 'denied', 'a role no definition names');
  assert.equal(decide('platform_owner', BUILT_IN_PLATFORM_ROLES), 'denied', 'a retired role id');
  assert.equal(decide('store_owner', BUILT_IN_PLATFORM_ROLES), 'denied', 'a tenant role on the platform plane');
  for (const level of ['EDIT', 'Edit', 'superuser', 'all', '', 5, null, true, { toString: () => 'full' }]) {
    assert.equal(decide('custom_role', one({ levels: { tenant_management: level }, moneyGrants: {} })), 'denied', `level ${String(level)}`);
  }
  for (const levels of [null, [], 'full', Object.create({ tenant_management: 'full' }), new Map([['tenant_management', 'full']])]) {
    assert.equal(decide('custom_role', one({ levels, moneyGrants: {} })), 'denied', 'levels that are not an own, plain record');
  }
  for (const definition of [null, 'full', 42]) assert.equal(decide('custom_role', one(definition)), 'denied', `definition ${String(definition)}`);
  // A money capability needs the explicit grant exactly `true`, whatever the level.
  const full = { tenant_management: 'full', billing_subscriptions: 'full' };
  assert.equal(decide('custom_role', one({ levels: full, moneyGrants: { approve_billing_actions: true } }), 'approve_billing_actions'), 'granted');
  for (const grant of [false, 'true', 1, null, undefined]) {
    assert.equal(decide('custom_role', one({ levels: full, moneyGrants: { approve_billing_actions: grant } }), 'approve_billing_actions'), 'denied', `grant ${String(grant)}`);
  }
  // An unknown permission key, a bare feature key, a tenant key and a malformed limitation deny for every role.
  for (const key of ['edit_tenant', 'tenant_management', 'tenants', 'Edit_Tenant_Profile', 'tenants:edit']) {
    assert.equal(decide('system_owner', BUILT_IN_PLATFORM_ROLES, key), 'denied', key);
  }
  assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId: 'system_owner', permission: 'edit_tenant_profile', limitation: 'limited' as never }), 'denied');
});

// --- M7A-CUSTOMERS-P1: the first decided tenant route permission, view_customers ------------------------------------

test('view_customers is the Customers domain at View, decided by the catalog\'s own tenant materializer for every built-in role', () => {
  const decide = (roleId: unknown, limitation: unknown = 'none', scope: unknown = 'tenant') =>
    evaluateCanonicalPermission({ scope: scope as never, roleId: roleId as never, permission: 'view_customers', limitation: limitation as never });
  let checked = 0;
  for (const roleId of TENANT_ROLE_IDS) for (const limitation of ['none', 'read_only'] as const) {
    const level = materializeTenantPermissions(roleId, {}, limitation === 'read_only').customers;
    const expected = meetsTenantPermissionLevel(level, 'view') ? 'granted' : 'denied';
    assert.equal(decide(roleId, limitation), expected, `${roleId} ${limitation}: the materializer's answer`);
    checked += 1;
  }
  assert.equal(checked, TENANT_ROLE_IDS.length * 2);
  // Today every durable tenant role holds Customers at View or above (full/full/view/create), read-only or not.
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, 'read_only')]), [
    ['store_owner', 'granted', 'granted'], ['manager', 'granted', 'granted'], ['technician', 'granted', 'granted'], ['sales_staff', 'granted', 'granted'],
  ]);
  // The empty entitlement map removes only plan-gated domains; Customers is core, so it is never the reason for a denial.
  assert.equal(materializeTenantPermissions('manager', {}, false).repairs, 'none', 'a plan-gated domain materializes none (control)');
  assert.equal(materializeTenantPermissions('manager', {}, false).customers, 'full');
  // Fail-closed: a platform role, an unknown, custom or misspelled id, a non-string id, an unrecognised limitation.
  for (const roleId of PLATFORM_ROLE_IDS) assert.equal(decide(roleId), 'denied', `platform role ${roleId} at tenant scope`);
  for (const roleId of ['cashier', 'Manager', '', 'store_owner ', ' manager', 'STORE_OWNER', 'constructor', '__proto__', 'toString', 'custom_role']) {
    assert.equal(decide(roleId), 'denied', JSON.stringify(roleId));
  }
  for (const roleId of [null, undefined, 1, {}, ['manager'], { toString: () => 'manager' }]) assert.equal(decide(roleId), 'denied', String(roleId));
  for (const limitation of ['READ_ONLY', 'readonly', 'None', '', undefined, null, true, 0]) {
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: 'view_customers', limitation: limitation as never }),
      'denied', `limitation ${JSON.stringify(limitation)}`);
  }
  // Recognised at TENANT scope only: a store or platform scope names nothing by this key.
  assert.notEqual(canonicalPermission('tenant', 'view_customers'), null);
  for (const scope of ['store', 'platform'] as const) {
    assert.equal(canonicalPermission(scope, 'view_customers'), null, scope);
    for (const roleId of [...TENANT_ROLE_IDS, 'system_owner']) assert.equal(decide(roleId, 'none', scope), 'denied', `${scope}/${roleId}`);
  }
  // Exact and case-sensitive, like every other key.
  for (const key of ['View_Customers', 'view_customers ', 'view_customer', 'customers', 'view_customers_all']) {
    assert.equal(canonicalPermission('tenant', key), null, key);
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: key, limitation: 'none' }), 'denied', key);
  }
});

// --- M7A-CUSTOMERS-P3: create_customers, the first tenant route permission above View ---------------------------------

test('create_customers is the Customers domain at Create, decided by the same materializer; read_only denies it for every role', () => {
  const decide = (roleId: unknown, limitation: unknown = 'none', scope: unknown = 'tenant', permission = 'create_customers') =>
    evaluateCanonicalPermission({ scope: scope as never, roleId: roleId as never, permission, limitation: limitation as never });
  let checked = 0;
  for (const roleId of TENANT_ROLE_IDS) for (const limitation of ['none', 'read_only'] as const) {
    const level = materializeTenantPermissions(roleId, {}, limitation === 'read_only').customers;
    const expected = meetsTenantPermissionLevel(level, 'create') && limitation === 'none' ? 'granted' : 'denied';
    assert.equal(decide(roleId, limitation), expected, `${roleId} ${limitation}: the materializer's answer, and never under read_only`);
    checked += 1;
  }
  assert.equal(checked, TENANT_ROLE_IDS.length * 2);
  // The role defaults, unchanged: Customers full/full/view/create. A technician views customers and cannot create one.
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, 'read_only')]), [
    ['store_owner', 'granted', 'denied'], ['manager', 'granted', 'denied'], ['technician', 'denied', 'denied'], ['sales_staff', 'granted', 'denied'],
  ]);
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => decide(r, 'none', 'tenant', 'view_customers')), ['granted', 'granted', 'granted', 'granted'],
    'the technician still views (control)');
  // Fail-closed exactly as view_customers is: a platform role, an unknown or misspelled id, a non-string id, a bad limitation.
  for (const roleId of [...PLATFORM_ROLE_IDS, 'cashier', 'Manager', 'sales_staff ', 'custom_role', '__proto__', null, 1, ['manager']]) {
    assert.equal(decide(roleId), 'denied', JSON.stringify(roleId));
  }
  for (const limitation of ['READ_ONLY', 'None', '', undefined, null, true]) {
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: 'create_customers', limitation: limitation as never }),
      'denied', `limitation ${JSON.stringify(limitation)}`);
  }
  // Tenant scope only: a store or platform scope names nothing by this key, for every role.
  assert.notEqual(canonicalPermission('tenant', 'create_customers'), null);
  for (const scope of ['store', 'platform'] as const) {
    assert.equal(canonicalPermission(scope, 'create_customers'), null, scope);
    for (const roleId of [...TENANT_ROLE_IDS, 'system_owner']) {
      for (const limitation of ['none', 'read_only'] as const) assert.equal(decide(roleId, limitation, scope), 'denied', `${scope}/${roleId}/${limitation}`);
    }
  }
  for (const key of ['Create_Customers', 'create_customer', 'create_customers ', 'customers:create', 'edit_customers']) {
    assert.equal(canonicalPermission('tenant', key), null, key);
    assert.equal(decide('store_owner', 'none', 'tenant', key), 'denied', key);
  }
});

test('isDecidablePermission: every platform key and the two customer route permissions at tenant scope — nothing else', () => {
  for (const sub of PLATFORM_SUB_PERMISSIONS) assert.equal(isDecidablePermission('platform', sub.id), true, sub.id);
  for (const key of ['view_customers', 'create_customers']) {
    assert.equal(isDecidablePermission('tenant', key), true, key);
    for (const scope of ['store', 'platform'] as const) assert.equal(isDecidablePermission(scope, key), false, `${scope}/${key}`);
  }
  for (const sub of TENANT_SUB_PERMISSIONS) {
    for (const scope of ['tenant', 'store', 'platform'] as const) assert.equal(isDecidablePermission(scope, sub.id), false, `${scope}/${sub.id}`);
  }
  for (const key of ['no_such_permission', '', 'View_Customers', 'view_customers ']) {
    for (const scope of ['tenant', 'store', 'platform'] as const) assert.equal(isDecidablePermission(scope, key), false, `${scope}/${JSON.stringify(key)}`);
  }
  assert.equal(isDecidablePermission('tenant', 'view_command_center'), false, 'a platform key at tenant scope');
  for (const key of [null, undefined, 42, {}, [], ['view_customers']]) {
    for (const scope of ['tenant', 'platform'] as const) assert.equal(isDecidablePermission(scope, key), false, `${scope}/${String(key)}`);
  }
  for (const scope of ['bogus', 'TENANT', '', undefined, null]) {
    assert.equal(isDecidablePermission(scope as never, 'view_customers'), false, `scope ${String(scope)}`);
    assert.equal(isDecidablePermission(scope as never, 'view_command_center'), false, `scope ${String(scope)}`);
  }
});

test('every tenant route permission names a core domain at View or Create, is not sensitive, and never shadows a sub-permission', () => {
  assert.deepEqual([...TENANT_ROUTE_PERMISSIONS.keys()], ['view_customers', 'create_customers'], 'exactly the two customer routes the owner fixed');
  const subIds = new Set(TENANT_SUB_PERMISSIONS.map((s) => s.id));
  const THRESHOLD: Record<string, string> = { view_customers: 'view', create_customers: 'create' };
  for (const [key, entry] of TENANT_ROUTE_PERMISSIONS) {
    assert.deepEqual(entry, { key, plane: 'tenant', parent: 'customers', sensitive: false, threshold: THRESHOLD[key] });
    assert.ok(Object.isFrozen(entry), key);
    assert.ok(TENANT_PERMISSION_DOMAINS.includes(entry.parent), `${key}: its parent is a tenant domain`);
    assert.ok(Object.prototype.hasOwnProperty.call(TENANT_DOMAIN_ENTITLEMENT, entry.parent), `${key}: its parent has an entitlement entry`);
    assert.equal(TENANT_DOMAIN_ENTITLEMENT[entry.parent], null, `${key}: its parent is a core domain, never plan-gated`);
    assert.equal(subIds.has(key), false, `${key}: no sub-permission shares the key`);
    assert.equal(CANONICAL_TENANT_PERMISSIONS.has(key), false, key);
    assert.equal(canonicalPermission('tenant', key), entry, `${key}: the lookup answers this very entry`);
  }
  // A sensitive entry added to the map after load (it is frozen only at its surface) is still denied under read_only.
  // So is a non-sensitive one above View (the read_only rule: View only).
  for (const late of [
    Object.freeze({ key: 'late_sensitive_view', plane: 'tenant' as const, parent: 'customers', sensitive: true, threshold: 'view' as const }),
    Object.freeze({ key: 'late_edit', plane: 'tenant' as const, parent: 'customers', sensitive: false, threshold: 'edit' as const }),
  ]) {
    (TENANT_ROUTE_PERMISSIONS as Map<string, typeof late>).set(late.key, late);
    try {
      assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: late.key, limitation: 'none' }), 'granted', late.key);
      assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: late.key, limitation: 'read_only' }), 'denied', late.key);
    } finally {
      (TENANT_ROUTE_PERMISSIONS as Map<string, typeof late>).delete(late.key);
    }
  }
  // Every other tenant/store key is still undecidable, for every built-in tenant role and both limitations.
  for (const sub of TENANT_SUB_PERMISSIONS) for (const scope of ['tenant', 'store'] as const) {
    for (const roleId of TENANT_ROLE_IDS) for (const limitation of ['none', 'read_only'] as const) {
      assert.equal(evaluateCanonicalPermission({ scope, roleId, permission: sub.id, limitation }), 'undecidable', `${scope}/${roleId}/${sub.id}/${limitation}`);
    }
  }
});
