// Phase 4.0 M6 — TEST SUPPORT ONLY: one synthetic transactional store — idempotency records, business
// aggregates, the append-only audit record and the outbox — its in-process command-transaction and
// delivery adapters, and the conformance suites every durable adapter must pass before it is approved.
//
// Excluded from the deployable artifact (tsconfig.server.json) and imported by no production module and
// nothing the production composition root reaches (tests/quality/production-runtime-contract.test.mjs).
// The in-process adapters are synchronous, so they are atomic by construction and prove nothing about
// interleaving or isolation: no adapter for either port is approved (server/composition binds none), and a
// PostgreSQL adapter must first pass both suites — and assertIdempotencyStoreContract — over two instances
// of one real database, with fault injection and interleaved statements.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandContract, CommandTransactionDeps, CommandTransactionPort, TransactionAudit, TransactionCommand } from './commandTransaction.js';
import { createIdempotencyKeyring } from './idempotency.js';
import type { DurableIdempotencyStore, OperationIdentity } from './idempotency.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyState, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import type { MemoryIdempotencyState } from './idempotencyStore.testkit.js';
import { OUTBOX_DELIVERY_POLICY, defineOutboxEvents } from './outbox.js';
import type { DeadLetterReason, EventContract, OutboxDeliveryStore, OutboxEnvelope, RecordValue } from './outbox.js';

const NAME = Object.freeze({ type: 'string', maxLength: 64 } as const);
const QUANTITY = Object.freeze({ type: 'integer', min: 0, max: 1_000 } as const);

/** Synthetic event contracts for tests and the conformance suites; never a deployment's. */
export const TEST_EVENTS: readonly EventContract[] = Object.freeze([
  Object.freeze({ type: 'conformance.item.created', version: 1, aggregateType: 'item', payload: Object.freeze({ name: NAME, quantity: QUANTITY }) }),
  Object.freeze({ type: 'conformance.item.renamed', version: 1, aggregateType: 'item', payload: Object.freeze({ name: NAME }) }),
]);

/** A synthetic create command: a new item and its `created` event. */
export const TEST_CREATE: CommandContract = Object.freeze({
  kind: 'conformance.item.create', mode: 'create', aggregateType: 'item', changes: Object.freeze({ name: NAME, quantity: QUANTITY }),
  events: Object.freeze([Object.freeze({ type: 'conformance.item.created', version: 1 })]),
});

/** A synthetic update command: an item's new name at its version, and its `renamed` event. */
export const TEST_RENAME: CommandContract = Object.freeze({
  kind: 'conformance.item.rename', mode: 'update', aggregateType: 'item', changes: Object.freeze({ name: NAME }),
  events: Object.freeze([Object.freeze({ type: 'conformance.item.renamed', version: 1 })]),
});

/** The part of a commit an injected failure strikes, inside the transaction. */
export type TransactionComponent = 'mutation' | 'audit' | 'outbox' | 'completion';
export type DeliveryStatus = 'pending' | 'claimed' | 'delivered' | 'dead';

/** An audit record as committed: the command's own, and the transaction timestamp the store stamped. */
export interface CommittedAudit extends TransactionAudit {
  readonly at: number;
}

interface StoredEvent {
  readonly envelope: OutboxEnvelope;
  readonly status: DeliveryStatus;
  readonly attempt: number;
  readonly dueAt: number;
  readonly claim: string | null;
  readonly claimExpiresAt: number;
  readonly reason: DeadLetterReason | null;
}

/** The synthetic store every instance shares, as runtime instances and workers share one database. */
export interface MemoryTransactionalState {
  readonly now: () => number;
  readonly idempotency: MemoryIdempotencyState;
  readonly aggregates: Map<string, Readonly<{ version: number; state: RecordValue }>>;
  readonly audit: CommittedAudit[];
  readonly outbox: Map<string, StoredEvent>;
  /**
   * Test control: the next commit that reaches its writes fails, inside the transaction. This adapter's
   * commit is one synchronous step, so it raises the failure before applying any part — a rollback by
   * construction; a harness over a real store fails the named part's own statement.
   */
  fault: TransactionComponent | null;
}

export function createMemoryTransactionalState(options: { now?: () => number } = {}): MemoryTransactionalState {
  const now = options.now ?? Date.now;
  return { now, idempotency: createMemoryIdempotencyState({ now }), aggregates: new Map(), audit: [], outbox: new Map(), fault: null };
}

const aggregateKey = (type: string, id: string): string => `${type}/${id}`;

/**
 * One command-transaction instance over `state`. Each commit runs to completion synchronously, so it is
 * atomic across every instance sharing the state — and it meets the contract nowhere else: it survives no
 * restart and shares nothing with another process.
 */
export function createMemoryCommandTransaction(state: MemoryTransactionalState): CommandTransactionPort {
  return {
    commit(command: TransactionCommand, signal: AbortSignal) {
      if (signal.aborted) return { outcome: 'unavailable' };
      const t = state.now();
      const records = state.idempotency.records;
      const record = records.get(command.scope);
      // The fence first: a stale, reclaimed or completed attempt learns nothing of business state.
      if (record === undefined || t >= record.expiresAt || record.response !== null || record.lease !== command.lease) return { outcome: 'lease_lost' };
      const { mutation } = command;
      const key = aggregateKey(mutation.aggregateType, mutation.aggregateId);
      const current = state.aggregates.get(key);
      if (mutation.expectedVersion === null ? current !== undefined : current?.version !== mutation.expectedVersion) return { outcome: 'conflict' };
      const ids = command.events.map((event) => event.eventId);
      if (new Set(ids).size !== ids.length || ids.some((id) => state.outbox.has(id))) return { outcome: 'unavailable' }; // a fault, never a conflict
      // Every write lands together or not at all: one synchronous step, in which an injected failure is
      // raised before anything is applied — a rollback by construction.
      const fault = state.fault;
      state.fault = null;
      if (fault !== null) throw new Error(`injected ${fault} failure`);
      state.aggregates.set(key, Object.freeze({
        version: (mutation.expectedVersion ?? 0) + 1, state: Object.freeze({ ...(current?.state ?? {}), ...mutation.changes }),
      }));
      state.audit.push(Object.freeze({ ...command.audit, at: t }));
      for (const event of command.events) {
        state.outbox.set(event.eventId, Object.freeze({
          envelope: Object.freeze({ ...event, occurredAt: t }), status: 'pending', attempt: 0, dueAt: t, claim: null, claimExpiresAt: 0, reason: null,
        }));
      }
      records.set(command.scope, { ...record, response: command.response });
      return { outcome: 'committed' };
    },
    probe: () => true,
  };
}

/** One delivery-store instance over `state`; atomic across instances in one process, as above. */
export function createMemoryOutboxDeliveryStore(state: MemoryTransactionalState): OutboxDeliveryStore {
  const settle = (eventId: string, claim: string, signal: AbortSignal, success: string, next: (event: StoredEvent, t: number) => StoredEvent): unknown => {
    if (signal.aborted) return { outcome: 'unavailable' };
    const event = state.outbox.get(eventId);
    // Only the claim's current holder settles — an expired claim nobody has reclaimed included.
    if (event === undefined || event.status !== 'claimed' || event.claim !== claim) return { outcome: 'claim_lost' };
    state.outbox.set(eventId, Object.freeze(next(event, state.now())));
    return { outcome: success };
  };
  return {
    claim(request, signal) {
      if (signal.aborted) return { outcome: 'unavailable' };
      const t = state.now();
      const events: Array<{ eventId: string; attempt: number; envelope: OutboxEnvelope }> = [];
      // inv: events holds the eligible events met so far, each now claimed under this token; term: the scan ends or the batch fills.
      for (const [eventId, event] of state.outbox) {
        if (events.length >= request.limit) break;
        const eligible = event.status === 'pending' ? event.dueAt <= t : event.status === 'claimed' && event.claimExpiresAt <= t;
        if (!eligible) continue;
        const attempt = event.attempt + 1;
        state.outbox.set(eventId, Object.freeze({ ...event, status: 'claimed', attempt, claim: request.claim, claimExpiresAt: t + request.claimMs }));
        events.push({ eventId, attempt, envelope: event.envelope });
      }
      return { outcome: 'claimed', events };
    },
    acknowledge: (request, signal) => settle(request.eventId, request.claim, signal, 'acknowledged', (event) => ({ ...event, status: 'delivered', claim: null })),
    retry: (request, signal) => settle(request.eventId, request.claim, signal, 'scheduled',
      (event, t) => ({ ...event, status: 'pending', dueAt: t + request.delayMs, claim: null })),
    deadLetter: (request, signal) => settle(request.eventId, request.claim, signal, 'dead_lettered',
      (event) => ({ ...event, status: 'dead', claim: null, reason: request.reason })),
    probe: () => true,
  };
}

/** A transaction port over `state`, for tests that are not about the store. */
export function testTransactions(state: MemoryTransactionalState): CommandTransactionDeps {
  return { port: createMemoryCommandTransaction(state) };
}

/** What a store has committed: aggregates, audit records, and events with their delivery status. */
export interface CommittedState {
  readonly aggregates: readonly Readonly<{ type: string; id: string; version: number; state: RecordValue }>[];
  readonly audit: readonly CommittedAudit[];
  readonly events: readonly Readonly<{ envelope: OutboxEnvelope; status: DeliveryStatus; attempt: number }>[];
}

export function inspectMemoryState(state: MemoryTransactionalState): CommittedState {
  return Object.freeze({
    aggregates: Object.freeze([...state.aggregates].map(([key, aggregate]) => {
      const [type, id] = key.split('/');
      return Object.freeze({ type, id, version: aggregate.version, state: aggregate.state });
    })),
    audit: Object.freeze([...state.audit]),
    events: Object.freeze([...state.outbox.values()].map((event) => Object.freeze({ envelope: event.envelope, status: event.status, attempt: event.attempt }))),
  });
}

/** What the conformance suites drive. Every method is required: none of the checks is optional. */
export interface TransactionalOutboxHarness {
  /** The idempotency store over the same durable state: the lease a commit checks is its record's. */
  readonly idempotency: DurableIdempotencyStore;
  readonly transaction: CommandTransactionPort;
  /** A second commit instance over the same state (never the same object). */
  readonly transactionPeer: CommandTransactionPort;
  readonly delivery: OutboxDeliveryStore;
  /** A second delivery instance over the same state (never the same object). */
  readonly deliveryPeer: OutboxDeliveryStore;
  /** Move the store's clock forward by `ms`; a harness over real time waits instead. */
  advance(ms: number): void | Promise<void>;
  /** Make the shared store unreachable to every instance. */
  breakStore(): void | Promise<void>;
  /** Make it reachable again. */
  restoreStore(): void | Promise<void>;
  /** Make the next commit that reaches its writes fail at `component`, inside its transaction. */
  failNextCommit(component: TransactionComponent): void | Promise<void>;
  /** What the store has committed, read outside every transaction of the ports'. */
  inspect(): CommittedState | Promise<CommittedState>;
}

export interface MemoryTransactionalHarness extends TransactionalOutboxHarness {
  readonly state: MemoryTransactionalState;
  readonly clock: { t: number };
}

/** The in-process adapters as a harness: two instances of each port over one state and one clock. */
export function createMemoryTransactionalHarness(): MemoryTransactionalHarness {
  const clock = { t: 1_700_000_000_000 };
  const state = createMemoryTransactionalState({ now: () => clock.t });
  let broken = false;
  const down = { outcome: 'unavailable' };
  const idempotency = createMemoryIdempotencyStore(state.idempotency);
  const transactionOf = (): CommandTransactionPort => {
    const inner = createMemoryCommandTransaction(state);
    return { commit: (c, s) => (broken ? down : inner.commit(c, s)), probe: (s) => !broken && inner.probe(s) };
  };
  const deliveryOf = (): OutboxDeliveryStore => {
    const inner = createMemoryOutboxDeliveryStore(state);
    return {
      claim: (r, s) => (broken ? down : inner.claim(r, s)),
      acknowledge: (r, s) => (broken ? down : inner.acknowledge(r, s)),
      retry: (r, s) => (broken ? down : inner.retry(r, s)),
      deadLetter: (r, s) => (broken ? down : inner.deadLetter(r, s)),
      probe: (s) => !broken && inner.probe(s),
    };
  };
  return {
    state,
    clock,
    idempotency: {
      acquire: (r, s) => (broken ? down : idempotency.acquire(r, s)),
      complete: (r, s) => (broken ? down : idempotency.complete(r, s)),
      probe: (s) => !broken && idempotency.probe(s),
    },
    transaction: transactionOf(),
    transactionPeer: transactionOf(),
    delivery: deliveryOf(),
    deliveryPeer: deliveryOf(),
    advance: (ms) => { clock.t += ms; },
    breakStore: () => { broken = true; },
    restoreStore: () => { broken = false; },
    failNextCommit: (component) => { state.fault = component; },
    inspect: () => inspectMemoryState(state),
  };
}

const LEASE_MS = 60_000;
const RETAIN_MS = 600_000;
const CLAIM_MS = 30_000;
const ACQUIRED = { outcome: 'acquired', reclaimed: false };
const RECLAIMED = { outcome: 'acquired', reclaimed: true };
const IN_PROGRESS = { outcome: 'in_progress' };
const COMMITTED = { outcome: 'committed' };
const LEASE_LOST = { outcome: 'lease_lost' };
const CONFLICT = { outcome: 'conflict' };
const UNAVAILABLE = { outcome: 'unavailable' };
const EMPTY = { outcome: 'claimed', events: [] };
const ACKNOWLEDGED = { outcome: 'acknowledged' };
const SCHEDULED = { outcome: 'scheduled' };
const DEAD_LETTERED = { outcome: 'dead_lettered' };
const CLAIM_LOST = { outcome: 'claim_lost' };
const NOTHING = { aggregate: null, audit: [], events: [] };

/** Whether `call` settles — resolves or rejects — within `ms`. */
async function settles(call: () => unknown, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  const done = Promise.resolve().then(call).then(() => true, () => true);
  try {
    return await Promise.race([done, hung]);
  } finally {
    clearTimeout(timer);
  }
}

interface Attempt { readonly operation: OperationIdentity; readonly lease: string }
interface Footprint {
  readonly aggregate: CommittedState['aggregates'][number] | null;
  readonly audit: readonly CommittedAudit[];
  readonly events: CommittedState['events'];
}

/** The runtime's own validation and sealing, over the harness: the suites send exactly what the runtime would. */
function conformanceKit(h: TransactionalOutboxHarness) {
  const events = defineOutboxEvents(TEST_EVENTS);
  const commands = defineCommands([TEST_CREATE, TEST_RENAME], events);
  const create = commands.contract(TEST_CREATE.kind) as CommandContract;
  const rename = commands.contract(TEST_RENAME.kind) as CommandContract;
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const run = randomBytes(6).toString('hex');
  let serial = 0;
  const live = (): AbortSignal => new AbortController().signal;
  const lease = (): string => randomBytes(32).toString('base64url');
  const acquire = (operation: OperationIdentity, held: string): Promise<unknown> =>
    Promise.resolve().then(() => h.idempotency.acquire(Object.freeze({ ...operation, lease: held, leaseMs: LEASE_MS, retentionMs: RETAIN_MS }), live()));
  /** An operation nobody has acquired. */
  const operationOf = (): OperationIdentity => keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'conformance', authProviderUid: `${run}-actor` }), {
    method: 'POST', path: '/v1/conformance', audience: null, tenant: null, store: null, body: Buffer.from(`{"n":${++serial}}`),
  });
  /** A fresh operation, its lease acquired. */
  const begin = async (): Promise<Attempt> => {
    const operation = operationOf();
    const held = lease();
    assert.deepEqual(await acquire(operation, held), ACQUIRED, 'a fresh operation is acquired');
    return { operation, lease: held };
  };
  const prepared = (contract: CommandContract, attempt: Attempt, held: string, newAggregateId: string, plan: unknown): TransactionCommand => {
    const result = prepareCommand(contract, events, plan, {
      scope: attempt.operation.scope, lease: held, newAggregateId, authorization: Object.freeze({ scope: 'platform', permission: 'conformance.write' }),
      seal: (envelope) => keyring.seal(envelope, attempt.operation),
    });
    assert.ok(result !== null, 'the conformance plans are in contract');
    return result.command;
  };
  /** A create of `aggregateId` (fresh by default) under `held` (the attempt's lease by default). */
  const creating = (attempt: Attempt, over: { name?: string; aggregateId?: string; lease?: string } = {}): TransactionCommand => {
    const name = over.name ?? `item-${++serial}`;
    const aggregateId = over.aggregateId ?? randomUUID();
    return prepared(create, attempt, over.lease ?? attempt.lease, aggregateId, {
      aggregateId, expectedVersion: null, changes: { name, quantity: 1 }, events: [{ type: 'conformance.item.created', payload: { name, quantity: 1 } }],
      response: { status: 201, body: { id: aggregateId } },
    });
  };
  /** A rename of `aggregateId` at `version`. */
  const renaming = (attempt: Attempt, aggregateId: string, version: number): TransactionCommand => {
    const name = `renamed-${++serial}`;
    return prepared(rename, attempt, attempt.lease, randomUUID(), {
      aggregateId, expectedVersion: version, changes: { name }, events: [{ type: 'conformance.item.renamed', payload: { name } }],
      response: { status: 200, body: { id: aggregateId, name } },
    });
  };
  const commit = (command: TransactionCommand, instance = h.transaction, signal = live()): Promise<unknown> =>
    Promise.resolve().then(() => instance.commit(command, signal));
  /** An answer, a rejection read as an outage. */
  const settled = (answer: Promise<unknown>): Promise<unknown> => answer.catch(() => UNAVAILABLE);
  /** What the store holds of one command: its aggregate, its audit records and its events. */
  const footprint = async (command: TransactionCommand): Promise<Footprint> => {
    const committed = await h.inspect();
    return {
      aggregate: committed.aggregates.find((a) => a.type === command.mutation.aggregateType && a.id === command.mutation.aggregateId) ?? null,
      audit: committed.audit.filter((a) => a.correlationId === command.audit.correlationId),
      events: committed.events.filter((e) => command.events.some((draft) => draft.eventId === e.envelope.eventId)),
    };
  };
  return { live, lease, acquire, operationOf, begin, creating, renaming, commit, settled, footprint };
}

const isCommitted = (answer: unknown): boolean => isDeepStrictEqual(answer, COMMITTED);

/**
 * The command-transaction contract (commandTransaction.ts), run against any adapter over two instances:
 * a healthy probe answers exactly true; one commit writes the aggregate, one audit record, every event
 * (stamped with the audit record's transaction timestamp, every value bound as data) and the completion,
 * which replays; an operation commits once; a lease never granted, an operation never acquired and a
 * reclaimed lease commit nothing, the lease checked before business state; an expired lease nobody
 * reclaimed commits until its retention ends; a conflict writes nothing and keeps the lease, and a reused
 * event ID is a fault; a failure at any part leaves no part and keeps the lease; of concurrent commits
 * exactly one lands; an aborted commit changes nothing and one aborted in flight is all or nothing; a
 * commit whose answer is lost replays; each commit carries its own transaction's time; an unreachable
 * store fails closed on both instances, keeps its state and queues nothing.
 */
export async function assertCommandTransactionContract(h: TransactionalOutboxHarness): Promise<void> {
  const { transaction, transactionPeer: peer } = h;
  assert.notEqual(peer, transaction, 'the peer is a second adapter instance, never the same object');
  const k = conformanceKit(h);

  // 1. A store that can serve answers the probe with exactly true, on both instances.
  for (const instance of [transaction, peer]) assert.equal(await instance.probe(k.live()), true, 'a store that can serve answers the probe with exactly true');

  // 2. One commit writes every part together: the aggregate with exactly its changes at version 1, one audit
  //    record, every event — stamped with the transaction timestamp the audit record carries — and the
  //    completion, which then replays. A value that looks like SQL is data, stored as sent.
  const a = await k.begin();
  const hostile = `O'Brien"); DROP TABLE item; --`;
  const first = k.creating(a, { name: hostile });
  assert.deepEqual(await k.commit(first, peer), COMMITTED, 'the lease holder commits, through either instance');
  const fa = await k.footprint(first);
  assert.deepEqual(fa.aggregate, { type: 'item', id: first.mutation.aggregateId, version: 1, state: { name: hostile, quantity: 1 } },
    'the aggregate is created at version 1 with exactly its changes, every value bound as data');
  assert.equal(fa.audit.length, 1, 'with exactly one audit record');
  const { at, ...audited } = fa.audit[0];
  assert.deepEqual(audited, first.audit, 'the audit record as the command carried it');
  assert.ok(Number.isSafeInteger(at) && at > 0, 'stamped with the transaction timestamp');
  assert.deepEqual(fa.events.map((e) => e.envelope), first.events.map((draft) => ({ ...draft, occurredAt: at })),
    'every event enqueued as sent, stamped with that same transaction timestamp');
  assert.ok(fa.events.length === first.events.length && fa.events.every((e) => e.status === 'pending' && e.attempt === 0), 'pending, never yet claimed');
  assert.deepEqual(await k.acquire(a.operation, k.lease()), { outcome: 'replay', response: first.response }, 'the completion replays byte for byte');

  // 3. An operation commits once: not the same command again, nor another under its lease, on either instance.
  assert.deepEqual(await k.commit(first), LEASE_LOST, 'a completed operation accepts no second commit');
  const second = k.creating(a);
  assert.deepEqual(await k.commit(second, peer), LEASE_LOST, 'nor another command under its lease');
  assert.deepEqual(await k.footprint(second), NOTHING, 'which wrote nothing');
  assert.deepEqual(await k.footprint(first), fa, 'and the first commit is unchanged: one immutable event set');

  // 4. Fencing. A lease the store never granted, an operation nobody acquired and a lease a reclaim replaced
  //    commit nothing, whatever the command — the lease is checked before business state — and the
  //    reclaimer commits. An expired lease nobody reclaimed still commits, until its retention ends.
  const f = await k.begin();
  assert.deepEqual(await k.commit(k.creating(f, { lease: k.lease() })), LEASE_LOST, 'a lease the store never granted commits nothing');
  assert.deepEqual(await k.commit(k.creating({ operation: k.operationOf(), lease: k.lease() }), peer), LEASE_LOST, 'nor does an operation nobody acquired');
  await h.advance(LEASE_MS);
  const fresh = k.lease();
  assert.deepEqual(await k.acquire(f.operation, fresh), RECLAIMED, 'the expired lease is reclaimed');
  const stale = k.creating(f);
  assert.deepEqual(await k.commit(stale), LEASE_LOST, 'the reclaimed attempt is fenced out');
  assert.deepEqual(await k.footprint(stale), NOTHING, 'and writes nothing');
  assert.deepEqual(await k.commit(k.creating(f, { aggregateId: first.mutation.aggregateId }), peer), LEASE_LOST,
    'a fenced attempt learns nothing of business state: the lease is checked before the aggregate');
  assert.deepEqual(await k.commit(k.creating({ ...f, lease: fresh }), peer), COMMITTED, 'the reclaimer commits');
  const late = await k.begin();
  const lateCommand = k.creating(late);
  await h.advance(LEASE_MS + 1);
  assert.deepEqual(await k.commit(lateCommand, peer), COMMITTED, 'an expired lease nobody reclaimed still commits');
  const kept = await k.begin();
  const keptCommand = k.creating(kept);
  const gone = await k.begin();
  const goneCommand = k.creating(gone);
  await h.advance(RETAIN_MS - 1);
  assert.deepEqual(await k.commit(keptCommand, peer), COMMITTED, 'on the peer too, until its retention ends');
  await h.advance(1);
  assert.deepEqual(await k.commit(goneCommand, peer), LEASE_LOST, 'past its retention an operation commits nothing');
  assert.deepEqual(await k.footprint(goneCommand), NOTHING);

  // 5. A conflict — creating an existing aggregate, updating at a version it is not at — writes nothing and
  //    keeps the lease; a reused event ID is a fault, never committed. The same instance then commits.
  const c = await k.begin();
  const id = first.mutation.aggregateId;
  const exists = k.creating(c, { aggregateId: id });
  assert.deepEqual(await k.commit(exists), CONFLICT, 'creating an existing aggregate conflicts');
  const staleVersion = k.renaming(c, id, 7);
  assert.deepEqual(await k.commit(staleVersion), CONFLICT, 'updating at a version it is not at conflicts');
  const renamed = k.renaming(c, id, 1);
  const reusing: TransactionCommand = Object.freeze({
    ...renamed, events: Object.freeze([Object.freeze({ ...renamed.events[0], eventId: first.events[0].eventId })]),
  });
  assert.deepEqual(await k.settled(k.commit(reusing)), UNAVAILABLE, 'a reused event ID is a fault: nothing commits, and it is no conflict');
  for (const refused of [exists, staleVersion, reusing]) assert.deepEqual((await k.footprint(refused)).audit, [], 'no refusal wrote an audit record');
  assert.equal((await k.footprint(renamed)).aggregate?.version, 1, 'nor changed the aggregate');
  assert.deepEqual((await k.footprint(first)).events, fa.events, 'nor the event whose ID was reused');
  assert.deepEqual(await k.commit(renamed), COMMITTED, 'no refusal changed anything: the holder commits, on the same instance');
  const fr = await k.footprint(renamed);
  assert.deepEqual([fr.aggregate?.version, fr.aggregate?.state.name, fr.audit.length, fr.events.length], [2, renamed.mutation.changes.name, 1, 1],
    'the update is written at the next version');
  assert.deepEqual(await k.commit(k.creating(await k.begin())), COMMITTED, 'and after the refusals the same instance commits an unrelated operation');

  // 6. A failure at any part rolls every part back and keeps the lease, so the holder commits after it.
  for (const component of ['mutation', 'audit', 'outbox', 'completion'] as const) {
    const p = await k.begin();
    const command = k.creating(p);
    await h.failNextCommit(component);
    assert.deepEqual(await k.settled(k.commit(command)), UNAVAILABLE, `a failure at the ${component} commits nothing`);
    assert.deepEqual(await k.footprint(command), NOTHING, `a failure at the ${component} leaves no part behind`);
    assert.deepEqual(await k.acquire(p.operation, k.lease()), IN_PROGRESS, `a failure at the ${component} records no completion: the lease holds`);
    assert.deepEqual(await k.commit(command, peer), COMMITTED, `the holder commits after a failure at the ${component}`);
  }

  // 7. Concurrency across both instances: of many commits under one lease exactly one lands and the rest are
  //    fenced; of many operations creating one aggregate, or updating it at one version, exactly one lands.
  const one = await k.begin();
  const racers = Array.from({ length: 20 }, () => k.creating(one));
  const raced = await Promise.all(racers.map((command, i) => k.commit(command, i % 2 === 0 ? transaction : peer)));
  assert.equal(raced.filter(isCommitted).length, 1, 'exactly one commit under one lease');
  for (const [i, answer] of raced.entries()) {
    const footprint = await k.footprint(racers[i]);
    if (isCommitted(answer)) {
      assert.deepEqual([footprint.aggregate?.version, footprint.audit.length, footprint.events.length], [1, 1, 1], 'the one that landed wrote every part');
    } else {
      assert.deepEqual(answer, LEASE_LOST, 'every other commit under the lease is fenced');
      assert.deepEqual(footprint, NOTHING, 'and wrote nothing');
    }
  }
  const contested = randomUUID();
  const creators = await Promise.all(Array.from({ length: 12 }, () => k.begin()));
  const creations = creators.map((attempt) => k.creating(attempt, { aggregateId: contested }));
  const created = await Promise.all(creations.map((command, i) => k.commit(command, i % 2 === 0 ? peer : transaction)));
  assert.equal(created.filter(isCommitted).length, 1, 'exactly one of many operations creates one aggregate');
  assert.ok(created.every((answer) => isCommitted(answer) || isDeepStrictEqual(answer, CONFLICT)), 'every other conflicts');
  const creationTraces = await Promise.all(creations.map((command) => k.footprint(command)));
  assert.deepEqual([creationTraces.flatMap((t) => t.audit).length, creationTraces.flatMap((t) => t.events).length], [1, 1], 'and only the one wrote its audit record and event');
  const renamers = await Promise.all(Array.from({ length: 12 }, () => k.begin()));
  const renames = renamers.map((attempt) => k.renaming(attempt, contested, 1));
  const renamedTo = await Promise.all(renames.map((command, i) => k.commit(command, i % 2 === 0 ? transaction : peer)));
  assert.equal(renamedTo.filter(isCommitted).length, 1, 'exactly one of many updates at one version lands');
  assert.ok(renamedTo.every((answer) => isCommitted(answer) || isDeepStrictEqual(answer, CONFLICT)), 'every other conflicts');
  assert.equal((await k.footprint(renames[0])).aggregate?.version, 2, 'and the aggregate moved one version');

  // 8. A call handed an already-aborted signal changes nothing; one aborted in flight lands entirely or not at all.
  const ab = await k.begin();
  const abCommand = k.creating(ab);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await settles(() => transaction.commit(abCommand, aborted.signal), 1_000), true, 'an aborted commit settles');
  assert.deepEqual(await k.footprint(abCommand), NOTHING, 'and changes nothing');
  assert.deepEqual(await k.acquire(ab.operation, k.lease()), IN_PROGRESS, 'its lease still held');
  const mid = new AbortController();
  const inFlight = k.settled(k.commit(abCommand, peer, mid.signal));
  await new Promise((resolve) => setImmediate(resolve)); // the commit has started when the abort fires
  mid.abort();
  await inFlight;
  const fm = await k.footprint(abCommand);
  const replayed = isDeepStrictEqual(await k.acquire(ab.operation, k.lease()), { outcome: 'replay', response: abCommand.response });
  assert.ok(replayed ? fm.aggregate !== null && fm.audit.length === 1 && fm.events.length === 1 : isDeepStrictEqual(fm, NOTHING),
    'a commit aborted in flight landed entirely, completion included, or not at all');
  if (!replayed) assert.deepEqual(await k.commit(abCommand), COMMITTED, 'and when it did not land, the holder still commits');

  // 9. An answer lost after the commit is no rollback: the operation replays, and nothing re-acquires it.
  const lost = await k.begin();
  const lostCommand = k.creating(lost);
  await k.commit(lostCommand, peer); // its answer dropped, as a connection cut just after COMMIT drops it
  assert.deepEqual(await k.acquire(lost.operation, k.lease()), { outcome: 'replay', response: lostCommand.response }, 'a commit whose answer is lost replays');

  // 10. Each commit carries its own transaction's time: a later commit, a later timestamp.
  const earlier = (await k.footprint(lostCommand)).audit[0].at;
  await h.advance(1_000);
  const laterCommand = k.creating(await k.begin());
  assert.deepEqual(await k.commit(laterCommand), COMMITTED);
  assert.ok((await k.footprint(laterCommand)).audit[0].at >= earlier + 1_000, 'each commit is stamped with its own transaction time, never a stale one');

  // 11. An unreachable store fails closed on both instances — it commits nothing, and its probe is never
  //     true — keeps its state, and queues nothing.
  const held = await k.begin();
  const heldCommand = k.creating(held);
  await h.breakStore();
  for (const instance of [transaction, peer]) {
    assert.deepEqual(await k.settled(k.commit(heldCommand, instance)), UNAVAILABLE, 'an unreachable store commits nothing');
    const probed = await Promise.resolve().then(() => instance.probe(k.live())).catch(() => false);
    assert.notEqual(probed, true, 'an unreachable store never answers the probe with true');
  }
  await h.restoreStore();
  assert.deepEqual(await k.footprint(heldCommand), NOTHING, 'no commit attempted during the outage was queued');
  const survived = await k.footprint(first);
  assert.deepEqual([survived.audit, survived.events], [fa.audit, fa.events], 'a committed operation survived the outage');
  assert.deepEqual(await k.commit(heldCommand), COMMITTED, 'the lease survived it too: the holder commits now');
  assert.equal(await transaction.probe(k.live()), true, 'the recovered store answers the probe again');
}

interface ClaimedItem { readonly eventId: string; readonly attempt: number; readonly envelope: OutboxEnvelope }

/**
 * The delivery contract (outbox.ts), run against any adapter over two instances of one store that holds no
 * outbox event but those the suite enqueues, each by a real commit: a healthy probe answers exactly true;
 * a claim returns { eventId, attempt, envelope } with the envelope as committed and its delivery metadata
 * beside it, and holds the event; the holder acknowledges it for good; concurrent claims never share an
 * event; an uncontended claim takes exactly min(limit, eligible); a claim holds until it expires, then a
 * reclaim counts an attempt and redelivers the same envelope, and the stale holder settles nothing; an
 * expired claim nobody reclaimed still settles; a retry waits its delay; a dead event is never claimed or
 * settled again; an aborted call changes nothing; an unreachable store fails closed on both instances,
 * keeps its claims and queues nothing.
 */
export async function assertOutboxDeliveryContract(h: TransactionalOutboxHarness): Promise<void> {
  const { delivery, deliveryPeer: peer } = h;
  assert.notEqual(peer, delivery, 'the peer is a second adapter instance, never the same object');
  const k = conformanceKit(h);
  const token = (): string => randomBytes(32).toString('base64url');
  const claim = (held: string, limit = 32, instance = delivery): Promise<unknown> =>
    Promise.resolve().then(() => instance.claim(Object.freeze({ claim: held, limit, claimMs: CLAIM_MS }), k.live()));
  const itemsOf = (answer: unknown): readonly ClaimedItem[] => {
    const record = answer as Record<string, unknown>;
    assert.ok(typeof answer === 'object' && answer !== null && record.outcome === 'claimed' && Array.isArray(record.events), 'a claim answers { outcome: "claimed", events }');
    return record.events as ClaimedItem[];
  };
  const ack = (eventId: string, held: string, instance = delivery): Promise<unknown> =>
    Promise.resolve().then(() => instance.acknowledge(Object.freeze({ eventId, claim: held }), k.live()));
  const retry = (eventId: string, held: string, delayMs: number, instance = delivery): Promise<unknown> =>
    Promise.resolve().then(() => instance.retry(Object.freeze({ eventId, claim: held, delayMs }), k.live()));
  const deadLetter = (eventId: string, held: string, instance = delivery): Promise<unknown> =>
    Promise.resolve().then(() => instance.deadLetter(Object.freeze({ eventId, claim: held, reason: 'attempts_exhausted' as const }), k.live()));
  const statusOf = async (eventId: string): Promise<DeliveryStatus | undefined> =>
    (await h.inspect()).events.find((e) => e.envelope.eventId === eventId)?.status;
  /** Enqueue `n` fresh events, each by committing its own create; their envelopes as committed. */
  const seed = async (n: number): Promise<OutboxEnvelope[]> => {
    const out: OutboxEnvelope[] = [];
    for (let i = 0; i < n; i++) {
      const command = k.creating(await k.begin());
      assert.deepEqual(await k.commit(command), COMMITTED, 'the suite enqueues by committing');
      out.push(...(await k.footprint(command)).events.map((e) => e.envelope));
    }
    return out;
  };
  const only = (event: OutboxEnvelope, attempt: number): unknown => ({ outcome: 'claimed', events: [{ eventId: event.eventId, attempt, envelope: event }] });

  // 1. A store that can serve answers the probe with exactly true, on both instances; nothing eligible is an empty batch.
  for (const instance of [delivery, peer]) assert.equal(await instance.probe(k.live()), true, 'a store that can serve answers the probe with exactly true');
  assert.deepEqual(await claim(token()), EMPTY, 'nothing eligible: an empty batch');

  // 2. A claim returns the event once as { eventId, attempt, envelope } — the envelope as committed, its
  //    delivery metadata beside it — and holds it; the holder acknowledges it, durably and for good.
  const [e1] = await seed(1);
  const a1 = token();
  assert.deepEqual(await claim(a1), only(e1, 1), 'the first claim takes the event at attempt 1, its envelope as committed');
  assert.deepEqual(await claim(token(), 32, peer), EMPTY, 'a held event is claimed by no one else');
  assert.deepEqual(await ack(e1.eventId, a1, peer), ACKNOWLEDGED, 'the holder acknowledges, through either instance');
  await h.advance(CLAIM_MS * 2);
  for (const instance of [delivery, peer]) assert.deepEqual(await claim(token(), 32, instance), EMPTY, 'an acknowledged event is never claimed again');
  assert.equal(await statusOf(e1.eventId), 'delivered');

  // 3. Concurrent claims across both instances never share an event, respect their limits, and together take every eligible event.
  const twelve = await seed(12);
  const tokens = Array.from({ length: 8 }, token);
  const taken = (await Promise.all(tokens.map((held, i) => claim(held, 3, i % 2 === 0 ? delivery : peer)))).map(itemsOf);
  assert.ok(taken.every((items) => items.length <= 3), 'no claim exceeds its limit');
  const takenIds = taken.flat().map((item) => item.eventId);
  assert.equal(new Set(takenIds).size, takenIds.length, 'no event is claimed by two concurrent claims');
  assert.deepEqual([...takenIds].sort(), twelve.map((e) => e.eventId).sort(), 'and together they took every eligible event');
  for (const [i, items] of taken.entries()) for (const item of items) assert.deepEqual(await ack(item.eventId, tokens[i]), ACKNOWLEDGED);

  // 4. An uncontended claim takes exactly min(limit, eligible).
  await seed(5);
  const batch = token();
  const sizes: number[] = [];
  const batched: ClaimedItem[] = [];
  for (let i = 0; i < 4; i++) {
    const items = itemsOf(await claim(batch, 2));
    sizes.push(items.length);
    batched.push(...items);
  }
  assert.deepEqual(sizes, [2, 2, 1, 0], 'each claim takes at most its limit, and exactly that while enough are eligible');
  for (const item of batched) assert.deepEqual(await ack(item.eventId, batch), ACKNOWLEDGED);

  // 5. A claim holds until it expires, by the store's clock; then a reclaim counts an attempt and redelivers
  //    the same immutable envelope — a lost acknowledgement redelivers the same event ID — and the stale
  //    holder can settle nothing.
  const [e5] = await seed(1);
  const old = token();
  assert.deepEqual(await claim(old), only(e5, 1));
  await h.advance(CLAIM_MS - 1);
  assert.deepEqual(await claim(token(), 32, peer), EMPTY, 'a claim holds until it expires, on either instance');
  await h.advance(1);
  const next = token();
  assert.deepEqual(await claim(next, 32, peer), only(e5, 2), 'an expired claim is reclaimed: the attempt counted, the same envelope redelivered');
  assert.deepEqual(await ack(e5.eventId, old), CLAIM_LOST, "the stale holder's acknowledgement is refused");
  assert.deepEqual(await retry(e5.eventId, old, 1_000), CLAIM_LOST, "the stale holder's retry is refused");
  assert.deepEqual(await deadLetter(e5.eventId, old), CLAIM_LOST, "the stale holder's dead-letter is refused");
  assert.deepEqual(await ack(e5.eventId, next, peer), ACKNOWLEDGED, 'and none changed anything: the new holder acknowledges');
  assert.equal((await h.inspect()).events.filter((e) => e.envelope.eventId === e5.eventId).length, 1, 'redelivery never creates a second event identity');

  // 6. An expired claim nobody reclaimed still settles.
  const [e6] = await seed(1);
  const lazy = token();
  assert.deepEqual(await claim(lazy), only(e6, 1));
  await h.advance(CLAIM_MS + 1);
  assert.deepEqual(await ack(e6.eventId, lazy, peer), ACKNOWLEDGED, 'an expired claim nobody reclaimed still acknowledges');
  assert.deepEqual(await claim(token()), EMPTY);

  // 7. A retry waits its delay, by the store's clock, and is then due again with its attempt counted.
  const [e7] = await seed(1);
  const r1 = token();
  assert.deepEqual(await claim(r1), only(e7, 1));
  assert.deepEqual(await retry(e7.eventId, r1, 5_000, peer), SCHEDULED, 'the holder schedules a retry');
  assert.deepEqual(await claim(token()), EMPTY, 'a retried event waits');
  await h.advance(4_999);
  assert.deepEqual(await claim(token(), 32, peer), EMPTY, 'until its delay has passed');
  await h.advance(1);
  const r2 = token();
  assert.deepEqual(await claim(r2), only(e7, 2), 'then it is due again, its attempt counted');
  assert.deepEqual(await retry(e7.eventId, r1, 1), CLAIM_LOST, 'the settled claim settles nothing more');
  assert.deepEqual(await ack(e7.eventId, r2), ACKNOWLEDGED);

  // 8. A dead event is dead for good: never claimed and never settled again.
  const [e8] = await seed(1);
  const d1 = token();
  assert.deepEqual(await claim(d1), only(e8, 1));
  assert.deepEqual(await deadLetter(e8.eventId, d1, peer), DEAD_LETTERED, 'the holder dead-letters');
  await h.advance(OUTBOX_DELIVERY_POLICY.maxDelayMs + CLAIM_MS);
  for (const instance of [delivery, peer]) assert.deepEqual(await claim(token(), 32, instance), EMPTY, 'a dead event is never claimed again');
  assert.deepEqual([await ack(e8.eventId, d1), await retry(e8.eventId, d1, 1)], [CLAIM_LOST, CLAIM_LOST], 'nor settled again');
  assert.equal(await statusOf(e8.eventId), 'dead');

  // 9. A call handed an already-aborted signal settles and changes nothing.
  const [e9] = await seed(1);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await settles(() => delivery.claim(Object.freeze({ claim: token(), limit: 32, claimMs: CLAIM_MS }), aborted.signal), 1_000), true, 'an aborted claim settles');
  const c9 = token();
  assert.deepEqual(await claim(c9, 32, peer), only(e9, 1), 'and claimed nothing — not even an attempt');
  assert.equal(await settles(() => delivery.acknowledge(Object.freeze({ eventId: e9.eventId, claim: c9 }), aborted.signal), 1_000), true, 'an aborted acknowledgement settles');
  assert.deepEqual(await ack(e9.eventId, c9), ACKNOWLEDGED, 'and acknowledged nothing: the holder acknowledges now');

  // 10. An unreachable store fails closed on both instances — it claims and settles nothing, and its probe is
  //     never true — keeps its claims, and queues nothing.
  const pair = await seed(2);
  const h1 = token();
  const [heldItem] = itemsOf(await claim(h1, 1));
  const free = pair.find((e) => e.eventId !== heldItem.eventId) as OutboxEnvelope;
  await h.breakStore();
  const down = (answer: Promise<unknown>): Promise<unknown> => answer.catch(() => UNAVAILABLE);
  for (const instance of [delivery, peer]) {
    assert.deepEqual(await down(claim(token(), 32, instance)), UNAVAILABLE, 'an unreachable store claims nothing');
    assert.deepEqual(await down(ack(heldItem.eventId, h1, instance)), UNAVAILABLE, 'nor acknowledges');
    assert.deepEqual(await down(retry(heldItem.eventId, h1, 1, instance)), UNAVAILABLE, 'nor retries');
    assert.deepEqual(await down(deadLetter(heldItem.eventId, h1, instance)), UNAVAILABLE, 'nor dead-letters');
    const probed = await Promise.resolve().then(() => instance.probe(k.live())).catch(() => false);
    assert.notEqual(probed, true, 'an unreachable store never answers the probe with true');
  }
  await h.restoreStore();
  assert.deepEqual(await ack(heldItem.eventId, h1), ACKNOWLEDGED, 'a claim kept through the outage still settles');
  const after = token();
  assert.deepEqual(await claim(after), only(free, 1), 'no claim attempted during the outage was queued');
  assert.deepEqual(await ack(free.eventId, after), ACKNOWLEDGED);
  assert.equal(await delivery.probe(k.live()), true, 'the recovered store answers the probe again');
}
