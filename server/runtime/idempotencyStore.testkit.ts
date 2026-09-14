// Phase 4.0 M6 — TEST SUPPORT ONLY: a process-local idempotency store, and the conformance suite
// every durable idempotency adapter must pass before it is approved.
//
// Excluded from the deployable artifact (tsconfig.server.json) and imported by no production module
// and nothing the production composition root reaches (tests/quality/production-runtime-contract.test.mjs).
// The composition root binds only its own closed table of approved adapters, which holds no
// idempotency store: none may be approved until the business mutation, its completion, the audit
// record and the outbox record commit in one transaction (idempotency.ts: the crash window).
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { MAX_SEALED_LENGTH, createIdempotencyKeyring } from './idempotency.js';
import type { DurableIdempotencyStore, IdempotencyAcquireRequest, IdempotencyCompleteRequest, IdempotencyDeps } from './idempotency.js';

/** A synthetic keyed-hash secret for tests; never a deployment's. */
export const TEST_IDEMPOTENCY_KEY: Uint8Array = new Uint8Array(32).fill(0x3c);

interface StoredRecord {
  readonly fingerprint: string;
  readonly lease: string;
  readonly leaseExpiresAt: number;
  readonly expiresAt: number;
  /** The sealed response once completed; null while in progress. */
  readonly response: string | null;
}

/** The synthetic state store instances share, as runtime instances share one durable store. */
export interface MemoryIdempotencyState {
  readonly now: () => number;
  readonly records: Map<string, StoredRecord>;
}

export function createMemoryIdempotencyState(options: { now?: () => number } = {}): MemoryIdempotencyState {
  return { now: options.now ?? Date.now, records: new Map() };
}

/**
 * One store instance over `state`. It meets the port contract inside one process — each call runs to
 * completion synchronously, so it is atomic across every instance sharing the state — and nowhere
 * else: it survives no restart and shares nothing with another process.
 */
export function createMemoryIdempotencyStore(state: MemoryIdempotencyState = createMemoryIdempotencyState()): DurableIdempotencyStore {
  const { records, now } = state;
  return {
    acquire(request: IdempotencyAcquireRequest, signal: AbortSignal) {
      if (signal.aborted) return { outcome: 'unavailable' };
      const t = now();
      const record = records.get(request.scope);
      // A record past its retention is absent: the operation starts afresh.
      if (record === undefined || t >= record.expiresAt) {
        records.set(request.scope, {
          fingerprint: request.fingerprint, lease: request.lease, leaseExpiresAt: t + request.leaseMs, expiresAt: t + request.retentionMs, response: null,
        });
        return { outcome: 'acquired', reclaimed: false };
      }
      if (record.fingerprint !== request.fingerprint) return { outcome: 'conflict' };
      if (record.response !== null) return { outcome: 'replay', response: record.response };
      if (t < record.leaseExpiresAt) return { outcome: 'in_progress' };
      records.set(request.scope, { ...record, lease: request.lease, leaseExpiresAt: t + request.leaseMs, expiresAt: t + request.retentionMs });
      return { outcome: 'acquired', reclaimed: true };
    },
    complete(request: IdempotencyCompleteRequest, signal: AbortSignal) {
      if (signal.aborted) return { outcome: 'unavailable' };
      const record = records.get(request.scope);
      if (record === undefined || now() >= record.expiresAt || record.response !== null || record.lease !== request.lease) {
        return { outcome: 'lease_lost' };
      }
      records.set(request.scope, { ...record, response: request.response });
      return { outcome: 'completed' };
    },
    probe: () => true,
  };
}

/** Idempotency over a fresh in-memory store, for tests that are not about the store. */
export function testIdempotency(over: Partial<IdempotencyDeps> = {}): IdempotencyDeps {
  return { store: createMemoryIdempotencyStore(), keySecret: TEST_IDEMPOTENCY_KEY, ...over };
}

/** What the conformance suite drives. Every method is required: none of the checks is optional. */
export interface IdempotencyStoreHarness {
  /** The adapter under test. Every check uses fresh keys, so a store may hold earlier runs' records. */
  readonly store: DurableIdempotencyStore;
  /** A second adapter instance over the same durable state (never the same object). */
  readonly peer: DurableIdempotencyStore;
  /** The lease the checks hand the store: default 60 000 ms, at least 2 ms. */
  readonly leaseMs?: number;
  /** The retention they hand it: default 600 000 ms, at least three leases. */
  readonly retentionMs?: number;
  /** Move the store's clock forward by `ms`; a harness over real time waits instead. */
  advance(ms: number): void | Promise<void>;
  /** Make the shared store unreachable to both instances. */
  breakStore(): void | Promise<void>;
  /** Make it reachable again. */
  restoreStore(): void | Promise<void>;
}

const outcomeOf = (v: unknown): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>).outcome : undefined);

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

/**
 * The port contract (idempotency.ts), run against any adapter over two instances: a healthy probe
 * answers exactly true; the first caller acquires and later ones wait; the lease holder completes
 * through either instance and the response replays byte for byte from both; another binding under
 * one scope conflicts, in progress or completed, and changes nothing; principals never share an
 * operation and tenants never share a response; exactly one of concurrent callers acquires; a
 * refused acquisition extends no lease, expiry allows one explicit reclaim, fences the old lease
 * out and restarts retention, and an expired lease nobody reclaimed still completes; a replay
 * extends no retention, which then ends; an aborted call changes nothing; an unreachable store
 * fails closed on both instances, keeps its state and queues nothing.
 */
export async function assertIdempotencyStoreContract(harness: IdempotencyStoreHarness): Promise<void> {
  const { store, peer } = harness;
  assert.notEqual(peer, store, 'the peer is a second adapter instance, never the same object');
  const LEASE = harness.leaseMs ?? 60_000;
  const RETAIN = harness.retentionMs ?? 600_000;
  assert.ok(Number.isSafeInteger(LEASE) && LEASE >= 2 && Number.isSafeInteger(RETAIN) && RETAIN >= 3 * LEASE,
    'the harness lease is at least 2 ms and its retention at least three leases');
  const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
  const run = randomBytes(8).toString('hex');
  interface Op { readonly scope: string; readonly fingerprint: string }
  /** An operation under a fresh client key (or `key`) for principal `who`, with a variant binding. */
  const op = (over: { key?: string; who?: string; tenant?: string | null; body?: string; path?: string } = {}): Op =>
    keyring.operationOf(over.key ?? randomUUID(), Object.freeze({ authProvider: 'conformance', authProviderUid: `${run}-${over.who ?? 'a'}` }), {
      method: 'POST', path: over.path ?? '/v1/conformance', audience: null, tenant: over.tenant ?? null, store: null, body: Buffer.from(over.body ?? '{"n":1}'),
    });
  const lease = (): string => randomBytes(32).toString('base64url');
  /** An opaque sealed response, as the runtime hands the store: the store keeps and returns it byte for byte. */
  const sealed = (bytes = 96): string => randomBytes(bytes).toString('base64url');
  const live = (): AbortSignal => new AbortController().signal;
  const acquireRequest = (o: Op, l: string): IdempotencyAcquireRequest =>
    Object.freeze({ scope: o.scope, fingerprint: o.fingerprint, lease: l, leaseMs: LEASE, retentionMs: RETAIN });
  const acquire = async (o: Op, l: string, instance = store): Promise<unknown> => instance.acquire(acquireRequest(o, l), live());
  const complete = async (o: Op, l: string, response: string, instance = store): Promise<unknown> =>
    instance.complete(Object.freeze({ scope: o.scope, lease: l, response }), live());
  const ACQUIRED = { outcome: 'acquired', reclaimed: false };
  const RECLAIMED = { outcome: 'acquired', reclaimed: true };
  const IN_PROGRESS = { outcome: 'in_progress' };
  const CONFLICT = { outcome: 'conflict' };
  const COMPLETED = { outcome: 'completed' };
  const LEASE_LOST = { outcome: 'lease_lost' };
  const UNAVAILABLE = { outcome: 'unavailable' };
  const replay = (response: string): unknown => ({ outcome: 'replay', response });

  // 1. A store that can serve answers the readiness probe with exactly true, on both instances.
  for (const instance of [store, peer]) assert.equal(await instance.probe(live()), true, 'a store that can serve answers the probe with exactly true');

  // 2. Sequential acquisition: the first caller acquires; every later one, on either instance, waits.
  const a = op();
  const la = lease();
  assert.deepEqual(await acquire(a, la), ACQUIRED, 'a new operation is acquired');
  assert.deepEqual(await acquire(a, lease()), IN_PROGRESS, 'a second caller finds it in progress');
  assert.deepEqual(await acquire(a, lease(), peer), IN_PROGRESS, 'so does a caller on the peer instance');

  // 3. The lease holder completes through either instance; the same request then replays the response
  //    byte for byte from both — the largest the runtime seals included — and nothing overwrites it.
  const largest = sealed(Math.floor((MAX_SEALED_LENGTH * 3) / 4));
  assert.ok(largest.length <= MAX_SEALED_LENGTH && largest.length > MAX_SEALED_LENGTH - 4);
  assert.deepEqual(await complete(a, la, largest, peer), COMPLETED, 'the lease holder completes, through either instance');
  assert.deepEqual(await acquire(a, lease()), replay(largest), 'the same request replays the stored response byte for byte');
  assert.deepEqual(await acquire(a, lease(), peer), replay(largest), 'from the peer instance too');
  assert.deepEqual(await complete(a, la, sealed(), peer), LEASE_LOST, 'a completed operation is never completed again, even by its holder');
  assert.deepEqual(await acquire(a, lease()), replay(largest), 'and its stored response is unchanged');

  // 4. Another binding under the same scope conflicts — in progress or completed — and changes nothing.
  const key = randomUUID();
  const first = op({ key, body: '{"n":2}' });
  const other = op({ key, body: '{"n":3}' });
  assert.equal(first.scope, other.scope, 'one key under one principal is one scope');
  const lf = lease();
  const firstResponse = sealed();
  assert.deepEqual(await acquire(first, lf), ACQUIRED);
  assert.deepEqual(await acquire(other, lease(), peer), CONFLICT, 'another body under an operation in progress conflicts');
  assert.deepEqual(await complete(other, lease(), sealed()), LEASE_LOST, 'the conflicting caller holds no lease');
  assert.deepEqual(await complete(first, lf, firstResponse), COMPLETED, 'the conflict changed nothing: the holder still completes');
  for (const variant of [other, op({ key, body: '{"n":2}', path: '/v1/conformance/other' }), op({ key, body: '{"n":2}', tenant: 'tenant-b' })]) {
    assert.deepEqual(await acquire(variant, lease()), CONFLICT, 'another body, operation or tenant under a completed operation conflicts');
  }
  assert.deepEqual(await acquire(first, lease(), peer), replay(firstResponse), 'and never displaces the stored response');

  // 5. Principal separation: one client key under two principals is two independent operations.
  //    Tenant separation: one principal's key in another tenant is the same scope under another binding.
  const shared = randomUUID();
  const mine = op({ key: shared, who: 'a' });
  const theirs = op({ key: shared, who: 'b' });
  assert.notEqual(mine.scope, theirs.scope, 'each principal has its own key namespace');
  const [lm, lt, rm, rt] = [lease(), lease(), sealed(), sealed()];
  assert.deepEqual(await acquire(mine, lm), ACQUIRED);
  assert.deepEqual(await acquire(theirs, lt, peer), ACQUIRED, "another principal's use of the same key neither conflicts nor waits");
  assert.deepEqual(await complete(mine, lm, rm), COMPLETED);
  assert.deepEqual(await acquire(theirs, lease()), IN_PROGRESS, "nor replays the first principal's response");
  assert.deepEqual(await complete(theirs, lt, rt, peer), COMPLETED);
  assert.deepEqual(await acquire(mine, lease(), peer), replay(rm));
  assert.deepEqual(await acquire(theirs, lease()), replay(rt), 'each principal replays only its own response');
  const home = op({ key: shared, who: 'c', tenant: 'tenant-a' });
  const away = op({ key: shared, who: 'c', tenant: 'tenant-b' });
  const lh = lease();
  assert.deepEqual(await acquire(home, lh), ACQUIRED);
  assert.deepEqual(await complete(home, lh, sealed(), peer), COMPLETED);
  assert.deepEqual(await acquire(away, lease(), peer), CONFLICT, "one tenant's operation is never another tenant's replay");

  // 6. Concurrent acquisition across both instances, with two bindings: exactly one winner; every
  //    other caller waits on it or conflicts with it, and holds no lease.
  const ckey = randomUUID();
  const same = op({ key: ckey, body: '{"c":1}' });
  const differs = op({ key: ckey, body: '{"c":2}' });
  const leases = Array.from({ length: 40 }, lease);
  const bindingOf = (i: number): Op => (i % 4 < 2 ? same : differs);
  const raced = await Promise.all(leases.map((l, i) => acquire(bindingOf(i), l, i % 2 === 0 ? store : peer)));
  const winners = raced.flatMap((o, i) => (outcomeOf(o) === 'acquired' ? [i] : []));
  assert.equal(winners.length, 1, 'exactly one concurrent caller acquires');
  const [winner] = winners;
  assert.deepEqual(raced[winner], ACQUIRED);
  raced.forEach((o, i) => {
    if (i !== winner) assert.deepEqual(o, bindingOf(i) === bindingOf(winner) ? IN_PROGRESS : CONFLICT, 'every other concurrent caller waits on or conflicts with the winner');
  });
  for (const [i, l] of leases.entries()) {
    if (i !== winner) assert.deepEqual(await complete(bindingOf(winner), l, sealed()), LEASE_LOST, 'a concurrent caller that did not acquire holds no lease');
  }
  assert.deepEqual(await complete(bindingOf(winner), leases[winner], sealed(), peer), COMPLETED, 'the winner completes');

  // 7. Lease ownership and expiry. A refused acquisition extends no lease; at expiry exactly one
  //    caller reclaims — explicitly — and only under the same binding; the old lease is fenced out;
  //    a completion racing a reclaim is decided once; an expired lease nobody reclaimed completes.
  const r = op();
  const z = op();
  const zOther = op();
  const x = op();
  const y = op();
  const [old, lz, ly] = [lease(), lease(), lease()];
  assert.deepEqual(await acquire(r, old), ACQUIRED);
  assert.deepEqual(await acquire(z, lz), ACQUIRED);
  assert.deepEqual(await acquire(x, lease()), ACQUIRED);
  assert.deepEqual(await acquire(y, ly), ACQUIRED);
  assert.deepEqual(await complete(r, lease(), sealed()), LEASE_LOST, 'a lease the store did not grant never completes');
  assert.deepEqual(await complete(op(), lease(), sealed()), LEASE_LOST, 'no record, no lease: nothing completes an operation nobody acquired');
  await harness.advance(LEASE - 1);
  assert.deepEqual(await acquire(r, lease(), peer), IN_PROGRESS, 'the lease holds until it expires');
  await harness.advance(1);
  const fresh = lease();
  assert.deepEqual(await acquire(r, fresh), RECLAIMED, 'the lease expired on time — a refused acquisition extended nothing — and the caller reclaims explicitly');
  assert.deepEqual(await acquire(r, lease(), peer), IN_PROGRESS, 'the reclaimer holds a new lease');
  assert.deepEqual(await complete(r, old, sealed(), peer), LEASE_LOST, 'the reclaimed lease can never complete');
  const rResponse = sealed();
  assert.deepEqual(await complete(r, fresh, rResponse), COMPLETED, 'the new holder completes');
  assert.deepEqual(await acquire(r, lease(), peer), replay(rResponse));
  assert.deepEqual(await acquire({ scope: z.scope, fingerprint: zOther.fingerprint }, lease()), CONFLICT,
    'an expired lease is reclaimed only under its own binding: another conflicts');
  assert.deepEqual(await acquire(z, lease(), peer), RECLAIMED, 'a conflict extended nothing: the expired lease is still reclaimable');
  const reclaims = await Promise.all(Array.from({ length: 20 }, (_, i) => acquire(x, lease(), i % 2 === 0 ? store : peer)));
  assert.equal(reclaims.filter((o) => outcomeOf(o) === 'acquired').length, 1, 'exactly one concurrent caller reclaims an expired lease');
  assert.ok(reclaims.every((o) => outcomeOf(o) === 'acquired' ? true : outcomeOf(o) === 'in_progress'), 'the others find it in progress');
  const yResponse = sealed();
  const [done, taken] = await Promise.all([complete(y, ly, yResponse), acquire(y, lease(), peer)]);
  const completedFirst = outcomeOf(done) === 'completed';
  assert.deepEqual([done, taken], completedFirst ? [COMPLETED, replay(yResponse)] : [LEASE_LOST, RECLAIMED],
    'a completion racing a reclaim of its expired lease is decided once: completed then replayed, or fenced out by the reclaim');
  const late = op();
  const lateLease = lease();
  const lateResponse = sealed();
  assert.deepEqual(await acquire(late, lateLease), ACQUIRED);
  await harness.advance(LEASE + 1);
  assert.deepEqual(await complete(late, lateLease, lateResponse, peer), COMPLETED, 'an expired but unreclaimed lease still completes');
  assert.deepEqual(await acquire(late, lease()), replay(lateResponse));

  // 8. Retention: a reclaim restarts it; neither a refusal, the completion nor a replay extends it;
  //    once it ends the operation is absent, and one still in progress can no longer complete.
  const k = op();
  assert.deepEqual(await acquire(k, lease()), ACQUIRED);
  await harness.advance(LEASE);
  const lk = lease();
  assert.deepEqual(await acquire(k, lk, peer), RECLAIMED);
  await harness.advance(LEASE - 1);
  const kResponse = sealed();
  assert.deepEqual(await complete(k, lk, kResponse), COMPLETED);
  await harness.advance(RETAIN - LEASE);
  assert.deepEqual(await acquire(k, lease(), peer), replay(kResponse), 'a reclaim restarted the retention, which holds until it ends');
  await harness.advance(1);
  assert.deepEqual(await acquire(k, lease()), ACQUIRED, 'neither the completion nor a replay extended the retention: past it the operation is absent');
  const e = op();
  const le = lease();
  assert.deepEqual(await acquire(e, le), ACQUIRED);
  await harness.advance(LEASE - 1);
  assert.deepEqual(await acquire(e, lease(), peer), IN_PROGRESS);
  await harness.advance(RETAIN - LEASE + 1);
  assert.deepEqual(await complete(e, le, sealed()), LEASE_LOST, 'past its retention an operation is gone — no refusal extended it — and its holder can no longer complete');

  // 9. A call handed an already-aborted signal settles and changes nothing.
  const f = op();
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await settles(() => store.acquire(acquireRequest(f, lease()), aborted.signal), 1_000), true, 'an aborted acquisition settles');
  const lf2 = lease();
  assert.deepEqual(await acquire(f, lf2, peer), ACQUIRED, 'the aborted acquisition created nothing');
  assert.equal(await settles(() => store.complete(Object.freeze({ scope: f.scope, lease: lf2, response: sealed() }), aborted.signal), 1_000), true,
    'an aborted completion settles');
  assert.deepEqual(await acquire(f, lease()), IN_PROGRESS, 'the aborted completion completed nothing');
  assert.deepEqual(await complete(f, lf2, sealed()), COMPLETED, 'the holder still completes');

  // 10. An unreachable store fails closed on both instances — it acquires, replays, reports and
  //     completes nothing, and its probe is never true — keeps its state, and queues nothing.
  const held = op();
  const kept = op();
  const during = op();
  const [lHeld, lKept, keptResponse] = [lease(), lease(), sealed()];
  assert.deepEqual(await acquire(held, lHeld), ACQUIRED);
  assert.deepEqual(await acquire(kept, lKept), ACQUIRED);
  assert.deepEqual(await complete(kept, lKept, keptResponse), COMPLETED);
  await harness.breakStore();
  const down = async (call: () => Promise<unknown>): Promise<unknown> => call().catch(() => UNAVAILABLE);
  const heldResponse = sealed();
  for (const instance of [store, peer]) {
    assert.deepEqual(await down(() => acquire(during, lease(), instance)), UNAVAILABLE, 'an unreachable store acquires nothing');
    assert.deepEqual(await down(() => acquire(kept, lease(), instance)), UNAVAILABLE, 'nor replays from a local copy');
    assert.deepEqual(await down(() => acquire(held, lease(), instance)), UNAVAILABLE, 'nor reports progress it cannot see');
    assert.deepEqual(await down(() => complete(held, lHeld, heldResponse, instance)), UNAVAILABLE, 'nor completes');
    const probed = await Promise.resolve().then(() => instance.probe(live())).catch(() => false);
    assert.notEqual(probed, true, 'an unreachable store never answers the probe with true');
  }
  await harness.restoreStore();
  assert.deepEqual(await acquire(held, lease(), peer), IN_PROGRESS, 'an operation in progress kept its lease through the outage');
  assert.deepEqual(await complete(held, lHeld, heldResponse), COMPLETED, 'no completion attempted during the outage was queued: the holder completes now');
  assert.deepEqual(await acquire(kept, lease()), replay(keptResponse), 'a completed operation survived the outage');
  assert.deepEqual(await acquire(during, lease(), peer), ACQUIRED, 'no acquisition attempted during the outage was queued and replayed');
  assert.equal(await store.probe(live()), true, 'the recovered store answers the probe again');
}
