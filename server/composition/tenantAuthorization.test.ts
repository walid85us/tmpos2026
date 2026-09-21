// Phase 4.0 M5-GIAM-D1-P2-R1 — the tenant boundary's two decisions, over a stub admission port.
//
// DATABASE-FREE. The PostgreSQL adapter this composes over is proved against a real cluster
// (tests/db/tenantAdmission.integration.test.mjs); what is decided HERE is what the composition does
// with the adapter's answer, which the deterministic gate must hold on every run:
//   * an admission that says 'refused' denies, and one that cannot answer is an OUTAGE — because the
//     boundary turns a denial into "revoke every session this principal holds" and an outage into a
//     bounded 503 that revokes nothing;
//   * a wrong audience is a wiring fault, not a request, so it throws;
//   * the selector is the ACTOR's grants, never the request's;
//   * the lifecycle decision, the canonical permission and the read-only narrowing each deny alone;
//   * every denial is the same value, so none of them is a probe.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTenantRouteAuthorizer, createTenantSessionAdmission, readKey } from './tenantAuthorization.js';
import type { TenantAdmissionPort, TenantAdmissionResult, TrustedMembership } from '../runtime/principals.js';
import type { AuthorizationRequirement, VerifiedPrincipal } from '../runtime/routes.js';
import type { RouteView } from '../runtime/access.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const STORE = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const WITNESS = 't1:0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const PRINCIPAL: VerifiedPrincipal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-alpha' });

/** A canonical tenant-plane key (m5CanonicalPermissions.ts) and one the catalog does not define. */
const CANONICAL = 'view_shipping_costs';
const INVENTED = 'view_shipping_costs ';

const ROUTE: RouteView = Object.freeze({ method: 'GET', path: '/api/v1/probe', audience: 'tenant' });
const TENANT_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: CANONICAL });
const STORE_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: CANONICAL });

const grant = (over: Partial<TrustedMembership> = {}): TrustedMembership => Object.freeze({
  membershipId: MEMBERSHIP, scopeType: 'tenant', tenant: TENANT, store: null, roleId: 'store_owner',
  tenantStatus: 'active', storeStatus: null, ...over,
});

const admitted = (memberships: readonly TrustedMembership[], limitation = 'none'): TenantAdmissionResult => Object.freeze({
  outcome: 'admitted',
  principal: Object.freeze({ actor: ACTOR, accountStatus: 'active', limitation, securityVersion: 'sv1', memberships: Object.freeze([...memberships]) }),
  securityVersion: WITNESS,
}) as TenantAdmissionResult;

/** A port answering exactly `answer` (or throwing `fault`), counting what it was asked. */
function stub(answer: unknown, fault?: Error): TenantAdmissionPort & { calls: number } {
  const port = {
    calls: 0,
    async admit(): Promise<TenantAdmissionResult> {
      port.calls += 1;
      if (fault) throw fault;
      return answer as TenantAdmissionResult;
    },
  };
  return port as unknown as TenantAdmissionPort & { calls: number };
}

const live = (): AbortSignal => new AbortController().signal;
/**
 * Both ports declare their methods as answering `unknown` — a port never promises a shape — so each
 * call is adapted once, here, rather than cast at every assertion.
 */
const answered = (value: unknown): Promise<unknown> => Promise.resolve(value);
const authorize = (port: TenantAdmissionPort, requirement = TENANT_REQUIREMENT, reads?: ReadonlySet<string>): Promise<unknown> =>
  answered(createTenantRouteAuthorizer({ admission: port, ...(reads === undefined ? {} : { reads }) }).authorize(PRINCIPAL, requirement, ROUTE, live(), null));

// --- admission ----------------------------------------------------------------------------------

test('the boundary admits at the witness the database derived, and a refusal is a plain false', async () => {
  const port = stub(admitted([grant()]));
  const admission = createTenantSessionAdmission({ admission: port });
  assert.deepEqual(await admission.admit(PRINCIPAL, 'tenant', live()), { admitted: true, securityVersion: WITNESS });
  assert.equal(port.calls, 1, 'one read per admission: the boundary asks on every protected request');
  assert.equal(await createTenantSessionAdmission({ admission: stub({ outcome: 'refused' }) }).admit(PRINCIPAL, 'tenant', live()), false);
});

test('an answer this file does not recognise is an outage, never a denial — a denial would revoke every session held', async () => {
  const shapes: [string, unknown][] = [
    ['unavailable', { outcome: 'unavailable' }],
    ['no outcome at all', { principal: 'admitted' }],
    ['a word neither refused nor admitted', { outcome: 'pending' }],
    ['admitted with no witness', { ...admitted([grant()]), securityVersion: '' }],
    // A witness the BOUNDARY could not carry (sessions.ts VERSION_RE). Admitting it would be worse
    // than useless: the boundary maps an unusable version to a DENIAL, which revokes every session
    // that principal holds — a silent, continuous mass logout instead of a visible outage.
    ['a witness longer than the boundary accepts', { ...admitted([grant()]), securityVersion: 'x'.repeat(129) }],
    ['a witness carrying a space', { ...admitted([grant()]), securityVersion: 't1 witness' }],
    ['a witness carrying a newline', { ...admitted([grant()]), securityVersion: 't1:a\nb' }],
    ['admitted with a non-string witness', { ...admitted([grant()]), securityVersion: 7 }],
    ['admitted with a principal that is not one', { outcome: 'admitted', principal: { actor: ACTOR }, securityVersion: WITNESS }],
    ['not an object', 'admitted'],
    ['null', null],
  ];
  for (const [label, answer] of shapes) {
    const admission = createTenantSessionAdmission({ admission: stub(answer) });
    await assert.rejects(answered(admission.admit(PRINCIPAL, 'tenant', live())), /tenant admission unavailable/, label);
  }
  // A THROWN adapter is an outage too: the throw is passed on, never turned into an answer. The
  // production adapter answers 'unavailable' rather than throwing, and the runtime reads ANY throw
  // here as one bounded word and discards the error itself (deadline.ts outage), so a driver message
  // reaching this point still reaches no response and no log — it is kept for the operator's stack.
  const fault = new Error('connection to db.example:5432 failed');
  const thrown = createTenantSessionAdmission({ admission: stub(null, fault) });
  await assert.rejects(answered(thrown.admit(PRINCIPAL, 'tenant', live())), (err: unknown) => err === fault);
  await assert.rejects(authorize(stub(null, fault)), (err: unknown) => err === fault,
    'and the authorizer passes THAT error on too, rather than reporting a denial nobody decided');
});

test('being asked about another boundary is a wiring fault: it throws rather than denying every administrator', async () => {
  const port = stub(admitted([grant()]));
  const admission = createTenantSessionAdmission({ admission: port });
  await assert.rejects(answered(admission.admit(PRINCIPAL, 'admin', live())), /tenant admission unavailable/);
  assert.equal(port.calls, 0, 'and the database is never asked about a boundary this adapter does not answer for');
});

test('dependencies that are not an admission port are refused at construction, not at the first request', () => {
  for (const deps of [undefined, null, {}, { admission: null }, { admission: {} }, { admission: { admit: 'yes' } }]) {
    assert.throws(() => createTenantSessionAdmission(deps as never), TypeError);
    assert.throws(() => createTenantRouteAuthorizer(deps as never), TypeError);
  }
  // And a read classification that is not a set of routes: it would otherwise throw only when a
  // read-only actor first reached a route — long after startup, and only for some actors.
  const port = stub(admitted([grant()]));
  // An object whose `has` answers true for anything would otherwise classify every write as a read.
  const everything = { has: () => true, size: 0 };
  for (const reads of [[readKey('GET', '/api/v1/probe')], 'GET /api/v1/probe', {}, null, everything, new Set([1]), new Map([['GET /api/v1/probe', true]])]) {
    assert.throws(() => createTenantRouteAuthorizer({ admission: port, reads: reads as never }), TypeError, String(reads));
  }
  assert.ok(createTenantRouteAuthorizer({ admission: port, reads: new Set<string>() }), 'an empty set is the closed default, and valid');
});

test('the read classification is copied at construction, so mutating the caller\'s set later widens nothing', async () => {
  const readOnly = stub(admitted([grant({ tenantStatus: 'read_only' })]));
  const shared = new Set<string>();
  const authorizer = createTenantRouteAuthorizer({ admission: readOnly, reads: shared });
  shared.add(readKey(ROUTE.method, ROUTE.path));
  assert.equal(await answered(authorizer.authorize(PRINCIPAL, TENANT_REQUIREMENT, ROUTE, live(), null)), false,
    'a route classified after construction is still not a read for this authorizer');
});

// --- route authorization ------------------------------------------------------------------------

test('a platform requirement belongs to the other authorizer and is refused without a read', async () => {
  const port = stub(admitted([grant({ scopeType: 'platform', tenant: null, tenantStatus: null, roleId: 'system_owner' })]));
  assert.equal(await authorize(port, { scope: 'platform', permission: 'view_tenants' }), false);
  assert.equal(port.calls, 0, 'the scope is judged before anything is read');
});

test('an authorized request carries the decided scope, and the decision is re-read rather than taken from the session', async () => {
  const port = stub(admitted([grant()]));
  assert.deepEqual(await authorize(port), {
    granted: true,
    context: {
      actor: ACTOR, securityVersion: 'sv1', scope: 'tenant', tenant: TENANT, store: null,
      membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
    },
  });
  assert.equal(port.calls, 1, 'authorization asks the database itself');
});

test('the selector is the actor\'s own grants: exactly one at the route\'s scope, never none and never a choice between two', async () => {
  const second = grant({ membershipId: '66666666-6666-4666-8666-666666666666', tenant: OTHER_TENANT });
  const cases: [string, readonly TrustedMembership[], AuthorizationRequirement][] = [
    ['no grant at all', [], TENANT_REQUIREMENT],
    ['only a platform grant', [grant({ scopeType: 'platform', tenant: null, tenantStatus: null })], TENANT_REQUIREMENT],
    ['two tenant grants', [grant(), second], TENANT_REQUIREMENT],
    ['a tenant grant on a store route', [grant()], STORE_REQUIREMENT],
    ['two store grants', [grant({ scopeType: 'store', store: STORE, storeStatus: 'active' }),
      grant({ membershipId: second.membershipId, scopeType: 'store', store: '77777777-7777-4777-8777-777777777777', storeStatus: 'active' })], STORE_REQUIREMENT],
  ];
  for (const [label, memberships, requirement] of cases) {
    assert.equal(await authorize(stub(admitted(memberships)), requirement), false, label);
  }
  // One store grant under an active tenant selects, so the rule above is not vacuous.
  const single = admitted([grant({ scopeType: 'store', store: STORE, storeStatus: 'active' })]);
  assert.deepEqual(await authorize(stub(single), STORE_REQUIREMENT), {
    granted: true,
    context: {
      actor: ACTOR, securityVersion: 'sv1', scope: 'store', tenant: TENANT, store: STORE,
      membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
    },
  });
});

test('the one lifecycle decision is applied again here: a suspended tenant, a suspended store and an unrecognised status all deny', async () => {
  for (const tenantStatus of ['suspended', 'pending_activation', 'grace_period']) {
    assert.equal(await authorize(stub(admitted([grant({ tenantStatus })]))), false, `tenant ${JSON.stringify(tenantStatus)}`);
  }
  // A status that is not even a STATUS WORD is a malformed standing, not a lifecycle decision: the
  // principal fails isTrustedPrincipal and the request is an outage, which revokes nothing.
  await assert.rejects(authorize(stub(admitted([grant({ tenantStatus: '' })]))), /tenant admission unavailable/);
  const store = (storeStatus: string, tenantStatus = 'active') =>
    admitted([grant({ scopeType: 'store', store: STORE, tenantStatus, storeStatus })]);
  assert.equal(await authorize(stub(store('suspended')), STORE_REQUIREMENT), false, 'a suspended store');
  assert.equal(await authorize(stub(store('active', 'suspended')), STORE_REQUIREMENT), false, 'an active store under a suspended tenant');
});

test('a refused admission denies, and a permission the catalog does not define denies — never a weaker permission', async () => {
  assert.equal(await authorize(stub({ outcome: 'refused' })), false, 'refused');
  for (const permission of [INVENTED, 'edit_tenant_profile', 'view_shipping_cost', '', 'VIEW_SHIPPING_COSTS']) {
    assert.equal(await authorize(stub(admitted([grant()])), { scope: 'tenant', permission }), false, JSON.stringify(permission));
  }
});

test('a read-only actor reaches only a route the composition CLASSIFIED as a read, never one inferred from its method', async () => {
  const readOnlyTenant = admitted([grant({ tenantStatus: 'read_only' })]);
  const readOnlyAccount = admitted([grant()], 'read_only');
  const classified = new Set([readKey(ROUTE.method, ROUTE.path)]);
  for (const [label, answer] of [['a read-only tenant', readOnlyTenant], ['a read-only account', readOnlyAccount]] as const) {
    // With no classification at all — the closed default — the same GET is refused.
    assert.equal(await authorize(stub(answer)), false, `${label}: unclassified`);
    assert.equal(await authorize(stub(answer), TENANT_REQUIREMENT, new Set(['GET /api/v1/other'])), false, `${label}: another route classified`);
    const granted = await authorize(stub(answer), TENANT_REQUIREMENT, classified);
    assert.equal((granted as { granted: boolean }).granted, true, `${label}: classified`);
    assert.equal((granted as { context: { limitation: string } }).context.limitation, 'read_only', `${label}: and it stays narrowed`);
  }
  // An unrestricted actor needs no classification.
  assert.equal(((await authorize(stub(admitted([grant()])))) as { granted: boolean }).granted, true);
});

test('the read classification is the exact method and path the table registered', () => {
  assert.equal(readKey('GET', '/api/v1/probe'), 'GET /api/v1/probe');
  assert.notEqual(readKey('GET', '/api/v1/probe'), readKey('POST', '/api/v1/probe'));
});
