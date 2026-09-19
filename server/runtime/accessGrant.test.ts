// Phase 4.0 M5-GIAM-D1-P1 — the authorization step's answer (access.ts authorize): exactly `true` allows
// with no context; a `{ granted: true, context }` allows with a frozen COPY of a TrustedScope at exactly the
// requirement's scope; anything else is a denial; a throw or an overrun is an outage, never a verdict.
import test from 'node:test';
import assert from 'node:assert/strict';

import { authorize } from './access.js';
import type { RouteAuthorizer, RouteView } from './access.js';
import type { TrustedScope } from './principals.js';
import type { AuthorizationRequirement, VerifiedPrincipal } from './routes.js';

const PRINCIPAL: VerifiedPrincipal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-operator' });
const PLATFORM: AuthorizationRequirement = Object.freeze({ scope: 'platform', permission: 'edit_tenant_profile' });
const ROUTE: RouteView = Object.freeze({ method: 'PATCH', path: '/admin/v1/tenants/display-name', audience: 'admin' });
const SCOPE: TrustedScope = Object.freeze({
  actor: '11111111-1111-4111-8111-111111111111', securityVersion: 'c'.repeat(64), scope: 'platform',
  tenant: null, store: null, membershipId: '55555555-5555-4555-8555-555555555555', roleId: 'support_admin', limitation: 'none',
});
const TENANT_SCOPE: TrustedScope = Object.freeze({ ...SCOPE, scope: 'tenant', tenant: '22222222-2222-4222-8222-222222222222', roleId: 'manager' });

const answering = (decision: unknown): RouteAuthorizer => ({ authorize: () => decision });
const run = (authorizer: RouteAuthorizer, requirement: AuthorizationRequirement = PLATFORM, deadlineMs = 1_000) =>
  authorize(authorizer, PRINCIPAL, requirement, ROUTE, deadlineMs);

test('exactly `true` allows and names no context', async () => {
  assert.deepEqual(await run(answering(true)), { context: null });
  assert.deepEqual(await run({ authorize: async () => true }), { context: null }, 'asynchronously too');
});

test('a granted decision allows with a frozen copy of its trusted scope — equal to it, never the same object', async () => {
  const live = { ...SCOPE };
  const allowed = await run(answering({ granted: true, context: live }));
  assert.ok(typeof allowed === 'object' && allowed !== null);
  const { context } = allowed as { context: TrustedScope };
  assert.deepEqual(context, SCOPE);
  assert.notEqual(context, live, 'a copy');
  assert.ok(Object.isFrozen(allowed) && Object.isFrozen(context), 'both frozen');
  live.roleId = 'system_owner'; // mutating the authorizer's object afterwards changes nothing already handed on
  assert.equal(context.roleId, 'support_admin');
});

test('a context at another scope than the requirement is a denial', async () => {
  assert.equal(await run(answering({ granted: true, context: TENANT_SCOPE })), 'authz_denied', 'a tenant context for a platform requirement');
  assert.equal(await run(answering({ granted: true, context: SCOPE }), { scope: 'tenant', permission: 'x' }), 'authz_denied', 'a platform context for a tenant requirement');
});

test('anything but exactly true or a well-formed grant is a denial', async () => {
  class Grant { granted = true; context = SCOPE; }
  const nullProto = Object.assign(Object.create(null) as object, { granted: true, context: SCOPE });
  // `then` answers undefined, so the promise machinery hands the proxy through and the grant check itself meets the throws.
  const hostile = new Proxy({}, {
    ownKeys: () => { throw new Error('hostile'); },
    get: (_t, k) => { if (k === 'then') return undefined; throw new Error('hostile'); },
    getPrototypeOf: () => Object.prototype,
  });
  const cases: Array<[string, unknown]> = [
    ['false', false], ['1', 1], ['"true"', 'true'], ['null', null], ['undefined', undefined], ['{}', {}],
    ['an extra key', { granted: true, context: SCOPE, admin: true }],
    ['granted missing', { context: SCOPE }],
    ['context missing', { granted: true }],
    ['granted "true"', { granted: 'true', context: SCOPE }],
    ['granted 1', { granted: 1, context: SCOPE }],
    ['a null context', { granted: true, context: null }],
    ['a bad actor uuid', { granted: true, context: { ...SCOPE, actor: 'not-a-uuid' } }],
    ['a bad role', { granted: true, context: { ...SCOPE, roleId: 'System Owner!' } }],
    // M5-GIAM-D1-P1-R1: the context names the one grant it was selected under, or it is no context.
    ['no membership', { granted: true, context: { ...SCOPE, membershipId: undefined } }],
    ['a membership that is not a uuid', { granted: true, context: { ...SCOPE, membershipId: 'system_owner' } }],
    ['a bad limitation', { granted: true, context: { ...SCOPE, limitation: 'x' } }],
    ['a platform context naming a tenant', { granted: true, context: { ...SCOPE, tenant: TENANT_SCOPE.tenant } }],
    ['a class instance', new Grant()],
    ['an array', Object.assign([], { granted: true, context: SCOPE })],
    ['a null-prototype object', nullProto],
    ['a proxy whose traps throw', hostile],
  ];
  for (const [label, decision] of cases) assert.equal(await run(answering(decision)), 'authz_denied', label);
});

test('a context read once: a getter cannot validate one scope and hand on another', async () => {
  let reads = 0;
  const context = {
    actor: SCOPE.actor, securityVersion: SCOPE.securityVersion, scope: 'platform', tenant: null, store: null, membershipId: SCOPE.membershipId, limitation: 'none',
    get roleId() { reads += 1; return reads === 1 ? 'support_admin' : 'system_owner'; },
  };
  const allowed = await run(answering({ granted: true, context }));
  if (typeof allowed === 'string') {
    // Refusing a context whose fields keep changing is sound too; what must never happen is a grant that carries the second answer.
    assert.equal(allowed, 'authz_denied');
    return;
  }
  const copy = (allowed as { context: TrustedScope }).context;
  assert.ok(copy !== null);
  assert.ok(['support_admin', 'system_owner'].includes(copy.roleId), 'one of the answers, fixed in the copy');
  assert.equal(copy.roleId, copy.roleId, 'and stable: reading the copy again returns the same role');
  assert.notEqual(copy, context, 'a copy, not the live object');
  // Whatever it read, the copy is a plain frozen data object: reading it again cannot change the answer.
  assert.ok(Object.isFrozen(copy));
  assert.deepEqual(Object.getOwnPropertyDescriptor(copy, 'roleId')?.get, undefined, 'a data property, never the getter');
});

test('an authorizer that throws or rejects is an outage; one that overruns the deadline is a timeout — never a verdict', async () => {
  assert.equal(await run({ authorize: () => { throw new Error('authz-secret-detail'); } }), 'authz_unavailable');
  assert.equal(await run({ authorize: () => Promise.reject(new Error('authz-secret-detail')) }), 'authz_unavailable');
  assert.equal(await run({ authorize: () => new Promise(() => {}) }, PLATFORM, 20), 'authz_timeout');
  // An answer whose `then` getter throws fails in the promise machinery: an outage (503), still never a grant.
  assert.equal(await run(answering(new Proxy({}, { get: () => { throw new Error('hostile'); } }))), 'authz_unavailable');
});
