// Phase 1.6 M7 — STATIC (offline) OBSERVATIONAL check for the AccessContext Supabase
// AWARENESS helper (`src/auth/supabaseAccessAwareness.ts`).
//
// Phase 1.6 M8 (owner-approved, controlled update): the helper is now wired into EXACTLY
// ONE importer — `src/context/AccessContext.tsx` — via a DYNAMIC, DEV+awareness-flag-gated
// import only. Section 10 therefore allows that single dynamic importer (and asserts there is
// NO static helper import and NO other importer); section 12a allows the dynamic helper import
// while still forbidding the Supabase SDK / M5 foundation / M6 bootstrap inside AccessContext.
// ALL helper-internal checks (token/secret/mutation/session-resolve/server-authz/one-shot/
// cancellation/flag-separation) stay strict and UNCHANGED — the helper file is not modified.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call. It reads the
// frontend (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and
// PROVES the awareness helper stays observational, token/secret-safe, mutation-free,
// one-shot, cancellation-safe, and reachable ONLY through the single approved dynamic
// AccessContext importer — and that AccessContext stays Firebase-authoritative.
//
// Run:  npx tsx scripts/diagnostics-accesscontext-supabase-awareness-observational-check.ts

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

const HELPER = 'src/auth/supabaseAccessAwareness.ts';
const HELPER_TYPES = 'src/auth/supabaseAccessAwarenessTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const helper = text.get(HELPER) ?? '';
const types = text.get(HELPER_TYPES) ?? '';
const helperOwned = `${helper}\n${types}`;

// Comment-stripped CODE views (line comments FIRST so prose like `src/pilot/**` cannot be
// misread as a block-comment opener). "Must-not-appear-in-CODE" checks use these so
// documentation is never mistaken for behavior; identifier/secret checks scan FULL text.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const helperCode = stripComments(helper);
const typesCode = stripComments(types);
const ownedCode = `${helperCode}\n${typesCode}`;

// =============================================================================
// 1) Helper (+ types) exist
// =============================================================================
check('1a awareness helper module exists', text.has(HELPER), text.has(HELPER) ? HELPER : 'absent');
check('1b awareness types module exists', text.has(HELPER_TYPES), text.has(HELPER_TYPES) ? HELPER_TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — bootstrap only; no SDK/React/Firebase/app/server/pilot/foundation
// =============================================================================
const staticImports = [...helperCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...helperCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
const ALLOWED = ['./supabaseSessionBootstrap', './supabaseSessionBootstrapTypes', './supabaseAccessAwarenessTypes'];
const disallowed = allImports.filter((i) => !ALLOWED.includes(i));
check('2a helper imports the M6 bootstrap', allImports.includes('./supabaseSessionBootstrap'), 'bootstrap imported');
check('2b helper imports confined to the bootstrap + safe local types', allImports.length > 0 && disallowed.length === 0, disallowed.join(', ') || allImports.join(' + '));
check('2c helper does NOT import @supabase/supabase-js directly', !allImports.some((i) => i === '@supabase/supabase-js'), 'no direct SDK');
check('2d helper does NOT import React', !allImports.some((i) => i === 'react' || i === 'react-dom'), 'no react');
check('2e helper does NOT import Firebase', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('2f helper does NOT import AccessContext / Login / AccessGuard / App / main', !allImports.some((i) => /AccessContext|components\/Login|AccessGuard|App$|\/App'?$|\/main$/.test(i)), 'no app-entrypoint import');
check('2g helper does NOT import server modules', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server import');
check('2h helper does NOT import pilot modules', !allImports.some((i) => /pilot\//.test(i)), 'no pilot import');
check('2i helper does NOT import the M5 foundation directly', !allImports.some((i) => /\/?supabaseAuthFoundation$/.test(i)), 'no direct foundation');

// =============================================================================
// 3) No privileged Supabase / DB secret reference (identifier forms; full text)
// =============================================================================
const forbidden: Array<[string, RegExp]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', /SUPABASE_SERVICE_ROLE_KEY/],
  ['SUPABASE_DATABASE_URL', /SUPABASE_DATABASE_URL/],
  ['service-role key identifier', /SERVICE_ROLE_KEY|serviceRoleKey|service_role/],
  ['DB URL / connection string', /\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//],
];
for (const [label, re] of forbidden) {
  check(`3 no ${label} reference in the helper`, !re.test(helperOwned), re.test(helperOwned) ? 'FOUND' : 'none');
}

// =============================================================================
// 4) Token safety + non-authorization record shape
// =============================================================================
check('4a helper never references access_token', !/access_token/.test(helperOwned), 'no access_token');
check('4b helper never references refresh_token', !/refresh_token/.test(helperOwned), 'no refresh_token');
check('4c awareness type exposes no token field', !/access_token|refresh_token|\btoken\b/i.test(typesCode), 'token-free record');
check('4d helper does no logging (no console.*)', !/console\./.test(helper), 'no console');
check('4e awareness record exposes no role/tenant/plan/permissions/subPermissions', !/\brole\b|\btenant\b|\bplan\b|permissions|subPermissions/.test(ownedCode), 'authz-free record');

// =============================================================================
// 5) No authorization / session-resolve / server-derived authz / shadow flag
// =============================================================================
check('5a helper CODE does not call the backend session-resolve route', !/\/auth\/session\/resolve|runSessionResolve/.test(helperCode), 'no session-resolve');
check('5b helper CODE references no server-derived authorization', !/authorization/i.test(helperCode), 'no authz');
check('5c helper does not reference VITE_ENABLE_SERVER_AUTHZ_SHADOW', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(helperOwned), 'no shadow flag');
check('5d helper makes no direct network call (no fetch/XMLHttpRequest)', !/\bfetch\s*\(|XMLHttpRequest/.test(helperCode), 'no direct network');

// =============================================================================
// 6) No state mutation (no React state, no AccessContext, no setters)
// =============================================================================
check('6a helper does not use React state APIs', !/\buseState\b|\buseReducer\b|\buseContext\b|\buseEffect\b/.test(helperCode), 'no react state');
check('6b helper does not consume AccessContext (no useAccess / AccessContext import)', !/useAccess\s*\(|from '[^']*\/AccessContext'/.test(helperCode), 'no AccessContext consumption');
check('6c helper does not mutate state (no set* setters)', !/\bset[A-Z]\w*\s*\(/.test(helperCode), 'no state setters');
check('6d helper does not touch loading/routing (no setLoading/navigate)', !/setLoading|navigate\s*\(|useNavigate/.test(helperCode), 'no loading/routing');

// =============================================================================
// 7) DEV-flag-gated, default OFF, requires bootstrap enablement, flag separation
// =============================================================================
check('7a helper is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(helperCode), 'DEV gate');
check('7b enablement is AND of DEV and explicit flag === "true" (default OFF)', /DEV === true/.test(helperCode) && /=== 'true'/.test(helperCode), 'dev && flag');
check('7c helper uses VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS', /VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/.test(helperCode), 'own flag');
check('7d helper requires the M6 bootstrap enablement', /isSupabaseSessionBootstrapEnabled\s*\(/.test(helperCode), 'requires bootstrap');
check('7e flag SEPARATE from foundation/bootstrap/pilot/shadow flags (not referenced in code)', !/VITE_ENABLE_SUPABASE_AUTH_FOUNDATION|VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP|VITE_ENABLE_SUPABASE_PILOT/.test(helperCode), 'separate flag');

// =============================================================================
// 8) One-shot + cancellation-safe + no import-time side effects
// =============================================================================
check('8a one-shot: no subscription/poll (no setInterval/addEventListener/.subscribe/onAuthStateChange)', !/setInterval|setTimeout|addEventListener|\.subscribe\s*\(|onAuthStateChange/.test(helperCode), 'one-shot');
check('8b reads the bootstrap snapshot at most once (readSupabaseSessionSnapshot present)', /readSupabaseSessionSnapshot\s*\(/.test(helperCode), 'single read');
check('8c cancellation-safe (honors AbortSignal/aborted)', /signal/.test(helperCode) && /aborted/.test(helperCode), 'cancellation-safe');
const topLevelSideEffect = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:run[A-Z]\w*|readSupabaseSessionSnapshot)/m.test(helperCode);
check('8d no import-time side effects (no top-level binding to a call)', !topLevelSideEffect, topLevelSideEffect ? 'FOUND top-level call' : 'lazy');
check('8e no top-level await (await only inside the async runner)', !/^await\b/m.test(helperCode), 'no top-level await');
check('8f a one-shot async runner exists', /async function runAccessContextSupabaseAwarenessObservation\s*\(/.test(helperCode), 'runner present');

// =============================================================================
// 9) No-throw disabled/no-session/cancelled/error states present
// =============================================================================
for (const s of ['disabled', 'no_session', 'cancelled', 'error']) {
  check(`9 helper returns the '${s}' state`, helperCode.includes(`'${s}'`), s);
}

// =============================================================================
// 10) Phase 1.6 M8 (controlled): the helper is wired into EXACTLY ONE importer —
//     AccessContext — via a DYNAMIC, DEV+flag-gated import only. No static import, no
//     other importer, and the other active entrypoints (Login/AccessGuard/App/main) stay
//     clean. (`refsHelper` matches only the helper module path, never `…AwarenessTypes`.)
// =============================================================================
const ACCESS_CONTEXT = 'src/context/AccessContext.tsx';
const refsHelper = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseAccessAwareness'/.test(s);
const staticHelperImport = (s: string) => /import\s+[^()]*?from\s*'[^']*\/supabaseAccessAwareness'/.test(s);
const dynamicHelperImport = (s: string) => /import\(\s*'[^']*\/supabaseAccessAwareness'\s*\)/.test(s);
const importers = srcFiles.filter((f) => f !== HELPER && f !== HELPER_TYPES && refsHelper(text.get(f)!));
const OTHER_ENTRYPOINTS = ENTRYPOINTS.filter((f) => f !== ACCESS_CONTEXT);
const acText = text.get(ACCESS_CONTEXT) ?? '';
const otherEntryImporters = OTHER_ENTRYPOINTS.filter((f) => refsHelper(text.get(f) ?? ''));
check('10a helper is imported by NO active app entrypoint EXCEPT AccessContext (Login/AccessGuard/App/main stay clean)', otherEntryImporters.length === 0, otherEntryImporters.join(', ') || 'others clean');
check('10b helper is imported by EXACTLY ONE file in src/** — AccessContext (no other call site)', importers.length === 1 && importers[0] === ACCESS_CONTEXT, importers.join(', ') || 'none');
check('10c AccessContext imports the helper DYNAMICALLY only (no static runtime import)', dynamicHelperImport(acText) && !staticHelperImport(acText), dynamicHelperImport(acText) ? 'dynamic import()' : 'NOT dynamic');
check('10d AccessContext still does NOT statically import the M6 bootstrap / M5 foundation', !/supabaseSessionBootstrap|supabaseAuthFoundation/.test(acText), 'no bootstrap/foundation import');
check('10e AccessContext dynamic import is DEV-gated and awareness-flag-gated', /\.DEV\b/.test(acText) && /VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/.test(acText), 'DEV + flag gate');

// =============================================================================
// 11) No barrel export
// =============================================================================
check('11a no src/auth/index.ts barrel exists', !srcFiles.includes('src/auth/index.ts'), 'no barrel');

// =============================================================================
// 12) AccessContext stays Firebase-authoritative + M6/M8 authority diagnostic intact
// =============================================================================
const ac = text.get('src/context/AccessContext.tsx') ?? '';
check('12a AccessContext still Firebase-derived (onAuthStateChanged), with NO Supabase SDK / M5 foundation / M6 bootstrap (awareness helper is dynamic-only)', /onAuthStateChanged/.test(ac) && !/@supabase\/supabase-js/.test(ac) && !/supabaseAuthFoundation|supabaseSessionBootstrap/.test(ac), 'firebase authority intact; awareness dynamic-only');
const authorityDiag = read('scripts/diagnostics-accesscontext-firebase-authority-check.ts');
check('12b AccessContext authority diagnostic still asserts AccessContext does NOT import the M6 bootstrap', /AccessContext does NOT import the M6 bootstrap/.test(authorityDiag), 'authority check intact');

// =============================================================================
// 13) Self-inertness (non-circular allowlist + read-only fs + no env)
// =============================================================================
const selfSrc = read('scripts/diagnostics-accesscontext-supabase-awareness-observational-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
check('13a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('13b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('13c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('13d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[accesscontext-supabase-awareness-observational-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
