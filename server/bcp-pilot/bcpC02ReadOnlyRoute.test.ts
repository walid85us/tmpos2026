// Phase 2.0 M8D — Tests for the inert C-02 registry-readiness route boundary handler.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding (does NOT import server.ts).
// Tests the pure transport-agnostic handler directly. Runnable via `npx tsx <thisfile>`. No real
// ids/secrets — synthetic placeholders only. Does NOT import src/ or any sensitive mock-row data.

import assert from 'node:assert/strict';
import {
  handleBcpC02RegistryReadinessRequest,
  type BcpC02RouteRequest,
  type BcpC02RouteResponse,
} from './bcpC02ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { C02RegistryModuleInput } from './bcpC02RegistryReadModel';

const FORBIDDEN_TOKENS = ['postgres://', 'Bearer', 'eyJ', 'service_role', '@', '://', 'supabase', 'getDb'];
const FORBIDDEN_SHAPE_RE =
  /tenant|store|customer|identity_link|identitylink|audit|provider_uid|internal_user|permission|entitlement|mismatch|\.tsx?|createClient|process\.env|stack|\bError\b|\bat \b/i;

// SAFE synthetic registry (id/name/status SHAPE only; no real data, not imported MODULES).
const SAFE_REGISTRY: C02RegistryModuleInput[] = [
  { id: 'access-gate', name: 'Separate Access Gate', status: 'included' },
  { id: 'command-center', name: 'Command Center', status: 'included' },
  { id: 'operations-console', name: 'Operations Console', status: 'placeholder' },
];

// A valid server-derived principal that meets C-02 minimum visibility (overview_viewer).
const AUTHORIZED: SyntheticServerPrincipal = {
  source: 'server_derived',
  internalUserId: 'iu_synthetic_dev',
  authProvider: 'supabase',
  verified: true,
  scopeType: 'platform',
  parityState: 'ready',
  visibilityClass: 'overview_viewer',
};

const base = (over: Partial<BcpC02RouteRequest> = {}): BcpC02RouteRequest => ({
  method: 'GET',
  isDevEnvironment: true,
  featureEnabled: true,
  principal: AUTHORIZED,
  modules: SAFE_REGISTRY,
  ...over,
});
const handle = (over: Partial<BcpC02RouteRequest> = {}) => handleBcpC02RegistryReadinessRequest(base(over));

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

// 1.
test('GET success returns C-02 envelope when DEV + enabled + authorized + safe modules', () => {
  const r = handle();
  assert.equal(r.httpStatus, 200);
  assert.equal(r.category, 'success');
  assert.ok(r.body && typeof r.body === 'object' && 'schemaVersion' in (r.body as object));
});

// 2.
test('GET success uses schemaVersion bcp.c02.registry-readiness.v1-code-config', () => {
  const b = handle().body as { schemaVersion?: string };
  assert.equal(b.schemaVersion, 'bcp.c02.registry-readiness.v1-code-config');
});

// 3.
test('GET success uses sourceMode code_config', () => {
  assert.equal((handle().body as { sourceMode?: string }).sourceMode, 'code_config');
});

// 4.
test('GET success uses freshness code-config-no-live-read', () => {
  const b = handle().body as { freshness?: { lastSuccessfulReadLabel?: string } };
  assert.equal(b.freshness?.lastSuccessfulReadLabel, 'code-config-no-live-read');
});

// 5.
test('GET success includes warnings code_config', () => {
  assert.ok(((handle().body as { warnings?: string[] }).warnings ?? []).includes('code_config'));
});

// 6.
test('GET success remains read-only and no-mutation', () => {
  const b = handle().body as { mutationPosture?: string; registryItems?: Array<{ readOnlyPosture?: boolean; mutationPosture?: string }> };
  assert.equal(b.mutationPosture, 'none');
  for (const item of b.registryItems ?? []) {
    assert.equal(item.readOnlyPosture, true);
    assert.equal(item.mutationPosture, 'none');
  }
});

// 7.
test('GET success does not claim route registration (routePosture states not-registered)', () => {
  const rp = (handle().body as { routePosture?: string }).routePosture ?? '';
  assert.ok(rp.includes('not_registered'), `routePosture should state not-registered: ${rp}`);
});

// 8.
test('GET success does not claim UI implementation', () => {
  const b = handle().body as { registryItems?: Array<{ uiPreviewPosture?: string }>; evidenceLabels?: string[] };
  for (const item of b.registryItems ?? []) assert.equal(item.uiPreviewPosture, 'not_implemented');
  assert.ok((b.evidenceLabels ?? []).includes('ui_not_implemented'));
});

const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

// 9.
test('feature-disabled returns safe unavailable response for EVERY method', () => {
  for (const method of ALL_METHODS) {
    const r = handle({ method, featureEnabled: false });
    assert.equal(r.httpStatus, 404, method);
    assert.equal(r.category, 'feature_disabled', method);
    if (method !== 'HEAD') assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' });
    else assert.equal(r.body, null);
  }
});

// 10.
test('production / not-DEV returns safe dev_only response for EVERY method (no existence disclosure)', () => {
  for (const method of ALL_METHODS) {
    const r = handle({ method, isDevEnvironment: false });
    assert.equal(r.httpStatus, 404, method);
    assert.equal(r.category, 'dev_only', method);
    if (method !== 'HEAD') assert.deepEqual(r.body, { status: 'unavailable', reason: 'dev_only' });
    else assert.equal(r.body, null);
  }
});

// 11.
test('unauthorized principal returns safe not_authorized response', () => {
  for (const p of [null, { ...AUTHORIZED, verified: false }, { ...AUTHORIZED, internalUserId: null }, { ...AUTHORIZED, visibilityClass: 'none' as const }]) {
    const r = handle({ principal: p as SyntheticServerPrincipal | null });
    assert.equal(r.httpStatus, 403);
    assert.equal(r.category, 'not_authorized');
    assert.deepEqual(r.body, { status: 'not_authorized' });
  }
});

// 12.
test('parity-unresolved principal returns safe parity_blocked response', () => {
  const r = handle({ principal: { ...AUTHORIZED, parityState: 'unresolved' } });
  assert.equal(r.httpStatus, 409);
  assert.equal(r.category, 'parity_blocked');
  assert.deepEqual(r.body, { status: 'parity_blocked' });
});

// 13.
test('hostile input causing an internal throw is caught and returned as safe error (no stack)', () => {
  // A revoked proxy as principal throws when the guard reads `.source`; the handler must catch it.
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const r = handleBcpC02RegistryReadinessRequest(base({ principal: revoked.proxy as unknown as SyntheticServerPrincipal }));
  assert.equal(r.httpStatus, 500);
  assert.equal(r.category, 'safe_error');
  assert.deepEqual(r.body, { status: 'error' });
  assert.ok(!/stack|Error:|\bat \b/.test(JSON.stringify(r.body)), 'no stack/raw error leaked');
});

// 14-17.
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${method} returns 405 method_not_allowed with Allow: GET and no side effect`, () => {
    const r = handle({ method });
    assert.equal(r.httpStatus, 405);
    assert.equal(r.category, 'method_not_allowed');
    assert.equal(r.headers?.Allow, 'GET');
    assert.deepEqual(r.body, { status: 'method_not_allowed' });
  });
}

// 18.
test('HEAD is safe and bodyless (200, no body)', () => {
  const r = handle({ method: 'HEAD' });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.category, 'success');
  assert.equal(r.body, null);
});

// 19.
test('OPTIONS is safe (204, Allow: GET, no body)', () => {
  const r = handle({ method: 'OPTIONS' });
  assert.equal(r.httpStatus, 204);
  assert.equal(r.category, 'no_content');
  assert.equal(r.headers?.Allow, 'GET');
  assert.equal(r.body, null);
});

// 20.
test('no raw Error object or stack trace appears in any serialized response', () => {
  const responses: BcpC02RouteResponse[] = [
    handle(), handle({ method: 'HEAD' }), handle({ method: 'OPTIONS' }), handle({ method: 'POST' }),
    handle({ featureEnabled: false }), handle({ isDevEnvironment: false }), handle({ principal: null }),
    handle({ principal: { ...AUTHORIZED, parityState: 'unresolved' } }),
  ];
  for (const r of responses) {
    assert.ok(!/stack|Error:|\bat \b/.test(JSON.stringify(r.body)), `raw error/stack in ${r.category}`);
  }
});

// 21 / 22 / 23.
test('success body exposes no tenant/store/customer/identity/audit, DB/Supabase/provider, or raw IDs/secrets', () => {
  const s = JSON.stringify(handle().body);
  assert.ok(!FORBIDDEN_SHAPE_RE.test(s), 'forbidden sensitive shape/marker leaked');
  for (const bad of FORBIDDEN_TOKENS) assert.ok(!s.includes(bad), `forbidden token leaked: ${bad}`);
  // Only the safe negated posture labels mention live/db/supabase concepts.
  const b = handle().body as { evidenceLabels?: string[] };
  for (const l of b.evidenceLabels ?? []) assert.ok(/^[A-Za-z0-9_.\- ]{1,64}$/.test(l));
});

// 24.
test('route handler is transport-agnostic (works on a plain object; no Express required)', () => {
  const r = handleBcpC02RegistryReadinessRequest({
    method: 'GET', isDevEnvironment: true, featureEnabled: true, principal: AUTHORIZED, modules: SAFE_REGISTRY,
  });
  assert.equal(r.httpStatus, 200);
});

// 25.
test('route handler does not mutate the input modules', () => {
  const input: C02RegistryModuleInput[] = [{ id: 'access-gate', name: 'Separate Access Gate', status: 'included' }];
  const before = JSON.stringify(input);
  handle({ modules: input });
  assert.equal(JSON.stringify(input), before, 'input modules were mutated');
});

// Gate precedence: the DEV gate must precede authorization — an unauthenticated caller in production
// gets uniform dev_only (404), never a 403 that would disclose the route exists.
test('DEV gate precedes authorization: not-DEV + null principal => 404 dev_only (not 403)', () => {
  const r = handle({ isDevEnvironment: false, principal: null });
  assert.equal(r.httpStatus, 404);
  assert.equal(r.category, 'dev_only');
  assert.deepEqual(r.body, { status: 'unavailable', reason: 'dev_only' });
});

// Non-authority hints must never grant access or influence the response.
test('request hints are never authority (a null principal with hints is still denied)', () => {
  const r = handle({
    principal: null,
    hints: { clientSuppliedUid: 'uid-attacker', email: 'evil@example.com', frontendRoleLabel: 'system_owner' },
  });
  assert.equal(r.httpStatus, 403);
  assert.equal(r.category, 'not_authorized');
  const s = JSON.stringify(r.body);
  for (const bad of ['uid-attacker', 'evil@example.com', 'system_owner', '@']) {
    assert.ok(!s.includes(bad), `hint value leaked: ${bad}`);
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
  console.log(`\n[M8D BCP C-02 inert route boundary] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
