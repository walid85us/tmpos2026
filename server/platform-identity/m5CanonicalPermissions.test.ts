// Phase 4.0 M5-ID-P1 — the canonical route-permission catalog: exact keys, fail-closed unknowns, and
// an honest refusal to answer where GAP-11 has not been settled.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_PLATFORM_PERMISSIONS,
  CANONICAL_TENANT_PERMISSIONS,
  canonicalPermission,
  evaluateCanonicalPermission,
} from './m5CanonicalPermissions';
import { PLATFORM_SUB_PERMISSIONS, TENANT_SUB_PERMISSIONS } from './permissionCatalog';
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
