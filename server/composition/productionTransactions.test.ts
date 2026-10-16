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
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
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
import { createPostgresSessionStore, tenantMintProof } from '../persistence/postgresSessionStore.js';
import type { SessionStandingCheck } from '../persistence/postgresSessionStore.js';
import { createPostgresTenantAdmission } from '../persistence/postgresTenantAdmission.js';
import { createPostgresTenantDirectory } from '../persistence/postgresTenantDirectory.js';
import { createPostgresTransactionalStore } from '../persistence/postgresTransactionalStore.js';
import type { AggregateMutator, TransactionalStore } from '../persistence/postgresTransactionalStore.js';
import { RETIRED_POOL_GRACE_S, createSupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { DriverPool, PgTransactionScope, SupervisedPgClient, TransactionBounds } from '../persistence/supervisedPgClient.js';
import { createApp, createBoundedServer, createReadinessState } from '../runtime/app.js';

/**
 * The session-boundary adapters this root also builds over its one kernel (M5-GIAM-D1-P2-R1), and the
 * rate limiter's production factory (M6-RATE-P2) — the one the binding calls with a key, never at composition.
 * Spread into a factories literal wherever the case under test is about the transaction ports and not
 * about these, so adding them changed no existing expectation.
 */
const SESSION_FACTORIES = Object.freeze({
  sessionStore: (client: SupervisedPgClient, standing: SessionStandingCheck) => createPostgresSessionStore({ client, standing }),
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
import { createCustomerDirectoryRoute } from '../runtime/customerDirectory.js';
import { TENANT_SUB_PERMISSIONS } from '../platform-identity/permissionCatalog.js';
import type { PlatformAdmissionPort } from '../runtime/principals.js';
import type { DistributedRateLimiter, RateLimitRequest } from '../runtime/rateLimit.js';
import { composeProductionSessions, durableSessionAdapters } from './productionSessions.js';
import { TENANT_DISPLAY_NAME_ROUTE } from '../runtime/tenantDisplayName.js';
import { TENANT_STATUS_ROUTE } from '../runtime/tenantStatus.js';
import { TENANT_DISPLAY_NAME_MUTATOR } from '../persistence/tenantDisplayNameMutator.js';
import { TENANT_STATUS_MUTATOR } from '../persistence/tenantStatusMutator.js';
import { composeReadTransactions, parseTenantIssuerKey } from './transactionKernel.js';
import { TENANT_INVENTORY, composeTenantTransactions, tenantRouteDeclarations } from './tenantTransactions.js';
import { defineCommands, prepareCommand } from '../runtime/commandTransaction.js';
import { CUSTOMER_CREATE_CONTRACT, planCustomerCreate } from '../runtime/customerCreate.js';
import { CUSTOMER_UPDATE_CONTRACT, planCustomerUpdate } from '../runtime/customerUpdate.js';
import { ROLE_LEVEL_UPDATE_CONTRACT, planRoleLevelUpdate } from '../runtime/roleLevelUpdate.js';
import { createIdempotencyKeyring } from '../runtime/idempotency.js';
import { defineOutboxEvents } from '../runtime/outbox.js';

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
    // M6-ENTRY-P1: `preflight` joined this shape; stale before that, this list named only the M6-RATE-P2 keys.
    assert.deepEqual(Object.keys(boundary).sort(),
      ['close', 'idempotency', 'platformAdmission', 'preflight', 'rateLimiter', 'routes', 'sessionStore', 'tenantAdmission', 'transactions'],
      'the two ports, the three session-boundary adapters, the limiter binding (M6-RATE-P2), the served routes, the startup preflight (M6-ENTRY-P1, null: this harness builds none), and close — nothing else');
    assert.equal(boundary.preflight, null, 'a harness factories object without `preflight` yields preflight null');
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

// ---------------------------------------------------------------------------
// M6-ENTRY-P1 — composeProductionTransactions(env, client): the deployable entry's construction boundary
// ---------------------------------------------------------------------------

test('M6E-T01 composeProductionTransactions(env, client) builds its kernel with the handed constructor, once, over the classified endpoint, and a refused configuration never calls it', async () => {
  const fake = fakeDriver();
  let calls = 0;
  let seenEndpoint: unknown;
  const client = (endpoint: unknown): SupervisedPgClient => { calls++; seenEndpoint = endpoint; return createSupervisedPgClient(fake.driver, '', { max: 2 }); };
  const boundary = composeProductionTransactions(CONFIGURED, client);
  assert.ok(boundary !== null);
  assert.equal(calls, 1, 'the handed constructor is called exactly once');
  assert.equal((seenEndpoint as { family: string }).family, 'direct', 'over the classified endpoint');
  await boundary!.close();

  calls = 0;
  assert.throws(() => composeProductionTransactions({ ...CONFIGURED, IDEMPOTENCY_KEY: undefined }, client), TransactionCompositionError);
  assert.equal(calls, 0, 'a refused configuration is never handed to the kernel constructor');
});

test('M6E-T02 the production factories build a non-null preflight exposing connect/runtimeLogin/migrationLedger/rateLimitKey', async () => {
  const fake = fakeDriver();
  const client = (): SupervisedPgClient => createSupervisedPgClient(fake.driver, '', { max: 2 });
  const boundary = composeProductionTransactions(CONFIGURED, client);
  assert.ok(boundary !== null && boundary.preflight !== null, 'the production factories always build it');
  const preflight = boundary!.preflight as unknown as Record<string, unknown>;
  assert.deepEqual(
    ['connect', 'runtimeLogin', 'migrationLedger', 'rateLimitKey'].map((k) => typeof preflight[k]),
    ['function', 'function', 'function', 'function'],
  );
  await boundary!.close();
});

test('a command route needs its mutator, a partial construction composes nothing, and no fallback stands in', async () => {
  const command: RouteDefinition = { method: 'POST', path: '/v1/orders', policy: WRITE, body: JSON_BODY, idempotency: 'required', trustedContext: 'required', recentAuth: 'none', command: { contract: TEST_CREATE, plan: () => assert.fail('never planned') } };
  assert.deepEqual(blockersOf({ routes: [command], mutators: [] }, CONFIGURED), ['command_mutator_unavailable']);
  const mutator: AggregateMutator = { kind: TEST_CREATE.kind, mode: 'create', aggregateType: TEST_CREATE.aggregateType, contextScope: 'platform', apply: async () => 'applied' };
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
  // M7B-INVOICES-P1 (design R4): route scope = contract scope = mutator scope, and this root admits platform alone — each as
  // DECLARED: a contract or a mutator with no scope (an untyped caller, outside the type system) gets no default.
  const { contextScope: _contractScope, ...undeclaredContract } = TEST_CREATE;
  const { contextScope: _mutatorScope, ...undeclaredMutator } = mutator;
  const withContract = (contract: unknown): RouteDefinition => ({ ...command, command: { contract: contract as never, plan: () => assert.fail('never planned') } }) as RouteDefinition;
  for (const [label, routes, mutators] of [
    ['a contract declaring no scope', [withContract(undeclaredContract)], [mutator]],
    ['a mutator declaring no scope', [command], [undeclaredMutator]],
    ['a contract declaring tenant', [withContract({ ...TEST_CREATE, contextScope: 'tenant' })], [mutator]],
    ['a mutator declaring store', [command], [{ ...mutator, contextScope: 'store' }]],
    ['a contract and a mutator agreeing on tenant at a platform route', [withContract({ ...TEST_CREATE, contextScope: 'tenant' })], [{ ...mutator, contextScope: 'tenant' }]],
    ['a tenant-session command route, its contract and its mutator all declaring tenant', [{
      ...withContract({ ...TEST_CREATE, contextScope: 'tenant' }), path: '/api/v1/orders',
      policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'items.write' } },
    }], [{ ...mutator, contextScope: 'tenant' }]],
  ] as const) {
    assert.deepEqual(blockersOf({ routes: routes as readonly RouteDefinition[], mutators: mutators as readonly AggregateMutator[] }, CONFIGURED), ['command_scope_mismatch'], label);
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
  // M6-ENTRY-P1: the production root takes configuration plus the kernel constructor only — no store,
  // factory or inventory can be handed to it (`client` is defaulted, so configuration alone is still a
  // complete call: `.length` stays 1).
  assert.equal(composeProductionTransactions.length, 1);
  assert.throws(() => composeProductionTransactions({ idempotencyStore: 'memory', store: 'memory' }),
    (err: unknown) => err instanceof TransactionCompositionError && JSON.stringify(err.blockers) === JSON.stringify(['app_database_url_missing', 'idempotency_key_missing']),
    'extra configuration selects nothing: no in-memory store, no fallback');
  assert.throws(() => composeProductionTransactions(CONFIGURED, 'not a function' as never), TypeError, 'a non-function client refuses before anything is built');
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
  // M7B-INVOICES-P1: a store-scope requirement registers only on a store template (routes.ts), so this Bearer route never
  // reaches the census; the store-scope census itself is pinned below, on a store template.
  assert.throws(() => uncataloguedRoutePermissions([route('process_refunds', 'store')]), /route_path_invalid/);
  // A public route declares no permission and needs none.
  assert.deepEqual(uncataloguedRoutePermissions([Object.freeze({
    method: 'GET' as const, path: '/v1/open', policy: Object.freeze({ access: 'public' as const }),
    body: Object.freeze({ kind: 'none' as const }), idempotency: 'none' as const,
    trustedContext: 'none' as const, recentAuth: 'none' as const, handler: () => undefined,
  })]), []);
  // Today's production inventory declares no route at all, so it clears the gate.
  assert.deepEqual(uncataloguedRoutePermissions(PRODUCTION_INVENTORY.routes), []);
});

test('M7A-CUSTOMERS-P1 view_customers (and, since P3, create_customers) are decidable tenant keys and, since M7B-INVOICES-P1, view_invoice_drafts and create_invoice_drafts (since M7B-INVOICES-P2 also edit_invoice_drafts, since M7B-INVOICES-DISCARD-P1 also discard_invoice_drafts) the decidable store keys: each clears the gate at its own scope alone, every other tenant or store key does not, and a store-scope route off a store template never registers', () => {
  const customerRoute = createCustomerDirectoryRoute({ customers: { page: () => ({ outcome: 'page', customers: [], hasMore: false }) } });
  assert.deepEqual(uncataloguedRoutePermissions([customerRoute]), [], 'the customer directory\'s requirement is catalogued and decidable');
  assert.deepEqual(uncataloguedRoutePermissions(tenantRouteDeclarations()), [], 'M7A-CUSTOMERS-P3: so is the customer create\'s, create_customers');
  const route = (permission: string, scope: 'platform' | 'tenant' | 'store', path = '/api/v1/unit') => Object.freeze({
    method: 'GET' as const, path,
    policy: Object.freeze({ access: 'session' as const, audience: 'tenant' as const, authorization: Object.freeze({ scope, permission }) }),
    body: Object.freeze({ kind: 'none' as const }), idempotency: 'none' as const, trustedContext: 'required' as const, recentAuth: 'none' as const,
    handler: () => undefined,
  });
  assert.deepEqual(uncataloguedRoutePermissions([route('view_customers', 'tenant')]), [], 'the same key on a synthetic tenant route (control)');
  // A store-scope requirement registers only on a store template (routes.ts, M7B-INVOICES-P1): the store cases sit on one.
  const STORE_TEMPLATE = '/api/v1/stores/{storeId}/invoice-drafts';
  const at = (permission: string, scope: 'platform' | 'tenant' | 'store') => route(permission, scope, scope === 'store' ? STORE_TEMPLATE : '/api/v1/unit');
  // Every existing tenant sub-permission is still undecidable, at either tenant-plane scope.
  for (const sub of TENANT_SUB_PERMISSIONS) {
    for (const scope of ['tenant', 'store'] as const) {
      assert.deepEqual(uncataloguedRoutePermissions([at(sub.id, scope)]), ['route_permission_undecidable'], `${scope}/${sub.id}`);
    }
  }
  // view_customers names nothing outside tenant scope.
  assert.deepEqual(uncataloguedRoutePermissions([at('view_customers', 'store')]), ['route_permission_uncatalogued'], 'store scope');
  assert.deepEqual(uncataloguedRoutePermissions([at('view_customers', 'platform')]), ['route_permission_uncatalogued'], 'platform scope');
  // The four store route permissions clear the gate at store scope, on a store template, and name nothing at any other scope.
  for (const key of ['view_invoice_drafts', 'create_invoice_drafts', 'edit_invoice_drafts', 'discard_invoice_drafts']) {
    assert.deepEqual(uncataloguedRoutePermissions([at(key, 'store')]), [], `store/${key}`);
    assert.deepEqual(uncataloguedRoutePermissions([at(key, 'tenant')]), ['route_permission_uncatalogued'], `tenant/${key}`);
    assert.deepEqual(uncataloguedRoutePermissions([at(key, 'platform')]), ['route_permission_uncatalogued'], `platform/${key}`);
    // Off a store template a store requirement never registers, so the census refuses the whole inventory first.
    assert.throws(() => uncataloguedRoutePermissions([route(key, 'store')]), /route_path_invalid/, `a literal path: ${key}`);
  }
  // One blocker per offending route, in order, beside a clean one.
  assert.deepEqual(uncataloguedRoutePermissions([customerRoute, route('process_refunds', 'tenant', '/api/v1/a'), at('view_customers', 'store')]),
    ['route_permission_undecidable', 'route_permission_uncatalogued']);
  // The deployable entry serves the administrative inventory only: no tenant business route is declared or composed.
  const declared = productionRouteDeclarations();
  assert.deepEqual(declared.filter((r) => r.path.startsWith('/api/v1')).map((r) => r.path), [], 'no /api/v1 route is declared');
  assert.ok(declared.every((r) => r.policy.access === 'session' && r.policy.audience === 'admin'), 'every declared route is on the admin boundary');
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
    sessionStore: (client, standing) => {
      built.push('sessionStore');
      assert.equal(client, sharedClient, 'the session store takes the SAME client');
      assert.equal(typeof standing, 'function', 'and the administrative login\'s standing check (M5-ADMIN-REVOKE-P1)');
      return createPostgresSessionStore({ client, standing });
    },
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

// A fake transaction handle answering the M5-ADMIN-REVOKE-P1 statements by their text, recording each statement and its values.
const REVAL_ACTOR = '6f1c2d3e-4b5a-4c6d-8e7f-8091a2b3c4d5';
const REVAL_MEMBERSHIP = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const REVAL_SESSION_KEY = 'q'.repeat(43);
const revalScope = (roleId: string) => Object.freeze({
  actor: REVAL_ACTOR, securityVersion: 'sv-1', scope: 'platform', tenant: null, store: null, membershipId: REVAL_MEMBERSHIP, roleId, limitation: 'none',
});
/** The p1 witness over a standing, recomputed here independently of the code under test (platformAuthorization.ts witnessOf). */
const revalWitness = (roleId: string, authorityVersion = '3', accountStatus = 'active'): string =>
  `p1:${createHash('sha256').update(['p1', REVAL_ACTOR, accountStatus, 'none', 'sv-1', REVAL_MEMBERSHIP, roleId, authorityVersion].join('\n')).digest('base64url')}`;
/** Migration 013's row for the actor holding `roleId`, at `authorityVersion`. */
const admissionRow = (roleId: string, authorityVersion = '3') => ({
  outcome: 'resolved', actor_id: REVAL_ACTOR, account_status: 'active', limitation: 'none', security_version: 'sv-1', authority_version: authorityVersion,
  memberships: [{ membershipId: REVAL_MEMBERSHIP, scopeType: 'platform', tenantId: null, storeId: null, roleId, tenantStatus: null, storeStatus: null }],
});
/** Migration 011's row for the administrative session bound to `witness`. */
const sessionRow = (witness: string) => ({
  audience: 'admin', authProvider: 'firebase', authProviderUid: 'uid-operator', principalKey: 'p'.repeat(43), securityVersion: witness,
  authenticatedAt: '1700000000000', createdAt: '1700000000000', lastSeenAt: '1700000000000', validatedAt: '1700000000001',
});
/** Migration 016's v2 row for a tenant actor holding one tenant grant, and its t2 witness recomputed here independently. */
const REVAL_TENANT = '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e';
const tenantAdmissionRow = (grantVersion = '1') => ({
  outcome: 'resolved', actor_id: REVAL_ACTOR, account_status: 'active', limitation: 'none', security_version: 'sv-1',
  memberships: [{ membershipId: REVAL_MEMBERSHIP, scopeType: 'tenant', tenantId: REVAL_TENANT, storeId: null, roleId: 'store_owner',
    tenantStatus: 'active', storeStatus: null, tenantAccessVersion: '1', storeAccessVersion: null }],
  authority_version: '0', grant_version: grantVersion,
});
const tenantWitness = `t2:${createHash('sha256').update(['t2', REVAL_ACTOR, 'active', 'none', 'sv-1', '0', '1', '1',
  REVAL_MEMBERSHIP, 'tenant', REVAL_TENANT, '', 'store_owner', 'active', '', '1', ''].join('\n')).digest('base64url')}`;
function revalHandle(over: { fresh?: boolean; authority?: unknown; session?: unknown[]; touch?: string; admission?: unknown[]; hold?: unknown; tenant?: unknown[] } = {}) {
  const texts: string[] = [];
  const bound: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    texts.push(text); bound.push(values);
    if (text.includes('clock_timestamp')) return Promise.resolve([{ fresh: over.fresh ?? true }]);
    if (text.includes('m5_revalidate_platform_authority')) return Promise.resolve([{ outcome: over.authority ?? 'valid' }]);
    if (text.includes('m5_session_get')) return Promise.resolve(over.session ?? [sessionRow(revalWitness('support_admin'))]);
    if (text.includes('m5_session_touch')) return Promise.resolve([{ outcome: over.touch ?? 'updated' }]);
    if (text.includes('m5_admit_platform_session')) return Promise.resolve(over.admission ?? [admissionRow('support_admin')]);
    if (text.includes('m5_hold_tenant_standing')) return Promise.resolve([{ outcome: over.hold ?? 'held' }]);
    if (text.includes('m5_admit_tenant_session_v2')) return Promise.resolve(over.tenant ?? [tenantAdmissionRow()]);
    return Promise.reject(new Error(`a statement the composed checks never send: ${text}`));
  }) as never;
  const step = (text: string): string => (text.includes('clock_timestamp') ? 'freshness' : text.includes('m5_revalidate_platform_authority') ? '009'
    : text.includes('m5_session_get') ? 'session get' : text.includes('m5_session_touch') ? 'touch' : text.includes('m5_admit_platform_session') ? '013'
      : text.includes('m5_hold_tenant_standing') ? '016 hold' : text.includes('m5_admit_tenant_session_v2') ? '016 v2' : 'other');
  return { sql, texts, bound, steps: () => texts.map(step) };
}

test('the store is composed with the platform revalidator: freshness, 009\'s locks, the presenting session held, 013\'s read — then the permission on the same roles', async () => {
  // M5-GIAM-D1-P1-R1: not merely "a function" — the revalidator the boundary hands the store asks the database about the
  // very grant selected, and re-decides the route's permission on that role, exactly as the composed authorizer decides it.
  // M5-ADMIN-REVOKE-P1: on the same handle it then holds the session that presented the command and re-reads that session's
  // standing under 009's locks — so the order on the committing transaction is freshness → 009 → session get → touch → 013.
  let revalidate: ((sql: never, scope: never, permission: string, authNotAfter: number | null, sessionKey: string | null) => Promise<unknown>) | undefined;
  const stub = Object.freeze({ transaction: () => Promise.reject(new Error('unused')), end: async () => undefined });
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, {
    client: () => stub as never,
    store: (options) => { revalidate = options.revalidate as never; return createPostgresTransactionalStore(options); },
    platformAdmission: (client) => createPostgresPlatformAdmission({ client }),
    ...SESSION_FACTORIES,
  });
  assert.ok(boundary !== null && revalidate !== undefined);
  const scope = (roleId: string) => revalScope(roleId) as never;
  const valid = revalHandle();
  const before = Date.now();
  assert.equal(await revalidate(valid.sql, scope('support_admin'), 'edit_tenant_profile', null, REVAL_SESSION_KEY), true);
  assert.deepEqual(valid.steps(), ['009', 'session get', 'touch', '013'], 'no freshness claimed; then 009, the session held, and 013 under the locks');
  assert.match(valid.texts[0], /tmpos_command\.m5_revalidate_platform_authority\(/, 'the exact-authority routine');
  assert.deepEqual(valid.bound[0], [REVAL_ACTOR, 'sv-1', REVAL_MEMBERSHIP, 'support_admin']);
  assert.equal(valid.bound[1][0], REVAL_SESSION_KEY, 'the session the command carried');
  assert.ok(typeof valid.bound[1][1] === 'number' && (valid.bound[1][1] as number) >= before, 'read live at this process\'s clock');
  assert.deepEqual(valid.bound[2], [REVAL_SESSION_KEY, 1_700_000_000_001], 'held by writing back the stamp it read');
  assert.deepEqual(valid.bound[3], ['firebase', 'uid-operator'], 'the standing of the held session\'s own provider reference');
  assert.equal(await revalidate(revalHandle().sql, scope('billing_admin'), 'edit_tenant_profile', null, REVAL_SESSION_KEY), false,
    'the database confirming the grant does not make a View role an editor: the permission is decided again');
  const invalid = revalHandle({ authority: 'invalid' });
  assert.equal(await revalidate(invalid.sql, scope('support_admin'), 'edit_tenant_profile', null, REVAL_SESSION_KEY), false, 'and nothing holds once the database says invalid');
  assert.deepEqual(invalid.steps(), ['009'], 'the session is never touched once 009 refuses');
  // M5-GIAM-D1-P2: a route that required a recent authentication has its deadline judged on the database's
  // clock, on this same transaction, BEFORE the authority routine is asked.
  const fresh = revalHandle();
  assert.equal(await revalidate(fresh.sql, scope('support_admin'), 'edit_tenant_profile', 1_700_000_600_000, REVAL_SESSION_KEY), true);
  assert.deepEqual(fresh.steps(), ['freshness', '009', 'session get', 'touch', '013'], 'freshness first, on the database clock, then as above');
  assert.deepEqual(fresh.bound[0], ['1700000600000'], 'the deadline is bound as a value, never interpolated');
  const stale = revalHandle({ fresh: false });
  assert.equal(await revalidate(stale.sql, scope('support_admin'), 'edit_tenant_profile', 1_700_000_600_000, REVAL_SESSION_KEY), false,
    'expired evidence denies whatever the authority routine would have said');
  // M5-ADMIN-REVOKE-P1: no session, a session ended first, and a standing that moved each commit nothing.
  const unkeyed = revalHandle();
  assert.equal(await revalidate(unkeyed.sql, scope('support_admin'), 'edit_tenant_profile', null, null), false, 'a command no session presented');
  assert.deepEqual(unkeyed.steps(), ['009']);
  for (const [label, over, steps] of [
    ['a session logged out or revoked first', { session: [] }, ['009', 'session get']],
    ['a session ended between the read and the hold', { touch: 'absent' }, ['009', 'session get', 'touch']],
    ['a tenant record under the key', { session: [{ ...sessionRow(revalWitness('support_admin')), audience: 'tenant' }] }, ['009', 'session get']],
    ['a grant removed and restored since the session was admitted', { admission: [admissionRow('support_admin', '5')] }, ['009', 'session get', 'touch', '013']],
    ['a standing that no longer admits', { admission: [{ outcome: 'refused', actor_id: null, account_status: null, limitation: null, security_version: null, memberships: null, authority_version: null }] },
      ['009', 'session get', 'touch', '013']],
  ] as Array<[string, Parameters<typeof revalHandle>[0], string[]]>) {
    const handle = revalHandle(over);
    assert.equal(await revalidate(handle.sql, scope('support_admin'), 'edit_tenant_profile', null, REVAL_SESSION_KEY), false, label);
    assert.deepEqual(handle.steps(), steps, label);
  }
  await boundary.close();
});

test('the session store is composed with the administrative login\'s standing check: 013, 009\'s locks through the lock that throws, 013 again', async () => {
  // M5-ADMIN-REVOKE-P1: the check the transaction root hands the session store, run on establish's own handle. It reads the
  // admission for the RECORD's provider reference, locks exactly the scope that read selected, and reads again — and it is
  // bound to lockPlatformAuthority, so a malformed 009 answer is an outage (a throw), never "the standing changed".
  let standing: SessionStandingCheck | undefined;
  const stub = Object.freeze({ transaction: () => Promise.reject(new Error('unused')), end: async () => undefined });
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, {
    client: () => stub as never,
    store: createPostgresTransactionalStore,
    platformAdmission: (client) => createPostgresPlatformAdmission({ client }),
    ...SESSION_FACTORIES,
    sessionStore: (client, check) => { standing = check; return createPostgresSessionStore({ client, standing: check }); },
  });
  assert.ok(boundary !== null && standing !== undefined);
  const record = Object.freeze({
    audience: 'admin' as const, authProvider: 'firebase', authProviderUid: 'uid-operator', principalKey: 'p'.repeat(43),
    securityVersion: revalWitness('support_admin'), authenticatedAt: 1_700_000_000_000, createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000, validatedAt: 1_700_000_000_000,
  });
  const held = revalHandle();
  assert.equal(await standing(held.sql, record), true);
  assert.deepEqual(held.steps(), ['013', '009', '013'], 'the standing, then 009\'s locks for the scope it selected, then the standing again');
  assert.deepEqual(held.bound[0], ['firebase', 'uid-operator'], 'the record\'s own provider reference');
  assert.deepEqual(held.bound[1], [REVAL_ACTOR, 'sv-1', REVAL_MEMBERSHIP, 'support_admin'], 'the lock names exactly the grant the read selected');
  assert.deepEqual(held.bound[2], ['firebase', 'uid-operator']);
  const moved = revalHandle({ admission: [admissionRow('support_admin', '4')] });
  assert.equal(await standing(moved.sql, record), false, 'a standing that moved since the login\'s admission');
  assert.deepEqual(moved.steps(), ['013'], 'no lock is taken for it');
  assert.equal(await standing(revalHandle({ authority: 'invalid' }).sql, record), false, '009 answering invalid');
  // A fault is an outage — never false.
  await assert.rejects(standing(revalHandle({ authority: 'maybe' }).sql, record), /platform authority unavailable/, 'a malformed 009 answer throws');
  await assert.rejects(standing(revalHandle({ admission: [{ outcome: 'resolved' }] }).sql, record), /platform admission unavailable/, 'a malformed 013 answer throws');
  await boundary.close();
});

test('M5T-PT1 the ONE session store\'s standing check dispatches on the record: admin to 013/009, tenant to 016\'s hold then v2, anything else throws', async () => {
  // M5-TENANT-SESSION-P1: one store serves both audiences, so the check it is handed decides by the record's audience.
  let standing: SessionStandingCheck | undefined;
  const stub = Object.freeze({ transaction: () => Promise.reject(new Error('unused')), end: async () => undefined });
  const boundary = assembleTransactions(REQUIRED, CONFIGURED, {
    client: () => stub as never,
    store: createPostgresTransactionalStore,
    platformAdmission: (client) => createPostgresPlatformAdmission({ client }),
    ...SESSION_FACTORIES,
    sessionStore: (client, check) => { standing = check; return createPostgresSessionStore({ client, standing: check }); },
  });
  assert.ok(boundary !== null && standing !== undefined);
  const base = {
    authProvider: 'firebase', authProviderUid: 'uid-operator', principalKey: 'p'.repeat(43), authenticatedAt: null,
    createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_000_000, validatedAt: 1_700_000_000_000,
  };
  const admin = revalHandle();
  assert.equal(await standing(admin.sql, { ...base, audience: 'admin', securityVersion: revalWitness('support_admin') }), true);
  assert.deepEqual(admin.steps(), ['013', '009', '013'], 'an administrative record: the platform check, unchanged');
  const tenantRecord = { ...base, audience: 'tenant' as const, securityVersion: tenantWitness };
  const tenant = revalHandle();
  assert.equal(await standing(tenant.sql, tenantRecord), true);
  assert.deepEqual(tenant.steps(), ['016 hold', '016 v2'], 'a tenant record: the hold, then the re-read on the same handle');
  assert.deepEqual(tenant.bound, [['firebase', 'uid-operator'], ['firebase', 'uid-operator']], 'the record\'s own provider reference, twice');
  const moved = revalHandle({ tenant: [tenantAdmissionRow('2')] });
  assert.equal(await standing(moved.sql, tenantRecord), false, 'a grant version that moved since the login\'s admission');
  const absent = revalHandle({ hold: 'absent' });
  assert.equal(await standing(absent.sql, tenantRecord), false, 'no account to hold');
  assert.deepEqual(absent.steps(), ['016 hold'], 'and no re-read after it');
  await assert.rejects(standing(revalHandle({ hold: 'maybe' }).sql, tenantRecord), /tenant standing unavailable/, 'a malformed hold answer throws');
  const other = revalHandle();
  await assert.rejects(standing(other.sql, { ...tenantRecord, audience: 'support' as never }), /session standing unavailable/, 'an audience with no check');
  assert.deepEqual(other.steps(), [], 'refused before any statement');
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
    // The administrative boundary alone, as the administrative entry composes it: that root builds no role-levels read, so
    // it composes no tenant authorizer (M7A-CUSTOMERS-P3-R1).
    const { limits } = composeProductionSessions(sessionEnv, {
      store: boundary.sessionStore, tenantAdmission: boundary.tenantAdmission, platformAdmission: boundary.platformAdmission, rateLimiter: boundary.rateLimiter,
    }, { audiences: ['admin'] });
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

// ---------------------------------------------------------------------------
// M7A-CUSTOMERS-P2 — the read-only composition over the shared kernel (transactionKernel.ts), for the tenant root
// (tenantTransactions.ts) alone
// ---------------------------------------------------------------------------
// What is proved: TENANT_SESSION_ISSUER_KEY is judged before any client exists (missing, invalid, shared with RATE_LIMIT_KEY
// however padded, weak), and so is APP_DATABASE_URL; a valid configuration builds the kernel once and hands back exactly the
// customer route, bound to the session and classified as a read; the session store mints under the issuer key and holds
// the tenant standing alone; the issuer-key probe sends a fingerprint, never the key; the reads' probe is the inventory's;
// a fault after the kernel exists ends it; and the administrative root still composes no key. Substituted: the kernel (an
// in-test recorder answering by statement text).

/** A random key: canonical, never RATE_LIMIT_KEY, and (with ~30 distinct values in 32 bytes) never weak. */
const TENANT_ISSUER_KEY = randomBytes(32);
const TENANT_CONFIGURED = Object.freeze({
  APP_DATABASE_URL: DIRECT_URL, RATE_LIMIT_KEY, TENANT_SESSION_ISSUER_KEY: TENANT_ISSUER_KEY.toString('base64url'),
  // M7A-CUSTOMERS-P3: the tenant process's own command secret for the write slot, never the limiter's or the issuer key.
  IDEMPOTENCY_KEY,
});

/** A kernel that answers by statement text and records every statement's bound values; no driver, no socket. */
function recordingKernel(answer: (text: string) => unknown = () => []) {
  const statements: { text: string; values: unknown[] }[] = [];
  let ended = 0;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    const text = strings.join('?');
    statements.push({ text, values });
    return answer(text);
  }, { json: (v: unknown) => v });
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(_signal: AbortSignal, _bounds: TransactionBounds, work: (scope: PgTransactionScope) => Promise<T>): Promise<T> =>
      work(sql as unknown as PgTransactionScope),
    end: async (): Promise<void> => { ended++; },
  });
  return { client, statements, ended: () => ended };
}

const blockersOfRead = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    composeReadTransactions(TENANT_INVENTORY, env, () => assert.fail('no client may be built'));
  } catch (err) {
    if (err instanceof TransactionCompositionError) return err.blockers;
    throw err;
  }
  return assert.fail('composition must refuse');
};

test('M7TK-01 parseTenantIssuerKey: missing, invalid, shared with RATE_LIMIT_KEY however padded, and weak are each refused; a random key is its bytes', () => {
  const env = (key: string | undefined, over: Record<string, string | undefined> = {}) => ({ RATE_LIMIT_KEY, ...over, TENANT_SESSION_ISSUER_KEY: key });
  const b64 = (bytes: Buffer): string => bytes.toString('base64url');
  const vector = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ['absent', env(undefined), 'tenant_issuer_key_missing'],
    ['empty', env(''), 'tenant_issuer_key_missing'],
    ['too short', env(b64(randomBytes(31))), 'tenant_issuer_key_invalid'],
    ['too long', env(b64(randomBytes(65))), 'tenant_issuer_key_invalid'],
    ['padded base64url', env(`${b64(randomBytes(32))}=`), 'tenant_issuer_key_invalid'],
    ['not canonical (stray bits in the last character)', env(`${b64(TENANT_ISSUER_KEY).slice(0, 42)}B`), 'tenant_issuer_key_invalid'],
    ['equal to RATE_LIMIT_KEY', env(RATE_LIMIT_KEY), 'tenant_issuer_key_shared'],
    ['RATE_LIMIT_KEY zero-padded to 33 bytes (the same HMAC key)', env(b64(Buffer.concat([Buffer.from(RATE_LIMIT_KEY, 'base64url'), Buffer.alloc(1)]))), 'tenant_issuer_key_shared'],
    ['equal to a random RATE_LIMIT_KEY', env(b64(TENANT_ISSUER_KEY), { RATE_LIMIT_KEY: b64(TENANT_ISSUER_KEY) }), 'tenant_issuer_key_shared'],
    ['the recorded test vector (bytes 0x00..0x1f)', env(b64(vector)), 'tenant_issuer_key_weak'],
    ['the test vector zero-padded (the same HMAC key)', env(b64(Buffer.concat([vector, Buffer.alloc(8)]))), 'tenant_issuer_key_weak'],
    ['one repeated byte', env(b64(Buffer.alloc(32, 0x5a))), 'tenant_issuer_key_weak'],
    ['all zeros', env(b64(Buffer.alloc(32))), 'tenant_issuer_key_weak'],
    ['two bytes then zeros (2 effective bytes)', env(b64(Buffer.concat([Buffer.from([0xab, 0xcd]), Buffer.alloc(30)]))), 'tenant_issuer_key_weak'],
    ['15 distinct values', env(b64(Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + (i % 15))))), 'tenant_issuer_key_weak'],
  ];
  for (const [label, e, code] of cases) assert.equal(parseTenantIssuerKey(e), code, label);
  // Exactly 16 distinct values is the floor that passes; a random key is its own bytes, whatever RATE_LIMIT_KEY is.
  const sixteen = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + (i % 16)));
  assert.deepEqual(parseTenantIssuerKey(env(b64(sixteen))), sixteen, '16 distinct values');
  assert.deepEqual(parseTenantIssuerKey(env(b64(TENANT_ISSUER_KEY))), TENANT_ISSUER_KEY, 'a random key');
  assert.deepEqual(parseTenantIssuerKey(env(b64(TENANT_ISSUER_KEY), { RATE_LIMIT_KEY: undefined })), TENANT_ISSUER_KEY, 'without a limiter key to compare');
  const long = randomBytes(64);
  assert.deepEqual(parseTenantIssuerKey(env(b64(long))), long, 'a 64-byte key');
});

test('M7TK-02 composeReadTransactions refuses APP_DATABASE_URL, the issuer key and — for the write slot — IDEMPOTENCY_KEY before any client exists, naming every blocker', () => {
  assert.deepEqual(blockersOfRead({}), ['app_database_url_missing', 'tenant_issuer_key_missing', 'idempotency_key_missing']);
  // M7A-CUSTOMERS-P3: the write slot's key — present, canonical, and never the limiter's or the issuer key, however padded.
  for (const missing of [undefined, '']) assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, IDEMPOTENCY_KEY: missing }), ['idempotency_key_missing']);
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, IDEMPOTENCY_KEY: 'short' }), ['idempotency_key_invalid']);
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, IDEMPOTENCY_KEY: RATE_LIMIT_KEY }), ['idempotency_key_shared']);
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, IDEMPOTENCY_KEY: TENANT_CONFIGURED.TENANT_SESSION_ISSUER_KEY }), ['idempotency_key_shared']);
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, IDEMPOTENCY_KEY: Buffer.concat([TENANT_ISSUER_KEY, Buffer.alloc(1)]).toString('base64url') }),
    ['idempotency_key_shared'], 'the issuer key zero-padded is the same HMAC key');
  // A read-only inventory (no write slot) still reads no IDEMPOTENCY_KEY at all.
  const { writes: _writes, ...readOnly } = TENANT_INVENTORY;
  assert.doesNotThrow(() => composeReadTransactions(readOnly, { ...TENANT_CONFIGURED, IDEMPOTENCY_KEY: undefined }, () => recordingKernel().client));
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, APP_DATABASE_URL: POOLER_URL.replace(':5432', ':6543') }), ['app_database_endpoint_unsupported']);
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, TENANT_SESSION_ISSUER_KEY: 'short' }), ['tenant_issuer_key_invalid']);
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, TENANT_SESSION_ISSUER_KEY: RATE_LIMIT_KEY }), ['tenant_issuer_key_shared']);
  assert.deepEqual(blockersOfRead({ ...TENANT_CONFIGURED, TENANT_SESSION_ISSUER_KEY: Buffer.alloc(32, 7).toString('base64url'), RATE_LIMIT_KEY: undefined }),
    ['tenant_issuer_key_weak']);
  assert.throws(() => composeReadTransactions(TENANT_INVENTORY, TENANT_CONFIGURED, 'not a constructor' as never), TypeError);
  // A TLS configuration the client refuses is a bounded blocker, exactly as for the administrative root.
  assert.throws(() => composeReadTransactions(TENANT_INVENTORY, TENANT_CONFIGURED, () => { throw new DatabaseTlsRefusal('synthetic'); }),
    (err: unknown) => err instanceof TransactionCompositionError && err.blockers.join() === 'database_tls_invalid');
});

test('M7TK-03 the tenant root builds its kernel once and serves exactly the tenant routes: the customer reads session-bound, the sixteen reads classified as reads, the eight commands not', async () => {
  const customerId = randomUUID();
  const kernel = recordingKernel((text) => (text.includes('m7a_customer_page_v3') || text.includes('m7a_customer_get')
    ? [{ o_outcome: 'customer', o_tenant_id: REVAL_TENANT, o_customer_id: customerId, o_name: 'n' }]
    : text.includes('m7a_customer_profile') ? [{ o_outcome: 'customer', o_tenant_id: REVAL_TENANT, o_customer_id: customerId, o_name: 'n',
      o_phone: '+1 555 0100', o_email: null, o_created_at: '2026-09-30T08:15:42.123Z', o_version: '2' }]
    : text.includes('m7a_invoice_role_level_states') ? [{ states: [{ roleId: 'manager', level: 'edit', version: 1 }, { roleId: 'technician', level: null, version: 0 },
      { roleId: 'sales_staff', level: null, version: 0 }] }]
    : text.includes('m7a_role_level_states') ? [{ states: [{ roleId: 'manager', level: null, version: 0 }, { roleId: 'technician', level: 'none', version: 2 },
      { roleId: 'sales_staff', level: 'view', version: 5 }] }]
      : text.includes('m7a_role_levels') ? [{ levels: { customers: 'view' } }]
        : text.includes('m7b_store_directory') ? [{ o_outcome: 'store', o_store_id: customerId, o_tenant_id: REVAL_TENANT, o_store_name: 'Main', o_read_only: false }] : []));
  let calls = 0;
  let seen: unknown;
  const ttx = composeTenantTransactions(TENANT_CONFIGURED, (endpoint) => { calls++; seen = endpoint; return kernel.client; });
  assert.equal(calls, 1, 'the handed constructor is called exactly once');
  assert.equal((seen as { family: string }).family, 'direct', 'over the classified endpoint');
  assert.deepEqual(ttx.routes.map((r) => [r.method, r.path, r.policy.access, r.policy.access === 'session' ? r.policy.audience : null,
    r.sessionBinding, r.trustedContext, r.idempotency]), [
    ['GET', '/api/v1/customers', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/customers/{id}', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/customers/{id}/profile', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/roles/levels', 'session', 'tenant', 'none', 'required', 'none'],
    ['GET', '/api/v1/roles/levels/invoices', 'session', 'tenant', 'none', 'required', 'none'],
    // M7B-INVOICES-P1: the store directory — session-bound, and the route table's one closed authorization-free shape.
    ['GET', '/api/v1/stores', 'session', 'tenant', 'required', 'none', 'none'],
    // M7B-INVOICES-P1: the invoice drafts' two store-scope reads, session-bound under a resolved store scope.
    ['GET', '/api/v1/stores/{storeId}/invoice-drafts', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/stores/{storeId}/invoice-drafts/{id}', 'session', 'tenant', 'required', 'required', 'none'],
    // M7B-INVOICES-P1-R2: the drafts' creation eligibility, a session-bound store-scope read appended after the detail.
    ['GET', '/api/v1/stores/{storeId}/invoice-drafts/eligibility', 'session', 'tenant', 'required', 'required', 'none'],
    // M7B-INVOICES-P2: the drafts' edit eligibility, a session-bound store-scope read appended after the creation eligibility.
    ['GET', '/api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility', 'session', 'tenant', 'required', 'required', 'none'],
    // M7B-INVOICES-DISCARD-P1: the drafts' discard eligibility, a session-bound store-scope read appended after the edit eligibility.
    ['GET', '/api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility', 'session', 'tenant', 'required', 'required', 'none'],
    // M7B-INVOICES-ISSUE-P1: the owner's settings read (tenant scope), the issue eligibility and preview, and the issued list and
    // detail (store scope), each session-bound, appended after the discard eligibility.
    ['GET', '/api/v1/issuing-settings/{id}', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/stores/{storeId}/invoices', 'session', 'tenant', 'required', 'required', 'none'],
    ['GET', '/api/v1/stores/{storeId}/invoices/{id}', 'session', 'tenant', 'required', 'required', 'none'],
    ['POST', '/api/v1/customers', 'session', 'tenant', 'none', 'required', 'required'],
    ['PATCH', '/api/v1/customers/{id}', 'session', 'tenant', 'none', 'required', 'required'],
    ['PUT', '/api/v1/roles/levels', 'session', 'tenant', 'none', 'required', 'required'],
    // M7B-INVOICES-P1: the draft save, the store template's first command.
    ['POST', '/api/v1/stores/{storeId}/invoice-drafts', 'session', 'tenant', 'none', 'required', 'required'],
    // M7B-INVOICES-P2: the draft edit, its second.
    ['PATCH', '/api/v1/stores/{storeId}/invoice-drafts/{id}', 'session', 'tenant', 'none', 'required', 'required'],
    // M7B-INVOICES-DISCARD-P1: the draft discard, its third.
    ['POST', '/api/v1/stores/{storeId}/invoice-drafts/{id}/discard', 'session', 'tenant', 'none', 'required', 'required'],
    // M7B-INVOICES-ISSUE-P1: the owner's settings write (tenant scope) and the issue (store scope), last.
    ['PUT', '/api/v1/issuing-settings/{id}', 'session', 'tenant', 'none', 'required', 'required'],
    ['POST', '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue', 'session', 'tenant', 'none', 'required', 'required'],
  ]);
  assert.deepEqual([...ttx.tenantReads], ['GET /api/v1/customers', 'GET /api/v1/customers/{id}', 'GET /api/v1/customers/{id}/profile', 'GET /api/v1/roles/levels', 'GET /api/v1/roles/levels/invoices',
    'GET /api/v1/stores', 'GET /api/v1/stores/{storeId}/invoice-drafts', 'GET /api/v1/stores/{storeId}/invoice-drafts/{id}',
    'GET /api/v1/stores/{storeId}/invoice-drafts/eligibility', 'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility',
    'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility', 'GET /api/v1/issuing-settings/{id}',
    'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility', 'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview',
    'GET /api/v1/stores/{storeId}/invoices', 'GET /api/v1/stores/{storeId}/invoices/{id}'],
    'the reads alone are classified as reads — the detail and the profile by their templates, never an id — and never a command');
  assert.deepEqual(tenantRouteDeclarations().map((r) => `${r.method} ${r.path}`),
    ['GET /api/v1/customers', 'GET /api/v1/customers/{id}', 'GET /api/v1/customers/{id}/profile', 'GET /api/v1/roles/levels', 'GET /api/v1/roles/levels/invoices', 'GET /api/v1/stores',
      'GET /api/v1/stores/{storeId}/invoice-drafts', 'GET /api/v1/stores/{storeId}/invoice-drafts/{id}', 'GET /api/v1/stores/{storeId}/invoice-drafts/eligibility',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility', 'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility',
      'GET /api/v1/issuing-settings/{id}', 'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview', 'GET /api/v1/stores/{storeId}/invoices', 'GET /api/v1/stores/{storeId}/invoices/{id}',
      'POST /api/v1/customers', 'PATCH /api/v1/customers/{id}', 'PUT /api/v1/roles/levels', 'POST /api/v1/stores/{storeId}/invoice-drafts',
      'PATCH /api/v1/stores/{storeId}/invoice-drafts/{id}', 'POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard', 'PUT /api/v1/issuing-settings/{id}',
      'POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue']);
  assert.deepEqual(ttx.routes[5].policy, { access: 'session', audience: 'tenant', authorization: null }, 'the store directory declares no authorization');
  assert.deepEqual([6, 7, 8, 19, 9, 20, 10, 21].map((i) => ttx.routes[i].policy), [
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'view_invoice_drafts' } },
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'view_invoice_drafts' } },
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'create_invoice_drafts' } },
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'create_invoice_drafts' } },
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'edit_invoice_drafts' } },
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'edit_invoice_drafts' } },
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'discard_invoice_drafts' } },
    { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'discard_invoice_drafts' } },
  ], 'the draft routes require the STORE route permissions — each eligibility read exactly its command\'s');
  // M7B-INVOICES-ISSUE-P1: the settings read and write under the owner-only TENANT permission; the issue, its eligibility and
  // its preview under issue_invoices; the issued reads under view_issued_invoices.
  assert.deepEqual([11, 22, 12, 13, 23, 14, 15].map((i) => [`${ttx.routes[i].method} ${ttx.routes[i].path}`, ttx.routes[i].policy, ttx.routes[i].recentAuth]), [
    ['GET /api/v1/issuing-settings/{id}', { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'edit_issuing_settings' } }, 'none'],
    ['PUT /api/v1/issuing-settings/{id}', { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'edit_issuing_settings' } }, 'required'],
    ['GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility', { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'issue_invoices' } }, 'none'],
    ['GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview', { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'issue_invoices' } }, 'none'],
    ['POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue', { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'issue_invoices' } }, 'none'],
    ['GET /api/v1/stores/{storeId}/invoices', { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'view_issued_invoices' } }, 'none'],
    ['GET /api/v1/stores/{storeId}/invoices/{id}', { access: 'session', audience: 'tenant', authorization: { scope: 'store', permission: 'view_issued_invoices' } }, 'none'],
  ]);
  assert.deepEqual([8, 19, 9, 20, 10, 21].map((i) => `${ttx.routes[i].method} ${ttx.routes[i].path}`),
    ['GET /api/v1/stores/{storeId}/invoice-drafts/eligibility', 'POST /api/v1/stores/{storeId}/invoice-drafts',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility', 'PATCH /api/v1/stores/{storeId}/invoice-drafts/{id}',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility', 'POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard']);
  assert.ok(ttx.idempotency !== undefined && ttx.transactions !== undefined, 'the write slot composes both ports, together');
  assert.deepEqual(Buffer.from(ttx.idempotency.keySecret), Buffer.from(IDEMPOTENCY_KEY, 'base64url'), 'under this process\'s own key');
  const preflight = ttx.preflight as unknown as Record<string, unknown>;
  assert.deepEqual(['connect', 'runtimeLogin', 'migrationLedger', 'parameterLogging', 'rateLimitKey'].map((k) => typeof preflight[k]), Array(5).fill('function'));
  assert.equal(typeof ttx.tenantAdmission.probe, 'function');
  assert.ok(Object.isFrozen(ttx) && Object.isFrozen(ttx.routes));
  assert.equal(kernel.statements.length, 0, 'composing sends nothing');
  // The served route reads through the production adapter over this kernel: 018's session-bound routine, with the key.
  const route = ttx.routes[0];
  assert.ok(route.idempotency === 'none' && typeof route.handler === 'function');
  const sessionKey = 'k'.repeat(43);
  const scope = Object.freeze({
    actor: REVAL_ACTOR, securityVersion: 'sv-1', scope: 'tenant', tenant: REVAL_TENANT, store: null, membershipId: REVAL_MEMBERSHIP,
    roleId: 'manager', limitation: 'none',
  });
  const reply: { status: number | null; body: unknown } = { status: null, body: undefined };
  const res = { locals: {}, status(code: number) { reply.status = code; return res; }, json(body: unknown) { reply.body = body; return res; } };
  await route.handler({ url: '/api/v1/customers?limit=1' } as never, res as never,
    { requestId: 'req-m7tk03', principal: null, session: null, authenticatedAt: null, trusted: scope, sessionKey } as never);
  assert.deepEqual(kernel.statements.map((st) => st.values), [[sessionKey, null, 2]], 'one statement: the session key, no cursor, the limit and its lookahead');
  assert.match(kernel.statements[0].text, /from tmpos_role\.m7a_customer_page_v3\(\?::text, \?::uuid, \?::integer\)/);
  assert.deepEqual([reply.status, reply.body], [200, { customers: [{ id: customerId, name: 'n' }], nextCursor: null }]);
  // M7A-CUSTOMERS-P4: the detail read through its production adapter over this kernel — 022's routine, key, id and tenant.
  kernel.statements.length = 0;
  const detail = ttx.routes[1];
  assert.ok(detail.path === '/api/v1/customers/{id}' && detail.idempotency === 'none' && typeof detail.handler === 'function');
  const detailReply: { status: number | null; body: unknown } = { status: null, body: undefined };
  const detailRes = { locals: {}, status(code: number) { detailReply.status = code; return detailRes; }, json(body: unknown) { detailReply.body = body; return detailRes; } };
  await detail.handler({ url: `/api/v1/customers/${customerId}`, path: `/api/v1/customers/${customerId}` } as never, detailRes as never,
    { requestId: 'req-m7tk03-detail', principal: null, session: null, authenticatedAt: null, trusted: scope, sessionKey } as never);
  assert.deepEqual(kernel.statements.map((st) => st.values), [[sessionKey, customerId, REVAL_TENANT]], 'one statement: the key, the id, the trusted tenant');
  assert.match(kernel.statements[0].text, /from tmpos_customer_detail\.m7a_customer_get\(\?::text, \?::uuid, \?::uuid\)/);
  assert.deepEqual([detailReply.status, detailReply.body], [200, { customer: { id: customerId, name: 'n' } }]);
  // M7A-CUSTOMERS-P6: the profile read through its production adapter over this kernel — since -P7 024's versioned routine, key,
  // id and tenant, the version as the strong ETag.
  kernel.statements.length = 0;
  const profile = ttx.routes[2];
  assert.ok(profile.path === '/api/v1/customers/{id}/profile' && profile.idempotency === 'none' && typeof profile.handler === 'function');
  const profileReply: { status: number | null; body: unknown; etag?: unknown } = { status: null, body: undefined };
  const profileRes = {
    locals: {}, setHeader(name: string, value: unknown) { if (name === 'ETag') profileReply.etag = value; return profileRes; },
    status(code: number) { profileReply.status = code; return profileRes; }, json(body: unknown) { profileReply.body = body; return profileRes; },
    end(chunk: unknown) { profileReply.body = JSON.parse(Buffer.from(chunk as Uint8Array).toString('utf8')); return profileRes; },
  };
  await profile.handler({ url: `/api/v1/customers/${customerId}/profile`, path: `/api/v1/customers/${customerId}/profile` } as never, profileRes as never,
    { requestId: 'req-m7tk03-profile', principal: null, session: null, authenticatedAt: null, trusted: scope, sessionKey } as never);
  assert.deepEqual(kernel.statements.map((st) => st.values), [[sessionKey, customerId, REVAL_TENANT]], 'one statement: the key, the id, the trusted tenant');
  assert.match(kernel.statements[0].text, /from tmpos_customer_edit\.m7a_customer_profile\(\?::text, \?::uuid, \?::uuid\)/);
  assert.deepEqual([profileReply.status, profileReply.body, profileReply.etag],
    [200, { customer: { id: customerId, name: 'n', phone: '+1 555 0100', email: null, createdAt: '2026-09-30T08:15:42.123Z' } }, '"2"']);
  // M7A-CUSTOMERS-P3-R1: the role-levels read the entry hands the tenant route authorizer, over this same kernel.
  kernel.statements.length = 0;
  assert.deepEqual(await ttx.roleLevels(REVAL_TENANT, 'sales_staff', new AbortController().signal), { customers: 'view' });
  assert.deepEqual(kernel.statements.map((st) => st.values), [[REVAL_TENANT, 'sales_staff']], 'one statement: the trusted tenant and role');
  assert.match(kernel.statements[0].text, /^select tmpos_role\.m7a_role_levels\(\?::uuid, \?::text\) as levels$/);
  // M7A-CUSTOMERS-P3-R2: the owner's read-back over this same kernel — ONE statement reading the three editable roles of the
  // trusted scope's tenant (one snapshot), each beside the catalog default the tenant root adds, the owner first and fixed.
  // M7A-CUSTOMERS-P4: that statement is 021's states routine, and each editable role carries its version; the owner none.
  kernel.statements.length = 0;
  const readBack = ttx.routes[3]; // M7A-CUSTOMERS-P6: after the profile read, which the inventory declares beside the detail
  assert.ok(readBack.path === '/api/v1/roles/levels' && readBack.idempotency === 'none' && typeof readBack.handler === 'function');
  const levelsReply: { status: number | null; body: unknown } = { status: null, body: undefined };
  const levelsRes = { locals: {}, status(code: number) { levelsReply.status = code; return levelsRes; }, json(body: unknown) { levelsReply.body = body; return levelsRes; } };
  await readBack.handler({ url: '/api/v1/roles/levels' } as never, levelsRes as never,
    { requestId: 'req-m7tk03-levels', principal: null, session: null, authenticatedAt: null, trusted: { ...scope, roleId: 'store_owner' }, sessionKey: null } as never);
  assert.deepEqual(kernel.statements.map((st) => st.values), [[REVAL_TENANT]], 'one statement: the trusted tenant alone');
  assert.match(kernel.statements[0].text, /^select tmpos_role_edit\.m7a_role_level_states\(\?::uuid\) as states$/);
  assert.deepEqual([levelsReply.status, levelsReply.body], [200, { tenant: REVAL_TENANT, domain: 'customers', roles: [
    { roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null },
    { roleId: 'manager', level: 'full', defaultLevel: 'full', source: 'default', editable: true, version: 0 },
    { roleId: 'technician', level: 'none', defaultLevel: 'view', source: 'stored', editable: true, version: 2 },
    { roleId: 'sales_staff', level: 'view', defaultLevel: 'create', source: 'stored', editable: true, version: 5 },
  ] }], 'the catalog defaults (manager Full, technician View, sales_staff Create), the stored overrides and their versions');
  // M5-INVOICES-AUTH-P1: the Invoices read-back over the same kernel — ONE statement into 026's states routine, the trusted
  // tenant alone; the defaults are the catalog's Invoices ones (manager Full, technician View, sales_staff Create).
  kernel.statements.length = 0;
  const invoiceReadBack = ttx.routes[4];
  assert.ok(invoiceReadBack.path === '/api/v1/roles/levels/invoices' && invoiceReadBack.idempotency === 'none' && typeof invoiceReadBack.handler === 'function');
  levelsReply.status = null;
  levelsReply.body = undefined;
  await invoiceReadBack.handler({ url: '/api/v1/roles/levels/invoices' } as never, levelsRes as never,
    { requestId: 'req-m7tk03-invoice-levels', principal: null, session: null, authenticatedAt: null, trusted: { ...scope, roleId: 'store_owner' }, sessionKey: null } as never);
  assert.deepEqual(kernel.statements.map((st) => st.values), [[REVAL_TENANT]], 'one statement: the trusted tenant alone');
  assert.match(kernel.statements[0].text, /^select tmpos_role_invoice\.m7a_invoice_role_level_states\(\?::uuid\) as states$/);
  assert.deepEqual([levelsReply.status, levelsReply.body], [200, { tenant: REVAL_TENANT, domain: 'invoices', roles: [
    { roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null },
    { roleId: 'manager', level: 'edit', defaultLevel: 'full', source: 'stored', editable: true, version: 1 },
    { roleId: 'technician', level: 'view', defaultLevel: 'view', source: 'default', editable: true, version: 0 },
    { roleId: 'sales_staff', level: 'create', defaultLevel: 'create', source: 'default', editable: true, version: 0 },
  ] }], 'the Invoices catalog defaults, one stored override and its version');
  // M7B-INVOICES-P1: the store directory through its production adapter over this kernel — ONE statement into 027's routine
  // with the session key alone; no trusted scope exists for it.
  kernel.statements.length = 0;
  const stores = ttx.routes[5];
  assert.ok(stores.path === '/api/v1/stores' && stores.idempotency === 'none' && typeof stores.handler === 'function');
  levelsReply.status = null;
  levelsReply.body = undefined;
  await stores.handler({ url: '/api/v1/stores' } as never, levelsRes as never,
    { requestId: 'req-m7tk03-stores', principal: null, session: null, authenticatedAt: null, trusted: null, sessionKey } as never);
  assert.deepEqual(kernel.statements.map((st) => st.values), [[sessionKey]], 'one statement: the session key alone');
  assert.match(kernel.statements[0].text, /from tmpos_store_access\.m7b_store_directory\(\?::text\)$/);
  assert.deepEqual([levelsReply.status, levelsReply.body], [200, { stores: [{ id: customerId, tenantId: REVAL_TENANT, name: 'Main', readOnly: false }] }]);
  await ttx.close();
  assert.equal(kernel.ended(), 1);
});

test('M7TK-04 the tenant session store mints under the issuer key and holds the tenant standing alone: an administrative record throws before any statement', async () => {
  const tenantRow = tenantAdmissionRow();
  const kernel = recordingKernel((text) => {
    if (text.includes('m5_hold_tenant_standing')) return [{ outcome: 'held' }];
    if (text.includes('m5_admit_tenant_session_v2')) return [tenantRow];
    if (text.includes('m7a_session_create')) return [{ outcome: 'created' }];
    if (/insert into public\.audit_event/.test(text)) return Object.assign([], { count: 1, command: 'INSERT' });
    throw new Error(`a statement the tenant store never sends here: ${text.slice(0, 80)}`);
  });
  const ttx = composeTenantTransactions(TENANT_CONFIGURED, () => kernel.client);
  const now = Date.now();
  const record = Object.freeze({
    audience: 'tenant' as const, authProvider: 'firebase', authProviderUid: 'uid-tenant', principalKey: 'p'.repeat(43),
    securityVersion: tenantWitness, authenticatedAt: now - 1_000, createdAt: now, lastSeenAt: now, validatedAt: now,
  });
  const audit = Object.freeze({ action: 'login' as const, operationId: randomUUID(), actor: REVAL_ACTOR, authenticatedAt: now - 1_000 });
  const key = 'k'.repeat(43);
  assert.equal(await ttx.sessionStore.establish?.(key, record, null, audit, new AbortController().signal), 'established');
  const steps = kernel.statements.map((st) => (st.text.includes('m5_hold_tenant_standing') ? '016 hold' : st.text.includes('m5_admit_tenant_session_v2') ? '016 v2'
    : st.text.includes('m7a_session_create') ? 'mint' : 'audit'));
  assert.deepEqual(steps, ['016 hold', '016 v2', 'mint', 'audit'], 'the tenant standing, then 018\'s mint, then the record');
  const mint = kernel.statements[2].values;
  assert.equal(mint.length, 12);
  assert.deepEqual(mint[11], tenantMintProof(TENANT_ISSUER_KEY, key, record, mint[10] as number), 'the proof under this process\'s issuer key');
  // An administrative record is a wiring fault in the tenant process: refused before anything is sent.
  const sent = kernel.statements.length;
  await assert.rejects(Promise.resolve(ttx.sessionStore.establish?.('a'.repeat(43), { ...record, audience: 'admin', securityVersion: 'v1' }, null, audit,
    new AbortController().signal)), /session store unavailable/);
  assert.equal(kernel.statements.length, sent, 'nothing sent for an administrative record');
  await ttx.close();
});

test('M7TK-05 the issuer-key probe sends a 32-byte fingerprint and never the key, the mint probe is the session store\'s, and the reads\' probe is the customer directory\'s, then the detail\'s, then the profile\'s, then the search\'s, then the store directory\'s, then the invoice drafts\'', async () => {
  let answer: unknown = [{ outcome: 'match' }];
  const denied = [{ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null }];
  const profileDenied = [{ ...denied[0], o_phone: null, o_email: null, o_created_at: null, o_version: null }];
  let page: unknown = denied;
  let got: unknown = denied;
  let profiled: unknown = profileDenied;
  let searched: unknown = denied;
  const storesDenied = [{ o_outcome: 'denied', o_store_id: null, o_tenant_id: null, o_store_name: null, o_read_only: null }];
  let stored: unknown = storesDenied;
  const draftPageDenied = [{ o_outcome: 'denied', o_tenant_id: null, o_store_id: null, o_draft_id: null, o_customer_id: null, o_status: null, o_currency: null,
    o_line_count: null, o_subtotal_cents: null, o_created_at: null }];
  const draftGetDenied = [{ ...draftPageDenied[0], o_version: null, o_position: null, o_description: null, o_quantity: null, o_unit_price_cents: null,
    o_line_total_cents: null }];
  let draftPage: unknown = draftPageDenied;
  let draftGot: unknown = draftGetDenied;
  // M7B-INVOICES-ISSUE-P1: 034's four issuing reads, each refusing with every other column null.
  const nulls = (columns: string[]) => [Object.fromEntries([['o_outcome', 'denied'], ...columns.map((c) => [c, null])])];
  const settingsDenied = nulls(['o_tenant_id', 'o_store_id', 'o_version', 'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id', 'o_tax_mode', 'o_tax_rate']);
  const previewDenied = nulls(['o_tenant_id', 'o_store_id', 'o_draft_id', 'o_draft_version', 'o_customer_id', 'o_customer_name', 'o_customer_version', 'o_settings_version',
    'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id', 'o_tax_mode', 'o_tax_rate', 'o_currency', 'o_line_count', 'o_subtotal_cents', 'o_tax_cents',
    'o_total_cents', 'o_position', 'o_description', 'o_quantity', 'o_unit_price_cents', 'o_line_total_cents']);
  const issuedPageDenied = nulls(['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_number', 'o_source_draft_id', 'o_customer_id', 'o_customer_name', 'o_currency',
    'o_total_cents', 'o_issued_at', 'o_snapshot_version']);
  const issuedGetDenied = nulls(['o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_number', 'o_snapshot_version', 'o_issued_at', 'o_source_draft_id', 'o_source_draft_version',
    'o_settings_version', 'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id', 'o_customer_id', 'o_customer_name', 'o_customer_version', 'o_currency',
    'o_line_count', 'o_subtotal_cents', 'o_tax_mode', 'o_tax_rate', 'o_tax_cents', 'o_total_cents', 'o_position', 'o_description', 'o_quantity', 'o_unit_price_cents',
    'o_line_total_cents']);
  let issuedGot: unknown = issuedGetDenied;
  let minted: unknown = [{ outcome: 'invalid' }];
  const kernel = recordingKernel((text) => (text.includes('m7a_issuer_key_check') ? answer : text.includes('m7a_customer_page_v3') ? page
    : text.includes('m7a_customer_get') ? got : text.includes('m7a_customer_profile') ? profiled : text.includes('m7a_customer_search') ? searched
      : text.includes('m7b_store_directory') ? stored : text.includes('m7b_invoice_draft_page') ? draftPage : text.includes('m7b_invoice_draft_get') ? draftGot
        : text.includes('m7b_issuing_settings_get') ? settingsDenied : text.includes('m7b_invoice_issue_preview') ? previewDenied
          : text.includes('m7b_issued_invoice_page') ? issuedPageDenied : text.includes('m7b_issued_invoice_get') ? issuedGot
            : text.includes('m7a_session_create') ? minted : []));
  const ttx = composeTenantTransactions(TENANT_CONFIGURED, () => kernel.client);
  const signal = new AbortController().signal;
  assert.equal(await ttx.issuerKey(signal), 'match');
  for (const word of ['mismatch', 'absent', 'invalid']) {
    answer = [{ outcome: word }];
    assert.equal(await ttx.issuerKey(signal), word);
  }
  answer = [{ outcome: 'maybe' }];
  await assert.rejects(ttx.issuerKey(signal), /answer_invalid/, 'an answer outside the four words throws');
  const probes = kernel.statements.filter((st) => st.text.includes('m7a_issuer_key_check'));
  assert.equal(probes.length, 5);
  const keyHex = TENANT_ISSUER_KEY.toString('hex');
  for (const { values } of probes) {
    assert.equal(values.length, 1);
    assert.ok(Buffer.isBuffer(values[0]) && (values[0] as Buffer).length === 32, 'one 32-byte fingerprint');
    assert.ok(!(values[0] as Buffer).equals(TENANT_ISSUER_KEY), 'never the key itself');
  }
  assert.ok(!JSON.stringify(kernel.statements).includes(keyHex) && !JSON.stringify(kernel.statements).includes(TENANT_CONFIGURED.TENANT_SESSION_ISSUER_KEY),
    'no statement carries the key in any spelling');
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), true, 'all eleven routines\' one refusal of an unknown key');
  const asked = (): string[] => kernel.statements.map((st) => (/m7a_customer_page_v3\(/.test(st.text) ? 'page_v3' : /m7a_customer_get\(/.test(st.text) ? 'get'
    : /tmpos_customer_edit\.m7a_customer_profile\(/.test(st.text) ? 'profile' : /tmpos_customer_search\.m7a_customer_search\(/.test(st.text) ? 'search'
      : /tmpos_store_access\.m7b_store_directory\(/.test(st.text) ? 'stores' : /tmpos_invoice_discard\.m7b_invoice_draft_page_v2\(/.test(st.text) ? 'draft_page'
        : /tmpos_invoice_discard\.m7b_invoice_draft_get_v2\(/.test(st.text) ? 'draft_get'
          : /tmpos_invoice_issue\.m7b_issuing_settings_get\(/.test(st.text) ? 'settings' : /tmpos_invoice_issue\.m7b_invoice_issue_preview\(/.test(st.text) ? 'preview'
            : /tmpos_invoice_issue\.m7b_issued_invoice_page\(/.test(st.text) ? 'issued_page' : /tmpos_invoice_issue\.m7b_issued_invoice_get\(/.test(st.text) ? 'issued_get' : 'other'));
  assert.deepEqual(asked(), ['page_v3', 'get', 'profile', 'search', 'stores', 'draft_page', 'draft_get', 'settings', 'preview', 'issued_page', 'issued_get'],
    'the probe asks 020\'s routine, then 022\'s, then 024\'s (M7A-CUSTOMERS-P7), then 025\'s (M7A-CUSTOMERS-P8), then 027\'s, then the drafts\' two reads (M7B-INVOICES-P1; 033\'s open-only page_v2 and get_v2 since M7B-INVOICES-DISCARD-P1), then 034\'s four issuing reads (M7B-INVOICES-ISSUE-P1)');
  // M7B-INVOICES-ISSUE-P1: the issuing reads are asked last, and the issued get answering anything else is not ready.
  issuedGot = [{ ...issuedGetDenied[0], o_outcome: 'not_found' }];
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'the issued get answering anything else is not ready');
  assert.deepEqual(asked(), ['page_v3', 'get', 'profile', 'search', 'stores', 'draft_page', 'draft_get', 'settings', 'preview', 'issued_page', 'issued_get']);
  issuedGot = issuedGetDenied;
  // M7B-INVOICES-P1: the invoice drafts' two reads are asked last, only once the store directory's has refused.
  draftGot = [{ ...draftGetDenied[0], o_outcome: 'not_found' }];
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'the draft get answering anything else is not ready');
  assert.deepEqual(asked(), ['page_v3', 'get', 'profile', 'search', 'stores', 'draft_page', 'draft_get']);
  draftGot = draftGetDenied;
  draftPage = draftGetDenied;
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'nor the get\'s sixteen columns in place of the page\'s ten');
  assert.deepEqual(asked(), ['page_v3', 'get', 'profile', 'search', 'stores', 'draft_page'], 'short-circuit: the get is not asked once the page is not ready');
  draftPage = draftPageDenied;
  // M7B-INVOICES-P1: the store directory's routine is asked once the search's has refused.
  stored = [{ ...storesDenied[0], o_outcome: 'invalid' }];
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'the store routine answering anything else is not ready');
  assert.deepEqual(asked(), ['page_v3', 'get', 'profile', 'search', 'stores'], 'short-circuit: the draft reads are not asked once the store routine is not ready');
  stored = denied;
  assert.equal(await ttx.readsProbe(signal), false, 'nor the customer reads\' four columns in place of the store routine\'s five');
  stored = storesDenied;
  got = [{ o_outcome: 'not_found', o_tenant_id: null, o_customer_id: null, o_name: null }];
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'the detail routine answering anything else is not ready');
  assert.deepEqual(asked(), ['page_v3', 'get'], 'short-circuit: the profile routine is not asked once the detail is not ready');
  got = denied;
  profiled = [{ ...profileDenied[0], o_outcome: 'not_found' }];
  assert.equal(await ttx.readsProbe(signal), false, 'the profile routine answering anything else is not ready');
  profiled = denied;
  assert.equal(await ttx.readsProbe(signal), false, 'nor the detail\'s four columns in place of the profile\'s seven');
  profiled = profileDenied;
  // M7A-CUSTOMERS-P8: the search routine is asked last, only once the profile's has refused.
  searched = [{ ...denied[0], o_outcome: 'invalid' }];
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'the search routine answering anything else is not ready');
  assert.deepEqual(asked(), ['page_v3', 'get', 'profile', 'search'], 'short-circuit: the store routine is not asked once the search is not ready');
  searched = profileDenied;
  assert.equal(await ttx.readsProbe(signal), false, 'nor the profile\'s eight columns in place of the search\'s four');
  searched = denied;
  profiled = denied;
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'a profile not ready (control)');
  assert.deepEqual(asked(), ['page_v3', 'get', 'profile'], 'short-circuit: the search routine is not asked once the profile is not ready');
  profiled = profileDenied;
  page = [{ o_outcome: 'customer', o_tenant_id: REVAL_TENANT, o_customer_id: REVAL_MEMBERSHIP, o_name: 'n' }];
  kernel.statements.length = 0;
  assert.equal(await ttx.readsProbe(signal), false, 'anything else is not ready');
  assert.ok(!kernel.statements.some((st) => /m7a_customer_get\(/.test(st.text)), 'short-circuit: the detail routine is not asked once the directory is not ready');
  assert.equal(await ttx.mintProbe(signal), true, 'the mint\'s refusal of all-null arguments');
  minted = [{ outcome: 'refused' }];
  assert.equal(await ttx.mintProbe(signal), false, 'anything else is not ready');
  const mints = kernel.statements.filter((st) => /tmpos_mint\.m7a_session_create\(/.test(st.text));
  assert.equal(mints.length, 2);
  assert.ok(mints.every((st) => st.values.length === 0), 'the mint probe binds nothing');
  await ttx.close();
});

test('M7TK-06 a fault after the kernel exists ends it once and is rethrown; only a write slot builds the store, its two ports and nothing else', async () => {
  const kernel = recordingKernel();
  const boom = new Error('synthetic read port fault');
  const inventory = { ...TENANT_INVENTORY, ports: (): never => { throw boom; } };
  assert.throws(() => composeReadTransactions(inventory, TENANT_CONFIGURED, () => kernel.client), (err: unknown) => err === boom);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kernel.ended(), 1, 'the kernel is ended: the caller holds nothing to close yet');
  // A route factory that throws only once served (over the real ports) ends it too.
  const served = recordingKernel();
  const throwing = { ...TENANT_INVENTORY, reads: [(ports: unknown) => (ports === TENANT_INVENTORY.inert ? tenantRouteDeclarations()[0] : (() => { throw boom; })())] };
  assert.throws(() => composeReadTransactions(throwing, TENANT_CONFIGURED, () => served.client), (err: unknown) => err === boom);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(served.ended(), 1);
  // The declared table is validated before any client exists: a duplicate refuses with nothing to close.
  const duplicate = { ...TENANT_INVENTORY, reads: [createCustomerDirectoryRoute, createCustomerDirectoryRoute] };
  assert.throws(() => composeReadTransactions(duplicate, TENANT_CONFIGURED, () => assert.fail('no client may be built')),
    (err: unknown) => err instanceof EnforcementSetupError && err.code === 'route_duplicate');
  const ttx = composeTenantTransactions(TENANT_CONFIGURED, () => recordingKernel().client) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(ttx).sort(),
    ['close', 'idempotency', 'issuerKey', 'mintProbe', 'preflight', 'rateLimiter', 'readsProbe', 'roleLevels', 'routes', 'sessionStore', 'tenantAdmission',
      'tenantReads', 'transactions'], 'the write slot\'s idempotency and command ports and the role-levels read — no delivery port, platform admission or store');
  assert.deepEqual(Object.keys(ttx.idempotency as object).sort(), ['keySecret', 'store']);
  assert.deepEqual(Object.keys(ttx.transactions as object), ['port']);
  // Without a write slot the composition is read-only, exactly as before.
  const { writes: _writes, ...readOnly } = TENANT_INVENTORY;
  assert.deepEqual(Object.keys(composeReadTransactions(readOnly, TENANT_CONFIGURED, () => recordingKernel().client)).sort(),
    ['close', 'issuerKey', 'mintProbe', 'preflight', 'rateLimiter', 'readsProbe', 'roleLevels', 'routes', 'sessionStore', 'tenantAdmission', 'tenantReads']);
  // A write route with no mutator of its kind, or one that is no idempotent command, refuses before any client exists.
  const slot = TENANT_INVENTORY.writes;
  assert.ok(slot !== undefined);
  for (const [label, writes] of [
    ['no mutator', { ...slot, mutators: [] }],
    ['a mutator of another mode', { ...slot, mutators: [{ ...slot.mutators[0], mode: 'update' }] }],
    ['a mutator of another aggregate type', { ...slot, mutators: [{ ...slot.mutators[0], aggregateType: 'tenant' }] }],
    ['two mutators of the kind', { ...slot, mutators: [...slot.mutators, ...slot.mutators] }],
    ['a read in the write slot', { ...slot, routes: [...slot.routes, { ...tenantRouteDeclarations()[0], path: '/api/v1/unit' }] }],
    // M7B-INVOICES-ISSUE-P1: the sealed issuing pair opted into by the contract alone, or by the mutator alone.
    ['the issue mutator without the issuing opt-in', { ...slot, mutators: slot.mutators.map((m) => (m.kind === 'store.invoice.issue'
      ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'issuingRefusals')) : m)) }],
    ['the discard mutator with the issuing opt-in', { ...slot, mutators: slot.mutators.map((m) => (m.kind === 'store.invoice_draft.discard'
      ? { ...m, issuingRefusals: true } : m)) }],
  ] as const) {
    try {
      composeReadTransactions({ ...TENANT_INVENTORY, writes } as never, TENANT_CONFIGURED, () => assert.fail('no client may be built'));
      assert.fail(`${label}: composition must refuse`);
    } catch (err) {
      assert.ok(err instanceof TransactionCompositionError, `${label}: ${String(err)}`);
      assert.deepEqual(err.blockers, ['command_mutator_unavailable'], label);
    }
  }
  // M7B-INVOICES-P1 (design R4): a command route's requirement scope, its contract's DECLARED context scope and its mutator's
  // are ONE scope of {tenant, store} — none defaulted: a missing declaration (an untyped caller) is a mismatch.
  const draftRoute = slot.routes.find((r) => r.path === '/api/v1/stores/{storeId}/invoice-drafts');
  const draftMutator = slot.mutators.find((m) => m.kind === 'store.invoice_draft.create');
  assert.ok(draftRoute !== undefined && 'command' in draftRoute && draftMutator !== undefined);
  assert.deepEqual([draftRoute.policy.access === 'session' ? draftRoute.policy.authorization?.scope : null, draftRoute.command.contract.contextScope,
    draftMutator.contextScope], ['store', 'store', 'store'], 'the composed draft save: store, store, store');
  const { contextScope: _scope, ...undeclared } = draftMutator;
  const customerRoute = slot.routes.find((r) => 'command' in r && r.command.contract.kind === 'tenant.customer.create');
  const customerMutator = slot.mutators.find((m) => m.kind === 'tenant.customer.create');
  assert.ok(customerRoute !== undefined && 'command' in customerRoute && customerRoute.policy.access === 'session' && customerMutator !== undefined);
  assert.deepEqual([customerRoute.policy.authorization?.scope, customerRoute.command.contract.contextScope, customerMutator.contextScope],
    ['tenant', 'tenant', 'tenant'], 'the composed customer create: tenant, tenant, tenant — declared, not defaulted');
  const { contextScope: _contractScope, ...undeclaredContract } = customerRoute.command.contract;
  const { contextScope: _customerScope, ...undeclaredCustomer } = customerMutator;
  const withCustomer = (route: unknown) => ({ ...slot, routes: slot.routes.map((r) => (r === customerRoute ? route : r)) });
  for (const [label, writes] of [
    ['a store command over a mutator declaring no scope', { ...slot, mutators: slot.mutators.map((m) => (m === draftMutator ? undeclared : m)) }],
    ['a tenant command over a mutator declaring no scope', { ...slot, mutators: slot.mutators.map((m) => (m === customerMutator ? undeclaredCustomer : m)) }],
    ['a tenant command whose contract declares no scope', withCustomer({ ...customerRoute, command: { ...customerRoute.command, contract: undeclaredContract } })],
    ['route, contract and mutator agreeing on platform, which the tenant root does not admit', {
      ...withCustomer({ ...customerRoute, policy: { ...customerRoute.policy, authorization: { ...customerRoute.policy.authorization, scope: 'platform' } },
        command: { ...customerRoute.command, contract: { ...customerRoute.command.contract, contextScope: 'platform' } } }),
      mutators: slot.mutators.map((m) => (m === customerMutator ? { ...m, contextScope: 'platform' } : m)) }],
    ['a store command over a mutator declaring tenant', { ...slot, mutators: slot.mutators.map((m) => (m === draftMutator ? { ...m, contextScope: 'tenant' } : m)) }],
    ['a tenant command over a mutator declaring store', { ...slot, mutators: slot.mutators.map((m) => (m.kind === 'tenant.customer.create' ? { ...m, contextScope: 'store' } : m)) }],
    ['a store contract on a tenant route', { ...slot, routes: slot.routes.map((r) => (r === draftRoute
      ? { ...draftRoute, command: { ...draftRoute.command, contract: { ...draftRoute.command.contract, contextScope: 'tenant' } } } : r)) }],
  ] as const) {
    try {
      composeReadTransactions({ ...TENANT_INVENTORY, writes } as never, TENANT_CONFIGURED, () => assert.fail('no client may be built'));
      assert.fail(`${label}: composition must refuse`);
    } catch (err) {
      assert.ok(err instanceof TransactionCompositionError, `${label}: ${String(err)}`);
      assert.deepEqual(err.blockers, ['command_scope_mismatch'], label);
    }
  }
});

test('M7TK-07 the administrative root still composes no issuer key: its store refuses a tenant record before any statement', async () => {
  const fake = fakeDriver();
  const boundary = composeProductionTransactions({ ...CONFIGURED, TENANT_SESSION_ISSUER_KEY: TENANT_CONFIGURED.TENANT_SESSION_ISSUER_KEY },
    () => createSupervisedPgClient(fake.driver, '', { max: 2 }));
  assert.ok(boundary !== null);
  const now = Date.now();
  await assert.rejects(Promise.resolve(boundary!.sessionStore.create('k'.repeat(43), {
    audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-tenant', principalKey: 'p'.repeat(43), securityVersion: tenantWitness,
    authenticatedAt: null, createdAt: now, lastSeenAt: now, validatedAt: now,
  }, new AbortController().signal)), /session store unavailable: issuer_key_missing/);
  assert.equal(fake.texts.length, 0, 'nothing sent');
  await boundary!.close();
});

test('M7TK-08 the composed tenant store commits the customer create in the ADR-34 order — fence, session peek, 016 hold, session held, v2 re-read, the role\'s levels, 023 (020 inside it) on the session key alone, the tenant audit record, the completion — and a session ended before its hold commits nothing', async () => {
  // M7A-CUSTOMERS-P3: the tenant root's write slot as composed, over a kernel answering by statement text.
  const tenantSession = { ...sessionRow(tenantWitness), audience: 'tenant', authProviderUid: 'uid-tenant' };
  let gets = 0;
  let endedAfterPeek = false;
  const kernel = recordingKernel((text) => {
    if (text.includes('m6_command_fence')) return [{ held: true }];
    if (text.includes('m5_session_get')) return endedAfterPeek && gets++ > 0 ? [] : [tenantSession];
    if (text.includes('m5_hold_tenant_standing')) return [{ outcome: 'held' }];
    if (text.includes('m5_session_touch')) return [{ outcome: 'updated' }];
    if (text.includes('m5_admit_tenant_session_v2')) return [tenantAdmissionRow()];
    if (text.includes('m7a_role_levels')) return [{ levels: {} }];
    // M7A-CUSTOMERS-P6: the runtime's one create path is migration 023's, which calls 020's create inside the database.
    if (text.includes('m7a_contact_create')) return [{ o_tenant_id: REVAL_TENANT, o_actor_id: REVAL_ACTOR, o_membership_id: REVAL_MEMBERSHIP }];
    if (/insert into public\.audit_event/.test(text)) return Object.assign([], { count: 1, command: 'INSERT' });
    if (text.includes('m6_idempotency_complete')) return [{ outcome: 'completed' }];
    throw new Error(`a statement the tenant command never sends: ${text.slice(0, 80)}`);
  });
  const ttx = composeTenantTransactions(TENANT_CONFIGURED, () => kernel.client);
  assert.ok(ttx.transactions !== undefined);
  const events = defineOutboxEvents([]);
  const contract = defineCommands([CUSTOMER_CREATE_CONTRACT], events).contract(CUSTOMER_CREATE_CONTRACT.kind);
  assert.ok(contract !== undefined);
  const keyring = createIdempotencyKeyring(Buffer.from(IDEMPOTENCY_KEY, 'base64url'));
  const context = Object.freeze({
    actor: REVAL_ACTOR, securityVersion: 'sv-1', scope: 'tenant' as const, tenant: REVAL_TENANT, store: null, membershipId: REVAL_MEMBERSHIP,
    roleId: 'store_owner', limitation: 'none' as const,
  });
  const prepared = (body: Record<string, unknown> = { name: 'Ada' }) => {
    const id = randomUUID();
    const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-tenant' }), {
      method: 'POST', path: '/api/v1/customers', audience: 'tenant', tenant: REVAL_TENANT, store: null, actor: REVAL_ACTOR, body: Buffer.from(JSON.stringify(body)),
    });
    const command = prepareCommand(contract, events, planCustomerCreate({ audience: 'tenant', body, newAggregateId: id }) as never, {
      scope: operation.scope, lease: randomBytes(32).toString('base64url'), newAggregateId: id,
      authorization: Object.freeze({ scope: 'tenant', permission: 'create_customers' }), context, authNotAfter: null, sessionKey: REVAL_SESSION_KEY,
      seal: (envelope) => keyring.seal(envelope, operation),
    });
    assert.ok(command !== null);
    return { id, command: command.command };
  };
  const step = (text: string): string => (text.includes('m6_command_fence') ? 'fence' : text.includes('m5_session_get') ? 'session get'
    : text.includes('m5_hold_tenant_standing') ? '016 hold' : text.includes('m5_session_touch') ? 'touch' : text.includes('m5_admit_tenant_session_v2') ? '016 v2'
      : text.includes('m7a_role_levels') ? 'levels' : text.includes('m7a_contact_create') ? '023' : text.includes('audit_event') ? 'audit'
        : text.includes('m6_idempotency_complete') ? 'completion' : 'other');
  const { id, command } = prepared();
  assert.deepEqual(await ttx.transactions.port.commit(command, new AbortController().signal), { outcome: 'committed' });
  assert.deepEqual(kernel.statements.map((st) => step(st.text)),
    ['fence', 'session get', '016 hold', 'session get', 'touch', '016 v2', 'levels', '023', 'audit', 'completion'],
    'the standing held before the session row, both before the role\'s current levels are read, all before the write');
  assert.deepEqual(kernel.statements.find((st) => step(st.text) === 'levels')?.values, [REVAL_TENANT, 'store_owner'], 'the confirmed grant\'s tenant and role');
  const create = kernel.statements.find((st) => step(st.text) === '023');
  assert.deepEqual(create?.values, [REVAL_SESSION_KEY, id, 'Ada', null, null], 'the presenting session\'s key as the only authority input; no contact is NULL');
  const audit = kernel.statements.find((st) => step(st.text) === 'audit');
  assert.deepEqual([audit?.values[4], audit?.values[7], audit?.values[8], audit?.values[9]], [REVAL_ACTOR, 'tenant', REVAL_TENANT, null],
    'audited at tenant scope: the context\'s actor and tenant, no store');
  assert.ok(!JSON.stringify(audit?.values).includes('Ada'), 'the customer\'s name is not in the audit record');
  // M7A-CUSTOMERS-P6: contacts reach 023's routine as bound values, and never the audit record.
  kernel.statements.length = 0;
  const withContacts = prepared({ name: 'Ada', phone: '+1 555 0100', email: 'ada@example.test' });
  assert.deepEqual(await ttx.transactions.port.commit(withContacts.command, new AbortController().signal), { outcome: 'committed' });
  assert.deepEqual(kernel.statements.find((st) => step(st.text) === '023')?.values, [REVAL_SESSION_KEY, withContacts.id, 'Ada', '+1 555 0100', 'ada@example.test']);
  // DA-182: the record's ids (its event id among them) are random UUIDs that may spell "555", so the contact scan reads every
  // bound value but a canonical UUID — a value that holds a whole UUID and nothing else cannot carry a phone or an email.
  const auditValues = kernel.statements.find((st) => step(st.text) === 'audit')?.values ?? [];
  const contactAudit = JSON.stringify(auditValues.filter((v) => !(typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v))));
  assert.ok(auditValues.length > 0 && !contactAudit.includes('555') && !contactAudit.includes('example.test'), 'no contact in the audit record');
  // A logout that committed between the peek and the hold: the held read finds nothing, and nothing is written.
  kernel.statements.length = 0;
  endedAfterPeek = true;
  assert.deepEqual(await ttx.transactions.port.commit(prepared().command, new AbortController().signal), { outcome: 'unavailable' });
  assert.deepEqual(kernel.statements.map((st) => step(st.text)), ['fence', 'session get', '016 hold', 'session get']);
  await ttx.close();
});

// --- M7A-CUSTOMERS-P3-R1: the role's current definition and the owner's role-level edit, through the composed tenant store ---

/** Migration 016's answer and the t2 witness for the actor holding `roleId` on the one tenant grant, recomputed independently. */
const tenantStanding = (roleId: string) => ({
  row: { ...tenantAdmissionRow(), memberships: [{ ...tenantAdmissionRow().memberships[0], roleId }] },
  witness: `t2:${createHash('sha256').update(['t2', REVAL_ACTOR, 'active', 'none', 'sv-1', '0', '1', '1',
    REVAL_MEMBERSHIP, 'tenant', REVAL_TENANT, '', roleId, 'active', '', '1', ''].join('\n')).digest('base64url')}`,
});

/** The composed tenant store over a kernel answering by statement text, the standing `roleId`'s, the stored levels and the clock as given. */
function tenantCommandKernel(roleId: string, over: { levels?: unknown; fresh?: boolean | readonly boolean[]; setOutcome?: string } = {}) {
  const standing = tenantStanding(roleId);
  // `fresh` as a list answers the database clock's successive judgements in order (the last one repeats).
  let clocks = 0;
  const freshNow = (): boolean => (Array.isArray(over.fresh) ? over.fresh[Math.min(clocks++, over.fresh.length - 1)] : (over.fresh as boolean | undefined) ?? true);
  const tenantSession = { ...sessionRow(standing.witness), audience: 'tenant', authProviderUid: 'uid-tenant' };
  const kernel = recordingKernel((text) => {
    if (text.includes('m6_command_fence')) return [{ held: true }];
    if (text.includes('m5_session_get')) return [tenantSession];
    if (text.includes('m5_hold_tenant_standing')) return [{ outcome: 'held' }];
    if (text.includes('m5_session_touch')) return [{ outcome: 'updated' }];
    if (text.includes('m5_admit_tenant_session_v2')) return [standing.row];
    if (text.includes('clock_timestamp')) return [{ fresh: freshNow() }];
    if (text.includes('m7a_role_levels')) return [{ levels: over.levels ?? {} }];
    if (text.includes('m7a_role_level_set_v2')) {
      if (over.setOutcome !== undefined) return [{ o_outcome: over.setOutcome, o_tenant_id: null, o_actor_id: null, o_membership_id: null, o_level: null, o_version: null }];
      return [{ o_outcome: 'applied', o_tenant_id: REVAL_TENANT, o_actor_id: REVAL_ACTOR, o_membership_id: REVAL_MEMBERSHIP, o_level: 'view', o_version: '3' }];
    }
    if (text.includes('m7a_contact_create')) return [{ o_tenant_id: REVAL_TENANT, o_actor_id: REVAL_ACTOR, o_membership_id: REVAL_MEMBERSHIP }];
    // M7A-CUSTOMERS-P7: the edit's one call into migration 024 answers as the routine does, at expected version 4.
    if (text.includes('m7a_customer_update')) {
      return [{ o_outcome: 'applied', o_tenant_id: REVAL_TENANT, o_actor_id: REVAL_ACTOR, o_membership_id: REVAL_MEMBERSHIP, o_version: '5' }];
    }
    if (/insert into public\.audit_event/.test(text)) return Object.assign([], { count: 1, command: 'INSERT' });
    if (text.includes('m6_idempotency_complete')) return [{ outcome: 'completed' }];
    throw new Error(`a statement the tenant command never sends: ${text.slice(0, 80)}`);
  });
  const ttx = composeTenantTransactions(TENANT_CONFIGURED, () => kernel.client);
  const step = (text: string): string => (text.includes('m6_command_fence') ? 'fence' : text.includes('m5_session_get') ? 'session get'
    : text.includes('m5_hold_tenant_standing') ? '016 hold' : text.includes('m5_session_touch') ? 'touch' : text.includes('m5_admit_tenant_session_v2') ? '016 v2'
      : text.includes('clock_timestamp') ? 'clock' : text.includes('m7a_role_levels') ? 'levels' : text.includes('m7a_role_level_set') ? '020 set'
        : text.includes('m7a_contact_create') ? '023 create' : text.includes('m7a_customer_update') ? '024 update'
          : text.includes('audit_event') ? 'audit' : text.includes('m6_idempotency_complete') ? 'completion' : 'other');
  const context = Object.freeze({
    actor: REVAL_ACTOR, securityVersion: 'sv-1', scope: 'tenant' as const, tenant: REVAL_TENANT, store: null, membershipId: REVAL_MEMBERSHIP,
    roleId, limitation: 'none' as const,
  });
  return { kernel, ttx, step, context };
}

/** A command prepared exactly as the runtime prepares it, for `contract` over `body`, under `context`. */
function preparedTenantCommand(contract: typeof CUSTOMER_CREATE_CONTRACT, plan: typeof planCustomerCreate, body: unknown, method: 'POST' | 'PUT', path: string,
  permission: string, context: Record<string, unknown>, authNotAfter: number | null) {
  const events = defineOutboxEvents([]);
  const registered = defineCommands([contract], events).contract(contract.kind);
  assert.ok(registered !== undefined);
  const keyring = createIdempotencyKeyring(Buffer.from(IDEMPOTENCY_KEY, 'base64url'));
  const id = randomUUID();
  const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-tenant' }), {
    method, path, audience: 'tenant', tenant: REVAL_TENANT, store: null, actor: REVAL_ACTOR, body: Buffer.from(JSON.stringify(body)),
  });
  const command = prepareCommand(registered, events, plan({ audience: 'tenant', body, newAggregateId: id }) as never, {
    scope: operation.scope, lease: randomBytes(32).toString('base64url'), newAggregateId: id,
    authorization: Object.freeze({ scope: 'tenant', permission }), context: context as never, authNotAfter, sessionKey: REVAL_SESSION_KEY,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(command !== null);
  return command.command;
}

const EDIT_BODY = Object.freeze({
  roleId: 'sales_staff', domain: 'customers', level: 'view', reason: 'Sales staff no longer onboard customers.', expectedTenant: REVAL_TENANT, expectedVersion: 2,
});

test('M7TK-09 the composed tenant store commits the owner\'s role-level edit — the standing held, the deadline judged on the database clock, the owner re-decided, 020 on the session key alone — and a stale deadline commits nothing', async () => {
  const { kernel, ttx, step, context } = tenantCommandKernel('store_owner');
  assert.ok(ttx.transactions !== undefined);
  const edit = (authNotAfter: number | null) => preparedTenantCommand(ROLE_LEVEL_UPDATE_CONTRACT, planRoleLevelUpdate, EDIT_BODY, 'PUT', '/api/v1/roles/levels',
    'edit_role_levels', context, authNotAfter);
  const deadline = Date.now() + 60_000;
  assert.deepEqual(await ttx.transactions.port.commit(edit(deadline), new AbortController().signal), { outcome: 'committed' });
  assert.deepEqual(kernel.statements.map((st) => step(st.text)),
    ['fence', 'session get', '016 hold', 'session get', 'touch', '016 v2', 'clock', 'levels', '020 set', 'clock', 'audit', 'completion'],
    'exactly one statement between 020\'s set and the audit record: the deadline judged again on the database clock');
  assert.deepEqual(kernel.statements.filter((st) => step(st.text) === 'clock').map((st) => st.values), [[String(deadline)], [String(deadline)]],
    'the same deadline, judged by the database before and after 020\'s lock wait');
  assert.deepEqual(kernel.statements.find((st) => step(st.text) === '020 set')?.values, [REVAL_SESSION_KEY, 'sales_staff', 'customers', 'view', REVAL_TENANT, '2'],
    'the presenting session\'s key as the only authority input, then the edit and its two preconditions (M7A-CUSTOMERS-P4: 021\'s set)');
  assert.match(kernel.statements.find((st) => step(st.text) === '020 set')?.text ?? '', /tmpos_role_edit\.m7a_role_level_set_v2\(/);
  const audit = kernel.statements.find((st) => step(st.text) === 'audit');
  assert.ok(JSON.stringify(audit?.values).includes('role_sales_staff_customers_to_view'), 'the audited reason code');
  // Past its deadline on the database's clock: nothing after the clock, nothing written.
  kernel.statements.length = 0;
  const stale = tenantCommandKernel('store_owner', { fresh: false });
  assert.deepEqual(await stale.ttx.transactions!.port.commit(edit(deadline), new AbortController().signal), { outcome: 'unavailable' });
  assert.deepEqual(stale.kernel.statements.map((st) => stale.step(st.text)), ['fence', 'session get', '016 hold', 'session get', 'touch', '016 v2', 'clock']);
  // Fresh at the revalidator, stale once 020 answered (it went stale during the role row's lock wait): nothing after the
  // second clock — no audit record, no completion.
  const lapsed = tenantCommandKernel('store_owner', { fresh: [true, false] });
  assert.deepEqual(await lapsed.ttx.transactions!.port.commit(edit(deadline), new AbortController().signal), { outcome: 'unavailable' });
  assert.deepEqual(lapsed.kernel.statements.map((st) => lapsed.step(st.text)),
    ['fence', 'session get', '016 hold', 'session get', 'touch', '016 v2', 'clock', 'levels', '020 set', 'clock']);
  await lapsed.ttx.close();
  // M7A-CUSTOMERS-P4: a precondition 021 found no longer holding — another tenant, or another version — is its own answer,
  // decided under the whole revalidation, with nothing after it: no clock, no audit record, no completion.
  for (const setOutcome of ['tenant_mismatch', 'version_conflict']) {
    const failed = tenantCommandKernel('store_owner', { setOutcome });
    assert.deepEqual(await failed.ttx.transactions!.port.commit(edit(deadline), new AbortController().signal), { outcome: 'precondition_failed' }, setOutcome);
    assert.deepEqual(failed.kernel.statements.map((st) => failed.step(st.text)),
      ['fence', 'session get', '016 hold', 'session get', 'touch', '016 v2', 'clock', 'levels', '020 set'], setOutcome);
    await failed.ttx.close();
  }
  // No deadline at all: refused before anything but the fence.
  assert.deepEqual(await stale.ttx.transactions!.port.commit(edit(null), new AbortController().signal), { outcome: 'unavailable' });
  await ttx.close();
  await stale.ttx.close();
});

test('M7TK-10 a role the owner narrowed below Create is refused on the committing transaction before 020\'s create is called, an already-issued session included', async () => {
  const narrowed = tenantCommandKernel('sales_staff', { levels: { customers: 'view' } });
  const create = preparedTenantCommand(CUSTOMER_CREATE_CONTRACT, planCustomerCreate, { name: 'Ada' }, 'POST', '/api/v1/customers', 'create_customers',
    narrowed.context, null);
  assert.deepEqual(await narrowed.ttx.transactions!.port.commit(create, new AbortController().signal), { outcome: 'unavailable' });
  assert.deepEqual(narrowed.kernel.statements.map((st) => narrowed.step(st.text)), ['fence', 'session get', '016 hold', 'session get', 'touch', '016 v2', 'levels'],
    'decided on the stored level: no create, no audit record, no completion');
  // The same sales_staff at its default creates (control).
  const ok = tenantCommandKernel('sales_staff');
  assert.deepEqual(await ok.ttx.transactions!.port.commit(preparedTenantCommand(CUSTOMER_CREATE_CONTRACT, planCustomerCreate, { name: 'Ada' }, 'POST',
    '/api/v1/customers', 'create_customers', ok.context, null), new AbortController().signal), { outcome: 'committed' });
  await narrowed.ttx.close();
  await ok.ttx.close();
});

test('M7TK-11 (M7A-CUSTOMERS-P7) the composed tenant store commits a customer edit — the standing held, the role re-decided at Edit on its stored level, 024 on the session key and the trusted tenant — and a role narrowed below Edit commits nothing', async () => {
  const target = randomUUID();
  const editCommand = (context: Record<string, unknown>) => {
    const events = defineOutboxEvents([]);
    const keyring = createIdempotencyKeyring(Buffer.from(IDEMPOTENCY_KEY, 'base64url'));
    const body = { expectedVersion: 4, name: 'Ada Lovelace', email: null };
    const operation = keyring.operationOf(randomUUID(), Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-tenant' }), {
      method: 'PATCH', path: '/api/v1/customers/{id}', audience: 'tenant', tenant: REVAL_TENANT, store: null, actor: REVAL_ACTOR,
      body: Buffer.from(JSON.stringify(body)), target,
    });
    const command = prepareCommand(CUSTOMER_UPDATE_CONTRACT, events, planCustomerUpdate({ audience: 'tenant', body, newAggregateId: randomUUID(), targetId: target }) as never, {
      scope: operation.scope, lease: randomBytes(32).toString('base64url'), newAggregateId: randomUUID(),
      authorization: Object.freeze({ scope: 'tenant', permission: 'edit_customers' }), context: context as never, authNotAfter: null, sessionKey: REVAL_SESSION_KEY,
      seal: (envelope) => keyring.seal(envelope, operation),
    });
    assert.ok(command !== null);
    return command.command;
  };
  const { kernel, ttx, step, context } = tenantCommandKernel('manager');
  assert.deepEqual(await ttx.transactions!.port.commit(editCommand(context), new AbortController().signal), { outcome: 'committed' });
  assert.deepEqual(kernel.statements.map((st) => step(st.text)),
    ['fence', 'session get', '016 hold', 'session get', 'touch', '016 v2', 'levels', '024 update', 'audit', 'completion']);
  assert.deepEqual(kernel.statements.find((st) => step(st.text) === '024 update')?.values,
    [REVAL_SESSION_KEY, target, REVAL_TENANT, '4', 'Ada Lovelace', false, null, true, null],
    'the key, the path\'s target, the trusted tenant as the expected one, the version as text, the name, the phone unwritten, the email cleared');
  const audit = kernel.statements.find((st) => step(st.text) === 'audit');
  assert.ok(audit !== undefined && audit.text.includes('subject_customer_id') && audit.values.at(-1) === target, 'the audit record names the customer');
  assert.ok(!JSON.stringify(audit.values).includes('Ada Lovelace'), 'and no name');
  // The sales staff default (Create) and a manager the owner narrowed to Create: refused before 024 is called.
  for (const [label, narrowed] of [
    ['sales_staff at its default', tenantCommandKernel('sales_staff')],
    ['a manager narrowed to Create', tenantCommandKernel('manager', { levels: { customers: 'create' } })],
  ] as const) {
    assert.deepEqual(await narrowed.ttx.transactions!.port.commit(editCommand(narrowed.context), new AbortController().signal), { outcome: 'unavailable' }, label);
    assert.ok(!narrowed.kernel.statements.some((st) => ['024 update', 'audit', 'completion'].includes(narrowed.step(st.text))), `${label}: nothing written`);
    await narrowed.ttx.close();
  }
  await ttx.close();
});
