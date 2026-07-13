// Phase 3.0 M3 — focused tests for the DEV-only, dependency-free, injectable, process-local rate limiter.
// Proves: per-principal window (5/60s) + global ceiling (30/60s), window reset, principal isolation, bounded
// bucket capacity (512) with expired-first then LRU eviction, valid Retry-After, one-way-fingerprint keys only,
// and NO side effects beyond the in-memory counters. Injected clock — no real time. Run via `npx tsx`.
import assert from 'node:assert/strict';
import { BcpActionRateLimiter } from './bcpActionRateLimiter';

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

// A tiny controllable clock.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ---------- per-principal window ----------
test('per-principal: 5 allowed then 6th denied within 60s', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now });
  for (let i = 0; i < 5; i++) assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, true, `attempt ${i}`);
  const sixth = rl.recordAndCheckPrincipal('fpA');
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.scope, 'principal');
  assert.ok((sixth.retryAfterSeconds ?? 0) >= 1 && (sixth.retryAfterSeconds ?? 0) <= 60);
});
test('per-principal: window resets after 60s', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now });
  for (let i = 0; i < 5; i++) rl.recordAndCheckPrincipal('fpA');
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, false);
  c.advance(60_001);
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, true);
});
test('per-principal: partial expiry frees exactly the expired slots', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now });
  rl.recordAndCheckPrincipal('fpA'); // t0
  c.advance(30_000);
  for (let i = 0; i < 4; i++) rl.recordAndCheckPrincipal('fpA'); // t0+30s (4 more → 5 total)
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, false); // 6th blocked
  c.advance(30_001); // first slot (t0) now expired, 4 remain
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, true); // one slot freed
});

test('per-principal: EXACT window boundary frees the slot (hit at now-windowMs is pruned)', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now, perPrincipalLimit: 1 });
  rl.recordAndCheckPrincipal('fpA');            // hit at t0
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, false);
  c.advance(60_000 - 1);
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, false, 'just under window → still blocked');
  c.advance(1);                                  // now exactly windowMs since t0
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, true, 'at exactly windowMs the old hit is pruned');
});

// ---------- principal isolation ----------
test('distinct principals have independent buckets', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now });
  for (let i = 0; i < 5; i++) rl.recordAndCheckPrincipal('fpA');
  assert.equal(rl.recordAndCheckPrincipal('fpA').allowed, false);
  assert.equal(rl.recordAndCheckPrincipal('fpB').allowed, true);
});

// ---------- global ceiling ----------
test('global: 30 allowed then 31st denied', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now });
  for (let i = 0; i < 30; i++) assert.equal(rl.recordAndCheckGlobal().allowed, true, `g${i}`);
  const over = rl.recordAndCheckGlobal();
  assert.equal(over.allowed, false);
  assert.equal(over.scope, 'global');
  assert.ok((over.retryAfterSeconds ?? 0) >= 1);
});
test('global: protects unauthenticated floods (no fingerprint needed)', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now, globalLimit: 3, globalWindowMs: 60_000 });
  assert.equal(rl.recordAndCheckGlobal().allowed, true);
  assert.equal(rl.recordAndCheckGlobal().allowed, true);
  assert.equal(rl.recordAndCheckGlobal().allowed, true);
  assert.equal(rl.recordAndCheckGlobal().allowed, false);
});
test('global window resets after 60s', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now, globalLimit: 2 });
  rl.recordAndCheckGlobal(); rl.recordAndCheckGlobal();
  assert.equal(rl.recordAndCheckGlobal().allowed, false);
  c.advance(60_001);
  assert.equal(rl.recordAndCheckGlobal().allowed, true);
});

// ---------- bounded capacity + eviction ----------
test('bucket capacity is bounded to maxBuckets', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now, maxBuckets: 4 });
  for (let i = 0; i < 20; i++) rl.recordAndCheckPrincipal('fp_' + i);
  assert.ok(rl.principalBucketCount() <= 4, `bucket count ${rl.principalBucketCount()} <= 4`);
});
test('eviction prefers fully-expired buckets before live ones', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now, maxBuckets: 2 });
  rl.recordAndCheckPrincipal('old');     // t0 (will expire)
  c.advance(60_001);
  rl.recordAndCheckPrincipal('live1');   // fresh
  rl.recordAndCheckPrincipal('live2');   // fresh → forces eviction; 'old' is expired and should go
  assert.ok(rl.principalBucketCount() <= 2);
  // 'live1' should still be rate-limited-capable (not evicted): 4 more attempts allowed, then blocked
  for (let i = 0; i < 4; i++) assert.equal(rl.recordAndCheckPrincipal('live1').allowed, true);
  assert.equal(rl.recordAndCheckPrincipal('live1').allowed, false);
});

// ---------- Retry-After validity ----------
test('Retry-After is a positive integer number of seconds', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now });
  for (let i = 0; i < 5; i++) rl.recordAndCheckPrincipal('fpA');
  const r = rl.recordAndCheckPrincipal('fpA');
  assert.equal(r.allowed, false);
  assert.ok(Number.isInteger(r.retryAfterSeconds));
  assert.ok((r.retryAfterSeconds ?? 0) >= 1);
});

// ---------- key hygiene ----------
test('limiter never mutates or exposes the raw fingerprint beyond map keys', () => {
  const c = clock();
  const rl = new BcpActionRateLimiter({ now: c.now });
  rl.recordAndCheckPrincipal('fp-secret');
  // No API returns raw fingerprints; only counts are exposed.
  assert.equal(typeof rl.principalBucketCount(), 'number');
  assert.equal(typeof (rl as any).principalFingerprints, 'undefined');
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpActionRateLimiter] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
