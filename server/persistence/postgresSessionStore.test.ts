// Phase 4.0 M5-GIAM-D1-P2-R1 — the PostgreSQL session store: what it sends, what it trusts, and what
// it refuses to answer. DATABASE-FREE; the routines themselves are proved against a real cluster
// (tests/db/tenantAdmission.integration.test.mjs).
//
// The property under test is one-sided. This store may answer "no such session" ONLY when the
// database said so: every other doubt — a shape it does not recognise, a stamp it cannot parse, a
// clock it cannot read, an outcome the routine does not define — must THROW, because the boundary
// reads a throw as an outage and refuses the request, while "no such session" logs a live user out.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresSessionStore, SESSION_STORE_BOUNDS, SESSION_STORE_DEADLINE_MS } from './postgresSessionStore.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import { SESSION_TTL } from '../runtime/sessions.js';
import type { SessionRecord } from '../runtime/sessions.js';

const KEY = 'a'.repeat(43);
const PRINCIPAL_KEY = 'b'.repeat(43);
const CREATED = 1_700_000_000_000;

const RECORD: SessionRecord = Object.freeze({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-alpha', principalKey: PRINCIPAL_KEY,
  securityVersion: 't1:witness', authenticatedAt: CREATED - 1_000, createdAt: CREATED,
  lastSeenAt: CREATED, validatedAt: CREATED,
});

/** The row migration 011's read answers with: int8 columns arrive from the driver as decimal TEXT. */
const ROW = Object.freeze({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-alpha', principalKey: PRINCIPAL_KEY,
  securityVersion: 't1:witness', authenticatedAt: String(CREATED - 1_000), createdAt: String(CREATED),
  lastSeenAt: String(CREATED), validatedAt: String(CREATED),
});

interface Fake extends SupervisedPgClient {
  readonly statements: string[];
  readonly values: unknown[][];
  readonly bounds: unknown[];
}

/** A client answering every statement from `rows` (or throwing `fault`), recording what it was sent. */
function fakeClient(rows: unknown, fault?: Error): Fake {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const bounds: unknown[] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    return fault ? Promise.reject(fault) : Promise.resolve(rows as never);
  }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements, values, bounds,
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      bounds.push(b);
      void signal;
      return work(sql);
    }) as never,
    end: async () => undefined,
  }) as never;
}

const live = (): AbortSignal => new AbortController().signal;
/**
 * The port declares every method as answering `unknown` — a port never promises a shape — so a call
 * is adapted once, here, rather than cast at each assertion.
 */
const answered = (value: unknown): Promise<unknown> => Promise.resolve(value);
const store = (rows: unknown, fault?: Error, now?: () => number) => {
  const client = fakeClient(rows, fault);
  return { client, store: createPostgresSessionStore({ client, ...(now === undefined ? {} : { now }) }) };
};

// --- create -------------------------------------------------------------------------------------

test("create sends the record as given and the expiry this store computes from the RECORD's own audience", async () => {
  for (const audience of ['tenant', 'admin'] as const) {
    const { client, store: s } = store([{ outcome: 'created' }]);
    await s.create(KEY, { ...RECORD, audience }, live());
    assert.equal(client.statements.length, 1, 'one statement, one round trip');
    assert.deepEqual(client.values[0], [
      KEY, audience, 'firebase', 'uid-alpha', PRINCIPAL_KEY, 't1:witness',
      CREATED - 1_000, CREATED, CREATED, CREATED, CREATED + SESSION_TTL[audience].absoluteMs,
    ], `${audience}: every stamp the boundary set travels, and the expiry is its own lifetime`);
    assert.equal(client.statements[0].includes('m5_session_create'), true);
    // The reference travels as a BOUND VALUE. (Asserting it is absent from the statement text would
    // be vacuous here: the fake joins the template's static strings, which can never hold a value.)
    assert.equal(client.values[0].includes('uid-alpha'), true, 'the reference is a parameter');
  }
});

test('a login whose key is already taken fails the login rather than overwriting a live session', async () => {
  const { store: s } = store([{ outcome: 'conflict' }]);
  await assert.rejects(answered(s.create(KEY, RECORD, live())), /session store unavailable: not_created/);
});

test('create refuses a record this runtime has no lifetime for, before anything is sent', async () => {
  // 'support' names nothing at all. The rest name something every plain object INHERITS, which an
  // `in` check or a bracket read would take for a lifetime — the case the own-property lookup closes.
  for (const audience of ['support', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const { client, store: s } = store([{ outcome: 'created' }]);
    await assert.rejects(answered(s.create(KEY, { ...RECORD, audience: audience as never }, live())), /audience_invalid/, audience);
    assert.deepEqual(client.statements, [], `${audience}: nothing was sent`);
  }
});

// --- get ----------------------------------------------------------------------------------------

test('get returns the stored record, parsing the driver\'s decimal int8 text rather than casting it', async () => {
  const NOW = 1_700_000_000_123;
  const { client, store: s } = store([ROW], undefined, () => NOW);
  assert.deepEqual(await s.get(KEY, live()), RECORD);
  // The liveness bound is this store's clock, sent AS GIVEN beside the key. Its VALUE is asserted,
  // not merely its type: a store sending seconds where the routine compares milliseconds would judge
  // every session expired (a silent mass logout) or none of them (a revoked session still served).
  assert.deepEqual(client.values[0], [KEY, NOW]);
  assert.equal(client.statements[0].includes('m5_session_get'), true);
});

test('each operation calls its OWN routine, so a misrouted call cannot pass for a working one', async () => {
  const calls: [string, (s: ReturnType<typeof store>['store']) => unknown][] = [
    ['m5_session_create', (s) => s.create(KEY, RECORD, live())],
    ['m5_session_get', (s) => s.get(KEY, live())],
    ['m5_session_touch', (s) => s.update(KEY, { lastSeenAt: CREATED }, live())],
    ['m5_session_revoke(', (s) => s.revoke(KEY, live())],
    ['m5_session_revoke_principal', (s) => s.revokePrincipal('tenant', PRINCIPAL_KEY, live())],
  ];
  for (const [routine, call] of calls) {
    const { client, store: s } = store([{ outcome: 'created' }, { ended: 0 }].slice(0, 1));
    await answered(call(s)).catch(() => undefined); // the answer is another test's subject
    assert.equal(client.statements.length, 1, routine);
    assert.equal(client.statements[0].includes(routine), true, `${routine}: called, not a sibling`);
  }
});

test('NO row is the one answer that is not a fault; every other doubt throws instead of logging a user out', async () => {
  assert.equal(await store([]).store.get(KEY, live()), undefined, 'this key names no live session');
  const faults: [string, unknown][] = [
    ['two rows', [ROW, ROW]],
    ['not an array', { ...ROW }],
    ['a row that is not an object', ['x']],
    ['a missing column', [{ ...ROW, validatedAt: undefined }]],
    ['an extra column', [{ ...ROW, extra: 1 }]],
    ['an audience the runtime does not know', [{ ...ROW, audience: 'support' }]],
    ['an empty security version', [{ ...ROW, securityVersion: '' }]],
    ['a stamp past the safe-integer range', [{ ...ROW, createdAt: '9007199254740993' }]],
    ['a stamp that is not decimal text', [{ ...ROW, lastSeenAt: '17e11' }]],
    ['a NULL where a stamp belongs', [{ ...ROW, createdAt: null }]],
  ];
  for (const [label, rows] of faults) {
    await assert.rejects(answered(store(rows).store.get(KEY, live())), /session store unavailable/, label);
  }
  // Only authenticatedAt may be absent, and only as a SQL NULL.
  const nullAuth = await store([{ ...ROW, authenticatedAt: null }]).store.get(KEY, live()) as SessionRecord;
  assert.equal(nullAuth.authenticatedAt, null);
});

test('a driver fault is an outage in this store\'s own words, carrying nothing of the driver\'s', async () => {
  const fault = Object.assign(new Error('connection to db.example:5432 refused'), { code: '08006', schema: 'tmpos_session' });
  await assert.rejects(answered(store(null, fault).store.get(KEY, live())), (err: Error) => {
    assert.equal(err.message, 'session store unavailable: store_failed');
    assert.equal(JSON.stringify(err.message).includes('db.example'), false);
    return true;
  });
});

test('a clock that cannot be read is an outage, never a read that matches no row', async () => {
  for (const bad of [NaN, 0, -1, 1.5, Infinity, '1700000000000' as unknown as number]) {
    await assert.rejects(answered(store([ROW], undefined, () => bad as number).store.get(KEY, live())),
      /session store unavailable/, String(bad));
  }
});

test('an already-aborted call never reaches the database', async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, store: s } = store([ROW]);
  await assert.rejects(answered(s.get(KEY, controller.signal)), /session store unavailable: aborted/);
  assert.deepEqual(client.statements, []);
});

// --- update, revoke, revokePrincipal --------------------------------------------------------------

test('update slides exactly one named stamp, and refuses any other field or value without sending one', async () => {
  const { client, store: s } = store([{ outcome: 'updated' }]);
  await s.update(KEY, { lastSeenAt: CREATED + 5 }, live());
  await s.update(KEY, { validatedAt: CREATED + 6 }, live());
  assert.deepEqual(client.values.map((v) => v.slice(1)), [['lastSeenAt', CREATED + 5], ['validatedAt', CREATED + 6]]);
  const sent = client.statements.length;
  for (const fields of [{}, { lastSeenAt: CREATED, validatedAt: CREATED }, { createdAt: CREATED }, { lastSeenAt: 1.5 },
    { lastSeenAt: -1 }, { lastSeenAt: '1700000000000' }, { lastSeenAt: Number.MAX_SAFE_INTEGER + 2 }]) {
    await assert.rejects(answered(s.update(KEY, fields as never, live())), /session store unavailable/, JSON.stringify(fields));
  }
  assert.equal(client.statements.length, sent, 'a refused update sends nothing');
});

test('an update never creates: a key that names no record is a no-op, so a revoked session stays revoked', async () => {
  await store([{ outcome: 'absent' }]).store.update(KEY, { lastSeenAt: CREATED }, live());
  for (const outcome of ['invalid', 'created', '']) {
    await assert.rejects(answered(store([{ outcome }]).store.update(KEY, { lastSeenAt: CREATED }, live())), /not_updated/, outcome);
  }
});

test('revocation is final: only the routine\'s own word is success', async () => {
  const { client, store: s } = store([{ outcome: 'revoked' }]);
  await s.revoke(KEY, live());
  assert.deepEqual(client.values[0], [KEY]);
  for (const outcome of ['absent', 'updated', null]) {
    await assert.rejects(answered(store([{ outcome }]).store.revoke(KEY, live())), /not_revoked/, String(outcome));
  }
});

test('revoking a principal names exactly one audience the runtime knows, and reads the count the routine returned', async () => {
  const { client, store: s } = store([{ ended: '2' }]);
  await s.revokePrincipal('tenant', PRINCIPAL_KEY, live());
  assert.deepEqual(client.values[0], ['tenant', PRINCIPAL_KEY]);
  // Zero is a valid answer: the principal held no session on this boundary.
  await store([{ ended: 0 }]).store.revokePrincipal('admin', PRINCIPAL_KEY, live());
  for (const audience of ['support', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const { client: unsent, store: refuses } = store([{ ended: '1' }]);
    await assert.rejects(answered(refuses.revokePrincipal(audience as never, PRINCIPAL_KEY, live())), /audience_invalid/, audience);
    assert.deepEqual(unsent.statements, [], `${audience}: an audience this runtime does not know reaches no routine`);
  }
  for (const ended of ['-1', 'many', null, '9007199254740993']) {
    await assert.rejects(answered(store([{ ended }]).store.revokePrincipal('tenant', PRINCIPAL_KEY, live())), /not_revoked/, String(ended));
  }
});

test('an answer of the wrong shape is never read as an outcome', async () => {
  for (const rows of [[], [{ outcome: 'revoked' }, { outcome: 'revoked' }], [{ outcome: 'revoked', extra: 1 }], [{ other: 'revoked' }], 'revoked']) {
    await assert.rejects(answered(store(rows).store.revoke(KEY, live())), /answer_shape_invalid/, JSON.stringify(rows));
  }
});

test('every operation runs under the store\'s own bounds, below the port deadline', async () => {
  const { client, store: s } = store([ROW]);
  await s.get(KEY, live());
  assert.deepEqual(client.bounds, [SESSION_STORE_BOUNDS]);
  for (const value of Object.values(SESSION_STORE_BOUNDS)) {
    const ms = Number(String(value).replace('ms', ''));
    assert.ok(Number.isInteger(ms) && ms > 0, `${String(value)} is a positive millisecond bound`);
  }
  assert.ok(Number(String(SESSION_STORE_BOUNDS.statement).replace('ms', '')) < SESSION_STORE_DEADLINE_MS,
    'the statement bound sits below the deadline, so PostgreSQL cancels before this process gives up');
});
