// Phase 2.0 M20 — Tests for the DEV-only read-only C-06 client + safe view-model, plus UI card static checks.
// Self-contained, NETWORK-FREE (fetch is injected), DB-FREE, Supabase-FREE. Runnable via `npx tsx`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  classifyC06Response,
  fetchC06QualityGatesEvidenceReadiness,
  safeLabel,
  safeCategory,
  safeCount,
  C06_QUALITY_GATES_EVIDENCE_READINESS_URL,
} from './bcpC06Client';

const ITEM_KEYS = ['evidenceKey', 'evidenceLabel', 'ownerSurface', 'evidencePurpose', 'expectedCoveragePosture', 'testCoveragePosture', 'typecheckPosture', 'staticScanPosture', 'transportPosture', 'browserEvidencePosture', 'regressionPosture', 'sourceScopePosture', 'productionPosture', 'mutationPosture', 'dataSourcePosture', 'logExposurePosture', 'evidenceStatus'].sort();

function okItem(over: Record<string, unknown> = {}) {
  return {
    evidenceKey: 'test_coverage', evidenceLabel: 'Test Coverage', ownerSurface: 'backend_cp_quality_gates',
    evidencePurpose: 'test_coverage_posture', expectedCoveragePosture: 'expected', testCoveragePosture: 'documented',
    typecheckPosture: 'documented', staticScanPosture: 'documented', transportPosture: 'documented',
    browserEvidencePosture: 'browser_waived_phase_2_only', regressionPosture: 'regression_required',
    sourceScopePosture: 'code_config_only', productionPosture: 'production_disabled', mutationPosture: 'no_mutation',
    dataSourcePosture: 'code_config_only', logExposurePosture: 'no_raw_logs', evidenceStatus: 'documented', ...over,
  };
}
function okBody(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config',
    sourceMode: 'code_config', freshness: { lastSuccessfulReadLabel: 'code-config-no-live-read' },
    generatedAt: '2026-01-01T00:00:00.000Z',
    summaryCounts: { total: 12, documented: 12, codeConfigOnly: 12, noRawLogs: 12, noCommandOutput: 12, noProductionClaim: 12, internalOnly: 12, unknown: 0 },
    evidenceItems: [okItem()], emptyState: { isEmpty: false, reason: 'none' }, warnings: ['code_config'],
    redactionPosture: 'safe_labels_only', logExposurePosture: 'no_raw_logs', productionPosture: 'production_disabled',
    mutationPosture: 'no_mutation', dataSourcePosture: 'code_config_only',
    evidenceLabels: ['code_config_only', 'no_raw_logs', 'no_production_claim'], ...over,
  };
}
const fakeFetch = (status: number, body: unknown, calls?: Array<{ url: string; opts: RequestInit }>) =>
  (async (url: string, opts: RequestInit) => { calls?.push({ url, opts }); return { status, json: async () => body } as unknown as Response; }) as unknown as typeof fetch;

const CARD = fs.readFileSync(new URL('./C06QualityGatesEvidenceReadinessCard.tsx', import.meta.url), 'utf8');
const CLIENT = fs.readFileSync(new URL('./bcpC06Client.ts', import.meta.url), 'utf8');

const cases: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (n: string, fn: () => Promise<void> | void) => cases.push({ name: n, fn });

// ---- safe primitives ----
test('safeLabel passes a safe bounded label', () => assert.equal(safeLabel('documented'), 'documented'));
test('safeLabel passes the schemaVersion', () => assert.equal(safeLabel('bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config'), 'bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config'));
test('safeLabel redacts secrets/urls/paths/ids/domains/readiness/non-string', () => { for (const v of ['sk_live_abc', 'http://x', 'server/foo.ts', 'deadbeef1', 'a.com', 'production ready', 123, null, '']) assert.equal(safeLabel(v as unknown), 'redacted', String(v)); });
test('safeCategory passes only allow-listed categories', () => { assert.equal(safeCategory('test_coverage'), 'test_coverage'); assert.equal(safeCategory('random_thing'), 'redacted'); });
test('safeCount bounds integers', () => { assert.equal(safeCount(5), 5); assert.equal(safeCount(-1), 0); assert.equal(safeCount(1.5), 0); assert.equal(safeCount('5' as unknown), 0); });

// ---- classify: success ----
test('200 valid envelope ⇒ success with 1 item', () => { const r = classifyC06Response(200, okBody()); assert.equal(r.kind, 'success'); if (r.kind === 'success') assert.equal(r.items.length, 1); });
test('success item exposes ONLY the 17 known safe fields', () => { const r = classifyC06Response(200, okBody()); if (r.kind === 'success') assert.deepEqual(Object.keys(r.items[0]).sort(), ITEM_KEYS); });
test('success counts parsed', () => { const r = classifyC06Response(200, okBody()); if (r.kind === 'success') { assert.equal(r.summaryCounts.total, 12); assert.equal(r.summaryCounts.noCommandOutput, 12); } });
test('only allow-listed category accepted as valid; non-allow-listed ⇒ redacted', () => { const r = classifyC06Response(200, okBody({ evidenceItems: [okItem({ evidenceKey: 'random_thing' })] })); if (r.kind === 'success') assert.equal(r.items[0].evidenceKey, 'redacted'); });
test('injected raw-log/output/path/stack fields are NOT surfaced on items', () => { const r = classifyC06Response(200, okBody({ evidenceItems: [okItem({ log: 'x', commandOutput: 'y', filePath: 'z', stack: 's' })] })); if (r.kind === 'success') { const it = r.items[0] as unknown as Record<string, unknown>; for (const bad of ['log', 'commandOutput', 'filePath', 'stack']) assert.ok(!(bad in it), bad); } });
test('unsafe posture labels (url/path) are redacted', () => { const r = classifyC06Response(200, okBody({ evidenceItems: [okItem({ logExposurePosture: 'http://leak', dataSourcePosture: 'server/x.ts' })] })); if (r.kind === 'success') { assert.equal(r.items[0].logExposurePosture, 'redacted'); assert.equal(r.items[0].dataSourcePosture, 'redacted'); } });
test('production-readiness claim content in a label is redacted', () => { const r = classifyC06Response(200, okBody({ evidenceItems: [okItem({ evidenceStatus: 'production ready' })] })); if (r.kind === 'success') assert.equal(r.items[0].evidenceStatus, 'redacted'); });
test('unsafe sourceMode redacted', () => { const r = classifyC06Response(200, okBody({ sourceMode: 'a@b.com' })); if (r.kind === 'success') assert.equal(r.sourceMode, 'redacted'); });
test('bad generatedAt dropped (undefined)', () => { const r = classifyC06Response(200, okBody({ generatedAt: 'not-a-ts' })); if (r.kind === 'success') assert.equal(r.generatedAt, undefined); });
test('unbounded evidenceItems list capped at 500', () => { const many = Array.from({ length: 999 }, () => okItem()); const r = classifyC06Response(200, okBody({ evidenceItems: many })); if (r.kind === 'success') assert.ok(r.items.length <= 500); });
test('200 without schemaVersion ⇒ unexpected', () => assert.equal(classifyC06Response(200, { foo: 1 }).kind, 'unexpected'));
test('evidenceLabels: safe negation label no_customer_facing_exposure RENDERS (allow-list, not over-redacted)', () => { const r = classifyC06Response(200, okBody({ evidenceLabels: ['no_customer_facing_exposure', 'no_raw_logs', 'tenant_12345', 'http://evil.com'] })); if (r.kind === 'success') { assert.ok(r.evidenceLabels.includes('no_customer_facing_exposure')); assert.ok(r.evidenceLabels.includes('no_raw_logs')); assert.ok(!r.evidenceLabels.includes('tenant_12345')); assert.ok(!r.evidenceLabels.some((l) => l.includes('evil'))); } });
test('safeLabel redacts production-readiness claims (incl. ship-class phrases)', () => { for (const s of ['production ready', 'safe to deploy', 'ship it', 'go live', 'good to go', 'ready for release']) assert.equal(safeLabel(s), 'redacted', s); });
test('schemaVersion fits the client SAFE_LABEL bound (length guard against future drift)', () => { assert.ok(safeLabel('bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config') !== 'redacted'); });

// ---- classify: error/edge states ----
test('404 feature_disabled', () => assert.equal(classifyC06Response(404, { reason: 'feature_disabled' }).kind, 'feature_disabled'));
test('404 dev_only', () => assert.equal(classifyC06Response(404, { reason: 'dev_only' }).kind, 'dev_only'));
test('404 other ⇒ unavailable', () => assert.equal(classifyC06Response(404, {}).kind, 'unavailable'));
test('403 ⇒ unauthorized', () => assert.equal(classifyC06Response(403, {}).kind, 'unauthorized'));
test('409 ⇒ parity_blocked', () => assert.equal(classifyC06Response(409, {}).kind, 'parity_blocked'));
test('405 ⇒ method_not_allowed', () => assert.equal(classifyC06Response(405, {}).kind, 'method_not_allowed'));
test('500 ⇒ error', () => assert.equal(classifyC06Response(500, {}).kind, 'error'));
test('0 ⇒ unavailable', () => assert.equal(classifyC06Response(0, {}).kind, 'unavailable'));
test('classify never surfaces a raw error/object', () => { const r = classifyC06Response(500, { stack: 'boom', error: new Error('x') }); assert.equal(r.kind, 'error'); assert.deepEqual(Object.keys(r), ['kind']); });

// ---- fetch wrapper: request shape + no-throw ----
test('fetch uses the proxy URL by default', () => assert.equal(C06_QUALITY_GATES_EVIDENCE_READINESS_URL, '/__identity/dev/bcp/quality-gates-evidence-coverage-readiness'));
test('fetch is GET only, credentials omit, accept JSON, no Authorization, no body', async () => { const calls: Array<{ url: string; opts: RequestInit }> = []; await fetchC06QualityGatesEvidenceReadiness({ fetchImpl: fakeFetch(200, okBody(), calls) }); const o = calls[0].opts; assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'omit'); assert.equal((o.headers as Record<string, string>).accept, 'application/json'); assert.ok(!('Authorization' in (o.headers as Record<string, string>))); assert.equal(o.body, undefined); });
test('fetch success maps to success result', async () => { const r = await fetchC06QualityGatesEvidenceReadiness({ fetchImpl: fakeFetch(200, okBody()) }); assert.equal(r.kind, 'success'); });
test('fetch network failure ⇒ unavailable', async () => { const r = await fetchC06QualityGatesEvidenceReadiness({ fetchImpl: (() => { throw new Error('net'); }) as unknown as typeof fetch }); assert.equal(r.kind, 'unavailable'); });
test('fetch non-JSON body ⇒ safe state (no throw)', async () => { const bad = (async () => ({ status: 200, json: async () => { throw new Error('not json'); } } as unknown as Response)) as unknown as typeof fetch; const r = await fetchC06QualityGatesEvidenceReadiness({ fetchImpl: bad }); assert.ok(r.kind === 'unexpected' || r.kind === 'unavailable'); });
test('fetch no fetch impl ⇒ unavailable', async () => { const r = await fetchC06QualityGatesEvidenceReadiness({ fetchImpl: undefined as unknown as typeof fetch }); assert.equal(r.kind, 'unavailable'); });
test('fetch never sends an evidence list / identity field', async () => { const calls: Array<{ url: string; opts: RequestInit }> = []; await fetchC06QualityGatesEvidenceReadiness({ fetchImpl: fakeFetch(200, okBody(), calls) }); const s = JSON.stringify(calls[0].opts).toLowerCase(); for (const bad of ['evidencekey', 'uid', 'email', 'tenant', 'principal', 'schemaversion']) assert.ok(!s.includes(bad), bad); });

// ---- client source static checks ----
test('client: GET only, credentials omit, no Authorization, no query params', () => { assert.ok(/method:\s*'GET'/.test(CLIENT)); assert.ok(/credentials:\s*'omit'/.test(CLIENT)); assert.ok(!/Authorization/i.test(CLIENT) || /no Authorization/i.test(CLIENT)); assert.ok(!/POST|PUT|PATCH|DELETE/.test(CLIENT.replace(/\/\/.*$/gm, ''))); });

// ---- UI card static checks (Section O) ----
test('UI card: no auto-fetch / no useEffect-triggered fetch', () => { assert.ok(!/useEffect\s*\(/.test(CARD)); });
test('UI card: button-triggered load only (onClick wired to load)', () => assert.ok(/onClick=\{load\}/.test(CARD)));
test('UI card: no dangerouslySetInnerHTML', () => assert.ok(!/dangerouslySetInnerHTML/.test(CARD)));
test('UI card: no raw JSON rendering (no JSON.stringify in JSX)', () => assert.ok(!/JSON\.stringify/.test(CARD)));
test('UI card: no destructive / backend-action / mutation controls', () => { for (const bad of ['Approve', 'Revoke', 'Provision', 'Delete', 'Execute', 'Mutate', 'fetch(']) assert.ok(!CARD.includes(bad), bad); });
test('UI card: uses only the safe C-06 client (no direct identity URL, no production endpoint)', () => { assert.ok(/fetchC06QualityGatesEvidenceReadiness/.test(CARD)); assert.ok(!/\/api\/|http:\/\/|https:\/\//.test(CARD)); });
test('UI card: displays the raw-evidence-never-shown warning', () => assert.ok(/never shown/i.test(CARD)));
// Binds no raw-identity DATA accessor (disclaimer prose mentioning "secret/token" is intentional copy).
test('UI card: no tenant/store/customer/identity DATA accessors rendered', () => { for (const bad of ['tenantId', 'storeId', 'customerId', 'providerUid', 'internal_user', 'identity_link', 'permission_key', 'rbac', 'dangerouslySetInnerHTML']) assert.ok(!CARD.includes(bad), bad); });
test('UI card does not import a C-05 module', () => { for (const bad of ['bcpC05', 'C05FeatureFlagPosture']) assert.ok(!CARD.includes(bad), bad); });

(async () => { let p = 0; const f: string[] = []; for (const c of cases) { try { await c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M20 BCP C-06 client + UI] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
