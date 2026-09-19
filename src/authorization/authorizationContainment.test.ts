// M5-GAP11-P5 (D) — containment: the family contract and the money capabilities change what the
// browser and the DEV-only spine decide, and nothing else — no route becomes live, the route
// catalogue still refuses the store plane, no candidate evaluator or pin reaches a decision path, and
// every level comparison in shipped or DEV code names its family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCanonicalPermission } from '../../server/platform-identity/m5CanonicalPermissions';
import { TENANT_SUB_PERMISSIONS } from '../../server/platform-identity/permissionCatalog';
import { TENANT_ROLE_IDS } from '../../server/platform-identity/authorizationConstants';
import { PRODUCTION_INVENTORY } from '../../server/composition/productionTransactions';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...files(p)); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/\.testkit\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(REPO, p).split('\\').join('/');
const PRODUCTION = [...files(join(REPO, 'src')), ...files(join(REPO, 'server'))].map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

test('D1. no route becomes live and the M5 route catalogue still refuses every store/tenant requirement', () => {
  let n = 0;
  for (const scope of ['tenant', 'store'] as const) for (const roleId of TENANT_ROLE_IDS) for (const sub of TENANT_SUB_PERMISSIONS) {
    for (const limitation of ['none', 'read_only'] as const) {
      assert.equal(evaluateCanonicalPermission({ scope, roleId, permission: sub.id, limitation }), 'undecidable', `${scope} ${roleId} ${sub.id}`);
      n += 1;
    }
  }
  assert.equal(n, 2 * TENANT_ROLE_IDS.length * TENANT_SUB_PERMISSIONS.length * 2);
  assert.deepEqual({ routes: PRODUCTION_INVENTORY.routes.length, mutators: PRODUCTION_INVENTORY.mutators.length }, { routes: 0, mutators: 0 }, 'the production route inventory stays empty');
});

test('D2. the browser bundle imports no server module, and the contract modules import nothing at runtime', () => {
  for (const f of PRODUCTION.filter((x) => x.path.startsWith('src/'))) {
    assert.doesNotMatch(code(f.text), /from\s+['"][^'"]*\/server\//, `${f.path} imports server code`);
  }
  for (const f of ['src/authorization/permissionFamilies.ts', 'src/authorization/moneyCapabilities.ts']) {
    const imports = [...code(readFileSync(join(REPO, f), 'utf8')).matchAll(/^import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)];
    assert.ok(imports.every((m) => m[1] !== undefined), `${f}: runtime import found`);
  }
  // The deployable server artifact (server/runtime) makes no permission-level decision of its own.
  for (const f of PRODUCTION.filter((x) => x.path.startsWith('server/runtime/'))) {
    assert.doesNotMatch(code(f.text), /permissionFamilies|moneyCapabilities|meetsFamilyLevel|PERMISSION_HIERARCHY/, f.path);
  }
});

test('D3. no candidate evaluator, shadow comparator or compatibility pin reaches a decision path', () => {
  for (const f of PRODUCTION) {
    if (/server\/platform-identity\/gap11(GrantDiff|ShadowComparator)\.ts$/.test(f.path)) continue;
    assert.doesNotMatch(code(f.text), /gap11GrantDiff|gap11ShadowComparator|D3_COMPATIBILITY_PINS|evaluatePinnedCandidate|compatibilityPins/, f.path);
  }
});

test('D4. every family comparison in shipped and DEV code names its family literally', () => {
  let calls = 0;
  for (const f of PRODUCTION) {
    if (f.path === 'src/authorization/permissionFamilies.ts') continue;
    for (const m of code(f.text).matchAll(/\b(meetsFamilyLevel|permissionLevelRank)\(\s*([^,)]*)/g)) {
      assert.match(m[2], /^'(tenant_store|platform)'$/, `${f.path}: ${m[1]}(${m[2]}…) does not name its family`);
      calls += 1;
    }
  }
  assert.ok(calls >= 20, `expected the migrated comparisons, found ${calls}`);
});

test('D5. no rank table and no raw rank comparison outside the family contract', () => {
  const RAW = /PERMISSION_HIERARCHY\.indexOf\(|PLATFORM_PERMISSION_LEVELS\.indexOf\(|TENANT_ORDERING\.indexOf\(|PLATFORM_ORDERING\.indexOf\(|LEVEL_RANK\b|\brankIn\(/;
  const ORDER_LITERAL = /'none',\s*'view',\s*'create',\s*'edit',\s*'(manage|approve)',\s*'(approve|manage)',\s*'full'/;
  const RANK_MAP = /\bnone:\s*0,\s*view:\s*1\b/;
  // The contract itself; two vocabulary lists that are never ranked; and the superseded candidate, kept as history.
  const ALLOWED_LITERAL = new Set([
    'src/authorization/permissionFamilies.ts',
    'server/platform-identity/permissionCatalog.ts', // PERMISSION_TOKENS: the vocabulary (isPermissionLevel)
    'server/platform-identity/authorizationConstants.ts', // PERMISSION_LEVEL_VALUES: the vocabulary tuple
    'server/platform-identity/gap11GrantDiff.ts', // UNIFIED_CANDIDATE_ORDERING: the rejected global ordering (historical)
  ]);
  for (const f of PRODUCTION) {
    // A domain's `levels: [...]` is the editor's selectable vocabulary for that domain, never a rank table.
    const c = code(f.text).replace(/levels:\s*\[[^\]]*\]/g, 'levels: []');
    if (f.path !== 'server/platform-identity/gap11GrantDiff.ts') assert.doesNotMatch(c, RAW, `${f.path}: raw rank comparison`);
    if (!ALLOWED_LITERAL.has(f.path)) {
      assert.doesNotMatch(c, ORDER_LITERAL, `${f.path}: a second ordering table`);
      assert.doesNotMatch(c, RANK_MAP, `${f.path}: a rank map`);
    }
  }
});

test('D6. no money action is decided by a level comparison alone', () => {
  for (const f of PRODUCTION) {
    const c = code(f.text);
    assert.doesNotMatch(c, /checkPermission\(\s*'refunds'\s*,\s*'approve'\s*\)/, `${f.path}: level-form refund approval`);
    assert.doesNotMatch(c, /(?:requireTenantPermission|requirePermission)\([^)]*'refunds'\s*,\s*'approve'/, `${f.path}: level-form refund approval`);
  }
  // Each money decision path reads the explicit grant.
  for (const f of ['src/context/tenantAccessDecisions.ts', 'src/owner/platformPermissionsConfig.ts', 'server/platform-identity/permissionCatalog.ts']) {
    assert.match(readFileSync(join(REPO, f), 'utf8'), /hasExplicitMoneyGrant\(/, f);
  }
});
