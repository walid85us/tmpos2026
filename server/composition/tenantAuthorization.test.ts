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

import {
  createTenantContextRevalidator, createTenantEstablishCheck, createTenantRouteAuthorizer, createTenantSessionAdmission, readKey,
} from './tenantAuthorization.js';
import type { SessionRecord } from '../runtime/sessions.js';
import type { TenantAdmissionPort, TenantAdmissionResult, TrustedMembership, TrustedScope } from '../runtime/principals.js';
import type { AuthorizationRequirement, VerifiedPrincipal } from '../runtime/routes.js';
import type { RouteView } from '../runtime/access.js';
import { TENANT_ROLE_IDS } from '../platform-identity/authorizationConstants.js';
import {
  INVOICE_DRAFT_CREATE_REQUIREMENT, INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH, INVOICE_DRAFT_EDIT_REQUIREMENT, INVOICE_DRAFT_ELIGIBILITY_PATH, INVOICE_DRAFT_PATH,
  INVOICE_DRAFT_UPDATE_ROUTE, createInvoiceDraftEditEligibilityRoute, createInvoiceDraftEligibilityRoute,
} from '../runtime/invoiceDrafts.js';

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
/** M7B-INVOICES-P1: a store template's view, naming STORE as its requested target. */
const STORE_ROUTE: RouteView = Object.freeze({ method: 'GET', path: '/api/v1/stores/{storeId}/invoice-drafts', audience: 'tenant', storeTarget: STORE });
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
/** No owner edit stored: every role at its catalog default (M7A-CUSTOMERS-P3-R1). */
const NO_EDITS = async (): Promise<unknown> => ({});
/**
 * Both ports declare their methods as answering `unknown` — a port never promises a shape — so each
 * call is adapted once, here, rather than cast at every assertion.
 */
const answered = (value: unknown): Promise<unknown> => Promise.resolve(value);
const authorize = (port: TenantAdmissionPort, requirement = TENANT_REQUIREMENT, reads?: ReadonlySet<string>, route: RouteView = ROUTE): Promise<unknown> =>
  answered(createTenantRouteAuthorizer({ admission: port, levels: NO_EDITS, ...(reads === undefined ? {} : { reads }) }).authorize(PRINCIPAL, requirement, route, live(), null));

// --- admission ----------------------------------------------------------------------------------

test('the boundary admits at the witness the database derived, as the resolved actor, and a refusal is a plain false', async () => {
  const port = stub(admitted([grant()]));
  const admission = createTenantSessionAdmission({ admission: port });
  // M5-TENANT-SESSION-P1: the actor is the internal user the login's audit record names.
  assert.deepEqual(await admission.admit(PRINCIPAL, 'tenant', live()), { admitted: true, securityVersion: WITNESS, actor: ACTOR });
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
    assert.throws(() => createTenantRouteAuthorizer({ admission: port, levels: NO_EDITS, reads: reads as never }), TypeError, String(reads));
  }
  assert.ok(createTenantRouteAuthorizer({ admission: port, levels: NO_EDITS, reads: new Set<string>() }), 'an empty set is the closed default, and valid');
});

test('the read classification is copied at construction, so mutating the caller\'s set later widens nothing', async () => {
  const readOnly = stub(admitted([grant({ tenantStatus: 'read_only' })]));
  const shared = new Set<string>();
  const authorizer = createTenantRouteAuthorizer({ admission: readOnly, levels: NO_EDITS, reads: shared });
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
  // M7B-INVOICES-P1: a store requirement is judged on a store template's view, which names its store (STORE_ROUTE), so each
  // store case below denies for the property its label names; the one literal-path case is labelled as the no-target case.
  const cases: [string, readonly TrustedMembership[], AuthorizationRequirement, RouteView][] = [
    ['no grant at all', [], TENANT_REQUIREMENT, ROUTE],
    ['only a platform grant', [grant({ scopeType: 'platform', tenant: null, tenantStatus: null })], TENANT_REQUIREMENT, ROUTE],
    ['two tenant grants', [grant(), second], TENANT_REQUIREMENT, ROUTE],
    ['a tenant grant on a store route', [grant()], STORE_REQUIREMENT, STORE_ROUTE],
    ['two store grants on a literal path (no target)', [grant({ scopeType: 'store', store: STORE, storeStatus: 'active' }),
      grant({ membershipId: second.membershipId, scopeType: 'store', store: '77777777-7777-4777-8777-777777777777', storeStatus: 'active' })], STORE_REQUIREMENT, ROUTE],
  ];
  for (const [label, memberships, requirement, route] of cases) {
    assert.equal(await authorize(stub(admitted(memberships)), requirement, undefined, route), false, label);
  }
  // M7B-INVOICES-P1: a store requirement on a view naming no store (a literal path) selects NOTHING — not even the actor's
  // one store grant — whatever the key: the undecidable catalogued one and both decided store route permissions.
  const single = admitted([grant({ scopeType: 'store', store: STORE, storeStatus: 'active' })]);
  for (const permission of [CANONICAL, 'view_invoice_drafts', 'create_invoice_drafts', 'edit_invoice_drafts']) {
    assert.equal(await authorize(stub(single), { scope: 'store', permission }, undefined, ROUTE), false, `one store grant on a literal path: ${permission}`);
  }
  // The same one store grant AT the store a store template names, under an active tenant, selects, so the rules above are not vacuous.
  assert.deepEqual(await authorize(stub(single), STORE_REQUIREMENT, undefined, STORE_ROUTE), {
    granted: true,
    context: {
      actor: ACTOR, securityVersion: 'sv1', scope: 'store', tenant: TENANT, store: STORE,
      membershipId: MEMBERSHIP, roleId: 'store_owner', limitation: 'none',
    },
  });
});

test('M7B-INVOICES-P1: at store scope the path\'s store is a REQUESTED TARGET — exactly one store grant AT it selects; none, a grant elsewhere, two roles at it, a tenant grant or no target deny', async () => {
  const OTHER_STORE = '77777777-7777-4777-8777-777777777777';
  const atStore = grant({ scopeType: 'store', store: STORE, storeStatus: 'active', roleId: 'manager' });
  const elsewhere = grant({ membershipId: '66666666-6666-4666-8666-666666666666', scopeType: 'store', store: OTHER_STORE, storeStatus: 'active' });
  const secondRole = grant({ membershipId: '88888888-8888-4888-8888-888888888888', scopeType: 'store', store: STORE, storeStatus: 'active', roleId: 'technician' });
  const view = (storeTarget: unknown): RouteView => ({ ...STORE_ROUTE, storeTarget } as RouteView);
  // A multi-store operator is served at each store it holds exactly one grant at — the target narrows, it never proves.
  const two = admitted([atStore, elsewhere]);
  assert.equal(((await authorize(stub(two), STORE_REQUIREMENT, undefined, view(STORE))) as { context: { store: string; roleId: string } }).context.store, STORE);
  assert.equal(((await authorize(stub(two), STORE_REQUIREMENT, undefined, view(OTHER_STORE))) as { context: { store: string; roleId: string } }).context.store, OTHER_STORE);
  for (const [label, memberships, route] of [
    ['a store the actor holds no grant at', [elsewhere], view(STORE)],
    ['two roles at the requested store (ambiguous)', [atStore, secondRole], view(STORE)],
    ['a tenant grant only (no inheritance)', [grant()], view(STORE)],
    ['a tenant owner grant beside a grant at another store', [grant(), elsewhere], view(STORE)],
    ['a non-canonical store segment (null target)', [atStore], view(null)],
    ['a literal path (no target) with grants at two stores', [atStore, elsewhere], ROUTE],
    ['an uppercase target', [grant({ scopeType: 'store', store: 'abcdef01-2345-4678-89ab-cdef01234567', storeStatus: 'active' })], view('ABCDEF01-2345-4678-89AB-CDEF01234567')],
    ['a target that is not a string', [atStore], view(7)],
    ['a target naming the tenant', [atStore], view(TENANT)],
  ] as const) {
    assert.equal(await authorize(stub(admitted(memberships)), STORE_REQUIREMENT, undefined, route), false, label);
  }
  // A tenant-scope requirement ignores any target: exactly today's selection.
  assert.equal(((await authorize(stub(admitted([grant()])), TENANT_REQUIREMENT, undefined, view(STORE))) as { granted: boolean }).granted, true);
  assert.equal(await authorize(stub(admitted([atStore])), TENANT_REQUIREMENT, undefined, view(STORE)), false, 'a store grant never answers a tenant route');
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
  assert.equal(await authorize(stub(store('suspended')), STORE_REQUIREMENT, undefined, STORE_ROUTE), false, 'a suspended store');
  assert.equal(await authorize(stub(store('active', 'suspended')), STORE_REQUIREMENT, undefined, STORE_ROUTE), false, 'an active store under a suspended tenant');
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

// --- the role decision where the catalog makes one (M7A-CUSTOMERS-P1) -------------------------------

const CUSTOMERS_ROUTE: RouteView = Object.freeze({ method: 'GET', path: '/api/v1/customers', audience: 'tenant' });
const VIEW_CUSTOMERS: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: 'view_customers' });
const customers = (port: TenantAdmissionPort, requirement = VIEW_CUSTOMERS, reads?: ReadonlySet<string>): Promise<unknown> =>
  answered(createTenantRouteAuthorizer({ admission: port, levels: NO_EDITS, ...(reads === undefined ? {} : { reads }) }).authorize(PRINCIPAL, requirement, CUSTOMERS_ROUTE, live(), null));

test('view_customers: one tenant grant under every built-in tenant role is granted, carrying the selected scope', async () => {
  for (const roleId of TENANT_ROLE_IDS) {
    const port = stub(admitted([grant({ roleId })]));
    assert.deepEqual(await customers(port), {
      granted: true,
      context: { actor: ACTOR, securityVersion: 'sv1', scope: 'tenant', tenant: TENANT, store: null, membershipId: MEMBERSHIP, roleId, limitation: 'none' },
    }, roleId);
    assert.equal(port.calls, 1, `${roleId}: one admission read`);
  }
});

test('view_customers: the grant\'s ROLE decides — a role the catalog does not hold as a tenant role is denied where an undecidable key is not', async () => {
  // The principal guard admits any role word, so a tenant grant can carry a platform role, a retired or a misspelled id.
  for (const roleId of ['system_owner', 'support_admin', 'cashier', 'owner', 'store_owners', 'constructor']) {
    const port = stub(admitted([grant({ roleId })]));
    assert.equal(await customers(port), false, roleId);
    // Control: the SAME grant on a catalogued key the catalog cannot decide is judged on membership and lifecycle alone,
    // so the denial above is the role decision and nothing else.
    assert.equal(((await authorize(stub(admitted([grant({ roleId })])))) as { granted: boolean }).granted, true, `${roleId}: undecidable key (control)`);
  }
});

test('view_customers: a read-only actor is granted only on the classified read; a store grant, two tenant grants and a store requirement deny', async () => {
  const classified = new Set([readKey(CUSTOMERS_ROUTE.method, CUSTOMERS_ROUTE.path)]);
  for (const [label, answer] of [['a read-only tenant', admitted([grant({ tenantStatus: 'read_only' })])], ['a read-only account', admitted([grant({ roleId: 'technician' })], 'read_only')]] as const) {
    const granted = await customers(stub(answer), VIEW_CUSTOMERS, classified);
    assert.equal((granted as { granted: boolean }).granted, true, `${label}: classified`);
    assert.equal((granted as { context: { limitation: string } }).context.limitation, 'read_only', `${label}: and it stays narrowed`);
    assert.equal(await customers(stub(answer)), false, `${label}: unclassified`);
    assert.equal(await customers(stub(answer), VIEW_CUSTOMERS, new Set([readKey('GET', '/api/v1/probe')])), false, `${label}: another route classified`);
  }
  // A read-only actor whose role is not a tenant role is denied even on the classified read.
  assert.equal(await customers(stub(admitted([grant({ roleId: 'system_owner', tenantStatus: 'read_only' })])), VIEW_CUSTOMERS, classified), false);
  const storeGrant = grant({ scopeType: 'store', store: STORE, storeStatus: 'active' });
  const second = grant({ membershipId: '66666666-6666-4666-8666-666666666666', tenant: OTHER_TENANT });
  const cases: [string, readonly TrustedMembership[], AuthorizationRequirement][] = [
    ['a store-only actor', [storeGrant], VIEW_CUSTOMERS],
    ['two tenant grants', [grant(), second], VIEW_CUSTOMERS],
    ['a platform-only actor', [grant({ scopeType: 'platform', tenant: null, tenantStatus: null, roleId: 'system_owner' })], VIEW_CUSTOMERS],
    ['a suspended tenant', [grant({ tenantStatus: 'suspended' })], VIEW_CUSTOMERS],
  ];
  for (const [label, memberships, requirement] of cases) assert.equal(await customers(stub(admitted(memberships)), requirement), false, label);
  // view_customers names nothing at store scope: judged on a store template's view AT the grant's store, where the same
  // store grant selects on a store key (the control), so the denial is the catalog's and not a missing target.
  const atStore = (requirement: AuthorizationRequirement): Promise<unknown> =>
    answered(createTenantRouteAuthorizer({ admission: stub(admitted([storeGrant])), levels: NO_EDITS }).authorize(PRINCIPAL, requirement, STORE_ROUTE, live(), null));
  assert.equal(await atStore({ scope: 'store', permission: 'view_customers' }), false, 'a store requirement naming view_customers, at the grant\'s store');
  assert.equal(((await atStore(STORE_REQUIREMENT)) as { granted: boolean }).granted, true, 'the same store grant selects on a store key at its store (control)');
});

// --- the tenant login's standing check (M5-TENANT-SESSION-P1) -------------------------------------

const RECORD: SessionRecord = Object.freeze({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-alpha', principalKey: 'p'.repeat(43),
  securityVersion: WITNESS, authenticatedAt: null, createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_000_000, validatedAt: 1_700_000_000_000,
});

/** A check over a hold and a read answering as given, recording each step with the handle and reference it was handed. */
function establishCheck(held: unknown, read: unknown) {
  const steps: Array<[string, unknown, unknown]> = [];
  const check = createTenantEstablishCheck<string>({
    hold: async (sql, principal) => { steps.push(['hold', sql, principal]); if (held instanceof Error) throw held; return held as boolean; },
    read: async (sql, principal) => { steps.push(['read', sql, principal]); if (read instanceof Error) throw read; return read; },
  });
  return { check, steps };
}

test('M5T-TE1 the establish check holds the record\'s actor, THEN re-reads admission on the same handle, and admits only at the record\'s witness', async () => {
  const { check, steps } = establishCheck(true, admitted([grant()]));
  assert.equal(await check('tx', RECORD), true);
  assert.deepEqual(steps.map(([step]) => step), ['hold', 'read'], 'hold first, then the re-read');
  assert.ok(steps.every(([, sql]) => sql === 'tx'), 'both on establish\'s own handle');
  assert.ok(steps.every(([, , principal]) => JSON.stringify(principal) === JSON.stringify(PRINCIPAL)), 'the record\'s own provider reference');
  // A standing that moved since the login's admission, or no longer admits: false, nothing written.
  assert.equal(await establishCheck(true, { ...admitted([grant()]), securityVersion: 't2:other' }).check('tx', RECORD), false, 'another witness');
  assert.equal(await establishCheck(true, { outcome: 'refused' }).check('tx', RECORD), false, 'refused');
});

test('M5T-TE2 a hold that answers false (no account) is a changed standing, and the admission is never read', async () => {
  const { check, steps } = establishCheck(false, admitted([grant()]));
  assert.equal(await check('tx', RECORD), false);
  assert.deepEqual(steps.map(([step]) => step), ['hold'], 'no read after a failed hold');
});

test('M5T-TE3 a fault, a malformed answer or a record of another audience is an outage: a throw, never false', async () => {
  const fault = new Error('lock timeout');
  await assert.rejects(establishCheck(fault, admitted([grant()])).check('tx', RECORD), (err: unknown) => err === fault, 'a hold fault');
  await assert.rejects(establishCheck(true, fault).check('tx', RECORD), (err: unknown) => err === fault, 'a read fault');
  await assert.rejects(establishCheck('held', admitted([grant()])).check('tx', RECORD), /tenant admission unavailable/, 'a hold answering no boolean');
  for (const answer of [{ outcome: 'unavailable' }, { outcome: 'admitted', securityVersion: WITNESS }, null, 'admitted']) {
    await assert.rejects(establishCheck(true, answer).check('tx', RECORD), /tenant admission unavailable/, JSON.stringify(answer));
  }
  const other = establishCheck(true, admitted([grant()]));
  await assert.rejects(other.check('tx', { ...RECORD, audience: 'admin' }), /tenant admission unavailable/, 'an administrative record');
  assert.deepEqual(other.steps, [], 'refused before anything is held');
  for (const deps of [undefined, {}, { hold: async () => true }, { read: async () => null }, { hold: 'x', read: async () => null }]) {
    assert.throws(() => createTenantEstablishCheck(deps as never), TypeError);
  }
});

test('M7TA-01 the tenant admission forwards the port\'s readiness probe: true, false and a throw are the port\'s own; a port without one throws, never a verdict', async () => {
  // M7A-CUSTOMERS-P2 (F4): readiness asks the admission every protected tenant request depends on, through the port.
  const signals: AbortSignal[] = [];
  const port = (probe: (signal: AbortSignal) => unknown): TenantAdmissionPort => Object.assign(stub(admitted([grant()])), {
    probe: (signal: AbortSignal) => { signals.push(signal); return probe(signal); },
  });
  const admission = (p: TenantAdmissionPort) => createTenantSessionAdmission({ admission: p });
  const signal = live();
  assert.equal(await answered(admission(port(async () => true)).probe?.(signal)), true);
  assert.equal(await answered(admission(port(async () => false)).probe?.(signal)), false);
  await assert.rejects(answered(admission(port(async () => { throw new Error('probe outage'); })).probe?.(signal)), /probe outage/);
  assert.deepEqual(signals, [signal, signal, signal], 'the caller\'s own deadline signal, each time');
  // A stub port without a probe composes (the boundary is still built), and asking it throws: readiness reads not ready.
  const noProbe = admission(stub(admitted([grant()])));
  assert.equal(typeof noProbe.probe, 'function');
  assert.throws(() => noProbe.probe?.(signal), TypeError);
});

// --- create_customers: the route decision (M7A-CUSTOMERS-P3, ADR-34) --------------------------------------------

const CREATE_ROUTE: RouteView = Object.freeze({ method: 'POST', path: '/api/v1/customers', audience: 'tenant' });
const CREATE_CUSTOMERS: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: 'create_customers' });
/** The POST decided as the composition decides it: the GET, and only the GET, classified as a read. */
const create = (port: TenantAdmissionPort): Promise<unknown> => answered(createTenantRouteAuthorizer({
  admission: port, levels: NO_EDITS, reads: new Set([readKey('GET', '/api/v1/customers')]),
}).authorize(PRINCIPAL, CREATE_CUSTOMERS, CREATE_ROUTE, live(), null));

test('create_customers: store_owner, manager and sales_staff are granted with the selected scope; a technician, a read-only actor, a store grant beside it and two tenant grants deny', async () => {
  const granted = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (roleId) =>
    [roleId, ((await create(stub(admitted([grant({ roleId })])))) as { granted?: boolean }).granted === true])));
  assert.deepEqual(granted, { store_owner: true, manager: true, technician: false, sales_staff: true }, 'Customers at Create or above, and no other role');
  assert.deepEqual(await create(stub(admitted([grant({ roleId: 'sales_staff' })]))), {
    granted: true,
    context: { actor: ACTOR, securityVersion: 'sv1', scope: 'tenant', tenant: TENANT, store: null, membershipId: MEMBERSHIP, roleId: 'sales_staff', limitation: 'none' },
  });
  const storeManager = grant({ membershipId: '77777777-7777-4777-8777-777777777777', scopeType: 'store', store: STORE, storeStatus: 'active', roleId: 'manager' });
  for (const [label, answer] of [
    ['a read-only tenant', admitted([grant({ tenantStatus: 'read_only' })])],
    ['an overdue tenant', admitted([grant({ tenantStatus: 'overdue' })])],
    ['a read-only account', admitted([grant()], 'read_only')],
    ['a tenant technician with a store manager grant in the same tenant', admitted([grant({ roleId: 'technician' }), storeManager])],
    ['a store manager grant alone', admitted([storeManager])],
    ['two tenant grants', admitted([grant(), grant({ membershipId: '66666666-6666-4666-8666-666666666666', tenant: OTHER_TENANT })])],
    ['a suspended tenant', admitted([grant({ tenantStatus: 'suspended' })])],
  ] as const) assert.equal(await create(stub(answer)), false, label);
});

// --- the tenant command's revalidator (M7A-CUSTOMERS-P3, ADR-34 R5) ----------------------------------------------

const KEY = 'k'.repeat(43);
/** The scope the authorizer handed the create: the actor's one tenant grant as `admitted` selects it. */
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'sv1', scope: 'tenant', tenant: TENANT, store: null, membershipId: MEMBERSHIP, roleId: 'manager', limitation: 'none',
});
const SESSION: SessionRecord = Object.freeze({ ...RECORD, securityVersion: WITNESS });

/**
 * A revalidator over a peek, a hold, a session hold, a read, a levels read and a clock answering as given, recording each
 * step with its handle and argument.
 */
function revalidator(over: { peek?: unknown; hold?: unknown; session?: unknown; read?: unknown; levels?: unknown; fresh?: unknown } = {}) {
  const steps: Array<[string, unknown, unknown]> = [];
  const answer = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const revalidate = createTenantContextRevalidator<string>({
    peek: async (sql, key) => { steps.push(['peek', sql, key]); return answer('peek' in over ? over.peek : SESSION) as never; },
    hold: async (sql, principal) => { steps.push(['hold', sql, principal]); return answer('hold' in over ? over.hold : true) as never; },
    session: async (sql, key) => { steps.push(['session', sql, key]); return answer('session' in over ? over.session : SESSION) as never; },
    read: async (sql, principal) => { steps.push(['read', sql, principal]); return answer('read' in over ? over.read : admitted([grant({ roleId: 'manager' })])); },
    levels: async (sql, tenant, role) => { steps.push(['levels', sql, [tenant, role]]); return answer('levels' in over ? over.levels : {}); },
    fresh: async (sql, notAfter) => { steps.push(['fresh', sql, notAfter]); return answer('fresh' in over ? over.fresh : true) as never; },
  });
  return { revalidate, steps };
}

test('M7TR-01 the revalidator peeks, holds the standing, holds the session, THEN re-reads admission — all on the committing handle — and re-decides create_customers', async () => {
  for (const roleId of ['store_owner', 'manager', 'sales_staff']) {
    const { revalidate, steps } = revalidator({ read: admitted([grant({ roleId })]) });
    assert.equal(await revalidate('tx', { ...SCOPE, roleId }, 'create_customers', null, KEY), true, roleId);
    assert.deepEqual(steps.map(([step]) => step), ['peek', 'hold', 'session', 'read', 'levels'],
      `${roleId}: the ADR-31 order: the standing held before the session row, and the role's current definition read last`);
    assert.deepEqual(steps.find(([step]) => step === 'levels')?.[2], [TENANT, roleId], 'the confirmed grant\'s own tenant and role');
    assert.ok(steps.every(([, sql]) => sql === 'tx'), 'every step on the committing transaction\'s own handle');
    assert.deepEqual(steps.filter(([step]) => step === 'peek' || step === 'session').map(([, , key]) => key), [KEY, KEY], 'the presenting session\'s key');
    assert.ok(steps.filter(([step]) => step === 'hold' || step === 'read').every(([, , p]) => JSON.stringify(p) === JSON.stringify(PRINCIPAL)),
      'the standing of the session\'s own provider reference');
  }
});

test('M7TR-02 every lost authority is false: the scope, the session, the standing, the witness, the selection and the role', async () => {
  const current = admitted([grant({ roleId: 'manager' })]) as unknown as { principal: Record<string, unknown> };
  const movedAccount = { ...current, principal: { ...current.principal, securityVersion: 'sv2' } };
  const cases: Array<[string, Parameters<typeof revalidator>[0], TrustedScope, string, number | null, string | null, string[]]> = [
    ['a platform scope', {}, { ...SCOPE, scope: 'platform', tenant: null }, 'create_customers', null, KEY, []],
    ['a store scope', {}, { ...SCOPE, scope: 'store', store: STORE }, 'create_customers', null, KEY, []],
    ['a read-only scope', {}, { ...SCOPE, limitation: 'read_only' }, 'create_customers', null, KEY, []],
    ['a recent-authentication claim', {}, SCOPE, 'create_customers', 1_700_000_000_000, KEY, []],
    ['no session key', {}, SCOPE, 'create_customers', null, null, []],
    ['a session ended before the peek', { peek: undefined }, SCOPE, 'create_customers', null, KEY, ['peek']],
    ['no account behind the reference', { hold: false }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold']],
    ['a session ended while the standing was held', { session: undefined }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session']],
    ['a held session of another principal', { session: { ...SESSION, authProviderUid: 'uid-beta' } }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session']],
    ['a refused admission', { read: { outcome: 'refused' } }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a moved witness', { read: { ...admitted([grant({ roleId: 'manager' })]), securityVersion: 't1:moved' } }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a changed role', { read: admitted([grant({ roleId: 'sales_staff' })]) }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a replaced grant', { read: admitted([grant({ roleId: 'manager', membershipId: '66666666-6666-4666-8666-666666666666' })]) }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a grant moved to another tenant', { read: admitted([grant({ roleId: 'manager', tenant: OTHER_TENANT })]) }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a second tenant grant', { read: admitted([grant({ roleId: 'manager' }), grant({ roleId: 'manager', membershipId: '66666666-6666-4666-8666-666666666666', tenant: OTHER_TENANT })]) }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a suspended tenant', { read: admitted([grant({ roleId: 'manager', tenantStatus: 'suspended' })]) }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a tenant turned read-only', { read: admitted([grant({ roleId: 'manager', tenantStatus: 'read_only' })]) }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a moved account security version', { read: movedAccount }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a technician, whom create_customers never admits', { read: admitted([grant({ roleId: 'technician' })]) }, { ...SCOPE, roleId: 'technician' }, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['an undecidable tenant key', {}, SCOPE, 'view_shipping_costs', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    // M7A-CUSTOMERS-P3-R1: the role's CURRENT definition decides — an owner's edit that committed first is read here.
    ['a manager the owner narrowed to Customers View', { levels: { customers: 'view' } }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['a manager the owner narrowed to Customers None', { levels: { customers: 'none' } }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['edits that are not a plain object', { levels: null }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['edits naming an unknown domain', { levels: { customer: 'full' } }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['an edit at a non-canonical level', { levels: { customers: 'Full' } }, SCOPE, 'create_customers', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['edit_role_levels with no recent-authentication deadline', { read: admitted([grant()]) }, { ...SCOPE, roleId: 'store_owner' }, 'edit_role_levels', null, KEY, []],
    ['edit_role_levels with a deadline that is not a positive integer', { read: admitted([grant()]) }, { ...SCOPE, roleId: 'store_owner' }, 'edit_role_levels', 0, KEY, []],
    ['edit_role_levels past its deadline on the database clock', { read: admitted([grant()]), fresh: false }, { ...SCOPE, roleId: 'store_owner' }, 'edit_role_levels', 1_700_000_000_000, KEY, ['peek', 'hold', 'session', 'read', 'fresh']],
    ['edit_role_levels for a manager', {}, SCOPE, 'edit_role_levels', 1_700_000_000_000, KEY, ['peek', 'hold', 'session', 'read', 'fresh', 'levels']],
  ];
  for (const [label, over, scope, permission, authNotAfter, key, expected] of cases) {
    const { revalidate, steps } = revalidator(over);
    assert.equal(await revalidate('tx', scope, permission, authNotAfter, key), false, label);
    assert.deepEqual(steps.map(([step]) => step), expected, `${label}: stops there`);
  }
});

test('M7TR-03 a fault is an outage — a throw, never false — and dependencies are checked at construction', async () => {
  const fault = new Error('lock timeout');
  for (const step of ['peek', 'hold', 'session', 'read', 'levels'] as const) {
    await assert.rejects(revalidator({ [step]: fault }).revalidate('tx', SCOPE, 'create_customers', null, KEY), (err: unknown) => err === fault, step);
  }
  await assert.rejects(revalidator({ read: admitted([grant()]), fresh: fault }).revalidate('tx', { ...SCOPE, roleId: 'store_owner' }, 'edit_role_levels', 1_700_000_000_000, KEY),
    (err: unknown) => err === fault, 'fresh');
  await assert.rejects(revalidator({ hold: 'held' }).revalidate('tx', SCOPE, 'create_customers', null, KEY), /tenant admission unavailable/, 'a hold answering no boolean');
  await assert.rejects(revalidator({ read: { outcome: 'unavailable' } }).revalidate('tx', SCOPE, 'create_customers', null, KEY), /tenant admission unavailable/);
  const ok = async () => undefined;
  const all = { hold: ok, read: ok, peek: ok, session: ok, levels: ok, fresh: ok };
  for (const deps of [undefined, {}, { hold: ok, read: ok, peek: ok }, { hold: ok, read: ok, session: ok }, { ...all, read: 'x' },
    { ...all, levels: undefined }, { ...all, fresh: undefined }, { ...all, levels: {} }]) {
    assert.throws(() => createTenantContextRevalidator(deps as never), TypeError);
  }
  assert.doesNotThrow(() => createTenantContextRevalidator(all as never), 'every dependency present (control)');
});

// --- the role's CURRENT definition (M7A-CUSTOMERS-P3-R1) ---------------------------------------------------------------

/** An authorizer over `port` whose levels read answers `levels` (or throws it), recording each (tenant, role) it was asked for. */
function withLevels(port: TenantAdmissionPort, levels: unknown) {
  const asked: Array<[string, string]> = [];
  const authorizer = createTenantRouteAuthorizer({
    admission: port, reads: new Set([readKey('GET', '/api/v1/customers')]),
    levels: async (tenant, role, signal) => {
      asked.push([tenant, role]);
      assert.ok(signal instanceof AbortSignal, 'the request\'s own deadline signal');
      if (levels instanceof Error) throw levels;
      return levels;
    },
  });
  const decide = (requirement: AuthorizationRequirement, route: RouteView = CREATE_ROUTE): Promise<unknown> =>
    answered(authorizer.authorize(PRINCIPAL, requirement, route, live(), null));
  return { decide, asked };
}
const grantedOf = (answer: unknown): boolean => (answer as { granted?: unknown }).granted === true;

test('M7TL-01 the authorizer refuses to be built without the role-levels read, and reads it only for a permission the catalog decides', async () => {
  for (const levels of [undefined, null, {}, 'levels']) {
    assert.throws(() => createTenantRouteAuthorizer({ admission: stub(admitted([grant()])), levels } as never), TypeError, String(levels));
  }
  const undecided = withLevels(stub(admitted([grant({ roleId: 'manager' })])), {});
  assert.ok(grantedOf(await undecided.decide(TENANT_REQUIREMENT, ROUTE)), 'an undecidable key (control)');
  assert.deepEqual(undecided.asked, [], 'no read for a key decided on membership and lifecycle alone');
  const decided = withLevels(stub(admitted([grant({ roleId: 'sales_staff' })])), {});
  assert.ok(grantedOf(await decided.decide(CREATE_CUSTOMERS)));
  assert.deepEqual(decided.asked, [[TENANT, 'sales_staff']], 'the selected grant\'s tenant and role, once, never the request\'s');
});

test('M7TL-02 an owner\'s edit replaces the default: narrowed below Create denies the create, below View denies the read; widened grants', async () => {
  const cases: Array<[string, string, unknown, AuthorizationRequirement, boolean]> = [
    ['sales_staff at its default', 'sales_staff', {}, CREATE_CUSTOMERS, true],
    ['sales_staff narrowed to View: no create', 'sales_staff', { customers: 'view' }, CREATE_CUSTOMERS, false],
    ['sales_staff narrowed to View: still reads', 'sales_staff', { customers: 'view' }, VIEW_CUSTOMERS, true],
    ['sales_staff narrowed to None: no read', 'sales_staff', { customers: 'none' }, VIEW_CUSTOMERS, false],
    ['manager narrowed to Create: still creates', 'manager', { customers: 'create' }, CREATE_CUSTOMERS, true],
    ['manager narrowed to None: no create', 'manager', { customers: 'none' }, CREATE_CUSTOMERS, false],
    ['technician widened to Create', 'technician', { customers: 'create' }, CREATE_CUSTOMERS, true],
    ['technician at its default (View)', 'technician', {}, CREATE_CUSTOMERS, false],
    ['the owner is never narrowed', 'store_owner', { customers: 'none' }, CREATE_CUSTOMERS, true],
    ['an edit of another domain leaves Customers at its default', 'sales_staff', { sales: 'none' }, CREATE_CUSTOMERS, true],
    ['malformed edits deny even the default', 'sales_staff', { customers: 'writer' }, CREATE_CUSTOMERS, false],
    ['an unknown domain denies', 'sales_staff', { customer: 'full' }, VIEW_CUSTOMERS, false],
    ['edits that are an array deny', 'sales_staff', [], VIEW_CUSTOMERS, false],
    ['no edits answered at all denies', 'sales_staff', undefined, VIEW_CUSTOMERS, false],
  ];
  for (const [label, roleId, levels, requirement, expected] of cases) {
    const route = requirement === VIEW_CUSTOMERS ? CUSTOMERS_ROUTE : CREATE_ROUTE;
    assert.equal(grantedOf(await withLevels(stub(admitted([grant({ roleId })])), levels).decide(requirement, route)), expected, label);
  }
  // A read-only actor is still capped at View whatever the edit says: a widened role creates nothing while read-only.
  const readOnly = withLevels(stub(admitted([grant({ roleId: 'technician', tenantStatus: 'read_only' })])), { customers: 'full' });
  assert.equal(await readOnly.decide(CREATE_CUSTOMERS), false, 'read-only caps the edit');
  assert.ok(grantedOf(await readOnly.decide(VIEW_CUSTOMERS, CUSTOMERS_ROUTE)), 'and the classified read stays granted');
});

test('M7TL-03 a levels read that cannot answer is an outage — the thrown error, never a decision on the defaults', async () => {
  const fault = new Error('role levels answer invalid');
  await assert.rejects(withLevels(stub(admitted([grant({ roleId: 'sales_staff' })])), fault).decide(CREATE_CUSTOMERS), (err: unknown) => err === fault);
});

const EDIT_ROUTE: RouteView = Object.freeze({ method: 'PUT', path: '/api/v1/roles/levels', audience: 'tenant' });
const EDIT_ROLE_LEVELS: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: 'edit_role_levels' });

test('M7TL-04 edit_role_levels is the OWNER RULE: the owner role alone, unlimited — never a manager, however its level is edited', async () => {
  const granted = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (roleId) =>
    [roleId, grantedOf(await withLevels(stub(admitted([grant({ roleId })])), {}).decide(EDIT_ROLE_LEVELS, EDIT_ROUTE))])));
  assert.deepEqual(granted, { store_owner: true, manager: false, technician: false, sales_staff: false });
  for (const [label, answer, levels] of [
    ['a manager edited to Full', admitted([grant({ roleId: 'manager' })]), { customers: 'full' }],
    ['a read-only owner', admitted([grant({ tenantStatus: 'read_only' })]), {}],
    ['an owner of a read-only account', admitted([grant()], 'read_only'), {}],
    ['an owner whose edits are unreadable', admitted([grant()]), { customers: 'bogus' }],
    ['a platform owner on a tenant grant', admitted([grant({ roleId: 'system_owner' })]), {}],
    ['a store owner grant alone', admitted([grant({ scopeType: 'store', store: STORE, storeStatus: 'active' })]), {}],
  ] as const) {
    assert.equal(await withLevels(stub(answer), levels).decide(EDIT_ROLE_LEVELS, EDIT_ROUTE), false, label);
  }
  // edit_role_levels names nothing at store scope: judged on a store template's view AT the grant's store (M7B-INVOICES-P1),
  // where that store grant would select, so the denial is the catalog's and not a missing target.
  const storeOwner = withLevels(stub(admitted([grant({ scopeType: 'store', store: STORE, storeStatus: 'active' })])), {});
  assert.equal(await storeOwner.decide({ scope: 'store', permission: 'edit_role_levels' }, STORE_ROUTE), false, 'edit_role_levels names nothing at store scope');
  assert.ok(grantedOf(await storeOwner.decide(STORE_REQUIREMENT, STORE_ROUTE)), 'the same store grant selects on a store key at its store (control)');
});

test('M7TL-05 the revalidator decides edit_role_levels on a fresh authentication judged on the committing handle, and re-decides the owner', async () => {
  const owner = { ...SCOPE, roleId: 'store_owner' };
  const { revalidate, steps } = revalidator({ read: admitted([grant()]) });
  assert.equal(await revalidate('tx', owner, 'edit_role_levels', 1_700_000_000_000, KEY), true);
  assert.deepEqual(steps.map(([step]) => step), ['peek', 'hold', 'session', 'read', 'fresh', 'levels'], 'the clock after every lock');
  assert.deepEqual(steps.find(([step]) => step === 'fresh')?.slice(1), ['tx', 1_700_000_000_000], 'the deadline, on the committing handle');
  // An owner whose grant was re-roled since the authorizer decided is refused by the scope comparison.
  assert.equal(await revalidator({ read: admitted([grant({ roleId: 'manager' })]) }).revalidate('tx', owner, 'edit_role_levels', 1_700_000_000_000, KEY), false);
  // Widened edits never make a manager an owner.
  assert.equal(await revalidator({ levels: { customers: 'full' } }).revalidate('tx', SCOPE, 'edit_role_levels', 1_700_000_000_000, KEY), false);
  // And a widened technician creates on this transaction's reading.
  const technician = { ...SCOPE, roleId: 'technician' };
  assert.equal(await revalidator({ read: admitted([grant({ roleId: 'technician' })]), levels: { customers: 'create' } })
    .revalidate('tx', technician, 'create_customers', null, KEY), true);
});

// --- edit_customers: the route decision and its revalidation (M7A-CUSTOMERS-P7) ----------------------------------------

const UPDATE_ROUTE: RouteView = Object.freeze({ method: 'PATCH', path: '/api/v1/customers/{id}', audience: 'tenant' });
const EDIT_CUSTOMERS: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: 'edit_customers' });

test('M7TE-AZ-01 edit_customers: the store owner and the manager are granted at their defaults; the technician (View), the sales staff (Create), a read-only actor and a store grant deny', async () => {
  const granted = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (roleId) =>
    [roleId, grantedOf(await withLevels(stub(admitted([grant({ roleId })])), {}).decide(EDIT_CUSTOMERS, UPDATE_ROUTE))])));
  assert.deepEqual(granted, { store_owner: true, manager: true, technician: false, sales_staff: false }, 'Customers at Edit or above, and no other role');
  const storeManager = grant({ membershipId: '77777777-7777-4777-8777-777777777777', scopeType: 'store', store: STORE, storeStatus: 'active', roleId: 'manager' });
  for (const [label, answer] of [
    ['a read-only tenant', admitted([grant({ roleId: 'manager', tenantStatus: 'read_only' })])],
    ['a read-only account', admitted([grant({ roleId: 'manager' })], 'read_only')],
    ['a store manager grant alone', admitted([storeManager])],
    ['two tenant grants', admitted([grant({ roleId: 'manager' }), grant({ roleId: 'manager', membershipId: '66666666-6666-4666-8666-666666666666', tenant: OTHER_TENANT })])],
    ['a suspended tenant', admitted([grant({ roleId: 'manager', tenantStatus: 'suspended' })])],
  ] as const) assert.equal(grantedOf(await withLevels(stub(answer), {}).decide(EDIT_CUSTOMERS, UPDATE_ROUTE)), false, label);
});

test('M7TE-AZ-02 edit_customers follows the owner\'s edits: View or Create only deny; Edit, Manage, Approve and Full grant; read-only caps a widened role', async () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    ['sales_staff widened to Edit', 'sales_staff', { customers: 'edit' }, true],
    ['technician widened to Manage', 'technician', { customers: 'manage' }, true],
    ['technician widened to Approve', 'technician', { customers: 'approve' }, true],
    ['technician widened to Full', 'technician', { customers: 'full' }, true],
    ['manager narrowed to Create', 'manager', { customers: 'create' }, false],
    ['manager narrowed to View', 'manager', { customers: 'view' }, false],
    ['manager narrowed to None', 'manager', { customers: 'none' }, false],
    ['the owner is never narrowed', 'store_owner', { customers: 'view' }, true],
    ['malformed edits deny', 'manager', { customers: 'Edit' }, false],
    ['no edits answered denies', 'manager', undefined, false],
  ];
  for (const [label, roleId, levels, expected] of cases) {
    assert.equal(grantedOf(await withLevels(stub(admitted([grant({ roleId })])), levels).decide(EDIT_CUSTOMERS, UPDATE_ROUTE)), expected, label);
  }
  const readOnly = withLevels(stub(admitted([grant({ roleId: 'technician', tenantStatus: 'read_only' })])), { customers: 'full' });
  assert.equal(await readOnly.decide(EDIT_CUSTOMERS, UPDATE_ROUTE), false, 'read-only caps the edit');
});

test('M7TE-AZ-03 the revalidator re-decides edit_customers on the committing handle, with no recent-authentication deadline, against the current levels', async () => {
  for (const roleId of ['store_owner', 'manager']) {
    const { revalidate, steps } = revalidator({ read: admitted([grant({ roleId })]) });
    assert.equal(await revalidate('tx', { ...SCOPE, roleId }, 'edit_customers', null, KEY), true, roleId);
    assert.deepEqual(steps.map(([step]) => step), ['peek', 'hold', 'session', 'read', 'levels'], roleId);
  }
  for (const [label, over, scope] of [
    ['a sales staff (Create)', { read: admitted([grant({ roleId: 'sales_staff' })]) }, { ...SCOPE, roleId: 'sales_staff' }],
    ['a manager the owner narrowed to Create after the authorizer decided', { levels: { customers: 'create' } }, SCOPE],
    ['a read-only scope', {}, { ...SCOPE, limitation: 'read_only' }],
  ] as const) {
    const { revalidate } = revalidator(over as never);
    assert.equal(await revalidate('tx', scope as TrustedScope, 'edit_customers', null, KEY), false, label);
  }
  const { revalidate } = revalidator({ read: admitted([grant({ roleId: 'technician' })]), levels: { customers: 'edit' } });
  assert.equal(await revalidate('tx', { ...SCOPE, roleId: 'technician' }, 'edit_customers', null, KEY), true, 'a technician the owner widened to Edit');
});

// --- M7B-INVOICES-P1: the store route permissions, decided at the store grant's role, and their revalidation ----------------

const VIEW_DRAFTS: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'view_invoice_drafts' });
const CREATE_DRAFTS: AuthorizationRequirement = Object.freeze({ scope: 'store', permission: 'create_invoice_drafts' });
const DRAFTS_POST: RouteView = Object.freeze({ method: 'POST', path: '/api/v1/stores/{storeId}/invoice-drafts', audience: 'tenant', storeTarget: STORE });
const storeGrantOf = (roleId: string, over: Partial<TrustedMembership> = {}): TrustedMembership =>
  grant({ scopeType: 'store', store: STORE, storeStatus: 'active', roleId, ...over });

test('M7B-AZ-01 view_invoice_drafts and create_invoice_drafts are decided on the STORE grant\'s role at its tenant\'s levels: defaults, corequisite and the asked tenant', async () => {
  const decide = async (roleId: string, requirement: AuthorizationRequirement, levels: unknown = {}) => {
    const probe = withLevels(stub(admitted([storeGrantOf(roleId)])), levels);
    const answer = await probe.decide(requirement, requirement === CREATE_DRAFTS ? DRAFTS_POST : STORE_ROUTE);
    return { granted: grantedOf(answer), asked: probe.asked, answer };
  };
  const view = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (r) => [r, (await decide(r, VIEW_DRAFTS)).granted])));
  assert.deepEqual(view, { store_owner: true, manager: true, technician: true, sales_staff: true }, 'Invoices View at every default');
  const create = Object.fromEntries(await Promise.all(TENANT_ROLE_IDS.map(async (r) => [r, (await decide(r, CREATE_DRAFTS)).granted])));
  assert.deepEqual(create, { store_owner: true, manager: true, technician: false, sales_staff: true }, 'Invoices Create AND Customers View at the defaults');
  const sales = await decide('sales_staff', CREATE_DRAFTS);
  assert.deepEqual(sales.asked, [[TENANT, 'sales_staff']], 'the store grant\'s own tenant and role');
  assert.deepEqual((sales.answer as { context: unknown }).context, {
    actor: ACTOR, securityVersion: 'sv1', scope: 'store', tenant: TENANT, store: STORE, membershipId: MEMBERSHIP, roleId: 'sales_staff', limitation: 'none',
  });
  for (const [label, roleId, levels, expected] of [
    ['sales staff whose Customers the owner narrowed to None', 'sales_staff', { customers: 'none' }, false],
    ['sales staff narrowed to Invoices View', 'sales_staff', { invoices: 'view' }, false],
    ['a manager narrowed to Invoices None', 'manager', { invoices: 'none' }, false],
    ['a technician widened to Invoices Create (Customers View by default)', 'technician', { invoices: 'create' }, true],
    ['a technician widened to Invoices Create but Customers None', 'technician', { invoices: 'create', customers: 'none' }, false],
    ['the owner is never narrowed', 'store_owner', { invoices: 'none', customers: 'none' }, true],
    ['malformed edits deny', 'manager', { invoices: 'Full' }, false],
    ['edits that are not a plain object deny', 'manager', null, false],
  ] as const) {
    assert.equal((await decide(roleId, CREATE_DRAFTS, levels)).granted, expected, label);
  }
  assert.equal((await decide('manager', VIEW_DRAFTS, { invoices: 'none' })).granted, false, 'view: a manager narrowed to Invoices None');
  assert.equal((await decide('technician', VIEW_DRAFTS, { customers: 'none' })).granted, true, 'view needs no Customers level');
  // The keys name nothing at tenant scope, and the tenant keys nothing at store scope.
  for (const permission of ['view_invoice_drafts', 'create_invoice_drafts', 'edit_invoice_drafts']) {
    assert.equal(grantedOf(await withLevels(stub(admitted([grant()])), {}).decide({ scope: 'tenant', permission })), false, `${permission} at tenant scope`);
  }
  // (A catalogued but undecidable sub-permission such as reopen_invoice is still judged on membership and lifecycle alone, as
  // before; composition refuses any route that declares one — transactionKernel.ts uncataloguedRoutePermissions.)
  for (const permission of ['view_customers', 'create_customers', 'edit_customers', 'edit_role_levels']) {
    assert.equal(grantedOf(await withLevels(stub(admitted([storeGrantOf('store_owner')])), {}).decide({ scope: 'store', permission }, STORE_ROUTE)), false,
      `${permission} decides nothing at store scope`);
  }
});

test('M7B-AZ-02 a read-only store, tenant or account reaches only a CLASSIFIED store read, never the create', async () => {
  const reads = new Set([readKey('GET', '/api/v1/stores/{storeId}/invoice-drafts')]);
  const decide = (answer: unknown, requirement: AuthorizationRequirement, route: RouteView, classified: ReadonlySet<string> = reads) =>
    answered(createTenantRouteAuthorizer({ admission: stub(answer), levels: NO_EDITS, reads: classified }).authorize(PRINCIPAL, requirement, route, live(), null));
  for (const [label, answer] of [
    ['a read-only store', admitted([storeGrantOf('manager', { storeStatus: 'read_only' })])],
    ['an overdue store', admitted([storeGrantOf('manager', { storeStatus: 'overdue' })])],
    ['a read-only tenant', admitted([storeGrantOf('manager', { tenantStatus: 'read_only' })])],
    ['a read-only account', admitted([storeGrantOf('manager')], 'read_only')],
  ] as const) {
    const viewed = await decide(answer, VIEW_DRAFTS, STORE_ROUTE);
    assert.equal(grantedOf(viewed), true, `${label}: the classified read`);
    assert.equal((viewed as { context: { limitation: string } }).context.limitation, 'read_only', `${label}: narrowed`);
    assert.equal(await decide(answer, VIEW_DRAFTS, STORE_ROUTE, new Set()), false, `${label}: unclassified`);
    assert.equal(await decide(answer, CREATE_DRAFTS, DRAFTS_POST), false, `${label}: never the create`);
  }
  for (const [label, answer] of [
    ['a suspended store', admitted([storeGrantOf('manager', { storeStatus: 'suspended' })])],
    ['a pending store', admitted([storeGrantOf('manager', { storeStatus: 'pending_activation' })])],
    ['a suspended tenant', admitted([storeGrantOf('manager', { tenantStatus: 'suspended' })])],
  ] as const) assert.equal(await decide(answer, VIEW_DRAFTS, STORE_ROUTE), false, label);
});

test('M7B-AZ-03 (M7B-INVOICES-P1-R2, DA-201) the eligibility view under the save\'s requirement decides exactly as the save: per role and owner edit, technician denied at its default level and a role outside the catalog always denied, a read-only or overdue scope denied although the route is a classified read', async () => {
  const ELIGIBILITY: RouteView = Object.freeze({ method: 'GET', path: INVOICE_DRAFT_ELIGIBILITY_PATH, audience: 'tenant', storeTarget: STORE });
  const reads = new Set([readKey('GET', '/api/v1/stores/{storeId}/invoice-drafts'), readKey('GET', INVOICE_DRAFT_ELIGIBILITY_PATH)]);
  // The requirement each route itself declares: the eligibility route's, and the save's (CREATE_DRAFTS).
  const declared = createInvoiceDraftEligibilityRoute().policy;
  assert.ok(declared.access === 'session' && declared.authorization !== null);
  const requirementOf = (route: RouteView): AuthorizationRequirement => (route === DRAFTS_POST ? CREATE_DRAFTS : declared.authorization as AuthorizationRequirement);
  const decide = (answer: unknown, route: RouteView, levels: unknown = {}) => answered(createTenantRouteAuthorizer({
    admission: stub(answer), levels: async () => levels, reads,
  }).authorize(PRINCIPAL, requirementOf(route), route, live(), null));
  assert.equal(declared.authorization, INVOICE_DRAFT_CREATE_REQUIREMENT, 'the route declares the save\'s requirement object');
  const EDITS = [
    {}, { invoices: 'none' }, { invoices: 'view' }, { invoices: 'create' }, { invoices: 'full' }, { customers: 'none' }, { customers: 'view' },
    { invoices: 'create', customers: 'none' }, { invoices: 'full', customers: 'view' }, { invoices: 'Full' }, null,
  ];
  const table: Record<string, boolean[]> = {};
  for (const roleId of [...TENANT_ROLE_IDS, 'custom_role_browser_only']) {
    table[roleId] = [];
    for (const levels of EDITS) {
      const answer = admitted([storeGrantOf(roleId)]);
      const eligible = grantedOf(await decide(answer, ELIGIBILITY, levels));
      assert.equal(eligible, grantedOf(await decide(answer, DRAFTS_POST, levels)), `${roleId} ${JSON.stringify(levels)}: eligibility = the save's decision`);
      table[roleId].push(eligible);
    }
  }
  assert.deepEqual(table, {
    store_owner: [true, true, true, true, true, true, true, true, true, false, false],
    manager: [true, false, false, true, true, false, true, false, true, false, false],
    technician: [false, false, false, true, true, false, false, false, true, false, false],
    sales_staff: [true, false, false, true, true, false, true, false, true, false, false],
    custom_role_browser_only: Array(EDITS.length).fill(false),
  }, 'defaults: owner, manager and sales staff yes, technician no; an edit below Invoices Create or Customers View denies (never the owner); malformed edits and a role the catalog does not hold never');
  for (const [label, answer] of [
    ['a read-only store', admitted([storeGrantOf('manager', { storeStatus: 'read_only' })])],
    ['an overdue store', admitted([storeGrantOf('manager', { storeStatus: 'overdue' })])],
    ['a read-only tenant', admitted([storeGrantOf('manager', { tenantStatus: 'read_only' })])],
    ['an overdue tenant', admitted([storeGrantOf('manager', { tenantStatus: 'overdue' })])],
    ['a read-only account', admitted([storeGrantOf('manager')], 'read_only')],
    ['a suspended store', admitted([storeGrantOf('manager', { storeStatus: 'suspended' })])],
    ['a grant at another store', admitted([storeGrantOf('manager', { store: OTHER_TENANT })])],
    ['a tenant grant only (no inheritance)', admitted([grant({ roleId: 'manager' })])],
    ['two roles at the store', admitted([storeGrantOf('manager'), storeGrantOf('sales_staff', { membershipId: OTHER_TENANT })])],
  ] as const) {
    assert.equal(await decide(answer, ELIGIBILITY), false, `${label}: eligibility`);
    assert.equal(await decide(answer, DRAFTS_POST), false, `${label}: the save`);
  }
  assert.equal(await decide(admitted([storeGrantOf('manager')]), { ...ELIGIBILITY, storeTarget: null }), false, 'a non-canonical store segment selects nothing');
});

// --- M7B-INVOICES-P2: the edit permission, its eligibility, and its revalidation --------------------------------------------

const DRAFT_PATCH: RouteView = Object.freeze({ method: 'PATCH', path: INVOICE_DRAFT_PATH, audience: 'tenant', storeTarget: STORE });
const EDIT_ELIGIBILITY: RouteView = Object.freeze({ method: 'GET', path: INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH, audience: 'tenant', storeTarget: STORE });
/** The owner-edited Invoices levels a decision table walks, with a Customers level that must never matter. */
const LEVEL_EDITS: readonly unknown[] = [
  {}, { invoices: 'none' }, { invoices: 'view' }, { invoices: 'create' }, { invoices: 'edit' }, { invoices: 'manage' }, { invoices: 'approve' },
  { invoices: 'full' }, { customers: 'none' }, { invoices: 'edit', customers: 'none' }, { invoices: 'create', customers: 'full' }, { invoices: 'Edit' }, null,
];

test('M7B-AZ-04 (M7B-INVOICES-P2, D1) edit_invoice_drafts is Invoices at Edit or above on the STORE grant\'s role at its tenant\'s levels — Customers never matters, Create is not Edit, the owner is never narrowed', async () => {
  // The requirement objects are distinct: the edit's is its own, never the create's or the view's.
  assert.deepEqual(INVOICE_DRAFT_EDIT_REQUIREMENT, { scope: 'store', permission: 'edit_invoice_drafts' });
  assert.notEqual(INVOICE_DRAFT_EDIT_REQUIREMENT, INVOICE_DRAFT_CREATE_REQUIREMENT);
  assert.ok(Object.isFrozen(INVOICE_DRAFT_EDIT_REQUIREMENT), 'frozen');
  const reads = new Set([readKey('GET', INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH), readKey('GET', INVOICE_DRAFT_ELIGIBILITY_PATH)]);
  const decide = (answer: unknown, requirement: AuthorizationRequirement, route: RouteView, levels: unknown = {}) => answered(createTenantRouteAuthorizer({
    admission: stub(answer), levels: async () => levels, reads,
  }).authorize(PRINCIPAL, requirement, route, live(), null));
  const ELIGIBILITY_VIEW: RouteView = Object.freeze({ method: 'GET', path: INVOICE_DRAFT_ELIGIBILITY_PATH, audience: 'tenant', storeTarget: STORE });
  const table: Record<string, boolean[]> = {};
  for (const roleId of [...TENANT_ROLE_IDS, 'custom_role_browser_only', 'cashier']) {
    table[roleId] = [];
    for (const levels of LEVEL_EDITS) {
      const answer = admitted([storeGrantOf(roleId)]);
      const edit = grantedOf(await decide(answer, INVOICE_DRAFT_EDIT_REQUIREMENT, DRAFT_PATCH, levels));
      table[roleId].push(edit);
      // Create eligibility never stands in for Edit: sales staff at its default is granted the create and refused the edit.
      if (roleId === 'sales_staff' && JSON.stringify(levels) === '{}') {
        assert.deepEqual([grantedOf(await decide(answer, INVOICE_DRAFT_CREATE_REQUIREMENT, ELIGIBILITY_VIEW, levels)), edit], [true, false], 'sales staff: Create yes, Edit no');
      }
    }
  }
  assert.deepEqual(table, {
    //            {}     none   view   create edit   manage approve full   cust:none edit+cust:none create+cust:full Edit(bad) null
    store_owner: [true, true, true, true, true, true, true, true, true, true, true, false, false],
    manager: [true, false, false, false, true, true, true, true, true, true, false, false, false],
    technician: [false, false, false, false, true, true, true, true, false, true, false, false, false],
    sales_staff: [false, false, false, false, true, true, true, true, false, true, false, false, false],
    custom_role_browser_only: Array(LEVEL_EDITS.length).fill(false),
    cashier: Array(LEVEL_EDITS.length).fill(false),
  }, 'defaults: owner and manager yes, technician (View) and sales staff (Create) no; Invoices Edit or above grants whatever Customers is; malformed edits and roles outside the catalog never');
  // Every write-refusing status, and every selection failure, denies the edit — the read-only and overdue ones although the
  // eligibility route is a classified read.
  for (const [label, answer] of [
    ['a read-only store', admitted([storeGrantOf('manager', { storeStatus: 'read_only' })])],
    ['an overdue store', admitted([storeGrantOf('manager', { storeStatus: 'overdue' })])],
    ['a read-only tenant', admitted([storeGrantOf('manager', { tenantStatus: 'read_only' })])],
    ['an overdue tenant', admitted([storeGrantOf('manager', { tenantStatus: 'overdue' })])],
    ['a read-only account', admitted([storeGrantOf('manager')], 'read_only')],
    ['a suspended store', admitted([storeGrantOf('manager', { storeStatus: 'suspended' })])],
    ['a pending store', admitted([storeGrantOf('manager', { storeStatus: 'pending_activation' })])],
    ['a suspended tenant', admitted([storeGrantOf('manager', { tenantStatus: 'suspended' })])],
    ['a grant at another store', admitted([storeGrantOf('manager', { store: OTHER_TENANT })])],
    ['a tenant grant only (no inheritance)', admitted([grant({ roleId: 'manager' })])],
    ['a tenant owner grant only (no inheritance)', admitted([grant({ roleId: 'store_owner' })])],
    ['two roles at the store', admitted([storeGrantOf('manager'), storeGrantOf('sales_staff', { membershipId: OTHER_TENANT })])],
  ] as const) {
    for (const route of [DRAFT_PATCH, EDIT_ELIGIBILITY]) assert.equal(await decide(answer, INVOICE_DRAFT_EDIT_REQUIREMENT, route), false, `${label}: ${route.method}`);
  }
  // Controls: the same manager grant at an active store is granted, so the denials above are the statuses'.
  assert.equal(grantedOf(await decide(admitted([storeGrantOf('manager')]), INVOICE_DRAFT_EDIT_REQUIREMENT, DRAFT_PATCH)), true);
  assert.equal(await decide(admitted([storeGrantOf('manager')]), INVOICE_DRAFT_EDIT_REQUIREMENT, { ...DRAFT_PATCH, storeTarget: null }), false, 'a non-canonical store segment selects nothing');
  // The key names nothing at tenant scope.
  assert.equal(grantedOf(await withLevels(stub(admitted([grant({ roleId: 'store_owner' })])), {}).decide({ scope: 'tenant', permission: 'edit_invoice_drafts' })), false);
});

test('M7B-AZ-05 (M7B-INVOICES-P2, D2) the edit eligibility declares the PATCH\'s own requirement object and decides exactly as the PATCH, cell by cell; the creation eligibility still decides as the save', async () => {
  const declared = createInvoiceDraftEditEligibilityRoute().policy;
  const patched = INVOICE_DRAFT_UPDATE_ROUTE.policy;
  assert.ok(declared.access === 'session' && patched.access === 'session', 'both are session routes');
  assert.equal(declared.authorization, INVOICE_DRAFT_EDIT_REQUIREMENT, 'the edit eligibility declares the edit requirement object itself');
  assert.equal(patched.authorization, INVOICE_DRAFT_EDIT_REQUIREMENT, 'the PATCH declares the same object');
  const create = createInvoiceDraftEligibilityRoute().policy;
  assert.ok(create.access === 'session' && create.authorization === INVOICE_DRAFT_CREATE_REQUIREMENT, 'the creation eligibility is unchanged');
  const reads = new Set([readKey('GET', INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH)]);
  const decide = (answer: unknown, route: RouteView, levels: unknown) => answered(createTenantRouteAuthorizer({
    admission: stub(answer), levels: async () => levels, reads,
  }).authorize(PRINCIPAL, (route === DRAFT_PATCH ? patched.authorization : declared.authorization) as AuthorizationRequirement, route, live(), null));
  let granted = 0;
  for (const roleId of [...TENANT_ROLE_IDS, 'custom_role_browser_only']) {
    for (const levels of LEVEL_EDITS) {
      for (const answer of [admitted([storeGrantOf(roleId)]), admitted([storeGrantOf(roleId, { storeStatus: 'read_only' })])]) {
        const eligible = grantedOf(await decide(answer, EDIT_ELIGIBILITY, levels));
        assert.equal(eligible, grantedOf(await decide(answer, DRAFT_PATCH, levels)), `${roleId} ${JSON.stringify(levels)}: eligibility = the edit's decision`);
        if (eligible) granted += 1;
      }
    }
  }
  // Not vacuous: the cells AZ-04's table grants at an active store — 11 for the owner, 7 for the manager, 5 each for the
  // technician and sales staff — are granted on BOTH sides, and none at a read_only store.
  assert.equal(granted, 28, 'the granted cells, both sides');
  assert.equal(grantedOf(await decide(admitted([storeGrantOf('manager')]), EDIT_ELIGIBILITY, {})), true, 'a manager at its default: the eligibility');
  assert.equal(grantedOf(await decide(admitted([storeGrantOf('manager')]), DRAFT_PATCH, {})), true, 'and the PATCH');
  assert.equal(grantedOf(await decide(admitted([storeGrantOf('sales_staff')]), DRAFT_PATCH, { invoices: 'edit' })), true, 'sales staff raised to Edit');
  // The answer is a store selection and a level, never a draft: the view carries no draft id at all.
  assert.deepEqual(Object.keys(EDIT_ELIGIBILITY).sort(), ['audience', 'method', 'path', 'storeTarget']);
  assert.equal(INVOICE_DRAFT_EDIT_ELIGIBILITY_PATH, '/api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility');
});

/** The scope the authorizer hands a store create: the manager's one store grant at STORE. */
const STORE_SCOPE: TrustedScope = Object.freeze({ ...SCOPE, scope: 'store', store: STORE });
const storeRead = (over: Partial<TrustedMembership> = {}) => admitted([storeGrantOf('manager', over)]);

test('M7B-RV-01 the revalidator accepts a store scope for a store route permission, in the same order, re-selecting with the trusted scope\'s own store', async () => {
  const { revalidate, steps } = revalidator({ read: storeRead() });
  assert.equal(await revalidate('tx', STORE_SCOPE, 'create_invoice_drafts', null, KEY), true);
  assert.deepEqual(steps.map(([step]) => step), ['peek', 'hold', 'session', 'read', 'levels']);
  assert.deepEqual(steps.find(([step]) => step === 'levels')?.[2], [TENANT, 'manager'], 'the store grant\'s tenant and role');
  assert.equal(await revalidator({ read: admitted([storeGrantOf('technician')]) }).revalidate('tx', { ...STORE_SCOPE, roleId: 'technician' }, 'view_invoice_drafts', null, KEY), true,
    'view_invoice_drafts for a technician');
  // A grant at a second store does not disturb the selection at this one.
  const elsewhere = grant({ membershipId: '66666666-6666-4666-8666-666666666666', scopeType: 'store', store: '77777777-7777-4777-8777-777777777777', storeStatus: 'active' });
  assert.equal(await revalidator({ read: admitted([storeGrantOf('manager'), elsewhere]) }).revalidate('tx', STORE_SCOPE, 'create_invoice_drafts', null, KEY), true);
});

test('M7B-RV-03 (M7B-INVOICES-P2) the revalidator decides edit_invoice_drafts again on the role\'s CURRENT level: Edit or above holds, Create or below, a narrowed manager, a technician or sales staff at its default, a read-only scope are false', async () => {
  assert.equal(await revalidator({ read: storeRead() }).revalidate('tx', STORE_SCOPE, 'edit_invoice_drafts', null, KEY), true, 'a manager at its default (Full)');
  for (const level of ['edit', 'manage', 'approve', 'full']) {
    assert.equal(await revalidator({ read: storeRead(), levels: { invoices: level, customers: 'none' } }).revalidate('tx', STORE_SCOPE, 'edit_invoice_drafts', null, KEY), true, level);
  }
  const cases: Array<[string, Parameters<typeof revalidator>[0], TrustedScope, string[]]> = [
    ['a manager narrowed to Invoices Create', { read: storeRead(), levels: { invoices: 'create' } }, STORE_SCOPE, ['peek', 'hold', 'session', 'read', 'levels']],
    ['a manager narrowed to Invoices View', { read: storeRead(), levels: { invoices: 'view' } }, STORE_SCOPE, ['peek', 'hold', 'session', 'read', 'levels']],
    ['a technician at its default (View)', { read: admitted([storeGrantOf('technician')]) }, { ...STORE_SCOPE, roleId: 'technician' }, ['peek', 'hold', 'session', 'read', 'levels']],
    ['sales staff at its default (Create)', { read: admitted([storeGrantOf('sales_staff')]) }, { ...STORE_SCOPE, roleId: 'sales_staff' }, ['peek', 'hold', 'session', 'read', 'levels']],
    ['a read-only store scope', {}, { ...STORE_SCOPE, limitation: 'read_only' }, []],
    ['a store turned read-only', { read: storeRead({ storeStatus: 'read_only' }) }, STORE_SCOPE, ['peek', 'hold', 'session', 'read']],
    ['the grant revoked (only a tenant grant now)', { read: admitted([grant({ roleId: 'manager' })]) }, STORE_SCOPE, ['peek', 'hold', 'session', 'read']],
  ];
  for (const [label, over, scope, expected] of cases) {
    const { revalidate, steps } = revalidator(over);
    assert.equal(await revalidate('tx', scope, 'edit_invoice_drafts', null, KEY), false, label);
    assert.deepEqual(steps.map(([step]) => step), expected, `${label}: steps`);
  }
});

test('M7B-RV-02 every lost store authority is false — a key the store scope does not decide is refused before ANY read', async () => {
  const cases: Array<[string, Parameters<typeof revalidator>[0], TrustedScope, string, number | null, string | null, string[]]> = [
    ['a tenant key at store scope', {}, STORE_SCOPE, 'create_customers', null, KEY, []],
    ['an undecidable sub-permission at store scope', {}, STORE_SCOPE, 'reopen_invoice', null, KEY, []],
    ['an invented key at store scope', {}, STORE_SCOPE, 'create_invoice_draft', null, KEY, []],
    ['a store key at tenant scope', { read: admitted([grant({ roleId: 'manager' })]) }, SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['a store scope naming no store', {}, { ...STORE_SCOPE, store: null }, 'create_invoice_drafts', null, KEY, []],
    ['a read-only store scope', {}, { ...STORE_SCOPE, limitation: 'read_only' }, 'create_invoice_drafts', null, KEY, []],
    ['a recent-authentication claim', {}, STORE_SCOPE, 'create_invoice_drafts', 1_700_000_000_000, KEY, []],
    ['no session key', {}, STORE_SCOPE, 'create_invoice_drafts', null, null, []],
    ['the grant moved to another store', { read: admitted([storeGrantOf('manager', { store: '77777777-7777-4777-8777-777777777777' })]) }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a second role at the store', { read: admitted([storeGrantOf('manager'), storeGrantOf('technician', { membershipId: '88888888-8888-4888-8888-888888888888' })]) }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['only a tenant grant now', { read: admitted([grant({ roleId: 'manager' })]) }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a store turned read-only', { read: storeRead({ storeStatus: 'read_only' }) }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a suspended store', { read: storeRead({ storeStatus: 'suspended' }) }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['a changed role', { read: admitted([storeGrantOf('sales_staff')]) }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read']],
    ['Customers narrowed to None', { read: storeRead(), levels: { customers: 'none' } }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['Invoices narrowed to View', { read: storeRead(), levels: { invoices: 'view' } }, STORE_SCOPE, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
    ['a technician (Invoices View) creating', { read: admitted([storeGrantOf('technician')]) }, { ...STORE_SCOPE, roleId: 'technician' }, 'create_invoice_drafts', null, KEY, ['peek', 'hold', 'session', 'read', 'levels']],
  ];
  for (const [label, over, scope, permission, notAfter, key, expected] of cases) {
    const { revalidate, steps } = revalidator(over);
    assert.equal(await revalidate('tx', scope, permission, notAfter, key), false, label);
    assert.deepEqual(steps.map(([step]) => step), expected, `${label}: steps`);
  }
});
