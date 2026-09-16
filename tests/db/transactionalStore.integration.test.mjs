// Phase 4.0 M6-PG-P4 — the PostgreSQL transactional store against a REAL disposable PostgreSQL.
//
// Everything here runs against a throwaway `tmpos_s1b_*` database: locally a cluster the S1b harness
// creates on a task-owned Unix socket, in CI the workflow's disposable loopback service
// (TM_POS_TEST_DATABASE_URL). No managed provider, persistent database or ambient application DSN is ever
// consulted: the trusted executor's guard refuses anything that is not a disposable local target, and it
// runs before any statement.
//
// WHAT IT PROVES. Migration 006 applies through the trusted engine on top of 001-005, refuses a rollback
// that would destroy work, reverses cleanly and re-applies; its constraints refuse malformed, oversized and
// contradictory values; and the adapter (server/persistence/postgresTransactionalStore.ts) passes the three
// UNCHANGED conformance suites — idempotency, command transaction, outbox delivery — over TWO independent
// instances, each on its own connection pool, as a non-owner LOGIN holding exactly tmpos_app and
// tmpos_audit_writer. Then the cases the suites cannot reach: the real clock after a lock wait, a lost COMMIT
// acknowledgement, aborts, lock and statement timeouts, injected SQLSTATEs, a connection cut mid-transaction,
// an unexpected null, claim order and the batch limit, and that nothing the driver says leaves the adapter.
//
// TEST MACHINERY — all of it in the disposable database or this process, none in a migration or the adapter:
//   * m6_proof.item: the synthetic business aggregate the two conformance commands mutate, through mutators
//     defined in this file;
//   * a FROZEN store clock: tmpos_internal.m6_store_clock() is replaced, in this database only, by one that reads
//     m6_proof.clock, so the suites' exact millisecond boundaries hold. The migration's own definition is
//     restored (from pg_get_functiondef) for the real-time cases and at the end. The stamps — audit_event
//     and outbox_event occurred_at — are the transaction start, now(), which no replacement touches, so an
//     advance of up to one second also waits that long in real time;
//   * fault triggers (m6_proof.inject) that raise a chosen SQLSTATE or sleep in the named part's own
//     statement, armed once through per-part sequences. A sequence is not transactional, so its value is also
//     the witness that the parts before a failure really ran before the rollback;
//   * a byte relay on a task-owned socket between the store's clients and the server: it makes the store
//     unreachable the way a stopping server does (no new connection; the server ends every store session),
//     severs a dedicated client's connection without a word, and can discard the server's answer to one COMMIT.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
} from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import {
  COMMAND_AUDIT_EVALUATED_BY,
  createPostgresTransactionalStore,
} from '../../server/persistence/postgresTransactionalStore.ts';
import { RETIRED_POOL_GRACE_S } from '../../server/persistence/supervisedPgClient.ts';
import { TEST_IDEMPOTENCY_KEY, assertIdempotencyStoreContract } from '../../server/runtime/idempotencyStore.testkit.ts';
import {
  TEST_CREATE,
  TEST_EVENTS,
  TEST_RENAME,
  assertCommandTransactionContract,
  assertOutboxDeliveryContract,
} from '../../server/runtime/transactionalOutbox.testkit.ts';
import { MAX_SEALED_LENGTH, createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';
import { defineCommands, prepareCommand } from '../../server/runtime/commandTransaction.ts';
import {
  MAX_CLAIM_BATCH, MAX_EVENTS_PER_COMMAND, OUTBOX_DELIVERY_POLICY, createOutboxDelivery, defineOutboxEvents, deliverOutboxBatch, retryDelayMs,
} from '../../server/runtime/outbox.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MIG_DIR = join(REPO, 'server', 'platform-identity', 'migrations');
const MIG_REL = 'server/platform-identity/migrations';
const UP_006 = readFileSync(join(MIG_DIR, '006_m6_transactional_store.up.sql'), 'utf8');
const DOWN_006 = readFileSync(join(MIG_DIR, '006_m6_transactional_store.down.sql'), 'utf8');

const LOCK_KEY = 720100306;
const MIGRATOR = { purpose: 'migration', migratorRef: 'm6-migrator', runtimeRef: 'm6-runtime' };
const NOW = () => new Date().toISOString();

/** The ephemeral non-owner LOGIN every store instance connects as: tmpos_app + tmpos_audit_writer, nothing else. */
const STORE_PROBE = 'tmpos_m6_store_probe';

/** The G-DBROLE owner step migration 005 verifies. Idempotent: in CI this database is shared with S2 and S3. */
const OWNER_DB_ACL_PREP = `do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
  execute format('revoke create on database %I from public', current_database());
end
$$;`;

const ACQUIRED = { outcome: 'acquired', reclaimed: false };
const RECLAIMED = { outcome: 'acquired', reclaimed: true };
const IN_PROGRESS = { outcome: 'in_progress' };
const COMMITTED = { outcome: 'committed' };
const CONFLICT = { outcome: 'conflict' };
const LEASE_LOST = { outcome: 'lease_lost' };
const UNAVAILABLE = { outcome: 'unavailable' };
const CLAIM_LOST = { outcome: 'claim_lost' };
const EMPTY = { outcome: 'claimed', events: [] };
const OUTCOME_UNKNOWN = 'transactional_store_outcome_unknown';

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const ambientTestDsn = process.env.TM_POS_TEST_DATABASE_URL;
let cluster = null;
let TARGET_DSN = null;
let CLIENT_OPTS = {};

if (typeof ambientTestDsn === 'string' && ambientTestDsn.trim() !== '') {
  TARGET_DSN = ambientTestDsn.trim();
  // A socket-form target (no hostname) names its directory (and role) as parameters, which every client strips from
  // the URL: carry them as options, so no client falls back to PGHOST, PGUSER or localhost instead of the validated
  // target. With a hostname, the hostname is what was validated, so a host parameter is never used.
  const target = new URL(TARGET_DSN);
  const socketDir = target.hostname === '' ? target.searchParams.get('host') : null;
  if (socketDir !== null) {
    CLIENT_OPTS = { host: socketDir, ...(target.searchParams.get('user') !== null ? { user: target.searchParams.get('user') } : {}) };
  }
} else if (localPostgresAvailable()) {
  cluster = startDisposablePostgres();
  TARGET_DSN = cluster.dsn;
  CLIENT_OPTS = cluster.clientOptions;
} else {
  throw new Error(
    'M6-PG INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

// VALIDATE BEFORE TOUCHING ANYTHING: the setup below issues cluster-wide DDL (CREATE ROLE).
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** `host`/`user` travel in client options, never the URL; a named role REPLACES the userinfo. */
function driverDsn(raw, user) {
  const u = new URL(raw);
  u.searchParams.delete('host');
  u.searchParams.delete('user');
  if (user !== undefined) {
    u.username = encodeURIComponent(user);
    u.password = '';
  }
  return u.toString();
}

/** The OWNER: fixtures, fault arming and out-of-band observation — never a privilege claim. */
const observer = postgres(driverDsn(TARGET_DSN), { max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS });
/** A second owner connection that holds row locks while a store call waits on them. */
const lockHolder = postgres(driverDsn(TARGET_DSN), { max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS });

// ---------------------------------------------------------------------------
// the relay: the store's only way to the server
// ---------------------------------------------------------------------------

/** The unnamed-statement Parse of COMMIT, as postgres.js sends it. */
const COMMIT_PARSE = Buffer.from('\0commit\0');

function startRelay() {
  const u = new URL(TARGET_DSN);
  const upstream = CLIENT_OPTS.host
    ? { path: join(CLIENT_OPTS.host, `.s.PGSQL.${u.port || 5432}`) }
    : { host: u.hostname, port: Number(u.port || 5432) };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m6-relay-'));
  const pairs = new Set();
  // closes: the connections through this relay that the driver has finished closing, as storeClient counts them.
  const state = { dropCommit: false, chunks: 0, closes: 0, pairs };
  const server = createServer((client) => {
    client.on('error', () => {});
    const db = connect(upstream);
    let swallow = false;
    const pair = {
      cut: () => {
        pairs.delete(pair);
        client.destroy();
        db.destroy();
      },
    };
    pairs.add(pair);
    client.on('data', (chunk) => {
      state.chunks += 1;
      if (state.dropCommit && chunk.includes(COMMIT_PARSE)) {
        state.dropCommit = false;
        swallow = true;
      }
      db.write(chunk);
    });
    // Once a COMMIT went through on a dropping connection, the server's answer to it is discarded and the
    // connection cut: the transaction committed, and the client never learns it.
    db.on('data', (chunk) => (swallow ? pair.cut() : client.write(chunk)));
    for (const socket of [client, db]) {
      socket.on('error', pair.cut);
      socket.on('close', pair.cut);
    }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listen = () => new Promise((done) => server.listen(path, done));
  // No listener, so every new connection is refused; settles once every open pair has closed. (A FATAL answer
  // to each new connection is NOT used: the driver retries those without end.)
  const refuse = () => (server.listening ? new Promise((done) => server.close(done)) : Promise.resolve());
  // Severed: refused, and every open connection cut without a word from the server — a network cut.
  const sever = async () => {
    const drained = refuse();
    for (const pair of [...pairs]) pair.cut();
    await drained;
  };
  return {
    dir,
    listening: listen(),
    state,
    refuse,
    restore: async () => {
      if (!server.listening) await listen();
    },
    dropNextCommitAnswer() {
      state.dropCommit = true;
    },
    async close() {
      await sever();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const relay = startRelay();
await relay.listening;

/**
 * A store client: the runtime principal's own options, through a relay (the shared one unless named), as the
 * non-owner probe, each close the driver finishes counted on that relay. Six connections, not the runtime's ten:
 * the local disposable cluster allows twenty in all, and two instances plus the owner's connections must fit — so
 * concurrent callers also queue in the client, as they would in production.
 */
function storeClient(max = 6, via = relay) {
  return postgres(driverDsn(TARGET_DSN, STORE_PROBE), {
    ...runtimeClientOptions(TARGET_DSN),
    // EXPLICIT TLS opt-out at the call site: the disposable target is a task-owned socket or loopback.
    ssl: false,
    max,
    idle_timeout: 0,
    onclose: () => {
      via.state.closes += 1;
    },
    host: via.dir,
    port: 5432,
    user: STORE_PROBE,
  });
}

/**
 * The store goes down the way a server does: the relay refuses new connections and the server itself ends every
 * store session — its FATAL, then the close — while no statement of the shared instances is in flight. It returns
 * only once the driver has closed every connection it held through the relay: a call the pinned driver is handed
 * on a connection whose session has ended, before it has seen the close, is written to it, and the close then
 * leaves that slot unable to reconnect (doc 08, DA-15). So no call meets one, and no pooled connection is severed
 * without a word either; the losses under an open transaction are proved on clients and relays of their own
 * (M6-PG-12).
 */
async function storeDown() {
  const open = relay.state.pairs.size;
  const closedBefore = relay.state.closes;
  const drained = relay.refuse();
  await observer`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = ${STORE_PROBE}`;
  const bound = new AbortController();
  const closed = (async () => {
    while (!bound.signal.aborted && relay.state.closes - closedBefore < open) await sleep(5);
  })();
  const late = sleep(5_000, undefined, { signal: bound.signal }).then(() => {
    throw new Error('the store sessions did not end within 5 s');
  }, () => {});
  try {
    await Promise.race([Promise.all([drained, closed]), late]);
  } finally {
    bound.abort();
  }
}

// ---------------------------------------------------------------------------
// setup: real migrations, a real non-owner principal
// ---------------------------------------------------------------------------

await observer.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await observer.unsafe(OWNER_DB_ACL_PREP);

// Locally this suite owns a fresh cluster and applies 001-006 itself; in CI S2 applied 001-005 and S3 applied
// 006 to the shared service database, and the ledger makes this a no-op. The ledger is asserted in M6-PG-01.
let applyReport;
{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    applyReport = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL),
      adapter: handle.adapter,
      ledger: handle.ledger,
      connectionMode: 'session',
      credential: MIGRATOR,
      lockKey: LOCK_KEY,
      now: NOW,
      deadlineMs: 60_000,
    });
  } finally {
    await handle.dispose();
  }
}

// No password: the disposable cluster authenticates locally by trust.
await observer.unsafe(`drop role if exists ${STORE_PROBE}`);
await observer.unsafe(`create role ${STORE_PROBE} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await observer.unsafe(`grant tmpos_app to ${STORE_PROBE}`);
await observer.unsafe(`grant tmpos_audit_writer to ${STORE_PROBE}`);

const FIXTURE_SQL = `
create schema m6_proof;
create table m6_proof.item (
  aggregate_id uuid primary key,
  version bigint not null check (version >= 1),
  name text not null,
  quantity integer not null
);
create table m6_proof.clock (singleton boolean primary key default true check (singleton), at timestamptz not null);
insert into m6_proof.clock (at) values (pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()));
create table m6_proof.fault (
  component text primary key, fire_at bigint not null, mode text not null, sqlstate text not null, seconds double precision not null
);
create sequence m6_proof.fault_mutation;
create sequence m6_proof.fault_audit;
create sequence m6_proof.fault_outbox;
create sequence m6_proof.fault_completion;
create function m6_proof.inject() returns trigger language plpgsql as $$
declare
  n bigint;
  f record;
begin
  n := case tg_argv[0]
    when 'mutation' then pg_catalog.nextval('m6_proof.fault_mutation')
    when 'audit' then pg_catalog.nextval('m6_proof.fault_audit')
    when 'outbox' then pg_catalog.nextval('m6_proof.fault_outbox')
    when 'completion' then pg_catalog.nextval('m6_proof.fault_completion')
  end;
  select * into f from m6_proof.fault where component = tg_argv[0] and fire_at = n;
  if found then
    if f.mode = 'sleep' then
      perform pg_catalog.pg_sleep(f.seconds);
    else
      raise exception 'injected % fault M6-DRIVER-CANARY', tg_argv[0] using errcode = f.sqlstate;
    end if;
  end if;
  return new;
end
$$;
create trigger m6_proof_inject before insert or update on m6_proof.item
  for each row execute function m6_proof.inject('mutation');
create trigger m6_proof_inject before insert on public.audit_event
  for each row execute function m6_proof.inject('audit');
create trigger m6_proof_inject before insert on tmpos_internal.outbox_event
  for each row execute function m6_proof.inject('outbox');
create trigger m6_proof_inject before update on tmpos_internal.idempotency_record
  for each row when (old.response is null and new.response is not null) execute function m6_proof.inject('completion');
grant usage on schema m6_proof to ${STORE_PROBE};
grant select, insert, update on m6_proof.item to ${STORE_PROBE};
grant select on m6_proof.clock, m6_proof.fault to ${STORE_PROBE};
grant usage on sequence m6_proof.fault_mutation, m6_proof.fault_audit, m6_proof.fault_outbox, m6_proof.fault_completion to ${STORE_PROBE};
`;

const FROZEN_CLOCK = `create or replace function tmpos_internal.m6_store_clock() returns timestamptz language sql volatile
  set search_path = pg_catalog, pg_temp as $$ select at from m6_proof.clock $$`;
let productionClock = null;

/** The fixture, installed once — after M6-PG-01 has reversed and re-applied migration 006. */
let fixture = null;
const ready = () => (fixture ??= (async () => {
  await observer.unsafe(FIXTURE_SQL).simple();
  productionClock = (await observer`select pg_catalog.pg_get_functiondef('tmpos_internal.m6_store_clock()'::regprocedure) as def`)[0].def;
  await observer.unsafe(FROZEN_CLOCK);
})());

/** Move the frozen store clock forward by exactly `ms`; up to a second also waits, for the real now() stamps. */
async function advance(ms) {
  await observer`update m6_proof.clock set at = at + (${String(ms)}::bigint * interval '1 millisecond')`;
  if (ms <= 1_000) await sleep(ms + 2);
}
const frozenNowMs = async () => Number((await observer`select (extract(epoch from at) * 1000)::bigint::text as t from m6_proof.clock`)[0].t);

/** Arm the next statement of `component` to raise `sqlstate`, or to sleep `seconds`, once. */
async function arm(component, mode = 'raise', sqlstate = 'P0001', seconds = 0) {
  await observer`insert into m6_proof.fault (component, fire_at, mode, sqlstate, seconds)
    values (${component}, coalesce(pg_catalog.pg_sequence_last_value(${`m6_proof.fault_${component}`}::regclass), 0) + 1, ${mode}, ${sqlstate}, ${seconds})
    on conflict (component) do update set fire_at = excluded.fire_at, mode = excluded.mode, sqlstate = excluded.sqlstate, seconds = excluded.seconds`;
}
/** How many statements each part has run, ever: sequences survive every rollback. */
async function witness() {
  const [w] = await observer`select
    coalesce(pg_catalog.pg_sequence_last_value('m6_proof.fault_mutation'::regclass), 0)::int as mutation,
    coalesce(pg_catalog.pg_sequence_last_value('m6_proof.fault_audit'::regclass), 0)::int as audit,
    coalesce(pg_catalog.pg_sequence_last_value('m6_proof.fault_outbox'::regclass), 0)::int as outbox,
    coalesce(pg_catalog.pg_sequence_last_value('m6_proof.fault_completion'::regclass), 0)::int as completion`;
  return { mutation: w.mutation, audit: w.audit, outbox: w.outbox, completion: w.completion };
}
const ranSince = (before, after) => Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]));

/** The synthetic aggregate's two commands, as trusted source defines a kind's mutator: fixed, parameterized SQL. */
const MUTATORS = Object.freeze([
  Object.freeze({
    kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item',
    apply: async (sql, m) => ((await sql`insert into m6_proof.item (aggregate_id, version, name, quantity)
      values (${m.aggregateId}, 1, ${m.changes.name}, ${m.changes.quantity}) on conflict (aggregate_id) do nothing`).count === 1 ? 'applied' : 'conflict'),
  }),
  Object.freeze({
    kind: TEST_RENAME.kind, mode: 'update', aggregateType: 'item',
    apply: async (sql, m) => ((await sql`update m6_proof.item set name = ${m.changes.name}, version = version + 1
      where aggregate_id = ${m.aggregateId} and version = ${m.expectedVersion}`).count === 1 ? 'applied' : 'conflict'),
  }),
]);

const clientA = storeClient();
const clientB = storeClient();
const A = createPostgresTransactionalStore({ client: clientA, mutators: MUTATORS });
const B = createPostgresTransactionalStore({ client: clientB, mutators: MUTATORS });
const extraClients = [];

/** What the store committed, read by the owner outside every port transaction. */
async function inspect() {
  const items = await observer`select aggregate_id::text as id, version::text as version, name, quantity from m6_proof.item`;
  const audit = await observer`select action_id, required_permission, scope_type, tenant_id, store_id, actor_internal_user_id, request_id,
      floor(extract(epoch from occurred_at) * 1000)::bigint::text as at
    from public.audit_event where evaluated_by = ${COMMAND_AUDIT_EVALUATED_BY}`;
  const events = await observer`select event_id::text as event_id, event_type, event_version, aggregate_type, aggregate_id::text as aggregate_id,
      aggregate_version::text as aggregate_version, tenant_digest, store_digest, actor_digest, correlation_id::text as correlation_id, payload,
      floor(extract(epoch from occurred_at) * 1000)::bigint::text as occurred_at, status, attempt
    from tmpos_internal.outbox_event`;
  return {
    aggregates: items.map((r) => ({ type: 'item', id: r.id, version: Number(r.version), state: { name: r.name, quantity: r.quantity } })),
    audit: audit.map((r) => ({
      action: r.action_id, permission: r.required_permission, scope: r.scope_type, tenant: r.tenant_id, store: r.store_id,
      actor: r.actor_internal_user_id, correlationId: r.request_id, at: Number(r.at),
    })),
    events: events.map((r) => ({
      envelope: {
        eventId: r.event_id, type: r.event_type, version: r.event_version, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
        aggregateVersion: Number(r.aggregate_version), tenant: r.tenant_digest, store: r.store_digest, actor: r.actor_digest,
        correlationId: r.correlation_id, payload: r.payload, occurredAt: Number(r.occurred_at),
      },
      status: r.status,
      attempt: r.attempt,
    })),
  };
}

const harness = () => ({
  idempotency: A.idempotency,
  transaction: A.transactions,
  transactionPeer: B.transactions,
  delivery: A.delivery,
  deliveryPeer: B.delivery,
  advance,
  breakStore: storeDown,
  restoreStore: () => relay.restore(),
  failNextCommit: (component) => arm(component),
  inspect,
});

// ---------------------------------------------------------------------------
// the runtime's own validation and sealing, for the targeted cases
// ---------------------------------------------------------------------------

const EVENTS = defineOutboxEvents(TEST_EVENTS);
const COMMANDS = defineCommands([TEST_CREATE, TEST_RENAME], EVENTS);
const KEYRING = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
const live = () => new AbortController().signal;
const lease = () => randomBytes(32).toString('base64url');
const token = () => randomBytes(32).toString('base64url');
const operation = () => KEYRING.operationOf(randomUUID(), Object.freeze({ authProvider: 'm6-proof', authProviderUid: 'actor' }), {
  method: 'POST', path: '/v1/m6-proof', audience: null, tenant: null, store: null, body: Buffer.from(randomUUID()),
});
const acquireRequest = (op, held, leaseMs = 60_000, retentionMs = 600_000) =>
  Object.freeze({ scope: op.scope, fingerprint: op.fingerprint, lease: held, leaseMs, retentionMs });

async function begin(store = A, terms = {}) {
  const op = operation();
  const held = lease();
  assert.deepEqual(await store.idempotency.acquire(acquireRequest(op, held, terms.leaseMs, terms.retentionMs), live()), ACQUIRED);
  return { op, lease: held };
}

function prepared(kind, attempt, plan, newAggregateId) {
  const result = prepareCommand(COMMANDS.contract(kind), EVENTS, plan, {
    scope: attempt.op.scope, lease: attempt.lease, newAggregateId,
    authorization: Object.freeze({ scope: 'platform', permission: 'conformance.write' }),
    seal: (envelope) => KEYRING.seal(envelope, attempt.op),
  });
  assert.ok(result !== null, 'the proof plans are in contract');
  return result.command;
}
function creating(attempt, name = `item-${randomUUID().slice(0, 8)}`, aggregateId = randomUUID()) {
  return prepared(TEST_CREATE.kind, attempt, {
    aggregateId, expectedVersion: null, changes: { name, quantity: 1 },
    events: [{ type: 'conformance.item.created', payload: { name, quantity: 1 } }], response: { status: 201, body: { id: aggregateId } },
  }, aggregateId);
}
function renaming(attempt, aggregateId, version, name = `renamed-${randomUUID().slice(0, 8)}`) {
  return prepared(TEST_RENAME.kind, attempt, {
    aggregateId, expectedVersion: version, changes: { name },
    events: [{ type: 'conformance.item.renamed', payload: { name } }], response: { status: 200, body: { id: aggregateId, name } },
  }, randomUUID());
}

/** What the store holds of one command: its aggregate's version, its audit rows, its events, and its completion. */
async function footprint(command) {
  const [item] = await observer`select version::text as version, name from m6_proof.item where aggregate_id = ${command.mutation.aggregateId}`;
  const [{ audit }] = await observer`select count(*)::int as audit from public.audit_event
    where request_id = ${command.audit.correlationId} and evaluated_by = ${COMMAND_AUDIT_EVALUATED_BY}`;
  const [{ events }] = await observer`select count(*)::int as events from tmpos_internal.outbox_event where correlation_id = ${command.audit.correlationId}`;
  const [{ completed }] = await observer`select count(*)::int as completed from tmpos_internal.idempotency_record where scope = ${command.scope} and response is not null`;
  return { version: item === undefined ? null : Number(item.version), audit, events, completed };
}
const NOTHING = { version: null, audit: 0, events: 0, completed: 0 };

/** How a statement was refused: its SQLSTATE and constraint, or nulls when it was not. */
async function refusal(fn) {
  try {
    await fn();
    return { code: null, constraint: null };
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    return { code: e?.code ?? null, constraint: e?.constraint_name ?? null };
  }
}

/** Hold the row lock `lockSql` takes for `holdMs`, on the owner's second connection, while `during` runs. */
async function whileLocked(lockSql, holdMs, during) {
  let released = false;
  let result;
  await lockHolder.begin(async (tx) => {
    await lockSql(tx);
    const running = during().then((value) => ({ value, released }));
    await Promise.race([running, sleep(holdMs)]);
    released = true;
    result = running;
  });
  return result;
}

/** The store session asleep in an armed fault, once it is there: its statement is in flight, before COMMIT. */
async function sleepingStoreSession() {
  for (let tries = 0; tries < 1_000; tries++) {
    const [session] = await observer`select pid from pg_catalog.pg_stat_activity where usename = ${STORE_PROBE} and wait_event = 'PgSleep'`;
    if (session !== undefined) return session.pid;
    await sleep(5);
  }
  throw new Error('no store session reached the armed sleep');
}

test.after(async () => {
  await relay.close().catch(() => {});
  for (const c of [clientA, clientB, ...extraClients]) await c.end({ timeout: 0 }).catch(() => {});
  if (productionClock !== null) await observer.unsafe(productionClock).catch(() => {});
  await observer.unsafe('drop schema if exists m6_proof cascade').catch(() => {});
  await observer.unsafe(`drop role if exists ${STORE_PROBE}`).catch(() => {});
  await lockHolder.end({ timeout: 5 }).catch(() => {});
  await observer.end({ timeout: 5 }).catch(() => {});
  if (cluster !== null) {
    const life = cluster.stop();
    assert.equal(life.stopped, true, 'the task-created PostgreSQL process must be stopped');
    assert.equal(life.removed, true, 'the task-created temporary directory must be removed');
  }
});

// ---------------------------------------------------------------------------
// the schema
// ---------------------------------------------------------------------------

/** The nine lifecycle routines migration 006 grants to the runtime role, by signature. */
const ROUTINES = [
  'm6_command_enqueue(text,text,uuid,text,integer,text,uuid,bigint,text,text,text,uuid,jsonb)', 'm6_command_fence(text,text)',
  'm6_idempotency_acquire(text,text,text,bigint,bigint)', 'm6_idempotency_complete(text,text,text)', 'm6_outbox_acknowledge(uuid,text)',
  'm6_outbox_claim(text,integer,bigint)', 'm6_outbox_dead_letter(uuid,text,text)', 'm6_outbox_retry(uuid,text,bigint)', 'm6_store_probe()',
];
const ROUTINE_NAMES = ROUTINES.map((r) => r.slice(0, r.indexOf('(')));
const STORE_FUNCTIONS = [...ROUTINE_NAMES, 'm6_store_clock', 'outbox_event_transition_guard'].sort();

async function assertStorePosture(label) {
  // Where it lives: the internal schema holds both tables and every function, all owned by the principal that applied
  // 006 — never the runtime login — and public holds none of them.
  const [{ me }] = await observer`select current_user::text as me`;
  const objects = await observer`select 'schema' as kind, n.nspname::text as name, n.nspowner::regrole::text as owner
      from pg_catalog.pg_namespace n where n.nspname = 'tmpos_internal'
    union all select 'table', c.relname::text, c.relowner::regrole::text from pg_catalog.pg_class c
      where c.relnamespace = 'tmpos_internal'::regnamespace and c.relkind = 'r'
    union all select 'function', p.proname::text, p.proowner::regrole::text from pg_catalog.pg_proc p
      where p.pronamespace = 'tmpos_internal'::regnamespace
    order by 1, 2`;
  assert.deepEqual(objects.map((o) => [o.kind, o.name, o.owner]), [
    ...STORE_FUNCTIONS.map((name) => ['function', name, me]),
    ['schema', 'tmpos_internal', me], ['table', 'idempotency_record', me], ['table', 'outbox_event', me],
  ], `${label}: the schema, both tables and all eleven functions, owned by the applying principal`);
  const [{ owned }] = await observer`select
      (select count(*)::int from pg_catalog.pg_class c where c.relowner = ${STORE_PROBE}::regrole)
    + (select count(*)::int from pg_catalog.pg_proc p where p.proowner = ${STORE_PROBE}::regrole)
    + (select count(*)::int from pg_catalog.pg_namespace n where n.nspowner = ${STORE_PROBE}::regrole) as owned`;
  assert.equal(owned, 0, `${label}: the runtime login owns no object`);
  const [{ none }] = await observer`select to_regclass('public.idempotency_record') is null and to_regclass('public.outbox_event') is null
    and to_regprocedure('public.m6_store_clock()') is null and to_regprocedure('public.m6_store_probe()') is null as none`;
  assert.equal(none, true, `${label}: public holds none of them`);
  // The routines: SECURITY DEFINER, pinned; the clock and the guard: neither definer nor granted.
  const attributes = await observer`select p.proname::text as name, p.prosecdef as definer, p.proconfig::text as config
    from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_internal'::regnamespace order by 1`;
  assert.deepEqual(attributes.map((a) => [a.name, a.definer, a.config]),
    STORE_FUNCTIONS.map((name) => [name, ROUTINE_NAMES.includes(name), '{"search_path=pg_catalog, pg_temp"}']),
    `${label}: every routine SECURITY DEFINER, the clock and the guard not, every one pinned to pg_catalog, pg_temp`);
  const schemaGrants = await observer`select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type as p,
      a.is_grantable as g
    from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a where n.nspname = 'tmpos_internal' and a.grantee <> n.nspowner order by 1, 2`;
  assert.deepEqual(schemaGrants.map((g) => [g.grantee, g.p, g.g]), [['tmpos_app', 'USAGE', false]], `${label}: USAGE on the schema, to tmpos_app alone`);
  const guards = await observer`select t.tgname::text as name, t.tgenabled::text as enabled, p.proname::text as fn
    from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'tmpos_internal.outbox_event'::regclass and t.tgname = 'outbox_event_transition_guard'`;
  assert.deepEqual(guards.map((t) => [t.name, t.enabled, t.fn]), [['outbox_event_transition_guard', 'A', 'outbox_event_transition_guard']],
    `${label}: the delivery state machine guards every insert and update, in replica sessions too (ENABLE ALWAYS)`);
  const tables = await observer`select c.relname::text as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_catalog.pg_class c where c.relnamespace = 'tmpos_internal'::regnamespace and c.relkind = 'r' order by 1`;
  assert.deepEqual(tables.map((t) => [t.name, t.rls, t.forced]), [['idempotency_record', true, false], ['outbox_event', true, false]],
    `${label}: both tables exist with RLS enabled`);
  const policies = await observer`select count(*)::int as n from pg_catalog.pg_policies where schemaname = 'tmpos_internal'`;
  assert.equal(policies[0].n, 0, `${label}: and no policy, so a stray grant reaches no row`);
  // Every direct grant in the schema beyond the owner's: the schema's USAGE and the nine routines' EXECUTE, to tmpos_app.
  const grants = await observer`select o.kind, o.name, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
      a.privilege_type as p, a.is_grantable as g
    from (select 'relation' as kind, c.relname::text as name, c.relowner as owner, c.relacl as acl from pg_catalog.pg_class c
            where c.relnamespace = 'tmpos_internal'::regnamespace
          union all select 'column', c.relname::text || '.' || a.attname::text, c.relowner, a.attacl from pg_catalog.pg_attribute a
            join pg_catalog.pg_class c on c.oid = a.attrelid where c.relnamespace = 'tmpos_internal'::regnamespace and a.attnum > 0
          union all select 'function', pg_catalog.substring(p.oid::regprocedure::text, '[^.]*$'), p.proowner,
            coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner)) from pg_catalog.pg_proc p
            where p.pronamespace = 'tmpos_internal'::regnamespace) o,
      pg_catalog.aclexplode(o.acl) a
    where a.grantee <> o.owner order by 1, 2, 3, 4`;
  assert.deepEqual(grants.map((g) => [g.kind, g.name, g.grantee, g.p, g.g]), ROUTINES.map((r) => ['function', r, 'tmpos_app', 'EXECUTE', false]),
    `${label}: no table, column, clock or guard grant to anyone, and no routine to PUBLIC, anon, authenticated or the audit writer`);
  const [p] = await observer`select
      has_table_privilege('tmpos_app', 'tmpos_internal.idempotency_record', 'SELECT') as record_select,
      has_table_privilege('tmpos_app', 'tmpos_internal.idempotency_record', 'INSERT') as record_insert,
      has_column_privilege('tmpos_app', 'tmpos_internal.idempotency_record', 'response', 'UPDATE') as response_update,
      has_column_privilege('tmpos_app', 'tmpos_internal.idempotency_record', 'expires_at', 'UPDATE') as expires_update,
      has_table_privilege('tmpos_app', 'tmpos_internal.outbox_event', 'SELECT') as outbox_select,
      has_table_privilege('tmpos_app', 'tmpos_internal.outbox_event', 'INSERT') as outbox_insert,
      has_column_privilege('tmpos_app', 'tmpos_internal.outbox_event', 'status', 'UPDATE') as status_update,
      has_column_privilege('tmpos_app', 'tmpos_internal.outbox_event', 'claim_token', 'SELECT') as token_select,
      has_table_privilege('tmpos_app', 'tmpos_internal.outbox_event', 'DELETE') as outbox_delete,
      has_table_privilege('tmpos_app', 'tmpos_internal.idempotency_record', 'TRUNCATE') as record_truncate,
      has_function_privilege('tmpos_app', 'tmpos_internal.m6_store_clock()', 'EXECUTE') as clock,
      has_function_privilege('tmpos_app', 'tmpos_internal.outbox_event_transition_guard()', 'EXECUTE') as guard,
      has_function_privilege('tmpos_app', 'tmpos_internal.m6_outbox_claim(text, integer, bigint)', 'EXECUTE') as claim,
      has_function_privilege('anon', 'tmpos_internal.m6_outbox_claim(text, integer, bigint)', 'EXECUTE') as claim_anon,
      has_function_privilege('authenticated', 'tmpos_internal.m6_idempotency_acquire(text, text, text, bigint, bigint)', 'EXECUTE') as acquire_authenticated,
      has_function_privilege('tmpos_audit_writer', 'tmpos_internal.m6_idempotency_complete(text, text, text)', 'EXECUTE') as complete_audit_writer,
      has_schema_privilege('tmpos_app', 'tmpos_internal', 'USAGE') as schema_app,
      has_schema_privilege('tmpos_app', 'tmpos_internal', 'CREATE') as schema_create_app,
      has_schema_privilege('anon', 'tmpos_internal', 'USAGE') as schema_anon,
      has_schema_privilege('authenticated', 'tmpos_internal', 'USAGE') as schema_authenticated`;
  assert.deepEqual(p, {
    record_select: false, record_insert: false, response_update: false, expires_update: false, outbox_select: false, outbox_insert: false,
    status_update: false, token_select: false, outbox_delete: false, record_truncate: false, clock: false, guard: false, claim: true,
    claim_anon: false, acquire_authenticated: false, complete_audit_writer: false,
    schema_app: true, schema_create_app: false, schema_anon: false, schema_authenticated: false,
  }, `${label}: the runtime role holds the schema and the routines — no table, column, clock or guard privilege, no CREATE`);
}

/** A valid outbox row, as the owner may insert one directly — for the constraint and rollback-guard cases. */
const baseEvent = () => ({
  event_id: randomUUID(), event_type: 'conformance.item.created', event_version: 1, aggregate_type: 'item', aggregate_id: randomUUID(),
  aggregate_version: '1', tenant: null, store: null, actor: null, correlation_id: randomUUID(), payload: { name: 'n', quantity: 1 },
  status: 'pending', attempt: 0, due_at: '2030-01-01T00:00:00Z', claim_token: null, claim_expires_at: null, dead_reason: null,
  occurred_at: null, // null: the transaction's own start, as a committing command stamps it
});
const insertEvent = (e, sql = observer) => sql`insert into tmpos_internal.outbox_event (event_id, event_type, event_version, aggregate_type, aggregate_id,
    aggregate_version, tenant_digest, store_digest, actor_digest, correlation_id, payload, occurred_at, status, attempt, due_at, claim_token,
    claim_expires_at, dead_reason)
  values (${e.event_id}, ${e.event_type}, ${e.event_version}, ${e.aggregate_type}, ${e.aggregate_id}, ${e.aggregate_version}::bigint, ${e.tenant},
    ${e.store}, ${e.actor}, ${e.correlation_id}, ${sql.json(e.payload)}, coalesce(${e.occurred_at}::text::timestamptz, pg_catalog.now()), ${e.status}, ${e.attempt}, ${e.due_at}::text::timestamptz,
    ${e.claim_token}, ${e.claim_expires_at}::text::timestamptz, ${e.dead_reason})`; // ::text keeps the server parsing these, whatever a case binds
const baseRecord = () => ({
  scope: token(), fingerprint: token(), lease: token(), lease_expires_at: '2030-01-01T00:00:00Z', expires_at: '2030-01-02T00:00:00Z', response: null,
});
const insertRecord = (r) => observer`insert into tmpos_internal.idempotency_record (scope, fingerprint, lease, lease_expires_at, expires_at, response)
  values (${r.scope}, ${r.fingerprint}, ${r.lease}, ${r.lease_expires_at}::text::timestamptz, ${r.expires_at}::text::timestamptz,
    ${r.response})`; // as text: the server, not the driver's Date, reads 'infinity'

test('M6-PG-01: migration 006 applies on 001-005, refuses a destructive rollback, reverses cleanly and re-applies', async () => {
  assert.equal(applyReport.outcome, 'complete', `the trusted apply failed: ${applyReport.code}`);
  const ledger = await observer`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), ['001', '002', '003', '004', '005', '006'].map((v) => [v, false]),
    '001-006 are recorded clean in the ledger of the disposable database');
  await assertStorePosture('after the trusted apply');
  const [{ roles }] = await observer`select count(*)::int as roles from pg_catalog.pg_roles where rolname in ('tmpos_app', 'tmpos_audit_writer')`;
  assert.equal(roles, 2, 'no role was created or removed');

  // The rollback refuses while it would destroy an undelivered event or a retained record — and drops nothing.
  const downInTransaction = () => observer.begin((tx) => tx.unsafe(DOWN_006).simple());
  const pending = baseEvent();
  await insertEvent(pending);
  assert.deepEqual(await refusal(downInTransaction), { code: '55006', constraint: null }, 'an undelivered event refuses the rollback');
  await assertStorePosture('after a refused rollback');
  await observer`delete from tmpos_internal.outbox_event where event_id = ${pending.event_id}`;
  const retained = baseRecord();
  await insertRecord(retained);
  assert.deepEqual(await refusal(downInTransaction), { code: '55006', constraint: null }, 'a record within its retention refuses the rollback');
  await observer`delete from tmpos_internal.idempotency_record where scope = ${retained.scope}`;
  // Something 006 did not create, in its schema: the schema is dropped without CASCADE, so the rollback refuses to
  // take it along — and drops nothing.
  await observer`create table tmpos_internal.m6_stray (id integer)`;
  assert.deepEqual(await refusal(downInTransaction), { code: '2BP01', constraint: null }, 'a stray object in the schema refuses the rollback');
  await observer`drop table tmpos_internal.m6_stray`;
  await assertStorePosture('after a rollback refused for a stray object');

  await downInTransaction();
  const [gone] = await observer`select to_regnamespace('tmpos_internal') is null as schema,
    (select count(*)::int from pg_catalog.pg_class where relname in ('idempotency_record', 'outbox_event')) as tables,
    (select count(*)::int from pg_catalog.pg_proc where proname = any (${STORE_FUNCTIONS})) as functions`;
  assert.deepEqual(gone, { schema: true, tables: 0, functions: 0 }, 'the rollback removes exactly what 006 created, its schema last');
  const [kept] = await observer`select to_regclass('public.audit_event') is not null as audit,
    (select count(*)::int from pg_catalog.pg_roles where rolname in ('tmpos_app', 'tmpos_audit_writer')) as roles,
    (select count(*)::int from pg_catalog.pg_policies where schemaname = 'public') as policies`;
  assert.deepEqual(kept, { audit: true, roles: 2, policies: 5 }, '001-005 — audit_event, both roles, the five 005 policies — are untouched');

  await observer.begin((tx) => tx.unsafe(UP_006).simple());
  await assertStorePosture('after re-applying');
});

test('M6-PG-23: migration 006 pins its own search path — an operator planted ahead of pg_catalog answers neither its grant check, its constraints nor its rollback refusal', async () => {
  const P = `tmpos_m6p5_${randomBytes(4).toString('hex')}_`;
  const [eq, ne, stray] = [`${P}eq`, `${P}ne`, `${P}stray`];
  const PIN = 'set local search_path = pg_catalog, pg_temp;';
  const unpinned = (text) => text.replace(PIN, '');
  assert.ok(UP_006.includes(PIN) && DOWN_006.includes(PIN), 'both files pin their search path');
  // Planted ahead of pg_catalog in an applier's path, each always false: = on text (the rollback then sees no
  // undelivered event) and <> on oid (section 6 then sees no stray grant).
  await observer.unsafe(`create schema ${eq}; create schema ${ne};
    create function ${eq}.never(text, text) returns boolean language sql immutable as 'select false';
    create operator ${eq}.= (function = ${eq}.never, leftarg = text, rightarg = text);
    create function ${ne}.never(oid, oid) returns boolean language sql immutable as 'select false';
    create operator ${ne}.<> (function = ${ne}.never, leftarg = oid, rightarg = oid);
    create role ${stray} nologin;`).simple();
  const under = (path, text) => (tx) => tx.unsafe(`set local search_path = ${path}, pg_catalog; ${text}`).simple();
  const rolledBack = async (fn) => {
    const sentinel = {};
    let seen;
    await observer.begin(async (tx) => { seen = await fn(tx); throw sentinel; }).catch((e) => { if (e !== sentinel) throw e; });
    return seen;
  };
  const plantedBindings = async (sql) => (await sql`select count(*)::int as n from pg_catalog.pg_depend d
    where d.refclassid = 'pg_catalog.pg_operator'::regclass and d.refobjid in (select o.oid from pg_catalog.pg_operator o
      where o.oprnamespace in (${eq}::regnamespace, ${ne}::regnamespace))`)[0].n;
  try {
    const pending = baseEvent();
    await insertEvent(pending);
    assert.equal(await rolledBack(async (tx) => {
      await under(eq, unpinned(DOWN_006))(tx);
      return (await tx`select pg_catalog.to_regnamespace('tmpos_internal') is null as gone`)[0].gone;
    }), true, 'control: unpinned, the planted = hides the undelivered event and the rollback drops it (rolled back here)');
    assert.deepEqual(await refusal(() => observer.begin(under(eq, DOWN_006))), { code: '55006', constraint: null },
      'pinned, the rollback still refuses while an event is undelivered');
    await observer`delete from tmpos_internal.outbox_event where event_id = ${pending.event_id}`;
    await observer.begin((tx) => tx.unsafe(DOWN_006).simple());

    // A default privilege hands the stray role SELECT on every table the applier creates.
    await observer.unsafe(`alter default privileges grant select on tables to ${stray}`);
    assert.equal(await rolledBack(async (tx) => {
      await under(ne, unpinned(UP_006))(tx);
      return (await tx`select pg_catalog.has_table_privilege(${stray}, 'tmpos_internal.outbox_event', 'SELECT') as leaked`)[0].leaked;
    }), true, 'control: unpinned, the planted <> hides the stray grant and the apply completes with it (rolled back here)');
    assert.deepEqual(await refusal(() => observer.begin(under(ne, UP_006))), { code: '55000', constraint: null },
      'pinned, section 6 sees the stray grant and refuses');
    await observer.unsafe(`alter default privileges revoke select on tables from ${stray}`);

    // Under both, pinned: the apply completes and nothing binds to a planted operator, as a constraint created under
    // that path would (control, rolled back).
    assert.ok(await rolledBack(async (tx) => {
      await tx.unsafe(`set local search_path = ${eq}, pg_catalog; create table pg_temp.m6_probe (s text check (s = 'x'))`).simple();
      return plantedBindings(tx);
    }) > 0, 'control: a constraint created under the planted path binds to it');
    await observer.begin(under(`${eq}, ${ne}`, UP_006));
    assert.equal(await plantedBindings(observer), 0, 'applied under the planted path, nothing binds to a planted operator');
    await assertStorePosture('after an apply under a hostile search path');
  } finally {
    await observer.unsafe(`alter default privileges revoke select on tables from ${stray}`);
    if ((await observer`select pg_catalog.to_regnamespace('tmpos_internal') is null as gone`)[0].gone) {
      await observer.begin((tx) => tx.unsafe(UP_006).simple()); // never leave the suite's store rolled back
    }
    await observer.unsafe(`drop schema if exists ${eq} cascade; drop schema if exists ${ne} cascade; drop role if exists ${stray}`).simple();
  }
});

test('M6-PG-28: section 6 refuses a routine granted beyond tmpos_app, a table granted to it, a routine not defined as 006 defines it, and a project role inside the owner', async () => {
  const P = `tmpos_m6p6_${randomBytes(4).toString('hex')}_`;
  const stray = `${P}stray`;
  const [{ me }] = await observer`select current_user::text as me`;
  await observer.unsafe(`create role ${stray} nologin`);
  const sentinel = new Error('rolled back');
  /**
   * The down, `setup`, then `up`, in one transaction that is always rolled back: the refusal's code and message, or 'applied'
   * followed by what `inspect` read inside it.
   */
  const applyWith = async (setup, up = UP_006, inspect = async () => '') => {
    let seen = '';
    try {
      await observer.begin(async (tx) => {
        await tx.unsafe(DOWN_006).simple();
        if (setup !== '') await tx.unsafe(setup).simple();
        await tx.unsafe(up).simple();
        seen = await inspect(tx);
        throw sentinel;
      });
    } catch (err) {
      return err === sentinel ? `applied${seen}` : `${err.code} ${err.message}`;
    }
    return 'not rolled back';
  };
  const PROBE_DEFINER = 'create function tmpos_internal.m6_store_probe()\nreturns boolean\nlanguage plpgsql\nvolatile\nsecurity definer\nset search_path = pg_catalog, pg_temp\n';
  const CLOCK = 'create function tmpos_internal.m6_store_clock()\nreturns timestamptz\nlanguage sql\nvolatile\n';
  assert.ok(UP_006.includes(PROBE_DEFINER) && UP_006.includes(CLOCK), 'the probe routine and the clock are written as the cases below rewrite them');
  const GRANT = 'migration 006 refused: an object of the transactional store carries a direct grant beyond the owner\'s and tmpos_app\'s own';
  const LOOSE = 'migration 006 refused: a function of the transactional store is not one this migration defines as it defines it';
  const MEMBER = 'migration 006 refused: a role of this project is a member of the transactional store\'s owner';
  try {
    assert.equal(await applyWith(''), 'applied', 'control: as written, the down and the up complete');
    assert.equal(await applyWith(`alter default privileges grant execute on functions to ${stray}`), `55000 ${GRANT}`,
      'a default privilege handing every new function to another role');
    // Section 4 revokes every table, clock and guard privilege from tmpos_app by name, so a default privilege handing it one is
    // removed before section 6 looks — the apply completes without it; what section 4 does not revoke, section 6 refuses.
    const runtimeReach = async (tx) => ` ${(await tx`select pg_catalog.has_table_privilege('tmpos_app', 'tmpos_internal.outbox_event', 'SELECT')
      or pg_catalog.has_function_privilege('tmpos_app', 'tmpos_internal.m6_store_clock()', 'EXECUTE') as reach`)[0].reach}`;
    assert.equal(await applyWith('alter default privileges grant select on tables to tmpos_app; alter default privileges grant execute on functions to tmpos_app',
      UP_006, runtimeReach), 'applied false', 'a default privilege handing the runtime role a table or the clock is revoked by section 4');
    assert.equal(await applyWith('alter default privileges grant create on schemas to tmpos_app'), `55000 ${GRANT}`,
      'a default privilege handing the runtime role CREATE on the schema');
    assert.equal(await applyWith('alter default privileges grant execute on functions to tmpos_app with grant option'), `55000 ${GRANT}`,
      'the runtime role handed its routines with the right to grant them on');
    assert.equal(await applyWith('', UP_006.replace(PROBE_DEFINER, PROBE_DEFINER.replace('security definer\n', ''))), `55000 ${LOOSE}`,
      'a routine that is not SECURITY DEFINER');
    assert.equal(await applyWith('', UP_006.replace(PROBE_DEFINER, PROBE_DEFINER.replace('pg_catalog, pg_temp', 'pg_catalog, public, pg_temp'))), `55000 ${LOOSE}`,
      'a routine whose search path is not pinned to pg_catalog, pg_temp');
    assert.equal(await applyWith('', UP_006.replace(CLOCK, `${CLOCK}security definer\n`)), `55000 ${LOOSE}`, 'the clock made SECURITY DEFINER');
    assert.equal(await applyWith(`grant "${me}" to tmpos_app`), `55000 ${MEMBER}`, 'the runtime role made a member of the owner');
  } finally {
    await observer.unsafe(`drop role if exists ${stray}`);
  }
  await assertStorePosture('after the refused applies');
});

test('M6-PG-02: the database refuses malformed, oversized and contradictory values; the runtime role reaches neither table nor the clock', async () => {
  const records = [
    ['a 42-character scope', { scope: 'A'.repeat(42) }, 'idempotency_record_scope_chk'],
    ['a scope outside base64url', { scope: '+'.repeat(43) }, 'idempotency_record_scope_chk'],
    ['a malformed fingerprint', { fingerprint: 'x' }, 'idempotency_record_fingerprint_chk'],
    ['a 44-character lease', { lease: 'A'.repeat(44) }, 'idempotency_record_lease_chk'],
    ['a lease that outlives its retention', { lease_expires_at: '2030-01-03T00:00:00Z' }, 'idempotency_record_expiry_chk'],
    ['a retention that never ends', { expires_at: 'infinity' }, 'idempotency_record_expiry_chk'],
    ['a lease that expired before time', { lease_expires_at: '-infinity' }, 'idempotency_record_expiry_chk'],
    ['a retention past the readable range', { expires_at: '10000-01-01T00:00:00Z' }, 'idempotency_record_expiry_chk'],
    ['an empty response', { response: '' }, 'idempotency_record_response_chk'],
    ['a response one character over MAX_SEALED_LENGTH', { response: 'A'.repeat(MAX_SEALED_LENGTH + 1) }, 'idempotency_record_response_chk'],
    ['a response outside base64url', { response: 'AAAA=' }, 'idempotency_record_response_chk'],
  ];
  for (const [label, over, constraint] of records) {
    const record = { ...baseRecord(), ...over };
    const refused = await refusal(() => insertRecord(record));
    // A value the database was meant to refuse but stored would otherwise stay behind for every later case in the
    // shared database. The delete count also tells a stored row apart from a driver error that carried no code.
    const stored = refused.code === null
      ? (await observer`delete from tmpos_internal.idempotency_record where scope = ${record.scope}`).count : 0;
    assert.deepEqual(refused, { code: '23514', constraint }, `${label} (rows stored: ${stored})`);
  }
  const largest = { ...baseRecord(), response: 'A'.repeat(MAX_SEALED_LENGTH) };
  assert.deepEqual(await refusal(() => insertRecord(largest)), { code: null, constraint: null }, 'a response of exactly MAX_SEALED_LENGTH is stored');
  // The last storable microsecond, not the last second: a bound tightened to 23:59:59 would still admit that.
  const lastRecord = { ...baseRecord(), lease_expires_at: '9999-12-31T23:59:59.999999Z', expires_at: '9999-12-31T23:59:59.999999Z' };
  assert.deepEqual(await refusal(() => insertRecord(lastRecord)), { code: null, constraint: null }, 'the last readable moment is a storable retention');
  // The delete count is the witness: refusal() cannot tell a stored row from a throw that carried no code.
  assert.equal((await observer`delete from tmpos_internal.idempotency_record where scope = ${lastRecord.scope}`).count, 1,
    'the last readable retention was really stored');
  assert.deepEqual(await refusal(() => insertRecord({ ...baseRecord(), scope: largest.scope })), { code: '23505', constraint: 'idempotency_record_pkey' },
    'one row per scope');

  const claimedAt = { status: 'claimed', attempt: 1, claim_token: token(), claim_expires_at: '2030-01-01T00:00:00Z' };
  const events = [
    ['an uppercase event type', { event_type: 'Conformance.item' }, 'outbox_event_type_chk'],
    ['a 65-character event type', { event_type: `a${'.b'.repeat(32)}` }, 'outbox_event_type_chk'],
    ['event version 0', { event_version: 0 }, 'outbox_event_version_chk'],
    ['event version 1001', { event_version: 1001 }, 'outbox_event_version_chk'],
    ['an uppercase aggregate type', { aggregate_type: 'Item' }, 'outbox_event_aggregate_type_chk'],
    ['aggregate version 0', { aggregate_version: '0' }, 'outbox_event_aggregate_version_chk'],
    ['an aggregate version past MAX_SAFE_INTEGER', { aggregate_version: '9007199254740992' }, 'outbox_event_aggregate_version_chk'],
    ['a malformed tenant digest', { tenant: 'tenant-a' }, 'outbox_event_digest_chk'],
    ['a payload that is not an object', { payload: [1] }, 'outbox_event_payload_chk'],
    ['an oversized payload', { payload: { name: 'x'.repeat(6_000) } }, 'outbox_event_payload_chk'],
    ['an unknown status, which the state machine refuses too', { status: 'sent' }, ['outbox_event_state_chk', 'outbox_event_status_chk']],
    ['a negative attempt', { attempt: -1 }, 'outbox_event_attempt_chk'],
    ['an attempt past the bound', { attempt: 1001 }, 'outbox_event_attempt_chk'],
    ['an event never due', { due_at: 'infinity' }, 'outbox_event_time_chk'],
    ['an event that never occurred', { occurred_at: 'infinity' }, 'outbox_event_time_chk'],
    ['an event that occurred before time', { occurred_at: '-infinity' }, 'outbox_event_time_chk'],
    ['an event occurring past the readable range', { occurred_at: '10000-01-01T00:00:00Z' }, 'outbox_event_time_chk'],
    ['an event occurring at the epoch', { occurred_at: '1970-01-01T00:00:00Z' }, 'outbox_event_time_chk'],
    ['an event occurring inside the first millisecond', { occurred_at: '1970-01-01T00:00:00.0005Z' }, 'outbox_event_time_chk'],
    ['a claim that never expires', { ...claimedAt, claim_expires_at: 'infinity' }, 'outbox_event_time_chk'],
    ['a malformed claim token', { ...claimedAt, claim_token: 'short' }, 'outbox_event_claim_token_chk'],
    ['an unknown dead reason', { status: 'dead', attempt: 1, dead_reason: 'other' }, 'outbox_event_dead_reason_chk'],
    ['a claimed event without a token', { ...claimedAt, claim_token: null }, 'outbox_event_state_chk'],
    ['a claimed event never attempted', { ...claimedAt, attempt: 0 }, 'outbox_event_state_chk'],
    ['a pending event holding a token', { claim_token: token() }, 'outbox_event_state_chk'],
    ['a delivered event never attempted', { status: 'delivered' }, 'outbox_event_state_chk'],
    ['a dead event without its reason', { status: 'dead', attempt: 1 }, 'outbox_event_state_chk'],
  ];
  for (const [label, over, constraint] of events) {
    const event = { ...baseEvent(), ...over };
    const refused = await refusal(() => insertEvent(event));
    // A value the database was meant to refuse but stored would otherwise stay behind and fail a later,
    // unrelated case as well, hiding which constraint actually regressed.
    // The delete count also tells a stored row apart from a driver error that carried no code.
    const stored = refused.code === null
      ? (await observer`delete from tmpos_internal.outbox_event where event_id = ${event.event_id}`).count : 0;
    assert.ok(refused.code === '23514' && [constraint].flat().includes(refused.constraint),
      `${label}: ${refused.code} ${refused.constraint} (rows stored: ${stored})`);
  }
  // The last storable microsecond, not the last second, and each delete count is the witness that the row existed:
  // refusal() reports the same shape for a stored row and for a throw that carried no code.
  const lastEvent = { ...baseEvent(), occurred_at: '9999-12-31T23:59:59.999999Z' };
  assert.deepEqual(await refusal(() => insertEvent(lastEvent)), { code: null, constraint: null }, 'the last readable moment is a storable occurrence');
  assert.equal((await observer`delete from tmpos_internal.outbox_event where event_id = ${lastEvent.event_id}`).count, 1,
    'the last readable occurrence was really stored');
  const firstEvent = { ...baseEvent(), occurred_at: '1970-01-01T00:00:00.001Z' };
  assert.deepEqual(await refusal(() => insertEvent(firstEvent)), { code: null, constraint: null }, 'the first readable millisecond is a storable occurrence');
  assert.equal((await observer`delete from tmpos_internal.outbox_event where event_id = ${firstEvent.event_id}`).count, 1,
    'the first readable millisecond was really stored');
  const valid = baseEvent();
  await insertEvent(valid);
  assert.deepEqual(await refusal(() => insertEvent({ ...baseEvent(), event_id: valid.event_id })), { code: '23505', constraint: 'outbox_event_pkey' },
    'one row per event ID');
  await observer`delete from tmpos_internal.outbox_event where event_id = ${valid.event_id}`;
  await observer`delete from tmpos_internal.idempotency_record where scope = ${largest.scope}`;

  // The runtime role, through its own LOGIN, reaches neither table and not the clock: every read and write is refused
  // before a row is seen — the lifecycle routines are its only way to the store.
  const direct = postgres(driverDsn(TARGET_DSN, STORE_PROBE), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 1, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS, user: STORE_PROBE,
  });
  extraClients.push(direct);
  for (const [label, statement] of [
    ['a record read', () => direct`select scope, lease, response from tmpos_internal.idempotency_record where false`],
    ['a record insert', () => direct`insert into tmpos_internal.idempotency_record (scope, fingerprint, lease, lease_expires_at, expires_at)
      values (${token()}, ${token()}, ${token()}, now(), now())`],
    ['a response cleared', () => direct`update tmpos_internal.idempotency_record set response = null where false`],
    ['a retention shortened', () => direct`update tmpos_internal.idempotency_record set expires_at = now() where false`],
    ['a lease replaced', () => direct`update tmpos_internal.idempotency_record set lease = ${token()} where false`],
    ['a record delete', () => direct`delete from tmpos_internal.idempotency_record where false`],
    ['an event read', () => direct`select claim_token from tmpos_internal.outbox_event where false`],
    ['an event insert', () => insertEvent(baseEvent(), direct)],
    ['a claim released', () => direct`update tmpos_internal.outbox_event set status = 'pending', claim_token = null, claim_expires_at = null where false`],
    ['a due time moved', () => direct`update tmpos_internal.outbox_event set due_at = now() where false`],
    ['an envelope payload', () => direct`update tmpos_internal.outbox_event set payload = '{}'::jsonb where false`],
    ['an outbox delete', () => direct`delete from tmpos_internal.outbox_event where false`],
    ['the store clock', () => direct`select tmpos_internal.m6_store_clock()`],
    ['an audit read', () => direct`select 1 from public.audit_event where false`],
  ]) {
    assert.equal((await refusal(statement)).code, '42501', `the runtime role is refused ${label}`);
  }
  assert.equal((await direct`select tmpos_internal.m6_store_probe() as ok`)[0].ok, true, 'and executes the routines');
});

// ---------------------------------------------------------------------------
// the three unchanged conformance suites, over two instances
// ---------------------------------------------------------------------------

test('M6-PG-03: the unchanged idempotency conformance suite passes over two independent instances on separate connections', async () => {
  await ready();
  const [[a], [b]] = await Promise.all([clientA`select pg_catalog.pg_backend_pid() as pid`, clientB`select pg_catalog.pg_backend_pid() as pid`]);
  assert.notEqual(a.pid, b.pid, 'two pools, two backends');
  assert.notEqual(A.idempotency, B.idempotency);
  await assertIdempotencyStoreContract({
    store: A.idempotency, peer: B.idempotency, advance, breakStore: storeDown, restoreStore: () => relay.restore(),
  });
});

test('M6-PG-04: the unchanged command-transaction conformance suite passes over two independent instances', async () => {
  await ready();
  await assertCommandTransactionContract(harness());
});

test('M6-PG-05: the unchanged outbox delivery conformance suite passes over two independent instances', async () => {
  await ready();
  await observer`delete from tmpos_internal.outbox_event`; // the suite starts from a store holding only the events it enqueues
  await assertOutboxDeliveryContract(harness());
});

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

test('M6-PG-06: decisions follow the database clock read after the lock — never the host clock, never the transaction start', async () => {
  await ready();
  await observer.unsafe(productionClock); // the migration's own clock_timestamp() for this case
  const hostNow = Date.now;
  try {
    const skew = (days) => { Date.now = () => hostNow() + days * 86_400_000; };
    const op = operation();
    assert.deepEqual(await A.idempotency.acquire(acquireRequest(op, lease(), 1_000, 3_000), live()), ACQUIRED);
    skew(7);
    assert.deepEqual(await B.idempotency.acquire(acquireRequest(op, lease(), 1_000, 3_000), live()), IN_PROGRESS,
      'a host clock a week ahead expires nothing');
    skew(-7);
    await sleep(1_050);
    assert.deepEqual(await B.idempotency.acquire(acquireRequest(op, lease(), 1_000, 3_000), live()), RECLAIMED,
      'a host clock a week behind keeps nothing alive: the lease expired by the database clock');
    Date.now = hostNow;

    // A lease that expires WHILE the acquisition waits on the row lock: its transaction began before the expiry,
    // and only a clock read after the lock sees that it has passed.
    const w = operation();
    assert.deepEqual(await A.idempotency.acquire(acquireRequest(w, lease(), 300, 3_000), live()), ACQUIRED);
    const waited = await whileLocked((tx) => tx`select 1 from tmpos_internal.idempotency_record where scope = ${w.scope} for update`, 500,
      () => B.idempotency.acquire(acquireRequest(w, lease(), 300, 3_000), live()));
    assert.deepEqual(waited.value, RECLAIMED, 'decided on the clock read after the lock wait, not at the transaction start');
    assert.equal(waited.released, true, 'and it did wait for the lock');

    // The commit fence the same way: retention ends while the commit waits, so the commit is fenced out.
    const late = await begin(A, { leaseMs: 100, retentionMs: 300 });
    const command = creating(late);
    const fenced = await whileLocked((tx) => tx`select 1 from tmpos_internal.idempotency_record where scope = ${late.op.scope} for update`, 500,
      () => B.transactions.commit(command, live()));
    assert.deepEqual(fenced.value, LEASE_LOST, 'retention is judged after the lock, so a commit that waited past it commits nothing');
    assert.deepEqual(await footprint(command), NOTHING);
  } finally {
    Date.now = hostNow;
    await observer.unsafe(FROZEN_CLOCK);
  }
});

// ---------------------------------------------------------------------------
// the transaction: order, rollback, conflict, fault, concurrency, lost acknowledgement
// ---------------------------------------------------------------------------

test('M6-PG-07: a failure at the mutation, the audit, an event or the completion discards every part that already ran', async () => {
  await ready();
  const order = ['mutation', 'audit', 'outbox', 'completion'];
  for (const [i, component] of order.entries()) {
    const attempt = await begin(A);
    const command = creating(attempt);
    const before = await witness();
    await arm(component);
    assert.deepEqual(await A.transactions.commit(command, live()), UNAVAILABLE, `a failure at the ${component} commits nothing`);
    const ran = ranSince(before, await witness());
    assert.deepEqual(ran, Object.fromEntries(order.map((part, j) => [part, j <= i ? 1 : 0])),
      `the parts up to the ${component} really ran, in order, before the rollback`);
    assert.deepEqual(await footprint(command), NOTHING, `and none of them survived the failure at the ${component}`);
    assert.deepEqual(await B.idempotency.acquire(acquireRequest(attempt.op, lease()), live()), IN_PROGRESS, 'the lease still holds');
    assert.deepEqual(await B.transactions.commit(command, live()), COMMITTED, 'the holder commits afterwards, on the other instance');
    assert.deepEqual(await footprint(command), { version: 1, audit: 1, events: 1, completed: 1 });
  }
});

test('M6-PG-08: a fenced attempt runs nothing; a conflict and a reused event ID commit nothing, and neither is mistaken for the other', async () => {
  await ready();
  const first = await begin(A);
  const created = creating(first);
  assert.deepEqual(await A.transactions.commit(created, live()), COMMITTED);

  // A stale lease: fenced before any business statement.
  const stale = await begin(A);
  const before = await witness();
  assert.deepEqual(await B.transactions.commit(creating({ ...stale, lease: lease() }), live()), LEASE_LOST);
  assert.deepEqual(ranSince(before, await witness()), { mutation: 0, audit: 0, outbox: 0, completion: 0 }, 'a fenced attempt reaches no business statement');

  // A conflict: the mutation ran and found its precondition false; nothing else ran, nothing stayed.
  const rival = creating(stale, 'rival', created.mutation.aggregateId);
  const b2 = await witness();
  assert.deepEqual(await A.transactions.commit(rival, live()), CONFLICT);
  assert.deepEqual(ranSince(b2, await witness()), { mutation: 1, audit: 0, outbox: 0, completion: 0 }, 'a conflict stops after the mutation');
  assert.deepEqual(await footprint(rival), { version: 1, audit: 0, events: 0, completed: 0 }, 'and leaves the existing aggregate as it was');
  assert.deepEqual(await B.idempotency.acquire(acquireRequest(stale.op, lease()), live()), IN_PROGRESS, 'the lease is kept, to expire');

  // A reused event ID: a fault, detected at the outbox insert, and everything before it is rolled back.
  const renamed = renaming(stale, created.mutation.aggregateId, 1);
  const reusing = Object.freeze({ ...renamed, events: Object.freeze([Object.freeze({ ...renamed.events[0], eventId: created.events[0].eventId })]) });
  const b3 = await witness();
  assert.deepEqual(await A.transactions.commit(reusing, live()), UNAVAILABLE, 'a reused event ID is a fault, never a conflict');
  assert.deepEqual(ranSince(b3, await witness()), { mutation: 1, audit: 1, outbox: 1, completion: 0 });
  assert.deepEqual(await footprint(reusing), { version: 1, audit: 0, events: 0, completed: 0 }, 'the rename and its audit record were rolled back');
  const [original] = await observer`select status, attempt, payload from tmpos_internal.outbox_event where event_id = ${created.events[0].eventId}`;
  assert.deepEqual(original, { status: 'pending', attempt: 0, payload: created.events[0].payload }, 'and the event whose ID was reused is untouched');
  assert.deepEqual(await B.transactions.commit(renamed, live()), COMMITTED, 'the holder then commits the rename');
  assert.deepEqual(await footprint(renamed), { version: 2, audit: 1, events: 1, completed: 1 });
});

test('M6-PG-09: of sixteen concurrent commands on one aggregate version across two instances, exactly one mutates', async () => {
  await ready();
  const seed = await begin(A);
  const created = creating(seed);
  assert.deepEqual(await A.transactions.commit(created, live()), COMMITTED);
  const attempts = await Promise.all(Array.from({ length: 16 }, () => begin(A)));
  const renames = attempts.map((attempt) => renaming(attempt, created.mutation.aggregateId, 1));
  const answers = await Promise.all(renames.map((command, i) => (i % 2 === 0 ? A : B).transactions.commit(command, live())));
  assert.equal(answers.filter((a) => a.outcome === 'committed').length, 1, 'exactly one commits');
  assert.ok(answers.every((a) => a.outcome === 'committed' || a.outcome === 'conflict'), 'every other conflicts');
  const traces = await Promise.all(renames.map(footprint));
  assert.deepEqual([traces[0].version, traces.reduce((n, t) => n + t.audit, 0), traces.reduce((n, t) => n + t.events, 0), traces.reduce((n, t) => n + t.completed, 0)],
    [2, 1, 1, 1], 'one version step, one audit record, one event, one completion');
});

test('M6-PG-10: a COMMIT whose acknowledgement is lost rejects as indeterminate; it landed once, replays, and is never repeated', async () => {
  await ready();
  const lossyClient = storeClient(1);
  extraClients.push(lossyClient);
  const lossy = createPostgresTransactionalStore({ client: lossyClient, mutators: MUTATORS });
  const attempt = await begin(A);
  const command = creating(attempt);
  relay.dropNextCommitAnswer();
  let rejection = null;
  try {
    await lossy.transactions.commit(command, live());
  } catch (err) {
    rejection = err;
  }
  assert.ok(rejection instanceof Error, 'the lost acknowledgement is a rejection, never an answer');
  assert.deepEqual([rejection.message, Object.keys(rejection), rejection.cause], [OUTCOME_UNKNOWN, [], undefined], 'one fixed message, nothing of the driver');
  assert.deepEqual(await footprint(command), { version: 1, audit: 1, events: 1, completed: 1 }, 'the commit landed, every part of it');
  assert.deepEqual(await B.idempotency.acquire(acquireRequest(attempt.op, lease()), live()), { outcome: 'replay', response: command.response },
    'a later request replays the completion');
  assert.deepEqual(await B.transactions.commit(command, live()), LEASE_LOST, 'and the same command never commits twice');
  assert.deepEqual(await footprint(command), { version: 1, audit: 1, events: 1, completed: 1 }, 'nothing was duplicated');
});

// ---------------------------------------------------------------------------
// aborts, timeouts, SQLSTATEs and connection failure
// ---------------------------------------------------------------------------

test('M6-PG-11: an aborted call touches nothing; an abort while blocked cancels the wait and rolls everything back', async () => {
  await ready();
  const attempt = await begin(A);
  const command = creating(attempt);
  const gone = new AbortController();
  gone.abort();
  const chunks = relay.state.chunks;
  for (const call of [
    () => A.transactions.commit(command, gone.signal),
    () => A.idempotency.acquire(acquireRequest(operation(), lease()), gone.signal),
    () => A.idempotency.complete({ scope: attempt.op.scope, lease: attempt.lease, response: command.response }, gone.signal),
    () => A.delivery.claim({ claim: token(), limit: 1, claimMs: 30_000 }, gone.signal),
  ]) assert.deepEqual(await call(), UNAVAILABLE);
  assert.equal(relay.state.chunks, chunks, 'no byte reached the server');
  assert.deepEqual(await footprint(command), NOTHING);

  const blocked = await whileLocked((tx) => tx`select 1 from tmpos_internal.idempotency_record where scope = ${attempt.op.scope} for update`, 1_200, async () => {
    const ctl = new AbortController();
    const answer = A.transactions.commit(command, ctl.signal);
    await sleep(150);
    ctl.abort();
    return answer;
  });
  assert.deepEqual(blocked.value, UNAVAILABLE, 'the abort ends the call');
  assert.equal(blocked.released, false, 'while the lock was still held: the wait was cancelled, not waited out');
  assert.deepEqual(await footprint(command), NOTHING, 'and nothing was written');
  assert.deepEqual(await B.transactions.commit(command, live()), COMMITTED, 'the holder commits once the lock is free');
});

test('M6-PG-12: lock and statement timeouts, deadlock, serialization, unknown SQLSTATEs, a cut connection and an unexpected null all fail closed', async () => {
  await ready();
  // A real lock timeout, below each port's deadline.
  const held = await begin(A);
  const heldCommand = creating(held);
  const timedOut = await whileLocked((tx) => tx`select 1 from tmpos_internal.idempotency_record where scope = ${held.op.scope} for update`, 2_500,
    () => A.transactions.commit(heldCommand, live()));
  assert.deepEqual([timedOut.value, timedOut.released], [UNAVAILABLE, false], 'the commit gave up on its own lock timeout');
  const acquired = await whileLocked((tx) => tx`select 1 from tmpos_internal.idempotency_record where scope = ${held.op.scope} for update`, 2_000,
    () => A.idempotency.acquire(acquireRequest(held.op, lease()), live()));
  assert.deepEqual([acquired.value, acquired.released], [UNAVAILABLE, false], 'so did the acquisition');
  assert.deepEqual(await footprint(heldCommand), NOTHING);

  // A real statement timeout: an event insert that sleeps past it.
  const before = await witness();
  await arm('outbox', 'sleep', 'P0001', 2.5);
  assert.deepEqual(await A.transactions.commit(heldCommand, live()), UNAVAILABLE, 'a statement past its timeout is cancelled by the server');
  assert.deepEqual(ranSince(before, await witness()), { mutation: 1, audit: 1, outbox: 1, completion: 0 });
  assert.deepEqual(await footprint(heldCommand), NOTHING);

  // Deadlock, serialization failure and an SQLSTATE nobody expects, raised inside the transaction.
  for (const sqlstate of ['40P01', '40001', 'XX000']) {
    await arm('audit', 'raise', sqlstate);
    assert.deepEqual(await B.transactions.commit(heldCommand, live()), UNAVAILABLE, `SQLSTATE ${sqlstate} before COMMIT commits nothing`);
  }
  await arm('completion', 'raise', '40001');
  const done = await begin(A);
  assert.deepEqual(await A.idempotency.complete({ scope: done.op.scope, lease: done.lease, response: heldCommand.response }, live()), UNAVAILABLE,
    'a failed completion completes nothing');
  assert.deepEqual(await B.idempotency.acquire(acquireRequest(done.op, lease()), live()), IN_PROGRESS);
  assert.deepEqual(await footprint(heldCommand), NOTHING);

  // A connection lost while the transaction's statement runs — the server ends the session, or it is cut without
  // a word — and then a store that is down: nothing was committed, nothing is, and the process survives each loss
  // (the pinned driver would crash it on a ROLLBACK sent after the loss — DA-15). Each loss is on a client and
  // relay of its own, so the shared instances never meet one.
  for (const loss of ['ended by the server', 'cut']) {
    const side = startRelay();
    await side.listening;
    const sideClient = storeClient(1, side);
    extraClients.push(sideClient);
    await arm('outbox', 'sleep', 'P0001', 1.2);
    const lost = createPostgresTransactionalStore({ client: sideClient, mutators: MUTATORS }).transactions.commit(heldCommand, live());
    const pid = await sleepingStoreSession();
    if (loss === 'cut') await side.close();
    else await observer`select pg_catalog.pg_terminate_backend(${pid})`;
    assert.deepEqual(await lost, UNAVAILABLE, `a connection ${loss} before COMMIT is a known rollback`);
    await side.close();
  }
  await storeDown();
  assert.deepEqual(await A.transactions.commit(heldCommand, live()), UNAVAILABLE, 'and an unreachable store answers at once');
  await relay.restore();
  assert.deepEqual(await footprint(heldCommand), NOTHING);

  // An unexpected null where the store's clock should be: every decision fails closed.
  await observer.unsafe(`create or replace function tmpos_internal.m6_store_clock() returns timestamptz language sql volatile
    set search_path = pg_catalog, pg_temp as $$ select null::timestamptz $$`);
  try {
    assert.deepEqual(await A.idempotency.acquire(acquireRequest(operation(), lease()), live()), UNAVAILABLE);
    assert.deepEqual(await A.transactions.commit(heldCommand, live()), UNAVAILABLE);
    assert.deepEqual(await footprint(heldCommand), NOTHING);
  } finally {
    await observer.unsafe(FROZEN_CLOCK);
  }
  assert.deepEqual(await B.transactions.commit(heldCommand, live()), COMMITTED, 'after every failure the holder still commits');
});

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

/** Enqueue `n` events by committing `n` creates; their event IDs. */
async function seed(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const command = creating(await begin(A));
    assert.deepEqual(await A.transactions.commit(command, live()), COMMITTED);
    ids.push(command.events[0].eventId);
  }
  return ids;
}
const claimOn = (store, held, limit = MAX_CLAIM_BATCH) => store.delivery.claim({ claim: held, limit, claimMs: 30_000 }, live());
const rowOf = async (eventId) => (await observer`select status, attempt, claim_token, dead_reason,
    (extract(epoch from due_at) * 1000)::bigint::text as due, (extract(epoch from claim_expires_at) * 1000)::bigint::text as claim_expires
  from tmpos_internal.outbox_event where event_id = ${eventId}`)[0];

test('M6-PG-13: concurrent claims across two instances take every event exactly once, each held by its claimer, and none waits on a locked row', async () => {
  await ready();
  await observer`delete from tmpos_internal.outbox_event`;
  const ids = await seed(64);
  const tokens = Array.from({ length: 8 }, token);
  const answers = await Promise.all(tokens.map((held, i) => claimOn(i % 2 === 0 ? A : B, held, MAX_CLAIM_BATCH)));
  const taken = answers.flatMap((a, i) => a.events.map((e) => ({ eventId: e.eventId, attempt: e.attempt, claim: tokens[i] })));
  assert.equal(new Set(taken.map((t) => t.eventId)).size, taken.length, 'no event is held by two claims');
  assert.deepEqual(taken.map((t) => t.eventId).sort(), [...ids].sort(), 'together they took every eligible event');
  for (const t of taken) {
    const row = await rowOf(t.eventId);
    assert.deepEqual([row.status, row.attempt, row.claim_token, t.attempt], ['claimed', 1, t.claim, 1], 'each is held by exactly the claim that returned it');
  }
  for (const t of taken) assert.deepEqual(await A.delivery.acknowledge({ eventId: t.eventId, claim: t.claim }, live()), { outcome: 'acknowledged' });

  // A claim never waits on a row another transaction holds: it passes over it and takes the rest at once.
  const [held, free] = await seed(2);
  const passed = await whileLocked((tx) => tx`select 1 from tmpos_internal.outbox_event where event_id = ${held} for update`, 1_500,
    () => claimOn(B, token(), MAX_CLAIM_BATCH));
  assert.deepEqual([passed.value.events.map((e) => e.eventId), passed.released], [[free], false], 'the locked row is passed over, and nothing waited');
  await observer`delete from tmpos_internal.outbox_event where event_id in (${held}, ${free})`;
});

test('M6-PG-14: a stale claim token settles nothing, and leaves the new holder\'s row exactly as it was', async () => {
  await ready();
  await observer`delete from tmpos_internal.outbox_event`;
  const [eventId] = await seed(1);
  const old = token();
  assert.equal((await claimOn(A, old)).events[0].eventId, eventId);
  await advance(30_000);
  const next = token();
  assert.deepEqual((await claimOn(B, next)).events.map((e) => [e.eventId, e.attempt]), [[eventId, 2]], 'reclaimed at its expiry, the attempt counted');
  const heldRow = await rowOf(eventId);
  assert.deepEqual(await A.delivery.acknowledge({ eventId, claim: old }, live()), CLAIM_LOST);
  assert.deepEqual(await A.delivery.retry({ eventId, claim: old, delayMs: 1_000 }, live()), CLAIM_LOST);
  assert.deepEqual(await A.delivery.deadLetter({ eventId, claim: old, reason: 'attempts_exhausted' }, live()), CLAIM_LOST);
  assert.deepEqual(await rowOf(eventId), heldRow, 'status, attempt, token, due time and reason are unchanged');
  assert.deepEqual(await B.delivery.acknowledge({ eventId, claim: next }, live()), { outcome: 'acknowledged' });
});

test('M6-PG-15: retry, delivery and dead-letter write exactly their transitions, by the store\'s clock', async () => {
  await ready();
  await observer`delete from tmpos_internal.outbox_event`;
  const [r, d] = await seed(2);
  const first = token();
  assert.equal((await claimOn(A, first)).events.length, 2);
  const t0 = await frozenNowMs();
  assert.deepEqual(await A.delivery.retry({ eventId: r, claim: first, delayMs: 5_000 }, live()), { outcome: 'scheduled' });
  assert.deepEqual(await rowOf(r), { status: 'pending', attempt: 1, claim_token: null, dead_reason: null, due: String(t0 + 5_000), claim_expires: null },
    'pending again, due exactly its delay after the store clock, the claim released');
  assert.deepEqual(await B.delivery.acknowledge({ eventId: d, claim: first }, live()), { outcome: 'acknowledged' });
  assert.deepEqual({ ...(await rowOf(d)), due: undefined }, { status: 'delivered', attempt: 1, claim_token: null, dead_reason: null, due: undefined, claim_expires: null });
  await advance(5_000);
  const second = token();
  assert.deepEqual((await claimOn(B, second)).events.map((e) => [e.eventId, e.attempt]), [[r, 2]], 'due again once its delay has passed');
  assert.deepEqual(await A.delivery.deadLetter({ eventId: r, claim: second, reason: 'envelope_invalid' }, live()), { outcome: 'dead_lettered' });
  assert.deepEqual((await rowOf(r)).dead_reason, 'envelope_invalid');
  await advance(1_000_000);
  assert.deepEqual(await claimOn(A, token()), EMPTY, 'neither a delivered nor a dead event is ever claimed again');
  const out = { eventId: randomUUID(), claim: token() };
  for (const [label, call] of [
    ['a zero delay', () => A.delivery.retry({ ...out, delayMs: 0 }, live())],
    ['a delay past the policy cap', () => A.delivery.retry({ ...out, delayMs: 900_001 }, live())],
    ['an unknown reason', () => A.delivery.deadLetter({ ...out, reason: 'other' }, live())],
  ]) assert.deepEqual(await call(), UNAVAILABLE, `${label} is refused before the store is asked`);
});

test('M6-PG-16: a claim takes at most 32, in due-time then event-ID order, deterministically', async () => {
  await ready();
  await observer`delete from tmpos_internal.outbox_event`;
  const ids = await seed(40);
  // Scatter the due times, with ties, so the order is the store's and not insertion order: take every event, then
  // retry each after its own delay — the one way the delivery state machine lets a due time change.
  const scatter = token();
  const taken = [...(await claimOn(A, scatter, 32)).events, ...(await claimOn(A, scatter, 32)).events].map((e) => e.eventId);
  assert.deepEqual([...taken].sort(), [...ids].sort(), 'every event taken for the scatter');
  const t = await frozenNowMs();
  const delays = ids.map((_, i) => 1_000 + ((i * 7) % 10) * 3);
  for (const [i, eventId] of ids.entries()) {
    assert.deepEqual(await A.delivery.retry({ eventId, claim: scatter, delayMs: delays[i] }, live()), { outcome: 'scheduled' });
  }
  const expected = ids.map((eventId, i) => ({ eventId, due: t + delays[i] }))
    .sort((x, y) => x.due - y.due || (x.eventId < y.eventId ? -1 : 1)).map((x) => x.eventId);
  await advance(1_027);
  const chunks = relay.state.chunks;
  for (const limit of [0, 33]) assert.deepEqual(await claimOn(A, token(), limit), UNAVAILABLE, `a limit of ${limit} is refused`);
  assert.equal(relay.state.chunks, chunks, 'before the store is asked');
  const firstBatch = (await claimOn(A, token(), 32)).events.map((e) => e.eventId);
  const secondBatch = (await claimOn(B, token(), 32)).events.map((e) => e.eventId);
  assert.deepEqual([firstBatch.length, secondBatch.length], [32, 8], 'the limit of 32, then the rest');
  assert.deepEqual([...firstBatch, ...secondBatch], expected, 'in (due time, event ID) order across both claims');
});

// ---------------------------------------------------------------------------
// what leaves the adapter
// ---------------------------------------------------------------------------

test('M6-PG-17: no statement, identifier, secret, key, payload or driver message leaves the adapter', async () => {
  await ready();
  const canary = `M6-CANARY-${randomUUID()}`;
  const written = [];
  const saved = { out: process.stdout.write, err: process.stderr.write, console: { ...console } };
  const record = (write) => function capture(chunk, ...rest) {
    written.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  process.stdout.write = record(saved.out);
  process.stderr.write = record(saved.err);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => written.push(args.map(String).join(' '));
  const seen = [];
  const attempt = await begin(A);
  const command = creating(attempt, canary);
  try {
    await arm('audit', 'raise', 'XX000'); // the server's message carries its own canary
    seen.push(await A.transactions.commit(command, live()));
    await storeDown();
    seen.push(await A.transactions.commit(command, live()));
    seen.push(await A.idempotency.acquire(acquireRequest(operation(), lease()), live()));
    seen.push(await A.delivery.claim({ claim: token(), limit: 1, claimMs: 30_000 }, live()));
    seen.push(await A.transactions.probe(live()));
    await relay.restore();
    const lossyClient = storeClient(1);
    extraClients.push(lossyClient);
    relay.dropNextCommitAnswer();
    try {
      await createPostgresTransactionalStore({ client: lossyClient, mutators: MUTATORS }).transactions.commit(command, live());
    } catch (err) {
      seen.push({ message: err.message, fields: Object.keys(err), cause: String(err.cause) });
    }
  } finally {
    await relay.restore();
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    Object.assign(console, saved.console);
  }
  assert.deepEqual(seen.slice(0, 5), [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, false], 'bounded answers only');
  assert.deepEqual(seen[5], { message: OUTCOME_UNKNOWN, fields: [], cause: 'undefined' });
  const text = `${JSON.stringify(seen)}\n${written.join('\n')}`;
  for (const needle of [canary, 'M6-DRIVER-CANARY', 'XX000', 'idempotency_record', 'outbox_event', 'audit_event', 'public.', 'tmpos_internal', 'm6_store_clock',
    ...ROUTINE_NAMES, 'transactional store routine', 'plpgsql',
    STORE_PROBE, relay.dir, DATABASE, 'CONNECTION_CLOSED', 'ECONNRESET', 'ENOENT', '57P01', 'administrator command', attempt.op.scope, attempt.lease,
    command.response]) {
    assert.ok(!text.includes(needle), `nothing that left the adapter carries ${needle.length > 24 ? 'a secret-length value' : needle}`);
  }
});

test('M6-PG-18: a command commits with no events, and with the most — eight — every part exactly once', async () => {
  await ready();
  for (const count of [0, MAX_EVENTS_PER_COMMAND]) {
    const one = creating(await begin(A));
    const command = { ...one, events: Array.from({ length: count }, () => ({ ...one.events[0], eventId: randomUUID() })) };
    assert.deepEqual(await B.transactions.commit(command, live()), COMMITTED, `${count} events commit`);
    assert.deepEqual(await footprint(command), { version: 1, audit: 1, events: count, completed: 1 }, `${count} events: every part once`);
  }
});

test('M6-PG-19: a command\'s audit record lands in public.audit_event even when the runtime role\'s path finds another first', async () => {
  await ready();
  // A schema named after the runtime login comes first on its default path ("$user", public), so an unqualified
  // audit_event would resolve to this decoy — unless the transaction pins its own path.
  await observer.unsafe(`create schema ${STORE_PROBE};
    create table ${STORE_PROBE}.audit_event (like public.audit_event including all);
    grant usage on schema ${STORE_PROBE} to ${STORE_PROBE};
    grant select, insert on ${STORE_PROBE}.audit_event to ${STORE_PROBE}`);
  try {
    const command = creating(await begin(A));
    assert.deepEqual(await A.transactions.commit(command, live()), COMMITTED);
    assert.deepEqual(await footprint(command), { version: 1, audit: 1, events: 1, completed: 1 }, 'the audit record is in public.audit_event');
    const [{ n }] = await observer.unsafe(`select count(*)::int as n from ${STORE_PROBE}.audit_event`);
    assert.equal(n, 0, 'and nothing reached the decoy');
  } finally {
    await observer.unsafe(`drop schema ${STORE_PROBE} cascade`);
  }
});

// ---------------------------------------------------------------------------
// M6-PG-P5: effective privilege, the delivery state machine and the attempt cap
// ---------------------------------------------------------------------------

/** A session of `role`'s own, on one connection of its own. */
function sessionAs(role) {
  const client = postgres(driverDsn(TARGET_DSN, role), { max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ssl: false, ...CLIENT_OPTS, user: role });
  extraClients.push(client);
  return client;
}

test('M6-PG-20: a direct grant is not effective reach — inheritance, nesting, SET ROLE, ownership, superuser status and schema USAGE each decide it', async () => {
  await ready();
  // Roles are cluster-wide and CI shares the cluster: a prefix of this run's own, so a run killed before its cleanup
  // leaves nothing a later run collides with.
  const P = `tmpos_m6p5_${randomBytes(4).toString('hex')}_`;
  const [{ me }] = await observer`select current_user::text as me`;
  const created = [];
  const role = async (name, ddl) => {
    await observer.unsafe(ddl).simple();
    created.push(P + name);
    return P + name;
  };
  // What each role reaches, as PostgreSQL itself decides it: schema USAGE, a table read, a table insert, the two kinds of
  // column update, a delete, the clock, the guard, the audit table's insert, and the lifecycle routines (every one of the
  // nine, reported as one bit: all or none).
  const reach = async (who) => {
    const [r] = await observer`select
      has_schema_privilege(${who}::name, 'tmpos_internal', 'USAGE') as usage,
      has_table_privilege(${who}::name, 'tmpos_internal.outbox_event', 'SELECT') as outbox_select,
      has_table_privilege(${who}::name, 'tmpos_internal.idempotency_record', 'INSERT') as record_insert,
      has_column_privilege(${who}::name, 'tmpos_internal.outbox_event', 'status', 'UPDATE') as status_update,
      has_column_privilege(${who}::name, 'tmpos_internal.outbox_event', 'payload', 'UPDATE') as payload_update,
      has_table_privilege(${who}::name, 'tmpos_internal.outbox_event', 'DELETE') as outbox_delete,
      has_function_privilege(${who}::name, 'tmpos_internal.m6_store_clock()', 'EXECUTE') as clock,
      has_function_privilege(${who}::name, 'tmpos_internal.outbox_event_transition_guard()', 'EXECUTE') as guard,
      has_table_privilege(${who}::name, 'public.audit_event', 'INSERT') as audit_insert,
      (select pg_catalog.array_agg(distinct has_function_privilege(${who}::name, p.oid, 'EXECUTE'))
         from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_internal'::regnamespace and p.proname = any (${ROUTINE_NAMES})) as routines`;
    assert.equal(r.routines.length, 1, `${who}: the nine routines are reached all together or not at all`);
    return ['usage', 'outbox_select', 'record_insert', 'status_update', 'payload_update', 'outbox_delete', 'clock', 'guard', 'audit_insert']
      .map((k) => (r[k] ? '1' : '0')).join('') + (r.routines[0] ? '1' : '0');
  };
  const sessions = [];
  /** A real call of the store's probe routine in `who`'s own session, after SET ROLE `as` when given. */
  const reads = async (who, as = null, statement = (s) => s`select tmpos_internal.m6_store_probe()`) => {
    const session = sessionAs(who);
    sessions.push(session);
    if (as !== null) {
      const switched = await refusal(() => session.unsafe(`set role ${as}`));
      if (switched.code !== null) return `SET ROLE refused ${switched.code}`;
    }
    return (await refusal(() => statement(session))).code ?? 'reached';
  };
  try {
    const plain = await role('plain', `create role ${P}plain login`);
    await role('mid', `create role ${P}mid nologin inherit; grant tmpos_app to ${P}mid`);
    const nested = await role('nested', `create role ${P}nested login inherit; grant ${P}mid to ${P}nested`);
    const noInherit = await role('noinherit', `create role ${P}noinherit login inherit; grant tmpos_app to ${P}noinherit with inherit false`);
    const noSet = await role('noset', `create role ${P}noset login inherit; grant tmpos_app to ${P}noset with inherit false, set false`);
    const tableOnly = await role('tableonly', `create role ${P}tableonly login;
      grant select on tmpos_internal.outbox_event to ${P}tableonly;
      grant execute on function tmpos_internal.m6_store_clock() to ${P}tableonly`);
    const usageOnly = await role('usageonly', `create role ${P}usageonly login; grant usage on schema tmpos_internal to ${P}usageonly`);
    const ownerMember = await role('ownermember', `create role ${P}ownermember login inherit; grant "${me}" to ${P}ownermember`);
    const superuser = await role('super', `create role ${P}super login superuser`);

    //                                    usage, read, insert, status, payload, delete, clock, guard, audit insert, routines
    assert.deepEqual(Object.fromEntries(await Promise.all([
      ['the runtime login (tmpos_app + tmpos_audit_writer, inherited)', STORE_PROBE],
      ['PUBLIC', 'public'], ['anon', 'anon'], ['authenticated', 'authenticated'],
      ['a role with no membership', plain],
      ['a login two inherited memberships from tmpos_app', nested],
      ['a membership WITH INHERIT FALSE', noInherit],
      ['a membership WITH INHERIT FALSE, SET FALSE', noSet],
      ['a direct table and function grant without schema USAGE', tableOnly],
      ['schema USAGE alone', usageOnly],
      ['a member of the owner', ownerMember],
      ['a superuser', superuser],
      ['the owner', me],
    ].map(async ([label, who]) => [label, await reach(who)]))), {
      'the runtime login (tmpos_app + tmpos_audit_writer, inherited)': '1000000011',
      PUBLIC: '0000000000', anon: '0000000000', authenticated: '0000000000',
      'a role with no membership': '0000000000',
      'a login two inherited memberships from tmpos_app': '1000000001',
      'a membership WITH INHERIT FALSE': '0000000000',
      'a membership WITH INHERIT FALSE, SET FALSE': '0000000000',
      'a direct table and function grant without schema USAGE': '0100001000',
      'schema USAGE alone': '1000000000',
      'a member of the owner': '1111111111',
      'a superuser': '1111111111',
      'the owner': '1111111111',
    }, 'effective privilege follows membership, inheritance and ownership — never the direct grants alone');

    // And in real sessions, where the difference shows.
    const tableRead = (s) => s`select count(*) from tmpos_internal.outbox_event`;
    assert.equal(await reads(STORE_PROBE), 'reached', 'the runtime login executes the routines through its inherited tmpos_app');
    assert.equal(await reads(STORE_PROBE, null, tableRead), '42501', 'and reads no table');
    assert.equal(await reads(nested), 'reached', 'so does a login two inherited memberships away, with no grant of its own');
    assert.equal(await reads(plain), '42501', 'a login with no membership is refused');
    assert.equal(await reads(noInherit), '42501', 'a membership WITH INHERIT FALSE reaches nothing by itself');
    assert.equal(await reads(noInherit, 'tmpos_app'), 'reached', '… until the session sets that role: reachable all along, through SET ROLE');
    assert.equal(await reads(noSet, 'tmpos_app'), 'SET ROLE refused 42501', 'with SET FALSE as well, SET ROLE is refused too');
    assert.equal(await reads(tableOnly, null, tableRead), '42501', 'a direct table grant without USAGE on the schema reaches nothing');
    assert.equal(await reads(tableOnly, null, (s) => s`select tmpos_internal.m6_store_clock()`), '42501', 'nor does a direct function grant');
    assert.equal(await reads(usageOnly), '42501', 'nor does USAGE on the schema without EXECUTE on a routine');
    assert.equal(await reads(ownerMember, null, tableRead), 'reached', 'a member of the owner reaches what the owner does, with no grant of its own');
    for (const nologin of ['anon', 'authenticated']) {
      const refused = await refusal(() => observer.begin(async (tx) => {
        await tx.unsafe(`set local role ${nologin}`);
        await tx`select tmpos_internal.m6_store_probe()`;
      }));
      assert.equal(refused.code, '42501', `${nologin}, as a session's role, is refused`);
    }
  } finally {
    for (const session of sessions) await session.end({ timeout: 5 }).catch(() => {});
    for (const [grantee, statement] of [
      [`${P}tableonly`, `revoke all on tmpos_internal.outbox_event from ${P}tableonly`],
      [`${P}tableonly`, `revoke all on function tmpos_internal.m6_store_clock() from ${P}tableonly`],
      [`${P}usageonly`, `revoke all on schema tmpos_internal from ${P}usageonly`],
    ]) if (created.includes(grantee)) await observer.unsafe(statement).catch(() => {});
    for (const r of [...created].reverse()) await observer.unsafe(`drop role if exists ${r}`).catch(() => {});
  }
  await assertStorePosture('after the privilege cases');
});

test('M6-PG-21: the table enforces the delivery state machine — on the owner\'s own SQL and through the adapter — and the runtime role\'s SQL reaches it only through the routines', async () => {
  await ready();
  await observer`delete from tmpos_internal.outbox_event`;
  const direct = sessionAs(STORE_PROBE);
  const [pending, claimed, delivered, dead] = await seed(4);
  const held = token();
  assert.equal((await claimOn(A, held, 4)).events.length, 4);
  assert.deepEqual(await A.delivery.retry({ eventId: pending, claim: held, delayMs: 60_000 }, live()), { outcome: 'scheduled' });
  assert.deepEqual(await A.delivery.acknowledge({ eventId: delivered, claim: held }, live()), { outcome: 'acknowledged' });
  assert.deepEqual(await A.delivery.deadLetter({ eventId: dead, claim: held, reason: 'envelope_invalid' }, live()), { outcome: 'dead_lettered' });
  const expiry = '2030-01-01T00:00:00Z';
  const states = () => observer`select event_id::text as id, status, attempt, claim_token from tmpos_internal.outbox_event order by 1`;
  const refused = async (label, statement) => {
    const before = await states();
    let failure = null;
    try {
      await statement();
    } catch (err) {
      failure = err;
    }
    assert.ok(failure !== null, `${label}: refused`);
    assert.deepEqual([failure.code, failure.message, failure.detail, failure.hint, failure.schema_name, failure.table_name, failure.constraint_name],
      ['23514', 'outbox event transition refused', undefined, undefined, undefined, undefined, undefined],
      `${label}: one fixed refusal — no detail, hint, relation or constraint field`);
    assert.ok(!Object.values(failure).some((v) => typeof v === 'string' && [pending, claimed, delivered, dead].some((id) => v.includes(id))),
      `${label}: no field carries a row value (PostgreSQL's CONTEXT names only the guard)`);
    assert.deepEqual(await states(), before, `${label}: nothing changed`);
  };
  // The owner is the one role that writes the table directly — the routines run as it — and the guard holds for it too.
  for (const [label, statement] of [
    ['a delivered event back to pending', () => observer`update tmpos_internal.outbox_event set status = 'pending' where event_id = ${delivered}`],
    ['a delivered event claimed again', () => observer`update tmpos_internal.outbox_event set status = 'claimed', attempt = attempt + 1, claim_token = ${token()},
      claim_expires_at = ${expiry} where event_id = ${delivered}`],
    ['a dead event back to pending', () => observer`update tmpos_internal.outbox_event set status = 'pending', dead_reason = null where event_id = ${dead}`],
    ['a dead event claimed again', () => observer`update tmpos_internal.outbox_event set status = 'claimed', attempt = attempt + 1, claim_token = ${token()},
      claim_expires_at = ${expiry}, dead_reason = null where event_id = ${dead}`],
    ['a delivered event touched at all', () => observer`update tmpos_internal.outbox_event set status = status where event_id = ${delivered}`],
    ['a pending event delivered unclaimed', () => observer`update tmpos_internal.outbox_event set status = 'delivered' where event_id = ${pending}`],
    ['a pending event dead-lettered unclaimed', () => observer`update tmpos_internal.outbox_event set status = 'dead', dead_reason = 'attempts_exhausted'
      where event_id = ${pending}`],
    ['a pending event rescheduled', () => observer`update tmpos_internal.outbox_event set due_at = due_at + interval '1 day' where event_id = ${pending}`],
    ['a claim that counts no attempt', () => observer`update tmpos_internal.outbox_event set status = 'claimed', claim_token = ${token()},
      claim_expires_at = ${expiry} where event_id = ${pending}`],
    ['a claim handed to another token without counting an attempt', () => observer`update tmpos_internal.outbox_event set claim_token = ${token()}
      where event_id = ${claimed}`],
    ['a retry that resets the attempt count', () => observer`update tmpos_internal.outbox_event set status = 'pending', claim_token = null,
      claim_expires_at = null, attempt = 0 where event_id = ${claimed}`],
    ['a delivery that rewrites the attempt count', () => observer`update tmpos_internal.outbox_event set status = 'delivered', claim_token = null,
      claim_expires_at = null, attempt = attempt + 5 where event_id = ${claimed}`],
    ['an event inserted already claimed', () => insertEvent({ ...baseEvent(), status: 'claimed', attempt: 1, claim_token: token(), claim_expires_at: expiry })],
    ['an event inserted with attempts already counted', () => insertEvent({ ...baseEvent(), attempt: 3 })],
    ['an event inserted delivered', () => insertEvent({ ...baseEvent(), status: 'delivered', attempt: 1 })],
    ['the owner, in a replica session, moving a delivered event back', () => observer.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update tmpos_internal.outbox_event set status = 'pending' where event_id = ${delivered}`;
    })],
    ['the owner rewriting a claimed event\'s envelope', () => observer`update tmpos_internal.outbox_event set payload = '{"forged":true}'::jsonb
      where event_id = ${claimed}`],
    ['an unexpired claim taken over, its attempt counted', () => observer`update tmpos_internal.outbox_event set claim_token = ${token()},
      attempt = attempt + 1 where event_id = ${claimed}`],
    ['a pending event claimed before it is due', () => observer`update tmpos_internal.outbox_event set status = 'claimed', attempt = attempt + 1,
      claim_token = ${token()}, claim_expires_at = ${expiry} where event_id = ${pending}`],
  ]) await refused(label, statement);

  // The delivery transitions themselves stay open — once their time has come, and a reclaim only under a new token.
  await advance(30_000); // the claims taken above have expired; the retried event is still not due
  await refused('an expired claim reclaimed under its own token', () => observer`update tmpos_internal.outbox_event set attempt = attempt + 1
    where event_id = ${claimed}`);
  const moved = async (label, statement) => assert.equal((await statement()).count, 1, `${label}: allowed`);
  await moved('an expired claim reclaimed under a new token, its attempt counted', () => observer`update tmpos_internal.outbox_event
    set claim_token = ${token()}, attempt = attempt + 1 where event_id = ${claimed}`);
  await moved('a claimed event retried', () => observer`update tmpos_internal.outbox_event set status = 'pending', claim_token = null, claim_expires_at = null
    where event_id = ${claimed}`);
  await moved('a due pending event claimed, its attempt counted', () => observer`update tmpos_internal.outbox_event set status = 'claimed', attempt = attempt + 1,
    claim_token = ${token()}, claim_expires_at = ${expiry} where event_id = ${claimed}`);
  await moved('a claimed event delivered', () => observer`update tmpos_internal.outbox_event set status = 'delivered', claim_token = null, claim_expires_at = null
    where event_id = ${claimed}`);
  const fresh = { ...baseEvent(), due_at: '2020-01-01T00:00:00Z' };
  await moved('an event inserted pending, never attempted', () => insertEvent(fresh));
  await moved('and claimed', () => observer`update tmpos_internal.outbox_event set status = 'claimed', attempt = attempt + 1, claim_token = ${token()},
    claim_expires_at = ${expiry} where event_id = ${fresh.event_id}`);
  await moved('a claimed event dead-lettered', () => observer`update tmpos_internal.outbox_event set status = 'dead', claim_token = null, claim_expires_at = null,
    dead_reason = 'attempts_exhausted' where event_id = ${fresh.event_id}`);

  // The runtime role's own SQL reaches none of it: not a transition the guard would allow, not one it would refuse.
  for (const [label, statement] of [
    ['an allowed-shaped retry', () => direct`update tmpos_internal.outbox_event set status = 'pending', claim_token = null, claim_expires_at = null
      where event_id = ${fresh.event_id}`],
    ['a delivered event revived', () => direct`update tmpos_internal.outbox_event set status = 'pending' where event_id = ${delivered}`],
    ['an event inserted pending', () => insertEvent({ ...baseEvent(), due_at: '2020-01-01T00:00:00Z' }, direct)],
  ]) {
    const before = await states();
    assert.equal((await refusal(statement)).code, '42501', `the runtime role: ${label} — refused before the guard is reached`);
    assert.deepEqual(await states(), before, `the runtime role: ${label} — nothing changed`);
  }

  // A mutator is trusted source and runs as the runtime role: one that tried to revive a delivered event commits nothing.
  const reviving = Object.freeze({
    ...MUTATORS[0],
    apply: async (sql, m) => {
      await sql`update tmpos_internal.outbox_event set status = 'pending' where event_id = ${delivered}`;
      return MUTATORS[0].apply(sql, m);
    },
  });
  const rogueClient = storeClient(1);
  extraClients.push(rogueClient);
  const command = creating(await begin(A));
  assert.deepEqual(await createPostgresTransactionalStore({ client: rogueClient, mutators: [reviving] }).transactions.commit(command, live()), UNAVAILABLE,
    'the refused statement is a failed statement to the adapter: it answers unavailable');
  assert.deepEqual(await footprint(command), NOTHING, 'and nothing of the command committed');
  assert.equal((await rowOf(delivered)).status, 'delivered', 'the delivered event is still delivered');
});

test('M6-PG-22: an event is claimed at most 20 times — then dead-lettered, never republished, and no caller can raise the cap', async () => {
  await ready();
  const cap = OUTBOX_DELIVERY_POLICY.maxAttempts;
  assert.equal(cap, 20, 'the fixed delivery policy');

  // 1. Through the delivery pass itself: a publisher that never succeeds is handed the event exactly 20 times.
  await observer`delete from tmpos_internal.outbox_event`;
  const [failing] = await seed(1);
  const delivery = createOutboxDelivery({ store: A.delivery, events: TEST_EVENTS });
  const published = [];
  const refuse = (envelope) => {
    published.push(envelope.eventId);
    return false;
  };
  for (let attempt = 1; attempt <= cap; attempt++) {
    const report = await deliverOutboxBatch(delivery, refuse);
    assert.deepEqual([report.claimed, report.retried, report.deadLettered], [1, attempt < cap ? 1 : 0, attempt < cap ? 0 : 1], `pass ${attempt}`);
    if (attempt < cap) await advance(retryDelayMs(attempt));
  }
  assert.deepEqual([published.length, new Set(published).size], [cap, 1], 'published 20 times, always the same event');
  const done = await rowOf(failing);
  assert.deepEqual([done.status, done.attempt, done.dead_reason], ['dead', cap, 'attempts_exhausted'], 'then dead-lettered as exhausted');
  await advance(86_400_000);
  assert.deepEqual(await deliverOutboxBatch(delivery, refuse), { claimed: 0, acknowledged: 0, retried: 0, deadLettered: 0, lost: 0, unsettled: 0 },
    'and never handed out again');
  assert.equal(published.length, cap);

  // 2. Claims that keep expiring — a worker that dies every time: the 20th expires, and the next claim dead-letters the
  //    event instead of handing it out a 21st time, whatever the request carries.
  await observer`delete from tmpos_internal.outbox_event`;
  const [expiring] = await seed(1);
  for (let attempt = 1; attempt <= cap; attempt++) {
    assert.deepEqual((await claimOn(A, token(), 32)).events.map((e) => [e.eventId, e.attempt]), [[expiring, attempt]], `claim ${attempt}`);
    await advance(30_000);
  }
  assert.deepEqual(await A.delivery.claim({ claim: token(), limit: 32, claimMs: 30_000, maxAttempts: 1_000 }, live()), EMPTY,
    'no 21st claim, not even for a request that asks for more attempts');
  const [{ args }] = await observer`select pg_catalog.pg_get_function_identity_arguments('tmpos_internal.m6_outbox_claim(text, integer, bigint)'::regprocedure) as args`;
  assert.equal(args, 'p_token text, p_limit integer, p_claim_ms bigint', 'the claim routine takes a token, a limit and a duration — no cap to raise');
  const spent = await rowOf(expiring);
  assert.deepEqual([spent.status, spent.attempt, spent.dead_reason, spent.claim_token], ['dead', cap, 'attempts_exhausted', null],
    'the claim dead-lettered it, unpublished');

  // 3. A retry at the cap changes nothing; the holder still settles the event it holds.
  await observer`delete from tmpos_internal.outbox_event`;
  const [last] = await seed(1);
  let held = null;
  for (let attempt = 1; attempt <= cap; attempt++) {
    held = token();
    assert.deepEqual((await claimOn(A, held, 32)).events.map((e) => [e.eventId, e.attempt]), [[last, attempt]]);
    if (attempt < cap) {
      assert.deepEqual(await A.delivery.retry({ eventId: last, claim: held, delayMs: 1 }, live()), { outcome: 'scheduled' });
      await advance(1);
    }
  }
  const before = await rowOf(last);
  assert.deepEqual(await A.delivery.retry({ eventId: last, claim: held, delayMs: 1 }, live()), UNAVAILABLE, 'a retry at the cap is refused');
  assert.deepEqual(await rowOf(last), before, 'and changes nothing');
  assert.deepEqual(await A.delivery.deadLetter({ eventId: last, claim: held, reason: 'attempts_exhausted' }, live()), { outcome: 'dead_lettered' },
    'the holder dead-letters it');
});

test('M6-PG-29: through the runtime role\'s own SQL, the routines change a record only under its lease and an event only under its claim token — on the store\'s clock, within their bounds, telling a stale caller nothing', async () => {
  await ready();
  await observer`delete from tmpos_internal.outbox_event`;
  const direct = sessionAs(STORE_PROBE);
  const recordOf = async (scope) => (await observer`select fingerprint, lease, response,
      (extract(epoch from lease_expires_at) * 1000)::bigint::text as lease_expires, (extract(epoch from expires_at) * 1000)::bigint::text as expires
    from tmpos_internal.idempotency_record where scope = ${scope}`)[0];
  const acquire = async (scope, fingerprint, held, leaseMs = 60_000, retentionMs = 600_000) => (await direct`select o_outcome as outcome, o_response as response
    from tmpos_internal.m6_idempotency_acquire(${scope}::text, ${fingerprint}::text, ${held}::text, ${String(leaseMs)}::bigint, ${String(retentionMs)}::bigint)`)[0];
  const complete = async (scope, held, response) =>
    (await direct`select tmpos_internal.m6_idempotency_complete(${scope}::text, ${held}::text, ${response}::text) as outcome`)[0].outcome;
  const fence = async (scope, held) => (await direct`select tmpos_internal.m6_command_fence(${scope}::text, ${held}::text) as held`)[0].held;
  const enqueue = async (scope, held, eventId) => (await direct`select tmpos_internal.m6_command_enqueue(${scope}::text, ${held}::text, ${eventId}::uuid,
    'conformance.item.created'::text, 1::integer, 'item'::text, ${randomUUID()}::uuid, 1::bigint, null::text, null::text, null::text, ${randomUUID()}::uuid,
    '{"name":"n","quantity":1}'::jsonb) as inserted`)[0].inserted;

  // 1. Creation: one open record, its terms from the store's clock.
  const [scope, fingerprint, mine] = [token(), token(), token()];
  const t0 = await frozenNowMs();
  assert.deepEqual(await acquire(scope, fingerprint, mine), { outcome: 'acquired', response: null });
  const open = await recordOf(scope);
  assert.deepEqual(open, { fingerprint, lease: mine, response: null, lease_expires: String(t0 + 60_000), expires: String(t0 + 600_000) },
    'lease and retention measured from the store clock');
  // 2. A live lease is never replaced, a fingerprint stays in conflict, a foreign lease completes and fences nothing — and none
  //    of those answers carries anything of the record.
  assert.deepEqual(await acquire(scope, fingerprint, token()), { outcome: 'in_progress', response: null });
  assert.deepEqual(await acquire(scope, token(), token(), 1, 1), { outcome: 'conflict', response: null });
  assert.equal(await complete(scope, token(), 'AAAA'), 'lease_lost');
  assert.equal(await complete(token(), mine, 'AAAA'), 'lease_lost', 'no record: the same answer as a foreign lease');
  assert.equal(await fence(scope, token()), false);
  assert.deepEqual(await recordOf(scope), open, 'no refusal changed the record: its lease, terms and response are as recorded');
  // 3. Only the current lease completes, and only once.
  assert.equal(await fence(scope, mine), true);
  assert.equal(await complete(scope, mine, 'AAAA'), 'completed');
  const done = await recordOf(scope);
  assert.equal(await complete(scope, mine, 'BBBB'), 'lease_lost', 'a completed response is never replaced, even by its holder');
  assert.equal(await fence(scope, mine), false, 'nor fenced for another commit');
  // 4. Within its retention a completed record is never reopened, re-leased or shortened: a replay to its own fingerprint, a
  //    conflict to any other — up to the last millisecond, and absent at the boundary, as the port contract says.
  await advance(599_999);
  assert.deepEqual(await acquire(scope, fingerprint, token()), { outcome: 'replay', response: 'AAAA' });
  assert.deepEqual(await acquire(scope, token(), token()), { outcome: 'conflict', response: null });
  assert.deepEqual(await recordOf(scope), done, 'unchanged by either');
  await advance(1);
  assert.deepEqual(await acquire(scope, fingerprint, token()), { outcome: 'acquired', response: null }, 'past its retention: a new operation');
  // 5. An expired lease is reclaimed under the caller's lease, and the lease it replaced is fenced out of everything.
  const [s2, f2, old, fresh] = [token(), token(), token(), token()];
  assert.equal((await acquire(s2, f2, old, 1_000, 10_000)).outcome, 'acquired');
  await advance(1_000);
  assert.deepEqual(await acquire(s2, f2, fresh, 1_000, 10_000), { outcome: 'reclaimed', response: null });
  assert.deepEqual([await complete(s2, old, 'AAAA'), await fence(s2, old)], ['lease_lost', false], 'the replaced lease completes and fences nothing');
  assert.equal((await refusal(() => enqueue(s2, old, randomUUID()))).code, '55000', 'nor enqueues an event');
  const eventId = randomUUID();
  assert.equal(await enqueue(s2, fresh, eventId), true, 'the current lease enqueues');
  assert.equal(await enqueue(s2, fresh, eventId), false, 'an event ID that is not new is not inserted again');
  const [queued] = await observer`select status, attempt, (extract(epoch from due_at) * 1000)::bigint::text as due
    from tmpos_internal.outbox_event where event_id = ${eventId}`;
  assert.deepEqual(queued, { status: 'pending', attempt: 0, due: String(await frozenNowMs()) }, 'pending, never attempted, due now by the store clock');
  await observer`delete from tmpos_internal.outbox_event where event_id = ${eventId}`;

  // 6. Every malformed argument is refused before a row is read.
  const uuid = randomUUID();
  for (const [label, call] of [
    ['a lease of 0 ms', () => acquire(token(), token(), token(), 0, 600_000)],
    ['a lease past 24 h', () => acquire(token(), token(), token(), 86_400_001, 604_800_000)],
    ['a retention shorter than its lease', () => acquire(token(), token(), token(), 60_000, 59_999)],
    ['a retention past 7 days', () => acquire(token(), token(), token(), 60_000, 604_800_001)],
    ['a malformed scope', () => acquire('short', token(), token())],
    ['a null lease', () => acquire(token(), token(), null)],
    ['an empty response', () => complete(token(), token(), '')],
    ['a response past MAX_SEALED_LENGTH', () => complete(token(), token(), 'A'.repeat(MAX_SEALED_LENGTH + 1))],
    ['a response outside base64url', () => complete(token(), token(), 'AA=A')],
    ['a fence under a malformed lease', () => fence(token(), 'x')],
    ['a claim of 0 events', () => direct`select * from tmpos_internal.m6_outbox_claim(${token()}::text, 0::integer, 30000::bigint)`],
    ['a claim of 33 events', () => direct`select * from tmpos_internal.m6_outbox_claim(${token()}::text, 33::integer, 30000::bigint)`],
    ['a claim of 0 ms', () => direct`select * from tmpos_internal.m6_outbox_claim(${token()}::text, 1::integer, 0::bigint)`],
    ['a claim past 1 h', () => direct`select * from tmpos_internal.m6_outbox_claim(${token()}::text, 1::integer, 3600001::bigint)`],
    ['a malformed claim token', () => direct`select * from tmpos_internal.m6_outbox_claim('short'::text, 1::integer, 30000::bigint)`],
    ['a retry of 0 ms', () => direct`select tmpos_internal.m6_outbox_retry(${uuid}::uuid, ${token()}::text, 0::bigint)`],
    ['a retry past 15 min', () => direct`select tmpos_internal.m6_outbox_retry(${uuid}::uuid, ${token()}::text, 900001::bigint)`],
    ['an unknown dead-letter reason', () => direct`select tmpos_internal.m6_outbox_dead_letter(${uuid}::uuid, ${token()}::text, 'other'::text)`],
    ['an acknowledgement of no event', () => direct`select tmpos_internal.m6_outbox_acknowledge(null::uuid, ${token()}::text)`],
  ]) assert.equal((await refusal(call)).code, '22023', `${label} is refused as a malformed argument`);
  // … and every bound itself is accepted.
  assert.equal((await acquire(token(), token(), token(), 86_400_000, 604_800_000)).outcome, 'acquired', 'a lease of exactly 24 h, a retention of exactly 7 days');
  assert.equal((await acquire(token(), token(), token(), 1, 1)).outcome, 'acquired', 'a lease and a retention of 1 ms');
  assert.deepEqual([...await direct`select o_spent as spent from tmpos_internal.m6_outbox_claim(${token()}::text, 32::integer, 3600000::bigint)`], [{ spent: 0 }],
    'a claim of 32 events for exactly 1 h');

  // 7. Claims: on the store's clock, never before expiry, never under the token that held the claim; settlement only under the
  //    current token, whatever a stale or foreign caller presents — and a settled event is settled for good.
  const claim = async (held) => (await direct`select o_event_id::text as event_id, o_attempt as attempt
    from tmpos_internal.m6_outbox_claim(${held}::text, 32::integer, 30000::bigint)`).filter((r) => r.event_id !== null);
  const settle = async (event, held) => [
    (await direct`select tmpos_internal.m6_outbox_acknowledge(${event}::uuid, ${held}::text) as o`)[0].o,
    (await direct`select tmpos_internal.m6_outbox_retry(${event}::uuid, ${held}::text, 1000::bigint) as o`)[0].o,
    (await direct`select tmpos_internal.m6_outbox_dead_letter(${event}::uuid, ${held}::text, 'envelope_invalid'::text) as o`)[0].o,
  ];
  const [seeded] = await seed(1);
  const first = token();
  const t1 = await frozenNowMs();
  assert.deepEqual(await claim(first), [{ event_id: seeded, attempt: 1 }]);
  const heldRow = await rowOf(seeded);
  assert.deepEqual([heldRow.status, heldRow.claim_token, heldRow.claim_expires], ['claimed', first, String(t1 + 30_000)], 'held until the store clock says');
  assert.deepEqual(await claim(token()), [], 'no reclaim before the claim expires');
  assert.deepEqual(await settle(seeded, token()), ['claim_lost', 'claim_lost', 'claim_lost'], 'a foreign token settles and releases nothing');
  assert.deepEqual(await settle(randomUUID(), first), ['claim_lost', 'claim_lost', 'claim_lost'], 'no such event: the same answer');
  assert.deepEqual(await rowOf(seeded), heldRow, 'and nothing changed');
  await advance(30_000);
  assert.deepEqual(await claim(first), [], 'an expired claim is never reclaimed under the token that held it');
  const second = token();
  assert.deepEqual(await claim(second), [{ event_id: seeded, attempt: 2 }], 'a new token reclaims it, the attempt counted');
  const reclaimed = await rowOf(seeded);
  assert.deepEqual(await settle(seeded, first), ['claim_lost', 'claim_lost', 'claim_lost'], 'the stale token is fenced out of every settlement');
  assert.deepEqual(await rowOf(seeded), reclaimed, 'and changed nothing');
  assert.equal((await direct`select tmpos_internal.m6_outbox_acknowledge(${seeded}::uuid, ${second}::text) as o`)[0].o, 'acknowledged');
  assert.deepEqual(await settle(seeded, second), ['claim_lost', 'claim_lost', 'claim_lost'], 'a delivered event is settled for good');
  await advance(1_000_000);
  assert.deepEqual(await claim(token()), [], 'and never claimed again');
  assert.equal((await rowOf(seeded)).status, 'delivered');

  // 8. A member of the runtime role that may create temporary objects plants exact-match operators in pg_temp for the
  //    operators the routines use (bigint * interval, timestamptz >= timestamptz). They work when named — and no routine,
  //    running as its owner, ever resolves to them: PostgreSQL never looks for a function or an operator in pg_temp.
  const P = `tmpos_m6p6_${randomBytes(4).toString('hex')}_`;
  const temp = `${P}temp`;
  await observer.unsafe(`create role ${temp} login inherit; grant tmpos_app to ${temp}; grant temporary on database "${DATABASE}" to ${temp}`);
  const planter = sessionAs(temp);
  try {
    await planter.unsafe(`create function pg_temp.planted_mul(bigint, interval) returns interval language plpgsql as $$ begin raise exception 'M6-PLANTED'; end $$;
      create operator pg_temp.* (function = pg_temp.planted_mul, leftarg = bigint, rightarg = interval);
      create function pg_temp.planted_ge(timestamptz, timestamptz) returns boolean language plpgsql as $$ begin raise exception 'M6-PLANTED'; end $$;
      create operator pg_temp.>= (function = pg_temp.planted_ge, leftarg = timestamptz, rightarg = timestamptz)`).simple();
    assert.equal((await refusal(() => planter.unsafe(`select 1::bigint operator(pg_temp.*) interval '1 ms'`))).code, 'P0001', 'control: the planted operator runs when named');
    const [ps, pf, pl] = [token(), token(), token()];
    assert.deepEqual((await planter`select o_outcome as outcome from tmpos_internal.m6_idempotency_acquire(${ps}::text, ${pf}::text, ${pl}::text,
      60000::bigint, 600000::bigint)`)[0], { outcome: 'acquired' }, 'the acquisition resolved pg_catalog\'s operators, not the planted ones');
    assert.equal((await planter`select tmpos_internal.m6_idempotency_complete(${ps}::text, ${pl}::text, 'AAAA'::text) as o`)[0].o, 'completed');
    assert.deepEqual([...await planter`select o_spent as spent from tmpos_internal.m6_outbox_claim(${token()}::text, 1::integer, 30000::bigint)`], [{ spent: 0 }]);
  } finally {
    await planter.end({ timeout: 5 }).catch(() => {});
    await observer.unsafe(`revoke temporary on database "${DATABASE}" from ${temp}; drop role if exists ${temp}`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// the pinned driver's connection-loss defects and notices, each in a process of its own (doc 08, DA-15, DA-17)
// ---------------------------------------------------------------------------

const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const DEFECT_CHILD = fileURLToPath(new URL('./pgDriverDefects.child.mjs', import.meta.url));
const DEFECT_TARGETS = JSON.stringify({
  owner: { dsn: driverDsn(TARGET_DSN), options: CLIENT_OPTS },
  store: { dsn: driverDsn(TARGET_DSN, STORE_PROBE), options: { ...CLIENT_OPTS, user: STORE_PROBE } },
});
const WRITE_AFTER_CLOSE = "Cannot read properties of null (reading 'write')";

/** One scenario of the defect child: its exit code, its RESULT, and everything it printed. */
function inChild(scenario) {
  return new Promise((done, fail) => {
    const child = spawn(TSX, [DEFECT_CHILD, scenario], { env: { ...process.env, M6_DEFECT_TARGETS: DEFECT_TARGETS }, stdio: ['ignore', 'pipe', 'pipe'] });
    let printed = '';
    child.stdout.on('data', (chunk) => { printed += chunk; });
    child.stderr.on('data', (chunk) => { printed += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = printed.split('\n').find((l) => l.startsWith('RESULT '));
      done({ code, result: line === undefined ? null : JSON.parse(line.slice('RESULT '.length)), printed });
    });
  });
}

test('M6-PG-24: the pinned driver still has both connection-loss defects — a write after close ends the process, and a close in the same turn as a write leaves a slot that never reconnects', async () => {
  // A witness, not a wish: should a driver change make either assertion fail, DA-15's containment is re-read, never
  // assumed away.
  const crashed = await inChild('write-after-close');
  assert.notEqual(crashed.code, 0, 'defect 1: the ROLLBACK the driver wrote to the closed socket ended the process');
  assert.equal(crashed.result, null);
  assert.ok(crashed.printed.includes(WRITE_AFTER_CLOSE), 'defect 1: it died of the write to a null socket');
  const poisoned = await inChild('poisoned-slot');
  assert.equal(poisoned.code, 0);
  assert.deepEqual(poisoned.result.rounds.map((r) => r.code), ['CONNECT_TIMEOUT', 'CONNECT_TIMEOUT'], 'defect 2: every later use of the slot waits out connect_timeout');
  assert.ok(poisoned.result.endMs < 3_000, 'ending that pool is still bounded');
});

test('M6-PG-25: a connection lost under a command — mid-statement, or while its mutator waits, then runs a statement, refuses or completes — answers unavailable, writes nothing more, and the process lives', async () => {
  for (const kind of ['mid-statement', 'gap-statement', 'gap-refusal', 'gap-completion']) {
    const run = await inChild(kind);
    assert.equal(run.code, 0, `${kind}: the process survived`);
    assert.deepEqual(run.result, { kind, acquired: 'acquired', answer: 'unavailable', sleepReturned: false },
      `${kind}: failed closed, before COMMIT — and mid-statement, the statement itself was cut`);
    assert.ok(!run.printed.includes(WRITE_AFTER_CLOSE), `${kind}: nothing was written to the closed socket`);
  }
});

test('M6-PG-26: the supervised client discards a poisoned pool — the call that met it fails once, unretried; the next opens a fresh pool within its deadline; end is bounded', async () => {
  const run = await inChild('supervised');
  assert.equal(run.code, 0);
  const r = run.result;
  assert.deepEqual([r.first, r.lost, r.next, r.pools], ['acquired', 'unavailable', 'acquired', 2], 'the poisoned pool failed one call and was replaced');
  assert.ok(r.nextMs < r.deadlineMs, 'the next call answered within its deadline');
  assert.ok(r.endMs < (RETIRED_POOL_GRACE_S + 2) * 1_000, 'end waited for the retired pool, within its bound');
});

test('M6-PG-27: a server NOTICE through the runtime\'s own client options reaches no output; the driver\'s default would print it', async () => {
  const run = await inChild('notices');
  assert.equal(run.code, 0);
  assert.ok(run.printed.includes('M6-NOTICE-CANARY-DEFAULT'), 'control: the driver\'s default handler prints a notice, and this capture sees it');
  for (const canary of ['M6-NOTICE-CANARY-RUNTIME', 'M6-NOTICE-CANARY-DETAIL']) {
    assert.ok(!run.printed.includes(canary), `the runtime's handler prints nothing of it: ${canary}`);
  }
});
