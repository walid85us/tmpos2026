// Phase 2.0 M12 — Tests for the inert C-03 Express adapter (handler factory).
//
// Self-contained, DB-FREE, network-FREE, NO port binding, NO real Express. Runnable via
// `npx tsx server/bcp-pilot/bcpC03ReadOnlyExpressAdapter.test.ts`.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  createBcpC03UiCoverageReadinessHandler,
  BCP_C03_UI_COVERAGE_ROUTE_PATH,
  BCP_C03_UI_COVERAGE_PROXY_PATH,
  BCP_C03_FEATURE_FLAG,
} from './bcpC03ReadOnlyExpressAdapter';
import type { C03UiCoverageEntryInput } from './bcpC03UiCoverageReadModel';

type MockRes = {
  statusCode: number; headers: Record<string, string>; body: unknown; ended: boolean; headersSent: boolean;
  status(c: number): MockRes; json(b: unknown): MockRes; setHeader(k: string, v: string): void; end(): MockRes;
};
function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 0, headers: {}, body: undefined, ended: false, headersSent: false,
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; r.headersSent = true; r.ended = true; return r; },
    setHeader(k, v) { r.headers[k] = v; },
    end() { r.headersSent = true; r.ended = true; return r; },
  };
  return r;
}
const ENTRIES: C03UiCoverageEntryInput[] = [{
  screenKey: 'c03-ui-coverage-preview', screenLabel: 'C-03 UI Coverage Preview', screenStatus: 'preview',
  coverageClass: 'preview_card', previewCardStatus: 'implemented', clientStatus: 'implemented',
  routeStatus: 'implemented', dataSourceClass: 'code_config_only', devGatePosture: 'dev_only',
  productionPosture: 'production_disabled', readOnlyPosture: 'read_only', mutationPosture: 'no_mutation',
  exposurePosture: 'backend_cp_internal_only', evidenceStatus: 'transport_verified',
}];
const devOn = { isDevEnvironment: () => true, featureEnabled: () => true, getCoverageEntries: () => ENTRIES };
const ADAPTER_CODE = fs.readFileSync(new URL('./bcpC03ReadOnlyExpressAdapter.ts', import.meta.url), 'utf8')
  .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

test('factory exports an inert handler function', () => {
  assert.equal(typeof createBcpC03UiCoverageReadinessHandler(), 'function');
});
test('constants are the accepted route/proxy/flag', () => {
  assert.equal(BCP_C03_UI_COVERAGE_ROUTE_PATH, '/dev/bcp/ui-coverage-readiness');
  assert.equal(BCP_C03_UI_COVERAGE_PROXY_PATH, '/__identity/dev/bcp/ui-coverage-readiness');
  assert.equal(BCP_C03_FEATURE_FLAG, 'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS');
});
test('GET (DEV + flag on) ⇒ 200 JSON envelope', () => {
  const h = createBcpC03UiCoverageReadinessHandler(devOn);
  const res = mockRes(); h({ method: 'GET' } as never, res as never);
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, unknown>).schemaVersion, 'bcp.c03.ui-coverage-readiness.v1-code-config');
});
test('HEAD ⇒ 200 bodyless (end, no json)', () => {
  const h = createBcpC03UiCoverageReadinessHandler(devOn);
  const res = mockRes(); h({ method: 'HEAD' } as never, res as never);
  assert.equal(res.statusCode, 200); assert.equal(res.body, undefined); assert.ok(res.ended);
});
test('OPTIONS ⇒ 204 with Allow header, bodyless', () => {
  const h = createBcpC03UiCoverageReadinessHandler(devOn);
  const res = mockRes(); h({ method: 'OPTIONS' } as never, res as never);
  assert.equal(res.statusCode, 204); assert.equal(res.headers.Allow, 'GET'); assert.equal(res.body, undefined);
});
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${m} ⇒ 405`, () => {
    const h = createBcpC03UiCoverageReadinessHandler(devOn);
    const res = mockRes(); h({ method: m } as never, res as never);
    assert.equal(res.statusCode, 405);
  });
}
test('feature off ⇒ 404 unavailable', () => {
  const h = createBcpC03UiCoverageReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => false });
  const res = mockRes(); h({ method: 'GET' } as never, res as never);
  assert.equal(res.statusCode, 404);
});
test('production ⇒ 404 dev_only', () => {
  const h = createBcpC03UiCoverageReadinessHandler({ isDevEnvironment: () => false, featureEnabled: () => true });
  const res = mockRes(); h({ method: 'GET' } as never, res as never);
  assert.equal(res.statusCode, 404);
  assert.equal((res.body as Record<string, unknown>).reason, 'dev_only');
});
test('provider is NOT resolved when gated off (gates-first)', () => {
  let called = 0;
  const h = createBcpC03UiCoverageReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => false, getCoverageEntries: () => { called++; return ENTRIES; } });
  h({ method: 'GET' } as never, mockRes() as never);
  assert.equal(called, 0);
});
test('provider IS resolved when gates pass', () => {
  let called = 0;
  const h = createBcpC03UiCoverageReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => true, getCoverageEntries: () => { called++; return ENTRIES; } });
  h({ method: 'GET' } as never, mockRes() as never);
  assert.equal(called, 1);
});
test('adapter reads ONLY req.method (throwing query/body/headers/cookies/params do not break it)', () => {
  const h = createBcpC03UiCoverageReadinessHandler(devOn);
  const req: Record<string, unknown> = { method: 'GET' };
  for (const k of ['query', 'body', 'headers', 'cookies', 'params']) {
    Object.defineProperty(req, k, { get() { throw new Error('must not be read'); } });
  }
  const res = mockRes();
  assert.doesNotThrow(() => h(req as never, res as never));
  assert.equal(res.statusCode, 200);
});
test('transport safe-error: a throwing provider ⇒ 500 {status:error}, no throw', () => {
  const h = createBcpC03UiCoverageReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => true, getCoverageEntries: () => { throw new Error('boom'); } });
  const res = mockRes();
  assert.doesNotThrow(() => h({ method: 'GET' } as never, res as never));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { status: 'error' });
});
test('default getCoverageEntries ⇒ safe empty envelope', () => {
  const h = createBcpC03UiCoverageReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => true });
  const res = mockRes(); h({ method: 'GET' } as never, res as never);
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as Record<string, { isEmpty: boolean }>).emptyState.isEmpty, true);
});
test('static inertness: adapter creates no app/router/listener', () => {
  for (const bad of ['express(', 'Router(', '.listen(', 'app.get(', 'app.post(', 'app.all(', 'app.use(']) {
    assert.ok(!ADAPTER_CODE.includes(bad), `adapter contains ${bad}`);
  }
});
test('static: adapter does not map req.query/body/headers/cookies/params', () => {
  for (const bad of ['req.query', 'req.body', 'req.headers', 'req.cookies', 'req.params']) {
    assert.ok(!ADAPTER_CODE.includes(bad), `adapter maps ${bad}`);
  }
});

(() => {
  let pass = 0; const failures: string[] = [];
  for (const c of cases) { try { c.fn(); pass++; console.log('PASS ' + c.name); } catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } }
  console.log(`\n[M12 BCP C-03 adapter] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
