// Phase 4.0 M7B-INVOICES-P1 — the PostgreSQL store directory adapter: what it hands migration 027's routine, and what it
// refuses to read back as a list. DATABASE-FREE; the routine itself is proved against a real cluster
// (tests/db/storeAccess.integration.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { STORE_DIRECTORY_BOUNDS, STORE_DIRECTORY_DEADLINE_MS, createPostgresStoreDirectory, probeStoreDirectory, storeDirectoryAnswerOf } from './postgresStoreDirectory.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';

/** A synthetic session key: the shape of a SHA-256 digest in unpadded base64url. */
const SESSION_KEY = 'k'.repeat(43);
const TENANT = randomUUID();
/** Store ids in id order, distinct, built at run time. */
const S = (i: number): string => `${(0x50000000 + i).toString(16)}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const storeRow = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ o_outcome: 'store', o_store_id: S(i), o_tenant_id: TENANT, o_store_name: `Store ${i}`, o_read_only: false, ...over });
const refusalRow = (outcome: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ o_outcome: outcome, o_store_id: null, o_tenant_id: null, o_store_name: null, o_read_only: null, ...over });

interface Fake extends SupervisedPgClient { readonly statements: string[]; readonly values: unknown[][]; readonly bounds: unknown[]; readonly signals: unknown[] }

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
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => { bounds.push(b); signals.push(signal); return work(sql); }) as never,
    end: async () => undefined,
  }) as never;
}

const live = (): AbortSignal => new AbortController().signal;

test('one fixed call to migration 027\'s routine with the session key alone; the rows become the list in the routine\'s order', async () => {
  const client = fakeClient([storeRow(1), storeRow(2, { o_store_name: null, o_read_only: true })]);
  const signal = live();
  const answer = await createPostgresStoreDirectory({ client }).stores(SESSION_KEY, signal);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], /select o_outcome, o_store_id, o_tenant_id, o_store_name, o_read_only\s+from tmpos_store_access\.m7b_store_directory\(\?::text\)$/);
  assert.deepEqual(client.values[0], [SESSION_KEY], 'the session key, and nothing else');
  assert.equal(client.bounds[0], STORE_DIRECTORY_BOUNDS);
  assert.deepEqual(STORE_DIRECTORY_BOUNDS, { lock: '2100ms', statement: '2700ms', idle: '6000ms' });
  assert.equal(STORE_DIRECTORY_DEADLINE_MS, 3_000);
  assert.equal(client.signals[0], signal, 'the route\'s deadline signal reaches the kernel');
  assert.deepEqual(answer, { outcome: 'stores', stores: [
    { id: S(1), tenantId: TENANT, name: 'Store 1', readOnly: false }, { id: S(2), tenantId: TENANT, name: null, readOnly: true },
  ] });
  assert.deepEqual(await createPostgresStoreDirectory({ client: fakeClient([]) }).stores(SESSION_KEY, live()), { outcome: 'stores', stores: [] }, 'no row: no usable store');
  assert.deepEqual(await createPostgresStoreDirectory({ client: fakeClient([refusalRow('denied')]) }).stores(SESSION_KEY, live()), { outcome: 'denied' });
  const full = Array.from({ length: 200 }, (_, i) => storeRow(i + 1, { o_store_name: `Store ${String(i + 1).padStart(3, '0')}` }));
  assert.equal(((await createPostgresStoreDirectory({ client: fakeClient(full) }).stores(SESSION_KEY, live())) as { stores: unknown[] }).stores.length, 200);
});

test('a key not of the session-key shape is refused before any statement', async () => {
  for (const key of ['', 'k'.repeat(42), 'k'.repeat(44), `${'k'.repeat(42)}=`, `${'k'.repeat(42)} `, null, 7]) {
    const client = fakeClient([]);
    await assert.rejects(Promise.resolve(createPostgresStoreDirectory({ client }).stores(key as never, live())), /store directory answer invalid/, String(key));
    assert.equal(client.statements.length, 0, String(key));
  }
});

test('everything out of shape is a throw — an outage, never a list and never a refusal', async () => {
  const otherTenant = randomUUID();
  const cases: Array<[string, unknown]> = [
    ['not an array', { rows: [] }], ['null', null],
    ['201 rows', Array.from({ length: 201 }, (_, i) => storeRow(i + 1, { o_store_name: `Store ${String(i + 1).padStart(3, '0')}` }))],
    ['invalid, the malformed-argument answer', [refusalRow('invalid')]],
    ['a refusal beside a store', [refusalRow('denied'), storeRow(1)]], ['a store beside a refusal', [storeRow(1), refusalRow('denied')]],
    ['a refusal carrying a store', [refusalRow('denied', { o_store_id: S(1) })]], ['a refusal carrying a flag', [refusalRow('denied', { o_read_only: false })]],
    ['an unknown outcome', [storeRow(1, { o_outcome: 'granted' })]], ['a missing column', [{ o_outcome: 'store', o_store_id: S(1), o_tenant_id: TENANT, o_store_name: 'x' }]],
    ['an extra column', [storeRow(1, { o_role_id: 'manager' })]], ['a store twice', [storeRow(1), storeRow(1)]],
    ['a non-canonical id', [storeRow(1, { o_store_id: S(1).toUpperCase().replace(/^5/, 'A') })]], ['no tenant', [storeRow(1, { o_tenant_id: null })]],
    ['an empty name', [storeRow(1, { o_store_name: '' })]], ['a name of 257 characters', [storeRow(1, { o_store_name: 'x'.repeat(257) })]],
    ['a text flag', [storeRow(1, { o_read_only: 'f' })]], ['a null flag on a store', [storeRow(1, { o_read_only: null })]],
    ['out of name order', [storeRow(2, { o_store_name: 'B' }), storeRow(1, { o_store_name: 'A' })]],
    ['an unnamed store first', [storeRow(1, { o_store_name: null }), storeRow(2)]],
    ['equal names out of id order', [storeRow(2, { o_store_name: 'A' }), storeRow(1, { o_store_name: 'A' })]],
  ];
  for (const [label, rows] of cases) {
    await assert.rejects(Promise.resolve(createPostgresStoreDirectory({ client: fakeClient(rows) }).stores(SESSION_KEY, live())), /store directory answer invalid/, label);
  }
  // Two tenants' stores are one actor's answer (store grants in two tenants): accepted, each row naming its own tenant.
  assert.deepEqual(storeDirectoryAnswerOf([storeRow(1, { o_store_name: 'A' }), storeRow(2, { o_store_name: 'B', o_tenant_id: otherTenant })]),
    { outcome: 'stores', stores: [{ id: S(1), tenantId: TENANT, name: 'A', readOnly: false }, { id: S(2), tenantId: otherTenant, name: 'B', readOnly: false }] });
  // A driver fault propagates unchanged, with no message of the adapter's own.
  const fault = new Error('connection lost');
  await assert.rejects(Promise.resolve(createPostgresStoreDirectory({ client: fakeClient([], fault) }).stores(SESSION_KEY, live())), (err: unknown) => err === fault);
});

test('readiness: true only for the routine\'s one denied row of a random key, with every other column null', async () => {
  const client = fakeClient([refusalRow('denied')]);
  assert.equal(await probeStoreDirectory(client, live()), true);
  assert.match(client.statements[0], /from tmpos_store_access\.m7b_store_directory\(\?::text\)$/);
  assert.match(String(client.values[0][0]), /^[A-Za-z0-9_-]{43}$/, 'a random key of the session-key shape');
  for (const [label, rows] of [
    ['no row', []], ['a store', [storeRow(1)]], ['invalid', [refusalRow('invalid')]], ['two refusals', [refusalRow('denied'), refusalRow('denied')]],
    ['a refusal carrying a store', [refusalRow('denied', { o_store_id: S(1) })]], ['out of shape', [{ o_outcome: 'denied' }]],
  ] as const) assert.equal(await probeStoreDirectory(fakeClient(rows), live()), false, label);
  assert.equal(await probeStoreDirectory(fakeClient([], new Error('down')), live()), false, 'a fault');
  const aborted = new AbortController();
  aborted.abort();
  const untouched = fakeClient([refusalRow('denied')]);
  assert.equal(await probeStoreDirectory(untouched, aborted.signal), false, 'an aborted signal');
  assert.equal(untouched.statements.length, 0);
});
