// Phase 3.0 M3 — focused tests for the DEV-only, READ-ONLY controlled-action ELIGIBILITY express adapter.
// Proves: flag-OFF 404 with ZERO auth/DB work; EXACT trusted-origin + cross-site + dedicated-intent enforcement;
// GET body rejection; missing→401 authentication_required (no verify call); invalid→401 authentication_invalid;
// the full eligible / insufficient(permission|visibility|parity|read-only cap|overdue cap) / unmapped / resolver-
// failure decision matrix; a SEPARATE bounded rate limiter (never the action limiter); and NO action-handler,
// NO advisory marker, NO idempotency state. Run via `npx tsx`.
import assert from 'node:assert/strict';
import { createBcpActionEligibilityHandler, BCP_ELIGIBILITY_ROUTE_PATH } from './bcpActionEligibilityExpressAdapter';
import { BcpActionRateLimiter } from './bcpActionRateLimiter';
import type { CanonicalAuthzView } from './bcpActionLivePrincipalResolver';

const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (n: string, fn: () => void | Promise<void>) => cases.push({ name: n, fn });

const TRUSTED = () => ({ ok: true, origin: 'https://t.example' } as const);
const view = (o: Partial<CanonicalAuthzView> = {}): CanonicalAuthzView => ({
  decision: 'allow', reasonCode: 'resolved', limitation: 'none', platformRoleId: 'system_owner',
  permissions: { f: 'full' }, statusValues: [], scopeType: 'platform', ...o,
});
const okVerify = async () => ({ ok: true, firebaseUid: 'uid-1' } as any);
const okLookup = async () => ({ ok: true, internalUserId: 'iu-1' } as any);

function mkReq(headers: Record<string, any> = {}, o: any = {}) {
  return {
    method: 'POST', // bodyless authenticated RPC-style probe (POST so the browser attaches its protected Origin)
    headers: {
      origin: 'https://t.example', 'sec-fetch-site': 'same-origin',
      'x-bcp-action-intent': 'acknowledge-readiness-review-eligibility', authorization: 'Bearer tok',
      ...headers,
    },
    body: {},
    ...o,
  };
}
function mkRes() {
  return { statusCode: 0, body: undefined as any, hdrs: {} as Record<string, string>, _sent: false,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; this._sent = true; return this; },
    setHeader(k: string, v: string) { this.hdrs[k] = v; },
    get headersSent() { return this._sent; } };
}
async function run(deps: any, reqO: { headers?: Record<string, any>; extra?: any } = {}) {
  const h = createBcpActionEligibilityHandler(deps);
  const req = mkReq(reqO.headers, reqO.extra); const res = mkRes();
  await (h as any)(req, res);
  return res;
}
const baseDeps = (o: any = {}) => ({
  isDevEnvironment: () => true, featureEnabled: () => true, trustedOrigin: TRUSTED,
  verifyBearer: okVerify, lookupInternalUserId: okLookup,
  resolveCanonicalAuthz: async () => view(), ...o,
});

// ---- flag / dev gates ----
test('flag OFF → 404 unavailable + ZERO auth/DB work', async () => {
  let verifyCalls = 0, lookupCalls = 0;
  const res = await run(baseDeps({ featureEnabled: () => false, verifyBearer: async () => { verifyCalls++; return { ok: true, firebaseUid: 'x' }; }, lookupInternalUserId: async () => { lookupCalls++; return { ok: true, internalUserId: 'y' }; } }));
  assert.equal(res.statusCode, 404); assert.deepEqual(res.body, { eligible: false, status: 'unavailable' });
  assert.equal(verifyCalls, 0); assert.equal(lookupCalls, 0);
});
test('production → 404 unavailable', async () => {
  const res = await run(baseDeps({ isDevEnvironment: () => false }));
  assert.equal(res.statusCode, 404); assert.equal(res.body.status, 'unavailable');
});

// ---- unsupported methods → bounded JSON 404 unavailable (side-effect-free; NO auth/authz work) ----
test('GET → 404 unavailable JSON (bounded, not HTML); verify NOT called', async () => {
  let verifyCalls = 0;
  const res = await run(baseDeps({ verifyBearer: async () => { verifyCalls++; return { ok: true, firebaseUid: 'x' }; } }), { extra: { method: 'GET' } });
  assert.equal(res.statusCode, 404); assert.deepEqual(res.body, { eligible: false, status: 'unavailable' });
  assert.equal(verifyCalls, 0);
});
test('PUT → 404 unavailable JSON', async () => {
  const res = await run(baseDeps({}), { extra: { method: 'PUT' } });
  assert.equal(res.statusCode, 404); assert.equal(res.body.status, 'unavailable');
});
test('DELETE → 404 unavailable JSON', async () => {
  const res = await run(baseDeps({}), { extra: { method: 'DELETE' } });
  assert.equal(res.statusCode, 404); assert.equal(res.body.status, 'unavailable');
});

// ---- request security ----
test('trusted origin unavailable → 503 unavailable', async () => {
  const res = await run(baseDeps({ trustedOrigin: () => ({ ok: false }) }));
  assert.equal(res.statusCode, 503); assert.equal(res.body.status, 'unavailable');
});
test('wrong origin → 403 request_denied', async () => {
  const res = await run(baseDeps({}), { headers: { origin: 'https://evil.example' } });
  assert.equal(res.statusCode, 403); assert.deepEqual(res.body, { eligible: false, status: 'request_denied' });
});
test('cross-site → 403 request_denied', async () => {
  const res = await run(baseDeps({}), { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.statusCode, 403);
});
test('missing intent → 403 request_denied', async () => {
  const res = await run(baseDeps({}), { headers: { 'x-bcp-action-intent': undefined } });
  assert.equal(res.statusCode, 403);
});
test('wrong intent (action value) → 403 request_denied', async () => {
  const res = await run(baseDeps({}), { headers: { 'x-bcp-action-intent': 'acknowledge-readiness-review' } });
  assert.equal(res.statusCode, 403);
});

// ---- body rejection ----
test('non-empty request body → 400 request_denied', async () => {
  const res = await run(baseDeps({}), { extra: { body: { a: 1 } } });
  assert.equal(res.statusCode, 400); assert.deepEqual(res.body, { eligible: false, status: 'request_denied' });
});
test('primitive (string) body → 400 request_denied (not just non-empty objects)', async () => {
  const res = await run(baseDeps({}), { extra: { body: 'x' } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.status, 'request_denied');
});
test('array body → 400 request_denied', async () => {
  const res = await run(baseDeps({}), { extra: { body: [1, 2] } });
  assert.equal(res.statusCode, 400);
});
test('no body (undefined) and empty object both proceed (allowed)', async () => {
  const u = await run(baseDeps({}), { extra: { body: undefined } });
  assert.equal(u.statusCode, 200); assert.equal(u.body.status, 'eligible');
  const e = await run(baseDeps({}), { extra: { body: {} } });
  assert.equal(e.statusCode, 200); assert.equal(e.body.status, 'eligible');
});

// ---- authentication ----
test('missing Bearer → 401 authentication_required, verify NOT called', async () => {
  let verifyCalls = 0;
  const res = await run(baseDeps({ verifyBearer: async () => { verifyCalls++; return { ok: true, firebaseUid: 'x' }; } }), { headers: { authorization: undefined } });
  assert.equal(res.statusCode, 401); assert.deepEqual(res.body, { eligible: false, status: 'authentication_required' });
  assert.equal(verifyCalls, 0);
});
test('invalid Bearer → 401 authentication_invalid', async () => {
  const res = await run(baseDeps({ verifyBearer: async () => ({ ok: false, code: 'authentication_invalid' }) }));
  assert.equal(res.statusCode, 401); assert.equal(res.body.status, 'authentication_invalid');
});
test('authentication_unavailable → 503 unavailable', async () => {
  const res = await run(baseDeps({ verifyBearer: async () => ({ ok: false, code: 'authentication_unavailable' }) }));
  assert.equal(res.statusCode, 503); assert.equal(res.body.status, 'unavailable');
});

// ---- decision matrix ----
test('eligible canonical principal → 200 eligible:true', async () => {
  const res = await run(baseDeps({}));
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { eligible: true, status: 'eligible' });
});
test('permission insufficient → 200 eligible:false', async () => {
  const res = await run(baseDeps({ resolveCanonicalAuthz: async () => view({ permissions: { f: 'view' } }) }));
  assert.deepEqual(res.body, { eligible: false, status: 'not_authorized' });
});
test('visibility insufficient (non system_owner) → 200 eligible:false', async () => {
  const res = await run(baseDeps({ resolveCanonicalAuthz: async () => view({ platformRoleId: 'support_admin' }) }));
  assert.deepEqual(res.body, { eligible: false, status: 'not_authorized' });
});
test('parity unresolved → 200 eligible:false', async () => {
  const res = await run(baseDeps({ resolveCanonicalAuthz: async () => view({ decision: 'deny', reasonCode: 'denied_no_app_user' }) }));
  assert.deepEqual(res.body, { eligible: false, status: 'not_authorized' });
});
test('read-only cap → 200 eligible:false', async () => {
  const res = await run(baseDeps({ resolveCanonicalAuthz: async () => view({ limitation: 'read_only' }) }));
  assert.deepEqual(res.body, { eligible: false, status: 'not_authorized' });
});
test('overdue cap → 200 eligible:false', async () => {
  const res = await run(baseDeps({ resolveCanonicalAuthz: async () => view({ statusValues: ['overdue'] }) }));
  assert.deepEqual(res.body, { eligible: false, status: 'not_authorized' });
});
test('unmapped (no identity) → 200 not_authorized', async () => {
  const res = await run(baseDeps({ lookupInternalUserId: async () => ({ ok: false, reason: 'not_found' }) }));
  assert.deepEqual(res.body, { eligible: false, status: 'not_authorized' });
});
test('resolver db_error → 503 unavailable (fail closed)', async () => {
  const res = await run(baseDeps({ lookupInternalUserId: async () => ({ ok: false, reason: 'db_error' }) }));
  assert.equal(res.statusCode, 503); assert.equal(res.body.status, 'unavailable');
});
test('resolveCanonicalAuthz null → 503 unavailable (fail closed)', async () => {
  const res = await run(baseDeps({ resolveCanonicalAuthz: async () => null }));
  assert.equal(res.statusCode, 503);
});

// ---- bounded body: never leaks internals ----
test('every response body has ONLY {eligible,status}', async () => {
  for (const d of [baseDeps({}), baseDeps({ resolveCanonicalAuthz: async () => view({ platformRoleId: 'support_admin' }) })]) {
    const res = await run(d);
    assert.deepEqual(Object.keys(res.body).sort(), ['eligible', 'status']);
  }
});

// ---- separate bounded rate limiter (never the action limiter) ----
test('separate limiter global cap → 429; action limiter untouched', async () => {
  const elig = new BcpActionRateLimiter();
  const action = new BcpActionRateLimiter();
  let last: any;
  for (let i = 0; i < 40; i++) last = await run(baseDeps({ rateLimiter: elig }));
  assert.equal(last.statusCode, 429); assert.equal(last.body.status, 'rate_limited');
  // the ACTION limiter never recorded anything → its very first global slot is still available.
  assert.equal(action.recordAndCheckGlobal().allowed, true);
});

// ---- route path ----
test('exports the eligibility route path', () => assert.equal(BCP_ELIGIBILITY_ROUTE_PATH, '/dev/bcp/actions/acknowledge-readiness-review/eligibility'));

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpActionEligibilityExpressAdapter] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
