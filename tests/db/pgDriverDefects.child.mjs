// Phase 4.0 M6-PG-P5 — one scenario per process, for M6-PG-24..27 (docs/phase-4/08 DA-15, DA-17).
//
// The pinned driver's first defect ends the process that meets it, so each scenario runs here, in a child of the
// PostgreSQL suite, which reads its exit status, its one RESULT line and everything it printed. The targets come
// from the suite alone (M6_DEFECT_TARGETS: the disposable server's DSN and client options for its owner and for the
// store's non-owner probe). Every pool is built with the runtime's own client options — notice handler included —
// and a socket hook, so a scenario can cut the one connection it holds.
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
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

/** The sockets the driver opens through this hook — the target's own socket file or TCP port — so one can be cut. */
function sockets() {
  const opened = [];
  const hook = (o) => new Promise((resolve, reject) => {
    const s = o.path ? net.createConnection(o.path) : net.createConnection({ host: o.host[0], port: o.port[0] });
    s.once('connect', () => { opened.push(s); resolve(s); });
    s.once('error', reject);
  });
  return { hook, cut: () => opened[opened.length - 1].destroy() };
}

/** A pool of one connection for `who`, as the runtime builds one, connecting through `hook`. */
function pool(who, hook, extra = {}) {
  const t = targets[who];
  return postgres(t.dsn, { ...runtimeClientOptions(t.dsn), ssl: false, max: 1, idle_timeout: 0, connect_timeout: 1, ...t.options, socket: hook, ...extra });
}

const EVENTS = defineOutboxEvents(TEST_EVENTS);
const COMMANDS = defineCommands([TEST_CREATE], EVENTS);
const KEYRING = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
const mutatorOf = (apply) => Object.freeze({ kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', apply });

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
    seal: (envelope) => KEYRING.seal(envelope, op),
  });
  return { acquired: acquired.outcome, command: prepared.command };
}

/** Defect 1, raw: the body rethrows the loss, the driver answers it with a ROLLBACK to the closed socket. */
async function writeAfterClose() {
  const s = sockets();
  const sql = pool('owner', s.hook);
  sql.begin(async (tx) => { await tx`select pg_catalog.pg_sleep(2)`; }).catch(() => undefined);
  await sleep(150);
  s.cut();
  await sleep(2_000);
  report({ survived: true }); // reached only if the driver never wrote to the closed socket
  await sql.end({ timeout: 1 });
}

/** Defect 2, raw: a close in the same turn as a write it was handed; every later use of the slot, and the end. */
async function poisonedSlot() {
  const s = sockets();
  const sql = pool('owner', s.hook);
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

/** The store, contained: a connection lost under a command — mid-statement, or while its mutator waits. */
async function contained(kind) {
  const s = sockets();
  let sleepReturned = false; // stays false only if the statement itself was cut, not the transaction after it
  const apply = {
    'mid-statement': async (sql) => { setTimeout(s.cut, 150); await sql`select pg_catalog.pg_sleep(2)`; sleepReturned = true; return 'applied'; },
    'gap-statement': async (sql) => { await sql`select 1`; s.cut(); await sleep(200); await sql`select 2`; return 'applied'; },
    'gap-refusal': async (sql) => { await sql`select 1`; s.cut(); await sleep(200); throw new Error('refused after the gap'); },
    'gap-completion': async (sql) => { await sql`select 1`; s.cut(); await sleep(200); return 'applied'; },
  }[kind];
  const client = pool('store', s.hook);
  const store = createPostgresTransactionalStore({ client, mutators: [mutatorOf(apply)] });
  const { acquired, command } = await held(store);
  const answer = await store.transactions.commit(command, live());
  await sleep(1_000); // a write scheduled on the closed socket would have run — and ended this process — by now
  report({ kind, acquired, answer: answer.outcome, sleepReturned });
  await client.end({ timeout: 1 });
}

/** The supervised client over a slot poisoned as in poisonedSlot: the call that meets it, the next call, the end. */
async function supervised() {
  const s = sockets();
  let raw = null;
  let pools = 0;
  const client = createSupervisedPgClient(() => {
    pools++;
    raw = pool('store', s.hook);
    return raw;
  });
  const store = createPostgresTransactionalStore({ client, mutators: [mutatorOf(async () => 'applied')] });
  const first = await held(store);
  const poisoned = raw;
  await new Promise((resolve) => setImmediate(() => { s.cut(); settled(poisoned`select 1`).then(resolve); }));
  let t = Date.now();
  const lost = await held(store);
  const lostMs = Date.now() - t;
  t = Date.now();
  const next = await held(store);
  const nextMs = Date.now() - t;
  t = Date.now();
  await client.end();
  report({ first: first.acquired, lost: lost.acquired, lostMs, next: next.acquired, nextMs, deadlineMs: IDEMPOTENCY_DEADLINE_MS, pools, endMs: Date.now() - t });
}

/** A NOTICE through the runtime's options, and one through the driver's default handler as the control. */
async function notices() {
  const s = sockets();
  const runtime = pool('owner', s.hook);
  const driverDefault = pool('owner', s.hook, { onnotice: undefined });
  await runtime`do $$ begin raise notice 'M6-NOTICE-CANARY-RUNTIME' using detail = 'M6-NOTICE-CANARY-DETAIL'; end $$`;
  await driverDefault`do $$ begin raise notice 'M6-NOTICE-CANARY-DEFAULT'; end $$`;
  report({ raised: 2 });
  await runtime.end({ timeout: 1 });
  await driverDefault.end({ timeout: 1 });
}

const run = {
  'write-after-close': writeAfterClose,
  'poisoned-slot': poisonedSlot,
  'mid-statement': () => contained('mid-statement'),
  'gap-statement': () => contained('gap-statement'),
  'gap-refusal': () => contained('gap-refusal'),
  'gap-completion': () => contained('gap-completion'),
  supervised,
  notices,
}[process.argv[2]];
if (targets === null || run === undefined) {
  console.error('usage: M6_DEFECT_TARGETS=<json> pgDriverDefects.child.mjs <scenario>');
  process.exit(2);
}
await run();
process.exit(0);
