// Phase 4.0 M5-GIAM-D1-P2 — the tenant status mutator's own contract: the one fixed call it makes, the
// from-status it derives rather than accepts, and the fault it answers for anything the operation did not
// promise. No database: the statement function is a recording stand-in, so every defensive branch is
// reachable here and none of them depends on PostgreSQL being present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TENANT_STATUS_MUTATOR } from './tenantStatusMutator.js';
import type { PgRows, PgStatement } from './postgresTransactionalStore.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';

const TENANT = '3f0c2a8e-9b1d-4c7e-8a2f-5d6e7f8a9b0c';
const rows = (list: readonly Record<string, unknown>[]): PgRows =>
  Object.assign([...list], { count: list.length }) as unknown as PgRows;

/** A statement function that records its bound values and answers `answer`. */
function recording(answer: readonly Record<string, unknown>[]): { sql: PgStatement; values: unknown[][] } {
  const values: unknown[][] = [];
  const sql = ((_strings: TemplateStringsArray, ...v: unknown[]) => { values.push(v); return Promise.resolve(rows(answer)); }) as PgStatement;
  return { sql, values };
}
const mutation = (over: Partial<TransactionMutation> = {}): TransactionMutation => Object.freeze({
  kind: 'platform.tenant.status.change', aggregateType: 'tenant', aggregateId: TENANT, expectedVersion: 3,
  changes: { status: 'suspended' }, ...over,
} as TransactionMutation);

test('the mutator registers for exactly its command kind, as an update of a tenant', () => {
  assert.deepEqual(
    { kind: TENANT_STATUS_MUTATOR.kind, mode: TENANT_STATUS_MUTATOR.mode, aggregateType: TENANT_STATUS_MUTATOR.aggregateType },
    { kind: 'platform.tenant.status.change', mode: 'update', aggregateType: 'tenant' });
  assert.ok(Object.isFrozen(TENANT_STATUS_MUTATOR));
});

test('the from-status is derived in trusted source, never taken from the command, and every value is bound', async () => {
  for (const [target, from] of [['suspended', 'active'], ['active', 'suspended']] as const) {
    const r = recording([{ o_outcome: 'applied', o_version: '4' }]);
    assert.equal(await TENANT_STATUS_MUTATOR.apply(r.sql, mutation({ changes: { status: target } })), 'applied');
    assert.deepEqual(r.values, [[TENANT, '3', from, target]],
      `${target}: the target, its expected version as decimal text, and the ONE status it may start from`);
  }
});

test('an answer the operation did not promise is a fault, never a business outcome', async () => {
  const applied = (version: unknown) => [{ o_outcome: 'applied', o_version: version }];
  const cases: Array<[string, readonly Record<string, unknown>[]]> = [
    ['no row', []],
    ['two rows', [{ o_outcome: 'applied', o_version: '4' }, { o_outcome: 'applied', o_version: '4' }]],
    ['applied at the version it started from', applied('3')],
    ['applied two versions on', applied('5')],
    ['applied with no version', applied(null)],
    ['applied with a numeric version', applied(4)],
    ['invalid', [{ o_outcome: 'invalid', o_version: null }]],
    ['unchanged — this command never has one', [{ o_outcome: 'unchanged', o_version: '3' }]],
    ['conflict carrying a version', [{ o_outcome: 'conflict', o_version: '3' }]],
    ['not_found carrying a version', [{ o_outcome: 'not_found', o_version: '3' }]],
    ['invalid_state carrying a version', [{ o_outcome: 'invalid_state', o_version: '3' }]],
    ['an outcome of its own', [{ o_outcome: 'applied_maybe', o_version: '4' }]],
  ];
  for (const [label, answer] of cases) {
    assert.equal(await TENANT_STATUS_MUTATOR.apply(recording(answer).sql, mutation()), 'fault', label);
  }
  // The three refusals the store maps, each only with a null version.
  for (const outcome of ['conflict', 'not_found', 'invalid_state']) {
    assert.equal(await TENANT_STATUS_MUTATOR.apply(recording([{ o_outcome: outcome, o_version: null }]).sql, mutation()), outcome, outcome);
  }
});

test('a mutation the store could not have produced is a fault before any statement runs', async () => {
  for (const [label, m] of [
    ['no expected version', mutation({ expectedVersion: null })],
    ['a textual version', mutation({ expectedVersion: '3' } as never)],
    ['no status', mutation({ changes: {} })],
    ['a numeric status', mutation({ changes: { status: 1 } } as never)],
  ] as const) {
    const r = recording([{ o_outcome: 'applied', o_version: '4' }]);
    assert.equal(await TENANT_STATUS_MUTATOR.apply(r.sql, m), 'fault', label);
    assert.deepEqual(r.values, [], `${label}: no statement ran`);
  }
});
