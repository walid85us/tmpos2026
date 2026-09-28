// Phase 4.0 M7A-CUSTOMERS-P1 — the PostgreSQL customer directory adapter: what it hands the database's routine, and
// what it refuses to read back as a page. DATABASE-FREE; the routine itself is proved against a real cluster.
// M7A-CUSTOMERS-P2: the routine is migration 018's session-bound read, handed the presenting session's store key — since
// M7A-CUSTOMERS-P3-R1 migration 020's page_v3, which adds the role's current Customers level to 018's derivation.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CUSTOMER_DIRECTORY_BOUNDS, CUSTOMER_DIRECTORY_DEADLINE_MS, createPostgresCustomerDirectory, probeCustomerDirectory } from './postgresCustomerDirectory.js';
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
