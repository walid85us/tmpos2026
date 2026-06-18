// Phase 1.6 M2 — STATIC (offline) feature-key canonicalization check.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env secrets, no
// SQL, no migration, no audit write, no Supabase MCP, no runtime endpoint call. It
// imports the inert catalog and reads the FROZEN frontend accessConfig as TEXT
// (read-only parity — never imported, never modified) to assert the feature-key
// normalization is deterministic, idempotent, many-to-one, cap-only, and that
// unknown keys remain fail-closed.
//
// Run:  npx tsx scripts/diagnostics-feature-key-canonicalization-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FEATURE_KEY_ALIASES,
  normalizeFeatureKey,
  KNOWN_TENANT_ENTITLEMENT_KEYS,
  TENANT_PERMISSION_DOMAINS,
  materializeTenantPermissions,
  materializeTenantSubPermissions,
} from '../server/platform-identity/permissionCatalog';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const aliasKeys = Object.keys(FEATURE_KEY_ALIASES);
const aliasVals = Object.values(FEATURE_KEY_ALIASES);
const domainSet = new Set(TENANT_PERMISSION_DOMAINS);
const accessConfigSrc = read('src/context/accessConfig.ts');

// =============================================================================
// 1) Canonical form follows the frozen frontend planFeatures form
// =============================================================================

check('1a supply_chain normalizes to supply-chain', normalizeFeatureKey('supply_chain') === 'supply-chain', normalizeFeatureKey('supply_chain'));
check('1b supply-chain normalizes to supply-chain (canonical fixed point)', normalizeFeatureKey('supply-chain') === 'supply-chain', normalizeFeatureKey('supply-chain'));
// Each alias target must be the planFeatures (hyphen) form; each source a domain id.
const formBad = Object.entries(FEATURE_KEY_ALIASES).filter(
  ([src, canon]) => !new RegExp(`'${canon}'`).test(accessConfigSrc) || !domainSet.has(src),
);
check('1c each alias maps a domain-id form to its planFeatures canonical form', formBad.length === 0, formBad.map(([s]) => s).join(','));

// =============================================================================
// 2) Deterministic, idempotent, many-to-one
// =============================================================================

check('2a deterministic (repeat call equal)', normalizeFeatureKey('supply_chain') === normalizeFeatureKey('supply_chain'), 'deterministic');
const sample = [...aliasKeys, ...aliasVals, 'supply_chain', 'supply-chain', 'inventory', 'totally-unknown-feature', 'supply chain'];
check('2b idempotent (normalize∘normalize == normalize) over a sample', sample.every((k) => normalizeFeatureKey(normalizeFeatureKey(k)) === normalizeFeatureKey(k)), 'idempotent');
check('2c many-to-one: no alias target is itself an alias source key', aliasVals.every((v) => !(v in FEATURE_KEY_ALIASES)), aliasVals.join(','));

// =============================================================================
// 3) Unknown keys normalize to themselves and stay fail-closed
// =============================================================================

check('3a unknown key normalizes to itself', normalizeFeatureKey('totally-unknown-feature') === 'totally-unknown-feature' && normalizeFeatureKey('supply chain') === 'supply chain', 'self');
check('3b every alias target is a KNOWN canonical gate key', aliasVals.every((v) => KNOWN_TENANT_ENTITLEMENT_KEYS.has(v)), aliasVals.filter((v) => !KNOWN_TENANT_ENTITLEMENT_KEYS.has(v)).join(','));
const nonCanonGate = [...KNOWN_TENANT_ENTITLEMENT_KEYS].filter((k) => normalizeFeatureKey(k) !== k);
check('3c every catalog entitlement gate key is already canonical', nonCanonGate.length === 0, nonCanonGate.join(','));

// =============================================================================
// 4) The supply_chain domain is gated by the supply-chain entitlement key
//    (canonical AND alias-form both line up; absent/unknown stay fail-closed)
// =============================================================================

const scCanonical = materializeTenantPermissions('store_owner', { 'supply-chain': true }, false).supply_chain;
const scAlias = materializeTenantPermissions('store_owner', { supply_chain: true }, false).supply_chain;
const scNone = materializeTenantPermissions('store_owner', {}, false).supply_chain;
const scBogus = materializeTenantPermissions('store_owner', { 'supply chain': true }, false).supply_chain;
check('4a supply_chain domain enabled by canonical supply-chain entitlement', scCanonical === 'full', String(scCanonical));
check('4b supply_chain domain enabled by alias supply_chain entitlement (normalized)', scAlias === 'full', String(scAlias));
check('4c supply_chain domain capped to none without the entitlement', scNone === 'none', String(scNone));
check('4d unknown "supply chain" entitlement does NOT enable the domain (fail closed)', scBogus === 'none', String(scBogus));

// Sub-permission end-to-end: manage_purchase_orders (parent supply_chain) follows
// the same gating — alias entitlement enables it, no entitlement denies it.
const mpoAlias = materializeTenantSubPermissions('manager', { supply_chain: true }, false).manage_purchase_orders;
const mpoNone = materializeTenantSubPermissions('manager', {}, false).manage_purchase_orders;
check('4e manage_purchase_orders granted via alias supply_chain entitlement', mpoAlias === true, String(mpoAlias));
check('4f manage_purchase_orders denied without the supply-chain entitlement', mpoNone === false, String(mpoNone));

// =============================================================================
// 5) Cap-only: normalization never expands beyond an empty entitlement map
// =============================================================================

const ownerPermEmpty = JSON.stringify(materializeTenantPermissions('store_owner', {}, false));
const ownerPermUnknown = JSON.stringify(materializeTenantPermissions('store_owner', { 'totally-unknown-feature': true, 'supply chain': true }, false));
check('5a unknown entitlement keys never expand domain permissions', ownerPermEmpty === ownerPermUnknown, 'no expansion');

const ownerSubEmpty = JSON.stringify(materializeTenantSubPermissions('store_owner', {}, false));
const ownerSubUnknown = JSON.stringify(materializeTenantSubPermissions('store_owner', { 'totally-unknown-feature': true, 'supply chain': true }, false));
check('5b unknown entitlement keys never expand sub-permissions', ownerSubEmpty === ownerSubUnknown, 'no expansion');

// Adding ONLY the alias may enable the supply-chain gate but nothing unrelated.
const aliasPerm = materializeTenantPermissions('store_owner', { supply_chain: true }, false);
const onlySupplyChainGained = TENANT_PERMISSION_DOMAINS.every((d) => {
  const base = materializeTenantPermissions('store_owner', {}, false)[d];
  return d === 'supply_chain' ? true : aliasPerm[d] === base;
});
check('5c alias entitlement enables ONLY the supply_chain gate, nothing unrelated', onlySupplyChainGained, 'scoped');

// =============================================================================
// 6) Inertness via import-allowlist (non-circular) + no env access
// =============================================================================

const selfSrc = read('scripts/diagnostics-feature-key-canonicalization-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const allowedImports = new Set([
  'fs',
  'path',
  '../server/platform-identity/permissionCatalog',
]);
// accessConfig (frontend) is read as TEXT via readFileSync — never imported.
check('6a diagnostic imports confined to node fs/path + inert catalog', selfImports.length > 0 && selfImports.every((i) => allowedImports.has(i)), selfImports.join(', '));
check('6b no frontend (src/) imported at runtime (read as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/')), 'no src import');
check('6c diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[feature-key-canonicalization-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
