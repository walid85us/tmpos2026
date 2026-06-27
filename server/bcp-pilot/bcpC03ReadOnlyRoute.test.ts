// Phase 2.0 M12 — Tests for the inert C-03 UI coverage route boundary handler.
//
// Self-contained, DB-FREE, network-FREE, NO port binding. Runnable via
// `npx tsx server/bcp-pilot/bcpC03ReadOnlyRoute.test.ts`. Proves gate order, GET-only semantics,
// server-sourced authority, and that request fields are never authority.

import assert from 'node:assert/strict';
import { handleBcpC03UiCoverageRequest, type BcpC03RouteRequest } from './bcpC03ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { C03UiCoverageEntryInput } from './bcpC03UiCoverageReadModel';

const PRINCIPAL: SyntheticServerPrincipal = {
  source: 'server_derived', internalUserId: 'iu_synthetic_dev', authProvider: 'supabase',
  verified: true, scopeType: 'platform', parityState: 'ready', visibilityClass: 'overview_viewer',
};
const ENTRIES: C03UiCoverageEntryInput[] = [{
  screenKey: 'c03-ui-coverage-preview', screenLabel: 'C-03 UI Coverage Preview', screenStatus: 'preview',
  coverageClass: 'preview_card', previewCardStatus: 'implemented', clientStatus: 'implemented',
  routeStatus: 'implemented', dataSourceClass: 'code_config_only', devGatePosture: 'dev_only',
  productionPosture: 'production_disabled', readOnlyPosture: 'read_only', mutationPosture: 'no_mutation',
  exposurePosture: 'backend_cp_internal_only', evidenceStatus: 'transport_verified',
}];
const base = (over: Partial<BcpC03RouteRequest> = {}): BcpC03RouteRequest => ({
  method: 'GET', isDevEnvironment: true, featureEnabled: true, principal: PRINCIPAL, entries: ENTRIES, ...over,
});

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

test('GET success returns a C-03 v1 envelope', () => {
  const r = handleBcpC03UiCoverageRequest(base());
  assert.equal(r.httpStatus, 200); assert.equal(r.category, 'success');
  const b = r.body as Record<string, unknown>;
  assert.equal(b.schemaVersion, 'bcp.c03.ui-coverage-readiness.v1-code-config');
});
test('GET success uses sourceMode code_config', () => {
  const b = handleBcpC03UiCoverageRequest(base()).body as Record<string, unknown>;
  assert.equal(b.sourceMode, 'code_config');
});
test('GET success uses freshness code-config-no-live-read', () => {
  const b = handleBcpC03UiCoverageRequest(base()).body as unknown as Record<string, { lastSuccessfulReadLabel: string }>;
  assert.equal(b.freshness.lastSuccessfulReadLabel, 'code-config-no-live-read');
});
test('feature disabled ⇒ safe unavailable (404)', () => {
  const r = handleBcpC03UiCoverageRequest(base({ featureEnabled: false }));
  assert.equal(r.httpStatus, 404); assert.equal(r.category, 'feature_disabled');
  assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' });
});
test('production / non-dev ⇒ safe dev_only (404), checked before flag', () => {
  const r = handleBcpC03UiCoverageRequest(base({ isDevEnvironment: false, featureEnabled: false }));
  assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only');
});
test('unauthorized (null principal) ⇒ 403', () => {
  const r = handleBcpC03UiCoverageRequest(base({ principal: null }));
  assert.equal(r.httpStatus, 403); assert.equal(r.category, 'not_authorized');
});
test('parity unresolved ⇒ 409 blocked', () => {
  const r = handleBcpC03UiCoverageRequest(base({ principal: { ...PRINCIPAL, parityState: 'unresolved' } }));
  assert.equal(r.httpStatus, 409); assert.equal(r.category, 'parity_blocked');
});
test('HEAD ⇒ 200 bodyless', () => {
  const r = handleBcpC03UiCoverageRequest(base({ method: 'HEAD' }));
  assert.equal(r.httpStatus, 200); assert.equal(r.body, null);
});
test('OPTIONS ⇒ 204 with Allow: GET', () => {
  const r = handleBcpC03UiCoverageRequest(base({ method: 'OPTIONS' }));
  assert.equal(r.httpStatus, 204); assert.equal(r.headers?.Allow, 'GET'); assert.equal(r.body, null);
});
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${m} ⇒ 405 method_not_allowed`, () => {
    const r = handleBcpC03UiCoverageRequest(base({ method: m }));
    assert.equal(r.httpStatus, 405); assert.equal(r.category, 'method_not_allowed');
  });
}
test('provider entries are reflected only on allowed GET (gates run first)', () => {
  // Flag off: even with entries supplied, no envelope/body data is produced.
  const r = handleBcpC03UiCoverageRequest(base({ featureEnabled: false }));
  assert.equal((r.body as Record<string, unknown>).schemaVersion, undefined);
});
test('request hints are never authority (hostile hints with valid principal still succeed unchanged)', () => {
  const r = handleBcpC03UiCoverageRequest(base({ hints: { clientSuppliedUid: 'evil', email: 'a@b.co', frontendRoleLabel: 'admin' } }));
  assert.equal(r.httpStatus, 200);
});
test('hostile hints WITHOUT a server principal are denied (not promoted to authority)', () => {
  const r = handleBcpC03UiCoverageRequest(base({ principal: null, hints: { clientSuppliedUid: 'evil' } }));
  assert.equal(r.httpStatus, 403);
});
test('no raw errors / stacks in any response body', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
    const json = JSON.stringify(handleBcpC03UiCoverageRequest(base({ method: m })).body);
    assert.ok(!/stack|Error:|at Object\./.test(json));
  }
});
test('handler is no-throw on hostile entries (throwing getter)', () => {
  const hostile = {} as Record<string, unknown>;
  Object.defineProperty(hostile, 'screenKey', { enumerable: true, get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => handleBcpC03UiCoverageRequest(base({ entries: [hostile as C03UiCoverageEntryInput] })));
});
test('success envelope counts match supplied entries', () => {
  const b = handleBcpC03UiCoverageRequest(base()).body as unknown as Record<string, { total: number }>;
  assert.equal(b.summaryCounts.total, ENTRIES.length);
});
test('non-GET in production ⇒ 404 dev_only (DEV gate precedes the method gate)', () => {
  const r = handleBcpC03UiCoverageRequest(base({ method: 'POST', isDevEnvironment: false }));
  assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only');
});
test('empty server entries ⇒ safe empty envelope (still 200)', () => {
  const r = handleBcpC03UiCoverageRequest(base({ entries: [] }));
  assert.equal(r.httpStatus, 200);
  const b = r.body as unknown as Record<string, { isEmpty: boolean }>;
  assert.equal(b.emptyState.isEmpty, true);
});

(() => {
  let pass = 0; const failures: string[] = [];
  for (const c of cases) { try { c.fn(); pass++; console.log('PASS ' + c.name); } catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } }
  console.log(`\n[M12 BCP C-03 route] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
