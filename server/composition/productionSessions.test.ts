// Phase 4.0 M4 — the provider-aware production composition root for the two session boundaries.
//
// Synthetic configuration only: no secret is read, no provider is contacted (the identity
// verifier initialises lazily, and no login reaches it here). The suite pins that production
// composition refuses, naming every missing dependency, while any production adapter is absent;
// that the origin topology is exact, https and host-distinct per boundary; that configuration alone
// composes no adapter, while the transaction root's durable bundle fills the tenant slots, one store for
// both boundaries and — only when it carries the platform admission (M5-GIAM-D1-P4) — the administrative
// boundary's admission and authorizer together, leaving the rate limiter the one blocker; and that, with every adapter
// present, assembly is all or nothing and yields boundaries the runtime serves end to end. Durable
// idempotency is the transaction root's (productionTransactions.test.ts), never this one's.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ProductionCompositionError, assembleSessions, composeProductionSessions, durableSessionAdapters } from './productionSessions.js';
import type { SessionParts } from './productionSessions.js';
import { createApp, createBoundedServer, createReadinessState } from '../runtime/app.js';
import type { BearerTokenView } from '../runtime/access.js';
import { createMemorySessionStore } from '../runtime/memorySessionStore.testkit.js';
import { createMemoryRateLimiter, testRequestLimits } from '../runtime/rateLimiter.testkit.js';
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

test('configuration alone composes no adapter, and none can be smuggled in through the configuration', () => {
  // TWO parameters since M5-GIAM-D1-P2-R1: the second is the durable adapter bundle the TRANSACTION
  // root builds over its own classified endpoint (productionTransactions.ts). It is a typed input, not
  // an opaque capability, so this test no longer claims no adapter can be handed over — the next one
  // proves what the bundle fills. This root still reads no connection string and constructs no client,
  // and called with the configuration ALONE it composes nothing and names every adapter it lacks.
  assert.equal(composeProductionSessions.length, 1, 'the durable adapters are optional: configuration alone is a complete call');
  const store = createMemorySessionStore();
  const limiter = createMemoryRateLimiter();
  const smuggled = {
    ...CONFIGURED, store, sessionStore: store, admission: { admit: () => true }, limiter, rateLimiter: limiter,
    platformAdmission: { admit: () => ({ outcome: 'refused' }), probe: () => true }, adminAuthorizer: { authorize: () => true },
  } as unknown as Record<string, string>;
  assert.deepEqual(blockersOf(smuggled), [LIMITER, ...ADAPTER_BLOCKERS], 'an extra value in the configuration composes nothing');
});

// A synthetic administrative admission port (migration 013's shape): one System Owner grant on an active account at
// platform authority version 1, counting every read. Nothing here is a deployment's.
const PLATFORM_ACTOR = '11111111-1111-4111-8111-111111111111';
const PLATFORM_GRANT = '66666666-6666-4666-8666-666666666666';
function platformPort(): { admit: () => unknown; probe: () => unknown; reads: number } {
  const port = {
    reads: 0,
    admit: () => {
      port.reads++;
      return {
        outcome: 'resolved', authorityVersion: '1',
        principal: {
          actor: PLATFORM_ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: 'sv-1',
          memberships: [{ membershipId: PLATFORM_GRANT, scopeType: 'platform', tenant: null, store: null, roleId: 'system_owner', tenantStatus: null, storeStatus: null }],
        },
      };
    },
    probe: () => true,
  };
  return port;
}

test('the durable bundle fills the tenant slots and ONE store for both boundaries, and the admin slots only from the platform admission', () => {
  const store = createMemorySessionStore();
  const tenantAdmission = { admit: () => ({ outcome: 'refused' }), probe: () => true };
  const blockersWith = (durable: Parameters<typeof composeProductionSessions>[1]): readonly string[] => {
    try {
      composeProductionSessions(CONFIGURED, durable);
    } catch (err) {
      if (err instanceof ProductionCompositionError) return err.blockers;
      throw err;
    }
    return assert.fail('production composition must still refuse: no distributed rate limiter is approved');
  };
  // Without the platform admission the bundle removes the three tenant blockers AND the admin store's: one store
  // serves both boundaries (DA-37). The admin boundary's admission and authorizer stay named, both of them.
  assert.deepEqual(blockersWith({ store, tenantAdmission }),
    [LIMITER, 'admin_admission_unavailable', 'admin_authorizer_unavailable']);
  // M5-GIAM-D1-P4: the platform admission the transaction root builds (migration 013) fills BOTH admin slots, and
  // what remains is exactly the one slot no adapter can fill yet — the distributed limiter.
  assert.deepEqual(blockersWith({ store, tenantAdmission, platformAdmission: platformPort() }), [LIMITER]);
  // The removed P1 slot is no way in: an authorizer handed over on its own fills nothing, whatever it answers.
  assert.deepEqual(blockersWith({ store, tenantAdmission, adminAuthorizer: { authorize: () => true } } as never),
    [LIMITER, 'admin_admission_unavailable', 'admin_authorizer_unavailable']);
  // A malformed bundle is refused when the adapters are built, not at the first request: the tenant ones ...
  assert.throws(() => composeProductionSessions(CONFIGURED, { store, tenantAdmission: {} as never }), TypeError);
  assert.throws(() => composeProductionSessions(CONFIGURED, { store, tenantAdmission, tenantReads: ['GET /x'] as never }), TypeError);
  // ... and a platform admission that is not a whole port — admit AND probe — never becomes a boundary.
  const admit = () => ({ outcome: 'refused' });
  const probe = () => true;
  for (const platformAdmission of [null, 'port', {}, { admit }, { probe }, { admit: 'admit', probe }, { admit, probe: true }]) {
    assert.throws(() => composeProductionSessions(CONFIGURED, { store, tenantAdmission, platformAdmission: platformAdmission as never }), TypeError,
      JSON.stringify(platformAdmission));
  }
});

test('durableSessionAdapters fills the admin admission and authorizer only together, from the platform admission, and never a limiter', async () => {
  const store = createMemorySessionStore();
  const tenantAdmission = { admit: () => ({ outcome: 'refused' }), probe: () => true };
  const without = durableSessionAdapters({ store, tenantAdmission });
  assert.deepEqual({ admission: without.admission.admin, authorizer: without.authorizer.admin, limiter: without.limiter },
    { admission: null, authorizer: null, limiter: null }, 'no platform admission: neither admin slot, and no limiter');
  const port = platformPort();
  const adapters = durableSessionAdapters({ store, tenantAdmission, platformAdmission: port });
  for (const table of [without, adapters]) {
    assert.equal(table.store.tenant, store, 'the one store ...');
    assert.equal(table.store.admin, store, '... serves both boundaries');
    assert.ok(table.admission.tenant !== null && table.authorizer.tenant !== null, 'the tenant slots, from the tenant admission');
    assert.equal(table.limiter, null, 'the limiter is never among the durable adapters');
    assert.ok(Object.isFrozen(table) && Object.isFrozen(table.store) && Object.isFrozen(table.admission) && Object.isFrozen(table.authorizer));
  }
  const admission = adapters.admission.admin;
  const authorizer = adapters.authorizer.admin;
  assert.ok(admission !== null && authorizer !== null, 'with it: both admin slots');
  // Not merely two functions: the admission is the platform decision over THAT port, and the authorizer decides on
  // the scope that admission selected — without asking the port again.
  const principal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-operator' });
  const signal = new AbortController().signal;
  const admitted = await admission.admit(principal, 'admin', signal) as { admitted: true; securityVersion: string; context: Record<string, unknown> };
  assert.equal(admitted.admitted, true);
  assert.match(admitted.securityVersion, /^p1:[A-Za-z0-9_-]{43}$/, 'the platform witness');
  assert.deepEqual({ ...admitted.context }, {
    actor: PLATFORM_ACTOR, securityVersion: 'sv-1', scope: 'platform', tenant: null, store: null,
    membershipId: PLATFORM_GRANT, roleId: 'system_owner', limitation: 'none',
  });
  assert.equal(port.reads, 1);
  await assert.rejects(Promise.resolve().then(() => admission.admit(principal, 'tenant', signal)), /^Error: platform admission unavailable$/,
    'bound to the administrative boundary alone');
  assert.equal(admission.probe?.(signal), true, 'its readiness probe is the port\'s');
  const route = Object.freeze({ method: 'PATCH', path: '/admin/v1/tenants/status', audience: 'admin' } as const);
  const requirement = Object.freeze({ scope: 'platform', permission: 'change_tenant_status' } as const);
  assert.deepEqual(await authorizer.authorize(principal, requirement, route, signal, admitted.context as never),
    { granted: true, context: { ...admitted.context } }, 'System Owner, decided on the admitted scope');
  await assert.rejects(Promise.resolve().then(() => authorizer.authorize(principal, requirement, route, signal, null)),
    /^Error: platform authorization unavailable$/, 'no admitted scope is a wiring fault, never a verdict');
  assert.equal(port.reads, 1, 'the authorizer never reads the port: it decides on what admission selected');
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
  };
}

test('durable idempotency is not this root\'s: it reads no IDEMPOTENCY_KEY or APP_DATABASE_URL and composes no idempotency or transaction port', () => {
  // The transaction root (productionTransactions.ts) owns both, for a route that requires them.
  const read = new Set<string>();
  const env = new Proxy({ ...CONFIGURED, IDEMPOTENCY_KEY: 'short', APP_DATABASE_URL: 'postgres://unit.invalid:6543/db' } as Record<string, string | undefined>, {
    get: (target, key) => {
      if (typeof key === 'string') read.add(key);
      return Reflect.get(target, key);
    },
  });
  assert.deepEqual(blockersOf(env), [LIMITER, ...ADAPTER_BLOCKERS], 'a malformed key or an unsupported endpoint is nothing to this root');
  assert.ok(!read.has('IDEMPOTENCY_KEY') && !read.has('APP_DATABASE_URL'), 'neither is read');
  assert.ok(read.has('RATE_LIMIT_KEY'), 'the scan observes reads (positive control)');
  assert.deepEqual(Object.keys(assembleSessions(parts())).sort(), ['limits', 'sessions']);
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
