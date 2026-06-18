// Phase 1.6 M6 — STATIC (offline) DORMANCY check for the app-level Supabase SESSION
// BOOTSTRAP (`src/auth/supabaseSessionBootstrap.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call. It reads the
// frontend (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and
// PROVES the bootstrap is dormant, secret/token-safe, mutation-free, and not reachable
// from any active app entrypoint — so it cannot change current behavior or reach prod.
//
// Run:  npx tsx scripts/diagnostics-supabase-session-bootstrap-dormant-check.ts

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

const BOOTSTRAP = 'src/auth/supabaseSessionBootstrap.ts';
const BOOTSTRAP_TYPES = 'src/auth/supabaseSessionBootstrapTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const bootstrap = text.get(BOOTSTRAP) ?? '';
const types = text.get(BOOTSTRAP_TYPES) ?? '';
const bootstrapOwned = `${bootstrap}\n${types}`;

// Comment-stripped CODE view (line comments FIRST so prose like `src/pilot/**` cannot
// be misread as a block-comment opener). "Must-not-appear-in-CODE" checks use this so
// documentation is never mistaken for behavior. Secret/token identifier checks scan the
// FULL text (stricter); the prose uses non-identifier forms that cannot match.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const bootstrapCode = stripComments(bootstrap);
const typesCode = stripComments(types);

// =============================================================================
// 1) Bootstrap (+ optional types) exist
// =============================================================================
check('1a bootstrap module exists', text.has(BOOTSTRAP), text.has(BOOTSTRAP) ? BOOTSTRAP : 'absent');
check('1b bootstrap types module exists', text.has(BOOTSTRAP_TYPES), text.has(BOOTSTRAP_TYPES) ? BOOTSTRAP_TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — foundation only; no SDK / Firebase / app / server / pilot
// =============================================================================
const staticImports = [...bootstrapCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...bootstrapCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
const ALLOWED = ['./supabaseAuthFoundation', './supabaseAuthFoundationTypes', './supabaseSessionBootstrapTypes'];
const disallowed = allImports.filter((i) => !ALLOWED.includes(i));
check('2a bootstrap imports the M5 foundation', allImports.includes('./supabaseAuthFoundation'), 'foundation imported');
check('2b bootstrap imports confined to the foundation + safe local types', allImports.length > 0 && disallowed.length === 0, disallowed.join(', ') || allImports.join(' + '));
check('2c bootstrap does NOT import @supabase/supabase-js directly', !allImports.some((i) => i === '@supabase/supabase-js'), 'no direct SDK');
check('2d bootstrap imports no Firebase module', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('2e bootstrap imports no AccessContext / Login / AccessGuard / App / main', !allImports.some((i) => /AccessContext|components\/Login|AccessGuard|App$|\/App'?$|\/main$/.test(i)), 'no app-entrypoint import');
check('2f bootstrap imports no server module', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server import');
check('2g bootstrap imports no pilot module', !allImports.some((i) => /pilot\//.test(i)), 'no pilot import');
check('2h bootstrap imports no React (no state hooks)', !allImports.some((i) => i === 'react' || i === 'react-dom'), 'no react');

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
  check(`3 no ${label} reference in the bootstrap`, !re.test(bootstrapOwned), re.test(bootstrapOwned) ? 'FOUND' : 'none');
}

// =============================================================================
// 4) Token safety — never reads/exposes/logs tokens or session payloads
// =============================================================================
check('4a bootstrap never references access_token', !/access_token/.test(bootstrapOwned), 'no access_token');
check('4b bootstrap never references refresh_token', !/refresh_token/.test(bootstrapOwned), 'no refresh_token');
check('4c snapshot type exposes no token field', !/access_token|refresh_token|\btoken\b/i.test(typesCode), 'token-free snapshot');
check('4d bootstrap does no logging (no console.* of tokens/session)', !/console\./.test(bootstrap), 'no console');

// =============================================================================
// 5) No authorization / session-resolve / server-derived authz
// =============================================================================
check('5a bootstrap CODE does not call the backend session-resolve route', !/\/auth\/session\/resolve|runSessionResolve/.test(bootstrapCode), 'no session-resolve');
check('5b bootstrap CODE references no server-derived authorization', !/authorization/i.test(bootstrapCode), 'no authz');
check('5c bootstrap makes no direct network call (no fetch/XMLHttpRequest)', !/\bfetch\s*\(|XMLHttpRequest/.test(bootstrapCode), 'no direct network');

// =============================================================================
// 6) No state mutation (no React state, no AccessContext, no permission writes)
// =============================================================================
check('6a bootstrap does not use React state APIs', !/\buseState\b|\buseReducer\b|\buseContext\b|\buseEffect\b/.test(bootstrapCode), 'no react state');
check('6b bootstrap does not reference AccessContext', !/AccessContext/.test(bootstrapCode), 'no AccessContext');
check('6c bootstrap does not mutate role/tenant/plan/permission state (no set* setters)', !/\bset[A-Z]\w*\s*\(/.test(bootstrapCode), 'no state setters');
check('6d bootstrap does not reference permissions/subPermissions/role/tenant/plan state', !/subPermissions|\bplatformRoles\b|\btenantRoles\b|setRealSession|setRealTenant/.test(bootstrapCode), 'no authz-state');

// =============================================================================
// 7) DEV-flag-gated, default OFF, flag SEPARATION
// =============================================================================
check('7a bootstrap is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(bootstrapCode), 'DEV gate');
check('7b enablement is AND of DEV and explicit flag === "true" (default OFF)', /DEV === true/.test(bootstrapCode) && /=== 'true'/.test(bootstrapCode), 'dev && flag');
check('7c bootstrap uses VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP', /VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP/.test(bootstrapCode), 'own flag');
check('7d flag SEPARATE from foundation/pilot/shadow flags (not referenced in code)', !/VITE_ENABLE_SUPABASE_AUTH_FOUNDATION|VITE_ENABLE_SUPABASE_PILOT|VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(bootstrapCode), 'separate flag');

// =============================================================================
// 8) No import-time side effects — lazy async reader only
// =============================================================================
const topLevelSideEffect = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:getSupabaseAuthFoundation|[\w.]*getSession)/m.test(bootstrapCode);
check('8a no import-time session/foundation read (no top-level binding to a call)', !topLevelSideEffect, topLevelSideEffect ? 'FOUND top-level call' : 'lazy');
check('8b no top-level await (await only inside the async helper)', !/^await\b/m.test(bootstrapCode), 'no top-level await');
check('8c a lazy async snapshot reader exists', /async function readSupabaseSessionSnapshot\s*\(/.test(bootstrapCode), 'readSupabaseSessionSnapshot()');
check('8d session read goes THROUGH the foundation (getSupabaseAuthFoundation present)', /getSupabaseAuthFoundation\s*\(/.test(bootstrapCode), 'via foundation');

// =============================================================================
// 9) No-throw disabled/no-session states are present
// =============================================================================
for (const s of ['disabled_not_dev', 'disabled_flag_off', 'foundation_unavailable', 'no_session']) {
  check(`9 bootstrap returns the '${s}' state`, bootstrapCode.includes(`'${s}'`), s);
}

// =============================================================================
// 10) Dormancy — bootstrap is imported by NOTHING in src/** (no call site)
// =============================================================================
const refsBootstrap = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseSessionBootstrap'/.test(s);
const importers = srcFiles.filter((f) => f !== BOOTSTRAP && f !== BOOTSTRAP_TYPES && refsBootstrap(text.get(f)!));
check('10a bootstrap is imported by NO active app entrypoint', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('10b bootstrap is imported nowhere in src/** yet (no M6 call site added)', importers.length === 0, importers.join(', ') || 'no importers');

// =============================================================================
// 11) No barrel export
// =============================================================================
check('11a no src/auth/index.ts barrel exists', !existsSync(join(ROOT, 'src/auth/index.ts')), 'no barrel');

// =============================================================================
// 12) Self-inertness (non-circular allowlist + read-only fs + no env)
// =============================================================================
const selfSrc = read('scripts/diagnostics-supabase-session-bootstrap-dormant-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
check('12a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('12b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('12c diagnostic uses fs read-only (readFileSync/readdirSync/existsSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync' || b === 'existsSync'), fsBindings.join(','));
check('12d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[supabase-session-bootstrap-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
