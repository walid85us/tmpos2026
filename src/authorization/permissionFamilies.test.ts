// M5-GAP11-P5 (A) — the family-aware ordering contract. The orderings are written out here from the
// owner decision, never read back from the module under test.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSION_FAMILIES,
  PLATFORM_ORDERING,
  TENANT_STORE_ORDERING,
  isPermissionFamily,
  meetsFamilyLevel,
  meetsPermissionRequirement,
  permissionLevelRank,
  type FamilyLevel,
  type PermissionFamily,
} from './permissionFamilies';
import { PERMISSION_HIERARCHY, meetsPermissionLevel } from '../context/accessConfig';
import { PLATFORM_PERMISSION_LEVELS, platformPermissionMeets } from '../owner/platformPermissionsConfig';
import {
  PLATFORM_ORDERING as SERVER_PLATFORM_ORDERING,
  TENANT_ORDERING as SERVER_TENANT_ORDERING,
  meetsPlatformPermissionLevel,
  meetsTenantPermissionLevel,
} from '../../server/platform-identity/permissionCatalog';
import {
  PLATFORM_PERMISSION_ORDERING,
  TENANT_PERMISSION_ORDERING,
} from '../../server/platform-identity/authorizationConstants';
import {
  meetsPermissionLevel as serverMeetsPermissionLevel,
  platformPermissionMeets as serverPlatformPermissionMeets,
} from '../../server/platform-identity/permissionDecision';
import type { PermissionLevel } from '../types';

const TENANT_WRITTEN = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'] as const;
const PLATFORM_WRITTEN = ['none', 'view', 'create', 'edit', 'approve', 'manage', 'full'] as const;

const BAD_VALUES: unknown[] = [
  undefined, null, '', 'View', 'VIEW', ' view', 'view ', 'view' + String.fromCharCode(0), 'admin',
  0, 1, true, {}, [], ['view'], () => 'view', 'constructor', '__proto__', 'toString', 'hasOwnProperty',
];
const BAD_FAMILIES: unknown[] = [
  undefined, null, '', 'tenant', 'store', 'Tenant_Store', 'PLATFORM', ' platform', 'unified', 'global',
  0, 1, {}, [], ['platform'], 'constructor', '__proto__', 'toString',
];

test('A1. the tenant/store family is the written store ordering — all 49 pairs', () => {
  assert.deepEqual([...TENANT_STORE_ORDERING], [...TENANT_WRITTEN]);
  for (let h = 0; h < 7; h++) for (let r = 0; r < 7; r++) {
    assert.equal(meetsFamilyLevel('tenant_store', TENANT_WRITTEN[h], TENANT_WRITTEN[r]), h >= r, `${TENANT_WRITTEN[h]} vs ${TENANT_WRITTEN[r]}`);
  }
});

test('A2. the platform family is the written platform ordering — all 49 pairs', () => {
  assert.deepEqual([...PLATFORM_ORDERING], [...PLATFORM_WRITTEN]);
  for (let h = 0; h < 7; h++) for (let r = 0; r < 7; r++) {
    assert.equal(meetsFamilyLevel('platform', PLATFORM_WRITTEN[h], PLATFORM_WRITTEN[r]), h >= r, `${PLATFORM_WRITTEN[h]} vs ${PLATFORM_WRITTEN[r]}`);
  }
});

test('A3. the families differ on exactly the two intentional pairs', () => {
  // held manage / required approve: the store family denies, the platform family allows.
  assert.equal(meetsFamilyLevel('tenant_store', 'manage', 'approve'), false);
  assert.equal(meetsFamilyLevel('platform', 'manage', 'approve'), true);
  // held approve / required manage: the store family allows, the platform family denies.
  assert.equal(meetsFamilyLevel('tenant_store', 'approve', 'manage'), true);
  assert.equal(meetsFamilyLevel('platform', 'approve', 'manage'), false);
  const differing: string[] = [];
  for (const h of TENANT_WRITTEN) for (const r of TENANT_WRITTEN) {
    if (meetsFamilyLevel('tenant_store', h, r) !== meetsFamilyLevel('platform', h, r)) differing.push(`${h}/${r}`);
  }
  assert.deepEqual(differing.sort(), ['approve/manage', 'manage/approve']);
});

test('A4. an unknown or malformed family denies every pair and ranks nothing', () => {
  assert.deepEqual([...PERMISSION_FAMILIES], ['tenant_store', 'platform']);
  for (const family of BAD_FAMILIES) {
    assert.equal(isPermissionFamily(family), false, String(family));
    for (const h of TENANT_WRITTEN) {
      assert.equal(permissionLevelRank(family as PermissionFamily, h), -1, `${String(family)} ${h}`);
      for (const r of TENANT_WRITTEN) {
        assert.equal(meetsFamilyLevel(family as PermissionFamily, h, r), false, `${String(family)} ${h}/${r}`);
      }
    }
  }
});

test('A5. an unknown or malformed level denies on either side in both families — even against `none`', () => {
  for (const family of ['tenant_store', 'platform'] as const) {
    assert.equal(meetsFamilyLevel(family, 'none', 'none'), true, 'control');
    for (const bad of BAD_VALUES) {
      assert.equal(permissionLevelRank(family, bad), -1);
      for (const ok of TENANT_WRITTEN) {
        assert.equal(meetsFamilyLevel(family, bad, ok), false, `${family} held ${String(bad)}`);
        assert.equal(meetsFamilyLevel(family, ok, bad), false, `${family} required ${String(bad)}`);
      }
    }
  }
});

test('A6. a comparison across families is refused, never coerced — and a malformed side denies', () => {
  for (const h of TENANT_WRITTEN) for (const r of TENANT_WRITTEN) {
    const tenant = (level: PermissionLevel): FamilyLevel => ({ family: 'tenant_store', level });
    const platform = (level: PermissionLevel): FamilyLevel => ({ family: 'platform', level });
    assert.equal(meetsPermissionRequirement(platform(h), tenant(r)), false, `platform ${h} vs store ${r}`);
    assert.equal(meetsPermissionRequirement(tenant(h), platform(r)), false, `store ${h} vs platform ${r}`);
    assert.equal(meetsPermissionRequirement(tenant(h), tenant(r)), meetsFamilyLevel('tenant_store', h, r), 'control: same family');
    assert.equal(meetsPermissionRequirement(platform(h), platform(r)), meetsFamilyLevel('platform', h, r), 'control: same family');
  }
  for (const bad of [null, undefined, 'full', 7, [], {}, { level: 'full' }, { family: 'platform' }] as unknown[]) {
    assert.equal(meetsPermissionRequirement(bad as FamilyLevel, { family: 'platform', level: 'none' }), false, JSON.stringify(bad));
    assert.equal(meetsPermissionRequirement({ family: 'platform', level: 'full' }, bad as FamilyLevel), false, JSON.stringify(bad));
  }
});

test('A7. a call that names no family cannot select an ordering', () => {
  const noFamily = meetsFamilyLevel as unknown as (...a: unknown[]) => boolean;
  for (const h of TENANT_WRITTEN) for (const r of TENANT_WRITTEN) {
    assert.equal(noFamily(undefined, h, r), false);
    assert.equal(noFamily(h, r), false); // the family slot filled by a level is not a family
  }
  assert.equal((permissionLevelRank as unknown as (...a: unknown[]) => number)('full'), -1);
});

test('A8. the public comparators keep their family: store callers the store ordering, platform callers the platform ordering', () => {
  for (const h of TENANT_WRITTEN) for (const r of TENANT_WRITTEN) {
    const store = meetsFamilyLevel('tenant_store', h, r);
    const plat = meetsFamilyLevel('platform', h, r);
    assert.equal(meetsPermissionLevel(h, r), store, `client meetsPermissionLevel ${h}/${r}`);
    assert.equal(meetsTenantPermissionLevel(h, r), store, `server tenant ${h}/${r}`);
    assert.equal(serverMeetsPermissionLevel(h, r), store, `DEV spine tenant ${h}/${r}`);
    assert.equal(platformPermissionMeets(h, r), plat, `client platform ${h}/${r}`);
    assert.equal(meetsPlatformPermissionLevel(h, r), plat, `server platform ${h}/${r}`);
    assert.equal(serverPlatformPermissionMeets(h, r), plat, `DEV spine platform ${h}/${r}`);
  }
});

test('A9. one table per family: every exported ordering is the same frozen array, not a copy', () => {
  for (const alias of [PERMISSION_HIERARCHY, SERVER_TENANT_ORDERING, TENANT_PERMISSION_ORDERING]) assert.equal(alias, TENANT_STORE_ORDERING);
  for (const alias of [PLATFORM_PERMISSION_LEVELS, SERVER_PLATFORM_ORDERING, PLATFORM_PERMISSION_ORDERING]) assert.equal(alias, PLATFORM_ORDERING);
  assert.ok(Object.isFrozen(TENANT_STORE_ORDERING) && Object.isFrozen(PLATFORM_ORDERING));
});
