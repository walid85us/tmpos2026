// Phase 4.0 M5-GAP11-P1-R1 — the DEV protected-action wrapper (docs/phase-4/04 §3 safeguard #4).
//
// The wrapper turns a route's declared requirement into an HTTP answer. What is proved here is the
// part only the wrapper owns: the requirement is read once, when the route is defined; a requirement
// that is not one — an unknown kind, a missing or non-string field, a getter that throws, a name or
// level the catalog does not declare — is a 403 on every request, never a crash, never a 200; and the
// handler never runs on anything but an allow.
//
// The positive defect control: an unknown required level is compared, answer for answer, with the
// real lowest level `none`. If unknown were ever mapped to `none` again, the two would agree and the
// test would fail — that agreement is exactly the defect R1 closes.
//
// The route is exercised in-process with request/response doubles: no server, no network, no
// database (the identity lookup is skipped because the server configuration is absent), and the
// advisory audit envelope is captured from the log sink rather than printed.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { withProtectedAction, type RequiredPermission } from './protectedAction';
import { PLATFORM_FEATURE_KEYS, TENANT_SUB_PERMISSIONS } from './permissionCatalog';
import { PERMISSION_LEVEL_VALUES } from './authorizationConstants';

const NUL = String.fromCharCode(0);

/** The one requirement a shipped route declares (server.ts, /diagnostics/echo-decision). */
const SHIPPED: RequiredPermission = { kind: 'platform', featureKey: 'team_management', threshold: 'view' };

interface Reply { status: number; body: Record<string, unknown> }

function setEnv(t: TestContext): void {
  const saved = new Map<string, string | undefined>();
  const set = (k: string, v: string | undefined): void => {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  set('ENABLE_SUPABASE_PLATFORM_IDENTITY', 'true');
  set('PLATFORM_IDENTITY_DEV_DIAGNOSTICS', 'true');
  set('NODE_ENV', 'test');
  set('SUPABASE_URL', undefined); // no server configuration ⇒ no identity lookup, no database
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

/** Captures the advisory audit envelopes the wrapper logs, and keeps the log quiet. */
function captureLog(t: TestContext): unknown[][] {
  const lines: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args); });
  t.mock.method(console, 'error', () => {});
  return lines;
}

function replyDouble(reply: Reply): Response {
  return {
    status(code: number) { reply.status = code; return this; },
    json(body: Record<string, unknown>) { reply.body = body; return this; },
  } as unknown as Response;
}

async function call(
  required: unknown,
  devActor: Record<string, unknown> | undefined,
  handler: () => Record<string, unknown> = () => ({ handled: true }),
): Promise<Reply & { handled: number }> {
  let handled = 0;
  const route = withProtectedAction('test.action', required as RequiredPermission, () => { handled += 1; return handler(); });
  const reply: Reply = { status: 0, body: {} };
  await route({ body: devActor === undefined ? {} : { devActor } } as Request, replyDouble(reply));
  return { ...reply, handled };
}

const platformActor = (platformRoleId: string, permissions: Record<string, string> = {}) => ({
  authProviderUid: 'dev-actor', scope: { scopeType: 'platform' }, permissionSnapshot: { platformRoleId, permissions },
});
const tenantActor = (tenantRoleId: string, permissions: Record<string, string> = {}, subPermissions: Record<string, boolean> = {}) => ({
  authProviderUid: 'dev-actor', scope: { scopeType: 'store', tenantId: 't-1', storeId: 's-1' },
  permissionSnapshot: { tenantRoleId, permissions, subPermissions },
});

// =============================================================================
// The shipped requirement keeps its answers
// =============================================================================

test('the shipped route requirement allows and denies exactly as before', async (t) => {
  setEnv(t);
  captureLog(t);
  const allow = await call(SHIPPED, platformActor('support_admin', { team_management: 'view' }));
  assert.equal(allow.status, 200);
  assert.equal(allow.body.decision, 'allow');
  assert.equal(allow.handled, 1);

  const owner = await call(SHIPPED, platformActor('system_owner'));
  assert.equal(owner.status, 200);
  assert.equal(owner.body.decision, 'allow');

  const deny = await call(SHIPPED, platformActor('support_admin', { team_management: 'none' }));
  assert.equal(deny.status, 403);
  assert.equal(deny.body.reasonCode, 'denied_missing_permission');
  assert.equal(deny.handled, 0, 'the handler never runs on a denial');

  const anonymous = await call(SHIPPED, undefined);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.reasonCode, 'denied_unauthenticated');

  const wrongScope = await call(SHIPPED, tenantActor('store_owner'));
  assert.equal(wrongScope.status, 403);
  assert.equal(wrongScope.body.reasonCode, 'denied_scope_mismatch');

  // A handler that throws after an allow is the existing bounded 500, unchanged.
  const thrown = await call(SHIPPED, platformActor('system_owner'), () => { throw new Error('handler'); });
  assert.equal(thrown.status, 500);
});

test('every canonical level on every feature gives the answer its level earns', async (t) => {
  setEnv(t);
  captureLog(t);
  // Held `approve` on the platform ordering (none < view < create < edit < approve < manage < full)
  // clears none..approve and not manage/full — written out, not computed by the code under test.
  const cleared = new Set(['none', 'view', 'create', 'edit', 'approve']);
  for (const featureKey of PLATFORM_FEATURE_KEYS) {
    for (const threshold of PERMISSION_LEVEL_VALUES) {
      const r = await call({ kind: 'platform', featureKey, threshold }, platformActor('support_admin', { [featureKey]: 'approve' }));
      assert.equal(r.status, cleared.has(threshold) ? 200 : 403, `${featureKey}:${threshold}`);
    }
  }
});

// =============================================================================
// Deny-by-default on the requirement itself
// =============================================================================

test('control: an unknown required level is refused where the real `none` is allowed — never mapped to it', async (t) => {
  setEnv(t);
  captureLog(t);
  const holder = platformActor('support_admin', {}); // holds nothing, so clears only `none`
  const none = await call({ kind: 'platform', featureKey: 'team_management', threshold: 'none' }, holder);
  assert.equal(none.status, 200, 'control: `none` is cleared by a holder of nothing');
  for (const threshold of ['bogus', 'FULL', 'None', ' none', 'none ', '', `none${NUL}`, 'constructor', '__proto__']) {
    const r = await call({ kind: 'platform', featureKey: 'team_management', threshold }, holder);
    assert.notEqual(r.status, none.status, `unknown ${JSON.stringify(threshold)} must not behave like none`);
    assert.equal(r.status, 403);
    assert.equal(r.body.reasonCode, 'denied_invalid_requirement');
    assert.equal(r.handled, 0);
  }
});

test('an unknown kind, feature, domain, sub-permission or level is a 403 — even for an owner', async (t) => {
  setEnv(t);
  const log = captureLog(t);
  const cases: readonly (readonly [string, unknown, Record<string, unknown>])[] = [
    ['unknown kind', { kind: 'global', featureKey: 'team_management', threshold: 'view' }, platformActor('system_owner')],
    ['wrong-case kind', { kind: 'Platform', featureKey: 'team_management', threshold: 'view' }, platformActor('system_owner')],
    ['unknown feature', { kind: 'platform', featureKey: 'no_such_feature', threshold: 'view' }, platformActor('system_owner')],
    ['inherited feature name', { kind: 'platform', featureKey: 'constructor', threshold: 'view' }, platformActor('system_owner')],
    ['unknown platform level', { kind: 'platform', featureKey: 'team_management', threshold: 'admin' }, platformActor('system_owner')],
    ['unknown domain', { kind: 'tenant', domain: 'no_such_domain', level: 'view' }, tenantActor('store_owner')],
    ['unknown tenant level', { kind: 'tenant', domain: 'refunds', level: 'Approve' }, tenantActor('store_owner')],
    ['unknown sub-permission', { kind: 'sub', subPermissionId: 'approve_everything',
      subDef: { parentDomain: 'refunds', minModuleLevel: 'view', defaultLevel: 'approve', planAvailable: true } }, tenantActor('store_owner')],
    ['sub definition that disagrees with the catalog', { kind: 'sub', subPermissionId: 'approve_refunds',
      subDef: { parentDomain: 'refunds', minModuleLevel: 'none', defaultLevel: 'none', planAvailable: true } }, tenantActor('manager', { refunds: 'view' })],
  ];
  for (const [why, required, actor] of cases) {
    const r = await call(required, actor);
    assert.equal(r.status, 403, why);
    assert.equal(r.body.decision, 'deny', why);
    assert.equal(r.body.reasonCode, 'denied_invalid_requirement', why);
    assert.equal(r.handled, 0, why);
    // The refusal carries a stable code and nothing else: no reason text, no echo of the requirement.
    assert.deepEqual(Object.keys(r.body).sort(), ['actionId', 'decision', 'reasonCode', 'requestId'], why);
  }
  // Control for the tenant kind, so the refusals above are the vocabulary, not the kind.
  assert.equal((await call({ kind: 'tenant', domain: 'refunds', level: 'full' }, tenantActor('store_owner'))).status, 200);
  // M5-GAP11-P5: Refunds at Approve is the retired level form of refund approval — refused, owner included.
  const levelForm = await call({ kind: 'tenant', domain: 'refunds', level: 'approve' }, tenantActor('store_owner'));
  assert.equal(levelForm.status, 403);
  assert.equal(levelForm.body.reasonCode, 'denied_money_level_form');
  // Each refusal is audited with the decision's own reason code.
  const codes = log.map((l) => l[1]).filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => e.reasonCode);
  assert.equal(codes.filter((c) => c === 'denied_invalid_requirement').length, cases.length);
});

test('a requirement that is not one — null, a non-object, a missing or non-string field, a trap — is a 403, never a crash', async (t) => {
  setEnv(t);
  const log = captureLog(t);
  const cases: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'platform:team_management:view'],
    ['a number', 7],
    ['an array', ['platform', 'team_management', 'view']],
    ['an array carrying the named fields', Object.assign([], { kind: 'platform', featureKey: 'team_management', threshold: 'view' })],
    ['no kind', { featureKey: 'team_management', threshold: 'view' }],
    ['a missing threshold', { kind: 'platform', featureKey: 'team_management' }],
    ['a non-string threshold', { kind: 'platform', featureKey: 'team_management', threshold: 1 }],
    ['a symbol threshold', { kind: 'platform', featureKey: 'team_management', threshold: Symbol('view') }],
    ['a non-string feature', { kind: 'platform', featureKey: ['team_management'], threshold: 'view' }],
    ['a sub without a definition', { kind: 'sub', subPermissionId: 'approve_refunds' }],
    ['a sub whose plan flag is a string', { kind: 'sub', subPermissionId: 'approve_refunds',
      subDef: { parentDomain: 'refunds', minModuleLevel: 'view', defaultLevel: 'approve', planAvailable: 'true' } }],
    ['a getter that throws', Object.defineProperty({ featureKey: 'team_management', threshold: 'view' }, 'kind', { get() { throw new Error('trap'); } })],
    ['a revoked proxy', (() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })()],
  ];
  for (const [why, required] of cases) {
    const r = await call(required, platformActor('system_owner'));
    assert.equal(r.status, 403, why);
    assert.equal(r.body.reasonCode, 'denied_invalid_requirement', why);
    assert.equal(r.handled, 0, why);
  }
  // Every refusal is still audited, and the audit names the requirement only as invalid.
  const envelopes = log.map((l) => l[1]).filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null);
  assert.ok(envelopes.length >= cases.length, 'every refusal is audited');
  for (const e of envelopes.slice(-cases.length)) assert.equal(e.requiredPermission, 'invalid_requirement');
});

test('the requirement is read once, when the route is defined — a getter cannot change it later', async (t) => {
  setEnv(t);
  captureLog(t);
  let reads = 0;
  const shifting = { kind: 'platform', featureKey: 'team_management', get threshold() { reads += 1; return reads === 1 ? 'full' : 'none'; } };
  const actor = platformActor('support_admin', { team_management: 'view' });
  let handled = 0;
  const route = withProtectedAction('test.shifting', shifting as never, () => { handled += 1; return {}; });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const reply: Reply = { status: 0, body: {} };
    await route({ body: { devActor: actor } } as Request, replyDouble(reply));
    statuses.push(reply.status);
  }
  assert.equal(reads, 1, 'read at definition, never per request');
  assert.deepEqual(statuses, [403, 403, 403], '`full` as read once: a `view` holder is refused every time');
  assert.equal(handled, 0);
});

// =============================================================================
// The decision's inputs, through the wrapper
// =============================================================================

test('an unknown role and a malformed held level deny through the wrapper; canonical inputs still decide', async (t) => {
  setEnv(t);
  captureLog(t);
  const sub = TENANT_SUB_PERMISSIONS.find((s) => s.id === 'approve_refunds')!;
  const subReq = { kind: 'sub', subPermissionId: sub.id,
    subDef: { parentDomain: sub.parentDomain, minModuleLevel: sub.minModuleLevel, defaultLevel: sub.defaultLevel, planAvailable: true } };
  // Controls, then the same shape made malformed.
  assert.equal((await call(subReq, tenantActor('manager', { refunds: 'approve' }, { approve_refunds: true }))).status, 200);
  assert.equal((await call(subReq, tenantActor('manager', { refunds: 'approve' }, { approve_refunds: false }))).status, 403);
  assert.equal((await call(SHIPPED, platformActor('support_admin', { team_management: 'view' }))).status, 200);
  for (const role of ['platform_admin', 'System_Owner', 'root', 'manager']) {
    const r = await call(SHIPPED, platformActor(role, { team_management: 'full' }));
    assert.equal(r.status, 403, role);
    assert.equal(r.body.reasonCode, 'denied_unknown_role', role);
  }
  for (const held of ['FULL', 'Full', 'full ', 'admin']) {
    const r = await call(SHIPPED, platformActor('support_admin', { team_management: held }));
    assert.equal(r.status, 403, `held ${held} is not canonical and clears nothing`);
  }
  // The dev adapter hands the decision the snapshot AS ASSERTED: a revoke written as a string, a padded
  // role and a non-string level are refused, not tidied into an absent entry or a canonical id.
  // M5-GAP11-P5: a money capability has no default — no entry is no grant.
  const noGrant = await call(subReq, tenantActor('manager', { refunds: 'approve' }, {}));
  assert.equal(noGrant.status, 403, 'no explicit money grant: denied');
  assert.equal(noGrant.body.reasonCode, 'denied_missing_grant');
  const nonMoney = TENANT_SUB_PERMISSIONS.find((s) => s.id === 'process_refunds')!;
  assert.equal((await call({ kind: 'sub', subPermissionId: nonMoney.id,
    subDef: { parentDomain: nonMoney.parentDomain, minModuleLevel: nonMoney.minModuleLevel, defaultLevel: nonMoney.defaultLevel, planAvailable: true } },
  tenantActor('manager', { refunds: 'approve' }, {}))).status, 200, 'control: a non-money sub with no entry still takes its default');
  const malformedGrant = await call(subReq, tenantActor('manager', { refunds: 'approve' }, { approve_refunds: 'false' as never }));
  assert.equal(malformedGrant.status, 403);
  assert.equal(malformedGrant.body.reasonCode, 'denied_malformed_snapshot');
  const padded = await call(SHIPPED, platformActor(' system_owner '));
  assert.equal(padded.status, 403, 'a padded role is not trimmed into the owner');
  assert.equal(padded.body.reasonCode, 'denied_unknown_role');
  const nonString = await call({ kind: 'tenant', domain: 'refunds', level: 'none' }, tenantActor('manager', { refunds: null as never }));
  assert.equal(nonString.status, 403, 'a present null level is not read as none');
});
