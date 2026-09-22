// Phase 4.0 M6-PG-P7-R1 — the production transaction boundary (productionTransactions.ts).
//
// Synthetic configuration and synthetic routes only: no secret is read and nothing is contacted — a PostgreSQL driver is
// replaced by an in-test fake answering the kernel, and where the real client factory runs, every DNS lookup, socket connect
// and TLS connect is counted (and a connect is stopped before it leaves the process). The suite pins that today's inventory
// composes nothing and reads nothing, and the runtime serves as before; that a route requiring idempotency needs a supported
// APP_DATABASE_URL and a valid IDEMPOTENCY_KEY before anything is built, then gets the client, kernel and store each once and
// both ports together, with no fallback; that a refused configuration makes no contact and the real client dials only the
// classified endpoint; and that readiness probes the store only when composed, answers 503 for every failed probe while health
// stays prompt, and shutdown is bounded. M6-RATE-P2 adds the distributed rate limiter's binding: the boundary hands back a
// function, not a limiter, that builds the PostgreSQL limiter (migration 014) over the SAME kernel only when called with
// RATE_LIMIT_KEY's bytes — refusing a malformed key, opening nothing when called, failing closed through that kernel — and
// readiness through the session root's limits is 503 whenever the store answers anything but 'ready' for that key.
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import {
  PRODUCTION_INVENTORY, TransactionCompositionError, assembleTransactions, composeProductionTransactions, uncataloguedRoutePermissions, productionRouteDeclarations,
} from './productionTransactions.js';
import type { ProductionTransactions, TransactionFactories, TransactionInventory } from './productionTransactions.js';
import { DRIVER_TLS_ENV_VAR, DatabaseTlsRefusal, createRuntimeStoreClient } from '../platform-identity/db.js';
import { createPostgresPlatformAdmission } from '../persistence/postgresPlatformAdmission.js';
import { createPostgresRateLimiter } from '../persistence/postgresRateLimiter.js';
import { createPostgresSessionStore } from '../persistence/postgresSessionStore.js';
import { createPostgresTenantAdmission } from '../persistence/postgresTenantAdmission.js';
import { createPostgresTenantDirectory } from '../persistence/postgresTenantDirectory.js';
import { createPostgresTransactionalStore } from '../persistence/postgresTransactionalStore.js';
import type { AggregateMutator, TransactionalStore } from '../persistence/postgresTransactionalStore.js';
import { RETIRED_POOL_GRACE_S, createSupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { DriverPool, SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import { createApp, createBoundedServer, createReadinessState } from '../runtime/app.js';

/**
 * The session-boundary adapters this root also builds over its one kernel (M5-GIAM-D1-P2-R1), and the
 * rate limiter's production factory (M6-RATE-P2) — the one the binding calls with a key, never at composition.
 * Spread into a factories literal wherever the case under test is about the transaction ports and not
 * about these, so adding them changed no existing expectation.
 */
const SESSION_FACTORIES = Object.freeze({
  sessionStore: (client: SupervisedPgClient) => createPostgresSessionStore({ client }),
  tenantAdmission: (client: SupervisedPgClient) => createPostgresTenantAdmission({ client }),
  tenantDirectory: (client: SupervisedPgClient) => createPostgresTenantDirectory({ client }),
  rateLimiter: (client: SupervisedPgClient, keySecret: Uint8Array) => createPostgresRateLimiter({ client, keySecret }),
});
import { createLifecycle } from '../runtime/lifecycle.js';
import { testRequestLimits } from '../runtime/rateLimiter.testkit.js';
import { TEST_CREATE } from '../runtime/transactionalOutbox.testkit.js';
import type { RouteDefinition } from '../runtime/routes.js';
import { EnforcementSetupError } from '../runtime/routes.js';
import { createTenantDirectoryRoute } from '../runtime/tenantDirectory.js';
import type { PlatformAdmissionPort } from '../runtime/principals.js';
import type { DistributedRateLimiter, RateLimitRequest } from '../runtime/rateLimit.js';
import { composeProductionSessions, durableSessionAdapters } from './productionSessions.js';
import { TENANT_DISPLAY_NAME_ROUTE } from '../runtime/tenantDisplayName.js';
import { TENANT_STATUS_ROUTE } from '../runtime/tenantStatus.js';
import { TENANT_DISPLAY_NAME_MUTATOR } from '../persistence/tenantDisplayNameMutator.js';
import { TENANT_STATUS_MUTATOR } from '../persistence/tenantStatusMutator.js';

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
  method: 'POST', path: '/v1/items', policy: WRITE, body: JSON_BODY, idempotency: 'required', trustedContext: 'required', recentAuth: 'none',
  perform: () => ({ status: 201, body: { ok: true } }),
};
const STATUS: RouteDefinition = { method: 'GET', path: '/v1/status', policy: { access: 'public' }, body: { kind: 'none' }, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: (_req, res) => { res.status(200).json({ ok: true }); } };
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
    platformAdmission: (client) => createPostgresPlatformAdmission({ client }),
    ...SESSION_FACTORIES,
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
  platformAdmission: () => assert.fail('no platform admission may be built'),
  sessionStore: () => assert.fail('no session store may be built'),
  tenantAdmission: () => assert.fail('no tenant admission may be built'),
  tenantDirectory: () => assert.fail('no tenant directory may be built'),
  rateLimiter: () => assert.fail('no rate limiter may be built'),
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

test('the production inventory holds the tenant display-name command and its one mutator, so it composes nothing without the whole boundary', () => {
  // M5-GIAM-D1-P1 (owner decision D1): the first business route. Serving it requires the database, the idempotency key and the
  // store, so the production root refuses, naming every blocker, when the configuration lacks them — never a partial composition.
  assert.deepEqual(PRODUCTION_INVENTORY.routes, [TENANT_DISPLAY_NAME_ROUTE, TENANT_STATUS_ROUTE], 'exactly the two business routes');
  assert.deepEqual(PRODUCTION_INVENTORY.mutators, [TENANT_DISPLAY_NAME_MUTATOR, TENANT_STATUS_MUTATOR], 'and exactly their mutators');
  // Both declare a trusted context, so neither can be served by a deployment whose authorizer resolves no actor.
  assert.ok(PRODUCTION_INVENTORY.routes.every((r) => r.trustedContext === 'required'), 'every business route requires a resolved actor');
  assert.ok(Object.isFrozen(PRODUCTION_INVENTORY) && Object.isFrozen(PRODUCTION_INVENTORY.routes) && Object.isFrozen(PRODUCTION_INVENTORY.mutators));
  assert.deepEqual(uncataloguedRoutePermissions(PRODUCTION_INVENTORY.routes), [], 'its permission is one canonical platform key');
  // M5-GIAM-D1-P3: exactly one read route — the platform tenant directory — built over the composed kernel, platform-scoped,
  // requiring a resolved actor like both commands, and checked for a canonical permission before anything is composed.
  assert.deepEqual(PRODUCTION_INVENTORY.reads, [createTenantDirectoryRoute], 'exactly one read route factory: the tenant directory');
  assert.ok(Object.isFrozen(PRODUCTION_INVENTORY.reads));
  const declared = productionRouteDeclarations();
  assert.deepEqual(declared.map((r) => `${r.method} ${r.path}`),
    ['PATCH /admin/v1/tenants/display-name', 'PATCH /admin/v1/tenants/status', 'GET /admin/v1/tenants'], 'the served set, as declared');
  assert.deepEqual(declared.map((r) => (r.policy.access === 'session' ? r.policy.authorization : null)), [
    { scope: 'platform', permission: 'edit_tenant_profile' },
    { scope: 'platform', permission: 'change_tenant_status' },
    { scope: 'platform', permission: 'view_tenants' },
  ], 'three canonical platform keys, and no tenant or store requirement');
  assert.ok(declared.every((r) => r.trustedContext === 'required' && r.policy.access === 'session' && r.policy.audience === 'admin'));
  assert.deepEqual(uncataloguedRoutePermissions(declared), [], 'every declared permission is canonical');
  const { env, read } = recording({});
  assert.throws(() => composeProductionTransactions(env),
    (err: unknown) => err instanceof TransactionCompositionError && JSON.stringify(err.blockers) === JSON.stringify(['app_database_url_missing', 'idempotency_key_missing']));
  assert.ok(read.has('APP_DATABASE_URL') && read.has('IDEMPOTENCY_KEY'), 'it reads its own configuration');
  // Any inventory without a route requiring idempotency composes nothing and reads nothing: its routes are still validated.
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
  // The provider-free entry (server.ts) composes no inventory at all; an inventory with no required route is the same: null.
  const composed = assembleTransactions({ routes: [STATUS], mutators: [] }, {}, NEVER);
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
    assert.deepEqual(Object.keys(boundary).sort(),
      ['close', 'idempotency', 'platformAdmission', 'rateLimiter', 'routes', 'sessionStore', 'tenantAdmission', 'transactions'],
      'the two ports, the three session-boundary adapters, the limiter binding (M6-RATE-P2), the served routes, and close — nothing else');
    // M5-GIAM-D1-P4: the administrative boundary's admission crosses; the resolver and the authorizer over it no longer
    // do — the session root builds the authorizer that decides on the scope this admission selects.
    assert.deepEqual([typeof boundary.platformAdmission.admit, typeof boundary.platformAdmission.probe], ['function', 'function']);
    assert.ok(!('principals' in boundary) && !('authorizer' in boundary), 'no resolver and no authorizer cross');
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
  const command: RouteDefinition = { method: 'POST', path: '/v1/orders', policy: WRITE, body: JSON_BODY, idempotency: 'required', trustedContext: 'required', recentAuth: 'none', command: { contract: TEST_CREATE, plan: () => assert.fail('never planned') } };
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
    platformAdmission: NEVER.platformAdmission,
    sessionStore: NEVER.sessionStore,
    tenantAdmission: NEVER.tenantAdmission,
    tenantDirectory: NEVER.tenantDirectory,
    rateLimiter: NEVER.rateLimiter,
  };
  assert.throws(() => assembleTransactions(REQUIRED, CONFIGURED, failing), /transactional store mutator invalid/);
  assert.equal(ended, 1);
  // The transport policy refuses: a bounded blocker, and no store is built.
  assert.deepEqual(blockersOf(REQUIRED, CONFIGURED, { client: () => { throw new DatabaseTlsRefusal('refusing to open a database connection: x'); }, store: NEVER.store, platformAdmission: NEVER.platformAdmission, sessionStore: NEVER.sessionStore, tenantAdmission: NEVER.tenantAdmission, tenantDirectory: NEVER.tenantDirectory, rateLimiter: NEVER.rateLimiter }),
    ['database_tls_invalid']);
  // Anything else the client factory throws is a defect, never a composition answer.
  assert.throws(() => assembleTransactions(REQUIRED, CONFIGURED, { client: () => { throw new RangeError('defect'); }, store: NEVER.store, platformAdmission: NEVER.platformAdmission, sessionStore: NEVER.sessionStore, tenantAdmission: NEVER.tenantAdmission, tenantDirectory: NEVER.tenantDirectory, rateLimiter: NEVER.rateLimiter }), RangeError);
  // The production root takes configuration only: no store, client or factory can be handed to it.
  assert.equal(composeProductionTransactions.length, 1);
  assert.throws(() => composeProductionTransactions({ idempotencyStore: 'memory', store: 'memory' }),
    (err: unknown) => err instanceof TransactionCompositionError && JSON.stringify(err.blockers) === JSON.stringify(['app_database_url_missing', 'idempotency_key_missing']),
    'extra configuration selects nothing: no in-memory store, no fallback');
});

test('a refused configuration makes no contact, and the real client dials only the classified endpoint once a transaction runs', async () => {
  const real = () => {
    const calls = { client: 0, store: 0 };
    const factories: TransactionFactories = {
      client: (endpoint) => { calls.client++; return createRuntimeStoreClient(endpoint); },
      store: (options) => { calls.store++; return createPostgresTransactionalStore(options); },
      platformAdmission: (client) => createPostgresPlatformAdmission({ client }),
    ...SESSION_FACTORIES,
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
      platformAdmission: (client) => createPostgresPlatformAdmission({ client }),
    ...SESSION_FACTORIES,
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
// M5-ID-P1, M5-GIAM-D1-P4 — the canonical permission gate and the platform admission's composition
// ---------------------------------------------------------------------------

test('a deployed route may require only a canonical platform permission, and startup says so', () => {
  const route = (permission: string, scope: 'platform' | 'tenant' | 'store') => Object.freeze({
    method: 'POST' as const, path: '/v1/unit',
    policy: Object.freeze({ access: 'authenticated' as const, authorization: Object.freeze({ scope, permission }) }),
    body: Object.freeze({ kind: 'json' as const, maxBytes: 1024, required: true }),
    idempotency: 'none' as const, trustedContext: 'none' as const, recentAuth: 'none' as const,
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
    body: Object.freeze({ kind: 'none' as const }), idempotency: 'none' as const,
    trustedContext: 'none' as const, recentAuth: 'none' as const, handler: () => undefined,
  })]), []);
  // Today's production inventory declares no route at all, so it clears the gate.
  assert.deepEqual(uncataloguedRoutePermissions(PRODUCTION_INVENTORY.routes), []);
});

test('the platform admission is composed with the store, once, over the same client, and never alone', () => {
  const built: string[] = [];
  let sharedClient: unknown = null;
  const limiterKey = Buffer.alloc(32, 7);
  const limiters: DistributedRateLimiter[] = [];
  // A stub client, not the real one: this proves WHO is handed the client, not how it is built (the
  // transport policy is proved above, and resolving it here would need a trust anchor this test has
  // no business installing).
  const stub = Object.freeze({ transaction: () => Promise.reject(new Error('unused')), end: async () => undefined });
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, {
    client: () => { sharedClient = stub; built.push('client'); return stub as never; },
    store: (options) => { built.push('store'); assert.equal(options.client, sharedClient, 'the store takes the shared client'); assert.equal(typeof options.revalidate, 'function', 'and a revalidator'); return createPostgresTransactionalStore(options); },
    platformAdmission: (client) => { built.push('platformAdmission'); assert.equal(client, sharedClient, 'the platform admission takes the SAME client'); return createPostgresPlatformAdmission({ client }); },
    sessionStore: (client) => { built.push('sessionStore'); assert.equal(client, sharedClient, 'the session store takes the SAME client'); return createPostgresSessionStore({ client }); },
    tenantAdmission: (client) => { built.push('tenantAdmission'); assert.equal(client, sharedClient, 'tenant admission takes the SAME client'); return createPostgresTenantAdmission({ client }); },
    tenantDirectory: (client) => { built.push('tenantDirectory'); assert.equal(client, sharedClient, 'the tenant directory takes the SAME client'); return createPostgresTenantDirectory({ client }); },
    rateLimiter: (client, keySecret) => {
      built.push('rateLimiter');
      assert.equal(client, sharedClient, 'the rate limiter takes the SAME client');
      assert.equal(keySecret, limiterKey, 'and the exact key bytes the binding was called with: no copy, no re-parse');
      limiters.push(createPostgresRateLimiter({ client, keySecret }));
      return limiters[limiters.length - 1];
    },
  });
  assert.ok(boundary !== null);
  assert.deepEqual(built, ['client', 'store', 'tenantDirectory', 'platformAdmission', 'sessionStore', 'tenantAdmission'],
    'one client, then every consumer of it, each once: the store, the tenant directory and the three session-boundary adapters');
  assert.equal(typeof boundary!.platformAdmission.admit, 'function');
  assert.equal(typeof boundary!.platformAdmission.probe, 'function');
  // M6-RATE-P2: the limiter is not built at composition — it awaits RATE_LIMIT_KEY, which only the session root parses. Called,
  // the binding builds it over that same client, once per call, and hands back exactly what the factory built.
  const limiter = boundary!.rateLimiter(limiterKey);
  assert.deepEqual(built.slice(6), ['rateLimiter'], 'the binding builds the limiter when called, and only then');
  assert.equal(limiter, limiters[0], 'the binding answers the factory\'s limiter itself, never a wrapper');
});

test('the served routes are the inventory\'s commands plus its read routes, each served read route built over the composed ports', () => {
  // M5-GIAM-D1-P3: a read route holds its port, so the root builds it from the ports it composed over its one client.
  const seen: unknown[] = [];
  const probeRoute = (ports: { tenantDirectory: unknown; permits: unknown }): RouteDefinition => {
    seen.push(ports);
    return createTenantDirectoryRoute(ports as never);
  };
  const { factories } = counted();
  const boundary = assembleTransactions({ routes: [TENANT_DISPLAY_NAME_ROUTE], mutators: [TENANT_DISPLAY_NAME_MUTATOR], reads: [probeRoute] }, CONFIGURED, factories);
  assert.ok(boundary !== null);
  assert.deepEqual(boundary!.routes.map((r) => `${r.method} ${r.path}`), ['PATCH /admin/v1/tenants/display-name', 'GET /admin/v1/tenants']);
  // Built twice: once declared over ports that answer nothing (the table check before any client exists), once served.
  assert.equal(seen.length, 2, 'declared once, served once');
  assert.throws(() => (seen[0] as { tenantDirectory: { page: () => unknown } }).tenantDirectory.page(), /read port not composed/,
    'the declaration is built over ports that answer nothing');
  const ports = seen[1] as { tenantDirectory: { page: unknown }; permits: unknown };
  assert.notEqual(ports, seen[0], 'and the served route over the composed ports');
  // The composed decision is the canonical one, not merely a function: a full role holds both command permissions, a
  // View-only role holds neither, and a read-only limitation caps a full role at View.
  const scopeOf = (roleId: string, limitation: 'none' | 'read_only' = 'none') => ({
    actor: '6f1c2d3e-4b5a-4c6d-8e7f-8091a2b3c4d5', securityVersion: 'sv-1', scope: 'platform', tenant: null, store: null,
    membershipId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', roleId, limitation,
  });
  const decide = ports.permits as (scope: unknown, permission: string) => unknown;
  assert.deepEqual(['view_tenants', 'edit_tenant_profile', 'change_tenant_status'].map((p) => decide(scopeOf('system_owner'), p)), [true, true, true]);
  assert.deepEqual(['view_tenants', 'edit_tenant_profile', 'change_tenant_status'].map((p) => decide(scopeOf('billing_admin'), p)), [true, false, false]);
  assert.deepEqual(['view_tenants', 'edit_tenant_profile', 'change_tenant_status'].map((p) => decide(scopeOf('system_owner', 'read_only'), p)), [true, false, false]);
  assert.equal(typeof ports.tenantDirectory.page, 'function', 'over the tenant directory port');
  assert.equal(typeof ports.permits, 'function', 'and the canonical permission decision');
  assert.ok(Object.isFrozen(boundary!.routes));
  // A read route that collides with a command is refused as one table, never served twice — and before any client exists.
  const collision = counted();
  assert.throws(() => assembleTransactions({ routes: [TENANT_DISPLAY_NAME_ROUTE], mutators: [TENANT_DISPLAY_NAME_MUTATOR], reads: [() => TENANT_DISPLAY_NAME_ROUTE] }, CONFIGURED, collision.factories),
    (err: unknown) => err instanceof EnforcementSetupError && err.code === 'route_duplicate');
  assert.equal(collision.calls.client, 0, 'refused before the client, or any consumer of it, is built');
  // Read routes ride the command boundary's kernel: without a route that requires idempotency they refuse, never vanish.
  assert.throws(() => assembleTransactions({ routes: [STATUS], mutators: [], reads: [probeRoute] }, CONFIGURED, NEVER),
    (err: unknown) => err instanceof TransactionCompositionError && err.blockers.join() === 'read_route_without_boundary');
  // With neither, nothing is composed, exactly as before.
  assert.equal(assembleTransactions({ routes: [STATUS], mutators: [] }, CONFIGURED, NEVER), null);
});

test('the platform admission the boundary hands back is the one it built, and the session root decides over exactly that object', async () => {
  // M5-GIAM-D1-P1 review, carried into P4: typeof checks alone would pass a stub. Swap only the platform admission factory for
  // a synthetic port; the boundary must hand back THAT object, and the administrative boundary the session root composes from
  // it (durableSessionAdapters, as the deployed entry would) must admit through it and authorize on the scope it selected.
  const ACTOR = '6f1c2d3e-4b5a-4c6d-8e7f-8091a2b3c4d5';
  const principal = { authProvider: 'firebase', authProviderUid: 'u' };
  const decide = async (roleId: string): Promise<unknown> => {
    const { factories } = counted();
    let built: PlatformAdmissionPort | undefined;
    let reads = 0;
    const synthetic: PlatformAdmissionPort = {
      admit: () => {
        reads++;
        return {
          outcome: 'resolved', authorityVersion: '3',
          principal: {
            actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: 'sv-1',
            memberships: [{ membershipId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', scopeType: 'platform', tenant: null, store: null, roleId, tenantStatus: null, storeStatus: null }],
          },
        };
      },
      probe: () => true,
    };
    const boundary = assembleTransactions(REQUIRED, CONFIGURED, { ...factories, platformAdmission: () => { built = synthetic; return synthetic; } });
    assert.ok(boundary !== null);
    try {
      assert.equal(boundary.platformAdmission, built, 'the boundary hands back the platform admission it built');
      const admin = durableSessionAdapters({ store: boundary.sessionStore, tenantAdmission: boundary.tenantAdmission, platformAdmission: boundary.platformAdmission });
      const signal = new AbortController().signal;
      const admitted = await admin.admission.admin!.admit(principal, 'admin', signal) as { admitted: true; context: never };
      assert.equal(admitted.admitted, true, `${roleId}: one platform grant on an active account is admitted`);
      assert.equal(reads, 1, 'admission reads the port once');
      const decision = await admin.authorizer.admin!.authorize(principal, { scope: 'platform', permission: 'edit_tenant_profile' },
        { method: 'PATCH', path: '/admin/v1/tenants/display-name', audience: 'admin' }, signal, admitted.context);
      assert.equal(reads, 1, 'and the authorizer decides on what it selected, without a second read');
      return decision;
    } finally {
      await boundary.close();
    }
  };
  const granted = await decide('support_admin') as { granted: boolean; context: Record<string, unknown> };
  assert.equal(granted.granted, true);
  assert.deepEqual({ ...granted.context }, {
    actor: ACTOR, securityVersion: 'sv-1', scope: 'platform', tenant: null, store: null,
    membershipId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', roleId: 'support_admin', limitation: 'none',
  }, 'the grant carries the admitted actor, the very grant selected and its role');
  assert.equal(await decide('billing_admin'), false, 'a role below Edit on tenant_management is denied');
});

test('the store is composed with the platform revalidator: migration 009\'s exact-authority routine, then the permission on the same roles', async () => {
  // M5-GIAM-D1-P1-R1: not merely "a function" — the revalidator the boundary hands the store asks the database about the
  // very grant selected, and re-decides the route's permission on that role, exactly as the composed authorizer decides it.
  let revalidate: ((sql: never, scope: never, permission: string, authNotAfter: number | null) => Promise<unknown>) | undefined;
  const stub = Object.freeze({ transaction: () => Promise.reject(new Error('unused')), end: async () => undefined });
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, {
    client: () => stub as never,
    store: (options) => { revalidate = options.revalidate as never; return createPostgresTransactionalStore(options); },
    platformAdmission: (client) => createPostgresPlatformAdmission({ client }),
    ...SESSION_FACTORIES,
  });
  assert.ok(boundary !== null && revalidate !== undefined);
  const texts: string[] = [];
  const bound: unknown[][] = [];
  const valid = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    texts.push(strings.join('?')); bound.push(values); return Promise.resolve([{ outcome: 'valid' }]);
  }) as never;
  const scope = (roleId: string) => Object.freeze({
    actor: '6f1c2d3e-4b5a-4c6d-8e7f-8091a2b3c4d5', securityVersion: 'sv-1', scope: 'platform', tenant: null, store: null,
    membershipId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', roleId, limitation: 'none',
  }) as never;
  assert.equal(await revalidate(valid, scope('support_admin'), 'edit_tenant_profile', null), true);
  assert.match(texts[0], /tmpos_command\.m5_revalidate_platform_authority\(/, 'the exact-authority routine');
  assert.deepEqual(bound[0], ['6f1c2d3e-4b5a-4c6d-8e7f-8091a2b3c4d5', 'sv-1', '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', 'support_admin']);
  assert.equal(await revalidate(valid, scope('billing_admin'), 'edit_tenant_profile', null), false,
    'the database confirming the grant does not make a View role an editor: the permission is decided again');
  const invalid = (() => Promise.resolve([{ outcome: 'invalid' }])) as never;
  assert.equal(await revalidate(invalid, scope('support_admin'), 'edit_tenant_profile', null), false, 'and nothing holds once the database says invalid');
  // M5-GIAM-D1-P2: a route that required a recent authentication has its deadline judged on the database's
  // clock, on this same transaction, BEFORE the authority routine is asked.
  texts.length = 0; bound.length = 0;
  const fresh = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    texts.push(strings.join('?')); bound.push(values);
    return Promise.resolve(strings.join('').includes('clock_timestamp') ? [{ fresh: true }] : [{ outcome: 'valid' }]);
  }) as never;
  assert.equal(await revalidate(fresh, scope('support_admin'), 'edit_tenant_profile', 1_700_000_600_000), true);
  assert.match(texts[0], /clock_timestamp\(\)/, 'the freshness statement runs first, on the database clock');
  assert.deepEqual(bound[0], ['1700000600000'], 'the deadline is bound as a value, never interpolated');
  assert.match(texts[1], /m5_revalidate_platform_authority\(/, 'and the authority routine follows it');
  const stale = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    texts.push(strings.join('?')); bound.push(values);
    return Promise.resolve(strings.join('').includes('clock_timestamp') ? [{ fresh: false }] : [{ outcome: 'valid' }]);
  }) as never;
  assert.equal(await revalidate(stale, scope('support_admin'), 'edit_tenant_profile', 1_700_000_600_000), false,
    'expired evidence denies whatever the authority routine would have said');
  await boundary.close();
});

// ---------------------------------------------------------------------------
// M6-RATE-P2 — the distributed rate limiter's binding (migration 014)
// ---------------------------------------------------------------------------
// What is proved: the boundary hands back a binding, not a limiter; calling it opens no transaction and makes no contact;
// the production factory is the PostgreSQL limiter over the sealed kernel, refusing a malformed key before any limiter
// exists; the bound limiter answers the port through that kernel and fails closed whenever the kernel does; and readiness,
// through the limits the session root composes from the binding, is 503 for anything but the store's exact 'ready'.
// Substituted: the PostgreSQL driver (the in-test fake above, answering migration 014's routines by statement text) and the
// identity provider (a freshly generated key, never contacted). The routines themselves are proved on a disposable database
// by the adapter's own suite, not here.

const LIMITER_KEY = Buffer.alloc(32, 7); // RATE_LIMIT_KEY's bytes: the canonical synthetic key
const LIMITER_PROBE = /m6_rate_limit_probe\(/;
const LIMITER_CONSUME = /m6_rate_limit_consume\(/;
const CONSUME_REQUEST: RateLimitRequest = Object.freeze({
  namespace: 'runtime', dimension: 'client', key: 'A'.repeat(43), limit: 10, windowMs: 60_000, cost: 1,
});

test('M6R-C01 the boundary hands back the limiter binding: nothing is built at composition, and calling it opens no transaction', async () => {
  const { factories, built, fake } = counted();
  const seen: Array<{ client: SupervisedPgClient; keySecret: Uint8Array }> = [];
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, {
    ...factories,
    rateLimiter: (client, keySecret) => { seen.push({ client, keySecret }); return createPostgresRateLimiter({ client, keySecret }); },
  });
  assert.ok(boundary !== null);
  try {
    assert.equal(typeof boundary.rateLimiter, 'function', 'a binding awaiting its key');
    assert.equal(seen.length, 0, 'composition builds no limiter: only the session root holds the key');
    let limiter: DistributedRateLimiter | undefined;
    const contacts = await contactsDuring(() => { limiter = boundary.rateLimiter(LIMITER_KEY); });
    assert.deepEqual(contacts, { lookups: 0, tlsConnects: 0, connects: [] }, 'binding contacts nothing');
    assert.deepEqual({ pools: fake.pools(), texts: fake.texts }, { pools: 0, texts: [] }, 'binding opens no pool and sends no statement');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].client, built.client, 'over the one kernel the store was built over');
    assert.equal(seen[0].keySecret, LIMITER_KEY, 'with the exact bytes it was handed');
    assert.deepEqual(Object.keys(limiter as object).sort(), ['consume', 'probe'], 'the port, and nothing else');
    assert.ok(Object.isFrozen(limiter));
    for (const key of ['transaction', 'reserve', 'begin', 'unsafe', 'client', 'sql', 'url', 'keySecret', 'fingerprint']) {
      assert.ok(!(key in (limiter as object)), `no ${key} crosses`);
    }
  } finally {
    await boundary.close();
  }
});

test('M6R-C02 the production binding is the PostgreSQL limiter over the sealed kernel: a malformed key refuses, a valid one dials only the classified endpoint', async () => {
  await withProcessEnv({ DATABASE_CA_CERT: CA, [DRIVER_TLS_ENV_VAR]: undefined, PGHOST: 'ambient.example', PGPORT: '6543', PGUSER: 'ambient', PGPASSWORD: 'ambient', PGDATABASE: 'ambient' }, async () => {
    let boundary: ProductionTransactions | null = null;
    const composing = await contactsDuring(() => { boundary = composeProductionTransactions(CONFIGURED); });
    assert.deepEqual(composing, { lookups: 0, tlsConnects: 0, connects: [] }, 'composition connects nothing');
    const composed = boundary as unknown as ProductionTransactions;
    assert.ok(composed !== null);
    try {
      for (const bad of [Buffer.alloc(31, 7), Buffer.alloc(65, 7), new Uint8Array(0), LIMITER_KEY.toString('base64url'), null, undefined]) {
        assert.throws(() => composed.rateLimiter(bad as never),
          (err: unknown) => err instanceof EnforcementSetupError && err.code === 'rate_limit_key_invalid', `refused: ${String(bad)}`);
      }
      let limiter: DistributedRateLimiter | undefined;
      const binding = await contactsDuring(() => { limiter = composed.rateLimiter(LIMITER_KEY); });
      assert.deepEqual(binding, { lookups: 0, tlsConnects: 0, connects: [] }, 'binding a valid key contacts nothing');
      const bound = limiter as DistributedRateLimiter;
      const probing = await contactsDuring(async () => {
        assert.equal(await bound.probe(AbortSignal.timeout(2_000)), false, 'the stopped connect is not ready');
      });
      assert.deepEqual(probing.connects, [[5432, `db.${REF}.supabase.co`]], 'the sealed endpoint, never an ambient PGHOST/PGPORT');
      const consuming = await contactsDuring(async () => {
        assert.deepEqual(await bound.consume(CONSUME_REQUEST, AbortSignal.timeout(2_000)), { outcome: 'unavailable' }, 'no store: no allowance');
      });
      assert.ok(consuming.connects.length >= 1 && consuming.connects.every(([port, host]) => port === 5432 && host === `db.${REF}.supabase.co`),
        'a consume dials the same sealed endpoint');
      assert.deepEqual({ lookups: probing.lookups + consuming.lookups, tlsConnects: probing.tlsConnects + consuming.tlsConnects }, { lookups: 0, tlsConnects: 0 });
    } finally {
      await composed.close();
    }
  });
});

test('M6R-C03 the bound limiter answers the port through the composed kernel, and every kernel failure answers unavailable', async () => {
  // Positive control: a kernel whose consume routine answers an in-contract allowance is answered as one, so every
  // `unavailable` below is the failure's, not a request the adapter refused to send.
  const ok = counted(fakeDriver((text) => (LIMITER_CONSUME.test(text) ? { rows: [{ outcome: 'allowed', remaining: 9, retry_after_ms: null }] } : {})));
  const allowing = assembleTransactions(REQUIRED, CONFIGURED, ok.factories) as ProductionTransactions;
  assert.deepEqual(await allowing.rateLimiter(LIMITER_KEY).consume(CONSUME_REQUEST, new AbortController().signal), { outcome: 'allowed', remaining: 9 });
  assert.ok(ok.fake.texts.some((t) => LIMITER_CONSUME.test(t)), 'the consume routine ran on the composed kernel');
  await allowing.close();

  const failures: Array<[string, (text: string) => Answer]> = [
    ['key_mismatch', (text) => (LIMITER_CONSUME.test(text) ? { rows: [{ outcome: 'key_mismatch', remaining: null, retry_after_ms: null }] } : {})],
    ['a statement error', (text) => (LIMITER_CONSUME.test(text) ? { error: Object.assign(new Error('M6-UNIT-CANARY'), { code: '42501', severity: 'ERROR' }) } : {})],
    ['a lost connection', (text) => (LIMITER_CONSUME.test(text) ? { error: Object.assign(new Error('M6-UNIT-CANARY'), { code: 'CONNECTION_CLOSED' }) } : {})],
    ['a serialization failure', (text) => (LIMITER_CONSUME.test(text) ? { error: Object.assign(new Error('M6-UNIT-CANARY'), { code: '40001', severity: 'ERROR' }) } : {})],
    ['a consume that never answers', (text) => (LIMITER_CONSUME.test(text) ? { hang: true } : {})],
  ];
  for (const [label, answer] of failures) {
    const { factories } = counted(fakeDriver(answer));
    const boundary = assembleTransactions(REQUIRED, CONFIGURED, factories) as ProductionTransactions;
    const outcome = await boundary.rateLimiter(LIMITER_KEY).consume(CONSUME_REQUEST, new AbortController().signal);
    assert.deepEqual(outcome, { outcome: 'unavailable' }, label);
    await boundary.close();
  }
  // A kernel whose transaction itself fails: the composed limiter answers unavailable and not ready, never an allowance.
  const failing = assembleTransactions(REQUIRED, CONFIGURED, {
    ...counted().factories,
    client: () => ({ transaction: () => Promise.reject(new Error('M6-UNIT-CANARY')), end: async () => undefined }),
  }) as ProductionTransactions;
  const closed = failing.rateLimiter(LIMITER_KEY);
  assert.deepEqual(await closed.consume(CONSUME_REQUEST, new AbortController().signal), { outcome: 'unavailable' });
  assert.equal(await closed.probe(new AbortController().signal), false);
});

test('M6R-C04 readiness through the session root\'s limits is ready only when the store answers \'ready\' for this key, while health stays prompt', async () => {
  // The deployed path: the transaction root's binding handed to the session root, which binds it to the RATE_LIMIT_KEY it
  // parsed; createApp is composed with those limits alone, so the limiter's probe is readiness's only store probe.
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sessionEnv = {
    SESSION_TENANT_ORIGINS: 'https://pos.example.test', SESSION_ADMIN_ORIGINS: 'https://admin.example.test',
    TRUSTED_PROXY_CIDRS: '203.0.113.0/24', RATE_LIMIT_KEY,
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', project_id: 'demo-synthetic', client_email: 'verifier@demo-synthetic.test', private_key: pem }),
  };
  const cases: Array<[string, (text: string) => Answer, number]> = [
    ['the store answers ready', (text) => (LIMITER_PROBE.test(text) ? { rows: [{ outcome: 'ready' }] } : {}), 200],
    ['the store answers key_mismatch', (text) => (LIMITER_PROBE.test(text) ? { rows: [{ outcome: 'key_mismatch' }] } : {}), 503],
    ['the store answers consume_unavailable', (text) => (LIMITER_PROBE.test(text) ? { rows: [{ outcome: 'consume_unavailable' }] } : {}), 503],
    ['no row', (text) => (LIMITER_PROBE.test(text) ? { rows: [] } : {}), 503],
    ['a statement error', (text) => (LIMITER_PROBE.test(text) ? { error: Object.assign(new Error('M6-UNIT-CANARY'), { code: '42883', severity: 'ERROR' }) } : {}), 503],
    ['a probe that never answers', (text) => (LIMITER_PROBE.test(text) ? { hang: true } : {}), 503],
  ];
  for (const [label, answer, expected] of cases) {
    const { factories, fake } = counted(fakeDriver(answer));
    const boundary = assembleTransactions(REQUIRED, CONFIGURED, factories) as ProductionTransactions;
    const { limits } = composeProductionSessions(sessionEnv, {
      store: boundary.sessionStore, tenantAdmission: boundary.tenantAdmission, platformAdmission: boundary.platformAdmission, rateLimiter: boundary.rateLimiter,
    });
    const readiness = createReadinessState();
    readiness.setReady();
    await serve(createApp({ readiness, log: { log: () => undefined }, limits }), async (get) => {
      const [ready, health] = await Promise.all([get('/readiness'), get('/health')]);
      assert.equal(ready.status, expected, label);
      assert.equal(ready.body.includes('M6-UNIT-CANARY'), false, `${label}: no driver error reaches the response`);
      assert.deepEqual({ status: health.status, body: health.body }, { status: 200, body: '{"status":"alive"}' }, label);
      assert.ok(health.ms < 500, `${label}: health answered in ${health.ms} ms`);
      assert.ok(fake.texts.some((t) => LIMITER_PROBE.test(t)), `${label}: the limiter's probe routine ran`);
      assert.ok(!fake.texts.some((t) => LIMITER_CONSUME.test(t)), `${label}: no probe spends a bucket`);
    });
    await boundary.close();
  }
});
