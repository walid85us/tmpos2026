// Phase 4.0 M6-PG-P5 — the pool supervisor's decisions, at the pool boundary (docs/phase-4/08 DA-15).
//
// The defect it contains — a pool slot the pinned driver leaves unable to reconnect — and the recovery from it are
// proved against a disposable server in tests/db/transactionalStore.integration.test.mjs (M6-PG-24, M6-PG-26). This
// suite pins what is decided without one: which failures retire a pool, that a retired pool is never used again,
// that nothing is retried, and that end is bounded and final. The scripted pools stand only at the driver boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_ENDED, RETIRED_POOL_GRACE_S, createSupervisedPgClient } from './supervisedPgClient.js';
import type { PgPool } from './supervisedPgClient.js';
import type { PgTransaction } from './postgresTransactionalStore.js';

type Outcome = 'body-throws' | 'lost' | 'commit-fails' | 'ok';

/** Pools whose next transaction ends as `next` says; each records the transactions it ran and how it was ended. */
function pools() {
  const made: { begins: number; ends: { timeout: number }[]; endGate: Promise<void> }[] = [];
  let next: Outcome = 'ok';
  let endGate: Promise<void> = Promise.resolve();
  const bodyError = new Error('M6-UNIT-CANARY refused by the body');
  const connect = (): PgPool => {
    const record = { begins: 0, ends: [] as { timeout: number }[], endGate };
    made.push(record);
    return {
      async begin(fn) {
        record.begins++;
        const outcome = next;
        const tx = (() => Promise.resolve([])) as unknown as PgTransaction;
        if (outcome === 'lost') throw Object.assign(new Error('M6-UNIT-CANARY write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });
        const result = await fn(tx); // a body that throws rejects here with its own error, as the driver rethrows it
        if (outcome === 'commit-fails') throw Object.assign(new Error('M6-UNIT-CANARY terminating connection'), { code: '57P01', severity: 'FATAL' });
        return result;
      },
      async end(options) {
        record.ends.push(options);
        await record.endGate;
      },
    };
  };
  return {
    connect,
    made,
    bodyError,
    set next(o: Outcome) { next = o; },
    set endGate(g: Promise<void>) { endGate = g; },
  };
}

test('a failure its body raised keeps the pool; any other retires it, once and bounded, and the next transaction opens a fresh one', async () => {
  // The store's own refusal travels as a plain object, not an Error: it must keep the pool just the same.
  const refusal = Object.freeze({ answer: 'unavailable' });
  for (const [label, failure, retires] of [
    ['the body refused with an Error', 'body-throws', false],
    ['the body refused with a value that is not an Error', 'body-throws-value', false],
    ['the connection was lost', 'lost', true],
    ['COMMIT failed with a FATAL', 'commit-fails', true],
  ] as const) {
    const p = pools();
    const client = createSupervisedPgClient(p.connect);
    assert.equal(await client.begin(async () => 'first'), 'first');
    p.next = failure === 'body-throws-value' ? 'body-throws' : failure;
    const thrown = failure === 'body-throws' ? p.bodyError : failure === 'body-throws-value' ? refusal : null;
    let bodies = 0;
    await assert.rejects(client.begin(async () => {
      bodies++;
      if (thrown !== null) throw thrown;
      return 'second';
    }), (err: unknown) => (thrown !== null ? err === thrown : err instanceof Error), `${label}: the call fails with the error it met`);
    assert.equal(bodies, failure === 'lost' ? 0 : 1, `${label}: the body ran at most once — nothing is retried`);
    p.next = 'ok';
    assert.equal(await client.begin(async () => 'third'), 'third');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(p.made.length, retires ? 2 : 1, `${label}: ${retires ? 'a fresh pool' : 'the same pool'} serves the next transaction`);
    assert.deepEqual(p.made[0].ends, retires ? [{ timeout: RETIRED_POOL_GRACE_S }] : [], `${label}: the old pool is ended ${retires ? 'once, with a bounded grace' : 'never'}`);
    assert.equal(p.made[0].begins, retires ? 2 : 3, `${label}: ${retires ? 'a retired pool runs nothing more' : 'the kept pool serves every transaction'}`);
  }
});

test('end retires the pool, waits for every retiring end — whatever it answers — and refuses every later transaction', async () => {
  const p = pools();
  let open: () => void = () => undefined;
  p.endGate = new Promise<void>((resolve) => { open = resolve; });
  const client = createSupervisedPgClient(p.connect);
  await client.begin(async () => 'ok');
  p.next = 'lost';
  await assert.rejects(client.begin(async () => 'never'));
  p.next = 'ok';
  await client.begin(async () => 'ok'); // the second pool
  let ended = false;
  const ending = client.end().then(() => { ended = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false, 'end waits for the retiring pools');
  await assert.rejects(client.begin(async () => 'late'), (err: unknown) => err instanceof Error && err.message === CLIENT_ENDED && Object.keys(err).length === 0);
  open();
  await ending;
  assert.deepEqual(p.made.map((m) => m.ends), [[{ timeout: RETIRED_POOL_GRACE_S }], [{ timeout: RETIRED_POOL_GRACE_S }]], 'each pool ended once, bounded');
  assert.equal(p.made.length, 2, 'nothing was opened after end');

  const failing = pools();
  const refused = Promise.reject(new Error('M6-UNIT-CANARY end failed'));
  refused.catch(() => undefined);
  failing.endGate = refused;
  const other = createSupervisedPgClient(failing.connect);
  await other.begin(async () => 'ok');
  await other.end(); // a pool whose end fails never fails the caller's end
});
