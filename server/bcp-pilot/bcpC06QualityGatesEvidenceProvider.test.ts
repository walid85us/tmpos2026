// Phase 2.0 M20 — Tests for the safe server-owned C-06 quality-gates / evidence-coverage provider +
// the six enforced fitness functions (category allow-list, recursive output-key allow-list, value-content
// scan, env/fs/clock invariance, production-readiness-claim ban, C-05 decoupling). Self-running via `npx tsx`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  getBcpC06QualityGatesEvidenceEntries,
  BCP_C06_QUALITY_GATES_EVIDENCE_ENTRIES,
  assertBcpC06EvidenceCategoryAllowList,
  assertBcpC06OutputKeyAllowList,
  assertBcpC06ValueContentSafety,
  assertBcpC06InvarianceContract,
  assertBcpC06ProductionReadinessClaimBan,
  assertBcpC06NoC05Coupling,
  ALLOWED_OUTPUT_KEYS,
  PROHIBITED_OUTPUT_KEYS,
  type BcpC06QualityGatesEvidenceEntry,
} from './bcpC06QualityGatesEvidenceProvider';
import { buildC06QualityGatesEvidenceEnvelope, C06_QUALITY_GATES_EVIDENCE_SCHEMA_VERSION_V1 } from './bcpC06QualityGatesEvidenceReadModel';

const COUNT = 12;
const ENTRY_KEYS = ['evidenceKey', 'evidenceLabel', 'ownerSurface', 'evidencePurpose', 'expectedCoveragePosture', 'testCoveragePosture', 'typecheckPosture', 'staticScanPosture', 'transportPosture', 'browserEvidencePosture', 'regressionPosture', 'sourceScopePosture', 'productionPosture', 'mutationPosture', 'dataSourcePosture', 'logExposurePosture', 'evidenceStatus'].sort();
const ALLOWED_KEYS = new Set(['test_coverage', 'typecheck_posture', 'static_scan_posture', 'transport_verification', 'frontend_proxy_review', 'browser_evidence_governance', 'independent_review', 'scoped_commit_backup', 'source_scope_control', 'baseline_freeze', 'regression_coverage', 'non_readiness_statements']);

const SRC = fs.readFileSync(new URL('./bcpC06QualityGatesEvidenceProvider.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });
const E = () => getBcpC06QualityGatesEvidenceEntries();
const build = buildC06QualityGatesEvidenceEnvelope;

// ---- Provider shape / membership (Section D, Q1-27) ----
test('returns an array', () => assert.ok(Array.isArray(E())));
test('returns exactly 12 evidence entries', () => assert.equal(E().length, COUNT));
for (const k of ['test_coverage', 'typecheck_posture', 'static_scan_posture', 'transport_verification', 'frontend_proxy_review', 'browser_evidence_governance', 'independent_review', 'scoped_commit_backup', 'source_scope_control', 'baseline_freeze', 'regression_coverage', 'non_readiness_statements'])
  test(`includes evidence category ${k}`, () => assert.ok(E().some((e) => e.evidenceKey === k)));
test('contains no extra evidence category (every evidenceKey allow-listed)', () => { for (const e of E()) assert.ok(ALLOWED_KEYS.has(e.evidenceKey), e.evidenceKey); });
test('every entry has ONLY the 17 accepted fields', () => { for (const e of E()) assert.deepEqual(Object.keys(e).sort(), ENTRY_KEYS); });
test('every entry emits only closed enum / bounded values (built envelope has no unknown)', () => { const env = build(E()); for (const it of env.evidenceItems) { assert.notEqual(it.evidenceKey, 'redacted_category'); assert.notEqual(it.evidenceLabel, 'redacted_label'); for (const v of Object.values(it)) assert.notEqual(v, 'unknown'); } });
test('defensive copy (fresh array + objects)', () => { const a = E(); const b = E(); assert.notEqual(a, b); assert.notEqual(a[0], b[0]); });
test('mutating returned array/object does not affect future; constant frozen', () => { const a = E(); a[0].evidenceKey = 'x'; a.length = 0; assert.equal(E().length, COUNT); assert.notEqual(E()[0].evidenceKey, 'x'); assert.ok(Object.isFrozen(BCP_C06_QUALITY_GATES_EVIDENCE_ENTRIES)); assert.ok(Object.isFrozen(BCP_C06_QUALITY_GATES_EVIDENCE_ENTRIES[0])); });
test('deterministic across calls', () => assert.deepEqual(E(), E()));
test('serialized output contains only accepted evidence category keys', () => { const j = JSON.stringify(E()); const found = j.match(/"evidenceKey":"([^"]+)"/g) ?? []; for (const m of found) { const key = m.replace(/"evidenceKey":"|"/g, ''); assert.ok(ALLOWED_KEYS.has(key), key); } });
test('no tenant/store/customer/identity/audit/permission/secret/log fields on entries', () => { const banned = ['tenant', 'store', 'customer', 'identity', 'audit', 'permission', 'rbac', 'email', 'secret', 'token', 'uid', 'log', 'logs', 'rawlog', 'output', 'stdout', 'stderr', 'stack', 'path', 'file', 'package', 'version']; for (const e of E()) for (const k of Object.keys(e)) assert.ok(!banned.includes(k.toLowerCase()), k); });
test('no raw IDs/secrets/urls/emails/domains/paths/SHAs in serialized output', () => { const j = JSON.stringify(E()); assert.ok(!/:\/\/|@|\bsecret\b|\btoken\b|sk_live|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{7,}|\b\d+\.\d+\.\d+\b/i.test(j)); });
test('output passes the C-06 read model (12 items, v1 schema, no redaction/unknown)', () => { const env = build(E()); assert.equal(env.evidenceItems.length, COUNT); assert.equal(env.schemaVersion, C06_QUALITY_GATES_EVIDENCE_SCHEMA_VERSION_V1); });

// ---- Fitness fn 1: category allow-list (Section D) ----
test('category allow-list passes for the real provider', () => assert.doesNotThrow(() => assertBcpC06EvidenceCategoryAllowList()));
test('category allow-list FAILS on unknown / non-quality-gate category', () => { const bad = E().map((e, i) => i === 0 ? { ...e, evidenceKey: 'random_thing' } : e); assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad)); });
test('category allow-list FAILS on duplicate evidence key', () => { const bad = [...E().slice(0, 11), { ...E()[0] }] as BcpC06QualityGatesEvidenceEntry[]; assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad)); });
test('category allow-list FAILS on wrong count (missing accepted category)', () => assert.throws(() => assertBcpC06EvidenceCategoryAllowList(E().slice(0, 11))));
test('category allow-list FAILS on extra category', () => assert.throws(() => assertBcpC06EvidenceCategoryAllowList([...E(), { ...E()[0], evidenceKey: 'test_coverage' }] as BcpC06QualityGatesEvidenceEntry[])));
test('category allow-list FAILS on secret-like category key', () => { const bad = E().map((e, i) => i === 0 ? { ...e, evidenceKey: 'secret_token' } : e); assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad)); });
test('category allow-list FAILS on DB/supabase/auth/credential category key', () => { for (const k of ['database_url', 'supabase_key', 'auth_token', 'private_key', 'connection_string']) { const bad = E().map((e, i) => i === 0 ? { ...e, evidenceKey: k } : e); assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad), undefined, k); } });
test('category allow-list FAILS on unsafe-shape key (uppercase/space)', () => { const bad = E().map((e, i) => i === 0 ? { ...e, evidenceKey: 'Test Coverage' } : e); assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad)); });
test('category allow-list FAILS on label tuple mismatch', () => { const bad = E().map((e) => e.evidenceKey === 'test_coverage' ? { ...e, evidenceLabel: 'Typecheck Posture' } : e); assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad), /mismatch/); });
test('category allow-list FAILS on ownerSurface tuple mismatch', () => { const bad = E().map((e) => e.evidenceKey === 'test_coverage' ? { ...e, ownerSurface: 'backend_cp_baseline' } : e); assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad), /mismatch/); });
test('category allow-list FAILS on purpose tuple mismatch', () => { const bad = E().map((e) => e.evidenceKey === 'test_coverage' ? { ...e, evidencePurpose: 'baseline_freeze_posture' } : e); assert.throws(() => assertBcpC06EvidenceCategoryAllowList(bad), /mismatch/); });
test('category allow-list throws DESCRIPTIVE error on null', () => assert.throws(() => assertBcpC06EvidenceCategoryAllowList(null as unknown as never), /C-06 evidence-category allow-list violation/));

// ---- Fitness fn 2: recursive output-key allow-list (Section E) ----
test('output-key allow-list passes for the safe built envelope', () => assert.doesNotThrow(() => assertBcpC06OutputKeyAllowList(build(E()))));
test('ALLOWED_OUTPUT_KEYS / PROHIBITED_OUTPUT_KEYS are disjoint', () => { for (const k of ALLOWED_OUTPUT_KEYS) assert.ok(!PROHIBITED_OUTPUT_KEYS.has(k.toLowerCase()), k); });
for (const k of ['log', 'logs', 'rawLog', 'rawOutput', 'commandOutput', 'stdout', 'stderr', 'stack', 'stackTrace', 'error', 'rawError', 'exception', 'details', 'metadata', 'diagnostics', 'runtime', 'runtimeState', 'build', 'buildOutput', 'buildId', 'command', 'shell', 'file', 'files', 'filePath', 'path', 'paths', 'filename', 'sourcePath', 'line', 'column', 'package', 'packages', 'dependency', 'dependencies', 'version', 'versions', 'artifact', 'artifacts', 'trace', 'traces', 'screenshot', 'screenshots', 'video', 'report', 'reports', 'reportPath', 'ciJob', 'ciLog', 'raw', 'env', 'secret', 'token', 'credential', 'password', 'privateKey', 'url', 'domain', 'databaseUrl', 'supabaseUrl', 'authProvider', 'tenantId', 'storeId', 'userId', 'email', 'permission', 'permissions', 'rbac', 'connection', 'connectionString', 'mismatch'])
  test(`output-key allow-list REJECTS prohibited key "${k}"`, () => assert.throws(() => assertBcpC06OutputKeyAllowList({ [k]: 'x' })));
test('output-key allow-list REJECTS arbitrary non-allow-listed key', () => assert.throws(() => assertBcpC06OutputKeyAllowList({ surprise: 1 })));
test('output-key allow-list REJECTS nested prohibited key inside evidenceItems', () => assert.throws(() => assertBcpC06OutputKeyAllowList({ evidenceItems: [{ log: 'x' }] })));
test('output-key allow-list REJECTS deeply nested prohibited key', () => assert.throws(() => assertBcpC06OutputKeyAllowList({ summaryCounts: { total: { stack: 'x' } } })));
test('output-key allow-list FAILS CLOSED over depth 4', () => assert.throws(() => assertBcpC06OutputKeyAllowList({ freshness: { freshness: { freshness: { freshness: { freshness: { freshness: 1 } } } } } }), /over-depth/));

// ---- Fitness fn 3: value-content scan (Section F) ----
test('value-content passes for the safe built envelope', () => assert.doesNotThrow(() => assertBcpC06ValueContentSafety(build(E()))));
test('value-content passes for safe bounded enum / category labels / schemaVersion / timestamp', () => { for (const s of ['documented', 'no_command_output', 'no_raw_logs', 'code_config_only', 'test_coverage', 'Browser Evidence Governance', C06_QUALITY_GATES_EVIDENCE_SCHEMA_VERSION_V1, '2026-01-01T00:00:00.000Z', 'code-config-no-live-read']) assert.doesNotThrow(() => assertBcpC06ValueContentSafety(s), s); });
for (const [s, why] of [['server/bcp-pilot/foo.ts', 'path'], ['Foo.tsx', 'filename'], ['at runTest (', 'stack'], ['npm run test', 'command'], ['stdout: boom', 'stdout'], ['Error: boom', 'error'], ['react@18.2.0', 'pkgver'], ['1.2.3', 'semver'], ['deadbeef1', 'sha7'], ['CVE-2021-44228', 'cve'], ['https://evil.example', 'url'], ['evil.com', 'domain'], ['a@b.com', 'email'], ['service_role key', 'secret'], ['100% passed', 'percent'], ['C-05 170', 'c0x-count'], ['106/106', 'ratio'], ['production ready', 'readiness-claim'],
  ['AKIAIOSFODNN7EXAMPLE', 'aws-key'], ['ghp_abcdef123456', 'gh-token'], ['ECONNREFUSED', 'errno'], ['ENABLE_SECRET_THING', 'screaming-token'], ['Dockerfile', 'named-file'], ['react 18.2', 'name-version']] as [string, string][])
  test(`value-content REJECTS unsafe value (${why})`, () => assert.throws(() => assertBcpC06ValueContentSafety(s)));
test('value-content REJECTS unsafe value nested deep in a structure', () => assert.throws(() => assertBcpC06ValueContentSafety({ evidenceItems: [{ evidenceLabel: 'server/secret/key.pem' }] })));

// ---- Fitness fn 4: env / filesystem / clock invariance (Section G) ----
test('invariance contract passes', () => assert.doesNotThrow(() => assertBcpC06InvarianceContract()));
test('output invariant under unrelated env VALUE changes', () => { const before = process.env.PATH; const base = JSON.stringify(build(E())); process.env.PATH = (before ?? '') + ':/tmp/bcp-c06-probe'; assert.equal(JSON.stringify(build(E())), base); if (before === undefined) delete process.env.PATH; else process.env.PATH = before; });
test('output invariant under unrelated env KEY presence/absence', () => { const base = JSON.stringify(build(E())); process.env.__BCP_C06_PROBE__ = 'x'; assert.equal(JSON.stringify(build(E())), base); delete process.env.__BCP_C06_PROBE__; assert.equal(JSON.stringify(build(E())), base); });
test('output invariant under clock / timezone changes (fixed synthetic generatedAt)', () => { const tz = process.env.TZ; const base = JSON.stringify(build(E())); process.env.TZ = 'Asia/Tokyo'; assert.equal(JSON.stringify(build(E())), base); process.env.TZ = 'America/Los_Angeles'; assert.equal(JSON.stringify(build(E())), base); if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; assert.equal(build(E()).generatedAt, '2026-01-01T00:00:00.000Z'); });
test('output invariant under filesystem artifact presence/absence', () => { const f = new URL('./__bcp_c06_probe_artifact__.log', import.meta.url); const base = JSON.stringify(build(E())); fs.writeFileSync(f, 'fake log output\nstdout\n'); try { assert.equal(JSON.stringify(build(E())), base); } finally { fs.rmSync(f, { force: true }); } assert.equal(JSON.stringify(build(E())), base); });
test('provider source has NO filesystem read / env read / clock read / command exec', () => { for (const bad of ['node:fs', 'readFileSync', 'readdirSync', 'process.env', 'Date.now', 'new Date', 'child_process', 'execSync', 'spawn']) assert.ok(!SRC.includes(bad), `provider references: ${bad}`); });

// ---- Fitness fn 5: production-readiness-claim ban (Section H) ----
test('readiness ban passes for the safe built envelope', () => assert.doesNotThrow(() => assertBcpC06ProductionReadinessClaimBan(build(E()))));
for (const s of ['production ready', 'ready for production', 'production-ready', 'customer ready', 'fully certified', 'fully compliant', 'all quality gates passed', 'no risk', 'production approved', 'phase 3 ready', 'phase 4 ready', 'safe to deploy', 'ready to ship', 'ship it', 'go live', 'ready for release', 'good to go', 'deploy to production'])
  test(`readiness ban REJECTS claim "${s}"`, () => assert.throws(() => assertBcpC06ProductionReadinessClaimBan(s)));
test('readiness ban ALLOWS safe non-readiness statements', () => { for (const s of ['production_disabled', 'no_production_claim', 'non_readiness_statements', 'future production readiness review required', 'not production readiness']) assert.doesNotThrow(() => assertBcpC06ProductionReadinessClaimBan(s), s); });

// ---- Fitness fn 6: C-05 decoupling (Section I) ----
test('C-05 decoupling passes for the real provider', () => assert.doesNotThrow(() => assertBcpC06NoC05Coupling()));
test('C-05 decoupling REJECTS a C-05 flag-name reused as a category field', () => { const bad = E().map((e, i) => i === 0 ? { ...e, evidenceLabel: 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS' } : e); assert.throws(() => assertBcpC06NoC05Coupling(bad)); });
test('C-05 decoupling REJECTS feature_flag_posture / c05 reference', () => { for (const v of ['c05_feature_flag_posture', 'feature_flag_posture_lens_gate']) { const bad = E().map((e, i) => i === 0 ? { ...e, evidencePurpose: v } : e); assert.throws(() => assertBcpC06NoC05Coupling(bad), undefined, v); } });
test('no C-06 evidence category equals a C-05 flag name', () => { const c5 = new Set(['ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS', 'VITE_ENABLE_BACKEND_CONTROL_PLANE', 'c05_feature_flag_posture_backend_gate']); for (const e of E()) assert.ok(!c5.has(e.evidenceKey)); });
test('provider source does not import a C-05 module', () => { for (const bad of ['bcpC05', 'FeatureFlagPosture', 'feature-flag-posture']) assert.ok(!SRC.includes(bad), bad); });
test('provider source: no DB/Supabase/getDb/createClient/mockData/src import / route registration', () => { for (const bad of ['createClient', '@supabase', 'getDb', 'process.env.DATABASE', 'mockData', '/src/', 'app.get(', 'app.all(', 'express(', 'router.stack', 'require(']) assert.ok(!SRC.includes(bad), bad); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M20 BCP C-06 provider + fitness] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
