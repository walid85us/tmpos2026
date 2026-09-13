// Phase 4.0 M4 — bounded port calls: every adapter call settles by its deadline, is told to
// cancel through its AbortSignal when it overruns, and leaves no timer, listener or unhandled
// rejection behind on any completion path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { DeadlineExceeded, outage, withDeadline } from './deadline.js';

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('a call that settles in time keeps its own outcome and clears its timer on every path', async () => {
  const before = timers();
  const signals: AbortSignal[] = [];
  const values = await Promise.all(Array.from({ length: 50 }, (_, i) => withDeadline(10_000, async (signal) => {
    signals.push(signal);
    return i;
  })));
  assert.deepEqual(values, Array.from({ length: 50 }, (_, i) => i));
  assert.equal(await withDeadline(10_000, () => 'sync value'), 'sync value');
  const failure = new Error('adapter-failure');
  await assert.rejects(withDeadline(10_000, async () => { throw failure; }), (e: unknown) => e === failure, 'an async failure is its own');
  await assert.rejects(withDeadline(10_000, () => { throw failure; }), (e: unknown) => e === failure, 'a synchronous throw is caught');
  assert.equal(timers(), before, 'no deadline timer outlives its call');
  assert.ok(signals.every((s) => !s.aborted), 'a call that completed is never cancelled');
  assert.ok(signals.every((s) => getEventListeners(s, 'abort').length === 0), 'the runtime leaves no listener on the signal');
});

test('a failed call is a timeout only at the deadline, and any other rejection value — even a hostile one — is an outage', () => {
  assert.equal(outage('probe', new DeadlineExceeded()), 'probe_timeout');
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('adapter-trap'); } });
  for (const err of [new Error('x'), undefined, null, 'text', 42, hostile]) {
    assert.equal(outage('probe', err), 'probe_unavailable', 'never a throw, never a timeout');
  }
});

test('a call that overruns its deadline is cancelled through its signal, refused, and its late outcome discarded', async () => {
  const before = timers();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let seen: AbortSignal | undefined;
    let aborts = 0;
    let settleLate: (outcome: 'resolve' | 'reject') => void = () => {};
    const started = Date.now();
    await assert.rejects(withDeadline(30, (signal) => {
      seen = signal;
      signal.addEventListener('abort', () => { aborts++; }, { once: true });
      return new Promise((resolve, reject) => {
        settleLate = (outcome) => (outcome === 'resolve' ? resolve('late') : reject(new Error('late-adapter-detail')));
      });
    }), (e: unknown) => e instanceof DeadlineExceeded && !String(e).includes('late-adapter-detail'));
    assert.ok(Date.now() - started < 2_000, 'the deadline, not the adapter, ended the call');
    assert.equal(seen?.aborted, true, 'the adapter is told to cancel');
    assert.equal(aborts, 1, 'the abort is delivered exactly once');
    settleLate('reject');
    await tick();
    // A second overrun call that later resolves changes nothing either.
    let resolveLate: (v: unknown) => void = () => {};
    await assert.rejects(withDeadline(10, () => new Promise((resolve) => { resolveLate = resolve; })), (e: unknown) => e instanceof DeadlineExceeded);
    resolveLate('late');
    await tick();
    assert.equal(timers(), before, 'the fired deadline leaves no timer behind');
    assert.deepEqual(unhandled, [], 'a late rejection is never an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
