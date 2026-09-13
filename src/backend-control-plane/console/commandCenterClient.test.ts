// Phase 4.0 M4 — the Command Center client against a scripted fetch
// (docs/phase-4/03-backend-control-plane-login-session-blueprint.md §2a): the one request it sends,
// the outcome each answer becomes, the exact view schema it accepts, and that it touches no
// storage, cookie or log.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_CENTER_PATH, MAX_BODY_CHARS, createCommandCenterClient, parseCommandCenterView } from './commandCenterClient';
import { commandCenterView } from '../../../server/runtime/commandCenter';

const AT = '2026-09-12T10:30:00.000Z';
const AS_OF = '2026-09-12T10:25:00.000Z';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A complete, valid view — a fresh object on every call, so a case can change its own copy. */
const fullView = (): Json => ({
  schemaVersion: 1,
  generatedAt: AT,
  sections: {
    posture: {
      status: 'available', asOf: AS_OF, stale: false,
      metrics: [{ key: 'tenants', value: 12 }, { key: 'stores', value: 48 }, { key: 'pending_approvals', value: 3 }, { key: 'critical_alerts', value: 1 }],
    },
    attention: {
      status: 'available', asOf: AS_OF, stale: false,
      items: [
        { severity: 'critical', area: 'security', count: 1 },
        { severity: 'warning', area: 'provisioning', count: 3 },
        { severity: 'info', area: 'billing', count: 2 },
      ],
    },
    governance: {
      status: 'available', asOf: '2026-09-12T10:10:00.000Z', stale: true, // twenty minutes before generatedAt
      signals: [{ key: 'production_locked', state: 'ok' }, { key: 'approvals_enforced', state: 'attention' }, { key: 'audit_recording', state: 'unknown' }],
    },
    services: {
      status: 'available', asOf: AS_OF, stale: false,
      services: [
        { key: 'auth', state: 'healthy' }, { key: 'pos', state: 'warning' }, { key: 'repairs', state: 'off' }, { key: 'inventory', state: 'unknown' },
        { key: 'identity_link', state: 'healthy' }, { key: 'audit', state: 'healthy' }, { key: 'worker', state: 'warning' },
      ],
    },
  },
});

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const rawResponse = (text: string, type: string): Response => new Response(text, { status: 200, headers: { 'content-type': type } });
const never = (): Promise<Response> => new Promise<Response>(() => undefined);

type Reply = Response | Error | (() => Promise<Response>);

/** A fetch that answers one reply, records the request and, like a browser, rejects on abort. */
function scripted(reply: Reply, { honourAbort = true } = {}) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ url: String(input), init });
    return new Promise<Response>((resolve, reject) => {
      if (honourAbort) init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      if (reply instanceof Error) return reject(reply);
      Promise.resolve(typeof reply === 'function' ? reply() : reply).then(resolve, reject);
    });
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

function load(reply: Reply, signal = new AbortController().signal, options: { timeoutMs?: number; honourAbort?: boolean } = {}) {
  const net = scripted(reply, { honourAbort: options.honourAbort });
  return { net, outcome: createCommandCenterClient({ fetch: net.fetch, timeoutMs: options.timeoutMs }).load(signal) };
}

const edit = (change: (view: Json) => void) => (view: Json): Json => {
  change(view);
  return view;
};

test('one GET to the Command Center: Accept only, credentials included, same-origin, uncached, no redirect, no referrer', async () => {
  const { net, outcome } = load(jsonResponse(200, fullView()));
  assert.equal((await outcome).kind, 'ok');
  assert.equal(COMMAND_CENTER_PATH, '/admin/v1/command-center');
  assert.equal(net.sent.length, 1);
  const [{ url, init }] = net.sent;
  assert.equal(url, COMMAND_CENTER_PATH);
  assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'headers', 'method', 'mode', 'redirect', 'referrerPolicy', 'signal']);
  assert.equal(init.method, 'GET');
  // Never the Firebase bearer, never a CSRF header: the HttpOnly session cookie rides on its own.
  assert.deepEqual([...new Headers(init.headers).entries()], [['accept', 'application/json']]);
  assert.equal(init.credentials, 'include');
  assert.equal(init.mode, 'same-origin');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.redirect, 'error');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.ok(init.signal instanceof AbortSignal);
});

test('a valid answer is the view, unchanged', async () => {
  assert.deepEqual(await load(jsonResponse(200, fullView())).outcome, { kind: 'ok', view: fullView() });
});

const STATUSES: ReadonlyArray<readonly [number, string]> = [
  [401, 'expired'], [403, 'forbidden'], [429, 'rate-limited'],
  [201, 'unavailable'], [204, 'unavailable'], [302, 'unavailable'], [400, 'unavailable'], [404, 'unavailable'],
  [409, 'unavailable'], [500, 'unavailable'], [502, 'unavailable'], [503, 'unavailable'], [504, 'unavailable'],
];
for (const [status, kind] of STATUSES) {
  test(`status ${status} is ${kind}`, async () => {
    // A 201 carries a well-formed view: only a 200 is an answer.
    const body = status === 201 ? fullView() : { error: 'refused', requestId: 'r1' };
    assert.deepEqual(await load(jsonResponse(status, body)).outcome, { kind });
  });
}

const TYPES: ReadonlyArray<readonly [string, string]> = [
  ['application/json', 'ok'], ['application/json;charset=utf-8', 'ok'], ['APPLICATION/JSON', 'ok'],
  ['text/html', 'unavailable'], ['text/plain', 'unavailable'], ['application/json-seq', 'unavailable'], ['', 'unavailable'],
];
for (const [type, kind] of TYPES) {
  test(`a 200 with content type "${type}" is ${kind}`, async () => {
    assert.equal((await load(rawResponse(JSON.stringify(fullView()), type)).outcome).kind, kind);
  });
}

test('a 200 whose body is not JSON (an SPA fallback page, say) is unavailable', async () => {
  assert.deepEqual(await load(rawResponse('<!doctype html><title>Control Plane</title>', 'application/json')).outcome, { kind: 'unavailable' });
});

test('a body over 65,536 characters is unavailable; one at the bound is read', async () => {
  assert.equal(MAX_BODY_CHARS, 65_536);
  const text = JSON.stringify(fullView());
  const atBound = text + ' '.repeat(MAX_BODY_CHARS - text.length);
  assert.equal((await load(rawResponse(atBound, 'application/json')).outcome).kind, 'ok');
  assert.deepEqual(await load(rawResponse(`${atBound} `, 'application/json')).outcome, { kind: 'unavailable' });
});

test('a network failure is unavailable', async () => {
  assert.deepEqual(await load(new TypeError('Failed to fetch')).outcome, { kind: 'unavailable' });
});

test('a request that outlasts the timeout is abandoned and unavailable', async () => {
  const { net, outcome } = load(never, undefined, { timeoutMs: 20 });
  assert.deepEqual(await outcome, { kind: 'unavailable' });
  assert.equal(net.sent[0].init.signal?.aborted, true);
});

test('a signal aborted before the request sends nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const { net, outcome } = load(jsonResponse(200, fullView()), controller.signal);
  assert.deepEqual(await outcome, { kind: 'aborted' });
  assert.equal(net.sent.length, 0);
});

test('an abort during the request cancels it and is aborted, not an outage', async () => {
  const controller = new AbortController();
  const { net, outcome } = load(never, controller.signal);
  assert.equal(net.sent.length, 1);
  controller.abort();
  assert.deepEqual(await outcome, { kind: 'aborted' });
  assert.equal(net.sent[0].init.signal?.aborted, true);
});

test('an answer that arrives after the abort is still aborted', async () => {
  const controller = new AbortController();
  let answer!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  const { outcome } = load(() => pending, controller.signal, { honourAbort: false });
  controller.abort();
  answer(jsonResponse(200, fullView()));
  assert.deepEqual(await outcome, { kind: 'aborted' });
});

test('a malformed view over the wire is unavailable, never half a view', async () => {
  for (const make of [edit((v) => { v.schemaVersion = 2; }), edit((v) => { v.sections.attention.items[0].summary = 'Tenant acme is suspended'; })]) {
    assert.deepEqual(await load(jsonResponse(200, make(fullView()))).outcome, { kind: 'unavailable' });
  }
});

test('a complete view is accepted unchanged and frozen all the way down', () => {
  const view = parseCommandCenterView(fullView());
  assert.deepEqual(view, fullView());
  const unfrozen: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null) return;
    if (!Object.isFrozen(value)) unfrozen.push(path);
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(view, 'view');
  assert.deepEqual(unfrozen, []);
});

test('an absent section is exactly its status; empty lists, partial lists and zero posture counts are available', () => {
  const view = fullView();
  view.sections.posture = { status: 'unavailable' };
  view.sections.attention = { status: 'not_configured' };
  view.sections.governance.signals = [];
  view.sections.services.services = [{ key: 'worker', state: 'off' }];
  assert.deepEqual(parseCommandCenterView(JSON.parse(JSON.stringify(view))), view);
  const counts = fullView();
  counts.sections.posture.metrics = [{ key: 'stores', value: 0 }];
  counts.sections.attention.items = [];
  assert.notEqual(parseCommandCenterView(counts), null);
});

test('every view the server can emit passes the client parser unchanged (server/runtime/commandCenter.ts parity)', () => {
  const now = Date.parse(AT);
  const reading = (asOf: number, data: unknown) => ({ status: 'available', asOf, data });
  const pairs = ['critical', 'warning', 'info'].flatMap((severity) =>
    ['tenants', 'provisioning', 'billing', 'security', 'platform'].map((area) => ({ severity, area, count: 1 })),
  );
  const cases: ReadonlyArray<readonly [string, unknown, number]> = [
    ['every section available, stale both ways', {
      posture: reading(now - 60_000, { tenants: 12, stores: 0, pending_approvals: 1_000_000_000, critical_alerts: 1 }),
      attention: reading(now, { items: [...pairs].reverse() }), // all fifteen pairs, which the server sorts
      governance: reading(now - 900_001, { signals: { production_locked: 'ok', approvals_enforced: 'attention', audit_recording: 'unknown' } }),
      services: reading(now + 60_000, { auth: 'healthy', pos: 'warning', repairs: 'off', inventory: 'unknown', identity_link: 'healthy', audit: 'healthy', worker: 'warning' }),
    }, now],
    ['empty lists', { posture: reading(now, {}), attention: reading(now, { items: [] }), governance: reading(now, { signals: {} }), services: reading(now, {}) }, now],
    ['the freshness bounds', {
      posture: reading(now - 900_000, { tenants: 1 }), attention: reading(now - 86_400_000, { items: [] }),
      governance: reading(now + 60_000, { signals: {} }), services: { status: 'not_configured' },
    }, now],
    ['missing, unavailable and not-configured sections', { attention: { status: 'unavailable' }, services: { status: 'not_configured' } }, now],
    ['an invalid server clock', {}, Number.NaN],
    ['the last instant a Date can hold', { posture: reading(8.64e15 - 1_000, { tenants: 3 }) }, 8.64e15],
  ];
  for (const [name, raw, at] of cases) {
    const emitted = JSON.parse(JSON.stringify(commandCenterView(raw, at)));
    assert.deepEqual(parseCommandCenterView(emitted), emitted, name);
  }
});

// Every schema rule, each broken on its own: any of them makes the whole view null.
const MALFORMED: ReadonlyArray<readonly [string, (view: Json) => unknown]> = [
  ['null', () => null],
  ['a list', (v) => [v]],
  ['a string', () => 'view'],
  ['schemaVersion 2', edit((v) => { v.schemaVersion = 2; })],
  ['schemaVersion as a string', edit((v) => { v.schemaVersion = '1'; })],
  ['no generatedAt', edit((v) => { delete v.generatedAt; })],
  ['generatedAt that is not a date', edit((v) => { v.generatedAt = 'yesterday'; })],
  ['generatedAt that is not ISO-8601', edit((v) => { v.generatedAt = 'Sat, 12 Sep 2026 10:30:00 GMT'; })],
  ['generatedAt with an offset instead of UTC', edit((v) => { v.generatedAt = '2026-09-12T12:30:00.000+02:00'; })],
  ['generatedAt as epoch milliseconds', edit((v) => { v.generatedAt = Date.parse(AT); })],
  ['an extra top-level key', edit((v) => { v.requestId = 'r1'; })],
  ['a __proto__ key', (v) => JSON.parse(JSON.stringify(v).replace('{', '{"__proto__":{"polluted":true},'))],
  ['no sections', edit((v) => { delete v.sections; })],
  ['sections as a list', edit((v) => { v.sections = Object.values(v.sections); })],
  ['a missing section', edit((v) => { delete v.sections.services; })],
  ['an extra section', edit((v) => { v.sections.incidents = { status: 'unavailable' }; })],
  ['an unknown section status', edit((v) => { v.sections.posture = { status: 'degraded' }; })],
  ['an unavailable section that carries values', edit((v) => { v.sections.posture = { status: 'unavailable', metrics: [] }; })],
  ['a not-configured section that carries asOf', edit((v) => { v.sections.services = { status: 'not_configured', asOf: AS_OF }; })],
  ['an available section without asOf', edit((v) => { delete v.sections.posture.asOf; })],
  ['asOf that is not ISO-8601', edit((v) => { v.sections.attention.asOf = '10:25'; })],
  ['asOf without milliseconds', edit((v) => { v.sections.attention.asOf = '2026-09-12T10:25:00Z'; })],
  ['asOf with a +00:00 offset', edit((v) => { v.sections.attention.asOf = '2026-09-12T10:25:00.000+00:00'; })],
  ['asOf more than 60 s after generatedAt', edit((v) => { v.sections.posture.asOf = '2026-09-12T10:31:00.001Z'; })],
  ['asOf more than 24 h before generatedAt', edit((v) => { v.sections.posture.asOf = '2026-09-11T10:29:59.999Z'; v.sections.posture.stale = true; })],
  ['stale false for a reading over 15 minutes old', edit((v) => { v.sections.services.asOf = '2026-09-12T10:14:59.999Z'; })],
  ['stale true for a fresh reading', edit((v) => { v.sections.services.stale = true; })],
  ['stale as a string', edit((v) => { v.sections.governance.stale = 'false'; })],
  ['no stale', edit((v) => { delete v.sections.services.stale; })],
  ['an available section with an extra key', edit((v) => { v.sections.attention.note = 'Check provisioning'; })],
  ['an available section without its list', edit((v) => { delete v.sections.services.services; })],
  ['a list under another section\'s key', edit((v) => { v.sections.posture.items = v.sections.posture.metrics; delete v.sections.posture.metrics; })],
  ['posture metrics as an object', edit((v) => { v.sections.posture.metrics = { tenants: 12 }; })],
  ['an unknown posture metric', edit((v) => { v.sections.posture.metrics.push({ key: 'revenue', value: 1 }); })],
  ['a negative count', edit((v) => { v.sections.posture.metrics[0].value = -1; })],
  ['a fractional count', edit((v) => { v.sections.posture.metrics[1].value = 1.5; })],
  ['a count above 1,000,000,000', edit((v) => { v.sections.posture.metrics[2].value = 1_000_000_001; })],
  ['a count as a string', edit((v) => { v.sections.posture.metrics[3].value = '1'; })],
  ['a repeated metric', edit((v) => { v.sections.posture.metrics.splice(1, 0, { key: 'tenants', value: 12 }); })],
  ['metrics out of order', edit((v) => { v.sections.posture.metrics.reverse(); })],
  ['a metric with a label', edit((v) => { v.sections.posture.metrics[0].label = 'Tenants'; })],
  ['an attention item with reader text', edit((v) => { v.sections.attention.items[0].summary = 'Tenant acme is suspended'; })],
  ['an unknown severity', edit((v) => { v.sections.attention.items[0].severity = 'urgent'; })],
  ['an unknown area', edit((v) => { v.sections.attention.items[0].area = 'payroll'; })],
  ['an attention count of zero', edit((v) => { v.sections.attention.items[1].count = 0; })],
  ['an attention count as a string', edit((v) => { v.sections.attention.items[1].count = '3'; })],
  ['a repeated severity and area', edit((v) => { v.sections.attention.items.splice(1, 0, { severity: 'critical', area: 'security', count: 4 }); })],
  ['attention items out of order', edit((v) => { v.sections.attention.items.reverse(); })],
  ['more than 15 attention items', edit((v) => { v.sections.attention.items = Array.from({ length: 16 }, (_, i) => ({ severity: 'info', area: 'platform', count: i + 1 })); })],
  ['an unknown governance signal', edit((v) => { v.sections.governance.signals.push({ key: 'backups_verified', state: 'ok' }); })],
  ['a signal state outside the vocabulary', edit((v) => { v.sections.governance.signals[0].state = 'locked'; })],
  ['signals as an object', edit((v) => { v.sections.governance.signals = { production_locked: 'ok' }; })],
  ['an unknown service', edit((v) => { v.sections.services.services.push({ key: 'payments', state: 'healthy' }); })],
  ['a service state outside the vocabulary', edit((v) => { v.sections.services.services[0].state = 'degraded'; })],
  ['a service with detail text', edit((v) => { v.sections.services.services[1].detail = 'queue lag 40s'; })],
  ['a repeated service', edit((v) => { v.sections.services.services.splice(1, 0, { key: 'auth', state: 'healthy' }); })],
];
for (const [name, make] of MALFORMED) {
  test(`malformed: ${name}`, () => {
    assert.equal(parseCommandCenterView(make(fullView())), null);
    assert.equal(({} as Json).polluted, undefined);
  });
}

test('the client reads and writes no storage or cookie, and logs nothing', async () => {
  const touched: string[] = [];
  const recorder = (name: string): object =>
    new Proxy(
      {},
      {
        get(_target, key) {
          touched.push(`${name}.${String(key)}`);
          return undefined;
        },
        set(_target, key) {
          touched.push(`${name}.${String(key)}=`);
          return true;
        },
        has(_target, key) {
          touched.push(`${String(key)} in ${name}`);
          return false;
        },
      },
    );
  const names = ['localStorage', 'sessionStorage', 'indexedDB', 'document'] as const;
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) Object.defineProperty(globalThis, name, { value: recorder(name), configurable: true, writable: true });
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    mock.method(console, level, () => {
      touched.push(`console.${level}`);
    });
  }
  try {
    const replies: Reply[] = [
      jsonResponse(200, fullView()), jsonResponse(401, {}), jsonResponse(403, {}), jsonResponse(429, {}), jsonResponse(503, {}),
      new TypeError('Failed to fetch'), jsonResponse(200, { schemaVersion: 2 }), rawResponse('not json', 'application/json'),
    ];
    for (const reply of replies) await load(reply).outcome;
    await load(never, undefined, { timeoutMs: 5 }).outcome;
    const aborted = new AbortController();
    aborted.abort();
    await load(jsonResponse(200, fullView()), aborted.signal).outcome;
  } finally {
    mock.restoreAll();
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
  assert.deepEqual(touched, []);
});
