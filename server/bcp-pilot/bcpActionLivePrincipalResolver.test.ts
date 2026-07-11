// Phase 3.0 M3 Gate 1 — tests for the live-principal resolver: Firebase-verified identity + canonical
// authorization → BCP action principal. DB-FREE + Firebase-FREE: every dependency (verify / identity lookup /
// canonical authz) is injected. Proves the exhaustive role→visibility mapping, canonical-derived permission
// (never role-name-inferred), cap derivation, parity derivation, fail-closed unknown/missing, and the ordered
// orchestration outcomes. Also proves end-to-end allow/deny THROUGH the real bcpActionAuthorizationGuard.
import assert from 'node:assert/strict';
import {
  translateToBcpActionPrincipal,
  resolveLiveBcpActionPrincipal,
  type CanonicalAuthzView,
} from './bcpActionLivePrincipalResolver';
import { authorizeBcpAction } from './bcpActionAuthorizationGuard';

const cases: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (n: string, fn: () => Promise<void> | void) => cases.push({ name: n, fn });

const view = (o: Partial<CanonicalAuthzView> = {}): CanonicalAuthzView => ({
  decision: 'allow', reasonCode: 'resolved', limitation: 'none',
  platformRoleId: 'system_owner', permissions: { admin: 'full', ops: 'full' },
  statusValues: ['active', 'active', 'active'], scopeType: 'platform', ...o,
});

// Run the translated principal through the REAL guard (DEV + flag on) to prove the final decision.
const decide = (t: ReturnType<typeof translateToBcpActionPrincipal>) =>
  authorizeBcpAction({
    actionKey: 'bcp.action.acknowledge_readiness_review', isDevEnvironment: true, featureEnabled: true,
    principal: t.principal, platformPermissionLevel: t.platformPermissionLevel,
    planReadOnly: t.planReadOnly, planOverdue: t.planOverdue,
  }).decision;

// ---------- translation: role → visibility + end-to-end guard ----------
test('eligible system_owner → system_owner / ready / full → guard ALLOW', () => {
  const t = translateToBcpActionPrincipal('iu_owner', view());
  assert.equal(t.principal.visibilityClass, 'system_owner');
  assert.equal(t.principal.parityState, 'ready');
  assert.equal(t.principal.source, 'server_derived');
  assert.equal(t.principal.verified, true);
  assert.equal(t.principal.internalUserId, 'iu_owner');
  assert.equal(t.principal.authProvider, 'firebase');
  assert.equal(t.platformPermissionLevel, 'full');
  assert.equal(t.planReadOnly, false);
  assert.equal(decide(t), 'allow');
});
for (const role of ['support_admin', 'billing_admin', 'operations_admin', 'security_admin']) {
  test(`${role} → NOT system_owner → guard DENY`, () => {
    const t = translateToBcpActionPrincipal('iu_x', view({ platformRoleId: role }));
    assert.notEqual(t.principal.visibilityClass, 'system_owner');
    assert.equal(decide(t), 'deny');
  });
}
test('unknown role → visibility none → guard DENY', () => {
  assert.equal(decide(translateToBcpActionPrincipal('iu_x', view({ platformRoleId: 'wat' }))), 'deny');
});
test('null role → visibility none → guard DENY', () => {
  const t = translateToBcpActionPrincipal('iu_x', view({ platformRoleId: null }));
  assert.equal(t.principal.visibilityClass, 'none');
  assert.equal(decide(t), 'deny');
});

// ---------- permission derived from CANONICAL map, never role name ----------
test('system_owner but canonical map floor=manage → level manage → ALLOW (manage meets manage)', () => {
  const t = translateToBcpActionPrincipal('iu', view({ permissions: { a: 'full', b: 'manage' } }));
  assert.equal(t.platformPermissionLevel, 'manage'); assert.equal(decide(t), 'allow');
});
test('system_owner but canonical map floor=view → level view → DENY (not role-name inferred)', () => {
  const t = translateToBcpActionPrincipal('iu', view({ permissions: { a: 'full', b: 'view' } }));
  assert.equal(t.platformPermissionLevel, 'view'); assert.equal(decide(t), 'deny');
});
test('empty canonical permissions → level none → DENY', () => {
  assert.equal(decide(translateToBcpActionPrincipal('iu', view({ permissions: {} }))), 'deny');
});

// ---------- caps ----------
test('limitation read_only → planReadOnly → DENY (capped below manage)', () => {
  const t = translateToBcpActionPrincipal('iu', view({ limitation: 'read_only' }));
  assert.equal(t.planReadOnly, true); assert.equal(decide(t), 'deny');
});
test('status overdue → planOverdue → DENY', () => {
  const t = translateToBcpActionPrincipal('iu', view({ statusValues: ['active', 'overdue', 'active'] }));
  assert.equal(t.planOverdue, true); assert.equal(decide(t), 'deny');
});

// ---------- parity derivation (never manufactured) ----------
test('canonical deny (no_membership) → parity unresolved → NOT allow', () => {
  const t = translateToBcpActionPrincipal('iu', view({ decision: 'deny', reasonCode: 'denied_no_membership' }));
  assert.equal(t.principal.parityState, 'unresolved'); assert.notEqual(decide(t), 'allow');
});
test('canonical deny (account_suspended) → parity blocked → NOT allow', () => {
  const t = translateToBcpActionPrincipal('iu', view({ decision: 'deny', reasonCode: 'denied_account_suspended' }));
  assert.equal(t.principal.parityState, 'blocked'); assert.notEqual(decide(t), 'allow');
});

// ---------- scope mapping ----------
test('unknown scopeType → principal.scopeType none', () => {
  assert.equal(translateToBcpActionPrincipal('iu', view({ scopeType: 'weird' })).principal.scopeType, 'none');
});
test('principal carries NO token/claims/email fields', () => {
  const t = translateToBcpActionPrincipal('iu', view());
  const keys = Object.keys(t.principal);
  for (const forbidden of ['token', 'idToken', 'claims', 'email', 'firebaseUid']) assert.ok(!keys.includes(forbidden));
});

// ---------- orchestration outcomes (injected deps) ----------
const okVerify = async () => ({ ok: true, firebaseUid: 'fb_1' });
const failVerify = (code: string) => async () => ({ ok: false, code });
const okLookup = (iu: string) => async () => ({ ok: true, internalUserId: iu });
const failLookup = (reason: string) => async () => ({ ok: false, reason });
const okAuthz = (v: CanonicalAuthzView) => async () => v;
const nullAuthz = async () => null;
const throwAuthz = async () => { throw new Error('db down'); };

test('missing credential → auth_failed / authentication_required', async () => {
  const r = await resolveLiveBcpActionPrincipal(undefined, { verifyBearer: failVerify('authentication_required') as any, lookupInternalUserId: okLookup('iu') as any, resolveCanonicalAuthz: okAuthz(view()) as any });
  assert.equal(r.outcome, 'auth_failed'); assert.equal(r.authCode, 'authentication_required');
});
test('invalid credential → auth_failed / authentication_invalid', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: failVerify('authentication_invalid') as any, lookupInternalUserId: okLookup('iu') as any, resolveCanonicalAuthz: okAuthz(view()) as any });
  assert.equal(r.outcome, 'auth_failed'); assert.equal(r.authCode, 'authentication_invalid');
});
test('verified but unmapped identity → unmapped', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: okVerify as any, lookupInternalUserId: failLookup('not_found') as any, resolveCanonicalAuthz: okAuthz(view()) as any });
  assert.equal(r.outcome, 'unmapped');
});
test('lookup db_error → resolver_error (fail-closed 5xx)', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: okVerify as any, lookupInternalUserId: failLookup('db_error') as any, resolveCanonicalAuthz: okAuthz(view()) as any });
  assert.equal(r.outcome, 'resolver_error');
});
test('authz returns null → resolver_error', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: okVerify as any, lookupInternalUserId: okLookup('iu') as any, resolveCanonicalAuthz: nullAuthz as any });
  assert.equal(r.outcome, 'resolver_error');
});
test('authz throws → resolver_error', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: okVerify as any, lookupInternalUserId: okLookup('iu') as any, resolveCanonicalAuthz: throwAuthz as any });
  assert.equal(r.outcome, 'resolver_error');
});
test('eligible chain → authenticated + system_owner principal', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: okVerify as any, lookupInternalUserId: okLookup('iu_owner') as any, resolveCanonicalAuthz: okAuthz(view()) as any });
  assert.equal(r.outcome, 'authenticated');
  assert.equal(r.principal?.visibilityClass, 'system_owner');
  assert.equal(r.internalUserId, 'iu_owner');
});
test('insufficient chain → authenticated + non-system_owner principal (guard denies later)', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: okVerify as any, lookupInternalUserId: okLookup('iu') as any, resolveCanonicalAuthz: okAuthz(view({ platformRoleId: 'support_admin' })) as any });
  assert.equal(r.outcome, 'authenticated');
  assert.notEqual(r.principal?.visibilityClass, 'system_owner');
});
test('verifyBearer that THROWS → auth_failed / authentication_unavailable (caught)', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: (async () => { throw new Error('boom'); }) as any, lookupInternalUserId: okLookup('iu') as any, resolveCanonicalAuthz: okAuthz(view()) as any });
  assert.equal(r.outcome, 'auth_failed'); assert.equal(r.authCode, 'authentication_unavailable');
});
test('lookupInternalUserId that THROWS → resolver_error (caught)', async () => {
  const r = await resolveLiveBcpActionPrincipal('Bearer x', { verifyBearer: okVerify as any, lookupInternalUserId: (async () => { throw new Error('boom'); }) as any, resolveCanonicalAuthz: okAuthz(view()) as any });
  assert.equal(r.outcome, 'resolver_error');
});

(async () => {
  let p = 0; const f: string[] = [];
  for (const c of cases) { try { await c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } }
  console.log(`\n[P3.0 M3 bcpActionLivePrincipalResolver] ${p}/${cases.length} passed`);
  if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); }
  console.log('ALL_TESTS_PASSED'); process.exit(0);
})();
