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

// ---- M7O: additive envelope metadata (schemaVersion / sourceMode / warnings / freshness) ----
test('M7O: default envelope (no meta) keeps v0-synthetic vocabulary and omits sourceMode', () => {
  const env = buildReadinessSummaryEnvelope(
    allow(),
    { categories: [{ category: 'feature_flag_posture', status: 'enabled', severity: 'low' }] },
    labels,
    '2026-01-01T00:00:00.000Z',
  );
  assert.equal(env.schemaVersion, BCP_READINESS_SCHEMA_VERSION); // bcp.c01.readiness.v0-synthetic
  assert.deepEqual(env.warnings, ['synthetic']);
  assert.equal(env.freshness.lastSuccessfulReadLabel, 'synthetic-no-live-read');
  assert.equal('sourceMode' in env, false); // omitted entirely on the v0 path (back-compat)
});

test('M7O: code/config meta override yields honest v1 schemaVersion + sourceMode + warning + freshness', () => {
  const env = buildReadinessSummaryEnvelope(
    allow(),
    { categories: [{ category: 'feature_flag_posture', status: 'enabled', severity: 'low' }] },
    labels,
    '2026-01-01T00:00:00.000Z',
    'DEV',
    { schemaVersion: 'bcp.c01.readiness.v1-code-config', sourceMode: 'code_config', warnings: ['code_config'], lastSuccessfulReadLabel: 'code-config-no-live-read' },
  );
  assert.equal(env.schemaVersion, 'bcp.c01.readiness.v1-code-config');
  assert.equal(env.sourceMode, 'code_config');
  assert.deepEqual(env.warnings, ['code_config']);
  assert.equal(env.freshness.lastSuccessfulReadLabel, 'code-config-no-live-read');
  assert.ok(env.data && env.data.categories.length === 1); // shape unchanged (additive)
});

test('M7O: unsafe meta values fall back to safe defaults/sentinels (never leak)', () => {
  const env = buildReadinessSummaryEnvelope(
    allow(),
    { categories: [] },
    labels,
    '2026-01-01T00:00:00.000Z',
    'DEV',
    { schemaVersion: 'postgres://leak', sourceMode: 'a@b.com', warnings: ['ok_label', 'bad://warn'], lastSuccessfulReadLabel: 'bad://fresh' },
  );
  assert.equal(env.schemaVersion, BCP_READINESS_SCHEMA_VERSION); // charset-unsafe ⇒ fallback to v0 default
  assert.equal(env.sourceMode, 'redacted_label'); // charset-unsafe ⇒ sentinel
  assert.deepEqual(env.warnings, ['ok_label']); // charset-unsafe warning filtered out
  assert.equal(env.freshness.lastSuccessfulReadLabel, 'synthetic-no-live-read'); // charset-unsafe ⇒ fallback
  const s = JSON.stringify(env);
  for (const bad of ['postgres://', '@', '://']) assert.ok(!s.includes(bad), `leaked: ${bad}`);
});

test('M7O: all-unsafe warnings fall back to the safe default sentinel (never empty)', () => {
  const env = buildReadinessSummaryEnvelope(
    allow(), { categories: [] }, labels, '2026-01-01T00:00:00.000Z', 'DEV',
    { warnings: ['bad://1', 'also://bad'] },
  );
  assert.deepEqual(env.warnings, ['synthetic']);
});

test('M7O: meta is applied on the denied/blocked empty path too', () => {
  const denied = buildReadinessSummaryEnvelope(
    { decision: 'deny', reasonCode: 'insufficient_visibility' },
    { categories: [] }, labels, '2026-01-01T00:00:00.000Z', 'DEV',
    { schemaVersion: 'bcp.c01.readiness.v1-code-config', sourceMode: 'code_config', warnings: ['code_config'] },
  );
  assert.equal(denied.data, null);
  assert.equal(denied.schemaVersion, 'bcp.c01.readiness.v1-code-config');
  assert.equal(denied.sourceMode, 'code_config');
  assert.deepEqual(denied.warnings, ['code_config']);
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

// ---- 6d. NO-THROW: malformed (null / non-object) category elements are skipped, not thrown ----
test('null / undefined / non-object category elements are skipped without throwing', () => {
  const malformed = {
    categories: [
      null,
      undefined,
      42,
      'a string',
      { category: 'valid', status: 'ok', severity: 'low' },
    ],
  } as unknown as SyntheticReadinessSource;
  let env: ReturnType<typeof buildReadinessSummaryEnvelope> | undefined;
  assert.doesNotThrow(() => {
    env = buildReadinessSummaryEnvelope(allow(), malformed, labels, '2026-01-01T00:00:00.000Z');
  });
  // Only the one valid element survives.
  assert.ok(env && env.data && env.data.categories.length === 1);
  assert.equal(env!.data!.categories[0].category, 'valid');
});

// ---- 6e. L2: an undefined-valued forbidden key is NOT over-reported as redacted ----
test('forbidden key present but undefined is not reported as an omitted category', () => {
  const src = { email: undefined, categories: [{ category: 'ok', status: 'ok', severity: 'low' }] } as unknown as SyntheticReadinessSource;
  const env = buildReadinessSummaryEnvelope(allow(), src, labels, '2026-01-01T00:00:00.000Z');
  assert.ok(!env.redaction.omittedCategories.includes('pii'), 'undefined-valued email over-reported');
});

// ---- 6f. L3: a non-string label is coerced AND recorded as sensitive_label_content (no leak) ----
test('non-string category/status is coerced to a sentinel and flagged, with no leak', () => {
  const src = {
    categories: [{ category: { secret: 'SHOULD_NOT_LEAK' }, status: 123, severity: 'low' }],
  } as unknown as SyntheticReadinessSource;
  const env = buildReadinessSummaryEnvelope(allow(), src, labels, '2026-01-01T00:00:00.000Z');
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes('SHOULD_NOT_LEAK'), 'object label leaked');
  assert.equal(env.data!.categories[0].category, 'unknown');
  assert.ok(env.redaction.omittedCategories.includes('sensitive_label_content'));
});

// ---- 6g. STAGING environment label flows through ----
test('STAGING environment label is carried through the envelope', () => {
  const env = buildReadinessSummaryEnvelope(allow(), { categories: [] }, labels, '2026-01-01T00:00:00.000Z', 'STAGING');
  assert.equal(env.environment, 'STAGING');
  assert.equal(env.authorizationContext.environment, 'STAGING');
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
