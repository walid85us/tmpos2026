// Phase 1.5 M11.1 — offline static check for the platform-role vocabulary
// alignment migration (003) + the DEV bootstrap seed/rollback templates.
//
// PURE / OFFLINE: never connects to Postgres, runs no SQL, applies no migration or
// seed, makes no network call, and uses no Supabase/Firebase/MCP. It reads the new
// files as text and asserts their content. The ONLY child process it spawns is the
// migration runner in SAFE --list mode with the DB URL stripped from the child env
// (so a connection is impossible), purely to prove 003 is discoverable and the
// seed files are not.
//
// Run:  npx tsx scripts/diagnostics-role-vocabulary-alignment-check.ts

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'server', 'platform-identity', 'migrations');
const SEEDS = join(ROOT, 'server', 'platform-identity', 'seeds');
const RUNNER = join(ROOT, 'scripts', 'supabase-migrate.ts');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const UP = join(MIGRATIONS, '003_platform_role_vocabulary_alignment.up.sql');
const DOWN = join(MIGRATIONS, '003_platform_role_vocabulary_alignment.down.sql');
const SEED = join(SEEDS, 'dev_bootstrap_platform_owner.example.sql');
const ROLLBACK = join(SEEDS, 'dev_bootstrap_rollback.example.sql');
const SELF = join(ROOT, 'scripts', 'diagnostics-role-vocabulary-alignment-check.ts');

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const upSrc = read(UP);
const downSrc = read(DOWN);
const seedSrc = read(SEED);
const rollbackSrc = read(ROLLBACK);
const selfSrc = read(SELF);

const CANONICAL = ['system_owner', 'support_admin', 'billing_admin', 'operations_admin', 'security_admin'];
const TENANT = ['store_owner', 'manager', 'technician', 'sales_staff'];
const LEGACY = ['platform_owner', 'platform_admin', 'platform_ops', 'platform_support', 'platform_readonly'];

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Extract the inner text of the replacement role/scope CHECK in the up migration. */
function newCheckRegion(sql: string): string {
  const m = /add constraint user_membership_role_scope_chk check \(([\s\S]*?)\);/i.exec(sql);
  return m ? m[1] : '';
}

/** All `update public.user_membership … ;` statements in a file. */
function updateStatements(sql: string): string[] {
  return sql.match(/update\s+public\.user_membership[\s\S]*?;/gi) ?? [];
}

const upCheck = newCheckRegion(upSrc);
const upUpdates = updateStatements(upSrc);
const downUpdates = updateStatements(downSrc);

// Secret-material patterns (real-looking secrets, NOT the prose words in warnings).
const SECRET_PATTERNS: [string, RegExp][] = [
  ['JWT (eyJ…)', /eyJ[A-Za-z0-9_-]{6,}/],
  ['postgres URL', /postgres(ql)?:\/\//i],
  ['supabase host', /[a-z0-9-]+\.supabase\.(co|com|net)/i],
];

// =============================================================================
// File presence + location
// =============================================================================

check('C1 003 up exists', upSrc.length > 0, UP);
check('C2 003 down exists', downSrc.length > 0, DOWN);
check('C3 seed exists OUTSIDE migrations folder', seedSrc.length > 0 && SEED.includes(`${join('platform-identity', 'seeds')}`) && !SEED.includes(`${join('platform-identity', 'migrations')}`), SEED);
check('C4 rollback exists OUTSIDE migrations folder', rollbackSrc.length > 0 && ROLLBACK.includes(`${join('platform-identity', 'seeds')}`) && !ROLLBACK.includes(`${join('platform-identity', 'migrations')}`), ROLLBACK);

// =============================================================================
// 003 up — replacement CHECK content
// =============================================================================

check('C5 up CHECK lists all 5 canonical platform roles', CANONICAL.every((r) => upCheck.includes(`'${r}'`)), CANONICAL.join(','));
check('C6 up CHECK lists all 4 tenant/store roles', TENANT.every((r) => upCheck.includes(`'${r}'`)), TENANT.join(','));
check('C7 up CHECK does NOT allow any legacy platform role', upCheck.length > 0 && LEGACY.every((r) => !upCheck.includes(`'${r}'`)), LEGACY.join(','));

// =============================================================================
// 003 up — forward mappings (exactly the 3 unambiguous, none ambiguous)
// =============================================================================

const FORWARD: [string, string][] = [
  ['platform_owner', 'system_owner'],
  ['platform_support', 'support_admin'],
  ['platform_ops', 'operations_admin'],
];
check('C8a up has exactly 3 UPDATE statements', upUpdates.length === 3, `count=${upUpdates.length}`);
check('C8b up contains the 3 allowed forward mappings',
  FORWARD.every(([from, to]) => new RegExp(`set role_id = '${to}'[^;]*role_id = '${from}'`, 'i').test(upSrc)),
  FORWARD.map(([f, t]) => `${f}->${t}`).join(', '));
check('C9 up does NOT map platform_admin', upUpdates.every((s) => !/platform_admin/i.test(s)));
check('C10 up does NOT map platform_readonly', upUpdates.every((s) => !/platform_readonly/i.test(s)));

// =============================================================================
// 003 down — reverse mappings (3) and no silent billing/security map
// =============================================================================

const REVERSE: [string, string][] = [
  ['system_owner', 'platform_owner'],
  ['support_admin', 'platform_support'],
  ['operations_admin', 'platform_ops'],
];
check('C11 down contains the 3 reverse mappings',
  REVERSE.every(([from, to]) => new RegExp(`set role_id = '${to}'[^;]*role_id = '${from}'`, 'i').test(downSrc)),
  REVERSE.map(([f, t]) => `${f}->${t}`).join(', '));
check('C12 down does NOT silently map billing_admin or security_admin',
  downUpdates.every((s) => !/billing_admin/i.test(s) && !/security_admin/i.test(s)));

// =============================================================================
// Seed — canonical role usage
// =============================================================================

check('C13 seed uses canonical platform role system_owner', /'system_owner'/.test(seedSrc));
check('C14 seed uses NO legacy platform role', LEGACY.every((r) => !seedSrc.includes(r)), LEGACY.join(','));

// =============================================================================
// Seed/rollback — secret safety + audit safety + idempotency + precondition
// =============================================================================

const seedAndRollback = `${seedSrc}\n${rollbackSrc}`;
const secretHits = SECRET_PATTERNS.filter(([, re]) => re.test(seedAndRollback)).map(([label]) => label);
check('C15 seed/rollback contain no real secret material', secretHits.length === 0, secretHits.join(',') || 'none');

const auditInsert = /insert\s+into\s+(public\.)?audit_event/i;
const auditDelete = /delete\s+from\s+(public\.)?audit_event/i;
check('C16 seed/rollback do NOT insert or delete audit_event',
  !auditInsert.test(seedAndRollback) && !auditDelete.test(seedAndRollback));

check('C17 seed uses deterministic DEV UUID literals', /11111111-1111-4111-8111-111111111111/.test(seedSrc) && /22222222-2222-4222-8222-222222222222/.test(seedSrc));
check('C18 seed uses idempotent ON CONFLICT handling', /on conflict/i.test(seedSrc));
check('C19 seed states it REQUIRES 003 APPLIED FIRST', /requires 003 applied first/i.test(seedSrc));

// =============================================================================
// No MCP / no VITE server-secret / no DB connection code in the new SQL + checker
// =============================================================================

// Scope the MCP / VITE_ checks to the SQL artifacts only — this checker's own
// source legitimately contains the strings "MCP" and "VITE_" inside these very
// checks, so including selfSrc would self-trip.
const artifacts = `${upSrc}\n${downSrc}\n${seedSrc}\n${rollbackSrc}`;
check('C21 no Supabase MCP references in new SQL artifacts', !/\bmcp\b/i.test(artifacts));
check('C22 no VITE_ server-secret references in new SQL artifacts', !/VITE_/.test(artifacts));
// Build the search tokens by concatenation so this line does not itself contain
// the literal strings it searches for (otherwise C23 self-trips).
const pgImportTok = "from '" + "postgres'";
const getDbTok = 'get' + 'Db';
check('C23 checker has no DB connection code',
  !selfSrc.includes(pgImportTok) && !new RegExp(`\\b${getDbTok}\\b`).test(selfSrc));

// =============================================================================
// Runner discovery (SAFE --list, DB-free) — 003 discovered, seeds not
// =============================================================================

const childEnv: NodeJS.ProcessEnv = { ...process.env };
delete childEnv.SUPABASE_DATABASE_URL;
delete childEnv.ALLOW_SUPABASE_MIGRATION_APPLY;
delete childEnv.CONFIRM_SUPABASE_TARGET;
delete childEnv.EXPECTED_DEV_PROJECT_REF;

function runList(): { status: number | null; out: string } {
  const res = existsSync(TSX_CLI)
    ? spawnSync(process.execPath, [TSX_CLI, RUNNER, '--list'], { cwd: ROOT, env: childEnv, encoding: 'utf8' })
    : spawnSync('npx', ['tsx', RUNNER, '--list'], { cwd: ROOT, env: childEnv, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

{
  const r = runList();
  check('C20a runner --list discovers 003 (DB-free)', r.status === 0 && /id=003/.test(r.out), `status=${r.status}`);
  check('C20b runner --list does NOT discover seed files', !/dev_bootstrap/.test(r.out));
  check('C20c runner --list leaks no DB URL / SQL body', !/postgres(ql)?:\/\//i.test(r.out) && !/create\s+table/i.test(r.out));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[role-vocab-alignment-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
