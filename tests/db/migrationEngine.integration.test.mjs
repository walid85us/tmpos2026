// Phase 4.0 M3 S1b — trusted executor against a REAL disposable PostgreSQL.
//
// Everything here runs against a throwaway `tmpos_s1b_*` database: locally a cluster this
// harness creates on a task-owned Unix socket, in CI the workflow's disposable loopback
// service. No managed provider, no persistent application database, and no ambient application
// DSN is ever consulted — the executor itself refuses anything that is not a disposable local
// target.
//
// These are the properties a fake port cannot prove: that the advisory lock is genuinely
// SESSION-scoped and survives a per-file commit, that the backend PID is genuinely stable
// across those commits, that a dirty marker is genuinely DURABLE after a rolled-back schema
// transaction, and that a rerun is genuinely idempotent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
  EXECUTOR_CODES,
} from '../../server/platform-identity/migrationExecutor.ts';
import { ENGINE_CODES, createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';

const LOCK_KEY = 720100301;
const CREDENTIAL = { purpose: 'migration', migratorRef: 's1b-migrator', runtimeRef: 's1b-runtime' };
const NOW = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// cluster lifecycle — one disposable target for the whole file
// ---------------------------------------------------------------------------

/** CI supplies its own disposable loopback service; locally we create the cluster ourselves. */
const ambientTestDsn = process.env.TM_POS_TEST_DATABASE_URL;
let cluster = null;
let TARGET_DSN = null;
/** Driver options the observer connection needs; a socket target must be told its path. */
let CLIENT_OPTS = {};

if (typeof ambientTestDsn === 'string' && ambientTestDsn.trim() !== '') {
  TARGET_DSN = ambientTestDsn.trim();
} else if (localPostgresAvailable()) {
  cluster = startDisposablePostgres();
  TARGET_DSN = cluster.dsn;
  CLIENT_OPTS = cluster.clientOptions;
} else {
  throw new Error(
    'S1b INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

/** `host`/`user` are libpq TRANSPORT parameters; the driver would forward them to the server as
 *  startup settings and the connection would be refused. They travel in CLIENT_OPTS instead. */
function driverDsn(raw) {
  const u = new URL(raw);
  u.searchParams.delete('host');
  u.searchParams.delete('user');
  return u.toString();
}

/** A SECOND, independent connection used only for out-of-band assertions. max:1 keeps every
 *  probe on ONE backend, which an advisory-lock observation depends on. */
const observer = postgres(driverDsn(TARGET_DSN), { max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS });

const fixtureDirs = [];

test.after(async () => {
  await observer.end({ timeout: 5 }).catch(() => {});
  for (const d of fixtureDirs) rmSync(d, { recursive: true, force: true });
  if (cluster !== null) {
    const life = cluster.stop();
    assert.equal(life.stopped, true, 'the task-created PostgreSQL process must be stopped');
    assert.equal(life.removed, true, 'the task-created temporary directory must be removed');
  }
});

// ---------------------------------------------------------------------------
// migration fixtures — written into a throwaway directory, never the repository
// ---------------------------------------------------------------------------

function fixtures(files) {
  const dir = mkdtempSync(join(tmpdir(), 's1b-mig-'));
  fixtureDirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return createNodeFsPort(dir, 'tests/db/fixtures');
}

const TWO_GOOD = {
  '001_alpha_table.up.sql': 'create table if not exists s1b_alpha (id int primary key);\n',
  '001_alpha_table.down.sql': 'drop table if exists s1b_alpha;\n',
  '002_beta_table.up.sql': 'create table if not exists s1b_beta (id int primary key);\n',
  '002_beta_table.down.sql': 'drop table if exists s1b_beta;\n',
};
const ONE_BROKEN = {
  '001_gamma_table.up.sql': 'create table if not exists s1b_gamma (id int primary key);\nselect 1/0;\n',
  '001_gamma_table.down.sql': 'drop table if exists s1b_gamma;\n',
};

/** Reset the disposable database between cases: the ledger and every fixture table. */
async function resetTarget() {
  await observer.unsafe('drop table if exists public.schema_migrations, s1b_alpha, s1b_beta, s1b_gamma cascade');
}

/**
 * Run one apply against the disposable target. `wrapSession` and `wrapLedger` let a case observe
 * the real ports without changing what the executor does.
 */
async function applyWith(fsPort, opts = {}) {
  const dsn = assertDisposableTestDsn(TARGET_DSN);
  const handle = await createPostgresExecutor(dsn);
  const adapter = opts.wrapSession
    ? {
        reserve: async (mode) => opts.wrapSession(await handle.adapter.reserve(mode)),
        cancelReserve: handle.adapter.cancelReserve,
      }
    : handle.adapter;
  try {
    return await runTrustedApply({
      fsPort,
      adapter,
      ledger: opts.wrapLedger ? opts.wrapLedger(handle.ledger) : handle.ledger,
      connectionMode: 'session',
      credential: CREDENTIAL,
      lockKey: opts.lockKey ?? LOCK_KEY,
      now: NOW,
      deadlineMs: opts.deadlineMs ?? 20000,
      transactionModeByVersion: opts.transactionModeByVersion,
    });
  } finally {
    await handle.dispose();
  }
}

// ---------------------------------------------------------------------------
// 28: only the disposable database is ever reached
// ---------------------------------------------------------------------------

test('S1b-28: only a disposable tmpos_s1b_ database is reachable, and it is the one in use', async () => {
  const dsn = assertDisposableTestDsn(TARGET_DSN);
  assert.match(dsn.database, /^tmpos_s1b_/, 'the target database must be disposable by name');
  const [{ current_database: live }] = await observer`select current_database()`;
  assert.equal(live, dsn.database, 'the connection really is bound to the disposable database');
  // The same validator refuses a managed endpoint outright, with no connection attempt.
  assert.throws(
    () => assertDisposableTestDsn('postgres://u:p@db.prod-managed.example.com:5432/tmpos_s1b_x'),
    (e) => e.code === EXECUTOR_CODES.TEST_DSN_HOST_NOT_LOCAL,
  );
});

// ---------------------------------------------------------------------------
// 11, 15: dirty-before-schema, and one stable backend across per-file commits
// ---------------------------------------------------------------------------

test('S1b-11+15: the dirty marker commits BEFORE schema execution; the backend PID never changes', async () => {
  await resetTarget();
  const identityTokens = [];
  const markerVisibleAt = [];

  const report = await applyWith(fixtures(TWO_GOOD), {
    wrapSession: (s) => ({
      ...s,
      backendIdentity: async () => {
        const id = await s.backendIdentity();
        identityTokens.push(id.token);
        return id;
      },
    }),
    wrapLedger: (real) => ({
      readLedger: (s) => real.readLedger(s),
      insertDirtyAttempt: async (s, row) => {
        await real.insertDirtyAttempt(s, row);
        // OUT OF BAND, on a DIFFERENT connection: the marker must already be visible, which is
        // only true if it committed in its own transaction before any schema work began.
        const rows = await observer`select dirty from public.schema_migrations where version = ${row.version}`;
        markerVisibleAt.push({ version: row.version, visible: rows.length === 1, dirty: rows[0]?.dirty });
      },
      finalizeApplied: (s, row, txScoped) => real.finalizeApplied(s, row, txScoped),
    }),
  });

  assert.equal(report.outcome, 'complete', `apply failed: ${report.code}`);
  assert.deepEqual(report.applied, ['001', '002']);
  assert.equal(report.disposal, 'closed', 'a fully verified run closes cleanly');

  for (const seen of markerVisibleAt) {
    assert.equal(seen.visible, true, `the dirty marker for ${seen.version} must be committed and visible`);
    assert.equal(seen.dirty, true, `the marker for ${seen.version} must be dirty before schema work`);
  }
  // capture + verify points: at least one per migration block plus the framing checks.
  assert.ok(identityTokens.length >= 8, `expected many identity checks, got ${identityTokens.length}`);
  assert.equal(new Set(identityTokens).size, 1, 'ONE backend served the entire run, including every per-file commit');
  assert.match(identityTokens[0], /^pid:\d+$/, 'the identity token is the real backend pid');

  const applied = await observer`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(applied.map((r) => [r.version, r.dirty]), [['001', false], ['002', false]]);
  const [t] = await observer`select to_regclass('public.s1b_alpha') is not null as a,
                                    to_regclass('public.s1b_beta') is not null as b`;
  assert.equal(t.a, true, 'migration 001 really created its table');
  assert.equal(t.b, true, 'migration 002 really created its table');
});

test('S1b-19: a successful rerun is idempotent — nothing pending, no second write', async () => {
  // Self-contained: establish the applied state here rather than inheriting it from whichever
  // test happened to run before, so an upstream failure cannot cascade into a misleading one here.
  await resetTarget();
  const first = await applyWith(fixtures(TWO_GOOD));
  assert.equal(first.outcome, 'complete', first.code ?? '');
  const before = await observer`select version, checksum, finished_at from public.schema_migrations order by version`;
  const report = await applyWith(fixtures(TWO_GOOD));
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.deepEqual(report.applied, [], 'a rerun applies nothing');
  assert.deepEqual(report.executedChecksums, [], 'a rerun executes no SQL');
  const after = await observer`select version, checksum, finished_at from public.schema_migrations order by version`;
  assert.deepEqual(
    after.map((r) => [r.version, r.checksum, String(r.finished_at)]),
    before.map((r) => [r.version, r.checksum, String(r.finished_at)]),
    'the ledger is byte-for-byte unchanged by an idempotent rerun',
  );
});

// ---------------------------------------------------------------------------
// 14b: the run lock is genuinely SESSION-scoped across a per-file commit
// ---------------------------------------------------------------------------

test('S1b-14b: the run lock is SESSION-scoped — still held after each per-file commit', async () => {
  await resetTarget();
  const stolenAtFinalize = [];
  const report = await applyWith(fixtures(TWO_GOOD), {
    wrapLedger: (real) => ({
      readLedger: (s) => real.readLedger(s),
      insertDirtyAttempt: (s, row) => real.insertDirtyAttempt(s, row),
      finalizeApplied: async (s, row, txScoped) => {
        const out = await real.finalizeApplied(s, row, txScoped);
        // An XACT-scoped lock would already have been released by 001's commit. A SESSION-scoped
        // lock is still held, so this foreign attempt must FAIL.
        const [{ stolen }] = await observer`select pg_try_advisory_lock(${LOCK_KEY}::bigint) as stolen`;
        if (stolen === true) await observer`select pg_advisory_unlock(${LOCK_KEY}::bigint)`;
        stolenAtFinalize.push(stolen === true);
        return out;
      },
    }),
  });
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.equal(stolenAtFinalize.length, 2, 'both per-file finalize points were observed');
  assert.deepEqual(stolenAtFinalize, [false, false], 'the run lock was never stealable mid-run');
});

// ---------------------------------------------------------------------------
// 12, 13: a mid-file failure leaves a DURABLE dirty marker that blocks the rerun
// ---------------------------------------------------------------------------

test('S1b-12: a mid-file failure leaves a DURABLE dirty marker after the schema transaction rolls back', async () => {
  await resetTarget();
  const report = await applyWith(fixtures(ONE_BROKEN));
  assert.equal(report.outcome, 'failed', 'a failing migration must fail the run');
  assert.equal(report.disposal, 'terminated', 'the session is destroyed, never pooled');

  const rows = await observer`select version, dirty, finished_at from public.schema_migrations`;
  assert.equal(rows.length, 1, 'the dirty marker survived the rolled-back schema transaction');
  assert.equal(rows[0].version, '001');
  assert.equal(rows[0].dirty, true, 'the marker is still dirty');
  assert.equal(rows[0].finished_at, null, 'the run never finalized');
  const [{ present }] = await observer`select to_regclass('public.s1b_gamma') is not null as present`;
  assert.equal(present, false, 'the partial schema change rolled back with its transaction');
});

test('S1b-13: an unresolved dirty marker blocks an ordinary rerun before any effect', async () => {
  // Self-contained: create the dirty marker in this test rather than inheriting it.
  await resetTarget();
  const failed = await applyWith(fixtures(ONE_BROKEN));
  assert.equal(failed.outcome, 'failed', 'precondition: the first attempt must fail dirty');
  const report = await applyWith(fixtures(ONE_BROKEN));
  assert.equal(report.outcome, 'refused');
  assert.equal(report.code, ENGINE_CODES.UNRESOLVED_DIRTY_ATTEMPT);
  assert.deepEqual(report.executedChecksums, [], 'a dirty ledger admits no SQL at all');
});

// ---------------------------------------------------------------------------
// 14: a concurrent holder excludes the executor
// ---------------------------------------------------------------------------

test('S1b-14: a concurrent holder of the run lock excludes the executor', async () => {
  await resetTarget();
  const holder = postgres(driverDsn(TARGET_DSN), { max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS });
  const held = await holder.reserve();
  try {
    const [{ locked }] = await held`select pg_try_advisory_lock(${LOCK_KEY}::bigint) as locked`;
    assert.equal(locked, true, 'the fixture must hold the run lock');
    const report = await applyWith(fixtures(TWO_GOOD));
    assert.equal(report.outcome, 'failed');
    assert.equal(report.code, ENGINE_CODES.RUN_LOCK_UNAVAILABLE, 'a second runner must be excluded');
    assert.deepEqual(report.executedChecksums, [], 'an excluded runner executes no SQL');
  } finally {
    await holder.end({ timeout: 0 }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 16: backend identity drift fails closed and disposes the session
// ---------------------------------------------------------------------------

test('S1b-16: a backend identity change fails closed and destroys the session', async () => {
  await resetTarget();
  let reads = 0;
  const report = await applyWith(fixtures(TWO_GOOD), {
    wrapSession: (s) => ({
      ...s,
      backendIdentity: async () => {
        const real = await s.backendIdentity();
        reads += 1;
        // Simulate the run being moved to a different physical backend mid-flight — exactly what
        // a pooler or a silent reconnect would do.
        return reads > 1 ? { token: `${real.token}-moved` } : real;
      },
    }),
  });
  assert.equal(report.outcome, 'failed');
  assert.equal(report.code, ENGINE_CODES.BACKEND_IDENTITY_CHANGED);
  assert.equal(report.disposal, 'terminated', 'a drifted backend must be destroyed, never pooled');
  assert.deepEqual(report.executedChecksums, [], 'no schema statement runs after identity drift');
});

// ---------------------------------------------------------------------------
// 18 against real PostgreSQL: a forbidden-mode migration uses no bracket
// ---------------------------------------------------------------------------

test('S1b-18b: a transaction-forbidden migration applies with no bracket and still finalizes', async () => {
  await resetTarget();
  const report = await applyWith(fixtures(TWO_GOOD), {
    transactionModeByVersion: { '001': 'forbidden', '002': 'forbidden' },
  });
  assert.equal(report.outcome, 'complete', report.code ?? '');
  assert.deepEqual(report.applied, ['001', '002']);
  const rows = await observer`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(rows.map((r) => [r.version, r.dirty]), [['001', false], ['002', false]]);
});

// ---------------------------------------------------------------------------
// no leakage from a real driver
// ---------------------------------------------------------------------------

test('S1b-8b: a real driver failure never leaks SQL, a DSN, or a stack into the report', async () => {
  await resetTarget();
  const report = await applyWith(fixtures(ONE_BROKEN));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('select 1/0'), 'no migration SQL may appear in the report');
  assert.ok(!/postgres:\/\//.test(serialized), 'no DSN may appear in the report');
  assert.ok(!serialized.includes('division by zero'), 'no driver message may appear in the report');
  assert.ok(!serialized.includes(TARGET_DSN), 'the target DSN may never appear');
});

// ---------------------------------------------------------------------------
// the forbidden-mode guarantee and the server-side bounds, proved for real
// ---------------------------------------------------------------------------

const FORBIDDEN_MULTI = {
  '001_multi_forbidden.up.sql':
    "set lock_timeout = '5s';\ncreate index concurrently if not exists s1b_idx on s1b_alpha (id);\n",
  '001_multi_forbidden.down.sql': 'drop index if exists s1b_idx;\n',
};

test('S1b-30b: PostgreSQL really rejects a multi-statement forbidden-mode batch; the executor refuses first', async () => {
  await resetTarget();
  await observer.unsafe('create table if not exists s1b_alpha (id int primary key)');

  // GROUND TRUTH: sent as ONE simple-query batch, PostgreSQL wraps it in an implicit transaction
  // and rejects the concurrent index - even though no BEGIN was ever issued by anyone.
  let raw = 'NO ERROR';
  try {
    await observer.unsafe(FORBIDDEN_MULTI['001_multi_forbidden.up.sql']).simple();
  } catch (e) {
    raw = `${e.code} ${e.message}`;
  }
  assert.match(raw, /^25001 /, `expected SQLSTATE 25001, got: ${raw}`);
  assert.match(raw, /cannot run inside a transaction block/);

  // The executor therefore refuses BEFORE running anything, rather than promising a guarantee
  // that the wire protocol withdraws.
  const report = await applyWith(fixtures(FORBIDDEN_MULTI), {
    transactionModeByVersion: { '001': 'forbidden' },
  });
  assert.equal(report.outcome, 'refused', 'refused at plan time, before any effect');
  assert.equal(report.code, EXECUTOR_CODES.FORBIDDEN_MODE_MULTI_STATEMENT);
  assert.deepEqual(report.executedChecksums, [], 'nothing may execute');
  // The ledger table may not even exist: it is created lazily by the first dirty-marker write,
  // and a plan-time refusal never reaches one. Existence is therefore checked FIRST — a query
  // merely referencing an absent relation still fails at parse time.
  const [{ present }] = await observer`select to_regclass('public.schema_migrations') is not null as present`;
  const written = present ? (await observer`select count(*)::int as n from public.schema_migrations`)[0].n : 0;
  assert.equal(written, 0, 'not even a dirty marker is written');
  await observer.unsafe('drop table if exists s1b_alpha cascade');
});

test('S1b-36: a SINGLE-statement forbidden-mode migration really runs outside any transaction block', async () => {
  await resetTarget();
  await observer.unsafe('create table if not exists s1b_alpha (id int primary key)');
  const CONCURRENT = {
    '001_concurrent_idx.up.sql': 'create index concurrently if not exists s1b_idx on s1b_alpha (id);\n',
    '001_concurrent_idx.down.sql': 'drop index if exists s1b_idx;\n',
  };
  const report = await applyWith(fixtures(CONCURRENT), { transactionModeByVersion: { '001': 'forbidden' } });
  assert.equal(report.outcome, 'complete', `CREATE INDEX CONCURRENTLY must succeed outside a bracket: ${report.code}`);
  const [{ present }] = await observer`select to_regclass('public.s1b_idx') is not null as present`;
  assert.equal(present, true, 'the concurrent index really was created');
  await observer.unsafe('drop table if exists s1b_alpha cascade');
});

test('S1b-37: the SERVER cancels a runaway statement on the executor\'s own session', async () => {
  await resetTarget();
  // A tiny server-side bound against a huge client-side deadline. If the statement dies fast, it
  // can ONLY be PostgreSQL cancelling it — the client is still willing to wait 30 seconds. That
  // is the difference between a bound the server enforces and one this process merely observes.
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN), { statementTimeoutMs: 250 });
  try {
    const session = await handle.adapter.reserve('session');
    await session.confirmLive();
    const started = Date.now();
    let code = 'NO ERROR';
    try {
      await session.executeSql('select pg_sleep(20)', false);
    } catch (e) {
      code = e.code ?? 'unknown';
    }
    const elapsed = Date.now() - started;
    assert.equal(code, '57014', `expected SQLSTATE 57014 (query_canceled), got ${code}`);
    assert.ok(elapsed < 10000, `the server bound must fire long before the client would (${elapsed}ms)`);
  } finally {
    await handle.dispose();
  }
});
