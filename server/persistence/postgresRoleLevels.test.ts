// Phase 4.0 M7A-CUSTOMERS-P3-R1 — the tenant role levels: the read every tenant route decision makes (its one fixed call,
// the answer's shape, a fault never read as "no edits") and the role-level edit's mutator (its one fixed call on the session
// key alone, the identities and level it requires the database to answer, and — through the real store over a recording
// kernel — that every answer but 'applied' rolls the whole command back instead of committing a sealed 409). Since
// M7A-CUSTOMERS-P4 the directory read is 021's one-snapshot states routine (levels and versions), and the edit is 021's
// conditional set: the asserted tenant and version bound beside the key, the committed version exactly one step on, and a
// precondition that no longer holds answered 'precondition_failed' — rolled back with NO completion. No database:
// migrations 020 and 021's routines are proved against a disposable cluster (tests/db).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ROLE_LEVELS_BOUNDS, ROLE_LEVEL_UPDATE_MUTATOR, createPostgresRoleLevelDirectory, createPostgresRoleLevels, readRoleLevelDirectory, readRoleLevels,
} from './postgresRoleLevels.js';
import { createPostgresTransactionalStore } from './postgresTransactionalStore.js';
import type { MutationAuthority, PgRows, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import { defineCommands, prepareCommand } from '../runtime/commandTransaction.js';
import type { TransactionCommand, TransactionMutation } from '../runtime/commandTransaction.js';
import { createIdempotencyKeyring } from '../runtime/idempotency.js';
import { TEST_IDEMPOTENCY_KEY } from '../runtime/idempotencyStore.testkit.js';
import { defineOutboxEvents } from '../runtime/outbox.js';
import type { TrustedScope } from '../runtime/principals.js';
import { ROLE_LEVEL_UPDATE_CONTRACT, planRoleLevelUpdate } from '../runtime/roleLevelUpdate.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '2a2a2a2a-2b2b-4c2c-8d2d-2e2e2e2e2e2e';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const SESSION_KEY = 'k'.repeat(21) + '_-' + 'K'.repeat(20);
const CONTEXT: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: TENANT, store: null, membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
});
const DEADLINE = 1_900_000_000_000;
const AUTHORITY: MutationAuthority = Object.freeze({ context: CONTEXT, sessionKey: SESSION_KEY, authNotAfter: DEADLINE });
const EXPECTED_VERSION = 6;
const DERIVED = Object.freeze({
  o_outcome: 'applied', o_tenant_id: TENANT, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_level: 'view', o_version: String(EXPECTED_VERSION + 1),
});
const REFUSED_AS = (outcome: string): Record<string, unknown> => ({
  o_outcome: outcome, o_tenant_id: null, o_actor_id: null, o_membership_id: null, o_level: null, o_version: null,
});

const rows = (list: readonly Record<string, unknown>[]): PgRows => Object.assign([...list], { count: list.length }) as unknown as PgRows;
/**
 * A statement function that records its text and bound values and answers `answer` (or throws it) — except the database-
 * clock freshness select, which answers `fresh`.
 */
function recording(answer: readonly Record<string, unknown>[] | Error, fresh = true): { sql: PgStatement; texts: string[]; values: unknown[][] } {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join('?');
    texts.push(text);
    values.push(v);
    if (text.includes('clock_timestamp')) return Promise.resolve(rows([{ fresh }]));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(rows(answer));
  }) as PgStatement;
  return { sql, texts, values };
}
const mutation = (over: Partial<TransactionMutation> = {}): TransactionMutation => Object.freeze({
  kind: ROLE_LEVEL_UPDATE_CONTRACT.kind, aggregateType: 'tenant_role_level', aggregateId: randomUUID(), expectedVersion: null,
  changes: { roleId: 'sales_staff', domain: 'customers', level: 'view', expectedTenant: TENANT, expectedVersion: EXPECTED_VERSION }, ...over,
} as TransactionMutation);

// --- the read ------------------------------------------------------------------------------------------------------------

test('the read is one fixed call into 020 on the trusted tenant and role, answering a frozen copy of the stored levels — {} when none', async () => {
  const r = recording([{ levels: { customers: 'view' } }]);
  const answer = await readRoleLevels(r.sql as unknown as PgTransactionScope, TENANT, 'sales_staff');
  assert.deepEqual(answer, { customers: 'view' });
  assert.ok(Object.isFrozen(answer));
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /^select tmpos_role\.m7a_role_levels\(\?::uuid, \?::text\) as levels$/);
  assert.deepEqual(r.values, [[TENANT, 'sales_staff']], 'the tenant and the role, bound');
  assert.deepEqual(await readRoleLevels(recording([{ levels: {} }]).sql as unknown as PgTransactionScope, TENANT, 'store_owner'), {}, 'nothing stored');
  for (const level of ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full']) {
    assert.deepEqual(await readRoleLevels(recording([{ levels: { customers: level } }]).sql as unknown as PgTransactionScope, TENANT, 'manager'), { customers: level });
  }
});

test('an answer out of shape is a FAULT — a throw, never "no edits" — and malformed inputs throw before any statement', async () => {
  const bad: Array<[string, readonly Record<string, unknown>[]]> = [
    ['no row', []], ['two rows', [{ levels: {} }, { levels: {} }]], ['another column', [{ levels: {}, extra: 1 }]], ['a renamed column', [{ level: {} }]],
    ['a null answer', [{ levels: null }]], ['an array', [{ levels: [] }]], ['text', [{ levels: '{}' }]],
    ['another domain', [{ levels: { sales: 'view' } }]], ['a non-canonical level', [{ levels: { customers: 'Full' } }]],
    ['a null level', [{ levels: { customers: null } }]], ['a prototype-less object', [{ levels: Object.create(null) }]],
  ];
  for (const [label, answer] of bad) {
    await assert.rejects(readRoleLevels(recording(answer).sql as unknown as PgTransactionScope, TENANT, 'manager'), /role levels answer invalid/, label);
  }
  for (const [tenant, role] of [['not-a-uuid', 'manager'], [TENANT.toUpperCase(), 'manager'], [TENANT, ''], [TENANT, 'Manager'], [TENANT, 'store owner']]) {
    const r = recording([{ levels: {} }]);
    await assert.rejects(readRoleLevels(r.sql as unknown as PgTransactionScope, tenant, role), /role levels answer invalid/, `${tenant}/${role}`);
    assert.deepEqual(r.texts, [], 'no statement');
  }
});

test('the authorizer\'s read runs in one bounded transaction on the composition\'s client, with the request\'s signal, and a fault propagates', async () => {
  const seen: Array<[AbortSignal, TransactionBounds]> = [];
  let answer: readonly Record<string, unknown>[] | Error = [{ levels: { customers: 'none' } }];
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(signal: AbortSignal, bounds: TransactionBounds, work: (scope: PgTransactionScope) => Promise<T>): Promise<T> => {
      seen.push([signal, bounds]);
      return work(recording(answer).sql as unknown as PgTransactionScope);
    },
    end: async (): Promise<void> => undefined,
  });
  const read = createPostgresRoleLevels({ client });
  const signal = new AbortController().signal;
  assert.deepEqual(await read(TENANT, 'technician', signal), { customers: 'none' });
  assert.deepEqual(seen, [[signal, ROLE_LEVELS_BOUNDS]]);
  assert.deepEqual(ROLE_LEVELS_BOUNDS, { lock: '2100ms', statement: '2700ms', idle: '6000ms' });
  answer = new Error('connection reset');
  await assert.rejects(read(TENANT, 'technician', signal), /connection reset/);
});

// --- the directory read (M7A-CUSTOMERS-P3-R2; M7A-CUSTOMERS-P4) -------------------------------------------------------

const DIRECTORY_TEXT = /^select tmpos_role_edit\.m7a_role_level_states\(\?::uuid\) as states$/;
const state = (roleId: string, level: unknown = null, version: unknown = 0): Record<string, unknown> => ({ roleId, level, version });
const statesRow = (s0: unknown = state('manager'), s1: unknown = state('technician'), s2: unknown = state('sales_staff')): Record<string, unknown> => ({ states: [s0, s1, s2] });

test('the directory read is ONE statement into 021 on the trusted tenant, answering stored ?? null and the version in role order, frozen', async () => {
  const r = recording([statesRow(state('manager', 'view', 3), state('technician'), state('sales_staff', 'none', 1))]);
  const answer = await readRoleLevelDirectory(r.sql as unknown as PgTransactionScope, TENANT, 'customers');
  assert.deepEqual(answer, [{ roleId: 'manager', stored: 'view', version: 3 }, { roleId: 'technician', stored: null, version: 0 },
    { roleId: 'sales_staff', stored: 'none', version: 1 }]);
  assert.ok(Object.isFrozen(answer) && answer.every((e) => Object.isFrozen(e)));
  assert.equal(r.texts.length, 1, 'one statement, one snapshot');
  assert.match(r.texts[0], DIRECTORY_TEXT);
  assert.deepEqual(r.values, [[TENANT]], 'the trusted tenant alone, bound');
  for (const level of ['none', 'view', 'create', 'edit', 'manage', 'approve', 'full']) {
    const all = await readRoleLevelDirectory(recording([statesRow(state('manager', level), state('technician', level), state('sales_staff', level))]).sql as unknown as PgTransactionScope, TENANT, 'customers');
    assert.deepEqual(all.map((e) => e.stored), [level, level, level], level);
  }
  assert.deepEqual((await readRoleLevelDirectory(recording([statesRow()]).sql as unknown as PgTransactionScope, TENANT, 'customers')).map((e) => [e.stored, e.version]),
    [[null, 0], [null, 0], [null, 0]], 'nothing stored, never edited');
  assert.equal((await readRoleLevelDirectory(recording([statesRow(state('manager', 'view', Number.MAX_SAFE_INTEGER))]).sql as unknown as PgTransactionScope, TENANT, 'customers'))[0].version,
    Number.MAX_SAFE_INTEGER);
});

test('a directory answer out of shape — in any of the three roles — is a FAULT, never "defaults", and a malformed tenant throws before any statement', async () => {
  // Each bad entry placed in every role's position in turn, then the answer-level and row-level ones.
  const entries: Array<[string, (roleId: string) => unknown]> = [
    ['a null entry', () => null], ['an array entry', (r) => [r, null, 0]], ['text', () => '{}'], ['a prototype-less object', (r) => Object.assign(Object.create(null), state(r))],
    ['a class instance', (r) => new (class S { roleId = r; level = null; version = 0; })()], ['another role word', () => state('cashier')],
    ['a non-canonical level', (r) => state(r, 'Full')], ['a numeric level', (r) => state(r, 3)], ['an undefined level', (r) => ({ roleId: r, level: undefined, version: 0 })],
    ['a negative version', (r) => state(r, null, -1)], ['a fractional version', (r) => state(r, null, 1.5)], ['a version as text', (r) => state(r, null, '1')],
    ['a null version', (r) => state(r, null, null)], ['an unsafe version', (r) => state(r, null, 2 ** 53)],
    ['a missing version', (r) => ({ roleId: r, level: null })], ['a missing level', (r) => ({ roleId: r, version: 0 })],
    ['an extra field', (r) => ({ ...state(r), tenant: TENANT })], ['020\'s map instead of a level', (r) => state(r, { customers: 'view' })],
  ];
  const roles = ['manager', 'technician', 'sales_staff'];
  const bad: Array<[string, readonly Record<string, unknown>[]]> = [];
  for (const [label, make] of entries) {
    for (let i = 0; i < 3; i++) {
      const list: unknown[] = roles.map((r) => state(r));
      list[i] = make(roles[i]);
      bad.push([`${label} at ${i}`, [{ states: list }]]);
    }
  }
  bad.push(
    ['no row', []], ['two rows', [statesRow(), statesRow()]], ['another column', [{ ...statesRow(), extra: 1 }]], ['a renamed column', [{ state: statesRow().states }]],
    ['a null answer', [{ states: null }]], ['an object answer', [{ states: { manager: state('manager') } }]], ['text', [{ states: '[]' }]],
    ['two roles', [{ states: [state('manager'), state('technician')] }]], ['four roles', [{ states: [...(statesRow().states as unknown[]), state('store_owner')] }]],
    ['roles out of order', [{ states: [state('technician'), state('manager'), state('sales_staff')] }]],
    ['020\'s three-column row', [{ r0: {}, r1: {}, r2: {} }]], ['a readRoleLevels row', [{ levels: {} }]],
  );
  for (const [label, answer] of bad) {
    await assert.rejects(readRoleLevelDirectory(recording(answer).sql as unknown as PgTransactionScope, TENANT, 'customers'), /role levels answer invalid/, label);
  }
  for (const tenant of ['not-a-uuid', TENANT.toUpperCase(), '', ` ${TENANT}`, null, 42]) {
    const r = recording([statesRow()]);
    await assert.rejects(readRoleLevelDirectory(r.sql as unknown as PgTransactionScope, tenant as never, 'customers'), /role levels answer invalid/, String(tenant));
    assert.deepEqual(r.texts, [], 'no statement');
  }
  // A driver error is not caught or rewritten here: it propagates, and the route answers the bounded 503.
  await assert.rejects(readRoleLevelDirectory(recording(new Error('connection reset')).sql as unknown as PgTransactionScope, TENANT, 'customers'), /connection reset/);
});

test('the directory read runs in one bounded transaction on the composition\'s client, with the request\'s signal, and a fault propagates', async () => {
  const seen: Array<[AbortSignal, TransactionBounds]> = [];
  let answer: readonly Record<string, unknown>[] | Error = [statesRow(state('manager'), state('technician', 'edit', 2))];
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(signal: AbortSignal, bounds: TransactionBounds, work: (scope: PgTransactionScope) => Promise<T>): Promise<T> => {
      seen.push([signal, bounds]);
      return work(recording(answer).sql as unknown as PgTransactionScope);
    },
    end: async (): Promise<void> => undefined,
  });
  const read = createPostgresRoleLevelDirectory({ client });
  const signal = new AbortController().signal;
  assert.deepEqual(await read(TENANT, signal), [{ roleId: 'manager', stored: null, version: 0 }, { roleId: 'technician', stored: 'edit', version: 2 },
    { roleId: 'sales_staff', stored: null, version: 0 }]);
  assert.deepEqual(seen, [[signal, ROLE_LEVELS_BOUNDS]]);
  answer = [statesRow(state('manager'), state('technician', 'Edit', 2))];
  await assert.rejects(read(TENANT, signal), /role levels answer invalid/);
  answer = new Error('connection reset');
  await assert.rejects(read(TENANT, signal), /connection reset/);
});

// --- the write -----------------------------------------------------------------------------------------------------------

test('the mutator registers for exactly the role-level edit contract, as a create of a tenant_role_level, frozen', () => {
  assert.deepEqual(Object.keys(ROLE_LEVEL_UPDATE_MUTATOR).sort(), ['aggregateType', 'apply', 'kind', 'mode']);
  assert.deepEqual([ROLE_LEVEL_UPDATE_MUTATOR.kind, ROLE_LEVEL_UPDATE_MUTATOR.mode, ROLE_LEVEL_UPDATE_MUTATOR.aggregateType],
    ['tenant.role.level.update', 'create', 'tenant_role_level']);
  assert.ok(Object.isFrozen(ROLE_LEVEL_UPDATE_MUTATOR));
});

test('one fixed call into 021: the session key as the ONLY authority input, then the role, the domain, the level and the two preconditions — never an actor or grant', async () => {
  const r = recording([DERIVED]);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(r.sql, mutation(), AUTHORITY), 'applied');
  assert.equal(r.texts.length, 2, 'the routine, then the recent sign-in judged again');
  assert.match(r.texts[0].replace(/\s+/g, ' '),
    /^select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version from tmpos_role_edit\.m7a_role_level_set_v2\(\?::text, \?::text, \?::text, \?::text, \?::uuid, \?::bigint\)$/);
  assert.deepEqual(r.values[0], [SESSION_KEY, 'sales_staff', 'customers', 'view', TENANT, String(EXPECTED_VERSION)],
    'six bound values: the key, the target role, the domain, the level, the asserted tenant and version (bigint as its decimal text)');
  for (const identity of [ACTOR, MEMBERSHIP, 'store_owner']) assert.ok(!r.values[0].includes(identity), `${identity} is never passed in`);
  assert.equal(r.values[0].indexOf(TENANT), 4, 'the tenant only as the asserted precondition, never as an authority input');
  // The asserted tenant is the planner's value, bound as it is — even when it is not the session's (the routine judges it).
  const other = recording([REFUSED_AS('tenant_mismatch')]);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(other.sql, mutation({ changes: { ...mutation().changes, expectedTenant: OTHER } }), AUTHORITY), 'precondition_failed');
  assert.deepEqual(other.values[0].slice(4), [OTHER, String(EXPECTED_VERSION)]);
  assert.doesNotMatch(r.texts[0], /tenant_role_level\b|insert|update|delete/i, 'no table and no write of its own');
  assert.match(r.texts[1], /clock_timestamp\(\) <=/, 'the deadline, on the database clock');
  assert.deepEqual(r.values[1], [String(DEADLINE)], 'the deadline the store handed over, and nothing else');
});

test('a recent sign-in that went stale while the routine waited for the role row refuses the edit — judged on the database clock AFTER the routine (the review\'s finding)', async () => {
  const stale = recording([DERIVED], false);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(stale.sql, mutation(), AUTHORITY), 'refused', 'never applied: the store rolls the level back with everything else');
  assert.ok(stale.texts[0].includes('m7a_role_level_set') && stale.texts[1].includes('clock_timestamp'), 'the routine first, the deadline after its wait');
  // A mismatch is decided before the clock is asked, and a refusal by the routine never reaches it.
  const refused = recording([]);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(refused.sql, mutation(), AUTHORITY), 'refused');
  assert.equal(refused.texts.length, 1);
  // A precondition that failed wrote nothing: it is answered as it is, the clock never asked — stale or not.
  for (const outcome of ['tenant_mismatch', 'version_conflict']) {
    const failed = recording([REFUSED_AS(outcome)], false);
    assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(failed.sql, mutation(), AUTHORITY), 'precondition_failed', outcome);
    assert.equal(failed.texts.length, 1, `${outcome}: no clock`);
  }
});

test('applied only when the database answers exactly one applied row naming the revalidated tenant, actor AND grant, at the level asked and the next version; a failed precondition only as its exact all-null row; anything else is never a conflict', async () => {
  const cases: Array<[string, readonly Record<string, unknown>[], string]> = [
    ['no row: the routine refused the session\'s authority', [], 'refused'],
    ['two rows', [DERIVED, DERIVED], 'mismatch'],
    ['another tenant', [{ ...DERIVED, o_tenant_id: OTHER }], 'mismatch'],
    ['another actor', [{ ...DERIVED, o_actor_id: OTHER }], 'mismatch'],
    ['another grant', [{ ...DERIVED, o_membership_id: OTHER }], 'mismatch'],
    ['another level stored', [{ ...DERIVED, o_level: 'none' }], 'mismatch'],
    ['a null level', [{ ...DERIVED, o_level: null }], 'mismatch'],
    // M7A-CUSTOMERS-P4: the version the edit committed at is exactly one past the asserted one, as bigint text.
    ['the asserted version itself', [{ ...DERIVED, o_version: String(EXPECTED_VERSION) }], 'mismatch'],
    ['two versions on', [{ ...DERIVED, o_version: String(EXPECTED_VERSION + 2) }], 'mismatch'],
    ['the next version as a number', [{ ...DERIVED, o_version: EXPECTED_VERSION + 1 }], 'mismatch'],
    ['the next version zero-padded', [{ ...DERIVED, o_version: `0${EXPECTED_VERSION + 1}` }], 'mismatch'],
    ['no version', [{ ...DERIVED, o_version: null }], 'mismatch'],
    ['no outcome', [{ ...DERIVED, o_outcome: null }], 'mismatch'],
    ['an unknown outcome', [{ ...DERIVED, o_outcome: 'conflict' }], 'mismatch'],
    ['a cased outcome', [{ ...DERIVED, o_outcome: 'Applied' }], 'mismatch'],
    ['a tenant mismatch', [REFUSED_AS('tenant_mismatch')], 'precondition_failed'],
    ['a version conflict', [REFUSED_AS('version_conflict')], 'precondition_failed'],
    ['a tenant mismatch naming a tenant', [{ ...REFUSED_AS('tenant_mismatch'), o_tenant_id: OTHER }], 'mismatch'],
    ['a version conflict naming a version', [{ ...REFUSED_AS('version_conflict'), o_version: '9' }], 'mismatch'],
    ['a version conflict naming a level', [{ ...REFUSED_AS('version_conflict'), o_level: 'view' }], 'mismatch'],
    ['a version conflict naming an actor', [{ ...REFUSED_AS('version_conflict'), o_actor_id: ACTOR }], 'mismatch'],
    ['a tenant mismatch naming a grant', [{ ...REFUSED_AS('tenant_mismatch'), o_membership_id: MEMBERSHIP }], 'mismatch'],
    ['two failed preconditions', [REFUSED_AS('version_conflict'), REFUSED_AS('version_conflict')], 'mismatch'],
  ];
  for (const [label, answer, expected] of cases) {
    const outcome = await ROLE_LEVEL_UPDATE_MUTATOR.apply(recording(answer).sql, mutation(), AUTHORITY);
    assert.equal(outcome, expected, label);
    assert.notEqual(outcome, 'conflict', `${label}: never the sealed 409`);
  }
});

test('a routine error propagates uncaught, and nothing is called without the revalidated tenant context, its key and the three changes', async () => {
  const fault = Object.assign(new Error('M7RL-UNIT-CANARY invalid_parameter_value'), { code: '22023' });
  await assert.rejects(ROLE_LEVEL_UPDATE_MUTATOR.apply(recording(fault).sql, mutation(), AUTHORITY), (err: unknown) => err === fault);
  for (const [label, authority, m] of [
    ['no authority at all', undefined, mutation()],
    ['a null context', { context: null, sessionKey: SESSION_KEY, authNotAfter: DEADLINE }, mutation()],
    ['a platform context', { context: { ...CONTEXT, scope: 'platform', tenant: null }, sessionKey: SESSION_KEY, authNotAfter: DEADLINE }, mutation()],
    ['no session key', { context: CONTEXT, sessionKey: null, authNotAfter: DEADLINE }, mutation()],
    ['no recent sign-in deadline', { context: CONTEXT, sessionKey: SESSION_KEY, authNotAfter: null }, mutation()],
    ['a deadline that is not a positive safe integer', { context: CONTEXT, sessionKey: SESSION_KEY, authNotAfter: 1.5 }, mutation()],
    ['no level', AUTHORITY, mutation({ changes: { roleId: 'manager', domain: 'customers', expectedTenant: TENANT, expectedVersion: 0 } })],
    ['a role that is not text', AUTHORITY, mutation({ changes: { roleId: 1, domain: 'customers', level: 'view', expectedTenant: TENANT, expectedVersion: 0 } })],
    // M7A-CUSTOMERS-P4: never a call without both preconditions, each well formed.
    ['no expected tenant', AUTHORITY, mutation({ changes: { roleId: 'manager', domain: 'customers', level: 'view', expectedVersion: 0 } })],
    ['no expected version', AUTHORITY, mutation({ changes: { roleId: 'manager', domain: 'customers', level: 'view', expectedTenant: TENANT } })],
    ['an uppercase expected tenant', AUTHORITY, mutation({ changes: { roleId: 'manager', domain: 'customers', level: 'view', expectedTenant: TENANT.toUpperCase(), expectedVersion: 0 } })],
    ['a negative expected version', AUTHORITY, mutation({ changes: { roleId: 'manager', domain: 'customers', level: 'view', expectedTenant: TENANT, expectedVersion: -1 } })],
    ['an expected version as text', AUTHORITY, mutation({ changes: { roleId: 'manager', domain: 'customers', level: 'view', expectedTenant: TENANT, expectedVersion: '0' } })],
    ['an expected version whose successor is unsafe', AUTHORITY,
      mutation({ changes: { roleId: 'manager', domain: 'customers', level: 'view', expectedTenant: TENANT, expectedVersion: Number.MAX_SAFE_INTEGER } })],
  ] as const) {
    const r = recording([DERIVED]);
    assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(r.sql, m, authority as never), 'unavailable', label);
    assert.deepEqual(r.texts, [], `${label}: no statement`);
  }
});

// --- M5-INVOICES-AUTH-P1: the Invoices domain beside Customers -------------------------------------------------------------

test('the all-domain read admits exactly customers and invoices, each at a canonical level, and faults on any other domain or level', async () => {
  const both = await readRoleLevels(recording([{ levels: { customers: 'view', invoices: 'edit' } }]).sql as unknown as PgTransactionScope, TENANT, 'manager');
  assert.deepEqual(both, { customers: 'view', invoices: 'edit' });
  assert.ok(Object.isFrozen(both));
  assert.deepEqual(await readRoleLevels(recording([{ levels: { invoices: 'none' } }]).sql as unknown as PgTransactionScope, TENANT, 'manager'), { invoices: 'none' });
  for (const levels of [{ sales: 'view' }, { customers: 'view', refunds: 'full' }, { Invoices: 'view' }, { invoices: 'Full' }, { invoices: null }, { invoices: 3 }]) {
    await assert.rejects(readRoleLevels(recording([{ levels }]).sql as unknown as PgTransactionScope, TENANT, 'manager'), /role levels answer invalid/, JSON.stringify(levels));
  }
});

const INVOICE_DIRECTORY_TEXT = /^select tmpos_role_invoice\.m7a_invoice_role_level_states\(\?::uuid\) as states$/;

test('the directory read is one FIXED statement per domain — 021 for customers, 026 for invoices — validated identically; any other domain throws before a statement', async () => {
  const invoices = recording([statesRow(state('manager', 'edit', 4), state('technician'), state('sales_staff', 'none', 1))]);
  assert.deepEqual(await readRoleLevelDirectory(invoices.sql as unknown as PgTransactionScope, TENANT, 'invoices'), [
    { roleId: 'manager', stored: 'edit', version: 4 }, { roleId: 'technician', stored: null, version: 0 }, { roleId: 'sales_staff', stored: 'none', version: 1 }]);
  assert.equal(invoices.texts.length, 1);
  assert.match(invoices.texts[0], INVOICE_DIRECTORY_TEXT);
  assert.deepEqual(invoices.values, [[TENANT]], 'the trusted tenant alone — the domain is in the routine, never a value');
  const customers = recording([statesRow()]);
  await readRoleLevelDirectory(customers.sql as unknown as PgTransactionScope, TENANT, 'customers');
  assert.match(customers.texts[0], DIRECTORY_TEXT);
  for (const domain of ['sales', 'Invoices', 'invoice', '', null, undefined, 1, 'customers; select 1']) {
    const r = recording([statesRow()]);
    await assert.rejects(readRoleLevelDirectory(r.sql as unknown as PgTransactionScope, TENANT, domain as never), /role levels answer invalid/, String(domain));
    assert.deepEqual(r.texts, [], 'no statement');
  }
  for (const bad of [[], [statesRow(), statesRow()], [{ states: [state('technician'), state('manager'), state('sales_staff')] }], [{ states: [state('manager'), state('technician', 'Full'), state('sales_staff')] }],
    [{ states: [state('manager'), state('technician'), state('sales_staff', null, -1)] }], [{ states: null }]] as Array<readonly Record<string, unknown>[]>) {
    await assert.rejects(readRoleLevelDirectory(recording(bad).sql as unknown as PgTransactionScope, TENANT, 'invoices'), /role levels answer invalid/);
  }
});

test('the composed directory read binds its domain: the Invoices reader asks 026, the default reader 021', async () => {
  const texts: string[] = [];
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(_signal: AbortSignal, _bounds: TransactionBounds, work: (scope: PgTransactionScope) => Promise<T>): Promise<T> => {
      const r = recording([statesRow()]);
      const out = await work(r.sql as unknown as PgTransactionScope);
      texts.push(...r.texts);
      return out;
    },
    end: async (): Promise<void> => undefined,
  });
  const signal = new AbortController().signal;
  await createPostgresRoleLevelDirectory({ client }, 'invoices')(TENANT, signal);
  await createPostgresRoleLevelDirectory({ client }, 'customers')(TENANT, signal);
  await createPostgresRoleLevelDirectory({ client })(TENANT, signal);
  assert.match(texts[0], INVOICE_DIRECTORY_TEXT);
  assert.match(texts[1], DIRECTORY_TEXT);
  assert.match(texts[2], DIRECTORY_TEXT);
});

test('the mutator dispatches by domain to one fixed statement each: invoices into 026 (no domain parameter, five bound values), customers into 021 unchanged; judged identically; any other domain is unavailable before a statement', async () => {
  const invoicesChanges = { ...mutation().changes, domain: 'invoices' };
  const r = recording([DERIVED]);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(r.sql, mutation({ changes: invoicesChanges }), AUTHORITY), 'applied');
  assert.equal(r.texts.length, 2, 'the routine, then the recent sign-in judged again');
  assert.match(r.texts[0].replace(/\s+/g, ' '),
    /^select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version from tmpos_role_invoice\.m7a_invoice_role_level_set\(\?::text, \?::text, \?::text, \?::uuid, \?::bigint\)$/);
  assert.deepEqual(r.values[0], [SESSION_KEY, 'sales_staff', 'view', TENANT, String(EXPECTED_VERSION)], 'key, role, level, asserted tenant and version — the domain is hard-coded in the routine');
  assert.ok(!r.texts[0].includes('role_level_set_v2'), 'never the Customers routine');
  const customers = recording([DERIVED]);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(customers.sql, mutation(), AUTHORITY), 'applied');
  assert.match(customers.texts[0], /tmpos_role_edit\.m7a_role_level_set_v2/);
  assert.ok(!customers.texts[0].includes('tmpos_role_invoice'));
  // The same judgement per domain.
  const cases: Array<[string, readonly Record<string, unknown>[], string]> = [
    ['no row', [], 'refused'], ['two rows', [DERIVED, DERIVED], 'mismatch'], ['another tenant', [{ ...DERIVED, o_tenant_id: OTHER }], 'mismatch'],
    ['another actor', [{ ...DERIVED, o_actor_id: OTHER }], 'mismatch'], ['another grant', [{ ...DERIVED, o_membership_id: OTHER }], 'mismatch'],
    ['another level', [{ ...DERIVED, o_level: 'none' }], 'mismatch'], ['a wrong version', [{ ...DERIVED, o_version: String(EXPECTED_VERSION) }], 'mismatch'],
    ['a tenant mismatch', [REFUSED_AS('tenant_mismatch')], 'precondition_failed'], ['a version conflict', [REFUSED_AS('version_conflict')], 'precondition_failed'],
    ['a version conflict naming a level', [{ ...REFUSED_AS('version_conflict'), o_level: 'view' }], 'mismatch'],
  ];
  for (const [label, answer, expected] of cases) {
    assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(recording(answer).sql, mutation({ changes: invoicesChanges }), AUTHORITY), expected, label);
  }
  // The post-wait recent-auth recheck is the same for Invoices.
  const stale = recording([DERIVED], false);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(stale.sql, mutation({ changes: invoicesChanges }), AUTHORITY), 'refused');
  assert.ok(stale.texts[0].includes('m7a_invoice_role_level_set') && stale.texts[1].includes('clock_timestamp'));
  const failed = recording([REFUSED_AS('version_conflict')], false);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(failed.sql, mutation({ changes: invoicesChanges }), AUTHORITY), 'precondition_failed');
  assert.equal(failed.texts.length, 1, 'no clock for a failed precondition');
  // Unknown domains never reach a statement.
  for (const domain of ['sales', 'Invoices', '', 'customers,invoices', null, 7]) {
    const u = recording([DERIVED]);
    assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(u.sql, mutation({ changes: { ...mutation().changes, domain } }), AUTHORITY), 'unavailable', String(domain));
    assert.deepEqual(u.texts, [], 'no statement');
  }
});

// --- through the real store: every answer but 'applied' rolls the whole command back, precondition_failed included -------

const events = defineOutboxEvents([]);
const contract = defineCommands([ROLE_LEVEL_UPDATE_CONTRACT], events).contract(ROLE_LEVEL_UPDATE_CONTRACT.kind);
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);

/** The edit exactly as the runtime prepares it for an owner's tenant session: the planner's own plan, a deadline, the context. */
function prepared(): TransactionCommand {
  assert.ok(contract !== undefined);
  const id = randomUUID();
  const body = { roleId: 'sales_staff', domain: 'customers', level: 'view', reason: 'Sales staff no longer onboard customers.', expectedTenant: TENANT, expectedVersion: EXPECTED_VERSION };
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'owner' }), {
    method: 'PUT', path: '/api/v1/roles/levels', audience: 'tenant', tenant: TENANT, store: null, actor: ACTOR, body: Buffer.from(JSON.stringify(body)),
  });
  const plan = planRoleLevelUpdate({ audience: 'tenant', body, newAggregateId: id });
  const command = prepareCommand(contract, events, plan as never, {
    scope: operation.scope, lease: randomBytes(32).toString('base64url'), newAggregateId: id,
    authorization: Object.freeze({ scope: 'tenant', permission: 'edit_role_levels' }), context: CONTEXT, authNotAfter: Date.now() + 60_000, sessionKey: SESSION_KEY,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(command !== null);
  return command.command;
}

/**
 * A kernel that runs each transaction on a recording handle, noting COMMIT or ROLLBACK; 021's set routine answers `routine`,
 * the database-clock freshness select `fresh`.
 */
function kernel(routine: readonly Record<string, unknown>[], fresh = true) {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown> => {
    const text = strings.join('?');
    texts.push(text);
    values.push(v);
    if (text.includes('m6_command_fence')) return rows([{ held: true }]);
    if (text.includes('m7a_role_level_set')) return rows(routine);
    if (text.includes('clock_timestamp')) return rows([{ fresh }]);
    if (text.includes('insert into public.audit_event')) return Object.assign([], { count: 1, command: 'INSERT' });
    if (text.includes('m6_idempotency_complete')) return rows([{ outcome: 'completed' }]);
    throw new Error(`a statement this command never sends: ${text.slice(0, 80)}`);
  }, { json: (v: unknown) => v });
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(_signal: AbortSignal, _bounds: TransactionBounds, work: (scope: PgTransactionScope) => Promise<T>): Promise<T> => {
      try {
        const answer = await work(sql as unknown as PgTransactionScope);
        texts.push('commit');
        return answer;
      } catch (err) {
        texts.push('rollback');
        throw err;
      }
    },
    end: async (): Promise<void> => undefined,
  });
  return { client, texts, values };
}

test('through the tenant store: applied commits the edit, its audited reason and the completion; a refusal, a mismatch or a failed precondition rolls it all back — never a sealed 409, never a completion', async () => {
  const commit = (routine: readonly Record<string, unknown>[], fresh = true) => {
    const k = kernel(routine, fresh);
    const store = createPostgresTransactionalStore({ client: k.client, mutators: [ROLE_LEVEL_UPDATE_MUTATOR], contextScope: 'tenant', revalidate: async () => true });
    return Promise.resolve(store.transactions.commit(prepared(), new AbortController().signal)).then((answer) => ({ answer, texts: k.texts, values: k.values }));
  };
  const ok = await commit([DERIVED]);
  assert.deepEqual(ok.answer, { outcome: 'committed' });
  assert.deepEqual(ok.texts.map((t) => (t.includes('m6_command_fence') ? 'fence' : t.includes('m7a_role_level_set') ? '020'
    : t.includes('clock_timestamp') ? 'fresh' : t.includes('audit_event') ? 'audit' : t.includes('m6_idempotency_complete') ? 'completion' : t)),
    ['fence', '020', 'fresh', 'audit', 'completion', 'commit'], 'the recent sign-in judged again after the routine, before the audit record');
  const audit = JSON.stringify(ok.values[ok.texts.findIndex((t) => t.includes('audit_event'))]);
  for (const recorded of ['tenant.role.level.update', 'edit_role_levels', 'role_sales_staff_customers_to_view', 'Sales staff no longer onboard customers.']) {
    assert.ok(audit.includes(recorded), `the audit record carries ${recorded}`);
  }
  for (const [label, routine, fresh, outcome] of [['refused', [], true, 'unavailable'], ['another tenant', [{ ...DERIVED, o_tenant_id: OTHER }], true, 'unavailable'],
    ['another level', [{ ...DERIVED, o_level: 'full' }], true, 'unavailable'], ['a recent sign-in gone stale during the routine\'s wait', [DERIVED], false, 'unavailable'],
    ['another committed version', [{ ...DERIVED, o_version: '99' }], true, 'unavailable'],
    // M7A-CUSTOMERS-P4: a failed precondition is its own answer — the runtime's unsealed 409 — and records nothing either.
    ['a tenant mismatch', [REFUSED_AS('tenant_mismatch')], true, 'precondition_failed'],
    ['a version conflict', [REFUSED_AS('version_conflict')], true, 'precondition_failed']] as const) {
    const { answer, texts } = await commit(routine, fresh);
    assert.deepEqual(answer, { outcome }, label);
    assert.ok(!texts.some((t) => t.includes('audit_event') || t.includes('m6_idempotency_complete')), `${label}: no audit record and no completion`);
    assert.equal(texts.at(-1), 'rollback', `${label}: the edit rolled back with everything else`);
  }
});
