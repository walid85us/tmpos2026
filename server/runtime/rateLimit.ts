// Phase 4.0 M6 — the distributed rate-limit port and the runtime's limits (G-IDEMPOT, G-UNAUTH).
//
// DistributedRateLimiter is the only way the runtime counts requests. It is provider-independent:
// an adapter over an approved shared store implements it outside the runtime, and only the
// provider-aware composition root binds one (server/composition). No limiter has a default, a
// per-process stand-in or a fallback: startup refuses any protected route without one (app.ts),
// and a store that cannot answer is a bounded 503 — never an allowance. The in-memory limiter is
// test support outside the deployable artifact (rateLimiter.testkit.ts), which also holds the
// conformance suite every adapter must pass.
//
// The contract. A bucket is (namespace, dimension, key, limit, windowMs): a changed policy starts
// fresh buckets instead of reinterpreting old counts. Its window opens at the first consume of an
// absent or expired bucket and lasts windowMs; a consume never extends it. A consume of `cost` is
// allowed iff the bucket's count plus cost stays within `limit`: it adds the cost and answers
// `{ outcome: 'allowed', remaining: limit - count }`. Otherwise it changes neither count nor
// expiry and answers `{ outcome: 'limited', retryAfterMs }`, the time left in the window
// (1..windowMs). A consume is atomic across every caller and instance sharing the store, and one
// handed an already-aborted signal consumes nothing. A store that cannot serve answers
// `{ outcome: 'unavailable' }` or rejects — never `allowed`, whatever its own timeout would
// permit: this contract fails closed. `probe` answers exactly `true` only while consumes can be
// served — best by exercising the same store path — and touches no client bucket. An adapter
// honours the abort signal, keeps no offline queue to replay later, times out below
// LIMITER_DEADLINE_MS and lets expired buckets go. A fixed window admits up to twice `limit`
// across a window boundary: accepted, and identical on every adapter.
//
// What crosses the port: the namespace, the dimension, the bounded policy and cost, and a
// pseudonymous key — HMAC-SHA256 under the deployment's secret over the namespace, dimension and
// subject, where the subject is an address group (clientAddress.ts) or a verified principal's
// digest (sessions.ts: principalKeyOf). No raw address, provider UID, token, cookie or request
// object reaches a limiter, and the keys are the only client data the limiter stores. The secret
// arrives only through the composition boundary and is the same on every instance, so one client
// maps to one bucket everywhere; rotating it starts every bucket afresh.
//
// Every answer is validated before it is obeyed (consumeRateLimit): only an exact, in-contract
// allowance passes; an in-contract limit is a 429 whose Retry-After is the wait in whole seconds;
// anything else, a throw, a rejection or a deadline overrun is `rate_limit_unavailable` or
// `rate_limit_timeout` — a 503.
import { createHmac, createSecretKey } from 'node:crypto';
import { parseTrustedProxies } from './clientAddress.js';
import type { TrustedProxies } from './clientAddress.js';
import { outage, withDeadline } from './deadline.js';
import { EnforcementSetupError } from './routes.js';

/** Where a limit applies: every request per boundary (or outside both), and each boundary's login exchange. */
export type RateLimitNamespace = 'runtime' | 'tenant' | 'admin' | 'tenant-login' | 'admin-login';
/** What a key identifies: a client address group, a verified account, and — reserved — a tenant or a store. */
export type RateLimitDimension = 'client' | 'account' | 'tenant' | 'store';

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitRequest extends RateLimitPolicy {
  readonly namespace: RateLimitNamespace;
  readonly dimension: RateLimitDimension;
  /** The pseudonymous key: 43 base64url characters. */
  readonly key: string;
  /** What this consume spends: 1..limit. */
  readonly cost: number;
}

export type RateLimitOutcome =
  | { readonly outcome: 'allowed'; readonly remaining: number }
  | { readonly outcome: 'limited'; readonly retryAfterMs: number }
  | { readonly outcome: 'unavailable' };

/** The port. Each call is handed the port deadline's AbortSignal and may return a Promise. */
export interface DistributedRateLimiter {
  consume(request: RateLimitRequest, signal: AbortSignal): unknown;
  probe(signal: AbortSignal): unknown;
}

/** The runtime's limits, all source-defined. */
export const RATE_LIMITS = Object.freeze({
  /** Every request but the operational probes, per client, per namespace. */
  request: Object.freeze({ limit: 300, windowMs: 60_000 }),
  /** Login attempts per client, counted before any credential is verified. */
  loginClient: Object.freeze({ limit: 10, windowMs: 60_000 }),
  /** Logins per verified account, counted only once the credential is verified. */
  loginAccount: Object.freeze({ limit: 5, windowMs: 5 * 60_000 }),
});

/** The bounds of every policy the port is handed; a cost is at most its limit. */
export const RATE_LIMIT_BOUNDS = Object.freeze({ maxLimit: 1_000_000, minWindowMs: 1_000, maxWindowMs: 3_600_000 });

/**
 * The bound on one limiter call, below the port deadline: a shared counter answers in
 * milliseconds, and a slow store must not hold every request's socket for seconds before its 503.
 */
export const LIMITER_DEADLINE_MS = 500;

const KEY_SECRET_BYTES = Object.freeze({ min: 32, max: 64 });

export interface LimiterKeyring {
  keyOf(namespace: RateLimitNamespace, dimension: RateLimitDimension, subject: string): string;
}

/** Keyed pseudonyms under `secret` (32–64 bytes): the one way a subject becomes a limiter key. */
export function createLimiterKeyring(secret: unknown): LimiterKeyring {
  if (!(secret instanceof Uint8Array) || secret.byteLength < KEY_SECRET_BYTES.min || secret.byteLength > KEY_SECRET_BYTES.max) {
    throw new EnforcementSetupError('rate_limit_key_invalid');
  }
  const key = createSecretKey(Buffer.from(secret)); // a copy, held as a KeyObject: the caller's bytes may change
  return Object.freeze({
    keyOf: (namespace: RateLimitNamespace, dimension: RateLimitDimension, subject: string): string =>
      createHmac('sha256', key).update(`tmpos-rate-limit:v1\n${namespace}\n${dimension}\n${subject}`).digest('base64url'),
  });
}

/** The keyed-hash secret from its configured text — unpadded base64url of 32–64 bytes — or null. */
export function parseRateLimitKey(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{43,86}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  // The round trip refuses non-canonical text: stray bits in the last character are no key material.
  return bytes.length >= KEY_SECRET_BYTES.min && bytes.length <= KEY_SECRET_BYTES.max && bytes.toString('base64url') === text ? bytes : null;
}

/** The limits a runtime is composed with. */
export interface RequestLimitDeps {
  /** The distributed limiter: an approved shared store in production, never a per-process stand-in. */
  readonly limiter: DistributedRateLimiter;
  /** The keyed-hash secret (32–64 bytes), identical on every instance. */
  readonly keySecret: Uint8Array;
  /** Exact CIDRs of the proxies whose X-Forwarded-For is believed; empty when clients connect directly. */
  readonly trustedProxies: readonly string[];
}

export interface RequestLimits {
  readonly limiter: DistributedRateLimiter;
  readonly keyring: LimiterKeyring;
  readonly trustedProxies: TrustedProxies;
}

const LIMIT_PARTS: readonly string[] = ['limiter', 'keySecret', 'trustedProxies'];

const hasMethod = (v: unknown, name: string): boolean =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[name] === 'function';

/** An ordinary object literal: never an array, a class instance or anything inheriting its fields. */
const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Validate the composed limits; startup fails closed on anything missing or malformed. */
export function createRequestLimits(raw: unknown): RequestLimits {
  if (!isRecord(raw) || !Object.keys(raw).every((part) => LIMIT_PARTS.includes(part))) {
    throw new EnforcementSetupError('rate_limit_invalid');
  }
  const { limiter, keySecret, trustedProxies } = raw as Record<string, unknown>;
  if (!hasMethod(limiter, 'consume') || !hasMethod(limiter, 'probe')) throw new EnforcementSetupError('rate_limit_invalid');
  return Object.freeze({
    limiter: limiter as DistributedRateLimiter,
    keyring: createLimiterKeyring(keySecret),
    trustedProxies: parseTrustedProxies(trustedProxies),
  });
}

/** What the chain does with a consume: go on, refuse with a 429 and this wait, or refuse with a 503. */
export type RateLimitVerdict =
  | 'allowed'
  | { readonly retryAfterSeconds: number }
  | 'rate_limit_unavailable'
  | 'rate_limit_timeout'
  | 'rate_limit_outcome_invalid';

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/**
 * Consume under the limiter deadline (the port deadline, capped at LIMITER_DEADLINE_MS), obeying
 * only an exact, in-contract answer. An explicit `unavailable`, a throw, a rejection or an overrun
 * is an outage; any other answer breaks the contract and is logged as such. Both are a 503.
 */
export async function consumeRateLimit(limiter: DistributedRateLimiter, request: RateLimitRequest, deadlineMs: number): Promise<RateLimitVerdict> {
  let raw: unknown;
  try {
    raw = await withDeadline(Math.min(deadlineMs, LIMITER_DEADLINE_MS), (signal) => limiter.consume(request, signal));
  } catch (err) {
    return outage('rate_limit', err);
  }
  try {
    if (!isRecord(raw)) return 'rate_limit_outcome_invalid';
    // Read once each: a replaceable adapter cannot validate one value and hand back another.
    const { outcome, remaining, retryAfterMs } = raw as Record<string, unknown>;
    if (outcome === 'allowed' && isCount(remaining) && remaining >= 0 && remaining <= request.limit - request.cost) return 'allowed';
    if (outcome === 'limited' && isCount(retryAfterMs) && retryAfterMs >= 1 && retryAfterMs <= request.windowMs) {
      return Object.freeze({ retryAfterSeconds: Math.ceil(retryAfterMs / 1000) });
    }
    return outcome === 'unavailable' ? 'rate_limit_unavailable' : 'rate_limit_outcome_invalid';
  } catch {
    return 'rate_limit_outcome_invalid'; // a hostile answer — a throwing getter — breaks the contract too
  }
}
