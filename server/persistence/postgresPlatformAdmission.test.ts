// Phase 4.0 M5-GIAM-D1-P4 — the PostgreSQL platform admission: what it reports for migration 013's one read,
// and everything it refuses to report as a standing. DATABASE-FREE; the routine itself is proved against a real
// cluster by the integration suite.
//
// THE PROPERTY THIS SUITE EXISTS FOR. The adapter decides nothing, so its whole job is to be exact about what it
// passes on. A reference it cannot read is `refused` before the database is asked; a row the routine did not
// answer in exactly its declared shape is `unavailable`, never `refused` — the boundary acts on a refusal by
// ending every administrative session that principal holds, so an outage must never look like one — and never
// `resolved`, which would hand the composition a standing nobody vouched for. Between those two, `resolved`
// carries the principal (its memberships the platform grants alone, frozen, in the port's own shape) and the
// authority version as the routine rendered it. Nothing is logged and no provider reference comes back.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPostgresPlatformAdmission, PLATFORM_ADMISSION_BOUNDS, PLATFORM_ADMISSION_DEADLINE_MS, readPlatformAdmission,
} from './postgresPlatformAdmission.js';
import { TransactionFailure } from './supervisedPgClient.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import type { VerifiedPrincipal } from '../runtime/routes.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const STORE = '33333333-3333-4333-8333-333333333333';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const SECOND = '66666666-6666-4666-8666-666666666666';
const VERSION = 'a'.repeat(64);
const PRINCIPAL: VerifiedPrincipal = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-alpha' });

/** One platform grant as migration 013 renders it: 007's seven keys, every tenant/store field null. */
const grant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  membershipId: MEMBERSHIP, scopeType: 'platform', tenantId: null, storeId: null, roleId: 'system_owner',
  tenantStatus: null, storeStatus: null, ...over,
});

/** The routine's resolved row: seven columns, the authority version as decimal text. */
const row = (memberships: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  outcome: 'resolved', actor_id: ACTOR, account_status: 'active', limitation: 'none',
  security_version: VERSION, memberships, authority_version: '7', ...over,
});

/** The routine's refusal: the same seven columns, every one but the outcome null. */
const REFUSED_ROW = Object.freeze({
  outcome: 'refused', actor_id: null, account_status: null, limitation: null, security_version: null,
  memberships: null, authority_version: null,
});

/** `value` with `key` absent — not present-and-undefined, which is a different fault. */
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

interface Fake extends SupervisedPgClient {
  readonly statements: string[];
  readonly values: unknown[][];
  readonly bounds: unknown[];
  readonly signals: AbortSignal[];
}

/**
 * A client that answers every statement with `rows` (or rejects it with `fault`), recording each statement's text,
 * its bound values, and the bounds and signal each transaction was opened with. `open` replaces the transaction
 * itself, for a kernel that throws before a body runs.
 */
function fakeClient(rows: unknown, fault?: unknown, open?: () => never | Promise<never>): Fake {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const bounds: unknown[] = [];
  const signals: AbortSignal[] = [];
  const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    return fault !== undefined ? Promise.reject(fault) : Promise.resolve(rows as never);
  }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements, values, bounds, signals,
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      bounds.push(b);
      signals.push(signal);
      if (open) return open();
      return work(sql);
    }) as never,
    end: async () => undefined,
  }) as never;
}

const live = (): AbortSignal => new AbortController().signal;
const aborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};
const over = (rows: unknown, fault?: unknown, open?: () => never | Promise<never>) => {
  const client = fakeClient(rows, fault, open);
  return { client, admission: createPostgresPlatformAdmission({ client }) };
};
const admit = async (rows: unknown, fault?: unknown): Promise<unknown> => over(rows, fault).admission.admit(PRINCIPAL, live());
/** Whitespace folded, so the assertion pins the statement, not its indentation. */
const text = (statement: string): string => statement.replace(/\s+/g, ' ').trim();

const ADMIT_TEXT = 'select outcome, actor_id, account_status, limitation, security_version, memberships, authority_version '
  + 'from tmpos_admission.m5_admit_platform_session(?::text, ?::text)';
const PROBE_TEXT = "select outcome from tmpos_admission.m5_admit_platform_session('firebase'::text, ?::text)";

// --- the resolved answer ------------------------------------------------------------------------------------------

test('M5PA-01 a resolved row is reported as the port\'s own frozen shape, with no provider reference in it', async () => {
  const { client, admission } = over([row([grant()])]);
  const answer = await admission.admit(PRINCIPAL, live()) as {
    outcome: string; authorityVersion: string;
    principal: { memberships: readonly Record<string, unknown>[] };
  };
  assert.deepEqual(answer, {
    outcome: 'resolved',
    principal: {
      actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: VERSION,
      memberships: [{
        membershipId: MEMBERSHIP, scopeType: 'platform', tenant: null, store: null,
        roleId: 'system_owner', tenantStatus: null, storeStatus: null,
      }],
    },
    authorityVersion: '7',
  }, 'the port\'s shape: tenant/store, not the routine\'s tenantId/storeId; the version as the routine rendered it');
  assert.equal(Object.isFrozen(answer), true, 'the answer');
  assert.equal(Object.isFrozen(answer.principal), true, 'the principal');
  assert.equal(Object.isFrozen(answer.principal.memberships), true, 'the grant list');
  assert.equal(Object.isFrozen(answer.principal.memberships[0]), true, 'each grant');
  assert.equal(JSON.stringify(answer).includes('uid-alpha'), false, 'no provider reference crosses the port');
  assert.equal(client.statements.length, 1, 'one statement, one round trip');
});

test('M5PA-02 the principal is a copy: a row changed after the read changes nothing the caller holds', async () => {
  const theGrant = grant();
  const theRow = row([theGrant]);
  const answer = await admit([theRow]) as { principal: { actor: string; memberships: readonly { roleId: string }[] } };
  theGrant.roleId = 'support_agent';
  theRow.actor_id = '99999999-9999-4999-8999-999999999999';
  (theRow.memberships as unknown[]).push(grant({ membershipId: SECOND }));
  assert.equal(answer.principal.actor, ACTOR);
  assert.equal(answer.principal.memberships.length, 1);
  assert.equal(answer.principal.memberships[0].roleId, 'system_owner');
});

test('M5PA-03 every column and grant field is read exactly once, so a value cannot answer the check one way and the caller another', async () => {
  const reads = new Map<string, number>();
  const counted = (target: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(target)) {
      Object.defineProperty(out, key, {
        enumerable: true,
        get: () => { reads.set(`${prefix}${key}`, (reads.get(`${prefix}${key}`) ?? 0) + 1); return value; },
      });
    }
    return out;
  };
  const answer = await admit([counted(row([counted(grant(), 'grant.')]), 'row.')]) as { outcome: string };
  assert.equal(answer.outcome, 'resolved');
  assert.deepEqual([...reads.entries()].filter(([, n]) => n !== 1), [], 'no field read more than once');
  assert.deepEqual([...reads.keys()].sort(), [
    'grant.membershipId', 'grant.roleId', 'grant.scopeType', 'grant.storeId', 'grant.storeStatus', 'grant.tenantId', 'grant.tenantStatus',
    'row.account_status', 'row.actor_id', 'row.authority_version', 'row.limitation', 'row.memberships', 'row.outcome', 'row.security_version',
  ], 'and every one of them is read');
});

test('M5PA-04 the adapter decides nothing: no grant, several grants, version zero and the widest version all resolve as the routine said', async () => {
  const cases: [string, unknown, readonly string[], string][] = [
    // Whether these admit a session is platformAuthorization.ts's decision (exactly one grant); not this file's.
    ['no platform grant', [row([])], [], '7'],
    ['two platform grants', [row([grant(), grant({ membershipId: SECOND, roleId: 'support_agent' })])], [MEMBERSHIP, SECOND], '7'],
    // coalesce(version, 0): an actor whose grants never moved is at zero, a legitimate answer.
    ['a version never moved', [row([grant()], { authority_version: '0' })], [MEMBERSHIP], '0'],
    ['the widest version the grammar admits', [row([grant()], { authority_version: '9'.repeat(19) })], [MEMBERSHIP], '9'.repeat(19)],
    ['a read-only account', [row([grant()], { account_status: 'read_only', limitation: 'read_only' })], [MEMBERSHIP], '7'],
  ];
  for (const [label, rows, ids, version] of cases) {
    const answer = await admit(rows) as { outcome: string; authorityVersion: string; principal: { memberships: readonly { membershipId: string }[] } };
    assert.equal(answer.outcome, 'resolved', label);
    assert.deepEqual(answer.principal.memberships.map((m) => m.membershipId), ids, label);
    assert.equal(answer.authorityVersion, version, label);
  }
});

// --- refusals -----------------------------------------------------------------------------------------------------

test('M5PA-05 a refusal is the routine\'s own, answered only in the routine\'s full seven-column shape', async () => {
  const answer = await admit([REFUSED_ROW]);
  assert.deepEqual(answer, { outcome: 'refused' });
  assert.equal(Object.isFrozen(answer), true);
  // A refusal missing a column is not the routine's answer: an outage, which revokes nothing.
  assert.deepEqual(await admit([without(REFUSED_ROW, 'authority_version')]), { outcome: 'unavailable' });
  assert.deepEqual(await admit([{ outcome: 'refused' }]), { outcome: 'unavailable' });
});

test('M5PA-05b a refusal carrying any payload column is not the routine\'s: unavailable, through admit() and readPlatformAdmission alike', async () => {
  // 013 answers a refusal with its six payload columns all null. One that names anything is not that answer, and read as a
  // refusal it would end every administrative session the principal holds: a fault must never revoke.
  const onHandle = (rows: unknown): PgTransactionScope => (() => Promise.resolve(rows as never)) as unknown as PgTransactionScope;
  for (const [column, value] of [['actor_id', ACTOR], ['account_status', 'active'], ['limitation', 'none'], ['security_version', VERSION],
    ['memberships', [grant()]], ['authority_version', '7']] as Array<[string, unknown]>) {
    const rows = [{ ...REFUSED_ROW, [column]: value }];
    assert.deepEqual(await admit(rows), { outcome: 'unavailable' }, `admit(): ${column} non-null`);
    assert.deepEqual(await readPlatformAdmission(onHandle(rows), PRINCIPAL), { outcome: 'unavailable' }, `readPlatformAdmission: ${column} non-null`);
  }
  assert.deepEqual(await readPlatformAdmission(onHandle([REFUSED_ROW]), PRINCIPAL), { outcome: 'refused' }, 'the all-null refusal stays a refusal');
});

test('M5PA-06 a reference this boundary cannot read is refused before any transaction or statement', async () => {
  const bad: [string, unknown][] = [
    ['a string', 'uid-alpha'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an unknown provider', { authProvider: 'okta', authProviderUid: 'uid-alpha' }],
    ['a provider in another case', { authProvider: 'Firebase', authProviderUid: 'uid-alpha' }],
    ['an empty provider', { authProvider: '', authProviderUid: 'uid-alpha' }],
    ['no provider', { authProviderUid: 'uid-alpha' }],
    ['a provider that is not a string', { authProvider: ['firebase'], authProviderUid: 'uid-alpha' }],
    ['no reference', { authProvider: 'firebase' }],
    ['a reference that is not a string', { authProvider: 'firebase', authProviderUid: 42 }],
    ['an empty reference', { authProvider: 'firebase', authProviderUid: '' }],
    ['a reference past the adapter\'s bound', { authProvider: 'firebase', authProviderUid: 'u'.repeat(256) }],
  ];
  for (const [label, principal] of bad) {
    const { client, admission } = over([row([grant()])]);
    assert.deepEqual(await admission.admit(principal as VerifiedPrincipal, live()), { outcome: 'refused' }, label);
    assert.deepEqual(client.bounds, [], `${label}: no transaction is opened`);
    assert.deepEqual(client.statements, [], `${label}: costs the database nothing`);
  }
  // Both providers 002's audit CHECK admits are read, and the bound itself is inside it.
  const readable: [string, VerifiedPrincipal][] = [
    ['firebase', { authProvider: 'firebase', authProviderUid: 'uid-alpha' }],
    ['supabase', { authProvider: 'supabase', authProviderUid: 'uid-alpha' }],
    ['a reference at the bound', { authProvider: 'firebase', authProviderUid: 'u'.repeat(255) }],
  ];
  for (const [label, principal] of readable) {
    const { client, admission } = over([row([grant()])]);
    assert.equal((await admission.admit(principal, live()) as { outcome: string }).outcome, 'resolved', label);
    assert.deepEqual(client.values, [[principal.authProvider, principal.authProviderUid]], label);
  }
});

// --- outages: the row ---------------------------------------------------------------------------------------------

test('M5PA-07 a row set or row the routine does not answer is UNAVAILABLE — never a refusal, never a principal', async () => {
  const faults: [string, unknown][] = [
    ['no row', []],
    ['two rows', [row([grant()]), row([grant()])]],
    ['a refusal and a resolution', [REFUSED_ROW, row([grant()])]],
    ['rows that are not an array', { 0: row([grant()]), length: 1 }],
    ['null rows', null],
    ['a row that is null', [null]],
    ['a row that is a string', ['resolved']],
    ['a row that is an array', [Object.values(row([grant()]))]],
    ['a missing column', [without(row([grant()]), 'security_version')]],
    ['the authority version missing', [without(row([grant()]), 'authority_version')]],
    ['an extra column', [{ ...row([grant()]), extra: 1 }]],
    ['a tenant access version where none belongs', [{ ...row([grant()]), tenant_access_version: '1' }]],
    ['an outcome that is neither', [row([grant()], { outcome: 'admitted' })]],
    ['a pending outcome', [row([grant()], { outcome: 'pending' })]],
    ['an outcome in another case', [row([grant()], { outcome: 'RESOLVED' })]],
    ['no outcome', [row([grant()], { outcome: null })]],
  ];
  for (const [label, rows] of faults) {
    assert.deepEqual(await admit(rows), { outcome: 'unavailable' }, label);
  }
});

test('M5PA-08 an authority version that is not the routine\'s decimal text is an outage', async () => {
  const faults: [string, unknown][] = [
    ['a number', 7],
    ['a bigint', 7n],
    ['null', null],
    ['an empty string', ''],
    ['past bigint width', '1'.repeat(20)],
    ['an exponent', '1e3'],
    ['hexadecimal', '0x1'],
    ['a sign', '-1'],
    ['a plus sign', '+1'],
    ['a leading space', ' 1'],
    ['a trailing space', '1 '],
    ['a trailing newline', '1\n'],
    ['a fraction', '1.0'],
    ['a non-ASCII digit', '١'],
  ];
  for (const [label, version] of faults) {
    assert.deepEqual(await admit([row([grant()], { authority_version: version })]), { outcome: 'unavailable' }, label);
  }
});

test('M5PA-09 a principal isTrustedPrincipal would not accept is an outage', async () => {
  const faults: [string, Record<string, unknown>][] = [
    ['an actor that is not a uuid', { actor_id: 'actor-1' }],
    ['no actor', { actor_id: null }],
    ['an account status in another case', { account_status: 'Active' }],
    ['an empty account status', { account_status: '' }],
    ['no account status', { account_status: null }],
    ['an account status past its bound', { account_status: 'a'.repeat(33) }],
    ['a limitation the runtime does not know', { limitation: 'full' }],
    ['a limitation in another case', { limitation: 'READ_ONLY' }],
    ['no limitation', { limitation: null }],
    ['a security version with a space', { security_version: 'a b' }],
    ['an empty security version', { security_version: '' }],
    ['a security version past its bound', { security_version: 'x'.repeat(129) }],
    ['no security version', { security_version: null }],
  ];
  for (const [label, columns] of faults) {
    assert.deepEqual(await admit([row([grant()], columns)]), { outcome: 'unavailable' }, label);
  }
});

// --- outages: the grants ------------------------------------------------------------------------------------------

test('M5PA-10 grants the routine would not answer — wrong container, wrong keys, wrong scope — are an outage, never a grant dropped', async () => {
  const faults: [string, unknown][] = [
    ['memberships that are a string', 'one'],
    ['memberships that are null', null],
    ['memberships that are an object', { 0: grant(), length: 1 }],
    ['a grant that is a string', ['x']],
    ['a grant that is null', [null]],
    ['a grant that is an array', [Object.values(grant())]],
    ['a grant missing its tenant id', [without(grant(), 'tenantId')]],
    ['a grant missing its store status', [without(grant(), 'storeStatus')]],
    ['a grant missing its role', [without(grant(), 'roleId')]],
    ['a grant with a key present but undefined', [grant({ tenantStatus: undefined })]],
    ['a grant with an extra key', [{ ...grant(), extra: 1 }]],
    ['a grant with a tenant access version', [{ ...grant(), tenantAccessVersion: '1' }]],
    ['a grant in the port\'s shape rather than the routine\'s', [{ ...without(without(grant(), 'tenantId'), 'storeId'), tenant: null, store: null }]],
    ['a tenant grant', [grant({ scopeType: 'tenant', tenantId: TENANT, tenantStatus: 'active' })]],
    ['a store grant', [grant({ scopeType: 'store', tenantId: TENANT, storeId: STORE, tenantStatus: 'active', storeStatus: 'active' })]],
    ['a platform grant beside a tenant grant', [grant(), grant({ membershipId: SECOND, scopeType: 'tenant', tenantId: TENANT, tenantStatus: 'active' })]],
    ['a scope in another case', [grant({ scopeType: 'Platform' })]],
    ['a scope the runtime does not know', [grant({ scopeType: 'region' })]],
  ];
  for (const [label, memberships] of faults) {
    assert.deepEqual(await admit([row(memberships)]), { outcome: 'unavailable' }, label);
  }
});

test('M5PA-11 a platform grant that names a tenant, a store or a status is an outage', async () => {
  const faults: [string, Record<string, unknown>][] = [
    ['a tenant id', { tenantId: TENANT }],
    ['a store id', { storeId: STORE }],
    ['a tenant status', { tenantStatus: 'active' }],
    ['a store status', { storeStatus: 'active' }],
    // Absent is null, never undefined and never an empty string.
    ['an empty tenant id', { tenantId: '' }],
    ['an undefined store id', { storeId: undefined }],
  ];
  for (const [label, fields] of faults) {
    assert.deepEqual(await admit([row([grant(fields)])]), { outcome: 'unavailable' }, label);
  }
});

test('M5PA-12 a grant id or role isTrustedPrincipal would not accept, a repeated id or too many grants is an outage', async () => {
  const faults: [string, unknown[]][] = [
    ['a membership id that is not a uuid', [grant({ membershipId: 'membership-1' })]],
    ['a membership id that is a number', [grant({ membershipId: 5 })]],
    ['no membership id', [grant({ membershipId: null })]],
    ['a role with an upper-case letter', [grant({ roleId: 'System_Owner' })]],
    ['a role with a hyphen', [grant({ roleId: 'system-owner' })]],
    ['a role with a digit', [grant({ roleId: 'owner2' })]],
    ['an empty role', [grant({ roleId: '' })]],
    ['a role past its bound', [grant({ roleId: 'a'.repeat(65) })]],
    ['a role that is a number', [grant({ roleId: 1 })]],
    ['no role', [grant({ roleId: null })]],
    ['two grants sharing one id', [grant(), grant({ roleId: 'support_agent' })]],
    ['more grants than any real principal holds', Array.from({ length: 201 }, (_, i) =>
      grant({ membershipId: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}` }))],
  ];
  for (const [label, memberships] of faults) {
    assert.deepEqual(await admit([row(memberships)]), { outcome: 'unavailable' }, label);
  }
  // The bound is exact: a role of sixty-four and two hundred grants are both inside it.
  assert.equal((await admit([row([grant({ roleId: 'a'.repeat(64) })])]) as { outcome: string }).outcome, 'resolved');
  const twoHundred = Array.from({ length: 200 }, (_, i) => grant({ membershipId: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}` }));
  assert.equal((await admit([row(twoHundred)]) as { outcome: string }).outcome, 'resolved');
});

// --- outages: the kernel ------------------------------------------------------------------------------------------

test('M5PA-13 a kernel or driver fault is an outage that throws nothing and discloses nothing', async () => {
  const hostile = Object.assign(new Error('connection to db.example:5432 refused for uid-alpha'), { code: '08006' });
  const opens: [string, () => never | Promise<never>][] = [
    ['a synchronous throw', () => { throw hostile; }],
    ['a rejection', () => Promise.reject(hostile)],
    ['nothing committed', () => Promise.reject(TransactionFailure.unavailable)],
    ['an outcome unknown', () => Promise.reject(TransactionFailure.outcomeUnknown)],
    ['a thrown value that is not an Error', () => { throw 'uid-alpha'; }],
  ];
  for (const [label, open] of opens) {
    const { client, admission } = over([row([grant()])], undefined, open);
    const answer = await admission.admit(PRINCIPAL, live());
    assert.deepEqual(answer, { outcome: 'unavailable' }, label);
    assert.equal(JSON.stringify(answer).includes('uid-alpha'), false, label);
    assert.deepEqual(client.statements, [], `${label}: no body ran`);
  }
  // The statement itself failing inside the transaction is the same outage.
  assert.deepEqual(await admit(null, hostile), { outcome: 'unavailable' }, 'a driver error on the read');
});

test('M5PA-14 an already-expired deadline answers unavailable without opening a transaction', async () => {
  const { client, admission } = over([row([grant()])]);
  assert.deepEqual(await admission.admit(PRINCIPAL, aborted()), { outcome: 'unavailable' });
  assert.deepEqual(client.bounds, [], 'no transaction');
  assert.deepEqual(client.statements, [], 'an expired deadline never reaches the database');
});

test('M5PA-15 each read runs under PLATFORM_ADMISSION_BOUNDS and the caller\'s own signal, below the port deadline', async () => {
  const signal = live();
  const { client, admission } = over([row([grant()])]);
  await admission.admit(PRINCIPAL, signal);
  const probeSignal = live();
  await admission.probe(probeSignal);
  assert.equal(client.bounds.length, 2);
  assert.equal(client.bounds[0], PLATFORM_ADMISSION_BOUNDS, 'the admission read: the exported bounds themselves');
  assert.equal(client.bounds[1], PLATFORM_ADMISSION_BOUNDS, 'the probe: the same bounds');
  assert.equal(client.signals[0], signal, 'the deadline is the caller\'s, not one the adapter invents');
  assert.equal(client.signals[1], probeSignal);
  assert.equal(PLATFORM_ADMISSION_DEADLINE_MS, 3_000);
  assert.deepEqual(PLATFORM_ADMISSION_BOUNDS, { lock: '2100ms', statement: '2700ms', idle: '6000ms' });
  assert.equal(Object.isFrozen(PLATFORM_ADMISSION_BOUNDS), true);
  const ms = (v: string): number => Number(v.replace(/ms$/, ''));
  assert.ok(ms(PLATFORM_ADMISSION_BOUNDS.statement) < PLATFORM_ADMISSION_DEADLINE_MS, 'PostgreSQL cancels an overrun before the port gives up');
  assert.ok(ms(PLATFORM_ADMISSION_BOUNDS.lock) < ms(PLATFORM_ADMISSION_BOUNDS.statement));
});

// --- the statement ------------------------------------------------------------------------------------------------

test('M5PA-16 the read names only migration 013\'s routine and binds the provider and the reference, never interpolating them', async () => {
  const { client, admission } = over([row([grant()])]);
  await admission.admit(PRINCIPAL, live());
  assert.deepEqual(client.statements.map(text), [ADMIT_TEXT], 'one fixed statement');
  assert.deepEqual(client.values, [['firebase', 'uid-alpha']], 'provider, then reference, as parameters');
  const qualified = client.statements[0].match(/[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*/gi);
  assert.deepEqual(qualified, ['tmpos_admission.m5_admit_platform_session'], 'no other relation or routine is named');
  assert.equal(client.statements[0].includes('firebase'), false, 'the provider is bound, not written into the text');
  assert.equal(client.statements[0].includes('uid-alpha'), false, 'the reference is bound, not written into the text');

  // A reference written to break out of a literal changes nothing in the text: it only ever travels as a value.
  const hostile = "x'::text); select pg_sleep(10); --";
  const second = over([row([grant()])]);
  await second.admission.admit({ authProvider: 'supabase', authProviderUid: hostile }, live());
  assert.deepEqual(second.client.statements, client.statements, 'byte-identical text whatever the reference');
  assert.deepEqual(second.client.values, [['supabase', hostile]]);
});

// --- readiness ----------------------------------------------------------------------------------------------------

test('M5PA-17 readiness runs the real admission read and is ready only on one of its two closed answers', async () => {
  const { client, admission } = over([{ outcome: 'refused' }]);
  assert.equal(await admission.probe(live()), true, 'refused: the read answered');
  assert.deepEqual(client.statements.map(text), [PROBE_TEXT], 'the real read, not a ping; the provider a literal');
  assert.equal(client.values.length, 1);
  const [uid] = client.values[0] as [unknown];
  assert.equal(typeof uid, 'string');
  assert.ok((uid as string).length > 0 && (uid as string).length <= 128, 'a reference the runtime itself could carry, so no guard short-circuits the read');
  await admission.probe(live());
  assert.deepEqual(client.values[1], client.values[0], 'a fixed reference');
  // Were the reference ever registered, the routine would answer `resolved`: closed and well formed, so ready.
  assert.equal(await over([{ outcome: 'resolved' }]).admission.probe(live()), true, 'resolved: the read answered');

  const notReady: [string, unknown][] = [
    ['no row', []],
    ['two rows', [{ outcome: 'refused' }, { outcome: 'refused' }]],
    ['an unknown outcome', [{ outcome: 'admitted' }]],
    ['no outcome', [{ outcome: null }]],
    ['an outcome in another case', [{ outcome: 'Refused' }]],
    ['an extra column', [{ outcome: 'refused', extra: 1 }]],
    ['the admission read\'s full row, which the probe does not select', [REFUSED_ROW]],
    ['a row that is null', [null]],
    ['rows that are not an array', { outcome: 'refused' }],
    ['null rows', null],
  ];
  for (const [label, rows] of notReady) {
    assert.equal(await over(rows).admission.probe(live()), false, label);
  }
  assert.equal(await over(null, new Error('down')).admission.probe(live()), false, 'a driver error');
  assert.equal(await over(null, undefined, () => { throw new Error('down'); }).admission.probe(live()), false, 'a synchronous kernel throw');
  assert.equal(await over(null, undefined, () => Promise.reject(TransactionFailure.unavailable)).admission.probe(live()), false, 'a kernel rejection');

  const expired = over([{ outcome: 'refused' }]);
  assert.equal(await expired.admission.probe(aborted()), false, 'an expired deadline');
  assert.deepEqual(expired.client.bounds, [], 'an expired probe opens no transaction');
  assert.deepEqual(expired.client.statements, []);
});

// --- nothing is logged --------------------------------------------------------------------------------------------

test('M5PA-18 nothing is logged: not a resolution, a refusal, an outage, a fault or a probe', async (t) => {
  const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const)
    .map((name) => [name, t.mock.method(console, name, () => undefined)] as const);
  const hostile = new Error('connection to db.example:5432 refused for uid-alpha');

  await admit([row([grant()])]);
  await admit([REFUSED_ROW]);
  await admit([]);
  await admit([row([grant({ scopeType: 'tenant', tenantId: TENANT, tenantStatus: 'active' })])]);
  await admit([row([grant()], { authority_version: 7 })]);
  await admit(null, hostile);
  await over([row([grant()])], undefined, () => { throw hostile; }).admission.admit(PRINCIPAL, live());
  await over([row([grant()])]).admission.admit({ authProvider: 'okta', authProviderUid: 'uid-alpha' }, live());
  await over([row([grant()])]).admission.admit(PRINCIPAL, aborted());
  await over([{ outcome: 'refused' }]).admission.probe(live());
  await over([]).admission.probe(live());
  await over(null, hostile).admission.probe(live());

  for (const [name, spy] of spies) {
    assert.equal(spy.mock.callCount(), 0, `console.${name}`);
  }
});

// --- M5-ADMIN-REVOKE-P1: the same read on a caller's own transaction -------------------------------------------------

test('M5AR-A1 readPlatformAdmission is admit()\'s one statement on the caller\'s handle: the same answers, and a fault left to the caller\'s kernel', async () => {
  // The same statement and the same bound reference as admit(), and the same answer for the same row.
  const seen: Array<[string, unknown[]]> = [];
  const handle = (rows: unknown, fault?: unknown): PgTransactionScope =>
    ((strings: TemplateStringsArray, ...args: unknown[]) => {
      seen.push([strings.join('?'), args]);
      return fault !== undefined ? Promise.reject(fault) : Promise.resolve(rows as never);
    }) as unknown as PgTransactionScope;
  for (const rows of [[row([grant()])], [REFUSED_ROW], [row([grant()]), row([grant()])], [without(row([grant()]), 'authority_version')]]) {
    seen.length = 0;
    assert.deepEqual(await readPlatformAdmission(handle(rows), PRINCIPAL), await admit(rows), JSON.stringify(rows).slice(0, 80));
    assert.equal(seen.length, 1);
    assert.equal(text(seen[0][0]), ADMIT_TEXT, 'the very statement admit() sends');
    assert.deepEqual(seen[0][1], ['firebase', 'uid-alpha'], 'the reference, bound');
  }
  // A malformed reference is refused before any statement, exactly as admit() refuses it.
  seen.length = 0;
  for (const principal of [null, { authProvider: 'github', authProviderUid: 'u' }, { authProvider: 'firebase', authProviderUid: '' },
    { authProvider: 'firebase', authProviderUid: 'u'.repeat(256) }]) {
    assert.deepEqual(await readPlatformAdmission(handle([row([grant()])]), principal as never), { outcome: 'refused' }, JSON.stringify(principal));
  }
  assert.equal(seen.length, 0, 'nothing sent');
  // Unlike admit(), a statement or driver error is NOT caught: the caller's transaction is aborted by it, and its kernel
  // rolls back — an outage there, never an answer made up here.
  const fault = new Error('FATAL: M5-UNIT-CANARY statement timeout');
  await assert.rejects(readPlatformAdmission(handle([], fault), PRINCIPAL), (err: unknown) => err === fault);
  assert.deepEqual(await admit([], fault), { outcome: 'unavailable' }, 'admit() in its own transaction still answers unavailable');
});
