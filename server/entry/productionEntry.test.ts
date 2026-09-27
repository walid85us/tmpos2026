// Phase 4.0 M6-ENTRY-P1 — productionEntry.ts: validateEntryConfig (pure), SHIPPING_ROUTES bound to what the runtime
// actually composes from the real production route declarations, and startProductionEntry — FAKE constructions
// only, no database, ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SHIPPING_ROUTES, servesExactlyShippingRoutes, startProductionEntry, validateEntryConfig } from './productionEntry.js';
import { PRODUCTION_CONSTRUCTION, STARTUP_STEP_DEADLINE_MS } from './entryStartup.js';
import type { EntryConstruction, EntryResult, ServedRoute } from './entryStartup.js';
import { createApp, createReadinessState } from '../runtime/app.js';
import { composeProductionSessions } from '../composition/productionSessions.js';
import { productionRouteDeclarations } from '../composition/productionTransactions.js';
import { APPROVED_ROLE_GRANTS, REQUIRED_MIGRATIONS, RUNTIME_PRIVILEGE_ROLES } from '../persistence/postgresStartupPreflight.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from '../persistence/supervisedPgClient.js';
import { createMemorySessionStore } from '../runtime/memorySessionStore.testkit.js';
import { createMemoryTransactionalState, testTransactions } from '../runtime/transactionalOutbox.testkit.js';
import { testIdempotency } from '../runtime/idempotencyStore.testkit.js';
import { TENANT_DISPLAY_NAME_EVENTS } from '../runtime/tenantDisplayName.js';
import { TENANT_STATUS_EVENTS } from '../runtime/tenantStatus.js';
import type { PlatformAdmissionPort, TenantAdmissionPort } from '../runtime/principals.js';
import type { DistributedRateLimiter } from '../runtime/rateLimit.js';
import type { FirebaseIdTokenVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import { DRIVER_TLS_ENV_VAR, createRuntimeStoreClient } from '../platform-identity/db.js';

// --- a synthetic, throwaway configuration: no secret, nothing dialled --------------------------------------------

const REF = 'abcdefghijklmnop';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account', project_id: 'm6ep-demo', client_email: 'svc@m6ep-demo.iam.gserviceaccount.com', private_key: privateKey,
});
const RATE_LIMIT_KEY = Buffer.alloc(32, 7).toString('base64url');
const IDEMPOTENCY_KEY = Buffer.alloc(32, 9).toString('base64url');
const CA_CERT = tls.rootCertificates[0];

/** A complete, valid synthetic configuration. Every test overrides one field at a time from this baseline. */
const VALID_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'production',
  PORT: '4443',
  APP_DATABASE_URL: `postgres://tmpos_runtime:synthetic-pw@db.${REF}.supabase.co:5432/postgres`,
  DATABASE_CA_CERT: CA_CERT,
  RATE_LIMIT_KEY,
  IDEMPOTENCY_KEY,
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: 'https://admin.m6ep.test',
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
});

const envWith = (over: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => ({ ...VALID_ENV, ...over });

// ===========================================================================================================
// A. validateEntryConfig — pure, no network, no listener, no client
// ===========================================================================================================

test('validateEntryConfig: a complete synthetic valid configuration clears every check', () => {
  assert.deepEqual(validateEntryConfig(VALID_ENV), []);
});

test('validateEntryConfig: every code, each in a targeted case', () => {
  // Every case is a SINGLE-fault mutation of VALID_ENV, so the exact error list is asserted (deepEqual to one
  // [{field,code}]), not merely that the code is present among others a different fault might also have added.
  // Verified by direct execution against every case below: none of these single mutations trips a second,
  // incidental check (no case here legitimately yields two errors).
  const cases: Array<[string, string, Record<string, string | undefined>]> = [
    ['NODE_ENV', 'env_missing', envWith({ NODE_ENV: undefined })],
    ['NODE_ENV', 'env_invalid', envWith({ NODE_ENV: 'staging2' })],
    ['NODE_ENV', 'env_not_production', envWith({ NODE_ENV: 'development' })],
    ['PORT', 'port_missing', envWith({ PORT: undefined })],
    ['PORT', 'port_invalid', envWith({ PORT: 'not-a-port' })],
    ['PORT', 'port_invalid', envWith({ PORT: '99999' })],
    ['ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW', 'production_dev_flag_conflict', envWith({ ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW: 'true' })],
    ['APP_DATABASE_URL', 'app_database_url_missing', envWith({ APP_DATABASE_URL: undefined })],
    ['APP_DATABASE_URL', 'app_database_url_invalid', envWith({ APP_DATABASE_URL: 'not a url' })],
    ['APP_DATABASE_URL', 'app_database_endpoint_unsupported', envWith({ APP_DATABASE_URL: `postgres://tmpos_runtime:synthetic-pw@db.${REF}.supabase.co:6543/postgres` })],
    ['DATABASE_CA_CERT', 'database_ca_missing', envWith({ DATABASE_CA_CERT: undefined })],
    ['DATABASE_CA_CERT', 'database_ca_missing', envWith({ DATABASE_CA_CERT: '   ' })],
    ['DATABASE_CA_CERT', 'database_ca_invalid', envWith({ DATABASE_CA_CERT: 'not a certificate' })],
    [DRIVER_TLS_ENV_VAR, 'driver_tls_override_forbidden', envWith({ [DRIVER_TLS_ENV_VAR]: 'disable' })],
    ['RATE_LIMIT_KEY', 'rate_limit_key_missing', envWith({ RATE_LIMIT_KEY: undefined })],
    ['RATE_LIMIT_KEY', 'rate_limit_key_invalid', envWith({ RATE_LIMIT_KEY: 'too-short' })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_missing', envWith({ IDEMPOTENCY_KEY: undefined })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_invalid', envWith({ IDEMPOTENCY_KEY: 'too-short' })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_shared', envWith({ IDEMPOTENCY_KEY: RATE_LIMIT_KEY })],
    ['TRUSTED_PROXY_CIDRS', 'trusted_proxies_missing', envWith({ TRUSTED_PROXY_CIDRS: undefined })],
    ['TRUSTED_PROXY_CIDRS', 'trusted_proxies_missing', envWith({ TRUSTED_PROXY_CIDRS: 'none' })],
    ['TRUSTED_PROXY_CIDRS', 'trusted_proxies_invalid', envWith({ TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })],
    ['SESSION_ADMIN_ORIGINS', 'session_admin_origin_missing', envWith({ SESSION_ADMIN_ORIGINS: undefined })],
    ['SESSION_ADMIN_ORIGINS', 'session_admin_origin_not_single', envWith({ SESSION_ADMIN_ORIGINS: 'https://admin.m6ep.test,https://other.m6ep.test' })],
    ['SESSION_ADMIN_ORIGINS', 'session_admin_origin_invalid', envWith({ SESSION_ADMIN_ORIGINS: 'http://admin.m6ep.test' })],
    ['SESSION_ADMIN_ORIGINS', 'session_admin_origin_invalid', envWith({ SESSION_ADMIN_ORIGINS: 'https://admin.m6ep.test/' })],
    ['FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON', 'identity_verifier_unconfigured', envWith({ FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: undefined })],
    ['FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON', 'identity_verifier_unconfigured', envWith({ FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: 'not json' })],
    ['FIREBASE_AUTH_EMULATOR_HOST', 'identity_emulator_forbidden', envWith({ FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' })],
    ['NODE_TLS_REJECT_UNAUTHORIZED', 'tls_verification_override_forbidden', envWith({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })],
    ['NODE_TLS_REJECT_UNAUTHORIZED', 'tls_verification_override_forbidden', envWith({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })],
    ['NODE_EXTRA_CA_CERTS', 'tls_trust_store_override_forbidden', envWith({ NODE_EXTRA_CA_CERTS: '/etc/ssl/extra-roots.pem' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--use-openssl-ca' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--max-old-space-size=512 --use-openssl-ca' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--use_openssl_ca' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '"--use-openssl-ca"' })],
    // Node also enables the flag given any value (even =false) and drops quotes and backslashes inside a token.
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--use-openssl-ca=1' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--use-openssl-ca=true' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--use-openssl-ca=false' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--use-"openssl"-ca' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '"--use-openssl\\-ca"' })],
    ['SUPABASE_DATABASE_URL', 'owner_credential_forbidden', envWith({ SUPABASE_DATABASE_URL: `postgres://postgres:synthetic-pw@db.${REF}.supabase.co:5432/postgres` })],
    ['SUPABASE_SERVICE_ROLE_KEY', 'owner_credential_forbidden', envWith({ SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role' })],
    // M7A-CUSTOMERS-P2: the tenant entry's minting key never sits in this process, whatever its value.
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_present', envWith({ TENANT_SESSION_ISSUER_KEY: randomBytes(32).toString('base64url') })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_present', envWith({ TENANT_SESSION_ISSUER_KEY: 'not-a-key' })],
  ];
  for (const [field, code, env] of cases) {
    assert.deepEqual(validateEntryConfig(env), [{ field, code }], `${field}:${code} over ${JSON.stringify(env[field])}`);
  }
});

test('validateEntryConfig: an empty-string FIREBASE_AUTH_EMULATOR_HOST or NODE_TLS_REJECT_UNAUTHORIZED adds nothing', () => {
  assert.deepEqual(validateEntryConfig(envWith({ FIREBASE_AUTH_EMULATOR_HOST: '' })), []);
  assert.deepEqual(validateEntryConfig(envWith({ NODE_TLS_REJECT_UNAUTHORIZED: '' })), []);
});

test('validateEntryConfig: NODE_OPTIONS without --use-openssl-ca, SSL_CERT_FILE / SSL_CERT_DIR, and empty owner or trust-store values add nothing', () => {
  // NODE_OPTIONS is refused only for selecting OpenSSL's store; other flags, the explicit bundled store and a mere substring pass.
  for (const options of [
    '', '--max-old-space-size=512', '--use-bundled-ca', '--enable-source-maps --use-openssl-ca-extra', '--use-openssl-ca-extra',
    '--no-use-openssl-ca', '--openssl-legacy-provider',
  ]) {
    assert.deepEqual(validateEntryConfig(envWith({ NODE_OPTIONS: options })), [], `NODE_OPTIONS ${JSON.stringify(options)}`);
  }
  // Hosting platforms set these by default; they matter only under --use-openssl-ca, which is refused.
  assert.deepEqual(validateEntryConfig(envWith({ SSL_CERT_FILE: '/etc/ssl/cert.pem', SSL_CERT_DIR: '/etc/ssl/certs' })), []);
  for (const field of ['NODE_EXTRA_CA_CERTS', 'SUPABASE_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TENANT_SESSION_ISSUER_KEY']) {
    assert.deepEqual(validateEntryConfig(envWith({ [field]: '' })), [], `empty ${field}`);
  }
});

// server/runtime/app.ts AUTHORITY_RE now requires the top-level label to carry a letter, so neither an IP-literal
// host (dotted quad) nor a bracketed IPv6 literal parses as a servable authority.
test('validateEntryConfig: an IP-literal admin origin (dotted-quad IPv4 or bracketed IPv6) is refused as session_admin_origin_invalid', () => {
  assert.deepEqual(validateEntryConfig(envWith({ SESSION_ADMIN_ORIGINS: 'https://127.0.0.1' })),
    [{ field: 'SESSION_ADMIN_ORIGINS', code: 'session_admin_origin_invalid' }]);
  assert.deepEqual(validateEntryConfig(envWith({ SESSION_ADMIN_ORIGINS: 'https://[::1]:8443' })),
    [{ field: 'SESSION_ADMIN_ORIGINS', code: 'session_admin_origin_invalid' }]);
});

test('validateEntryConfig: several faults at once are all collected', () => {
  const errors = validateEntryConfig(envWith({ NODE_ENV: undefined, PORT: undefined, APP_DATABASE_URL: undefined, RATE_LIMIT_KEY: undefined }));
  const pairs = errors.map((e) => `${e.field}:${e.code}`).sort();
  assert.deepEqual(pairs, ['APP_DATABASE_URL:app_database_url_missing', 'NODE_ENV:env_missing', 'PORT:port_missing', 'RATE_LIMIT_KEY:rate_limit_key_missing'].sort());
});

test('validateEntryConfig: no returned field or code carries any part of the submitted value', () => {
  const MARKER = 'M6EP-CONFIG-MARKER-9f1b2c3d';
  const env = envWith({
    NODE_ENV: MARKER,
    PORT: MARKER,
    APP_DATABASE_URL: `postgres://user:${MARKER}@db.${REF}.supabase.co:5432/postgres`,
    DATABASE_CA_CERT: MARKER,
    RATE_LIMIT_KEY: MARKER,
    IDEMPOTENCY_KEY: MARKER,
    TRUSTED_PROXY_CIDRS: MARKER,
    SESSION_ADMIN_ORIGINS: `https://${MARKER}.invalid`,
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: MARKER,
    FIREBASE_AUTH_EMULATOR_HOST: MARKER,
    NODE_TLS_REJECT_UNAUTHORIZED: MARKER,
    [DRIVER_TLS_ENV_VAR]: MARKER,
    NODE_EXTRA_CA_CERTS: MARKER,
    NODE_OPTIONS: `--use-openssl-ca ${MARKER}`,
    SUPABASE_DATABASE_URL: MARKER,
    SUPABASE_SERVICE_ROLE_KEY: MARKER,
    TENANT_SESSION_ISSUER_KEY: MARKER,
  });
  const errors = validateEntryConfig(env);
  assert.ok(errors.length > 0, 'the marker-laden configuration is refused');
  for (const { field, code } of errors) {
    assert.ok(!field.includes(MARKER), `field ${field} carries the submitted value`);
    assert.ok(!code.includes(MARKER), `code ${code} carries the submitted value`);
  }
});

// Every environment key validateEntryConfig — and the modules it calls (config.ts loadConfig; firebaseAdminAuthAdapter.ts
// createRuntimeIdentityVerifier, handed CONFIGURATION_ONLY so it verifies nothing) — is documented to read, confirmed by
// direct execution over both VALID_ENV and {}. A key read that is not on this list is a regression this test must catch.
const DOCUMENTED_ENV_KEYS: readonly string[] = [
  'NODE_ENV', 'PORT', 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW',
  'APP_DATABASE_URL', 'DATABASE_CA_CERT', DRIVER_TLS_ENV_VAR, 'RATE_LIMIT_KEY', 'IDEMPOTENCY_KEY',
  'TRUSTED_PROXY_CIDRS', 'SESSION_ADMIN_ORIGINS', 'FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON',
  'FIREBASE_AUTH_EMULATOR_HOST', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS',
  'SUPABASE_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TENANT_SESSION_ISSUER_KEY',
];

test('validateEntryConfig: opens no handle, reads only the named keys of the supplied env, and never process.env', () => {
  const before = process.getActiveResourcesInfo();
  const read = new Set<string>();
  // Both a value read (get) and a presence check (has / `in`) count as reading a key.
  const recording = (env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') read.add(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string') read.add(prop);
      return Reflect.has(target, prop);
    },
  }) as Record<string, string | undefined>;
  // The process environment is not the configuration: any touch of it during the call — a key, a presence check or an
  // enumeration — is recorded, and the original is restored whatever happens.
  const ambient: string[] = [];
  const originalEnv = process.env;
  process.env = new Proxy(originalEnv, {
    get(target, prop, receiver) { ambient.push(`get:${String(prop)}`); return Reflect.get(target, prop, receiver); },
    has(target, prop) { ambient.push(`has:${String(prop)}`); return Reflect.has(target, prop); },
    ownKeys(target) { ambient.push('ownKeys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) { ambient.push(`descriptor:${String(prop)}`); return Reflect.getOwnPropertyDescriptor(target, prop); },
  });
  try {
    validateEntryConfig(recording(VALID_ENV));
    validateEntryConfig(recording({}));
  } finally {
    process.env = originalEnv;
  }
  assert.deepEqual(ambient, [], `validateEntryConfig read process.env directly: ${JSON.stringify(ambient)}`);
  const undocumented = [...read].filter((key) => !DOCUMENTED_ENV_KEYS.includes(key));
  assert.deepEqual(undocumented, [], `validateEntryConfig read a key not on the documented allowlist: ${JSON.stringify(undocumented)}`);
  const after = process.getActiveResourcesInfo();
  assert.deepEqual(after, before, 'validateEntryConfig must open nothing: no timer, no socket, no handle');
});

// ===========================================================================================================
// B. SHIPPING_ROUTES — the exact frozen inventory, bound to what the runtime composes from the REAL production
//    route declarations (server/composition/productionTransactions.ts), composed here entirely over testkits:
//    no database, ever.
// ===========================================================================================================

test('SHIPPING_ROUTES is exactly the 8 frozen shipping routes', () => {
  // Pinned literally, every policy field of every route: a change to the shipping surface must change this line too, never
  // only a production-owned inventory that another production-owned inventory is then compared with.
  assert.deepEqual(SHIPPING_ROUTES, [
    { method: 'GET', path: '/health', access: 'public', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/readiness', access: 'public', body: 'none', idempotency: 'none' },
    { method: 'POST', path: '/admin/v1/session/login', access: 'login', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/admin/v1/session', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'POST', path: '/admin/v1/session/logout', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/admin/v1/tenants', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'PATCH', path: '/admin/v1/tenants/display-name', access: 'session', body: 'json', idempotency: 'required' },
    { method: 'PATCH', path: '/admin/v1/tenants/status', access: 'session', body: 'json', idempotency: 'required' },
  ]);
  assert.equal(SHIPPING_ROUTES.length, 8);
  assert.ok(Object.isFrozen(SHIPPING_ROUTES) && SHIPPING_ROUTES.every((r) => Object.isFrozen(r)));
  const paths = SHIPPING_ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual([...new Set(paths)], paths, 'no duplicate method+path');
});

const canonical = (routes: readonly ServedRoute[]): unknown =>
  routes.map((r) => [r.method, r.path, r.access, r.body, r.idempotency]).sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));

/**
 * A synthetic, THROWING verifier: configuration-shaped only, never able to verify anything. Every
 * composeProductionSessions call and fake EntryConstruction in this file passes it, so a composition regression can
 * never reach the real Firebase Admin SDK — it would throw here instead, loudly, rather than dial out.
 */
const SYNTHETIC_VERIFIER: FirebaseIdTokenVerifier = Object.freeze({
  verify: async () => { throw Object.assign(new Error('synthetic'), { code: 'auth/invalid-id-token' }); },
});

/** Trivial, never-invoked admission ports: only their shape matters for composing the route table. */
const trivialPlatformAdmission: PlatformAdmissionPort = Object.freeze({
  admit: async () => Object.freeze({ outcome: 'refused' }), probe: async () => true,
});
const trivialTenantAdmission: TenantAdmissionPort = Object.freeze({
  admit: async () => Object.freeze({ outcome: 'refused' }), probe: async () => true,
});
const PRODUCTION_EVENTS = Object.freeze([...TENANT_DISPLAY_NAME_EVENTS, ...TENANT_STATUS_EVENTS]);

test('SHIPPING_ROUTES equals the table the runtime builds from the real production route declarations', () => {
  // productionRouteDeclarations(): the exact commands and read routes today's production inventory serves
  // (server/composition/productionTransactions.ts), built over ports that answer nothing — never called here.
  const declared = productionRouteDeclarations();
  const readiness = createReadinessState();
  readiness.setReady();
  const durable = {
    store: createMemorySessionStore(),
    tenantAdmission: trivialTenantAdmission,
    platformAdmission: trivialPlatformAdmission,
    rateLimiter: (): DistributedRateLimiter => ({ consume: async () => ({ outcome: 'unavailable' }), probe: async () => true }),
  };
  const sessions = composeProductionSessions(VALID_ENV, durable, { audiences: ['admin'], tokenVerifier: SYNTHETIC_VERIFIER });
  const transactions = testTransactions(createMemoryTransactionalState());
  const app = createApp({
    readiness, routes: declared, limits: sessions.limits, idempotency: testIdempotency(), transactions,
    events: PRODUCTION_EVENTS, sessions: sessions.sessions, hsts: true, hosts: [new URL(VALID_ENV.SESSION_ADMIN_ORIGINS).host],
  });
  const actual = app.locals.routes as readonly ServedRoute[];
  assert.deepEqual(canonical(actual), canonical(SHIPPING_ROUTES));
});

test('servesExactlyShippingRoutes: true for SHIPPING_ROUTES and a reordered copy; false for one missing, one extra, or one attribute changed', () => {
  assert.equal(servesExactlyShippingRoutes(SHIPPING_ROUTES), true);
  assert.equal(servesExactlyShippingRoutes(Object.freeze([...SHIPPING_ROUTES].reverse())), true, 'order does not matter');

  assert.equal(servesExactlyShippingRoutes(SHIPPING_ROUTES.slice(1)), false, 'one route missing');

  const extraRoute: ServedRoute = Object.freeze({ method: 'GET', path: '/v1/extra', access: 'public', body: 'none', idempotency: 'none' });
  assert.equal(servesExactlyShippingRoutes(Object.freeze([...SHIPPING_ROUTES, extraRoute])), false, 'one extra route');

  for (const attribute of ['method', 'path', 'access', 'body', 'idempotency'] as const) {
    const changed = SHIPPING_ROUTES.map((r, i) => (i === 0 ? Object.freeze({ ...r, [attribute]: `${r[attribute]}-changed` }) : r));
    assert.equal(servesExactlyShippingRoutes(changed), false, `one route's ${attribute} changed`);
  }
});

// ===========================================================================================================
// C. startProductionEntry with FAKE constructions — no database, ever
// ===========================================================================================================

/** A fake SignalSource: captures every registered listener and lets the test fire one by name. */
function fakeProc(): { proc: { on(event: string, listener: (...args: unknown[]) => void): void }; emit: (event: string) => void } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    proc: {
      on(event, listener) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Counts real calls to net.Server.prototype.listen while active, still binding for real underneath (the golden
 * listening path needs a real bind). Always restore()d in a finally, so a spy never leaks across tests.
 */
function listenSpy(): { calls: () => number; restore: () => void } {
  const original = net.Server.prototype.listen;
  let count = 0;
  (net.Server.prototype as unknown as { listen: (...args: unknown[]) => net.Server }).listen = function patchedListen(
    this: net.Server, ...args: unknown[]
  ): net.Server {
    count += 1;
    return (original as (...a: unknown[]) => net.Server).apply(this, args);
  };
  return { calls: () => count, restore: () => { net.Server.prototype.listen = original; } };
}

test('an invalid construction refuses startup_failed and exits 1', async () => {
  const { proc } = fakeProc();
  const exits: number[] = [];
  const spy = listenSpy();
  try {
    const result = await startProductionEntry({
      env: VALID_ENV,
      construction: { listen: (port) => ({ port }), tokenVerifier: SYNTHETIC_VERIFIER } as unknown as EntryConstruction, // databaseClient missing
      proc, exit: (code) => exits.push(code),
    });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'startup_failed');
    assert.deepEqual(result.reasons, ['construction_invalid']);
    assert.deepEqual(exits, [1]);
    assert.equal(spy.calls(), 0, 'a refused startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('an invalid configuration refuses config_invalid, exits 1, and never builds a database client or a listener', async () => {
  const { proc } = fakeProc();
  const exits: number[] = [];
  let dbCalls = 0;
  let listenCalls = 0;
  const spy = listenSpy();
  try {
    const result = await startProductionEntry({
      env: {},
      construction: {
        databaseClient: () => { dbCalls++; throw new Error('must never be called'); },
        listen: () => { listenCalls++; throw new Error('must never be called'); },
        tokenVerifier: SYNTHETIC_VERIFIER,
      },
      proc, exit: (code) => exits.push(code),
    });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'config_invalid');
    assert.ok(result.reasons.length > 0);
    assert.equal(dbCalls, 0);
    assert.equal(listenCalls, 0);
    assert.deepEqual(exits, [1]);
    assert.equal(spy.calls(), 0, 'a refused startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('an env carrying FIREBASE_AUTH_EMULATOR_HOST refuses config_invalid naming it, and never builds a database client', async () => {
  const { proc } = fakeProc();
  const exits: number[] = [];
  let dbCalls = 0;
  const spy = listenSpy();
  try {
    const result = await startProductionEntry({
      env: envWith({ FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' }),
      construction: {
        databaseClient: () => { dbCalls++; throw new Error('must never be called'); }, listen: (port) => ({ port }),
        tokenVerifier: SYNTHETIC_VERIFIER,
      },
      proc, exit: (code) => exits.push(code),
    });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'config_invalid');
    assert.ok(result.reasons.includes('FIREBASE_AUTH_EMULATOR_HOST:identity_emulator_forbidden'), JSON.stringify(result.reasons));
    assert.equal(dbCalls, 0);
    assert.deepEqual(exits, [1]);
    assert.equal(spy.calls(), 0, 'a refused startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('M7A-CUSTOMERS-P2: an env carrying TENANT_SESSION_ISSUER_KEY refuses config_invalid naming it, and never builds a database client', async () => {
  // The administrative process never holds the tenant minting key: holding it would let this process mint tenant sessions.
  const { proc } = fakeProc();
  const exits: number[] = [];
  const logs: string[] = [];
  let dbCalls = 0;
  const key = randomBytes(32).toString('base64url');
  const spy = listenSpy();
  try {
    const result = await startProductionEntry({
      env: envWith({ TENANT_SESSION_ISSUER_KEY: key }),
      construction: {
        databaseClient: () => { dbCalls++; throw new Error('must never be called'); }, listen: (port) => ({ port }),
        tokenVerifier: SYNTHETIC_VERIFIER,
      },
      proc, exit: (code) => exits.push(code), log: { log: (line) => logs.push(line) },
    });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'config_invalid');
    assert.deepEqual(result.reasons, ['TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_present']);
    assert.equal(dbCalls, 0);
    assert.deepEqual(exits, [1]);
    assert.ok(!logs.some((l) => l.includes(key)), 'the key is never logged');
    assert.equal(spy.calls(), 0, 'a refused startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('a fake client whose transaction rejects refuses database_unavailable, exits 1, and ends the client', async () => {
  const { proc } = fakeProc();
  const exits: number[] = [];
  let ended = 0;
  const client: SupervisedPgClient = {
    transaction: () => Promise.reject(new Error('connection refused')),
    end: async () => { ended++; },
  };
  const spy = listenSpy();
  try {
    const result = await startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => client, listen: (port) => ({ port }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'database_unavailable');
    assert.deepEqual(exits, [1]);
    assert.equal(ended, 1);
    assert.equal(spy.calls(), 0, 'a refused startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('a fake client whose transaction waits for its signal: SIGTERM interrupts, exits 0, never listens, and ends the client', async () => {
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  let ended = 0;
  let listened = 0;
  const client: SupervisedPgClient = {
    transaction: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    end: async () => { ended++; },
  };
  const spy = listenSpy();
  try {
    const resultPromise = startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => client, listen: (port) => { listened++; return { port }; }, tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    await settle(); // let startup reach the hanging connect() call
    emit('SIGTERM');
    const result = await resultPromise;
    assert.equal(result.outcome, 'interrupted');
    assert.equal(listened, 0);
    assert.deepEqual(exits, [0]);
    assert.equal(ended, 1);
    assert.equal(spy.calls(), 0, 'an interrupted startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('two SIGTERMs exit exactly once', async () => {
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  const client: SupervisedPgClient = {
    transaction: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    end: async () => undefined,
  };
  const spy = listenSpy();
  try {
    const resultPromise = startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => client, listen: (port) => ({ port }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    await settle();
    emit('SIGTERM');
    emit('SIGTERM');
    await resultPromise;
    assert.equal(exits.length, 1, JSON.stringify(exits));
    assert.equal(spy.calls(), 0, 'an interrupted startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('a databaseClient that throws a RangeError refuses startup_failed, exits 1, and never logs the error text', async () => {
  const { proc } = fakeProc();
  const exits: number[] = [];
  const logs: string[] = [];
  const spy = listenSpy();
  try {
    const result = await startProductionEntry({
      env: VALID_ENV,
      construction: {
        databaseClient: () => { throw new RangeError('M6EP-DEFECT-TEXT-7a8b9c'); }, listen: (port) => ({ port }),
        tokenVerifier: SYNTHETIC_VERIFIER,
      },
      proc, exit: (code) => exits.push(code), log: { log: (line) => logs.push(line) },
    });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'startup_failed');
    assert.deepEqual(exits, [1]);
    assert.ok(!logs.some((l) => l.includes('M6EP-DEFECT-TEXT-7a8b9c')), JSON.stringify(logs));
    assert.equal(spy.calls(), 0, 'a refused startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

test('no captured log line, across every FAKE-construction scenario above, carries a configuration value', async () => {
  const marker = randomBytes(16).toString('hex');
  const logs: string[] = [];
  const log = { log: (line: string) => logs.push(line) };
  const { proc } = fakeProc();
  const spy = listenSpy();
  try {
    await startProductionEntry({
      env: envWith({ SESSION_ADMIN_ORIGINS: `https://${marker}.invalid`, APP_DATABASE_URL: undefined }),
      construction: { databaseClient: () => { throw new Error('unused'); }, listen: (port) => ({ port }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: () => undefined, log,
    });
    const client: SupervisedPgClient = { transaction: () => Promise.reject(new Error(marker)), end: async () => undefined };
    await startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => client, listen: (port) => ({ port }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc: fakeProc().proc, exit: () => undefined, log,
    });
    assert.ok(logs.length > 0, 'at least one refusal was logged');
    assert.ok(!logs.some((l) => l.includes(marker)), JSON.stringify(logs));
    assert.equal(spy.calls(), 0, 'neither refused scenario above may ever attempt to bind');
  } finally {
    spy.restore();
  }
});

test('forceTimeoutMs: a client whose end() never resolves still forces shutdown_forced and exits 1', async () => {
  const { proc } = fakeProc();
  const exits: number[] = [];
  const logs: string[] = [];
  let exited: () => void;
  const exitedGate = new Promise<void>((resolve) => { exited = resolve; });
  const client: SupervisedPgClient = {
    transaction: () => Promise.reject(new Error('down')),
    end: () => new Promise(() => undefined), // never resolves
  };
  const spy = listenSpy();
  try {
    void startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => client, listen: (port) => ({ port }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc,
      exit: (code) => { exits.push(code); if (code !== 0 || exits.length > 0) exited(); },
      log: { log: (line) => logs.push(line) },
      forceTimeoutMs: 20,
    });
    await exitedGate;
    assert.deepEqual(exits, [1]);
    assert.ok(logs.some((l) => l.includes('shutdown_forced')), JSON.stringify(logs));
    assert.equal(spy.calls(), 0, 'a refused startup must never attempt to bind');
  } finally {
    spy.restore();
  }
});

// ===========================================================================================================
// D. startProductionEntry — the full golden path over a FAKE, fully-answering SupervisedPgClient (still no
//    database: every answer is authored here, over the exact approved least-privilege facts)
// ===========================================================================================================

type Row = Readonly<Record<string, unknown>>;
type QueryKind =
  | 'connect' | 'login' | 'memberships' | 'reached' | 'owned' | 'exposure' | 'grants' | 'database'
  | 'ledgerAccess' | 'ledgerRows' | 'rateLimitProbe' | 'storeProbe' | 'sessionGet' | 'platformAdmissionProbe';

function classify(text: string): QueryKind {
  if (text.includes('as connected')) return 'connect';
  if (text.includes('unsafe_attribute')) return 'reached';
  if (text.includes('own_role')) return 'login';
  if (text.includes('admin_option')) return 'memberships';
  if (text.includes('login_owned')) return 'owned';
  if (text.includes('public_exposure')) return 'exposure';
  if (text.includes('is_login')) return 'grants';
  if (text.includes('database_create')) return 'database';
  if (text.includes('has_table_privilege')) return 'ledgerAccess';
  if (text.includes('finished_at')) return 'ledgerRows';
  if (text.includes('m6_rate_limit_probe')) return 'rateLimitProbe';
  if (text.includes('m6_store_probe')) return 'storeProbe';
  if (text.includes('m5_session_get')) return 'sessionGet';
  if (text.includes('m5_admit_platform_session')) return 'platformAdmissionProbe';
  throw new Error(`goldenClient: unrecognized statement: ${text.slice(0, 150)}`);
}

const GOLDEN_LOGIN_ROW: Row = Object.freeze({
  rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
  rolinherit: true, own_role: true,
});
const GOLDEN_MEMBERSHIP_ROWS: readonly Row[] = Object.freeze([
  Object.freeze({ role: 'tmpos_app', admin_option: false, inherit_option: 'true' }),
  Object.freeze({ role: 'tmpos_audit_writer', admin_option: false, inherit_option: 'true' }),
]);
const GOLDEN_REACHED_ROWS: readonly Row[] = Object.freeze([
  Object.freeze({ role: 'tmpos_app', rolcanlogin: false, unsafe_attribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_app }),
  Object.freeze({ role: 'tmpos_audit_writer', rolcanlogin: false, unsafe_attribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_audit_writer }),
]);
const GOLDEN_GRANT_ROWS: readonly Row[] = Object.freeze([
  Object.freeze({ is_login: true, role: 'runtime_login', kind: 'a', type: 'table', identity: 'public.schema_migrations', privileges: 'SELECT' }),
  ...APPROVED_ROLE_GRANTS.map((line) => {
    const [role, kind, type, identity, privileges] = line.split('|');
    return Object.freeze({ is_login: false, role, kind, type, identity, privileges: privileges === '' ? null : privileges });
  }),
]);
const GOLDEN: Readonly<Record<QueryKind, readonly Row[]>> = Object.freeze({
  connect: Object.freeze([Object.freeze({ connected: 1 })]),
  login: Object.freeze([GOLDEN_LOGIN_ROW]),
  memberships: GOLDEN_MEMBERSHIP_ROWS,
  reached: GOLDEN_REACHED_ROWS,
  owned: Object.freeze([Object.freeze({ login_owned: 0, roles_owned: 0, role_memberships: 0, foreign_dependencies: 0 })]),
  exposure: Object.freeze([Object.freeze({ public_exposure: 0 })]),
  grants: GOLDEN_GRANT_ROWS,
  database: Object.freeze([Object.freeze({ database_create: false, database_temporary: false, schema_create: 0 })]),
  ledgerAccess: Object.freeze([Object.freeze({ present: true, readable: true })]),
  ledgerRows: Object.freeze(REQUIRED_MIGRATIONS.map((m) => Object.freeze({ version: m.version, checksum: m.checksum, dirty: false, finished: true }))),
  rateLimitProbe: Object.freeze([Object.freeze({ outcome: 'ready' })]),
  storeProbe: Object.freeze([Object.freeze({ ok: true })]),
  sessionGet: Object.freeze([]),
  platformAdmissionProbe: Object.freeze([Object.freeze({ outcome: 'refused' })]),
});

/** A fully-answering FAKE SupervisedPgClient over the golden least-privilege facts: still no database, ever. */
function goldenClient(): SupervisedPgClient {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<readonly Row[]> => GOLDEN[classify(strings.join('$'))],
    { json: (v: unknown) => v },
  );
  return Object.freeze({
    transaction: async <T>(_signal: AbortSignal, _bounds: TransactionBounds, work: (sql: PgTransactionScope) => Promise<T>): Promise<T> =>
      work(sql as unknown as PgTransactionScope),
    end: async (): Promise<void> => undefined,
  });
}

/** Shut the entry down through its own fake SIGTERM path and wait for the exit callback, closing any real listener. */
async function shutDown(emit: (event: string) => void, exits: number[]): Promise<void> {
  emit('SIGTERM');
  for (let i = 0; i < 50 && exits.length === 0; i++) await settle();
}

test('the golden-path fake client reaches "listening" (positive control), served on an exact routes match', async () => {
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  let result: EntryResult | undefined;
  const spy = listenSpy();
  try {
    result = await startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => goldenClient(), listen: () => ({ port: 0, host: '127.0.0.1' }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    assert.equal(result.outcome, 'listening', JSON.stringify(result));
    assert.equal(result.failure, null);
    assert.ok(result.address !== null);
    assert.deepEqual(canonical(result.routes), canonical(SHIPPING_ROUTES));
    assert.equal(spy.calls(), 1, 'the golden listening path binds exactly once');
  } finally {
    spy.restore();
    await shutDown(emit, exits);
  }
  assert.deepEqual(exits, [0]);
});

test('step 10 (listen) is bounded: a listen that never settles refuses listen_failed with reason listen_timeout', async (t) => {
  const originalListen = net.Server.prototype.listen;
  let listenCalled: () => void = () => undefined;
  const listenGate = new Promise<void>((resolve) => { listenCalled = resolve; });
  // Never calls back and never emits 'error': the real bind hangs forever, so only the step's own deadline ends it.
  (net.Server.prototype as unknown as { listen: (...args: unknown[]) => unknown }).listen = function patchedListen(this: unknown) {
    listenCalled();
    return this;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  try {
    const resultPromise = startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => goldenClient(), listen: () => ({ port: 0, host: '127.0.0.1' }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    await listenGate; // step 10 has now called the (patched) listen and is hanging
    t.mock.timers.tick(STARTUP_STEP_DEADLINE_MS);
    const result = await resultPromise;
    assert.equal(result.outcome, 'refused');
    assert.equal(result.failure, 'listen_failed');
    assert.deepEqual(result.reasons, ['listen_timeout']);
    assert.equal(result.address, null);
  } finally {
    net.Server.prototype.listen = originalListen;
    t.mock.timers.reset();
    await shutDown(emit, exits);
  }
});

// ===========================================================================================================
// D2. dependency_unready — each of step 7's and step 9's five probes, refused alone, over the same golden facts
// ===========================================================================================================

/** A queued answer for one call of a QueryKind, in order: a row set, 'reject' (the query throws), or 'default' (GOLDEN). */
type QueueEntry = readonly Row[] | 'reject' | 'default';

const STORE_SOURCE_LINES = readFileSync(new URL('../persistence/postgresTransactionalStore.ts', import.meta.url), 'utf8').split('\n');

/**
 * Which store port asked m6_store_probe. Every port's probe is the one statement over the one client, so the statement
 * cannot tell idempotency_store from command_transactions — the port method on the call stack can: the top-level function
 * of postgresTransactionalStore.ts enclosing its `Object.probe` frame (idempotencyPort, transactionPort). No such frame
 * throws, which the store answers as not ready for EVERY port — every dependency_unready case then refuses with the wrong
 * reasons, never answering for a port that did not ask.
 */
function probingStorePort(): string {
  const frame = /Object\.probe \(.*postgresTransactionalStore\.ts:(\d+):\d+\)/.exec(new Error().stack ?? '');
  if (frame === null) throw new Error('m6_store_probe asked by no store port');
  for (let i = Number(frame[1]) - 1; i >= 0; i--) {
    const fn = /^function (\w+)\(/.exec(STORE_SOURCE_LINES[i]);
    if (fn !== null) return fn[1];
  }
  throw new Error('store port probe outside any function');
}

/** Overrides by QueryKind — except m6_store_probe, overridden per asking port: each named case fails unless ITS port asks. */
type OverrideKey = Exclude<QueryKind, 'storeProbe'> | 'storeProbe:idempotencyPort' | 'storeProbe:transactionPort';

/**
 * `goldenClient`, but a probe's successive calls can be substituted in order before falling back to GOLDEN. The limiter
 * key's boot check and the rate limiter's own probe share one physical query (m6_rate_limit_probe), called in that fixed
 * order, so its queue's entries line up with call order; m6_store_probe's queue is kept per asking port instead.
 */
function statefulGoldenClient(overrides: Partial<Record<OverrideKey, readonly QueueEntry[]>>): SupervisedPgClient {
  const seen = new Map<OverrideKey, number>();
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]): Promise<readonly Row[]> => {
      const kind = classify(strings.join('$'));
      const key = (kind === 'storeProbe' ? `storeProbe:${probingStorePort()}` : kind) as OverrideKey;
      const i = seen.get(key) ?? 0;
      seen.set(key, i + 1);
      const queue = overrides[key];
      const entry: QueueEntry = queue !== undefined && i < queue.length ? queue[i] : 'default';
      if (entry === 'default') return GOLDEN[kind];
      if (entry === 'reject') throw new Error('synthetic probe rejection');
      return entry;
    },
    { json: (v: unknown) => v },
  );
  return Object.freeze({
    transaction: async <T>(_signal: AbortSignal, _bounds: TransactionBounds, work: (sql: PgTransactionScope) => Promise<T>): Promise<T> =>
      work(sql as unknown as PgTransactionScope),
    end: async (): Promise<void> => undefined,
  });
}

/** A well-formed session row (m5_session_get): the ONE answer that makes session_store's probe see "not undefined". */
const GOLDEN_SESSION_ROW: Row = Object.freeze({
  audience: 'admin', authProvider: 'firebase', authProviderUid: 'probe-uid', principalKey: 'probe-principal',
  securityVersion: 'v1', authenticatedAt: null, createdAt: 1_000, lastSeenAt: 1_000, validatedAt: 1_000,
});

/** dependency_unready, refused alone with exactly `reason`: exit 1, no address, and never a bind attempt. */
async function assertDependencyUnready(overrides: Partial<Record<OverrideKey, readonly QueueEntry[]>>, reason: string): Promise<void> {
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  const spy = listenSpy();
  let result: EntryResult | undefined;
  try {
    result = await startProductionEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => statefulGoldenClient(overrides), listen: () => ({ port: 0, host: '127.0.0.1' }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    assert.equal(result.outcome, 'refused', JSON.stringify(result));
    assert.equal(result.failure, 'dependency_unready');
    assert.deepEqual(result.reasons, [reason]);
    assert.equal(result.address, null);
    assert.deepEqual(exits, [1]);
    assert.equal(spy.calls(), 0, 'a dependency_unready refusal must never attempt to bind');
  } finally {
    spy.restore();
    // A regression that listens instead fails the assertions above; its listener is shut down here (bounded, shutDown),
    // so a failing case can never leave a bound socket keeping the run alive.
    if (result?.outcome === 'listening') await shutDown(emit, exits);
  }
}

test('dependency_unready: idempotency_store answers not ready (asked by the idempotency port itself)', async () => {
  await assertDependencyUnready({ 'storeProbe:idempotencyPort': [[{ ok: false }]] }, 'idempotency_store');
});

test('dependency_unready: idempotency_store rejects', async () => {
  await assertDependencyUnready({ 'storeProbe:idempotencyPort': ['reject'] }, 'idempotency_store');
});

test('dependency_unready: command_transactions answers not ready (asked by the transaction port itself)', async () => {
  await assertDependencyUnready({ 'storeProbe:transactionPort': [[{ ok: false }]] }, 'command_transactions');
});

test('dependency_unready: command_transactions rejects', async () => {
  await assertDependencyUnready({ 'storeProbe:transactionPort': ['reject'] }, 'command_transactions');
});

test('dependency_unready: session_store answers not ready (a session found for the probe key)', async () => {
  await assertDependencyUnready({ sessionGet: [[GOLDEN_SESSION_ROW]] }, 'session_store');
});

test('dependency_unready: session_store rejects', async () => {
  await assertDependencyUnready({ sessionGet: ['reject'] }, 'session_store');
});

test('dependency_unready: admin_admission answers not ready', async () => {
  await assertDependencyUnready({ platformAdmissionProbe: [[{ outcome: 'unavailable' }]] }, 'admin_admission');
});

test('dependency_unready: admin_admission rejects', async () => {
  await assertDependencyUnready({ platformAdmissionProbe: ['reject'] }, 'admin_admission');
});

test('dependency_unready: rate_limiter answers not ready (the boot check succeeds first; its own probe, called second, does not)', async () => {
  await assertDependencyUnready({ rateLimitProbe: ['default', [{ outcome: 'key_mismatch' }]] }, 'rate_limiter');
});

test('dependency_unready: rate_limiter rejects', async () => {
  await assertDependencyUnready({ rateLimitProbe: ['default', 'reject'] }, 'rate_limiter');
});

// ===========================================================================================================
// E. PRODUCTION_CONSTRUCTION — pinned by identity to the real production dependencies it wires
// ===========================================================================================================

test('PRODUCTION_CONSTRUCTION wires the real verified-TLS client factory, the Firebase Admin SDK default verifier, and PORT on every interface', () => {
  assert.ok(Object.isFrozen(PRODUCTION_CONSTRUCTION));
  assert.deepEqual(Object.keys(PRODUCTION_CONSTRUCTION).sort(), ['databaseClient', 'listen'], 'exactly these members: no fake, no testkit');
  // The db.ts factory itself (verified TLS against DATABASE_CA_CERT) — never a wrapper or a stand-in.
  assert.equal(PRODUCTION_CONSTRUCTION.databaseClient, createRuntimeStoreClient);
  // Absent: the Firebase adapter then builds the Firebase Admin SDK's own verifier — no synthetic one can be selected.
  assert.equal(PRODUCTION_CONSTRUCTION.tokenVerifier, undefined);
  // The configured PORT, no host: every interface, and nothing else chosen here.
  assert.deepEqual(PRODUCTION_CONSTRUCTION.listen(4443), { port: 4443 });
  assert.ok(Object.isFrozen(PRODUCTION_CONSTRUCTION.listen(4443)));
});
