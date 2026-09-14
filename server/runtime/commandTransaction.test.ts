// Phase 4.0 M6 — the atomic command transaction: plan validation, strict commit answers, command contracts,
// the audit mapping, the conformance suite with positive controls, and the chain over real loopback sockets.
//
// Synthetic contracts, principals, keys and stores only. The socket half drives createApp with synthetic
// command routes (never in the production table) and records exactly what crosses the transaction port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { validateAuditEventInput } from '../platform-identity/auditEventWriter.js';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import type { AppDeps } from './app.js';
import { COMMAND_TRANSACTION_DEADLINE_MS, commitCommand, createCommandTransactions, defineCommands, prepareCommand } from './commandTransaction.js';
import type { CommandContract, CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import { IDEMPOTENCY_POLICY, createIdempotencyKeyring } from './idempotency.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { defineOutboxEvents } from './outbox.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError } from './routes.js';
import type { CommandContext, CommandPlan, CommandPlanner, RouteDefinition } from './routes.js';
import {
  TEST_CREATE, TEST_EVENTS, TEST_RENAME, assertCommandTransactionContract, createMemoryCommandTransaction, createMemoryTransactionalHarness,
  createMemoryTransactionalState, inspectMemoryState, testTransactions,
} from './transactionalOutbox.testkit.js';
import type { MemoryTransactionalState, TransactionalOutboxHarness } from './transactionalOutbox.testkit.js';

const T0 = 1_700_000_000_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMITTED = { outcome: 'committed' };
const LEASE_LOST = { outcome: 'lease_lost' };
const CONFLICT = { outcome: 'conflict' };
const UNAVAILABLE = { outcome: 'unavailable' };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- plans, commands and contracts ------------------------------------------------------------------

const events = defineOutboxEvents(TEST_EVENTS);
const commands = defineCommands([TEST_CREATE, TEST_RENAME], events);
const create = commands.contract(TEST_CREATE.kind) as CommandContract;
const rename = commands.contract(TEST_RENAME.kind) as CommandContract;
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
const op = keyring.operationOf(randomUUID(), { authProvider: 'synthetic', authProviderUid: 'uid-a' }, {
  method: 'POST', path: '/v1/items', audience: null, tenant: null, store: null, body: Buffer.from('{}'),
});
const binding = (newAggregateId = randomUUID()) => ({
  scope: op.scope, lease: 'l'.repeat(43), newAggregateId, authorization: Object.freeze({ scope: 'platform' as const, permission: 'items.write' }),
  seal: (e: Parameters<typeof keyring.seal>[0]) => keyring.seal(e, op),
});
const createPlan = (id: string) => ({
  aggregateId: id, expectedVersion: null, changes: { name: 'n', quantity: 1 }, events: [{ type: 'conformance.item.created', payload: { name: 'n', quantity: 1 } }],
  response: { status: 201, body: { id } },
});
const commandOf = (): TransactionCommand => {
  const b = binding();
  return (prepareCommand(create, events, createPlan(b.newAggregateId), b) as NonNullable<ReturnType<typeof prepareCommand>>).command;
};

test('a plan becomes one command: runtime-generated identities, null scope and actor slots, and a sealed success response', () => {
  const b = binding();
  const prepared = prepareCommand(create, events, createPlan(b.newAggregateId), b);
  assert.ok(prepared);
  const { command } = prepared;
  assert.deepEqual(Object.keys(command).sort(), ['audit', 'events', 'lease', 'mutation', 'response', 'scope'], 'values only: no SQL, relation or raw request');
  assert.deepEqual(command.mutation, { kind: 'conformance.item.create', aggregateType: 'item', aggregateId: b.newAggregateId, expectedVersion: null, changes: { name: 'n', quantity: 1 } });
  assert.match(command.audit.correlationId, UUID_V4);
  assert.deepEqual(command.audit, { action: 'conformance.item.create', permission: 'items.write', scope: 'platform', tenant: null, store: null, actor: null, correlationId: command.audit.correlationId });
  const [event] = command.events;
  assert.match(event.eventId, UUID_V4);
  assert.deepEqual(event, {
    eventId: event.eventId, type: 'conformance.item.created', version: 1, aggregateType: 'item', aggregateId: b.newAggregateId, aggregateVersion: 1,
    tenant: null, store: null, actor: null, correlationId: command.audit.correlationId, payload: { name: 'n', quantity: 1 },
  });
  assert.deepEqual(keyring.unseal(command.response, op), prepared.response, 'the completion is the response, sealed for this operation');
  assert.ok(Object.isFrozen(command) && Object.isFrozen(command.mutation) && Object.isFrozen(command.audit) && Object.isFrozen(command.events[0]));
  const again = prepareCommand(create, events, createPlan(b.newAggregateId), b);
  assert.ok(again && again.command.events[0].eventId !== event.eventId && again.command.audit.correlationId !== command.audit.correlationId, 'fresh IDs per preparation');
  const update = prepareCommand(rename, events, {
    aggregateId: randomUUID(), expectedVersion: 4, changes: { name: 'm' }, events: [{ type: 'conformance.item.renamed', payload: { name: 'm' } }], response: { status: 200, body: {} },
  }, binding());
  assert.equal(update?.command.events[0].aggregateVersion, 5, 'an update produces the next version');
});

test('a plan out of its contract is refused whole: identifiers, versions, fields, events, responses and thenables', () => {
  const b = binding();
  const good = createPlan(b.newAggregateId);
  const update = { ...good, aggregateId: randomUUID(), expectedVersion: 1, changes: { name: 'n' }, events: [] };
  const rejecting = Promise.reject(new Error('planner-rejection')); // observed by the refusal, never left unhandled
  for (const [label, plan, contract] of [
    ['a create naming its own ID', createPlan(randomUUID()), create], ['a create with a version', { ...good, expectedVersion: 1 }, create],
    ['an update without a version', { ...update, expectedVersion: null }, rename], ['an update of a non-canonical ID', { ...update, aggregateId: update.aggregateId.toUpperCase() }, rename],
    ['an update at version 0', { ...update, expectedVersion: 0 }, rename], ['an unsafe version', { ...update, expectedVersion: Number.MAX_SAFE_INTEGER }, rename],
    ['an SQL fragment', { ...good, sql: 'delete from item' }, create], ['a relation name', { ...good, table: 'audit_event' }, create], ['a kind of its own', { ...good, kind: 'x.y' }, create],
    ['a change out of schema', { ...good, changes: { name: 'n', quantity: 5_000 } }, create], ['an extra change', { ...good, changes: { name: 'n', quantity: 1, role: 'owner' } }, create],
    ['an event type the contract lacks', { ...good, events: [{ type: 'conformance.item.renamed', payload: { name: 'n' } }] }, create],
    ['one event twice', { ...good, events: [good.events[0], good.events[0]] }, create], ['a payload out of schema', { ...good, events: [{ type: 'conformance.item.created', payload: { name: 'n' } }] }, create],
    ['an event carrying its own ID', { ...good, events: [{ ...good.events[0], eventId: randomUUID() }] }, create],
    ['a rejection response', { ...good, response: { status: 409, body: {} } }, create], ['a failure response', { ...good, response: { status: 500, body: {} } }, create],
    ['a response setting a cookie', { ...good, response: { status: 201, body: {}, headers: { 'set-cookie': 'sid=1' } } }, create],
    ['a thenable', rejecting, create], ['null', null, create], ['an array', [good], create],
  ] as const) {
    assert.equal(prepareCommand(contract, events, plan, b), null, label);
  }
});

test('command contracts are closed at startup against the event contracts', () => {
  assert.equal(commands.list().length, 2);
  const base = { kind: 'x.create', mode: 'create', aggregateType: 'item', changes: {}, events: [{ type: 'conformance.item.created', version: 1 }] };
  for (const [label, defs] of [
    ['an unregistered event', [{ ...base, events: [{ type: 'conformance.item.deleted', version: 1 }] }]], ['an event of another aggregate', [{ ...base, aggregateType: 'order' }]],
    ['one event twice', [{ ...base, events: [...base.events, ...base.events] }]], ['a mode it cannot have', [{ ...base, mode: 'upsert' }]],
    ['a kind outside the grammar', [{ ...base, kind: 'Create' }]], ['a secret-named change', [{ ...base, changes: { password: { type: 'string', maxLength: 8 } } }]],
    ['one kind twice', [base, base]], ['an extra key', [{ ...base, table: 'item' }]], ['not an array', base],
  ] as const) {
    assert.throws(() => defineCommands(defs, events), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'command_registry_invalid', label);
  }
  assert.equal(defineCommands([{ ...base, events: [] }], events).list().length, 1, 'a command may enqueue no event');
});

test('only an exact commit answer is obeyed; everything else is refused for what it is, never read as a rollback', async () => {
  const command = commandOf();
  const verdictOf = (answer: (c: TransactionCommand, s: AbortSignal) => unknown, deadlineMs = 1_000): Promise<unknown> =>
    commitCommand(createCommandTransactions({ port: { commit: answer, probe: () => true } }), command, deadlineMs);
  assert.equal(await verdictOf(() => COMMITTED), null);
  assert.equal(await verdictOf(async () => COMMITTED), null);
  assert.equal(await verdictOf(() => LEASE_LOST), 'transaction_lease_lost');
  assert.equal(await verdictOf(() => CONFLICT), 'transaction_conflict');
  assert.equal(await verdictOf(() => UNAVAILABLE), 'transaction_unavailable');
  assert.equal(await verdictOf(() => { throw new Error('store-secret-detail'); }), 'transaction_unavailable');
  assert.equal(await verdictOf(() => Promise.reject(new Error('x'))), 'transaction_unavailable');
  for (const [i, answer] of [
    { outcome: 'Committed' }, { outcome: 'committed', durable: false }, {}, { committed: true }, { outcome: 'replay' }, null, 'committed', true,
    Object.create({ outcome: 'committed' }), Object.assign([], { outcome: 'committed' }), new Proxy({}, { get: (_t, name) => { if (name === 'then') return undefined; throw new Error('hostile'); } }),
  ].entries()) {
    assert.equal(await verdictOf(() => answer), 'transaction_outcome_invalid', `out-of-contract answer #${i}`);
  }
  let signal: AbortSignal | undefined;
  const started = Date.now();
  assert.equal(await verdictOf((_c, s) => { signal = s; return new Promise(() => {}); }, 3_000), 'transaction_timeout');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= COMMAND_TRANSACTION_DEADLINE_MS - 100 && elapsed < 3_000, `bounded by COMMAND_TRANSACTION_DEADLINE_MS (${elapsed} ms)`);
  assert.ok(signal?.aborted, 'and told to cancel');
});

test('the transaction-local audit record maps onto a valid append-only audit event under the documented adapter mapping', () => {
  const { audit } = commandOf();
  // The PostgreSQL adapter's mapping onto the existing writer (docs/phase-4/10 ADR-17), written once, on the commit's transaction.
  assert.doesNotThrow(() => validateAuditEventInput({
    requestId: audit.correlationId, traceId: null, actorInternalUserId: audit.actor, actorAuthProvider: null, onBehalfOfInternalUserId: null,
    scopeType: audit.scope, tenantId: audit.tenant, storeId: audit.store, actionId: audit.action, requiredPermission: audit.permission, decision: 'allow',
    reasonCode: 'command_committed', humanReadableReason: 'The command committed.', resultStatus: 'succeeded', sourceOfTruth: 'command_transaction',
    evaluatedBy: 'runtime_command_transaction@v1', evidenceLevel: 'durable_compliance_event', metadata: {},
  }));
});

// --- conformance ------------------------------------------------------------------------------------

type TxDefect =
  | 'nonAtomic' | 'leaseBlind' | 'conflictBeforeLease' | 'versionBlind' | 'partialOnFailure' | 'dropsAudit' | 'dropsEvents' | 'noCompletion'
  | 'eventIdOverwrite' | 'strictLeaseExpiry' | 'skewedPeer' | 'ignoresAbort' | 'failsOpen' | 'probesOpen' | 'losesState' | 'queuesOutage' | 'staleTimestamp';

/**
 * An independent commit adapter — two instances, as over a remote store, with a network gap between its
 * checks and its writes — over the in-memory harness's state. With no defect it is in contract; each
 * defect breaks exactly one clause of the port contract.
 */
function transactionHarness(defect: TxDefect | null): TransactionalOutboxHarness {
  const base = createMemoryTransactionalHarness();
  const { state } = base;
  let broken = false;
  const queued: Array<() => void> = [];
  const frozenAt = state.now();
  const instance = (skew: number): CommandTransactionPort => {
    const now = (): number => state.now() + skew;
    const commitAt = async (command: TransactionCommand, t: number): Promise<unknown> => {
      const record = state.idempotency.records.get(command.scope);
      const leaseHeld = record !== undefined && t < record.expiresAt && record.response === null && (record.lease === command.lease || defect === 'leaseBlind')
        && !(defect === 'strictLeaseExpiry' && t >= record.leaseExpiresAt);
      const { mutation } = command;
      const key = `${mutation.aggregateType}/${mutation.aggregateId}`;
      const current = state.aggregates.get(key);
      const inVersion = defect === 'versionBlind' || (mutation.expectedVersion === null ? current === undefined : current?.version === mutation.expectedVersion);
      if (defect === 'conflictBeforeLease' && !inVersion) return CONFLICT;
      if (!leaseHeld) return LEASE_LOST;
      if (!inVersion) return CONFLICT;
      if (defect !== 'eventIdOverwrite' && command.events.some((e) => state.outbox.has(e.eventId))) return UNAVAILABLE;
      if (defect === 'nonAtomic') await new Promise((resolve) => setImmediate(resolve)); // the gap between the checks and the writes
      const fault = state.fault;
      state.fault = null;
      if (fault !== null && defect !== 'partialOnFailure') throw new Error('injected');
      state.aggregates.set(key, { version: (mutation.expectedVersion ?? 0) + 1, state: { ...(current?.state ?? {}), ...mutation.changes } });
      if (fault !== null) throw new Error('injected'); // partialOnFailure: the mutation already written
      if (defect !== 'dropsAudit') state.audit.push({ ...command.audit, at: defect === 'staleTimestamp' ? frozenAt : t });
      if (defect !== 'dropsEvents') {
        for (const e of command.events) {
          state.outbox.set(e.eventId, { envelope: { ...e, occurredAt: t }, status: 'pending', attempt: 0, dueAt: t, claim: null, claimExpiresAt: 0, reason: null });
        }
      }
      if (defect !== 'noCompletion' && record !== undefined) state.idempotency.records.set(command.scope, { ...record, response: command.response });
      return COMMITTED;
    };
    return {
      commit: async (command, signal) => {
        if (broken) {
          if (defect === 'queuesOutage') queued.push(() => { void commitAt(command, now()); });
          return defect === 'failsOpen' ? COMMITTED : UNAVAILABLE;
        }
        if (signal.aborted && defect !== 'ignoresAbort') return UNAVAILABLE;
        return commitAt(command, now());
      },
      probe: () => defect === 'probesOpen' || !broken,
    };
  };
  return {
    ...base,
    transaction: instance(0),
    transactionPeer: instance(defect === 'skewedPeer' ? 1_000 : 0),
    breakStore: () => { broken = true; base.breakStore(); },
    restoreStore: () => {
      broken = false;
      base.restoreStore();
      if (defect === 'losesState') { state.aggregates.clear(); state.audit.length = 0; state.outbox.clear(); }
      for (const run of queued.splice(0)) run();
    },
  };
}

test('the in-memory adapter meets the command-transaction contract every durable adapter must meet', async () => {
  await assertCommandTransactionContract(createMemoryTransactionalHarness());
});

test('the conformance suite passes a correct independent adapter and fails every broken one', async () => {
  await assertCommandTransactionContract(transactionHarness(null));
  const caught: Array<[TxDefect, RegExp]> = [
    ['nonAtomic', /exactly one commit under one lease/], ['leaseBlind', /a lease the store never granted commits nothing/],
    // A store that judges business state before the lease already answers a completed operation's re-commit with a conflict.
    ['conflictBeforeLease', /a completed operation accepts no second commit/], ['versionBlind', /creating an existing aggregate conflicts/],
    ['partialOnFailure', /leaves no part behind/], ['dropsAudit', /with exactly one audit record/], ['dropsEvents', /every event enqueued as sent/],
    ['noCompletion', /the completion replays byte for byte/], ['eventIdOverwrite', /a reused event ID is a fault/],
    ['strictLeaseExpiry', /an expired lease nobody reclaimed still commits/], ['skewedPeer', /on the peer too, until its retention ends/],
    ['ignoresAbort', /and changes nothing/], ['failsOpen', /an unreachable store commits nothing/], ['probesOpen', /never answers the probe with true/],
    ['losesState', /a committed operation survived the outage/], ['queuesOutage', /no commit attempted during the outage was queued/],
    ['staleTimestamp', /never a stale one/],
  ];
  for (const [defect, check] of caught) {
    await assert.rejects(assertCommandTransactionContract(transactionHarness(defect)), (err: unknown) => err instanceof assert.AssertionError && check.test(err.message), defect);
  }
});

// --- the chain over real loopback sockets -----------------------------------------------------------

const TRUSTED = 'http://pos.trusted.test';
const WRITE = { access: 'authenticated', authorization: { scope: 'platform', permission: 'items.write' } } as const;
const JSON_BODY = { kind: 'json', maxBytes: 1_024, required: false } as const;
const PRINCIPALS: Record<string, unknown> = { 'tok-alice': { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-alice' } };

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }
interface Send { key?: string | null; body?: string; path?: string; headers?: Record<string, string> }

function open(port: number, { key = null, body = '{"name":"first"}', path = '/v1/items', headers = {} }: Send = {}) {
  const sent: Record<string, string> = {
    origin: TRUSTED, [CSRF_HEADER]: CSRF_HEADER_VALUE, 'sec-fetch-site': 'same-origin', authorization: 'Bearer tok-alice',
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers,
  };
  if (key !== null) sent['idempotency-key'] = key;
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: sent, agent: false });
  const reply = new Promise<Reply>((resolve, reject) => {
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
  });
  req.end(body);
  return { req, reply };
}
const post = (port: number, send: Send = {}): Promise<Reply> => open(port, send).reply;
const errorOf = (reply: Reply): unknown => (JSON.parse(reply.body) as Record<string, unknown>).error;

const createPlanner: CommandPlanner = (ctx) => {
  const name = String((ctx.body as { name?: unknown } | undefined)?.name ?? 'unnamed');
  return {
    aggregateId: ctx.newAggregateId, expectedVersion: null, changes: { name, quantity: 1 }, events: [{ type: 'conformance.item.created', payload: { name, quantity: 1 } }],
    response: { status: 201, body: { id: ctx.newAggregateId }, headers: { location: `/v1/items/${ctx.newAggregateId}` } },
  };
};
const renamePlanner: CommandPlanner = (ctx) => {
  const body = ctx.body as { id: string; version: number; name: string };
  return {
    aggregateId: body.id, expectedVersion: body.version, changes: { name: body.name }, events: [{ type: 'conformance.item.renamed', payload: { name: body.name } }],
    response: { status: 200, body: { id: body.id, name: body.name } },
  };
};

interface Harness { port: number; logs: string[]; plans: CommandContext[]; commits: TransactionCommand[]; state: MemoryTransactionalState; clock: { t: number } }
interface Setup { plan?: CommandPlanner; port?: (inner: CommandTransactionPort) => CommandTransactionPort; deadlineMs?: number }

/** Serve synthetic command routes over one synthetic store, recording what crosses the port; always closes the server. */
async function withCommands(setup: Setup, fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const plans: CommandContext[] = [];
  const commits: TransactionCommand[] = [];
  const clock = { t: T0 };
  const state = createMemoryTransactionalState({ now: () => clock.t });
  const inner = createMemoryCommandTransaction(state);
  const base = setup.port === undefined ? inner : setup.port(inner);
  const port: CommandTransactionPort = { commit: (c, s) => { commits.push(c); return base.commit(c, s); }, probe: (s) => base.probe(s) };
  const planner = setup.plan ?? createPlanner;
  const routes: RouteDefinition[] = [
    { method: 'POST', path: '/v1/items', policy: WRITE, body: JSON_BODY, idempotency: 'required', command: { contract: TEST_CREATE, plan: (ctx) => { plans.push(ctx); return planner(ctx); } } },
    { method: 'POST', path: '/v1/items/rename', policy: WRITE, body: JSON_BODY, idempotency: 'required', command: { contract: TEST_RENAME, plan: (ctx) => { plans.push(ctx); return renamePlanner(ctx); } } },
  ];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, now: () => clock.t, log: { log: (line: string) => { logs.push(line); } }, routes, events: TEST_EVENTS, trustedOrigins: [TRUSTED],
    limits: testRequestLimits(), ...(setup.deadlineMs === undefined ? {} : { portDeadlineMs: setup.deadlineMs }),
    authenticator: { async verify(view): Promise<unknown> { return PRINCIPALS[view.bearerToken] ?? null; } }, authorizer: { authorize: () => true },
    idempotency: { store: createMemoryIdempotencyStore(state.idempotency), keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ port: (server.address() as AddressInfo).port, logs, plans, commits, state, clock });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** The reason codes of the first `count` request-log records, once they have flushed. */
async function reasons(logs: string[], count: number): Promise<unknown[]> {
  const records = (): Array<Record<string, unknown>> => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.event === 'request');
  for (let i = 0; i < 200 && records().length < count; i++) await sleep(5);
  return records().map((r) => r.reason);
}

test('a command commits every part together, answers only once committed, and every retry replays it', async () => {
  await withCommands({}, async ({ port, plans, commits, state }) => {
    const key = randomUUID();
    const first = await post(port, { key, headers: { 'x-request-id': 'client-chosen-request-id' } });
    assert.equal(first.status, 201);
    const { id } = JSON.parse(first.body) as { id: string };
    assert.equal(first.headers.location, `/v1/items/${id}`);
    const committed = inspectMemoryState(state);
    assert.deepEqual(committed.aggregates, [{ type: 'item', id, version: 1, state: { name: 'first', quantity: 1 } }]);
    assert.equal(committed.audit.length, 1);
    const [audit] = committed.audit;
    assert.deepEqual({ ...audit, at: 0 }, {
      action: 'conformance.item.create', permission: 'items.write', scope: 'platform', tenant: null, store: null, actor: null, correlationId: audit.correlationId, at: 0,
    });
    assert.ok(UUID_V4.test(audit.correlationId) && audit.correlationId !== 'client-chosen-request-id', 'the correlation ID is the server’s, never the client’s request ID');
    assert.deepEqual(committed.events.map((e) => [e.envelope.aggregateId, e.envelope.correlationId, e.envelope.occurredAt]), [[id, audit.correlationId, audit.at]]);
    assert.deepEqual(Object.keys(commits[0]).sort(), ['audit', 'events', 'lease', 'mutation', 'response', 'scope']);
    assert.deepEqual(Object.keys(plans[0]).sort(), ['audience', 'body', 'newAggregateId'], 'the planner sees its context and nothing else');
    assert.equal(plans[0].newAggregateId, id, 'a create names the runtime’s aggregate ID');
    for (const retry of [await post(port, { key }), await post(port, { key: key.toUpperCase() })]) {
      assert.deepEqual([retry.status, retry.body, retry.headers['idempotent-replayed']], [201, first.body, 'true']);
    }
    assert.deepEqual([plans.length, commits.length], [1, 1], 'the planner ran once, and one commit crossed the port');
    const after = inspectMemoryState(state);
    assert.deepEqual([after.aggregates.length, after.audit.length, after.events.length], [1, 1, 1], 'one logical operation, one immutable event, whatever the retries');
  });
});

test('the response waits for the commit: nothing is sent before the store confirms it', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withCommands({ port: (inner) => ({ commit: async (c, s) => { await gate; return inner.commit(c, s); }, probe: (s) => inner.probe(s) }) }, async ({ port, state }) => {
    const pending = open(port, { key: randomUUID() });
    assert.equal(await Promise.race([pending.reply.then(() => 'answered'), sleep(200).then(() => 'waiting')]), 'waiting', 'no answer before the commit is confirmed');
    assert.equal(inspectMemoryState(state).aggregates.length, 0);
    release();
    assert.equal((await pending.reply).status, 201);
  });
});

test('a conflict is a 409 write_conflict that commits and records nothing; the lease then simply expires', async () => {
  await withCommands({}, async ({ port, logs, state, clock }) => {
    const { id } = JSON.parse((await post(port, { key: randomUUID() })).body) as { id: string };
    const key = randomUUID();
    const stale = JSON.stringify({ id, version: 5, name: 'stale' });
    const refused = await post(port, { key, path: '/v1/items/rename', body: stale });
    assert.deepEqual([refused.status, errorOf(refused)], [409, 'write_conflict']);
    assert.deepEqual(inspectMemoryState(state).aggregates.map((a) => a.version), [1], 'nothing committed');
    const waiting = await post(port, { key, path: '/v1/items/rename', body: stale });
    assert.deepEqual([waiting.status, errorOf(waiting)], [409, 'request_in_progress'], 'nothing recorded: the key waits out its lease');
    clock.t += IDEMPOTENCY_POLICY.leaseMs;
    const again = await post(port, { key, path: '/v1/items/rename', body: stale });
    assert.deepEqual([again.status, errorOf(again)], [409, 'write_conflict'], 'a reclaim plans again, and conflicts again');
    assert.equal((await post(port, { key: randomUUID(), path: '/v1/items/rename', body: JSON.stringify({ id, version: 1, name: 'second' }) })).status, 200);
    assert.deepEqual(inspectMemoryState(state).aggregates.map((a) => [a.version, a.state.name]), [[2, 'second']]);
    assert.deepEqual(await reasons(logs, 5), [undefined, 'transaction_conflict', 'idempotency_in_progress', 'transaction_conflict', undefined]);
  });
});

test('an unknown or failed commit is a bounded 503 that assumes no rollback: a retry replays what landed and waits on what did not', async () => {
  const cases: Array<[string, (inner: CommandTransactionPort) => CommandTransactionPort, string, boolean]> = [
    ['a hang', (inner) => ({ ...inner, commit: () => new Promise(() => {}) }), 'transaction_timeout', false],
    ['a commit whose answer is lost', (inner) => ({ ...inner, commit: (c, s) => { void inner.commit(c, s); return new Promise(() => {}); } }), 'transaction_timeout', true],
    ['a throw', (inner) => ({ ...inner, commit: () => { throw new Error('store-secret-detail'); } }), 'transaction_unavailable', false],
    ['a rejection after the commit', (inner) => ({ ...inner, commit: async (c, s) => { await inner.commit(c, s); throw new Error('store-secret-detail'); } }), 'transaction_unavailable', true],
    ['an explicit unavailable', (inner) => ({ ...inner, commit: () => UNAVAILABLE }), 'transaction_unavailable', false],
    ['a malformed answer', (inner) => ({ ...inner, commit: () => ({ outcome: 'committed', durable: false }) }), 'transaction_outcome_invalid', false],
    ['a lost lease', (inner) => ({ ...inner, commit: () => LEASE_LOST }), 'transaction_lease_lost', false],
  ];
  for (const [label, wrap, reason, landed] of cases) {
    await withCommands({ port: wrap, deadlineMs: 300 }, async ({ port, logs, plans, state }) => {
      const key = randomUUID();
      const refused = await post(port, { key });
      assert.deepEqual([refused.status, errorOf(refused)], [503, 'service_unavailable'], label);
      const retry = await post(port, { key });
      if (landed) {
        assert.deepEqual([retry.status, retry.headers['idempotent-replayed'], plans.length], [201, 'true', 1], `${label}: the retry replays what landed`);
      } else {
        assert.deepEqual([retry.status, errorOf(retry), plans.length], [409, 'request_in_progress', 1], `${label}: the retry waits on the lease — nothing assumed rolled back`);
        assert.equal(inspectMemoryState(state).aggregates.length, 0, label);
      }
      assert.equal((await reasons(logs, 2))[0], reason, label);
      assert.doesNotMatch(logs.join(''), /store-secret-detail/, label);
    });
  }
});

test('a stale attempt whose commit lands after a reclaim is fenced out: exactly one attempt commits', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let staleAnswer: unknown;
  const port = (inner: CommandTransactionPort): CommandTransactionPort => ({
    commit: async (c, s) => {
      if (++calls > 1) return inner.commit(c, s);
      await gate; // the first attempt's commit is still in flight, and ignores its cancellation
      staleAnswer = await inner.commit(c, new AbortController().signal);
      return staleAnswer;
    },
    probe: (s) => inner.probe(s),
  });
  await withCommands({ port, deadlineMs: 300 }, async ({ port: p, plans, state, clock }) => {
    const key = randomUUID();
    assert.equal((await post(p, { key })).status, 503, 'the first attempt times out with its commit in flight');
    clock.t += IDEMPOTENCY_POLICY.leaseMs;
    const second = await post(p, { key });
    assert.equal(second.status, 201, 'a reclaim plans and commits');
    release();
    for (let i = 0; i < 100 && staleAnswer === undefined; i++) await sleep(5);
    assert.deepEqual(staleAnswer, LEASE_LOST, 'the stale commit is fenced out when it finally runs');
    const committed = inspectMemoryState(state);
    assert.deepEqual([plans.length, committed.aggregates.length, committed.audit.length, committed.events.length], [2, 1, 1, 1], 'two plans, one commit');
    assert.equal((await post(p, { key })).body, second.body, 'and every retry replays the attempt that committed');
  });
});

test('a plan out of its contract, or a planner that throws, is a bounded 500 that commits nothing', async () => {
  const planners: Array<[string, CommandPlanner, string]> = [
    ['a throw', () => { throw new Error('planner-secret-detail'); }, 'command_plan_failed'],
    ['an async planner', (async (ctx: CommandContext) => createPlanner(ctx)) as unknown as CommandPlanner, 'command_plan_invalid'],
    ['a rejecting planner', (() => Promise.reject(new Error('planner-secret-detail'))) as unknown as CommandPlanner, 'command_plan_invalid'],
    ['a create naming the client’s ID', (ctx) => ({ ...createPlanner(ctx), aggregateId: randomUUID() }), 'command_plan_invalid'],
    ['an SQL fragment', (ctx) => ({ ...createPlanner(ctx), sql: 'drop table item' }) as unknown as CommandPlan, 'command_plan_invalid'],
    ['a change the contract lacks', (ctx) => ({ ...createPlanner(ctx), changes: { name: 'n', quantity: 1, owner: 'x' } }), 'command_plan_invalid'],
    ['a rejection response', (ctx) => ({ ...createPlanner(ctx), response: { status: 422, body: {} } }), 'command_plan_invalid'],
  ];
  for (const [label, plan, reason] of planners) {
    await withCommands({ plan }, async ({ port, logs, commits, state }) => {
      const refused = await post(port, { key: randomUUID() });
      assert.deepEqual([refused.status, errorOf(refused), commits.length, inspectMemoryState(state).aggregates.length], [500, 'internal_error', 0, 0], label);
      assert.deepEqual(await reasons(logs, 1), [reason], label);
      assert.doesNotMatch(`${refused.body}${logs.join('')}`, /planner-secret-detail/, label);
    });
  }
});

test('no raw key, principal, credential, cookie or request body crosses the transaction port or reaches the log', async () => {
  const planner: CommandPlanner = (ctx) => ({ ...createPlanner(ctx), response: { status: 201, body: { receipt: 'RESPONSE-BODY-CANARY-5e2a' } } });
  await withCommands({ plan: planner }, async ({ port, logs, commits, state }) => {
    const key = randomUUID();
    const body = JSON.stringify({ name: 'first', canary: 'REQUEST-BODY-CANARY-5e2a' });
    const headers = { cookie: 'sid=COOKIE-CANARY-5e2a', 'x-request-id': 'client-request-id-5e2a' };
    const replies = [await post(port, { key, body, headers }), await post(port, { key, body, headers })];
    assert.deepEqual(replies.map((r) => r.status), [201, 201]);
    assert.ok(replies[1].body.includes('RESPONSE-BODY-CANARY'), 'the replay carries the recorded response');
    const [{ id }] = inspectMemoryState(state).aggregates;
    const renameBody = JSON.stringify({ id, version: 1, name: 'second', canary: 'REQUEST-BODY-CANARY-5e2a' });
    assert.equal((await post(port, { key: randomUUID(), path: '/v1/items/rename', body: renameBody, headers })).status, 200, 'an update crosses the port the same way');
    await reasons(logs, 3);
    const crossed = `${JSON.stringify(commits)}${JSON.stringify(inspectMemoryState(state))}${JSON.stringify([...state.idempotency.records])}`;
    for (const secret of [key, key.toUpperCase(), 'uid-alice', 'tok-alice', 'REQUEST-BODY-CANARY', 'COOKIE-CANARY', 'RESPONSE-BODY-CANARY', 'client-request-id-5e2a']) {
      assert.ok(!crossed.includes(secret), `${secret} never crosses the ports`);
    }
    for (const secret of [key, 'uid-alice', 'tok-alice', 'REQUEST-BODY-CANARY', 'COOKIE-CANARY', 'RESPONSE-BODY-CANARY']) {
      assert.ok(!logs.join('').includes(secret), `${secret} never reaches the log`);
    }
  });
});

test('startup refuses a command route without its port, a port without the idempotency store, a malformed port and an out-of-line contract', () => {
  const route = (contract: unknown = TEST_CREATE, path = '/v1/items'): RouteDefinition => ({
    method: 'POST', path, policy: WRITE, body: JSON_BODY, idempotency: 'required', command: { contract: contract as CommandContract, plan: createPlanner },
  });
  const state = createMemoryTransactionalState();
  const idempotency = { store: createMemoryIdempotencyStore(state.idempotency), keySecret: TEST_IDEMPOTENCY_KEY };
  const code = (over: Partial<AppDeps>): string | undefined => {
    try {
      createApp({
        readiness: createReadinessState(), trustedOrigins: [TRUSTED], limits: testRequestLimits(), authenticator: { verify: async () => null },
        authorizer: { authorize: () => true }, events: TEST_EVENTS, ...over,
      });
    } catch (err) {
      return err instanceof EnforcementSetupError ? err.code : 'unexpected';
    }
    return undefined;
  };
  assert.equal(code({ routes: [route()], idempotency }), 'command_transaction_required');
  assert.equal(code({ routes: [route()], transactions: testTransactions(state) }), 'idempotency_required', 'a command needs the store its lease lives in');
  assert.equal(code({ transactions: testTransactions(state) }), 'idempotency_required', 'the transaction port is never composed alone');
  assert.equal(code({ routes: [route()], idempotency, transactions: { port: { commit: () => ({}) } } as never }), 'command_transaction_invalid', 'a port without a probe');
  assert.equal(code({ routes: [route()], idempotency, transactions: { ...testTransactions(state), fallback: {} } as never }), 'command_transaction_invalid', 'no extra part, least of all a fallback');
  assert.equal(code({ routes: [route({ ...TEST_CREATE, events: [{ type: 'conformance.item.deleted', version: 1 }] })], idempotency, transactions: testTransactions(state) }),
    'command_registry_invalid', 'an event the contracts lack');
  assert.equal(code({ routes: [route(), route(TEST_CREATE, '/v1/items/again')], idempotency, transactions: testTransactions(state) }), 'command_registry_invalid', 'one kind on two routes');
  assert.equal(code({ routes: [route()], idempotency, transactions: testTransactions(state), events: [{ type: 'bad' }] as never }), 'outbox_registry_invalid');
  assert.equal(code({ routes: [route()], idempotency, transactions: testTransactions(state) }), undefined);
});

test('readiness reports the transaction port through one shared probe per second, and health never depends on it', async () => {
  let healthy = true;
  let probes = 0;
  const clock = { t: T0 };
  const state = createMemoryTransactionalState({ now: () => clock.t });
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, now: () => clock.t, log: { log: () => {} }, limits: testRequestLimits(),
    idempotency: { store: createMemoryIdempotencyStore(state.idempotency), keySecret: TEST_IDEMPOTENCY_KEY },
    transactions: { port: { commit: () => UNAVAILABLE, probe: () => { probes++; return healthy; } } },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const status = (path: string): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.deepEqual([await status('/readiness'), await status('/readiness')], [200, 200]);
    assert.equal(probes, 1, 'one shared probe answers every readiness request within a second');
    healthy = false;
    clock.t += 1_000;
    assert.equal(await status('/readiness'), 503, 'a port that cannot commit makes the instance unready');
    assert.equal(await status('/health'), 200, 'health stays independent of every dependency');
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
