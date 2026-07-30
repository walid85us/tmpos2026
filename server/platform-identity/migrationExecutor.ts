// Phase 4.0 M3 S1b — TRUSTED migration executor.
//
// The S1 kernel (migrationEngine.ts) is pure and database-free: it prescribes an ordered
// program of inert effects and never performs one. THIS module is the only place that turns
// those effects into real PostgreSQL work, and it is deliberately NOT reachable from the
// production application server (see tests/quality/migration-executor-containment.test.mjs).
//
// SAFETY BOUNDARY. The executor connects to exactly one class of database: a DISPOSABLE
// PostgreSQL instance named `tmpos_s1b_*`, reached over a task-owned Unix socket or a
// loopback address, supplied ONLY through TM_POS_TEST_DATABASE_URL. Ambient application and
// provider DSNs (DATABASE_URL / SUPABASE_DATABASE_URL / APP_DATABASE_URL) are never read —
// not preferred-against, not fallen back to, simply never consulted. The validated DSN never
// leaves this module: the raw string is held in a module-private WeakMap so no caller, log
// line, error message, or serialized report can reach it.

import { createHash } from 'crypto';
import { tmpdir } from 'os';

import {
  ENGINE_CODES,
  assertLedgerTimestamp,
  discoverMigrations,
  pairMigrations,
  planApply,
  startMigrationExecution,
  stepMigrationExecution,
  type ApplyPlan,
  type BackendIdentity,
  type ConnectionMode,
  type CredentialClassification,
  type ExecutionDisposition,
  type ExecutionEffect,
  type ExecutionEvent,
  type ExecutionOutcome,
  type KernelResult,
  type LedgerRow,
  type MigrationFsPort,
  type MigrationPair,
  type TransactionMode,
} from './migrationEngine';

// ---------------------------------------------------------------------------
// bounded reason codes
// ---------------------------------------------------------------------------

export const EXECUTOR_CODES = {
  TEST_DSN_MISSING: 'test_dsn_missing',
  TEST_DSN_INVALID: 'test_dsn_invalid',
  TEST_DSN_HOST_NOT_LOCAL: 'test_dsn_host_not_local',
  TEST_DSN_DATABASE_NOT_DISPOSABLE: 'test_dsn_database_not_disposable',
  TEST_DSN_POOL_MODE_REJECTED: 'test_dsn_pool_mode_rejected',
  ARTIFACT_BINDING_MISMATCH: 'executor_artifact_binding_mismatch',
  /** A `transaction: forbidden` migration whose file holds more than one statement. */
  FORBIDDEN_MODE_MULTI_STATEMENT: 'executor_forbidden_mode_multi_statement',
  PORT_FAILED: 'executor_port_failed',
  DISPOSAL_FAILED: 'executor_disposal_failed',
  UNSUPPORTED_EFFECT: 'executor_unsupported_effect',
} as const;

export type ExecutorCode = (typeof EXECUTOR_CODES)[keyof typeof EXECUTOR_CODES];

/**
 * A bounded, secret-safe executor error. The message is built ONLY from the stable code and an
 * optional short printable label the executor itself chose — never from a driver error, a DSN,
 * a credential, SQL text, or a stack. This is the single error type that crosses the boundary.
 */
export class MigrationExecutorError extends Error {
  readonly code: ExecutorCode;
  constructor(code: ExecutorCode, label = '') {
    const safeLabel = typeof label === 'string' ? label.replace(/[^\x20-\x7e]/g, '').slice(0, 80) : '';
    super(safeLabel ? `${code}: ${safeLabel}` : code);
    this.name = 'MigrationExecutorError';
    this.code = code;
  }
}

const fail = (code: ExecutorCode, label = ''): never => {
  throw new MigrationExecutorError(code, label);
};

// ---------------------------------------------------------------------------
// the disposable-test DSN
// ---------------------------------------------------------------------------

/** The ONLY environment variable this module ever reads for a connection target. */
export const TEST_DSN_VAR = 'TM_POS_TEST_DATABASE_URL';

/** Every disposable database this executor may touch carries this prefix. */
export const DISPOSABLE_DB_PREFIX = 'tmpos_s1b_';

export type DsnHostKind = 'unix_socket' | 'loopback';

/** Validated handle. It carries NO credential and NO host — only the two facts that are safe
 *  to print. The raw connection string stays in a module-private map, unreachable by callers. */
export interface DisposableTestDsn {
  readonly kind: 'disposable_test_dsn';
  readonly hostKind: DsnHostKind;
  readonly database: string;
}

/** DRIVER-SAFE DSN, keyed by handle. Module-private: there is no exported reader.
 *
 *  `host` and `user` are libpq TRANSPORT parameters, but a JavaScript driver forwards any query
 *  parameter it does not recognise to the server as a startup setting — and PostgreSQL then
 *  refuses the connection with `unrecognized configuration parameter "host"`. They are therefore
 *  stripped here and re-supplied through the driver's own options instead. */
const RAW_DSN = new WeakMap<DisposableTestDsn, string>();
/** Unix socket DIRECTORY for socket-form handles. `?host=` is libpq's way of naming a socket
 *  directory, but a URL parser reads it as an ordinary query parameter and the driver takes its
 *  connection host from the URL's host field — so the adapter must hand the path over
 *  explicitly rather than assume the URL alone carries it. */
const SOCKET_DIR = new WeakMap<DisposableTestDsn, string>();
/** Explicit role for the connection. Without it the driver falls back to an AMBIENT PGUSER /
 *  PGUSERNAME, which would silently authenticate as a different principal than the one the
 *  disposable target was created for. */
const DSN_USER = new WeakMap<DisposableTestDsn, string>();

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Ports whose only conventional meaning is a TRANSACTION-mode pooler, which cannot hold a
 *  session advisory lock across statements and therefore can never run a migration. */
const TRANSACTION_POOL_PORTS = new Set(['6543']);
/** Query parameters that declare pooling; any of them disqualifies the migrator DSN. */
const POOL_PARAMS: ReadonlyArray<[string, (v: string) => boolean]> = [
  ['pgbouncer', (v) => v !== 'false'],
  ['pool_mode', (v) => v !== 'session'],
];

/**
 * Validate a raw connection string into a disposable-test handle, or refuse with a bounded
 * code. Checks run host → database → pool mode, so the most dangerous property (reaching a
 * machine that is not this task's) is decided first and no later check can mask it.
 */
export function assertDisposableTestDsn(raw: unknown): DisposableTestDsn {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fail(EXECUTOR_CODES.TEST_DSN_MISSING, TEST_DSN_VAR);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // The unparsable value is NOT echoed — it is a connection string.
    return fail(EXECUTOR_CODES.TEST_DSN_INVALID, 'not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return fail(EXECUTOR_CODES.TEST_DSN_INVALID, 'scheme must be postgres');
  }

  // --- host: a task-owned Unix socket, or loopback. Nothing else, ever. ---
  const socketDir = url.searchParams.get('host') ?? '';
  let hostKind: DsnHostKind;
  if (url.hostname === '') {
    // libpq socket form: postgres:///db?host=/abs/socket/dir
    if (!socketDir.startsWith('/')) return fail(EXECUTOR_CODES.TEST_DSN_HOST_NOT_LOCAL, 'no host and no socket directory');
    // "Absolute path" is not the same as "task-owned". A system-wide socket directory such as
    // /var/run/postgresql is absolute too, and would point this executor at a standing local
    // cluster. A disposable cluster lives under the temp root by construction, so that is the
    // confinement actually required.
    const tempRoot = tmpdir();
    if (!socketDir.startsWith(`${tempRoot}/`) && socketDir !== tempRoot) {
      return fail(EXECUTOR_CODES.TEST_DSN_HOST_NOT_LOCAL, 'socket directory is not under the temp root');
    }
    hostKind = 'unix_socket';
  } else if (LOOPBACK_HOSTS.has(url.hostname)) {
    hostKind = 'loopback';
  } else {
    // An allowlist, not a denylist: a managed provider, pooler, VPC address, or any other
    // remote endpoint fails here by construction rather than by matching a known name.
    return fail(EXECUTOR_CODES.TEST_DSN_HOST_NOT_LOCAL, 'only a task socket or loopback is accepted');
  }

  // --- database: disposable by name ---
  // decodeURIComponent throws a RAW URIError on malformed percent-encoding. That error would
  // cross this boundary carrying caller-controlled text, so it is converted to a bounded code.
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return fail(EXECUTOR_CODES.TEST_DSN_INVALID, 'malformed percent-encoding in database name');
  }
  if (!database.startsWith(DISPOSABLE_DB_PREFIX)) {
    return fail(EXECUTOR_CODES.TEST_DSN_DATABASE_NOT_DISPOSABLE, `database must begin ${DISPOSABLE_DB_PREFIX}`);
  }

  // --- pool mode: a transaction pooler cannot hold a session advisory lock ---
  if (url.port !== '' && TRANSACTION_POOL_PORTS.has(url.port)) {
    return fail(EXECUTOR_CODES.TEST_DSN_POOL_MODE_REJECTED, 'transaction-pooler port');
  }
  for (const [param, isPooled] of POOL_PARAMS) {
    const v = url.searchParams.get(param);
    if (v !== null && isPooled(v)) return fail(EXECUTOR_CODES.TEST_DSN_POOL_MODE_REJECTED, `${param} declares pooling`);
  }

  const handle: DisposableTestDsn = Object.freeze({ kind: 'disposable_test_dsn' as const, hostKind, database });
  const driverUrl = new URL(raw.trim());
  driverUrl.searchParams.delete('host');
  driverUrl.searchParams.delete('user');
  RAW_DSN.set(handle, driverUrl.toString());
  if (hostKind === 'unix_socket') SOCKET_DIR.set(handle, socketDir);
  // The socket URI form carries no userinfo, so the role travels as a `user` parameter.
  let declaredUser: string;
  try {
    declaredUser = url.username !== '' ? decodeURIComponent(url.username) : (url.searchParams.get('user') ?? '');
  } catch {
    return fail(EXECUTOR_CODES.TEST_DSN_INVALID, 'malformed percent-encoding in user');
  }
  if (declaredUser !== '') DSN_USER.set(handle, declaredUser);
  return handle;
}

/**
 * Resolve the disposable-test DSN from an environment object. Reads exactly ONE key. Ambient
 * application/provider DSNs present in the same object are never consulted, so a machine that
 * happens to export a production connection string cannot supply this executor by accident.
 */
export function resolveDisposableTestDsn(env: Readonly<Record<string, string | undefined>>): DisposableTestDsn {
  const raw = env === null || typeof env !== 'object' ? undefined : env[TEST_DSN_VAR];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fail(EXECUTOR_CODES.TEST_DSN_MISSING, `${TEST_DSN_VAR} is not set`);
  }
  return assertDisposableTestDsn(raw);
}

/** The ONLY description of a DSN that may be printed: host CLASS and disposable database name.
 *  Never the user, password, host, port, or the string itself. */
export function describeDsn(dsn: DisposableTestDsn): { hostKind: DsnHostKind; database: string } {
  return { hostKind: dsn.hostKind, database: dsn.database };
}

/**
 * Count TOP-LEVEL statements in a SQL script, ignoring semicolons inside line comments, block
 * comments, single-quoted literals, double-quoted identifiers, and dollar-quoted bodies.
 *
 * It is deliberately CONSERVATIVE: anything it cannot confidently interpret (an unterminated
 * quote or comment) counts as more than one statement, so an ambiguous script is refused rather
 * than executed under an assumption. Miscounting can only ever cause a refusal, never a wrong
 * execution.
 */
export function countSqlStatements(sql: string): number {
  let i = 0;
  let statements = 0;
  let sawContent = false;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      // PostgreSQL block comments NEST, so depth must be tracked rather than scanning to the
      // first close.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      if (depth > 0) return 2; // unterminated: refuse
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; } // doubled quote is an escape
          i += 1; closed = true; break;
        }
        i += 1;
      }
      if (!closed) return 2; // unterminated: refuse
      sawContent = true;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*\$|^\$\$/.exec(sql.slice(i));
      if (tag !== null) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        if (end === -1) return 2; // unterminated dollar quote: refuse
        i = end + marker.length;
        sawContent = true;
        continue;
      }
    }
    if (ch === ';') {
      if (sawContent) statements += 1;
      sawContent = false;
      i += 1;
      continue;
    }
    if (!/\s/.test(ch)) sawContent = true;
    i += 1;
  }
  if (sawContent) statements += 1; // trailing statement with no terminating semicolon
  return statements;
}

/** SHA-256 hex of a UTF-8 string — used to re-bind executed SQL to its declared checksum. */
export function sha256Utf8(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// executor ports
//
// These are STEPWISE by necessity. The kernel prescribes `open_tx`, `execute`, `finalize`
// and `commit_tx` as four separate effects, so a callback-scoped `begin(fn)` port could not
// be driven by it without inverting control and hiding the boundary the kernel exists to
// make explicit. Everything still runs on the ONE reserved session.
// ---------------------------------------------------------------------------

export interface ExecutorSession {
  /** A real round-trip proving the reserved session is alive and answering. */
  confirmLive(): Promise<void>;
  /** The backend's own identity (pg_backend_pid), read fresh each time. */
  backendIdentity(): Promise<BackendIdentity>;
  /** SESSION-scoped advisory lock, bounded (try / timeout) — never an unbounded wait. */
  acquireRunLock(key: number): Promise<boolean>;
  /** Verified session-scoped unlock; false means ownership is uncertain. */
  releaseRunLock(key: number): Promise<boolean>;
  beginTx(): Promise<void>;
  commitTx(): Promise<void>;
  /** Execute checksum-bound migration SQL. `txScoped` states whether a bracket is open. */
  executeSql(sql: string, txScoped: boolean): Promise<void>;
  /** CLEAN release — only ever on the fully verified path. */
  close(): Promise<void>;
  /** DESTROY the physical connection so session end drops the advisory lock. */
  terminate(): Promise<void>;
}

export interface ExecutorAdapter {
  reserve(mode: ConnectionMode): Promise<ExecutorSession>;
  /** Best-effort cancellation of an outstanding reservation attempt. */
  cancelReserve?(): Promise<void>;
}

/** ONE ledger port. Every operation takes the run's single reserved session, so the dirty
 *  marker, the finalize and the read share one backend by construction. */
export interface ExecutorLedgerPort {
  readLedger(session: ExecutorSession): Promise<LedgerRow[]>;
  insertDirtyAttempt(session: ExecutorSession, row: { version: string; checksum: string; startedAt: string }): Promise<void>;
  finalizeApplied(
    session: ExecutorSession,
    row: { version: string; checksum: string; finishedAt: string },
    txScoped: boolean,
  ): Promise<void>;
}

export interface TrustedApplyDeps {
  /** Discovery source. The executor rediscovers, revalidates, repairs and replans itself. */
  fsPort: MigrationFsPort;
  adapter: ExecutorAdapter;
  ledger: ExecutorLedgerPort;
  connectionMode: ConnectionMode;
  credential: CredentialClassification;
  lockKey: number;
  now: () => string;
  /** Bound applied to EVERY awaited database/adapter operation. */
  deadlineMs: number;
  transactionModeByVersion?: Readonly<Record<string, TransactionMode>>;
}

export interface ExecutorReport {
  outcome: ExecutionOutcome;
  /** A bounded engine or executor code — never a driver message. */
  code: string | null;
  disposition: ExecutionDisposition;
  ownershipUncertain: boolean;
  /** Versions whose finalize effect completed, in order. */
  applied: string[];
  /** Checksums of the SQL actually executed, re-derived from the executed text. */
  executedChecksums: string[];
  disposal: 'none' | 'closed' | 'terminated';
  /** Mutated to true if a reservation settles AFTER a timeout verdict and is disposed. */
  lateSettlementDisposed: boolean;
  steps: number;
}

// ---------------------------------------------------------------------------
// bounded awaiting with late-settlement interception
// ---------------------------------------------------------------------------

/** `timedOut` is present on BOTH members so reading it never depends on control-flow narrowing
 *  surviving a callback boundary — a deadline result must stay readable wherever it is passed. */
type Bounded<T> = { ok: true; value: T; timedOut: false } | { ok: false; timedOut: boolean };

/**
 * Await `start()` under a hard deadline. On timeout the original promise is NOT abandoned —
 * a late settlement is routed to `onLate`, because a database operation that merely missed a
 * deadline may still have created a physical resource that must be disposed of.
 */
async function bounded<T>(
  start: () => Promise<T>,
  ms: number,
  onLate: (value: T | undefined) => void,
): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const work = (async () => {
    try {
      const value = await start();
      return { kind: 'ok' as const, value };
    } catch {
      // The driver error is DROPPED here, deliberately: it may carry SQL, a DSN, a password or
      // a stack. Only the fact of failure crosses this boundary.
      return { kind: 'err' as const };
    }
  })();
  // The timer is deliberately NOT unref'd: it is the only handle keeping the process alive
  // while a database call hangs, and that is exactly the case this deadline exists for. An
  // unref'd timer lets the event loop drain mid-hang, which turns a bounded failure into an
  // abrupt exit — the opposite of a bounded failure.
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  const race = await Promise.race([work, timeout]);
  if (race.kind !== 'timeout') {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    return race.kind === 'ok'
      ? { ok: true, value: race.value, timedOut: false }
      : { ok: false, timedOut: false };
  }
  // Deadline exceeded: keep watching so a late resource cannot leak.
  void work
    .then((r) => {
      if (settled) return;
      onLate(r.kind === 'ok' ? r.value : undefined);
    })
    // Structural, not incidental: a throwing onLate must never become an unhandled rejection
    // that takes down a migration process on its cleanup path.
    .catch(() => {});
  return { ok: false, timedOut: true };
}

// ---------------------------------------------------------------------------
// the trusted apply run
// ---------------------------------------------------------------------------

/**
 * Apply every pending migration against ONE reserved session, driven entirely by the pure
 * kernel's prescribed effect order.
 *
 * The executor NEVER accepts a caller-supplied plan, program, state, verdict or KernelResult:
 * it rediscovers the migrations through its own filesystem port, revalidates and pairs them,
 * reads the ledger itself, plans with the engine's own planner, and hands THAT to the kernel.
 * Extra properties on `deps` are inert.
 *
 * ORDERING NOTE, stated plainly: the physical reservation happens in the prologue rather than
 * inside the loop, because the ledger — which the plan, and therefore the kernel program, is
 * derived from — can only be read over a connection. The kernel's own `reserve` effect is then
 * satisfied by a live round-trip on that session, and a prologue reservation that fails or
 * exceeds its deadline is still adjudicated BY THE KERNEL: it is fed to a kernel run as the
 * `port_failed`/`timeout` event for the `reserve` step, so the verdict, the disposition and the
 * ownership-uncertainty flag are the kernel's decision and not the executor's.
 */
export async function runTrustedApply(deps: TrustedApplyDeps): Promise<ExecutorReport> {
  const report: ExecutorReport = {
    outcome: 'refused',
    code: null,
    disposition: 'none',
    ownershipUncertain: false,
    applied: [],
    executedChecksums: [],
    disposal: 'none',
    lateSettlementDisposed: false,
    steps: 0,
  };
  const deadlineMs = Number.isSafeInteger(deps.deadlineMs) && deps.deadlineMs > 0 ? deps.deadlineMs : 30_000;
  const kernelDeps = { connectionMode: deps.connectionMode, credential: deps.credential, lockKey: deps.lockKey };

  // A late-settling reservation must be DISPOSED, and the run must be able to WAIT for that
  // disposal before it returns — a fire-and-forget chain can be truncated by the caller exiting
  // the process, leaking a backend that may still hold the run's advisory lock.
  let lateDisposal: Promise<void> | null = null;
  /** Physically destroy a session, never pool it. Disposal failure can never mask a verdict. */
  const disposeLate = (s: ExecutorSession | undefined): void => {
    if (s === undefined) return;
    lateDisposal = bounded(() => s.terminate(), deadlineMs, () => {}).then((r) => {
      report.lateSettlementDisposed = r.ok;
    });
  };
  /** Give an in-flight late disposal a bounded chance to finish before the report is returned. */
  const settleLateDisposal = async (graceMs: number): Promise<void> => {
    const started = Date.now();
    while (lateDisposal === null && Date.now() - started < graceMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (lateDisposal !== null) {
      await Promise.race([lateDisposal, new Promise((r) => setTimeout(r, graceMs))]);
    }
  };

  // --- prologue: rediscover and reserve -------------------------------------
  let pairs: MigrationPair[];
  try {
    pairs = pairMigrations(discoverMigrations(deps.fsPort, { transactionModeByVersion: deps.transactionModeByVersion }));
  } catch (e) {
    report.outcome = 'refused';
    report.code = boundedCode(e);
    return report;
  }

  const reserved = await bounded(() => deps.adapter.reserve(deps.connectionMode), deadlineMs, disposeLate);
  if (!reserved.ok) {
    // Let the KERNEL decide the verdict, the disposition and the ownership flag.
    const started = startMigrationExecution({ pending: [] }, kernelDeps);
    const verdict = stepMigrationExecution(started.state, { type: reserved.timedOut ? 'timeout' : 'port_failed' });
    report.outcome = verdict.state.outcome;
    report.code = verdict.state.code;
    report.disposition = verdict.state.disposition;
    report.ownershipUncertain = verdict.state.ownershipUncertain;
    const cancel = deps.adapter.cancelReserve;
    if (verdict.state.disposition === 'cancel_and_dispose' && typeof cancel === 'function') {
      // Cancel the OUTSTANDING attempt. Best-effort: a failure here must not mask the verdict.
      await bounded(() => cancel.call(deps.adapter), deadlineMs, () => {});
    }
    // Wait, briefly and boundedly, for any session that settles late — so the caller can act on
    // `lateSettlementDisposed` instead of racing the process exit.
    await settleLateDisposal(deadlineMs);
    return report;
  }
  const session = reserved.value;

  let ledgerRows: LedgerRow[];
  const read = await bounded(() => deps.ledger.readLedger(session), deadlineMs, () => {});
  if (!read.ok) {
    report.outcome = 'failed';
    report.code = read.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED;
    report.disposition = 'terminate';
    await terminateQuietly(session, report);
    return report;
  }
  ledgerRows = read.value;

  let plan: ApplyPlan;
  try {
    plan = planApply(pairs, ledgerRows);
  } catch (e) {
    // A refusal BEFORE any effect: nothing was locked or written, but a session IS held, so it
    // is destroyed rather than pooled — the kernel never saw this run.
    report.outcome = 'refused';
    report.code = boundedCode(e);
    report.disposition = 'terminate';
    await terminateQuietly(session, report);
    return report;
  }

  // A `transaction: forbidden` migration whose file holds more than one statement can never be
  // executed bracket-free (see the execute effect below), so it is refused HERE — before the
  // kernel emits a single effect. Refusing later would still be fail-closed, but it would leave
  // a durable dirty marker behind for a run that never had any chance of succeeding.
  const multi = forbiddenMultiStatementVersion(plan);
  if (multi !== null) {
    report.outcome = 'refused';
    report.code = EXECUTOR_CODES.FORBIDDEN_MODE_MULTI_STATEMENT;
    report.disposition = 'terminate';
    await terminateQuietly(session, report);
    return report;
  }

  // --- kernel-driven interpretation ----------------------------------------
  let result: KernelResult = startMigrationExecution(plan, kernelDeps);
  let executorCode: string | null = null;

  while (result.state.outcome === 'in_progress') {
    const effect = result.effects[0];
    if (effect === undefined) {
      executorCode = EXECUTOR_CODES.UNSUPPORTED_EFFECT;
      result = stepMigrationExecution(result.state, { type: 'port_failed' });
      break;
    }
    report.steps += 1;
    const event = await interpretEffect(effect, session, deps, deadlineMs, report, (c) => { executorCode = c; });
    result = stepMigrationExecution(result.state, event);
  }

  report.outcome = result.state.outcome;
  report.code = executorCode ?? result.state.code;
  report.disposition = result.state.disposition;
  report.ownershipUncertain = result.state.ownershipUncertain;

  // The run lineage stops being authority here: nothing below reads `result` again, and it is
  // function-local so scope exit discards it. (It used to be overwritten with a `null` cast,
  // which bought nothing and left a footgun: a later diagnostic branch reading `result.state`
  // would have compiled cleanly and thrown at runtime.)
  const disposition = result.state.disposition;

  if (report.outcome === 'complete' && disposition === 'none') {
    // `close` already ran as the kernel's final effect on the one verified path.
    report.disposal = 'closed';
    return report;
  }
  await terminateQuietly(session, report);
  return report;
}

/**
 * READ-ONLY ledger read over one reserved session. Reserves, confirms the session is live, reads
 * the ledger, and closes cleanly. It acquires NO lock, writes nothing, and executes no migration
 * SQL — status and planning must never be able to apply anything as a side effect.
 */
export async function runTrustedLedgerRead(deps: {
  adapter: ExecutorAdapter;
  ledger: ExecutorLedgerPort;
  connectionMode: ConnectionMode;
  deadlineMs: number;
}): Promise<{ outcome: 'complete' | 'failed'; code: string | null; rows: LedgerRow[]; disposal: 'closed' | 'terminated' | 'none' }> {
  const deadlineMs = Number.isSafeInteger(deps.deadlineMs) && deps.deadlineMs > 0 ? deps.deadlineMs : 30_000;
  const out: { outcome: 'complete' | 'failed'; code: string | null; rows: LedgerRow[]; disposal: 'closed' | 'terminated' | 'none' } =
    { outcome: 'failed', code: null, rows: [], disposal: 'none' };

  const reserved = await bounded(
    () => deps.adapter.reserve(deps.connectionMode),
    deadlineMs,
    // Bounded like every other awaited port call: an unbounded terminate on the cleanup path
    // could hang forever with nothing to stop it.
    (late) => { if (late !== undefined) void bounded(() => late.terminate(), deadlineMs, () => {}); },
  );
  if (!reserved.ok) {
    out.code = reserved.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED;
    const cancel = deps.adapter.cancelReserve;
    if (typeof cancel === 'function') {
      await bounded(() => cancel.call(deps.adapter), deadlineMs, () => {});
    }
    return out;
  }
  const session = reserved.value;
  // A disposal is only ever reported as achieved when the destroy call itself succeeded; a
  // failed hard-kill must stay visible as 'none' rather than be flattened into 'terminated'.
  const destroy = async (): Promise<void> => {
    const term = await bounded(() => session.terminate(), 5_000, () => {});
    out.disposal = term.ok ? 'terminated' : 'none';
    if (!term.ok) out.code = out.code ?? EXECUTOR_CODES.DISPOSAL_FAILED;
  };
  const live = await bounded(() => session.confirmLive(), deadlineMs, () => {});
  if (!live.ok) {
    out.code = live.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED;
    await destroy();
    return out;
  }
  const read = await bounded(() => deps.ledger.readLedger(session), deadlineMs, () => {});
  if (!read.ok) {
    out.code = read.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED;
    await destroy();
    return out;
  }
  out.rows = read.value;
  const closed = await bounded(() => session.close(), deadlineMs, () => {});
  if (!closed.ok) {
    out.code = ENGINE_CODES.PORT_OPERATION_FAILED;
    await destroy();
    return out;
  }
  out.disposal = 'closed';
  out.outcome = 'complete';
  return out;
}

/** The first pending version that declares `forbidden` mode yet carries multiple statements. */
function forbiddenMultiStatementVersion(plan: ApplyPlan): string | null {
  for (const pair of plan.pending) {
    if (pair.transactionMode !== 'forbidden') continue;
    const sql = pair.up.artifact?.sql;
    if (typeof sql === 'string' && countSqlStatements(sql) > 1) return pair.version;
  }
  return null;
}

/** Destroy the session; record it. A disposal failure is recorded, never silently swallowed
 *  and never upgraded into success. */
async function terminateQuietly(session: ExecutorSession, report: ExecutorReport): Promise<void> {
  const out = await bounded(() => session.terminate(), 5_000, () => {});
  if (out.ok) {
    report.disposal = 'terminated';
    return;
  }
  report.disposal = 'none';
  if (report.outcome === 'complete') report.outcome = 'failed';
  report.code = report.code ?? EXECUTOR_CODES.DISPOSAL_FAILED;
}

/** Every code this module may ever report. Anything outside the set is NOT a code we recognise. */
const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(ENGINE_CODES) as string[],
  ...Object.values(EXECUTOR_CODES) as string[],
]);

/**
 * Map a thrown value to a bounded code.
 *
 * An ALLOWLIST, not a copy: a `code` property is caller-controlled (any port, adapter or ledger
 * may throw an object carrying one), so echoing it verbatim would let SQL text, a DSN or a
 * credential ride into the report through the one field that is meant to be inert.
 */
function boundedCode(e: unknown): string {
  const d = e === null || typeof e !== 'object' ? undefined : Object.getOwnPropertyDescriptor(e, 'code');
  const raw = d !== undefined && typeof d.value === 'string' ? d.value : '';
  return KNOWN_CODES.has(raw) ? raw : EXECUTOR_CODES.PORT_FAILED;
}

/**
 * Perform exactly ONE kernel-prescribed effect and report its result as a kernel event. Every
 * awaited call is deadline-bounded; a throw becomes `port_failed` and a deadline `timeout`, so
 * no raw driver error, SQL string, DSN or stack ever crosses back into the run.
 */
async function interpretEffect(
  effect: ExecutionEffect,
  session: ExecutorSession,
  deps: TrustedApplyDeps,
  deadlineMs: number,
  report: ExecutorReport,
  setCode: (c: string) => void,
): Promise<ExecutionEvent> {
  const ev = (r: Bounded<unknown>, ok: ExecutionEvent): ExecutionEvent =>
    r.ok ? ok : { type: r.timedOut ? 'timeout' : 'port_failed' };

  switch (effect.kind) {
    case 'reserve': {
      const r = await bounded(() => session.confirmLive(), deadlineMs, () => {});
      return ev(r, { type: 'reserved' });
    }
    case 'capture_identity':
    case 'verify_identity': {
      const r = await bounded(() => session.backendIdentity(), deadlineMs, () => {});
      return r.ok ? { type: 'identity', identity: r.value } : { type: r.timedOut ? 'timeout' : 'port_failed' };
    }
    case 'acquire_lock': {
      const r = await bounded(() => session.acquireRunLock(effect.lockKey), deadlineMs, () => {});
      return r.ok ? { type: 'lock', acquired: r.value } : { type: r.timedOut ? 'timeout' : 'port_failed' };
    }
    case 'release_lock': {
      const r = await bounded(() => session.releaseRunLock(effect.lockKey), deadlineMs, () => {});
      return r.ok ? { type: 'unlock', released: r.value } : { type: r.timedOut ? 'timeout' : 'port_failed' };
    }
    case 'insert_dirty': {
      let startedAt: string;
      try {
        startedAt = assertLedgerTimestamp(deps.now(), 'started_at');
      } catch {
        setCode(EXECUTOR_CODES.PORT_FAILED);
        return { type: 'port_failed' };
      }
      const r = await bounded(
        () => deps.ledger.insertDirtyAttempt(session, { version: effect.version, checksum: effect.checksum, startedAt }),
        deadlineMs,
        () => {},
      );
      return ev(r, { type: 'ok' });
    }
    case 'open_tx': {
      const r = await bounded(() => session.beginTx(), deadlineMs, () => {});
      return ev(r, { type: 'ok' });
    }
    case 'execute': {
      // Re-bind the text to its declared checksum INSIDE the executor. The kernel already
      // canonicalized the artifact, but this module is what actually runs the statement, so it
      // proves for itself that the bytes it is about to execute are the bytes that were hashed.
      if (sha256Utf8(effect.sql) !== effect.checksum) {
        setCode(EXECUTOR_CODES.ARTIFACT_BINDING_MISMATCH);
        return { type: 'port_failed' };
      }
      // A `transaction: forbidden` migration exists for statements that CANNOT run inside a
      // transaction block (CREATE INDEX CONCURRENTLY, VACUUM, ALTER TYPE ... ADD VALUE). Issuing
      // no explicit BEGIN is NOT sufficient: PostgreSQL executes a multi-statement simple query
      // in an implicit transaction block of its own, so such a file fails with SQLSTATE 25001
      // ("cannot run inside a transaction block") even though this executor opened no bracket.
      // Rather than silently promise a guarantee the protocol withdraws, a multi-statement
      // forbidden-mode file is refused before any statement runs. Splitting the script and
      // sending each statement as its own query is the upgrade path.
      if (!effect.txScoped && countSqlStatements(effect.sql) > 1) {
        setCode(EXECUTOR_CODES.FORBIDDEN_MODE_MULTI_STATEMENT);
        return { type: 'port_failed' };
      }
      const r = await bounded(() => session.executeSql(effect.sql, effect.txScoped), deadlineMs, () => {});
      if (r.ok) report.executedChecksums.push(effect.checksum);
      return ev(r, { type: 'ok' });
    }
    case 'finalize': {
      let finishedAt: string;
      try {
        finishedAt = assertLedgerTimestamp(deps.now(), 'finished_at');
      } catch {
        setCode(EXECUTOR_CODES.PORT_FAILED);
        return { type: 'port_failed' };
      }
      const r = await bounded(
        () => deps.ledger.finalizeApplied(session, { version: effect.version, checksum: effect.checksum, finishedAt }, effect.txScoped),
        deadlineMs,
        () => {},
      );
      if (r.ok) report.applied.push(effect.version);
      return ev(r, { type: 'ok' });
    }
    case 'commit_tx': {
      const r = await bounded(() => session.commitTx(), deadlineMs, () => {});
      return ev(r, { type: 'ok' });
    }
    case 'close': {
      const r = await bounded(() => session.close(), deadlineMs, () => {});
      return ev(r, { type: 'ok' });
    }
    default: {
      setCode(EXECUTOR_CODES.UNSUPPORTED_EFFECT);
      return { type: 'port_failed' };
    }
  }
}

// ---------------------------------------------------------------------------
// the REAL PostgreSQL adapter
//
// This is the only code in the repository that opens a migration connection. It uses the
// already-installed `postgres` client (a declared direct dependency — nothing is added) and
// binds the WHOLE run to ONE physical backend: a `max: 1` client whose single connection is
// pinned by `reserve()`. `close()` returns that connection cleanly; `terminate()` destroys the
// socket, which is what makes PostgreSQL drop a session advisory lock and abort an open
// transaction. A potentially locked backend therefore never returns to a reusable pool.
// ---------------------------------------------------------------------------

/** Everything the adapter needs, with no reference to the raw DSN outside this module. */
export interface PostgresExecutorHandle {
  adapter: ExecutorAdapter;
  ledger: ExecutorLedgerPort;
  /** Destroy the client unconditionally (idempotent). Always call this in a finally block. */
  dispose(): Promise<void>;
}

const LEDGER_DDL =
  'create table if not exists public.schema_migrations (' +
  'version text primary key, checksum text not null, dirty boolean not null default true, ' +
  'started_at timestamptz not null, finished_at timestamptz)';

/**
 * Build the PostgreSQL executor ports for a validated disposable-test DSN.
 *
 * The DSN is read from the module-private map — it is never a parameter, never returned, and
 * never logged, so no caller can obtain it from this handle.
 */
export async function createPostgresExecutor(
  dsn: DisposableTestDsn,
  options: { statementTimeoutMs?: number } = {},
): Promise<PostgresExecutorHandle> {
  const raw = RAW_DSN.get(dsn);
  if (raw === undefined) return fail(EXECUTOR_CODES.TEST_DSN_INVALID, 'unvalidated handle');

  // Imported HERE, not at module load: the import itself is what a containment test must be
  // able to see is absent from the production graph, and a dynamic import keeps the driver out
  // of any bundle that merely type-imports this module.
  const { default: postgres } = await import('postgres');

  // A socket handle must pass its directory as the driver's HOST: the driver derives the socket
  // path from the host field, and a `?host=` query parameter would silently be ignored, sending
  // the connection to `localhost` over TCP instead of the task-owned socket it was validated for.
  const socketDir = SOCKET_DIR.get(dsn);
  const user = DSN_USER.get(dsn);
  const statementTimeoutMs =
    Number.isSafeInteger(options.statementTimeoutMs) && (options.statementTimeoutMs as number) > 0
      ? (options.statementTimeoutMs as number)
      : 60_000;
  const client = postgres(raw, {
    max: 1,
    prepare: false,
    idle_timeout: 0,
    connect_timeout: 10,
    onnotice: () => {},
    ...(socketDir === undefined ? {} : { host: socketDir }),
    ...(user === undefined ? {} : { user }),
    // SERVER-SIDE bounds, sent as startup parameters. The client-side deadline only stops this
    // process WAITING; it sends no cancel request, and PostgreSQL does not notice a dropped
    // client while it is blocked in a lock wait. Without these a migration statement could hold
    // locks indefinitely after the executor had already given up on it.
    connection: {
      statement_timeout: statementTimeoutMs,
      lock_timeout: Math.max(1000, Math.floor(statementTimeoutMs / 2)),
      idle_in_transaction_session_timeout: statementTimeoutMs,
    },
    // No SSL clause: the only reachable endpoints are a task-owned Unix socket and loopback.
  });

  type Reserved = Awaited<ReturnType<typeof client.reserve>>;
  let reservedConn: Reserved | null = null;
  let destroyed = false;

  const dispose = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    // timeout: 0 destroys rather than draining — session end drops the advisory lock.
    await client.end({ timeout: 0 }).catch(() => {});
  };

  const session: ExecutorSession = {
    confirmLive: async () => {
      const c = requireConn();
      await c`select 1`;
    },
    backendIdentity: async (): Promise<BackendIdentity> => {
      const c = requireConn();
      const rows = await c`select pg_backend_pid() as pid`;
      const pid = rows[0]?.pid;
      // A bounded PRIMITIVE token: the kernel compares captured strings, so a driver that
      // reused one row object across backends could not keep this equal.
      return { token: `pid:${String(pid)}` };
    },
    acquireRunLock: async (key: number) => {
      const c = requireConn();
      // pg_try_advisory_lock is SESSION-scoped and NON-BLOCKING: it either takes the lock for
      // the life of this backend or returns false at once. An xact-scoped lock would silently
      // release at the first per-file commit, leaving the rest of the run unprotected.
      const rows = await c`select pg_try_advisory_lock(${key}::bigint) as acquired`;
      return rows[0]?.acquired === true;
    },
    releaseRunLock: async (key: number) => {
      const c = requireConn();
      const rows = await c`select pg_advisory_unlock(${key}::bigint) as released`;
      return rows[0]?.released === true;
    },
    beginTx: async () => { await requireConn().unsafe('begin'); },
    commitTx: async () => { await requireConn().unsafe('commit'); },
    executeSql: async (sqlText: string) => {
      // `.simple()` runs the migration file as one simple-query batch, which is what a .sql
      // file is. The TEXT is the canonical, checksum-rebound artifact text and nothing else —
      // it is never concatenated with a parameter, an identifier, or any caller value.
      await requireConn().unsafe(sqlText).simple();
    },
    close: async () => {
      const c = reservedConn;
      reservedConn = null;
      if (c !== null) c.release();
      // `destroyed` is latched ONLY after the graceful shutdown actually resolves. Setting it
      // first made a FAILING close disable its own compensating force-destroy: terminate() ->
      // dispose() would hit the `if (destroyed) return` guard and no-op, and the run would then
      // report `disposal: 'terminated'` for a connection that may still be alive holding the
      // run's advisory lock.
      await client.end({ timeout: 5 });
      destroyed = true;
    },
    terminate: async () => { await dispose(); },
  };

  function requireConn(): Reserved {
    if (reservedConn === null) throw new MigrationExecutorError(EXECUTOR_CODES.PORT_FAILED, 'no reserved session');
    return reservedConn;
  }

  const adapter: ExecutorAdapter = {
    reserve: async () => {
      reservedConn = await client.reserve();
      return session;
    },
    cancelReserve: async () => { await dispose(); },
  };

  const ledger: ExecutorLedgerPort = {
    readLedger: async (): Promise<LedgerRow[]> => {
      const c = requireConn();
      // Read-only: a missing ledger table is an EMPTY history, never a reason to create one
      // before the run holds its lock.
      const present = await c`select to_regclass('public.schema_migrations') is not null as ok`;
      if (present[0]?.ok !== true) return [];
      const rows = await c`select version, checksum, dirty from public.schema_migrations order by version asc`;
      return rows.map((r) => ({ version: String(r.version), checksum: String(r.checksum), dirty: r.dirty === true }));
    },
    insertDirtyAttempt: async (_s, row) => {
      const c = requireConn();
      // Runs AFTER the advisory lock, so the idempotent DDL cannot race another runner.
      await c.unsafe(LEDGER_DDL);
      // Parameterized: version/checksum/timestamp are values, never interpolated text.
      await c`insert into public.schema_migrations (version, checksum, dirty, started_at)
              values (${row.version}, ${row.checksum}, true, ${row.startedAt}::timestamptz)`;
    },
    finalizeApplied: async (_s, row) => {
      const c = requireConn();
      const res = await c`update public.schema_migrations
                          set dirty = false, checksum = ${row.checksum}, finished_at = ${row.finishedAt}::timestamptz
                          where version = ${row.version}`;
      if (res.count !== 1) throw new MigrationExecutorError(EXECUTOR_CODES.PORT_FAILED, 'finalize matched no row');
    },
  };

  return { adapter, ledger, dispose };
}
