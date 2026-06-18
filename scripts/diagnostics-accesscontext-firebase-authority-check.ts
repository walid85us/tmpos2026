// Phase 1.6 M6 — STATIC (offline) AccessContext FIREBASE-AUTHORITY lock.
//
// Phase 1.6 M8 (owner-approved, controlled hardening): AccessContext may now reach the M7
// awareness helper through a SINGLE DYNAMIC, DEV+flag-gated import used as a private, one-shot
// OBSERVER. Section 2 stays strict — AccessContext still imports NO Supabase SDK, NO M5
// foundation, and NO M6 bootstrap (the literal "AccessContext does NOT import the M6 bootstrap"
// guarantee is preserved). The new section 8 LOCKS the observer down: dynamic-only, type-only
// record import, DEV+flag-gated, private-ref, write-only (never read), AbortController cleanup,
// no session-resolve / server-authz / shadow flag — proving it is non-authoritative and the
// Firebase listener + loading lifecycle are unchanged.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call. It reads the
// frontend (`src/**`) and the M5/M6 docs as TEXT only (read-only — NEVER imported,
// NEVER modified) and PROVES the production session authority remains Firebase-derived:
// Login stays Firebase-based, AccessGuard still reads AccessContext, and App routing
// gained no Supabase session provider.
//
// Run:  npx tsx scripts/diagnostics-accesscontext-firebase-authority-check.ts

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

function walk(relDir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}
walk('src'); // (validates src/ is readable; per-file reads below)

const ac = read('src/context/AccessContext.tsx');
const login = read('src/components/Login.tsx');
const guard = read('src/components/AccessGuard.tsx');
const app = read('src/App.tsx');

const refsFoundation = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseAuthFoundation'/.test(s);
const refsBootstrap = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseSessionBootstrap'/.test(s);
const importsSupabaseSdk = (s: string) => /from '@supabase\/supabase-js'/.test(s);

// =============================================================================
// 1) AccessContext remains Firebase-derived
// =============================================================================
check('1a AccessContext subscribes to Firebase onAuthStateChanged', /onAuthStateChanged\s*\(\s*auth/.test(ac), 'firebase listener');
check('1b AccessContext imports the Firebase auth path', /from 'firebase\/auth'/.test(ac) && /from '\.\.\/firebase'/.test(ac), 'firebase/auth + ../firebase');
check('1c AccessContext reads the Firestore users/{uid} role doc', /getDoc\(\s*doc\(\s*db\s*,\s*'users'/.test(ac), 'firestore role doc');

// =============================================================================
// 2) AccessContext is free of Supabase SDK / M5 foundation / M6 bootstrap
// =============================================================================
check('2a AccessContext does NOT import the Supabase SDK', !importsSupabaseSdk(ac), 'no supabase sdk');
check('2b AccessContext does NOT import the M5 foundation', !refsFoundation(ac), 'no foundation');
check('2c AccessContext does NOT import the M6 bootstrap', !refsBootstrap(ac), 'no bootstrap');
check('2d AccessContext does NOT call the backend session-resolve route', !/\/auth\/session\/resolve|runSessionResolve/.test(ac), 'no session-resolve');

// =============================================================================
// 3) AccessContext still owns the legacy permission engine surface
// =============================================================================
check('3a AccessContext computes permissions via the legacy config (accessConfig/platformPermissionsConfig)', /from '\.\/accessConfig'/.test(ac) && /platformPermissionsConfig/.test(ac), 'legacy engine');
check('3b AccessContext exposes the existing permission helpers', /canAccess/.test(ac) && /hasPermission/.test(ac) && /checkSubPermission/.test(ac) && /getPermissionLevel/.test(ac), 'helpers intact');

// =============================================================================
// 4) Login remains Firebase-based and free of Supabase/foundation/bootstrap
// =============================================================================
check('4a Login imports firebase/auth', /from 'firebase\/auth'/.test(login), 'firebase login');
check('4b Login does NOT import the Supabase SDK', !importsSupabaseSdk(login), 'no supabase sdk');
check('4c Login does NOT import the M5 foundation', !refsFoundation(login), 'no foundation');
check('4d Login does NOT import the M6 bootstrap', !refsBootstrap(login), 'no bootstrap');

// =============================================================================
// 5) AccessGuard still reads AccessContext; no foundation/bootstrap leak
// =============================================================================
check('5a AccessGuard reads AccessContext via useAccess', /useAccess\s*\(/.test(guard) && /from '\.\.\/context\/AccessContext'/.test(guard), 'reads AccessContext');
check('5b AccessGuard does NOT import the Supabase SDK / foundation / bootstrap', !importsSupabaseSdk(guard) && !refsFoundation(guard) && !refsBootstrap(guard), 'unchanged');

// =============================================================================
// 6) App routing gained no Supabase session provider / foundation / bootstrap
// =============================================================================
check('6a App routing does NOT import the M6 bootstrap', !refsBootstrap(app), 'no bootstrap');
check('6b App routing does NOT import the M5 foundation', !refsFoundation(app), 'no foundation');
check('6c App routing does NOT import the Supabase SDK; pilot stays behind PILOT_ROUTE_ENABLED', !importsSupabaseSdk(app) && /PILOT_ROUTE_ENABLED/.test(app), 'gated; firebase-only providers');

// =============================================================================
// 7) authorization:null fallback semantics remain documented (M5/M6 docs)
// =============================================================================
const m5doc = read('docs/phase-1.6-milestone-5-supabase-auth-frontend-foundation-plan.md');
let m6doc = '';
try { m6doc = read('docs/phase-1.6-milestone-6-dual-provider-session-bootstrap-plan.md'); } catch { /* optional at run time */ }
// Normalize whitespace first so markdown hard-wrapping (a newline mid-phrase) does not
// hide the documented semantics.
const documentsFallback = (d: string) => {
  const flat = d.replace(/\s+/g, ' ');
  return /fall ?back to the legacy client engine/i.test(flat) && /authorization: ?null/i.test(flat);
};
check('7a authorization:null = fall-back-to-legacy semantics documented (M5 and/or M6 doc)', documentsFallback(m5doc) || documentsFallback(m6doc), documentsFallback(m6doc) ? 'M6 doc' : 'M5 doc');

// =============================================================================
// 8) Phase 1.6 M8 — AccessContext Supabase awareness OBSERVER is dynamic-only, gated,
//    private, and NON-AUTHORITATIVE (Firebase listener + loading lifecycle unchanged).
// =============================================================================
const dynamicHelperImport = /import\(\s*'[^']*\/supabaseAccessAwareness'\s*\)/.test(ac);
const staticHelperImport = /import\s+[^()]*?from\s*'[^']*\/supabaseAccessAwareness'/.test(ac);
// Slice the provider value object `value={{ … }}` so we can prove the ref is not exposed.
const valueStart = ac.indexOf('value={{');
const valueEnd = ac.indexOf('}}>', valueStart);
const providerValue = valueStart >= 0 && valueEnd >= 0 ? ac.slice(valueStart, valueEnd) : ac;
// The ref is WRITE-ONLY: `supabaseAwarenessRef.current` only ever appears as an assignment
// target. Any occurrence NOT immediately followed by `=` would be a READ (a consumer) — there
// must be zero, proving session/tenant/role/plan/permissions/loading/routing never read it.
const refReads = (ac.match(/supabaseAwarenessRef\.current(?!\s*=)/g) ?? []).length;
check('8a observer imports the M7 helper DYNAMICALLY (one-shot)', dynamicHelperImport, 'dynamic import()');
check('8b observer has NO static runtime import of the M7 helper', !staticHelperImport, 'no static import');
check('8c awareness record imported TYPE-ONLY (erased at runtime)', /import\s+type\s*\{[^}]*AccessAwarenessRecord[^}]*\}/.test(ac), 'type-only');
check('8d observer is DEV-gated (import.meta … .DEV)', /\.DEV\b/.test(ac), 'DEV gate');
check('8e observer is awareness-flag-gated (VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS)', /VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/.test(ac), 'flag gate');
check('8f observer result stored in a PRIVATE useRef (not React state)', /supabaseAwarenessRef\s*=\s*useRef</.test(ac) && !/useState[^;\n]*[Aa]wareness/.test(ac), 'private ref');
check('8g observer ref is NOT exposed in the provider value object', !providerValue.includes('supabaseAwarenessRef'), 'not in value');
check('8h observer ref value is WRITE-ONLY (never read by session/tenant/role/plan/permissions/loading/routing)', refReads === 0, refReads === 0 ? 'write-only' : `${refReads} read(s)`);
check('8i observer uses AbortController + abort() cleanup (StrictMode / cancellation-safe)', /new AbortController\(/.test(ac) && /\.abort\(\)/.test(ac), 'cancellation-safe');
check('8j observer does NOT call /auth/session/resolve (already covered by 2d; re-asserted)', !/\/auth\/session\/resolve|runSessionResolve/.test(ac), 'no session-resolve');
check('8k observer does NOT reference VITE_ENABLE_SERVER_AUTHZ_SHADOW', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(ac), 'no shadow flag');
check('8l observer does NOT read tokens (no access_token/refresh_token)', !/access_token|refresh_token/.test(ac), 'token-safe');
check('8m Firebase listener still present (loading lifecycle owner unchanged)', /onAuthStateChanged\s*\(\s*auth/.test(ac), 'firebase listener intact');

// =============================================================================
// 9) Self-inertness (non-circular allowlist + read-only fs + no env)
// =============================================================================
const selfSrc = read('scripts/diagnostics-accesscontext-firebase-authority-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
check('9a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('9b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('9c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('9d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[accesscontext-firebase-authority-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
