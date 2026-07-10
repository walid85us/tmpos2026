// Phase 3.0 M2 — Tests for the thin Express adapter of the "Acknowledge Backend CP Readiness Review" action.
// Confirms: DEV/flag gates resolved before the handler; server-supplied principal/permission are the ONLY
// authority (request headers/query/cookies are never authority); default principal is system_owner + manage;
// POST-only; safe response serialization; injected advisory sink receives events; no durable sink.
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createBcpActionAcknowledgeReadinessReviewHandler,
  BCP_ACTION_ACK_ROUTE_PATH,
  BCP_ACTION_ACK_PROXY_PATH,
  BCP_ACTION_ACK_FLAG,
  BCP_ACTION_ACK_KEY,
} from './bcpActionAcknowledgeReadinessReviewExpressAdapter';
import { createRecordingActionAuditSink } from './bcpActionAuditSink';

function mockRes() {
  const res: Record<string, unknown> = { _status: 0, _json: undefined, headersSent: false };
  res.status = (c: number) => { res._status = c; return res; };
  res.json = (b: unknown) => { res._json = b; res.headersSent = true; return res; };
  return res as unknown as Response & { _status: number; _json: unknown };
}
const req = (method: string, body: unknown, extra: Record<string, unknown> = {}): Request =>
  ({ method, body, headers: {}, query: {}, cookies: {}, params: {}, ...extra } as unknown as Request);
const okBody = () => ({ confirm: true, reason: 'Reviewed readiness.', idempotencyKey: 'adp-key-0001', lensKey: 'ALL' });

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('constants: route / proxy / flag / key are the accepted values', () => {
  assert.equal(BCP_ACTION_ACK_ROUTE_PATH, '/dev/bcp/actions/acknowledge-readiness-review');
  assert.equal(BCP_ACTION_ACK_PROXY_PATH, '/__identity/dev/bcp/actions/acknowledge-readiness-review');
  assert.equal(BCP_ACTION_ACK_FLAG, 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW');
  assert.equal(BCP_ACTION_ACK_KEY, 'bcp.action.acknowledge_readiness_review');
});

test('flag OFF (injected) => 404 feature_disabled, 0 audit', () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler({ isDevEnvironment: () => true, featureEnabled: () => false, sink, idempotencyStore: new Set() });
  const res = mockRes(); h(req('POST', okBody()), res);
  assert.equal(res._status, 404); assert.equal((res._json as Record<string, unknown>).reason, 'feature_disabled'); assert.equal(sink.events.length, 0);
});

test('production (injected) => 404 dev_only', () => {
  const h = createBcpActionAcknowledgeReadinessReviewHandler({ isDevEnvironment: () => false, featureEnabled: () => true, idempotencyStore: new Set() });
  const res = mockRes(); h(req('POST', okBody()), res);
  assert.equal(res._status, 404); assert.equal((res._json as Record<string, unknown>).reason, 'dev_only');
});

test('DEFAULT principal is system_owner + manage => dev+flag ON + valid body => 200 success', () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler({ isDevEnvironment: () => true, featureEnabled: () => true, sink, idempotencyStore: new Set() });
  const res = mockRes(); h(req('POST', okBody()), res);
  assert.equal(res._status, 200); assert.equal((res._json as Record<string, unknown>).status, 'success');
  assert.equal(sink.events.length, 1); assert.equal(sink.events[0].decision, 'allow');
});

test('non-POST method => 405 (method gate; adapter passes req.method)', () => {
  const h = createBcpActionAcknowledgeReadinessReviewHandler({ isDevEnvironment: () => true, featureEnabled: () => true, idempotencyStore: new Set() });
  const res = mockRes(); h(req('GET', okBody()), res);
  assert.equal(res._status, 405);
});

test('request headers/query/cookies are NEVER authority (non-qualifying injected principal => 403 despite hostile req)', () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler({
    isDevEnvironment: () => true, featureEnabled: () => true, sink, idempotencyStore: new Set(),
    principal: () => ({ source: 'server_derived', internalUserId: 'iu_x', authProvider: 'supabase', verified: true, scopeType: 'platform', parityState: 'ready', visibilityClass: 'overview_viewer' }),
    platformPermissionLevel: () => 'view',
  });
  const res = mockRes();
  h(req('POST', okBody(), { headers: { authorization: 'Bearer evil', 'x-role': 'system_owner' }, query: { role: 'system_owner' }, cookies: { admin: '1' } }), res);
  assert.equal(res._status, 403);
});

test('body authority fields rejected (strict schema) => 400 unexpected_field', () => {
  const h = createBcpActionAcknowledgeReadinessReviewHandler({ isDevEnvironment: () => true, featureEnabled: () => true, idempotencyStore: new Set() });
  const res = mockRes(); h(req('POST', { ...okBody(), role: 'system_owner', permissions: { platform: 'full' } }), res);
  assert.equal(res._status, 400); assert.equal((res._json as Record<string, unknown>).code, 'unexpected_field');
});

test('duplicate idempotency key across two calls (shared store) => second is 200 duplicate, no 2nd marker', () => {
  const store = new Set<string>(); const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler({ isDevEnvironment: () => true, featureEnabled: () => true, sink, idempotencyStore: store });
  const r1 = mockRes(); h(req('POST', okBody()), r1); assert.equal(r1._status, 200); assert.equal((r1._json as Record<string, unknown>).status, 'success');
  const r2 = mockRes(); h(req('POST', okBody()), r2); assert.equal(r2._status, 200); assert.equal((r2._json as Record<string, unknown>).status, 'duplicate');
  assert.equal(sink.events.length, 1);
});

test('adapter response is a safe closed DTO (no raw error/stack/secret)', () => {
  const h = createBcpActionAcknowledgeReadinessReviewHandler({ isDevEnvironment: () => true, featureEnabled: () => true, idempotencyStore: new Set() });
  const res = mockRes(); h(req('POST', okBody()), res);
  assert.ok(!/Error:|"stack":|password|service_role/i.test(JSON.stringify(res._json)));
});

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } } console.log(`\n[P3.0 M2 BCP action ack adapter] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
