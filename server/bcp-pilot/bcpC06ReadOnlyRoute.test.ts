// Phase 2.0 M20 — Tests for the inert C-06 quality-gates / evidence-coverage route boundary handler.
import assert from 'node:assert/strict';
import { handleBcpC06QualityGatesEvidenceRequest, type BcpC06RouteRequest } from './bcpC06ReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import { getBcpC06QualityGatesEvidenceEntries, assertBcpC06OutputKeyAllowList, assertBcpC06ValueContentSafety, assertBcpC06ProductionReadinessClaimBan } from './bcpC06QualityGatesEvidenceProvider';
import type { C06QualityGatesEvidenceEntryInput } from './bcpC06QualityGatesEvidenceReadModel';

const PRINCIPAL: SyntheticServerPrincipal = { source: 'server_derived', internalUserId: 'iu_synthetic_dev', authProvider: 'supabase', verified: true, scopeType: 'platform', parityState: 'ready', visibilityClass: 'overview_viewer' };
const ENTRIES = getBcpC06QualityGatesEvidenceEntries();
const base = (o: Partial<BcpC06RouteRequest> = {}): BcpC06RouteRequest => ({ method: 'GET', isDevEnvironment: true, featureEnabled: true, principal: PRINCIPAL, entries: ENTRIES, ...o });
const ALLOWED_KEYS = new Set(['test_coverage', 'typecheck_posture', 'static_scan_posture', 'transport_verification', 'frontend_proxy_review', 'browser_evidence_governance', 'independent_review', 'scoped_commit_backup', 'source_scope_control', 'baseline_freeze', 'regression_coverage', 'non_readiness_statements']);

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });
const H = handleBcpC06QualityGatesEvidenceRequest;

test('GET success returns C-06 v1 envelope', () => { const r = H(base()); assert.equal(r.httpStatus, 200); assert.equal((r.body as Record<string, unknown>).schemaVersion, 'bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config'); });
test('GET success sourceMode code_config', () => assert.equal((H(base()).body as Record<string, unknown>).sourceMode, 'code_config'));
test('GET success freshness code-config-no-live-read', () => assert.equal((H(base()).body as unknown as Record<string, { lastSuccessfulReadLabel: string }>).freshness.lastSuccessfulReadLabel, 'code-config-no-live-read'));
test('GET success emits exactly 12 evidence items', () => assert.equal((H(base()).body as unknown as Record<string, unknown[]>).evidenceItems.length, 12));
test('GET success emits only allow-listed evidence categories', () => { const items = (H(base()).body as unknown as Record<string, Array<{ evidenceKey: string }>>).evidenceItems; for (const it of items) assert.ok(ALLOWED_KEYS.has(it.evidenceKey), it.evidenceKey); });
test('GET success body passes output-key allow-list (no raw-log/path/package/error key)', () => assert.doesNotThrow(() => assertBcpC06OutputKeyAllowList(H(base()).body)));
test('GET success body passes value-content scan', () => assert.doesNotThrow(() => assertBcpC06ValueContentSafety(H(base()).body)));
test('GET success body has NO production-readiness claim', () => assert.doesNotThrow(() => assertBcpC06ProductionReadinessClaimBan(H(base()).body)));
test('feature disabled ⇒ 404 feature_disabled', () => { const r = H(base({ featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' }); });
test('production ⇒ 404 dev_only (before flag)', () => { const r = H(base({ isDevEnvironment: false, featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); });
test('unauthorized (null principal) ⇒ 403', () => assert.equal(H(base({ principal: null })).httpStatus, 403));
test('parity unresolved ⇒ 409', () => assert.equal(H(base({ principal: { ...PRINCIPAL, parityState: 'unresolved' } })).httpStatus, 409));
test('HEAD ⇒ 200 bodyless', () => { const r = H(base({ method: 'HEAD' })); assert.equal(r.httpStatus, 200); assert.equal(r.body, null); });
test('OPTIONS ⇒ 204 Allow GET', () => { const r = H(base({ method: 'OPTIONS' })); assert.equal(r.httpStatus, 204); assert.equal(r.headers?.Allow, 'GET'); });
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${m} ⇒ 405`, () => assert.equal(H(base({ method: m })).httpStatus, 405));
test('non-GET in production ⇒ 404 dev_only (DEV gate precedes method gate)', () => { const r = H(base({ method: 'POST', isDevEnvironment: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); });
test('provider entries reflected ONLY on allowed GET (gates first)', () => assert.equal((H(base({ featureEnabled: false })).body as Record<string, unknown>).schemaVersion, undefined));
test('hostile hints WITH valid principal still succeed (hints not authority)', () => assert.equal(H(base({ hints: { clientSuppliedUid: 'evil', email: 'a@b.co' } })).httpStatus, 200));
test('hostile hints WITHOUT principal denied', () => assert.equal(H(base({ principal: null, hints: { clientSuppliedUid: 'evil' } })).httpStatus, 403));
test('request-supplied non-allow-listed entries get redacted by the builder', () => { const hostile: C06QualityGatesEvidenceEntryInput[] = [{ ...ENTRIES[0], evidenceKey: 'random_thing', evidenceLabel: 'Hacked' }]; const items = (H(base({ entries: hostile })).body as unknown as Record<string, Array<{ evidenceKey: string; evidenceLabel: string }>>).evidenceItems; assert.equal(items[0].evidenceKey, 'redacted_category'); assert.equal(items[0].evidenceLabel, 'redacted_label'); });
test('request-supplied injected raw-log/path field never reaches output', () => { const hostile = [{ ...ENTRIES[0], log: 'secret', filePath: '/etc/passwd' }] as unknown as C06QualityGatesEvidenceEntryInput[]; const body = H(base({ entries: hostile })).body; assert.doesNotThrow(() => assertBcpC06OutputKeyAllowList(body)); assert.doesNotThrow(() => assertBcpC06ValueContentSafety(body)); });
test('request-supplied schemaVersion/sourceMode ignored (server-pinned)', () => { const r = H(base({ ...({ schemaVersion: 'evil', sourceMode: 'evil' } as unknown as Partial<BcpC06RouteRequest>) })); assert.equal((r.body as Record<string, unknown>).schemaVersion, 'bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config'); assert.equal((r.body as Record<string, unknown>).sourceMode, 'code_config'); });
test('no raw errors/stack-traces in any response body', () => { for (const m of ['GET', 'HEAD', 'OPTIONS', 'POST']) assert.ok(!/Error:|at Object\.|"stack":/.test(JSON.stringify(H(base({ method: m })).body))); });
test('handler no-throw on hostile throwing-getter entries', () => { const h = {} as Record<string, unknown>; Object.defineProperty(h, 'evidenceKey', { enumerable: true, get() { throw new Error('boom'); } }); assert.doesNotThrow(() => H(base({ entries: [h as C06QualityGatesEvidenceEntryInput] }))); });
test('counts match supplied entries (12)', () => assert.equal((H(base()).body as unknown as Record<string, { total: number }>).summaryCounts.total, ENTRIES.length));
test('empty entries ⇒ safe empty envelope (still 200)', () => { const r = H(base({ entries: [] })); assert.equal(r.httpStatus, 200); assert.equal((r.body as unknown as Record<string, { isEmpty: boolean }>).emptyState.isEmpty, true); });
test('request method is the ONLY request field consulted (authority server-side)', () => assert.deepEqual(H(base()).body, H(base({ hints: { bodyInternalUserId: 'evil', urlTenantParam: 't', urlStoreParam: 's' } })).body));

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M20 BCP C-06 route] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
