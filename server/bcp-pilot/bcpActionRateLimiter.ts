// Phase 3.0 M3 — DEV-only, dependency-free, injectable, process-LOCAL rate limiter for the single controlled
// action. NOT a distributed/production limiter (process-local only; state lives in-memory and dies with the
// process). Two independent sliding windows:
//   - a GLOBAL action-route ceiling (default 30/60s) that caps every post-security attempt, including
//     unauthenticated floods (checked before auth — no principal needed); and
//   - a PER-PRINCIPAL window (default 5/60s) keyed by a ONE-WAY fingerprint of the server-derived internal
//     identity (checked after auth).
// Principal buckets are bounded (default 512) with expired-first, then LRU eviction. The limiter stores ONLY
// opaque fingerprint keys + numeric timestamps — never tokens, UIDs, emails, or IPs. No DB / Firebase / fs /
// durable write; no process-blocking timer (cleanup happens lazily on access).
//
// ponytail: two flat timestamp arrays per window; O(n) prune on access is fine at these bounds (≤30 global, ≤5
// per principal, ≤512 buckets). Swap to a ring buffer only if these caps ever grow by orders of magnitude.
//
// Server-side only. Never imported by the client bundle.

export interface RateLimiterOptions {
  perPrincipalLimit?: number;
  perPrincipalWindowMs?: number;
  globalLimit?: number;
  globalWindowMs?: number;
  maxBuckets?: number;
  /** Injectable monotonic-ish clock (ms). Defaults to Date.now. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  scope?: 'global' | 'principal';
  retryAfterSeconds?: number;
}

interface Bucket {
  hits: number[]; // ascending attempt timestamps within the window
}

const DEFAULTS = {
  perPrincipalLimit: 5,
  perPrincipalWindowMs: 60_000,
  globalLimit: 30,
  globalWindowMs: 60_000,
  maxBuckets: 512,
};

/** Drop timestamps older than `windowMs` before `now`. Mutates in place; returns the surviving array. */
function prune(hits: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < hits.length && hits[i] <= cutoff) i++;
  if (i > 0) hits.splice(0, i);
  return hits;
}

/** Seconds until the oldest in-window hit expires (≥1). */
function retryAfter(oldest: number, now: number, windowMs: number): number {
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

export class BcpActionRateLimiter {
  private readonly opts: Required<Omit<RateLimiterOptions, 'now'>>;
  private readonly now: () => number;
  private readonly global: number[] = [];
  /** Insertion/most-recent-access order is the Map's own iteration order (used for LRU eviction). */
  private readonly principals = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.opts = {
      perPrincipalLimit: options.perPrincipalLimit ?? DEFAULTS.perPrincipalLimit,
      perPrincipalWindowMs: options.perPrincipalWindowMs ?? DEFAULTS.perPrincipalWindowMs,
      globalLimit: options.globalLimit ?? DEFAULTS.globalLimit,
      globalWindowMs: options.globalWindowMs ?? DEFAULTS.globalWindowMs,
      maxBuckets: options.maxBuckets ?? DEFAULTS.maxBuckets,
    };
  }

  /** Record + check the GLOBAL ceiling. Call once per request, before auth. Caps unauthenticated floods too. */
  recordAndCheckGlobal(): RateLimitResult {
    const now = this.now();
    prune(this.global, now, this.opts.globalWindowMs);
    if (this.global.length >= this.opts.globalLimit) {
      return { allowed: false, scope: 'global', retryAfterSeconds: retryAfter(this.global[0], now, this.opts.globalWindowMs) };
    }
    this.global.push(now);
    return { allowed: true };
  }

  /** Record + check the PER-PRINCIPAL window. Call once per request, after auth, with the one-way fingerprint. */
  recordAndCheckPrincipal(fingerprint: string): RateLimitResult {
    const now = this.now();
    let bucket = this.principals.get(fingerprint);
    if (bucket) {
      // Move to most-recent position for LRU (delete + re-set).
      this.principals.delete(fingerprint);
      prune(bucket.hits, now, this.opts.perPrincipalWindowMs);
    } else {
      bucket = { hits: [] };
    }

    if (bucket.hits.length >= this.opts.perPrincipalLimit) {
      // Re-insert (still most-recent) so a spamming principal isn't evicted out from under its own limit.
      this.principals.set(fingerprint, bucket);
      this.evictIfNeeded(now);
      return { allowed: false, scope: 'principal', retryAfterSeconds: retryAfter(bucket.hits[0], now, this.opts.perPrincipalWindowMs) };
    }

    bucket.hits.push(now);
    this.principals.set(fingerprint, bucket);
    this.evictIfNeeded(now);
    return { allowed: true };
  }

  /** Evict down to maxBuckets: fully-expired buckets first, then least-recently-used. */
  private evictIfNeeded(now: number): void {
    if (this.principals.size <= this.opts.maxBuckets) return;
    // Pass 1: drop fully-expired buckets.
    for (const [key, b] of this.principals) {
      if (this.principals.size <= this.opts.maxBuckets) break;
      prune(b.hits, now, this.opts.perPrincipalWindowMs);
      if (b.hits.length === 0) this.principals.delete(key);
    }
    // Pass 2: drop least-recently-used (Map iteration is oldest-first).
    while (this.principals.size > this.opts.maxBuckets) {
      const oldestKey = this.principals.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.principals.delete(oldestKey);
    }
  }

  /** Test/telemetry: current number of live principal buckets (no fingerprints exposed). */
  principalBucketCount(): number {
    return this.principals.size;
  }
}
