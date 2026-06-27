// Phase 2.0 M14 — Tests for the inert C-04 route-exposure route boundary handler.
import assert from 'node:assert/strict';
import { handleBcpC04RouteExposureRequest, type BcpC04RouteRequest } from './bcpC04ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import { getBcpC04RouteExposureEntries } from './bcpC04RouteExposureProvider';
import type { C04RouteExposureEntryInput } from './bcpC04RouteExposureReadModel';

const PRINCIPAL: SyntheticServerPrincipal = { source: 'server_derived', internalUserId: 'iu_synthetic_dev', authProvider: 'supabase', verified: true, scopeType: 'platform', parityState: 'ready', visibilityClass: 'overview_viewer' };
const ENTRIES = getBcpC04RouteExposureEntries();
const base = (o: Partial<BcpC04RouteRequest> = {}): BcpC04RouteRequest => ({ method: 'GET', isDevEnvironment: true, featureEnabled: true, principal: PRINCIPAL, entries: ENTRIES, ...o });
const ALLOWED_BACKEND = new Set(['/dev/bcp/readiness-summary', '/dev/bcp/registry-readiness', '/dev/bcp/ui-coverage-readiness', '/dev/bcp/route-exposure-readiness']);
const ALLOWED_PROXY = new Set(['/__identity/dev/bcp/readiness-summary', '/__identity/dev/bcp/registry-readiness', '/__identity/dev/bcp/ui-coverage-readiness', '/__identity/dev/bcp/route-exposure-readiness']);
const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('GET success returns C-04 v1 envelope', () => { const r = handleBcpC04RouteExposureRequest(base()); assert.equal(r.httpStatus, 200); assert.equal((r.body as Record<string, unknown>).schemaVersion, 'bcp.c04.route-exposure-readiness.v1-code-config'); });
test('GET success sourceMode code_config', () => assert.equal((handleBcpC04RouteExposureRequest(base()).body as Record<string, unknown>).sourceMode, 'code_config'));
test('GET success freshness code-config-no-live-read', () => assert.equal((handleBcpC04RouteExposureRequest(base()).body as unknown as Record<string, { lastSuccessfulReadLabel: string }>).freshness.lastSuccessfulReadLabel, 'code-config-no-live-read'));
test('GET success emits exactly 4 route items', () => assert.equal((handleBcpC04RouteExposureRequest(base()).body as unknown as Record<string, unknown[]>).routeItems.length, 4));
test('GET success emits only allow-listed backend + proxy routes', () => { const items = (handleBcpC04RouteExposureRequest(base()).body as unknown as Record<string, Array<{ backendRoutePath: string; frontendProxyPath: string }>>).routeItems; for (const it of items) { assert.ok(ALLOWED_BACKEND.has(it.backendRoutePath), it.backendRoutePath); assert.ok(ALLOWED_PROXY.has(it.frontendProxyPath), it.frontendProxyPath); } });
test('feature disabled ⇒ 404 feature_disabled', () => { const r = handleBcpC04RouteExposureRequest(base({ featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' }); });
test('production ⇒ 404 dev_only (before flag)', () => { const r = handleBcpC04RouteExposureRequest(base({ isDevEnvironment: false, featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); });
test('unauthorized (null principal) ⇒ 403', () => assert.equal(handleBcpC04RouteExposureRequest(base({ principal: null })).httpStatus, 403));
test('parity unresolved ⇒ 409', () => assert.equal(handleBcpC04RouteExposureRequest(base({ principal: { ...PRINCIPAL, parityState: 'unresolved' } })).httpStatus, 409));
test('HEAD ⇒ 200 bodyless', () => { const r = handleBcpC04RouteExposureRequest(base({ method: 'HEAD' })); assert.equal(r.httpStatus, 200); assert.equal(r.body, null); });
test('OPTIONS ⇒ 204 Allow GET', () => { const r = handleBcpC04RouteExposureRequest(base({ method: 'OPTIONS' })); assert.equal(r.httpStatus, 204); assert.equal(r.headers?.Allow, 'GET'); });
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${m} ⇒ 405`, () => assert.equal(handleBcpC04RouteExposureRequest(base({ method: m })).httpStatus, 405));
test('non-GET in production ⇒ 404 dev_only (DEV gate precedes method gate)', () => { const r = handleBcpC04RouteExposureRequest(base({ method: 'POST', isDevEnvironment: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); });
test('provider entries reflected only on allowed GET (gates first)', () => assert.equal((handleBcpC04RouteExposureRequest(base({ featureEnabled: false })).body as Record<string, unknown>).schemaVersion, undefined));
test('hostile hints with valid principal still succeed (hints not authority)', () => assert.equal(handleBcpC04RouteExposureRequest(base({ hints: { clientSuppliedUid: 'evil', email: 'a@b.co' } })).httpStatus, 200));
test('hostile hints without principal denied', () => assert.equal(handleBcpC04RouteExposureRequest(base({ principal: null, hints: { clientSuppliedUid: 'evil' } })).httpStatus, 403));
test('request-supplied non-allow-listed entries still get allow-list-redacted by the builder', () => { const hostile: C04RouteExposureEntryInput[] = [{ ...ENTRIES[0], backendRoutePath: '/api/customers', frontendProxyPath: '/__identity/evil' }]; const items = (handleBcpC04RouteExposureRequest(base({ entries: hostile })).body as unknown as Record<string, Array<{ backendRoutePath: string; frontendProxyPath: string }>>).routeItems; assert.equal(items[0].backendRoutePath, 'redacted_route'); assert.equal(items[0].frontendProxyPath, 'redacted_route'); });
test('no raw errors/stacks in any response body', () => { for (const m of ['GET', 'HEAD', 'OPTIONS', 'POST']) assert.ok(!/stack|Error:|at Object\./.test(JSON.stringify(handleBcpC04RouteExposureRequest(base({ method: m })).body))); });
test('handler no-throw on hostile throwing-getter entries', () => { const h = {} as Record<string, unknown>; Object.defineProperty(h, 'routeKey', { enumerable: true, get() { throw new Error('boom'); } }); assert.doesNotThrow(() => handleBcpC04RouteExposureRequest(base({ entries: [h as C04RouteExposureEntryInput] }))); });
test('counts match supplied entries', () => assert.equal((handleBcpC04RouteExposureRequest(base()).body as unknown as Record<string, { total: number }>).summaryCounts.total, ENTRIES.length));
test('empty entries ⇒ safe empty envelope (still 200)', () => { const r = handleBcpC04RouteExposureRequest(base({ entries: [] })); assert.equal(r.httpStatus, 200); assert.equal((r.body as unknown as Record<string, { isEmpty: boolean }>).emptyState.isEmpty, true); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M14 BCP C-04 route] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
