// M7A-CUSTOMERS-P3-R2 — the shop's role-levels client against a scripted fetch: the exact read contract, the PUT it
// sends, and the one outcome each answer maps to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_LEVELS_PATH, createRoleLevelsClient, parseRoleLevels } from './roleLevelsClient';

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
    { roleId: 'store_owner', level: 'full', defaultLevel: 'full', source: 'fixed', editable: false },
    { roleId: 'manager', level: 'full', defaultLevel: 'full', source: 'default', editable: true },
    { roleId: 'technician', level: 'view', defaultLevel: 'view', source: 'default', editable: true },
    { roleId: 'sales_staff', level: 'view', defaultLevel: 'create', source: 'stored', editable: true },
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

test('RLC-04. put sends exactly the four-field body with the CSRF, intent and Idempotency-Key headers', async () => {
  const net = once(json(200, { roleLevel: { roleId: 'sales_staff', domain: 'customers', level: 'view' } }));
  const answer = await net.client.put({ roleId: 'sales_staff', level: 'view', reason: 'Narrowing access for audit' }, KEY, CSRF);
  assert.deepEqual(answer, { kind: 'ok', level: 'view' });
  const { init, headers, url } = net.sent[0];
  assert.equal(url, ROLE_LEVELS_PATH);
  assert.equal(init.method, 'PUT');
  assert.equal(init.body, '{"roleId":"sales_staff","domain":"customers","level":"view","reason":"Narrowing access for audit"}');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-tmpos-csrf'), '1');
  assert.equal(headers.get('x-tmpos-session-csrf'), CSRF);
  assert.equal(headers.get('idempotency-key'), KEY);
  assert.equal(headers.get('authorization'), null);
  assert.equal(init.credentials, 'include');
});

test('RLC-05. each answer maps to one outcome; only an exact 200 for this change is ok', async () => {
  const change = { roleId: 'technician', level: 'none', reason: 'Technicians no longer see customers' } as const;
  const cases: Array<[Response | Error, unknown]> = [
    [json(200, { roleLevel: { roleId: 'technician', domain: 'customers', level: 'view' } }), { kind: 'unknown', responded: true }],
    [json(200, { roleLevel: { roleId: 'technician', domain: 'customers', level: 'none' }, extra: 1 }), { kind: 'unknown', responded: true }],
    [json(200, { roleLevel: { roleId: 'manager', domain: 'customers', level: 'none' } }), { kind: 'unknown', responded: true }], // another role
    [json(200, { roleLevel: { roleId: 'technician', domain: 'inventory', level: 'none' } }), { kind: 'unknown', responded: true }], // another domain
    [json(200, { roleLevel: { roleId: 'technician', domain: 'customers', level: 'none', tenant: 'x' } }), { kind: 'unknown', responded: true }],
    [json(200, { roleId: 'technician', domain: 'customers', level: 'none' }), { kind: 'unknown', responded: true }], // not wrapped
    [json(200, { roleLevel: { roleId: 'technician', domain: 'customers', level: 'none' } }, 'text/plain'), { kind: 'unknown', responded: true }],
    [json(400, { error: 'invalid_request' }), { kind: 'invalid' }],
    [json(413, { error: 'content_too_large' }), { kind: 'invalid' }],
    [json(401, { error: 'unauthenticated' }), { kind: 'signed-out' }],
    [json(403, { error: 'step_up_required' }), { kind: 'step-up-required' }],
    [json(403, { error: 'forbidden' }), { kind: 'denied' }],
    [json(409, { error: 'request_in_progress' }), { kind: 'in-progress' }],
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
  assert.deepEqual(await client.put({ roleId: 'manager', level: 'edit', reason: 'Managers edit only now' }, KEY, CSRF), { kind: 'unknown', responded: false });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await client.read(aborted.signal)).kind, 'unavailable');
});
