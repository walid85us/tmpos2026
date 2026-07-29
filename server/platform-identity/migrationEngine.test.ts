// Phase 4.0 M3 S1/S1.1 — migration-engine contract tests. PURE + INJECTED, database-FREE.
//
// No test constructs a database client, reads a connection string, or executes SQL. The
// filesystem is a fake port; the reserved session, ledger, and backend identity are fakes.
// Planning never receives a session/ledger, proving it cannot reach a database.
//
// S1.1 additions: filesystem-integrity (nonregular entries, strict UTF-8), the
// checksum-to-execution artifact binding (single read; execution never re-reads),
// reserved-session cleanup semantics (verified unlock; close-vs-terminate; a potentially
// locked session is never pooled), and the baseline-candidate / append-preserving
// audit-record state model. S1.2: the test-credential purpose fails closed with NO
// caller-suppliable bypass — Boolean, string, structural, and prototype forgeries reject.

import test from 'node:test';
import assert from 'node:assert/strict';
// Used by ONE structural test, to prove no origin/provenance registry remains in the engine source.
import { readFileSync, Stats, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
// A self-contained OS temp fixture for the ONE test that needs a real directory — never a
// hard-coded absolute path, which would pin the suite to one machine and plant an absolute path
// in an authorized file.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Used ONLY to reach the Hash prototype the engine's digest must NOT dispatch through at call time.
import { createHash } from 'node:crypto';

import {
  sha256Hex,
  discoverMigrations,
  pairMigrations,
  computeStatus,
  planApply,
  planBaseline,
  planDirtyResolution,
  isBaselineCandidate,
  assertMigratorCredential,
  assertMigratorConnectionMode,
  isContained,
  createNodeFsPort,
  runMigrations,
  startMigrationExecution,
  stepMigrationExecution,
  assertLedgerTimestamp,
  MigrationEngineError,
  ENGINE_CODES,
  type FsEntryType,
  type MigrationFsPort,
  type MigrationArtifact,
  type ReservedSession,
  type ReservedSessionAdapter,
  type MigrationLedgerPort,
  type SchemaTx,
  type ApplyPlan,
  type EngineCode,
  type LedgerRow,
  type MigrationDescriptor,
  type MigrationPair,
  type RunDeps,
  type ExecutionDeps,
  type ExecutionEffect,
  type ExecutionEvent,
  type ExecutionState,
  type CredentialClassification,
  type CredentialPurpose,
  type ConnectionMode,
  type DiscoverOptions,
} from './migrationEngine';

// --- fakes -----------------------------------------------------------------

function fakeFs(
  files: Record<string, string>,
  relDir = 'server/platform-identity/migrations',
  types: Record<string, FsEntryType> = {},
): MigrationFsPort {
  return {
    relDir,
    list: () => Object.keys(files),
    entryType: (b: string) => types[b] ?? 'file',
    readBytes: (b: string) => new TextEncoder().encode(files[b]),
  };
}

/** Two valid up/down pairs with distinct bytes. */
const TWO_PAIRS = {
  '001_alpha.up.sql': 'create table alpha();\n',
  '001_alpha.down.sql': 'drop table alpha;\n',
  '002_beta.up.sql': 'create table beta();\n',
  '002_beta.down.sql': 'drop table beta;\n',
};

interface Rec { events: string[]; executed: MigrationArtifact[] }
const newRec = (): Rec => ({ events: [], executed: [] });

// F3: a migration credential must declare distinct, non-empty PRIMITIVE migrator/runtime
// references — a bare `{ purpose: 'migration' }` no longer self-asserts the classification.
const CRED: CredentialClassification = { purpose: 'migration', migratorRef: 'migrator-ref', runtimeRef: 'runtime-ref' };

const codeOf = (fn: () => unknown): string => {
  try { fn(); return 'NO_THROW'; } catch (e) { return e instanceof MigrationEngineError ? e.code : `OTHER:${String(e)}`; }
};

// --- S1.7B pure decision-kernel driver -------------------------------------
// The kernel is port-free: a test SIMULATES an executor by answering each emitted inert effect
// with an inert event. No session/ledger/adapter/clock is ever constructed — driving the kernel
// invokes nothing. These helpers replace the fake-port choreography harness.

const execDeps = (
  connectionMode: ConnectionMode = 'session',
  lockKey = 42,
  credential: CredentialClassification = CRED,
): ExecutionDeps => ({ connectionMode, credential, lockKey });

/** Happy-path executor: reserve→reserved, identity→a stable token, lock/unlock→literal true,
 *  every other effect→ok. */
const okEvent = (token = 'pid-1') => (e: ExecutionEffect): ExecutionEvent => {
  switch (e.kind) {
    case 'reserve': return { type: 'reserved' };
    case 'capture_identity':
    case 'verify_identity': return { type: 'identity', identity: { token } };
    case 'acquire_lock': return { type: 'lock', acquired: true };
    case 'release_lock': return { type: 'unlock', released: true };
    default: return { type: 'ok' };
  }
};

/** Drive the kernel to a terminal state, feeding each emitted effect through `respond`. Returns the
 *  ordered emitted effects (and their kinds) plus the terminal state. Bounded against non-termination. */
function driveKernel(
  plan: ApplyPlan,
  deps: ExecutionDeps,
  respond: (effect: ExecutionEffect, index: number) => ExecutionEvent = okEvent(),
): { effects: ExecutionEffect[]; kinds: string[]; state: ExecutionState } {
  let step = startMigrationExecution(plan, deps);
  const emitted: ExecutionEffect[] = [];
  let guard = 0;
  while (step.state.outcome === 'in_progress' && step.effects.length > 0) {
    if (guard++ > 5000) throw new Error('kernel did not terminate');
    const eff = step.effects[0];
    emitted.push(eff);
    step = stepMigrationExecution(step.state, respond(eff, emitted.length - 1));
  }
  return { effects: emitted, kinds: emitted.map((e) => e.kind), state: step.state };
}

// --- discovery + checksums -------------------------------------------------

test('SHA-256 is over exact bytes with no normalization', () => {
  const a = sha256Hex(new TextEncoder().encode('x\n'));
  const b = sha256Hex(new TextEncoder().encode('x'));
  assert.notEqual(a, b);
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('discovery orders by version then up-before-down and checksums each file', () => {
  const ds = discoverMigrations(fakeFs(TWO_PAIRS));
  assert.deepEqual(ds.map((d) => `${d.version}.${d.direction}`), ['001.up', '001.down', '002.up', '002.down']);
  assert.equal(ds[0].checksum, sha256Hex(new TextEncoder().encode(TWO_PAIRS['001_alpha.up.sql'])));
  assert.equal(ds[0].relPath, 'server/platform-identity/migrations/001_alpha.up.sql');
  assert.ok(ds.every((d) => d.transactionMode === 'required'));
});

test('discovery refuses a duplicate (version, direction)', () => {
  const dupPort: MigrationFsPort = {
    relDir: 'x',
    list: () => ['001_a.up.sql', '001_a.up.sql'],
    entryType: () => 'file',
    readBytes: () => new TextEncoder().encode('z'),
  };
  assert.equal(codeOf(() => discoverMigrations(dupPort)), ENGINE_CODES.DUPLICATE_VERSION_DIRECTION);
});

test('discovery refuses a malformed filename', () => {
  assert.equal(codeOf(() => discoverMigrations(fakeFs({ 'nope.sql': 'x' }))), ENGINE_CODES.INVALID_FILENAME);
  assert.equal(codeOf(() => discoverMigrations(fakeFs({ '1_a.up.sql': 'x' }))), ENGINE_CODES.INVALID_FILENAME);
  assert.equal(codeOf(() => discoverMigrations(fakeFs({ '001_A.up.sql': 'x' }))), ENGINE_CODES.INVALID_FILENAME);
});

test('discovery refuses path traversal in a basename', () => {
  for (const bad of ['../001_a.up.sql', 'a/001_a.up.sql', '001_a.up.sql/..']) {
    assert.equal(codeOf(() => discoverMigrations(fakeFs({ [bad]: 'x' }))), ENGINE_CODES.PATH_TRAVERSAL, bad);
  }
});

test('symlink / directory / other (FIFO, socket, device) migration entries are rejected', () => {
  // 'other' models every nonregular lstat type that is not a symlink or directory —
  // FIFO, socket, and device files all map to it in the Node adapter.
  for (const t of ['symlink', 'directory', 'other'] as const) {
    assert.equal(
      codeOf(() => discoverMigrations(fakeFs({ '001_a.up.sql': 'x' }, 'x', { '001_a.up.sql': t }))),
      ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY,
      t,
    );
  }
});

test('invalid UTF-8 migration bytes fail closed with a bounded encoding error', () => {
  const bad: MigrationFsPort = {
    relDir: 'x',
    list: () => ['001_a.up.sql'],
    entryType: () => 'file',
    readBytes: () => new Uint8Array([0x73, 0x71, 0x6c, 0xff, 0xfe]), // invalid UTF-8 sequence
  };
  try {
    discoverMigrations(bad);
    assert.fail('expected an encoding rejection');
  } catch (e) {
    assert.ok(e instanceof MigrationEngineError);
    assert.equal(e.code, ENGINE_CODES.INVALID_ENCODING);
    assert.ok(!e.message.includes('�'), 'no replacement/raw bytes in the error');
  }
});

test('the discovery artifact is frozen and byte-bound: one read, checksum over the exact executed bytes', () => {
  const reads: Record<string, number> = {};
  const first: Record<string, string> = {
    '001_alpha.up.sql': 'create table alpha();\n',
    '001_alpha.down.sql': 'drop table alpha;\n',
  };
  const drifting: MigrationFsPort = {
    relDir: 'migrations',
    list: () => Object.keys(first),
    entryType: () => 'file',
    readBytes: (b: string) => {
      reads[b] = (reads[b] ?? 0) + 1;
      // A second read of the same path returns DIFFERENT bytes — a re-reading engine
      // would bind the checksum to bytes it does not execute (TOCTOU).
      const content = reads[b] === 1 ? first[b] : `-- DRIFTED ${reads[b]}\n`;
      return new TextEncoder().encode(content);
    },
  };
  const ds = discoverMigrations(drifting);
  for (const d of ds) {
    assert.equal(reads[`${d.version}_alpha.${d.direction}.sql`], 1, 'exactly one read per file');
    assert.ok(Object.isFrozen(d.artifact), 'the artifact wrapper is frozen');
    assert.equal(sha256Hex(d.artifact.bytes), d.checksum, 'checksum covers the exact artifact bytes');
    assert.equal(d.artifact.checksum, d.checksum);
    assert.equal(d.artifact.sql, first[`${d.version}_alpha.${d.direction}.sql`], 'sql decoded from the single read');
    // CONTENT immutability, not just a shallow wrapper freeze: bytes accesses return
    // defensive copies, so mutating a returned array cannot touch the checksummed bytes.
    const leaked = d.artifact.bytes;
    leaked[0] ^= 0xff;
    assert.equal(sha256Hex(d.artifact.bytes), d.checksum, 'mutating a returned copy cannot alter the artifact');
  }
});

test('pairing refuses a missing up/down partner', () => {
  const ds = discoverMigrations(fakeFs({ '001_a.up.sql': 'x' }));
  assert.equal(codeOf(() => pairMigrations(ds)), ENGINE_CODES.MISSING_PAIR);
});

test('pairing refuses up/down files whose names disagree', () => {
  // 001_alpha.up.sql + 001_beta.down.sql must NOT be silently accepted as a pair.
  const ds = discoverMigrations(fakeFs({ '001_alpha.up.sql': 'x', '001_beta.down.sql': 'y' }));
  assert.equal(codeOf(() => pairMigrations(ds)), ENGINE_CODES.PAIR_MISMATCH);
});

test('pairing refuses up/down files whose transaction modes disagree', () => {
  const ds = discoverMigrations(fakeFs({ '001_a.up.sql': 'x', '001_a.down.sql': 'y' }));
  // Force a mode split by hand: only the up is 'forbidden'.
  const split = [{ ...ds[0], transactionMode: 'forbidden' as const }, ds[1]];
  assert.equal(codeOf(() => pairMigrations(split)), ENGINE_CODES.PAIR_MISMATCH);
});

test('a forbidden-transaction mode is honored via the explicit contract', () => {
  const ds = discoverMigrations(fakeFs(TWO_PAIRS), { transactionModeByVersion: { '002': 'forbidden' } });
  const pairs = pairMigrations(ds);
  assert.equal(pairs.find((p) => p.version === '001')!.transactionMode, 'required');
  assert.equal(pairs.find((p) => p.version === '002')!.transactionMode, 'forbidden');
});

// --- state model + planning (no session/ledger port -> cannot reach a DB) ---

const PAIRS = () => pairMigrations(discoverMigrations(fakeFs(TWO_PAIRS)));

test('planning operations reach no database and require no credential (pure over snapshots)', () => {
  const pairs = PAIRS();
  assert.equal(computeStatus(pairs, []).length, 2);
  assert.equal(planApply(pairs, []).pending.length, 2);
  assert.equal(planBaseline(pairs, [], ['001', '002']).versions.length, 2);
});

test('computeStatus classifies applied / unapplied / checksum mismatch', () => {
  const pairs = PAIRS();
  const applied: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: false, resolution: null }];
  const st = computeStatus(pairs, applied);
  assert.equal(st.find((s) => s.version === '001')!.state, 'applied');
  assert.equal(st.find((s) => s.version === '002')!.state, 'unapplied');
  const drift: LedgerRow[] = [{ version: '001', checksum: 'deadbeef', dirty: false, resolution: null }];
  assert.equal(computeStatus(pairs, drift).find((s) => s.version === '001')!.state, 'checksum_mismatch');
});

test('a checksum mismatch outranks a resolution (an altered historical file always blocks)', () => {
  const pairs = PAIRS();
  const resolution = planDirtyResolution({ version: '001', reasonCategory: 'x', correctiveRef: '003', at: '2026-01-01T00:00:00.000Z' });
  // Dirty + resolved BUT the stored checksum no longer matches the file → checksum_mismatch, not failed_resolved.
  const drifted: LedgerRow[] = [{ version: '001', checksum: 'deadbeef', dirty: true, resolution }];
  assert.equal(computeStatus(pairs, drifted).find((s) => s.version === '001')!.state, 'checksum_mismatch');
  assert.equal(codeOf(() => planApply(pairs, drifted)), ENGINE_CODES.CHECKSUM_MISMATCH);
});

test('planApply refuses on an applied checksum mismatch', () => {
  const pairs = PAIRS();
  const drift: LedgerRow[] = [{ version: '001', checksum: 'deadbeef', dirty: false, resolution: null }];
  assert.equal(codeOf(() => planApply(pairs, drift)), ENGINE_CODES.CHECKSUM_MISMATCH);
});

test('planApply refuses while an unresolved dirty attempt exists', () => {
  const pairs = PAIRS();
  const dirty: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: true, resolution: null }];
  assert.equal(codeOf(() => planApply(pairs, dirty)), ENGINE_CODES.UNRESOLVED_DIRTY_ATTEMPT);
});

test('planApply refuses a ledger row for an unknown (undiscovered) version', () => {
  const pairs = PAIRS();
  const unknown: LedgerRow[] = [{ version: '999', checksum: 'x', dirty: false, resolution: null }];
  assert.equal(codeOf(() => planApply(pairs, unknown)), ENGINE_CODES.UNKNOWN_LEDGER_VERSION);
});

test('a resolved dirty attempt is preserved as failed_resolved history, not deleted', () => {
  const pairs = PAIRS();
  const resolution = planDirtyResolution({ version: '001', reasonCategory: 'schema_error', correctiveRef: '003', at: '2026-01-01T00:00:00.000Z' });
  assert.equal(resolution.status, 'resolved_failed');
  const resolved: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: true, resolution }];
  const st = computeStatus(pairs, resolved);
  assert.equal(st.find((s) => s.version === '001')!.state, 'failed_resolved');
  const plan = planApply(pairs, resolved);
  assert.ok(!plan.pending.some((p) => p.version === '001'), 'a resolved failed attempt is not retried');
  assert.deepEqual(plan.pending.map((p) => p.version), ['002']);
});

test('resolution requires a corrective linkage and never edits history', () => {
  assert.equal(
    codeOf(() => planDirtyResolution({ version: '001', reasonCategory: '', correctiveRef: '', at: '' })),
    ENGINE_CODES.INVALID_HISTORY,
  );
});

test('duplicate ledger rows for one version are invalid history', () => {
  const pairs = PAIRS();
  const dupe: LedgerRow[] = [
    { version: '001', checksum: pairs[0].up.checksum, dirty: false, resolution: null },
    { version: '001', checksum: pairs[0].up.checksum, dirty: false, resolution: null },
  ];
  assert.equal(computeStatus(pairs, dupe).find((s) => s.version === '001')!.state, 'invalid_history');
  assert.equal(codeOf(() => planApply(pairs, dupe)), ENGINE_CODES.INVALID_HISTORY);
});

test('status output and engine errors never carry SQL text (the artifact alone does)', () => {
  const sentinel = 'SECRET_SQL_SENTINEL_9f31';
  const pairs = pairMigrations(discoverMigrations(fakeFs({
    '001_a.up.sql': `-- ${sentinel}\ncreate table a();\n`,
    '001_a.down.sql': `-- ${sentinel}\ndrop table a;\n`,
  })));
  assert.ok(pairs[0].up.artifact.sql.includes(sentinel), 'the executable artifact carries the SQL');
  const status = computeStatus(pairs, []);
  assert.ok(!JSON.stringify(status).includes(sentinel), 'status output is SQL-free');
  // The artifact is non-enumerable: serializing descriptors, pairs, or a whole plan is
  // structurally SQL-free — there is no printable route to the SQL text.
  assert.ok(!JSON.stringify(pairs).includes(sentinel), 'serialized pairs are SQL-free');
  assert.ok(!JSON.stringify(planApply(pairs, [])).includes(sentinel), 'a serialized plan is SQL-free');
  try {
    planApply(pairs, [{ version: '001', checksum: 'deadbeef', dirty: false, resolution: null }]);
    assert.fail('expected a checksum refusal');
  } catch (e) {
    assert.ok(e instanceof MigrationEngineError);
    assert.ok(!e.message.includes(sentinel), 'engine errors are SQL-free');
  }
});

// --- baseline ---------------------------------------------------------------

test('baseline refuses a non-empty ledger', () => {
  const pairs = PAIRS();
  const applied: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: false, resolution: null }];
  assert.equal(codeOf(() => planBaseline(pairs, applied, ['001', '002'])), ENGINE_CODES.BASELINE_PRECONDITION_FAILED);
});

test('baseline refuses a version allowlist mismatch and records checksums + postconditions otherwise', () => {
  const pairs = PAIRS();
  assert.equal(codeOf(() => planBaseline(pairs, [], ['001'])), ENGINE_CODES.BASELINE_PRECONDITION_FAILED);
  const plan = planBaseline(pairs, [], ['001', '002']);
  assert.deepEqual(plan.versions.map((v) => v.version), ['001', '002']);
  assert.deepEqual(plan.requiredPostconditions, ['verify_schema_postcondition:001', 'verify_schema_postcondition:002']);
});

test('a baseline plan carries an append-preserving planned operator/audit record', () => {
  const pairs = PAIRS();
  const plan = planBaseline(pairs, [], ['001', '002']);
  assert.deepEqual(plan.plannedAudit, {
    action: 'record_baseline',
    appendOnly: true,
    versions: ['001', '002'],
  });
});

test('baseline candidacy is an explicit pure state: empty ledger + exact allowlist', () => {
  const pairs = PAIRS();
  assert.equal(isBaselineCandidate(pairs, [], ['001', '002']), true);
  assert.equal(isBaselineCandidate(pairs, [], ['001']), false, 'allowlist mismatch is not a candidate');
  const applied: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: false, resolution: null }];
  assert.equal(isBaselineCandidate(pairs, applied, ['001', '002']), false, 'a non-empty ledger is not a candidate');
});

// --- credential + connection boundaries ------------------------------------

test('a runtime-classified credential is rejected; migration is accepted', () => {
  assert.equal(codeOf(() => assertMigratorCredential({ purpose: 'runtime' })), ENGINE_CODES.RUNTIME_CREDENTIAL_REJECTED);
  assert.equal(codeOf(() => assertMigratorCredential({ purpose: 'migration', migratorRef: 'M', runtimeRef: 'R' })), 'NO_THROW');
  // Any unknown purpose is rejected.
  assert.equal(codeOf(() => assertMigratorCredential({ purpose: 'other' as unknown as 'migration' })), ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
});

test('a test-purpose credential is rejected in S1: no caller-suppliable bypass exists', () => {
  assert.equal(codeOf(() => assertMigratorCredential({ purpose: 'test' })), ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
});

test('the removed test-capability bypass stays dead: Boolean, string, structural, and prototype forgeries are all rejected', () => {
  // A generic JavaScript caller may pass ANYTHING as a second argument; none of it may
  // widen the boundary. The signature no longer admits an options parameter, so the
  // forgery is modeled exactly as a JS runtime caller would attempt it — an untyped call.
  const forge = assertMigratorCredential as unknown as (i: CredentialClassification, o?: unknown) => void;
  assert.equal(codeOf(() => forge({ purpose: 'test' }, { allowTestCredential: true })), ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  assert.equal(codeOf(() => forge({ purpose: 'test' }, { allowTestCredential: 'true' })), ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  assert.equal(codeOf(() => forge({ purpose: 'test' }, Object.create({ allowTestCredential: true }))), ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  assert.equal(codeOf(() => forge({ purpose: 'test' }, new Proxy({}, { get: () => true }))), ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  // No second argument of any shape admits runtime either.
  assert.equal(codeOf(() => forge({ purpose: 'runtime' }, { allowTestCredential: true })), ENGINE_CODES.RUNTIME_CREDENTIAL_REJECTED);
});

test('a credential whose purpose varies per read cannot satisfy two guards on two reads', () => {
  // A getter returning 'test' on the first read (dodging the runtime check) and 'migration'
  // on the second (dodging the purpose check) must NOT be admitted — the classification is
  // snapshotted once, so the value that dodges one guard is the value the next guard sees.
  let n = 0;
  const shifty = { get purpose(): CredentialPurpose { n += 1; return n === 1 ? 'test' : 'migration'; } } as CredentialClassification;
  assert.equal(codeOf(() => assertMigratorCredential(shifty)), ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
});

test('a migrator ref that varies per read cannot dodge the equality rejection', () => {
  // Until S1.7F the equality guard INVOKED the getter and compared one snapshot, so a migratorRef
  // returning the runtime value on the first read and a different value on the second could not
  // suppress the rejection. The ref is now taken from its property DESCRIPTOR, so an accessor-backed
  // ref is not a declared primitive reference at all: it is refused WITHOUT the getter ever running.
  // Strictly stronger — caller code no longer executes inside the credential boundary — and still
  // fail-closed, with a coarser code.
  let n = 0;
  const cred = { purpose: 'migration', runtimeRef: 'S', get migratorRef(): string { n += 1; return n === 1 ? 'S' : 'OTHER'; } } as CredentialClassification;
  assert.equal(codeOf(() => assertMigratorCredential(cred)), ENGINE_CODES.INVALID_CREDENTIAL_REF);
  assert.equal(n, 0, 'the accessor-backed ref was never invoked');
});

test('an equal migrator/runtime credential is rejected without leaking the value', () => {
  const leaked = 'sentinel-secret';
  try {
    assertMigratorCredential({ purpose: 'migration', migratorRef: leaked, runtimeRef: leaked });
    assert.fail('expected rejection');
  } catch (e) {
    assert.ok(e instanceof MigrationEngineError);
    assert.equal(e.code, ENGINE_CODES.CREDENTIAL_EQUALITY_REJECTED);
    assert.ok(!e.message.includes(leaked), 'the credential value must not appear in the error');
  }
});

test('a transaction-pool migrator connection mode is refused', () => {
  assert.equal(codeOf(() => assertMigratorConnectionMode('transaction')), ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED);
  assert.equal(codeOf(() => assertMigratorConnectionMode('unknown')), ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED);
  assert.equal(codeOf(() => assertMigratorConnectionMode('direct')), 'NO_THROW');
  assert.equal(codeOf(() => assertMigratorConnectionMode('session')), 'NO_THROW');
});

// --- choreography (fakes) --------------------------------------------------

const twoPlan = (): ApplyPlan => planApply(PAIRS(), []);

/** A hand-built ONE-migration plan whose `version` is caller-chosen but whose artifact is fully
 *  self-consistent (checksum === sha256(bytes) === sha256(utf8(sql))), so the ONLY property under
 *  test is the version grammar on the ledger-bound effect path — not checksum binding. */
const planWithVersion = (version: string, sql = 'create table alpha();\n'): ApplyPlan => {
  const bytes = new TextEncoder().encode(sql);
  const checksum = sha256Hex(bytes);
  const artifact = { version, direction: 'up', checksum, sql, bytes } as unknown as MigrationArtifact;
  const up = { version, direction: 'up', checksum, transactionMode: 'required', artifact } as unknown as MigrationDescriptor;
  return { pending: [{ version, up } as unknown as MigrationPair] } as unknown as ApplyPlan;
};

test('required-transaction choreography (kernel): one reserved session, dirty-before-schema, finalize-in-tx, verified unlock, clean close', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps('session', 42));
  assert.deepEqual(kinds, [
    'reserve', 'capture_identity', 'acquire_lock', 'verify_identity',
    'insert_dirty', 'open_tx', 'verify_identity', 'execute', 'finalize', 'commit_tx', 'verify_identity',
    'insert_dirty', 'open_tx', 'verify_identity', 'execute', 'finalize', 'commit_tx', 'verify_identity',
    'verify_identity', 'release_lock', 'verify_identity', 'close',
  ]);
  assert.equal(kinds.filter((k) => k === 'reserve').length, 1, 'exactly one reservation');
  assert.ok(kinds.indexOf('insert_dirty') < kinds.indexOf('execute'), 'dirty marker before schema execute');
  const o = kinds.indexOf('open_tx'), f = kinds.indexOf('finalize'), c = kinds.indexOf('commit_tx');
  assert.ok(o < f && f < c, 'finalize runs inside the transaction bracket');
  assert.equal(state.outcome, 'complete');
  assert.equal(state.disposition, 'none', 'a fully clean run never terminates the session');
});

test('ledger and execution run on the ONE reserved session (kernel): a single reserve..close bracket, one dirty per migration', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps());
  assert.equal(kinds.filter((k) => k === 'reserve').length, 1, 'exactly one reservation for the whole run');
  assert.equal(kinds.filter((k) => k === 'close').length, 1, 'exactly one clean close');
  assert.equal(kinds.filter((k) => k === 'insert_dirty').length, 2, 'one dirty insert per migration');
  assert.equal(kinds.filter((k) => k === 'finalize').length, 2, 'one finalize per migration');
  assert.equal(state.outcome, 'complete');
  // The single-physical-session invariant (all ledger writes on the same reserved session) is an
  // S1b executor obligation; the kernel emits ONE reserve..close bracket enclosing every ledger effect.
  const r = kinds.indexOf('reserve'), cl = kinds.lastIndexOf('close');
  assert.equal(kinds.slice(r + 1, cl).filter((k) => k === 'insert_dirty' || k === 'finalize').length, 4,
    'every ledger effect falls inside the one reserve..close bracket');
});

test('execution effects carry the canonical checksum-bound SQL (F2), as frozen inert data', () => {
  const plan = twoPlan();
  const { effects } = driveKernel(plan, execDeps());
  const executes = effects.filter((e): e is Extract<ExecutionEffect, { kind: 'execute' }> => e.kind === 'execute');
  assert.equal(executes.length, 2);
  for (const e of executes) {
    const pair = plan.pending.find((p) => p.version === e.version)!;
    // F2: the effect carries a canonical snapshot (read-once, verified) rather than the caller's
    // artifact object, so a getter/proxy/mutable source cannot swap SQL after validation.
    assert.ok(Object.isFrozen(e), 'the execute effect is frozen inert data');
    assert.equal(e.checksum, pair.up.checksum, 'the canonical checksum matches discovery');
    assert.equal(e.direction, 'up');
    assert.equal(e.sql, pair.up.artifact.sql, 'the canonical SQL equals the validated SQL');
    assert.equal(sha256Hex(new TextEncoder().encode(e.sql)), pair.up.checksum, 'the effect SQL hashes to the discovery checksum');
    // The bytes GETTER never leaks into the inert effect — only primitive strings cross.
    assert.equal(typeof (e as unknown as { bytes?: unknown }).bytes, 'undefined', 'no bytes accessor on the effect');
  }
});

test('startMigrationExecution snapshots each descriptor once — a validate-then-swap artifact getter yields only the validated effect', () => {
  // The artifact validated by canonicalization MUST be the artifact bound into the effect. A
  // descriptor whose `artifact` is a getter returning a valid artifact to the validation read and
  // a DIFFERENT one to a later read must not swap the executed bytes (F2/TOCTOU).
  const base = twoPlan();
  const realUp = base.pending[0].up;
  const swap = base.pending[1].up.artifact; // a real but DIFFERENT artifact (distinct checksum)
  let reads = 0;
  const hostileUp = new Proxy(realUp, {
    get(target, prop, recv) {
      if (prop === 'artifact') { reads += 1; return reads === 1 ? realUp.artifact : swap; }
      return Reflect.get(target, prop, recv);
    },
  });
  const plan: ApplyPlan = { pending: [{ ...base.pending[0], up: hostileUp }] };
  const { effects } = driveKernel(plan, execDeps());
  const executes = effects.filter((e): e is Extract<ExecutionEffect, { kind: 'execute' }> => e.kind === 'execute');
  assert.equal(executes.length, 1);
  assert.equal(executes[0].checksum, realUp.checksum, 'the effect binds the validated artifact, never the later swap');
  assert.notEqual(executes[0].checksum, swap.checksum, 'the swapped artifact never reaches an effect');
});

test('the run credential is validated (kernel): a runtime credential refuses before any reserve effect', () => {
  const { state, effects } = startMigrationExecution(twoPlan(), execDeps('session', 42, { purpose: 'runtime' }));
  assert.equal(state.outcome, 'refused');
  assert.equal(state.code, ENGINE_CODES.RUNTIME_CREDENTIAL_REJECTED);
  assert.deepEqual(effects, [], 'no reserve effect on a rejected credential');
});

test('startMigrationExecution rejects a test credential in S1 — a forged capability field on deps changes nothing', () => {
  const a = startMigrationExecution(twoPlan(), execDeps('session', 42, { purpose: 'test' }));
  assert.equal(a.state.outcome, 'refused');
  assert.equal(a.state.code, ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  assert.deepEqual(a.effects, [], 'no reserve effect for a test credential in S1');

  // A JS caller reintroducing the removed Boolean field on the deps object gains nothing: the
  // kernel reads only connectionMode/credential/lockKey, so the run still refuses fail-closed.
  const forged = { ...execDeps('session', 42, { purpose: 'test' }), allowTestCredential: true } as unknown as ExecutionDeps;
  const b = startMigrationExecution(twoPlan(), forged);
  assert.equal(b.state.outcome, 'refused');
  assert.equal(b.state.code, ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  assert.deepEqual(b.effects, [], 'a forged capability field never reaches a reserve effect');
});

test('a plan whose up-slot holds a down descriptor refuses before any reserve (kernel; whole-plan up-front validation)', () => {
  // Substituting pair.up with the genuine down descriptor passes artifact integrity (the down
  // bytes hash to their own checksum), so only the direction/version guard stops rollback SQL.
  // The kernel validates the ENTIRE plan up front, so a bad pair refuses BEFORE any reserve —
  // strictly safer than the legacy mid-run terminate (nothing is reserved, nothing runs).
  const base = twoPlan();
  const swapped = { ...base.pending[0], up: base.pending[0].down };
  const plan: ApplyPlan = { pending: [swapped] };
  const { state, effects } = startMigrationExecution(plan, execDeps());
  assert.equal(state.outcome, 'refused');
  assert.equal(state.code, ENGINE_CODES.PAIR_MISMATCH);
  assert.deepEqual(effects, [], 'no reserve, no execute, no dirty — nothing runs on a refused plan');
});

test('required-transaction failure (kernel): dirty precedes schema, finalize never emitted, verdict is terminate', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'execute' ? { type: 'port_failed' } : okEvent()(e));
  assert.ok(kinds.indexOf('insert_dirty') < kinds.indexOf('execute'), 'dirty marker before schema execute');
  assert.ok(!kinds.includes('finalize'), 'finalize is never emitted on a schema failure');
  // Lock ownership is uncertain after a failure — the physical session must be DESTROYED, never pooled.
  assert.equal(state.outcome, 'failed');
  assert.equal(state.disposition, 'terminate', 'the physical session is terminated after a failure');
  assert.notEqual(state.outcome, 'complete', 'a failed run never reaches the clean close/complete path');
});

test('an injected schema error becomes a bounded inert verdict (kernel): port_failed → PORT_OPERATION_FAILED, no leak', () => {
  const { state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'execute' ? { type: 'port_failed' } : okEvent()(e));
  assert.equal(state.outcome, 'failed');
  assert.equal(state.disposition, 'terminate');
  assert.equal(state.code, ENGINE_CODES.PORT_OPERATION_FAILED, 'a failed port op maps to a bounded code');
  // The verdict is inert DATA carrying only a stable code — never a message, SQL, or driver detail.
  // Stripping a raw driver message before it becomes a `port_failed` event is the S1b executor
  // guard obligation (the same guardPort boundary the pure engine already provides for discovery).
  assert.ok(!/create\s+table|secret|pw/i.test(JSON.stringify(state)), 'the inert verdict carries no raw content');
});

test('forbidden-transaction (kernel): dirty-before-any-statement, identity re-verify between execute and finalize, no tx bracket; failure → terminate', () => {
  const pairs = pairMigrations(discoverMigrations(fakeFs(TWO_PAIRS), { transactionModeByVersion: { '001': 'forbidden', '002': 'forbidden' } }));
  const okPlan = planApply(pairs, []);
  const ok = driveKernel(okPlan, execDeps('direct'));
  assert.ok(!ok.kinds.includes('open_tx') && !ok.kinds.includes('commit_tx'), 'forbidden migrations never open a transaction');
  const d = ok.kinds.indexOf('insert_dirty'), x = ok.kinds.indexOf('execute'), f = ok.kinds.indexOf('finalize');
  assert.ok(d < x && x < f, 'dirty before the irreversible statement, finalize only after');
  assert.ok(ok.kinds.slice(x + 1, f).includes('verify_identity'), 'identity re-verified between the irreversible execute and the finalize');
  assert.equal(ok.state.outcome, 'complete');

  const bad = driveKernel(okPlan, execDeps('direct'), (e) => e.kind === 'execute' ? { type: 'port_failed' } : okEvent()(e));
  assert.ok(bad.kinds.includes('insert_dirty'), 'dirty marker persists after a forbidden-migration failure');
  assert.ok(!bad.kinds.includes('finalize'), 'no finalize on failure');
  assert.equal(bad.state.disposition, 'terminate');
  assert.notEqual(bad.state.outcome, 'complete');
});

test('a changed backend identity fails closed (kernel): BACKEND_IDENTITY_CHANGED, verdict terminate, no finalize', () => {
  let idc = 0;
  const { kinds, state } = driveKernel(twoPlan(), execDeps(), (e) => {
    if (e.kind === 'capture_identity' || e.kind === 'verify_identity') {
      idc += 1;
      return { type: 'identity', identity: { token: idc <= 2 ? 'pid-1' : 'pid-2' } };
    }
    return okEvent()(e);
  });
  assert.equal(state.outcome, 'failed');
  assert.equal(state.code, ENGINE_CODES.BACKEND_IDENTITY_CHANGED);
  assert.equal(state.disposition, 'terminate', 'an identity-changed session is destroyed, never pooled');
  assert.ok(!kinds.includes('finalize'), 'no finalize after an identity change');
});

test('the reserved mode is the validated mode (kernel): a per-read connectionMode getter is read exactly once', () => {
  // The reserve effect must carry the SAME value the connection-mode guard validated: a getter
  // returning 'session' to the validator and 'transaction' later must not slip a pooled mode through.
  let reads = 0;
  const d = {
    credential: CRED, lockKey: 1,
    get connectionMode(): ConnectionMode { reads += 1; return reads === 1 ? 'session' : 'transaction'; },
  } as unknown as ExecutionDeps;
  const { state, effects } = startMigrationExecution(twoPlan(), d);
  assert.equal(state.outcome, 'in_progress');
  assert.equal(effects[0].kind, 'reserve');
  assert.equal((effects[0] as Extract<ExecutionEffect, { kind: 'reserve' }>).connectionMode, 'session',
    'the reserve effect carries the validated mode, never the getter’s later value');
  assert.equal(reads, 1, 'connectionMode is read exactly once');
});

test('the advisory lock uses ONE key (kernel): a per-read lockKey getter is read once; acquire and release carry the same key', () => {
  // acquire and release effects must carry ONE snapshot key: a key differing between acquire and
  // release could unlock a key never held while the acquired lock stays held on a pooled session.
  let reads = 0;
  const d = {
    connectionMode: 'session' as ConnectionMode, credential: CRED,
    get lockKey(): number { reads += 1; return reads === 1 ? 111 : 222; },
  } as unknown as ExecutionDeps;
  const { effects, state } = driveKernel(twoPlan(), d);
  assert.equal(state.outcome, 'complete');
  const acquire = effects.find((e) => e.kind === 'acquire_lock') as Extract<ExecutionEffect, { kind: 'acquire_lock' }>;
  const release = effects.find((e) => e.kind === 'release_lock') as Extract<ExecutionEffect, { kind: 'release_lock' }>;
  assert.equal(acquire.lockKey, 111, 'acquire uses the snapshot key');
  assert.equal(release.lockKey, 111, 'release uses the SAME snapshot key, never a different one');
  assert.equal(reads, 1, 'lockKey is read exactly once');
});

test('a reused+mutated backend identity object is still detected as drift (kernel): tokens captured as primitives', () => {
  // The identity is captured as a PRIMITIVE token, not held as an object: an executor returning one
  // shared identity object and mutating its token after a backend switch must not compare equal.
  const shared = { token: 'pid-1' };
  let calls = 0;
  const { state } = driveKernel(twoPlan(), execDeps(), (e) => {
    if (e.kind === 'capture_identity' || e.kind === 'verify_identity') {
      calls += 1;
      if (calls > 2) shared.token = 'pid-2';
      return { type: 'identity', identity: shared };
    }
    return okEvent()(e);
  });
  assert.equal(state.outcome, 'failed');
  assert.equal(state.code, ENGINE_CODES.BACKEND_IDENTITY_CHANGED, 'a mutated shared identity object cannot keep expected==actual');
  assert.equal(state.disposition, 'terminate', 'a drifted session is destroyed, never pooled');
});

test('an unavailable run lock fails closed (kernel): RUN_LOCK_UNAVAILABLE, no release emitted, verdict terminate', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'acquire_lock' ? { type: 'lock', acquired: false } : okEvent()(e));
  assert.equal(state.outcome, 'failed');
  assert.equal(state.code, ENGINE_CODES.RUN_LOCK_UNAVAILABLE);
  assert.ok(!kinds.includes('release_lock'), 'a lock that was never acquired is never released');
  assert.equal(state.disposition, 'terminate');
});

test('an unlock reporting false fails closed (kernel): RUN_UNLOCK_FAILED, verdict terminate', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'release_lock' ? { type: 'unlock', released: false } : okEvent()(e));
  assert.ok(kinds.includes('release_lock'), 'the unlock was attempted and verified');
  assert.equal(state.code, ENGINE_CODES.RUN_UNLOCK_FAILED);
  assert.equal(state.disposition, 'terminate', 'an uncertain lock state never returns to the pool');
});

test('an unlock that throws is bounded (kernel): port_failed at release_lock → PORT_OPERATION_FAILED, terminate', () => {
  const { state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'release_lock' ? { type: 'port_failed' } : okEvent()(e));
  assert.equal(state.code, ENGINE_CODES.PORT_OPERATION_FAILED);
  assert.equal(state.disposition, 'terminate');
});

test('a close failure escalates to terminate (kernel): close emitted, port_failed → PORT_OPERATION_FAILED, terminate', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'close' ? { type: 'port_failed' } : okEvent()(e));
  assert.ok(kinds.includes('close'), 'the clean close was attempted');
  assert.equal(state.code, ENGINE_CODES.PORT_OPERATION_FAILED);
  assert.equal(state.disposition, 'terminate', 'a cleanup failure escalates to termination');
});

test('a transaction-pool connection mode refuses before any reserve (kernel)', () => {
  const { state, effects } = startMigrationExecution(twoPlan(), execDeps('transaction'));
  assert.equal(state.outcome, 'refused');
  assert.equal(state.code, ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED);
  assert.deepEqual(effects, [], 'no reserve effect on a refused connection mode');
});

test('engine errors are bounded: code-tagged, no SQL body', () => {
  const err = new MigrationEngineError(ENGINE_CODES.CHECKSUM_MISMATCH, '001');
  assert.equal(err.code, 'checksum_mismatch');
  assert.match(err.message, /migration engine refused \(checksum_mismatch\)/);
  assert.ok(!/create\s+table/i.test(err.message));
});

// --- S1.1 review hardenings -------------------------------------------------

test('error subjects are sanitized: control/ANSI bytes stripped, hard length cap', () => {
  const hostile = `${'x'.repeat(500)}\u001b[31mRED\nNEWLINE\u0007`;
  const err = new MigrationEngineError(ENGINE_CODES.PORT_OPERATION_FAILED, hostile);
  const subject = err.message.split(': ')[1] ?? '';
  assert.ok(subject.length <= 120, 'subject is length-capped');
  assert.ok(!/[^\x20-\x7e]/.test(err.message), 'message is printable ASCII only');
  assert.ok(!err.message.includes('\u001b'), 'no ANSI escape survives');
});

test('a foreign throw from ANY filesystem-port method is converted to a bounded code', () => {
  const secret = 'ABSOLUTE:/tmp/secret-dir create table leak(pw text)';
  const throwingRead: MigrationFsPort = {
    relDir: 'x',
    list: () => ['001_a.up.sql'],
    entryType: () => 'file',
    readBytes: () => { throw new Error(secret); },
  };
  const throwingList: MigrationFsPort = {
    relDir: 'x',
    list: () => { throw new Error(secret); },
    entryType: () => 'file',
    readBytes: () => new Uint8Array(),
  };
  for (const port of [throwingRead, throwingList]) {
    try {
      discoverMigrations(port);
      assert.fail('expected a bounded failure');
    } catch (e) {
      assert.ok(e instanceof MigrationEngineError);
      assert.equal(e.code, ENGINE_CODES.PORT_OPERATION_FAILED);
      assert.ok(!e.message.includes('secret-dir'), 'no foreign path leaks');
      assert.ok(!/create\s+table/i.test(e.message), 'no foreign SQL leaks');
    }
  }
});

test('an orphan ledger row (no discovered file) is surfaced as invalid_history, never omitted', () => {
  const pairs = PAIRS();
  const orphan: LedgerRow[] = [{ version: '999', checksum: 'cafe', dirty: false, resolution: null }];
  const st = computeStatus(pairs, orphan);
  const row = st.find((s) => s.version === '999');
  assert.ok(row, 'the orphan version appears in status output');
  assert.equal(row!.state, 'invalid_history');
  assert.equal(row!.ledgerChecksum, 'cafe');
  assert.equal(row!.fileChecksum, '');
});

test('a NON-dirty ledger row carrying a resolution is contradictory history, never applied', () => {
  const pairs = PAIRS();
  const resolution = planDirtyResolution({ version: '001', reasonCategory: 'x', correctiveRef: '003', at: '2026-01-01T00:00:00.000Z' });
  const contradictory: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: false, resolution }];
  assert.equal(computeStatus(pairs, contradictory).find((s) => s.version === '001')!.state, 'invalid_history');
  assert.equal(codeOf(() => planApply(pairs, contradictory)), ENGINE_CODES.INVALID_HISTORY);
});

test('forward-only ordering: an unapplied version below an applied head is refused as a backfill', () => {
  const pairs = PAIRS();
  // 002 is applied; 001 was never recorded — scheduling 001 now would run history out
  // of order underneath an applied head.
  const headApplied: LedgerRow[] = [{ version: '002', checksum: pairs.find((p) => p.version === '002')!.up.checksum, dirty: false, resolution: null }];
  assert.equal(codeOf(() => planApply(pairs, headApplied)), ENGINE_CODES.INVALID_HISTORY);
});

test('a resolved_superseded resolution is honored and classified with failed_resolved semantics', () => {
  const pairs = PAIRS();
  const superseded = planDirtyResolution({ version: '001', reasonCategory: 'superseded', correctiveRef: '003', at: '2026-01-01T00:00:00.000Z', status: 'resolved_superseded' });
  assert.equal(superseded.status, 'resolved_superseded');
  const rows: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: true, resolution: superseded }];
  // Intentional unification: both resolved statuses are settled dirty attempts.
  assert.equal(computeStatus(pairs, rows).find((s) => s.version === '001')!.state, 'failed_resolved');
});

test('execute-time integrity (kernel): a tampered or lost artifact refuses BEFORE any reserve/ledger effect', () => {
  // S1.7G REWRITE. The tamper is applied to a CALLER-BUILT plan instead of by mutating the engine's
  // own returned plan: public results are now deeply frozen, so the old in-place edit is impossible.
  // That is also the realistic threat model — `ApplyPlan` is a plain exported interface, so an
  // executor may be handed a plan the engine never produced. The asserted property is unchanged: a
  // tampered or LOST artifact refuses with checksum_mismatch and emits zero effects.
  const src = twoPlan().pending[0];
  const tamperedUp = { ...src.up, checksum: 'deadbeef' } as unknown as MigrationDescriptor;
  // The spread already dropped the non-enumerable artifact; re-attach the REAL one so the only
  // discrepancy under test is the descriptor checksum.
  Object.defineProperty(tamperedUp, 'artifact', { value: src.up.artifact, enumerable: false });
  const plan = { pending: [{ ...src, up: tamperedUp }] } as unknown as ApplyPlan;
  const a = startMigrationExecution(plan, execDeps());
  assert.equal(a.state.outcome, 'refused');
  assert.equal(a.state.code, ENGINE_CODES.CHECKSUM_MISMATCH);
  assert.deepEqual(a.effects, [], 'no reserve, no dirty marker, no schema statement for a tampered artifact');

  // A spread-copied descriptor silently LOSES the non-enumerable artifact — fail closed.
  const src2 = twoPlan().pending[0];
  const plan2 = { pending: [{ ...src2, up: { ...src2.up } }] } as unknown as ApplyPlan;
  const b = startMigrationExecution(plan2, execDeps());
  assert.equal(b.state.outcome, 'refused');
  assert.equal(b.state.code, ENGINE_CODES.CHECKSUM_MISMATCH);
  assert.deepEqual(b.effects, []);
});

test('a truthy NON-boolean lock result is not an acquired lock (kernel): RUN_LOCK_UNAVAILABLE, no dirty, terminate', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'acquire_lock' ? { type: 'lock', acquired: { rows: [{ locked: false }] } } : okEvent()(e));
  assert.equal(state.code, ENGINE_CODES.RUN_LOCK_UNAVAILABLE);
  assert.ok(!kinds.includes('insert_dirty'), 'nothing runs on an unverified lock');
  assert.equal(state.disposition, 'terminate');
});

test('a truthy NON-boolean unlock result is UNVERIFIED (kernel): RUN_UNLOCK_FAILED, terminate', () => {
  const { state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'release_lock' ? { type: 'unlock', released: { rows: [{ unlocked: false }] } } : okEvent()(e));
  assert.equal(state.code, ENGINE_CODES.RUN_UNLOCK_FAILED);
  assert.equal(state.disposition, 'terminate');
  assert.notEqual(state.outcome, 'complete', 'an unverified unlock never pools the session');
});

// --- S1.5 exported-boundary hardening (hostile JavaScript caller) -----------

test('F1 (kernel): an up-slot descriptor relabeled `up` but carrying the DOWN artifact refuses before reserve', () => {
  const base = twoPlan();
  const realPair = base.pending[0];
  const down = realPair.down;
  // Relabel the DOWN descriptor as direction 'up' while keeping its own (down) artifact and
  // checksum: integrity passes (down bytes hash to their own checksum), so ONLY the artifact-bound
  // direction guard stops rollback SQL from running in the up slot.
  const relabeled = { ...down, direction: 'up' as const, artifact: down.artifact };
  const plan: ApplyPlan = { pending: [{ ...realPair, up: relabeled }] };
  const { state, effects } = startMigrationExecution(plan, execDeps());
  assert.equal(state.outcome, 'refused');
  assert.equal(state.code, ENGINE_CODES.PAIR_MISMATCH);
  assert.deepEqual(effects, [], 'no reserve, no rollback SQL, no dirty marker');
});

test('F2 (kernel): an artifact whose `sql` getter alternates binds ONLY the validated bytes into the effect (TOCTOU closed)', () => {
  const validSql = 'create table alpha();\n';
  const validBytes = new TextEncoder().encode(validSql);
  const validChecksum = sha256Hex(validBytes);
  let sqlReads = 0;
  const hostileArtifact = {
    version: '001', direction: 'up' as const, checksum: validChecksum,
    get bytes(): Uint8Array { return new Uint8Array(validBytes); },
    get sql(): string { sqlReads += 1; return sqlReads === 1 ? validSql : '-- SWAPPED malicious drop table alpha;\n'; },
  } as unknown as MigrationArtifact;
  const up = { version: '001', name: 'alpha', direction: 'up' as const, checksum: validChecksum, relPath: 'x/001_alpha.up.sql', transactionMode: 'required' as const, artifact: hostileArtifact };
  const plan: ApplyPlan = { pending: [{ version: '001', name: 'alpha', up, down: up, transactionMode: 'required' }] };
  const { effects } = driveKernel(plan, execDeps());
  const executes = effects.filter((e): e is Extract<ExecutionEffect, { kind: 'execute' }> => e.kind === 'execute');
  // Canonicalization reads `sql` exactly once and re-hashes it; the effect binds that validated SQL,
  // so a later-alternating getter can never swap what an executor would run.
  assert.deepEqual(executes.map((e) => e.sql), [validSql], 'the effect binds the validated SQL, never the later swapped SQL');
});

test('F3: a migration credential must declare distinct primitive migrator/runtime refs', () => {
  // A bare purpose is no longer self-assertable.
  assert.equal(codeOf(() => assertMigratorCredential({ purpose: 'migration' })), ENGINE_CODES.INVALID_CREDENTIAL_REF);
  // Two distinct String('x') wrappers evade === but are the same underlying value — non-primitives are refused.
  const boxed = { purpose: 'migration', migratorRef: new String('x'), runtimeRef: new String('x') } as unknown as CredentialClassification;
  assert.equal(codeOf(() => assertMigratorCredential(boxed)), ENGINE_CODES.INVALID_CREDENTIAL_REF);
  // A getter returning a non-string is refused.
  const objRef = { purpose: 'migration', runtimeRef: 'r', get migratorRef(): string { return ({} as unknown as string); } } as CredentialClassification;
  assert.equal(codeOf(() => assertMigratorCredential(objRef)), ENGINE_CODES.INVALID_CREDENTIAL_REF);
  // Distinct primitive refs are accepted.
  assert.equal(codeOf(() => assertMigratorCredential({ purpose: 'migration', migratorRef: 'm', runtimeRef: 'r' })), 'NO_THROW');
});

test('F4 (kernel): a forged/missing transaction mode refuses before reserve, never routed to non-transactional', () => {
  const base = twoPlan();
  const realPair = base.pending[0];
  for (const badMode of ['bogus', undefined] as unknown[]) {
    const badUp = { ...realPair.up, transactionMode: badMode as unknown as 'required', artifact: realPair.up.artifact };
    const plan: ApplyPlan = { pending: [{ ...realPair, up: badUp }] };
    const { state, effects } = startMigrationExecution(plan, execDeps());
    assert.equal(state.outcome, 'refused', `mode=${String(badMode)}`);
    assert.equal(state.code, ENGINE_CODES.INVALID_TRANSACTION_MODE, `mode=${String(badMode)}`);
    assert.deepEqual(effects, [], 'nothing runs on an invalid mode');
  }
});

test('F5 (kernel): a non-safe-integer advisory lock key refuses before any reserve; a valid key proceeds', () => {
  for (const badKey of ['1', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, { valueOf: () => 1 }] as unknown[]) {
    const { state, effects } = startMigrationExecution(twoPlan(), execDeps('session', badKey as unknown as number));
    assert.equal(state.outcome, 'refused', `key=${String(badKey)}`);
    assert.equal(state.code, ENGINE_CODES.INVALID_LOCK_KEY, `key=${String(badKey)}`);
    assert.deepEqual(effects, [], `key=${String(badKey)}: no reserve`);
  }
  const ok = startMigrationExecution(twoPlan(), execDeps('session', 7));
  assert.equal(ok.state.outcome, 'in_progress', 'a valid safe-integer key is accepted');
  assert.equal(ok.effects[0].kind, 'reserve');
});

test('F6 (kernel): a non-string backend identity token refuses before lock/ledger work (INVALID_BACKEND_IDENTITY, terminate)', () => {
  const { kinds, state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'capture_identity' ? { type: 'identity', identity: { token: {} as unknown as string } } : okEvent()(e));
  assert.equal(state.code, ENGINE_CODES.INVALID_BACKEND_IDENTITY);
  assert.ok(!kinds.includes('acquire_lock'), 'no lock acquired on an invalid backend token');
  assert.equal(state.disposition, 'terminate', 'the reserved session is destroyed');
});

test('F7 (kernel): a throwing connectionMode getter becomes a bounded refusal, never a raw leak', () => {
  const d = {
    credential: CRED, lockKey: 1,
    get connectionMode(): ConnectionMode { throw new Error('SELECT secret FROM pg /abs/secret/path'); },
  } as unknown as ExecutionDeps;
  const { state, effects } = startMigrationExecution(twoPlan(), d);
  assert.equal(state.outcome, 'refused');
  assert.equal(state.code, ENGINE_CODES.PORT_OPERATION_FAILED);
  assert.deepEqual(effects, [], 'no reserve when the mode getter throws');
  assert.ok(!/secret|SELECT|abs/i.test(JSON.stringify(state)), 'no raw getter message leaks into the inert verdict');
});

test('S1.7D (F7): a foreign throw crosses a port guard as a BOUNDED code only — never a caller-owned object, message, subject, or stack', () => {
  // REPLACES the S1.7C test "an unbranded MigrationEngineError from a deps getter is downgraded to a
  // bounded code". That test could only be stated in terms of PROVENANCE: the engine kept a WeakSet
  // of the errors it had itself raised and downgraded every unbranded one, so its assertion was
  // "this object is not in the registry". S1.7D removes the registry, so the property is restated
  // STRUCTURALLY, and is strictly stronger: no caught object EVER crosses by identity, and the only
  // thing recovered from it is a code that must lie in the closed engine-code domain. Message,
  // subject, and stack are dropped outright, so there is no caller-text channel left at all.
  const BEL = String.fromCharCode(7);
  const HOSTILE = `SELECT pw FROM users${BEL} /abs/secret ${'z'.repeat(5000)}`;
  const cases: Array<{ label: string; thrown: unknown; code: string }> = [
    { label: 'raw driver error', thrown: new Error(HOSTILE), code: ENGINE_CODES.PORT_OPERATION_FAILED },
    { label: 'out-of-domain code', thrown: Object.assign(new Error(HOSTILE), { code: 'not_an_engine_code' }), code: ENGINE_CODES.PORT_OPERATION_FAILED },
    { label: 'non-string code', thrown: Object.assign(new Error(HOSTILE), { code: { toString: () => ENGINE_CODES.CHECKSUM_MISMATCH } }), code: ENGINE_CODES.PORT_OPERATION_FAILED },
    { label: 'throwing code getter', thrown: Object.defineProperty(new Error(HOSTILE), 'code', { get(): never { throw new Error('RAW trap'); } }), code: ENGINE_CODES.PORT_OPERATION_FAILED },
    { label: 'primitive throw', thrown: HOSTILE, code: ENGINE_CODES.PORT_OPERATION_FAILED },
    // A faked prototype chain and a caller-CONSTRUCTED engine error are treated identically to each
    // other and to an engine throw — the whole point of dropping provenance. Both may steer WHICH
    // bounded refusal is reported; neither can place one byte of their own content anywhere.
    { label: 'faked prototype chain', thrown: Object.setPrototypeOf({ code: ENGINE_CODES.CHECKSUM_MISMATCH, message: HOSTILE, subject: 'DROP TABLE users' }, MigrationEngineError.prototype), code: ENGINE_CODES.CHECKSUM_MISMATCH },
    { label: 'caller-constructed engine error', thrown: new MigrationEngineError(ENGINE_CODES.CHECKSUM_MISMATCH, 'leaked DROP TABLE users pw'), code: ENGINE_CODES.CHECKSUM_MISMATCH },
  ];
  for (const c of cases) {
    const d = { credential: CRED, lockKey: 1, get connectionMode(): ConnectionMode { throw c.thrown; } } as unknown as ExecutionDeps;
    const { state, effects } = startMigrationExecution(twoPlan(), d);
    assert.equal(state.outcome, 'refused', c.label);
    assert.deepEqual(effects, [], `${c.label}: a refusal emits no effect`);
    assert.equal(state.code, c.code, `${c.label}: bounded code`);
    assert.ok(Object.values(ENGINE_CODES).includes(state.code as EngineCode), `${c.label}: the code lies in the closed domain`);
    const dumped = JSON.stringify(state);
    assert.ok(!/DROP TABLE|SELECT|pw|RAW|abs\/secret|zzzz/i.test(dumped), `${c.label}: no caller content crosses`);
    assert.ok(!/[^\x20-\x7e]/.test(dumped), `${c.label}: the verdict stays printable ASCII`);
  }
  // On a THROWING boundary the same holds: the value handed back is engine-allocated, its message is
  // exactly the bounded refusal sentence, and the hostile object itself never escapes.
  const hostile = new MigrationEngineError(ENGINE_CODES.INVALID_FILENAME, `x${BEL}${'q'.repeat(500)}`);
  const port: MigrationFsPort = { relDir: 'x', list: (): string[] => { throw hostile; }, entryType: () => 'file', readBytes: () => new Uint8Array() };
  let caught: unknown;
  try { discoverMigrations(port); } catch (e) { caught = e; }
  assert.ok(caught instanceof MigrationEngineError, 'a bounded engine error is thrown');
  assert.notEqual(caught, hostile, 'the caught object never crosses the boundary by identity');
  assert.equal((caught as MigrationEngineError).code, ENGINE_CODES.INVALID_FILENAME, 'the bounded code is preserved');
  assert.equal((caught as MigrationEngineError).message, `migration engine refused (${ENGINE_CODES.INVALID_FILENAME})`, 'the message is the bounded sentence alone — no subject survives the rebuild');
  // A credential refusal raised INSIDE a guarded call must still report its own bounded reason,
  // which is why the code is preserved rather than flattened to a generic port failure.
  const runtimeCred = { purpose: 'runtime', migratorRef: 'a', runtimeRef: 'b' } as unknown as CredentialClassification;
  assert.equal(startMigrationExecution(twoPlan(), execDeps('session', 1, runtimeCred)).state.code, ENGINE_CODES.RUNTIME_CREDENTIAL_REJECTED);
});

test('F8: a hostile ledger checksum is never echoed into status output', () => {
  const pairs = PAIRS();
  const sqlish = 'DROP TABLE users; -- not a checksum';
  const st = computeStatus(pairs, [{ version: '001', checksum: sqlish, dirty: false, resolution: null } as unknown as LedgerRow]);
  const row = st.find((s) => s.version === '001')!;
  assert.equal(row.state, 'checksum_mismatch', 'a non-hex ledger checksum drifts');
  assert.equal(row.ledgerChecksum, null, 'the hostile value is nulled, never echoed');
  assert.ok(!JSON.stringify(st).includes('DROP TABLE'), 'serialized status carries no raw ledger content');
});

test('F8: hostile resolution fields (control chars / oversized / unknown status) are refused', () => {
  assert.equal(codeOf(() => planDirtyResolution({ version: '001', reasonCategory: 'x\u0007y', correctiveRef: '003', at: '2026-01-01T00:00:00.000Z' })), ENGINE_CODES.INVALID_LEDGER_FIELD);
  assert.equal(codeOf(() => planDirtyResolution({ version: '001', reasonCategory: 'x'.repeat(5000), correctiveRef: '003', at: '2026-01-01T00:00:00.000Z' })), ENGINE_CODES.INVALID_LEDGER_FIELD);
  assert.equal(codeOf(() => planDirtyResolution({ version: '001', reasonCategory: 'ok', correctiveRef: '003', at: 'when', status: 'bogus' as unknown as 'resolved_failed' })), ENGINE_CODES.INVALID_LEDGER_FIELD);
  assert.equal(codeOf(() => planDirtyResolution({ version: '001', reasonCategory: 'schema_error', correctiveRef: '003', at: '2026-01-01T00:00:00.000Z' })), 'NO_THROW');
});

test('F9 (kernel): every uncertain lock/session outcome yields a terminate verdict, never a clean close', () => {
  const scenarios: Array<{ label: string; respond: (e: ExecutionEffect) => ExecutionEvent }> = [
    { label: 'lock-unavailable', respond: (e) => e.kind === 'acquire_lock' ? { type: 'lock', acquired: false } : okEvent()(e) },
    { label: 'unlock-false', respond: (e) => e.kind === 'release_lock' ? { type: 'unlock', released: false } : okEvent()(e) },
    { label: 'unlock-throws', respond: (e) => e.kind === 'release_lock' ? { type: 'port_failed' } : okEvent()(e) },
    { label: 'schema-failure', respond: (e) => e.kind === 'execute' ? { type: 'port_failed' } : okEvent()(e) },
    { label: 'close-failure', respond: (e) => e.kind === 'close' ? { type: 'port_failed' } : okEvent()(e) },
  ];
  for (const s of scenarios) {
    const { state } = driveKernel(twoPlan(), execDeps(), s.respond);
    assert.equal(state.outcome, 'failed', s.label);
    // 'terminate' (destroy) is the verdict on every uncertain path; 'complete' (the only pool-eligible
    // clean-close path) is never reached, so a potentially-locked session is never pooled. Real
    // physical destruction is the S1b executor obligation.
    assert.equal(state.disposition, 'terminate', `${s.label}: disposal is terminate, never a clean close/pool`);
  }
});

test('S1.7D (F7): copying every own symbol, property, and prototype off a genuine engine error onto a forgery changes nothing that crosses the boundary', () => {
  // REPLACES the S1.7C test "the engine-origin WeakSet brand cannot be forged by lifting own symbols
  // off a caught engine error". That test asserted a property OF THE BRAND — that a symbol-keyed
  // marker is liftable while a WeakSet membership is not — so it cannot survive the brand's removal
  // in any form. The replacement property is the one that actually matters to a caller and does not
  // mention provenance at all: total forgery of a genuine engine error buys NOTHING, because the
  // boundary recovers only a closed-domain code and rebuilds everything else itself.
  const captured = ((): unknown => {
    try { assertMigratorConnectionMode('transaction' as ConnectionMode); } catch (e) { return e; }
    return undefined;
  })();
  assert.ok(captured instanceof MigrationEngineError, 'a genuine engine error was captured to copy from');

  const forged = new MigrationEngineError(ENGINE_CODES.CHECKSUM_MISMATCH, 'forged DROP TABLE users pw');
  for (const s of Object.getOwnPropertySymbols(captured as object)) {
    try { Object.defineProperty(forged, s, { value: (captured as unknown as Record<symbol, unknown>)[s], enumerable: false, configurable: true }); } catch { /* sealed */ }
  }
  for (const k of Object.getOwnPropertyNames(captured as object)) {
    try { Object.defineProperty(forged, k, { value: (captured as unknown as Record<string, unknown>)[k], configurable: true }); } catch { /* sealed */ }
  }
  Object.setPrototypeOf(forged, Object.getPrototypeOf(captured as object));

  const d = { credential: CRED, lockKey: 1, get connectionMode(): ConnectionMode { throw forged; } } as unknown as ExecutionDeps;
  const { state, effects } = startMigrationExecution(twoPlan(), d);
  assert.equal(state.outcome, 'refused');
  assert.deepEqual(effects, [], 'a forged throw emits no effect');
  assert.ok(Object.values(ENGINE_CODES).includes(state.code as EngineCode), 'whatever it forged, the reported code lies in the closed domain');
  assert.ok(!/DROP TABLE|pw/i.test(JSON.stringify(state)), 'the forged subject never crosses');
  // `message` and `code` are SEALED at construction, so even total ownership of the object cannot
  // make an instance of this class carry unbounded or non-printable content.
  const BEL = String.fromCharCode(7);
  const sealed = new MigrationEngineError(ENGINE_CODES.CHECKSUM_MISMATCH, 'ok');
  for (const prop of ['message', 'code']) {
    try { (sealed as unknown as Record<string, unknown>)[prop] = `RAW${BEL}${'w'.repeat(5000)}`; } catch { /* non-writable */ }
    try { Object.defineProperty(sealed, prop, { value: `RAW${BEL}${'w'.repeat(5000)}` }); } catch { /* non-configurable */ }
  }
  assert.equal(sealed.code, ENGINE_CODES.CHECKSUM_MISMATCH, 'the sealed code is unchanged');
  assert.ok(!/RAW|wwww/.test(sealed.message), 'the sealed message is unchanged');
  assert.ok(!/[^\x20-\x7e]/.test(sealed.message), 'the sealed message stays printable ASCII');
});

test('F7 (kernel): a throwing credential-field getter becomes a bounded refusal, not a raw leak', () => {
  // S1.7F: the credential fields are read from their DESCRIPTORS, so a throwing getter is never
  // invoked — there is no exception to bound. `purpose` reads as absent and the classification is
  // refused on its purpose. Same fail-closed outcome, reached without running caller code at all.
  let invoked = 0;
  const cred = { get purpose(): CredentialPurpose { invoked += 1; throw new Error('SELECT secret FROM pg /abs/path pw'); } } as CredentialClassification;
  const { state, effects } = startMigrationExecution(twoPlan(), execDeps('session', 42, cred));
  assert.equal(invoked, 0, 'the throwing credential getter was never invoked');
  assert.equal(state.outcome, 'refused');
  assert.equal(state.code, ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  assert.deepEqual(effects, [], 'no reserve when the credential is not a canonical classification');
  assert.ok(!/secret|SELECT|pw/i.test(JSON.stringify(state)), 'no raw getter message leaks');
});

test('F7 (kernel): a throwing backend-identity token getter becomes a bounded code, not a raw leak', () => {
  const { state } = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'capture_identity'
      ? { type: 'identity', identity: { get token(): string { throw new Error('SELECT secret FROM pg /abs/path pw'); } } }
      : okEvent()(e));
  assert.equal(state.code, ENGINE_CODES.INVALID_BACKEND_IDENTITY);
  assert.equal(state.disposition, 'terminate', 'the reserved session is destroyed');
  assert.ok(!/secret|SELECT|pw/i.test(JSON.stringify(state)), 'no raw getter message leaks');
});

// --- S1.6 exported-boundary hardening (hostile JavaScript caller) -----------

test('S1.6/D1: a NON-STRING error subject cannot smuggle unbounded or non-printable content across the boundary', async () => {
  // TypeScript erases `subject: string`. A hostile caller can hand the exported connection-mode
  // guard an object whose replace()/slice() return attacker-chosen content; without a RUNTIME
  // type check that content becomes the ENGINE-BRANDED error's own message, defeating the
  // printable-ASCII filter and the 120-character cap the boundary is supposed to guarantee.
  const smuggled = `\u001b[31m${'A'.repeat(5000)}\u0007DROP TABLE users`;
  const hostileMode = { replace: () => ({ slice: () => smuggled }) } as unknown as ConnectionMode;
  try {
    assertMigratorConnectionMode(hostileMode);
    assert.fail('expected a bounded refusal');
  } catch (e) {
    assert.ok(e instanceof MigrationEngineError);
    assert.ok(e.message.length <= 200, `the error message must stay bounded, got ${e.message.length}`);
    assert.ok(!/[^\x20-\x7e]/.test(e.message), 'the message is printable ASCII only');
    assert.ok(!e.message.includes('DROP TABLE'), 'the smuggled content never crosses');
  }
  // The same object reaching the kernel entry point refuses fail-closed with an inert verdict.
  const { state, effects } = startMigrationExecution(twoPlan(), { connectionMode: hostileMode, credential: CRED, lockKey: 1 });
  assert.equal(state.outcome, 'refused');
  assert.equal(state.code, ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED);
  assert.deepEqual(effects, [], 'no reserve on a refused connection mode');
  assert.ok(!/DROP TABLE/.test(JSON.stringify(state)), 'no smuggled content in the inert verdict');
});

test('S1.6/D2: a per-read ledger version cannot dodge the forward-only backfill guard', () => {
  // planApply must read each ledger row ONCE. A row whose `version` getter reports the applied
  // head to the known-version and status reads, then an empty string to the max-recorded read,
  // empties the head and lets an out-of-order 001 be scheduled underneath an applied 002.
  const pairs = PAIRS();
  let reads = 0;
  const shifty = {
    get version(): string { reads += 1; return reads <= 2 ? '002' : ''; },
    checksum: pairs.find((p) => p.version === '002')!.up.checksum,
    dirty: false,
    resolution: null,
  } as unknown as LedgerRow;
  assert.equal(codeOf(() => planApply(pairs, [shifty])), ENGINE_CODES.INVALID_HISTORY);
});

test('S1.6/D3: caller-built pair identifiers cannot place raw content into status output', () => {
  // `pairs` is a plain, caller-controlled structure at the exported boundary. The version and
  // file checksum echoed into status output must be bounded, printable, canonical values —
  // otherwise a caller-built pair puts arbitrary text into output documented as SQL-free.
  const pairs = PAIRS();
  const sqlish = 'DROP TABLE users; --';
  const hostilePairs = [
    { ...pairs[0], up: { ...pairs[0].up, checksum: sqlish } },
  ] as unknown as MigrationPair[];
  assert.equal(codeOf(() => computeStatus(hostilePairs, [])), ENGINE_CODES.INVALID_LEDGER_FIELD);
  const control = 'a'.repeat(65);
  const oversized = [{ ...pairs[0], version: control }] as unknown as MigrationPair[];
  assert.equal(codeOf(() => computeStatus(oversized, [])), ENGINE_CODES.INVALID_LEDGER_FIELD);
});

test('S1.6/D4 (kernel): the exported ledger-timestamp validator refuses raw/non-canonical content (executor stamps via it)', () => {
  const rec = newRec();
  const stamps: string[] = [];
  const ledger: MigrationLedgerPort = {
    insertDirtyAttempt: async (_s, r) => { stamps.push(r.startedAt); rec.events.push(`dirty:${r.version}`); },
    finalizeApplied: async (_h, r) => { stamps.push(r.finishedAt); rec.events.push(`finalize:${r.version}`); },
  };
  const hostileNow = (): string => `\u001b[31m${'A'.repeat(500)}DROP TABLE users`;
  // D4 property preserved by the exported ledger-timestamp validator; the kernel holds no clock, so
  // the S1b executor stamps rows and MUST validate its own now() through it. The hostile now() value
  // (control chars + SQL) is precisely what that pure validator refuses.
  assert.equal(codeOf(() => assertLedgerTimestamp(hostileNow())), ENGINE_CODES.INVALID_LEDGER_FIELD, 'hostile control/SQL timestamp refused');
  assert.equal(codeOf(() => assertLedgerTimestamp('x'.repeat(65))), ENGINE_CODES.INVALID_LEDGER_FIELD, 'oversized refused');
  assert.equal(assertLedgerTimestamp('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z', 'canonical accepted');
  void rec; void stamps; void ledger;
});

test('S1.6/D5 (kernel): the dirty marker precedes the finalize in the emitted effect stream (one-ledger routing is the executor’s)', () => {
  // The kernel holds no ledger port; it emits insert_dirty BEFORE finalize for each migration, so an
  // executor cannot record an apply that no marker precedes. Routing both effects to ONE ledger port
  // is the S1b executor obligation (the kernel emits inert data, never a port handle).
  const { kinds } = driveKernel(twoPlan(), execDeps());
  const dirties = kinds.map((k, i) => (k === 'insert_dirty' ? i : -1)).filter((i) => i >= 0);
  const finals = kinds.map((k, i) => (k === 'finalize' ? i : -1)).filter((i) => i >= 0);
  assert.equal(dirties.length, 2);
  assert.equal(finals.length, 2);
  for (let m = 0; m < 2; m += 1) assert.ok(dirties[m] < finals[m], `migration ${m}: dirty precedes finalize`);
});

/**
 * Ports that RECORD every operation a call reaches. Used to prove that an export which is not
 * the execution entry point can reach NONE of them — not reservation, ledger, advisory lock,
 * SQL execution, reusable release, or terminal disposal.
 */
function recordingPorts(): { ops: string[]; adapter: ReservedSessionAdapter; ledger: MigrationLedgerPort } {
  const ops: string[] = [];
  const tx: SchemaTx = {
    backendIdentity: async () => { ops.push('tx.backendIdentity'); return { token: 'pid-1' }; },
    execute: async (a) => { ops.push(`tx.execute:${a.version}`); },
  };
  const session: ReservedSession = {
    backendIdentity: async () => { ops.push('session.backendIdentity'); return { token: 'pid-1' }; },
    acquireRunLock: async () => { ops.push('session.acquireRunLock'); return true; },
    releaseRunLock: async () => { ops.push('session.releaseRunLock'); return true; },
    begin: async (fn) => { ops.push('session.begin'); return fn(tx); },
    executeNonTransactional: async (a) => { ops.push(`session.executeNonTransactional:${a.version}`); },
    close: async () => { ops.push('session.close'); },
    terminate: async () => { ops.push('session.terminate'); },
  };
  return {
    ops,
    adapter: { reserve: async () => { ops.push('adapter.reserve'); return session; } },
    ledger: {
      insertDirtyAttempt: async (_s, r) => { ops.push(`ledger.insertDirtyAttempt:${r.version}`); },
      finalizeApplied: async (_h, r) => { ops.push(`ledger.finalizeApplied:${r.version}`); },
    },
  };
}

test('S1.6/D1 variants: every non-string subject shape is refused a subject, not just a plain object', () => {
  const huge = 'Z'.repeat(5000);
  const smuggler = { replace: (): unknown => ({ slice: (): string => huge }) };
  const variants: unknown[] = [
    smuggler,                                                       // plain object
    new String(huge),                                               // boxed primitive
    Object.create(smuggler),                                        // prototype-inherited
    new Proxy({}, { get: () => () => ({ slice: () => huge }) }),    // proxy
    Symbol('subject'),
    42,
    null,
  ];
  for (const v of variants) {
    const err = new MigrationEngineError(ENGINE_CODES.PORT_OPERATION_FAILED, v as unknown as string);
    assert.ok(err.message.length <= 200, `bounded for ${String(typeof v)}`);
    assert.ok(!err.message.includes('ZZZZ'), `no smuggled content for ${String(typeof v)}`);
    assert.ok(!/[^\x20-\x7e]/.test(err.message), `printable ASCII for ${String(typeof v)}`);
  }
});

test('S1.7B: NO runtime export reaches a session, ledger, lock, transaction, release, termination, or SQL port', async () => {
  // Strengthened sweep. (1) The fail-closed runMigrations shim is AWAITED and must REJECT — a
  // fail-OPEN shim that merely resolved would fail this row, which the earlier fire-and-forget
  // form could not detect. (2) The pure kernel is driven with deps that ACTUALLY CARRY the
  // recording ports, so an empty op log is BEHAVIOURAL rather than true by construction.
  // (3) Every other runtime export reaches no port. createNodeFsPort is excluded deliberately:
  // it takes only directory strings and node:fs, so it has no parameter through which a port
  // could be handed in.
  const ports = recordingPorts();
  const bait = {
    adapter: ports.adapter, ledger: ports.ledger, connectionMode: 'session',
    credential: CRED, lockKey: 1, now: () => 'T',
  };
  await assert.rejects(
    runMigrations(bait as unknown as ApplyPlan, bait as unknown as RunDeps),
    (e: unknown) => e instanceof MigrationEngineError && e.code === ENGINE_CODES.MIGRATION_EXECUTION_UNAVAILABLE,
    'runMigrations (fail-closed shim) must REJECT, never resolve',
  );
  assert.deepEqual(ports.ops, [], 'runMigrations (fail-closed shim) must not reach any port');
  // ExecutionDeps is a SCALAR-ONLY contract, so handing the kernel the port-bearing bait proves
  // port-freeness by behaviour: the extra adapter/ledger keys must simply never be reached.
  const portBearing = bait as unknown as ExecutionDeps;
  const others: Array<[string, () => unknown]> = [
    ['startMigrationExecution (port-bearing deps)', () => startMigrationExecution(twoPlan(), portBearing)],
    ['stepMigrationExecution (kernel driven to completion, port-bearing deps)', () => driveKernel(twoPlan(), portBearing)],
    ['assertLedgerTimestamp', () => { try { assertLedgerTimestamp('2026-01-01T00:00:00.000Z'); } catch { /* pure */ } }],
    ['sha256Hex', () => sha256Hex(new Uint8Array())],
    ['discoverMigrations', () => discoverMigrations(bait as unknown as MigrationFsPort)],
    ['pairMigrations', () => pairMigrations([bait] as unknown as MigrationDescriptor[])],
    ['computeStatus', () => computeStatus([bait] as unknown as MigrationPair[], [bait] as unknown as LedgerRow[])],
    ['planApply', () => planApply([bait] as unknown as MigrationPair[], [bait] as unknown as LedgerRow[])],
    ['isBaselineCandidate', () => isBaselineCandidate([bait] as unknown as MigrationPair[], [], [])],
    ['planBaseline', () => planBaseline([bait] as unknown as MigrationPair[], [], [])],
    ['planDirtyResolution', () => planDirtyResolution(bait as unknown as Parameters<typeof planDirtyResolution>[0])],
    ['assertMigratorCredential', () => assertMigratorCredential(bait as unknown as CredentialClassification)],
    ['assertMigratorConnectionMode', () => assertMigratorConnectionMode(bait as unknown as ConnectionMode)],
    ['isContained', () => isContained('/a', '/a/b')],
  ];
  for (const [name, fn] of others) {
    try { fn(); } catch { /* a bounded refusal is expected; only port reachability matters here */ }
    assert.deepEqual(ports.ops, [], `${name} must not reach any session, ledger, lock, or SQL port`);
  }
});

test('S1.6/R6 (kernel): a caught engine error whose message is mutated cannot smuggle raw content across the guard', () => {
  // The engine-origin brand proves ORIGIN, but `Error.message` is an ordinary writable property.
  // A hostile port can obtain a genuine branded error (catch one from any exported guard),
  // rewrite its message to raw content, and re-throw it — and a guard that trusts the brand
  // would propagate the attacker's text verbatim. The sanitized message must be immutable.
  const rec = newRec();
  const adapter: ReservedSessionAdapter = {
    reserve: async () => {
      let branded: unknown;
      try { assertMigratorConnectionMode('transaction' as ConnectionMode); } catch (e) { branded = e; }
      try { (branded as Error).message = 'RAW DROP TABLE users /abs/secret\u0007'; } catch { /* immutability is the fix */ }
      throw branded;
    },
  };
  void rec; void adapter;
  // Kernel form: a deps getter throws a GENUINE engine-origin error whose message it also tries to
  // mutate. The brand is engine-origin (re-thrown), but the message is SEALED at construction, so the
  // mutation cannot take — and the inert kernel verdict carries only the code, never a message.
  const dd = {
    credential: CRED, lockKey: 1,
    get connectionMode(): ConnectionMode {
      let branded2: unknown;
      try { assertMigratorConnectionMode('transaction' as ConnectionMode); } catch (e) { branded2 = e; }
      try { (branded2 as Error).message = 'RAW DROP TABLE users /abs/secret'; } catch { /* sealed message is the fix */ }
      throw branded2;
    },
  } as unknown as ExecutionDeps;
  const { state } = startMigrationExecution(twoPlan(), dd);
  assert.ok(!/DROP TABLE|abs\/secret/.test(JSON.stringify(state)), 'a mutated branded message never crosses');
  assert.equal(state.code, ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED, 'the branded code is used; its sealed message never enters the verdict');
});

test('S1.6/R8: an oversized or non-printable error CODE cannot produce an unbounded message', () => {
  const err = new MigrationEngineError(`${'X'.repeat(300)}\u0007` as unknown as EngineCode, 'v');
  assert.ok(err.message.length <= 200, `the message must stay bounded, got ${err.message.length}`);
  assert.ok(!/[^\x20-\x7e]/.test(err.message), 'printable ASCII only');
});

test('S1.6/R3: a throwing ledger-row getter is bounded, never a raw leak', () => {
  const pairs = PAIRS();
  const hostile = [{ get version(): string { throw new Error('RAW SELECT secret /abs/path'); } }] as unknown as LedgerRow[];
  for (const call of [() => computeStatus(pairs, hostile), () => planApply(pairs, hostile)]) {
    try {
      call();
      assert.fail('expected a bounded refusal');
    } catch (e) {
      assert.ok(e instanceof MigrationEngineError, 'a throwing ledger getter must become a MigrationEngineError');
      assert.ok(!/RAW|SELECT|abs/.test((e as Error).message), 'no raw getter message leaks');
    }
  }
});

test('S1.6/R2: overriding filter/map on caller-supplied arrays cannot widen the plan or hide the ledger', () => {
  const pairs = PAIRS();
  const head = pairs.find((p) => p.version === '002')!;
  // Hiding the ledger behind a hostile `map` must not erase the forward-only head.
  const hiddenLedger = [{ version: '002', checksum: head.up.checksum, dirty: false, resolution: null }] as LedgerRow[];
  Object.defineProperty(hiddenLedger, 'map', { value: () => [] });
  assert.equal(codeOf(() => planApply(pairs, hiddenLedger)), ENGINE_CODES.INVALID_HISTORY);
  // Widening the returned pending set through a hostile `filter` must not succeed.
  const oneApplied: LedgerRow[] = [{ version: '001', checksum: pairs[0].up.checksum, dirty: false, resolution: null }];
  const widening = [...pairs] as MigrationPair[];
  Object.defineProperty(widening, 'filter', { value: () => [...pairs] });
  assert.deepEqual(
    planApply(widening, oneApplied).pending.map((p) => p.version),
    ['002'],
    'pending comes from classification, never from a caller-supplied filter',
  );
});

test('S1.6/R4: a printable but non-canonical version cannot reach status output', () => {
  const pairs = PAIRS();
  const sqlish = [{ ...pairs[0], version: 'DROP TABLE users; --' }] as unknown as MigrationPair[];
  assert.equal(codeOf(() => computeStatus(sqlish, [])), ENGINE_CODES.INVALID_LEDGER_FIELD);
  const orphan = [{ version: 'DROP TABLE users; --', checksum: 'cafe', dirty: false, resolution: null }] as unknown as LedgerRow[];
  assert.equal(codeOf(() => computeStatus(pairs, orphan)), ENGINE_CODES.INVALID_LEDGER_FIELD);
});

test('S1.6/R5 (kernel): a printable but non-canonical timestamp is refused by the exported ledger-timestamp validator', () => {
  // The now()='DROP TABLE users; --' value the legacy run rejected is exactly what the exported
  // validator refuses; the S1b executor stamps rows through it (the kernel holds no clock).
  assert.equal(codeOf(() => assertLedgerTimestamp('DROP TABLE users; --')), ENGINE_CODES.INVALID_LEDGER_FIELD, 'sql-ish refused');
  // A canonical space/offset literal within the charset+length bound is accepted and returned.
  assert.equal(assertLedgerTimestamp('2026-07-24 10:00:00+00'), '2026-07-24 10:00:00+00');
});

test('S1.6/R7 (kernel): a backend switch during the unlock yields BACKEND_IDENTITY_CHANGED and a terminate verdict', () => {
  // A verified unlock proves only that the CURRENT backend released the lock. If the physical backend
  // switched at unlock time, the original backend may still hold it, so the post-unlock identity
  // re-verify must catch the switch and the session must be destroyed, never pooled.
  let token = 'pid-1';
  const { state } = driveKernel(twoPlan(), execDeps(), (e) => {
    if (e.kind === 'release_lock') { token = 'pid-2'; return { type: 'unlock', released: true }; }
    if (e.kind === 'capture_identity' || e.kind === 'verify_identity') return { type: 'identity', identity: { token } };
    return okEvent()(e);
  });
  assert.equal(state.code, ENGINE_CODES.BACKEND_IDENTITY_CHANGED, 'the post-unlock identity re-check catches the switch');
  assert.equal(state.disposition, 'terminate', 'a session whose backend switched at unlock is destroyed, never pooled');
});

// A SYNTHETIC connection-string-shaped probe used only as hostile INPUT, to prove the engine
// never echoes such a value back out. It is assembled from fragments at runtime so no
// credential-shaped literal appears contiguously in this source file; the fake user, fake
// password, and RFC1918 host are invented and address nothing real.
const FAKE_SCHEME = ['post', 'gres', '://'].join('');
const FAKE_URL = `${FAKE_SCHEME}${['adm', 'in'].join('')}:${['S3cr', '3tPW'].join('')}@10.0.0.5:5432/prod`;

test('S1.6/S1: a rejected connection mode never echoes its own value into the error', () => {
  // `connectionMode` is the one dependency whose real-world value is derived from connection
  // configuration, so echoing the rejected value is exactly how a connection string reaches an
  // error message. Printable-ASCII sanitization alone does not stop it — the subject must go.
  const hostile = `${FAKE_URL}; DROP TABLE users; --`;
  try {
    assertMigratorConnectionMode(hostile as unknown as ConnectionMode);
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(e instanceof MigrationEngineError);
    assert.equal(e.code, ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED);
    assert.ok(!e.message.includes(FAKE_SCHEME), 'no connection string in the message');
    assert.ok(!e.message.includes(FAKE_URL), 'no connection string in the message');
    assert.ok(!/DROP TABLE|10\.0\.0\.5/.test(e.message), 'no credential, host, or SQL in the message');
  }
});

test('S1.6/S2: a non-canonical ledger version is never echoed into the unknown-version error', () => {
  const pairs = PAIRS();
  const hostile = `${FAKE_URL} DROP TABLE users`;
  const ledger = [{ version: hostile, checksum: 'cafe', dirty: false, resolution: null }] as unknown as LedgerRow[];
  try {
    planApply(pairs, ledger);
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(e instanceof MigrationEngineError);
    assert.ok(!(e as Error).message.includes(FAKE_SCHEME), 'no raw ledger content in the message');
    assert.ok(!/DROP TABLE/.test((e as Error).message), 'no raw ledger content in the message');
  }
});

test('S1.6/S3: a hostile filesystem-port relDir cannot reach the printable relPath field', () => {
  const hostilePort: MigrationFsPort = {
    relDir: FAKE_URL,
    list: () => ['001_a.up.sql'],
    entryType: () => 'file',
    readBytes: () => new TextEncoder().encode('x'),
  };
  assert.equal(codeOf(() => discoverMigrations(hostilePort)), ENGINE_CODES.INVALID_LEDGER_FIELD);
  // A legitimate repository-relative label still works and is read once.
  let reads = 0;
  const okPort: MigrationFsPort = {
    get relDir(): string { reads += 1; return 'server/platform-identity/migrations'; },
    list: () => ['001_a.up.sql', '001_a.down.sql'],
    entryType: () => 'file',
    readBytes: (b: string) => new TextEncoder().encode(b),
  };
  const ds = discoverMigrations(okPort);
  assert.equal(ds[0].relPath, 'server/platform-identity/migrations/001_a.up.sql');
  assert.equal(reads, 1, 'relDir is read exactly once for the whole discovery');
});

test('S1.6/C1: an oversized error CODE is sanitized on the `code` property, not only in the message', () => {
  const err = new MigrationEngineError(`${'X'.repeat(300)}` as unknown as EngineCode, 'v');
  assert.ok(err.code.length <= 64, `the code property must stay bounded, got ${err.code.length}`);
  assert.ok(!/[^\x20-\x7e]/.test(err.code), 'the code property is printable ASCII only');
});

test('S1.6/C2: a throwing `length` getter on a caller-supplied array is bounded, never a raw leak', () => {
  const pairs = PAIRS();
  const hostile = { get length(): number { throw new Error('RAW SELECT secret /abs/path'); } } as unknown as LedgerRow[];
  for (const call of [() => computeStatus(pairs, hostile), () => planApply(pairs, hostile)]) {
    try {
      call();
      assert.fail('expected a bounded refusal');
    } catch (e) {
      assert.ok(e instanceof MigrationEngineError, 'a throwing length getter must become a MigrationEngineError');
      assert.ok(!/RAW|SELECT|abs/.test((e as Error).message), 'no raw getter message leaks');
    }
  }
});

test('S1.6/C3: the returned pending set holds the exact pairs that were classified', () => {
  // The pending set must carry the SAME pair objects the snapshot validated: re-reading
  // `pairs[i]` after classification lets an accessor or Proxy substitute a different pair
  // (and therefore different SQL) into a plan that was authorized for another version.
  const pairs = PAIRS();
  const decoy = pairs[1];
  let reads = 0;
  const shifty = new Proxy(pairs, {
    get(target, prop, recv) {
      if (prop === '0') { reads += 1; return reads === 1 ? target[0] : decoy; }
      return Reflect.get(target, prop, recv);
    },
  });
  const plan = planApply(shifty as unknown as MigrationPair[], []);
  // S1.7G REWRITE. A pending entry is now an engine-owned canonical SNAPSHOT — a public result may
  // share no object with caller input — so the identical property is asserted by canonical VALUE
  // instead of by reference identity, plus an explicit check that the substitution never lands and
  // that the caller's own object is NOT what the plan carries. This is strictly more than the old
  // single reference-equality assertion, not less.
  const identity = (p: MigrationPair): string =>
    `${p.version}|${p.name}|${p.transactionMode}|${p.up.checksum}|${p.up.artifact.sql}|${p.down.checksum}`;
  assert.equal(identity(plan.pending[0]), identity(pairs[0]), 'the pending entry is the classified pair, never a later substitution');
  assert.notEqual(identity(plan.pending[0]), identity(decoy), 'the decoy offered on a re-read never reaches the plan');
  assert.equal(reads, 1, 'the pair slot is read exactly once, so no substitution window exists');
  assert.equal(plan.pending.includes(pairs[0]), false, 'the plan holds an engine-owned snapshot, not the caller object');
});

test('S1.6/R1: a pair whose `up` getter varies per read is read exactly once', () => {
  const pairs = PAIRS();
  const real = pairs[0].up;
  let reads = 0;
  const shifty = { version: '001', get up(): MigrationDescriptor { reads += 1; return real; } } as unknown as MigrationPair;
  computeStatus([shifty], []);
  assert.equal(reads, 1, 'the pair `up` slot is read exactly once');
});

// --- S1.7B: fail-closed exported execution + pure decision kernel -----------

test('S1.7B: the exported runMigrations fail-closes with a bounded code and reaches NO port (well-formed forged deps)', async () => {
  // A generic in-process caller supplies a fully well-formed RunDeps — valid migration credential,
  // a valid connection mode, a safe-integer lock key, and its OWN recording ports — plus a valid
  // two-migration plan. The exported execution entry point refuses UNCONDITIONALLY with a bounded
  // code WITHOUT reaching a single session/ledger/lock/SQL port.
  const ports = recordingPorts();
  const forged: RunDeps = {
    adapter: ports.adapter, ledger: ports.ledger, connectionMode: 'session',
    credential: CRED, lockKey: 1, now: () => 'T',
  };
  await assert.rejects(
    runMigrations(twoPlan(), forged),
    (e: unknown) => e instanceof MigrationEngineError && e.code === ENGINE_CODES.MIGRATION_EXECUTION_UNAVAILABLE,
  );
  assert.deepEqual(ports.ops, [], 'no session/ledger/lock/SQL port may be reached by the exported run entry point');
});

test('S1.7B: the exported runMigrations refuses BEFORE reading any argument property (no getter, no Proxy trap fires)', async () => {
  // The shim documents that it refuses before it reads ANY argument property, evaluates ANY
  // getter, or triggers ANY Proxy trap. An implementation that validated a credential, a
  // connection mode, or a lock key first would trip one of these counters — the previous tests
  // passed only plain objects, so that ordering claim was asserted nowhere.
  let planTraps = 0;
  const planTrap = new Proxy({}, {
    get(_t, p) { planTraps += 1; throw new Error(`plan read ${String(p)}`); },
    has() { planTraps += 1; return false; },
    ownKeys() { planTraps += 1; return []; },
    getOwnPropertyDescriptor() { planTraps += 1; return undefined; },
  });
  const ports = recordingPorts();
  let depsGets = 0;
  const hostileDeps = {
    get adapter() { depsGets += 1; return ports.adapter; },
    get ledger() { depsGets += 1; return ports.ledger; },
    get connectionMode() { depsGets += 1; return 'session'; },
    get credential() { depsGets += 1; return CRED; },
    get lockKey() { depsGets += 1; return 1; },
    get now() { depsGets += 1; return () => 'T'; },
  };
  await assert.rejects(
    runMigrations(planTrap as unknown as ApplyPlan, hostileDeps as unknown as RunDeps),
    (e: unknown) => e instanceof MigrationEngineError && e.code === ENGINE_CODES.MIGRATION_EXECUTION_UNAVAILABLE,
  );
  assert.equal(planTraps, 0, 'no plan property is read — not one Proxy trap fires');
  assert.equal(depsGets, 0, 'no deps getter is evaluated before the refusal');
  assert.deepEqual(ports.ops, [], 'no session/ledger/lock/SQL port is reached');
});

test('S1.7B kernel: a reservation timeout is uncertain ownership (explicit cancel-and-dispose obligation); a mid-run timeout terminates', () => {
  const reserveTimeout = driveKernel(twoPlan(), execDeps(), (e) => e.kind === 'reserve' ? { type: 'timeout' } : okEvent()(e));
  assert.equal(reserveTimeout.state.outcome, 'failed');
  assert.equal(reserveTimeout.state.disposition, 'cancel_and_dispose', 'the kernel cannot destroy a resource it never received a handle for — it directs cancellation and disposal instead');
  assert.equal(reserveTimeout.state.ownershipUncertain, true, 'a reservation timeout is flagged uncertain');
  assert.equal(reserveTimeout.state.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT);
  const midTimeout = driveKernel(twoPlan(), execDeps(), (e) => e.kind === 'execute' ? { type: 'timeout' } : okEvent()(e));
  assert.equal(midTimeout.state.outcome, 'failed');
  assert.equal(midTimeout.state.disposition, 'terminate', 'a live-session timeout destroys the session');
  assert.equal(midTimeout.state.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT);
});

test('S1.7B kernel: an out-of-order / contradictory event fails closed (a live session terminates)', () => {
  // Awaiting `reserved`, feed an identity event instead. Until S1.7F this reported disposition
  // 'none' — "nothing outstanding and nothing held" — which the kernel cannot know at the reserve
  // step: the executor may hold a live reserved backend it merely reported in a non-canonical shape.
  // The verdict is now the honest one, and it is strictly stronger: cancel the outstanding attempt
  // and dispose of anything held or settling late.
  const start = startMigrationExecution(twoPlan(), execDeps());
  const step = stepMigrationExecution(start.state, { type: 'identity', identity: { token: 'x' } });
  assert.equal(step.state.outcome, 'failed');
  assert.equal(step.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
  assert.equal(step.state.disposition, 'cancel_and_dispose', 'reservation ownership is unknowable, so the executor is told to cancel and dispose');
  assert.equal(step.state.ownershipUncertain, true, 'ownership is uncertain before a confirmed session');
  assert.deepEqual(step.effects, [], 'zero effects');
  // Awaiting a post-lock identity verify, feed an `ok` instead → live session → terminate.
  let s = startMigrationExecution(twoPlan(), execDeps());
  s = stepMigrationExecution(s.state, { type: 'reserved' });
  s = stepMigrationExecution(s.state, { type: 'identity', identity: { token: 'p' } });
  s = stepMigrationExecution(s.state, { type: 'lock', acquired: true });
  const bad = stepMigrationExecution(s.state, { type: 'ok' });
  assert.equal(bad.state.outcome, 'failed');
  assert.equal(bad.state.disposition, 'terminate');
  assert.equal(bad.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
});

test('S1.7B kernel: a duplicate/late event on a terminal state is absorbed (no change, no effects)', () => {
  const done = driveKernel(twoPlan(), execDeps());
  assert.equal(done.state.outcome, 'complete');
  const again = stepMigrationExecution(done.state, { type: 'ok' });
  assert.equal(again.state.outcome, 'complete', 'a terminal state absorbs further events unchanged');
  assert.deepEqual(again.effects, []);
  const failed = driveKernel(twoPlan(), execDeps(), (e) => e.kind === 'execute' ? { type: 'port_failed' } : okEvent()(e));
  const afterFail = stepMigrationExecution(failed.state, { type: 'identity', identity: { token: 'x' } });
  assert.equal(afterFail.state.outcome, 'failed', 'a terminal failed state stays failed on a late event');
  assert.deepEqual(afterFail.effects, []);
});

test('S1.7B kernel: every emitted effect is inert data — frozen, only primitives, no function/getter', () => {
  const { effects } = driveKernel(twoPlan(), execDeps());
  assert.ok(effects.length > 0);
  for (const e of effects) {
    assert.ok(Object.isFrozen(e), `${e.kind} effect is frozen`);
    for (const k of Object.keys(e)) {
      const t = typeof (e as Record<string, unknown>)[k];
      assert.ok(t === 'string' || t === 'number' || t === 'boolean', `${e.kind}.${k} is a primitive (got ${t})`);
      const desc = Object.getOwnPropertyDescriptor(e, k)!;
      assert.equal(typeof desc.get, 'undefined', `${e.kind}.${k} has no getter`);
      assert.equal(typeof desc.set, 'undefined', `${e.kind}.${k} has no setter`);
    }
  }
});

test('S1.7B kernel (F9/D4): a non-canonical version never reaches a ledger-bound effect', () => {
  // `version` is copied VERBATIM into insert_dirty/execute/finalize — the effects an S1b executor
  // turns into DURABLE ledger rows. `typeof === 'string'` alone would admit unbounded,
  // non-printable, SQL-shaped text, so the canonical filename grammar every sibling ledger/status
  // path enforces is applied on the effect path too.
  const BEL = String.fromCharCode(7);
  for (const bad of ["001'; DROP TABLE users--", `001${BEL}`, 'a'.repeat(65), '0'.repeat(65), '00-1', '', ' 001']) {
    const r = startMigrationExecution(planWithVersion(bad), execDeps());
    assert.equal(r.state.outcome, 'refused', `version ${JSON.stringify(bad)} must refuse`);
    assert.equal(r.state.code, ENGINE_CODES.INVALID_LEDGER_FIELD, `version ${JSON.stringify(bad)} is a bounded ledger-field refusal`);
    assert.deepEqual(r.effects, [], 'a refused plan emits no effect at all');
    const dumped = JSON.stringify(r.state);
    assert.ok(!/DROP TABLE/.test(dumped), 'no smuggled SQL-shaped content in the verdict');
    assert.ok(!/[^\x20-\x7e]/.test(dumped), 'the verdict stays printable ASCII');
  }
  // The canonical form still builds, and the emitted ledger-bound effects carry exactly it.
  const okRun = driveKernel(planWithVersion('001'), execDeps());
  assert.equal(okRun.state.outcome, 'complete');
  for (const e of okRun.effects) {
    const v = (e as Record<string, unknown>).version;
    if (v !== undefined) assert.match(String(v), /^[0-9]{1,64}$/, `${e.kind}.version is canonical`);
  }
});

test('S1.7D kernel: a malformed or mutated state fails closed and grants no authority — it cannot emit any effect at all', () => {
  // (a) An UNREADABLE state must yield a BOUNDED verdict, never the caller's own raw exception, and
  //     never a disposal order for a resource whose liveness cannot be confirmed. Canonical capture
  //     achieves that WITHOUT invoking anything the caller supplied: the key set is wrong here, and
  //     where it is right the accessors are seen in the descriptors and rejected unevaluated.
  const boomOutcome = { get outcome(): string { throw new Error('RAW /abs/secret'); } } as unknown as ExecutionState;
  const r0 = stepMigrationExecution(boomOutcome, { type: 'reserved' });
  assert.equal(r0.state.outcome, 'failed');
  assert.equal(r0.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
  assert.equal(r0.state.disposition, 'cancel_and_dispose', 'liveness is unknowable, so the executor is told to cancel and dispose rather than to do nothing');
  assert.equal(r0.state.ownershipUncertain, true, 'liveness is unknowable on an unreadable state');
  assert.deepEqual(r0.effects, []);
  for (const field of ['program', 'cursor', 'sessionLive', 'expectedToken']) {
    const base: Record<string, unknown> = {
      outcome: 'in_progress', disposition: 'none', code: null, ownershipUncertain: false,
      program: [Object.freeze({ kind: 'reserve', connectionMode: 'session' })], cursor: 0,
      expectedToken: null, sessionLive: false,
    };
    Object.defineProperty(base, field, { get() { throw new Error('RAW /abs/secret'); } });
    const r = stepMigrationExecution(base as unknown as ExecutionState, { type: 'reserved' });
    assert.equal(r.state.outcome, 'failed', `a hand-built state with a throwing ${field} getter is refused`);
    assert.ok(!/RAW|abs\/secret/.test(JSON.stringify(r.state)), 'no caller content crosses the boundary');
  }
  // (b) A CLONE of a genuine state carrying a non-safe-integer or out-of-range cursor refuses instead
  //     of indexing: the cursor domain and the in-range requirement are part of canonical capture, so
  //     this is a REACHABLE, directly tested guard rather than an unreachable second barrier.
  for (const badCursor of [-1, 1.5, 9_999_999, Number.NaN, '0', null]) {
    const s = { ...startMigrationExecution(twoPlan(), execDeps()).state, cursor: badCursor } as unknown as ExecutionState;
    const r = stepMigrationExecution(s, { type: 'reserved' });
    assert.equal(r.state.outcome, 'failed', `a cloned state with cursor ${String(badCursor)} refuses`);
    assert.equal(r.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
    assert.deepEqual(r.effects, []);
  }
  // (c) A program that is a well-formed LIST but not a well-formed CHOREOGRAPHY emits NOTHING. This
  //     REPLACES the superseded S1.7B assertion that the kernel "echoes the caller's own object":
  //     returning `program[cursor + 1]` by IDENTITY put caller-authored SQL, a caller-chosen
  //     checksum, and a caller-chosen version across the effect boundary in a shape an S1b
  //     interpreter could not tell apart from engine-validated work. `[reserve, execute]` skips
  //     capture_identity, acquire_lock, and the dirty marker, so it does not parse and is refused.
  const smuggled = Object.freeze({ kind: 'execute', txScoped: true, version: '001', direction: 'up', checksum: 'c', sql: 'DROP TABLE users' });
  const forged = {
    outcome: 'in_progress', disposition: 'none', code: null, ownershipUncertain: false,
    program: Object.freeze([Object.freeze({ kind: 'reserve', connectionMode: 'session' }), smuggled]),
    cursor: 0, expectedToken: null, sessionLive: false,
  } as unknown as ExecutionState;
  // No port recorder here: `stepMigrationExecution(state, event)` has NO port parameter, so an
  // empty op log would be tautological. Kernel port-freeness is proven BEHAVIOURALLY in the export
  // sweep, which hands the kernel deps that really do carry recording ports.
  const r2 = stepMigrationExecution(forged, { type: 'reserved' });
  assert.equal(r2.effects.length, 0, 'a caller-authored program yields NO effect');
  // Scan the WHOLE result for the caller-owned object rather than asserting `effects[0] !== smuggled`:
  // once `effects` is known empty, `effects[0]` is `undefined` and that comparison holds vacuously,
  // so it would still pass if the object leaked through `state.program` instead.
  assert.ok(![...r2.effects, ...r2.state.program].includes(smuggled as unknown as ExecutionEffect), 'the caller-owned object appears nowhere in the result');
  assert.equal(r2.state.outcome, 'failed');
  assert.equal(r2.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
  assert.ok(!/DROP TABLE/.test(JSON.stringify(r2.state)), 'no caller-authored SQL crosses in the verdict either');
  for (const marker of ['trusted', 'authorized', 'verified', 'brand']) {
    assert.equal((r2.state as unknown as Record<string, unknown>)[marker], undefined, `no ${marker} authority field is ever added`);
  }
  // (d) An EXHAUSTED program (a cursor with no current effect) also fails closed — refused by the
  //     in-range requirement in canonical capture, which is again a reachable, tested guard.
  const exhausted = { ...(forged as unknown as ExecutionState), cursor: 1 } as unknown as ExecutionState;
  const r3 = stepMigrationExecution(exhausted, { type: 'ok' });
  assert.equal(r3.state.outcome, 'failed');
  assert.equal(r3.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
  assert.deepEqual(r3.effects, []);
});

test('S1.7B kernel: a forged event with a throwing type/value getter fails closed (never a raw exception)', () => {
  const start = startMigrationExecution(twoPlan(), execDeps());
  // A throwing `type` getter is treated as an invalid (unreadable) event — fail closed, no raw throw.
  const badType = stepMigrationExecution(start.state, { get type(): 'reserved' { throw new Error('x'); } } as unknown as ExecutionEvent);
  assert.equal(badType.state.outcome, 'failed');
  assert.equal(badType.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
  // An ACCESSOR-backed `acquired` slot at the acquire_lock step. Until S1.7E this getter was
  // INVOKED under a guard and its throw distilled to `acquired: false` → RUN_LOCK_UNAVAILABLE.
  // The slot is now read from its descriptor, so the getter never runs and the event is simply
  // not a canonical event: the refusal code is coarser, and it is still fail-closed — no lock is
  // recorded as held, no dirty row follows, and the confirmed live session is terminated.
  let s = startMigrationExecution(twoPlan(), execDeps());
  s = stepMigrationExecution(s.state, { type: 'reserved' });
  s = stepMigrationExecution(s.state, { type: 'identity', identity: { token: 'p' } });
  const badAcq = stepMigrationExecution(s.state, { type: 'lock', get acquired(): boolean { throw new Error('x'); } } as unknown as ExecutionEvent);
  assert.equal(badAcq.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
  assert.equal(badAcq.state.disposition, 'terminate');
  assert.deepEqual(badAcq.effects, [], 'an accessor-backed lock result emits nothing');
});

// --- S1.7C: inert-effect boundary + explicit reservation-cleanup obligation --

test('S1.7D kernel: only a CANONICAL state can emit an effect — a malformed, contradictory, or booby-trapped state emits none', () => {
  // S1.7B returned `state.program[cursor + 1]` BY IDENTITY, so a hand-built state handed the caller
  // back its OWN object as a kernel effect: caller-authored SQL, a caller-chosen checksum, and a
  // caller-chosen version crossed the effect boundary in a shape an S1b interpreter could not tell
  // apart from engine-validated work. S1.7C closed that with an origin registry; S1.7D closes it
  // with STRUCTURE instead — a state that is not canonical emits nothing, and a state that IS
  // canonical emits only values the kernel newly allocated from validated primitives.
  const smuggled = Object.freeze({ kind: 'execute', txScoped: true, version: '001', direction: 'up', checksum: 'c', sql: 'DROP TABLE users' });
  const forged = {
    outcome: 'in_progress', disposition: 'none', code: null, ownershipUncertain: false,
    program: Object.freeze([Object.freeze({ kind: 'reserve', connectionMode: 'session' }), smuggled]),
    cursor: 0, expectedToken: null, sessionLive: false,
  } as unknown as ExecutionState;
  const r = stepMigrationExecution(forged, { type: 'reserved' });
  assert.deepEqual(r.effects, [], 'a caller-authored program emits ZERO effects');
  // As above: scan the whole result, because `effects[0] !== smuggled` is vacuous once empty.
  assert.ok(![...r.effects, ...r.state.program].includes(smuggled as unknown as ExecutionEffect), 'the caller-owned object appears nowhere in the result');
  assert.equal(r.state.outcome, 'failed');
  assert.equal(r.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
  assert.ok(!/DROP TABLE/.test(JSON.stringify(r.state)), 'no caller-controlled text crosses the boundary');

  // A CLONE of a genuine engine state that jumps the cursor forward is CONTRADICTORY, not merely
  // foreign: it reuses the engine's own validated program but keeps `sessionLive: false` and
  // `expectedToken: null` while claiming a mid-run position, and no trajectory reaches that. The
  // capture rejects it on that inconsistency alone — no registry, no identity, no origin.
  const live = startMigrationExecution(twoPlan(), execDeps());
  const execIndex = live.state.program.findIndex((e) => e.kind === 'execute');
  assert.ok(execIndex > 0, 'the engine program does contain an execute effect to jump to');
  const cloned = { ...live.state, cursor: execIndex - 1 } as unknown as ExecutionState;
  const rc = stepMigrationExecution(cloned, { type: 'identity', identity: { token: 'p' } });
  assert.deepEqual(rc.effects, [], 'a cloned state carrying a caller-chosen cursor emits ZERO effects');
  assert.equal(rc.state.outcome, 'failed');
  assert.equal(rc.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);

  // The engine state is an IMMUTABLE VALIDATED SNAPSHOT in full, so a returned state can never be
  // mutated after creation: the state is frozen, the program array is frozen, and every effect is
  // frozen with primitive-ONLY fields (no function, getter, setter, thenable, or symbol-keyed key).
  assert.ok(Object.isFrozen(live.state), 'the state is frozen');
  assert.ok(Object.isFrozen(live.state.program), 'the program array is frozen');
  // The KernelResult WRAPPER is frozen too, on both the success and the refusal path — otherwise a
  // holder could swap `state` or `effects` on a result and pass it on as though the kernel had
  // produced the substitution.
  assert.ok(Object.isFrozen(live), 'the in-progress KernelResult wrapper is frozen');
  assert.ok(Object.isFrozen(r), 'the refusal KernelResult wrapper is frozen');
  assert.ok(Object.isFrozen(live.effects), 'the emitted effects array is frozen');
  for (const e of live.state.program) {
    assert.ok(Object.isFrozen(e), `${e.kind} program entry is frozen`);
    assert.equal(Object.getOwnPropertySymbols(e).length, 0, `${e.kind} carries no symbol-keyed marker`);
    for (const k of Object.keys(e)) {
      const t = typeof (e as Record<string, unknown>)[k];
      assert.ok(t === 'string' || t === 'number' || t === 'boolean', `${e.kind}.${k} is a primitive (got ${t})`);
      const d = Object.getOwnPropertyDescriptor(e, k)!;
      assert.equal(typeof d.get, 'undefined', `${e.kind}.${k} has no getter`);
      assert.equal(typeof d.set, 'undefined', `${e.kind}.${k} has no setter`);
    }
  }
  const before = JSON.stringify(live.state);
  try { (live.state as unknown as { cursor: number }).cursor = 99; } catch { /* frozen: strict-mode TypeError */ }
  try { (live.state.program as ExecutionEffect[])[0] = smuggled as unknown as ExecutionEffect; } catch { /* frozen */ }
  assert.equal(JSON.stringify(live.state), before, 'an engine-origin state cannot be mutated after creation');

  // A state whose FIELD GETTERS throw is refused before a single one is evaluated: capture reads
  // property DESCRIPTORS, sees the accessors, and rejects — so a getter or trap exception cannot
  // even begin to escape as a raw error out of this pure function.
  let getterCalls = 0;
  const boobyTrapped = {
    outcome: 'in_progress', disposition: 'none', code: null, ownershipUncertain: false,
    get program(): never { getterCalls += 1; throw new Error('RAW /abs/secret'); },
    get cursor(): never { getterCalls += 1; throw new Error('RAW /abs/secret'); },
    get sessionLive(): never { getterCalls += 1; throw new Error('RAW /abs/secret'); },
    get expectedToken(): never { getterCalls += 1; throw new Error('RAW /abs/secret'); },
  } as unknown as ExecutionState;
  const rb = stepMigrationExecution(boobyTrapped, { type: 'reserved' });
  assert.equal(rb.state.outcome, 'failed');
  assert.deepEqual(rb.effects, []);
  assert.equal(getterCalls, 0, 'not one caller getter is evaluated');
  assert.ok(!/RAW|abs\/secret/.test(JSON.stringify(rb.state)), 'no caller content crosses the boundary');
});

test('S1.7D: NO hidden origin registry or intrinsic-patch authority surface remains — no membership primitive can change a kernel decision', () => {
  // REPLACES the S1.7C test "replacing WeakSet.prototype.has AFTER module load cannot turn the
  // origin gate fail-open". That test existed only because a decision DEPENDED on WeakSet
  // membership: the gate was an identity check, so a mutable realm intrinsic sat on the security
  // path and had to be captured at load. S1.7D deletes the dependency rather than defending it, so
  // the replacement property is the stronger and simpler one — NO membership primitive is on the
  // path at all, and therefore none of them can be patched into influence.
  //
  // (1) STRUCTURAL: the module contains no origin/provenance registry to gate on.
  const source = readFileSync(new URL('./migrationEngine.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const forbidden of ['WeakSet', 'WeakMap', 'getOwnPropertySymbols', 'Symbol(', 'globalThis']) {
    assert.ok(!code.includes(forbidden), `no runtime \`${forbidden}\` remains in the engine (found outside comments)`);
  }
  // No MODULE-SCOPE mutable collection of any kind: a registry must live across calls to be one, and
  // a top-level binding is the only place it could. (A Set built and discarded INSIDE one pure call
  // — discovery's duplicate-basename check — cannot carry state between calls and is not a registry.)
  const moduleScopeCollections = code.split('\n').filter((l) => /^(?:const|let|var)\s+\w+\s*(?::[^=]*)?=\s*new\s+(?:Weak)?(?:Set|Map)\b/.test(l));
  assert.deepEqual(moduleScopeCollections, [], 'no module-scope Set/Map/WeakSet/WeakMap exists to hold provenance');

  // (2) BEHAVIOURAL: patch every membership primitive a replacement registry could be built on,
  //     fail-open AND fail-closed, and prove every observable decision is byte-identical.
  // Inputs are built BEFORE any patch, so what is measured under the patch is the KERNEL TRANSITION
  // alone rather than plan construction.
  const live = startMigrationExecution(twoPlan(), execDeps());
  const foreign = JSON.parse(JSON.stringify(live.state)) as ExecutionState;
  const smuggled = Object.freeze({ kind: 'execute', txScoped: true, version: '001', direction: 'up', checksum: 'c', sql: 'DROP TABLE users' });
  const bogus = {
    outcome: 'in_progress', disposition: 'none', code: null, ownershipUncertain: false,
    program: Object.freeze([Object.freeze({ kind: 'reserve', connectionMode: 'session' }), smuggled]),
    cursor: 0, expectedToken: null, sessionLive: false,
  } as unknown as ExecutionState;
  const decisions = (): string => JSON.stringify([
    shapeOf(stepMigrationExecution(live.state, { type: 'reserved' })),
    shapeOf(stepMigrationExecution(foreign, { type: 'reserved' })),
    shapeOf(stepMigrationExecution(bogus, { type: 'reserved' })),
    shapeOf(stepMigrationExecution(live.state, { type: 'ok' })),
    shapeOf(stepMigrationExecution(live.state, { type: 'identity', identity: { token: 'p' } })),
  ]);
  const baseline = decisions();
  const dupPort: MigrationFsPort = {
    relDir: 'server/platform-identity/migrations',
    list: () => ['001_a.up.sql', '001_a.up.sql'],
    entryType: () => 'file',
    readBytes: () => new TextEncoder().encode('select 1;\n'),
  };
  const expectedDiscovery = discoverMigrations(fakeFs(TWO_PAIRS)).map((d) => `${d.version}.${d.direction}`).join(',');
  let observedDiscovery = '';
  let observedDuplicate = '';
  const saved: Array<[object, string, PropertyDescriptor]> = [];
  const patch = (proto: object, name: string, value: unknown): void => {
    saved[saved.length] = [proto, name, Object.getOwnPropertyDescriptor(proto, name)!];
    Object.defineProperty(proto, name, { value, writable: true, configurable: true });
  };
  try {
    patch(WeakSet.prototype, 'has', () => true);
    patch(WeakSet.prototype, 'add', function add(this: unknown) { return this; });
    patch(WeakMap.prototype, 'has', () => true);
    patch(WeakMap.prototype, 'get', () => true);
    patch(WeakMap.prototype, 'set', function set(this: unknown) { return this; });
    patch(Set.prototype, 'has', () => true);
    patch(Map.prototype, 'has', () => true);
    patch(Map.prototype, 'get', () => true);
    // Self-check: the patches must really be in force, otherwise this test proves nothing.
    assert.equal(new WeakSet().has({}), true, 'WeakSet.prototype.has really was patched');
    assert.equal(new WeakMap().get({}), true, 'WeakMap.prototype.get really was patched');
    assert.equal(new Set().has(0), true, 'Set.prototype.has really was patched');
    assert.equal(decisions(), baseline, 'no membership primitive influences any kernel decision');
    // Discovery uses a local Set to reject duplicate (version, direction) keys. Until S1.7F that set
    // was consulted through the LIVE `Set.prototype.has`, so a fail-open patch made discovery refuse
    // EVERYTHING — the asymmetry was merely favourable, not absent. The membership methods are now
    // BOUND at module load, so the patch has no effect in EITHER direction: valid history discovers
    // unchanged, and a genuine duplicate is still refused.
    observedDiscovery = discoverMigrations(fakeFs(TWO_PAIRS)).map((d) => `${d.version}.${d.direction}`).join(',');
    observedDuplicate = codeOf(() => discoverMigrations(dupPort));
  } finally {
    for (const [proto, name, desc] of saved) Object.defineProperty(proto, name, desc);
  }
  assert.equal(observedDiscovery, expectedDiscovery, 'a fail-open membership patch does not change what discovery accepts');
  assert.equal(observedDuplicate, ENGINE_CODES.DUPLICATE_VERSION_DIRECTION, 'a genuine duplicate is still refused under a fail-open membership patch');

  // (3) The CAPTURE and RESULT-CONSTRUCTION intrinsics are bound at module load for the same reason.
  //     Re-pointing `Reflect.ownKeys` selects by identity and breaks determinism; `Array.prototype.push`
  //     makes the rebuild store the caller's own objects and breaks reference isolation;
  //     `Object.freeze` turned into a thrower turns a bounded refusal into an escaping raw exception;
  //     `Array.prototype.indexOf` returning 0 makes every closed domain accept. None may matter.
  const savedCapture: Array<[object, string, PropertyDescriptor]> = [];
  const capture = (o: object, name: string, value: unknown): void => {
    // Index assignment, NOT push: this very test re-points `Array.prototype.push` partway through
    // the sequence, so a push-based recorder would silently drop every later saved descriptor and
    // leave the intrinsics patched for the rest of the suite.
    savedCapture[savedCapture.length] = [o, name, Object.getOwnPropertyDescriptor(o, name)!];
    Object.defineProperty(o, name, { value, writable: true, configurable: true });
  };
  let underPatch = '';
  let escaped: unknown = null;
  try {
    capture(Reflect, 'ownKeys', (): never => { throw new Error('RAW ownKeys /abs/secret'); });
    capture(Object, 'freeze', (): never => { throw new Error('RAW freeze /abs/secret'); });
    capture(Array.prototype, 'push', function push(this: unknown[]): number { return this.length; });
    // Every one of these is on a live path since the bindings moved to module load: a re-pointed
    // `RegExp.prototype.exec` defeats a bound `test` (which re-dispatches through the receiver),
    // `Object.create` backs the capture record, `charCodeAt`/`fromCharCode` back every character
    // domain check and the error sanitizer, and `Object.keys`/`isArray`/`isSafeInteger` back the
    // shape checks. (`Array.prototype.indexOf` is deliberately NOT patched here: the module calls
    // it nowhere, so patching it would assert nothing.)
    capture(RegExp.prototype, 'exec', (): unknown => ({ index: 0, 0: '', input: '' }));
    capture(Object, 'create', (): unknown => ({ kind: 'close' }));
    capture(String.prototype, 'replace', (): string => '9');
    capture(String.prototype, 'slice', (): string => 'RAW');
    capture(Object, 'keys', (): string[] => []);
    capture(Array, 'isArray', (): boolean => true);
    capture(Number, 'isSafeInteger', (): boolean => true);
    // Patched LAST: `capture` itself reads descriptors, so re-pointing this any earlier would
    // sabotage the save-and-restore rather than the engine.
    // Self-checks: every patch must really be in force, or the comparison below proves nothing.
    assert.equal(/^[0-9]$/.test('zz'), true, 'RegExp.prototype.exec really was patched');
    assert.deepEqual(Object.create(null), { kind: 'close' }, 'Object.create really was patched');
    assert.equal('001'.replace(/0/, ''), '9', 'String.prototype.replace really was patched');
    assert.equal(Number.isSafeInteger(1.5), true, 'Number.isSafeInteger really was patched');
    capture(Object, 'getOwnPropertyDescriptor', (): never => { throw new Error('RAW descriptor /abs/secret'); });
    underPatch = decisions();
  } catch (e) {
    escaped = e;
  } finally {
    for (const [o, n, d] of savedCapture) Object.defineProperty(o, n, d);
  }
  assert.equal(escaped, null, 'no raw exception escapes when a capture intrinsic is re-pointed mid-call');
  assert.equal(underPatch, baseline, 'the capture intrinsics are bound at load, so re-pointing them changes no decision');

  // (4) PROGRAM CONSTRUCTION specifically. `buildProgram` originates the array, so a re-pointed
  //     `Array.prototype.push` there would be strictly worse than at the rebuild site: rather than
  //     leaking a reference it could APPEND a complete, grammar-valid block of the patcher's
  //     choosing into an engine-allocated program, which canonical capture would then certify.
  //     Only `push` is patched here — the wider set above perturbs credential and label validation,
  //     which live outside the kernel's bound-intrinsic surface and would confound the comparison.
  const plan = twoPlan();                                   // built before the patch: discovery uses Object.keys
  const builtBaseline = JSON.stringify(shapeOf(startMigrationExecution(plan, execDeps())));
  const pushDesc = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!;
  let builtUnderPatch = '';
  let buildEscaped: unknown = null;
  try {
    Object.defineProperty(Array.prototype, 'push', { value: function push(this: unknown[]): number { return this.length; }, writable: true, configurable: true });
    builtUnderPatch = JSON.stringify(shapeOf(startMigrationExecution(plan, execDeps())));
  } catch (e) {
    buildEscaped = e;
  } finally {
    Object.defineProperty(Array.prototype, 'push', pushDesc);
  }
  assert.equal(buildEscaped, null, 'construction raises no exception under a re-pointed push');
  assert.equal(builtUnderPatch, builtBaseline, 'a re-pointed Array.prototype.push cannot change the program the engine builds');
  assert.ok(builtBaseline.includes('"kind":"reserve"'), 'the baseline really did build a program');

  assert.equal(new WeakSet().has({}), false, 'the intrinsics are restored for every other test');
  assert.equal(decisions(), baseline, 'and the decisions are unchanged afterwards');
  assert.equal(driveKernel(twoPlan(), execDeps()).state.outcome, 'complete', 'a genuine run is unaffected throughout');
});

test('S1.7C kernel: a pre-reservation timeout carries an EXPLICIT cancellation-and-disposal obligation, never "nothing to do"', () => {
  // A reservation TIMEOUT settled NOTHING: no handle reached the kernel, yet a backend may still be
  // created after this verdict. Reporting `disposition: 'none'` reads as "nothing to do" on exactly
  // the path where an acquisition attempt is still outstanding, so the verdict must name BOTH
  // obligations the kernel cannot discharge itself — CANCEL the outstanding attempt, and DISPOSE of
  // any session that settles late. Real deadlines, driver cancellation, socket destruction,
  // late-settlement interception, and physical disposal remain S1b executor/adapter duties.
  const t = driveKernel(twoPlan(), execDeps(), (e) => e.kind === 'reserve' ? { type: 'timeout' } : okEvent()(e));
  assert.equal(t.state.outcome, 'failed');
  assert.equal(t.state.code, ENGINE_CODES.EXECUTION_STEP_TIMEOUT);
  assert.equal(t.state.ownershipUncertain, true, 'ownership is unknown before a confirmed handle');
  assert.equal(t.state.disposition, 'cancel_and_dispose', 'the executor MUST cancel the attempt and dispose of a late settlement');
  assert.deepEqual(t.kinds, ['reserve'], 'no normal migration effect is ever emitted');
  assert.notEqual(t.state.disposition, 'terminate', 'the kernel never orders destruction of a handle it never received');

  // S1.7G REWRITE. This block previously asserted that a SETTLED reservation failure reports
  // 'none' with certain ownership. That assertion encoded the defect: settling as a failure proves
  // the CALL is over, not that it allocated nothing. `ReservedSessionAdapter.reserve` is
  // `(mode) => Promise<ReservedSession>` and states no atomic no-allocation-on-failure guarantee,
  // so a driver may open a socket, start a backend, and only then reject. The two pre-reservation
  // paths must still stay DISTINGUISHABLE — otherwise the verdict carries no information — but
  // they are distinguished by their bounded CODE, not by pretending one of them is safe.
  const f = driveKernel(twoPlan(), execDeps(), (e) => e.kind === 'reserve' ? { type: 'port_failed' } : okEvent()(e));
  assert.equal(f.state.code, ENGINE_CODES.PORT_OPERATION_FAILED);
  assert.notEqual(f.state.code, t.state.code, 'a settled failure and a timeout stay distinguishable by code');
  assert.equal(f.state.ownershipUncertain, true, 'a rejecting reserve may already have allocated a backend');
  assert.equal(f.state.disposition, 'cancel_and_dispose', 'cancel the attempt and dispose of anything already allocated');
  assert.deepEqual(f.kinds, ['reserve'], 'no normal migration effect is ever emitted');
  assert.notEqual(f.state.disposition, 'terminate', 'the kernel never orders destruction of a handle it never received');

  // Once a handle IS confirmed, the kernel names the resource it knows exists: destroy it.
  const mid = driveKernel(twoPlan(), execDeps(), (e) => e.kind === 'execute' ? { type: 'timeout' } : okEvent()(e));
  assert.equal(mid.state.disposition, 'terminate', 'a live-session timeout destroys the confirmed session');
  assert.equal(mid.state.ownershipUncertain, false, 'a confirmed handle is not uncertain ownership');

  // INVARIANT: ownershipUncertain === true ALWAYS carries the explicit cleanup obligation, so an
  // uncertain outcome can never be reported as "nothing to do" on any path that produces one.
  const uncertain = [t.state, stepMigrationExecution({} as unknown as ExecutionState, { type: 'ok' }).state];
  for (const s of uncertain) {
    assert.equal(s.ownershipUncertain, true);
    assert.equal(s.disposition, 'cancel_and_dispose', 'ownershipUncertain === true implies cancel_and_dispose');
  }
  // …and the BICONDITIONAL holds across every observable terminal verdict, so the two fields can
  // never disagree in either direction: no silent "uncertain but nothing to do", and no explicit
  // cancel-and-dispose order that fails to declare the uncertainty justifying it.
  const verdicts = [
    t.state, f.state, mid.state,
    driveKernel(twoPlan(), execDeps()).state,                                    // complete / none
    startMigrationExecution(twoPlan(), execDeps('transaction')).state,           // refused / none
    driveKernel(twoPlan(), execDeps(), (e) => e.kind === 'close' ? { type: 'port_failed' } : okEvent()(e)).state, // failed / terminate
    stepMigrationExecution({} as unknown as ExecutionState, { type: 'ok' }).state,
  ];
  for (const s of verdicts) {
    assert.equal(
      s.ownershipUncertain,
      s.disposition === 'cancel_and_dispose',
      `verdict ${String(s.code)}: ownershipUncertain must hold exactly when disposition is cancel_and_dispose`,
    );
  }
});

// --- S1.7D: pure-kernel determinism over canonical structural data ----------
// The kernel must be a function of the DATA it is given, never of how that data was constructed.
// These tests pin that contract: equivalent canonical snapshots produce equivalent bounded
// decisions, a structurally valid caller-created snapshot may run an inert simulation, and every
// value handed back is newly allocated — so no caller-owned reference ever crosses the boundary.

/** A JSON-comparable projection of a KernelResult: everything the kernel OBSERVABLY decided, with
 *  all object identity stripped. Two results with equal shapes are the SAME decision. */
const shapeOf = (r: { state: ExecutionState; effects: readonly ExecutionEffect[] }) => ({
  outcome: r.state.outcome,
  disposition: r.state.disposition,
  code: r.state.code,
  ownershipUncertain: r.state.ownershipUncertain,
  cursor: r.state.cursor,
  expectedToken: r.state.expectedToken,
  sessionLive: r.state.sessionLive,
  program: r.state.program.map((e) => ({ ...e })),
  effects: r.effects.map((e) => ({ ...e })),
});

test('S1.7D kernel: equivalent canonical state data produces an equivalent decision regardless of construction origin', () => {
  const live = startMigrationExecution(twoPlan(), execDeps());
  const ev: ExecutionEvent = { type: 'reserved' };
  const engineBuilt = stepMigrationExecution(live.state, ev);

  // Three constructions of the SAME canonical data. None of them is the object the engine built,
  // and none of them can be distinguished from it by any bounded structural predicate.
  const cloned = { ...live.state } as ExecutionState;
  const handBuilt = {
    outcome: 'in_progress', disposition: 'none', code: null, ownershipUncertain: false,
    program: live.state.program, cursor: 0, expectedToken: null, sessionLive: false,
  } as unknown as ExecutionState;
  const deserialized = JSON.parse(JSON.stringify(live.state)) as ExecutionState;

  for (const [label, s] of [
    ['spread clone', cloned], ['hand-built', handBuilt], ['deserialized', deserialized],
  ] as const) {
    assert.deepEqual(
      shapeOf(stepMigrationExecution(s, ev)),
      shapeOf(engineBuilt),
      `${label}: equivalent canonical input must produce an equivalent bounded decision`,
    );
  }
});

test('S1.7D kernel: a structurally valid caller-created snapshot receives NEWLY ALLOCATED effects sharing no reference with its input', () => {
  const live = startMigrationExecution(twoPlan(), execDeps());
  const caller = JSON.parse(JSON.stringify(live.state)) as ExecutionState;
  const callerOwned = new Set<unknown>([caller, caller.program, ...caller.program]);

  const r = stepMigrationExecution(caller, { type: 'reserved' });
  assert.equal(r.effects.length, 1, 'a structurally valid snapshot simulates and emits the next effect');
  assert.deepEqual({ ...r.effects[0] }, { ...caller.program[1] }, 'the emitted effect is structurally the next program entry');

  // Inert, deeply frozen, and allocated by the kernel — never the caller's own object.
  assert.ok(Object.isFrozen(r), 'the KernelResult wrapper is frozen');
  assert.ok(Object.isFrozen(r.state), 'the returned state is frozen');
  assert.ok(Object.isFrozen(r.state.program), 'the returned program is frozen');
  assert.ok(Object.isFrozen(r.effects), 'the emitted effects array is frozen');
  assert.ok(Object.isFrozen(r.effects[0]), 'the emitted effect is frozen');
  for (const e of r.effects) assert.ok(!callerOwned.has(e), 'no emitted effect is a caller-owned object');
  for (const e of r.state.program) assert.ok(!callerOwned.has(e), 'no returned program entry is a caller-owned object');
  assert.ok(!callerOwned.has(r.state), 'the returned state is not the caller-owned object');
  assert.ok(!callerOwned.has(r.state.program), 'the returned program is not the caller-owned array');

  // Mutating the ORIGINAL input afterwards can influence neither the returned value nor a later
  // transition: the kernel kept no reference to it.
  const before = JSON.stringify(r.state);
  (caller.program as unknown as Record<number, unknown>)[1] = { kind: 'execute', txScoped: true, version: '001', direction: 'up', checksum: 'c', sql: 'DROP TABLE users' };
  (caller as unknown as Record<string, unknown>).cursor = 99;
  assert.equal(JSON.stringify(r.state), before, 'mutating the original input cannot alter a returned state');
  const next = stepMigrationExecution(r.state, { type: 'identity', identity: { token: 'p' } });
  assert.ok(!/DROP TABLE/.test(JSON.stringify(next)), 'nor can it alter a later transition');
});

test('S1.7D kernel: contradictory, malformed, unbounded, or invalidly ORDERED input emits zero effects and a bounded verdict', () => {
  const live = startMigrationExecution(twoPlan(), execDeps());
  const good = JSON.parse(JSON.stringify(live.state)) as Record<string, unknown>;
  const withState = (patch: Record<string, unknown>): ExecutionState =>
    ({ ...JSON.parse(JSON.stringify(good)), ...patch }) as unknown as ExecutionState;
  const prog = (): Record<string, unknown>[] => JSON.parse(JSON.stringify(good.program)) as Record<string, unknown>[];
  const dirtyAt = prog().findIndex((e) => e.kind === 'insert_dirty');
  assert.ok(dirtyAt > 0, 'the engine program contains a dirty marker to remove');
  // The two-pair engine program is head(4) · block(7) · block(7) · tail(4). Splitting it lets the
  // pair blocks be swapped or duplicated to test cross-block ordering.
  const HEAD = 4, BLOCK = 7;
  const p0 = prog();
  const head = p0.slice(0, HEAD);
  const blockA = p0.slice(HEAD, HEAD + BLOCK);
  const blockB = p0.slice(HEAD + BLOCK, HEAD + 2 * BLOCK);
  const tail = p0.slice(HEAD + 2 * BLOCK);
  assert.deepEqual([blockA[0].version, blockB[0].version], ['001', '002'], 'the two pair blocks are 001 then 002');
  const reorderedPairs = (): Record<string, unknown>[] => [...head, ...blockB, ...blockA, ...tail];
  const duplicatedPair = (): Record<string, unknown>[] => [...head, ...blockA, ...blockA, ...tail];
  // Control: the UNMODIFIED split reassembles into a program that still canonicalizes, so the two
  // rejections above are attributable to the reordering, not to the splitting.
  assert.equal(stepMigrationExecution(withState({ program: [...head, ...blockA, ...blockB, ...tail] }), { type: 'reserved' }).effects.length, 1, 'the reassembled control program advances');

  const bad: Array<[string, unknown]> = [
    // --- not an object at all -------------------------------------------------------------
    ['null', null], ['undefined', undefined], ['a number', 7], ['a string', 'in_progress'], ['an array', []],
    // --- shape ---------------------------------------------------------------------------
    ['an extra own key', { ...good, extra: 1 }],
    ['a missing key', (() => { const s = { ...good }; delete s.expectedToken; return s; })()],
    ['a symbol key', Object.defineProperty({ ...good }, Symbol('brand'), { value: 1, enumerable: true })],
    ['an accessor field', Object.defineProperty({ ...good }, 'cursor', { get: () => 0, enumerable: true, configurable: true })],
    // --- domains -------------------------------------------------------------------------
    ['an unknown outcome', withState({ outcome: 'running' })],
    ['an unknown disposition', withState({ disposition: 'destroy' })],
    ['an out-of-domain code', withState({ code: 'not_an_engine_code', outcome: 'failed', program: [], disposition: 'terminate' })],
    ['a non-boolean liveness', withState({ sessionLive: 1 })],
    ['a fractional cursor', withState({ cursor: 0.5 })],
    ['an oversized token', withState({ cursor: 2, sessionLive: true, expectedToken: 't'.repeat(257) })],
    // --- contradictions ------------------------------------------------------------------
    ['uncertain but disposition none', withState({ outcome: 'failed', disposition: 'none', ownershipUncertain: true, program: [], code: ENGINE_CODES.EXECUTION_STEP_TIMEOUT })],
    ['cancel_and_dispose but not uncertain', withState({ outcome: 'failed', disposition: 'cancel_and_dispose', ownershipUncertain: false, program: [], code: ENGINE_CODES.EXECUTION_STEP_TIMEOUT })],
    ['complete carrying a code', withState({ outcome: 'complete', program: [], code: ENGINE_CODES.RUN_LOCK_UNAVAILABLE })],
    ['failed carrying no code', withState({ outcome: 'failed', disposition: 'terminate', program: [], code: null })],
    ['a terminal verdict still carrying a program', withState({ outcome: 'failed', disposition: 'terminate', code: ENGINE_CODES.RUN_LOCK_UNAVAILABLE })],
    ['in_progress carrying a code', withState({ code: ENGINE_CODES.RUN_LOCK_UNAVAILABLE })],
    ['live before the reserve step', withState({ sessionLive: true })],
    ['not live after the reserve step', withState({ cursor: 1, sessionLive: false })],
    ['a token before capture_identity', withState({ cursor: 1, sessionLive: true, expectedToken: 'p' })],
    ['no token after capture_identity', withState({ cursor: 2, sessionLive: true, expectedToken: null })],
    ['an exhausted cursor', withState({ cursor: (good.program as unknown[]).length, sessionLive: true, expectedToken: 'p' })],
    // --- invalid ORDERING: the choreography grammar, not merely well-formed effects --------
    ['a program with no dirty marker before schema', withState({ program: prog().filter((e) => e.kind !== 'insert_dirty') })],
    ['a program with no lock', withState({ program: prog().filter((e) => e.kind !== 'acquire_lock') })],
    ['a program with no identity re-verification', withState({ program: prog().filter((e) => e.kind !== 'verify_identity') })],
    ['a program with no finalize', withState({ program: prog().filter((e) => e.kind !== 'finalize') })],
    ['a program with no unlock', withState({ program: prog().filter((e) => e.kind !== 'release_lock') })],
    ['a program with no close', withState({ program: prog().filter((e) => e.kind !== 'close') })],
    ['a program with a broken tx bracket', withState({ program: prog().filter((e) => e.kind !== 'commit_tx') })],
    ['a program whose dirty marker follows the schema', withState({ program: (() => { const p = prog(); const [d] = p.splice(dirtyAt, 1); p.splice(dirtyAt + 3, 0, d); return p; })() })],
    ['a program releasing a different lock key', withState({ program: prog().map((e) => (e.kind === 'release_lock' ? { ...e, lockKey: 999 } : e)) })],
    ['a program whose sql does not match its checksum', withState({ program: prog().map((e) => (e.kind === 'execute' ? { ...e, sql: 'DROP TABLE users' } : e)) })],
    ['a program executing a DOWN migration', withState({ program: prog().map((e) => (e.kind === 'execute' ? { ...e, direction: 'down' } : e)) })],
    ['a program whose finalize names another version', withState({ program: prog().map((e) => (e.kind === 'finalize' ? { ...e, version: '999' } : e)) })],
    ['a program reserving a pooled transaction backend', withState({ program: prog().map((e) => (e.kind === 'reserve' ? { ...e, connectionMode: 'transaction' } : e)) })],
    ['an effect with an extra own key', withState({ program: prog().map((e) => (e.kind === 'close' ? { ...e, authorized: true } : e)) })],
    // --- unbounded -----------------------------------------------------------------------
    ['an unbounded program', withState({ program: new Array(4097).fill({ kind: 'close' }) })],
    ['a program whose length is a getter', withState({ program: { get length(): number { return 1; }, 0: { kind: 'close' } } })],
    ['an array-LIKE program container', withState({ program: { length: (good.program as unknown[]).length, ...prog() } })],
    ['a program array carrying an extra own key', withState({ program: Object.assign(prog(), { smuggled: { kind: 'execute' } }) })],
    ['a program array carrying a symbol key', withState({ program: Object.defineProperty(prog(), Symbol('brand'), { value: 1, enumerable: true }) })],
    ['a program array with a SPARSE HOLE', withState({ program: (() => { const p = prog(); delete p[2]; return p; })() })],
    ['a program array whose length runs past its elements', withState({ program: (() => { const p = prog(); p.length = p.length + 1; return p; })() })],
    ['a program array carrying a non-index own key', withState({ program: Object.defineProperty(prog(), '0x1', { value: 1, enumerable: true }) })],
    // Forward-only ordering ACROSS pair blocks, not merely within one.
    ['a program applying versions out of order', withState({ program: reorderedPairs() })],
    ['a program applying one version twice', withState({ program: duplicatedPair() })],
  ];

  for (const [label, s] of bad) {
    const r = stepMigrationExecution(s as ExecutionState, { type: 'reserved' });
    assert.deepEqual(r.effects, [], `${label}: emits zero effects`);
    assert.equal(r.state.outcome, 'failed', label);
    assert.equal(r.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, `${label}: one stable bounded code`);
    assert.equal(r.state.disposition, 'cancel_and_dispose', `${label}: unknown ownership demands cancel-and-dispose`);
    assert.equal(r.state.ownershipUncertain, true, label);
    const dumped = JSON.stringify(r.state);
    assert.ok(!/DROP TABLE|999|authorized/.test(dumped), `${label}: nothing caller-authored crosses`);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.state), `${label}: the verdict is frozen`);
  }

  // The control: the SAME builder without a defect canonicalizes and advances, so every rejection
  // above is attributable to its specific defect rather than to the harness.
  assert.equal(stepMigrationExecution(withState({}), { type: 'reserved' }).effects.length, 1, 'the undamaged control advances');

  // ORDERING, stated precisely and honestly: a caller may resume a VALID program at any position its
  // own trajectory can reach — that is inert simulation and grants nothing. What it cannot do is
  // simulate a program that omits or reorders a required step, because such a program never parses.
  const resumed = withState({ cursor: 2, sessionLive: true, expectedToken: 'p' });
  assert.equal(stepMigrationExecution(resumed, { type: 'lock', acquired: true }).effects.length, 1, 'a consistent mid-run position resumes');
  assert.equal(stepMigrationExecution(resumed, { type: 'lock', acquired: 'yes' } as unknown as ExecutionEvent).state.code, ENGINE_CODES.RUN_LOCK_UNAVAILABLE, 'a truthy non-boolean is still not an acquired lock');
});

test('S1.7D: every declared numeric bound is enforced AT its boundary, with a control that passes just under it', () => {
  // Each bound below is declared in the engine but was previously never driven to its edge, so an
  // off-by-one — or the check being dropped outright — would have been invisible to the suite.
  const bigPlan = (n: number): ApplyPlan => {
    const one = twoPlan().pending[0];
    const pending: MigrationPair[] = new Array(n) as MigrationPair[];
    for (let i = 0; i < n; i += 1) pending[i] = one;
    return { ...twoPlan(), pending } as ApplyPlan;
  };
  // MAX_PENDING_PAIRS = 512, checked BEFORE any per-pair hashing. 513 identical entries suffice:
  // the count guard must fire before the duplicate-version rule the program grammar would apply.
  const over = startMigrationExecution(bigPlan(513), execDeps());
  assert.equal(over.state.outcome, 'refused', '513 pending pairs is refused');
  assert.equal(over.state.code, ENGINE_CODES.INVALID_LEDGER_FIELD, 'refused as a bounded ledger-field violation, not a generic event error');
  assert.deepEqual(over.effects, [], 'a refused plan emits nothing');
  // Control: 512 entries clears the COUNT guard and is then refused by the version-ordering rule —
  // proving the count bound is what rejected 513, and that it is not simply rejecting everything.
  assert.equal(startMigrationExecution(bigPlan(512), execDeps()).state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, '512 clears the count bound and fails later, on duplicate versions');

  // MAX_SQL_LENGTH = 4 MiB, enforced on the PRODUCING side so a legitimately discovered oversized
  // migration is refused honestly rather than surfacing as a malformed-event error from capture.
  const sqlPlan = (len: number): ApplyPlan => {
    const body = `-- ${'x'.repeat(len)}\n`;
    return planApply(pairMigrations(discoverMigrations(fakeFs({ '001_a.up.sql': body, '001_a.down.sql': 'drop table a;\n' }))), []);
  };
  const oversized = startMigrationExecution(sqlPlan(4 * 1024 * 1024), execDeps());
  assert.equal(oversized.state.outcome, 'refused', 'a migration larger than the SQL ceiling refuses');
  assert.equal(oversized.state.code, ENGINE_CODES.INVALID_LEDGER_FIELD, 'refused with the producing-side code, NOT invalid_execution_event');
  assert.equal(startMigrationExecution(sqlPlan(1024), execDeps()).state.outcome, 'in_progress', 'a normal-sized migration still starts');

  // MAX_TOKEN_LENGTH = 256 on the EVENT path (readBackendToken), distinct from the state-path check.
  const started = startMigrationExecution(twoPlan(), execDeps());
  const afterReserve = stepMigrationExecution(started.state, { type: 'reserved' });
  for (const [label, token, code] of [
    ['257 chars', 't'.repeat(257), ENGINE_CODES.INVALID_BACKEND_IDENTITY],
    ['empty', '', ENGINE_CODES.INVALID_BACKEND_IDENTITY],
  ] as const) {
    const r = stepMigrationExecution(afterReserve.state, { type: 'identity', identity: { token } });
    assert.equal(r.state.code, code, `an identity token of ${label} is refused`);
    assert.deepEqual(r.effects, [], `${label}: no effect is emitted`);
  }
  assert.equal(stepMigrationExecution(afterReserve.state, { type: 'identity', identity: { token: 't'.repeat(256) } }).effects.length, 1, 'exactly 256 characters is still a valid token');

  // The effect-layer checksum domain is EXACTLY 64 lowercase hex — stricter than the {1,64} the
  // status layer uses. Valid hex of the wrong length must be refused, which no other test covers.
  // ONE migration, so every checksum-bearing effect shares a single value and rewriting it uniformly
  // stays self-consistent — with two migrations the control would fail for an unrelated reason (the
  // second block's SQL would no longer hash to the substituted checksum).
  const live = startMigrationExecution(planWithVersion('001'), execDeps());
  const good = JSON.parse(JSON.stringify(live.state)) as Record<string, unknown>;
  const withChecksum = (ck: string): ExecutionState => {
    const p = (JSON.parse(JSON.stringify(good.program)) as Record<string, unknown>[]).map((e) => ('checksum' in e ? { ...e, checksum: ck } : e));
    return { ...JSON.parse(JSON.stringify(good)), program: p } as unknown as ExecutionState;
  };
  const realChecksum = String((JSON.parse(JSON.stringify(good.program)) as Record<string, unknown>[]).find((e) => e.kind === 'insert_dirty')!.checksum);
  assert.equal(realChecksum.length, 64, 'the engine emits a full-length checksum');
  for (const [label, ck] of [['63 hex chars', realChecksum.slice(0, 63)], ['65 hex chars', `${realChecksum}a`], ['uppercase hex', realChecksum.toUpperCase()]] as const) {
    const r = stepMigrationExecution(withChecksum(ck), { type: 'reserved' });
    assert.deepEqual(r.effects, [], `${label}: refused`);
    assert.equal(r.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, label);
  }
  assert.equal(stepMigrationExecution(withChecksum(realChecksum), { type: 'reserved' }).effects.length, 1, 'the genuine 64-char checksum is accepted');
});

test('S1.7D: version ordering is NUMERIC across differing digit lengths, not lexicographic', () => {
  // The cross-block ordering rule normalizes leading zeros and compares by significant length first.
  // Every existing ordering test uses same-length 3-digit versions, so a naive `a < b` string
  // comparison would pass them all while ordering '9' after '10'.
  const build = (versions: readonly string[]): ApplyPlan => {
    const files: Record<string, string> = {};
    for (const v of versions) { files[`${v}_m.up.sql`] = `create table t${v}();\n`; files[`${v}_m.down.sql`] = `drop table t${v};\n`; }
    return planApply(pairMigrations(discoverMigrations(fakeFs(files))), []);
  };
  // Discovery's own grammar is fixed-width, so drive the ordering rule through a rebuilt program.
  const ascending = build(['009', '010']);
  const r = startMigrationExecution(ascending, execDeps());
  assert.equal(r.state.outcome, 'in_progress', '009 then 010 is ascending and starts');
  const prog = JSON.parse(JSON.stringify(r.state.program)) as Record<string, unknown>[];
  const HEAD = 4, BLOCK = 7;
  const head = prog.slice(0, HEAD), a = prog.slice(HEAD, HEAD + BLOCK), b = prog.slice(HEAD + BLOCK, HEAD + 2 * BLOCK), tail = prog.slice(HEAD + 2 * BLOCK);
  assert.deepEqual([a[0].version, b[0].version], ['009', '010'], 'blocks are 009 then 010');
  const state = (p: Record<string, unknown>[]): ExecutionState => ({ ...JSON.parse(JSON.stringify(r.state)), program: p } as unknown as ExecutionState);
  assert.equal(stepMigrationExecution(state([...head, ...a, ...b, ...tail]), { type: 'reserved' }).effects.length, 1, 'control: 009 before 010 is accepted');
  const swapped = stepMigrationExecution(state([...head, ...b, ...a, ...tail]), { type: 'reserved' });
  assert.deepEqual(swapped.effects, [], '010 before 009 is refused — NOT compared as raw strings');
  assert.equal(swapped.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT);
});

test('S1.7D kernel: a behaviorally transparent wrapper canonicalizes to the same decision and shares no reference', () => {
  const live = startMigrationExecution(twoPlan(), execDeps());
  const ev: ExecutionEvent = { type: 'reserved' };
  const direct = stepMigrationExecution(live.state, ev);

  // JavaScript offers NO general mechanism that detects every behaviorally transparent Proxy, so
  // the contract is not "detect it" — it is "treat it exactly like the bounded data it exposes".
  const transparent = new Proxy(live.state, {}) as ExecutionState;
  const viaProxy = stepMigrationExecution(transparent, ev);
  assert.deepEqual(shapeOf(viaProxy), shapeOf(direct), 'a transparent wrapper receives the same bounded decision');
  assert.notEqual(viaProxy.state, transparent, 'the wrapper itself never crosses back out');
  assert.notEqual(viaProxy.state.program, live.state.program, 'nor its target program by identity');

  // Capture never performs a property GET, so a hostile `get` trap is never even reached: a wrapper
  // that would leak through a getter is behaviourally identical to the transparent one.
  let getTraps = 0;
  const getTrapped = new Proxy(live.state, { get(): never { getTraps += 1; throw new Error('RAW /abs/secret get'); } }) as unknown as ExecutionState;
  assert.deepEqual(shapeOf(stepMigrationExecution(getTrapped, ev)), shapeOf(direct), 'an unreached get trap changes nothing');
  assert.equal(getTraps, 0, 'not one property get is performed on caller-supplied state');

  // A trap that throws where capture DOES look (descriptor / ownKeys) violates the bounded schema:
  // zero effects, a stable bounded verdict, and no raw trap output.
  for (const [label, handler] of [
    ['getOwnPropertyDescriptor', { getOwnPropertyDescriptor(): never { throw new Error('RAW /abs/secret desc'); } }],
    ['ownKeys', { ownKeys(): never { throw new Error('RAW /abs/secret keys'); } }],
  ] as const) {
    const rh = stepMigrationExecution(new Proxy(live.state, handler) as ExecutionState, ev);
    assert.deepEqual(rh.effects, [], `${label}: a throwing trap emits zero effects`);
    assert.equal(rh.state.outcome, 'failed', label);
    assert.equal(rh.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, label);
    assert.ok(!/RAW|abs\/secret/.test(JSON.stringify(rh.state)), `${label}: no raw trap output escapes`);
  }
});

test('S1.7E kernel: a caller ACCESSOR is never invoked — a getter-backed state field, event slot, or identity token cannot drive a transition', () => {
  // S1.7D took state fields from DESCRIPTORS (an accessor was rejected without being invoked) but
  // EXEMPTED three event slots — `acquired`, `released`, `identity.token` — reading them through a
  // property GET "under a guard". A guard bounds the THROW; it does not stop the CALL. Caller code
  // therefore ran inside the kernel and, worse, CHOSE the transition: a `true`-returning `acquired`
  // getter advanced the machine exactly as a data property would, so structurally identical input
  // decided differently depending on how its value was BACKED. Canonical data is data; an accessor
  // is caller code, and caller code is never executed on this boundary.
  let calls = 0;

  // (a) control — an own accessor on a STATE field was already rejected uninvoked.
  const live = startMigrationExecution(twoPlan(), execDeps());
  const plain = JSON.parse(JSON.stringify(live.state)) as Record<string, unknown>;
  const accessorState = Object.defineProperty({ ...plain }, 'cursor', {
    get(): never { calls += 1; throw new Error('RAW /abs/secret accessor'); }, enumerable: true, configurable: true,
  }) as unknown as ExecutionState;
  const ra = stepMigrationExecution(accessorState, { type: 'reserved' });
  assert.deepEqual(ra.effects, [], 'state accessor: zero effects');
  assert.equal(ra.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, 'state accessor: bounded verdict');

  // (b) an accessor on the `acquired` slot: a true-returning getter must NOT acquire the lock.
  let s = startMigrationExecution(twoPlan(), execDeps());
  s = stepMigrationExecution(s.state, { type: 'reserved' });
  s = stepMigrationExecution(s.state, { type: 'identity', identity: { token: 'pid-1' } });
  const rb = stepMigrationExecution(s.state, { type: 'lock', get acquired(): boolean { calls += 1; return true; } } as unknown as ExecutionEvent);
  assert.deepEqual(rb.effects, [], 'acquired accessor: zero effects — a getter cannot acquire the lock');
  assert.equal(rb.state.outcome, 'failed', 'acquired accessor: fails closed');

  // (c) an accessor on the nested identity TOKEN, reached THROUGH the event — equally caller code.
  const rc = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'capture_identity'
      ? ({ type: 'identity', identity: { get token(): string { calls += 1; return 'pid-1'; } } } as unknown as ExecutionEvent)
      : okEvent()(e));
  assert.notEqual(rc.state.outcome, 'complete', 'identity-token accessor: a getter cannot supply the captured identity');

  // (d) an accessor on the `released` slot: a getter cannot verify the unlock.
  const rd = driveKernel(twoPlan(), execDeps(), (e) =>
    e.kind === 'release_lock'
      ? ({ type: 'unlock', get released(): boolean { calls += 1; return true; } } as unknown as ExecutionEvent)
      : okEvent()(e));
  assert.notEqual(rd.state.outcome, 'complete', 'released accessor: an unverified unlock never closes cleanly');

  assert.equal(calls, 0, 'NOT ONE caller accessor was invoked anywhere on the kernel boundary');
});

// --- S1.7F: the ambient-intrinsic trust boundary ----------------------------
// Module initialization may capture intrinsics before any caller code in this realm runs; an
// attacker who patches an intrinsic BEFORE import already owns the realm and is out of scope. What
// is IN scope, and what these tests pin, is that AFTER initialization no caller-controlled mutation
// of a global or a prototype can influence validation, canonicalization, hashing, transitions,
// effects, verdicts, or returned references.

test('S1.7F-1 kernel: re-pointing globalThis.Array cannot substitute the canonical program container', () => {
  // `new Array(n)` is a LIVE GLOBAL CONSTRUCTOR LOOKUP, and `new F(n)` where F returns an object
  // yields THAT object. Re-pointing `globalThis.Array` after import therefore handed the kernel an
  // attacker-owned, accessor-backed container to write its canonical program into: `state.program`
  // came back as the caller's own object, the grammar certified values it need not later emit,
  // reference isolation was lost, and attacker getters ran INSIDE the kernel. An array LITERAL
  // resolves %Array% and cannot be re-pointed, which is the whole fix.
  const live = startMigrationExecution(twoPlan(), execDeps());
  const state = JSON.parse(JSON.stringify(live.state)) as ExecutionState;

  let getterReads = 0;
  let hijacked: unknown = null;
  const Hijack = function (n: number): unknown {
    const box: Record<string, unknown> = {};
    for (let i = 0; i < n; i += 1) {
      let slot: unknown;
      Object.defineProperty(box, `${i}`, {
        get(): unknown { getterReads += 1; return slot; },
        set(v: unknown) { slot = v; },
        enumerable: true, configurable: true,
      });
    }
    box.length = n;
    hijacked = box;
    return box;
  };

  const RealArray = globalThis.Array;
  let out: ReturnType<typeof stepMigrationExecution>;
  try {
    (globalThis as unknown as { Array: unknown }).Array = Hijack;
    out = stepMigrationExecution(state, { type: 'reserved' });
  } finally {
    (globalThis as unknown as { Array: unknown }).Array = RealArray;
  }

  assert.equal(hijacked, null, 'the kernel never allocated a container through the LIVE global Array');
  assert.equal(getterReads, 0, 'no attacker accessor ran inside the kernel');
  assert.ok(Array.isArray(out.state.program), 'the program is a genuine engine-allocated array');
  assert.equal(out.state.outcome, 'in_progress', 'a canonical state still advances normally');
  assert.equal(out.effects.length, 1, 'exactly one newly allocated effect is emitted');
});

/** Files whose LISTING order differs from their sorted order, so an engine that does not really
 *  order its output cannot accidentally look correct. */
const SCRAMBLED = {
  '002_beta.up.sql': 'create table beta();\n',
  '001_alpha.up.sql': 'create table alpha();\n',
  '002_beta.down.sql': 'drop table beta;\n',
  '001_alpha.down.sql': 'drop table alpha;\n',
};

test('S1.7F-2: re-pointing Array.prototype push/map/filter/sort/every cannot change discovery, pairing, status, apply, or baseline output', () => {
  // Every one of these is an OVERRIDABLE prototype method on an ENGINE-allocated array, and each sat
  // on a path that decides what is discovered, how it is ordered, which versions are pending, and
  // what a baseline records. The engine must reach none of them.
  // ONLY engine calls happen inside the patched window; the fingerprint is built afterwards, because
  // the fingerprint itself uses the very prototype methods under test.
  interface Run { ds: MigrationDescriptor[]; pairs: MigrationPair[]; descPairs: MigrationPair[]; status: { version: string; state: string }[]; plan: ApplyPlan; base: ReturnType<typeof planBaseline> }
  // S1.7G: pairMigrations has its OWN sort, and it was never exercised here. Discovery already hands
  // it ascending descriptors, so a no-op `sort` left the output unchanged and the protection was
  // invisible to this test — a mutation that routed pairMigrations through `Array.prototype.sort`
  // SURVIVED the whole suite. Feeding it DESCENDING input makes its ordering observable: with a
  // hostile prototype the mutated engine returns 002,001 while the engine must return 001,002.
  const ascending = discoverMigrations(fakeFs(SCRAMBLED));
  const descending: MigrationDescriptor[] = [];
  for (let i = 0; i < ascending.length; i += 1) descending[i] = ascending[ascending.length - 1 - i];
  const run = (): Run => {
    const ds = discoverMigrations(fakeFs(SCRAMBLED));
    const pairs = pairMigrations(ds);
    return {
      ds, pairs, descPairs: pairMigrations(descending),
      status: computeStatus(pairs, []), plan: planApply(pairs, []), base: planBaseline(pairs, [], ['001', '002']),
    };
  };
  const fp = (r: Run): string => JSON.stringify({
    d: r.ds.map((x) => `${x.version}.${x.direction}.${x.checksum}`),
    p: r.pairs.map((x) => x.version),
    r: r.descPairs.map((x) => x.version),
    s: r.status.map((x) => `${x.version}:${x.state}`),
    a: r.plan.pending.map((x) => x.version),
    b: r.base.versions.map((v) => `${v.version}=${v.checksum}`),
    q: r.base.plannedAudit.versions,
  });
  const expected = fp(run());
  assert.ok(expected.includes('"r":["001","002"]'), 'control: pairMigrations orders DESCENDING input ascending');

  const proto = Array.prototype as unknown as Record<string, unknown>;
  const real = { push: proto.push, map: proto.map, filter: proto.filter, sort: proto.sort, every: proto.every };
  let hostileRun: Run | null = null;
  let raised = '';
  try {
    proto.push = function (): number { return 0; };                       // silently drops appends
    proto.map = function (): unknown[] { return ['HOSTILE']; };
    proto.filter = function (): unknown[] { return []; };
    proto.sort = function (this: unknown): unknown { return this; };      // never orders
    proto.every = function (): boolean { return true; };
    try { hostileRun = run(); } catch (e) { raised = e instanceof MigrationEngineError ? e.code : `OTHER:${String(e)}`; }
  } finally {
    proto.push = real.push; proto.map = real.map; proto.filter = real.filter;
    proto.sort = real.sort; proto.every = real.every;
  }
  const observed = hostileRun === null ? '' : fp(hostileRun);

  assert.equal(raised, '', 'no path threw while the prototype was hostile');
  assert.equal(observed, expected, 'discovery, pairing, status, apply and baseline are byte-identical under a hostile Array.prototype');
});

test('S1.7F-3: patching Hash.prototype update/digest cannot forge the SQL/checksum binding', () => {
  // `createHash(...).update(...).digest(...)` resolves BOTH methods on Hash.prototype at CALL time.
  // Patching `digest` after import therefore made `canonicalSql` a no-op: any SQL could be paired
  // with any checksum, because the "re-hash and compare" step returned whatever the attacker chose.
  const hashProto = Object.getPrototypeOf(createHash('sha256')) as Record<string, unknown>;
  const realUpdate = hashProto.update;
  const realDigest = hashProto.digest;
  const forged = 'a'.repeat(64);
  const probe = new TextEncoder().encode('probe');
  const honest = sha256Hex(probe);

  // A canonical program rewritten to pair DESTRUCTIVE SQL with a checksum only a patched digest
  // could ever satisfy.
  const live = startMigrationExecution(twoPlan(), execDeps());
  const prog = JSON.parse(JSON.stringify(live.state.program)) as Record<string, unknown>[];
  for (const e of prog) {
    if (e.kind === 'insert_dirty' || e.kind === 'execute' || e.kind === 'finalize') e.checksum = forged;
    if (e.kind === 'execute') e.sql = 'DROP SCHEMA public CASCADE;';
  }
  const forgedState = { ...(JSON.parse(JSON.stringify(live.state)) as object), program: prog } as unknown as ExecutionState;

  let hashedUnderPatch = '';
  let out: ReturnType<typeof stepMigrationExecution> | null = null;
  try {
    hashProto.digest = function (): string { return forged; };
    hashProto.update = function (this: unknown): unknown { return this; };
    hashedUnderPatch = sha256Hex(probe);
    out = stepMigrationExecution(forgedState, { type: 'reserved' });
  } finally {
    hashProto.digest = realDigest;
    hashProto.update = realUpdate;
  }

  assert.notEqual(hashedUnderPatch, forged, 'the exported digest never routes through a patched prototype method');
  assert.equal(hashedUnderPatch, honest, 'the digest is byte-identical patched and unpatched');
  assert.deepEqual(out!.effects, [], 'a forged sql/checksum pairing emits ZERO effects');
  assert.equal(out!.state.outcome, 'failed', 'the forged program fails closed');
  assert.equal(out!.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, 'refused as a non-canonical program');
});

test('S1.7F-5: patching RegExp.prototype exec/test cannot alter any exported validator', () => {
  // `re.test(x)` performs Get(re,'exec') and calls it, so binding `test` binds nothing that matters.
  // Until S1.7F eight exported ledger/label/filename validators still ran on regex — including
  // `assertLedgerTimestamp`, the guard S1b must run before writing a durable ledger row, which
  // returned SQL-shaped text verbatim once `exec` was re-pointed. The module header claimed regex was
  // "NOT used for any canonical domain check"; that claim is now true.
  const hostileTs = "2020-01-01'); DROP TABLE schema_migrations; --";
  const badRelDir = "migrations'; DROP TABLE schema_migrations; --";
  const probes = (): Record<string, string> => ({
    tsBad: codeOf(() => assertLedgerTimestamp(hostileTs)),
    tsGood: codeOf(() => assertLedgerTimestamp('2020-01-01T00:00:00Z')),
    nameBad: codeOf(() => discoverMigrations(fakeFs({ 'not a migration.txt': 'x' }))),
    nameGood: codeOf(() => discoverMigrations(fakeFs(TWO_PAIRS))),
    relBad: codeOf(() => discoverMigrations(fakeFs(TWO_PAIRS, badRelDir))),
    statusBad: codeOf(() => computeStatus([{ version: '1; DROP', up: { checksum: 'zz' } } as unknown as MigrationPair], [])),
    labelBad: codeOf(() => planDirtyResolution({ version: '001', reasonCategory: `x${String.fromCharCode(7)}y`, correctiveRef: '002', at: '2020-01-01' })),
    labelGood: codeOf(() => planDirtyResolution({ version: '001', reasonCategory: 'ok', correctiveRef: '002', at: '2020-01-01' })),
  });
  const expected = probes();

  const rp = RegExp.prototype as unknown as Record<string, unknown>;
  const realExec = rp.exec;
  const realTest = rp.test;
  const observed: Record<string, Record<string, string>> = {};
  try {
    // BOTH directions: a fail-OPEN patch would let `^...$` validators accept anything, and a
    // fail-CLOSED patch would make the negated `[^\x20-\x7e]` validator reject valid input.
    for (const verdict of [true, false]) {
      rp.test = function (): boolean { return verdict; };
      rp.exec = function (): unknown { return verdict ? ['999_x.up.sql', '999', 'x', 'up'] : null; };
      observed[String(verdict)] = probes();
    }
  } finally {
    rp.exec = realExec;
    rp.test = realTest;
  }

  assert.deepEqual(observed.true, expected, 'a fail-open RegExp.prototype changes no exported validation result');
  assert.deepEqual(observed.false, expected, 'a fail-closed RegExp.prototype changes no exported validation result');
  // The stable baseline must also be the SECURE one, not merely stable.
  assert.equal(expected.tsBad, ENGINE_CODES.INVALID_LEDGER_FIELD, 'SQL-shaped text is refused by the exported ledger-timestamp guard');
  assert.equal(expected.tsGood, 'NO_THROW', 'a canonical timestamp is still accepted');
  assert.equal(expected.nameBad, ENGINE_CODES.INVALID_FILENAME, 'a non-conforming basename is refused');
  assert.equal(expected.nameGood, 'NO_THROW', 'valid history still discovers');
  assert.equal(expected.relBad, ENGINE_CODES.INVALID_LEDGER_FIELD, 'a hostile relDir is refused');
  assert.equal(expected.statusBad, ENGINE_CODES.INVALID_LEDGER_FIELD, 'a non-canonical version/checksum is refused');
  assert.equal(expected.labelBad, ENGINE_CODES.INVALID_LEDGER_FIELD, 'a control character in a ledger label is refused');
  assert.equal(expected.labelGood, 'NO_THROW', 'a clean ledger label is still accepted');
});

test('S1.7F-6: patching TextDecoder/TextEncoder prototypes cannot change what discovery decodes or what the kernel canonicalizes', () => {
  // `STRICT_UTF8.decode(bytes)` and `UTF8_ENCODER.encode(sql)` were LIVE prototype dispatches. A
  // patched `decode` put attacker text into `artifact.sql` while the checksum still covered the real
  // bytes; a patched `encode` made the kernel's third integrity check hash the wrong bytes.
  const hostileSql = 'DROP SCHEMA public CASCADE;';
  const bytesOf: Record<string, Uint8Array> = {};
  for (const k of Object.keys(TWO_PAIRS)) bytesOf[k] = new TextEncoder().encode(TWO_PAIRS[k as keyof typeof TWO_PAIRS]);
  const port: MigrationFsPort = {
    relDir: 'server/platform-identity/migrations',
    list: () => Object.keys(TWO_PAIRS),
    entryType: () => 'file',
    readBytes: (b: string) => bytesOf[b],
  };
  const discoveryOf = (): string => discoverMigrations(port).map((d) => `${d.checksum}:${d.artifact.sql}`).join('|');
  const plan = twoPlan();
  const programOf = (): string => JSON.stringify(startMigrationExecution(plan, execDeps()).state.program);

  const expectedDiscovery = discoveryOf();
  const expectedProgram = programOf();

  const tdp = TextDecoder.prototype as unknown as Record<string, unknown>;
  const tep = TextEncoder.prototype as unknown as Record<string, unknown>;
  const realDecode = tdp.decode;
  const realEncode = tep.encode;
  let observedDiscovery = '';
  let observedProgram = '';
  let raised = '';
  try {
    tdp.decode = function (): string { return hostileSql; };
    tep.encode = function (): Uint8Array { return new Uint8Array([0]); };
    try {
      observedDiscovery = discoveryOf();
      observedProgram = programOf();
    } catch (e) { raised = e instanceof MigrationEngineError ? e.code : `OTHER:${String(e)}`; }
  } finally {
    tdp.decode = realDecode;
    tep.encode = realEncode;
  }

  assert.equal(raised, '', 'no path threw while the codec prototypes were hostile');
  assert.equal(observedDiscovery, expectedDiscovery, 'the decoded SQL and its checksum are unchanged');
  assert.ok(!observedDiscovery.includes(hostileSql), 'no attacker-supplied SQL entered a discovered artifact');
  assert.equal(observedProgram, expectedProgram, 'the canonical program is unchanged');
});

test('S1.7F-7: a hostile filesystem port cannot leak raw text or drive discovery through caller code', () => {
  // Assembled from RUNTIME FRAGMENTS so no contiguous connection string exists in these bytes: the
  // value must be secret-SHAPED to the engine at runtime without being a secret-shaped literal a
  // repository scanner would flag. (Same technique as the pre-existing FAKE_URL fixture above.)
  const SECRET = `${['postgres', '//u:p@db'].join(':')}${['.internal', 'prod'].join('/')}`;
  const bounded = (fn: () => unknown): string => {
    try { fn(); return 'NO_THROW'; } catch (e) {
      if (!(e instanceof MigrationEngineError)) return `RAW:${String(e)}`;
      return e.message.indexOf(SECRET) >= 0 ? 'LEAKED' : e.code;
    }
  };
  const port = (over: Partial<MigrationFsPort>): MigrationFsPort => ({
    relDir: 'server/platform-identity/migrations',
    list: () => ['001_a.up.sql'],
    entryType: () => 'file',
    readBytes: () => new TextEncoder().encode('select 1;\n'),
    ...over,
  });

  // (a) a NON-STRING basename is never coerced through the caller's own toString.
  let coerced = 0;
  const evil = { toString(): string { coerced += 1; throw new Error(SECRET); } };
  assert.equal(bounded(() => discoverMigrations(port({ list: () => [evil] as unknown as string[] }))), ENGINE_CODES.PATH_TRAVERSAL);
  assert.equal(coerced, 0, 'the caller toString is never invoked');

  // (b) a throwing ITERATOR on the returned list never escapes.
  const listB = ['001_a.up.sql'];
  Object.defineProperty(listB, Symbol.iterator, { value: () => { throw new Error(SECRET); }, configurable: true });
  const b = bounded(() => discoverMigrations(port({ list: () => listB })));
  assert.ok(b !== 'LEAKED' && b.slice(0, 4) !== 'RAW:', `a hostile list iterator yields a bounded code (got ${b})`);

  // (c) an ACCESSOR-backed listing entry is REJECTED WITHOUT BEING INVOKED. Capturing the listing by
  //     index performs a property GET, which runs caller code inside the engine and lets its throw
  //     escape raw; the entry must be taken from its DESCRIPTOR instead.
  let reads = 0;
  const listC: string[] = [];
  // Defining index '0' bumps the array's own `length` to 1 automatically (`length` is not
  // configurable on a real array, so it must not be redefined).
  Object.defineProperty(listC, '0', { get(): string { reads += 1; throw new Error(SECRET); }, enumerable: true, configurable: true });
  const c = bounded(() => discoverMigrations(port({ list: () => listC })));
  assert.equal(reads, 0, 'an accessor-backed listing entry is NEVER invoked');
  assert.ok(c !== 'LEAKED' && c.slice(0, 4) !== 'RAW:', `an accessor-backed entry yields a bounded code (got ${c})`);

  // (d) an own METHOD override on the returned list grants nothing.
  const listD = ['001_a.up.sql'];
  (listD as unknown as Record<string, unknown>).map = (): unknown[] => ['999_evil.up.sql'];
  const d = bounded(() => discoverMigrations(port({ list: () => listD })));
  assert.ok(d !== 'LEAKED' && d.slice(0, 4) !== 'RAW:', `an overridden own method yields a bounded code (got ${d})`);

  // (e) a throwing entryType / readBytes stays bounded.
  assert.equal(bounded(() => discoverMigrations(port({ entryType: () => { throw new Error(SECRET); } }))), ENGINE_CODES.PORT_OPERATION_FAILED);
  assert.equal(bounded(() => discoverMigrations(port({ readBytes: () => { throw new Error(SECRET); } }))), ENGINE_CODES.PORT_OPERATION_FAILED);

  // (f) an UNBOUNDED declared listing length is refused BY THE BOUND, before any per-entry work.
  //     A GENUINE array, so the refusal cannot come from the array-shape check instead.
  const hugeList: string[] = [];
  hugeList.length = 5_000_000;
  assert.equal(
    bounded(() => discoverMigrations(port({ list: () => hugeList }))),
    ENGINE_CODES.INVALID_LEDGER_FIELD,
    'an oversized listing is refused by the length bound itself, not incidentally by its first entry',
  );

  // (g) a non-array listing is refused.
  assert.ok(bounded(() => discoverMigrations(port({ list: () => ({ length: 1, 0: '001_a.up.sql' }) as unknown as string[] }))) !== 'NO_THROW');
});

test('S1.7F-8: the exported status path enforces a MAXIMUM bound, not merely a safe-integer length', () => {
  // `boundedLength` rejected a negative or non-safe-integer length but had no ceiling, so a caller
  // could declare a 5,000,000-row ledger or pair list and make the engine walk it.
  const huge = { length: 5_000_000 } as unknown as LedgerRow[];
  assert.equal(codeOf(() => computeStatus([], huge)), ENGINE_CODES.INVALID_LEDGER_FIELD, 'an oversized ledger is refused');
  assert.equal(codeOf(() => computeStatus(huge as unknown as MigrationPair[], [])), ENGINE_CODES.INVALID_LEDGER_FIELD, 'an oversized pair list is refused');
  assert.equal(codeOf(() => planApply([], huge)), ENGINE_CODES.INVALID_LEDGER_FIELD, 'planApply refuses an oversized ledger');
  // A realistic history is unaffected.
  assert.equal(computeStatus(PAIRS(), []).length, 2, 'a normal history still classifies');
});

test('S1.7F-9 kernel: an uninterpretable reservation response leaves ownership UNCERTAIN, never "nothing to do"', () => {
  // At cursor 0 the kernel has emitted `reserve` and knows NOTHING about what the executor holds.
  // Reporting `disposition: 'none'` there claimed "nothing outstanding and nothing held" on exactly
  // the path where the executor may hold a live reserved backend it merely reported in a
  // non-canonical shape. The kernel already applies the opposite, correct reasoning to an
  // uncapturable STATE; it must apply it to an uncapturable reservation RESPONSE too.
  const start = startMigrationExecution(twoPlan(), execDeps());
  for (const [label, ev] of [
    ['a wrong-type event', { type: 'identity', identity: { token: 'x' } }],
    ['an unknown event', { type: 'ok' }],
    ['an empty event', {}],
    ['a lock event', { type: 'lock', acquired: true }],
  ] as const) {
    const r = stepMigrationExecution(start.state, ev as unknown as ExecutionEvent);
    assert.deepEqual(r.effects, [], `${label}: zero effects`);
    assert.equal(r.state.outcome, 'failed', `${label}: fails closed`);
    assert.equal(r.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, label);
    assert.equal(r.state.ownershipUncertain, true, `${label}: the kernel cannot know whether a backend was reserved`);
    assert.equal(r.state.disposition, 'cancel_and_dispose', `${label}: cancel the attempt and dispose of any late settlement`);
  }
  // S1.7G REWRITE. This block previously asserted that a SETTLED reservation failure differs by
  // reporting 'none'. It does not: settling proves only that the CALL ended, never that it
  // allocated nothing, and the adapter contract enforces no atomicity. It differs by CODE.
  const settled = stepMigrationExecution(start.state, { type: 'port_failed' });
  assert.equal(settled.state.code, ENGINE_CODES.PORT_OPERATION_FAILED, 'a settled failure keeps its own bounded code');
  assert.equal(settled.state.disposition, 'cancel_and_dispose', 'a rejecting reserve may still have allocated a backend');
  assert.equal(settled.state.ownershipUncertain, true);
  assert.deepEqual(settled.effects, [], 'zero effects');
  // A reservation TIMEOUT stays uncertain (contract unchanged).
  const timedOut = stepMigrationExecution(start.state, { type: 'timeout' });
  assert.equal(timedOut.state.disposition, 'cancel_and_dispose');
  assert.equal(timedOut.state.ownershipUncertain, true);
  // Once a session is CONFIRMED live, an uninterpretable event destroys it instead of cancelling.
  const s = stepMigrationExecution(start.state, { type: 'reserved' });
  const mid = stepMigrationExecution(s.state, { type: 'ok' });
  assert.equal(mid.state.disposition, 'terminate', 'a confirmed live session is destroyed, not merely cancelled');
  assert.equal(mid.state.ownershipUncertain, false);
});

test('S1.7F-10 kernel: the failure disposition at EVERY choreography stage, and close never follows uncertainty', () => {
  // The stage-by-stage disposition table, asserted rather than asserted-about: at each cursor of a
  // full two-migration run, feed an uninterpretable event and pin the verdict.
  const plan = twoPlan();
  let cur = startMigrationExecution(plan, execDeps());
  const rows: string[] = [];
  let guard = 0;
  while (cur.state.outcome === 'in_progress' && guard < 200) {
    guard += 1;
    const kind = cur.effects[0].kind;
    const bad = stepMigrationExecution(cur.state, { type: 'nonsense' } as unknown as ExecutionEvent);
    rows.push(`${kind}:${bad.state.outcome}/${bad.state.disposition}/${bad.state.ownershipUncertain}`);
    assert.notEqual(bad.state.outcome, 'complete', `${kind}: an uninterpretable event never completes`);
    assert.deepEqual(bad.effects, [], `${kind}: zero effects`);
    assert.equal(
      bad.state.ownershipUncertain,
      bad.state.disposition === 'cancel_and_dispose',
      `${kind}: ownershipUncertain holds exactly when the disposition is cancel_and_dispose`,
    );
    cur = stepMigrationExecution(cur.state, okEvent()(cur.effects[0]));
  }
  assert.equal(cur.state.outcome, 'complete', 'the happy path still completes');
  assert.ok(rows.length >= 15, `every stage of a two-migration choreography was probed (got ${rows.length})`);
  // `reserve` is the ONLY stage where ownership cannot be confirmed; every later stage holds a
  // CONFIRMED live session and therefore orders destruction.
  assert.equal(rows[0], 'reserve:failed/cancel_and_dispose/true');
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].endsWith(':failed/terminate/false'), `stage ${i} (${rows[i]}) destroys a confirmed session`);
  }
});

/** A one-migration plan whose DECLARED transaction mode is caller-chosen but whose artifact is fully
 *  self-consistent, so the only property under test is mode-to-choreography binding. */
const planWithMode = (transactionMode: 'required' | 'forbidden', sql = 'create table alpha();\n'): ApplyPlan => {
  const bytes = new TextEncoder().encode(sql);
  const checksum = sha256Hex(bytes);
  const artifact = { version: '001', direction: 'up', checksum, sql, bytes } as unknown as MigrationArtifact;
  const up = { version: '001', direction: 'up', checksum, transactionMode, artifact } as unknown as MigrationDescriptor;
  return { pending: [{ version: '001', up } as unknown as MigrationPair] } as unknown as ApplyPlan;
};

test('S1.7F-11 kernel: the DECLARED transaction mode is bound into canonical execution data', () => {
  // `txRequired` was INFERRED from the program itself (`peek() === 'open_tx'`) and only checked for
  // self-consistency, never against the migration's declared `transactionMode` — which never entered
  // ExecutionState at all. A migration declared `required` could therefore be represented with the
  // unbracketed forbidden choreography and run its DDL and ledger finalize with no atomicity, and
  // the kernel structurally could not notice. The declared mode is now canonical data, bound beside
  // the version and checksum in the same frozen effect.
  const req = startMigrationExecution(planWithMode('required'), execDeps());
  const forb = startMigrationExecution(planWithMode('forbidden'), execDeps());
  assert.equal(req.state.outcome, 'in_progress', 'a required-mode plan builds');
  assert.equal(forb.state.outcome, 'in_progress', 'a forbidden-mode plan builds');
  assert.equal(req.state.program.length, 15, 'the required choreography is 15 effects');
  assert.equal(forb.state.program.length, 14, 'the forbidden choreography is 14 effects');

  const clone = (v: unknown): Record<string, unknown>[] => JSON.parse(JSON.stringify(v)) as Record<string, unknown>[];
  const dirtyOf = (r: ReturnType<typeof startMigrationExecution>): Record<string, unknown> =>
    clone(r.state.program).find((e) => e.kind === 'insert_dirty')!;

  // (1) the DECLARED mode is carried in the canonical program.
  assert.equal(dirtyOf(req).txMode, 'required', 'a required migration declares its mode in canonical data');
  assert.equal(dirtyOf(forb).txMode, 'forbidden', 'a forbidden migration declares its mode in canonical data');

  const withProgram = (r: ReturnType<typeof startMigrationExecution>, program: unknown[]): ExecutionState => {
    const base = JSON.parse(JSON.stringify(r.state)) as Record<string, unknown>;
    base.program = program;
    return base as unknown as ExecutionState;
  };
  const V = (): Record<string, unknown> => ({ kind: 'verify_identity' });
  const zeroEffects = (label: string, s: ExecutionState): void => {
    const out = stepMigrationExecution(s, { type: 'reserved' });
    assert.deepEqual(out.effects, [], `${label}: ZERO effects`);
    assert.equal(out.state.outcome, 'failed', `${label}: fails closed`);
    assert.equal(out.state.code, ENGINE_CODES.INVALID_EXECUTION_EVENT, `${label}: bounded refusal`);
  };

  // (2) DOWNGRADE — a migration DECLARED `required`, rewritten into the unbracketed choreography.
  const rp = clone(req.state.program);
  const rExec = rp.find((e) => e.kind === 'execute')!;
  const rFin = rp.find((e) => e.kind === 'finalize')!;
  zeroEffects('required declared, forbidden choreography', withProgram(req, [
    ...rp.slice(0, 5),
    V(), { ...rExec, txScoped: false }, V(), { ...rFin, txScoped: false }, V(),
    ...rp.slice(11),
  ]));

  // (3) UPGRADE — a migration DECLARED `forbidden`, rewritten into the transaction-bracketed one.
  const fp = clone(forb.state.program);
  const fExec = fp.find((e) => e.kind === 'execute')!;
  const fFin = fp.find((e) => e.kind === 'finalize')!;
  zeroEffects('forbidden declared, required choreography', withProgram(forb, [
    ...fp.slice(0, 5),
    { kind: 'open_tx' }, V(), { ...fExec, txScoped: true }, { ...fFin, txScoped: true }, { kind: 'commit_tx' }, V(),
    ...fp.slice(10),
  ]));

  // (4) the declared mode is REQUIRED — an insert_dirty without it is not a canonical effect.
  const stripped = clone(req.state.program);
  delete (stripped.find((e) => e.kind === 'insert_dirty')!).txMode;
  zeroEffects('insert_dirty with no declared mode', withProgram(req, stripped));

  // (5) an out-of-domain declared mode is refused.
  const bogus = clone(req.state.program);
  (bogus.find((e) => e.kind === 'insert_dirty')!).txMode = 'maybe';
  zeroEffects('insert_dirty with an out-of-domain mode', withProgram(req, bogus));

  // (6) a SELF-CONSISTENT program of either mode still simulates — simulation grants no authority.
  assert.equal(driveKernel(planWithMode('required'), execDeps()).state.outcome, 'complete');
  assert.equal(driveKernel(planWithMode('forbidden'), execDeps()).state.outcome, 'complete');
});

test('S1.7F-12 kernel: every terminal verdict is fully reconstructed, deeply frozen, and shares no caller reference', () => {
  const plan = twoPlan();
  const live = startMigrationExecution(plan, execDeps());
  const callerState = JSON.parse(JSON.stringify(live.state)) as ExecutionState;
  const states: ExecutionState[] = [
    stepMigrationExecution(callerState, { type: 'nonsense', payload: { evil: true } } as unknown as ExecutionEvent).state,
    stepMigrationExecution(callerState, { type: 'timeout' }).state,
    stepMigrationExecution(callerState, { type: 'port_failed' }).state,
    stepMigrationExecution({} as unknown as ExecutionState, { type: 'ok' }).state,
    driveKernel(plan, execDeps()).state,
  ];
  for (const s of states) {
    assert.ok(Object.isFrozen(s), 'the verdict object is frozen');
    assert.ok(Object.isFrozen(s.program), 'its program is frozen');
    assert.deepEqual(s.program, [], 'a terminal verdict carries an empty program');
    assert.equal(s.cursor, 0, 'cursor 0');
    assert.equal(s.expectedToken, null, 'no captured token survives a verdict');
    assert.equal(s.sessionLive, false, 'no verdict reports a live session');
    assert.equal(s.ownershipUncertain, s.disposition === 'cancel_and_dispose', 'ownershipUncertain holds exactly when the disposition is cancel_and_dispose');
    assert.equal(s.outcome === 'complete', s.code === null && s.disposition === 'none', 'complete <=> no code AND nothing to dispose');
    assert.notEqual(s.program as unknown, callerState.program as unknown, 'no caller-owned reference is returned');
  }
});

test('S1.7F-13: runMigrations refuses BEFORE inspecting any argument', async () => {
  // The unconditional fail-closed shim must refuse before it reads a property, enumerates a key,
  // requests a descriptor, evaluates a getter, triggers a Proxy trap, or reaches any port.
  let touched = 0;
  const trap: ProxyHandler<object> = {
    get(): undefined { touched += 1; return undefined; },
    has(): boolean { touched += 1; return false; },
    ownKeys(): string[] { touched += 1; return []; },
    getOwnPropertyDescriptor(): undefined { touched += 1; return undefined; },
  };
  const hostile = new Proxy({}, trap);
  await assert.rejects(
    runMigrations(hostile as unknown as ApplyPlan, hostile as unknown as RunDeps),
    (e: unknown) => e instanceof MigrationEngineError && e.code === ENGINE_CODES.MIGRATION_EXECUTION_UNAVAILABLE,
  );
  assert.equal(touched, 0, 'no property, key, or descriptor of either argument was read');
});

test('S1.7F-14: re-pointing Object.freeze / Object.defineProperty cannot un-freeze a discovered artifact or expose its SQL', () => {
  // Three CALL-TIME sites still reached the LIVE `Object.freeze` / `Object.defineProperty` instead of
  // the bound intrinsics. Re-pointing them left `descriptor.artifact` unfrozen AND enumerable, which
  // breaks two documented guarantees at once: the artifact is immutable, and `JSON.stringify` of a
  // descriptor / pair / plan is structurally SQL-FREE.
  const plan = twoPlan();
  const op = Object as unknown as Record<string, unknown>;
  const realFreeze = op.freeze;
  const realDefine = op.defineProperty;
  let ds: MigrationDescriptor[] | null = null;
  let program = '';
  let raised = '';
  try {
    op.freeze = (o: unknown): unknown => o;                 // identity — nothing gets frozen
    op.defineProperty = (o: unknown): unknown => o;         // no-op  — nothing becomes non-enumerable
    try {
      ds = discoverMigrations(fakeFs(TWO_PAIRS));
      program = JSON.stringify(startMigrationExecution(plan, execDeps()).state.program);
    } catch (e) { raised = e instanceof MigrationEngineError ? e.code : `OTHER:${String(e)}`; }
  } finally {
    op.freeze = realFreeze;
    op.defineProperty = realDefine;
  }

  assert.equal(raised, '', 'no path threw while Object.freeze/defineProperty were hostile');
  assert.ok(Object.isFrozen(ds![0].artifact), 'the discovered artifact is frozen even when Object.freeze is re-pointed');
  assert.ok(!JSON.stringify(ds![0]).includes('create table'), 'the SQL-bearing artifact stays NON-ENUMERABLE — a serialized descriptor carries no SQL');
  assert.ok(!JSON.stringify(ds).includes('create table'), 'a serialized descriptor LIST carries no SQL');
  assert.ok(program.length > 0 && !program.includes('"bytes"'), 'the canonical program still carries only verified primitives');
});

test('S1.7F-15: ONE version ordering — planApply and pairMigrations agree with the kernel comparator', () => {
  // The kernel orders canonical versions NUMERICALLY (significant-length, then lexicographic within a
  // length), and the exported boundary admits 1..64 digits. But planApply's forward-only guard and
  // pairMigrations' sort compared version strings with `<`/`>`, i.e. LEXICOGRAPHICALLY. The two
  // orderings coincide only for the fixed 3-digit versions the filename grammar produces, so at the
  // exported boundary the module disagreed with itself: a retroactive backfill was ACCEPTED under an
  // applied head, and a legitimate forward migration was REFUSED.
  const mkPair = (version: string, sql: string): MigrationPair => {
    const bytes = new TextEncoder().encode(sql);
    const checksum = sha256Hex(bytes);
    const artifact = { version, direction: 'up', checksum, sql, bytes } as unknown as MigrationArtifact;
    const up = { version, name: 'x', direction: 'up', checksum, transactionMode: 'required', artifact } as unknown as MigrationDescriptor;
    const down = { version, name: 'x', direction: 'down', checksum, transactionMode: 'required', artifact } as unknown as MigrationDescriptor;
    return { version, name: 'x', up, down, transactionMode: 'required' } as unknown as MigrationPair;
  };
  const applied = (p: MigrationPair): LedgerRow => ({ version: p.version, checksum: p.up.checksum, dirty: false });
  const p2 = mkPair('2', 'a2();');
  const p9 = mkPair('9', 'p9();');
  const p10 = mkPair('10', 'a10();');

  // (1) a retroactive backfill BELOW the applied head is refused — numerically, not lexicographically.
  assert.equal(
    codeOf(() => planApply([p10, p9], [applied(p10)])),
    ENGINE_CODES.INVALID_HISTORY,
    'version 9 under an applied head of 10 is a retroactive backfill',
  );
  // (2) a legitimate forward migration ABOVE the applied head is accepted, not falsely refused.
  assert.deepEqual(
    planApply([p2, p10], [applied(p2)]).pending.map((p) => p.version),
    ['10'],
    'version 10 above an applied head of 2 is a forward migration',
  );
  // (3) pairing orders numerically.
  assert.deepEqual(pairMigrations([p9.up, p9.down, p10.up, p10.down]).map((p) => p.version), ['9', '10']);
  // (4) the zero-padded versions the filename grammar produces are unaffected.
  assert.deepEqual(planApply(PAIRS(), []).pending.map((p) => p.version), ['001', '002']);
});

test('S1.7F-16: Object.prototype pollution cannot supply a credential, flip a transaction mode, or forge a pair', () => {
  // The kernel half reads caller data through descriptors and null-prototype records; the pre-kernel
  // half read it with plain `obj.prop` / `obj[key]`, so an INHERITED property was indistinguishable
  // from a declared one. `Object.prototype` is a prototype like any other, and the module's trust
  // boundary says no caller-controlled prototype mutation may influence a decision.
  const OP = Object.prototype as unknown as Record<string, unknown>;
  const PAIR = { '001_alpha.up.sql': 'create table alpha();\n', '001_alpha.down.sql': 'drop table alpha;\n' };
  const results: Record<string, string> = {};
  try {
    OP.migratorRef = 'm'; OP.runtimeRef = 'r'; OP['001'] = 'forbidden';
    OP.down = { name: 'alpha', transactionMode: 'required' }; OP.status = 'resolved_superseded';
    results.cred = codeOf(() => assertMigratorCredential({ purpose: 'migration' } as CredentialClassification));
    results.mode = discoverMigrations(fakeFs(PAIR))[0].transactionMode;
    results.pair = codeOf(() => pairMigrations(discoverMigrations(fakeFs({ '001_alpha.up.sql': PAIR['001_alpha.up.sql'] }))));
    results.status = planDirtyResolution({ version: '001', reasonCategory: 'r', correctiveRef: '002', at: '2020-01-01' }).status;
  } finally {
    delete OP.migratorRef; delete OP.runtimeRef; delete OP['001']; delete OP.down; delete OP.status;
  }
  assert.equal(results.cred, ENGINE_CODES.INVALID_CREDENTIAL_REF, 'an inherited migratorRef/runtimeRef never self-asserts a migration credential');
  assert.equal(results.mode, 'required', 'an inherited version key never overrides a declared transaction mode');
  assert.equal(results.pair, ENGINE_CODES.MISSING_PAIR, 'an inherited `down` never completes a missing up/down pair');
  assert.equal(results.status, 'resolved_failed', 'an inherited `status` never rewrites a durable resolution record');
});

test('S1.7F-17: no raw caller exception escapes discovery or pairing', () => {
  const LEAK = `${['postgres', '//u:pw@h'].join(':')}/db`;
  const bounded = (fn: () => unknown): string => {
    try { fn(); return 'NO_THROW'; } catch (e) {
      if (!(e instanceof MigrationEngineError)) return 'RAW';
      return e.message.indexOf(LEAK) >= 0 ? 'LEAKED' : e.code;
    }
  };
  const PAIR = { '001_alpha.up.sql': 'create table alpha();\n', '001_alpha.down.sql': 'drop table alpha;\n' };
  const base = fakeFs(PAIR);
  const ds = discoverMigrations(base);
  const up = ds.find((d) => d.direction === 'up')!;
  const down = ds.find((d) => d.direction === 'down')!;

  // (a) a throwing field getter on a caller-supplied DESCRIPTOR must not escape pairMigrations.
  const boom = Object.defineProperty({ ...down } as Record<string, unknown>, 'name', {
    get(): string { throw new Error(LEAK); }, enumerable: true, configurable: true,
  }) as unknown as MigrationDescriptor;
  assert.ok(!['RAW', 'LEAKED'].includes(bounded(() => pairMigrations([up, boom]))), 'a throwing descriptor getter is bounded');

  // (b) a hostile `readBytes` return whose `length` throws must not escape discovery. The port CALL
  //     was guarded but the Uint8Array construction over its result was not.
  assert.equal(bounded(() => discoverMigrations({
    ...base, readBytes: () => ({ get length(): number { throw new Error(LEAK); } }) as unknown as Uint8Array,
  })), ENGINE_CODES.PORT_OPERATION_FAILED, 'a hostile readBytes result is bounded');

  // (c) a throwing getter on the caller's OPTIONS object must not escape discovery.
  assert.ok(!['RAW', 'LEAKED'].includes(bounded(() => discoverMigrations(base, Object.defineProperty({}, 'transactionModeByVersion', {
    get(): never { throw new Error(LEAK); }, enumerable: true, configurable: true,
  }) as DiscoverOptions))), 'a throwing options getter is bounded');
});

test('S1.7F-18: patching fs.Stats.prototype cannot make a NONREGULAR entry pass the regular-file gate', () => {
  // `createNodeFsPort`'s entryType classified via st.isSymbolicLink()/isDirectory()/isFile() — live
  // prototype dispatch on `fs.Stats`, whose methods are writable and configurable. Patching them made
  // a directory (or a FIFO/socket/device) report as a regular 'file', defeating the module's own
  // documented "only REGULAR files are accepted" control. O_NOFOLLOW still stops a symlink at open,
  // but a FIFO opened under O_NONBLOCK is not covered by that residual barrier.
  // A SELF-CONTAINED fixture in the OS temp dir: no hard-coded absolute path and no dependency on
  // repository layout, so the suite behaves identically wherever it is run from (including a
  // disposable mutation replica).
  const root = mkdtempSync(join(tmpdir(), 'mig-entrytype-'));
  mkdirSync(join(root, 'sub'));
  const port = createNodeFsPort(root, 'x');
  const clean = port.entryType('sub');
  const sp = (Stats as unknown as { prototype: Record<string, unknown> }).prototype;
  const real = { f: sp.isFile, d: sp.isDirectory, s: sp.isSymbolicLink };
  let patched = '';
  try {
    sp.isSymbolicLink = (): boolean => false;
    sp.isDirectory = (): boolean => false;
    sp.isFile = (): boolean => true;
    patched = port.entryType('sub');
  } finally {
    sp.isFile = real.f; sp.isDirectory = real.d; sp.isSymbolicLink = real.s;
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(clean, 'directory', 'baseline: a directory classifies as a directory');
  assert.equal(patched, 'directory', 'a patched fs.Stats.prototype cannot reclassify a directory as a regular file');
});

test('S1.7F-4: every exported digest is exactly 64 lowercase hexadecimal characters, checked without regex', () => {
  // Bounded, non-regex shape validation of the final digest (contract C). `RegExp.prototype.exec`
  // is itself patchable, so the check that guards the hash may not depend on it.
  for (const s of ['', 'a', 'create table alpha();\n', `\u00ff\u0000binary`, 'x'.repeat(100_000)]) {
    const d = sha256Hex(new TextEncoder().encode(s));
    assert.equal(d.length, 64, 'exactly 64 characters');
    for (let i = 0; i < d.length; i += 1) {
      const c = d.charCodeAt(i);
      assert.ok((c >= 48 && c <= 57) || (c >= 97 && c <= 102), `character ${i} is a lowercase hex digit`);
    }
  }
});

// --- S1.7G: reservation uncertainty + deeply immutable public results -------
//
// A: `ReservedSessionAdapter.reserve(mode): Promise<ReservedSession>` states NOTHING about
// atomicity. A reserve call may therefore create a physical backend and THEN reject, throw, time
// out, or answer in a shape the kernel cannot interpret. Absent an ENFORCED no-allocation-on-failure
// contract, the kernel must assume ownership is UNCERTAIN — it prescribes disposition only, and
// never claims the cancellation or disposal physically happened.
//
// B: every public result is a NEWLY ALLOCATED, DEEPLY FROZEN, canonical data graph that shares no
// object with the caller's input. Containment through later revalidation is not immutability.

/** A caller-OWNED, fully mutable descriptor set with caller-owned artifacts. Nothing here is
 *  engine-allocated, so any of these objects appearing in a returned graph is a leak. */
const mutableDescriptors = (): MigrationDescriptor[] =>
  discoverMigrations(fakeFs(TWO_PAIRS)).map((d) => ({
    version: d.version,
    name: d.name,
    direction: d.direction,
    checksum: d.checksum,
    relPath: d.relPath,
    transactionMode: d.transactionMode,
    artifact: {
      version: d.artifact.version,
      direction: d.artifact.direction,
      checksum: d.artifact.checksum,
      sql: d.artifact.sql,
      bytes: d.artifact.bytes,
    } as MigrationArtifact,
  }));

/** Caller-OWNED pairs built from caller-owned descriptors. */
const mutablePairs = (): MigrationPair[] => {
  const ds = mutableDescriptors();
  const out: MigrationPair[] = [];
  for (let i = 0; i < ds.length; i += 2) {
    out.push({ version: ds[i].version, name: ds[i].name, up: ds[i], down: ds[i + 1], transactionMode: ds[i].transactionMode });
  }
  return out;
};

/** Every object/array reachable from `root` through own DATA properties. An accessor is never
 *  invoked while auditing — walking a result must not itself run engine or caller code. */
function reachableNodes(root: unknown, depthCap = 12): Set<object> {
  const out = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== 'object' || out.has(v as object) || depth > depthCap) return;
    out.add(v as object);
    if (ArrayBuffer.isView(v)) return;
    for (const k of Object.getOwnPropertyNames(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || d.get !== undefined || d.set !== undefined) continue;
      walk(d.value, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Paths of every reachable object/array that is NOT frozen. */
function unfrozenPaths(root: unknown, label: string, depthCap = 12): string[] {
  const bad: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string, depth: number): void => {
    if (v === null || typeof v !== 'object' || seen.has(v as object) || depth > depthCap) return;
    seen.add(v as object);
    if (!Object.isFrozen(v)) bad.push(path);
    if (ArrayBuffer.isView(v)) return;
    for (const k of Object.getOwnPropertyNames(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || d.get !== undefined || d.set !== undefined) continue;
      walk(d.value, `${path}.${k}`, depth + 1);
    }
  };
  walk(root, label, 0);
  return bad;
}

test('S1.7G-1 kernel: a reserve-stage port_failed leaves ownership UNCERTAIN, never "nothing to do"', () => {
  const first = startMigrationExecution(planApply(PAIRS(), []), execDeps());
  assert.equal(first.effects[0].kind, 'reserve', 'precondition: the first emitted effect is the reservation');
  const verdict = stepMigrationExecution(first.state, { type: 'port_failed' });
  assert.equal(verdict.state.outcome, 'failed', 'a rejected reservation is fatal');
  assert.equal(verdict.state.code, ENGINE_CODES.PORT_OPERATION_FAILED, 'the bounded reason code');
  // The adapter contract proves no atomic no-allocation-on-failure, so a backend may exist.
  assert.equal(verdict.state.ownershipUncertain, true, 'a rejecting reserve may already have allocated a backend');
  assert.equal(verdict.state.disposition, 'cancel_and_dispose', 'the executor must cancel the attempt and dispose of any session');
  assert.equal(verdict.effects.length, 0, 'a fatal reserve failure emits no migration effects');
});

test('S1.7G-2 kernel: NO reserve-stage outcome can report disposition none with certain ownership', () => {
  const cases: Array<readonly [string, ExecutionEvent]> = [
    ['port_failed', { type: 'port_failed' }],
    ['timeout', { type: 'timeout' }],
    ['ok', { type: 'ok' }],
    ['identity', { type: 'identity', identity: { token: 'pid-1' } }],
    ['lock', { type: 'lock', acquired: true }],
    ['unlock', { type: 'unlock', released: true }],
    ['unknown_type', { type: 'nope' } as unknown as ExecutionEvent],
    ['null_event', null as unknown as ExecutionEvent],
    ['accessor_backed', Object.defineProperty({}, 'type', { get: () => 'reserved' }) as unknown as ExecutionEvent],
    ['contradictory', { type: 'reserved', acquired: false, token: null } as unknown as ExecutionEvent],
  ];
  const observed: Record<string, string> = {};
  for (const [label, ev] of cases) {
    const first = startMigrationExecution(planApply(PAIRS(), []), execDeps());
    const v = stepMigrationExecution(first.state, ev);
    observed[label] = v.state.outcome === 'in_progress'
      ? 'in_progress'
      : `${v.state.disposition}/${v.state.ownershipUncertain}`;
  }
  for (const label of Object.keys(observed)) {
    assert.notEqual(observed[label], 'none/false', `${label}: a reserve-stage failure never reports "nothing to do"`);
  }
});

test('S1.7G-3 kernel: every later or duplicate event after a reserve-uncertainty verdict emits zero effects', () => {
  const first = startMigrationExecution(planApply(PAIRS(), []), execDeps());
  const verdict = stepMigrationExecution(first.state, { type: 'port_failed' });
  assert.equal(verdict.state.disposition, 'cancel_and_dispose', 'precondition: the rejected reserve is an uncertain verdict');
  assert.equal(verdict.state.ownershipUncertain, true, 'precondition: ownership is uncertain');
  const later: ExecutionEvent[] = [
    { type: 'reserved' },
    { type: 'ok' },
    { type: 'port_failed' },
    { type: 'timeout' },
    { type: 'identity', identity: { token: 'pid-1' } },
    { type: 'lock', acquired: true },
    { type: 'unlock', released: true },
  ];
  let s = verdict.state;
  for (const ev of later) {
    const r = stepMigrationExecution(s, ev);
    assert.equal(r.effects.length, 0, 'a terminal verdict emits no further effects');
    assert.equal(r.state.outcome, 'failed', 'the verdict is absorbed, never restarted');
    assert.equal(r.state.disposition, 'cancel_and_dispose', 'the uncertain disposition is absorbed unchanged');
    assert.equal(r.state.ownershipUncertain, true, 'uncertainty is never downgraded by a later event');
    s = r.state;
  }
});

test('S1.7G-4 kernel: close can never follow a reserve-stage uncertainty verdict', () => {
  const first = startMigrationExecution(planApply(PAIRS(), []), execDeps());
  const verdict = stepMigrationExecution(first.state, { type: 'port_failed' });
  assert.equal(verdict.state.ownershipUncertain, true, 'precondition: a rejected reserve leaves ownership uncertain');
  // Drive as hard as an executor can from the uncertain verdict: the full happy-path answer set,
  // repeatedly. No sequence may reach `complete` and none may re-enter the program.
  const answers: ExecutionEvent[] = [
    { type: 'reserved' },
    { type: 'identity', identity: { token: 'pid-1' } },
    { type: 'lock', acquired: true },
    { type: 'ok' },
    { type: 'unlock', released: true },
  ];
  let s = verdict.state;
  for (let i = 0; i < 40; i += 1) {
    const r = stepMigrationExecution(s, answers[i % answers.length]);
    assert.notEqual(r.state.outcome, 'complete', 'no clean close after reserve uncertainty');
    assert.equal(r.state.cursor, 0, 'the terminal verdict holds no program cursor');
    assert.equal(r.state.sessionLive, false, 'no session is ever live after the verdict');
    assert.equal(r.state.ownershipUncertain, true, 'the disposal obligation survives every later event');
    s = r.state;
  }
});

test('S1.7G-5: every public result WRAPPER the module returns is frozen', () => {
  const ds = discoverMigrations(fakeFs(TWO_PAIRS));
  const pairs = pairMigrations(ds);
  const plan = planApply(pairs, []);
  const start = startMigrationExecution(plan, execDeps());
  const wrappers: Array<readonly [string, unknown]> = [
    ['discoverMigrations', ds],
    ['pairMigrations', pairs],
    ['computeStatus', computeStatus(pairs, [])],
    ['planApply', plan],
    ['planApply.pending', plan.pending],
    ['planBaseline', planBaseline(pairs, [], ['001', '002'])],
    ['planDirtyResolution', planDirtyResolution({ version: '001', reasonCategory: 'operator', correctiveRef: '003', at: '2020-01-01T00:00:00Z' })],
    ['startMigrationExecution', start],
    ['startMigrationExecution.state', start.state],
    ['stepMigrationExecution', stepMigrationExecution(start.state, { type: 'reserved' })],
  ];
  const mutable: string[] = [];
  for (const [name, r] of wrappers) if (!Object.isFrozen(r)) mutable.push(name);
  assert.deepEqual(mutable, [], 'every public result wrapper is frozen');
});

test('S1.7G-6: every object and array reachable from a public result is deeply frozen', () => {
  const ds = discoverMigrations(fakeFs(TWO_PAIRS));
  const pairs = pairMigrations(ds);
  const plan = planApply(pairs, []);
  const start = startMigrationExecution(plan, execDeps());
  const graphs: Array<readonly [string, unknown]> = [
    ['discoverMigrations', ds],
    ['pairMigrations', pairs],
    ['computeStatus', computeStatus(pairs, [{ version: '001', checksum: pairs[0].up.checksum, dirty: false }])],
    ['planApply', plan],
    ['planBaseline', planBaseline(pairs, [], ['001', '002'])],
    ['planDirtyResolution', planDirtyResolution({ version: '001', reasonCategory: 'operator', correctiveRef: '003', at: '2020-01-01T00:00:00Z' })],
    ['startMigrationExecution', start],
    ['stepMigrationExecution', stepMigrationExecution(start.state, { type: 'reserved' })],
    ['terminalVerdict', stepMigrationExecution(start.state, { type: 'port_failed' })],
  ];
  const bad: string[] = [];
  for (const [name, g] of graphs) for (const p of unfrozenPaths(g, name)) bad.push(p);
  assert.deepEqual(bad, [], 'no reachable object or array in a public result is mutable');
});

test('S1.7G-7: mutating an INPUT after a call cannot alter what that call already returned', () => {
  const owned = mutableDescriptors();
  const pairs = pairMigrations(owned);
  const ownedPairs = mutablePairs();
  const plan = planApply(ownedPairs, []);
  const status = computeStatus(ownedPairs, []);
  const baseline = planBaseline(ownedPairs, [], ['001', '002']);
  const fingerprint = (): string => JSON.stringify([
    pairs.map((p) => `${p.version}|${p.name}|${p.transactionMode}|${p.up.checksum}|${p.up.artifact.sql}|${p.down.checksum}`),
    plan.pending.map((p) => `${p.version}|${p.transactionMode}|${p.up.checksum}|${p.up.artifact.sql}`),
    status.map((s) => `${s.version}|${s.fileChecksum}|${s.state}`),
    baseline.versions.map((v) => `${v.version}|${v.checksum}`).concat(baseline.plannedAudit.versions),
  ]);
  const before = fingerprint();
  // Every caller-owned input object is now rewritten — including the SQL-bearing artifacts.
  for (const d of owned.concat(ownedPairs.map((p) => p.up), ownedPairs.map((p) => p.down))) {
    d.name = 'rewritten';
    d.version = '999';
    d.checksum = 'f'.repeat(64);
    d.transactionMode = 'forbidden';
    (d.artifact as { sql: string }).sql = 'DROP TABLE schema_migrations;';
    (d.artifact as { checksum: string }).checksum = '0'.repeat(64);
  }
  for (const p of ownedPairs) { p.version = '999'; p.name = 'rewritten'; p.transactionMode = 'forbidden'; }
  assert.equal(fingerprint(), before, 'a returned result holds engine-owned snapshots, not live input references');
});

test('S1.7G-8: a returned plan, status, or descriptor cannot be mutated to change a later call', () => {
  const ds = discoverMigrations(fakeFs(TWO_PAIRS));
  const pairs = pairMigrations(ds);
  const plan = planApply(pairs, []);
  const status = computeStatus(pairs, []);
  const baseline = planBaseline(pairs, [], ['001', '002']);
  const attempts: Array<readonly [string, () => void]> = [
    ['discoverMigrations[0].checksum', () => { (ds[0] as { checksum: string }).checksum = '0'.repeat(64); }],
    ['pairMigrations[0].transactionMode', () => { (pairs[0] as { transactionMode: string }).transactionMode = 'forbidden'; }],
    ['plan.pending.push', () => { (plan.pending as MigrationPair[]).push(plan.pending[0]); }],
    ['plan.pending[0].version', () => { (plan.pending[0] as { version: string }).version = '999'; }],
    ['status[0].state', () => { (status[0] as { state: string }).state = 'applied'; }],
    ['baseline.versions[0].checksum', () => { (baseline.versions[0] as { checksum: string }).checksum = '0'.repeat(64); }],
    ['baseline.plannedAudit.appendOnly', () => { (baseline.plannedAudit as { appendOnly: boolean }).appendOnly = false; }],
  ];
  for (const [name, mutate] of attempts) {
    assert.throws(mutate, TypeError, `${name}: a frozen public result refuses mutation`);
  }
  assert.deepEqual(planApply(pairs, []).pending.map((p) => p.version), ['001', '002'], 'a later plan is unaffected');
  assert.deepEqual(computeStatus(pairs, []).map((s) => s.state), ['unapplied', 'unapplied'], 'a later status is unaffected');
  assert.deepEqual(
    planBaseline(pairs, [], ['001', '002']).versions.map((v) => v.checksum),
    [ds[0].checksum, ds[2].checksum],
    'a later baseline is unaffected',
  );
});

test('S1.7G-9: no caller-owned nested reference appears anywhere in a public result', () => {
  const ownedPairs = mutablePairs();
  const ownedDescriptors = mutableDescriptors();
  const callerOwned = new Set<object>();
  for (const n of reachableNodes(ownedPairs)) callerOwned.add(n);
  for (const n of reachableNodes(ownedDescriptors)) callerOwned.add(n);
  const results: Array<readonly [string, unknown]> = [
    ['pairMigrations', pairMigrations(ownedDescriptors)],
    ['planApply', planApply(ownedPairs, [])],
    ['computeStatus', computeStatus(ownedPairs, [])],
    ['planBaseline', planBaseline(ownedPairs, [], ['001', '002'])],
    ['startMigrationExecution', startMigrationExecution(planApply(ownedPairs, []), execDeps())],
  ];
  const leaks: string[] = [];
  for (const [name, g] of results) {
    for (const node of reachableNodes(g)) if (callerOwned.has(node)) leaks.push(name);
  }
  assert.deepEqual(leaks, [], 'a returned graph shares no object with the caller-owned input');
});

test('S1.7G-10: re-pointing Object.freeze or Object.defineProperty after import cannot weaken a public result', () => {
  const realFreeze = Object.freeze;
  const realDefine = Object.defineProperty;
  let captured: Array<readonly [string, unknown]> = [];
  try {
    (Object as unknown as { freeze: unknown }).freeze = (o: unknown): unknown => o;
    (Object as unknown as { defineProperty: unknown }).defineProperty = (o: unknown): unknown => o;
    const ds = discoverMigrations(fakeFs(TWO_PAIRS));
    const pairs = pairMigrations(ds);
    const plan = planApply(pairs, []);
    captured = [
      ['discoverMigrations', ds],
      ['pairMigrations', pairs],
      ['computeStatus', computeStatus(pairs, [])],
      ['planApply', plan],
      ['planBaseline', planBaseline(pairs, [], ['001', '002'])],
      ['planDirtyResolution', planDirtyResolution({ version: '001', reasonCategory: 'operator', correctiveRef: '003', at: '2020-01-01T00:00:00Z' })],
      ['startMigrationExecution', startMigrationExecution(plan, execDeps())],
    ];
  } finally {
    (Object as unknown as { freeze: unknown }).freeze = realFreeze;
    (Object as unknown as { defineProperty: unknown }).defineProperty = realDefine;
  }
  const bad: string[] = [];
  for (const [name, g] of captured) for (const p of unfrozenPaths(g, name)) bad.push(p);
  assert.deepEqual(bad, [], 'freezing is bound at module load, never resolved through the live global at call time');
  // …and the SQL-bearing artifact stays NON-ENUMERABLE even with a neutered defineProperty, so a
  // JSON.stringify of a descriptor, pair, or plan remains structurally SQL-free.
  const ds2 = captured[0][1] as MigrationDescriptor[];
  assert.equal(Object.keys(ds2[0]).includes('artifact'), false, 'the SQL-bearing artifact is never enumerable');
  assert.equal(JSON.stringify(captured[3][1]).includes('create table'), false, 'a serialized plan carries no SQL');
});

test('S1.7G-11: a caller-installed Symbol.hasInstance cannot reclassify an engine verdict', () => {
  // `createNodeFsPort`'s readBytes told its OWN bounded refusal apart from a driver errno with
  // `e instanceof MigrationEngineError`. `instanceof` consults `MigrationEngineError[Symbol.hasInstance]`
  // — an own property ANY caller can install, because the class is exported — so answering `false`
  // downgraded a precise `nonregular_migration_entry` refusal to a generic `port_operation_failed`.
  // Caller-controlled `instanceof` semantics are only Advisory while they cannot reach module
  // behaviour; here they reached a verdict, so this is a Required correction.
  //
  // The code is read STRUCTURALLY (own `code` data property), never through `instanceof`, because
  // the shared `codeOf` helper would itself be steered by the very patch under test.
  const codeOfStructural = (fn: () => unknown): string => {
    try { fn(); return 'NO_THROW'; } catch (e) {
      const d = e === null || typeof e !== 'object' ? undefined : Object.getOwnPropertyDescriptor(e, 'code');
      return d !== undefined && typeof d.value === 'string' ? d.value : `OTHER:${String(e)}`;
    }
  };
  const root = mkdtempSync(join(tmpdir(), 'mig-hasinstance-'));
  mkdirSync(join(root, 'sub'));
  const port = createNodeFsPort(root, 'x');
  const clean = codeOfStructural(() => port.readBytes('sub'));
  let patched = 'UNSET';
  const real = Object.getOwnPropertyDescriptor(MigrationEngineError, Symbol.hasInstance);
  try {
    Object.defineProperty(MigrationEngineError, Symbol.hasInstance, { value: () => false, configurable: true });
    patched = codeOfStructural(() => port.readBytes('sub'));
  } finally {
    if (real !== undefined) Object.defineProperty(MigrationEngineError, Symbol.hasInstance, real);
    else Reflect.deleteProperty(MigrationEngineError, Symbol.hasInstance);
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(clean, ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY, 'a directory is a NONREGULAR entry, not a generic port failure');
  assert.equal(patched, clean, 'a caller-installed hasInstance cannot change which verdict the engine reports');
});
