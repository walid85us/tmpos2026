// Phase 1.6 M8 — STATIC (offline) AccessContext Supabase OBSERVER-WIRING check.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call. It reads the
// frontend (`src/**`) and `package.json` as TEXT only (read-only — NEVER imported,
// NEVER modified) and PROVES the M8 AccessContext observer is wired EXACTLY as approved:
// a private, DEV+flag-gated, one-shot, DYNAMIC-import observer of the M7 helper whose
// result is stored ONLY in a private ref and consumed by NOTHING — so Firebase remains
// the sole authoritative session source and no session/permission/loading/routing behavior
// changes. It also re-locks Login / AccessGuard / App routing / src/main.tsx as un-migrated.
//
// Run:  npx tsx scripts/diagnostics-accesscontext-supabase-observer-wiring-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- frontend sources (read as TEXT only — never imported) ------------------
const ac = read('src/context/AccessContext.tsx');
const login = read('src/components/Login.tsx');
const guard = read('src/components/AccessGuard.tsx');
const app = read('src/App.tsx');
const main = read('src/main.tsx');
const pkg = read('package.json');

// ---- robust block slices ----------------------------------------------------
const FB_DEPS = '}, [platformRolesState]);';
const OBS_DEPS = '}, [loading]);';
const fbDepsIdx = ac.indexOf(FB_DEPS);
const fbStart = ac.indexOf('useEffect(() => {');
const fbBlock = (fbStart >= 0 && fbDepsIdx >= 0) ? ac.slice(fbStart, fbDepsIdx + FB_DEPS.length) : '';

const obsStart = ac.indexOf('useEffect(() => {', fbDepsIdx >= 0 ? fbDepsIdx + FB_DEPS.length : 0);
const obsDepsIdx = ac.indexOf(OBS_DEPS, obsStart >= 0 ? obsStart : 0);
const observerBlock = (obsStart >= 0 && obsDepsIdx >= 0) ? ac.slice(obsStart, obsDepsIdx + OBS_DEPS.length) : '';
// Everything declared AFTER the observer effect: session/tenant/effectiveRole, every
// permission function, isStoreActivated, resolveLandingRoute, AND the provider value.
const afterObserver = obsDepsIdx >= 0 ? ac.slice(obsDepsIdx + OBS_DEPS.length) : ac;

const valStart = ac.indexOf('value={{');
const valEnd = ac.indexOf('}}>', valStart);
const providerValue = (valStart >= 0 && valEnd >= 0) ? ac.slice(valStart, valEnd) : '';

const typeStart = ac.indexOf('interface AccessContextType {');
const typeEnd = ac.indexOf('\n}', typeStart);
const contextType = (typeStart >= 0 && typeEnd >= 0) ? ac.slice(typeStart, typeEnd) : '';

// ---- helper import detectors (match the helper module, never `…AwarenessTypes`) ----
const dynamicHelperImport = /import\(\s*'[^']*\/supabaseAccessAwareness'\s*\)/.test(ac);
const staticHelperImport = /import\s+[^()]*?from\s*'[^']*\/supabaseAccessAwareness'/.test(ac);
const typeOnlyImport = /import\s+type\s*\{[^}]*AccessAwarenessRecord[^}]*\}\s*from\s*'[^']*\/supabaseAccessAwarenessTypes'/.test(ac);

// The ref is WRITE-ONLY: any `supabaseAwarenessRef.current` NOT immediately assigned (`= …`)
// would be a consumer READ. There must be zero such reads.
const refReads = (ac.match(/supabaseAwarenessRef\.current(?!\s*=)/g) ?? []).length;

// =============================================================================
// 1) Helper import shape (dynamic-only + type-only record; gated)
// =============================================================================
check('1 AccessContext contains a DYNAMIC import of the M7 helper', dynamicHelperImport, 'import(\'…/supabaseAccessAwareness\')');
check('2 AccessContext has NO runtime static import of the M7 helper', !staticHelperImport, 'no static helper import');
check('3 AccessContext imports the awareness record TYPE-ONLY (erased at runtime)', typeOnlyImport, 'import type { AccessAwarenessRecord }');
{
  const devIdx = observerBlock.indexOf('.DEV');
  const flagIdx = observerBlock.indexOf('VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS');
  const dynIdx = observerBlock.indexOf("import('");
  check('4 dynamic import is inside the import.meta.env.DEV guard (DEV precedes import)', devIdx >= 0 && dynIdx >= 0 && devIdx < dynIdx, devIdx >= 0 && dynIdx >= 0 ? 'DEV-gated' : 'guard/import missing');
  check('5 dynamic import is inside the VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS guard (flag precedes import)', flagIdx >= 0 && dynIdx >= 0 && flagIdx < dynIdx, flagIdx >= 0 && dynIdx >= 0 ? 'flag-gated' : 'guard/import missing');
}

// =============================================================================
// 2) AccessContext imports NO bootstrap / foundation / SDK / pilot
// =============================================================================
check('6 AccessContext does NOT import the M6 bootstrap', !/supabaseSessionBootstrap/.test(ac), 'no bootstrap');
check('7 AccessContext does NOT import the M5 foundation', !/supabaseAuthFoundation/.test(ac), 'no foundation');
check('8 AccessContext does NOT import @supabase/supabase-js', !/@supabase\/supabase-js/.test(ac), 'no SDK');
check('9 AccessContext does NOT import any pilot module', !/from '[^']*pilot\//.test(ac) && !/import\(\s*'[^']*pilot\//.test(ac), 'no pilot import');

// =============================================================================
// 3) Private ref; not React state; not exposed via value or context type
// =============================================================================
check('10 awareness result uses a PRIVATE useRef', /const\s+supabaseAwarenessRef\s*=\s*useRef</.test(ac), 'useRef');
check('11 awareness result does NOT use React state (no awareness useState)', !/useState[^;\n]*[Aa]wareness/.test(ac), 'no awareness useState');
check('12 awareness ref is NOT included in the provider value object', providerValue.length > 0 && !providerValue.includes('supabaseAwarenessRef'), 'not in value');
check('13 awareness ref/record is NOT exposed through the context type', contextType.length > 0 && !/supabaseAwarenessRef|AccessAwarenessRecord/.test(contextType), 'not in AccessContextType');

// =============================================================================
// 4) Ref is write-only — used by NO session/tenant/role/plan/permission/route path
// =============================================================================
check('14 awareness ref value is WRITE-ONLY (never read by any consumer)', refReads === 0, refReads === 0 ? 'write-only' : `${refReads} read(s)`);
// Check 15 proves the ref appears nowhere after the observer effect, which is where ALL of
// session/tenant/effectiveRole, getPermissionLevel, checkPermission, checkSubPermission,
// canAccess, hasPermission, isStoreActivated, resolveLandingRoute, and the provider value are
// defined — so none of those authority surfaces can read it.
check('15 awareness ref is not referenced anywhere AFTER the observer effect (session/tenant/role/plan/permissions/value)', !afterObserver.includes('supabaseAwarenessRef'), 'absent from derivations + permission fns + value');
check('16 effectiveRole derivation does not reference the awareness ref', !/effectiveRole[\s\S]{0,160}supabaseAwarenessRef/.test(ac), 'role/effectiveRole clean');
check('17 session/tenant derivation does not reference the awareness ref', !/const session =[\s\S]{0,200}supabaseAwarenessRef/.test(ac), 'session/tenant clean');
check('18 observer does NOT call setLoading (loading lifecycle unchanged)', !observerBlock.includes('setLoading'), 'no setLoading in observer');

// =============================================================================
// 5) Firebase listener present + observer is a SEPARATE effect after init
// =============================================================================
check('19 Firebase onAuthStateChanged listener is still present', /onAuthStateChanged\s*\(\s*auth/.test(ac), 'firebase listener intact');
check('20 Firebase effect retains its core shape (getDoc users/{uid}, setLoading(false), unsubscribe)', /getDoc\(\s*doc\(\s*db\s*,\s*'users'/.test(fbBlock) && /setLoading\(false\)/.test(fbBlock) && /return unsubscribe/.test(fbBlock), 'firebase effect intact');
check('21 the observer is a SEPARATE effect (distinct from the Firebase effect)', observerBlock.length > 0 && obsStart > fbDepsIdx, 'separate effect');
check('22 the observer effect depends on [loading] (runs only after Firebase init)', observerBlock.includes(OBS_DEPS) && /if\s*\(\s*loading\s*\)\s*return/.test(observerBlock), 'loading-gated');
check('23 the Firebase effect still depends on [platformRolesState] (unchanged deps)', fbBlock.includes(FB_DEPS), 'firebase deps intact');

// =============================================================================
// 6) One-shot + cancellation-safe
// =============================================================================
check('24 observer uses an AbortController', /new AbortController\(/.test(observerBlock), 'AbortController');
check('25 observer cleanup aborts the controller', /return\s*\(\)\s*=>\s*controller\.abort\(\)/.test(observerBlock) || /controller\.abort\(\)/.test(observerBlock), 'abort on cleanup');
check('26 observer calls the M7 runner only THROUGH the dynamic import', /import\([^)]*supabaseAccessAwareness'\s*\)/.test(observerBlock) && /runAccessContextSupabaseAwarenessObservation\s*\(/.test(observerBlock), 'dynamic-then-call');
{
  const runnerCalls = (observerBlock.match(/runAccessContextSupabaseAwarenessObservation\s*\(/g) ?? []).length;
  const dynImports = (observerBlock.match(/import\(\s*'[^']*\/supabaseAccessAwareness'\s*\)/g) ?? []).length;
  check('27 observer calls the runner at most once per effect lifecycle (no loop/subscribe)', runnerCalls === 1 && dynImports === 1 && !/setInterval|setTimeout|addEventListener|\.subscribe\s*\(|onAuthStateChange/.test(observerBlock), `runner=${runnerCalls} import=${dynImports}`);
}

// =============================================================================
// 7) Token / authorization / network / shadow safety inside the observer
// =============================================================================
check('28 observer does NOT log the awareness record (no console.*)', !/console\./.test(observerBlock), 'no console in observer');
check('29 observer does NOT reference access_token', !/access_token/.test(observerBlock), 'no access_token');
check('30 observer does NOT reference refresh_token', !/refresh_token/.test(observerBlock), 'no refresh_token');
check('31 observer does NOT reference a raw JWT / provider token', !/\bjwt\b/i.test(observerBlock) && !/provider_token/.test(observerBlock), 'no jwt/provider token');
check('32 observer does NOT call /auth/session/resolve', !/\/auth\/session\/resolve|runSessionResolve/.test(ac), 'no session-resolve');
check('33 observer does NOT read server-derived authorization', !/authorization/i.test(observerBlock), 'no authz');
check('34 observer does NOT reference VITE_ENABLE_SERVER_AUTHZ_SHADOW', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(ac), 'no shadow flag');

// =============================================================================
// 8) Login / AccessGuard / App routing / main.tsx remain un-migrated
// =============================================================================
const refsAwareness = (s: string) => /supabaseAccessAwareness/.test(s);
check('35 Login remains Firebase-based (firebase/auth) and free of the awareness helper', /from 'firebase\/auth'/.test(login) && !refsAwareness(login) && !/@supabase\/supabase-js/.test(login), 'firebase login');
check('36 AccessGuard still reads AccessContext and imports no awareness/foundation/bootstrap/SDK', /useAccess\s*\(/.test(guard) && !refsAwareness(guard) && !/supabaseAuthFoundation|supabaseSessionBootstrap|@supabase\/supabase-js/.test(guard), 'guard unchanged');
check('37 App routing imports no awareness/foundation/bootstrap; pilot stays behind PILOT_ROUTE_ENABLED', !refsAwareness(app) && !/supabaseAuthFoundation|supabaseSessionBootstrap/.test(app) && /PILOT_ROUTE_ENABLED/.test(app), 'routing unchanged');
check('38 src/main.tsx imports no awareness helper and keeps StrictMode', !refsAwareness(main) && /StrictMode/.test(main), 'main unchanged');

// =============================================================================
// 9) No public context API change + no package change for the observer
// =============================================================================
check('39 no public context API change (no awareness field in AccessContextType / provider value)', !/supabaseAwarenessRef|AccessAwarenessRecord/.test(contextType) && !providerValue.includes('supabaseAwarenessRef'), 'private only');
check('40 the dynamic import target is a RELATIVE path (no new npm dependency)', /import\(\s*'\.\.?\//.test(observerBlock), 'relative import');
check('41 package.json declares no awareness flag / helper dependency', !/supabaseAccessAwareness|VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/.test(pkg), 'no package change');

// =============================================================================
// 10) Self-inertness (non-circular allowlist + read-only fs + no env)
// =============================================================================
const selfSrc = read('scripts/diagnostics-accesscontext-supabase-observer-wiring-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
check('42 diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('43 diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('44 diagnostic uses fs read-only (readFileSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync'), fsBindings.join(','));
check('45 diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[accesscontext-supabase-observer-wiring-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
