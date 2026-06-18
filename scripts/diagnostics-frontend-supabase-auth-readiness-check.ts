// Phase 1.6 M4 — STATIC (offline) frontend Supabase-auth READINESS check.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no
// SQL, no migration, no audit write, no Supabase MCP, no live/route call. It reads
// the frontend (`src/**`) and the M4 migration doc as TEXT only (read-only — NEVER
// imported, NEVER modified) to LOCK the frontend secret-safety boundary for the
// future Supabase-auth migration: no privileged Supabase secret may reach the
// browser, only public `VITE_` names are read client-side, the proven pilot path
// is isolated, and the main app remains un-migrated (Firebase-derived).
//
// Run:  npx tsx scripts/diagnostics-frontend-supabase-auth-readiness-check.ts

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
const allSrc = srcFiles.map((f) => text.get(f)!).join('\n');
const filesWhere = (re: RegExp) => srcFiles.filter((f) => re.test(text.get(f)!));

// =============================================================================
// 1) No privileged Supabase/DB secret reference anywhere in the frontend
// =============================================================================

// Identifier-form tokens (NOT prose like "service-role key" / "DB URL"): a real
// leak would use these exact identifiers. Scanning src/** (never this script).
const forbidden: Array<[string, RegExp]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', /SUPABASE_SERVICE_ROLE_KEY/],
  ['SUPABASE_DATABASE_URL', /SUPABASE_DATABASE_URL/],
  ['service-role key identifier', /SERVICE_ROLE_KEY|serviceRoleKey|service_role/],
  ['DB URL / connection string', /\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//],
];
for (const [label, re] of forbidden) {
  const hits = filesWhere(re);
  check(`1 no ${label} reference in src/**`, hits.length === 0, hits.join(', ') || 'none');
}

// =============================================================================
// 2) Only public VITE_ names are read client-side for Supabase config
// =============================================================================

// Env/property accesses whose NAME contains SUPABASE (requires a leading dot, so
// prose mentions like "Enable ENABLE_SUPABASE_PLATFORM_IDENTITY=true" do NOT match).
const supabaseEnvNames = [...allSrc.matchAll(/\.([A-Za-z_]*SUPABASE[A-Za-z_]*)/g)].map((m) => m[1]);
const nonVite = [...new Set(supabaseEnvNames)].filter((n) => !n.startsWith('VITE_'));
check('2a every SUPABASE env/config access read client-side is VITE_-prefixed', nonVite.length === 0, nonVite.join(',') || `[${[...new Set(supabaseEnvNames)].join(', ')}]`);
check('2b only the public anon key (no privileged key) is read client-side', /VITE_SUPABASE_ANON_KEY/.test(allSrc) && !/VITE_SUPABASE_SERVICE_ROLE/.test(allSrc), 'anon-only');

// =============================================================================
// 3) Proven pilot client + session-resolve path exist, isolated to the pilot
// =============================================================================

check('3a a frontend Supabase client exists under the pilot scope', /createClient\(/.test(text.get('src/pilot/supabaseClient.ts') ?? ''), 'pilot client');
check('3b a token→/auth/session/resolve path exists under the pilot scope', /\/auth\/session\/resolve/.test(text.get('src/pilot/sessionResolvePilotClient.ts') ?? ''), 'pilot session-resolve');
const sessionResolveNonPilot = filesWhere(/\/auth\/session\/resolve|runSessionResolve/).filter((f) => !f.startsWith('src/pilot/'));
check('3c the session-resolve path is NOT wired into the main app', sessionResolveNonPilot.length === 0, sessionResolveNonPilot.join(', ') || 'pilot-scoped only');

// =============================================================================
// 4) Main app remains un-migrated (Firebase-derived; no Supabase in the app tree)
// =============================================================================

const ac = text.get('src/context/AccessContext.tsx') ?? '';
const login = text.get('src/components/Login.tsx') ?? '';
const guard = text.get('src/components/AccessGuard.tsx') ?? '';
const app = text.get('src/App.tsx') ?? '';
check('4a AccessContext unchanged: Firebase onAuthStateChanged, no Supabase SDK import', /onAuthStateChanged/.test(ac) && !/@supabase\/supabase-js/.test(ac), 'firebase-derived');
check('4b Login unchanged: imports firebase/auth, no Supabase SDK import', /from 'firebase\/auth'/.test(login) && !/@supabase\/supabase-js/.test(login), 'firebase login');
check('4c AccessGuard unchanged: no Supabase SDK / no pilot auth client import', !/@supabase\/supabase-js/.test(guard) && !/pilot\/(supabaseClient|sessionResolvePilotClient|identityDiagnosticClient)/.test(guard), 'unchanged');
check('4d App routing unchanged: no Supabase SDK import; pilot only behind PILOT_ROUTE_ENABLED', !/@supabase\/supabase-js/.test(app) && /PILOT_ROUTE_ENABLED/.test(app), 'gated');

// =============================================================================
// 5) Future adoption is flag-gateable + fallback semantics documented
// =============================================================================

check('5a future shadow flag VITE_ENABLE_SERVER_AUTHZ_SHADOW is dormant (absent from src/)', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(allSrc), 'flag-gateable');
const m4doc = read('docs/phase-1.6-milestone-4-supabase-auth-frontend-migration-plan.md');
const fallbackDocumented =
  /fall ?back to the legacy client engine/i.test(m4doc) &&
  /never fail-open/i.test(m4doc) &&
  /blanket deny/i.test(m4doc) &&
  /blank permissions/i.test(m4doc);
check('5b authorization:null fallback semantics documented (legacy fallback, not fail-open/deny/blank)', fallbackDocumented, 'documented');
check('5c VITE_ENABLE_SERVER_AUTHZ_SHADOW documented as the future gate', /VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(m4doc), 'documented');

// =============================================================================
// 6) Inertness via import-allowlist (non-circular) + no env access
// =============================================================================

const selfSrc = read('scripts/diagnostics-frontend-supabase-auth-readiness-check.ts');
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
console.log(`\n[frontend-supabase-auth-readiness-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
