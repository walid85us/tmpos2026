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
import type { AggregateMutator, PgStatement } from './postgresTransactionalStore.js';
import { createSupervisedPgClient } from './supervisedPgClient.js';
import type { DriverPool, SupervisedPgClient } from './supervisedPgClient.js';
import { defineCommands, prepareCommand } from '../runtime/commandTransaction.js';
import type { TransactionCommand } from '../runtime/commandTransaction.js';
import type { TrustedScope } from '../runtime/principals.js';
import { createIdempotencyKeyring } from '../runtime/idempotency.js';
import { TEST_IDEMPOTENCY_KEY } from '../runtime/idempotencyStore.testkit.js';
import { defineOutboxEvents } from '../runtime/outbox.js';
import { TEST_CREATE, TEST_EVENTS } from '../runtime/transactionalOutbox.testkit.js';
import { TENANT_DISPLAY_NAME_CONTRACT, TENANT_DISPLAY_NAME_EVENTS, planTenantDisplayName } from '../runtime/tenantDisplayName.js';

const UNAVAILABLE = { outcome: 'unavailable' };
const LEASE_LOST = { outcome: 'lease_lost' };
const CLAIM_LOST = { outcome: 'claim_lost' };
const COMMITTED = { outcome: 'committed' };
const OUTCOME_UNKNOWN = 'transactional_store_outcome_unknown';

const digest = (): string => randomBytes(32).toString('base64url');
const live = (): AbortSignal => new AbortController().signal;
const CREATE_MUTATOR: AggregateMutator = Object.freeze({ kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', apply: async () => 'applied' });

/** A client the adapter must never reach: every transaction it opens is counted and refused. */
function untouched(): { readonly client: SupervisedPgClient; readonly begins: () => number } {
  let begins = 0;
  return { client: { transaction: async () => { begins++; throw new Error('the store was asked'); }, end: async () => undefined }, begins: () => begins };
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
 * The real transaction kernel over a scripted one-connection driver whose statements answer as a healthy store would for a
 * commit held by `lease`, then whose COMMIT succeeds or fails as `commit` says. `failAt` makes the first statement whose text
 * contains it fail with `error`; with `lost` that failure also closes the connection, as the driver reports one. `lose` closes
 * it from outside, between statements. Whatever the driver is handed after a close is counted: each is a write the real
 * driver would make to a dropped socket (doc 08, DA-15). `texts` is every statement handed over on the reserved connection, in
 * order; the statement the kernel opens a new pool's connection with answers and is not recorded.
 */
function scripted(lease: string, options: { failAt?: string; error?: Error; lost?: boolean; commit?: Error; spent?: () => number; completion?: string } = {}) {
  let writesAfterLoss = 0;
  const texts: string[] = [];
  const values: unknown[][] = [];
  let close: (err: Error) => void = () => undefined;
  const rowsFor = (text: string, values: readonly unknown[]): Record<string, unknown>[] => {
    if (text.includes('m6_command_fence')) return [{ held: values[1] === lease }];
    if (text.includes('m6_command_enqueue')) return [{ inserted: true }];
    if (text.includes('m6_idempotency_complete')) return [{ outcome: options.completion ?? 'completed' }];
    if (text.includes('m6_outbox_claim')) return [{ spent: options.spent?.() ?? 0, event_id: null }];
    return [{ ok: true }];
  };
  const driver = (_url: string, driverOptions: Record<string, unknown>): DriverPool => {
    let closed = false;
    let inFlight: { reject: (e: unknown) => void } | null = null;
    close = (err) => {
      if (closed) return;
      closed = true;
      inFlight?.reject(err);
      (driverOptions.onclose as (id: number) => void)(1);
    };
    const build = (reservedConnection: boolean) => (strings: TemplateStringsArray, ...boundValues: unknown[]) => {
      const text = strings.join('$');
      let resolveFn: (v: unknown) => void = () => undefined;
      let rejectFn: (e: unknown) => void = () => undefined;
      const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
      let started = false;
      const query = {
        handler: (q: typeof query) => {
          if (closed) { writesAfterLoss++; return; }
          if (reservedConnection) { texts.push(text); values.push(boundValues); }
          inFlight = q;
          const failed = reservedConnection && options.failAt !== undefined && text.includes(options.failAt);
          const commitFails = text === 'commit' && options.commit !== undefined;
          void Promise.resolve().then(() => {
            inFlight = null;
            if (failed && options.lost === true) { rejectFn(options.error); close(options.error as Error); } // the statement first, then the close
            else if (failed) rejectFn(options.error);
            else if (commitFails) rejectFn(options.commit);
            else { const rows = rowsFor(text, boundValues); resolveFn(Object.assign(rows, { count: rows.length, command: text.split(/\s/)[0].toUpperCase() })); }
          });
        },
        then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => {
          if (!started) { started = true; void Promise.resolve().then(() => query.handler(query)); }
          return promise.then(a, b);
        },
        reject: (e: unknown) => rejectFn(e),
        cancel: () => undefined,
      };
      return query;
    };
    const reserved = Object.assign(build(true), { json: (value: unknown) => ({ json: value }), release: () => { if (closed) writesAfterLoss++; } });
    return Object.assign(build(false), { reserve: async () => reserved, end: async () => { closed = true; } }) as unknown as DriverPool;
  };
  const client = createSupervisedPgClient(driver, 'postgres://unit.invalid/db', { max: 1 });
  return { transaction: client.transaction, end: client.end, writesAfterLoss: () => writesAfterLoss, lose: (err: Error) => close(err), texts, values };
}

const events = defineOutboxEvents(TEST_EVENTS);
const commands = defineCommands([TEST_CREATE], events);
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);

/** A trusted context as scope selection produces one: a platform actor with a security version. */
const TRUSTED: TrustedScope = Object.freeze({
  actor: '11111111-1111-4111-8111-111111111111', securityVersion: 'a'.repeat(64),
  scope: 'platform', tenant: null, store: null, membershipId: '55555555-5555-4555-8555-555555555555', roleId: 'system_owner', limitation: 'none',
});

/** A command exactly as the runtime prepares one. */
function command(context: TrustedScope | null = null): TransactionCommand {
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
    context,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null);
  return prepared.command;
}

test('construction refuses a malformed client, a raw driver pool or a malformed mutator table, and accepts the kernel', () => {
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
  assert.throws(() => createPostgresTransactionalStore({ client: Object.assign(() => undefined, { begin: async () => undefined }), mutators: [] } as never), TypeError,
    'a driver pool is refused: only the transaction kernel');
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] });
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
  const commitOn = (client: SupervisedPgClient): Promise<unknown> =>
    Promise.resolve(createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] }).transactions.commit(good, live()));
  assert.deepEqual(await commitOn(scripted(good.lease)), COMMITTED, 'the scripted store commits a well-formed command');
  for (const [label, options] of [
    ['a serialization failure at the fence', { failAt: 'm6_command_fence', error: serverError('40001') }],
    ['a deadlock at the event insert', { failAt: 'm6_command_enqueue', error: serverError('40P01') }],
    ['an unknown SQLSTATE at the completion', { failAt: 'm6_idempotency_complete', error: serverError('XX000') }],
    ['a value the driver cannot bind', { failAt: 'm6_command_enqueue', error: driverError('UNDEFINED_VALUE') }],
    ['a statement the driver cancelled before sending it', { failAt: 'm6_command_enqueue', error: driverError('57014') }],
    ['a connection lost mid-transaction', { failAt: 'm6_command_enqueue', error: connectionError(), lost: true }],
    ['a session the server ends mid-transaction', { failAt: 'm6_command_enqueue', error: serverError('25P03', 'FATAL'), lost: true }],
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

test('the adapter reads no host clock, environment or console, binds no driver, names no store table, and reaches the store only through 006\'s routines', () => {
  const source = readFileSync(new URL('./postgresTransactionalStore.ts', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '');
  for (const forbidden of [/\bDate\.now\b/, /\bnew Date\b/, /\bperformance\.now\b/, /\bprocess\.env\b/, /\bconsole\./, /\.unsafe\s*\(/, /from\s+['"]postgres['"]/,
    /\bgetRuntimeDb\b/, /\bgetDb\b/, /\bsetInterval\b/, /\bsetTimeout\b/]) {
    assert.doesNotMatch(code, forbidden, `the adapter holds no ${forbidden}`);
  }
  // Every statement is a tagged template. The one plain call forwards the audit writer's own fixed template to the
  // transaction — never an identifier helper, a fragment or a string.
  assert.deepEqual([...code.matchAll(/\bsql\s*\(([^)]*)\)/g)].map((m) => m[1].trim()), ['strings, ...values']);
  // The runtime role holds no privilege on either store table (migration 006, section 4), so the adapter names neither
  // table nor the clock, and writes nothing itself: every read and change of the store is one of 006's routines.
  for (const name of ['idempotency_record', 'outbox_event', 'm6_store_clock']) assert.ok(!code.includes(name), `the adapter never names ${name}`);
  assert.doesNotMatch(code, /\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i, 'and issues no write of its own');
  const routines = ['m6_idempotency_acquire', 'm6_idempotency_complete', 'm6_command_fence', 'm6_command_enqueue', 'm6_outbox_claim',
    'm6_outbox_acknowledge', 'm6_outbox_retry', 'm6_outbox_dead_letter', 'm6_store_probe'];
  assert.deepEqual([...new Set([...code.matchAll(/\b(m6_\w+)\s*\(/g)].map((m) => m[1]))].sort(), [...routines].sort(), 'it calls exactly the nine routines');
  for (const routine of routines) {
    assert.equal([...code.matchAll(new RegExp(`(^|[^.\\w])${routine}\\b`, 'g'))].length, 0, `every call of ${routine} is qualified tmpos_internal.${routine}`);
  }
  assert.doesNotMatch(code, /\bpublic\./, 'no relation of the store is named in public');
  for (const driverOnly of [/\.begin\s*\(/, /savepoint/i, /\.reserve\s*\(/, /\.release\s*\(/, /\bprepare\s+transaction\b/i]) {
    assert.doesNotMatch(code, driverOnly, `the adapter reaches the driver only through the kernel: no ${driverOnly}`);
  }
  const audits = [...code.matchAll(/\bwriteAuditEvent\(([^)]*)\)/g)];
  assert.deepEqual(audits.map((m) => /\{\s*executor\s*\}/.test(m[1])), [true], 'the one audit write runs on the transaction, never the runtime pool');
});

test('an idle claim rolls back, so it is never indeterminate; one that dead-lettered a spent claim commits', async () => {
  let spentNow = 0;
  const client = scripted(digest(), { spent: () => spentNow });
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] });
  const request = { claim: digest(), limit: 32, claimMs: 30_000 };
  assert.deepEqual(await store.delivery.claim(request, live()), { outcome: 'claimed', events: [] });
  spentNow = 1;
  assert.deepEqual(await store.delivery.claim(request, live()), { outcome: 'claimed', events: [] });
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback', 'commit'],
    'the same empty answer; only the claim that dead-lettered something commits');
});

test('a connection lost while the mutator waits between statements is handed nothing more — no statement, ROLLBACK or COMMIT — and the call is unavailable', async () => {
  for (const after of ['a statement', 'a refusal', 'completion'] as const) {
    const good = command();
    let inGap: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { inGap = resolve; });
    let resume: () => void = () => undefined;
    const gapped: AggregateMutator = Object.freeze({ ...CREATE_MUTATOR, apply: async (sql: PgStatement) => {
      await sql`select 1`;
      inGap();
      await new Promise<void>((resolve) => { resume = resolve; });
      if (after === 'a statement') await sql`select 2`;
      if (after === 'a refusal') throw new Error('M6-UNIT-CANARY refused after the gap');
      return 'applied';
    } });
    const client = scripted(good.lease);
    const answer = createPostgresTransactionalStore({ client, mutators: [gapped] }).transactions.commit(good, live());
    await waiting;
    client.lose(connectionError());
    assert.deepEqual(await within(Promise.resolve(answer), 2_000), UNAVAILABLE, `${after}: nothing committed, and the answer comes at once`);
    resume();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.writesAfterLoss(), 0, `${after}: nothing reaches the lost connection`);
  }
});

// ---------------------------------------------------------------------------
// M5-ID-P1 — transaction-local revalidation
// ---------------------------------------------------------------------------

test('a trusted context is re-read after the fence and before any business state', async () => {
  // The order is the whole point: a stale lease must still answer 'lease_lost' and learn nothing about
  // the identity, and a revoked actor must never reach a mutator.
  const order: string[] = [];
  const c = command(TRUSTED);
  const client = scripted(c.lease);
  const mutator: AggregateMutator = Object.freeze({
    kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item',
    apply: async () => { order.push('mutator'); return 'applied'; },
  });
  const store = createPostgresTransactionalStore({
    client, mutators: [mutator],
    revalidate: async (_sql, scope, permission) => {
      order.push('revalidate');
      assert.deepEqual(scope, TRUSTED);
      assert.equal(permission, 'conformance.write', 'the route\'s own requirement, from the audit record the runtime built');
      return true;
    },
  });

  assert.deepEqual(await store.transactions.commit(c, live()), COMMITTED);
  assert.deepEqual(order, ['revalidate', 'mutator'], 'the context is re-read before the mutation');
  const fenceAt = client.texts.findIndex((t) => t.includes('m6_command_fence'));
  assert.ok(fenceAt >= 0 && fenceAt < client.texts.findIndex((t) => t.includes('m6_command_enqueue')), 'the fence still runs first');
});

test('a lost lease refuses before the context is read at all', async () => {
  let asked = false;
  const c = command(TRUSTED);
  const store = createPostgresTransactionalStore({
    client: scripted('a'.repeat(43)), mutators: [CREATE_MUTATOR],
    revalidate: async () => { asked = true; return true; },
  });
  assert.deepEqual(await store.transactions.commit(c, live()), LEASE_LOST);
  assert.equal(asked, false, 'a stale attempt learns nothing about the actor');
});

test('a context that no longer holds commits nothing — no mutation, completion, audit or event', async () => {
  // Exactly true commits; false, a truthy value that is not true (a role name, as 007's routine answered) and a throw do not.
  for (const [label, answer] of [['revoked', async () => false], ['a truthy non-boolean', async () => 'system_owner' as never],
    ['a throw', async () => { throw new Error('M6-UNIT-CANARY revalidation fault'); }]] as const) {
    let applied = 0;
    const c = command(TRUSTED);
    const client = scripted(c.lease);
    const store = createPostgresTransactionalStore({
      client,
      mutators: [Object.freeze({ kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', apply: async () => { applied++; return 'applied'; } })],
      revalidate: answer,
    });
    assert.deepEqual(await store.transactions.commit(c, live()), UNAVAILABLE, label);
    assert.equal(applied, 0, `${label}: no mutator runs`);
    for (const forbidden of ['m6_command_enqueue', 'm6_idempotency_complete', 'insert into']) {
      assert.ok(!client.texts.some((t) => t.toLowerCase().includes(forbidden)), `${label}: no ${forbidden}`);
    }
    assert.ok(client.texts.includes('rollback'), `${label}: the transaction rolled back`);
  }
});

test('a context the store cannot revalidate is never committed', async () => {
  // No revalidator composed: a contextless command still commits, and a command carrying a context
  // does not — the store never commits an unrevalidated actor because its dependency is missing.
  const contextless = command();
  const withContext = command(TRUSTED);
  assert.deepEqual(await createPostgresTransactionalStore({ client: scripted(contextless.lease), mutators: [CREATE_MUTATOR] })
    .transactions.commit(contextless, live()), COMMITTED);
  const client = scripted(withContext.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] })
    .transactions.commit(withContext, live()), UNAVAILABLE);
  assert.ok(!client.texts.some((t) => t.includes('m6_command_enqueue')));
});

test('a context whose scope this transaction cannot prove is refused before any statement', async () => {
  // Tenant and store scopes wait on GAP-11 and on the audit writer carrying the tenant RLS context;
  // until then the store refuses rather than auditing at a scope it cannot prove.
  const tenant = '22222222-2222-4222-8222-222222222222';
  for (const scope of [
    { ...TRUSTED, scope: 'tenant' as const, tenant, roleId: 'manager' },
    { ...TRUSTED, scope: 'store' as const, tenant, store: '44444444-4444-4444-8444-444444444444', roleId: 'technician' },
  ]) {
    const c = command(scope);
    const store = untouched();
    assert.deepEqual(await createPostgresTransactionalStore({ client: store.client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
      .transactions.commit(c, live()), UNAVAILABLE, scope.scope);
    assert.equal(store.begins(), 0, 'no transaction opens');
  }
});

test('a read-only context may not commit a command at all', async () => {
  // A command is a write. The resolver marks the context read-only when the account, the tenant or the
  // store is read_only or overdue; the store refuses it rather than leaving the limiting to a caller.
  for (const limitation of ['read_only'] as const) {
    const c = command({ ...TRUSTED, limitation });
    const store = untouched();
    assert.deepEqual(await createPostgresTransactionalStore({ client: store.client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
      .transactions.commit(c, live()), UNAVAILABLE, limitation);
    assert.equal(store.begins(), 0, 'no transaction opens');
  }
});

test('an outbox event names no actor, tenant or store even under a trusted context', async () => {
  // Migration 006 types those columns as keyed digests, not identifiers; naming one would abort the
  // whole transaction at the constraint. The actor is attributed on the audit record instead.
  const c = command(TRUSTED);
  assert.deepEqual(c.events.map((e) => [e.tenant, e.store, e.actor]), c.events.map(() => [null, null, null]));
  assert.equal(c.audit.actor, TRUSTED.actor, 'the audit record does name it');
  const client = scripted(c.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
    .transactions.commit(c, live()), COMMITTED);
});

test('a command may not name an actor, tenant or store its context did not give it', async () => {
  const c = command(TRUSTED);
  const forged: unknown[] = [
    { ...c, context: null }, //                                       an audit actor with no context
    { ...c, audit: { ...c.audit, actor: 'someone-else' } }, //          an actor of the caller's choosing
    { ...c, audit: { ...c.audit, tenant: '22222222-2222-4222-8222-222222222222' } },
    { ...c, context: { ...TRUSTED, actor: 'root' } }, //                a context selection could not produce
    { ...c, events: c.events.map((e) => ({ ...e, actor: 'someone-else' })) },
  ];
  for (const raw of forged) {
    const store = untouched();
    assert.deepEqual(await createPostgresTransactionalStore({ client: store.client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
      .transactions.commit(raw as TransactionCommand, live()), UNAVAILABLE, JSON.stringify(raw).slice(0, 60));
    assert.equal(store.begins(), 0);
  }
});

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P1-R1 — the no-op's completion, and the audit record's subject
// ---------------------------------------------------------------------------

const TARGET_TENANT = '66666666-6666-4666-8666-666666666666';
const tenantEvents = defineOutboxEvents(TENANT_DISPLAY_NAME_EVENTS);

/** A display-name command exactly as the runtime prepares one: an update whose plan names its unchanged response. */
function renaming(context: TrustedScope | null = TRUSTED): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'PATCH', path: '/admin/v1/tenants/display-name', audience: 'admin', tenant: null, store: null, body: Buffer.from('{}'),
  });
  const plan = planTenantDisplayName({ audience: 'admin', body: { tenantId: TARGET_TENANT, displayName: 'Acme', expectedVersion: 3 }, newAggregateId: randomUUID() });
  const prepared = prepareCommand(TENANT_DISPLAY_NAME_CONTRACT, tenantEvents, plan, {
    scope: operation.scope, lease: digest(), newAggregateId: randomUUID(), authorization: Object.freeze({ scope: 'platform', permission: 'edit_tenant_profile' }),
    context, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null && prepared.command.unchanged !== null);
  return prepared.command;
}
const tenantMutator = (answer: string): AggregateMutator => Object.freeze({
  kind: TENANT_DISPLAY_NAME_CONTRACT.kind, mode: 'update', aggregateType: 'tenant', apply: async () => answer,
});

test('changes already in place commit exactly their sealed unchanged response as the completion, in the same transaction — no audit record, no event', async () => {
  const c = renaming();
  const client = scripted(c.lease);
  const store = createPostgresTransactionalStore({ client, mutators: [tenantMutator('unchanged')], revalidate: async () => true });
  assert.deepEqual(await store.transactions.commit(c, live()), { outcome: 'unchanged' });
  const at = (name: string): number => client.texts.findIndex((t) => t.includes(name));
  assert.ok(at('m6_command_fence') >= 0 && at('m6_command_fence') < at('m6_idempotency_complete'), 'the fence, then the completion, on one transaction');
  assert.notEqual(c.unchanged, c.response);
  assert.deepEqual(client.values[at('m6_idempotency_complete')], [c.scope, c.lease, c.unchanged],
    'the sealed unchanged response, under this attempt\'s lease — never the response of a change');
  for (const forbidden of ['m6_command_enqueue', 'insert into']) {
    assert.ok(!client.texts.some((t) => t.toLowerCase().includes(forbidden)), `nothing changed, so no ${forbidden}`);
  }
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit'], 'and the decision commits with its completion');
});

test('a no-op whose completion does not hold, or that carries no unchanged response, commits nothing', async () => {
  for (const [label, c, completion] of [
    ['a completion under a lease that no longer holds', renaming(), 'lease_lost'],
    ['a completion answer the store does not know', renaming(), 'maybe'],
    ['no unchanged response to record', { ...renaming(), unchanged: null }, 'completed'],
  ] as const) {
    const client = scripted(c.lease, { completion });
    const store = createPostgresTransactionalStore({ client, mutators: [tenantMutator('unchanged')], revalidate: async () => true });
    assert.deepEqual(await store.transactions.commit(c, live()), UNAVAILABLE, label);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], `${label}: rolled back, never committed`);
  }
  // With no response to record, nothing is even attempted: no completion statement reaches the store.
  const noResponse = { ...renaming(), unchanged: null };
  const client = scripted(noResponse.lease);
  await createPostgresTransactionalStore({ client, mutators: [tenantMutator('unchanged')], revalidate: async () => true }).transactions.commit(noResponse, live());
  assert.ok(!client.texts.some((t) => t.includes('m6_idempotency_complete')), 'no completion without an unchanged response');
});

test('an unchanged response belongs to an update alone, sealed exactly like the response — anything else is refused before a statement', async () => {
  const create = command();
  const update = renaming();
  const { client, begins } = untouched();
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR, tenantMutator('applied')], revalidate: async () => true });
  const { unchanged: _dropped, ...withoutField } = update;
  for (const [label, raw] of [
    ['a create carrying one', { ...create, unchanged: update.unchanged }],
    ['one that is not sealed text', { ...update, unchanged: 'a=b' }],
    ['an empty one', { ...update, unchanged: '' }],
    ['one that is not text', { ...update, unchanged: 7 }],
    ['a command without the field', withoutField],
  ] as const) assert.deepEqual(await store.transactions.commit(raw as never, live()), UNAVAILABLE, label);
  assert.equal(begins(), 0, 'not one of them opened a transaction');
});

test('the audit record names a tenant command\'s own target as its subject — no caller value, and no other command names one', async () => {
  const c = renaming();
  const client = scripted(c.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client, mutators: [tenantMutator('applied')], revalidate: async () => true })
    .transactions.commit(c, live()), COMMITTED);
  const audit = client.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(audit >= 0 && client.texts[audit].includes('subject_tenant_id'), 'the statement names the subject column');
  const bound = client.values[audit];
  assert.equal(bound[bound.length - 1], TARGET_TENANT, 'the subject is the command\'s own validated target');
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9]], [TRUSTED.actor, 'platform', null, null],
    'the actor stays the trusted context\'s, the scope stays platform, and the scope still names no tenant');

  // A command of another aggregate names no subject: its statement is the one every writer used before 009.
  const other = command(TRUSTED);
  const otherClient = scripted(other.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client: otherClient, mutators: [CREATE_MUTATOR], revalidate: async () => true })
    .transactions.commit(other, live()), COMMITTED);
  const otherAudit = otherClient.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(otherAudit >= 0 && !otherClient.texts[otherAudit].includes('subject_tenant_id'));

  // The caller cannot hand one in: the audit record it sends has exactly its seven fields.
  const { client: untouchedClient, begins } = untouched();
  assert.deepEqual(await createPostgresTransactionalStore({ client: untouchedClient, mutators: [tenantMutator('applied')], revalidate: async () => true })
    .transactions.commit({ ...c, audit: { ...c.audit, subjectTenantId: randomUUID() } } as never, live()), UNAVAILABLE);
  assert.equal(begins(), 0);
});
