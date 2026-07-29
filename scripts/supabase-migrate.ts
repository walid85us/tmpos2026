// Phase 4.0 M3 S1 — Platform Identity migration CLI (thin, DATABASE-FREE in S1).
//
// This CLI is a thin front over the deterministic engine in
// server/platform-identity/migrationEngine.ts. In S1 it constructs NO database client,
// reads NO connection string, imports NO provider SDK, and executes NO SQL.
//
// DATABASE-FREE commands (discovery only; never touch a DB URL or a client):
//   npm run identity:migrate                        # --list (default)
//   npx tsx scripts/supabase-migrate.ts --list
//   npx tsx scripts/supabase-migrate.ts --plan
//   npx tsx scripts/supabase-migrate.ts --dry-run --migration 002 [--direction up|down]
//
// DATABASE-REQUIRING operations are FAIL-CLOSED in S1 — they refuse BEFORE reading a
// connection string or constructing a client, with the stable reason
// `migration_engine_pg_validation_required` (exit code 2), until S1b supplies the
// disposable-PostgreSQL harness, the reserved-session/advisory-lock proof, and CI
// evidence (D3/D5). This set: --apply, --status (live ledger), --baseline,
// --resolve-dirty, and any DOWN execution. Production remains hard-blocked regardless.
//
// SECURITY: never prints a connection string, a derived project ref, SQL file contents,
// or any secret. Output is bounded: migration id/basename/direction, the relative path,
// transaction mode, and stable reason codes. Operator CLI only — never imported by the
// client (`src/`) or the server runtime; importing it opens no connection.

import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import {
  createNodeFsPort,
  discoverMigrations,
  pairMigrations,
  type MigrationPair,
} from '../server/platform-identity/migrationEngine';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'server', 'platform-identity', 'migrations');
const MIGRATIONS_REL = 'server/platform-identity/migrations';

// The DEV confirmation token (label only, not a secret). Retained for the guarded
// operator path S1b will re-enable; a wrong label can never satisfy a future apply guard.
const EXPECTED_DEV_TARGET = 'tmpos2026-dev';

// A migration identifier (number or basename) may contain ONLY these characters — this
// alone rejects '/', '\\', '..', '.', and absolute paths.
const IDENT_RE = /^[a-z0-9_]+$/i;

// Stable fail-closed contract for every database-requiring operation in S1.
const PG_VALIDATION_REQUIRED = 'migration_engine_pg_validation_required';
const PG_VALIDATION_EXIT = 2;

// ---- argument parsing -------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (f: string): boolean => argv.includes(f);
function getOpt(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return undefined;
}

const wantApply = hasFlag('--apply');
const wantDryRun = hasFlag('--dry-run');
const wantList = hasFlag('--list');
const wantPlan = hasFlag('--plan');
const wantStatus = hasFlag('--status');
const wantBaseline = hasFlag('--baseline');
const wantResolveDirty = hasFlag('--resolve-dirty');
const migrationInput = getOpt('--migration');
const direction = getOpt('--direction') ?? (hasFlag('--down') ? 'down' : 'up');

// ---- safe failure -----------------------------------------------------------

/** Print a safe refusal (variable NAMES / codes only, never values) and exit non-zero. */
function refuse(message: string, exitCode = 1): never {
  console.error(`[migrate] REFUSED: ${message}`);
  process.exit(exitCode);
}

/**
 * Fail-closed gate for every database-requiring operation in S1. Refuses BEFORE any
 * connection string is read or client is constructed. Production is hard-blocked first
 * (the historical guard); otherwise the stable pg-validation reason + exit code.
 */
function refusePgValidationRequired(op: string): never {
  // Every database-requiring op returns the SAME stable reason + exit code, including under
  // production (which is additionally hard-blocked). No connection string is read either way.
  const productionNote = process.env.NODE_ENV === 'production'
    ? ' NODE_ENV=production is additionally hard-blocked (this runner is DEV-only).'
    : '';
  refuse(
    `${PG_VALIDATION_REQUIRED} — "${op}" requires S1b real-PostgreSQL proof (reserved-session ` +
      `+ advisory-lock + CI) before it can execute. No database connection was attempted. ` +
      `DEV target label: ${EXPECTED_DEV_TARGET}.${productionNote}`,
    PG_VALIDATION_EXIT,
  );
}

// ---- database-free discovery (delegated to the engine) ----------------------

function discoverPairs(): MigrationPair[] {
  const port = createNodeFsPort(MIGRATIONS_DIR, MIGRATIONS_REL);
  return pairMigrations(discoverMigrations(port));
}

function assertSafeInput(input: string | undefined): asserts input is string {
  if (!input) throw new Error('a migration identifier is required (e.g. --migration 002)');
  // Defense-in-depth traversal rejection before the allow-list, for a precise error.
  if (input.includes('/') || input.includes('\\') || input.includes('..') || isAbsolute(input)) {
    throw new Error('invalid migration identifier: path separators / traversal are not allowed');
  }
  if (!IDENT_RE.test(input)) {
    throw new Error('invalid migration identifier: only letters, digits, and underscore are allowed');
  }
}

// ---- database-free modes ----------------------------------------------------

function runList(): void {
  const pairs = discoverPairs();
  console.log(`[migrate] discovered migrations under ${MIGRATIONS_REL}/:`);
  if (pairs.length === 0) {
    console.log('  (none found)');
  } else {
    for (const p of pairs) {
      console.log(`  id=${p.version}  basename=${p.version}_${p.name}  up=yes  down=yes  tx=${p.transactionMode}`);
    }
  }
  console.log('[migrate] list mode: no database connection, no SQL executed.');
}

function runPlan(): void {
  const pairs = discoverPairs();
  console.log('[migrate] file-side plan (no database connection, no ledger read):');
  for (const p of pairs) {
    console.log(`  id=${p.version}  ${p.version}_${p.name}  tx=${p.transactionMode}  up.sha256=${p.up.checksum.slice(0, 12)}…`);
  }
  console.log('[migrate] plan mode is file-only. A live status/apply requires S1b (fail-closed in S1).');
}

function runDryRun(dir: 'up' | 'down'): void {
  assertSafeInput(migrationInput);
  const pairs = discoverPairs();
  const match = /^\d{3}$/.test(migrationInput)
    ? pairs.find((p) => p.version === migrationInput)
    : pairs.find((p) => `${p.version}_${p.name}` === migrationInput);
  if (!match) throw new Error(`no migration found for "${migrationInput}" under ${MIGRATIONS_REL}/`);
  const selectedFile = `${match.version}_${match.name}.${dir}.sql`;
  const pairedFile = `${match.version}_${match.name}.${dir === 'up' ? 'down' : 'up'}.sql`;
  console.log('[migrate] dry-run (no database connection, no SQL executed):');
  console.log(`  migration id:   ${match.version}`);
  console.log(`  basename:       ${match.version}_${match.name}`);
  console.log(`  direction:      ${dir}`);
  console.log(`  selected file:  ${MIGRATIONS_REL}/${selectedFile}`);
  console.log(`  paired file:    ${MIGRATIONS_REL}/${pairedFile}`);
  console.log(`  transaction:    ${match.transactionMode}`);
  console.log('  pair verified:  yes');
  console.log('[migrate] dry-run OK. Apply is fail-closed in S1 (requires S1b real-PostgreSQL proof).');
}

// ---- dispatch ---------------------------------------------------------------

async function main(): Promise<void> {
  // Database-REQUIRING operations fail closed FIRST — before --direction validation or any
  // connection string is read — so a malformed argument can never mask the fail-closed gate.
  const rawDirection = getOpt('--direction') ?? (hasFlag('--down') ? 'down' : 'up');
  if (wantApply) refusePgValidationRequired(rawDirection === 'down' ? 'apply(down)' : 'apply(up)');
  if (wantStatus) refusePgValidationRequired('status');
  if (wantBaseline) refusePgValidationRequired('baseline');
  if (wantResolveDirty) refusePgValidationRequired('resolve-dirty');

  if (direction !== 'up' && direction !== 'down') {
    console.error('[migrate] ERROR: --direction must be "up" or "down".');
    process.exitCode = 1;
    return;
  }
  try {
    // Database-FREE operations only reach here.
    if (wantDryRun) runDryRun(direction);
    else if (wantPlan) runPlan();
    else if (wantList) runList();
    else runList(); // default: safe, DB-free listing
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[migrate] ERROR: ${message}`);
    process.exitCode = 1;
  }
}

main();
