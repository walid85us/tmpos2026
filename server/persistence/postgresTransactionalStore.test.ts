// Phase 4.0 M6-PG-P4 — the PostgreSQL transactional store's boundary logic, without a database.
//
// Everything that needs PostgreSQL — locking, the store's clock, atomicity, and the three conformance suites
// over two instances — is proved against a disposable server in tests/db/transactionalStore.integration.test.mjs.
// This suite pins what sits on either side of the server, where no server is needed to decide: what the adapter
// refuses without asking it, how it reads a failure before and after COMMIT, what it hands back, and what its
// source may never contain. The scripted client stands only at the database boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { NOT_FOUND_CREATE_KINDS, PRECONDITION_UPDATE_KINDS, createPostgresTransactionalStore } from './postgresTransactionalStore.js';
import type { AggregateMutator, PgStatement } from './postgresTransactionalStore.js';
import { createSupervisedPgClient } from './supervisedPgClient.js';
import type { DriverPool, SupervisedPgClient } from './supervisedPgClient.js';
import { defineCommands, prepareCommand } from '../runtime/commandTransaction.js';
import type { TransactionCommand } from '../runtime/commandTransaction.js';
import { NOT_FOUND_CREATE_KINDS as APP_NOT_FOUND_CREATE_KINDS, PRECONDITION_UPDATE_KINDS as APP_PRECONDITION_UPDATE_KINDS } from '../runtime/app.js';
import type { TrustedScope } from '../runtime/principals.js';
import { createIdempotencyKeyring } from '../runtime/idempotency.js';
import { TEST_IDEMPOTENCY_KEY } from '../runtime/idempotencyStore.testkit.js';
import { defineOutboxEvents } from '../runtime/outbox.js';
import { TEST_CREATE, TEST_EVENTS } from '../runtime/transactionalOutbox.testkit.js';
import { TENANT_DISPLAY_NAME_CONTRACT, TENANT_DISPLAY_NAME_EVENTS, planTenantDisplayName } from '../runtime/tenantDisplayName.js';
import { CUSTOMER_UPDATE_CONTRACT, planCustomerUpdate } from '../runtime/customerUpdate.js';
import {
  INVOICE_DRAFT_CREATE_CONTRACT, INVOICE_DRAFT_DISCARD_CONTRACT, INVOICE_DRAFT_EVENTS, INVOICE_DRAFT_UPDATE_CONTRACT, planInvoiceDraftCreate, planInvoiceDraftDiscard,
  planInvoiceDraftUpdate,
} from '../runtime/invoiceDrafts.js';

const UNAVAILABLE = { outcome: 'unavailable' };
const LEASE_LOST = { outcome: 'lease_lost' };
const CLAIM_LOST = { outcome: 'claim_lost' };
const COMMITTED = { outcome: 'committed' };
const OUTCOME_UNKNOWN = 'transactional_store_outcome_unknown';

const digest = (): string => randomBytes(32).toString('base64url');
const live = (): AbortSignal => new AbortController().signal;
const CREATE_MUTATOR: AggregateMutator = Object.freeze({ kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', contextScope: 'platform', apply: async () => 'applied' });
/** The same mutator declaring the tenant root's scope (M7B-INVOICES-P1, R4: a mutator's scope is declared, never the store's). */
const TENANT_CREATE_MUTATOR: AggregateMutator = Object.freeze({ ...CREATE_MUTATOR, contextScope: 'tenant' });

/** A client the adapter must never reach: every transaction it opens is counted and refused. */
function untouched(): { readonly client: SupervisedPgClient; readonly begins: () => number } {
  let begins = 0;
  return { client: { transaction: async () => { begins++; throw new Error('the store was asked'); }, end: async () => undefined }, begins: () => begins };
}

/** A server error as the driver reports one: a SQLSTATE, a severity, and a message the adapter must never repeat. */
const serverError = (code: string, severity = 'ERROR'): Error => Object.assign(new Error(`M6-UNIT-CANARY ${code} relation tmpos_internal.outbox_event`), { code, severity });
const connectionError = (): Error => Object.assign(new Error('M6-UNIT-CANARY write CONNECTION_CLOSED /tmp/.s.PGSQL.5432'), { code: 'CONNECTION_CLOSED' });
/** A refusal the driver raises itself, before or without the server: a code and no severity; the connection stays open. */
const driverError = (code: string): Error => Object.assign(new Error(`M6-UNIT-CANARY ${code}: raised by the driver`), { code });

/** `answer`, or 'no answer' when it has not settled within `ms`. */
async function within(answer: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, 'no answer'); });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The real transaction kernel over a scripted one-connection driver whose statements answer as a healthy store would for a
 * commit held by `lease`, then whose COMMIT succeeds or fails as `commit` says. `failAt` makes the first statement whose text
 * contains it fail with `error`; with `lost` that failure also closes the connection, as the driver reports one. `lose` closes
 * it from outside, between statements. Whatever the driver is handed after a close is counted: each is a write the real
 * driver would make to a dropped socket (doc 08, DA-15). `texts` is every statement handed over on the reserved connection, in
 * order; the statement the kernel opens a new pool's connection with answers and is not recorded.
 */
function scripted(lease: string, options: { failAt?: string; error?: Error; lost?: boolean; commit?: Error; spent?: () => number; completion?: string;
  audit?: { readonly count: number; readonly command: string } } = {}) {
  let writesAfterLoss = 0;
  const texts: string[] = [];
  const values: unknown[][] = [];
  let close: (err: Error) => void = () => undefined;
  const rowsFor = (text: string, values: readonly unknown[]): Record<string, unknown>[] => {
    if (text.includes('m6_command_fence')) return [{ held: values[1] === lease }];
    if (text.includes('m6_command_enqueue')) return [{ inserted: true }];
    if (text.includes('m6_idempotency_complete')) return [{ outcome: options.completion ?? 'completed' }];
    if (text.includes('m6_outbox_claim')) return [{ spent: options.spent?.() ?? 0, event_id: null }];
    return [{ ok: true }];
  };
  const driver = (_url: string, driverOptions: Record<string, unknown>): DriverPool => {
    let closed = false;
    let inFlight: { reject: (e: unknown) => void } | null = null;
    close = (err) => {
      if (closed) return;
      closed = true;
      inFlight?.reject(err);
      (driverOptions.onclose as (id: number) => void)(1);
    };
    const build = (reservedConnection: boolean) => (strings: TemplateStringsArray, ...boundValues: unknown[]) => {
      const text = strings.join('$');
      let resolveFn: (v: unknown) => void = () => undefined;
      let rejectFn: (e: unknown) => void = () => undefined;
      const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
      let started = false;
      const query = {
        handler: (q: typeof query) => {
          if (closed) { writesAfterLoss++; return; }
          if (reservedConnection) { texts.push(text); values.push(boundValues); }
          inFlight = q;
          const failed = reservedConnection && options.failAt !== undefined && text.includes(options.failAt);
          const commitFails = text === 'commit' && options.commit !== undefined;
          void Promise.resolve().then(() => {
            inFlight = null;
            if (failed && options.lost === true) { rejectFn(options.error); close(options.error as Error); } // the statement first, then the close
            else if (failed) rejectFn(options.error);
            else if (commitFails) rejectFn(options.commit);
            else if (options.audit !== undefined && text.includes('insert into public.audit_event')) resolveFn(Object.assign([], options.audit));
            else { const rows = rowsFor(text, boundValues); resolveFn(Object.assign(rows, { count: rows.length, command: text.trim().split(/\s/)[0].toUpperCase() })); }
          });
        },
        then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => {
          if (!started) { started = true; void Promise.resolve().then(() => query.handler(query)); }
          return promise.then(a, b);
        },
        reject: (e: unknown) => rejectFn(e),
        cancel: () => undefined,
      };
      return query;
    };
    const reserved = Object.assign(build(true), { json: (value: unknown) => ({ json: value }), release: () => { if (closed) writesAfterLoss++; } });
    return Object.assign(build(false), { reserve: async () => reserved, end: async () => { closed = true; } }) as unknown as DriverPool;
  };
  const client = createSupervisedPgClient(driver, 'postgres://unit.invalid/db', { max: 1 });
  return { transaction: client.transaction, end: client.end, writesAfterLoss: () => writesAfterLoss, lose: (err: Error) => close(err), texts, values };
}

const events = defineOutboxEvents(TEST_EVENTS);
const commands = defineCommands([TEST_CREATE], events);
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);

/** A trusted context as scope selection produces one: a platform actor with a security version. */
const TRUSTED: TrustedScope = Object.freeze({
  actor: '11111111-1111-4111-8111-111111111111', securityVersion: 'a'.repeat(64),
  scope: 'platform', tenant: null, store: null, membershipId: '55555555-5555-4555-8555-555555555555', roleId: 'system_owner', limitation: 'none',
});

/** The store key of the administrative session a context-carrying command is presented by (M5-ADMIN-REVOKE-P1). */
const SESSION_KEY = 's'.repeat(21) + '_-' + 'S'.repeat(20);

/** A command exactly as the runtime prepares one: a context-carrying one presented by a session, as every one is. */
function command(context: TrustedScope | null = null): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'POST', path: '/v1/unit', audience: null, tenant: null, store: null, actor: null, body: Buffer.from('{}'),
  });
  const id = randomUUID();
  const contract = commands.contract(TEST_CREATE.kind);
  assert.ok(contract !== undefined);
  const prepared = prepareCommand(contract, events, {
    aggregateId: id, expectedVersion: null, changes: { name: 'n', quantity: 1 },
    events: [{ type: 'conformance.item.created', payload: { name: 'n', quantity: 1 } }], response: { status: 201, body: { id } },
  }, {
    scope: operation.scope, lease: digest(), newAggregateId: id,
    authorization: Object.freeze({ scope: context === null ? 'platform' : context.scope, permission: 'conformance.write' }),
    context,
    authNotAfter: null,
    sessionKey: context === null ? null : SESSION_KEY,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null);
  return prepared.command;
}

test('construction refuses a malformed client, a raw driver pool or a malformed mutator table, and accepts the kernel', () => {
  const client = untouched().client;
  for (const options of [null, {}, { client: null, mutators: [] }, { client: {}, mutators: [] }, { client, mutators: null }]) {
    assert.throws(() => createPostgresTransactionalStore(options as never), TypeError);
  }
  for (const mutators of [
    [{ ...CREATE_MUTATOR, kind: 'NotDotted' }],
    [{ ...CREATE_MUTATOR, mode: 'upsert' }],
    [{ ...CREATE_MUTATOR, aggregateType: 'Item' }],
    [{ ...CREATE_MUTATOR, apply: 'insert into item' }],
    [{ ...CREATE_MUTATOR, table: 'item' }],
    [CREATE_MUTATOR, { ...CREATE_MUTATOR }],
    // M7B-INVOICES-P1 (R4): the scope is required — absent, undefined or outside the three, the table is refused (an untyped
    // caller gets no default).
    [Object.fromEntries(Object.entries(CREATE_MUTATOR).filter(([key]) => key !== 'contextScope'))],
    [{ ...CREATE_MUTATOR, contextScope: undefined }],
    [{ ...CREATE_MUTATOR, contextScope: 'shop' }],
  ]) assert.throws(() => createPostgresTransactionalStore({ client, mutators } as never), TypeError, 'a mutator table in contract only, one per kind');
  assert.throws(() => createPostgresTransactionalStore({ client: Object.assign(() => undefined, { begin: async () => undefined }), mutators: [] } as never), TypeError,
    'a driver pool is refused: only the transaction kernel');
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] });
  assert.deepEqual(Object.keys(store).sort(), ['delivery', 'idempotency', 'transactions'], 'three separate ports, no fourth surface');
  assert.deepEqual([Object.keys(store.idempotency).sort(), Object.keys(store.transactions).sort(), Object.keys(store.delivery).sort()], [
    ['acquire', 'complete', 'probe'], ['commit', 'probe'], ['acknowledge', 'claim', 'deadLetter', 'probe', 'retry'],
  ], 'each port exposes exactly its own interface');
});

test('a malformed request, an unserved kind, a pre-M5 scope or an aborted signal is refused before the store is asked', async () => {
  const { client, begins } = untouched();
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] });
  const good = command();
  const [event] = good.events;
  const acquire = { scope: digest(), fingerprint: digest(), lease: digest(), leaseMs: 60_000, retentionMs: 600_000 };
  const aborted = new AbortController();
  aborted.abort();
  // A caller that is not the runtime: a proxy whose every read throws, and a change no enumeration shows.
  const hostile = new Proxy({}, { get() { throw new Error('M6-UNIT-CANARY hostile getter'); } });
  const hidden = Object.defineProperty({ ...good.mutation.changes }, 'note', { value: 'x'.repeat(8_192), enumerable: false });
  const cases: Array<[string, () => unknown, unknown]> = [
    ['a short scope', () => store.idempotency.acquire({ ...acquire, scope: 'short' }, live()), UNAVAILABLE],
    ['a retention shorter than its lease', () => store.idempotency.acquire({ ...acquire, retentionMs: 1_000 }, live()), UNAVAILABLE],
    ['a fractional lease', () => store.idempotency.acquire({ ...acquire, leaseMs: 1.5 }, live()), UNAVAILABLE],
    ['a completion under a lease the store never granted', () => store.idempotency.complete({ scope: digest(), lease: 'x', response: 'AAAA' }, live()), LEASE_LOST],
    ['a completion whose response is not sealed text', () => store.idempotency.complete({ scope: digest(), lease: digest(), response: 'a=b' }, live()), UNAVAILABLE],
    ['a command under a malformed lease', () => store.transactions.commit({ ...good, lease: 'x' }, live()), LEASE_LOST],
    ['a command with a field too many', () => store.transactions.commit({ ...good, sql: 'select 1' } as never, live()), UNAVAILABLE],
    ['a kind no mutator serves', () => store.transactions.commit({ ...good, mutation: { ...good.mutation, kind: 'conformance.item.rename' } }, live()), UNAVAILABLE],
    ['a tenant-scope audit under no tenant context', () => store.transactions.commit({ ...good, audit: { ...good.audit, scope: 'tenant' } }, live()), UNAVAILABLE],
    ['an event of another aggregate', () => store.transactions.commit({ ...good, events: [{ ...event, aggregateId: randomUUID() }] }, live()), UNAVAILABLE],
    ['an event ID twice', () => store.transactions.commit({ ...good, events: [event, event] }, live()), UNAVAILABLE],
    ['nine events', () => store.transactions.commit({ ...good, events: Array.from({ length: 9 }, () => ({ ...event, eventId: randomUUID() })) }, live()), UNAVAILABLE],
    ['a claim of 33', () => store.delivery.claim({ claim: digest(), limit: 33, claimMs: 30_000 }, live()), UNAVAILABLE],
    ['a claim of no duration', () => store.delivery.claim({ claim: digest(), limit: 1, claimMs: 0 }, live()), UNAVAILABLE],
    ['a settlement of a malformed event ID', () => store.delivery.acknowledge({ eventId: 'e', claim: digest() }, live()), CLAIM_LOST],
    ['a retry past the delay cap', () => store.delivery.retry({ eventId: randomUUID(), claim: digest(), delayMs: 900_001 }, live()), UNAVAILABLE],
    ['an unknown dead-letter reason', () => store.delivery.deadLetter({ eventId: randomUUID(), claim: digest(), reason: 'other' } as never, live()), UNAVAILABLE],
    ['an aborted acquisition', () => store.idempotency.acquire(acquire, aborted.signal), UNAVAILABLE],
    ['an aborted commit', () => store.transactions.commit(good, aborted.signal), UNAVAILABLE],
    ['a hostile acquisition request', () => store.idempotency.acquire(hostile as never, live()), UNAVAILABLE],
    ['a hostile completion', () => store.idempotency.complete(hostile as never, live()), UNAVAILABLE],
    ['a hostile claim', () => store.delivery.claim(hostile as never, live()), UNAVAILABLE],
    ['a hostile acknowledgement', () => store.delivery.acknowledge(hostile as never, live()), UNAVAILABLE],
    ['a hostile retry', () => store.delivery.retry(hostile as never, live()), UNAVAILABLE],
    ['a hostile dead-letter', () => store.delivery.deadLetter(hostile as never, live()), UNAVAILABLE],
    ['a change hidden from enumeration', () => store.transactions.commit({ ...good, mutation: { ...good.mutation, changes: hidden } }, live()), UNAVAILABLE],
    ['an event naming a tenant before M5', () => store.transactions.commit({ ...good, events: [{ ...event, tenant: digest() }] } as never, live()), UNAVAILABLE],
    ['an event naming an actor before M5', () => store.transactions.commit({ ...good, events: [{ ...event, actor: digest() }] } as never, live()), UNAVAILABLE],
  ];
  for (const [label, call, expected] of cases) assert.deepEqual(await call(), expected, label);
  assert.equal(await store.transactions.probe(aborted.signal), false, 'an aborted probe is never ready');
  assert.equal(begins(), 0, 'not one of them opened a transaction');
});

test('a failure before COMMIT is unavailable; after COMMIT is sent, only a server ERROR is — anything else rejects with one fixed message', async () => {
  const good = command();
  const commitOn = (client: SupervisedPgClient): Promise<unknown> =>
    Promise.resolve(createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] }).transactions.commit(good, live()));
  assert.deepEqual(await commitOn(scripted(good.lease)), COMMITTED, 'the scripted store commits a well-formed command');
  for (const [label, options] of [
    ['a serialization failure at the fence', { failAt: 'm6_command_fence', error: serverError('40001') }],
    ['a deadlock at the event insert', { failAt: 'm6_command_enqueue', error: serverError('40P01') }],
    ['an unknown SQLSTATE at the completion', { failAt: 'm6_idempotency_complete', error: serverError('XX000') }],
    ['a value the driver cannot bind', { failAt: 'm6_command_enqueue', error: driverError('UNDEFINED_VALUE') }],
    ['a statement the driver cancelled before sending it', { failAt: 'm6_command_enqueue', error: driverError('57014') }],
    ['a connection lost mid-transaction', { failAt: 'm6_command_enqueue', error: connectionError(), lost: true }],
    ['a session the server ends mid-transaction', { failAt: 'm6_command_enqueue', error: serverError('25P03', 'FATAL'), lost: true }],
    ['a server ERROR at COMMIT, which rolled it back', { commit: serverError('23505') }],
  ] as const) {
    const client = scripted(good.lease, options);
    assert.deepEqual(await within(commitOn(client), 2_000), UNAVAILABLE, `${label}: nothing committed, and the answer comes at once`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.writesAfterLoss(), 0, `${label}: nothing is written to a lost connection`);
  }
  for (const [label, error] of [
    ['a connection lost at COMMIT', connectionError()],
    ['a FATAL at COMMIT', serverError('57P01', 'FATAL')],
    ['a connection exception at COMMIT', serverError('08006')],
  ] as const) {
    await assert.rejects(commitOn(scripted(good.lease, { commit: error })), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.deepEqual([err.message, Object.keys(err), err.cause], [OUTCOME_UNKNOWN, [], undefined], `${label}: indeterminate, and nothing of the driver kept`);
      return true;
    });
  }
  assert.deepEqual(await commitOn(scripted(digest())), LEASE_LOST, 'another lease on the record: fenced out');
});

test('the mutator is handed the values the store validated, read once and frozen — never the caller\'s live object', async () => {
  const good = command();
  let reads = 0;
  // Valid when first read, oversized on every read after: only a single read passes it.
  const flipping = Object.defineProperty({ quantity: 1 }, 'name', { enumerable: true, get: () => (reads++ === 0 ? 'n' : `n${'x'.repeat(8_192)}`) });
  let seen: unknown;
  const capturing: AggregateMutator = Object.freeze({ ...CREATE_MUTATOR, apply: async (_sql: unknown, m: { changes: unknown }) => { seen = m.changes; return 'applied'; } });
  const store = createPostgresTransactionalStore({ client: scripted(good.lease), mutators: [capturing] });
  assert.deepEqual(await store.transactions.commit({ ...good, mutation: { ...good.mutation, changes: flipping } }, live()), COMMITTED);
  assert.deepEqual([seen, Object.isFrozen(seen), reads], [{ name: 'n', quantity: 1 }, true, 1], 'the validated copy, read once');
});

test('the adapter reads no host clock, environment or console, binds no driver, names no store table, and reaches the store only through 006\'s routines', () => {
  const source = readFileSync(new URL('./postgresTransactionalStore.ts', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '');
  for (const forbidden of [/\bDate\.now\b/, /\bnew Date\b/, /\bperformance\.now\b/, /\bprocess\.env\b/, /\bconsole\./, /\.unsafe\s*\(/, /from\s+['"]postgres['"]/,
    /\bgetRuntimeDb\b/, /\bgetDb\b/, /\bsetInterval\b/, /\bsetTimeout\b/]) {
    assert.doesNotMatch(code, forbidden, `the adapter holds no ${forbidden}`);
  }
  // Every statement is a tagged template. The one plain call forwards the audit writer's own fixed template to the
  // transaction — never an identifier helper, a fragment or a string.
  assert.deepEqual([...code.matchAll(/\bsql\s*\(([^)]*)\)/g)].map((m) => m[1].trim()), ['strings, ...values']);
  // The runtime role holds no privilege on either store table (migration 006, section 4), so the adapter names neither
  // table nor the clock, and writes nothing itself: every read and change of the store is one of 006's routines.
  for (const name of ['idempotency_record', 'outbox_event', 'm6_store_clock']) assert.ok(!code.includes(name), `the adapter never names ${name}`);
  assert.doesNotMatch(code, /\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i, 'and issues no write of its own');
  const routines = ['m6_idempotency_acquire', 'm6_idempotency_complete', 'm6_command_fence', 'm6_command_enqueue', 'm6_outbox_claim',
    'm6_outbox_acknowledge', 'm6_outbox_retry', 'm6_outbox_dead_letter', 'm6_store_probe'];
  assert.deepEqual([...new Set([...code.matchAll(/\b(m6_\w+)\s*\(/g)].map((m) => m[1]))].sort(), [...routines].sort(), 'it calls exactly the nine routines');
  for (const routine of routines) {
    assert.equal([...code.matchAll(new RegExp(`(^|[^.\\w])${routine}\\b`, 'g'))].length, 0, `every call of ${routine} is qualified tmpos_internal.${routine}`);
  }
  assert.doesNotMatch(code, /\bpublic\./, 'no relation of the store is named in public');
  for (const driverOnly of [/\.begin\s*\(/, /savepoint/i, /\.reserve\s*\(/, /\.release\s*\(/, /\bprepare\s+transaction\b/i]) {
    assert.doesNotMatch(code, driverOnly, `the adapter reaches the driver only through the kernel: no ${driverOnly}`);
  }
  const audits = [...code.matchAll(/\bwriteAuditEvent\(([^)]*)\)/g)];
  assert.deepEqual(audits.map((m) => /\{\s*executor\s*\}/.test(m[1])), [true], 'the one audit write runs on the transaction, never the runtime pool');
});

test('an idle claim rolls back, so it is never indeterminate; one that dead-lettered a spent claim commits', async () => {
  let spentNow = 0;
  const client = scripted(digest(), { spent: () => spentNow });
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] });
  const request = { claim: digest(), limit: 32, claimMs: 30_000 };
  assert.deepEqual(await store.delivery.claim(request, live()), { outcome: 'claimed', events: [] });
  spentNow = 1;
  assert.deepEqual(await store.delivery.claim(request, live()), { outcome: 'claimed', events: [] });
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback', 'commit'],
    'the same empty answer; only the claim that dead-lettered something commits');
});

test('a connection lost while the mutator waits between statements is handed nothing more — no statement, ROLLBACK or COMMIT — and the call is unavailable', async () => {
  for (const after of ['a statement', 'a refusal', 'completion'] as const) {
    const good = command();
    let inGap: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { inGap = resolve; });
    let resume: () => void = () => undefined;
    const gapped: AggregateMutator = Object.freeze({ ...CREATE_MUTATOR, apply: async (sql: PgStatement) => {
      await sql`select 1`;
      inGap();
      await new Promise<void>((resolve) => { resume = resolve; });
      if (after === 'a statement') await sql`select 2`;
      if (after === 'a refusal') throw new Error('M6-UNIT-CANARY refused after the gap');
      return 'applied';
    } });
    const client = scripted(good.lease);
    const answer = createPostgresTransactionalStore({ client, mutators: [gapped] }).transactions.commit(good, live());
    await waiting;
    client.lose(connectionError());
    assert.deepEqual(await within(Promise.resolve(answer), 2_000), UNAVAILABLE, `${after}: nothing committed, and the answer comes at once`);
    resume();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.writesAfterLoss(), 0, `${after}: nothing reaches the lost connection`);
  }
});

// ---------------------------------------------------------------------------
// M5-ID-P1 — transaction-local revalidation
// ---------------------------------------------------------------------------

test('a trusted context is re-read after the fence and before any business state', async () => {
  // The order is the whole point: a stale lease must still answer 'lease_lost' and learn nothing about
  // the identity, and a revoked actor must never reach a mutator.
  const order: string[] = [];
  const c = command(TRUSTED);
  const client = scripted(c.lease);
  const mutator: AggregateMutator = Object.freeze({
    kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', contextScope: 'platform',
    apply: async () => { order.push('mutator'); return 'applied'; },
  });
  const store = createPostgresTransactionalStore({
    client, mutators: [mutator],
    revalidate: async (_sql, scope, permission, authNotAfter, sessionKey) => {
      order.push('revalidate');
      assert.deepEqual(scope, TRUSTED);
      assert.equal(permission, 'conformance.write', 'the route\'s own requirement, from the audit record the runtime built');
      assert.equal(authNotAfter, null);
      assert.equal(sessionKey, SESSION_KEY, 'the presenting session\'s key, handed to the revalidator as the command carried it (M5-ADMIN-REVOKE-P1)');
      return true;
    },
  });

  assert.deepEqual(await store.transactions.commit(c, live()), COMMITTED);
  assert.deepEqual(order, ['revalidate', 'mutator'], 'the context is re-read before the mutation');
  const fenceAt = client.texts.findIndex((t) => t.includes('m6_command_fence'));
  assert.ok(fenceAt >= 0 && fenceAt < client.texts.findIndex((t) => t.includes('m6_command_enqueue')), 'the fence still runs first');
  // The key is the revalidator's parameter and nothing else: no statement the store itself sends — the fence, the
  // mutation, the audit record, the events, the completion — carries it.
  assert.ok(!JSON.stringify(client.values).includes(SESSION_KEY), 'the session key reaches no statement of the store\'s own');
});

test('a lost lease refuses before the context is read at all', async () => {
  let asked = false;
  const c = command(TRUSTED);
  const store = createPostgresTransactionalStore({
    client: scripted('a'.repeat(43)), mutators: [CREATE_MUTATOR],
    revalidate: async () => { asked = true; return true; },
  });
  assert.deepEqual(await store.transactions.commit(c, live()), LEASE_LOST);
  assert.equal(asked, false, 'a stale attempt learns nothing about the actor');
});

test('a context that no longer holds commits nothing — no mutation, completion, audit or event', async () => {
  // Exactly true commits; false, a truthy value that is not true (a role name, as 007's routine answered) and a throw do not.
  for (const [label, answer] of [['revoked', async () => false], ['a truthy non-boolean', async () => 'system_owner' as never],
    ['a throw', async () => { throw new Error('M6-UNIT-CANARY revalidation fault'); }]] as const) {
    let applied = 0;
    const c = command(TRUSTED);
    const client = scripted(c.lease);
    const store = createPostgresTransactionalStore({
      client,
      mutators: [Object.freeze({ kind: TEST_CREATE.kind, mode: 'create', aggregateType: 'item', contextScope: 'platform', apply: async () => { applied++; return 'applied'; } })],
      revalidate: answer,
    });
    assert.deepEqual(await store.transactions.commit(c, live()), UNAVAILABLE, label);
    assert.equal(applied, 0, `${label}: no mutator runs`);
    for (const forbidden of ['m6_command_enqueue', 'm6_idempotency_complete', 'insert into']) {
      assert.ok(!client.texts.some((t) => t.toLowerCase().includes(forbidden)), `${label}: no ${forbidden}`);
    }
    assert.ok(client.texts.includes('rollback'), `${label}: the transaction rolled back`);
  }
});

test('a context the store cannot revalidate is never committed', async () => {
  // No revalidator composed: a contextless command still commits, and a command carrying a context
  // does not — the store never commits an unrevalidated actor because its dependency is missing.
  const contextless = command();
  const withContext = command(TRUSTED);
  assert.deepEqual(await createPostgresTransactionalStore({ client: scripted(contextless.lease), mutators: [CREATE_MUTATOR] })
    .transactions.commit(contextless, live()), COMMITTED);
  const client = scripted(withContext.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR] })
    .transactions.commit(withContext, live()), UNAVAILABLE);
  assert.ok(!client.texts.some((t) => t.includes('m6_command_enqueue')));
});

test('a context whose scope this transaction cannot prove is refused before any statement', async () => {
  // The default (administrative) store re-proves platform contexts alone: a tenant or store context is refused there
  // rather than audited at a scope it cannot prove — only a store composed for tenant scope admits one (below).
  const tenant = '22222222-2222-4222-8222-222222222222';
  for (const scope of [
    { ...TRUSTED, scope: 'tenant' as const, tenant, roleId: 'manager' },
    { ...TRUSTED, scope: 'store' as const, tenant, store: '44444444-4444-4444-8444-444444444444', roleId: 'technician' },
  ]) {
    const c = command(scope);
    const store = untouched();
    assert.deepEqual(await createPostgresTransactionalStore({ client: store.client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
      .transactions.commit(c, live()), UNAVAILABLE, scope.scope);
    assert.equal(store.begins(), 0, 'no transaction opens');
  }
});

test('a read-only context may not commit a command at all', async () => {
  // A command is a write. The resolver marks the context read-only when the account, the tenant or the
  // store is read_only or overdue; the store refuses it rather than leaving the limiting to a caller.
  for (const limitation of ['read_only'] as const) {
    const c = command({ ...TRUSTED, limitation });
    const store = untouched();
    assert.deepEqual(await createPostgresTransactionalStore({ client: store.client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
      .transactions.commit(c, live()), UNAVAILABLE, limitation);
    assert.equal(store.begins(), 0, 'no transaction opens');
  }
});

test('an outbox event names no actor, tenant or store even under a trusted context', async () => {
  // Migration 006 types those columns as keyed digests, not identifiers; naming one would abort the
  // whole transaction at the constraint. The actor is attributed on the audit record instead.
  const c = command(TRUSTED);
  assert.deepEqual(c.events.map((e) => [e.tenant, e.store, e.actor]), c.events.map(() => [null, null, null]));
  assert.equal(c.audit.actor, TRUSTED.actor, 'the audit record does name it');
  const client = scripted(c.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
    .transactions.commit(c, live()), COMMITTED);
});

test('a command may not name an actor, tenant or store its context did not give it', async () => {
  const c = command(TRUSTED);
  const forged: unknown[] = [
    { ...c, context: null }, //                                       an audit actor with no context
    { ...c, audit: { ...c.audit, actor: 'someone-else' } }, //          an actor of the caller's choosing
    { ...c, audit: { ...c.audit, tenant: '22222222-2222-4222-8222-222222222222' } },
    { ...c, context: { ...TRUSTED, actor: 'root' } }, //                a context selection could not produce
    { ...c, events: c.events.map((e) => ({ ...e, actor: 'someone-else' })) },
    // M5-GIAM-D1-P2 — the bounded reason pair is both or neither, within the bounds the runtime applied,
    // and a freshness deadline is a positive safe integer that only a command carrying a context may claim.
    { ...c, audit: { ...c.audit, reasonCode: 'x_y' } }, //                       a code with no reason
    { ...c, audit: { ...c.audit, reason: 'a'.repeat(20) } }, //                  a reason with no code
    { ...c, audit: { ...c.audit, reasonCode: 'X_Y', reason: 'a'.repeat(20) } },
    { ...c, audit: { ...c.audit, reasonCode: 'x.y', reason: 'a'.repeat(20) } },
    { ...c, audit: { ...c.audit, reasonCode: 1, reason: 'a'.repeat(20) } },
    { ...c, audit: { ...c.audit, reasonCode: 'x_y', reason: '' } },
    { ...c, audit: { ...c.audit, reasonCode: 'x_y', reason: 'a'.repeat(1_001) } },
    { ...c, audit: { ...c.audit, reasonCode: 'x_y', reason: `a${String.fromCodePoint(10)}b` } },
    { ...c, audit: { ...c.audit, reasonCode: 'x_y', reason: `a${String.fromCodePoint(0x202e)}b` } },
    { ...c, audit: { ...c.audit, reasonCode: 'x_y', reason: `a${String.fromCharCode(0xd800)}b` } },
    { ...c, authNotAfter: 0 },
    { ...c, authNotAfter: -1 },
    { ...c, authNotAfter: 1.5 },
    { ...c, authNotAfter: '1700000000000' },
    { ...c, context: null, audit: { ...c.audit, actor: null, tenant: null, store: null }, authNotAfter: 1_700_000_600_000 },
    // M5-ADMIN-REVOKE-P1 — the presenting session's key: null or exactly a session key's shape, and never without a context.
    { ...c, sessionKey: '' },
    { ...c, sessionKey: 'k'.repeat(42) },
    { ...c, sessionKey: 'k'.repeat(44) },
    { ...c, sessionKey: `${'k'.repeat(42)}=` },
    { ...c, sessionKey: 1 },
    { ...c, sessionKey: { key: SESSION_KEY } },
    { ...c, context: null, audit: { ...c.audit, actor: null, tenant: null, store: null }, sessionKey: SESSION_KEY },
    Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'sessionKey')), //   the field absent: the key set is exact
    { ...c, session: SESSION_KEY }, //                                                an extra field
  ];
  for (const raw of forged) {
    const store = untouched();
    assert.deepEqual(await createPostgresTransactionalStore({ client: store.client, mutators: [CREATE_MUTATOR], revalidate: async () => true })
      .transactions.commit(raw as TransactionCommand, live()), UNAVAILABLE, JSON.stringify(raw).slice(0, 60));
    assert.equal(store.begins(), 0);
  }
});

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P1-R1 — the no-op's completion, and the audit record's subject
// ---------------------------------------------------------------------------

const TARGET_TENANT = '66666666-6666-4666-8666-666666666666';
const tenantEvents = defineOutboxEvents(TENANT_DISPLAY_NAME_EVENTS);

/** A display-name command exactly as the runtime prepares one: an update whose plan names its unchanged response. */
function renaming(context: TrustedScope | null = TRUSTED): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'PATCH', path: '/admin/v1/tenants/display-name', audience: 'admin', tenant: null, store: null, actor: null, body: Buffer.from('{}'),
  });
  const plan = planTenantDisplayName({ audience: 'admin', body: { tenantId: TARGET_TENANT, displayName: 'Acme', expectedVersion: 3 }, newAggregateId: randomUUID() });
  const prepared = prepareCommand(TENANT_DISPLAY_NAME_CONTRACT, tenantEvents, plan, {
    scope: operation.scope, lease: digest(), newAggregateId: randomUUID(), authorization: Object.freeze({ scope: 'platform', permission: 'edit_tenant_profile' }),
    context, authNotAfter: null, sessionKey: context === null ? null : SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null && prepared.command.unchanged !== null);
  return prepared.command;
}
const tenantMutator = (answer: string): AggregateMutator => Object.freeze({
  kind: TENANT_DISPLAY_NAME_CONTRACT.kind, mode: 'update', aggregateType: 'tenant', contextScope: 'platform', apply: async () => answer,
});

test('changes already in place commit exactly their sealed unchanged response as the completion, in the same transaction — no audit record, no event', async () => {
  const c = renaming();
  const client = scripted(c.lease);
  const store = createPostgresTransactionalStore({ client, mutators: [tenantMutator('unchanged')], revalidate: async () => true });
  assert.deepEqual(await store.transactions.commit(c, live()), { outcome: 'unchanged' });
  const at = (name: string): number => client.texts.findIndex((t) => t.includes(name));
  assert.ok(at('m6_command_fence') >= 0 && at('m6_command_fence') < at('m6_idempotency_complete'), 'the fence, then the completion, on one transaction');
  assert.notEqual(c.unchanged, c.response);
  assert.deepEqual(client.values[at('m6_idempotency_complete')], [c.scope, c.lease, c.unchanged],
    'the sealed unchanged response, under this attempt\'s lease — never the response of a change');
  for (const forbidden of ['m6_command_enqueue', 'insert into']) {
    assert.ok(!client.texts.some((t) => t.toLowerCase().includes(forbidden)), `nothing changed, so no ${forbidden}`);
  }
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit'], 'and the decision commits with its completion');
});

test('a no-op whose completion does not hold, or that carries no unchanged response, commits nothing', async () => {
  for (const [label, c, completion] of [
    ['a completion under a lease that no longer holds', renaming(), 'lease_lost'],
    ['a completion answer the store does not know', renaming(), 'maybe'],
    ['no unchanged response to record', { ...renaming(), unchanged: null }, 'completed'],
  ] as const) {
    const client = scripted(c.lease, { completion });
    const store = createPostgresTransactionalStore({ client, mutators: [tenantMutator('unchanged')], revalidate: async () => true });
    assert.deepEqual(await store.transactions.commit(c, live()), UNAVAILABLE, label);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], `${label}: rolled back, never committed`);
  }
  // With no response to record, nothing is even attempted: no completion statement reaches the store.
  const noResponse = { ...renaming(), unchanged: null };
  const client = scripted(noResponse.lease);
  await createPostgresTransactionalStore({ client, mutators: [tenantMutator('unchanged')], revalidate: async () => true }).transactions.commit(noResponse, live());
  assert.ok(!client.texts.some((t) => t.includes('m6_idempotency_complete')), 'no completion without an unchanged response');
});

test('an unchanged response belongs to an update alone, sealed exactly like the response — anything else is refused before a statement', async () => {
  const create = command();
  const update = renaming();
  const { client, begins } = untouched();
  const store = createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR, tenantMutator('applied')], revalidate: async () => true });
  const { unchanged: _dropped, ...withoutField } = update;
  for (const [label, raw] of [
    ['a create carrying one', { ...create, unchanged: update.unchanged }],
    ['one that is not sealed text', { ...update, unchanged: 'a=b' }],
    ['an empty one', { ...update, unchanged: '' }],
    ['one that is not text', { ...update, unchanged: 7 }],
    ['a command without the field', withoutField],
  ] as const) assert.deepEqual(await store.transactions.commit(raw as never, live()), UNAVAILABLE, label);
  assert.equal(begins(), 0, 'not one of them opened a transaction');
});

test('the audit record names a tenant command\'s own target as its subject — no caller value, and no other command names one', async () => {
  const c = renaming();
  const client = scripted(c.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client, mutators: [tenantMutator('applied')], revalidate: async () => true })
    .transactions.commit(c, live()), COMMITTED);
  const audit = client.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(audit >= 0 && client.texts[audit].includes('subject_tenant_id'), 'the statement names the subject column');
  const bound = client.values[audit];
  assert.equal(bound[bound.length - 1], TARGET_TENANT, 'the subject is the command\'s own validated target');
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9]], [TRUSTED.actor, 'platform', null, null],
    'the actor stays the trusted context\'s, the scope stays platform, and the scope still names no tenant');

  // A command of another aggregate names no subject: its statement is the one every writer used before 009.
  const other = command(TRUSTED);
  const otherClient = scripted(other.lease);
  assert.deepEqual(await createPostgresTransactionalStore({ client: otherClient, mutators: [CREATE_MUTATOR], revalidate: async () => true })
    .transactions.commit(other, live()), COMMITTED);
  const otherAudit = otherClient.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(otherAudit >= 0 && !otherClient.texts[otherAudit].includes('subject_tenant_id'));

  // The caller cannot hand one in: the audit record it sends has exactly its seven fields.
  const { client: untouchedClient, begins } = untouched();
  assert.deepEqual(await createPostgresTransactionalStore({ client: untouchedClient, mutators: [tenantMutator('applied')], revalidate: async () => true })
    .transactions.commit({ ...c, audit: { ...c.audit, subjectTenantId: randomUUID() } } as never, live()), UNAVAILABLE);
  assert.equal(begins(), 0);
});

// ---------------------------------------------------------------------------
// M7A-CUSTOMERS-P3 — the tenant store, the mutator's authority and the one-row audit rule
// ---------------------------------------------------------------------------

const TENANT = '22222222-2222-4222-8222-222222222222';
/** A tenant context as the tenant authorizer selects one: the actor's one tenant grant, no store. */
const TENANT_CONTEXT: TrustedScope = Object.freeze({ ...TRUSTED, scope: 'tenant', tenant: TENANT, roleId: 'manager' });
const tenantStore = (client: SupervisedPgClient, mutators: readonly AggregateMutator[] = [TENANT_CREATE_MUTATOR]) =>
  createPostgresTransactionalStore({ client, mutators, contextScope: 'tenant', revalidate: async () => true });

test('a tenant store commits a tenant context audited at tenant scope, naming its tenant and no store', async () => {
  const c = command(TENANT_CONTEXT);
  assert.deepEqual([c.audit.scope, c.audit.tenant, c.audit.store], ['tenant', TENANT, null], 'the runtime audits at the route\'s scope');
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client).transactions.commit(c, live()), COMMITTED);
  const audit = client.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(audit >= 0 && !client.texts[audit].includes('subject_tenant_id'), 'a customer is no tenant aggregate: no subject column');
  assert.ok(!client.texts[audit].includes('subject_customer_id'), 'a create names no customer subject (DA-111 unchanged)');
  const bound = client.values[audit];
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9]], [TENANT_CONTEXT.actor, 'tenant', TENANT, null],
    'the actor, the tenant scope, the context\'s own tenant and no store');
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit']);
});

test('M7A-CUSTOMERS-P7: a customer UPDATE names its own validated target as the audit record\'s subject customer — a create and a tenant command never do', async () => {
  const target = '77777777-7777-4777-8777-777777777777';
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'PATCH', path: '/api/v1/customers/{id}', audience: 'tenant', tenant: TENANT, store: null, actor: TENANT_CONTEXT.actor,
    body: Buffer.from('{}'), target,
  });
  const plan = planCustomerUpdate({ audience: 'tenant', body: { expectedVersion: 4, name: 'Ada Lovelace' }, newAggregateId: randomUUID(), targetId: target });
  const prepared = prepareCommand(CUSTOMER_UPDATE_CONTRACT, defineOutboxEvents([]), plan, {
    scope: operation.scope, lease: digest(), newAggregateId: randomUUID(), authorization: Object.freeze({ scope: 'tenant', permission: 'edit_customers' }),
    context: TENANT_CONTEXT, authNotAfter: null, sessionKey: SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null);
  const updater: AggregateMutator = Object.freeze({ kind: CUSTOMER_UPDATE_CONTRACT.kind, mode: 'update', aggregateType: 'customer', contextScope: 'tenant', apply: async () => 'applied' });
  const client = scripted(prepared.command.lease);
  assert.deepEqual(await tenantStore(client, [updater]).transactions.commit(prepared.command, live()), COMMITTED);
  const audit = client.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(audit >= 0 && client.texts[audit].includes('subject_customer_id') && !client.texts[audit].includes('subject_tenant_id'));
  const bound = client.values[audit];
  assert.equal(bound[bound.length - 1], target, 'the subject is the command\'s own validated target');
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9], bound[10], bound[11]],
    [TENANT_CONTEXT.actor, 'tenant', TENANT, null, 'tenant.customer.update', 'edit_customers'],
    'the trusted actor, the tenant scope and tenant, no store, the contract kind and the route permission');
  assert.deepEqual(bound[bound.length - 2], { json: {} }, 'metadata stays {}: no field name and no value is recorded');
  assert.ok(!bound.some((value) => value === 'Ada Lovelace'), 'the name never reaches the audit record');
  // The caller cannot hand a subject in: the audit record it sends has exactly its own fields.
  const { client: untouchedClient, begins } = untouched();
  assert.deepEqual(await tenantStore(untouchedClient, [updater]).transactions
    .commit({ ...prepared.command, audit: { ...prepared.command.audit, subjectCustomerId: target } } as never, live()), UNAVAILABLE);
  assert.equal(begins(), 0);
});

test('a tenant store refuses every command not of its scope, and the audit scope must equal the context\'s, before any statement', async () => {
  const c = command(TENANT_CONTEXT);
  const store = '44444444-4444-4444-8444-444444444444';
  for (const [label, raw] of [
    ['a platform context', command(TRUSTED)],
    ['a store context', command({ ...TENANT_CONTEXT, scope: 'store', store, roleId: 'technician' })],
    ['a contextless command, whose tenant nothing proves', command()],
    ['a tenant context audited at platform scope', { ...c, audit: { ...c.audit, scope: 'platform' } }],
    ['a tenant context audited at store scope', { ...c, audit: { ...c.audit, scope: 'store', store } }],
    ['a tenant context audited under another tenant', { ...c, audit: { ...c.audit, tenant: '33333333-3333-4333-8333-333333333333' } }],
    ['a read-only tenant context', command({ ...TENANT_CONTEXT, limitation: 'read_only' })],
  ] as const) {
    const { client, begins } = untouched();
    assert.deepEqual(await tenantStore(client).transactions.commit(raw as TransactionCommand, live()), UNAVAILABLE, label);
    assert.equal(begins(), 0, `${label}: no transaction opens`);
  }
});

test('a tenant store needs its revalidator, and no other scope is ever admitted: construction refuses', () => {
  const client = untouched().client;
  for (const options of [
    { client, mutators: [], contextScope: 'tenant' },
    { client, mutators: [], contextScope: 'store', revalidate: async () => true },
    { client, mutators: [], contextScope: 'bogus', revalidate: async () => true },
    { client, mutators: [], contextScope: null, revalidate: async () => true },
  ]) assert.throws(() => createPostgresTransactionalStore(options as never), TypeError, JSON.stringify(options.contextScope));
  assert.doesNotThrow(() => createPostgresTransactionalStore({ client, mutators: [], contextScope: 'platform' }), 'platform is the default, explicit too');
});

test('the mutator is handed the context, session key and recent-sign-in deadline this transaction revalidated — the store\'s frozen copy, never the caller\'s object', async () => {
  const seen: unknown[] = [];
  const capturing: AggregateMutator = Object.freeze({ ...TENANT_CREATE_MUTATOR, apply: async (_sql: PgStatement, _m: unknown, authority: unknown) => { seen.push(authority); return 'applied'; } });
  const c = command(TENANT_CONTEXT);
  assert.deepEqual(await tenantStore(scripted(c.lease), [capturing]).transactions.commit(c, live()), COMMITTED);
  const contextless = command();
  // The administrative store's contextless command, through the same capture declaring platform (R4: one scope per mutator).
  assert.deepEqual(await createPostgresTransactionalStore({ client: scripted(contextless.lease), mutators: [{ ...capturing, contextScope: 'platform' }] }).transactions.commit(contextless, live()), COMMITTED);
  assert.deepEqual(seen, [{ context: TENANT_CONTEXT, sessionKey: SESSION_KEY, authNotAfter: null }, { context: null, sessionKey: null, authNotAfter: null }]);
  // A sensitive command's deadline reaches the mutator as the store checked it (M7A-CUSTOMERS-P3-R1: the role-level edit
  // judges it again after its routine's lock wait).
  const deadline = Date.now() + 60_000;
  const sensitive = { ...command(TENANT_CONTEXT), authNotAfter: deadline };
  assert.deepEqual(await tenantStore(scripted(sensitive.lease), [capturing]).transactions.commit(sensitive, live()), COMMITTED);
  assert.deepEqual(seen.at(-1), { context: TENANT_CONTEXT, sessionKey: SESSION_KEY, authNotAfter: deadline });
  const [authority] = seen as Array<{ context: TrustedScope }>;
  assert.ok(Object.isFrozen(authority) && Object.isFrozen(authority.context), 'frozen');
  assert.notStrictEqual(authority.context, c.context, 'the checked copy the revalidator was handed, not the caller\'s object');
});

test('an audit INSERT that did not insert exactly one row rolls the whole command back — no completion, no COMMIT (decision R6)', async () => {
  for (const [label, audit] of [
    ['no row (a BEFORE INSERT trigger answering NULL)', { count: 0, command: 'INSERT' }],
    ['two rows', { count: 2, command: 'INSERT' }],
    ['not an INSERT', { count: 1, command: 'SELECT' }],
  ] as const) {
    for (const [scope, c, store] of [
      ['platform', command(TRUSTED), (client: SupervisedPgClient) => createPostgresTransactionalStore({ client, mutators: [CREATE_MUTATOR], revalidate: async () => true })],
      ['tenant', command(TENANT_CONTEXT), (client: SupervisedPgClient) => tenantStore(client)],
    ] as const) {
      const client = scripted(c.lease, { audit });
      assert.deepEqual(await store(client).transactions.commit(c, live()), UNAVAILABLE, `${scope}: ${label}`);
      assert.ok(!client.texts.some((t) => t.includes('m6_idempotency_complete')), `${scope}: ${label}: no completion`);
      assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], `${scope}: ${label}: rolled back`);
    }
  }
});

// ---------------------------------------------------------------------------
// M7A-CUSTOMERS-P4 — a precondition that no longer holds: rolled back, NOTHING recorded (DA-125)
// ---------------------------------------------------------------------------

test('precondition_failed from a tenant create rolls everything back with NO completion — unlike the sealed conflict — and from any other shape is the fault', async () => {
  const failing = Object.freeze({ ...TENANT_CREATE_MUTATOR, apply: async () => 'precondition_failed' });
  // The same mutator declaring the administrative scope, for the platform shapes below (R4: one declared scope per mutator).
  const platformFailing = Object.freeze({ ...failing, contextScope: 'platform' as const });
  const c = command(TENANT_CONTEXT);
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [failing]).transactions.commit(c, live()), { outcome: 'precondition_failed' });
  for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event', 'm6_command_enqueue']) {
    assert.ok(!client.texts.some((t) => t.includes(recorded)), `no ${recorded}: nothing is recorded, the key is not terminal`);
  }
  assert.ok(client.texts.some((t) => t.includes('m6_command_fence')), 'decided under the fence');
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], 'rolled back, never committed');
  // The sealed conflict, for contrast: it commits its own completion.
  const sealed = scripted(c.lease);
  assert.deepEqual(await tenantStore(sealed, [Object.freeze({ ...TENANT_CREATE_MUTATOR, apply: async () => 'conflict' })]).transactions.commit(c, live()), { outcome: 'conflict' });
  assert.deepEqual(sealed.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit']);
  assert.ok(sealed.texts.some((t) => t.includes('m6_idempotency_complete')), 'the conflict records its sealed 409');
  // Only a create, in a tenant store, under its revalidated tenant context: a platform command or an update answering it is a fault.
  for (const [label, run] of [
    ['a platform create', () => { const p = command(TRUSTED); return createPostgresTransactionalStore({ client: scripted(p.lease), mutators: [platformFailing], revalidate: async () => true }).transactions.commit(p, live()); }],
    ['a contextless create', () => { const p = command(); return createPostgresTransactionalStore({ client: scripted(p.lease), mutators: [platformFailing] }).transactions.commit(p, live()); }],
    ['an update', () => { const p = renaming(); return createPostgresTransactionalStore({ client: scripted(p.lease), mutators: [tenantMutator('precondition_failed')], revalidate: async () => true }).transactions.commit(p, live()); }],
  ] as const) {
    assert.deepEqual(await run(), UNAVAILABLE, label);
  }
});

// ---------------------------------------------------------------------------
// M7B-INVOICES-P1 — store contexts, a rows change set, the typed sealed 422 and a store create's precondition
// ---------------------------------------------------------------------------

const STORE_ID = '88888888-8888-4888-8888-888888888888';
/** A store context as the tenant authorizer selects one at a store template: the actor's one grant at that store. */
const STORE_CONTEXT: TrustedScope = Object.freeze({ ...TRUSTED, scope: 'store', tenant: TENANT, store: STORE_ID, roleId: 'sales_staff' });
const draftEvents = defineOutboxEvents(INVOICE_DRAFT_EVENTS);
/** The draft create's mutator answering `answer`, declaring `scope` (null: NO declaration — an untyped caller's, which R4 refuses). */
const draftMutator = (answer: string, scope: 'store' | 'tenant' | null = 'store'): AggregateMutator => Object.freeze({
  kind: INVOICE_DRAFT_CREATE_CONTRACT.kind, mode: 'create', aggregateType: 'invoice_draft', ...(scope === null ? {} : { contextScope: scope }),
  apply: async () => answer,
}) as AggregateMutator;
/** A draft create exactly as the runtime prepares one under `context`: the real contract, planner and sealing. */
function drafting(context: TrustedScope | null = STORE_CONTEXT, contract = INVOICE_DRAFT_CREATE_CONTRACT): TransactionCommand {
  const id = randomUUID();
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'POST', path: '/api/v1/stores/{storeId}/invoice-drafts', audience: 'tenant', tenant: TENANT, store: STORE_ID, actor: TRUSTED.actor,
    body: Buffer.from('{}'), target: STORE_ID,
  });
  const plan = planInvoiceDraftCreate({ audience: 'tenant', newAggregateId: id, targetId: STORE_ID, body: {
    expectedTenant: TENANT, customerId: '99999999-9999-4999-8999-999999999999', currency: 'USD',
    lines: [{ description: 'Glass', quantity: 2, unitPriceCents: 50 }, { description: 'Labour', quantity: 1, unitPriceCents: 0 }],
  } });
  const prepared = prepareCommand(contract, draftEvents, plan, {
    scope: operation.scope, lease: digest(), newAggregateId: id, authorization: Object.freeze({ scope: 'store', permission: 'create_invoice_drafts' }),
    context, authNotAfter: null, sessionKey: context === null ? null : SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null);
  return prepared.command;
}

test('M7B-INVOICES-P1 AC-01: a tenant store commits a STORE context only for a store mutator — audited at store scope with its tenant and store, the draft as subject_invoice_draft_id, the rows reaching the mutator deep-frozen', async () => {
  const seen: unknown[] = [];
  const capturing: AggregateMutator = Object.freeze({ ...draftMutator('applied'), apply: async (_sql: PgStatement, m: unknown) => { seen.push(m); return 'applied'; } });
  const c = drafting();
  assert.deepEqual([c.audit.scope, c.audit.tenant, c.audit.store], ['store', TENANT, STORE_ID]);
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [capturing]).transactions.commit(c, live()), COMMITTED);
  const audit = client.texts.findIndex((t) => t.includes('insert into public.audit_event'));
  assert.ok(audit >= 0 && client.texts[audit].includes('subject_invoice_draft_id'));
  assert.ok(!client.texts[audit].includes('subject_customer_id') && !client.texts[audit].includes('subject_tenant_id'), 'exactly one subject');
  const bound = client.values[audit];
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9], bound[10], bound[11], bound[bound.length - 1]],
    [STORE_CONTEXT.actor, 'store', TENANT, STORE_ID, 'store.invoice_draft.create', 'create_invoice_drafts', c.mutation.aggregateId],
    'the actor, the store scope with its tenant and store, the kind, the route permission and the new draft');
  assert.deepEqual(bound[bound.length - 2], { json: {} }, 'metadata {}: no description, amount or customer');
  const enqueue = client.values[client.texts.findIndex((t) => t.includes('m6_command_enqueue'))];
  assert.deepEqual(enqueue.slice(8, 11), [null, null, null], 'the event names no tenant, store or actor');
  assert.deepEqual(enqueue[12], { json: { storeId: STORE_ID, customerId: '99999999-9999-4999-8999-999999999999', lineCount: 2 } });
  const [m] = seen as Array<{ changes: { lines: readonly object[] } }>;
  assert.deepEqual(m.changes.lines, [{ description: 'Glass', quantity: 2, unitPriceCents: 50 }, { description: 'Labour', quantity: 1, unitPriceCents: 0 }]);
  assert.ok(Object.isFrozen(m.changes.lines) && Object.isFrozen(m.changes.lines[0]), 'the store\'s own deep-frozen copy');
  assert.notStrictEqual(m.changes.lines, c.mutation.changes.lines);
});

test('M7B-INVOICES-P1 AC-02: a store mutator refuses a tenant or no context, a tenant mutator a store context, and the administrative store every store command — each before any statement', async () => {
  const s = drafting();
  for (const [label, store, raw] of [
    ['a store context through a mutator declaring tenant', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied', 'tenant')]), s],
    ['a tenant context through a store mutator', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]), drafting(TENANT_CONTEXT)],
    ['a contextless command through a store mutator', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]), drafting(null)],
    ['a store context audited at tenant scope', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]), { ...s, audit: { ...s.audit, scope: 'tenant', store: null } }],
    ['a store context audited at another store', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]), { ...s, audit: { ...s.audit, store: TENANT } }],
    ['the administrative store', (client: SupervisedPgClient) => createPostgresTransactionalStore({ client, mutators: [draftMutator('applied')], revalidate: async () => true }), s],
    ['a read-only store context', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]), drafting({ ...STORE_CONTEXT, limitation: 'read_only' })],
    ['rows that are not plain records', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]),
      { ...s, mutation: { ...s.mutation, changes: { ...s.mutation.changes, lines: [['Glass', 2, 50]] } } }],
    ['51 rows', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]),
      { ...s, mutation: { ...s.mutation, changes: { ...s.mutation.changes, lines: Array.from({ length: 51 }, () => ({ description: 'x', quantity: 1, unitPriceCents: 0 })) } } }],
    ['an update carrying the sealed 422', (client: SupervisedPgClient) => tenantStore(client, [draftMutator('applied')]),
      { ...s, rejected: { ...s.rejected, invalidState: s.rejected.conflict } }],
  ] as const) {
    const { client, begins } = untouched();
    assert.deepEqual(await store(client).transactions.commit(raw as TransactionCommand, live()), UNAVAILABLE, label);
    assert.equal(begins(), 0, `${label}: no transaction opens`);
  }
  assert.throws(() => createPostgresTransactionalStore({ client: untouched().client, mutators: [{ ...draftMutator('applied'), contextScope: 'shop' } as never] }), TypeError);
  // R4: a mutator declaring NO scope never takes the store's — the tenant store and the administrative store both refuse it
  // at construction, before any command (the store-context-through-an-undeclared-mutator case can no longer be built).
  assert.throws(() => tenantStore(untouched().client, [draftMutator('applied', null)]), TypeError, 'the tenant store: no default scope');
  assert.throws(() => createPostgresTransactionalStore({ client: untouched().client, mutators: [draftMutator('applied', null)] }), TypeError, 'the administrative store: no default scope');
});

test('M7B-INVOICES-P1 AC-05: customer_not_found COMMITS exactly the sealed 422 as the completion — no audit, no event — only for a create carrying it; a store create\'s precondition rolls back with nothing', async () => {
  const c = drafting();
  assert.ok(c.rejected.customerNotFound !== null && c.rejected.invalidState === null);
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [draftMutator('customer_not_found')]).transactions.commit(c, live()), { outcome: 'customer_not_found' });
  const completion = client.values[client.texts.findIndex((t) => t.includes('m6_idempotency_complete'))];
  assert.equal(completion[2], c.rejected.customerNotFound, 'the sealed 422 is the completion');
  for (const absent of ['insert into public.audit_event', 'm6_command_enqueue']) assert.ok(!client.texts.some((t) => t.includes(absent)), `no ${absent}`);
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit']);
  // A completion that does not hold commits nothing.
  const lost = scripted(c.lease, { completion: 'lease_lost' });
  assert.deepEqual(await tenantStore(lost, [draftMutator('customer_not_found')]).transactions.commit(c, live()), UNAVAILABLE);
  assert.deepEqual(lost.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
  // A create that did not opt in carries no 422: its mutator answering the word is the fault.
  const { sealedRefusal: _off, ...plain } = INVOICE_DRAFT_CREATE_CONTRACT;
  const unopted = drafting(STORE_CONTEXT, plain);
  assert.equal(unopted.rejected.customerNotFound, null);
  const fault = scripted(unopted.lease);
  assert.deepEqual(await tenantStore(fault, [draftMutator('customer_not_found')]).transactions.commit(unopted, live()), UNAVAILABLE);
  assert.ok(!fault.texts.some((t) => t.includes('m6_idempotency_complete')));
  assert.deepEqual(fault.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
  // A store create's precondition: rolled back, nothing recorded.
  const pre = scripted(c.lease);
  assert.deepEqual(await tenantStore(pre, [draftMutator('precondition_failed')]).transactions.commit(c, live()), { outcome: 'precondition_failed' });
  for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event', 'm6_command_enqueue']) assert.ok(!pre.texts.some((t) => t.includes(recorded)), recorded);
  assert.deepEqual(pre.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
  // 'refused' (the routine's authority refusal) rolls everything back as the generic outage.
  const refused = scripted(c.lease);
  assert.deepEqual(await tenantStore(refused, [draftMutator('refused')]).transactions.commit(c, live()), UNAVAILABLE);
  assert.deepEqual(refused.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
});

// ---------------------------------------------------------------------------
// M7B-INVOICES-P2 — the draft edit: its audit subject, its precondition and its update outcomes
// ---------------------------------------------------------------------------

const EDITED = '66666666-6666-4666-8666-666666666666';
const EDIT_CUSTOMER = '99999999-9999-4999-8999-999999999999';
/** The draft edit's mutator kind answering `answer`, declaring store scope. */
const editMutator = (answer: string, kind = INVOICE_DRAFT_UPDATE_CONTRACT.kind): AggregateMutator =>
  Object.freeze({ kind, mode: 'update', aggregateType: 'invoice_draft', contextScope: 'store', apply: async () => answer });
/** A draft edit exactly as the runtime prepares one under `context`: the real contract, planner and sealing, at version 4. */
function editing(context: TrustedScope = STORE_CONTEXT, contract = INVOICE_DRAFT_UPDATE_CONTRACT): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'PATCH', path: '/api/v1/stores/{storeId}/invoice-drafts/{id}', audience: 'tenant', tenant: TENANT, store: STORE_ID, actor: TRUSTED.actor,
    body: Buffer.from('{}'), target: EDITED,
  });
  const plan = planInvoiceDraftUpdate({ audience: 'tenant', newAggregateId: randomUUID(), targetId: EDITED, storeId: STORE_ID, body: {
    expectedTenant: TENANT, expectedVersion: 4, customerId: EDIT_CUSTOMER,
    lines: [{ description: 'Glass', quantity: 2, unitPriceCents: 50 }, { description: 'Labour', quantity: 1, unitPriceCents: 0 }],
  } });
  const prepared = prepareCommand(contract, draftEvents, plan, {
    scope: operation.scope, lease: digest(), newAggregateId: randomUUID(), authorization: Object.freeze({ scope: 'store', permission: 'edit_invoice_drafts' }),
    context, authNotAfter: null, sessionKey: SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'the edit is in contract');
  return prepared.command;
}

test('M7B-INVOICES-P2 AC-05 (D5, D6): an applied draft edit is audited at store scope with the EDITED draft as subject_invoice_draft_id, then its one invoice_draft.updated event at the new version, then its completion', async () => {
  const c = editing();
  assert.ok(c.unchanged !== null && c.rejected.invalidState !== null && c.rejected.customerNotFound === null, 'an update: unchanged and invalid_state sealed, no 422');
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [editMutator('applied')]).transactions.commit(c, live()), COMMITTED);
  const at = (name: string): number => client.texts.findIndex((t) => t.includes(name));
  assert.ok(at('m6_command_fence') < at('insert into public.audit_event') && at('insert into public.audit_event') < at('m6_command_enqueue')
    && at('m6_command_enqueue') < at('m6_idempotency_complete'), 'fence, audit, event, completion');
  const audit = at('insert into public.audit_event');
  assert.ok(client.texts[audit].includes('subject_invoice_draft_id'), 'the statement names the draft subject column');
  assert.ok(!client.texts[audit].includes('subject_customer_id') && !client.texts[audit].includes('subject_tenant_id'), 'exactly one subject');
  const bound = client.values[audit];
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9], bound[10], bound[11], bound[bound.length - 1]],
    [STORE_CONTEXT.actor, 'store', TENANT, STORE_ID, 'store.invoice_draft.update', 'edit_invoice_drafts', EDITED],
    'the actor, the store scope with its tenant and store, the edit kind, the edit permission and the edited draft');
  assert.deepEqual(bound[bound.length - 2], { json: {} }, 'metadata {}: no description, amount or customer');
  const enqueue = client.values[at('m6_command_enqueue')];
  assert.deepEqual([enqueue[3], enqueue[4], enqueue[5], enqueue[6], enqueue[7]], ['invoice_draft.updated', 1, 'invoice_draft', EDITED, '5'],
    'the edit\'s event, its aggregate the draft, its aggregate version expected + 1');
  assert.deepEqual(enqueue.slice(8, 11), [null, null, null], 'the event names no tenant, store or actor');
  assert.deepEqual(enqueue[12], { json: { storeId: STORE_ID, customerId: EDIT_CUSTOMER, lineCount: 2 } });
  assert.deepEqual(client.values[at('m6_idempotency_complete')], [c.scope, c.lease, c.response]);
  assert.equal(client.texts.filter((t) => t.includes('m6_command_enqueue')).length, 1);
});

test('M7B-INVOICES-P2 AC-06 AC-07 AC-10: a draft edit\'s unchanged, conflict and invalid_state COMMIT only their sealed completion; not_found and refused roll everything back', async () => {
  const c = editing();
  for (const [answer, outcome, sealed] of [
    ['unchanged', { outcome: 'unchanged' }, c.unchanged], ['conflict', { outcome: 'conflict' }, c.rejected.conflict],
    ['invalid_state', { outcome: 'invalid_state' }, c.rejected.invalidState],
  ] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [editMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    assert.deepEqual(client.values[client.texts.findIndex((t) => t.includes('m6_idempotency_complete'))], [c.scope, c.lease, sealed], `${answer}: its own sealed completion`);
    for (const absent of ['insert into public.audit_event', 'm6_command_enqueue']) assert.ok(!client.texts.some((t) => t.includes(absent)), `${answer}: no ${absent}`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit'], answer);
  }
  for (const [answer, outcome] of [['not_found', { outcome: 'not_found' }], ['refused', UNAVAILABLE], ['mismatch', UNAVAILABLE], ['customer_not_found', UNAVAILABLE]] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [editMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event', 'm6_command_enqueue']) {
      assert.ok(!client.texts.some((t) => t.includes(recorded)), `${answer}: no ${recorded}`);
    }
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], answer);
  }
});

test('M7B-INVOICES-P2 (design §2): precondition_failed is admitted from the draft edit\'s kind alone — rolled back with NO completion — and from any other update kind is still the fault', async () => {
  const c = editing();
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [editMutator('precondition_failed')]).transactions.commit(c, live()), { outcome: 'precondition_failed' });
  for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event', 'm6_command_enqueue']) {
    assert.ok(!client.texts.some((t) => t.includes(recorded)), `no ${recorded}: nothing is recorded, the key is not terminal`);
  }
  assert.ok(client.texts.some((t) => t.includes('m6_command_fence')), 'decided under the fence');
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
  // Another store-scope update kind of the same aggregate answering it is the fault: keyed on the kind, never on the mode.
  const otherKind = 'store.invoice_draft.reprice';
  const other = editing(STORE_CONTEXT, Object.freeze({ ...INVOICE_DRAFT_UPDATE_CONTRACT, kind: otherKind }));
  const fault = scripted(other.lease);
  assert.deepEqual(await tenantStore(fault, [editMutator('precondition_failed', otherKind)]).transactions.commit(other, live()), UNAVAILABLE);
  assert.deepEqual(fault.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
  // The customer edit (a tenant-scope update) answering it is still the fault.
  const target = '77777777-7777-4777-8777-777777777777';
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'PATCH', path: '/api/v1/customers/{id}', audience: 'tenant', tenant: TENANT, store: null, actor: TENANT_CONTEXT.actor, body: Buffer.from('{}'), target,
  });
  const customer = prepareCommand(CUSTOMER_UPDATE_CONTRACT, defineOutboxEvents([]),
    planCustomerUpdate({ audience: 'tenant', body: { expectedVersion: 4, name: 'Ada' }, newAggregateId: randomUUID(), targetId: target }), {
      scope: operation.scope, lease: digest(), newAggregateId: randomUUID(), authorization: Object.freeze({ scope: 'tenant', permission: 'edit_customers' }),
      context: TENANT_CONTEXT, authNotAfter: null, sessionKey: SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
    });
  assert.ok(customer !== null, 'the customer edit is in contract');
  const updater: AggregateMutator = Object.freeze({ kind: CUSTOMER_UPDATE_CONTRACT.kind, mode: 'update', aggregateType: 'customer', contextScope: 'tenant', apply: async () => 'precondition_failed' });
  assert.deepEqual(await tenantStore(scripted(customer.command.lease), [updater]).transactions.commit(customer.command, live()), UNAVAILABLE);
});

test('M7B-INVOICES-P2, M7B-INVOICES-DISCARD-P1, M7B-INVOICES-ISSUE-P1, M7B-INVOICES-VOID-P1 (design §2): the update kinds the store admits precondition_failed from and app.ts\'s 409 mapping\'s kinds are one closed set — exactly the draft edit\'s, the draft discard\'s, the invoice issue\'s and the invoice void\'s contract kinds; a drift in any of them fails here', () => {
  // The issue's contract (invoiceIssuing.ts INVOICE_ISSUE_CONTRACT, kind store.invoice.issue) and the void's (invoiceVoid.ts
  // INVOICE_VOID_CONTRACT, kind store.invoice.void) are pinned by their kinds here.
  const contracts = [INVOICE_DRAFT_UPDATE_CONTRACT.kind, INVOICE_DRAFT_DISCARD_CONTRACT.kind, 'store.invoice.issue', 'store.invoice.void'];
  assert.deepEqual([...PRECONDITION_UPDATE_KINDS].sort(), [...contracts].sort(), 'the store\'s');
  assert.deepEqual([...APP_PRECONDITION_UPDATE_KINDS].sort(), [...contracts].sort(), 'app.ts\'s');
  assert.deepEqual([...APP_PRECONDITION_UPDATE_KINDS], [...PRECONDITION_UPDATE_KINDS], 'the two copies, in one order');
  assert.deepEqual(contracts, ['store.invoice_draft.update', 'store.invoice_draft.discard', 'store.invoice.issue', 'store.invoice.void'], 'the contracts\', as the audit action ids migrations 029, 033, 034 and 035 document');
  assert.ok(Object.isFrozen(PRECONDITION_UPDATE_KINDS) && Object.isFrozen(APP_PRECONDITION_UPDATE_KINDS), 'frozen');
  for (const kind of ['store.invoice_draft.create', 'store.invoice_draft.reprice', 'tenant.customer.update', '']) {
    assert.equal(PRECONDITION_UPDATE_KINDS.includes(kind) || APP_PRECONDITION_UPDATE_KINDS.includes(kind), false, `closed: ${kind}`);
  }
});

// ---------------------------------------------------------------------------
// M7B-INVOICES-DISCARD-P1 — the draft discard: its audit record, NO event, its sealed and rolled-back outcomes
// ---------------------------------------------------------------------------

/** The draft discard's mutator answering `answer`, declaring store scope. */
const discardMutator = (answer: string): AggregateMutator =>
  Object.freeze({ kind: INVOICE_DRAFT_DISCARD_CONTRACT.kind, mode: 'update', aggregateType: 'invoice_draft', contextScope: 'store', apply: async () => answer });
/** A draft discard exactly as the runtime prepares one: the real contract, planner and sealing, at version 4. */
function discarding(): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'POST', path: '/api/v1/stores/{storeId}/invoice-drafts/{id}/discard', audience: 'tenant', tenant: TENANT, store: STORE_ID, actor: TRUSTED.actor,
    body: Buffer.from('{}'), target: EDITED,
  });
  const plan = planInvoiceDraftDiscard({ audience: 'tenant', newAggregateId: randomUUID(), targetId: EDITED, storeId: STORE_ID,
    body: { expectedTenant: TENANT, expectedVersion: 4 } });
  const prepared = prepareCommand(INVOICE_DRAFT_DISCARD_CONTRACT, draftEvents, plan, {
    scope: operation.scope, lease: digest(), newAggregateId: randomUUID(), authorization: Object.freeze({ scope: 'store', permission: 'discard_invoice_drafts' }),
    context: STORE_CONTEXT, authNotAfter: null, sessionKey: SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'the discard is in contract');
  return prepared.command;
}

test('M7B-INVOICES-DISCARD-P1 DSC-01 DSC-24 (D-DIS-4): an applied draft discard writes exactly one audit record — store scope, its tenant and store, the actor, action store.invoice_draft.discard, permission discard_invoice_drafts, the DISCARDED draft as subject_invoice_draft_id, metadata {} — then its completion, and enqueues NOTHING: its contract declares no event', async () => {
  const c = discarding();
  assert.deepEqual([c.events.length, c.unchanged, c.rejected.invalidState !== null, c.rejected.customerNotFound], [0, null, true, null],
    'an update with no event, no unchanged answer, invalid_state sealed and no 422');
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [discardMutator('applied')]).transactions.commit(c, live()), COMMITTED);
  const at = (name: string): number => client.texts.findIndex((t) => t.includes(name));
  assert.ok(at('m6_command_fence') < at('insert into public.audit_event') && at('insert into public.audit_event') < at('m6_idempotency_complete'), 'fence, audit, completion');
  assert.equal(client.texts.filter((t) => t.includes('m6_command_enqueue')).length, 0, 'no outbox row: nothing is enqueued, and no dummy event');
  assert.equal(client.texts.filter((t) => t.includes('insert into public.audit_event')).length, 1, 'exactly one audit record');
  const audit = at('insert into public.audit_event');
  assert.ok(client.texts[audit].includes('subject_invoice_draft_id'), 'the statement names the draft subject column');
  assert.ok(!client.texts[audit].includes('subject_customer_id') && !client.texts[audit].includes('subject_tenant_id'), 'exactly one subject');
  const bound = client.values[audit];
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9], bound[10], bound[11], bound[bound.length - 1]],
    [STORE_CONTEXT.actor, 'store', TENANT, STORE_ID, 'store.invoice_draft.discard', 'discard_invoice_drafts', EDITED],
    'the actor, the store scope with its tenant and store, the discard kind, the discard permission and the discarded draft');
  assert.deepEqual(bound[bound.length - 2], { json: {} }, 'metadata {}: no reason, description, amount or customer');
  assert.deepEqual(client.values[at('m6_idempotency_complete')], [c.scope, c.lease, c.response]);
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit']);
});

test('M7B-INVOICES-DISCARD-P1 DSC-06 DSC-10 (D-DIS-3): a draft discard\'s conflict and invalid_state COMMIT only their sealed completion; precondition_failed (its kind admitted) rolls back with NO completion; not_found, refused, unchanged and anything else roll everything back', async () => {
  const c = discarding();
  for (const [answer, outcome, sealed] of [['conflict', { outcome: 'conflict' }, c.rejected.conflict], ['invalid_state', { outcome: 'invalid_state' }, c.rejected.invalidState]] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [discardMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    assert.deepEqual(client.values[client.texts.findIndex((t) => t.includes('m6_idempotency_complete'))], [c.scope, c.lease, sealed], `${answer}: its own sealed completion`);
    for (const absent of ['insert into public.audit_event', 'm6_command_enqueue']) assert.ok(!client.texts.some((t) => t.includes(absent)), `${answer}: no ${absent}`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit'], answer);
  }
  for (const [answer, outcome] of [['precondition_failed', { outcome: 'precondition_failed' }], ['not_found', { outcome: 'not_found' }], ['refused', UNAVAILABLE],
    ['unchanged', UNAVAILABLE], ['mismatch', UNAVAILABLE], ['customer_not_found', UNAVAILABLE]] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [discardMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event', 'm6_command_enqueue']) {
      assert.ok(!client.texts.some((t) => t.includes(recorded)), `${answer}: no ${recorded}`);
    }
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], answer);
  }
});

// ---------------------------------------------------------------------------
// M7B-INVOICES-ISSUE-P1 — the issue (an opted-in update, the audit triple) and the settings write (a create naming its store)
// ---------------------------------------------------------------------------

const ISSUE_INVOICE = 'efefefef-efef-4fef-8fef-efefefefefef';
const ISSUE_CUSTOMER = 'abababab-abab-4bab-8bab-abababababab';
const ID_STRING = Object.freeze({ type: 'string', maxLength: 36 } as const);
const VERSION_INTEGER = Object.freeze({ type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER } as const);
/** The issue's contract as the interface pins it (invoiceIssuing.ts): an opted-in store update of the draft, no event. */
const ISSUE_CONTRACT_DEF = Object.freeze({
  kind: 'store.invoice.issue', mode: 'update', aggregateType: 'invoice_draft', events: Object.freeze([]), contextScope: 'store', issuingRefusals: true,
  changes: Object.freeze({ expectedTenant: ID_STRING, expectedSettingsVersion: VERSION_INTEGER, expectedCustomerVersion: VERSION_INTEGER, invoiceId: ID_STRING }),
});
/** The settings write's contract shape (issuingSettings.ts), reduced to the fields the store reads: a tenant create, no event. */
const SETTINGS_CONTRACT_DEF = Object.freeze({
  kind: 'tenant.issuing_settings.update', mode: 'create', aggregateType: 'store_issuing_settings_change', events: Object.freeze([]), contextScope: 'tenant',
  changes: Object.freeze({ storeId: ID_STRING, expectedTenant: ID_STRING }),
});
const issuingCommands = defineCommands([ISSUE_CONTRACT_DEF, SETTINGS_CONTRACT_DEF], defineOutboxEvents([]));
const issueMutator = (answer: unknown, over: Record<string, unknown> = {}): AggregateMutator => Object.freeze({
  kind: 'store.invoice.issue', mode: 'update', aggregateType: 'invoice_draft', contextScope: 'store', issuingRefusals: true, auditSubjects: 'issued_invoice',
  apply: async () => answer, ...over,
}) as AggregateMutator;
const settingsMutator = (answer: unknown, over: Record<string, unknown> = {}): AggregateMutator => Object.freeze({
  kind: 'tenant.issuing_settings.update', mode: 'create', aggregateType: 'store_issuing_settings_change', contextScope: 'tenant', auditSubjects: 'store',
  apply: async () => answer, ...over,
}) as AggregateMutator;
const APPLIED_ISSUE = Object.freeze({ outcome: 'applied', subjectCustomerId: ISSUE_CUSTOMER });

/** An issue exactly as the runtime prepares one: the opted-in contract, at version 4, its invoice id `invoiceId`. */
function issuing(invoiceId = ISSUE_INVOICE): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'POST', path: '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue', audience: 'tenant', tenant: TENANT, store: STORE_ID, actor: TRUSTED.actor,
    body: Buffer.from('{}'), target: EDITED,
  });
  const prepared = prepareCommand(issuingCommands.contract('store.invoice.issue') as never, defineOutboxEvents([]), {
    aggregateId: EDITED, expectedVersion: 4, events: [],
    changes: { expectedTenant: TENANT, expectedSettingsVersion: 2, expectedCustomerVersion: 3, invoiceId },
    response: { status: 201, body: { invoice: { id: invoiceId, sourceDraftId: EDITED, status: 'issued' } }, headers: { location: `/api/v1/stores/${STORE_ID}/invoices/${invoiceId}` } },
  }, {
    scope: operation.scope, lease: digest(), newAggregateId: invoiceId, authorization: Object.freeze({ scope: 'store', permission: 'issue_invoices' }),
    context: STORE_CONTEXT, authNotAfter: null, sessionKey: SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'the issue is in contract');
  return prepared.command;
}
/** A settings write exactly as the runtime prepares one: a tenant create naming `storeId`. */
function configuring(storeId = STORE_ID): TransactionCommand {
  const id = randomUUID();
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'PUT', path: '/api/v1/issuing-settings/{id}', audience: 'tenant', tenant: TENANT, store: null, actor: TRUSTED.actor, body: Buffer.from('{}'), target: STORE_ID,
  });
  const prepared = prepareCommand(issuingCommands.contract('tenant.issuing_settings.update') as never, defineOutboxEvents([]), {
    aggregateId: id, expectedVersion: null, events: [], changes: { storeId, expectedTenant: TENANT },
    response: { status: 200, body: { issuingSettings: { storeId, version: 1, configured: true } } },
  }, {
    scope: operation.scope, lease: digest(), newAggregateId: id, authorization: Object.freeze({ scope: 'tenant', permission: 'edit_issuing_settings' }),
    context: TENANT_CONTEXT, authNotAfter: null, sessionKey: SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'the settings write is in contract');
  return prepared.command;
}

test('M7B-INVOICES-ISSUE-P1: the mutator table admits issuingRefusals on an update alone, the issued-invoice subjects on a store-scope invoice_draft update alone and the store subject on a tenant-scope create alone — every other declaration is refused', () => {
  const client = untouched().client;
  const omitting = (key: string): AggregateMutator => Object.fromEntries(Object.entries(issueMutator('applied')).filter(([k]) => k !== key)) as never;
  for (const mutator of [issueMutator('applied'), settingsMutator('applied'), omitting('auditSubjects'), omitting('issuingRefusals')]) {
    assert.doesNotThrow(() => tenantStore(client, [mutator]), JSON.stringify(Object.keys(mutator)));
  }
  for (const [label, mutator] of [
    ['issuingRefusals on a create', settingsMutator('applied', { issuingRefusals: true })],
    ['issuingRefusals false', issueMutator('applied', { issuingRefusals: false })],
    ['issuingRefusals as a word', issueMutator('applied', { issuingRefusals: 'yes' })],
    ['issuingRefusals undefined', issueMutator('applied', { issuingRefusals: undefined })],
    ['the issued-invoice subjects on a create', Object.freeze({ ...omitting('issuingRefusals'), mode: 'create' }) as AggregateMutator],
    ['the issued-invoice subjects on another aggregate', issueMutator('applied', { aggregateType: 'customer' })],
    ['the issued-invoice subjects at tenant scope', issueMutator('applied', { contextScope: 'tenant' })],
    ['the store subject on an update', settingsMutator('applied', { mode: 'update' })],
    ['the store subject at store scope', settingsMutator('applied', { contextScope: 'store' })],
    ['an unknown subject word', settingsMutator('applied', { auditSubjects: 'tenant' })],
    ['an undefined subject word', issueMutator('applied', { auditSubjects: undefined })],
    ['a third declaration', issueMutator('applied', { sealedRefusal: 'customer_not_found' })],
  ] as const) {
    assert.throws(() => tenantStore(client, [mutator]), TypeError, label);
  }
});

test('M7B-INVOICES-ISSUE-P1 §10.9: an applied issue writes exactly ONE audit record through the triple statement — the draft, the command\'s own invoice id and the customer its mutator\'s verified answer names — no event, then its completion', async () => {
  const c = issuing();
  assert.deepEqual(Object.keys(c.rejected).sort(), ['amountOutOfRange', 'conflict', 'customerNotFound', 'invalidState', 'issuingNotConfigured']);
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [issueMutator(APPLIED_ISSUE)]).transactions.commit(c, live()), COMMITTED);
  const at = (name: string): number => client.texts.findIndex((t) => t.includes(name));
  assert.ok(at('m6_command_fence') < at('insert into public.audit_event') && at('insert into public.audit_event') < at('m6_idempotency_complete'), 'fence, audit, completion');
  assert.equal(client.texts.filter((t) => t.includes('insert into public.audit_event')).length, 1, 'exactly one audit record');
  assert.equal(client.texts.filter((t) => t.includes('m6_command_enqueue')).length, 0, 'no event');
  const audit = client.texts[at('insert into public.audit_event')];
  assert.match(audit, /metadata,\s*subject_invoice_draft_id,\s*subject_issued_invoice_id,\s*subject_customer_id\s*\)/, 'the triple statement');
  assert.ok(!audit.includes('subject_tenant_id') && !audit.includes('subject_store_id'), 'no other subject column');
  const bound = client.values[at('insert into public.audit_event')];
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9], bound[10], bound[11]], [STORE_CONTEXT.actor, 'store', TENANT, STORE_ID, 'store.invoice.issue', 'issue_invoices']);
  assert.deepEqual(bound.slice(-3), [EDITED, ISSUE_INVOICE, ISSUE_CUSTOMER], 'the draft, the issued invoice and the customer, in that order');
  assert.deepEqual(client.values[at('m6_idempotency_complete')], [c.scope, c.lease, c.response]);
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit']);
});

test('M7B-INVOICES-ISSUE-P1: the object form is the issue mutator\'s only applied answer and no other mutator\'s — its bare word, a malformed customer and an object from any other mutator roll everything back', async () => {
  const c = issuing();
  for (const [label, answer] of [
    ['the bare word', 'applied'],
    ['a customer that is no uuid', { outcome: 'applied', subjectCustomerId: 'not-a-uuid' }],
    ['an uppercase customer', { outcome: 'applied', subjectCustomerId: ISSUE_CUSTOMER.toUpperCase() }],
    ['a missing customer', { outcome: 'applied' }],
    ['an extra field', { ...APPLIED_ISSUE, subjectInvoiceId: ISSUE_INVOICE }],
    ['another word in the object', { outcome: 'conflict', subjectCustomerId: ISSUE_CUSTOMER }],
    ['a customer number', { outcome: 'applied', subjectCustomerId: 7 }],
  ] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [issueMutator(answer)]).transactions.commit(c, live()), UNAVAILABLE, label);
    for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event']) assert.ok(!client.texts.some((t) => t.includes(recorded)), `${label}: no ${recorded}`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], label);
  }
  // The discard (no declared subjects) answering the object form is the fault too.
  const d = discarding();
  const client = scripted(d.lease);
  assert.deepEqual(await tenantStore(client, [discardMutator(APPLIED_ISSUE as never)]).transactions.commit(d, live()), UNAVAILABLE);
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
});

test('M7B-INVOICES-ISSUE-P1 §10.6: the issue\'s issuing_not_configured and amount_out_of_range COMMIT only their own sealed 409 — as conflict and invalid_state do; precondition_failed (its kind admitted) and not_found roll back; a mutator that did not opt in answering either word commits nothing', async () => {
  const c = issuing();
  for (const [answer, outcome, sealed] of [
    ['issuing_not_configured', { outcome: 'issuing_not_configured' }, c.rejected.issuingNotConfigured],
    ['amount_out_of_range', { outcome: 'amount_out_of_range' }, c.rejected.amountOutOfRange],
    ['conflict', { outcome: 'conflict' }, c.rejected.conflict], ['invalid_state', { outcome: 'invalid_state' }, c.rejected.invalidState],
  ] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [issueMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    assert.deepEqual(client.values[client.texts.findIndex((t) => t.includes('m6_idempotency_complete'))], [c.scope, c.lease, sealed], `${answer}: its own sealed completion`);
    for (const absent of ['insert into public.audit_event', 'm6_command_enqueue']) assert.ok(!client.texts.some((t) => t.includes(absent)), `${answer}: no ${absent}`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit'], answer);
    // A completion that does not hold commits nothing.
    const lost = scripted(c.lease, { completion: 'lease_lost' });
    assert.deepEqual(await tenantStore(lost, [issueMutator(answer)]).transactions.commit(c, live()), UNAVAILABLE, `${answer}: lost`);
    assert.deepEqual(lost.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], `${answer}: lost`);
  }
  assert.notEqual(c.rejected.issuingNotConfigured, c.rejected.amountOutOfRange, 'two distinct sealed refusals');
  for (const [answer, outcome] of [['precondition_failed', { outcome: 'precondition_failed' }], ['not_found', { outcome: 'not_found' }], ['refused', UNAVAILABLE],
    ['unchanged', UNAVAILABLE], ['customer_not_found', UNAVAILABLE], ['mismatch', UNAVAILABLE]] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [issueMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event']) assert.ok(!client.texts.some((t) => t.includes(recorded)), `${answer}: no ${recorded}`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], answer);
  }
  // The discard (not opted in) answering either word: rolled back, nothing recorded.
  const d = discarding();
  for (const answer of ['issuing_not_configured', 'amount_out_of_range']) {
    const client = scripted(d.lease);
    assert.deepEqual(await tenantStore(client, [discardMutator(answer)]).transactions.commit(d, live()), UNAVAILABLE, answer);
    assert.ok(!client.texts.some((t) => t.includes('m6_idempotency_complete')), `${answer}: no completion`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], answer);
  }
});

test('M7B-INVOICES-ISSUE-P1: an opted-in mutator\'s command carries exactly five sealed slots and every other command exactly three — a mismatch either way, a 422 slot on the issue, a missing 409 and a non-canonical invoice id are refused before any statement', async () => {
  const { client, begins } = untouched();
  const issue = issuing();
  const d = discarding();
  const { issuingNotConfigured: _a, amountOutOfRange: _b, ...three } = issue.rejected;
  const store = tenantStore(client, [issueMutator(APPLIED_ISSUE), discardMutator('applied')]);
  for (const [label, command] of [
    ['the issue carrying three slots', { ...issue, rejected: three }],
    ['the issue carrying a 422 slot', { ...issue, rejected: { ...issue.rejected, customerNotFound: issue.rejected.conflict } }],
    ['the issue with no issuing_not_configured response', { ...issue, rejected: { ...issue.rejected, issuingNotConfigured: null } }],
    ['the issue with an empty amount_out_of_range response', { ...issue, rejected: { ...issue.rejected, amountOutOfRange: '' } }],
    ['the issue with an unsealed response', { ...issue, rejected: { ...issue.rejected, amountOutOfRange: 'a=b' } }],
    ['the issue with a sixth slot', { ...issue, rejected: { ...issue.rejected, unpaid: issue.rejected.conflict } }],
    ['the discard carrying five slots', { ...d, rejected: { ...d.rejected, issuingNotConfigured: d.rejected.conflict, amountOutOfRange: d.rejected.conflict } }],
    ['an uppercase invoice id', issuing(ISSUE_INVOICE.toUpperCase())],
    ['an invoice id that is no uuid', issuing('x'.repeat(36))],
  ] as const) {
    assert.deepEqual(await store.transactions.commit(command as never, live()), UNAVAILABLE, label);
  }
  assert.equal(begins(), 0, 'no transaction was opened');
});

test('M7B-INVOICES-ISSUE-P1 §10.9: an applied settings write is audited at TENANT scope through the store statement — subject_store_id alone, its validated change-set store — with no event', async () => {
  const c = configuring();
  assert.deepEqual(Object.keys(c.rejected).sort(), ['conflict', 'customerNotFound', 'invalidState'], 'a create carries exactly three slots');
  const client = scripted(c.lease);
  assert.deepEqual(await tenantStore(client, [settingsMutator('applied')]).transactions.commit(c, live()), COMMITTED);
  const at = (name: string): number => client.texts.findIndex((t) => t.includes(name));
  const audit = client.texts[at('insert into public.audit_event')];
  assert.match(audit, /metadata,\s*subject_store_id\s*\)/, 'the store statement');
  for (const other of ['subject_tenant_id', 'subject_customer_id', 'subject_invoice_draft_id', 'subject_issued_invoice_id']) assert.ok(!audit.includes(other), `no ${other}`);
  const bound = client.values[at('insert into public.audit_event')];
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9], bound[10], bound[11], bound[bound.length - 1]],
    [TENANT_CONTEXT.actor, 'tenant', TENANT, null, 'tenant.issuing_settings.update', 'edit_issuing_settings', STORE_ID]);
  assert.equal(client.texts.filter((t) => t.includes('m6_command_enqueue')).length, 0, 'no event');
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit']);
  // A change-set store that is not a canonical uuid is refused before any statement.
  const { client: never, begins } = untouched();
  assert.deepEqual(await tenantStore(never, [settingsMutator('applied')]).transactions.commit(configuring('cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'.toUpperCase()), live()), UNAVAILABLE);
  assert.equal(begins(), 0);
});

test('M7B-INVOICES-ISSUE-P1: not_found is admitted from the settings write\'s create kind alone — rolled back with nothing recorded — and from any other create is still the fault; its precondition rolls back and its conflict is sealed', async () => {
  const c = configuring();
  for (const [answer, outcome, recorded] of [['not_found', { outcome: 'not_found' }, false], ['precondition_failed', { outcome: 'precondition_failed' }, false],
    ['conflict', { outcome: 'conflict' }, true], ['invalid_state', UNAVAILABLE, false], ['issuing_not_configured', UNAVAILABLE, false], ['customer_not_found', UNAVAILABLE, false]] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [settingsMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    assert.equal(client.texts.some((t) => t.includes('m6_idempotency_complete')), recorded, `${answer}: completion ${recorded}`);
    assert.ok(!client.texts.some((t) => t.includes('insert into public.audit_event')), `${answer}: no audit`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), [recorded ? 'commit' : 'rollback'], answer);
  }
  // The customer create (a tenant create of another kind) answering not_found is the fault.
  const other = command(TENANT_CONTEXT);
  const client = scripted(other.lease);
  assert.deepEqual(await tenantStore(client, [Object.freeze({ ...TENANT_CREATE_MUTATOR, apply: async () => 'not_found' })]).transactions.commit(other, live()), UNAVAILABLE);
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback']);
});

test('M7B-INVOICES-ISSUE-P1: the create kinds the store admits not_found from and app.ts\'s 404 mapping\'s kinds are one closed set — exactly the settings write\'s', () => {
  assert.deepEqual([...NOT_FOUND_CREATE_KINDS], ['tenant.issuing_settings.update'], 'the store\'s');
  assert.deepEqual([...APP_NOT_FOUND_CREATE_KINDS], [...NOT_FOUND_CREATE_KINDS], 'app.ts\'s');
  assert.ok(Object.isFrozen(NOT_FOUND_CREATE_KINDS) && Object.isFrozen(APP_NOT_FOUND_CREATE_KINDS), 'frozen');
  for (const kind of ['store.invoice_draft.create', 'tenant.customer.create', 'tenant.role_levels.update', 'store.invoice.issue', '']) {
    assert.equal(NOT_FOUND_CREATE_KINDS.includes(kind) || APP_NOT_FOUND_CREATE_KINDS.includes(kind), false, `closed: ${kind}`);
  }
});

// ---------------------------------------------------------------------------
// M7B-INVOICES-VOID-P1 — the void: an issued_invoice update at store scope, audited with its invoice ALONE
// ---------------------------------------------------------------------------

const VOID_TARGET = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
/** The void's contract as the interface pins it (invoiceVoid.ts INVOICE_VOID_CONTRACT): a store update of the issued invoice, no event. */
const VOID_CONTRACT_DEF = Object.freeze({
  kind: 'store.invoice.void', mode: 'update', aggregateType: 'issued_invoice', events: Object.freeze([]), contextScope: 'store',
  changes: Object.freeze({ expectedTenant: ID_STRING, reasonCode: Object.freeze({ type: 'enum', values: Object.freeze(['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other']) }) }),
});
const voidCommands = defineCommands([VOID_CONTRACT_DEF], defineOutboxEvents([]));
const voidMutator = (answer: unknown, over: Record<string, unknown> = {}): AggregateMutator => Object.freeze({
  kind: 'store.invoice.void', mode: 'update', aggregateType: 'issued_invoice', contextScope: 'store', auditSubjects: 'voided_invoice',
  apply: async () => answer, ...over,
}) as AggregateMutator;

/** A void exactly as the runtime prepares one: the contract at version 1, its target `invoiceId`, a recent-sign-in deadline. */
function voiding(invoiceId = VOID_TARGET): TransactionCommand {
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'unit', authProviderUid: 'actor' }), {
    method: 'POST', path: '/api/v1/stores/{storeId}/invoices/{id}/void', audience: 'tenant', tenant: TENANT, store: STORE_ID, actor: TRUSTED.actor,
    body: Buffer.from('{}'), target: invoiceId,
  });
  const prepared = prepareCommand(voidCommands.contract('store.invoice.void') as never, defineOutboxEvents([]), {
    aggregateId: invoiceId, expectedVersion: 1, events: [], changes: { expectedTenant: TENANT, reasonCode: 'duplicate' },
    response: { status: 200, body: { invoice: { id: invoiceId, status: 'voided' } } },
    audit: { reasonCode: 'invoice_void_duplicate', reason: 'Issued invoice voided. Reason: Duplicate of another invoice.' },
  }, {
    scope: operation.scope, lease: digest(), newAggregateId: randomUUID(), authorization: Object.freeze({ scope: 'store', permission: 'void_issued_invoices' }),
    context: STORE_CONTEXT, authNotAfter: 1_700_000_000_000, sessionKey: SESSION_KEY, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(prepared !== null, 'the void is in contract');
  return prepared.command;
}

test('M7B-INVOICES-VOID-P1: the mutator table admits the voided-invoice subject on a store-scope issued_invoice update alone — on a create, another aggregate type or another scope it is refused', () => {
  const client = untouched().client;
  assert.doesNotThrow(() => tenantStore(client, [voidMutator('applied')]), 'the void mutator');
  for (const [label, mutator] of [
    ['on a create', voidMutator('applied', { mode: 'create' })],
    ['on an invoice_draft update', voidMutator('applied', { aggregateType: 'invoice_draft' })],
    ['on a customer update', voidMutator('applied', { aggregateType: 'customer' })],
    ['at tenant scope', voidMutator('applied', { contextScope: 'tenant' })],
    ['at platform scope', voidMutator('applied', { contextScope: 'platform' })],
    ['the issued-invoice word on the void\'s aggregate', voidMutator('applied', { auditSubjects: 'issued_invoice' })],
    ['the store word on the void\'s aggregate', voidMutator('applied', { auditSubjects: 'store' })],
    ['a near word', voidMutator('applied', { auditSubjects: 'voided_invoices' })],
  ] as const) {
    assert.throws(() => tenantStore(client, [mutator]), TypeError, label);
  }
});

test('M7B-INVOICES-VOID-P1: an applied void writes exactly ONE audit record naming its issued invoice ALONE — the checked aggregate id, no draft, customer, tenant or store subject — no event, then its completion; the revalidator is handed the deadline', async () => {
  const c = voiding();
  assert.deepEqual(Object.keys(c.rejected).sort(), ['conflict', 'customerNotFound', 'invalidState'], 'an update carries exactly three slots');
  const client = scripted(c.lease);
  const seen: unknown[] = [];
  const store = createPostgresTransactionalStore({
    client: client as never, mutators: [voidMutator('applied')], contextScope: 'tenant',
    revalidate: async (_sql, scope, permission, authNotAfter, key) => { seen.push([scope.scope, permission, authNotAfter, key]); return true; },
  });
  assert.deepEqual(await store.transactions.commit(c, live()), COMMITTED);
  assert.deepEqual(seen, [['store', 'void_issued_invoices', 1_700_000_000_000, SESSION_KEY]], 'the sensitive key\'s deadline reaches the revalidator');
  const at = (name: string): number => client.texts.findIndex((t) => t.includes(name));
  assert.ok(at('m6_command_fence') < at('insert into public.audit_event') && at('insert into public.audit_event') < at('m6_idempotency_complete'), 'fence, audit, completion');
  assert.equal(client.texts.filter((t) => t.includes('insert into public.audit_event')).length, 1, 'exactly one audit record');
  assert.equal(client.texts.filter((t) => t.includes('m6_command_enqueue')).length, 0, 'no event');
  const audit = client.texts[at('insert into public.audit_event')];
  assert.match(audit, /metadata,\s*subject_issued_invoice_id\s*\)/, 'the issued-invoice-alone statement');
  for (const other of ['subject_tenant_id', 'subject_customer_id', 'subject_invoice_draft_id', 'subject_store_id']) assert.ok(!audit.includes(other), `no ${other}`);
  const bound = client.values[at('insert into public.audit_event')];
  assert.deepEqual([bound[4], bound[7], bound[8], bound[9], bound[10], bound[11]], [STORE_CONTEXT.actor, 'store', TENANT, STORE_ID, 'store.invoice.void', 'void_issued_invoices']);
  assert.deepEqual([bound[13], bound[14]], ['invoice_void_duplicate', 'Issued invoice voided. Reason: Duplicate of another invoice.'], 'the annex pair');
  assert.equal(bound[bound.length - 1], VOID_TARGET, 'the invoice, from the checked aggregate id');
  assert.deepEqual(client.values[at('m6_idempotency_complete')], [c.scope, c.lease, c.response]);
  assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit']);
});

test('M7B-INVOICES-VOID-P1: the void answers bare words only — the object form from it is the fault; the update vocabulary applies (conflict and invalid_state sealed; not_found and precondition_failed rolled back; anything else unavailable)', async () => {
  const c = voiding();
  for (const [label, answer] of [
    ['the issue\'s object form', { outcome: 'applied', subjectCustomerId: ISSUE_CUSTOMER }],
    ['an object naming the invoice', { outcome: 'applied', subjectIssuedInvoiceId: VOID_TARGET }],
    ['a bare object', { outcome: 'applied' }],
  ] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [voidMutator(answer)]).transactions.commit(c, live()), UNAVAILABLE, label);
    for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event']) assert.ok(!client.texts.some((t) => t.includes(recorded)), `${label}: no ${recorded}`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], label);
  }
  for (const [answer, outcome, sealed] of [['conflict', { outcome: 'conflict' }, c.rejected.conflict], ['invalid_state', { outcome: 'invalid_state' }, c.rejected.invalidState]] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [voidMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    assert.deepEqual(client.values[client.texts.findIndex((t) => t.includes('m6_idempotency_complete'))], [c.scope, c.lease, sealed], `${answer}: its own sealed completion`);
    assert.ok(!client.texts.some((t) => t.includes('insert into public.audit_event')), `${answer}: no audit`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['commit'], answer);
  }
  for (const [answer, outcome] of [['not_found', { outcome: 'not_found' }], ['precondition_failed', { outcome: 'precondition_failed' }], ['refused', UNAVAILABLE],
    ['mismatch', UNAVAILABLE], ['unchanged', UNAVAILABLE], ['issuing_not_configured', UNAVAILABLE], ['customer_not_found', UNAVAILABLE]] as const) {
    const client = scripted(c.lease);
    assert.deepEqual(await tenantStore(client, [voidMutator(answer)]).transactions.commit(c, live()), outcome, answer);
    for (const recorded of ['m6_idempotency_complete', 'insert into public.audit_event']) assert.ok(!client.texts.some((t) => t.includes(recorded)), `${answer}: no ${recorded}`);
    assert.deepEqual(client.texts.filter((t) => t === 'commit' || t === 'rollback'), ['rollback'], answer);
  }
});

test('M7B-INVOICES-VOID-P1: a void whose aggregate id is not a canonical uuid names no subject — refused before any statement', async () => {
  const { client, begins } = untouched();
  const store = tenantStore(client, [voidMutator('applied')]);
  const c = voiding();
  for (const [label, aggregateId] of [['uppercase', VOID_TARGET.toUpperCase()], ['no uuid', 'x'.repeat(36)]] as const) {
    assert.deepEqual(await store.transactions.commit({ ...c, aggregateId } as never, live()), UNAVAILABLE, label);
  }
  assert.equal(begins(), 0, 'no transaction was opened');
});
