// Phase 4.0 M6 — TEST SUPPORT ONLY: a process-local rate limiter, and the conformance suite every
// distributed limiter adapter must pass before it is approved.
//
// Excluded from the deployable artifact (tsconfig.server.json) and imported by no production
// module and nothing the production composition root reaches
// (tests/quality/production-runtime-contract.test.mjs). Production eligibility is provenance, not
// a property of a limiter: the composition root binds only its own closed table of approved
// adapters and takes configuration only, so no wrapper or relabelling of this limiter can reach
// production — and the chain has no fallback to it, or to anything else, when a store fails.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { DistributedRateLimiter, RateLimitOutcome, RateLimitRequest, RequestLimitDeps } from './rateLimit.js';

/** A synthetic keyed-hash secret for tests; never a deployment's. */
export const TEST_RATE_LIMIT_KEY: Uint8Array = new Uint8Array(32).fill(0x5a);

export interface MemoryRateLimiterOptions {
  /** The clock; default Date.now. */
  now?: () => number;
}

export interface MemoryRateLimiter extends DistributedRateLimiter {
  consume(request: RateLimitRequest, signal: AbortSignal): RateLimitOutcome;
  probe(signal?: AbortSignal): boolean;
  size(): number;
}

/**
 * A limiter over process memory that meets the port contract inside one process — each consume
 * runs to completion synchronously — and nowhere else: it shares nothing with another instance
 * and forgets everything on restart.
 */
export function createMemoryRateLimiter(options: MemoryRateLimiterOptions = {}): MemoryRateLimiter {
  const now = options.now ?? Date.now;
  // Test support: never evicts a live bucket, so no test's limit can silently reset.
  const buckets = new Map<string, { start: number; count: number }>();
  return {
    consume(request, signal) {
      if (signal.aborted) return { outcome: 'unavailable' };
      const t = now();
      const id = `${request.namespace}\n${request.dimension}\n${request.limit}\n${request.windowMs}\n${request.key}`;
      let bucket = buckets.get(id);
      if (bucket === undefined || t - bucket.start >= request.windowMs) bucket = { start: t, count: 0 };
      buckets.set(id, bucket);
      if (bucket.count + request.cost > request.limit) {
        // A clock that steps backwards cannot stretch the wait past one window.
        return { outcome: 'limited', retryAfterMs: Math.min(Math.max(bucket.start + request.windowMs - t, 1), request.windowMs) };
      }
      bucket.count += request.cost;
      return { outcome: 'allowed', remaining: request.limit - bucket.count };
    },
    probe: () => true,
    size: () => buckets.size,
  };
}

/** Limits over a fresh in-memory limiter, for tests that are not about limits. */
export function testRequestLimits(over: Partial<RequestLimitDeps> = {}): RequestLimitDeps {
  return { limiter: createMemoryRateLimiter(), keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: [], ...over };
}

/** What the conformance suite drives. Every member is required: none of the checks is optional. */
export interface RateLimiterHarness {
  /** The adapter under test. Every check uses fresh keys, so a store may be shared with earlier runs. */
  readonly limiter: DistributedRateLimiter;
  /** A second adapter instance over the same store (an in-process limiter can only offer itself). */
  readonly peer: DistributedRateLimiter;
  /** The window the checks use: default 60 000 ms; a multiple of 6 and at least 6 000. */
  readonly windowMs?: number;
  /** Move the store's clock forward by `ms`; a harness over real time waits instead. */
  advance(ms: number): void | Promise<void>;
  /** Make the shared store unreachable to both instances. */
  breakStore(): void | Promise<void>;
  /** Make it reachable again. */
  restoreStore(): void | Promise<void>;
}

const outcomeOf = (v: unknown): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>).outcome : undefined);
const remainingOf = (v: unknown): number => (v as { remaining: number }).remaining;

/** The wait a limited outcome carries; fails unless `v` is exactly that. */
function limitedWait(v: unknown, label: string): number {
  assert.equal(outcomeOf(v), 'limited', label);
  const ms = (v as Record<string, unknown>).retryAfterMs;
  assert.ok(typeof ms === 'number' && Number.isSafeInteger(ms), `${label}: a limited outcome carries a whole-millisecond wait`);
  return ms;
}

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
 * The port contract (rateLimit.ts), run against any adapter: up to the limit, then limited with a
 * wait bounded by the window; a consume spends its cost and a refused one spends nothing; buckets
 * are independent per key, namespace, dimension and policy; concurrent consumes — across two
 * instances, with mixed costs — are atomic; the window is fixed, counts down and reopens at
 * windowMs; an already-aborted consume settles and spends nothing; a healthy probe answers exactly
 * true; and an unreachable store answers unavailable (or rejects) and never a ready probe — it
 * fails closed, never open — while its buckets survive the outage.
 */
export async function assertRateLimiterContract(harness: RateLimiterHarness): Promise<void> {
  const { limiter, peer } = harness;
  assert.notEqual(peer, limiter, 'the peer is a second adapter instance, never the same object');
  const window = harness.windowMs ?? 60_000;
  assert.ok(Number.isSafeInteger(window) && window >= 6_000 && window % 6 === 0, 'the harness window is a multiple of 6 of at least 6 000 ms');
  const step = window / 6;
  const run = randomBytes(8).toString('hex');
  let serial = 0;
  const fresh = (): string => createHash('sha256').update(`${run}:${serial++}`).digest('base64url');
  const req = (key: string, limit: number, over: Partial<RateLimitRequest> = {}): RateLimitRequest =>
    Object.freeze({ namespace: 'tenant', dimension: 'client', key, limit, windowMs: window, cost: 1, ...over });
  const live = (): AbortSignal => new AbortController().signal;
  const consume = async (request: RateLimitRequest, instance = limiter): Promise<unknown> => instance.consume(request, live());
  const allowed = (remaining: number): RateLimitOutcome => ({ outcome: 'allowed', remaining });

  // 1. Up to the limit, then limited with a wait bounded by the window.
  const a = fresh();
  for (const remaining of [2, 1, 0]) assert.deepEqual(await consume(req(a, 3)), allowed(remaining), `allowed with ${remaining} left`);
  const wait = limitedWait(await consume(req(a, 3)), 'past the limit');
  assert.ok(wait >= 1 && wait <= window, 'the wait is bounded by the window');

  // 2. A consume spends its cost; one that would overrun the limit spends nothing.
  const c = fresh();
  for (const remaining of [7, 4, 1]) assert.deepEqual(await consume(req(c, 10, { cost: 3 })), allowed(remaining), `cost 3, ${remaining} left`);
  limitedWait(await consume(req(c, 10, { cost: 3 })), 'a cost that would overrun the limit');
  assert.deepEqual(await consume(req(c, 10)), allowed(0), 'the refused consume spent nothing');

  // 3. Buckets are independent per key, namespace, dimension and policy, and shared by instances.
  const b = fresh();
  assert.deepEqual(await consume(req(b, 1)), allowed(0));
  limitedWait(await consume(req(b, 1), peer), 'the peer instance sees the same spent bucket');
  const others: Array<[string, RateLimitRequest]> = [
    ['another key', req(fresh(), 1)], ['another namespace', req(b, 1, { namespace: 'admin' })],
    ['a login namespace', req(b, 1, { namespace: 'tenant-login' })], ['another dimension', req(b, 1, { dimension: 'account' })],
    ['another limit: a fresh bucket, never the old count reinterpreted', req(b, 2)],
    ['another window: a fresh bucket', req(b, 1, { windowMs: window + 6_000 })],
  ];
  for (const [label, request] of others) assert.deepEqual(await consume(request), allowed(request.limit - 1), label);

  // 4. Atomic: concurrent consumes of one bucket, across both instances, grant exactly the limit,
  //    each at its own count.
  const d = fresh();
  const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => consume(req(d, 10), i % 2 === 0 ? limiter : peer)));
  const granted = outcomes.filter((o) => outcomeOf(o) === 'allowed').map(remainingOf).sort((x, y) => x - y);
  assert.deepEqual(granted, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'exactly the limit is granted to concurrent consumes, once per count');
  assert.equal(outcomes.filter((o) => outcomeOf(o) === 'limited').length, 40, 'every other concurrent consume is limited');

  // 4b. Mixed costs, concurrently: the grants never overrun the limit, and each sees its own count.
  const m = fresh();
  const costs = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3];
  const mixed = await Promise.all(costs.map((cost, i) => consume(req(m, 10, { cost }), i % 2 === 0 ? limiter : peer)));
  assert.ok(mixed.every((o) => outcomeOf(o) === 'allowed' || outcomeOf(o) === 'limited'), 'every concurrent consume is an allowance or a limit');
  const grants = costs.filter((_, i) => outcomeOf(mixed[i]) === 'allowed');
  const spent = grants.reduce((sum, cost) => sum + cost, 0);
  const seen = mixed.filter((o) => outcomeOf(o) === 'allowed').map(remainingOf);
  assert.ok(spent <= 10, 'concurrent mixed-cost grants never overrun the limit');
  assert.equal(new Set(seen).size, seen.length, 'each concurrent grant sees its own count');
  assert.equal(Math.min(...seen), 10 - spent, 'the last grant leaves exactly the limit minus everything granted');
  costs.forEach((cost, i) => {
    if (outcomeOf(mixed[i]) === 'limited') assert.ok(spent >= 11 - cost, 'no consume is limited while its cost still fits');
  });

  // 5. A fixed window: a consume never extends it, the wait counts down, and it reopens at windowMs.
  const e = fresh();
  assert.deepEqual(await consume(req(e, 3)), allowed(2), 'the first consume opens the window');
  await harness.advance(window - 2 * step);
  assert.deepEqual(await consume(req(e, 3), peer), allowed(1), 'a later consume that leaves capacity extends nothing');
  assert.deepEqual(await consume(req(e, 3)), allowed(0), 'still inside the first window');
  assert.ok(limitedWait(await consume(req(e, 3)), 'the spent window') <= 2 * step, 'the wait is what is left of the first window: no consume extended it');
  await harness.advance(step);
  assert.ok(limitedWait(await consume(req(e, 3), peer), 'later in the window') <= step, 'the wait counts down; a refused consume extended nothing');
  await harness.advance(step);
  assert.deepEqual(await consume(req(e, 3)), allowed(2), 'the window reopens at windowMs');

  // 6. A consume handed an already-aborted signal settles, and spends nothing.
  const f = fresh();
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await settles(() => limiter.consume(req(f, 1), aborted.signal), 1_000), true, 'an aborted consume settles');
  assert.deepEqual(await consume(req(f, 1)), allowed(0), 'the aborted consume spent nothing');

  // 7. The readiness probe answers exactly true and touches no client bucket.
  const s = fresh();
  assert.deepEqual(await consume(req(s, 2)), allowed(1));
  for (const instance of [limiter, peer]) assert.equal(await instance.probe(live()), true, 'a store that can serve answers the probe with exactly true');
  assert.deepEqual(await consume(req(s, 2)), allowed(0), 'the probe touched no client bucket');

  // 8. An unreachable store fails closed — never an allowance or a limit, never a ready probe —
  //    and its buckets survive the outage.
  const g = fresh();
  const h = fresh();
  const o = fresh();
  assert.deepEqual(await consume(req(g, 1)), allowed(0));
  assert.deepEqual(await consume(req(h, 3)), allowed(2));
  await harness.breakStore();
  const down = async (instance: DistributedRateLimiter, request: RateLimitRequest): Promise<unknown> =>
    Promise.resolve().then(() => instance.consume(request, live())).catch(() => ({ outcome: 'unavailable' }));
  for (const instance of [limiter, peer]) {
    assert.deepEqual(await down(instance, req(o, 1_000)), { outcome: 'unavailable' }, 'an unreachable store answers unavailable or rejects: no local allowance');
    assert.deepEqual(await down(instance, req(g, 1)), { outcome: 'unavailable' }, 'not even for a bucket this instance has seen spent');
    assert.deepEqual(await down(instance, req(h, 3)), { outcome: 'unavailable' }, 'nor for one it has seen with capacity left');
    const probed = await Promise.resolve().then(() => instance.probe(live())).catch(() => false);
    assert.notEqual(probed, true, 'an unreachable store never answers the probe with true');
  }
  await harness.restoreStore();
  limitedWait(await consume(req(g, 1), peer), 'a bucket spent before the outage is still spent after it');
  assert.deepEqual(await consume(req(h, 3)), allowed(1), 'a bucket with capacity left kept its count through the outage');
  assert.deepEqual(await consume(req(o, 1_000), peer), allowed(999), 'no consume attempted during the outage was queued and replayed');
  assert.equal(await limiter.probe(live()), true, 'the recovered store answers the probe again');
}
