// Phase 2.0 M12 — Tests for the DEV-only C-03 UI coverage client parser.
//
// Self-contained, network-FREE (fetch is injected). Runnable via
// `npx tsx src/backend-control-plane/bcpC03Client.test.ts`. Proves GET-only/no-credentials transport and
// that every response (including hostile/unexpected) maps to a safe render-ready state with safe labels.

import assert from 'node:assert/strict';
import {
  fetchC03UiCoverageReadiness,
  classifyC03Response,
  safeLabel,
  safeCount,
  C03_UI_COVERAGE_READINESS_URL,
} from './bcpC03Client';

const GOOD_ITEM = {
  screenKey: 'c03-ui-coverage-preview', screenLabel: 'C-03 UI Coverage Preview', screenStatus: 'preview',
  coverageClass: 'preview_card', previewCardStatus: 'implemented', clientStatus: 'implemented',
  routeStatus: 'implemented', dataSourceClass: 'code_config_only', devGatePosture: 'dev_only',
  productionPosture: 'production_disabled', readOnlyPosture: 'read_only', mutationPosture: 'no_mutation',
  exposurePosture: 'backend_cp_internal_only', evidenceStatus: 'transport_verified',
};
const GOOD_ENVELOPE = {
  schemaVersion: 'bcp.c03.ui-coverage-readiness.v1-code-config', sourceMode: 'code_config',
  generatedAt: '2026-01-01T00:00:00.000Z', freshness: { lastSuccessfulReadLabel: 'code-config-no-live-read' },
  summaryCounts: { total: 1, implemented: 0, preview: 1, placeholder: 0, deferred: 0, blocked: 0, unknown: 0 },
  coverageItems: [GOOD_ITEM], emptyState: { isEmpty: false, reason: 'none' }, warnings: ['code_config'],
  redactionPosture: 'safe_labels_only', routePosture: 'dev_isolated_api', productionPosture: 'production_disabled',
  mutationPosture: 'none', evidenceLabels: ['code_config_only', 'read_only'],
};

const THROW = Symbol('throw');
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, async json() { if (body === THROW) throw new Error('bad json'); return body; } } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn });

test('URL is the accepted dev proxy path', () => {
  assert.ok(C03_UI_COVERAGE_READINESS_URL.endsWith('/dev/bcp/ui-coverage-readiness'));
});
test('fetch uses GET, credentials omit, accept JSON, no Authorization, no body, no query', async () => {
  const { impl, calls } = fakeFetch(200, GOOD_ENVELOPE);
  await fetchC03UiCoverageReadiness({ fetchImpl: impl, url: 'http://x/dev/bcp/ui-coverage-readiness' });
  const init = calls[0].init as RequestInit & { headers: Record<string, string> };
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.body, undefined);
  assert.equal((init.headers as Record<string, string>).accept, 'application/json');
  assert.ok(!('Authorization' in (init.headers as Record<string, string>)));
  assert.ok(!calls[0].url.includes('?'));
});
test('successful v1 envelope parses (and real schemaVersion survives safeLabel)', async () => {
  const { impl } = fakeFetch(200, GOOD_ENVELOPE);
  const r = await fetchC03UiCoverageReadiness({ fetchImpl: impl });
  assert.equal(r.kind, 'success');
  // Guard rail: the real schema string must NOT be redacted by the client safeLabel.
  if (r.kind === 'success') assert.equal(r.schemaVersion, 'bcp.c03.ui-coverage-readiness.v1-code-config');
});
test('empty envelope parses safely', () => {
  const r = classifyC03Response(200, { ...GOOD_ENVELOPE, coverageItems: [], summaryCounts: { ...GOOD_ENVELOPE.summaryCounts, total: 0, preview: 0 }, emptyState: { isEmpty: true, reason: 'no_ui_coverage_entries' } });
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') { assert.equal(r.items.length, 0); assert.equal(r.emptyState.isEmpty, true); }
});
test('counts are bounded (negative/huge/float ⇒ 0)', () => {
  assert.equal(safeCount(-1), 0); assert.equal(safeCount(1e9), 0); assert.equal(safeCount(1.5), 0); assert.equal(safeCount(5), 5);
});
test('coverage items keep only safe labels', () => {
  const r = classifyC03Response(200, GOOD_ENVELOPE);
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') { assert.equal(r.items[0].screenKey, 'c03-ui-coverage-preview'); assert.equal(r.items[0].exposurePosture, 'backend_cp_internal_only'); }
});
test('unsafe labels in items are redacted', () => {
  const r = classifyC03Response(200, { ...GOOD_ENVELOPE, coverageItems: [{ ...GOOD_ITEM, screenKey: 'tok_secret', screenLabel: 'a@b.com' }] });
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') { assert.equal(r.items[0].screenKey, 'redacted'); assert.equal(r.items[0].screenLabel, 'redacted'); }
});
test('unsafe sourceMode redacted', () => {
  const r = classifyC03Response(200, { ...GOOD_ENVELOPE, sourceMode: 'postgres://leak' });
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') assert.equal(r.sourceMode, 'redacted');
});
test('unknown schema (200, no schemaVersion) ⇒ unexpected', () => {
  assert.equal(classifyC03Response(200, { foo: 1 }).kind, 'unexpected');
});
test('200 with unknown schemaVersion string still parses defensively', () => {
  const r = classifyC03Response(200, { ...GOOD_ENVELOPE, schemaVersion: 'bcp.c03.ui-coverage-readiness.v99-future' });
  assert.equal(r.kind, 'success');
});
test('feature_disabled state', () => { assert.equal(classifyC03Response(404, { status: 'unavailable', reason: 'feature_disabled' }).kind, 'feature_disabled'); });
test('dev_only state', () => { assert.equal(classifyC03Response(404, { status: 'unavailable', reason: 'dev_only' }).kind, 'dev_only'); });
test('generic 404 ⇒ unavailable', () => { assert.equal(classifyC03Response(404, {}).kind, 'unavailable'); });
test('unauthorized state (403)', () => { assert.equal(classifyC03Response(403, { status: 'not_authorized' }).kind, 'unauthorized'); });
test('parity_blocked state (409)', () => { assert.equal(classifyC03Response(409, { status: 'parity_blocked' }).kind, 'parity_blocked'); });
test('method_not_allowed state (405)', () => { assert.equal(classifyC03Response(405, { status: 'method_not_allowed' }).kind, 'method_not_allowed'); });
test('5xx ⇒ error', () => { assert.equal(classifyC03Response(500, { status: 'error' }).kind, 'error'); });
test('status 0 ⇒ unavailable', () => { assert.equal(classifyC03Response(0, null).kind, 'unavailable'); });
test('non-JSON body on 200 ⇒ unexpected (no throw)', async () => {
  const { impl } = fakeFetch(200, THROW);
  const r = await fetchC03UiCoverageReadiness({ fetchImpl: impl });
  assert.equal(r.kind, 'unexpected');
});
test('network failure ⇒ unavailable (no throw)', async () => {
  const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const r = await fetchC03UiCoverageReadiness({ fetchImpl: impl });
  assert.equal(r.kind, 'unavailable');
});
test('no fetch available ⇒ unavailable', async () => {
  const r = await fetchC03UiCoverageReadiness({ fetchImpl: undefined as unknown as typeof fetch });
  assert.equal(r.kind, 'unavailable');
});
test('raw Error / stack never surfaced in the result', async () => {
  const impl = (async () => { const e = new Error('secret stack'); throw e; }) as unknown as typeof fetch;
  const r = await fetchC03UiCoverageReadiness({ fetchImpl: impl });
  assert.ok(!JSON.stringify(r).includes('secret stack'));
});
test('sensitive shapes in payload are redacted (no leak of @, ://, secrets, ids)', () => {
  const hostile = { ...GOOD_ENVELOPE, coverageItems: [{ ...GOOD_ITEM, screenKey: 'db.internal.acme.com', screenLabel: 'Bearer sk_live_x', evidenceStatus: '12345678-1234-1234-1234-123456789abc' }] };
  const r = classifyC03Response(200, hostile);
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') {
    const json = JSON.stringify(r.items[0]);
    assert.ok(!/:\/\/|@|sk_live|[0-9a-f]{8}-[0-9a-f]{4}/.test(json), 'sensitive shape leaked');
  }
});
test('raw object values never surfaced (non-string item fields become redacted)', () => {
  const r = classifyC03Response(200, { ...GOOD_ENVELOPE, coverageItems: [{ ...GOOD_ITEM, screenKey: { evil: 1 }, screenStatus: ['x'] }] });
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') { assert.equal(r.items[0].screenKey, 'redacted'); assert.equal(r.items[0].screenStatus, 'redacted'); }
});
test('safeLabel rejects empties, overlong, and unsafe charset', () => {
  assert.equal(safeLabel(''), 'redacted'); assert.equal(safeLabel('   '), 'redacted');
  assert.equal(safeLabel('x'.repeat(65)), 'redacted'); assert.equal(safeLabel('a/b'), 'redacted');
  assert.equal(safeLabel('ok-label_1'), 'ok-label_1');
});

(async () => {
  let pass = 0; const failures: string[] = [];
  for (const c of cases) { try { await c.fn(); pass++; console.log('PASS ' + c.name); } catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } }
  console.log(`\n[M12 BCP C-03 client] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
