// Phase 4.0 M3 S1b — trusted migration executor: DATABASE-FREE unit contract.
//
// This suite never connects to PostgreSQL. It proves the executor's SAFETY BOUNDARY (which
// DSNs may ever be reached) and its EFFECT INTERPRETATION (that it obeys the pure kernel's
// prescribed order, bounds every await, and disposes physically on every uncertain path)
// using injected fakes. The real-PostgreSQL proof lives in tests/db/, run only by `test:db`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTOR_CODES,
  MigrationExecutorError,
  countSqlStatements,
  resolveDisposableTestDsn,
  assertDisposableTestDsn,
  describeDsn,
  runTrustedApply,
  runTrustedLedgerRead,
  // --- C2B-R2 managed DEV recovery path ---
  CANONICAL_PLATFORM_ROLES,
  CANONICAL_TENANT_ROLES,
  LEGACY_PLATFORM_ROLES,
  assertExactManagedApplyPlan,
  assertManagedDevDsn,
  createManagedExactPlanPolicy,
  describeManagedDsn,
  describeManagedDriverRouting,
  resolveManagedApplyDirection,
  detectPre005Residue,
  runTrustedHistoricalBaseline,
  verifyHistoricalPostconditions,
  verifyManagedDevFingerprint,
  // --- C2B-M005-B0 single-purpose migration-005 hardening ---
  LEDGER_COLUMN_CONTRACT,
  LEDGER_RELATION,
  M005_DOWN_BASENAME,
  M005_DOWN_SHA256,
  M005_UP_BASENAME,
  M005_UP_SHA256,
  M005_VERSION,
  applyCommitOutcome,
  classifyManagedApplyRefusal,
  PRE_COMMIT_GATE_CODES,
  choosePreCommitVerdict,
  classifyApplyMutationState,
  classifyLedgerMarker,
  boundedExecutorError,
  isKnownBoundedCode,
  createM005PostCommitPolicy,
  readDefaultAclRowsBounded,
  requiredPreCommitEntryRefusal,
  createM005PreCommitPolicy,
  createManagedM005Policy,
  normalizeLedgerDirty,
  toLedgerRowStrict,
  verify005Postconditions,
  classifyDefaultPrivileges,
  verifyDefaultPrivileges,
  verifyCapabilityDatabasePrivileges,
  M005_DEFAULT_ACL_CLASSES,
  M005_DEFAULT_ACL_GRANTEES,
  M005_UNCOVERED_DEFAULT_ACL_CLASSES,
  M005_CAPABILITY_ROLES,
  verifyLedgerShape,
  canonicalLedgerShapeCategories,
  LEDGER_SHAPE_CATEGORY_ORDER,
  type LedgerShapeCategory,
  type CatalogReadPort,
  type ExecutorSession,
  type ExecutorAdapter,
  type ExecutorLedgerPort,
  type BaselineCommitObserver,
  type TrustedApplyDeps,
  type TrustedApplyPolicy,
} from './migrationExecutor';
import {
  ENGINE_CODES,
  runMigrations,
  sha256Hex,
  type BackendIdentity,
  type LedgerRow,
  type MigrationFsPort,
} from './migrationEngine';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The code of a thrown executor error, or a marker — never the raw error. */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (e) {
    const d = e === null || typeof e !== 'object' ? undefined : Object.getOwnPropertyDescriptor(e, 'code');
    return d !== undefined && typeof d.value === 'string' ? d.value : `OTHER:${String(e)}`;
  }
};

/** A structurally valid disposable socket DSN, as the local harness constructs it. */
const SOCKET_DSN = 'postgres:///tmpos_s1b_run?host=/tmp/tmpos-s1b-abc/sock';
/** A structurally valid disposable loopback DSN, as the CI service provides it. */
const LOOPBACK_DSN = 'postgres://tmpos:tmpos@127.0.0.1:5432/tmpos_s1b_ci';

/** Ambient application/provider DSNs that must never be consulted. */
const AMBIENT = {
  DATABASE_URL: 'postgres://app:secretpw@db.example-managed.com:5432/appdb',
  SUPABASE_DATABASE_URL: 'postgres://postgres.abcdefgh:secretpw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
  APP_DATABASE_URL: 'postgres://app:secretpw@10.0.0.9:5432/production',
};

// ---------------------------------------------------------------------------
// 1-4: the ONLY variable consulted is TM_POS_TEST_DATABASE_URL
// ---------------------------------------------------------------------------

test('S1b-1: a missing TM_POS_TEST_DATABASE_URL refuses BEFORE any connection is attempted', () => {
  assert.equal(codeOf(() => resolveDisposableTestDsn({})), EXECUTOR_CODES.TEST_DSN_MISSING);
  assert.equal(codeOf(() => resolveDisposableTestDsn({ TM_POS_TEST_DATABASE_URL: '' })), EXECUTOR_CODES.TEST_DSN_MISSING);
  assert.equal(codeOf(() => resolveDisposableTestDsn({ TM_POS_TEST_DATABASE_URL: '   ' })), EXECUTOR_CODES.TEST_DSN_MISSING);
});

test('S1b-2: an ambient DATABASE_URL is ignored — it can never supply the executor', () => {
  assert.equal(
    codeOf(() => resolveDisposableTestDsn({ DATABASE_URL: AMBIENT.DATABASE_URL })),
    EXECUTOR_CODES.TEST_DSN_MISSING,
    'an ambient application DSN must not stand in for the test variable',
  );
});

test('S1b-3: an ambient SUPABASE_DATABASE_URL is ignored', () => {
  assert.equal(
    codeOf(() => resolveDisposableTestDsn({ SUPABASE_DATABASE_URL: AMBIENT.SUPABASE_DATABASE_URL })),
    EXECUTOR_CODES.TEST_DSN_MISSING,
  );
});

test('S1b-4: an ambient APP_DATABASE_URL is ignored, even alongside a valid test DSN', () => {
  assert.equal(
    codeOf(() => resolveDisposableTestDsn({ APP_DATABASE_URL: AMBIENT.APP_DATABASE_URL })),
    EXECUTOR_CODES.TEST_DSN_MISSING,
  );
  // With BOTH present the resolver must use the test variable and nothing else.
  const dsn = resolveDisposableTestDsn({ ...AMBIENT, TM_POS_TEST_DATABASE_URL: SOCKET_DSN });
  assert.equal(describeDsn(dsn).database, 'tmpos_s1b_run');
  assert.equal(describeDsn(dsn).hostKind, 'unix_socket');
});

// ---------------------------------------------------------------------------
// 5-7: host, database-name, and pool-mode boundaries
// ---------------------------------------------------------------------------

test('S1b-5: a nonlocal host refuses before connection — only a task socket or loopback is accepted', () => {
  const nonlocal = [
    'postgres://u:p@db.example-managed.com:5432/tmpos_s1b_x',
    'postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/tmpos_s1b_x',
    'postgres://u:p@10.0.0.9:5432/tmpos_s1b_x',
    'postgres://u:p@[2001:db8::1]:5432/tmpos_s1b_x',
    'postgres://u:p@192.168.1.5:5432/tmpos_s1b_x',
  ];
  for (const raw of nonlocal) {
    assert.equal(codeOf(() => assertDisposableTestDsn(raw)), EXECUTOR_CODES.TEST_DSN_HOST_NOT_LOCAL, raw);
  }
  // The two accepted shapes.
  assert.equal(describeDsn(assertDisposableTestDsn(SOCKET_DSN)).hostKind, 'unix_socket');
  assert.equal(describeDsn(assertDisposableTestDsn(LOOPBACK_DSN)).hostKind, 'loopback');
});

test('S1b-6: a database name without the tmpos_s1b_ prefix refuses', () => {
  const bad = [
    'postgres://u:p@127.0.0.1:5432/postgres',
    'postgres://u:p@127.0.0.1:5432/appdb',
    'postgres://u:p@127.0.0.1:5432/tmpos_s1c_run',
    'postgres://u:p@127.0.0.1:5432/',
    'postgres:///notprefixed?host=/tmp/x/sock',
  ];
  for (const raw of bad) {
    assert.equal(codeOf(() => assertDisposableTestDsn(raw)), EXECUTOR_CODES.TEST_DSN_DATABASE_NOT_DISPOSABLE, raw);
  }
});

test('S1b-7: a transaction-pool or runtime-pooler DSN refuses for the migrator', () => {
  const pooled = [
    'postgres://u:p@127.0.0.1:6543/tmpos_s1b_x',
    'postgres://u:p@127.0.0.1:5432/tmpos_s1b_x?pgbouncer=true',
    'postgres://u:p@127.0.0.1:5432/tmpos_s1b_x?pool_mode=transaction',
  ];
  for (const raw of pooled) {
    assert.equal(codeOf(() => assertDisposableTestDsn(raw)), EXECUTOR_CODES.TEST_DSN_POOL_MODE_REJECTED, raw);
  }
});

// ---------------------------------------------------------------------------
// 8: nothing secret ever leaves the boundary
// ---------------------------------------------------------------------------

test('S1b-8: no password, complete DSN, or credential appears in any executor output', () => {
  const withSecret = 'postgres://tmpos_migrator:sup3r-s3cret-pw@127.0.0.1:5432/tmpos_s1b_x';
  const dsn = assertDisposableTestDsn(withSecret);
  const described = JSON.stringify(describeDsn(dsn));
  assert.ok(!described.includes('sup3r-s3cret-pw'), 'the password must never be described');
  assert.ok(!described.includes(withSecret), 'the complete DSN must never be described');
  assert.ok(!described.includes('tmpos_migrator'), 'the username must never be described');
  assert.equal(described.includes('tmpos_s1b_x'), true, 'the disposable database NAME is the only identifier reported');

  // The refusal errors carry a bounded code and no DSN content either.
  const err = (() => {
    try {
      assertDisposableTestDsn('postgres://u:leaked-pw@db.example-managed.com:5432/tmpos_s1b_x');
      return null;
    } catch (e) {
      return e as MigrationExecutorError;
    }
  })();
  assert.ok(err !== null, 'a nonlocal host must throw');
  assert.equal(err.code, EXECUTOR_CODES.TEST_DSN_HOST_NOT_LOCAL);
  assert.ok(!err.message.includes('leaked-pw'), `message leaked a credential: ${err.message}`);
  assert.ok(!err.message.includes('db.example-managed.com'), `message leaked a host: ${err.message}`);
});

// ---------------------------------------------------------------------------
// executor-core fixtures: a fake filesystem, a recording session, a recording ledger
// ---------------------------------------------------------------------------

const UP_SQL = 'create table alpha();\n';
const DOWN_SQL = 'drop table alpha;\n';
const UP2_SQL = 'create table beta();\n';
const DOWN2_SQL = 'drop table beta;\n';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A fake discovery port carrying two well-formed migration pairs. */
function fakeFs(files: Record<string, string>): MigrationFsPort {
  return {
    relDir: 'server/platform-identity/migrations',
    list: () => Object.keys(files),
    entryType: () => 'file',
    readBytes: (b: string) => {
      const v = files[b];
      if (v === undefined) throw new Error('missing');
      return enc(v);
    },
  };
}

const ONE = {
  '001_alpha_table.up.sql': UP_SQL,
  '001_alpha_table.down.sql': DOWN_SQL,
};
const TWO = {
  ...ONE,
  '002_beta_table.up.sql': UP2_SQL,
  '002_beta_table.down.sql': DOWN2_SQL,
};

interface Recorder {
  ops: string[];
  sessions: unknown[];
  txDepth: number;
  disposed: string[];
}

interface FakeOptions {
  /** op name -> behaviour override. `hang` never settles; `throw` rejects. */
  behaviour?: Record<string, 'hang' | 'throw'>;
  /** backend identity token sequence; the last value repeats. */
  tokens?: string[];
  lockAcquired?: boolean;
  unlockReleased?: boolean;
  /** when set, reserve() hangs and later settles with a session after this many ms. */
  lateReserveMs?: number;
  /** 1-based index of the commit_tx that should REJECT. Earlier commits resolve normally. */
  commitFailAt?: number;
}

function fakeSession(rec: Recorder, opt: FakeOptions): ExecutorSession {
  let idIdx = 0;
  let commits = 0;
  const tokens = opt.tokens ?? ['pid-1'];
  const gate = async (op: string): Promise<void> => {
    rec.ops.push(op);
    const b = opt.behaviour?.[op];
    if (b === 'hang') await new Promise(() => {});
    if (b === 'throw') throw new Error(`driver exploded in ${op} with secret pw=hunter2`);
  };
  const session: ExecutorSession = {
    confirmLive: async () => { await gate('confirm_live'); },
    backendIdentity: async (): Promise<BackendIdentity> => {
      await gate('identity');
      const t = tokens[Math.min(idIdx, tokens.length - 1)];
      idIdx += 1;
      return { token: t };
    },
    acquireRunLock: async () => { await gate('acquire_lock'); return opt.lockAcquired !== false; },
    releaseRunLock: async () => { await gate('release_lock'); return opt.unlockReleased !== false; },
    beginTx: async () => { await gate('begin_tx'); rec.txDepth += 1; },
    commitTx: async () => {
      await gate('commit_tx');
      commits += 1;
      // A multi-migration plan reaches this more than once, and the evidence must describe THIS
      // commit rather than the first one that happened to succeed.
      if (opt.commitFailAt === commits) throw new Error('driver rejected the commit');
      rec.txDepth -= 1;
    },
    executeSql: async (_sql: string, txScoped: boolean) => {
      await gate(`execute:${txScoped ? 'tx' : 'raw'}:depth=${rec.txDepth}`);
    },
    close: async () => { await gate('close'); rec.disposed.push('closed'); },
    // Routed through the gate like every other port call: without this a disposal FAILURE was
    // not expressible, and the branch that must never turn a failed destroy into success was
    // structurally untestable.
    terminate: async () => { await gate('terminate'); rec.disposed.push('terminated'); },
  };
  return session;
}

function fakeDeps(
  files: Record<string, string>,
  ledgerRows: LedgerRow[],
  opt: FakeOptions = {},
): { deps: TrustedApplyDeps; rec: Recorder } {
  const rec: Recorder = { ops: [], sessions: [], txDepth: 0, disposed: [] };
  const session = fakeSession(rec, opt);
  /** Same gate as the session's: a ledger call must be able to hang as well as throw. */
  const ledgerGate = async (op: string): Promise<void> => {
    rec.ops.push(op);
    const b = opt.behaviour?.[op];
    if (b === 'hang') await new Promise(() => {});
    if (b === 'throw') throw new Error('ledger exploded');
  };
  const adapter: ExecutorAdapter = {
    reserve: async () => {
      rec.ops.push('reserve');
      if (opt.behaviour?.reserve === 'throw') throw new Error('reserve exploded: dsn=postgres://u:pw@h/db');
      if (opt.lateReserveMs !== undefined) {
        await new Promise((r) => setTimeout(r, opt.lateReserveMs));
        return session;
      }
      if (opt.behaviour?.reserve === 'hang') await new Promise(() => {});
      return session;
    },
    cancelReserve: async () => { rec.ops.push('cancel_reserve'); },
  };
  const ledger: ExecutorLedgerPort = {
    readLedger: async (s) => { rec.sessions.push(s); await ledgerGate('read_ledger'); return ledgerRows; },
    insertDirtyAttempt: async (s, row) => {
      rec.sessions.push(s);
      await ledgerGate(`insert_dirty:${row.version}`);
    },
    finalizeApplied: async (s, row, txScoped) => {
      rec.sessions.push(s);
      await ledgerGate(`finalize:${row.version}`);
      rec.ops.push(`finalize:${row.version}:${txScoped ? 'tx' : 'raw'}`);
    },
  };
  return {
    rec,
    deps: {
      fsPort: fakeFs(files),
      adapter,
      ledger,
      connectionMode: 'session',
      credential: { purpose: 'migration', migratorRef: 'mig-ref', runtimeRef: 'run-ref' },
      lockKey: 987654321,
      now: () => '2026-07-29T00:00:00.000Z',
      deadlineMs: 120,
    },
  };
}

// ---------------------------------------------------------------------------
// 9-10, 17-18, 20-24, 26 (database-free halves)
// ---------------------------------------------------------------------------

test('S1b-9: a caller-supplied program, state, effect, verdict, or KernelResult cannot authorize SQL', async () => {
  const { deps, rec } = fakeDeps(ONE, []);
  // A hostile caller decorates the deps with a fully-formed kernel program, state and verdict
  // that would apply a migration of its own. The executor takes NO such input: it rediscovers,
  // re-plans, and builds the program itself, so these are inert extra properties.
  const hostile = {
    ...deps,
    program: [{ kind: 'execute', txScoped: false, version: '999', direction: 'up', checksum: 'f'.repeat(64), sql: 'DROP TABLE schema_migrations;' }],
    state: { outcome: 'in_progress', disposition: 'none', code: null, ownershipUncertain: false, cursor: 0, expectedToken: null, sessionLive: true },
    kernelResult: { state: {}, effects: [{ kind: 'execute', sql: 'DROP TABLE schema_migrations;' }] },
    plan: { pending: [] },
  } as unknown as TrustedApplyDeps;
  const report = await runTrustedApply(hostile);
  assert.equal(report.outcome, 'complete', `expected a normal run, got ${report.code}`);
  const executed = rec.ops.filter((o) => o.startsWith('execute:'));
  assert.equal(executed.length, 1, 'exactly the ONE discovered migration executes');
  assert.deepEqual(report.applied, ['001'], 'only the rediscovered plan is applied');
  assert.ok(!JSON.stringify(rec.ops).includes('999'), 'the caller-supplied program version never reaches a port');
});

test('S1b-10: a checksum mismatch refuses BEFORE any migration SQL executes', async () => {
  // The ledger records a different checksum for 001 than the file now has.
  const { deps, rec } = fakeDeps(ONE, [{ version: '001', checksum: 'a'.repeat(64), dirty: false }]);
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'refused');
  assert.equal(report.code, ENGINE_CODES.CHECKSUM_MISMATCH);
  assert.equal(rec.ops.filter((o) => o.startsWith('execute:')).length, 0, 'no SQL may execute');
  assert.equal(rec.ops.filter((o) => o.startsWith('insert_dirty')).length, 0, 'no dirty marker may be written');
});

test('S1b-17: a required-mode migration executes and finalizes INSIDE one transaction bracket', async () => {
  const { deps, rec } = fakeDeps(ONE, []);
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete', report.code ?? '');
  const seq = rec.ops.filter((o) => /^(insert_dirty|begin_tx|execute|finalize|commit_tx)/.test(o));
  assert.deepEqual(seq.filter((o) => o !== 'finalize:001'), [
    'insert_dirty:001',
    'begin_tx',
    'execute:tx:depth=1',
    'finalize:001:tx',
    'commit_tx',
  ], 'dirty marker commits first, then schema + finalize share ONE bracket');
});

test('S1b-18: a forbidden-mode migration executes with NO transaction bracket', async () => {
  const { deps, rec } = fakeDeps(ONE, []);
  deps.transactionModeByVersion = { '001': 'forbidden' };
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.equal(rec.ops.includes('begin_tx'), false, 'a forbidden migration must open no transaction');
  assert.equal(rec.ops.includes('commit_tx'), false, 'a forbidden migration must commit no transaction');
  const seq = rec.ops.filter((o) => /^(insert_dirty|execute|finalize)/.test(o));
  assert.deepEqual(seq.filter((o) => o !== 'finalize:001'),
    ['insert_dirty:001', 'execute:raw:depth=0', 'finalize:001:raw']);
});

test('S1b-20: the ledger dirty and finalize operations use ONE port on the SAME session', async () => {
  const { deps, rec } = fakeDeps(TWO, []);
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.ok(rec.sessions.length >= 5, 'read + 2 dirty + 2 finalize');
  const distinct = new Set(rec.sessions);
  assert.equal(distinct.size, 1, 'every ledger operation ran on exactly one session object');
});

test('S1b-21: every awaited database operation carries a bounded deadline', async () => {
  // A lock acquisition that never settles must become a bounded verdict, not a hang.
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { acquire_lock: 'hang' } });
  const started = Date.now();
  const report = await runTrustedApply(deps);
  const elapsed = Date.now() - started;
  assert.equal(report.outcome, 'failed');
  assert.equal(report.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT);
  assert.ok(elapsed < 5000, `the run must not hang; took ${elapsed}ms`);
  assert.equal(rec.ops.filter((o) => o.startsWith('execute:')).length, 0);
});

test('S1b-22: a timeout prevents every later effect and can never reach a clean close', async () => {
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { acquire_lock: 'hang' } });
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'failed');
  assert.equal(rec.ops.includes('close'), false, 'a clean close must never follow a timeout');
  assert.equal(report.disposal, 'terminated', 'a confirmed live session is destroyed, never pooled');
  assert.equal(rec.disposed.includes('closed'), false);
  assert.equal(rec.disposed.includes('terminated'), true);
});

test('S1b-23: reserve uncertainty cancels the attempt and disposes a LATE settlement', async () => {
  // reserve() settles AFTER the deadline: the kernel gets a timeout, and the session that
  // arrives late must be physically disposed rather than leaked or pooled.
  const { deps, rec } = fakeDeps(ONE, [], { lateReserveMs: 260 });
  deps.deadlineMs = 60;
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'failed');
  assert.equal(report.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT);
  assert.equal(report.ownershipUncertain, true, 'a reserve that never settled leaves ownership uncertain');
  assert.equal(report.disposition, 'cancel_and_dispose');
  assert.equal(rec.ops.includes('cancel_reserve'), true, 'the outstanding attempt must be cancelled');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(report.lateSettlementDisposed, true, 'the late session must be disposed');
  assert.equal(rec.disposed.includes('terminated'), true);
  assert.equal(rec.disposed.includes('closed'), false, 'a late session must never be cleanly closed');
});

test('S1b-24: failure cleanup can never be reported as success, and leaks no driver text', async () => {
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { 'insert_dirty:001': 'throw' } });
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'failed', 'a ledger failure is a failure');
  assert.notEqual(report.outcome as string, 'complete');
  assert.equal(report.disposal, 'terminated');
  assert.equal(rec.ops.includes('close'), false);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('hunter2'), 'no driver secret may survive into the report');
  assert.ok(!serialized.includes('ledger exploded'), 'no raw driver message may survive into the report');
  assert.ok(!/postgres:\/\//.test(serialized), 'no DSN may survive into the report');
});

test('S1b-26: the public S1 runMigrations entry point remains unconditionally fail-closed', async () => {
  await assert.rejects(
    () => runMigrations({ pending: [] }, {} as never),
    (e: unknown) => (e as { code?: string }).code === ENGINE_CODES.MIGRATION_EXECUTION_UNAVAILABLE,
    'the exported S1 entry point must remain a refusal, not an execution authority',
  );
});

test('S1b-25a: executed SQL is re-bound to its declared checksum inside the executor', async () => {
  // The executor re-hashes the SQL it is about to run and compares it with the checksum the
  // canonical effect carries, so nothing between planning and execution can substitute text.
  const { deps } = fakeDeps(ONE, []);
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.deepEqual(report.executedChecksums, [sha256Hex(enc(UP_SQL))]);
});

// ---------------------------------------------------------------------------
// statement counting — the basis of the forbidden-mode guarantee
// ---------------------------------------------------------------------------

test('S1b-29: SQL statement counting ignores semicolons that are not statement separators', () => {
  const one = [
    'create index concurrently i on t (a);',
    'create index concurrently i on t (a)',
    "select ';';",
    '-- a; comment\nselect 1;',
    '/* a; block */ select 1;',
    '/* nested /* block; */ still */ select 1;',
    'do $$ begin perform 1; perform 2; end $$;',
    'do $tag$ begin perform 1; end $tag$;',
    'select "a;b" from t;',
    "select 'it''s; fine';",
    '   \n\t select 1 ;   \n',
  ];
  for (const sql of one) assert.equal(countSqlStatements(sql), 1, JSON.stringify(sql));

  const many = [
    'select 1; select 2;',
    "set lock_timeout='5s'; create index concurrently i on t (a);",
    'select 1;\ncreate index concurrently i on t (a);\n',
  ];
  for (const sql of many) assert.ok(countSqlStatements(sql) > 1, JSON.stringify(sql));

  // CONSERVATIVE by design: anything unparseable counts as many, so it is refused, never run.
  for (const sql of ["select 'unterminated", 'select /* unterminated', 'select $$unterminated']) {
    assert.ok(countSqlStatements(sql) > 1, `unterminated input must refuse: ${sql}`);
  }
  assert.equal(countSqlStatements(''), 0);
  assert.equal(countSqlStatements('   \n  '), 0);
});

test('S1b-30: a MULTI-statement transaction-forbidden migration is refused before any statement runs', async () => {
  const MULTI = {
    '001_multi_stmt.up.sql': "set lock_timeout='5s';\ncreate index concurrently idx on alpha (id);\n",
    '001_multi_stmt.down.sql': 'drop index if exists idx;\n',
  };
  const { deps, rec } = fakeDeps(MULTI, []);
  deps.transactionModeByVersion = { '001': 'forbidden' };
  const report = await runTrustedApply(deps);
  // 'refused', not 'failed': the refusal happens at PLAN time, before the kernel emits an effect,
  // so no ledger write and no schema statement ever occur.
  assert.equal(report.outcome, 'refused');
  assert.equal(report.code, EXECUTOR_CODES.FORBIDDEN_MODE_MULTI_STATEMENT);
  assert.equal(rec.ops.filter((o) => o.startsWith('execute:')).length, 0, 'no statement may run');
  assert.equal(rec.ops.filter((o) => o.startsWith('insert_dirty')).length, 0, 'no dirty marker may be written');
  assert.deepEqual(report.executedChecksums, []);
  // The SAME file in required mode is fine: an explicit bracket is exactly what it then gets.
  const ok = fakeDeps(MULTI, []);
  const okReport = await runTrustedApply(ok.deps);
  assert.equal(okReport.outcome, 'complete', okReport.code ?? '');
  assert.ok(ok.rec.ops.includes('begin_tx'));
});

// ---------------------------------------------------------------------------
// credential + connection-mode propagation (previously untested through the executor)
// ---------------------------------------------------------------------------

test('S1b-31: a runtime or self-asserted credential is refused, and no port is ever touched', async () => {
  const cases: Array<[Partial<TrustedApplyDeps>, string]> = [
    [{ credential: { purpose: 'runtime', migratorRef: 'm', runtimeRef: 'r' } }, ENGINE_CODES.RUNTIME_CREDENTIAL_REJECTED],
    [{ credential: { purpose: 'test', migratorRef: 'm', runtimeRef: 'r' } as never }, ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED],
    [{ credential: { purpose: 'migration', migratorRef: 'same', runtimeRef: 'same' } }, ENGINE_CODES.CREDENTIAL_EQUALITY_REJECTED],
    [{ credential: { purpose: 'migration' } as never }, ENGINE_CODES.INVALID_CREDENTIAL_REF],
    [{ connectionMode: 'transaction' }, ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED],
    [{ connectionMode: 'unknown' }, ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED],
  ];
  for (const [patch, expected] of cases) {
    const { deps, rec } = fakeDeps(ONE, []);
    Object.assign(deps, patch);
    const report = await runTrustedApply(deps);
    assert.equal(report.outcome, 'refused', JSON.stringify(patch));
    assert.equal(report.code, expected, JSON.stringify(patch));
    assert.equal(rec.ops.filter((o) => o.startsWith('execute:')).length, 0, 'no SQL may run');
    assert.equal(rec.ops.filter((o) => o.startsWith('insert_dirty')).length, 0, 'no ledger write may occur');
  }
});

// ---------------------------------------------------------------------------
// deadline coverage at EVERY awaited call site, not just one sample
// ---------------------------------------------------------------------------

test('S1b-32: EVERY awaited port operation is deadline-bounded, including executeSql', async () => {
  const sites = ['confirm_live', 'identity', 'acquire_lock', 'begin_tx', 'execute:tx:depth=1', 'commit_tx', 'close'];
  for (const site of sites) {
    const { deps, rec } = fakeDeps(ONE, [], { behaviour: { [site]: 'hang' } });
    const started = Date.now();
    const report = await runTrustedApply(deps);
    const elapsed = Date.now() - started;
    assert.equal(report.outcome, 'failed', `hanging ${site} must fail`);
    assert.equal(report.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT, `hanging ${site} must time out`);
    assert.ok(elapsed < 8000, `hanging ${site} must not hang the run (${elapsed}ms)`);
    assert.equal(rec.ops.includes('close'), site === 'close', `no clean close after a ${site} timeout`);
  }
  // the two ledger call sites too
  for (const site of ['insert_dirty:001', 'finalize:001']) {
    const { deps } = fakeDeps(ONE, [], { behaviour: { [site]: 'hang' } });
    const report = await runTrustedApply(deps);
    assert.equal(report.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT, `hanging ${site} must time out`);
  }
});

// ---------------------------------------------------------------------------
// disposal honesty — a failed destroy must never read as a clean one
// ---------------------------------------------------------------------------

test('S1b-33: a disposal that FAILS is reported as such, never upgraded to a clean termination', async () => {
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { 'insert_dirty:001': 'throw', terminate: 'throw' } });
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'failed');
  assert.equal(report.disposal, 'none', 'a failed destroy must NOT be reported as terminated');
  // The PRIMARY failure keeps the code — it is the more informative one — and the failed destroy
  // is visible as disposal 'none'. What must never happen is a failed destroy reading as clean.
  assert.equal(report.code, ENGINE_CODES.PORT_OPERATION_FAILED);
  assert.equal(rec.disposed.includes('terminated'), false);
  assert.equal(rec.disposed.includes('closed'), false);
});

test('S1b-34: the read-only ledger path reports the disposal it actually achieved', async () => {
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { read_ledger: 'throw', terminate: 'throw' } });
  const read = await runTrustedLedgerRead({
    adapter: deps.adapter, ledger: deps.ledger, connectionMode: 'session', deadlineMs: 120,
  });
  assert.equal(read.outcome, 'failed');
  assert.equal(read.disposal, 'none', 'a failed destroy must not be flattened into terminated');
  assert.equal(rec.disposed.includes('terminated'), false);

  // and the happy path really does close cleanly, taking no lock and running no migration SQL
  const good = fakeDeps(ONE, [{ version: '001', checksum: 'x'.repeat(64), dirty: false }]);
  const ok = await runTrustedLedgerRead({
    adapter: good.deps.adapter, ledger: good.deps.ledger, connectionMode: 'session', deadlineMs: 2000,
  });
  assert.equal(ok.outcome, 'complete');
  assert.equal(ok.disposal, 'closed');
  assert.equal(ok.rows.length, 1);
  assert.equal(good.rec.ops.includes('acquire_lock'), false, 'the read path takes no advisory lock');
  assert.equal(good.rec.ops.filter((o) => o.startsWith('execute:')).length, 0, 'the read path runs no migration SQL');
});

// ---------------------------------------------------------------------------
// a foreign `code` must never ride into the report
// ---------------------------------------------------------------------------

test('S1b-35: an unrecognised error code from a port is replaced, never echoed into the report', async () => {
  const hostile = Object.assign(new Error('boom'), {
    code: "postgres://u:pw@host/db -- DROP TABLE schema_migrations;",
  });
  const { deps } = fakeDeps(ONE, []);
  deps.ledger = {
    readLedger: async () => { throw hostile; },
    insertDirtyAttempt: async () => {},
    finalizeApplied: async () => {},
  };
  const report = await runTrustedApply(deps);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('DROP TABLE'), 'a caller-controlled code must not reach the report');
  assert.ok(!/postgres:\/\//.test(serialized), 'a DSN-shaped code must not reach the report');
});

// ---------------------------------------------------------------------------
// Phase 4.0 M3 S4.1b C2B-R2 — managed DEV recovery path
//
// Still DATABASE-FREE. Every catalog answer below is a fake, so these prove the DECISIONS
// (which targets are reachable, which histories are adoptable, what is refused) without a
// managed endpoint existing.
// ---------------------------------------------------------------------------

interface FakeCatalogState {
  tables?: Record<string, boolean>;
  constraints?: Record<string, { contype: string; convalidated: boolean; def: string }>;
  triggers?: string[];
  indexes?: string[];
  functions?: string[];
  auditActions?: string[];
  memberships?: { status: string; n: number }[];
  policyCount?: string;
  roles?: string[];
}

function fakeCatalog(s: FakeCatalogState): CatalogReadPort {
  return {
    query: async (text: string, params: readonly unknown[]) => {
      if (text.includes('relrowsecurity')) {
        const t = String(params[1]);
        const rls = s.tables?.[t];
        return rls === undefined ? [] : [{ rls }];
      }
      if (text.includes('pg_get_constraintdef')) {
        const c = s.constraints?.[`${String(params[1])}.${String(params[2])}`];
        return c === undefined ? [] : [c];
      }
      if (text.includes('pg_trigger')) {
        return (s.triggers ?? []).includes(`${String(params[1])}.${String(params[2])}`) ? [{ ok: 1 }] : [];
      }
      if (text.includes("relkind = 'i'")) {
        return (s.indexes ?? []).includes(String(params[1])) ? [{ ok: 1 }] : [];
      }
      if (text.includes('pg_proc')) {
        return (s.functions ?? []).includes(String(params[1])) ? [{ ok: 1 }] : [];
      }
      if (text.includes('group by action_id')) {
        return (s.auditActions ?? []).map((a) => ({ action_id: a, n: '1' }));
      }
      if (text.includes("role_id = 'system_owner'")) {
        return (s.memberships ?? []).map((m) => ({ status: m.status, n: m.n }));
      }
      if (text.includes('pg_roles')) {
        return (s.roles ?? []).map((r) => ({ rolname: r }));
      }
      if (text.includes('pg_policies')) {
        return [{ n: s.policyCount ?? '0' }];
      }
      return [];
    },
  };
}

/** A catalog in which 001-004 are all genuinely present and 005 has NOT run. */
const HEALTHY: FakeCatalogState = {
  tables: {
    platform_identity: true, app_user: true, tenant: true, store: true,
    user_membership: true, tenant_feature_entitlement: true, audit_event: true, identity_link: true,
  },
  constraints: {
    'platform_identity.platform_identity_provider_uid_key': { contype: 'u', convalidated: true, def: 'UNIQUE (auth_provider, auth_provider_uid)' },
    'user_membership.user_membership_scope_consistency_chk': { contype: 'c', convalidated: true, def: 'CHECK (true)' },
    'user_membership.user_membership_unique_grant': { contype: 'u', convalidated: true, def: 'UNIQUE (a,b)' },
    'audit_event.audit_event_metadata_flat_chk': { contype: 'c', convalidated: true, def: 'CHECK (audit_metadata_is_flat(metadata))' },
    'user_membership.user_membership_role_scope_chk': {
      contype: 'c', convalidated: true,
      def: "CHECK (scope_type = 'platform' AND role_id = ANY (ARRAY['system_owner'::text, 'support_admin'::text, 'billing_admin'::text, 'operations_admin'::text, 'security_admin'::text]) OR scope_type = ANY (ARRAY['tenant'::text,'store'::text]) AND role_id = ANY (ARRAY['store_owner'::text,'manager'::text,'technician'::text,'sales_staff'::text]))",
    },
    'identity_link.identity_link_status_chk': { contype: 'c', convalidated: true, def: 'CHECK (true)' },
    'identity_link.identity_link_verification_method_chk': { contype: 'c', convalidated: true, def: 'CHECK (true)' },
    'identity_link.identity_link_firebase_ref_fk': { contype: 'f', convalidated: true, def: 'FOREIGN KEY (x)' },
    'identity_link.identity_link_supabase_ref_fk': { contype: 'f', convalidated: true, def: 'FOREIGN KEY (y)' },
  },
  triggers: [
    'platform_identity.trg_platform_identity_updated_at',
    'audit_event.trg_audit_event_reject_mutation',
    'identity_link.trg_identity_link_updated_at',
  ],
  indexes: ['uq_identity_link_active_firebase', 'uq_identity_link_active_supabase', 'uq_identity_link_active_pair'],
  functions: ['set_platform_identity_updated_at', 'set_updated_at_timestamp', 'audit_metadata_is_flat', 'reject_audit_event_mutation'],
  auditActions: ['bcp.platform.system_owner_provisioning', 'bcp.platform.system_owner_provisioning_compensation'],
  memberships: [{ status: 'active', n: 2 }, { status: 'suspended', n: 1 }],
  policyCount: '0',
  roles: [],
};

const clone = (s: FakeCatalogState): FakeCatalogState => JSON.parse(JSON.stringify(s)) as FakeCatalogState;

// --- managed target boundary -------------------------------------------------

const REF = 'abcdefghijklmnop';
const OKDSN = `postgres://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
// C2B-R3A-C1: the corroborating value is the provider's API/Auth GATEWAY url, which is what an
// operator actually configures. It was previously spelled as the DATABASE host, `db.<ref>.…`, and
// that is a spelling a correctly configured project can never supply.
const OKURL = `https://${REF}.supabase.co`;

test('C2B-R2: the managed boundary accepts only a remote session-mode DEV target', () => {
  const h = assertManagedDevDsn(OKDSN, OKURL, 'postgres');
  assert.deepEqual(describeManagedDsn(h), { endpointFamily: 'session', database: 'postgres' });
});

test('C2B-R2: the managed boundary refuses local targets — those belong to the disposable path', () => {
  for (const raw of [
    `postgres://postgres.${REF}:pw@127.0.0.1:5432/postgres`,
    `postgres://postgres.${REF}:pw@localhost:5432/postgres`,
    `postgres:///postgres?host=/tmp/sock`,
  ]) {
    assert.equal(codeOf(() => assertManagedDevDsn(raw, OKURL, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE);
  }
});

test('C2B-R2: the managed boundary refuses a transaction-pooler endpoint family', () => {
  const pooled = `postgres://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;
  assert.equal(codeOf(() => assertManagedDevDsn(pooled, OKURL, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED);
  const declared = `${OKDSN}?pgbouncer=true`;
  assert.equal(codeOf(() => assertManagedDevDsn(declared, OKURL, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED);
});

test('C2B-R2: the managed boundary refuses a project reference the independent URL disagrees with', () => {
  assert.equal(
    codeOf(() => assertManagedDevDsn(OKDSN, 'https://zzzzzzzzzzzzzzzz.supabase.co', 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
});

test('C2B-R2: the managed boundary refuses an unexpected database name', () => {
  const other = `postgres://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/somethingelse`;
  assert.equal(codeOf(() => assertManagedDevDsn(other, OKURL, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_DATABASE_MISMATCH);
});

test('C2B-R2: the disposable resolver still refuses every managed target (unchanged)', () => {
  assert.equal(codeOf(() => assertDisposableTestDsn(OKDSN)), EXECUTOR_CODES.TEST_DSN_HOST_NOT_LOCAL);
  assert.equal(
    codeOf(() => assertDisposableTestDsn('postgres://u:p@127.0.0.1:5432/postgres')),
    EXECUTOR_CODES.TEST_DSN_DATABASE_NOT_DISPOSABLE,
  );
});

// --- per-version postconditions ---------------------------------------------

const failuresFor = async (v: string, s: FakeCatalogState): Promise<string[]> =>
  (await verifyHistoricalPostconditions(fakeCatalog(s), [v]))[0].failed;

test('C2B-R2 postconditions: 001 passes when present and fails on each missing part', async () => {
  assert.deepEqual(await failuresFor('001', HEALTHY), []);
  const noRls = clone(HEALTHY); noRls.tables!.platform_identity = false;
  assert.ok((await failuresFor('001', noRls)).length > 0, 'RLS disabled must fail');
  const noUq = clone(HEALTHY); delete noUq.constraints!['platform_identity.platform_identity_provider_uid_key'];
  assert.ok((await failuresFor('001', noUq)).length > 0, 'missing unique constraint must fail');
  const noTrg = clone(HEALTHY); noTrg.triggers = [];
  assert.ok((await failuresFor('001', noTrg)).length > 0, 'missing trigger must fail');
});

test('C2B-R2 postconditions: 002 passes when present and fails without its append-only guard', async () => {
  assert.deepEqual(await failuresFor('002', HEALTHY), []);
  const noGuard = clone(HEALTHY);
  noGuard.triggers = noGuard.triggers!.filter((t) => t !== 'audit_event.trg_audit_event_reject_mutation');
  assert.ok((await failuresFor('002', noGuard)).some((f) => f.includes('trg_audit_event_reject_mutation')));
  const noTable = clone(HEALTHY); delete noTable.tables!.audit_event;
  assert.ok((await failuresFor('002', noTable)).length > 0, 'a missing relation must fail');
});

test("C2B-R2 postconditions: 002 does NOT require its own legacy role_scope_chk — 003 replaces it", async () => {
  // The trap this guards: 003 legitimately DROPs and re-ADDs user_membership_role_scope_chk with
  // the canonical vocabulary. If 002's predicate demanded its own legacy form, a CORRECTLY
  // migrated database would fail 002 forever and could never be adopted.
  assert.deepEqual(await failuresFor('002', HEALTHY), [], 'the canonical (003) form must not break 002');
});

test('C2B-R2 postconditions: 004 passes when present and fails without its partial-unique indexes', async () => {
  assert.deepEqual(await failuresFor('004', HEALTHY), []);
  const noIx = clone(HEALTHY); noIx.indexes = ['uq_identity_link_active_firebase'];
  const f = await failuresFor('004', noIx);
  assert.ok(f.some((x) => x.includes('uq_identity_link_active_supabase')));
  const noFk = clone(HEALTHY); delete noFk.constraints!['identity_link.identity_link_firebase_ref_fk'];
  assert.ok((await failuresFor('004', noFk)).length > 0, 'a missing FK must fail');
});

// --- 003: the critical gate --------------------------------------------------

const K003 = 'user_membership.user_membership_role_scope_chk';

test('C2B-R2 003 gate: the exact canonical constraint passes', async () => {
  assert.deepEqual(await failuresFor('003', HEALTHY), []);
});

test('C2B-R2 003 gate: an absent constraint fails', async () => {
  const s = clone(HEALTHY); delete s.constraints![K003];
  assert.ok((await failuresFor('003', s)).some((f) => f.includes('missing')));
});

test('C2B-R2 003 gate: the same conname on a DIFFERENT relation does not satisfy it', async () => {
  // conname is unique per relation, not per database. Matching by name alone would let a
  // same-named constraint on some other table stand in for the real one.
  const s = clone(HEALTHY);
  delete s.constraints![K003];
  s.constraints!['app_user.user_membership_role_scope_chk'] = HEALTHY.constraints![K003];
  assert.ok((await failuresFor('003', s)).length > 0, 'wrong relation must fail');
});

test('C2B-R2 003 gate: a constraint that is not a CHECK fails', async () => {
  const s = clone(HEALTHY); s.constraints![K003] = { ...HEALTHY.constraints![K003], contype: 'u' };
  assert.ok((await failuresFor('003', s)).some((f) => f.includes('not a CHECK')));
});

test('C2B-R2 003 gate: an unvalidated (NOT VALID) constraint fails', async () => {
  const s = clone(HEALTHY); s.constraints![K003] = { ...HEALTHY.constraints![K003], convalidated: false };
  assert.ok((await failuresFor('003', s)).some((f) => f.includes('not validated')));
});

test('C2B-R2 003 gate: EVERY missing canonical role is reported', async () => {
  for (const role of [...CANONICAL_PLATFORM_ROLES, ...CANONICAL_TENANT_ROLES]) {
    const s = clone(HEALTHY);
    s.constraints![K003] = {
      ...HEALTHY.constraints![K003],
      def: HEALTHY.constraints![K003].def.replace(`'${role}'`, "'something_else'"),
    };
    const f = await failuresFor('003', s);
    assert.ok(f.some((x) => x.includes(role)), `a definition missing ${role} must fail`);
  }
});

test('C2B-R2 003 gate: surviving legacy platform_* vocabulary fails', async () => {
  for (const legacy of LEGACY_PLATFORM_ROLES) {
    const s = clone(HEALTHY);
    s.constraints![K003] = { ...HEALTHY.constraints![K003], def: `${HEALTHY.constraints![K003].def} OR role_id = '${legacy}'` };
    const f = await failuresFor('003', s);
    assert.ok(f.some((x) => x.includes(legacy)), `${legacy} present must fail — 003 exists to remove it`);
  }
});

test('C2B-R2 003 gate: the 002-era legacy definition is rejected outright', async () => {
  const s = clone(HEALTHY);
  s.constraints![K003] = {
    contype: 'c', convalidated: true,
    def: "CHECK (scope_type = 'platform' AND role_id = ANY (ARRAY['platform_owner'::text,'platform_admin'::text,'platform_ops'::text,'platform_support'::text,'platform_readonly'::text]))",
  };
  const f = await failuresFor('003', s);
  assert.ok(f.length > 0, 'the pre-003 definition must never be mistaken for the post-003 one');
});

test('C2B-R2: an unregistered version is refused, never silently passed', async () => {
  const r = await verifyHistoricalPostconditions(fakeCatalog(HEALTHY), ['005']);
  assert.equal(r[0].ok, false);
});

// --- pre-005 sentinel --------------------------------------------------------

test('C2B-R2 sentinel: a clean pre-005 database reports no residue', async () => {
  assert.deepEqual(await detectPre005Residue(fakeCatalog(HEALTHY)), []);
});

test('C2B-R2 sentinel: any 005 postcondition present is residue', async () => {
  const withChk = clone(HEALTHY);
  withChk.constraints!['audit_event.audit_event_scope_consistency_chk'] = { contype: 'c', convalidated: true, def: 'CHECK (true)' };
  assert.ok((await detectPre005Residue(fakeCatalog(withChk))).length > 0);
  const withRoles = clone(HEALTHY); withRoles.roles = ['tmpos_app'];
  assert.ok((await detectPre005Residue(fakeCatalog(withRoles))).length > 0);
  const withPolicies = clone(HEALTHY); withPolicies.policyCount = '5';
  assert.ok((await detectPre005Residue(fakeCatalog(withPolicies))).length > 0);
});

// --- fingerprint -------------------------------------------------------------

const FP = { requiredAuditActions: ['bcp.platform.system_owner_provisioning'], activeSystemOwners: 2, suspendedSystemOwners: 1 };

test('C2B-R2 fingerprint: the expected DEV state passes, a different database fails', async () => {
  assert.deepEqual(await verifyManagedDevFingerprint(fakeCatalog(HEALTHY), FP), []);
  const wrong = clone(HEALTHY); wrong.memberships = [{ status: 'active', n: 1 }];
  assert.ok((await verifyManagedDevFingerprint(fakeCatalog(wrong), FP)).length > 0);
  const noAudit = clone(HEALTHY); noAudit.auditActions = [];
  assert.ok((await verifyManagedDevFingerprint(fakeCatalog(noAudit), FP)).length > 0);
});

// --- atomic historical baseline ---------------------------------------------

const PREFIX = { versions: [
  { version: '001', checksum: 'a'.repeat(64) },
  { version: '002', checksum: 'b'.repeat(64) },
  { version: '003', checksum: 'c'.repeat(64) },
  { version: '004', checksum: 'd'.repeat(64) },
] };

function baselineDeps(opts: {
  catalog?: FakeCatalogState;
  ledgerRows?: LedgerRow[];
  writeThrows?: boolean;
  committed?: LedgerRow[];
  /** Cleanup-failure injection: models a rejecting connection release / client.end(). */
  closeThrows?: boolean;
  terminateThrows?: boolean;
  /** The POST-COMMIT read-back fails, after the adoption transaction has already landed. */
  readBackFails?: boolean;
  /** The post-commit read-back returns a non-array, so the comparison itself throws. */
  readBackGarbage?: boolean;
  /**
   * How the adoption transaction behaves at the COMMIT boundary. For every `*_at_commit` mode the
   * SYNTHETIC DATABASE really does commit — the rows land in `store` — while the client never
   * receives the acknowledgement. That is the whole point: the process cannot see what the
   * database did, and must not claim otherwise.
   */
  commitMode?: 'ok' | 'reject_before_commit' | 'reject_at_commit' | 'hang_at_commit' | 'hang_before_commit';
}) {
  const store: LedgerRow[] = (opts.ledgerRows ?? []).slice();
  let commitCount = 0;
  let reads = 0;
  /** SERVER-side truth: did PostgreSQL commit? The runner is never allowed to read this. */
  let serverCommitted = false;
  const session: ExecutorSession = {
    confirmLive: async () => {},
    backendIdentity: async () => ({ token: 'pid:1' }) as BackendIdentity,
    acquireRunLock: async () => true,
    releaseRunLock: async () => true,
    beginTx: async () => {},
    commitTx: async () => {},
    executeSql: async () => {},
    close: async () => { if (opts.closeThrows) throw new Error('release failed'); },
    terminate: async () => { if (opts.terminateThrows) throw new Error('client.end failed'); },
  };
  const deps = {
    adapter: { reserve: async () => session } as ExecutorAdapter,
    ledger: {
      readLedger: async () => {
        reads += 1;
        // Call 1 is the under-lock entry-state read; call 2 is the post-commit read-back.
        if (opts.readBackFails && reads > 1) throw new Error('read failed');
        // A port that resolves with a NON-ARRAY: the read "succeeds", then the comparison throws
        // and lands in the runner's catch-all. The only way to reach it after commit evidence.
        if (opts.readBackGarbage && reads > 1) return undefined as never;
        return store.slice();
      },
      insertDirtyAttempt: async () => {},
      finalizeApplied: async () => {},
    } as ExecutorLedgerPort,
    catalog: fakeCatalog(opts.catalog ?? HEALTHY),
    write: {
      writeAdoptedPrefix: async (
        rows: readonly { version: string; checksum: string; at: string }[],
        observe: BaselineCommitObserver,
      ) => {
        const mode = opts.commitMode ?? 'ok';
        // The ONE transaction. A throw BEFORE commit commits nothing at all — never a partial prefix.
        if (opts.writeThrows || mode === 'reject_before_commit') throw new Error('transaction failed');
        // A deadline that fires while the write is still short of COMMIT. The promise is abandoned,
        // not cancelled, so COMMIT may still be issued after the runner has moved on.
        if (mode === 'hang_before_commit') await new Promise(() => {});

        observe.commitSubmitted();
        // PAST THE POINT OF NO RETURN. Everything below models the SERVER having committed.
        commitCount += 1;
        for (const r of opts.committed ?? rows) store.push({ version: r.version, checksum: r.checksum, dirty: false });
        serverCommitted = true;

        // ...and the client never learns it. A lost response and a lost connection are the same
        // thing from here: the rows are durable, and this process cannot see that.
        if (mode === 'hang_at_commit') await new Promise(() => {});
        if (mode === 'reject_at_commit') throw new Error('connection lost after commit');
        observe.commitAcknowledged();
      },
    },
    connectionMode: 'session' as const,
    deadlineMs: 5000,
    lockKey: 1,
    plan: PREFIX,
    now: () => '2026-01-01T00:00:00.000Z',
  };
  return { deps, store, commits: () => commitCount, serverCommitted: () => serverCommitted };
}

test('C2B-R2 baseline: a verified prefix commits exactly 001-004, clean, and nothing else', async () => {
  const { deps, store } = baselineDeps({});
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'complete', JSON.stringify(r.detail));
  assert.deepEqual(r.adopted, ['001', '002', '003', '004']);
  assert.deepEqual(store.map((x) => x.version), ['001', '002', '003', '004']);
  assert.ok(store.every((x) => x.dirty === false), 'adopted rows are clean');
  assert.ok(!store.some((x) => x.version === '005'), '005 must never be recorded');
});

test('C2B-R2 baseline: a failing postcondition refuses BEFORE the transaction — zero rows written', async () => {
  const broken = clone(HEALTHY); delete broken.constraints![K003];
  const { deps, store, commits } = baselineDeps({ catalog: broken });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_POSTCONDITION_FAILED);
  assert.equal(store.length, 0, 'nothing may be written when any version fails');
  assert.equal(commits(), 0);
});

test('C2B-R2 baseline: pre-005 residue refuses before the transaction', async () => {
  const residue = clone(HEALTHY); residue.roles = ['tmpos_audit_writer'];
  const { deps, store } = baselineDeps({ catalog: residue });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_PRE005_RESIDUE);
  assert.equal(store.length, 0);
});

test('C2B-R2 baseline: a failure DURING the transaction commits no partial prefix', async () => {
  const { deps, store, commits } = baselineDeps({ writeThrows: true });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'failed');
  assert.equal(store.length, 0, 'a mid-transaction failure must leave the ledger untouched');
  assert.equal(commits(), 0);
});

test('C2B-R2 baseline: an already-committed PARTIAL prefix is a STOP state, never auto-repaired', async () => {
  const { deps, store } = baselineDeps({
    ledgerRows: [
      { version: '001', checksum: 'a'.repeat(64), dirty: false },
      { version: '002', checksum: 'b'.repeat(64), dirty: false },
    ],
  });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_PARTIAL_OBSERVED);
  assert.equal(store.length, 2, 'the observed partial state is left exactly as found');
});

test('C2B-R2 baseline: a non-empty unrelated ledger is refused', async () => {
  const { deps } = baselineDeps({ ledgerRows: [{ version: '009', checksum: 'e'.repeat(64), dirty: false }] });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_ENTRY_STATE_REJECTED);
});

test('C2B-R2 baseline: post-commit read-back must show exactly the prefix', async () => {
  // A write that silently persisted only part of the prefix is caught by the read-back even if
  // the transaction reported success.
  const { deps } = baselineDeps({ committed: [{ version: '001', checksum: 'a'.repeat(64), at: 'x' }] as never });
  const r = await runTrustedHistoricalBaseline(deps);
  // NOT 'refused'. The transaction already committed, and 'refused' is this report's word for
  // "nothing happened" — reporting it here would send the operator to re-run, whose entry-state
  // check would then reject a ledger this very run wrote.
  assert.equal(r.outcome, 'failed');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_READBACK_MISMATCH);
  assert.ok(r.detail[0].includes('COMMITTED'), 'the operator must be told the write landed');
});

test('C2B-R2 baseline: the adopted prefix must be MAXIMAL — a shorter one is refused', async () => {
  // The pure planner accepts any in-order prefix, so without this the runner would happily adopt
  // 001-002 on a database where 003 and 004 also ran, recording them as pending and inviting a
  // re-execution of migrations that already applied.
  const { deps, store } = baselineDeps({});
  const shortened = { ...deps, plan: { versions: PREFIX.versions.slice(0, 2) } };
  const r = await runTrustedHistoricalBaseline(shortened);
  assert.equal(r.outcome, 'refused');
  assert.equal(store.length, 0, 'nothing may be written for a non-maximal prefix');
});

test('C2B-R2: the managed boundary refuses a host outside the provider domain', () => {
  // The decisive hole this closes: for the pooler form the project reference comes from the
  // USERNAME, so without a host constraint `postgres.<real-ref>@attacker.example` satisfies
  // every other check and the admin credential is handed to a host nobody named. Verified TLS
  // does not close it — that proves the endpoint holds a trusted certificate, not the right one.
  const evil = `postgres://postgres.${REF}:pw@evil-attacker-host.example.com:5432/postgres`;
  assert.equal(codeOf(() => assertManagedDevDsn(evil, OKURL, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE);
  // A lookalike suffix must not pass either.
  const lookalike = `postgres://postgres.${REF}:pw@supabase.co.evil.example:5432/postgres`;
  assert.equal(codeOf(() => assertManagedDevDsn(lookalike, OKURL, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE);
  // And the project url's reference must come from the exact provider gateway shape, not from an
  // arbitrary hostname's first label.
  assert.equal(
    codeOf(() => assertManagedDevDsn(OKDSN, `https://${REF}.example.com`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
});

test('C2B-R2: DSN query parameters cannot override the executor timeout bounds', () => {
  // postgres.js spreads unrecognised URL query parameters into its `connection` object LAST, so
  // `?statement_timeout=0` would silently disarm the server-side bounds set at construction.
  const armed = `postgres://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?statement_timeout=0&idle_in_transaction_session_timeout=0`;
  const h = assertManagedDevDsn(armed, OKURL, 'postgres');
  assert.deepEqual(describeManagedDsn(h), { endpointFamily: 'session', database: 'postgres' });
});

// --- 005-only apply gate -----------------------------------------------------

test('C2B-R2 apply gate: exactly [005] is authorized and nothing else is', () => {
  assert.doesNotThrow(() => assertExactManagedApplyPlan(['005'], '005'));
  assert.equal(codeOf(() => assertExactManagedApplyPlan(['005', '006'], '005')), EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.equal(codeOf(() => assertExactManagedApplyPlan([], '005')), EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.equal(codeOf(() => assertExactManagedApplyPlan(['004'], '005')), EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.equal(codeOf(() => assertExactManagedApplyPlan(['004', '005'], '005')), EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
});

// --- forward-only direction gate (C2B-R2A) -----------------------------------
//
// VERSION and DIRECTION are separate invariants. The exact-[005] gate above constrains WHICH
// migration may run and says nothing about which way; the authorized C2B mutation is "apply 005
// FORWARD, exactly once". A managed DOWN is not a narrower form of that — it would drop the very
// objects 005 creates — so it is refused rather than gated.

test('C2B-R2A direction: the managed default resolves unambiguously to UP', () => {
  assert.equal(resolveManagedApplyDirection([], false), 'up');
  assert.equal(resolveManagedApplyDirection(['up'], false), 'up');
});

test('C2B-R2A direction: a managed DOWN is refused, by option or by the legacy flag', () => {
  assert.equal(codeOf(() => resolveManagedApplyDirection(['down'], false)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
  assert.equal(codeOf(() => resolveManagedApplyDirection([], true)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
  // --down must not be able to hide behind an explicit --direction=up on the same command line.
  assert.equal(codeOf(() => resolveManagedApplyDirection(['up'], true)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
});

test('C2B-R2A direction: a repeated --direction is ambiguous and is refused, not first-wins', () => {
  // Measured, not assumed: with the shared first-wins getOpt, `--direction=up --direction=down`
  // reached the managed runner and proceeded. The executed migration would have been the
  // authorized forward one — the executor has no reverse path — but a command line that asks for
  // DOWN must not continue, so ambiguity is refused outright.
  assert.equal(codeOf(() => resolveManagedApplyDirection(['up', 'down'], false)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
  assert.equal(codeOf(() => resolveManagedApplyDirection(['down', 'up'], false)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
  assert.equal(codeOf(() => resolveManagedApplyDirection(['up', 'up'], false)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
});

test('C2B-R2A direction: an unknown or malformed value never falls through to UP', () => {
  // The defect class this closes: the old dispatch asked `raw === 'down'` and treated EVERY other
  // token as UP, so a typo silently selected a mutation the operator never requested. "Not down"
  // is not the same claim as "up", and only the second one is safe to act on.
  // '' is the shape a valueless `--direction` produces — it must refuse, not fall back to UP.
  for (const bad of ['sideways', 'UP', 'Up', '', ' up', 'up ', 'downgrade', 'undo', '0', 'true']) {
    assert.equal(
      codeOf(() => resolveManagedApplyDirection([bad], false)),
      EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED,
      `"${bad}" must not resolve to a direction`,
    );
  }
});

test('C2B-R2A direction: the refusal cannot reach a database — it has no port to reach one with', () => {
  // The requirement is that a DOWN refusal precedes connection, fingerprint, advisory lock and
  // every write. That is proved STRUCTURALLY rather than by ordering assertions: the resolver
  // accepts only the two argv scalars — no adapter, ledger, catalog or DSN — so there is no port
  // through which it could touch a database, and it is synchronous, so it cannot await one.
  assert.equal(resolveManagedApplyDirection.length, 2, 'takes exactly the two argv-derived inputs');
  let thrown: unknown;
  try {
    resolveManagedApplyDirection(['down'], false);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof MigrationExecutorError, 'the refusal is synchronous, not a rejected promise');
});

test('C2B-R2A direction: a forward direction still licenses no version by itself', () => {
  // Neither gate may stand in for the other. UP is accepted here, and the version gate is still
  // the only thing that decides 005 — unchanged and independently enforced.
  assert.equal(resolveManagedApplyDirection(['up'], false), 'up');
  assert.doesNotThrow(() => assertExactManagedApplyPlan(['005'], '005'));
  assert.equal(codeOf(() => assertExactManagedApplyPlan(['005', '006'], '005')), EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.equal(codeOf(() => assertExactManagedApplyPlan([], '005')), EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
});

// --- provider-host boundary, re-proved (C2B-R2A) ------------------------------

test('C2B-R2A host boundary: the provider match is a DNS-label boundary, not a substring', () => {
  // A bare endsWith('supabase.co') would ACCEPT the first four of these and hand the admin
  // credential to a domain the attacker registered. Since H2 the match is not a suffix test at
  // all: each host must equal one of two whole endpoint shapes, so these fail on the shape itself.
  // The code differs by WHICH guard speaks first — a `db.` first label CLAIMS the direct endpoint
  // and is refused as a malformed member of that family; everything else is simply not a
  // recognised endpoint.
  const deceptive: ReadonlyArray<readonly [string, string]> = [
    ['evilsupabase.co', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // provider text, attacker domain
    ['my-supabase.co', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['xsupabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['notsupabase.co', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['db.supabase.co.evil.example', EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    ['supabase.co', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // bare apex is not an endpoint
    ['supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    [`db.${REF}.supabase.co.`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED], // trailing dot
  ];
  for (const [host, code] of deceptive) {
    const raw = `postgres://postgres.${REF}:pw@${host}:5432/postgres`;
    assert.equal(codeOf(() => assertManagedDevDsn(raw, OKURL, 'postgres')), code, `${host} must be refused`);
  }
});

test('C2B-R2A host boundary: the parsed authority decides, not text appearing elsewhere in the URL', () => {
  // Userinfo is the classic confusion — a provider-looking string before the "@" is a USERNAME,
  // not a target. The check runs on the parsed host, so the real destination is what is judged.
  const userinfo = `postgres://db.${REF}.supabase.co:pw@evil.example:5432/postgres`;
  assert.equal(codeOf(() => assertManagedDevDsn(userinfo, OKURL, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE);
  // A non-ASCII lookalike label cannot collide with the ASCII suffix: `postgres:` is not a WHATWG
  // "special" scheme, so the host is parsed as opaque and the character is percent-encoded.
  const homograph = `postgres://postgres.${REF}:pw@db.${REF}.ѕupabase.co:5432/postgres`;
  // A `db.` first label makes this a malformed DIRECT-host claim rather than an unknown endpoint.
  assert.equal(
    codeOf(() => assertManagedDevDsn(homograph, OKURL, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED,
  );
});

// --- C2B-R2B: the exact-[005] authorization is BOUND to what executes --------
//
// ROOT DEFECT. runTrustedApply discovers, reads the ledger and calls planApply BEFORE the kernel
// emits `acquire_lock` — the lock is an effect inside the program, and the program is built from
// the plan. So every plan computed outside the lock, including the runner's own and any CLI
// preflight, is an unserialized snapshot that authorizes nothing.

const FIVE = { '005_epsilon_table.up.sql': UP_SQL, '005_epsilon_table.down.sql': DOWN_SQL };
const SIX = { '006_zeta_table.up.sql': UP2_SQL, '006_zeta_table.down.sql': DOWN2_SQL };
const FOUR = { '004_delta_table.up.sql': UP2_SQL, '004_delta_table.down.sql': DOWN2_SQL };

/**
 * A run whose world CHANGES the instant the lock is taken — the race the gate exists to catch.
 *
 * `files`/`rows` are what the runner sees on its own unserialized pass; `*UnderLock` is what the
 * policy re-derives once serialized; `filesAfterAuth` is what a LATER discovery would see, used to
 * prove nothing re-discovers after authorization. Phases switch by counting discovery listings and
 * ledger reads — deterministic, no timers, no real ports.
 */
function bindingRun(opts: {
  files: Record<string, string>;
  rows?: LedgerRow[];
  filesUnderLock?: Record<string, string>;
  rowsUnderLock?: LedgerRow[];
  filesAfterAuth?: Record<string, string>;
  authorizedVersion?: string;
  lockAcquired?: boolean;
  /** Port-level failure injection — `terminate: 'throw'` models `client.end()` rejecting. */
  behaviour?: Record<string, 'hang' | 'throw'>;
  unlockReleased?: boolean;
}): { deps: TrustedApplyDeps; rec: Recorder } {
  let lists = 0;
  const phase = (): Record<string, string> => {
    if (lists <= 1) return opts.files;
    if (lists === 2) return opts.filesUnderLock ?? opts.files;
    return opts.filesAfterAuth ?? opts.filesUnderLock ?? opts.files;
  };
  const fsPort: MigrationFsPort = {
    relDir: 'server/platform-identity/migrations',
    list: () => { lists += 1; return Object.keys(phase()); },
    entryType: () => 'file',
    readBytes: (b: string) => {
      const v = phase()[b];
      if (v === undefined) throw new Error('missing');
      return enc(v);
    },
  };
  const { deps, rec } = fakeDeps(opts.files, opts.rows ?? [], {
    lockAcquired: opts.lockAcquired,
    unlockReleased: opts.unlockReleased,
    behaviour: opts.behaviour,
  });
  const inner = deps.ledger;
  let reads = 0;
  const ledger: ExecutorLedgerPort = {
    ...inner,
    readLedger: async (s) => {
      reads += 1;
      await inner.readLedger(s); // keep the recorder's op trace honest
      return reads === 1 ? (opts.rows ?? []) : (opts.rowsUnderLock ?? opts.rows ?? []);
    },
  };
  return {
    rec,
    deps: {
      ...deps,
      fsPort,
      ledger,
      executionPolicy: createManagedExactPlanPolicy({
        ledger,
        fsPort,
        authorizedVersion: opts.authorizedVersion ?? '005',
      }),
    },
  };
}

/** Every recorded port call that would change durable state. */
const mutations = (rec: Recorder): string[] =>
  rec.ops.filter(
    (o) =>
      o.startsWith('execute:') || o.startsWith('insert_dirty:') || o.startsWith('finalize:') || o === 'begin_tx' || o === 'commit_tx',
  );

test('C2B-R2B: the authoritative plan is derived under the lock, and only then authorizes', async () => {
  const { deps, rec } = bindingRun({ files: FIVE });
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete', `expected success, got ${report.code}`);
  assert.deepEqual(report.applied, ['005']);
  const lock = rec.ops.indexOf('acquire_lock');
  const reads = rec.ops.reduce<number[]>((a, o, i) => (o === 'read_ledger' ? [...a, i] : a), []);
  const firstWrite = rec.ops.findIndex((o) => o.startsWith('insert_dirty:'));
  assert.ok(lock > 0, 'the lock is acquired');
  assert.equal(reads.length, 2, 'the ledger is read twice: once unserialized, once under the lock');
  assert.ok(reads[0] < lock, "the runner's own read precedes the lock — which is why it authorizes nothing");
  assert.ok(reads[1] > lock, 'the AUTHORITATIVE read happens with the lock held');
  assert.ok(firstWrite > 0 && reads[1] < firstWrite, 'authorization precedes the first durable write');
  assert.ok(rec.ops.indexOf('finalize:005') > firstWrite, 'finalization follows the write');
  assert.ok(rec.ops.indexOf('release_lock') > rec.ops.indexOf('finalize:005'), 'the lock is held through verification');
});

test('C2B-R2B: a 006 appearing after the preflight refuses under the lock, before any mutation', async () => {
  const { deps, rec } = bindingRun({ files: FIVE, filesUnderLock: { ...FIVE, ...SIX } });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.deepEqual(report.applied, []);
  assert.deepEqual(mutations(rec), [], 'no SQL, no dirty row, no clean row — for 005 or 006');
});

test('C2B-R2B: a ledger that gained 005 under the lock voids the stale approval', async () => {
  const { deps, rec } = bindingRun({
    files: FIVE,
    rowsUnderLock: [{ version: '005', checksum: sha256Hex(enc(UP_SQL)), dirty: false }],
  });
  const report = await runTrustedApply(deps);
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, 'authoritative pending set is empty');
  assert.deepEqual(mutations(rec), []);
});

test('C2B-R2B: an unexpected dirty history is a STOP, never an automatic repair', async () => {
  const { deps, rec } = bindingRun({
    files: FIVE,
    rowsUnderLock: [{ version: '005', checksum: sha256Hex(enc(UP_SQL)), dirty: true }],
  });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  assert.ok(report.code !== null, 'the history refusal carries its own code');
  assert.notEqual(report.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, 'refused by history validation, not the version check');
  assert.deepEqual(mutations(rec), [], 'nothing was repaired into an executable state');
});

test('C2B-R2B: an authoritative [004,005] or [006] refuses — exactness is enforced post-lock', async () => {
  const both = bindingRun({ files: { ...FOUR, ...FIVE } });
  const r1 = await runTrustedApply(both.deps);
  assert.equal(r1.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, '[004,005] is not the authorized set');
  assert.deepEqual(mutations(both.rec), []);

  const later = bindingRun({ files: SIX });
  const r2 = await runTrustedApply(later.deps);
  assert.equal(r2.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, '[006] is not the authorized set');
  assert.deepEqual(mutations(later.rec), []);
});

test('C2B-R2B: exactness alone is not binding — the program must carry the authorized plan', async () => {
  // The authoritative set IS exactly [005], so the version gate passes; but the frozen program was
  // built from a pre-lock discovery that saw only 004. Without the binding step this run would
  // have executed a migration nobody authorized while reporting an approved plan.
  const { deps, rec } = bindingRun({ files: FOUR, filesUnderLock: FIVE });
  const report = await runTrustedApply(deps);
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PLAN_DRIFT);
  assert.deepEqual(mutations(rec), []);
});

test('C2B-R2B: same version, different CONTENT is drift — bytes are bound, not just labels', async () => {
  // A version label is a name, and two SQL bodies can wear the same name. If 005 is edited between
  // the program being frozen and the authoritative re-read, both sides still read ['005'] — so a
  // version-only comparison would approve the run while the STALE bytes execute.
  const FIVE_EDITED = { '005_epsilon_table.up.sql': UP2_SQL, '005_epsilon_table.down.sql': DOWN2_SQL };
  const { deps, rec } = bindingRun({ files: FIVE, filesUnderLock: FIVE_EDITED });
  const report = await runTrustedApply(deps);
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PLAN_DRIFT, 'the authorized checksum must equal the executed checksum');
  assert.deepEqual(mutations(rec), []);
});

test('C2B-R2B: nothing re-discovers after authorization — a later 006 cannot join the run', async () => {
  const { deps, rec } = bindingRun({ files: FIVE, filesUnderLock: FIVE, filesAfterAuth: { ...FIVE, ...SIX } });
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete', `expected success, got ${report.code}`);
  assert.deepEqual(report.applied, ['005'], 'only the authorized version executes');
  assert.equal(rec.ops.filter((o) => o.startsWith('execute:')).length, 1, 'exactly one migration runs');
  assert.ok(!JSON.stringify(rec.ops).includes('006'), 'the later discovery never reaches a port');
});

test('C2B-R2B: a supplied policy is always consulted, after the lock and before the first write', async () => {
  const { deps, rec } = bindingRun({ files: FIVE });
  const authoritative = deps.executionPolicy as NonNullable<TrustedApplyDeps['executionPolicy']>;
  let calledAt = -1;
  const report = await runTrustedApply({
    ...deps,
    executionPolicy: async (a) => { calledAt = rec.ops.length; return authoritative(a); },
  });
  assert.equal(report.outcome, 'complete', `expected success, got ${report.code}`);
  const firstWrite = rec.ops.findIndex((o) => o.startsWith('insert_dirty:'));
  assert.ok(calledAt > rec.ops.indexOf('acquire_lock'), 'consulted after the lock');
  assert.ok(calledAt <= firstWrite, 'consulted before the first durable write');
});

test('C2B-R2B: a run that never holds the lock is never authorized and never mutates', async () => {
  const { deps, rec } = bindingRun({ files: FIVE, lockAcquired: false });
  let called = 0;
  const report = await runTrustedApply({ ...deps, executionPolicy: async () => { called += 1; return null; } });
  assert.notEqual(report.outcome, 'complete');
  assert.equal(called, 0, 'no lock, no authorization — the gate cannot be reached unserialized');
  assert.deepEqual(mutations(rec), []);
});

test('C2B-R2B: a policy that throws or hangs is a refusal, never an authorization', async () => {
  // Only an explicit null authorizes. A gate that fails must not be mistaken for a gate that passed.
  const thrown = bindingRun({ files: FIVE });
  const r1 = await runTrustedApply({ ...thrown.deps, executionPolicy: async () => { throw new Error('boom'); } });
  assert.notEqual(r1.outcome, 'complete');
  assert.deepEqual(mutations(thrown.rec), [], 'a throwing gate is fail-closed');

  const hung = bindingRun({ files: FIVE });
  const r2 = await runTrustedApply({ ...hung.deps, executionPolicy: () => new Promise(() => {}) });
  assert.notEqual(r2.outcome, 'complete');
  assert.deepEqual(mutations(hung.rec), [], 'a hanging gate is bounded and fail-closed');
});

test('C2B-R2B: a refused run destroys the session, so the advisory lock cannot survive it', async () => {
  // The run lock is session-scoped. Pooling a refused session would return a connection that still
  // holds the lock, deadlocking the next operator run against a mutation that never happened.
  const { deps, rec } = bindingRun({ files: FIVE, filesUnderLock: { ...FIVE, ...SIX } });
  const report = await runTrustedApply(deps);
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.ok(rec.disposed.includes('terminated'), 'the session is destroyed, never pooled');
  assert.ok(!rec.disposed.includes('closed'), 'a refused run does not return the session to the pool');
  assert.deepEqual(mutations(rec), []);
});

test('C2B-R2B: with NO policy the generic/disposable runner is byte-for-byte unchanged', async () => {
  const { deps, rec } = fakeDeps(ONE, []);
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete');
  assert.deepEqual(report.applied, ['001']);
  assert.equal(rec.ops.filter((o) => o === 'read_ledger').length, 1, 'exactly one ledger read — the policy adds no port call');
});

// --- C2B-R2C: termination REQUESTED is not termination PROVEN ----------------
//
// The managed session's terminate() routed through a quiet wrapper that swallowed a rejecting
// client.end(). Because bounded(() => session.terminate()) then always succeeded, the runner's
// terminateQuietly took its `disposal: 'terminated'` branch unconditionally — claiming a closure,
// and by implication a session-scoped advisory-lock release, on no evidence. The session contract
// is the seam: a rejecting client.end() is observable exactly as a rejecting terminate().

test('C2B-R2C: a session close that SUCCEEDS is still reported as terminated', async () => {
  const { deps, rec } = bindingRun({ files: FIVE, filesUnderLock: { ...FIVE, ...SIX } });
  const report = await runTrustedApply(deps);
  assert.equal(report.disposal, 'terminated', 'a real destroy is reported honestly');
  assert.ok(rec.disposed.includes('terminated'));
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, 'no invented cleanup error replaces the reason');
});

test('C2B-R2C: a session close that FAILS is never reported as a completed termination', async () => {
  const { deps, rec } = bindingRun({
    files: FIVE,
    filesUnderLock: { ...FIVE, ...SIX },
    behaviour: { terminate: 'throw' },
  });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.disposal, 'terminated', 'closure was attempted, not established');
  assert.equal(report.disposal, 'none');
  assert.ok(!rec.disposed.includes('terminated'), 'nothing recorded a completed destroy');
});

test('C2B-R2C: a cleanup failure does not erase the primary refusal', async () => {
  // BOTH facts must survive: why the run was rejected, AND that cleanup did not establish closure.
  // Collapsing either one is how "rejected before mutation" becomes "cleaned up and safe to retry".
  const { deps, rec } = bindingRun({
    files: FIVE,
    filesUnderLock: { ...FIVE, ...SIX },
    behaviour: { terminate: 'throw' },
  });
  const report = await runTrustedApply(deps);
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, 'the primary reason is preserved');
  assert.equal(report.disposal, 'none', 'and the cleanup failure stays visible');
  assert.notEqual(report.outcome, 'complete');
  assert.deepEqual(report.applied, []);
  assert.deepEqual(mutations(rec), [], 'no SQL, no dirty row, no clean row');
  assert.ok(!JSON.stringify(rec.ops).includes('006'), 'and no 006 anywhere');
});

test('C2B-R2C: a policy throw or timeout plus a failed close stays fail-closed', async () => {
  const thrown = bindingRun({ files: FIVE, behaviour: { terminate: 'throw' } });
  const r1 = await runTrustedApply({ ...thrown.deps, executionPolicy: async () => { throw new Error('boom'); } });
  assert.notEqual(r1.outcome, 'complete');
  assert.notEqual(r1.disposal, 'terminated');
  assert.deepEqual(mutations(thrown.rec), []);

  const hung = bindingRun({ files: FIVE, behaviour: { terminate: 'throw' } });
  const r2 = await runTrustedApply({ ...hung.deps, executionPolicy: () => new Promise(() => {}) });
  assert.notEqual(r2.outcome, 'complete');
  assert.notEqual(r2.disposal, 'terminated');
  assert.deepEqual(mutations(hung.rec), []);
});

test('C2B-R2C: the normal release path distinguishes a failed unlock from a clean run', async () => {
  const ok = bindingRun({ files: FIVE });
  const good = await runTrustedApply(ok.deps);
  assert.equal(good.outcome, 'complete');
  assert.equal(good.disposal, 'closed', 'a clean run CLOSES; it does not terminate');

  const bad = bindingRun({ files: FIVE, unlockReleased: false });
  const r = await runTrustedApply(bad.deps);
  assert.notEqual(r.outcome, 'complete', 'a failed unlock is not a successful run');
  assert.equal(r.code, ENGINE_CODES.RUN_UNLOCK_FAILED);
});

test('C2B-R2C: unlock succeeding but the close failing is not a wholly successful cleanup', async () => {
  // Execution state and cleanup state must not collapse into one flag. The migration DID run here,
  // so the result has to keep saying so — otherwise an operator could read a cleanup failure as
  // "nothing happened" and re-apply 005.
  const { deps, rec } = bindingRun({ files: FIVE, behaviour: { close: 'throw' } });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete', 'a failed close is not a complete run');
  assert.notEqual(report.disposal, 'closed', 'and it is not reported as cleanly closed');
  assert.ok(rec.ops.includes('release_lock'), 'the unlock itself did happen');
  assert.ok(rec.ops.some((o) => o.startsWith('execute:')), 'the migration ran before cleanup failed');
  assert.deepEqual(report.applied, ['005'], 'the mutation stays visible — no retry is implied safe');
});

test('C2B-R2C: the generic/disposable runner reports a failed close just as honestly', async () => {
  // Same runner contract, no policy: a swallowed close would have been a false 'terminated' here
  // too. This is the behavioural half of the disposable correction.
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { terminate: 'throw', close: 'throw' } });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  assert.notEqual(report.disposal, 'terminated');
  assert.equal(report.disposal, 'none');
  assert.ok(!rec.disposed.includes('terminated'));
});

test('C2B-R2C: a COMMITTED baseline whose cleanup fails records both facts, not one', async () => {
  // The sibling runners already recorded a failed destroy in `code`; this one recorded only
  // `disposal`, so a committed adoption whose cleanup failed read as complete with a null code —
  // i.e. entirely clean. Both halves must now survive, and neither may overwrite the other.
  const { deps, store } = baselineDeps({ closeThrows: true, terminateThrows: true });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'complete', 'the adoption really committed — do not invent a failure');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004'], 'and which versions stays visible');
  assert.deepEqual(store.map((x) => x.version), ['001', '002', '003', '004'], 'the write really landed');
  assert.equal(r.disposal, 'none', 'but closure was NOT established');
  // R2D refined the code: the CLOSE failed first and is what forced the destroy, so it is the
  // primary fact; `??` in destroy() then correctly declines to overwrite it with DISPOSAL_FAILED.
  // The R2C property under test — that the cleanup failure is recorded rather than silent — holds
  // either way, and this now matches the sibling runTrustedLedgerRead exactly.
  assert.equal(r.code, ENGINE_CODES.PORT_OPERATION_FAILED, 'and the cleanup failure is recorded, not silent');
});

test('C2B-R2C: a baseline cleanup failure never overwrites the primary refusal', async () => {
  const broken = clone(HEALTHY); delete broken.constraints![K003];
  const { deps, store } = baselineDeps({ catalog: broken, terminateThrows: true });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_POSTCONDITION_FAILED, 'the primary reason wins');
  assert.equal(r.disposal, 'none', 'and the cleanup failure is still visible');
  assert.equal(store.length, 0, 'nothing was written');
});

test('C2B-R2B: plan binding did not weaken the R2A direction gate', () => {
  assert.equal(resolveManagedApplyDirection([], false), 'up');
  assert.equal(codeOf(() => resolveManagedApplyDirection(['down'], false)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
  assert.equal(codeOf(() => resolveManagedApplyDirection(['up', 'down'], false)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
  assert.equal(codeOf(() => resolveManagedApplyDirection([], true)), EXECUTOR_CODES.MANAGED_DIRECTION_REJECTED);
});

test('C2B-R2A host boundary: a genuine provider endpoint is still accepted, case-insensitively', () => {
  // The explicit lowercasing is load-bearing, not cosmetic: because `postgres:` is not a special
  // scheme, the URL parser does NOT normalise host case, so without it an uppercase spelling of
  // the SAME authorized endpoint would be refused.
  const upper = `postgres://postgres.${REF}:pw@AWS-0-EU-WEST-1.POOLER.SUPABASE.COM:5432/postgres`;
  assert.deepEqual(describeManagedDsn(assertManagedDevDsn(upper, OKURL, 'postgres')), {
    endpointFamily: 'session',
    database: 'postgres',
  });
});

// ---------------------------------------------------------------------------
// C2B-R2D — session-level advisory-lock OWNERSHIP DEPTH
//
// PostgreSQL session advisory locks belong to the SESSION and are RECURSIVE: N successful
// pg_try_advisory_lock calls need N pg_advisory_unlock calls, and only session end drops the
// remainder. Every claim below is therefore made against a rig that MODELS that arithmetic, so
// "the lock was released" is a counted fact rather than a reading of the code. No database, DSN,
// CA, credential or pg_locks query is involved.
// ---------------------------------------------------------------------------

const R2D_KEY = 424242;
const R2D_FILES: Record<string, string> = {
  '001_alpha.up.sql': 'create table r2d_alpha();\n', '001_alpha.down.sql': 'drop table r2d_alpha;\n',
  '002_beta.up.sql': 'create table r2d_beta();\n', '002_beta.down.sql': 'drop table r2d_beta;\n',
  '003_gamma.up.sql': 'create table r2d_gamma();\n', '003_gamma.down.sql': 'drop table r2d_gamma;\n',
  '004_delta.up.sql': 'create table r2d_delta();\n', '004_delta.down.sql': 'drop table r2d_delta;\n',
  '005_epsilon.up.sql': 'create table r2d_epsilon();\n', '005_epsilon.down.sql': 'drop table r2d_epsilon;\n',
};
/** A later migration that must never ride along on a plan authorized for 005. */
const R2D_SIX: Record<string, string> = {
  '006_zeta.up.sql': 'create table r2d_zeta();\n', '006_zeta.down.sql': 'drop table r2d_zeta;\n',
};
const R2D_UP: Record<string, string> = {
  '001': '001_alpha.up.sql', '002': '002_beta.up.sql', '003': '003_gamma.up.sql',
  '004': '004_delta.up.sql', '005': '005_epsilon.up.sql',
};
/** The discovery checksum of a fixture's UP file, so an adopted ledger row and a later plan agree. */
const r2dChecksum = (version: string): string => sha256Hex(enc(R2D_FILES[R2D_UP[version]]));
const R2D_ADOPTED: LedgerRow[] = ['001', '002', '003', '004'].map((v) => ({
  version: v, checksum: r2dChecksum(v), dirty: false,
}));

function lockDepthRig(opts: {
  ledgerRows?: LedgerRow[];
  catalog?: FakeCatalogState;
  /** Extra discoverable migrations, e.g. a later 006. */
  extraFiles?: Record<string, string>;
  /** pg_advisory_unlock reports "this session did not hold it". */
  unlockReleased?: boolean;
  /** client.end() rejects — a termination REQUESTED but never established (the R2C case). */
  terminateThrows?: boolean;
  closeThrows?: boolean;
}) {
  let depth = 0;
  const events: string[] = [];
  /** The modeled lock depth at every moment the connection became reusable. */
  const pooledAtDepth: number[] = [];
  const store: LedgerRow[] = (opts.ledgerRows ?? []).slice();
  const files = { ...R2D_FILES, ...(opts.extraFiles ?? {}) };

  const session: ExecutorSession = {
    confirmLive: async () => {},
    backendIdentity: async () => ({ token: 'pid:r2d' }) as BackendIdentity,
    acquireRunLock: async (key: number) => {
      assert.equal(key, R2D_KEY, 'one key for the whole run');
      events.push('acquire');
      depth += 1; // STACKS, exactly like pg_try_advisory_lock on one session.
      return true;
    },
    releaseRunLock: async (key: number) => {
      assert.equal(key, R2D_KEY, 'the lock released is the lock acquired');
      events.push('release');
      if (opts.unlockReleased === false) return false;
      if (depth === 0) return false; // pg_advisory_unlock on a lock this session never took.
      depth -= 1;
      return true;
    },
    beginTx: async () => {},
    commitTx: async () => {},
    executeSql: async () => { events.push('execute'); },
    close: async () => {
      // RELEASE to the pool, not session end — so any depth still owned here survives, and is
      // exactly what an unrelated reuse would inherit.
      if (opts.closeThrows) throw new Error('release failed');
      events.push('close');
      pooledAtDepth.push(depth);
    },
    terminate: async () => {
      events.push('terminate');
      // A REJECTING client.end() leaves the backend possibly alive, so the depth must NOT drop:
      // termination requested is not termination proven, and neither is lock release.
      if (opts.terminateThrows) throw new Error('client.end failed');
      depth = 0; // session end drops the whole stack
    },
  };

  // Idempotent like the real managed adapter: `max: 1` + `idle_timeout: 0` means every phase of a
  // run is pinned to the SAME physical backend, which is the property session locks depend on.
  const adapter: ExecutorAdapter = { reserve: async () => session, cancelReserve: async () => {} };
  const ledger: ExecutorLedgerPort = {
    readLedger: async () => store.slice(),
    insertDirtyAttempt: async (_s, row) => {
      events.push(`insert_dirty:${row.version}`);
      store.push({ version: row.version, checksum: row.checksum, dirty: true });
    },
    finalizeApplied: async (_s, row) => {
      const i = store.findIndex((r) => r.version === row.version);
      if (i < 0) throw new Error('finalize matched no row');
      store[i] = { version: row.version, checksum: row.checksum, dirty: false };
    },
  };

  const baseline = {
    adapter,
    ledger,
    catalog: fakeCatalog(opts.catalog ?? HEALTHY),
    write: {
      writeAdoptedPrefix: async (rows: readonly { version: string; checksum: string; at: string }[]) => {
        for (const r of rows) store.push({ version: r.version, checksum: r.checksum, dirty: false });
      },
    },
    connectionMode: 'session' as const,
    deadlineMs: 5000,
    lockKey: R2D_KEY,
    plan: { versions: ['001', '002', '003', '004'].map((v) => ({ version: v, checksum: r2dChecksum(v) })) },
    now: () => '2026-01-01T00:00:00.000Z',
  };
  const apply: TrustedApplyDeps = {
    fsPort: fakeFs(files),
    adapter,
    ledger,
    connectionMode: 'session',
    credential: { purpose: 'migration', migratorRef: 'mig-ref', runtimeRef: 'run-ref' },
    lockKey: R2D_KEY,
    now: () => '2026-07-29T00:00:00.000Z',
    deadlineMs: 5000,
  };
  const count = (e: string): number => events.filter((x) => x === e).length;
  return { session, adapter, ledger, baseline, apply, store, events, pooledAtDepth, count, depth: () => depth };
}

test('C2B-R2D rig: the depth model really is recursive, so the regressions below CAN fail', async () => {
  // Load-bearing self-check. Every claim in this section is "the modeled depth is zero"; if the
  // model collapsed stacked acquisitions, those claims would hold vacuously and prove nothing.
  const rig = lockDepthRig({});
  await rig.session.acquireRunLock(R2D_KEY);
  await rig.session.acquireRunLock(R2D_KEY);
  assert.equal(await rig.session.releaseRunLock(R2D_KEY), true);
  assert.equal(rig.depth(), 1, 'ONE unlock cannot clear TWO acquisitions');
  await rig.session.close();
  assert.deepEqual(rig.pooledAtDepth, [1], 'pooling a still-holding session is observable');
  assert.equal(await rig.session.releaseRunLock(R2D_KEY), true);
  assert.equal(rig.depth(), 0);
  assert.equal(await rig.session.releaseRunLock(R2D_KEY), false, 'unlocking what we do not hold reports false');
  await rig.session.terminate();
  assert.equal(rig.depth(), 0, 'session end drops the whole stack');
});

test('C2B-R2D baseline: exactly one acquisition, one VERIFIED unlock, pooled only at depth zero', async () => {
  const rig = lockDepthRig({});
  const r = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(r.outcome, 'complete', JSON.stringify(r.detail));
  assert.equal(r.code, null);
  assert.equal(r.disposal, 'closed');
  assert.equal(rig.count('acquire'), 1, 'the baseline takes the run lock exactly once');
  assert.equal(rig.count('release'), 1, 'and gives back exactly what it took');
  assert.equal(rig.depth(), 0, 'no owned acquisition may survive the run');
  assert.deepEqual(rig.pooledAtDepth, [0], 'the session becomes reusable only with the lock released');
  assert.ok(
    rig.events.indexOf('release') < rig.events.indexOf('close'),
    'the unlock must precede the pooling, not follow it',
  );
});

test('C2B-R2D handoff: a composed baseline -> apply cannot stack a second acquisition', async () => {
  // THE regression for the suspected defect. Both runners are exported and a caller may compose
  // them over ONE handle. Before R2D the baseline returned still holding its acquisition, so this
  // sequence ran acquire -> acquire -> unlock and pooled the connection at depth 1 while reporting
  // `complete` / `closed` — a clean report over a session that still held the run lock.
  const rig = lockDepthRig({});
  const b = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(b.outcome, 'complete', JSON.stringify(b.detail));
  assert.equal(rig.depth(), 0, 'the baseline must not hand a still-held lock to the next phase');

  const a = await runTrustedApply(rig.apply);
  assert.equal(a.outcome, 'complete', a.code ?? '');
  assert.deepEqual(a.applied, ['005']);
  assert.equal(rig.count('acquire'), 2, 'one acquisition per runner');
  assert.equal(rig.count('release'), 2, 'and one corresponding unlock per runner');
  assert.equal(rig.depth(), 0, 'residual modeled lock depth after the full recovery sequence');
  assert.ok(
    rig.pooledAtDepth.every((d) => d === 0),
    `no lock-holding session may become reusable (pooled at depths ${rig.pooledAtDepth.join(',')})`,
  );
});

test('C2B-R2D baseline: an UNVERIFIED unlock destroys the session instead of pooling it', async () => {
  const rig = lockDepthRig({ unlockReleased: false });
  const r = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(r.outcome, 'complete', 'the adoption transaction really did commit');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004'], 'mutation evidence survives the cleanup failure');
  assert.equal(r.code, ENGINE_CODES.RUN_UNLOCK_FAILED, 'and the cleanup failure is recorded, not silent');
  assert.equal(r.disposal, 'terminated', 'destroying the session is what establishes the release');
  assert.equal(rig.depth(), 0, 'session end dropped the stack the unlock could not');
  assert.deepEqual(rig.pooledAtDepth, [], 'a session with unbalanced ownership is NEVER pooled');
  assert.ok(r.detail.some((d) => d.includes('COMMITTED')), 'the operator must be told not to re-run');
});

test('C2B-R2D baseline: unlock failure + failed destroy leaves release UNKNOWN, primary code intact', async () => {
  const rig = lockDepthRig({ unlockReleased: false, terminateThrows: true });
  const r = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(r.outcome, 'complete');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004']);
  assert.equal(r.code, ENGINE_CODES.RUN_UNLOCK_FAILED, 'the disposal code must not overwrite the primary one');
  assert.equal(r.disposal, 'none', 'a failed destroy is never reported as terminated');
  // The report claims NEITHER released NOR still held — it claims nothing, which is the contract.
  assert.equal(rig.depth(), 1, 'the model still shows ownership; the code asserts only that it is unproven');
  assert.deepEqual(rig.pooledAtDepth, [], 'and nothing was handed back as reusable');
});

test('C2B-R2D refusal: an unauthorized [005,006] plan mutates nothing and leaves zero lock depth', async () => {
  const rig = lockDepthRig({ extraFiles: R2D_SIX });
  const b = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(b.outcome, 'complete', JSON.stringify(b.detail));
  const before = rig.store.map((r) => r.version).join(',');

  const a = await runTrustedApply({
    ...rig.apply,
    executionPolicy: createManagedExactPlanPolicy({
      ledger: rig.ledger, fsPort: rig.apply.fsPort, authorizedVersion: '005',
    }),
  });
  assert.notEqual(a.outcome, 'complete');
  assert.equal(a.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.deepEqual(a.applied, []);
  assert.equal(rig.count('execute'), 0, 'zero migration SQL');
  assert.equal(rig.store.map((r) => r.version).join(','), before, 'zero ledger mutation');
  assert.equal(a.disposal, 'terminated');
  assert.equal(rig.depth(), 0, 'the refusal path releases by destroying the session');
  assert.ok(rig.pooledAtDepth.every((d) => d === 0));
});

test('C2B-R2D refusal + failed destroy: release stays UNKNOWN and nothing is retried', async () => {
  const rig = lockDepthRig({ extraFiles: R2D_SIX, terminateThrows: true });
  const b = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(b.outcome, 'complete', JSON.stringify(b.detail));

  const a = await runTrustedApply({
    ...rig.apply,
    executionPolicy: createManagedExactPlanPolicy({
      ledger: rig.ledger, fsPort: rig.apply.fsPort, authorizedVersion: '005',
    }),
  });
  assert.equal(a.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED, 'the primary refusal survives the cleanup failure');
  assert.equal(a.disposal, 'none', 'closure NOT established');
  assert.deepEqual(a.applied, []);
  assert.equal(rig.count('execute'), 0);
  assert.equal(rig.count('acquire'), 2, 'the apply took its own lock; the baseline had already given back its own');
  assert.deepEqual(rig.pooledAtDepth, [0], 'only the baseline pooled, and only at depth zero');
});

test('C2B-R2D apply: an unlock failure AFTER 005 applied is not clean, not retried, not pooled', async () => {
  const rig = lockDepthRig({ ledgerRows: R2D_ADOPTED, unlockReleased: false });
  const a = await runTrustedApply(rig.apply);
  assert.notEqual(a.outcome, 'complete', 'an unbalanced run is not a clean run');
  assert.equal(a.code, ENGINE_CODES.RUN_UNLOCK_FAILED);
  assert.ok(
    rig.store.some((r) => r.version === '005' && r.dirty === false),
    'the migration really ran — that evidence survives the cleanup failure',
  );
  assert.equal(rig.count('execute'), 1, 'no automatic re-application of an already-performed mutation');
  assert.equal(rig.count('insert_dirty:005'), 1);
  assert.equal(a.disposal, 'terminated', 'destroying the session is the only remaining release');
  assert.equal(rig.depth(), 0);
  assert.deepEqual(rig.pooledAtDepth, [], 'a session whose unlock failed is never handed back');
});

test('C2B-R2D baseline: a CLOSE failure is recorded even when the compensating destroy succeeds', async () => {
  // Previously this returned complete / code:null / disposal:'terminated' — byte-identical in every
  // gated field to a clean run, so the CLI's code-keyed refusal exited 0 on the one path that had
  // just written durable history. The sibling runTrustedLedgerRead always recorded it.
  const rig = lockDepthRig({ closeThrows: true });
  const r = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(r.outcome, 'complete', 'the adoption committed');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004']);
  assert.equal(r.code, ENGINE_CODES.PORT_OPERATION_FAILED, 'a failed connection release is never silent');
  assert.equal(r.disposal, 'terminated');
  assert.equal(rig.count('release'), 1, 'the unlock ran first and succeeded');
  assert.equal(rig.depth(), 0, 'so the run lock was genuinely released before the close failed');
  assert.ok(r.detail.some((d) => d.includes('WAS verifiably released')), 'and the report says so');
});

test('C2B-R2D baseline: the cleanup detail is written from the ACTUAL destroy result', async () => {
  // The detail used to assert "the session was destroyed" before destroy() had run, and never
  // revised it — so on the highest-stakes path it flatly contradicted disposal:'none'.
  const proven = lockDepthRig({ unlockReleased: false });
  const a = await runTrustedHistoricalBaseline(proven.baseline);
  assert.equal(a.disposal, 'terminated');
  assert.ok(a.detail.some((d) => d.includes('was destroyed rather than pooled')));
  assert.ok(!a.detail.some((d) => d.includes('UNKNOWN')), 'a proven destroy is not UNKNOWN');

  const unproven = lockDepthRig({ unlockReleased: false, terminateThrows: true });
  const b = await runTrustedHistoricalBaseline(unproven.baseline);
  assert.equal(b.disposal, 'none');
  assert.ok(b.detail.some((d) => d.includes('UNKNOWN')), 'an unproven destroy must say UNKNOWN');
  assert.ok(
    !b.detail.some((d) => d.includes('was destroyed rather than pooled')),
    'and must never claim a destruction it did not achieve',
  );
});

test('C2B-R2D baseline: a post-commit read-back FAILURE still preserves the adoption evidence', async () => {
  // This branch used refuse(), whose own word for the outcome is "nothing happened" — erasing
  // `adopted` and the do-not-re-run warning for a transaction that had already committed. The
  // mismatch branch immediately below it already carried exactly this reasoning.
  const { deps, store } = baselineDeps({ readBackFails: true });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.notEqual(r.outcome, 'refused', 'a committed adoption is never "nothing happened"');
  assert.equal(r.outcome, 'failed');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004'], 'which versions landed stays visible');
  assert.deepEqual(store.map((x) => x.version), ['001', '002', '003', '004'], 'and the write really landed');
  assert.ok(r.detail.some((d) => d.includes('COMMITTED')), 'the operator must be told not to re-run');
});

// ---------------------------------------------------------------------------
// C2B-R2E — COMMIT RESOLUTION
//
// A client-side failure is evidence about THIS PROCESS, never about the database. Once COMMIT is
// on the wire, a rejection, a dropped socket and a deadline all leave PostgreSQL equally free to
// have committed. The rig below models exactly that split: `serverCommitted()` is the database's
// truth, which the runner is never allowed to see.
// ---------------------------------------------------------------------------

test('C2B-R2E: an acknowledged COMMIT is reported as committed, with the adoption evidence', async () => {
  const { deps, store, serverCommitted } = baselineDeps({});
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'complete', JSON.stringify(r.detail));
  assert.equal(r.commit, 'committed');
  assert.equal(serverCommitted(), true, 'the synthetic database really did commit');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004']);
  assert.deepEqual(store.map((x) => x.version), ['001', '002', '003', '004']);
  assert.equal(r.code, null);
});

test('C2B-R2E: a failure BEFORE COMMIT is submitted is positively NOT COMMITTED', async () => {
  // The only branch entitled to that claim: nothing was ever put on the wire, and the port
  // rolled back. Over-correcting this into UNKNOWN would be its own falsehood.
  const { deps, store, commits, serverCommitted } = baselineDeps({ commitMode: 'reject_before_commit' });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.commit, 'not_committed');
  assert.equal(serverCommitted(), false, 'the synthetic database really did NOT commit');
  assert.equal(commits(), 0);
  assert.equal(store.length, 0, 'a pre-commit failure leaves the ledger untouched');
  assert.deepEqual(r.adopted, []);
  assert.ok(r.detail.some((d) => d.includes('never submitted')), 'and says WHY it can claim that');
});

test('C2B-R2E: COMMIT sent, response LOST — never "did not commit"', async () => {
  // THE 38(g) defect, exactly. The database committed; the client got a connection error instead
  // of an acknowledgement. The old code reported `adoption transaction did not commit`.
  const { deps, store, serverCommitted } = baselineDeps({ commitMode: 'reject_at_commit' });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(serverCommitted(), true, 'PostgreSQL committed — the process simply cannot see it');
  assert.equal(store.length, 4, 'and the rows are durably there');

  assert.equal(r.commit, 'unknown', 'so the ONLY truthful resolution is UNKNOWN');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_COMMIT_UNKNOWN);
  assert.notEqual(r.outcome, 'complete', 'UNKNOWN must fail closed');
  assert.deepEqual(r.adopted, [], 'adoption is not established either — neither claim may be made');
  const joined = r.detail.join(' | ');
  assert.ok(!/did not commit/i.test(joined), `no "did not commit" claim may survive: ${joined}`);
  assert.ok(!/roll(ed)? ?back/i.test(joined), 'and no rollback may be claimed');
  assert.ok(/NOT ESTABLISHED/.test(joined));
  assert.ok(/do NOT re-run baseline/.test(joined) && /migration 005/.test(joined), 'and it must say so');
});

test('C2B-R2E: COMMIT sent, deadline fires before any answer — UNKNOWN, not failure-to-commit', async () => {
  const { deps, store, serverCommitted } = baselineDeps({ commitMode: 'hang_at_commit' });
  const r = await runTrustedHistoricalBaseline({ ...deps, deadlineMs: 40 });
  assert.equal(serverCommitted(), true);
  assert.equal(store.length, 4);
  assert.equal(r.commit, 'unknown');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_COMMIT_UNKNOWN);
  assert.ok(!/did not commit/i.test(r.detail.join(' | ')));
});

test('C2B-R2E: a deadline BEFORE COMMIT is still UNKNOWN — the write was abandoned, not cancelled', async () => {
  // `bounded` stops waiting; it does not stop the work. The write is still live past the timeout
  // and may yet issue COMMIT, so "COMMIT was never submitted" is not established here either.
  const { deps } = baselineDeps({ commitMode: 'hang_before_commit' });
  const r = await runTrustedHistoricalBaseline({ ...deps, deadlineMs: 40 });
  assert.equal(r.commit, 'unknown', 'a timeout can never prove non-commit');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_COMMIT_UNKNOWN);
  assert.ok(!/did not commit/i.test(r.detail.join(' | ')));
});

test('C2B-R2E: the UNKNOWN detail is derived, never asserted — two ways in, two different facts', async () => {
  // Replacing "did not commit" with a blanket "COMMIT WAS SUBMITTED" would be the same defect
  // mirrored: on a deadline that fired first, submission is exactly what is NOT established.
  const sent = await runTrustedHistoricalBaseline(baselineDeps({ commitMode: 'reject_at_commit' }).deps);
  assert.equal(sent.commit, 'unknown');
  assert.ok(sent.detail.some((d) => d.includes('COMMIT WAS SUBMITTED')), 'submission established');

  const raced = await runTrustedHistoricalBaseline({
    ...baselineDeps({ commitMode: 'hang_before_commit' }).deps, deadlineMs: 40,
  });
  assert.equal(raced.commit, 'unknown');
  assert.ok(
    !raced.detail.some((d) => d.includes('COMMIT WAS SUBMITTED')),
    'submission NOT established — the report must not claim it',
  );
  assert.ok(raced.detail.some((d) => d.includes('ABANDONED, NOT CANCELLED')), 'and must say what IS known');
  assert.ok(raced.detail.some((d) => d.includes('do NOT re-run baseline')), 'both stay fail-closed');
});

test('C2B-R2E: an acknowledged COMMIT never falls through to the never-submitted claim', async () => {
  // `commit` can be 'committed' while the write promise rejected — a port that does anything after
  // acknowledging. The definite claim is guarded on the verdict, not reached by falling through.
  const { deps } = baselineDeps({});
  const acked = {
    ...deps,
    write: {
      writeAdoptedPrefix: async (
        rows: readonly { version: string; checksum: string; at: string }[],
        observe: BaselineCommitObserver,
      ) => {
        await deps.write.writeAdoptedPrefix(rows, observe);
        observe.commitAcknowledged();
        throw new Error('port epilogue failed after the commit was acknowledged');
      },
    },
  };
  const r = await runTrustedHistoricalBaseline(acked);
  assert.equal(r.commit, 'committed');
  assert.ok(
    !r.detail.some((d) => /never submitted|did not commit/i.test(d)),
    `an acknowledged commit must never be described as non-commit: ${r.detail.join(' | ')}`,
  );
  assert.ok(r.detail.some((d) => d.includes('COMMITTED')), 'it must say the transaction committed');
});

test('C2B-R2E: UNKNOWN + termination SUCCESS does not rewrite the transaction as rolled back', async () => {
  const { deps } = baselineDeps({ commitMode: 'reject_at_commit' });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.disposal, 'terminated', 'session cleanup succeeded');
  assert.equal(r.commit, 'unknown', 'which says NOTHING about the transaction');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_COMMIT_UNKNOWN, 'and does not become a cleanup story');
});

test('C2B-R2E: UNKNOWN + termination FAILURE keeps BOTH uncertainties', async () => {
  const { deps } = baselineDeps({ commitMode: 'reject_at_commit', terminateThrows: true });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.commit, 'unknown', 'transaction resolution: unknown');
  assert.equal(r.disposal, 'none', 'session/lock cleanup: not established');
  assert.equal(r.code, EXECUTOR_CODES.BASELINE_COMMIT_UNKNOWN, 'the primary fact is not overwritten');
});

test('C2B-R2E: an acknowledged commit stays COMMITTED when the read-back later fails', async () => {
  const { deps, store } = baselineDeps({ readBackFails: true });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.commit, 'committed', 'a later failure cannot demote established commit evidence');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004']);
  assert.deepEqual(store.map((x) => x.version), ['001', '002', '003', '004']);
  assert.ok(r.detail.some((d) => d.includes('COMMITTED')));
  assert.ok(!r.detail.some((d) => /did not commit/i.test(d)));
});

test('C2B-R2E: an acknowledged commit stays COMMITTED when the unlock later fails', async () => {
  const rig = lockDepthRig({ unlockReleased: false });
  const r = await runTrustedHistoricalBaseline(rig.baseline);
  assert.equal(r.commit, 'committed');
  assert.deepEqual(r.adopted, ['001', '002', '003', '004'], 'mutation evidence preserved');
  assert.equal(r.code, ENGINE_CODES.RUN_UNLOCK_FAILED, 'cleanup failure is reported separately');
  assert.deepEqual(rig.pooledAtDepth, [], 'and no clean pool return');
});

test('C2B-R2E: the catch-all cannot overwrite established commit evidence', async () => {
  // R2D 38(h): the catch-all assigns `outcome`/`code` unconditionally. It writes NEITHER `commit`
  // NOR `adopted`, so putting commit resolution in its own field puts it structurally out of
  // reach — which is why 38(h) needed no change to make R2E safe.
  const { deps, store } = baselineDeps({ readBackGarbage: true });
  const r = await runTrustedHistoricalBaseline(deps);
  assert.equal(r.outcome, 'failed', 'the catch-all did fire');
  assert.equal(r.code, ENGINE_CODES.PORT_OPERATION_FAILED, 'and did set its own code');
  assert.equal(r.commit, 'committed', 'but the commit dimension survived it untouched');
  assert.deepEqual(store.map((x) => x.version), ['001', '002', '003', '004']);
});

test('C2B-R2E: every pre-write refusal truthfully reports not_committed', async () => {
  const broken = clone(HEALTHY); delete broken.constraints![K003];
  const post = await runTrustedHistoricalBaseline(baselineDeps({ catalog: broken }).deps);
  assert.equal(post.commit, 'not_committed', 'no transaction was ever begun');
  const residue = clone(HEALTHY); residue.roles = ['tmpos_audit_writer'];
  const sentinel = await runTrustedHistoricalBaseline(baselineDeps({ catalog: residue }).deps);
  assert.equal(sentinel.commit, 'not_committed');
  const entry = await runTrustedHistoricalBaseline(
    baselineDeps({ ledgerRows: [{ version: '009', checksum: 'e'.repeat(64), dirty: false }] }).deps,
  );
  assert.equal(entry.commit, 'not_committed');
});

test('C2B-R2D apply: a CLOSE failure after a verified unlock still leaves zero depth', async () => {
  const rig = lockDepthRig({ ledgerRows: R2D_ADOPTED, closeThrows: true });
  const a = await runTrustedApply(rig.apply);
  assert.ok(
    rig.store.some((r) => r.version === '005' && r.dirty === false),
    'the applied migration is still reported',
  );
  assert.equal(rig.count('release'), 1, 'the named unlock ran and consumed the only acquisition');
  assert.equal(rig.depth(), 0, 'so the lock was released BEFORE the connection cleanup failed');
  assert.notEqual(a.disposal, 'closed', 'but the cleanup failure stays visible');
  assert.deepEqual(rig.pooledAtDepth, [], 'and no session was pooled');
  assert.equal(rig.count('execute'), 1, 'no automatic rerun of 005');
});

// ---------------------------------------------------------------------------
// C2B-R3A-C1 — the project-url CORROBORATION parser
//
// `SUPABASE_URL` is the provider's API/Auth GATEWAY url, `https://<ref>.supabase.co`; the database
// answers on a different hostname entirely. The corroboration parser used to demand the DATABASE
// host spelling, so a project configured exactly as the provider documents could never corroborate
// and the managed target was refused before a client existed.
//
// What is proved below is bounded on purpose: that two SEPARATELY CONFIGURED values name the same
// project reference. That is identity corroboration between operator inputs — NOT provider
// provenance and NOT a cryptographic proof. The live fingerprint, the verified TLS chain and the
// certificate/hostname check remain the only evidence about which database actually answers.
//
// Every value here is synthetic. Nothing constructs a client, resolves a name or opens a socket.
// ---------------------------------------------------------------------------

/** A second synthetic project, for the mismatch cases. Never a real reference. */
const OTHER_REF = 'zzzzzzzzzzzzzzzz';
const ok = (projectUrl: string) => describeManagedDsn(assertManagedDevDsn(OKDSN, projectUrl, 'postgres'));
const SESSION_TARGET = { endpointFamily: 'session', database: 'postgres' } as const;

test('C1-A: the documented API gateway url corroborates a DSN naming the same reference', () => {
  assert.deepEqual(ok(`https://${REF}.supabase.co`), SESSION_TARGET);
  // A bare root slash is the same url — the provider's own copy/paste form carries one.
  assert.deepEqual(ok(`https://${REF}.supabase.co/`), SESSION_TARGET);
  // `https:` is a WHATWG special scheme, so the SAME project spelled in capitals normalises to the
  // same host and the same reference.
  assert.deepEqual(ok(`https://${REF.toUpperCase()}.SUPABASE.CO`), SESSION_TARGET);
});

test('C1-B: a well-formed gateway url naming a DIFFERENT reference is refused', () => {
  assert.notEqual(OTHER_REF, REF);
  assert.equal(
    codeOf(() => assertManagedDevDsn(OKDSN, `https://${OTHER_REF}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
    'the comparison is exact equality — a valid shape is not corroboration',
  );
});

test('C1-C: an arbitrary hostname first label is never treated as a project reference', () => {
  // The rejected rule is `hostname.split('.')[0]`. Were it ever reintroduced, EVERY one of these
  // would corroborate: each carries the real reference as its first label.
  for (const host of [
    `${REF}.example.com`,
    `${REF}.supabase.io`,
    `${REF}.evilsupabase.co`,
    `${REF}.my-supabase.co`,
    `${REF}.notsupabase.co`,
    `${REF}.supabase.co.evil.example`,
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(OKDSN, `https://${host}`, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
      `${host} must not corroborate`,
    );
  }
});

test('C1-D: the provider suffix and label boundaries are exact in BOTH directions', () => {
  for (const host of [
    `${REF}.attacker.supabase.co`, // an extra label AFTER the reference
    `attacker.${REF}.supabase.co`, // an extra label BEFORE the reference
    `db.${REF}.supabase.co`, // the DATABASE host spelling is not the gateway url
    `${REF}.supabase.com`, // the pooler domain is not the gateway domain
    `${REF}.supabase.co.`, // trailing-dot FQDN: fail closed rather than guess
    `${REF}.supabase`, // truncated suffix
    'supabase.co', // the bare apex carries no reference
    // A non-ASCII lookalike cannot collide: IDNA turns it into punycode before the comparison.
    `${REF}.ѕupabase.co`,
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(OKDSN, `https://${host}`, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
      `${host} must not corroborate`,
    );
  }
});

test('C1-E: scheme, credentials, port, path, query and fragment are all contained', () => {
  for (const raw of [
    `http://${REF}.supabase.co`, // scheme downgrade
    `ftp://${REF}.supabase.co`,
    `https://user:pw@${REF}.supabase.co`, // embedded credentials
    `https://user@${REF}.supabase.co`,
    `https://${REF}.supabase.co:8443`, // unexpected port
    `https://${REF}.supabase.co/rest/v1`, // a non-root application path
    `https://${REF}.supabase.co/?ref=${REF}`, // query
    `https://${REF}.supabase.co/#${REF}`, // fragment
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(OKDSN, raw, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
      `${raw} must not corroborate`,
    );
  }
  // A value that is not a url at all, or is blank, fails earlier still — on the input contract.
  assert.equal(codeOf(() => assertManagedDevDsn(OKDSN, 'not a url', 'postgres')), EXECUTOR_CODES.MANAGED_DSN_INVALID);
  assert.equal(codeOf(() => assertManagedDevDsn(OKDSN, '   ', 'postgres')), EXECUTOR_CODES.MANAGED_DSN_INVALID);
});

test('C1-F: a gateway label outside the canonical grammar never corroborates', () => {
  for (const label of [
    'abcdefghijklmno', // fifteen characters: one short of the accepted minimum
    'abcdefghijklmno-p', // a hyphen is outside the grammar
    'abcdefghijklmno_p', // an underscore is outside the grammar
    '', // an empty label
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(OKDSN, `https://${label}.supabase.co`, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
      `${label === '' ? '<empty>' : label} must not corroborate`,
    );
  }
  // HONEST SCOPE: these four are refused by the grammar guard AND by plain inequality, because a
  // grammar-invalid label can never equal a DSN reference the SAME grammar produced. The guard is
  // therefore defence in depth, not the load-bearing check — it is what stops a future loosening
  // of one side from silently pairing with the other. This test does not claim to isolate it.
  //
  // What IS isolated here: the grammar itself is untouched by C1. Sixteen characters remains the
  // accepted boundary and a longer reference still corroborates — only the ARTIFACT the grammar is
  // applied to changed.
  const long = `${REF}qrstuvwx`;
  const longDsn = `postgres://postgres.${long}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
  assert.deepEqual(
    describeManagedDsn(assertManagedDevDsn(longDsn, `https://${long}.supabase.co`, 'postgres')),
    SESSION_TARGET,
  );
});

test('C1-H: a DSN naming two different projects is refused, never resolved by precedence', () => {
  // The DSN carries a reference in two places. `postgres.<A>@db.<B>.supabase.co` passes every
  // other check — provider host, session port, database name — and a bare username-wins rule would
  // corroborate it against project A's gateway url while the driver dials project B. Identity that
  // cannot be established EXACTLY must fail closed.
  const a = 'aaaaaaaaaaaaaaaa';
  const b = 'bbbbbbbbbbbbbbbb';
  const split = `postgres://postgres.${a}:pw@db.${b}.supabase.co:5432/postgres`;
  assert.equal(
    codeOf(() => assertManagedDevDsn(split, `https://${a}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
    'the username reference must not override a disagreeing host reference',
  );
  // Naming project B's gateway does not rescue it either — the DSN is self-inconsistent.
  assert.equal(
    codeOf(() => assertManagedDevDsn(split, `https://${b}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
  // When the two halves AGREE the direct-host form still corroborates normally.
  const agreed = `postgres://postgres.${a}:pw@db.${a}.supabase.co:5432/postgres`;
  assert.deepEqual(describeManagedDsn(assertManagedDevDsn(agreed, `https://${a}.supabase.co`, 'postgres')), SESSION_TARGET);
  // And a pooler host carries no competing reference, so the username alone still speaks.
  assert.deepEqual(ok(`https://${REF}.supabase.co`), SESSION_TARGET);
});

test('C1-G: corroboration is pure — no client, driver, socket or name resolution', () => {
  // assertManagedDevDsn mints a HANDLE, never a connection: the client is built later, by
  // createManagedDevExecutor, from a handle only this function can produce. So a refusal cannot
  // have opened anything — nothing is opened on the SUCCESS path either. Synchronous throughout,
  // so nothing else can interleave between the two samples.
  const before = process.getActiveResourcesInfo();
  for (const projectUrl of [
    `https://${REF}.supabase.co`,
    `https://${OTHER_REF}.supabase.co`,
    `https://${REF}.example.com`,
    `http://${REF}.supabase.co`,
    'not a url',
  ]) {
    try {
      assertManagedDevDsn(OKDSN, projectUrl, 'postgres');
    } catch {
      /* the refusals are the point; this test is about their side effects */
    }
  }
  assert.deepEqual(
    process.getActiveResourcesInfo(),
    before,
    'target validation must not create a handle, socket, timer or lookup',
  );
});

// ---------------------------------------------------------------------------
// C2B-R3A-C1H1 — the DIRECT database host must be matched WHOLE
//
// C1 gave the database host its own parser but left that parser PREFIX-ONLY: `^db\.(<ref>)\.`
// established only that a hostname STARTS like the documented direct endpoint. The two endpoint
// families the provider documents are
//
//   direct   postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
//   pooler   postgres://postgres.<ref>:<pw>@<region-host>.pooler.supabase.com:5432/postgres
//
// and they carry project identity in DIFFERENT places — the host label for the direct form, the
// username for the pooler form. A prefix-only direct-host rule blurs that line: it hands
// direct-host identity to hostnames that are not the direct endpoint at all.
//
// Every value here is synthetic. Nothing constructs a client, resolves a name or opens a socket.
// ---------------------------------------------------------------------------

/** The DOCUMENTED direct form. Its username is plain `postgres` — deliberately NOT `<role>.<ref>`,
 *  so the ONLY reference signal in these DSNs is the host. That is what makes the cases below
 *  decisive about the host parser rather than about the username parser. */
const directDsn = (host: string) => `postgres://postgres:pw@${host}:5432/postgres`;
/** The SAME hosts carrying a POOLER-form username, which DOES supply a reference. Both spellings
 *  must be exercised: with only the bare form, `userRef` is always null and every case would refuse
 *  on "no reference at all" — passing for a reason that has nothing to do with the host rule. */
const userDsn = (host: string, ref: string) => `postgres://postgres.${ref}:pw@${host}:5432/postgres`;

test('H1-A: the exact documented direct database host corroborates and describes as a session target', () => {
  // PRESERVATION, not regression evidence: this test passes identically under the prefix-only
  // rule. What it does isolate is the `i` flag — dropping it turns the uppercase spelling red.
  assert.deepEqual(
    describeManagedDsn(assertManagedDevDsn(directDsn(`db.${REF}.supabase.co`), `https://${REF}.supabase.co`, 'postgres')),
    SESSION_TARGET,
  );
  // DNS is case-insensitive and `postgres:` is not a WHATWG special scheme, so the host arrives
  // unnormalised: the parser must fold case itself rather than refuse a legitimate spelling.
  assert.deepEqual(
    describeManagedDsn(
      assertManagedDevDsn(directDsn(`DB.${REF.toUpperCase()}.SUPABASE.CO`), `https://${REF}.supabase.co`, 'postgres'),
    ),
    SESSION_TARGET,
  );
  // A direct host naming a DIFFERENT project still fails the corroboration it must fail.
  assert.equal(
    codeOf(() => assertManagedDevDsn(directDsn(`db.${OTHER_REF}.supabase.co`), `https://${REF}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
});

test('H1-B: a hostname that merely BEGINS like the direct endpoint yields no reference', () => {
  // Each case names the guard that must refuse it, because a bare "it threw" assertion accepts a
  // refusal from ANY guard and so cannot tell the host rule from the ones around it. Both username
  // spellings are exercised: the bare `postgres` form leaves `userRef` null, so a refusal there
  // could merely mean "no reference anywhere"; the pooler form SUPPLIES a matching reference, so
  // only a host-side rule can refuse it.
  //
  // HONEST SCOPE — exactly which of these H1 changed:
  //  * The four ENDPOINT_FAMILY_REJECTED hosts are THE REGRESSION. Under the prefix-only rule each
  //    extracted `REF` and — with a matching gateway url, the session port and the expected
  //    database name — was ACCEPTED, handing the privileged credential to an endpoint the operator
  //    never named. These four are what H1 fixes.
  //  * The NOT_REMOTE hosts were already refused before H1, by the provider-suffix allowlist that
  //    runs earlier. They are boundary coverage, not regression evidence.
  for (const [host, code] of [
    [`db.${REF}.extra.supabase.co`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED], // one extra label
    [`db.${REF}.attacker.supabase.co`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    [`db.${REF}.a.b.c.supabase.co`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED], // arbitrarily many
    [`db.${REF}.pooler.supabase.com`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED], // pooler domain
    [`db.${REF}.supabase.co.attacker.example`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    [`db.${REF}.supabase.co.`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED], // trailing dot
    [`db.${REF}supabase.co`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED], // no boundary
    [`db.${REF}.supabasexco`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED], // suffix confusion
  ]) {
    for (const raw of [directDsn(host), userDsn(host, REF)]) {
      assert.equal(codeOf(() => assertManagedDevDsn(raw, `https://${REF}.supabase.co`, 'postgres')), code, host);
    }
  }
  // A host that does NOT begin `db.` makes no direct-endpoint claim. Under H1 these reached the
  // reference comparison and were refused only because this helper's username carries no
  // reference — with a POOLER username they were ACCEPTED, bounded by nothing but a provider
  // suffix. H2 closes that: they are no longer a recognised endpoint at all, for either username.
  for (const host of [`attacker.db.${REF}.supabase.co`, `dbx.${REF}.supabase.co`, `anything.supabase.co`]) {
    for (const raw of [directDsn(host), userDsn(host, REF)]) {
      assert.equal(
        codeOf(() => assertManagedDevDsn(raw, `https://${REF}.supabase.co`, 'postgres')),
        EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE,
        `${host} is not a documented endpoint`,
      );
    }
  }
  // ISOLATION, for the PAIR below only: the accepted and the refused value differ in ONE token — a
  // single extra label — with the same reference, username, port, database and gateway url. Both
  // satisfy the provider suffix and the session port, so the whole-host match is the only thing
  // that can flip the verdict.
  assert.deepEqual(
    describeManagedDsn(assertManagedDevDsn(directDsn(`db.${REF}.supabase.co`), `https://${REF}.supabase.co`, 'postgres')),
    SESSION_TARGET,
  );
  assert.equal(
    codeOf(() => assertManagedDevDsn(directDsn(`db.${REF}.extra.supabase.co`), `https://${REF}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED,
    'a `db.` first label CLAIMS the direct endpoint; a claim that is not the exact host fails closed',
  );
});

test('H1-B2: a malformed direct-host CLAIM fails closed instead of degrading to username identity', () => {
  // THE REGRESSION THE ANCHOR ITSELF INTRODUCED, and the reason `DB_HOST_CLAIM` exists.
  //
  // Making DB_HOST_REF exact turns more hostnames into `hostRef === null` — the SAME state a
  // legitimate pooler host occupies. Without a claim guard the two-halves agreement check simply
  // stops firing and `userRef ?? hostRef` falls through to the username. So this DSN, which the
  // PREFIX-ONLY rule refused (it read `<B>` from the host and saw it disagree with `<A>`), would
  // have started being ACCEPTED as `<A>` while the driver dialled a `<B>`-shaped host: a tightening
  // that silently widened. Being malformed must not buy silence.
  const a = 'aaaaaaaaaaaaaaaa';
  const b = 'bbbbbbbbbbbbbbbb';
  for (const host of [`db.${b}.extra.supabase.co`, `db.${b}.attacker.supabase.co`, `db.${b}.supabase.com`]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(userDsn(host, a), `https://${a}.supabase.co`, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED,
      `${host} must not degrade to username-only identity`,
    );
  }
  // The guard is scoped to the direct-host CLAIM: a pooler hostname never begins with `db.`, so it
  // is untouched and still resolves by username.
  assert.deepEqual(ok(`https://${REF}.supabase.co`), SESSION_TARGET);
  // And on the EXACT direct host the disagreement check — not the claim guard — is what fires.
  assert.equal(
    codeOf(() => assertManagedDevDsn(userDsn(`db.${b}.supabase.co`, a), `https://${a}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
});

test('H1-C: db.<ref>.supabase.com is NOT a direct host merely because poolers live on supabase.com', () => {
  // `.supabase.com` is inside the provider-suffix allowlist because the SHARED POOLER lives there,
  // and under the prefix-only rule that was enough for `db.<ref>.supabase.com` to be read as a
  // direct host. It is not one: whatever resolves there belongs to the POOLER family, and a
  // pooler's project identity is carried by the `postgres.<ref>` username, never by a
  // `db.`-prefixed host label. No configuration in this repository names such a target either.
  // Accepting it would be a WIDER rule than either source asks for, so it fails closed — and it
  // must do so for BOTH username spellings, not only the one that supplies no reference.
  for (const raw of [directDsn(`db.${REF}.supabase.com`), userDsn(`db.${REF}.supabase.com`, REF)]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(raw, `https://${REF}.supabase.co`, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED,
    );
  }
  // The gateway parser already refused the same confusion from its own side; both stay refused.
  assert.equal(
    codeOf(() => assertManagedDevDsn(directDsn(`db.${REF}.supabase.co`), `https://${REF}.supabase.com`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
});

test('H1-D: the shared session pooler is unchanged — its identity still comes from the username', () => {
  // The pooler hostname carries no project reference and must never be given one: tightening the
  // DIRECT host rule must not make the pooler form unusable, which is the failure mode a shared
  // parser would have produced.
  assert.deepEqual(ok(`https://${REF}.supabase.co`), SESSION_TARGET);
  assert.deepEqual(
    describeManagedDsn(
      assertManagedDevDsn(`postgres://postgres.${REF}:pw@aws-1-us-east-2.pooler.supabase.com:5432/postgres`, `https://${REF}.supabase.co`, 'postgres'),
    ),
    SESSION_TARGET,
    'any provider pooler region host is still accepted — the region is not part of the identity',
  );
  // The pooler path keeps every bound it already had: session port, gateway agreement, and the
  // provider-host boundary that stops a valid username from dialling an arbitrary host.
  assert.equal(
    codeOf(() => assertManagedDevDsn(`postgres://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`, `https://${REF}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED,
  );
  assert.equal(
    codeOf(() => assertManagedDevDsn(OKDSN, `https://${OTHER_REF}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
  assert.equal(
    codeOf(() => assertManagedDevDsn(`postgres://postgres.${REF}:pw@attacker.example:5432/postgres`, `https://${REF}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE,
  );
});

test('H1-E: a direct-host label outside the canonical grammar never becomes a reference', () => {
  for (const label of [
    'abcdefghijklmno', // fifteen characters: one short of the accepted minimum
    'abcdefghijklmno-p', // a hyphen is outside the grammar
    'abcdefghijklmno_p', // an underscore is outside the grammar
    '', // an empty label, i.e. `db..supabase.co`
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(directDsn(`db.${label}.supabase.co`), `https://${REF}.supabase.co`, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED,
      `db.${label === '' ? '<empty>' : label}.supabase.co must not corroborate`,
    );
  }
  // HONEST SCOPE: H1 did not touch the reference grammar — these four labels were refused before
  // it too. What changed is WHICH guard refuses them and therefore the code they report: a `db.`
  // first label is now a direct-endpoint CLAIM, so a grammar-invalid claim fails closed on the
  // claim rather than falling through to 'no reference anywhere'.
  // The grammar itself is untouched by H1: a longer reference still corroborates on the direct host.
  const long = `${REF}qrstuvwx`;
  assert.deepEqual(
    describeManagedDsn(assertManagedDevDsn(directDsn(`db.${long}.supabase.co`), `https://${long}.supabase.co`, 'postgres')),
    SESSION_TARGET,
  );
});

test('H1-F: the newly refused direct hosts ARE refused, and refusing constructs nothing', () => {
  // The refusal assertions are the load-bearing half. An earlier draft only sampled active
  // resources around a bare `try/catch`, which passes against a validator that accepts EVERYTHING —
  // no refusals occur, every call succeeds, and nothing notices. So each host now names the code
  // that must be thrown, and the resource sample is the secondary check.
  //
  // What the sample can and cannot see: `getActiveResourcesInfo()` reports active libuv resource
  // TYPES, so it detects a timer or an open socket but not a leaked descriptor or a synchronous
  // read. The real guarantee is structural — `assertManagedDevDsn` has no I/O call site at all,
  // which the containment suite asserts directly — and this is the runtime corroboration of it.
  const before = process.getActiveResourcesInfo();
  for (const [host, code] of [
    [`db.${REF}.extra.supabase.co`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    [`db.${REF}.attacker.supabase.co`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    [`db.${REF}.supabase.com`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    ['db..supabase.co', EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    [`db.${REF}.supabase.co.`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    [`attacker.db.${REF}.supabase.co`, EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
  ]) {
    assert.equal(codeOf(() => assertManagedDevDsn(directDsn(host), `https://${REF}.supabase.co`, 'postgres')), code, host);
  }
  // The SUCCESS path opens nothing either — the client is built later, by createManagedDevExecutor,
  // from a handle only this function can mint.
  assert.deepEqual(
    describeManagedDsn(assertManagedDevDsn(directDsn(`db.${REF}.supabase.co`), `https://${REF}.supabase.co`, 'postgres')),
    SESSION_TARGET,
  );
  assert.deepEqual(
    process.getActiveResourcesInfo(),
    before,
    'direct-host validation must not create a handle, socket, timer or lookup',
  );
});


// ---------------------------------------------------------------------------
// C2B-R3A-C1H2 — one sealed effective connection authority
//
// H1 made the validator's own reading of a hostname exact. It could not make the DRIVER agree,
// and postgres.js reads the same connection string by different rules: it slices the authority
// out of the raw text, `decodeURIComponent`s it, treats a comma as a MULTIHOST list that
// OUTRANKS `url.hostname`, and promotes a `/` to a UNIX socket path. So the string the validator
// approved and the address the driver dialled were two different questions with two answers.
//
// H2 removes the second parser from the decision: routing components are extracted once, sealed
// into the validated handle, and handed to the driver as explicit options with no connection
// string at all.
//
// Everything below is synthetic. No DNS, socket, TLS or database contact occurs — the driver
// factory is exercised for its OPTION RESOLUTION only, which postgres.js performs eagerly while
// leaving `socket = null` until a query is issued.
// ---------------------------------------------------------------------------

const POOLER_OK = `postgres://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
const DIRECT_OK = `postgres://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
const GATEWAY = `https://${REF}.supabase.co`;
const anyHost = (host: string) => `postgres://postgres.${REF}:pw@${host}:5432/postgres`;

test('H2-A: parser-differential authorities are refused — multihost, encoded port, socket path', () => {
  // HONEST SCOPE: not every entry below is regression evidence. The ones whose TAIL is a provider
  // domain are — they passed the old provider-SUFFIX test while postgres.js resolved a different
  // destination out of the same bytes. The rest (a tail that is not a provider domain, or a
  // literal colon that never parses as a URL) were already refused before H2 and are boundary
  // coverage. The per-case codes below say which guard speaks for each.
  //
  // THE DEFECT, for the provider-tailed ones:
  //   attacker.example,db.<ref>.supabase.co   -> dials attacker.example:5432
  //   attacker.example%3A9999,x.supabase.com  -> dials attacker.example:9999
  //   %2Ftmp%2Fevil,x.supabase.co             -> leaves the network for a UNIX socket
  // A whole-host grammar cannot express a comma, a percent sign, a colon or a slash, so the class
  // is refused structurally rather than enumerated.
  for (const [host, code] of [
    [`attacker.example,db.${REF}.supabase.co`, EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // multihost
    // A `db.` FIRST LABEL claims the direct endpoint, so this one is refused a step earlier still.
    [`db.${REF}.supabase.co,attacker.example`, EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED],
    ['attacker.example,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['x.pooler.supabase.com,attacker.example', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['attacker.example%3A9999,x.supabase.co', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // encoded port
    ['attacker.example%3A9999,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['%2Ftmp%2Fevil,x.supabase.co', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // encoded UNIX socket path
    ['%2Ftmp%2Fevil,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['%2Ctmp,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // encoded comma
    ['%2Fvar%2Frun,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    ['%5Cattacker,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // encoded backslash
    ['attacker.example%09,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE], // encoded control/whitespace
    ['attacker.example%20,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE],
    // A LITERAL colon is a forbidden host code point, so the URL never parses at all.
    ['attacker.example:9999,x.pooler.supabase.com', EXECUTOR_CODES.MANAGED_DSN_INVALID],
  ] as ReadonlyArray<readonly [string, string]>) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(anyHost(host), GATEWAY, 'postgres')),
      code,
      `${host} must be refused before any client is constructed`,
    );
  }
  // A second `@`: the two parsers split the authority differently — WHATWG uses the LAST `@`,
  // postgres.js `indexOf('@')` uses the FIRST. HONEST SCOPE: measured against the installed
  // driver, that difference does NOT move the destination, because without a comma `multihost` is
  // false and the driver falls back to its own `url.hostname`. So the correct assertion is not
  // "both are refused" but "whatever is accepted routes where the validator approved".
  const trailingAt = `postgres://postgres.${REF}:pw@attacker.example@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
  assert.equal(
    describeManagedDriverRouting(assertManagedDevDsn(trailingAt, GATEWAY, 'postgres')).host,
    'aws-0-eu-west-1.pooler.supabase.com',
    'the extra `@` lands in the password, not in the destination',
  );
  const leadingAt = `postgres://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com@attacker.example:5432/postgres`;
  assert.equal(
    codeOf(() => assertManagedDevDsn(leadingAt, GATEWAY, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE,
    'a provider-looking string before the real host is userinfo, and the real host is judged',
  );
  // Query parameters cannot nominate a destination either: `?host=` is refused outright, and every
  // other parameter is dropped because no connection string reaches the driver at all.
  assert.equal(
    codeOf(() => assertManagedDevDsn(`${POOLER_OK}?host=/tmp/evil`, GATEWAY, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE,
  );
});

test('H2-B: the shared pooler host is one canonical DNS label, not a loose character class', () => {
  for (const host of [
    'anything.supabase.co', // the old suffix test accepted this with a pooler username
    'evil.supabase.com',
    'x.y.pooler.supabase.com', // more than one label before the pooler domain
    'pooler.supabase.com', // no label at all
    '.pooler.supabase.com',
    '-x.pooler.supabase.com', // a DNS label may not begin with a hyphen
    'x-.pooler.supabase.com', // ...nor end with one
    'x_y.pooler.supabase.com', // underscores are outside the label grammar
    `${'a'.repeat(64)}.pooler.supabase.com`, // 64 characters: one over the DNS maximum
    'aws-0-eu-west-1.pooler.supabase.co', // the pooler lives on .com, not .co
    'aws-0-eu-west-1.pooler.supabase.com.', // trailing-dot FQDN
    'aws-0-eu-west-1.pooler.supabase.com.attacker.example',
    'attacker.example',
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(anyHost(host), GATEWAY, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_NOT_REMOTE,
      `${host} is not the documented pooler endpoint`,
    );
  }
  // The boundary itself: 63 characters is the longest legal label and must still be accepted.
  const maxLabel = `${'a'.repeat(62)}0`;
  assert.equal(maxLabel.length, 63);
  assert.deepEqual(
    describeManagedDsn(assertManagedDevDsn(anyHost(`${maxLabel}.pooler.supabase.com`), GATEWAY, 'postgres')),
    SESSION_TARGET,
  );
});

test('H2-C: the validated handle SEALS the routing the driver will be given', () => {
  const pooler = describeManagedDriverRouting(assertManagedDevDsn(POOLER_OK, GATEWAY, 'postgres'));
  assert.deepEqual(pooler, {
    hostFamily: 'pooler',
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${REF}`,
  });
  const direct = describeManagedDriverRouting(assertManagedDevDsn(DIRECT_OK, GATEWAY, 'postgres'));
  assert.deepEqual(direct, {
    hostFamily: 'direct',
    host: `db.${REF}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
  });
  // The seam exposes routing, never the secret: no password anywhere in the projection.
  assert.deepEqual(Object.keys(direct).sort(), ['database', 'host', 'hostFamily', 'port', 'user']);
  assert.ok(!JSON.stringify(direct).includes('pw'), 'the password must not be reachable through the seam');
  // An unvalidated object cannot borrow a sealed target.
  const forged = Object.freeze({ kind: 'managed_dev_dsn', database: 'postgres', endpointFamily: 'session' }) as never;
  assert.equal(codeOf(() => describeManagedDriverRouting(forged)), EXECUTOR_CODES.MANAGED_DSN_INVALID);
});

test('H2-D: the sealed routing is the ONLY thing the driver is given', () => {
  // The other half of this proof — that the INSTALLED postgres.js resolves exactly these values
  // and cannot be talked out of them by a raw multihost DSN — lives in the containment suite,
  // which sits outside `server/` and so can import the driver without adding a driver edge to a
  // directory whose driver edges are inventoried. Here: the values themselves.
  for (const [raw, expected] of [
    [POOLER_OK, { hostFamily: 'pooler', host: 'aws-0-eu-west-1.pooler.supabase.com', port: 5432, database: 'postgres', user: `postgres.${REF}` }],
    [DIRECT_OK, { hostFamily: 'direct', host: `db.${REF}.supabase.co`, port: 5432, database: 'postgres', user: 'postgres' }],
  ] as ReadonlyArray<readonly [string, Record<string, unknown>]>) {
    const routing = describeManagedDriverRouting(assertManagedDevDsn(raw, GATEWAY, 'postgres'));
    assert.deepEqual(routing, expected);
    // Nothing in the sealed routing can be read as a multihost list, a port suffix or a path.
    assert.ok(!/[,%:/\\\s]/.test(routing.host), 'the sealed host cannot carry a second authority');
    assert.equal(typeof routing.port, 'number', 'the port is a number, not text the driver re-splits');
  }
  // A case-varied host is sealed in its canonical lowercase form, so the value compared is the
  // value used.
  assert.equal(
    describeManagedDriverRouting(assertManagedDevDsn(`postgres://postgres:pw@DB.${REF.toUpperCase()}.SUPABASE.CO:5432/postgres`, GATEWAY, 'postgres')).host,
    `db.${REF}.supabase.co`,
  );
});

test('H2-E: cross-signal disagreement and gateway corroboration survive the H2 rewrite', () => {
  const a = 'aaaaaaaaaaaaaaaa';
  const b = 'bbbbbbbbbbbbbbbb';
  // username A versus direct host B
  assert.equal(
    codeOf(() => assertManagedDevDsn(`postgres://postgres.${a}:pw@db.${b}.supabase.co:5432/postgres`, `https://${a}.supabase.co`, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH,
  );
  // username versus gateway
  assert.equal(codeOf(() => assertManagedDevDsn(POOLER_OK, `https://${OTHER_REF}.supabase.co`, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH);
  // direct host versus gateway
  assert.equal(codeOf(() => assertManagedDevDsn(DIRECT_OK, `https://${OTHER_REF}.supabase.co`, 'postgres')), EXECUTOR_CODES.MANAGED_DSN_PROJECT_MISMATCH);
  // a pooler host still derives NO reference of its own — the username alone speaks for it
  assert.deepEqual(describeManagedDriverRouting(assertManagedDevDsn(POOLER_OK, GATEWAY, 'postgres')).hostFamily, 'pooler');
  // ...and a refusal leaves no sealed target behind: `describeManagedDriverRouting` can only
  // answer for a handle the validator actually minted, so there is nothing for a caller to read.
  for (const bad of [`postgres://postgres.${a}:pw@db.${b}.supabase.co:5432/postgres`, `${POOLER_OK.replace(':5432', ':6543')}`]) {
    assert.notEqual(codeOf(() => assertManagedDevDsn(bad, GATEWAY, 'postgres')), 'NO_THROW');
  }
});


test('H2-F: the sealed principal can never be an AMBIENT one', () => {
  // The seam is only honest if every value it reports is a value the driver will actually use.
  // postgres.js resolves `user` and `pass` through `||` chains that end in `env.PGUSERNAME` /
  // `env.PGUSER` / `osUsername()` and `env.PGPASSWORD`, so an EMPTY sealed value is not a value at
  // all — it is a silent handover to the environment. The connection would still reach the sealed,
  // TLS-verified host while authenticating as whoever the box says, and the seam would report `''`
  // for a driver that used something else. Emptiness is therefore refused, not defaulted.
  for (const raw of [
    `postgres://db.${REF}.supabase.co:5432/postgres`, // no userinfo at all
    `postgres://:pw@db.${REF}.supabase.co:5432/postgres`, // no role
    `postgres://postgres@db.${REF}.supabase.co:5432/postgres`, // no password
    `postgres://postgres:@db.${REF}.supabase.co:5432/postgres`,
    `postgres://postgres.${REF}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(raw, GATEWAY, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_INVALID,
      `${raw.replace(REF, '<ref>')} must not seal an empty principal`,
    );
  }
  // A role name is constrained like every other sealed field. The startup packet is a
  // NUL-separated key/value list, so a NUL inside the role appends startup PARAMETERS —
  // `postgres\0options\0-c search_path=…` on a connection that then runs migration DDL.
  for (const user of [
    'postgres%00options%00-c%20search_path%3Devil', // startup-parameter injection
    'postgres%20admin', // whitespace
    'postgres%3Devil', // an `=` would read as a parameter assignment
    `${'a'.repeat(64)}`, // longer than PostgreSQL's own identifier limit
    '.postgres', // a role name may not begin with a separator
    '-postgres',
  ]) {
    assert.equal(
      codeOf(() => assertManagedDevDsn(`postgres://${user}:pw@db.${REF}.supabase.co:5432/postgres`, GATEWAY, 'postgres')),
      EXECUTOR_CODES.MANAGED_DSN_INVALID,
      `${user} is not a valid role name`,
    );
  }
  // Both documented role spellings still pass, and 63 characters remains legal.
  assert.equal(describeManagedDriverRouting(assertManagedDevDsn(DIRECT_OK, GATEWAY, 'postgres')).user, 'postgres');
  assert.equal(describeManagedDriverRouting(assertManagedDevDsn(POOLER_OK, GATEWAY, 'postgres')).user, `postgres.${REF}`);
});

test('H2-G: db.pooler.supabase.com sits in BOTH grammars and the claim guard is what refuses it', () => {
  // `db` is itself a legal DNS label, so the direct-host claim and the pooler shape intersect at
  // exactly one hostname. Without the claim guard this would classify as a pooler, take its
  // identity from the username alone, and be ACCEPTED — an accept-to-reject difference, not the
  // cosmetic code difference the guard is easy to mistake for.
  assert.equal(
    codeOf(() => assertManagedDevDsn(anyHost('db.pooler.supabase.com'), GATEWAY, 'postgres')),
    EXECUTOR_CODES.MANAGED_DSN_ENDPOINT_FAMILY_REJECTED,
  );
  // Neighbouring labels are ordinary pooler hosts and stay accepted, so the guard is not a
  // blanket ban on short labels.
  assert.deepEqual(describeManagedDsn(assertManagedDevDsn(anyHost('dc.pooler.supabase.com'), GATEWAY, 'postgres')), SESSION_TARGET);
});

// ---------------------------------------------------------------------------
// Phase 4.0 M3 S4.1b — C2B-M005-B0
//
// The single-purpose migration-005 hardening: the ledger relation contract, fail-closed dirty
// state, under-lock artifact identity, post-commit verification, the COMMIT evidence model and
// the advisory-lock release matrix.
//
// STILL DATABASE-FREE. Every catalog answer, every ledger row and every migration file below is a
// fake, so these prove the DECISIONS without a managed endpoint existing and without 005 running.
// ---------------------------------------------------------------------------

/** The catalog shape a correctly created ledger relation reports. */
interface FakeLedgerShape {
  relkind?: string | null;
  rls?: boolean;
  checks?: string[];
  pkCols?: string | null;
  columns?: { name: string; type: string; notnull: boolean; def: string | null; generated?: string; identity?: string }[];
  pk?: string | null;
  /** Force a catalog read to throw, so "missing evidence" can be told from "good shape". */
  throws?: boolean;
}

const CONTRACT_COLUMNS = () => LEDGER_COLUMN_CONTRACT.map((c) => ({
  name: c.name, type: c.type, notnull: c.notNull, def: c.defaultExpr, generated: '', identity: '',
}));

function fakeLedgerCatalog(s: FakeLedgerShape): CatalogReadPort {
  return {
    query: async (text: string, params: readonly unknown[] = []) => {
      if (s.throws === true) throw new Error('catalog exploded');
      // BIND ON THE PARAMETERS. Dispatching on SQL text alone let the entire shape check be
      // repointed at a relation that does not exist without a single test failing.
      if (params.length >= 2 && (params[0] !== LEDGER_RELATION.schema || params[1] !== LEDGER_RELATION.table)) {
        return [];
      }
      if (text.includes('c.relkind::text as kind')) {
        return s.relkind === null || s.relkind === undefined ? [] : [{ kind: s.relkind, rls: s.rls === true }];
      }
      // `attisdropped` appears ONLY in the column query. The structural primary-key query also
      // reads pg_attribute, so a looser matcher answered it with column rows.
      if (text.includes('attisdropped')) {
        return (s.columns ?? CONTRACT_COLUMNS()).map((c) => ({
          name: c.name, type: c.type, notnull: c.notnull, def: c.def,
          generated: (c as { generated?: string }).generated ?? '', identity: (c as { identity?: string }).identity ?? '',
        }));
      }
      if (text.includes("k.contype = 'c'")) return (s.checks ?? []).map((name) => ({ name }));
      if (text.includes("k.contype = 'p'")) {
        const cols = s.pkCols === undefined ? 'version' : s.pkCols;
        return cols === null ? [] : [{ cols }];
      }
      return [];
    },
  };
}

test('C2B-M005-B0: an ABSENT ledger relation is not a shape failure — the DDL will create it', async () => {
  const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: null }));
  assert.equal(r.present, false);
  assert.deepEqual(r.failed, []);
});

test('C2B-M005-B0: a correctly shaped ledger relation passes with no findings', async () => {
  const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r' }));
  assert.equal(r.present, true);
  assert.deepEqual(r.failed, []);
});

test('C2B-M005-B0: the column contract is DERIVED from the DDL, field by field', async () => {
  // `create table if not exists` is a silent no-op against a relation with any other definition, so
  // the contract is the only thing that can detect a wrong shape. Comparing the DDL against a
  // handful of regexes and the contract against a length left three real drifts undetectable: a
  // `timestamptz` spelling that would never match `format_type` output (silently disabling the
  // check on a live database) and a flipped nullability on `version`. This parses the DDL and
  // compares the two representations directly.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./migrationExecutor.ts', import.meta.url), 'utf8');
  const ddl = /const LEDGER_DDL =\s*([\s\S]*?);\n/.exec(src);
  assert.notEqual(ddl, null, 'LEDGER_DDL must be findable in source');
  const text = ddl![1].replace(/'/g, '').replace(/\s*\+\s*/g, '').replace(/\s+/g, ' ').trim();
  assert.ok(text.startsWith(`create table if not exists ${LEDGER_RELATION.schema}.${LEDGER_RELATION.table} (`), text);

  // `format_type` renders the RESOLVED type, which is not always the DDL spelling.
  const RESOLVED = { text: 'text', boolean: 'boolean', timestamptz: 'timestamp with time zone' };
  const body = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'));
  const derived = body.split(',').map((raw) => {
    const col = raw.trim();
    const [name, ddlType, ...rest] = col.split(/\s+/);
    const tail = rest.join(' ');
    const def = /default (\S+)/.exec(tail);
    return {
      name,
      type: RESOLVED[ddlType as keyof typeof RESOLVED] ?? ddlType,
      notNull: /not null/.test(tail) || /primary key/.test(tail),
      defaultExpr: def === null ? null : def[1],
    };
  });
  assert.deepEqual(derived, LEDGER_COLUMN_CONTRACT.map((c) => ({ ...c })));
});

test('C2B-M005-B0: a NON-TABLE relation of the same name is refused', async () => {
  for (const relkind of ['v', 'm', 'f', 'p']) {
    const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind }));
    assert.equal(r.present, true, relkind);
    assert.ok(r.failed.some((f) => f.includes('not an ordinary table')), relkind);
  }
});

test('C2B-M005-B0: each column deviation is detected on its own', async () => {
  const cases: { label: string; mutate: (c: ReturnType<typeof CONTRACT_COLUMNS>) => ReturnType<typeof CONTRACT_COLUMNS>; match: RegExp }[] = [
    { label: 'missing', mutate: (c) => c.filter((x) => x.name !== 'dirty'), match: /dirty missing/ },
    { label: 'type', mutate: (c) => c.map((x) => (x.name === 'dirty' ? { ...x, type: 'text' } : x)), match: /dirty is text/ },
    { label: 'nullability', mutate: (c) => c.map((x) => (x.name === 'dirty' ? { ...x, notnull: false } : x)), match: /dirty nullability differs/ },
    { label: 'default', mutate: (c) => c.map((x) => (x.name === 'dirty' ? { ...x, def: 'false' } : x)), match: /dirty default differs/ },
    { label: 'checksum type', mutate: (c) => c.map((x) => (x.name === 'checksum' ? { ...x, type: 'bytea' } : x)), match: /checksum is bytea/ },
    { label: 'finished_at nullability', mutate: (c) => c.map((x) => (x.name === 'finished_at' ? { ...x, notnull: true } : x)), match: /finished_at nullability differs/ },
  ];
  for (const c of cases) {
    const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r', columns: c.mutate(CONTRACT_COLUMNS()) }));
    assert.ok(r.failed.some((f) => c.match.test(f)), `${c.label}: ${r.failed.join(' | ')}`);
  }
});

test('C2B-M005-B0: an extra column is tolerated only when an unnamed INSERT can satisfy it', async () => {
  // The insert statements name four and five columns respectively, so an extra column must be
  // satisfiable without being named. Nullable or defaulted: fine. NOT NULL with no default: every
  // insert would fail at runtime, so it is refused now rather than mid-run.
  const nullable = await verifyLedgerShape(fakeLedgerCatalog({
    relkind: 'r', columns: [...CONTRACT_COLUMNS(), { name: 'note', type: 'text', notnull: false, def: null }],
  }));
  assert.deepEqual(nullable.failed, []);
  const defaulted = await verifyLedgerShape(fakeLedgerCatalog({
    relkind: 'r', columns: [...CONTRACT_COLUMNS(), { name: 'note', type: 'text', notnull: true, def: "''::text" }],
  }));
  assert.deepEqual(defaulted.failed, []);
  const hostile = await verifyLedgerShape(fakeLedgerCatalog({
    relkind: 'r', columns: [...CONTRACT_COLUMNS(), { name: 'note', type: 'text', notnull: true, def: null }],
  }));
  assert.ok(hostile.failed.some((f) => /unexpected NOT NULL column with no default/.test(f)));
});

test('C2B-M005-B0: the uniqueness contract is required, and compared STRUCTURALLY', async () => {
  // The rendered definition gains INCLUDE (...), WITH (fillfactor=...) and tablespace decorations,
  // so string equality refuses a functionally identical key. The column set is the contract.
  for (const pkCols of [null, 'checksum', 'version,checksum']) {
    const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r', pkCols }));
    assert.ok(r.failed.some((f) => /primary key is not exactly the version column/.test(f)), String(pkCols));
  }
  assert.deepEqual((await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r', pkCols: 'version' }))).failed, []);
});

test('C2B-M005-B0: a ledger relation with row security enabled is refused — it reads fail-OPEN', async () => {
  // A policy that hides every row makes readLedger return zero rows, and zero rows is this
  // system's evidence that a migration has never been applied.
  const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r', rls: true }));
  assert.ok(r.failed.some((f) => /row-level security enabled/.test(f)), r.failed.join(' | '));
});

test('C2B-M005-B0: a generated or identity contract column is refused before it breaks every insert', async () => {
  const gen = CONTRACT_COLUMNS().map((c) => (c.name === 'checksum' ? { ...c, generated: 's' } : c));
  const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r', columns: gen }));
  assert.ok(r.failed.some((f) => /checksum is generated or an identity column/.test(f)), r.failed.join(' | '));
  // ...but an EXTRA self-supplying column needs no default and must not be false-flagged.
  const extra = [...CONTRACT_COLUMNS(), { name: 'seq', type: 'bigint', notnull: true, def: null, generated: '', identity: 'a' }];
  assert.deepEqual((await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r', columns: extra }))).failed, []);
});

test('C2B-M005-B0: an undeclared CHECK constraint on the ledger is refused', async () => {
  // A shape that passes every column test and then defeats the write it approves: `CHECK (dirty =
  // false)` rejects insertDirtyAttempt, whose whole purpose is to write `dirty = true` first.
  const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r', checks: ['schema_migrations_dirty_chk'] }));
  assert.ok(r.failed.some((f) => /undeclared check constraint/.test(f)), r.failed.join(' | '));
});

// ---------------------------------------------------------------------------
// C2B-M005-P2-R2-B0 — the typed shape-category contract
//
// The reason strings above name the thing they found — a column, a type, a default expression, a
// constraint — so none of them may reach an operator record. The accepted renderer therefore
// printed one aggregate MISMATCH and discarded WHICH check failed, and a second live observation
// would have returned the identical aggregate. These prove the publishable half of each finding is
// chosen AT the guard, is complete over the eleven causes, and survives every combination.
// ---------------------------------------------------------------------------

/** One fake catalog per source condition, paired with the category that condition must produce. */
const SHAPE_CAUSES: readonly { readonly why: string; readonly shape: FakeLedgerShape; readonly category: LedgerShapeCategory }[] = [
  { why: 'relation absent', shape: { relkind: null }, category: 'RELATION_ABSENT' },
  { why: 'relation is a view', shape: { relkind: 'v' }, category: 'RELATION_KIND' },
  { why: 'row-level security enabled', shape: { relkind: 'r', rls: true }, category: 'ROW_LEVEL_SECURITY' },
  {
    why: 'a contracted column is missing',
    shape: { relkind: 'r', columns: CONTRACT_COLUMNS().filter((c) => c.name !== 'finished_at') },
    category: 'COLUMN_MISSING',
  },
  {
    why: 'a contracted column has the wrong type',
    shape: { relkind: 'r', columns: CONTRACT_COLUMNS().map((c) => (c.name === 'checksum' ? { ...c, type: 'integer' } : c)) },
    category: 'COLUMN_TYPE',
  },
  {
    why: 'a contracted column is generated',
    shape: { relkind: 'r', columns: CONTRACT_COLUMNS().map((c) => (c.name === 'checksum' ? { ...c, generated: 's' } : c)) },
    category: 'COLUMN_GENERATED_OR_IDENTITY',
  },
  {
    why: 'a contracted column nullability differs',
    shape: { relkind: 'r', columns: CONTRACT_COLUMNS().map((c) => (c.name === 'finished_at' ? { ...c, notnull: true } : c)) },
    category: 'COLUMN_NULLABILITY',
  },
  {
    why: 'a contracted column default differs',
    shape: { relkind: 'r', columns: CONTRACT_COLUMNS().map((c) => (c.name === 'dirty' ? { ...c, def: 'false' } : c)) },
    category: 'COLUMN_DEFAULT',
  },
  {
    why: 'an unexpected NOT NULL column with no default',
    shape: {
      relkind: 'r',
      columns: [...CONTRACT_COLUMNS(), { name: 'tenant_id', type: 'uuid', notnull: true, def: null, generated: '', identity: '' }],
    },
    category: 'EXTRA_REQUIRED_COLUMN',
  },
  { why: 'an undeclared CHECK constraint', shape: { relkind: 'r', checks: ['schema_migrations_dirty_chk'] }, category: 'UNDECLARED_CHECK' },
  { why: 'the primary key is not the version column', shape: { relkind: 'r', pkCols: 'checksum' }, category: 'PRIMARY_KEY' },
];

test('C2B-M005-P2-R2-B0: each of the eleven mismatch causes maps to its own category, alone', async () => {
  // THE MAPPING IS COMPLETE AND THE CAUSES ARE SEPARABLE. A cause that produced two categories, or
  // a category no cause produces, would make the operator field either ambiguous or unreachable.
  assert.equal(SHAPE_CAUSES.length, LEDGER_SHAPE_CATEGORY_ORDER.length);
  for (const c of SHAPE_CAUSES) {
    const r = await verifyLedgerShape(fakeLedgerCatalog(c.shape));
    assert.deepEqual(r.categories, [c.category], c.why + ': ' + r.categories.join(',') + ' / ' + r.failed.join(' | '));
  }
  assert.deepEqual(
    SHAPE_CAUSES.map((c) => c.category).slice().sort(),
    LEDGER_SHAPE_CATEGORY_ORDER.slice().sort(),
    'every declared category must be produced by some source condition',
  );
});

test('C2B-M005-P2-R2-B0: relation absence carries its category despite an empty reason list', async () => {
  // THE FINDING THAT HAD NO EXPLANATION. The reason list is empty here by design — the apply path
  // creates the relation, so absence is not a contract violation for it — and the preflight
  // nonetheless reads absence as a MISMATCH. Without the category the record said "the ledger
  // disagrees" and named nothing whatever, which is the report this correction exists to fix.
  const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind: null }));
  assert.equal(r.present, false);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.categories, ['RELATION_ABSENT']);
});

test('C2B-M005-P2-R2-B0: the reason/category pairing holds over every catalog condition, not a fixture list', async () => {
  // NOT THE CURATED ELEVEN. The list above pins each cause to its category; this drives the REAL
  // producer over the cross-product of every condition it inspects, so a twelfth guard added later
  // with a reason and no category fails here even though no fixture names it.
  const cols = () => CONTRACT_COLUMNS();
  const columnSets = [
    cols(),
    cols().filter((c) => c.name !== 'finished_at'),
    cols().map((c) => (c.name === 'checksum' ? { ...c, type: 'integer' } : c)),
    cols().map((c) => (c.name === 'checksum' ? { ...c, generated: 's' } : c)),
    cols().map((c) => (c.name === 'finished_at' ? { ...c, notnull: true } : c)),
    cols().map((c) => (c.name === 'dirty' ? { ...c, def: 'false' } : c)),
    [...cols(), { name: 'x', type: 'uuid', notnull: true, def: null, generated: '', identity: '' }],
    [...cols(), { name: 'x', type: 'uuid', notnull: false, def: null, generated: '', identity: '' }],
  ];
  let states = 0;
  let mismatches = 0;
  for (const relkind of [null, 'r', 'v', 'f', 'p']) {
    for (const rls of [false, true]) {
      for (const columns of columnSets) {
        for (const checks of [[], ['a'], ['a', 'b']]) {
          for (const pkCols of ['version', 'checksum', 'version,checksum', null]) {
            const r = await verifyLedgerShape(fakeLedgerCatalog({ relkind, rls, columns, checks, pkCols }));
            states += 1;
            const where = JSON.stringify({ relkind, rls, checks, pkCols, cols: columns.length });
            // EVERY REASON IS PAIRED. This is the invariant the operator field depends on: a
            // finding the producer can state but not classify is a mismatch with no cause.
            if (r.failed.length > 0) {
              assert.ok(r.categories.length > 0, 'reason without a category: ' + where);
              mismatches += 1;
            }
            // AND EVERY CATEGORY IS A DECLARED ONE.
            for (const c of r.categories) {
              assert.ok(LEDGER_SHAPE_CATEGORY_ORDER.includes(c), c + ' at ' + where);
            }
            // A CONFORMING RELATION STAYS SILENT ON BOTH.
            if (r.present && r.failed.length === 0) assert.deepEqual(r.categories, [], where);
            // ABSENCE IS THE ONE FINDING WITH NO REASON, and it is never silent on the category.
            if (!r.present) assert.deepEqual(r.categories, ['RELATION_ABSENT'], where);
            // THE SET IS ALWAYS CANONICAL AND DEDUPLICATED, whatever order the guards fired in.
            assert.deepEqual(r.categories, canonicalLedgerShapeCategories(r.categories), where);
          }
        }
      }
    }
  }
  assert.ok(states >= 900, 'states=' + states);
  assert.ok(mismatches >= 500, 'mismatches=' + mismatches);
});

test('C2B-M005-P2-R2-B0: the ambiguous-catalog reason is the exact string the preflight treats as unreadable', async () => {
  // THE ONE CROSS-MODULE STRING CONTRACT. The preflight recognises an unmeasurable shape by this
  // literal; if the text here were reworded the two would drift, and while the empty category set
  // would still fail the read closed, the specific unreadable verdict would be lost. Both sides
  // are anchored on the same literal, so either one moving alone fails a test.
  const ambiguous: CatalogReadPort = {
    query: async (text: string) => (text.includes('c.relkind::text as kind')
      ? [{ kind: 'r', rls: false }, { kind: 'r', rls: false }]
      : []),
  };
  const r = await verifyLedgerShape(ambiguous);
  assert.deepEqual(r.failed, ['ledger relation ambiguous in catalog']);
  assert.deepEqual(r.categories, []);
});

test('C2B-M005-P2-R2-B0: simultaneous discrepancies keep every category, deduplicated and ordered', async () => {
  // FOUR AT ONCE, TWO OF THEM ARRIVING TWICE. Reporting only the first would send an operator to
  // fix one defect and re-run into the next; reporting them in discovery order would make the same
  // database print two different findings depending on how the catalog happened to answer.
  const columns = CONTRACT_COLUMNS().map((c) => {
    if (c.name === 'checksum') return { ...c, type: 'integer' };
    if (c.name === 'version') return { ...c, type: 'integer' };
    if (c.name === 'started_at') return { ...c, def: 'now()' };
    return c;
  });
  const r = await verifyLedgerShape(fakeLedgerCatalog({
    relkind: 'r', rls: true, columns, checks: ['a_chk', 'b_chk'], pkCols: 'checksum',
  }));
  // COLUMN_TYPE twice and UNDECLARED_CHECK twice, collapsed to one each.
  assert.deepEqual(r.categories, [
    'ROW_LEVEL_SECURITY', 'COLUMN_TYPE', 'UNDECLARED_CHECK', 'PRIMARY_KEY',
  ]);
  assert.ok(r.failed.length > r.categories.length, 'the reason list still carries every finding');
  // started_at has no contracted default, so a default present there is NOT a finding — the control
  // proving the set above is not simply "every column this fake mentioned".
  assert.ok(!r.categories.includes('COLUMN_DEFAULT'));
});

test('C2B-M005-P2-R2-B0: category order is canonical, never the order they were discovered', () => {
  const reversed = LEDGER_SHAPE_CATEGORY_ORDER.slice().reverse();
  assert.deepEqual(canonicalLedgerShapeCategories(reversed), LEDGER_SHAPE_CATEGORY_ORDER.slice());
  assert.deepEqual(
    canonicalLedgerShapeCategories(['PRIMARY_KEY', 'RELATION_ABSENT', 'PRIMARY_KEY', 'COLUMN_TYPE']),
    ['RELATION_ABSENT', 'COLUMN_TYPE', 'PRIMARY_KEY'],
  );
  assert.deepEqual(canonicalLedgerShapeCategories([]), []);
});

test('C2B-M005-P2-R2-B0: a conforming relation carries no category, and an ambiguous one carries none either', async () => {
  const ok = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'r' }));
  assert.deepEqual(ok.failed, []);
  assert.deepEqual(ok.categories, []);

  // AMBIGUITY IS THE ONE UNMEASURABLE CASE. A mismatch category here would let a shape that could
  // not be determined reach the operator as an observed disagreement about a specific check.
  const ambiguous: CatalogReadPort = {
    query: async (text: string) => (text.includes('c.relkind::text as kind')
      ? [{ kind: 'r', rls: false }, { kind: 'r', rls: false }]
      : []),
  };
  const r = await verifyLedgerShape(ambiguous);
  assert.equal(r.present, true);
  assert.ok(r.failed.some((f) => /ambiguous/.test(f)));
  assert.deepEqual(r.categories, [], 'an unreadable shape must carry no mismatch category');
});

test('C2B-M005-P2-R2-B0: no category token can carry a catalog value', () => {
  // BY CONSTRUCTION, not by filtering: every member is a fixed source constant, so the assertion
  // is that the closed list contains nothing but upper-case identifiers of this vocabulary.
  for (const c of LEDGER_SHAPE_CATEGORY_ORDER) {
    assert.match(c, /^[A-Z][A-Z_]*[A-Z]$/, c);
  }
  assert.equal(new Set(LEDGER_SHAPE_CATEGORY_ORDER).size, LEDGER_SHAPE_CATEGORY_ORDER.length);
});

test('C2B-M005-P2-R2-B0: the apply policy still refuses on the same shapes and no others', async () => {
  // THE SECOND CONSUMER OF THIS FUNCTION reads presence and the reason list, so adding a category
  // to an absent relation must not turn the ordinary first-run state into an apply refusal.
  const absent = await verifyLedgerShape(fakeLedgerCatalog({ relkind: null }));
  assert.equal(absent.present && absent.failed.length > 0, false);
  const bad = await verifyLedgerShape(fakeLedgerCatalog({ relkind: 'v' }));
  assert.equal(bad.present && bad.failed.length > 0, true);
});

// ---------------------------------------------------------------------------
// fail-closed dirty state
// ---------------------------------------------------------------------------

test('C2B-M005-B0: only the two literal booleans are a readable dirty state', () => {
  assert.equal(normalizeLedgerDirty(true), true);
  assert.equal(normalizeLedgerDirty(false), false);
  // The whole failure class: every one of these previously coerced to `false` — this system's word
  // for "completed cleanly" — so an unrepresentable value read as the safest possible one.
  for (const hostile of [null, undefined, 0, 1, 't', 'f', 'true', 'false', '', {}, []]) {
    assert.equal(normalizeLedgerDirty(hostile), null, JSON.stringify(hostile));
  }
});

test('C2B-M005-B0: a NULL or coerced dirty value refuses AT THE READ, before any planner sees it', () => {
  assert.deepEqual(
    toLedgerRowStrict({ version: '005', checksum: 'abc', dirty: false }),
    { version: '005', checksum: 'abc', dirty: false },
  );
  for (const hostile of [null, undefined, 0, 1, 't', 'f']) {
    assert.equal(
      codeOf(() => toLedgerRowStrict({ version: '005', checksum: 'abc', dirty: hostile })),
      EXECUTOR_CODES.LEDGER_DIRTY_STATE_INVALID,
      JSON.stringify(hostile),
    );
  }
});

test('C2B-M005-B0: the dirty refusal carries a version label and never the offending value', () => {
  try {
    toLedgerRowStrict({ version: '005', checksum: 'abc', dirty: 'pw=hunter2' });
    assert.fail('must throw');
  } catch (e) {
    const msg = String((e as Error).message);
    assert.ok(msg.includes('005'));
    assert.ok(!msg.includes('hunter2'), 'a malformed column can hold anything; it is never echoed');
  }
});

// ---------------------------------------------------------------------------
// under-lock migration identity (§8)
// ---------------------------------------------------------------------------

/** The real 005 bytes, read once so the policy tests exercise the governed artifact itself. */
async function realM005Files(): Promise<Record<string, string>> {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('./migrations/', import.meta.url);
  const out: Record<string, string> = {};
  for (const b of [M005_UP_BASENAME, M005_DOWN_BASENAME]) {
    out[b] = readFileSync(new URL(b, dir), 'utf8');
  }
  return out;
}

/** A discovery set in which 001-004 are already recorded and 005 is the sole pending version. */
async function m005World(over: { files?: Record<string, string>; rows?: LedgerRow[] } = {}) {
  const files = over.files ?? (await realM005Files());
  const rows = over.rows ?? [];
  const ledger: ExecutorLedgerPort = {
    readLedger: async () => rows,
    insertDirtyAttempt: async () => {},
    finalizeApplied: async () => {},
  };
  return { files, rows, ledger };
}

const m005Plan = (checksum: string) => [{ version: M005_VERSION, checksum, txScoped: true }];

test('C2B-M005-B0: the governed 005 hashes match the artifacts on disk', async () => {
  const files = await realM005Files();
  assert.equal(sha256Hex(enc(files[M005_UP_BASENAME])), M005_UP_SHA256);
  assert.equal(sha256Hex(enc(files[M005_DOWN_BASENAME])), M005_DOWN_SHA256);
});

test('C2B-M005-B0: the under-lock policy authorizes the governed artifact and the exact [005] plan', async () => {
  const w = await m005World();
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'r' }), fsPort: fakeFs(w.files),
  });
  const verdict = await policy({
    session: {} as unknown as ExecutorSession,
    executionPlan: m005Plan(M005_UP_SHA256),
  });
  assert.equal(verdict, null);
});

test('C2B-M005-B0: a checksum change AFTER lock acquisition is refused (time-of-check/time-of-use)', async () => {
  // THE WINDOW THIS CLOSES. Discovery runs before the lock; without the under-lock re-derivation an
  // artifact swapped in between would be EXECUTED and then recorded under a checksum computed from
  // the swapped bytes, so the ledger would agree with the tampered file forever.
  const w = await m005World();
  const tampered = { ...w.files, [M005_UP_BASENAME]: `${w.files[M005_UP_BASENAME]}\n-- appended\n` };
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'r' }), fsPort: fakeFs(tampered),
  });
  // The plan is self-consistent with the TAMPERED file, which is exactly why a self-consistency
  // check alone would have passed it.
  const verdict = await policy({
    session: {} as unknown as ExecutorSession,
    executionPlan: m005Plan(sha256Hex(enc(tampered[M005_UP_BASENAME]))),
  });
  assert.equal(verdict, EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT);
});

test('C2B-M005-B0: discovery that resolves 005 to DIFFERENT bytes is refused by the governed-hash gate', async () => {
  // WHY THIS SHAPE EXISTS. The artifact re-read (step 2) hashes the file at the FIXED governed
  // basename, so a tampered 005 is caught there and step 3's comparison never runs — a red/green
  // mutation of step 3 therefore changed no test at all, which is how a conjunct comes to look
  // load-bearing while being unreachable.
  //
  // The state step 3 actually guards is DIVERGENCE: the governed file is present and byte-perfect,
  // but DISCOVERY resolved version 005 to different bytes. Here the port serves the real governed
  // bytes for the governed basenames while listing a differently-named 005 pair, so step 2 passes
  // and only the governed-hash comparison can refuse.
  const real = await realM005Files();
  const alt = {
    '005_alternate_name.up.sql': '-- transaction: required\nselect 1;\n',
    '005_alternate_name.down.sql': '-- transaction: required\nselect 1;\n',
  };
  const divergent: MigrationFsPort = {
    relDir: 'server/platform-identity/migrations',
    list: () => Object.keys(alt),
    entryType: () => 'file',
    readBytes: (b: string) => enc(alt[b] ?? real[b] ?? ''),
  };
  const w = await m005World({ files: real });
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'r' }), fsPort: divergent,
  });
  const verdict = await policy({
    session: {} as unknown as ExecutorSession,
    executionPlan: m005Plan(sha256Hex(enc(alt['005_alternate_name.up.sql']))),
  });
  assert.equal(verdict, EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT);
});

test('C2B-M005-B0: a change to the DOWN artifact is refused too — the governed pair is the pair', async () => {
  const w = await m005World();
  const tampered = { ...w.files, [M005_DOWN_BASENAME]: `${w.files[M005_DOWN_BASENAME]}\n-- appended\n` };
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'r' }), fsPort: fakeFs(tampered),
  });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT,
  );
});

test('C2B-M005-B0: a non-regular migration entry is refused rather than read', async () => {
  const w = await m005World();
  const fs: MigrationFsPort = { ...fakeFs(w.files), entryType: () => 'symlink' };
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'r' }), fsPort: fs,
  });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    EXECUTOR_CODES.MANAGED_APPLY_IDENTITY_DRIFT,
  );
});

test('C2B-M005-B0: an incompatible ledger shape refuses BEFORE the artifact or the plan is trusted', async () => {
  const w = await m005World();
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'v' }), fsPort: fakeFs(w.files),
  });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    EXECUTOR_CODES.LEDGER_SHAPE_REJECTED,
  );
});

test('C2B-M005-B0: a catalog read that FAILS is missing evidence, never a good shape', async () => {
  const w = await m005World();
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ throws: true }), fsPort: fakeFs(w.files),
  });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    ENGINE_CODES.PORT_OPERATION_FAILED,
  );
});

test('C2B-M005-B0: a version 006 that becomes eligible in the window stops the run', async () => {
  const w = await m005World();
  const withSix = {
    ...w.files,
    '006_later.up.sql': '-- transaction: required\nselect 1;\n',
    '006_later.down.sql': '-- transaction: required\nselect 1;\n',
  };
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'r' }), fsPort: fakeFs(withSix),
  });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED,
  );
});

test('C2B-M005-B0: a frozen program that disagrees with the authoritative plan is drift, not identity', async () => {
  const w = await m005World();
  const policy = createManagedM005Policy({
    ledger: w.ledger, catalog: fakeLedgerCatalog({ relkind: 'r' }), fsPort: fakeFs(w.files),
  });
  for (const plan of [
    [],
    [{ version: '004', checksum: M005_UP_SHA256, txScoped: true }],
    [{ version: M005_VERSION, checksum: M005_UP_SHA256, txScoped: false }],
  ]) {
    const verdict = await policy({ session: {} as unknown as ExecutorSession, executionPlan: plan });
    assert.notEqual(verdict, null, JSON.stringify(plan));
  }
});

// ---------------------------------------------------------------------------
// post-commit verification (§10)
// ---------------------------------------------------------------------------

/**
 * The role the migration ran as. SERVER-DERIVED in production (`select current_user`); a fixed
 * value here so a test can make the catalog disagree with it, which is the only way to exercise
 * the executing-principal mismatch.
 */
const M005_PRINCIPAL = 'tmpos_migrator';

/**
 * The default-ACL rows of a database in which every migration-005 postcondition holds.
 *
 * TWO ROWS, AND ONLY ONE OF THEM COMES FROM MIGRATION 005. Revoking from PUBLIC what PostgreSQL
 * never granted is a no-op that creates no catalog row, so the TABLES and SEQUENCES statements
 * leave nothing behind — their hard-wired default already grants PUBLIC nothing. The FUNCTIONS
 * statement is the one that changes state, and because it is written `IN SCHEMA public` it writes
 * a PUBLIC-SCHEMA row.
 *
 * That row is NOT sufficient. PostgreSQL composes a new object's ACL by merging the per-schema
 * entry ON TOP of a base, where the base is the GLOBAL entry when one exists and the hard-wired
 * `acldefault()` otherwise — and `acldefault()` grants PUBLIC EXECUTE on functions. The per-schema
 * entry can only add. Closing the class therefore requires a GLOBAL functions row for the same
 * principal, and migration 005 issues no such statement.
 *
 * So this fixture is a database where that global row is ALREADY PRESENT from some earlier action.
 * That is a legitimate state, but it is not one migration 005 establishes by itself, and nothing
 * here should be read as claiming otherwise: the gap is reported as a blocker against the frozen
 * migration rather than absorbed into the fixture.
 */
const CLEAN_DEFAULT_ACL = (): Record<string, unknown>[] => [
  { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: null, privilege: null },
  { owner: M005_PRINCIPAL, objtype: 'f', scope: 'public', grantee: null, privilege: null },
];

/** A catalog in which every migration-005 postcondition holds. */
const M005_APPLIED: CatalogReadPort = {
  query: async (text: string, params: readonly unknown[]) => {
    if (text.includes('as principal')) return [{ principal: M005_PRINCIPAL }];
    if (text.includes('pg_default_acl')) return CLEAN_DEFAULT_ACL();
    if (text.includes('has_database_privilege')) return [{ c: false, t: false }];
    if (text.includes('shobj_description')) {
      const role = String(params[0]);
      return [{
        canlogin: false, super: false, createdb: false, createrole: false, repl: false, bypass: false,
        marker: role === 'tmpos_app'
          ? 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:tenant-runtime'
          : 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:audit-append',
      }];
    }
    if (text.includes('relrowsecurity')) return [{ rls: true }];
    if (text.includes('pg_get_constraintdef')) {
      return [{
        contype: 'c', convalidated: true,
        def: "CHECK (scope_type = ANY (ARRAY['platform','none']) AND tenant_id IS NULL AND store_id IS NULL)",
      }];
    }
    if (text.includes('pg_policies')) {
      const policy = String(params[2]);
      return [{
        cmd: policy === 'tmpos_audit_writer_append' ? 'INSERT' : 'ALL',
        roles: policy === 'tmpos_audit_writer_append' ? 'tmpos_audit_writer' : 'tmpos_app',
      }];
    }
    if (text.includes('has_table_privilege')) {
      const [role, rel, priv] = [String(params[0]), String(params[1]), String(params[2])];
      const yes = (role === 'tmpos_app' && (
        (rel.endsWith('.tenant') && priv === 'SELECT')
        || (rel.endsWith('.store') && (priv === 'SELECT' || priv === 'INSERT'))
        || (rel.endsWith('.user_membership') && priv === 'SELECT')
        || (rel.endsWith('.tenant_feature_entitlement') && priv === 'SELECT')))
        || (role === 'tmpos_audit_writer' && rel.endsWith('.audit_event') && priv === 'INSERT');
      return [{ ok: yes }];
    }
    if (text.includes('has_column_privilege')) {
      const col = String(params[2]);
      return [{ ok: col === 'display_name' || col === 'legal_name' || col === 'store_name' }];
    }
    if (text.includes('has_schema_privilege')) {
      // Two DIFFERENT schema probes now share this keyword; discriminate on the alias the caller
      // actually asked for, or the writer probe silently receives the tenant runtime's answer.
      return text.includes('usage_writer')
        ? [{ usage_writer: true, create_writer: false }]
        : [{ usage_app: true, create_app: false, create_public: false }];
    }
    return [];
  },
};

test('C2B-M005-B0-R2: 005 postconditions pass on a database where 005 applied AND a prior global functions override already exists', async () => {
  assert.deepEqual(await verify005Postconditions(M005_APPLIED), []);
});

test('C2B-M005-B0: each 005 postcondition fails on its own', async () => {
  const bend = (
    over: (text: string, params: readonly unknown[]) => Record<string, unknown>[] | null,
  ): CatalogReadPort => ({
    query: async (text, params) => over(text, params) ?? await M005_APPLIED.query(text, params),
  });
  const cases: { label: string; port: CatalogReadPort; match: RegExp }[] = [
    {
      label: 'role absent',
      port: bend((t) => (t.includes('shobj_description') ? [] : null)),
      match: /privilege role tmpos_app absent/,
    },
    {
      label: 'role marker missing',
      port: bend((t) => (t.includes('shobj_description')
        ? [{ canlogin: false, super: false, createdb: false, createrole: false, repl: false, bypass: false, marker: 'someone else' }]
        : null)),
      match: /does not carry the 005 ownership marker/,
    },
    {
      label: 'role elevated',
      port: bend((t, p) => (t.includes('shobj_description')
        ? [{
          canlogin: true, super: false, createdb: false, createrole: false, repl: false, bypass: false,
          marker: String(p[0]) === 'tmpos_app'
            ? 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:tenant-runtime'
            : 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:audit-append',
        }]
        : null)),
      match: /carries attributes 005 never grants/,
    },
    {
      label: 'audit constraint absent',
      port: bend((t) => (t.includes('pg_get_constraintdef') ? [] : null)),
      match: /audit_event_scope_consistency_chk absent/,
    },
    {
      label: 'policy absent',
      port: bend((t) => (t.includes('pg_policies') ? [] : null)),
      match: /policy tmpos_app_tenant_scope on tenant absent/,
    },
    {
      label: 'row security disabled',
      port: bend((t) => (t.includes('relrowsecurity') ? [{ rls: false }] : null)),
      match: /does not enforce row-level security/,
    },
    {
      label: 'same-name policy that opens what 005 closes',
      port: bend((t) => (t.includes('pg_policies') ? [{ cmd: 'ALL', roles: 'public' }] : null)),
      match: /is not bound to tmpos_app alone/,
    },
    {
      label: 'audit constraint that constrains nothing',
      port: bend((t) => (t.includes('pg_get_constraintdef')
        ? [{ contype: 'c', convalidated: true, def: 'CHECK (true)' }] : null)),
      match: /does not constrain scope_type/,
    },
    {
      label: 'grant missing',
      port: bend((t) => (t.includes('has_table_privilege') ? [{ ok: false }] : null)),
      match: /is not the 005 posture/,
    },
    {
      label: 'delete granted',
      port: bend((t) => (t.includes('has_table_privilege') ? [{ ok: true }] : null)),
      match: /DELETE on tenant is not the 005 posture/,
    },
    {
      label: 'status column writable',
      port: bend((t) => (t.includes('has_column_privilege') ? [{ ok: true }] : null)),
      match: /UPDATE on tenant\.status is not the 005 posture/,
    },
    {
      label: 'PUBLIC still holds CREATE on the schema',
      port: bend((t) => (t.includes('has_schema_privilege')
        ? [{ usage_app: true, create_app: false, create_public: true }] : null)),
      match: /PUBLIC still holds CREATE/,
    },
  ];
  for (const c of cases) {
    const failed = await verify005Postconditions(c.port);
    assert.ok(failed.some((f) => c.match.test(f)), `${c.label}: ${failed.join(' | ')}`);
  }
});

test('C2B-M005-B0: post-commit verification passes only on a clean, governed, complete ledger', async () => {
  const w = await m005World({ rows: [{ version: M005_VERSION, checksum: M005_UP_SHA256, dirty: false }] });
  const policy = createM005PostCommitPolicy({ ledger: w.ledger, catalog: M005_APPLIED, fsPort: fakeFs(w.files) });
  assert.equal(await policy({ session: {} as unknown as ExecutorSession, executionPlan: [] }), null);
});

test('C2B-M005-B0: a COMMIT/read-back disagreement is refused in every shape', async () => {
  const files = await realM005Files();
  const cases: { label: string; rows: LedgerRow[]; code: string }[] = [
    { label: 'row absent', rows: [], code: EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH },
    {
      label: 'checksum differs',
      rows: [{ version: M005_VERSION, checksum: 'f'.repeat(64), dirty: false }],
      code: EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH,
    },
    {
      label: 'still dirty',
      rows: [{ version: M005_VERSION, checksum: M005_UP_SHA256, dirty: true }],
      code: EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH,
    },
  ];
  for (const c of cases) {
    const w = await m005World({ files, rows: c.rows });
    const policy = createM005PostCommitPolicy({ ledger: w.ledger, catalog: M005_APPLIED, fsPort: fakeFs(files) });
    assert.equal(
      await policy({ session: {} as unknown as ExecutorSession, executionPlan: [] }),
      c.code,
      c.label,
    );
  }
});

test('C2B-M005-B0: a committed ledger whose 005 objects are ABSENT is refused, not reported as applied', async () => {
  // The interesting failure: the ledger claims an applied migration whose catalog objects are not
  // there. Reporting that as success is precisely what the ledger's inability to distinguish
  // adopted from executed makes hard to notice later.
  const w = await m005World({ rows: [{ version: M005_VERSION, checksum: M005_UP_SHA256, dirty: false }] });
  const empty: CatalogReadPort = { query: async () => [] };
  const policy = createM005PostCommitPolicy({ ledger: w.ledger, catalog: empty, fsPort: fakeFs(w.files) });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: [] }),
    EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
  );
});

test('C2B-M005-B0: an unexpected additional pending migration after commit is refused', async () => {
  const files = await realM005Files();
  const withSix = {
    ...files,
    '006_later.up.sql': '-- transaction: required\nselect 1;\n',
    '006_later.down.sql': '-- transaction: required\nselect 1;\n',
  };
  const w = await m005World({ files: withSix, rows: [{ version: M005_VERSION, checksum: M005_UP_SHA256, dirty: false }] });
  const policy = createM005PostCommitPolicy({ ledger: w.ledger, catalog: M005_APPLIED, fsPort: fakeFs(withSix) });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: [] }),
    EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH,
  );
});

// ---------------------------------------------------------------------------
// COMMIT evidence + advisory-lock release matrix (§9, §10)
// ---------------------------------------------------------------------------

test('C2B-M005-B0: the shape check addresses the ledger relation by name, not by luck', async () => {
  // The fake now binds on parameters, so a check repointed at another relation reports ABSENT
  // rather than silently passing on the right relation's answers.
  const elsewhere: CatalogReadPort = {
    query: async (text, params) => fakeLedgerCatalog({ relkind: 'r' }).query(text, ['other', 'other']),
  };
  const r = await verifyLedgerShape(elsewhere);
  assert.equal(r.present, false);
});

test('C2B-M005-B0: toLedgerRowStrict refuses a malformed version or checksum, not just dirty', () => {
  // `String(null)` is the literal 'null', and the prologue ledger read runs BEFORE the lock and
  // before any shape check — the unshaped relation this function exists for.
  for (const raw of [
    { version: null, checksum: 'abc', dirty: false },
    { version: '005', checksum: null, dirty: false },
    { version: 5, checksum: 'abc', dirty: false },
  ]) {
    assert.equal(
      codeOf(() => toLedgerRowStrict(raw as Record<string, unknown>)),
      EXECUTOR_CODES.LEDGER_DIRTY_STATE_INVALID,
      JSON.stringify(raw),
    );
  }
});

// ---------------------------------------------------------------------------
// the operator verdict, as behaviour rather than as a source regex
// ---------------------------------------------------------------------------

const EV = (over: Partial<Parameters<typeof classifyManagedApplyRefusal>[1]> = {}) => ({
  outcome: 'complete' as const,
  code: null,
  commit: { submitted: true, resolved: true, acknowledged: 'unavailable' as const, readBackVerified: true },
  lockRelease: 'verified' as const,
  // C2B-M005-B1-R1 — the fully evidenced shape now includes the pre-commit gate having approved
  // and an ESTABLISHED disposal; both are required fields, so neither can be silently omitted.
  preCommitVerified: true,
  disposal: 'terminated' as const,
  // C2B-M005-B1-R3 — also required, so the durable ledger consequence cannot be omitted. The
  // fully evidenced shape is the one whose marker was verified clean by the durable read-back.
  ledgerMarker: 'clean_verified' as const,
  teardown: { completed: true, code: null },
  ...over,
});

test('C2B-M005-B0: a fully evidenced apply is the ONLY shape that produces no refusal', () => {
  assert.equal(classifyManagedApplyRefusal('apply(up)', EV()), null);
});

test('C2B-M005-B0: an UNKNOWN commit outranks every other verdict — ordering, not just presence', () => {
  // THE DEFECT THIS PINS. Reordering the branches so a plain failure is tested first renders an
  // undetermined COMMIT as "did not complete", which reads as "nothing happened" — the exact
  // wording that invites the re-run this path must never permit. A source regex cannot see order.
  const undetermined = EV({
    outcome: 'failed', code: ENGINE_CODES.PORT_OPERATION_FAILED,
    commit: { submitted: true, resolved: false, acknowledged: 'unavailable', readBackVerified: false },
  });
  const v = classifyManagedApplyRefusal('apply(up)', undetermined);
  assert.match(String(v), /COMMIT OUTCOME IS UNKNOWN/);
  assert.match(String(v), /Do NOT re-run\. Do NOT compensate\./);
  assert.ok(!String(v).startsWith('apply(up) did not complete'), 'the unknown branch must win');
});

test('C2B-M005-B0: an incomplete run and an unverified read-back each refuse on their own', () => {
  assert.match(
    String(classifyManagedApplyRefusal('apply(up)', EV({ outcome: 'failed', code: 'some_code' }))),
    /did not complete: some_code/,
  );
  assert.match(
    String(classifyManagedApplyRefusal('apply(up)', EV({
      commit: { submitted: true, resolved: true, acknowledged: 'unavailable', readBackVerified: false },
    }))),
    /without a post-commit read-back verification/,
  );
});

test('C2B-M005-B0: lock and teardown residuals are APPENDED, never substituted for the primary', () => {
  const both = classifyManagedApplyRefusal('apply(up)', EV({
    outcome: 'failed', code: 'primary_code',
    lockRelease: 'unverified',
    teardown: { completed: false, code: EXECUTOR_CODES.CLIENT_TEARDOWN_FAILED },
  }));
  // The primary failure must SURVIVE both appends: an operator who loses it is told about the
  // residuals and not about what actually went wrong.
  assert.match(String(both), /did not complete: primary_code/);
  assert.match(String(both), /advisory-lock release is UNVERIFIED/);
  assert.match(String(both), /client teardown NOT ESTABLISHED/);
});

test('C2B-M005-B0: a residual alone refuses a run that was otherwise clean', () => {
  assert.match(String(classifyManagedApplyRefusal('apply(up)', EV({ lockRelease: 'unverified' }))), /UNVERIFIED/);
  assert.match(
    String(classifyManagedApplyRefusal('apply(up)', EV({ teardown: { completed: false, code: null } }))),
    /teardown NOT ESTABLISHED/,
  );
  // `not_acquired` is NOT a residual: nothing was held, so there is nothing to give back.
  assert.equal(classifyManagedApplyRefusal('apply(up)', EV({ lockRelease: 'not_acquired' })), null);
});

test('C2B-M005-B0: the four commit-evidence fields are distinct and outcome is derived', () => {
  const base = { submitted: false, resolved: false, acknowledged: 'unavailable' as const, readBackVerified: false };
  assert.equal(applyCommitOutcome(base), 'not_submitted');
  assert.equal(applyCommitOutcome({ ...base, submitted: true }), 'unknown');
  assert.equal(applyCommitOutcome({ ...base, submitted: true, resolved: true }), 'resolved');
  // UNKNOWN IS ABSORBING: a read-back that never ran cannot narrow it back, and a resolved promise
  // is never relabelled "acknowledged" — the driver exposes no such signal on this path.
  assert.equal(applyCommitOutcome({ ...base, submitted: true, readBackVerified: true }), 'unknown');
});

test('C2B-M005-B0: a successful apply records submitted, resolved and a verified unlock', async () => {
  const { deps } = fakeDeps(ONE, []);
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete');
  assert.equal(report.commit.submitted, true);
  assert.equal(report.commit.resolved, true);
  assert.equal(report.commit.acknowledged, 'unavailable');
  assert.equal(applyCommitOutcome(report.commit), 'resolved');
  assert.equal(report.lockRelease, 'verified');
});

test('C2B-M005-B0: a COMMIT that never resolves is UNKNOWN, never "did not commit"', async () => {
  const { deps } = fakeDeps(ONE, [], { behaviour: { commit_tx: 'throw' } });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  // Marked BEFORE the await, so a rejection after COMMIT reached the wire cannot be narrowed to
  // "not submitted" — the reading that would invite a re-run of a transaction that may have landed.
  assert.equal(report.commit.submitted, true);
  assert.equal(report.commit.resolved, false);
  assert.equal(applyCommitOutcome(report.commit), 'unknown');
});

test('C2B-M005-B0: a run that never reached COMMIT reports not_submitted', async () => {
  const { deps } = fakeDeps(ONE, [], { behaviour: { 'execute:tx:depth=1': 'throw' } });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  assert.equal(applyCommitOutcome(report.commit), 'not_submitted');
});

test('C2B-M005-B0: a lock that is never acquired is not_acquired, not an unverified release', async () => {
  const { deps } = fakeDeps(ONE, [], { lockAcquired: false });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  // A DISTINCT state: nothing was held, so there is no residual. Collapsing it into `unverified`
  // would make every contention failure look like a leaked lock.
  assert.equal(report.lockRelease, 'not_acquired');
});

test('C2B-M005-B0: a lock-release FAILURE is unverified and can never be a complete run', async () => {
  const { deps } = fakeDeps(ONE, [], { unlockReleased: false });
  const report = await runTrustedApply(deps);
  assert.equal(report.lockRelease, 'unverified');
  assert.notEqual(report.outcome, 'complete');
  assert.equal(report.code, ENGINE_CODES.RUN_UNLOCK_FAILED);
});

test('C2B-M005-B0: a post-lock failure attempts the COMPENSATING verified unlock', async () => {
  // Before this, `release_lock` was emitted on the SUCCESS path alone: every other post-acquisition
  // exit inferred release from session end, which the module's own comments call weaker than it
  // looks. The compensating call is what turns that inference into evidence.
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { 'insert_dirty:001': 'throw' } });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  assert.equal(report.lockRelease, 'verified');
  assert.ok(rec.ops.filter((o) => o === 'release_lock').length >= 1, rec.ops.join(','));
});

test('C2B-M005-B0: an UNKNOWN commit prohibits the compensating unlock — no unsafe follow-up query', async () => {
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { commit_tx: 'throw' } });
  const report = await runTrustedApply(deps);
  assert.equal(applyCommitOutcome(report.commit), 'unknown');
  // The transaction's fate is undetermined; another query on that session is exactly the unsafe
  // follow-up that could resolve it by accident. The release stays unverified and nothing is retried.
  assert.equal(report.lockRelease, 'unverified');
  assert.equal(rec.ops.filter((o) => o === 'release_lock').length, 0, rec.ops.join(','));
});

test('C2B-M005-B0: a TIMEOUT prohibits the compensating unlock — a statement may still be in flight', async () => {
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { 'insert_dirty:001': 'hang' } });
  const report = await runTrustedApply({ ...deps, deadlineMs: 40 });
  assert.equal(report.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT);
  assert.equal(report.lockRelease, 'unverified');
  assert.equal(rec.ops.filter((o) => o === 'release_lock').length, 0, rec.ops.join(','));
});

test('C2B-M005-B0: a POLICY REFUSAL under the lock still classifies the lock it holds', async () => {
  // THE CONTROL-FLOW DEFECT THIS PINS. The authorization block `break`s on refusal, so with the
  // lock ledger recorded after it the single most likely post-acquisition failure reported
  // `not_acquired` for a lock that was genuinely held — and no compensating unlock was attempted.
  const { deps, rec } = fakeDeps(ONE, []);
  const report = await runTrustedApply({
    ...deps,
    executionPolicy: async () => EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED,
  });
  assert.notEqual(report.outcome, 'complete');
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_PLAN_REJECTED);
  assert.equal(report.lockRelease, 'verified', 'the held lock must be classified and compensated');
  assert.ok(rec.ops.includes('release_lock'), rec.ops.join(','));
});

test('C2B-M005-B0: a LATER commit that rejects is not masked by an earlier one that resolved', async () => {
  // `buildProgram` emits one commit_tx per tx-scoped migration. Latching `resolved` from the first
  // made a rejected second commit report `resolved` — and opened the compensating unlock's
  // `!== 'unknown'` guard on a session whose commit outcome was genuinely undetermined.
  const { deps, rec } = fakeDeps(TWO, [], { commitFailAt: 2 });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete');
  assert.equal(report.commit.submitted, true);
  assert.equal(report.commit.resolved, false, 'the SECOND commit did not resolve');
  assert.equal(applyCommitOutcome(report.commit), 'unknown');
  // ...and the unknown outcome must then forbid the follow-up query on that session.
  assert.equal(report.lockRelease, 'unverified');
  assert.equal(rec.ops.filter((o) => o === 'release_lock').length, 0, rec.ops.join(','));
});

test('C2B-M005-B0: post-commit verification runs after the LAST commit, not the first', async () => {
  // Latching on the first commit made `readBackVerified` describe an intermediate database state,
  // and that flag then survived into a report whose later migration failed.
  const seen: number[] = [];
  const { deps } = fakeDeps(TWO, [], { commitFailAt: 2 });
  const failed = await runTrustedApply({
    ...deps,
    postCommitPolicy: async () => { seen.push(1); return null; },
  });
  assert.notEqual(failed.outcome, 'complete');
  assert.equal(seen.length, 0, 'no verification may run while a later commit is still to come');
  assert.equal(failed.commit.readBackVerified, false);

  const { deps: ok } = fakeDeps(TWO, []);
  const good = await runTrustedApply({ ...ok, postCommitPolicy: async () => { seen.push(2); return null; } });
  assert.equal(good.outcome, 'complete');
  assert.equal(seen.filter((x) => x === 2).length, 1, 'exactly once, after the last commit');
  assert.equal(good.commit.readBackVerified, true);
});

test('C2B-M005-B0: a post-commit policy refusal turns a would-be complete run into a failure', async () => {
  const { deps } = fakeDeps(ONE, []);
  const report = await runTrustedApply({
    ...deps,
    postCommitPolicy: async () => EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH,
  });
  assert.notEqual(report.outcome, 'complete');
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH);
  assert.equal(report.commit.readBackVerified, false);
});

test('C2B-M005-B0: a post-commit policy that throws or hangs is a refusal, never a verification', async () => {
  for (const policy of [
    async () => { throw new Error('boom pw=hunter2'); },
    async () => new Promise<string | null>(() => {}),
  ]) {
    const { deps } = fakeDeps(ONE, []);
    const report = await runTrustedApply({ ...deps, deadlineMs: 40, postCommitPolicy: policy });
    assert.notEqual(report.outcome, 'complete');
    assert.equal(report.commit.readBackVerified, false);
    assert.ok(!JSON.stringify(report).includes('hunter2'));
  }
});

test('C2B-M005-B0: an approving post-commit policy records the read-back and runs exactly once', async () => {
  let calls = 0;
  const { deps } = fakeDeps(ONE, []);
  const report = await runTrustedApply({
    ...deps,
    postCommitPolicy: async () => { calls += 1; return null; },
  });
  assert.equal(report.outcome, 'complete');
  assert.equal(report.commit.readBackVerified, true);
  assert.equal(calls, 1);
});

test('C2B-M005-B0: with no post-commit policy the read-back flag stays false — absence is not proof', async () => {
  const { deps } = fakeDeps(ONE, []);
  const report = await runTrustedApply(deps);
  assert.equal(report.outcome, 'complete');
  assert.equal(report.commit.readBackVerified, false);
});

// ---------------------------------------------------------------------------
// C2B-M005-B0-R1 §5/§6 — future-object (default) privileges and database capabilities
//
// These are the two postconditions the structural checks above cannot express. Everything the
// structural checks ask is about objects that already exist; these ask what the database will do
// to objects that do not exist yet, and whether the two roles can create anything at all.
// ---------------------------------------------------------------------------

/** One default-ACL row, spelled the way the catalog projection spells it. */
const acl = (o: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  owner: M005_PRINCIPAL, objtype: 'f', scope: 'public', grantee: null, privilege: null, ...o,
});

test('C2B-M005-B0-R1: the three object classes are exactly the ones migration 005 alters', () => {
  assert.deepEqual(
    M005_DEFAULT_ACL_CLASSES.map((c) => [c.objtype, c.label, c.builtinGrantsPublic]),
    [['r', 'tables', false], ['S', 'sequences', false], ['f', 'functions', true]],
  );
});

test("C2B-M005-B0-R1: with no catalog row at all, only FUNCTIONS fails — PostgreSQL's built-in default", () => {
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, []);
  // The built-in default grants PUBLIC EXECUTE on functions and nothing on tables or sequences, so
  // "no row" is the CLOSED posture for two classes and the OPEN one for the third. A verifier that
  // read absence as clean across the board would pass exactly what the FUNCTIONS statement exists
  // to prevent, which is why this asserts both halves rather than only the failure.
  assert.equal(failed.length, 1);
  assert.match(failed[0], /future functions retain PostgreSQL's built-in grant to PUBLIC/);
  assert.ok(!failed.some((f) => /tables|sequences/.test(f)));
});

/**
 * THE FUNCTIONS DEFAULT-PRIVILEGE MATRIX, stated as the merge rule rather than as row presence.
 *
 * PostgreSQL composes the initial ACL of a new object from a BASE and an ADDITION: the base is the
 * global default-ACL row for that (role, object class) when one exists and the hard-wired
 * `acldefault()` when it does not, and the per-schema row is merged on top of it. The per-schema
 * row can only ADD. Every line below is that single rule applied.
 *
 * The R1 predecessor of this test asserted that "a clean row in EITHER scope closes the functions
 * class". That was wrong in the schema half, and it is the reason lines 2 and 3 exist: a per-schema
 * row cannot subtract the hard-wired EXECUTE that `acldefault()` grants PUBLIC, so neither an
 * unrelated-role grant nor an empty ACL in that scope closes anything.
 */
const FUNCTION_DEFAULT_MATRIX: {
  label: string; rows: Record<string, unknown>[]; refuses: boolean; because?: RegExp;
}[] = [
  {
    label: 'neither a global nor a schema row: the hard-wired EXECUTE to PUBLIC still applies',
    rows: [],
    refuses: true,
    because: /retain PostgreSQL's built-in grant to PUBLIC/,
  },
  {
    label: 'no global row, schema row granting EXECUTE to an unrelated role: the base is still hard-wired',
    rows: [acl({ grantee: 'reporting_svc', privilege: 'EXECUTE' })],
    refuses: true,
    because: /retain PostgreSQL's built-in grant to PUBLIC/,
  },
  {
    label: 'no global row, explicitly empty schema ACL: an empty ADDITION subtracts nothing',
    rows: [acl({ scope: 'public' })],
    refuses: true,
    because: /retain PostgreSQL's built-in grant to PUBLIC/,
  },
  {
    label: 'clean global override, no schema row: the base itself no longer grants PUBLIC',
    rows: [acl({ scope: '' })],
    refuses: false,
  },
  {
    label: 'clean global override plus a harmless schema addition to an unrelated role',
    rows: [acl({ scope: '' }), acl({ grantee: 'reporting_svc', privilege: 'EXECUTE' })],
    refuses: false,
  },
  {
    label: 'global row still granting PUBLIC EXECUTE, clean schema row: the schema row cannot subtract',
    rows: [acl({ scope: '', grantee: 'public', privilege: 'EXECUTE' }), acl({ scope: 'public' })],
    refuses: true,
    because: /future functions would still grant EXECUTE to public \(global default privileges\)/,
  },
  {
    label: 'clean global override, schema row granting PUBLIC EXECUTE: the addition reopens it',
    rows: [acl({ scope: '' }), acl({ grantee: 'public', privilege: 'EXECUTE' })],
    refuses: true,
    because: /future functions would still grant EXECUTE to public \(public default privileges\)/,
  },
  {
    label: 'a forbidden anon grant in the GLOBAL scope',
    rows: [acl({ scope: '', grantee: 'anon', privilege: 'EXECUTE' })],
    refuses: true,
    because: /future functions would still grant EXECUTE to anon \(global default privileges\)/,
  },
  {
    label: 'a forbidden authenticated grant in the SCHEMA scope, over a clean global override',
    rows: [acl({ scope: '' }), acl({ grantee: 'authenticated', privilege: 'EXECUTE' })],
    refuses: true,
    because: /future functions would still grant EXECUTE to authenticated \(public default privileges\)/,
  },
  {
    // `pg_get_userbyid` returns the role name as stored, and the PUBLIC pseudo-role is projected by
    // this query's own CASE arm. A grantee comparison that were case-sensitive would let a catalog
    // spelling of `PUBLIC` walk past the forbidden-grantee list unnoticed.
    label: 'a PUBLIC grant spelled in upper case is still a PUBLIC grant',
    rows: [acl({ scope: '' }), acl({ grantee: 'PUBLIC', privilege: 'EXECUTE' })],
    refuses: true,
    because: /future functions would still grant EXECUTE to public \(public default privileges\)/,
  },
];

test('C2B-M005-B0-R2: only a GLOBAL row replaces the hard-wired functions default; a schema row is merely added to it', () => {
  for (const c of FUNCTION_DEFAULT_MATRIX) {
    const failed = classifyDefaultPrivileges(M005_PRINCIPAL, c.rows);
    if (!c.refuses) { assert.deepEqual(failed, [], c.label); continue; }
    // EXACT COUNT, not `> 0`: every refusing row is built to produce exactly one finding, so a
    // mutation that adds a spurious second finding alongside the right one is caught here too.
    assert.equal(failed.length, 1, `${c.label}: ${failed.join(' | ')}`);
    assert.ok(failed.some((f) => (c.because as RegExp).test(f)), `${c.label}: ${failed.join(' | ')}`);
  }
});

test('C2B-M005-B0-R2: no global row, an explicitly empty global ACL and unreadable evidence are three different answers', () => {
  // (a) NO GLOBAL ROW. The hard-wired base applies and the class stays open, whatever the schema
  // row says — this is the case the R1 classifier passed.
  assert.deepEqual(classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: 'public' })]), [
    "future functions retain PostgreSQL's built-in grant to PUBLIC: no GLOBAL default-privilege row "
      + 'for the executing principal replaces it, and a per-schema row is added to the built-in '
      + 'default rather than substituted for it',
  ]);
  // (b) A VALID, EXPLICITLY EMPTY GLOBAL ACL. `aclexplode` returns no rows over an empty ACL and
  // the LEFT JOIN LATERAL keeps the catalog row with a NULL grantee, so this is presence WITHOUT a
  // grant: the base exists and grants PUBLIC nothing. Clean.
  assert.deepEqual(classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: '', grantee: null, privilege: null })]), []);
  // (c) UNREADABLE EVIDENCE is neither of those. It is its own failure and never credits a class.
  const malformed = classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: null })]);
  assert.equal(malformed.length, 2, malformed.join(' | '));
  assert.ok(malformed.some((f) => /has no readable scope/.test(f)), malformed.join(' | '));
  assert.ok(malformed.some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f)), malformed.join(' | '));
});

test('C2B-M005-B0-R2: a GLOBAL row owned by another role does not replace this principal\'s base', () => {
  // The owner test is what makes the global-row rule mean anything. `supabase_admin` revoking its
  // own future-function grants changes nothing about the objects THIS principal creates, so a
  // foreign global row must be refused AND must not be credited as closing the class.
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ owner: 'supabase_admin', scope: '' })]);
  assert.equal(failed.length, 2, failed.join(' | '));
  assert.ok(failed.some((f) => /belongs to a role other than the executing principal/.test(f)), failed.join(' | '));
  assert.ok(failed.some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f)), failed.join(' | '));
});

/**
 * THE ACL-PROJECTION VALUE MATRIX.
 *
 * The catalog statement projects exactly two shapes: both fields SQL NULL (the LEFT JOIN LATERAL
 * null-extending a row whose ACL is empty) or both fields non-empty text. Every other pair is
 * evidence the classifier cannot read, and the R2 implementation collapsed all of them onto the
 * empty string BEFORE deciding, so each one was credited as a valid empty GLOBAL override and
 * closed the functions class. `credited` below is what the row is allowed to do to the class.
 */
const ACL_PROJECTION_MATRIX: { label: string; fields: Record<string, unknown>; credited: boolean }[] = [
  { label: 'both properties absent',                 fields: {},                                          credited: false },
  { label: 'both explicitly undefined',              fields: { grantee: undefined, privilege: undefined }, credited: false },
  { label: 'both numeric',                           fields: { grantee: 0, privilege: 1 },                 credited: false },
  { label: 'both boolean',                           fields: { grantee: false, privilege: true },          credited: false },
  { label: 'both empty strings',                     fields: { grantee: '', privilege: '' },               credited: false },
  { label: 'grantee null, privilege numeric',        fields: { grantee: null, privilege: 42 },             credited: false },
  { label: 'grantee array, privilege null',          fields: { grantee: ['public'], privilege: null },     credited: false },
  { label: 'grantee object, privilege null',         fields: { grantee: { r: 'public' }, privilege: null }, credited: false },
  { label: 'grantee string, privilege null',         fields: { grantee: 'public', privilege: null },       credited: false },
  { label: 'grantee null, privilege string',         fields: { grantee: null, privilege: 'EXECUTE' },      credited: false },
  { label: 'grantee empty string, privilege string', fields: { grantee: '', privilege: 'EXECUTE' },        credited: false },
  { label: 'grantee string, privilege empty string', fields: { grantee: 'public', privilege: '' },         credited: false },
  // The two legitimate projections.
  { label: 'explicit null / null — a valid empty global ACL', fields: { grantee: null, privilege: null },  credited: true },
  { label: 'a real aclitem for an unrelated role',   fields: { grantee: 'reporting_svc', privilege: 'EXECUTE' }, credited: true },
];

test('C2B-M005-B0-R3: an unreadable ACL projection is refused and never credited as an empty global ACL', () => {
  for (const c of ACL_PROJECTION_MATRIX) {
    // A correctly owned GLOBAL functions row. Only the ACL projection varies, so the ONLY thing
    // that can decide the verdict is the pair of projected fields.
    const row: Record<string, unknown> = { owner: M005_PRINCIPAL, objtype: 'f', scope: '', ...c.fields };
    const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [row]);
    if (c.credited) {
      assert.deepEqual(failed, [], c.label);
      continue;
    }
    assert.equal(failed.length, 2, `${c.label}: ${failed.join(' | ')}`);
    assert.ok(failed.some((f) => /has an unreadable ACL projection/.test(f)), `${c.label}: ${failed.join(' | ')}`);
    // NOT CREDITED is the half that matters: an unreadable row must leave the class reported open.
    assert.ok(
      failed.some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f)),
      `${c.label} was credited as closing the functions class: ${failed.join(' | ')}`,
    );
  }
});

test('C2B-M005-B0-R3: an inherited grantee/privilege pair is not evidence about the row', () => {
  // OWN PROPERTIES ONLY. A row projected by the catalog statement carries its fields as its own; a
  // value reached through the prototype chain says nothing about THIS row. Both shapes must be
  // refused and neither may close the class — including the string pair, which passes a bare
  // `typeof` test and would otherwise be credited as a genuine aclitem.
  const shapes: [string, object][] = [
    ['inherited null / null', { grantee: null, privilege: null }],
    ['inherited string / string', { grantee: 'reporting_svc', privilege: 'EXECUTE' }],
    ['inherited PUBLIC grant', { grantee: 'public', privilege: 'EXECUTE' }],
  ];
  for (const [label, proto] of shapes) {
    const row = Object.assign(Object.create(proto), { owner: M005_PRINCIPAL, objtype: 'f', scope: '' });
    const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [row as Record<string, unknown>]);
    assert.equal(failed.length, 2, `${label}: ${failed.join(' | ')}`);
    assert.ok(failed.some((f) => /has an unreadable ACL projection/.test(f)), `${label}: ${failed.join(' | ')}`);
    assert.ok(
      failed.some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f)),
      `${label} was credited as closing the functions class: ${failed.join(' | ')}`,
    );
  }
});

test('C2B-M005-B0-R3: the rejected value is never interpolated into the failure label', () => {
  // A bounded label only. Echoing the raw value would put catalog content the classifier could not
  // even parse into operator-visible output.
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [
    { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: 'sekrit-role-name', privilege: 7 },
  ]);
  assert.ok(failed.some((f) => /has an unreadable ACL projection/.test(f)), failed.join(' | '));
  assert.ok(!failed.some((f) => /sekrit-role-name|7/.test(f)), failed.join(' | '));
});

test('C2B-M005-B0-R3: the grantee case fold over-refuses rather than under-refuses', () => {
  // A role whose quoted name is `PUBLIC` is a different identity from the PUBLIC pseudo-role, and
  // the case fold conflates the two. That is recorded here as a deliberate choice, not an
  // oversight: the conflation costs a false refusal, while comparing case-sensitively would let a
  // catalog spelling of the REAL pseudo-role escape the forbidden list — the direction that loses a
  // finding. Both halves are asserted so the trade-off cannot be reversed silently.
  const asPublic = classifyDefaultPrivileges(M005_PRINCIPAL, [
    { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: 'PUBLIC', privilege: 'EXECUTE' },
  ]);
  assert.deepEqual(asPublic, ['future functions would still grant EXECUTE to public (global default privileges)']);
  // And a role whose name merely CONTAINS a forbidden label is untouched — no substring matching,
  // no trimming, no pattern.
  for (const near of ['public_reader', 'anonymous', 'authenticated_svc', ' public']) {
    assert.deepEqual(
      classifyDefaultPrivileges(M005_PRINCIPAL, [
        { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: near, privilege: 'EXECUTE' },
      ]),
      [],
      near,
    );
  }
});

test('C2B-M005-B0-R3: a valid global row alongside a malformed applicable row still refuses', () => {
  // The clean global row would close the class on its own. The malformed row must not be absorbed
  // by it: a verifier that reported "clean" here would be reporting on evidence it could not read.
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [
    { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: null, privilege: null },
    { owner: M005_PRINCIPAL, objtype: 'f', scope: 'public', grantee: 12, privilege: false },
  ]);
  assert.deepEqual(failed, ['a default-privilege row has an unreadable ACL projection']);
});

test('C2B-M005-B0-R3: legitimate role names survive validation unchanged', () => {
  // No pattern check and no trimming: either would silently turn one role into another. Names with
  // spaces, dots, dashes and mixed case are all legal PostgreSQL identifiers.
  for (const name of ['reporting_svc', 'Report Service', 'svc.reader', 'a-b-c', 'ROLE_UPPER']) {
    assert.deepEqual(
      classifyDefaultPrivileges(M005_PRINCIPAL, [
        { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: name, privilege: 'EXECUTE' },
      ]),
      [],
      name,
    );
  }
  // And the forbidden grantees are still detected, in either applicable scope, in either case.
  for (const [scope, label] of [['', 'global'], ['public', 'public']] as const) {
    for (const g of ['public', 'PUBLIC', 'anon', 'authenticated']) {
      const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [
        { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: null, privilege: null },
        { owner: M005_PRINCIPAL, objtype: 'f', scope, grantee: g, privilege: 'EXECUTE' },
      ]);
      assert.ok(
        failed.some((f) => new RegExp(`grant EXECUTE to ${g.toLowerCase()} \\(${label} default privileges\\)`).test(f)),
        `${g} in ${label}: ${failed.join(' | ')}`,
      );
    }
  }
});

test('C2B-M005-B0-R2: an object class letter the catalog cannot produce is unreadable evidence, not an uninteresting row', () => {
  // `T` and `n` are the two classes migration 005 deliberately leaves alone; they are skipped in
  // silence and are already named in M005_UNCOVERED_DEFAULT_ACL_CLASSES.
  for (const t of M005_UNCOVERED_DEFAULT_ACL_CLASSES.map((c) => c.objtype)) {
    const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: '', objtype: t })]);
    assert.ok(!failed.some((f) => /unrecognized object class/.test(f)), `${t}: ${failed.join(' | ')}`);
  }
  // Any other letter is one pg_default_acl cannot hold. Dropping it without trace would discard
  // whatever grant it carried; it is refused instead.
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: '', objtype: 's', grantee: 'public', privilege: 'USAGE' })]);
  assert.ok(failed.some((f) => /unrecognized object class/.test(f)), failed.join(' | '));
  assert.ok(failed.some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f)), failed.join(' | '));
});

test('C2B-M005-B0-R2: a GLOBAL row for an unrelated class closes nothing for the classes 005 governs', () => {
  // Class isolation at the GLOBAL level, not only at the schema level: a global TYPES row is a real
  // catalog row for this principal, and it must not be mistaken for the functions base.
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: '', objtype: 'T' })]);
  assert.deepEqual(failed, [
    "future functions retain PostgreSQL's built-in grant to PUBLIC: no GLOBAL default-privilege row "
      + 'for the executing principal replaces it, and a per-schema row is added to the built-in '
      + 'default rather than substituted for it',
  ]);
});

test('C2B-M005-B0-R1: an applicable GLOBAL grant to PUBLIC fails even with no schema row', () => {
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [
    acl({ objtype: 'r', scope: '', grantee: 'public', privilege: 'SELECT' }),
    acl({ scope: '' }),
  ]);
  assert.equal(failed.length, 1, failed.join(' | '));
  assert.match(failed[0], /future tables would still grant SELECT to public \(global default privileges\)/);
});

test('C2B-M005-B0-R1: a per-schema revoke-like state does NOT negate an applicable global grant', () => {
  // THE WHOLE POINT OF READING BOTH SCOPES. PostgreSQL adds the per-schema default privileges to
  // the global ones; it does not let the narrower scope subtract from the wider one. A verifier
  // that saw the clean schema row and stopped would report this database as hardened.
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [
    acl({ objtype: 'r', scope: '', grantee: 'public', privilege: 'SELECT' }),
    acl({ objtype: 'r', scope: 'public' }),
    acl({ scope: '' }),
  ]);
  assert.equal(failed.length, 1, failed.join(' | '));
  assert.match(failed[0], /future tables would still grant SELECT to public \(global default privileges\)/);
});

test('C2B-M005-B0-R1: a PUBLIC grant owned by another role is a mismatch and is never credited', () => {
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [
    acl({ owner: 'supabase_admin', grantee: 'public', privilege: 'EXECUTE' }),
  ]);
  assert.ok(failed.some((f) => /belongs to a role other than the executing principal/.test(f)));
  // NOT CREDITED: another role's row cannot close this principal's functions class, so the
  // built-in grant is still reported open.
  assert.ok(failed.some((f) => /future functions retain/.test(f)));
});

test('C2B-M005-B0-R1: a row for another schema or another object class closes nothing', () => {
  for (const row of [acl({ scope: 'other_schema' }), acl({ objtype: 'T' }), acl({ objtype: 'n' })]) {
    const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [row]);
    assert.ok(failed.some((f) => /future functions retain/.test(f)), JSON.stringify(row));
  }
});

test('C2B-M005-B0-R1: one forbidden privilege among otherwise-clean privileges still fails', () => {
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [
    acl({ scope: '' }),
    acl({ grantee: M005_PRINCIPAL, privilege: 'EXECUTE' }),
    acl({ grantee: 'some_reporting_role', privilege: 'EXECUTE' }),
    acl({ grantee: 'authenticated', privilege: 'EXECUTE' }),
  ]);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /future functions would still grant EXECUTE to authenticated/);
});

test('C2B-M005-B0-R1: malformed, null and duplicate catalog results are refused, never coerced', () => {
  assert.deepEqual(classifyDefaultPrivileges(null, [acl({})]), ['the executing principal could not be read from the server']);
  assert.deepEqual(classifyDefaultPrivileges('', [acl({})]), ['the executing principal could not be read from the server']);
  const bad = classifyDefaultPrivileges(M005_PRINCIPAL, [
    null as unknown as Record<string, unknown>,
    acl({ owner: 7 }),
    acl({ scope: 42 }),
  ]);
  assert.ok(bad.some((f) => /a default-privilege row was unreadable/.test(f)));
  assert.ok(bad.some((f) => /has no readable owner/.test(f)));
  assert.ok(bad.some((f) => /has no readable scope/.test(f)));
  // Duplicates are set-like: two identical clean GLOBAL rows still close the class exactly once.
  assert.deepEqual(classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: '' }), acl({ scope: '' })]), []);
});

test('C2B-M005-B0-R1: the default-privilege read binds the principal and schema server-side', async () => {
  const seen: { text: string; params: readonly unknown[] }[] = [];
  const port: CatalogReadPort = {
    query: async (text, params) => { seen.push({ text, params }); return await M005_APPLIED.query(text, params); },
  };
  assert.deepEqual(await verifyDefaultPrivileges(port), []);
  const who = seen.find((q) => q.text.includes('as principal'));
  assert.ok(who !== undefined, 'the principal must be asked of the server');
  assert.deepEqual(who?.params, []);
  const read = seen.find((q) => q.text.includes('pg_default_acl'));
  assert.ok(read !== undefined);
  // Bound to the SERVER's current_user, never to a caller-supplied role name.
  assert.match(String(read?.text), /rolname = current_user/);
  assert.deepEqual(read?.params, ['public']);
  // BOTH scopes are read in one statement: global (namespace 0) and the public schema. Anchored to
  // the WHERE-clause disjunct, not to the bare text — `defaclnamespace = 0` also appears in the
  // SELECT list, and a loose match there is satisfied by a query that has stopped asking for the
  // global scope entirely. The behavioural proof is the scope-honouring catalog test below.
  assert.match(String(read?.text), /and \(d\.defaclnamespace = 0\s+or d\.defaclnamespace =/);
  assert.match(String(read?.text), /nspname = \$1/);
  // THE ALIAS PAIRING, not merely the presence of both expressions. Every fake below builds its own
  // rows, so nothing else notices if the SELECT list transposes `grantee` and `privilege` — the
  // classifier would keep working against fabricated data while the production query reported a
  // privilege name as a grantee.
  assert.match(String(read?.text), /case when a\.grantee = 0[\s\S]*?end\s+as grantee/);
  assert.match(String(read?.text), /a\.privilege_type::text\s+as privilege/);
  assert.match(String(read?.text), /pg_get_userbyid\(d\.defaclrole\)\s+as owner/);
  assert.match(String(read?.text), /d\.defaclobjtype::text\s+as objtype/);
  // Read-only: one SELECT, no DDL, no temporary object.
  for (const q of seen) assert.match(q.text.trimStart(), /^select/i);
});

test('C2B-M005-B0-R1: the two capability roles and PUBLIC must hold neither CREATE nor TEMPORARY', async () => {
  assert.deepEqual(M005_CAPABILITY_ROLES, ['tmpos_app', 'tmpos_audit_writer']);
  assert.deepEqual(await verifyCapabilityDatabasePrivileges(M005_APPLIED), []);

  // Each role, each privilege, on its own.
  for (const role of M005_CAPABILITY_ROLES) {
    for (const [field, priv] of [['c', 'CREATE'], ['t', 'TEMPORARY']] as const) {
      const port: CatalogReadPort = {
        query: async (text, params) => (
          text.includes('has_database_privilege') && String(params[0]) === role
            ? [{ c: false, t: false, [field]: true }]
            : await M005_APPLIED.query(text, params)
        ),
      };
      assert.deepEqual(await verifyCapabilityDatabasePrivileges(port), [`${role} holds ${priv} on the current database`]);
    }
  }

  // PUBLIC is reported on its OWN labels: the roles can be clean while the database is not.
  for (const [field, priv] of [['c', 'CREATE'], ['t', 'TEMPORARY']] as const) {
    const port: CatalogReadPort = {
      query: async (text, params) => (
        text.includes("has_database_privilege('public'")
          ? [{ c: false, t: false, [field]: true }]
          : await M005_APPLIED.query(text, params)
      ),
    };
    assert.deepEqual(await verifyCapabilityDatabasePrivileges(port), [`PUBLIC holds ${priv} on the current database`]);
  }
});

test('C2B-M005-B0-R1: the database identifier is server-derived and never caller-supplied', async () => {
  const seen: string[] = [];
  const port: CatalogReadPort = {
    query: async (text, params) => { seen.push(text); return await M005_APPLIED.query(text, params); },
  };
  await verifyCapabilityDatabasePrivileges(port);
  const probes = seen.filter((t) => t.includes('has_database_privilege'));
  assert.equal(probes.length, 3);
  for (const t of probes) {
    assert.match(t, /pg_catalog\.current_database\(\)/);
    // CREATE must be the `c` column and TEMPORARY the `t` column. Transposing them keeps every
    // fake answer valid and silently swaps which privilege each label describes.
    assert.match(t, /'CREATE'\)\s+as c/);
    assert.match(t, /'TEMPORARY'\)\s+as t/);
  }
});

test('C2B-M005-B0-R1: a missing row or a raising probe is missing evidence, never a pass', async () => {
  const empty: CatalogReadPort = {
    query: async (text, params) => (text.includes('has_database_privilege') ? [] : await M005_APPLIED.query(text, params)),
  };
  assert.deepEqual(await verifyCapabilityDatabasePrivileges(empty), [
    'tmpos_app database privileges could not be determined',
    'tmpos_audit_writer database privileges could not be determined',
    'PUBLIC database privileges could not be determined',
  ]);
  // A NULL is not `false`. `r.c !== false` is what makes an unrepresentable answer a failure.
  const nulls: CatalogReadPort = {
    query: async (text, params) => (text.includes('has_database_privilege') ? [{ c: null, t: null }] : await M005_APPLIED.query(text, params)),
  };
  assert.equal((await verifyCapabilityDatabasePrivileges(nulls)).length, 6);
  // A raising probe for ONE role must not discard the other role's finding.
  const raises: CatalogReadPort = {
    query: async (text, params) => {
      if (text.includes('has_database_privilege') && String(params[0]) === 'tmpos_app') throw new Error('role does not exist');
      return await M005_APPLIED.query(text, params);
    },
  };
  assert.deepEqual(await verifyCapabilityDatabasePrivileges(raises), ['tmpos_app database privileges could not be determined']);
});

test('C2B-M005-B0-R1: the post-commit policy fails on either new postcondition', async () => {
  const w = await m005World({ rows: [{ version: M005_VERSION, checksum: M005_UP_SHA256, dirty: false }] });
  const bend = (over: (t: string, p: readonly unknown[]) => Record<string, unknown>[] | null): CatalogReadPort => ({
    query: async (text, params) => over(text, params) ?? await M005_APPLIED.query(text, params),
  });
  const cases: { label: string; catalog: CatalogReadPort; want: string }[] = [
    {
      label: 'a global PUBLIC default grant survives',
      catalog: bend((t) => (t.includes('pg_default_acl')
        ? [...CLEAN_DEFAULT_ACL(), { owner: M005_PRINCIPAL, objtype: 'r', scope: '', grantee: 'public', privilege: 'SELECT' }]
        : null)),
      want: EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
    },
    {
      label: 'no default-privilege row closes the functions class',
      catalog: bend((t) => (t.includes('pg_default_acl') ? [] : null)),
      want: EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
    },
    {
      label: 'a capability role still holds TEMPORARY',
      catalog: bend((t, p) => (t.includes('has_database_privilege') && String(p[0]) === 'tmpos_app' ? [{ c: false, t: true }] : null)),
      want: EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
    },
    {
      label: 'PUBLIC still holds CREATE on the database',
      catalog: bend((t) => (t.includes("has_database_privilege('public'") ? [{ c: true, t: false }] : null)),
      want: EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
    },
    {
      label: 'the default-privilege read itself fails',
      catalog: bend((t) => { if (t.includes('pg_default_acl')) throw new Error('port down'); return null; }),
      want: ENGINE_CODES.PORT_OPERATION_FAILED,
    },
  ];
  for (const c of cases) {
    const policy = createM005PostCommitPolicy({ ledger: w.ledger, catalog: c.catalog, fsPort: fakeFs(w.files) });
    assert.equal(
      await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
      c.want,
      c.label,
    );
  }
});

test('C2B-M005-B0-R3: an unreadable ACL projection reaches the post-commit policy as a non-success code', async () => {
  // PROPAGATION, END TO END. The pure classifier's refusal is only useful if it survives the two
  // layers above it: the port wrapper must not swallow it, and the post-commit policy must turn it
  // into a bounded failure code rather than a success disposition.
  const malformed: CatalogReadPort = {
    query: async (text, params) => (text.includes('pg_default_acl')
      // A correctly owned GLOBAL functions row whose ACL projection cannot be read.
      ? [{ owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: 0, privilege: false }]
      : await M005_APPLIED.query(text, params)),
  };
  const failed = await verifyDefaultPrivileges(malformed);
  assert.equal(failed.length, 2, failed.join(' | '));
  assert.ok(failed.some((f) => /has an unreadable ACL projection/.test(f)), failed.join(' | '));
  assert.ok(failed.some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f)), failed.join(' | '));

  const w = await m005World({ rows: [{ version: M005_VERSION, checksum: M005_UP_SHA256, dirty: false }] });
  const policy = createM005PostCommitPolicy({ ledger: w.ledger, catalog: malformed, fsPort: fakeFs(w.files) });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
  );
});

test('C2B-M005-B0-R2: migration 005 ALONE cannot satisfy the functions postcondition — the refusal is about the migration, not the verifier', async () => {
  // THE HONEST CASE, stated as a test so it cannot be lost in prose. Migration 005's three
  // statements are all `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ...` with no FOR ROLE, and
  // the derivation test above re-reads the frozen SQL to prove exactly that. Of the three, only the
  // FUNCTIONS statement changes catalog state, and because it names a schema it writes a PER-SCHEMA
  // row. PostgreSQL merges a per-schema row ON TOP of the base and never substitutes it, so on a
  // database that has no pre-existing GLOBAL functions row for this principal, a CORRECT apply of
  // the unchanged migration still leaves PUBLIC holding the built-in EXECUTE.
  //
  // The verifier therefore refuses, and that refusal is TRUE. It is reported as a blocker against
  // the frozen migration; it is not evidence of a verifier defect, and it is not a claim about any
  // particular live database, whose global rows are not established here.
  const only005: CatalogReadPort = {
    query: async (text, params) => (text.includes('pg_default_acl')
      ? [{ owner: M005_PRINCIPAL, objtype: 'f', scope: 'public', grantee: null, privilege: null }]
      : await M005_APPLIED.query(text, params)),
  };
  const failed = await verifyDefaultPrivileges(only005);
  assert.deepEqual(failed, [
    "future functions retain PostgreSQL's built-in grant to PUBLIC: no GLOBAL default-privilege row "
      + 'for the executing principal replaces it, and a per-schema row is added to the built-in '
      + 'default rather than substituted for it',
  ]);
  // And the whole post-commit policy refuses with the bounded postcondition code, so no success
  // disposition can be reached from this state.
  const w2 = await m005World({ rows: [{ version: M005_VERSION, checksum: M005_UP_SHA256, dirty: false }] });
  const policy = createM005PostCommitPolicy({ ledger: w2.ledger, catalog: only005, fsPort: fakeFs(w2.files) });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
  );
});

test('C2B-M005-B0-R1: the new postconditions run only AFTER the ledger read-back', async () => {
  // ORDER IS PART OF THE CONTRACT. A finding about future privileges describes a database that
  // applied 005; issuing it against a ledger that never recorded a clean 005 would attach the
  // finding to the wrong claim. The proof is that neither probe is ever issued on that path.
  const seen: string[] = [];
  const catalog: CatalogReadPort = {
    query: async (text, params) => { seen.push(text); return await M005_APPLIED.query(text, params); },
  };
  const w = await m005World();
  const policy = createM005PostCommitPolicy({
    ledger: { ...w.ledger, readLedger: async () => [] },
    catalog,
    fsPort: fakeFs(w.files),
  });
  assert.equal(
    await policy({ session: {} as unknown as ExecutorSession, executionPlan: m005Plan(M005_UP_SHA256) }),
    EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH,
  );
  assert.ok(!seen.some((t) => t.includes('pg_default_acl')));
  assert.ok(!seen.some((t) => t.includes('has_database_privilege')));
});

test('C2B-M005-B0-R1: the verifier is DERIVED from migration 005, not guessed alongside it', async () => {
  // THE BINDING TEST. `M005_DEFAULT_ACL_CLASSES` and `M005_DEFAULT_ACL_GRANTEES` are compile-time
  // constants; without this they could drift from the migration silently and the postcondition
  // would go on passing while verifying the wrong thing. This reads the UNCHANGED SQL and rebuilds
  // both sets from it, so an edit to either side that is not matched by the other fails here.
  const sql = (await realM005Files())[M005_UP_BASENAME]
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const found = [...sql.matchAll(
    /alter\s+default\s+privileges\s+in\s+schema\s+(\w+)\s+revoke\s+all\s+on\s+(\w+)\s+from\s+([^;]+);/gi,
  )].map((m) => ({
    schema: m[1].toLowerCase(),
    objects: m[2].toLowerCase(),
    grantees: m[3].split(',').map((g) => g.trim().toLowerCase()).sort(),
  }));
  assert.equal(found.length, 3, 'migration 005 performs exactly three ALTER DEFAULT PRIVILEGES statements');
  for (const f of found) assert.equal(f.schema, 'public');
  assert.deepEqual(found.map((f) => f.objects).sort(), M005_DEFAULT_ACL_CLASSES.map((c) => c.label).sort());
  for (const f of found) assert.deepEqual(f.grantees, [...M005_DEFAULT_ACL_GRANTEES].sort());
  // No FOR ROLE clause anywhere: the effect is scoped to the role that runs the migration, which
  // is precisely why the claim is principal-scoped and not owner-independent.
  assert.ok(!/alter\s+default\s+privileges\s+for\s+role/i.test(sql));
});

/**
 * A default-ACL catalog that HONOURS the scope predicate the statement actually expresses.
 *
 * The other fakes answer by keyword and ignore the WHERE clause, which makes them blind to the one
 * mutation that matters most here: dropping the global-scope disjunct from the query. That edit
 * leaves the rest of the statement — including the `defaclnamespace = 0` test in the SELECT list —
 * intact, so a source-text assertion still matches while the verifier has silently stopped seeing
 * global rows. This port reproduces what PostgreSQL would do instead: a query that no longer asks
 * for the global scope no longer receives it.
 */
const scopeHonouringAclCatalog = (rows: Record<string, unknown>[]): CatalogReadPort => ({
  query: async (text, params) => {
    if (text.includes('as principal')) return [{ principal: M005_PRINCIPAL }];
    if (text.includes('pg_default_acl')) {
      const readsGlobal = /defaclnamespace = 0\s*\n?\s*or/.test(text);
      const readsSchema = text.includes('nspname = $1');
      return rows.filter((r) => (r.scope === ''
        ? readsGlobal
        : readsSchema && r.scope === String(params[0])));
    }
    return [{ c: false, t: false }];
  },
});

test('C2B-M005-B0-R1: the statement itself must ask for BOTH default-ACL scopes', async () => {
  const rows: Record<string, unknown>[] = [
    // A public-schema functions row. It does NOT close the functions class on its own — a schema
    // entry is added to the base, never substituted for it — and the assertion below proves that
    // rather than leaving the old, disproven claim standing in prose.
    { owner: M005_PRINCIPAL, objtype: 'f', scope: 'public', grantee: null, privilege: null },
    // ...and an applicable GLOBAL grant that a schema-only query would never see.
    { owner: M005_PRINCIPAL, objtype: 'r', scope: '', grantee: 'public', privilege: 'SELECT' },
  ];
  const failed = await verifyDefaultPrivileges(scopeHonouringAclCatalog(rows));
  assert.ok(
    failed.some((f) => /future tables would still grant SELECT to public \(global default privileges\)/.test(f)),
    `the global row must reach the classifier: ${failed.join(' | ')}`,
  );
  // And the SCHEMA scope is still asked for. It can no longer be proved by a schema row that closes
  // a class — a schema row closes nothing — so it is proved by a forbidden grant that exists ONLY
  // in the public schema: a query that stopped asking for that scope would never receive the row
  // and would report this database clean.
  // The public-schema row on its own leaves the functions class open — asserted here so the
  // corrected rule is enforced at this fixture and not merely stated elsewhere.
  assert.ok(
    (await verifyDefaultPrivileges(scopeHonouringAclCatalog([rows[0]])))
      .some((f) => /retain PostgreSQL's built-in grant to PUBLIC/.test(f)),
  );
  const schemaGrant = await verifyDefaultPrivileges(scopeHonouringAclCatalog([
    { owner: M005_PRINCIPAL, objtype: 'f', scope: '', grantee: null, privilege: null },
    { owner: M005_PRINCIPAL, objtype: 'f', scope: 'public', grantee: 'anon', privilege: 'EXECUTE' },
  ]));
  assert.ok(
    schemaGrant.some((f) => /future functions would still grant EXECUTE to anon \(public default privileges\)/.test(f)),
    `the schema row must reach the classifier: ${schemaGrant.join(' | ')}`,
  );
});

test('C2B-M005-B0-R1: a schema literally named "global" is not the global scope', () => {
  // The global scope is proved by the EMPTY namespace sentinel, never by a schema whose name
  // happens to be the word this code prints for it. `global` is a legal schema name, and a row in
  // it governs neither the public schema nor the global default — crediting it would close the one
  // class whose built-in default grants PUBLIC EXECUTE.
  const failed = classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: 'global' })]);
  assert.ok(failed.some((f) => /future functions retain/.test(f)), failed.join(' | '));
  // The real global row, spelled as the empty sentinel, still closes it.
  assert.deepEqual(classifyDefaultPrivileges(M005_PRINCIPAL, [acl({ scope: '' })]), []);
});

test('C2B-M005-B0-R1: the audit writer holds USAGE but never CREATE on the application schema', async () => {
  assert.deepEqual(await verify005Postconditions(M005_APPLIED), []);
  const bend = (over: Record<string, unknown>): CatalogReadPort => ({
    query: async (text, params) => (
      text.includes('usage_writer') ? [over] : await M005_APPLIED.query(text, params)
    ),
  });
  // CREATE on the schema is the precondition for this role ever owning an object, and an object it
  // owns is covered by NO default-privilege postcondition here — the one below is scoped to the
  // migration principal. Denying CREATE is what keeps that gap out of reach.
  assert.ok((await verify005Postconditions(bend({ usage_writer: true, create_writer: true })))
    .some((f) => /tmpos_audit_writer still holds CREATE on the application schema/.test(f)));
  assert.ok((await verify005Postconditions(bend({ usage_writer: false, create_writer: false })))
    .some((f) => /tmpos_audit_writer lacks USAGE on the application schema/.test(f)));
  // Missing evidence is not a pass: an absent row fails both labels.
  const absent: CatalogReadPort = {
    query: async (text, params) => (text.includes('usage_writer') ? [] : await M005_APPLIED.query(text, params)),
  };
  assert.equal((await verify005Postconditions(absent)).filter((f) => /tmpos_audit_writer/.test(f)).length, 2);
});

test('C2B-M005-B0-R1: the object classes 005 does NOT close are named, not silently omitted', async () => {
  // TYPES have a built-in default of USAGE to PUBLIC — the same shape as FUNCTIONS — and migration
  // 005 issues no statement for them. Requiring them would fail a correct apply of the frozen
  // migration, so the verifier deliberately does not; this records the omission instead, and
  // fails the day 005 gains such a statement without the verifier being extended.
  assert.deepEqual(M005_UNCOVERED_DEFAULT_ACL_CLASSES.map((c) => c.label), ['types', 'schemas']);
  const covered = new Set(M005_DEFAULT_ACL_CLASSES.map((c) => c.objtype));
  for (const c of M005_UNCOVERED_DEFAULT_ACL_CLASSES) assert.equal(covered.has(c.objtype), false, c.label);
  const sql = (await realM005Files())[M005_UP_BASENAME]
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  for (const c of M005_UNCOVERED_DEFAULT_ACL_CLASSES) {
    assert.equal(
      new RegExp(`alter\\s+default\\s+privileges[\\s\\S]{0,80}\\bon\\s+${c.label}\\b`, 'i').test(sql),
      false,
      `migration 005 now alters default privileges on ${c.label}; the verifier must cover it`,
    );
  }
});

// ---------------------------------------------------------------------------
// C2B-M005-B1-R1/R2 — the PRE-COMMIT default-ACL commit-prevention gate
//
// The B1 correction put the right statement in migration 005 and the right classifier behind the
// read-only diagnostic, but the only thing that re-checked the posture on the APPLY path ran after
// COMMIT. These tests pin the boundary itself: with the governed 005 bytes in the program, the
// bounded default-ACL verification happens on the same pinned session, inside the still-open
// bracket, and BEFORE `session.commitTx()` — so an unfavourable answer abandons the mutation
// instead of describing one that already landed.
// ---------------------------------------------------------------------------

/** The principal every synthetic default-ACL row below belongs to. */
const R1_PRINCIPAL = 'tmpos_migrator';
type R1AclRow = Record<string, unknown>;

/** The one row a correct 005 leaves behind: a GLOBAL functions entry carrying no grant. */
const R1_GLOBAL_FUNCTIONS_CLOSED: R1AclRow =
  { owner: R1_PRINCIPAL, objtype: 'f', scope: '', grantee: null, privilege: null };
/** A favourable posture: A = MET and B = NO. */
const R1_HEALTHY: R1AclRow[] = [R1_GLOBAL_FUNCTIONS_CLOSED];
/** The blocker migration 005 CANNOT remove: a GLOBAL table grant. 005 revokes tables in schema only. */
const R1_GLOBAL_TABLE_GRANT: R1AclRow[] = [
  R1_GLOBAL_FUNCTIONS_CLOSED,
  { owner: R1_PRINCIPAL, objtype: 'r', scope: '', grantee: 'public', privilege: 'SELECT' },
];
/** The same shape on sequences — the other class 005 revokes in schema only. */
const R1_GLOBAL_SEQUENCE_GRANT: R1AclRow[] = [
  R1_GLOBAL_FUNCTIONS_CLOSED,
  { owner: R1_PRINCIPAL, objtype: 'S', scope: '', grantee: 'anon', privilege: 'USAGE' },
];
/** No global functions row at all: PostgreSQL's built-in EXECUTE to PUBLIC is still the base. */
const R1_NO_FUNCTIONS_GLOBAL: R1AclRow[] = [];
/** A surviving public-schema grant to a covered grantee. */
const R1_SCHEMA_GRANT: R1AclRow[] = [
  R1_GLOBAL_FUNCTIONS_CLOSED,
  { owner: R1_PRINCIPAL, objtype: 'f', scope: 'public', grantee: 'authenticated', privilege: 'EXECUTE' },
];
/** An ACL projection this code cannot read: present, and not a legible aclitem. */
const R1_MALFORMED: R1AclRow[] = [
  R1_GLOBAL_FUNCTIONS_CLOSED,
  { owner: R1_PRINCIPAL, objtype: 'f', scope: '', grantee: 42, privilege: 'EXECUTE' },
];
/** More applicable rows than the bounded reader will consider. */
const R1_OVERFLOW: R1AclRow[] = Array.from({ length: 201 }, () => ({ ...R1_GLOBAL_FUNCTIONS_CLOSED }));

/** The backend the R1 rig's session and catalog both claim to be, unless a case says otherwise. */
const R1_PID = 11;
const R1_TOKEN = `pid:${R1_PID}`;

interface R1CatalogOptions {
  rows?: R1AclRow[];
  principal?: unknown;
  sessionPrincipal?: unknown;
  principalThrows?: boolean;
  aclThrows?: boolean;
  noPrincipalRow?: boolean;
  /** What the CATALOG says its own backend is. A different value models a second connection. */
  backendPid?: unknown;
  backendThrows?: boolean;
  /** Every statement text the catalog was asked for, in order, when supplied. */
  seen?: string[];
}

/**
 * A synthetic catalog for the pre-commit gate. It answers the TWO statements the gate issues and
 * refuses anything else, so a future edit that added a third read fails here rather than silently
 * widening what this gate touches. The ACL statement is served through the REAL bounded reader, so
 * the class filter, the distinct row bound and the overflow rule are exercised, not stubbed.
 */
function r1Catalog(o: R1CatalogOptions = {}): CatalogReadPort {
  return {
    query: async (text: string, params: readonly unknown[]) => {
      o.seen?.push(
        text.includes('pg_backend_pid') ? 'backend'
          : (text.includes('pg_default_acl') ? 'acl'
            : (text.includes('current_user') ? 'principal' : 'OTHER')),
      );
      if (text.includes('pg_backend_pid')) {
        if (o.backendThrows === true) throw new Error('catalog exploded dsn=postgres://u:hunter2@h/db');
        return [{ pid: 'backendPid' in o ? o.backendPid : R1_PID }];
      }
      if (text.includes('current_user as principal')) {
        if (o.principalThrows === true) throw new Error('catalog exploded dsn=postgres://u:hunter2@h/db');
        if (o.noPrincipalRow === true) return [];
        const p = o.principal ?? R1_PRINCIPAL;
        return [{ principal: p, session_principal: o.sessionPrincipal ?? p }];
      }
      if (text.includes('pg_default_acl')) {
        if (o.aclThrows === true) throw new Error('catalog exploded dsn=postgres://u:hunter2@h/db');
        // The bounded reader asks for limit + 1 as a DISTINCT bound parameter; assert it rather
        // than assume it, so a regression in the bound is visible from this side too.
        assert.deepEqual(params, ['public', 201]);
        return (o.rows ?? R1_HEALTHY) as Record<string, unknown>[];
      }
      throw new Error(`the pre-commit gate issued an unexpected statement: ${text}`);
    },
  };
}

/** A deps rig whose frozen program executes the GOVERNED 005 bytes. */
async function r1Deps(opt: FakeOptions = {}): Promise<{ deps: TrustedApplyDeps; rec: Recorder }> {
  // `pid:<n>` is the shape the real adapter's `backendIdentity` produces, and the gate now compares
  // the catalog's own `pg_backend_pid()` against it — so the rig has to speak the same vocabulary.
  return fakeDeps(await realM005Files(), [], { tokens: [R1_TOKEN], ...opt });
}

/**
 * Wrap a policy so the recorder shows WHEN it ran relative to the port calls. Ordering is the whole
 * contract here, and a boolean flag cannot express it.
 */
const r1Marked = (rec: Recorder, label: string, inner: TrustedApplyPolicy): TrustedApplyPolicy =>
  async (auth) => {
    rec.ops.push(label);
    // Captured at the moment the gate runs. `1` is the bracket still being open.
    rec.ops.push(`${label}:txDepth=${rec.txDepth}`);
    return inner(auth);
  };

const r1PreCommit = (rec: Recorder, o: R1CatalogOptions = {}): TrustedApplyPolicy =>
  r1Marked(rec, 'precommit', createM005PreCommitPolicy({ catalog: r1Catalog(o) }));

test('C2B-M005-B1-R1 (regression): a post-commit-wired check refuses only AFTER COMMIT', async () => {
  // THE DEFECT THIS STAGE CORRECTS, reproduced deliberately. The identical bounded reader,
  // classifier and evidence — a surviving GLOBAL table grant — routed through `postCommitPolicy`
  // instead of the new gate. It fails on the EVENT ORDER, not on a code difference: COMMIT is on
  // the wire before the blocker is looked for, so the refusal describes a durable mutation that no
  // connection disposal can reverse.
  //
  // It runs against a migration the new requirement does NOT govern, because on the governed bytes
  // this wiring is no longer expressible at all — the second half of this test is that proof.
  const ungoverned = {
    '005_principal_separation_rls_foundation.up.sql': 'create table gamma();\n',
    '005_principal_separation_rls_foundation.down.sql': '-- the down file is never executed here\n',
  };
  const { deps, rec } = fakeDeps(ungoverned, []);
  const inner = createM005PreCommitPolicy({ catalog: r1Catalog({ rows: R1_GLOBAL_TABLE_GRANT }) });
  const report = await runTrustedApply({
    ...deps,
    postCommitPolicy: r1Marked(rec, 'postcommit', async (auth) => (
      (await inner(auth)) === null ? null : EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED
    )),
  });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED);
  const commitAt = rec.ops.indexOf('commit_tx');
  const checkAt = rec.ops.indexOf('postcommit');
  assert.ok(commitAt >= 0, 'the defect is that COMMIT happens at all');
  assert.ok(checkAt > commitAt, `the check must land AFTER commit to reproduce B1: ${rec.ops.join(',')}`);
  assert.equal(report.commit.submitted, true, 'COMMIT was put on the wire');
  assert.equal(report.commit.resolved, true);
  assert.equal(rec.ops.includes('postcommit:txDepth=0'), true, 'the bracket was already CLOSED');
  // And nothing here reverses it: the mutation state says so in the operator's own vocabulary.
  assert.equal(classifyApplyMutationState(report), 'post_commit_verification_failed_may_have_committed');
  assert.equal(report.preCommitVerified, false, 'no pre-commit gate ran in this wiring');

  // THE CORRECTION, stated as an impossibility. The same B1 wiring over the GOVERNED bytes never
  // reaches a commit at all: the missing pre-commit gate is refused before the first effect.
  const { deps: gov, rec: govRec } = await r1Deps();
  const refused = await runTrustedApply({
    ...gov,
    postCommitPolicy: async () => EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
  });
  assert.equal(refused.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_POLICY_MISSING);
  assert.equal(govRec.ops.includes('commit_tx'), false, 'the B1 shape cannot run on the governed bytes');
});

test('C2B-M005-B1-R2: a surviving GLOBAL TABLE grant prevents COMMIT and disposes the connection', async () => {
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_GLOBAL_TABLE_GRANT }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  assert.equal(report.outcome, 'failed');
  assert.equal(rec.ops.includes('commit_tx'), false, `COMMIT must never be called: ${rec.ops.join(',')}`);
  assert.equal(report.commit.submitted, false);
  assert.equal(applyCommitOutcome(report.commit), 'not_submitted');
  // The migration DID execute and the ledger WAS finalized — inside the bracket, before the gate.
  assert.ok(rec.ops.some((o) => o.startsWith('execute:tx:')), 'the migration SQL runs first');
  assert.ok(rec.ops.includes('finalize:005:tx'), 'the in-transaction finalize runs first');
  assert.ok(rec.ops.indexOf('precommit') > rec.ops.indexOf('finalize:005:tx'), 'gate is after finalize');
  assert.ok(rec.ops.includes('precommit:txDepth=1'), 'the bracket was still OPEN when the gate ran');
  // Rollback is requested through the existing path: the disposition is `terminate`, which destroys
  // the connection and abandons the open transaction. Never claimed as more than that.
  assert.equal(report.disposition, 'terminate');
  assert.equal(report.disposal, 'terminated');
  assert.equal(classifyApplyMutationState(report), 'pre_commit_refusal_connection_disposal_resolved');
});

test('C2B-M005-B1-R2: a surviving GLOBAL SEQUENCE grant prevents COMMIT and disposes the connection', async () => {
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_GLOBAL_SEQUENCE_GRANT }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  assert.equal(rec.ops.includes('commit_tx'), false);
  assert.equal(report.disposal, 'terminated');
  assert.equal(classifyApplyMutationState(report), 'pre_commit_refusal_connection_disposal_resolved');
});

test('C2B-M005-B1-R1: a MISSING global FUNCTIONS override prevents COMMIT', async () => {
  // B is NO here — 005 does revoke functions globally — so this case is caught by question A alone.
  // Checking only B would let a run whose global statement did not take reach COMMIT.
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_NO_FUNCTIONS_GLOBAL }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  assert.equal(rec.ops.includes('commit_tx'), false);
});

test('C2B-M005-B1-R1: a surviving PUBLIC-SCHEMA governed grant prevents COMMIT', async () => {
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_SCHEMA_GRANT }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  assert.equal(rec.ops.includes('commit_tx'), false);
});

test('C2B-M005-B1-R1: unreadable, overflowed and principal-mismatched evidence all prevent COMMIT', async () => {
  // Each of these is MISSING EVIDENCE, not a blocker, and they carry the evidence code rather than
  // the blocker code — an operator must not be told a grant was found when none was read.
  const cases: [string, R1CatalogOptions][] = [
    ['malformed ACL projection', { rows: R1_MALFORMED }],
    ['row-budget overflow', { rows: R1_OVERFLOW }],
    ['session/current principal mismatch', { principal: R1_PRINCIPAL, sessionPrincipal: 'someone_else' }],
    ['unreadable principal', { principal: 42 }],
    ['no principal row at all', { noPrincipalRow: true }],
    ['principal read throws', { principalThrows: true }],
    ['ACL read throws', { aclThrows: true }],
  ];
  for (const [label, o] of cases) {
    const { deps, rec } = await r1Deps();
    const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, o) });
    assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE, label);
    assert.equal(rec.ops.includes('commit_tx'), false, label);
    assert.equal(report.commit.submitted, false, label);
    assert.ok(!JSON.stringify(report).includes('hunter2'), `${label}: a driver message leaked`);
  }
});

test('C2B-M005-B1-R1: a CHANGED or UNREADABLE backend identity prevents COMMIT, with its own code', async () => {
  // The gate reads the backend token before and after the catalog reads. The 005 program's own
  // identity effects consume the first three tokens, so index 3 is the gate's "before" and index 4
  // its "after".
  const T = R1_TOKEN;
  for (const [label, tokens, expected] of [
    ['identity changes between the reads', [T, T, T, T, 'pid:99'], EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED],
    ['the AFTER token is unreadable', [T, T, T, T, ''], EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED],
    // Nothing had been established yet, so this is missing evidence and NOT a claimed change.
    ['the BEFORE token is unreadable', [T, T, T, ''], EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE],
    // The adapter can render a missing pid as the literal 'pid:undefined'; that is not a token.
    ['the BEFORE token is the undefined rendering', [T, T, T, 'pid:undefined'], EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE],
  ] as [string, string[], string][]) {
    const { deps, rec } = await r1Deps({ tokens });
    const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec) });
    assert.equal(report.code, expected, label);
    assert.equal(rec.ops.includes('commit_tx'), false, label);
    // The refusal keeps its disposal label: the bracket WAS open and 005 HAD executed.
    assert.equal(classifyApplyMutationState(report), 'pre_commit_refusal_connection_disposal_resolved', label);
  }
});

test('C2B-M005-B1-R1: a catalog on a DIFFERENT backend cannot authorize this run', async () => {
  // "Same pinned connection" used to be a property of one call site's wiring. The gate now proves
  // it: a catalog whose own `pg_backend_pid()` disagrees with the session token is refused, so a
  // second connection — which would see the PRE-migration catalog, and therefore a clean one —
  // cannot approve a commit the real backend's state forbids.
  for (const [label, o] of [
    ['catalog reports another backend', { backendPid: 99 }],
    ['catalog reports no backend at all', { backendPid: null }],
  ] as [string, R1CatalogOptions][]) {
    const { deps, rec } = await r1Deps();
    const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, o) });
    assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED, label);
    assert.equal(rec.ops.includes('commit_tx'), false, label);
  }
  // A catalog that cannot answer at all is missing evidence, not a claimed change.
  const { deps, rec } = await r1Deps();
  const unreadable = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { backendThrows: true }) });
  assert.equal(unreadable.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE);
});

test('C2B-M005-B1-R1: a policy that throws, hangs or returns an unknown code all prevent COMMIT', async () => {
  const unknown: TrustedApplyPolicy = async () => 'not_a_code_this_module_knows pw=hunter2';
  const thrower: TrustedApplyPolicy = async () => { throw new Error('policy exploded pw=hunter2'); };
  const hanger: TrustedApplyPolicy = () => new Promise(() => {});
  // ALL THREE ARE THE SAME FACT — the gate ran and did not answer — and they carry the gate's own
  // code rather than a generic port/timeout one. That matters downstream: a generic code made the
  // mutation-state classifier say "nothing had been executed" about a state where 005's DDL and its
  // in-transaction ledger row had both run and were then abandoned.
  for (const [label, policy] of [
    ['throws', thrower],
    ['times out', hanger],
    // An unrecognized return is an unrecognized RESULT: a refusal, and one whose label is bounded
    // rather than echoed — the report's `code` field must never become a text channel.
    ['returns an unknown code', unknown],
  ] as [string, TrustedApplyPolicy][]) {
    const { deps, rec } = await r1Deps();
    const report = await runTrustedApply({ ...deps, preCommitPolicy: r1Marked(rec, 'precommit', policy) });
    assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_UNEVALUATED, label);
    assert.equal(rec.ops.includes('commit_tx'), false, label);
    assert.equal(report.commit.submitted, false, label);
    assert.equal(report.preCommitVerified, false, label);
    assert.equal(classifyApplyMutationState(report), 'pre_commit_refusal_connection_disposal_resolved', label);
    assert.ok(!JSON.stringify(report).includes('hunter2'), `${label}: text leaked into the report`);
  }
});

test('C2B-M005-B1-R1: the exact-005 program REFUSES when no pre-commit policy is supplied', async () => {
  // The requirement is derived from the frozen program, not from a caller flag — so forgetting to
  // wire the gate is a refusal rather than a silent bypass. It refuses before ANY mutating effect.
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply(deps);
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_POLICY_MISSING);
  assert.equal(report.outcome, 'failed');
  assert.equal(rec.ops.includes('acquire_lock'), false, 'no lock is taken');
  assert.equal(rec.ops.some((o) => o.startsWith('insert_dirty')), false, 'no dirty marker is written');
  assert.equal(rec.ops.some((o) => o.startsWith('execute:')), false, 'no SQL runs');
  assert.equal(rec.ops.includes('commit_tx'), false);
  assert.equal(report.lockRelease, 'not_acquired');
  // NOT a disposal label: nothing was locked, executed or bracketed, so there is nothing that was
  // abandoned. The two ENTRY refusals are deliberately excluded from the disposal vocabulary.
  assert.equal(classifyApplyMutationState(report), 'commit_not_attempted');
});

test('C2B-M005-B1-R1: a non-transactional exact-005 program refuses before any statement', async () => {
  // Asked to run the governed bytes bracket-free, the run stops. It is caught by the OLDER and
  // stronger multi-statement gate rather than by the new one, and that ordering is why
  // MANAGED_PRECOMMIT_NOT_TRANSACTIONAL is defence in depth: see the reachability proof below.
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({
    ...deps,
    transactionModeByVersion: { '005': 'forbidden' },
    preCommitPolicy: r1PreCommit(rec),
  });
  assert.equal(report.code, EXECUTOR_CODES.FORBIDDEN_MODE_MULTI_STATEMENT);
  assert.equal(rec.ops.some((o) => o.startsWith('execute:')), false);
  assert.equal(rec.ops.includes('commit_tx'), false);
  assert.equal(report.commit.submitted, false);
});

test('C2B-M005-B1-R1: why the not-transactional guard cannot be reached END-TO-END for these bytes', async () => {
  // The guard itself is exercised directly, as a pure function, further down. This records WHY it
  // cannot also be reached through `runTrustedApply` on the governed artifact: clause 1
  // (`txScoped !== true`) needs a bracket-free 005, and 005 holds many statements, so the older
  // forbidden-mode gate refuses first; clause 2 (`totalCommits !== 1`) cannot occur because a
  // required-mode migration emits exactly one commit_tx per unit and this plan is one unit.
  const sql = (await realM005Files())[M005_UP_BASENAME];
  assert.ok(countSqlStatements(sql) > 1, 'a single-statement 005 would make clause 1 reachable');
  const { deps, rec } = await r1Deps();
  const ok = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec) });
  assert.equal(ok.outcome, 'complete', ok.code ?? '');
  assert.equal(rec.ops.filter((o) => o === 'commit_tx').length, 1, 'exactly one commit_tx per required-mode unit');
});

test('C2B-M005-B1-R1: a favourable gate commits exactly once, in order, and reports the verification', async () => {
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec) });
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.equal(report.preCommitVerified, true);
  assert.equal(rec.ops.filter((o) => o === 'precommit').length, 1, 'the gate runs exactly once');
  assert.equal(rec.ops.filter((o) => o === 'commit_tx').length, 1, 'COMMIT happens exactly once');
  // THE ORDERING INVARIANT. Moving the gate to after `interpretEffect` — the B1 shape — flips this
  // comparison and turns the recorded depth into 0.
  assert.ok(rec.ops.indexOf('precommit') < rec.ops.indexOf('commit_tx'), rec.ops.join(','));
  assert.ok(rec.ops.includes('precommit:txDepth=1'), 'the gate saw an OPEN bracket');
});

test('C2B-M005-B1-R1: post-commit verification is still required after a favourable pre-commit gate', async () => {
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({
    ...deps,
    preCommitPolicy: r1PreCommit(rec),
    postCommitPolicy: r1Marked(rec, 'postcommit', async () => null),
  });
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.equal(report.preCommitVerified, true);
  assert.equal(report.commit.readBackVerified, true);
  assert.equal(rec.ops.filter((o) => o === 'postcommit').length, 1, 'the post-commit policy runs exactly once');
  assert.ok(rec.ops.indexOf('precommit') < rec.ops.indexOf('commit_tx'), rec.ops.join(','));
  assert.ok(rec.ops.indexOf('commit_tx') < rec.ops.indexOf('postcommit'), rec.ops.join(','));
  assert.equal(classifyApplyMutationState(report), 'success_commit_and_read_back_verified');
});

test('C2B-M005-B1-R1: a post-commit refusal after a favourable gate is still MAY-HAVE-COMMITTED', async () => {
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({
    ...deps,
    preCommitPolicy: r1PreCommit(rec),
    postCommitPolicy: async () => EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH,
  });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_APPLY_READBACK_MISMATCH);
  assert.equal(report.preCommitVerified, true, 'the pre-commit gate DID approve — that is not retracted');
  assert.equal(classifyApplyMutationState(report), 'post_commit_verification_failed_may_have_committed');
});

test('C2B-M005-B1-R2: a failed teardown after a pre-commit refusal leaves the disposal UNVERIFIED', async () => {
  // Rollback failure overrides nothing about the primary refusal — the pre-commit code SURVIVES —
  // but it downgrades what may be claimed about the open transaction.
  const { deps, rec } = await r1Deps({ behaviour: { terminate: 'throw' } });
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_GLOBAL_TABLE_GRANT }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT, 'the primary refusal survives');
  assert.equal(report.outcome, 'failed');
  assert.equal(report.disposal, 'none', 'termination was attempted and not established');
  assert.equal(classifyApplyMutationState(report), 'pre_commit_refusal_connection_disposal_unverified');
});

test('C2B-M005-B1-R1: neither a missing pre-commit gate nor a failed teardown can produce a PASS', async () => {
  const clean = {
    outcome: 'complete' as const,
    code: null,
    commit: { submitted: true, resolved: true, acknowledged: 'unavailable' as const, readBackVerified: true },
    lockRelease: 'verified' as const,
    preCommitVerified: true,
    disposal: 'terminated' as const,
    ledgerMarker: 'clean_verified' as const,
    teardown: { completed: true, code: null },
  };
  assert.equal(classifyManagedApplyRefusal('apply(up)', clean), null);
  assert.match(
    String(classifyManagedApplyRefusal('apply(up)', { ...clean, preCommitVerified: false })),
    /without a pre-commit default-ACL verification/,
  );
  // ORDERING: the pre-commit statement outranks the read-back one, because "committed around the
  // gate" is graver than "committed without confirming the write".
  assert.match(
    String(classifyManagedApplyRefusal('apply(up)', {
      ...clean,
      preCommitVerified: false,
      commit: { submitted: true, resolved: true, acknowledged: 'unavailable', readBackVerified: false },
    })),
    /without a pre-commit default-ACL verification/,
  );
  assert.match(
    String(classifyManagedApplyRefusal('apply(up)', { ...clean, teardown: { completed: false, code: null } })),
    /teardown NOT ESTABLISHED/,
  );
});

test('C2B-M005-B1-R1: a NON-005 program is untouched — no gate is required and none is injected', async () => {
  // The requirement binds version AND checksum. A synthetic migration that merely CALLS itself 005
  // carries different bytes, so it is not this path and runs exactly as it did before.
  const { deps, rec } = fakeDeps(ONE, []);
  const before = await runTrustedApply(deps);
  assert.equal(before.outcome, 'complete', before.code ?? '');
  assert.equal(before.preCommitVerified, false, 'no gate ran, and none was owed');
  assert.equal(rec.ops.filter((o) => o === 'commit_tx').length, 1);

  const impostor = {
    '005_principal_separation_rls_foundation.up.sql': 'create table imposter();\n',
    '005_principal_separation_rls_foundation.down.sql': '-- the down file is never executed here\n',
  };
  const { deps: d2, rec: r2 } = fakeDeps(impostor, []);
  const report = await runTrustedApply(d2);
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.equal(r2.ops.filter((o) => o === 'commit_tx').length, 1, 'a different-bytes 005 is not the governed path');
});

test('C2B-M005-B1-R1: the gate issues exactly its three reads, in order, around the identity pair', async () => {
  // Containment AND ordering in one place. The gate reads through the SAME reserved session's
  // catalog port; `r1Catalog` throws on any statement other than the three it expects, so a future
  // edit that added a fourth read fails here rather than silently widening what this gate touches.
  //
  // The interleaving matters as much as the set: the BEFORE token must precede every catalog read
  // and the AFTER token must follow every one of them, or a verdict could be spoken about rows
  // that came from a backend the run never bound. Recording both channels into ONE list is what
  // makes that assertable — with the catalog reads invisible, moving either token read was a
  // mutation no test could see.
  const { deps, rec } = await r1Deps();
  const seen: string[] = [];
  const report = await runTrustedApply({
    ...deps,
    preCommitPolicy: r1Marked(rec, 'precommit', createM005PreCommitPolicy({ catalog: r1Catalog({ seen: rec.ops }) })),
  });
  assert.equal(report.outcome, 'complete', report.code ?? '');
  for (const op of rec.ops) if (op === 'backend' || op === 'acl' || op === 'principal') seen.push(op);
  assert.deepEqual(seen, ['backend', 'principal', 'acl'], 'exactly three reads, in this order');
  assert.equal(rec.ops.includes('OTHER'), false, 'no statement outside the three the gate declares');

  // The identity calls the gate itself makes are the two `identity` entries bracketing the reads.
  const gateAt = rec.ops.indexOf('precommit');
  const after = rec.ops.slice(gateAt);
  const idAt = after.indexOf('identity');
  const lastId = after.lastIndexOf('identity');
  assert.ok(idAt >= 0 && lastId > idAt, `two identity reads inside the gate: ${after.join(',')}`);
  assert.ok(after.indexOf('backend') > idAt, 'the BEFORE token precedes every catalog read');
  assert.ok(after.indexOf('acl') > idAt, 'including the ACL read');
  assert.ok(lastId > after.lastIndexOf('acl'), 'the AFTER token follows every catalog read');
  assert.equal(rec.ops.filter((o) => o === 'reserve').length, 1, 'exactly one reservation for the whole run');
});

test('C2B-M005-B1-R1: the entry requirement is a pure function of the frozen program', async () => {
  // Extracted so BOTH clauses can be exercised. Inline, the not-transactional clause was
  // unreachable for the governed bytes — an older gate refuses first — and a guard nothing can
  // fail is indistinguishable from a guard that is not there.
  const gov = { version: M005_VERSION, checksum: M005_UP_SHA256, txScoped: true };
  const P = requiredPreCommitEntryRefusal;
  assert.equal(P([gov], true, 1), null, 'the exact-[005] execution with a gate is allowed');
  assert.equal(P([gov], false, 1), EXECUTOR_CODES.MANAGED_PRECOMMIT_POLICY_MISSING);
  assert.equal(P([{ ...gov, txScoped: false }], true, 0), EXECUTOR_CODES.MANAGED_PRECOMMIT_NOT_TRANSACTIONAL);
  assert.equal(P([gov], true, 0), EXECUTOR_CODES.MANAGED_PRECOMMIT_NOT_TRANSACTIONAL, 'no commit to gate');
  assert.equal(P([gov], true, 2), EXECUTOR_CODES.MANAGED_PRECOMMIT_NOT_TRANSACTIONAL, 'more than one commit');
  // NOT the exact-[005] execution, and each conjunct is shown to matter on its own.
  assert.equal(P([], true, 0), null, 'an empty plan owes nothing');
  assert.equal(P([{ ...gov, version: '004' }], false, 1), null, 'another version owes nothing');
  assert.equal(P([{ ...gov, checksum: 'a'.repeat(64) }], false, 1), null, 'other bytes are another migration');
  assert.equal(
    P([{ version: '004', checksum: 'b'.repeat(64), txScoped: false }, gov], false, 1), null,
    'a multi-unit plan is not the exact-[005] execution — ordinary 001-005 applies are untouched',
  );
});

test('C2B-M005-B1-R1: the gate verdict is a pure function, and BOTH its questions decide', async () => {
  // Question B cannot currently be exercised through the policy: with today's class flags every
  // posture that yields B = YES also yields A = UNMET, so B is a subset of A and deleting the B
  // clause changes nothing observable. That is a fact about the class constant, not the contract —
  // the day 005 stops revoking a class globally, B is the only question that can see it. Asserting
  // the decision directly is what keeps the clause alive.
  const V = choosePreCommitVerdict;
  const met = { principalAgreement: 'AGREED', postcondition: 'MET', blockerSurvivesCurrentM005: 'NO' } as const;
  assert.equal(V(met, false), null);
  assert.equal(
    V({ ...met, blockerSurvivesCurrentM005: 'YES' }, false), EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT,
    'A = MET with B = YES must still refuse — this is the clause the live class set cannot reach',
  );
  assert.equal(V({ ...met, postcondition: 'UNMET' }, false), EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  // Missing evidence is a DIFFERENT finding and never borrows the blocker's code.
  for (const bad of [
    { ...met, principalAgreement: 'MISMATCH' } as const,
    { ...met, principalAgreement: 'UNREADABLE' } as const,
    { ...met, postcondition: 'UNREADABLE' } as const,
    { ...met, blockerSurvivesCurrentM005: 'UNREADABLE' } as const,
  ]) {
    assert.equal(V(bad, false), EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE, JSON.stringify(bad));
  }
  assert.equal(V(met, true), EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE, 'overflow is never a verdict');
});

test('C2B-M005-B1-R1: the bounded reader DISCARDS an overflowing page rather than truncating it', async () => {
  // Proved on the reader itself. Through the gate this is double-covered by the assessment also
  // returning UNREADABLE, so either copy alone was unpinned: each was proven only by the other.
  let asked: readonly unknown[] = [];
  const many = Array.from({ length: 201 }, () => ({ ...R1_GLOBAL_FUNCTIONS_CLOSED }));
  const over = await readDefaultAclRowsBounded({
    query: async (_t, params) => { asked = params; return many as Record<string, unknown>[]; },
  });
  assert.deepEqual(asked, ['public', 201], 'the row budget is a DISTINCT bound parameter of limit + 1');
  assert.equal(over.overflowed, true);
  assert.deepEqual(over.rows, [], 'a truncated page could omit exactly the grant that would fail');
  const under = await readDefaultAclRowsBounded({ query: async () => R1_HEALTHY as Record<string, unknown>[] });
  assert.equal(under.overflowed, false);
  assert.equal(under.rows.length, 1);
});

test('C2B-M005-B1-R2: every pre-commit gate code carries a disposal label, and no other code does', async () => {
  // Membership of PRE_COMMIT_GATE_CODES is what decides whether an operator is told "005 executed
  // and was abandoned" or "nothing ran". Two of the four members were unpinned, and dropping either
  // silently deleted that statement from the report.
  const base = {
    outcome: 'failed' as const,
    commit: { submitted: false, resolved: false, acknowledged: 'unavailable' as const, readBackVerified: false },
    disposal: 'terminated' as const,
    preCommitVerified: false,
  };
  for (const code of [
    EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT,
    EXECUTOR_CODES.MANAGED_PRECOMMIT_EVIDENCE_UNREADABLE,
    EXECUTOR_CODES.MANAGED_PRECOMMIT_BACKEND_IDENTITY_CHANGED,
    EXECUTOR_CODES.MANAGED_PRECOMMIT_UNEVALUATED,
  ]) {
    assert.equal(PRE_COMMIT_GATE_CODES.has(code), true, code);
    assert.equal(classifyApplyMutationState({ ...base, code }), 'pre_commit_refusal_connection_disposal_resolved', code);
    assert.equal(
      classifyApplyMutationState({ ...base, code, disposal: 'none' }),
      'pre_commit_refusal_connection_disposal_unverified', code,
    );
  }
  // The two ENTRY refusals decide before any effect, so they are deliberately NOT disposal states.
  for (const code of [
    EXECUTOR_CODES.MANAGED_PRECOMMIT_POLICY_MISSING,
    EXECUTOR_CODES.MANAGED_PRECOMMIT_NOT_TRANSACTIONAL,
  ]) {
    assert.equal(PRE_COMMIT_GATE_CODES.has(code), false, code);
    assert.equal(classifyApplyMutationState({ ...base, code }), 'commit_not_attempted', code);
  }
});

test('C2B-M005-B1-R1: UNKNOWN outranks every other mutation state, and success needs all three facts', async () => {
  const submitted = { submitted: true, resolved: false, acknowledged: 'unavailable' as const, readBackVerified: false };
  // Absorbing, and decided FIRST: a code, a disposal or a pre-commit approval must not narrow it.
  for (const over of [
    {}, { code: EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT }, { disposal: 'none' as const },
    { preCommitVerified: true }, { outcome: 'complete' as const },
  ]) {
    assert.equal(
      classifyApplyMutationState({
        outcome: 'failed', code: null, commit: submitted, disposal: 'terminated', preCommitVerified: false, ...over,
      }),
      'commit_failed_or_unknown', JSON.stringify(over),
    );
  }
  const resolved = { ...submitted, resolved: true, readBackVerified: true };
  const clean = { outcome: 'complete' as const, code: null, commit: resolved, disposal: 'closed' as const, preCommitVerified: true };
  assert.equal(classifyApplyMutationState(clean), 'success_commit_and_read_back_verified');
  // Each conjunct on its own is enough to withhold the strongest word in this vocabulary.
  assert.equal(classifyApplyMutationState({ ...clean, preCommitVerified: false }), 'post_commit_verification_failed_may_have_committed');
  assert.equal(classifyApplyMutationState({ ...clean, outcome: 'failed' }), 'post_commit_verification_failed_may_have_committed');
  assert.equal(
    classifyApplyMutationState({ ...clean, commit: { ...resolved, readBackVerified: false } }),
    'post_commit_verification_failed_may_have_committed',
  );
});

test('C2B-M005-B1-R1: a sibling policy cannot borrow a pre-commit label or emit arbitrary text', async () => {
  // Both siblings run outside the bracket — the execution policy before `open_tx`, the post-commit
  // one after COMMIT resolved — so a pre-commit code from either would make the mutation state
  // describe abandoning a bracket that was never opened. And `report.code` reaches operator output,
  // so an unrecognized return must never be echoed.
  const { deps: d1 } = await r1Deps();
  const stolen = await runTrustedApply({
    ...d1,
    executionPolicy: async () => EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT,
    preCommitPolicy: createM005PreCommitPolicy({ catalog: r1Catalog() }),
  });
  assert.equal(stolen.code, EXECUTOR_CODES.PORT_FAILED, 'the pre-commit label is refused, not adopted');
  assert.equal(classifyApplyMutationState(stolen), 'commit_not_attempted', 'and no disposal is claimed');

  const { deps: d2, rec: r2 } = await r1Deps();
  const leaked = await runTrustedApply({
    ...d2,
    preCommitPolicy: r1PreCommit(r2),
    postCommitPolicy: async () => 'select * from secrets where pw=hunter2',
  });
  assert.equal(leaked.code, EXECUTOR_CODES.PORT_FAILED);
  assert.ok(!JSON.stringify(leaked).includes('hunter2'), 'a policy return is never echoed into the report');
});

test('C2B-M005-B1-R1: the run lock is NOT released while an uncommitted bracket is still open', async () => {
  // `pg_advisory_unlock` on a session lock is not transactional, so releasing here would publish
  // "no migration in progress" while this backend still holds every ACCESS EXCLUSIVE lock the
  // migration took — and `terminate()` is a half-close the backend may not read at once. The
  // truthful outcome is an UNVERIFIED release that the physical teardown then performs.
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_GLOBAL_TABLE_GRANT }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  const unlocks = rec.ops.filter((o) => o === 'release_lock').length;
  assert.equal(unlocks, 0, `no unlock may be issued inside the open bracket: ${rec.ops.join(',')}`);
  assert.equal(report.lockRelease, 'unverified', 'and the report says so rather than claiming a release');
  assert.equal(report.disposal, 'terminated', 'the teardown is what actually drops it');
  // A run that reached its refusal with NO bracket open still gets the compensating unlock.
  const { deps: d2, rec: r2 } = fakeDeps(ONE, []);
  const early = await runTrustedApply({ ...d2, executionPolicy: async () => ENGINE_CODES.PORT_OPERATION_FAILED });
  assert.equal(r2.ops.filter((o) => o === 'release_lock').length, 1, 'the existing path is unchanged');
  assert.equal(early.lockRelease, 'verified');
});

test('C2B-M005-B1-R1: an AMBIGUOUS BEGIN also suppresses the unlock — the attempt is what latches', async () => {
  // A BEGIN whose port call rejects is ambiguous: the client saw a failure, but the server may have
  // processed the statement before the connection faulted. Latching the bracket flag on SUCCESS
  // left this path unguarded, so a non-timeout failure released the run lock while a transaction
  // might still be open — the exact hazard the guard exists to prevent.
  const { deps, rec } = fakeDeps(ONE, [], { behaviour: { begin_tx: 'throw' } });
  const report = await runTrustedApply(deps);
  assert.notEqual(report.outcome, 'complete', 'the run fails on the BEGIN');
  assert.ok(rec.ops.includes('begin_tx'), 'the open was attempted');
  assert.equal(rec.ops.filter((o) => o === 'release_lock').length, 0,
    `no unlock may be issued when a bracket MAY be open: ${rec.ops.join(',')}`);
  assert.equal(report.lockRelease, 'unverified', 'and the report claims nothing it cannot prove');
  assert.equal(rec.ops.includes('commit_tx'), false, 'and COMMIT is never reached');
});

// C2B-M005-B1-R2 — accurate failure vocabulary
//
// R1 prevented the commit correctly and then described what followed as a rollback. It is not one:
// there is no rollback port on this path, no ROLLBACK is submitted, and the connection is simply
// destroyed. These tests pin the corrected vocabulary and the two facts it must never overstate —
// that a resolved disposal is a CLIENT fact, and that `report.applied` counts a finalize whose
// transaction was abandoned.
// ---------------------------------------------------------------------------

test('C2B-M005-B1-R2: no reachable mutation-state label names a rollback', async () => {
  // The whole vocabulary, driven rather than read off the type: every code in the table crossed
  // with every disposal and both commit shapes. If any future label reintroduces the word, the set
  // this collects contains it.
  const seen = new Set<string>();
  const commits = [
    { submitted: false, resolved: false, acknowledged: 'unavailable' as const, readBackVerified: false },
    { submitted: true, resolved: false, acknowledged: 'unavailable' as const, readBackVerified: false },
    { submitted: true, resolved: true, acknowledged: 'observed' as const, readBackVerified: true },
  ];
  for (const code of [null, ...Object.values(EXECUTOR_CODES)]) {
    for (const disposal of ['none', 'closed', 'terminated'] as const) {
      for (const commit of commits) {
        for (const outcome of ['complete', 'failed'] as const) {
          for (const preCommitVerified of [true, false]) {
            seen.add(classifyApplyMutationState({ outcome, code, commit, disposal, preCommitVerified }));
          }
        }
      }
    }
  }
  // EXACTLY the vocabulary, not "at least most of it": a floor below the real count lets any of
  // the four non-disposal labels be deleted or merged without failing here.
  assert.equal(seen.size, 6, `the sweep must reach the whole vocabulary: ${[...seen].sort().join(',')}`);
  for (const label of seen) {
    assert.ok(!/roll(ed)? ?back/i.test(label), `no label may claim a rollback: ${label}`);
  }
  // And the two disposal labels are the ones the sweep reaches — named for what was observed.
  assert.ok(seen.has('pre_commit_refusal_connection_disposal_resolved'));
  assert.ok(seen.has('pre_commit_refusal_connection_disposal_unverified'));
});

test('C2B-M005-B1-R2: a resolved disposal is a client fact, and the report claims nothing beyond it', async () => {
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_GLOBAL_TABLE_GRANT }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  // `terminated` means the destroy CALL succeeded. It is the strongest word this path has, and it
  // is still only about this process — the label it produces says "disposal", never "rollback".
  assert.equal(report.disposal, 'terminated');
  assert.equal(classifyApplyMutationState(report), 'pre_commit_refusal_connection_disposal_resolved');
  // There is no rollback anywhere in the evidence: not a field, not a code, not a detail line.
  const serialized = JSON.stringify(report);
  assert.ok(!/roll(ed)? ?back/i.test(serialized), `the report must not mention a rollback: ${serialized}`);
  // Nor does anything in it assert a graceful socket close. That is the launcher's child-exit
  // evidence on the live path, and this report is not entitled to it.
  assert.ok(!/graceful/i.test(serialized), 'no graceful-close claim belongs in this report');
});

test('C2B-M005-B1-R2: an abandoned finalize still lands in report.applied — which is why it is not "applied"', async () => {
  // THE REASON THE CLI HEADLINE SAYS `finalized=`. The tx-scoped finalize runs INSIDE the bracket,
  // one effect before the gate, so a refusal leaves the version counted here with nothing durable
  // behind it. The count is not a bug to remove — it is the ledger write that really happened —
  // but presenting it as an applied migration would tell an operator the opposite of the truth.
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_GLOBAL_SEQUENCE_GRANT }) });
  assert.equal(report.applied.length, 1, 'the finalize succeeded inside the bracket');
  assert.equal(report.commit.submitted, false, 'and COMMIT was never put on the wire');
  assert.equal(applyCommitOutcome(report.commit), 'not_submitted');
  assert.equal(report.outcome, 'failed');
  // The mutation state is the field that resolves the contradiction, so it must never be omitted
  // wherever the count is shown.
  assert.equal(classifyApplyMutationState(report), 'pre_commit_refusal_connection_disposal_resolved');
});

test('C2B-M005-B1-R2 (residual): the ungated-apply downgrade is real, and is bounded to this function', async () => {
  // NAMED RESIDUAL, pinned rather than repaired. A clean run whose post-commit read-back verified
  // still classifies as `post_commit_verification_failed_...` when `preCommitVerified` is false,
  // which for an ORDINARY apply — one that owes no gate — would be a wrong word for a good run.
  //
  // It is UNREACHABLE from production source: `classifyApplyMutationState` has exactly one
  // non-test caller, the managed exact-[005] apply, and on that path the executor refuses the
  // program outright unless a pre-commit policy is supplied — so a resolved commit there implies
  // the flag. The containment suite pins the call-site count; this pins the behaviour, so that a
  // future second caller changes a test rather than a report.
  const resolved = { submitted: true, resolved: true, acknowledged: 'observed' as const, readBackVerified: true };
  const ungated = {
    outcome: 'complete' as const, code: null, commit: resolved,
    disposal: 'closed' as const, preCommitVerified: false,
  };
  assert.equal(classifyApplyMutationState(ungated), 'post_commit_verification_failed_may_have_committed');
  assert.equal(classifyApplyMutationState({ ...ungated, preCommitVerified: true }), 'success_commit_and_read_back_verified');
});

// C2B-M005-B1-R3 — the durable dirty-marker consequence
//
// `insert_dirty` is an AUTOCOMMITTED ledger mutation that lands before `open_tx`. Every refusal
// after it therefore leaves a durable `dirty = true` row while the migration itself commits
// nothing — and until this stage no field in the report could say so, so the whole managed record
// read as "nothing landed". These tests pin the state machine and the operator consequence.
// ---------------------------------------------------------------------------

const R3_COMMIT_NONE = { submitted: false, resolved: false, acknowledged: 'unavailable' as const, readBackVerified: false };
const R3_COMMIT_SENT = { ...R3_COMMIT_NONE, submitted: true };
const R3_COMMIT_OK = { ...R3_COMMIT_SENT, resolved: true, readBackVerified: true };

test('C2B-M005-B1-R3: the ledger-marker state machine is total and never narrows an unknown', () => {
  const c = classifyLedgerMarker;
  // 1. NOTHING ATTEMPTED outranks everything — no commit evidence can make a row exist.
  for (const commit of [R3_COMMIT_NONE, R3_COMMIT_SENT, R3_COMMIT_OK]) {
    assert.equal(c({ dirtyMarkerWrite: 'not_attempted', commit }), 'not_written');
  }
  // 2. An UNDETERMINED WRITE outranks any commit evidence, including a fully verified one: a
  //    commit cannot clear a row that may never have existed.
  for (const commit of [R3_COMMIT_NONE, R3_COMMIT_SENT, R3_COMMIT_OK]) {
    assert.equal(c({ dirtyMarkerWrite: 'unknown', commit }), 'unknown');
  }
  // 3. Written, COMMIT never submitted — the autocommitted row is definitely still dirty.
  assert.equal(c({ dirtyMarkerWrite: 'succeeded', commit: R3_COMMIT_NONE }), 'durable_dirty');
  // 4. Written, COMMIT submitted and undetermined — the finalize inside it may or may not stand.
  assert.equal(c({ dirtyMarkerWrite: 'succeeded', commit: R3_COMMIT_SENT }), 'unknown');
  // 5. Written, COMMIT resolved, NO durable read-back — a settled client promise is not a database
  //    fact, so `clean` is withheld rather than assumed.
  assert.equal(
    c({ dirtyMarkerWrite: 'succeeded', commit: { ...R3_COMMIT_OK, readBackVerified: false } }),
    'unknown',
  );
  // 6. Written, COMMIT resolved, read-back verified — the only combination that may claim clean.
  assert.equal(c({ dirtyMarkerWrite: 'succeeded', commit: R3_COMMIT_OK }), 'clean_verified');
});

test('C2B-M005-B1-R3: a refusal BEFORE insert_dirty reports no marker at all', async () => {
  // The forbidden-migration guard refuses before the first effect, so nothing was ever written.
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_POLICY_MISSING);
  assert.equal(rec.ops.some((o) => o.startsWith('insert_dirty')), false, 'no marker effect ran');
  assert.equal(report.dirtyMarkerWrite, 'not_attempted');
  assert.equal(classifyLedgerMarker(report), 'not_written');
});

test('C2B-M005-B1-R3: a pre-commit ACL refusal leaves a DURABLE dirty marker, and says so', async () => {
  // THE STATE THE WHOLE STAGE EXISTS FOR. The migration transaction commits nothing, and a ledger
  // mutation is nonetheless durable — the two facts are opposite and both must be reported.
  const { deps, rec } = await r1Deps();
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec, { rows: R1_GLOBAL_TABLE_GRANT }) });
  assert.equal(report.code, EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT);
  assert.ok(rec.ops.some((o) => o.startsWith('insert_dirty')), 'the marker WAS written');
  assert.equal(report.dirtyMarkerWrite, 'succeeded');
  assert.equal(report.commit.submitted, false, 'commit_attempted=false, for the MIGRATION tx only');
  assert.equal(classifyLedgerMarker(report), 'durable_dirty');

  const verdict = classifyManagedApplyRefusal('apply(up)', {
    ...report, ledgerMarker: classifyLedgerMarker(report), teardown: { completed: true, code: null },
  });
  assert.ok(verdict !== null, 'a durable marker must force a refusal');
  assert.match(verdict, /DURABLE DIRTY LEDGER MARKER REMAINS/, 'stated, not implied');
  assert.match(verdict, /FUTURE APPLY IS BLOCKED/, 'and its operational consequence is stated');
  assert.ok(!/nothing landed|nothing happened/i.test(verdict), 'it must not read as "nothing landed"');
  // No remedy is named: no managed command implements one, and naming a flag that refuses would
  // send the operator to a dead end.
  assert.ok(!/resolve-dirty|--resolve/i.test(verdict), 'no unimplemented remedy may be suggested');
  // And nothing in the verdict leaks evidence.
  assert.ok(!/hunter2|pg_default_acl|select |postgres:\/\//i.test(verdict), 'bounded text only');
});

test('C2B-M005-B1-R3: every failure AFTER the marker write keeps the durable marker', async () => {
  // open_tx, the migration SQL and the finalize each fail in turn. All three land after the
  // autocommitted write, so all three owe the same durable-marker statement.
  const cases: Array<[string, Record<string, 'throw'>]> = [
    ['open_tx fails', { begin_tx: 'throw' }],
    ['migration SQL fails', { 'execute:tx:depth=1': 'throw' }],
    ['finalize fails', { 'finalize:005': 'throw' }],
  ];
  for (const [label, behaviour] of cases) {
    const { deps, rec } = await r1Deps({ behaviour });
    const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec) });
    assert.equal(report.dirtyMarkerWrite, 'succeeded', label);
    assert.equal(classifyLedgerMarker(report), 'durable_dirty', label);
    assert.equal(report.commit.submitted, false, label);
    assert.match(
      String(classifyManagedApplyRefusal('apply(up)', {
        ...report, ledgerMarker: classifyLedgerMarker(report), teardown: { completed: true, code: null },
      })),
      /DURABLE DIRTY LEDGER MARKER REMAINS/,
      label,
    );
  }
});

test('C2B-M005-B1-R3: an undetermined marker write is UNKNOWN, and stays unknown', async () => {
  // `bounded` collapses a rejection and a deadline into one failure, and even a definite
  // client-side rejection cannot prove the server did not apply the row before the answer was
  // lost. Reporting `not_written` here would be the same unearned certainty this stage removes.
  const { deps, rec } = await r1Deps({ behaviour: { 'insert_dirty:005': 'throw' } });
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec) });
  assert.equal(report.dirtyMarkerWrite, 'unknown');
  assert.equal(classifyLedgerMarker(report), 'unknown');
  const verdict = String(classifyManagedApplyRefusal('apply(up)', {
    ...report, ledgerMarker: 'unknown', teardown: { completed: true, code: null },
  }));
  assert.match(verdict, /LEDGER MARKER STATE IS UNKNOWN/);
  assert.ok(!/DURABLE DIRTY LEDGER MARKER REMAINS/.test(verdict), 'unknown is not narrowed to dirty');
});

test('C2B-M005-B1-R3: connection disposal neither clears nor downgrades the marker', async () => {
  // Destroying the connection abandons the OPEN BRACKET. The marker committed before that bracket
  // opened, so no disposal outcome is evidence about it — in either direction.
  const resolved = await r1Deps();
  const a = await runTrustedApply({
    ...resolved.deps,
    preCommitPolicy: r1PreCommit(resolved.rec, { rows: R1_GLOBAL_TABLE_GRANT }),
  });
  assert.equal(a.disposal, 'terminated', 'the destroy call succeeded');
  assert.equal(classifyLedgerMarker(a), 'durable_dirty', 'a resolved disposal clears nothing');

  const failed = await r1Deps({ behaviour: { terminate: 'throw' } });
  const b = await runTrustedApply({
    ...failed.deps,
    preCommitPolicy: r1PreCommit(failed.rec, { rows: R1_GLOBAL_TABLE_GRANT }),
  });
  assert.equal(b.disposal, 'none', 'the destroy call failed');
  assert.equal(classifyLedgerMarker(b), 'durable_dirty', 'a failed disposal downgrades nothing');
  // Both verdicts still carry the marker clause, and the failed one ALSO carries its own residual.
  for (const r of [a, b]) {
    assert.match(
      String(classifyManagedApplyRefusal('apply(up)', {
        ...r, ledgerMarker: classifyLedgerMarker(r), teardown: { completed: true, code: null },
      })),
      /DURABLE DIRTY LEDGER MARKER REMAINS/,
    );
  }
});

test('C2B-M005-B1-R3: an UNKNOWN commit cannot claim either a dirty or a clean ledger', async () => {
  const { deps, rec } = await r1Deps({ behaviour: { commit_tx: 'throw' } });
  const report = await runTrustedApply({ ...deps, preCommitPolicy: r1PreCommit(rec) });
  assert.equal(report.commit.submitted, true, 'COMMIT went on the wire');
  assert.equal(report.commit.resolved, false, 'and its answer never came back');
  assert.equal(report.dirtyMarkerWrite, 'succeeded');
  assert.equal(classifyLedgerMarker(report), 'unknown', 'the finalize inside that bracket is undetermined');
  assert.equal(classifyApplyMutationState(report), 'commit_failed_or_unknown', 'and the mutation state agrees');
});

test('C2B-M005-B1-R3: a verified clean read-back is the ONLY route to clean_verified', async () => {
  const { deps, rec } = await r1Deps();
  const ok = await runTrustedApply({
    ...deps,
    preCommitPolicy: r1PreCommit(rec),
    postCommitPolicy: async () => null,
  });
  assert.equal(ok.outcome, 'complete');
  assert.equal(ok.commit.readBackVerified, true);
  assert.equal(classifyLedgerMarker(ok), 'clean_verified');
  assert.equal(classifyManagedApplyRefusal('apply(up)', {
    ...ok, ledgerMarker: classifyLedgerMarker(ok), teardown: { completed: true, code: null },
  }), null, 'the fully evidenced run is still the only one with no refusal');

  // A post-commit ACL failure does not falsify the LEDGER evidence — but it does withhold the
  // read-back, so the ledger state becomes unknown rather than clean. The two are separate facts
  // and neither is allowed to answer for the other.
  const { deps: d2, rec: r2 } = await r1Deps();
  const bad = await runTrustedApply({
    ...d2,
    preCommitPolicy: r1PreCommit(r2),
    postCommitPolicy: async () => EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED,
  });
  assert.equal(bad.code, EXECUTOR_CODES.MANAGED_APPLY_POSTCONDITION_FAILED);
  assert.equal(bad.dirtyMarkerWrite, 'succeeded', 'the ledger observation is untouched by the ACL verdict');
  assert.equal(bad.commit.readBackVerified, false);
  assert.equal(classifyLedgerMarker(bad), 'unknown');
});

test('C2B-M005-B1-R3: the throw-site converter preserves a known code and collapses anything else', () => {
  // The CLI's catches key on the executor error type, so a bounded code only survives if it is
  // wearing that type by the time it is thrown. This is the conversion that puts it there.
  assert.equal(boundedExecutorError(ENGINE_CODES.UNRESOLVED_DIRTY_ATTEMPT, 'x').code,
    ENGINE_CODES.UNRESOLVED_DIRTY_ATTEMPT, 'a real ledger failure keeps its identity');
  assert.equal(boundedExecutorError(ENGINE_CODES.EXECUTION_STEP_TIMEOUT).code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT);
  for (const hostile of ['select * from secrets where pw=hunter2', 'postgres://u:hunter2@h/db', undefined, {}, 42]) {
    const e = boundedExecutorError(hostile, 'x');
    assert.equal(e.code, EXECUTOR_CODES.PORT_FAILED, JSON.stringify(hostile) ?? 'undefined');
    assert.ok(!/hunter2|select |postgres:\/\//.test(e.message), `nothing rides out: ${e.message}`);
  }
});

test('C2B-M005-B1-R3: a known bounded ledger code is recognised; anything else is not', () => {
  // The CLI collapsed `unresolved_dirty_attempt` — the follow-on state of a durable marker — into
  // the operator-GATE code, so an operator could not tell it from "you did not satisfy the gates".
  assert.equal(isKnownBoundedCode(ENGINE_CODES.UNRESOLVED_DIRTY_ATTEMPT), true);
  assert.equal(isKnownBoundedCode(ENGINE_CODES.EXECUTION_STEP_TIMEOUT), true);
  assert.equal(isKnownBoundedCode(EXECUTOR_CODES.MANAGED_PRECOMMIT_BLOCKER_PRESENT), true);
  // An ALLOWLIST, not a passthrough: a `code` property is caller-controlled.
  for (const hostile of [
    'select * from secrets where pw=hunter2', 'postgres://u:hunter2@h/db', '', 'DROP',
    null, undefined, 42, {}, ['unresolved_dirty_attempt'],
  ]) {
    assert.equal(isKnownBoundedCode(hostile), false, JSON.stringify(hostile) ?? 'undefined');
  }
});

test('C2B-M005-B1-R3: a COMMIT with no marker ever written refuses as a bypassed choreography', () => {
  // STRUCTURALLY UNREACHABLE on the managed path — `insert_dirty` precedes `open_tx` in the
  // kernel's `required` grammar — and therefore exactly the state that must not pass silently.
  // The same argument the pre-commit flag already makes: the graver reading of a clean-looking
  // report is that the ordering was bypassed, and a verdict must not be the last thing to notice.
  const evidence = {
    outcome: 'complete' as const,
    code: null,
    commit: { submitted: true, resolved: true, acknowledged: 'unavailable' as const, readBackVerified: true },
    lockRelease: 'verified' as const,
    preCommitVerified: true,
    disposal: 'terminated' as const,
    teardown: { completed: true, code: null },
  };
  const bypassed = classifyManagedApplyRefusal('apply(up)', { ...evidence, ledgerMarker: 'not_written' });
  assert.ok(bypassed !== null, 'a committed run with no marker must not pass');
  assert.match(bypassed, /NO DIRTY LEDGER MARKER WAS WRITTEN/);
  // And the ordinary early refusal — nothing written because nothing ran — keeps its silence here:
  // it is already refused by its own code, and there is no ledger residue to disclose.
  const early = classifyManagedApplyRefusal('apply(up)', {
    ...evidence,
    outcome: 'failed',
    commit: { submitted: false, resolved: false, acknowledged: 'unavailable', readBackVerified: false },
    ledgerMarker: 'not_written',
  });
  assert.ok(!/NO DIRTY LEDGER MARKER WAS WRITTEN/.test(String(early)),
    'a pre-marker refusal has no ledger residue to report');
  assert.match(String(early), /did not complete/, 'and is still refused on its own terms');
});

test('C2B-M005-B1-R3: durable_dirty is spoken only for the commit outcome that entails it', () => {
  // NOT A FALL-THROUGH. The strongest negative claim in this vocabulary is reached by naming the
  // one outcome that earns it, so a future fourth commit outcome degrades to `unknown` instead of
  // inheriting a certainty. This pins the branch, not just the current three-value cross-product.
  const written = { dirtyMarkerWrite: 'succeeded' as const };
  const not_submitted = { submitted: false, resolved: false, acknowledged: 'unavailable' as const, readBackVerified: false };
  assert.equal(classifyLedgerMarker({ ...written, commit: not_submitted }), 'durable_dirty');
  // Every other reachable outcome must NOT be durable_dirty.
  for (const commit of [
    { ...not_submitted, submitted: true },
    { ...not_submitted, submitted: true, resolved: true },
    { ...not_submitted, submitted: true, resolved: true, readBackVerified: true },
  ]) {
    assert.notEqual(classifyLedgerMarker({ ...written, commit }), 'durable_dirty', JSON.stringify(commit));
  }
  // And `applyCommitOutcome` is the only thing that decides which of the three it is, so the pin
  // above is a pin on that function's contract too.
  assert.equal(applyCommitOutcome(not_submitted), 'not_submitted');
});

// ---------------------------------------------------------------------------
// C2B-M005-P2-B0 — the snapshot bracket added for the comprehensive migration-005 preflight.
//
// WHAT IS PROVED HERE. The port is a contract, not an implementation detail: the comprehensive
// preflight's entire "one database state" claim rests on the bracket declaring REPEATABLE READ and
// READ ONLY in ONE statement, on the level being reported by the SERVER rather than assumed, and on
// the port carrying no commit entry point. Each is asserted against the source of the single
// implementation, because that implementation is closure-scoped inside `createManagedDevExecutor`
// and cannot be constructed here without a real connection.
// ---------------------------------------------------------------------------

const readExecutorSource = async (): Promise<string> => {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL('./migrationExecutor.ts', import.meta.url), 'utf8');
};

/**
 * Executable lines only.
 *
 * The negative assertions below are claims about what the port DOES. A comment explaining WHY
 * `set transaction read only` is not issued after `begin` is evidence for the contract, not a
 * violation of it, and matching it would make the assertion punish the explanation.
 */
const executableLines = (body: string): string =>
  body.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

test('C2B-M005-P2-B0: the snapshot bracket declares isolation and read-only in ONE statement', async () => {
  const src = await readExecutorSource();
  const start = src.indexOf('const snapshotTx: SnapshotTxPort = {');
  assert.ok(start > 0, 'the snapshot port implementation must exist');
  const end = src.indexOf('return { adapter, ledger, catalog', start);
  assert.ok(end > start);
  const body = executableLines(src.slice(start, end));

  // ONE STATEMENT. `set transaction read only` issued after `begin` would leave a window in which
  // the bracket is open and writable, and a reader of the record could not tell the two apart.
  assert.ok(body.includes("'begin transaction isolation level repeatable read, read only'"), body);
  assert.ok(!/set\s+transaction\s+read\s+only/.test(body), 'read-only must not be set after begin');

  // THE SERVER'S OWN VIEW, both times. A port answering from a constant would certify a level it
  // never asked the server about.
  assert.ok(body.includes("'show transaction_isolation'"));
  assert.ok(body.includes("'show transaction_read_only'"));

  // NO COMMIT, AND NO SECOND BACKEND. `finish` is the only exit and every statement goes through
  // `requireConn()`, which throws rather than opening another connection.
  assert.ok(body.includes("finish: async () => { await requireConn().unsafe('rollback'); }"));
  assert.ok(!/commit/i.test(body), 'the snapshot port must have no commit entry point');
  assert.equal((body.match(/requireConn\(\)/g) ?? []).length, 5,
    'every snapshot statement must go through requireConn()');
});

test('C2B-M005-P2-B0: an unreadable isolation level is the empty string, never a guess', async () => {
  const src = await readExecutorSource();
  const start = src.indexOf('isolationLevel: async () => {');
  assert.ok(start > 0);
  const body = executableLines(src.slice(start, src.indexOf('finish:', start)));
  // A non-string result must not be coerced into a level, and the caller compares against the
  // required literal, so '' can never satisfy it.
  assert.ok(body.includes("typeof v === 'string' ? v : ''"), body);
  assert.ok(!/repeatable read/.test(body), 'the port must not name the level it expects');
});

test('C2B-M005-P2-B0: the snapshot port is additive — the accepted read-only bracket is unchanged', async () => {
  const src = await readExecutorSource();
  const start = src.indexOf('const readOnlyTx: ReadOnlyTxPort = {');
  assert.ok(start > 0);
  // Sliced to the END OF THE OBJECT LITERAL, not to the next declaration: the snapshot port's own
  // explanatory comment sits between the two and is not part of the accepted port.
  const body = executableLines(src.slice(start, src.indexOf('\n  };', start)));
  // The accepted default-ACL diagnostic keeps the server default isolation. Widening the shared port
  // would silently change that accepted diagnostic's semantics without touching its file.
  assert.ok(body.includes("begin: async () => { await requireConn().unsafe('begin transaction read only'); }"));
  assert.ok(!/isolation/i.test(body), 'the accepted bracket must not have gained an isolation clause');
  assert.ok(!/isolationLevel/.test(body), 'the accepted port must not have gained a new member');
});

test('C2B-M005-P2-B0: the handle exposes the snapshot port and nothing else new', async () => {
  const src = await readExecutorSource();
  const ret = src.match(/return \{ adapter, ledger, catalog, ([^}]*)\};/);
  assert.ok(ret !== null);
  assert.equal(ret[1].trim(), 'readOnlyTx, snapshotTx, write, ownerAcl, dispose: disposeReporting');

  // DECLARED, NOT OPTIONAL. `snapshotTx?: SnapshotTxPort` type-checks and keeps every source-text
  // pin above satisfied, but it makes the port something a caller must narrow — and the obvious
  // narrowing is a fallback to the READ COMMITTED bracket, which is precisely the one-snapshot
  // guarantee the comprehensive preflight rests on. An optional port is a silently weaker contract.
  const handle = src.slice(
    src.indexOf('export interface ManagedDevExecutorHandle'),
    src.indexOf('export interface TeardownResult'),
  );
  assert.ok(handle.includes('  snapshotTx: SnapshotTxPort;'), 'the snapshot port must be required');
  assert.ok(!/snapshotTx\?:/.test(handle), 'and must never become optional');
  assert.ok(handle.includes('  readOnlyTx: ReadOnlyTxPort;'), 'the accepted port stays required too');
});
