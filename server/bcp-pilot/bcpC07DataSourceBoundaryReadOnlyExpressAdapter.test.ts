// Phase 2.0 M35/M37 — Tests for the thin Express adapter of the C-07 data-source-boundary handler.
//
// M37: with the additive 'C-07': 'overview_viewer' guard entry, an enabled+DEV GET now serializes the real
// authorized 200 (envelope JSON; HEAD stays bodyless). These tests assert that authorized transport behavior
// AND every denied/disabled/method/error path honestly (mock req/res only — no server, no socket, no network),
// confirm the adapter FILE stays inert (registers nothing itself), and confirm the mount now lives in the
// isolated server.ts. No test fakes or bypasses guard authorization — the 200 arises from the real guard entry.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { Request, Response } from 'express';
import {
  createBcpC07DataSourceBoundaryReadinessHandler,
  BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH,
  BCP_C07_DATA_SOURCE_BOUNDARY_PROXY_PATH,
  BCP_C07_DATA_SOURCE_BOUNDARY_FLAG,
} from './bcpC07DataSourceBoundaryReadOnlyExpressAdapter';
import { getBcpC07DataSourceBoundaryItems } from './bcpC07DataSourceBoundaryProvider';

interface MockRes {
  _status: number; _json: unknown; _ended: boolean; _headers: Record<string, string>; headersSent: boolean;
  status(s: number): MockRes; json(b: unknown): MockRes; end(): MockRes; setHeader(k: string, v: string): void;
}
function mockRes(): MockRes {
  const r: MockRes = {
    _status: 0, _json: undefined, _ended: false, _headers: {}, headersSent: false,
    status(s) { this._status = s; return this; },
    json(b) { this._json = b; this.headersSent = true; return this; },
    end() { this._ended = true; this.headersSent = true; return this; },
    setHeader(k, v) { this._headers[k] = v; },
  };
  return r;
}
const req = (method: string, extra: Record<string, unknown> = {}): Request => ({ method, ...extra } as unknown as Request);
// Enabled + DEV, with the C-07 provider wired in. With the additive 'C-07' guard entry (M37) this now
// serializes the authorized 200 and consumes the provider's items to build the envelope.
const devOn = { isDevEnvironment: () => true, featureEnabled: () => true, getDataSourceBoundaryItems: () => getBcpC07DataSourceBoundaryItems() };

const SRC = fs.readFileSync(new URL('./bcpC07DataSourceBoundaryReadOnlyExpressAdapter.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });
const H = createBcpC07DataSourceBoundaryReadinessHandler;

test('constants: route / proxy / flag are the accepted C-07 values', () => { assert.equal(BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH, '/dev/bcp/data-source-boundary-readiness'); assert.equal(BCP_C07_DATA_SOURCE_BOUNDARY_PROXY_PATH, '/__identity/dev/bcp/data-source-boundary-readiness'); assert.equal(BCP_C07_DATA_SOURCE_BOUNDARY_FLAG, 'ENABLE_BCP_DEV_C07_DATA_SOURCE_BOUNDARY_READINESS'); });
test('factory returns an inert handler function', () => assert.equal(typeof H(devOn), 'function'));

// --- authorized: GET/HEAD serialize the real 200 (unlocked by the additive 'C-07' guard entry, M37) ---
test('AUTHORIZED: GET (dev+enabled) ⇒ 200 JSON envelope', () => { const res = mockRes(); H(devOn)(req('GET'), res as unknown as Response); assert.equal(res._status, 200); assert.equal((res._json as Record<string, unknown>).schemaVersion, 'bcp.c07.data-source-boundary-readiness.v1-code-config'); assert.equal((res._json as Record<string, unknown>).selfAttestation, 'design_time_code_config'); assert.equal((res._json as Record<string, unknown>).generatedAt, undefined); });
test('AUTHORIZED: HEAD ⇒ 200 bodyless (end, no json)', () => { const res = mockRes(); H(devOn)(req('HEAD'), res as unknown as Response); assert.equal(res._status, 200); assert.equal(res._ended, true); assert.equal(res._json, undefined); });

// --- method behavior ---
test('OPTIONS ⇒ 204 Allow: GET (end)', () => { const res = mockRes(); H(devOn)(req('OPTIONS'), res as unknown as Response); assert.equal(res._status, 204); assert.equal(res._headers.Allow, 'GET'); assert.equal(res._ended, true); });
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${m} ⇒ 405 Allow: GET`, () => { const res = mockRes(); H(devOn)(req(m), res as unknown as Response); assert.equal(res._status, 405); assert.equal(res._headers.Allow, 'GET'); });

// --- disabled / production ---
test('feature OFF ⇒ 404 feature_disabled', () => { const res = mockRes(); H({ ...devOn, featureEnabled: () => false })(req('GET'), res as unknown as Response); assert.equal(res._status, 404); assert.equal((res._json as Record<string, unknown>).reason, 'feature_disabled'); });
test('production (dev off) ⇒ 404 dev_only', () => { const res = mockRes(); H({ ...devOn, isDevEnvironment: () => false })(req('GET'), res as unknown as Response); assert.equal(res._status, 404); assert.equal((res._json as Record<string, unknown>).reason, 'dev_only'); });
test('default featureEnabled resolver is default-OFF (flag unset ⇒ 404)', () => { const res = mockRes(); H({ isDevEnvironment: () => true })(req('GET'), res as unknown as Response); assert.equal(res._status, 404); });

// --- gates-first provider resolution ---
test('provider NOT resolved when gated off (gates first)', () => { let called = 0; const res = mockRes(); H({ isDevEnvironment: () => true, featureEnabled: () => false, getDataSourceBoundaryItems: () => { called++; return getBcpC07DataSourceBoundaryItems(); } })(req('GET'), res as unknown as Response); assert.equal(called, 0); });
test('provider NOT resolved in production (gates first)', () => { let called = 0; const res = mockRes(); H({ isDevEnvironment: () => false, featureEnabled: () => true, getDataSourceBoundaryItems: () => { called++; return getBcpC07DataSourceBoundaryItems(); } })(req('GET'), res as unknown as Response); assert.equal(called, 0); });
test('provider resolved when dev+enabled and items ARE consumed on the authorized 200 path', () => { let called = 0; const res = mockRes(); H({ isDevEnvironment: () => true, featureEnabled: () => true, getDataSourceBoundaryItems: () => { called++; return getBcpC07DataSourceBoundaryItems(); } })(req('GET'), res as unknown as Response); assert.equal(called, 1); assert.equal(res._status, 200); });

// --- hostile request: only req.method is consulted ---
test('reads ONLY req.method — throwing getters on query/body/headers/cookies/params do not throw (still 200)', () => { const r = { method: 'GET' } as Record<string, unknown>; for (const k of ['query', 'body', 'headers', 'cookies', 'params']) Object.defineProperty(r, k, { get() { throw new Error(`read ${k}`); } }); const res = mockRes(); assert.doesNotThrow(() => H(devOn)(r as unknown as Request, res as unknown as Response)); assert.equal(res._status, 200); });
test('hostile extra request fields ignored (still 200; fields never authority)', () => { const res = mockRes(); H(devOn)(req('GET', { body: { internalUserId: 'evil' }, query: { admin: '1' }, headers: { authorization: 'Bearer x' } }), res as unknown as Response); assert.equal(res._status, 200); });

// --- safe transport-edge error ---
test('safe 500 on a hostile throwing method getter (no leak)', () => { const r = {} as Record<string, unknown>; Object.defineProperty(r, 'method', { get() { throw new Error('boom'); } }); const res = mockRes(); assert.doesNotThrow(() => H(devOn)(r as unknown as Request, res as unknown as Response)); assert.equal(res._status, 500); assert.deepEqual(res._json, { status: 'error' }); });
test('no raw error/stack in any serialized body', () => { for (const m of ['GET', 'HEAD', 'OPTIONS', 'POST']) { const res = mockRes(); H(devOn)(req(m), res as unknown as Response); assert.ok(!/Error:|at Object\.|"stack":/.test(JSON.stringify(res._json ?? '')), m); } });

// --- static source posture (inert / unmounted / no live access) ---
test('adapter source is inert: no express()/Router/listen/app.* registration or mount', () => { for (const bad of ['express(', 'Router(', '.listen(', 'app.get(', 'app.post(', 'app.put(', 'app.patch(', 'app.delete(', 'app.all(', 'app.use(']) assert.ok(!SRC.includes(bad), bad); });
test('adapter source: type-only express import (no value import)', () => assert.ok(/import\s+type\s*\{[^}]*\}\s*from\s*['"]express['"]/.test(SRC)));
test('adapter source: no env enumeration / live access / network / fs / log read', () => { for (const bad of ['Object.keys(process.env)', 'printenv', 'dotenv', 'createClient', '@supabase', 'getDb', 'fetch(', 'http.request', '.listen(', 'net.Socket', 'mockData', '/src/', 'readFileSync', 'writeFileSync', 'child_process', 'execSync']) assert.ok(!SRC.includes(bad), bad); });
test('adapter source reads no request authority fields (only req.method)', () => { for (const bad of ['req.query', 'req.body', 'req.headers', 'req.cookies', 'req.params']) assert.ok(!SRC.includes(bad), bad); assert.ok(SRC.includes('req.method')); });
test('adapter source does not import another BCP lens module (decoupling)', () => { for (const bad of ['bcpC01', 'bcpC02', 'bcpC03', 'bcpC04', 'bcpC05', 'bcpC06', 'QualityGates', 'FeatureFlagPosture']) assert.ok(!SRC.includes(bad), bad); });
test('adapter source does not import server.ts / registration / transport matrix', () => { for (const bad of ['platform-identity/server', 'RouteRegistration', 'bcpTransportMatrix']) assert.ok(!SRC.includes(bad), bad); });
test('C-07 handler IS mounted in the identity API server.ts (M37) — adapter wired into the isolated API', () => { let serverSrc = ''; try { serverSrc = fs.readFileSync(new URL('../platform-identity/server.ts', import.meta.url), 'utf8'); } catch { serverSrc = ''; } assert.ok(serverSrc.length > 0, 'server.ts should be readable'); for (const marker of ['createBcpC07DataSourceBoundaryReadinessHandler', 'BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH']) assert.ok(serverSrc.includes(marker), `server.ts must reference ${marker} in M37 (route mounted)`); assert.ok(/app\.all\(\s*BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH/.test(serverSrc), 'C-07 mounted via app.all(constant)'); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M35 BCP C-07 adapter] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
