// Phase 3.0 M3 Gate 1 — tests for the read-only canonical-authorization wiring. Proves the pure result→view
// adapter and the injectable resolve path (platform-scope request; NO durable audit write; fail-closed to null
// on missing identity / build / resolve error). DB-free via injected seams. Runs via `npx tsx`.
import assert from 'node:assert/strict';
import { adaptAuthorizationResultToView, resolveCanonicalPlatformAuthz } from './bcpActionCanonicalAuthzResolver';

const cases: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (n: string, fn: () => Promise<void> | void) => cases.push({ name: n, fn });

const allowResult: any = {
  decision: 'allow', reasonCode: 'resolved', humanReadableReason: '', limitation: 'none',
  authorization: {
    roles: { platformRoleId: 'system_owner', tenantRoleId: null },
    permissions: { admin: 'full', ops: 'full' },
    status: { user: 'active', tenant: null, store: null },
    scope: { scopeType: 'platform', tenantId: null, storeId: null },
  },
};
const denyResult: any = { decision: 'deny', reasonCode: 'denied_no_membership', humanReadableReason: '', limitation: 'none', authorization: null };

test('adapt allow → authority-neutral view', () => {
  const v = adaptAuthorizationResultToView(allowResult);
  assert.equal(v.decision, 'allow'); assert.equal(v.reasonCode, 'resolved'); assert.equal(v.limitation, 'none');
  assert.equal(v.platformRoleId, 'system_owner'); assert.deepEqual(v.permissions, { admin: 'full', ops: 'full' });
  assert.deepEqual(v.statusValues, ['active']); assert.equal(v.scopeType, 'platform');
});
test('adapt deny (null authorization) → fail-closed view', () => {
  const v = adaptAuthorizationResultToView(denyResult);
  assert.equal(v.decision, 'deny'); assert.equal(v.reasonCode, 'denied_no_membership');
  assert.equal(v.platformRoleId, null); assert.deepEqual(v.permissions, {}); assert.deepEqual(v.statusValues, []);
  assert.equal(v.scopeType, 'none');
});
test('adapt read_only limitation preserved', () => {
  assert.equal(adaptAuthorizationResultToView({ ...allowResult, limitation: 'read_only' }).limitation, 'read_only');
});

test('resolve: build returns null → null (no durable identity)', async () => {
  const r = await resolveCanonicalPlatformAuthz('fb_x', { buildInput: async () => null, resolve: (() => allowResult) as any });
  assert.equal(r, null);
});
test('resolve: eligible → adapted allow view; requests platform scope for the exact key', async () => {
  let seenKey: any, seenCtx: any;
  const r = await resolveCanonicalPlatformAuthz('fb_owner', {
    buildInput: async (key: any, ctx: any) => { seenKey = key; seenCtx = ctx; return { some: 'input' }; },
    resolve: (() => allowResult) as any,
  });
  assert.equal(r?.decision, 'allow'); assert.equal(r?.platformRoleId, 'system_owner');
  assert.deepEqual(seenKey, { authProvider: 'firebase', authProviderUid: 'fb_owner' });
  assert.deepEqual(seenCtx, { scopeType: 'platform' });
});
test('resolve: buildInput throws → null', async () => {
  const r = await resolveCanonicalPlatformAuthz('fb_x', { buildInput: async () => { throw new Error('db'); }, resolve: (() => allowResult) as any });
  assert.equal(r, null);
});
test('resolve: resolveAuthorization throws → null', async () => {
  const r = await resolveCanonicalPlatformAuthz('fb_x', { buildInput: async () => ({ some: 'input' }), resolve: (() => { throw new Error('x'); }) as any });
  assert.equal(r, null);
});
test('resolve: canonical deny is a valid view (not null)', async () => {
  const r = await resolveCanonicalPlatformAuthz('fb_x', { buildInput: async () => ({ some: 'input' }), resolve: (() => denyResult) as any });
  assert.equal(r?.decision, 'deny');
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpActionCanonicalAuthzResolver] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
