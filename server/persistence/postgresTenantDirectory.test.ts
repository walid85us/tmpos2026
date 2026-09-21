// Phase 4.0 M5-GIAM-D1-P3 — the PostgreSQL tenant directory adapter: what it hands migration 012's routine, and what it
// refuses to read back as a page. DATABASE-FREE; the routine itself is proved against a real cluster
// (tests/db/tenantDirectory.integration.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { TENANT_DIRECTORY_BOUNDS, TENANT_DIRECTORY_DEADLINE_MS, createPostgresTenantDirectory } from './postgresTenantDirectory.js';
import type { PgTransactionScope, SupervisedPgClient } from './supervisedPgClient.js';
import type { TrustedScope } from '../runtime/principals.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
const T = (i: number): string => `2222222${i}-2222-4222-8222-22222222222${i}`;
const SCOPE: TrustedScope = Object.freeze({
  actor: ACTOR, securityVersion: 'a'.repeat(64), scope: 'platform', tenant: null, store: null, membershipId: MEMBERSHIP, roleId: 'billing_admin', limitation: 'read_only',
});

const tenantRow = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ o_outcome: 'tenant', o_tenant_id: T(i), o_display_name: `Tenant ${i}`, o_status: 'active', o_version: String(i), ...over });
const refusalRow = (outcome: string): Record<string, unknown> =>
  ({ o_outcome: outcome, o_tenant_id: null, o_display_name: null, o_status: null, o_version: null });

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

test('one fixed call to migration 012\'s routine: the trusted scope\'s four facts, the continuation and one row more than the page', async () => {
  const client = fakeClient([tenantRow(1), tenantRow(2)]);
  const answer = await createPostgresTenantDirectory({ client }).page(SCOPE, { after: T(9), limit: 2 }, live());
  assert.equal(client.statements.length, 1);
  assert.match(client.statements[0], /from tmpos_directory\.m5_tenant_directory_page\(\?::uuid, \?::text,\s+\?::uuid, \?::text, \?::uuid, \?::integer\)/);
  assert.deepEqual(client.values[0], [ACTOR, 'a'.repeat(64), MEMBERSHIP, 'billing_admin', T(9), 3], 'actor, security version, membership, role, after, limit + 1');
  assert.deepEqual(client.bounds, [TENANT_DIRECTORY_BOUNDS]);
  assert.deepEqual(TENANT_DIRECTORY_BOUNDS, { lock: '2100ms', statement: '2700ms', idle: '6000ms' });
  assert.equal(TENANT_DIRECTORY_DEADLINE_MS, 3_000);
  assert.deepEqual(answer, {
    outcome: 'page', hasMore: false,
    tenants: [
      { tenantId: T(1), displayName: 'Tenant 1', status: 'active', version: 1 },
      { tenantId: T(2), displayName: 'Tenant 2', status: 'active', version: 2 },
    ],
  });
});

test('the lookahead row says another page follows and is never returned; an empty directory is an empty page', async () => {
  const full = await createPostgresTenantDirectory({ client: fakeClient([tenantRow(1), tenantRow(2), tenantRow(3)]) }).page(SCOPE, { after: null, limit: 2 }, live());
  assert.deepEqual(full, {
    outcome: 'page', hasMore: true,
    tenants: [
      { tenantId: T(1), displayName: 'Tenant 1', status: 'active', version: 1 },
      { tenantId: T(2), displayName: 'Tenant 2', status: 'active', version: 2 },
    ],
  });
  assert.deepEqual(await createPostgresTenantDirectory({ client: fakeClient([]) }).page(SCOPE, { after: null, limit: 25 }, live()),
    { outcome: 'page', tenants: [], hasMore: false });
  const client = fakeClient([tenantRow(1, { o_display_name: null })]);
  assert.deepEqual(await createPostgresTenantDirectory({ client }).page(SCOPE, { after: null, limit: 25 }, live()),
    { outcome: 'page', tenants: [{ tenantId: T(1), displayName: null, status: 'active', version: 1 }], hasMore: false }, 'a name never set stays null');
  assert.equal(client.values[0][4], null, 'no continuation is sent as SQL null');
});

test('denied and cursor_unknown are the routine\'s only row, with every other column null', async () => {
  for (const outcome of ['denied', 'cursor_unknown']) {
    assert.deepEqual(await createPostgresTenantDirectory({ client: fakeClient([refusalRow(outcome)]) }).page(SCOPE, { after: T(1), limit: 5 }, live()), { outcome });
  }
});

test('everything out of shape is a throw — an outage the route answers as a 503 — never a page and never a refusal', async () => {
  const cases: Array<[string, unknown]> = [
    ['not an array', { rows: [] }],
    ['a refusal beside a tenant', [refusalRow('denied'), tenantRow(1)]],
    ['a tenant beside a refusal', [tenantRow(1), refusalRow('denied')]],
    ['invalid, the malformed-argument answer', [refusalRow('invalid')]],
    ['an unknown outcome', [refusalRow('granted')]],
    ['a refusal carrying a tenant', [{ ...refusalRow('denied'), o_tenant_id: T(1) }]],
    ['a missing column', [{ o_outcome: 'tenant', o_tenant_id: T(1), o_display_name: 'x', o_status: 'active' }]],
    ['an extra column', [{ ...tenantRow(1), o_access_version: '3' }]],
    ['an uppercase id', [tenantRow(1, { o_tenant_id: T(1).replace(/2/g, 'A') })]],
    ['a non-UUID id', [tenantRow(1, { o_tenant_id: 'tenant' })]],
    ['a numeric name', [tenantRow(1, { o_display_name: 5 })]],
    ['a null status', [tenantRow(1, { o_status: null })]],
    ['a numeric version', [tenantRow(1, { o_version: 1 })]],
    ['version zero', [tenantRow(1, { o_version: '0' })]],
    ['a padded version', [tenantRow(1, { o_version: '01' })]],
    ['an unsafe version', [tenantRow(1, { o_version: '9007199254740993' })]],
    ['a version past 16 digits', [tenantRow(1, { o_version: '12345678901234567' })]],
    ['more rows than limit + 1', [tenantRow(1), tenantRow(2), tenantRow(3), tenantRow(4)]],
    ['a malformed lookahead row', [tenantRow(1), tenantRow(2), refusalRow('denied')]],
    ['a lookahead row with a null id', [tenantRow(1), tenantRow(2), tenantRow(3, { o_tenant_id: null })]],
    ['a lookahead row with a bad version', [tenantRow(1), tenantRow(2), tenantRow(3, { o_version: '0' })]],
    ['a lookahead row repeating a tenant', [tenantRow(1), tenantRow(2), tenantRow(2)]],
    ['a repeated tenant', [tenantRow(1), tenantRow(1)]],
    ['a row that is not an object', ['tenant']],
  ];
  for (const [label, rows] of cases) {
    await assert.rejects(createPostgresTenantDirectory({ client: fakeClient(rows) }).page(SCOPE, { after: null, limit: 2 }, live()) as Promise<unknown>,
      (err: unknown) => err instanceof Error && err.message === 'tenant directory answer invalid', label);
  }
  // A driver error propagates as the outage it is; its text is the route's to discard.
  await assert.rejects(createPostgresTenantDirectory({ client: fakeClient([], new Error('driver')) }).page(SCOPE, { after: null, limit: 2 }, live()) as Promise<unknown>, /driver/);
});

test('only the platform scope the authorizer selected is an authority, and only a validated query reaches the database', async () => {
  const bad: Array<[string, unknown, unknown]> = [
    ['a tenant scope', { ...SCOPE, scope: 'tenant', tenant: T(1) }, { after: null, limit: 2 }],
    ['a malformed scope', { ...SCOPE, actor: 'nobody' }, { after: null, limit: 2 }],
    ['no scope', null, { after: null, limit: 2 }],
    ['limit 0', SCOPE, { after: null, limit: 0 }],
    ['limit 51', SCOPE, { after: null, limit: 51 }],
    ['a fractional limit', SCOPE, { after: null, limit: 1.5 }],
    ['a malformed continuation', SCOPE, { after: 'x', limit: 2 }],
    ['an uppercase continuation', SCOPE, { after: T(1).replace(/2/g, 'A'), limit: 2 }],
  ];
  for (const [label, scope, query] of bad) {
    const client = fakeClient([]);
    await assert.rejects(createPostgresTenantDirectory({ client }).page(scope as TrustedScope, query as never, live()) as Promise<unknown>, /answer invalid/, label);
    assert.equal(client.statements.length, 0, `${label}: nothing reached the database`);
  }
});
