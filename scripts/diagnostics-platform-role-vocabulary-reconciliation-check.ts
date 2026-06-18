// Phase 1.6 M2 — STATIC (offline) platform-role vocabulary reconciliation check.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env secrets, no
// SQL, no migration apply, no audit write, no Supabase MCP, no runtime endpoint
// call. It imports the inert constants/catalog/resolver and reads migration 003 as
// TEXT (read-only parity inspection — never applied) to assert that the canonical
// platform-role vocabulary is consistent across:
//   - server/platform-identity/authorizationConstants.ts  (PLATFORM_ROLE_IDS)
//   - server/platform-identity/permissionCatalog.ts        (PLATFORM_ROLE_FEATURE_DEFAULTS)
//   - server/platform-identity/migrations/003_...up.sql     (canonical CHECK set)
// and that the resolver is canonical-first, legacy-compat fallback, fail-closed.
//
// Run:  npx tsx scripts/diagnostics-platform-role-vocabulary-reconciliation-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { PLATFORM_ROLE_IDS } from '../server/platform-identity/authorizationConstants';
import {
  PLATFORM_ROLE_FEATURE_DEFAULTS,
  materializePlatformPermissions,
  materializePlatformSubPermissions,
} from '../server/platform-identity/permissionCatalog';
import {
  resolveAuthorization,
  PLATFORM_ROLE_COMPAT_MAP,
  type AuthorizationResolverInput,
  type ResolverIdentity,
  type AppUserSnapshot,
  type MembershipSnapshot,
} from '../server/platform-identity/authorizationResolver';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sorted = (a: readonly string[]): string => JSON.stringify([...a].sort());

// The ONE canonical platform-role vocabulary (hardcoded EXPECTED — every other
// surface is asserted EQUAL to this, never derived from it).
const EXPECTED = ['system_owner', 'support_admin', 'billing_admin', 'operations_admin', 'security_admin'];
// By-design fail-closed legacy ids (no honest canonical target).
const FAIL_CLOSED_LEGACY = ['platform_admin', 'platform_readonly'];
// The three unambiguous legacy ids the compat fallback is allowed to map.
const EXPECTED_COMPAT: Record<string, string> = {
  platform_owner: 'system_owner',
  platform_support: 'support_admin',
  platform_ops: 'operations_admin',
};

// ---- mocked snapshot builder (platform scope) ------------------------------

const UID = 'user-internal-1';
const identity = (): ResolverIdentity => ({
  internalUserId: UID, authProvider: 'supabase', authProviderUid: 'sub-abc', email: 'tester@dev.local',
});
const appUser = (): AppUserSnapshot => ({ internal_user_id: UID, status: 'active', display_name: 'Tester' });
const membership = (roleId: string): MembershipSnapshot => ({
  membership_id: 'm-1', internal_user_id: UID, tenant_id: null, store_id: null,
  scope_type: 'platform', role_id: roleId, status: 'active',
});
function platform(roleId: string): AuthorizationResolverInput {
  return {
    identity: identity(), appUser: appUser(), memberships: [membership(roleId)],
    tenant: null, store: null, entitlements: [], requestedContext: { scopeType: 'platform' },
  };
}

// ---- extract the canonical platform-role set from migration 003 ------------

const mig003 = read('server/platform-identity/migrations/003_platform_role_vocabulary_alignment.up.sql');
function platformRolesFromCheck(sql: string): string[] {
  // Match the ADD CONSTRAINT clause: scope_type = 'platform' and role_id in ( ... )
  const m = /scope_type\s*=\s*'platform'\s+and\s+role_id\s+in\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const mig003Roles = platformRolesFromCheck(mig003);

// =============================================================================
// 1) Canonical vocabulary parity across constants / catalog / migration 003
// =============================================================================

check('1a EXPECTED canonical set is 5 distinct roles', new Set(EXPECTED).size === 5, EXPECTED.join(','));
check('1b constants PLATFORM_ROLE_IDS == canonical', sorted(PLATFORM_ROLE_IDS) === sorted(EXPECTED), [...PLATFORM_ROLE_IDS].join(','));
check('1c catalog PLATFORM_ROLE_FEATURE_DEFAULTS keys == canonical', sorted(Object.keys(PLATFORM_ROLE_FEATURE_DEFAULTS)) === sorted(EXPECTED), Object.keys(PLATFORM_ROLE_FEATURE_DEFAULTS).join(','));
check('1d migration 003 canonical CHECK set == canonical', sorted(mig003Roles) === sorted(EXPECTED), mig003Roles.join(','));

// =============================================================================
// 2) billing_admin / security_admin are first-class canonical + catalog-defined
// =============================================================================

{
  const billing = materializePlatformPermissions('billing_admin', false);
  const security = materializePlatformPermissions('security_admin', false);
  const billingSubs = materializePlatformSubPermissions('billing_admin', false);
  const securitySubs = materializePlatformSubPermissions('security_admin', false);
  check('2a billing_admin present + catalog-defined', 'billing_admin' in PLATFORM_ROLE_FEATURE_DEFAULTS && billing.billing_subscriptions === 'full' && Object.keys(billingSubs).length > 0, `billing=${billing.billing_subscriptions}`);
  check('2b security_admin present + catalog-defined', 'security_admin' in PLATFORM_ROLE_FEATURE_DEFAULTS && security.audit_security === 'full' && Object.keys(securitySubs).length > 0, `audit=${security.audit_security}`);
  const noInvented =
    !('billing_admin' in PLATFORM_ROLE_COMPAT_MAP) &&
    !('security_admin' in PLATFORM_ROLE_COMPAT_MAP) &&
    !Object.values(PLATFORM_ROLE_COMPAT_MAP).some((v) => v === 'billing_admin' || v === 'security_admin');
  check('2c no legacy compat id was invented for billing_admin/security_admin', noInvented, 'no invented mapping');
}

// =============================================================================
// 3) platform_admin / platform_readonly are absent (fail-closed by design)
// =============================================================================

check('3a platform_admin/platform_readonly absent from canonical constants', FAIL_CLOSED_LEGACY.every((r) => !(PLATFORM_ROLE_IDS as readonly string[]).includes(r)), 'absent');
check('3b platform_admin/platform_readonly absent from catalog roles', FAIL_CLOSED_LEGACY.every((r) => !(r in PLATFORM_ROLE_FEATURE_DEFAULTS)), 'absent');
check('3c platform_admin/platform_readonly absent from migration 003 canonical CHECK', FAIL_CLOSED_LEGACY.every((r) => !mig003Roles.includes(r)), 'absent');
check('3d platform_admin/platform_readonly absent from compat map', FAIL_CLOSED_LEGACY.every((r) => !(r in PLATFORM_ROLE_COMPAT_MAP)), 'absent');

// =============================================================================
// 4) Compatibility map covers ONLY the unambiguous legacy subset
// =============================================================================

check('4a compat map keys == {platform_owner, platform_support, platform_ops}', sorted(Object.keys(PLATFORM_ROLE_COMPAT_MAP)) === sorted(Object.keys(EXPECTED_COMPAT)), Object.keys(PLATFORM_ROLE_COMPAT_MAP).join(','));
check('4b compat map maps each legacy id to its canonical target', Object.entries(EXPECTED_COMPAT).every(([k, v]) => PLATFORM_ROLE_COMPAT_MAP[k] === v), JSON.stringify(PLATFORM_ROLE_COMPAT_MAP));
check('4c every compat target is a canonical role', Object.values(PLATFORM_ROLE_COMPAT_MAP).every((v) => EXPECTED.includes(v)), Object.values(PLATFORM_ROLE_COMPAT_MAP).join(','));
check('4d no compat target is billing_admin/security_admin', !Object.values(PLATFORM_ROLE_COMPAT_MAP).some((v) => v === 'billing_admin' || v === 'security_admin'), 'none');

// =============================================================================
// 5) Resolver: canonical-first, legacy-compat fallback, fail-closed otherwise
// =============================================================================

{
  // 5a) Every canonical id resolves DIRECTLY (roles.platformRoleId === the fed id).
  const directBad = EXPECTED.filter((id) => {
    const r = resolveAuthorization(platform(id));
    return r.decision !== 'allow' || r.authorization?.roles.platformRoleId !== id;
  });
  check('5a every canonical id resolves directly (post-003)', directBad.length === 0, directBad.join(','));
}
{
  // 5b) Each legacy compat id resolves to its mapped canonical id (fallback path).
  const compatBad = Object.entries(EXPECTED_COMPAT).filter(([legacy, canon]) => {
    const r = resolveAuthorization(platform(legacy));
    return r.decision !== 'allow' || r.authorization?.roles.platformRoleId !== canon;
  });
  check('5b each legacy compat id resolves to its canonical target', compatBad.length === 0, compatBad.map(([k]) => k).join(','));
}
{
  // 5c) Fail-closed: platform_admin, platform_readonly, and an unknown string deny → null.
  const failers = [...FAIL_CLOSED_LEGACY, 'zzz_unknown_role'];
  const notFailed = failers.filter((id) => {
    const r = resolveAuthorization(platform(id));
    return !(r.decision === 'deny' && r.authorization === null);
  });
  check('5c platform_admin/platform_readonly/unknown fail closed (deny → null)', notFailed.length === 0, notFailed.join(','));
}

// =============================================================================
// 6) Inertness via import-allowlist (non-circular) + no env access
// =============================================================================

const selfSrc = read('scripts/diagnostics-platform-role-vocabulary-reconciliation-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const allowedImports = new Set([
  'fs',
  'path',
  '../server/platform-identity/authorizationConstants',
  '../server/platform-identity/permissionCatalog',
  '../server/platform-identity/authorizationResolver',
]);
check('6a diagnostic imports confined to node fs/path + inert server modules', selfImports.length > 0 && selfImports.every((i) => allowedImports.has(i)), selfImports.join(', '));
check('6b diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('6c diagnostic imports no frontend (src/)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/')), 'no src import');

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[platform-role-vocabulary-reconciliation-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
