// Phase 2.0 M10 — Tests for the safe server-owned C-02 module registry provider.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding, NO app.listen. Runnable via
// `npx tsx server/bcp-pilot/bcpC02RegistryProvider.test.ts`. Proves the provider emits ONLY safe bounded
// { id, name, status }, is deterministic / defensively-copied / request-independent, carries NO live /
// DB / Supabase / src / mockData / sensitive-row coupling, and that its output flows cleanly through the
// FROZEN C-02 read model into a non-empty v1 envelope with matching counts. No real ids / secrets.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  getBcpC02RegistryModules,
  BCP_C02_SERVER_OWNED_REGISTRY_MODULES,
} from './bcpC02RegistryProvider';
import {
  buildC02RegistryReadinessEnvelope,
  C02_REGISTRY_SCHEMA_VERSION_V1,
} from './bcpC02RegistryReadModel';

const EXPECTED_COUNT = 33;
const VALID_STATUS = new Set(['included', 'placeholder', 'deferred', 'blocked']);

// Provider source text (comments stripped) for static, leak-shape scans. Comments deliberately mention
// the forbidden tokens to negate them, so they must be removed before scanning the executable code.
const PROVIDER_SRC_RAW = fs.readFileSync(new URL('./bcpC02RegistryProvider.ts', import.meta.url), 'utf8');
const PROVIDER_CODE = PROVIDER_SRC_RAW.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// A safe bounded label mirrors the frozen read-model allow-list: charset + whitespace guard + forbidden
// substrings + id/uuid/digit/domain/file-ext shapes. Returns true only if the value would NOT be redacted.
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

/** Scan an arbitrary serialized string for SENSITIVE shapes (used on provider output, not safe scaffold). */
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

// 1.
test('provider returns an array', () => {
  assert.ok(Array.isArray(getBcpC02RegistryModules()));
});

// 2.
test('provider returns non-empty modules', () => {
  assert.ok(getBcpC02RegistryModules().length > 0);
});

// 3. (actual count documented as 33 — matches the conceptual Backend CP registry.)
test('provider returns the expected bounded module count (33)', () => {
  assert.equal(getBcpC02RegistryModules().length, EXPECTED_COUNT);
});

// 4.
test('every module has ONLY id / name / status (no other fields)', () => {
  for (const m of getBcpC02RegistryModules()) {
    assert.deepEqual(Object.keys(m).sort(), ['id', 'name', 'status']);
  }
});

// 5.
test('id values are safe bounded labels', () => {
  for (const m of getBcpC02RegistryModules()) assert.ok(isSafeLabel(m.id), `unsafe id: ${m.id}`);
});

// 6.
test('name values are safe bounded labels', () => {
  for (const m of getBcpC02RegistryModules()) assert.ok(isSafeLabel(m.name), `unsafe name: ${m.name}`);
});

// 7.
test('status values are from the accepted C-02 status vocabulary', () => {
  for (const m of getBcpC02RegistryModules()) assert.ok(VALID_STATUS.has(m.status), `bad status: ${m.status}`);
});

// 8.
test('no tenant / store / customer / identity / audit FIELDS exist on any module', () => {
  const BANNED_KEYS = [
    'tenant', 'tenantId', 'store', 'storeId', 'customer', 'customerId', 'identity', 'identityLink',
    'audit', 'auditId', 'internalUserId', 'providerUid', 'email', 'secret', 'token', 'permission',
  ];
  for (const m of getBcpC02RegistryModules()) {
    for (const k of Object.keys(m)) assert.ok(!BANNED_KEYS.includes(k), `banned field present: ${k}`);
  }
});

// 9.
test('no raw ids / uuids / long hex / long digits / secrets / tokens / urls / emails / domains / files', () => {
  for (const m of getBcpC02RegistryModules()) {
    for (const v of [m.id, m.name]) {
      const hit = findSensitive(v);
      assert.equal(hit, null, `sensitive shape "${hit}" in: ${v}`);
      assert.ok(!DIGIT_RUN_RE.test(v), `4+ digit run in: ${v}`);
      assert.ok(!DOMAINISH_RE.test(v), `domain shape in: ${v}`);
      assert.ok(!FILE_EXT_RE.test(v), `file ext in: ${v}`);
    }
  }
});

// 10.
test('provider source has NO DB / Supabase / provider / live imports or calls', () => {
  for (const bad of ['createClient', '@supabase', 'getDb', 'process.env.DATABASE', 'http', 'net',
    'node:fs', 'require(', 'fetch(', 'XMLHttpRequest', 'WebSocket']) {
    assert.ok(!PROVIDER_CODE.includes(bad), `provider code references: ${bad}`);
  }
});

// 11.
test('provider is deterministic across calls', () => {
  assert.deepEqual(getBcpC02RegistryModules(), getBcpC02RegistryModules());
});

// 12.
test('provider returns a defensive copy (fresh array + fresh objects each call)', () => {
  const a = getBcpC02RegistryModules();
  const b = getBcpC02RegistryModules();
  assert.notEqual(a, b, 'array reference should differ');
  assert.notEqual(a[0], b[0], 'object reference should differ');
});

// 13.
test('mutating a returned array does not mutate future results', () => {
  const a = getBcpC02RegistryModules();
  a.push({ id: 'injected', name: 'Injected', status: 'included' });
  a.length = 0;
  assert.equal(getBcpC02RegistryModules().length, EXPECTED_COUNT);
});

// 14.
test('mutating a returned module does not mutate future results', () => {
  const a = getBcpC02RegistryModules();
  const firstId = a[0].id;
  a[0].id = 'tampered';
  a[0].name = 'tampered';
  assert.equal(getBcpC02RegistryModules()[0].id, firstId, 'constant must be unaffected');
  // The exported source-of-truth constant is frozen: a write is silently ignored (non-strict) / throws.
  assert.ok(Object.isFrozen(BCP_C02_SERVER_OWNED_REGISTRY_MODULES));
  assert.ok(Object.isFrozen(BCP_C02_SERVER_OWNED_REGISTRY_MODULES[0]));
});

// 15.
test('provider has NO process.env dependency', () => {
  assert.ok(!PROVIDER_CODE.includes('process.env'), 'provider code reads process.env');
});

// 16.
test('provider has NO request dependency (takes zero args, no req/request token)', () => {
  assert.equal(getBcpC02RegistryModules.length, 0, 'getBcpC02RegistryModules must take no arguments');
  for (const bad of ['req.', 'request', 'Request', 'res.', 'query', 'cookies', 'headers', 'params']) {
    assert.ok(!PROVIDER_CODE.includes(bad), `provider code references request token: ${bad}`);
  }
});

// 17.
test('provider has NO auth dependency', () => {
  for (const bad of ['principal', 'session', 'claims', 'Authorization', 'authProvider', 'internalUserId']) {
    assert.ok(!PROVIDER_CODE.includes(bad), `provider code references auth token: ${bad}`);
  }
});

// 18.
test('provider has NO frontend src import', () => {
  assert.ok(!/from\s*['"][^'"]*\/src\//.test(PROVIDER_CODE), 'provider imports from /src/');
  assert.ok(!/from\s*['"]\.\.\/\.\.\/src/.test(PROVIDER_CODE), 'provider imports ../../src');
});

// 19.
test('provider has NO mockData import', () => {
  assert.ok(!PROVIDER_CODE.includes('mockData'), 'provider references mockData');
});

// 20.
test('provider has NO sensitive row-type import', () => {
  for (const t of ['TenantRow', 'StoreRow', 'AuditRow', 'DatabaseRow', 'PermissionRow', 'IdentityLinkRow']) {
    assert.ok(!PROVIDER_CODE.includes(t), `provider references sensitive row type: ${t}`);
  }
});

// 21.
test('provider output passes the accepted C-02 read model (no redaction, no unknown status)', () => {
  const env = buildC02RegistryReadinessEnvelope(getBcpC02RegistryModules());
  for (const item of env.registryItems) {
    assert.notEqual(item.moduleKey, 'redacted_label', 'a module id was redacted by the read model');
    assert.notEqual(item.moduleLabel, 'redacted_label', 'a module name was redacted by the read model');
    assert.notEqual(item.moduleStatus, 'unknown', 'a module status normalized to unknown');
  }
});

// 22.
test('provider output produces a non-empty C-02 v1 envelope', () => {
  const env = buildC02RegistryReadinessEnvelope(getBcpC02RegistryModules());
  assert.equal(env.registryItems.length, EXPECTED_COUNT);
  assert.equal(env.schemaVersion, C02_REGISTRY_SCHEMA_VERSION_V1);
  assert.equal(env.sourceMode, 'code_config');
  assert.equal(env.freshness.lastSuccessfulReadLabel, 'code-config-no-live-read');
});

// 23.
test('C-02 envelope summaryCounts match provider output', () => {
  const mods = getBcpC02RegistryModules();
  const env = buildC02RegistryReadinessEnvelope(mods);
  const tally = (s: string) => mods.filter((m) => m.status === s).length;
  assert.deepEqual(env.summaryCounts, {
    total: mods.length,
    included: tally('included'),
    placeholder: tally('placeholder'),
    deferred: tally('deferred'),
    blocked: tally('blocked'),
    unknown: 0,
  });
  // Pin the documented distribution: 20 included / 9 placeholder / 3 deferred / 1 blocked / 33 total.
  assert.deepEqual(env.summaryCounts, {
    total: 33, included: 20, placeholder: 9, deferred: 3, blocked: 1, unknown: 0,
  });
});

// 24.
test('C-02 envelope emptyState is NOT empty', () => {
  const env = buildC02RegistryReadinessEnvelope(getBcpC02RegistryModules());
  assert.equal(env.emptyState.isEmpty, false);
  assert.equal(env.emptyState.reason, 'none');
});

// 25.
test('serialized provider + envelope output contains no forbidden sensitive patterns', () => {
  const providerJson = JSON.stringify(getBcpC02RegistryModules());
  assert.equal(findSensitive(providerJson), null, 'sensitive shape in serialized provider output');
  assert.ok(!DIGIT_RUN_RE.test(providerJson), '4+ digit run in serialized provider output');
  // The envelope adds only the FROZEN read-model scaffold (deterministic stamp / dotted schema label /
  // posture labels); scan it for SENSITIVE shapes (not the benign timestamp digits / schema dots).
  const envelopeJson = JSON.stringify(buildC02RegistryReadinessEnvelope(getBcpC02RegistryModules()));
  assert.equal(findSensitive(envelopeJson), null, 'sensitive shape in serialized envelope output');
});

// ---- Runner ----
(() => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try { c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M10 BCP C-02 server-owned registry provider] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
