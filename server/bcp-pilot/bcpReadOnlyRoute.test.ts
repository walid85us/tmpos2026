// Phase 2.0 M7E — Unit tests for the INERT BCP DEV-only read-only route boundary handler.
//
// Self-contained, in-memory, DB-FREE, Supabase-FREE, network-FREE. Runnable via `npx tsx <thisfile>`.
// Tests the PURE handler function directly (no express, no server startup) — full HTTP registration
// is deferred by design (see bcpReadOnlyRoute.ts). NO real ids/uids/emails/tokens/secrets.

import assert from 'node:assert/strict';
import { isBcpDevReadonlyPilotEnabled, BCP_DEV_READONLY_PILOT_FLAG } from './bcpPilotConfig';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import {
  handleBcpReadinessSummaryRequest,
  type BcpRouteRequest,
} from './bcpReadOnlyRoute';

const principal = (over: Partial<SyntheticServerPrincipal> = {}): SyntheticServerPrincipal => ({
  source: 'server_derived',
  internalUserId: 'iu_synthetic_0001',
  authProvider: 'supabase',
  verified: true,
  scopeType: 'platform',
  parityState: 'ready',
  visibilityClass: 'overview_viewer',
  ...over,
});

const req = (over: Partial<BcpRouteRequest> = {}): BcpRouteRequest => ({
  method: 'GET',
  isDevEnvironment: true,
  featureEnabled: true,
  principal: principal(),
  syntheticSource: { categories: [{ category: 'identity_readiness', status: 'gated', severity: 'medium' }] },
  ...over,
});

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

// ---- Flag default-off / DEV-only / production-disabled (boundary uses the real flag helper) ----
test('flag-off ⇒ route unavailable (feature_disabled, no data)', () => {
  const r = handleBcpReadinessSummaryRequest(req({ featureEnabled: false }));
  assert.equal(r.httpStatus, 404);
  assert.equal(r.category, 'feature_disabled');
  assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' });
});
test('outside DEV ⇒ route unavailable (dev_only, no data)', () => {
  const r = handleBcpReadinessSummaryRequest(req({ isDevEnvironment: false }));
  assert.equal(r.httpStatus, 404);
  assert.equal(r.category, 'dev_only');
});
test('production-disabled: real flag helper returns false under NODE_ENV=production even if set true', () => {
  const prev = process.env[BCP_DEV_READONLY_PILOT_FLAG];
  const prevNode = process.env.NODE_ENV;
  try {
    process.env[BCP_DEV_READONLY_PILOT_FLAG] = 'true';
    process.env.NODE_ENV = 'production';
    const featureEnabled = isBcpDevReadonlyPilotEnabled();
    assert.equal(featureEnabled, false);
    const r = handleBcpReadinessSummaryRequest(req({ featureEnabled, isDevEnvironment: false }));
    assert.equal(r.category, 'dev_only');
  } finally {
    if (prev === undefined) delete process.env[BCP_DEV_READONLY_PILOT_FLAG];
    else process.env[BCP_DEV_READONLY_PILOT_FLAG] = prev;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  }
});

// ---- Method handling: GET-only, mutation rejected, HEAD/OPTIONS safe ----
test('GET returns a synthetic success envelope', () => {
  const r = handleBcpReadinessSummaryRequest(req());
  assert.equal(r.httpStatus, 200);
  assert.equal(r.category, 'synthetic_success');
  assert.ok(r.body && 'schemaVersion' in r.body);
});

test('M7O: GET without envelopeMeta keeps the legacy v0-synthetic envelope (back-compat)', () => {
  const r = handleBcpReadinessSummaryRequest(req());
  const body = r.body as { schemaVersion?: string; sourceMode?: string; warnings?: string[] };
  assert.equal(body.schemaVersion, 'bcp.c01.readiness.v0-synthetic');
  assert.deepEqual(body.warnings, ['synthetic']);
  assert.equal('sourceMode' in (r.body as object), false);
});

test('M7O: GET with code/config envelopeMeta returns the honest v1 envelope', () => {
  const r = handleBcpReadinessSummaryRequest(req({
    envelopeMeta: { schemaVersion: 'bcp.c01.readiness.v1-code-config', sourceMode: 'code_config', warnings: ['code_config'], lastSuccessfulReadLabel: 'code-config-no-live-read' },
  }));
  assert.equal(r.httpStatus, 200);
  const body = r.body as { schemaVersion?: string; sourceMode?: string; warnings?: string[]; freshness?: { lastSuccessfulReadLabel?: string } };
  assert.equal(body.schemaVersion, 'bcp.c01.readiness.v1-code-config');
  assert.equal(body.sourceMode, 'code_config');
  assert.deepEqual(body.warnings, ['code_config']);
  assert.equal(body.freshness?.lastSuccessfulReadLabel, 'code-config-no-live-read');
});
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${m} is rejected (405, no side effect, no data)`, () => {
    const r = handleBcpReadinessSummaryRequest(req({ method: m }));
    assert.equal(r.httpStatus, 405);
    assert.equal(r.category, 'method_not_allowed');
    assert.equal(r.headers?.Allow, 'GET');
    assert.deepEqual(r.body, { status: 'method_not_allowed' });
  });
}
test('OPTIONS ⇒ 204, Allow: GET, no body', () => {
  const r = handleBcpReadinessSummaryRequest(req({ method: 'OPTIONS' }));
  assert.equal(r.httpStatus, 204);
  assert.equal(r.category, 'no_content');
  assert.equal(r.headers?.Allow, 'GET');
  assert.equal(r.body, null);
});
test('HEAD ⇒ same status as GET but never a body', () => {
  const r = handleBcpReadinessSummaryRequest(req({ method: 'HEAD' }));
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body, null);
});
// Gate order: dev/flag gates run BEFORE method handling, so no method discloses the route when off.
test('OPTIONS when flag-off ⇒ unavailable (not 204) — no method disclosure', () => {
  const r = handleBcpReadinessSummaryRequest(req({ method: 'OPTIONS', featureEnabled: false }));
  assert.equal(r.httpStatus, 404);
  assert.equal(r.category, 'feature_disabled');
});
test('OPTIONS outside DEV ⇒ unavailable (not 204)', () => {
  const r = handleBcpReadinessSummaryRequest(req({ method: 'OPTIONS', isDevEnvironment: false }));
  assert.equal(r.httpStatus, 404);
  assert.equal(r.category, 'dev_only');
});
test('POST when flag-off ⇒ unavailable (not 405) — no route existence disclosure', () => {
  const r = handleBcpReadinessSummaryRequest(req({ method: 'POST', featureEnabled: false }));
  assert.equal(r.httpStatus, 404);
  assert.equal(r.category, 'feature_disabled');
});
test('method matching is case-insensitive (get)', () => {
  const r = handleBcpReadinessSummaryRequest(req({ method: 'get' }));
  assert.equal(r.httpStatus, 200);
  assert.equal(r.category, 'synthetic_success');
});

// ---- Fail-closed authorization ----
test('missing principal ⇒ not_authorized (403, uniform)', () => {
  const r = handleBcpReadinessSummaryRequest(req({ principal: null }));
  assert.equal(r.httpStatus, 403);
  assert.equal(r.category, 'not_authorized');
  assert.deepEqual(r.body, { status: 'not_authorized' });
});
test('unverified principal ⇒ not_authorized', () => {
  const r = handleBcpReadinessSummaryRequest(req({ principal: principal({ verified: false }) }));
  assert.equal(r.category, 'not_authorized');
});
test('null internalUserId ⇒ not_authorized (fail closed)', () => {
  const r = handleBcpReadinessSummaryRequest(req({ principal: principal({ internalUserId: null }) }));
  assert.equal(r.category, 'not_authorized');
});
test('insufficient visibility ⇒ not_authorized', () => {
  const r = handleBcpReadinessSummaryRequest(req({ principal: principal({ visibilityClass: 'none' }) }));
  assert.equal(r.category, 'not_authorized');
});

// ---- Forbidden authority inputs ignored ----
test('client UID / email / body / query hints never authorize on their own', () => {
  const r = handleBcpReadinessSummaryRequest(
    req({
      principal: null,
      hints: { clientSuppliedUid: 'x', email: 'a@b.test', frontendRoleLabel: 'system_owner', urlTenantParam: 't', bodyInternalUserId: 'iu' },
    }),
  );
  assert.equal(r.category, 'not_authorized');
});
test('untrusted hints do not change an authorized GET', () => {
  const r = handleBcpReadinessSummaryRequest(req({ hints: { clientSuppliedUid: 'x', frontendRoleLabel: 'system_owner' } }));
  assert.equal(r.category, 'synthetic_success');
});

// ---- Parity-blocked ----
test('unresolved parity ⇒ parity_blocked (409, no data)', () => {
  const r = handleBcpReadinessSummaryRequest(req({ principal: principal({ parityState: 'unresolved' }) }));
  assert.equal(r.httpStatus, 409);
  assert.equal(r.category, 'parity_blocked');
  assert.deepEqual(r.body, { status: 'parity_blocked' });
});

// ---- Redacted / safe response shape; forbidden fields absent ----
test('synthetic success returns an already-redacted envelope with no forbidden values', () => {
  const r = handleBcpReadinessSummaryRequest(
    req({
      syntheticSource: {
        secret: 'SHOULD_NOT_LEAK',
        tenantId: 't_raw_123',
        email: 'leak@example.test',
        categories: [{ category: 'system_ops', status: 'ok', severity: 'low', token: 'SHOULD_NOT_LEAK', dbUrl: 'postgres://leak' }],
      },
    }),
  );
  const serialized = JSON.stringify(r.body);
  for (const needle of ['SHOULD_NOT_LEAK', 't_raw_123', 'leak@example.test', 'postgres://leak']) {
    assert.ok(!serialized.includes(needle), `forbidden value leaked: ${needle}`);
  }
});
test('safe error / disabled responses never carry stack traces, SQL, paths, or claims', () => {
  const samples = [
    handleBcpReadinessSummaryRequest(req({ featureEnabled: false })),
    handleBcpReadinessSummaryRequest(req({ principal: null })),
    handleBcpReadinessSummaryRequest(req({ method: 'POST' })),
  ];
  for (const r of samples) {
    const s = JSON.stringify(r.body);
    for (const bad of ['Error', 'at ', 'SELECT', '/home/', 'stack', 'Bearer', 'eyJ']) {
      assert.ok(!s.includes(bad), `leaked internal token "${bad}" in ${s}`);
    }
  }
});

// ---- Empty-state still safe ----
test('empty synthetic source ⇒ success envelope with null data + safe empty-state', () => {
  const r = handleBcpReadinessSummaryRequest(req({ syntheticSource: { categories: [] } }));
  assert.equal(r.category, 'synthetic_success');
  assert.ok(r.body && 'emptyState' in r.body && (r.body as { data: unknown }).data === null);
});

// ---- Malformed synthetic source is handled safely (no 500), proving the no-throw harness contract ----
test('malformed categories element ⇒ safe synthetic_success (no safe_error), bad element dropped', () => {
  const r = handleBcpReadinessSummaryRequest(
    req({ syntheticSource: { categories: [null, { category: 'ok', status: 'ok', severity: 'low' }] } as never }),
  );
  assert.equal(r.category, 'synthetic_success');
  assert.notEqual(r.category, 'safe_error');
});

// ---- Rollback/disable: flipping the gate input off instantly disables ----
test('rollback: toggling featureEnabled false re-disables the route', () => {
  const on = handleBcpReadinessSummaryRequest(req({ featureEnabled: true }));
  const off = handleBcpReadinessSummaryRequest(req({ featureEnabled: false }));
  assert.equal(on.category, 'synthetic_success');
  assert.equal(off.category, 'feature_disabled');
});

// ---- Runner ----
(() => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      c.fn();
      pass++;
      console.log('PASS ' + c.name);
    } catch (e) {
      failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e)));
      console.log('FAIL ' + c.name);
    }
  }
  console.log(`\n[M7E BCP inert DEV-only route boundary] ${pass}/${cases.length} passed`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
