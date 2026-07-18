// Phase 4.0 M3 — lifecycle / graceful-shutdown contract tests.
//
// The coordinator is fully injectable so it can be exercised WITHOUT terminating
// the test runner: the process, server, exit, and force-timer are all deps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLifecycle, type LifecycleDeps } from './lifecycle.js';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** A harness capturing call order and requested exit codes. */
function harness(over: Partial<LifecycleDeps> = {}) {
  const order: string[] = [];
  const exits: number[] = [];
  const proc = new EventEmitter();
  const deps: LifecycleDeps = {
    server: { close: (cb) => { order.push('close'); cb(); } },
    readiness: { setUnavailable: () => { order.push('unavailable'); } },
    hooks: [() => { order.push('hook'); }],
    proc,
    exit: (c) => { exits.push(c); },
    forceTimeoutMs: 1000,
    setTimer: (_ms, _cb) => ({ unref: () => {} }), // inert timer unless a test drives it
    clearTimer: () => {},
    ...over,
  };
  return { order, exits, proc, deps, lifecycle: createLifecycle(deps) };
}

test('graceful SIGTERM: readiness down, drain, hooks, exit 0 — in order', async () => {
  const h = harness();
  h.lifecycle.install();
  h.proc.emit('SIGTERM');
  await flush();
  assert.deepEqual(h.order, ['unavailable', 'close', 'hook']);
  assert.deepEqual(h.exits, [0]);
});

test('graceful SIGINT drains and exits 0', async () => {
  const h = harness();
  h.lifecycle.install();
  h.proc.emit('SIGINT');
  await flush();
  assert.deepEqual(h.exits, [0]);
});

test('readiness is set unavailable before draining begins', async () => {
  const h = harness();
  await h.lifecycle.shutdown('signal_sigterm', 0);
  assert.ok(h.order.indexOf('unavailable') < h.order.indexOf('close'), 'unavailable must precede close');
});

test('repeated shutdown is idempotent — hooks and exit run once', async () => {
  const h = harness();
  await Promise.all([h.lifecycle.shutdown('a', 0), h.lifecycle.shutdown('a', 0)]);
  await h.lifecycle.shutdown('a', 0);
  assert.deepEqual(h.order, ['unavailable', 'close', 'hook']);
  assert.deepEqual(h.exits, [0]);
});

test('a forced-shutdown deadline exits non-zero when draining hangs', async () => {
  let fire: (() => void) | undefined;
  const h = harness({
    server: { close: () => { /* never calls back — hang */ } },
    setTimer: (_ms, cb) => { fire = cb; return { unref: () => {} }; },
  });
  void h.lifecycle.shutdown('signal_sigterm', 0);
  await flush();
  assert.ok(fire, 'force timer must be armed');
  fire!();
  assert.deepEqual(h.exits, [1]);
});

test('a cleanup-hook rejection forces a non-zero exit', async () => {
  const h = harness({ hooks: [() => Promise.reject(new Error('cleanup failed'))] });
  await h.lifecycle.shutdown('signal_sigterm', 0);
  assert.deepEqual(h.exits, [1]);
});

test('a synchronously-throwing cleanup hook also forces a non-zero exit', async () => {
  const h = harness({ hooks: [() => { throw new Error('sync cleanup failure'); }] });
  await h.lifecycle.shutdown('signal_sigterm', 0);
  assert.deepEqual(h.exits, [1]);
});

test('an uncaught exception routes through the fatal path (non-zero exit)', async () => {
  const h = harness();
  h.lifecycle.install();
  h.proc.emit('uncaughtException', new Error('boom'));
  await flush();
  assert.ok(h.order.includes('unavailable'));
  assert.deepEqual(h.exits, [1]);
});

test('an unhandled rejection routes through the fatal path (non-zero exit)', async () => {
  const h = harness();
  h.lifecycle.install();
  h.proc.emit('unhandledRejection', new Error('nope'));
  await flush();
  assert.deepEqual(h.exits, [1]);
});

test('a null server still drains hooks and exits cleanly', async () => {
  const h = harness({ server: null });
  await h.lifecycle.shutdown('signal_sigterm', 0);
  assert.deepEqual(h.order, ['unavailable', 'hook']);
  assert.deepEqual(h.exits, [0]);
});

test('a fatal event during a graceful shutdown escalates the exit code to nonzero', async () => {
  // SIGTERM starts a graceful (code 0) drain that parks on a slow hook; an uncaught
  // exception fires mid-drain and must escalate the final exit code to nonzero.
  let releaseHook: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseHook = r; });
  const h = harness({ hooks: [() => gate] });
  h.lifecycle.install();
  h.proc.emit('SIGTERM');
  await flush();
  h.proc.emit('uncaughtException', new Error('mid-drain'));
  await flush();
  releaseHook();
  await flush();
  assert.deepEqual(h.exits, [1], 'a fatal mid-shutdown event must force a nonzero exit');
});

test('closing a not-yet-listening server is treated as a clean shutdown', async () => {
  // A signal during startup (before listen) must drain gracefully, not error on close.
  const h = harness({ server: { listening: false, close: () => { throw new Error('close must not be called'); } } });
  await h.lifecycle.shutdown('signal_sigterm', 0);
  assert.deepEqual(h.order, ['unavailable', 'hook']);
  assert.deepEqual(h.exits, [0]);
});
