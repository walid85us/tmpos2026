// Phase 4.0 M7A-CUSTOMERS-P1 — the PostgreSQL customer directory adapter: what it hands the database's routine, and
// what it refuses to read back as a page. DATABASE-FREE; the routine itself is proved against a real cluster.
// M7A-CUSTOMERS-P2: the routine is migration 018's session-bound read, handed the presenting session's store key — since
// M7A-CUSTOMERS-P3-R1 migration 020's page_v3, which adds the role's current Customers level to 018's derivation.
// M7A-CUSTOMERS-P6: the profile read over migration 023's m7a_contact_profile (M7CPP-01..04).
// M7A-CUSTOMERS-P7: the profile read is now migration 024's versioned m7a_customer_profile (o_version, M7CPP-05).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOMER_DIRECTORY_BOUNDS, CUSTOMER_DIRECTORY_DEADLINE_MS, createPostgresCustomerDetail, createPostgresCustomerDirectory,
  createPostgresCustomerProfile, probeCustomerDetail, probeCustomerDirectory, probeCustomerProfile,
} from './postgresCustomerDirectory.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import type { TrustedScope } from '../runtime/principals.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const STORE = '33333333-3333-4333-8333-333333333333';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
/** A synthetic store key: the shape of a SHA-256 digest in unpadded base64url. */
const SESSION_KEY = 'k'.repeat(43);
const C = (i: number): string => `c000000${i}-0000-4000-8000-00000000000${i}`;
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'a'.repeat(64), scope: 'tenant', tenant: TENANT, store: null, membershipId: MEMBERSHIP, roleId: 'technician', limitation: 'read_only',
});

const customerRow = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ o_outcome: 'customer', o_tenant_id: TENANT, o_customer_id: C(i), o_name: `Customer ${i}`, ...over });
const refusalRow = (outcome: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ o_outcome: outcome, o_tenant_id: null, o_customer_id: null, o_name: null, ...over });

interface Fake extends SupervisedPgClient {
  readonly statements: string[];
  readonly values: unknown[][];
  readonly bounds: unknown[];
  readonly signals: unknown[];
}

function fakeClient(rows: unknown, fault?: Error): Fake {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const bounds: unknown[] = [];
  const signals: unknown[] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    return fault ? Promise.reject(fault) : Promise.resolve(rows as never);
  }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements, values, bounds, signals,
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      bounds.push(b);
      signals.push(signal);
      return work(sql);
    }) as never,
    end: async () => undefined,
  }) as never;
}

const live = (): AbortSignal => new AbortController().signal;

test('one fixed call to migration 020\'s session-bound routine: the session\'s store key, the continuation and one row more than the page', async () => {
  const client = fakeClient([customerRow(1), customerRow(2)]);
  const signal = live();
  const answer = await createPostgresCustomerDirectory({ client }).page(SCOPE, SESSION_KEY, { after: C(9), limit: 2 }, signal);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], /select o_outcome, o_tenant_id, o_customer_id, o_name\s+from tmpos_role\.m7a_customer_page_v3\(\?::text, \?::uuid, \?::integer\)$/);
  assert.deepEqual(client.values[0], [SESSION_KEY, C(9), 3], 'the session key, after, limit + 1 — in that order');
  // The routine derives the authority from the session itself: no fact of the scope is a parameter.
  for (const fact of [ACTOR, 'a'.repeat(64), MEMBERSHIP, 'technician', TENANT]) assert.ok(!client.values[0].includes(fact), `${fact} is not sent`);
  assert.ok(!client.statements[0].includes('tmpos_customer'), 'migration 017\'s page is never called directly');
  assert.equal(client.bounds.length, 1);
  assert.equal(client.bounds[0], CUSTOMER_DIRECTORY_BOUNDS, 'the adapter\'s own bounds');
  assert.deepEqual(CUSTOMER_DIRECTORY_BOUNDS, { lock: '2100ms', statement: '2700ms', idle: '6000ms' });
  assert.ok(Object.isFrozen(CUSTOMER_DIRECTORY_BOUNDS));
  assert.equal(CUSTOMER_DIRECTORY_DEADLINE_MS, 3_000);
  assert.equal(client.signals[0], signal, 'the route\'s deadline signal reaches the kernel');
  assert.deepEqual(answer, { outcome: 'page', hasMore: false, customers: [{ id: C(1), name: 'Customer 1' }, { id: C(2), name: 'Customer 2' }] });
  // The rows are checked against the AUTHORIZER's tenant, never a constant: rows naming the scope's tenant are its page.
  const other = fakeClient([customerRow(1, { o_tenant_id: OTHER_TENANT })]);
  assert.deepEqual(await createPostgresCustomerDirectory({ client: other }).page({ ...SCOPE, tenant: OTHER_TENANT }, SESSION_KEY, { after: null, limit: 100 }, live()),
    { outcome: 'page', hasMore: false, customers: [{ id: C(1), name: 'Customer 1' }] }, 'rows naming the scope\'s tenant are that tenant\'s page');
  assert.deepEqual(other.values[0], [SESSION_KEY, null, 101], 'no continuation is SQL null; limit 100 asks 101');
});

test('the lookahead row says another page follows and is never returned; exactly the limit is the last page; an empty directory is an empty page', async () => {
  const read = (rows: unknown[], limit: number) => createPostgresCustomerDirectory({ client: fakeClient(rows) }).page(SCOPE, SESSION_KEY, { after: null, limit }, live());
  assert.deepEqual(await read([customerRow(1), customerRow(2), customerRow(3)], 2),
    { outcome: 'page', hasMore: true, customers: [{ id: C(1), name: 'Customer 1' }, { id: C(2), name: 'Customer 2' }] });
  assert.deepEqual(await read([customerRow(1), customerRow(2)], 2),
    { outcome: 'page', hasMore: false, customers: [{ id: C(1), name: 'Customer 1' }, { id: C(2), name: 'Customer 2' }] });
  assert.deepEqual(await read([customerRow(1)], 1), { outcome: 'page', hasMore: false, customers: [{ id: C(1), name: 'Customer 1' }] });
  assert.deepEqual(await read([customerRow(1), customerRow(2)], 1), { outcome: 'page', hasMore: true, customers: [{ id: C(1), name: 'Customer 1' }] });
  assert.deepEqual(await read([], 50), { outcome: 'page', customers: [], hasMore: false });
  // Only id and name leave the adapter, as copies of the row's two values.
  const page = await read([customerRow(1)], 5) as { customers: object[] };
  assert.deepEqual(Object.keys(page.customers[0]), ['id', 'name']);
});

test('denied and cursor_unknown are the routine\'s only row, with every other column null', async () => {
  for (const outcome of ['denied', 'cursor_unknown']) {
    assert.deepEqual(await createPostgresCustomerDirectory({ client: fakeClient([refusalRow(outcome)]) }).page(SCOPE, SESSION_KEY, { after: C(1), limit: 5 }, live()), { outcome });
  }
});

test('everything out of shape is a throw — an outage the route answers as a 503 — never a page and never a refusal', async () => {
  const cases: Array<[string, unknown]> = [
    ['not an array', { rows: [] }],
    ['null', null],
    ['a refusal beside a customer', [refusalRow('denied'), customerRow(1)]],
    ['a customer beside a refusal', [customerRow(1), refusalRow('denied')]],
    ['cursor_unknown beside a customer', [customerRow(1), refusalRow('cursor_unknown')]],
    ['two refusals', [refusalRow('denied'), refusalRow('denied')]],
    ['invalid, the malformed-argument answer', [refusalRow('invalid')]],
    ['an unknown outcome', [refusalRow('granted')]],
    ['a capitalised outcome', [refusalRow('Denied')]],
    ['a null outcome', [refusalRow(null as never)]],
    ['a refusal carrying a customer id', [refusalRow('denied', { o_customer_id: C(1) })]],
    ['a refusal carrying a name', [refusalRow('cursor_unknown', { o_name: 'Customer 1' })]],
    ['a refusal carrying an empty name', [refusalRow('denied', { o_name: '' })]],
    ['a refusal naming the tenant', [refusalRow('denied', { o_tenant_id: TENANT })]],
    ['a cursor_unknown naming the tenant', [refusalRow('cursor_unknown', { o_tenant_id: TENANT })]],
    ['a row naming another tenant', [customerRow(1, { o_tenant_id: OTHER_TENANT })]],
    ['a second row naming another tenant', [customerRow(1), customerRow(2, { o_tenant_id: OTHER_TENANT })]],
    ['only the lookahead row naming another tenant', [customerRow(1), customerRow(2), customerRow(3, { o_tenant_id: OTHER_TENANT })]],
    ['a row with a null tenant', [customerRow(1, { o_tenant_id: null })]],
    ['a row with an uppercase tenant', [customerRow(1, { o_tenant_id: TENANT.toUpperCase().replace(/2/g, 'A') })]],
    ['a row missing its tenant', [{ o_outcome: 'customer', o_customer_id: C(1), o_name: 'x' }]],
    ['a missing column', [{ o_outcome: 'customer', o_tenant_id: TENANT, o_customer_id: C(1) }]],
    ['an extra column', [{ ...customerRow(1), o_email: 'a@b.test' }]],
    ['a renamed column', [{ o_outcome: 'customer', o_tenant_id: TENANT, o_customer_id: C(1), name: 'x' }]],
    ['an extra column on a refusal', [{ ...refusalRow('denied'), o_store_id: null }]],
    ['the three-column row of the earlier contract', [{ o_outcome: 'customer', o_customer_id: C(1), o_name: 'x' }]],
    ['an uppercase id', [customerRow(1, { o_customer_id: C(1).toUpperCase() })]],
    ['a non-UUID id', [customerRow(1, { o_customer_id: 'customer-1' })]],
    ['a null id', [customerRow(1, { o_customer_id: null })]],
    ['a numeric name', [customerRow(1, { o_name: 5 })]],
    ['a null name', [customerRow(1, { o_name: null })]],
    ['more rows than limit + 1', [customerRow(1), customerRow(2), customerRow(3), customerRow(4)]],
    ['a malformed lookahead row', [customerRow(1), customerRow(2), refusalRow('denied')]],
    ['a lookahead row with a null id', [customerRow(1), customerRow(2), customerRow(3, { o_customer_id: null })]],
    ['a lookahead row with a non-string name', [customerRow(1), customerRow(2), customerRow(3, { o_name: 3 })]],
    ['a lookahead row repeating a customer', [customerRow(1), customerRow(2), customerRow(2)]],
    ['a lookahead row with a 201-character name', [customerRow(1), customerRow(2), customerRow(3, { o_name: 'Z'.repeat(201) })]],
    ['a lookahead row with a lone surrogate', [customerRow(1), customerRow(2), customerRow(3, { o_name: 'Z\uD800' })]],
    ['a lookahead row with an empty name', [customerRow(1), customerRow(2), customerRow(3, { o_name: '' })]],
    ['a repeated customer', [customerRow(1), customerRow(1)]],
    ['a repeated customer under another name', [customerRow(1), customerRow(1, { o_name: 'Other' })]],
    ['a row that is not an object', ['customer']],
    ['a null row', [null]],
  ];
  for (const [label, rows] of cases) {
    await assert.rejects(createPostgresCustomerDirectory({ client: fakeClient(rows) }).page(SCOPE, SESSION_KEY, { after: null, limit: 2 }, live()) as Promise<unknown>,
      (err: unknown) => err instanceof Error && err.message === 'customer directory answer invalid', label);
  }
  // A driver error propagates as the outage it is; its text is the route's to discard.
  await assert.rejects(createPostgresCustomerDirectory({ client: fakeClient([], new Error('driver')) }).page(SCOPE, SESSION_KEY, { after: null, limit: 2 }, live()) as Promise<unknown>, /driver/);
});

test('every row, the lookahead included, must be in the routine\'s order — a page ordered on its own is not enough', async () => {
  const read = (rows: unknown[]) => createPostgresCustomerDirectory({ client: fakeClient(rows) }).page(SCOPE, SESSION_KEY, { after: null, limit: 2 }, live()) as Promise<unknown>;
  const named = (i: number, name: string) => customerRow(i, { o_name: name });
  const invalid = (err: unknown) => err instanceof Error && err.message === 'customer directory answer invalid';
  // Amy, Zoe is an ordered page of two; only the lookahead, Bob, is out of order — and the route never sees the lookahead.
  await assert.rejects(read([named(1, 'Amy'), named(2, 'Zoe'), named(3, 'Bob')]), invalid, 'a lookahead sorting before the last row');
  // The lookahead repeats the last row's name with a LOWER id.
  await assert.rejects(read([named(1, 'Amy'), named(3, 'Zoe'), named(2, 'Zoe')]), invalid, 'same name as the last row, lower id');
  await assert.rejects(read([named(2, 'Zoe'), named(1, 'Amy')]), invalid, 'the page itself out of order');
  await assert.rejects(read([named(1, 'alice'), named(2, 'Zed')]), invalid, 'locale order, not byte order');
  // In order, the lookahead is read, checked and dropped.
  assert.deepEqual(await read([named(1, 'Amy'), named(2, 'Zoe'), named(3, 'Zoe')]),
    { outcome: 'page', hasMore: true, customers: [{ id: C(1), name: 'Amy' }, { id: C(2), name: 'Zoe' }] }, 'an in-order lookahead (equal name, higher id)');
  assert.deepEqual(await read([named(1, 'Amy'), named(2, 'Bob'), named(3, 'Zoe')]),
    { outcome: 'page', hasMore: true, customers: [{ id: C(1), name: 'Amy' }, { id: C(2), name: 'Bob' }] }, 'an in-order lookahead');
  assert.deepEqual(await read([named(1, 'Zed'), named(2, 'alice'), named(3, 'Émile')]),
    { outcome: 'page', hasMore: true, customers: [{ id: C(1), name: 'Zed' }, { id: C(2), name: 'alice' }] }, 'byte order');
});

test('an answer longer than limit + 1 is refused before any row is read', async () => {
  let reads = 0;
  // limit + 2 elements, each of which throws a distinct error if read: only the length may be consulted.
  const trap = (): unknown[] => new Proxy(new Array(4).fill(null), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) { reads += 1; throw new Error('row read'); }
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(createPostgresCustomerDirectory({ client: fakeClient(trap()) }).page(SCOPE, SESSION_KEY, { after: null, limit: 2 }, live()) as Promise<unknown>,
    (err: unknown) => err instanceof Error && err.message === 'customer directory answer invalid');
  assert.equal(reads, 0, 'no row was read');
  // Control: the same trap at limit + 1 is read, so the refusal above is the bound and not the trap.
  await assert.rejects(createPostgresCustomerDirectory({ client: fakeClient(trap()) }).page(SCOPE, SESSION_KEY, { after: null, limit: 3 }, live()) as Promise<unknown>, /row read/);
  assert.ok(reads > 0, 'at limit + 1 the rows are read (control)');
});

test('only the tenant scope the authorizer selected is an authority, and only a validated query reaches the database', async () => {
  const q = { after: null, limit: 2 };
  const bad: Array<[string, unknown, unknown]> = [
    ['a platform scope', { ...SCOPE, scope: 'platform', tenant: null }, q],
    ['a store scope', { ...SCOPE, scope: 'store', store: STORE }, q],
    ['a tenant scope with no tenant', { ...SCOPE, tenant: null }, q],
    ['a non-UUID tenant', { ...SCOPE, tenant: 'tenant-1' }, q],
    // The runtime's scope guard reads UUIDs case-insensitively; this adapter asks for the canonical lowercase form.
    ['an uppercase tenant', { ...SCOPE, tenant: TENANT.replace(/2/g, 'A').toUpperCase() }, q],
    ['a malformed scope', { ...SCOPE, actor: 'nobody' }, q],
    ['an unknown limitation', { ...SCOPE, limitation: 'readonly' }, q],
    ['no scope', null, q],
    ['limit 0', SCOPE, { after: null, limit: 0 }],
    ['limit 101', SCOPE, { after: null, limit: 101 }],
    ['a fractional limit', SCOPE, { after: null, limit: 1.5 }],
    ['a NaN limit', SCOPE, { after: null, limit: Number.NaN }],
    ['a limit as text', SCOPE, { after: null, limit: '5' }],
    ['a malformed continuation', SCOPE, { after: 'x', limit: 2 }],
    ['an uppercase continuation', SCOPE, { after: C(1).toUpperCase(), limit: 2 }],
    ['a numeric continuation', SCOPE, { after: 7, limit: 2 }],
  ];
  for (const [label, scope, query] of bad) {
    const client = fakeClient([]);
    await assert.rejects(createPostgresCustomerDirectory({ client }).page(scope as TrustedScope, SESSION_KEY, query as never, live()) as Promise<unknown>, /answer invalid/, label);
    assert.equal(client.statements.length, 0, `${label}: nothing reached the database`);
    assert.equal(client.bounds.length, 0, `${label}: no transaction was opened`);
  }
});

test('only a key of the store-key shape names a session: an absent or malformed key faults before any statement', async () => {
  const q = { after: null, limit: 2 };
  const bad: Array<[string, unknown]> = [
    ['no key', null], ['undefined', undefined], ['an empty key', ''], ['42 characters', 'k'.repeat(42)], ['44 characters', 'k'.repeat(44)],
    ['padding', `${'k'.repeat(42)}=`], ['a standard base64 character', `${'k'.repeat(42)}+`], ['a space', `${'k'.repeat(42)} `],
    ['a number', 7], ['an object', { key: SESSION_KEY }],
  ];
  for (const [label, key] of bad) {
    const client = fakeClient([customerRow(1)]);
    await assert.rejects(createPostgresCustomerDirectory({ client }).page(SCOPE, key as string, q, live()) as Promise<unknown>,
      (err: unknown) => err instanceof Error && err.message === 'customer directory answer invalid', label);
    assert.equal(client.statements.length, 0, `${label}: nothing reached the database`);
    assert.equal(client.bounds.length, 0, `${label}: no transaction was opened`);
  }
});

test('M7TP-01 probeCustomerDirectory: true only for the routine\'s one refusal of a random key, asked once under the adapter\'s bounds', async () => {
  // M7A-CUSTOMERS-P2 (the tenant entry's readiness): the routine (020's page_v3, as 018's before it) refuses an unknown key
  // before any other read (DA-108).
  const client = fakeClient([refusalRow('denied')]);
  const signal = live();
  assert.equal(await probeCustomerDirectory(client, signal), true);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], /select o_outcome, o_tenant_id, o_customer_id, o_name\s+from tmpos_role\.m7a_customer_page_v3\(\?::text, null::uuid, 1::integer\)$/);
  assert.equal(client.values[0].length, 1, 'the key alone is bound');
  assert.match(client.values[0][0] as string, /^[A-Za-z0-9_-]{43}$/, 'a store-key-shaped key');
  assert.equal(client.bounds[0], CUSTOMER_DIRECTORY_BOUNDS);
  assert.equal(client.signals[0], signal);
  await probeCustomerDirectory(client, live());
  assert.notEqual(client.values[1][0], client.values[0][0], 'a fresh random key per call');
});

test('M7TP-02 probeCustomerDirectory: any other answer, a fault or an abort is false — never a throw, never a page', async () => {
  const cases: Array<[string, unknown]> = [
    ['no row', []],
    ['two refusals', [refusalRow('denied'), refusalRow('denied')]],
    ['a customer row', [customerRow(1)]],
    ['cursor_unknown', [refusalRow('cursor_unknown')]],
    ['a refusal naming a tenant', [refusalRow('denied', { o_tenant_id: TENANT })]],
    ['a refusal naming a customer', [refusalRow('denied', { o_customer_id: C(1) })]],
    ['a refusal naming a name', [refusalRow('denied', { o_name: 'x' })]],
    ['an extra column', [{ ...refusalRow('denied'), extra: 1 }]],
    ['not rows', { rows: 1 }],
  ];
  for (const [label, rows] of cases) assert.equal(await probeCustomerDirectory(fakeClient(rows), live()), false, label);
  assert.equal(await probeCustomerDirectory(fakeClient(null, Object.assign(new Error('M7TP-CANARY'), { code: '42501' })), live()), false, 'a driver error');
  const aborted = new AbortController();
  aborted.abort();
  const idle = fakeClient([refusalRow('denied')]);
  assert.equal(await probeCustomerDirectory(idle, aborted.signal), false, 'an aborted probe');
  assert.equal(idle.statements.length, 0, 'sends nothing once aborted');
});

// --- the detail read (M7A-CUSTOMERS-P4): migration 022's m7a_customer_get ------------------------------------------------

const DETAIL_STATEMENT = /select o_outcome, o_tenant_id, o_customer_id, o_name\s+from tmpos_customer_detail\.m7a_customer_get\(\?::text, \?::uuid, \?::uuid\)$/;
const getOne = (rows: unknown, id = C(1), scope: TrustedScope = SCOPE, key: unknown = SESSION_KEY) => {
  const client = fakeClient(rows);
  return { client, answer: createPostgresCustomerDetail({ client }).get(scope, key as string, id, live()) as Promise<unknown> };
};
const faults = (p: Promise<unknown>, label: string) =>
  assert.rejects(p, (err: unknown) => err instanceof Error && err.message === 'customer directory answer invalid', label);

test('M7CDP-01 detail: one fixed call to 022\'s routine — the store key, the id and the authorizer\'s tenant as a precondition — under the adapter\'s bounds', async () => {
  const client = fakeClient([customerRow(1)]);
  const signal = live();
  const answer = await createPostgresCustomerDetail({ client }).get(SCOPE, SESSION_KEY, C(1), signal);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], DETAIL_STATEMENT);
  assert.deepEqual(client.values[0], [SESSION_KEY, C(1), TENANT], 'key, id, expected tenant — in that order');
  for (const fact of [ACTOR, 'a'.repeat(64), MEMBERSHIP, 'technician']) assert.ok(!client.values[0].includes(fact), `${fact} is not sent`);
  assert.ok(!client.statements[0].includes('tmpos_customer.'), '017\'s table and page are never named');
  assert.equal(client.bounds[0], CUSTOMER_DIRECTORY_BOUNDS);
  assert.equal(client.signals[0], signal);
  assert.deepEqual(answer, { outcome: 'customer', id: C(1), name: 'Customer 1' });
  assert.ok(Object.isFrozen(answer));
  for (const outcome of ['not_found', 'denied']) {
    const { answer: refusal } = getOne([refusalRow(outcome)]);
    assert.deepEqual(await refusal, { outcome }, outcome);
  }
});

test('M7CDP-02 detail: every answer out of shape is a throw — never a customer, never a refusal', async () => {
  const cases: Array<[string, unknown]> = [
    ['no row', []], ['two rows', [customerRow(1), customerRow(1)]], ['two refusals', [refusalRow('not_found'), refusalRow('not_found')]],
    ['invalid', [refusalRow('invalid')]], ['cursor_unknown', [refusalRow('cursor_unknown')]],
    ['another tenant', [customerRow(1, { o_tenant_id: OTHER_TENANT })]], ['no tenant', [customerRow(1, { o_tenant_id: null })]],
    ['another id', [customerRow(2)]], ['an uppercase id', [customerRow(1, { o_customer_id: C(1).toUpperCase() })]],
    ['an empty name', [customerRow(1, { o_name: '' })]], ['a 201-character name', [customerRow(1, { o_name: 'x'.repeat(201) })]],
    ['a null name', [customerRow(1, { o_name: null })]], ['an extra column', [{ ...customerRow(1), o_email: 'a@x.test' }]],
    ['a missing column', [{ o_outcome: 'customer', o_tenant_id: TENANT, o_customer_id: C(1) }]],
    ['not_found naming a tenant', [refusalRow('not_found', { o_tenant_id: TENANT })]], ['denied naming a customer', [refusalRow('denied', { o_customer_id: C(1) })]],
    ['not_found naming a name', [refusalRow('not_found', { o_name: 'x' })]], ['not rows', { rows: 1 }], ['null', null],
  ];
  for (const [label, rows] of cases) await faults(getOne(rows).answer, label);
  // A driver error propagates as itself (the route discards it): still a throw, never an answer.
  await assert.rejects(createPostgresCustomerDetail({ client: fakeClient(null, new Error('M7CDP-CANARY')) }).get(SCOPE, SESSION_KEY, C(1), live()) as Promise<unknown>,
    /M7CDP-CANARY/, 'a driver error');
});

test('M7CDP-03 detail: only a selected tenant scope, a store-key-shaped key and a canonical id reach the database', async () => {
  const cases: Array<[string, unknown, unknown, unknown]> = [
    ['a platform scope', { ...SCOPE, scope: 'platform', tenant: null }, SESSION_KEY, C(1)],
    ['a store scope', { ...SCOPE, scope: 'store', store: STORE }, SESSION_KEY, C(1)],
    ['a tenant scope with no tenant', { ...SCOPE, tenant: null }, SESSION_KEY, C(1)],
    ['a non-uuid tenant', { ...SCOPE, tenant: 'tenant-a' }, SESSION_KEY, C(1)],
    ['no scope', null, SESSION_KEY, C(1)],
    ['no key', SCOPE, null, C(1)], ['a short key', SCOPE, 'k'.repeat(42), C(1)], ['a padded key', SCOPE, `${'k'.repeat(42)}=`, C(1)],
    ['no id', SCOPE, SESSION_KEY, null], ['an uppercase id', SCOPE, SESSION_KEY, C(1).toUpperCase()], ['a braced id', SCOPE, SESSION_KEY, '{id}'],
    ['an id with a suffix', SCOPE, SESSION_KEY, `${C(1)}x`], ['a numeric id', SCOPE, SESSION_KEY, 7],
  ];
  for (const [label, scope, key, id] of cases) {
    const client = fakeClient([customerRow(1)]);
    await faults(createPostgresCustomerDetail({ client }).get(scope as TrustedScope, key as string, id as string, live()) as Promise<unknown>, label);
    assert.equal(client.statements.length, 0, `${label}: nothing reached the database`);
    assert.equal(client.bounds.length, 0, `${label}: no transaction was opened`);
  }
});

test('M7CDP-04 probeCustomerDetail: true only for the routine\'s one denial of a random key; anything else, a fault or an abort is false', async () => {
  const client = fakeClient([refusalRow('denied')]);
  const signal = live();
  assert.equal(await probeCustomerDetail(client, signal), true);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], DETAIL_STATEMENT);
  assert.equal(client.values[0].length, 3);
  assert.match(client.values[0][0] as string, /^[A-Za-z0-9_-]{43}$/, 'a store-key-shaped key');
  for (const v of client.values[0].slice(1)) assert.match(v as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'random ids');
  assert.equal(client.bounds[0], CUSTOMER_DIRECTORY_BOUNDS);
  assert.equal(client.signals[0], signal);
  await probeCustomerDetail(client, live());
  assert.notEqual(client.values[1][0], client.values[0][0], 'a fresh random key per call');
  for (const [label, rows] of [
    ['no row', []], ['two denials', [refusalRow('denied'), refusalRow('denied')]], ['not_found', [refusalRow('not_found')]],
    ['invalid', [refusalRow('invalid')]], ['a customer row', [customerRow(1)]], ['a denial naming a tenant', [refusalRow('denied', { o_tenant_id: TENANT })]],
    ['an extra column', [{ ...refusalRow('denied'), extra: 1 }]], ['not rows', { rows: 1 }],
  ] as const) {
    assert.equal(await probeCustomerDetail(fakeClient(rows), live()), false, label);
  }
  assert.equal(await probeCustomerDetail(fakeClient(null, Object.assign(new Error('M7CDP-CANARY'), { code: '42501' })), live()), false, 'a driver error');
  const aborted = new AbortController();
  aborted.abort();
  const idle = fakeClient([refusalRow('denied')]);
  assert.equal(await probeCustomerDetail(idle, aborted.signal), false, 'an aborted probe');
  assert.equal(idle.statements.length, 0, 'sends nothing once aborted');
});

// --- the profile read (M7A-CUSTOMERS-P6, -P7): migration 024's m7a_customer_profile over 023's -----------------------------

const PROFILE_STATEMENT = /select o_outcome, o_tenant_id, o_customer_id, o_name, o_phone, o_email, o_created_at, o_version\s+from tmpos_customer_edit\.m7a_customer_profile\(\?::text, \?::uuid, \?::uuid\)$/;
const CREATED = '2026-09-30T08:15:42.123Z';
const profileRow = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...customerRow(i), o_phone: '+1 555 0100', o_email: 'ada@example.test', o_created_at: CREATED, o_version: '3', ...over });
const profileRefusal = (outcome: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...refusalRow(outcome), o_phone: null, o_email: null, o_created_at: null, o_version: null, ...over });
const profileOne = (rows: unknown, id = C(1), scope: TrustedScope = SCOPE, key: unknown = SESSION_KEY) =>
  createPostgresCustomerProfile({ client: fakeClient(rows) }).get(scope, key as string, id, live()) as Promise<unknown>;

test('M7CPP-01 profile: one fixed call to 024\'s routine — the store key, the id and the authorizer\'s tenant — and the contact record answered as stored', async () => {
  const client = fakeClient([profileRow(1)]);
  const signal = live();
  const answer = await createPostgresCustomerProfile({ client }).get(SCOPE, SESSION_KEY, C(1), signal);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], PROFILE_STATEMENT);
  assert.deepEqual(client.values[0], [SESSION_KEY, C(1), TENANT], 'key, id, expected tenant — in that order');
  for (const fact of [ACTOR, 'a'.repeat(64), MEMBERSHIP, 'technician']) assert.ok(!client.values[0].includes(fact), `${fact} is not sent`);
  assert.ok(!client.statements[0].includes('tmpos_customer.'), '017\'s table is never named');
  assert.equal(client.bounds[0], CUSTOMER_DIRECTORY_BOUNDS);
  assert.equal(client.signals[0], signal);
  assert.ok(!client.statements[0].includes('tmpos_customer_contact.'), '023\'s routine is no longer asked (024 revokes it from the runtime)');
  assert.deepEqual(answer, { outcome: 'customer', id: C(1), name: 'Customer 1', phone: '+1 555 0100', email: 'ada@example.test', createdAt: CREATED, version: 3 });
  assert.ok(Object.isFrozen(answer));
  assert.deepEqual(await profileOne([profileRow(1, { o_phone: null, o_email: null, o_created_at: null, o_version: '1' })]),
    { outcome: 'customer', id: C(1), name: 'Customer 1', phone: null, email: null, createdAt: null, version: 1 }, 'a legacy customer');
  for (const outcome of ['not_found', 'denied']) assert.deepEqual(await profileOne([profileRefusal(outcome)]), { outcome }, outcome);
});

test('M7CPP-02 profile: every answer out of shape is a throw with the one bounded message — never a customer, a refusal or a contact', async () => {
  const cases: Array<[string, unknown]> = [
    ['no row', []], ['two rows', [profileRow(1), profileRow(1)]], ['invalid', [profileRefusal('invalid')]],
    ['the detail\'s four columns', [customerRow(1)]], ['an extra column', [{ ...profileRow(1), o_extra: 1 }]],
    ['another tenant', [profileRow(1, { o_tenant_id: OTHER_TENANT })]], ['another id', [profileRow(2)]],
    ['an untrimmed phone', [profileRow(1, { o_phone: ' +1 555 0100' })]], ['an empty phone', [profileRow(1, { o_phone: '' })]],
    ['a phone with no digit', [profileRow(1, { o_phone: 'call me' })]], ['a numeric phone', [profileRow(1, { o_phone: 5550100 })]],
    ['an email with a space', [profileRow(1, { o_email: 'ada @example.test' })]], ['an email with no @', [profileRow(1, { o_email: 'ada' })]],
    ['a Date for the creation time', [profileRow(1, { o_created_at: new Date(CREATED) })]],
    ['a creation time out of form', [profileRow(1, { o_created_at: '2026-09-30 08:15:42.123+00' })]],
    ['denied naming a phone', [profileRefusal('denied', { o_phone: '+1 555 0100' })]],
    ['not_found naming a creation time', [profileRefusal('not_found', { o_created_at: CREATED })]], ['null', null],
    // M7A-CUSTOMERS-P7: the version, as bigint decimal text 1..2^53-1 with no leading zero, and NULL on every refusal.
    ['P6\'s seven columns', [(({ o_version: _v, ...rest }) => rest)(profileRow(1))]],
    ['a null version', [profileRow(1, { o_version: null })]], ['version 0', [profileRow(1, { o_version: '0' })]],
    ['a leading zero', [profileRow(1, { o_version: '03' })]], ['a negative version', [profileRow(1, { o_version: '-3' })]],
    ['a numeric version', [profileRow(1, { o_version: 3 })]], ['a bigint version', [profileRow(1, { o_version: 3n })]],
    ['a version past 2^53-1', [profileRow(1, { o_version: '9007199254740992' })]], ['a 17-digit version', [profileRow(1, { o_version: '10000000000000000' })]],
    ['a version with a space', [profileRow(1, { o_version: ' 3' })]], ['a fractional version', [profileRow(1, { o_version: '3.0' })]],
    ['denied naming a version', [profileRefusal('denied', { o_version: '1' })]], ['not_found naming a version', [profileRefusal('not_found', { o_version: '1' })]],
  ];
  for (const [label, rows] of cases) {
    await assert.rejects(profileOne(rows), (err: unknown) => err instanceof Error && err.message === 'customer directory answer invalid'
      && !/555|example|ada/i.test(err.message), label);
  }
});

test('M7CPP-03 profile: only a selected tenant scope, a store-key-shaped key and a canonical id reach the database', async () => {
  for (const [label, scope, key, id] of [
    ['a platform scope', { ...SCOPE, scope: 'platform', tenant: null }, SESSION_KEY, C(1)], ['no scope', null, SESSION_KEY, C(1)],
    ['a tenant scope with no tenant', { ...SCOPE, tenant: null }, SESSION_KEY, C(1)], ['no key', SCOPE, null, C(1)],
    ['a short key', SCOPE, 'k'.repeat(42), C(1)], ['an uppercase id', SCOPE, SESSION_KEY, C(1).toUpperCase()], ['a braced id', SCOPE, SESSION_KEY, '{id}'],
  ] as const) {
    const client = fakeClient([profileRow(1)]);
    await faults(createPostgresCustomerProfile({ client }).get(scope as TrustedScope, key as string, id as string, live()) as Promise<unknown>, label);
    assert.equal(client.statements.length + client.bounds.length, 0, `${label}: nothing reached the database`);
  }
});

test('M7CPP-04 probeCustomerProfile: true only for the routine\'s one denial of a random key with every other column null; anything else, a fault or an abort is false', async () => {
  const client = fakeClient([profileRefusal('denied')]);
  const signal = live();
  assert.equal(await probeCustomerProfile(client, signal), true);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], PROFILE_STATEMENT);
  assert.match(client.values[0][0] as string, /^[A-Za-z0-9_-]{43}$/, 'a store-key-shaped key');
  for (const v of client.values[0].slice(1)) assert.match(v as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'random ids');
  assert.equal(client.bounds[0], CUSTOMER_DIRECTORY_BOUNDS);
  for (const [label, rows] of [
    ['no row', []], ['the detail\'s four columns', [refusalRow('denied')]], ['not_found', [profileRefusal('not_found')]],
    ['a customer row', [profileRow(1)]], ['a denial naming a phone', [profileRefusal('denied', { o_phone: '1' })]],
    ['a denial naming a creation time', [profileRefusal('denied', { o_created_at: CREATED })]], ['two denials', [profileRefusal('denied'), profileRefusal('denied')]],
    ['a denial naming a version', [profileRefusal('denied', { o_version: '1' })]],
    ['P6\'s seven-column denial', [(({ o_version: _v, ...rest }) => rest)(profileRefusal('denied'))]],
  ] as const) {
    assert.equal(await probeCustomerProfile(fakeClient(rows), live()), false, label);
  }
  assert.equal(await probeCustomerProfile(fakeClient(null, Object.assign(new Error('M7CPP-CANARY'), { code: '42501' })), live()), false, 'a driver error');
  const aborted = new AbortController();
  aborted.abort();
  const idle = fakeClient([profileRefusal('denied')]);
  assert.equal(await probeCustomerProfile(idle, aborted.signal), false, 'an aborted probe');
  assert.equal(idle.statements.length, 0, 'sends nothing once aborted');
});

test('M7CPP-05 profile (M7A-CUSTOMERS-P7): the largest version a row can hold is answered exactly, never rounded through a float', async () => {
  assert.equal(((await profileOne([profileRow(1, { o_version: '9007199254740991' })])) as { version: number }).version, Number.MAX_SAFE_INTEGER);
  assert.equal(((await profileOne([profileRow(1, { o_version: '1' })])) as { version: number }).version, 1);
});
