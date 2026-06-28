// Phase 2.0 M20 — Tests for the thin Express adapter of the inert C-06 evidence-coverage handler.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { Request, Response } from 'express';
import {
  createBcpC06QualityGatesEvidenceReadinessHandler,
  BCP_C06_QUALITY_GATES_EVIDENCE_ROUTE_PATH,
  BCP_C06_QUALITY_GATES_EVIDENCE_PROXY_PATH,
  BCP_C06_QUALITY_GATES_EVIDENCE_FLAG,
} from './bcpC06ReadOnlyExpressAdapter';
import { getBcpC06QualityGatesEvidenceEntries } from './bcpC06QualityGatesEvidenceProvider';

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
const devOn = { isDevEnvironment: () => true, featureEnabled: () => true, getQualityGatesEvidenceEntries: () => getBcpC06QualityGatesEvidenceEntries() };

const SRC = fs.readFileSync(new URL('./bcpC06ReadOnlyExpressAdapter.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('constants: route / proxy / flag are the accepted C-06 values', () => { assert.equal(BCP_C06_QUALITY_GATES_EVIDENCE_ROUTE_PATH, '/dev/bcp/quality-gates-evidence-coverage-readiness'); assert.equal(BCP_C06_QUALITY_GATES_EVIDENCE_PROXY_PATH, '/__identity/dev/bcp/quality-gates-evidence-coverage-readiness'); assert.equal(BCP_C06_QUALITY_GATES_EVIDENCE_FLAG, 'ENABLE_BCP_DEV_C06_QUALITY_GATES_EVIDENCE_COVERAGE_READINESS'); });
test('factory returns an inert handler function', () => assert.equal(typeof createBcpC06QualityGatesEvidenceReadinessHandler(devOn), 'function'));
test('GET (dev+enabled) ⇒ 200 JSON envelope', () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler(devOn)(req('GET'), res as unknown as Response); assert.equal(res._status, 200); assert.equal((res._json as Record<string, unknown>).schemaVersion, 'bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config'); });
test('GET emits exactly 12 items', () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler(devOn)(req('GET'), res as unknown as Response); assert.equal((res._json as unknown as Record<string, unknown[]>).evidenceItems.length, 12); });
test('HEAD ⇒ 200 bodyless (end, no json)', () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler(devOn)(req('HEAD'), res as unknown as Response); assert.equal(res._status, 200); assert.equal(res._ended, true); assert.equal(res._json, undefined); });
test('OPTIONS ⇒ 204 Allow: GET (end)', () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler(devOn)(req('OPTIONS'), res as unknown as Response); assert.equal(res._status, 204); assert.equal(res._headers.Allow, 'GET'); assert.equal(res._ended, true); });
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${m} ⇒ 405`, () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler(devOn)(req(m), res as unknown as Response); assert.equal(res._status, 405); });
test('feature OFF ⇒ 404 feature_disabled', () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler({ ...devOn, featureEnabled: () => false })(req('GET'), res as unknown as Response); assert.equal(res._status, 404); assert.equal((res._json as Record<string, unknown>).reason, 'feature_disabled'); });
test('production (dev off) ⇒ 404 dev_only', () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler({ ...devOn, isDevEnvironment: () => false })(req('GET'), res as unknown as Response); assert.equal(res._status, 404); assert.equal((res._json as Record<string, unknown>).reason, 'dev_only'); });
test('provider NOT resolved when gated off (gates first)', () => { let called = 0; const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => false, getQualityGatesEvidenceEntries: () => { called++; return getBcpC06QualityGatesEvidenceEntries(); } })(req('GET'), res as unknown as Response); assert.equal(called, 0); });
test('provider resolved when dev+enabled', () => { let called = 0; const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler({ isDevEnvironment: () => true, featureEnabled: () => true, getQualityGatesEvidenceEntries: () => { called++; return getBcpC06QualityGatesEvidenceEntries(); } })(req('GET'), res as unknown as Response); assert.equal(called, 1); });
test('reads ONLY req.method — throwing getters on query/body/headers/cookies/params do not throw', () => { const r = { method: 'GET' } as Record<string, unknown>; for (const k of ['query', 'body', 'headers', 'cookies', 'params']) Object.defineProperty(r, k, { get() { throw new Error(`read ${k}`); } }); const res = mockRes(); assert.doesNotThrow(() => createBcpC06QualityGatesEvidenceReadinessHandler(devOn)(r as unknown as Request, res as unknown as Response)); assert.equal(res._status, 200); });
test('default featureEnabled resolver is default-OFF (flag unset ⇒ 404)', () => { const res = mockRes(); createBcpC06QualityGatesEvidenceReadinessHandler({ isDevEnvironment: () => true })(req('GET'), res as unknown as Response); assert.equal(res._status, 404); });
test('adapter source is inert: no express()/Router/listen/app.* registration', () => { for (const bad of ['express(', 'Router(', '.listen(', 'app.get(', 'app.post(', 'app.put(', 'app.patch(', 'app.delete(', 'app.all(', 'app.use(']) assert.ok(!SRC.includes(bad), bad); });
test('adapter source: type-only express import (no value import)', () => assert.ok(/import\s+type\s*\{[^}]*\}\s*from\s*['"]express['"]/.test(SRC)));
test('adapter source: no env enumeration / live access / log read', () => { for (const bad of ['Object.keys(process.env)', 'printenv', 'dotenv', 'createClient', '@supabase', 'getDb', 'fetch(', 'mockData', '/src/', 'readFileSync', 'child_process']) assert.ok(!SRC.includes(bad), bad); });
test('adapter source reads no request authority fields (only req.method)', () => { for (const bad of ['req.query', 'req.body', 'req.headers', 'req.cookies', 'req.params']) assert.ok(!SRC.includes(bad), bad); assert.ok(SRC.includes('req.method')); });
test('adapter source does not import a C-05 module', () => { for (const bad of ['bcpC05', 'FeatureFlagPosture']) assert.ok(!SRC.includes(bad), bad); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M20 BCP C-06 adapter] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
