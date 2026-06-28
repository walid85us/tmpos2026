// Phase 2.0 M20 — Tests for the PURE C-06 quality-gates / evidence-coverage read model / DTO builder.
import assert from 'node:assert/strict';
import {
  buildC06QualityGatesEvidenceEnvelope,
  C06_QUALITY_GATES_EVIDENCE_SCHEMA_VERSION_V1,
  type C06QualityGatesEvidenceEntryInput,
} from './bcpC06QualityGatesEvidenceReadModel';
import {
  getBcpC06QualityGatesEvidenceEntries,
  assertBcpC06OutputKeyAllowList,
  assertBcpC06ValueContentSafety,
  assertBcpC06ProductionReadinessClaimBan,
} from './bcpC06QualityGatesEvidenceProvider';

const ITEM_KEYS = ['evidenceKey', 'evidenceLabel', 'ownerSurface', 'evidencePurpose', 'expectedCoveragePosture', 'testCoveragePosture', 'typecheckPosture', 'staticScanPosture', 'transportPosture', 'browserEvidencePosture', 'regressionPosture', 'sourceScopePosture', 'productionPosture', 'mutationPosture', 'dataSourcePosture', 'logExposurePosture', 'evidenceStatus'].sort();
const E = () => getBcpC06QualityGatesEvidenceEntries();
const build = (x: readonly C06QualityGatesEvidenceEntryInput[]) => buildC06QualityGatesEvidenceEnvelope(x);

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('schemaVersion is the v1 code-config schema', () => assert.equal(build(E()).schemaVersion, C06_QUALITY_GATES_EVIDENCE_SCHEMA_VERSION_V1));
test('sourceMode is code_config', () => assert.equal(build(E()).sourceMode, 'code_config'));
test('freshness is code-config-no-live-read', () => assert.equal(build(E()).freshness.lastSuccessfulReadLabel, 'code-config-no-live-read'));
test('warnings is [code_config]', () => assert.deepEqual(build(E()).warnings, ['code_config']));
test('generatedAt is a fixed synthetic constant', () => { assert.equal(build(E()).generatedAt, '2026-01-01T00:00:00.000Z'); assert.equal(build(E()).generatedAt, build([]).generatedAt); });
test('emits exactly 12 evidence items for the provider', () => assert.equal(build(E()).evidenceItems.length, 12));
test('summaryCounts match the safe provider (12 across, 0 unknown)', () => assert.deepEqual(build(E()).summaryCounts, { total: 12, documented: 12, codeConfigOnly: 12, noRawLogs: 12, noCommandOutput: 12, noProductionClaim: 12, internalOnly: 12, unknown: 0 }));
test('non-empty input ⇒ emptyState false / none', () => { const es = build(E()).emptyState; assert.equal(es.isEmpty, false); assert.equal(es.reason, 'none'); });
test('empty input ⇒ safe emptyState true / no_quality_gate_evidence_entries', () => { const es = build([]).emptyState; assert.equal(es.isEmpty, true); assert.equal(es.reason, 'no_quality_gate_evidence_entries'); });
test('non-array input ⇒ no-throw safe empty', () => { assert.doesNotThrow(() => build(null as unknown as never)); assert.equal(build(null as unknown as never).evidenceItems.length, 0); });
test('malformed entries (null / number / string / array / {}) ⇒ no-throw', () => { const env = build([null, 1, 'x', [], {}] as unknown as C06QualityGatesEvidenceEntryInput[]); assert.ok(Array.isArray(env.evidenceItems)); });
test('throwing-getter entry ⇒ no-throw', () => { const h = {} as Record<string, unknown>; Object.defineProperty(h, 'evidenceKey', { enumerable: true, get() { throw new Error('boom'); } }); assert.doesNotThrow(() => build([h as C06QualityGatesEvidenceEntryInput])); });
test('every emitted item has ONLY the 17 accepted fields', () => { for (const it of build(E()).evidenceItems) assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS); });
test('non-allow-listed category key ⇒ redacted_category', () => assert.equal(build([{ ...E()[0], evidenceKey: 'random_thing' }]).evidenceItems[0].evidenceKey, 'redacted_category'));
test('non-allow-listed evidence label ⇒ redacted_label', () => assert.equal(build([{ ...E()[0], evidenceLabel: 'Arbitrary Label' }]).evidenceItems[0].evidenceLabel, 'redacted_label'));
test('unknown posture enum ⇒ unknown fallback', () => { const env = build([{ ...E()[0], logExposurePosture: 'leak_everything', productionPosture: 'ship_it' }]); assert.equal(env.evidenceItems[0].logExposurePosture, 'unknown'); assert.equal(env.evidenceItems[0].productionPosture, 'unknown'); });
test('injected raw-log / command-output / path / stack fields are STRIPPED (only known fields copied)', () => { const env = build([{ ...E()[0], log: 'x', commandOutput: 'y', filePath: 'z', stack: 's', details: {} } as unknown as C06QualityGatesEvidenceEntryInput]); const it = env.evidenceItems[0] as unknown as Record<string, unknown>; for (const bad of ['log', 'commandOutput', 'filePath', 'stack', 'details']) assert.ok(!(bad in it), bad); assert.doesNotThrow(() => assertBcpC06OutputKeyAllowList(env)); });
test('built envelope passes the output-key allow-list', () => assert.doesNotThrow(() => assertBcpC06OutputKeyAllowList(build(E()))));
test('built envelope passes the value-content scan', () => assert.doesNotThrow(() => assertBcpC06ValueContentSafety(build(E()))));
test('built envelope passes the production-readiness-claim ban', () => assert.doesNotThrow(() => assertBcpC06ProductionReadinessClaimBan(build(E()))));
test('counts invariant across repeated builds', () => assert.deepEqual(build(E()).summaryCounts, build(E()).summaryCounts));
test('deterministic output across calls', () => assert.deepEqual(build(E()), build(E())));
test('envelope posture summary fields are safe constants', () => { const env = build(E()); assert.equal(env.redactionPosture, 'safe_labels_only'); assert.equal(env.logExposurePosture, 'no_raw_logs'); assert.equal(env.productionPosture, 'production_disabled'); assert.equal(env.mutationPosture, 'no_mutation'); assert.equal(env.dataSourcePosture, 'code_config_only'); });
test('no raw error / stack-trace / object-dump shapes in envelope', () => { const j = JSON.stringify(build(E())); assert.ok(!/Error:|at Object\.|\bat \w+ \(|"stack":|"error":|"exception":/.test(j)); });
test('no raw tenant/store/customer/identity/audit/permission/secret DATA in output', () => { const j = JSON.stringify(build(E())).toLowerCase(); for (const bad of ['tenantid', 'storeid', 'customerid', 'identity_link', 'audit_row', 'permission_key', '"secret"', '"token"', 'process.env', 'databaseurl', 'supabaseurl', 'service_role']) assert.ok(!j.includes(bad), bad); });
test('serialized output scan: no secrets/urls/ids/domains/paths', () => { const j = JSON.stringify(build(E())); assert.ok(!/:\/\/|@|sk_live|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{7,}|\bpassword\b/i.test(j)); });
test('evidenceLabels are all safe bounded labels', () => { for (const l of build(E()).evidenceLabels) assert.ok(/^[a-z0-9_]+$/.test(l), l); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M20 BCP C-06 read model] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
