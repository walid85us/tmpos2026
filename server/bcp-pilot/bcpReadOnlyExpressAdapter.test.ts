// Phase 2.0 M7G — Tests for the thin Express adapter that registers the inert BCP read-only route.
//
// Self-contained, DB-FREE, Supabase-FREE, network-FREE, NO port binding (does NOT import server.ts,
// which calls app.listen at import time). Tests the adapter handler directly with a fake req/res.
// Runnable via `npx tsx <thisfile>`. No real ids/secrets — synthetic placeholders only.

import assert from 'node:assert/strict';
import { createBcpReadinessSummaryHandler, BCP_READINESS_ROUTE_PATH } from './bcpReadOnlyExpressAdapter';
import { BCP_DEV_READONLY_PILOT_FLAG } from './bcpPilotConfig';

// Minimal fake Express res capturing status/headers/body/ended.
interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
  setHeader(k: string, v: string): void;
  status(c: number): FakeRes;
  json(b: unknown): void;
  end(): void;
}
function fakeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; },
    end() { this.ended = true; },
  };
}

const handler = createBcpReadinessSummaryHandler();
const call = (method: string): FakeRes => {
  const res = fakeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler({ method } as any, res as any);
  return res;
};

function withEnv(flag: string | undefined, nodeEnv: string | undefined, fn: () => void) {
  const pf = process.env[BCP_DEV_READONLY_PILOT_FLAG];
  const pn = process.env.NODE_ENV;
  try {
    if (flag === undefined) delete process.env[BCP_DEV_READONLY_PILOT_FLAG]; else process.env[BCP_DEV_READONLY_PILOT_FLAG] = flag;
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    fn();
  } finally {
    if (pf === undefined) delete process.env[BCP_DEV_READONLY_PILOT_FLAG]; else process.env[BCP_DEV_READONLY_PILOT_FLAG] = pf;
    if (pn === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = pn;
  }
}

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

test('route path is the isolated DEV path', () => {
  assert.equal(BCP_READINESS_ROUTE_PATH, '/dev/bcp/readiness-summary');
});

test('flag OFF (dev) => 404 feature_disabled, no data', () => {
  withEnv(undefined, 'development', () => {
    const r = call('GET');
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' });
  });
});

test('production with flag TRUE => unavailable (dev_only), no data', () => {
  withEnv('true', 'production', () => {
    const r = call('GET');
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.body, { status: 'unavailable', reason: 'dev_only' });
  });
});

test('enabled + DEV + GET => 200 synthetic_success envelope (no forbidden values)', () => {
  withEnv('true', 'development', () => {
    const r = call('GET');
    assert.equal(r.statusCode, 200);
    assert.ok(r.body && typeof r.body === 'object' && 'schemaVersion' in (r.body as object));
    const s = JSON.stringify(r.body);
    for (const bad of ['postgres://', 'Bearer', 'eyJ', 'service_role', '@']) {
      assert.ok(!s.includes(bad), `forbidden token leaked: ${bad}`);
    }
  });
});

test('enabled + DEV + GET => envelope carries the M7K code/config posture (code_config_only)', () => {
  withEnv('true', 'development', () => {
    const r = call('GET');
    assert.equal(r.statusCode, 200);
    const body = r.body as { data?: { categories?: Array<{ category: string; status: string }> } };
    const categories = body.data?.categories ?? [];
    const names = categories.map((c) => c.category);
    assert.ok(names.includes('feature_flag_posture'), 'expected code/config feature_flag_posture category');
    const boundary = categories.find((c) => c.category === 'synthetic_live_boundary_posture');
    assert.equal(boundary?.status, 'code_config_only');
  });
});

test('adapter ignores request body/query/headers — authority/content is server-side only', () => {
  withEnv('true', 'development', () => {
    const plain = call('GET');
    const res = fakeRes();
    const junkReq = {
      method: 'GET',
      body: { internalUserId: 'iu_attacker', email: 'evil@example.com' },
      query: { tenant: 't-injected', authProviderUid: 'uid-injected' },
      headers: { authorization: 'Bearer injected' },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler(junkReq as any, res as any);
    assert.equal(res.statusCode, 200);
    // Identical to a plain GET ⇒ request fields had zero influence on the response.
    assert.deepEqual(res.body, plain.body);
    // And none of the injected values leaked into the response body.
    const s = JSON.stringify(res.body);
    for (const bad of ['iu_attacker', 'evil@example.com', 't-injected', 'uid-injected', 'Bearer']) {
      assert.ok(!s.includes(bad), `injected request value leaked: ${bad}`);
    }
  });
});

test('enabled + DEV + POST => 405 method_not_allowed, Allow: GET, no side effect', () => {
  withEnv('true', 'development', () => {
    const r = call('POST');
    assert.equal(r.statusCode, 405);
    assert.equal(r.headers.Allow, 'GET');
    assert.deepEqual(r.body, { status: 'method_not_allowed' });
  });
});

test('enabled + DEV + OPTIONS => 204 Allow: GET, no body', () => {
  withEnv('true', 'development', () => {
    const r = call('OPTIONS');
    assert.equal(r.statusCode, 204);
    assert.equal(r.headers.Allow, 'GET');
    assert.equal(r.body, undefined);
    assert.equal(r.ended, true);
  });
});

test('enabled + DEV + HEAD => 200, no body', () => {
  withEnv('true', 'development', () => {
    const r = call('HEAD');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, undefined);
    assert.equal(r.ended, true);
  });
});

// ---- Runner ----
(() => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try { c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M7G BCP inert route Express adapter] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
