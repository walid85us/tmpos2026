// Phase 4.0 M6-PG-P7-R1 — the production transaction boundary (productionTransactions.ts).
//
// Synthetic configuration and synthetic routes only: no secret is read and nothing is contacted — a PostgreSQL driver is
// replaced by an in-test fake answering the kernel, and where the real client factory runs, every DNS lookup, socket connect
// and TLS connect is counted (and a connect is stopped before it leaves the process). The suite pins that today's inventory
// composes nothing and reads nothing, and the runtime serves as before; that a route requiring idempotency needs a supported
// APP_DATABASE_URL and a valid IDEMPOTENCY_KEY before anything is built, then gets the client, kernel and store each once and
// both ports together, with no fallback; that a refused configuration makes no contact and the real client dials only the
// classified endpoint; and that readiness probes the store only when composed, answers 503 for every failed probe while health
// stays prompt, and shutdown is bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import {
  PRODUCTION_INVENTORY, TransactionCompositionError, assembleTransactions, composeProductionTransactions, uncataloguedRoutePermissions,
} from './productionTransactions.js';
import type { ProductionTransactions, TransactionFactories, TransactionInventory } from './productionTransactions.js';
import { DRIVER_TLS_ENV_VAR, DatabaseTlsRefusal, createRuntimeStoreClient } from '../platform-identity/db.js';
import { createPostgresPrincipalResolver } from '../persistence/postgresPrincipalResolver.js';
import { createPostgresTransactionalStore } from '../persistence/postgresTransactionalStore.js';
import type { AggregateMutator, TransactionalStore } from '../persistence/postgresTransactionalStore.js';
import { RETIRED_POOL_GRACE_S, createSupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { DriverPool, SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import { createApp, createBoundedServer, createReadinessState } from '../runtime/app.js';
import { createLifecycle } from '../runtime/lifecycle.js';
import { testRequestLimits } from '../runtime/rateLimiter.testkit.js';
import { TEST_CREATE } from '../runtime/transactionalOutbox.testkit.js';
import type { RouteDefinition } from '../runtime/routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, '..', '..');
const REF = 'abcdefghijklmnop';
const DIRECT_URL = `postgres://tmpos_runtime:synthetic-pw@db.${REF}.supabase.co:5432/postgres`;
const POOLER_URL = `postgres://tmpos_runtime.${REF}:synthetic-pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
// Synthetic keys (32 bytes of 0x09 and of 0x07): never a deployment's.
const IDEMPOTENCY_KEY = Buffer.alloc(32, 9).toString('base64url');
const RATE_LIMIT_KEY = Buffer.alloc(32, 7).toString('base64url');
const CONFIGURED = { APP_DATABASE_URL: DIRECT_URL, IDEMPOTENCY_KEY, RATE_LIMIT_KEY };

const WRITE = { access: 'authenticated', authorization: { scope: 'platform', permission: 'items.write' } } as const;
const JSON_BODY = { kind: 'json', maxBytes: 1_024, required: false } as const;
const PERFORM: RouteDefinition = {
  method: 'POST', path: '/v1/items', policy: WRITE, body: JSON_BODY, idempotency: 'required',
  perform: () => ({ status: 201, body: { ok: true } }),
};
const STATUS: RouteDefinition = { method: 'GET', path: '/v1/status', policy: { access: 'public' }, body: { kind: 'none' }, idempotency: 'none', handler: (_req, res) => { res.status(200).json({ ok: true }); } };
const REQUIRED: TransactionInventory = Object.freeze({ routes: [PERFORM], mutators: [] });

// --- an in-test driver: answers the kernel's statements, records them, and never touches a socket ---------------------------

type Answer = { rows?: Record<string, unknown>[]; error?: Error; hang?: boolean };
function fakeDriver(answer: (text: string) => Answer = () => ({})) {
  const texts: string[] = [];
  let pools = 0;
  const statement = (strings: TemplateStringsArray): unknown => {
    const text = strings.join('$');
    let settle!: { resolve: (rows: unknown) => void; reject: (err: unknown) => void };
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    let started = false;
    const query = {
      handler: (): void => {
        texts.push(text);
        const a = answer(text);
        if (a.hang === true) return;
        if (a.error !== undefined) settle.reject(a.error);
        else settle.resolve(Object.assign(a.rows ?? [{}], { count: (a.rows ?? [{}]).length, command: text.split(/\s/)[0].toUpperCase() }));
      },
      cancel: (): void => settle.reject(Object.assign(new Error('canceling statement'), { code: '57014', severity: 'ERROR' })),
      reject: (err: unknown): void => settle.reject(err),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown): Promise<unknown> => {
        if (!started) {
          started = true;
          void Promise.resolve().then(() => (query.handler as (q: unknown) => void)(query));
        }
        return done.then(ok, bad);
      },
    };
    return query;
  };
  const driver = (): DriverPool => {
    pools++;
    const reserved = Object.assign((s: TemplateStringsArray) => statement(s), { json: (v: unknown) => v, release: () => undefined });
    return Object.assign((s: TemplateStringsArray) => statement(s), { reserve: async () => reserved, end: async () => undefined }) as unknown as DriverPool;
  };
  return { driver, texts, pools: () => pools };
}

const PROBE = 'select tmpos_internal.m6_store_probe() as ok';

/** Factories over the fake driver, counting each construction. */
function counted(fake = fakeDriver()) {
  const calls = { client: 0, store: 0, family: '' };
  const built: { client?: SupervisedPgClient; store?: TransactionalStore } = {};
  const factories: TransactionFactories = {
    client: (endpoint) => {
      calls.client++;
      calls.family = endpoint.family;
      built.client = createSupervisedPgClient(fake.driver, '', { max: 2 });
      return built.client;
    },
    principals: (client) => createPostgresPrincipalResolver({ client }),
    store: (options) => {
      calls.store++;
      built.store = createPostgresTransactionalStore(options);
      return built.store;
    },
  };
  return { factories, calls, built, fake };
}

const NEVER: TransactionFactories = Object.freeze({
  client: () => assert.fail('no client may be built'),
  store: () => assert.fail('no store may be built'),
  principals: () => assert.fail('no resolver may be built'),
});

function blockersOf(inventory: TransactionInventory, env: Record<string, string | undefined>, factories: TransactionFactories = NEVER): readonly string[] {
  try {
    assembleTransactions(inventory, env, factories);
  } catch (err) {
    if (err instanceof TransactionCompositionError) return err.blockers;
    throw err;
  }
  return assert.fail('composition must refuse');
}

/** An environment that records every key read from it. */
function recording(values: Record<string, string | undefined>): { env: Record<string, string | undefined>; read: Set<string> } {
  const read = new Set<string>();
  const env = new Proxy(values, {
    get: (target, key) => { if (typeof key === 'string') read.add(key); return Reflect.get(target, key); },
    has: (target, key) => { if (typeof key === 'string') read.add(key); return Reflect.has(target, key); },
    ownKeys: (target) => { read.add('*'); return Reflect.ownKeys(target); },
  });
  return { env, read };
}

/** Every DNS lookup, socket connect and TLS connect while `fn` runs; a socket connect is recorded and stopped, never made. */
async function contactsDuring(fn: () => unknown): Promise<{ lookups: number; tlsConnects: number; connects: Array<[unknown, unknown]> }> {
  const seen = { lookups: 0, tlsConnects: 0, connects: [] as Array<[unknown, unknown]> };
  const lookup = dns.lookup;
  const promised = dns.promises.lookup;
  const connect = net.Socket.prototype.connect;
  const tlsConnect = tls.connect;
  dns.lookup = ((...args: unknown[]) => { seen.lookups++; return (lookup as (...a: unknown[]) => unknown)(...args); }) as typeof dns.lookup;
  dns.promises.lookup = ((...args: unknown[]) => { seen.lookups++; return (promised as (...a: unknown[]) => unknown)(...args); }) as typeof dns.promises.lookup;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    seen.connects.push([args[0], args[1]]);
    queueMicrotask(() => this.destroy(Object.assign(new Error('connect stopped by the test'), { code: 'ECONNREFUSED' })));
    return this;
  } as typeof connect;
  tls.connect = ((...args: unknown[]) => { seen.tlsConnects++; return (tlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args); }) as typeof tls.connect;
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    dns.lookup = lookup;
    dns.promises.lookup = promised;
    net.Socket.prototype.connect = connect;
    tls.connect = tlsConnect;
  }
  return seen;
}

/** Run `fn` with process environment overrides, restored afterwards (the transport policy reads the process environment). */
async function withProcessEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
// A genuine public root from the runtime's bundled store: certificate input for the explicit-CA policy, no private key anywhere.
const CA = tls.rootCertificates[0];

async function serve(app: Express, fn: (get: (path: string) => Promise<{ status: number; type: string; body: string; ms: number }>) => Promise<void>): Promise<void> {
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const get = (path: string) => new Promise<{ status: number; type: string; body: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body, ms: Date.now() - started }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    await fn(get);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** The runtime composed as a deployable entry would compose it: the probes, `routes`, and any transaction boundary. */
function appWith(boundary: ProductionTransactions | null, routes: readonly RouteDefinition[] = [PERFORM]) {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: () => undefined }, routes, trustedOrigins: ['https://pos.example.test'], limits: testRequestLimits(),
    authenticator: { verify: async () => null }, authorizer: { authorize: () => true },
    ...(boundary === null ? {} : { idempotency: boundary.idempotency, transactions: boundary.transactions }),
  });
  return { app, readiness };
}

// --- A. today's production inventory ---------------------------------------------------------------------------------------

test('today\'s inventory requires no transaction boundary: nothing is read, built or probed', () => {
  assert.deepEqual(PRODUCTION_INVENTORY.routes, [], 'no production route is roadmapped into the inventory yet');
  assert.ok(Object.isFrozen(PRODUCTION_INVENTORY) && Object.isFrozen(PRODUCTION_INVENTORY.routes) && Object.isFrozen(PRODUCTION_INVENTORY.mutators));
  const { env, read } = recording({ APP_DATABASE_URL: 'postgres://x@127.0.0.1:6543/db', IDEMPOTENCY_KEY: 'short', DATABASE_CA_CERT: 'nonsense' });
  assert.equal(composeProductionTransactions(env), null);
  assert.deepEqual([...read], [], 'not APP_DATABASE_URL, not IDEMPOTENCY_KEY, not any key');
  // Any inventory without a route requiring idempotency is the same: its routes are still validated, nothing else happens.
  const none = recording({});
  assert.equal(assembleTransactions({ routes: [STATUS], mutators: [] }, none.env, NEVER), null);
  assert.deepEqual([...none.read], []);
  const required = recording({ ...CONFIGURED, IDEMPOTENCY_KEY: undefined });
  assert.deepEqual(blockersOf(REQUIRED, required.env), ['idempotency_key_missing']);
  assert.ok(required.read.has('APP_DATABASE_URL') && required.read.has('IDEMPOTENCY_KEY'), 'the recording observes reads (positive control)');
  assert.throws(() => assembleTransactions({ routes: [{ ...STATUS, idempotency: 'sometimes' } as unknown as RouteDefinition], mutators: [] }, {}, NEVER),
    /route_idempotency_policy_invalid/, 'the inventory is the runtime\'s validated route table');
});

test('without a transaction boundary the runtime serves its probes and bounded fallback exactly as the production entry does', async () => {
  const composed = composeProductionTransactions({});
  assert.equal(composed, null);
  const responses = async (app: Express): Promise<unknown[]> => {
    const out: unknown[] = [];
    await serve(app, async (get) => {
      for (const path of ['/health', '/readiness', '/v1/unknown']) {
        const { status, type, body } = await get(path);
        out.push({ path, status, type, body: body.replace(/"requestId":"[^"]*"/, '') });
      }
    });
    return out;
  };
  const entry = createReadinessState();
  entry.setReady();
  const baseline = await responses(createApp({ readiness: entry })); // server.ts's own composition
  const withRoot = createReadinessState();
  withRoot.setReady();
  const actual = await responses(createApp({ readiness: withRoot, ...(composed ?? {}) }));
  assert.deepEqual(actual, baseline);
  assert.deepEqual((baseline as Array<{ status: number }>).map((r) => r.status), [200, 200, 404]);
});

// --- B. a route that requires idempotency ----------------------------------------------------------------------------------

test('a required route refuses a missing, malformed or unsupported APP_DATABASE_URL before any client exists', () => {
  const blockers = (url: string | undefined) => blockersOf(REQUIRED, { ...CONFIGURED, APP_DATABASE_URL: url });
  for (const missing of [undefined, '']) assert.deepEqual(blockers(missing), ['app_database_url_missing'], String(missing));
  for (const bad of ['not a url', 'postgres://tmpos_runtime@db.abcdefghijklmnop.supabase.co:5432/postgres', `${DIRECT_URL}?sslmode=disable`]) {
    assert.deepEqual(blockers(bad), ['app_database_url_invalid'], bad);
  }
  for (const unsupported of [
    POOLER_URL.replace(':5432', ':6543'), // the shared transaction pooler
    DIRECT_URL.replace(':5432', ':6543'), // the dedicated transaction pooler
    `${POOLER_URL}?pgbouncer=true`, 'postgres://tmpos_runtime:synthetic-pw@127.0.0.1:5432/postgres', 'postgres:///tmpos_disposable?host=/tmp',
  ]) {
    assert.deepEqual(blockers(unsupported), ['app_database_endpoint_unsupported'], unsupported);
  }
  assert.deepEqual(blockersOf(REQUIRED, { ...CONFIGURED, APP_DATABASE_URL: undefined, SUPABASE_DATABASE_URL: DIRECT_URL }), ['app_database_url_missing'],
    'the migration applier\'s credential is never read in its place');
});

test('a required route needs its own valid IDEMPOTENCY_KEY, and every blocker is named at once', () => {
  const blockers = (over: Record<string, string | undefined>) => blockersOf(REQUIRED, { ...CONFIGURED, ...over });
  for (const missing of [undefined, '']) assert.deepEqual(blockers({ IDEMPOTENCY_KEY: missing }), ['idempotency_key_missing'], String(missing));
  for (const bad of ['short', IDEMPOTENCY_KEY.slice(0, 42), `${IDEMPOTENCY_KEY}=`, Buffer.alloc(31, 9).toString('base64url'), Buffer.alloc(32, 9).toString('base64')]) {
    assert.deepEqual(blockers({ IDEMPOTENCY_KEY: bad }), ['idempotency_key_invalid'], bad);
  }
  assert.deepEqual(blockers({ IDEMPOTENCY_KEY: RATE_LIMIT_KEY }), ['idempotency_key_shared'], 'never the limiter key');
  // HMAC zero-pads a short key, so the limiter key followed by zero bytes is the same key.
  assert.deepEqual(blockers({ IDEMPOTENCY_KEY: Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(32, 0)]).toString('base64url') }), ['idempotency_key_shared']);
  assert.deepEqual(blockers({ APP_DATABASE_URL: POOLER_URL.replace(':5432', ':6543'), IDEMPOTENCY_KEY: undefined }),
    ['app_database_endpoint_unsupported', 'idempotency_key_missing']);
  try {
    assembleTransactions(REQUIRED, { APP_DATABASE_URL: 'postgres://secret-role:secret-password@secret-host.example:6543/secret-db', IDEMPOTENCY_KEY: 'secret-key' }, NEVER);
    assert.fail('composition must refuse');
  } catch (err) {
    assert.ok(err instanceof TransactionCompositionError);
    assert.ok(!err.message.includes('secret') && !JSON.stringify(err.blockers).includes('secret'), 'no configuration value in the refusal');
    assert.match(err.message, /^production transaction composition refused: [a-z_,]+$/);
  }
});

test('a supported endpoint builds the client, kernel and store once each, and hands back both ports together and nothing else', async () => {
  for (const [url, family] of [[DIRECT_URL, 'direct'], [POOLER_URL, 'session_pooler']] as const) {
    const { factories, calls, built, fake } = counted();
    const boundary = assembleTransactions(REQUIRED, { ...CONFIGURED, APP_DATABASE_URL: url }, factories);
    assert.ok(boundary !== null);
    assert.deepEqual({ client: calls.client, store: calls.store, family: calls.family }, { client: 1, store: 1, family }, url);
    assert.equal(fake.pools(), 0, 'nothing connects at composition: the kernel opens a pool only when a transaction runs');
    assert.deepEqual(Object.keys(boundary).sort(), ['close', 'idempotency', 'principals', 'transactions']);
    assert.deepEqual(Object.keys(boundary.idempotency).sort(), ['keySecret', 'store']);
    assert.deepEqual(Object.keys(boundary.transactions), ['port']);
    assert.ok(Object.isFrozen(boundary) && Object.isFrozen(boundary.idempotency) && Object.isFrozen(boundary.transactions));
    assert.equal(boundary.idempotency.store, built.store?.idempotency, 'the idempotency store and ...');
    assert.equal(boundary.transactions.port, built.store?.transactions, '... the transaction port are one store\'s');
    assert.deepEqual([...boundary.idempotency.keySecret], [...Buffer.alloc(32, 9)]);
    for (const value of [boundary, boundary.idempotency, boundary.transactions]) {
      for (const key of ['transaction', 'reserve', 'begin', 'unsafe', 'client', 'sql', 'url']) assert.ok(!(key in value), `no ${key} crosses`);
    }
    assert.ok(!JSON.stringify(boundary).includes('synthetic-pw') && !JSON.stringify(boundary).includes(REF), 'no URL or credential crosses');
    await boundary.close();
  }
});

test('a command route needs its mutator, a partial construction composes nothing, and no fallback stands in', async () => {
  const command: RouteDefinition = { method: 'POST', path: '/v1/orders', policy: WRITE, body: JSON_BODY, idempotency: 'required', command: { contract: TEST_CREATE, plan: () => assert.fail('never planned') } };
  assert.deepEqual(blockersOf({ routes: [command], mutators: [] }, CONFIGURED), ['command_mutator_unavailable']);
  const mutator: AggregateMutator = { kind: TEST_CREATE.kind, mode: 'create', aggregateType: TEST_CREATE.aggregateType, apply: async () => 'applied' };
  const ok = counted();
  assert.ok(assembleTransactions({ routes: [command], mutators: [mutator] }, CONFIGURED, ok.factories) !== null);
  // Only the one mutator matching the contract's kind, mode and aggregate type serves it: nothing that would fail every command later.
  for (const [label, mutators] of [
    ['a mutator of another mode', [{ ...mutator, mode: 'update' }]],
    ['a mutator of another aggregate type', [{ ...mutator, aggregateType: 'other_aggregate' }]],
    ['two mutators of one kind', [mutator, { ...mutator }]],
  ] as const) {
    assert.deepEqual(blockersOf({ routes: [command], mutators: mutators as readonly AggregateMutator[] }, CONFIGURED), ['command_mutator_unavailable'], label);
  }

  // The store refuses its mutator table: the client already built is ended, and nothing is returned.
  let ended = 0;
  const fake = fakeDriver();
  const failing: TransactionFactories = {
    client: () => { const client = createSupervisedPgClient(fake.driver, '', { max: 1 }); return { transaction: client.transaction, end: () => { ended++; return client.end(); } }; },
    store: () => { throw new TypeError('transactional store mutator invalid'); },
    principals: NEVER.principals,
  };
  assert.throws(() => assembleTransactions(REQUIRED, CONFIGURED, failing), /transactional store mutator invalid/);
  assert.equal(ended, 1);
  // The transport policy refuses: a bounded blocker, and no store is built.
  assert.deepEqual(blockersOf(REQUIRED, CONFIGURED, { client: () => { throw new DatabaseTlsRefusal('refusing to open a database connection: x'); }, store: NEVER.store, principals: NEVER.principals }),
    ['database_tls_invalid']);
  // Anything else the client factory throws is a defect, never a composition answer.
  assert.throws(() => assembleTransactions(REQUIRED, CONFIGURED, { client: () => { throw new RangeError('defect'); }, store: NEVER.store, principals: NEVER.principals }), RangeError);
  // The production root takes configuration only: no store, client or factory can be handed to it.
  assert.equal(composeProductionTransactions.length, 1);
  assert.equal(composeProductionTransactions({ ...CONFIGURED, idempotencyStore: 'memory', store: 'memory' }), null, 'extra configuration composes nothing');
});

test('a refused configuration makes no contact, and the real client dials only the classified endpoint once a transaction runs', async () => {
  const real = () => {
    const calls = { client: 0, store: 0 };
    const factories: TransactionFactories = {
      client: (endpoint) => { calls.client++; return createRuntimeStoreClient(endpoint); },
      store: (options) => { calls.store++; return createPostgresTransactionalStore(options); },
      principals: (client) => createPostgresPrincipalResolver({ client }),
    };
    return { calls, factories };
  };
  await withProcessEnv({ DATABASE_CA_CERT: CA, [DRIVER_TLS_ENV_VAR]: undefined, PGHOST: 'ambient.example', PGPORT: '6543', PGUSER: 'ambient', PGPASSWORD: 'ambient', PGDATABASE: 'ambient' }, async () => {
    for (const env of [
      { ...CONFIGURED, APP_DATABASE_URL: POOLER_URL.replace(':5432', ':6543') },
      { ...CONFIGURED, APP_DATABASE_URL: DIRECT_URL.replace(':5432', ':6543') },
      { ...CONFIGURED, APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@attacker.example:5432/postgres' },
      { ...CONFIGURED, APP_DATABASE_URL: undefined },
      { ...CONFIGURED, IDEMPOTENCY_KEY: 'short' },
    ]) {
      const { calls, factories } = real();
      const seen = await contactsDuring(() => assert.throws(() => assembleTransactions(REQUIRED, env, factories), TransactionCompositionError));
      assert.deepEqual({ ...calls, ...seen }, { client: 0, store: 0, lookups: 0, tlsConnects: 0, connects: [] }, String(env.APP_DATABASE_URL));
    }
    for (const [url, host] of [[DIRECT_URL, `db.${REF}.supabase.co`], [POOLER_URL, 'aws-0-eu-west-1.pooler.supabase.com']] as const) {
      const { calls, factories } = real();
      let boundary: ProductionTransactions | null = null;
      const composing = await contactsDuring(() => { boundary = assembleTransactions(REQUIRED, { ...CONFIGURED, APP_DATABASE_URL: url }, factories); });
      assert.deepEqual({ ...calls, ...composing }, { client: 1, store: 1, lookups: 0, tlsConnects: 0, connects: [] }, 'composition connects nothing');
      const composed = boundary as unknown as ProductionTransactions;
      const probing = await contactsDuring(async () => {
        assert.equal(await composed.idempotency.store.probe(AbortSignal.timeout(2_000)), false, 'the stopped connect answers unavailable');
      });
      assert.deepEqual(probing.connects, [[5432, host]], 'the sealed endpoint, never an ambient PGHOST/PGPORT or the URL re-parsed');
      assert.deepEqual({ lookups: probing.lookups, tlsConnects: probing.tlsConnects }, { lookups: 0, tlsConnects: 0 });
      await composed.close();
    }
  });
  await withProcessEnv({ DATABASE_CA_CERT: undefined, [DRIVER_TLS_ENV_VAR]: undefined }, async () => {
    const { calls, factories } = real();
    const seen = await contactsDuring(() => assert.deepEqual(blockersOf(REQUIRED, CONFIGURED, factories), ['database_tls_invalid']));
    assert.deepEqual({ ...calls, ...seen }, { client: 1, store: 0, lookups: 0, tlsConnects: 0, connects: [] }, 'no trust anchor: no client, no contact');
  });
});

test('importing the composition and the database-client boundary opens nothing', () => {
  const script = [
    "const dns = require('node:dns'); const net = require('node:net'); const tls = require('node:tls');",
    'let contacts = 0; const count = (o, k) => { const f = o[k]; o[k] = function (...a) { contacts++; return f.apply(this, a); }; };',
    "count(dns, 'lookup'); count(net.Socket.prototype, 'connect'); count(tls, 'connect');",
    "import('./server/composition/productionTransactions.ts').then(() => import('./server/platform-identity/db.ts'))",
    '  .then(() => new Promise((r) => setTimeout(r, 50))).then(() => {',
    '    const imported = contacts;',
    "    const control = net.connect({ host: '127.0.0.1', port: 9 }); control.on('error', () => undefined); control.destroy();",
    '    process.stdout.write(`imported=${imported} control=${contacts - imported}`);',
    '  });',
  ].join('\n');
  const run = spawnSync(join(REPO, 'node_modules/.bin/tsx'), ['--eval', script], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, APP_DATABASE_URL: DIRECT_URL, IDEMPOTENCY_KEY } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'imported=0 control=1', 'nothing at import, and the counter sees a connect (positive control)');
});

// --- D. readiness and health -----------------------------------------------------------------------------------------------

test('readiness probes the composed store and is ready only for an exact true answer, while health stays prompt', async () => {
  const cases: Array<[string, (text: string) => Answer, number]> = [
    ['a healthy store', (text) => (text === PROBE ? { rows: [{ ok: true }] } : {}), 200],
    ['the store answers not ready', (text) => (text === PROBE ? { rows: [{ ok: false }] } : {}), 503],
    ['a malformed answer', (text) => (text === PROBE ? { rows: [{ ok: 'true' }] } : {}), 503],
    ['no row', (text) => (text === PROBE ? { rows: [] } : {}), 503],
    ['a statement error', (text) => (text === PROBE ? { error: Object.assign(new Error('M6-UNIT-CANARY'), { code: '42883', severity: 'ERROR' }) } : {}), 503],
    ['a lost connection', (text) => (text === PROBE ? { error: Object.assign(new Error('M6-UNIT-CANARY'), { code: 'CONNECTION_CLOSED' }) } : {}), 503],
    ['a probe that never answers', (text) => (text === PROBE ? { hang: true } : {}), 503],
  ];
  for (const [label, answer, expected] of cases) {
    const { factories, fake } = counted(fakeDriver(answer));
    const boundary = assembleTransactions(REQUIRED, CONFIGURED, factories) as ProductionTransactions;
    const { app } = appWith(boundary);
    await serve(app, async (get) => {
      const [readiness, health] = await Promise.all([get('/readiness'), get('/health')]);
      assert.equal(readiness.status, expected, label);
      assert.equal(readiness.body.includes('M6-UNIT-CANARY'), false, 'no driver error reaches the response');
      assert.deepEqual({ status: health.status, body: health.body }, { status: 200, body: '{"status":"alive"}' }, label);
      assert.ok(health.ms < 500, `${label}: health answered in ${health.ms} ms`);
      assert.ok(fake.texts.includes(PROBE), `${label}: the store's probe routine ran`);
      assert.ok(!fake.texts.some((t) => /^\s*(?:insert|update|delete)\b/i.test(t)), `${label}: the probe writes nothing`);
    });
    await boundary.close();
  }
});

test('readiness is 503 when a composed port\'s probe throws, rejects, answers a non-boolean or runs late', async () => {
  const store = createPostgresTransactionalStore({ client: createSupervisedPgClient(fakeDriver().driver, '', { max: 1 }), mutators: [] });
  const cases: Array<[string, (signal: AbortSignal) => unknown]> = [
    ['throws', () => { throw new Error('M6-UNIT-CANARY'); }],
    ['rejects', async () => { throw new Error('M6-UNIT-CANARY'); }],
    ['answers a truthy non-boolean', async () => 'true'],
    ['answers an object', async () => ({ ready: true })],
    ['answers late', (signal) => new Promise((resolve) => { const t = setTimeout(() => resolve(true), 5_000); signal.addEventListener('abort', () => { clearTimeout(t); resolve(true); }); })],
  ];
  for (const [label, probe] of cases) {
    const factories: TransactionFactories = {
      client: () => ({ transaction: () => Promise.reject(new Error('unused')), end: async () => undefined }),
      principals: (client) => createPostgresPrincipalResolver({ client }),
      store: () => ({ ...store, idempotency: { ...store.idempotency, probe }, transactions: { ...store.transactions, probe } }),
    };
    const boundary = assembleTransactions(REQUIRED, CONFIGURED, factories) as ProductionTransactions;
    await serve(appWith(boundary).app, async (get) => {
      const readiness = await get('/readiness');
      assert.deepEqual({ status: readiness.status, body: readiness.body }, { status: 503, body: '{"status":"unavailable"}' }, label);
    });
  }
});

test('without a composed store readiness probes nothing, and shutdown with one in flight is bounded', async () => {
  const idle = counted(fakeDriver(() => assert.fail('nothing may be sent')));
  const none = assembleTransactions({ routes: [STATUS], mutators: [] }, CONFIGURED, idle.factories);
  assert.equal(none, null);
  const nothing = appWith(none, [STATUS]);
  await serve(nothing.app, async (get) => {
    assert.equal((await get('/readiness')).status, 200);
  });
  assert.deepEqual({ client: idle.calls.client, store: idle.calls.store, pools: idle.fake.pools(), texts: idle.fake.texts }, { client: 0, store: 0, pools: 0, texts: [] });

  // A probe hangs in flight under a signal that never aborts — not readiness's own deadline, which would settle it first — so
  // only the kernel's grace can end it: the lifecycle's shutdown hook ends the kernel after that grace, and the process exits
  // cleanly.
  const { factories, fake } = counted(fakeDriver((text) => (text === PROBE ? { hang: true } : {})));
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, factories) as ProductionTransactions;
  const { app, readiness } = appWith(boundary);
  await serve(app, async (get) => {
    const pending = boundary.transactions.port.probe(new AbortController().signal);
    while (!fake.texts.includes(PROBE)) await new Promise((resolve) => setImmediate(resolve));
    const exits: number[] = [];
    const lifecycle = createLifecycle({
      server: null, readiness, hooks: [boundary.close], proc: { on: () => undefined }, exit: (code) => { exits.push(code); },
      log: { log: () => undefined }, forceTimeoutMs: (RETIRED_POOL_GRACE_S + 5) * 1_000,
    });
    // One watchdog over the whole sequence, so an unbounded end() or a probe it never settles fails here, never hangs the suite.
    const started = performance.now();
    let took = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      (async () => {
        await lifecycle.shutdown('signal_sigterm', 0);
        took = performance.now() - started;
        return { answer: await pending };
      })(),
      new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), (RETIRED_POOL_GRACE_S + 2) * 1_000); }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(outcome, { answer: false }, 'shutdown ends the kernel and the retired probe answers unavailable, within the grace and 2 s');
    assert.ok(took >= RETIRED_POOL_GRACE_S * 1_000 - 250, `shutdown took ${Math.round(took)} ms: it waited the grace`);
    assert.deepEqual(exits, [0], 'the hook finished before the forced deadline');
    assert.equal((await get('/readiness')).status, 503, 'after shutdown the instance is not ready');
  });
});

// ---------------------------------------------------------------------------
// M5-ID-P1 — the canonical permission gate and the resolver's composition
// ---------------------------------------------------------------------------

test('a deployed route may require only a canonical platform permission, and startup says so', () => {
  const route = (permission: string, scope: 'platform' | 'tenant' | 'store') => Object.freeze({
    method: 'POST' as const, path: '/v1/unit',
    policy: Object.freeze({ access: 'authenticated' as const, authorization: Object.freeze({ scope, permission }) }),
    body: Object.freeze({ kind: 'json' as const, maxBytes: 1024, required: true }),
    idempotency: 'none' as const,
    handler: () => undefined,
  });
  // A real catalog key at platform scope is the only thing that passes.
  assert.deepEqual(uncataloguedRoutePermissions([route('view_command_center', 'platform')]), []);
  // A key the catalog does not define is a typo or an invented permission.
  for (const key of ['conformance.write', 'command_center', 'made_up', 'view_command_centre']) {
    assert.deepEqual(uncataloguedRoutePermissions([route(key, 'platform')]), ['route_permission_uncatalogued'], key);
  }
  // A key that is not even a permission SHAPE never reaches the catalog: the route table refuses it
  // first, so case is rejected twice over.
  assert.throws(() => uncataloguedRoutePermissions([route('View_Command_Center', 'platform')]), /route_policy_invalid/);
  // A real tenant key is undecidable until owner decision D1 defines a specific route (M5-GAP11-P5).
  assert.deepEqual(uncataloguedRoutePermissions([route('process_refunds', 'tenant')]), ['route_permission_undecidable']);
  assert.deepEqual(uncataloguedRoutePermissions([route('process_refunds', 'store')]), ['route_permission_undecidable']);
  // A public route declares no permission and needs none.
  assert.deepEqual(uncataloguedRoutePermissions([Object.freeze({
    method: 'GET' as const, path: '/v1/open', policy: Object.freeze({ access: 'public' as const }),
    body: Object.freeze({ kind: 'none' as const }), idempotency: 'none' as const, handler: () => undefined,
  })]), []);
  // Today's production inventory declares no route at all, so it clears the gate.
  assert.deepEqual(uncataloguedRoutePermissions(PRODUCTION_INVENTORY.routes), []);
});

test('the resolver is composed with the store, over the same client, and never alone', () => {
  const built: string[] = [];
  let sharedClient: unknown = null;
  // A stub client, not the real one: this proves WHO is handed the client, not how it is built (the
  // transport policy is proved above, and resolving it here would need a trust anchor this test has
  // no business installing).
  const stub = Object.freeze({ transaction: () => Promise.reject(new Error('unused')), end: async () => undefined });
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, {
    client: () => { sharedClient = stub; built.push('client'); return stub as never; },
    store: (options) => { built.push('store'); assert.equal(options.client, sharedClient, 'the store takes the shared client'); assert.equal(typeof options.revalidate, 'function', 'and a revalidator'); return createPostgresTransactionalStore(options); },
    principals: (client) => { built.push('principals'); assert.equal(client, sharedClient, 'the resolver takes the SAME client'); return createPostgresPrincipalResolver({ client }); },
  });
  assert.ok(boundary !== null);
  assert.deepEqual(built, ['client', 'store', 'principals'], 'one client, then both consumers of it');
  assert.equal(typeof boundary!.principals.resolve, 'function');
  assert.equal(typeof boundary!.principals.probe, 'function');
});
