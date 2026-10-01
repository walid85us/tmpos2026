// Phase 4.0 M7A-CUSTOMERS-P7 — the tenant customer edit's mutator: the one fixed call it makes into migration 024's routine,
// the session key as its authority input beside the revalidated tenant as the expected one, the contact flags and NULLs it
// binds, the answers it maps (applied, unchanged, conflict, not_found) and every other answer it refuses — and, through the
// real store over a recording kernel, what each answer commits: the change with its audit record naming the customer, a
// sealed completion alone, or nothing at all. No database: migration 024's routine is proved against a disposable cluster
// (tests/db).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { CUSTOMER_UPDATE_MUTATOR } from './postgresCustomerUpdate.js';
import { createPostgresTransactionalStore } from './postgresTransactionalStore.js';
import type { MutationAuthority, PgRows, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import { defineCommands, prepareCommand } from '../runtime/commandTransaction.js';
import type { TransactionCommand, TransactionMutation } from '../runtime/commandTransaction.js';
import { CUSTOMER_UPDATE_CONTRACT, planCustomerUpdate } from '../runtime/customerUpdate.js';
import { createIdempotencyKeyring } from '../runtime/idempotency.js';
import { TEST_IDEMPOTENCY_KEY } from '../runtime/idempotencyStore.testkit.js';
import { defineOutboxEvents } from '../runtime/outbox.js';
import type { TrustedScope } from '../runtime/principals.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '2a2a2a2a-2b2b-4c2c-8d2d-2e2e2e2e2e2e';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const SESSION_KEY = 'k'.repeat(21) + '_-' + 'K'.repeat(20);
const CUSTOMER = '4d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
const CONTEXT: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: TENANT, store: null, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});
const AUTHORITY: MutationAuthority = Object.freeze({ context: CONTEXT, sessionKey: SESSION_KEY, authNotAfter: null });
const IDENTITY = Object.freeze({ o_tenant_id: TENANT, o_actor_id: ACTOR, o_membership_id: MEMBERSHIP });
const NULLS = Object.freeze({ o_tenant_id: null, o_actor_id: null, o_membership_id: null, o_version: null });
const applied = (version = '5') => ({ o_outcome: 'applied', ...IDENTITY, o_version: version });
const unchanged = (version = '4') => ({ o_outcome: 'unchanged', ...IDENTITY, o_version: version });

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
const CHANGES = Object.freeze({ name: 'Ada Lovelace', setPhone: false, phone: '', setEmail: false, email: '' });
const mutation = (over: Partial<TransactionMutation> = {}): TransactionMutation => Object.freeze({
  kind: CUSTOMER_UPDATE_CONTRACT.kind, aggregateType: 'customer', aggregateId: CUSTOMER, expectedVersion: 4, changes: CHANGES, ...over,
} as TransactionMutation);

test('the mutator registers for exactly the customer update contract, as an update of a customer, frozen', () => {
  assert.deepEqual(Object.keys(CUSTOMER_UPDATE_MUTATOR).sort(), ['aggregateType', 'apply', 'kind', 'mode']);
  assert.deepEqual([CUSTOMER_UPDATE_MUTATOR.kind, CUSTOMER_UPDATE_MUTATOR.mode, CUSTOMER_UPDATE_MUTATOR.aggregateType],
    ['tenant.customer.update', 'update', 'customer']);
  assert.ok(Object.isFrozen(CUSTOMER_UPDATE_MUTATOR));
});

test('one fixed call into 024: the session key, the id, the revalidated tenant as the expected one, the version as text, the name, and each contact as a flag and a value or NULL', async () => {
  const STATEMENT = /^select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_version\s+from tmpos_customer_edit\.m7a_customer_update\(\?::text, \?::uuid, \?::uuid,\s+\?::bigint, \?::text, \?::boolean, \?::text,\s+\?::boolean, \?::text\)$/;
  const r = recording([applied()]);
  assert.equal(await CUSTOMER_UPDATE_MUTATOR.apply(r.sql, mutation(), AUTHORITY), 'applied');
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], STATEMENT);
  assert.deepEqual(r.values, [[SESSION_KEY, CUSTOMER, TENANT, '4', 'Ada Lovelace', false, null, false, null]], 'neither contact written: both NULL with a false flag');
  for (const [label, changes, bound] of [
    ['both written', { ...CHANGES, setPhone: true, phone: '+1 555 0100', setEmail: true, email: 'ada@example.test' }, [true, '+1 555 0100', true, 'ada@example.test']],
    ['both cleared', { ...CHANGES, setPhone: true, phone: '', setEmail: true, email: '' }, [true, null, true, null]],
    ['the phone cleared, the email kept', { ...CHANGES, setPhone: true, phone: '' }, [true, null, false, null]],
    ['the email written, the phone kept', { ...CHANGES, setEmail: true, email: 'ada@example.test' }, [false, null, true, 'ada@example.test']],
  ] as const) {
    const each = recording([applied()]);
    assert.equal(await CUSTOMER_UPDATE_MUTATOR.apply(each.sql, mutation({ changes }), AUTHORITY), 'applied', label);
    assert.deepEqual(each.values[0].slice(5), bound, label);
  }
  const big = recording([applied(String(Number.MAX_SAFE_INTEGER))]);
  assert.equal(await CUSTOMER_UPDATE_MUTATOR.apply(big.sql, mutation({ expectedVersion: Number.MAX_SAFE_INTEGER - 1 }), AUTHORITY), 'applied',
    'the largest version a row reaches, compared as exact text');
  assert.equal(big.values[0][3], '9007199254740990');
  for (const identity of [ACTOR, MEMBERSHIP, 'manager']) assert.ok(!r.values[0].includes(identity), `${identity} is never passed in`);
  assert.doesNotMatch(r.texts[0], /tmpos_customer\.customer|insert|delete/i, 'no table and no write of its own');
});

test('the answers: applied and unchanged only with the revalidated identities at the exact version; conflict and not_found only with every other column null', async () => {
  const cases: Array<[string, readonly Record<string, unknown>[], string]> = [
    ['applied at expected + 1', [applied('5')], 'applied'],
    ['unchanged at expected', [unchanged('4')], 'unchanged'],
    ['a stale version', [{ o_outcome: 'conflict', ...NULLS }], 'conflict'],
    ['a missing or foreign customer', [{ o_outcome: 'not_found', ...NULLS }], 'not_found'],
    ['no row: the routine refused the session\'s authority, tenant or level', [], 'refused'],
    ['two rows', [applied(), applied()], 'mismatch'],
    ['applied at the expected version', [applied('4')], 'mismatch'],
    ['applied two ahead', [applied('6')], 'mismatch'],
    ['applied as a number', [{ ...applied(), o_version: 5 }], 'mismatch'],
    ['applied with no version', [{ ...applied(), o_version: null }], 'mismatch'],
    ['applied in another tenant', [{ ...applied(), o_tenant_id: OTHER }], 'mismatch'],
    ['applied by another actor', [{ ...applied(), o_actor_id: OTHER }], 'mismatch'],
    ['applied under another grant', [{ ...applied(), o_membership_id: OTHER }], 'mismatch'],
    ['unchanged at expected + 1', [unchanged('5')], 'mismatch'],
    ['unchanged in another tenant', [{ ...unchanged(), o_tenant_id: OTHER }], 'mismatch'],
    ['unchanged with no identity', [{ o_outcome: 'unchanged', ...NULLS, o_version: '4' }], 'mismatch'],
    ['a conflict naming a version', [{ o_outcome: 'conflict', ...NULLS, o_version: '5' }], 'mismatch'],
    ['a conflict naming the tenant', [{ o_outcome: 'conflict', ...NULLS, o_tenant_id: TENANT }], 'mismatch'],
    ['not_found naming the actor', [{ o_outcome: 'not_found', ...NULLS, o_actor_id: ACTOR }], 'mismatch'],
    ['an invalid_state', [{ o_outcome: 'invalid_state', ...NULLS }], 'mismatch'],
    ['an unknown outcome', [{ o_outcome: 'Applied', ...IDENTITY, o_version: '5' }], 'mismatch'],
    ['a null outcome', [{ o_outcome: null, ...NULLS }], 'mismatch'],
  ];
  for (const [label, answer, expected] of cases) {
    assert.equal(await CUSTOMER_UPDATE_MUTATOR.apply(recording(answer).sql, mutation(), AUTHORITY), expected, label);
  }
});

test('a routine raise (22023 for a refused value, a lock timeout) propagates uncaught; nothing is called without the tenant context, its key or a well-formed change set', async () => {
  for (const code of ['22023', '23514', '55P03']) {
    const fault = Object.assign(new Error(`M7CU-UNIT-CANARY ${code}`), { code });
    await assert.rejects(CUSTOMER_UPDATE_MUTATOR.apply(recording(fault).sql, mutation(), AUTHORITY), (err: unknown) => err === fault, code);
  }
  for (const [label, authority, m] of [
    ['no authority at all', undefined, mutation()],
    ['a null context', { context: null, sessionKey: SESSION_KEY }, mutation()],
    ['a platform context', { context: { ...CONTEXT, scope: 'platform', tenant: null }, sessionKey: SESSION_KEY }, mutation()],
    ['a tenant context with no tenant', { context: { ...CONTEXT, tenant: null }, sessionKey: SESSION_KEY }, mutation()],
    ['no session key', { context: CONTEXT, sessionKey: null }, mutation()],
    ['no expected version', AUTHORITY, mutation({ expectedVersion: null })],
    ['version 0', AUTHORITY, mutation({ expectedVersion: 0 })],
    ['a fractional version', AUTHORITY, mutation({ expectedVersion: 1.5 })],
    ['version 2^53-1 (its successor would not be exact)', AUTHORITY, mutation({ expectedVersion: Number.MAX_SAFE_INTEGER })],
    ['a version past 2^53-1', AUTHORITY, mutation({ expectedVersion: Number.MAX_SAFE_INTEGER + 1 })],
    ['a negative version', AUTHORITY, mutation({ expectedVersion: -4 })],
    ['a name that is not text', AUTHORITY, mutation({ changes: { ...CHANGES, name: 7 } })],
    ['a flag that is not boolean', AUTHORITY, mutation({ changes: { ...CHANGES, setPhone: 'true' } })],
    ['no email flag', AUTHORITY, mutation({ changes: { name: 'Ada', setPhone: false, phone: '', email: '' } })],
    ['a null phone', AUTHORITY, mutation({ changes: { ...CHANGES, phone: null } })],
    ['a phone beside a false flag', AUTHORITY, mutation({ changes: { ...CHANGES, phone: '+1 555 0100' } })],
    ['an email beside a false flag', AUTHORITY, mutation({ changes: { ...CHANGES, email: 'ada@example.test' } })],
  ] as const) {
    const r = recording([applied()]);
    assert.equal(await CUSTOMER_UPDATE_MUTATOR.apply(r.sql, m as TransactionMutation, authority as never), 'unavailable', label);
    assert.deepEqual(r.texts, [], `${label}: no statement`);
  }
});

// --- through the real store: what each answer commits ---------------------------------------------------------------------

const events = defineOutboxEvents([]);
const contract = defineCommands([CUSTOMER_UPDATE_CONTRACT], events).contract(CUSTOMER_UPDATE_CONTRACT.kind);
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);

/** The edit exactly as the runtime prepares it for a tenant session: the planner's own plan over the path's target. */
function prepared(): TransactionCommand {
  assert.ok(contract !== undefined);
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'PATCH', path: '/api/v1/customers/{id}', audience: 'tenant', tenant: TENANT, store: null, actor: ACTOR,
    body: Buffer.from('{"expectedVersion":4,"name":"Ada Lovelace"}'), target: CUSTOMER,
  });
  const plan = planCustomerUpdate({ audience: 'tenant', body: { expectedVersion: 4, name: 'Ada Lovelace' }, newAggregateId: randomUUID(), targetId: CUSTOMER });
  const command = prepareCommand(contract, events, plan as never, {
    scope: operation.scope, lease: randomBytes(32).toString('base64url'), newAggregateId: randomUUID(),
    authorization: Object.freeze({ scope: 'tenant', permission: 'edit_customers' }), context: CONTEXT, authNotAfter: null, sessionKey: SESSION_KEY,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(command !== null);
  return command.command;
}

/** A kernel that runs each transaction on a recording handle, noting COMMIT or ROLLBACK; 024's routine answers `routine`. */
function kernel(routine: readonly Record<string, unknown>[] | Error, after: { audit?: unknown; completion?: unknown } = {}) {
  const texts: string[] = [];
  const values: unknown[][] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown> => {
    const text = strings.join('?');
    texts.push(text);
    values.push(v);
    if (text.includes('m6_command_fence')) return rows([{ held: true }]);
    if (text.includes('m7a_customer_update')) {
      if (routine instanceof Error) throw routine;
      return rows(routine);
    }
    if (text.includes('insert into public.audit_event')) {
      if (after.audit instanceof Error) throw after.audit;
      return after.audit ?? Object.assign([], { count: 1, command: 'INSERT' });
    }
    if (text.includes('m6_idempotency_complete')) {
      if (after.completion instanceof Error) throw after.completion;
      return after.completion ?? rows([{ outcome: 'completed' }]);
    }
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

test('through the tenant store: applied commits the change, an audit record naming the customer, and the completion; unchanged and conflict commit their sealed completion alone; anything else rolls back', async () => {
  const commit = (routine: readonly Record<string, unknown>[] | Error) => {
    const k = kernel(routine);
    const store = createPostgresTransactionalStore({ client: k.client, mutators: [CUSTOMER_UPDATE_MUTATOR], contextScope: 'tenant', revalidate: async () => true });
    return Promise.resolve(store.transactions.commit(prepared(), new AbortController().signal)).then((answer) => ({ answer, ...k }));
  };
  const step = (t: string): string => (t.includes('m6_command_fence') ? 'fence' : t.includes('m7a_customer_update') ? '024'
    : t.includes('audit_event') ? 'audit' : t.includes('m6_idempotency_complete') ? 'completion' : t);
  const ok = await commit([applied()]);
  assert.deepEqual(ok.answer, { outcome: 'committed' });
  assert.deepEqual(ok.texts.map(step), ['fence', '024', 'audit', 'completion', 'commit']);
  const audit = ok.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(ok.texts[audit].includes('subject_customer_id') && !ok.texts[audit].includes('subject_tenant_id'), 'the customer is the record\'s subject');
  assert.equal(ok.values[audit].at(-1), CUSTOMER);
  assert.ok(!ok.values[audit].includes('Ada Lovelace'), 'no name in the audit record');
  for (const [label, routine, outcome] of [
    ['unchanged', [unchanged()], 'unchanged'],
    ['a stale version', [{ o_outcome: 'conflict', ...NULLS }], 'conflict'],
  ] as const) {
    const { answer, texts } = await commit(routine);
    assert.deepEqual(answer, { outcome }, label);
    assert.deepEqual(texts.map(step), ['fence', '024', 'completion', 'commit'], `${label}: its sealed completion alone — no audit record`);
  }
  for (const [label, routine, outcome] of [
    ['not found', [{ o_outcome: 'not_found', ...NULLS }], 'not_found'],
    ['refused', [], 'unavailable'],
    ['another tenant', [{ ...applied(), o_tenant_id: OTHER }], 'unavailable'],
    ['a refused value (22023)', Object.assign(new Error('M7CU-UNIT-CANARY'), { code: '22023' }), 'unavailable'],
  ] as const) {
    const { answer, texts } = await commit(routine as never);
    assert.deepEqual(answer, { outcome }, label);
    assert.ok(!texts.some((t) => t.includes('audit_event') || t.includes('m6_idempotency_complete')), `${label}: no audit record and no completion`);
    assert.equal(texts.at(-1), 'rollback', `${label}: rolled back`);
  }
});

test('through the tenant store: after 024 answered applied, an audit insert that throws or writes no row, or a completion that throws or is refused, rolls everything back — never a commit, never reported applied', async () => {
  for (const [label, after] of [
    ['the audit insert throws', { audit: Object.assign(new Error('M7CU-UNIT-CANARY audit'), { code: '42501' }) }],
    ['the audit insert writes no row', { audit: Object.assign([], { count: 0, command: 'INSERT' }) }],
    ['the completion throws', { completion: Object.assign(new Error('M7CU-UNIT-CANARY completion'), { code: '57014' }) }],
    ['the completion is refused (the lease moved)', { completion: rows([{ outcome: 'lease_lost' }]) }],
    ['the completion answers nothing', { completion: rows([]) }],
  ] as const) {
    const k = kernel([applied()], after);
    const store = createPostgresTransactionalStore({ client: k.client, mutators: [CUSTOMER_UPDATE_MUTATOR], contextScope: 'tenant', revalidate: async () => true });
    const answer = await store.transactions.commit(prepared(), new AbortController().signal) as { outcome: string };
    assert.notEqual(answer.outcome, 'committed', label);
    assert.ok(['unavailable', 'lease_lost'].includes(answer.outcome), `${label}: ${answer.outcome} — the runtime's 503, nothing applied`);
    assert.ok(k.texts.some((t) => t.includes('m7a_customer_update')), `${label}: 024 had answered applied`);
    assert.ok(!k.texts.includes('commit'), `${label}: never a COMMIT`);
    assert.equal(k.texts.at(-1), 'rollback', `${label}: the change, the audit record and the completion rolled back together`);
  }
});
