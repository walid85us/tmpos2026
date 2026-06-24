// Phase 2.0 M7C — Unit tests for the BCP DEV-only read-only pilot foundation + synthetic harness.
//
// Self-contained, in-memory, DB-FREE, Supabase-FREE, network-FREE. Runnable via `npx tsx <thisfile>`
// (the repo ships no test framework; mirrors the existing assertion-script convention). Uses Node's
// built-in assert. NO real ids/uids/emails/tokens/secrets — obvious fake placeholders only. NO live
// data, NO route registration, NO production path.

import assert from 'node:assert/strict';
import {
  BCP_DEV_READONLY_PILOT_FLAG,
  isBcpDevReadonlyPilotEnabled,
} from './bcpPilotConfig';
import {
  authorizeBcpRead,
  type SyntheticServerPrincipal,
  type GuardRequest,
} from './bcpAuthorizationGuard';
import {
  buildReadinessSummaryEnvelope,
  BCP_READINESS_SCHEMA_VERSION,
  type SyntheticReadinessSource,
  type ReadinessAuthLabels,
} from './bcpReadinessSummaryHarness';

// ---- Helpers (synthetic only) ----
const goodPrincipal = (over: Partial<SyntheticServerPrincipal> = {}): SyntheticServerPrincipal => ({
  source: 'server_derived',
  internalUserId: 'iu_synthetic_0001',
  authProvider: 'supabase',
  verified: true,
  scopeType: 'platform',
  parityState: 'ready',
  visibilityClass: 'overview_viewer',
  ...over,
});

const guardReq = (over: Partial<GuardRequest> = {}): GuardRequest => ({
  contractId: 'C-01',
  featureEnabled: true,
  principal: goodPrincipal(),
  ...over,
});

const labels: ReadinessAuthLabels = {
  visibilityClass: 'overview_viewer',
  scopeType: 'platform',
  parityState: 'ready',
};

const allow = () => authorizeBcpRead(guardReq());

// Snapshot + restore the flag env around flag tests.
function withFlagEnv(value: string | undefined, nodeEnv: string | undefined, fn: () => void) {
  const prevFlag = process.env[BCP_DEV_READONLY_PILOT_FLAG];
  const prevNode = process.env.NODE_ENV;
  try {
    if (value === undefined) delete process.env[BCP_DEV_READONLY_PILOT_FLAG];
    else process.env[BCP_DEV_READONLY_PILOT_FLAG] = value;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    fn();
  } finally {
    if (prevFlag === undefined) delete process.env[BCP_DEV_READONLY_PILOT_FLAG];
    else process.env[BCP_DEV_READONLY_PILOT_FLAG] = prevFlag;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  }
}

const cases: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

// ---- 1. Feature flag default-off + DEV-only gate ----
test('flag is OFF when unset', () => {
  withFlagEnv(undefined, 'development', () => assert.equal(isBcpDevReadonlyPilotEnabled(), false));
});
test('flag is OFF for non-"true" values', () => {
  for (const v of ['', 'false', '1', 'yes', 'TRUE']) {
    withFlagEnv(v, 'development', () => assert.equal(isBcpDevReadonlyPilotEnabled(), false));
  }
});
test('flag is ON only for exactly "true" in non-production', () => {
  withFlagEnv('true', 'development', () => assert.equal(isBcpDevReadonlyPilotEnabled(), true));
});
test('flag is OFF in production even when set to "true" (DEV-only gate)', () => {
  withFlagEnv('true', 'production', () => assert.equal(isBcpDevReadonlyPilotEnabled(), false));
});

// ---- 2. Guard: feature-disabled denies ----
test('guard denies when feature disabled', () => {
  const r = authorizeBcpRead(guardReq({ featureEnabled: false }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'feature_disabled');
});

// ---- 3. Guard: fail-closed authorization ----
test('guard allows a valid verified server principal', () => {
  const r = allow();
  assert.equal(r.decision, 'allow');
  assert.equal(r.reasonCode, 'allow');
});
test('guard denies when no principal', () => {
  const r = authorizeBcpRead(guardReq({ principal: null }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'no_server_principal');
});
test('guard denies an unverified principal', () => {
  const r = authorizeBcpRead(guardReq({ principal: goodPrincipal({ verified: false }) }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'unverified_principal');
});
test('guard fails closed when internalUserId is null', () => {
  const r = authorizeBcpRead(guardReq({ principal: goodPrincipal({ internalUserId: null }) }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'no_internal_user_id');
});
test('guard blocks when parity is unresolved', () => {
  const r = authorizeBcpRead(guardReq({ principal: goodPrincipal({ parityState: 'unresolved' }) }));
  assert.equal(r.decision, 'blocked');
  assert.equal(r.reasonCode, 'parity_unresolved');
});
test('guard denies insufficient visibility', () => {
  const r = authorizeBcpRead(guardReq({ principal: goodPrincipal({ visibilityClass: 'none' }) }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'insufficient_visibility');
});
test('guard denies an unknown contract', () => {
  const r = authorizeBcpRead(guardReq({ contractId: 'C-99' }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'unknown_contract');
});
test('guard fails closed on a malformed/unknown visibility class (defense-in-depth)', () => {
  const bogus = { ...goodPrincipal(), visibilityClass: 'bogus' } as unknown as SyntheticServerPrincipal;
  const r = authorizeBcpRead(guardReq({ principal: bogus }));
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'insufficient_visibility');
});

// ---- 4. Guard: forbidden authority inputs never become authority ----
test('client-supplied UID / email / frontend claim alone never authorizes', () => {
  const r = authorizeBcpRead(
    guardReq({
      principal: null,
      hints: {
        clientSuppliedUid: 'attacker_uid',
        email: 'fake@example.test',
        frontendRoleLabel: 'system_owner',
        urlTenantParam: 't_fake',
        bodyInternalUserId: 'iu_fake',
      },
    }),
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'untrusted_authority_only');
});
test('untrusted hints do NOT change an authorized decision (ignored, not trusted)', () => {
  const withHints = authorizeBcpRead(
    guardReq({ hints: { clientSuppliedUid: 'x', email: 'y@z.test', frontendRoleLabel: 'system_owner' } }),
  );
  assert.equal(withHints.decision, 'allow'); // same as without hints — authority came only from principal
});

// ---- 5. DTO envelope: schema + redaction metadata ----
test('allowed envelope has schemaVersion + redaction/freshness/authorizationContext/emptyState', () => {
  const env = buildReadinessSummaryEnvelope(
    allow(),
    { categories: [{ category: 'identity_readiness', status: 'gated', severity: 'medium' }] },
    labels,
    '2026-01-01T00:00:00.000Z',
  );
  assert.equal(env.schemaVersion, BCP_READINESS_SCHEMA_VERSION);
  assert.equal(env.redaction.redactionApplied, true);
  assert.ok(env.freshness.lastSuccessfulReadLabel);
  assert.equal(env.authorizationContext.environment, 'DEV');
  assert.equal(env.emptyState.isEmpty, false);
  assert.ok(env.data && env.data.categories.length === 1);
});

// ---- 6. DTO envelope: forbidden fields are stripped, never passed through ----
test('forbidden source fields are blocked and reported as omitted categories', () => {
  const malicious: SyntheticReadinessSource = {
    secret: 'SHOULD_NOT_LEAK',
    token: 'SHOULD_NOT_LEAK',
    email: 'leak@example.test',
    tenantId: 't_raw_123',
    identityLinkRow: { provider_uid: 'raw' },
    permissionKeys: ['pos.read', 'pos.write'],
    categories: [
      { category: 'system_ops', status: 'ok', severity: 'low', rawId: 'raw_999', dbUrl: 'postgres://leak' },
    ],
  };
  const env = buildReadinessSummaryEnvelope(allow(), malicious, labels, '2026-01-01T00:00:00.000Z');
  const serialized = JSON.stringify(env);
  for (const needle of [
    'SHOULD_NOT_LEAK',
    'leak@example.test',
    't_raw_123',
    'raw_999',
    'postgres://leak',
    'pos.write',
    'provider_uid',
  ]) {
    assert.ok(!serialized.includes(needle), `forbidden value leaked: ${needle}`);
  }
  // Forbidden keys are reported only as GENERIC categories — never the raw key name or value.
  for (const cat of ['secret_material', 'pii', 'tenant_scope_id', 'identity_internal', 'authorization_keys', 'raw_identifier', 'connection_string']) {
    assert.ok(env.redaction.omittedCategories.includes(cat), `expected omitted category: ${cat}`);
  }
  // The raw field NAMES must NOT appear either (categories, not field names).
  for (const rawName of ['identityLinkRow', 'permissionKeys']) {
    assert.ok(!env.redaction.omittedCategories.includes(rawName), `raw field name leaked: ${rawName}`);
  }
  assert.equal(env.redaction.redactionLevel, 'strict');
});

// ---- 6b. DTO envelope: forbidden value embedded INSIDE an allowed label is sanitized ----
test('a forbidden value embedded in category/status label is replaced, not emitted', () => {
  const env = buildReadinessSummaryEnvelope(
    allow(),
    { categories: [{ category: 'leak@example.test', status: 'postgres://leak/db', severity: 'low' }] },
    labels,
    '2026-01-01T00:00:00.000Z',
  );
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes('leak@example.test'), 'email in label leaked');
  assert.ok(!serialized.includes('postgres://leak/db'), 'url in label leaked');
  assert.ok(env.data && env.data.categories[0].category === 'redacted_label');
  assert.ok(env.data && env.data.categories[0].status === 'redacted_label');
  assert.ok(env.redaction.omittedCategories.includes('sensitive_label_content'));
});

// ---- 6c. DTO envelope: invalid generatedAt is replaced with a safe sentinel ----
test('non-ISO generatedAt is replaced with a safe sentinel', () => {
  const env = buildReadinessSummaryEnvelope(allow(), { categories: [] }, labels, 'not-a-timestamp; DROP');
  assert.equal(env.generatedAt, 'redacted-timestamp');
  assert.equal(env.freshness.generatedAt, 'redacted-timestamp');
});

// ---- 7. DTO envelope: safe empty state ----
test('empty source yields a safe empty-state envelope with null data', () => {
  const env = buildReadinessSummaryEnvelope(allow(), { categories: [] }, labels, '2026-01-01T00:00:00.000Z');
  assert.equal(env.data, null);
  assert.equal(env.emptyState.isEmpty, true);
  assert.equal(env.emptyState.reason, 'no_visible_records');
});

// ---- 8. DTO envelope: fail closed on non-allow guard ----
test('denied guard yields not_authorized empty envelope with no data', () => {
  const denied = authorizeBcpRead(guardReq({ principal: null }));
  const env = buildReadinessSummaryEnvelope(denied, { categories: [{ category: 'x', status: 'y', severity: 'low' }] }, labels, '2026-01-01T00:00:00.000Z');
  assert.equal(env.data, null);
  assert.equal(env.emptyState.isEmpty, true);
  assert.equal(env.emptyState.reason, 'not_authorized');
});
test('blocked guard (parity) yields blocked_by_phase empty envelope with no data', () => {
  const blk = authorizeBcpRead(guardReq({ principal: goodPrincipal({ parityState: 'unresolved' }) }));
  const env = buildReadinessSummaryEnvelope(blk, { categories: [{ category: 'x', status: 'y', severity: 'low' }] }, labels, '2026-01-01T00:00:00.000Z');
  assert.equal(env.data, null);
  assert.equal(env.emptyState.isEmpty, true);
  assert.equal(env.emptyState.reason, 'blocked_by_phase');
});

// ---- 9. No-mutation / purity: building the envelope does not mutate the source ----
test('mapper does not mutate the synthetic source object', () => {
  const source: SyntheticReadinessSource = { categories: [{ category: 'a', status: 'ok', severity: 'low' }] };
  const snapshot = JSON.stringify(source);
  buildReadinessSummaryEnvelope(allow(), source, labels, '2026-01-01T00:00:00.000Z');
  assert.equal(JSON.stringify(source), snapshot);
});

// ---- 10. authorizationContext carries posture labels only (no raw ids) ----
test('authorizationContext carries only safe posture labels', () => {
  const env = buildReadinessSummaryEnvelope(allow(), { categories: [] }, labels, '2026-01-01T00:00:00.000Z');
  const ctxKeys = Object.keys(env.authorizationContext).sort();
  assert.deepEqual(ctxKeys, ['environment', 'parityState', 'scopeType', 'visibilityClass']);
});

// ---- Runner ----
(() => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      c.fn();
      pass++;
      console.log('PASS ' + c.name);
    } catch (e) {
      failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e)));
      console.log('FAIL ' + c.name);
    }
  }
  console.log(`\n[M7C BCP DEV read-only pilot foundation + synthetic harness] ${pass}/${cases.length} passed`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();
