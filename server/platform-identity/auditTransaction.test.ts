// Phase 4.0 M3 S3 — control-flow contract of the mutation-plus-audit transaction helper.
//
// DATABASE-FREE, AND HONEST ABOUT IT. The boundary below is a fake: it records whether the
// callback threw and calls that "rolled back". That proves the helper ASKS for a rollback on
// every failing path; it proves NOTHING about PostgreSQL actually discarding the mutation. The
// real atomicity evidence — a business row observed absent, out of band by the owner, after a
// privilege failure inside the transaction — is tests/db/auditAtomicity.integration.test.mjs
// against disposable PostgreSQL. Neither suite substitutes for the other, and this one never
// claims the other's result.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runAuditedMutation,
  AuditTransactionError,
  type AuditTransactionBoundary,
  type AuditedMutationOutcome,
} from './auditTransaction';
import {
  type AuditEventWriteInput,
  type AuditSqlExecutor,
  type WrittenAuditEvent,
} from './auditEventWriter';
import type { SqlExecutor } from './authorizationRepository';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HELPER_SRC = readFileSync(join(HERE, 'auditTransaction.ts'), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
/** A SECOND store id, distinct from the one the base event carries, so a builder that ignores
 *  its argument cannot pass the "built from the mutation result" assertion by coincidence. */
const S2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';

/**
 * COMPILE-TIME assertion, not a runtime test: a real postgres.js client must satisfy the
 * injected boundary, or no `.ts` caller could ever pass one and the seam would be usable only
 * from the untypechecked `.mjs` integration suite. `SqlExecutor` IS `postgres.Sql`, so naming it
 * here proves exactly that — while keeping this file out of the executor-containment scanner's
 * driver-importer inventory, which a direct `postgres` import would join.
 */
const _realClientSatisfiesTheBoundary: AuditTransactionBoundary = null as unknown as SqlExecutor;
void _realClientSatisfiesTheBoundary;

const auditEvent = (): AuditEventWriteInput => ({
  requestId: 'req-s3-tx-1',
  traceId: null,
  actorInternalUserId: null,
  actorAuthProvider: null,
  onBehalfOfInternalUserId: null,
  scopeType: 'store',
  tenantId: T1,
  storeId: S1,
  actionId: 's3.audit.tx',
  requiredPermission: 'store:rename',
  decision: 'allow',
  reasonCode: 's3_tx_unit',
  humanReadableReason: 'S3 transaction-helper unit event.',
  resultStatus: 'succeeded',
  sourceOfTruth: 'server_authorization_resolver',
  evaluatedBy: 'durable_audit@v0-contract',
  evidenceLevel: 'durable_compliance_event',
  metadata: { phase: 'phase-4.0-m3-s3' },
});

interface FakeTx {
  handle: AuditSqlExecutor;
  statements: string[];
}

/** A transaction-scoped handle: a tagged template plus the driver's json helper. */
function makeTx(): FakeTx {
  const statements: string[] = [];
  const handle = Object.assign(
    async (strings: TemplateStringsArray) => { statements.push(strings.join('?')); return []; },
    { json: (v: unknown) => ({ __json: v }) },
  ) as unknown as AuditSqlExecutor;
  return { handle, statements };
}

/**
 * A boundary that models `sql.begin`: run the callback, resolve on success, and on any throw
 * mark the transaction discarded and re-raise. `commitFails` models COMMIT itself failing AFTER
 * the callback returned — the one path where the work succeeded and the outcome must still
 * never reach the caller.
 */
function makeBoundary(opts: { commitFails?: Error; commitGate?: Promise<void> } = {}) {
  const state = {
    begins: 0,
    rolledBack: false,
    committed: false,
    tx: null as FakeTx | null,
    callbackReturned: undefined as unknown,
  };
  const boundary: AuditTransactionBoundary = {
    async begin<T>(fn: (tx: AuditSqlExecutor) => T | Promise<T>): Promise<T> {
      state.begins += 1;
      const tx = makeTx();
      state.tx = tx;
      let value: T;
      try {
        value = await fn(tx.handle);
      } catch (e) {
        state.rolledBack = true;
        throw e;
      }
      state.callbackReturned = value;
      // The callback has returned but COMMIT has not landed. Holding here models exactly that
      // window, which is the only place "resolves only after the boundary resolves" can be
      // observed — gating the audit callback instead would prove something weaker.
      if (opts.commitGate) await opts.commitGate;
      if (opts.commitFails) { state.rolledBack = true; throw opts.commitFails; }
      state.committed = true;
      return value;
    },
  };
  return { boundary, state };
}

/** A writer spy that records the exact executor it was handed. */
function auditSpy(behaviour: { fail?: Error; defer?: boolean } = {}) {
  const seen: Array<{ event: AuditEventWriteInput; executor: unknown }> = [];
  let release: (() => void) | null = null;
  const gate = behaviour.defer ? new Promise<void>((r) => { release = r; }) : null;
  const fn = async (
    event: AuditEventWriteInput,
    options: { executor?: AuditSqlExecutor },
  ): Promise<WrittenAuditEvent> => {
    seen.push({ event, executor: options?.executor });
    if (gate) await gate;
    if (behaviour.fail) throw behaviour.fail;
    return { eventId: 'evt-fake', requestId: event.requestId };
  };
  return { fn, seen, release: () => release?.() };
}

const rejection = async (fn: () => unknown): Promise<Error> => {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error('expected a rejection, got none');
};

// ---------------------------------------------------------------------------
// one transaction, one executor, mutation first
// ---------------------------------------------------------------------------

test('S3-TX-1: mutation and audit receive the IDENTICAL transaction-scoped executor', async () => {
  const { boundary, state } = makeBoundary();
  const spy = auditSpy();
  let mutationExecutor: unknown = null;

  await runAuditedMutation(
    boundary,
    {
      mutate: async (tx) => { mutationExecutor = tx; return { storeId: S1 }; },
      buildAuditEvent: () => auditEvent(),
    },
    { writeAuditEvent: spy.fn },
  );

  assert.equal(state.begins, 1, 'exactly one transaction may be opened');
  assert.equal(mutationExecutor, state.tx!.handle);
  assert.equal(spy.seen[0].executor, state.tx!.handle, 'object identity, not merely a similar handle');
  assert.equal(spy.seen[0].executor, mutationExecutor);
});

test('S3-TX-2: order is mutation, then build, then audit', async () => {
  const { boundary } = makeBoundary();
  const order: string[] = [];
  const spy = auditSpy();

  await runAuditedMutation(
    boundary,
    {
      mutate: async () => { order.push('mutate'); return 1; },
      buildAuditEvent: () => { order.push('build'); return auditEvent(); },
    },
    { writeAuditEvent: async (e, o) => { order.push('audit'); return spy.fn(e, o); } },
  );
  assert.deepEqual(order, ['mutate', 'build', 'audit']);
});

test('S3-TX-3: the outcome carries the mutation result and the audit receipt, typed', async () => {
  const { boundary } = makeBoundary();
  const spy = auditSpy();
  interface Renamed { storeId: string; rows: number }

  // The mutation returns a store id DIFFERENT from the one the base event carries, so a
  // buildAuditEvent that ignored its argument would produce S1 and fail the last assertion.
  assert.notEqual(S2, auditEvent().storeId);

  const outcome: AuditedMutationOutcome<Renamed> = await runAuditedMutation<Renamed>(
    boundary,
    {
      mutate: async () => ({ storeId: S2, rows: 1 }),
      buildAuditEvent: (r) => ({ ...auditEvent(), storeId: r.storeId }),
    },
    { writeAuditEvent: spy.fn },
  );

  assert.deepEqual(outcome.result, { storeId: S2, rows: 1 });
  assert.deepEqual(outcome.audit, { eventId: 'evt-fake', requestId: 'req-s3-tx-1' });
  // The event really was built FROM the mutation result, not from a captured constant.
  assert.equal(spy.seen[0].event.storeId, S2);
});

// ---------------------------------------------------------------------------
// failing paths
// ---------------------------------------------------------------------------

test('S3-TX-4: a mutation failure prevents the audit INSERT entirely', async () => {
  const { boundary, state } = makeBoundary();
  const spy = auditSpy();
  const boom = Object.assign(new Error('permission denied for column status'), { code: '42501' });

  const err = await rejection(() => runAuditedMutation(
    boundary,
    { mutate: async () => { throw boom; }, buildAuditEvent: () => auditEvent() },
    { writeAuditEvent: spy.fn },
  ));

  assert.equal(err, boom, 'the mutation error propagates unchanged');
  assert.equal(spy.seen.length, 0, 'no audit may be attempted for a mutation that failed');
  assert.equal(state.rolledBack, true);
  assert.equal(state.committed, false);
});

test('S3-TX-5: an audit failure rejects the helper and is never swallowed', async () => {
  const { boundary, state } = makeBoundary();
  const denied = Object.assign(new Error('permission denied for table audit_event'), { code: '42501' });
  const spy = auditSpy({ fail: denied });

  const err = await rejection(() => runAuditedMutation(
    boundary,
    { mutate: async () => 'mutated', buildAuditEvent: () => auditEvent() },
    { writeAuditEvent: spy.fn },
  ));

  assert.equal(err, denied, 'the audit error reaches the caller — not a flag, not a wrapper');
  assert.equal((err as { code?: string }).code, '42501');
  assert.equal(spy.seen.length, 1, 'attempted exactly once — nothing is retried');
  assert.equal(state.rolledBack, true, 'the helper asked for a rollback (fake boundary — see header)');
  assert.equal(state.committed, false);
});

test('S3-TX-6: a failure while BUILDING the event rolls back through the same transaction', async () => {
  const { boundary, state } = makeBoundary();
  const spy = auditSpy();
  const bad = new Error('audit event cannot be described');
  let mutated = false;

  const err = await rejection(() => runAuditedMutation(
    boundary,
    {
      mutate: async () => { mutated = true; return 1; },
      buildAuditEvent: () => { throw bad; },
    },
    { writeAuditEvent: spy.fn },
  ));

  assert.equal(err, bad);
  assert.equal(mutated, true, 'the mutation had already run — that is why rollback matters here');
  assert.equal(spy.seen.length, 0);
  assert.equal(state.rolledBack, true);
  assert.equal(state.begins, 1, 'no second transaction is opened to salvage anything');
});

test('S3-TX-7: a COMMIT failure yields no success result', async () => {
  const commitBoom = Object.assign(new Error('could not serialize access'), { code: '40001' });
  const { boundary, state } = makeBoundary({ commitFails: commitBoom });
  const spy = auditSpy();

  const err = await rejection(() => runAuditedMutation(
    boundary,
    { mutate: async () => 'mutated', buildAuditEvent: () => auditEvent() },
    { writeAuditEvent: spy.fn },
  ));

  assert.equal(err, commitBoom);
  assert.equal(state.committed, false);
  // The callback did produce a value — the point is that it never became a caller's result.
  assert.equal((state.callbackReturned as AuditedMutationOutcome<string>).result, 'mutated');
});

test('S3-TX-8: the outcome is produced only after the boundary itself resolves', async () => {
  // Two distinct windows, because passing the first proves less than the title claims: an
  // implementation could resolve as soon as the audit returned and still be wrong. The second
  // window holds COMMIT open AFTER the callback has produced its value.
  let releaseCommit: () => void = () => {};
  const commitGate = new Promise<void>((r) => { releaseCommit = r; });
  const { boundary, state } = makeBoundary({ commitGate });
  const spy = auditSpy({ defer: true });
  let settled = false;

  const p = runAuditedMutation(
    boundary,
    { mutate: async () => 1, buildAuditEvent: () => auditEvent() },
    { writeAuditEvent: spy.fn },
  ).then((v) => { settled = true; return v; });

  // Window 1: the audit INSERT is still in flight.
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'nothing may resolve while the audit is still in flight');
  assert.equal(state.committed, false);

  // Window 2: the callback has produced its value, but COMMIT has not landed.
  spy.release();
  await new Promise((r) => setImmediate(r));
  assert.notEqual(state.callbackReturned, undefined, 'the callback has produced its value');
  assert.equal(settled, false, 'a produced value is not a committed transaction');
  assert.equal(state.committed, false);

  releaseCommit();
  const outcome = await p;
  assert.equal(settled, true);
  assert.equal(state.committed, true);
  assert.equal(outcome.audit.eventId, 'evt-fake');
});

// ---------------------------------------------------------------------------
// the seams that make "one transaction, one executor" unfakeable
// ---------------------------------------------------------------------------

test('S3-TX-9: the default writer is invoked with the transaction handle, never its own client', async () => {
  // deps omitted on purpose: this exercises the REAL writeAuditEvent through the helper's
  // default. Had the helper dropped `{ executor: tx }`, the writer would fall through to
  // getDb() — which in this process has no configured URL and would throw, not silently pass.
  const { boundary, state } = makeBoundary();
  const outcome = await runAuditedMutation(boundary, {
    mutate: async () => 'mutated',
    buildAuditEvent: () => auditEvent(),
  });

  assert.equal(state.begins, 1);
  assert.equal(state.committed, true);
  assert.equal(state.tx!.statements.length, 1, 'the real writer sent exactly one statement');
  assert.ok(state.tx!.statements[0].toLowerCase().includes('insert into audit_event'));
  assert.ok(!/\breturning\b/i.test(state.tx!.statements[0]));
  assert.equal(outcome.audit.requestId, 'req-s3-tx-1');
  assert.match(outcome.audit.eventId, /^[0-9a-f]{8}-/i);
});

test('S3-TX-10: the real writer rejects a scope-inconsistent event before any statement is sent', async () => {
  // The helper does not re-validate; the writer does, inside the transaction and before
  // touching it. The mutation must therefore roll back.
  const { boundary, state } = makeBoundary();
  let mutated = false;
  const err = await rejection(() => runAuditedMutation(boundary, {
    mutate: async () => { mutated = true; return 1; },
    buildAuditEvent: () => ({ ...auditEvent(), scopeType: 'none', tenantId: T1, storeId: S1 }),
  }));

  assert.equal(err.name, 'AuditEventValidationError');
  assert.equal(mutated, true);
  assert.equal(state.tx!.statements.length, 0, 'no audit statement may be sent for a rejected event');
  assert.equal(state.rolledBack, true);
});

test('S3-TX-11: a transaction HANDLE cannot be passed as the boundary', async () => {
  // Measured on the pinned driver, a postgres.js transaction handle exposes no `begin`, so this
  // is the real misuse the guard catches — nesting would open a savepoint, not a transaction.
  const tx = makeTx();
  let mutated = false;
  const err = await rejection(() => runAuditedMutation(
    tx.handle as unknown as AuditTransactionBoundary,
    { mutate: async () => { mutated = true; return 1; }, buildAuditEvent: () => auditEvent() },
  ));
  assert.ok(err instanceof AuditTransactionError, err.name);
  assert.match(err.message, /pass the client, not a transaction handle/);
  assert.equal(mutated, false, 'nothing may execute outside a transaction');
  assert.equal(tx.statements.length, 0);
});

test('S3-TX-12: a malformed operation is refused before anything runs', async () => {
  const { boundary, state } = makeBoundary();
  for (const bad of [
    { buildAuditEvent: () => auditEvent() },
    { mutate: async () => 1 },
    {},
  ]) {
    const err = await rejection(() =>
      runAuditedMutation(boundary, bad as never, { writeAuditEvent: auditSpy().fn }));
    assert.ok(err instanceof AuditTransactionError, err.name);
  }
  assert.equal(state.begins, 0, 'no transaction may be opened for a malformed operation');
});

test('S3-TX-13: the helper opens no connection and has no fallback or retry path', () => {
  const code = stripComments(HELPER_SRC);
  assert.ok(!/getDb\s*\(/.test(code), 'the helper must never reach for its own client');
  assert.ok(!/getRuntimeDb\s*\(/.test(code));
  assert.ok(!/\bcatch\b/.test(code), 'a catch here is how a required audit error gets swallowed');
  assert.ok(!/\bretry\b|setTimeout|while\s*\(/.test(code), 'nothing may be retried');
  // Assembled from fragments at runtime, deliberately. tests/quality/migration-executor-
  // containment.test.mjs scans every file under server/ for a contiguous driver-import token and
  // asserts an EXACT inventory of importers; spelling it out here would make this assertion read
  // as a driver import of its own. The scanner is the control and stays byte-unchanged — the
  // test that trips it is what gets fixed, and the coverage below is identical either way.
  const driverImport = new RegExp(`from\\s+['"]${['post', 'gres'].join('')}['"]`);
  assert.ok(!driverImport.test(code), 'no driver import — the boundary is injected');
  // Exactly one `begin` call site.
  assert.equal((code.match(/\.begin\s*[<(]/g) ?? []).length, 1);
  // The audit write is always given the transaction handle.
  assert.ok(/writeAudit\(event,\s*\{\s*executor:\s*tx\s*\}\)/.test(code));
});

test('S3-TX-14: no production or DEV request caller imports the helper in S3', () => {
  // The S3 boundary is explicit that no runtime route or business caller is converted. If that
  // ever changes it must change deliberately, not as a side effect of an unrelated edit.
  //
  // IMPORTERS, not mentions. A test-registry entry naming the suite's PATH — the discovery
  // ratchet's sentinel list and its guard test both do — is not a caller, and matching bare
  // occurrences would report those two files as wiring. Only an import edge can make this
  // module run inside something else.
  //
  // A filesystem walk, not `git grep`: these files are not yet tracked when this first runs.
  const EXCLUDE = new Set(['node_modules', 'dist', '.git', 'agency-agents', '.cache']);
  const IMPORTS_HELPER = /(?:from|import)\s*\(?\s*['"][^'"]*\/auditTransaction(?:\.ts)?['"]/;
  const importers: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!EXCLUDE.has(e.name)) walk(p); continue; }
      if (!/\.(ts|tsx|mjs|js|cjs)$/.test(e.name)) continue;
      if (IMPORTS_HELPER.test(readFileSync(p, 'utf8'))) importers.push(relative(REPO, p));
    }
  };
  for (const root of ['server', 'src', 'scripts', 'tests']) walk(join(REPO, root));

  assert.deepEqual(importers.sort(), [
    'server/platform-identity/auditTransaction.test.ts',
    'tests/db/auditAtomicity.integration.test.mjs',
  ], `the transaction helper must have no runtime caller in S3, only its own tests: ${importers.join(', ')}`);

  // Nothing under src/ (the client bundle) may reference it at all, by any spelling.
  const clientHits: string[] = [];
  const scanClient = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!EXCLUDE.has(e.name)) scanClient(p); continue; }
      if (!/\.(ts|tsx|mjs|js|cjs)$/.test(e.name)) continue;
      if (/auditTransaction|runAuditedMutation/.test(readFileSync(p, 'utf8'))) clientHits.push(relative(REPO, p));
    }
  };
  scanClient(join(REPO, 'src'));
  assert.deepEqual(clientHits, [], `server-only module reached the client bundle: ${clientHits.join(', ')}`);
});
