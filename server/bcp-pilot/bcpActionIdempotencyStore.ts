// Phase 3.0 M3 — bounded, concurrency-safe, DEV-only idempotency store. REPLACES the M2 unbounded
// process-lifetime `Set<string>`. Scope of each key = actionKey + one-way principal fingerprint + client
// idempotency key. Each record stores a ONE-WAY payload fingerprint (lens + sanitized reason representation,
// hashed upstream) — never raw reason text, tokens, UIDs, or claims.
//
// Lifecycle (enforced by the caller, modeled here): begin() reserves an in-flight slot; the caller emits exactly
// one advisory marker; commit() promotes the reservation to a completed record ONLY after a successful emission;
// release() drops the reservation on sink failure so a later retry can execute. Bounds: completed records capped
// (default 512, expired-first then LRU eviction, 15-min TTL), in-flight capped (default 64, never evicted). No
// DB / Firebase / fs / durable fallback; no process-blocking timer (cleanup is lazy, on access).
//
// ponytail: no in-flight TTL/sweep — the caller's handler always commit()s or release()s within one synchronous
// invocation, so a reservation cannot leak. Add a staleness sweep only if an async emit path is ever introduced.
//
// Server-side only. Never imported by the client bundle.

export interface IdempotencyScopeKey {
  actionKey: string;
  principalFingerprint: string;
  clientKey: string;
}

export interface IdempotencyReservation {
  readonly key: string;
  readonly payloadFingerprint: string;
}

export type BeginResult =
  | { status: 'reserved'; reservation: IdempotencyReservation }
  | { status: 'duplicate' }
  | { status: 'in_flight_duplicate' }
  | { status: 'conflict' }
  | { status: 'capacity' };

export interface IdempotencyStoreOptions {
  maxCompleted?: number;
  maxInflight?: number;
  ttlMs?: number;
  now?: () => number;
}

interface CompletedRecord { payloadFingerprint: string; committedAt: number; }
interface InflightRecord { payloadFingerprint: string; startedAt: number; }

const DEFAULTS = { maxCompleted: 512, maxInflight: 64, ttlMs: 15 * 60_000 };
const SEP = ' ';

function compositeKey(s: IdempotencyScopeKey): string {
  return `${s.actionKey}${SEP}${s.principalFingerprint}${SEP}${s.clientKey}`;
}

export class BcpActionIdempotencyStore {
  private readonly maxCompleted: number;
  private readonly maxInflight: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Map iteration order = LRU order (oldest first); re-set on commit to mark most-recent. */
  private readonly completed = new Map<string, CompletedRecord>();
  private readonly inflight = new Map<string, InflightRecord>();

  constructor(options: IdempotencyStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxCompleted = options.maxCompleted ?? DEFAULTS.maxCompleted;
    this.maxInflight = options.maxInflight ?? DEFAULTS.maxInflight;
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
  }

  private isExpired(rec: CompletedRecord, now: number): boolean {
    return now - rec.committedAt >= this.ttlMs;
  }

  /** Reserve an in-flight slot, or short-circuit on a duplicate / conflict / capacity condition. */
  begin(scope: IdempotencyScopeKey, payloadFingerprint: string): BeginResult {
    const now = this.now();
    const key = compositeKey(scope);

    // 1. Completed record wins (unless expired → re-executable).
    const done = this.completed.get(key);
    if (done) {
      if (this.isExpired(done, now)) {
        this.completed.delete(key);
      } else if (done.payloadFingerprint === payloadFingerprint) {
        return { status: 'duplicate' };
      } else {
        return { status: 'conflict' };
      }
    }

    // 2. In-flight reservation for the same key.
    const flight = this.inflight.get(key);
    if (flight) {
      return flight.payloadFingerprint === payloadFingerprint
        ? { status: 'in_flight_duplicate' }
        : { status: 'conflict' };
    }

    // 3. Reserve — fail closed if the in-flight cap is exhausted.
    if (this.inflight.size >= this.maxInflight) return { status: 'capacity' };
    this.inflight.set(key, { payloadFingerprint, startedAt: now });
    return { status: 'reserved', reservation: { key, payloadFingerprint } };
  }

  /** Promote a reservation to a completed record AFTER a successful marker emission. */
  commit(reservation: IdempotencyReservation): void {
    const flight = this.inflight.get(reservation.key);
    // Only the owning reservation may commit (payload fingerprint must match what was reserved).
    if (!flight || flight.payloadFingerprint !== reservation.payloadFingerprint) return;
    this.inflight.delete(reservation.key);
    this.completed.delete(reservation.key); // re-set to move to most-recent LRU position
    this.completed.set(reservation.key, { payloadFingerprint: reservation.payloadFingerprint, committedAt: this.now() });
    this.evictCompletedIfNeeded(this.now());
  }

  /** Drop a reservation without completing it (e.g. sink failure) so a retry can execute. */
  release(reservation: IdempotencyReservation): void {
    const flight = this.inflight.get(reservation.key);
    if (flight && flight.payloadFingerprint === reservation.payloadFingerprint) {
      this.inflight.delete(reservation.key);
    }
  }

  /** Evict completed down to cap: expired records first, then least-recently-used. Never touches in-flight. */
  private evictCompletedIfNeeded(now: number): void {
    if (this.completed.size <= this.maxCompleted) return;
    for (const [key, rec] of this.completed) {
      if (this.completed.size <= this.maxCompleted) break;
      if (this.isExpired(rec, now)) this.completed.delete(key);
    }
    while (this.completed.size > this.maxCompleted) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  completedCount(): number { return this.completed.size; }
  inflightCount(): number { return this.inflight.size; }
}
