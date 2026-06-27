// Phase 2.0 M14 — Tests for the pure C-04 route-exposure read model / DTO builder.
import assert from 'node:assert/strict';
import { buildC04RouteExposureEnvelope, C04_ROUTE_EXPOSURE_SCHEMA_VERSION_V1, type C04RouteExposureEntryInput } from './bcpC04RouteExposureReadModel';

const GOOD: C04RouteExposureEntryInput = {
  routeKey: 'c04_route_exposure_readiness', routeLabel: 'C-04 Route Exposure Readiness',
  backendRoutePath: '/dev/bcp/route-exposure-readiness', frontendProxyPath: '/__identity/dev/bcp/route-exposure-readiness',
  featureFlag: 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS', methodPosture: 'get_head_options_only',
  exposurePosture: 'backend_cp_dev_only', productionPosture: 'production_disabled', readOnlyPosture: 'read_only',
  mutationPosture: 'no_mutation', dataSourcePosture: 'code_config_only', registrationPosture: 'isolated_identity_api_only',
  authorityPosture: 'server_sourced_only', evidenceStatus: 'transport_verified',
};
const SENSITIVE = /:\/\/|@|\bsecret\b|token|password|service_role|supabase|postgres|tenant_|store_|customer_|identity_link|audit_|permission_|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/i;
const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

test('v1 schemaVersion', () => assert.equal(buildC04RouteExposureEnvelope([GOOD]).schemaVersion, C04_ROUTE_EXPOSURE_SCHEMA_VERSION_V1));
test('sourceMode code_config', () => assert.equal(buildC04RouteExposureEnvelope([GOOD]).sourceMode, 'code_config'));
test('freshness code-config-no-live-read', () => assert.equal(buildC04RouteExposureEnvelope([GOOD]).freshness.lastSuccessfulReadLabel, 'code-config-no-live-read'));
test('warnings code_config', () => assert.deepEqual(buildC04RouteExposureEnvelope([GOOD]).warnings, ['code_config']));
test('summary counts match input', () => { const env = buildC04RouteExposureEnvelope([GOOD, GOOD]); assert.deepEqual(env.summaryCounts, { total: 2, devOnly: 2, productionDisabled: 2, readOnly: 2, mutationBlocked: 2, internalOnly: 2, unknown: 0 }); });
test('non-empty ⇒ emptyState false/none', () => { const e = buildC04RouteExposureEnvelope([GOOD]); assert.equal(e.emptyState.isEmpty, false); assert.equal(e.emptyState.reason, 'none'); });
test('empty ⇒ safe emptyState', () => { const e = buildC04RouteExposureEnvelope([]); assert.equal(e.emptyState.isEmpty, true); assert.equal(e.emptyState.reason, 'no_route_exposure_entries'); });
test('malformed input no-throw; only valid survives', () => { assert.doesNotThrow(() => buildC04RouteExposureEnvelope(undefined as unknown as C04RouteExposureEntryInput[])); assert.equal(buildC04RouteExposureEnvelope([null, 5, 'x', [], GOOD] as unknown as C04RouteExposureEntryInput[]).routeItems.length, 1); });
test('unsafe labels redacted', () => { const it = buildC04RouteExposureEnvelope([{ ...GOOD, routeKey: 'tok_secret', routeLabel: 'a@b.com' }]).routeItems[0]; assert.equal(it.routeKey, 'redacted_label'); assert.equal(it.routeLabel, 'redacted_label'); });
test('non-allow-listed backend route redacted to redacted_route', () => assert.equal(buildC04RouteExposureEnvelope([{ ...GOOD, backendRoutePath: '/api/customers' }]).routeItems[0].backendRoutePath, 'redacted_route'));
test('non-allow-listed proxy route redacted to redacted_route', () => assert.equal(buildC04RouteExposureEnvelope([{ ...GOOD, frontendProxyPath: '/__identity/evil' }]).routeItems[0].frontendProxyPath, 'redacted_route'));
test('production/admin route redacted (not emitted as valid)', () => { const it = buildC04RouteExposureEnvelope([{ ...GOOD, backendRoutePath: '/admin/prod' }]).routeItems[0]; assert.equal(it.backendRoutePath, 'redacted_route'); });
test('whitespace labels redacted', () => assert.equal(buildC04RouteExposureEnvelope([{ ...GOOD, routeLabel: '   ' }]).routeItems[0].routeLabel, 'redacted_label'));
test('overlong labels redacted', () => assert.equal(buildC04RouteExposureEnvelope([{ ...GOOD, routeLabel: 'x'.repeat(65) }]).routeItems[0].routeLabel, 'redacted_label'));
test('domain/email/token/secret labels redacted', () => { for (const bad of ['db.internal.acme', 'a@b.co', 'bearer xyz', 'service_role', 'my-secret']) assert.equal(buildC04RouteExposureEnvelope([{ ...GOOD, routeLabel: bad }]).routeItems[0].routeLabel, 'redacted_label', bad); });
test('UUID/long hex/long digit labels redacted', () => { for (const bad of ['12345678-1234-1234-1234-123456789abc', 'deadbeefdeadbeef0', '1234567']) assert.equal(buildC04RouteExposureEnvelope([{ ...GOOD, routeKey: bad }]).routeItems[0].routeKey, 'redacted_label', bad); });
test('source filenames redacted', () => assert.equal(buildC04RouteExposureEnvelope([{ ...GOOD, routeLabel: 'server.ts' }]).routeItems[0].routeLabel, 'redacted_label'));
test('raw object/non-string values become safe fallbacks', () => { const it = buildC04RouteExposureEnvelope([{ ...GOOD, routeKey: { a: 1 } as unknown, methodPosture: { x: 1 } as unknown }]).routeItems[0]; assert.equal(it.routeKey, 'redacted_label'); assert.equal(it.methodPosture, 'unknown'); });
test('unknown enum values normalize to unknown', () => { const it = buildC04RouteExposureEnvelope([{ ...GOOD, exposurePosture: 'HACK', dataSourcePosture: 'evil' }]).routeItems[0]; assert.equal(it.exposurePosture, 'unknown'); assert.equal(it.dataSourcePosture, 'unknown'); });
test('throwing getters do not abort the build', () => { const h = {} as Record<string, unknown>; Object.defineProperty(h, 'routeLabel', { enumerable: true, get() { throw new Error('boom'); } }); h.routeKey = 'safe'; assert.doesNotThrow(() => buildC04RouteExposureEnvelope([h as C04RouteExposureEntryInput, GOOD])); });
test('no raw errors/stacks in output', () => assert.ok(!/stack|Error:|at Object\.|\.ts:\d+/.test(JSON.stringify(buildC04RouteExposureEnvelope([GOOD])))));
test('serialized item output clean of sensitive shapes', () => assert.ok(!SENSITIVE.test(JSON.stringify(buildC04RouteExposureEnvelope([GOOD]).routeItems))));
test('deterministic output', () => assert.deepEqual(buildC04RouteExposureEnvelope([GOOD]), buildC04RouteExposureEnvelope([GOOD])));
test('count filters distinguish devOnly vs internalOnly vs unknown', () => {
  // GOOD = backend_cp_dev_only; one internal-only; one unknown exposure.
  const env = buildC04RouteExposureEnvelope([GOOD, { ...GOOD, exposurePosture: 'backend_cp_internal_only' }, { ...GOOD, exposurePosture: 'HACK' }]);
  assert.equal(env.summaryCounts.total, 3);
  assert.equal(env.summaryCounts.devOnly, 1);       // only the backend_cp_dev_only one
  assert.equal(env.summaryCounts.internalOnly, 2);  // dev_only + internal_only both count as internal
  assert.equal(env.summaryCounts.unknown, 1);       // the HACK one normalized to unknown
});

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M14 BCP C-04 read model] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
