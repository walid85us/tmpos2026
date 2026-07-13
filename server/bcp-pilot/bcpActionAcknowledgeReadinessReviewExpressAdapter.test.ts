// Phase 3.0 M3 Gate 1 — tests for the Express adapter's genuine async principal-resolution chain.
// Injects fake verify/lookup/authz seams (NO real firebase-admin / DB). Proves: flag/dev/method gates run with
// ZERO Firebase/DB work; 401 on missing/invalid credential; 403 SAFE DENIED (no marker) on unmapped/insufficient;
// 503 fail-closed on resolver/DB error; 200 success (one marker) for a genuine eligible principal; 400 on
// authority body fields; duplicate + sink-failure-retry semantics; and NO fixed synthetic principal remains.
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createBcpActionAcknowledgeReadinessReviewHandler,
  BCP_ACTION_ACK_ROUTE_PATH, BCP_ACTION_ACK_PROXY_PATH, BCP_ACTION_ACK_FLAG, BCP_ACTION_ACK_KEY,
} from './bcpActionAcknowledgeReadinessReviewExpressAdapter';
import { createRecordingActionAuditSink, type BcpActionAuditSink } from './bcpActionAuditSink';
import type { CanonicalAuthzView } from './bcpActionLivePrincipalResolver';
import { BcpActionIdempotencyStore } from './bcpActionIdempotencyStore';
import { BcpActionRateLimiter } from './bcpActionRateLimiter';
import fs from 'node:fs';

function mockRes() {
  let done!: () => void;
  const p = new Promise<void>((r) => { done = r; });
  const res: any = { _status: 0, _json: undefined, _headers: {} as Record<string, string>, headersSent: false, done: p };
  res.status = (c: number) => { res._status = c; return res; };
  res.setHeader = (k: string, v: string) => { res._headers[k] = String(v); return res; };
  res.getHeader = (k: string) => res._headers[k];
  res.json = (b: unknown) => { res._json = b; res.headersSent = true; done(); return res; };
  return res as Response & { _status: number; _json: any; _headers: Record<string, string>; done: Promise<void> };
}
// Valid same-origin browser security headers (content-type + Origin + Fetch-Metadata + intent). Merged under any
// per-test overrides so the request-security guard passes by default; override to exercise denial paths.
const SECURE_HEADERS = {
  'content-type': 'application/json',
  origin: 'http://localhost:5000',
  'sec-fetch-site': 'same-origin',
  'x-bcp-action-intent': 'acknowledge-readiness-review',
};
const req = (method: string, body: unknown, headers: Record<string, unknown> = {}): Request =>
  ({ method, body, headers: { ...SECURE_HEADERS, ...headers }, query: {}, cookies: {}, params: {} } as unknown as Request);
const okBody = () => ({ confirm: true, reason: 'Reviewed readiness.', idempotencyKey: 'adp-key-0001', lensKey: 'ALL' });

function counting<T extends (...a: any[]) => any>(fn: T) {
  let calls = 0;
  const w = (async (...a: any[]) => { calls++; return fn(...a); }) as any;
  w.calls = () => calls; return w as T & { calls: () => number };
}
const view = (o: Partial<CanonicalAuthzView> = {}): CanonicalAuthzView => ({
  decision: 'allow', reasonCode: 'resolved', limitation: 'none', platformRoleId: 'system_owner',
  permissions: { admin: 'full' }, statusValues: ['active'], scopeType: 'platform', ...o,
});
const verifyOk = async () => ({ ok: true, firebaseUid: 'fb_test' });
const verifyFail = (code: string) => async () => ({ ok: false, code });
const lookupOk = (iu: string) => async () => ({ ok: true, internalUserId: iu });
const lookupFail = (reason: string) => async () => ({ ok: false, reason });
const authz = (v: CanonicalAuthzView | null) => async () => v;

// Injected trusted origin matches SECURE_HEADERS.origin so existing tests pass the exact-origin check.
const baseDeps = (over: any = {}) => ({
  isDevEnvironment: () => true, featureEnabled: () => true,
  verifyBearer: verifyOk as any, lookupInternalUserId: lookupOk('iu_owner') as any, resolveCanonicalAuthz: authz(view()) as any,
  idempotencyStore: new BcpActionIdempotencyStore(), rateLimiter: new BcpActionRateLimiter(),
  trustedOrigin: () => ({ ok: true, origin: 'http://localhost:5000' }), ...over,
});

const cases: { name: string; fn: () => Promise<void> }[] = [];
const test = (n: string, fn: () => Promise<void>) => cases.push({ name: n, fn });

test('constants unchanged', async () => {
  assert.equal(BCP_ACTION_ACK_ROUTE_PATH, '/dev/bcp/actions/acknowledge-readiness-review');
  assert.equal(BCP_ACTION_ACK_PROXY_PATH, '/__identity/dev/bcp/actions/acknowledge-readiness-review');
  assert.equal(BCP_ACTION_ACK_FLAG, 'ENABLE_BCP_DEV_ACTION_ACKNOWLEDGE_READINESS_REVIEW');
  assert.equal(BCP_ACTION_ACK_KEY, 'bcp.action.acknowledge_readiness_review');
});

test('flag OFF → 404 feature_disabled + ZERO verify/lookup/authz calls', async () => {
  const v = counting(verifyOk); const l = counting(lookupOk('iu')); const a = counting(authz(view()));
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ featureEnabled: () => false, verifyBearer: v, lookupInternalUserId: l, resolveCanonicalAuthz: a, sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 404); assert.equal(res._json.reason, 'feature_disabled');
  assert.equal(v.calls(), 0); assert.equal(l.calls(), 0); assert.equal(a.calls(), 0); assert.equal(sink.events.length, 0);
});

test('production → 404 dev_only + ZERO verify/lookup/authz calls', async () => {
  const v = counting(verifyOk); const l = counting(lookupOk('iu')); const a = counting(authz(view()));
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ isDevEnvironment: () => false, verifyBearer: v, lookupInternalUserId: l, resolveCanonicalAuthz: a }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 404); assert.equal(res._json.reason, 'dev_only'); assert.equal(v.calls(), 0); assert.equal(l.calls(), 0); assert.equal(a.calls(), 0);
});

test('non-POST → 405 + ZERO verify/lookup/authz calls', async () => {
  const v = counting(verifyOk); const l = counting(lookupOk('iu')); const a = counting(authz(view()));
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: v, lookupInternalUserId: l, resolveCanonicalAuthz: a }));
  const res = mockRes(); h(req('GET', okBody()), res); await res.done;
  assert.equal(res._status, 405); assert.equal(v.calls(), 0); assert.equal(l.calls(), 0); assert.equal(a.calls(), 0);
});

test('missing credential → 401 authentication_required, 0 audit', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: verifyFail('authentication_required'), sink }));
  const res = mockRes(); h(req('POST', okBody()), res); await res.done;
  assert.equal(res._status, 401); assert.equal(res._json.reason, 'authentication_required'); assert.equal(sink.events.length, 0);
});

test('invalid credential → 401 authentication_invalid, 0 audit', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: verifyFail('authentication_invalid'), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer bad' }), res); await res.done;
  assert.equal(res._status, 401); assert.equal(res._json.reason, 'authentication_invalid'); assert.equal(sink.events.length, 0);
});

test('firebase unavailable → 503, 0 audit', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: verifyFail('authentication_unavailable'), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 503); assert.equal(sink.events.length, 0);
});

test('verified but UNMAPPED identity → 403 SAFE DENIED, NO marker', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ lookupInternalUserId: lookupFail('not_found'), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'not_authorized'); assert.equal(sink.events.length, 0);
});

test('identity DB error → 503 fail-closed, NO marker', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ lookupInternalUserId: lookupFail('db_error'), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 503); assert.equal(sink.events.length, 0);
});

test('authz resolver null → 503 fail-closed, NO marker', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ resolveCanonicalAuthz: authz(null), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 503); assert.equal(sink.events.length, 0);
});

test('INSUFFICIENT principal (support_admin) → 403 SAFE DENIED, NO marker', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ resolveCanonicalAuthz: authz(view({ platformRoleId: 'support_admin' })), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'not_authorized'); assert.equal(sink.events.length, 0);
});

test('read-only capped system_owner → 403 SAFE DENIED, NO marker', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ resolveCanonicalAuthz: authz(view({ limitation: 'read_only' })), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(sink.events.length, 0);
});

test('parity-BLOCKED canonical deny → 403 SAFE DENIED, NO marker (guard blocks, handler not reached)', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ resolveCanonicalAuthz: authz(view({ decision: 'deny', reasonCode: 'denied_account_suspended' })), sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'not_authorized'); assert.equal(sink.events.length, 0);
});

test('ELIGIBLE genuine principal → 200 success + exactly ONE advisory marker', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), res); await res.done;
  assert.equal(res._status, 200); assert.equal(res._json.status, 'success');
  assert.equal(sink.events.length, 1); assert.equal(sink.events[0].decision, 'allow'); assert.equal(sink.events[0].result, 'success');
});

test('authority-bearing body field (eligible auth) → 400 unexpected_field, NO marker', async () => {
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ sink }));
  const res = mockRes(); h(req('POST', { ...okBody(), role: 'system_owner' }, { authorization: 'Bearer good' }), res); await res.done;
  assert.equal(res._status, 400); assert.equal(res._json.code, 'unexpected_field'); assert.equal(sink.events.length, 0);
});

test('duplicate key (shared store) → success then duplicate, ONE marker', async () => {
  const store = new BcpActionIdempotencyStore(); const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ sink, idempotencyStore: store }));
  const r1 = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), r1); await r1.done;
  const r2 = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), r2); await r2.done;
  assert.equal(r1._json.status, 'success'); assert.equal(r2._json.status, 'duplicate'); assert.equal(sink.events.length, 1);
});

test('same key + CHANGED payload (shared store) → success then 409 idempotency_conflict, ONE marker', async () => {
  const store = new BcpActionIdempotencyStore(); const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ sink, idempotencyStore: store }));
  const r1 = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), r1); await r1.done;
  const r2 = mockRes(); h(req('POST', { ...okBody(), reason: 'A different reason entirely.' }, { authorization: 'Bearer good' }), r2); await r2.done;
  assert.equal(r1._json.status, 'success'); assert.equal(r2._status, 409); assert.equal(r2._json.status, 'idempotency_conflict');
  assert.equal(sink.events.length, 1);
});

test('sink failure does not burn the key: 500 then retry succeeds with one final marker', async () => {
  const store = new BcpActionIdempotencyStore();
  let first = true;
  const throwOnceSink: BcpActionAuditSink = { record: () => { if (first) { first = false; throw new Error('sink down'); } } };
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ sink: throwOnceSink, idempotencyStore: store }));
  const r1 = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), r1); await r1.done;
  assert.equal(r1._status, 500); assert.equal(store.completedCount(), 0); assert.equal(store.inflightCount(), 0); // key NOT persisted on sink throw
  const rec = createRecordingActionAuditSink();
  const h2 = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ sink: rec, idempotencyStore: store }));
  const r2 = mockRes(); h2(req('POST', okBody(), { authorization: 'Bearer good' }), r2); await r2.done;
  assert.equal(r2._status, 200); assert.equal(rec.events.length, 1);
});

// ============================ Request-security / same-origin / CSRF (BEFORE auth) ============================
test('missing X-BCP-Action-Intent → 403 request_denied, verifier NEVER called, NO marker', async () => {
  const v = counting(verifyOk); const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: v, sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good', 'x-bcp-action-intent': undefined }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'request_denied');
  assert.equal(v.calls(), 0, 'security denial must precede authentication'); assert.equal(sink.events.length, 0);
});
test('Sec-Fetch-Site: cross-site → 403 request_denied, verifier never called', async () => {
  const v = counting(verifyOk);
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: v }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good', 'sec-fetch-site': 'cross-site' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'request_denied'); assert.equal(v.calls(), 0);
});
test('non-JSON content-type → 403 request_denied', async () => {
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps());
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good', 'content-type': 'text/plain' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'request_denied');
});
test('malformed Origin → 403 request_denied', async () => {
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps());
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good', origin: 'not-a-url' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'request_denied');
});
test('exact trusted-origin MISMATCH → 403 request_denied, verifier never called', async () => {
  const v = counting(verifyOk);
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: v, trustedOrigin: () => ({ ok: true, origin: 'https://real.replit.dev' }) }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good', origin: 'http://localhost:5000' }), res); await res.done;
  assert.equal(res._status, 403); assert.equal(res._json.status, 'request_denied'); assert.equal(v.calls(), 0);
});
test('trusted origin UNAVAILABLE (REPLIT_DEV_DOMAIN unresolved) → 503 request_security_unavailable, no verify/marker', async () => {
  const v = counting(verifyOk); const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ verifyBearer: v, sink, trustedOrigin: () => ({ ok: false }) }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), res); await res.done;
  assert.equal(res._status, 503); assert.equal(res._json.status, 'request_security_unavailable');
  assert.equal(v.calls(), 0); assert.equal(sink.events.length, 0);
});
test('flag OFF performs NO trusted-origin resolution (resolver not called) → 404', async () => {
  let resolverCalls = 0;
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ featureEnabled: () => false, trustedOrigin: () => { resolverCalls++; return { ok: true, origin: 'http://localhost:5000' }; } }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer x' }), res); await res.done;
  assert.equal(res._status, 404); assert.equal(resolverCalls, 0, 'trusted-origin resolution must not run when the flag is off');
});
test('security denial consumes NO rate-limit slot and NO idempotency state', async () => {
  const rateLimiter = new BcpActionRateLimiter({ globalLimit: 1 }); // exactly one slot
  const store = new BcpActionIdempotencyStore();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ rateLimiter, idempotencyStore: store }));
  // A security-denied request (missing intent) must NOT consume the single global slot or create any record.
  const denied = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good', 'x-bcp-action-intent': undefined }), denied); await denied.done;
  assert.equal(denied._status, 403); assert.equal(store.completedCount(), 0); assert.equal(store.inflightCount(), 0);
  // The one global slot is still available → a valid request now succeeds (slot was not burned by the denial).
  const ok = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), ok); await ok.done;
  assert.equal(ok._status, 200); assert.equal(ok._json.status, 'success');
});

// ============================ Rate limiting (global ceiling + per-principal) ============================
test('GLOBAL ceiling: over the limit → 429 rate_limited + Retry-After, verifier NOT called past cap', async () => {
  const rateLimiter = new BcpActionRateLimiter({ globalLimit: 2 });
  const v = counting(verifyOk);
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ rateLimiter, verifyBearer: v }));
  for (let i = 0; i < 2; i++) { const r = mockRes(); h(req('POST', { ...okBody(), idempotencyKey: 'gkey-000' + i }, { authorization: 'Bearer good' }), r); await r.done; assert.equal(r._status, 200); }
  const over = mockRes(); h(req('POST', { ...okBody(), idempotencyKey: 'gkey-over' }, { authorization: 'Bearer good' }), over); await over.done;
  assert.equal(over._status, 429); assert.equal(over._json.status, 'rate_limited');
  assert.ok(Number(over._headers['Retry-After']) >= 1, 'valid Retry-After header');
  assert.equal(v.calls(), 2, 'over-cap request is 429ed by the global ceiling BEFORE Bearer verification');
});
test('PER-PRINCIPAL window: 6th attempt → 429 rate_limited (global still under ceiling)', async () => {
  const rateLimiter = new BcpActionRateLimiter({ perPrincipalLimit: 5, globalLimit: 100 });
  const store = new BcpActionIdempotencyStore();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ rateLimiter, idempotencyStore: store }));
  for (let i = 0; i < 5; i++) { const r = mockRes(); h(req('POST', { ...okBody(), idempotencyKey: 'pkey-000' + i }, { authorization: 'Bearer good' }), r); await r.done; assert.equal(r._status, 200); }
  const over = mockRes(); h(req('POST', { ...okBody(), idempotencyKey: 'pkey-over' }, { authorization: 'Bearer good' }), over); await over.done;
  assert.equal(over._status, 429); assert.equal(over._json.status, 'rate_limited');
});
test('rate-limited request emits NO advisory marker', async () => {
  const rateLimiter = new BcpActionRateLimiter({ globalLimit: 0 });
  const sink = createRecordingActionAuditSink();
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps({ rateLimiter, sink }));
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), res); await res.done;
  assert.equal(res._status, 429); assert.equal(sink.events.length, 0);
});

test('response is a safe closed DTO (no raw error/stack/secret)', async () => {
  const h = createBcpActionAcknowledgeReadinessReviewHandler(baseDeps());
  const res = mockRes(); h(req('POST', okBody(), { authorization: 'Bearer good' }), res); await res.done;
  assert.ok(!/Error:|"stack":|password|service_role/i.test(JSON.stringify(res._json)));
});

test('mounted adapter source contains NO fixed synthetic privileged principal', async () => {
  const src = fs.readFileSync(new URL('./bcpActionAcknowledgeReadinessReviewExpressAdapter.ts', import.meta.url), 'utf8');
  assert.ok(!src.includes('SYNTHETIC_ACTION_PRINCIPAL'), 'synthetic principal constant must be removed');
  assert.ok(!/visibilityClass:\s*'system_owner'/.test(src), 'no hard-coded system_owner principal in the mounted route');
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 BCP action ack adapter] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
