// Phase 1.6 M4 — STATIC (offline) frontend auth-provider INVENTORY check.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no
// SQL, no migration, no audit write, no Supabase MCP, no live/route call. It reads
// the frontend (`src/**`) and `package.json` as TEXT only (read-only parity —
// NEVER imported, NEVER modified) to inventory the current Firebase-derived
// frontend auth authority vs the isolated, dev-only `src/pilot/**` Supabase auth
// path, and to prove the main app does not consume the pilot auth client.
//
// Run:  npx tsx scripts/diagnostics-frontend-auth-provider-inventory-check.ts

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- collect every frontend source file (read as TEXT) ---------------------
function walk(relDir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}
const srcFiles = walk('src');
const text = new Map<string, string>(srcFiles.map((f) => [f, read(f)]));
const filesWhere = (re: RegExp) => srcFiles.filter((f) => re.test(text.get(f)!));
const nonPilot = (f: string) => !f.startsWith('src/pilot/');

// =============================================================================
// 1) Firebase is the current production frontend auth authority
// =============================================================================

const firebaseImportFiles = filesWhere(/from '@?firebase(\/[a-z]+)?'/);
check('1a Firebase is imported by the production app', firebaseImportFiles.length > 0, firebaseImportFiles.join(', '));
check('1b core auth files use Firebase (firebase.ts, Login.tsx, AccessContext.tsx)',
  /from 'firebase\/auth'/.test(text.get('src/firebase.ts') ?? '') &&
  /from 'firebase\/auth'/.test(text.get('src/components/Login.tsx') ?? '') &&
  /onAuthStateChanged/.test(text.get('src/context/AccessContext.tsx') ?? ''),
  'firebase-derived session');

// =============================================================================
// 2) Supabase SDK usage is isolated to the dev-only pilot
// =============================================================================

const supabaseSdkFiles = filesWhere(/from '@supabase\/supabase-js'/);
// Phase 1.6 M5 (owner-approved, controlled allowlist): the Supabase SDK may be
// imported ONLY under the dev-only pilot AND in the single dormant app-level auth
// foundation file. ANY other non-pilot, non-foundation SDK import is a regression.
// Compensating dormancy assertions (2e–2g below) prove the foundation is not
// reachable from any active app entrypoint.
const M5_FOUNDATION = 'src/auth/supabaseAuthFoundation.ts';
const sdkAllowed = (f: string) => f.startsWith('src/pilot/') || f === M5_FOUNDATION;
const sdkOutsideAllowlist = supabaseSdkFiles.filter((f) => !sdkAllowed(f));
check('2a @supabase/supabase-js imported ONLY under src/pilot/ + the dormant M5 foundation file', supabaseSdkFiles.length > 0 && sdkOutsideAllowlist.length === 0, sdkOutsideAllowlist.join(', ') || `allowed: [${supabaseSdkFiles.join(', ')}]`);

// Main app (non-pilot) must NOT import any pilot auth client module.
const pilotClientImport = /from '[^']*pilot\/(supabaseClient|sessionResolvePilotClient|identityDiagnosticClient)'/;
const leakedPilotClient = filesWhere(pilotClientImport).filter(nonPilot);
check('2b main app does not import the pilot Supabase auth client', leakedPilotClient.length === 0, leakedPilotClient.join(', ') || 'pilot-scoped only');

// The session-resolve round-trip reference stays pilot-scoped.
const sessionResolveRef = filesWhere(/\/auth\/session\/resolve|runSessionResolve/).filter(nonPilot);
check('2c token→/auth/session/resolve reference is pilot-scoped (not wired into main app)', sessionResolveRef.length === 0, sessionResolveRef.join(', ') || 'pilot-scoped only');

// The pilot is mounted only behind the dev gate (lazy + PILOT_ROUTE_ENABLED).
const appSrc = text.get('src/App.tsx') ?? '';
check('2d App routing mounts the pilot only behind the dev gate (PILOT_ROUTE_ENABLED)', /PILOT_ROUTE_ENABLED/.test(appSrc) && /lazy\(\s*\(\)\s*=>\s*import\('\.\/pilot\//.test(appSrc), 'gated lazy mount');

// Phase 1.6 M5 — compensating dormancy assertions for the new app-level foundation:
// it exists, but is imported by NOTHING active (so the bundler tree-shakes it out of
// production). Any importer — especially an entrypoint — would defeat dormancy.
const M5_FOUNDATION_TYPES = 'src/auth/supabaseAuthFoundationTypes.ts';
const M5_ENTRYPOINTS = ['src/main.tsx', 'src/App.tsx', 'src/components/Login.tsx', 'src/context/AccessContext.tsx', 'src/components/AccessGuard.tsx'];
// Matches static `from '…/supabaseAuthFoundation'`, bare `import '…'`, and dynamic
// `import('…')` — but NOT the sibling `…FoundationTypes` module.
const refsM5Foundation = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseAuthFoundation'/.test(s);
const m5Importers = srcFiles.filter((f) => f !== M5_FOUNDATION && f !== M5_FOUNDATION_TYPES && refsM5Foundation(text.get(f)!));
check('2e dormant M5 Supabase auth foundation file is present', text.has(M5_FOUNDATION), text.has(M5_FOUNDATION) ? M5_FOUNDATION : 'absent');
check('2f M5 foundation is NOT imported by any active app entrypoint (Login/AccessContext/AccessGuard/App/main)', m5Importers.filter((f) => M5_ENTRYPOINTS.includes(f)).length === 0, m5Importers.filter((f) => M5_ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('2g M5 foundation is imported nowhere in src/** yet (no call site added in M5)', m5Importers.length === 0, m5Importers.join(', ') || 'no importers');

// =============================================================================
// 3) Dependency presence (package.json, read as TEXT)
// =============================================================================

const pkg = read('package.json');
check('3a @supabase/supabase-js already declared (no package change needed)', /"@supabase\/supabase-js"\s*:/.test(pkg), 'present');
check('3b firebase already declared', /"firebase"\s*:/.test(pkg), 'present');

// =============================================================================
// 4) Client env variable NAMES only (no values)
// =============================================================================

const allSrc = srcFiles.map((f) => text.get(f)!).join('\n');
const presentName = (n: string) => allSrc.includes(n);
check('4a VITE_SUPABASE_URL referenced client-side', presentName('VITE_SUPABASE_URL'), 'name only');
check('4b VITE_SUPABASE_ANON_KEY referenced client-side', presentName('VITE_SUPABASE_ANON_KEY'), 'name only');
check('4c VITE_ENABLE_SUPABASE_PILOT referenced client-side', presentName('VITE_ENABLE_SUPABASE_PILOT'), 'name only');
check('4d VITE_IDENTITY_API_BASE referenced client-side', presentName('VITE_IDENTITY_API_BASE'), 'name only');
// The future shadow flag is documented but NOT yet wired into the frontend.
check('4e future VITE_ENABLE_SERVER_AUTHZ_SHADOW is NOT yet in src/ (documented/dormant)', !presentName('VITE_ENABLE_SERVER_AUTHZ_SHADOW'), 'future-only');

// =============================================================================
// 5) Inventory summary (informational — always reported)
// =============================================================================

check('5a auth/session/client file inventory', true, `firebase=[${firebaseImportFiles.length}] supabase-sdk=[${supabaseSdkFiles.join(', ')}] pilot=[${srcFiles.filter((f) => f.startsWith('src/pilot/')).length} files]`);

// =============================================================================
// 6) Inertness via import-allowlist (non-circular) + no env access
// =============================================================================

const selfSrc = read('scripts/diagnostics-frontend-auth-provider-inventory-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
check('6a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('6b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('6c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('6d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[frontend-auth-provider-inventory-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
