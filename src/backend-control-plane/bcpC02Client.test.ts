// Phase 2.0 M8F — Tests for the DEV-only C-02 registry-readiness client + safe view-model.
//
// Self-contained, NETWORK-FREE (fetch is injected), DB-FREE, Supabase-FREE. Runnable via `npx tsx`.
// Covers classification, the safe-label boundary (malicious payloads never leak), bounded counts,
// version-tolerance, and that the fetch is GET-only with no body / no credentials / no identity fields.

import assert from 'node:assert/strict';
import {
  classifyC02Response,
  safeLabel,
  safeCount,
  fetchC02RegistryReadiness,
  C02_REGISTRY_READINESS_URL,
} from './bcpC02Client';

// A minimal valid success envelope (mirrors the M8C C-02 builder output shape).
const envelope = {
  schemaVersion: 'bcp.c02.registry-readiness.v1-code-config',
  sourceMode: 'code_config',
  generatedAt: '2026-01-01T00:00:00.000Z',
  freshness: { lastSuccessfulReadLabel: 'code-config-no-live-read' },
  summaryCounts: { total: 2, included: 1, placeholder: 1, deferred: 0, blocked: 0, unknown: 0 },
  registryItems: [
    { moduleKey: 'access-gate', moduleLabel: 'Separate Access Gate', moduleStatus: 'included', routeBoundaryCategory: 'dev_isolated_api', devGatePosture: 'dev_only_default_off', productionPosture: 'production_disabled', readOnlyPosture: true, mutationPosture: 'none', testCoveragePosture: 'planned', dtoSchemaPosture: 'v1_code_config', uiPreviewPosture: 'not_implemented', dataSourceClass: 'code_config', redactionPosture: 'safe_labels_only', rbacVisibilityPosture: 'system_owner_only', implementationStatus: 'read_model_only', evidenceStatus: 'read_model_tests' },
    { moduleKey: 'ops-console', moduleLabel: 'Operations Console', moduleStatus: 'placeholder', readOnlyPosture: true, mutationPosture: 'none' },
  ],
  emptyState: { isEmpty: false, reason: 'none' },
  warnings: ['code_config'],
  redactionPosture: 'safe_labels_only',
  routePosture: 'not_registered_dev_only_planned',
  productionPosture: 'production_disabled',
  mutationPosture: 'none',
  evidenceLabels: ['code_config_only', 'no_live_source', 'read_only', 'no_mutation', 'production_disabled'],
};

const emptyEnvelope = {
  schemaVersion: 'bcp.c02.registry-readiness.v1-code-config',
  sourceMode: 'code_config',
  generatedAt: '2026-01-01T00:00:00.000Z',
  freshness: { lastSuccessfulReadLabel: 'code-config-no-live-read' },
  summaryCounts: { total: 0, included: 0, placeholder: 0, deferred: 0, blocked: 0, unknown: 0 },
  registryItems: [],
  emptyState: { isEmpty: true, reason: 'no_modules' },
  warnings: ['code_config'],
  redactionPosture: 'safe_labels_only', routePosture: 'not_registered_dev_only_planned',
  productionPosture: 'production_disabled', mutationPosture: 'none', evidenceLabels: ['code_config_only'],
};

const FORBIDDEN = ['postgres://', 'Bearer', 'eyJ', 'service_role', '@', 'iu_', '://', 'supabase'];

// Recording fake fetch.
interface Recorded { url: string; init: RequestInit | undefined; }
function makeFetch(status: number, body: unknown, rec?: Recorded[]) {
  return async (url: unknown, init?: RequestInit): Promise<Response> => {
    rec?.push({ url: String(url), init });
    return {
      status,
      json: async () => { if (body === '__nonjson__') throw new Error('not json'); return body; },
    } as unknown as Response;
  };
}

const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn });

// 2 + 30.
test('proxy URL is the /__identity dev path; no production endpoint', () => {
  assert.equal(C02_REGISTRY_READINESS_URL, '/__identity/dev/bcp/registry-readiness');
  assert.ok(!/^https?:\/\//.test(C02_REGISTRY_READINESS_URL), 'must be same-origin dev proxy, not absolute');
});

// 1 + 3 + 4 + 5 + 6 + 7.
test('fetch is GET-only, no body, credentials omit, no auth/identity/authority fields', async () => {
  const rec: Recorded[] = [];
  await fetchC02RegistryReadiness({ fetchImpl: makeFetch(200, envelope, rec) as unknown as typeof fetch });
  assert.equal(rec.length, 1);
  const init = rec[0].init!;
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.equal((init as { body?: unknown }).body, undefined);
  const headers = (init.headers ?? {}) as Record<string, string>;
  assert.ok(!('authorization' in Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))));
  const serialized = JSON.stringify(rec[0]);
  for (const bad of ['principal', 'modules', 'mode', 'sourceMode', 'schemaVersion', 'uid', 'email', 'tenant', 'store', 'customer']) {
    assert.ok(!serialized.toLowerCase().includes(bad.toLowerCase()) || bad === 'mode', `client sent forbidden field: ${bad}`);
  }
  // (the URL/path naturally contains none of these authority fields)
});

// 8.
test('successful v1 envelope parses safely', () => {
  const r = classifyC02Response(200, envelope);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.schemaVersion, 'bcp.c02.registry-readiness.v1-code-config');
  assert.equal(r.sourceMode, 'code_config');
  assert.equal(r.freshness, 'code-config-no-live-read');
  assert.equal(r.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].moduleKey, 'access-gate');
  assert.equal(r.items[0].readOnlyPosture, true);
  assert.deepEqual(r.warnings, ['code_config']);
});

// 9.
test('empty registry envelope parses safely (emptyState no_modules, total 0)', () => {
  const r = classifyC02Response(200, emptyEnvelope);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.items.length, 0);
  assert.equal(r.emptyState.isEmpty, true);
  assert.equal(r.emptyState.reason, 'no_modules');
  assert.equal(r.summaryCounts.total, 0);
});

// 10.
test('summaryCounts are bounded and safe (negative/float/huge/non-number => 0)', () => {
  assert.equal(safeCount(-5), 0);
  assert.equal(safeCount(1.5), 0);
  assert.equal(safeCount(1e9), 0);
  assert.equal(safeCount('5'), 0);
  assert.equal(safeCount(3), 3);
  const r = classifyC02Response(200, { ...envelope, summaryCounts: { total: -1, included: 2.2, placeholder: 99999999, deferred: 'x', blocked: null, unknown: 1 } });
  if (r.kind !== 'success') return assert.fail();
  assert.deepEqual(r.summaryCounts, { total: 0, included: 0, placeholder: 0, deferred: 0, blocked: 0, unknown: 1 });
});

// 11.
test('registry item safe labels parse safely', () => {
  const r = classifyC02Response(200, envelope);
  if (r.kind !== 'success') return assert.fail();
  const SAFE = /^[A-Za-z0-9_.\- ]{1,64}$|^redacted$/;
  for (const item of r.items) {
    for (const [k, v] of Object.entries(item)) {
      if (k === 'readOnlyPosture') { assert.equal(typeof v, 'boolean'); continue; }
      assert.ok(SAFE.test(String(v)), `unsafe item field ${k}: ${String(v)}`);
    }
  }
});

// 12 + 24 + 25 + 26 + 27 + 28.
test('unsafe / hostile / sensitive module values are redacted', () => {
  const hostile = {
    ...envelope,
    registryItems: [{
      moduleKey: 'a@b.com', moduleLabel: '  ', moduleStatus: 'x'.repeat(200),
      routeBoundaryCategory: 'postgres://h/db', devGatePosture: 'Bearer eyJabc',
      productionPosture: { nested: 'obj' }, readOnlyPosture: 'yes', mutationPosture: 'tenant_acme',
      testCoveragePosture: 'iu_12345', dtoSchemaPosture: 'cus_999', uiPreviewPosture: 'sk_live_x',
      dataSourceClass: 'service_role', redactionPosture: 'a'.repeat(80), rbacVisibilityPosture: 'evil@x.com',
      implementationStatus: '550e8400-e29b-41d4-a716-446655440000', evidenceStatus: '123456',
    }],
  };
  const r = classifyC02Response(200, hostile);
  if (r.kind !== 'success') return assert.fail();
  const it = r.items[0];
  for (const k of Object.keys(it) as (keyof typeof it)[]) {
    if (k === 'readOnlyPosture') { assert.equal(it[k], false, 'non-true readOnlyPosture => false'); continue; }
    assert.equal(it[k], 'redacted', `field ${k} should be redacted, got ${String(it[k])}`);
  }
  const s = JSON.stringify(r);
  for (const bad of FORBIDDEN) assert.ok(!s.includes(bad), `forbidden token leaked: ${bad}`);
});

// 13.
test('unsafe sourceMode is redacted', () => {
  const r = classifyC02Response(200, { ...envelope, sourceMode: 'postgres://leak' });
  if (r.kind !== 'success') return assert.fail();
  assert.equal(r.sourceMode, 'redacted');
});

// 14.
test('unknown schema is parsed safely (version-tolerant)', () => {
  const r = classifyC02Response(200, { ...envelope, schemaVersion: 'bcp.c02.registry-readiness.v9-future' });
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.schemaVersion, 'bcp.c02.registry-readiness.v9-future');
});

// 15-19.
test('error-status responses map to safe states', () => {
  assert.equal(classifyC02Response(404, { status: 'unavailable', reason: 'feature_disabled' }).kind, 'feature_disabled');
  assert.equal(classifyC02Response(404, { status: 'unavailable', reason: 'dev_only' }).kind, 'dev_only');
  assert.equal(classifyC02Response(404, { status: 'unavailable' }).kind, 'unavailable');
  assert.equal(classifyC02Response(403, { status: 'not_authorized' }).kind, 'unauthorized');
  assert.equal(classifyC02Response(409, { status: 'parity_blocked' }).kind, 'parity_blocked');
  assert.equal(classifyC02Response(405, { status: 'method_not_allowed' }).kind, 'method_not_allowed');
  assert.equal(classifyC02Response(500, { status: 'error' }).kind, 'error');
  assert.equal(classifyC02Response(0, null).kind, 'unavailable');
  assert.equal(classifyC02Response(418, {}).kind, 'unexpected');
  assert.equal(classifyC02Response(200, { notAnEnvelope: true }).kind, 'unexpected');
});

// 20.
test('non-JSON response maps to a safe state (not a crash)', async () => {
  const r = await fetchC02RegistryReadiness({ fetchImpl: makeFetch(200, '__nonjson__') as unknown as typeof fetch });
  // 200 with unparseable body => body null => not a success envelope => unexpected (safe).
  assert.ok(['unexpected', 'unavailable'].includes(r.kind), `got ${r.kind}`);
  const r5 = await fetchC02RegistryReadiness({ fetchImpl: makeFetch(503, '__nonjson__') as unknown as typeof fetch });
  assert.equal(r5.kind, 'unavailable');
});

// 21.
test('network failure (throwing fetch) maps to safe unavailable; missing fetch => unavailable', async () => {
  const throwing = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  assert.equal((await fetchC02RegistryReadiness({ fetchImpl: throwing })).kind, 'unavailable');
  assert.equal((await fetchC02RegistryReadiness({ fetchImpl: undefined as unknown as typeof fetch })).kind, 'unavailable');
});

// 22 + 23.
test('raw Error object / stack trace is never exposed in any result', async () => {
  const r = await fetchC02RegistryReadiness({ fetchImpl: (async () => { const e = new Error('boom'); throw e; }) as unknown as typeof fetch });
  const s = JSON.stringify(r);
  assert.ok(!/boom|stack|Error:|\bat \b/.test(s), 'raw error/stack leaked');
});

// 29.
test('generatedAt is bounded/safe (bad timestamp dropped)', () => {
  const r = classifyC02Response(200, { ...envelope, generatedAt: 'not-a-timestamp; DROP TABLE' });
  if (r.kind !== 'success') return assert.fail();
  assert.equal(r.generatedAt, undefined);
});

// safeLabel direct boundary checks.
test('safeLabel redacts non-strings, whitespace, charset/denylist/id-shapes/domains/hex; keeps clean labels', () => {
  for (const bad of [
    null, 42, {}, [], '  ', 'a@b', 'x://y', 'service_role', 'iu_1', 'tenant_a', 'store_1', 'customer_x',
    'mysql', 'mongodb', 'pk_live', 'apikey', 'password', '123456',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'deadbeefcafe1234beef', // 16+ hex run
    'acme.com', 'db.internal.acme', // domain / hostname shapes
    'x'.repeat(100),
  ]) {
    assert.equal(safeLabel(bad as unknown), 'redacted', `should redact: ${String(bad)}`);
  }
  // Genuine bounded enum labels (including the dotted schemaVersion) are NOT over-redacted.
  for (const ok of ['access-gate', 'code_config', 'production_disabled', 'No modules', 'bcp.c02.registry-readiness.v1-code-config', 'code-config-no-live-read']) {
    assert.equal(safeLabel(ok), ok, `should keep: ${ok}`);
  }
});

// success-path serialized scan: no forbidden tokens / sensitive shapes.
test('parsed success result has no forbidden tokens or sensitive shapes', () => {
  const s = JSON.stringify(classifyC02Response(200, envelope));
  for (const bad of FORBIDDEN) assert.ok(!s.includes(bad), `forbidden token: ${bad}`);
  assert.ok(!/tenant|store|customer|identity_link|audit|provider_uid|internal_user|\.tsx?/i.test(s), 'sensitive shape leaked');
});

// ---- Runner ----
(async () => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try { await c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M8F BCP C-02 client] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
