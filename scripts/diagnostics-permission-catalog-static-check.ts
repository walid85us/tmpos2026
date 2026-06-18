// Phase 1.6 M1 — STATIC (offline) check for the server permission catalog.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env secrets, no
// SQL, no migration, no audit write, no Supabase MCP, no runtime endpoint call.
// It imports the inert catalog and reads the two FROZEN frontend engines as TEXT
// (read-only parity inspection — never imported) to assert structural integrity.
//
// Run:  npx tsx scripts/diagnostics-permission-catalog-static-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PERMISSION_TOKENS,
  TENANT_ORDERING,
  PLATFORM_ORDERING,
  TENANT_PERMISSION_DOMAINS,
  TENANT_DOMAIN_ENTITLEMENT,
  TENANT_SUB_PERMISSIONS,
  TENANT_FEATURE_PERMISSION_DEPENDENCIES,
  TENANT_ROLE_PERMISSION_DEFAULTS,
  TENANT_ROLE_SUBPERMISSION_DEFAULTS,
  KNOWN_TENANT_ENTITLEMENT_KEYS,
  requiredEntitlementsForTenantSub,
  PLATFORM_FEATURE_KEYS,
  PLATFORM_SUB_PERMISSIONS,
  PLATFORM_PERMISSION_DEPENDENCIES,
  PLATFORM_ROLE_FEATURE_DEFAULTS,
  meetsTenantPermissionLevel,
  meetsPlatformPermissionLevel,
  materializeTenantSubPermissions,
  materializeTenantPermissions,
  FEATURE_KEY_ALIASES,
  normalizeFeatureKey,
} from '../server/platform-identity/permissionCatalog';
import { PLATFORM_ROLE_IDS } from '../server/platform-identity/authorizationConstants';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const dupes = (arr: string[]): string[] => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const x of arr) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
};

// Extract a `[ ... ]` token list following a named const in a source string.
function extractArray(src: string, constName: string): string[] {
  const re = new RegExp(`${constName}[^=]*=\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// =============================================================================
// 1) No duplicate keys across every catalog vocabulary
// =============================================================================

const tenantSubIds = TENANT_SUB_PERMISSIONS.map((s) => s.id);
const platformSubIds = PLATFORM_SUB_PERMISSIONS.map((s) => s.id);
check('1a no duplicate tenant domains', dupes([...TENANT_PERMISSION_DOMAINS]).length === 0, dupes([...TENANT_PERMISSION_DOMAINS]).join(','));
check('1b no duplicate tenant sub-permission ids', dupes(tenantSubIds).length === 0, dupes(tenantSubIds).join(','));
check('1c no duplicate platform feature keys', dupes([...PLATFORM_FEATURE_KEYS]).length === 0, dupes([...PLATFORM_FEATURE_KEYS]).join(','));
check('1d no duplicate platform sub-permission ids', dupes(platformSubIds).length === 0, dupes(platformSubIds).join(','));
check('1e tenant & platform sub-id namespaces may overlap (independent contexts) — informational', true, 'informational');

// =============================================================================
// 2) Both orderings preserved + 3) frontend parity + 4) manage/approve intact
// =============================================================================

const tenantExpected = ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
const platformExpected = ['none', 'view', 'create', 'edit', 'approve', 'manage', 'full'];
check('2a tenant ordering exact (manage < approve)', JSON.stringify([...TENANT_ORDERING]) === JSON.stringify(tenantExpected), TENANT_ORDERING.join('<'));
check('2b platform ordering exact (approve < manage)', JSON.stringify([...PLATFORM_ORDERING]) === JSON.stringify(platformExpected), PLATFORM_ORDERING.join('<'));
check('2c 7-token vocabulary present', PERMISSION_TOKENS.length === 7 && new Set(PERMISSION_TOKENS).size === 7, PERMISSION_TOKENS.join(','));

const accessConfigSrc = read('src/context/accessConfig.ts');
const platformConfigSrc = read('src/owner/platformPermissionsConfig.ts');
const feHierarchy = extractArray(accessConfigSrc, 'PERMISSION_HIERARCHY');
const feePlatform = extractArray(platformConfigSrc, 'PLATFORM_PERMISSION_LEVELS');
check('3a tenant ordering matches frontend PERMISSION_HIERARCHY (parity)', JSON.stringify(feHierarchy) === JSON.stringify([...TENANT_ORDERING]), feHierarchy.join('<') || 'not found');
check('3b platform ordering matches frontend PLATFORM_PERMISSION_LEVELS (parity)', JSON.stringify(feePlatform) === JSON.stringify([...PLATFORM_ORDERING]), feePlatform.join('<') || 'not found');

// manage/approve must NOT be collapsed: orderings disagree on their relative order.
const tManageIdx = TENANT_ORDERING.indexOf('manage');
const tApproveIdx = TENANT_ORDERING.indexOf('approve');
const pManageIdx = PLATFORM_ORDERING.indexOf('manage');
const pApproveIdx = PLATFORM_ORDERING.indexOf('approve');
check('4a tenant: manage < approve', tManageIdx >= 0 && tApproveIdx >= 0 && tManageIdx < tApproveIdx, `${tManageIdx}<${tApproveIdx}`);
check('4b platform: approve < manage', pApproveIdx >= 0 && pManageIdx >= 0 && pApproveIdx < pManageIdx, `${pApproveIdx}<${pManageIdx}`);
check('4c orderings are NOT collapsed (divergence preserved)', JSON.stringify([...TENANT_ORDERING]) !== JSON.stringify([...PLATFORM_ORDERING]), 'distinct');
// Cross-check via the comparison helpers (semantic, not just array order).
check('4d tenant helper: approve outranks manage', meetsTenantPermissionLevel('approve', 'manage') && !meetsTenantPermissionLevel('manage', 'approve'), 'tenant manage<approve');
check('4e platform helper: manage outranks approve', meetsPlatformPermissionLevel('manage', 'approve') && !meetsPlatformPermissionLevel('approve', 'manage'), 'platform approve<manage');

// =============================================================================
// 5) Every sub-permission has a valid parent
// =============================================================================

const domainSet = new Set(TENANT_PERMISSION_DOMAINS);
const featureSet = new Set(PLATFORM_FEATURE_KEYS);
const badTenantParents = TENANT_SUB_PERMISSIONS.filter((s) => !domainSet.has(s.parentDomain)).map((s) => s.id);
const badPlatformParents = PLATFORM_SUB_PERMISSIONS.filter((s) => !featureSet.has(s.feature)).map((s) => s.id);
check('5a every tenant sub has a valid parent domain', badTenantParents.length === 0, badTenantParents.join(','));
check('5b every platform sub has a valid parent feature', badPlatformParents.length === 0, badPlatformParents.join(','));
check('5c every sub min/default level is a known token', TENANT_SUB_PERMISSIONS.every((s) => PERMISSION_TOKENS.includes(s.minModuleLevel) && PERMISSION_TOKENS.includes(s.defaultLevel)), 'levels valid');
check('5d every platform sub threshold is a known token', PLATFORM_SUB_PERMISSIONS.every((s) => PERMISSION_TOKENS.includes(s.threshold)), 'thresholds valid');

// =============================================================================
// 6) Every role default references valid domains / sub-permissions
// =============================================================================

const tenantSubIdSet = new Set(tenantSubIds);
const platformSubIdSet = new Set(platformSubIds);

let roleDomainBad: string[] = [];
let roleSubBad: string[] = [];
for (const [role, map] of Object.entries(TENANT_ROLE_PERMISSION_DEFAULTS)) {
  for (const d of Object.keys(map)) if (!domainSet.has(d)) roleDomainBad.push(`${role}.${d}`);
  // Completeness: every domain represented for each non-owner tenant role.
  for (const d of TENANT_PERMISSION_DOMAINS) if (!(d in map)) roleDomainBad.push(`${role} missing ${d}`);
}
for (const [role, map] of Object.entries(TENANT_ROLE_SUBPERMISSION_DEFAULTS)) {
  for (const id of Object.keys(map)) if (!tenantSubIdSet.has(id)) roleSubBad.push(`${role}.${id}`);
}
check('6a tenant role permission defaults reference valid + complete domains', roleDomainBad.length === 0, roleDomainBad.slice(0, 6).join(' | '));
check('6b tenant role sub defaults reference valid sub ids', roleSubBad.length === 0, roleSubBad.slice(0, 6).join(' | '));

let platRoleBad: string[] = [];
for (const [role, map] of Object.entries(PLATFORM_ROLE_FEATURE_DEFAULTS)) {
  for (const f of Object.keys(map)) if (!featureSet.has(f)) platRoleBad.push(`${role}.${f}`);
  for (const f of PLATFORM_FEATURE_KEYS) if (!(f in map)) platRoleBad.push(`${role} missing ${f}`);
}
check('6c platform role defaults reference valid + complete feature keys', platRoleBad.length === 0, platRoleBad.slice(0, 6).join(' | '));

// =============================================================================
// 7) Entitlement dependency keys internally consistent
// =============================================================================

let depSubBad: string[] = [];
for (const subs of Object.values(TENANT_FEATURE_PERMISSION_DEPENDENCIES)) {
  for (const id of subs) if (!tenantSubIdSet.has(id)) depSubBad.push(id);
}
check('7a feature-dependency entries reference valid tenant sub ids', depSubBad.length === 0, depSubBad.join(','));

let reqKeyBad: string[] = [];
for (const sub of TENANT_SUB_PERMISSIONS) {
  for (const k of requiredEntitlementsForTenantSub(sub)) if (!KNOWN_TENANT_ENTITLEMENT_KEYS.has(k)) reqKeyBad.push(`${sub.id}:${k}`);
}
check('7b every required entitlement key is a KNOWN catalog key', reqKeyBad.length === 0, reqKeyBad.slice(0, 6).join(' | '));

let platDepBad: string[] = [];
for (const [dep, prereqs] of Object.entries(PLATFORM_PERMISSION_DEPENDENCIES)) {
  if (!platformSubIdSet.has(dep)) platDepBad.push(`dep:${dep}`);
  for (const p of prereqs) if (!platformSubIdSet.has(p)) platDepBad.push(`prereq:${p}`);
}
check('7c platform dependency map references valid platform sub ids', platDepBad.length === 0, platDepBad.slice(0, 6).join(' | '));

// Domain gate keys (non-null) are part of the known set and the domain map is complete.
const domainMapComplete = TENANT_PERMISSION_DOMAINS.every((d) => d in TENANT_DOMAIN_ENTITLEMENT);
check('7d tenant domain entitlement map covers every domain', domainMapComplete, 'complete');

// =============================================================================
// 8) Unknown entitlement keys fail closed (never expand)
// =============================================================================

const ownerSubsBaseline = JSON.stringify(materializeTenantSubPermissions('store_owner', {}, false));
const ownerSubsUnknown = JSON.stringify(materializeTenantSubPermissions('store_owner', { 'totally-unknown-feature': true, pos: true }, false));
check('8a unknown entitlement key grants nothing (sub-permissions identical to empty)', ownerSubsBaseline === ownerSubsUnknown, 'no expansion');

const ownerPermBaseline = JSON.stringify(materializeTenantPermissions('store_owner', {}, false));
const ownerPermUnknown = JSON.stringify(materializeTenantPermissions('store_owner', { 'totally-unknown-feature': true }, false));
check('8b unknown entitlement key grants nothing (domain permissions identical to empty)', ownerPermBaseline === ownerPermUnknown, 'no expansion');

// A gated capability without its known gate is false even for the owner.
const ownerNoShipping = materializeTenantSubPermissions('store_owner', {}, false);
check('8c gated capability false without its known entitlement (configure_shipping_provider)', ownerNoShipping.configure_shipping_provider === false, String(ownerNoShipping.configure_shipping_provider));

// Unknown role fails closed to empty maps.
check('8d unknown tenant role → empty maps (fail closed)', Object.keys(materializeTenantSubPermissions('not_a_role', { shipping: true }, false)).length === 0, 'empty');

// =============================================================================
// 9) No secret-like keys or values anywhere in the catalog
// =============================================================================

const catalogSrc = read('server/platform-identity/permissionCatalog.ts');
const forbiddenTokens = [
  'accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey',
  'service_role', 'databaseUrl', 'DATABASE_URL', 'connectionString', 'password',
  'SUPABASE_', 'SECRET', 'process.env',
];
// Strip comments so we scan executable code + data only. Strip LINE comments
// FIRST so a header mention like `(src/**)` cannot masquerade as a `/*` block and
// swallow real code.
const codeOnly = catalogSrc.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const leakedInCode = forbiddenTokens.filter((t) => codeOnly.includes(t));
check('9a catalog source contains no secret-like tokens (code+data)', leakedInCode.length === 0, leakedInCode.join(','));

// Materialized OUTPUT (keys + values) carries no secret-like field name.
const sampleOut = JSON.stringify({
  tPerm: materializeTenantPermissions('store_owner', { shipping: true, returns: true }, false),
  tSub: materializeTenantSubPermissions('manager', { shipping: true, shipping_providers: true }, false),
});
const leakedInOut = ['accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey', 'databaseUrl', 'connectionString', 'password'].filter((t) => sampleOut.includes(t));
check('9b materialized output carries no secret-like field', leakedInOut.length === 0, leakedInOut.join(','));

// Inertness: catalog imports only inert modules (no DB/env/network/frontend).
// Imports are real statements (never inside comments), so read from raw source.
const catImports = [...catalogSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const allowedCatImports = new Set(['./authorizationConstants', './authorizationContract']);
check('9c catalog imports only inert modules', catImports.length > 0 && catImports.every((i) => allowedCatImports.has(i)), `imports=[${catImports.join(', ')}]`);
check('9d catalog imports no frontend (src/)', !/from '[^']*\/src\//.test(codeOnly) && !/from 'src\//.test(codeOnly), 'no src import');
check('9e catalog performs no I/O', !/getDb|from 'postgres'|postgres\(|from 'express'|fetch\(|createClient|firebase|supabase|https?:\/\/|require\(/i.test(codeOnly), 'no io');

// =============================================================================
// 10) Phase 1.6 M2 — feature-key normalization exports + parity
// =============================================================================

const aliasKeys = Object.keys(FEATURE_KEY_ALIASES);
const aliasVals = Object.values(FEATURE_KEY_ALIASES);
// Known synonym present and canonical target is the planFeatures (hyphen) form.
check('10a supply_chain alias normalizes to canonical supply-chain', normalizeFeatureKey('supply_chain') === 'supply-chain', normalizeFeatureKey('supply_chain'));
check('10b normalizeFeatureKey idempotent on canonical (supply-chain → supply-chain)', normalizeFeatureKey('supply-chain') === 'supply-chain', normalizeFeatureKey('supply-chain'));
check('10c normalizeFeatureKey idempotent (normalize∘normalize == normalize)', aliasKeys.every((k) => normalizeFeatureKey(normalizeFeatureKey(k)) === normalizeFeatureKey(k)), 'idempotent');
check('10d normalizeFeatureKey deterministic (repeat call equal)', normalizeFeatureKey('supply_chain') === normalizeFeatureKey('supply_chain'), 'deterministic');
check('10e unknown key normalizes to itself (stays fail-closed)', normalizeFeatureKey('totally-unknown-feature') === 'totally-unknown-feature', 'self');
// Many-to-one + idempotent: no alias target is itself an alias source key.
check('10f every alias target is canonical (not an alias source key)', aliasVals.every((v) => !(v in FEATURE_KEY_ALIASES)), aliasVals.join(','));
// Aliases can only line up with an EXISTING gate, never invent a capability.
check('10g every alias target is a KNOWN catalog gate key', aliasVals.every((v) => KNOWN_TENANT_ENTITLEMENT_KEYS.has(v)), aliasVals.filter((v) => !KNOWN_TENANT_ENTITLEMENT_KEYS.has(v)).join(','));
// The catalog's OWN gate keys are already canonical (no alias leaked into a gate).
const nonCanonGate = [...KNOWN_TENANT_ENTITLEMENT_KEYS].filter((k) => normalizeFeatureKey(k) !== k);
check('10h every known entitlement gate key is canonical', nonCanonGate.length === 0, nonCanonGate.join(','));
// Frontend parity: canonical target appears in planFeatures; alias source is a tenant domain id.
check('10i canonical supply-chain present in frontend planFeatures', /'supply-chain'/.test(accessConfigSrc), 'planFeatures parity');
check('10j alias source supply_chain is a tenant domain id', domainSet.has('supply_chain'), 'domain id');

// =============================================================================
// 11) Phase 1.6 M2 — platform role vocabulary parity (catalog ↔ constants)
// =============================================================================

const catalogPlatformRoles = Object.keys(PLATFORM_ROLE_FEATURE_DEFAULTS).sort();
const constantsPlatformRoles = [...PLATFORM_ROLE_IDS].sort();
check('11a catalog platform roles == constants PLATFORM_ROLE_IDS', JSON.stringify(catalogPlatformRoles) === JSON.stringify(constantsPlatformRoles), catalogPlatformRoles.join(','));
check('11b billing_admin + security_admin are catalog-defined', 'billing_admin' in PLATFORM_ROLE_FEATURE_DEFAULTS && 'security_admin' in PLATFORM_ROLE_FEATURE_DEFAULTS, 'present');
check('11c platform_admin + platform_readonly absent from catalog roles', !('platform_admin' in PLATFORM_ROLE_FEATURE_DEFAULTS) && !('platform_readonly' in PLATFORM_ROLE_FEATURE_DEFAULTS), 'absent');

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[permission-catalog-static-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
