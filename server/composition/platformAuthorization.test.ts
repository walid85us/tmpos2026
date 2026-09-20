// Phase 4.0 M5-GIAM-D1-P1 — the canonical platform route authorizer (platformAuthorization.ts), over a
// synthetic principal resolver: no database. The answer is `false` or a frozen `{ granted: true, context }`
// whose context is exactly the TrustedScope selectScope derives from what the RESOLVER said — never from
// anything the request, the principal object or the route view carries.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlatformContextRevalidator, createPlatformRouteAuthorizer } from './platformAuthorization.js';
import { selectScope } from '../runtime/principals.js';
import type { PrincipalResolutionPort, TrustedMembership, TrustedPrincipal, TrustedScope } from '../runtime/principals.js';
import type { AuthorizationRequirement, VerifiedPrincipal } from '../runtime/routes.js';
import type { RouteView } from '../runtime/access.js';
import { BUILT_IN_PLATFORM_ROLES, CANONICAL_PLATFORM_PERMISSIONS } from '../platform-identity/m5CanonicalPermissions.js';
import type { PlatformRoleDefinition } from '../platform-identity/m5CanonicalPermissions.js';
import type { PgTransactionScope } from '../persistence/supervisedPgClient.js';

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
      actor: ACTOR, securityVersion: VERSION, scope: 'platform', tenant: null, store: null,
      membershipId: p.memberships[0].membershipId, roleId, limitation: 'none',
    }, `${roleId}: the context is the resolved actor at platform scope, naming the very grant selected`);
  }
  for (const roleId of ['billing_admin', 'security_admin']) assert.equal(await decide(platformRole(roleId)), false, `${roleId}: insufficient level`);
});

test('System Owner is decided through the same evaluator: a View definition under its id is denied — no name shortcut', async () => {
  const viewOwner = new Map([['system_owner', { levels: { tenant_management: 'view' }, moneyGrants: {} } as PlatformRoleDefinition]]);
  assert.equal(await decide(platformRole('system_owner'), EDIT, viewOwner), false);
  const fullOwner = new Map([['system_owner', { levels: { tenant_management: 'full' }, moneyGrants: {} } as PlatformRoleDefinition]]);
  const owner = platformRole('system_owner');
  assertGranted(await decide(owner, EDIT, fullOwner), owner, 'system_owner by its definition');
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
  const control = platformRole('system_owner');
  assertGranted(await decide(control), control, 'unlimited control');
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

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P1-R1 — the same decision, again, inside the committing transaction
// ---------------------------------------------------------------------------

/** The committing transaction's handle: the synthetic authority check below never sends a statement on it. */
const SQL = (() => Promise.reject(new Error('no statement: the authority check is synthetic'))) as unknown as PgTransactionScope;
const scopeOf = (p: TrustedPrincipal): TrustedScope => {
  const selection = selectScope(p, 'platform', { tenant: null, store: null });
  assert.equal(selection.outcome, 'selected');
  return (selection as { scope: TrustedScope }).scope;
};
/** An authority check answering `answer`, recording what it was handed. */
function authorityCheck(answer: unknown | (() => unknown)): { check: (sql: PgTransactionScope, scope: TrustedScope) => Promise<boolean>; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { calls, check: async (...args: unknown[]) => { calls.push(args); return (typeof answer === 'function' ? (answer as () => unknown)() : answer) as boolean; } };
}

test('the transaction revalidator asks the database about exactly the scope handed out, then decides the permission on its role', async () => {
  const authority = authorityCheck(true);
  const revalidate = createPlatformContextRevalidator({ authority: authority.check });
  const scope = scopeOf(platformRole('support_admin'));
  assert.equal(await revalidate(SQL, scope, 'edit_tenant_profile', null), true);
  assert.equal(authority.calls.length, 1);
  assert.equal(authority.calls[0][0], SQL, 'on the committing transaction\'s own handle');
  assert.equal(authority.calls[0][1], scope, 'the scope itself — actor, version, the very grant and its role');
  assert.equal(authority.calls[0][2], null, 'a route that required no recent authentication claims no freshness');
  // A route that DID require one hands its deadline to the database half unchanged (M5-GIAM-D1-P2): the
  // revalidator must forward it, not drop it.
  const stepUp = authorityCheck(true);
  const withDeadline = createPlatformContextRevalidator({ authority: stepUp.check });
  assert.equal(await withDeadline(SQL, scope, 'edit_tenant_profile', 1_700_000_600_000), true);
  assert.equal(stepUp.calls[0][2], 1_700_000_600_000, 'the step-up deadline reaches the database half');
  // The database confirming the grant is not enough: the role's current definition must still carry the permission.
  for (const roleId of ['billing_admin', 'security_admin']) {
    assert.equal(await revalidate(SQL, scopeOf(platformRole(roleId)), 'edit_tenant_profile', null), false, `${roleId}: Tenants at View`);
  }
  for (const permission of ['tenants:edit', 'Edit_Tenant_Profile', '', 'edit_tenant']) {
    assert.equal(await revalidate(SQL, scope, permission, null), false, `vocabulary the catalog does not define: ${permission}`);
  }
});

test('initial authorization and transaction revalidation agree on every built-in role and every canonical platform permission', async () => {
  // Equivalent fail-closed semantics: for an unlimited actor holding one platform grant, whatever the authorizer
  // grants the revalidator grants, and whatever it denies the revalidator denies — over the same role definitions.
  const revalidate = createPlatformContextRevalidator({ authority: async () => true });
  let compared = 0;
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
    const p = platformRole(roleId);
    for (const permission of CANONICAL_PLATFORM_PERMISSIONS.keys()) {
      const initial = (await decide(p, { scope: 'platform', permission })) !== false;
      assert.equal(await revalidate(SQL, scopeOf(p), permission, null), initial, `${roleId} / ${permission}`);
      compared += 1;
    }
  }
  assert.ok(compared >= BUILT_IN_PLATFORM_ROLES.size * 10, `a real comparison (${compared} pairs)`);
});

test('a custom definition is re-decided through the same injected roles, and a changed definition is honoured at commit time', async () => {
  const p = platformRole('custom_tenant_editor');
  const at = (level: unknown) => createPlatformContextRevalidator({ authority: async () => true, roles: custom(level) });
  assert.equal(await at('edit')(SQL, scopeOf(p), 'edit_tenant_profile', null), true, 'custom role at Edit');
  assert.equal(await at('view')(SQL, scopeOf(p), 'edit_tenant_profile', null), false, 'the same grant, its definition lowered to View before the commit');
  assert.equal(await createPlatformContextRevalidator({ authority: async () => true })(SQL, scopeOf(p), 'edit_tenant_profile', null), false,
    'a role id the deployment\'s definitions do not name');
});

test('the database half decides first and alone: anything but exactly true denies, and a throw propagates to the store\'s rollback', async () => {
  const scope = scopeOf(platformRole('system_owner'));
  for (const answer of [false, 'valid', 1, null, undefined, {}]) {
    assert.equal(await createPlatformContextRevalidator({ authority: authorityCheck(answer).check })(SQL, scope, 'edit_tenant_profile', null), false, JSON.stringify(answer));
  }
  await assert.rejects(createPlatformContextRevalidator({ authority: async () => { throw new Error('db down'); } })(SQL, scope, 'edit_tenant_profile', null), /db down/);
});

test('a scope the authorizer could not have handed a command is refused before the database is asked', async () => {
  const authority = authorityCheck(true);
  const revalidate = createPlatformContextRevalidator({ authority: authority.check });
  const scope = scopeOf(platformRole('system_owner'));
  for (const refused of [
    { ...scope, limitation: 'read_only' },
    { ...scope, scope: 'tenant', tenant: TENANT, roleId: 'manager' },
    { ...scope, scope: 'store', tenant: TENANT, store: STORE, roleId: 'technician' },
  ] as TrustedScope[]) assert.equal(await revalidate(SQL, refused, 'edit_tenant_profile', null), false, JSON.stringify(refused));
  assert.equal(authority.calls.length, 0);
});

test('the revalidator refuses to be built without an authority check or with roles that are not a Map', () => {
  for (const deps of [undefined, {}, { authority: null }, { authority: 'check' }]) {
    assert.throws(() => createPlatformContextRevalidator(deps as never), TypeError, JSON.stringify(deps));
  }
  for (const roles of [{}, [], 'roles']) {
    assert.throws(() => createPlatformContextRevalidator({ authority: async () => true, roles: roles as never }), TypeError, JSON.stringify(roles));
  }
});
