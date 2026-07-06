// Phase 2.0 M41 — Tests for the DEV-only read-only C-07 client + safe view-model (client + sanitizer).
// Self-contained, NETWORK-FREE (fetch is injected), DB-FREE, Supabase-FREE, no server, no sockets. Runnable
// via `npx tsx`. Mirrors the frozen C-06 client test style, adapted to the C-07 closed-enum vocabulary.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  classifyC07Response,
  fetchC07DataSourceBoundaryReadiness,
  safeEnum,
  safeCount,
  safeLabel,
  C07_DATA_SOURCE_BOUNDARY_READINESS_URL,
} from './bcpC07Client';

const ITEM_KEYS = [
  'boundaryKey', 'boundaryLabel', 'boundaryPurpose', 'ownerSurface', 'sourceMode', 'dataSourcePosture',
  'dbPosture', 'sqlPosture', 'supabasePosture', 'liveProviderPosture', 'runtimeEnvPosture',
  'commandOutputPosture', 'diagnosticsPosture', 'rawEvidencePosture', 'valueOraclePosture',
  'productionPosture', 'mutationPosture', 'customerExposurePosture', 'evidenceStatus',
].sort();

const SUCCESS_KEYS = [
  'kind', 'schemaVersion', 'selfAttestation', 'sourceMode', 'freshness', 'summaryCounts', 'items',
  'emptyState', 'emptyStateReason', 'warnings', 'redactionPosture', 'productionPosture', 'mutationPosture',
  'dataSourcePosture', 'logExposurePosture', 'valueOraclePosture', 'evidenceLabels',
].sort();

function okItem(over: Record<string, unknown> = {}) {
  return {
    boundaryKey: 'c01_readiness_summary', boundaryLabel: 'C-01 Readiness Summary',
    boundaryPurpose: 'Readiness summary evidence', ownerSurface: 'bcp_evidence_lens', sourceMode: 'code_config',
    dataSourcePosture: 'code_config_only', dbPosture: 'asserted_absent_code_config',
    sqlPosture: 'asserted_absent_code_config', supabasePosture: 'asserted_absent_code_config',
    liveProviderPosture: 'asserted_absent_code_config', runtimeEnvPosture: 'asserted_absent_code_config',
    commandOutputPosture: 'asserted_absent_code_config', diagnosticsPosture: 'asserted_absent_code_config',
    rawEvidencePosture: 'asserted_absent_code_config', valueOraclePosture: 'no_value_oracle',
    productionPosture: 'production_disabled', mutationPosture: 'mutation_blocked',
    customerExposurePosture: 'no_customer_exposure', evidenceStatus: 'asserted_within_boundary', ...over,
  };
}
function okBody(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'bcp.c07.data-source-boundary-readiness.v1-code-config',
    selfAttestation: 'design_time_code_config', sourceMode: 'code_config', freshness: 'static_code_config',
    summaryCounts: {
      total: 1, codeConfigOnly: 1, syntheticOnly: 0, noDb: 1, noSql: 1, noSupabase: 1, noLiveProvider: 1,
      noRuntimeEnvValues: 1, noRawDiagnostics: 1, noCommandOutput: 1, productionDisabled: 1, readOnly: 1,
      mutationBlocked: 1, valueOracleBlocked: 1, customerExposureBlocked: 1, unknownRedacted: 0,
    },
    boundaryItems: [okItem()], emptyState: false, emptyStateReason: 'no_live_source', warnings: [],
    redactionPosture: 'enforced', productionPosture: 'production_disabled', mutationPosture: 'mutation_blocked',
    dataSourcePosture: 'code_config_only', logExposurePosture: 'no_raw_logs', valueOraclePosture: 'no_value_oracle',
    evidenceLabels: ['code_config_declared'], ...over,
  };
}
const fakeFetch = (status: number, body: unknown, calls?: Array<{ url: string; opts: RequestInit }>) =>
  (async (url: string, opts: RequestInit) => { calls?.push({ url, opts }); return { status, json: async () => body } as unknown as Response; }) as unknown as typeof fetch;

const CLIENT = fs.readFileSync(new URL('./bcpC07Client.ts', import.meta.url), 'utf8');

const cases: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (n: string, fn: () => Promise<void> | void) => cases.push({ name: n, fn });

// ---- safe primitives ----
test('safeEnum passes a closed-set member', () => assert.equal(safeEnum('code_config', new Set(['code_config'])), 'code_config'));
test('safeEnum redacts a non-member and non-string', () => { assert.equal(safeEnum('nope', new Set(['a'])), 'redacted'); assert.equal(safeEnum(123 as unknown, new Set(['a'])), 'redacted'); });
test('safeEnum: no_customer_exposure passes its set (allow-list primary, NOT over-redacted by customer_ denylist)', () => assert.equal(safeEnum('no_customer_exposure', new Set(['no_customer_exposure'])), 'no_customer_exposure'));
test('safeCount bounds integers', () => { assert.equal(safeCount(5), 5); assert.equal(safeCount(-1), 0); assert.equal(safeCount(1.5), 0); assert.equal(safeCount('5' as unknown), 0); assert.equal(safeCount(999999), 0); });
test('safeLabel passes a safe bounded display label', () => { assert.equal(safeLabel('C-01 Readiness Summary'), 'C-01 Readiness Summary'); assert.equal(safeLabel('Boundary Transport Harness'), 'Boundary Transport Harness'); });
test('safeLabel redacts secrets/urls/paths/ids/domains/readiness/non-string/empty/oversize', () => { for (const v of ['sk_live_abc', 'http://x', 'server/foo.ts', 'deadbeef1', 'a.com', 'production ready', 'safe to deploy', 123, null, '', 'x'.repeat(65)]) assert.equal(safeLabel(v as unknown), 'redacted', String(v)); });

// ---- classify: success shape ----
test('200 valid envelope ⇒ success with 1 item', () => { const r = classifyC07Response(200, okBody()); assert.equal(r.kind, 'success'); if (r.kind === 'success') assert.equal(r.items.length, 1); });
test('success exposes ONLY the fixed view-model keys (no generatedAt/timestamp key)', () => { const r = classifyC07Response(200, okBody()); assert.deepEqual(Object.keys(r).sort(), SUCCESS_KEYS); assert.ok(!('generatedAt' in r)); });
test('success item exposes ONLY the 19 known safe fields', () => { const r = classifyC07Response(200, okBody()); if (r.kind === 'success') assert.deepEqual(Object.keys(r.items[0]).sort(), ITEM_KEYS); });
test('success surfaces the exact schema + selfAttestation', () => { const r = classifyC07Response(200, okBody()); if (r.kind === 'success') { assert.equal(r.schemaVersion, 'bcp.c07.data-source-boundary-readiness.v1-code-config'); assert.equal(r.selfAttestation, 'design_time_code_config'); } });
test('success parses the 16 summary counts', () => { const r = classifyC07Response(200, okBody()); if (r.kind === 'success') { assert.equal(Object.keys(r.summaryCounts).length, 16); assert.equal(r.summaryCounts.total, 1); assert.equal(r.summaryCounts.noSupabase, 1); assert.equal(r.summaryCounts.customerExposureBlocked, 1); } });
test('generatedAt in payload is NEVER surfaced (C-07 permanently excludes timestamps)', () => { const r = classifyC07Response(200, okBody({ generatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', timestamp: 123 })); assert.ok(!('generatedAt' in r)); assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(JSON.stringify(r)), 'no ISO timestamp anywhere in the view model'); });
test('success passes VALID envelope + item enum values through un-redacted (guards against allow-list narrowing)', () => { const r = classifyC07Response(200, okBody()); if (r.kind === 'success') { assert.equal(r.freshness, 'static_code_config'); assert.equal(r.logExposurePosture, 'no_raw_logs'); assert.equal(r.redactionPosture, 'enforced'); assert.equal(r.sourceMode, 'code_config'); assert.equal(r.productionPosture, 'production_disabled'); assert.equal(r.mutationPosture, 'mutation_blocked'); assert.equal(r.dataSourcePosture, 'code_config_only'); assert.equal(r.valueOraclePosture, 'no_value_oracle'); assert.equal(r.emptyStateReason, 'no_live_source'); const it = r.items[0]; assert.equal(it.boundaryKey, 'c01_readiness_summary'); assert.equal(it.boundaryLabel, 'C-01 Readiness Summary'); assert.equal(it.boundaryPurpose, 'Readiness summary evidence'); assert.equal(it.ownerSurface, 'bcp_evidence_lens'); assert.equal(it.dbPosture, 'asserted_absent_code_config'); assert.equal(it.evidenceStatus, 'asserted_within_boundary'); } });

// ---- classify: schema / self-attestation gate ----
test('200 wrong schema ⇒ unexpected', () => assert.equal(classifyC07Response(200, okBody({ schemaVersion: 'bcp.c06.quality-gates-evidence-coverage-readiness.v1-code-config' })).kind, 'unexpected'));
test('200 wrong selfAttestation ⇒ unexpected', () => assert.equal(classifyC07Response(200, okBody({ selfAttestation: 'live_verified' })).kind, 'unexpected'));
test('200 without schemaVersion ⇒ unexpected', () => assert.equal(classifyC07Response(200, { foo: 1 }).kind, 'unexpected'));
test('200 non-object body ⇒ unexpected (safe fallback)', () => { assert.equal(classifyC07Response(200, 'not-an-object').kind, 'unexpected'); assert.equal(classifyC07Response(200, 42 as unknown).kind, 'unexpected'); });
test('200 null body ⇒ unexpected (safe fallback)', () => assert.equal(classifyC07Response(200, null).kind, 'unexpected'));

// ---- sanitizer: allow-list primary gate + hostile redaction ----
test('valid no_customer_exposure item value RENDERS (allow-list primary)', () => { const r = classifyC07Response(200, okBody()); if (r.kind === 'success') assert.equal(r.items[0].customerExposurePosture, 'no_customer_exposure'); });
test('hostile customerExposurePosture value ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ customerExposurePosture: 'customer_data_http://leak' })] })); if (r.kind === 'success') assert.equal(r.items[0].customerExposurePosture, 'redacted'); });
test('non-allow-listed posture value ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ dbPosture: 'live_connected' })] })); if (r.kind === 'success') assert.equal(r.items[0].dbPosture, 'redacted'); });
test('unsafe sourceMode ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ sourceMode: 'a@b.com' })] })); if (r.kind === 'success') assert.equal(r.items[0].sourceMode, 'redacted'); });
test('unknown boundaryKey ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ boundaryKey: 'c99_secret_source' })] })); if (r.kind === 'success') assert.equal(r.items[0].boundaryKey, 'redacted'); });
test('hostile boundaryLabel (url/path) ⇒ redacted (display allow-list)', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ boundaryLabel: 'http://evil.com/x.ts' })] })); if (r.kind === 'success') assert.equal(r.items[0].boundaryLabel, 'redacted'); });
test('non-member boundaryPurpose ⇒ redacted (display allow-list)', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ boundaryPurpose: 'Arbitrary injected purpose text' })] })); if (r.kind === 'success') assert.equal(r.items[0].boundaryPurpose, 'redacted'); });
test('injected raw-evidence/diagnostics/stack/log/commandOutput/filePath/secret fields are NOT surfaced on items', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ rawEvidence: 'x', diagnostics: 'y', stack: 's', log: 'l', commandOutput: 'c', filePath: '/etc/passwd', secret: 'sk_live', supabaseUrl: 'https://a.supabase.co', processEnv: { X: 1 } })] })); if (r.kind === 'success') { const it = r.items[0] as unknown as Record<string, unknown>; for (const bad of ['rawEvidence', 'diagnostics', 'stack', 'log', 'commandOutput', 'filePath', 'secret', 'supabaseUrl', 'processEnv']) assert.ok(!(bad in it), bad); } });
test('SQL/DB/Supabase marker as a posture value ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ supabasePosture: 'supabase_connected', sqlPosture: 'select * from users' })] })); if (r.kind === 'success') { assert.equal(r.items[0].supabasePosture, 'redacted'); assert.equal(r.items[0].sqlPosture, 'redacted'); } });
test('live-provider marker ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ liveProviderPosture: 'firebase_live_read' })] })); if (r.kind === 'success') assert.equal(r.items[0].liveProviderPosture, 'redacted'); });
test('env-value marker ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ runtimeEnvPosture: 'DATABASE_URL=postgres://x' })] })); if (r.kind === 'success') assert.equal(r.items[0].runtimeEnvPosture, 'redacted'); });
test('value-oracle marker ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ valueOraclePosture: 'oracle_result_42' })] })); if (r.kind === 'success') assert.equal(r.items[0].valueOraclePosture, 'redacted'); });
test('production-readiness claim as a posture value ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ productionPosture: 'production ready' })] })); if (r.kind === 'success') assert.equal(r.items[0].productionPosture, 'redacted'); });
test('hostile value into rawEvidence/diagnostics/commandOutput posture fields ⇒ redacted (explicit absence-family)', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ rawEvidencePosture: 'raw log: sk_live_x', diagnosticsPosture: 'stacktrace at server/x.ts:22', commandOutputPosture: '$ printenv DATABASE_URL' })] })); if (r.kind === 'success') { assert.equal(r.items[0].rawEvidencePosture, 'redacted'); assert.equal(r.items[0].diagnosticsPosture, 'redacted'); assert.equal(r.items[0].commandOutputPosture, 'redacted'); } });
test('evidenceStatus unknown value ⇒ redacted', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem({ evidenceStatus: 'live_verified_pass' })] })); if (r.kind === 'success') assert.equal(r.items[0].evidenceStatus, 'redacted'); });

// ---- sanitizer: caps / bounds / unknown-field drop ----
test('oversize boundaryItems list capped at exactly 12', () => { const many = Array.from({ length: 999 }, () => okItem()); const r = classifyC07Response(200, okBody({ boundaryItems: many })); if (r.kind === 'success') assert.equal(r.items.length, 12); });
test('warnings filtered to allow-listed members and capped at exactly 12', () => { const w = ['no_live_source', 'not_a_warning', 'source_mode_redacted', 'DROP TABLE', ...Array.from({ length: 20 }, () => 'item_count_capped')]; const r = classifyC07Response(200, okBody({ warnings: w })); if (r.kind === 'success') { assert.equal(r.warnings.length, 12); assert.ok(!r.warnings.includes('not_a_warning')); assert.ok(!r.warnings.includes('DROP TABLE')); for (const x of r.warnings) assert.ok(['source_mode_redacted', 'posture_value_redacted', 'boundary_key_redacted', 'item_count_capped', 'warning_count_capped', 'no_live_source'].includes(x), x); } });
test('evidenceLabels filtered to allow-listed members and capped at exactly 4', () => { const r = classifyC07Response(200, okBody({ evidenceLabels: ['code_config_declared', 'synthetic_fixture', 'none_empty', 'redacted', 'bogus_label', 'http://x'] })); if (r.kind === 'success') { assert.equal(r.evidenceLabels.length, 4); assert.ok(!r.evidenceLabels.includes('bogus_label')); assert.ok(!r.evidenceLabels.some((l) => l.includes('http'))); } });
test('summary counts bounded (negative/float/string/oversize ⇒ 0)', () => { const r = classifyC07Response(200, okBody({ summaryCounts: { total: -5, codeConfigOnly: 1.5, noDb: '9', noSql: 999999, noSupabase: null } })); if (r.kind === 'success') { assert.equal(r.summaryCounts.total, 0); assert.equal(r.summaryCounts.codeConfigOnly, 0); assert.equal(r.summaryCounts.noDb, 0); assert.equal(r.summaryCounts.noSql, 0); assert.equal(r.summaryCounts.noSupabase, 0); } });
test('a bad item mixed with a good item: bad postures redact, good ones survive, keys stay fixed', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [okItem(), okItem({ boundaryKey: 'zzz', dbPosture: 'live', evilExtra: 'leak' })] })); if (r.kind === 'success') { assert.equal(r.items.length, 2); assert.equal(r.items[1].boundaryKey, 'redacted'); assert.equal(r.items[1].dbPosture, 'redacted'); assert.deepEqual(Object.keys(r.items[1]).sort(), ITEM_KEYS); } });

// ---- sanitizer: envelope enums / states ----
test('envelope posture enums redact unsafe values', () => { const r = classifyC07Response(200, okBody({ productionPosture: 'http://x', redactionPosture: 'bogus', freshness: 'ready', logExposurePosture: 'raw_logs_here', valueOraclePosture: 'oracle_1' })); if (r.kind === 'success') { assert.equal(r.productionPosture, 'redacted'); assert.equal(r.redactionPosture, 'redacted'); assert.equal(r.freshness, 'redacted'); assert.equal(r.logExposurePosture, 'redacted'); assert.equal(r.valueOraclePosture, 'redacted'); } });
test('emptyState normalizes to boolean; non-bool ⇒ false', () => { const r1 = classifyC07Response(200, okBody({ emptyState: 'yes' })); if (r1.kind === 'success') assert.equal(r1.emptyState, false); const r2 = classifyC07Response(200, okBody({ emptyState: true, boundaryItems: [] })); if (r2.kind === 'success') assert.equal(r2.emptyState, true); });
test('emptyStateReason non-member ⇒ redacted; valid member passes', () => { const r1 = classifyC07Response(200, okBody({ emptyStateReason: 'because_reasons' })); if (r1.kind === 'success') assert.equal(r1.emptyStateReason, 'redacted'); const r2 = classifyC07Response(200, okBody({ emptyStateReason: 'input_redacted' })); if (r2.kind === 'success') assert.equal(r2.emptyStateReason, 'input_redacted'); });
test('empty boundaryItems ⇒ success with zero items (safe empty state)', () => { const r = classifyC07Response(200, okBody({ boundaryItems: [], emptyState: true, emptyStateReason: 'no_boundary_items' })); assert.equal(r.kind, 'success'); if (r.kind === 'success') { assert.equal(r.items.length, 0); assert.equal(r.emptyState, true); } });

// ---- classify: error / edge states ----
test('404 feature_disabled', () => assert.equal(classifyC07Response(404, { status: 'unavailable', reason: 'feature_disabled' }).kind, 'feature_disabled'));
test('404 dev_only', () => assert.equal(classifyC07Response(404, { status: 'unavailable', reason: 'dev_only' }).kind, 'dev_only'));
test('404 other ⇒ unavailable', () => assert.equal(classifyC07Response(404, {}).kind, 'unavailable'));
test('403 ⇒ unauthorized', () => assert.equal(classifyC07Response(403, { status: 'not_authorized' }).kind, 'unauthorized'));
test('409 ⇒ parity_blocked', () => assert.equal(classifyC07Response(409, { status: 'parity_blocked' }).kind, 'parity_blocked'));
test('405 ⇒ method_not_allowed', () => assert.equal(classifyC07Response(405, { status: 'method_not_allowed' }).kind, 'method_not_allowed'));
test('500 ⇒ error', () => assert.equal(classifyC07Response(500, { status: 'error' }).kind, 'error'));
test('0 ⇒ unavailable', () => assert.equal(classifyC07Response(0, {}).kind, 'unavailable'));
test('classify never surfaces a raw error/object (5xx with injected stack/error ⇒ {kind} only)', () => { const r = classifyC07Response(500, { stack: 'boom', error: new Error('x'), diagnostics: 'leak' }); assert.equal(r.kind, 'error'); assert.deepEqual(Object.keys(r), ['kind']); });

// ---- fetch wrapper: request shape + no-throw ----
test('fetch uses the exact same-origin proxy URL by default', () => assert.equal(C07_DATA_SOURCE_BOUNDARY_READINESS_URL, '/__identity/dev/bcp/data-source-boundary-readiness'));
test('default URL is relative same-origin (no absolute/production URL)', () => { assert.ok(C07_DATA_SOURCE_BOUNDARY_READINESS_URL.startsWith('/__identity/')); assert.ok(!/^https?:\/\//.test(C07_DATA_SOURCE_BOUNDARY_READINESS_URL)); });
test('fetch is GET only, credentials omit, accept JSON, no Authorization, no body', async () => { const calls: Array<{ url: string; opts: RequestInit }> = []; await fetchC07DataSourceBoundaryReadiness({ fetchImpl: fakeFetch(200, okBody(), calls) }); const o = calls[0].opts; assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'omit'); assert.equal((o.headers as Record<string, string>).accept, 'application/json'); assert.ok(!('Authorization' in (o.headers as Record<string, string>))); assert.ok(!('authorization' in (o.headers as Record<string, string>))); assert.equal(o.body, undefined); });
test('fetch sends no query authority (URL carries no query string)', async () => { const calls: Array<{ url: string; opts: RequestInit }> = []; await fetchC07DataSourceBoundaryReadiness({ fetchImpl: fakeFetch(200, okBody(), calls) }); assert.ok(!calls[0].url.includes('?')); });
test('fetch success maps to success result', async () => { const r = await fetchC07DataSourceBoundaryReadiness({ fetchImpl: fakeFetch(200, okBody()) }); assert.equal(r.kind, 'success'); });
test('fetch network failure ⇒ unavailable', async () => { const r = await fetchC07DataSourceBoundaryReadiness({ fetchImpl: (() => { throw new Error('net'); }) as unknown as typeof fetch }); assert.equal(r.kind, 'unavailable'); });
test('fetch non-JSON body (200) ⇒ unexpected (deterministic safe state, no throw)', async () => { const bad = (async () => ({ status: 200, json: async () => { throw new Error('not json'); } } as unknown as Response)) as unknown as typeof fetch; const r = await fetchC07DataSourceBoundaryReadiness({ fetchImpl: bad }); assert.equal(r.kind, 'unexpected'); });
test('fetch 5xx with unparseable body ⇒ unavailable (no-throw normalization before classify)', async () => { const bad = (async () => ({ status: 500, json: async () => { throw new Error('not json'); } } as unknown as Response)) as unknown as typeof fetch; const r = await fetchC07DataSourceBoundaryReadiness({ fetchImpl: bad }); assert.equal(r.kind, 'unavailable'); });
test('fetch with no impl and no global fetch ⇒ unavailable (network-free; truly exercises the !fetchImpl guard)', async () => { const g = globalThis as { fetch?: typeof fetch }; const saved = g.fetch; try { g.fetch = undefined; const r = await fetchC07DataSourceBoundaryReadiness({}); assert.equal(r.kind, 'unavailable'); } finally { g.fetch = saved; } });
test('fetch sends no identity/authority/query field in the request options', async () => { const calls: Array<{ url: string; opts: RequestInit }> = []; await fetchC07DataSourceBoundaryReadiness({ fetchImpl: fakeFetch(200, okBody(), calls) }); const s = JSON.stringify(calls[0].opts).toLowerCase(); for (const bad of ['uid', 'email', 'tenant', 'store', 'customer', 'principal', 'schemaversion', 'role', 'capability', 'authorization']) assert.ok(!s.includes(bad), bad); });

// ---- client source static checks (defense-in-depth against source drift) ----
// Strip BOTH block (/* */, /** */) and line (//) comments so the scans read only executable code, not the
// client's own explanatory prose (which legitimately names "Authorization", "generatedAt", "safeTimestamp").
const CLIENT_NO_COMMENTS = CLIENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
test('client: GET only, credentials omit, accept JSON', () => { assert.ok(/method:\s*'GET'/.test(CLIENT)); assert.ok(/credentials:\s*'omit'/.test(CLIENT)); assert.ok(/accept:\s*'application\/json'/.test(CLIENT)); });
test('client: no mutation verbs and no Authorization header in code', () => { assert.ok(!/\b(POST|PUT|PATCH|DELETE)\b/.test(CLIENT_NO_COMMENTS)); assert.ok(!/Authorization/i.test(CLIENT_NO_COMMENTS)); });
test('client: no timestamp handling in code (no safeTimestamp helper, no clock/ISO use, no generatedAt field)', () => { assert.ok(!/safeTimestamp/.test(CLIENT_NO_COMMENTS)); assert.ok(!/ISO_TS|toISOString|Date\.now|new Date/.test(CLIENT_NO_COMMENTS)); assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(CLIENT_NO_COMMENTS)); assert.ok(!/generatedAt/.test(CLIENT_NO_COMMENTS)); });
test('client: no localStorage/sessionStorage/window authority', () => { for (const bad of ['localStorage', 'sessionStorage', 'window.', 'document.cookie']) assert.ok(!CLIENT_NO_COMMENTS.includes(bad), bad); });
test('client: no absolute/production URL and no browser/network tooling', () => { assert.ok(!/https?:\/\//.test(CLIENT_NO_COMMENTS)); assert.ok(!/\/api\//.test(CLIENT_NO_COMMENTS)); for (const bad of ['puppeteer', 'playwright', 'jsdom', 'XMLHttpRequest', 'WebSocket']) assert.ok(!CLIENT.includes(bad), bad); });
test('client: is self-contained (no import statements; no backend/server-side coupling in code)', () => { assert.ok(!/^\s*import\s/m.test(CLIENT), 'client declares no import statements'); assert.ok(!/bcp-pilot|server\//.test(CLIENT_NO_COMMENTS), 'no server path reference in code'); });

(async () => { let p = 0; const f: string[] = []; for (const c of cases) { try { await c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M41 BCP C-07 client + sanitizer] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();
