// Phase 4.0 M7A-CUSTOMERS-P3-R1 — the tenant role levels: the read every tenant route decision makes (its one fixed call,
// the answer's shape, a fault never read as "no edits") and the role-level edit's mutator (its one fixed call on the session
// key alone, the identities and level it requires the database to answer, and — through the real store over a recording
// kernel — that every answer but 'applied' rolls the whole command back instead of committing a sealed 409). No database:
// migration 020's routines are proved against a disposable cluster (tests/db).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ROLE_LEVELS_BOUNDS, ROLE_LEVEL_UPDATE_MUTATOR, createPostgresRoleLevels, readRoleLevels } from './postgresRoleLevels.js';
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
const DERIVED = Object.freeze({ o_tenant_id: TENANT, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP, o_level: 'view' });

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
  changes: { roleId: 'sales_staff', domain: 'customers', level: 'view' }, ...over,
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

// --- the write -----------------------------------------------------------------------------------------------------------

test('the mutator registers for exactly the role-level edit contract, as a create of a tenant_role_level, frozen', () => {
  assert.deepEqual(Object.keys(ROLE_LEVEL_UPDATE_MUTATOR).sort(), ['aggregateType', 'apply', 'kind', 'mode']);
  assert.deepEqual([ROLE_LEVEL_UPDATE_MUTATOR.kind, ROLE_LEVEL_UPDATE_MUTATOR.mode, ROLE_LEVEL_UPDATE_MUTATOR.aggregateType],
    ['tenant.role.level.update', 'create', 'tenant_role_level']);
  assert.ok(Object.isFrozen(ROLE_LEVEL_UPDATE_MUTATOR));
});

test('one fixed call into 020: the session key as the ONLY authority input, then the role, the domain and the level — never a tenant, actor or grant', async () => {
  const r = recording([DERIVED]);
  assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(r.sql, mutation(), AUTHORITY), 'applied');
  assert.equal(r.texts.length, 2, 'the routine, then the recent sign-in judged again');
  assert.match(r.texts[0], /^select o_tenant_id, o_actor_id, o_membership_id, o_level\s+from tmpos_role\.m7a_role_level_set\(\?::text, \?::text, \?::text, \?::text\)$/);
  assert.deepEqual(r.values[0], [SESSION_KEY, 'sales_staff', 'customers', 'view'], 'four bound values: the key, the target role, the domain, the level');
  for (const identity of [TENANT, ACTOR, MEMBERSHIP, 'store_owner']) assert.ok(!r.values[0].includes(identity), `${identity} is never passed in`);
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
});

test('applied only when the database answers exactly one row naming the revalidated tenant, actor AND grant, at the level asked; anything else is never a conflict', async () => {
  const cases: Array<[string, readonly Record<string, unknown>[], string]> = [
    ['no row: the routine refused the session\'s authority', [], 'refused'],
    ['two rows', [DERIVED, DERIVED], 'mismatch'],
    ['another tenant', [{ ...DERIVED, o_tenant_id: OTHER }], 'mismatch'],
    ['another actor', [{ ...DERIVED, o_actor_id: OTHER }], 'mismatch'],
    ['another grant', [{ ...DERIVED, o_membership_id: OTHER }], 'mismatch'],
    ['another level stored', [{ ...DERIVED, o_level: 'none' }], 'mismatch'],
    ['a null level', [{ ...DERIVED, o_level: null }], 'mismatch'],
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
    ['no level', AUTHORITY, mutation({ changes: { roleId: 'manager', domain: 'customers' } })],
    ['a role that is not text', AUTHORITY, mutation({ changes: { roleId: 1, domain: 'customers', level: 'view' } })],
  ] as const) {
    const r = recording([DERIVED]);
    assert.equal(await ROLE_LEVEL_UPDATE_MUTATOR.apply(r.sql, m, authority as never), 'unavailable', label);
    assert.deepEqual(r.texts, [], `${label}: no statement`);
  }
});

// --- through the real store: every answer but 'applied' rolls the whole command back -------------------------------

const events = defineOutboxEvents([]);
const contract = defineCommands([ROLE_LEVEL_UPDATE_CONTRACT], events).contract(ROLE_LEVEL_UPDATE_CONTRACT.kind);
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);

/** The edit exactly as the runtime prepares it for an owner's tenant session: the planner's own plan, a deadline, the context. */
function prepared(): TransactionCommand {
  assert.ok(contract !== undefined);
  const id = randomUUID();
  const body = { roleId: 'sales_staff', domain: 'customers', level: 'view', reason: 'Sales staff no longer onboard customers.' };
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
 * A kernel that runs each transaction on a recording handle, noting COMMIT or ROLLBACK; 020's set routine answers `routine`,
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

test('through the tenant store: applied commits the edit, its audited reason and the completion; a refusal or a mismatch rolls it all back — never a sealed 409', async () => {
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
  for (const [label, routine, fresh] of [['refused', [], true], ['another tenant', [{ ...DERIVED, o_tenant_id: OTHER }], true],
    ['another level', [{ ...DERIVED, o_level: 'full' }], true], ['a recent sign-in gone stale during the routine\'s wait', [DERIVED], false]] as const) {
    const { answer, texts } = await commit(routine, fresh);
    assert.deepEqual(answer, { outcome: 'unavailable' }, label);
    assert.ok(!texts.some((t) => t.includes('audit_event') || t.includes('m6_idempotency_complete')), `${label}: no audit record and no completion`);
    assert.equal(texts.at(-1), 'rollback', `${label}: the edit rolled back with everything else`);
  }
});
