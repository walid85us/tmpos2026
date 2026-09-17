// Phase 4.0 M6-PG-P5/P6/P7 — one scenario per process, for M6-PG-24..27, M6-PG-30..33 and M6-PG-36 (docs/phase-4/08 DA-15, DA-17, DA-19,
// DA-20, DA-21).
//
// The pinned driver's first defect ends the process that meets it, so each scenario runs here, in a child of the PostgreSQL
// suite, which reads its exit status, its one RESULT line and everything it printed. No scenario installs an
// uncaughtException handler: a write to a dropped socket ends this process, and the parent sees it. The targets come from the
// suite alone (M6_DEFECT_TARGETS: the disposable server's DSN and client options for its owner and for the store's non-owner
// probe). Every store client is the transaction kernel over the runtime's own client options; a scenario reaches the
// connection through a TCP relay of its own (a FIN, a reset, a lost COMMIT answer) or through the driver's socket hook (a
// close processed at an exact point). The driver's `debug` and `onclose` options are the witness — every statement the
// driver builds for a connection, and when that connection closed. Only counts and fixed words leave this process.
import net from 'node:net';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import { RETIRED_POOL_GRACE_S, TransactionFailure, createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { TEST_IDEMPOTENCY_KEY } from '../../server/runtime/idempotencyStore.testkit.ts';
import { TEST_CREATE, TEST_EVENTS } from '../../server/runtime/transactionalOutbox.testkit.ts';
import { IDEMPOTENCY_DEADLINE_MS, createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';
import { defineCommands, prepareCommand } from '../../server/runtime/commandTransaction.ts';
import { defineOutboxEvents } from '../../server/runtime/outbox.ts';

const targets = JSON.parse(process.env.M6_DEFECT_TARGETS ?? 'null');
const report = (result) => console.log(`RESULT ${JSON.stringify(result)}`);
const codeOf = (e) => (typeof e?.code === 'string' ? e.code : 'none');
const settled = (p) => p.then(() => 'ok', codeOf);
const live = () => new AbortController().signal;
const outcomeOf = (p) => p.then((a) => a.outcome, (e) => (e instanceof Error && e.message === 'transactional_store_outcome_unknown' ? 'outcome_unknown' : 'rejected'));

/** A chunk from the server that ends with ReadyForQuery: the point at which the driver settles the statement it answers. */
const endsReady = (chunk) => chunk.length >= 6 && chunk[chunk.length - 6] === 0x5a && chunk.readUInt32BE(chunk.length - 5) === 5;

/** The sockets the driver opens through this hook, so the last one can be cut, or closed at an exact point. */
function sockets() {
  const opened = [];
  let behind = null;
  const closeNow = (s) => { s.destroy(); s.emit('close', false); };
  const hook = (o) => new Promise((resolve, reject) => {
    const s = o.path ? net.createConnection(o.path) : net.createConnection({ host: o.host[0], port: o.port[0] });
    s.on('data', (chunk) => {
      if (behind === null) return;
      if (chunk.includes(behind.tag)) behind.seen = true;
      if (!behind.seen || !endsReady(chunk)) return;
      behind = null;
      // The driver settles the statement in this same 'data' call; a tick runs before anything awaiting it can.
      process.nextTick(() => closeNow(s));
    });
    s.once('connect', () => { opened.push(s); resolve(s); });
    s.once('error', reject);
  });
  return {
    hook,
    cut: () => opened[opened.length - 1].destroy(),
    /** Destroyed, and its close delivered to the driver now, within this very call. */
    closeNow: () => closeNow(opened[opened.length - 1]),
    /** Closed right behind the server's next answer tagged `tag` (COMMIT, ROLLBACK): settled by the driver, unseen by its caller. */
    closeBehindAnswer: (tag) => { behind = { tag: Buffer.from(`${tag}\0`), seen: false }; },
  };
}

/**
 * A TCP relay to the target: toward the driver, the last connection's FIN or reset, the server's answer to COMMIT or to the
 * reset swallowed with the connection cut, the answer to the reset withheld on a connection left open, or every new connection
 * refused until restored.
 */
async function relay(who) {
  const t = targets[who];
  const u = new URL(t.dsn);
  const upstream = t.options.host ? { path: join(t.options.host, `.s.PGSQL.${u.port || 5432}`) } : { host: u.hostname, port: Number(u.port || 5432) };
  const pairs = [];
  let drop = null; // the next statement whose answer is swallowed: its Parse text, and 'cut' or 'hold'
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    db.on('error', () => {});
    const pair = { client, db, swallow: null };
    pairs.push(pair);
    client.on('data', (chunk) => {
      if (drop !== null && chunk.includes(drop.parse)) { pair.swallow = drop.mode; drop = null; }
      db.write(chunk);
    });
    db.on('data', (chunk) => (pair.swallow === 'cut' ? (client.destroy(), db.destroy()) : pair.swallow === null ? client.write(chunk) : undefined));
    client.on('close', () => db.destroy());
    db.on('close', () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const last = () => pairs[pairs.length - 1];
  return {
    port,
    refuse: () => { server.close(); },
    restore: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    fin: () => { last().client.end(); last().db.end(); },
    reset: () => { last().db.destroy(); last().client.resetAndDestroy(); },
    dropNextCommitAnswer: () => { drop = { parse: Buffer.from('\0commit\0'), mode: 'cut' }; },
    dropNextResetAnswer: () => { drop = { parse: Buffer.from('\0discard all\0'), mode: 'cut' }; },
    holdNextResetAnswer: () => { drop = { parse: Buffer.from('\0discard all\0'), mode: 'hold' }; },
    close: () => new Promise((resolve) => { for (const p of pairs) { p.client.destroy(); p.db.destroy(); } server.close(resolve); }),
  };
}

/** Per connection id, what the driver built and whether it came after that connection closed. */
function witness() {
  const closed = new Set();
  const built = new Map();
  let waiters = [];
  let onReset = null;
  const kind = (text) => (/^\s*begin\s*$/i.test(text) ? 'B' : /^\s*commit\s*$/i.test(text) ? 'C' : /^\s*rollback\s*$/i.test(text) ? 'R'
    : /^\s*discard all\s*$/i.test(text) ? 'D' : 'S');
  return {
    debug: (id, text) => {
      if (!built.has(id)) built.set(id, []);
      built.get(id).push(`${kind(text)}${closed.has(id) ? '!' : ''}`);
      if (kind(text) === 'D' && onReset !== null) { const told = onReset; onReset = null; told(); }
    },
    /** Resolves when the driver next takes a reset. */
    nextReset: () => new Promise((resolve) => { onReset = resolve; }),
    onclose: (id) => {
      closed.add(id);
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve();
    },
    closedOnce: () => new Promise((resolve) => { waiters.push(resolve); }),
    /** Statements built after their connection closed; a COMMIT or ROLLBACK with no BEGIN of its own before it; COMMITs built. */
    tally: () => {
      let afterClose = 0;
      let orphanEnds = 0;
      let commits = 0;
      for (const list of built.values()) {
        let open = false;
        for (const entry of list) {
          if (entry.endsWith('!')) afterClose++;
          if (entry[0] === 'B') open = true;
          else if (entry[0] === 'C' || entry[0] === 'R') {
            if (!open) orphanEnds++;
            if (entry[0] === 'C') commits++;
            open = false;
          }
        }
      }
      // The last two statements the driver took on each connection that closed, in order of the close.
      const tails = [...closed].map((id) => (built.get(id) ?? []).slice(-2).join(''));
      return { afterClose, orphanEnds, commits, connections: built.size, closes: closed.size, tails };
    },
  };
}

/** The transaction kernel for `who`, as the runtime would compose one, over `transport` (a relay port or the socket hook). */
function kernel(who, w, transport, max = 1, driver = postgres) {
  const t = targets[who];
  return createSupervisedPgClient(driver, t.dsn, {
    ...runtimeClientOptions(t.dsn), ssl: false, max, idle_timeout: 0, connect_timeout: 2, ...t.options,
    ...(transport.port !== undefined ? { host: '127.0.0.1', port: transport.port } : { socket: transport.hook }),
    debug: w.debug, onclose: w.onclose,
  });
}

const EVENTS = defineOutboxEvents(TEST_EVENTS);
const COMMANDS = defineCommands([TEST_CREATE], EVENTS);
const KEYRING = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
const mutatorOf = (apply) => Object.freeze({ kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', apply });
const ownerSql = () => postgres(targets.owner.dsn, { ...targets.owner.options, max: 1, onnotice: () => {} });

/** A fresh operation acquired on `store`, and a create command held by it. */
async function held(store) {
  const op = KEYRING.operationOf(randomUUID(), Object.freeze({ authProvider: 'm6-defect', authProviderUid: 'actor' }), {
    method: 'POST', path: '/v1/m6-defect', audience: null, tenant: null, store: null, body: Buffer.from(randomUUID()),
  });
  const lease = randomBytes(32).toString('base64url');
  const acquired = await store.idempotency.acquire(Object.freeze({ scope: op.scope, fingerprint: op.fingerprint, lease, leaseMs: 60_000, retentionMs: 600_000 }), live());
  const id = randomUUID();
  const prepared = prepareCommand(COMMANDS.contract(TEST_CREATE.kind), EVENTS, {
    aggregateId: id, expectedVersion: null, changes: { name: 'defect', quantity: 1 },
    events: [{ type: 'conformance.item.created', payload: { name: 'defect', quantity: 1 } }], response: { status: 201, body: { id } },
  }, {
    scope: op.scope, lease, newAggregateId: id, authorization: Object.freeze({ scope: 'platform', permission: 'conformance.write' }),
    // These proofs are about the driver's close window, not about identity: no route resolves a
    // principal yet, so the command commits without a trusted context, as the runtime does.
    context: null,
    seal: (envelope) => KEYRING.seal(envelope, op),
  });
  return { op, acquired: acquired.outcome, command: prepared.command };
}

const rawPool = (s) => postgres(targets.owner.dsn, {
  ...runtimeClientOptions(targets.owner.dsn), ssl: false, max: 1, idle_timeout: 0, connect_timeout: 1, ...targets.owner.options, socket: s.hook,
});

/** Witness, raw driver: the body rethrows the loss, and the driver answers it with a ROLLBACK to the dropped socket. */
async function writeAfterClose() {
  const s = sockets();
  const sql = rawPool(s);
  sql.begin(async (tx) => { await tx`select pg_catalog.pg_sleep(2)`; }).catch(() => undefined);
  await sleep(150);
  s.cut();
  await sleep(2_000);
  report({ survived: true }); // reached only if the driver never wrote to the dropped socket
  await sql.end({ timeout: 1 });
}

/** Witness, raw driver: a close in the same turn as a write it was handed; every later use of the slot, and the end. */
async function poisonedSlot() {
  const s = sockets();
  const sql = rawPool(s);
  await sql`select 1`;
  const immediate = await new Promise((resolve) => setImmediate(() => { s.cut(); settled(sql`select 1`).then(resolve); }));
  const rounds = [];
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    rounds.push({ code: await settled(sql`select 1`), ms: Date.now() - t });
  }
  const t = Date.now();
  await sql.end({ timeout: 1 });
  report({ immediate, rounds, endMs: Date.now() - t });
}

/**
 * The close window (DA-19), for one kind of loss: a command's mutator runs a statement, the connection is lost, and only once
 * the driver has processed the close does the mutator go on — to its next statement, to returning (COMMIT would follow) or to
 * throwing (ROLLBACK would follow). 'sync' processes the close within the mutator's own call; 'handoff' after a statement is
 * built and awaited but before the driver hands it over — one step only, since that statement's refusal is what the mutator
 * then meets. Then the next command, which must find a fresh pool.
 */
async function gap(loss) {
  const steps = [];
  for (const step of loss === 'handoff' ? ['statement'] : ['statement', 'commit', 'rollback']) {
    const w = witness();
    const transport = ['sync', 'handoff'].includes(loss) ? sockets() : await relay('store');
    const client = kernel('store', w, transport, 1);
    const owner = ownerSql();
    const apply = async (sql) => {
      const [{ pid }] = await sql`select pg_catalog.pg_backend_pid() as pid`;
      if (loss === 'handoff') {
        const pending = sql`select 2`;
        transport.closeNow();
        return pending; // refused at its hand-off: the mutator fails with it
      }
      const closed = w.closedOnce();
      if (loss === 'sync') transport.closeNow();
      else if (loss === 'fin') transport.fin();
      else if (loss === 'reset') transport.reset();
      else await owner`select pg_catalog.pg_terminate_backend(${pid})`;
      await closed;
      if (step === 'statement') await sql`select 2`;
      if (step === 'rollback') throw new Error('refused after the loss');
      return 'applied';
    };
    const first = await held(createPostgresTransactionalStore({ client, mutators: [mutatorOf(apply)] }));
    const answer = await outcomeOf(createPostgresTransactionalStore({ client, mutators: [mutatorOf(apply)] }).transactions.commit(first.command, live()));
    await sleep(300); // a write scheduled on a dropped socket would have ended this process by now
    const t = Date.now();
    const next = await held(createPostgresTransactionalStore({ client, mutators: [mutatorOf(async () => 'applied')] }));
    steps.push({ step, acquired: first.acquired, answer, next: next.acquired, nextWithinDeadline: Date.now() - t < IDEMPOTENCY_DEADLINE_MS, ...w.tally() });
    await client.end();
    await owner.end({ timeout: 1 });
    if (transport.close !== undefined) await transport.close();
  }
  report({ loss, steps });
}

/** A write queued on the connection when it closes; that pool is never used again, and the next call opens a fresh one. */
async function queuedWrite() {
  const w = witness();
  const s = sockets();
  const client = kernel('store', w, s, 1);
  const store = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async (sql) => {
    await sql`select 1`;
    const pending = sql`select 2`;
    await Promise.resolve();
    await Promise.resolve(); // the driver has taken it: its short write waits for the next turn
    s.closeNow();
    await pending;
    return 'applied';
  })] });
  const first = await held(store);
  const answer = await outcomeOf(store.transactions.commit(first.command, live()));
  await sleep(300);
  const t = Date.now();
  const next = await held(store);
  const nextMs = Date.now() - t;
  const t2 = Date.now();
  await client.end();
  report({ acquired: first.acquired, answer, next: next.acquired, nextWithinDeadline: nextMs < IDEMPOTENCY_DEADLINE_MS, endMs: Date.now() - t2, ...w.tally() });
}

/** COMMIT handed over and its answer lost: indeterminate, landed exactly once, replayed, never repeated. */
async function commitLost() {
  const w = witness();
  const r = await relay('store');
  const client = kernel('store', w, r, 1);
  const store = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async () => 'applied')] });
  const first = await held(store);
  r.dropNextCommitAnswer();
  const answer = await outcomeOf(store.transactions.commit(first.command, live()));
  const owner = ownerSql();
  const [{ completed }] = await owner`select count(*)::int as completed from tmpos_internal.idempotency_record where scope = ${first.op.scope} and response is not null`;
  const replay = await store.idempotency.acquire({ scope: first.op.scope, fingerprint: first.op.fingerprint, lease: randomBytes(32).toString('base64url'), leaseMs: 60_000, retentionMs: 600_000 }, live());
  const again = await outcomeOf(store.transactions.commit(first.command, live()));
  report({ answer, completed, replay: replay.outcome, again, ...w.tally() });
  await client.end();
  await owner.end({ timeout: 1 });
  await r.close();
}

/**
 * Pool-queue pressure and concurrency: two pools, six commands. The server ends the first command's connection while its mutator
 * waits and the others queue for a pool; they commit on the surviving pool and a fresh one, and no COMMIT or ROLLBACK is ever
 * built on a connection after its close, or without a BEGIN of its own before it.
 */
async function pressure() {
  const w = witness();
  const r = await relay('store');
  const client = kernel('store', w, r, 2);
  const owner = ownerSql();
  let reach;
  const reached = new Promise((resolve) => { reach = resolve; });
  const victimStore = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async (sql) => {
    const [{ pid }] = await sql`select pg_catalog.pg_backend_pid() as pid`;
    reach(pid);
    await sleep(400); // the others queue meanwhile
    return 'applied';
  })] });
  const plainStore = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async (sql) => { await sql`select pg_catalog.pg_sleep(0.05)`; return 'applied'; })] });
  const commands = [await held(victimStore), ...(await Promise.all(Array.from({ length: 5 }, () => held(plainStore))))];
  const answers = commands.map((c, i) => outcomeOf((i === 0 ? victimStore : plainStore).transactions.commit(c.command, live())));
  const pid = await reached;
  const closed = w.closedOnce();
  await owner`select pg_catalog.pg_terminate_backend(${pid})`;
  await closed;
  const outcomes = await Promise.all(answers);
  await sleep(300);
  report({ victim: outcomes[0], others: outcomes.slice(1), ...w.tally() });
  await client.end();
  await owner.end({ timeout: 1 });
  await r.close();
}

/** After a loss, a transaction stuck in a long statement: end() closes it under it within its grace, and the process lives. */
async function shutdown() {
  const w = witness();
  const s = sockets();
  const client = kernel('store', w, s, 2);
  const store = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async (sql) => { await sql`select 1`; s.closeNow(); return 'applied'; })] });
  const first = await held(store);
  const lostAnswer = await outcomeOf(store.transactions.commit(first.command, live()));
  const stuckStore = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async (sql) => { await sql`select pg_catalog.pg_sleep(30)`; return 'applied'; })] });
  const second = await held(stuckStore);
  const stuck = outcomeOf(stuckStore.transactions.commit(second.command, live()));
  await sleep(300);
  const t = Date.now();
  await client.end();
  const endMs = Date.now() - t;
  report({ lostAnswer, stuck: await stuck, endWithinBound: endMs < (RETIRED_POOL_GRACE_S + 2) * 1_000, ...w.tally() });
}

/**
 * The server unreachable, then back. Witness, raw driver: a reserve() refused, then end(), and the driver still reconnects for
 * the refused request once the server answers — a session nobody owns (DA-15 (3)). The kernel meets the same outage with three
 * transactions and ends: it never reserves a connection that has not opened, so nothing reconnects after it. Each client's
 * sessions are told apart by an application name of its own; any left are ended here.
 */
async function orphan() {
  const r = await relay('store');
  const t = targets.store;
  const owner = ownerSql();
  const tags = { driver: `m6_orphan_driver_${randomBytes(4).toString('hex')}`, kernel: `m6_orphan_kernel_${randomBytes(4).toString('hex')}` };
  const base = runtimeClientOptions(t.dsn);
  const options = (tag) => ({
    ...base, ssl: false, idle_timeout: 0, connect_timeout: 2, ...t.options, host: '127.0.0.1', port: r.port,
    connection: { ...base.connection, application_name: tag }, backoff: () => 1,
  });
  r.refuse();
  const driver = postgres(t.dsn, { ...options(tags.driver), max: 1 });
  const refused = (await settled(driver.reserve())) !== 'ok';
  await driver.end({ timeout: 0 });
  const client = createSupervisedPgClient(postgres, t.dsn, { ...options(tags.kernel), max: 2 });
  const bounds = { lock: '1000ms', statement: '2000ms', idle: '5000ms' };
  const answers = await Promise.all([0, 1, 2].map(() => client.transaction(live(), bounds, async () => 'applied')
    .then(() => 'committed', (e) => (e === TransactionFailure.unavailable ? 'unavailable' : 'other'))));
  await client.end();
  await r.restore();
  await sleep(2_500); // past the driver's one-second reconnect delay
  const [left] = await owner`select count(*) filter (where application_name = ${tags.driver})::int as driver,
    count(*) filter (where application_name = ${tags.kernel})::int as kernel from pg_catalog.pg_stat_activity`;
  await owner`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where application_name in (${tags.driver}, ${tags.kernel})`;
  report({ refused, answers, driverSessions: left.driver, kernelSessions: left.kernel });
  await owner.end({ timeout: 1 });
  await r.close();
}

/**
 * The reset (DA-21), for one way of losing it: 'before' — the close lands right behind the COMMIT or ROLLBACK answer, settled by
 * the driver but unseen by the kernel; 'during' — DISCARD ALL reached the server and its answer is lost with the connection;
 * 'handoff' — the close lands between the reset's build and the driver taking it (a pass-through proxy on the driver's reserved
 * connection closes the socket as the kernel builds it); 'abort' — the reset's answer never comes, and the caller aborts while
 * it waits. Each for a command that commits and for a fenced one the store rolls back (lease_lost), with another caller queued
 * behind it for the only pool. The answer stands; the command's effects exist exactly once and replay; nothing is taken after
 * the close; nothing is retried; the queued caller is served on a fresh connection.
 */
async function reset(variant) {
  const steps = [];
  for (const ending of ['commit', 'rollback']) {
    const w = witness();
    const transport = ['during', 'abort'].includes(variant) ? await relay('store') : sockets();
    let closeAtBuild = false;
    const proxied = (url, options) => {
      const pool = postgres(url, options);
      const watch = (reserved) => new Proxy(reserved, {
        apply: (target, self, args) => {
          const query = Reflect.apply(target, self, args);
          if (closeAtBuild && Array.isArray(args[0]) && args[0][0] === 'discard all') { closeAtBuild = false; transport.closeNow(); }
          return query;
        },
      });
      return new Proxy(pool, { get: (target, key) => (key === 'reserve' ? async () => watch(await target.reserve()) : Reflect.get(target, key)) });
    };
    const client = kernel('store', w, transport, 1, variant === 'handoff' ? proxied : postgres);
    const store = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async () => 'applied')] });
    const first = await held(store);
    if (ending === 'rollback') await store.transactions.commit(first.command, live()); // committed: the same command again is fenced
    const ctl = new AbortController();
    let abortedAt = 0;
    if (variant === 'before') transport.closeBehindAnswer(ending === 'commit' ? 'COMMIT' : 'ROLLBACK');
    else if (variant === 'during') transport.dropNextResetAnswer();
    else if (variant === 'handoff') closeAtBuild = true;
    else {
      transport.holdNextResetAnswer();
      void w.nextReset().then(() => sleep(150)).then(() => { abortedAt = Date.now(); ctl.abort(); });
    }
    const started = Date.now();
    const answer = outcomeOf(store.transactions.commit(first.command, variant === 'abort' ? ctl.signal : live()));
    const queued = held(createPostgresTransactionalStore({ client, mutators: [mutatorOf(async () => 'applied')] }));
    const settledAnswer = await answer;
    const answeredMs = Date.now() - (abortedAt === 0 ? started : abortedAt); // the whole call, or from the abort
    const t = Date.now();
    const next = await queued;
    const nextWithinDeadline = Date.now() - t < IDEMPOTENCY_DEADLINE_MS;
    await sleep(300); // a write scheduled on a dropped socket would have ended this process by now
    const owner = ownerSql();
    const [effects] = await owner`select
      (select count(*)::int from tmpos_internal.idempotency_record where scope = ${first.op.scope} and response is not null) as completed,
      (select count(*)::int from tmpos_internal.outbox_event where correlation_id = ${first.command.audit.correlationId}) as events`;
    const replay = await store.idempotency.acquire({ scope: first.op.scope, fingerprint: first.op.fingerprint, lease: randomBytes(32).toString('base64url'), leaseMs: 60_000, retentionMs: 600_000 }, live());
    steps.push({ ending, answer: settledAnswer, answeredWithinBound: answeredMs < 2_000, next: next.acquired, nextWithinDeadline,
      completed: effects.completed, events: effects.events, replay: replay.outcome, ...w.tally() });
    await client.end();
    await owner.end({ timeout: 1 });
    if (transport.close !== undefined) await transport.close();
  }
  report({ variant, steps });
}

/** A NOTICE through the runtime's options, and one through the driver's default handler as the control. */
async function notices() {
  const s = sockets();
  const runtime = rawPool(s);
  const driverDefault = postgres(targets.owner.dsn, {
    ...runtimeClientOptions(targets.owner.dsn), ssl: false, max: 1, idle_timeout: 0, connect_timeout: 1, ...targets.owner.options, socket: s.hook, onnotice: undefined,
  });
  await runtime`do $$ begin raise notice 'M6-NOTICE-CANARY-RUNTIME' using detail = 'M6-NOTICE-CANARY-DETAIL'; end $$`;
  await driverDefault`do $$ begin raise notice 'M6-NOTICE-CANARY-DEFAULT'; end $$`;
  report({ raised: 2 });
  await runtime.end({ timeout: 1 });
  await driverDefault.end({ timeout: 1 });
}

const [scenario, variant] = process.argv.slice(2);
const run = {
  'write-after-close': writeAfterClose,
  'poisoned-slot': poisonedSlot,
  gap: () => gap(variant),
  'queued-write': queuedWrite,
  'commit-lost': commitLost,
  pressure,
  shutdown,
  orphan,
  notices,
  reset: () => reset(variant),
}[scenario];
if (targets === null || run === undefined || (scenario === 'gap' && !['fin', 'reset', 'terminate', 'sync', 'handoff'].includes(variant))
  || (scenario === 'reset' && !['before', 'during', 'handoff', 'abort'].includes(variant))) {
  console.error('usage: M6_DEFECT_TARGETS=<json> pgDriverDefects.child.mjs <scenario> [variant]');
  process.exit(2);
}
await run();
process.exit(0);
