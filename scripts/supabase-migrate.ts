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
// DATABASE-REQUIRING operations (--status, --apply, --baseline, --resolve-dirty) run ONLY
// through the S1b TRUSTED EXECUTOR, and only after every gate below is satisfied, in order:
//   1. NODE_ENV=production is hard-blocked outright.
//   2. Mutating operations additionally require the operator gates:
//      ALLOW_SUPABASE_MIGRATION_APPLY=1, CONFIRM_SUPABASE_TARGET=<dev target label>, and
//      --confirm-dev; a DOWN direction additionally requires --allow-down.
//   3. The executor validates its own target and accepts ONLY a disposable local
//      PostgreSQL (`tmpos_s1b_*` over a task socket or loopback) named by
//      TM_POS_TEST_DATABASE_URL. It never reads an ambient application/provider DSN, so this
//      CLI cannot reach a managed or persistent database even with every gate satisfied.
// Every refusal happens BEFORE a connection exists and carries a stable reason + exit code 2.
//
// SECURITY: never prints a connection string, a derived project ref, SQL file contents,
// or any secret. Output is bounded: migration id/basename/direction, the relative path,
// transaction mode, and stable reason codes. Operator CLI only — never imported by the
// client (`src/`) or the server runtime; importing it opens no connection.

import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import {
  computeStatus,
  createNodeFsPort,
  discoverMigrations,
  pairMigrations,
  planBaseline,
  planDirtyResolution,
  type MigrationPair,
} from '../server/platform-identity/migrationEngine';
// The CLI is the ONLY composition root allowed to build the trusted executor. It holds no
// driver import of its own: the executor owns the client, the target validation, and the DSN.
import {
  MigrationExecutorError,
  createPostgresExecutor,
  describeDsn,
  resolveDisposableTestDsn,
  runTrustedApply,
  runTrustedLedgerRead,
} from '../server/platform-identity/migrationExecutor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'server', 'platform-identity', 'migrations');
const MIGRATIONS_REL = 'server/platform-identity/migrations';

// The DEV confirmation token (label only, not a secret). Retained for the guarded
// operator path S1b will re-enable; a wrong label can never satisfy a future apply guard.
const EXPECTED_DEV_TARGET = 'tmpos2026-dev';

// A migration identifier (number or basename) may contain ONLY these characters — this
// alone rejects '/', '\\', '..', '.', and absolute paths.
const IDENT_RE = /^[a-z0-9_]+$/i;

// Stable refusal contract for every database-requiring operation. One exit code, three
// bounded reasons, all raised BEFORE any connection could exist.
const PG_VALIDATION_REQUIRED = 'migration_engine_pg_validation_required';
const PRODUCTION_FORBIDDEN = 'migration_production_forbidden';
const OPERATOR_GATE_UNSATISFIED = 'migration_operator_gate_unsatisfied';
const PG_VALIDATION_EXIT = 2;

// Opaque, non-secret credential REFERENCES. They name which principal a run claims to use; the
// real credential lives in the validated target and never passes through this file.
const MIGRATOR_REF = 'tmpos-migrator';
const RUNTIME_REF = 'tmpos-runtime';
/** One stable advisory-lock key for the whole migration run. */
const RUN_LOCK_KEY = 720100301;
/** Bound applied to every awaited database operation. */
const OPERATION_DEADLINE_MS = 30000;
/** A durable ledger WRITE that S1b plans but does not yet perform. Reported, never faked. */
const LEDGER_WRITE_UNIMPLEMENTED = 'migration_ledger_write_not_implemented';

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
const rawDirection = getOpt('--direction') ?? (hasFlag('--down') ? 'down' : 'up');
const direction = rawDirection;

// ---- safe failure -----------------------------------------------------------

/** Print a safe refusal (variable NAMES / codes only, never values) and exit non-zero. */
function refuse(message: string, exitCode = 1): never {
  console.error(`[migrate] REFUSED: ${message}`);
  process.exit(exitCode);
}

/**
 * Operator + environment gates for a database-requiring operation. Every branch refuses BEFORE
 * a connection string is read or a client is constructed, with a stable reason and exit code 2.
 *
 * `mutating` distinguishes a read-only status from apply/baseline/resolve-dirty: only the
 * mutating operations demand the operator acknowledgement gates, which is the historical
 * contract and is deliberately not weakened here.
 */
function assertOperatorGates(op: string, mutating: boolean): void {
  // 1. Production is hard-blocked outright — before anything else is even considered.
  if (process.env.NODE_ENV === 'production') {
    refuse(
      `${PRODUCTION_FORBIDDEN} — "${op}" is refused because NODE_ENV=production; this runner is ` +
        `DEV-only and no database connection was attempted.`,
      PG_VALIDATION_EXIT,
    );
  }
  if (!mutating) return;

  // 2. The operator acknowledgement gates, unchanged from the historical apply contract.
  const missing: string[] = [];
  if (process.env.ALLOW_SUPABASE_MIGRATION_APPLY !== '1') missing.push('ALLOW_SUPABASE_MIGRATION_APPLY=1');
  if (process.env.CONFIRM_SUPABASE_TARGET !== EXPECTED_DEV_TARGET) missing.push('CONFIRM_SUPABASE_TARGET=<dev target label>');
  if (!hasFlag('--confirm-dev')) missing.push('--confirm-dev');
  if (rawDirection === 'down' && !hasFlag('--allow-down')) missing.push('--allow-down');
  if (missing.length > 0) {
    // Variable NAMES only — never their values.
    refuse(
      `${OPERATOR_GATE_UNSATISFIED} — "${op}" requires: ${missing.join(', ')}. ` +
        `No database connection was attempted.`,
      PG_VALIDATION_EXIT,
    );
  }
}

/**
 * Run a database-requiring operation through the trusted executor.
 *
 * The executor validates its own target and refuses anything that is not a DISPOSABLE local
 * PostgreSQL, so this path cannot reach a managed or persistent database. Nothing it returns is
 * printed beyond bounded codes, counts and version labels.
 *
 * A refusal is DEFERRED to after the client is disposed: `refuse()` ends the process, and a
 * `finally` block does not run through `process.exit`, so refusing inline would skip disposal.
 */
async function runThroughExecutor(op: string, mutating: boolean): Promise<void> {
  assertOperatorGates(op, mutating);
  let handle: Awaited<ReturnType<typeof createPostgresExecutor>> | null = null;
  let refusal: string | null = null;
  try {
    const dsn = resolveDisposableTestDsn(process.env);
    const target = describeDsn(dsn);
    console.log(`[migrate] ${op}: disposable target host=${target.hostKind} database=${target.database}`);
    handle = await createPostgresExecutor(dsn);
    const shared = {
      adapter: handle.adapter,
      ledger: handle.ledger,
      connectionMode: 'session' as const,
      deadlineMs: OPERATION_DEADLINE_MS,
    };

    if (op === 'status' || op === 'baseline' || op === 'resolve-dirty') {
      // READ-ONLY contact. Status and planning must never apply a migration as a side effect,
      // so they use the read path — which takes no lock and executes no migration SQL.
      const read = await runTrustedLedgerRead(shared);
      console.log(`[migrate] ${op}: outcome=${read.outcome} rows=${read.rows.length} disposal=${read.disposal} code=${read.code ?? 'none'}`);
      if (read.outcome !== 'complete') {
        refusal = `${op} could not read the ledger: ${read.code ?? 'unknown'}`;
      } else if (op === 'status') {
        for (const st of computeStatus(discoverPairs(), read.rows)) {
          console.log(`  version=${st.version}  state=${st.state}  ledger=${st.ledgerChecksum === null ? 'none' : 'recorded'}`);
        }
      } else if (op === 'baseline') {
        // Baseline authorization is UNCHANGED: the operator must name the exact version set, and
        // the engine refuses unless it equals the discovered set on a genuinely empty ledger.
        const allowlist = (getOpt('--baseline-versions') ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '');
        if (allowlist.length === 0) {
          refusal = 'baseline requires --baseline-versions=<comma-separated versions> (operator authorization)';
        } else {
          const plan = planBaseline(discoverPairs(), read.rows, allowlist);
          console.log(`[migrate] baseline plan: versions=${plan.versions.map((v) => v.version).join(',')} audit=${plan.plannedAudit.action}`);
          refusal = `${LEDGER_WRITE_UNIMPLEMENTED} — the baseline PLAN was computed against the live ledger, but the durable baseline write is not implemented in S1b.`;
        }
      } else {
        const version = getOpt('--migration');
        const reasonCategory = getOpt('--reason-category');
        const correctiveRef = getOpt('--corrective-ref');
        if (!version || !reasonCategory || !correctiveRef) {
          refusal = 'resolve-dirty requires --migration, --reason-category and --corrective-ref';
        } else {
          const resolution = planDirtyResolution({ version, reasonCategory, correctiveRef, at: new Date().toISOString() });
          console.log(`[migrate] resolve-dirty plan: version=${version} status=${resolution.status}`);
          refusal = `${LEDGER_WRITE_UNIMPLEMENTED} — the resolution RECORD was computed against the live ledger, but the durable resolution write is not implemented in S1b.`;
        }
      }
    } else {
      const report = await runTrustedApply({
        ...shared,
        fsPort: createNodeFsPort(MIGRATIONS_DIR, MIGRATIONS_REL),
        credential: { purpose: 'migration', migratorRef: MIGRATOR_REF, runtimeRef: RUNTIME_REF },
        lockKey: RUN_LOCK_KEY,
        now: () => new Date().toISOString(),
      });
      console.log(
        `[migrate] ${op}: outcome=${report.outcome} applied=${report.applied.length} ` +
          `disposal=${report.disposal} code=${report.code ?? 'none'}`,
      );
      if (report.outcome !== 'complete') refusal = `${op} did not complete: ${report.code ?? 'unknown'}`;
    }
  } catch (err) {
    // Only a bounded executor code crosses this boundary — never a driver message or a DSN.
    const code = err instanceof MigrationExecutorError ? err.code : PG_VALIDATION_REQUIRED;
    refusal = `${op} refused before completion: ${code}. No managed database was contacted.`;
  } finally {
    if (handle !== null) await handle.dispose();
  }
  // Dispose FIRST, refuse second: process.exit() would otherwise skip the disposal above.
  if (refusal !== null) refuse(refusal, PG_VALIDATION_EXIT);
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
  if (wantApply) return runThroughExecutor(rawDirection === 'down' ? 'apply(down)' : 'apply(up)', true);
  if (wantStatus) return runThroughExecutor('status', false);
  if (wantBaseline) return runThroughExecutor('baseline', true);
  if (wantResolveDirty) return runThroughExecutor('resolve-dirty', true);

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
