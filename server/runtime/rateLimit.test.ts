// Phase 4.0 M6 — the distributed rate-limit port: keyed pseudonyms, strict outcomes, conformance.
//
// Pinned three ways. The conformance suite every distributed adapter must pass runs against the
// test-only in-memory limiter and a correct shared-store adapter, and positive controls prove it
// fails each broken adapter it exists to catch. The runtime obeys only exact in-contract answers,
// within its own limiter deadline. And the keyring turns every subject into a bounded pseudonym
// under a secret only the composition boundary supplies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITER_DEADLINE_MS, RATE_LIMITS, RATE_LIMIT_BOUNDS, consumeRateLimit, createLimiterKeyring, createRequestLimits, parseRateLimitKey,
} from './rateLimit.js';
import type { DistributedRateLimiter, RateLimitRequest } from './rateLimit.js';
import { EnforcementSetupError } from './routes.js';
import { TEST_RATE_LIMIT_KEY, assertRateLimiterContract, createMemoryRateLimiter } from './rateLimiter.testkit.js';
import type { RateLimiterHarness } from './rateLimiter.testkit.js';

const T0 = 1_700_000_000_000;

// --- conformance -------------------------------------------------------------------------------

type Defect =
  | 'nonAtomic' | 'perInstanceMutex' | 'extendsWindow' | 'spendsOnRefusal' | 'policyBlind' | 'ignoresAbort' | 'failsOpen' | 'losesState';

/**
 * Two adapter instances over one shared bucket store, as over a remote store: each consume reads,
 * may wait on the network, then writes. With no defect it is atomic — it never waits between the
 * read and the write — and each defect breaks exactly one clause of the port contract.
 */
function storeHarness(defect: Defect | null): RateLimiterHarness {
  const store = new Map<string, { start: number; count: number }>();
  const clock = { t: T0 };
  let broken = false;
  const idOf = (r: RateLimitRequest): string =>
    (defect === 'policyBlind' ? [r.namespace, r.dimension, r.key] : [r.namespace, r.dimension, r.limit, r.windowMs, r.key]).join('\n');
  const step = async (r: RateLimitRequest): Promise<unknown> => {
    const id = idOf(r);
    let bucket = store.get(id);
    if (defect === 'nonAtomic' || defect === 'perInstanceMutex') await new Promise((resolve) => setImmediate(resolve)); // the network gap
    if (bucket === undefined || clock.t - bucket.start >= r.windowMs) bucket = { start: clock.t, count: 0 };
    if (defect === 'extendsWindow') bucket = { ...bucket, start: clock.t };
    if (bucket.count + r.cost > r.limit) {
      store.set(id, defect === 'spendsOnRefusal' ? { ...bucket, count: bucket.count + r.cost } : bucket);
      return { outcome: 'limited', retryAfterMs: Math.max(bucket.start + r.windowMs - clock.t, 1) };
    }
    store.set(id, { ...bucket, count: bucket.count + r.cost });
    return { outcome: 'allowed', remaining: r.limit - bucket.count - r.cost };
  };
  const instance = (): DistributedRateLimiter => {
    let queue: Promise<unknown> = Promise.resolve(); // this instance's own lock
    return {
      consume: (r: RateLimitRequest, signal: AbortSignal) => {
        if (broken) return defect === 'failsOpen' ? { outcome: 'allowed', remaining: r.limit - r.cost } : { outcome: 'unavailable' };
        if (signal.aborted && defect !== 'ignoresAbort') return { outcome: 'unavailable' };
        if (defect !== 'perInstanceMutex') return step(r);
        const run = queue.then(() => step(r));
        queue = run.catch(() => undefined);
        return run;
      },
      probe: () => !broken,
    };
  };
  return {
    limiter: instance(),
    peer: instance(),
    advance: (ms) => { clock.t += ms; },
    breakStore: () => { broken = true; },
    restoreStore: () => {
      broken = false;
      if (defect === 'losesState') store.clear();
    },
  };
}

test('the in-memory test limiter meets the port contract every distributed adapter must meet', async () => {
  let t = T0;
  let broken = false;
  const memory = createMemoryRateLimiter({ now: () => t });
  // Two adapter objects over one process-local store: the only kind of peer the in-memory limiter has.
  const instance = (): DistributedRateLimiter => ({
    consume: (r: RateLimitRequest, s: AbortSignal) => (broken ? { outcome: 'unavailable' } : memory.consume(r, s)),
    probe: () => !broken && memory.probe(),
  });
  await assertRateLimiterContract({
    limiter: instance(), peer: instance(), advance: (ms) => { t += ms; }, breakStore: () => { broken = true; }, restoreStore: () => { broken = false; },
  });
});

test('the conformance suite passes a correct shared-store adapter and fails every broken one', async () => {
  await assertRateLimiterContract(storeHarness(null));
  const caught: Array<[Defect, RegExp]> = [
    ['nonAtomic', /exactly the limit is granted/],
    ['perInstanceMutex', /exactly the limit is granted/],
    ['extendsWindow', /no consume extended it/],
    ['spendsOnRefusal', /the refused consume spent nothing/],
    ['policyBlind', /another limit/],
    ['ignoresAbort', /the aborted consume spent nothing/],
    ['failsOpen', /no local allowance/],
    ['losesState', /still spent after it/],
  ];
  for (const [defect, check] of caught) {
    await assert.rejects(assertRateLimiterContract(storeHarness(defect)),
      (err: unknown) => err instanceof assert.AssertionError && check.test(err.message), defect);
  }
});

// --- the runtime's validation of every answer ------------------------------------------------------

const REQUEST: RateLimitRequest = Object.freeze({
  namespace: 'tenant', dimension: 'client', key: 'k'.repeat(43), limit: 10, windowMs: 60_000, cost: 1,
});

test('only an exact, in-contract answer is obeyed; anything else is a 503, reported for what it is', async () => {
  const verdictOf = (answer: () => unknown): Promise<unknown> => consumeRateLimit({ consume: answer, probe: () => true }, REQUEST, 1_000);
  assert.equal(await verdictOf(() => ({ outcome: 'allowed', remaining: 9 })), 'allowed');
  assert.equal(await verdictOf(async () => ({ outcome: 'allowed', remaining: 0 })), 'allowed', 'a Promise is awaited');
  assert.deepEqual(await verdictOf(() => ({ outcome: 'limited', retryAfterMs: 1 })), { retryAfterSeconds: 1 });
  assert.deepEqual(await verdictOf(() => ({ outcome: 'limited', retryAfterMs: 1_500 })), { retryAfterSeconds: 2 });
  assert.deepEqual(await verdictOf(() => ({ outcome: 'limited', retryAfterMs: 60_000 })), { retryAfterSeconds: 60 });
  assert.equal(await verdictOf(() => ({ outcome: 'unavailable' })), 'rate_limit_unavailable');
  assert.equal(await verdictOf(() => { throw new Error('store-secret-detail'); }), 'rate_limit_unavailable');
  assert.equal(await verdictOf(() => Promise.reject(new Error('store-secret-detail'))), 'rate_limit_unavailable');
  const outOfContract: unknown[] = [
    { allowed: true, retryAfterSeconds: 0 }, { outcome: 'allowed', remaining: 10 }, { outcome: 'allowed', remaining: -1 },
    { outcome: 'allowed', remaining: 1.5 }, { outcome: 'allowed', remaining: '9' }, { outcome: 'allowed' },
    { outcome: 'limited', retryAfterMs: 0 }, { outcome: 'limited', retryAfterMs: 60_001 }, { outcome: 'limited', retryAfterMs: Number.NaN },
    { outcome: 'limited' }, { outcome: 'Allowed', remaining: 1 }, undefined, null, 'allowed', true, 7,
    Object.assign([], { outcome: 'allowed', remaining: 9 }), Object.create({ outcome: 'allowed', remaining: 9 }),
    // A getter that throws once the answer is being read: the contract is broken, never an allowance.
    new Proxy({}, { get: (_target, name) => { if (name === 'then') return undefined; throw new Error('hostile'); } }),
  ];
  for (const [i, answer] of outOfContract.entries()) {
    assert.equal(await verdictOf(() => answer), 'rate_limit_outcome_invalid', `out-of-contract answer #${i}`);
  }
  // One that throws as the port's promise settles (on `then`) is an outage: a 503 all the same.
  assert.equal(await verdictOf(() => new Proxy({}, { get: () => { throw new Error('hostile'); } })), 'rate_limit_unavailable');
});

test('a limiter call is bounded by LIMITER_DEADLINE_MS under a longer port deadline, and told to cancel', async () => {
  let signal: AbortSignal | undefined;
  const hanging: DistributedRateLimiter = {
    consume: (_request: unknown, s: AbortSignal) => { signal = s; return new Promise(() => {}); },
    probe: () => true,
  };
  const started = Date.now();
  assert.equal(await consumeRateLimit(hanging, REQUEST, 3_000), 'rate_limit_timeout');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= LIMITER_DEADLINE_MS - 50 && elapsed < 2_000, `${elapsed} ms`);
  assert.equal(signal?.aborted, true);
});

// --- keyed pseudonyms, the configured key and composition -----------------------------------------

test('limiter keys are bounded keyed pseudonyms: deterministic, separated by namespace and dimension, secret-dependent', () => {
  const keyring = createLimiterKeyring(TEST_RATE_LIMIT_KEY);
  const key = keyring.keyOf('tenant', 'client', '4:203.0.113.7');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createLimiterKeyring(new Uint8Array(TEST_RATE_LIMIT_KEY)).keyOf('tenant', 'client', '4:203.0.113.7'), key,
    'one subject is one key on every instance holding the secret');
  const others = [
    keyring.keyOf('admin', 'client', '4:203.0.113.7'), keyring.keyOf('tenant-login', 'client', '4:203.0.113.7'),
    keyring.keyOf('tenant', 'account', '4:203.0.113.7'), keyring.keyOf('tenant', 'client', '4:203.0.113.8'),
    createLimiterKeyring(new Uint8Array(32).fill(1)).keyOf('tenant', 'client', '4:203.0.113.7'),
  ];
  assert.equal(new Set([key, ...others]).size, 6, 'namespace, dimension, subject and secret each change the key');
  const secret = new Uint8Array(32).fill(9);
  const copied = createLimiterKeyring(secret);
  const before = copied.keyOf('runtime', 'client', 's');
  secret.fill(0);
  assert.equal(copied.keyOf('runtime', 'client', 's'), before, 'the keyring holds its own copy of the secret');
  for (const bad of [undefined, 'a'.repeat(64), new Uint8Array(31), new Uint8Array(65), [1, 2, 3], Buffer.alloc(0)]) {
    assert.throws(() => createLimiterKeyring(bad), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'rate_limit_key_invalid');
  }
});

test('the configured key text is unpadded, canonical base64url of 32–64 bytes, or nothing', () => {
  const key = Buffer.alloc(32, 7).toString('base64url');
  assert.deepEqual(parseRateLimitKey(key), Buffer.alloc(32, 7));
  assert.deepEqual(parseRateLimitKey(Buffer.alloc(64, 7).toString('base64url')), Buffer.alloc(64, 7));
  for (const bad of [
    undefined, '', key.slice(0, 42), `${key.slice(0, 42)}d`, `${key}=`, Buffer.alloc(32, 7).toString('base64'),
    Buffer.alloc(65, 7).toString('base64url'), `${key.slice(0, 20)}*${key.slice(21)}`, ` ${key}`,
  ]) {
    assert.equal(parseRateLimitKey(bad), null, String(bad));
  }
});

test('the shipped limits are pinned and within the port bounds', () => {
  assert.deepEqual(RATE_LIMITS, {
    request: { limit: 300, windowMs: 60_000 }, loginClient: { limit: 10, windowMs: 60_000 }, loginAccount: { limit: 5, windowMs: 300_000 },
  });
  for (const policy of Object.values(RATE_LIMITS)) {
    assert.ok(policy.limit >= 1 && policy.limit <= RATE_LIMIT_BOUNDS.maxLimit);
    assert.ok(policy.windowMs >= RATE_LIMIT_BOUNDS.minWindowMs && policy.windowMs <= RATE_LIMIT_BOUNDS.maxWindowMs);
  }
});

test('composed limits are validated at startup: a limiter with consume and probe, a key, exact proxies and nothing else', () => {
  const good = { limiter: createMemoryRateLimiter(), keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: ['10.0.0.0/8'] };
  assert.equal(createRequestLimits(good).trustedProxies.size, 1);
  const code = (raw: unknown): string => {
    try {
      createRequestLimits(raw);
    } catch (e) {
      return e instanceof EnforcementSetupError ? e.code : 'unexpected';
    }
    return 'accepted';
  };
  assert.equal(code(undefined), 'rate_limit_invalid');
  assert.equal(code({ ...good, fallback: createMemoryRateLimiter() }), 'rate_limit_invalid', 'no extra part, least of all a fallback');
  assert.equal(code({ ...good, limiter: { consume: () => ({ outcome: 'allowed', remaining: 0 }) } }), 'rate_limit_invalid', 'a limiter without a probe');
  assert.equal(code({ ...good, keySecret: 'not-bytes' }), 'rate_limit_key_invalid');
  assert.equal(code({ ...good, trustedProxies: ['0.0.0.0/0'] }), 'trusted_proxies_invalid');
  assert.equal(code({ ...good, trustedProxies: undefined }), 'trusted_proxies_invalid', 'the proxy list is never defaulted');
});
