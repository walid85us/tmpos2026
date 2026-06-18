// Phase 1.6 M3 — STATIC (offline) AccessContext adoption-readiness check.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env secrets, no
// SQL, no migration, no audit write, no Supabase MCP, no route call. It imports the
// inert SERVER permission catalog (the server-derived key space) and reads the
// FROZEN frontend permission/session files as TEXT (read-only parity — NEVER
// imported, NEVER modified) to prove a FUTURE AccessContext adapter could map
// server-derived authorization onto the existing frontend vocabulary with NO key
// silently dropped, and WITHOUT the frontend importing any server module.
//
// This proves READINESS only. It builds nothing, wires nothing, and changes no
// frontend behavior. Frontend adoption remains deferred (see the M3 doc).
//
// Run:  npx tsx scripts/diagnostics-accesscontext-adoption-readiness-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TENANT_PERMISSION_DOMAINS,
  TENANT_SUB_PERMISSIONS,
  PLATFORM_FEATURE_KEYS,
  PLATFORM_SUB_PERMISSIONS,
  KNOWN_TENANT_ENTITLEMENT_KEYS,
  normalizeFeatureKey,
} from '../server/platform-identity/permissionCatalog';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- frozen frontend sources (read as TEXT only — never imported) ----------
const accessConfigSrc = read('src/context/accessConfig.ts');
const platformConfigSrc = read('src/owner/platformPermissionsConfig.ts');
const mapperSrc = read('src/auth/mapWhoamiToAppSession.ts');
const appSessionSrc = read('src/auth/appSession.ts');

// Slice a top-level `export const NAME = [ ... ];` / `{ ... };` block by name.
function declBlock(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) return '';
  const candidates = [src.indexOf('\n];', start), src.indexOf('\n};', start)].filter((e) => e >= 0);
  const end = candidates.length ? Math.min(...candidates) : src.length;
  return src.slice(start, end);
}
// Ids/keys may contain digits (e.g. `view_tenant_360`), so allow [a-z0-9_].
const idSet = (s: string) => new Set([...s.matchAll(/id:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
const keySet = (s: string) => new Set([...s.matchAll(/key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));

function diff(a: Set<string>, b: Set<string>): { aOnly: string[]; bOnly: string[] } {
  return {
    aOnly: [...a].filter((x) => !b.has(x)).sort(),
    bOnly: [...b].filter((x) => !a.has(x)).sort(),
  };
}

// ---- frontend key spaces (extracted from text) -----------------------------
const feDomains = idSet(declBlock(accessConfigSrc, 'export const PERMISSION_DOMAINS'));
const feSubs = idSet(declBlock(accessConfigSrc, 'export const SUB_PERMISSIONS'));
const pfgBlock = declBlock(platformConfigSrc, 'export const PLATFORM_FEATURE_GROUPS');
const feFeatures = keySet(pfgBlock);
const feSubsPlatform = idSet(pfgBlock);
const planBlock = declBlock(accessConfigSrc, 'export const planFeatures');
const fePlanFeatures = new Set([...planBlock.matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]));

// ---- server key spaces (imported from the inert catalog) -------------------
const srvDomains = new Set<string>(TENANT_PERMISSION_DOMAINS);
const srvSubs = new Set(TENANT_SUB_PERMISSIONS.map((s) => s.id));
const srvFeatures = new Set<string>(PLATFORM_FEATURE_KEYS);
const srvSubsPlatform = new Set(PLATFORM_SUB_PERMISSIONS.map((s) => s.id));

// =============================================================================
// 1) Tenant DOMAIN parity — adapter mapping is TOTAL (no key dropped either way)
// =============================================================================
{
  const d = diff(srvDomains, feDomains);
  check('1a no server tenant domain unmapped on the frontend', d.aOnly.length === 0, d.aOnly.join(','));
  check('1b no frontend tenant domain unaccounted in the server model', d.bOnly.length === 0, d.bOnly.join(','));
  check('1c tenant domain sets are in exact parity', d.aOnly.length === 0 && d.bOnly.length === 0, `srv=${srvDomains.size} fe=${feDomains.size}`);
}

// =============================================================================
// 2) Tenant SUB-permission parity
// =============================================================================
{
  const d = diff(srvSubs, feSubs);
  check('2a no server tenant sub-permission unmapped on the frontend', d.aOnly.length === 0, d.aOnly.slice(0, 8).join(','));
  check('2b no frontend tenant sub-permission unaccounted in the server model', d.bOnly.length === 0, d.bOnly.slice(0, 8).join(','));
  check('2c tenant sub-permission sets are in exact parity', d.aOnly.length === 0 && d.bOnly.length === 0, `srv=${srvSubs.size} fe=${feSubs.size}`);
}

// =============================================================================
// 3) Platform FEATURE-key parity
// =============================================================================
{
  const d = diff(srvFeatures, feFeatures);
  check('3a no server platform feature key unmapped on the frontend', d.aOnly.length === 0, d.aOnly.join(','));
  check('3b no frontend platform feature key unaccounted in the server model', d.bOnly.length === 0, d.bOnly.join(','));
  check('3c platform feature key sets are in exact parity', d.aOnly.length === 0 && d.bOnly.length === 0, `srv=${srvFeatures.size} fe=${feFeatures.size}`);
}

// =============================================================================
// 4) Platform SUB-permission parity
// =============================================================================
{
  const d = diff(srvSubsPlatform, feSubsPlatform);
  check('4a no server platform sub-permission unmapped on the frontend', d.aOnly.length === 0, d.aOnly.slice(0, 8).join(','));
  check('4b no frontend platform sub-permission unaccounted in the server model', d.bOnly.length === 0, d.bOnly.slice(0, 8).join(','));
  check('4c platform sub-permission sets are in exact parity', d.aOnly.length === 0 && d.bOnly.length === 0, `srv=${srvSubsPlatform.size} fe=${feSubsPlatform.size}`);
}

// =============================================================================
// 5) Feature-key (entitlement) adapter: every server gate key maps to a
//    frontend plan-feature key after canonical normalization
// =============================================================================
{
  const known = [...KNOWN_TENANT_ENTITLEMENT_KEYS].map(normalizeFeatureKey);
  const missing = known.filter((k) => !fePlanFeatures.has(k));
  check('5a every server entitlement gate key (normalized) maps to a frontend planFeatures key', missing.length === 0, missing.join(','));
  check('5b supply_chain alias resolves to the planFeatures form supply-chain', normalizeFeatureKey('supply_chain') === 'supply-chain' && fePlanFeatures.has('supply-chain'), 'supply-chain');
}

// =============================================================================
// 6) mapWhoamiToAppSession remains a plausible future seam (adapter target)
// =============================================================================
{
  // The existing pure mapper seam exists.
  const seamPresent = /export\s+function\s+mapWhoamiToAppSession/.test(mapperSrc);
  // Its FLAT input does NOT carry `authorization`: the future adapter must read the
  // STRUCTURED wire `authorization` field — documenting the exact adapter point.
  const whoamiBlock = mapperSrc.slice(mapperSrc.indexOf('interface WhoamiResponseInput'), mapperSrc.indexOf('}', mapperSrc.indexOf('interface WhoamiResponseInput')));
  const inputCarriesAuthz = /(^|\n)\s*authorization\s*[?:]/.test(whoamiBlock);
  // The AppSession model already has a forward-compatible authorization slot.
  const appSessionHasAuthzSlot = /authorization:\s*AppAuthorization\s*\|\s*null/.test(appSessionSrc);
  check('6a mapWhoamiToAppSession seam present', seamPresent, 'seam');
  check('6b mapper flat input does not yet read authorization (adapter must read structured wire field)', !inputCarriesAuthz, inputCarriesAuthz ? 'already reads authz' : 'structured-field adapter point');
  check('6c AppSession model has a forward-compatible authorization slot', appSessionHasAuthzSlot, 'slot present');
}

// =============================================================================
// 7) No frontend import of a server module is required for adoption
//    (frontend consumes the wire DTO only) — and this diagnostic never imports
//    a frontend module, never writes a frontend file.
// =============================================================================
{
  const selfSrc = read('scripts/diagnostics-accesscontext-adoption-readiness-check.ts');
  const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
  const allowed = new Set(['fs', 'path', '../server/platform-identity/permissionCatalog']);
  // fs is imported only for reading: assert the `from 'fs'` binding list is a
  // subset of {readFileSync} (no write API is even imported) — non-circular.
  const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1])
    .split(',').map((s) => s.trim()).filter(Boolean);
  check('7a diagnostic imports confined to node fs/path + inert catalog', selfImports.length > 0 && selfImports.every((i) => allowed.has(i)), selfImports.join(', '));
  check('7b diagnostic imports no frontend module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/')), 'text-only');
  check('7c diagnostic imports only readFileSync from fs (read-only, writes no file)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync'), fsBindings.join(','));
  check('7d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
  // The frozen frontend permission engines do NOT import any server module today.
  check('7e frontend accessConfig/platformConfig import no server/platform-identity module', !/platform-identity/.test(accessConfigSrc) && !/platform-identity/.test(platformConfigSrc), 'no server import in frontend');
}

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[accesscontext-adoption-readiness-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
