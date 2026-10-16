// Phase 4.0 M5-ID-P1 — the canonical route-permission catalog: exact keys, fail-closed unknowns, and
// an honest refusal to answer where GAP-11 has not been settled.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_PLATFORM_PERMISSIONS,
  CANONICAL_TENANT_PERMISSIONS,
  BUILT_IN_PLATFORM_ROLES,
  STORE_ROUTE_PERMISSIONS,
  TENANT_ROUTE_PERMISSIONS,
  assertStoreRoutePermissions,
  assertTenantRoutePermissions,
  canonicalPermission,
  evaluateCanonicalPermission,
  isDecidablePermission,
} from './m5CanonicalPermissions';
import type { PlatformRoleDefinition } from './m5CanonicalPermissions';
import {
  PLATFORM_SUB_PERMISSIONS, TENANT_DOMAIN_ENTITLEMENT, TENANT_OWNER_ROLE_ID, TENANT_PERMISSION_DOMAINS, TENANT_SUB_PERMISSIONS,
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
  // `roles` (M5-GIAM-D1-P1) and `levels` (M7A-CUSTOMERS-P3-R1) are read once too: absent here, so the built-in definitions decide.
  assert.deepEqual(reads, { scope: 1, roleId: 1, permission: 1, limitation: 1, roles: 1, levels: 1 });
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
    evaluateCanonicalPermission({ scope: scope as never, roleId: roleId as never, permission: 'view_customers', limitation: limitation as never, levels: {} });
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
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: 'view_customers', limitation: limitation as never, levels: {} }),
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
    evaluateCanonicalPermission({ scope: scope as never, roleId: roleId as never, permission, limitation: limitation as never, levels: {} });
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
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: 'create_customers', limitation: limitation as never, levels: {} }),
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
  for (const key of ['Create_Customers', 'create_customer', 'create_customers ', 'customers:create', 'update_customers']) {
    assert.equal(canonicalPermission('tenant', key), null, key);
    assert.equal(decide('store_owner', 'none', 'tenant', key), 'denied', key);
  }
});

test('edit_customers (M7A-CUSTOMERS-P7) is the Customers domain at Edit or above, decided by the same materializer; read_only denies it', () => {
  const decide = (roleId: unknown, limitation: unknown = 'none', scope: unknown = 'tenant', levels: unknown = {}) =>
    evaluateCanonicalPermission({ scope: scope as never, roleId: roleId as never, permission: 'edit_customers', limitation: limitation as never, levels });
  let checked = 0;
  for (const roleId of TENANT_ROLE_IDS) for (const limitation of ['none', 'read_only'] as const) {
    const level = materializeTenantPermissions(roleId, {}, limitation === 'read_only').customers;
    const expected = meetsTenantPermissionLevel(level, 'edit') && limitation === 'none' ? 'granted' : 'denied';
    assert.equal(decide(roleId, limitation), expected, `${roleId} ${limitation}: the materializer's answer, and never under read_only`);
    checked += 1;
  }
  assert.equal(checked, TENANT_ROLE_IDS.length * 2);
  // The role defaults, unchanged (Customers full/full/view/create): the store owner and the manager edit; the technician
  // (View) and the sales staff (Create) do not.
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, 'read_only')]), [
    ['store_owner', 'granted', 'denied'], ['manager', 'granted', 'denied'], ['technician', 'denied', 'denied'], ['sales_staff', 'denied', 'denied'],
  ]);
  // Owner-edited levels decide it: every level on the tenant family ordering, for a non-owner role; Edit or above grants.
  const EXPECTED: Record<string, string> = { none: 'denied', view: 'denied', create: 'denied', edit: 'granted', manage: 'granted', approve: 'granted', full: 'granted' };
  for (const roleId of ['manager', 'technician', 'sales_staff']) for (const [level, expected] of Object.entries(EXPECTED)) {
    assert.equal(decide(roleId, 'none', 'tenant', { customers: level }), expected, `${roleId} edited to ${level}`);
    assert.equal(decide(roleId, 'read_only', 'tenant', { customers: level }), 'denied', `${roleId} edited to ${level}, read_only`);
  }
  assert.equal(decide('store_owner', 'none', 'tenant', { customers: 'view' }), 'granted', 'the owner ignores edits (store_owner is Full)');
  // Edits that are missing or malformed deny, even the owner (undefined is covered for every key by R3 below).
  for (const levels of [null, [], { customers: 'Edit' }, { customer: 'full' }]) {
    assert.equal(decide('store_owner', 'none', 'tenant', levels), 'denied', JSON.stringify(levels));
  }
  // Fail-closed exactly as create_customers is: a platform role, an unknown or misspelled id, a non-string id, a bad limitation.
  for (const roleId of [...PLATFORM_ROLE_IDS, 'cashier', 'Manager', 'manager ', 'custom_role', '__proto__', null, 1, ['manager']]) {
    assert.equal(decide(roleId), 'denied', JSON.stringify(roleId));
  }
  for (const limitation of ['READ_ONLY', 'None', '', undefined, null, true]) {
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: 'edit_customers', limitation: limitation as never, levels: {} }),
      'denied', `limitation ${JSON.stringify(limitation)}`);
  }
  // Tenant scope only.
  assert.notEqual(canonicalPermission('tenant', 'edit_customers'), null);
  for (const scope of ['store', 'platform'] as const) {
    assert.equal(canonicalPermission(scope, 'edit_customers'), null, scope);
    for (const roleId of [...TENANT_ROLE_IDS, 'system_owner']) {
      for (const limitation of ['none', 'read_only'] as const) assert.equal(decide(roleId, limitation, scope), 'denied', `${scope}/${roleId}/${limitation}`);
    }
  }
  for (const key of ['Edit_Customers', 'edit_customer', 'edit_customers ', 'customers:edit', 'update_customers']) {
    assert.equal(canonicalPermission('tenant', key), null, key);
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: key, limitation: 'none', levels: {} }), 'denied', key);
  }
});

test('isDecidablePermission: every platform key, the five tenant route permissions at tenant scope and the six store route permissions at store scope — nothing else', () => {
  for (const sub of PLATFORM_SUB_PERMISSIONS) assert.equal(isDecidablePermission('platform', sub.id), true, sub.id);
  for (const key of ['view_invoice_drafts', 'create_invoice_drafts', 'edit_invoice_drafts', 'discard_invoice_drafts', 'issue_invoices', 'view_issued_invoices']) {
    assert.equal(isDecidablePermission('store', key), true, key);
    for (const scope of ['tenant', 'platform'] as const) assert.equal(isDecidablePermission(scope, key), false, `${scope}/${key}`);
  }
  for (const key of ['view_customers', 'create_customers', 'edit_customers', 'edit_role_levels', 'edit_issuing_settings']) {
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

test('every level-decided tenant route permission names a core domain at View, Create or Edit, is not sensitive, and none shadows a sub-permission', () => {
  assert.deepEqual([...TENANT_ROUTE_PERMISSIONS.keys()], ['view_customers', 'create_customers', 'edit_customers', 'edit_role_levels', 'edit_issuing_settings'],
    'exactly the three customer routes the owner fixed (M7A-CUSTOMERS-P7: edit), the owner-only role edit (M7A-CUSTOMERS-P3-R1) and the owner-only issuing settings (M7B-INVOICES-ISSUE-P1)');
  const subIds = new Set(TENANT_SUB_PERMISSIONS.map((s) => s.id));
  const THRESHOLD: Record<string, string> = { view_customers: 'view', create_customers: 'create', edit_customers: 'edit' };
  // The owner-only edit: sensitive, its parent and threshold descriptive (the owner rule decides it, never a level).
  const edit = TENANT_ROUTE_PERMISSIONS.get('edit_role_levels');
  assert.deepEqual(edit, { key: 'edit_role_levels', plane: 'tenant', parent: 'employees', sensitive: true, threshold: 'full' });
  assert.ok(Object.isFrozen(edit) && !subIds.has('edit_role_levels') && !CANONICAL_TENANT_PERMISSIONS.has('edit_role_levels'));
  // M7B-INVOICES-ISSUE-P1: the second owner-only key, sensitive at Full; its parent a core domain the owner always materializes.
  const settings = TENANT_ROUTE_PERMISSIONS.get('edit_issuing_settings');
  assert.deepEqual(settings, { key: 'edit_issuing_settings', plane: 'tenant', parent: 'invoices', sensitive: true, threshold: 'full' });
  assert.ok(Object.isFrozen(settings) && !subIds.has('edit_issuing_settings') && !CANONICAL_TENANT_PERMISSIONS.has('edit_issuing_settings'));
  assert.ok(TENANT_PERMISSION_DOMAINS.includes('invoices') && TENANT_DOMAIN_ENTITLEMENT.invoices === null, 'Invoices: a core domain, never plan-gated');
  for (const [key, entry] of TENANT_ROUTE_PERMISSIONS) {
    if (key === 'edit_role_levels' || key === 'edit_issuing_settings') continue;
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
      assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: late.key, limitation: 'none', levels: {} }), 'granted', late.key);
      assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: late.key, limitation: 'read_only', levels: {} }), 'denied', late.key);
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

// --- M7A-CUSTOMERS-P3-R1: the role's current definition, and the owner rule ----------------------------------------------

test('R3: a tenant route permission is decided on the role\'s durable edits, which are REQUIRED — missing or malformed denies', () => {
  const decide = (roleId: string, permission: string, levels: unknown, limitation: 'none' | 'read_only' = 'none') =>
    evaluateCanonicalPermission({ scope: 'tenant', roleId, permission, limitation, levels });
  // No edits read is not "no edits": every built-in role, every tenant route permission.
  for (const roleId of TENANT_ROLE_IDS) for (const permission of TENANT_ROUTE_PERMISSIONS.keys()) {
    for (const levels of [undefined, null, [], 'customers', 7, new Map([['customers', 'full']]), Object.create({ customers: 'full' })]) {
      assert.equal(decide(roleId, permission, levels), 'denied', `${roleId}/${permission}/${String(levels)}`);
    }
  }
  // A malformed edit denies even the owner and even at the default: an unknown domain, a non-canonical level, a symbol key.
  for (const levels of [{ customer: 'full' }, { customers: 'Full' }, { customers: '' }, { customers: null }, { [Symbol('customers')]: 'full' }]) {
    for (const roleId of TENANT_ROLE_IDS) assert.equal(decide(roleId, 'view_customers', levels), 'denied', `${roleId} ${String(Object.keys(levels))}`);
  }
  // An edit replaces the default for the domain it names — narrowing or widening — and a prototype-less record reads the same.
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r, 'create_customers', { customers: 'view' }), decide(r, 'view_customers', { customers: 'none' })]), [
    ['store_owner', 'granted', 'granted'], ['manager', 'denied', 'denied'], ['technician', 'denied', 'denied'], ['sales_staff', 'denied', 'denied'],
  ], 'narrowed: every role but the owner');
  assert.equal(decide('technician', 'create_customers', Object.assign(Object.create(null), { customers: 'create' })), 'granted', 'widened');
  assert.equal(decide('sales_staff', 'create_customers', { sales: 'none', customers: 'create' }), 'granted', 'another domain leaves Customers alone');
  // The read-only cap still applies after an edit.
  assert.equal(decide('technician', 'view_customers', { customers: 'full' }, 'read_only'), 'granted');
  assert.equal(decide('technician', 'create_customers', { customers: 'full' }, 'read_only'), 'denied');
  // Platform decisions ignore `levels` entirely.
  assert.equal(evaluateCanonicalPermission({ scope: 'platform', roleId: 'system_owner', permission: 'view_command_center', limitation: 'none', levels: 'x' }), 'granted');
});

test('R2: edit_role_levels is the OWNER RULE — the owner role at limitation none, whatever any role\'s levels say', () => {
  const decide = (roleId: unknown, limitation: unknown = 'none', levels: unknown = {}, scope: unknown = 'tenant') =>
    evaluateCanonicalPermission({ scope: scope as never, roleId: roleId as never, permission: 'edit_role_levels', limitation: limitation as never, levels });
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, 'read_only')]), [
    ['store_owner', 'granted', 'denied'], ['manager', 'denied', 'denied'], ['technician', 'denied', 'denied'], ['sales_staff', 'denied', 'denied'],
  ]);
  assert.equal(TENANT_OWNER_ROLE_ID, 'store_owner', 'the catalog\'s one owner role');
  assert.equal(decide('manager', 'none', { customers: 'full' }), 'denied', 'a widened level never makes a role the owner');
  assert.equal(decide('store_owner', 'none', { customers: 'bogus' }), 'denied', 'an owner whose edits are unreadable is denied');
  assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId: 'store_owner', permission: 'edit_role_levels', limitation: 'none' }), 'denied',
    'and so is one with none read');
  for (const roleId of [...PLATFORM_ROLE_IDS, 'owner', 'Store_Owner', 'store_owner ', null]) assert.equal(decide(roleId), 'denied', String(roleId));
  for (const scope of ['store', 'platform'] as const) assert.equal(decide('store_owner', 'none', {}, scope), 'denied', scope);
  assert.equal(canonicalPermission('tenant', 'edit_role_levels')?.sensitive, true);
});

test('the catalog materializer applies edits before the entitlement gate and the read-only cap; the owner ignores them; existing callers are unchanged', () => {
  for (const roleId of TENANT_ROLE_IDS) {
    for (const limited of [false, true]) {
      assert.deepEqual(materializeTenantPermissions(roleId, {}, limited, {}), materializeTenantPermissions(roleId, {}, limited), `${roleId} ${limited}: {} is the default`);
    }
  }
  assert.equal(materializeTenantPermissions('sales_staff', {}, false, { customers: 'none' }).customers, 'none');
  assert.equal(materializeTenantPermissions('technician', {}, false, { customers: 'full' }).customers, 'full');
  assert.equal(materializeTenantPermissions('technician', {}, true, { customers: 'full' }).customers, 'view', 'capped for read-only after the edit');
  assert.equal(materializeTenantPermissions('sales_staff', {}, false, { repairs: 'full' }).repairs, 'none', 'a plan-gated domain stays gated after the edit');
  assert.equal(materializeTenantPermissions('store_owner', {}, false, { customers: 'none' }).customers, 'full', 'the owner ignores edits');
  assert.deepEqual(materializeTenantPermissions('manager', {}, false, { customers: 'writer' }), {}, 'a malformed edit materializes nothing');
  assert.deepEqual(materializeTenantPermissions('manager', {}, false, null), {}, 'an unreadable edit is not "no edit"');
});

test('M5-INVOICES-AUTH-P1: a stored Invoices level is materialized as the edit says, defaults without it, and never moves a Customers decision (nor the reverse)', () => {
  const levelOf = (role: string, levels: unknown, domain: string) => materializeTenantPermissions(role, {}, false, levels)[domain];
  for (const [role, level] of [['manager', 'full'], ['technician', 'view'], ['sales_staff', 'create'], ['store_owner', 'full']] as const) {
    assert.equal(levelOf(role, {}, 'invoices'), level, `${role} default`);
  }
  for (const role of ['manager', 'technician', 'sales_staff']) {
    for (const level of ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full']) assert.equal(levelOf(role, { invoices: level }, 'invoices'), level, `${role}/${level}`);
  }
  assert.equal(levelOf('store_owner', { invoices: 'none' }, 'invoices'), 'full', 'the owner is fixed');
  for (const role of ['manager', 'technician', 'sales_staff']) {
    assert.equal(levelOf(role, { invoices: 'none' }, 'customers'), levelOf(role, {}, 'customers'), `${role}: an Invoices edit leaves Customers at its default`);
    assert.equal(levelOf(role, { customers: 'none' }, 'invoices'), levelOf(role, {}, 'invoices'), `${role}: a Customers edit leaves Invoices at its default`);
    for (const permission of ['view_customers', 'create_customers', 'edit_customers']) {
      for (const invoices of ['none', 'view', 'create', 'edit', 'full']) {
        for (const customers of [undefined, 'none', 'view', 'create', 'edit', 'full']) {
          const base = customers === undefined ? {} : { customers };
          assert.equal(
            evaluateCanonicalPermission({ scope: 'tenant', roleId: role, permission, limitation: 'none', levels: { ...base, invoices } }),
            evaluateCanonicalPermission({ scope: 'tenant', roleId: role, permission, limitation: 'none', levels: base }),
            `${role}/${permission}/customers=${String(customers)}: invoices=${invoices} changes nothing`,
          );
        }
      }
    }
  }
  // No LEVEL-decided tenant route permission names Invoices: configuration only. The one that names it (M7B-INVOICES-ISSUE-P1)
  // is the owner-only edit_issuing_settings, decided by role, never by the Invoices level — which changes nothing for it either.
  assert.deepEqual([...TENANT_ROUTE_PERMISSIONS.values()].filter((e) => e.parent === 'invoices').map((e) => e.key), ['edit_issuing_settings']);
  for (const roleId of TENANT_ROLE_IDS) for (const invoices of ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full']) {
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId, permission: 'edit_issuing_settings', limitation: 'none', levels: { invoices } }),
      roleId === 'store_owner' ? 'granted' : 'denied', `${roleId} invoices=${invoices}`);
  }
  for (const levels of [{ invoices: 'Full' }, { invoices: null }, { invoices: '' }, { Invoices: 'view' }, { invoice: 'view' }, { customers: 'view', invoices: 'x' }, null, [], 'invoices']) {
    for (const roleId of TENANT_ROLE_IDS) {
      assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId, permission: 'view_customers', limitation: 'none', levels }), 'denied', `${roleId} ${JSON.stringify(levels)}`);
    }
    assert.deepEqual(materializeTenantPermissions('manager', {}, false, levels), {});
  }
  for (const roleId of ['cashier', 'Manager', '', 'system_owner', 'store_owner_2']) {
    assert.deepEqual(materializeTenantPermissions(roleId, {}, false, { invoices: 'full' }), {}, roleId);
    assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId, permission: 'view_customers', limitation: 'none', levels: { invoices: 'full' } }), 'denied', roleId);
  }
  assert.equal(materializeTenantPermissions('manager', {}, true, { invoices: 'full' }).invoices, 'view');
});

// --- M7B-INVOICES-P1: the store route permissions ------------------------------------------------------------------------

test('M7B: exactly six store route permissions, decided at store scope only, non-sensitive, none shadowing a tenant key', () => {
  assert.deepEqual([...STORE_ROUTE_PERMISSIONS.keys()],
    ['view_invoice_drafts', 'create_invoice_drafts', 'edit_invoice_drafts', 'discard_invoice_drafts', 'issue_invoices', 'view_issued_invoices']);
  assert.deepEqual(STORE_ROUTE_PERMISSIONS.get('view_invoice_drafts'),
    { key: 'view_invoice_drafts', plane: 'tenant', parent: 'invoices', sensitive: false, threshold: 'view' });
  assert.deepEqual(STORE_ROUTE_PERMISSIONS.get('create_invoice_drafts'),
    { key: 'create_invoice_drafts', plane: 'tenant', parent: 'invoices', sensitive: false, threshold: 'create', corequisite: { parent: 'customers', threshold: 'view' } });
  // M7B-INVOICES-P2: Invoices at Edit, and no corequisite (design D1).
  assert.deepEqual(STORE_ROUTE_PERMISSIONS.get('edit_invoice_drafts'),
    { key: 'edit_invoice_drafts', plane: 'tenant', parent: 'invoices', sensitive: false, threshold: 'edit' });
  // M7B-INVOICES-DISCARD-P1 (D-DIS-2): Invoices at Manage, and no corequisite.
  assert.deepEqual(STORE_ROUTE_PERMISSIONS.get('discard_invoice_drafts'),
    { key: 'discard_invoice_drafts', plane: 'tenant', parent: 'invoices', sensitive: false, threshold: 'manage' });
  // M7B-INVOICES-ISSUE-P1 (doc 12 §10.2): the issue at Invoices Approve, the issued reads at Invoices View, each with Customers View.
  assert.deepEqual(STORE_ROUTE_PERMISSIONS.get('issue_invoices'),
    { key: 'issue_invoices', plane: 'tenant', parent: 'invoices', sensitive: false, threshold: 'approve', corequisite: { parent: 'customers', threshold: 'view' } });
  assert.deepEqual(STORE_ROUTE_PERMISSIONS.get('view_issued_invoices'),
    { key: 'view_issued_invoices', plane: 'tenant', parent: 'invoices', sensitive: false, threshold: 'view', corequisite: { parent: 'customers', threshold: 'view' } });
  const subIds = new Set(TENANT_SUB_PERMISSIONS.map((sub) => sub.id));
  for (const [key, entry] of STORE_ROUTE_PERMISSIONS) {
    assert.ok(Object.isFrozen(entry) && (entry.corequisite === undefined || Object.isFrozen(entry.corequisite)), key);
    assert.equal(subIds.has(key), false, `${key}: no sub-permission shares the key (reopen_invoice is not reused)`);
    assert.equal(TENANT_ROUTE_PERMISSIONS.has(key), false, key);
    assert.equal(canonicalPermission('store', key), entry, `${key}: the store lookup answers this very entry`);
    assert.equal(canonicalPermission('tenant', key), null, `${key}: names nothing at tenant scope`);
    assert.equal(canonicalPermission('platform', key), null, `${key}: names nothing at platform scope`);
    assert.ok(TENANT_PERMISSION_DOMAINS.includes(entry.parent) && TENANT_DOMAIN_ENTITLEMENT[entry.parent] === null, `${key}: a core domain, never plan-gated`);
    for (const roleId of TENANT_ROLE_IDS) {
      assert.equal(evaluateCanonicalPermission({ scope: 'tenant', roleId, permission: key, limitation: 'none', levels: {} }), 'denied', `${key} at tenant scope`);
    }
  }
  // The tenant route permissions still decide nothing at store scope.
  for (const key of TENANT_ROUTE_PERMISSIONS.keys()) {
    assert.equal(canonicalPermission('store', key), null, key);
    assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'store_owner', permission: key, limitation: 'none', levels: {} }), 'denied', key);
  }
});

test('M7B: the store route permissions on every built-in role, both limitations, at the defaults and under the owner\'s edits — Customers View is the create\'s corequisite', () => {
  const decide = (roleId: string, permission: string, levels: unknown = {}, limitation: 'none' | 'read_only' = 'none') =>
    evaluateCanonicalPermission({ scope: 'store', roleId, permission, limitation, levels });
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r, 'view_invoice_drafts'), decide(r, 'create_invoice_drafts'),
    decide(r, 'view_invoice_drafts', {}, 'read_only'), decide(r, 'create_invoice_drafts', {}, 'read_only')]), [
    ['store_owner', 'granted', 'granted', 'granted', 'denied'],
    ['manager', 'granted', 'granted', 'granted', 'denied'],
    ['technician', 'granted', 'denied', 'granted', 'denied'],
    ['sales_staff', 'granted', 'granted', 'granted', 'denied'],
  ], 'Invoices View for every role; Create for owner, manager and sales staff; read-only reaches View alone');
  // Each condition denies alone, the owner excepted.
  for (const levels of [{ invoices: 'view' }, { customers: 'none' }, { invoices: 'none' }, { invoices: 'create', customers: 'none' }]) {
    assert.equal(decide('manager', 'create_invoice_drafts', levels), 'denied', JSON.stringify(levels));
    assert.equal(decide('store_owner', 'create_invoice_drafts', levels), 'granted', `owner ${JSON.stringify(levels)}`);
  }
  for (const level of ['create', 'edit', 'manage', 'approve', 'full']) {
    assert.equal(decide('technician', 'create_invoice_drafts', { invoices: level }), 'granted', `technician invoices=${level}`);
  }
  for (const level of ['view', 'create', 'edit', 'manage', 'approve', 'full']) {
    assert.equal(decide('sales_staff', 'create_invoice_drafts', { customers: level }), 'granted', `sales staff customers=${level}`);
  }
  assert.equal(decide('manager', 'view_invoice_drafts', { invoices: 'none' }), 'denied');
  assert.equal(decide('manager', 'view_invoice_drafts', { customers: 'none' }), 'granted', 'View needs no Customers level');
  // Levels are required and validated; unknown roles and limitations deny.
  for (const levels of [null, [], 'x', { invoices: 'Full' }, { invoice: 'view' }]) {
    for (const permission of STORE_ROUTE_PERMISSIONS.keys()) assert.equal(decide('manager', permission, levels), 'denied', `${permission} ${JSON.stringify(levels)}`);
  }
  for (const permission of STORE_ROUTE_PERMISSIONS.keys()) {
    assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'store_owner', permission, limitation: 'none' }), 'denied', `${permission}: no edits read`);
  }
  for (const roleId of ['system_owner', 'cashier', '', 'Manager']) assert.equal(decide(roleId, 'view_invoice_drafts'), 'denied', roleId);
  assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'manager', permission: 'view_invoice_drafts', limitation: 'limited' as never, levels: {} }), 'denied');
  // The parity the 028 routine restates: Invoices and Customers defaults from the one catalog.
  for (const roleId of ['manager', 'technician', 'sales_staff']) {
    assert.equal(materializeTenantPermissions(roleId, {}, false, {}).invoices, ({ manager: 'full', technician: 'view', sales_staff: 'create' } as Record<string, string>)[roleId]);
    assert.ok(meetsTenantPermissionLevel(materializeTenantPermissions(roleId, {}, false, {}).customers, 'view'), `${roleId}: Customers View by default`);
  }
});

test('M7B-INVOICES-P2: edit_invoice_drafts is Invoices at Edit or above on every built-in role, the owner\'s edits decide, Customers never matters, read-only never reaches it', () => {
  const decide = (roleId: string, levels: unknown = {}, limitation: 'none' | 'read_only' = 'none') =>
    evaluateCanonicalPermission({ scope: 'store', roleId, permission: 'edit_invoice_drafts', limitation, levels });
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, {}, 'read_only')]), [
    ['store_owner', 'granted', 'denied'],
    ['manager', 'granted', 'denied'],
    ['technician', 'denied', 'denied'],
    ['sales_staff', 'denied', 'denied'],
  ], 'Edit for owner and manager by default; technician (View) and sales staff (Create) refused; read-only never');
  const LEVELS = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  for (const roleId of ['manager', 'technician', 'sales_staff']) {
    for (const level of LEVELS) {
      const expected = ['edit', 'manage', 'approve', 'full'].includes(level) ? 'granted' : 'denied';
      for (const customers of [undefined, 'none', 'full']) {
        const levels = customers === undefined ? { invoices: level } : { invoices: level, customers };
        assert.equal(decide(roleId, levels), expected, `${roleId} ${JSON.stringify(levels)}`);
        assert.equal(decide(roleId, levels, 'read_only'), 'denied', `${roleId} read_only ${JSON.stringify(levels)}`);
      }
    }
  }
  // The owner is Full wherever it holds a store grant: an edit stored against store_owner never applies.
  assert.equal(decide('store_owner', { invoices: 'none', customers: 'none' }), 'granted');
  // Create eligibility is not Edit: a Create-level role passes the create and is refused the edit, at the same levels.
  for (const levels of [{}, { invoices: 'create' }]) {
    assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'sales_staff', permission: 'create_invoice_drafts', limitation: 'none', levels }), 'granted');
    assert.equal(decide('sales_staff', levels), 'denied', JSON.stringify(levels));
  }
  // Only at store scope: the key names nothing at tenant or platform scope.
  for (const scope of ['tenant', 'platform'] as const) {
    assert.equal(evaluateCanonicalPermission({ scope, roleId: 'store_owner', permission: 'edit_invoice_drafts', limitation: 'none', levels: {} }), 'denied', scope);
  }
});

// --- M7B-INVOICES-DISCARD-P1: discard_invoice_drafts at Invoices Manage, and the narrowly widened guard ---------------------

test('M7B-INVOICES-DISCARD-P1 DSC-23 (D-DIS-2): the load-time guard admits Manage for exactly discard_invoice_drafts on Invoices with no corequisite — any other key at Manage, that key at any other threshold or domain, a corequisite, a sensitive entry, and Approve or Full anywhere are refused', () => {
  assert.doesNotThrow(() => assertStoreRoutePermissions(STORE_ROUTE_PERMISSIONS), 'the shipped table loads');
  const entry = (key: string, threshold: string, over: Record<string, unknown> = {}) =>
    Object.freeze({ key, plane: 'tenant' as const, parent: 'invoices', sensitive: false, threshold, ...over });
  const discard = STORE_ROUTE_PERMISSIONS.get('discard_invoice_drafts');
  assert.ok(discard !== undefined);
  const without = [...STORE_ROUTE_PERMISSIONS].filter(([key]) => key !== 'discard_invoice_drafts');
  const table = (...extra: Array<[string, unknown]>) => new Map([...without, ...extra]) as never;
  // Controls: the table without the discard, and with exactly the discard pair re-added, both load.
  assert.doesNotThrow(() => assertStoreRoutePermissions(table()), 'View, Create and Edit stay the general rule');
  assert.doesNotThrow(() => assertStoreRoutePermissions(table(['discard_invoice_drafts', entry('discard_invoice_drafts', 'manage')])), 'the one Manage pair');
  for (const [label, extra] of [
    ['another key at Manage', ['archive_invoice_drafts', entry('archive_invoice_drafts', 'manage')]],
    ['another key at Manage beside the discard', ['archive_invoice_drafts', entry('archive_invoice_drafts', 'manage')]],
    ['the discard at Edit', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'edit')]],
    ['the discard at View', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'view')]],
    ['the discard at Create', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'create')]],
    ['the discard at Approve', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'approve')]],
    ['the discard at Full', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'full')]],
    ['the discard on Customers', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'manage', { parent: 'customers' })]],
    ['the discard with a Customers corequisite', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'manage', { corequisite: Object.freeze({ parent: 'customers', threshold: 'view' }) })]],
    ['the discard sensitive', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'manage', { sensitive: true })]],
    ['the discard pair under another entry key', ['discard_invoice_drafts', entry('edit_invoice_drafts', 'manage')]],
    ['the discard with no threshold', ['discard_invoice_drafts', entry('discard_invoice_drafts', null as never)]],
    ['another key at Approve', ['approve_invoice_drafts', entry('approve_invoice_drafts', 'approve')]],
    ['another key at Full', ['purge_invoice_drafts', entry('purge_invoice_drafts', 'full')]],
    ['the edit at Manage', ['edit_invoice_drafts', entry('edit_invoice_drafts', 'manage')]],
  ] as const) {
    const extras: Array<[string, unknown]> = label === 'another key at Manage beside the discard'
      ? [['discard_invoice_drafts', discard], extra as [string, unknown]] : [extra as [string, unknown]];
    assert.throws(() => assertStoreRoutePermissions(table(...extras)), /not a non-sensitive View, Create or Edit threshold, nor discard_invoice_drafts at Invoices Manage/, label);
  }
  // The other guards still hold for the new entry's neighbours.
  assert.throws(() => assertStoreRoutePermissions(table(['view_customers', entry('view_customers', 'view', { parent: 'customers' })])), /collides with a tenant permission/);
});

test('M7B-INVOICES-DISCARD-P1 DSC-02 (D-DIS-2): discard_invoice_drafts is Invoices at Manage or above on every built-in role — Edit denies, Manage, Approve and Full allow, the owner and a default manager allow, read-only never, Customers never matters', () => {
  const decide = (roleId: string, levels: unknown = {}, limitation: 'none' | 'read_only' = 'none') =>
    evaluateCanonicalPermission({ scope: 'store', roleId, permission: 'discard_invoice_drafts', limitation, levels });
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, {}, 'read_only')]), [
    ['store_owner', 'granted', 'denied'],
    ['manager', 'granted', 'denied'],
    ['technician', 'denied', 'denied'],
    ['sales_staff', 'denied', 'denied'],
  ], 'the owner and a default manager (Full) may discard; technician (View) and sales staff (Create) may not; read-only never');
  const LEVELS = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  for (const roleId of ['manager', 'technician', 'sales_staff']) {
    for (const level of LEVELS) {
      const expected = ['manage', 'approve', 'full'].includes(level) ? 'granted' : 'denied';
      for (const customers of [undefined, 'none', 'full']) {
        const levels = customers === undefined ? { invoices: level } : { invoices: level, customers };
        assert.equal(decide(roleId, levels), expected, `${roleId} ${JSON.stringify(levels)}`);
        assert.equal(decide(roleId, levels, 'read_only'), 'denied', `${roleId} read_only ${JSON.stringify(levels)}`);
      }
    }
  }
  // Edit alone does not discard: a manager the owner set to Edit edits and is refused the discard — the role's name grants nothing.
  assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'manager', permission: 'edit_invoice_drafts', limitation: 'none', levels: { invoices: 'edit' } }), 'granted');
  assert.equal(decide('manager', { invoices: 'edit' }), 'denied');
  // The owner is Full wherever it holds a store grant: an edit stored against store_owner never applies.
  assert.equal(decide('store_owner', { invoices: 'none', customers: 'none' }), 'granted');
  // Levels are required and validated; unknown roles and limitations deny; only at store scope.
  for (const levels of [null, [], 'x', { invoices: 'Manage' }, { invoice: 'full' }]) assert.equal(decide('manager', levels), 'denied', JSON.stringify(levels));
  for (const roleId of ['system_owner', 'cashier', '', 'Manager']) assert.equal(decide(roleId), 'denied', roleId);
  assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'manager', permission: 'discard_invoice_drafts', limitation: 'limited' as never, levels: {} }), 'denied');
  for (const scope of ['tenant', 'platform'] as const) {
    assert.equal(evaluateCanonicalPermission({ scope, roleId: 'store_owner', permission: 'discard_invoice_drafts', limitation: 'none', levels: {} }), 'denied', scope);
    assert.equal(canonicalPermission(scope, 'discard_invoice_drafts'), null, scope);
  }
});

// --- M7B-INVOICES-ISSUE-P1: issue_invoices at Invoices Approve, view_issued_invoices, and the owner-only issuing settings ----

test('M7B-INVOICES-ISSUE-P1 (§10.2): the store guard admits Approve for exactly issue_invoices on Invoices with exactly a Customers View corequisite — any other key at Approve, that key at any other threshold, domain or corequisite, a sensitive entry, and Full anywhere are refused', () => {
  assert.doesNotThrow(() => assertStoreRoutePermissions(STORE_ROUTE_PERMISSIONS), 'the shipped table loads');
  const CUSTOMERS_VIEW = Object.freeze({ parent: 'customers', threshold: 'view' });
  const entry = (key: string, threshold: string, over: Record<string, unknown> = {}) =>
    Object.freeze({ key, plane: 'tenant' as const, parent: 'invoices', sensitive: false, threshold, corequisite: CUSTOMERS_VIEW, ...over });
  const without = [...STORE_ROUTE_PERMISSIONS].filter(([key]) => key !== 'issue_invoices');
  const table = (...extra: Array<[string, unknown]>) => new Map([...without, ...extra]) as never;
  assert.doesNotThrow(() => assertStoreRoutePermissions(table()), 'the table without the issue loads');
  assert.doesNotThrow(() => assertStoreRoutePermissions(table(['issue_invoices', entry('issue_invoices', 'approve')])), 'the one Approve entry');
  const { corequisite: _none, ...bare } = entry('issue_invoices', 'approve');
  for (const [label, extra] of [
    ['another key at Approve', ['approve_invoices', entry('approve_invoices', 'approve')]],
    ['another key at Approve without a corequisite', ['approve_invoices', entry('approve_invoices', 'approve', { corequisite: undefined })]],
    ['the issue at View', ['issue_invoices', entry('issue_invoices', 'view')]],
    ['the issue at Create', ['issue_invoices', entry('issue_invoices', 'create')]],
    ['the issue at Edit', ['issue_invoices', entry('issue_invoices', 'edit')]],
    ['the issue at Manage', ['issue_invoices', entry('issue_invoices', 'manage')]],
    ['the issue at Full', ['issue_invoices', entry('issue_invoices', 'full')]],
    ['the issue with no threshold', ['issue_invoices', entry('issue_invoices', null as never)]],
    ['the issue without its corequisite', ['issue_invoices', Object.freeze(bare)]],
    ['the issue with a Customers Create corequisite', ['issue_invoices', entry('issue_invoices', 'approve', { corequisite: Object.freeze({ parent: 'customers', threshold: 'create' }) })]],
    ['the issue with an Employees View corequisite', ['issue_invoices', entry('issue_invoices', 'approve', { corequisite: Object.freeze({ parent: 'employees', threshold: 'view' }) })]],
    ['the issue on Customers', ['issue_invoices', entry('issue_invoices', 'approve', { parent: 'customers' })]],
    ['the issue sensitive', ['issue_invoices', entry('issue_invoices', 'approve', { sensitive: true })]],
    ['the issue under another entry key', ['issue_invoices', entry('view_issued_invoices', 'approve')]],
    ['the discard at Approve', ['discard_invoice_drafts', entry('discard_invoice_drafts', 'approve', { corequisite: undefined })]],
    ['the issued reads at Approve', ['view_issued_invoices', entry('view_issued_invoices', 'approve')]],
    ['another key at Full', ['purge_invoices', entry('purge_invoices', 'full')]],
  ] as const) {
    assert.throws(() => assertStoreRoutePermissions(table(extra as [string, unknown])),
      /not a non-sensitive View, Create or Edit threshold, nor discard_invoice_drafts at Invoices Manage, nor issue_invoices at Invoices Approve with Customers View/, label);
  }
  // The corequisite rule still holds for a View entry: Customers View on another domain, never on Invoices itself.
  assert.throws(() => assertStoreRoutePermissions(table(['view_issued_invoices', entry('view_issued_invoices', 'view', { corequisite: Object.freeze({ parent: 'invoices', threshold: 'view' }) })])),
    /corequisite is not View on another domain/);
});

test('M7B-INVOICES-ISSUE-P1 (§10.2): issue_invoices is Invoices at Approve or above AND Customers at View or above on every built-in role — Manage denies, Customers None denies, read-only never, the owner always', () => {
  const decide = (roleId: string, levels: unknown = {}, limitation: 'none' | 'read_only' = 'none') =>
    evaluateCanonicalPermission({ scope: 'store', roleId, permission: 'issue_invoices', limitation, levels });
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, {}, 'read_only')]), [
    ['store_owner', 'granted', 'denied'],
    ['manager', 'granted', 'denied'],
    ['technician', 'denied', 'denied'],
    ['sales_staff', 'denied', 'denied'],
  ], 'the owner and a default manager (Invoices Full) may issue; technician (View) and sales staff (Create) may not; read-only never');
  const LEVELS = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  for (const roleId of ['manager', 'technician', 'sales_staff']) {
    for (const invoices of LEVELS) for (const customers of LEVELS) {
      const expected = ['approve', 'full'].includes(invoices) && customers !== 'none' ? 'granted' : 'denied';
      assert.equal(decide(roleId, { invoices, customers }), expected, `${roleId} invoices=${invoices} customers=${customers}`);
      assert.equal(decide(roleId, { invoices, customers }, 'read_only'), 'denied', `${roleId} read_only invoices=${invoices} customers=${customers}`);
    }
  }
  // Manage (the discard's threshold) alone does not issue; the role's name grants nothing.
  assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'manager', permission: 'discard_invoice_drafts', limitation: 'none', levels: { invoices: 'manage' } }), 'granted');
  assert.equal(decide('manager', { invoices: 'manage' }), 'denied');
  assert.equal(decide('store_owner', { invoices: 'none', customers: 'none' }), 'granted', 'the owner is Full wherever it holds a store grant');
  for (const levels of [null, [], 'x', { invoices: 'Approve' }, { invoice: 'full' }]) assert.equal(decide('manager', levels), 'denied', JSON.stringify(levels));
  assert.equal(evaluateCanonicalPermission({ scope: 'store', roleId: 'store_owner', permission: 'issue_invoices', limitation: 'none' }), 'denied', 'no edits read');
  for (const roleId of ['system_owner', 'cashier', '', 'Manager']) assert.equal(decide(roleId), 'denied', roleId);
  for (const scope of ['tenant', 'platform'] as const) {
    assert.equal(evaluateCanonicalPermission({ scope, roleId: 'store_owner', permission: 'issue_invoices', limitation: 'none', levels: {} }), 'denied', scope);
    assert.equal(canonicalPermission(scope, 'issue_invoices'), null, scope);
  }
});

test('M7B-INVOICES-ISSUE-P1 (§10.2): view_issued_invoices is Invoices at View AND Customers at View — reachable read-only, denied without either', () => {
  const decide = (roleId: string, levels: unknown = {}, limitation: 'none' | 'read_only' = 'none') =>
    evaluateCanonicalPermission({ scope: 'store', roleId, permission: 'view_issued_invoices', limitation, levels });
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide(r), decide(r, {}, 'read_only')]), [
    ['store_owner', 'granted', 'granted'], ['manager', 'granted', 'granted'], ['technician', 'granted', 'granted'], ['sales_staff', 'granted', 'granted'],
  ], 'every role holds Invoices and Customers at View by default; the read is reachable read-only');
  for (const roleId of ['manager', 'technician', 'sales_staff']) {
    assert.equal(decide(roleId, { invoices: 'none' }), 'denied', `${roleId}: Invoices None`);
    assert.equal(decide(roleId, { customers: 'none' }), 'denied', `${roleId}: Customers None (the corequisite)`);
    assert.equal(decide(roleId, { invoices: 'view', customers: 'view' }, 'read_only'), 'granted', `${roleId}: View and View read-only`);
  }
  for (const scope of ['tenant', 'platform'] as const) {
    assert.equal(evaluateCanonicalPermission({ scope, roleId: 'store_owner', permission: 'view_issued_invoices', limitation: 'none', levels: {} }), 'denied', scope);
  }
});

test('M7B-INVOICES-ISSUE-P1 (§10.2, review b): edit_issuing_settings is the OWNER RULE exactly as edit_role_levels — the owner role at limitation none on readable edits, sensitive at Full, its parent always materialized for the owner', () => {
  const decide = (permission: string, roleId: unknown, limitation: unknown = 'none', levels: unknown = {}, scope: unknown = 'tenant') =>
    evaluateCanonicalPermission({ scope: scope as never, roleId: roleId as never, permission, limitation: limitation as never, levels });
  // Every input decides the two owner-only keys identically.
  const LEVELS = [{}, { invoices: 'none' }, { employees: 'none' }, { customers: 'full' }, { customers: 'bogus' }, null, undefined, []];
  for (const roleId of [...TENANT_ROLE_IDS, ...PLATFORM_ROLE_IDS, 'owner', 'Store_Owner', null]) {
    for (const limitation of ['none', 'read_only', 'limited']) for (const levels of LEVELS) for (const scope of ['tenant', 'store', 'platform']) {
      assert.equal(decide('edit_issuing_settings', roleId, limitation, levels, scope), decide('edit_role_levels', roleId, limitation, levels, scope),
        `${String(roleId)}/${limitation}/${JSON.stringify(levels)}/${scope}`);
    }
  }
  assert.deepEqual(TENANT_ROLE_IDS.map((r) => [r, decide('edit_issuing_settings', r), decide('edit_issuing_settings', r, 'read_only')]), [
    ['store_owner', 'granted', 'denied'], ['manager', 'denied', 'denied'], ['technician', 'denied', 'denied'], ['sales_staff', 'denied', 'denied'],
  ]);
  // The owner rule's readability check reads the parent in the owner's materialized map: Invoices is always there.
  assert.equal(materializeTenantPermissions('store_owner', {}, false, {}).invoices, 'full', 'the owner materializes Invoices (at Full)');
  assert.equal(decide('edit_issuing_settings', 'manager', 'none', { invoices: 'full', customers: 'full', employees: 'full' }), 'denied', 'a widened manager is never the owner');
  assert.equal(canonicalPermission('tenant', 'edit_issuing_settings')?.sensitive, true, 'sensitive: a command under it needs a recent-sign-in deadline');
  for (const scope of ['store', 'platform'] as const) assert.equal(canonicalPermission(scope, 'edit_issuing_settings'), null, scope);
});

test('M7B-INVOICES-ISSUE-P1: the tenant guard admits exactly the two owner-only keys at sensitive Full; every other sensitive or above-Edit entry, and either owner-only key in any other shape, is refused', () => {
  assert.doesNotThrow(() => assertTenantRoutePermissions(TENANT_ROUTE_PERMISSIONS), 'the shipped table loads');
  const entry = (key: string, threshold: string, over: Record<string, unknown> = {}) =>
    Object.freeze({ key, plane: 'tenant' as const, parent: 'invoices', sensitive: true, threshold, ...over });
  const without = [...TENANT_ROUTE_PERMISSIONS].filter(([key]) => key !== 'edit_issuing_settings');
  const table = (...extra: Array<[string, unknown]>) => new Map([...without, ...extra]) as never;
  assert.doesNotThrow(() => assertTenantRoutePermissions(table()), 'the table without the settings key loads');
  assert.doesNotThrow(() => assertTenantRoutePermissions(table(['edit_issuing_settings', entry('edit_issuing_settings', 'full')])), 'the owner-only entry');
  for (const [label, extra, message] of [
    ['the settings key not sensitive', ['edit_issuing_settings', entry('edit_issuing_settings', 'full', { sensitive: false })], /owner-only tenant route permission is not sensitive at Full/],
    ['the settings key at Manage', ['edit_issuing_settings', entry('edit_issuing_settings', 'manage')], /owner-only tenant route permission is not sensitive at Full/],
    ['the settings key under another entry key', ['edit_issuing_settings', entry('edit_role_levels', 'full')], /owner-only tenant route permission is not sensitive at Full/],
    ['the settings key on a domain the materializer never answers', ['edit_issuing_settings', entry('edit_issuing_settings', 'full', { parent: 'issuing' })], /owner-only tenant route permission is not sensitive at Full on a tenant domain/],
    ['the settings key on a platform feature', ['edit_issuing_settings', entry('edit_issuing_settings', 'full', { parent: 'command_center' })], /owner-only tenant route permission is not sensitive at Full on a tenant domain/],
    ['the settings key with a corequisite', ['edit_issuing_settings', entry('edit_issuing_settings', 'full', { corequisite: Object.freeze({ parent: 'customers', threshold: 'view' }) })], /owner-only tenant route permission is not sensitive at Full/],
    ['the settings key on the platform plane', ['edit_issuing_settings', entry('edit_issuing_settings', 'full', { plane: 'platform' })], /owner-only tenant route permission is not sensitive at Full/],
    ['the role edit on a domain the materializer never answers', ['edit_role_levels', entry('edit_role_levels', 'full', { parent: 'roles' })], /owner-only tenant route permission is not sensitive at Full/],
    ['a third sensitive key at Full', ['edit_store_settings', entry('edit_store_settings', 'full')], /not a non-sensitive View, Create or Edit threshold/],
    ['a non-sensitive key at Full', ['edit_store_settings', entry('edit_store_settings', 'full', { sensitive: false })], /not a non-sensitive View, Create or Edit threshold/],
    ['a non-sensitive key at Approve', ['approve_invoices', entry('approve_invoices', 'approve', { sensitive: false })], /not a non-sensitive View, Create or Edit threshold/],
    ['a sensitive key at View', ['view_issuing_settings', entry('view_issuing_settings', 'view')], /not a non-sensitive View, Create or Edit threshold/],
  ] as const) {
    assert.throws(() => assertTenantRoutePermissions(table(extra as [string, unknown])), message, label);
  }
  assert.throws(() => assertTenantRoutePermissions(table(['reopen_invoice', entry('reopen_invoice', 'view', { sensitive: false })])), /collides with a tenant sub-permission/);
});
