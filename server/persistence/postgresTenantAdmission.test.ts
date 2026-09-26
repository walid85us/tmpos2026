// Phase 4.0 M5-GIAM-D1-P2-R1 — the PostgreSQL tenant admission: the witness it derives, and what it
// refuses to derive one from. DATABASE-FREE; migration 011's routine is proved against a real cluster
// (tests/db/tenantAdmission.integration.test.mjs).
//
// THE PROPERTY THIS SUITE EXISTS FOR (DA-32). The witness must move whenever the actor's standing
// moves, and must NOT move when something irrelevant does. Suspension alone is not enough: 007's
// resolver already hides a suspended tenant's grant, so the answer after a suspend-and-reactivate
// would be byte-identical to the answer before it — and an idle session would be revived. The tenant's
// access version, which never returns to a value it has held, is what closes that, and the test below
// pins exactly that difference. M5-TENANT-SESSION-P1 (migration 016) adds the store's access version and
// the actor's two grant counters, for the same reason, and the two reads a tenant login runs on its own
// store transaction (readTenantAdmission, holdTenantStanding).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPostgresTenantAdmission, holdTenantStanding, readTenantAdmission, TENANT_ADMISSION_BOUNDS, TENANT_ADMISSION_DEADLINE_MS,
} from './postgresTenantAdmission.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import type { VerifiedPrincipal } from '../runtime/routes.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const STORE = '33333333-3333-4333-8333-333333333333';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const VERSION = 'a'.repeat(64);
const PRINCIPAL: VerifiedPrincipal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-alpha' });

/** One grant as the routine renders it: 007's seven fields plus the tenant's and the store's access versions. */
const membership = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  membershipId: MEMBERSHIP, scopeType: 'tenant', tenantId: TENANT, storeId: null, roleId: 'store_owner',
  tenantStatus: 'active', storeStatus: null, tenantAccessVersion: '1', storeAccessVersion: null, ...over,
});
/** A store grant under TENANT: the store's access version rides beside the tenant's. */
const storeGrant = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  membership({ scopeType: 'store', storeId: STORE, storeStatus: 'active', storeAccessVersion: '1', ...over });

const row = (memberships: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  outcome: 'resolved', actor_id: ACTOR, account_status: 'active', limitation: 'none',
  security_version: VERSION, memberships, authority_version: '0', grant_version: '1', ...over,
});

const REFUSED_ROW = Object.freeze({
  outcome: 'refused', actor_id: null, account_status: null, limitation: null, security_version: null, memberships: null,
  authority_version: null, grant_version: null,
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
  assert.match(witness, /^t2:[A-Za-z0-9_-]{43}$/, 'prefixed, so an earlier or later derivation is never mistaken for this one');
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
    ['the same grant at store scope', [row([storeGrant()])]],
    // Each of the four below moves EXACTLY ONE field, so dropping that field from the digest would be
    // caught here. Without them, a digest that omitted the tenant id would still pass every row above
    // — and a grant moved from one tenant to another at the same access version would digest
    // identically, so the live session would never be re-admitted against its new tenant.
    ['a different membership id alone', [row([membership({ membershipId: '88888888-8888-4888-8888-888888888888' })])]],
    ['a different tenant alone', [row([membership({ tenantId: '99999999-9999-4999-8999-999999999999' })])]],
    // Differs from the store-scope row above in its STORE alone.
    ['a different store alone', [row([storeGrant({ storeId: '12345678-1234-4123-8123-123456789abc' })])]],
    ['a different store status alone', [row([storeGrant({ storeStatus: 'read_only' })])]],
    // M5-TENANT-SESSION-P1 (016; doc 08 DA-41): each of these moves exactly one field too, and each only increases, so
    // a store reactivated, a grant removed and restored, or an anchor moved and moved back never digests as before.
    ['a moved store access version alone', [row([storeGrant({ storeAccessVersion: '3' })])]],
    ['a moved grant version alone', [row([membership()], { grant_version: '2' })]],
    ['a moved platform authority version alone', [row([membership()], { authority_version: '1' })]],
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
  // The refusal row is one fixed row: a counter on it is not the routine's answer, and an outage.
  assert.deepEqual(await admit([{ ...REFUSED_ROW, grant_version: '1' }]), { outcome: 'unavailable' }, 'a refusal carrying a counter');
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
    // The same rule for a store grant and its store (016).
    ['a store grant with no store access version', [row([storeGrant({ storeAccessVersion: null })])]],
    ['a store access version that is not decimal text', [row([storeGrant({ storeAccessVersion: '1e3' })])]],
    ['a store access version past bigint width', [row([storeGrant({ storeAccessVersion: '1'.repeat(20) })])]],
    ['a store access version on a grant that names no store', [row([membership({ storeAccessVersion: '1' })])]],
    ['a grant with no store access version key at all', [row([{ ...membership(), storeAccessVersion: undefined }])]],
  ];
  for (const [label, rows] of missing) {
    assert.deepEqual(await admit(rows), { outcome: 'unavailable' }, label);
  }
});

test('M5T-TA1 v2\'s two counters are decimal text on a resolved row, and anything else there is an outage', async () => {
  const bad: [string, unknown][] = [
    ['no grant version', [row([membership()], { grant_version: null })]],
    ['no authority version', [row([membership()], { authority_version: null })]],
    ['a counter that is a number', [row([membership()], { grant_version: 1 })]],
    ['a counter that is not decimal text', [row([membership()], { authority_version: '-1' })]],
    ['a counter past bigint width', [row([membership()], { grant_version: '1'.repeat(20) })]],
    ['a row without the counters (011\'s shape)', [{ outcome: 'resolved', actor_id: ACTOR, account_status: 'active', limitation: 'none', security_version: VERSION, memberships: [membership()] }]],
  ];
  for (const [label, rows] of bad) assert.deepEqual(await admit(rows), { outcome: 'unavailable' }, label);
  // Zero is a counter: an actor no trigger has moved yet (016 answers 0 for one with no row).
  assert.equal((await admit([row([membership()], { authority_version: '0', grant_version: '0' })]) as { outcome: string }).outcome, 'admitted');
  // The read is 016's v2, with both counters named.
  const { client } = admissionOver([row([membership()])]);
  await createPostgresTenantAdmission({ client }).admit(PRINCIPAL, live());
  assert.match(client.statements[0], /tmpos_session\.m5_admit_tenant_session_v2\(/);
  assert.match(client.statements[0], /authority_version, grant_version/);
});

test('M5T-TA4 a refusal row carrying any value is an outage: the boundary answers a refusal by ending every session', async () => {
  const values: Record<string, unknown> = {
    actor_id: ACTOR, account_status: 'active', limitation: 'none', security_version: VERSION, memberships: [],
    authority_version: '0', grant_version: '1',
  };
  for (const [column, value] of Object.entries(values)) {
    assert.deepEqual(await admit([{ ...REFUSED_ROW, [column]: value }]), { outcome: 'unavailable' }, `a refusal carrying ${column}`);
    await assert.rejects(readTenantAdmission(handle([{ ...REFUSED_ROW, [column]: value }]).sql, PRINCIPAL),
      /^Error: tenant admission unavailable$/, `readTenantAdmission: a refusal carrying ${column}`);
  }
});

test('M5T-TA5 every version is canonical decimal inside its CHECK bound, and anything else is an outage', async () => {
  // 010's and 016's CHECKs bound an access version to 1..2^53-1; 013's and 016's bound a stored counter the same way,
  // and 016 answers 0 for an actor with no counter row. No text the routine renders has a sign, a space or a leading zero.
  const noncanonical = ['01', '9007199254740992', '9223372036854775807', '', ' 1', '1 ', '+1', '00'];
  const bad: [string, unknown][] = [];
  for (const v of ['0', ...noncanonical]) {
    bad.push([`tenant access version ${JSON.stringify(v)}`, [row([membership({ tenantAccessVersion: v })])]]);
    bad.push([`store access version ${JSON.stringify(v)}`, [row([storeGrant({ storeAccessVersion: v })])]]);
  }
  for (const v of noncanonical) {
    bad.push([`authority version ${JSON.stringify(v)}`, [row([membership()], { authority_version: v })]]);
    bad.push([`grant version ${JSON.stringify(v)}`, [row([membership()], { grant_version: v })]]);
  }
  for (const [label, rows] of bad) assert.deepEqual(await admit(rows), { outcome: 'unavailable' }, label);
  // The bounds themselves are the routine's answers, and admitted.
  const good: [string, unknown][] = [];
  for (const v of ['1', '9007199254740991']) {
    good.push([`tenant access version ${v}`, [row([membership({ tenantAccessVersion: v })])]]);
    good.push([`store access version ${v}`, [row([storeGrant({ storeAccessVersion: v })])]]);
  }
  for (const v of ['0', '9007199254740991']) {
    good.push([`authority version ${v}`, [row([membership()], { authority_version: v })]]);
    good.push([`grant version ${v}`, [row([membership()], { grant_version: v })]]);
  }
  for (const [label, rows] of good) assert.equal((await admit(rows) as { outcome: string }).outcome, 'admitted', label);
});

/** A caller's transaction handle answering `answer` (or rejecting with `fault`), recording what it was sent. */
function handle(answer: unknown, fault?: Error) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    return fault ? Promise.reject(fault) : Promise.resolve(answer as never);
  }) as unknown as PgTransactionScope;
  return { sql, statements, values };
}

test('M5T-TA2 readTenantAdmission is admit\'s decision on the CALLER\'s transaction: faults and malformed answers throw, never answer', async () => {
  const admitted = handle([row([membership()])]);
  const answer = await readTenantAdmission(admitted.sql, PRINCIPAL) as { outcome: string; securityVersion: string; principal: { actor: string } };
  assert.equal(answer.outcome, 'admitted');
  assert.equal(answer.principal.actor, ACTOR, 'the admitted answer exposes the actor');
  assert.equal(answer.securityVersion, await witnessOf([row([membership()])]), 'exactly the witness admit derives');
  assert.deepEqual(admitted.values, [['firebase', 'uid-alpha']], 'the reference, bound');
  assert.match(admitted.statements[0], /m5_admit_tenant_session_v2\(/);
  assert.deepEqual(await readTenantAdmission(handle([REFUSED_ROW]).sql, PRINCIPAL), { outcome: 'refused' });
  assert.deepEqual(await readTenantAdmission(handle([row([])]).sql, PRINCIPAL), { outcome: 'refused' }, 'no tenant or store grant');
  const unsent = handle([row([membership()])]);
  assert.deepEqual(await readTenantAdmission(unsent.sql, { authProvider: 'okta', authProviderUid: 'uid-alpha' }), { outcome: 'refused' });
  assert.deepEqual(unsent.statements, [], 'a reference this adapter cannot admit is refused before a statement');
  for (const [label, rows] of [['no row', []], ['a malformed grant', [row(['x'])]], ['an unknown outcome', [row([membership()], { outcome: 'pending' })]],
    ['a counter missing', [row([membership()], { grant_version: null })]]] as Array<[string, unknown]>) {
    await assert.rejects(readTenantAdmission(handle(rows).sql, PRINCIPAL), /^Error: tenant admission unavailable$/, label);
  }
  const fault = new Error('lock timeout on db.example:5432');
  await assert.rejects(readTenantAdmission(handle(null, fault).sql, PRINCIPAL), (err: unknown) => err === fault, 'a driver error propagates as it is');
});

test('M5T-TA3 holdTenantStanding: held is true, absent is false, and any other answer or a fault throws', async () => {
  const held = handle([{ outcome: 'held' }]);
  assert.equal(await holdTenantStanding(held.sql, PRINCIPAL), true);
  assert.match(held.statements[0], /tmpos_session\.m5_hold_tenant_standing\(\?::text, \?::text\) as outcome/);
  assert.deepEqual(held.values, [['firebase', 'uid-alpha']], 'the reference, bound');
  assert.equal(await holdTenantStanding(handle([{ outcome: 'absent' }]).sql, PRINCIPAL), false);
  for (const rows of [[], [{ outcome: 'HELD' }], [{ outcome: null }], [{ outcome: 'held' }, { outcome: 'held' }], [{ outcome: 'held', extra: 1 }], 'held']) {
    await assert.rejects(holdTenantStanding(handle(rows).sql, PRINCIPAL), /tenant standing unavailable/, JSON.stringify(rows));
  }
  const fault = new Error('deadlock detected');
  await assert.rejects(holdTenantStanding(handle(null, fault).sql, PRINCIPAL), (err: unknown) => err === fault);
});

test('M5T-TA3b holdTenantStanding refuses a reference admit and readTenantAdmission refuse, as false and before a statement', async () => {
  // false, as those two refuse it: the establish check then refuses the login, and nothing is written.
  for (const principal of [null, 'firebase', { authProvider: 'okta', authProviderUid: 'uid-alpha' }, { authProvider: 'firebase', authProviderUid: '' },
    { authProvider: 'firebase', authProviderUid: 'u'.repeat(256) }, { authProvider: 'firebase', authProviderUid: 7 }]) {
    const unsent = handle([{ outcome: 'held' }]);
    assert.equal(await holdTenantStanding(unsent.sql, principal as never), false, JSON.stringify(principal));
    assert.deepEqual(await readTenantAdmission(unsent.sql, principal as never), { outcome: 'refused' }, JSON.stringify(principal));
    assert.deepEqual(unsent.statements, [], 'nothing sent');
  }
  const widest = handle([{ outcome: 'held' }]);
  assert.equal(await holdTenantStanding(widest.sql, { authProvider: 'supabase', authProviderUid: 'u'.repeat(255) }), true);
  assert.deepEqual(widest.values, [['supabase', 'u'.repeat(255)]], 'the widest reference is still sent, bound');
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
  assert.equal(client.statements[0].includes('m5_admit_tenant_session_v2('), true, 'the real read the adapter makes, not a ping');
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
