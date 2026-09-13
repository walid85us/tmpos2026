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
import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'path';
import {
  computeStatus,
  createNodeFsPort,
  discoverMigrations,
  pairMigrations,
  planApply,
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
  // C2B-R2 managed DEV recovery path — a SEPARATE brand, validator and executor factory.
  assertExactManagedApplyPlan,
  assertManagedDevDsn,
  createManagedDevExecutor,
  describeManagedDsn,
  resolveManagedApplyDirection,
  runTrustedHistoricalBaseline,
  verifyManagedDevFingerprint,
  // C2B-M005-B0 — the single-purpose migration-005 hardening.
  applyCommitOutcome,
  classifyApplyMutationState,
  classifyLedgerMarker,
  classifyManagedApplyRefusal,
  createM005PostCommitPolicy,
  createM005PreCommitPolicy,
  createManagedM005Policy,
  boundedExecutorError,
  type ExecutorReport,
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
/** `args` exists for the managed runner, which reads its argv through its process port. */
function getOpt(name: string, args: readonly string[] = argv): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return undefined;
}

const wantApply = hasFlag('--apply');
/** C2B-R2: explicit opt-in to the MANAGED DEV recovery path. Absent => the disposable path,
 *  whose behaviour is unchanged. There is deliberately no environment variable for this: an
 *  ambient value could select a managed target for a command the operator meant to run locally. */
const wantManagedDev = hasFlag('--managed-dev');
const wantDryRun = hasFlag('--dry-run');
const wantList = hasFlag('--list');
const wantPlan = hasFlag('--plan');
const wantStatus = hasFlag('--status');
const wantBaseline = hasFlag('--baseline');
const wantResolveDirty = hasFlag('--resolve-dirty');
/**
 * C2B-R3B-B0-R1 — does THIS process address the MANAGED database?
 *
 * Used only to decide how an UNEXPECTED top-level failure is rendered (see the `main().catch`
 * handler at the foot of this file). Deliberately a property of the flags this process was started
 * with, evaluated once: an error handler that has to ask the runtime what mode it is in has already
 * failed, because the failure being handled may be the reason that state is unreliable.
 *
 * WIDER THAN THE BASELINE, deliberately. `runThroughManagedExecutor` serves status, baseline AND
 * apply, and all three construct a real client against the same managed DSN — so a postgres.js
 * connection error carrying the host, user and connection string is reachable from all three. Fixing
 * only the baseline would have left the identical leak on two neighbouring commands. This changes
 * how an error is RENDERED and nothing about what any mode is authorized to do; the disposable
 * (non-managed) path keeps its previous behaviour untouched.
 */
const managedRun = wantManagedDev;
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
      // FINALIZED, NOT APPLIED, HERE TOO (C2B-M005-B1-R2). `report.applied` counts ledger
      // finalizes, and for a tx-scoped migration the finalize runs INSIDE the bracket — so any
      // abandoned commit leaves it holding a version that never became durable. The disposable
      // target makes that harmless, not untrue. `commit=` carries the durability evidence; the
      // gated mutation classifier deliberately does NOT appear on this path, because no
      // pre-commit gate is owed here and its verdict would understate a clean disposable run.
      console.log(
        `[migrate] ${op}: outcome=${report.outcome} finalized=${report.applied.length} ` +
          `commit=${applyCommitOutcome(report.commit)} readBack=${report.commit.readBackVerified} ` +
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

// ---- C2B-R2: the MANAGED DEV recovery path ----------------------------------
//
// A separate function with a separate target validator, deliberately. Sharing `runThroughExecutor`
// would put a managed database one predicate-edit away from the disposable path, which is the
// containment property S1b was built to hold.

/** The managed database this recovery path may ever address. */
const EXPECTED_MANAGED_DATABASE = 'postgres';
/** The ONLY historical prefix this recovery path may adopt. Not "any prefix": the pure planner
 *  accepts any in-order prefix, but THIS path is the C2B recovery and its authorized history is
 *  exactly 001-004. 005 is pending and must be EXECUTED, never adopted. */
const AUTHORIZED_BASELINE_PREFIX = ['001', '002', '003', '004'] as const;
/** The ONLY version this recovery path may execute. */
const AUTHORIZED_APPLY_VERSION = '005';
/** Durable DEV-only audit actions identifying this database (target-identity signal class C). */
const REQUIRED_AUDIT_ACTIONS = [
  'bcp.platform.system_owner_provisioning',
  'bcp.platform.system_owner_provisioning_compensation',
] as const;
const EXPECTED_ACTIVE_SYSTEM_OWNERS = 2;
const EXPECTED_SUSPENDED_SYSTEM_OWNERS = 1;

/**
 * Phase 4.0 M3 S4.1b (C2B-R3B-B0) — the FINAL environment assertion, taken immediately before the
 * managed client is constructed.
 *
 * WHAT IT ACTUALLY PROVES. The parent launcher seals the child environment at spawn, but that seal
 * covers only the moment of exec: `process.env` is a mutable process-wide object, and ANY module in
 * the import graph — a future dotenv call, a transitive dependency, a diagnostics helper — can
 * rewrite it between the seal and the moment the driver reads a value. The repository currently
 * loads no dotenv and holds no root `.env`, but neither of those is an architectural control: both
 * are facts about today's tree, and one added import would end them silently.
 *
 * WHY /proc/self/environ. It is the environment the kernel recorded at exec, and no in-process
 * assignment can change it — so it is the only source that can contradict a repopulated
 * `process.env`. Comparing the two makes a post-seal overwrite of the routing, credential or TLS
 * material a REFUSAL rather than an invisible redirect to another database.
 *
 * WHY IT REFUSES WHEN /proc IS UNREADABLE. Falling back to `process.env` would compare the mutable
 * object against itself and pass unconditionally — an assertion that cannot fail, which is worse
 * than no assertion because it reads as proof. STOP is the honest outcome.
 *
 * The PG* sweep belongs here too: postgres.js resolves unset options from `PG<KEY>` environment
 * fallbacks, so a PG name appearing after the seal can still change host, port, user or database
 * even though the DSN was already validated.
 */
const SEALED_CONFIG_NAMES = ['SUPABASE_DATABASE_URL', 'SUPABASE_URL', 'DATABASE_CA_CERT'] as const;
const STARTUP_SENSITIVE_NAMES: readonly string[] = [
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];
const ENV_SEAL_BROKEN = 'migration_managed_environment_seal_broken';

/**
 * C2B-R3B-B0-R1 — the EXACT authorized environment for the MANAGED HISTORICAL BASELINE.
 *
 * WHY AN EXACT SET, AND ONLY HERE. The previous seal proved two things: that the three configuration
 * VALUES had not changed since exec, and that no forbidden NAME (PG*, Node TLS/OpenSSL) was present.
 * Neither is an exact-set property, so an environment carrying PATH, HOME, npm_config_* and a
 * hundred inherited shell variables passed it unchanged — which meant the historical baseline could
 * still be hand-run from an ordinary interactive shell, with the launcher's whole containment
 * argument bypassed and nothing in the record saying so. The seal must therefore assert what the
 * launcher actually constructs, not merely that nothing forbidden was added to whatever was there.
 *
 * SCOPE. `--managed-dev --status` and `--managed-dev --apply` keep the previous behaviour EXACTLY:
 * they are separate operations with separate authorizations, and widening their environment contract
 * here would be an unreviewed change to a path this stage was not asked to touch.
 *
 * FEASIBILITY IS MEASURED, NOT ASSUMED. `node node_modules/tsx/dist/cli.mjs` started under exactly
 * these six variables reports exactly these six from BOTH `process.env` and `/proc/self/environ` —
 * the loader injects nothing — so the assertion is satisfiable by the launcher's own child
 * environment and fails only when something genuinely added a name.
 */
const SEALED_BASELINE_ENV_NAMES: readonly string[] = [
  'SUPABASE_DATABASE_URL',
  'SUPABASE_URL',
  'DATABASE_CA_CERT',
  'ALLOW_SUPABASE_MIGRATION_APPLY',
  'CONFIRM_SUPABASE_TARGET',
  'NODE_ENV',
];

/**
 * The seal's DECISION, as a pure function of its two environments.
 *
 * Split out from the I/O so it can be proved directly. The alternative — driving the seal by running
 * this CLI as a child with a manipulated environment — would mean that a RED mutation (a seal that
 * fails to catch an injected variable) proceeds straight to `createManagedDevExecutor` and performs
 * a DNS lookup for the configured host. A red/green exercise whose failing half contacts the network
 * is not a safe test of a containment boundary, so the decision is made testable in-process instead.
 *
 * Returns the DIVERGED NAMES, de-duplicated. Never a value, from either side.
 */
export function sealBreakage(
  op: string,
  execEnv: ReadonlyMap<string, string>,
  liveEnv: Record<string, string | undefined>,
): string[] {
  // NAMES only — a divergence is reported by which variable diverged, never by either value.
  const broken: string[] = [];
  for (const name of SEALED_CONFIG_NAMES) {
    if (liveEnv[name] !== execEnv.get(name)) broken.push(name);
  }
  // BOTH SOURCES, and for a reason on each side.
  //
  // A startup-sensitive variable present at EXEC time has already done its work — NODE_OPTIONS was
  // applied, NODE_EXTRA_CA_CERTS already widened the trust store — before a single line of
  // JavaScript ran. Sweeping only `process.env` would let a later `delete process.env.NODE_OPTIONS`
  // (a sanitizer, a test shim, a stray assignment) erase the evidence and the seal would pass
  // vacuously, reporting an environment as intact precisely when it was already compromised.
  //
  // A PG name, conversely, matters when the DRIVER reads it, which is from `process.env` at
  // connection time — so one appearing after exec is exactly as dangerous as one present at exec.
  // Neither source subsumes the other, so both are swept.
  for (const name of [...execEnv.keys(), ...Object.keys(liveEnv)]) {
    if (name.startsWith('PG') || STARTUP_SENSITIVE_NAMES.includes(name)) broken.push(name);
  }

  // ---- historical-baseline ONLY: the EXACT-SET seal --------------------------
  //
  // Everything above is shared with `--managed-dev --status` and `--managed-dev --apply` and is
  // unchanged for them. Everything below runs for the baseline and for nothing else.
  if (op === 'baseline') {
    const want = [...SEALED_BASELINE_ENV_NAMES].sort();
    // BOTH SIDES, independently. The exec-time set is what the launcher actually handed over; the
    // live set is what the driver will read. An exact match on one says nothing about the other:
    // a module that ADDS `process.env.PATH` after exec leaves the exec-time set pristine, and a
    // module that DELETES a name leaves the exec-time set pristine too.
    for (const [side, names] of [
      ['exec', [...execEnv.keys()]],
      ['live', Object.keys(liveEnv)],
    ] as const) {
      // SET EQUALITY BY MEMBERSHIP, not by joined strings. `['A','B,C'].join(',')` equals
      // `['A','B','C'].join(',')`, and an environment NAME may contain a comma — the kernel forbids
      // only '=' and NUL. A joined comparison can therefore be satisfied by a set that is not the
      // authorized one, which is precisely the failure an exact-set seal exists to make impossible.
      const got = [...new Set(names)];
      const gotSet = new Set(got);
      if (gotSet.size === want.length && want.every((k) => gotSet.has(k))) continue;
      // NAMES only, and the DIRECTION of each divergence: `+NAME` appeared, `-NAME` is missing.
      // An operator who sees `live:+PATH` knows immediately that this was a hand-run rather than a
      // launcher-spawned child, which a bare "seal broken" would not tell them.
      for (const k of got) if (!want.includes(k)) broken.push(`${side}:+${k}`);
      for (const k of want) if (!got.includes(k)) broken.push(`${side}:-${k}`);
    }
    // Value stability across ALL SIX, not just the three configuration names. The two operator
    // gates and NODE_ENV were validated earlier in this process from `process.env`; if either has
    // been rewritten since exec, that earlier validation described an environment that no longer
    // exists — and NODE_ENV in particular is the production block's only input.
    for (const name of SEALED_BASELINE_ENV_NAMES) {
      if (liveEnv[name] !== execEnv.get(name)) broken.push(`value:${name}`);
    }
  }

  return [...new Set(broken)];
}

/**
 * The seal itself: read the exec-time environment, decide, and refuse before any client exists.
 *
 * WHY IT REFUSES WHEN /proc IS UNREADABLE. Falling back to `process.env` would compare the mutable
 * object against itself and pass unconditionally — an assertion that cannot fail, which is worse
 * than no assertion because it reads as proof. STOP is the honest outcome.
 */
function assertSealedManagedEnvironment(op: string): void {
  let raw: string;
  try {
    raw = readFileSync('/proc/self/environ', 'utf8');
  } catch {
    refuse(
      `${ENV_SEAL_BROKEN} — the exec-time environment is unreadable, so the sealed managed ` +
        `environment cannot be proved intact. No database connection was attempted.`,
      PG_VALIDATION_EXIT,
    );
  }
  const execEnv = new Map<string, string>();
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) execEnv.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  const broken = sealBreakage(op, execEnv, process.env);
  if (broken.length > 0) {
    refuse(
      `${ENV_SEAL_BROKEN} — names=${broken.join(',')}. The managed environment was ` +
        `altered after exec or carries a driver/TLS override. No database connection was attempted.`,
      PG_VALIDATION_EXIT,
    );
  }
}

// ---- C2B-M005-LRLS-L3-R4-R2-V2: the managed runner's effects, as ports -------
//
// The ordering contract `runThroughManagedExecutor` keeps — execution settled, disposal requested
// and settled, teardown record, verdict, refusal line, exit classification, terminal record,
// completion — used to be witnessed by one regular expression over this file. A source scan runs
// nothing, so deleting that one test let thirteen behavioural mutations through. Taking the effects
// as ports lets the SAME function run in-process against synthetic adapters, so the contract is also
// witnessed by what the function DOES.
//
// Only EFFECTS are ports: opening the managed executor, the two trusted runners, the two output
// streams, the argv the baseline allowlist is read from, the exit classification and the process
// termination. The verdict and the terminal record are not — they are the function's own
// statements, run unchanged by production and by the harness.

/** The three operations the managed path serves: the dispatch's own literals and nothing else. */
const MANAGED_OPS = Object.freeze(['status', 'baseline', 'apply(up)'] as const);
type ManagedOp = (typeof MANAGED_OPS)[number];

interface ManagedRunPorts {
  /** Operator gates, DSN validation, environment seal, then the ONE client — see openManagedExecutor. */
  readonly openManagedExecutor: (op: ManagedOp) => ReturnType<typeof createManagedDevExecutor>;
  readonly runTrustedHistoricalBaseline: typeof runTrustedHistoricalBaseline;
  readonly runTrustedApply: typeof runTrustedApply;
  readonly console: Pick<Console, 'log' | 'error'>;
  readonly process: {
    readonly argv: readonly string[];
    exitCode?: number | string | undefined;
    readonly stdout: { write(chunk: string, callback: (err?: Error | null) => void): unknown };
    exit(code: number): void;
  };
}
const MANAGED_PORT_NAMES = Object.freeze([
  'console', 'openManagedExecutor', 'process', 'runTrustedApply', 'runTrustedHistoricalBaseline',
]);

/** Exactly the five members above, on a frozen object — by membership, never by a joined string. */
function isSealedManagedPortSet(ports: unknown): boolean {
  if (typeof ports !== 'object' || ports === null || !Object.isFrozen(ports)) return false;
  const names = Reflect.ownKeys(ports);
  return names.length === MANAGED_PORT_NAMES.length && MANAGED_PORT_NAMES.every((n) => names.includes(n));
}

/**
 * The ONE route from this file to a managed client, and production-only: bound into
 * `PRODUCTION_MANAGED_PORTS` below and exported nowhere. The operator gates, the DSN validation and
 * the environment seal run here, in their original order, before the construction — so no port set
 * obtains the client without them. A synthetic set can only supply its own open, which reaches none.
 */
async function openManagedExecutor(op: ManagedOp): ReturnType<typeof createManagedDevExecutor> {
  // Signal class A (operator attestation) and the production block, unchanged and BEFORE any
  // connection string is read. `mutating` is always true here: every managed operation either
  // writes the ledger or precedes one that does.
  assertOperatorGates(op, true);

  // Signal class B (endpoint-derived): the DSN's project reference must agree with an
  // INDEPENDENTLY configured project URL. Refused before a client exists.
  const dsn = assertManagedDevDsn(process.env.SUPABASE_DATABASE_URL, process.env.SUPABASE_URL, EXPECTED_MANAGED_DATABASE);
  const shape = describeManagedDsn(dsn);
  console.log(`[migrate] ${op}: managed target endpointFamily=${shape.endpointFamily} database=${shape.database}`);

  // THE LAST ASSERTION BEFORE A CLIENT EXISTS. Everything above validated the DSN as a VALUE;
  // this proves the environment that value came from is still the one the parent sealed. It sits
  // here, and not earlier, because every line between an earlier check and this call is a window
  // in which `process.env` could be rewritten.
  // The OP is passed so the historical baseline gets the EXACT-SET seal while status and apply
  // keep the contract they were authorized under. It is the dispatch's own literal — 'baseline',
  // 'status' or `apply(up)` — never an operator string.
  assertSealedManagedEnvironment(op);
  return createManagedDevExecutor(dsn);
}

/**
 * Exported so the control flow below can be proved in-process, as `sealBreakage` is. It cannot run
 * without a caller-supplied port set: there is no default, and the only set with real effects is
 * module-private and passed by `main()` alone.
 */
export async function runThroughManagedExecutor(op: ManagedOp, ports: ManagedRunPorts): Promise<void> {
  // CHECKED BEFORE ANY PORT IS TOUCHED: an operation outside the dispatch's three literals, or a
  // port set that is not exactly the sealed five, is refused here — never discovered half-way
  // through a run it could then not report.
  if (!(MANAGED_OPS as readonly string[]).includes(op) || !isSealedManagedPortSet(ports)) {
    throw new TypeError('managed run refused: unsupported operation or port set');
  }
  // THE PORTS KEEP THE NAMES OF WHAT THEY REPLACE, so every statement below is byte-for-byte the one
  // production runs, with the real `console`, `process` and runners bound in. The TYPES are narrowed
  // to exactly what this function may touch, so a new `process.env` read or `console.warn` here is a
  // compile error rather than an unported effect.
  const { openManagedExecutor, runTrustedHistoricalBaseline, runTrustedApply, console, process } = ports;
  /**
   * The apply report, held so the operator verdict can be computed ONCE — after the teardown, which
   * is the last piece of evidence and is only knowable in the `finally` below.
   */
  let applyEvidence: ExecutorReport | null = null;

  let handle: Awaited<ReturnType<typeof createManagedDevExecutor>> | null = null;
  let refusal: string | null = null;
  // C2B-M005-LRLS-L3-R4-R2 — THE THREE BOUNDED INPUTS TO THE POST-DECISION TERMINAL RECORD.
  //
  // The teardown record below proves the CLEANUP boundary was crossed and nothing more. A signal
  // delivered after it but before the refusal is applied still ended this run with `exit=0
  // signal=null` — byte-identical to a clean success — because the decision had not yet been
  // spoken. These carry the decision, the cleanup outcome and its bounded code out to the ONE
  // record emitted after all of them are final.
  //
  // `threw` is a SEPARATE fact from `refusal`, deliberately: a run that threw and a run that
  // refused in band are both non-zero, but they are different operator situations, and collapsing
  // them would make the record say less than the state it reports on.
  let threw = false;
  let cleanup: 'completed' | 'failed' | 'not_attempted' = 'not_attempted';
  let cleanupCode = 'none';
  try {
    // The gates, the DSN, the seal and the ONE client, in that order — see `openManagedExecutor`. A
    // gate refusal ends the process before a client exists; a throw lands in the catch below with
    // no handle to dispose.
    handle = await openManagedExecutor(op);
    await handle.adapter.reserve('session');

    // Signal class C (live fingerprint). It can only run AFTER a connection exists, which is
    // precisely why NO mutation may be attempted before it passes — the static and endpoint
    // classes cannot tell two databases of the same shape apart.
    const fingerprint = await verifyManagedDevFingerprint(handle.catalog, {
      requiredAuditActions: REQUIRED_AUDIT_ACTIONS,
      activeSystemOwners: EXPECTED_ACTIVE_SYSTEM_OWNERS,
      suspendedSystemOwners: EXPECTED_SUSPENDED_SYSTEM_OWNERS,
    });
    if (fingerprint.length > 0) {
      console.error(`[migrate] managed fingerprint failures: ${fingerprint.length}`);
      refusal = `${op} refused: the live database is not the expected DEV target. NOTHING was mutated.`;
    } else {
      console.log('[migrate] managed target: live DEV fingerprint OK');
      const pairs = discoverPairs();

      if (op === 'status') {
        const read = await runTrustedLedgerRead({
          adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session', deadlineMs: OPERATION_DEADLINE_MS,
        });
        // A FAILED read also returns rows: [] — indistinguishable from a genuinely empty ledger.
        // Using it would report every migration as pending on a database that may be fully
        // migrated, which is exactly the input that would invite a destructive "recovery".
        if (read.outcome !== 'complete') {
          refusal = `status could not read the ledger: ${read.code ?? 'unknown'}`;
        } else {
          for (const st of computeStatus(pairs, read.rows)) {
            console.log(`  version=${st.version}  state=${st.state}  ledger=${st.ledgerChecksum === null ? 'none' : 'recorded'}`);
          }
        }
      } else if (op === 'baseline') {
        // The operator must still name the versions, AND they must equal the authorized prefix.
        // The pure planner would accept any in-order prefix; this path accepts exactly one. The argv
        // is the process port's — the real `process.argv` in production.
        const allowlist = (getOpt('--baseline-versions', process.argv.slice(2)) ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '');
        if (allowlist.join(',') !== AUTHORIZED_BASELINE_PREFIX.join(',')) {
          refusal =
            `baseline on the managed recovery path requires --baseline-versions=${AUTHORIZED_BASELINE_PREFIX.join(',')} exactly ` +
            `(005 is PENDING and must be executed, never adopted)`;
        } else {
          const read = await runTrustedLedgerRead({
            adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session', deadlineMs: OPERATION_DEADLINE_MS,
          });
          // Same trap as status: a failed read is an EMPTY row set, and "empty ledger" is the
          // precondition baseline is looking for. Refuse rather than plan on a failure.
          // A bare Error discarded a bounded code the read had ALREADY produced, and the catch
          // below — whose exact shape is pinned by an existing source-integrity contract this
          // stage may not edit — keys on the executor error type. Converting here preserves the
          // code without touching that shape.
          if (read.outcome !== 'complete') throw boundedExecutorError(read.code, 'ledger unreadable');
          const plan = planBaseline(pairs, read.rows, allowlist);
          const report = await runTrustedHistoricalBaseline({
            adapter: handle.adapter, ledger: handle.ledger, catalog: handle.catalog, write: handle.write,
            connectionMode: 'session', deadlineMs: OPERATION_DEADLINE_MS, lockKey: RUN_LOCK_KEY,
            plan, now: () => new Date().toISOString(),
          });
          console.log(
            `[migrate] baseline: outcome=${report.outcome} adopted=${report.adopted.join(',') || 'none'} ` +
              `commit=${report.commit} disposal=${report.disposal} code=${report.code ?? 'none'}`,
          );
          for (const d of report.detail) console.error(`  - ${d}`);
          if (report.commit === 'unknown') {
            // The one outcome a bare code renders dangerously. `baseline did not complete: <code>`
            // reads as "nothing happened", and that reading is exactly what invites a re-run — while
            // the database may already hold the adopted prefix. Stated first and in operational
            // terms; still non-zero, and nothing is retried or reconnected automatically.
            refusal =
              'baseline COMMIT OUTCOME IS UNKNOWN — the transaction may or may not have committed. ' +
              'Do NOT re-run baseline. Do NOT run apply/migration 005. ' +
              'Verify the authoritative ledger state before any continuation';
          } else if (report.commit === 'committed' && (report.outcome !== 'complete' || report.code !== null)) {
            // BRANCH ON THE EVIDENCE, NOT THE OUTCOME. The executor deliberately returns
            // `failed` + `commit: 'committed'` + `adopted` for a post-commit read-back failure or
            // mismatch, precisely so the operator is not told "nothing happened" about a write
            // that landed. Testing `outcome !== 'complete'` first would reintroduce exactly that
            // mis-report and send them to re-run it.
            refusal =
              `baseline ADOPTED ${report.adopted.join(',') || 'the prefix'} — the transaction COMMITTED — ` +
              `but the run did not finish cleanly: ${report.code ?? 'unknown'}. Do NOT re-run baseline`;
          } else if (report.outcome !== 'complete') {
            refusal = `baseline did not complete: ${report.code ?? 'unknown'}`;
          } else if (report.code !== null) {
            // A COMPLETE adoption that still carries a code did not finish CLEANLY — today that
            // means its run advisory lock was not verifiably released. Exiting 0 here would present
            // a session whose lock ownership is unbalanced or unknown as a clean success, and this
            // CLI is the only thing that spans the baseline and apply phases (they are separate
            // processes), so it is the only place that state can be surfaced to the operator.
            refusal =
              `baseline adopted ${report.adopted.join(',')} but did not finish cleanly: ${report.code}. ` +
              `The adoption COMMITTED — do NOT re-run`;
          }
          // Identical in meaning to the apply branch below: 'none' means termination was ATTEMPTED
          // and not established, so the session-scoped lock's release is neither proven released
          // nor provably still held. Appended, never replacing the primary refusal.
          if (report.disposal === 'none') {
            // NAMED `closureResidual`, not `cleanup`: the outer `cleanup` is the terminal record's
            // own field, set from the teardown in the `finally`. Two unrelated meanings under one
            // identifier in one function is how a later edit reaches for the wrong one.
            const closureResidual =
              'session closure NOT ESTABLISHED — session-level advisory-lock release is UNKNOWN. ' +
              'Verify state before any continuation; nothing is retried and no second connection is opened automatically.';
            refusal = refusal === null ? `baseline: ${closureResidual}` : `${refusal}. ${closureResidual}`;
          }
        }
      } else {
        // APPLY. Re-read the ledger and re-plan, then refuse unless the computed set is EXACTLY
        // the one authorized version. A later 006 appearing in discovery must stop the run
        // rather than ride along on a plan computed for 005.
        const read = await runTrustedLedgerRead({
          adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session', deadlineMs: OPERATION_DEADLINE_MS,
        });
        if (read.outcome !== 'complete') throw boundedExecutorError(read.code, 'ledger unreadable');
        // `planApply` throws a MigrationEngineError, which the catch below cannot tell from an
        // arbitrary throw — so `unresolved_dirty_attempt`, the follow-on state of exactly the
        // durable dirty marker this stage exists to disclose, surfaced as the operator-GATE code.
        // Converted here, allowlisted, so the operator can tell it from a validation failure.
        let planned: string[];
        try {
          planned = planApply(pairs, read.rows).pending.map((p) => p.version);
        } catch (e) {
          throw boundedExecutorError(
            e !== null && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined,
            'apply plan refused',
          );
        }
        // NON-AUTHORITATIVE PREFLIGHT. This read is unserialized, so it can only fail fast and
        // report — it authorizes nothing. The binding check runs under the run lock inside the
        // trusted runner (executionPolicy below), against the program that will actually execute.
        assertExactManagedApplyPlan(planned, AUTHORIZED_APPLY_VERSION);
        console.log(`[migrate] managed apply preflight (advisory): plan is exactly [${AUTHORIZED_APPLY_VERSION}]`);
        const fsPort = createNodeFsPort(MIGRATIONS_DIR, MIGRATIONS_REL);
        const report = await runTrustedApply({
          adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session', deadlineMs: OPERATION_DEADLINE_MS,
          fsPort,
          credential: { purpose: 'migration', migratorRef: MIGRATOR_REF, runtimeRef: RUNTIME_REF },
          lockKey: RUN_LOCK_KEY,
          now: () => new Date().toISOString(),
          // THE authoritative gate. Same ledger port and same discovery source, re-derived with the
          // lock held and bound to the frozen program's own execution versions. C2B-M005-B0 widens
          // it: the ledger RELATION and the migration ARTIFACT are re-derived under the lock too,
          // so a file swapped after the pre-lock discovery is refused rather than executed and then
          // recorded under a checksum computed from the swapped bytes.
          executionPolicy: createManagedM005Policy({
            ledger: handle.ledger,
            catalog: handle.catalog,
            fsPort,
          }),
          // C2B-M005-B1-R1 — pre-COMMIT, on the same pinned session, inside the still-open bracket.
          // This is the gate that can still PREVENT the mutation; the post-commit one below can
          // only refuse to call a durable mutation verified. Supplying it is not optional on this
          // path: the executor refuses the exact-005 program outright when it is absent.
          preCommitPolicy: createM005PreCommitPolicy({ catalog: handle.catalog }),
          // C2B-M005-B0 — post-COMMIT, on the same pinned session, before the verified unlock.
          postCommitPolicy: createM005PostCommitPolicy({
            ledger: handle.ledger,
            catalog: handle.catalog,
            fsPort,
          }),
        });
        const commitOutcome = applyCommitOutcome(report.commit);
        // FINALIZED, NOT APPLIED. C2B-M005-B1-R1 made a new state reachable: the tx-scoped finalize
        // runs INSIDE the bracket, one effect before the pre-commit gate, so a gate refusal leaves
        // `report.applied` holding a version whose transaction was then abandoned. Printing that as
        // `applied=1` told an operator the opposite of what happened. The word now matches the
        // field's actual meaning, and `mutation=` below says where the mutation really stands.
        console.log(
          `[migrate] ${op}: outcome=${report.outcome} finalized=${report.applied.length} ` +
            `disposal=${report.disposal} code=${report.code ?? 'none'}`,
        );
        // COMMIT ATTEMPT AND ROLLBACK OBSERVABILITY, STATED RATHER THAN IMPLIED (C2B-M005-B1-R2).
        // A pre-commit refusal must say plainly that COMMIT was never submitted, and no line here
        // may leave an operator to infer a rollback: this path submits no ROLLBACK and observes
        // none, so the field is a constant that is always true rather than a value that could
        // one day be read as evidence of one.
        console.log(
          `[migrate] ${op} mutation: ${classifyApplyMutationState(report)} ` +
            `commit_attempted=${report.commit.submitted} rollback_observed=false`,
        );
        // THE LEDGER LINE (C2B-M005-B1-R3), separate from the mutation line on purpose.
        //
        // `commit_attempted=false` above speaks ONLY for the migration transaction. The dirty
        // marker is written in its own transaction BEFORE that bracket opens, so a pre-commit
        // refusal leaves a committed ledger mutation behind while every other line correctly says
        // the migration did not commit. Without this line the record read as "nothing landed",
        // and the operator's natural next action — re-run — is the one the planner will refuse.
        const marker = classifyLedgerMarker(report);
        console.log(
          `[migrate] ${op} ledger: version=${AUTHORIZED_APPLY_VERSION} marker=${marker} ` +
            `markerWrite=${report.dirtyMarkerWrite} ` +
            `cleanVerified=${marker === 'clean_verified'} ` +
            `ddlMayHaveCommitted=${report.commit.submitted}`,
        );
        // THE EVIDENCE LINE, separate from the outcome line on purpose: an operator deciding
        // whether a re-run is safe needs the commit states, not a single word that averages them.
        console.log(
          `[migrate] ${op} evidence: commit=${commitOutcome} submitted=${report.commit.submitted} ` +
            `resolved=${report.commit.resolved} acknowledged=${report.commit.acknowledged} ` +
            `readBack=${report.commit.readBackVerified} lockRelease=${report.lockRelease}`,
        );
        // THE VERDICT IS A PURE FUNCTION, not a ladder inline here. It used to be inline, and the
        // only thing asserting it was a regex over this file's own text — which cannot see ORDERING,
        // and ordering is the contract: an UNDETERMINED commit must outrank a plain failure or it
        // renders as "did not complete" and reads as "nothing happened".
        applyEvidence = report;
        // The 'disposal === none' warning is NOT appended here any more. The `finally` below
        // reassigns `refusal` from `classifyManagedApplyRefusal`, which discarded anything set at
        // this point; the disposal is now part of that function's evidence instead, so the verdict
        // is genuinely total rather than total-looking.
      }
    }
  } catch (err) {
    threw = true;
    const code = err instanceof MigrationExecutorError ? err.code : PG_VALIDATION_REQUIRED;
    refusal = `${op} refused before completion: ${code}.`;
  } finally {
    // C2B-M005-B0 — THE TEARDOWN RESULT IS NO LONGER DISCARDED.
    //
    // `handle.dispose()` used to route through a bare `.catch(() => {})`, so on the SUCCESS path a
    // client that failed to shut down produced exit 0 with a clean-looking record — for a backend
    // that may still have been alive. It is requested exactly ONCE (postgres.js caches its shutdown
    // promise, so a retry would only re-await a settled rejection), it still never throws, and its
    // failure is now a refusal.
    //
    // WHAT IT IS NOT: evidence about the socket. `end({timeout:0})` destroys rather than drains, so
    // `completed` says the REQUEST finished, never that a graceful close was observed. The
    // no-live-child guarantee is process exit plus an empty process group and session, established
    // by the launcher — not by this line.
    if (handle !== null) {
      const teardown = await handle.dispose();
      console.log(
        `[migrate] ${op} teardown: requested=${teardown.requested} completed=${teardown.completed} ` +
          `gracefulSocketClose=${teardown.gracefulSocketClose} code=${teardown.code ?? 'none'}`,
      );
      // THE SAME TWO FACTS THE LINE ABOVE JUST PRINTED, carried to the terminal record so the pair
      // can be cross-checked by a reader that trusts neither line on its own. Nothing is recomputed:
      // a second derivation could disagree with the record it is supposed to corroborate.
      cleanup = teardown.completed ? 'completed' : 'failed';
      // THE CODE IS BOUNDED HERE, not merely believed to be bounded. `TeardownResult.code` is typed
      // `string | null`, so the type alone permits any string; the two values below are what its
      // single producer can actually return, and pinning them is what makes this record's "finite
      // vocabulary" claim true rather than incidental. Anything else is refused rather than
      // forwarded: the substituted token is outside the launcher's declared code domain, so the
      // whole record fails to canonicalise and the run reports no completion evidence at all —
      // which is the correct answer for a teardown outcome this file does not understand.
      const observed = teardown.code ?? 'none';
      cleanupCode = observed === 'none' || observed === 'client_teardown_failed'
        ? observed
        : 'teardown_code_unrecognized';
      // ONE call, with ALL the evidence. The teardown is only knowable here, after the finally has
      // run, so the verdict is computed once at the end rather than assembled in two places.
      if (applyEvidence !== null) {
        refusal = classifyManagedApplyRefusal(op, {
          ...applyEvidence,
          // Derived HERE from the same evidence the ledger line printed, so the verdict and the
          // record cannot disagree, and so the clause is not optional for this caller.
          ledgerMarker: classifyLedgerMarker(applyEvidence),
          teardown,
        });
      } else if (!teardown.completed) {
        // A non-apply managed op (status, baseline) still must not exit 0 on an unproved teardown.
        const t =
          `client teardown NOT ESTABLISHED (${teardown.code ?? 'unknown'}) — the managed connection `
          + 'was not proved shut down; nothing is retried and no second connection is opened automatically.';
        refusal = refusal === null ? `${op}: ${t}` : `${refusal}. ${t}`;
      }
    }
  }

  // ---- C2B-M005-LRLS-L3-R4-R2: THE POST-DECISION TERMINAL RECORD -------------
  //
  // WHAT IT CLOSES. The teardown record above is emitted at the CLEANUP boundary, and until now it
  // was the last thing this path wrote to stdout on a successful run. That made it the strongest
  // completion evidence available to the launcher — and it is not strong enough: everything that
  // decides whether this run SUCCEEDED still happened after it. A Linux realtime signal (34, 40, 64)
  // delivered in that window destroys the process reporting `exit=0 signal=null`, which no field
  // Node exposes can tell apart from a clean return. The launcher then saw a valid post-cleanup
  // record and a zero exit, and called it OK.
  //
  // THE ORDERING IS THE WHOLE CONTRACT, and it is the reason the refusal is applied INLINE here
  // rather than through `refuse()`:
  //   1. the managed execution has returned or thrown into `refusal` (the try/catch above);
  //   2. `handle.dispose()` has completed or failed and been reported (the finally above);
  //   3. the final verdict is fixed — nothing below reassigns `refusal`;
  //   4. the process exit classification is ASSIGNED below, before the record;
  //   5. the last existing report on either stream — the `REFUSED:` line — is written below,
  //      before the record.
  // After the record this function does nothing but return. No decision, no refusal application,
  // no cleanup, no database, lock or migration operation, and no further write to either stream.
  //
  // `refuse()` cannot be used here because it ends the process from inside itself: the record could
  // then only be emitted BEFORE the refusal was applied, which is the window this exists to close.
  // Its two effects are reproduced exactly — the identical stderr line, the identical exit code —
  // with the exit ASSIGNED rather than forced. `process.exitCode` is what every other deferred
  // failure in this file already uses (see `main()` and the top-level catch), and unlike
  // `process.exit()` it cannot truncate a record that is still flushing to a pipe.
  const decision = threw ? 'failed' : refusal === null ? 'success' : 'refused';
  // THE EXIT CLASS IS DERIVED FROM THE DECISION, not independently from `refusal`.
  //
  // Deriving them separately made one tuple EXPRESSIBLE that the child declares impossible — a run
  // that threw but whose refusal was later cleared would have printed `decision=failed exit=success`
  // and exited 0. It is unreachable only because `applyEvidence = report` is the last statement of
  // the apply branch and nothing after it can throw: an invariant of statement PLACEMENT, which the
  // next edit to that branch could silently break. One derivation cannot disagree with itself.
  const exitClass = decision === 'success' ? 'success' : 'failure';
  const exitCode = decision === 'success' ? 0 : PG_VALIDATION_EXIT;
  if (refusal !== null) console.error(`[migrate] REFUSED: ${refusal}`);
  process.exitCode = exitCode;
  // ONE WRITE, FIXED FIELDS, FINITE VOCABULARY. Every value is drawn from a closed set decided in
  // this file; no message, error text, host, identifier, filename, SQL or provider response can
  // reach it.
  //
  // THE CALLBACK IS THE PROCESS'S OWN COMPLETION, and it is why a refusal still ends the process
  // AT ONCE. `refuse()` used to do that with `process.exit`, which cannot be used here — it would
  // have to run before the record, which is the window this record exists to close. Merely
  // assigning `process.exitCode` is not equivalent either: `handle.dispose()` reports a FAILED
  // teardown by catching the driver's rejection, so the socket it could not close can keep the
  // event loop alive — on exactly the branch that produces the refusal. The child would then hang
  // until the launcher's timeout killed it, turning a clean `child_refused` record into a forced
  // termination. Writing the record with a completion callback keeps both: the record is flushed
  // to the pipe FIRST (an explicit `process.exit` can truncate an unflushed pipe write), and the
  // process then ends immediately, exactly as before. Nothing else remains — the success path has
  // no callback work at all and returns as it always did.
  process.stdout.write(
    `[migrate] ${op} terminal: decision=${decision} cleanup=${cleanup} `
      + `exit=${exitClass} code=${cleanupCode}\n`,
    // THE CALLBACK'S ERROR ARGUMENT IS IGNORED DELIBERATELY, not overlooked. It fires with an error
    // when stdout is already broken — the parent is gone or the pipe was destroyed — and there is
    // nothing to do with that fact: the record cannot reach a reader that no longer exists, and
    // stderr is no more trustworthy than stdout at that moment. What must still happen is the exit
    // code, and it does: measured against a destroyed stdout, the callback still fires and the
    // process still ends with the refusal's code rather than hanging.
    //
    // ON THE SUCCESS PATH A LOST WRITE MUST NOT BECOME A FAILURE. `decision === 'success'` means the
    // migration completed cleanly, so exit 0 is TRUE even if the operator's own pipe closed before
    // the line landed; turning a broken pipe into a non-zero exit would report a failed migration
    // for a run that succeeded, which is a worse lie than a missing line. What is lost is the
    // EVIDENCE, and evidence is the parent's question: the launcher reads its own capture and
    // refuses a run whose record never arrived, which is where "no evidence" belongs.
    () => { if (exitCode !== 0) process.exit(exitCode); },
  );
}

/**
 * The ONLY port set with real effects: the gated open, the real trusted runners, and the real
 * `console` and `process` — so production executes exactly what it executed before the seam existed.
 * Module-private, and passed by `main()` alone.
 */
const PRODUCTION_MANAGED_PORTS: ManagedRunPorts = Object.freeze({
  openManagedExecutor,
  runTrustedHistoricalBaseline,
  runTrustedApply,
  console,
  process,
});

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

/**
 * The managed apply DIRECTION gate, at the CLI seam.
 *
 * The managed C2B recovery authority is "apply migration 005 FORWARD, exactly once". A managed
 * DOWN is not a narrower version of that — it would drop the objects 005 creates — so it is
 * refused outright rather than gated. The refusal is a pure argv computation: it needs no DSN, no
 * client, and no database, which is what lets it run before anything connects.
 *
 * The disposable/local route below keeps its DOWN semantics untouched; this function is reached
 * only under --managed-dev.
 */
/**
 * EVERY `--direction` token in argv, in order — deliberately NOT `getOpt`.
 *
 * `getOpt` is first-wins and collapses two distinct shapes to `undefined`: "no --direction at
 * all" and "a --direction whose value is missing". On the managed path those must be told apart,
 * and a repeated `--direction=up --direction=down` must not silently resolve to the first token.
 * A valueless `--direction` yields '' here, which the resolver refuses.
 */
function managedDirectionTokens(): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--direction=')) out.push(a.slice('--direction='.length));
    else if (a === '--direction') out.push(i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : '');
  }
  return out;
}

function managedApplyDirectionOrRefuse(): 'up' {
  try {
    return resolveManagedApplyDirection(managedDirectionTokens(), hasFlag('--down'));
  } catch (err) {
    const code = err instanceof MigrationExecutorError ? err.code : PG_VALIDATION_REQUIRED;
    refuse(
      `${code} — the managed recovery path applies migrations FORWARD only; a reverse direction ` +
        `is not an authorized managed apply. No database connection was attempted.`,
      PG_VALIDATION_EXIT,
    );
  }
}

async function main(): Promise<void> {
  // Database-REQUIRING operations fail closed FIRST — before --direction validation or any
  // connection string is read — so a malformed argument can never mask the fail-closed gate.
  //
  // C2B-R2: the MANAGED route is selected only by an explicit flag, and it is a DIFFERENT
  // function with a different target validator. The disposable route below is untouched.
  if (wantManagedDev) {
    // DIRECTION is settled HERE, at the dispatch, before runThroughManagedExecutor is entered —
    // so a DOWN request is refused ahead of the operator gates, the DSN read, the client, the live
    // fingerprint, the advisory lock, and every ledger write or migration statement. It is a
    // SEPARATE invariant from the exact-[005] version gate, which constrains WHICH migration may
    // run and says nothing about which way. Because the resolver can only ever return 'up', the
    // op label below cannot describe a DOWN request as a permitted apply.
    if (wantApply) return runThroughManagedExecutor(`apply(${managedApplyDirectionOrRefuse()})`, PRODUCTION_MANAGED_PORTS);
    if (wantBaseline) return runThroughManagedExecutor('baseline', PRODUCTION_MANAGED_PORTS);
    if (wantStatus) return runThroughManagedExecutor('status', PRODUCTION_MANAGED_PORTS);
    refuse(`${OPERATOR_GATE_UNSATISFIED} — --managed-dev supports only --status, --baseline and --apply.`, PG_VALIDATION_EXIT);
  }
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

/**
 * C2B-R3B-B0-R1 — the ONE code an unexpected MANAGED-path failure may ever render as.
 *
 * Expected refusal and execution states already map to bounded codes inside
 * `runThroughManagedExecutor`; this covers everything that did NOT go through them.
 */
const MANAGED_RUN_FAILURE = 'migration_managed_run_failed';

/**
 * ENTRY GUARD — importing this module must run nothing.
 *
 * `sealBreakage` above is exported so the seal's decision can be proved in-process rather than by
 * running this CLI as a child against a manipulated environment. Without this guard that import
 * would EXECUTE `main()`, which for an empty argv performs the DB-free listing — harmless, but it
 * would mean a test file could not touch this module without running it, and a future change to the
 * default mode would silently become a test side effect.
 *
 * Measured, not assumed: under both `node node_modules/tsx/dist/cli.mjs <script>` (the launcher's
 * shape) and `node_modules/.bin/tsx <script>` (the runner's shape), `process.argv[1]` is the script
 * path and `import.meta.url` is that same path's file URL, so the CLI still runs exactly as before.
 */
const IS_CLI_ENTRY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

// The top-level promise is handled explicitly. Every reachable failure inside main() is already
// funnelled into a bounded refusal, but that is discipline, not a guarantee — and Node's default
// unhandled-rejection handler prints the FULL error object, message and stack, which is exactly
// the leak this file's banner promises to prevent.
if (IS_CLI_ENTRY) main().catch((err) => {
  if (managedRun) {
    // NO MESSAGE, NO STACK, NO SERIALIZED ERROR, NO ARGV, NO ENVIRONMENT VALUE.
    //
    // On the managed historical-baseline path the likeliest unexpected throw is a driver error, and
    // a postgres.js connection failure puts the host, port, user and — depending on the failure —
    // the whole connection string into `err.message`. Printing it here reached the operator record
    // BEFORE any parent redactor could see it only because the parent captures the child's streams;
    // relying on that made the parent's redaction load-bearing rather than defence in depth. One
    // fixed code cannot carry a value, so this path cannot disclose one at all. The parent's
    // capture-and-redact still runs, and is now genuinely a second layer.
    console.error(`[migrate] FATAL: ${MANAGED_RUN_FAILURE}`);
    process.exitCode = 1;
    return;
  }
  const message = err instanceof Error ? err.message : 'unknown error';
  console.error(`[migrate] FATAL: ${message}`);
  process.exitCode = 1;
});
