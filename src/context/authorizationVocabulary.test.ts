// docs/phase-4/04 §3 safeguard #4 — deny-by-default on unknowns at the CLIENT
// authorization entry points. This suite pins the 7-token permission
// vocabulary comparators (tenant + platform orderings), the platform
// override readers, and cross-checks the platform catalog against the
// server-side mirror so a defect in either direction is caught.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PERMISSION_HIERARCHY, meetsPermissionLevel } from './accessConfig';
import type { Role } from './accessConfig';
import type { PermissionLevel } from '../types';
import {
  PLATFORM_PERMISSION_LEVELS,
  platformPermissionMeets,
  getPlatformFeatureLevel,
  getPlatformSubPermissionLevel,
  hasEffectiveFeatureAccess,
  explainAccessDecision,
  hasPlatformPermission,
  PLATFORM_FEATURE_GROUPS,
} from '../owner/platformPermissionsConfig';
import type { PlatformFeatureKey, PlatformPermissionsOverrides } from '../owner/platformPermissionsConfig';
import { materializePlatformSubPermissions, meetsTenantPermissionLevel } from '../../server/platform-identity/permissionCatalog';
import {
  CANONICAL_DIFF_CONTEXT,
  CANONICAL_GRANT_UNIVERSE,
  D2_EXPLICIT_MONEY_ACTION_GRANTS,
  candidateMeetsLevel,
  evaluateAfterRepinCandidate,
  evaluateBefore,
} from '../../server/platform-identity/gap11GrantDiff';
import { readFileSync } from 'node:fs';

// The written orderings (spec text, pinned as literal expectations — not
// re-derived from the module under test).
const TENANT_ORDER = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'] as const;
const PLATFORM_ORDER = ['none', 'view', 'create', 'edit', 'approve', 'manage', 'full'] as const;

// Values that must never rank as a canonical level, on either side of either
// comparator.
const UNKNOWN_VALUES: unknown[] = [
  'unknown_token',
  '',
  'View',
  'VIEW',
  ' view',
  'view ',
  'view' + String.fromCharCode(0),
  'view' + String.fromCharCode(1),
  undefined,
  null,
  0,
  1,
  true,
  {},
  [],
  ['view'],
  () => {},
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
];

type Comparator = (actual: unknown, required: unknown) => boolean;
interface Violation { actual: unknown; required: unknown; expected: boolean; got: boolean }

function findLevelViolations(order: readonly string[], compare: Comparator, probes: unknown[]): Violation[] {
  const violations: Violation[] = [];
  for (const actual of probes) {
    for (const required of probes) {
      const a = typeof actual === 'string' ? order.indexOf(actual) : -1;
      const r = typeof required === 'string' ? order.indexOf(required) : -1;
      const expected = a >= 0 && r >= 0 && a >= r;
      const got = compare(actual, required);
      if (got !== expected) violations.push({ actual, required, expected, got });
    }
  }
  return violations;
}

// =============================================================================
// meetsPermissionLevel (tenant ordering)
// =============================================================================

test('meetsPermissionLevel: orderings match the written tenant vocabulary', () => {
  assert.deepEqual(PERMISSION_HIERARCHY, TENANT_ORDER);
});

test('meetsPermissionLevel: full 7x7 matrix pinned to the written tenant ordering', () => {
  for (let a = 0; a < TENANT_ORDER.length; a++) {
    for (let r = 0; r < TENANT_ORDER.length; r++) {
      const expected = a >= r;
      assert.equal(
        meetsPermissionLevel(TENANT_ORDER[a], TENANT_ORDER[r]),
        expected,
        `${TENANT_ORDER[a]} vs ${TENANT_ORDER[r]}`,
      );
    }
  }
});

test('meetsPermissionLevel: every unknown class denies on either side, including against required "none" (control: canonical "none" vs "none" passes)', () => {
  assert.equal(meetsPermissionLevel('none', 'none'), true); // control
  for (const bad of UNKNOWN_VALUES) {
    for (const canonical of TENANT_ORDER) {
      assert.equal(meetsPermissionLevel(bad as unknown as PermissionLevel, canonical), false, `actual=${String(bad)} required=${canonical}`);
      assert.equal(meetsPermissionLevel(canonical, bad as unknown as PermissionLevel), false, `actual=${canonical} required=${String(bad)}`);
    }
    // Explicitly named in the task: unknown actual against the most lenient
    // possible requirement ('none') must still deny.
    assert.equal(meetsPermissionLevel(bad as unknown as PermissionLevel, 'none'), false, `actual=${String(bad)} required=none`);
  }
});

test('meetsPermissionLevel harness: [] for the real function; the pre-fix reproduction fails and specifically shows an unknown required level treated as satisfiable', () => {
  const probes: unknown[] = [...TENANT_ORDER, ...UNKNOWN_VALUES];
  const real: Comparator = (a, r) => meetsPermissionLevel(a as PermissionLevel, r as PermissionLevel);
  assert.deepEqual(findLevelViolations(TENANT_ORDER, real, probes), []);

  // Pre-fix reproduction: PERMISSION_HIERARCHY.indexOf(actual) >= PERMISSION_HIERARCHY.indexOf(required),
  // unknown ranked -1 on both sides (the exact defect this change corrects).
  const preFix: Comparator = (a, r) => TENANT_ORDER.indexOf(a as (typeof TENANT_ORDER)[number]) >= TENANT_ORDER.indexOf(r as (typeof TENANT_ORDER)[number]);
  const preFixViolations = findLevelViolations(TENANT_ORDER, preFix, probes);
  assert.ok(preFixViolations.length > 0, 'the pre-fix reproduction must fail the harness');
  const unknownRequiredSatisfiable = preFixViolations.some(v =>
    typeof v.actual === 'string' && TENANT_ORDER.includes(v.actual as (typeof TENANT_ORDER)[number]) &&
    !(typeof v.required === 'string' && TENANT_ORDER.includes(v.required as (typeof TENANT_ORDER)[number])) &&
    v.expected === false && v.got === true
  );
  assert.ok(unknownRequiredSatisfiable, 'must specifically catch "unknown required level treated as satisfiable"');
});

// =============================================================================
// platformPermissionMeets (platform ordering)
// =============================================================================

test('platformPermissionMeets: orderings match the written platform vocabulary', () => {
  assert.deepEqual(PLATFORM_PERMISSION_LEVELS, PLATFORM_ORDER);
});

test('platformPermissionMeets: full 7x7 matrix pinned to the written platform ordering', () => {
  for (let a = 0; a < PLATFORM_ORDER.length; a++) {
    for (let t = 0; t < PLATFORM_ORDER.length; t++) {
      const expected = a >= t;
      assert.equal(
        platformPermissionMeets(PLATFORM_ORDER[a], PLATFORM_ORDER[t]),
        expected,
        `${PLATFORM_ORDER[a]} vs ${PLATFORM_ORDER[t]}`,
      );
    }
  }
});

test('platformPermissionMeets: every unknown class denies on either side, arrays included (control: canonical "full" vs "full" passes)', () => {
  assert.equal(platformPermissionMeets('full', 'full'), true); // control
  for (const bad of UNKNOWN_VALUES) {
    for (const canonical of PLATFORM_ORDER) {
      assert.equal(platformPermissionMeets(bad as unknown as PermissionLevel, canonical), false, `actual=${String(bad)} threshold=${canonical}`);
      assert.equal(platformPermissionMeets(canonical, bad as unknown as PermissionLevel), false, `actual=${canonical} threshold=${String(bad)}`);
    }
  }
});

test('platformPermissionMeets: prototype pairs no longer pass (control: a real level paired with itself still passes)', () => {
  assert.equal(platformPermissionMeets('manage', 'manage'), true); // control
  for (const proto of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    assert.equal(platformPermissionMeets(proto as unknown as PermissionLevel, proto as unknown as PermissionLevel), false, proto);
  }
});

test('platformPermissionMeets: "none" threshold no longer short-circuits true for a garbage actual (control: a canonical actual still clears "none")', () => {
  assert.equal(platformPermissionMeets('view', 'none'), true); // control
  for (const bad of UNKNOWN_VALUES) {
    assert.equal(platformPermissionMeets(bad as unknown as PermissionLevel, 'none'), false, String(bad));
  }
});

test('platformPermissionMeets harness: [] for the real function; the pre-fix reproduction fails on the none-threshold short-circuit', () => {
  const probes: unknown[] = [...PLATFORM_ORDER, ...UNKNOWN_VALUES];
  const real: Comparator = (a, t) => platformPermissionMeets(a as PermissionLevel, t as PermissionLevel);
  assert.deepEqual(findLevelViolations(PLATFORM_ORDER, real, probes), []);

  // Pre-fix reproduction: `if (threshold === 'none') return true;` short-circuits
  // regardless of `actual`, then a bare LEVEL_RANK[x] lookup (inherited props included).
  const LEVEL_RANK_REPRO: Record<string, number> = { none: 0, view: 1, create: 2, edit: 3, approve: 4, manage: 5, full: 6 };
  const preFix: Comparator = (actual, required) => {
    if (required === 'none') return true;
    return (LEVEL_RANK_REPRO as Record<string, number>)[actual as string] >= (LEVEL_RANK_REPRO as Record<string, number>)[required as string];
  };
  const preFixViolations = findLevelViolations(PLATFORM_ORDER, preFix, probes);
  assert.ok(preFixViolations.length > 0, 'the pre-fix reproduction must fail the harness');
  const noneThresholdDefect = preFixViolations.some(v => v.required === 'none' && v.expected === false && v.got === true);
  assert.ok(noneThresholdDefect, 'must specifically catch the none-threshold short-circuit passing garbage');
});

// =============================================================================
// Premise for the override readers' 'none' malformed-sentinel: no catalog
// platform threshold is ever 'none' (asserted here per the C3 instruction).
// =============================================================================

test('premise: no catalog platform sub-permission threshold is "none"', () => {
  let count = 0;
  for (const group of PLATFORM_FEATURE_GROUPS) {
    for (const sub of group.subPermissions) {
      assert.notEqual(sub.threshold, 'none', sub.id);
      count++;
    }
  }
  assert.ok(count > 0, 'the catalog must not be empty for this premise to mean anything');
});

// =============================================================================
// Override readers — overrides passed explicitly, no sessionStorage.
// =============================================================================

test('getPlatformFeatureLevel: canonical override honored, absent falls back to the spec default', () => {
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', {}), 'manage'); // control: absent -> spec default
  const overrides: PlatformPermissionsOverrides = { support_admin: { features: { command_center: 'full' } } };
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', overrides), 'full'); // control: canonical honored
});

test('getPlatformFeatureLevel: each malformed override leaf value denies (control: the canonical case above already passes)', () => {
  for (const bad of ['None', 'none ', ['none'], ['full'], true, 1, null, '', {}]) {
    const overrides = { support_admin: { features: { command_center: bad } } } as unknown as PlatformPermissionsOverrides;
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', overrides), 'none', JSON.stringify(bad));
  }
});

test('getPlatformFeatureLevel: malformed role entry / kind container deny (control: a well-formed shape passes)', () => {
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', { support_admin: { features: { command_center: 'full' } } }), 'full'); // control
  for (const badRoleEntry of ['not-an-object', ['array'], 42, null]) {
    const overrides = { support_admin: badRoleEntry } as unknown as PlatformPermissionsOverrides;
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', overrides), 'none', JSON.stringify(badRoleEntry));
  }
  for (const badKindContainer of ['nope', ['x'], 1, true]) {
    const overrides = { support_admin: { features: badKindContainer } } as unknown as PlatformPermissionsOverrides;
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', overrides), 'none', JSON.stringify(badKindContainer));
  }
});

test('getPlatformFeatureLevel: an own "__proto__" entry produced by JSON.parse is not honored for any role (control: an unrelated role reads its normal spec default)', () => {
  const overrides = JSON.parse('{"__proto__": {"features": {"command_center": "full"}}}') as PlatformPermissionsOverrides;
  assert.equal(Object.getPrototypeOf(overrides), Object.prototype, 'JSON.parse must not actually repoint the prototype');
  // control: a real role is unaffected by the sibling "__proto__" entry.
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', overrides), 'manage');
  // "__proto__" itself is not a platform role id, so its own entry is never honored.
  assert.equal(getPlatformFeatureLevel('__proto__' as unknown as Role, 'command_center', overrides), 'none');
});

test('getPlatformFeatureLevel / getPlatformSubPermissionLevel: unknown, array, wrong-case, and empty role ids deny (control: the real 5 role ids resolve normally)', () => {
  const overrides: PlatformPermissionsOverrides = { support_admin: { features: { command_center: 'full' } } };
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', overrides), 'full'); // control
  for (const badRole of ['constructor', '__proto__', 'System_Owner', '', ['system_owner'], undefined, null]) {
    assert.equal(getPlatformFeatureLevel(badRole as unknown as Role, 'command_center', overrides), 'none', String(badRole));
    assert.equal(getPlatformSubPermissionLevel(badRole as unknown as Role, 'view_command_center', overrides), 'none', String(badRole));
  }
});

test('getPlatformFeatureLevel / getPlatformSubPermissionLevel: a tenant role with matching overrides still denies (control: the identical override honored for a real platform role)', () => {
  const overrides = {
    support_admin: { features: { command_center: 'full' }, subs: { view_command_center: 'full' } },
    manager: { features: { command_center: 'full' }, subs: { view_command_center: 'full' } },
  } as unknown as PlatformPermissionsOverrides;
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', overrides), 'full'); // control
  assert.equal(getPlatformSubPermissionLevel('support_admin', 'view_command_center', overrides), 'full'); // control
  for (const tenantRole of ['manager', 'store_owner', 'technician', 'sales_staff']) {
    assert.equal(getPlatformFeatureLevel(tenantRole as unknown as Role, 'command_center', overrides), 'none', tenantRole);
    assert.equal(getPlatformSubPermissionLevel(tenantRole as unknown as Role, 'view_command_center', overrides), 'none', tenantRole);
  }
});

test('getPlatformFeatureLevel / hasEffectiveFeatureAccess: unrecognized and prototype-named featureKey deny (control: a real catalog featureKey resolves)', () => {
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', {}), 'manage'); // control
  assert.equal(hasEffectiveFeatureAccess('support_admin', 'command_center', {}), true); // control
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'not_a_real_feature', '']) {
    assert.equal(getPlatformFeatureLevel('support_admin', bad as unknown as PlatformFeatureKey, {}), 'none', bad);
    assert.equal(hasEffectiveFeatureAccess('support_admin', bad as unknown as PlatformFeatureKey, {}), false, bad);
  }
});

test('explainAccessDecision: canonical explicit child honored; malformed explicit child denies explicitly', () => {
  const canonicalOv = { support_admin: { subs: { view_command_center: 'full' } } } as unknown as PlatformPermissionsOverrides;
  const canonicalDec = explainAccessDecision('support_admin', 'view_command_center', canonicalOv);
  assert.equal(canonicalDec.allowed, true); // control
  assert.equal(canonicalDec.source, 'explicit_child');

  for (const bad of ['FULL', 'full ', ['full'], 1]) {
    const badOv = { support_admin: { subs: { view_command_center: bad } } } as unknown as PlatformPermissionsOverrides;
    const dec = explainAccessDecision('support_admin', 'view_command_center', badOv);
    assert.equal(dec.allowed, false, JSON.stringify(bad));
    assert.equal(dec.source, 'denied_explicit_child', JSON.stringify(bad));
    assert.equal(dec.effectiveLevel, 'none', JSON.stringify(bad));
  }
});

test('explainAccessDecision: malformed explicit parent denies (control: a canonical explicit parent is honored)', () => {
  const canonicalOv = { support_admin: { features: { command_center: 'full' } } } as unknown as PlatformPermissionsOverrides;
  const canonicalDec = explainAccessDecision('support_admin', 'view_command_center', canonicalOv);
  assert.equal(canonicalDec.allowed, true); // control
  assert.equal(canonicalDec.source, 'explicit_parent');

  const badOv = { support_admin: { features: { command_center: ['full'] } } } as unknown as PlatformPermissionsOverrides;
  const dec = explainAccessDecision('support_admin', 'view_command_center', badOv);
  assert.equal(dec.allowed, false);
  assert.equal(dec.effectiveLevel, 'none');
});

test('explainAccessDecision: tenant / unknown role denies even with a matching override, overrides ignored (control: the same override honored for a real platform role)', () => {
  const ov = {
    support_admin: { subs: { view_command_center: 'full' } },
    manager: { subs: { view_command_center: 'full' } },
  } as unknown as PlatformPermissionsOverrides;
  assert.equal(explainAccessDecision('support_admin', 'view_command_center', ov).allowed, true); // control
  for (const badRole of ['manager', 'constructor', '__proto__', 'System_Owner', '', ['system_owner']]) {
    const dec = explainAccessDecision(badRole as unknown as Role, 'view_command_center', ov);
    assert.equal(dec.allowed, false, String(badRole));
    assert.equal(dec.effectiveLevel, 'none', String(badRole));
  }
});

// =============================================================================
// Preservation — the client matrix and the server catalog must still agree
// for every platform role x every catalog sub-permission with no overrides.
// =============================================================================

test('preservation: explainAccessDecision(role, sub, {}).allowed matches materializePlatformSubPermissions(role, false)[sub] for every platform role x catalog sub', () => {
  const platformRoleIds: Role[] = ['system_owner', 'support_admin', 'billing_admin', 'operations_admin', 'security_admin'];
  const mismatches: string[] = [];
  for (const role of platformRoleIds) {
    const serverMap = materializePlatformSubPermissions(role, false);
    for (const group of PLATFORM_FEATURE_GROUPS) {
      for (const sub of group.subPermissions) {
        const clientAllowed = explainAccessDecision(role, sub.id, {}).allowed;
        const serverAllowed = serverMap[sub.id];
        if (clientAllowed !== serverAllowed) {
          mismatches.push(`${role} / ${sub.id}: client=${clientAllowed} server=${String(serverAllowed)}`);
        }
      }
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

// =============================================================================
// Follow-up review (F1-F3)
// =============================================================================

test('F1: System Owner still gets full/true for a real key (control), but an unknown or inherited key denies even for the owner', () => {
  assert.equal(getPlatformFeatureLevel('system_owner', 'command_center', {}), 'full'); // control
  assert.equal(hasEffectiveFeatureAccess('system_owner', 'command_center', {}), true); // control
  assert.equal(getPlatformSubPermissionLevel('system_owner', 'view_command_center', {}), 'full'); // control
  for (const bad of ['constructor', '__proto__', 'toString', 'not_a_real_key']) {
    assert.equal(getPlatformFeatureLevel('system_owner', bad as unknown as PlatformFeatureKey, {}), 'none', bad);
    assert.equal(hasEffectiveFeatureAccess('system_owner', bad as unknown as PlatformFeatureKey, {}), false, bad);
    assert.equal(getPlatformSubPermissionLevel('system_owner', bad, {}), 'none', bad);
  }
});

test('F2: a malformed overrides ROOT denies rather than silently defaulting (control: absent {} still defaults, a canonical root still honored)', () => {
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', {}), 'manage'); // control: absent
  const canonicalOv: PlatformPermissionsOverrides = { support_admin: { features: { command_center: 'full' } } };
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', canonicalOv), 'full'); // control: canonical
  for (const badRoot of [[], ['x'], 'garbage', 42, true, new Date()]) {
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center', badRoot as unknown as PlatformPermissionsOverrides), 'none', String(badRoot));
  }
});

test('F3: a legacy alias reads the canonical override slot; a disagreeing alias/canonical pair denies (control: canonical-only honored under both names)', () => {
  const canonicalOnly = { support_admin: { subs: { view_next_best_actions: 'full' } } } as unknown as PlatformPermissionsOverrides;
  assert.equal(getPlatformSubPermissionLevel('support_admin', 'view_next_best_actions', canonicalOnly), 'full'); // control
  assert.equal(getPlatformSubPermissionLevel('support_admin', 'view_nba_recommendations', canonicalOnly), 'full'); // alias reads canonical slot

  const agreeing = {
    support_admin: { subs: { view_next_best_actions: 'view', view_nba_recommendations: 'view' } },
  } as unknown as PlatformPermissionsOverrides;
  assert.equal(getPlatformSubPermissionLevel('support_admin', 'view_nba_recommendations', agreeing), 'view');

  const disagreeing = {
    support_admin: { subs: { view_next_best_actions: 'full', view_nba_recommendations: 'view' } },
  } as unknown as PlatformPermissionsOverrides;
  assert.equal(getPlatformSubPermissionLevel('support_admin', 'view_nba_recommendations', disagreeing), 'none');
  assert.equal(getPlatformSubPermissionLevel('support_admin', 'view_next_best_actions', disagreeing), 'none');
  assert.equal(explainAccessDecision('support_admin', 'view_nba_recommendations', disagreeing).allowed, false);
});

test('F2 (implicit source): no window -> defaults (control); a getItem that throws, and unparseable stored JSON, both deny rather than defaulting', () => {
  // control: no `window` at all (the real node:test environment) -> {} -> spec default.
  assert.equal(getPlatformFeatureLevel('support_admin', 'command_center'), 'manage');

  type FakeWindow = { sessionStorage: { getItem: (k: string) => string | null } };
  const g = globalThis as unknown as { window?: FakeWindow };
  const restore = g.window;
  try {
    // control: a present item that's absent (null) still yields the spec default.
    g.window = { sessionStorage: { getItem: () => null } };
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center'), 'manage');

    // getItem throws -> deny.
    g.window = { sessionStorage: { getItem: () => { throw new Error('boom'); } } };
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center'), 'none');

    // the browser blocks storage (reading sessionStorage throws) -> deny.
    g.window = Object.defineProperty({}, 'sessionStorage', { get() { throw new Error('SecurityError'); } }) as FakeWindow;
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center'), 'none');

    // stored item fails JSON.parse -> deny.
    g.window = { sessionStorage: { getItem: () => '{not json' } };
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center'), 'none');

    // stored item parses to a non-plain root (array) -> deny.
    g.window = { sessionStorage: { getItem: () => '[]' } };
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center'), 'none');

    // stored item parses to a well-formed canonical override -> honored.
    g.window = { sessionStorage: { getItem: () => JSON.stringify({ support_admin: { features: { command_center: 'full' } } }) } };
    assert.equal(getPlatformFeatureLevel('support_admin', 'command_center'), 'full');
  } finally {
    if (restore === undefined) delete g.window; else g.window = restore;
  }
});

test('TeamManagementPage gates: a corrupt store denies the governance gates instead of reverting them to role defaults', () => {
  type FakeWindow = { sessionStorage: { getItem: (k: string) => string | null } };
  const g = globalThis as unknown as { window?: FakeWindow };
  const restore = g.window;
  try {
    g.window = { sessionStorage: { getItem: () => null } };
    assert.equal(hasPlatformPermission('security_admin', 'manage_temporary_access').allowed, true, 'control: role default');
    g.window = { sessionStorage: { getItem: () => '{not json' } };
    assert.equal(hasPlatformPermission('security_admin', 'manage_temporary_access').allowed, false);
  } finally {
    if (restore === undefined) delete g.window; else g.window = restore;
  }
  // The page's gates must use that reader: its editor state sanitizes a corrupt store to `{}`, so passing
  // that state as the overrides argument would bring the role defaults back.
  const page = readFileSync(new URL('../owner/TeamManagementPage.tsx', import.meta.url), 'utf8');
  const gates = [...page.matchAll(/\b(?:hasPlatformPermission|canPlatform|hasEffectiveFeatureAccess|getEffectiveFeatureAccess|hasSectionAccess|hasActionAccess)\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(gates.length >= 5, `control: the five governance gates are found (found ${gates.length})`);
  for (const args of gates) assert.equal(args.split(',').length, 2, args);
});

// =============================================================================
// M5-GAP11-P2 — server/client agreement for the GAP-11 candidate and D2's money actions
// =============================================================================

test('server/client agreement: the client comparators equal the server authority (tenant) and the server candidate (unified), on every probe', () => {
  // The candidate adopts the unified ordering, which is the one the client's platform comparator already
  // uses; the tenant side stays the authority on both. Canonical levels and every unknown class alike.
  const probes: unknown[] = [...PLATFORM_ORDER, ...UNKNOWN_VALUES];
  let pairs = 0;
  let flips = 0;
  for (const a of probes) {
    for (const r of probes) {
      const unified = platformPermissionMeets(a as PermissionLevel, r as PermissionLevel);
      const tenant = meetsPermissionLevel(a as PermissionLevel, r as PermissionLevel);
      assert.equal(unified, candidateMeetsLevel(a, r), `unified: ${String(a)} vs ${String(r)}`);
      assert.equal(tenant, meetsTenantPermissionLevel(a as never, r as never), `tenant: ${String(a)} vs ${String(r)}`);
      if (unified !== tenant) flips += 1;
      pairs += 1;
    }
  }
  assert.equal(pairs, probes.length * probes.length);
  assert.equal(flips, 2, 'control: the two orderings still differ on exactly the manage/approve pair');
});

test('server/client agreement: the client\'s platform billing approval equals the D2 explicit grant and the post-re-pin candidate, per role', () => {
  const platform = D2_EXPLICIT_MONEY_ACTION_GRANTS.filter((g) => g.plane === 'platform');
  assert.equal(platform.length, 5);
  assert.equal(platform.filter((g) => g.granted).length, 2, 'control: the check is not a constant');
  for (const g of platform) {
    const client = explainAccessDecision(g.role as Role, g.action, {}).allowed;
    assert.equal(client, g.granted, `client vs D2 grant: ${g.role}`);
    const t = CANONICAL_GRANT_UNIVERSE.find((x) => x.plane === g.plane && x.stratum === g.stratum
      && x.role === g.role && x.scope === g.scope && x.action === g.action);
    assert.ok(t !== undefined, g.role);
    assert.equal(evaluateAfterRepinCandidate(t, CANONICAL_DIFF_CONTEXT) === 'granted', client, `candidate vs client: ${g.role}`);
    assert.equal(evaluateBefore(t, CANONICAL_DIFF_CONTEXT) === 'granted', client, `authority vs client: ${g.role}`);
  }
});
