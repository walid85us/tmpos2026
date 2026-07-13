// Phase 3.0 M3 — focused tests for the bounded, concurrency-safe, DEV-only idempotency store that REPLACES the
// M2 unbounded process-lifetime Set. Proves the reserve→(emit)→commit lifecycle, first/duplicate/conflict,
// principal isolation, TTL expiry (re-executable), bounded completed capacity with expired-first-then-LRU
// eviction, never evicting in-flight, in-flight capacity exhaustion (fail-closed retryable), sink-failure release
// (no completed record + retry), and that ONLY one-way fingerprints (never raw reasons) are stored. Injected
// clock. Run via `npx tsx`.
import assert from 'node:assert/strict';
import { BcpActionIdempotencyStore, type IdempotencyScopeKey } from './bcpActionIdempotencyStore';

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
const scope = (o: Partial<IdempotencyScopeKey> = {}): IdempotencyScopeKey => ({
  actionKey: 'bcp.action.acknowledge_readiness_review', principalFingerprint: 'fpA', clientKey: 'k-0001', ...o,
});

// ---------- reserve → commit lifecycle ----------
test('first begin → reserved; after commit a matching-payload replay → duplicate', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const r = s.begin(scope(), 'pfp-1');
  assert.equal(r.status, 'reserved');
  s.commit((r as any).reservation);
  assert.equal(s.completedCount(), 1);
  assert.equal(s.inflightCount(), 0);
  assert.equal(s.begin(scope(), 'pfp-1').status, 'duplicate');
});
test('reserved but NOT yet committed: same key+payload again → in_flight_duplicate (concurrent)', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  s.begin(scope(), 'pfp-1'); // reserved, not committed
  assert.equal(s.begin(scope(), 'pfp-1').status, 'in_flight_duplicate');
});

// ---------- conflict (same key, changed payload) ----------
test('committed key + DIFFERENT payload → conflict', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const r = s.begin(scope(), 'pfp-1'); s.commit((r as any).reservation);
  assert.equal(s.begin(scope(), 'pfp-2').status, 'conflict');
});
test('in-flight key + DIFFERENT payload → conflict', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  s.begin(scope(), 'pfp-1');
  assert.equal(s.begin(scope(), 'pfp-2').status, 'conflict');
});

// ---------- principal isolation ----------
test('same client key, different principals → independent (both reserve)', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const a = s.begin(scope({ principalFingerprint: 'fpA' }), 'pfp-1'); s.commit((a as any).reservation);
  const b = s.begin(scope({ principalFingerprint: 'fpB' }), 'pfp-9');
  assert.equal(b.status, 'reserved'); // fpB not blocked by fpA's key
});

// ---------- TTL (expired records re-execute) ----------
test('completed record expires after TTL → re-executable', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now, ttlMs: 15 * 60_000 });
  const r = s.begin(scope(), 'pfp-1'); s.commit((r as any).reservation);
  assert.equal(s.begin(scope(), 'pfp-1').status, 'duplicate');
  c.advance(15 * 60_000 + 1);
  const again = s.begin(scope(), 'pfp-1'); // expired → fresh reservation
  assert.equal(again.status, 'reserved');
});

// ---------- bounded completed capacity + eviction ----------
test('completed capacity bounded to maxCompleted', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now, maxCompleted: 4 });
  for (let i = 0; i < 20; i++) { const r = s.begin(scope({ clientKey: 'k' + i }), 'p' + i); s.commit((r as any).reservation); }
  assert.ok(s.completedCount() <= 4, `completed ${s.completedCount()} <= 4`);
});
test('eviction removes expired completed before LRU-live', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now, maxCompleted: 2, ttlMs: 60_000 });
  const a = s.begin(scope({ clientKey: 'old' }), 'p1'); s.commit((a as any).reservation); // t0
  c.advance(60_001); // 'old' now expired
  const b = s.begin(scope({ clientKey: 'live1' }), 'p2'); s.commit((b as any).reservation);
  const d = s.begin(scope({ clientKey: 'live2' }), 'p3'); s.commit((d as any).reservation); // forces eviction
  assert.ok(s.completedCount() <= 2);
  // live1 must survive (expired 'old' evicted first): a matching replay is a duplicate, not a fresh reserve
  assert.equal(s.begin(scope({ clientKey: 'live1' }), 'p2').status, 'duplicate');
});
test('completed eviction never removes an in-flight reservation', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now, maxCompleted: 1 });
  s.begin(scope({ clientKey: 'inflight' }), 'pIF'); // reserved, uncommitted
  for (let i = 0; i < 5; i++) { const r = s.begin(scope({ clientKey: 'c' + i }), 'p' + i); s.commit((r as any).reservation); }
  // the in-flight reservation is still valid → its same-payload replay is an in_flight_duplicate
  assert.equal(s.begin(scope({ clientKey: 'inflight' }), 'pIF').status, 'in_flight_duplicate');
  assert.equal(s.inflightCount() >= 1, true);
});

// ---------- in-flight capacity exhaustion ----------
test('in-flight cap exhaustion → capacity (fail-closed retryable)', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now, maxInflight: 3 });
  for (let i = 0; i < 3; i++) assert.equal(s.begin(scope({ clientKey: 'f' + i }), 'p' + i).status, 'reserved');
  assert.equal(s.begin(scope({ clientKey: 'f3' }), 'p3').status, 'capacity');
});

// ---------- sink failure → release ----------
test('release clears in-flight, creates NO completed record, permits retry', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const r = s.begin(scope(), 'pfp-1');
  s.release((r as any).reservation); // simulate sink failure
  assert.equal(s.inflightCount(), 0);
  assert.equal(s.completedCount(), 0);
  const retry = s.begin(scope(), 'pfp-1'); // retry succeeds as a fresh reservation
  assert.equal(retry.status, 'reserved');
});

// ---------- lifecycle-guard no-ops (exactly-once safety) ----------
test('double commit of the same reservation is a no-op (no second completed record)', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const r = s.begin(scope(), 'pfp-1'); const res = (r as any).reservation;
  s.commit(res); s.commit(res); // second commit finds no in-flight → no-op
  assert.equal(s.completedCount(), 1); assert.equal(s.inflightCount(), 0);
});
test('commit after release is a no-op (release already cleared the reservation)', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const r = s.begin(scope(), 'pfp-1'); const res = (r as any).reservation;
  s.release(res); s.commit(res); // no in-flight to promote
  assert.equal(s.completedCount(), 0); assert.equal(s.inflightCount(), 0);
});
test('release with a mismatched-fingerprint reservation does NOT drop the live in-flight entry', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const r = s.begin(scope(), 'pfp-real'); const key = (r as any).reservation.key;
  s.release({ key, payloadFingerprint: 'pfp-WRONG' }); // guard mismatch → safe no-op
  assert.equal(s.inflightCount(), 1, 'live reservation must survive a stale/wrong release');
  assert.equal(s.begin(scope(), 'pfp-real').status, 'in_flight_duplicate'); // still reserved
});

// ---------- exact TTL boundary ----------
test('completed record at EXACTLY ttl is expired (re-executable); at ttl-1 still duplicate', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now, ttlMs: 15 * 60_000 });
  const r = s.begin(scope(), 'pfp-1'); s.commit((r as any).reservation);
  c.advance(15 * 60_000 - 1);
  assert.equal(s.begin(scope(), 'pfp-1').status, 'duplicate', 'just under ttl → still duplicate');
  c.advance(1); // now exactly ttl elapsed
  assert.equal(s.begin(scope(), 'pfp-1').status, 'reserved', 'at exactly ttl → expired, re-executable');
});

// ---------- key hygiene ----------
test('store retains only fingerprints, never a raw reason field', () => {
  const c = clock();
  const s = new BcpActionIdempotencyStore({ now: c.now });
  const r = s.begin(scope(), 'pfp-1'); s.commit((r as any).reservation);
  const dump = JSON.stringify((s as any));
  assert.ok(!/reason/i.test(dump), 'no raw reason retained');
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpActionIdempotencyStore] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
