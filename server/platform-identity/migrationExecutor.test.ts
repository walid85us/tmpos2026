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
  resolveDisposableTestDsn,
  assertDisposableTestDsn,
  describeDsn,
  runTrustedApply,
  type ExecutorSession,
  type ExecutorAdapter,
  type ExecutorLedgerPort,
  type TrustedApplyDeps,
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
}

function fakeSession(rec: Recorder, opt: FakeOptions): ExecutorSession {
  let idIdx = 0;
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
    commitTx: async () => { await gate('commit_tx'); rec.txDepth -= 1; },
    executeSql: async (_sql: string, txScoped: boolean) => {
      await gate(`execute:${txScoped ? 'tx' : 'raw'}:depth=${rec.txDepth}`);
    },
    close: async () => { await gate('close'); rec.disposed.push('closed'); },
    terminate: async () => { rec.ops.push('terminate'); rec.disposed.push('terminated'); },
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
    readLedger: async (s) => { rec.ops.push('read_ledger'); rec.sessions.push(s); return ledgerRows; },
    insertDirtyAttempt: async (s, row) => {
      rec.ops.push(`insert_dirty:${row.version}`);
      rec.sessions.push(s);
      const b = opt.behaviour?.[`insert_dirty:${row.version}`];
      if (b === 'throw') throw new Error('ledger exploded');
    },
    finalizeApplied: async (s, row, txScoped) => {
      rec.ops.push(`finalize:${row.version}:${txScoped ? 'tx' : 'raw'}`);
      rec.sessions.push(s);
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
  assert.deepEqual(seq, [
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
  assert.deepEqual(seq, ['insert_dirty:001', 'execute:raw:depth=0', 'finalize:001:raw']);
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
