// M7A-CUSTOMERS-P2 — tenantEntry.ts: validateTenantEntryConfig (pure), TENANT_SHIPPING_ROUTES bound to what the runtime
// actually composes from the real tenant route declarations, and startTenantEntry — FAKE constructions only, no database,
// ever. The disposable-database proof of the same entry, compiled and over real sockets, is tests/db's.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { STARTUP_STEP_DEADLINE_MS } from './entryStartup.js';
import type { EntryResult, ServedRoute } from './entryStartup.js';
import { TENANT_SHIPPING_ROUTES, servesExactlyTenantRoutes, startTenantEntry, validateTenantEntryConfig } from './tenantEntry.js';
import { createApp, createReadinessState } from '../runtime/app.js';
import { composeProductionSessions } from '../composition/productionSessions.js';
import { tenantRouteDeclarations } from '../composition/tenantTransactions.js';
import { APPROVED_ROLE_GRANTS, REQUIRED_MIGRATIONS, RUNTIME_PRIVILEGE_ROLES } from '../persistence/postgresStartupPreflight.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from '../persistence/supervisedPgClient.js';
import { createMemoryIdempotencyStore } from '../runtime/idempotencyStore.testkit.js';
import { createMemorySessionStore } from '../runtime/memorySessionStore.testkit.js';
import type { TenantAdmissionPort } from '../runtime/principals.js';
import type { DistributedRateLimiter } from '../runtime/rateLimit.js';
import type { FirebaseIdTokenVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import { DRIVER_TLS_ENV_VAR, DatabaseTlsRefusal } from '../platform-identity/db.js';

// --- a synthetic, throwaway configuration: no secret, nothing dialled --------------------------------------------

const REF = 'abcdefghijklmnop';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account', project_id: 'm7tu-demo', client_email: 'svc@m7tu-demo.iam.gserviceaccount.com', private_key: privateKey,
});
const RATE_LIMIT_KEY = Buffer.alloc(32, 7).toString('base64url');
/** Runtime-generated: canonical, never RATE_LIMIT_KEY and (about 30 distinct values in 32 bytes) never weak. */
const ISSUER_KEY = randomBytes(32).toString('base64url');
/** The tenant process's own command secret (M7A-CUSTOMERS-P3): runtime-generated, never RATE_LIMIT_KEY or the issuer key. */
const IDEMPOTENCY_KEY = randomBytes(32).toString('base64url');
const TENANT_HOST = 'tenant.tmpos.test';
const ADMIN_HOST = 'admin.tmpos.test';

/** A complete, valid synthetic tenant configuration. Every test overrides one field at a time from this baseline. */
const VALID_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'production',
  PORT: '4443',
  APP_DATABASE_URL: `postgres://tmpos_runtime:synthetic-pw@db.${REF}.supabase.co:5432/postgres`,
  DATABASE_CA_CERT: tls.rootCertificates[0],
  RATE_LIMIT_KEY,
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: `https://${ADMIN_HOST}`,
  SESSION_TENANT_ORIGINS: `https://${TENANT_HOST}`,
  TENANT_SESSION_ISSUER_KEY: ISSUER_KEY,
  IDEMPOTENCY_KEY,
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
});

const envWith = (over: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => ({ ...VALID_ENV, ...over });
const b64 = (bytes: Buffer): string => bytes.toString('base64url');
const VECTOR = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

// ===========================================================================================================
// A. validateTenantEntryConfig — pure, no network, no listener, no client
// ===========================================================================================================

test('M7TU-01 validateTenantEntryConfig: a complete synthetic valid configuration clears every check, with its own IDEMPOTENCY_KEY', () => {
  assert.deepEqual(validateTenantEntryConfig(VALID_ENV), []);
  assert.equal(typeof VALID_ENV.IDEMPOTENCY_KEY, 'string', 'M7A-CUSTOMERS-P3: the command secret is required');
});

test('M7TU-02 validateTenantEntryConfig: every code, each in a targeted single-fault case', () => {
  const cases: Array<[string, string, Record<string, string | undefined>]> = [
    // The shared judgments (entryStartup.ts validateCommonEntryConfig), reached through this entry.
    ['NODE_ENV', 'env_missing', envWith({ NODE_ENV: undefined })],
    ['NODE_ENV', 'env_not_production', envWith({ NODE_ENV: 'development' })],
    ['PORT', 'port_missing', envWith({ PORT: undefined })],
    ['APP_DATABASE_URL', 'app_database_url_missing', envWith({ APP_DATABASE_URL: undefined })],
    ['APP_DATABASE_URL', 'app_database_endpoint_unsupported', envWith({ APP_DATABASE_URL: `postgres://tmpos_runtime:synthetic-pw@db.${REF}.supabase.co:6543/postgres` })],
    ['DATABASE_CA_CERT', 'database_ca_missing', envWith({ DATABASE_CA_CERT: undefined })],
    ['DATABASE_CA_CERT', 'database_ca_invalid', envWith({ DATABASE_CA_CERT: 'not a certificate' })],
    [DRIVER_TLS_ENV_VAR, 'driver_tls_override_forbidden', envWith({ [DRIVER_TLS_ENV_VAR]: 'disable' })],
    ['RATE_LIMIT_KEY', 'rate_limit_key_missing', envWith({ RATE_LIMIT_KEY: undefined })],
    ['RATE_LIMIT_KEY', 'rate_limit_key_invalid', envWith({ RATE_LIMIT_KEY: 'too-short' })],
    ['TRUSTED_PROXY_CIDRS', 'trusted_proxies_missing', envWith({ TRUSTED_PROXY_CIDRS: 'none' })],
    ['TRUSTED_PROXY_CIDRS', 'trusted_proxies_invalid', envWith({ TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })],
    ['SESSION_ADMIN_ORIGINS', 'session_admin_origin_missing', envWith({ SESSION_ADMIN_ORIGINS: undefined })],
    ['SESSION_ADMIN_ORIGINS', 'session_admin_origin_not_single', envWith({ SESSION_ADMIN_ORIGINS: `https://${ADMIN_HOST},https://other.tmpos.test` })],
    ['SESSION_ADMIN_ORIGINS', 'session_admin_origin_invalid', envWith({ SESSION_ADMIN_ORIGINS: `http://${ADMIN_HOST}` })],
    ['FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON', 'identity_verifier_unconfigured', envWith({ FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: 'not json' })],
    ['FIREBASE_AUTH_EMULATOR_HOST', 'identity_emulator_forbidden', envWith({ FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' })],
    ['NODE_TLS_REJECT_UNAUTHORIZED', 'tls_verification_override_forbidden', envWith({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })],
    ['NODE_EXTRA_CA_CERTS', 'tls_trust_store_override_forbidden', envWith({ NODE_EXTRA_CA_CERTS: '/etc/ssl/extra-roots.pem' })],
    ['NODE_OPTIONS', 'tls_trust_store_override_forbidden', envWith({ NODE_OPTIONS: '--use-openssl-ca' })],
    ['SUPABASE_DATABASE_URL', 'owner_credential_forbidden', envWith({ SUPABASE_DATABASE_URL: `postgres://postgres:synthetic-pw@db.${REF}.supabase.co:5432/postgres` })],
    ['SUPABASE_SERVICE_ROLE_KEY', 'owner_credential_forbidden', envWith({ SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role' })],
    // The tenant origin: exactly one canonical https origin on a servable host.
    ['SESSION_TENANT_ORIGINS', 'session_tenant_origin_missing', envWith({ SESSION_TENANT_ORIGINS: undefined })],
    ['SESSION_TENANT_ORIGINS', 'session_tenant_origin_missing', envWith({ SESSION_TENANT_ORIGINS: '' })],
    ['SESSION_TENANT_ORIGINS', 'session_tenant_origin_not_single', envWith({ SESSION_TENANT_ORIGINS: `https://${TENANT_HOST},https://pos.tmpos.test` })],
    ...[
      `http://${TENANT_HOST}`, `https://${TENANT_HOST}/`, `https://${TENANT_HOST}/api`, '*', 'https://*.tmpos.test', `https://TENANT.tmpos.test`,
      `https://${TENANT_HOST}:443`, 'https://127.0.0.1', 'https://[::1]:8443', `https://${TENANT_HOST}.`, `https://user@${TENANT_HOST}`, 'tenant.tmpos.test',
    ].map((origin): [string, string, Record<string, string | undefined>] =>
      ['SESSION_TENANT_ORIGINS', 'session_tenant_origin_invalid', envWith({ SESSION_TENANT_ORIGINS: origin })]),
    // ...on a host the administrative origin does not name, whatever the port.
    ['SESSION_TENANT_ORIGINS', 'session_tenant_origin_shares_admin_host', envWith({ SESSION_TENANT_ORIGINS: `https://${ADMIN_HOST}` })],
    ['SESSION_TENANT_ORIGINS', 'session_tenant_origin_shares_admin_host', envWith({ SESSION_TENANT_ORIGINS: `https://${ADMIN_HOST}:8443` })],
    ['SESSION_TENANT_ORIGINS', 'session_tenant_origin_shares_admin_host', envWith({ SESSION_ADMIN_ORIGINS: `https://${TENANT_HOST}:8443` })],
    // The minting secret.
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_missing', envWith({ TENANT_SESSION_ISSUER_KEY: undefined })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_missing', envWith({ TENANT_SESSION_ISSUER_KEY: '' })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_invalid', envWith({ TENANT_SESSION_ISSUER_KEY: b64(randomBytes(31)) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_invalid', envWith({ TENANT_SESSION_ISSUER_KEY: `${ISSUER_KEY.slice(0, 42)}B` })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_invalid', envWith({ TENANT_SESSION_ISSUER_KEY: `${ISSUER_KEY}=` })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_shared', envWith({ TENANT_SESSION_ISSUER_KEY: RATE_LIMIT_KEY })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_shared', envWith({ TENANT_SESSION_ISSUER_KEY: b64(Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(1)])) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_weak', envWith({ TENANT_SESSION_ISSUER_KEY: b64(VECTOR) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_weak', envWith({ TENANT_SESSION_ISSUER_KEY: b64(Buffer.concat([VECTOR, Buffer.alloc(1)])) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_weak', envWith({ TENANT_SESSION_ISSUER_KEY: b64(Buffer.alloc(32, 8)) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_weak', envWith({ TENANT_SESSION_ISSUER_KEY: b64(Buffer.concat([Buffer.alloc(32, 8), Buffer.alloc(1)])) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_weak', envWith({ TENANT_SESSION_ISSUER_KEY: b64(Buffer.alloc(32)) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_weak', envWith({ TENANT_SESSION_ISSUER_KEY: b64(Buffer.concat([Buffer.from([0xab, 0xcd]), Buffer.alloc(30)])) })],
    ['TENANT_SESSION_ISSUER_KEY', 'tenant_issuer_key_weak', envWith({ TENANT_SESSION_ISSUER_KEY: b64(Buffer.concat([randomBytes(12), Buffer.alloc(20)])) })],
    // M7A-CUSTOMERS-P3: this process's own command secret — present, canonical, and never the limiter's or the minting key.
    ['IDEMPOTENCY_KEY', 'idempotency_key_missing', envWith({ IDEMPOTENCY_KEY: undefined })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_missing', envWith({ IDEMPOTENCY_KEY: '' })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_invalid', envWith({ IDEMPOTENCY_KEY: 'not-a-key' })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_invalid', envWith({ IDEMPOTENCY_KEY: b64(randomBytes(31)) })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_invalid', envWith({ IDEMPOTENCY_KEY: `${IDEMPOTENCY_KEY}=` })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_shared', envWith({ IDEMPOTENCY_KEY: RATE_LIMIT_KEY })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_shared', envWith({ IDEMPOTENCY_KEY: b64(Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(1)])) })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_shared', envWith({ IDEMPOTENCY_KEY: ISSUER_KEY })],
    ['IDEMPOTENCY_KEY', 'idempotency_key_shared', envWith({ IDEMPOTENCY_KEY: b64(Buffer.concat([Buffer.from(ISSUER_KEY, 'base64url'), Buffer.alloc(1)])) })],
  ];
  for (const [field, code, env] of cases) {
    assert.deepEqual(validateTenantEntryConfig(env), [{ field, code }], `${field}:${code} over ${JSON.stringify(env[field])}`);
  }
  // Empty values of the refused-when-present keys add nothing.
  for (const field of ['SUPABASE_DATABASE_URL', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    assert.deepEqual(validateTenantEntryConfig(envWith({ [field]: '' })), [], `empty ${field}`);
  }
  // A malformed administrative origin is named once; the host comparison is not made against it.
  assert.deepEqual(validateTenantEntryConfig(envWith({ SESSION_ADMIN_ORIGINS: `https://${TENANT_HOST}/` })),
    [{ field: 'SESSION_ADMIN_ORIGINS', code: 'session_admin_origin_invalid' }]);
});

test('M7TU-03 validateTenantEntryConfig: no returned field or code carries any part of the submitted value', () => {
  const MARKER = `M7TU-MARKER-${randomBytes(6).toString('hex')}`;
  const env = envWith({
    NODE_ENV: MARKER, PORT: MARKER, APP_DATABASE_URL: `postgres://user:${MARKER}@db.${REF}.supabase.co:5432/postgres`,
    DATABASE_CA_CERT: MARKER, RATE_LIMIT_KEY: MARKER, TRUSTED_PROXY_CIDRS: MARKER, SESSION_ADMIN_ORIGINS: `https://${MARKER}.invalid`,
    SESSION_TENANT_ORIGINS: `https://${MARKER}.tenant.invalid/${MARKER}`, TENANT_SESSION_ISSUER_KEY: MARKER, IDEMPOTENCY_KEY: MARKER,
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: MARKER, NODE_OPTIONS: `--use-openssl-ca ${MARKER}`,
  });
  const errors = validateTenantEntryConfig(env);
  assert.ok(errors.length > 0);
  assert.ok(!JSON.stringify(errors).includes(MARKER), JSON.stringify(errors));
  assert.ok(!JSON.stringify(validateTenantEntryConfig(envWith({ TENANT_SESSION_ISSUER_KEY: b64(VECTOR) }))).includes(b64(VECTOR)));
});

// Every environment key validateTenantEntryConfig — and the modules it calls — is documented to read. A key read that is not
// on this list is a regression this test must catch.
const DOCUMENTED_ENV_KEYS: readonly string[] = [
  'NODE_ENV', 'PORT', 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW',
  'APP_DATABASE_URL', 'DATABASE_CA_CERT', DRIVER_TLS_ENV_VAR, 'RATE_LIMIT_KEY',
  'TRUSTED_PROXY_CIDRS', 'SESSION_ADMIN_ORIGINS', 'FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON',
  'FIREBASE_AUTH_EMULATOR_HOST', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS',
  'SUPABASE_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'SESSION_TENANT_ORIGINS', 'TENANT_SESSION_ISSUER_KEY', 'IDEMPOTENCY_KEY',
];

test('M7TU-04 validateTenantEntryConfig: opens no handle, reads only the documented keys of the supplied env, and never process.env', () => {
  const before = process.getActiveResourcesInfo();
  const read = new Set<string>();
  const recording = (env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => new Proxy(env, {
    get(target, prop, receiver) { if (typeof prop === 'string') read.add(prop); return Reflect.get(target, prop, receiver); },
    has(target, prop) { if (typeof prop === 'string') read.add(prop); return Reflect.has(target, prop); },
  }) as Record<string, string | undefined>;
  const ambient: string[] = [];
  const originalEnv = process.env;
  process.env = new Proxy(originalEnv, {
    get(target, prop, receiver) { ambient.push(`get:${String(prop)}`); return Reflect.get(target, prop, receiver); },
    has(target, prop) { ambient.push(`has:${String(prop)}`); return Reflect.has(target, prop); },
    ownKeys(target) { ambient.push('ownKeys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) { ambient.push(`descriptor:${String(prop)}`); return Reflect.getOwnPropertyDescriptor(target, prop); },
  });
  try {
    validateTenantEntryConfig(recording(VALID_ENV));
    validateTenantEntryConfig(recording({}));
  } finally {
    process.env = originalEnv;
  }
  assert.deepEqual(ambient, [], `validateTenantEntryConfig read process.env directly: ${JSON.stringify(ambient)}`);
  assert.deepEqual([...read].filter((key) => !DOCUMENTED_ENV_KEYS.includes(key)), [], 'no undocumented key is read');
  assert.ok(read.has('TENANT_SESSION_ISSUER_KEY') && read.has('SESSION_TENANT_ORIGINS'), 'the scan observes reads (positive control)');
  assert.deepEqual(process.getActiveResourcesInfo(), before, 'validateTenantEntryConfig must open nothing');
});

// ===========================================================================================================
// B. TENANT_SHIPPING_ROUTES — the exact frozen inventory, bound to what the runtime composes from the REAL tenant route
//    declarations (server/composition/tenantTransactions.ts), over testkits: no database, ever.
// ===========================================================================================================

test('M7TU-05 TENANT_SHIPPING_ROUTES is exactly the 14 frozen tenant routes', () => {
  assert.deepEqual(TENANT_SHIPPING_ROUTES, [
    { method: 'GET', path: '/health', access: 'public', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/readiness', access: 'public', body: 'none', idempotency: 'none' },
    { method: 'POST', path: '/api/v1/session/login', access: 'login', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/api/v1/session', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'POST', path: '/api/v1/session/logout', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/api/v1/customers', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/api/v1/customers/{id}', access: 'session', body: 'none', idempotency: 'none' },
    // M7A-CUSTOMERS-P6: the contact profile, the route table's second template.
    { method: 'GET', path: '/api/v1/customers/{id}/profile', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'POST', path: '/api/v1/customers', access: 'session', body: 'json', idempotency: 'required' },
    // M7A-CUSTOMERS-P7: the customer edit, the route table's one templated command.
    { method: 'PATCH', path: '/api/v1/customers/{id}', access: 'session', body: 'json', idempotency: 'required' },
    { method: 'GET', path: '/api/v1/roles/levels', access: 'session', body: 'none', idempotency: 'none' },
    // M5-INVOICES-AUTH-P1: the Invoices level read-back (configuration only), beside the Customers one.
    { method: 'GET', path: '/api/v1/roles/levels/invoices', access: 'session', body: 'none', idempotency: 'none' },
    { method: 'PUT', path: '/api/v1/roles/levels', access: 'session', body: 'json', idempotency: 'required' },
    // M7B-INVOICES-P1: the store directory, the route table's one closed authorization-free business route.
    { method: 'GET', path: '/api/v1/stores', access: 'session', body: 'none', idempotency: 'none' },
  ]);
  assert.ok(Object.isFrozen(TENANT_SHIPPING_ROUTES) && TENANT_SHIPPING_ROUTES.every((r) => Object.isFrozen(r)));
  assert.ok(!TENANT_SHIPPING_ROUTES.some((r) => r.path.startsWith('/admin/') || r.path.includes('/harness/')), 'no administrative or witness route');
});

const canonical = (routes: readonly ServedRoute[]): unknown =>
  routes.map((r) => [r.method, r.path, r.access, r.body, r.idempotency]).sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));

/** A synthetic, THROWING verifier: every composition and fake construction here passes it, so nothing can dial a provider. */
const SYNTHETIC_VERIFIER: FirebaseIdTokenVerifier = Object.freeze({
  verify: async () => { throw Object.assign(new Error('synthetic'), { code: 'auth/invalid-id-token' }); },
});

test('M7TU-06 TENANT_SHIPPING_ROUTES equals the table the runtime builds from the real tenant declarations, tenant boundary alone', () => {
  const tenantAdmission: TenantAdmissionPort = Object.freeze({ admit: async () => Object.freeze({ outcome: 'refused' }), probe: async () => true });
  const limiter: DistributedRateLimiter = { consume: async () => ({ outcome: 'unavailable' }), probe: async () => true };
  const sessions = composeProductionSessions(VALID_ENV, {
    store: createMemorySessionStore(), tenantAdmission, rateLimiter: () => limiter, tenantReads: new Set(['GET /api/v1/customers', 'GET /api/v1/customers/{id}', 'GET /api/v1/customers/{id}/profile', 'GET /api/v1/roles/levels', 'GET /api/v1/roles/levels/invoices']),
    roleLevels: async () => ({}),
  }, { audiences: ['tenant'], tokenVerifier: SYNTHETIC_VERIFIER });
  const readiness = createReadinessState();
  // M7A-CUSTOMERS-P3: the POST requires the idempotency store and the command port, handed in as the tenant root hands them.
  const app = createApp({
    readiness, routes: tenantRouteDeclarations(), limits: sessions.limits, sessions: sessions.sessions, hsts: true, hosts: [TENANT_HOST],
    idempotency: { store: createMemoryIdempotencyStore(), keySecret: Buffer.from(IDEMPOTENCY_KEY, 'base64url') },
    transactions: { port: { commit: async () => ({ outcome: 'unavailable' }), probe: async () => true } },
  });
  assert.deepEqual(canonical(app.locals.routes as readonly ServedRoute[]), canonical(TENANT_SHIPPING_ROUTES));
});

test('M7TU-07 servesExactlyTenantRoutes: true for the inventory and a reordered copy; false for one missing, one extra, or one attribute changed', () => {
  assert.equal(servesExactlyTenantRoutes(TENANT_SHIPPING_ROUTES), true);
  assert.equal(servesExactlyTenantRoutes([...TENANT_SHIPPING_ROUTES].reverse()), true);
  assert.equal(servesExactlyTenantRoutes(TENANT_SHIPPING_ROUTES.slice(1)), false);
  assert.equal(servesExactlyTenantRoutes([...TENANT_SHIPPING_ROUTES,
    { method: 'GET', path: '/admin/v1/tenants', access: 'session', body: 'none', idempotency: 'none' }]), false);
  for (const attribute of ['method', 'path', 'access', 'body', 'idempotency'] as const) {
    assert.equal(servesExactlyTenantRoutes(TENANT_SHIPPING_ROUTES.map((r, i) => (i === 5 ? { ...r, [attribute]: `${r[attribute]}-x` } : r))), false, attribute);
  }
});

// ===========================================================================================================
// C. startTenantEntry over FAKE constructions — every refusal, then the golden path, the host lock and readiness
// ===========================================================================================================

function fakeProc(): { proc: { on(event: string, listener: (...args: unknown[]) => void): void }; emit: (event: string) => void } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    proc: { on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); } },
    emit(event) { for (const listener of listeners.get(event) ?? []) listener(); },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Counts real calls to net.Server.prototype.listen while active; always restore()d. */
function listenSpy(): { calls: () => number; restore: () => void } {
  const original = net.Server.prototype.listen;
  let count = 0;
  (net.Server.prototype as unknown as { listen: (...args: unknown[]) => net.Server }).listen = function patchedListen(this: net.Server, ...args: unknown[]): net.Server {
    count += 1;
    return (original as (...a: unknown[]) => net.Server).apply(this, args);
  };
  return { calls: () => count, restore: () => { net.Server.prototype.listen = original; } };
}

type Row = Readonly<Record<string, unknown>>;
type Kind =
  | 'connect' | 'login' | 'memberships' | 'reached' | 'owned' | 'exposure' | 'grants' | 'database' | 'ledgerAccess' | 'ledgerRows'
  | 'logging' | 'issuerKey' | 'rateLimitProbe' | 'rateLimitConsume' | 'sessionGet' | 'sessionMint' | 'tenantAdmissionProbe' | 'customerProbe'
  | 'customerDetailProbe' | 'customerProfileProbe' | 'customerSearchProbe' | 'storeDirectoryProbe' | 'storeProbe';

function classify(text: string): Kind {
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
  if (text.includes('log_parameter_max_length_on_error')) return 'logging';
  if (text.includes('m7a_issuer_key_check')) return 'issuerKey';
  if (text.includes('m6_rate_limit_probe')) return 'rateLimitProbe';
  if (text.includes('m6_rate_limit_consume')) return 'rateLimitConsume';
  if (text.includes('m5_session_get')) return 'sessionGet';
  if (text.includes('m7a_session_create')) return 'sessionMint';
  if (text.includes('m5_admit_tenant_session_v2')) return 'tenantAdmissionProbe';
  if (text.includes('m7a_customer_page_v3')) return 'customerProbe';
  if (text.includes('m7a_customer_profile')) return 'customerProfileProbe';
  if (text.includes('m7a_customer_get')) return 'customerDetailProbe';
  if (text.includes('m7a_customer_search')) return 'customerSearchProbe';
  if (text.includes('m7b_store_directory')) return 'storeDirectoryProbe';
  if (text.includes('m6_store_probe')) return 'storeProbe';
  throw new Error(`fake client: a statement the tenant entry never sends: ${text.slice(0, 120)}`);
}

const SAFE_LOGGING: Row = Object.freeze({
  on_error: '0', max_length: '-1', statement: 'none', min_duration: '-1', min_sample: '-1', sample_rate: '0', print_plan: 'off',
  ae_min_duration: null, pga_parameter: null, pga_log: null,
});

/** The golden least-privilege facts and every probe's ready answer: still no database, ever. */
const GOLDEN: Readonly<Record<Kind, readonly Row[]>> = Object.freeze({
  connect: [{ connected: 1 }],
  login: [{ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: true, own_role: true }],
  memberships: [{ role: 'tmpos_app', admin_option: false, inherit_option: 'true' }, { role: 'tmpos_audit_writer', admin_option: false, inherit_option: 'true' }],
  reached: [
    { role: 'tmpos_app', rolcanlogin: false, unsafe_attribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_app },
    { role: 'tmpos_audit_writer', rolcanlogin: false, unsafe_attribute: false, marker: RUNTIME_PRIVILEGE_ROLES.tmpos_audit_writer },
  ],
  owned: [{ login_owned: 0, roles_owned: 0, role_memberships: 0, foreign_dependencies: 0 }],
  exposure: [{ public_exposure: 0 }],
  grants: [
    { is_login: true, role: 'runtime_login', kind: 'a', type: 'table', identity: 'public.schema_migrations', privileges: 'SELECT' },
    ...APPROVED_ROLE_GRANTS.map((line) => {
      const [role, kind, type, identity, privileges] = line.split('|');
      return { is_login: false, role, kind, type, identity, privileges: privileges === '' ? null : privileges };
    }),
  ],
  database: [{ database_create: false, database_temporary: false, schema_create: 0 }],
  ledgerAccess: [{ present: true, readable: true }],
  ledgerRows: REQUIRED_MIGRATIONS.map((m) => ({ version: m.version, checksum: m.checksum, dirty: false, finished: true })),
  logging: [SAFE_LOGGING],
  issuerKey: [{ outcome: 'match' }],
  rateLimitProbe: [{ outcome: 'ready' }],
  rateLimitConsume: [{ outcome: 'allowed', remaining: 0, retry_after_ms: null }],
  sessionGet: [],
  sessionMint: [{ outcome: 'invalid' }],
  tenantAdmissionProbe: [{ outcome: 'refused' }],
  customerProbe: [{ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null }],
  customerDetailProbe: [{ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null }],
  customerProfileProbe: [{ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null, o_phone: null, o_email: null, o_created_at: null, o_version: null }],
  customerSearchProbe: [{ o_outcome: 'denied', o_tenant_id: null, o_customer_id: null, o_name: null }],
  storeDirectoryProbe: [{ o_outcome: 'denied', o_store_id: null, o_tenant_id: null, o_store_name: null, o_read_only: null }],
  storeProbe: [{ ok: true }],
});

/** One call's answer: rows, 'reject' (the statement throws) or 'default' (GOLDEN). */
type Entry = readonly Row[] | 'reject' | 'default';

/**
 * A FAKE SupervisedPgClient over GOLDEN: each kind's successive calls can be substituted in order, `live` overrides a kind
 * for every later call (readiness transitions), and every statement's kind is recorded in order.
 */
function fakeClient(queued: Partial<Record<Kind, readonly Entry[]>> = {}) {
  const seen = new Map<Kind, number>();
  const kinds: Kind[] = [];
  const live: Partial<Record<Kind, Entry>> = {};
  let ended = 0;
  const sql = Object.assign(async (strings: TemplateStringsArray): Promise<readonly Row[]> => {
    const kind = classify(strings.join('$'));
    kinds.push(kind);
    const i = seen.get(kind) ?? 0;
    seen.set(kind, i + 1);
    const queue = queued[kind];
    const entry: Entry = live[kind] ?? (queue !== undefined && i < queue.length ? queue[i] : 'default');
    if (entry === 'reject') throw new Error('synthetic statement rejection');
    return entry === 'default' ? GOLDEN[kind] : entry;
  }, { json: (v: unknown) => v });
  const client: SupervisedPgClient = Object.freeze({
    transaction: async <T>(_signal: AbortSignal, _bounds: TransactionBounds, work: (scope: PgTransactionScope) => Promise<T>): Promise<T> =>
      work(sql as unknown as PgTransactionScope),
    end: async (): Promise<void> => { ended++; },
  });
  return { client, kinds, live, ended: () => ended };
}

/** Shut the entry down through its own fake SIGTERM path and wait for the exit callback. */
async function shutDown(emit: (event: string) => void, exits: number[]): Promise<void> {
  emit('SIGTERM');
  for (let i = 0; i < 50 && exits.length === 0; i++) await settle();
}

/** Start over `client` (the golden one unless given) and answer the result; never leaves a listener behind on a refusal. */
async function start(options: { env?: Record<string, string | undefined>; client?: SupervisedPgClient; databaseClient?: () => SupervisedPgClient; log?: string[] } = {}) {
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  const spy = listenSpy();
  const client = options.client ?? fakeClient().client;
  let result: EntryResult;
  try {
    result = await startTenantEntry({
      env: options.env ?? VALID_ENV,
      construction: { databaseClient: options.databaseClient ?? (() => client), listen: () => ({ port: 0, host: '127.0.0.1' }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code), log: { log: (line) => options.log?.push(line) },
    });
  } finally {
    spy.restore();
  }
  return { result, exits, binds: spy.calls(), stop: () => shutDown(emit, exits) };
}

/** A refusal with exactly `failure` and `reasons`: exit 1, no address, never a bind, and the kernel ended once when built. */
async function assertRefused(queued: Partial<Record<Kind, readonly Entry[]>>, failure: string, reasons: readonly string[]): Promise<void> {
  const fake = fakeClient(queued);
  const { result, exits, binds, stop } = await start({ client: fake.client });
  try {
    assert.equal(result.outcome, 'refused', JSON.stringify(result));
    assert.equal(result.failure, failure);
    assert.deepEqual(result.reasons, reasons);
    assert.equal(result.address, null);
    assert.deepEqual(exits, [1]);
    assert.equal(binds, 0, 'a refusal never attempts to bind');
    assert.equal(fake.ended(), 1, 'the kernel is ended');
  } finally {
    if (result.outcome === 'listening') await stop();
  }
}

test('M7TU-08 an invalid construction refuses startup_failed; an invalid configuration refuses config_invalid and never builds a client', async () => {
  const { proc } = fakeProc();
  const exits: number[] = [];
  const invalid = await startTenantEntry({ env: VALID_ENV, construction: { listen: (port: number) => ({ port }) } as never, proc, exit: (code) => exits.push(code) });
  assert.deepEqual([invalid.outcome, invalid.failure, invalid.reasons], ['refused', 'startup_failed', ['construction_invalid']]);
  let built = 0;
  for (const [env, reason] of [
    [{}, 'SESSION_TENANT_ORIGINS:session_tenant_origin_missing'],
    [envWith({ IDEMPOTENCY_KEY: undefined }), 'IDEMPOTENCY_KEY:idempotency_key_missing'],
    [envWith({ IDEMPOTENCY_KEY: ISSUER_KEY }), 'IDEMPOTENCY_KEY:idempotency_key_shared'],
    [envWith({ TENANT_SESSION_ISSUER_KEY: b64(VECTOR) }), 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_weak'],
    [envWith({ SESSION_TENANT_ORIGINS: `https://${ADMIN_HOST}` }), 'SESSION_TENANT_ORIGINS:session_tenant_origin_shares_admin_host'],
  ] as const) {
    const { result, exits: code, binds } = await start({ env, databaseClient: () => { built++; throw new Error('must never be called'); } });
    assert.equal(result.failure, 'config_invalid');
    assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
    assert.deepEqual(code, [1]);
    assert.equal(binds, 0);
  }
  assert.equal(built, 0, 'no configuration refusal builds a database client');
});

test('M7TU-09 the database client: a TLS refusal is database_tls_invalid, a defect is startup_failed, and neither logs its text', async () => {
  const logs: string[] = [];
  const tlsRefused = await start({ databaseClient: () => { throw new DatabaseTlsRefusal('M7TU-DEFECT-TEXT'); }, log: logs });
  assert.deepEqual([tlsRefused.result.failure, tlsRefused.result.reasons], ['database_tls_invalid', ['database_tls_invalid']]);
  const defect = await start({ databaseClient: () => { throw new RangeError('M7TU-DEFECT-TEXT'); }, log: logs });
  assert.deepEqual([defect.result.failure, defect.result.reasons], ['startup_failed', []]);
  assert.ok(!logs.some((l) => l.includes('M7TU-DEFECT-TEXT')), JSON.stringify(logs));
});

test('M7TU-10 connect, the runtime login and the ledger refuse as the administrative entry does', async () => {
  await assertRefused({ connect: ['reject'] }, 'database_unavailable', []);
  await assertRefused({ login: ['reject'] }, 'database_unavailable', ['runtime_login_unanswered']);
  await assertRefused({ login: [[{ ...GOLDEN.login[0], rolsuper: true }]] }, 'database_login_unsafe', ['login_superuser']);
  await assertRefused({ ledgerRows: [GOLDEN.ledgerRows.slice(0, -1)] }, 'migration_state_invalid', ['migration_missing']);
  await assertRefused({ ledgerAccess: ['reject'] }, 'database_unavailable', ['migration_ledger_unanswered']);
});

test('M7TU-11 parameter logging refuses database_logging_unsafe naming each unsafe setting, and an unanswered read is database_unavailable', async () => {
  const cases: Array<[Partial<Row>, string[]]> = [
    [{ on_error: '64B' }, ['log_parameter_max_length_on_error']],
    [{ statement: 'mod' }, ['log_statement']],
    [{ min_sample: '250ms' }, ['log_min_duration_sample']],
    [{ min_duration: '0', max_length: '64B' }, ['log_min_duration_statement']],
    [{ sample_rate: null }, ['log_setting_unreadable']],
    [{ print_plan: 'on' }, ['debug_print_plan']],
    [{ ae_min_duration: '0' }, ['auto_explain_parameters']],
    [{ pga_parameter: 'on', pga_log: 'none' }, ['pgaudit_parameters']],
  ];
  for (const [over, reasons] of cases) await assertRefused({ logging: [[{ ...SAFE_LOGGING, ...over }]] }, 'database_logging_unsafe', reasons);
  await assertRefused({ logging: ['reject'] }, 'database_unavailable', ['parameter_logging_unanswered']);
});

test('M7TU-12 the issuer key must answer match: absent, mismatch, invalid and an unanswered or out-of-set probe each refuse', async () => {
  await assertRefused({ issuerKey: [[{ outcome: 'absent' }]] }, 'tenant_issuer_key_absent', []);
  await assertRefused({ issuerKey: [[{ outcome: 'mismatch' }]] }, 'tenant_issuer_key_mismatch', []);
  await assertRefused({ issuerKey: [[{ outcome: 'invalid' }]] }, 'tenant_issuer_key_probe_malformed', []);
  await assertRefused({ issuerKey: ['reject'] }, 'database_unavailable', ['issuer_key_unanswered']);
  await assertRefused({ issuerKey: [[{ outcome: 'maybe' }]] }, 'database_unavailable', ['issuer_key_unanswered']);
  await assertRefused({ issuerKey: [[{ outcome: 'match' }, { outcome: 'match' }]] }, 'database_unavailable', ['issuer_key_unanswered']);
});

test('M7TU-13 the limiter key refuses as the administrative entry does', async () => {
  await assertRefused({ rateLimitProbe: [[{ outcome: 'key_mismatch' }]] }, 'rate_limit_key_mismatch', []);
  await assertRefused({ rateLimitProbe: [[{ outcome: 'store_read_only' }]] }, 'rate_limit_store_read_only', []);
  await assertRefused({ rateLimitProbe: [[{ outcome: 'consume_unavailable' }]] }, 'rate_limit_store_unavailable', ['consume_unavailable']);
  await assertRefused({ rateLimitProbe: ['reject'] }, 'rate_limit_store_unavailable', []);
});

test('M7TU-14 dependency_unready: the session store, the session mint, the tenant admission, the limiter, the customer reads and the two command ports, each alone', async () => {
  const sessionRow = { audience: 'tenant', authProvider: 'firebase', authProviderUid: 'probe-uid', principalKey: 'probe-principal',
    securityVersion: 'v1', authenticatedAt: null, createdAt: 1_000, lastSeenAt: 1_000, validatedAt: 1_000 };
  await assertRefused({ sessionGet: [[sessionRow]] }, 'dependency_unready', ['session_store']);
  await assertRefused({ sessionGet: ['reject'] }, 'dependency_unready', ['session_store']);
  await assertRefused({ sessionMint: [[{ outcome: 'refused' }]] }, 'dependency_unready', ['session_mint']);
  await assertRefused({ sessionMint: [[{ outcome: 'created' }]] }, 'dependency_unready', ['session_mint']);
  await assertRefused({ sessionMint: ['reject'] }, 'dependency_unready', ['session_mint']);
  await assertRefused({ tenantAdmissionProbe: [[{ outcome: 'unavailable' }]] }, 'dependency_unready', ['tenant_admission']);
  await assertRefused({ tenantAdmissionProbe: ['reject'] }, 'dependency_unready', ['tenant_admission']);
  await assertRefused({ rateLimitProbe: ['default', [{ outcome: 'key_mismatch' }]] }, 'dependency_unready', ['rate_limiter']);
  await assertRefused({ customerProbe: [[GOLDEN.customerProbe[0], GOLDEN.customerProbe[0]]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerProbe: ['reject'] }, 'dependency_unready', ['customer_directory']);
  // M7A-CUSTOMERS-P4: the detail routine is the second half of the same reads probe.
  await assertRefused({ customerDetailProbe: [[{ o_outcome: 'not_found', o_tenant_id: null, o_customer_id: null, o_name: null }]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerDetailProbe: [[]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerDetailProbe: ['reject'] }, 'dependency_unready', ['customer_directory']);
  // M7A-CUSTOMERS-P6: the profile routine is the third part of the same reads probe.
  await assertRefused({ customerProfileProbe: [[{ ...GOLDEN.customerProfileProbe[0], o_outcome: 'not_found' }]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerProfileProbe: [[GOLDEN.customerDetailProbe[0]]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerProfileProbe: [[]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerProfileProbe: ['reject'] }, 'dependency_unready', ['customer_directory']);
  // M7A-CUSTOMERS-P8: the name search routine is the fourth part of the same reads probe.
  await assertRefused({ customerSearchProbe: [[{ ...GOLDEN.customerSearchProbe[0], o_outcome: 'invalid' }]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerSearchProbe: [[]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ customerSearchProbe: ['reject'] }, 'dependency_unready', ['customer_directory']);
  // M7B-INVOICES-P1: the store directory routine is the fifth part of the same reads probe.
  await assertRefused({ storeDirectoryProbe: [[{ ...GOLDEN.storeDirectoryProbe[0], o_outcome: 'invalid' }]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ storeDirectoryProbe: [[GOLDEN.customerSearchProbe[0]]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ storeDirectoryProbe: [[]] }, 'dependency_unready', ['customer_directory']);
  await assertRefused({ storeDirectoryProbe: ['reject'] }, 'dependency_unready', ['customer_directory']);
  // M7A-CUSTOMERS-P3: the idempotency store is asked first, then the command port; both are 006's probe.
  await assertRefused({ storeProbe: [[{ ok: false }]] }, 'dependency_unready', ['idempotency_store']);
  await assertRefused({ storeProbe: ['reject'] }, 'dependency_unready', ['idempotency_store']);
  await assertRefused({ storeProbe: ['default', [{ ok: false }]] }, 'dependency_unready', ['command_transactions']);
  await assertRefused({ storeProbe: ['default', 'reject'] }, 'dependency_unready', ['command_transactions']);
});

test('M7TU-15 the golden path listens on exactly the tenant inventory, in the startup order: ledger, logging, issuer key, limiter key, readiness', async () => {
  const fake = fakeClient();
  const { result, exits, binds, stop } = await start({ client: fake.client });
  try {
    assert.equal(result.outcome, 'listening', JSON.stringify(result));
    assert.ok(result.address !== null);
    assert.deepEqual(canonical(result.routes), canonical(TENANT_SHIPPING_ROUTES));
    assert.equal(binds, 1, 'binds exactly once');
    const steps = fake.kinds.filter((k, i, all) => i === 0 || all[i - 1] !== k);
    assert.deepEqual(steps, ['connect', 'login', 'memberships', 'reached', 'owned', 'grants', 'database', 'exposure', 'ledgerAccess', 'ledgerRows',
      'logging', 'issuerKey', 'rateLimitProbe', 'sessionGet', 'sessionMint', 'tenantAdmissionProbe', 'rateLimitProbe', 'customerProbe', 'customerDetailProbe',
      'customerProfileProbe', 'customerSearchProbe', 'storeDirectoryProbe', 'storeProbe'],
    'nothing is asked of the issuer key before the ledger and the logging guard, nor of the limiter before the issuer key');
  } finally {
    await stop();
  }
  assert.deepEqual(exits, [0]);
  assert.equal(fake.ended(), 1, 'shutdown ends the kernel');
});

interface Reply { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: string }

const DETAIL_ID = '0f8e2a4c-9b1d-4e3f-8a2b-6c7d8e9f0a1b';

/** One request on its own connection, with an explicit Host; bounded. */
function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, headers: res.headers, body }); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('send: bounded timeout exceeded')); }, 5_000);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

test('M7TU-16 the host lock: the customer route and the login answer the bounded 404 on the admin and an unknown host, and reach the chain on the tenant host', async () => {
  const { result, stop } = await start();
  try {
    assert.equal(result.outcome, 'listening');
    const port = (result.address as { port: number }).port;
    for (const host of [ADMIN_HOST, 'unknown.tmpos.test', `${TENANT_HOST}.evil.test`, '127.0.0.1', `${TENANT_HOST}:443`]) {
      for (const [method, path] of [['GET', '/api/v1/customers'], ['GET', `/api/v1/customers/${DETAIL_ID}`], ['GET', '/api/v1/customers/NOT-AN-ID'], ['GET', `/api/v1/customers/${DETAIL_ID}/profile`], ['POST', '/api/v1/customers'], ['POST', '/api/v1/session/login'], ['GET', '/admin/v1/tenants'], ['GET', '/api/v1/stores']]) {
        const reply = await send(port, method, path, { host, origin: `https://${TENANT_HOST}` });
        assert.equal(reply.status, 404, `${method} ${path} on ${host}`);
        assert.equal(JSON.parse(reply.body).error, 'not_found');
        assert.equal(reply.headers['set-cookie'], undefined, 'no cookie');
        assert.match(String(reply.headers['strict-transport-security']), /max-age=/, 'HSTS on every response');
      }
    }
    // A forwarded Host is never read.
    assert.equal((await send(port, 'GET', '/api/v1/customers', { host: ADMIN_HOST, 'x-forwarded-host': TENANT_HOST })).status, 404);
    // On the tenant host the route reaches the chain: no session is a 401, and an administrative cookie is no tenant session.
    const tenant = await send(port, 'GET', '/api/v1/customers', { host: TENANT_HOST });
    assert.equal(tenant.status, 401);
    const adminCookie = await send(port, 'GET', '/api/v1/customers', { host: TENANT_HOST, cookie: `__Host-tmpos_admin_session=${'a'.repeat(43)}` });
    assert.equal(adminCookie.status, 401);
    // M7A-CUSTOMERS-P4: the detail template reaches the chain for any one segment — a 401 before the id is judged.
    for (const segment of [DETAIL_ID, 'NOT-AN-ID', '{id}']) {
      assert.equal((await send(port, 'GET', `/api/v1/customers/${segment}`, { host: TENANT_HOST })).status, 401, segment);
    }
    assert.equal((await send(port, 'GET', `/api/v1/customers/${DETAIL_ID}/`, { host: TENANT_HOST })).status, 404, 'a trailing slash is no route');
    // M7A-CUSTOMERS-P6: the profile template the same way — a 401 for any id segment, and nothing past its one suffix.
    for (const segment of [DETAIL_ID, 'NOT-AN-ID', '{id}']) {
      assert.equal((await send(port, 'GET', `/api/v1/customers/${segment}/profile`, { host: TENANT_HOST })).status, 401, `${segment}/profile`);
    }
    for (const path of [`/api/v1/customers/${DETAIL_ID}/profile/`, `/api/v1/customers/${DETAIL_ID}/profile/x`, `/api/v1/customers/${DETAIL_ID}/contacts`]) {
      assert.equal((await send(port, 'GET', path, { host: TENANT_HOST })).status, 404, path);
    }
    assert.equal((await send(port, 'GET', '/admin/v1/tenants', { host: TENANT_HOST })).status, 404, 'no administrative route on the tenant host');
    // M7B-INVOICES-P1: the store directory reaches the chain on the tenant host (no session: 401); no store template is served.
    assert.equal((await send(port, 'GET', '/api/v1/stores', { host: TENANT_HOST })).status, 401);
    assert.equal((await send(port, 'GET', `/api/v1/stores/${DETAIL_ID}/invoice-drafts`, { host: TENANT_HOST })).status, 404, 'no draft route in commit A');
    // The probes answer on any host.
    for (const host of [TENANT_HOST, ADMIN_HOST]) assert.equal((await send(port, 'GET', '/health', { host })).status, 200);
  } finally {
    await stop();
  }
});

test('M7TU-17 after listening, readiness is 503 once any one dependency turns bad and 200 again when it recovers, each shared per window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fake = fakeClient();
  const { result, stop } = await start({ client: fake.client });
  try {
    assert.equal(result.outcome, 'listening');
    const port = (result.address as { port: number }).port;
    const ready = async (): Promise<number> => (await send(port, 'GET', '/readiness', { host: TENANT_HOST })).status;
    assert.equal(await ready(), 200);
    const transitions: Array<[string, Kind, Entry]> = [
      ['the issuer key rotated', 'issuerKey', [{ outcome: 'mismatch' }]],
      ['the issuer key deleted', 'issuerKey', [{ outcome: 'absent' }]],
      ['unsafe logging after a reload', 'logging', [{ ...SAFE_LOGGING, on_error: '64B' }]],
      ['the session read fails', 'sessionGet', 'reject'],
      ['the session read answers a row for the probe key', 'sessionGet', [{ audience: 'tenant' }]],
      ['the session mint withdrawn', 'sessionMint', 'reject'],
      ['the session mint answers another word', 'sessionMint', [{ outcome: 'refused' }]],
      ['the customer probe answers two rows', 'customerProbe', [GOLDEN.customerProbe[0], GOLDEN.customerProbe[0]]],
      ['the customer detail probe fails', 'customerDetailProbe', 'reject'],
      ['the customer profile probe fails', 'customerProfileProbe', 'reject'],
      ['the customer search probe fails', 'customerSearchProbe', 'reject'],
      ['the store directory probe fails', 'storeDirectoryProbe', 'reject'],
      ['the idempotency store and command port probe fails', 'storeProbe', 'reject'],
      ['the store probe answers false', 'storeProbe', [{ ok: false }]],
      ['the tenant admission fails', 'tenantAdmissionProbe', 'reject'],
      ['the tenant admission answers unavailable', 'tenantAdmissionProbe', [{ outcome: 'unavailable' }]],
      ['the limiter key rotated', 'rateLimitProbe', [{ outcome: 'key_mismatch' }]],
      ['the limiter probe fails', 'rateLimitProbe', 'reject'],
      ['the database is down for everything', 'connect', 'default'],
    ];
    for (const [label, kind, entry] of transitions) {
      if (kind === 'connect') for (const k of ['issuerKey', 'logging', 'sessionGet', 'sessionMint', 'customerProbe', 'customerDetailProbe', 'customerProfileProbe', 'customerSearchProbe', 'storeDirectoryProbe', 'tenantAdmissionProbe', 'rateLimitProbe', 'storeProbe'] as const) fake.live[k] = 'reject';
      else fake.live[kind] = entry;
      t.mock.timers.tick(1_000);
      assert.equal(await ready(), 503, label);
      for (const k of Object.keys(fake.live) as Kind[]) delete fake.live[k];
      t.mock.timers.tick(1_000);
      assert.equal(await ready(), 200, `${label}: recovered`);
    }
    // Inside one window, a flood of readiness requests asks each dependency once.
    t.mock.timers.tick(1_000);
    const before = fake.kinds.length;
    await Promise.all(Array.from({ length: 5 }, () => ready()));
    const asked = fake.kinds.slice(before);
    for (const k of ['issuerKey', 'logging', 'sessionGet', 'sessionMint', 'customerProbe', 'customerDetailProbe', 'customerProfileProbe', 'customerSearchProbe', 'storeDirectoryProbe', 'tenantAdmissionProbe', 'rateLimitProbe'] as const) {
      assert.equal(asked.filter((x) => x === k).length, 1, `${k}: once per window`);
    }
    assert.equal(asked.filter((x) => x === 'storeProbe').length, 2, 'the idempotency store and the command port: once each per window');
  } finally {
    await stop();
  }
});

test('M7TU-18 a signal during preflight interrupts: exit 0, never listens, and the kernel is ended', async () => {
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  let ended = 0;
  const client: SupervisedPgClient = {
    transaction: (signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }),
    end: async () => { ended++; },
  };
  const spy = listenSpy();
  try {
    const pending = startTenantEntry({
      env: VALID_ENV, construction: { databaseClient: () => client, listen: (port) => ({ port }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    await settle();
    emit('SIGTERM');
    const result = await pending;
    assert.equal(result.outcome, 'interrupted');
    assert.deepEqual(exits, [0]);
    assert.equal(ended, 1);
    assert.equal(spy.calls(), 0);
  } finally {
    spy.restore();
  }
});

test('M7TU-19 the listen step is bounded: a bind that never settles refuses listen_failed with reason listen_timeout', async (t) => {
  const originalListen = net.Server.prototype.listen;
  let listenCalled: () => void = () => undefined;
  const listenGate = new Promise<void>((resolve) => { listenCalled = resolve; });
  (net.Server.prototype as unknown as { listen: (...args: unknown[]) => unknown }).listen = function patchedListen(this: unknown) {
    listenCalled();
    return this;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { proc, emit } = fakeProc();
  const exits: number[] = [];
  try {
    const pending = startTenantEntry({
      env: VALID_ENV,
      construction: { databaseClient: () => fakeClient().client, listen: () => ({ port: 0, host: '127.0.0.1' }), tokenVerifier: SYNTHETIC_VERIFIER },
      proc, exit: (code) => exits.push(code),
    });
    await listenGate;
    t.mock.timers.tick(STARTUP_STEP_DEADLINE_MS);
    const result = await pending;
    assert.deepEqual([result.outcome, result.failure, result.reasons, result.address], ['refused', 'listen_failed', ['listen_timeout'], null]);
  } finally {
    net.Server.prototype.listen = originalListen;
    t.mock.timers.reset();
    await shutDown(emit, exits);
  }
});

test('M7TU-20 no captured log line, across refusals and a listening run, carries a configuration value or the issuer key', async () => {
  const marker = randomBytes(16).toString('hex');
  const logs: string[] = [];
  await start({ env: envWith({ SESSION_TENANT_ORIGINS: `https://${marker}.invalid/`, APP_DATABASE_URL: undefined }), log: logs });
  await start({ client: fakeClient({ connect: ['reject'] }).client, log: logs });
  await start({ client: fakeClient({ issuerKey: [[{ outcome: 'mismatch' }]] }).client, log: logs });
  const listening = await start({ log: logs });
  await listening.stop();
  assert.ok(logs.length > 0);
  const all = logs.join('\n');
  for (const secret of [marker, ISSUER_KEY, Buffer.from(ISSUER_KEY, 'base64url').toString('hex'), RATE_LIMIT_KEY, IDEMPOTENCY_KEY, 'synthetic-pw']) {
    assert.ok(!all.includes(secret), 'no configuration value or key in any log line');
  }
});
