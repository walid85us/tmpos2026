// Phase 4.0 M7A-CUSTOMERS-P3 — the tenant customer create's mutator: the one fixed call it makes, the session key as its
// only authority input, the identities it requires the database to answer, and — through the real store over a recording
// kernel — that every answer but 'applied' rolls the whole command back instead of committing a sealed 409. No database:
// migration 019's routine itself is proved against a disposable cluster (tests/db/customerCreateRoutine.integration.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { CUSTOMER_CREATE_MUTATOR } from './postgresCustomerCreate.js';
import { createPostgresTransactionalStore } from './postgresTransactionalStore.js';
import type { MutationAuthority, PgRows, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import { defineCommands, prepareCommand } from '../runtime/commandTransaction.js';
import type { TransactionCommand, TransactionMutation } from '../runtime/commandTransaction.js';
import { CUSTOMER_CREATE_CONTRACT, planCustomerCreate } from '../runtime/customerCreate.js';
import { createIdempotencyKeyring } from '../runtime/idempotency.js';
import { TEST_IDEMPOTENCY_KEY } from '../runtime/idempotencyStore.testkit.js';
import { defineOutboxEvents } from '../runtime/outbox.js';
import type { TrustedScope } from '../runtime/principals.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '2a2a2a2a-2b2b-4c2c-8d2d-2e2e2e2e2e2e';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const SESSION_KEY = 'k'.repeat(21) + '_-' + 'K'.repeat(20);
const CUSTOMER = randomUUID();
const CONTEXT: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: TENANT, store: null, membershipId: MEMBERSHIP, roleId: 'sales_staff', limitation: 'none',
});
const AUTHORITY: MutationAuthority = Object.freeze({ context: CONTEXT, sessionKey: SESSION_KEY });
const DERIVED = Object.freeze({ o_tenant_id: TENANT, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP });

const rows = (list: readonly Record<string, unknown>[]): PgRows => Object.assign([...list], { count: list.length }) as unknown as PgRows;
/** A statement function that records its text and bound values and answers `answer` (or throws it). */
function recording(answer: readonly Record<string, unknown>[] | Error): { sql: PgStatement; texts: string[]; values: unknown[][] } {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...v: unknown[]) => {
    texts.push(strings.join('?'));
    values.push(v);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(rows(answer));
  }) as PgStatement;
  return { sql, texts, values };
}
const mutation = (over: Partial<TransactionMutation> = {}): TransactionMutation => Object.freeze({
  kind: CUSTOMER_CREATE_CONTRACT.kind, aggregateType: 'customer', aggregateId: CUSTOMER, expectedVersion: null, changes: { name: 'Ada Lovelace' }, ...over,
} as TransactionMutation);

test('the mutator registers for exactly the customer create contract, as a create of a customer, frozen', () => {
  assert.deepEqual(Object.keys(CUSTOMER_CREATE_MUTATOR).sort(), ['aggregateType', 'apply', 'kind', 'mode']);
  assert.deepEqual([CUSTOMER_CREATE_MUTATOR.kind, CUSTOMER_CREATE_MUTATOR.mode, CUSTOMER_CREATE_MUTATOR.aggregateType],
    ['tenant.customer.create', 'create', 'customer']);
  assert.ok(Object.isFrozen(CUSTOMER_CREATE_MUTATOR));
});

test('one fixed call into 019: the session key as the ONLY authority input, then the id and the name — never a tenant, actor or grant', async () => {
  const r = recording([DERIVED]);
  assert.equal(await CUSTOMER_CREATE_MUTATOR.apply(r.sql, mutation(), AUTHORITY), 'applied');
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /^select o_tenant_id, o_actor_id, o_membership_id\s+from tmpos_customer_write\.m7a_customer_create\(\?::text, \?::uuid, \?::text\)$/);
  assert.deepEqual(r.values, [[SESSION_KEY, CUSTOMER, 'Ada Lovelace']], 'three bound values: the key, the new id, the name');
  for (const identity of [TENANT, ACTOR, MEMBERSHIP, 'sales_staff']) assert.ok(!r.values[0].includes(identity), `${identity} is never passed in`);
  assert.doesNotMatch(r.texts[0], /tmpos_customer\.customer|insert|update|delete/i, 'no table and no write of its own');
});

test('applied only when the database answers exactly one row naming the revalidated tenant, actor AND grant; anything else is never a conflict', async () => {
  const cases: Array<[string, readonly Record<string, unknown>[], string]> = [
    ['no row: the routine refused the session\'s authority', [], 'refused'],
    ['two rows', [DERIVED, DERIVED], 'mismatch'],
    ['another tenant', [{ ...DERIVED, o_tenant_id: OTHER }], 'mismatch'],
    ['another actor', [{ ...DERIVED, o_actor_id: OTHER }], 'mismatch'],
    ['another grant', [{ ...DERIVED, o_membership_id: OTHER }], 'mismatch'],
    ['a null tenant', [{ ...DERIVED, o_tenant_id: null }], 'mismatch'],
    ['an upper-case spelling of the tenant', [{ ...DERIVED, o_tenant_id: TENANT.toUpperCase() }], 'mismatch'],
  ];
  for (const [label, answer, expected] of cases) {
    const outcome = await CUSTOMER_CREATE_MUTATOR.apply(recording(answer).sql, mutation(), AUTHORITY);
    assert.equal(outcome, expected, label);
    assert.notEqual(outcome, 'conflict', `${label}: never the sealed 409`);
  }
});

test('a driver or routine error propagates uncaught, and nothing is called without the revalidated tenant context, its key and a name', async () => {
  const fault = Object.assign(new Error('M7CC-UNIT-CANARY duplicate key'), { code: '23505' });
  await assert.rejects(CUSTOMER_CREATE_MUTATOR.apply(recording(fault).sql, mutation(), AUTHORITY), (err: unknown) => err === fault);
  for (const [label, authority, m] of [
    ['no authority at all', undefined, mutation()],
    ['a null context', { context: null, sessionKey: SESSION_KEY }, mutation()],
    ['a platform context', { context: { ...CONTEXT, scope: 'platform', tenant: null }, sessionKey: SESSION_KEY }, mutation()],
    ['no session key', { context: CONTEXT, sessionKey: null }, mutation()],
    ['a name that is not text', AUTHORITY, mutation({ changes: { name: 7 } })],
  ] as const) {
    const r = recording([DERIVED]);
    assert.equal(await CUSTOMER_CREATE_MUTATOR.apply(r.sql, m, authority as never), 'unavailable', label);
    assert.deepEqual(r.texts, [], `${label}: no statement`);
  }
});

// --- through the real store: every answer but 'applied' rolls the whole command back -------------------------------

const events = defineOutboxEvents([]);
const contract = defineCommands([CUSTOMER_CREATE_CONTRACT], events).contract(CUSTOMER_CREATE_CONTRACT.kind);
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);

/** The create exactly as the runtime prepares it for a tenant session: the planner's own plan, the new id, the context. */
function prepared(): TransactionCommand {
  assert.ok(contract !== undefined);
  const id = randomUUID();
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'POST', path: '/api/v1/customers', audience: 'tenant', tenant: TENANT, store: null, actor: ACTOR, body: Buffer.from('{"name":"Ada"}'),
  });
  const plan = planCustomerCreate({ audience: 'tenant', body: { name: ' Ada ' }, newAggregateId: id });
  const command = prepareCommand(contract, events, plan as never, {
    scope: operation.scope, lease: randomBytes(32).toString('base64url'), newAggregateId: id,
    authorization: Object.freeze({ scope: 'tenant', permission: 'create_customers' }), context: CONTEXT, authNotAfter: null, sessionKey: SESSION_KEY,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(command !== null);
  return command.command;
}

/** A kernel that runs each transaction on a recording handle, noting COMMIT or ROLLBACK; 019's routine answers `routine`. */
function kernel(routine: readonly Record<string, unknown>[]) {
  const texts: string[] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray): Promise<unknown> => {
    const text = strings.join('?');
    texts.push(text);
    if (text.includes('m6_command_fence')) return rows([{ held: true }]);
    if (text.includes('m7a_customer_create')) return rows(routine);
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
  return { client, texts };
}

test('through the tenant store: applied commits the create, its audit record and completion; a refusal or a mismatch rolls it all back — never a sealed 409', async () => {
  const commit = (routine: readonly Record<string, unknown>[]) => {
    const k = kernel(routine);
    const store = createPostgresTransactionalStore({ client: k.client, mutators: [CUSTOMER_CREATE_MUTATOR], contextScope: 'tenant', revalidate: async () => true });
    return Promise.resolve(store.transactions.commit(prepared(), new AbortController().signal)).then((answer) => ({ answer, texts: k.texts }));
  };
  const ok = await commit([DERIVED]);
  assert.deepEqual(ok.answer, { outcome: 'committed' });
  assert.deepEqual(ok.texts.map((t) => (t.includes('m6_command_fence') ? 'fence' : t.includes('m7a_customer_create') ? '019'
    : t.includes('audit_event') ? 'audit' : t.includes('m6_idempotency_complete') ? 'completion' : t)), ['fence', '019', 'audit', 'completion', 'commit']);
  for (const [label, routine] of [['refused', []], ['another tenant', [{ ...DERIVED, o_tenant_id: OTHER }]], ['two rows', [DERIVED, DERIVED]]] as const) {
    const { answer, texts } = await commit(routine);
    assert.deepEqual(answer, { outcome: 'unavailable' }, label);
    assert.ok(!texts.some((t) => t.includes('audit_event') || t.includes('m6_idempotency_complete')), `${label}: no audit record and no completion`);
    assert.equal(texts.at(-1), 'rollback', `${label}: the insert rolled back with everything else`);
  }
});
