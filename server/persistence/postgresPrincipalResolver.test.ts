// Phase 4.0 M5-ID-P1 — the PostgreSQL principal resolver: bounded outcomes, nothing trusted that the
// routine did not say, and no fallback of any kind.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresPrincipalResolver, revalidateTrustedScope } from './postgresPrincipalResolver.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import type { TrustedScope } from '../runtime/principals.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const VERSION = 'a'.repeat(64);
const PRINCIPAL = Object.freeze({ authProvider: 'firebase', authProviderUid: 'uid-alpha' });

const RESOLVED_ROW = Object.freeze({
  outcome: 'resolved', actor_id: ACTOR, account_status: 'active', limitation: 'none',
  security_version: VERSION, memberships: [{
    membershipId: MEMBERSHIP, scopeType: 'platform', tenantId: null, storeId: null,
    roleId: 'system_owner', tenantStatus: null, storeStatus: null,
  }],
});

const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: VERSION, scope: 'platform', tenant: null, store: null,
  roleId: 'system_owner', limitation: 'none',
});

/** A client that answers every statement from `rows` (or throws `fault`), recording what it was asked. */
function fakeClient(rows: unknown, fault?: Error): SupervisedPgClient & { readonly statements: string[] } {
  const statements: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(strings.join('?'));
    void values;
    if (fault) return Promise.reject(fault);
    return Promise.resolve(rows as never);
  }) as unknown as PgTransactionScope;
  return Object.freeze({
    statements,
    transaction: (<T>(_s: AbortSignal, _b: unknown, work: (h: PgTransactionScope) => Promise<T>) => work(sql)) as never,
    end: async () => undefined,
  }) as never;
}

const live = (): AbortSignal => new AbortController().signal;

test('a resolved row becomes a trusted principal, and the provider reference never comes back with it', async () => {
  const client = fakeClient([RESOLVED_ROW]);
  const answer = await createPostgresPrincipalResolver({ client }).resolve(PRINCIPAL, live());
  assert.deepEqual(answer, {
    outcome: 'resolved',
    principal: {
      actor: ACTOR, accountStatus: 'active', limitation: 'none', securityVersion: VERSION,
      memberships: [{
        membershipId: MEMBERSHIP, scopeType: 'platform', tenant: null, store: null,
        roleId: 'system_owner', tenantStatus: null, storeStatus: null,
      }],
    },
  });
  assert.equal(JSON.stringify(answer).includes('uid-alpha'), false, 'no provider reference crosses the port');
  // The reference is a bound parameter, never spliced into the statement text.
  assert.equal(client.statements.join('').includes('uid-alpha'), false);
  assert.equal(client.statements.length, 1, 'one statement, one round trip');
});

test("a refusal is the routine's, and a malformed answer is an outage — never a principal", async () => {
  const cases: [string, unknown, 'refused' | 'unavailable'][] = [
    ['the routine refused', [{ ...RESOLVED_ROW, outcome: 'refused', actor_id: null, memberships: null }], 'refused'],
    ['no row at all', [], 'unavailable'],
    ['two rows', [RESOLVED_ROW, RESOLVED_ROW], 'unavailable'],
    ['an unknown outcome', [{ ...RESOLVED_ROW, outcome: 'maybe' }], 'unavailable'],
    ['an extra column', [{ ...RESOLVED_ROW, smuggled: true }], 'unavailable'],
    ['a missing column', [{ outcome: 'resolved', actor_id: ACTOR }], 'unavailable'],
    ['an actor that is not a uuid', [{ ...RESOLVED_ROW, actor_id: 'root' }], 'unavailable'],
    ['a version with a space', [{ ...RESOLVED_ROW, security_version: 'v 1' }], 'unavailable'],
    ['a limitation outside the two', [{ ...RESOLVED_ROW, limitation: 'partial' }], 'unavailable'],
    ['memberships that are not an array', [{ ...RESOLVED_ROW, memberships: '[]' }], 'unavailable'],
    ['a membership with an extra key', [{ ...RESOLVED_ROW, memberships: [{ ...RESOLVED_ROW.memberships[0], extra: 1 }] }], 'unavailable'],
    ['a membership missing a key', [{ ...RESOLVED_ROW, memberships: [{ membershipId: MEMBERSHIP }] }], 'unavailable'],
    ['a platform grant carrying a tenant', [{ ...RESOLVED_ROW, memberships: [{ ...RESOLVED_ROW.memberships[0], tenantId: TENANT }] }], 'unavailable'],
    ['the whole answer replaced', ['resolved'], 'unavailable'],
  ];
  for (const [label, rows, expected] of cases) {
    const answer = await createPostgresPrincipalResolver({ client: fakeClient(rows) }).resolve(PRINCIPAL, live());
    assert.equal((answer as { outcome: string }).outcome, expected, label);
  }
});

test('a reference the routine could not accept is refused without a statement', async () => {
  for (const principal of [
    { authProvider: 'google', authProviderUid: 'x' },
    { authProvider: 'firebase', authProviderUid: '' },
    { authProvider: 'firebase', authProviderUid: 'x'.repeat(256) },
    { authProvider: 'Firebase', authProviderUid: 'x' },
    { authProviderUid: 'x' }, { authProvider: 'firebase' }, null,
  ]) {
    const client = fakeClient([RESOLVED_ROW]);
    const answer = await createPostgresPrincipalResolver({ client }).resolve(principal as never, live());
    assert.deepEqual(answer, { outcome: 'refused' }, JSON.stringify(principal));
    assert.equal(client.statements.length, 0, 'the database is never asked');
  }
});

test('an outage, an abort or a driver fault answers unavailable and discloses nothing', async () => {
  const faulty = fakeClient([], new Error('FATAL: password authentication failed for user "tmpos_runtime"'));
  const answer = await createPostgresPrincipalResolver({ client: faulty }).resolve(PRINCIPAL, live());
  assert.deepEqual(answer, { outcome: 'unavailable' });
  assert.equal(JSON.stringify(answer).includes('password'), false, 'no driver message survives the boundary');

  const aborted = new AbortController();
  aborted.abort();
  const client = fakeClient([RESOLVED_ROW]);
  assert.deepEqual(await createPostgresPrincipalResolver({ client }).resolve(PRINCIPAL, aborted.signal), { outcome: 'unavailable' });
  assert.equal(client.statements.length, 0, 'an already-aborted call opens nothing');
});

test('readiness is the routine answering, not a connection existing', async () => {
  assert.equal(await createPostgresPrincipalResolver({ client: fakeClient([{ outcome: 'refused' }]) }).probe(live()), true);
  for (const rows of [[{ outcome: 'resolved' }], [], [{ outcome: 'refused' }, { outcome: 'refused' }]]) {
    assert.equal(await createPostgresPrincipalResolver({ client: fakeClient(rows) }).probe(live()), false, JSON.stringify(rows));
  }
  assert.equal(await createPostgresPrincipalResolver({ client: fakeClient([], new Error('down')) }).probe(live()), false);
});

test('revalidation answers the still-granted role, and one value for every failure', async () => {
  const handle = (rows: unknown): PgTransactionScope =>
    (() => Promise.resolve(rows as never)) as unknown as PgTransactionScope;

  assert.equal(await revalidateTrustedScope(handle([{ outcome: 'valid', granted_role_id: 'system_owner' }]), SCOPE), 'system_owner');
  for (const rows of [
    [{ outcome: 'invalid', granted_role_id: null }],
    [{ outcome: 'valid', granted_role_id: null }],
    [{ outcome: 'valid', granted_role_id: '' }],
    [{ outcome: 'valid', granted_role_id: 'x'.repeat(65) }],
    [{ outcome: 'valid', granted_role_id: 'system_owner', extra: 1 }],
    [], [{ outcome: 'valid', granted_role_id: 'a' }, { outcome: 'valid', granted_role_id: 'b' }],
  ]) assert.equal(await revalidateTrustedScope(handle(rows), SCOPE), null, JSON.stringify(rows));

  // A scope that selection could not have produced is never sent to the database at all.
  let asked = false;
  const watching = ((): Promise<never> => { asked = true; return Promise.resolve([] as never); }) as unknown as PgTransactionScope;
  assert.equal(await revalidateTrustedScope(watching, { ...SCOPE, actor: 'root' } as TrustedScope), null);
  assert.equal(asked, false);
});
