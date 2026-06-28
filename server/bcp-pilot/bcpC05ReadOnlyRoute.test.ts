// Phase 2.0 M17 — Tests for the inert C-05 feature-flag-posture route boundary handler.
import assert from 'node:assert/strict';
import { handleBcpC05FeatureFlagPostureRequest, type BcpC05RouteRequest } from './bcpC05ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import { getBcpC05FeatureFlagPostureEntries, assertBcpC05NoValueOracleFields } from './bcpC05FeatureFlagPostureProvider';
import type { C05FeatureFlagPostureEntryInput } from './bcpC05FeatureFlagPostureReadModel';

const PRINCIPAL: SyntheticServerPrincipal = { source: 'server_derived', internalUserId: 'iu_synthetic_dev', authProvider: 'supabase', verified: true, scopeType: 'platform', parityState: 'ready', visibilityClass: 'overview_viewer' };
const ENTRIES = getBcpC05FeatureFlagPostureEntries();
const base = (o: Partial<BcpC05RouteRequest> = {}): BcpC05RouteRequest => ({ method: 'GET', isDevEnvironment: true, featureEnabled: true, principal: PRINCIPAL, entries: ENTRIES, ...o });
const ALLOWED_NAMES = new Set(['ENABLE_BCP_DEV_READONLY_PILOT', 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS', 'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS', 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS', 'VITE_ENABLE_BACKEND_CONTROL_PLANE', 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS']);

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('GET success returns C-05 v1 envelope', () => { const r = handleBcpC05FeatureFlagPostureRequest(base()); assert.equal(r.httpStatus, 200); assert.equal((r.body as Record<string, unknown>).schemaVersion, 'bcp.c05.feature-flag-posture-readiness.v1-code-config'); });
test('GET success sourceMode code_config', () => assert.equal((handleBcpC05FeatureFlagPostureRequest(base()).body as Record<string, unknown>).sourceMode, 'code_config'));
test('GET success freshness code-config-no-live-read', () => assert.equal((handleBcpC05FeatureFlagPostureRequest(base()).body as unknown as Record<string, { lastSuccessfulReadLabel: string }>).freshness.lastSuccessfulReadLabel, 'code-config-no-live-read'));
test('GET success emits exactly 6 flag items', () => assert.equal((handleBcpC05FeatureFlagPostureRequest(base()).body as unknown as Record<string, unknown[]>).flagItems.length, 6));
test('GET success emits only allow-listed flag names', () => { const items = (handleBcpC05FeatureFlagPostureRequest(base()).body as unknown as Record<string, Array<{ flagName: string }>>).flagItems; for (const it of items) assert.ok(ALLOWED_NAMES.has(it.flagName), it.flagName); });
test('GET success body has NO value/value-oracle field (fitness function)', () => assert.doesNotThrow(() => assertBcpC05NoValueOracleFields(handleBcpC05FeatureFlagPostureRequest(base()).body)));
test('feature disabled ⇒ 404 feature_disabled', () => { const r = handleBcpC05FeatureFlagPostureRequest(base({ featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' }); });
test('production ⇒ 404 dev_only (before flag)', () => { const r = handleBcpC05FeatureFlagPostureRequest(base({ isDevEnvironment: false, featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); });
test('unauthorized (null principal) ⇒ 403', () => assert.equal(handleBcpC05FeatureFlagPostureRequest(base({ principal: null })).httpStatus, 403));
test('parity unresolved ⇒ 409', () => assert.equal(handleBcpC05FeatureFlagPostureRequest(base({ principal: { ...PRINCIPAL, parityState: 'unresolved' } })).httpStatus, 409));
test('HEAD ⇒ 200 bodyless', () => { const r = handleBcpC05FeatureFlagPostureRequest(base({ method: 'HEAD' })); assert.equal(r.httpStatus, 200); assert.equal(r.body, null); });
test('OPTIONS ⇒ 204 Allow GET', () => { const r = handleBcpC05FeatureFlagPostureRequest(base({ method: 'OPTIONS' })); assert.equal(r.httpStatus, 204); assert.equal(r.headers?.Allow, 'GET'); });
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${m} ⇒ 405`, () => assert.equal(handleBcpC05FeatureFlagPostureRequest(base({ method: m })).httpStatus, 405));
test('non-GET in production ⇒ 404 dev_only (DEV gate precedes method gate)', () => { const r = handleBcpC05FeatureFlagPostureRequest(base({ method: 'POST', isDevEnvironment: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); });
test('provider entries reflected only on allowed GET (gates first)', () => assert.equal((handleBcpC05FeatureFlagPostureRequest(base({ featureEnabled: false })).body as Record<string, unknown>).schemaVersion, undefined));
test('hostile hints with valid principal still succeed (hints not authority)', () => assert.equal(handleBcpC05FeatureFlagPostureRequest(base({ hints: { clientSuppliedUid: 'evil', email: 'a@b.co' } })).httpStatus, 200));
test('hostile hints without principal denied', () => assert.equal(handleBcpC05FeatureFlagPostureRequest(base({ principal: null, hints: { clientSuppliedUid: 'evil' } })).httpStatus, 403));
test('request-supplied non-allow-listed entries get redacted by the builder', () => { const hostile: C05FeatureFlagPostureEntryInput[] = [{ ...ENTRIES[0], flagName: 'ENABLE_EVIL', flagKey: 'evil_gate' }]; const items = (handleBcpC05FeatureFlagPostureRequest(base({ entries: hostile })).body as unknown as Record<string, Array<{ flagName: string; flagKey: string }>>).flagItems; assert.equal(items[0].flagName, 'redacted_flag'); assert.equal(items[0].flagKey, 'redacted_flag'); });
test('request-supplied injected value field never reaches output', () => { const hostile = [{ ...ENTRIES[0], value: 'true', enabled: true }] as unknown as C05FeatureFlagPostureEntryInput[]; const body = handleBcpC05FeatureFlagPostureRequest(base({ entries: hostile })).body; assert.doesNotThrow(() => assertBcpC05NoValueOracleFields(body)); });
test('no raw errors/stacks in any response body', () => { for (const m of ['GET', 'HEAD', 'OPTIONS', 'POST']) assert.ok(!/stack|Error:|at Object\./.test(JSON.stringify(handleBcpC05FeatureFlagPostureRequest(base({ method: m })).body))); });
test('handler no-throw on hostile throwing-getter entries', () => { const h = {} as Record<string, unknown>; Object.defineProperty(h, 'flagName', { enumerable: true, get() { throw new Error('boom'); } }); assert.doesNotThrow(() => handleBcpC05FeatureFlagPostureRequest(base({ entries: [h as C05FeatureFlagPostureEntryInput] }))); });
test('counts match supplied entries', () => assert.equal((handleBcpC05FeatureFlagPostureRequest(base()).body as unknown as Record<string, { total: number }>).summaryCounts.total, ENTRIES.length));
test('empty entries ⇒ safe empty envelope (still 200)', () => { const r = handleBcpC05FeatureFlagPostureRequest(base({ entries: [] })); assert.equal(r.httpStatus, 200); assert.equal((r.body as unknown as Record<string, { isEmpty: boolean }>).emptyState.isEmpty, true); });
test('request method is the ONLY request field consulted (authority server-side)', () => { const r1 = handleBcpC05FeatureFlagPostureRequest(base()); const r2 = handleBcpC05FeatureFlagPostureRequest(base({ hints: { bodyInternalUserId: 'evil', urlTenantParam: 't', urlStoreParam: 's' } })); assert.deepEqual(r1.body, r2.body); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M17 BCP C-05 route] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
