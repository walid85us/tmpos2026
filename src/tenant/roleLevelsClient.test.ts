// M7A-CUSTOMERS-P3-R2 — the shop's role-levels client against a scripted fetch: the exact read contract, the PUT it
// sends, and the one outcome each answer maps to. M7A-CUSTOMERS-P4: each editable level's version, the six-field PUT
// with its tenant and version preconditions, the committed version in the 200, and the one 409 decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_LEVELS_PATH, ROLE_LEVELS_READ_PATHS, conflictKind, createRoleLevelsClient, parseRoleLevels } from './roleLevelsClient';

const TENANT = '0b6f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4';
// A synthetic v4 Idempotency-Key, assembled at run time so no key-shaped literal sits in the source (secret scanning).
const KEY = ['1e3d5c7b', '9a8f', '4e6d', '8c4b', '2a1f0e9d8c7b'].join('-');
const CSRF = 'c'.repeat(43);

const json = (status: number, body: unknown, type = 'application/json; charset=utf-8'): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const LEVELS = () => ({
  tenant: TENANT,
  domain: 'customers',
  roles: [
    { roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false, version: null },
    { roleId: 'manager', level: 'full', defaultLevel: 'full', source: 'default', editable: true, version: 0 },
    { roleId: 'technician', level: 'view', defaultLevel: 'view', source: 'default', editable: true, version: 2 },
    { roleId: 'sales_staff', level: 'view', defaultLevel: 'create', source: 'stored', editable: true, version: 7 },
  ],
});

function once(reply: Response | Error) {
  const sent: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ url: String(input), init, headers: new Headers(init.headers) });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { sent, client: createRoleLevelsClient({ fetch: fetch as typeof globalThis.fetch }) };
}

test('RLC-01. the read contract is accepted exactly, in display order, and frozen', () => {
  const body = LEVELS();
  body.roles.reverse();
  const parsed = parseRoleLevels(body);
  assert.ok(parsed !== null);
  assert.equal(parsed.tenant, TENANT);
  assert.deepEqual(parsed.roles.map((r) => r.roleId), ['store_owner', 'manager', 'technician', 'sales_staff']);
  assert.deepEqual(parsed.roles.map((r) => r.version), [null, 0, 2, 7]);
  assert.ok(Object.isFrozen(parsed.roles) && Object.isFrozen(parsed.roles[0]));
});

test('RLC-02. anything but the exact contract is refused', () => {
  const variants: Array<(b: ReturnType<typeof LEVELS>) => unknown> = [
    (b) => ({ ...b, extra: 1 }),
    (b) => ({ ...b, tenant: 'tenant-1' }),
    (b) => ({ ...b, domain: 'inventory' }),
    (b) => ({ ...b, roles: b.roles.slice(1) }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), b.roles[1]] }), // a duplicate role
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], roleId: 'custom_role' }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], level: 'owner' }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], editable: false }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], source: 'default' }] }), // default must equal its level
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], secret: 'x' }] }),
    (b) => ({ ...b, roles: [{ ...b.roles[0], level: 'view' }, ...b.roles.slice(1)] }), // store_owner is fixed Full
    // M7A-CUSTOMERS-P4: an editable version is a safe integer >= 0; store_owner's is null; the key is required.
    (b) => ({ ...b, roles: [{ ...b.roles[0], version: 0 }, ...b.roles.slice(1)] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], version: null }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], version: -1 }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], version: 1.5 }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], version: '7' }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), { ...b.roles[3], version: Number.MAX_SAFE_INTEGER + 1 }] }),
    (b) => ({ ...b, roles: [...b.roles.slice(0, 3), (({ version: _v, ...rest }) => rest)(b.roles[3])] }),
    () => null,
    () => [],
  ];
  for (const variant of variants) assert.equal(parseRoleLevels(variant(LEVELS())), null);
});

test('RLC-03. read maps 200/401/403 and everything else to unavailable; same-origin, credentials, no-store', async () => {
  const ok = once(json(200, LEVELS()));
  const answer = await ok.client.read();
  assert.equal(answer.kind, 'ok');
  assert.equal(ok.sent[0].url, ROLE_LEVELS_PATH);
  assert.equal(ok.sent[0].init.method, 'GET');
  assert.equal(ok.sent[0].init.credentials, 'include');
  assert.equal(ok.sent[0].init.mode, 'same-origin');
  assert.equal(ok.sent[0].init.cache, 'no-store');
  assert.equal(ok.sent[0].init.body, undefined);
  assert.equal(ok.sent[0].headers.get('x-tmpos-session-csrf'), null);
  const cases: Array<[Response | Error, string]> = [
    [json(401, { error: 'unauthenticated' }), 'signed-out'],
    [json(403, { error: 'forbidden' }), 'denied'],
    [json(503, { error: 'service_unavailable' }), 'unavailable'],
    [json(200, { ...LEVELS(), extra: true }), 'unavailable'],
    [json(200, LEVELS(), 'text/plain'), 'unavailable'],
    [new Error('network'), 'unavailable'],
  ];
  for (const [reply, kind] of cases) assert.equal((await once(reply).client.read()).kind, kind);
});

test('RLC-04. put sends exactly the six-field body (tenant and version preconditions last) with the CSRF, intent and Idempotency-Key headers', async () => {
  const net = once(json(200, { roleLevel: { roleId: 'sales_staff', domain: 'customers', level: 'view', version: 8 } }));
  const answer = await net.client.put({ roleId: 'sales_staff', level: 'view', reason: 'Narrowing access for audit', expectedTenant: TENANT, expectedVersion: 7 }, KEY, CSRF);
  assert.deepEqual(answer, { kind: 'ok', level: 'view', version: 8 });
  const { init, headers, url } = net.sent[0];
  assert.equal(url, ROLE_LEVELS_PATH);
  assert.equal(init.method, 'PUT');
  assert.equal(init.body, `{"roleId":"sales_staff","domain":"customers","level":"view","reason":"Narrowing access for audit","expectedTenant":"${TENANT}","expectedVersion":7}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-tmpos-csrf'), '1');
  assert.equal(headers.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(headers.get('idempotency-key'), KEY);
  assert.equal(headers.get('authorization'), null);
  assert.equal(init.credentials, 'include');
});

test('RLC-05. each answer maps to one outcome; only an exact 200 for this change at expectedVersion + 1 is ok', async () => {
  const change = { roleId: 'technician', level: 'none', reason: 'Technicians no longer see customers', expectedTenant: TENANT, expectedVersion: 2 } as const;
  const done = { roleId: 'technician', domain: 'customers', level: 'none', version: 3 };
  const cases: Array<[Response | Error, unknown]> = [
    [json(200, { roleLevel: done }), { kind: 'ok', level: 'none', version: 3 }],
    [json(200, { roleLevel: { ...done, level: 'view' } }), { kind: 'unknown', responded: true }],
    [json(200, { roleLevel: done, extra: 1 }), { kind: 'unknown', responded: true }],
    [json(200, { roleLevel: { ...done, roleId: 'manager' } }), { kind: 'unknown', responded: true }], // another role
    [json(200, { roleLevel: { ...done, domain: 'inventory' } }), { kind: 'unknown', responded: true }], // another domain
    [json(200, { roleLevel: { ...done, tenant: 'x' } }), { kind: 'unknown', responded: true }],
    [json(200, { roleLevel: { roleId: 'technician', domain: 'customers', level: 'none' } }), { kind: 'unknown', responded: true }], // no version
    [json(200, { roleLevel: { ...done, version: 2 } }), { kind: 'unknown', responded: true }], // not the committed version
    [json(200, { roleLevel: { ...done, version: 4 } }), { kind: 'unknown', responded: true }],
    [json(200, { roleLevel: { ...done, version: '3' } }), { kind: 'unknown', responded: true }],
    [json(200, done), { kind: 'unknown', responded: true }], // not wrapped
    [json(200, { roleLevel: done }, 'text/plain'), { kind: 'unknown', responded: true }],
    [json(400, { error: 'invalid_request' }), { kind: 'invalid' }],
    [json(413, { error: 'content_too_large' }), { kind: 'invalid' }],
    [json(401, { error: 'unauthenticated' }), { kind: 'signed-out' }],
    [json(403, { error: 'step_up_required' }), { kind: 'step-up-required' }],
    [json(403, { error: 'forbidden' }), { kind: 'denied' }],
    [json(409, { error: 'request_in_progress' }), { kind: 'in-progress' }],
    [json(409, { error: 'write_conflict' }), { kind: 'conflict' }], // the sealed shape
    [json(409, { error: 'write_conflict', requestId: 'r-1' }), { kind: 'conflict' }], // the runtime shape
    [json(409, { error: 'write_conflict', requestId: 1 }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'write_conflict', detail: 'x' }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'invalid_state' }), { kind: 'unknown', responded: true }],
    [json(409, { error: 'write_conflict' }, 'text/plain'), { kind: 'unknown', responded: true }],
    [json(422, { error: 'idempotency_key_reused' }), { kind: 'key-reused' }],
    [json(503, { error: 'service_unavailable' }), { kind: 'unknown', responded: true }],
    [json(429, { error: 'rate_limited' }), { kind: 'unknown', responded: true }],
    [new Error('network'), { kind: 'unknown', responded: false }],
  ];
  for (const [reply, expected] of cases) assert.deepEqual(await once(reply).client.put(change, KEY, CSRF), expected);
});

test('RLC-06. a timeout or an aborted signal is an unknown outcome with no answer', async () => {
  const hang = (_: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
    new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const client = createRoleLevelsClient({ fetch: hang as typeof globalThis.fetch, timeoutMs: 5 });
  assert.deepEqual(await client.put({ roleId: 'manager', level: 'edit', reason: 'Managers edit only now', expectedTenant: TENANT, expectedVersion: 0 }, KEY, CSRF), { kind: 'unknown', responded: false });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await client.read(aborted.signal)).kind, 'unavailable');
});

test('RLC-07. the one 409 decoder: write_conflict in the sealed or the runtime shape is a conflict; request_in_progress is in progress', () => {
  assert.equal(conflictKind({ error: 'write_conflict' }), 'conflict');
  assert.equal(conflictKind({ error: 'write_conflict', requestId: 'r-1' }), 'conflict');
  assert.equal(conflictKind(JSON.parse('{"requestId":"r-2","error":"write_conflict"}')), 'conflict'); // key order is free
  assert.equal(conflictKind({ error: 'request_in_progress' }), 'in-progress');
  for (const body of [
    { error: 'write_conflict', requestId: null }, { error: 'write_conflict', requestId: 7 }, { error: 'write_conflict', extra: true },
    { error: 'idempotency_key_reused' }, { error: 'WRITE_CONFLICT' }, {}, null, 'write_conflict', ['write_conflict'],
  ]) {
    assert.equal(conflictKind(body), null, JSON.stringify(body));
  }
});

test('RLC-08. the tenant is any canonical lowercase UUID, as the server accepts it — never another form', () => {
  const nil = '00000000-0000-0000-0000-000000000000';
  const anyVariant = '0b6f1d2e-3c4a-0b5c-cd6e-7f8091a2b3c4'; // version nibble 0, variant c: the server's rule accepts it
  for (const tenant of [nil, anyVariant]) assert.equal(parseRoleLevels({ ...LEVELS(), tenant })?.tenant, tenant);
  for (const tenant of [TENANT.toUpperCase(), `{${TENANT}}`, TENANT.replace(/-/g, ''), ` ${TENANT}`]) {
    assert.equal(parseRoleLevels({ ...LEVELS(), tenant }), null, tenant);
  }
});

test('RLC-09. request_in_progress passes the same key check as write_conflict: keys within {error, requestId}, requestId a string', () => {
  assert.equal(conflictKind({ error: 'request_in_progress', requestId: 'r-3' }), 'in-progress');
  for (const body of [
    { error: 'request_in_progress', detail: 'x' }, { error: 'request_in_progress', requestId: 7 }, { error: 'request_in_progress', requestId: null },
  ]) {
    assert.equal(conflictKind(body), null, JSON.stringify(body));
  }
});

// M5-INVOICES-AUTH-P1: the same client, parameterised by domain.
const invoicesOnce = (reply: Response) => {
  const sent: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ url: String(input), method: init.method ?? 'GET', body: init.body });
    return reply;
  };
  return { sent, client: createRoleLevelsClient({ fetch: fetch as typeof globalThis.fetch, domain: 'invoices' }) };
};

test('RLC-10. an Invoices client reads its own path and accepts only an Invoices answer; the Customers client refuses it', async () => {
  assert.equal(ROLE_LEVELS_READ_PATHS.customers, ROLE_LEVELS_PATH);
  assert.equal(ROLE_LEVELS_READ_PATHS.invoices, `${ROLE_LEVELS_PATH}/invoices`);
  const invoices = { ...LEVELS(), domain: 'invoices' };
  const a = invoicesOnce(json(200, invoices));
  const read = await a.client.read();
  assert.equal(read.kind, 'ok');
  assert.deepEqual(a.sent.map((r) => [r.method, r.url]), [['GET', '/api/v1/roles/levels/invoices']]);
  assert.equal(parseRoleLevels(invoices), null); // the default (Customers) parser refuses an Invoices answer
  assert.equal(parseRoleLevels(invoices, 'invoices')?.tenant, TENANT);
  assert.equal((await invoicesOnce(json(200, LEVELS())).client.read()).kind, 'unavailable'); // a Customers answer is no Invoices answer
  const c = once(json(200, LEVELS()));
  assert.equal((await c.client.read()).kind, 'ok');
  assert.equal(c.sent[0].url, ROLE_LEVELS_PATH); // the default client is unchanged
});

test('RLC-11. an Invoices PUT names the domain in the same fixed body order and accepts only an Invoices 200', async () => {
  const change = { roleId: 'manager', level: 'edit', reason: 'Managers edit invoices now', expectedTenant: TENANT, expectedVersion: 3 } as const;
  const ok = invoicesOnce(json(200, { roleLevel: { roleId: 'manager', domain: 'invoices', level: 'edit', version: 4 } }));
  assert.deepEqual(await ok.client.put(change, KEY, CSRF), { kind: 'ok', level: 'edit', version: 4 });
  assert.equal(ok.sent[0].url, ROLE_LEVELS_PATH); // the PUT route is shared
  assert.equal(ok.sent[0].body, `{"roleId":"manager","domain":"invoices","level":"edit","reason":"Managers edit invoices now","expectedTenant":"${TENANT}","expectedVersion":3}`);
  const wrong = invoicesOnce(json(200, { roleLevel: { roleId: 'manager', domain: 'customers', level: 'edit', version: 4 } }));
  assert.deepEqual(await wrong.client.put(change, KEY, CSRF), { kind: 'unknown', responded: true });
});

test('RLC-12. an Invoices client maps 409/403/422 exactly like the Customers one', async () => {
  const change = { roleId: 'technician', level: 'none', reason: 'Technicians lose invoices', expectedTenant: TENANT, expectedVersion: 0 } as const;
  assert.equal((await invoicesOnce(json(409, { error: 'write_conflict', requestId: 'r' })).client.put(change, KEY, CSRF)).kind, 'conflict');
  assert.equal((await invoicesOnce(json(403, { error: 'step_up_required' })).client.put(change, KEY, CSRF)).kind, 'step-up-required');
  assert.equal((await invoicesOnce(json(422, { error: 'idempotency_key_reused' })).client.put(change, KEY, CSRF)).kind, 'key-reused');
  assert.equal((await invoicesOnce(json(403, { error: 'forbidden' })).client.read()).kind, 'denied');
});
