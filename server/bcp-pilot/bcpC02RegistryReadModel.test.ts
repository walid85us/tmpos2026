// Phase 2.0 M8C — Tests for the C-02 backend registry-readiness read model + DTO/envelope.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding (does NOT import server.ts).
// Tests the pure builder directly. Runnable via `npx tsx <thisfile>`. No real ids/secrets — synthetic
// placeholders only. Does NOT import src/, MODULES, or any sensitive mock-row type/data.

import assert from 'node:assert/strict';
import * as readModelModule from './bcpC02RegistryReadModel';
import {
  buildC02RegistryReadinessEnvelope,
  C02_REGISTRY_SCHEMA_VERSION_V1,
  C02_REGISTRY_SCHEMA_VERSION_V0,
  type C02RegistryModuleInput,
  type C02RegistryReadinessEnvelope,
} from './bcpC02RegistryReadModel';

const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;

// Forbidden substrings that must never appear anywhere in a serialized envelope.
const FORBIDDEN_TOKENS = [
  'postgres://', 'Bearer', 'eyJ', 'service_role', '@', '://', 'supabase', 'getDb',
];
// Sensitive field/shape markers that must never appear as keys or values.
const FORBIDDEN_SHAPE_RE =
  /tenant|store|customer|identity_link|identitylink|audit|provider_uid|internal_user|permission|entitlement|mismatch|\.tsx?|\/dev\/|createClient|process\.env/i;

// A small SAFE synthetic registry mirroring the id/name/status SHAPE only (no real data, not imported MODULES).
const SAFE_REGISTRY: C02RegistryModuleInput[] = [
  { id: 'access-gate', name: 'Separate Access Gate', status: 'included' },
  { id: 'command-center', name: 'Command Center', status: 'included' },
  { id: 'operations-console', name: 'Operations Console', status: 'placeholder' },
  { id: 'future-lens', name: 'Future Lens', status: 'deferred' },
  { id: 'database-control', name: 'Database Control', status: 'blocked' },
];

// Allowed key sets (allow-list — proves no tenant/store/audit/DB field can appear).
const ENVELOPE_KEYS = [
  'schemaVersion', 'sourceMode', 'generatedAt', 'freshness', 'summaryCounts', 'registryItems',
  'emptyState', 'warnings', 'redactionPosture', 'routePosture', 'productionPosture',
  'mutationPosture', 'evidenceLabels',
].sort();
const ITEM_KEYS = [
  'moduleKey', 'moduleLabel', 'moduleStatus', 'sourceMode', 'routeBoundaryCategory', 'devGatePosture',
  'productionPosture', 'readOnlyPosture', 'mutationPosture', 'testCoveragePosture', 'dtoSchemaPosture',
  'uiPreviewPosture', 'dataSourceClass', 'redactionPosture', 'rbacVisibilityPosture',
  'implementationStatus', 'evidenceStatus',
].sort();

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

const build = (mods: C02RegistryModuleInput[] = SAFE_REGISTRY) => buildC02RegistryReadinessEnvelope(mods);

// 1.
test('v1 code/config DTO schemaVersion is correct', () => {
  assert.equal(build().schemaVersion, C02_REGISTRY_SCHEMA_VERSION_V1);
  assert.equal(build().schemaVersion, 'bcp.c02.registry-readiness.v1-code-config');
});

// 2.
test('sourceMode is code_config (default path)', () => {
  assert.equal(build().sourceMode, 'code_config');
});

// 3.
test('freshness is code-config-no-live-read', () => {
  assert.equal(build().freshness.lastSuccessfulReadLabel, 'code-config-no-live-read');
});

// 4.
test('warnings include code_config', () => {
  assert.ok(build().warnings.includes('code_config'));
});

// 5.
test('summary counts are bounded and derived from safe module inputs', () => {
  const e = build();
  assert.equal(e.summaryCounts.total, SAFE_REGISTRY.length);
  assert.equal(e.summaryCounts.included, 2);
  assert.equal(e.summaryCounts.placeholder, 1);
  assert.equal(e.summaryCounts.deferred, 1);
  assert.equal(e.summaryCounts.blocked, 1);
  assert.equal(e.summaryCounts.unknown, 0);
  // Bounded: every count is between 0 and total.
  for (const v of Object.values(e.summaryCounts)) {
    assert.ok(Number.isInteger(v) && v >= 0 && v <= e.summaryCounts.total + 0);
  }
  // Sum of status buckets equals total.
  const { included, placeholder, deferred, blocked, unknown } = e.summaryCounts;
  assert.equal(included + placeholder + deferred + blocked + unknown, e.summaryCounts.total);
});

// 6.
test('registry items contain only safe labels/enums/booleans/bounded values', () => {
  for (const item of build().registryItems) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
    for (const [k, v] of Object.entries(item)) {
      if (k === 'readOnlyPosture') { assert.equal(typeof v, 'boolean'); continue; }
      assert.equal(typeof v, 'string', `field ${k} must be a string label`);
      assert.ok(SAFE_LABEL_RE.test(String(v)), `field ${k} not a safe bounded label: ${String(v)}`);
    }
  }
});

// 7.
test('valid module id/name/status are sanitized (pass through safely)', () => {
  const item = build([{ id: 'access-gate', name: 'Separate Access Gate', status: 'included' }]).registryItems[0];
  assert.equal(item.moduleKey, 'access-gate');
  assert.equal(item.moduleLabel, 'Separate Access Gate');
  assert.equal(item.moduleStatus, 'included');
});

// 8.
test('unsafe module id/name/status values become redacted_label or safe enum fallback', () => {
  const item = build([{ id: 'a@b.com', name: 'x'.repeat(200), status: 'hacker' }]).registryItems[0];
  assert.equal(item.moduleKey, 'redacted_label');
  assert.equal(item.moduleLabel, 'redacted_label');
  assert.equal(item.moduleStatus, 'unknown');
});

// 9.
test('whitespace-only values are redacted', () => {
  const item = build([{ id: '   ', name: '\t\n ', status: 'included' }]).registryItems[0];
  assert.equal(item.moduleKey, 'redacted_label');
  assert.equal(item.moduleLabel, 'redacted_label');
});

// 10.
test('secret-like strings are redacted', () => {
  for (const s of ['my-secret-key', 'service_role', 'app_password_123']) {
    assert.equal(build([{ id: s, name: 'n', status: 'included' }]).registryItems[0].moduleKey, 'redacted_label', s);
  }
});

// 11.
test('email-like strings are redacted', () => {
  assert.equal(build([{ id: 'user@example.com', name: 'n', status: 'included' }]).registryItems[0].moduleKey, 'redacted_label');
});

// 12.
test('DB URL-like strings are redacted', () => {
  for (const s of ['postgres://host/db', 'postgresql://u:p@h/db']) {
    assert.equal(build([{ id: s, name: 'n', status: 'included' }]).registryItems[0].moduleKey, 'redacted_label', s);
  }
});

// 13.
test('token-like strings are redacted', () => {
  for (const s of ['Bearer eyJabc', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'sk_live_abcdef0123456789abcdef']) {
    assert.equal(build([{ id: s, name: 'n', status: 'included' }]).registryItems[0].moduleKey, 'redacted_label', s);
  }
});

// 14.
test('raw route paths are not emitted as item internals (no slashes / no raw path)', () => {
  const s = JSON.stringify(build());
  assert.ok(!/\/dev\/bcp|\/__identity|registry-readiness\/|readiness-summary/.test(s), 'raw route path leaked');
  for (const item of build().registryItems) {
    assert.ok(!item.routeBoundaryCategory.includes('/'), 'routeBoundaryCategory must be a category, not a path');
    // It is a bounded category label, not a route internal.
    assert.ok(SAFE_LABEL_RE.test(item.routeBoundaryCategory));
  }
});

// 15.
test('raw source filenames are not emitted', () => {
  const s = JSON.stringify(build());
  assert.ok(!/\.tsx?\b/.test(s), 'source filename leaked');
});

// 16.
test('synthetic sensitive mock-row types/data are not used (no row-shaped keys/values in output)', () => {
  const s = JSON.stringify(build());
  for (const marker of ['TenantRow', 'StoreRow', 'AuditRow', 'DatabaseRow', 'PermissionRow', 'isolation', 'dbStatus', 'lastAudit']) {
    assert.ok(!s.includes(marker), `sensitive mock-row marker leaked: ${marker}`);
  }
});

// 17.
test('empty module input returns safe emptyState (no throw, no invented modules)', () => {
  const e = build([]);
  assert.equal(e.emptyState.isEmpty, true);
  assert.equal(e.emptyState.reason, 'no_modules');
  assert.equal(e.registryItems.length, 0);
  assert.equal(e.summaryCounts.total, 0);
});

// 18.
test('malformed module input does not throw raw errors', () => {
  const hostile = [null, undefined, 123, 'str', [], { id: {}, name: [], status: true }] as unknown as C02RegistryModuleInput[];
  let env: C02RegistryReadinessEnvelope | undefined;
  assert.doesNotThrow(() => { env = buildC02RegistryReadinessEnvelope(hostile); });
  // Only the single object entry is processed; its bad fields are sanitized.
  assert.equal(env!.registryItems.length, 1);
  assert.equal(env!.registryItems[0].moduleKey, 'redacted_label');
  assert.equal(env!.registryItems[0].moduleStatus, 'unknown');
  // Non-array input is handled safely too.
  assert.doesNotThrow(() => buildC02RegistryReadinessEnvelope(null as unknown as C02RegistryModuleInput[]));
  assert.equal(buildC02RegistryReadinessEnvelope(null as unknown as C02RegistryModuleInput[]).summaryCounts.total, 0);
});

// 19.
test('DTO does not include tenant/store/customer/audit/identity fields', () => {
  const e = build();
  assert.deepEqual(Object.keys(e).sort(), ENVELOPE_KEYS);
  const s = JSON.stringify(e);
  assert.ok(!FORBIDDEN_SHAPE_RE.test(s), 'forbidden sensitive shape/marker leaked');
});

// 20.
test('DTO does not include DB/Supabase/provider/live fields', () => {
  const s = JSON.stringify(build()).toLowerCase();
  for (const bad of ['createclient', '@supabase', 'getdb', 'process.env.database', 'connectionstring', 'live_read', 'liveread']) {
    assert.ok(!s.includes(bad), `forbidden db/supabase/provider marker leaked: ${bad}`);
  }
});

// 21.
test('mutation posture is no-mutation / read-only', () => {
  const e = build();
  assert.equal(e.mutationPosture, 'none');
  for (const item of e.registryItems) {
    assert.equal(item.mutationPosture, 'none');
    assert.equal(item.readOnlyPosture, true);
  }
});

// 22.
test('production posture is production-disabled', () => {
  const e = build();
  assert.equal(e.productionPosture, 'production_disabled');
  for (const item of e.registryItems) assert.equal(item.productionPosture, 'production_disabled');
});

// 23.
test('route posture states not-registered / planned DEV-only without claiming registration', () => {
  const rp = build().routePosture;
  assert.ok(rp.includes('not_registered'), `route posture must state not-registered: ${rp}`);
  assert.ok(rp.includes('dev_only'), `route posture must state dev-only: ${rp}`);
  assert.ok(!/\bregistered\b(?!_)/.test(rp.replace('not_registered', '')), 'must not claim active registration');
});

// 24.
test('no current route/API behavior exists in M8C (builder is the only callable; no handler/app/router export)', () => {
  // The module exports only the builder + types/consts — no Express app, router, or request handler.
  // (Type-only exports are erased at runtime; this asserts the runtime surface.)
  const mod = readModelModule as Record<string, unknown>;
  assert.equal(typeof mod.buildC02RegistryReadinessEnvelope, 'function');
  for (const forbidden of ['createHandler', 'handler', 'app', 'router', 'register', 'listen', 'createApp']) {
    assert.ok(!(forbidden in mod), `unexpected runtime export suggests wiring: ${forbidden}`);
  }
});

// 25.
test('generatedAt is deterministic (fixed safe stamp; same input → equal)', () => {
  assert.equal(build().generatedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(build(), build());
});

// 26.
test('unknown/hostile options cannot cause unsafe output', () => {
  const hostileOpts = [{ mode: 'hacker' }, { mode: 123 }, { mode: null }, {}, undefined, 'x'] as unknown as never[];
  for (const o of hostileOpts) {
    const e = buildC02RegistryReadinessEnvelope(SAFE_REGISTRY, o);
    // Unknown mode falls back to code_config (the safe default); never an unsafe value.
    assert.equal(e.sourceMode, 'code_config');
    assert.equal(e.schemaVersion, C02_REGISTRY_SCHEMA_VERSION_V1);
    assert.ok(SAFE_LABEL_RE.test(e.sourceMode));
  }
});

// 27.
test('no raw object dumps: every emitted value is a string, boolean, number count, or bounded array', () => {
  const e = build();
  const scan = (v: unknown, path: string) => {
    if (v === null) assert.fail(`null leaked at ${path}`);
    const t = typeof v;
    if (t === 'string' || t === 'boolean' || t === 'number') return;
    if (Array.isArray(v)) { v.forEach((x, i) => scan(x, `${path}[${i}]`)); return; }
    if (t === 'object') {
      // Only the known nested objects are allowed (freshness, summaryCounts, emptyState, items).
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) scan(val, `${path}.${k}`);
      return;
    }
    assert.fail(`unexpected type ${t} at ${path}`);
  };
  scan(e, 'envelope');
});

// 28.
test('serialized DTO contains no forbidden sensitive patterns', () => {
  for (const mode of ['code_config', 'synthetic'] as const) {
    const s = JSON.stringify(buildC02RegistryReadinessEnvelope(SAFE_REGISTRY, { mode }));
    for (const bad of FORBIDDEN_TOKENS) assert.ok(!s.includes(bad), `forbidden token leaked (${mode}): ${bad}`);
    assert.ok(!FORBIDDEN_SHAPE_RE.test(s), `forbidden shape leaked (${mode})`);
  }
});

// --- Optional v0 synthetic-path compatibility (M8B contract) ---
test('v0 synthetic path declares honest synthetic schema/sourceMode/freshness/warnings', () => {
  const e = buildC02RegistryReadinessEnvelope(SAFE_REGISTRY, { mode: 'synthetic' });
  assert.equal(e.schemaVersion, C02_REGISTRY_SCHEMA_VERSION_V0);
  assert.equal(e.schemaVersion, 'bcp.c02.registry-readiness.v0-synthetic');
  assert.equal(e.sourceMode, 'synthetic');
  assert.equal(e.freshness.lastSuccessfulReadLabel, 'synthetic-no-live-read');
  assert.deepEqual(e.warnings, ['synthetic']);
  for (const item of e.registryItems) {
    assert.equal(item.sourceMode, 'synthetic');
    assert.equal(item.dataSourceClass, 'synthetic');
    assert.equal(item.dtoSchemaPosture, 'v0_synthetic');
  }
});

// --- Honest posture evidence labels ---
test('evidence labels truthfully describe M8C posture (no live read; nothing wired)', () => {
  const labels = build().evidenceLabels;
  for (const required of [
    'code_config_only', 'no_live_source', 'read_only', 'no_mutation', 'production_disabled',
    'route_not_registered', 'ui_not_implemented', 'read_model_only',
  ]) {
    assert.ok(labels.includes(required), `missing honest evidence label: ${required}`);
  }
  for (const l of labels) assert.ok(SAFE_LABEL_RE.test(l), `unsafe evidence label: ${l}`);
});

// --- Hardening: hostile getters / proxies must not throw and must yield safe output ---
test('throwing getters / revoked proxies on entries and options do not throw; output stays safe', () => {
  const throwingEntry = {} as Record<string, unknown>;
  for (const k of ['id', 'name', 'status']) {
    Object.defineProperty(throwingEntry, k, { enumerable: true, get() { throw new Error('boom ' + k); } });
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile = [
    throwingEntry,
    revoked.proxy,
    { id: 'access-gate', name: 'Safe Module', status: 'included' }, // one genuinely-safe entry survives
  ] as unknown as C02RegistryModuleInput[];

  let env: C02RegistryReadinessEnvelope | undefined;
  assert.doesNotThrow(() => { env = buildC02RegistryReadinessEnvelope(hostile); });
  // The throwing-getter entry is sanitized to a fully-redacted item (never throws/leaks); the revoked
  // proxy is skipped (its Array.isArray probe throws and is caught); the safe entry passes through.
  assert.equal(env!.registryItems.length, 2);
  assert.ok(env!.registryItems.some((i) => i.moduleKey === 'access-gate'), 'safe entry survives');
  const redacted = env!.registryItems.find((i) => i.moduleKey !== 'access-gate')!;
  assert.equal(redacted.moduleKey, 'redacted_label');
  assert.equal(redacted.moduleLabel, 'redacted_label');
  assert.equal(redacted.moduleStatus, 'unknown');
  // Poisoned options (throwing `mode` getter) must not throw and must fall back to code_config.
  const poisonOpts = {} as Record<string, unknown>;
  Object.defineProperty(poisonOpts, 'mode', { get() { throw new Error('boom mode'); } });
  let env2: C02RegistryReadinessEnvelope | undefined;
  assert.doesNotThrow(() => { env2 = buildC02RegistryReadinessEnvelope(SAFE_REGISTRY, poisonOpts as never); });
  assert.equal(env2!.sourceMode, 'code_config');
  // No forbidden token leaked from any hostile path.
  const s = JSON.stringify(env) + JSON.stringify(env2);
  for (const bad of FORBIDDEN_TOKENS) assert.ok(!s.includes(bad), `forbidden token leaked: ${bad}`);
  assert.ok(!/boom|Error:|\bat \b/.test(s), 'a raw error/stack trace leaked into output');
});

test('UUIDs and separator-chunked / prefixed raw IDs are redacted', () => {
  for (const id of [
    '550e8400-e29b-41d4-a716-446655440000', // uuid
    'cus_123456789',                         // stripe-style customer id
    'user_12345',                            // raw user id
    'acct_99887766',                         // account id
    'sk-live-abcd-efgh-ijkl-mnop',           // secret key (separator-chunked)
    'pk_test_0001',                          // publishable key
    '0001112223',                            // long digit run (phone/id-shaped)
  ]) {
    assert.equal(
      build([{ id, name: 'n', status: 'included' }]).registryItems[0].moduleKey,
      'redacted_label',
      `should redact: ${id}`,
    );
  }
  // Genuine kebab module keys are NOT over-redacted.
  for (const ok of ['access-gate', 'command-center', 'operations-console', 'database-control']) {
    assert.equal(build([{ id: ok, name: 'n', status: 'included' }]).registryItems[0].moduleKey, ok, `should keep: ${ok}`);
  }
});

test('sensitive row/key shape markers, dotted hosts, and source filenames are redacted', () => {
  for (const v of [
    'tenant_acme', 'store_01x', 'customer_acme', 'internal_user_x', 'provider_uid_x',
    'identity_link_x', 'audit_trail', 'permission_key', 'entitlement_key', 'mismatch_list',
    'internal.corp.example', 'host.sub.example', // dotted hosts / domains
    'screens.tsx', 'config.json', 'secrets.env',  // source filenames
  ]) {
    assert.equal(
      build([{ id: v, name: v, status: 'included' }]).registryItems[0].moduleKey,
      'redacted_label',
      `should redact: ${v}`,
    );
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
  console.log(`\n[M8C BCP C-02 registry read model] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
