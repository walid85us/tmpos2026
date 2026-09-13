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
  sha256Hex,
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
  // --- managed DEV recovery path (Phase 4.0 M3 S4.1b C2B-R2) ---------------------------
  /** The managed DSN is absent, unparseable, or not a postgres URL. */
  MANAGED_DSN_INVALID: 'managed_dsn_invalid',
  /** The managed DSN names a local/loopback/socket host — that is the DISPOSABLE path's job. */
  MANAGED_DSN_NOT_REMOTE: 'managed_dsn_not_remote',
  /** Endpoint family is not the accepted session-mode one (e.g. a transaction-pooler port). */
  MANAGED_DSN_ENDPOINT_FAMILY_REJECTED: 'managed_dsn_endpoint_family_rejected',
  /** DSN project reference disagrees with the independently supplied project URL. */
  MANAGED_DSN_PROJECT_MISMATCH: 'managed_dsn_project_mismatch',
  /** DSN database name is not the expected managed database. */
  MANAGED_DSN_DATABASE_MISMATCH: 'managed_dsn_database_mismatch',
  /** The live database did not match the expected DEV fingerprint. */
  MANAGED_FINGERPRINT_REJECTED: 'managed_fingerprint_rejected',
  /** A per-version historical postcondition was not satisfied. */
  BASELINE_POSTCONDITION_FAILED: 'baseline_postcondition_failed',
  /** Evidence of migration-005 state was found before adoption. */
  BASELINE_PRE005_RESIDUE: 'baseline_pre005_residue',
  /** The ledger was not in the expected empty entry state under serialization. */
  BASELINE_ENTRY_STATE_REJECTED: 'baseline_entry_state_rejected',
  /** A committed partial adopted prefix was observed — a STOP state, never auto-repaired. */
  BASELINE_PARTIAL_OBSERVED: 'baseline_partial_observed',
  /** Post-commit read-back did not show exactly the adopted prefix. */
  BASELINE_READBACK_MISMATCH: 'baseline_readback_mismatch',
  /** COMMIT was submitted and its database outcome was NOT established. Never "did not commit". */
  BASELINE_COMMIT_UNKNOWN: 'baseline_commit_unknown',
  /** The computed managed apply plan was not exactly the single authorized version. */
  MANAGED_APPLY_PLAN_REJECTED: 'managed_apply_plan_rejected',
  /** A managed apply asked for a direction other than forward. Separate from the VERSION gate. */
  MANAGED_DIRECTION_REJECTED: 'managed_direction_rejected',
  /** Under the run lock, the authoritative plan disagreed with the program about to execute. */
  MANAGED_PLAN_DRIFT: 'managed_plan_drift',
  /** A mutating effect was reached while a supplied execution policy had not authorized the run. */
  EXECUTION_POLICY_UNEVALUATED: 'execution_policy_unevaluated',
  /** The connected principal lacks the database-owner authority the action requires. */
  OWNER_AUTHORITY_MISSING: 'owner_authority_missing',
  /** A database-level ACL action did not verify as effective afterwards. */
  OWNER_ACL_VERIFY_FAILED: 'owner_acl_verify_failed',
  // --- single-purpose migration-005 hardening (Phase 4.0 M3 S4.1b C2B-M005-B0) ---------
  /** An existing migration-ledger relation does not match the contract this code writes. */
  LEDGER_SHAPE_REJECTED: 'ledger_shape_rejected',
  /**
   * A ledger `dirty` value was not one of the two literal booleans.
   *
   * SEPARATE from a shape rejection on purpose: a relation can satisfy every column check and
   * still return a NULL for a row written before the NOT NULL was in force. `dirty` is the field
   * the whole apply gate turns on, so an unrepresentable value is refused rather than coerced.
   */
  LEDGER_DIRTY_STATE_INVALID: 'ledger_dirty_state_invalid',
  /** Under the run lock, the migration artifact was no longer the one the plan was built from. */
  MANAGED_APPLY_IDENTITY_DRIFT: 'managed_apply_identity_drift',
  /** A migration-005 structural postcondition was not satisfied after its COMMIT. */
  MANAGED_APPLY_POSTCONDITION_FAILED: 'managed_apply_postcondition_failed',
  /** Post-commit ledger read-back did not show exactly the applied version, clean and matching. */
  MANAGED_APPLY_READBACK_MISMATCH: 'managed_apply_readback_mismatch',
  /** COMMIT was submitted and its database outcome was NOT established. Never "did not commit". */
  MANAGED_APPLY_COMMIT_UNKNOWN: 'managed_apply_commit_unknown',
  /** The managed client's teardown was requested and did not complete. Never silently discarded. */
  CLIENT_TEARDOWN_FAILED: 'client_teardown_failed',
  // --- pre-COMMIT default-ACL commit-prevention gate (S4.1b C2B-M005-B1-R1/R2) ---------
  //
  // These are DELIBERATELY DISTINCT from the `MANAGED_APPLY_*` post-commit codes above. A
  // post-commit code says "the mutation is durable and the database does not show what the run
  // believes it wrote"; a pre-commit code says "COMMIT was never called". Reusing one label for
  // both would erase exactly the distinction this stage exists to establish — an operator reading
  // `managed_apply_postcondition_failed` has to assume the DDL landed.
  /** A governed default-ACL blocker was still present with the transaction OPEN. No COMMIT. */
  MANAGED_PRECOMMIT_BLOCKER_PRESENT: 'managed_precommit_blocker_present',
  /** Pre-commit default-ACL evidence was unreadable, malformed, overflowed or principal-mismatched. */
  MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE: 'managed_precommit_evidence_unreadable',
  /** The backend answering the pre-commit read is not the one that executed the migration. */
  MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED: 'managed_precommit_backend_identity_changed',
  /** The exact-005 program reached execution without the required pre-commit gate supplied. */
  MANAGED_PRECOMMIT_POLICY_MISSING: 'managed_precommit_policy_missing',
  /** Exact-005 is not a single transaction-scoped unit, so no pre-commit gate could protect it. */
  MANAGED_PRECOMMIT_NOT_TRANSACTIONAL: 'managed_precommit_not_transactional',
  /**
   * The pre-commit gate was reached and did not ANSWER — it threw, exceeded the deadline, or
   * returned something this module does not recognise.
   *
   * SEPARATE from the three verdict codes because the states differ in what an operator must do.
   * A verdict means the bracket was open, the migration had executed and the gate decided; this
   * means the gate itself is the unknown. Flattening it into a generic port failure lost the one
   * fact that matters afterwards — that 005's DDL and its in-transaction ledger row existed and
   * were abandoned — and made a gate timeout indistinguishable from any other step timeout.
   */
  MANAGED_PRECOMMIT_UNEVALUATED: 'managed_precommit_unevaluated',
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
  // A transport-downgrade request is a malformed MANAGED dsn, and it must be refused where every
  // other malformed input is — at the boundary, with a bounded code — rather than deep inside
  // client construction as an unbounded driver error after the run has begun reporting.
  // `resolveDatabaseTls` refuses the same values independently at construction; this is the early,
  // legible half of that policy, not a replacement for it.
  for (const key of ['ssl', 'sslmode']) {
    for (const value of url.searchParams.getAll(key)) {
      if (TLS_DOWNGRADE_REQUESTS.has(value.trim().toLowerCase())) {
        // The KEY is one of two fixed literals; the VALUE is operator input and stays out.
        return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, `the dsn selects a weaker transport through '${key}'`);
      }
    }
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
  /**
   * OPTIONAL post-lock authorization. Evaluated while the run lock is HELD and before any mutating
   * effect; a non-null return refuses the run. Generic/disposable callers omit it and are wholly
   * unaffected — with no policy there is no extra port call and no behaviour change.
   */
  executionPolicy?: TrustedApplyPolicy;
  /**
   * OPTIONAL pre-COMMIT verification (C2B-M005-B1-R1). Evaluated on the SAME pinned session, with
   * the migration SQL executed and the in-transaction ledger finalize already done, and with the
   * bracket STILL OPEN — immediately before `commit_tx` is interpreted and therefore before
   * `session.commitTx()` is ever called.
   *
   * WHY IT IS NOT A SECOND `postCommitPolicy`. The post-commit policy runs after COMMIT has
   * resolved; whatever it finds, the DDL is durable and it can only downgrade the REPORT. This one
   * is the only place a governed default-ACL blocker can still PREVENT the mutation, so refusing
   * here abandons the bracket and refusing there is a disclosure. Only an explicit `null` allows the
   * commit: a returned code, a throw and a deadline are all refusals, and an unrecognized code is
   * bounded to `PORT_FAILED` rather than echoed.
   *
   * REQUIRED, NOT MERELY HONOURED, for the exact-005 execution. When the frozen program will
   * execute the governed 005 bytes (version AND checksum), its absence is a refusal before the
   * first mutating effect — see `runTrustedApply`. Callers running anything else are unaffected.
   */
  preCommitPolicy?: TrustedApplyPolicy;
  /**
   * OPTIONAL post-COMMIT verification (C2B-M005-B0). Evaluated on the SAME pinned session, once,
   * immediately after a successful `commit_tx` and therefore BEFORE `release_lock` — so the ledger
   * read-back and the migration's structural postconditions are still serialized by the run lock.
   *
   * Symmetric to `executionPolicy` in shape and in failure handling: a non-null return, a throw, or
   * a deadline is a REFUSAL driven through the kernel, so disposition and the ownership flag stay
   * the kernel's to decide. It cannot un-commit anything — its job is to stop a committed run being
   * REPORTED as verified when the database does not show what the run believes it wrote.
   */
  postCommitPolicy?: TrustedApplyPolicy;
}

/**
 * One unit of work the frozen program will perform. The CHECKSUM is carried, not just the version:
 * a version label is a name, and two different SQL bodies can wear the same name. Binding only the
 * label would let a migration whose content changed between the program being frozen and the
 * authoritative re-read pass the gate while stale bytes execute.
 */
export interface ExecutionUnit {
  readonly version: string;
  readonly checksum: string;
  /** True when the migration runs inside a transaction bracket (`transaction: required`). */
  readonly txScoped: boolean;
}

/** What a post-lock policy is shown. `executionPlan` is what the FROZEN program will run. */
export interface TrustedApplyAuthorization {
  /** The reserved session, with the run lock already acquired. */
  readonly session: ExecutorSession;
  /** The program's own `execute` effects, in order — the plan execution actually consumes. */
  readonly executionPlan: readonly ExecutionUnit[];
}

/** Returns `null` to authorize, or a bounded refusal code. Never throws a driver error outward. */
export type TrustedApplyPolicy = (auth: TrustedApplyAuthorization) => Promise<string | null>;

/** Effects that change durable state. Reaching one without authorization is a fail-closed stop. */
const MUTATING_EFFECT_KINDS: ReadonlySet<string> = new Set(['insert_dirty', 'open_tx', 'execute', 'finalize', 'commit_tx']);

/**
 * The versions the frozen program will ACTUALLY execute, read from the program's own `execute`
 * effects rather than from the plan object.
 *
 * This distinction is the whole point of the binding: `buildProgram` copies each migration's
 * version, checksum AND SQL text inline into the effects, so the program — not the plan, and not
 * the filesystem — is what the kernel interprets from here on. Authorizing what the program says
 * it will run therefore authorizes the bytes that actually run.
 */
function programExecutionPlan(program: readonly ExecutionEffect[]): ExecutionUnit[] {
  const out: ExecutionUnit[] = [];
  for (let i = 0; i < program.length; i += 1) {
    const e = program[i];
    if (e !== undefined && e.kind === 'execute') out.push({ version: e.version, checksum: e.checksum, txScoped: e.txScoped });
  }
  return out;
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
  /** C2B-M005-B0 — the COMMIT evidence states, kept separate rather than summed into one word. */
  commit: ApplyCommitEvidence;
  /** C2B-M005-B0 — what this run established about its own advisory-lock release. */
  lockRelease: LockReleaseState;
  /**
   * C2B-M005-B1-R1 — a supplied pre-commit gate returned an explicit favourable result while the
   * transaction was still open, and only then was COMMIT interpreted.
   *
   * NOT the same fact as `commit.readBackVerified`, and deliberately not folded into it: this one
   * is about a decision taken while the mutation could still be abandoned, the other about durable
   * state after it could not. A run that is `complete` with this false either ran no gate or
   * reached COMMIT around one — both of which are refusals on the exact-005 path.
   */
  preCommitVerified: boolean;
  /**
   * C2B-M005-B1-R3 — whether this run's AUTOCOMMITTED dirty-marker write happened.
   *
   * An observation, not a verdict: `classifyLedgerMarker` turns it plus the commit evidence into
   * the durable ledger state. Kept separate for the same reason `commit` is four fields rather
   * than one — "the write succeeded" and "the row is still dirty" are different facts, and a
   * resolved commit with a verified read-back is what turns the first into a clean ledger.
   */
  dirtyMarkerWrite: DirtyMarkerWrite;
}

/**
 * COMMIT evidence, as separate observations rather than one verdict.
 *
 * The four fields answer four different questions and no two of them are the same fact:
 *
 *   submitted        — COMMIT was put on the wire. Marked BEFORE the await, so it survives both a
 *                      rejection and a deadline that abandons the promise mid-flight.
 *   resolved         — the driver's own commit call settled without error. This is a CLIENT-side
 *                      event: it is strong evidence and it is not a database acknowledgement.
 *   acknowledged     — an explicit protocol-level acknowledgement, IF the driver exposes one.
 *                      postgres.js does not, on this path, so the honest value is 'unavailable'
 *                      rather than a synonym for `resolved` that would quietly upgrade the claim.
 *   readBackVerified — the ledger was re-read on the SAME pinned session, under the SAME lock,
 *                      after the commit, and showed exactly what was written. This is the only
 *                      one of the four that is evidence about the DATABASE.
 *
 * `outcome` is derived from them and is deliberately not a fifth independent field: 'unknown' is
 * what `submitted && !resolved` means, and it must never be narrowed to 'not_submitted'.
 */
export interface ApplyCommitEvidence {
  submitted: boolean;
  resolved: boolean;
  acknowledged: 'unavailable' | 'observed';
  readBackVerified: boolean;
}

/** Derive the commit outcome. `unknown` is absorbing: nothing narrows it back. */
export function applyCommitOutcome(c: ApplyCommitEvidence): 'not_submitted' | 'resolved' | 'unknown' {
  if (!c.submitted) return 'not_submitted';
  return c.resolved ? 'resolved' : 'unknown';
}

/**
 * What a run established about the SESSION-scoped advisory lock it took.
 *
 * `not_acquired` is not a weaker form of `unverified`: it means no lock was ever held, so there is
 * nothing to release and no residual risk. `unverified` means a lock WAS taken and this process
 * could not prove it was given back — the state that blocks the next run.
 */
export type LockReleaseState = 'not_acquired' | 'verified' | 'unverified';

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
    // TRUTHFUL DEFAULTS, not optimistic ones: every path that returns before the kernel's first
    // effect returns before a lock was taken and before a transaction was begun.
    commit: { submitted: false, resolved: false, acknowledged: 'unavailable', readBackVerified: false },
    lockRelease: 'not_acquired',
    preCommitVerified: false,
    dirtyMarkerWrite: 'not_attempted',
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

  // The plan above was computed BEFORE the lock exists — the kernel acquires it as an effect, so
  // `planApply` necessarily ran unserialized. That snapshot therefore authorizes nothing. What the
  // program will actually execute is captured here, and an optional policy re-derives the
  // authoritative state UNDER the lock and must agree with it before any mutation is interpreted.
  const executionPlan = programExecutionPlan(result.state.program);
  const policy = deps.executionPolicy;
  let authorized = policy === undefined;
  const postCommit = deps.postCommitPolicy;
  /**
   * How many `commit_tx` effects the frozen program will emit, and how many have been seen.
   *
   * Latching on the FIRST commit made `readBackVerified` describe an intermediate database state on
   * a multi-migration plan, and that flag then survived into a report whose LATER migration failed.
   * The verification has to run after the last commit or it is verifying the wrong thing.
   */
  const totalCommits = result.state.program.filter((e) => e.kind === 'commit_tx').length;
  let commitsSeen = 0;
  /** True while this run holds an advisory lock it has not verifiably released. */
  let lockHeld = false;
  /**
   * True while a transaction bracket is OPEN and its COMMIT has not been interpreted.
   *
   * C2B-M005-B1-R1 made this state newly reachable in a HEALTHY form. Before the pre-commit gate,
   * every post-`open_tx` failure was a failed statement, which leaves the session in an aborted
   * block where a follow-up query fails anyway. A gate refusal leaves the bracket open and
   * perfectly usable — which is exactly what makes the compensating unlock below dangerous here.
   */
  let bracketOpen = false;

  // C2B-M005-B1-R1 — THE PRE-COMMIT GATE, AND WHEN IT IS MANDATORY.
  //
  // The requirement is derived from the FROZEN PROGRAM, not from a caller flag: a flag a caller
  // must remember to set is bypassed by forgetting it, which is the same defect as having no gate.
  // Both refusals happen HERE — before the loop, so before `acquire_lock`, `insert_dirty` and any
  // SQL. A run that cannot be gated must not begin, rather than begin and be stopped later.
  const preCommit = deps.preCommitPolicy;
  const entryRefusal = requiredPreCommitEntryRefusal(executionPlan, preCommit !== undefined, totalCommits);
  if (entryRefusal !== null) {
    executorCode = entryRefusal;
    result = stepMigrationExecution(result.state, { type: 'port_failed' });
  }

  while (result.state.outcome === 'in_progress') {
    const effect = result.effects[0];
    if (effect === undefined) {
      executorCode = EXECUTOR_CODES.UNSUPPORTED_EFFECT;
      result = stepMigrationExecution(result.state, { type: 'port_failed' });
      break;
    }
    // BYPASS GUARD. The authorization below hangs off a successful `acquire_lock`; a program that
    // never emits one — or whose lock event is malformed — must not therefore become unpoliced.
    // Anything that would change durable state stops here instead.
    if (!authorized && MUTATING_EFFECT_KINDS.has(effect.kind)) {
      executorCode = EXECUTOR_CODES.EXECUTION_POLICY_UNEVALUATED;
      result = stepMigrationExecution(result.state, { type: 'port_failed' });
      break;
    }
    // C2B-M005-B1-R1 — PRE-COMMIT VERIFICATION, BEFORE THE EFFECT IS INTERPRETED.
    //
    // Position is the entire correction. `commit_tx` is the effect whose interpretation calls
    // `session.commitTx()`, so evaluating the gate HERE means an unfavourable result returns
    // without COMMIT ever being put on the wire — `report.commit.submitted` stays false, which is
    // the evidence an operator needs to know a re-run is safe. Evaluating it one line later, after
    // `interpretEffect`, would be the B1 defect: a refusal about a mutation that already landed.
    //
    // Everything the migration does is already done and still uncommitted at this point: the kernel
    // emits `open_tx`, `execute`, `finalize` and then `commit_tx`, and the tx-scoped finalize writes
    // the ledger row inside the same bracket. The catalog port the policy reads through is built
    // over the SAME reserved connection, so it observes this transaction's uncommitted state — a
    // second connection could not see it at all, which is why no second connection is opened.
    //
    // A refusal is driven through the KERNEL, exactly like the pre-mutation policy, so disposition
    // and the ownership flag stay the kernel's to decide; the existing `terminate` disposition is
    // what abandons the open transaction.
    if (preCommit !== undefined && effect.kind === 'commit_tx') {
      const verdict = await bounded(() => preCommit({ session, executionPlan }), deadlineMs, () => {});
      const raw = verdict.ok
        ? verdict.value
        : (verdict.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED);
      if (raw !== null) {
        // BOUND THE CODE, AND KEEP IT A PRE-COMMIT CODE.
        //
        // A policy is caller-supplied, so an unrecognized return is an unrecognized result — a
        // refusal, and one whose label must not become a channel for arbitrary text. But a throw, a
        // deadline and an unrecognized string previously became generic port/timeout codes, and the
        // downstream classifier then read those as "nothing had been executed" — for a state where
        // 005's DDL and its in-transaction ledger row had both run and were abandoned. The gate's
        // own non-answer therefore gets its own code, so what actually happened survives the trip.
        executorCode = KNOWN_CODES.has(raw) && PRE_COMMIT_GATE_CODES.has(raw)
          ? raw
          : EXECUTOR_CODES.MANAGED_PRECOMMIT_UNEVALUATED;
        result = stepMigrationExecution(result.state, { type: 'port_failed' });
        break;
      }
      // Set only on an explicit null, and only after it: "the gate approved", never "the gate ran".
      report.preCommitVerified = true;
    }
    report.steps += 1;
    const event = await interpretEffect(effect, session, deps, deadlineMs, report, (c) => { executorCode = c; });
    result = stepMigrationExecution(result.state, event);

    // C2B-M005-B0 — THE LOCK LEDGER, recorded from the EVENTS rather than inferred afterwards from
    // the outcome. A run that acquired a lock and then failed has a residual an outcome label does
    // not carry, and inferring release from "the session probably ended" is exactly the weak claim
    // this replaces.
    //
    // ORDERED BEFORE THE AUTHORIZATION BLOCK, and that ordering is load-bearing. Below it, a policy
    // REFUSAL `break`s out of the loop — so with the ledger recorded afterwards, the single most
    // likely post-acquisition failure left `lockHeld` false and reported `lockRelease` as
    // `not_acquired` for a lock that was genuinely held, and no compensating unlock was attempted.
    if (effect.kind === 'acquire_lock' && event.type === 'lock' && event.acquired === true) {
      lockHeld = true;
      report.lockRelease = 'unverified';
    }
    // LATCHED ON THE ATTEMPT, NOT ON THE SUCCESS — and that asymmetry is deliberate.
    //
    // A BEGIN whose port call REJECTS is ambiguous: the client saw a failure, but the server may
    // have processed the statement before the connection faulted. Latching only on `ok` left
    // `bracketOpen` false there, and a non-timeout failure then satisfied the compensating unlock's
    // guard — releasing the run lock while a transaction might be open, which is the exact hazard
    // that guard exists to prevent. Treating "we asked to open" as "a bracket may be open" costs a
    // `verified` label on a path that had already failed, and buys the guard on the one path where
    // the state is genuinely unknown. Cleared on the COMMIT attempt for the same reason in reverse:
    // once COMMIT is on the wire the bracket's fate is the commit evidence's to describe.
    if (effect.kind === 'open_tx') bracketOpen = true;
    if (effect.kind === 'commit_tx') bracketOpen = false;
    if (effect.kind === 'release_lock' && event.type === 'unlock') {
      // `pg_advisory_unlock` returns true ONLY when this session genuinely held the lock, so a
      // literal true is the verification. Anything else leaves the residual standing.
      const released = event.released === true;
      report.lockRelease = released ? 'verified' : 'unverified';
      if (released) lockHeld = false;
    }

    // AUTHORIZE UNDER THE LOCK — after the lock is genuinely held, before the next effect is even
    // fetched, and therefore before `insert_dirty`, any SQL, and any ledger row. A policy refusal
    // is driven through the KERNEL rather than short-circuited around it, so disposition and the
    // ownership flag stay the kernel's to decide, exactly as for every other port failure.
    if (!authorized && effect.kind === 'acquire_lock' && event.type === 'lock' && event.acquired === true) {
      if (result.state.outcome !== 'in_progress') break;
      const verdict = await bounded(() => (policy as TrustedApplyPolicy)({ session, executionPlan }), deadlineMs, () => {});
      // A policy that throws, hangs past the deadline, or returns a code is a REFUSAL. Only an
      // explicit null authorizes, so no failure mode of the gate can be mistaken for approval.
      const refusal = verdict.ok
        ? verdict.value
        : (verdict.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED);
      if (refusal !== null) {
        // C2B-M005-B1-R1 — BOUND IT, like the pre-commit gate's. A policy is caller-supplied, so an
        // unrecognized return was an arbitrary string that reached `report.code` and from there the
        // operator output: SQL, a role name or a DSN could ride out through the one field meant to
        // be inert. A PRE-COMMIT code is refused here too — this gate runs before `open_tx`, so
        // borrowing a label that means "the bracket was open and the migration had run" would make
        // the mutation-state classifier name a connection disposal that abandoned nothing.
        executorCode = KNOWN_CODES.has(refusal) && !PRE_COMMIT_GATE_CODES.has(refusal)
          ? refusal
          : EXECUTOR_CODES.PORT_FAILED;
        result = stepMigrationExecution(result.state, { type: 'port_failed' });
        break;
      }
      // Set LAST, and only here. `authorized` must mean "the policy approved", not "the gate was
      // reached" — the bypass guard above trusts it, so any future edit that added a path between
      // reaching the gate and approving would otherwise run unpoliced and silently.
      authorized = true;
    }


    // C2B-M005-B0 — POST-COMMIT VERIFICATION, on the same pinned session while the run lock is
    // still held (the kernel emits `release_lock` only after `commit_tx`). Runs at most once: a
    // second evaluation could only re-read state this run no longer controls.
    if (effect.kind === 'commit_tx' && event.type === 'ok') commitsSeen += 1;
    if (postCommit !== undefined && effect.kind === 'commit_tx' && event.type === 'ok' && commitsSeen === totalCommits) {
      if (result.state.outcome !== 'in_progress') break;
      const verdict = await bounded(() => postCommit({ session, executionPlan }), deadlineMs, () => {});
      // Same rule as the pre-mutation policy: only an explicit null passes, so a throw, a hang or a
      // returned code can never be mistaken for verification.
      const refusal = verdict.ok
        ? verdict.value
        : (verdict.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED);
      if (refusal !== null) {
        // Bounded for the same two reasons as the pre-mutation policy above: no arbitrary text into
        // `report.code`, and no borrowing of a pre-commit label for a refusal that happens after
        // COMMIT has already resolved.
        executorCode = KNOWN_CODES.has(refusal) && !PRE_COMMIT_GATE_CODES.has(refusal)
          ? refusal
          : EXECUTOR_CODES.PORT_FAILED;
        result = stepMigrationExecution(result.state, { type: 'port_failed' });
        break;
      }
      report.commit.readBackVerified = true;
    }
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

  // C2B-M005-B0 — THE COMPENSATING UNLOCK.
  //
  // Before this, `release_lock` was emitted on the SUCCESS path alone. Every other post-acquisition
  // exit — a policy refusal, a failed statement, an identity change, a post-commit mismatch —
  // reached `terminateQuietly` with the lock still held and inferred its release from session end.
  // That inference is weaker than it looks: `terminate()` is a protocol Terminate plus a socket
  // half-close, which a backend blocked in a statement reads only when that statement finishes. So
  // the release was neither established nor reportable, and the next run would simply find the lock
  // taken.
  //
  // WHEN IT IS SAFE TO ASK. Only where the session is still usable AND nothing prohibits another
  // query on it:
  //   * an UNKNOWN commit prohibits it — the transaction's fate is undetermined, and a follow-up
  //     query on that session is exactly the "unsafe follow-up" that could resolve it by accident;
  //   * a TIMEOUT prohibits it — `bounded` abandons rather than cancels, so a statement may still be
  //     in flight on this backend and a new query would be sent into it;
  //   * a CHANGED BACKEND IDENTITY prohibits it — the kernel has just concluded this is not the
  //     session that took the lock, so a query on it proves nothing about the lock that is held.
  // In each case the release stays `unverified`, nothing is retried or reconnected, and the
  // physical teardown below is what the operator is left with.
  //
  // WHAT IT CANNOT REPAIR, stated rather than implied: a statement failure INSIDE an open
  // transaction bracket leaves the session in an aborted-transaction block, where the unlock query
  // itself fails with 25P02. That path is admitted by the guard and simply does not succeed — the
  // release stays `unverified`, which is truthful, but this block does not rescue it.
  if (
    lockHeld
    && applyCommitOutcome(report.commit) !== 'unknown'
    && report.code !== ENGINE_CODES.EXECUTION_STEP_TIMEOUT
    && report.code !== ENGINE_CODES.BACKEND_IDENTITY_CHANGED
    // C2B-M005-B1-R1 — the PRE-COMMIT gate's own discontinuity verdict, which is a DIFFERENT string
    // from the kernel's. Without it the third prohibition above was documented and not enforced:
    // the gate would conclude "this is not the backend that took the lock", and the very next thing
    // this block did was ask that session to release it.
    //
    // SUBSUMED TODAY, KEPT DELIBERATELY. The `!bracketOpen` term below already excludes every path
    // that can produce this code, because the gate only runs with the bracket open — so removing
    // this line changes no current behaviour, and a test cannot fail for its absence. It stays as
    // defence in depth against exactly one future edit: relaxing the bracket rule without
    // rediscovering that this code names a session the run has already rejected. Stated rather
    // than left as an untested line someone later reads as load-bearing.
    && report.code !== EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED
    && report.ownershipUncertain !== true
    // C2B-M005-B1-R1 — AND NOT WHILE AN UNCOMMITTED BRACKET IS STILL OPEN.
    //
    // `pg_advisory_unlock` on a session lock is NOT transactional: the release takes effect at
    // once and survives the transaction being abandoned. Asking for it here would publish "no
    // migration in progress" while this backend still holds every ACCESS EXCLUSIVE lock the
    // migration took, and `terminate()` is a half-close a blocked backend may not read for some
    // time — so a second runner could take the run lock and then block on those object locks. That
    // inverts the exclusion the run lock exists to provide.
    //
    // The cost is stated rather than hidden: on this path `lockRelease` stays `unverified`, and
    // the physical teardown below is what actually drops the lock. That is a weaker CLAIM about
    // the same action, not a weaker action — and it is the truthful one.
    && !bracketOpen
  ) {
    const released = await bounded(() => session.releaseRunLock(deps.lockKey), deadlineMs, () => {});
    if (released.ok && released.value === true) {
      report.lockRelease = 'verified';
      lockHeld = false;
    }
    // A failed or false unlock changes nothing: `unverified` was already the state, and asserting
    // anything else here would be the inference this block exists to remove.
  }

  if (report.outcome === 'complete' && disposition === 'none') {
    // `close` already ran as the kernel's final effect on the one verified path.
    report.disposal = 'closed';
    // DEFENCE IN DEPTH. The kernel refuses to complete unless `release_lock` returned true, so this
    // should be unreachable — which is exactly why it is here. A complete run whose lock release is
    // not verified must not be reported as clean by any future edit to the choreography.
    if (report.lockRelease !== 'verified') {
      report.outcome = 'failed';
      report.code = report.code ?? ENGINE_CODES.RUN_UNLOCK_FAILED;
      // And do NOT leave the connection pooled. `close` already released it, which is the one
      // disposal a run with an unproven lock release must not keep.
      await terminateQuietly(session, report);
      return report;
    }
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
 * Is this a code the executor or the engine actually defines?
 *
 * C2B-M005-B1-R3 — exported so the CLI can PRESERVE a known bounded failure instead of collapsing
 * it. Two of its boundaries threw a bare `Error`, which the CLI's catch could not tell from an
 * arbitrary throw, so `unresolved_dirty_attempt` and `execution_step_timeout` both surfaced as the
 * operator-GATE code — "you did not satisfy the gates" for a run that satisfied every gate.
 *
 * It stays an ALLOWLIST rather than a passthrough: a `code` property is caller-controlled, so a
 * port could otherwise ride SQL text, a DSN or a credential out through the one inert field.
 */
export function isKnownBoundedCode(code: unknown): code is string {
  return typeof code === 'string' && KNOWN_CODES.has(code);
}

/**
 * Re-brand a KNOWN bounded code as the ONE error type that crosses this boundary.
 *
 * C2B-M005-B1-R3 — the narrowest way to stop a real ledger failure surfacing as the operator-GATE
 * code. Two CLI boundaries threw a bare `Error`, and `planApply` throws a `MigrationEngineError`,
 * so `unresolved_dirty_attempt` and `execution_step_timeout` both rendered as "you did not satisfy
 * the gates" for a run that satisfied every gate. Converting AT THE THROW leaves the CLI's catches
 * exactly as they are — the existing source-integrity contract on that shape stays intact.
 *
 * The code is ALLOWLISTED here, not trusted: a `code` property is caller-controlled, so an
 * unrecognized value collapses to a safe generic rather than riding SQL, a DSN or a credential out
 * through the one field that is meant to be inert. `label` is already sanitized by the constructor.
 */
export function boundedExecutorError(code: unknown, label = ''): MigrationExecutorError {
  const safe = isKnownBoundedCode(code) ? code : EXECUTOR_CODES.PORT_FAILED;
  return new MigrationExecutorError(safe as ExecutorCode, label);
}

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
 * C2B-M005-B1-R1 — is a pre-commit gate OWED for this program, and is it satisfiable?
 *
 * A PURE FUNCTION of the frozen program, so both of its clauses can be exercised directly. Inline,
 * the second one was unreachable for the governed bytes and therefore untestable — a guard nothing
 * can fail is indistinguishable from a guard that is not there.
 *
 * WHAT MAKES A PROGRAM OWE THE GATE: it is THE EXACT-[005] EXECUTION — one unit, version 005, at
 * the governed checksum. All three conjuncts matter and none is decoration:
 *   * `length === 1` is the same exactness `assertExactManagedApplyPlan` enforces. Without it a
 *     plan of [004-forbidden, 005] satisfies `totalCommits === 1` while 004's DDL autocommits
 *     BEFORE the gate ever runs — durable work the gate's refusal cannot reach. It also keeps
 *     ordinary multi-migration applies (001-005 on a fresh database) exactly as they were.
 *   * the CHECKSUM, because a version label is a name: a fixture that calls itself '005' carries
 *     different bytes and is a different migration.
 *
 * WHAT IS NOT CLAIMED: this does not make an EDITED 005 refuse. A drifted artifact simply is not
 * the exact-[005] execution, and refusing it is `createManagedM005Policy`'s job under the lock —
 * where the ledger and the artifact are re-derived. Saying so here rather than implying an
 * executor-level guarantee that lives in a different, separately supplied policy.
 */
export function requiredPreCommitEntryRefusal(
  executionPlan: readonly ExecutionUnit[],
  hasPreCommitPolicy: boolean,
  totalCommits: number,
): string | null {
  const unit = executionPlan.length === 1 ? executionPlan[0] : undefined;
  if (unit === undefined || unit.version !== M005_VERSION || unit.checksum !== M005_UP_SHA256) return null;
  if (!hasPreCommitPolicy) return EXECUTOR_CODES.MANAGED_PRECOMMIT_POLICY_MISSING;
  // Not transaction-scoped means `buildProgram` emits no bracket and no `commit_tx`, so the
  // migration would be durable the instant it executed and there would be nothing left to prevent.
  // `totalCommits !== 1` covers the same hole from the other side: the gate runs before each
  // commit, so a program with none or several is not the single authorized unit.
  if (unit.txScoped !== true || totalCommits !== 1) return EXECUTOR_CODES.MANAGED_PRECOMMIT_NOT_TRANSACTIONAL;
  return null;
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
      // C2B-M005-B1-R3 — THE ONE AUTOCOMMITTED MUTATION ON THIS PATH, recorded rather than assumed.
      //
      // The kernel's `required` grammar is `insert_dirty · ( open_tx · … · commit_tx )`: this write
      // lands in its OWN transaction, BEFORE the bracket, and the engine states as contract that
      // the marker SURVIVES a failure of everything after it. So a later refusal — including the
      // pre-commit ACL gate — leaves a durable `dirty = true` ledger row behind while the migration
      // itself commits nothing. Until this line the report had no field that could say so, and
      // every operator-visible word said the opposite.
      //
      // A FAILURE IS `unknown`, NOT `not_attempted`. `bounded` collapses a rejection and a deadline
      // into one `{ok:false}`, and even a definite client-side rejection cannot prove the server
      // did not apply the insert before the answer was lost. UNKNOWN is absorbing: once a write
      // outcome is undetermined, a later successful one does not restore certainty about the row.
      if (!r.ok) report.dirtyMarkerWrite = 'unknown';
      else if (report.dirtyMarkerWrite !== 'unknown') report.dirtyMarkerWrite = 'succeeded';
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
      // MARKED BEFORE THE AWAIT, deliberately, and this is the only place that can mark it. Once
      // COMMIT is on the wire no client-side outcome — a rejection, a dropped socket, or a deadline
      // that never lets this line resume — can say whether PostgreSQL committed. `bounded` collapses
      // a rejection and a deadline into one `{ok:false}` and drops the driver error, so the runner
      // alone could not tell "commit was never sent" from "its answer never came back".
      report.commit.submitted = true;
      // RESET PER COMMIT. `buildProgram` emits one `commit_tx` per tx-scoped migration, so a plan
      // with two migrations reaches this line twice. Leaving `resolved` latched from the first made
      // a REJECTED second commit report `resolved` — and, worse, opened the compensating unlock's
      // `!== 'unknown'` guard on a session whose commit outcome was genuinely undetermined.
      report.commit.resolved = false;
      const r = await bounded(() => session.commitTx(), deadlineMs, () => {});
      // RESOLVED, not "acknowledged" and not "committed". postgres.js exposes no signal distinct
      // from this promise settling, so naming it anything stronger would be this code asserting a
      // database fact from a client-side event. `acknowledged` stays 'unavailable' for that reason.
      if (r.ok) report.commit.resolved = true;
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
    // timeout: 0 destroys rather than draining — session end drops the advisory lock.
    //
    // The latch is set only AFTER the shutdown resolves, and a rejection is NOT swallowed. This
    // path carried BOTH halves of the managed session's defect: latching first let a FAILING
    // end() disable its own compensating retry (`if (destroyed) return`), and the `.catch(() => {})`
    // reported a disposal that was never achieved — for a backend that may still be alive holding
    // the run's session-scoped advisory lock. The sibling `close()` below already got this right.
    await client.end({ timeout: 0 });
    destroyed = true;
  };
  /** Never-throws wrapper. The HANDLE-level disposer is run from a caller's `finally`, where a
   *  throw would replace the real failure; `session.terminate()` deliberately uses the loud one. */
  const disposeQuietly = async (): Promise<void> => { await dispose().catch(() => {}); };

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
      // FAIL-CLOSED, not coercing. `r.dirty === true` mapped a NULL, a string, or a numeric 0 to
      // `false` — this system's word for "completed cleanly" — so an unrepresentable state read as
      // the safest possible one. `toLedgerRowStrict` refuses instead, at the read, before any
      // planner or gate sees the row. Applied on BOTH adapters: the coercion was identical in each,
      // and leaving the disposable one fail-open would keep the defect alive in the path the
      // integration proofs run through.
      return rows.map((r) => toLedgerRowStrict(r as Record<string, unknown>));
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

  return { adapter, ledger, dispose: disposeQuietly };
}

// ---------------------------------------------------------------------------
// Managed DEV recovery target (Phase 4.0 M3 S4.1b C2B-R2)
//
// A SEPARATE trust boundary, deliberately not a widening of the disposable one. The disposable
// resolver above stays byte-identical: it still refuses every remote endpoint by construction,
// and its tests still prove that. Sharing one resolver across two trust levels would put a
// managed database one predicate-edit away from the throwaway path.
//
// This boundary is narrow by construction rather than by denylist: it accepts ONLY a remote
// session-mode endpoint whose project reference matches an independently supplied project URL
// and whose database name matches an expected literal. There is deliberately no "any remote
// PostgreSQL URL" escape hatch, and nothing here is parameterised by a raw CLI string.
// ---------------------------------------------------------------------------

/**
 * DSN transport values that ASK for something weaker than verified TLS.
 *
 * Mirrors `TLS_DOWNGRADE_VALUES` in the repository's TLS policy module deliberately rather than
 * importing it: this validator must stay free of any edge into the database layer, and the policy
 * module refuses the same values again at construction. A duplicated refusal is cheap; a dynamic
 * import inside the validator is not.
 */
const TLS_DOWNGRADE_REQUESTS: ReadonlySet<string> = new Set(['require', 'allow', 'prefer', 'disable', 'false']);

/** Transaction-pooler ports cannot hold a session advisory lock, so they can never run a run. */
const MANAGED_SESSION_PORTS: ReadonlySet<string> = new Set(['5432']);

/**
 * A canonical ASCII DNS label: 1–63 characters, alphanumeric at BOTH ends, hyphens only inside.
 *
 * This is the whole point of the endpoint grammars below. A suffix test (`host.endsWith(...)`)
 * constrains only the TAIL of a hostname and says nothing about what precedes it — and what
 * precedes it is exactly where `,`, `%`, `:`, `/`, `\` and whitespace live. Those characters are
 * outside this class, so a whole-host match refuses them structurally rather than by denylist.
 */
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/**
 * The SHARED SESSION POOLER host: exactly one provider label before `pooler.supabase.com`.
 *
 * Deliberately prefix-agnostic rather than a region list — `aws-0-eu-west-1` and `aws-1-us-east-2`
 * are both accepted, and the next provider naming change will be too — but bounded to ONE label,
 * so `x.y.pooler.supabase.com`, a bare `pooler.supabase.com` and `.pooler.supabase.com` all fail.
 */
const POOLER_HOST = new RegExp(`^${DNS_LABEL}\\.pooler\\.supabase\\.com$`, 'i');

/** The two endpoint families this repository supports, and nothing else. */
type ManagedEndpointFamily = 'direct' | 'pooler';

/**
 * Classify a managed hostname into an EXACT endpoint family, or refuse it.
 *
 * This replaces a provider-suffix allowlist, and the replacement is the load-bearing part of H2.
 * `host.endsWith('.supabase.co')` accepted `attacker.example,db.<ref>.supabase.co` — a value the
 * repository validator read as ONE opaque host while postgres.js read as a comma-separated
 * MULTIHOST list, dialling `attacker.example` first. Percent-escapes made it worse: the driver
 * `decodeURIComponent`s the authority, so `%3A9999` became an attacker-chosen port and `%2F…` a
 * UNIX socket path, leaving the network entirely.
 *
 * Neither grammar below can express any of those characters, so the whole class dies with the
 * suffix test rather than being enumerated.
 */
function classifyManagedHost(host: string): ManagedEndpointFamily | null {
  if (DB_HOST_REF.test(host)) return 'direct';
  if (POOLER_HOST.test(host)) return 'pooler';
  return null;
}

/** Validated managed handle. Like the disposable one it carries NO credential and NO host. */
export interface ManagedDevDsn {
  readonly kind: 'managed_dev_dsn';
  readonly database: string;
  /** Endpoint family CLASS only — never the host, port, or project reference. */
  readonly endpointFamily: 'session';
}

/**
 * The SEALED effective connection authority for a validated handle.
 *
 * Every field that can influence WHERE the driver connects lives here, extracted once by the
 * validator. Nothing downstream re-parses a connection string to decide a destination.
 */
interface SealedManagedTarget {
  readonly hostFamily: ManagedEndpointFamily;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** Held once, never copied, never described, never logged. */
  readonly password: string;
  /** Input to the TLS POLICY check only — never a routing input. */
  readonly tlsPolicySource: string;
}

const MANAGED_TARGET = new WeakMap<ManagedDevDsn, SealedManagedTarget>();

/**
 * The project-reference grammar, single-sourced.
 *
 * Every parser below builds its pattern from this ONE string. Two hand-copied grammars could
 * drift into accepting different vocabularies, and the looser of the two would then decide which
 * references corroborate — an asymmetry the comparison itself could never detect.
 */
const PROJECT_REF = '[a-z0-9]{16,}';
/**
 * The DIRECT database host form, matched WHOLE: `db.<ref>.supabase.co`, and nothing else.
 *
 * END-ANCHORED on purpose. A prefix-only `^db\.(<ref>)\.` established only that a hostname STARTS
 * like the documented direct endpoint, so `db.<ref>.extra.supabase.co`,
 * `db.<ref>.attacker.supabase.co` and `db.<ref>.supabase.com` each yielded a host-derived project
 * reference and could corroborate against the gateway url. The provider-suffix allowlist bounds
 * such a host to the provider's namespace but does NOT establish the endpoint family — and this
 * validator runs before a privileged database credential is transmitted, so the hostname must be
 * classified exactly, not approximately.
 *
 * `supabase.com` is deliberately NOT accepted here, and the reason is endpoint FAMILY, not mere
 * spelling. The provider documents the direct endpoint on `supabase.co`; `supabase.com` carries
 * POOLER endpoints — the shared `<provider-region-host>.pooler.supabase.com`, and (on paid plans)
 * a co-located dedicated pooler. Whether or not a `db.<ref>.supabase.com` host resolves for some
 * project is therefore beside the point: it would be a POOLER, whose project identity is carried
 * by the `postgres.<ref>` USERNAME and never by a `db.`-prefixed host label. Widening this to
 * `supabase\.(?:co|com)` would let a pooler host inherit DIRECT-host identity from its hostname —
 * a broader rule than the provider documents, and one no configuration in this repository asks
 * for. Every `.supabase.com` value tracked here is the shared-pooler form.
 */
const DB_HOST_REF = new RegExp(`^db\\.(${PROJECT_REF})\\.supabase\\.co$`, 'i');
/**
 * A hostname whose FIRST LABEL is `db` is CLAIMING to be the direct database endpoint.
 *
 * Anchoring DB_HOST_REF alone would have been a REGRESSION rather than only a tightening: making
 * the pattern stricter turns more hostnames into "no host reference", and "no host reference" is
 * the same state the POOLER form legitimately occupies. So `postgres.<A>@db.<B>.extra.supabase.co`
 * — refused before, because a prefix-only rule read `<B>` out of the host and saw it disagree with
 * `<A>` — would instead have fallen through to the username and corroborated as `<A>` while the
 * driver dialled a `<B>`-shaped host. Silence must not be the reward for being malformed.
 *
 * This predicate restores the distinction the anchor erased: `null` from DB_HOST_REF now means
 * "not a direct host" ONLY when nothing claimed to be one. A `db.` first label is a claim, and a
 * claim that does not resolve to the exact documented host fails closed.
 */
const DB_HOST_CLAIM = /^db\./i;
/** The pooler DSN username form, `<role>.<ref>`. */
const USER_REF = new RegExp(`^[a-z0-9_]+\\.(${PROJECT_REF})$`, 'i');
/** A bare reference occupying a single host label. */
const BARE_REF = new RegExp(`^${PROJECT_REF}$`, 'i');

/**
 * Extract a Supabase project reference from a DATABASE host, without ever returning the
 * surrounding host.
 *
 * `db.<ref>.supabase.co` and `aws-0-<region>.pooler.supabase.com` differ in shape, so the
 * reference is taken from the DSN USERNAME (`<role>.<ref>`) for the pooler form and from the
 * host label for the direct form. Both are compared, never printed.
 *
 * The two endpoint families stay SEMANTICALLY SEPARATE here. This function answers exactly one
 * question — "is this the whole documented direct-database hostname, and if so which project?" —
 * and returns null for everything else, the pooler hostname included. A pooler host therefore
 * never acquires a host-derived reference from this path; its identity comes from the username
 * parser alone, which is what keeps a direct-host rule from silently governing a pooler target.
 *
 * Named for its INPUT TYPE, and deliberately NOT shared with the project-URL parser below. The
 * two consume different provider artifacts; a rule wide enough for one must never become
 * reachable from the other, which is exactly what a single generic "parse a ref from a hostname"
 * helper would have made possible.
 */
function dbHostProjectRefOf(host: string): string | null {
  const m = DB_HOST_REF.exec(host);
  return m === null ? null : m[1].toLowerCase();
}

function userProjectRefOf(user: string): string | null {
  const m = USER_REF.exec(user);
  return m === null ? null : m[1].toLowerCase();
}

/**
 * Extract the project reference from the provider's API/Auth GATEWAY url — the `SUPABASE_URL`
 * artifact, whose documented form is `https://<ref>.supabase.co`.
 *
 * This is a SEPARATE input type from the database host, and the provider defines it as such: the
 * gateway and the database/pooler endpoint are different hostnames for the same project. Demanding
 * that the gateway url be spelled as a database host made a correctly configured project
 * unusable, and respelling the variable is not available as a fix — that same value is the
 * JWKS/issuer base, so one spelling cannot serve both roles.
 *
 * The WHOLE url is judged, not merely its hostname. A scheme downgrade, embedded credentials, an
 * unexpected port, a non-root path, a query or a fragment each mean the value is not the
 * documented project url, and a value whose identity cannot be established EXACTLY is refused.
 *
 * The host must be EXACTLY the three labels `<ref>`, `supabase`, `co`. That is what keeps this
 * from degenerating into `hostname.split('.')[0]` — the rejected rule that accepts the first label
 * of ANY hostname and turns the "independent" signal into "whatever the operator typed". Because
 * the shape is exact rather than a suffix test, an extra label in EITHER direction fails on the
 * shape itself: `attacker.<ref>.supabase.co`, `<ref>.attacker.supabase.co`,
 * `<ref>.supabase.co.attacker.example`, a trailing-dot FQDN and every provider lookalike are all
 * refused before any comparison runs.
 */
function apiProjectRefOf(url: URL): string | null {
  if (url.protocol !== 'https:') return null;
  // Credentials are never part of this artifact, and userinfo is the classic way to make a
  // hostile authority read like a provider one.
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  if (url.search !== '' || url.hash !== '') return null;
  // `https:` is a WHATWG "special" scheme, so the host arrives already lowercased and
  // IDNA-normalised: a non-ASCII lookalike label is punycode here and cannot collide with
  // `supabase`. The DSN path cannot rely on that — `postgres:` is not special — which is why it
  // lowercases by hand and this one must not be folded into it.
  const labels = url.hostname.split('.');
  if (labels.length !== 3 || labels[1] !== 'supabase' || labels[2] !== 'co') return null;
  return BARE_REF.test(labels[0]) ? labels[0].toLowerCase() : null;
}

/**
 * Validate a MANAGED DEV connection target. Every refusal happens before any client exists.
 *
 * `projectUrl` is an INDEPENDENT signal (the provider project URL), not a copy of the DSN: the
 * reference parsed from the DSN must equal the reference parsed from that URL. Two readings of
 * the same string would not be two signals, so they are deliberately taken from two variables
 * the operator configures separately.
 */
export function assertManagedDevDsn(raw: unknown, projectUrl: unknown, expectedDatabase: unknown): ManagedDevDsn {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'dsn missing');
  if (typeof projectUrl !== 'string' || projectUrl.trim().length === 0) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'project url missing');
  }
  if (typeof expectedDatabase !== 'string' || expectedDatabase.trim().length === 0) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'expected database missing');
  }
  let url: URL;
  let proj: URL;
  try {
    url = new URL(raw.trim());
    proj = new URL(projectUrl.trim());
  } catch {
    // Neither value is echoed — both are secret-adjacent.
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'scheme must be postgres');
  }
  // --- remote by construction: the disposable path owns local targets --------------------
  const host = url.hostname.toLowerCase();
  if (host === '' || LOOPBACK_HOSTS.has(host) || url.searchParams.get('host') !== null) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE, 'local target belongs to the disposable path');
  }
  // --- endpoint family: an EXACT whole-host classification -------------------------------
  // Load-bearing, and exact rather than suffix-shaped on purpose. For the pooler form the project
  // reference is carried in the USERNAME, so an unconstrained hostname lets
  // `postgres.<real-ref>@attacker.example` satisfy every remaining check. Verified TLS does not
  // close that — it proves the endpoint holds a certificate the configured CA trusts, not that it
  // is the intended endpoint.
  //
  // A SUFFIX test was not enough for a second, sharper reason: it judges only the tail, so
  // `attacker.example,db.<ref>.supabase.co` passed while postgres.js read the same string as a
  // multihost list and dialled `attacker.example`. Classification is now whole-host, so the
  // validator and the driver can no longer disagree about what the authority is.
  // The `db.` first label CLAIMS the direct endpoint. Checked BEFORE classification, and not
  // merely for a nicer error code: the two grammars INTERSECT at exactly one hostname, because
  // `db` is itself a legal DNS label. Without this guard `db.pooler.supabase.com` would classify
  // as a POOLER, take its identity from the username alone, and be ACCEPTED.
  if (DB_HOST_CLAIM.test(host) && !DB_HOST_REF.test(host)) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED, 'not the documented direct database host');
  }
  const endpointFamily = classifyManagedHost(host);
  if (endpointFamily === null) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE, 'hostname is not a documented provider endpoint');
  }
  // --- endpoint family: session mode only ------------------------------------------------
  const port = url.port === '' ? '5432' : url.port;
  if (!MANAGED_SESSION_PORTS.has(port)) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED, 'not a session-mode endpoint');
  }
  for (const [param, isPooled] of POOL_PARAMS) {
    const v = url.searchParams.get(param);
    if (v !== null && isPooled(v)) {
      return fail(EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED, `${param} declares pooling`);
    }
  }
  // --- project reference consistency against an INDEPENDENT source -----------------------
  let declaredUser: string;
  try {
    declaredUser = url.username === '' ? '' : decodeURIComponent(url.username);
  } catch {
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'malformed percent-encoding in user');
  }
  // A DSN can carry a reference in TWO places — the pooler USERNAME and the direct HOST — and a
  // bare `??` lets the username's silently win. If both are present they must AGREE. Otherwise
  // `postgres.<projectA>@db.<projectB>.supabase.co` corroborates against project A's gateway url
  // while the driver dials project B, and the gate that exists to bind the target to the
  // operator's declared project would be certifying the wrong database. A value whose own two
  // halves name different projects has no exact identity, so it is refused rather than resolved
  // by precedence.
  // A ROLE NAME, constrained like every other sealed field. Two things depend on it:
  //
  //  * postgres.js resolves `o.user || o.username || url.username || env.PGUSERNAME || env.PGUSER
  //    || osUsername()` — a `||` chain, so an EMPTY user silently becomes an ambient principal.
  //    The connection would still reach the sealed, TLS-verified host while authenticating as
  //    whoever the environment says, and the routing seam would report `''` while the driver used
  //    something else. A seal that evaporates when its input is empty fails open exactly where it
  //    is supposed to hold, so emptiness is refused rather than defaulted.
  //  * the startup packet is a NUL-separated key/value list, so a NUL inside the role name appends
  //    startup PARAMETERS — `postgres\0options\0-c search_path=…` on a connection that then runs
  //    migration DDL. No documented role name contains one.
  //
  // `postgres`, `postgres.<ref>` and `supabase_admin` all satisfy this; 63 is PostgreSQL's own
  // NAMEDATALEN-1 identifier limit.
  if (!/^[a-z0-9_][a-z0-9_.-]{0,62}$/i.test(declaredUser)) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'dsn does not name a valid role');
  }
  //
  // Which side may speak follows from the FAMILY, not from whichever pattern happens to match: the
  // direct host carries the reference in its label, the pooler host carries none at all and defers
  // to the username. That is also what stops the H1 regression from returning — a malformed
  // `db.`-claiming host can no longer become "no host reference" and quietly inherit the
  // username's identity, because the claim guard above refused it before this point.
  const userRef = userProjectRefOf(declaredUser);
  const hostRef = endpointFamily === 'direct' ? dbHostProjectRefOf(host) : null;
  if (userRef !== null && hostRef !== null && userRef !== hostRef) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH, 'dsn names two different projects');
  }
  const dsnRef = userRef ?? hostRef;
  // The project url is the provider's API GATEWAY url, parsed by its OWN validator against its
  // own exact shape. It is a different artifact from the database host, so the two do not share a
  // rule — and neither rule is `hostname.split('.')[0]`, which would accept the first label of ANY
  // hostname and turn the "independent" signal into "whatever the operator typed".
  //
  // What corroboration means here is bounded on purpose: the two SEPARATELY CONFIGURED values
  // name the same project reference. It is not provider provenance and not a cryptographic proof
  // — the live fingerprint, the verified TLS chain and the certificate/hostname check remain the
  // only evidence about which database actually answers.
  const projRef = apiProjectRefOf(proj);
  if (dsnRef === null || projRef === null || dsnRef !== projRef) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH, 'dsn and project url disagree');
  }
  // --- database name ---------------------------------------------------------------------
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'malformed percent-encoding in database name');
  }
  if (database !== expectedDatabase.trim()) {
    return fail(EXECUTOR_CODES.MANAGED_DSN_DATABASE_MISMATCH, 'unexpected database name');
  }

  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'malformed percent-encoding in password');
  }
  // `pass: o.pass || o.password || url.password || env.PGPASSWORD || ''` is the same falsy chain as
  // the role name, so an empty password is an ambient one. A managed remote endpoint has no
  // passwordless form; refusing here keeps the sealed credential the only credential.
  if (password === '') return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'dsn carries no password');

  const policyUrl = new URL(raw.trim());
  policyUrl.username = '';
  policyUrl.password = '';

  const handle: ManagedDevDsn = Object.freeze({
    kind: 'managed_dev_dsn' as const,
    database,
    endpointFamily: 'session' as const,
  });
  // SEAL the routing components. This is the H2 correction: the raw DSN is no longer the driver's
  // source of truth for WHERE to connect, because the driver parses that string with rules this
  // validator does not share — `decodeURIComponent` on the authority, comma-separated multihost
  // that OUTRANKS `url.hostname`, and a `/` promoting the target to a UNIX socket. Two parsers,
  // one string, two different destinations.
  //
  // Everything that can steer a connection is extracted ONCE, here, after every check has passed,
  // and handed to the driver as explicit options. postgres.js resolves
  // `o.hostname || o.host || multihost || url.hostname` — note `hostname` FIRST, the reverse of
  // what the field names suggest — so an explicit host wins outright, and with no URL string
  // passed at all there is no multihost, no query parameters and no second interpretation to lose
  // to. Only `host` is ever set here; the order is written down because an options object that
  // also carried `hostname` would silently outrank the sealed value.
  MANAGED_TARGET.set(handle, Object.freeze({
    hostFamily: endpointFamily,
    host,
    port: Number(port),
    database,
    user: declaredUser,
    password,
    // Kept for ONE purpose: resolveDatabaseTls inspects `ssl`/`sslmode` for a transport downgrade.
    // It never routes anything, so the QUERY is preserved and the CREDENTIAL is stripped — there is
    // no reason for a password to cross a module boundary to answer a question about transport.
    //
    // HONEST SCOPE: with no connection string reaching the driver, a `?sslmode=disable` can no
    // longer take effect by any path, so this check is now an assertion about operator INTENT
    // rather than the mechanism that stops a downgrade. It refuses; it never permits.
    tlsPolicySource: policyUrl.toString(),
  }));
  return handle;
}

/** The ONLY description of a managed DSN that may be printed. Never the host, port, user or ref. */
export function describeManagedDsn(dsn: ManagedDevDsn): { endpointFamily: 'session'; database: string } {
  return { endpointFamily: dsn.endpointFamily, database: dsn.database };
}

/**
 * VERIFICATION SEAM — the routing the driver will actually be given, minus every secret.
 *
 * Deliberately NOT a description for logs: `describeManagedDsn` above remains the only printable
 * one, and this returns a host and a username precisely because those are the values a test must
 * compare against the driver's own resolved options. Without it, "the driver connects where the
 * validator approved" is an assertion about two things a test can never see at once — which is how
 * the validator and the driver came to disagree in the first place.
 *
 * The password is not exposed and there is no accessor for it anywhere. The pooler USERNAME does
 * embed the project reference, which `describeManagedDsn` deliberately withholds — which is why
 * this is @internal, has no non-test importer, and must never reach a log.
 *
 * @internal verification only — not a printable description.
 */
export function describeManagedDriverRouting(dsn: ManagedDevDsn): {
  hostFamily: ManagedEndpointFamily; host: string; port: number; database: string; user: string;
} {
  const target = MANAGED_TARGET.get(dsn);
  if (target === undefined) return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'unvalidated handle');
  return {
    hostFamily: target.hostFamily,
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
  };
}

// ---------------------------------------------------------------------------
// Per-version historical postconditions
//
// Derived from the IMMUTABLE committed migrations, and cumulative through 004. Each predicate
// must distinguish "this migration really ran" from "a table of the same name exists", so each
// asserts identity-bearing structure (constraints, triggers, partial indexes, RLS) rather than
// mere relation presence.
//
// DELIBERATE OMISSION: 002's own definition of `user_membership_role_scope_chk` is NOT part of
// 002's predicate. Migration 003 legitimately DROPs and re-ADDs that constraint with the
// canonical vocabulary, so requiring 002's legacy form would make a correctly-migrated database
// fail 002 forever. 003's predicate owns that constraint instead.
// ---------------------------------------------------------------------------

/** Canonical platform-scope roles established by immutable migration 003. */
export const CANONICAL_PLATFORM_ROLES: readonly string[] = Object.freeze([
  'system_owner', 'support_admin', 'billing_admin', 'operations_admin', 'security_admin',
]);
/** Canonical tenant/store-scope roles carried through migration 003. */
export const CANONICAL_TENANT_ROLES: readonly string[] = Object.freeze([
  'store_owner', 'manager', 'technician', 'sales_staff',
]);
/** The placeholder vocabulary 003 exists to remove. Any survivor means 003 did not take. */
export const LEGACY_PLATFORM_ROLES: readonly string[] = Object.freeze([
  'platform_owner', 'platform_admin', 'platform_ops', 'platform_support', 'platform_readonly',
]);

export interface PostconditionResult {
  version: string;
  ok: boolean;
  /** Bounded, printable failure labels — never SQL, a value, or a driver message. */
  failed: string[];
}

/** A minimal read-only SQL port. Deliberately separate from ExecutorSession: postcondition
 *  verification must never be able to begin a transaction or execute migration SQL. */
export interface CatalogReadPort {
  /** Run a bounded catalog query with positional parameters and return plain rows. */
  query(text: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

const APP_SCHEMA = 'public';

async function tableWithRls(port: CatalogReadPort, table: string): Promise<boolean> {
  const rows = await port.query(
    `select c.relrowsecurity as rls from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind = 'r'`,
    [APP_SCHEMA, table],
  );
  return rows.length === 1 && rows[0].rls === true;
}

async function constraintOf(
  port: CatalogReadPort, table: string, name: string,
): Promise<{ contype: unknown; convalidated: unknown; def: unknown } | null> {
  const rows = await port.query(
    `select c.contype, c.convalidated, pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = $1 and t.relname = $2 and c.conname = $3`,
    [APP_SCHEMA, table, name],
  );
  return rows.length === 1 ? (rows[0] as { contype: unknown; convalidated: unknown; def: unknown }) : null;
}

async function triggerExists(port: CatalogReadPort, table: string, name: string): Promise<boolean> {
  const rows = await port.query(
    `select 1 as ok from pg_trigger g
       join pg_class t on t.oid = g.tgrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = $1 and t.relname = $2 and g.tgname = $3 and not g.tgisinternal`,
    [APP_SCHEMA, table, name],
  );
  return rows.length === 1;
}

async function indexExists(port: CatalogReadPort, name: string): Promise<boolean> {
  const rows = await port.query(
    `select 1 as ok from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and c.relkind = 'i'`,
    [APP_SCHEMA, name],
  );
  return rows.length === 1;
}

async function functionExists(port: CatalogReadPort, name: string): Promise<boolean> {
  const rows = await port.query(
    `select 1 as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname = $2`,
    [APP_SCHEMA, name],
  );
  return rows.length >= 1;
}

/** 001: the platform_identity foundation. */
async function verify001(port: CatalogReadPort): Promise<string[]> {
  const failed: string[] = [];
  if (!(await tableWithRls(port, 'platform_identity'))) failed.push('platform_identity missing or RLS disabled');
  const uq = await constraintOf(port, 'platform_identity', 'platform_identity_provider_uid_key');
  if (uq === null || uq.contype !== 'u') failed.push('platform_identity_provider_uid_key missing or not unique');
  if (!(await functionExists(port, 'set_platform_identity_updated_at'))) failed.push('set_platform_identity_updated_at missing');
  if (!(await triggerExists(port, 'platform_identity', 'trg_platform_identity_updated_at'))) {
    failed.push('trg_platform_identity_updated_at missing');
  }
  return failed;
}

/** 002: the authorization + append-only audit foundation (six relations). */
async function verify002(port: CatalogReadPort): Promise<string[]> {
  const failed: string[] = [];
  for (const t of ['app_user', 'tenant', 'store', 'user_membership', 'tenant_feature_entitlement', 'audit_event']) {
    if (!(await tableWithRls(port, t))) failed.push(`${t} missing or RLS disabled`);
  }
  for (const fn of ['set_updated_at_timestamp', 'audit_metadata_is_flat', 'reject_audit_event_mutation']) {
    if (!(await functionExists(port, fn))) failed.push(`${fn} missing`);
  }
  // The append-only guarantee is the identity-bearing part of 002 — a same-named audit table
  // without it is not the migration having run.
  if (!(await triggerExists(port, 'audit_event', 'trg_audit_event_reject_mutation'))) {
    failed.push('trg_audit_event_reject_mutation missing');
  }
  const scope = await constraintOf(port, 'user_membership', 'user_membership_scope_consistency_chk');
  if (scope === null || scope.contype !== 'c') failed.push('user_membership_scope_consistency_chk missing');
  const grant = await constraintOf(port, 'user_membership', 'user_membership_unique_grant');
  if (grant === null || grant.contype !== 'u') failed.push('user_membership_unique_grant missing');
  const flat = await constraintOf(port, 'audit_event', 'audit_event_metadata_flat_chk');
  if (flat === null || flat.contype !== 'c') failed.push('audit_event_metadata_flat_chk missing');
  return failed;
}

/**
 * 003: the CRITICAL gate. 003 creates no table, so its ONLY durable distinguishing effect is the
 * redefinition of user_membership_role_scope_chk to the canonical vocabulary. C2B never collected
 * that definition, which is precisely why 003 is the one version with no live corroboration.
 *
 * conname alone proves nothing — constraint names are unique per relation, not per database, and
 * 002 already created a constraint of this exact name carrying the LEGACY vocabulary. The
 * definition is therefore extracted with pg_get_constraintdef() and inspected for the complete
 * canonical role set and the absence of every legacy name.
 */
async function verify003(port: CatalogReadPort): Promise<string[]> {
  const failed: string[] = [];
  const c = await constraintOf(port, 'user_membership', 'user_membership_role_scope_chk');
  if (c === null) return ['user_membership_role_scope_chk missing on public.user_membership'];
  if (c.contype !== 'c') failed.push('user_membership_role_scope_chk is not a CHECK constraint');
  // `convalidated` is false for a NOT VALID constraint: an unenforced guard is not the migration.
  if (c.convalidated !== true) failed.push('user_membership_role_scope_chk is not validated');
  const def = typeof c.def === 'string' ? c.def : '';
  if (def === '') return failed.concat('user_membership_role_scope_chk definition unreadable');
  for (const role of [...CANONICAL_PLATFORM_ROLES, ...CANONICAL_TENANT_ROLES]) {
    if (!new RegExp(`'${role}'`).test(def)) failed.push(`canonical role ${role} absent from the definition`);
  }
  for (const legacy of LEGACY_PLATFORM_ROLES) {
    if (new RegExp(`'${legacy}'`).test(def)) failed.push(`legacy role ${legacy} still present in the definition`);
  }
  // Vocabulary presence alone is not enforcement. A validated constraint of the right name such
  // as `CHECK (true OR role_id = ANY (ARRAY[...all nine...]))` contains every literal and
  // constrains nothing, so the STRUCTURE 003 establishes is checked too: both scope branches
  // must be discriminated, and a tautological disjunct disqualifies the definition.
  if (!/scope_type/.test(def)) failed.push('definition does not discriminate on scope_type');
  for (const scope of ['platform', 'tenant', 'store']) {
    if (!new RegExp(`'${scope}'`).test(def)) failed.push(`scope ${scope} absent from the definition`);
  }
  if (/\b(OR|or)\s+true\b/.test(def) || /\btrue\s+(OR|or)\b/.test(def)) {
    failed.push('definition contains a tautological disjunct and enforces nothing');
  }
  return failed;
}

/** 004: the identity_link surface, identified by its partial-unique active-link indexes. */
async function verify004(port: CatalogReadPort): Promise<string[]> {
  const failed: string[] = [];
  if (!(await tableWithRls(port, 'identity_link'))) failed.push('identity_link missing or RLS disabled');
  for (const ix of ['uq_identity_link_active_firebase', 'uq_identity_link_active_supabase', 'uq_identity_link_active_pair']) {
    if (!(await indexExists(port, ix))) failed.push(`${ix} missing`);
  }
  for (const ck of ['identity_link_status_chk', 'identity_link_verification_method_chk']) {
    const c = await constraintOf(port, 'identity_link', ck);
    if (c === null || c.contype !== 'c') failed.push(`${ck} missing`);
  }
  for (const fk of ['identity_link_firebase_ref_fk', 'identity_link_supabase_ref_fk']) {
    const c = await constraintOf(port, 'identity_link', fk);
    if (c === null || c.contype !== 'f') failed.push(`${fk} missing`);
  }
  if (!(await triggerExists(port, 'identity_link', 'trg_identity_link_updated_at'))) {
    failed.push('trg_identity_link_updated_at missing');
  }
  return failed;
}

const POSTCONDITION_VERIFIERS: Readonly<Record<string, (p: CatalogReadPort) => Promise<string[]>>> = Object.freeze({
  '001': verify001,
  '002': verify002,
  '003': verify003,
  '004': verify004,
});

/**
 * Verify EVERY requested version's postconditions. A version with no registered verifier is a
 * refusal, not a pass: an unverifiable version must never be adoptable.
 */
export async function verifyHistoricalPostconditions(
  port: CatalogReadPort,
  versions: readonly string[],
): Promise<PostconditionResult[]> {
  const out: PostconditionResult[] = [];
  for (const version of versions) {
    const verifier = POSTCONDITION_VERIFIERS[version];
    if (verifier === undefined) {
      out.push({ version, ok: false, failed: ['no postcondition verifier is registered for this version'] });
      continue;
    }
    const failed = await verifier(port);
    out.push({ version, ok: failed.length === 0, failed });
  }
  return out;
}

/**
 * Pre-005 sentinel. Adoption of 001-004 must fail closed if the database already carries
 * migration-005 state, because that would mean 005 ran outside the ledger and the "005 is the
 * sole pending version" conclusion the whole recovery rests on would be false.
 *
 * The sentinels are 005's OWN postconditions: its audit scope constraint, its two NOLOGIN
 * privilege roles, and its policies.
 */
export async function detectPre005Residue(port: CatalogReadPort): Promise<string[]> {
  const residue: string[] = [];
  const chk = await constraintOf(port, 'audit_event', 'audit_event_scope_consistency_chk');
  if (chk !== null) residue.push('audit_event_scope_consistency_chk present (a 005 postcondition)');
  const roles = await port.query(
    `select rolname from pg_roles where rolname in ('tmpos_app','tmpos_audit_writer') order by rolname`, [],
  );
  for (const r of roles) residue.push(`privilege role ${String(r.rolname)} present (a 005 postcondition)`);
  const pols = await port.query(
    `select count(*)::text as n from pg_policies where schemaname = $1`, [APP_SCHEMA],
  );
  if (pols.length === 1 && pols[0].n !== '0') residue.push('RLS policies already present (a 005 postcondition)');
  return residue;
}

// ---------------------------------------------------------------------------
// C2B-M005-B0 — the migration-ledger RELATION CONTRACT
//
// WHY THIS EXISTS. `LEDGER_DDL` is `create table if not exists`, which is a silent no-op against a
// relation that already carries the name and ANY definition at all. Every later step then trusts a
// shape nothing checked: `insertDirtyAttempt` names four columns and relies on the fifth being
// nullable, `finalizeApplied` asserts `count === 1` and relies on `version` being unique, and the
// apply gate turns entirely on `dirty`. A view, a pre-existing table with a nullable `dirty`, or an
// extra NOT NULL column with no default each break one of those in a different place and none of
// them raises where the assumption was made.
//
// The contract is stated as DATA rather than as prose about the DDL so a test can compare the two
// directly, and so a future DDL edit that forgets this list is a failing assertion rather than a
// silently weaker gate.
// ---------------------------------------------------------------------------

/** The one relation this module writes. Schema-qualified, because `public` is not a given. */
export const LEDGER_RELATION = Object.freeze({ schema: APP_SCHEMA, table: 'schema_migrations' });

export interface LedgerColumnContract {
  readonly name: string;
  /** `pg_catalog.format_type` output — the resolved type, not the spelling used in the DDL. */
  readonly type: string;
  readonly notNull: boolean;
  /** Required default expression, or null when the contract requires nothing in particular. */
  readonly defaultExpr: string | null;
}

/** Derived from LEDGER_DDL. A test asserts the two agree, so they cannot drift apart silently. */
export const LEDGER_COLUMN_CONTRACT: readonly LedgerColumnContract[] = Object.freeze([
  Object.freeze({ name: 'version', type: 'text', notNull: true, defaultExpr: null }),
  Object.freeze({ name: 'checksum', type: 'text', notNull: true, defaultExpr: null }),
  Object.freeze({ name: 'dirty', type: 'boolean', notNull: true, defaultExpr: 'true' }),
  Object.freeze({ name: 'started_at', type: 'timestamp with time zone', notNull: true, defaultExpr: null }),
  Object.freeze({ name: 'finished_at', type: 'timestamp with time zone', notNull: false, defaultExpr: null }),
]);

/**
 * THE CLOSED SET OF WAYS A LEDGER RELATION CAN DISAGREE WITH THE CONTRACT.
 *
 * `failed` below carries a human-readable reason per finding, and every one of those strings names
 * the thing it found: a column, a type, a default expression, a constraint. That makes the reason
 * list unpublishable — an operator record may not carry a catalog identifier — and it is why the
 * accepted renderer printed one aggregate MISMATCH token and discarded WHICH check failed.
 *
 * These categories are the publishable half of the same finding: fixed source constants, chosen at
 * the guard that produced the reason rather than recovered afterwards by matching its text. A
 * reason string may be reworded freely without moving a category, and no catalog value can enter
 * one, because none of them is built from a catalog value.
 */
export type LedgerShapeCategory =
  | 'RELATION_ABSENT'
  | 'RELATION_KIND'
  | 'ROW_LEVEL_SECURITY'
  | 'COLUMN_MISSING'
  | 'COLUMN_TYPE'
  | 'COLUMN_GENERATED_OR_IDENTITY'
  | 'COLUMN_NULLABILITY'
  | 'COLUMN_DEFAULT'
  | 'EXTRA_REQUIRED_COLUMN'
  | 'UNDECLARED_CHECK'
  | 'PRIMARY_KEY';

/**
 * The ONE canonical render order, and the closed membership test.
 *
 * Discovery order is not stable: the column loop visits `LEDGER_COLUMN_CONTRACT` in order but the
 * extra-column and check-constraint loops walk catalog results, so two databases with the same
 * defects could otherwise print the same set in two different sequences and read as two findings.
 */
export const LEDGER_SHAPE_CATEGORY_ORDER: readonly LedgerShapeCategory[] = Object.freeze([
  'RELATION_ABSENT',
  'RELATION_KIND',
  'ROW_LEVEL_SECURITY',
  'COLUMN_MISSING',
  'COLUMN_TYPE',
  'COLUMN_GENERATED_OR_IDENTITY',
  'COLUMN_NULLABILITY',
  'COLUMN_DEFAULT',
  'EXTRA_REQUIRED_COLUMN',
  'UNDECLARED_CHECK',
  'PRIMARY_KEY',
] as const);

/** Deduplicate and impose the canonical order. Unknown members are dropped by construction. */
export function canonicalLedgerShapeCategories(
  found: Iterable<LedgerShapeCategory>,
): LedgerShapeCategory[] {
  const set = new Set<LedgerShapeCategory>(found);
  return LEDGER_SHAPE_CATEGORY_ORDER.filter((c) => set.has(c));
}

export interface LedgerShapeResult {
  readonly present: boolean;
  /** Human-readable, IDENTIFIER-BEARING and therefore never publishable. Internal use only. */
  readonly failed: string[];
  /** The publishable, closed, canonically ordered classification of the same findings. */
  readonly categories: LedgerShapeCategory[];
}

/**
 * Validate an EXISTING ledger relation against the contract. Returns bounded failure labels.
 *
 * ABSENCE IS NOT A FAILURE, and that is deliberate: the apply path's own `insertDirtyAttempt`
 * issues `LEDGER_DDL` before its first insert, so a database with no ledger at all is the ordinary
 * first-run state. What this refuses is a relation that EXISTS and is not the one this code writes
 * — the case `create table if not exists` cannot detect and every later step assumes away.
 *
 * EXTRA COLUMNS are tolerated under exactly one proof: `insertDirtyAttempt` names four columns and
 * `writeAdoptedPrefix` names five, so any column outside the contract must be satisfiable without
 * being named — i.e. nullable, or carrying a default. A NOT NULL extra column with no default would
 * make every insert fail at runtime, which is a refusal now rather than a mid-run failure later.
 */
export async function verifyLedgerShape(port: CatalogReadPort): Promise<LedgerShapeResult> {
  const failed: string[] = [];
  // Chosen at the guard, so a category cannot drift from the finding that produced it.
  const found = new Set<LedgerShapeCategory>();
  const done = (present: boolean): LedgerShapeResult =>
    ({ present, failed, categories: canonicalLedgerShapeCategories(found) });
  const rel = await port.query(
    `select c.relkind::text as kind, c.relrowsecurity as rls from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table],
  );
  if (rel.length === 0) {
    // THE FINDING WITH NO REASON STRING. `failed` stays empty here — absence is not a contract
    // violation for the apply path, which creates the relation — but the preflight's classifier
    // still reads this as a MISMATCH, and an empty reason list left it a mismatch with no stated
    // cause. The category is the cause, and it is why it must be set where the list is not.
    found.add('RELATION_ABSENT');
    return done(false);
  }
  if (rel.length > 1) {
    // Two relations cannot share a name in one schema, so this is an unreadable catalog rather
    // than a shape problem. Refusing beats picking one of them.
    // NO CATEGORY. This is the one unreadable case, and a mismatch category here would let an
    // unmeasurable shape reach the operator as an observed disagreement.
    failed.push('ledger relation ambiguous in catalog');
    return done(true);
  }
  if (rel[0].kind !== 'r') {
    // A view, foreign table or partitioned parent accepts some of these statements and silently
    // changes what `count === 1` and `on conflict` mean. Only an ordinary table is the contract.
    failed.push(`ledger relation is relkind ${String(rel[0].kind)}, not an ordinary table`);
    found.add('RELATION_KIND');
    return done(true);
  }

  // RLS ON THE LEDGER READS FAIL-OPEN, which is the direction that matters: a policy that hides
  // every row makes `readLedger` return zero rows, and zero rows is this system's evidence that a
  // migration has never been applied. `create table if not exists` cannot see this either.
  if (rel[0].rls === true) {
    failed.push('ledger relation has row-level security enabled');
    found.add('ROW_LEVEL_SECURITY');
  }

  const cols = await port.query(
    `select a.attname::text as name,
            a.attgenerated::text as generated,
            a.attidentity::text as identity,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as notnull,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) as def
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table],
  );
  const byName = new Map<string, Record<string, unknown>>();
  for (const c of cols) byName.set(String(c.name), c);

  for (const want of LEDGER_COLUMN_CONTRACT) {
    const got = byName.get(want.name);
    if (got === undefined) {
      failed.push(`ledger column ${want.name} missing`);
      found.add('COLUMN_MISSING');
      continue;
    }
    if (String(got.type) !== want.type) {
      failed.push(`ledger column ${want.name} is ${String(got.type)}, expected ${want.type}`);
      found.add('COLUMN_TYPE');
    }
    // A generated or identity column passes type, nullability and "no default required" and then
    // rejects every INSERT that names it (428C9) — the mid-run failure this function replaces.
    if (String(got.generated ?? '') !== '' || String(got.identity ?? '') !== '') {
      failed.push(`ledger column ${want.name} is generated or an identity column`);
      found.add('COLUMN_GENERATED_OR_IDENTITY');
    }
    if ((got.notnull === true) !== want.notNull) {
      failed.push(`ledger column ${want.name} nullability differs`);
      found.add('COLUMN_NULLABILITY');
    }
    // A default is required only where the contract names one. `dirty default true` is the reason
    // `insertDirtyAttempt` may name it explicitly and `writeAdoptedPrefix` may not rely on it.
    if (want.defaultExpr !== null && String(got.def ?? '') !== want.defaultExpr) {
      failed.push(`ledger column ${want.name} default differs`);
      found.add('COLUMN_DEFAULT');
    }
  }
  for (const [name, got] of byName) {
    if (LEDGER_COLUMN_CONTRACT.some((c) => c.name === name)) continue;
    // The tolerance proof, applied per column rather than assumed for the set.
    // A generated or identity column supplies its own value, so it satisfies an unnamed INSERT
    // exactly as a default does — it just has no `pg_attrdef` row to prove it.
    const selfSupplying = String(got.generated ?? '') !== '' || String(got.identity ?? '') !== '';
    if (got.notnull === true && !selfSupplying && (got.def === null || got.def === undefined)) {
      failed.push(`ledger column ${name} is an unexpected NOT NULL column with no default`);
      found.add('EXTRA_REQUIRED_COLUMN');
    }
  }

  // CHECK CONSTRAINTS. The contract defines none, and an undeclared one can defeat a write the
  // shape check otherwise approves: `CHECK (dirty = false)` passes every column test above and then
  // rejects `insertDirtyAttempt`, whose whole purpose is to write `dirty = true` first.
  const checks = await port.query(
    `select k.conname::text as name from pg_catalog.pg_constraint k
       join pg_catalog.pg_class c on c.oid = k.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and k.contype = 'c'`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table],
  );
  for (const c of checks) {
    failed.push(`ledger carries an undeclared check constraint ${String(c.name)}`);
    found.add('UNDECLARED_CHECK');
  }

  // STRUCTURAL, not the rendered definition text. `pg_get_constraintdef` appends INCLUDE (...),
  // WITH (fillfactor=...), USING INDEX TABLESPACE ... and DEFERRABLE decorations, so string equality
  // refuses a functionally identical primary key created in a non-default tablespace. The column
  // set is the contract; its rendering is not.
  const pk = await port.query(
    `select array_to_string(array(
              select a.attname::text from pg_catalog.pg_attribute a
               where a.attrelid = k.conrelid and a.attnum = any(k.conkey)
               order by a.attnum), ',') as cols
       from pg_catalog.pg_constraint k
       join pg_catalog.pg_class c on c.oid = k.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2 and k.contype = 'p'`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table],
  );
  // `finalizeApplied` asserts `count === 1` for a version, and the baseline write relies on the
  // primary key to refuse a racing duplicate. Both are the uniqueness contract, not a nicety.
  if (pk.length !== 1 || String(pk[0].cols ?? '') !== 'version') {
    failed.push('ledger primary key is not exactly the version column');
    found.add('PRIMARY_KEY');
  }
  return done(true);
}

/**
 * The ONLY accepted reading of a ledger `dirty` value.
 *
 * `r.dirty === true` was fail-OPEN in the one direction that matters: a NULL, a string `'f'`, or a
 * driver that returned `0` all collapsed to `false`, and `false` is this system's word for "this
 * migration completed cleanly". Returning `null` for everything outside the two literal booleans
 * makes an unrepresentable value a refusal at the read, before any planner sees it.
 */
export function normalizeLedgerDirty(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/** Map one driver row to a LedgerRow, refusing rather than coercing an unrepresentable state. */
export function toLedgerRowStrict(raw: Record<string, unknown>): LedgerRow {
  // VERSION AND CHECKSUM TOO. `String(null)` is the literal `'null'`, and the prologue ledger read
  // runs BEFORE the lock and before any shape check — which is exactly the unshaped relation this
  // function exists for. Coercing there would put `'null'` into a planner's history.
  if (typeof raw.version !== 'string' || typeof raw.checksum !== 'string') {
    throw new MigrationExecutorError(EXECUTOR_CODES.LEDGER_DIRTY_STATE_INVALID, 'ledger row shape');
  }
  const dirty = normalizeLedgerDirty(raw.dirty);
  if (dirty === null) {
    // The VERSION is named because it is already a ledger key an operator can look up; the value
    // that failed is deliberately not echoed — a malformed column can hold anything at all.
    throw new MigrationExecutorError(
      EXECUTOR_CODES.LEDGER_DIRTY_STATE_INVALID,
      `version ${String(raw.version).slice(0, 16)}`,
    );
  }
  return { version: String(raw.version), checksum: String(raw.checksum), dirty };
}

/**
 * Migration 005's own postconditions, in the POSITIVE direction.
 *
 * `detectPre005Residue` asks whether any of this is present BEFORE 005 runs; this asks whether all
 * of it is present after. They are deliberately separate functions rather than one negated call:
 * the sentinel must fire on ANY residue (a partial 005 is exactly what it exists to catch), while
 * the postcondition must require EVERY object (a partial 005 is exactly what it exists to catch
 * too, from the other side). Sharing one predicate would make one of the two wrong.
 *
 * Bounded to catalog reads that the migration itself establishes: the two marked roles, the audit
 * constraint, the five policies, the schema posture and the grant matrix.
 */
export async function verify005Postconditions(port: CatalogReadPort): Promise<string[]> {
  const failed: string[] = [];

  const MARKERS: readonly (readonly [string, string])[] = Object.freeze([
    Object.freeze(['tmpos_app', 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:tenant-runtime'] as const),
    Object.freeze(['tmpos_audit_writer', 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:audit-append'] as const),
  ]);
  for (const [role, marker] of MARKERS) {
    const rows = await port.query(
      `select p.rolcanlogin as canlogin, p.rolsuper as super, p.rolcreatedb as createdb,
              p.rolcreaterole as createrole, p.rolreplication as repl, p.rolbypassrls as bypass,
              pg_catalog.shobj_description(p.oid, 'pg_authid') as marker
         from pg_catalog.pg_roles p where p.rolname = $1`,
      [role],
    );
    if (rows.length !== 1) {
      failed.push(`privilege role ${role} absent`);
      continue;
    }
    const r = rows[0];
    if (r.canlogin === true || r.super === true || r.createdb === true
      || r.createrole === true || r.repl === true || r.bypass === true) {
      failed.push(`privilege role ${role} carries attributes 005 never grants`);
    }
    // The marker is what the DOWN migration matches before it removes anything, so a role that is
    // present but unmarked is not the role 005 created — the same distinction, checked upward.
    if (String(r.marker ?? '') !== marker) failed.push(`privilege role ${role} does not carry the 005 ownership marker`);
  }

  const chk = await constraintOf(port, 'audit_event', 'audit_event_scope_consistency_chk');
  if (chk === null) failed.push('audit_event_scope_consistency_chk absent');
  else if (chk.contype !== 'c') failed.push('audit_event_scope_consistency_chk is not a check constraint');
  else if (chk.convalidated !== true) failed.push('audit_event_scope_consistency_chk is not validated');
  // EXPRESSION, not just presence. `CHECK (true)` is a validated check constraint of the right name
  // and constrains nothing; the three scope arms are what the constraint is for.
  else {
    const def = String(chk.def ?? '');
    for (const arm of ['scope_type', 'tenant_id', 'store_id']) {
      if (!def.includes(arm)) failed.push(`audit_event_scope_consistency_chk does not constrain ${arm}`);
    }
  }

  // ROW SECURITY MUST BE ON. `pg_policies` lists a policy whether or not the table enforces row
  // security, so all five names can be present and every one of them inert. 005 relies on 001/002
  // to have enabled it, which means nothing on this path checked it before.
  for (const table of ['tenant', 'store', 'user_membership', 'tenant_feature_entitlement', 'audit_event']) {
    if (!(await tableWithRls(port, table))) failed.push(`${table} does not enforce row-level security`);
  }

  const POLICIES: readonly (readonly [string, string])[] = Object.freeze([
    Object.freeze(['tenant', 'tmpos_app_tenant_scope'] as const),
    Object.freeze(['store', 'tmpos_app_store_scope'] as const),
    Object.freeze(['user_membership', 'tmpos_app_membership_scope'] as const),
    Object.freeze(['tenant_feature_entitlement', 'tmpos_app_entitlement_scope'] as const),
    Object.freeze(['audit_event', 'tmpos_audit_writer_append'] as const),
  ]);
  for (const [table, policy] of POLICIES) {
    // NAME, COMMAND AND ROLE. A name alone is not the policy: a same-named `FOR ALL ... USING
    // (true)` policy would satisfy a name check while opening exactly what 005 exists to close.
    const rows = await port.query(
      `select p.cmd::text as cmd, array_to_string(p.roles, ',') as roles
         from pg_catalog.pg_policies p
        where p.schemaname = $1 and p.tablename = $2 and p.policyname = $3`,
      [APP_SCHEMA, table, policy],
    );
    if (rows.length !== 1) {
      failed.push(`policy ${policy} on ${table} absent`);
      continue;
    }
    const wantCmd = policy === 'tmpos_audit_writer_append' ? 'INSERT' : 'ALL';
    const wantRole = policy === 'tmpos_audit_writer_append' ? 'tmpos_audit_writer' : 'tmpos_app';
    if (String(rows[0].cmd) !== wantCmd) failed.push(`policy ${policy} applies to ${String(rows[0].cmd)}, not ${wantCmd}`);
    if (String(rows[0].roles ?? '') !== wantRole) failed.push(`policy ${policy} is not bound to ${wantRole} alone`);
  }

  // EARLY RETURN ON AN ABSENT ROLE. `has_table_privilege('tmpos_app', ...)` RAISES when the role
  // does not exist, and that throw escaped to the policy's catch — so "the roles are missing", the
  // single most likely real failure, was reported as a generic port failure with none of the labels
  // already collected. Returning here keeps the diagnosis.
  if (failed.some((f) => /^privilege role \S+ absent$/.test(f))) return failed;

  // The grant matrix, asked as EFFECTIVE privilege rather than read out of an ACL array: a grant
  // reaching the role through PUBLIC or a membership is still a grant, and the matrix is a
  // statement about what the role can do, not about which catalog row says so.
  const GRANTS: readonly (readonly [string, string, string, boolean])[] = Object.freeze([
    Object.freeze(['tmpos_app', 'tenant', 'SELECT', true] as const),
    Object.freeze(['tmpos_app', 'store', 'SELECT', true] as const),
    Object.freeze(['tmpos_app', 'store', 'INSERT', true] as const),
    Object.freeze(['tmpos_app', 'user_membership', 'SELECT', true] as const),
    Object.freeze(['tmpos_app', 'tenant_feature_entitlement', 'SELECT', true] as const),
    Object.freeze(['tmpos_audit_writer', 'audit_event', 'INSERT', true] as const),
    // The absences are as load-bearing as the presences: DELETE anywhere, and any read for the
    // append-only writer, are the two the matrix comment calls out by name.
    Object.freeze(['tmpos_app', 'tenant', 'DELETE', false] as const),
    Object.freeze(['tmpos_app', 'store', 'DELETE', false] as const),
    Object.freeze(['tmpos_audit_writer', 'audit_event', 'SELECT', false] as const),
    Object.freeze(['tmpos_app', 'platform_identity', 'SELECT', false] as const),
  ]);
  for (const [role, table, priv, want] of GRANTS) {
    // PER-PROBE GUARD: `has_table_privilege` raises on a missing relation, and one absent table
    // must not discard every finding gathered so far.
    try {
      const rows = await port.query(
        `select pg_catalog.has_table_privilege($1, $2, $3) as ok`,
        [role, `${APP_SCHEMA}.${table}`, priv],
      );
      if ((rows[0]?.ok === true) !== want) failed.push(`${role} ${priv} on ${table} is not the 005 posture`);
    } catch {
      failed.push(`${role} ${priv} on ${table} could not be determined`);
    }
  }

  // Column-scoped UPDATE: the whole reason section 8 of the migration uses a column list.
  const COLUMN_GRANTS: readonly (readonly [string, string, string, boolean])[] = Object.freeze([
    Object.freeze(['tmpos_app', 'tenant', 'display_name', true] as const),
    Object.freeze(['tmpos_app', 'tenant', 'legal_name', true] as const),
    Object.freeze(['tmpos_app', 'tenant', 'status', false] as const),
    Object.freeze(['tmpos_app', 'tenant', 'plan_key', false] as const),
    Object.freeze(['tmpos_app', 'store', 'store_name', true] as const),
    Object.freeze(['tmpos_app', 'store', 'status', false] as const),
  ]);
  for (const [role, table, column, want] of COLUMN_GRANTS) {
    try {
      const rows = await port.query(
        `select pg_catalog.has_column_privilege($1, $2, $3, 'UPDATE') as ok`,
        [role, `${APP_SCHEMA}.${table}`, column],
      );
      if ((rows[0]?.ok === true) !== want) failed.push(`${role} UPDATE on ${table}.${column} is not the 005 posture`);
    } catch {
      failed.push(`${role} UPDATE on ${table}.${column} could not be determined`);
    }
  }

  const schema = await port.query(
    `select pg_catalog.has_schema_privilege($1, $2, 'USAGE')  as usage_app,
            pg_catalog.has_schema_privilege($1, $2, 'CREATE') as create_app,
            pg_catalog.has_schema_privilege('public', $2, 'CREATE') as create_public`,
    ['tmpos_app', APP_SCHEMA],
  );
  if (schema[0]?.usage_app !== true) failed.push('tmpos_app lacks USAGE on the application schema');
  if (schema[0]?.create_app !== false) failed.push('tmpos_app still holds CREATE on the application schema');
  if (schema[0]?.create_public !== false) failed.push('PUBLIC still holds CREATE on the application schema');

  // THE AUDIT WRITER'S SCHEMA CREATE, checked separately because it was checked NOWHERE.
  // `revoke create on schema public from public, anon, authenticated` does not name this role, so
  // its CREATE is closed only as long as it inherits nothing. That matters more here than for the
  // tenant runtime: the default-privilege postcondition below is scoped to the MIGRATION principal,
  // so an object this role creates would carry PostgreSQL's built-in defaults with no coverage at
  // all. Denying CREATE is what keeps that case out of existence.
  const writerSchema = await port.query(
    `select pg_catalog.has_schema_privilege($1, $2, 'USAGE')  as usage_writer,
            pg_catalog.has_schema_privilege($1, $2, 'CREATE') as create_writer`,
    ['tmpos_audit_writer', APP_SCHEMA],
  );
  if (writerSchema[0]?.usage_writer !== true) failed.push('tmpos_audit_writer lacks USAGE on the application schema');
  if (writerSchema[0]?.create_writer !== false) failed.push('tmpos_audit_writer still holds CREATE on the application schema');

  return failed;
}

// -----------------------------------------------------------------------------
// Migration 005: future-object (default) privileges
// -----------------------------------------------------------------------------
/**
 * The object classes migration 005 actually touches, DERIVED from its three unchanged statements:
 *
 *   alter default privileges                 revoke all on functions from public, anon, authenticated;
 *   alter default privileges in schema public revoke all on tables    from public, anon, authenticated;
 *   alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
 *   alter default privileges in schema public revoke all on functions from public, anon, authenticated;
 *
 * One GLOBAL statement for functions and three IN SCHEMA public statements; three grantees; no FOR
 * ROLE clause. So the effect is scoped to FUTURE OBJECTS TO WHICH THIS PRINCIPAL'S DEFAULT
 * PRIVILEGES APPLY — objects OWNED AT CREATION by the role whose default ACL was altered — and to
 * no other role. Owner, not issuer: PostgreSQL matches pg_default_acl on the new object's owner, so
 * an object created under `CREATE SCHEMA ... AUTHORIZATION other`, or an identity/serial sequence
 * generated on another role's table, takes THAT role's defaults instead; `ALTER ... OWNER TO` does
 * not re-derive an ACL already computed; and a role this principal is merely a MEMBER of has its
 * own defaults, not these. This is not owner-independent hardening and is not a provider-wide
 * claim.
 *
 * `builtinGrantsPublic` is the half that cannot be read out of the migration text. PostgreSQL ships
 * a hard-wired default ACL per object class, and for FUNCTIONS that default grants EXECUTE to
 * PUBLIC. For TABLES and SEQUENCES it grants PUBLIC nothing. That asymmetry is the whole reason
 * absence of a catalog row means different things per class: no row for tables is already the
 * closed posture, while no row for functions means PUBLIC still holds EXECUTE on every function
 * future object to which this principal's defaults apply. A verifier treating "no row" as clean
 * across the board would pass exactly the state the global FUNCTIONS statement exists to prevent.
 */
export const M005_DEFAULT_ACL_CLASSES: readonly {
  readonly objtype: string;
  readonly label: string;
  readonly builtinGrantsPublic: boolean;
  /** Migration 005 issues `ALTER DEFAULT PRIVILEGES REVOKE ... ON <class>` with NO `IN SCHEMA`. */
  readonly globallyRevokedByM005: boolean;
  /** Migration 005 issues `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ... ON <class>`. */
  readonly schemaRevokedByM005: boolean;
}[] =
  Object.freeze([
    Object.freeze({ objtype: 'r', label: 'tables', builtinGrantsPublic: false, globallyRevokedByM005: false, schemaRevokedByM005: true }),
    Object.freeze({ objtype: 'S', label: 'sequences', builtinGrantsPublic: false, globallyRevokedByM005: false, schemaRevokedByM005: true }),
    Object.freeze({ objtype: 'f', label: 'functions', builtinGrantsPublic: true, globallyRevokedByM005: true, schemaRevokedByM005: true }),
  ]);

/**
 * The object-class predicate fragment, GENERATED from `M005_DEFAULT_ACL_CLASSES`.
 *
 * The hand-written `('r', 'S', 'f')` literal this replaces was an INDEPENDENT source of truth: the
 * class set could gain a class and the row budget would still be spent on the old three, or lose
 * one and the query would keep fetching rows nothing classifies. Generating it removes the second
 * copy — there is now one frozen list, and the statement cannot describe a different one.
 *
 * NO CALLER-SUPPLIED STRING REACHES SQL TEXT. The only values interpolated are `objtype` fields of
 * the module-level frozen constant, and each is re-proved to be a single ASCII letter at generation
 * time; anything else throws here rather than reaching the server. `pg_default_acl.defaclobjtype`
 * is a one-byte `"char"`, so a single ASCII letter is the whole legal domain and the check is a
 * complete one rather than a filter.
 */
export function defaultAclObjtypePredicate(
  classes: readonly { readonly objtype: string }[] = M005_DEFAULT_ACL_CLASSES,
): string {
  if (classes.length === 0) throw new MigrationExecutorError(EXECUTOR_CODES.PORT_FAILED, 'no governed default-acl classes');
  const literals = classes.map((c) => {
    if (typeof c.objtype !== 'string' || !/^[A-Za-z]$/.test(c.objtype)) {
      throw new MigrationExecutorError(EXECUTOR_CODES.PORT_FAILED, 'invalid default-acl object class');
    }
    return `'${c.objtype}'`;
  });
  return `d.defaclobjtype in (${literals.join(', ')})`;
}

/**
 * Default-ACL object classes PostgreSQL supports that migration 005 does NOT touch.
 *
 * RECORDED, NOT REQUIRED. `T` (types: domains, enums, composite types) has a hard-wired default of
 * USAGE to PUBLIC, exactly the shape the FUNCTIONS statement exists to close — and migration 005
 * issues no statement for it. Adding `T` to the required set would make a correct application of
 * the frozen migration fail its own postcondition, which would be a false alarm about the verifier
 * rather than a true one about the database. So it is named here instead, and a test asserts both
 * that 005 still contains no TYPES statement and that this list is what the verifier deliberately
 * omits — so the day 005 gains that statement, the omission has to be revisited rather than
 * silently outlived. The residual itself is reported as an open finding, not closed here.
 */
export const M005_UNCOVERED_DEFAULT_ACL_CLASSES: readonly { readonly objtype: string; readonly label: string }[] =
  Object.freeze([
    Object.freeze({ objtype: 'T', label: 'types' }),
    Object.freeze({ objtype: 'n', label: 'schemas' }),
  ]);

/** The grantees the three statements revoke from. `PUBLIC` is the pseudo-role, not a named role. */
export const M005_DEFAULT_ACL_GRANTEES: readonly string[] = Object.freeze(['public', 'anon', 'authenticated']);

/**
 * Decide the default-privilege posture from catalog rows, as a PURE FUNCTION.
 *
 * Pure because the interesting failures here are not SQL failures — they are reasoning failures
 * about how two catalog scopes combine, and a port-driven test cannot mutate the reasoning without
 * also mutating the query. Four of them, stated so a later edit has to argue with them:
 *
 *   1. A GLOBAL row (defaclnamespace = 0) and a PUBLIC-SCHEMA row are BOTH applicable to an object
 *      created in `public`. Reading only one is the omission this function exists to prevent.
 *   2. A per-schema revoke-like state does NOT negate an applicable global grant. This function
 *      therefore fails on ANY positive grant to a revoked grantee in EITHER scope, and never
 *      credits a schema row as cancelling a global one. Absence of a schema row is not evidence.
 *   3. The BASE ACL is the GLOBAL row's ACL when a global row exists and PostgreSQL's hard-wired
 *      `acldefault()` when it does not; the per-schema row is MERGED ON TOP of whichever base was
 *      chosen and never replaces it. A per-schema row therefore cannot subtract anything, so for a
 *      class whose hard-wired default grants PUBLIC, only a GLOBAL row can close it — schema-row
 *      presence must never suppress the hard-wired fallback.
 *   4. The rows must belong to the EXECUTING PRINCIPAL. A revoke performed by `supabase_admin`
 *      closes nothing for future objects to which THIS principal's defaults apply, so a row owned
 *      by another role is recorded as a mismatch and is never credited toward closing a class.
 *
 * Returns bounded labels only — never an ACL, a value, or SQL.
 */
export function classifyDefaultPrivileges(
  principal: unknown,
  rows: readonly Record<string, unknown>[],
): string[] {
  const failed: string[] = [];
  if (typeof principal !== 'string' || principal === '') {
    return ['the executing principal could not be read from the server'];
  }
  const byClass = new Map<string, Set<string>>();
  for (const cls of M005_DEFAULT_ACL_CLASSES) byClass.set(cls.objtype, new Set<string>());

  for (const raw of rows ?? []) {
    if (raw === null || typeof raw !== 'object') { failed.push('a default-privilege row was unreadable'); continue; }
    const owner = raw.owner;
    if (typeof owner !== 'string' || owner === '') { failed.push('a default-privilege row has no readable owner'); continue; }
    if (owner !== principal) {
      // NOT CREDITED, and said out loud. Silently ignoring it would let a class stay open while the
      // report showed nothing at all about why.
      failed.push('a default-privilege row belongs to a role other than the executing principal');
      continue;
    }
    const objtype = typeof raw.objtype === 'string' ? raw.objtype : '';
    if (!byClass.has(objtype)) {
      // A class migration 005 does not govern. `T` and `n` are the two PostgreSQL classes it
      // deliberately leaves alone and they are skipped in silence. ANY OTHER letter is one this
      // catalog projection cannot legitimately produce, so it is unreadable evidence rather than an
      // uninteresting row, and it is refused rather than dropped without trace.
      if (!M005_UNCOVERED_DEFAULT_ACL_CLASSES.some((c) => c.objtype === objtype)) {
        failed.push('a default-privilege row has an unrecognized object class');
      }
      continue;
    }
    const scopeRaw = raw.scope;
    if (typeof scopeRaw !== 'string') { failed.push('a default-privilege row has no readable scope'); continue; }
    // THE SENTINEL DECIDES, NOT THE NAME. `defaclnamespace = 0` is projected as the empty string,
    // and naming it 'global' before the applicability test let a row for a schema LITERALLY named
    // `global` — a legal name — take the same value by a different route and be credited as
    // closing the class. The emptiness is the only evidence of the global scope; the label is
    // derived from it afterwards, for the message alone.
    const isGlobal = scopeRaw === '';
    if (!isGlobal && scopeRaw !== APP_SCHEMA) continue; // wrong schema: not applicable here
    const scope = isGlobal ? 'global' : scopeRaw;

    // THE ACL PROJECTION IS VALIDATED BEFORE IT IS NORMALIZED, AND BEFORE ANY PRESENCE IS RECORDED.
    //
    // The statement above projects exactly two shapes and no third. `aclexplode` returns no rows
    // over an empty ACL, so the LEFT JOIN LATERAL null-extends the catalog row and BOTH fields
    // arrive as SQL NULL. Otherwise the lateral yields a real aclitem and BOTH fields arrive as
    // non-empty text — `grantee` through a CASE whose arms are the literal 'public' and
    // `pg_get_userbyid`, `privilege` through `privilege_type::text`. Neither can be the empty
    // string, a number, a boolean, an array, an object, or absent.
    //
    // Normalizing first was the defect this replaces. `typeof x === 'string' ? … : ''` collapsed
    // EVERY unreadable value — missing, undefined, numeric, boolean, array, object — onto the same
    // empty string the genuine null-extended row produced, so a row that this function could not
    // read at all was credited as a valid empty GLOBAL override and closed the functions class.
    // Validation therefore happens on the RAW values, and an unreadable row is never credited.
    //
    // Role names are preserved exactly: any non-empty string is a legitimate identifier. There is
    // no pattern check and no trimming, because either would silently turn one role into another.
    // The rejected value is never interpolated into the message.
    //
    // OWN PROPERTIES ONLY, AND THAT GUARDS BOTH BRANCHES. A row projected by the statement carries
    // its fields as its own; a value reached through the prototype chain is not evidence about this
    // row. Requiring ownership on the empty-ACL branch alone would leave the grant branch open to an
    // inherited `grantee`/`privilege` pair, which passes a bare `typeof` test and would be credited
    // as a real aclitem — closing a class on evidence the row does not actually carry.
    const hasGrantee = Object.prototype.hasOwnProperty.call(raw, 'grantee');
    const hasPrivilege = Object.prototype.hasOwnProperty.call(raw, 'privilege');
    const rawGrantee: unknown = raw.grantee;
    const rawPrivilege: unknown = raw.privilege;

    if (hasGrantee && hasPrivilege && rawGrantee === null && rawPrivilege === null) {
      // THE ONLY ACCEPTED EMPTY-ACL PROJECTION: both fields present, both explicitly null. Presence
      // of the catalog row, carrying no grant.
      byClass.get(objtype)?.add(scope);
      continue;
    }
    if (!hasGrantee || !hasPrivilege
        || typeof rawGrantee !== 'string' || rawGrantee === ''
        || typeof rawPrivilege !== 'string' || rawPrivilege === '') {
      // Anything else is evidence this function cannot read. It is reported, and it is NOT credited
      // — so a class whose hard-wired default grants PUBLIC stays reported open.
      failed.push('a default-privilege row has an unreadable ACL projection');
      continue;
    }
    byClass.get(objtype)?.add(scope);
    // THE CASE FOLD IS DELIBERATE AND ITS ERROR DIRECTION IS FAIL-CLOSED. The projection spells the
    // PUBLIC pseudo-role as the literal 'public' and every other grantee through
    // `pg_get_userbyid`, so a role whose quoted name is `PUBLIC` would arrive spelled that way and
    // fold onto the pseudo-role's label. That over-reports: such a grant is refused when it might
    // have been allowed. The opposite choice — comparing case-sensitively — would let a catalog
    // spelling of the REAL pseudo-role slip past the forbidden list, which is the direction that
    // loses a finding. The name itself is never rewritten, trimmed or pattern-matched; only the
    // comparison folds.
    const grantee = rawGrantee.toLowerCase();
    const privilege = rawPrivilege;
    if (M005_DEFAULT_ACL_GRANTEES.includes(grantee)) {
      const label = M005_DEFAULT_ACL_CLASSES.find((c) => c.objtype === objtype)?.label ?? objtype;
      failed.push(`future ${label} would still grant ${privilege} to ${grantee} (${scope} default privileges)`);
    }
  }

  // ONLY A GLOBAL ROW REPLACES THE HARD-WIRED DEFAULT. PostgreSQL composes the initial ACL of a new
  // object as merge(global row's ACL if a global row exists, else acldefault(), schema row's ACL):
  // the global row SUBSTITUTES for the hard-wired default, while the per-schema row is only ever
  // ADDED to whichever base was chosen. A per-schema row cannot subtract, so it cannot remove the
  // built-in EXECUTE that `acldefault()` grants PUBLIC on functions. Crediting a schema row as
  // closing this class was the defect this replaces: it passed a database in which every future
  // function created by this principal is still executable by PUBLIC.
  //
  // `.has('global')`, not `.size`: presence in the applicable-scope set is recorded for BOTH scopes
  // above, because a grant in either scope must still be reported. Only the global entry counts as
  // a replacement of the base.
  for (const cls of M005_DEFAULT_ACL_CLASSES) {
    if (!cls.builtinGrantsPublic) continue;
    if (byClass.get(cls.objtype)?.has('global') !== true) {
      failed.push(
        `future ${cls.label} retain PostgreSQL's built-in grant to PUBLIC: no GLOBAL `
          + 'default-privilege row for the executing principal replaces it, and a per-schema row is '
          + 'added to the built-in default rather than substituted for it',
      );
    }
  }
  return failed;
}

/**
 * Read the default-privilege posture on the SAME session the read-back used, and classify it.
 *
 * The principal and the schema are BOTH server-derived: `current_user` is asked of the backend
 * rather than supplied, so the observation is bound to the role that actually ran the migration
 * and cannot be redirected by a caller value. `current_database()` is likewise resolved server-side
 * — nothing here accepts a database name.
 *
 * SCOPE OF THE CLAIM, stated because it is narrower than it looks: this proves the defaults for
 * FUTURE OBJECTS TO WHICH THIS PRINCIPAL'S DEFAULT PRIVILEGES APPLY — objects owned at creation by
 * the role whose default ACL is being evaluated. It proves nothing about objects owned by
 * `supabase_admin` or any other role, nothing about a role this principal merely inherits from, and
 * it is not owner-independent hardening or a provider-wide compatibility claim.
 *
 * Read-only: one SELECT over pg_default_acl. No DDL, no temporary object, no mutation.
 */
export async function verifyDefaultPrivileges(port: CatalogReadPort): Promise<string[]> {
  const who = await port.query(`select current_user as principal`, []);
  const principal = who[0]?.principal;
  const rows = await port.query(
    `select pg_catalog.pg_get_userbyid(d.defaclrole) as owner,
            d.defaclobjtype::text                    as objtype,
            case when d.defaclnamespace = 0 then ''
                 else (select n.nspname from pg_catalog.pg_namespace n where n.oid = d.defaclnamespace)
            end                                      as scope,
            case when a.grantee = 0 then 'public'
                 else pg_catalog.pg_get_userbyid(a.grantee)
            end                                      as grantee,
            a.privilege_type::text                   as privilege
       from pg_catalog.pg_default_acl d
       left join lateral pg_catalog.aclexplode(d.defaclacl) a on true
      where d.defaclrole = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
        and (d.defaclnamespace = 0
             or d.defaclnamespace = (select n.oid from pg_catalog.pg_namespace n where n.nspname = $1))`,
    [APP_SCHEMA],
  );
  return classifyDefaultPrivileges(principal, rows);
}

// ---------------------------------------------------------------------------
// C2B-M005-P0 — the READ-ONLY default-ACL diagnostic surface.
//
// Nothing below writes, and nothing below is reachable from a migration path. It exists so a
// diagnostic can answer, from catalog evidence alone, TWO SEPARATE questions that the migration
// report previously ran together:
//
//   A. Do the CURRENT defaults meet the postcondition?
//   B. Would a covered blocker SURVIVE the CURRENT migration 005 bytes?
//
// They are different questions with different answers, and B is decided PER CLASS from what 005
// actually issues — one GLOBAL functions revoke plus three IN SCHEMA public revokes. A grant 005
// revokes in the scope it lives in makes A fail and must NOT by itself establish B. What survives
// is a grant in a scope 005 does not reach for that class: a covered GLOBAL grant on TABLES or
// SEQUENCES, for which 005 issues no global statement. An absent global functions override still
// fails A — the hard-wired PUBLIC EXECUTE is live right now — but no longer establishes B, because
// the global FUNCTIONS statement displaces exactly that base.
// ---------------------------------------------------------------------------

/**
 * Hard cap on default-ACL rows the diagnostic will consider.
 *
 * The applicable set is (one principal) x (two scopes) x (three classes) x (its grantees), so a
 * healthy database is far under this. The cap exists so an unexpected catalog cannot make the
 * diagnostic unbounded, and REACHING it is an unreadable result rather than a verdict: a truncated
 * row set could omit exactly the grant that would have failed the check.
 */
export const DEFAULT_ACL_ROW_LIMIT = 200;

export interface BoundedAclRead {
  readonly rows: readonly Record<string, unknown>[];
  readonly overflowed: boolean;
}

/**
 * Read the applicable default-ACL rows with an explicit bound.
 *
 * `limit + 1` is requested so overflow is DETECTED rather than inferred from a full page, and on
 * overflow the rows are DISCARDED — no verdict is ever computed from a truncated set.
 *
 * THE OBJECT-CLASS PREDICATE IS PART OF THE BOUND, not a convenience. Without
 * `d.defaclobjtype in ('r', 'S', 'f')` the statement also returns `T` (types) and `n` (schemas)
 * rows — classes this contract deliberately does NOT govern — and those rows consume the row
 * budget. A database with many uncovered-class entries could then reach the overflow sentinel and
 * make the whole diagnostic unreadable on evidence that was never in scope. Filtering in SQL rather
 * than in JavaScript is what makes the bound mean what it says: the 200 rows counted are 200
 * APPLICABLE rows.
 *
 * THE PREDICATE IS NO LONGER HAND-WRITTEN. It is produced by `defaultAclObjtypePredicate` from
 * `M005_DEFAULT_ACL_CLASSES`, so the governed class set is the single source of truth for it; a
 * test that once had to BIND two independent copies now asserts the one generator instead. It is
 * combined with the executing-principal and namespace predicates and takes effect BEFORE `limit`,
 * and the row bound stays a DISTINCT bound parameter equal to `limit + 1`.
 */
export async function readDefaultAclRowsBounded(
  port: CatalogReadPort,
  limit: number = DEFAULT_ACL_ROW_LIMIT,
): Promise<BoundedAclRead> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return { rows: [], overflowed: true };
  const rows = await port.query(
    `select pg_catalog.pg_get_userbyid(d.defaclrole) as owner,
            d.defaclobjtype::text                    as objtype,
            case when d.defaclnamespace = 0 then ''
                 else (select n.nspname from pg_catalog.pg_namespace n where n.oid = d.defaclnamespace)
            end                                      as scope,
            case when a.grantee = 0 then 'public'
                 else pg_catalog.pg_get_userbyid(a.grantee)
            end                                      as grantee,
            a.privilege_type::text                   as privilege
       from pg_catalog.pg_default_acl d
       left join lateral pg_catalog.aclexplode(d.defaclacl) a on true
      where d.defaclrole = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
        and ${defaultAclObjtypePredicate()}
        and (d.defaclnamespace = 0
             or d.defaclnamespace = (select n.oid from pg_catalog.pg_namespace n where n.nspname = $1))
      limit $2`,
    [APP_SCHEMA, limit + 1],
  );
  if (rows.length > limit) return { rows: [], overflowed: true };
  return { rows, overflowed: false };
}


// ---------------------------------------------------------------------------
// C2B-M005-LRLS-B0 — LEDGER-RLS REPAIR-SAFETY EVIDENCE (READ-ONLY)
//
// `relrowsecurity` on the ledger says row-level security is ENABLED. It does NOT say this
// connection is filtered by it: a table owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set,
// and a superuser or a BYPASSRLS role bypasses it regardless. Enablement, force mode, ownership and
// bypass authority are therefore four SEPARATE observations, and only together do they say whether
// any policy is consulted for this principal.
//
// EVERY FIELD BELOW IS A BOOLEAN, A FIXED TOKEN OR A COUNT. No role name, OID, policy name, policy
// expression, function name, extension name, command-tag array or catalog row is selected, so none
// can reach an operator record even through a rendering mistake. `polqual` and `polwithcheck` are
// tested for NULL rather than deparsed: `pg_get_expr` would materialize the expression text this
// boundary exists to keep out.
// ---------------------------------------------------------------------------

/** Explicit caps. Each read requests `limit + 1` so truncation is DETECTED, never silently kept. */
export const LEDGER_POLICY_LIMIT = 50;
export const LEDGER_ROLE_LIMIT = 200;
export const EVENT_TRIGGER_LIMIT = 50;

/** The seven ordinary table privileges that would become the access boundary without RLS. */
export const LEDGER_TABLE_PRIVILEGES: readonly string[] = Object.freeze([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
]);

/** The four privileges PostgreSQL can also grant at column granularity. */
export const LEDGER_COLUMN_PRIVILEGES: readonly string[] = Object.freeze([
  'SELECT', 'INSERT', 'UPDATE', 'REFERENCES',
]);

export interface LedgerRlsModeRow {
  readonly rlsEnabled: boolean | null;
  readonly forceRls: boolean | null;
  readonly currentIsSessionPrincipal: boolean | null;
  readonly currentOwnsLedger: boolean | null;
  readonly ledgerOwnerIsDatabaseOwner: boolean | null;
  readonly currentIsSuperuser: boolean | null;
  readonly currentHasBypassRls: boolean | null;
  /**
   * PostgreSQL's OWN answer to "are row-security policies being applied to this principal for this
   * relation", from `row_security_active`. It is a CROSS-CHECK on the booleans above, never a
   * replacement for them: they say WHY, this says WHETHER, and a disagreement between the two means
   * the derivation cannot be trusted and must fail closed.
   */
  readonly rowSecurityActiveForCurrent: boolean | null;
}

/**
 * The four authority facts, the two mode flags and the server's own row-security verdict, in ONE
 * row, all as booleans.
 *
 * Ownership is compared by OID inside the database and reported as a boolean; the owner's NAME is
 * never selected. The same holds for the database-owner comparison.
 *
 * `row_security_active` is applied to `c.oid` — the OID the FIXED schema/table source constants
 * resolve to inside this statement. No caller supplies a relation, here or anywhere in this file.
 */
export async function readLedgerRlsMode(port: CatalogReadPort): Promise<LedgerRlsModeRow | null> {
  const rows = await port.query(
    `select c.relrowsecurity                       as rls_enabled,
            c.relforcerowsecurity                  as force_rls,
            pg_catalog.row_security_active(c.oid)  as rls_active,
            (current_user = session_user)          as principal_agrees,
            (c.relowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user))
                                                   as owns_ledger,
            (c.relowner = (select d.datdba from pg_catalog.pg_database d
                            where d.datname = current_database()))
                                                   as owner_is_db_owner,
            (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user)
                                                   as is_superuser,
            (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user)
                                                   as has_bypassrls
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table],
  );
  // ABSENT OR AMBIGUOUS IS UNREADABLE, not "no RLS". Two relations cannot share a name in one
  // schema, so more than one row means the catalog answer cannot be attributed to the ledger.
  if (rows.length !== 1) return null;
  const r = rows[0] as Record<string, unknown>;
  const b = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
  return {
    rlsEnabled: b(r.rls_enabled),
    forceRls: b(r.force_rls),
    currentIsSessionPrincipal: b(r.principal_agrees),
    currentOwnsLedger: b(r.owns_ledger),
    ledgerOwnerIsDatabaseOwner: b(r.owner_is_db_owner),
    currentIsSuperuser: b(r.is_superuser),
    currentHasBypassRls: b(r.has_bypassrls),
    rowSecurityActiveForCurrent: b(r.rls_active),
  };
}

export interface LedgerPolicyRow {
  readonly permissive: boolean | null;
  /** `pg_policy.polcmd`: '*' ALL, 'r' SELECT, 'a' INSERT, 'w' UPDATE, 'd' DELETE. */
  readonly cmd: string | null;
  readonly hasUsing: boolean | null;
  readonly hasWithCheck: boolean | null;
  readonly targetsPublic: boolean | null;
  readonly appliesToCurrent: boolean | null;
  readonly targetsOnlyOtherRoles: boolean | null;
}

export interface BoundedPolicyRead {
  readonly rows: readonly LedgerPolicyRow[];
  readonly overflowed: boolean;
}

/**
 * The ledger's own policies, as booleans and one command letter each.
 *
 * `polroles = '{0}'` is the catalog's encoding of PUBLIC. Applicability to THIS principal is asked
 * of the server through `pg_has_role`, which accounts for inherited membership — a direct grantee
 * comparison would miss a policy that reaches this principal through a group role.
 */
export async function readLedgerPoliciesBounded(
  port: CatalogReadPort,
  limit: number = LEDGER_POLICY_LIMIT,
): Promise<BoundedPolicyRead> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return { rows: [], overflowed: true };
  const rows = await port.query(
    `select p.polpermissive                        as permissive,
            p.polcmd::text                         as cmd,
            (p.polqual is not null)                as has_using,
            (p.polwithcheck is not null)           as has_check,
            (p.polroles = '{0}'::oid[])            as targets_public,
            (p.polroles = '{0}'::oid[] or exists (
               select 1 from unnest(p.polroles) as t(roleoid)
                where pg_catalog.pg_has_role(current_user, t.roleoid, 'USAGE')))
                                                   as applies_to_current
       from pg_catalog.pg_policy p
       join pg_catalog.pg_class c on c.oid = p.polrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2
      limit $3`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table, limit + 1],
  );
  // A TRUNCATED POLICY SET IS DISCARDED. Classifying the visible half would report a policy posture
  // the run did not read, and "some of the policies" is not a posture.
  if (rows.length > limit) return { rows: [], overflowed: true };
  const b = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
  return {
    overflowed: false,
    rows: rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      const targetsPublic = b(r.targets_public);
      const appliesToCurrent = b(r.applies_to_current);
      return {
        permissive: b(r.permissive),
        cmd: typeof r.cmd === 'string' ? r.cmd : null,
        hasUsing: b(r.has_using),
        hasWithCheck: b(r.has_check),
        targetsPublic,
        appliesToCurrent,
        // DERIVED, not separately queried: a policy that reaches neither PUBLIC nor this principal
        // targets only other roles. Left null when either input is unreadable.
        targetsOnlyOtherRoles:
          targetsPublic === null || appliesToCurrent === null
            ? null
            : (!targetsPublic && !appliesToCurrent),
      };
    }),
  };
}

export interface LedgerPrivilegeRoleRow {
  readonly isSuperuser: boolean | null;
  readonly hasBypassRls: boolean | null;
  readonly ownsLedger: boolean | null;
  readonly canConnectDatabase: boolean | null;
  readonly canUseSchema: boolean | null;
  /** Effective TABLE privileges, membership included, in LEDGER_TABLE_PRIVILEGES order. */
  readonly tablePrivileges: readonly (boolean | null)[];
  /** Effective COLUMN privileges on ANY column, in LEDGER_COLUMN_PRIVILEGES order. */
  readonly columnPrivileges: readonly (boolean | null)[];
}

export interface LedgerPrivilegeRead {
  /** PUBLIC's TABLE-level privileges, in LEDGER_TABLE_PRIVILEGES order. */
  readonly publicTablePrivileges: readonly (boolean | null)[];
  /**
   * PUBLIC's TABLE-OR-COLUMN privileges, in LEDGER_COLUMN_PRIVILEGES order.
   *
   * `has_any_column_privilege` is true when the privilege is held for the table as a whole OR for
   * ANY single non-dropped column, so this is a SUPERSET of the table-level answer. The difference
   * between the two is exactly the column-only grant that reading `relacl` alone cannot see.
   */
  readonly publicColumnPrivileges: readonly (boolean | null)[];
  readonly roles: readonly LedgerPrivilegeRoleRow[];
  readonly overflowed: boolean;
}

/**
 * The ordinary-privilege posture that would become the access boundary if RLS were disabled.
 *
 * PUBLIC IS ASKED THROUGH THE INQUIRY FUNCTIONS, NOT THROUGH `relacl`. PostgreSQL documents the
 * special user name `public` as accepted by the privilege inquiry functions, and it permits
 * column-level SELECT, INSERT, UPDATE and REFERENCES grants to PUBLIC. Column ACLs live in
 * `pg_attribute.attacl`, SEPARATELY from `pg_class.relacl` — so an earlier draft that explodes
 * `relacl` alone reports "PUBLIC holds nothing" for a table whose one column PUBLIC can read. An
 * empty table ACL is not evidence of absent column grants, and this read no longer treats it as
 * such. `has_any_column_privilege` also covers a contract-compatible EXTRA column, because it
 * ranges over every non-dropped column rather than over a declared list.
 *
 * Every other role is asked through `has_table_privilege`/`has_column_privilege`, which resolve
 * INHERITED membership — reading the ACL alone would report only direct grantees and miss a
 * privilege held through a group. Those functions also account for privileges available via PUBLIC,
 * so a PUBLIC grant reaches the per-role answers without being counted from two sources.
 *
 * REACHABILITY IS SEPARATE FROM PRIVILEGE. A role holding SELECT that cannot CONNECT to the
 * database or USE the schema cannot presently reach the table, and conflating the two would either
 * overstate exposure or understate a grant that a later CONNECT would activate.
 */
export async function readLedgerPrivilegesBounded(
  port: CatalogReadPort,
  limit: number = LEDGER_ROLE_LIMIT,
): Promise<LedgerPrivilegeRead | null> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return { publicTablePrivileges: [], publicColumnPrivileges: [], roles: [], overflowed: true };
  }
  // EVERY PRIVILEGE IS WRITTEN OUT, for the same reason the role statement below spells its columns
  // out: a list joined into the statement text would put a JavaScript value into SQL rather than
  // into the parameter list, and a fixed string is what a containment test can assert absolutely.
  const pub = await port.query(
    `select pg_catalog.has_table_privilege('public', c.oid, 'SELECT')          as t0,
            pg_catalog.has_table_privilege('public', c.oid, 'INSERT')          as t1,
            pg_catalog.has_table_privilege('public', c.oid, 'UPDATE')          as t2,
            pg_catalog.has_table_privilege('public', c.oid, 'DELETE')          as t3,
            pg_catalog.has_table_privilege('public', c.oid, 'TRUNCATE')        as t4,
            pg_catalog.has_table_privilege('public', c.oid, 'REFERENCES')      as t5,
            pg_catalog.has_table_privilege('public', c.oid, 'TRIGGER')         as t6,
            pg_catalog.has_any_column_privilege('public', c.oid, 'SELECT')     as c0,
            pg_catalog.has_any_column_privilege('public', c.oid, 'INSERT')     as c1,
            pg_catalog.has_any_column_privilege('public', c.oid, 'UPDATE')     as c2,
            pg_catalog.has_any_column_privilege('public', c.oid, 'REFERENCES') as c3
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table],
  );
  // ABSENT OR AMBIGUOUS IS UNREADABLE. Returning an empty PUBLIC set here would be the favourable
  // direction — it reads as "PUBLIC holds nothing" — so it fails closed instead.
  if (pub.length !== 1) return null;
  const p0 = pub[0] as Record<string, unknown>;
  const pb = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
  const publicTablePrivileges = LEDGER_TABLE_PRIVILEGES.map((_, i) => pb(p0[`t${i}`]));
  const publicColumnPrivileges = LEDGER_COLUMN_PRIVILEGES.map((_, i) => pb(p0[`c${i}`]));

  // ONE ROW PER NON-OWNER ROLE. `rolcanlogin` is deliberately NOT a filter: a NOLOGIN group role
  // carrying a privilege hands that privilege to every member, so excluding it would hide the grant.
  //
  // EVERY COLUMN IS WRITTEN OUT. An earlier draft assembled this list by joining the privilege
  // constants into the statement text. That is safe only for as long as those constants stay frozen,
  // and it puts a JavaScript value into SQL TEXT rather than into the parameter list — the one shape
  // this boundary refuses on principle. Spelled out, the statement is a fixed string with no
  // interpolation at all, which a test can assert absolutely rather than case by case.
  const roles = await port.query(
    `select r.rolsuper                                            as is_super,
            r.rolbypassrls                                        as bypass_rls,
            (c.relowner = r.oid)                                  as owns,
            pg_catalog.has_database_privilege(r.oid, (select d.oid from pg_catalog.pg_database d
                                                       where d.datname = current_database()), 'CONNECT')
                                                                  as can_connect,
            pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE') as can_use_schema,
            pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT')     as t0,
            pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT')     as t1,
            pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE')     as t2,
            pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE')     as t3,
            pg_catalog.has_table_privilege(r.oid, c.oid, 'TRUNCATE')   as t4,
            pg_catalog.has_table_privilege(r.oid, c.oid, 'REFERENCES') as t5,
            pg_catalog.has_table_privilege(r.oid, c.oid, 'TRIGGER')    as t6,
            exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                       and pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'SELECT')) as c0,
            exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                       and pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'INSERT')) as c1,
            exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                       and pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE')) as c2,
            exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                       and pg_catalog.has_column_privilege(r.oid, c.oid, a.attnum, 'REFERENCES')) as c3
       from pg_catalog.pg_roles r
       cross join pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2
      limit $3`,
    [LEDGER_RELATION.schema, LEDGER_RELATION.table, limit + 1],
  );
  if (roles.length > limit) {
    return { publicTablePrivileges, publicColumnPrivileges, roles: [], overflowed: true };
  }
  const b = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
  return {
    publicTablePrivileges,
    publicColumnPrivileges,
    overflowed: false,
    roles: roles.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        isSuperuser: b(r.is_super),
        hasBypassRls: b(r.bypass_rls),
        ownsLedger: b(r.owns),
        canConnectDatabase: b(r.can_connect),
        canUseSchema: b(r.can_use_schema),
        tablePrivileges: LEDGER_TABLE_PRIVILEGES.map((_, i) => b(r[`t${i}`])),
        columnPrivileges: LEDGER_COLUMN_PRIVILEGES.map((_, i) => b(r[`c${i}`])),
      };
    }),
  };
}

export interface EventTriggerRow {
  /** `pg_event_trigger.evtevent`: ddl_command_start, ddl_command_end, table_rewrite, sql_drop. */
  readonly event: string | null;
  /** `evtenabled`: 'O' origin, 'R' replica, 'A' always, 'D' disabled. */
  readonly enableMode: string | null;
  /** No tag filter at all — fires for every command of its event, ALTER TABLE included. */
  readonly wildcardTags: boolean | null;
  readonly altersTableTag: boolean | null;
  readonly extensionOwned: boolean | null;
}

export interface BoundedEventTriggerRead {
  readonly rows: readonly EventTriggerRow[];
  readonly overflowed: boolean;
}

/**
 * Enabled event triggers, as catalog METADATA only.
 *
 * This says what a trigger's event, enable mode and tag filter are. It does NOT say what its
 * function does, and no function is inspected or executed here — so this evidence can prove a
 * trigger CANNOT match a command, and can never prove that one which could match is harmless.
 */
export async function readEventTriggersBounded(
  port: CatalogReadPort,
  limit: number = EVENT_TRIGGER_LIMIT,
): Promise<BoundedEventTriggerRead> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return { rows: [], overflowed: true };
  const rows = await port.query(
    `select e.evtevent::text                as event,
            e.evtenabled::text              as enable_mode,
            (e.evttags is null)             as wildcard_tags,
            (e.evttags is not null and 'ALTER TABLE' = any(e.evttags)) as alter_table_tag,
            exists (select 1 from pg_catalog.pg_depend d
                     where d.classid = 'pg_catalog.pg_event_trigger'::regclass
                       and d.objid = e.oid and d.deptype = 'e') as extension_owned
       from pg_catalog.pg_event_trigger e
      where e.evtenabled <> 'D'
      limit $1`,
    [limit + 1],
  );
  if (rows.length > limit) return { rows: [], overflowed: true };
  const b = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
  return {
    overflowed: false,
    rows: rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        event: typeof r.event === 'string' ? r.event : null,
        enableMode: typeof r.enable_mode === 'string' ? r.enable_mode : null,
        wildcardTags: b(r.wildcard_tags),
        altersTableTag: b(r.alter_table_tag),
        extensionOwned: b(r.extension_owned),
      };
    }),
  };
}

export type BaseCategory = 'GLOBAL_OVERRIDE' | 'BUILTIN_RETAINED' | 'UNREADABLE';
export type PresenceCategory = 'PRESENT' | 'NONE' | 'UNREADABLE';

export interface DefaultAclAssessment {
  /** current_user vs session_user, and both readable. */
  readonly principalAgreement: 'AGREED' | 'MISMATCH' | 'UNREADABLE';
  /** Per covered object-class LABEL: whether a global row replaces the hard-wired base. */
  readonly globalBase: Readonly<Record<string, BaseCategory>>;
  /** Applicable public-schema grants to the covered grantees. */
  readonly schemaGrantsToCoveredGrantees: PresenceCategory;
  /** Question A — do the CURRENT defaults satisfy the postcondition? */
  readonly postcondition: 'MET' | 'UNMET' | 'UNREADABLE';
  /**
   * Question B — would a covered default-ACL blocker survive the CURRENT migration 005 bytes?
   *
   * RENAMED from `blockerSurvivesUnchangedM005`, because the migration is no longer the
   * three-statement, schema-only file that name described. The rename is deliberate rather than
   * cosmetic: a reader of an old record must not be able to mistake it for this one.
   */
  readonly blockerSurvivesCurrentM005: 'YES' | 'NO' | 'UNREADABLE';
  /** Bounded count only. The finding TEXT is never part of the operator record. */
  readonly findingCount: number;
}

/**
 * Whether one raw row is an applicable, readable row for `objtype` in `scope`.
 *
 * A DELIBERATE MIRROR of the acceptance rules in `classifyDefaultPrivileges`, not a refactor of
 * them: that function is an accepted, separately reviewed correction and is not reopened here. The
 * duplication is bound by a test that asserts this mirror and the classifier agree about the
 * functions class over the whole default-ACL matrix, so the two cannot drift silently.
 */
function applicableReadableRow(
  raw: unknown, principal: string, objtype: string, wantGlobal: boolean,
): 'no' | 'empty' | 'grant' | 'unreadable' {
  if (raw === null || typeof raw !== 'object') return 'unreadable';
  const r = raw as Record<string, unknown>;
  if (typeof r.owner !== 'string' || r.owner === '') return 'unreadable';
  if (r.owner !== principal) return 'no';
  if (r.objtype !== objtype) return 'no';
  if (typeof r.scope !== 'string') return 'unreadable';
  const isGlobal = r.scope === '';
  if (!isGlobal && r.scope !== APP_SCHEMA) return 'no';
  if (isGlobal !== wantGlobal) return 'no';
  const hasG = Object.prototype.hasOwnProperty.call(r, 'grantee');
  const hasP = Object.prototype.hasOwnProperty.call(r, 'privilege');
  if (hasG && hasP && r.grantee === null && r.privilege === null) return 'empty';
  if (!hasG || !hasP || typeof r.grantee !== 'string' || r.grantee === ''
      || typeof r.privilege !== 'string' || r.privilege === '') return 'unreadable';
  return 'grant';
}

/**
 * Turn bounded catalog evidence into the fixed operator categories.
 *
 * Every value returned is a fixed label or a count. No ACL text, no role name, no privilege name
 * and no row content crosses this boundary — the classifier's finding strings are consumed here and
 * only their COUNT is reported.
 */
export function assessDefaultAclPosture(
  principal: unknown,
  sessionUser: unknown,
  read: BoundedAclRead,
): DefaultAclAssessment {
  const unreadableAll: DefaultAclAssessment = {
    principalAgreement: 'UNREADABLE',
    globalBase: Object.freeze(Object.fromEntries(M005_DEFAULT_ACL_CLASSES.map((c) => [c.label, 'UNREADABLE' as BaseCategory]))),
    schemaGrantsToCoveredGrantees: 'UNREADABLE',
    postcondition: 'UNREADABLE',
    blockerSurvivesCurrentM005: 'UNREADABLE',
    findingCount: 0,
  };
  // PRINCIPAL AGREEMENT IS DECIDED FIRST, AND IT NOW GATES EVERYTHING BELOW.
  //
  // Both names must be readable AND equal. Previously `agreement` was computed here and then read
  // only for its own output field: `postcondition` was `findings.length === 0` and
  // `blockerSurvivesCurrentM005` was `globalForbiddenGrant || functionsBuiltinRetained`, and
  // neither expression mentioned it. So MISMATCH could be reported alongside A=MET and B=NO — a
  // favourable verdict about defaults belonging to `current_user` while the session never proved it
  // was running as that role. Every row considered here is scoped to `current_user`, so without
  // agreement the evidence does not describe the principal the caller believes it does, and the only
  // honest answer for every derived category is UNREADABLE.
  //
  // The classifier itself is UNTOUCHED by this: it is a separately accepted correction, and the
  // global/schema semantics, the r/S/f scope and the uncovered TYPES/SCHEMAS classes are unchanged.
  // This gate only decides whether the classifier's verdict may be spoken at all.
  const agreement: DefaultAclAssessment['principalAgreement'] =
    (typeof principal !== 'string' || principal === ''
      || typeof sessionUser !== 'string' || sessionUser === '')
      ? 'UNREADABLE'
      : (sessionUser === principal ? 'AGREED' : 'MISMATCH');
  // The agreement is still REPORTED on every unreadable return — it is the one thing that IS known,
  // and suppressing it would hide the reason everything else is unreadable.
  const unreadableWithAgreement: DefaultAclAssessment = {
    ...unreadableAll,
    principalAgreement: agreement,
  };
  // OVERFLOW IS UNREADABLE, NEVER A VERDICT. A truncated set could be missing exactly the grant
  // that would have failed the check, so no category is computed from it.
  if (read.overflowed) return unreadableWithAgreement;
  // `AGREED` already implies both names are non-empty strings; the `typeof` re-test is what NARROWS
  // `principal` for the classifier call below, so the narrowing is local and provable rather than
  // inferred from a label.
  if (agreement !== 'AGREED' || typeof principal !== 'string' || principal === '') {
    return unreadableWithAgreement;
  }

  const findings = classifyDefaultPrivileges(principal, read.rows);

  const globalBase: Record<string, BaseCategory> = {};
  // PER-CLASS, THEN AGGREGATED. A single `anyUnreadable` shared across the class loop labelled every
  // class AFTER an unreadable one as UNREADABLE even when that class's own rows were clean. Nothing
  // observed it, because an unreadable read discards `globalBase` wholesale below — which is exactly
  // what makes it a trap rather than a bug: the day a partial per-class report is wanted, the
  // contamination becomes a live misreport. The aggregate flag still drives the wholesale refusal.
  let anyUnreadable = false;
  let schemaForbiddenGrant = false;
  // QUESTION B IS NOW DECIDED PER CLASS, because the migration now treats the classes differently:
  // FUNCTIONS is revoked GLOBALLY and in schema, TABLES and SEQUENCES only in schema. A single
  // `globalForbiddenGrant` flag folded all three together and could not express that.
  let blockerSurvives = false;

  for (const cls of M005_DEFAULT_ACL_CLASSES) {
    let sawGlobal = false;
    let classUnreadable = false;
    let classGlobalForbiddenGrant = false;
    let classSchemaForbiddenGrant = false;
    for (const raw of read.rows) {
      const g = applicableReadableRow(raw, principal, cls.objtype, true);
      if (g === 'unreadable') { classUnreadable = true; continue; }
      if (g === 'no') continue;
      sawGlobal = true;
      if (g === 'grant') {
        const grantee = String((raw as Record<string, unknown>).grantee).toLowerCase();
        if (M005_DEFAULT_ACL_GRANTEES.includes(grantee)) classGlobalForbiddenGrant = true;
      }
    }
    for (const raw of read.rows) {
      const s = applicableReadableRow(raw, principal, cls.objtype, false);
      if (s === 'unreadable') { classUnreadable = true; continue; }
      if (s !== 'grant') continue;
      const grantee = String((raw as Record<string, unknown>).grantee).toLowerCase();
      if (M005_DEFAULT_ACL_GRANTEES.includes(grantee)) classSchemaForbiddenGrant = true;
    }
    if (classSchemaForbiddenGrant) schemaForbiddenGrant = true;
    if (classUnreadable) anyUnreadable = true;
    globalBase[cls.label] = classUnreadable ? 'UNREADABLE' : (sawGlobal ? 'GLOBAL_OVERRIDE' : 'BUILTIN_RETAINED');

    // WHAT SURVIVES THE CURRENT 005, class by class. Each clause names the statement that would
    // have to exist to remove the blocker, so a migration edit that drops a statement — and with it
    // the corresponding flag on the class constant — turns this back to YES rather than lying.
    //
    //   * A GLOBAL grant to a covered grantee survives unless 005 revokes that class GLOBALLY. An
    //     `IN SCHEMA public` revoke cannot reach a global row at all.
    //   * The HARD-WIRED base survives unless 005 revokes that class GLOBALLY, because only a
    //     global row substitutes for `acldefault()`; a per-schema row is added on top of it.
    //   * A PUBLIC-SCHEMA grant to a covered grantee survives unless 005 revokes that class IN
    //     SCHEMA public.
    //
    // FOREIGN-OWNER rows never reach here: `applicableReadableRow` answers 'no' for them and the
    // bounded read never selects them. TYPES and SCHEMAS are not in this list at all.
    if (!cls.globallyRevokedByM005 && classGlobalForbiddenGrant) blockerSurvives = true;
    if (!cls.globallyRevokedByM005 && cls.builtinGrantsPublic && !sawGlobal) blockerSurvives = true;
    if (!cls.schemaRevokedByM005 && classSchemaForbiddenGrant) blockerSurvives = true;
  }

  if (anyUnreadable) return { ...unreadableAll, principalAgreement: agreement, findingCount: findings.length };

  return {
    principalAgreement: agreement,
    globalBase: Object.freeze(globalBase),
    schemaGrantsToCoveredGrantees: schemaForbiddenGrant ? 'PRESENT' : 'NONE',
    // QUESTION A: the classifier's own verdict over the current evidence.
    postcondition: findings.length === 0 ? 'MET' : 'UNMET',
    // QUESTION B, and deliberately NOT the same test. A blocker survives when the CURRENT migration
    // 005 has no statement that removes it — decided per class in the loop above from the class
    // constant's `globallyRevokedByM005` / `schemaRevokedByM005` flags, which a source test binds
    // to the migration's own statements. A schema-only grant on a class 005 revokes in schema
    // establishes A but never B; a GLOBAL table or sequence grant establishes both.
    //
    // B = NO IS NOT MIGRATION READINESS. It answers one question about default ACLs and says
    // nothing about the other preconditions of migration 005.
    blockerSurvivesCurrentM005: blockerSurvives ? 'YES' : 'NO',
    findingCount: findings.length,
  };
}

/** The two roles migration 005 creates. Neither may hold a database-level capability. */
export const M005_CAPABILITY_ROLES: readonly string[] = Object.freeze(['tmpos_app', 'tmpos_audit_writer']);

/**
 * Effective database-level CREATE and TEMPORARY for the two capability roles, and for PUBLIC.
 *
 * Asked as EFFECTIVE privilege, so a grant reaching a role through PUBLIC or through a role
 * membership is still seen. The database identifier is `current_database()` — resolved by the
 * server, never accepted from a caller — so this cannot be pointed at a different database.
 *
 * PUBLIC is reported on its own two labels rather than folded into the roles: PUBLIC's database
 * TEMPORARY grant is a PostgreSQL default that only the database owner can close, and it is the
 * open gate (G-DBROLE) that migration 005's own preflight refuses to run without. Reporting it
 * separately keeps "the roles are clean" and "the database is clean" from being confused.
 *
 * Strict `!== false`: an absent row, a NULL, or a non-boolean is missing evidence, never a pass.
 */
export async function verifyCapabilityDatabasePrivileges(port: CatalogReadPort): Promise<string[]> {
  const failed: string[] = [];
  for (const role of M005_CAPABILITY_ROLES) {
    try {
      const rows = await port.query(
        `select pg_catalog.has_database_privilege($1, pg_catalog.current_database(), 'CREATE')    as c,
                pg_catalog.has_database_privilege($1, pg_catalog.current_database(), 'TEMPORARY') as t`,
        [role],
      );
      const r = rows[0];
      if (r === undefined) { failed.push(`${role} database privileges could not be determined`); continue; }
      if (r.c !== false) failed.push(`${role} holds CREATE on the current database`);
      if (r.t !== false) failed.push(`${role} holds TEMPORARY on the current database`);
    } catch {
      // PER-ROLE GUARD: has_database_privilege RAISES on a missing role, and one absent role must
      // not discard the finding already gathered for the other.
      failed.push(`${role} database privileges could not be determined`);
    }
  }
  try {
    const rows = await port.query(
      `select pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'CREATE')    as c,
              pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'TEMPORARY') as t`,
      [],
    );
    const r = rows[0];
    if (r === undefined) failed.push('PUBLIC database privileges could not be determined');
    else {
      if (r.c !== false) failed.push('PUBLIC holds CREATE on the current database');
      if (r.t !== false) failed.push('PUBLIC holds TEMPORARY on the current database');
    }
  } catch {
    failed.push('PUBLIC database privileges could not be determined');
  }
  return failed;
}

/**
 * Live DEV fingerprint — target-identity signal class C, and the ONLY one that reads the
 * database itself. It runs AFTER a connection exists, which is why no mutation may be attempted
 * before it passes: the static and endpoint-derived classes alone cannot tell two databases of
 * the same shape apart.
 */
export async function verifyManagedDevFingerprint(
  port: CatalogReadPort,
  expected: { readonly requiredAuditActions: readonly string[]; readonly activeSystemOwners: number; readonly suspendedSystemOwners: number },
): Promise<string[]> {
  const failed: string[] = [];
  const acts = await port.query(
    `select action_id, count(*)::text as n from public.audit_event group by action_id`, [],
  );
  const seen = new Set(acts.map((r) => String(r.action_id)));
  for (const a of expected.requiredAuditActions) {
    if (!seen.has(a)) failed.push(`expected durable audit action absent: ${a}`);
  }
  const mem = await port.query(
    `select status, count(*)::int as n from public.user_membership
      where scope_type = 'platform' and role_id = 'system_owner' group by status`, [],
  );
  const byStatus = new Map(mem.map((r) => [String(r.status), Number(r.n)]));
  if ((byStatus.get('active') ?? 0) !== expected.activeSystemOwners) failed.push('active platform system_owner count differs');
  if ((byStatus.get('suspended') ?? 0) !== expected.suspendedSystemOwners) failed.push('suspended platform system_owner count differs');
  return failed;
}

/**
 * ATOMIC adoption write. One transaction for the WHOLE prefix — never one transaction per row.
 *
 * A per-row commit could leave `001,002` adopted with `003,004` absent, and a later ordinary
 * apply would then read 003 as pending and try to RE-EXECUTE it against a database where it
 * already ran. That committed partial prefix is the specific failure this port exists to make
 * impossible, so the ledger DDL and every insert share one bracket and one commit.
 */
/**
 * What a run can PROVE about its adoption transaction's COMMIT. Three states, because there are
 * genuinely three: a client-side failure is evidence about THIS PROCESS, never about the database.
 *
 *  - `not_committed` — positive evidence: COMMIT was never put on the wire.
 *  - `committed`     — the driver acknowledged COMMIT.
 *  - `unknown`       — COMMIT may have been submitted and processed; its outcome was not established.
 *
 * `unknown` must never be narrowed to `not_committed`: a timeout, a dropped socket, or a lost
 * response after COMMIT was sent leaves PostgreSQL entirely free to have committed durably.
 */
export type CommitResolution = 'not_committed' | 'committed' | 'unknown';

/**
 * The two moments only the write port can observe. `bounded` collapses a rejection and a deadline
 * into one `{ok:false}` and deliberately drops the driver error, so the runner alone cannot tell
 * "an insert failed before COMMIT" from "COMMIT was sent and its answer never came back".
 *
 * Both marks are made BEFORE the await they describe, which is what makes them survive a rejection
 * AND a deadline that abandons the promise mid-flight.
 */
export interface BaselineCommitObserver {
  /** Called IMMEDIATELY BEFORE the COMMIT statement is issued. */
  commitSubmitted(): void;
  /** Called ONLY when the driver acknowledged the COMMIT. */
  commitAcknowledged(): void;
}

export interface BaselineWritePort {
  writeAdoptedPrefix(
    rows: readonly { version: string; checksum: string; at: string }[],
    observe: BaselineCommitObserver,
  ): Promise<void>;
}

export interface BaselineReport {
  outcome: 'complete' | 'refused' | 'failed';
  code: string | null;
  adopted: string[];
  /** Bounded detail labels — never SQL, a DSN, or a driver message. */
  detail: string[];
  disposal: 'closed' | 'terminated' | 'none';
  /**
   * What this run established about its adoption transaction's COMMIT. A dimension of its OWN,
   * deliberately parallel to `disposal` rather than folded into `code` or `detail`: transaction
   * state and cleanup state are independent facts, and a successful termination must never be
   * readable as "the transaction rolled back". Keeping it in its own field also puts it out of
   * reach of the catch-all, which writes only `outcome` and `code`.
   */
  commit: CommitResolution;
}

/**
 * Adopt a verified historical prefix into an EMPTY ledger, all-or-nothing.
 *
 * Ordering is load-bearing and matches the C2B-R2 contract: lock FIRST, then re-read the ledger
 * while serialized, then verify, and only then write. Verifying before the lock would let a
 * concurrent runner change the very state that was just proved.
 *
 * LOCK OWNERSHIP IS BALANCED WITHIN THIS RUN (C2B-R2D). Exactly one physical acquisition is made,
 * and it is consumed by exactly one VERIFIED unlock before the session is returned — or, on every
 * other path, by destroying the session, which is what session-end lock semantics make equivalent.
 * The session is never handed back for reuse while this run's lock ownership is positive or
 * unknown, so no caller can compose this runner with another and stack a second acquisition onto a
 * lock this one still holds.
 */
export async function runTrustedHistoricalBaseline(deps: {
  adapter: ExecutorAdapter;
  ledger: ExecutorLedgerPort;
  catalog: CatalogReadPort;
  write: BaselineWritePort;
  connectionMode: ConnectionMode;
  deadlineMs: number;
  lockKey: number;
  /** The authorized prefix, already proved a prefix by planBaseline. */
  plan: { versions: readonly { version: string; checksum: string }[] };
  now: () => string;
}): Promise<BaselineReport> {
  const deadlineMs = Number.isSafeInteger(deps.deadlineMs) && deps.deadlineMs > 0 ? deps.deadlineMs : 30_000;
  // `commit` starts at `not_committed` and that is a TRUTHFUL default, not an optimistic one: every
  // path that returns before the write step returns before any transaction was begun at all.
  const report: BaselineReport = {
    outcome: 'failed', code: null, adopted: [], detail: [], disposal: 'none', commit: 'not_committed',
  };
  const want = deps.plan.versions.map((v) => v.version);

  // MAXIMALITY, enforced by the runner rather than by a caller's constant. The pure planner now
  // accepts ANY in-order prefix, so a caller could ask to adopt 001-002 on a database where 003
  // and 004 also ran — recording them as pending and inviting a re-execution. The registered
  // verifier set is exactly the history this runner can PROVE, so the adopted prefix must equal
  // it: anything shorter leaves provable history unadopted, anything longer is unverifiable.
  const verifiable = Object.keys(POSTCONDITION_VERIFIERS).sort();
  if (want.join(',') !== verifiable.join(',')) {
    report.outcome = 'refused';
    report.code = EXECUTOR_CODES.BASELINE_POSTCONDITION_FAILED;
    report.detail = [`adoptable history is exactly [${verifiable.join(',')}]; requested [${want.join(',')}]`];
    return report;
  }

  const reserved = await bounded(() => deps.adapter.reserve(deps.connectionMode), deadlineMs, (late) => {
    if (late !== undefined) void bounded(() => late.terminate(), deadlineMs, () => {});
  });
  if (!reserved.ok) {
    report.code = reserved.timedOut ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED;
    return report;
  }
  const session = reserved.value;
  const destroy = async (): Promise<void> => {
    const t = await bounded(() => session.terminate(), 5_000, () => {});
    report.disposal = t.ok ? 'terminated' : 'none';
    // A failed destroy must be RECORDED, not merely left as 'none' — both sibling runners already
    // do this, and without it a committed adoption whose cleanup failed reads as `complete` with a
    // null code, i.e. entirely clean. `??` so a primary failure is never overwritten.
    //
    // `outcome` is deliberately NOT downgraded here. When the adoption transaction committed, it
    // committed, and `adopted` says which versions. Execution state and cleanup state are separate
    // facts: collapsing them would either hide a real write or invent a failure that never
    // happened, and an operator reading "failed" might re-run an adoption that already landed.
    if (!t.ok) report.code = report.code ?? EXECUTOR_CODES.DISPOSAL_FAILED;
  };
  const refuse = async (code: string, detail: string[]): Promise<BaselineReport> => {
    report.outcome = 'refused';
    report.code = code;
    report.detail = detail;
    await destroy();
    return report;
  };

  try {
    const live = await bounded(() => session.confirmLive(), deadlineMs, () => {});
    if (!live.ok) return await refuse(ENGINE_CODES.PORT_OPERATION_FAILED, ['session not live']);

    // 1) SERIALIZE FIRST. Everything verified below is only meaningful while the lock is held.
    const locked = await bounded(() => session.acquireRunLock(deps.lockKey), deadlineMs, () => {});
    if (!locked.ok || locked.value !== true) {
      return await refuse(ENGINE_CODES.PORT_OPERATION_FAILED, ['run lock not acquired']);
    }

    // 2) Entry state, re-read UNDER the lock.
    const read = await bounded(() => deps.ledger.readLedger(session), deadlineMs, () => {});
    if (!read.ok) return await refuse(ENGINE_CODES.PORT_OPERATION_FAILED, ['ledger unreadable']);
    if (read.value.length !== 0) {
      // A non-empty ledger here is either a completed adoption or — the dangerous case — a
      // COMMITTED PARTIAL prefix. Both are STOP states. Neither is repaired, completed, or
      // overwritten: doing so would be this code inventing history it cannot verify.
      const present = read.value.map((r) => r.version);
      const partial = present.length < want.length && want.slice(0, present.length).join(',') === present.join(',');
      return await refuse(
        partial ? EXECUTOR_CODES.BASELINE_PARTIAL_OBSERVED : EXECUTOR_CODES.BASELINE_ENTRY_STATE_REJECTED,
        [`ledger is not empty (${present.length} row(s) present)`],
      );
    }

    // 3) Per-version postconditions. EVERY requested version must pass; one failure refuses all.
    const post = await bounded(() => verifyHistoricalPostconditions(deps.catalog, want), deadlineMs, () => {});
    if (!post.ok) return await refuse(ENGINE_CODES.PORT_OPERATION_FAILED, ['postcondition verification failed to run']);
    const badVersions = post.value.filter((r) => !r.ok);
    if (badVersions.length > 0) {
      return await refuse(
        EXECUTOR_CODES.BASELINE_POSTCONDITION_FAILED,
        badVersions.flatMap((r) => r.failed.map((f) => `${r.version}: ${f}`)),
      );
    }

    // 4) Pre-005 sentinel: adoption must not proceed over evidence that 005 already ran.
    const residue = await bounded(() => detectPre005Residue(deps.catalog), deadlineMs, () => {});
    if (!residue.ok) return await refuse(ENGINE_CODES.PORT_OPERATION_FAILED, ['sentinel check failed to run']);
    if (residue.value.length > 0) return await refuse(EXECUTOR_CODES.BASELINE_PRE005_RESIDUE, residue.value);

    // 5) ONE atomic write for the whole prefix.
    const at = deps.now();
    const rows = deps.plan.versions.map((v) => ({ version: v.version, checksum: v.checksum, at }));
    // COMMIT RESOLUTION. The port marks the two moments it alone can see; `bounded` cannot, because
    // it flattens a rejection and a deadline into the same `{ok:false}` and drops the driver error.
    let submitted = false;
    let acknowledged = false;
    const observe: BaselineCommitObserver = {
      commitSubmitted: () => { submitted = true; },
      commitAcknowledged: () => { acknowledged = true; },
    };
    const wrote = await bounded(() => deps.write.writeAdoptedPrefix(rows, observe), deadlineMs, () => {});

    // A TIMEOUT is UNKNOWN even when COMMIT has not been reached yet: `bounded` ABANDONS the work
    // promise rather than cancelling it, so the write is still running past this line and may still
    // issue COMMIT. Only a definite rejection that never reached COMMIT proves non-commit.
    report.commit =
      wrote.ok || acknowledged
        ? 'committed'
        : (wrote.timedOut || submitted) ? 'unknown' : 'not_committed';

    if (!wrote.ok) {
      report.outcome = 'failed';
      if (report.commit === 'unknown') {
        // NOT "did not commit". COMMIT may have reached PostgreSQL and durably adopted 001-004; a
        // client-side timeout, dropped socket or lost response is evidence about THIS PROCESS, not
        // about the database. `adopted` stays empty because adoption is not established EITHER —
        // the state is genuinely undetermined in both directions, and saying exactly that is the
        // only truthful option. Nothing here retries, rolls back, or reconnects to find out.
        report.code = EXECUTOR_CODES.BASELINE_COMMIT_UNKNOWN;
        report.detail = [
          // Derived, not asserted. There are TWO ways to reach UNKNOWN and they are not the same
          // fact: stating "COMMIT was submitted" when the deadline fired first would be its own
          // unwarranted claim — the mirror of the one this whole correction exists to remove.
          submitted
            ? 'COMMIT WAS SUBMITTED AND ITS OUTCOME WAS NOT ESTABLISHED — historical adoption may or may not have committed'
            : 'THE ADOPTION WRITE EXCEEDED ITS DEADLINE AND WAS ABANDONED, NOT CANCELLED — it may still have issued COMMIT',
          'do NOT re-run baseline and do NOT run apply/migration 005; verify the authoritative ledger state first',
        ];
      } else if (report.commit === 'not_committed') {
        // Positive evidence of non-commit: the write rejected before COMMIT was ever put on the
        // wire. The port also ATTEMPTS a rollback there, but that attempt is swallowed and its
        // outcome is never observed, so this branch claims non-submission only — never a completed
        // rollback. This is the ONLY branch entitled to the non-commit claim, so it is
        // guarded on the verdict itself rather than reached by falling through — `commit` can also
        // be `committed` here, when a port rejects after acknowledging its COMMIT.
        report.code = ENGINE_CODES.PORT_OPERATION_FAILED;
        report.detail = ['adoption transaction did not commit — COMMIT was never submitted'];
      } else {
        // Acknowledged COMMIT, then a later rejection inside the write port. The mutation stands;
        // only the port's own epilogue failed, and neither fact may be stated as the other.
        report.code = ENGINE_CODES.PORT_OPERATION_FAILED;
        report.detail = ['THE ADOPTION TRANSACTION COMMITTED — do not re-run; the write port then failed'];
      }
      await destroy();
      return report;
    }

    // 6) Read-back UNDER THE SAME LOCK: exactly the adopted prefix, clean, correct checksums,
    //    and nothing beyond it.
    const back = await bounded(() => deps.ledger.readLedger(session), deadlineMs, () => {});
    if (!back.ok) {
      // NOT `refuse()`, for exactly the reason the mismatch branch below spells out: the adoption
      // transaction has already COMMITTED, and `refused` is this report's word for "nothing
      // happened". Erasing `adopted` and the do-not-re-run warning here would send the operator to
      // re-run a write that landed. The re-run is fail-closed at the entry-state check, so the cost
      // is a manual STOP investigation caused entirely by the mis-report — the same cost that
      // branch was written to avoid.
      report.outcome = 'failed';
      report.code = ENGINE_CODES.PORT_OPERATION_FAILED;
      report.adopted = want.slice();
      report.detail = [
        'THE ADOPTION TRANSACTION COMMITTED — do not re-run; investigate the ledger',
        'post-commit ledger unreadable',
      ];
      await destroy();
      return report;
    }
    const got = back.value;
    const mismatch: string[] = [];
    if (got.length !== want.length) mismatch.push(`expected ${want.length} adopted row(s), found ${got.length}`);
    for (let i = 0; i < deps.plan.versions.length; i += 1) {
      const expect = deps.plan.versions[i];
      const actual = got.find((r) => r.version === expect.version);
      if (actual === undefined) mismatch.push(`${expect.version} absent after commit`);
      else if (actual.checksum !== expect.checksum) mismatch.push(`${expect.version} checksum differs after commit`);
      else if (actual.dirty !== false) mismatch.push(`${expect.version} is dirty after commit`);
    }
    if (mismatch.length > 0) {
      // NOT `refuse()`. The transaction has already COMMITTED by this point, and `refused` is
      // this report's word for "nothing happened". Reporting a committed adoption as refused
      // would send the operator to re-run, whose entry-state check would then reject a ledger
      // this very run wrote — a manual STOP investigation caused entirely by the mis-report.
      report.outcome = 'failed';
      report.code = EXECUTOR_CODES.BASELINE_READBACK_MISMATCH;
      report.adopted = want.slice();
      report.detail = ['THE ADOPTION TRANSACTION COMMITTED — do not re-run; investigate the ledger', ...mismatch];
      await destroy();
      return report;
    }

    report.outcome = 'complete';
    report.adopted = want.slice();

    // 7) BALANCE THE ONE OWNED ACQUISITION, before the session can become reusable.
    //
    // PostgreSQL session-level advisory locks belong to the SESSION and STACK: every successful
    // pg_try_advisory_lock needs its own pg_advisory_unlock, and only session end drops the whole
    // stack. Step 1 takes exactly one. This runner used to take none back — and `close()` below
    // RELEASES the connection to the pool rather than ending it, so the run lock left this function
    // still held and was dropped only when the caller's own `finally { handle.dispose() }` destroyed
    // the client. That made process teardown the lock's real cleanup path, and that teardown is
    // deliberately quiet, so the release was neither established nor reportable. An explicit unlock
    // makes ownership balanced and the release VERIFIED: pg_advisory_unlock returns true only when
    // this session genuinely held it.
    //
    // No serialization is given up. Everything this run had to serialize — the entry state, the
    // postconditions, the sentinel, the atomic write and the read-back — is already done above, and
    // the lock never outlived this process in the first place.
    const released = await bounded(() => session.releaseRunLock(deps.lockKey), deadlineMs, () => {});
    if (!released.ok || released.value !== true) {
      // Ownership is unbalanced or unverified, so the session must NOT be pooled: `close()` would
      // hand a possibly-lock-holding connection back for reuse and report it clean. Destroying it is
      // the only remaining way to establish a release, and R2C keeps that outcome truthful — a
      // failed destroy stays `disposal: 'none'`, i.e. release UNKNOWN, never "released".
      //
      // `outcome` stays `complete` and `adopted` stays populated: the adoption transaction really
      // did commit and a re-run is neither needed nor safe. The non-null code and the disposal are
      // what tell the operator this run did not finish cleanly.
      report.code = report.code ?? ENGINE_CODES.RUN_UNLOCK_FAILED;
      await destroy();
      // Written AFTER `destroy()`, from its actual result. Stating "the session was destroyed"
      // beforehand asserted an outcome that had not happened yet and stayed wrong when it failed —
      // producing, on the single highest-stakes path (committed adoption plus a possibly-live
      // lock-holding backend), a detail line that flatly contradicted `disposal: 'none'`.
      report.detail = [
        'THE ADOPTION TRANSACTION COMMITTED — do not re-run',
        report.disposal === 'terminated'
          ? 'the run advisory lock was not verifiably released; the session was destroyed rather than pooled'
          : 'the run advisory lock was not verifiably released AND the session was not provably destroyed — its release state is UNKNOWN',
      ];
      return report;
    }

    const closed = await bounded(() => session.close(), deadlineMs, () => {});
    if (!closed.ok) {
      // SIBLING PARITY. `runTrustedLedgerRead` records a failed close, and the kernel turns one into
      // a non-complete outcome. Without a code here the report reads `complete / code:null /
      // terminated`, and the CLI gate — which keys on the code — exits 0: a failed connection
      // release on the one path that just wrote durable history would pass as entirely clean.
      report.code = report.code ?? ENGINE_CODES.PORT_OPERATION_FAILED;
      await destroy();
      report.detail = [
        'THE ADOPTION TRANSACTION COMMITTED — do not re-run',
        'the run advisory lock WAS verifiably released; the connection release then failed',
      ];
      return report;
    }
    report.disposal = 'closed';
    return report;
  } catch {
    report.outcome = 'failed';
    report.code = ENGINE_CODES.PORT_OPERATION_FAILED;
    await destroy();
    return report;
  }
}

/**
 * The managed apply gate. After adoption the recovery path may execute EXACTLY one version and
 * nothing else — a later 006 appearing in discovery must stop the run rather than ride along on
 * a plan computed for 005.
 */
export function assertExactManagedApplyPlan(planned: readonly string[], authorized: string): void {
  if (planned.length !== 1 || planned[0] !== authorized) {
    fail(EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, `planned=[${planned.join(',')}] authorized=[${authorized}]`);
  }
}

/**
 * The managed apply DIRECTION gate — a separate invariant from the exact-[005] VERSION gate.
 *
 * WHY SEPARATE. `assertExactManagedApplyPlan` constrains WHICH migration may run; it says nothing
 * about which way. The authorized C2B recovery mutation is "apply migration 005 FORWARD, exactly
 * once". A managed DOWN is not a narrower version of that — it is a different, unauthorized
 * mutation that would drop the very objects 005 creates. Version safety cannot imply direction
 * safety, so this gate exists on its own and runs on its own.
 *
 * WHY IT RESOLVES RATHER THAN JUST VALIDATES. The CLI's direction has two sources — `--direction`
 * and the legacy `--down` flag — and an unrecognized `--direction=sideways` previously fell
 * through the `=== 'down'` comparison and was treated as UP. Doing the defaulting and the
 * rejection in ONE pure function is what makes "the managed default is unambiguously UP" a
 * testable claim rather than a reading of two expressions in two files. Anything that is not
 * exactly `'up'` — 'down', '', 'UP', 'sideways', or the `--down` flag — is refused.
 *
 * WHY IT TAKES EVERY TOKEN, NOT ONE. The shared `getOpt` helper is first-wins, so
 * `--direction=up --direction=down` would yield 'up' and let a command line that literally asks
 * for DOWN proceed to a mutation. The executor happens to be structurally forward-only, so the
 * mutation would be the authorized one — but "the operator asked for DOWN and the run continued"
 * is exactly the outcome this gate exists to prevent, so ambiguity is refused rather than
 * silently resolved. Taking the whole list is what makes that decidable here.
 *
 * This is deliberately NOT a managed rollback capability, and there is no override, force flag, or
 * environment escape hatch: the only value it can ever return is `'up'`.
 */
export function resolveManagedApplyDirection(directionTokens: readonly string[], downFlag: boolean): 'up' {
  // The `--down` flag is checked FIRST and independently: it must not be able to hide behind an
  // explicit `--direction=up` on the same command line.
  if (downFlag) {
    fail(EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED, 'flag=--down; the managed path is forward-only');
  }
  if (directionTokens.length > 1) {
    fail(EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED, `ambiguous: ${directionTokens.length} --direction tokens`);
  }
  // NO `--direction` at all is the established CLI default of UP, and is the ONLY accepted default.
  const direction = directionTokens.length === 0 ? 'up' : directionTokens[0];
  if (direction !== 'up') {
    // The label is the operator's own token, not a claim that a DOWN apply was permitted.
    fail(EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED, `requested=${JSON.stringify(direction)}; the managed path is forward-only`);
  }
  return 'up';
}

/**
 * The AUTHORITATIVE managed apply gate, evaluated under the run lock.
 *
 * WHY THIS EXISTS RATHER THAN A CALLER-SIDE CHECK. `runTrustedApply` discovers migrations, reads
 * the ledger and calls `planApply` BEFORE the kernel emits `acquire_lock` — the lock is an effect
 * inside the program, and the program is built from the plan. So every plan computed outside this
 * policy, including the runner's own and any CLI preflight, is an unserialized snapshot. Checking
 * such a snapshot proves only what was true before the run was serialized; between that moment and
 * the first write, another migrator can commit and a new migration file can appear. This policy is
 * the only place where "what is true" and "what will run" are established with the lock held.
 *
 * It does three things, in order:
 *   1. re-derives the authoritative pending set — fresh discovery, fresh ledger read, fresh plan;
 *   2. requires that authoritative set to be EXACTLY the one authorized version;
 *   3. requires the frozen program's own execution versions to equal it.
 *
 * Step 3 is what makes this a BINDING rather than another check: step 2 could pass while the
 * program still carried a different set. The program's `execute` effects already hold the SQL and
 * checksum inline, so once they match, nothing reachable afterwards can substitute other content.
 *
 * Any refusal is returned as a bounded code — never thrown — and the caller stops before the first
 * mutating effect. Nothing here repairs, resolves or writes: an unexpected state is a STOP.
 */
export function createManagedExactPlanPolicy(opts: {
  ledger: ExecutorLedgerPort;
  fsPort: MigrationFsPort;
  authorizedVersion: string;
  transactionModeByVersion?: Readonly<Record<string, TransactionMode>>;
}): TrustedApplyPolicy {
  return async ({ session, executionPlan }) => {
    let authoritative: ExecutionUnit[];
    try {
      // Discovery is re-run too, not just the ledger: a 006 file appearing after the runner's own
      // discovery is precisely the case a ledger-only recheck would miss.
      const pairs = pairMigrations(discoverMigrations(opts.fsPort, { transactionModeByVersion: opts.transactionModeByVersion }));
      const rows = await opts.ledger.readLedger(session);
      // planApply REFUSES a dirty, checksum-mismatched, out-of-order or unknown-version history by
      // throwing. Surfacing its own code keeps "why" honest instead of flattening every unexpected
      // state into one label — and refusing is the only handling: this path never repairs.
      const pending = planApply(pairs, rows).pending;
      authoritative = [];
      for (let i = 0; i < pending.length; i += 1) {
        const p = pending[i];
        authoritative.push({ version: p.version, checksum: p.up.checksum, txScoped: p.up.transactionMode === 'required' });
      }
    } catch (e) {
      return boundedCode(e);
    }
    if (authoritative.length !== 1 || authoritative[0].version !== opts.authorizedVersion) {
      return EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED;
    }
    if (executionPlan.length !== authoritative.length) return EXECUTOR_CODES.MANAGED_PLAN_DRIFT;
    for (let i = 0; i < authoritative.length; i += 1) {
      const want = authoritative[i];
      const will = executionPlan[i];
      // CHECKSUM, not just version. Two different SQL bodies can wear the same version label, so
      // comparing labels would approve a run whose migration content changed after the program was
      // frozen — the authorized bytes and the executed bytes must be the same bytes.
      if (will.version !== want.version || will.checksum !== want.checksum || will.txScoped !== want.txScoped) {
        return EXECUTOR_CODES.MANAGED_PLAN_DRIFT;
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// C2B-M005-B0 — the single-purpose migration-005 authorization
//
// The governed artifact identity, as constants rather than as a lookup. The whole point of the
// under-lock check is that it must not be satisfiable by whatever the filesystem happens to hold
// at that moment, so what it compares against is frozen in this module and reviewed as source.
// ---------------------------------------------------------------------------

export const M005_VERSION = '005';
export const M005_UP_BASENAME = '005_principal_separation_rls_foundation.up.sql';
export const M005_DOWN_BASENAME = '005_principal_separation_rls_foundation.down.sql';
/** SHA-256 of the governed artifact bytes. Identical to the engine's own migration checksum. */
export const M005_UP_SHA256 = 'a4a61385beedf98194fb427bcd528704b068d7ca2947a9713d7a1a1c87157bda';
export const M005_DOWN_SHA256 = 'c198c0fa9c481cb2fe99c7f841aba4023bfbbef06663e2948755abca1d74db64';

/**
 * The migration-005 post-lock authorization: everything `createManagedExactPlanPolicy` does, plus
 * the artifact identity the plan was built from.
 *
 * WHY THE EXTRA WORK. The baseline runner adopted checksums that were computed BEFORE it reserved a
 * connection, and its read-back then compared the database against those same values — self-
 * referential, and blind to an artifact edited in the window. That window is wider on the apply
 * path, because apply also EXECUTES the bytes: a file swapped between discovery and the lock would
 * be executed and then recorded under a checksum computed from the file, so the ledger would agree
 * with the tampered artifact forever. Re-deriving under the lock closes the window; comparing
 * against a frozen constant closes the case where the whole directory was replaced consistently.
 *
 * Order matters and is not arbitrary. Shape first, because every later read of the ledger assumes
 * it; then artifact identity, because a drifted file must be refused before the plan is trusted;
 * then the plan, which is only meaningful once both hold.
 */
export function createManagedM005Policy(opts: {
  ledger: ExecutorLedgerPort;
  catalog: CatalogReadPort;
  fsPort: MigrationFsPort;
  transactionModeByVersion?: Readonly<Record<string, TransactionMode>>;
}): TrustedApplyPolicy {
  return async ({ session, executionPlan }) => {
    // 1) LEDGER SHAPE. `create table if not exists` cannot see a relation that already exists with
    //    a different definition, so this is the only place a wrong shape is detectable at all.
    try {
      const shape = await verifyLedgerShape(opts.catalog);
      if (shape.present && shape.failed.length > 0) return EXECUTOR_CODES.LEDGER_SHAPE_REJECTED;
    } catch {
      // A catalog read that fails is missing evidence, never evidence of a good shape.
      return ENGINE_CODES.PORT_OPERATION_FAILED;
    }

    // 2) ARTIFACT IDENTITY, re-derived through the same containment-enforcing port the engine uses:
    //    a canonical path inside the migrations directory, O_NOFOLLOW, and a regular-file check are
    //    all the port's own guarantees, so a swapped symlink or a FIFO fails here rather than being
    //    read. Both directions are checked: the DOWN file does not execute here, but a change to it
    //    means the governed pair is not the reviewed pair.
    try {
      for (const [basename, want] of [
        [M005_UP_BASENAME, M005_UP_SHA256],
        [M005_DOWN_BASENAME, M005_DOWN_SHA256],
      ] as const) {
        if (opts.fsPort.entryType(basename) !== 'file') return EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT;
        if (sha256Hex(opts.fsPort.readBytes(basename)) !== want) {
          return EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT;
        }
      }
    } catch {
      return EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT;
    }

    // 3) THE AUTHORITATIVE PLAN, re-derived under the lock from the same two sources.
    let authoritative: ExecutionUnit[];
    try {
      const pairs = pairMigrations(discoverMigrations(opts.fsPort, { transactionModeByVersion: opts.transactionModeByVersion }));
      const rows = await opts.ledger.readLedger(session);
      const pending = planApply(pairs, rows).pending;
      authoritative = pending.map((p) => ({ version: p.version, checksum: p.up.checksum, txScoped: p.up.transactionMode === 'required' }));
    } catch (e) {
      return boundedCode(e);
    }
    // Exactly one pending version, and it is 005. A 006 that became eligible in the window fails
    // here rather than riding along on a plan computed when it did not exist.
    if (authoritative.length !== 1 || authoritative[0].version !== M005_VERSION) {
      return EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED;
    }
    // The re-derived checksum must be the GOVERNED one, not merely self-consistent. Without this
    // an edited artifact would pass: discovery would hash the new bytes and the plan would agree
    // with itself perfectly.
    if (authoritative[0].checksum !== M005_UP_SHA256) return EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT;

    // 4) THE FROZEN PROGRAM must be the same work. `executionPlan` is read from the program's own
    //    execute effects, so this binds the bytes that will actually run.
    if (executionPlan.length !== authoritative.length) return EXECUTOR_CODES.MANAGED_PLAN_DRIFT;
    for (let i = 0; i < authoritative.length; i += 1) {
      const want = authoritative[i];
      const will = executionPlan[i];
      if (will.version !== want.version || will.checksum !== want.checksum || will.txScoped !== want.txScoped) {
        return EXECUTOR_CODES.MANAGED_PLAN_DRIFT;
      }
    }
    return null;
  };
}

/**
 * The migration-005 PRE-COMMIT default-ACL gate (C2B-M005-B1-R1).
 *
 * WHAT IT IS FOR. Migration 005's whole purpose on this path is to close the future-object
 * privileges, and until this existed the only thing that checked them ran after COMMIT. A
 * post-commit refusal is a disclosure: the DDL is durable, the default ACLs are whatever they are,
 * and the operator is told about it. This gate is evaluated with the bracket still open, so an
 * unfavourable answer PREVENTS the commit instead — the mutation is abandoned rather than reported.
 * Abandoned means COMMIT is never submitted and the connection is destroyed; this process issues no
 * ROLLBACK and observes no backend rollback (see `ApplyMutationState`).
 *
 * WHY IT CAN SEE THE MIGRATION'S OWN WRITES. The catalog port and the executor session are built
 * over the SAME reserved connection (`max: 1`, pinned by `reserve()`), so these reads run inside
 * the run's own uncommitted transaction. A second connection would see the pre-migration catalog
 * and would therefore refuse every correct run; that is the reason no second connection is opened,
 * not merely a containment preference.
 *
 * WHAT IT CHECKS, and it is the same evidence the read-only diagnostic uses, not a second opinion:
 *   1. the backend identity BEFORE the reads — a token that cannot be read establishes nothing;
 *   2. the CATALOG's own backend pid, which must equal (1) — so "same pinned connection" is proved
 *      here rather than inherited from how one call site happens to be wired;
 *   3. the executing principal and session principal, which must be readable and equal, because
 *      every default-ACL row considered is scoped to `current_user`;
 *   4. the bounded default-ACL rows — class filter before LIMIT, row budget a distinct bound
 *      parameter, overflow discarding every row;
 *   5. the backend identity AFTER them, which must equal (1), or the rows describe a backend that
 *      is not the one holding this transaction;
 *   6. `assessDefaultAclPosture`, whose two questions must BOTH be favourable: A = MET (nothing
 *      the classifier can see is open) and B = NO (nothing the current 005 bytes leave standing).
 *
 * BOTH QUESTIONS, not either. A is about the catalog as it now stands inside the transaction; B is
 * about what the executed statements can remove. A global TABLE or SEQUENCE grant fails both, and
 * that is the case this gate exists for: 005 issues no global TABLES or SEQUENCES revocation, so
 * such a row is not repaired, is not repairable by this migration, and must stop the commit.
 *
 * Every return is a fixed bounded code. No catalog row, role name, ACL text or backend token
 * crosses this boundary — `assessDefaultAclPosture` already reduces its evidence to labels and a
 * count, and none of those are returned either.
 */
export function createM005PreCommitPolicy(opts: {
  catalog: CatalogReadPort;
  /** Injectable ONLY so a deterministic test can drive the bounded reader; defaults to the real one. */
  readAcl?: typeof readDefaultAclRowsBounded;
}): TrustedApplyPolicy {
  const readAcl = opts.readAcl ?? readDefaultAclRowsBounded;
  return async ({ session }) => {
    /** A token is usable only as an exact non-empty string; anything else is "not established". */
    const readToken = async (): Promise<string | null> => {
      try {
        const id = await session.backendIdentity();
        if (id === null || typeof id !== 'object') return null;
        const token = (id as { token?: unknown }).token;
        return typeof token === 'string' && token !== '' && !token.includes('undefined') ? token : null;
      } catch {
        return null;
      }
    };

    // (1) BEFORE. An unreadable token here is missing evidence, NOT a changed backend: nothing has
    // been established yet, so claiming the identity CHANGED would assert a comparison never made.
    const before = await readToken();
    if (before === null) return EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE;

    // (2) THE CATALOG IS PROVED TO BE THE SAME BACKEND, not assumed to be.
    //
    // The session and the catalog arrive as two independent ports. That they ride the same pinned
    // connection is true of the production wiring and was, until this read, only true of it: a
    // catalog on another connection would see the PRE-migration catalog — clean, because 005 has
    // not committed — and could authorize a commit that the real backend's state forbids. Asking
    // the catalog for its own backend pid and requiring it to equal the session's token turns that
    // from a property of one call site into a property of this function.
    let catalogBackend: unknown;
    try {
      const rows = await opts.catalog.query('select pg_backend_pid() as pid', []);
      catalogBackend = rows[0]?.pid;
    } catch {
      return EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE;
    }
    if (catalogBackend === null || catalogBackend === undefined
      || `pid:${String(catalogBackend)}` !== before) {
      return EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED;
    }

    // (3) the principal pair, read from the server rather than assumed from any configuration.
    let principal: unknown;
    let sessionPrincipal: unknown;
    try {
      const rows = await opts.catalog.query(
        'select current_user as principal, session_user as session_principal', [],
      );
      const row = rows[0];
      if (row === undefined) return EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE;
      principal = row.principal;
      sessionPrincipal = row.session_principal;
    } catch {
      return EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE;
    }

    // (4) the bounded rows.
    let read: BoundedAclRead;
    try {
      read = await readAcl(opts.catalog);
    } catch {
      return EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE;
    }

    // (5) AFTER. Checked before the verdict is computed, so a verdict is never spoken about rows
    // that may have come from another backend. Unreadable and unequal are the SAME answer here,
    // because both leave continuity unestablished after a comparison was owed.
    const after = await readToken();
    if (after === null || after !== before) return EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED;

    // (6) the verdict — a pure function, so both of its questions can be exercised independently
    // of what the live class constant currently makes reachable.
    return choosePreCommitVerdict(assessDefaultAclPosture(principal, sessionPrincipal, read), read.overflowed);
  };
}

/**
 * The pre-commit verdict as a PURE FUNCTION of the assessment.
 *
 * SEPARATE FROM THE POLICY ON PURPOSE. Inline, question B could not be shown to decide anything:
 * with the current `M005_DEFAULT_ACL_CLASSES` flags every posture that yields B = YES also yields
 * A = UNMET, so B ⊂ A and deleting the B clause changed no observable behaviour. That is a fact
 * about today's class constant, not about the contract — the day 005 stops revoking a class
 * globally, B becomes the only question that can see it. Extracting the decision is what lets a
 * synthetic assessment prove the clause is live instead of inferring it from a comment.
 *
 * MISSING EVIDENCE AND A BLOCKER ARE DIFFERENT FINDINGS and never share a code: an operator must
 * not be told a grant was found when nothing was read.
 */
export function choosePreCommitVerdict(
  a: Pick<DefaultAclAssessment, 'principalAgreement' | 'postcondition' | 'blockerSurvivesCurrentM005'>,
  overflowed: boolean,
): string | null {
  if (overflowed
    || a.principalAgreement !== 'AGREED'
    || a.postcondition === 'UNREADABLE'
    || a.blockerSurvivesCurrentM005 === 'UNREADABLE') {
    return EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE;
  }
  if (a.postcondition !== 'MET' || a.blockerSurvivesCurrentM005 !== 'NO') {
    return EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT;
  }
  return null;
}

/**
 * The migration-005 POST-COMMIT verification, run on the same pinned session while the run lock is
 * still held.
 *
 * WHAT IT CAN AND CANNOT DO. It cannot un-commit anything and it does not try: by the time it runs,
 * COMMIT has resolved and the mutation stands. Its only job is to stop a run being REPORTED as
 * verified when the database does not show what the run believes it wrote — which is a different
 * and weaker claim than "the migration succeeded", and stating it as the weaker one is the point.
 *
 * FIVE INDEPENDENT QUESTIONS, in order of how directly they bear on the ledger:
 *   1. does the ledger hold exactly version 005, clean, at the governed checksum;
 *   2. is the pending set now empty — i.e. did nothing else become eligible during the run;
 *   3. do migration 005's own structural postconditions hold in the catalog;
 *   4. are the future-object (default) privileges closed for the EXECUTING principal, across both
 *      the global and the public-schema default ACLs;
 *   5. do the two capability roles — and PUBLIC — still hold neither CREATE nor TEMPORARY on the
 *      server-derived current database.
 * Every query runs on the SAME pinned session as the read-back, through the reserved connection the
 * handle's catalog port is built over, so (3)-(5) observe the backend that performed the commit
 * rather than whatever another pooled connection can see.
 * A failure of (3) with (1) passing is the interesting case: the ledger would claim an applied
 * migration whose objects are absent, and reporting that as success is exactly the outcome the
 * ledger's inability to distinguish adopted from executed makes hard to detect later.
 */
export function createM005PostCommitPolicy(opts: {
  ledger: ExecutorLedgerPort;
  catalog: CatalogReadPort;
  fsPort: MigrationFsPort;
  transactionModeByVersion?: Readonly<Record<string, TransactionMode>>;
}): TrustedApplyPolicy {
  return async ({ session }) => {
    let rows: LedgerRow[];
    try {
      // The SAME session the commit ran on, so this reads its own commit rather than whatever
      // another backend can see. A read that fails is missing evidence, never verification.
      rows = await opts.ledger.readLedger(session);
    } catch (e) {
      return boundedCode(e);
    }
    const row = rows.find((r) => r.version === M005_VERSION);
    if (row === undefined) return EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH;
    if (row.checksum !== M005_UP_SHA256) return EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH;
    // `dirty` is already fail-closed at the read (`toLedgerRowStrict`), so this is a genuine
    // boolean and a strict `!== false` cannot be satisfied by an unrepresentable value.
    if (row.dirty !== false) return EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH;

    try {
      const pairs = pairMigrations(discoverMigrations(opts.fsPort, { transactionModeByVersion: opts.transactionModeByVersion }));
      if (planApply(pairs, rows).pending.length !== 0) return EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH;
    } catch (e) {
      return boundedCode(e);
    }

    try {
      const failed = await verify005Postconditions(opts.catalog);
      if (failed.length > 0) return EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED;
    } catch {
      return ENGINE_CODES.PORT_OPERATION_FAILED;
    }

    // FUTURE-OBJECT PRIVILEGES, AFTER THE READ-BACK. The structural postconditions above are about
    // objects that exist now; these two are about what the database will do next. They run last
    // because a failure here is only meaningful once the ledger has been shown to claim a clean,
    // governed 005 — otherwise the finding would describe a database that never ran the migration.
    try {
      const failed = await verifyDefaultPrivileges(opts.catalog);
      if (failed.length > 0) return EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED;
    } catch {
      return ENGINE_CODES.PORT_OPERATION_FAILED;
    }

    try {
      const failed = await verifyCapabilityDatabasePrivileges(opts.catalog);
      if (failed.length > 0) return EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED;
    } catch {
      return ENGINE_CODES.PORT_OPERATION_FAILED;
    }
    return null;
  };
}

/**
 * WHERE THE MUTATION ACTUALLY STANDS, as six mutually exclusive states rather than one word.
 *
 * The operator question this answers is not "did it work" but "may anything have landed, and is a
 * re-run safe". `outcome` alone cannot answer it: a pre-commit refusal and a post-commit
 * verification failure are both `failed`, and they are opposite instructions — the first leaves no
 * durable SCHEMA change, the second leaves durable DDL.
 *
 * NOT "leaves nothing behind" (corrected in C2B-M005-B1-R2). The kernel's `required` grammar is
 * `insert_dirty · ( open_tx · … · commit_tx )`, and the managed ledger port writes that marker in
 * its OWN autocommit transaction on the reserved session, before the bracket opens — the engine
 * states this as contract ("the marker survives"). So a pre-commit refusal DOES leave a durable
 * `dirty = true` ledger row for the refused version, which `planApply` then treats as
 * `UNRESOLVED_DIRTY_ATTEMPT`. No state below names that residue, and no managed command currently
 * clears it; it is a RECORDED RESIDUAL of this stage, not a solved problem. Widening this type or
 * `ExecutorReport` to carry it is the narrowest correction, and it is deliberately NOT made here.
 *
 * ON THE TWO PRE-COMMIT LABELS, and why NEITHER NAMES A ROLLBACK (C2B-M005-B1-R2). This executor
 * has no rollback PORT and submits no ROLLBACK on this path: `ExecutorSession` exposes no rollback
 * operation, the kernel emits no rollback effect, and an open bracket is abandoned by DESTROYING
 * the connection (`terminate`). Whatever the backend then does with the abandoned bracket is a
 * server-side consequence this process never observes. The labels therefore name the only thing
 * that WAS observed — the connection disposal — and rank it by what that disposal established:
 * `resolved` when the destroy call itself succeeded (`disposal: 'terminated'`), `unverified`
 * otherwise. Even `resolved` is a CLIENT fact: it proves this process completed its termination
 * sequence, never that the socket closed gracefully and never that PostgreSQL has already aborted
 * the transaction. Process-level cleanup evidence is the isolated child's own exit, established by
 * the launcher — not by any value in this report. An earlier revision named these
 * `..._rollback_requested` / `..._rollback_unverified`; both dressed connection disposal as a
 * rollback that was neither requested nor observed, and they are gone.
 */
export type ApplyMutationState =
  | 'pre_commit_refusal_connection_disposal_resolved'
  | 'pre_commit_refusal_connection_disposal_unverified'
  | 'commit_not_attempted'
  | 'commit_failed_or_unknown'
  /** Covers a post-commit check that FAILED and one that never ran: neither verified the write. */
  | 'post_commit_verification_failed_may_have_committed'
  | 'success_commit_and_read_back_verified';

/**
 * Codes produced by EVALUATING the pre-commit gate — and only those.
 *
 * The two ENTRY refusals (`..._POLICY_MISSING`, `..._NOT_TRANSACTIONAL`) are deliberately NOT here.
 * They are decided before the first effect, so no lock was taken, no SQL ran and no bracket was
 * ever opened: giving them a disposal label would describe abandoning a bracket that never
 * existed, which is exactly the kind of unearned claim this vocabulary exists to prevent. They
 * fall through to `commit_not_attempted`, which is what actually happened.
 */
export const PRE_COMMIT_GATE_CODES: ReadonlySet<string> = new Set<string>([
  EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT,
  EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE,
  EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED,
  // The gate ran and did not answer. Same bracket, same executed migration, same abandonment —
  // only the reason differs, so it belongs to the same disposition.
  EXECUTOR_CODES.MANAGED_PRECOMMIT_UNEVALUATED,
]);

export function classifyApplyMutationState(ev: {
  outcome: ExecutionOutcome;
  code: string | null;
  commit: ApplyCommitEvidence;
  disposal: 'none' | 'closed' | 'terminated';
  /** Required, so the strongest verdict cannot be reached by a caller that omits the field. */
  preCommitVerified: boolean;
}): ApplyMutationState {
  // UNKNOWN IS ABSORBING and is decided first: once COMMIT is on the wire without a settled answer,
  // no later evidence narrows it back, and every other label would understate the risk.
  const outcome = applyCommitOutcome(ev.commit);
  if (outcome === 'unknown') return 'commit_failed_or_unknown';
  if (outcome === 'resolved') {
    // The SUCCESS label needs all three: a clean outcome, a durable read-back, AND a gate that
    // approved while the mutation could still be abandoned. Without the last conjunct the strongest
    // word in this vocabulary was derivable from a run the gate never saw.
    return ev.outcome === 'complete' && ev.commit.readBackVerified && ev.preCommitVerified
      ? 'success_commit_and_read_back_verified'
      : 'post_commit_verification_failed_may_have_committed';
  }
  // COMMIT was never submitted. Only a GATE code establishes that a bracket was open with the
  // migration already executed inside it, and only then is the connection disposal worth naming at
  // all — every other reason includes cases where nothing had been executed to abandon. Neither
  // label claims a rollback: `terminated` says the destroy call succeeded, nothing more.
  if (ev.code !== null && PRE_COMMIT_GATE_CODES.has(ev.code)) {
    return ev.disposal === 'terminated'
      ? 'pre_commit_refusal_connection_disposal_resolved'
      : 'pre_commit_refusal_connection_disposal_unverified';
  }
  return 'commit_not_attempted';
}

/**
 * WHETHER THIS RUN'S AUTOCOMMITTED DIRTY-MARKER WRITE HAPPENED. An observation, never a verdict.
 *
 *   not_attempted — the run refused before the `insert_dirty` effect was interpreted.
 *   succeeded     — the ledger port's write resolved. That write is in its OWN transaction, so it
 *                   is DURABLE from this moment on, whatever happens to the migration bracket.
 *   unknown       — the write did not resolve. `bounded` collapses a rejection and a deadline into
 *                   one failure, and even a definite client-side rejection cannot prove the server
 *                   did not apply the row before the answer was lost. Absorbing.
 */
export type DirtyMarkerWrite = 'not_attempted' | 'succeeded' | 'unknown';

/**
 * WHAT THE RUN ESTABLISHED ABOUT THE DURABLE LEDGER ROW, as four mutually exclusive states.
 *
 * This is the fact C2B-M005-B1-R2 could not express and therefore did not report. A pre-commit
 * refusal prevents the migration COMMIT — and leaves a durable dirty ledger row that `planApply`
 * then treats as `UNRESOLVED_DIRTY_ATTEMPT`, refusing every subsequent apply. Reporting only
 * `commit_attempted=false` reads as "nothing landed", which is the opposite of what happened: a
 * ledger MUTATION landed, and no implemented managed command clears it.
 *
 *   not_written    — no marker write was interpreted. Nothing to resolve.
 *   durable_dirty  — the marker write succeeded and COMMIT was never submitted, so the migration
 *                    transaction cannot have cleared it. The row is dirty and it is durable.
 *   clean_verified — the marker write succeeded, COMMIT resolved, AND the post-commit durable
 *                    read-back confirmed the ledger. Only this combination may claim clean.
 *   unknown        — the marker write is undetermined, or COMMIT is undetermined, or COMMIT
 *                    resolved without a verified read-back. Never narrowed to either certainty.
 */
export type LedgerMarkerState = 'not_written' | 'durable_dirty' | 'clean_verified' | 'unknown';

/**
 * Derive the durable ledger state. PURE, so the transitions are assertable without a database.
 *
 * ORDER IS THE CONTRACT:
 *   1. no write attempted outranks everything — there is nothing to be uncertain about;
 *   2. an undetermined WRITE outranks any commit evidence — a commit cannot clear a row that may
 *      never have existed, and it cannot fail to clear one that may;
 *   3. an undetermined COMMIT is unknown — the finalize inside that bracket may or may not stand;
 *   4. a resolved COMMIT may claim clean ONLY with the durable read-back; without it the client
 *      settled a promise and nothing read the database, so the honest answer is unknown;
 *   5. otherwise COMMIT was never submitted, and the autocommitted row is definitely still dirty.
 *
 * Connection disposal is deliberately NOT an input. Destroying the connection abandons the open
 * bracket; it does not touch a row that was committed before the bracket opened. A resolved
 * disposal must not clear this state and a failed disposal must not downgrade it.
 */
export function classifyLedgerMarker(ev: {
  dirtyMarkerWrite: DirtyMarkerWrite;
  commit: ApplyCommitEvidence;
}): LedgerMarkerState {
  if (ev.dirtyMarkerWrite === 'not_attempted') return 'not_written';
  if (ev.dirtyMarkerWrite === 'unknown') return 'unknown';
  const outcome = applyCommitOutcome(ev.commit);
  if (outcome === 'unknown') return 'unknown';
  if (outcome === 'resolved') return ev.commit.readBackVerified ? 'clean_verified' : 'unknown';
  // EXPLICIT, NOT A FALL-THROUGH. `durable_dirty` is the strongest negative claim in this
  // vocabulary — "the row IS dirty and it IS durable" — so it is spoken only for the one commit
  // outcome that entails it. A catch-all `return 'durable_dirty'` would keep saying it if
  // `applyCommitOutcome` ever gained a fourth value, which is precisely how a certainty outlives
  // the evidence that earned it. Anything else is unknown.
  return outcome === 'not_submitted' ? 'durable_dirty' : 'unknown';
}

/**
 * The managed-apply operator verdict, as a PURE FUNCTION of the evidence.
 *
 * WHY THIS IS NOT INLINE IN THE CLI. It was, and the only thing asserting it was a regular
 * expression over the CLI's own source text. Four separate mutations that kept the matched text and
 * destroyed the behaviour all passed: rebinding the refusal to a dead local, and reordering the
 * branches so an UNDETERMINED commit renders as "did not complete" — the exact "reads as nothing
 * happened" wording that invites the re-run this path must never permit. A source regex cannot see
 * ordering, and ordering is the whole contract here.
 *
 * ORDER IS THE CONTRACT, stated once:
 *   1. an UNKNOWN commit outranks everything — it is the one state a bare failure renders
 *      dangerously, and it forbids a re-run whatever else is true;
 *   2. then a run that did not complete;
 *   3. then a complete run that never verified its own read-back, which is not a verified apply;
 *   4. an unverified lock release and an unestablished teardown are APPENDED, never substituted:
 *      each is a residual an operator must act on even when the primary outcome was clean.
 */
export function classifyManagedApplyRefusal(op: string, ev: {
  outcome: ExecutionOutcome;
  code: string | null;
  commit: ApplyCommitEvidence;
  lockRelease: LockReleaseState;
  /** C2B-M005-B1-R1 — required, so a caller cannot omit it and get the fail-open reading. */
  preCommitVerified: boolean;
  /**
   * C2B-M005-B1-R1 — also required. The CLI used to append its own "closure NOT ESTABLISHED" line
   * and then OVERWRITE `refusal` with this function's return, discarding it; the verdict is
   * supposed to be total, and it cannot be total about evidence it is not shown.
   */
  disposal: 'none' | 'closed' | 'terminated';
  /**
   * C2B-M005-B1-R3 — REQUIRED, so the durable ledger consequence cannot be omitted by a caller
   * that simply does not pass it. A durable dirty marker forces a refusal whatever else is true.
   */
  ledgerMarker: LedgerMarkerState;
  teardown?: { completed: boolean; code: string | null } | null;
}): string | null {
  let refusal: string | null = null;
  const commitOutcome = applyCommitOutcome(ev.commit);
  if (commitOutcome === 'unknown') {
    refusal =
      `${op} COMMIT OUTCOME IS UNKNOWN — the transaction may or may not have committed. `
      + 'Do NOT re-run. Do NOT compensate. Verify the authoritative ledger state before any continuation';
  } else if (ev.outcome !== 'complete') {
    refusal = `${op} did not complete: ${ev.code ?? 'unknown'}`;
  } else if (!ev.preCommitVerified) {
    // DEFENCE IN DEPTH, and ordered ABOVE the read-back deliberately. The executor already refuses
    // the exact-005 program when no pre-commit gate is supplied, so a `complete` run reaching here
    // with the flag false would mean COMMIT happened around the gate rather than after it — a
    // graver statement than an unverified read-back, and one an operator must see first.
    refusal = `${op} completed without a pre-commit default-ACL verification`;
  } else if (!ev.commit.readBackVerified) {
    refusal = `${op} completed without a post-commit read-back verification`;
  }
  if (ev.lockRelease === 'unverified') {
    const lock =
      'run advisory-lock release is UNVERIFIED — the lock may still be held by a live backend. '
      + 'Nothing is retried and no second connection is opened automatically.';
    refusal = refusal === null ? `${op}: ${lock}` : `${refusal}. ${lock}`;
  }
  if (ev.disposal === 'none') {
    // Termination was ATTEMPTED and did not establish closure, so the session-scoped advisory
    // lock's release is neither proven nor provably outstanding. Appended, never substituted.
    const closure =
      'session closure NOT ESTABLISHED — session-level advisory-lock release is UNKNOWN. '
      + 'Verify state before any continuation; nothing is retried and no second connection is opened automatically.';
    refusal = refusal === null ? `${op}: ${closure}` : `${refusal}. ${closure}`;
  }
  if (ev.teardown != null && !ev.teardown.completed) {
    const t =
      `client teardown NOT ESTABLISHED (${ev.teardown.code ?? 'unknown'}) — the managed connection `
      + 'was not proved shut down; nothing is retried and no second connection is opened automatically.';
    refusal = refusal === null ? `${op}: ${t}` : `${refusal}. ${t}`;
  }
  // C2B-M005-B1-R3 — THE DURABLE LEDGER CONSEQUENCE, appended LAST and never substituted.
  //
  // It is mandatory rather than conditional on the primary outcome: a durable dirty marker is a
  // committed ledger MUTATION, and it is exactly the fact `commit_attempted=false` invites an
  // operator to assume did not happen. `commit_attempted` speaks only for the migration
  // transaction; this speaks for the ledger row written before that transaction opened.
  //
  // No remedy is named. No managed command implements one, and inventing an instruction here
  // would send an operator to a flag that refuses.
  if (ev.ledgerMarker === 'durable_dirty') {
    const m =
      'a DURABLE DIRTY LEDGER MARKER REMAINS for the attempted migration — the ledger mutation '
      + 'committed in its own transaction before the migration transaction opened, so it survives '
      + 'the abandoned bracket. FUTURE APPLY IS BLOCKED: the planner refuses an unresolved dirty '
      + 'attempt. Resolution requires separately authorized investigation; nothing is retried, no '
      + 'marker is cleared and no second connection is opened automatically.';
    refusal = refusal === null ? `${op}: ${m}` : `${refusal}. ${m}`;
  } else if (ev.ledgerMarker === 'not_written' && ev.commit.submitted) {
    // DEFENCE IN DEPTH, and structurally unreachable on the managed path — which is exactly why it
    // must refuse rather than pass silently. The kernel's `required` grammar puts `insert_dirty`
    // before `open_tx`, so a run that reached COMMIT with no marker ever written did not execute
    // the choreography this verdict is describing. It is the same argument as the pre-commit flag
    // above: the graver reading of a "clean" report is that the ordering was bypassed.
    const m =
      'NO DIRTY LEDGER MARKER WAS WRITTEN and COMMIT was nonetheless submitted — the recorded '
      + 'sequence is not the one this path executes. Treat the ledger state as unestablished and '
      + 'verify it before any continuation; nothing is retried and no marker is written or cleared.';
    refusal = refusal === null ? `${op}: ${m}` : `${refusal}. ${m}`;
  } else if (ev.ledgerMarker === 'unknown') {
    const m =
      'the LEDGER MARKER STATE IS UNKNOWN — a dirty ledger row for the attempted migration may or '
      + 'may not be durable, and this run cannot narrow it to either. Verify the authoritative '
      + 'ledger state before any continuation; nothing is retried, no marker is cleared and no '
      + 'second connection is opened automatically.';
    refusal = refusal === null ? `${op}: ${m}` : `${refusal}. ${m}`;
  }
  return refusal;
}

/**
 * A READ ONLY transaction bracket over the ONE reserved session, for diagnostics only.
 *
 * WHY IT IS A SEPARATE PORT rather than a reuse of `ExecutorSession.beginTx`/`executeSql`: those
 * two exist to run checksum-bound MIGRATION SQL, and `executeSql` takes arbitrary text. A read-only
 * diagnostic that borrowed them would be indistinguishable, at the type level, from a path that can
 * write — and the containment argument for the diagnostic rests on it having no reachable write
 * operation at all. Every statement on this port is a FIXED literal; the only value that varies is
 * a millisecond count, and it is proved a safe positive integer before it is ever formatted.
 *
 * `begin()` opens `READ ONLY`, which PostgreSQL enforces server-side: inside the bracket INSERT,
 * UPDATE, DELETE, TRUNCATE, COPY FROM, DDL and temporary-object creation are refused by the server
 * whatever this process asks for. That is an ADDITIONAL control layered over the fixed call path,
 * never the primary one.
 */
export interface ReadOnlyTxPort {
  /** `begin transaction read only` — issued before any diagnostic query. */
  begin(): Promise<void>;
  /** Transaction-LOCAL bounds. `set local` reverts at end of transaction; nothing survives it. */
  applyLocalTimeouts(ms: number): Promise<void>;
  /** The server's own view of the bracket: `show transaction_read_only`. */
  isReadOnly(): Promise<boolean>;
  /** The only way this bracket ends. There is deliberately no commit entry point on this port. */
  finish(): Promise<void>;
}

/**
 * C2B-M005-P2-B0 — a SEPARATE bounded snapshot bracket for the comprehensive migration-005
 * preflight, added rather than folded into `ReadOnlyTxPort`.
 *
 * WHY A SECOND PORT AND NOT A WIDENED FIRST ONE. The accepted default-ACL diagnostic asks ONE
 * question and its bracket is `begin transaction read only` at the server default isolation. The
 * comprehensive preflight asks MANY questions whose answers must describe ONE database state, so a
 * statement-level snapshot is not sufficient: under READ COMMITTED each read takes a fresh
 * snapshot, and a ledger read, a policy read and a constraint read could each be true of a
 * different instant. Changing the shared port's isolation would silently change the ACCEPTED
 * diagnostic's semantics, which the stage does not authorize; adding a port changes nothing that
 * already exists.
 *
 * ISOLATION IS OBSERVED, NOT ASSUMED. `isolationLevel()` reports the SERVER's own view via
 * `show transaction_isolation`, so a bracket that did not take the level it asked for is a refusal
 * rather than an unstated assumption. Both it and `isReadOnly()` are read before the catalog reads
 * and again after them.
 *
 * THIS PORT HAS NO COMMIT AND NO WRITE. `finish()` issues `rollback` and is the only exit; a
 * snapshot diagnostic has nothing to commit, and the server-side READ ONLY bracket refuses INSERT,
 * UPDATE, DELETE, TRUNCATE, COPY FROM and DDL whatever the caller asks for.
 */
export interface SnapshotTxPort {
  /** `begin transaction isolation level repeatable read, read only`. One statement, no caller input. */
  begin(): Promise<void>;
  /** Transaction-LOCAL bounds. `set local` reverts at end of transaction; nothing survives it. */
  applyLocalTimeouts(ms: number): Promise<void>;
  /** The server's own view of the bracket: `show transaction_read_only`. */
  isReadOnly(): Promise<boolean>;
  /** The server's own view of the isolation level: `show transaction_isolation`. */
  isolationLevel(): Promise<string>;
  /** The only way this bracket ends. There is deliberately no commit entry point on this port. */
  finish(): Promise<void>;
}

export interface ManagedDevExecutorHandle {
  adapter: ExecutorAdapter;
  ledger: ExecutorLedgerPort;
  catalog: CatalogReadPort;
  /** READ ONLY bracket for the default-ACL diagnostic. No commit, no write, fixed statements. */
  readOnlyTx: ReadOnlyTxPort;
  /** REPEATABLE READ + READ ONLY snapshot bracket for the comprehensive migration-005 preflight. */
  snapshotTx: SnapshotTxPort;
  write: BaselineWritePort;
  /** Owner-side database ACL surface. Hardening only — see revokeTemporaryFromPublic. */
  ownerAcl: {
    databasePublicPrivileges(): Promise<{ create: boolean; temporary: boolean }>;
    isCurrentPrincipalDatabaseOwner(): Promise<boolean>;
    revokeTemporaryFromPublic(): Promise<void>;
  };
  /**
   * Tear the client down and REPORT the result. Never throws — it is called from a caller's
   * `finally`, where a throw would replace the real failure with a shutdown error — but the
   * failure is no longer discarded either. See TeardownResult.
   */
  dispose(): Promise<TeardownResult>;
}

/**
 * The result of the ONE teardown request a managed run makes.
 *
 * WHAT EACH FIELD IS, and why they are not one boolean:
 *
 *   requested            — the teardown was asked for. Always true from `dispose()`: the request
 *                          is what this process controls, and it makes exactly one (postgres.js
 *                          caches its shutdown promise, so a retry would re-await a settled
 *                          rejection rather than try again).
 *   completed            — the request itself resolved. A rejection here means the client did not
 *                          finish its shutdown sequence, and previously that fact was swallowed by
 *                          a bare `.catch(() => {})` — so a run could exit 0 while a backend may
 *                          still have been alive.
 *   gracefulSocketClose  — permanently 'not_observed', and stated rather than omitted.
 *                          `client.end({timeout:0})` DESTROYS the socket; it does not wait for or
 *                          report a graceful FIN exchange, so no value of `completed` is evidence
 *                          about the socket. The no-live-child guarantee comes from process exit
 *                          plus an empty process group and session, not from this field.
 *   code                 — a bounded code when `completed` is false; never a driver message.
 */
export interface TeardownResult {
  readonly requested: true;
  readonly completed: boolean;
  readonly gracefulSocketClose: 'not_observed';
  readonly code: string | null;
}

/**
 * Build the PostgreSQL ports for a validated MANAGED DEV target.
 *
 * TLS is resolved by the repository's own policy resolver, imported HERE rather than accepted as
 * a parameter: a caller-supplied ssl object is a caller-suppliable weakening, and the one thing
 * this boundary must not allow is an unverified transport. There is no `rejectUnauthorized:false`
 * branch, no plaintext fallback, and no way to reach the client from outside this function.
 */
export async function createManagedDevExecutor(
  dsn: ManagedDevDsn,
  options: { statementTimeoutMs?: number } = {},
): Promise<ManagedDevExecutorHandle> {
  const target = MANAGED_TARGET.get(dsn);
  if (target === undefined) return fail(EXECUTOR_CODES.MANAGED_DSN_INVALID, 'unvalidated handle');

  const { default: postgres } = await import('postgres');
  // Dynamic, for the same reason the driver import is dynamic: the production graph must not
  // acquire a static edge into the database layer merely by type-importing this module.
  const { resolveDatabaseTls } = await import('./db');
  // Policy only. The string it reads decides whether the TRANSPORT is acceptable; it decides
  // nothing about the destination, which is already sealed.
  const ssl = resolveDatabaseTls(target.tlsPolicySource); // throws before any client exists

  const statementTimeoutMs =
    Number.isSafeInteger(options.statementTimeoutMs) && (options.statementTimeoutMs as number) > 0
      ? (options.statementTimeoutMs as number)
      : 60_000;

  // NO connection string is passed. postgres.js only reaches its own authority parser when its
  // first argument is a string, so with an options object there is no multihost list and no query
  // string left to spread into `connection` and overwrite the server-side bounds below.
  //
  // What it does NOT do is take the host verbatim: `index.js` still runs
  // `host.split(',').map(x => x.split(':')[0])` and still promotes a host containing `/` to a UNIX
  // socket, on the options path too. Those hazards are dead here because the HOST GRAMMAR cannot
  // express `,`, `:` or `/` — credit the grammar, not the driver, or a future loosening of one
  // will silently re-arm the other.
  // NOT SEALED, and honestly so: `target_session_attrs` is resolved by the driver as
  // `o.target_session_attrs || url.searchParams.get(...) || env.PGTARGETSESSIONATTRS`, a `||` chain
  // whose only accepted values are truthy ('read-write', 'standby', …). There is no truthy value
  // meaning "no requirement", so no option value can shut the ambient fallback — passing `null`
  // would look like a pin and be one only by accident of the environment being empty.
  // PGTARGETSESSIONATTRS therefore remains reachable. It cannot REROUTE anything (`options.host` is
  // a one-element array, so the `prefer-standby` retry branch has nowhere to go); its reach is an
  // unsupported value throwing during construction, or a supported one forcing an extra round-trip.
  // Availability, not authority — recorded as a residual rather than papered over.
  const client = postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    pass: target.password,
    database: target.database,
    max: 1,
    prepare: false,
    idle_timeout: 0,
    connect_timeout: 15,
    onnotice: () => {},
    ssl,
    // `parseOptions` resolves every OTHER key as `k in o ? o[k] : … : env['PG' + KEY] || default`.
    // That is a PRESENCE test, so naming a key here — even with a falsy value — shuts the ambient
    // fallback for it. `debug` is the one with a security consequence: `PGDEBUG` makes SQL text and
    // bound parameters enumerable on driver errors.
    debug: false,
    connection: {
      // Spread AFTER the driver's own `application_name: env.PGAPPNAME || 'postgres.js'`, so this
      // wins and PGAPPNAME cannot write the operator's string into the startup packet.
      application_name: 'tmpos-migrator',
      statement_timeout: statementTimeoutMs,
      lock_timeout: Math.max(1000, Math.floor(statementTimeoutMs / 2)),
      idle_in_transaction_session_timeout: statementTimeoutMs,
    },
  });

  type Reserved = Awaited<ReturnType<typeof client.reserve>>;
  let reservedConn: Reserved | null = null;
  let destroyed = false;

  const dispose = async (): Promise<void> => {
    if (destroyed) return;
    // The latch is set only AFTER the shutdown actually resolves, so a FAILING end() cannot be
    // recorded as a disposal that was never achieved — for a connection that may still be alive
    // holding the run's advisory lock.
    //
    // What this does NOT buy is a second attempt: postgres.js caches teardown in `ending` and
    // returns that same promise to every later `end()` (src/index.js), so a retry would merely
    // re-await an already-settled rejection. The ordering is about TRUTHFUL REPORTING only.
    await client.end({ timeout: 0 });
    destroyed = true;
  };
  /**
   * The handle-level teardown. Still never throws — a caller's `finally` must not have the real
   * failure replaced by a shutdown error — but the outcome is now REPORTED instead of discarded.
   *
   * The latch is read first so the request is made exactly once: a second call reports the state
   * the first established rather than re-awaiting postgres.js's cached shutdown promise.
   */
  const disposeReporting = async (): Promise<TeardownResult> => {
    if (destroyed) return { requested: true, completed: true, gracefulSocketClose: 'not_observed', code: null };
    try {
      await dispose();
      return { requested: true, completed: true, gracefulSocketClose: 'not_observed', code: null };
    } catch {
      // The driver error is dropped unread — it can carry a DSN, a credential or SQL. Only the
      // bounded fact of failure crosses this boundary, which is the whole contract of this type.
      return { requested: true, completed: false, gracefulSocketClose: 'not_observed', code: EXECUTOR_CODES.CLIENT_TEARDOWN_FAILED };
    }
  };
  /** Never-throws, result-free wrapper for the internal cancel path, which has no reporting seam. */
  const disposeQuietly = async (): Promise<void> => { await dispose().catch(() => {}); };
  const requireConn = (): Reserved => {
    if (reservedConn === null) throw new MigrationExecutorError(EXECUTOR_CODES.PORT_FAILED, 'no reserved session');
    return reservedConn;
  };

  const session: ExecutorSession = {
    confirmLive: async () => { await requireConn()`select 1`; },
    backendIdentity: async (): Promise<BackendIdentity> => {
      const rows = await requireConn()`select pg_backend_pid() as pid`;
      return { token: `pid:${String(rows[0]?.pid)}` };
    },
    acquireRunLock: async (key: number) => {
      const rows = await requireConn()`select pg_try_advisory_lock(${key}::bigint) as acquired`;
      return rows[0]?.acquired === true;
    },
    releaseRunLock: async (key: number) => {
      const rows = await requireConn()`select pg_advisory_unlock(${key}::bigint) as released`;
      return rows[0]?.released === true;
    },
    beginTx: async () => { await requireConn().unsafe('begin'); },
    commitTx: async () => { await requireConn().unsafe('commit'); },
    executeSql: async (sqlText: string) => { await requireConn().unsafe(sqlText).simple(); },
    // RELEASE, not shut down. The managed recovery flow deliberately runs several trusted
    // runners over ONE handle — a ledger read, then the baseline, then the apply — and each
    // ends its phase with close(). Ending the pool here would tear down the client after the
    // FIRST phase; every later phase would then either reconnect onto a different backend
    // (silently losing the advisory lock the run depends on) or fail with no useful reason.
    // The pool is ended once, by the CLI's own `finally { handle.dispose() }`.
    close: async () => {
      const c = reservedConn;
      reservedConn = null;
      if (c !== null) c.release();
    },
    // A terminate is the uncertain path: tear the connection down so PostgreSQL drops the advisory
    // lock and aborts any open transaction, rather than returning a suspect backend to a pool.
    //
    // PRECISION, because the disposal vocabulary depends on it: postgres.js `terminate()` writes
    // the protocol Terminate message and calls `socket.end()` — a half-close initiated by THIS
    // side, not `socket.destroy()`, and not a graceful close OBSERVED to have completed. It is a
    // different mechanism from the handle teardown's `end({timeout:0})`, which destroys outright
    // and reports `gracefulSocketClose: 'not_observed'`; neither may be read as the other. A backend blocked inside a statement reads it only when that statement
    // ends. So `disposal: 'terminated'` proves the client COMPLETED its termination sequence, not
    // that the backend session has already ended; for a blocked backend the lock can outlive the
    // report, bounded by the server-side statement_timeout / idle_in_transaction_session_timeout
    // configured on this client. It is still the strongest cleanup this path can obtain, and it is
    // strictly stronger than pooling a suspect connection — but it is not instantaneous.
    //
    // It calls `dispose`, NOT `disposeQuietly`. Requesting termination is not the same as
    // achieving it: if `client.end()` rejects, the backend may still be alive holding this run's
    // SESSION-scoped advisory lock. Swallowing that made `bounded(() => session.terminate())`
    // always succeed, so `terminateQuietly` took its `disposal: 'terminated'` branch
    // unconditionally and the tool claimed a closure — and by implication a lock release — it had
    // no evidence for. The failure now propagates and the caller records the truth.
    terminate: async () => {
      reservedConn = null;
      await dispose();
    },
  };

  const adapter: ExecutorAdapter = {
    // IDEMPOTENT by design. The whole run is bound to ONE physical backend (`max: 1`), and the
    // managed recovery flow legitimately reserves more than once: the CLI reserves to run the
    // live fingerprint, then hands the same adapter to runTrustedLedgerRead / the baseline /
    // runTrustedApply, each of which reserves again. A second `client.reserve()` against a
    // one-connection pool waits for the connection this very code path is already holding, so
    // the run would block until its own deadline and report a timeout instead of working.
    // Returning the already-pinned session also keeps the advisory lock and any open
    // transaction on the SAME backend, which is the property the session lock depends on.
    reserve: async () => {
      // FAIL-CLOSED once destroyed. `terminate()` nulls `reservedConn` AND ends the client, so
      // without this a later phase's reserve would call `client.reserve()` on an ended pool — which
      // postgres.js satisfies by CONNECTING A NEW BACKEND (`connect(closed.shift())` resets the
      // connection's `terminated` flag). That revived session holds none of the run's locks, and
      // `dispose()`'s `destroyed` latch would then make the CLI's `finally { handle.dispose() }` a
      // no-op, leaving it to be cleaned up by process exit alone. A destroyed handle is finished.
      if (destroyed) return fail(EXECUTOR_CODES.PORT_FAILED, 'handle destroyed');
      if (reservedConn === null) reservedConn = await client.reserve();
      return session;
    },
    cancelReserve: async () => { await disposeQuietly(); },
  };

  const ledger: ExecutorLedgerPort = {
    readLedger: async (): Promise<LedgerRow[]> => {
      const c = requireConn();
      const present = await c`select to_regclass('public.schema_migrations') is not null as ok`;
      if (present[0]?.ok !== true) return [];
      const rows = await c`select version, checksum, dirty from public.schema_migrations order by version asc`;
      // FAIL-CLOSED, not coercing. `r.dirty === true` mapped a NULL, a string, or a numeric 0 to
      // `false` — this system's word for "completed cleanly" — so an unrepresentable state read as
      // the safest possible one. `toLedgerRowStrict` refuses instead, at the read, before any
      // planner or gate sees the row. Applied on BOTH adapters: the coercion was identical in each,
      // and leaving the disposable one fail-open would keep the defect alive in the path the
      // integration proofs run through.
      return rows.map((r) => toLedgerRowStrict(r as Record<string, unknown>));
    },
    insertDirtyAttempt: async (_s, row) => {
      const c = requireConn();
      await c.unsafe(LEDGER_DDL);
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

  const catalog: CatalogReadPort = {
    query: async (text, params) => {
      // Parameters are always driver-bound values (schema/relation/constraint NAMES), never
      // interpolated into the statement text — the queries above are fixed literals.
      const rows = await requireConn().unsafe(text, params as never[]);
      return rows as unknown as Record<string, unknown>[];
    },
  };

  const write: BaselineWritePort = {
    writeAdoptedPrefix: async (rows, observe) => {
      const c = requireConn();
      // ONE bracket for the DDL and EVERY row. A throw BEFORE commit rolls the whole thing back,
      // so a committed partial prefix cannot exist. The rollback is best-effort but the original
      // error is always the one that propagates — a failed rollback must not be reported as a
      // different, more benign failure.
      await c.unsafe('begin');
      let submitted = false;
      try {
        await c.unsafe(LEDGER_DDL);
        for (const r of rows) {
          await c`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
                  values (${r.version}, ${r.checksum}, false, ${r.at}::timestamptz, ${r.at}::timestamptz)`;
        }
        // Marked BEFORE the await, deliberately. Once COMMIT is on the wire no client-side outcome
        // — a rejection, a dropped socket, or a deadline that never lets this line resume — can say
        // whether PostgreSQL committed. This function is the only place standing at that boundary,
        // so it is the only place that can record which side of it the failure happened on.
        submitted = true;
        observe.commitSubmitted();
        await c.unsafe('commit');
        observe.commitAcknowledged();
      } catch (e) {
        // NO rollback once COMMIT is submitted. It cannot undo a commit that may already have
        // landed, and issuing it would dress an UNDETERMINED outcome as a rolled-back one — the
        // exact false claim this path exists to avoid. Before COMMIT the rollback is real.
        if (!submitted) await c.unsafe('rollback').catch(() => {});
        throw e;
      }
    },
  };

  const ownerAcl = {
    databasePublicPrivileges: async (): Promise<{ create: boolean; temporary: boolean }> => {
      const rows = await requireConn()`
        select has_database_privilege('public', current_database(), 'CREATE')    as c,
               has_database_privilege('public', current_database(), 'TEMPORARY') as t`;
      return { create: rows[0]?.c === true, temporary: rows[0]?.t === true };
    },
    isCurrentPrincipalDatabaseOwner: async (): Promise<boolean> => {
      const rows = await requireConn()`
        select pg_get_userbyid(datdba) = current_user as owner
          from pg_database where datname = current_database()`;
      return rows[0]?.owner === true;
    },
    revokeTemporaryFromPublic: async (): Promise<void> => {
      // `current_database()` is resolved by the SERVER, so the statement cannot be redirected to
      // another database by any caller value — there is no identifier interpolation here at all.
      // PostgreSQL only accepts a literal database name in REVOKE, so the name is quoted through
      // format(%I) inside a DO block rather than concatenated by this process.
      await requireConn().unsafe(
        `do $$ begin execute format('revoke temporary on database %I from public', current_database()); end $$;`,
      );
    },
  };

  // The handle exposes the QUIET disposer: it is called from a caller's `finally`, where a throw
  // would replace the real failure with a shutdown error.
  // The handle exposes the REPORTING disposer. It is still safe in a `finally` — it never throws —
  // but a failed shutdown is now a value the caller must deal with rather than a silent no-op.
  const readOnlyTx: ReadOnlyTxPort = {
    begin: async () => { await requireConn().unsafe('begin transaction read only'); },
    applyLocalTimeouts: async (ms: number) => {
      // The ONLY varying value on this port, and it is not interpolated until it has been proved a
      // safe positive integer — anything else would otherwise reach the statement text.
      // The upper bound is PostgreSQL's int4 ceiling for these GUCs. Without it a large safe
      // integer would be formatted into the statement and REFUSED BY THE SERVER as a driver error
      // rather than refused cleanly here — a bounded refusal is the contract this port owes.
      if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
        return fail(EXECUTOR_CODES.PORT_FAILED, 'invalid transaction timeout');
      }
      const lock = Math.max(1000, Math.floor(ms / 2));
      await requireConn().unsafe(
        `set local statement_timeout = ${ms}; `
          + `set local lock_timeout = ${lock}; `
          + `set local idle_in_transaction_session_timeout = ${ms}`,
      ).simple();
    },
    isReadOnly: async () => {
      const rows = await requireConn().unsafe('show transaction_read_only');
      const v = (rows as unknown as Record<string, unknown>[])[0]?.transaction_read_only;
      return v === 'on';
    },
    finish: async () => { await requireConn().unsafe('rollback'); },
  };

  // C2B-M005-P2-B0 — the snapshot bracket. Same connection discipline as `readOnlyTx`: every
  // statement goes through `requireConn()`, which THROWS rather than opening a second backend, and
  // there is no commit entry point. The only difference is the declared isolation level, and the
  // fact that the level is reported back from the server rather than assumed.
  const snapshotTx: SnapshotTxPort = {
    // READ ONLY IS DECLARED IN THE SAME STATEMENT AS THE ISOLATION LEVEL, not set afterwards.
    // `set transaction read only` issued after `begin` is a second round trip during which the
    // bracket is open and writable; naming both in the BEGIN leaves no such window.
    begin: async () => {
      await requireConn().unsafe('begin transaction isolation level repeatable read, read only');
    },
    applyLocalTimeouts: async (ms: number) => {
      if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
        return fail(EXECUTOR_CODES.PORT_FAILED, 'invalid transaction timeout');
      }
      const lock = Math.max(1000, Math.floor(ms / 2));
      await requireConn().unsafe(
        `set local statement_timeout = ${ms}; `
          + `set local lock_timeout = ${lock}; `
          + `set local idle_in_transaction_session_timeout = ${ms}`,
      ).simple();
    },
    isReadOnly: async () => {
      const rows = await requireConn().unsafe('show transaction_read_only');
      const v = (rows as unknown as Record<string, unknown>[])[0]?.transaction_read_only;
      return v === 'on';
    },
    // A STRING OR THE EMPTY STRING, never a throw and never a guess. An unreadable level is
    // reported as '' so the caller refuses on missing evidence rather than on a thrown driver
    // message that could carry a DSN.
    isolationLevel: async () => {
      const rows = await requireConn().unsafe('show transaction_isolation');
      const v = (rows as unknown as Record<string, unknown>[])[0]?.transaction_isolation;
      return typeof v === 'string' ? v : '';
    },
    finish: async () => { await requireConn().unsafe('rollback'); },
  };

  return { adapter, ledger, catalog, readOnlyTx, snapshotTx, write, ownerAcl, dispose: disposeReporting };
}
