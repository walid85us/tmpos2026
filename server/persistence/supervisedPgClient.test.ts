// Phase 4.0 M6-PG-P6 — the transaction kernel's own rules, without a database (docs/phase-4/08 DA-15, DA-19, DA-20).
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

type Reply = { rows?: Record<string, unknown>[]; answer?: unknown; error?: Error; hold?: Promise<void> };
/** The fake's answer to a statement: its text, and whether it was built on the pool rather than a reserved connection. */
type Replier = (text: string, onPool: boolean) => Reply;
interface FakeConnection {
  readonly id: number;
  readonly texts: string[];
  closed: boolean;
  released: number;
  reserves: number;
  ended: boolean;
  inFlight: FakeQuery | null;
  close(error?: Error): void;
}
class FakeQuery {
  handler: (q: FakeQuery) => void;
  settled = false;
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
  cancel(): void { this.reject(Object.assign(new Error('canceling statement'), { code: '57014', severity: 'ERROR' })); }
}

/** A fake driver: every pool it builds, what each connection was handed, and the writes a real driver would make after a close. */
function fakeDriver(reply: Replier = () => ({}), onBuild: (text: string) => void = () => undefined) {
  const connections: FakeConnection[] = [];
  const built: Record<string, unknown>[] = [];
  let writesAfterClose = 0;
  const driver = (_url: string, options: Record<string, unknown>): DriverPool => {
    built.push(options);
    const conn: FakeConnection = {
      id: connections.length + 1, texts: [], closed: false, released: 0, reserves: 0, ended: false, inFlight: null,
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
      conn.inFlight = q;
      const r = reply(q.text, onPool);
      void Promise.resolve(r.hold).then(() => {
        if (conn.inFlight === q) conn.inFlight = null;
        if (r.error !== undefined) q.reject(r.error);
        else if (r.answer !== undefined) q.resolve(r.answer);
        else q.resolve(Object.assign(r.rows ?? [{}], { count: (r.rows ?? [{}]).length, state: { pid: 1, secret: 2 } }));
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
    const end = async (): Promise<void> => { conn.ended = true; conn.inFlight?.reject(lost()); };
    const reserve = async (): Promise<typeof reserved> => { conn.reserves++; return reserved; };
    return Object.assign((strings: TemplateStringsArray) => new FakeQuery(strings.join('$'), execute(true)), { reserve, end }) as unknown as DriverPool;
  };
  return { driver, connections, built, writesAfterClose: () => writesAfterClose };
}

const clientOver = (fake: ReturnType<typeof fakeDriver>, max = 2, extra: Record<string, unknown> = {}) =>
  createSupervisedPgClient(fake.driver, 'postgres://unit.invalid/db', { max, prepare: false, ...extra });
const kinds = (texts: readonly string[]): string[] =>
  texts.map((t) => (t.startsWith('pool:') ? `open ${t.slice(5)}` : /^(begin|commit|rollback)$/.test(t) ? t : /set_config/.test(t) ? 'settings' : 'body'));
const isUnavailable = (err: unknown): boolean => err === TransactionFailure.unavailable;

test('options are checked, and nothing is opened before a transaction needs it', () => {
  const fake = fakeDriver();
  clientOver(fake, 3, { onclose: () => undefined });
  for (const bad of [{ max: 0 }, { max: MAX_POOLS + 1 }, { max: 1.5 }, { max: 2, onclose: 'x' }, null]) {
    assert.throws(() => createSupervisedPgClient(fake.driver, 'postgres://unit.invalid/db', bad as never), TypeError);
  }
  assert.equal(fake.built.length, 0);
});

test('a transaction runs BEGIN, its settings, the body and COMMIT on one reserved connection of a one-connection pool, then releases it', async () => {
  const fake = fakeDriver((text) => ({ rows: /select 7/.test(text) ? [{ n: 7 }] : [{}] }));
  const observed: unknown[] = [];
  const client = clientOver(fake, 2, { onclose: (id: unknown) => observed.push(id) });
  assert.equal(await client.transaction(live(), BOUNDS, async (sql) => (await sql`select 7 as n`)[0].n), 7);
  assert.deepEqual([fake.built.length, fake.built[0].max, typeof fake.built[0].onclose], [1, 1, 'function'], 'max forced to 1, onclose the kernel\'s own');
  const [conn] = fake.connections;
  assert.deepEqual(kinds(conn.texts), ['open select 1', 'begin', 'settings', 'body', 'commit']);
  assert.equal(conn.released, 1);
  await client.transaction(live(), BOUNDS, async (sql) => sql`select 1`);
  assert.equal(fake.built.length, 1, 'the idle pool is reused');
  assert.deepEqual(kinds(conn.texts).slice(5), ['begin', 'settings', 'body', 'commit'], 'and its open connection is not opened again');
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
  assert.equal(errorAtCommit.connections[0].released, 1);

  const lostAtCommit = fakeDriver((text) => (text === 'commit' ? { error: lost() } : {}));
  const c2 = clientOver(lostAtCommit);
  await assert.rejects(c2.transaction(live(), BOUNDS, async (sql) => sql`select 1`), (err: unknown) => err === TransactionFailure.outcomeUnknown);
  assert.deepEqual([lostAtCommit.connections[0].released, lostAtCommit.connections[0].ended], [0, true]);

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
  assert.deepEqual([kinds(fake.connections[0].texts), fake.connections[0].released, runs], [['open select 1', 'begin', 'settings', 'body', 'rollback'], 1, 1]);
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
  assert.deepEqual(kinds(fake.connections[0].texts), ['open select 1', 'begin', 'settings', 'body', 'body', 'body', 'body', 'commit'], 'none of them reached the connection');
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
