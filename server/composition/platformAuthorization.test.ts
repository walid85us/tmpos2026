// Phase 4.0 M5-GIAM-D1-P1 — the canonical platform route authorizer (platformAuthorization.ts), over a
// synthetic principal resolver: no database. The answer is `false` or a frozen `{ granted: true, context }`
// whose context is exactly the TrustedScope selectScope derives from what the RESOLVER said — never from
// anything the request, the principal object or the route view carries.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlatformRouteAuthorizer } from './platformAuthorization.js';
import { selectScope } from '../runtime/principals.js';
import type { PrincipalResolutionPort, TrustedMembership, TrustedPrincipal } from '../runtime/principals.js';
import type { AuthorizationRequirement, VerifiedPrincipal } from '../runtime/routes.js';
import type { RouteView } from '../runtime/access.js';
import type { PlatformRoleDefinition } from '../platform-identity/m5CanonicalPermissions.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const STORE = '44444444-4444-4444-8444-444444444444';
const VERSION = 'b'.repeat(64);
const PRINCIPAL: VerifiedPrincipal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-operator' });
const ROUTE: RouteView = Object.freeze({ method: 'PATCH', path: '/admin/v1/tenants/display-name', audience: 'admin' });
const EDIT: AuthorizationRequirement = Object.freeze({ scope: 'platform', permission: 'edit_tenant_profile' });
const SIGNAL = new AbortController().signal;

let nextId = 0;
const grant = (over: Partial<TrustedMembership> = {}): TrustedMembership => Object.freeze({
  membershipId: `55555555-5555-4555-8555-${String(++nextId).padStart(12, '0')}`,
  scopeType: 'platform', tenant: null, store: null, roleId: 'system_owner', tenantStatus: null, storeStatus: null, ...over,
});
const principalWith = (memberships: readonly TrustedMembership[], over: Partial<TrustedPrincipal> = {}): TrustedPrincipal =>
  Object.freeze({ actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: VERSION, memberships: Object.freeze(memberships), ...over });
const platformRole = (roleId: string, over: Partial<TrustedPrincipal> = {}): TrustedPrincipal => principalWith([grant({ roleId })], over);

/** A synthetic resolver answering `answer` and recording every call's arguments. */
function resolver(answer: unknown | (() => unknown)): PrincipalResolutionPort & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    resolve: (...args: unknown[]) => { calls.push(args); return typeof answer === 'function' ? (answer as () => unknown)() : answer; },
    probe: () => true,
  };
}
const resolved = (p: TrustedPrincipal) => Object.freeze({ outcome: 'resolved', principal: p });

async function decide(p: TrustedPrincipal, requirement: AuthorizationRequirement = EDIT, roles?: ReadonlyMap<string, PlatformRoleDefinition>): Promise<unknown> {
  return createPlatformRouteAuthorizer({ principals: resolver(resolved(p)), ...(roles === undefined ? {} : { roles }) })
    .authorize(PRINCIPAL, requirement, ROUTE, SIGNAL);
}

/** The exact grant: frozen, two keys, and a context equal to what selectScope derives from the resolved principal. */
function assertGranted(answer: unknown, p: TrustedPrincipal, label: string): void {
  const expected = selectScope(p, 'platform', { tenant: null, store: null });
  assert.equal(expected.outcome, 'selected', label);
  assert.deepEqual(answer, { granted: true, context: expected.outcome === 'selected' ? expected.scope : null }, label);
  assert.ok(Object.isFrozen(answer), `${label}: the answer is frozen`);
}

const custom = (level: unknown): ReadonlyMap<string, PlatformRoleDefinition> =>
  new Map([['custom_tenant_editor', { levels: { tenant_management: level }, moneyGrants: {} } as unknown as PlatformRoleDefinition]]);

test('built-in roles on edit_tenant_profile: Edit or above on tenant_management is granted with the resolved actor\'s scope; View is denied', async () => {
  for (const roleId of ['system_owner', 'operations_admin', 'support_admin']) {
    const p = platformRole(roleId);
    const answer = await decide(p);
    assertGranted(answer, p, roleId);
    assert.deepEqual((answer as { context: unknown }).context, {
      actor: ACTOR, securityVersion: VERSION, scope: 'platform', tenant: null, store: null, roleId, limitation: 'none',
    }, `${roleId}: the context is the resolved actor at platform scope`);
  }
  for (const roleId of ['billing_admin', 'security_admin']) assert.equal(await decide(platformRole(roleId)), false, `${roleId}: insufficient level`);
});

test('System Owner is decided through the same evaluator: a View definition under its id is denied — no name shortcut', async () => {
  const viewOwner = new Map([['system_owner', { levels: { tenant_management: 'view' }, moneyGrants: {} } as PlatformRoleDefinition]]);
  assert.equal(await decide(platformRole('system_owner'), EDIT, viewOwner), false);
  const fullOwner = new Map([['system_owner', { levels: { tenant_management: 'full' }, moneyGrants: {} } as PlatformRoleDefinition]]);
  assertGranted(await decide(platformRole('system_owner'), EDIT, fullOwner), platformRole('system_owner'), 'system_owner by its definition');
});

test('a custom platform role is decided by its definition: Edit granted, View denied, unknown id and malformed levels denied', async () => {
  const p = platformRole('custom_tenant_editor');
  assertGranted(await decide(p, EDIT, custom('edit')), p, 'custom role at Edit');
  assert.equal(await decide(p, EDIT, custom('view')), false, 'custom role at View');
  assert.equal(await decide(platformRole('custom_unknown_role'), EDIT, custom('edit')), false, 'a role id no definition names');
  assert.equal(await decide(p), false, 'a custom role under the built-in definitions only (a deployment\'s)');
  for (const level of ['EDIT', 5, 'superuser']) assert.equal(await decide(p, EDIT, custom(level)), false, `malformed level ${String(level)}`);
});

test('a store or tenant role cannot authorize the platform command, and a tenant-scope requirement is refused without asking the resolver', async () => {
  const tenantOnly = principalWith([
    grant({ scopeType: 'tenant', tenant: TENANT, roleId: 'store_owner', tenantStatus: 'active' }),
    grant({ scopeType: 'store', tenant: TENANT, store: STORE, roleId: 'manager', tenantStatus: 'active', storeStatus: 'active' }),
  ]);
  assert.equal(await decide(tenantOnly), false, 'no platform grant at all');
  const port = resolver(resolved(platformRole('system_owner')));
  const authorizer = createPlatformRouteAuthorizer({ principals: port });
  for (const scope of ['tenant', 'store'] as const) {
    assert.equal(await authorizer.authorize(PRINCIPAL, { scope, permission: 'edit_tenant_profile' }, ROUTE, SIGNAL), false, scope);
  }
  assert.equal(port.calls.length, 0, 'the resolver is never asked for a non-platform requirement');
});

test('a read-only actor holds no write permission — System Owner included', async () => {
  for (const roleId of ['system_owner', 'operations_admin', 'support_admin']) {
    assert.equal(await decide(platformRole(roleId, { limitation: 'read_only' })), false, roleId);
  }
  // Control: the same actor, not limited, is granted.
  assertGranted(await decide(platformRole('system_owner')), platformRole('system_owner'), 'unlimited control');
});

test('two active platform grants are ambiguous, and none is no grant: both are denied', async () => {
  assert.equal(await decide(principalWith([grant({ roleId: 'system_owner' }), grant({ roleId: 'support_admin' })])), false, 'ambiguous');
  assert.equal(await decide(principalWith([])), false, 'no membership');
});

test('a refused resolution denies; an unavailable, malformed, throwing or non-object answer is an outage (a rejection), never a grant', async () => {
  assert.equal(await createPlatformRouteAuthorizer({ principals: resolver({ outcome: 'refused' }) }).authorize(PRINCIPAL, EDIT, ROUTE, SIGNAL), false);
  const outages: Array<[string, unknown]> = [
    ['unavailable', { outcome: 'unavailable' }],
    ['a malformed principal', { outcome: 'resolved', principal: { ...platformRole('system_owner'), actor: 'not-a-uuid' } }],
    ['a resolved answer with no principal', { outcome: 'resolved' }],
    ['an unknown outcome', { outcome: 'granted', principal: platformRole('system_owner') }],
    ['null', null], ['a string', 'resolved'], ['true', true], ['undefined', undefined],
  ];
  for (const [label, answer] of outages) {
    await assert.rejects(Promise.resolve().then(() => createPlatformRouteAuthorizer({ principals: resolver(answer) }).authorize(PRINCIPAL, EDIT, ROUTE, SIGNAL)), label);
  }
  await assert.rejects(Promise.resolve().then(() => createPlatformRouteAuthorizer({ principals: resolver(() => { throw new Error('db down'); }) })
    .authorize(PRINCIPAL, EDIT, ROUTE, SIGNAL)), /db down/, 'a throwing resolver');
  await assert.rejects(createPlatformRouteAuthorizer({ principals: resolver(() => Promise.reject(new Error('timeout'))) })
    .authorize(PRINCIPAL, EDIT, ROUTE, SIGNAL) as Promise<unknown>, 'a rejecting resolver');
});

test('each field of the resolution is read once: a getter cannot answer the check one way and the use another', async () => {
  const reads: Record<string, number> = {};
  const good = platformRole('system_owner');
  const bad = platformRole('billing_admin');
  let principalReads = 0;
  const answer = new Proxy({ outcome: 'resolved', principal: good } as Record<string, unknown>, {
    get(t, k, r) {
      reads[String(k)] = (reads[String(k)] ?? 0) + 1;
      // A second read of `principal` would swap in another actor's grants.
      if (k === 'principal') { principalReads += 1; return principalReads === 1 ? good : bad; }
      return Reflect.get(t, k, r);
    },
  });
  const decision = await createPlatformRouteAuthorizer({ principals: resolver(answer) }).authorize(PRINCIPAL, EDIT, ROUTE, SIGNAL);
  assertGranted(decision, good, 'decided on the principal it read');
  assert.equal(reads.outcome, 1);
  assert.equal(reads.principal, 1);
});

test('unknown or malformed permission vocabulary denies, for every role', async () => {
  for (const permission of ['tenants:edit', 'tenant_management', 'Edit_Tenant_Profile', '', 'edit_tenant', 'tenants']) {
    assert.equal(await decide(platformRole('system_owner'), { scope: 'platform', permission }), false, permission);
  }
});

test('request-supplied identity is ignored: the resolver sees only the principal and the signal, and its answer alone decides', async () => {
  const claiming = Object.freeze({ ...PRINCIPAL, role: 'system_owner', internalUserId: '99999999-9999-4999-8999-999999999999', permissions: ['*'] }) as unknown as VerifiedPrincipal;
  const loudRoute = Object.freeze({ ...ROUTE, role: 'system_owner', tenant: TENANT, actor: ACTOR }) as unknown as RouteView;
  const port = resolver(resolved(platformRole('billing_admin')));
  const authorizer = createPlatformRouteAuthorizer({ principals: port });
  assert.equal(await authorizer.authorize(claiming, EDIT, loudRoute, SIGNAL), false, 'a principal claiming System Owner that resolves to billing_admin is denied');
  assert.equal(port.calls.length, 1);
  assert.equal(port.calls[0].length, 2, 'the resolver is handed exactly two arguments');
  assert.equal(port.calls[0][0], claiming, 'the principal, unchanged');
  assert.equal(port.calls[0][1], SIGNAL, 'and the deadline signal');
  // The grant carries the RESOLVED actor, never an id the principal object claimed.
  const granted = await createPlatformRouteAuthorizer({ principals: resolver(resolved(platformRole('support_admin'))) }).authorize(claiming, EDIT, loudRoute, SIGNAL);
  assert.equal((granted as { context: { actor: string } }).context.actor, ACTOR);
  assert.equal((granted as { context: { roleId: string } }).context.roleId, 'support_admin');
});

test('the authorizer refuses to be built without a resolver or with roles that are not a Map', () => {
  for (const deps of [undefined, {}, { principals: null }, { principals: {} }, { principals: { resolve: 'x' } }]) {
    assert.throws(() => createPlatformRouteAuthorizer(deps as never), TypeError, JSON.stringify(deps));
  }
  const principals = resolver({ outcome: 'refused' });
  for (const roles of [{}, [], { system_owner: { levels: {}, moneyGrants: {} } }, 'roles']) {
    assert.throws(() => createPlatformRouteAuthorizer({ principals, roles: roles as never }), TypeError, JSON.stringify(roles));
  }
});
