// Phase 4.0 M7B-INVOICES-ISSUE-P1 — a store's issuing settings through the runtime, DATABASE-FREE: the write's contract as the
// runtime registers it, its planner's closed input (every field, -0, fractions, out-of-range, extra keys, the tax shapes, the
// text rules with the postal address's LF rule, Bidi and controls), its response and audit annex; the read route's
// declaration, its strict answer validation and each handler outcome. Synthetic ports only. The PostgreSQL side is proved
// in server/persistence/postgresInvoiceIssuing.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import { defineCommands } from './commandTransaction.js';
import type { CommandTransactionPort, TransactionCommand } from './commandTransaction.js';
import { TEST_IDEMPOTENCY_KEY, createMemoryIdempotencyStore } from './idempotencyStore.testkit.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import {
  ISSUING_SETTINGS_PATH, ISSUING_SETTINGS_REQUIREMENT, ISSUING_SETTINGS_UPDATE_CONTRACT, ISSUING_SETTINGS_UPDATE_ROUTE, createIssuingSettingsReadRoute,
  issuingSettingsAuditOf, issuingSettingsOf, normalizePostalAddress, planIssuingSettingsUpdate, postalAddressLinesOf, taxSettingOf,
} from './issuingSettings.js';
import type { IssuingSettingsReadPort } from './issuingSettings.js';
import { defineOutboxEvents } from './outbox.js';
import type { TrustedScope } from './principals.js';
import { COMMAND_REQUEST_INVALID, EnforcementSetupError, sessionPaths } from './routes.js';

const MAX = Number.MAX_SAFE_INTEGER;
const TENANT = randomUUID();
const STORE = randomUUID();
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
const body = (over: Record<string, unknown> = {}) => ({
  expectedTenant: TENANT, expectedVersion: 0, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield, IL 62701',
  taxRegistrationId: 'TX-12345', tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 }, ...over,
});
const plan = (b: unknown, targetId: string | null = STORE) =>
  planIssuingSettingsUpdate(Object.freeze({ audience: 'tenant' as const, body: b, newAggregateId: randomUUID(), ...(targetId === null ? {} : { targetId }) }));
const planned = (b: unknown) => {
  const p = plan(b);
  assert.notEqual(p, COMMAND_REQUEST_INVALID, JSON.stringify(b));
  return p as Exclude<typeof p, typeof COMMAND_REQUEST_INVALID>;
};

// --- 1. the contract and the routes as the runtime registers them ---------------------------------------------------------

test('ISS-S01 the write is a tenant-scope create of its own aggregate, no event, the address one rows field of lines; it registers', () => {
  const commands = defineCommands([ISSUING_SETTINGS_UPDATE_CONTRACT], defineOutboxEvents([]));
  const contract = commands.contract('tenant.issuing_settings.update');
  assert.ok(contract !== undefined);
  assert.deepEqual([contract.mode, contract.aggregateType, contract.contextScope, contract.events], ['create', 'store_issuing_settings_change', 'tenant', []]);
  assert.deepEqual(Object.keys(contract.changes).sort(), ['expectedTenant', 'expectedVersion', 'hasTaxRegistrationId', 'legalName', 'postalAddress', 'storeId',
    'storeName', 'taxMode', 'taxRateMilliPercent', 'taxRegistrationId']);
  assert.deepEqual(contract.changes.postalAddress, { type: 'rows', maxRows: 8, fields: { line: { type: 'string', maxLength: 240 } } });
  assert.deepEqual(contract.changes.expectedVersion, { type: 'integer', min: 0, max: MAX - 1 });
  assert.deepEqual(contract.changes.taxRateMilliPercent, { type: 'integer', min: 0, max: 100_000 });
  assert.deepEqual(contract.changes.taxMode, { type: 'enum', values: ['exclusive_rate', 'none'] });
  assert.deepEqual([contract.changes.legalName, contract.changes.storeName, contract.changes.taxRegistrationId],
    [{ type: 'string', maxLength: 400 }, { type: 'string', maxLength: 240 }, { type: 'string', maxLength: 128 }]);
});

test('ISS-S02 the routes: PUT and GET on the tenant template, the owner-only tenant permission; the write under a key on a recent sign-in, the read session-bound without one', () => {
  assert.equal(ISSUING_SETTINGS_PATH, '/api/v1/issuing-settings/{id}');
  assert.deepEqual(ISSUING_SETTINGS_REQUIREMENT, { scope: 'tenant', permission: 'edit_issuing_settings' });
  const w = ISSUING_SETTINGS_UPDATE_ROUTE;
  assert.deepEqual([w.method, w.path, w.body, w.idempotency, w.trustedContext, w.recentAuth, w.sessionBinding],
    ['PUT', ISSUING_SETTINGS_PATH, { kind: 'json', maxBytes: 8192, required: true }, 'required', 'required', 'required', undefined]);
  assert.deepEqual(w.policy, { access: 'session', audience: 'tenant', authorization: ISSUING_SETTINGS_REQUIREMENT });
  assert.ok('command' in w && w.command.contract === ISSUING_SETTINGS_UPDATE_CONTRACT && Object.isFrozen(w));
  const r = createIssuingSettingsReadRoute({ issuingSettings: { settings: () => ({ outcome: 'denied' }) } });
  assert.deepEqual([r.method, r.path, r.body, r.idempotency, r.trustedContext, r.recentAuth, r.sessionBinding],
    ['GET', ISSUING_SETTINGS_PATH, { kind: 'none' }, 'none', 'required', 'none', 'required']);
  assert.deepEqual(r.policy, { access: 'session', audience: 'tenant', authorization: ISSUING_SETTINGS_REQUIREMENT });
  assert.throws(() => createIssuingSettingsReadRoute({} as never), (e: unknown) => e instanceof EnforcementSetupError && e.code === 'route_handler_invalid');
  assert.throws(() => createIssuingSettingsReadRoute({ issuingSettings: { settings: () => null } }, { deadlineMs: 3_001 }),
    (e: unknown) => e instanceof EnforcementSetupError && e.code === 'port_deadline_invalid');
});

// --- 2. the planner --------------------------------------------------------------------------------------------------------

test('ISS-S03 a rate-mode write: the path store, the preconditions and normalized values, the address as lines, no event, the 200 at expectedVersion + 1, the audit annex', () => {
  const p = planned(body({ legalName: '  Acme Repairs LLC ', postalAddress: '  1 Main St  \n  Springfield, IL 62701 \n' }));
  assert.equal(p.expectedVersion, null);
  assert.deepEqual(p.changes, {
    storeId: STORE, expectedTenant: TENANT, expectedVersion: 0, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown',
    postalAddress: [{ line: '1 Main St' }, { line: 'Springfield, IL 62701' }], hasTaxRegistrationId: true, taxRegistrationId: 'TX-12345',
    taxMode: 'exclusive_rate', taxRateMilliPercent: 8875,
  });
  assert.deepEqual(p.events, []);
  assert.deepEqual(p.response, { status: 200, body: { issuingSettings: {
    storeId: STORE, version: 1, configured: true, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield, IL 62701',
    taxRegistrationId: 'TX-12345', tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 },
  } } });
  assert.deepEqual(p.audit, { reasonCode: 'issuing_settings_tax_exclusive_rate', reason: 'Issuing settings version 1: exclusive tax at 8875 thousandths of a percent.' });
  assert.ok(!JSON.stringify(p.audit).includes('Acme'), 'no seller text in the audit annex');
});

test('ISS-S04 a no-tax write without a registration id: none is not a zero rate; every accepted write is a new version, even an identical one', () => {
  const none = planned(body({ expectedVersion: 7, taxRegistrationId: null, tax: { mode: 'none' } }));
  assert.deepEqual([none.changes.hasTaxRegistrationId, none.changes.taxRegistrationId, none.changes.taxMode, none.changes.taxRateMilliPercent], [false, '', 'none', 0]);
  assert.deepEqual((none.response.body as { issuingSettings: unknown }).issuingSettings, {
    storeId: STORE, version: 8, configured: true, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield, IL 62701',
    taxRegistrationId: null, tax: { mode: 'none' },
  });
  assert.deepEqual(none.audit, { reasonCode: 'issuing_settings_tax_none', reason: 'Issuing settings version 8: no tax calculated.' });
  const zero = planned(body({ expectedVersion: 7, tax: { mode: 'exclusive_rate', rateMilliPercent: 0 } }));
  assert.deepEqual([zero.changes.taxMode, zero.changes.taxRateMilliPercent, zero.audit?.reasonCode], ['exclusive_rate', 0, 'issuing_settings_tax_exclusive_rate']);
  // The same values twice: two plans, each its own new aggregate, each one version on — there is no no-op answer.
  const again = planned(body({ expectedVersion: 8, taxRegistrationId: null, tax: { mode: 'none' } }));
  assert.equal((again.response.body as { issuingSettings: { version: number } }).issuingSettings.version, 9);
  assert.equal('unchanged' in again, false);
  assert.notEqual(again.aggregateId, none.aggregateId);
  assert.equal(issuingSettingsAuditOf(MAX, { mode: 'exclusive_rate', rateMilliPercent: 100_000 }).reason, `Issuing settings version ${MAX}: exclusive tax at 100000 thousandths of a percent.`);
});

test('ISS-S05 every field refused: keys, the target, the tenant, the version (-0, fractions, out of range), the tax shapes, and each text rule', () => {
  const bad: Array<[string, unknown]> = [
    ['not an object', 'x'], ['an array', [body()]], ['null', null],
    ['an extra key', { ...body(), extra: 1 }], ['currency', { ...body(), currency: 'USD' }],
    ...(['expectedTenant', 'expectedVersion', 'legalName', 'storeName', 'postalAddress', 'taxRegistrationId', 'tax'] as const)
      .map((k): [string, unknown] => [`no ${k}`, Object.fromEntries(Object.entries(body()).filter(([key]) => key !== k))]),
    ['tenant uppercase', body({ expectedTenant: TENANT.toUpperCase() })], ['tenant not a uuid', body({ expectedTenant: 'tenant' })],
    ['version -0', body({ expectedVersion: -0 })], ['version -1', body({ expectedVersion: -1 })], ['version 1.5', body({ expectedVersion: 1.5 })],
    ['version 2^53 - 1', body({ expectedVersion: MAX })], ['version a string', body({ expectedVersion: '0' })], ['version null', body({ expectedVersion: null })],
    ['tax null', body({ tax: null })], ['tax a string', body({ tax: 'none' })], ['tax unknown mode', body({ tax: { mode: 'inclusive_rate', rateMilliPercent: 1 } })],
    ['none with a rate', body({ tax: { mode: 'none', rateMilliPercent: 0 } })], ['exclusive without a rate', body({ tax: { mode: 'exclusive_rate' } })],
    ['a tax extra key', body({ tax: { mode: 'exclusive_rate', rateMilliPercent: 1, label: 'Tax' } })],
    ['rate -0', body({ tax: { mode: 'exclusive_rate', rateMilliPercent: -0 } })], ['rate -1', body({ tax: { mode: 'exclusive_rate', rateMilliPercent: -1 } })],
    ['rate 8.875', body({ tax: { mode: 'exclusive_rate', rateMilliPercent: 8.875 } })], ['rate 100001', body({ tax: { mode: 'exclusive_rate', rateMilliPercent: 100_001 } })],
    ['rate a string', body({ tax: { mode: 'exclusive_rate', rateMilliPercent: '8875' } })], ['rate NaN', body({ tax: { mode: 'exclusive_rate', rateMilliPercent: Number.NaN } })],
    ['legal name empty', body({ legalName: '' })], ['legal name spaces', body({ legalName: '   ' })], ['legal name 201', body({ legalName: 'a'.repeat(201) })],
    ['legal name invisible', body({ legalName: ch(0x200b) })], ['legal name NUL', body({ legalName: `A${ch(0)}B` })], ['legal name LF', body({ legalName: 'A\nB' })],
    ['legal name DEL', body({ legalName: `A${ch(0x7f)}` })], ['legal name C1', body({ legalName: `A${ch(0x85)}B` })], ['legal name LS', body({ legalName: `A${ch(0x2028)}B` })],
    ['legal name Bidi', body({ legalName: `A${ch(0x202e)}B` })], ['legal name lone surrogate', body({ legalName: `A${String.fromCharCode(0xd800)}` })],
    ['legal name a number', body({ legalName: 5 })], ['store name 121', body({ storeName: 'b'.repeat(121) })], ['store name Bidi', body({ storeName: `S${ch(0x2066)}` })],
    ['tax id empty', body({ taxRegistrationId: '' })], ['tax id spaces', body({ taxRegistrationId: '  ' })], ['tax id 65', body({ taxRegistrationId: 'c'.repeat(65) })],
    ['tax id a number', body({ taxRegistrationId: 12345 })], ['tax id control', body({ taxRegistrationId: `T${ch(9)}X` })],
    ['address empty', body({ postalAddress: '' })], ['address 9 lines', body({ postalAddress: Array(9).fill('x').join('\n') })],
    ['address an empty line', body({ postalAddress: 'a\n\nb' })], ['address a blank line', body({ postalAddress: 'a\n   \nb' })],
    ['address CRLF', body({ postalAddress: 'a\r\nb' })], ['address a trailing CR', body({ postalAddress: 'a\nb\r' })], ['address a lone CR', body({ postalAddress: 'a\rb' })],
    ['address a 121 line', body({ postalAddress: `a\n${'d'.repeat(121)}` })], ['address a tab inside', body({ postalAddress: 'a\tb' })],
    ['address Bidi in a line', body({ postalAddress: `a\nb${ch(0x200f)}c` })], ['address LS in a line', body({ postalAddress: `a${ch(0x2029)}b\nc` })],
    ['address an invisible line', body({ postalAddress: `a\n${ch(0x2800)}` })], ['address not a string', body({ postalAddress: ['a', 'b'] })],
  ];
  for (const [label, b] of bad) assert.equal(plan(b), COMMAND_REQUEST_INVALID, label);
  for (const target of [null, 'not-a-uuid', STORE.toUpperCase()]) assert.equal(plan(body(), target), COMMAND_REQUEST_INVALID, `target ${target}`);
});

test('ISS-S06 the bounds hold exactly: 200, 120 and 64 scalars (astral scalars counted once), 8 lines of 120, version 2^53 - 2, rate 100000', () => {
  const astral = ch(0x1f600);
  const p = planned(body({
    expectedVersion: MAX - 1, legalName: astral.repeat(200), storeName: 'e'.repeat(120), taxRegistrationId: astral.repeat(64),
    postalAddress: Array.from({ length: 8 }, (_, i) => `${i}${'f'.repeat(119)}`).join('\n'), tax: { mode: 'exclusive_rate', rateMilliPercent: 100_000 },
  }));
  assert.equal((p.changes.postalAddress as unknown[]).length, 8);
  assert.equal((p.response.body as { issuingSettings: { version: number } }).issuingSettings.version, MAX);
  assert.equal((p.changes.legalName as string).length, 400, 'within the change set\'s 400 UTF-16 units');
  // An address of one line is a single line, with no LF.
  assert.deepEqual(planned(body({ postalAddress: ' Only line ' })).changes.postalAddress, [{ line: 'Only line' }]);
});

test('ISS-S07 the value helpers: the address normalizer and its lines, the tax setting parser', () => {
  assert.equal(normalizePostalAddress('\n  a  \n b\n'), 'a\nb', 'the whole value trimmed, then each line');
  assert.deepEqual(postalAddressLinesOf('a\nb'), ['a', 'b']);
  assert.equal(postalAddressLinesOf('a\r'), null, 'a CR is refused, never trimmed away');
  assert.equal(postalAddressLinesOf(7), null);
  assert.deepEqual(taxSettingOf({ mode: 'none' }), { mode: 'none' });
  assert.deepEqual(taxSettingOf({ rateMilliPercent: 5, mode: 'exclusive_rate' }), { mode: 'exclusive_rate', rateMilliPercent: 5 });
  const hostile = { mode: 'none', get rateMilliPercent(): never { throw new Error('getter'); } };
  assert.equal(taxSettingOf(hostile), null, 'a throwing getter is never a setting');
  assert.equal(taxSettingOf(Object.assign(Object.create({ inherited: 1 }), { mode: 'none' })), null, 'only a plain object');
});

// --- 3. the read -----------------------------------------------------------------------------------------------------------

const CONFIGURED = Object.freeze({
  storeId: STORE, version: 3, configured: true, legalName: 'Acme Repairs LLC', storeName: 'Acme Downtown', postalAddress: '1 Main St\nSpringfield',
  taxRegistrationId: null, tax: { mode: 'exclusive_rate', rateMilliPercent: 8875 },
});

test('ISS-S08 the read\'s answer: the none view and a configured one pass; anything out of shape is null', () => {
  assert.deepEqual(issuingSettingsOf({ outcome: 'settings', issuingSettings: { storeId: STORE, version: 0, configured: false } }, STORE),
    { storeId: STORE, version: 0, configured: false });
  assert.deepEqual(issuingSettingsOf({ outcome: 'settings', issuingSettings: CONFIGURED }, STORE), CONFIGURED);
  assert.equal(issuingSettingsOf({ outcome: 'denied' }, STORE), 'denied');
  assert.equal(issuingSettingsOf({ outcome: 'not_found' }, STORE), 'not_found');
  const bad: unknown[] = [
    null, [], { outcome: 'denied', extra: 1 }, { outcome: 'none' }, { outcome: 'settings' },
    { outcome: 'settings', issuingSettings: { storeId: STORE, version: 1, configured: false } },
    { outcome: 'settings', issuingSettings: { storeId: STORE, version: -0, configured: false } },
    { outcome: 'settings', issuingSettings: { storeId: STORE, version: 0, configured: false, legalName: 'x' } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, storeId: randomUUID() } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, version: 0 } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, version: MAX + 1 } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, legalName: ' padded' } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, postalAddress: 'a\n\nb' } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, taxRegistrationId: '' } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, tax: { mode: 'none', rateMilliPercent: 0 } } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, tax: { mode: 'exclusive_rate', rateMilliPercent: 100_001 } } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, extra: true } },
    { outcome: 'settings', issuingSettings: { ...CONFIGURED, configured: 'yes' } },
  ];
  for (const raw of bad) assert.equal(issuingSettingsOf(raw, STORE), null, JSON.stringify(raw));
});

const OWNER_SCOPE: TrustedScope = Object.freeze({
  actor: randomUUID(), securityVersion: 'sv', scope: 'tenant', tenant: TENANT, store: null, membershipId: randomUUID(), roleId: 'store_owner', limitation: 'none',
});
const KEY = 'k'.repeat(43);

async function readOnce(port: IssuingSettingsReadPort, url: string, over: Record<string, unknown> = {}): Promise<{ status: number | null; body: unknown; reason: unknown }> {
  const reply: { status: number | null; body: unknown } = { status: null, body: undefined };
  const res = { locals: {} as Record<string, unknown>, status(code: number) { reply.status = code; return res; }, json(b: unknown) { reply.body = b; return res; } };
  const route = createIssuingSettingsReadRoute({ issuingSettings: port });
  assert.ok(route.idempotency === 'none');
  await route.handler({ url, path: url.split('?')[0] } as never, res as never,
    { requestId: 'req-s', principal: null, session: null, authenticatedAt: null, trusted: OWNER_SCOPE, sessionKey: KEY, body: undefined, ...over } as never);
  return { ...reply, reason: res.locals.refusal };
}

test('ISS-S09 the read handler: the query, the scope, the id, then the port with the key, the trusted tenant and the store; each answer mapped', async () => {
  const calls: unknown[][] = [];
  const port = (answer: unknown): IssuingSettingsReadPort => ({ settings: (...args: unknown[]) => { calls.push(args.slice(0, 3)); return answer; } });
  const path = `/api/v1/issuing-settings/${STORE}`;
  assert.deepEqual(await readOnce(port({ outcome: 'settings', issuingSettings: CONFIGURED }), path), { status: 200, body: { issuingSettings: CONFIGURED }, reason: undefined });
  assert.deepEqual(calls, [[OWNER_SCOPE, KEY, STORE]]);
  assert.deepEqual((await readOnce(port({ outcome: 'settings', issuingSettings: { storeId: STORE, version: 0, configured: false } }), path)).body,
    { issuingSettings: { storeId: STORE, version: 0, configured: false } });
  calls.length = 0;
  const refusals: Array<[string, Record<string, unknown>, number, string, string]> = [
    [`${path}?`, {}, 400, 'invalid_request', 'issuing_settings_query_invalid'],
    [`${path}?x=1`, {}, 400, 'invalid_request', 'issuing_settings_query_invalid'],
    [path, { trusted: null }, 403, 'forbidden', 'authz_context_missing'],
    [path, { trusted: { ...OWNER_SCOPE, scope: 'store', store: STORE } }, 403, 'forbidden', 'authz_context_missing'],
    [path, { sessionKey: null }, 403, 'forbidden', 'authz_context_missing'],
    ['/api/v1/issuing-settings/NOT-A-UUID', {}, 400, 'invalid_request', 'issuing_settings_store_invalid'],
    [`/api/v1/issuing-settings/${STORE.toUpperCase()}`, {}, 400, 'invalid_request', 'issuing_settings_store_invalid'],
  ];
  for (const [url, over, status, error, reason] of refusals) {
    const r = await readOnce(port({ outcome: 'denied' }), url, over);
    assert.deepEqual([r.status, (r.body as { error: string }).error, r.reason], [status, error, reason], `${url} ${JSON.stringify(over)}`);
  }
  assert.equal(calls.length, 0, 'no refusal above reaches the port');
  for (const [answer, status, error] of [[{ outcome: 'denied' }, 403, 'forbidden'], [{ outcome: 'not_found' }, 404, 'not_found'],
    [{ outcome: 'settings', issuingSettings: { ...CONFIGURED, storeId: randomUUID() } }, 503, 'service_unavailable']] as const) {
    const r = await readOnce(port(answer), path);
    assert.deepEqual([r.status, (r.body as { error: string; requestId: string })], [status, { error, requestId: 'req-s' }]);
  }
  const thrown = await readOnce({ settings: () => { throw new Error('down'); } }, path);
  assert.deepEqual([thrown.status, thrown.reason], [503, 'issuing_settings_unavailable']);
});

// --- 4. the write over the enforced chain, on real loopback sockets ---------------------------------------------------------

const TENANT_ORIGIN = 'http://pos.trusted.test';
const BEARER = 'synthetic-owner-bearer';
interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string>, payload?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** An owner's tenant session whose provider authentication happened `ageMs` ago, and a PUT at `path` over it. */
async function withChain(ageMs: number, answer: string | null, fn: (h: { commits: TransactionCommand[]; storeKey: string; put(path: string, payload?: string): Promise<Reply> }) => Promise<void>): Promise<void> {
  const commits: TransactionCommand[] = [];
  const inner = createMemoryIdempotencyStore();
  const port: CommandTransactionPort = {
    async commit(c, signal) {
      commits.push(c);
      if (answer !== null) return { outcome: answer }; // a rolled-back refusal: nothing completed
      const done = await inner.complete(Object.freeze({ scope: c.scope, lease: c.lease, response: c.response }), signal);
      return { outcome: (done as { outcome?: unknown }).outcome === 'completed' ? 'committed' : 'lease_lost' };
    },
    probe: () => true,
  };
  const authenticatedAt = Date.now() - ageMs;
  const boundary: SessionBoundaryDeps = {
    trustedOrigins: [TENANT_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER ? { verified: true, authProvider: 'synthetic', authProviderUid: 'uid-owner', authenticatedAt, secondFactor: null } : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1', actor: OWNER_SCOPE.actor }) },
    authorizer: { authorize: () => ({ granted: true, context: OWNER_SCOPE }) },
    store: createMemorySessionStore(),
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness, log: { log: () => undefined }, sessions: { tenant: boundary }, routes: [ISSUING_SETTINGS_UPDATE_ROUTE],
    limits: testRequestLimits(), idempotency: { store: inner, keySecret: TEST_IDEMPOTENCY_KEY }, transactions: { port },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = (server.address() as AddressInfo).port;
    const login = await request(p, 'POST', sessionPaths('tenant').login, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`, 'content-length': '0',
    });
    assert.equal(login.status, 200, `tenant login: ${login.body}`);
    const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const id = pair.slice(pair.indexOf('=') + 1);
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    const storeKey = createHash('sha256').update(id).digest('base64url');
    const put = (path: string, payload = JSON.stringify(body())) => request(p, 'PUT', path, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-type': 'application/json',
      cookie: `${SESSION_COOKIES.tenant}=${id}`, [SESSION_CSRF_HEADER]: csrf, 'content-length': String(Buffer.byteLength(payload)), 'idempotency-key': randomUUID(),
    }, payload);
    await fn({ commits, storeKey, put });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

test('ISS-S10 the PUT over the chain: the path\'s store is the planner\'s target and the change set\'s storeId, never the aggregate; the store gets the owner\'s scope, key and deadline', async () => {
  await withChain(1_000, null, async (h) => {
    const r = await h.put(`/api/v1/issuing-settings/${STORE}`);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual((JSON.parse(r.body) as { issuingSettings: { storeId: string; version: number } }).issuingSettings.storeId, STORE);
    assert.equal(h.commits.length, 1);
    const [c] = h.commits;
    assert.equal(c.mutation.changes.storeId, STORE, 'ctx.targetId is the path store id');
    assert.notEqual(c.mutation.aggregateId, STORE, 'a create: its own new aggregate, never the store');
    assert.deepEqual([c.mutation.kind, c.mutation.expectedVersion, c.context, c.sessionKey], ['tenant.issuing_settings.update', null, OWNER_SCOPE, h.storeKey]);
    assert.ok(typeof c.authNotAfter === 'number' && c.authNotAfter <= Date.now() + RECENT_AUTH_MAX_AGE_MS, 'the recent sign-in\'s deadline handed to the store');
    assert.deepEqual([c.audit.reasonCode, c.audit.permission], ['issuing_settings_tax_exclusive_rate', 'edit_issuing_settings']);
    const other = randomUUID();
    assert.equal((await h.put(`/api/v1/issuing-settings/${other}`)).status, 200);
    assert.equal(h.commits[1].mutation.changes.storeId, other, 'another path store, another target');
  });
});

test('ISS-S11 the PUT\'s refusals: a stale sign-in is step_up_required before anything commits; the store\'s not_found is the 404 and precondition_failed the 409', async () => {
  await withChain(RECENT_AUTH_MAX_AGE_MS + 60_000, null, async (h) => {
    const r = await h.put(`/api/v1/issuing-settings/${STORE}`);
    assert.deepEqual([r.status, (JSON.parse(r.body) as { error: string }).error, h.commits.length], [403, 'step_up_required', 0]);
  });
  for (const [answer, status, error] of [['not_found', 404, 'not_found'], ['precondition_failed', 409, 'write_conflict']] as const) {
    await withChain(1_000, answer, async (h) => {
      const r = await h.put(`/api/v1/issuing-settings/${STORE}`);
      assert.deepEqual([r.status, (JSON.parse(r.body) as { error: string }).error], [status, error], answer);
    });
  }
});
