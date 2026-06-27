// Phase 2.0 M14 — Tests for the safe server-owned C-04 route-exposure provider + allow-list fitness fn.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  getBcpC04RouteExposureEntries,
  BCP_C04_SERVER_OWNED_ROUTE_EXPOSURE_ENTRIES,
  assertBcpC04RouteExposureAllowList,
  type BcpC04RouteExposureEntry,
} from './bcpC04RouteExposureProvider';
import { buildC04RouteExposureEnvelope, C04_ROUTE_EXPOSURE_SCHEMA_VERSION_V1 } from './bcpC04RouteExposureReadModel';

const COUNT = 4;
const KEYS = ['routeKey', 'routeLabel', 'backendRoutePath', 'frontendProxyPath', 'featureFlag', 'methodPosture', 'exposurePosture', 'productionPosture', 'readOnlyPosture', 'mutationPosture', 'dataSourcePosture', 'registrationPosture', 'authorityPosture', 'evidenceStatus'].sort();
const ALLOWED_BACKEND = new Set(['/dev/bcp/readiness-summary', '/dev/bcp/registry-readiness', '/dev/bcp/ui-coverage-readiness', '/dev/bcp/route-exposure-readiness']);
const ALLOWED_PROXY = new Set(['/__identity/dev/bcp/readiness-summary', '/__identity/dev/bcp/registry-readiness', '/__identity/dev/bcp/ui-coverage-readiness', '/__identity/dev/bcp/route-exposure-readiness']);
const ALLOWED_KEYS = new Set(['c01_readiness_summary', 'c02_registry_readiness', 'c03_ui_coverage_readiness', 'c04_route_exposure_readiness']);
const METHOD = new Set(['get_head_options_only', 'mutations_405']);
const EXPOSURE = new Set(['backend_cp_dev_only', 'backend_cp_internal_only', 'no_saas_nav_exposure', 'no_external_facing_exposure']);
const DATASRC = new Set(['code_config_only', 'no_live_source', 'no_db', 'no_supabase']);
const REG = new Set(['isolated_identity_api_only', 'single_registration']);
const AUTHP = new Set(['server_sourced_only', 'request_not_authority']);
const EVID = new Set(['tested', 'transport_verified', 'static_reviewed', 'ui_static_reviewed', 'browser_not_run', 'unknown']);

const SRC = fs.readFileSync(new URL('./bcpC04RouteExposureProvider.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const FORBIDDEN = ['://', '@', 'secret', 'token', 'password', 'supabase', 'postgres', 'tenant_', 'store_', 'customer_', 'identity_link', 'audit_', 'permission_', 'provider_uid', 'internal_user'];
function safeLabelOk(v: string): boolean { if (!SAFE_LABEL_RE.test(v)) return false; const l = v.toLowerCase(); for (const b of FORBIDDEN) if (l.includes(b)) return false; if (/\d{4,}/.test(v) || /[A-Za-z0-9]{16,}/.test(v)) return false; return true; }
const CUSTOMER_FACING = ['/api/', '/admin', '/login', '/logout', '/pos', '/repair', '/invoice', '/store/', '/customer', '/checkout', '/billing/pay', '/auth/', '/session'];

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });
const E = () => getBcpC04RouteExposureEntries();

test('returns an array', () => assert.ok(Array.isArray(E())));
test('returns exactly 4 entries', () => assert.equal(E().length, COUNT));
test('includes C-01 readiness summary route', () => assert.ok(E().some((e) => e.backendRoutePath === '/dev/bcp/readiness-summary')));
test('includes C-02 registry readiness route', () => assert.ok(E().some((e) => e.backendRoutePath === '/dev/bcp/registry-readiness')));
test('includes C-03 UI coverage readiness route', () => assert.ok(E().some((e) => e.backendRoutePath === '/dev/bcp/ui-coverage-readiness')));
test('includes C-04 route exposure readiness route', () => assert.ok(E().some((e) => e.backendRoutePath === '/dev/bcp/route-exposure-readiness')));
test('contains no extra route (every backend route allow-listed)', () => { for (const e of E()) assert.ok(ALLOWED_BACKEND.has(e.backendRoutePath), e.backendRoutePath); });
test('every frontend proxy route allow-listed', () => { for (const e of E()) assert.ok(ALLOWED_PROXY.has(e.frontendProxyPath), e.frontendProxyPath); });
test('every route key allow-listed', () => { for (const e of E()) assert.ok(ALLOWED_KEYS.has(e.routeKey), e.routeKey); });
test('every entry has only accepted fields', () => { for (const e of E()) assert.deepEqual(Object.keys(e).sort(), KEYS); });
test('routeKey + routeLabel + featureFlag are safe labels', () => { for (const e of E()) { assert.ok(safeLabelOk(e.routeKey)); assert.ok(safeLabelOk(e.routeLabel)); assert.ok(safeLabelOk(e.featureFlag)); } });
test('methodPosture safe vocab', () => { for (const e of E()) assert.ok(METHOD.has(e.methodPosture)); });
test('exposurePosture safe vocab', () => { for (const e of E()) assert.ok(EXPOSURE.has(e.exposurePosture)); });
test('productionPosture is production_disabled', () => { for (const e of E()) assert.equal(e.productionPosture, 'production_disabled'); });
test('readOnlyPosture is read_only', () => { for (const e of E()) assert.equal(e.readOnlyPosture, 'read_only'); });
test('mutationPosture is no_mutation', () => { for (const e of E()) assert.equal(e.mutationPosture, 'no_mutation'); });
test('dataSourcePosture safe vocab', () => { for (const e of E()) assert.ok(DATASRC.has(e.dataSourcePosture)); });
test('registrationPosture safe vocab', () => { for (const e of E()) assert.ok(REG.has(e.registrationPosture)); });
test('authorityPosture safe vocab', () => { for (const e of E()) assert.ok(AUTHP.has(e.authorityPosture)); });
test('evidenceStatus safe vocab', () => { for (const e of E()) assert.ok(EVID.has(e.evidenceStatus)); });
test('no tenant/store/customer/identity/audit/permission fields', () => { const banned = ['tenant', 'store', 'customer', 'identity', 'audit', 'permission', 'rbac', 'email', 'secret', 'token', 'uid']; for (const e of E()) for (const k of Object.keys(e)) assert.ok(!banned.includes(k), k); });
test('no customer-facing or production route appears anywhere', () => { const j = JSON.stringify(E()); for (const c of CUSTOMER_FACING) assert.ok(!j.includes(c), `customer-facing route fragment present: ${c}`); });
test('no auth/session/admin/store/invoice/repair/POS route appears', () => { const j = JSON.stringify(E()).toLowerCase(); for (const w of ['/admin', '/login', '/session', '/pos', '/repair', '/invoice', '/checkout']) assert.ok(!j.includes(w), w); });
test('no raw IDs/secrets/urls/emails/domains in serialized output', () => { const j = JSON.stringify(E()); assert.ok(!/:\/\/|@|\bsecret\b|token|sk_live|[0-9a-f]{8}-[0-9a-f]{4}|\d{4,}/i.test(j)); });
test('provider source: no runtime route scanner / router introspection', () => { for (const bad of ['app._router', 'router.stack', '.stack', 'app.get', 'app.post', 'app.all', 'express(', 'listChildren', 'route.path', 'process.env', 'createClient', '@supabase', 'getDb', 'fetch(', 'mockData', '/src/']) assert.ok(!SRC.includes(bad), `provider references: ${bad}`); });
test('deterministic across calls', () => assert.deepEqual(E(), E()));
test('defensive copy (fresh array + objects)', () => { const a = E(); const b = E(); assert.notEqual(a, b); assert.notEqual(a[0], b[0]); });
test('mutating returned array does not affect future', () => { const a = E(); a.push(a[0]); a.length = 0; assert.equal(E().length, COUNT); });
test('mutating returned object does not affect future; constant frozen', () => { const a = E(); a[0].routeKey = 'x'; assert.notEqual(E()[0].routeKey, 'x'); assert.ok(Object.isFrozen(BCP_C04_SERVER_OWNED_ROUTE_EXPOSURE_ENTRIES)); assert.ok(Object.isFrozen(BCP_C04_SERVER_OWNED_ROUTE_EXPOSURE_ENTRIES[0])); });
test('getter is zero-arg / no env/request tokens in source', () => { assert.equal(getBcpC04RouteExposureEntries.length, 0); for (const b of ['req.', 'request', 'principal', 'process.env', 'query', 'cookies', 'headers']) assert.ok(!SRC.includes(b), b); });
test('output passes the C-04 read model (no redacted routes, no unknown enums)', () => { const env = buildC04RouteExposureEnvelope(E()); assert.equal(env.routeItems.length, COUNT); assert.equal(env.schemaVersion, C04_ROUTE_EXPOSURE_SCHEMA_VERSION_V1); for (const it of env.routeItems) { assert.notEqual(it.backendRoutePath, 'redacted_route'); assert.notEqual(it.frontendProxyPath, 'redacted_route'); assert.notEqual(it.routeKey, 'redacted_label'); assert.notEqual(it.exposurePosture, 'unknown'); } });
test('serialized provider output contains only accepted route paths', () => { const j = JSON.stringify(E()); const found = j.match(/\/(?:__identity\/)?dev\/bcp\/[a-z-]+/g) ?? []; for (const p of found) assert.ok(ALLOWED_BACKEND.has(p) || ALLOWED_PROXY.has(p), `unexpected path: ${p}`); });

// ---- Enforced allow-list fitness function ----
test('allow-list assert passes for the real provider', () => assert.doesNotThrow(() => assertBcpC04RouteExposureAllowList()));
test('allow-list assert FAILS when an unknown backend route is introduced', () => { const bad = [...E(), { ...E()[0], routeKey: 'c01_readiness_summary', backendRoutePath: '/dev/bcp/evil' }] as BcpC04RouteExposureEntry[]; assert.throws(() => assertBcpC04RouteExposureAllowList(bad)); });
test('allow-list assert FAILS when an unknown proxy route is introduced', () => { const bad = E().map((e, i) => i === 0 ? { ...e, frontendProxyPath: '/__identity/evil' } : e); assert.throws(() => assertBcpC04RouteExposureAllowList(bad)); });
test('allow-list assert FAILS when a customer-facing route appears', () => { const bad = E().map((e, i) => i === 0 ? { ...e, backendRoutePath: '/api/customers' } : e); assert.throws(() => assertBcpC04RouteExposureAllowList(bad)); });
test('allow-list assert FAILS when a production route appears', () => { const bad = E().map((e, i) => i === 0 ? { ...e, backendRoutePath: '/admin/prod' } : e); assert.throws(() => assertBcpC04RouteExposureAllowList(bad)); });
test('allow-list assert FAILS on wrong count (missing accepted route)', () => { const bad = E().slice(0, 3); assert.throws(() => assertBcpC04RouteExposureAllowList(bad)); });
test('allow-list assert FAILS when an unknown route key appears', () => { const bad = E().map((e, i) => i === 0 ? { ...e, routeKey: 'evil_key' } : e); assert.throws(() => assertBcpC04RouteExposureAllowList(bad)); });
test('allow-list assert FAILS on key↔path tuple mismatch (allowed key with another allowed path)', () => { const bad = E().map((e) => e.routeKey === 'c01_readiness_summary' ? { ...e, backendRoutePath: '/dev/bcp/registry-readiness' } : e); assert.throws(() => assertBcpC04RouteExposureAllowList(bad), /mismatch/); });
test('allow-list assert throws a DESCRIPTIVE error (not raw TypeError) on null input', () => { assert.throws(() => assertBcpC04RouteExposureAllowList(null as unknown as never), /C-04 route allow-list violation/); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M14 BCP C-04 provider + allow-list] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
