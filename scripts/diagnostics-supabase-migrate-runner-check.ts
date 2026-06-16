// Phase 1.5 M10.2 — dev-only check for the parameterized migration runner.
//
// PURE / OFFLINE for the database: it NEVER connects to Postgres, runs no SQL,
// applies no migration, and uses no Supabase/Firebase/MCP. It validates the
// runner two ways:
//   (1) STATIC — reads scripts/supabase-migrate.ts as text and asserts the modes,
//       DEV guards, path-safety, and secret-safe logging are present.
//   (2) BEHAVIOURAL — spawns the runner in SAFE modes only (--list / --dry-run /
//       guard-refused apply) with SUPABASE_DATABASE_URL and every apply-guard env
//       var STRIPPED from the child environment, so no connection is even possible.
//
// Run:  npx tsx scripts/diagnostics-supabase-migrate-runner-check.ts

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const RUNNER = join(ROOT, 'scripts', 'supabase-migrate.ts');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const src = existsSync(RUNNER) ? readFileSync(RUNNER, 'utf8') : '';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- child-process helper (DB-free by construction) -------------------------

// Strip the DB URL AND every apply-guard env var so the child can neither connect
// nor satisfy apply guards, regardless of the surrounding shell.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
delete childEnv.SUPABASE_DATABASE_URL;
delete childEnv.ALLOW_SUPABASE_MIGRATION_APPLY;
delete childEnv.CONFIRM_SUPABASE_TARGET;
delete childEnv.EXPECTED_DEV_PROJECT_REF;

interface Run { status: number | null; out: string }
function run(args: string[]): Run {
  const res = existsSync(TSX_CLI)
    ? spawnSync(process.execPath, [TSX_CLI, RUNNER, ...args], { cwd: ROOT, env: childEnv, encoding: 'utf8' })
    : spawnSync('npx', ['tsx', RUNNER, ...args], { cwd: ROOT, env: childEnv, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

// =============================================================================
// 1) STATIC checks on the runner source
// =============================================================================

check('S1 runner source exists', src.length > 0, RUNNER);
check('S2 supports --list', src.includes('--list'));
check('S3 supports --dry-run', src.includes('--dry-run'));
check('S4 supports --apply', src.includes('--apply'));
check('S5 default mode is safe (falls through to runList)', /else\s*\{[\s\S]*?runList\(\)/.test(src) && src.includes('runList'));
check('S6 production hard-block', /NODE_ENV\s*===\s*'production'/.test(src));
check('S7 apply requires ALLOW_SUPABASE_MIGRATION_APPLY', src.includes('ALLOW_SUPABASE_MIGRATION_APPLY'));
check('S8 apply requires CONFIRM_SUPABASE_TARGET', src.includes('CONFIRM_SUPABASE_TARGET'));
check('S9 apply requires --confirm-dev', src.includes('--confirm-dev'));
check('S10 down requires --allow-down', src.includes('--allow-down'));
check('S11 path-traversal rejection (isAbsolute + traversal guard)', src.includes('isAbsolute') && /traversal/i.test(src));
check('S12 migration folder restriction (realpath containment)', src.includes('realpathSync') && src.includes('platform-identity'));
check('S13 naming pattern validation (NNN_name.(up|down).sql)', src.includes('\\d{3}') && src.includes('(up|down)'));
check('S14 does NOT log SUPABASE_DATABASE_URL / databaseUrl', !/console\.\w+\([^)]*\b(databaseUrl|SUPABASE_DATABASE_URL)\b/.test(src));
check('S15 does NOT print full SQL (sqlText)', !/console\.\w+\([^)]*\bsqlText\b/.test(src));

// =============================================================================
// 2) BEHAVIOURAL checks (safe modes only; child has no DB URL / no guards)
// =============================================================================

const allOut: string[] = [];
function record(r: Run): Run { allOut.push(r.out); return r; }

// B1 — --list succeeds, DB-free, discovers 001 and 002.
{
  const r = record(run(['--list']));
  check('B1 --list succeeds and discovers 001 + 002', r.status === 0 && /id=001/.test(r.out) && /id=002/.test(r.out), `status=${r.status}`);
}

// B2 — dry-run 001 (up) resolves.
{
  const r = record(run(['--dry-run', '--migration', '001']));
  check('B2 --dry-run --migration 001 resolves up', r.status === 0 && r.out.includes('001_platform_identity') && /direction:\s*up/.test(r.out), `status=${r.status}`);
}

// B3 — dry-run 002 (up) resolves.
{
  const r = record(run(['--dry-run', '--migration', '002']));
  check('B3 --dry-run --migration 002 resolves up', r.status === 0 && r.out.includes('002_authorization_audit_foundation') && /direction:\s*up/.test(r.out), `status=${r.status}`);
}

// B4 — dry-run 002 down resolves the down file.
{
  const r = record(run(['--dry-run', '--migration', '002', '--direction', 'down']));
  check('B4 --dry-run --migration 002 --direction down resolves down', r.status === 0 && /direction:\s*down/.test(r.out) && r.out.includes('002_authorization_audit_foundation.down.sql'), `status=${r.status}`);
}

// B5 — traversal is rejected (no DB touch).
{
  const r = record(run(['--dry-run', '--migration', '../x']));
  check('B5 traversal "../x" rejected', r.status !== 0 && /traversal|invalid migration identifier/i.test(r.out), `status=${r.status}`);
}

// B6 — apply WITHOUT guards refuses before any DB connection.
{
  const r = record(run(['--migration', '002', '--direction', 'up', '--apply']));
  const refusedEarly = r.status !== 0 && /REFUSED/.test(r.out) && !/ECONNREFUSED|getaddrinfo|SASL|SUCCESS/.test(r.out);
  check('B6 apply without guards refuses pre-connection', refusedEarly, `status=${r.status}`);
}

// B7 — down apply without the extra guard refuses (no DB touch).
{
  const r = record(run(['--migration', '002', '--direction', 'down', '--apply', '--confirm-dev']));
  check('B7 down apply (missing guards/--allow-down) refuses', r.status !== 0 && /REFUSED/.test(r.out) && !/SUCCESS/.test(r.out), `status=${r.status}`);
}

// B8 — across ALL runs: no DB URL / connection string / SQL body / apply success leaked.
{
  const combined = allOut.join('\n');
  const noUrl = !/postgres(ql)?:\/\//i.test(combined) && !/\.supabase\.co/i.test(combined);
  const noSql = !/create\s+table/i.test(combined);
  const noApplySuccess = !/SUCCESS:/.test(combined);
  check('B8 no secrets/DB URL/SQL body/apply-success in any output', noUrl && noSql && noApplySuccess, `noUrl=${noUrl} noSql=${noSql} noApplySuccess=${noApplySuccess}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[migrate-runner-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
