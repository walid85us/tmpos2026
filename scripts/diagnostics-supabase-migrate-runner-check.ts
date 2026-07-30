// Phase 4.0 M3 S1 — dev-only check for the DATABASE-FREE migration CLI contract.
//
// PURE / OFFLINE: it NEVER connects to Postgres, runs no SQL, applies no migration, and
// uses no Supabase/Firebase/MCP. It validates the CLI two ways:
//   (1) STATIC — reads scripts/supabase-migrate.ts as text and asserts the DB-free modes,
//       the fail-closed database-requiring gate, the absence of any database-client
//       construction, path-safety, and secret-safe logging are present.
//   (2) BEHAVIOURAL — spawns the CLI in SAFE modes (--list / --plan / --dry-run) and
//       proves every database-requiring op (apply / status / baseline / resolve-dirty)
//       fails closed with the stable `migration_engine_pg_validation_required` reason and
//       exit code BEFORE any connection could be created. The child env has the DB URL
//       and every apply-guard var STRIPPED, so no connection is even possible.
//
// Run:  npx tsx scripts/diagnostics-supabase-migrate-runner-check.ts

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const RUNNER = join(ROOT, 'scripts', 'supabase-migrate.ts');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const src = existsSync(RUNNER) ? readFileSync(RUNNER, 'utf8') : '';

// The stable refusal contract this CLI must honour. Every database-requiring operation refuses
// BEFORE a connection exists, with one exit code and a bounded reason naming which gate stopped it.
const PG_VALIDATION_REQUIRED = 'migration_engine_pg_validation_required';
const PRODUCTION_FORBIDDEN = 'migration_production_forbidden';
const OPERATOR_GATE_UNSATISFIED = 'migration_operator_gate_unsatisfied';
const TEST_DSN_MISSING = 'test_dsn_missing';
const TEST_DSN_HOST_NOT_LOCAL = 'test_dsn_host_not_local';
const PG_VALIDATION_EXIT = 2;

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---- child-process helper (DB-free by construction) -------------------------

// Strip the DB URL AND every apply-guard env var so the child can neither connect nor
// satisfy any legacy guard, regardless of the surrounding shell.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
delete childEnv.SUPABASE_DATABASE_URL;
delete childEnv.ALLOW_SUPABASE_MIGRATION_APPLY;
delete childEnv.CONFIRM_SUPABASE_TARGET;
delete childEnv.EXPECTED_DEV_PROJECT_REF;
// The S1b target variable is stripped as well, so a machine that happens to export one cannot
// let a behavioural check reach a live database.
delete childEnv.TM_POS_TEST_DATABASE_URL;

interface Run { status: number | null; out: string }
function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run {
  // Fail closed if the pinned local tsx is missing rather than falling back to `npx`, which
  // could resolve packages over the network — this diagnostic must stay fully offline.
  if (!existsSync(TSX_CLI)) {
    return { status: 127, out: 'REFUSED: pinned local tsx executable missing — offline diagnostic will not invoke npx' };
  }
  const res = spawnSync(process.execPath, [TSX_CLI, RUNNER, ...args], { cwd: ROOT, env: { ...childEnv, ...extraEnv }, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

// =============================================================================
// 1) STATIC checks on the CLI source
// =============================================================================

check('S1 runner source exists', src.length > 0, RUNNER);
check('S2 supports --list', src.includes('--list'));
check('S3 supports --dry-run', src.includes('--dry-run'));
check('S4 supports --plan', src.includes('--plan'));
check('S5 default mode is the safe DB-free listing', /else\s+runList\(\)/.test(src));
check('S6 production hard-block retained', /NODE_ENV\s*===\s*'production'/.test(src));

// The database-requiring gate: stable reason + exit code, refusing before any connection.
check('S7 stable fail-closed reason present', src.includes(PG_VALIDATION_REQUIRED));
check('S8 stable fail-closed exit code present', src.includes(`PG_VALIDATION_EXIT = ${PG_VALIDATION_EXIT}`));
check('S9 apply is routed through the trusted executor, never inline', /wantApply\)\s*return runThroughExecutor\(/.test(src));
check('S10 status/baseline/resolve-dirty are routed through the trusted executor',
  /wantStatus\)\s*return runThroughExecutor\('status', false\)/.test(src) &&
  /wantBaseline\)\s*return runThroughExecutor\('baseline', true\)/.test(src) &&
  /wantResolveDirty\)\s*return runThroughExecutor\('resolve-dirty', true\)/.test(src));
check('S9b the operator gates are asserted before any executor construction',
  /assertOperatorGates\(op, mutating\);[\s\S]{0,200}?createPostgresExecutor/.test(src));
check('S9c production is hard-blocked first, ahead of every other gate',
  /NODE_ENV === 'production'[\s\S]{0,300}?PRODUCTION_FORBIDDEN|PRODUCTION_FORBIDDEN[\s\S]{0,300}?ALLOW_SUPABASE_MIGRATION_APPLY/.test(src));
check('S9d the historical operator gates are all still required',
  src.includes('ALLOW_SUPABASE_MIGRATION_APPLY') && src.includes('CONFIRM_SUPABASE_TARGET') &&
  src.includes("--confirm-dev") && src.includes("--allow-down"));

// No database-client construction / no provider SDK import (neither new nor legacy path).
check('S11 no postgres/provider client import', !/from\s+'postgres'/.test(src) && !/require\(['"]postgres['"]\)/.test(src));
check('S12 no database client is constructed', !/\bpostgres\s*\(/.test(src) && !/createClient\s*\(/.test(src));
check('S13 no SQL is executed (no sql.unsafe / .simple())', !/\.unsafe\s*\(/.test(src) && !/\.simple\s*\(/.test(src));

// Path safety + delegation to the engine.
check('S14 path-traversal rejection (isAbsolute + traversal guard)', src.includes('isAbsolute') && /traversal/i.test(src));
check('S15 discovery delegated to the migration engine', src.includes("from '../server/platform-identity/migrationEngine'"));

// Secret-safe logging.
check('S16 does NOT log SUPABASE_DATABASE_URL / databaseUrl', !/console\.\w+\([^)]*\b(databaseUrl|SUPABASE_DATABASE_URL)\b/.test(src));
check('S17 does NOT print full SQL (sqlText)', !/console\.\w+\([^)]*\bsqlText\b/.test(src) && !src.includes('sqlText'));

// Refusal happens BEFORE any connection string is read: the CLI must not reference the DB
// URL at all in S1 (a stripped env var would make a prohibited read observationally
// invisible, so this static assertion is what actually proves the S1 boundary).
check('S18 never reads the connection string (no SUPABASE_DATABASE_URL access at all)', !src.includes('SUPABASE_DATABASE_URL'));

// =============================================================================
// 2) BEHAVIOURAL checks (safe modes + fail-closed apply; child has no DB URL)
// =============================================================================

const allOut: string[] = [];
function record(r: Run): Run { allOut.push(r.out); return r; }

// B1 — --list succeeds, DB-free, discovers 001 and 002.
{
  const r = record(run(['--list']));
  check('B1 --list succeeds and discovers 001 + 002', r.status === 0 && /id=001/.test(r.out) && /id=002/.test(r.out), `status=${r.status}`);
}

// B2 — --plan succeeds, DB-free.
{
  const r = record(run(['--plan']));
  check('B2 --plan succeeds DB-free', r.status === 0 && /file-side plan/.test(r.out), `status=${r.status}`);
}

// B3 — dry-run 001 (up) resolves.
{
  const r = record(run(['--dry-run', '--migration', '001']));
  check('B3 --dry-run --migration 001 resolves up', r.status === 0 && r.out.includes('001_platform_identity') && /direction:\s*up/.test(r.out), `status=${r.status}`);
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

// B6 — apply fails closed with the stable reason + exit code, BEFORE any connection.
{
  const r = record(run(['--migration', '002', '--direction', 'up', '--apply']));
  const failedClosed =
    r.status === PG_VALIDATION_EXIT &&
    r.out.includes(OPERATOR_GATE_UNSATISFIED) &&
    !/ECONNREFUSED|getaddrinfo|SASL|SUCCESS/.test(r.out);
  check('B6 apply without operator gates fails closed pre-connection', failedClosed, `status=${r.status}`);
}

// B7 — down apply fails closed the same way (no DB touch).
{
  const r = record(run(['--migration', '002', '--direction', 'down', '--apply']));
  check('B7 down apply fails closed pre-connection', r.status === PG_VALIDATION_EXIT && r.out.includes(OPERATOR_GATE_UNSATISFIED) && !/SUCCESS/.test(r.out), `status=${r.status}`);
}

// B8 — status / baseline / resolve-dirty all fail closed with the stable reason.
{
  // status is read-only, so it is stopped by the TARGET gate; baseline/resolve-dirty mutate, so
  // they are stopped earlier still, by the operator gates.
  const expected: Array<[string, string]> = [
    ['--status', TEST_DSN_MISSING],
    ['--baseline', OPERATOR_GATE_UNSATISFIED],
    ['--resolve-dirty', OPERATOR_GATE_UNSATISFIED],
  ];
  let allClosed = true;
  for (const [mode, reason] of expected) {
    const r = record(run([mode]));
    if (!(r.status === PG_VALIDATION_EXIT && r.out.includes(reason))) allClosed = false;
  }
  check('B8 status/baseline/resolve-dirty each fail closed with their own stable reason', allClosed);
}

// B10 — production apply fails closed with the stable reason + exit code (and a production note).
{
  const r = record(run(['--migration', '002', '--direction', 'up', '--apply'], { NODE_ENV: 'production' }));
  check('B10 production apply is hard-blocked first, ahead of every other gate', r.status === PG_VALIDATION_EXIT && r.out.includes(PRODUCTION_FORBIDDEN) && /production/i.test(r.out), `status=${r.status}`);
}

// B11 — apply with a MALFORMED --direction still fails closed (the gate precedes direction validation).
{
  const r = record(run(['--apply', '--direction', 'sideways']));
  check('B11 apply with a malformed --direction still fails closed pre-validation', r.status === PG_VALIDATION_EXIT && r.out.includes(OPERATOR_GATE_UNSATISFIED), `status=${r.status}`);
}

// B12 — with EVERY operator gate satisfied, the TARGET gate still refuses: the two are
// independent, so acknowledging the operation never grants a connection.
{
  const r = record(run(['--migration', '002', '--direction', 'up', '--apply', '--confirm-dev'], {
    ALLOW_SUPABASE_MIGRATION_APPLY: '1',
    CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev',
  }));
  check('B12 fully acknowledged apply still refuses without a validated disposable target',
    r.status === PG_VALIDATION_EXIT && r.out.includes(TEST_DSN_MISSING), `status=${r.status}`);
}

// B13 — the decisive containment check: even with every gate satisfied AND a target supplied,
// a MANAGED/remote endpoint is refused before a connection is attempted.
{
  const r = record(run(['--migration', '002', '--direction', 'up', '--apply', '--confirm-dev'], {
    ALLOW_SUPABASE_MIGRATION_APPLY: '1',
    CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev',
    TM_POS_TEST_DATABASE_URL: 'postgres://u:p@db.managed.example.com:5432/tmpos_s1b_x',
  }));
  check('B13 a managed/remote target is refused even with every gate satisfied',
    r.status === PG_VALIDATION_EXIT && r.out.includes(TEST_DSN_HOST_NOT_LOCAL) &&
    !/ECONNREFUSED|getaddrinfo|SUCCESS/.test(r.out), `status=${r.status}`);
}

// B14 — a non-disposable database name is refused for the same reason class.
{
  const r = record(run(['--status'], {
    TM_POS_TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/production',
  }));
  check('B14 a non-disposable database name is refused',
    r.status === PG_VALIDATION_EXIT && r.out.includes('test_dsn_database_not_disposable'), `status=${r.status}`);
}

// B9 — across ALL runs: no DB URL / connection string / SQL body / apply success leaked.
{
  const combined = allOut.join('\n');
  const noUrl = !/postgres(ql)?:\/\//i.test(combined) && !/\.supabase\.co/i.test(combined);
  const noSql = !/create\s+table/i.test(combined);
  const noApplySuccess = !/SUCCESS:/.test(combined);
  check('B9 no secrets/DB URL/SQL body/apply-success in any output', noUrl && noSql && noApplySuccess, `noUrl=${noUrl} noSql=${noSql} noApplySuccess=${noApplySuccess}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[migrate-runner-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
