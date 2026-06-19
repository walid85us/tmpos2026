// Phase 1.6 M9 — STATIC (offline) AccessContext Supabase observer PRIVATE-SURFACE LOCK.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call. It reads the
// frontend (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and
// PERMANENTLY LOCKS the M8 boundary: the private `supabaseAwarenessRef` observer record
// stays private, write-only, and NON-AUTHORITATIVE, and is NEVER surfaced through the
// context value, a `useAccess` getter, UI, a `window` hook, a DOM event, a console log,
// storage, or the network — so it cannot become an app/support/debug API or an authority
// input. M9 adds NO runtime surfacing; this diagnostic proves none exists.
//
// Run:  npx tsx scripts/diagnostics-accesscontext-supabase-observer-private-surface-check.ts

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
const srcFiles = walk('src');
const text = new Map<string, string>(srcFiles.map((f) => [f, read(f)]));

// Comment-stripped CODE view (line comments FIRST so prose like `src/pilot/**` cannot be
// misread as a block-comment opener). "Must-not-appear-in-CODE" checks use this so
// documentation/prose (e.g. "No token/session payload is logged") is never mistaken for
// behavior. Identifier/secret scans use FULL text (stricter).
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

const ACCESS_CONTEXT = 'src/context/AccessContext.tsx';
const HELPER = 'src/auth/supabaseAccessAwareness.ts';
const HELPER_TYPES = 'src/auth/supabaseAccessAwarenessTypes.ts';

const ac = text.get(ACCESS_CONTEXT) ?? '';
const acCode = stripComments(ac);

// ---- robust block slices of AccessContext -----------------------------------
const FB_DEPS = '}, [platformRolesState]);';
const OBS_DEPS = '}, [loading]);';
const fbDepsIdx = ac.indexOf(FB_DEPS);
const obsStart = ac.indexOf('useEffect(() => {', fbDepsIdx >= 0 ? fbDepsIdx + FB_DEPS.length : 0);
const obsDepsIdx = ac.indexOf(OBS_DEPS, obsStart >= 0 ? obsStart : 0);
const observerBlock = (obsStart >= 0 && obsDepsIdx >= 0) ? ac.slice(obsStart, obsDepsIdx + OBS_DEPS.length) : '';
const observerCode = stripComments(observerBlock);
const afterObserver = obsDepsIdx >= 0 ? ac.slice(obsDepsIdx + OBS_DEPS.length) : ac;

const valStart = ac.indexOf('value={{');
const valEnd = ac.indexOf('}}>', valStart);
const providerValue = (valStart >= 0 && valEnd >= 0) ? ac.slice(valStart, valEnd) : '';

const typeStart = ac.indexOf('interface AccessContextType {');
const typeEnd = ac.indexOf('\n}', typeStart);
const contextType = (typeStart >= 0 && typeEnd >= 0) ? ac.slice(typeStart, typeEnd) : '';

// helper-module import detectors (match the helper module path, NEVER `…AwarenessTypes`)
const refsHelper = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseAccessAwareness'/.test(s);
const dynamicHelperImport = (s: string) => /import\(\s*'[^']*\/supabaseAccessAwareness'\s*\)/.test(s);
const staticHelperImport = (s: string) => /import\s+[^()]*?from\s*'[^']*\/supabaseAccessAwareness'/.test(s);

// =============================================================================
// 1) Observer ref exists, is a private useRef, write-only
// =============================================================================
check('1 AccessContext.tsx exists', text.has(ACCESS_CONTEXT), ACCESS_CONTEXT);
check('2 supabaseAwarenessRef exists in AccessContext', /supabaseAwarenessRef\b/.test(ac), 'ref present');
check('3 supabaseAwarenessRef is created with useRef', /const\s+supabaseAwarenessRef\s*=\s*useRef</.test(ac), 'useRef');
check('4 supabaseAwarenessRef is private to AccessContext (not exported)', !/export[\s\S]{0,40}supabaseAwarenessRef/.test(ac), 'not exported');
{
  // Every `supabaseAwarenessRef.current` NOT immediately assigned (`= …`) is a READ. Must be zero.
  const reads = (ac.match(/supabaseAwarenessRef\.current(?!\s*=)/g) ?? []).length;
  check('5 supabaseAwarenessRef.current is WRITE-ONLY (zero reads)', reads === 0, reads === 0 ? 'write-only' : `${reads} read(s)`);
}

// =============================================================================
// 2) Ref value not read by ANY session/tenant/role/plan/permission/route/loading path
//    (all of these are defined AFTER the observer effect; the ref must not appear there)
// =============================================================================
check('6-19 supabaseAwarenessRef is absent from everything after the observer effect (session/tenant/effectiveRole/plan/permissions/subPermissions/hasPermission/checkSubPermission/canAccess/getPermissionLevel/isStoreActivated/resolveLandingRoute/loading/routing/authError)', !afterObserver.includes('supabaseAwarenessRef'), 'absent from all derivations + permission fns + value');

// =============================================================================
// 3) Not exposed via provider value / context type / getter / useAccess
// =============================================================================
check('20 supabaseAwarenessRef is NOT in the provider value object', providerValue.length > 0 && !providerValue.includes('supabaseAwarenessRef'), 'not in value');
check('21 AccessAwarenessRecord is NOT in the provider value object', providerValue.length > 0 && !providerValue.includes('AccessAwarenessRecord'), 'not in value');
check('22 AccessAwarenessRecord is NOT in AccessContextType', contextType.length > 0 && !/AccessAwarenessRecord|supabaseAwarenessRef/.test(contextType), 'not in context type');
check('23 no public getter for the observer record (no `return … supabaseAwarenessRef`)', !/return[\s\S]{0,60}supabaseAwarenessRef/.test(acCode), 'no getter');
{
  // useAccess returns the context value (already proven free of the ref/record by 20-22).
  const ua = ac.slice(ac.indexOf('export const useAccess'));
  check('24 useAccess does not expose observer data', !/(supabaseAwarenessRef|AccessAwarenessRecord)/.test(ua), 'useAccess clean');
}

// =============================================================================
// 4) Confinement — ref only in AccessContext; record type only in approved files
// =============================================================================
const refElsewhere = srcFiles.filter((f) => f !== ACCESS_CONTEXT && /\bsupabaseAwarenessRef\b/.test(text.get(f)!));
check('25/26 no file OUTSIDE AccessContext references supabaseAwarenessRef (no UI/other consumer)', refElsewhere.length === 0, refElsewhere.join(', ') || 'confined to AccessContext');
const recordRefs = srcFiles.filter((f) => /\bAccessAwarenessRecord\b/.test(text.get(f)!));
const recordAllowed = new Set([ACCESS_CONTEXT, HELPER, HELPER_TYPES]);
const recordUnexpected = recordRefs.filter((f) => !recordAllowed.has(f));
check('27 AccessAwarenessRecord referenced only by approved files (helper, types, AccessContext type-only import)', recordUnexpected.length === 0, recordUnexpected.join(', ') || `allowed: [${recordRefs.join(', ')}]`);
check('27b AccessContext references AccessAwarenessRecord via a TYPE-ONLY import', /import\s+type\s*\{[^}]*AccessAwarenessRecord[^}]*\}\s*from\s*'[^']*\/supabaseAccessAwarenessTypes'/.test(ac), 'type-only import');

// =============================================================================
// 5) No window / global hook for the observer record (whole src/**)
// =============================================================================
const windowHookAnywhere = srcFiles.filter((f) => /__TM_POS_SUPABASE_AWARENESS__/.test(text.get(f)!));
check('28 no window.__TM_POS_SUPABASE_AWARENESS__ anywhere in src/**', windowHookAnywhere.length === 0, windowHookAnywhere.join(', ') || 'absent');
const windowAwarenessAssign = srcFiles.filter((f) => /(window|globalThis)\s*\.\s*[A-Za-z0-9_$]*[Aa]wareness[A-Za-z0-9_$]*\s*=/.test(text.get(f)!) || /(window|globalThis)\s*\[\s*['"][^'"]*[Aa]wareness/.test(text.get(f)!));
check('29/30 no window/globalThis awareness hook assignment anywhere in src/**', windowAwarenessAssign.length === 0, windowAwarenessAssign.join(', ') || 'no global hook');

// =============================================================================
// 6) Observer block (the ONLY code touching the record) surfaces NOTHING
//    (no event/console/storage/network/window/globalThis inside it)
// =============================================================================
check('31/32 observer block dispatches NO DOM event (no CustomEvent / dispatchEvent)', !/CustomEvent|dispatchEvent/.test(observerCode), 'no event');
check('33 observer block does NOT log the record (no console.*)', !/console\./.test(observerCode), 'no console');
check('34 observer block does NOT persist to localStorage', !/localStorage/.test(observerCode), 'no localStorage');
check('35 observer block does NOT persist to sessionStorage', !/sessionStorage/.test(observerCode), 'no sessionStorage');
check('36 observer block does NOT persist to IndexedDB', !/indexedDB/.test(observerCode), 'no indexedDB');
check('37 observer block makes NO fetch transmission', !/\bfetch\s*\(/.test(observerCode), 'no fetch');
check('38 observer block makes NO XMLHttpRequest transmission', !/XMLHttpRequest/.test(observerCode), 'no XHR');
check('39 observer block makes NO navigator.sendBeacon transmission', !/sendBeacon/.test(observerCode), 'no sendBeacon');
check('39b observer block touches NO window/globalThis', !/\b(window|globalThis)\b/.test(observerCode), 'no global object');

// Defense-in-depth: the record/ref is never an argument to any surfacing sink anywhere in src.
const recordSinkAnywhere = srcFiles.filter((f) => /(setItem|dispatchEvent|CustomEvent|sendBeacon|fetch|console\.\w+)\s*\([^)]*supabaseAwarenessRef/.test(text.get(f)!));
check('39c supabaseAwarenessRef is never passed to a storage/event/network/console sink', recordSinkAnywhere.length === 0, recordSinkAnywhere.join(', ') || 'no sink usage');

// =============================================================================
// 7) No session-resolve / server-authz / shadow / surface flag introduced
// =============================================================================
check('40 AccessContext makes NO /auth/session/resolve call', !/\/auth\/session\/resolve|runSessionResolve/.test(ac), 'no session-resolve');
check('41 observer reads NO server-derived authorization', !/authorization/i.test(observerCode), 'no authz');
// Phase 1.6 M13 (owner-approved, controlled SINGLE-FILE exception): VITE_ENABLE_SERVER_AUTHZ_SHADOW
// is now wired into EXACTLY the single dormant server-authz shadow COMPARISON helper
// (src/auth/serverAuthzShadowComparison.ts) — NOT AccessContext, the M8 observer, or anything this
// lock protects. Its dormancy + structural-only / result-safety are proven by
// scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts. The flag must NOT appear in
// ANY other src/** file — this check still FAILS for any other reference (incl. AccessContext).
const M13_SHADOW_COMPARISON = 'src/auth/serverAuthzShadowComparison.ts';
const shadowAnywhere = srcFiles.filter((f) => f !== M13_SHADOW_COMPARISON && /VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(text.get(f)!));
check('42 VITE_ENABLE_SERVER_AUTHZ_SHADOW confined to the dormant M13 shadow-comparison helper (absent from AccessContext + every other src/**)', shadowAnywhere.length === 0, shadowAnywhere.join(', ') || 'M13 helper only');
const surfaceFlagAnywhere = srcFiles.filter((f) => /VITE_ENABLE_ACCESSCONTEXT_SUPABASE_DIAGNOSTIC_SURFACE/.test(text.get(f)!));
check('43 reserved VITE_ENABLE_ACCESSCONTEXT_SUPABASE_DIAGNOSTIC_SURFACE absent from src/** (documented only; not wired)', surfaceFlagAnywhere.length === 0, surfaceFlagAnywhere.join(', ') || 'absent');

// =============================================================================
// 8) M7 helper reachable ONLY through the approved AccessContext dynamic import
// =============================================================================
const importers = srcFiles.filter((f) => f !== HELPER && f !== HELPER_TYPES && refsHelper(text.get(f)!));
check('44 M7 helper imported by EXACTLY ONE file — AccessContext', importers.length === 1 && importers[0] === ACCESS_CONTEXT, importers.join(', ') || 'none');
check('45 no static runtime import of the M7 helper exists', importers.every((f) => !staticHelperImport(text.get(f)!)), 'dynamic-only');
check('46/47 AccessContext dynamic import is DEV-gated and awareness-flag-gated', dynamicHelperImport(ac) && /\.DEV\b/.test(acCode) && /VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/.test(acCode), 'dynamic + DEV + flag');
check('48 observer result remains private + non-authoritative (write-only ref; not in value/type/getter)', !afterObserver.includes('supabaseAwarenessRef') && !providerValue.includes('supabaseAwarenessRef'), 'private + non-authoritative');

// =============================================================================
// 9) No token / role / tenant / plan / permission fields surfaced
// =============================================================================
check('49 observer surfaces NO token field (access_token/refresh_token/jwt/provider token)', !/access_token|refresh_token|provider_token/.test(observerCode) && !/\bjwt\b/i.test(observerCode), 'no token field');
check('50 observer does not read role/tenant/plan/permission off the record', !/record\.(role|tenant|plan|permissions|subPermissions)/.test(observerCode), 'no authz field read');

// =============================================================================
// 10) No browser→DB access / no privileged Supabase/DB env name in frontend
// =============================================================================
check('51 AccessContext introduces NO direct Supabase SDK / browser→DB access', !/@supabase\/supabase-js/.test(ac), 'no direct SDK');
const forbidden: Array<[string, RegExp]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', /SUPABASE_SERVICE_ROLE_KEY/],
  ['SUPABASE_DATABASE_URL', /SUPABASE_DATABASE_URL/],
  ['service-role key identifier', /SERVICE_ROLE_KEY|serviceRoleKey|service_role/],
  ['DB URL / connection string', /\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//],
];
for (const [label, re] of forbidden) {
  const hits = srcFiles.filter((f) => re.test(text.get(f)!));
  check(`52 no ${label} reference in src/**`, hits.length === 0, hits.join(', ') || 'none');
}

// =============================================================================
// 11) Self-inertness (non-circular allowlist + read-only fs + no env/net/db/proc/writes)
// =============================================================================
const selfSrc = read('scripts/diagnostics-accesscontext-supabase-observer-private-surface-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
check('53a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('53b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('53c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('53d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
// Build side-effect needles from fragments so this self-scan never matches its OWN tokens
// (the same self-reference hazard the `process\.env` check above avoids via its regex escape).
const banned = ['child' + '_process', 'exec' + 'Sync', 'spawn' + '(', 'fetch' + '(', 'create' + 'Client', 'new ' + 'Pool'];
const selfBanned = banned.filter((t) => selfSrc.includes(t));
check('53e diagnostic spawns no child process / makes no network call / opens no DB (side-effect-free)', selfBanned.length === 0, selfBanned.join(', ') || 'inert');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[accesscontext-supabase-observer-private-surface-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
