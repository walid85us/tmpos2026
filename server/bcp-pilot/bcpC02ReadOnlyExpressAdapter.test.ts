// Phase 2.0 M8D — Tests for the thin Express adapter of the inert C-02 registry-readiness route.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding (does NOT import server.ts,
// which calls app.listen at import time). Tests the adapter handler directly with a fake req/res and
// INJECTED deps (no global env mutation needed). Runnable via `npx tsx <thisfile>`. No real
// ids/secrets — synthetic placeholders only. Does NOT import src/ or any sensitive mock-row data.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  createBcpC02RegistryReadinessHandler,
  BCP_C02_REGISTRY_READINESS_ROUTE_PATH,
  BCP_C02_REGISTRY_READINESS_PROXY_PATH,
  BCP_C02_FEATURE_FLAG,
} from './bcpC02ReadOnlyExpressAdapter';
import type { C02RegistryModuleInput } from './bcpC02RegistryReadModel';

const SAFE_REGISTRY: C02RegistryModuleInput[] = [
  { id: 'access-gate', name: 'Separate Access Gate', status: 'included' },
  { id: 'command-center', name: 'Command Center', status: 'placeholder' },
];

// Minimal fake Express res capturing status/headers/body/ended.
interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
  setHeader(k: string, v: string): void;
  status(c: number): FakeRes;
  json(b: unknown): void;
  end(): void;
}
function fakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; },
    end() { this.ended = true; },
  };
}

// Enabled, DEV, with a safe injected registry — the common "on" configuration.
const enabledHandler = createBcpC02RegistryReadinessHandler({
  isDevEnvironment: () => true,
  featureEnabled: () => true,
  getModules: () => SAFE_REGISTRY,
});
const call = (handler: ReturnType<typeof createBcpC02RegistryReadinessHandler>, method: string): FakeRes => {
  const res = fakeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler({ method } as any, res as any);
  return res;
};

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

// (path/flag constants are safe future labels, not registered in M8D)
test('route/proxy path + flag constants are the safe future labels', () => {
  assert.equal(BCP_C02_REGISTRY_READINESS_ROUTE_PATH, '/dev/bcp/registry-readiness');
  assert.equal(BCP_C02_REGISTRY_READINESS_PROXY_PATH, '/__identity/dev/bcp/registry-readiness');
  assert.equal(BCP_C02_FEATURE_FLAG, 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS');
});

// 1 + 2.
test('adapter translates GET into the route handler and returns safe JSON success', () => {
  const r = call(enabledHandler, 'GET');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body && typeof r.body === 'object' && 'schemaVersion' in (r.body as object));
  assert.equal((r.body as { schemaVersion?: string }).schemaVersion, 'bcp.c02.registry-readiness.v1-code-config');
});

// 3.
test('adapter returns bodyless HEAD (200, ended, no body)', () => {
  const r = call(enabledHandler, 'HEAD');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, undefined);
  assert.equal(r.ended, true);
});

// 4.
test('adapter returns OPTIONS response (204, Allow: GET, no body)', () => {
  const r = call(enabledHandler, 'OPTIONS');
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers.Allow, 'GET');
  assert.equal(r.body, undefined);
  assert.equal(r.ended, true);
});

// 5.
test('adapter blocks POST/PUT/PATCH/DELETE with 405 method_not_allowed', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = call(enabledHandler, m);
    assert.equal(r.statusCode, 405, m);
    assert.equal(r.headers.Allow, 'GET');
    assert.deepEqual(r.body, { status: 'method_not_allowed' });
  }
});

// 6 + 7 + 12.
test('adapter needs no Express app / no registration / no server.ts to test', () => {
  // The factory returns a plain function; calling it with a fake req/res requires no app, no mounting,
  // and no import of server/platform-identity/server.ts (this file imports neither).
  assert.equal(typeof enabledHandler, 'function');
  const r = call(enabledHandler, 'GET');
  assert.equal(r.statusCode, 200);
});

// 8 + 10 + 11.
test('adapter exposes no raw errors and no DB/Supabase/provider/nav/customer/prod tokens', () => {
  const bodies = ['GET', 'HEAD', 'OPTIONS', 'POST'].map((m) => JSON.stringify(call(enabledHandler, m).body ?? null));
  for (const s of bodies) {
    for (const bad of ['postgres://', 'Bearer', 'eyJ', 'service_role', '@', '://', 'supabase', 'getDb', 'stack', 'Error:']) {
      assert.ok(!s.includes(bad), `forbidden token leaked: ${bad}`);
    }
  }
});

// 9.
test('adapter preserves safe status codes across configurations', () => {
  assert.equal(call(enabledHandler, 'GET').statusCode, 200);
  assert.equal(call(enabledHandler, 'POST').statusCode, 405);
  assert.equal(call(enabledHandler, 'OPTIONS').statusCode, 204);
  // feature OFF (injected) → 404 feature_disabled
  const off = createBcpC02RegistryReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => false });
  const ro = call(off, 'GET');
  assert.equal(ro.statusCode, 404);
  assert.deepEqual(ro.body, { status: 'unavailable', reason: 'feature_disabled' });
  // not DEV (injected) → 404 dev_only
  const prod = createBcpC02RegistryReadinessHandler({ isDevEnvironment: () => false, featureEnabled: () => true });
  const rp = call(prod, 'GET');
  assert.equal(rp.statusCode, 404);
  assert.deepEqual(rp.body, { status: 'unavailable', reason: 'dev_only' });
});

// Default-off proof via the real env-backed default (no injected featureEnabled).
test('default flag is OFF: with the C-02 flag unset, DEV GET => 404 feature_disabled', () => {
  const prev = process.env[BCP_C02_FEATURE_FLAG];
  const prevNode = process.env.NODE_ENV;
  try {
    delete process.env[BCP_C02_FEATURE_FLAG];
    process.env.NODE_ENV = 'development';
    // Only NODE_ENV/dev injected; featureEnabled falls back to the real default-off flag read.
    const h = createBcpC02RegistryReadinessHandler({ isDevEnvironment: () => true, getModules: () => SAFE_REGISTRY });
    const r = call(h, 'GET');
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' });
  } finally {
    if (prev === undefined) delete process.env[BCP_C02_FEATURE_FLAG]; else process.env[BCP_C02_FEATURE_FLAG] = prev;
    if (prevNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNode;
  }
});

// adapter ignores request body/query/headers — authority/content is server-side only.
test('adapter ignores request body/query/headers (no injected request value can influence output)', () => {
  const plain = call(enabledHandler, 'GET');
  const res = fakeRes();
  const junkReq = {
    method: 'GET',
    body: { internalUserId: 'iu_attacker', email: 'evil@example.com' },
    query: { tenant: 't-injected', authProviderUid: 'uid-injected' },
    headers: { authorization: 'Bearer injected' },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enabledHandler(junkReq as any, res as any);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, plain.body);
  const s = JSON.stringify(res.body);
  for (const bad of ['iu_attacker', 'evil@example.com', 't-injected', 'uid-injected', 'Bearer']) {
    assert.ok(!s.includes(bad), `injected request value leaked: ${bad}`);
  }
});

// default getModules is EMPTY (no src import) → safe emptyState.
test('default registry is empty (no src import) => safe emptyState envelope', () => {
  const h = createBcpC02RegistryReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => true });
  const r = call(h, 'GET');
  assert.equal(r.statusCode, 200);
  const b = r.body as { emptyState?: { isEmpty?: boolean; reason?: string }; summaryCounts?: { total?: number } };
  assert.equal(b.emptyState?.isEmpty, true);
  assert.equal(b.emptyState?.reason, 'no_modules');
  assert.equal(b.summaryCounts?.total, 0);
});

// Gate-order proof: the injected registry provider must NOT run when gated off (production/flag-off).
test('gates run FIRST: getModules is never called when not-DEV or flag-off', () => {
  let calls = 0;
  const throwingProvider = (): readonly C02RegistryModuleInput[] => { calls++; throw new Error('provider must not run when gated off'); };
  // flag-off
  const offHandler = createBcpC02RegistryReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => false, getModules: throwingProvider });
  const r1 = call(offHandler, 'GET');
  assert.equal(r1.statusCode, 404);
  assert.deepEqual(r1.body, { status: 'unavailable', reason: 'feature_disabled' });
  // not-DEV
  const prodHandler = createBcpC02RegistryReadinessHandler({ isDevEnvironment: () => false, featureEnabled: () => true, getModules: throwingProvider });
  const r2 = call(prodHandler, 'GET');
  assert.equal(r2.statusCode, 404);
  assert.deepEqual(r2.body, { status: 'unavailable', reason: 'dev_only' });
  assert.equal(calls, 0, 'registry provider ran while gated off');
});

// Transport-level safe error: a throwing dependency must yield a safe 500, never a raw stack.
test('adapter dependency throw yields a safe 500 error (no stack/raw error)', () => {
  const boom = createBcpC02RegistryReadinessHandler({
    isDevEnvironment: () => true,
    featureEnabled: () => { throw new Error('boom in featureEnabled'); },
  });
  const res = fakeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.doesNotThrow(() => boom({ method: 'GET' } as any, res as any));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { status: 'error' });
  assert.ok(!/boom|stack|Error:|\bat \b/.test(JSON.stringify(res.body)), 'leaked a raw error/stack');
});

// Static inertness self-check: the source files must contain no registration / listen / server.ts import.
test('inertness: route + adapter source contain no app registration, listen, or server.ts import', () => {
  for (const f of ['bcpC02ReadOnlyRoute.ts', 'bcpC02ReadOnlyExpressAdapter.ts']) {
    const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    // Strip comments so the documentation prose (which mentions these tokens to negate them) is ignored.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const bad of ['.listen(', 'app.get(', 'app.post(', 'app.put(', 'app.patch(', 'app.delete(', 'app.use(', 'app.all(', 'platform-identity/server', 'from \'../../src', 'createClient', '@supabase', 'getDb(']) {
      assert.ok(!code.includes(bad), `${f} contains forbidden wiring/access: ${bad}`);
    }
  }
});

// ---- Runner ----
(() => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try { c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M8D BCP C-02 inert route Express adapter] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
