// Phase 4.0 M5-GIAM-D1-P2-R1 — the PostgreSQL session store: what it sends, what it trusts, and what
// it refuses to answer. DATABASE-FREE; the routines themselves are proved against a real cluster
// (tests/db/tenantAdmission.integration.test.mjs).
//
// The property under test is one-sided. This store may answer "no such session" ONLY when the
// database said so: every other doubt — a shape it does not recognise, a stamp it cannot parse, a
// clock it cannot read, an outcome the routine does not define — must THROW, because the boundary
// reads a throw as an outage and refuses the request, while "no such session" logs a live user out.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  createPostgresSessionStore, holdAdministrativeSession, holdTenantSession, persistedAuditMetadata, probeIssuerKey, probeSessionMint, readTenantSession,
  SESSION_STORE_BOUNDS, SESSION_STORE_DEADLINE_MS, tenantMintProof,
} from './postgresSessionStore.js';
import type { SessionStandingCheck } from './postgresSessionStore.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import { SESSION_TTL } from '../runtime/sessions.js';
import type { SessionEndAudit, SessionEstablishAudit, SessionRecord } from '../runtime/sessions.js';

const KEY = 'a'.repeat(43);
const PRINCIPAL_KEY = 'b'.repeat(43);
const CREATED = 1_700_000_000_000;
/** A synthetic tenant issuer key, generated per run: no key material is ever written into this file. */
const ISSUER_KEY = randomBytes(32);

const RECORD: SessionRecord = Object.freeze({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-alpha', principalKey: PRINCIPAL_KEY,
  securityVersion: 't1:witness', authenticatedAt: CREATED - 1_000, createdAt: CREATED,
  lastSeenAt: CREATED, validatedAt: CREATED,
});

/** The row migration 011's read answers with: int8 columns arrive from the driver as decimal TEXT. */
const ROW = Object.freeze({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-alpha', principalKey: PRINCIPAL_KEY,
  securityVersion: 't1:witness', authenticatedAt: String(CREATED - 1_000), createdAt: String(CREATED),
  lastSeenAt: String(CREATED), validatedAt: String(CREATED),
});

interface Fake extends SupervisedPgClient {
  readonly statements: string[];
  readonly values: unknown[][];
  readonly bounds: unknown[];
  /** The template each statement was sent with, as the kernel receives it. */
  readonly templates: TemplateStringsArray[];
}

/**
 * A client answering every statement from `rows` (or throwing `fault`), recording what it was sent. `rows` may be
 * a function of the statement's text, for an operation that sends several; one answering an Error rejects.
 */
function fakeClient(rows: unknown, fault?: Error): Fake {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const bounds: unknown[] = [];
  const templates: TemplateStringsArray[] = [];
  const sql = Object.assign((strings: TemplateStringsArray, ...args: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(args);
    templates.push(strings);
    const answer = typeof rows === 'function' ? (rows as (s: string) => unknown)(strings.join('?')) : rows;
    return fault ? Promise.reject(fault) : answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as never);
  }, { json: (value: unknown) => ({ json: value }) }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements, values, bounds, templates,
    transaction: (<T>(signal: AbortSignal, b: unknown, work: (h: PgTransactionScope) => Promise<T>) => {
      bounds.push(b);
      void signal;
      return work(sql);
    }) as never,
    end: async () => undefined,
  }) as never;
}

const live = (): AbortSignal => new AbortController().signal;
/**
 * The port declares every method as answering `unknown` — a port never promises a shape — so a call
 * is adapted once, here, rather than cast at each assertion.
 */
const answered = (value: unknown): Promise<unknown> => Promise.resolve(value);
/** A standing check that admits: the establish tests below prove the store's own steps; the check is proved on its own. */
const ADMITS: SessionStandingCheck = async () => true;
const store = (rows: unknown, fault?: Error, now?: () => number, standing: SessionStandingCheck | null = ADMITS, issuerKey: Uint8Array | null = ISSUER_KEY) => {
  const client = fakeClient(rows, fault);
  return {
    client,
    store: createPostgresSessionStore({
      client, ...(now === undefined ? {} : { now }), ...(standing === null ? {} : { standing }), ...(issuerKey === null ? {} : { issuerKey }),
    }),
  };
};

// --- create -------------------------------------------------------------------------------------

test("create sends the record as given and the expiry this store computes from the RECORD's own audience", async () => {
  // The administrative audience's expiry is proved through establish below: create refuses its records.
  const { client, store: s } = store([{ outcome: 'created' }]);
  await s.create(KEY, RECORD, live());
  assert.equal(client.statements.length, 1, 'one statement, one round trip');
  const expiresAt = CREATED + SESSION_TTL.tenant.absoluteMs;
  assert.deepEqual(client.values[0], [
    KEY, 'tenant', 'firebase', 'uid-alpha', PRINCIPAL_KEY, 't1:witness',
    CREATED - 1_000, CREATED, CREATED, CREATED, expiresAt, tenantMintProof(ISSUER_KEY, KEY, RECORD, expiresAt),
  ], 'every stamp the boundary set travels, the expiry is its own lifetime, and the proof covers all eleven');
  assert.match(client.statements[0], /tmpos_mint\.m7a_session_create\(\s*(?:\?::(?:text|bigint),\s*){11}\?::bytea\) as outcome/);
  assert.equal(client.statements[0].includes('m5_session_create'), false, '011\'s unproven create is never called');
  // The reference travels as a BOUND VALUE. (Asserting it is absent from the statement text would
  // be vacuous here: the fake joins the template's static strings, which can never hold a value.)
  assert.equal(client.values[0].includes('uid-alpha'), true, 'the reference is a parameter');
});

test('create refuses an administrative record before anything is sent: establish is the only way one is written', async () => {
  const { client, store: s } = store([{ outcome: 'created' }]);
  await assert.rejects(answered(s.create(KEY, { ...RECORD, audience: 'admin' }, live())), /session store unavailable: audit_required/);
  assert.deepEqual(client.statements, []);
});

test('a login whose key is already taken fails the login rather than overwriting a live session', async () => {
  const { store: s } = store([{ outcome: 'conflict' }]);
  await assert.rejects(answered(s.create(KEY, RECORD, live())), /session store unavailable: not_created/);
});

test('create refuses a record this runtime has no lifetime for, before anything is sent', async () => {
  // 'support' names nothing at all. The rest name something every plain object INHERITS, which an
  // `in` check or a bracket read would take for a lifetime — the case the own-property lookup closes.
  for (const audience of ['support', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const { client, store: s } = store([{ outcome: 'created' }]);
    await assert.rejects(answered(s.create(KEY, { ...RECORD, audience: audience as never }, live())), /audience_invalid/, audience);
    assert.deepEqual(client.statements, [], `${audience}: nothing was sent`);
  }
});

// --- get ----------------------------------------------------------------------------------------

test('get returns the stored record, parsing the driver\'s decimal int8 text rather than casting it', async () => {
  const NOW = 1_700_000_000_123;
  const { client, store: s } = store([ROW], undefined, () => NOW);
  assert.deepEqual(await s.get(KEY, live()), RECORD);
  // The liveness bound is this store's clock, sent AS GIVEN beside the key. Its VALUE is asserted,
  // not merely its type: a store sending seconds where the routine compares milliseconds would judge
  // every session expired (a silent mass logout) or none of them (a revoked session still served).
  assert.deepEqual(client.values[0], [KEY, NOW]);
  assert.equal(client.statements[0].includes('m5_session_get'), true);
});

test('each operation calls its OWN routine, so a misrouted call cannot pass for a working one', async () => {
  const calls: [string, (s: ReturnType<typeof store>['store']) => unknown][] = [
    ['m7a_session_create', (s) => s.create(KEY, RECORD, live())],
    ['m5_session_get', (s) => s.get(KEY, live())],
    ['m5_session_touch', (s) => s.update(KEY, { lastSeenAt: CREATED }, live())],
    ['m5_session_revoke(', (s) => s.revoke(KEY, live())],
    ['m5_session_revoke_principal', (s) => s.revokePrincipal('tenant', PRINCIPAL_KEY, live())],
  ];
  for (const [routine, call] of calls) {
    const { client, store: s } = store([{ outcome: 'created' }, { ended: 0 }].slice(0, 1));
    await answered(call(s)).catch(() => undefined); // the answer is another test's subject
    assert.equal(client.statements.length, 1, routine);
    assert.equal(client.statements[0].includes(routine), true, `${routine}: called, not a sibling`);
  }
});

test('NO row is the one answer that is not a fault; every other doubt throws instead of logging a user out', async () => {
  assert.equal(await store([]).store.get(KEY, live()), undefined, 'this key names no live session');
  const faults: [string, unknown][] = [
    ['two rows', [ROW, ROW]],
    ['not an array', { ...ROW }],
    ['a row that is not an object', ['x']],
    ['a missing column', [{ ...ROW, validatedAt: undefined }]],
    ['an extra column', [{ ...ROW, extra: 1 }]],
    ['an audience the runtime does not know', [{ ...ROW, audience: 'support' }]],
    ['an empty security version', [{ ...ROW, securityVersion: '' }]],
    ['a stamp past the safe-integer range', [{ ...ROW, createdAt: '9007199254740993' }]],
    ['a stamp that is not decimal text', [{ ...ROW, lastSeenAt: '17e11' }]],
    ['a NULL where a stamp belongs', [{ ...ROW, createdAt: null }]],
  ];
  for (const [label, rows] of faults) {
    await assert.rejects(answered(store(rows).store.get(KEY, live())), /session store unavailable/, label);
  }
  // Only authenticatedAt may be absent, and only as a SQL NULL.
  const nullAuth = await store([{ ...ROW, authenticatedAt: null }]).store.get(KEY, live()) as SessionRecord;
  assert.equal(nullAuth.authenticatedAt, null);
});

test('a driver fault is an outage in this store\'s own words, carrying nothing of the driver\'s', async () => {
  const fault = Object.assign(new Error('connection to db.example:5432 refused'), { code: '08006', schema: 'tmpos_session' });
  await assert.rejects(answered(store(null, fault).store.get(KEY, live())), (err: Error) => {
    assert.equal(err.message, 'session store unavailable: store_failed');
    assert.equal(JSON.stringify(err.message).includes('db.example'), false);
    return true;
  });
});

test('a clock that cannot be read is an outage, never a read that matches no row', async () => {
  for (const bad of [NaN, 0, -1, 1.5, Infinity, '1700000000000' as unknown as number]) {
    await assert.rejects(answered(store([ROW], undefined, () => bad as number).store.get(KEY, live())),
      /session store unavailable/, String(bad));
  }
});

test('an already-aborted call never reaches the database', async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, store: s } = store([ROW]);
  await assert.rejects(answered(s.get(KEY, controller.signal)), /session store unavailable: aborted/);
  assert.deepEqual(client.statements, []);
});

// --- update, revoke, revokePrincipal --------------------------------------------------------------

test('update slides exactly one named stamp, and refuses any other field or value without sending one', async () => {
  const { client, store: s } = store([{ outcome: 'updated' }]);
  await s.update(KEY, { lastSeenAt: CREATED + 5 }, live());
  await s.update(KEY, { validatedAt: CREATED + 6 }, live());
  assert.deepEqual(client.values.map((v) => v.slice(1)), [['lastSeenAt', CREATED + 5], ['validatedAt', CREATED + 6]]);
  const sent = client.statements.length;
  for (const fields of [{}, { lastSeenAt: CREATED, validatedAt: CREATED }, { createdAt: CREATED }, { lastSeenAt: 1.5 },
    { lastSeenAt: -1 }, { lastSeenAt: '1700000000000' }, { lastSeenAt: Number.MAX_SAFE_INTEGER + 2 }]) {
    await assert.rejects(answered(s.update(KEY, fields as never, live())), /session store unavailable/, JSON.stringify(fields));
  }
  assert.equal(client.statements.length, sent, 'a refused update sends nothing');
});

test('an update never creates: a key that names no record is a no-op, so a revoked session stays revoked', async () => {
  await store([{ outcome: 'absent' }]).store.update(KEY, { lastSeenAt: CREATED }, live());
  for (const outcome of ['invalid', 'created', '']) {
    await assert.rejects(answered(store([{ outcome }]).store.update(KEY, { lastSeenAt: CREATED }, live())), /not_updated/, outcome);
  }
});

test('revocation is final: only the routine\'s own word is success', async () => {
  const { client, store: s } = store([{ outcome: 'revoked' }]);
  await s.revoke(KEY, live());
  assert.deepEqual(client.values[0], [KEY]);
  for (const outcome of ['absent', 'updated', null]) {
    await assert.rejects(answered(store([{ outcome }]).store.revoke(KEY, live())), /not_revoked/, String(outcome));
  }
});

test('revoking a principal names exactly one audience the runtime knows, and reads the count the routine returned', async () => {
  const { client, store: s } = store([{ ended: '2' }]);
  await s.revokePrincipal('tenant', PRINCIPAL_KEY, live());
  assert.deepEqual(client.values[0], ['tenant', PRINCIPAL_KEY]);
  // Zero is a valid answer: the principal held no session on this boundary.
  await store([{ ended: 0 }]).store.revokePrincipal('admin', PRINCIPAL_KEY, live());
  for (const audience of ['support', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const { client: unsent, store: refuses } = store([{ ended: '1' }]);
    await assert.rejects(answered(refuses.revokePrincipal(audience as never, PRINCIPAL_KEY, live())), /audience_invalid/, audience);
    assert.deepEqual(unsent.statements, [], `${audience}: an audience this runtime does not know reaches no routine`);
  }
  for (const ended of ['-1', 'many', null, '9007199254740993']) {
    await assert.rejects(answered(store([{ ended }]).store.revokePrincipal('tenant', PRINCIPAL_KEY, live())), /not_revoked/, String(ended));
  }
});

test('an answer of the wrong shape is never read as an outcome', async () => {
  for (const rows of [[], [{ outcome: 'revoked' }, { outcome: 'revoked' }], [{ outcome: 'revoked', extra: 1 }], [{ other: 'revoked' }], 'revoked']) {
    await assert.rejects(answered(store(rows).store.revoke(KEY, live())), /answer_shape_invalid/, JSON.stringify(rows));
  }
});

test('every operation runs under the store\'s own bounds, below the port deadline', async () => {
  const { client, store: s } = store([ROW]);
  await s.get(KEY, live());
  assert.deepEqual(client.bounds, [SESSION_STORE_BOUNDS]);
  for (const value of Object.values(SESSION_STORE_BOUNDS)) {
    const ms = Number(String(value).replace('ms', ''));
    assert.ok(Number.isInteger(ms) && ms > 0, `${String(value)} is a positive millisecond bound`);
  }
  assert.ok(Number(String(SESSION_STORE_BOUNDS.statement).replace('ms', '')) < SESSION_STORE_DEADLINE_MS,
    'the statement bound sits below the deadline, so PostgreSQL cancels before this process gives up');
});

// --- the audited pair (M6-ADMIN-AUDIT-P1) ---------------------------------------------------------

const NEW_KEY = 'n'.repeat(43);
const NOW = 1_700_000_000_123;
const ACTOR = '0b6f1c2e-4d5a-4e3b-9c8d-7a6b5c4d3e2f';
const OPERATION = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const ADMIN_RECORD: SessionRecord = Object.freeze({ ...RECORD, audience: 'admin' });
const ADMIN_ROW = Object.freeze({ ...ROW, audience: 'admin' });
const LOGIN: SessionEstablishAudit = Object.freeze({ action: 'login', operationId: OPERATION, actor: ACTOR, authenticatedAt: CREATED - 1_000 });
const LOGOUT: SessionEndAudit = Object.freeze({ action: 'logout', operationId: OPERATION, actor: null, authenticatedAt: null });
/** What the driver answers an INSERT with: no rows, the command, and the count it affected. */
const inserted = (count: number, command = 'INSERT'): unknown => Object.assign([], { count, command });

type Step = 'get' | 'touch' | 'revoke' | 'create' | 'insert' | 'other';
const stepOf = (statement: string): Step => (
  statement.includes('m5_session_get') ? 'get' : statement.includes('m5_session_touch') ? 'touch'
    : statement.includes('m5_session_revoke(') ? 'revoke' : statement.includes('m7a_session_create') ? 'create'
      : statement.includes('insert into public.audit_event') ? 'insert' : 'other');
const DEFAULTS: Record<Step, unknown> = {
  get: [ADMIN_ROW], touch: [{ outcome: 'updated' }], revoke: [{ outcome: 'revoked' }], create: [{ outcome: 'created' }],
  insert: inserted(1), other: new Error('a statement this store never sends'),
};
/** Answers each statement by the routine it calls, `over` replacing the default answer of a step. */
const answers = (over: Partial<Record<Step, unknown>> = {}) => (statement: string): unknown => {
  const step = stepOf(statement);
  return step in over ? over[step] : DEFAULTS[step];
};
/** The reference an audit record names a session by, derived here independently of the store. */
const refOf = (key: string): string => createHash('sha256').update(`tmpos-audit-session-ref:v1\n${key}`).digest('base64url');

/** The audit record the store sent, column by column, read off the writer's own column list. */
function recordSent(client: Fake): Record<string, unknown> {
  const i = client.statements.findIndex((s) => stepOf(s) === 'insert');
  assert.ok(i >= 0, 'an audit record was sent');
  const text = client.statements[i];
  const columns = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').map((c) => c.trim());
  assert.equal(columns.length, client.values[i].length);
  return Object.fromEntries(columns.map((c, j) => [c, client.values[i][j]]));
}
/** The fixed columns of every session record, with the event id and the sentence masked. */
const masked = (row: Record<string, unknown>): Record<string, unknown> => ({ ...row, event_id: '-', human_readable_reason: '-' });
const COMMON = {
  event_id: '-', audit_version: 'audit.v1', request_id: OPERATION, trace_id: null, actor_auth_provider: null,
  on_behalf_of_internal_user_id: null, scope_type: 'platform', tenant_id: null, store_id: null, required_permission: 'n_a',
  human_readable_reason: '-', result_status: 'succeeded', source_of_truth: 'session_transaction',
  evaluated_by: 'm6_postgres_session_store@v1', evidence_level: 'durable_compliance_event',
};

test('M6AA-S1 establish ends the presented session, creates the new one and writes its record in ONE transaction, the record last', async () => {
  const { client, store: s } = store(answers(), undefined, () => NOW);
  assert.equal(await answered(s.establish?.(NEW_KEY, ADMIN_RECORD, KEY, { ...LOGIN, action: 'reauthenticate' }, live())), 'established');
  assert.deepEqual(client.bounds, [SESSION_STORE_BOUNDS], 'one transaction, under the store\'s own bounds');
  assert.deepEqual(client.statements.map(stepOf), ['get', 'touch', 'revoke', 'create', 'insert']);
  assert.deepEqual(client.values[0], [KEY, NOW], 'the presented session, read live by this store\'s clock');
  // The touch writes back the stamp it just read: an UPDATE that changes nothing but takes the row's lock.
  assert.match(client.statements[1], /m5_session_touch\(\?::text, 'validatedAt', \?::bigint\)/);
  assert.deepEqual(client.values[1], [KEY, CREATED]);
  assert.deepEqual(client.values[2], [KEY]);
  assert.deepEqual(client.values[3], [
    NEW_KEY, 'admin', 'firebase', 'uid-alpha', PRINCIPAL_KEY, 't1:witness',
    CREATED - 1_000, CREATED, CREATED, CREATED, CREATED + SESSION_TTL.admin.absoluteMs, null,
  ], 'the new record, expiring at the administrative lifetime, with NO proof: the administrative branch takes none');
  assert.deepEqual(masked(recordSent(client)), {
    ...COMMON, actor_internal_user_id: ACTOR, action_id: 'platform.admin.session.reauthenticate', decision: 'allow',
    reason_code: 'admin_session_reauthenticated',
    metadata: { json: { sessionRef: refOf(NEW_KEY), authenticatedAt: CREATED - 1_000, replacedSessionRef: refOf(KEY) } },
  });
  const sentence = recordSent(client).human_readable_reason;
  assert.ok(typeof sentence === 'string' && sentence.length > 0 && !sentence.includes(ACTOR), 'a fixed sentence, carrying no input');
  // The writer's own frozen template reached the kernel unchanged: the kernel refuses any other.
  assert.ok(Object.isFrozen(client.templates[4]) && Object.isFrozen(client.templates[4].raw));
});

test('M6AA-S2 no presented session, one naming nothing live, one another transaction ended first, or one of another audience: created and recorded, never named as replaced', async () => {
  const cases: Array<[string, string | null, Partial<Record<Step, unknown>>, Step[]]> = [
    ['no presented session', null, {}, ['create', 'insert']],
    ['a key naming no live session', KEY, { get: [] }, ['get', 'create', 'insert']],
    ['a session another transaction ended first', KEY, { touch: [{ outcome: 'absent' }] }, ['get', 'touch', 'create', 'insert']],
    ['a tenant record under the administrative cookie', KEY, { get: [ROW] }, ['get', 'touch', 'revoke', 'create', 'insert']],
  ];
  for (const [label, replaces, over, steps] of cases) {
    const { client, store: s } = store(answers(over));
    assert.equal(await answered(s.establish?.(NEW_KEY, ADMIN_RECORD, replaces, LOGIN, live())), 'established', label);
    assert.deepEqual(client.statements.map(stepOf), steps, label);
    assert.deepEqual(masked(recordSent(client)), {
      ...COMMON, actor_internal_user_id: ACTOR, action_id: 'platform.admin.session.login', decision: 'allow', reason_code: 'admin_session_created',
      metadata: { json: { sessionRef: refOf(NEW_KEY), authenticatedAt: CREATED - 1_000 } },
    }, `${label}: no replacedSessionRef`);
  }
  // A record bound to no authentication time names none.
  const { client, store: s } = store(answers());
  await s.establish?.(NEW_KEY, { ...ADMIN_RECORD, authenticatedAt: null }, null, { ...LOGIN, authenticatedAt: null }, live());
  assert.deepEqual((recordSent(client).metadata as { json: unknown }).json, { sessionRef: refOf(NEW_KEY) });
});

test('M6AA-S3 establish refuses before anything is sent: an unknown audience, an entry that is no login, a client or malformed id, no actor, another authentication time, and anything the writer refuses', async () => {
  const cases: Array<[string, SessionRecord, unknown, RegExp]> = [
    // A tenant record is established too since M5-TENANT-SESSION-P1 (M5T-S1); an audience with no lifetime is not.
    ['an audience the runtime does not know', { ...RECORD, audience: 'support' as never }, LOGIN, /audience_invalid/],
    ['a logout entry', ADMIN_RECORD, { ...LOGIN, action: 'logout' }, /audit_invalid/],
    ['an unknown action', ADMIN_RECORD, { ...LOGIN, action: 'refresh' }, /audit_invalid/],
    ['a client-chosen request id', ADMIN_RECORD, { ...LOGIN, operationId: 'client-chosen-request-id' }, /audit_invalid/],
    ['no actor', ADMIN_RECORD, { ...LOGIN, actor: null }, /audit_invalid/],
    ['an authentication time the record does not bind', ADMIN_RECORD, { ...LOGIN, authenticatedAt: CREATED }, /audit_invalid/],
    ['no entry', ADMIN_RECORD, null, /audit_invalid/],
    // The writer's own validation decides the actor's form, and its refusal fails the operation here.
    ['an actor that is a provider uid, which the writer refuses', ADMIN_RECORD, { ...LOGIN, actor: 'uid-alpha' }, /audit_invalid/],
  ];
  for (const [label, record, entry, reason] of cases) {
    const { client, store: s } = store(answers());
    await assert.rejects(answered(s.establish?.(NEW_KEY, record, KEY, entry as SessionEstablishAudit, live())), reason, label);
    assert.deepEqual(client.statements, [], `${label}: nothing was sent`);
  }
});

test('M6AA-S4 the record must be exactly one INSERTed row, and every other doubt throws inside the transaction, which the kernel rolls back', async () => {
  const faults: Array<[string, Partial<Record<Step, unknown>>, RegExp, Step[]]> = [
    ['no row inserted (a trigger answered NULL)', { insert: inserted(0) }, /audit_not_written/, ['get', 'touch', 'revoke', 'create', 'insert']],
    ['two rows', { insert: inserted(2) }, /audit_not_written/, ['get', 'touch', 'revoke', 'create', 'insert']],
    ['a command other than INSERT', { insert: inserted(1, 'UPDATE') }, /audit_not_written/, ['get', 'touch', 'revoke', 'create', 'insert']],
    ['a result with no command', { insert: Object.assign([], { count: 1 }) }, /audit_not_written/, ['get', 'touch', 'revoke', 'create', 'insert']],
    ['the insert refused by the database', { insert: new Error('new row violates row-level security policy') }, /store_failed/, ['get', 'touch', 'revoke', 'create', 'insert']],
    ['a taken key', { create: [{ outcome: 'conflict' }] }, /not_created/, ['get', 'touch', 'revoke', 'create']],
    ['a touch the routine calls invalid', { touch: [{ outcome: 'invalid' }] }, /not_updated/, ['get', 'touch']],
    ['a revocation that is not the routine\'s word', { revoke: [{ outcome: 'absent' }] }, /not_revoked/, ['get', 'touch', 'revoke']],
    ['two live rows under one key', { get: [ADMIN_ROW, ADMIN_ROW] }, /answer_shape_invalid/, ['get']],
    ['a malformed presented record', { get: [{ ...ADMIN_ROW, extra: 1 }] }, /row_shape_invalid/, ['get']],
  ];
  for (const [label, over, reason, steps] of faults) {
    const { client, store: s } = store(answers(over));
    await assert.rejects(answered(s.establish?.(NEW_KEY, ADMIN_RECORD, KEY, LOGIN, live())), reason, label);
    assert.deepEqual(client.statements.map(stepOf), steps, `${label}: the audit record is last, so nothing after the fault is sent`);
    assert.equal(client.bounds.length, 1, `${label}: all of it one transaction`);
  }
  // A fault never carries the driver's words.
  await assert.rejects(answered(store(answers({ insert: new Error('db.example:5432 refused') })).store.establish?.(NEW_KEY, ADMIN_RECORD, null, LOGIN, live())),
    (err: Error) => err.message === 'session store unavailable: store_failed');
});

test('M6AA-S5 end ends the live session with its record in ONE transaction; nothing live to end answers absent, records nothing and deletes any expired row', async () => {
  const { client, store: s } = store(answers(), undefined, () => NOW);
  assert.equal(await answered(s.end?.(KEY, LOGOUT, live())), 'ended');
  assert.deepEqual(client.bounds, [SESSION_STORE_BOUNDS]);
  assert.deepEqual(client.statements.map(stepOf), ['get', 'touch', 'revoke', 'insert']);
  assert.deepEqual(client.values.slice(0, 3), [[KEY, NOW], [KEY, CREATED], [KEY]]);
  assert.deepEqual(masked(recordSent(client)), {
    ...COMMON, actor_internal_user_id: null, action_id: 'platform.admin.session.logout', decision: 'not_applicable',
    reason_code: 'admin_session_ended', metadata: { json: { sessionRef: refOf(KEY) } },
  }, 'no actor — logout re-asks no admission — and the same reference the login record gave this session');
  for (const [label, over, steps] of [
    // The read judges liveness at this instance's clock, so a row past its absolute expiry reads as nothing live; it is
    // deleted here, so an instance whose clock runs behind cannot go on accepting it. Nothing is recorded either way.
    ['no live session: any expired row under the key is deleted', { get: [] }, ['get', 'revoke']],
    ['a session another transaction ended first', { touch: [{ outcome: 'absent' }] }, ['get', 'touch']],
  ] as Array<[string, Partial<Record<Step, unknown>>, Step[]]>) {
    const { client: c, store: absent } = store(answers(over));
    assert.equal(await answered(absent.end?.(KEY, LOGOUT, live())), 'absent', label);
    assert.deepEqual(c.statements.map(stepOf), steps, `${label}: nothing recorded`);
    assert.equal(c.bounds.length, 1, `${label}: one transaction`);
  }
  await assert.rejects(answered(store(answers({ get: [], revoke: [{ outcome: 'absent' }] })).store.end?.(KEY, LOGOUT, live())),
    /not_revoked/, 'the deletion must be the routine\'s own word');
  // A logout names no actor: one handed an actor is refused like any other malformed entry.
  for (const entry of [LOGIN, { ...LOGOUT, actor: ACTOR }, { ...LOGOUT, authenticatedAt: CREATED }, { ...LOGOUT, operationId: 'x' }]) {
    const { client: c, store: e } = store(answers());
    await assert.rejects(answered(e.end?.(KEY, entry as unknown as SessionEndAudit, live())), /audit_invalid/, JSON.stringify(entry));
    assert.deepEqual(c.statements, []);
  }
  const { store: lost } = store(answers({ insert: inserted(0) }));
  await assert.rejects(answered(lost.end?.(KEY, LOGOUT, live())), /audit_not_written/);
});

test('M6AA-S6 a record names sessions by a one-way, domain-separated reference: never a key, an identifier or a provider reference', async () => {
  const { client, store: s } = store(answers());
  await s.establish?.(NEW_KEY, ADMIN_RECORD, KEY, LOGIN, live());
  const sent = JSON.stringify(recordSent(client));
  for (const secret of [KEY, NEW_KEY, PRINCIPAL_KEY, 'uid-alpha', 'firebase', 't1:witness']) assert.ok(!sent.includes(secret), `the record carries ${secret}`);
  const ref = refOf(KEY);
  assert.match(ref, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ref, createHash('sha256').update(KEY).digest('base64url'), 'domain-separated: not a bare digest of the key');
  assert.notEqual(refOf(KEY), refOf(NEW_KEY));
});

test('M6AA-S7 metadata the writer would not persist as given — a key it drops for the action, a value it would cut — is refused, never quietly lost', () => {
  const full = { sessionRef: refOf(KEY), replacedSessionRef: refOf(NEW_KEY), authenticatedAt: CREATED };
  for (const action of ['login', 'reauthenticate', 'logout']) {
    assert.deepEqual(persistedAuditMetadata(full, `platform.admin.session.${action}`), full, `${action}: kept exactly`);
  }
  const dropped: Array<[string, Record<string, string | number>, string]> = [
    ['a session key on another action', { sessionRef: refOf(KEY) }, 'platform.tenant.status.change'],
    ['a key no action keeps', { sessionId: 'x' }, 'platform.admin.session.login'],
    ['a general key on a session action, which keeps its own keys alone', { sessionRef: refOf(KEY), phase: 'p' }, 'platform.admin.session.login'],
    ['a value past the writer\'s bound', { sessionRef: 'r'.repeat(300) }, 'platform.admin.session.login'],
  ];
  for (const [label, metadata, actionId] of dropped) {
    assert.throws(() => persistedAuditMetadata(metadata, actionId), /session store unavailable: audit_metadata_dropped/, label);
  }
});

// --- M5-ADMIN-REVOKE-P1: ordered against revocation --------------------------------------------------

/** A standing check that answers `answer` and records the handle it ran on and what it was sent before it, if anything. */
function standingCheck(answer: boolean | Error, client: () => Fake) {
  const seen: Array<{ handle: unknown; record: SessionRecord; sentBefore: number }> = [];
  const check: SessionStandingCheck = async (sql, record) => {
    seen.push({ handle: sql, record, sentBefore: client().statements.length });
    // The check runs its own statements on the handle it was given: one here, so its place in the order is visible.
    await sql`select 'standing' as probe`;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { check, seen };
}
const withStanding = (answer: boolean | Error, over: Partial<Record<Step, unknown>> = {}) => {
  let client: Fake | undefined;
  const standing = standingCheck(answer, () => client as Fake);
  const built = store((statement: string) => (statement.includes("'standing'") ? [{ probe: 'standing' }] : answers(over)(statement)), undefined, () => NOW, standing.check);
  client = built.client;
  return { ...built, seen: standing.seen };
};
const stepsOf = (client: Fake): string[] => client.statements.map((t) => (t.includes("'standing'") ? 'standing' : stepOf(t)));

test('M5AR-S1 establish runs the standing check FIRST, on its own transaction\'s handle, before the presented session is read', async () => {
  for (const action of ['login', 'reauthenticate'] as const) {
    const { client, store: s, seen } = withStanding(true);
    assert.equal(await answered(s.establish?.(NEW_KEY, ADMIN_RECORD, KEY, { ...LOGIN, action }, live())), 'established', action);
    assert.deepEqual(stepsOf(client), ['standing', 'get', 'touch', 'revoke', 'create', 'insert'], `${action}: the standing, then today's steps`);
    assert.equal(seen.length, 1, `${action}: once`);
    assert.equal(seen[0].sentBefore, 0, `${action}: before any statement of the store's own`);
    assert.equal(seen[0].record, ADMIN_RECORD, `${action}: judged against the very record being established`);
    assert.equal(client.bounds.length, 1, `${action}: all of it one transaction`);
  }
});

test('M5AR-S2 a standing that moved answers standing_changed and writes nothing: nothing ended, created or recorded', async () => {
  for (const action of ['login', 'reauthenticate'] as const) {
    const { client, store: s } = withStanding(false);
    assert.equal(await answered(s.establish?.(NEW_KEY, ADMIN_RECORD, KEY, { ...LOGIN, action }, live())), 'standing_changed', action);
    assert.deepEqual(stepsOf(client), ['standing'], `${action}: nothing after the check`);
  }
});

test('M5AR-S3 a standing check that faults is an outage: a throw in the store\'s own word, nothing after it', async () => {
  const { client, store: s } = withStanding(new Error('db.example:5432 lock timeout'));
  await assert.rejects(answered(s.establish?.(NEW_KEY, ADMIN_RECORD, KEY, LOGIN, live())), (err: Error) => err.message === 'session store unavailable: store_failed');
  assert.deepEqual(stepsOf(client), ['standing']);
  // A check answering anything but a boolean is a broken check: an outage too — never an admission, and never read as
  // a changed standing (a 401).
  for (const answer of ['true', 'false', 1, 0, undefined, null] as unknown[]) {
    const { client: c, store: odd } = store(answers(), undefined, () => NOW, async () => answer as boolean);
    await assert.rejects(answered(odd.establish?.(NEW_KEY, ADMIN_RECORD, KEY, LOGIN, live())), /session store unavailable: standing_invalid/, String(answer));
    assert.deepEqual(c.statements, [], `${String(answer)}: nothing after the check`);
  }
});

test('M5AR-S4 a store built without a standing check establishes nothing: a throw before anything is sent', async () => {
  const { client, store: s } = store(answers(), undefined, () => NOW, null);
  await assert.rejects(answered(s.establish?.(NEW_KEY, ADMIN_RECORD, KEY, LOGIN, live())), /session store unavailable: standing_check_missing/);
  assert.deepEqual(client.statements, []);
  assert.equal(client.bounds.length, 0, 'no transaction opens');
  // Its plain operations are unaffected: they need no check.
  const { store: tenant } = store([ROW], undefined, () => NOW, null);
  assert.deepEqual(await tenant.get(KEY, live()), RECORD);
});

test('M5AR-S5 a reauthentication must end a live administrative session of its own principal: otherwise session_ended, and nothing is written', async () => {
  const REAUTH: SessionEstablishAudit = { ...LOGIN, action: 'reauthenticate' };
  const cases: Array<[string, string | null, Partial<Record<Step, unknown>>, Step[]]> = [
    ['no presented session', null, {}, []],
    ['a key naming no live session (a logout or revocation committed first)', KEY, { get: [] }, ['get']],
    ['a tenant record under the administrative cookie', KEY, { get: [ROW] }, ['get']],
    ['another principal\'s administrative session', KEY, { get: [{ ...ADMIN_ROW, principalKey: 'c'.repeat(43) }] }, ['get']],
    ['a session another transaction ended first (a racing logout or reauthentication)', KEY, { touch: [{ outcome: 'absent' }] }, ['get', 'touch']],
  ];
  for (const [label, replaces, over, steps] of cases) {
    const { client, store: s } = store(answers(over), undefined, () => NOW);
    assert.equal(await answered(s.establish?.(NEW_KEY, ADMIN_RECORD, replaces, REAUTH, live())), 'session_ended', label);
    assert.deepEqual(client.statements.map(stepOf), steps, `${label}: the checks precede the end — nothing revoked, created or recorded`);
    assert.equal(client.bounds.length, 1, `${label}: one transaction, which changed nothing`);
  }
  // The same presented states at an ORDINARY login keep today's rotation (contract C7; M6AA-S2): it still establishes.
  for (const [label, replaces, over] of cases) {
    const { store: s } = store(answers(over), undefined, () => NOW);
    assert.equal(await answered(s.establish?.(NEW_KEY, ADMIN_RECORD, replaces, LOGIN, live())), 'established', `a login presenting ${label}`);
  }
});

test('M5AR-S6 holdAdministrativeSession holds the live administrative session under a key, or answers undefined before writing anything', async () => {
  const run = async (over: Partial<Record<Step, unknown>>): Promise<{ client: Fake; held: SessionRecord | undefined }> => {
    const client = fakeClient(answers(over));
    const held = await client.transaction(live(), SESSION_STORE_BOUNDS, (sql) => holdAdministrativeSession(sql, KEY, NOW));
    return { client, held };
  };
  const live1 = await run({});
  assert.deepEqual(live1.held, ADMIN_RECORD, 'the record, as read');
  assert.deepEqual(live1.client.statements.map(stepOf), ['get', 'touch']);
  assert.deepEqual(live1.client.values, [[KEY, NOW], [KEY, CREATED]], 'read live at the given instant, then held by writing back the stamp it read');
  assert.match(live1.client.statements[1], /m5_session_touch\(\?::text, 'validatedAt', \?::bigint\)/);
  for (const [label, over, steps] of [
    ['no live session', { get: [] }, ['get']],
    ['a record of another audience', { get: [ROW] }, ['get']],
    ['a session another transaction ended since the read', { touch: [{ outcome: 'absent' }] }, ['get', 'touch']],
  ] as Array<[string, Partial<Record<Step, unknown>>, Step[]]>) {
    const { client, held } = await run(over);
    assert.equal(held, undefined, label);
    assert.deepEqual(client.statements.map(stepOf), steps, `${label}: nothing written`);
  }
  // Every other doubt throws, and the caller's kernel rolls back.
  for (const [label, over, reason] of [
    ['a touch the routine calls invalid', { touch: [{ outcome: 'invalid' }] }, /not_updated/],
    ['two live rows', { get: [ADMIN_ROW, ADMIN_ROW] }, /answer_shape_invalid/],
    ['a malformed record', { get: [{ ...ADMIN_ROW, extra: 1 }] }, /row_shape_invalid/],
  ] as Array<[string, Partial<Record<Step, unknown>>, RegExp]>) {
    await assert.rejects(run(over), reason, label);
  }
  for (const now of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const client = fakeClient(answers());
    await assert.rejects(client.transaction(live(), SESSION_STORE_BOUNDS, (sql) => holdAdministrativeSession(sql, KEY, now)), /clock_invalid/, String(now));
    assert.deepEqual(client.statements, [], `${now}: nothing sent`);
  }
});

test('M7CS-S1 readTenantSession reads the live tenant session and takes no lock; holdTenantSession reads it again and holds it — either answers undefined before writing anything', async () => {
  // M7A-CUSTOMERS-P3: the tenant command's revalidator reads first (to learn the reference whose standing it locks), then holds.
  const run = async (fn: typeof readTenantSession, over: Partial<Record<Step, unknown>>, now = NOW) => {
    const client = fakeClient(answers({ get: [ROW], ...over }));
    const held = await client.transaction(live(), SESSION_STORE_BOUNDS, (sql) => fn(sql, KEY, now));
    return { client, held };
  };
  const read = await run(readTenantSession, {});
  assert.deepEqual(read.held, RECORD, 'the record, as read');
  assert.deepEqual(read.client.statements.map(stepOf), ['get'], 'a read alone: no touch, no lock');
  assert.deepEqual(read.client.values, [[KEY, NOW]]);
  const held = await run(holdTenantSession, {});
  assert.deepEqual(held.held, RECORD);
  assert.deepEqual(held.client.statements.map(stepOf), ['get', 'touch']);
  assert.deepEqual(held.client.values, [[KEY, NOW], [KEY, CREATED]], 'read live at the given instant, then held by writing back the stamp it read');
  for (const [label, over, readSteps, holdSteps] of [
    ['no live session', { get: [] }, ['get'], ['get']],
    ['an administrative record', { get: [ADMIN_ROW] }, ['get'], ['get']],
    ['a session another transaction ended since the read', { touch: [{ outcome: 'absent' }] }, ['get'], ['get', 'touch']],
  ] as Array<[string, Partial<Record<Step, unknown>>, Step[], Step[]]>) {
    const r = await run(readTenantSession, over);
    if (label !== 'a session another transaction ended since the read') assert.equal(r.held, undefined, `read: ${label}`);
    assert.deepEqual(r.client.statements.map(stepOf), readSteps, `read: ${label}`);
    const h = await run(holdTenantSession, over);
    assert.equal(h.held, undefined, `hold: ${label}`);
    assert.deepEqual(h.client.statements.map(stepOf), holdSteps, `hold: ${label}: nothing written`);
  }
  // The administrative twin still refuses a tenant record: each hold serves its own audience only.
  const cross = fakeClient(answers({ get: [ROW] }));
  assert.equal(await cross.transaction(live(), SESSION_STORE_BOUNDS, (sql) => holdAdministrativeSession(sql, KEY, NOW)), undefined);
  // Every other doubt throws, and the caller's kernel rolls back.
  for (const fn of [readTenantSession, holdTenantSession]) {
    for (const [label, over, reason] of [
      ['two live rows', { get: [ROW, ROW] }, /answer_shape_invalid/],
      ['a malformed record', { get: [{ ...ROW, extra: 1 }] }, /row_shape_invalid/],
    ] as Array<[string, Partial<Record<Step, unknown>>, RegExp]>) {
      await assert.rejects(run(fn, over), reason, `${fn.name}: ${label}`);
    }
    for (const now of [0, -1, 1.5, Number.NaN]) {
      const client = fakeClient(answers());
      await assert.rejects(client.transaction(live(), SESSION_STORE_BOUNDS, (sql) => fn(sql, KEY, now)), /clock_invalid/, `${fn.name}: ${now}`);
      assert.deepEqual(client.statements, [], `${fn.name}: ${now}: nothing sent`);
    }
  }
  await assert.rejects(run(holdTenantSession, { touch: [{ outcome: 'invalid' }] }), /not_updated/, 'a touch the routine calls invalid');
});

// --- M5-TENANT-SESSION-P1: the tenant session through the same audited pair ----------------------------

const TENANT_LOGIN: SessionEstablishAudit = LOGIN;
const TENANT_COMMON = { ...COMMON, scope_type: 'none' };

test('M5T-S1 a tenant login is ONE transaction: the standing FIRST, then rotation, the new session and its tenant record at scope none, last', async () => {
  for (const action of ['login', 'reauthenticate'] as const) {
    const { client, store: s, seen } = withStanding(true, { get: [ROW] });
    assert.equal(await answered(s.establish?.(NEW_KEY, RECORD, KEY, { ...TENANT_LOGIN, action }, live())), 'established', action);
    assert.deepEqual(stepsOf(client), ['standing', 'get', 'touch', 'revoke', 'create', 'insert'], `${action}: the admin order, unchanged`);
    assert.equal(seen[0].record, RECORD, `${action}: the check judges the very tenant record`);
    assert.equal(client.bounds.length, 1, `${action}: one transaction`);
    assert.equal(client.values[4][1], 'tenant');
    assert.equal(client.values[4][10], CREATED + SESSION_TTL.tenant.absoluteMs, `${action}: the tenant lifetime`);
    assert.deepEqual(client.values[4][11], tenantMintProof(ISSUER_KEY, NEW_KEY, RECORD, CREATED + SESSION_TTL.tenant.absoluteMs), `${action}: the mint proof`);
    assert.deepEqual(masked(recordSent(client)), {
      ...TENANT_COMMON, actor_internal_user_id: ACTOR, action_id: `tenant.session.${action}`, decision: 'allow',
      reason_code: action === 'login' ? 'tenant_session_created' : 'tenant_session_reauthenticated',
      metadata: { json: { sessionRef: refOf(NEW_KEY), authenticatedAt: CREATED - 1_000, replacedSessionRef: refOf(KEY) } },
    }, `${action}: the tenant family, naming no tenant or store`);
  }
  // A standing that moved writes nothing, exactly as for an administrative record.
  const { client, store: s } = withStanding(false, { get: [ROW] });
  assert.equal(await answered(s.establish?.(NEW_KEY, RECORD, KEY, TENANT_LOGIN, live())), 'standing_changed');
  assert.deepEqual(stepsOf(client), ['standing']);
});

test('M5T-S2 a record of the other audience under the cookie: a tenant reauthentication ends nothing, and a tenant login ends it without naming it replaced', async () => {
  // The same principal's ADMINISTRATIVE session presented at a tenant recent sign-in: the audience must match.
  const reauth = store(answers({ get: [ADMIN_ROW] }), undefined, () => NOW);
  assert.equal(await answered(reauth.store.establish?.(NEW_KEY, RECORD, KEY, { ...TENANT_LOGIN, action: 'reauthenticate' }, live())), 'session_ended');
  assert.deepEqual(reauth.client.statements.map(stepOf), ['get'], 'nothing held, revoked, created or recorded');
  const login = store(answers({ get: [ADMIN_ROW] }), undefined, () => NOW);
  assert.equal(await answered(login.store.establish?.(NEW_KEY, RECORD, KEY, TENANT_LOGIN, live())), 'established');
  assert.deepEqual(login.client.statements.map(stepOf), ['get', 'touch', 'revoke', 'create', 'insert'], 'rotation ends whatever it is presented');
  assert.deepEqual((recordSent(login.client).metadata as { json: unknown }).json, { sessionRef: refOf(NEW_KEY), authenticatedAt: CREATED - 1_000 },
    'no replacedSessionRef: the ended record is not a tenant session');
});

test('M5T-S3 a tenant logout ends the session with its tenant record in one transaction, attributed to no actor', async () => {
  const { client, store: s } = store(answers({ get: [ROW] }), undefined, () => NOW);
  assert.equal(await answered(s.end?.(KEY, LOGOUT, live())), 'ended');
  assert.deepEqual(client.statements.map(stepOf), ['get', 'touch', 'revoke', 'insert']);
  assert.equal(client.bounds.length, 1);
  assert.deepEqual(masked(recordSent(client)), {
    ...TENANT_COMMON, actor_internal_user_id: null, action_id: 'tenant.session.logout', decision: 'not_applicable',
    reason_code: 'tenant_session_ended', metadata: { json: { sessionRef: refOf(KEY) } },
  });
  // Both families' records are checked before anything is sent: a malformed logout entry sends nothing, whatever is live.
  const refused = store(answers({ get: [ROW] }));
  await assert.rejects(answered(refused.store.end?.(KEY, { ...LOGOUT, actor: ACTOR } as never, live())), /audit_invalid/);
  assert.deepEqual(refused.client.statements, []);
});

// --- M7A-CUSTOMERS-P2: the tenant mint (migration 018) --------------------------------------------------

test('M7M-S1 the proof is HMAC-SHA256 over the netstring message and reproduces the recorded vector byte for byte', () => {
  // The vector key is bytes 0x00..0x1f, built here: no key literal is written into this file.
  const vectorKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const created = 1_790_000_000_000;
  const record: SessionRecord = {
    audience: 'tenant', authProvider: 'firebase', authProviderUid: 'uid-Ω-vector', principalKey: 'pk-vector',
    securityVersion: 't2:vector', authenticatedAt: null, createdAt: created, lastSeenAt: created, validatedAt: created,
  };
  const expiresAt = 1_790_028_800_000;
  const message = 'tmpos-tenant-session-mint:v118:session-key-vector,6:tenant,8:firebase,13:uid-Ω-vector,9:pk-vector,9:t2:vector,0:,'
    + '13:1790000000000,13:1790000000000,13:1790000000000,13:1790028800000,';
  assert.equal(Buffer.byteLength(message), 182);
  const proof = tenantMintProof(vectorKey, 'session-key-vector', record, expiresAt);
  assert.deepEqual(proof, createHmac('sha256', vectorKey).update(Buffer.from(message, 'utf8')).digest(), 'the message is the netstring encoding');
  assert.equal(proof.toString('hex'), '54c2bf73916e2d04e33889e948ff9ec4812ea1f054d9895ff282245da79392e4', 'the recorded proof');
  assert.equal(createHmac('sha256', vectorKey).update('tmpos-tenant-issuer-key-fingerprint:v1').digest('hex'),
    'e3cea24acf7070c68bee2a3d19a3040ed203fc23f1d1aeef90ea566a52b5ef15', 'the recorded fingerprint');
  // Every value is covered: changing any one changes the proof.
  const changed: Array<[string, SessionRecord, string, number]> = [
    ['the key', record, 'session-key-vectoR', expiresAt], ['the expiry', record, 'session-key-vector', expiresAt + 1],
    ...(['authProvider', 'authProviderUid', 'principalKey', 'securityVersion'] as const)
      .map((f): [string, SessionRecord, string, number] => [f, { ...record, [f]: `${record[f]}x` }, 'session-key-vector', expiresAt]),
    ...(['createdAt', 'lastSeenAt', 'validatedAt'] as const)
      .map((f): [string, SessionRecord, string, number] => [f, { ...record, [f]: record[f] + 1 }, 'session-key-vector', expiresAt]),
    ['an authentication time', { ...record, authenticatedAt: created }, 'session-key-vector', expiresAt],
  ];
  for (const [label, r, key, at] of changed) assert.notDeepEqual(tenantMintProof(vectorKey, key, r, at), proof, label);
});

test('M7M-S2 a tenant write without the issuer key throws before any statement; an administrative write needs none', async () => {
  const { client, store: s } = store(answers({ get: [ROW] }), undefined, () => NOW, ADMITS, null);
  await assert.rejects(answered(s.create(KEY, RECORD, live())), /session store unavailable: issuer_key_missing/);
  await assert.rejects(answered(s.establish?.(NEW_KEY, RECORD, KEY, TENANT_LOGIN, live())), /session store unavailable: issuer_key_missing/);
  assert.deepEqual(client.statements, [], 'nothing was sent');
  assert.equal(client.bounds.length, 0, 'no transaction opened');
  // The administrative entry never holds the key, and its logins still establish, sending NULL.
  const admin = store(answers(), undefined, () => NOW, ADMITS, null);
  assert.equal(await answered(admin.store.establish?.(NEW_KEY, ADMIN_RECORD, null, LOGIN, live())), 'established');
  assert.equal(admin.client.values[0][11], null);
});

test('M7M-S3 an issuer key of anything but 32-64 bytes is refused at construction, and the store keeps a private copy', async () => {
  for (const bad of [randomBytes(31), randomBytes(65), Buffer.alloc(0), 'k'.repeat(43), [1, 2, 3], null]) {
    assert.throws(() => createPostgresSessionStore({ client: fakeClient([]), issuerKey: bad as never }), TypeError, String((bad as { length?: number })?.length));
  }
  for (const size of [32, 64]) assert.ok(createPostgresSessionStore({ client: fakeClient([]), issuerKey: randomBytes(size) }), `${size} bytes`);
  const given = Buffer.from(ISSUER_KEY);
  const client = fakeClient([{ outcome: 'created' }]);
  const s = createPostgresSessionStore({ client, issuerKey: given });
  given.fill(0);
  await s.create(KEY, RECORD, live());
  assert.deepEqual(client.values[0][11], tenantMintProof(ISSUER_KEY, KEY, RECORD, CREATED + SESSION_TTL.tenant.absoluteMs),
    'a later change to the caller\'s buffer does not change the proof');
});

test('M7M-S4 every mint refusal is the same outage: nothing is issued', async () => {
  for (const outcome of ['refused', 'invalid', 'conflict', null]) {
    await assert.rejects(answered(store([{ outcome }]).store.create(KEY, RECORD, live())), /not_created/, String(outcome));
    const { client, store: s } = store(answers({ get: [ROW], create: [{ outcome }] }), undefined, () => NOW);
    await assert.rejects(answered(s.establish?.(NEW_KEY, RECORD, KEY, TENANT_LOGIN, live())), /not_created/, String(outcome));
    assert.deepEqual(client.statements.map(stepOf), ['get', 'touch', 'revoke', 'create'], `${String(outcome)}: no record, and the kernel rolls back`);
  }
});

test('M7M-S5 probeIssuerKey sends the key\'s fingerprint, never the key, and reads back only the four words', async () => {
  const fingerprint = createHmac('sha256', ISSUER_KEY).update('tmpos-tenant-issuer-key-fingerprint:v1').digest();
  for (const outcome of ['match', 'mismatch', 'absent', 'invalid'] as const) {
    const client = fakeClient([{ outcome }]);
    assert.equal(await probeIssuerKey(client, ISSUER_KEY, live()), outcome);
    assert.equal(client.statements.length, 1);
    assert.match(client.statements[0], /select tmpos_mint\.m7a_issuer_key_check\(\?::bytea\) as outcome/);
    assert.deepEqual(client.values[0], [fingerprint]);
    assert.ok(!(client.values[0][0] as Buffer).equals(ISSUER_KEY), 'not the key');
    assert.deepEqual(client.bounds, [SESSION_STORE_BOUNDS]);
  }
  for (const rows of [[{ outcome: 'MATCH' }], [{ outcome: null }], [], [{ outcome: 'match' }, { outcome: 'match' }], [{ other: 'match' }]]) {
    await assert.rejects(probeIssuerKey(fakeClient(rows), ISSUER_KEY, live()), /session store unavailable/, JSON.stringify(rows));
  }
  await assert.rejects(probeIssuerKey(fakeClient(null, new Error('db.example:5432 refused')), ISSUER_KEY, live()),
    (err: Error) => err.message === 'session store unavailable: store_failed');
  const controller = new AbortController();
  controller.abort();
  const aborted = fakeClient([{ outcome: 'match' }]);
  await assert.rejects(probeIssuerKey(aborted, ISSUER_KEY, controller.signal), /session store unavailable: aborted/);
  for (const bad of [randomBytes(31), randomBytes(65), 'k'.repeat(43)]) {
    const unsent = fakeClient([{ outcome: 'match' }]);
    await assert.rejects(probeIssuerKey(unsent, bad as never, live()), /session store unavailable: issuer_key_invalid/);
    assert.deepEqual(unsent.statements, []);
  }
  assert.deepEqual(aborted.statements, [], 'an aborted probe sends nothing');
});

test('M7M-S6 probeSessionMint calls 018\'s mint with every argument null and is true only for its answer invalid', async () => {
  const client = fakeClient([{ outcome: 'invalid' }]);
  assert.equal(await probeSessionMint(client, live()), true);
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], /select tmpos_mint\.m7a_session_create\(null::text, null::text, null::text, null::text, null::text, null::text,\s+null::bigint, null::bigint, null::bigint, null::bigint, null::bigint, null::bytea\) as outcome/);
  assert.deepEqual(client.values[0], [], 'nothing is bound: no key, record or proof is sent');
  assert.deepEqual(client.bounds, [SESSION_STORE_BOUNDS]);
  // Any other word, a row out of shape, no row, or a fault (a withdrawn EXECUTE included) is not ready — never a throw.
  for (const rows of [[{ outcome: 'created' }], [{ outcome: 'refused' }], [{ outcome: 'conflict' }], [{ outcome: 'INVALID' }], [{ outcome: null }],
    [], [{ outcome: 'invalid' }, { outcome: 'invalid' }], [{ other: 'invalid' }]]) {
    assert.equal(await probeSessionMint(fakeClient(rows), live()), false, JSON.stringify(rows));
  }
  assert.equal(await probeSessionMint(fakeClient(null, new Error('permission denied for function m7a_session_create')), live()), false);
  const controller = new AbortController();
  controller.abort();
  const aborted = fakeClient([{ outcome: 'invalid' }]);
  assert.equal(await probeSessionMint(aborted, controller.signal), false);
  assert.deepEqual(aborted.statements, [], 'an aborted probe sends nothing');
});
