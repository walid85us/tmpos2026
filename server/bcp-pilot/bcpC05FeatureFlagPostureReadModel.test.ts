// Phase 2.0 M17 — Tests for the PURE C-05 feature-flag-posture read model / DTO builder.
import assert from 'node:assert/strict';
import {
  buildC05FeatureFlagPostureEnvelope,
  C05_FEATURE_FLAG_POSTURE_SCHEMA_VERSION_V1,
  type C05FeatureFlagPostureEntryInput,
} from './bcpC05FeatureFlagPostureReadModel';
import { getBcpC05FeatureFlagPostureEntries, assertBcpC05NoValueOracleFields } from './bcpC05FeatureFlagPostureProvider';

const ITEM_KEYS = ['flagKey', 'flagName', 'flagPurpose', 'ownerSurface', 'defaultPosture', 'devGatePosture', 'productionPosture', 'exposurePosture', 'dataSourcePosture', 'valueExposurePosture', 'mutationPosture', 'evidenceStatus'].sort();
const E = () => getBcpC05FeatureFlagPostureEntries();
const build = (x: readonly C05FeatureFlagPostureEntryInput[]) => buildC05FeatureFlagPostureEnvelope(x);

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('schemaVersion is the v1 code-config schema', () => assert.equal(build(E()).schemaVersion, C05_FEATURE_FLAG_POSTURE_SCHEMA_VERSION_V1));
test('sourceMode is code_config', () => assert.equal(build(E()).sourceMode, 'code_config'));
test('freshness is code-config-no-live-read', () => assert.equal(build(E()).freshness.lastSuccessfulReadLabel, 'code-config-no-live-read'));
test('warnings is [code_config]', () => assert.deepEqual(build(E()).warnings, ['code_config']));
test('generatedAt is a fixed synthetic constant (no runtime oracle)', () => { assert.equal(build(E()).generatedAt, '2026-01-01T00:00:00.000Z'); assert.equal(build(E()).generatedAt, build([]).generatedAt); });
test('emits exactly 6 flag items for the provider', () => assert.equal(build(E()).flagItems.length, 6));
test('summaryCounts match the safe provider (6/6/6/6/6/6/6/0)', () => { const c = build(E()).summaryCounts; assert.deepEqual(c, { total: 6, devOnly: 6, productionDisabled: 6, defaultOff: 6, valueHidden: 6, noValueOracle: 6, internalOnly: 6, unknown: 0 }); });
test('non-empty input ⇒ emptyState false', () => { const es = build(E()).emptyState; assert.equal(es.isEmpty, false); assert.equal(es.reason, 'none'); });
test('empty input ⇒ safe emptyState true', () => { const es = build([]).emptyState; assert.equal(es.isEmpty, true); assert.equal(es.reason, 'no_feature_flag_posture_entries'); });
test('non-array input ⇒ no-throw safe empty', () => { assert.doesNotThrow(() => build(null as unknown as never)); assert.equal(build(null as unknown as never).flagItems.length, 0); });
test('malformed entries (null / non-object / array) ⇒ no-throw, skipped', () => { const env = build([null, 1, 'x', [], {}] as unknown as C05FeatureFlagPostureEntryInput[]); assert.ok(Array.isArray(env.flagItems)); });
test('throwing-getter entry ⇒ no-throw', () => { const h = {} as Record<string, unknown>; Object.defineProperty(h, 'flagName', { enumerable: true, get() { throw new Error('boom'); } }); assert.doesNotThrow(() => build([h as C05FeatureFlagPostureEntryInput])); });
test('every emitted item has ONLY the 12 accepted fields', () => { for (const it of build(E()).flagItems) assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS); });
test('non-allow-listed flag name ⇒ redacted_flag (never emitted as valid)', () => { const env = build([{ ...E()[0], flagName: 'ENABLE_EVIL' }]); assert.equal(env.flagItems[0].flagName, 'redacted_flag'); });
test('non-allow-listed flag key ⇒ redacted_flag', () => { const env = build([{ ...E()[0], flagKey: 'evil_gate' }]); assert.equal(env.flagItems[0].flagKey, 'redacted_flag'); });
test('unknown posture enum ⇒ unknown fallback', () => { const env = build([{ ...E()[0], exposurePosture: 'evil', valueExposurePosture: 'leak_value' }]); assert.equal(env.flagItems[0].exposurePosture, 'unknown'); assert.equal(env.flagItems[0].valueExposurePosture, 'unknown'); });
test('injected value / enabled / currentValue fields are STRIPPED (only known fields copied)', () => { const env = build([{ ...E()[0], value: 'true', enabled: true, currentValue: 'x', isSet: true, length: 9 } as unknown as C05FeatureFlagPostureEntryInput]); const it = env.flagItems[0] as unknown as Record<string, unknown>; for (const bad of ['value', 'enabled', 'currentValue', 'isSet', 'length']) assert.ok(!(bad in it), bad); assert.doesNotThrow(() => assertBcpC05NoValueOracleFields(env)); });
test('built envelope passes the no-value-oracle fitness function', () => assert.doesNotThrow(() => assertBcpC05NoValueOracleFields(build(E()))));
test('counts invariant: identical regardless of repeated builds', () => assert.deepEqual(build(E()).summaryCounts, build(E()).summaryCounts));
test('no raw error / stack / object dump fields in envelope', () => { const j = JSON.stringify(build(E())); assert.ok(!/stack|Error:|at Object\.|\beval\b/.test(j)); });
test('no full env inventory / process.env leakage in output', () => { const j = JSON.stringify(build(E())).toLowerCase(); for (const bad of ['process.env', 'allenvkeys', 'rawenv', 'envvalue']) assert.ok(!j.includes(bad), bad); });
test('serialized output scan: no secrets/urls/ids/domains', () => { const j = JSON.stringify(build(E())); assert.ok(!/:\/\/|@|sk_live|[0-9a-f]{8}-[0-9a-f]{4}|\bpassword\b/i.test(j)); });
test('deterministic output across calls', () => assert.deepEqual(build(E()), build(E())));
test('envelope posture summary fields are safe constants', () => { const env = build(E()); assert.equal(env.productionPosture, 'production_disabled'); assert.equal(env.exposurePosture, 'backend_cp_internal_only'); assert.equal(env.mutationPosture, 'none'); assert.equal(env.valueExposurePosture, 'no_raw_env_value'); assert.equal(env.redactionPosture, 'safe_labels_only'); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M17 BCP C-05 read model] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
