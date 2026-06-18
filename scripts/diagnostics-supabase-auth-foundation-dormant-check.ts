// Phase 1.6 M5 — STATIC (offline) DORMANCY check for the app-level Supabase Auth
// foundation (`src/auth/supabaseAuthFoundation.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call. It reads the
// frontend (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and
// PROVES the new foundation is dormant, secret-safe, and not reachable from any active
// app entrypoint, so it cannot change current behavior or reach production.
//
// Run:  npx tsx scripts/diagnostics-supabase-auth-foundation-dormant-check.ts

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- collect every frontend source file (read as TEXT) ----------------------
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

const FOUNDATION = 'src/auth/supabaseAuthFoundation.ts';
const TYPES = 'src/auth/supabaseAuthFoundationTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const foundation = text.get(FOUNDATION) ?? '';
const types = text.get(TYPES) ?? '';
const foundationOwned = `${foundation}\n${types}`;

// Comment-stripped views. The foundation intentionally DOCUMENTS its boundaries in
// comments (it names `/auth/session/resolve`, the pilot flag, and the shadow flag to
// state it does NOT use them). "Must-not-appear-in-CODE" checks scan these stripped
// views so documentation is never mistaken for behavior. (Secret-identifier checks in
// section 3 deliberately scan the FULL text — stricter — and the foundation's prose
// uses non-identifier forms, e.g. "service-role key", that cannot match.)
// Order matters: strip LINE comments FIRST (the header prose names `src/pilot/**`,
// whose `/**` would otherwise be misread as a block-comment opener), THEN strip
// block/JSDoc comments. The `[^:]` guard keeps `https://`-style code literals intact.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const foundationCode = stripComments(foundation);

// =============================================================================
// 1) The dormant foundation + its types file exist
// =============================================================================

check('1a foundation module exists', text.has(FOUNDATION), text.has(FOUNDATION) ? FOUNDATION : 'absent');
check('1b foundation types module exists', text.has(TYPES), text.has(TYPES) ? TYPES : 'absent');

// =============================================================================
// 2) Public VITE_-only env boundary (anon key only; no privileged key)
// =============================================================================

check('2a foundation reads VITE_SUPABASE_URL', /VITE_SUPABASE_URL/.test(foundationCode), 'public url');
check('2b foundation reads VITE_SUPABASE_ANON_KEY', /VITE_SUPABASE_ANON_KEY/.test(foundationCode), 'public anon key');
check('2c foundation reads its DEV-only flag VITE_ENABLE_SUPABASE_AUTH_FOUNDATION', /VITE_ENABLE_SUPABASE_AUTH_FOUNDATION/.test(foundationCode), 'dev flag');

// Every SUPABASE-named property access in the foundation CODE must be VITE_-prefixed
// (requires a leading dot so prose/identifiers without access do not match).
const supabaseAccesses = [...foundationCode.matchAll(/\.([A-Za-z_]*SUPABASE[A-Za-z_]*)/g)].map((m) => m[1]);
const nonViteAccess = [...new Set(supabaseAccesses)].filter((n) => !n.startsWith('VITE_'));
check('2d every SUPABASE env/config access is VITE_-prefixed (no server-only name read)', nonViteAccess.length === 0, nonViteAccess.join(', ') || 'vite-only');
check('2e only the public anon key is read (no VITE_SUPABASE_SERVICE_ROLE)', !/VITE_SUPABASE_SERVICE_ROLE/.test(foundationOwned), 'anon-only');

// =============================================================================
// 3) No privileged Supabase / DB secret reference (identifier forms)
// =============================================================================

const forbidden: Array<[string, RegExp]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', /SUPABASE_SERVICE_ROLE_KEY/],
  ['SUPABASE_DATABASE_URL', /SUPABASE_DATABASE_URL/],
  ['service-role key identifier', /SERVICE_ROLE_KEY|serviceRoleKey|service_role/],
  ['DB URL / connection string', /\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//],
  ['server-only (non-VITE_) Supabase env name', /(?<!VITE_)SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|DATABASE_URL|JWT_SECRET)/],
];
for (const [label, re] of forbidden) {
  check(`3 no ${label} reference in the foundation`, !re.test(foundationOwned), re.test(foundationOwned) ? 'FOUND' : 'none');
}

// =============================================================================
// 4) Import allowlist — no Firebase / app-entrypoint / server / pilot import
// =============================================================================

// Parse the ACTUAL import specifiers (robust against comment prose).
const foundationImports = [...foundationCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...foundationCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...foundationImports, ...dynamicImports];
const ALLOWED_IMPORTS = ['@supabase/supabase-js', './supabaseAuthFoundationTypes'];
const disallowedImports = allImports.filter((i) => !ALLOWED_IMPORTS.includes(i));
check('4a foundation imports confined to the SDK + its own types', allImports.length > 0 && disallowedImports.length === 0, disallowedImports.join(', ') || allImports.join(' + '));
check('4b foundation imports no Firebase module', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('4c foundation imports no AccessContext / Login / AccessGuard / App / main entrypoint', !allImports.some((i) => /AccessContext|components\/Login|AccessGuard|App$|\/App'?$|\/main$/.test(i)), 'no app-entrypoint import');
check('4d foundation imports no server module', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server import');
check('4e foundation imports no pilot module', !allImports.some((i) => /pilot\//.test(i)), 'no pilot import');

// =============================================================================
// 5) No forbidden calls (session-resolve, protected/business/control APIs, network)
// =============================================================================

check('5a foundation CODE does not call /auth/session/resolve', !/\/auth\/session\/resolve|runSessionResolve/.test(foundationCode), 'no session-resolve');
check('5b foundation makes no direct network call (no fetch/XMLHttpRequest)', !/\bfetch\s*\(|XMLHttpRequest/.test(foundationCode), 'no direct network');

// =============================================================================
// 6) No import-time side effects — lazy factory only
// =============================================================================

// A module-scope binding initialized to a built client = import-time side effect.
const topLevelClientBuild = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*createClient\(/m.test(foundationCode);
check('6a no Supabase client constructed at import time (no top-level createClient binding)', !topLevelClientBuild, topLevelClientBuild ? 'FOUND top-level createClient' : 'lazy');
check('6b createClient IS present (foundation can build a client on demand)', /createClient\(/.test(foundationCode), 'on-demand');
check('6c a lazy factory function wraps client construction', /function getSupabaseAuthFoundation\s*\(/.test(foundationCode), 'getSupabaseAuthFoundation()');
check('6d memoized client binding initializes to null (no eager build)', /let\s+\w+\s*:\s*[^=]*=\s*null/.test(foundationCode), 'memoized=null');
check('6e no top-level await and no import-time logging', !/\bawait\b/.test(foundationCode) && !/console\./.test(foundationCode), 'inert import');

// =============================================================================
// 7) DEV-gated, default OFF, and flag SEPARATION from pilot/shadow flags
// =============================================================================

check('7a foundation is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(foundationCode), 'DEV gate');
check('7b enablement is AND of DEV and explicit flag === "true" (default OFF)', /DEV === true/.test(foundationCode) && /=== 'true'/.test(foundationCode), 'dev && flag');
check('7c flag is SEPARATE from VITE_ENABLE_SUPABASE_PILOT (not referenced in code)', !/VITE_ENABLE_SUPABASE_PILOT/.test(foundationCode), 'separate from pilot');
check('7d flag is SEPARATE from VITE_ENABLE_SERVER_AUTHZ_SHADOW (not referenced in code)', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(foundationCode), 'separate from shadow');

// =============================================================================
// 8) Dormancy — the foundation is imported by NOTHING in src/** (no call site)
// =============================================================================

// Match static `from '…/supabaseAuthFoundation'`, bare `import '…'`, and dynamic
// `import('…')` — but NOT the sibling `…FoundationTypes` module.
const refsFoundationModule = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseAuthFoundation'/.test(s);
const importers = srcFiles.filter((f) => f !== FOUNDATION && f !== TYPES && refsFoundationModule(text.get(f)!));
check('8a foundation is imported by NO active app entrypoint', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('8b foundation is imported nowhere in src/** yet (no M5 call site added)', importers.length === 0, importers.join(', ') || 'no importers');

// =============================================================================
// 9) No barrel export (avoids accidental entrypoint pull-in)
// =============================================================================

check('9a no src/auth/index.ts barrel exists', !existsSync(join(ROOT, 'src/auth/index.ts')), 'no barrel');

// =============================================================================
// 10) Firebase remains the active authority; foundation did not leak into it
// =============================================================================

const ac = text.get('src/context/AccessContext.tsx') ?? '';
const login = text.get('src/components/Login.tsx') ?? '';
check('10a AccessContext still Firebase-derived (onAuthStateChanged) and free of the foundation', /onAuthStateChanged/.test(ac) && !refsFoundationModule(ac), 'firebase authority intact');
check('10b Login still uses firebase/auth and is free of the foundation', /from 'firebase\/auth'/.test(login) && !refsFoundationModule(login), 'firebase login intact');

// =============================================================================
// 11) Self-inertness (non-circular allowlist + read-only fs + no env)
// =============================================================================

const selfSrc = read('scripts/diagnostics-supabase-auth-foundation-dormant-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
check('11a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('11b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('11c diagnostic uses fs read-only (readFileSync/readdirSync/existsSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync' || b === 'existsSync'), fsBindings.join(','));
check('11d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[supabase-auth-foundation-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
