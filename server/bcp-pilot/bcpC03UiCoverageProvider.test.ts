// Phase 2.0 M12 — Tests for the safe server-owned C-03 UI coverage provider.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding, NO app.listen. Runnable via
// `npx tsx server/bcp-pilot/bcpC03UiCoverageProvider.test.ts`. Proves the provider emits ONLY safe
// bounded entries, is deterministic / defensively-copied / request-independent, carries NO live / DB /
// Supabase / src / mockData / sensitive-row coupling, and flows cleanly through the C-03 read model.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  getBcpC03UiCoverageEntries,
  BCP_C03_SERVER_OWNED_UI_COVERAGE_ENTRIES,
} from './bcpC03UiCoverageProvider';
import {
  buildC03UiCoverageEnvelope,
  C03_UI_COVERAGE_SCHEMA_VERSION_V1,
} from './bcpC03UiCoverageReadModel';

const EXPECTED_COUNT = 14;
const ACCEPTED_KEYS = [
  'clientStatus', 'coverageClass', 'dataSourceClass', 'devGatePosture', 'evidenceStatus',
  'exposurePosture', 'mutationPosture', 'previewCardStatus', 'productionPosture', 'readOnlyPosture',
  'routeStatus', 'screenKey', 'screenLabel', 'screenStatus',
];
const SCREEN_STATUS = new Set(['implemented', 'preview', 'placeholder', 'deferred', 'blocked']);
const COVERAGE_CLASS = new Set(['internal_dev_screen', 'readiness_gate', 'preview_card', 'placeholder_screen', 'deferred_screen', 'blocked_screen']);
const SUB_STATUS = new Set(['implemented', 'not_implemented', 'not_applicable', 'deferred', 'unknown']);
const DATA_SOURCE = new Set(['code_config_only', 'no_live_source']);
const DEV_GATE = new Set(['dev_only', 'backend_cp_shell_gate']);
const PROD = new Set(['production_disabled']);
const RO = new Set(['read_only']);
const MUT = new Set(['no_mutation']);
const EXPOSURE = new Set(['backend_cp_internal_only', 'no_external_facing_exposure', 'no_saas_nav_exposure']);
const EVIDENCE = new Set(['tested', 'static_reviewed', 'transport_verified', 'not_run', 'unknown']);

const PROVIDER_SRC_RAW = fs.readFileSync(new URL('./bcpC03UiCoverageProvider.ts', import.meta.url), 'utf8');
const PROVIDER_CODE = PROVIDER_SRC_RAW.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'secret', 'token', 'password', 'postgres', 'supabase',
  'apikey', 'api_key', 'sk_', 'sk-', 'pk_', 'pk-', 'rk_', 'ak_', 'cus_', 'acct_', 'usr_', 'txn_', 'tok_',
  'card_', 'tenant_', 'store_', 'customer_', 'identity_link', 'identitylink', 'provider_uid',
  'internal_user', 'audit_', 'permission_', 'entitlement_', 'mismatch_', 'iu_',
];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_ALNUM_RUN_RE = /[A-Za-z0-9]{16,}/;
const DIGIT_RUN_RE = /\d{4,}/;
const DOMAINISH_RE = /\.[a-z0-9-]+\.[a-z]{2,}/i;
const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|env|key|pem|sql|sh|ya?ml|toml|lock)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/;

function isSafeLabel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  if (!SAFE_LABEL_RE.test(value)) return false;
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return false;
  if (UUID_RE.test(value) || LONG_ALNUM_RUN_RE.test(value) || DIGIT_RUN_RE.test(value) ||
      DOMAINISH_RE.test(value) || FILE_EXT_RE.test(value)) return false;
  return true;
}
function findSensitive(text: string): string | null {
  const lower = text.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return bad;
  if (UUID_RE.test(text)) return 'uuid-shape';
  if (/[0-9a-f]{16,}/i.test(text)) return 'long-hex';
  if (EMAIL_RE.test(text)) return 'email-shape';
  return null;
}

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

test('provider returns an array', () => { assert.ok(Array.isArray(getBcpC03UiCoverageEntries())); });
test('provider returns non-empty entries', () => { assert.ok(getBcpC03UiCoverageEntries().length > 0); });
test('provider returns the expected bounded entry count (14)', () => {
  assert.equal(getBcpC03UiCoverageEntries().length, EXPECTED_COUNT);
});
test('every entry has ONLY the accepted fields', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.deepEqual(Object.keys(e).sort(), ACCEPTED_KEYS);
});
test('screenKey values are safe bounded labels', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(isSafeLabel(e.screenKey), `unsafe screenKey: ${e.screenKey}`);
});
test('screenLabel values are safe bounded labels', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(isSafeLabel(e.screenLabel), `unsafe screenLabel: ${e.screenLabel}`);
});
test('screenStatus values are from the accepted vocabulary', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(SCREEN_STATUS.has(e.screenStatus), e.screenStatus);
});
test('coverageClass values are from the accepted vocabulary', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(COVERAGE_CLASS.has(e.coverageClass), e.coverageClass);
});
test('previewCardStatus values are from the accepted vocabulary', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(SUB_STATUS.has(e.previewCardStatus), e.previewCardStatus);
});
test('clientStatus values are from the accepted vocabulary', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(SUB_STATUS.has(e.clientStatus), e.clientStatus);
});
test('routeStatus values are from the accepted vocabulary', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(SUB_STATUS.has(e.routeStatus), e.routeStatus);
});
test('dataSourceClass values are safe', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(DATA_SOURCE.has(e.dataSourceClass), e.dataSourceClass);
});
test('devGatePosture values are safe', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(DEV_GATE.has(e.devGatePosture), e.devGatePosture);
});
test('productionPosture is production_disabled for every entry', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(PROD.has(e.productionPosture), e.productionPosture);
});
test('readOnlyPosture is read_only for every entry', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(RO.has(e.readOnlyPosture), e.readOnlyPosture);
});
test('mutationPosture is no_mutation for every entry', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(MUT.has(e.mutationPosture), e.mutationPosture);
});
test('exposurePosture values are safe (no customer_-shaped substring)', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(EXPOSURE.has(e.exposurePosture), e.exposurePosture);
});
test('evidenceStatus values are from the accepted vocabulary', () => {
  for (const e of getBcpC03UiCoverageEntries()) assert.ok(EVIDENCE.has(e.evidenceStatus), e.evidenceStatus);
});
test('no tenant/store/customer/identity/audit/permission FIELDS exist on any entry', () => {
  const BANNED = ['tenant', 'tenantId', 'store', 'storeId', 'customer', 'identity', 'identityLink', 'audit', 'permission', 'rbac', 'internalUserId', 'providerUid', 'email', 'secret', 'token'];
  for (const e of getBcpC03UiCoverageEntries()) for (const k of Object.keys(e)) assert.ok(!BANNED.includes(k), k);
});
test('no raw IDs / uuids / long hex / long digits / secrets / tokens / urls / emails / domains / files', () => {
  for (const e of getBcpC03UiCoverageEntries()) {
    for (const v of Object.values(e)) {
      assert.equal(findSensitive(String(v)), null, `sensitive in: ${v}`);
      assert.ok(!DIGIT_RUN_RE.test(String(v)), `4+ digit run in: ${v}`);
    }
  }
});
test('provider source has NO frontend src import', () => {
  assert.ok(!/from\s*['"][^'"]*\/src\//.test(PROVIDER_CODE) && !/from\s*['"]\.\.\/\.\.\/src/.test(PROVIDER_CODE));
});
test('provider source has NO mockData import', () => { assert.ok(!PROVIDER_CODE.includes('mockData')); });
test('provider source has NO sensitive row-type import', () => {
  for (const t of ['TenantRow', 'StoreRow', 'AuditRow', 'DatabaseRow', 'PermissionRow', 'IdentityLinkRow']) assert.ok(!PROVIDER_CODE.includes(t), t);
});
test('provider source has NO DB / Supabase / provider / live imports or calls', () => {
  for (const bad of ['createClient', '@supabase', 'getDb', 'process.env', 'DATABASE', 'fetch(', 'require(', 'XMLHttpRequest', 'WebSocket', 'node:fs', 'node:net', 'node:http']) {
    assert.ok(!PROVIDER_CODE.includes(bad), `provider references: ${bad}`);
  }
});
test('provider is deterministic across calls', () => {
  assert.deepEqual(getBcpC03UiCoverageEntries(), getBcpC03UiCoverageEntries());
});
test('provider returns a defensive copy (fresh array + fresh objects)', () => {
  const a = getBcpC03UiCoverageEntries();
  const b = getBcpC03UiCoverageEntries();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
});
test('mutating a returned array does not mutate future results', () => {
  const a = getBcpC03UiCoverageEntries();
  a.push({ ...a[0], screenKey: 'injected' });
  a.length = 0;
  assert.equal(getBcpC03UiCoverageEntries().length, EXPECTED_COUNT);
});
test('mutating a returned object does not mutate future results; constant is frozen', () => {
  const a = getBcpC03UiCoverageEntries();
  const firstKey = a[0].screenKey;
  a[0].screenKey = 'tampered';
  assert.equal(getBcpC03UiCoverageEntries()[0].screenKey, firstKey);
  assert.ok(Object.isFrozen(BCP_C03_SERVER_OWNED_UI_COVERAGE_ENTRIES));
  assert.ok(Object.isFrozen(BCP_C03_SERVER_OWNED_UI_COVERAGE_ENTRIES[0]));
});
test('provider has no request/auth/env dependency (zero-arg getter; no tokens in source)', () => {
  assert.equal(getBcpC03UiCoverageEntries.length, 0);
  for (const bad of ['req.', 'request', 'principal', 'session', 'process.env', 'query', 'cookies', 'headers']) {
    assert.ok(!PROVIDER_CODE.includes(bad), `provider references: ${bad}`);
  }
});
test('provider output passes the C-03 read model (no redaction, no unknown status)', () => {
  const env = buildC03UiCoverageEnvelope(getBcpC03UiCoverageEntries());
  for (const it of env.coverageItems) {
    assert.notEqual(it.screenKey, 'redacted_label');
    assert.notEqual(it.screenLabel, 'redacted_label');
    assert.notEqual(it.screenStatus, 'unknown');
    assert.notEqual(it.coverageClass, 'unknown');
    assert.notEqual(it.exposurePosture, 'unknown');
  }
  assert.equal(env.coverageItems.length, EXPECTED_COUNT);
  assert.equal(env.schemaVersion, C03_UI_COVERAGE_SCHEMA_VERSION_V1);
  assert.equal(env.emptyState.isEmpty, false);
  // Pin the documented distribution.
  assert.deepEqual(env.summaryCounts, { total: 14, implemented: 9, preview: 1, placeholder: 2, deferred: 1, blocked: 1, unknown: 0 });
});
test('serialized provider output contains no forbidden sensitive patterns', () => {
  const json = JSON.stringify(getBcpC03UiCoverageEntries());
  assert.equal(findSensitive(json), null);
  assert.ok(!DIGIT_RUN_RE.test(json));
});

(() => {
  let pass = 0; const failures: string[] = [];
  for (const c of cases) { try { c.fn(); pass++; console.log('PASS ' + c.name); } catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } }
  console.log(`\n[M12 BCP C-03 UI coverage provider] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
