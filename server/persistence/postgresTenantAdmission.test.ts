// Phase 4.0 M5-GIAM-D1-P2-R1 — the PostgreSQL tenant admission: the witness it derives, and what it
// refuses to derive one from. DATABASE-FREE; migration 011's routine is proved against a real cluster
// (tests/db/tenantAdmission.integration.test.mjs).
//
// THE PROPERTY THIS SUITE EXISTS FOR (DA-32). The witness must move whenever the actor's standing
// moves, and must NOT move when something irrelevant does. Suspension alone is not enough: 007's
// resolver already hides a suspended tenant's grant, so the answer after a suspend-and-reactivate
// would be byte-identical to the answer before it — and an idle session would be revived. The tenant's
// access version, which never returns to a value it has held, is what closes that, and the test below
// pins exactly that difference.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresTenantAdmission, TENANT_ADMISSION_BOUNDS, TENANT_ADMISSION_DEADLINE_MS } from './postgresTenantAdmission.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import type { VerifiedPrincipal } from '../runtime/routes.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const STORE = '33333333-3333-4333-8333-333333333333';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const VERSION = 'a'.repeat(64);
const PRINCIPAL: VerifiedPrincipal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-alpha' });

/** One grant as the routine renders it: 007's seven fields plus the tenant's access version. */
const membership = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  membershipId: MEMBERSHIP, scopeType: 'tenant', tenantId: TENANT, storeId: null, roleId: 'store_owner',
  tenantStatus: 'active', storeStatus: null, tenantAccessVersion: '1', ...over,
});

const row = (memberships: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  outcome: 'resolved', actor_id: ACTOR, account_status: 'active', limitation: 'none',
  security_version: VERSION, memberships, ...over,
});

const REFUSED_ROW = Object.freeze({
  outcome: 'refused', actor_id: null, account_status: null, limitation: null, security_version: null, memberships: null,
});

interface Fake extends SupervisedPgClient {
  readonly statements: string[];
  readonly values: unknown[][];
  readonly bounds: unknown[];
}

function fakeClient(rows: unknown, fault?: Error): Fake {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const bounds: unknown[] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    return fault ? Promise.reject(fault) : Promise.resolve(rows as never);
  }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements, values, bounds,
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      bounds.push(b);
      void signal;
      return work(sql);
    }) as never,
    end: async () => undefined,
  }) as never;
}

const live = (): AbortSignal => new AbortController().signal;
const admissionOver = (rows: unknown, fault?: Error) => {
  const client = fakeClient(rows, fault);
  return { client, admission: createPostgresTenantAdmission({ client }) };
};
const admit = async (rows: unknown, fault?: Error) => admissionOver(rows, fault).admission.admit(PRINCIPAL, live());
const witnessOf = async (rows: unknown): Promise<string> => {
  const answer = await admit(rows) as { outcome: string; securityVersion?: string };
  assert.equal(answer.outcome, 'admitted', JSON.stringify(answer));
  return answer.securityVersion as string;
};

// --- the admitted answer ------------------------------------------------------------------------

test('a resolved actor with a tenant grant is admitted, and no provider reference comes back with it', async () => {
  const { client, admission } = admissionOver([row([membership()])]);
  const answer = await admission.admit(PRINCIPAL, live()) as Record<string, unknown>;
  assert.equal(answer.outcome, 'admitted');
  assert.deepEqual(answer.principal, {
    actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: VERSION,
    memberships: [{
      membershipId: MEMBERSHIP, scopeType: 'tenant', tenant: TENANT, store: null,
      roleId: 'store_owner', tenantStatus: 'active', storeStatus: null,
    }],
  }, 'the port\'s own shape: the access version is digested, never handed on');
  assert.equal(JSON.stringify(answer).includes('uid-alpha'), false, 'no provider reference crosses the port');
  assert.equal(client.statements.join('').includes('uid-alpha'), false, 'the reference is a bound parameter');
  assert.equal(client.statements.length, 1, 'one statement, one round trip');
  assert.deepEqual(client.bounds, [TENANT_ADMISSION_BOUNDS]);
});

test('the witness is bounded printable ASCII, so the session boundary can carry it as a version', async () => {
  const witness = await witnessOf([row([membership()])]);
  assert.match(witness, /^t1:[A-Za-z0-9_-]+$/, 'prefixed, so a later derivation is never mistaken for this one');
  assert.ok(witness.length >= 1 && witness.length <= 128, `length ${witness.length} is within the boundary's bound`);
  assert.match(witness, /^[\x21-\x7e]{1,128}$/, 'the same shape sessions.ts VERSION_RE admits');
});

// --- DA-32: what moves the witness, and what must not -----------------------------------------------

// The end-to-end proof — that a suspension really moves the version and 007 really hides the grant —
// is the integration suite's (tests/db/tenantAdmission.integration.test.mjs M5A-04, M5A-04b). What is
// established HERE is narrower and still necessary: that the digest DEPENDS on the access version, so
// a version that moved cannot produce the answer it produced before it moved.
test('the witness depends on the tenant access version, so a moved version cannot reproduce the old answer', async () => {
  // Before: the grant is visible and its tenant is at access version 1.
  const before = await witnessOf([row([membership({ tenantAccessVersion: '1' })])]);
  // Suspended: 007's resolver hides the grant entirely, so the actor holds nothing here at all.
  assert.deepEqual(await admit([row([])]), { outcome: 'refused' }, 'a suspended tenant leaves no tenant grant, so no session may be held');
  // Reactivated: the SAME grant, the SAME status, the SAME security version — only the access version
  // has moved, twice. Without it this answer would be byte-identical to `before` and an idle session
  // would be revived by the reactivation.
  const after = await witnessOf([row([membership({ tenantAccessVersion: '3' })])]);
  assert.notEqual(after, before, 'the access version is what makes reactivation visible to the session boundary');
  // And an unchanged standing digests unchanged: a re-read is not a reason to end anyone's session.
  assert.equal(await witnessOf([row([membership({ tenantAccessVersion: '1' })])]), before);
});

test('every field of the standing moves the witness, and no two of these standings digest alike', async () => {
  const base = await witnessOf([row([membership()])]);
  const moved: [string, unknown][] = [
    ['a different actor', [row([membership()], { actor_id: '99999999-9999-4999-8999-999999999999' })]],
    ['a different account status', [row([membership()], { account_status: 'read_only' })]],
    ['a narrowed account', [row([membership()], { limitation: 'read_only' })]],
    ['a moved security version', [row([membership()], { security_version: 'b'.repeat(64) })]],
    ['a different role', [row([membership({ roleId: 'technician' })])]],
    ['a read-only tenant', [row([membership({ tenantStatus: 'read_only' })])]],
    ['a second grant', [row([membership(), membership({ membershipId: '66666666-6666-4666-8666-666666666666', tenantId: '77777777-7777-4777-8777-777777777777' })])]],
    ['the same grant at store scope', [row([membership({ scopeType: 'store', storeId: STORE, storeStatus: 'active' })])]],
    // Each of the four below moves EXACTLY ONE field, so dropping that field from the digest would be
    // caught here. Without them, a digest that omitted the tenant id would still pass every row above
    // — and a grant moved from one tenant to another at the same access version would digest
    // identically, so the live session would never be re-admitted against its new tenant.
    ['a different membership id alone', [row([membership({ membershipId: '88888888-8888-4888-8888-888888888888' })])]],
    ['a different tenant alone', [row([membership({ tenantId: '99999999-9999-4999-8999-999999999999' })])]],
    // Differs from the store-scope row above in its STORE alone.
    ['a different store alone', [row([membership({ scopeType: 'store', storeId: '12345678-1234-4123-8123-123456789abc', storeStatus: 'active' })])]],
    ['a different store status alone', [row([membership({ scopeType: 'store', storeId: STORE, storeStatus: 'read_only' })])]],
  ];
  const seen = new Set([base]);
  for (const [label, rows] of moved) {
    const witness = await witnessOf(rows);
    assert.equal(seen.has(witness), false, `${label}: moves the witness`);
    seen.add(witness);
  }
});

// --- refusals ------------------------------------------------------------------------------------

test('a refusal is the routine\'s own, and an actor with no tenant or store grant is refused rather than admitted', async () => {
  assert.deepEqual(await admit([REFUSED_ROW]), { outcome: 'refused' }, 'the routine refused');
  assert.deepEqual(await admit([row([])]), { outcome: 'refused' }, 'no grant at all');
  const platformOnly = membership({ scopeType: 'platform', tenantId: null, storeId: null, tenantStatus: null, roleId: 'system_owner', tenantAccessVersion: null });
  assert.deepEqual(await admit([row([platformOnly])]), { outcome: 'refused' }, 'a platform grant is not a tenant session');
});

test('a reference this boundary cannot admit is refused before a statement runs', async () => {
  const bad: [string, unknown][] = [
    ['not an object', 'uid-alpha'],
    ['null', null],
    ['an unknown provider', { authProvider: 'okta', authProviderUid: 'uid-alpha' }],
    ['no provider', { authProviderUid: 'uid-alpha' }],
    ['an empty reference', { authProvider: 'firebase', authProviderUid: '' }],
    ['a reference past the routine\'s bound', { authProvider: 'firebase', authProviderUid: 'u'.repeat(256) }],
  ];
  for (const [label, principal] of bad) {
    const { client, admission } = admissionOver([row([membership()])]);
    assert.deepEqual(await admission.admit(principal as VerifiedPrincipal, live()), { outcome: 'refused' }, label);
    assert.deepEqual(client.statements, [], `${label}: costs the database nothing`);
  }
  // Both providers 002's audit CHECK admits are read.
  for (const authProvider of ['firebase', 'supabase']) {
    const answer = await admissionOver([row([membership()])]).admission.admit({ authProvider, authProviderUid: 'uid-alpha' }, live());
    assert.equal((answer as { outcome: string }).outcome, 'admitted', authProvider);
  }
});

// --- outages -------------------------------------------------------------------------------------

test('an answer the adapter does not recognise is UNAVAILABLE — never a refusal, which would revoke every session', async () => {
  const faults: [string, unknown][] = [
    ['no row', []],
    ['two rows', [row([membership()]), row([membership()])]],
    ['a missing column', [{ ...row([membership()]), memberships: undefined }]],
    ['an extra column', [{ ...row([membership()]), extra: 1 }]],
    ['an outcome that is neither', [row([membership()], { outcome: 'pending' })]],
    ['memberships that are not an array', [row('one')]],
    ['a grant that is not an object', [row(['x'])]],
    ['a grant missing a field', [row([{ ...membership(), tenantStatus: undefined }])]],
    ['a grant with an extra field', [row([{ ...membership(), extra: 1 }])]],
    ['a scope the runtime does not know', [row([membership({ scopeType: 'region' })])]],
    ['an actor that is not a uuid', [row([membership()], { actor_id: 'actor-1' })]],
    ['a security version with a space', [row([membership()], { security_version: 'a b' })]],
    ['two grants sharing one id', [row([membership(), membership({ tenantId: STORE })])]],
  ];
  for (const [label, rows] of faults) {
    assert.deepEqual(await admit(rows), { outcome: 'unavailable' }, label);
  }
});

test('a tenant grant with no access version is an outage: a grant no version could revoke is not admitted', async () => {
  const missing: [string, unknown][] = [
    ['null where a version belongs', [row([membership({ tenantAccessVersion: null })])]],
    ['a version that is not decimal text', [row([membership({ tenantAccessVersion: '1e3' })])]],
    ['an empty version', [row([membership({ tenantAccessVersion: '' })])]],
    ['a version past bigint width', [row([membership({ tenantAccessVersion: '1'.repeat(20) })])]],
    ['a number rather than the routine\'s text', [row([membership({ tenantAccessVersion: 1 })])]],
    ['a version on a grant that names no tenant', [row([membership({ scopeType: 'platform', tenantId: null, tenantStatus: null, roleId: 'system_owner' })])]],
  ];
  for (const [label, rows] of missing) {
    assert.deepEqual(await admit(rows), { outcome: 'unavailable' }, label);
  }
});

test('a driver fault, an abort and an overrun are outages that disclose nothing', async () => {
  const fault = Object.assign(new Error('connection to db.example:5432 refused'), { code: '08006' });
  assert.deepEqual(await admit(null, fault), { outcome: 'unavailable' });
  const controller = new AbortController();
  controller.abort();
  const { client, admission } = admissionOver([row([membership()])]);
  assert.deepEqual(await admission.admit(PRINCIPAL, controller.signal), { outcome: 'unavailable' });
  assert.deepEqual(client.statements, [], 'an expired deadline never reaches the database');
});

// --- readiness ------------------------------------------------------------------------------------

test('readiness runs the real admission read and reports ready only on one of its two closed answers', async () => {
  const { client, admission } = admissionOver([{ outcome: 'refused' }]);
  assert.equal(await admission.probe?.(live()), true);
  assert.equal(client.statements.length, 1);
  assert.equal(client.statements[0].includes('m5_admit_tenant_session'), true, 'the real read, not a ping');
  // The probe's provider is a literal in the statement; only its reference is bound.
  assert.equal(client.statements[0].includes("'firebase'"), true);
  const [uid] = client.values[0] as [string];
  assert.ok(uid.length > 0 && uid.length <= 255, 'a syntactically valid reference, so no guard short-circuits the read');
  // Were the reference ever registered, the routine would answer `resolved`: closed and well formed, so ready.
  assert.equal(await admissionOver([{ outcome: 'resolved' }]).admission.probe?.(live()), true);
  // No row, several rows, an unknown outcome, or an answer of any other shape is NOT ready.
  for (const rows of [[], [{ outcome: 'admitted' }], [{ outcome: null }], [{ outcome: 'refused' }, { outcome: 'refused' }], [{ outcome: 'refused', extra: 1 }]]) {
    assert.equal(await admissionOver(rows).admission.probe?.(live()), false, JSON.stringify(rows));
  }
  assert.equal(await admissionOver(null, new Error('down')).admission.probe?.(live()), false);
});

test('every read runs under the adapter\'s own bounds, below its port deadline', () => {
  for (const value of Object.values(TENANT_ADMISSION_BOUNDS)) {
    const ms = Number(String(value).replace('ms', ''));
    assert.ok(Number.isInteger(ms) && ms > 0, `${String(value)} is a positive millisecond bound`);
  }
  assert.ok(Number(String(TENANT_ADMISSION_BOUNDS.statement).replace('ms', '')) < TENANT_ADMISSION_DEADLINE_MS);
});
