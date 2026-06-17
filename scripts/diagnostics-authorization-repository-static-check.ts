// Phase 1.5 M11.2 — OFFLINE static check for the read-only authorization
// repository + the live diagnostic.
//
// PURE / OFFLINE: never connects to Postgres, runs no SQL, applies no migration or
// seed, makes no network call, and uses no Supabase/Firebase/MCP. It reads the
// M11.2 source files as TEXT and asserts their safety invariants.
//
// IMPORTANT: forbidden mutation words legitimately appear in the repository's
// DOCUMENTATION comments ("No INSERT/UPDATE/DELETE …"). So the mutation scan runs
// against COMMENT-STRIPPED executable code only — it must not trip on prose.
//
// Run:  npx tsx scripts/diagnostics-authorization-repository-static-check.ts

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const REPO = join(ROOT, 'server', 'platform-identity', 'authorizationRepository.ts');
const LIVE = join(ROOT, 'scripts', 'diagnostics-authorization-repository-live-check.ts');
const SESSION_RESOLVE = join(ROOT, 'server', 'platform-identity', 'sessionResolve.ts');

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const repoSrc = read(REPO);
const liveSrc = read(LIVE);
const sessionSrc = read(SESSION_RESOLVE);

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Strip // and block comments so a scan sees only executable code (not the
 *  module's own "no insert/update/delete" documentation). */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const repoCode = stripTsComments(repoSrc);
const liveCode = stripTsComments(liveSrc);

// =============================================================================
// Presence
// =============================================================================

check('C1 authorizationRepository.ts exists', repoSrc.length > 0, REPO);
check('C2 live diagnostic exists', liveSrc.length > 0, LIVE);

// =============================================================================
// Repository — SELECT-only / no mutation (comment-stripped code only)
// =============================================================================

const MUTATION_PATTERNS: [string, RegExp][] = [
  ['insert', /\binsert\b/i],
  ['update', /\bupdate\b/i],
  ['delete', /\bdelete\b/i],
  ['upsert', /\bupsert\b/i],
  ['on conflict', /\bon\s+conflict\b/i],
  ['alter', /\balter\b/i],
  ['drop', /\bdrop\b/i],
  ['truncate', /\btruncate\b/i],
  ['.unsafe', /\.unsafe\b/i],
  ['dynamic concat into sql', /sql\s*\+/i],
];

const repoMutations = MUTATION_PATTERNS.filter(([, re]) => re.test(repoCode)).map(([l]) => l);
check('C3 repository executable code has NO mutating/dynamic SQL', repoMutations.length === 0, repoMutations.join(',') || 'none');

const liveMutations = MUTATION_PATTERNS.filter(([, re]) => re.test(liveCode)).map(([l]) => l);
check('C3b live diagnostic executable code has NO mutating/dynamic SQL', liveMutations.length === 0, liveMutations.join(',') || 'none');

check('C4 repository selects (read-only) the durable tables', /\bselect\b/i.test(repoCode), 'select present');

// =============================================================================
// Repository — imports getDb, isolated from runtime/frontend
// =============================================================================

const repoImports = [...repoCode.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
check('C5 repository imports getDb from ./db', /from '\.\/db'/.test(repoCode) && /\bgetDb\b/.test(repoCode), repoImports.join(', '));
check('C6 repository does NOT import Express', !repoImports.includes('express'), repoImports.join(', '));
check('C7 repository does NOT import sessionResolve', !repoImports.some((i) => /sessionResolve/.test(i)), 'ok');
check('C8 repository does NOT import frontend (src/)', !repoImports.some((i) => /(^|\/)src\//.test(i) || /\.\.\/\.\.\/src/.test(i)), 'ok');
check('C9 repository registers no route', !/\b(app|router)\.(get|post|put|patch|delete|use)\s*\(/.test(repoCode), 'no route registration');

// =============================================================================
// Live diagnostic — required gates + production block
// =============================================================================

const GATES = [
  'ALLOW_LIVE_AUTHZ_REPOSITORY_CHECK',
  'CONFIRM_SUPABASE_TARGET',
  'AUTHZ_CHECK_AUTH_PROVIDER',
  'AUTHZ_CHECK_AUTH_PROVIDER_UID',
];
const missingGates = GATES.filter((g) => !liveSrc.includes(g));
check('C10 live diagnostic enforces all required gates', missingGates.length === 0, missingGates.length ? `MISSING: ${missingGates.join(',')}` : GATES.join(','));
check('C11 live diagnostic blocks production', /NODE_ENV\s*===\s*'production'/.test(liveSrc), 'NODE_ENV production block present');
check('C12 live diagnostic uses a read-only transaction', /set transaction read only/i.test(liveSrc), 'read-only tx present');

// =============================================================================
// Live diagnostic — no secret/UID/email printing
// =============================================================================
// Inspect every console.* line; none may interpolate the UID, email, DB URL,
// project ref, or any key/token identifier.
const PRINT_FORBIDDEN = [
  'authProviderUid', 'AUTH_PROVIDER_UID', '.email', 'databaseUrl', 'DATABASE_URL',
  'SERVICE_ROLE', 'serviceRole', 'ANON_KEY', 'anonKey', 'rawJwt', 'accessToken', 'token',
  'projectRef', 'PROJECT_REF',
];
const consoleLines = liveSrc.split('\n').filter((l) => /console\.(log|error|warn)\s*\(/.test(l));
const leakyLines = consoleLines.filter((l) => PRINT_FORBIDDEN.some((f) => l.includes(f)));
check('C13 live diagnostic prints no UID/email/secret/URL', leakyLines.length === 0, leakyLines.length ? `${leakyLines.length} suspicious console line(s)` : 'none');

// =============================================================================
// Live diagnostic — isolation
// =============================================================================

const liveImports = [...liveCode.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
check('C14 live diagnostic does NOT import Express', !liveImports.includes('express'), liveImports.join(', '));
check('C15 live diagnostic does NOT import sessionResolve', !liveImports.some((i) => /sessionResolve/.test(i)), 'ok');
check('C16 live diagnostic does NOT import frontend (src/)', !liveImports.some((i) => /(^|\/)src\//.test(i)), 'ok');

// =============================================================================
// No MCP, no migration/seed/rollback execution, no schema change
// =============================================================================

const artifacts = `${repoCode}\n${liveCode}`;
check('C17 no Supabase MCP references in M11.2 code', !/\bmcp\b/i.test(artifacts), 'no mcp');
const MIGRATION_EXEC: [string, RegExp][] = [
  ['supabase-migrate', /supabase-migrate/i],
  ['ALLOW_SUPABASE_MIGRATION_APPLY', /ALLOW_SUPABASE_MIGRATION_APPLY/],
  ['.up.sql', /\.up\.sql/i],
  ['.down.sql', /\.down\.sql/i],
  ['--apply', /--apply/],
];
const migrationHits = MIGRATION_EXEC.filter(([, re]) => re.test(artifacts)).map(([l]) => l);
check('C18 no migration/seed/rollback execution in M11.2 code', migrationHits.length === 0, migrationHits.join(',') || 'none');

// =============================================================================
// /auth/session/resolve: flag-disabled path returns authorization: null; the
// repository is NOT wired directly into the route (M11.5 wires only the service).
// =============================================================================

check(
  'C19 flag-disabled /auth/session/resolve path returns authorization: null',
  /authorization:\s*null/.test(sessionSrc) && /isLiveSessionAuthorizationEnabled/.test(sessionSrc),
  'null default + live-flag gate present',
);
check('C20 sessionResolve does NOT import the repository directly', !/authorizationRepository/.test(sessionSrc), 'not wired');

const failed = results.filter((r) => !r.pass);
console.log(`\n[authz-repo-static-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
