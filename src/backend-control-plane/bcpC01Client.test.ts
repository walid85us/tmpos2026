// Phase 2.0 M7L — Tests for the DEV-only C-01 readiness client + safe view-model.
//
// Self-contained, NETWORK-FREE (fetch is injected), DB-FREE, Supabase-FREE. Runnable via `npx tsx`.
// Covers classification, the safe label boundary (malicious payloads never leak), and that the
// fetch is GET-only with no body / no credentials / no identity fields.

import assert from 'node:assert/strict';
import {
  classifyC01Response,
  toSafeReadinessRows,
  toneForStatus,
  safeLabel,
  fetchC01Readiness,
} from './bcpC01Client';

// A minimal valid success envelope (mirrors the M7K code/config output shape).
const envelope = {
  schemaVersion: 'bcp.c01.readiness.v0-synthetic',
  environment: 'DEV',
  generatedAt: '2026-01-01T00:00:00.000Z',
  data: {
    categories: [
      { category: 'feature_flag_posture', status: 'enabled', severity: 'low' },
      { category: 'synthetic_live_boundary_posture', status: 'code_config_only', severity: 'low' },
      { category: 'parity_posture', status: 'static_config', severity: 'low' },
      { category: 'production_disabled_posture', status: 'production_disabled', severity: 'low' },
    ],
  },
  authorizationContext: { visibilityClass: 'overview_viewer', scopeType: 'platform', environment: 'DEV', parityState: 'ready' },
  warnings: ['synthetic'],
};

const FORBIDDEN_TOKENS = ['postgres://', 'Bearer', 'eyJ', 'service_role', '@', 'iu_'];

const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn });

test('classify 200 envelope => success with safe rows + derived postures', () => {
  const r = classifyC01Response(200, envelope);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.ok(r.rows.length >= 4);
  assert.equal(r.sourceMode, 'code_config_only');
  assert.equal(r.parity, 'static_config');
  assert.equal(r.environment, 'DEV');
  assert.equal(r.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(r.warnings, ['synthetic']);
});

test('classify 404 feature_disabled / dev_only / generic', () => {
  assert.equal(classifyC01Response(404, { status: 'unavailable', reason: 'feature_disabled' }).kind, 'feature_disabled');
  assert.equal(classifyC01Response(404, { status: 'unavailable', reason: 'dev_only' }).kind, 'dev_only');
  assert.equal(classifyC01Response(404, { status: 'unavailable' }).kind, 'unavailable');
});

test('classify 403 / 409 / 405 / 500 / 0 / unknown', () => {
  assert.equal(classifyC01Response(403, { status: 'not_authorized' }).kind, 'unauthorized');
  assert.equal(classifyC01Response(409, { status: 'parity_blocked' }).kind, 'parity_blocked');
  assert.equal(classifyC01Response(405, { status: 'method_not_allowed' }).kind, 'unexpected');
  assert.equal(classifyC01Response(500, { status: 'error' }).kind, 'error');
  assert.equal(classifyC01Response(0, null).kind, 'unavailable');
  assert.equal(classifyC01Response(418, { weird: true }).kind, 'unexpected');
});

test('classify 200 non-envelope => unexpected (fail-safe)', () => {
  assert.equal(classifyC01Response(200, { hello: 'world' }).kind, 'unexpected');
});

test('safeLabel rejects unsafe values', () => {
  assert.equal(safeLabel('feature_flag_posture'), 'feature_flag_posture');
  assert.equal(safeLabel('postgres://secret@host/db'), 'redacted');
  assert.equal(safeLabel('a@b.com'), 'redacted');
  assert.equal(safeLabel('Bearer eyJabc'), 'redacted');
  assert.equal(safeLabel(12345), 'redacted');
  assert.equal(safeLabel({}), 'redacted');
  // Id-shaped values redacted even when charset-valid; legit posture labels preserved.
  assert.equal(safeLabel('123456'), 'redacted');
  assert.equal(safeLabel('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), 'redacted');
  assert.equal(safeLabel('production_disabled'), 'production_disabled');
  assert.equal(safeLabel('code_config_only'), 'code_config_only');
});

test('toSafeReadinessRows reads ONLY category/status and redacts unsafe values', () => {
  const malicious = {
    data: {
      categories: [
        // forbidden value in status, and an injected raw id field that must be ignored
        { category: 'feature_flag_posture', status: 'postgres://u:p@host/db', internalUserId: 'iu_attacker', severity: 'low' },
        { category: 'x@evil', status: 'enabled' },
      ],
    },
  };
  const rows = toSafeReadinessRows(malicious);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'redacted'); // forbidden value never leaks
  assert.equal(rows[1].label, 'redacted'); // unsafe category label redacted
  // The injected raw id field is never present in any row.
  const s = JSON.stringify(rows);
  for (const bad of FORBIDDEN_TOKENS) assert.ok(!s.includes(bad), `leaked forbidden token: ${bad}`);
});

test('success result never serializes a forbidden token even from a malicious envelope', () => {
  const malicious = {
    schemaVersion: 'bcp.c01.readiness.v0-synthetic',
    data: { categories: [{ category: 'parity_posture', status: 'service_role_key', internalUserId: 'iu_x' }] },
    authorizationContext: { environment: 'DEV', internalUserId: 'iu_leak' },
    warnings: ['Bearer eyJ'],
    generatedAt: 'not-a-timestamp',
  };
  const r = classifyC01Response(200, malicious);
  assert.equal(r.kind, 'success');
  const s = JSON.stringify(r);
  for (const bad of FORBIDDEN_TOKENS) assert.ok(!s.includes(bad), `leaked forbidden token: ${bad}`);
  if (r.kind === 'success') assert.equal(r.generatedAt, undefined); // bad timestamp dropped
});

test('toneForStatus maps statuses sensibly', () => {
  assert.equal(toneForStatus('ready'), 'healthy');
  assert.equal(toneForStatus('enabled'), 'healthy');
  assert.equal(toneForStatus('blocked'), 'blocked');
  assert.equal(toneForStatus('production_disabled'), 'blocked');
  assert.equal(toneForStatus('deferred'), 'warning');
  assert.equal(toneForStatus('static_config'), 'neutral');
});

test('fetchC01Readiness sends GET only — no body, no credentials, no auth/identity headers', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return { status: 200, json: async () => envelope } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await fetchC01Readiness({ fetchImpl: fakeFetch, url: '/__identity/dev/bcp/readiness-summary' });
  assert.equal(r.kind, 'success');
  assert.ok(captured);
  const init = captured!.init;
  assert.equal(init.method, 'GET');
  assert.equal('body' in init, false); // never a body
  assert.equal(init.credentials, 'omit');
  const headers = (init.headers ?? {}) as Record<string, string>;
  assert.equal('authorization' in headers, false);
  assert.equal('Authorization' in headers, false);
  // No client identity/tenant/store fields anywhere in the request.
  const s = JSON.stringify({ url: captured!.url, init: { method: init.method, headers, credentials: init.credentials } });
  for (const bad of ['internalUserId', 'tenantId', 'storeId', 'email', 'uid']) {
    assert.ok(!s.includes(bad), `request carried identity field: ${bad}`);
  }
});

test('fetchC01Readiness maps a thrown fetch (proxy/API down) to unavailable', async () => {
  const throwing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const r = await fetchC01Readiness({ fetchImpl: throwing, url: '/x' });
  assert.equal(r.kind, 'unavailable');
});

test('fetchC01Readiness maps a feature_disabled body to feature_disabled', async () => {
  const fakeFetch = (async () => ({ status: 404, json: async () => ({ status: 'unavailable', reason: 'feature_disabled' }) } as unknown as Response)) as unknown as typeof fetch;
  const r = await fetchC01Readiness({ fetchImpl: fakeFetch, url: '/x' });
  assert.equal(r.kind, 'feature_disabled');
});

test('fetchC01Readiness maps a non-JSON 5xx to unavailable', async () => {
  const fakeFetch = (async () => ({ status: 502, json: async () => { throw new Error('not json'); } } as unknown as Response)) as unknown as typeof fetch;
  const r = await fetchC01Readiness({ fetchImpl: fakeFetch, url: '/x' });
  assert.equal(r.kind, 'unavailable');
});

// ---- M7Q: top-level sourceMode hardening ----

// A v1 code/config envelope: top-level `sourceMode` present and safe, AND the in-band category still
// present (mirrors the real M7K/M7O output — top-level should take precedence over the category).
const v1Envelope = {
  schemaVersion: 'bcp.c01.readiness.v1-code-config',
  sourceMode: 'code_config',
  environment: 'DEV',
  generatedAt: '2026-01-01T00:00:00.000Z',
  data: {
    categories: [
      { category: 'feature_flag_posture', status: 'enabled', severity: 'low' },
      { category: 'synthetic_live_boundary_posture', status: 'code_config_only', severity: 'low' },
      { category: 'parity_posture', status: 'static_config', severity: 'low' },
    ],
  },
  authorizationContext: { environment: 'DEV' },
  warnings: ['code_config'],
};

test('M7Q: safeLabel accepts code_config / code_config_only as safe bounded source modes', () => {
  assert.equal(safeLabel('code_config'), 'code_config');
  assert.equal(safeLabel('code_config_only'), 'code_config_only');
  assert.equal(safeLabel('live_provider'), 'live_provider');
});

test('M7Q: v1 top-level sourceMode (code_config) is read and preferred over in-band category', () => {
  const r = classifyC01Response(200, v1Envelope);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.sourceMode, 'code_config'); // top-level wins over category 'code_config_only'
  // The in-band category row is still present (compatibility preserved).
  assert.ok(r.rows.some((row) => row.label === 'synthetic_live_boundary_posture' && row.status === 'code_config_only'));
});

test('M7Q: v1-shaped response with NO top-level sourceMode falls back to in-band category', () => {
  const v1NoTop = {
    schemaVersion: 'bcp.c01.readiness.v1-code-config',
    environment: 'DEV',
    data: { categories: [{ category: 'synthetic_live_boundary_posture', status: 'code_config_only', severity: 'low' }] },
    authorizationContext: { environment: 'DEV' },
    warnings: ['code_config'],
  };
  const r = classifyC01Response(200, v1NoTop);
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.sourceMode, 'code_config_only'); // in-band fallback preserved
});

test('M7Q: v0 envelope (no top-level sourceMode) keeps existing in-band fallback', () => {
  const r = classifyC01Response(200, envelope); // existing v0 fixture has no top-level sourceMode
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.sourceMode, 'code_config_only');
});

test('M7Q: unknown future schemaVersion still classifies success and reads a safe top-level sourceMode', () => {
  const r = classifyC01Response(200, { ...v1Envelope, schemaVersion: 'bcp.c01.readiness.v9-future', sourceMode: 'live_provider' });
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.sourceMode, 'live_provider');
});

test('M7Q: empty / malformed top-level sourceMode is neutralized (never falls through to category)', () => {
  // Each is caught by a different safeLabel guard: '' & '  ' (trim-empty), 'has\ttab' (charset regex),
  // 123/{}/null/true/[] (typeof). All must map to 'redacted_label' — never the category fallback.
  const bads: unknown[] = ['', 123, {}, null, true, [], '  ', 'has\ttab'];
  for (const bad of bads) {
    const r = classifyC01Response(200, { ...v1Envelope, sourceMode: bad });
    assert.equal(r.kind, 'success');
    if (r.kind !== 'success') continue;
    assert.equal(r.sourceMode, 'redacted_label', `value ${JSON.stringify(bad)} not neutralized`);
  }
});

test('M7Q: hostile top-level sourceMode (forbidden substring / id-shaped / token / email) is redacted and never leaks', () => {
  const hostiles = [
    'service_role_key', 'iu_attacker', 'sk-deadbeef', 'Bearer eyJabc', 'a@b.com',
    'postgres://u:p@h/db', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', '1234567890',
  ];
  for (const h of hostiles) {
    const r = classifyC01Response(200, { ...v1Envelope, sourceMode: h });
    assert.equal(r.kind, 'success');
    if (r.kind !== 'success') continue;
    assert.equal(r.sourceMode, 'redacted_label', `hostile sourceMode not redacted: ${h}`);
    const s = JSON.stringify(r);
    for (const bad of [...FORBIDDEN_TOKENS, 'service_role', 'sk-', '1234567890', 'a1b2c3d4']) {
      assert.ok(!s.includes(bad), `leaked via sourceMode: ${bad}`);
    }
  }
});

test('M7Q: fetch surfaces top-level sourceMode end-to-end — still GET-only, no body/credentials/auth', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return { status: 200, json: async () => v1Envelope } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await fetchC01Readiness({ fetchImpl: fakeFetch, url: '/__identity/dev/bcp/readiness-summary' });
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') assert.equal(r.sourceMode, 'code_config');
  assert.ok(captured);
  const init = captured!.init;
  assert.equal(init.method, 'GET');
  assert.equal('body' in init, false);
  assert.equal(init.credentials, 'omit');
  const headers = (init.headers ?? {}) as Record<string, string>;
  assert.equal('authorization' in headers, false);
  assert.equal('Authorization' in headers, false);
  const s = JSON.stringify({ url: captured!.url, init: { method: init.method, headers, credentials: init.credentials } });
  for (const bad of ['internalUserId', 'tenantId', 'storeId', 'email', 'uid']) {
    assert.ok(!s.includes(bad), `request carried identity field: ${bad}`);
  }
});

// ---- Runner ----
(async () => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try { await c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M7L BCP C-01 client] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
