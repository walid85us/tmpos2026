// Phase 4.0 M6-RATE-P2 — the PostgreSQL distributed rate limiter: what the adapter sends over the fixed kernel
// transaction, and everything it refuses to trust as an answer. DATABASE-FREE; migration 014's routines
// themselves are proved against a real cluster by the smoke script (.workflow/scratch/m6r/smoke014.mjs) and the
// unchanged conformance suite (rateLimiter.testkit.ts), not here.
//
// THE PROPERTY THIS SUITE EXISTS FOR. The adapter decides nothing about limits: its whole job is to send exactly
// one fixed statement per call and trust only its two in-contract row shapes. A request outside the port's own
// bounds is refused before any transaction opens; a row the routine did not answer in exactly its declared shape,
// a kernel fault, an already-expired deadline or an overrun past LIMITER_DEADLINE_MS all answer `unavailable` —
// never an allowance, never a throw. Between calls, the internal timer and the caller's own abort listener are
// always torn down, so a caller that never aborts still cannot hold the adapter past its own deadline.
//
// TWO MORE PROPERTIES SINCE THE LANE AND THE RECLAIM WERE ADDED. First: a bucket's consumes serialize on the
// instance, and the next one waits for the one ahead of it to really settle its transaction — not merely for that
// call to answer, since an early answer (the deadline, or the caller's own abort) can leave a transaction running
// in the background. A waiter that gives up while it is still waiting never sends anything. Second: a consume that
// opened a window fires one best-effort reclaim transaction, never awaited and never able to change the consume's
// own answer, coalesced to at most one per instance at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createPostgresRateLimiter, probeRateLimitKey, rateLimitKeyFingerprint,
  RATE_LIMIT_STORE_BOUNDS, RATE_LIMIT_RECLAIM_BOUNDS, RATE_LIMIT_KEY_FINGERPRINT_CONTEXT, RATE_LIMIT_LANE_DEPTH,
} from './postgresRateLimiter.js';
import { TransactionFailure } from './supervisedPgClient.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import { LIMITER_DEADLINE_MS, RATE_LIMIT_BOUNDS, createLimiterKeyring } from '../runtime/rateLimit.js';
import type { DistributedRateLimiter, RateLimitRequest } from '../runtime/rateLimit.js';
import { EnforcementSetupError } from '../runtime/routes.js';

const KEY32 = Buffer.alloc(32, 7);
const KEY64 = Buffer.alloc(64, 9);
const KEY = 'K'.repeat(43); // 43 base64url characters, matching the store's limiter_key column
const REQUEST = { namespace: 'runtime', dimension: 'client', key: KEY, limit: 100, windowMs: 60_000, cost: 10 };
const FINGERPRINT = rateLimitKeyFingerprint(KEY32);

const CONSUME_TEXT = 'select outcome, remaining, retry_after_ms from tmpos_rate_limit.m6_rate_limit_consume'
  + '(?::bytea, ?::text, ?::text, ?::text, ?::integer, ?::integer, ?::integer)';
const PROBE_TEXT = 'select outcome from tmpos_rate_limit.m6_rate_limit_probe(?::bytea)';

/** Whitespace folded, so the assertion pins the statement, not its indentation. */
const text = (statement: string): string => statement.replace(/\s+/g, ' ').trim();

/** `value` with `key` absent — not present-and-undefined, which is a different fault. */
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

const live = (): AbortSignal => new AbortController().signal;
const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/** Drains every pending microtask (however many chained `.then()`s) before the next check. */
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** `limiter.consume` typed loosely: the port's own signature is strict, but this suite deliberately feeds it garbage. */
const callConsume = (limiter: DistributedRateLimiter, request: unknown, signal: unknown): Promise<unknown> =>
  Promise.resolve(limiter.consume(request as RateLimitRequest, signal as AbortSignal));
const callProbe = (limiter: DistributedRateLimiter, signal: unknown): Promise<unknown> =>
  Promise.resolve(limiter.probe(signal as AbortSignal));

interface Fake extends SupervisedPgClient {
  readonly statements: string[];
  readonly values: unknown[][];
  readonly bounds: unknown[];
  readonly signals: AbortSignal[];
}

/** A client that answers every statement with `rows` (or rejects it with `fault`), recording each statement's
 * text, its bound values, and the bounds/signal each transaction opened with. `open` replaces the transaction
 * itself, for a kernel that fails before any statement runs. */
function fakeClient(rows: unknown, fault?: unknown, open?: (signal: AbortSignal) => never | Promise<never>): Fake {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const bounds: unknown[] = [];
  const signals: AbortSignal[] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    return fault !== undefined ? Promise.reject(fault) : Promise.resolve(rows as never);
  }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements, values, bounds, signals,
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      bounds.push(b);
      signals.push(signal);
      if (open) return open(signal);
      return work(sql);
    }) as never,
    end: async () => undefined,
  }) as never;
}

/** A kernel whose `sql` throws synchronously the moment `work` calls it — a driver fault distinct from a rejection. */
function throwingSqlClient(): Fake {
  const bounds: unknown[] = [];
  const signals: AbortSignal[] = [];
  const throwingSql = (() => { throw new Error('sql failed'); }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements: [], values: [], bounds, signals,
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      bounds.push(b);
      signals.push(signal);
      return work(throwingSql);
    }) as never,
    end: async () => undefined,
  }) as never;
}

/** A kernel transaction that never settles until the signal it was handed aborts — for the deadline/abort tests. */
function hangingClient(): { client: SupervisedPgClient; kernelAborted: () => boolean } {
  let didAbort = false;
  const client = Object.freeze({
    transaction: (<T>(signal: AbortSignal) => new Promise<T>((_resolve, reject) => {
      signal.addEventListener('abort', () => { didAbort = true; reject(new Error('kernel aborted')); }, { once: true });
    })) as never,
    end: async () => undefined,
  }) as unknown as SupervisedPgClient;
  return { client, kernelAborted: () => didAbort };
}

/** An ordinary AbortController signal whose listener registrations are counted, without changing its behaviour. */
function trackedSignal(): { signal: AbortSignal; counts: () => { adds: number; removes: number } } {
  const controller = new AbortController();
  const signal = controller.signal;
  let adds = 0;
  let removes = 0;
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, 'addEventListener', { value: (...a: Parameters<typeof realAdd>) => { adds += 1; return realAdd(...a); } });
  Object.defineProperty(signal, 'removeEventListener', { value: (...a: Parameters<typeof realRemove>) => { removes += 1; return realRemove(...a); } });
  return { signal, counts: () => ({ adds, removes }) };
}

/** A kernel whose every `transaction()` call is controlled from the test: pushed to `calls`, resolved or rejected
 * on demand — bypassing `work` entirely, for the lane-timing tests where only when a transaction starts and settles
 * matters, not the statement it would have sent. */
interface PendingTx {
  readonly signal: AbortSignal;
  readonly bounds: unknown;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}
function deferredClient(): { client: SupervisedPgClient; calls: PendingTx[] } {
  const calls: PendingTx[] = [];
  const client = Object.freeze({
    transaction: (<T>(signal: AbortSignal, bounds: unknown) => {
      let resolve!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res as never; reject = rej; });
      calls.push({ signal, bounds, resolve, reject });
      return promise;
    }) as never,
    end: async () => undefined,
  }) as unknown as SupervisedPgClient;
  return { client, calls };
}

/** A kernel whose transaction ignores the signal it is handed — as a driver whose COMMIT is already in flight would
 * — and settles only after `delayMs`, however long after the adapter itself gave up. */
function lateClient(delayMs: number, mode: 'resolve' | 'reject', value: unknown): { client: SupervisedPgClient; callCount: () => number } {
  let count = 0;
  const client = Object.freeze({
    transaction: (<T>() => {
      count += 1;
      return new Promise<T>((resolve, reject) => {
        setTimeout(() => { if (mode === 'resolve') resolve(value as T); else reject(value); }, delayMs);
      });
    }) as never,
    end: async () => undefined,
  }) as unknown as SupervisedPgClient;
  return { client, callCount: () => count };
}

/** A kernel that runs `work` for real (so the reclaim's own statement can be checked) but routes by the transaction's
 * bounds: RATE_LIMIT_STORE_BOUNDS answers `consumeRows` (or rejects `consumeFault`); RATE_LIMIT_RECLAIM_BOUNDS settles
 * per `reclaimMode` — 'resolve' (default), 'reject', 'hang' (never settles), or 'gate' (settles only once released). */
function reclaimTrackingClient(consumeRows: unknown, opts: {
  consumeFault?: unknown;
  reclaimMode?: 'resolve' | 'reject' | 'hang' | 'gate';
  reclaimFault?: unknown;
} = {}): { client: SupervisedPgClient; reclaimCount: () => number; reclaimStatements: string[]; release: (i: number) => void } {
  const reclaimStatements: string[] = [];
  const releasers: Array<() => void> = [];
  let reclaimCount = 0;
  const consumeSql = ((_strings: TemplateStringsArray, ..._args: unknown[]) => (
    opts.consumeFault !== undefined ? Promise.reject(opts.consumeFault) : Promise.resolve(consumeRows as never)
  )) as unknown as PgTransactionScope;
  const client = Object.freeze({
    transaction: (<T>(_signal: AbortSignal, bounds: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      if (bounds === RATE_LIMIT_RECLAIM_BOUNDS) {
        reclaimCount += 1;
        const mode = opts.reclaimMode ?? 'resolve';
        if (mode === 'hang') return new Promise<T>(() => undefined);
        const reclaimSql = ((strings: TemplateStringsArray) => {
          reclaimStatements.push(strings.join('?'));
          if (mode === 'reject') return Promise.reject(opts.reclaimFault ?? new Error('reclaim failed'));
          if (mode === 'gate') return new Promise((resolve) => { releasers.push(() => resolve([])); });
          return Promise.resolve([] as never);
        }) as unknown as PgTransactionScope;
        return work(reclaimSql);
      }
      return work(consumeSql);
    }) as never,
    end: async () => undefined,
  }) as unknown as SupervisedPgClient;
  return { client, reclaimCount: () => reclaimCount, reclaimStatements, release: (i: number) => releasers[i]() };
}

/** A kernel whose consume transactions answer `consumeRow` at once, and whose reclaim transactions run `work` for real
 * against a statement the test settles by hand — `reclaims[i].answer(rows)` or `.fail(reason)` — counting how many
 * reclaim transactions are in flight at once. */
interface HeldReclaim {
  readonly statement: string;
  answer(rows: unknown): void;
  fail(reason: unknown): void;
}
function owedReclaimClient(consumeRow: unknown): { client: SupervisedPgClient; reclaims: HeldReclaim[]; inFlight: () => number; maxInFlight: () => number } {
  const reclaims: HeldReclaim[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const consumeSql = (() => Promise.resolve([consumeRow])) as unknown as PgTransactionScope;
  const reclaimSql = ((strings: TemplateStringsArray) => new Promise((answer, fail) => {
    reclaims.push({ statement: strings.join('?'), answer, fail });
  })) as unknown as PgTransactionScope;
  const client = Object.freeze({
    transaction: (<T>(_signal: AbortSignal, bounds: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      if (bounds !== RATE_LIMIT_RECLAIM_BOUNDS) return work(consumeSql);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const transaction = work(reclaimSql);
      const ended = (): void => { inFlight -= 1; };
      void transaction.then(ended, ended);
      return transaction;
    }) as never,
    end: async () => undefined,
  }) as unknown as SupervisedPgClient;
  return { client, reclaims, inFlight: () => inFlight, maxInFlight: () => maxInFlight };
}

/** Whether `p` has settled yet, observed without awaiting it. */
function settledFlag(p: Promise<unknown>): () => boolean {
  let done = false;
  const mark = (): void => { done = true; };
  void p.then(mark, mark);
  return () => done;
}

/** `n` consumes of `request`, each under its own controller, joined to the bucket's line in order. */
const joinLine = (limiter: DistributedRateLimiter, request: unknown, n: number) => Array.from({ length: n }, () => {
  const controller = new AbortController();
  const promise = callConsume(limiter, request, controller.signal);
  return { controller, promise, settled: settledFlag(promise) };
});

/** A consume of `request` that the line refuses: unavailable at once — far short of the 500ms a waiter would spend
 * behind a held head — and no transaction opened. */
const refusedAtOnce = async (limiter: DistributedRateLimiter, request: unknown, calls: readonly unknown[], label: string): Promise<void> => {
  const before = calls.length;
  const start = Date.now();
  assert.deepEqual(await callConsume(limiter, request, live()), { outcome: 'unavailable' }, label);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `${label}: elapsed ${elapsed}ms should be at once, not a wait in the line`);
  await flush();
  assert.equal(calls.length, before, `${label}: no transaction opened`);
};

const buildLimiter = (rows: unknown, fault?: unknown, open?: (signal: AbortSignal) => never | Promise<never>) => {
  const client = fakeClient(rows, fault, open);
  return { client, limiter: createPostgresRateLimiter({ client, keySecret: KEY32 }) };
};
const consumeAnswer = (rows: unknown, fault?: unknown): Promise<unknown> =>
  callConsume(buildLimiter(rows, fault).limiter, REQUEST, live());
const probeWith = async (rows: unknown, fault?: unknown, signal: AbortSignal = live()): Promise<{ value: unknown; client: Fake }> => {
  const { client, limiter } = buildLimiter(rows, fault);
  const value = await callProbe(limiter, signal);
  return { value, client };
};

// --- construction ---------------------------------------------------------------------------------------------

test('M6R-01 construction refuses a key outside 32-64 raw bytes and never touches the kernel; the limiter and every outcome are frozen', async () => {
  const { client } = buildLimiter([]);
  const invalidKeys: [string, unknown][] = [
    ['a plain array, not a Uint8Array', Array.from(KEY32)],
    ['31 bytes', Buffer.alloc(31, 7)],
    ['65 bytes', Buffer.alloc(65, 7)],
    ['a string', KEY32.toString('base64url')],
  ];
  for (const [label, keySecret] of invalidKeys) {
    let threw = false;
    try {
      createPostgresRateLimiter({ client, keySecret: keySecret as unknown as Uint8Array });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof EnforcementSetupError, label);
      assert.equal((err as EnforcementSetupError).code, 'rate_limit_key_invalid', label);
    }
    assert.equal(threw, true, label);
  }
  assert.deepEqual(client.bounds, [], 'no invalid key ever opens a transaction');

  for (const keySecret of [KEY32, KEY64]) {
    const limiter = createPostgresRateLimiter({ client, keySecret });
    assert.equal(Object.isFrozen(limiter), true, 'the limiter itself');
  }
  assert.deepEqual(client.bounds, [], 'construction alone never opens a transaction');

  // remaining: 50, not limit - cost (90) — a window-opening answer would also fire a reclaim this test does not care about.
  const allowed = buildLimiter([{ outcome: 'allowed', remaining: 50, retry_after_ms: null }]);
  assert.equal(Object.isFrozen(await callConsume(allowed.limiter, REQUEST, live())), true, 'an allowed outcome');
  const limited = buildLimiter([{ outcome: 'limited', remaining: null, retry_after_ms: 5_000 }]);
  assert.equal(Object.isFrozen(await callConsume(limited.limiter, REQUEST, live())), true, 'a limited outcome');
  assert.equal(Object.isFrozen(await callConsume(allowed.limiter, null, live())), true, 'an unavailable outcome');
});

// --- the fingerprint --------------------------------------------------------------------------------------------

test('M6R-02 the fingerprint is HMAC-SHA256 of the key under its own context, 32 bytes, key-distinct, and never a limiter key the runtime keyring derives', async () => {
  assert.equal(RATE_LIMIT_KEY_FINGERPRINT_CONTEXT, 'tmpos-rate-limit-key-fingerprint:v1');
  const expected = createHmac('sha256', KEY32).update('tmpos-rate-limit-key-fingerprint:v1').digest();
  assert.ok(FINGERPRINT.equals(expected), 'matches an independent HMAC computation');
  assert.equal(FINGERPRINT.length, 32);

  const otherKey = Buffer.alloc(32, 8);
  assert.equal(rateLimitKeyFingerprint(otherKey).equals(FINGERPRINT), false, 'a different key fingerprints differently');
  assert.equal(rateLimitKeyFingerprint(KEY64).equals(FINGERPRINT), false);

  const keyring = createLimiterKeyring(KEY32);
  const combos: [string, string, string][] = [
    ['runtime', 'client', 'subject-1'],
    ['admin-login', 'account', 'subject-2'],
    ['tenant', 'store', ''],
  ];
  for (const [namespace, dimension, subject] of combos) {
    const limiterKey = keyring.keyOf(namespace as never, dimension as never, subject);
    assert.notEqual(limiterKey, FINGERPRINT.toString('base64url'), `${namespace}/${dimension}: domain-separated from the limiter keyring`);
  }

  // remaining: 50, not limit - cost (90) — this test does not care about the reclaim a window-opening answer fires.
  const { client, limiter } = buildLimiter([{ outcome: 'allowed', remaining: 50, retry_after_ms: null }]);
  await callConsume(limiter, REQUEST, live());
  assert.ok((client.values[0][0] as Buffer).equals(FINGERPRINT), 'the adapter sends the fingerprint it computed');
});

// --- the signal -------------------------------------------------------------------------------------------------

test('M6R-03 an already-aborted signal, or a value that is not an AbortSignal, answers unavailable and opens no transaction', async () => {
  const { client, limiter } = buildLimiter([{ outcome: 'allowed', remaining: 90, retry_after_ms: null }]);
  const badSignals: [string, unknown][] = [
    ['an already-aborted signal', aborted()],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { aborted: true }],
    ['a string', 'aborted'],
  ];
  for (const [label, signal] of badSignals) {
    assert.deepEqual(await callConsume(limiter, REQUEST, signal), { outcome: 'unavailable' }, label);
    assert.deepEqual(client.bounds, [], `${label}: no transaction opened`);
  }
  assert.deepEqual(client.statements, [], 'nothing was ever sent');
});

// --- out-of-contract requests -------------------------------------------------------------------------------------

test('M6R-04 every request outside the port\'s own bounds is refused without opening a transaction', async () => {
  const base = (): Record<string, unknown> => ({ ...REQUEST });
  const outOfContract: [string, unknown][] = [
    ['a namespace outside the set', { ...base(), namespace: 'other' }],
    ['a dimension outside the set', { ...base(), dimension: 'ip' }],
    ['a key of 42 characters', { ...base(), key: 'K'.repeat(42) }],
    ['a key of 44 characters', { ...base(), key: 'K'.repeat(44) }],
    ['a key with a plus sign', { ...base(), key: `${'K'.repeat(42)}+` }],
    ['a key with a slash', { ...base(), key: `${'K'.repeat(42)}/` }],
    ['a key with an equals sign', { ...base(), key: `${'K'.repeat(42)}=` }],
    ['a non-integer limit', { ...base(), limit: 1.5 }],
    ['a limit of zero', { ...base(), limit: 0 }],
    ['a limit past 1e6', { ...base(), limit: RATE_LIMIT_BOUNDS.maxLimit + 1 }],
    ['a window of 999ms', { ...base(), windowMs: 999 }],
    ['a window of 3600001ms', { ...base(), windowMs: 3_600_001 }],
    ['a non-integer window', { ...base(), windowMs: 1000.5 }],
    ['a cost of zero', { ...base(), cost: 0 }],
    ['a cost past the limit', { ...base(), limit: 10, cost: 11 }],
    ['a fractional cost', { ...base(), cost: 1.5 }],
    ['a null request', null],
    ['an array request', []],
    ['a string request', 'runtime'],
    ['a number request', 42],
  ];
  for (const [label, request] of outOfContract) {
    const { client, limiter } = buildLimiter([{ outcome: 'allowed', remaining: 90, retry_after_ms: null }]);
    assert.deepEqual(await callConsume(limiter, request, live()), { outcome: 'unavailable' }, label);
    assert.deepEqual(client.bounds, [], `${label}: no transaction opened`);
    assert.deepEqual(client.statements, [], `${label}: nothing sent`);
  }

  // A hostile request whose getter throws is refused the same way, never propagating the throw.
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, 'namespace', { enumerable: true, get(): never { throw new Error('boom'); } });
  const { client, limiter } = buildLimiter([{ outcome: 'allowed', remaining: 90, retry_after_ms: null }]);
  assert.deepEqual(await callConsume(limiter, hostile, live()), { outcome: 'unavailable' }, 'a throwing getter');
  assert.deepEqual(client.bounds, [], 'a throwing getter opens no transaction');
});

// --- the statement ------------------------------------------------------------------------------------------------

test('M6R-05 consume sends exactly one statement into the consume routine, fingerprint then the request fields in order, under the store\'s own bounds, each field read once', async () => {
  const reads = new Map<string, number>();
  const source = { namespace: 'tenant', dimension: 'account', key: KEY, limit: 500, windowMs: 30_000, cost: 25 };
  const counted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    Object.defineProperty(counted, k, { enumerable: true, get: () => { reads.set(k, (reads.get(k) ?? 0) + 1); return v; } });
  }
  // remaining: 400, not limit - cost (475) — a window-opening answer would also fire a reclaim, a second transaction
  // this test's "exactly one statement" assertion is not about.
  const { client, limiter } = buildLimiter([{ outcome: 'allowed', remaining: 400, retry_after_ms: null }]);
  await callConsume(limiter, counted, live());

  assert.equal(client.statements.length, 1, 'one statement, one round trip');
  assert.equal(text(client.statements[0]), CONSUME_TEXT);
  assert.deepEqual(client.values, [[FINGERPRINT, 'tenant', 'account', KEY, 500, 30_000, 25]]);

  assert.equal(client.bounds.length, 1);
  assert.equal(client.bounds[0], RATE_LIMIT_STORE_BOUNDS, 'the exported bounds themselves');
  const ms = (v: string): number => Number(v.replace(/ms$/, ''));
  for (const [name, value] of Object.entries(RATE_LIMIT_STORE_BOUNDS as Record<keyof TransactionBounds, string>)) {
    assert.ok(ms(value) < LIMITER_DEADLINE_MS, `${name}: ${value} is under the ${LIMITER_DEADLINE_MS}ms deadline`);
  }

  assert.deepEqual([...reads.entries()].filter(([, n]) => n !== 1), [], 'every field read exactly once');
  assert.deepEqual([...reads.keys()].sort(), ['cost', 'dimension', 'key', 'limit', 'namespace', 'windowMs'].sort());
});

// --- the answer -----------------------------------------------------------------------------------------------

test('M6R-06 only the routine\'s two exact row shapes are trusted; anything else, however close, is unavailable', async () => {
  const allowedRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ outcome: 'allowed', remaining: 90, retry_after_ms: null, ...over });
  const limitedRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ outcome: 'limited', remaining: null, retry_after_ms: 30_000, ...over });

  assert.deepEqual(await consumeAnswer([allowedRow({ remaining: 0 })]), { outcome: 'allowed', remaining: 0 }, 'remaining at its floor');
  assert.deepEqual(await consumeAnswer([allowedRow({ remaining: 90 })]), { outcome: 'allowed', remaining: 90 }, 'remaining at limit - cost');
  await sleep(10); // that boundary is also a window-opening answer: let its incidental background reclaim fully settle
  assert.deepEqual(await consumeAnswer([limitedRow({ retry_after_ms: 1 })]), { outcome: 'limited', retryAfterMs: 1 }, 'retry at its floor');
  assert.deepEqual(await consumeAnswer([limitedRow({ retry_after_ms: 60_000 })]), { outcome: 'limited', retryAfterMs: 60_000 }, 'retry at the window itself');

  const rejects: [string, unknown][] = [
    ['remaining below zero', [allowedRow({ remaining: -1 })]],
    ['remaining past limit - cost', [allowedRow({ remaining: 91 })]],
    ['a fractional remaining', [allowedRow({ remaining: 1.5 })]],
    ['a stringly remaining', [allowedRow({ remaining: '3' })]],
    ['remaining null on an allowed row', [allowedRow({ remaining: null })]],
    ['allowed with a retry', [allowedRow({ retry_after_ms: 5 })]],
    ['retry of zero', [limitedRow({ retry_after_ms: 0 })]],
    ['retry past the window', [limitedRow({ retry_after_ms: 60_001 })]],
    ['a fractional retry', [limitedRow({ retry_after_ms: 2.5 })]],
    ['a stringly retry', [limitedRow({ retry_after_ms: '100' })]],
    ['limited with a remaining', [limitedRow({ remaining: 0 })]],
    ['key_mismatch', [{ outcome: 'key_mismatch', remaining: null, retry_after_ms: null }]],
    ['consume_unavailable', [{ outcome: 'consume_unavailable', remaining: null, retry_after_ms: null }]],
    ['an outcome in another case', [{ ...allowedRow(), outcome: 'ALLOWED' }]],
    ['no outcome', [{ outcome: undefined, remaining: null, retry_after_ms: null }]],
    ['zero rows', []],
    ['two rows', [allowedRow(), allowedRow()]],
    ['an extra column', [{ ...allowedRow(), extra: 1 }]],
    ['a missing column', [without(allowedRow(), 'retry_after_ms')]],
    ['rows not an array', { 0: allowedRow(), length: 1 }],
    ['a row that is null', [null]],
  ];
  for (const [label, rows] of rejects) {
    assert.deepEqual(await consumeAnswer(rows), { outcome: 'unavailable' }, label);
  }
});

// --- the kernel ----------------------------------------------------------------------------------------------------

test('M6R-07 every kernel or driver failure answers unavailable, never a throw', async () => {
  const cases: [string, () => never | Promise<never>][] = [
    ['TransactionFailure.unavailable', () => Promise.reject(TransactionFailure.unavailable)],
    ['TransactionFailure.outcomeUnknown', () => Promise.reject(TransactionFailure.outcomeUnknown)],
    ['an Error', () => Promise.reject(new Error('connection to db.example:5432 refused'))],
    ['a non-Error value', () => Promise.reject('boom')],
    ['a synchronous kernel throw', () => { throw new Error('down'); }],
  ];
  for (const [label, open] of cases) {
    const { client, limiter } = buildLimiter(undefined, undefined, open);
    assert.deepEqual(await callConsume(limiter, REQUEST, live()), { outcome: 'unavailable' }, label);
    assert.equal(client.bounds.length, 1, `${label}: one transaction attempted`);
  }
  // `sql` itself throwing inside `work`, distinct from the kernel rejecting the whole transaction.
  const throwing = throwingSqlClient();
  const limiter = createPostgresRateLimiter({ client: throwing, keySecret: KEY32 });
  assert.deepEqual(await callConsume(limiter, REQUEST, live()), { outcome: 'unavailable' }, 'sql throwing inside work');
});

// --- the deadline and cleanup ---------------------------------------------------------------------------------------

test('M6R-08 an unsettled transaction ends at the internal deadline or the caller\'s own abort, and always tears down its listener and timer', async (t) => {
  const setTimeoutSpy = t.mock.method(globalThis, 'setTimeout');
  const clearTimeoutSpy = t.mock.method(globalThis, 'clearTimeout');

  // A caller signal that never aborts: the internal LIMITER_DEADLINE_MS timer ends it and aborts the kernel's signal.
  const never = hangingClient();
  const neverLimiter = createPostgresRateLimiter({ client: never.client, keySecret: KEY32 });
  const { signal: neverSignal, counts: neverCounts } = trackedSignal();
  const neverStart = Date.now();
  const neverResult = await callConsume(neverLimiter, REQUEST, neverSignal);
  const neverElapsed = Date.now() - neverStart;
  assert.deepEqual(neverResult, { outcome: 'unavailable' });
  assert.ok(neverElapsed >= 450 && neverElapsed <= 1500, `elapsed ${neverElapsed}ms`);
  assert.equal(never.kernelAborted(), true, 'the internal deadline aborts the kernel\'s signal');
  assert.deepEqual(neverCounts(), { adds: 1, removes: 1 }, 'the caller\'s listener is added once and removed once');

  const neverDeadlineCalls = setTimeoutSpy.mock.calls.filter((c) => c.arguments[1] === LIMITER_DEADLINE_MS);
  assert.equal(neverDeadlineCalls.length, 1, 'exactly one deadline timer scheduled');
  const neverTimerId = neverDeadlineCalls[0].result;
  assert.ok(clearTimeoutSpy.mock.calls.some((c) => c.arguments[0] === neverTimerId), 'the deadline timer is cleared, never left running');

  setTimeoutSpy.mock.resetCalls();
  clearTimeoutSpy.mock.resetCalls();

  // The caller aborts partway through: the transaction ends promptly, well under the internal deadline.
  const early = hangingClient();
  const earlyLimiter = createPostgresRateLimiter({ client: early.client, keySecret: KEY32 });
  const controller = new AbortController();
  const earlySignal = controller.signal;
  let adds = 0;
  let removes = 0;
  const realAdd = earlySignal.addEventListener.bind(earlySignal);
  const realRemove = earlySignal.removeEventListener.bind(earlySignal);
  Object.defineProperty(earlySignal, 'addEventListener', { value: (...a: Parameters<typeof realAdd>) => { adds += 1; return realAdd(...a); } });
  Object.defineProperty(earlySignal, 'removeEventListener', { value: (...a: Parameters<typeof realRemove>) => { removes += 1; return realRemove(...a); } });
  setTimeout(() => controller.abort(), 50);
  const earlyStart = Date.now();
  const earlyResult = await callConsume(earlyLimiter, REQUEST, earlySignal);
  const earlyElapsed = Date.now() - earlyStart;
  assert.deepEqual(earlyResult, { outcome: 'unavailable' });
  assert.ok(earlyElapsed < 450, `elapsed ${earlyElapsed}ms should end well before the internal deadline`);
  assert.equal(early.kernelAborted(), true, 'the caller\'s abort reaches the kernel\'s signal');
  assert.equal(adds, 1);
  assert.equal(removes, 1);

  const earlyDeadlineCalls = setTimeoutSpy.mock.calls.filter((c) => c.arguments[1] === LIMITER_DEADLINE_MS);
  assert.equal(earlyDeadlineCalls.length, 1);
  const earlyTimerId = earlyDeadlineCalls[0].result;
  assert.ok(clearTimeoutSpy.mock.calls.some((c) => c.arguments[0] === earlyTimerId), 'the deadline timer is cleared on an early abort too');
});

// --- the probe ------------------------------------------------------------------------------------------------------

test('M6R-09 probe answers true only for the store\'s single ready row, touches no consume routine, and never a truthy non-true value', async () => {
  const ready = await probeWith([{ outcome: 'ready' }]);
  assert.equal(ready.value, true);
  assert.equal(typeof ready.value, 'boolean');
  assert.deepEqual(ready.client.statements.map(text), [PROBE_TEXT]);
  assert.deepEqual(ready.client.values, [[FINGERPRINT]]);
  assert.equal(ready.client.statements[0].includes('m6_rate_limit_consume'), false, 'the probe never touches the consume routine');

  const notReady: [string, unknown][] = [
    ['key_mismatch', [{ outcome: 'key_mismatch' }]],
    ['consume_unavailable', [{ outcome: 'consume_unavailable' }]],
    ['an extra column', [{ outcome: 'ready', extra: 1 }]],
    ['two rows', [{ outcome: 'ready' }, { outcome: 'ready' }]],
    ['zero rows', []],
    ['rows not an array', { outcome: 'ready' }],
    ['a row that is null', [null]],
    ['no outcome', [{ outcome: undefined }]],
    ['an outcome in another case', [{ outcome: 'READY' }]],
    ['store_read_only', [{ outcome: 'store_read_only' }]],
  ];
  for (const [label, rows] of notReady) {
    const { value } = await probeWith(rows);
    assert.equal(value, false, label);
    assert.equal(typeof value, 'boolean', label);
  }

  assert.equal((await probeWith(undefined, new Error('down'))).value, false, 'a driver fault');

  const expired = await probeWith([{ outcome: 'ready' }], undefined, aborted());
  assert.equal(expired.value, false, 'an already-aborted signal');
  assert.deepEqual(expired.client.bounds, [], 'an already-aborted signal opens no transaction');
});

// --- lanes ----------------------------------------------------------------------------------------------------

test('M6R-10 the same bucket serializes on the transaction\'s own settlement, different buckets never wait on each other, and a waiter that gives up while waiting sends nothing', async () => {
  const { client, calls } = deferredClient();
  const limiter = createPostgresRateLimiter({ client, keySecret: KEY32 });
  // remaining: 50, never limit - cost (90) for any of these requests — nothing here is meant to fire a reclaim.
  const bucket = { ...REQUEST, key: 'L'.repeat(43) };

  // (a) same bucket: the second call's transaction waits for the first's transaction to settle, not merely for the
  // first call to answer — an abort can make the first call answer while its transaction is still open underneath.
  const firstController = new AbortController();
  const firstPromise = callConsume(limiter, bucket, firstController.signal);
  await flush();
  assert.equal(calls.length, 1, 'the first consume of an empty lane starts at once');
  const secondPromise = callConsume(limiter, bucket, live());
  await flush();
  assert.equal(calls.length, 1, 'the second consume of the same bucket waits for the first, sending nothing yet');

  firstController.abort(); // the first call answers unavailable now; its transaction is still open
  assert.deepEqual(await firstPromise, { outcome: 'unavailable' });
  await flush();
  assert.equal(calls.length, 1, 'the first call answering does not free the lane: its transaction has not settled');

  calls[0].resolve({ outcome: 'allowed', remaining: 50 }); // the late COMMIT the first caller never saw
  await flush();
  assert.equal(calls.length, 2, 'only once the first transaction settles does the second one start');
  calls[1].resolve({ outcome: 'allowed', remaining: 50 });
  assert.deepEqual(await secondPromise, { outcome: 'allowed', remaining: 50 });

  // (b) different buckets never wait on one another.
  const bucketA = { ...REQUEST, key: 'M'.repeat(43) };
  const bucketB = { ...REQUEST, key: 'N'.repeat(43) };
  const before = calls.length;
  const pA = callConsume(limiter, bucketA, live());
  const pB = callConsume(limiter, bucketB, live());
  await flush();
  assert.equal(calls.length, before + 2, 'both different-bucket consumes start without waiting on each other');
  calls[before].resolve({ outcome: 'allowed', remaining: 50 });
  calls[before + 1].resolve({ outcome: 'allowed', remaining: 50 });
  await Promise.all([pA, pB]);

  // (c) a waiter whose own signal aborts while it is still waiting for the lane sends nothing.
  const holdPromise1 = callConsume(limiter, bucket, live());
  await flush();
  const heldIndex1 = calls.length - 1;
  const waiterController = new AbortController();
  const waiterPromise = callConsume(limiter, bucket, waiterController.signal);
  await flush();
  assert.equal(calls.length, heldIndex1 + 1, 'the waiter has not started a transaction yet');
  waiterController.abort();
  assert.deepEqual(await waiterPromise, { outcome: 'unavailable' }, 'an abort while waiting for the lane');
  await flush();
  assert.equal(calls.length, heldIndex1 + 1, 'the aborted waiter never sent anything, before or after its abort');
  calls[heldIndex1].resolve({ outcome: 'allowed', remaining: 50 });
  await holdPromise1;

  // (d) a waiter whose own internal 500ms deadline passes while it is still waiting for the lane sends nothing.
  const holdPromise2 = callConsume(limiter, bucket, live());
  await flush();
  const heldIndex2 = calls.length - 1;
  const waiterStart = Date.now();
  const waiterResult = await callConsume(limiter, bucket, live());
  const waiterElapsed = Date.now() - waiterStart;
  assert.deepEqual(waiterResult, { outcome: 'unavailable' }, 'the internal deadline firing while still waiting for the lane');
  assert.ok(waiterElapsed >= 450 && waiterElapsed <= 1500, `elapsed ${waiterElapsed}ms`);
  assert.equal(calls.length, heldIndex2 + 1, 'the timed-out waiter never sent anything');
  calls[heldIndex2].resolve({ outcome: 'allowed', remaining: 50 });
  await holdPromise2;

  // (e) once every consume of the bucket has settled, the lane is gone: the next one starts at once, not after a wait.
  await flush();
  const freshIndex = calls.length;
  const freshStart = Date.now();
  const fresh = callConsume(limiter, bucket, live());
  await flush();
  const freshElapsed = Date.now() - freshStart;
  assert.equal(calls.length, freshIndex + 1, 'a fresh consume of the settled bucket starts without waiting');
  assert.ok(freshElapsed < 300, `elapsed ${freshElapsed}ms should be immediate, not a wait on a stale lane`);
  calls[freshIndex].resolve({ outcome: 'allowed', remaining: 50 });
  await fresh;
});

test('M6R-10b a waiter whose deadline has passed sends nothing, even when the line frees before its own deadline timer has run (M6R-PERF-R1)', async () => {
  const { client, calls } = deferredClient();
  const limiter = createPostgresRateLimiter({ client, keySecret: KEY32 });
  const bucket = { ...REQUEST, key: 'Q'.repeat(43) };
  const head = callConsume(limiter, bucket, live());
  await flush();
  const waiter = callConsume(limiter, bucket, live());
  await flush();
  assert.equal(calls.length, 1, 'the waiter waits in line');
  // The process is busy past both deadlines, and the head's transaction settles in that same turn: the line frees in
  // microtasks that run before any timer callback — the moment the deadline timers fire one callback at a time.
  const busyUntil = performance.now() + LIMITER_DEADLINE_MS + 20;
  while (performance.now() < busyUntil) { /* the event loop runs nothing else */ }
  calls[0].resolve({ outcome: 'allowed', remaining: 50 });
  for (let i = 0; i < 50; i += 1) await Promise.resolve(); // microtasks only: no timer has run yet
  assert.equal(calls.length, 1, 'past its deadline, the waiter sends nothing when the line frees');
  assert.deepEqual(await waiter, { outcome: 'unavailable' });
  await head;
  await flush();
  assert.equal(calls.length, 1, 'nor later');
});

test('M6R-10c a transaction whose answer arrives past the deadline, before the deadline timer has run, is answered unavailable — never a late allowance (M6R-PERF-R1)', async () => {
  const { client, calls } = deferredClient();
  const limiter = createPostgresRateLimiter({ client, keySecret: KEY32 });
  let answer: unknown = 'pending';
  const consume = callConsume(limiter, { ...REQUEST, key: 'R'.repeat(43) }, live()).then((a) => { answer = a; });
  await flush();
  assert.equal(calls.length, 1, 'its transaction is in flight');
  // The process is busy past the deadline, and the transaction's answer arrives in that same turn: it settles in microtasks
  // that run before the deadline timer's callback.
  const busyUntil = performance.now() + LIMITER_DEADLINE_MS + 20;
  while (performance.now() < busyUntil) { /* the event loop runs nothing else */ }
  calls[0].resolve({ outcome: 'allowed', remaining: 50 });
  for (let i = 0; i < 50; i += 1) await Promise.resolve(); // microtasks only: no timer has run yet
  assert.deepEqual(answer, { outcome: 'unavailable' }, 'past its deadline, the allowance that arrived is not obeyed');
  await consume;
});

test('M6R-10d the deadline is the adapter\'s own monotonic reading, fixed inside the call\'s synchronous step: work is handed over, and an answer obeyed, only while the clock reads strictly before it — at the deadline\'s very reading nothing is sent and nothing obeyed, its timer not yet run — and a pause later in that step moves nothing (M6R-PERF-R3)', async (t) => {
  // A scoped clock and timer, nothing else changed: `performance.now` reads `clock`, and the deadline timers the adapter sets
  // are held here and never run — so every case is decided by the adapter's own clock comparison alone, as when a busy event
  // loop runs its timers late. `pause` advances the clock the moment the adapter sets its timer: a stall of the call's
  // synchronous step after the deadline was read. The kernel only records hand-overs and answers what the test says.
  assert.equal(LIMITER_DEADLINE_MS, 500, 'the readings below are written for a 500 ms deadline');
  let clock = 1_000;
  let pause = 0;
  const held: number[] = [];
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(globalThis, 'setTimeout', ((_fn: () => void, ms: number) => {
    held.push(ms);
    clock += pause;
    return { held: true };
  }) as never);
  t.mock.method(globalThis, 'clearTimeout', (() => undefined) as never);
  const microtasks = async (): Promise<void> => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };
  const ALLOWED = { outcome: 'allowed', remaining: 50 }; // never limit - cost: no reclaim here
  const UNAVAILABLE = { outcome: 'unavailable' };
  let serial = 0;
  const setup = (): { limiter: DistributedRateLimiter; calls: PendingTx[]; bucket: typeof REQUEST } => {
    const { client, calls } = deferredClient();
    serial += 1;
    return { limiter: createPostgresRateLimiter({ client, keySecret: KEY32 }), calls, bucket: { ...REQUEST, key: `${String(serial).padStart(2, '0')}${'D'.repeat(41)}` } };
  };
  /** Called at `clock`; its answer is recorded the moment it settles. */
  const call = (limiter: DistributedRateLimiter, bucket: typeof REQUEST): { answer: () => unknown; done: Promise<unknown> } => {
    let answer: unknown = 'pending';
    const done = callConsume(limiter, bucket, live()).then((a) => { answer = a; return a; });
    return { answer: () => answer, done };
  };

  // A consume waits in line behind one in flight; its deadline is read at 1000, so it is 1500. The line frees at `freeAt`.
  for (const [freeAt, sends] of [[1_499, true], [1_500, false], [1_501, false]] as const) {
    clock = 1_000;
    const { limiter, calls, bucket } = setup();
    const head = call(limiter, bucket);
    const waiter = call(limiter, bucket);
    await microtasks();
    assert.equal(calls.length, 1, `free at ${freeAt}: the waiter waits in line`);
    clock = freeAt;
    calls[0].resolve(ALLOWED);
    await microtasks();
    assert.equal(calls.length, sends ? 2 : 1, `free at ${freeAt}: ${sends ? 'handed over one reading before its deadline' : 'at or past its deadline, nothing is sent'}`);
    if (sends) {
      assert.equal(calls[1].signal.aborted, false, `free at ${freeAt}: handed over live`);
      calls[1].resolve(ALLOWED); // answered at the same reading, before the deadline: obeyed
      await microtasks();
      assert.deepEqual(waiter.answer(), ALLOWED, `free at ${freeAt}: an answer one reading before the deadline is obeyed`);
    } else {
      assert.deepEqual(waiter.answer(), UNAVAILABLE, `free at ${freeAt}: answered unavailable by the clock, its timer held unrun`);
    }
    await Promise.all([head.done, waiter.done]);
  }

  // A transaction in flight since 1000 (deadline 1500) answers allowed at `answerAt`, the deadline timer not yet run.
  for (const [answerAt, obeyed] of [[1_499, true], [1_500, false], [1_501, false]] as const) {
    clock = 1_000;
    const { limiter, calls, bucket } = setup();
    const consume = call(limiter, bucket);
    await microtasks();
    assert.equal(calls.length, 1, `answer at ${answerAt}: handed over at once`);
    clock = answerAt;
    calls[0].resolve(ALLOWED);
    await microtasks();
    assert.deepEqual(consume.answer(), obeyed ? ALLOWED : UNAVAILABLE,
      `answer at ${answerAt}: ${obeyed ? 'obeyed one reading before the deadline' : 'at or past the deadline, never obeyed'}`);
    await consume.done;
  }

  // The call's synchronous step stalls `stall` ms after the deadline is read at 1000, so the call returns at 1000 + stall.
  // Measured from that return the deadline would be 1500 + stall; the adapter's own stays 1500.
  for (const stall of [600, 499]) {
    clock = 1_000;
    pause = stall;
    const { limiter, calls, bucket } = setup();
    const consume = call(limiter, bucket);
    const returned = performance.now();
    pause = 0;
    assert.equal(returned, 1_000 + stall, `stall ${stall}: the call returned ${stall} ms after its deadline was read`);
    await microtasks();
    if (stall >= LIMITER_DEADLINE_MS) {
      assert.equal(calls.length, 0, `stall ${stall}: past the deadline fixed inside the step nothing is sent, though the call has only just returned`);
      assert.deepEqual(consume.answer(), UNAVAILABLE, `stall ${stall}: answered unavailable`);
    } else {
      assert.equal(calls.length, 1, `stall ${stall}: handed over before the deadline fixed inside the step`);
      clock = 1_550; // 51 ms after the call returned: inside a deadline measured from the return, past the adapter's own
      calls[0].resolve(ALLOWED);
      await microtasks();
      assert.deepEqual(consume.answer(), UNAVAILABLE, `stall ${stall}: an answer past the deadline read inside the step is never obeyed, however late the call returned`);
    }
    await consume.done;
  }
  assert.ok(held.length === 11 && held.every((ms) => ms === LIMITER_DEADLINE_MS), `every consume set one deadline timer of LIMITER_DEADLINE_MS (${held.length}), each held, never run by this mock`);
});

// --- the early answer -------------------------------------------------------------------------------------------

test('M6R-11 an early answer never becomes a late allowance, the lane stays held until the late transaction really settles, and a late rejection is absorbed silently', async () => {
  // The kernel ignores the signal it is handed and settles 1500ms later — as a driver whose COMMIT is already in
  // flight would (supervisedPgClient.ts): the adapter's own deadline and its lane bookkeeping are all it has left.
  const { client, callCount } = lateClient(1500, 'resolve', { outcome: 'allowed', remaining: 50 });
  const limiter = createPostgresRateLimiter({ client, keySecret: KEY32 });
  const bucket = { ...REQUEST, key: 'P'.repeat(43) };

  const start = Date.now();
  const result = await callConsume(limiter, bucket, live());
  const elapsed = Date.now() - start;
  assert.deepEqual(result, { outcome: 'unavailable' }, 'never the late allowance');
  assert.ok(elapsed >= 450 && elapsed <= 1500, `elapsed ${elapsed}ms should be the internal deadline, not the 1500ms transaction`);
  assert.equal(callCount(), 1);

  await sleep(100); // land around 600ms since the first consume's own start
  const second = callConsume(limiter, bucket, live());
  await sleep(700); // now around 1400ms: still short of when the first transaction settles at ~1500ms
  assert.equal(callCount(), 1, 'the lane is still held: the second consume of the same bucket has sent nothing');
  await second; // whichever way the second one itself answers, it never started before the lane freed
  assert.ok(callCount() <= 2, 'never more than one transaction beyond the first, whatever the second one did');

  // A late transaction that eventually rejects instead: absorbed silently, no unhandled rejection, on its own bucket.
  const rejecting = lateClient(700, 'reject', new Error('late rollback'));
  const rejectingLimiter = createPostgresRateLimiter({ client: rejecting.client, keySecret: KEY32 });
  let unhandled: unknown;
  const onUnhandled = (err: unknown): void => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const rejectResult = await callConsume(rejectingLimiter, { ...REQUEST, key: 'Q'.repeat(43) }, live());
    assert.deepEqual(rejectResult, { outcome: 'unavailable' });
    await sleep(800); // past the late transaction's own 700ms rejection
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, undefined, 'a late rejection is handled by the adapter\'s own settlement bookkeeping');
});

// --- the reclaim ------------------------------------------------------------------------------------------------

test('M6R-12 a window-opening allowed consume fires exactly one background reclaim, never for anything else, coalesced to at most one in flight, and never able to change or delay the consume\'s own answer', async () => {
  // (a) exactly one reclaim transaction, with the reclaim's own bounds and statement, after remaining === limit - cost.
  const opening = reclaimTrackingClient([{ outcome: 'allowed', remaining: 90, retry_after_ms: null }]);
  const openingLimiter = createPostgresRateLimiter({ client: opening.client, keySecret: KEY32 });
  const openResult = await callConsume(openingLimiter, REQUEST, live());
  assert.deepEqual(openResult, { outcome: 'allowed', remaining: 90 });
  await sleep(30);
  assert.equal(opening.reclaimCount(), 1, 'exactly one reclaim transaction after a window-opening consume');
  assert.equal(text(opening.reclaimStatements[0]), 'select tmpos_rate_limit.m6_rate_limit_reclaim()');

  // (b) none after a limited, an unavailable, a non-opening allowed consume, or a probe.
  const limited = reclaimTrackingClient([{ outcome: 'limited', remaining: null, retry_after_ms: 5_000 }]);
  await callConsume(createPostgresRateLimiter({ client: limited.client, keySecret: KEY32 }), REQUEST, live());
  await sleep(30);
  assert.equal(limited.reclaimCount(), 0, 'a limited consume never reclaims');

  const unavailable = reclaimTrackingClient([{ outcome: 'key_mismatch', remaining: null, retry_after_ms: null }]);
  await callConsume(createPostgresRateLimiter({ client: unavailable.client, keySecret: KEY32 }), REQUEST, live());
  await sleep(30);
  assert.equal(unavailable.reclaimCount(), 0, 'an unavailable consume never reclaims');

  const partial = reclaimTrackingClient([{ outcome: 'allowed', remaining: 50, retry_after_ms: null }]); // 50 !== 90
  await callConsume(createPostgresRateLimiter({ client: partial.client, keySecret: KEY32 }), REQUEST, live());
  await sleep(30);
  assert.equal(partial.reclaimCount(), 0, 'an allowed consume that did not open a window never reclaims');

  const probed = reclaimTrackingClient([{ outcome: 'allowed', remaining: 90, retry_after_ms: null }]);
  await callProbe(createPostgresRateLimiter({ client: probed.client, keySecret: KEY32 }), live());
  await sleep(30);
  assert.equal(probed.reclaimCount(), 0, 'a probe never reclaims, whatever it reads');

  // (c) at most one reclaim in flight per instance: a second window-opening consume while one is pending triggers
  // none; once that one settles, the next window-opening consume triggers a fresh one. Different buckets throughout,
  // so only the reclaim's own single-flight bookkeeping — never the lane — is under test here.
  const gated = reclaimTrackingClient([{ outcome: 'allowed', remaining: 90, retry_after_ms: null }], { reclaimMode: 'gate' });
  const gatedLimiter = createPostgresRateLimiter({ client: gated.client, keySecret: KEY32 });
  await callConsume(gatedLimiter, { ...REQUEST, key: 'R'.repeat(43) }, live());
  await sleep(30);
  assert.equal(gated.reclaimCount(), 1, 'the first window-opening consume triggers one reclaim');
  await callConsume(gatedLimiter, { ...REQUEST, key: 'S'.repeat(43) }, live());
  await sleep(30);
  assert.equal(gated.reclaimCount(), 1, 'a second window-opening consume while a reclaim is pending triggers none');
  gated.release(0); // the pending reclaim finally settles
  await sleep(30);
  await callConsume(gatedLimiter, { ...REQUEST, key: 'T'.repeat(43) }, live());
  await sleep(30);
  assert.equal(gated.reclaimCount(), 2, 'once the pending reclaim settles, the next window-opening consume triggers a new one');
  gated.release(1); // tidy up: let the second reclaim settle too

  // (d) a reclaim that rejects never changes the consume's own answer, and is never an unhandled rejection.
  let unhandled: unknown;
  const onUnhandled = (err: unknown): void => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const rejecting = reclaimTrackingClient(
      [{ outcome: 'allowed', remaining: 90, retry_after_ms: null }],
      { reclaimMode: 'reject', reclaimFault: new Error('reclaim failed') },
    );
    const result = await callConsume(createPostgresRateLimiter({ client: rejecting.client, keySecret: KEY32 }), REQUEST, live());
    assert.deepEqual(result, { outcome: 'allowed', remaining: 90 }, 'a rejecting reclaim never changes the consume\'s own answer');
    await sleep(30);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, undefined, 'a rejecting reclaim is never an unhandled rejection');

  // (e) the consume's own answer never waits for the reclaim: even one that hangs forever does not delay it.
  const hanging = reclaimTrackingClient([{ outcome: 'allowed', remaining: 90, retry_after_ms: null }], { reclaimMode: 'hang' });
  const hangingLimiter = createPostgresRateLimiter({ client: hanging.client, keySecret: KEY32 });
  const start = Date.now();
  const hangResult = await callConsume(hangingLimiter, REQUEST, live());
  const elapsed = Date.now() - start;
  assert.deepEqual(hangResult, { outcome: 'allowed', remaining: 90 });
  assert.ok(elapsed < 300, `the consume answers without waiting for the reclaim: elapsed ${elapsed}ms`);
  await sleep(30); // the reclaim runs on its own, later, microtask chain — give it a moment to reach the kernel
  assert.equal(hanging.reclaimCount(), 1, 'the reclaim was still triggered, just never awaited');
});

// --- the bounded line ---------------------------------------------------------------------------------------------

test('M6R-13 a bucket\'s line holds at most RATE_LIMIT_LANE_DEPTH consumes: the next is refused at once and opens nothing, other buckets are unaffected, a waiter that gave up still counts until the line reaches it, and the line drains once its head settles', async () => {
  assert.equal(RATE_LIMIT_LANE_DEPTH, 64);
  const { client, calls } = deferredClient();
  const limiter = createPostgresRateLimiter({ client, keySecret: KEY32 });
  const bucket = { ...REQUEST, key: 'U'.repeat(43) };
  const answer = { outcome: 'allowed', remaining: 50 }; // never limit - cost (90): nothing here fires a reclaim

  // The head's transaction stays open (the deferred kernel ignores its signal) until the test settles it.
  const head = callConsume(limiter, bucket, live());
  await flush();
  assert.equal(calls.length, 1, 'the head starts its transaction');
  const waiters = joinLine(limiter, bucket, RATE_LIMIT_LANE_DEPTH - 1);
  await flush();
  assert.equal(calls.length, 1, 'the 63 waiters send nothing');
  assert.equal(waiters.filter((w) => w.settled()).length, 0, 'all 63 are admitted to the line and still waiting, none refused');
  await refusedAtOnce(limiter, bucket, calls, 'the consume past 1 in flight + 63 waiting');

  // A different bucket has a line of its own.
  const otherPromise = callConsume(limiter, { ...REQUEST, key: 'W'.repeat(43) }, live());
  await flush();
  assert.equal(calls.length, 2, 'a consume of a different bucket starts at once');
  calls[1].resolve(answer);
  assert.deepEqual(await otherPromise, answer);

  // Half the waiters give up by their own abort: each answers unavailable, and each still holds its place.
  const byAbort = waiters.filter((_, i) => i % 2 === 0);
  const byDeadline = waiters.filter((_, i) => i % 2 === 1);
  for (const w of byAbort) w.controller.abort();
  for (const w of byAbort) assert.deepEqual(await w.promise, { outcome: 'unavailable' }, 'a waiter that aborted');
  await refusedAtOnce(limiter, bucket, calls, 'after 32 waiters aborted, with the head still open');

  // The rest give up at their own 500ms deadline: still counted, the head still open.
  const deadlineStart = Date.now();
  for (const w of byDeadline) assert.deepEqual(await w.promise, { outcome: 'unavailable' }, 'a waiter past its deadline');
  const deadlineElapsed = Date.now() - deadlineStart;
  assert.ok(deadlineElapsed >= 300 && deadlineElapsed <= 1500, `the waiters gave up at their deadline: elapsed ${deadlineElapsed}ms`);
  assert.deepEqual(await head, { outcome: 'unavailable' }, 'the head itself answered at its deadline; its transaction is still open');
  await refusedAtOnce(limiter, bucket, calls, 'after every waiter gave up, with the head still open');
  assert.equal(calls.length, 2, 'no waiter ever sent anything');

  // The head's transaction settles: the whole line drains and the bucket's entry is gone.
  calls[0].resolve(answer);
  await flush();
  assert.equal(calls.length, 2, 'draining a line of givers-up sends nothing');
  const fresh = callConsume(limiter, bucket, live());
  await flush();
  assert.equal(calls.length, 3, 'a fresh consume of the drained bucket starts its transaction at once');

  // And the count is back to exactly zero: the fresh head plus 63 are admitted again, the next refused.
  const refill = joinLine(limiter, bucket, RATE_LIMIT_LANE_DEPTH - 1);
  await flush();
  assert.equal(refill.filter((w) => w.settled()).length, 0, 'a drained line admits a full 63 waiters again');
  await refusedAtOnce(limiter, bucket, calls, 'the consume past a refilled line');
  for (const w of refill) w.controller.abort();
  await Promise.all(refill.map((w) => w.promise));
  calls[2].resolve(answer);
  assert.deepEqual(await fresh, answer);
});

test('M6R-14 a consume whose signal is already aborted joins no line: it takes no slot, however full the line is', async () => {
  const { client, calls } = deferredClient();
  const limiter = createPostgresRateLimiter({ client, keySecret: KEY32 });
  const bucket = { ...REQUEST, key: 'Y'.repeat(43) };
  const answer = { outcome: 'allowed', remaining: 50 };

  const head = callConsume(limiter, bucket, live());
  await flush();
  const waiters = joinLine(limiter, bucket, RATE_LIMIT_LANE_DEPTH - 2); // the line now holds depth - 1
  await flush();
  assert.equal(calls.length, 1);

  const start = Date.now();
  assert.deepEqual(await callConsume(limiter, bucket, aborted()), { outcome: 'unavailable' }, 'an already-aborted consume');
  assert.ok(Date.now() - start < 200, 'answered at once, not after a wait in the line');

  const last = joinLine(limiter, bucket, 1);
  await flush();
  assert.equal(last[0].settled(), false, 'the aborted consume took no slot: one more ordinary consume is still admitted');
  await refusedAtOnce(limiter, bucket, calls, 'the consume past the full line');
  assert.equal(calls.length, 1, 'nothing but the head ever sent anything');

  for (const w of [...waiters, ...last]) w.controller.abort();
  await Promise.all([...waiters, ...last].map((w) => w.promise));
  calls[0].resolve(answer);
  assert.deepEqual(await head, answer);
});

// --- the owed reclaim ---------------------------------------------------------------------------------------------

test('M6R-15 each window opening owes one reclaim: a full batch deleted runs the next owed one, one at a time, and a short batch or a failure forgives the rest — never delaying or changing a consume\'s answer', async () => {
  const opening = { outcome: 'allowed', remaining: 90, retry_after_ms: null }; // remaining === limit - cost: a window opened
  const full = [{ m6_rate_limit_reclaim: 4 }];
  const RECLAIM_TEXT = 'select tmpos_rate_limit.m6_rate_limit_reclaim()';
  let keys = 0;
  /** One window-opening consume of a bucket of its own: its answer is its own, at once, whatever the reclaims do. */
  const open = async (limiter: DistributedRateLimiter): Promise<void> => {
    keys += 1;
    const start = Date.now();
    const result = await callConsume(limiter, { ...REQUEST, key: `${keys}`.padStart(43, 'k') }, live());
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { outcome: 'allowed', remaining: 90 }, 'the consume\'s own answer is unchanged');
    assert.ok(elapsed < 200, `the consume never waits on a reclaim: elapsed ${elapsed}ms`);
  };

  let unhandled: unknown;
  const onUnhandled = (err: unknown): void => { unhandled = err; };
  process.on('unhandledRejection', onUnhandled);
  try {
    // (a) four openings while the first reclaim is held: one in flight, three owed; each full batch runs the next.
    const a = owedReclaimClient(opening);
    const la = createPostgresRateLimiter({ client: a.client, keySecret: KEY32 });
    for (let i = 0; i < 4; i += 1) await open(la);
    await flush();
    assert.equal(a.reclaims.length, 1, 'one reclaim in flight, three owed');
    a.reclaims[0].answer(full);
    await flush();
    assert.equal(a.reclaims.length, 2, 'a full batch with reclaims owed runs the next');
    await open(la); // a fifth opening, mid-chain: owed, not started beside the one in flight
    await flush();
    assert.equal(a.reclaims.length, 2, 'never a second reclaim in flight');
    for (let i = 1; i <= 3; i += 1) {
      a.reclaims[i].answer(full);
      await flush();
      assert.equal(a.reclaims.length, i + 2, `full batch ${i + 1} runs owed reclaim ${i + 2}`);
    }
    a.reclaims[4].answer(full); // a full batch, but nothing is owed any more
    await sleep(30);
    assert.equal(a.reclaims.length, 5, 'exactly as many reclaims as window openings in total');
    assert.equal(a.maxInFlight(), 1, 'never two reclaims in flight at once');
    assert.equal(a.inFlight(), 0);
    assert.deepEqual(a.reclaims.map((r) => text(r.statement)), Array(5).fill(RECLAIM_TEXT));

    // (b) a short batch, (c) a failure or a malformed row: nothing more runs though three were owed; (d) a new
    // opening afterwards starts a fresh reclaim, and owes only itself — the three forgiven are not carried over.
    const stops: [string, (r: HeldReclaim) => void][] = [
      ['a batch of 3', (r) => r.answer([{ m6_rate_limit_reclaim: 3 }])],
      ['a batch of 0', (r) => r.answer([{ m6_rate_limit_reclaim: 0 }])],
      ['a rejected reclaim', (r) => r.fail(new Error('reclaim failed'))],
      ['a count as a string', (r) => r.answer([{ m6_rate_limit_reclaim: '4' }])],
      ['a count past the batch', (r) => r.answer([{ m6_rate_limit_reclaim: 5 }])],
      ['an extra column', (r) => r.answer([{ m6_rate_limit_reclaim: 4, extra: 1 }])],
      ['another column', (r) => r.answer([{ deleted: 4 }])],
      ['zero rows', (r) => r.answer([])],
      ['two rows', (r) => r.answer([...full, ...full])],
      ['rows not an array', (r) => r.answer({ 0: full[0], length: 1 })],
    ];
    for (const [label, stop] of stops) {
      const c = owedReclaimClient(opening);
      const lc = createPostgresRateLimiter({ client: c.client, keySecret: KEY32 });
      for (let i = 0; i < 4; i += 1) await open(lc);
      await flush();
      assert.equal(c.reclaims.length, 1, `${label}: one in flight, three owed`);
      stop(c.reclaims[0]);
      await sleep(30);
      assert.equal(c.reclaims.length, 1, `${label}: nothing more runs, though three were owed`);
      await open(lc);
      await flush();
      assert.equal(c.reclaims.length, 2, `${label}: a new window opening starts a fresh reclaim`);
      c.reclaims[1].answer(full);
      await sleep(30);
      assert.equal(c.reclaims.length, 2, `${label}: the forgiven reclaims were not carried over`);
      assert.equal(c.maxInFlight(), 1, `${label}: never two in flight`);
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled, undefined, 'a failed reclaim is never an unhandled rejection');
});

// --- the hostile signal -------------------------------------------------------------------------------------------

test('M6R-16 a signal whose removeEventListener throws never leaves its bucket\'s line held, and never answers allowed', async () => {
  class HostileSignal extends AbortSignal {
    override removeEventListener(): void { throw new Error('hostile removeEventListener'); }
  }
  const hostileSignals: [string, () => AbortController][] = [
    ['an own removeEventListener property', () => {
      const controller = new AbortController();
      Object.defineProperty(controller.signal, 'removeEventListener', { value: () => { throw new Error('hostile removeEventListener'); } });
      return controller;
    }],
    ['a genuine AbortSignal subclass', () => {
      const controller = new AbortController();
      Object.setPrototypeOf(controller.signal, HostileSignal.prototype);
      return controller;
    }],
  ];
  const answer = { outcome: 'allowed', remaining: 50 };
  const outcomeOrRejection = (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, (err: unknown) => ({ rejected: err }));

  for (const [kind, make] of hostileSignals) {
    for (const when of ['already aborted', 'aborted while waiting in the line', 'aborted with its own transaction in flight'] as const) {
      const label = `${kind}, ${when}`;
      const hostile = make();
      assert.ok(hostile.signal instanceof AbortSignal, `${label}: a genuine AbortSignal`);
      assert.throws(() => hostile.signal.removeEventListener('abort', () => undefined), /hostile/, `${label}: its removeEventListener throws`);
      const { client, calls } = deferredClient();
      const limiter = createPostgresRateLimiter({ client, keySecret: KEY32 });
      const bucket = { ...REQUEST, key: 'Z'.repeat(43) };

      if (when === 'already aborted') hostile.abort();
      // In the in-flight variant the hostile consume is the head itself; otherwise an ordinary head is ahead of it.
      const head = when === 'aborted with its own transaction in flight' ? null : callConsume(limiter, bucket, live());
      const hostilePromise = outcomeOrRejection(callConsume(limiter, bucket, hostile.signal));
      await flush();
      if (when !== 'already aborted') hostile.abort();
      const hostileAnswer = await hostilePromise;
      assert.notEqual((hostileAnswer as { outcome?: unknown }).outcome, 'allowed', `${label}: never allowed`);

      const later = callConsume(limiter, bucket, live());
      await flush();
      assert.equal(calls.length, 1, `${label}: the later consume waits while the head's transaction is open`);
      calls[0].resolve(answer);
      if (head !== null) assert.deepEqual(await head, answer, `${label}: the ordinary head`);
      await flush();
      assert.equal(calls.length, 2, `${label}: the later consume starts its transaction once the head has settled`);
      calls[1].resolve(answer);
      assert.deepEqual(await later, answer, `${label}: the later consume's own answer`);
    }
  }
});

// --- probeRateLimitKey (M6-ENTRY-P1: the deployable entry's rate-limit-key boot check) -----------------------

test('M6R-17 probeRateLimitKey returns each of the routine\'s four outcomes as-is, sends the fingerprint under RATE_LIMIT_STORE_BOUNDS, and a rejecting transaction rejects', async () => {
  for (const outcome of ['ready', 'key_mismatch', 'store_read_only', 'consume_unavailable'] as const) {
    const client = fakeClient([{ outcome }]);
    assert.equal(await probeRateLimitKey(client, KEY32, live()), outcome, outcome);
    assert.equal(client.statements.length, 1, outcome);
    assert.equal(text(client.statements[0]), PROBE_TEXT, outcome);
    assert.deepEqual(client.values, [[FINGERPRINT]], outcome);
    assert.equal(client.bounds.length, 1, outcome);
    assert.equal(client.bounds[0], RATE_LIMIT_STORE_BOUNDS, `${outcome}: the exported bounds themselves`);
  }

  const malformed: [string, unknown][] = [
    ['zero rows', []],
    ['two rows', [{ outcome: 'ready' }, { outcome: 'ready' }]],
    ['an extra column', [{ outcome: 'ready', extra: 1 }]],
    ['an unknown outcome', [{ outcome: 'not_a_real_outcome' }]],
    ['an outcome in another case', [{ outcome: 'READY' }]],
    ['no outcome', [{ outcome: undefined }]],
    ['rows not an array', { outcome: 'ready' }],
    ['a row that is null', [null]],
  ];
  for (const [label, rows] of malformed) {
    assert.equal(await probeRateLimitKey(fakeClient(rows), KEY32, live()), 'malformed', label);
  }

  const rejecting = fakeClient(undefined, new Error('down'));
  await assert.rejects(probeRateLimitKey(rejecting, KEY32, live()), /down/, 'a rejecting transaction rejects, never answering malformed for a kernel fault');

  const openFails = fakeClient(undefined, undefined, () => Promise.reject(new Error('kernel down')));
  await assert.rejects(probeRateLimitKey(openFails, KEY32, live()), /kernel down/, 'a kernel that fails before any statement runs also rejects');
});
