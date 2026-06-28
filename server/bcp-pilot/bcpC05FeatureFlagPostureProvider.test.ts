// Phase 2.0 M17 — Tests for the safe server-owned C-05 feature-flag-posture provider + fitness functions.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  getBcpC05FeatureFlagPostureEntries,
  BCP_C05_SERVER_OWNED_FEATURE_FLAG_POSTURE_ENTRIES,
  assertBcpC05FeatureFlagNameAllowList,
  assertBcpC05NoValueOracleFields,
  PROHIBITED_VALUE_ORACLE_FIELDS,
  type BcpC05FeatureFlagPostureEntry,
} from './bcpC05FeatureFlagPostureProvider';
import { buildC05FeatureFlagPostureEnvelope, C05_FEATURE_FLAG_POSTURE_SCHEMA_VERSION_V1 } from './bcpC05FeatureFlagPostureReadModel';

const COUNT = 6;
const KEYS = ['flagKey', 'flagName', 'flagPurpose', 'ownerSurface', 'defaultPosture', 'devGatePosture', 'productionPosture', 'exposurePosture', 'dataSourcePosture', 'valueExposurePosture', 'mutationPosture', 'evidenceStatus'].sort();
const ALLOWED_NAMES = new Set(['ENABLE_BCP_DEV_READONLY_PILOT', 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS', 'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS', 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS', 'VITE_ENABLE_BACKEND_CONTROL_PLANE', 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS']);
const ALLOWED_KEYS = new Set(['c01_readiness_summary_backend_gate', 'c02_registry_readiness_backend_gate', 'c03_ui_coverage_backend_gate', 'c04_route_exposure_backend_gate', 'backend_cp_dev_shell_frontend_gate', 'c05_feature_flag_posture_backend_gate']);
const PURPOSE = new Set(['readiness_summary_lens_gate', 'registry_readiness_lens_gate', 'ui_coverage_lens_gate', 'route_exposure_lens_gate', 'backend_cp_dev_shell_gate', 'feature_flag_posture_lens_gate']);
const SURFACE = new Set(['c01_readiness_summary', 'c02_registry_readiness', 'c03_ui_coverage', 'c04_route_exposure', 'backend_cp_dev_shell', 'c05_feature_flag_posture']);
const EXPOSURE = new Set(['backend_cp_internal_only', 'no_saas_nav_exposure', 'no_external_facing_exposure']);
const DATASRC = new Set(['code_config_only', 'no_live_source', 'no_env_value_read', 'no_env_inventory']);
const VALUEX = new Set(['no_raw_env_value', 'no_secret_value_exposed', 'no_value_oracle']);
const EVID = new Set(['static_reviewed', 'tested', 'transport_verified', 'browser_waived_phase_2_only', 'unknown']);

const SRC = fs.readFileSync(new URL('./bcpC05FeatureFlagPostureProvider.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });
const E = () => getBcpC05FeatureFlagPostureEntries();

// ---- Provider shape / membership ----
test('returns an array', () => assert.ok(Array.isArray(E())));
test('returns exactly 6 entries', () => assert.equal(E().length, COUNT));
test('includes C-01 readiness summary flag', () => assert.ok(E().some((e) => e.flagName === 'ENABLE_BCP_DEV_READONLY_PILOT')));
test('includes C-02 registry readiness flag', () => assert.ok(E().some((e) => e.flagName === 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS')));
test('includes C-03 UI coverage flag', () => assert.ok(E().some((e) => e.flagName === 'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS')));
test('includes C-04 route exposure flag', () => assert.ok(E().some((e) => e.flagName === 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS')));
test('includes Backend CP DEV shell frontend flag', () => assert.ok(E().some((e) => e.flagName === 'VITE_ENABLE_BACKEND_CONTROL_PLANE')));
test('includes C-05 feature flag posture flag', () => assert.ok(E().some((e) => e.flagName === 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS')));
test('contains no extra flag (every flagName allow-listed)', () => { for (const e of E()) assert.ok(ALLOWED_NAMES.has(e.flagName), e.flagName); });
test('every flagKey allow-listed', () => { for (const e of E()) assert.ok(ALLOWED_KEYS.has(e.flagKey), e.flagKey); });
test('every entry has only accepted fields', () => { for (const e of E()) assert.deepEqual(Object.keys(e).sort(), KEYS); });
test('flagPurpose safe vocab', () => { for (const e of E()) assert.ok(PURPOSE.has(e.flagPurpose)); });
test('ownerSurface safe vocab', () => { for (const e of E()) assert.ok(SURFACE.has(e.ownerSurface)); });
test('defaultPosture is expected_default_off', () => { for (const e of E()) assert.equal(e.defaultPosture, 'expected_default_off'); });
test('devGatePosture is dev_only', () => { for (const e of E()) assert.equal(e.devGatePosture, 'dev_only'); });
test('productionPosture is production_disabled', () => { for (const e of E()) assert.equal(e.productionPosture, 'production_disabled'); });
test('exposurePosture safe vocab', () => { for (const e of E()) assert.ok(EXPOSURE.has(e.exposurePosture)); });
test('dataSourcePosture safe vocab', () => { for (const e of E()) assert.ok(DATASRC.has(e.dataSourcePosture)); });
test('valueExposurePosture safe vocab (no raw env value)', () => { for (const e of E()) assert.ok(VALUEX.has(e.valueExposurePosture)); });
test('mutationPosture is no_mutation', () => { for (const e of E()) assert.equal(e.mutationPosture, 'no_mutation'); });
test('evidenceStatus safe vocab', () => { for (const e of E()) assert.ok(EVID.has(e.evidenceStatus)); });
test('no tenant/store/customer/identity/audit/permission/value fields', () => { const banned = ['tenant', 'store', 'customer', 'identity', 'audit', 'permission', 'rbac', 'email', 'secret', 'token', 'uid', 'value', 'enabled', 'disabled', 'env', 'currentvalue']; for (const e of E()) for (const k of Object.keys(e)) assert.ok(!banned.includes(k.toLowerCase()), k); });
test('no raw IDs/secrets/urls/emails/domains in serialized output', () => { const j = JSON.stringify(E()); assert.ok(!/:\/\/|@|\bsecret\b|\btoken\b|sk_live|[0-9a-f]{8}-[0-9a-f]{4}|\d{4,}/i.test(j)); });
test('deterministic across calls', () => assert.deepEqual(E(), E()));
test('defensive copy (fresh array + objects)', () => { const a = E(); const b = E(); assert.notEqual(a, b); assert.notEqual(a[0], b[0]); });
test('mutating returned array does not affect future', () => { const a = E(); a.push(a[0]); a.length = 0; assert.equal(E().length, COUNT); });
test('mutating returned object does not affect future; constant frozen', () => { const a = E(); a[0].flagKey = 'x'; assert.notEqual(E()[0].flagKey, 'x'); assert.ok(Object.isFrozen(BCP_C05_SERVER_OWNED_FEATURE_FLAG_POSTURE_ENTRIES)); assert.ok(Object.isFrozen(BCP_C05_SERVER_OWNED_FEATURE_FLAG_POSTURE_ENTRIES[0])); });
test('getter is zero-arg / no env/request tokens in source', () => { assert.equal(getBcpC05FeatureFlagPostureEntries.length, 0); for (const b of ['req.', 'request', 'principal', 'process.env', 'query', 'cookies', 'headers']) assert.ok(!SRC.includes(b), b); });
test('provider source: no env reader / enumeration / live access / scanner', () => { for (const bad of ['process.env', 'printenv', 'dotenv', 'createClient', '@supabase', 'getDb', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'mockData', '/src/', 'app.get(', 'app.all(', 'express(', 'router.stack', 'app._router', 'require(']) assert.ok(!SRC.includes(bad), `provider references: ${bad}`); });
test('output passes the C-05 read model (no redacted flags, no unknown enums)', () => { const env = buildC05FeatureFlagPostureEnvelope(E()); assert.equal(env.flagItems.length, COUNT); assert.equal(env.schemaVersion, C05_FEATURE_FLAG_POSTURE_SCHEMA_VERSION_V1); for (const it of env.flagItems) { assert.notEqual(it.flagName, 'redacted_flag'); assert.notEqual(it.flagKey, 'redacted_flag'); assert.notEqual(it.exposurePosture, 'unknown'); assert.notEqual(it.valueExposurePosture, 'unknown'); } });
test('serialized provider output contains only accepted flag names', () => { const j = JSON.stringify(E()); const found = j.match(/(?:ENABLE_BCP[A-Z0-9_]*|VITE_ENABLE_BACKEND_CONTROL_PLANE)/g) ?? []; for (const n of found) assert.ok(ALLOWED_NAMES.has(n), `unexpected flag: ${n}`); });

// ---- Fitness function 1: enforced flag-name allow-list ----
test('allow-list assert passes for the real provider', () => assert.doesNotThrow(() => assertBcpC05FeatureFlagNameAllowList()));
test('allow-list assert FAILS on unknown flag name', () => { const bad = E().map((e, i) => i === 0 ? { ...e, flagName: 'ENABLE_EVIL' } : e); assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad)); });
test('allow-list assert FAILS on unknown flag key', () => { const bad = E().map((e, i) => i === 0 ? { ...e, flagKey: 'evil_gate' } : e); assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad)); });
test('allow-list assert FAILS on duplicate flag key', () => { const bad = [...E().slice(0, 5), { ...E()[0] }] as BcpC05FeatureFlagPostureEntry[]; assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad)); });
test('allow-list assert FAILS on wrong count (missing accepted flag)', () => { const bad = E().slice(0, 5); assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad)); });
test('allow-list assert FAILS on secret-like flag name', () => { const bad = E().map((e, i) => i === 0 ? { ...e, flagName: 'ENABLE_SECRET_TOKEN_VALUE' } : e); assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad)); });
test('allow-list assert FAILS on non-Backend-CP / unsafe-shape flag name', () => { const bad = E().map((e, i) => i === 0 ? { ...e, flagName: 'enable-bcp lower case' } : e); assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad)); });
test('allow-list assert FAILS on key↔name tuple mismatch', () => { const bad = E().map((e) => e.flagKey === 'c01_readiness_summary_backend_gate' ? { ...e, flagName: 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS' } : e); assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad), /mismatch/); });
test('allow-list assert FAILS on owner-surface tuple mismatch', () => { const bad = E().map((e) => e.flagKey === 'c01_readiness_summary_backend_gate' ? { ...e, ownerSurface: 'c04_route_exposure' as BcpC05FeatureFlagPostureEntry['ownerSurface'] } : e); assert.throws(() => assertBcpC05FeatureFlagNameAllowList(bad), /mismatch/); });
test('allow-list assert throws DESCRIPTIVE error (not raw TypeError) on null', () => assert.throws(() => assertBcpC05FeatureFlagNameAllowList(null as unknown as never), /C-05 flag allow-list violation/));

// ---- Fitness function 2: enforced no-value / no-value-oracle ----
test('no-value-oracle assert passes for the real provider', () => assert.doesNotThrow(() => assertBcpC05NoValueOracleFields()));
test('no-value-oracle assert passes for the built envelope', () => assert.doesNotThrow(() => assertBcpC05NoValueOracleFields(buildC05FeatureFlagPostureEnvelope(E()))));
test('PROHIBITED set covers value/oracle field names', () => { for (const k of ['value', 'rawvalue', 'currentvalue', 'envvalue', 'enabled', 'disabled', 'isset', 'unset', 'present', 'missing', 'exists', 'length', 'hash', 'env', 'allenvkeys', 'rawenv', 'secret', 'token', 'url', 'domain']) assert.ok(PROHIBITED_VALUE_ORACLE_FIELDS.has(k), k); });
test('no-value-oracle assert FAILS on injected value field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], value: 'true' }]), /no-value-oracle/));
test('no-value-oracle assert FAILS on injected rawValue field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], rawValue: 'x' }])));
test('no-value-oracle assert FAILS on injected currentValue field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], currentValue: 'x' }])));
test('no-value-oracle assert FAILS on injected enabled field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], enabled: true }])));
test('no-value-oracle assert FAILS on injected disabled field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], disabled: false }])));
test('no-value-oracle assert FAILS on injected isSet field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], isSet: true }])));
test('no-value-oracle assert FAILS on injected exists field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], exists: true }])));
test('no-value-oracle assert FAILS on injected present field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], present: false }])));
test('no-value-oracle assert FAILS on injected length field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], length: 12 }])));
test('no-value-oracle assert FAILS on injected hash field', () => assert.throws(() => assertBcpC05NoValueOracleFields([{ ...E()[0], hash: 'abc' }])));
test('no-value-oracle assert FAILS on nested injected envValue', () => assert.throws(() => assertBcpC05NoValueOracleFields({ flagItems: [{ envValue: 'x' }] })));
test('safe meta-label valueExposurePosture is NOT flagged as a prohibited field', () => { assert.ok(!PROHIBITED_VALUE_ORACLE_FIELDS.has('valueexposureposture')); assert.doesNotThrow(() => assertBcpC05NoValueOracleFields([{ valueExposurePosture: 'no_raw_env_value' }])); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M17 BCP C-05 provider + fitness] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
