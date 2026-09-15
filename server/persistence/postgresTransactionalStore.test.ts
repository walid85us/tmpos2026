// Phase 4.0 M6-PG-P4 — the PostgreSQL transactional store's boundary logic, without a database.
//
// Everything that needs PostgreSQL — locking, the store's clock, atomicity, and the three conformance suites
// over two instances — is proved against a disposable server in tests/db/transactionalStore.integration.test.mjs.
// This suite pins what sits on either side of the server, where no server is needed to decide: what the adapter
// refuses without asking it, how it reads a failure before and after COMMIT, what it hands back, and what its
// source may never contain. The scripted client stands only at the database boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresTransactionalStore } from './postgresTransactionalStore.js';
import type { AggregateMutator, PgClient, PgTransaction } from './postgresTransactionalStore.js';
import { defineCommands, prepareCommand } from '../runtime/commandTransaction.js';
import type { TransactionCommand } from '../runtime/commandTransaction.js';
import { createIdempotencyKeyring } from '../runtime/idempotency.js';
import { TEST_IDEMPOTENCY_KEY } from '../runtime/idempotencyStore.testkit.js';
import { defineOutboxEvents } from '../runtime/outbox.js';
import { TEST_CREATE, TEST_EVENTS } from '../runtime/transactionalOutbox.testkit.js';

const UNAVAILABLE = { outcome: 'unavailable' };
const LEASE_LOST = { outcome: 'lease_lost' };
const CLAIM_LOST = { outcome: 'claim_lost' };
const COMMITTED = { outcome: 'committed' };
const OUTCOME_UNKNOWN = 'transactional_store_outcome_unknown';

const digest = (): string => randomBytes(32).toString('base64url');
const live = (): AbortSignal => new AbortController().signal;
const CREATE_MUTATOR: AggregateMutator = Object.freeze({ kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', apply: async () => 'applied' });

/** A client the adapter must never reach: every transaction it opens is counted and refused. */
function untouched(): { readonly client: PgClient; readonly begins: () => number } {
  let begins = 0;
  return { client: { begin: async () => { begins++; throw new Error('the store was asked'); } }, begins: () => begins };
}

/** A server error as the driver reports one: a SQLSTATE, a severity, and a message the adapter must never repeat. */
const serverError = (code: string, severity = 'ERROR'): Error => Object.assign(new Error(`M6-UNIT-CANARY ${code} relation tmpos_internal.outbox_event`), { code, severity });
const connectionError = (): Error => Object.assign(new Error('M6-UNIT-CANARY write CONNECTION_CLOSED /tmp/.s.PGSQL.5432'), { code: 'CONNECTION_CLOSED' });
/** A refusal the driver raises itself, before or without the server: a code and no severity; the connection stays open. */
const driverError = (code: string): Error => Object.assign(new Error(`M6-UNIT-CANARY ${code}: raised by the driver`), { code });

/** `answer`, or 'no answer' when it has not settled within `ms`. */
async function within(answer: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, 'no answer'); });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One transaction whose statements answer as a healthy store would for a commit held by `lease`, then whose
 * COMMIT succeeds or fails as `commit` says. `failAt` makes the first statement whose text contains it fail with
 * `error`; with `lost` that failure also loses the connection, and then, as the driver does, the transaction is
 * rejected at once — and whatever is written after that is counted: the ROLLBACK the driver sends for a body that
 * rejects, which the real driver writes to the closed socket and crashes on (doc 08, DA-15).
 */
function scripted(lease: string, options: { failAt?: string; error?: Error; lost?: boolean; commit?: Error } = {}): PgClient & { readonly writesAfterLoss: () => number } {
  const rowsFor = (text: string): Record<string, unknown>[] => {
    if (text.includes('for update')) return [{ lease, open: true, expires: String(Date.now() + 60_000) }];
    if (text.includes('as now')) return [{ now: String(Date.now()) }];
    if (text.includes('insert into tmpos_internal.outbox_event') || text.includes('update tmpos_internal.idempotency_record')) return [{}];
    return [{ ok: true }];
  };
  let writesAfterLoss = 0;
  return {
    writesAfterLoss: () => writesAfterLoss,
    async begin(fn) {
      let lost = false;
      let lose: (err: unknown) => void = () => undefined;
      const closed = new Promise<never>((_, reject) => { lose = reject; });
      const tx = ((strings: TemplateStringsArray) => {
        if (lost) writesAfterLoss++;
        const text = strings.join('$');
        const failed = options.failAt !== undefined && text.includes(options.failAt);
        if (failed && options.lost === true) {
          lost = true;
          lose(options.error);
        }
        const rows = rowsFor(text);
        const answer = failed ? Promise.reject(options.error) : Promise.resolve(Object.assign(rows, { count: rows.length }));
        return Object.assign(answer, { cancel: () => undefined });
      }) as unknown as PgTransaction;
      Object.assign(tx, { json: (value: unknown) => value });
      const body = Promise.resolve(fn(tx)).catch((err: unknown) => {
        if (lost) writesAfterLoss++; // the driver's ROLLBACK for the rejected body
        throw err;
      });
      const result = await Promise.race([body, closed]);
      if (options.commit !== undefined) throw options.commit;
      return result;
    },
  };
}

const events = defineOutboxEvents(TEST_EVENTS);
const commands = defineCommands([TEST_CREATE], events);
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);

/** A command exactly as the runtime prepares one. */
function command(): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'POST', path: '/v1/unit', audience: null, tenant: null, store: null, body: Buffer.from('{}'),
  });
  const id = randomUUID();
  const contract = commands.contract(TEST_CREATE.kind);
  assert.ok(contract !== undefined);
  const prepared = prepareCommand(contract, events, {
    aggregateId: id, expectedVersion: null, changes: { name: 'n', quantity: 1 },
    events: [{ type: 'conformance.item.created', payload: { name: 'n', quantity: 1 } }], response: { status: 201, body: { id } },
  }, {
    scope: operation.scope, lease: digest(), newAggregateId: id, authorization: Object.freeze({ scope: 'platform', permission: 'conformance.write' }),
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null);
  return prepared.command;
}

test('construction refuses a malformed client or mutator table, and accepts the pool as the driver shapes it — a function', () => {
  const client = untouched().client;
  for (const options of [null, {}, { client: null, mutators: [] }, { client: {}, mutators: [] }, { client, mutators: null }]) {
    assert.throws(() => createPostgresTransactionalStore(options as never), TypeError);
  }
  for (const mutators of [
    [{ ...CREATE_MUTATOR, kind: 'NotDotted' }],
    [{ ...CREATE_MUTATOR, mode: 'upsert' }],
    [{ ...CREATE_MUTATOR, aggregateType: 'Item' }],
    [{ ...CREATE_MUTATOR, apply: 'insert into item' }],
    [{ ...CREATE_MUTATOR, table: 'item' }],
    [CREATE_MUTATOR, { ...CREATE_MUTATOR }],
  ]) assert.throws(() => createPostgresTransactionalStore({ client, mutators } as never), TypeError, 'a mutator table in contract only, one per kind');
  const pool = Object.assign(() => undefined, { begin: client.begin });
  const store = createPostgresTransactionalStore({ client: pool as unknown as PgClient, mutators: [CREATE_MUTATOR] });
  assert.deepEqual(Object.keys(store).sort(), ['delivery', 'idempotency', 'transactions'], 'three separate ports, no fourth surface');
  assert.deepEqual([Object.keys(store.idempotency).sort(), Object.keys(store.transactions).sort(), Object.keys(store.delivery).sort()], [
    ['acquire', 'complete', 'probe'], ['commit', 'probe'], ['acknowledge', 'claim', 'deadLetter', 'probe', 'retry'],
  ], 'each port exposes exactly its own interface');
});

test('a malformed request, an unserved kind, a pre-M5 scope or an aborted signal is refused before the store is asked', async () => {
  const { client, begins } = untouched();
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] });
  const good = command();
  const [event] = good.events;
  const acquire = { scope: digest(), fingerprint: digest(), lease: digest(), leaseMs: 60_000, retentionMs: 600_000 };
  const aborted = new AbortController();
  aborted.abort();
  // A caller that is not the runtime: a proxy whose every read throws, and a change no enumeration shows.
  const hostile = new Proxy({}, { get() { throw new Error('M6-UNIT-CANARY hostile getter'); } });
  const hidden = Object.defineProperty({ ...good.mutation.changes }, 'note', { value: 'x'.repeat(8_192), enumerable: false });
  const cases: Array<[string, () => unknown, unknown]> = [
    ['a short scope', () => store.idempotency.acquire({ ...acquire, scope: 'short' }, live()), UNAVAILABLE],
    ['a retention shorter than its lease', () => store.idempotency.acquire({ ...acquire, retentionMs: 1_000 }, live()), UNAVAILABLE],
    ['a fractional lease', () => store.idempotency.acquire({ ...acquire, leaseMs: 1.5 }, live()), UNAVAILABLE],
    ['a completion under a lease the store never granted', () => store.idempotency.complete({ scope: digest(), lease: 'x', response: 'AAAA' }, live()), LEASE_LOST],
    ['a completion whose response is not sealed text', () => store.idempotency.complete({ scope: digest(), lease: digest(), response: 'a=b' }, live()), UNAVAILABLE],
    ['a command under a malformed lease', () => store.transactions.commit({ ...good, lease: 'x' }, live()), LEASE_LOST],
    ['a command with a field too many', () => store.transactions.commit({ ...good, sql: 'select 1' } as never, live()), UNAVAILABLE],
    ['a kind no mutator serves', () => store.transactions.commit({ ...good, mutation: { ...good.mutation, kind: 'conformance.item.rename' } }, live()), UNAVAILABLE],
    ['a tenant-scope audit before M5', () => store.transactions.commit({ ...good, audit: { ...good.audit, scope: 'tenant' } }, live()), UNAVAILABLE],
    ['an event of another aggregate', () => store.transactions.commit({ ...good, events: [{ ...event, aggregateId: randomUUID() }] }, live()), UNAVAILABLE],
    ['an event ID twice', () => store.transactions.commit({ ...good, events: [event, event] }, live()), UNAVAILABLE],
    ['nine events', () => store.transactions.commit({ ...good, events: Array.from({ length: 9 }, () => ({ ...event, eventId: randomUUID() })) }, live()), UNAVAILABLE],
    ['a claim of 33', () => store.delivery.claim({ claim: digest(), limit: 33, claimMs: 30_000 }, live()), UNAVAILABLE],
    ['a claim of no duration', () => store.delivery.claim({ claim: digest(), limit: 1, claimMs: 0 }, live()), UNAVAILABLE],
    ['a settlement of a malformed event ID', () => store.delivery.acknowledge({ eventId: 'e', claim: digest() }, live()), CLAIM_LOST],
    ['a retry past the delay cap', () => store.delivery.retry({ eventId: randomUUID(), claim: digest(), delayMs: 900_001 }, live()), UNAVAILABLE],
    ['an unknown dead-letter reason', () => store.delivery.deadLetter({ eventId: randomUUID(), claim: digest(), reason: 'other' } as never, live()), UNAVAILABLE],
    ['an aborted acquisition', () => store.idempotency.acquire(acquire, aborted.signal), UNAVAILABLE],
    ['an aborted commit', () => store.transactions.commit(good, aborted.signal), UNAVAILABLE],
    ['a hostile acquisition request', () => store.idempotency.acquire(hostile as never, live()), UNAVAILABLE],
    ['a hostile completion', () => store.idempotency.complete(hostile as never, live()), UNAVAILABLE],
    ['a hostile claim', () => store.delivery.claim(hostile as never, live()), UNAVAILABLE],
    ['a hostile acknowledgement', () => store.delivery.acknowledge(hostile as never, live()), UNAVAILABLE],
    ['a hostile retry', () => store.delivery.retry(hostile as never, live()), UNAVAILABLE],
    ['a hostile dead-letter', () => store.delivery.deadLetter(hostile as never, live()), UNAVAILABLE],
    ['a change hidden from enumeration', () => store.transactions.commit({ ...good, mutation: { ...good.mutation, changes: hidden } }, live()), UNAVAILABLE],
    ['an event naming a tenant before M5', () => store.transactions.commit({ ...good, events: [{ ...event, tenant: digest() }] } as never, live()), UNAVAILABLE],
    ['an event naming an actor before M5', () => store.transactions.commit({ ...good, events: [{ ...event, actor: digest() }] } as never, live()), UNAVAILABLE],
  ];
  for (const [label, call, expected] of cases) assert.deepEqual(await call(), expected, label);
  assert.equal(await store.transactions.probe(aborted.signal), false, 'an aborted probe is never ready');
  assert.equal(begins(), 0, 'not one of them opened a transaction');
});

test('a failure before COMMIT is unavailable; after COMMIT is sent, only a server ERROR is — anything else rejects with one fixed message', async () => {
  const good = command();
  const commitOn = (client: PgClient): Promise<unknown> =>
    Promise.resolve(createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] }).transactions.commit(good, live()));
  assert.deepEqual(await commitOn(scripted(good.lease)), COMMITTED, 'the scripted store commits a well-formed command');
  for (const [label, options] of [
    ['a serialization failure at the fence', { failAt: 'for update', error: serverError('40001') }],
    ['a deadlock at the event insert', { failAt: 'insert into tmpos_internal.outbox_event', error: serverError('40P01') }],
    ['an unknown SQLSTATE at the completion', { failAt: 'update tmpos_internal.idempotency_record', error: serverError('XX000') }],
    ['a value the driver cannot bind', { failAt: 'insert into tmpos_internal.outbox_event', error: driverError('UNDEFINED_VALUE') }],
    ['a statement the driver cancelled before sending it', { failAt: 'insert into tmpos_internal.outbox_event', error: driverError('57014') }],
    ['a connection lost mid-transaction', { failAt: 'insert into tmpos_internal.outbox_event', error: connectionError(), lost: true }],
    ['a session the server ends mid-transaction', { failAt: 'insert into tmpos_internal.outbox_event', error: serverError('25P03', 'FATAL'), lost: true }],
    ['a server ERROR at COMMIT, which rolled it back', { commit: serverError('23505') }],
  ] as const) {
    const client = scripted(good.lease, options);
    assert.deepEqual(await within(commitOn(client), 2_000), UNAVAILABLE, `${label}: nothing committed, and the answer comes at once`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.writesAfterLoss(), 0, `${label}: nothing is written to a lost connection`);
  }
  for (const [label, error] of [
    ['a connection lost at COMMIT', connectionError()],
    ['a FATAL at COMMIT', serverError('57P01', 'FATAL')],
    ['a connection exception at COMMIT', serverError('08006')],
  ] as const) {
    await assert.rejects(commitOn(scripted(good.lease, { commit: error })), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.deepEqual([err.message, Object.keys(err), err.cause], [OUTCOME_UNKNOWN, [], undefined], `${label}: indeterminate, and nothing of the driver kept`);
      return true;
    });
  }
  assert.deepEqual(await commitOn(scripted(digest())), LEASE_LOST, 'another lease on the record: fenced out');
});

test('the mutator is handed the values the store validated, read once and frozen — never the caller\'s live object', async () => {
  const good = command();
  let reads = 0;
  // Valid when first read, oversized on every read after: only a single read passes it.
  const flipping = Object.defineProperty({ quantity: 1 }, 'name', { enumerable: true, get: () => (reads++ === 0 ? 'n' : `n${'x'.repeat(8_192)}`) });
  let seen: unknown;
  const capturing: AggregateMutator = Object.freeze({ ...CREATE_MUTATOR, apply: async (_sql: unknown, m: { changes: unknown }) => { seen = m.changes; return 'applied'; } });
  const store = createPostgresTransactionalStore({ client: scripted(good.lease), mutators: [capturing] });
  assert.deepEqual(await store.transactions.commit({ ...good, mutation: { ...good.mutation, changes: flipping } }, live()), COMMITTED);
  assert.deepEqual([seen, Object.isFrozen(seen), reads], [{ name: 'n', quantity: 1 }, true, 1], 'the validated copy, read once');
});

test('the adapter reads no host clock, environment or console, binds no driver, and names every relation of its own in tmpos_internal', () => {
  const source = readFileSync(new URL('./postgresTransactionalStore.ts', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '');
  for (const forbidden of [/\bDate\.now\b/, /\bnew Date\b/, /\bperformance\.now\b/, /\bprocess\.env\b/, /\bconsole\./, /\.unsafe\s*\(/, /from\s+['"]postgres['"]/,
    /\bgetRuntimeDb\b/, /\bgetDb\b/, /\bsetInterval\b/, /\bsetTimeout\b/]) {
    assert.doesNotMatch(code, forbidden, `the adapter holds no ${forbidden}`);
  }
  // Every statement is a tagged template. The one plain call forwards the audit writer's own fixed template to the
  // transaction — never an identifier helper, a fragment or a string.
  assert.deepEqual([...code.matchAll(/\bsql\s*\(([^)]*)\)/g)].map((m) => m[1].trim()), ['strings, ...values']);
  for (const relation of ['idempotency_record', 'outbox_event', 'm6_store_clock']) {
    const bare = [...code.matchAll(new RegExp(`(^|[^.\\w])${relation}\\b`, 'g'))];
    assert.equal(bare.length, 0, `every use of ${relation} is qualified tmpos_internal.${relation}`);
    assert.ok(code.includes(`tmpos_internal.${relation}`), `and it is used: ${relation}`);
  }
  assert.doesNotMatch(code, /\bpublic\./, 'no relation of the store is named in public');
  assert.match(code, /set_config\('search_path', 'pg_catalog, pg_temp', true\)/, 'every transaction pins pg_catalog, pg_temp: no writable schema on its path');
  const audits = [...code.matchAll(/\bwriteAuditEvent\(([^)]*)\)/g)];
  assert.deepEqual(audits.map((m) => /\{\s*executor\s*\}/.test(m[1])), [true], 'the one audit write runs on the transaction, never the runtime pool');
});

test('an idle claim rolls back, so it is never indeterminate; one that dead-lettered a spent claim commits', async () => {
  const settled: string[] = [];
  let spentNow = 0;
  const client: PgClient = {
    async begin(fn) {
      const tx = ((strings: TemplateStringsArray) => {
        const rows = strings.join('$').includes('from exhausted') ? [{ spent: spentNow, event_id: null }] : [];
        return Object.assign(Promise.resolve(Object.assign(rows, { count: 0 })), { cancel: () => undefined });
      }) as unknown as PgTransaction;
      Object.assign(tx, { json: (value: unknown) => value });
      try {
        const result = await fn(tx);
        settled.push('COMMIT');
        return result;
      } catch (err) {
        settled.push('ROLLBACK');
        throw err;
      }
    },
  };
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] });
  const request = { claim: digest(), limit: 32, claimMs: 30_000 };
  assert.deepEqual(await store.delivery.claim(request, live()), { outcome: 'claimed', events: [] });
  spentNow = 1;
  assert.deepEqual(await store.delivery.claim(request, live()), { outcome: 'claimed', events: [] });
  assert.deepEqual(settled, ['ROLLBACK', 'COMMIT'], 'the same empty answer; only the claim that dead-lettered something commits');
});
