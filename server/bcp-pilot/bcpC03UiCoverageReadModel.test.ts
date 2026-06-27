// Phase 2.0 M12 — Tests for the pure C-03 UI coverage read model / DTO builder.
//
// Self-contained, DB-FREE, network-FREE, NO port binding. Runnable via
// `npx tsx server/bcp-pilot/bcpC03UiCoverageReadModel.test.ts`. Proves the builder is pure, no-throw,
// deterministic, defensive against malformed/hostile input, and that it redacts every unsafe value.

import assert from 'node:assert/strict';
import {
  buildC03UiCoverageEnvelope,
  C03_UI_COVERAGE_SCHEMA_VERSION_V1,
  type C03UiCoverageEntryInput,
} from './bcpC03UiCoverageReadModel';

const GOOD: C03UiCoverageEntryInput = {
  screenKey: 'c03-ui-coverage-preview', screenLabel: 'C-03 UI Coverage Preview', screenStatus: 'implemented',
  coverageClass: 'preview_card', previewCardStatus: 'implemented', clientStatus: 'implemented',
  routeStatus: 'implemented', dataSourceClass: 'code_config_only', devGatePosture: 'dev_only',
  productionPosture: 'production_disabled', readOnlyPosture: 'read_only', mutationPosture: 'no_mutation',
  exposurePosture: 'backend_cp_internal_only', evidenceStatus: 'transport_verified',
};

const SENSITIVE_RE = /:\/\/|@|\bsecret\b|token|password|service_role|supabase|postgres|tenant_|store_|customer_|identity_link|audit_|permission_|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{4,}/i;

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

test('v1 schemaVersion', () => { assert.equal(buildC03UiCoverageEnvelope([GOOD]).schemaVersion, C03_UI_COVERAGE_SCHEMA_VERSION_V1); });
test('sourceMode code_config', () => { assert.equal(buildC03UiCoverageEnvelope([GOOD]).sourceMode, 'code_config'); });
test('freshness code-config-no-live-read', () => { assert.equal(buildC03UiCoverageEnvelope([GOOD]).freshness.lastSuccessfulReadLabel, 'code-config-no-live-read'); });
test('warnings code_config', () => { assert.deepEqual(buildC03UiCoverageEnvelope([GOOD]).warnings, ['code_config']); });
test('summary counts match input', () => {
  const env = buildC03UiCoverageEnvelope([GOOD, { ...GOOD, screenStatus: 'blocked' }, { ...GOOD, screenStatus: 'preview' }]);
  assert.deepEqual(env.summaryCounts, { total: 3, implemented: 1, preview: 1, placeholder: 0, deferred: 0, blocked: 1, unknown: 0 });
});
test('non-empty input ⇒ emptyState false / none', () => {
  const env = buildC03UiCoverageEnvelope([GOOD]);
  assert.equal(env.emptyState.isEmpty, false); assert.equal(env.emptyState.reason, 'none');
});
test('empty input ⇒ safe emptyState', () => {
  const env = buildC03UiCoverageEnvelope([]);
  assert.equal(env.emptyState.isEmpty, true); assert.equal(env.emptyState.reason, 'no_ui_coverage_entries');
  assert.equal(env.coverageItems.length, 0);
});
test('malformed input is no-throw (non-array, nulls, primitives, arrays)', () => {
  assert.doesNotThrow(() => buildC03UiCoverageEnvelope(undefined as unknown as C03UiCoverageEntryInput[]));
  const env = buildC03UiCoverageEnvelope([null, 42, 'x', [], GOOD] as unknown as C03UiCoverageEntryInput[]);
  assert.equal(env.coverageItems.length, 1); // only GOOD survives
});
test('unsafe labels are redacted', () => {
  const env = buildC03UiCoverageEnvelope([{ ...GOOD, screenKey: 'tok_secret', screenLabel: 'a@b.com' }]);
  assert.equal(env.coverageItems[0].screenKey, 'redacted_label');
  assert.equal(env.coverageItems[0].screenLabel, 'redacted_label');
});
test('whitespace-only labels redacted', () => {
  assert.equal(buildC03UiCoverageEnvelope([{ ...GOOD, screenLabel: '   ' }]).coverageItems[0].screenLabel, 'redacted_label');
});
test('overlong labels redacted', () => {
  assert.equal(buildC03UiCoverageEnvelope([{ ...GOOD, screenLabel: 'x'.repeat(65) }]).coverageItems[0].screenLabel, 'redacted_label');
});
test('domain/email/token/secret/DB-url labels redacted', () => {
  for (const bad of ['db.internal.acme', 'a@b.co', 'bearer xyz', 'service_role', 'postgres://x', 'my-secret']) {
    assert.equal(buildC03UiCoverageEnvelope([{ ...GOOD, screenLabel: bad }]).coverageItems[0].screenLabel, 'redacted_label', bad);
  }
});
test('UUID / long hex / long digit labels redacted', () => {
  for (const bad of ['12345678-1234-1234-1234-123456789abc', 'deadbeefdeadbeef0', '1234567']) {
    assert.equal(buildC03UiCoverageEnvelope([{ ...GOOD, screenKey: bad }]).coverageItems[0].screenKey, 'redacted_label', bad);
  }
});
test('source filenames redacted', () => {
  assert.equal(buildC03UiCoverageEnvelope([{ ...GOOD, screenLabel: 'screens.tsx' }]).coverageItems[0].screenLabel, 'redacted_label');
});
test('raw object / non-string field values become safe fallbacks', () => {
  const env = buildC03UiCoverageEnvelope([{ ...GOOD, screenKey: { a: 1 } as unknown, screenStatus: { x: 1 } as unknown }]);
  assert.equal(env.coverageItems[0].screenKey, 'redacted_label');
  assert.equal(env.coverageItems[0].screenStatus, 'unknown');
});
test('unknown enum values normalize to unknown', () => {
  const env = buildC03UiCoverageEnvelope([{ ...GOOD, screenStatus: 'HACKED', coverageClass: 'evil', exposurePosture: 'no_customer_facing_exposure' }]);
  assert.equal(env.coverageItems[0].screenStatus, 'unknown');
  assert.equal(env.coverageItems[0].coverageClass, 'unknown');
  // the customer_-shaped value is NOT an accepted exposure enum ⇒ falls back to 'unknown' (never emitted raw)
  assert.equal(env.coverageItems[0].exposurePosture, 'unknown');
});
test('throwing getters do not abort the build', () => {
  const hostile = {} as Record<string, unknown>;
  Object.defineProperty(hostile, 'screenLabel', { enumerable: true, get() { throw new Error('boom'); } });
  hostile.screenKey = 'safe-key';
  assert.doesNotThrow(() => buildC03UiCoverageEnvelope([hostile as C03UiCoverageEntryInput, GOOD]));
});
test('no raw errors / stacks in output', () => {
  const env = buildC03UiCoverageEnvelope([GOOD]);
  const json = JSON.stringify(env);
  assert.ok(!/stack|Error:|at Object\.|\.ts:\d+/.test(json));
});
test('serialized output scan is clean of sensitive shapes (data items)', () => {
  const env = buildC03UiCoverageEnvelope([GOOD, { ...GOOD, screenStatus: 'blocked' }]);
  const itemsJson = JSON.stringify(env.coverageItems);
  assert.ok(!SENSITIVE_RE.test(itemsJson), 'sensitive shape in coverageItems');
});
test('deterministic output', () => { assert.deepEqual(buildC03UiCoverageEnvelope([GOOD]), buildC03UiCoverageEnvelope([GOOD])); });

(() => {
  let pass = 0; const failures: string[] = [];
  for (const c of cases) { try { c.fn(); pass++; console.log('PASS ' + c.name); } catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } }
  console.log(`\n[M12 BCP C-03 UI coverage read model] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
