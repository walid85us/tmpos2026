// Phase 2.0 M17 — Tests for the DEV-only read-only C-05 feature-flag-posture client + safe view-model.
// Self-contained, NETWORK-FREE (fetch is injected), DB-FREE, Supabase-FREE. Runnable via `npx tsx`.
import assert from 'node:assert/strict';
import {
  classifyC05Response,
  fetchC05FeatureFlagPostureReadiness,
  safeLabel,
  safeFlag,
  safeCount,
  C05_FEATURE_FLAG_POSTURE_READINESS_URL,
} from './bcpC05Client';

const ITEM_KEYS = ['flagKey', 'flagName', 'flagPurpose', 'ownerSurface', 'defaultPosture', 'devGatePosture', 'productionPosture', 'exposurePosture', 'dataSourcePosture', 'valueExposurePosture', 'mutationPosture', 'evidenceStatus'].sort();

function okBody(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'bcp.c05.feature-flag-posture-readiness.v1-code-config',
    sourceMode: 'code_config',
    freshness: { lastSuccessfulReadLabel: 'code-config-no-live-read' },
    generatedAt: '2026-01-01T00:00:00.000Z',
    summaryCounts: { total: 1, devOnly: 1, productionDisabled: 1, defaultOff: 1, valueHidden: 1, noValueOracle: 1, internalOnly: 1, unknown: 0 },
    flagItems: [{
      flagKey: 'c05_feature_flag_posture_backend_gate', flagName: 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS',
      flagPurpose: 'feature_flag_posture_lens_gate', ownerSurface: 'c05_feature_flag_posture',
      defaultPosture: 'expected_default_off', devGatePosture: 'dev_only', productionPosture: 'production_disabled',
      exposurePosture: 'backend_cp_internal_only', dataSourcePosture: 'code_config_only',
      valueExposurePosture: 'no_raw_env_value', mutationPosture: 'no_mutation', evidenceStatus: 'transport_verified',
    }],
    emptyState: { isEmpty: false, reason: 'none' },
    warnings: ['code_config'],
    redactionPosture: 'safe_labels_only', productionPosture: 'production_disabled',
    exposurePosture: 'backend_cp_internal_only', mutationPosture: 'none', valueExposurePosture: 'no_raw_env_value',
    evidenceLabels: ['code_config_only', 'no_value_oracle'],
    ...over,
  };
}
const fakeFetch = (status: number, body: unknown, calls?: Array<{ url: string; opts: RequestInit }>) =>
  (async (url: string, opts: RequestInit) => { calls?.push({ url, opts }); return { status, json: async () => body } as unknown as Response; }) as unknown as typeof fetch;

const cases: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (n: string, fn: () => Promise<void> | void) => cases.push({ name: n, fn });

// ---- safe-label / safe-flag / safe-count primitives ----
test('safeLabel passes a safe bounded label', () => assert.equal(safeLabel('dev_only'), 'dev_only'));
test('safeLabel redacts secrets/urls/ids/domains/non-string', () => { for (const v of ['sk_live_abc', 'http://x', '1234', 'a.com', 123, null, '']) assert.equal(safeLabel(v as unknown), 'redacted'); });
test('safeFlag passes only allow-listed names', () => { const A = new Set(['ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS']); assert.equal(safeFlag('ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS', A), 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS'); assert.equal(safeFlag('ENABLE_EVIL', A), 'redacted'); });
test('safeCount bounds integers', () => { assert.equal(safeCount(5), 5); assert.equal(safeCount(-1), 0); assert.equal(safeCount(1.5), 0); assert.equal(safeCount('5' as unknown), 0); });

// ---- classifyC05Response: success ----
test('200 valid envelope ⇒ success with 1 item', () => { const r = classifyC05Response(200, okBody()); assert.equal(r.kind, 'success'); if (r.kind === 'success') assert.equal(r.items.length, 1); });
test('success item exposes ONLY the 12 known safe fields', () => { const r = classifyC05Response(200, okBody()); if (r.kind === 'success') assert.deepEqual(Object.keys(r.items[0]).sort(), ITEM_KEYS); });
test('success counts parsed', () => { const r = classifyC05Response(200, okBody()); if (r.kind === 'success') assert.equal(r.summaryCounts.noValueOracle, 1); });
test('only allow-listed flag name accepted as valid; non-allow-listed ⇒ redacted', () => { const r = classifyC05Response(200, okBody({ flagItems: [{ ...okBody().flagItems[0], flagName: 'ENABLE_EVIL', flagKey: 'evil_gate' }] })); if (r.kind === 'success') { assert.equal(r.items[0].flagName, 'redacted'); assert.equal(r.items[0].flagKey, 'redacted'); } });
test('injected value/enabled/currentValue fields are NOT surfaced on items', () => { const r = classifyC05Response(200, okBody({ flagItems: [{ ...okBody().flagItems[0], value: 'true', enabled: true, currentValue: 'x', isSet: true }] })); if (r.kind === 'success') { const it = r.items[0] as unknown as Record<string, unknown>; for (const bad of ['value', 'enabled', 'currentValue', 'isSet']) assert.ok(!(bad in it), bad); } });
test('unsafe posture labels are redacted', () => { const r = classifyC05Response(200, okBody({ flagItems: [{ ...okBody().flagItems[0], exposurePosture: 'http://leak', dataSourcePosture: 'sk_live_x' }] })); if (r.kind === 'success') { assert.equal(r.items[0].exposurePosture, 'redacted'); assert.equal(r.items[0].dataSourcePosture, 'redacted'); } });
test('unsafe sourceMode redacted', () => { const r = classifyC05Response(200, okBody({ sourceMode: 'a@b.com' })); if (r.kind === 'success') assert.equal(r.sourceMode, 'redacted'); });
test('bad generatedAt dropped (undefined)', () => { const r = classifyC05Response(200, okBody({ generatedAt: 'not-a-ts' })); if (r.kind === 'success') assert.equal(r.generatedAt, undefined); });
test('unbounded flagItems list capped at 500', () => { const many = Array.from({ length: 999 }, () => okBody().flagItems[0]); const r = classifyC05Response(200, okBody({ flagItems: many })); if (r.kind === 'success') assert.ok(r.items.length <= 500); });
test('200 without schemaVersion ⇒ unexpected', () => assert.equal(classifyC05Response(200, { foo: 1 }).kind, 'unexpected'));

// ---- classifyC05Response: error/edge states ----
test('404 feature_disabled', () => assert.equal(classifyC05Response(404, { reason: 'feature_disabled' }).kind, 'feature_disabled'));
test('404 dev_only', () => assert.equal(classifyC05Response(404, { reason: 'dev_only' }).kind, 'dev_only'));
test('404 other ⇒ unavailable', () => assert.equal(classifyC05Response(404, {}).kind, 'unavailable'));
test('403 ⇒ unauthorized', () => assert.equal(classifyC05Response(403, {}).kind, 'unauthorized'));
test('409 ⇒ parity_blocked', () => assert.equal(classifyC05Response(409, {}).kind, 'parity_blocked'));
test('405 ⇒ method_not_allowed', () => assert.equal(classifyC05Response(405, {}).kind, 'method_not_allowed'));
test('500 ⇒ error', () => assert.equal(classifyC05Response(500, {}).kind, 'error'));
test('0 ⇒ unavailable', () => assert.equal(classifyC05Response(0, {}).kind, 'unavailable'));
test('classify never surfaces a raw error/object', () => { const r = classifyC05Response(500, { stack: 'boom', error: new Error('x') }); assert.equal(r.kind, 'error'); assert.deepEqual(Object.keys(r), ['kind']); });

// ---- fetch wrapper: request shape + no-throw ----
test('fetch uses the proxy URL by default', () => assert.equal(C05_FEATURE_FLAG_POSTURE_READINESS_URL, '/__identity/dev/bcp/feature-flag-posture-readiness'));
test('fetch is GET only, credentials omit, accept JSON, no Authorization, no body', async () => { const calls: Array<{ url: string; opts: RequestInit }> = []; await fetchC05FeatureFlagPostureReadiness({ fetchImpl: fakeFetch(200, okBody(), calls) }); const o = calls[0].opts; assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'omit'); assert.equal((o.headers as Record<string, string>).accept, 'application/json'); assert.ok(!('Authorization' in (o.headers as Record<string, string>))); assert.equal(o.body, undefined); });
test('fetch success maps to success result', async () => { const r = await fetchC05FeatureFlagPostureReadiness({ fetchImpl: fakeFetch(200, okBody()) }); assert.equal(r.kind, 'success'); });
test('fetch network failure ⇒ unavailable', async () => { const r = await fetchC05FeatureFlagPostureReadiness({ fetchImpl: (() => { throw new Error('net'); }) as unknown as typeof fetch }); assert.equal(r.kind, 'unavailable'); });
test('fetch non-JSON body ⇒ safe state (no throw)', async () => { const bad = (async () => ({ status: 200, json: async () => { throw new Error('not json'); } } as unknown as Response)) as unknown as typeof fetch; const r = await fetchC05FeatureFlagPostureReadiness({ fetchImpl: bad }); assert.ok(r.kind === 'unexpected' || r.kind === 'unavailable'); });
test('fetch no fetch impl ⇒ unavailable', async () => { const r = await fetchC05FeatureFlagPostureReadiness({ fetchImpl: undefined as unknown as typeof fetch }); assert.equal(r.kind, 'unavailable'); });
test('fetch never sends a flag list / env value / identity field', async () => { const calls: Array<{ url: string; opts: RequestInit }> = []; await fetchC05FeatureFlagPostureReadiness({ fetchImpl: fakeFetch(200, okBody(), calls) }); const s = JSON.stringify(calls[0].opts).toLowerCase(); for (const bad of ['flagname', 'envvalue', 'uid', 'email', 'tenant', 'principal']) assert.ok(!s.includes(bad), bad); });

(async () => { let p = 0; const f: string[] = []; for (const c of cases) { try { await c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M17 BCP C-05 client] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
