// Phase 2.0 M7K — Tests for the DEV-only code/config C-01 Readiness Summary posture source.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding (does NOT import server.ts).
// Tests the pure builder directly and its integration through the existing M7C/M7E envelope path.
// Runnable via `npx tsx <thisfile>`. No real ids/secrets — synthetic placeholders only.

import assert from 'node:assert/strict';
import { buildC01CodeConfigSource, C01_CODE_CONFIG_ENVELOPE_META } from './bcpC01CodeConfigReadModel';
import { buildReadinessSummaryEnvelope } from './bcpReadinessSummaryHarness';
import type { GuardResult } from './bcpAuthorizationGuard';

const ROUTE = '/dev/bcp/readiness-summary';
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const ALLOW: GuardResult = { decision: 'allow', reasonCode: 'allow' };

// Forbidden tokens that must never appear anywhere in the source/envelope.
const FORBIDDEN_TOKENS = ['postgres://', 'Bearer', 'eyJ', 'service_role', '@'];
// Forbidden source KEY names (mirrors the harness FORBIDDEN_KEY_CATEGORY map).
const FORBIDDEN_KEYS = [
  'rawId', 'internalUserId', 'tenantId', 'storeId', 'customerId', 'email', 'providerUid',
  'authProviderUid', 'identityLinkRow', 'secret', 'token', 'accessToken', 'refreshToken',
  'dbUrl', 'databaseUrl', 'paymentId', 'cardNumber', 'permissionKeys', 'entitlementKeys',
  'mismatchList', 'rawAuditEvent',
];

const cats = (src: ReturnType<typeof buildC01CodeConfigSource>) =>
  (Array.isArray(src.categories) ? src.categories : []) as Array<Record<string, unknown>>;
const catNames = (src: ReturnType<typeof buildC01CodeConfigSource>) =>
  cats(src).map((c) => String(c.category));
const statusOf = (src: ReturnType<typeof buildC01CodeConfigSource>, name: string) => {
  const c = cats(src).find((x) => x.category === name);
  return c ? String(c.status) : undefined;
};

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

const devEnabled = () => buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: true });

test('returns a plain object with a categories array (synchronous, not a promise)', () => {
  const src = buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: true });
  assert.equal(typeof src, 'object');
  assert.ok(!(src instanceof Promise));
  assert.ok(Array.isArray(src.categories));
  assert.ok(cats(src).length >= 5);
});

test('every category/status is a safe bounded label; severity in {low,medium,high}', () => {
  for (const c of cats(devEnabled())) {
    assert.ok(SAFE_LABEL_RE.test(String(c.category)), `bad category label: ${String(c.category)}`);
    assert.ok(SAFE_LABEL_RE.test(String(c.status)), `bad status label: ${String(c.status)}`);
    assert.ok(['low', 'medium', 'high'].includes(String(c.severity)), `bad severity: ${String(c.severity)}`);
  }
});

test('includes S-1 through S-5 posture categories', () => {
  const names = catNames(devEnabled());
  for (const required of [
    'feature_flag_posture',
    'route_registration_posture',
    'production_disabled_posture',
    'redaction_posture',
    'synthetic_live_boundary_posture',
  ]) {
    assert.ok(names.includes(required), `missing S-category: ${required}`);
  }
});

test('feature_flag_posture reflects featureEnabled input', () => {
  assert.equal(statusOf(buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: true }), 'feature_flag_posture'), 'enabled');
  assert.equal(statusOf(buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: false }), 'feature_flag_posture'), 'disabled');
});

test('synthetic_live_boundary_posture is code_config_only (not synthetic stub, not live data)', () => {
  assert.equal(statusOf(devEnabled(), 'synthetic_live_boundary_posture'), 'code_config_only');
});

test('S-10 parity_posture is a static/config/deferred label only (never live)', () => {
  const s = statusOf(devEnabled(), 'parity_posture');
  assert.ok(['static_config', 'deferred'].includes(String(s)), `parity must be static/deferred, got: ${String(s)}`);
});

test('S-2 route_registration_posture: ready when path constant present, guarded when empty', () => {
  assert.equal(statusOf(buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: true }), 'route_registration_posture'), 'ready');
  assert.equal(statusOf(buildC01CodeConfigSource({ routePath: '', isDevEnvironment: true, featureEnabled: true }), 'route_registration_posture'), 'guarded');
});

test('S-3 production_disabled_posture: production_disabled in dev, blocked when not dev', () => {
  assert.equal(statusOf(buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: true }), 'production_disabled_posture'), 'production_disabled');
  assert.equal(statusOf(buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: false, featureEnabled: true }), 'production_disabled_posture'), 'blocked');
});

test('S-11 blocked: NO DB/Supabase/count/tenant/store/customer category is emitted', () => {
  for (const n of catNames(devEnabled())) {
    assert.ok(!/db|supabase|count|tenant|store|customer/i.test(n), `forbidden source category leaked: ${n}`);
  }
});

test('S-12 out of scope: NO identity_link/audit/permission/entitlement category is emitted', () => {
  for (const n of catNames(devEnabled())) {
    assert.ok(!/identity_link|identitylink|audit|permission|entitlement|mismatch/i.test(n), `out-of-scope category leaked: ${n}`);
  }
});

test('S-7/S-8 not emitted as runtime categories (test/typecheck never run at request time)', () => {
  const names = catNames(devEnabled());
  assert.ok(!names.includes('test_posture'));
  assert.ok(!names.includes('typecheck_posture'));
});

test('no forbidden key names and no forbidden tokens anywhere in the source', () => {
  const src = devEnabled();
  // No forbidden top-level keys.
  for (const k of FORBIDDEN_KEYS) assert.ok(!(k in src), `forbidden top-level key present: ${k}`);
  // No forbidden keys inside any category.
  for (const c of cats(src)) for (const k of FORBIDDEN_KEYS) assert.ok(!(k in c), `forbidden category key present: ${k}`);
  // No forbidden tokens in the serialized source.
  const s = JSON.stringify(src);
  for (const bad of FORBIDDEN_TOKENS) assert.ok(!s.includes(bad), `forbidden token leaked: ${bad}`);
});

test('M7O: code/config envelope meta declares honest, safe v1 values', () => {
  const m = C01_CODE_CONFIG_ENVELOPE_META;
  assert.equal(m.schemaVersion, 'bcp.c01.readiness.v1-code-config');
  assert.equal(m.sourceMode, 'code_config');
  assert.deepEqual(m.warnings, ['code_config']);
  assert.equal(m.lastSuccessfulReadLabel, 'code-config-no-live-read');
  // Every meta string is a safe bounded label (and not 'synthetic').
  for (const v of [m.schemaVersion, m.sourceMode, m.lastSuccessfulReadLabel, ...(m.warnings ?? [])]) {
    assert.ok(typeof v === 'string' && SAFE_LABEL_RE.test(v), `unsafe meta label: ${String(v)}`);
    assert.ok(!String(v).includes('synthetic'), `meta should not say synthetic: ${String(v)}`);
  }
});

test('deterministic: same input yields equal output', () => {
  const a = buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: true });
  const b = buildC01CodeConfigSource({ routePath: ROUTE, isDevEnvironment: true, featureEnabled: true });
  assert.deepEqual(a, b);
});

test('integration: source feeds the existing envelope safely (allow guard)', () => {
  const env = buildReadinessSummaryEnvelope(
    ALLOW,
    devEnabled(),
    { visibilityClass: 'overview_viewer', scopeType: 'platform', parityState: 'ready' },
    '2026-01-01T00:00:00.000Z',
    'DEV',
  );
  // Envelope carries the posture categories, redaction applied, no forbidden omissions.
  assert.ok(env.data && Array.isArray(env.data.categories) && env.data.categories.length >= 5);
  assert.equal(env.redaction.redactionApplied, true);
  assert.deepEqual(env.redaction.omittedCategories, []); // no forbidden keys ⇒ nothing omitted
  assert.equal(env.emptyState.isEmpty, false);
  // The mapper copies ONLY allow-listed fields — prove no raw passthrough leaked.
  for (const c of env.data.categories) {
    assert.deepEqual(Object.keys(c).sort(), ['category', 'severity', 'status']);
  }
  // No forbidden token anywhere in the serialized envelope.
  const s = JSON.stringify(env);
  for (const bad of FORBIDDEN_TOKENS) assert.ok(!s.includes(bad), `forbidden token leaked in envelope: ${bad}`);
});

// ---- Runner ----
(() => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try { c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M7K BCP C-01 code/config read model] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
