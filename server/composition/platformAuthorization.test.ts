// Phase 4.0 M5-GIAM-D1-P4 — the administrative boundary's two decisions (platformAuthorization.ts) over a synthetic
// admission port: no database. The PostgreSQL adapter behind the port is proved on its own
// (server/persistence/postgresPlatformAdmission.test.ts) and against a real cluster (tests/db); what is decided HERE
// is what the composition does with the port's answer, which the deterministic gate must hold on every run:
//   * ADMISSION answers `false` for a standing that may hold no administrative session — a refused reference, an
//     account that is not 'active' or 'trialing', a read-only cap, no platform grant or two, a role the definitions
//     do not name — and THROWS for anything it cannot read as a standing, because the boundary turns a denial into
//     "revoke every session this principal holds" and an outage into a bounded 503 that revokes nothing;
//   * it admits at a `p1:` witness derived from the whole standing, which moves when any part of it moves, and hands
//     the one platform scope it selected to the same request's authorizer;
//   * the AUTHORIZER decides on that admitted scope alone — never the principal, never a second read that could
//     disagree — by the canonical rule, and a request that reaches it without one is a wiring fault, never a verdict.
// The transaction-time revalidator and the tenant directory's permits are proved to agree with that authorizer, and
// (M5-ADMIN-REVOKE-P1) the revalidator's hold of the presenting session and re-read of its standing, and the
// administrative login's establish check, are proved in their order and in failing closed: a fault throws, never
// reads as a changed standing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createAdmittedPlatformAuthorizer, createPlatformContextRevalidator, createPlatformEstablishCheck, createPlatformPermits,
  createPlatformSessionAdmission, platformStandingOf,
} from './platformAuthorization.js';
import { selectScope } from '../runtime/principals.js';
import type { PlatformAdmissionPort, TrustedMembership, TrustedPrincipal, TrustedScope } from '../runtime/principals.js';
import type { AuthorizationRequirement, SessionAudience, VerifiedPrincipal } from '../runtime/routes.js';
import type { RouteView } from '../runtime/access.js';
import { BUILT_IN_PLATFORM_ROLES, CANONICAL_PLATFORM_PERMISSIONS, evaluateCanonicalPermission } from '../platform-identity/m5CanonicalPermissions.js';
import type { PlatformRoleDefinition } from '../platform-identity/m5CanonicalPermissions.js';
import type { PgTransactionScope } from '../persistence/supervisedPgClient.js';
import type { SessionRecord } from '../runtime/sessions.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR = '99999999-9999-4999-8999-999999999999';
const TENANT = '22222222-2222-4222-8222-222222222222';
const STORE = '44444444-4444-4444-8444-444444444444';
const MEMBERSHIP = '66666666-6666-4666-8666-666666666666';
const OTHER_MEMBERSHIP = '77777777-7777-4777-8777-777777777777';
const VERSION = 'b'.repeat(64);
/** The platform authority version as the port renders it: decimal text (migration 013). */
const AUTHORITY = '7';
const PRINCIPAL: VerifiedPrincipal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-operator' });
const ROUTE: RouteView = Object.freeze({ method: 'PATCH', path: '/admin/v1/tenants/display-name', audience: 'admin' });
const EDIT: AuthorizationRequirement = Object.freeze({ scope: 'platform', permission: 'edit_tenant_profile' });
const SIGNAL = new AbortController().signal;
const TENANT_MANAGEMENT = ['view_tenants', 'edit_tenant_profile', 'change_tenant_status'] as const;
/** The witness's whole shape: the derivation's name, then an unpadded base64url SHA-256. */
const WITNESS_RE = /^p1:[A-Za-z0-9_-]{43}$/;

let nextId = 0;
const grant = (over: Partial<TrustedMembership> = {}): TrustedMembership => Object.freeze({
  membershipId: `55555555-5555-4555-8555-${String(++nextId).padStart(12, '0')}`,
  scopeType: 'platform', tenant: null, store: null, roleId: 'system_owner', tenantStatus: null, storeStatus: null, ...over,
});
const principalWith = (memberships: readonly TrustedMembership[], over: Partial<TrustedPrincipal> = {}): TrustedPrincipal =>
  Object.freeze({ actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: VERSION, memberships: Object.freeze(memberships), ...over });
const platformRole = (roleId: string, over: Partial<TrustedPrincipal> = {}): TrustedPrincipal => principalWith([grant({ roleId })], over);

/** The scope selectScope derives for `p` at platform scope — exactly what admission selects and hands the authorizer. */
const scopeOf = (p: TrustedPrincipal): TrustedScope => {
  const selection = selectScope(p, 'platform', { tenant: null, store: null });
  assert.equal(selection.outcome, 'selected');
  return (selection as { scope: TrustedScope }).scope;
};

const custom = (level: unknown): ReadonlyMap<string, PlatformRoleDefinition> =>
  new Map([['custom_tenant_editor', { levels: { tenant_management: level }, moneyGrants: {} } as unknown as PlatformRoleDefinition]]);

/** A synthetic admission port answering `answer` (or what a function of the call returns), recording every call. */
function port(answer: unknown, probeAnswer: unknown = true): PlatformAdmissionPort & { calls: unknown[][]; probes: unknown[][] } {
  const calls: unknown[][] = [];
  const probes: unknown[][] = [];
  return {
    calls,
    probes,
    admit: (...args: unknown[]) => { calls.push(args); return typeof answer === 'function' ? (answer as () => unknown)() : answer; },
    probe: (...args: unknown[]) => { probes.push(args); return probeAnswer; },
  };
}
const resolved = (p: unknown, authorityVersion: unknown = AUTHORITY) => Object.freeze({ outcome: 'resolved', principal: p, authorityVersion });

/** What a fresh admission over a port answering `answer` decides — so nothing can carry from one call to the next. */
function admitAnswer(answer: unknown, roles?: ReadonlyMap<string, PlatformRoleDefinition>, audience: SessionAudience = 'admin'): Promise<unknown> {
  const admission = createPlatformSessionAdmission({ admission: port(answer), ...(roles === undefined ? {} : { roles }) });
  return Promise.resolve().then(() => admission.admit(PRINCIPAL, audience, SIGNAL));
}
const admitStanding = (p: TrustedPrincipal, authorityVersion: unknown = AUTHORITY, roles?: ReadonlyMap<string, PlatformRoleDefinition>): Promise<unknown> =>
  admitAnswer(resolved(p, authorityVersion), roles);

type Admitted = { readonly admitted: true; readonly securityVersion: string; readonly context: TrustedScope };
/** The witness a standing is admitted at: asserted to be an admission, of the p1 shape. */
async function witnessOf(p: TrustedPrincipal, authorityVersion: string = AUTHORITY): Promise<string> {
  const answer = await admitStanding(p, authorityVersion) as Admitted;
  assert.equal(answer.admitted, true, 'admitted');
  assert.match(answer.securityVersion, WITNESS_RE);
  return answer.securityVersion;
}

/** The authorizer's decision on an admitted scope; a throw surfaces as a rejection. */
function decide(admitted: unknown, requirement: AuthorizationRequirement = EDIT, roles?: ReadonlyMap<string, PlatformRoleDefinition>): Promise<unknown> {
  const authorizer = createAdmittedPlatformAuthorizer(roles === undefined ? {} : { roles });
  return Promise.resolve().then(() => authorizer.authorize(PRINCIPAL, requirement, ROUTE, SIGNAL, admitted as TrustedScope | null));
}

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P4 — admission: may this reference hold an administrative session, on which grant, at what witness
// ---------------------------------------------------------------------------

test('M5PS-01 one active platform grant on an eligible account is admitted at a p1 witness, naming the exact scope selected', async () => {
  for (const accountStatus of ['active', 'trialing']) {
    for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
      const p = platformRole(roleId, { accountStatus });
      const admissionPort = port(resolved(p));
      const answer = await createPlatformSessionAdmission({ admission: admissionPort }).admit(PRINCIPAL, 'admin', SIGNAL) as Admitted;
      const label = `${accountStatus} ${roleId}`;
      assert.deepEqual(Reflect.ownKeys(answer), ['admitted', 'securityVersion', 'context'], `${label}: exactly three keys`);
      assert.equal(answer.admitted, true, label);
      assert.match(answer.securityVersion, WITNESS_RE, `${label}: the witness`);
      assert.notEqual(answer.securityVersion, VERSION, `${label}: the witness is not 007's security version`);
      assert.deepEqual(answer.context, {
        actor: ACTOR, securityVersion: VERSION, scope: 'platform', tenant: null, store: null,
        membershipId: p.memberships[0].membershipId, roleId, limitation: 'none',
      }, `${label}: the context is the platform scope over the very grant, carrying 007's version for the transaction to revalidate`);
      assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.context), `${label}: frozen`);
      // The port is asked once, about exactly this reference, under exactly this deadline — nothing from the request.
      assert.deepEqual(admissionPort.calls, [[PRINCIPAL, SIGNAL]], label);
    }
  }
});

test('M5PS-02 a refused reference, every account status but active and trialing, and a read-only cap deny with false — never a throw', async () => {
  assert.equal(await admitAnswer({ outcome: 'refused' }), false, 'refused');
  // Each status alone, with no cap, so the status check is proved on its own. A status 007 does not define yet is
  // a status word all the same: it admits nothing until it is classified.
  for (const accountStatus of ['read_only', 'overdue', 'pending_activation', 'suspended', 'frozen', 'grace_period', 'deleted']) {
    assert.equal(await admitStanding(platformRole('system_owner', { accountStatus })), false, accountStatus);
  }
  for (const accountStatus of ['active', 'trialing']) {
    assert.equal(await admitStanding(platformRole('system_owner', { accountStatus, limitation: 'read_only' })), false, `${accountStatus}, capped read-only`);
  }
});

test('M5PS-03 no platform grant, two in either order, and a role the definitions do not name all deny', async () => {
  assert.equal(await admitStanding(principalWith([])), false, 'no platform grant');
  const owner = grant({ roleId: 'system_owner' });
  const support = grant({ roleId: 'support_admin' });
  assert.equal(await admitStanding(principalWith([owner, support])), false, 'two grants: ambiguous');
  assert.equal(await admitStanding(principalWith([support, owner])), false, 'the same two, reversed: there is no first match');
  assert.equal(await admitStanding(principalWith([owner, grant({ roleId: 'system_owner' })])), false, 'two grants of one role');
  // A platform grant carrying a role the definitions do not name holds no platform authority, whatever it is called.
  for (const roleId of ['custom_unknown_role', 'store_owner', 'manager', 'system_owners']) {
    assert.equal(await admitStanding(platformRole(roleId)), false, roleId);
  }
});

test('M5PS-04 the role map decides which ids are roles: a custom map admits one the built-in map refuses, and refuses a built-in id it lacks', async () => {
  const p = platformRole('custom_tenant_editor');
  assert.equal(await admitStanding(p), false, 'the built-in definitions (a deployment\'s) do not name it');
  const answer = await admitStanding(p, AUTHORITY, custom('edit')) as Admitted;
  assert.equal(answer.admitted, true);
  assert.equal(answer.context.roleId, 'custom_tenant_editor');
  // Admission asks only whether the role is defined; what it may do is the authorizer's (M5PZ): a View definition admits too.
  assert.equal((await admitStanding(p, AUTHORITY, custom('view')) as Admitted).admitted, true, 'defined at View: admitted, and decided later');
  assert.equal(await admitStanding(platformRole('system_owner'), AUTHORITY, custom('edit')), false, 'System Owner is no authority where no definition names it');
});

test('M5PS-05 anything admission cannot read as a standing is an outage — a throw, never a denial that would revoke every session', async () => {
  const owner = platformRole('system_owner');
  const outages: Array<[string, unknown]> = [
    ['null', null], ['undefined', undefined], ['a string', 'resolved'], ['true', true], ['a number', 1],
    ['unavailable', { outcome: 'unavailable' }],
    ['no outcome', { principal: owner, authorityVersion: AUTHORITY }],
    ['an unknown outcome', { outcome: 'admitted', principal: owner, authorityVersion: AUTHORITY }],
    ['resolved with no principal', { outcome: 'resolved', authorityVersion: AUTHORITY }],
    ['a principal whose actor is not a UUID', resolved({ ...owner, actor: 'not-a-uuid' })],
    ['a principal whose account status is not a status word', resolved({ ...owner, accountStatus: 'Active' })],
    ['a principal whose limitation is unknown', resolved({ ...owner, limitation: 'partial' })],
    ['a principal with no memberships array', resolved({ ...owner, memberships: undefined })],
    ['a grant whose id is not a UUID', resolved(principalWith([grant({ membershipId: 'grant-1' })]))],
    ['a tenant grant beside the platform one', resolved(principalWith([grant(), grant({ scopeType: 'tenant', tenant: TENANT, roleId: 'store_owner', tenantStatus: 'active' })]))],
    ['only a store grant', resolved(principalWith([grant({ scopeType: 'store', tenant: TENANT, store: STORE, roleId: 'manager', tenantStatus: 'active', storeStatus: 'active' })]))],
  ];
  // The authority version the port renders is canonical decimal text in 0..2^53-1: anything else is not the port's.
  for (const authorityVersion of ['', '-1', '1.5', '0x1', ' 1', '1 ', '1\n', '\u0661', '1'.repeat(20), 7, 7n, null, undefined]) {
    outages.push([`authority version ${JSON.stringify(String(authorityVersion))} (${typeof authorityVersion})`,
      { outcome: 'resolved', principal: owner, authorityVersion }]);
  }
  outages.push(['no authority version at all', { outcome: 'resolved', principal: owner }]);
  for (const [label, answer] of outages) {
    await assert.rejects(admitAnswer(answer), /^Error: platform admission unavailable$/, label);
  }
  // A throwing or rejecting port is an outage too: its own error is passed on, never turned into an answer.
  const fault = new Error('db down');
  for (const [label, answer] of [['throws', () => { throw fault; }], ['rejects', () => Promise.reject(fault)]] as const) {
    await assert.rejects(admitAnswer(answer), (err: unknown) => err === fault, `a port that ${label}`);
  }
});

test('M5PS-05b an authority version 013 cannot answer is an outage — canonical decimal in 0..2^53-1 alone reaches a witness', async () => {
  const owner = platformRole('system_owner');
  for (const authorityVersion of ['01', '00', '007', '9007199254740992', '9'.repeat(16), '9'.repeat(19)]) {
    await assert.rejects(admitStanding(owner, authorityVersion), /^Error: platform admission unavailable$/, authorityVersion);
    assert.throws(() => platformStandingOf(resolved(owner, authorityVersion), BUILT_IN_PLATFORM_ROLES), /^Error: platform admission unavailable$/, authorityVersion);
  }
  // 013 answers 0 for an actor with no counter row; 2^53-1 is the widest its CHECK stores.
  for (const authorityVersion of ['0', '9007199254740991']) assert.match(await witnessOf(owner, authorityVersion), /^p1:/, authorityVersion);
});

test('M5PS-06 being asked about any boundary but the administrative one is a wiring fault: a throw, and the port is never asked', async () => {
  const admissionPort = port(resolved(platformRole('system_owner')));
  const admission = createPlatformSessionAdmission({ admission: admissionPort });
  for (const audience of ['tenant', 'Admin', '', undefined]) {
    await assert.rejects(Promise.resolve().then(() => admission.admit(PRINCIPAL, audience as SessionAudience, SIGNAL)),
      /^Error: platform admission unavailable$/, String(audience));
  }
  assert.equal(admissionPort.calls.length, 0, 'a denial composed on the tenant boundary would sign every tenant user out');
});

test('M5PS-07 each field of the port\'s answer is read once: a getter cannot answer the check one way and the decision another', async () => {
  const reads: Record<string, number> = {};
  const good = principalWith([grant({ membershipId: MEMBERSHIP, roleId: 'support_admin' })]);
  // A second read of `principal` would swap in two grants, and of `authorityVersion` a malformed version.
  const second: Record<string, unknown> = { principal: principalWith([grant(), grant()]), authorityVersion: 'not-a-version' };
  const answer = new Proxy({ outcome: 'resolved', principal: good, authorityVersion: AUTHORITY } as Record<string, unknown>, {
    get(target, key, receiver) {
      const name = String(key);
      reads[name] = (reads[name] ?? 0) + 1;
      return reads[name] > 1 && name in second ? second[name] : Reflect.get(target, key, receiver);
    },
  });
  const decision = await admitAnswer(answer) as Admitted;
  assert.equal(decision.securityVersion, await witnessOf(good), 'decided on the standing it read, at the version it read');
  assert.equal(decision.context.membershipId, MEMBERSHIP);
  assert.deepEqual({ outcome: reads.outcome, principal: reads.principal, authorityVersion: reads.authorityVersion }, { outcome: 1, principal: 1, authorityVersion: 1 });
});

// The witness: stable for one standing, moved by any change to it. The database only ever increments the authority
// version (migration 013), so a withdrawn and restored grant, or a role changed and changed back, never returns a
// session's witness to a value it was admitted at.
const BASE = principalWith([grant({ membershipId: MEMBERSHIP, roleId: 'support_admin' })]);

test('M5PS-08 the witness is stable for an unchanged standing: the same value from separate adapters and from an equal copy', async () => {
  const witness = await witnessOf(BASE);
  assert.equal(await witnessOf(BASE), witness, 'a second adapter over the same standing');
  const copy = principalWith([grant({ membershipId: MEMBERSHIP, roleId: 'support_admin' })]);
  assert.notEqual(copy, BASE);
  assert.equal(await witnessOf(copy), witness, 'an equal standing in other objects: the witness is a function of the values');
});

const WITNESS_CHANGES: ReadonlyArray<readonly [string, () => Promise<string>]> = [
  ['the actor', () => witnessOf(principalWith(BASE.memberships, { actor: OTHER_ACTOR }))],
  ['the account status (active to trialing, both eligible)', () => witnessOf(principalWith(BASE.memberships, { accountStatus: 'trialing' }))],
  ['007\'s security version', () => witnessOf(principalWith(BASE.memberships, { securityVersion: 'c'.repeat(64) }))],
  ['the membership (the same role on another grant)', () => witnessOf(principalWith([grant({ membershipId: OTHER_MEMBERSHIP, roleId: 'support_admin' })]))],
  ['the role on the same grant', () => witnessOf(principalWith([grant({ membershipId: MEMBERSHIP, roleId: 'operations_admin' })]))],
  ['the platform authority version', () => witnessOf(BASE, '8')],
];
for (const [index, [field, changed]] of WITNESS_CHANGES.entries()) {
  test(`M5PS-${String(9 + index).padStart(2, '0')} the witness moves when ${field} changes`, async () => {
    // witnessOf asserts each is an admission of the p1 shape: the change moved the session's binding, not its eligibility.
    assert.notEqual(await changed(), await witnessOf(BASE), field);
  });
}

test('M5PS-15 probe delegates to the port: the same signal in, the port\'s own answer out, and nobody is admitted', () => {
  const pending = Promise.resolve(true);
  for (const answer of [true, false, 'ready', pending]) {
    const admissionPort = port(resolved(platformRole('system_owner')), answer);
    const admission = createPlatformSessionAdmission({ admission: admissionPort });
    assert.equal(admission.probe?.(SIGNAL), answer, String(answer));
    assert.deepEqual(admissionPort.probes, [[SIGNAL]], 'exactly the caller\'s signal, once');
    assert.equal(admissionPort.calls.length, 0, 'a probe asks nothing about anyone');
  }
});

test('M5PS-16 admission refuses to be built without a whole port — admit AND probe — or with roles that are not a Map', () => {
  const admit = () => ({ outcome: 'refused' });
  const probe = () => true;
  for (const deps of [
    undefined, null, {}, { admission: null }, { admission: 'port' }, { admission: {} },
    { admission: { probe } }, { admission: { admit } }, { admission: { admit: 'admit', probe } }, { admission: { admit, probe: true } },
  ]) {
    assert.throws(() => createPlatformSessionAdmission(deps as never), TypeError, JSON.stringify(deps) ?? 'undefined');
  }
  for (const roles of [{}, [], { system_owner: { levels: {}, moneyGrants: {} } }, 'roles', new Set(['system_owner'])]) {
    assert.throws(() => createPlatformSessionAdmission({ admission: { admit, probe }, roles: roles as never }), TypeError, String(roles));
  }
  assert.equal(typeof createPlatformSessionAdmission({ admission: { admit, probe } }).admit, 'function', 'a whole port builds (positive control)');
});

test('M5PS-17 the witness is exactly the p1 digest over the eight lines of the standing, the read-only cap among them', async () => {
  // Recomputed here, independently, so the derivation is pinned and not merely "some stable hash": a reordered, dropped
  // or added line fails this even where M5PS-09..14 still pass. The cap is one of the lines, but an admitted standing
  // always carries 'none' (a capped account is denied, M5PS-02), so a witness can never be reached at 'read_only' —
  // what IS provable is that the cap's value is inside the digest, at its place, which this equality checks.
  const lines = ['p1', ACTOR, 'active', 'none', VERSION, MEMBERSHIP, 'support_admin', AUTHORITY];
  assert.equal(await witnessOf(BASE), `p1:${createHash('sha256').update(lines.join('\n')).digest('base64url')}`);
});

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P4 — the route authorizer: the admitted scope, and nothing else, decides
// ---------------------------------------------------------------------------

test('M5PZ-01 a tenant- or store-scope requirement is refused with false, whatever was admitted, before the scope is even read', async () => {
  for (const scope of ['tenant', 'store'] as const) {
    for (const admitted of [scopeOf(platformRole('system_owner')), null, undefined, 'not a scope']) {
      assert.equal(await decide(admitted, { scope, permission: 'edit_tenant_profile' }), false, `${scope} / ${String(admitted)}`);
    }
  }
});

test('M5PZ-02 a platform requirement with no admitted platform scope is a wiring fault: a throw, never a verdict', async () => {
  const owner = scopeOf(platformRole('system_owner'));
  const cases: Array<[string, unknown]> = [
    ['null', null], ['undefined', undefined], ['a string', 'system_owner'], ['an empty object', {}],
    ['the principal instead of a scope', platformRole('system_owner')],
    ['a malformed actor', { ...owner, actor: 'nobody' }],
    ['a malformed membership', { ...owner, membershipId: 'grant-1' }],
    ['a malformed role', { ...owner, roleId: 'System Owner' }],
    ['an unknown limitation', { ...owner, limitation: 'partial' }],
    ['a platform scope naming a tenant', { ...owner, tenant: TENANT }],
    ['a tenant scope', { ...owner, scope: 'tenant', tenant: TENANT, roleId: 'store_owner' }],
    ['a store scope', { ...owner, scope: 'store', tenant: TENANT, store: STORE, roleId: 'manager' }],
  ];
  for (const [label, admitted] of cases) {
    await assert.rejects(decide(admitted), /^Error: platform authorization unavailable$/, label);
  }
  // A throwing getter is no scope either: it surfaces as a rejection the chain turns into a bounded 503.
  const trap = Object.defineProperty({ ...owner }, 'roleId', { enumerable: true, get: () => { throw new Error('getter'); } });
  await assert.rejects(decide(trap), /getter/);
});

test('M5PZ-03 the tenant-management matrix on the admitted scope: View reads, Edit renames, Manage changes status, read-only only reads', async () => {
  const row = async (roleId: string, limitation: 'none' | 'read_only' = 'none'): Promise<boolean[]> => {
    const out: boolean[] = [];
    for (const permission of TENANT_MANAGEMENT) out.push((await decide(scopeOf(platformRole(roleId, { limitation })), { scope: 'platform', permission })) !== false);
    return out;
  };
  assert.deepEqual(await row('system_owner'), [true, true, true], 'Full');
  assert.deepEqual(await row('operations_admin'), [true, true, true], 'Full');
  assert.deepEqual(await row('support_admin'), [true, true, false], 'Edit: renames, never suspends');
  assert.deepEqual(await row('billing_admin'), [true, false, false], 'View only');
  assert.deepEqual(await row('security_admin'), [true, false, false], 'View only');
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) assert.deepEqual(await row(roleId, 'read_only'), [true, false, false], `${roleId} read-only`);
  // And every cell is exactly the canonical evaluator's answer: the authorizer adds no rule of its own.
  let cells = 0;
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
    for (const limitation of ['none', 'read_only'] as const) {
      for (const permission of TENANT_MANAGEMENT) {
        const granted = (await decide(scopeOf(platformRole(roleId, { limitation })), { scope: 'platform', permission })) !== false;
        assert.equal(granted, evaluateCanonicalPermission({ scope: 'platform', roleId, permission, limitation }) === 'granted', `${roleId} ${limitation} ${permission}`);
        cells++;
      }
    }
  }
  assert.equal(cells, BUILT_IN_PLATFORM_ROLES.size * 2 * TENANT_MANAGEMENT.length);
});

test('M5PZ-04 unknown or malformed permission vocabulary denies, for every role', async () => {
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
    for (const permission of ['tenants:edit', 'tenant_management', 'Edit_Tenant_Profile', '', 'edit_tenant', 'view_tenants ', 'tenants']) {
      assert.equal(await decide(scopeOf(platformRole(roleId)), { scope: 'platform', permission }), false, `${roleId} / ${JSON.stringify(permission)}`);
    }
  }
});

test('M5PZ-05 a grant is exactly { granted: true, context }: the context equal to the admitted scope, but a frozen copy of it', async () => {
  const admitted = scopeOf(platformRole('support_admin'));
  const answer = await decide(admitted) as { granted: true; context: TrustedScope };
  assert.deepEqual(answer, { granted: true, context: { ...admitted } });
  assert.deepEqual(Reflect.ownKeys(answer), ['granted', 'context']);
  assert.notEqual(answer.context, admitted, 'a copy, not the object handed in');
  assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.context), 'frozen');
  // An unfrozen scope changed after the decision changes nothing the grant carries to the command.
  const mutable: Record<string, unknown> = { ...admitted };
  const granted = await decide(mutable) as { context: TrustedScope };
  mutable.roleId = 'billing_admin';
  mutable.actor = OTHER_ACTOR;
  assert.deepEqual(granted.context, { ...admitted });
});

test('M5PZ-06 the admitted scope is read once into a checked copy: a getter cannot pass the check as one role and decide as another', async () => {
  let reads = 0;
  const shifty = Object.defineProperty({ ...scopeOf(platformRole('billing_admin')) }, 'roleId', {
    enumerable: true, get: () => (++reads === 1 ? 'billing_admin' : 'system_owner'),
  });
  assert.equal(await decide(shifty), false, 'decided as the role it read: billing_admin holds Tenants at View');
  assert.equal(reads, 1);
});

test('M5PZ-07 the authorizer never reads the principal or the route: the admitted scope alone decides', async () => {
  const touched: string[] = [];
  const trap = (label: string): never => new Proxy({}, {
    get: (_t, key) => { touched.push(`${label}.${String(key)}`); throw new Error(`${label} read`); },
    has: (_t, key) => { touched.push(`${label} has ${String(key)}`); throw new Error(`${label} read`); },
    ownKeys: () => { touched.push(`${label} keys`); throw new Error(`${label} read`); },
    getOwnPropertyDescriptor: (_t, key) => { touched.push(`${label} descriptor ${String(key)}`); throw new Error(`${label} read`); },
    getPrototypeOf: () => { touched.push(`${label} prototype`); throw new Error(`${label} read`); },
  }) as never;
  const authorizer = createAdmittedPlatformAuthorizer();
  const owner = scopeOf(platformRole('system_owner'));
  assert.deepEqual(await authorizer.authorize(trap('principal'), EDIT, trap('route'), SIGNAL, owner), { granted: true, context: { ...owner } });
  assert.equal(await authorizer.authorize(trap('principal'), EDIT, trap('route'), SIGNAL, scopeOf(platformRole('billing_admin'))), false);
  await assert.rejects(Promise.resolve().then(() => authorizer.authorize(trap('principal'), EDIT, trap('route'), SIGNAL, null)), /platform authorization unavailable/);
  assert.deepEqual(touched, []);
});

test('M5PZ-08 System Owner is decided through the same evaluator: a View definition under its id is denied — no name shortcut', async () => {
  const owner = scopeOf(platformRole('system_owner'));
  const viewOwner = new Map([['system_owner', { levels: { tenant_management: 'view' }, moneyGrants: {} } as PlatformRoleDefinition]]);
  assert.equal(await decide(owner, EDIT, viewOwner), false);
  const fullOwner = new Map([['system_owner', { levels: { tenant_management: 'full' }, moneyGrants: {} } as PlatformRoleDefinition]]);
  assert.deepEqual(await decide(owner, EDIT, fullOwner), { granted: true, context: { ...owner } }, 'system_owner by its definition');
});

test('M5PZ-09 a custom platform role is decided by its definition: Edit granted, View denied, unknown id and malformed levels denied', async () => {
  const editor = scopeOf(platformRole('custom_tenant_editor'));
  assert.deepEqual(await decide(editor, EDIT, custom('edit')), { granted: true, context: { ...editor } }, 'custom role at Edit');
  assert.equal(await decide(editor, EDIT, custom('view')), false, 'custom role at View');
  assert.equal(await decide(scopeOf(platformRole('custom_unknown_role')), EDIT, custom('edit')), false, 'a role id no definition names');
  assert.equal(await decide(editor), false, 'a custom role under the built-in definitions only (a deployment\'s)');
  for (const level of ['EDIT', 5, 'superuser']) assert.equal(await decide(editor, EDIT, custom(level)), false, `malformed level ${String(level)}`);
});

test('M5PZ-10 the scope admission selects is the scope the authorizer decides on, for every built-in role', async () => {
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
    const admitted = await admitStanding(platformRole(roleId)) as Admitted;
    for (const permission of TENANT_MANAGEMENT) {
      const decision = await decide(admitted.context, { scope: 'platform', permission });
      const expected = evaluateCanonicalPermission({ scope: 'platform', roleId, permission, limitation: 'none' }) === 'granted';
      assert.deepEqual(decision, expected ? { granted: true, context: { ...admitted.context } } : false, `${roleId} / ${permission}`);
    }
  }
});

test('M5PZ-11 the authorizer refuses to be built with roles that are not a Map, and builds over the built-in ones by default', () => {
  for (const roles of [{}, [], { system_owner: { levels: {}, moneyGrants: {} } }, 'roles', new Set(['system_owner'])]) {
    assert.throws(() => createAdmittedPlatformAuthorizer({ roles: roles as never }), TypeError, String(roles));
  }
  for (const deps of [undefined, {}, { roles: undefined }]) {
    assert.equal(typeof createAdmittedPlatformAuthorizer(deps as never).authorize, 'function', JSON.stringify(deps) ?? 'undefined');
  }
});

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P1-R1 — the same decision, again, inside the committing transaction
// ---------------------------------------------------------------------------

/** The committing transaction's handle: the synthetic checks below never send a statement on it. */
const SQL = (() => Promise.reject(new Error('no statement: the authority check is synthetic'))) as unknown as PgTransactionScope;
/** An authority check answering `answer`, recording what it was handed. */
function authorityCheck(answer: unknown | (() => unknown)): { check: (sql: PgTransactionScope, scope: TrustedScope) => Promise<boolean>; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { calls, check: async (...args: unknown[]) => { calls.push(args); return (typeof answer === 'function' ? (answer as () => unknown)() : answer) as boolean; } };
}

/** The store key of the session presenting a command (M5-ADMIN-REVOKE-P1). */
const SESSION_KEY = 's'.repeat(43);
/** The administrative session the store holds for `SESSION_KEY`, bound to the witness `witness`. */
const heldSession = (witness: string): SessionRecord => Object.freeze({
  audience: 'admin', authProvider: PRINCIPAL.authProvider, authProviderUid: PRINCIPAL.authProviderUid, principalKey: 'k'.repeat(43),
  securityVersion: witness, authenticatedAt: 1_700_000_000_000, createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_000_000, validatedAt: 1_700_000_000_000,
});

/**
 * A revalidator over `p`'s standing: 009 answering `authority`, the held session bound to `p`'s own witness (or
 * `held`), and 013's read answering `p`'s standing (or `answer`) — each step recorded, in order, with its arguments.
 */
async function revalidatorFor(p: TrustedPrincipal, over: {
  authority?: unknown; held?: SessionRecord | undefined | null; answer?: unknown; roles?: ReadonlyMap<string, PlatformRoleDefinition>;
} = {}) {
  const steps: string[] = [];
  const calls: Record<string, unknown[][]> = { authority: [], session: [], read: [] };
  const held = over.held === null ? undefined : (over.held ?? heldSession(await witnessOf(p)));
  const record = (name: string, args: unknown[]): void => { steps.push(name); calls[name].push(args); };
  const revalidate = createPlatformContextRevalidator({
    authority: async (...args: unknown[]) => { record('authority', args); return ('authority' in over ? over.authority : true) as boolean; },
    session: async (...args: unknown[]) => { record('session', args); return held; },
    read: async (...args: unknown[]) => { record('read', args); return 'answer' in over ? over.answer : resolved(p); },
    ...(over.roles === undefined ? {} : { roles: over.roles }),
  });
  return { revalidate, steps, calls };
}

test('the transaction revalidator asks the database about exactly the scope handed out, then decides the permission on its role', async () => {
  const p = platformRole('support_admin');
  const { revalidate, calls } = await revalidatorFor(p);
  const scope = scopeOf(p);
  assert.equal(await revalidate(SQL, scope, 'edit_tenant_profile', null, SESSION_KEY), true);
  assert.equal(calls.authority.length, 1);
  assert.equal(calls.authority[0][0], SQL, 'on the committing transaction\'s own handle');
  assert.equal(calls.authority[0][1], scope, 'the scope itself — actor, version, the very grant and its role');
  assert.equal(calls.authority[0][2], null, 'a route that required no recent authentication claims no freshness');
  // A route that DID require one hands its deadline to the database half unchanged (M5-GIAM-D1-P2): the
  // revalidator must forward it, not drop it.
  const stepUp = await revalidatorFor(p);
  assert.equal(await stepUp.revalidate(SQL, scope, 'edit_tenant_profile', 1_700_000_600_000, SESSION_KEY), true);
  assert.equal(stepUp.calls.authority[0][2], 1_700_000_600_000, 'the step-up deadline reaches the database half');
  // The database confirming the grant is not enough: the role's current definition must still carry the permission.
  for (const roleId of ['billing_admin', 'security_admin']) {
    const q = platformRole(roleId);
    assert.equal(await (await revalidatorFor(q)).revalidate(SQL, scopeOf(q), 'edit_tenant_profile', null, SESSION_KEY), false, `${roleId}: Tenants at View`);
  }
  for (const permission of ['tenants:edit', 'Edit_Tenant_Profile', '', 'edit_tenant']) {
    assert.equal(await revalidate(SQL, scope, permission, null, SESSION_KEY), false, `vocabulary the catalog does not define: ${permission}`);
  }
});

test('initial authorization and transaction revalidation agree on every built-in role and every canonical platform permission', async () => {
  // Equivalent fail-closed semantics: for an unlimited actor holding one platform grant, whatever the authorizer
  // grants on the admitted scope the revalidator grants, and whatever it denies the revalidator denies — over the
  // same role definitions.
  let compared = 0;
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
    const p = platformRole(roleId);
    const { revalidate } = await revalidatorFor(p);
    for (const permission of CANONICAL_PLATFORM_PERMISSIONS.keys()) {
      const initial = (await decide(scopeOf(p), { scope: 'platform', permission })) !== false;
      assert.equal(await revalidate(SQL, scopeOf(p), permission, null, SESSION_KEY), initial, `${roleId} / ${permission}`);
      compared += 1;
    }
  }
  assert.ok(compared >= BUILT_IN_PLATFORM_ROLES.size * 10, `a real comparison (${compared} pairs)`);
});

test('a custom definition is re-decided through the same injected roles, and a changed definition is honoured at commit time', async () => {
  const p = platformRole('custom_tenant_editor');
  // The held session was admitted under the custom definitions (admission asks only that the role be defined).
  const held = heldSession((await admitStanding(p, AUTHORITY, custom('edit')) as Admitted).securityVersion);
  const at = async (level: unknown) => (await revalidatorFor(p, { held, roles: custom(level) })).revalidate;
  assert.equal(await (await at('edit'))(SQL, scopeOf(p), 'edit_tenant_profile', null, SESSION_KEY), true, 'custom role at Edit');
  assert.equal(await (await at('view'))(SQL, scopeOf(p), 'edit_tenant_profile', null, SESSION_KEY), false, 'the same grant, its definition lowered to View before the commit');
  assert.equal(await (await revalidatorFor(p, { held })).revalidate(SQL, scopeOf(p), 'edit_tenant_profile', null, SESSION_KEY), false,
    'a role id the deployment\'s definitions do not name');
});

test('the database half decides first and alone: anything but exactly true denies, and a throw propagates to the store\'s rollback', async () => {
  const p = platformRole('system_owner');
  const scope = scopeOf(p);
  for (const answer of [false, 'valid', 1, null, undefined, {}]) {
    const { revalidate, steps } = await revalidatorFor(p, { authority: answer });
    assert.equal(await revalidate(SQL, scope, 'edit_tenant_profile', null, SESSION_KEY), false, JSON.stringify(answer));
    assert.deepEqual(steps, ['authority'], `${JSON.stringify(answer)}: the session and the standing are never asked`);
  }
  const failing = createPlatformContextRevalidator({
    authority: async () => { throw new Error('db down'); }, session: async () => heldSession('x'), read: async () => resolved(p),
  });
  await assert.rejects(failing(SQL, scope, 'edit_tenant_profile', null, SESSION_KEY), /db down/);
});

test('a scope the authorizer could not have handed a command is refused before the database is asked', async () => {
  const p = platformRole('system_owner');
  const { revalidate, steps } = await revalidatorFor(p);
  const scope = scopeOf(p);
  for (const refused of [
    { ...scope, limitation: 'read_only' },
    { ...scope, scope: 'tenant', tenant: TENANT, roleId: 'manager' },
    { ...scope, scope: 'store', tenant: TENANT, store: STORE, roleId: 'technician' },
  ] as TrustedScope[]) assert.equal(await revalidate(SQL, refused, 'edit_tenant_profile', null, SESSION_KEY), false, JSON.stringify(refused));
  assert.deepEqual(steps, []);
});

test('the revalidator refuses to be built without an authority check, the session hold or the standing read, or with roles that are not a Map', () => {
  const authority = async () => true;
  const session = async () => undefined;
  const read = async () => ({ outcome: 'refused' });
  for (const deps of [
    undefined, {}, { authority: null, session, read }, { authority: 'check', session, read },
    // M5-ADMIN-REVOKE-P1: the session and the standing are required — there is no revalidation without them.
    { authority }, { authority, read }, { authority, session }, { authority, session: 'hold', read }, { authority, session, read: null },
  ]) {
    assert.throws(() => createPlatformContextRevalidator(deps as never), TypeError, JSON.stringify(deps));
  }
  for (const roles of [{}, [], 'roles']) {
    assert.throws(() => createPlatformContextRevalidator({ authority, session, read, roles: roles as never }), TypeError, JSON.stringify(roles));
  }
});

// ---------------------------------------------------------------------------
// M5-ADMIN-REVOKE-P1 — the presenting session and its standing, inside the committing transaction
// ---------------------------------------------------------------------------

test('M5AR-01 the revalidator holds the presenting session and reads its standing, in that order, after the authority, on the one handle', async () => {
  const p = platformRole('support_admin');
  const { revalidate, steps, calls } = await revalidatorFor(p);
  assert.equal(await revalidate(SQL, scopeOf(p), 'edit_tenant_profile', 1_700_000_600_000, SESSION_KEY), true);
  assert.deepEqual(steps, ['authority', 'session', 'read'], 'freshness and 009 first, then the session held, then 013 under those locks');
  assert.deepEqual(calls.session, [[SQL, SESSION_KEY]], 'the session the command carried, on the committing handle');
  assert.equal(calls.read[0][0], SQL);
  assert.deepEqual(calls.read[0][1], { authProvider: PRINCIPAL.authProvider, authProviderUid: PRINCIPAL.authProviderUid },
    'the standing of the held session\'s own provider reference — nothing from the request');
});

test('M5AR-02 no session key, or no live session under it, refuses — and nothing further is asked', async () => {
  const p = platformRole('system_owner');
  const unkeyed = await revalidatorFor(p);
  assert.equal(await unkeyed.revalidate(SQL, scopeOf(p), 'edit_tenant_profile', null, null), false, 'a command no session presented');
  assert.deepEqual(unkeyed.steps, ['authority'], 'the session is never asked about a key that is not there');
  const ended = await revalidatorFor(p, { held: null });
  assert.equal(await ended.revalidate(SQL, scopeOf(p), 'edit_tenant_profile', null, SESSION_KEY), false, 'a logout, a revocation or a rotation committed first');
  assert.deepEqual(ended.steps, ['authority', 'session'], 'the standing is never read for a session that is gone');
});

test('M5AR-03 the held session\'s standing must still admit, at the session\'s own witness, on exactly the scope handed out', async () => {
  const scope = scopeOf(BASE);
  const refuses = async (label: string, over: Parameters<typeof revalidatorFor>[1]): Promise<void> => {
    const { revalidate } = await revalidatorFor(BASE, over);
    assert.equal(await revalidate(SQL, scope, 'edit_tenant_profile', null, SESSION_KEY), false, label);
  };
  await refuses('a refused reference', { answer: { outcome: 'refused' } });
  await refuses('an account suspended since', { answer: resolved(principalWith(BASE.memberships, { accountStatus: 'suspended' })) });
  await refuses('the grant withdrawn', { answer: resolved(principalWith([])) });
  await refuses('a second grant added', { answer: resolved(principalWith([...BASE.memberships, grant()])) });
  // Each part of the witness moved — the removal-and-restoration case among them (the authority version only
  // increases), which 009's locks alone cannot see.
  const changed: Array<[string, TrustedPrincipal, string]> = [
    ['the account status', principalWith(BASE.memberships, { accountStatus: 'trialing' }), AUTHORITY],
    ['007\'s security version', principalWith(BASE.memberships, { securityVersion: 'c'.repeat(64) }), AUTHORITY],
    ['the role on the same grant', principalWith([grant({ membershipId: MEMBERSHIP, roleId: 'operations_admin' })]), AUTHORITY],
    ['the platform authority version (a grant removed and restored)', BASE, '8'],
  ];
  for (const [field, standing, authorityVersion] of changed) await refuses(`${field} moved`, { answer: resolved(standing, authorityVersion) });
  // A session bound to another standing than the command's scope: its witness holds, but it selects another grant.
  const other = principalWith([grant({ membershipId: OTHER_MEMBERSHIP, roleId: 'support_admin' })]);
  await refuses('a session whose standing selects another grant', { held: heldSession(await witnessOf(other)), answer: resolved(other) });
  // A standing the read cannot decide is an outage: a throw, which the store's kernel rolls back.
  for (const answer of [{ outcome: 'unavailable' }, null, resolved({ ...BASE, actor: 'nobody' })]) {
    const { revalidate } = await revalidatorFor(BASE, { answer });
    await assert.rejects(revalidate(SQL, scope, 'edit_tenant_profile', null, SESSION_KEY), /^Error: platform admission unavailable$/, JSON.stringify(answer));
  }
  // Positive control: unchanged, it holds.
  assert.equal(await (await revalidatorFor(BASE)).revalidate(SQL, scope, 'edit_tenant_profile', null, SESSION_KEY), true);
});

test('M5AR-04 platformStandingOf is admission\'s own decision: the same witness and scope, the same denials, the same outages', async () => {
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
    const p = platformRole(roleId);
    const admitted = await admitStanding(p) as Admitted;
    const standing = platformStandingOf(resolved(p), BUILT_IN_PLATFORM_ROLES);
    assert.ok(standing !== false);
    assert.deepEqual(standing, { witness: admitted.securityVersion, scope: admitted.context }, roleId);
    assert.ok(Object.isFrozen(standing));
  }
  for (const answer of [{ outcome: 'refused' }, resolved(principalWith([])), resolved(platformRole('system_owner', { accountStatus: 'suspended' })),
    resolved(platformRole('system_owner', { limitation: 'read_only' })), resolved(platformRole('custom_unknown_role'))]) {
    assert.equal(platformStandingOf(answer, BUILT_IN_PLATFORM_ROLES), false, JSON.stringify(answer).slice(0, 80));
  }
  assert.ok(platformStandingOf(resolved(platformRole('custom_tenant_editor')), custom('edit')) !== false, 'the roles handed in decide');
  for (const answer of [null, 'resolved', { outcome: 'unavailable' }, { outcome: 'resolved', principal: BASE }, resolved(BASE, 'x')]) {
    assert.throws(() => platformStandingOf(answer, BUILT_IN_PLATFORM_ROLES), /^Error: platform admission unavailable$/, JSON.stringify(answer));
  }
});

// ---------------------------------------------------------------------------
// M5-ADMIN-REVOKE-P1 — the administrative login's standing check, on establish's own transaction
// ---------------------------------------------------------------------------

/** An establish check whose reads answer `answers` in turn, and whose 009 lock answers `lock`; every step recorded. */
function establishCheckWith(answers: unknown[], lock: unknown = true, roles?: ReadonlyMap<string, PlatformRoleDefinition>) {
  const steps: string[] = [];
  const calls: unknown[][] = [];
  let reads = 0;
  const check = createPlatformEstablishCheck({
    read: async (...args: unknown[]) => { steps.push('read'); calls.push(args); return answers[reads++]; },
    authority: async (...args: unknown[]) => {
      steps.push('lock'); calls.push(args);
      if (typeof lock === 'function') return (lock as () => unknown)() as boolean;
      return lock as boolean;
    },
    ...(roles === undefined ? {} : { roles }),
  });
  return { check, steps, calls };
}

test('M5AR-05 the establish check reads the standing, locks its authority, and reads it again — true only when both reads are the record\'s witness', async () => {
  const record = heldSession(await witnessOf(BASE));
  const { check, steps, calls } = establishCheckWith([resolved(BASE), resolved(BASE)]);
  assert.equal(await check(SQL, record), true);
  assert.deepEqual(steps, ['read', 'lock', 'read'], '013, then 009\'s locks for the scope that read selected, then 013 again under them');
  const reference = { authProvider: PRINCIPAL.authProvider, authProviderUid: PRINCIPAL.authProviderUid };
  assert.deepEqual(calls[0], [SQL, reference], 'the record\'s own provider reference, on establish\'s handle');
  assert.equal(calls[1][0], SQL);
  assert.deepEqual(calls[1][1], scopeOf(BASE), 'the lock is taken for exactly the scope the first read selected');
  assert.deepEqual(calls[2], [SQL, reference]);
});

test('M5AR-06 a standing that moved before the locks refuses without locking; one that moved under them refuses after', async () => {
  const record = heldSession(await witnessOf(BASE));
  // Each part of the standing moved (as M5PS-09..14), or no longer admitted at all.
  const changedStandings: Array<[string, unknown]> = [
    ['the actor', resolved(principalWith(BASE.memberships, { actor: OTHER_ACTOR }))],
    ['the account status', resolved(principalWith(BASE.memberships, { accountStatus: 'trialing' }))],
    ['007\'s security version', resolved(principalWith(BASE.memberships, { securityVersion: 'c'.repeat(64) }))],
    ['the membership', resolved(principalWith([grant({ membershipId: OTHER_MEMBERSHIP, roleId: 'support_admin' })]))],
    ['the role', resolved(principalWith([grant({ membershipId: MEMBERSHIP, roleId: 'operations_admin' })]))],
    ['the authority version', resolved(BASE, '8')],
    ['a refused reference', { outcome: 'refused' }],
    ['a suspended account', resolved(principalWith(BASE.memberships, { accountStatus: 'suspended' }))],
    ['no platform grant', resolved(principalWith([]))],
  ];
  for (const [label, answer] of changedStandings) {
    const before = establishCheckWith([answer, resolved(BASE)]);
    assert.equal(await before.check(SQL, record), false, `${label}, before the locks`);
    assert.deepEqual(before.steps, ['read'], `${label}: no lock is taken for a standing that no longer matches`);
    const under = establishCheckWith([resolved(BASE), answer]);
    assert.equal(await under.check(SQL, record), false, `${label}, committed before the locks were granted`);
    assert.deepEqual(under.steps, ['read', 'lock', 'read']);
  }
  const unlocked = establishCheckWith([resolved(BASE), resolved(BASE)], false);
  assert.equal(await unlocked.check(SQL, record), false, '009 answering invalid');
  assert.deepEqual(unlocked.steps, ['read', 'lock'], 'no second read once the lock refused');
});

test('M5AR-07 a fault anywhere in the establish check THROWS — never false, which would read as a changed standing and answer 401', async () => {
  const record = heldSession(await witnessOf(BASE));
  for (const [label, answers] of [
    ['a first read that is no standing', [{ outcome: 'unavailable' }, resolved(BASE)]],
    ['a second read that is no standing', [resolved(BASE), { outcome: 'unavailable' }]],
    ['a malformed principal', [resolved({ ...BASE, actor: 'nobody' }), resolved(BASE)]],
  ] as Array<[string, unknown[]]>) {
    await assert.rejects(establishCheckWith(answers).check(SQL, record), /^Error: platform admission unavailable$/, label);
  }
  const fault = new Error('lock timeout');
  await assert.rejects(establishCheckWith([resolved(BASE), resolved(BASE)], () => Promise.reject(fault)).check(SQL, record), (err: unknown) => err === fault,
    'the lock\'s own fault propagates');
  const readFault = new Error('driver error');
  const failing = createPlatformEstablishCheck({ read: async () => { throw readFault; }, authority: async () => true });
  await assert.rejects(failing(SQL, record), (err: unknown) => err === readFault, 'the read\'s own fault propagates');
});

test('M5AR-08 the establish check decides over the roles handed in, and refuses to be built without its read and lock', async () => {
  const p = platformRole('custom_tenant_editor');
  const record = heldSession((await admitStanding(p, AUTHORITY, custom('edit')) as Admitted).securityVersion);
  assert.equal(await establishCheckWith([resolved(p), resolved(p)], true, custom('edit')).check(SQL, record), true);
  assert.equal(await establishCheckWith([resolved(p), resolved(p)]).check(SQL, record), false, 'a role the deployment\'s definitions do not name');
  const read = async () => ({ outcome: 'refused' });
  const authority = async () => true;
  for (const deps of [undefined, {}, { read }, { authority }, { read: 'read', authority }, { read, authority: null }]) {
    assert.throws(() => createPlatformEstablishCheck(deps as never), TypeError, JSON.stringify(deps));
  }
  for (const roles of [{}, [], 'roles']) {
    assert.throws(() => createPlatformEstablishCheck({ read, authority, roles: roles as never }), TypeError, JSON.stringify(roles));
  }
});

// --- M5-GIAM-D1-P3: the permits the tenant directory presents its `actions` from ----------------------------------------

const platformScopeOf = (principal: TrustedPrincipal): TrustedScope => {
  const selection = selectScope(principal, 'platform', { tenant: null, store: null });
  assert.equal(selection.outcome, 'selected');
  return (selection as { scope: TrustedScope }).scope;
};

test('createPlatformPermits answers exactly what the authorizer decides — every built-in role, both limitations, the three tenant-management keys', async () => {
  const permits = createPlatformPermits();
  let n = 0;
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) {
    for (const limitation of ['none', 'read_only'] as const) {
      for (const permission of TENANT_MANAGEMENT) {
        const scope = platformScopeOf(platformRole(roleId, { limitation }));
        const decided = await decide(scope, { scope: 'platform', permission });
        assert.equal(permits(scope, permission), decided !== false, `${roleId} ${limitation} ${permission}`);
        n++;
      }
    }
  }
  assert.equal(n, BUILT_IN_PLATFORM_ROLES.size * 2 * 3);
});

test('the tenant-management matrix, stated outright: View reads, Edit renames, Manage changes status, and a read-only actor only reads', () => {
  const permits = createPlatformPermits();
  const row = (roleId: string, limitation: 'none' | 'read_only' = 'none') =>
    TENANT_MANAGEMENT.map((permission) => permits(platformScopeOf(platformRole(roleId, { limitation })), permission));
  assert.deepEqual(row('system_owner'), [true, true, true], 'Full');
  assert.deepEqual(row('operations_admin'), [true, true, true], 'Full');
  assert.deepEqual(row('support_admin'), [true, true, false], 'Edit: renames, never suspends');
  assert.deepEqual(row('billing_admin'), [true, false, false], 'View only');
  assert.deepEqual(row('security_admin'), [true, false, false], 'View only');
  for (const roleId of BUILT_IN_PLATFORM_ROLES.keys()) assert.deepEqual(row(roleId, 'read_only'), [true, false, false], `${roleId} read-only`);
});

test('permits hold nothing outside a well-formed platform scope, and read a role only through the definitions it was given', () => {
  const permits = createPlatformPermits();
  const owner = platformScopeOf(platformRole('system_owner'));
  assert.equal(permits({ ...owner, scope: 'tenant', tenant: TENANT }, 'view_tenants'), false, 'a tenant scope');
  assert.equal(permits({ ...owner, scope: 'store', tenant: TENANT, store: STORE }, 'view_tenants'), false, 'a store scope');
  assert.equal(permits({ ...owner, actor: 'nobody' }, 'view_tenants'), false, 'a malformed scope');
  assert.equal(permits(null as never, 'view_tenants'), false, 'no scope');
  for (const permission of ['View_Tenants', 'tenant_management', 'view_tenant', '', 'change_tenant_status ']) {
    assert.equal(permits(owner, permission), false, `not a canonical key: ${JSON.stringify(permission)}`);
  }
  const custom: ReadonlyMap<string, PlatformRoleDefinition> = new Map([
    ['support_admin', { levels: { tenant_management: 'manage' }, moneyGrants: {} }],
  ]);
  const support = platformScopeOf(platformRole('support_admin'));
  assert.equal(createPlatformPermits({ roles: custom })(support, 'change_tenant_status'), true, 'the injected definition decides');
  assert.equal(createPlatformPermits()(support, 'change_tenant_status'), false, 'the built-in definition decides otherwise');
  for (const roles of [{}, [], 'roles']) assert.throws(() => createPlatformPermits({ roles: roles as never }), TypeError, JSON.stringify(roles));
});
