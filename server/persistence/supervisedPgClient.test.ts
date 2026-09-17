// Phase 4.0 M6-PG-P6/P7 — the transaction kernel's own rules, without a database (docs/phase-4/08 DA-15, DA-19, DA-20, DA-21).
//
// The fake driver below keeps the pinned driver's orderings that matter, and nothing else: a statement runs when first
// awaited and is handed to its connection by its `handler` one microtask later; a close rejects the statement in flight,
// then calls the pool's `onclose` synchronously; a statement built on the pool itself, not on a reserved connection, is
// recorded with a `pool:` prefix; and a statement handed to a closed connection is counted as the write the real driver
// would make to its dropped socket (DA-15 (1)) — every case asserts that count stays zero. The real driver's
// orderings are proved against disposable PostgreSQL in child processes (tests/db/pgDriverDefects.child.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MAX_POOLS, RETIRED_POOL_GRACE_S, TransactionFailure, createSupervisedPgClient } from './supervisedPgClient.js';
import type { DriverPool, PgTransactionScope, TransactionBounds } from './supervisedPgClient.js';

const BOUNDS: TransactionBounds = Object.freeze({ lock: '700ms', statement: '900ms', idle: '2000ms' });
const live = (): AbortSignal => new AbortController().signal;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const serverError = (code: string): Error => Object.assign(new Error(`M6-UNIT-CANARY ${code}`), { code, severity: 'ERROR' });
const lost = (): Error => Object.assign(new Error('M6-UNIT-CANARY CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });
/** A shared order for the fake's events: which came first, a statement's cancel or its connection's end. */
let clock = 0;

/**
 * `after` runs as soon as the statement is answered, before anything awaiting that answer — where a close lands behind it.
 * `stall`: never answered, and a cancel changes nothing — a network that has gone quiet; only closing the connection ends it.
 * `command`: the tag the answer carries, as the driver reports it (by default the statement's first word).
 */
type Reply = { rows?: Record<string, unknown>[]; command?: string; answer?: unknown; error?: Error; hold?: Promise<void>; after?: () => void; stall?: boolean };
/** The fake's answer to a statement: its text, and whether it was built on the pool rather than a reserved connection. */
type Replier = (text: string, onPool: boolean) => Reply;
interface FakeConnection {
  readonly id: number;
  readonly texts: string[];
  closed: boolean;
  released: number;
  reserves: number;
  ended: boolean;
  /** When end() was called (the shared clock), 0 if never. */
  endedAt: number;
  /** Every statement handed to this connection. */
  readonly queries: FakeQuery[];
  inFlight: FakeQuery | null;
  close(error?: Error): void;
}
class FakeQuery {
  handler: (q: FakeQuery) => void;
  settled = false;
  cancellable = true;
  /** When cancel() was called (the shared clock), 0 if never — whether or not it could still reach the statement. */
  cancelledAt = 0;
  private started = false;
  private readonly promise: Promise<unknown>;
  private resolveFn: (v: unknown) => void = () => undefined;
  private rejectFn: (e: unknown) => void = () => undefined;
  constructor(readonly text: string, run: (q: FakeQuery) => void) {
    this.promise = new Promise((resolve, reject) => { this.resolveFn = resolve; this.rejectFn = reject; });
    this.handler = run;
  }
  then(onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown): Promise<unknown> {
    if (!this.started) {
      this.started = true;
      void Promise.resolve().then(() => this.handler(this)); // the driver's own one-microtask hand-off
    }
    return this.promise.then(onOk, onErr);
  }
  resolve(v: unknown): void { if (!this.settled) { this.settled = true; this.resolveFn(v); } }
  reject(e: unknown): void { if (!this.settled) { this.settled = true; this.rejectFn(e); } }
  cancel(): void { this.cancelledAt = ++clock; if (this.cancellable) this.reject(Object.assign(new Error('canceling statement'), { code: '57014', severity: 'ERROR' })); }
}

/** A fake driver: every pool it builds, what each connection was handed, and the writes a real driver would make after a close. */
function fakeDriver(reply: Replier = () => ({}), onBuild: (text: string) => void = () => undefined) {
  const connections: FakeConnection[] = [];
  const built: Record<string, unknown>[] = [];
  let writesAfterClose = 0;
  const driver = (_url: string, options: Record<string, unknown>): DriverPool => {
    built.push(options);
    const conn: FakeConnection = {
      id: connections.length + 1, texts: [], closed: false, released: 0, reserves: 0, ended: false, endedAt: 0, queries: [], inFlight: null,
      close(error = lost()) {
        if (conn.closed) return;
        conn.closed = true;
        conn.inFlight?.reject(error); // the driver rejects the statement in flight first…
        (options.onclose as (id: number) => void)(conn.id); // …then reports the close, synchronously
      },
    };
    connections.push(conn);
    const execute = (onPool: boolean) => (q: FakeQuery): void => {
      if (conn.closed || conn.ended) { writesAfterClose++; return; }
      conn.texts.push(`${onPool ? 'pool:' : ''}${q.text}`);
      conn.queries.push(q);
      conn.inFlight = q;
      const r = reply(q.text, onPool);
      if (r.stall === true) {
        q.cancellable = false;
        return;
      }
      void Promise.resolve(r.hold).then(() => {
        if (conn.inFlight === q) conn.inFlight = null;
        if (r.error !== undefined) q.reject(r.error);
        else if (r.answer !== undefined) q.resolve(r.answer);
        else q.resolve(Object.assign(r.rows ?? [{}], { count: (r.rows ?? [{}]).length, command: r.command ?? q.text.split(/\s/)[0].toUpperCase(), state: { pid: 1, secret: 2 } }));
        r.after?.();
      });
    };
    const reserved = Object.assign((strings: TemplateStringsArray) => {
      const query = new FakeQuery(strings.join('$'), execute(false));
      onBuild(query.text);
      return query;
    }, {
      json: (value: unknown) => ({ jsonParameter: value }),
      release: () => { if (conn.closed) writesAfterClose++; conn.released++; },
    });
    const end = async (): Promise<void> => { conn.ended = true; conn.endedAt = ++clock; conn.inFlight?.reject(lost()); };
    const reserve = async (): Promise<typeof reserved> => { conn.reserves++; return reserved; };
    return Object.assign((strings: TemplateStringsArray) => new FakeQuery(strings.join('$'), execute(true)), { reserve, end }) as unknown as DriverPool;
  };
  return { driver, connections, built, writesAfterClose: () => writesAfterClose };
}

const clientOver = (fake: ReturnType<typeof fakeDriver>, max = 2, extra: Record<string, unknown> = {}) =>
  createSupervisedPgClient(fake.driver, 'postgres://unit.invalid/db', { max, prepare: false, ...extra });
const kinds = (texts: readonly string[]): string[] => texts.map((t) =>
  (t.startsWith('pool:') ? `open ${t.slice(5)}` : /^(begin|commit|rollback)$/.test(t) ? t : t === 'discard all' ? 'reset' : /set_config/.test(t) ? 'settings' : 'body'));
const isUnavailable = (err: unknown): boolean => err === TransactionFailure.unavailable;

test('options are checked, and nothing is opened before a transaction needs it', () => {
  const fake = fakeDriver();
  clientOver(fake, 3, { onclose: () => undefined });
  for (const bad of [{ max: 0 }, { max: MAX_POOLS + 1 }, { max: 1.5 }, { max: 2, onclose: 'x' }, null]) {
    assert.throws(() => createSupervisedPgClient(fake.driver, 'postgres://unit.invalid/db', bad as never), TypeError);
  }
  assert.equal(fake.built.length, 0);
});

test('a transaction runs BEGIN, its settings, the body and COMMIT on one reserved connection of a one-connection pool, resets it, then releases it', async () => {
  const fake = fakeDriver((text) => ({ rows: /select 7/.test(text) ? [{ n: 7 }] : [{}] }));
  const observed: unknown[] = [];
  const client = clientOver(fake, 2, { onclose: (id: unknown) => observed.push(id), prepare: true });
  assert.equal(await client.transaction(live(), BOUNDS, async (sql) => (await sql`select 7 as n`)[0].n), 7);
  assert.deepEqual([fake.built.length, fake.built[0].max, fake.built[0].prepare, typeof fake.built[0].onclose], [1, 1, false, 'function'],
    'max forced to 1, prepare forced off (DISCARD ALL removes prepared statements), onclose the kernel\'s own');
  const [conn] = fake.connections;
  assert.deepEqual(kinds(conn.texts), ['open select 1', 'begin', 'settings', 'body', 'commit', 'reset']);
  assert.equal(conn.released, 1);
  await client.transaction(live(), BOUNDS, async (sql) => sql`select 1`);
  assert.equal(fake.built.length, 1, 'the idle pool is reused');
  assert.deepEqual(kinds(conn.texts).slice(6), ['begin', 'settings', 'body', 'commit', 'reset'], 'and its open connection is not opened again');
  conn.close();
  assert.deepEqual(observed, [1], 'the caller\'s own onclose is still told');
  await client.end();
});

test('a close between statements shuts the gate synchronously: no statement, COMMIT or ROLLBACK reaches the closed connection — even one built before the close', async () => {
  for (const after of ['statement', 'commit', 'rollback', 'hand-off'] as const) {
    const fake = fakeDriver();
    const client = clientOver(fake);
    const answer = client.transaction(live(), BOUNDS, async (sql: PgTransactionScope) => {
      await sql`select 1`;
      const [conn] = fake.connections;
      if (after === 'hand-off') {
        const pending = sql`select 2`; // awaited below: the driver hands it over one microtask later…
        conn.close(); // …and the close is processed first
        return pending;
      }
      conn.close();
      if (after === 'statement') return sql`select 2`;
      if (after === 'rollback') throw new Error('M6-UNIT-CANARY refused after the close');
      return 'applied';
    });
    await assert.rejects(answer, isUnavailable, `${after}: nothing committed`);
    for (let i = 0; i < 3; i++) await tick();
    const [conn] = fake.connections;
    assert.deepEqual(kinds(conn.texts), ['open select 1', 'begin', 'settings', 'body'], `${after}: nothing more was handed to the connection`);
    assert.deepEqual([fake.writesAfterClose(), conn.released, conn.ended], [0, 0, true], `${after}: no write, never released, pool retired`);
    assert.equal(await client.transaction(live(), BOUNDS, async (sql) => (await sql`select 3`).length), 1, `${after}: the next transaction opens a fresh pool`);
    assert.equal(fake.connections.length, 2);
    await client.end();
  }
});

test('a statement lost with its connection closes the gate before the body sees the failure', async () => {
  const fake = fakeDriver((text, onPool) => (!onPool && /select 1/.test(text) ? { error: lost() } : {}));
  const client = clientOver(fake);
  let caught: unknown;
  const answer = client.transaction(live(), BOUNDS, async (sql) => {
    try { await sql`select 1`; } catch (err) { caught = err; }
    return sql`select 2`;
  });
  await assert.rejects(answer, isUnavailable);
  assert.ok(caught instanceof Error);
  assert.deepEqual(kinds(fake.connections[0].texts), ['open select 1', 'begin', 'settings', 'body'], 'neither the next statement nor a ROLLBACK was handed over');
  assert.equal(fake.writesAfterClose(), 0);
  await client.end();
});

test('a pool whose connection never opens is never reserved: it is retired, and the next transaction opens a fresh one', async () => {
  let refuseOpen = true;
  const fake = fakeDriver((_text, onPool) => (onPool && refuseOpen ? { error: lost() } : {}));
  const client = clientOver(fake, 1);
  let ran = false;
  await assert.rejects(client.transaction(live(), BOUNDS, async () => { ran = true; }), isUnavailable);
  const [first] = fake.connections;
  assert.deepEqual([ran, first.reserves, first.ended, kinds(first.texts)], [false, 0, true, ['open select 1']],
    'no reserve() on a connection that never opened — the driver would leave its request queued and reconnect for it');
  refuseOpen = false;
  assert.equal(await client.transaction(live(), BOUNDS, async () => 'applied'), 'applied');
  assert.deepEqual([fake.connections.length, fake.connections[1].reserves, fake.writesAfterClose()], [2, 1, 0]);
  await client.end();
});

test('an answer that is not rows closes the gate and retires the pool, and rows never carry the connection\'s cancel key', async () => {
  const stream = new EventEmitter();
  const fake = fakeDriver((text) => (/copy_like/.test(text) ? { answer: stream } : {}));
  const client = clientOver(fake);
  let state: unknown = 'unread';
  await assert.rejects(client.transaction(live(), BOUNDS, async (sql) => {
    state = Reflect.get(await sql`select 1`, 'state');
    return sql`select copy_like`;
  }), isUnavailable);
  assert.deepEqual([state, fake.connections[0].ended, stream.listenerCount('error')], [undefined, true, 1]);
  assert.doesNotThrow(() => stream.emit('error', new Error('M6-UNIT-CANARY destroyed')), 'the driver destroying it later throws nothing');
  await client.end();
});

test('an abort after COMMIT is built but before it is handed over answers unavailable at once, and COMMIT is never sent', async () => {
  const ctl = new AbortController();
  // Aborted in the microtask after COMMIT is built, ahead of the driver's own hand-off a microtask later.
  const fake = fakeDriver(() => ({}), (text) => { if (text === 'commit') queueMicrotask(() => ctl.abort()); });
  const client = clientOver(fake);
  await assert.rejects(client.transaction(ctl.signal, BOUNDS, async (sql) => sql`select 1`), isUnavailable);
  for (let i = 0; i < 3; i++) await tick();
  const [conn] = fake.connections;
  assert.deepEqual([conn.texts.includes('commit'), conn.released, conn.ended, fake.writesAfterClose()], [false, 0, true, 0]);
  await client.end();
});

test('COMMIT: a server ERROR is unavailable on a reusable connection; a loss once handed over is outcomeUnknown; a gate closed before it sends nothing', async () => {
  const errorAtCommit = fakeDriver((text) => (text === 'commit' ? { error: serverError('23505') } : {}));
  const c1 = clientOver(errorAtCommit);
  await assert.rejects(c1.transaction(live(), BOUNDS, async (sql) => sql`select 1`), isUnavailable);
  assert.deepEqual([kinds(errorAtCommit.connections[0].texts).slice(-2), errorAtCommit.connections[0].released], [['commit', 'reset'], 1],
    'rolled back by the server: reset, then released');

  const lostAtCommit = fakeDriver((text) => (text === 'commit' ? { error: lost() } : {}));
  const c2 = clientOver(lostAtCommit);
  await assert.rejects(c2.transaction(live(), BOUNDS, async (sql) => sql`select 1`), (err: unknown) => err === TransactionFailure.outcomeUnknown);
  assert.deepEqual([lostAtCommit.connections[0].released, lostAtCommit.connections[0].ended, lostAtCommit.connections[0].texts.includes('discard all')], [0, true, false],
    'an indeterminate COMMIT is never reset: the pool is retired');

  const closedBeforeCommit = fakeDriver();
  const c3 = clientOver(closedBeforeCommit);
  await assert.rejects(c3.transaction(live(), BOUNDS, async (sql) => {
    await sql`select 1`;
    closedBeforeCommit.connections[0].close();
    return 'applied';
  }), isUnavailable);
  assert.equal(closedBeforeCommit.connections[0].texts.includes('commit'), false);
  for (const c of [c1, c2, c3]) await c.end();
});

test('a body that fails on a usable connection is rolled back and its own failure returned, once — nothing is retried', async () => {
  const fake = fakeDriver();
  const client = clientOver(fake);
  const refusal = new Error('M6-UNIT-CANARY a refusal');
  let runs = 0;
  await assert.rejects(client.transaction(live(), BOUNDS, async (sql) => { runs++; await sql`select 1`; throw refusal; }), (err: unknown) => err === refusal);
  assert.deepEqual([kinds(fake.connections[0].texts), fake.connections[0].released, runs], [['open select 1', 'begin', 'settings', 'body', 'rollback', 'reset'], 1, 1]);
  await client.end();
});

test('the reset is sent only once COMMIT or ROLLBACK is acknowledged, and the connection is released only once the reset is: a caller waiting for the pool starts after it', async () => {
  let letReset: () => void = () => undefined;
  const resetHeld = new Promise<void>((resolve) => { letReset = resolve; });
  const releasedAtReset: number[] = [];
  const fake = fakeDriver((text) => {
    if (text !== 'discard all') return {};
    releasedAtReset.push(fake.connections[0].released);
    return releasedAtReset.length === 1 ? { hold: resetHeld } : {};
  });
  const client = clientOver(fake, 1);
  const order: string[] = [];
  const first = client.transaction(live(), BOUNDS, async (sql) => { await sql`select 1`; order.push('first'); return 'first'; });
  const second = client.transaction(live(), BOUNDS, async (sql) => { order.push('second'); await sql`select 2`; throw new Error('M6-UNIT-CANARY second refused'); });
  for (let i = 0; i < 10; i++) await tick();
  const [conn] = fake.connections;
  assert.deepEqual([kinds(conn.texts), order, conn.released], [['open select 1', 'begin', 'settings', 'body', 'commit', 'reset'], ['first'], 0],
    'COMMIT acknowledged and its reset still running: the connection is not released, and the waiting caller has not started');
  letReset();
  assert.equal(await first, 'first');
  await assert.rejects(second, /second refused/);
  assert.deepEqual([kinds(conn.texts).slice(6), releasedAtReset, conn.released, fake.built.length], [['begin', 'settings', 'body', 'rollback', 'reset'], [0, 1], 2, 1],
    'the waiting caller ran on the same connection once it was reset, and its ROLLBACK was reset before release too');
  await client.end();
});

test('a close before the reset, while it runs, or between its build and its hand-off keeps the known answer, writes nothing after the close, and retires the pool', async () => {
  const refusal = new Error('M6-UNIT-CANARY refused by the body');
  for (const ending of ['commit', 'rollback'] as const) {
    for (const when of ['before', 'during', 'hand-off'] as const) {
      let armed = true; // the first transaction's connection only; the next transaction's runs untouched
      const close = (): void => { armed = false; fake.connections[0].close(); };
      const fake = fakeDriver(
        (text) => (!armed ? {} : when === 'before' && text === ending ? { after: close } // answered, and closed before anything sees the answer
          : when === 'during' && text === 'discard all' ? { hold: new Promise<void>(() => { setImmediate(close); }) } : {}),
        (text) => { if (armed && when === 'hand-off' && text === 'discard all') close(); },
      );
      const client = clientOver(fake);
      const answer = client.transaction(live(), BOUNDS, async (sql) => {
        await sql`select 1`;
        if (ending === 'rollback') throw refusal;
        return 'applied';
      });
      if (ending === 'commit') assert.equal(await answer, 'applied', `${ending}/${when}: the committed answer stands`);
      else await assert.rejects(answer, (err: unknown) => err === refusal, `${ending}/${when}: the body's own failure stands`);
      for (let i = 0; i < 3; i++) await tick();
      const [conn] = fake.connections;
      const handed = ['open select 1', 'begin', 'settings', 'body', ending, ...(when === 'during' ? ['reset'] : [])];
      assert.deepEqual([kinds(conn.texts), fake.writesAfterClose(), conn.released, conn.ended], [handed, 0, 0, true],
        `${ending}/${when}: no reset handed over after the close, nothing written to it, never released, the pool retired`);
      assert.equal(await client.transaction(live(), BOUNDS, async () => 'next'), 'next');
      assert.equal(fake.connections.length, 2, `${ending}/${when}: the next transaction opens a fresh pool`);
      await client.end();
    }
  }
});

test('an abort while the reset stalls answers the committed outcome at once and retires the pool then: the waiting caller is served by a fresh pool, never that connection', async () => {
  let resets = 0;
  const fake = fakeDriver((text) => (text === 'discard all' && ++resets === 1 ? { stall: true } : {}));
  const client = clientOver(fake, 1);
  const ctl = new AbortController();
  const answer = client.transaction(ctl.signal, BOUNDS, async (sql) => { await sql`select 1`; return 'applied'; });
  const waiting = client.transaction(live(), BOUNDS, async (sql) => (await sql`select 2`).length);
  for (let i = 0; i < 10; i++) await tick();
  const [conn] = fake.connections;
  assert.deepEqual(kinds(conn.texts).slice(-2), ['commit', 'reset'], 'COMMIT acknowledged, the reset in flight');
  ctl.abort();
  assert.equal(await answer, 'applied', 'the abort answers what committed, never unavailable');
  assert.equal(await waiting, 1);
  assert.deepEqual([conn.released, conn.ended, fake.connections.length, kinds(fake.connections[1].texts)[0], fake.writesAfterClose()], [0, true, 2, 'open select 1', 0],
    'a reset no cancel reaches does not hold the pool: it is retired unreleased at the abort, and the waiting caller served by a fresh pool');
  await client.end();
});

test('a reset that fails is never retried and nothing is replayed: the committed answer stands, the body ran once, and the pool is retired', async () => {
  for (const failure of [serverError('25001'), lost()]) {
    let runs = 0;
    const fake = fakeDriver((text) => (text === 'discard all' ? { error: failure } : {}));
    const client = clientOver(fake);
    assert.equal(await client.transaction(live(), BOUNDS, async (sql) => { runs++; await sql`insert into t values (1)`; return 'applied'; }), 'applied');
    const [conn] = fake.connections;
    assert.deepEqual([kinds(conn.texts), runs, conn.released, conn.ended], [['open select 1', 'begin', 'settings', 'body', 'commit', 'reset'], 1, 0, true], String(failure.message));
    await client.end();
  }
});

test('an abort retires the pool at once: a body that never finishes, a statement no cancel reaches, or a ROLLBACK that never answers holds no pool, and the caller waiting for it is served by a fresh one', async () => {
  for (const stuck of ['body', 'statement', 'rollback'] as const) {
    const fake = fakeDriver((text) => ((stuck === 'statement' && /pg_sleep/.test(text)) || (stuck === 'rollback' && text === 'rollback') ? { stall: true } : {}));
    const client = clientOver(fake, 1);
    const ctl = new AbortController();
    const answer = client.transaction(ctl.signal, BOUNDS, async (sql) => {
      await sql`select 1`;
      if (stuck === 'body') await new Promise<void>(() => undefined);
      if (stuck === 'statement') await sql`select pg_sleep(1000)`;
      throw new Error('M6-UNIT-CANARY refused');
    });
    const waiting = client.transaction(live(), BOUNDS, async () => 'served');
    for (let i = 0; i < 10; i++) await tick();
    ctl.abort();
    await assert.rejects(answer, isUnavailable, `${stuck}: nothing committed`);
    assert.equal(await waiting, 'served', `${stuck}: the waiting caller is served`);
    const [conn] = fake.connections;
    const handed = ['open select 1', 'begin', 'settings', 'body', ...(stuck === 'statement' ? ['body'] : stuck === 'rollback' ? ['rollback'] : [])];
    assert.deepEqual([kinds(conn.texts), conn.released, conn.ended, fake.connections.length, fake.writesAfterClose()], [handed, 0, true, 2, 0],
      `${stuck}: nothing more sent on the aborted connection — no ROLLBACK, no reset — never released, retired, and a fresh pool served the next caller`);
    const cancelled = conn.queries.filter((q) => q.cancelledAt > 0);
    assert.deepEqual([cancelled.map((q) => q.text), cancelled.every((q) => q.cancelledAt < conn.endedAt)], [stuck === 'statement' ? ['select pg_sleep(1000)'] : [], true],
      `${stuck}: only a body statement in flight is cancelled — once, and before the connection is ended; never ROLLBACK`);
    await client.end();
  }
});

test('once end() has begun, a transaction still finishing — its body or its reset — answers, and its connection is retired rather than reset or reused, within the grace', async () => {
  for (const at of ['body', 'reset'] as const) {
    let finish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const fake = fakeDriver((text) => (at === 'reset' && text === 'discard all' ? { hold: held } : {}));
    const client = clientOver(fake);
    const answer = client.transaction(live(), BOUNDS, async (sql) => { await sql`select 1`; if (at === 'body') await held; return 'applied'; });
    for (let i = 0; i < 10; i++) await tick();
    const t = Date.now();
    const ended = client.end();
    finish();
    assert.equal(await answer, 'applied', `${at}: the committed answer`);
    await ended;
    const [conn] = fake.connections;
    assert.deepEqual([kinds(conn.texts).slice(-1), conn.released, conn.ended, Date.now() - t < RETIRED_POOL_GRACE_S * 1_000],
      [[at === 'body' ? 'commit' : 'reset'], 0, true, true], `${at}: no reset sent once end() began, never released, retired, end() within its grace`);
  }
});

test('the body\'s statement function stops at the end of its body: kept and called later — while the reset runs, once the pool is idle, or during the next transaction — it is refused and reaches no connection', async () => {
  for (const when of ['reset', 'idle', 'next'] as const) {
    let letReset: () => void = () => undefined;
    const resetHeld = new Promise<void>((resolve) => { letReset = resolve; });
    let letNext: () => void = () => undefined;
    const nextHeld = new Promise<void>((resolve) => { letNext = resolve; });
    let resets = 0;
    const fake = fakeDriver((text) => (text === 'discard all' && ++resets === 1 && when === 'reset' ? { hold: resetHeld } : /'next'/.test(text) ? { hold: nextHeld } : {}));
    const client = clientOver(fake, 1);
    let kept: PgTransactionScope | null = null;
    const first = client.transaction(live(), BOUNDS, async (sql) => { kept = sql; await sql`select 1`; return 'applied'; });
    for (let i = 0; i < 10; i++) await tick();
    const late = (): Promise<string> => (kept as unknown as PgTransactionScope)`select pg_catalog.set_config('app.tenant_id', 'x', false)`.then(() => 'ran', () => 'refused');
    let next: Promise<unknown> | null = null;
    let seen: string;
    if (when === 'reset') {
      seen = await late();
      letReset();
      await first;
    } else {
      await first;
      if (when === 'next') {
        next = client.transaction(live(), BOUNDS, async (sql) => sql`select 'next'`);
        for (let i = 0; i < 10; i++) await tick();
      }
      seen = await late();
      letNext();
      await next;
    }
    const texts = kinds(fake.connections[0].texts);
    assert.equal(seen, 'refused', `${when}: refused`);
    assert.equal(fake.connections[0].texts.some((t) => t.includes('app.tenant_id')), false, `${when}: nothing of it reached the connection`);
    assert.deepEqual(texts.slice(0, 6), ['open select 1', 'begin', 'settings', 'body', 'commit', 'reset'], `${when}: the transaction itself ran as ever`);
    await client.end();
  }
});

test('a COMMIT the server answers ROLLBACK — a block an error the body caught left aborted — is unavailable, never the body\'s value; the transaction did end, so the connection is reset and reused', async () => {
  let commits = 0;
  const fake = fakeDriver((text) => (text === 'commit' && ++commits === 1 ? { command: 'ROLLBACK' } : /1\/0/.test(text) ? { error: serverError('22012') } : {}));
  const client = clientOver(fake);
  await assert.rejects(client.transaction(live(), BOUNDS, async (sql) => { await sql`select 1/0`.catch(() => undefined); return 'applied'; }), isUnavailable);
  const [conn] = fake.connections;
  assert.deepEqual([kinds(conn.texts).slice(-2), conn.released], [['commit', 'reset'], 1]);
  assert.equal(await client.transaction(live(), BOUNDS, async () => 'next'), 'next', 'and a COMMIT answered COMMIT is the body\'s value');
  await client.end();
});

test('only fixed text beginning with SELECT, INSERT, UPDATE, DELETE, WITH or VALUES runs: transaction control, savepoints, COPY, session commands, fragments and changeable text are refused before the driver is asked; statements run one at a time', async () => {
  const fake = fakeDriver();
  const client = clientOver(fake);
  const seen: string[] = [];
  await client.transaction(live(), BOUNDS, async (sql) => {
    for (const helper of ['savepoint', 'begin', 'unsafe', 'reserve', 'release']) {
      assert.equal((sql as unknown as Record<string, unknown>)[helper], undefined, `no ${helper}`);
    }
    const fixed = (text: string): TemplateStringsArray => Object.freeze(Object.assign([text], { raw: Object.freeze([text]) })) as unknown as TemplateStringsArray;
    const texts = ['savepoint s1', 'SAVEPOINT s1', '  release savepoint s1', 'rollback to s1', 'begin', 'start transaction', 'commit', 'end',
      'abort', 'prepare transaction \'x\'', '/* c */ savepoint s1', '-- c\nsavepoint s1', ';savepoint s1', '(select 1)',
      'copy (select 1) to stdout', 'set search_path = public', 'do $$ begin end $$', 'call p()', 'lock table t', 'listen c', 'execute s'];
    for (const text of texts) {
      await sql(fixed(text)).then(() => seen.push(`ran ${text}`), () => seen.push('refused'));
    }
    // Text that could still change before the driver reads it again: an unfrozen array, and a frozen one whose text is a getter.
    const changeable = Object.assign(['select 1'], { raw: ['select 1'] }) as unknown as TemplateStringsArray;
    const getter = Object.freeze(Object.defineProperty(Object.defineProperty([''], 0, { get: () => 'select 1', enumerable: true }), 'raw',
      { value: Object.freeze(['select 1']) })) as unknown as TemplateStringsArray;
    for (const text of [changeable, getter]) {
      await sql(text).then(() => seen.push('ran changeable text'), () => seen.push('refused'));
    }
    for (const value of [{ nested: 1 }, [1, 2], () => 1, Symbol('s')]) {
      await sql`select ${value}`.then(() => seen.push('ran a value'), () => seen.push('refused'));
    }
    await sql`select ${sql.json({ a: 1 })}, ${'text'}, ${1}, ${null}, ${true}, ${new Date(0)}`;
    await sql`with x as (select 1) insert into t select * from x`;
    await sql`values (1)`;
    const first = sql`select 1`;
    await sql`select 2`.then(() => seen.push('ran concurrently'), () => seen.push('refused'));
    await first;
    return 'ok';
  });
  assert.deepEqual(seen, Array(28).fill('refused'));
  assert.deepEqual(kinds(fake.connections[0].texts), ['open select 1', 'begin', 'settings', 'body', 'body', 'body', 'body', 'commit', 'reset'], 'none of them reached the connection');
  await client.end();
});

test('callers beyond the pool count wait in order under their own deadline; an abort while waiting answers at once and runs nothing', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fake = fakeDriver((text) => (/'hold'/.test(text) ? { hold: held } : {}));
  const client = clientOver(fake, 1);
  const order: string[] = [];
  const first = client.transaction(live(), BOUNDS, async (sql) => { await sql`select 'hold'`; order.push('first'); });
  await tick();
  const gone = new AbortController();
  const waiting = client.transaction(gone.signal, BOUNDS, async () => { order.push('aborted ran'); });
  const second = client.transaction(live(), BOUNDS, async () => { order.push('second'); });
  gone.abort();
  await assert.rejects(waiting, isUnavailable);
  release();
  await first;
  await second;
  assert.deepEqual([order, fake.built.length], [['first', 'second'], 1]);
  const already = new AbortController();
  already.abort();
  await assert.rejects(client.transaction(already.signal, BOUNDS, async () => 'x'), isUnavailable);
  await client.end();
});

test('an abort in flight cancels the statement and retires its pool; an idle pool whose connection closes is retired; end is bounded and refuses later work', async () => {
  const fake = fakeDriver((text) => (/pg_sleep/.test(text) ? { hold: new Promise(() => undefined) } : {}));
  const client = clientOver(fake, 2);
  const ctl = new AbortController();
  const answer = client.transaction(ctl.signal, BOUNDS, async (sql) => sql`select pg_sleep(10)`);
  await tick();
  ctl.abort();
  await assert.rejects(answer, isUnavailable);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual([kinds(fake.connections[0].texts), fake.connections[0].released, fake.connections[0].ended], [['open select 1', 'begin', 'settings', 'body'], 0, true],
    'cancelled, nothing more sent, and the pool retired: a late cancel could otherwise interrupt the next transaction on that session');
  assert.equal(await client.transaction(live(), BOUNDS, async (sql) => (await sql`select 1`).length), 1);
  fake.connections[1].close();
  await tick();
  assert.deepEqual([fake.connections[1].ended, fake.writesAfterClose()], [true, 0], 'an idle pool whose connection closed is retired at once');

  const stuck = client.transaction(live(), BOUNDS, async (sql) => sql`select pg_sleep(1000)`);
  stuck.catch(() => undefined);
  await tick();
  const t = Date.now();
  await client.end();
  assert.ok(Date.now() - t < (RETIRED_POOL_GRACE_S + 1) * 1_000, 'end waited no longer than its grace');
  assert.ok(fake.connections.every((c) => c.ended));
  await assert.rejects(stuck, isUnavailable);
  await assert.rejects(client.transaction(live(), BOUNDS, async () => 'late'), isUnavailable);
});
