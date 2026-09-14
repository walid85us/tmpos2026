// Phase 4.0 M4 — the provider-aware production composition root for the two session boundaries.
//
// Synthetic configuration only: no secret is read, no provider is contacted (the identity
// verifier initialises lazily, and no login reaches it here). The suite pins that production
// composition refuses, naming every missing dependency, while any production adapter is absent;
// that the origin topology is exact, https and host-distinct per boundary; that the root takes
// configuration only, so no test double can be handed to it; and that, with every adapter
// present, assembly is all or nothing and yields boundaries the runtime serves end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ProductionCompositionError, assembleSessions, composeProductionSessions } from './productionSessions.js';
import type { SessionParts } from './productionSessions.js';
import { createApp, createBoundedServer, createReadinessState } from '../runtime/app.js';
import type { BearerTokenView } from '../runtime/access.js';
import { createMemorySessionStore } from '../runtime/memorySessionStore.testkit.js';
import { createMemoryRateLimiter, testRequestLimits } from '../runtime/rateLimiter.testkit.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyStore } from '../runtime/idempotencyStore.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../runtime/requestSecurity.js';
import { sessionPaths } from '../runtime/routes.js';
import type { SessionAudience } from '../runtime/routes.js';

// A freshly generated key (never a real credential), so composition's local key check passes.
const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA = JSON.stringify({
  type: 'service_account', project_id: 'demo-synthetic', client_email: 'verifier@demo-synthetic.test', private_key: PEM,
});
const TOPOLOGY = { SESSION_TENANT_ORIGINS: 'https://pos.example.test', SESSION_ADMIN_ORIGINS: 'https://admin.example.test' };
// A synthetic key (32 bytes of 0x07) and a documentation-range proxy: never a deployment's.
const KEY = Buffer.alloc(32, 7).toString('base64url');
const LIMITS_CONFIG = { TRUSTED_PROXY_CIDRS: '203.0.113.0/24', RATE_LIMIT_KEY: KEY };
const CONFIGURED = { ...TOPOLOGY, ...LIMITS_CONFIG, FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: SA };
// No distributed limiter adapter is approved: composition names it before the session adapters.
const LIMITER = 'rate_limit_store_unavailable';
const ADAPTER_BLOCKERS = [
  'tenant_session_store_unavailable', 'tenant_admission_unavailable', 'tenant_authorizer_unavailable',
  'admin_session_store_unavailable', 'admin_admission_unavailable', 'admin_authorizer_unavailable',
];

function blockersOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    composeProductionSessions(env);
  } catch (err) {
    if (err instanceof ProductionCompositionError) return err.blockers;
    throw err;
  }
  return assert.fail('production composition must refuse');
}

test('production composition refuses while any production adapter is missing, naming every one', () => {
  assert.deepEqual(blockersOf(CONFIGURED), [LIMITER, ...ADAPTER_BLOCKERS], 'configured today: exactly the adapters that do not exist yet');
  assert.deepEqual(blockersOf({}), [
    'session_origins_missing', 'identity_verifier_unconfigured', 'trusted_proxies_missing', 'rate_limit_key_missing', LIMITER, ...ADAPTER_BLOCKERS,
  ]);
  assert.deepEqual(blockersOf({ ...TOPOLOGY, ...LIMITS_CONFIG, FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: '{"type":"authorized_user"}' }),
    ['identity_verifier_unconfigured', LIMITER, ...ADAPTER_BLOCKERS]);
  const truncated = JSON.stringify({ ...(JSON.parse(SA) as object), private_key: '-----BEGIN PRIVATE KEY-----\nMIGHAgEA' });
  assert.deepEqual(blockersOf({ ...TOPOLOGY, ...LIMITS_CONFIG, FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: truncated }),
    ['identity_verifier_unconfigured', LIMITER, ...ADAPTER_BLOCKERS], 'a key that does not parse refuses composition');
});

test('the production origin topology is exact, https and host-distinct per boundary', () => {
  const first = (tenant: string | undefined, admin: string | undefined): string =>
    blockersOf({ SESSION_TENANT_ORIGINS: tenant, SESSION_ADMIN_ORIGINS: admin, FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: SA, ...LIMITS_CONFIG })[0];
  const accepted = LIMITER;
  assert.equal(first('https://pos.example.test', 'https://admin.example.test'), accepted, 'distinct hosts');
  assert.equal(first('https://pos.example.test,https://till.example.test', 'https://admin.example.test'), accepted, 'several exact origins');
  assert.equal(first('https://pos.example.test', 'https://admin.pos.example.test'), accepted, 'a dedicated admin subdomain');
  for (const [tenant, admin] of [[undefined, TOPOLOGY.SESSION_ADMIN_ORIGINS], ['', TOPOLOGY.SESSION_ADMIN_ORIGINS], [TOPOLOGY.SESSION_TENANT_ORIGINS, undefined]]) {
    assert.equal(first(tenant, admin), 'session_origins_missing', `${String(tenant)} / ${String(admin)}`);
  }
  for (const bad of [
    'http://pos.example.test', 'https://pos.example.test/', 'https://pos.example.test/app', ' https://pos.example.test',
    'https://pos.example.test,', 'https://pos.example.test, https://till.example.test', '*', 'https://*.example.test',
    'HTTPS://POS.EXAMPLE.TEST', 'https://pos.example.test:443', 'pos.example.test',
  ]) {
    assert.equal(first(bad, TOPOLOGY.SESSION_ADMIN_ORIGINS), 'session_origins_invalid', bad);
  }
  for (const [tenant, admin, label] of [
    ['https://pos.example.test', 'https://pos.example.test', 'one origin for both boundaries'],
    ['https://pos.example.test', 'https://pos.example.test:8443', 'one host on two ports (cookies ignore ports)'],
    ['https://pos.example.test', 'https://pos.example.test.', 'one host spelled with a trailing dot'],
    ['https://pos.example.test,https://admin.example.test', 'https://admin.example.test', 'an origin in both lists'],
    ['https://pos.example.test,https://pos.example.test', 'https://admin.example.test', 'a duplicated origin'],
  ]) {
    assert.equal(first(tenant, admin), 'session_origins_ambiguous', label);
  }
});

test('a refusal carries bounded codes only, never configuration content', () => {
  try {
    composeProductionSessions({
      SESSION_TENANT_ORIGINS: 'https://secret-host.test', SESSION_ADMIN_ORIGINS: 'https://secret-host.test',
      FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: '{"type":"service_account","private_key":"secret-key-material"}',
      TRUSTED_PROXY_CIDRS: 'secret-proxy.test/8', RATE_LIMIT_KEY: 'secret-rate-limit-key-material',
    });
    assert.fail('composition must refuse');
  } catch (err) {
    assert.ok(err instanceof ProductionCompositionError);
    assert.ok(!err.message.includes('secret'), 'no configuration value in the message');
    assert.match(err.message, /^production session composition refused: [a-z_,]+$/);
  }
});

test('the production root takes configuration only: no adapter, store or test double can be handed to it', () => {
  assert.equal(composeProductionSessions.length, 1, 'one parameter: the configuration');
  const store = createMemorySessionStore();
  const limiter = createMemoryRateLimiter();
  const smuggled = {
    ...CONFIGURED, store, sessionStore: store, admission: { admit: () => true }, limiter, rateLimiter: limiter,
  } as unknown as Record<string, string>;
  assert.deepEqual(blockersOf(smuggled), [LIMITER, ...ADAPTER_BLOCKERS], 'an extra value in the configuration composes nothing');
});

test('the request limits are explicit configuration: exact trusted proxies, a canonical key, an approved limiter', () => {
  const blockers = (over: Record<string, string | undefined>): readonly string[] => blockersOf({ ...CONFIGURED, ...over });
  for (const cidrs of ['none', '10.0.0.0/8,2001:db8::/32', '203.0.113.7/32']) {
    assert.deepEqual(blockers({ TRUSTED_PROXY_CIDRS: cidrs }), [LIMITER, ...ADAPTER_BLOCKERS], cidrs);
  }
  for (const missing of [undefined, '']) assert.equal(blockers({ TRUSTED_PROXY_CIDRS: missing })[0], 'trusted_proxies_missing', String(missing));
  assert.equal(blockers({ TRUSTED_PROXY_CIDRS: 'none', NODE_ENV: 'production' })[0], 'trusted_proxies_missing', 'production always names its proxies');
  for (const bad of ['0.0.0.0/0', '::/0', '10.0.0.1/8', '10.0.0.0/8, 192.0.2.0/24', '10.0.0.0/8,', 'proxy.example.test/32', 'NONE']) {
    assert.equal(blockers({ TRUSTED_PROXY_CIDRS: bad })[0], 'trusted_proxies_invalid', bad);
  }
  for (const missing of [undefined, '']) assert.equal(blockers({ RATE_LIMIT_KEY: missing })[0], 'rate_limit_key_missing', String(missing));
  for (const bad of ['short', KEY.slice(0, 42), `${KEY}=`, `${KEY.slice(0, 42)}d`, Buffer.alloc(31, 7).toString('base64url'), Buffer.alloc(32, 7).toString('base64')]) {
    assert.equal(blockers({ RATE_LIMIT_KEY: bad })[0], 'rate_limit_key_invalid', bad);
  }
});

// --- assembly, with every adapter supplied (test doubles here; approved adapters in production) ---

const T0 = 1_700_000_000_000;
const ORIGINS: Record<SessionAudience, string> = { tenant: 'http://pos.trusted.test', admin: 'http://admin.trusted.test' };

function parts(): SessionParts {
  const admitted = { admitted: true, securityVersion: 'v1' };
  return {
    origins: { tenant: [ORIGINS.tenant], admin: [ORIGINS.admin] },
    verifier: {
      async verify(tokenView: BearerTokenView): Promise<unknown> {
        return tokenView.bearerToken === 'tok-owner'
          ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-owner', authenticatedAt: T0 - 60_000, secondFactor: 'totp' }
          : null;
      },
    },
    store: { tenant: createMemorySessionStore(), admin: createMemorySessionStore() },
    admission: { tenant: { admit: () => admitted }, admin: { admit: () => admitted } },
    authorizer: { tenant: { authorize: () => true }, admin: { authorize: () => true } },
    ...testRequestLimits(),
    idempotencyKey: null,
    idempotencyStore: null,
  };
}

// A synthetic idempotency key (32 bytes of 0x09): never a deployment's, and never the limiter key above.
const IDEM_KEY = Buffer.alloc(32, 9).toString('base64url');

test('idempotency is composed only when IDEMPOTENCY_KEY is configured, and then needs a valid, separate key and an approved store', () => {
  const blockers = (over: Record<string, string | undefined>): readonly string[] => blockersOf({ ...CONFIGURED, ...over });
  for (const unset of [undefined, '']) {
    assert.deepEqual(blockers({ IDEMPOTENCY_KEY: unset }), [LIMITER, ...ADAPTER_BLOCKERS], 'not configured: nothing about idempotency blocks');
  }
  assert.deepEqual(blockers({ IDEMPOTENCY_KEY: IDEM_KEY }), [LIMITER, 'idempotency_store_unavailable', ...ADAPTER_BLOCKERS],
    'configured: no durable store is approved, and nothing stands in for one');
  for (const bad of ['short', IDEM_KEY.slice(0, 42), `${IDEM_KEY}=`, Buffer.alloc(31, 9).toString('base64url'), Buffer.alloc(32, 9).toString('base64')]) {
    assert.deepEqual(blockers({ IDEMPOTENCY_KEY: bad }), [LIMITER, 'idempotency_key_invalid', 'idempotency_store_unavailable', ...ADAPTER_BLOCKERS], bad);
  }
  assert.deepEqual(blockers({ IDEMPOTENCY_KEY: KEY }), [LIMITER, 'idempotency_key_shared', 'idempotency_store_unavailable', ...ADAPTER_BLOCKERS],
    'the limiter key is never the idempotency key');
  // HMAC zero-pads a short key, so the limiter key followed by zero bytes is the same key.
  const padded = Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(32, 0)]).toString('base64url');
  assert.deepEqual(blockers({ IDEMPOTENCY_KEY: padded }), [LIMITER, 'idempotency_key_shared', 'idempotency_store_unavailable', ...ADAPTER_BLOCKERS],
    'nor the limiter key padded with zero bytes');
  const smuggled = { ...CONFIGURED, IDEMPOTENCY_KEY: IDEM_KEY, idempotencyStore: createMemoryIdempotencyStore() } as unknown as Record<string, string>;
  assert.deepEqual(blockersOf(smuggled), [LIMITER, 'idempotency_store_unavailable', ...ADAPTER_BLOCKERS], 'no store can be handed to the root');
  const full = parts();
  const refused = (p: SessionParts): readonly string[] => {
    try {
      assembleSessions(p);
    } catch (err) {
      if (err instanceof ProductionCompositionError) return err.blockers;
      throw err;
    }
    return assert.fail('assembly must refuse');
  };
  assert.deepEqual(refused({ ...full, idempotencyKey: TEST_IDEMPOTENCY_KEY }), ['idempotency_store_unavailable'], 'no per-process store stands in');
  const assembled = assembleSessions({ ...full, idempotencyKey: TEST_IDEMPOTENCY_KEY, idempotencyStore: createMemoryIdempotencyStore() });
  assert.ok(assembled.idempotency !== null && Object.isFrozen(assembled.idempotency));
  assert.equal(assembleSessions(full).idempotency, null, 'not configured: not composed');
});

test('assembly is all or nothing: a missing part names its dependency and composes no boundary', () => {
  const refused = (p: SessionParts): readonly string[] => {
    try {
      assembleSessions(p);
    } catch (err) {
      if (err instanceof ProductionCompositionError) return err.blockers;
      throw err;
    }
    return assert.fail('assembly must refuse');
  };
  const full = parts();
  assert.deepEqual(refused({ ...full, origins: 'session_origins_ambiguous' }), ['session_origins_ambiguous']);
  assert.deepEqual(refused({ ...full, verifier: null }), ['identity_verifier_unconfigured']);
  assert.deepEqual(refused({ ...full, store: { ...full.store, admin: null } }), ['admin_session_store_unavailable']);
  assert.deepEqual(refused({ ...full, admission: { ...full.admission, admin: null } }), ['admin_admission_unavailable']);
  assert.deepEqual(refused({ ...full, authorizer: { ...full.authorizer, tenant: null } }), ['tenant_authorizer_unavailable']);
  assert.deepEqual(refused({ ...full, limiter: null }), [LIMITER], 'no per-process limiter stands in for a missing one');
  assert.deepEqual(refused({ ...full, trustedProxies: 'trusted_proxies_invalid' }), ['trusted_proxies_invalid']);
  assert.deepEqual(refused({ ...full, keySecret: 'rate_limit_key_missing' }), ['rate_limit_key_missing']);
});

test('with every adapter present, both boundaries are assembled through the runtime ports and serve a login end to end', async () => {
  const { sessions, limits } = assembleSessions(parts());
  assert.deepEqual(Object.keys(sessions).sort(), ['admin', 'tenant']);
  assert.ok(Object.isFrozen(sessions) && Object.isFrozen(limits));
  const readiness = createReadinessState();
  readiness.setReady();
  const server = createBoundedServer(createApp({ readiness, now: () => T0, log: { log: () => {} }, sessions, limits }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    for (const audience of ['tenant', 'admin'] as const) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST', path: sessionPaths(audience).login, agent: false,
          headers: {
            origin: ORIGINS[audience], 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
            authorization: 'Bearer tok-owner', 'content-length': '0',
          },
        }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 200, `${audience} login through the assembled boundary`);
    }
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
