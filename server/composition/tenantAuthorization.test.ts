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
/** No owner edit stored: every role at its catalog default (M7A-CUSTOMERS-P3-R1). */
const NO_EDITS = async (): Promise<unknown> => ({});
/**
 * Both ports declare their methods as answering `unknown` — a port never promises a shape — so each
 * call is adapted once, here, rather than cast at every assertion.
 */
const answered = (value: unknown): Promise<unknown> => Promise.resolve(value);
const authorize = (port: TenantAdmissionPort, requirement = TENANT_REQUIREMENT, reads?: ReadonlySet<string>): Promise<unknown> =>
  answered(createTenantRouteAuthorizer({ admission: port, levels: NO_EDITS, ...(reads === undefined ? {} : { reads }) }).authorize(PRINCIPAL, requirement, ROUTE, live(), null));

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
    // view_customers names nothing at store scope, even for a store grant that would otherwise select.
    ['a store requirement naming view_customers', [storeGrant], { scope: 'store', permission: 'view_customers' }],
  ];
  for (const [label, memberships, requirement] of cases) assert.equal(await customers(stub(admitted(memberships)), requirement), false, label);
  assert.equal(((await customers(stub(admitted([storeGrant])), STORE_REQUIREMENT)) as { granted: boolean }).granted, true, 'the same store grant selects on a store key (control)');
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
  assert.equal(await withLevels(stub(admitted([grant({ scopeType: 'store', store: STORE, storeStatus: 'active' })])), {})
    .decide({ scope: 'store', permission: 'edit_role_levels' }, EDIT_ROUTE), false, 'edit_role_levels names nothing at store scope');
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
