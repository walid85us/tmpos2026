// Phase 4.0 M4 — the Command Center read model: real-socket contract for its one bounded route.
//
// A synthetic reader, verifier, admission and authorizer cross a real loopback socket
// (127.0.0.1, ephemeral port) into createApp, with the administrative session boundary composed
// from test ports only. The suite pins:
//   - the admin session and the server authorizer gate every read: a 401, 403 or authz outage
//     comes from the shared chain, and the reader is never called before both have passed;
//   - a reader failure or overrun is a bounded 503 with its own log reason, and an overrun read
//     is cancelled through its signal;
//   - the mapping is total and fails closed per section: one invalid value voids the section, a
//     missing section is unavailable, and a reading older than 24 h is unavailable;
//   - no string the reader supplies, and no reader field, credential, UID or CSRF token, ever
//     leaves: every string in the view is a contract constant or a runtime-formatted instant;
//   - the route has no state-changing method, and the deployable app composes no such route.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, createReadinessState, createBoundedServer } from './app.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError, sessionPaths } from './routes.js';
import type { RouteContext } from './routes.js';
import { PORT_DEADLINE_MS } from './deadline.js';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from './sessions.js';
import type { SessionBoundaryDeps } from './sessions.js';
import { createMemorySessionStore } from './memorySessionStore.testkit.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import {
  COMMAND_CENTER_PATH, COMMAND_CENTER_REQUIREMENT, MAX_AGE_MS, STALE_AFTER_MS, commandCenterRoutes, commandCenterView,
} from './commandCenter.js';
import type { CommandCenterReader } from './commandCenter.js';

const T0 = 1_700_000_000_000;
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const BEARER = 'tok-owner';
const UID = 'uid-owner';
const P = '/admin/v1/command-center';
const ISO = (ms: number): string => new Date(ms).toISOString();
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECTIONS = ['posture', 'attention', 'governance', 'services'] as const;
type SectionName = typeof SECTIONS[number];
const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const;
const AREA_ORDER = ['tenants', 'provisioning', 'billing', 'security', 'platform'] as const;
const UNAVAILABLE = { status: 'unavailable' };
const NOT_CONFIGURED = { status: 'not_configured' };
const ALL_UNAVAILABLE = { posture: UNAVAILABLE, attention: UNAVAILABLE, governance: UNAVAILABLE, services: UNAVAILABLE };

/** A reader's available reading of `data` as of `asOf`. */
const at = (data: unknown, asOf: unknown = T0): unknown => ({ status: 'available', asOf, data });
/** The available section the view must emit for `fields` read as of `asOf` (fresh). */
const avail = (fields: Record<string, unknown>, asOf = T0): unknown => ({ status: 'available', asOf: ISO(asOf), stale: false, ...fields });
/** The one section the view makes of a raw value holding only `reading` under `name`. */
const only = (name: SectionName, reading: unknown, now = T0): unknown =>
  (commandCenterView({ [name]: reading }, now).sections as Record<string, unknown>)[name];

// --- transport -----------------------------------------------------------------------------

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One bodiless request on its own connection; an unsafe one is framed with an explicit zero length. */
function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const framed = method === 'GET' ? headers : { 'content-length': '0', ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: framed, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end();
  });
}

function assertPolicyHeaders(headers: http.IncomingHttpHeaders, label: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers[name.toLowerCase()], value, `${label}: ${name}`);
}

/** A bounded refusal: the status, `{ error, requestId }` only, and the header policy. */
function assertRefusal(r: Reply, status: number, error: string, label: string): void {
  assert.equal(r.status, status, `${label}: ${r.body}`);
  const body = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], label);
  assert.equal(body.error, error, label);
  assertPolicyHeaders(r.headers, label);
}

/** Whether a log record carries this reason (records may trail the reply slightly). */
async function logged(logs: string[], reason: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (logs.some((line) => (JSON.parse(line) as { reason?: unknown }).reason === reason)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

const adminCookie = (id: string): Record<string, string> => ({ cookie: `${SESSION_COOKIES.admin}=${id}` });

// Every string value a view may carry besides an ISO instant: the contract's enum members.
const CONTRACT_STRINGS: ReadonlySet<string> = new Set([
  'available', 'unavailable', 'not_configured',
  'tenants', 'stores', 'pending_approvals', 'critical_alerts',
  ...SEVERITY_ORDER, ...AREA_ORDER,
  'production_locked', 'approvals_enforced', 'audit_recording', 'ok', 'attention', 'unknown',
  'auth', 'pos', 'repairs', 'inventory', 'identity_link', 'audit', 'worker', 'healthy', 'warning', 'off',
]);

function assertContractStringsOnly(view: unknown): void {
  const walk = (value: unknown, where: string): void => {
    if (typeof value === 'string') assert.ok(CONTRACT_STRINGS.has(value) || ISO_RE.test(value), `${where} carries a non-contract string`);
    else if (typeof value === 'object' && value !== null) for (const [key, child] of Object.entries(value)) walk(child, `${where}.${key}`);
  };
  walk(view, 'view');
}

// --- synthetic sources and the views they must produce --------------------------------------

const RAW = {
  posture: { status: 'available', asOf: T0 - 60_000, data: { tenants: 12, stores: 30, pending_approvals: 2, critical_alerts: 0 } },
  attention: {
    status: 'available',
    asOf: T0 - STALE_AFTER_MS - 1,
    data: {
      items: [
        { severity: 'info', area: 'platform', count: 1 },
        { severity: 'warning', area: 'provisioning', count: 2 },
        { severity: 'critical', area: 'security', count: 1 },
      ],
    },
  },
  governance: { status: 'available', asOf: T0, data: { signals: { production_locked: 'ok', approvals_enforced: 'ok', audit_recording: 'attention' } } },
  services: { status: 'unavailable' },
};

const EXPECTED = {
  schemaVersion: 1,
  generatedAt: ISO(T0),
  sections: {
    posture: {
      status: 'available', asOf: ISO(T0 - 60_000), stale: false,
      metrics: [
        { key: 'tenants', value: 12 }, { key: 'stores', value: 30 },
        { key: 'pending_approvals', value: 2 }, { key: 'critical_alerts', value: 0 },
      ],
    },
    attention: {
      status: 'available', asOf: ISO(T0 - STALE_AFTER_MS - 1), stale: true,
      items: [
        { severity: 'critical', area: 'security', count: 1 },
        { severity: 'warning', area: 'provisioning', count: 2 },
        { severity: 'info', area: 'platform', count: 1 },
      ],
    },
    governance: {
      status: 'available', asOf: ISO(T0), stale: false,
      signals: [
        { key: 'production_locked', state: 'ok' }, { key: 'approvals_enforced', state: 'ok' },
        { key: 'audit_recording', state: 'attention' },
      ],
    },
    services: { status: 'unavailable' },
  },
};

/** Every section available and every key present: each field is a place a reader string could go. */
const FULL_RAW = {
  posture: { status: 'available', asOf: T0, data: { tenants: 1, stores: 2, pending_approvals: 3, critical_alerts: 4 } },
  attention: { status: 'available', asOf: T0, data: { items: [{ severity: 'critical', area: 'tenants', count: 5 }, { severity: 'info', area: 'billing', count: 6 }] } },
  governance: { status: 'available', asOf: T0, data: { signals: { production_locked: 'ok', approvals_enforced: 'attention', audit_recording: 'unknown' } } },
  services: {
    status: 'available', asOf: T0,
    data: { auth: 'healthy', pos: 'warning', repairs: 'off', inventory: 'unknown', identity_link: 'healthy', audit: 'healthy', worker: 'off' },
  },
};

const FULL_SECTIONS = {
  posture: avail({
    metrics: [
      { key: 'tenants', value: 1 }, { key: 'stores', value: 2 },
      { key: 'pending_approvals', value: 3 }, { key: 'critical_alerts', value: 4 },
    ],
  }),
  attention: avail({ items: [{ severity: 'critical', area: 'tenants', count: 5 }, { severity: 'info', area: 'billing', count: 6 }] }),
  governance: avail({
    signals: [
      { key: 'production_locked', state: 'ok' }, { key: 'approvals_enforced', state: 'attention' },
      { key: 'audit_recording', state: 'unknown' },
    ],
  }),
  services: avail({
    services: [
      { key: 'auth', state: 'healthy' }, { key: 'pos', state: 'warning' }, { key: 'repairs', state: 'off' },
      { key: 'inventory', state: 'unknown' }, { key: 'identity_link', state: 'healthy' },
      { key: 'audit', state: 'healthy' }, { key: 'worker', state: 'off' },
    ],
  }),
};

type Path = Array<string | number>;

/** Every node path in a JSON-like value (object keys and array indices), parents first. */
function paths(value: unknown, prefix: Path = []): Path[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, Array.isArray(value) ? Number(key) : key];
    return [path, ...paths(child, path)];
  });
}

/** A deep copy of `value` with the node at `path` replaced by `by`. */
function replaced(value: unknown, path: Path, by: unknown): unknown {
  const copy = structuredClone(value);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]] = by;
  return copy;
}

// --- harness -------------------------------------------------------------------------------

interface Recorder { reads: unknown[][]; authorizations: unknown[][] }

function adminBoundary(rec: Recorder, authorize: (...args: unknown[]) => unknown): SessionBoundaryDeps {
  return {
    trustedOrigins: [ADMIN_ORIGIN],
    verifier: {
      async verify(credential) {
        return credential.bearerToken === BEARER
          ? { verified: true, authProvider: 'synthetic', authProviderUid: UID, authenticatedAt: T0, secondFactor: 'totp' }
          : null;
      },
    },
    admission: { admit: () => ({ admitted: true, securityVersion: 'v1' }) },
    authorizer: { authorize: (...args: unknown[]) => { rec.authorizations.push(args); return authorize(...args); } },
    store: createMemorySessionStore(),
  };
}

interface Harness { port: number; logs: string[]; rec: Recorder; id: string; csrf: string }
interface Setup { read?: (signal: AbortSignal) => unknown; authorize?: (...args: unknown[]) => unknown; deadlineMs?: number }

/** Serve the admin boundary plus the Command Center route, signed in as an admitted admin. */
async function withCommandCenter(setup: Setup, fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const rec: Recorder = { reads: [], authorizations: [] };
  const read = setup.read ?? ((): unknown => RAW);
  const reader: CommandCenterReader = {
    read: (...args: unknown[]) => { rec.reads.push(args); return read(args[0] as AbortSignal); },
  };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness,
    now: () => T0,
    log: { log: (line: string) => { logs.push(line); } },
    sessions: { admin: adminBoundary(rec, setup.authorize ?? (() => true)) },
    routes: commandCenterRoutes(reader, { now: () => T0, ...(setup.deadlineMs === undefined ? {} : { deadlineMs: setup.deadlineMs }) }),
    limits: testRequestLimits(),
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const login = await send(port, 'POST', sessionPaths('admin').login, {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${BEARER}`,
    });
    assert.equal(login.status, 200, `admin login: ${login.body}`);
    const pair = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
    await fn({ port, logs, rec, id: pair.slice(pair.indexOf('=') + 1), csrf });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

// --- the route -----------------------------------------------------------------------------

test('the route is one bodiless GET behind an admin session and the view_command_center requirement', () => {
  assert.equal(COMMAND_CENTER_PATH, P);
  assert.equal(STALE_AFTER_MS, 900_000);
  assert.equal(MAX_AGE_MS, 86_400_000);
  assert.deepEqual(COMMAND_CENTER_REQUIREMENT, { scope: 'platform', permission: 'view_command_center' });
  assert.ok(Object.isFrozen(COMMAND_CENTER_REQUIREMENT), 'the requirement is frozen');
  const defs = commandCenterRoutes({ read: () => ({}) });
  assert.equal(defs.length, 1);
  const [def] = defs;
  assert.deepEqual({ method: def.method, path: def.path, policy: def.policy, body: def.body, idempotency: def.idempotency }, {
    method: 'GET', path: P, body: { kind: 'none' }, idempotency: 'none',
    policy: { access: 'session', audience: 'admin', authorization: { scope: 'platform', permission: 'view_command_center' } },
  });
  assert.ok(Object.isFrozen(defs) && Object.isFrozen(def), 'the definitions are frozen');
});

test('a reader without a read function is refused at construction', () => {
  for (const reader of [undefined, null, {}, { read: 'x' }, { read: null }, 'read']) {
    assert.throws(() => commandCenterRoutes(reader as never),
      (err: unknown) => err instanceof EnforcementSetupError && err.code === 'route_handler_invalid', String(reader));
  }
  // The reader's deadline is one of the chain's port calls, so it stays within the port bound.
  for (const deadlineMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, PORT_DEADLINE_MS + 1]) {
    assert.throws(() => commandCenterRoutes({ read: () => ({}) }, { deadlineMs }),
      (err: unknown) => err instanceof EnforcementSetupError && err.code === 'port_deadline_invalid', String(deadlineMs));
  }
  for (const deadlineMs of [1, PORT_DEADLINE_MS]) assert.equal(commandCenterRoutes({ read: () => ({}) }, { deadlineMs }).length, 1);
});

test('an authorized admin session reads the exact bounded view, with the runtime headers', async () => {
  await withCommandCenter({}, async ({ port, rec, id }) => {
    const r = await send(port, 'GET', P, adminCookie(id));
    assert.equal(r.status, 200, r.body);
    assert.equal(r.body, JSON.stringify(EXPECTED), 'exactly the view, fields and sections in the contract order');
    assertPolicyHeaders(r.headers, 'view');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(rec.authorizations.length, 1, 'the server authorizer decides every read');
    const [, requirement, route, signal] = rec.authorizations[0];
    assert.deepEqual(requirement, { scope: 'platform', permission: 'view_command_center' });
    assert.deepEqual(route, { method: 'GET', path: P, audience: 'admin' });
    assert.ok(signal instanceof AbortSignal, 'the authorizer is handed its deadline signal');
    assert.equal(rec.reads.length, 1);
    assert.equal(rec.reads[0].length, 1, 'the reader is handed its signal and nothing else');
    assert.ok(rec.reads[0][0] instanceof AbortSignal, 'the reader is handed an AbortSignal');
  });
});

test('the handler reads nothing of the request, principal or session', async () => {
  const cases: Array<[string, () => unknown, number, unknown, string | undefined]> = [
    ['success', () => RAW, 200, EXPECTED, undefined],
    ['outage', () => { throw new Error('reader-secret-detail'); }, 503, { error: 'service_unavailable', requestId: 'req-isolated' }, 'command_center_unavailable'],
  ];
  for (const [label, read, status, body, refusal] of cases) {
    const touched: string[] = [];
    const req = new Proxy({}, { get(_target, key) { touched.push(`req.${String(key)}`); return undefined; } });
    const ctx = {
      requestId: 'req-isolated',
      body: undefined,
      get principal() { touched.push('principal'); return null; },
      get session() { touched.push('session'); return null; },
    } as RouteContext;
    const sent: unknown[] = [];
    const res = {
      locals: {} as Record<string, unknown>,
      status(code: number) { sent.push(code); return this; },
      json(payload: unknown) { sent.push(payload); return this; },
    };
    const [route] = commandCenterRoutes({ read }, { now: () => T0 });
    assert.ok(route.idempotency === 'none', 'the read model requires no idempotency');
    await route.handler(req as never, res as never, ctx);
    assert.deepEqual(touched, [], `${label}: no request, principal or session access`);
    assert.deepEqual(sent, [status, body], label);
    assert.equal(res.locals.refusal, refusal, label);
  }
});

test('without an admin session the answer is a 401 and the reader is never called', async () => {
  await withCommandCenter({}, async ({ port, rec, id }) => {
    const cases: Array<[string, Record<string, string>]> = [
      ['no cookie', {}],
      ['the admin session presented under the tenant cookie name', { cookie: `${SESSION_COOKIES.tenant}=${id}` }],
      ['an unknown admin session', adminCookie('A'.repeat(43))],
    ];
    for (const [label, headers] of cases) assertRefusal(await send(port, 'GET', P, headers), 401, 'unauthenticated', label);
    assert.equal(rec.authorizations.length, 0);
    assert.equal(rec.reads.length, 0);
  });
});

test('an authorizer denial is a generic 403 and an authorizer outage a 503; the reader is never called', async () => {
  const denials: Array<() => unknown> = [() => false, () => 'true', () => 1, () => ({ allowed: true }), () => Promise.resolve(false)];
  for (const decide of denials) {
    await withCommandCenter({ authorize: decide }, async ({ port, rec, id }) => {
      const r = await send(port, 'GET', P, adminCookie(id));
      assertRefusal(r, 403, 'forbidden', String(decide));
      assert.doesNotMatch(r.body, /command_center|view_|platform/, 'a denial names no permission');
      assert.equal(rec.reads.length, 0, String(decide));
    });
  }
  const outages: Array<() => unknown> = [() => { throw new Error('authz-backend-secret'); }, () => Promise.reject(new Error('authz-backend-secret'))];
  for (const decide of outages) {
    await withCommandCenter({ authorize: decide }, async ({ port, rec, logs, id }) => {
      const r = await send(port, 'GET', P, adminCookie(id));
      assertRefusal(r, 503, 'service_unavailable', String(decide));
      assert.ok(await logged(logs, 'authz_unavailable'), 'the outage is logged as authz_unavailable');
      assert.ok(!`${r.body}${logs.join('')}`.includes('authz-backend-secret'), 'no authorizer error text escapes');
      assert.equal(rec.reads.length, 0);
    });
  }
});

test('a reader failure is a bounded 503, and an overrunning read times out with its signal aborted', async () => {
  const failures: Array<() => unknown> = [() => { throw new Error('reader-secret-detail'); }, () => Promise.reject(new Error('reader-secret-detail'))];
  for (const read of failures) {
    await withCommandCenter({ read }, async ({ port, logs, id }) => {
      const r = await send(port, 'GET', P, adminCookie(id));
      assertRefusal(r, 503, 'service_unavailable', String(read));
      assert.ok(await logged(logs, 'command_center_unavailable'), `${String(read)} is logged as command_center_unavailable`);
      assert.ok(!`${r.body}${logs.join('')}`.includes('reader-secret-detail'), 'no reader error text escapes');
    });
  }
  await withCommandCenter({ read: () => new Promise(() => {}), deadlineMs: 50 }, async ({ port, logs, rec, id }) => {
    const r = await send(port, 'GET', P, adminCookie(id));
    assertRefusal(r, 503, 'service_unavailable', 'overrun');
    assert.ok(await logged(logs, 'command_center_timeout'), 'the overrun is logged as command_center_timeout');
    assert.equal((rec.reads[0][0] as AbortSignal).aborted, true, 'the overrun read is cancelled through its signal');
  });
});

test('nothing but the approved view leaves: extra reader fields, nested too, never reach the body', async () => {
  const SECRETS = {
    token: 'tok-SECRET-1', csrfToken: 'csrf-SECRET-2', databaseId: 'db-row-SECRET-3',
    uid: 'uid-SECRET-4', email: 'owner@secret.test', secret: 'shh-SECRET-5',
  };
  const leaky = {
    ...SECRETS,
    posture: { ...RAW.posture, ...SECRETS, data: { ...RAW.posture.data, ...SECRETS } },
    attention: {
      ...RAW.attention, ...SECRETS,
      data: { ...SECRETS, items: RAW.attention.data.items.map((item) => ({ ...item, ...SECRETS, summary: 'free text', nested: { ...SECRETS } })) },
    },
    governance: {
      ...RAW.governance, ...SECRETS,
      data: { ...RAW.governance.data, ...SECRETS, auditEvents24h: 42, signals: { ...RAW.governance.data.signals, ...SECRETS } },
    },
    services: { status: 'available', asOf: T0, ...SECRETS, data: { auth: 'healthy', ...SECRETS } },
  };
  await withCommandCenter({ read: () => leaky }, async ({ port, id, csrf }) => {
    const r = await send(port, 'GET', P, adminCookie(id));
    assert.equal(r.status, 200, r.body);
    for (const [key, value] of Object.entries({ ...SECRETS, summary: 'free text', auditEvents24h: '42' })) {
      assert.ok(!r.body.includes(`"${key}"`), `no ${key} key`);
      assert.ok(key === 'auditEvents24h' || !r.body.includes(value), `no ${key} value`);
    }
    for (const credential of [id, csrf, BEARER, UID]) assert.ok(!r.body.includes(credential), 'no session, CSRF token, bearer or UID');
    const view = JSON.parse(r.body) as unknown;
    assert.deepEqual(view, { ...EXPECTED, sections: { ...EXPECTED.sections, services: avail({ services: [{ key: 'auth', state: 'healthy' }] }) } });
    assertContractStringsOnly(view);
  });
});

test('no reader-supplied string ever reaches the body: a string in any field voids only its own section', async () => {
  let current: unknown = FULL_RAW;
  await withCommandCenter({ read: () => current }, async ({ port, id }) => {
    const baseline = JSON.parse((await send(port, 'GET', P, adminCookie(id))).body) as { sections: unknown };
    assert.deepEqual(baseline, { schemaVersion: 1, generatedAt: ISO(T0), sections: FULL_SECTIONS });
    assertContractStringsOnly(baseline);
    const every = paths(FULL_RAW);
    assert.equal(every.length, 40, 'the sweep reaches every field of every section');
    for (const [i, path] of every.entries()) {
      const marker = `reader-string-${i}`;
      current = replaced(FULL_RAW, path, marker);
      const r = await send(port, 'GET', P, adminCookie(id));
      const where = path.join('.');
      assert.equal(r.status, 200, `${where}: ${r.body}`);
      assert.ok(!r.body.includes(marker), `${where}: the reader string never reaches the body`);
      const view = JSON.parse(r.body) as { sections: unknown };
      assert.deepEqual(view.sections, { ...FULL_SECTIONS, [path[0]]: UNAVAILABLE }, `${where} voids its own section alone`);
      assertContractStringsOnly(view);
    }
    current = 'reader-string-root';
    const root = await send(port, 'GET', P, adminCookie(id));
    assert.ok(!root.body.includes('reader-string-root'), 'a string in place of the whole value never reaches the body');
    assert.deepEqual((JSON.parse(root.body) as { sections: unknown }).sections, ALL_UNAVAILABLE);
  });
});

test('the route has no state-changing operation: other methods and path variants are 404s that never read', async () => {
  await withCommandCenter({}, async ({ port, rec, id, csrf }) => {
    // Full session, origin and CSRF evidence, so a 404 cannot be a missing-credential artefact.
    const headers = {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      ...adminCookie(id), [SESSION_CSRF_HEADER]: csrf,
    };
    const probes: Array<[string, string]> = [
      ['POST', P], ['PUT', P], ['PATCH', P], ['DELETE', P], ['HEAD', P], ['OPTIONS', P],
      ['GET', `${P}/x`], ['GET', `${P}/`], ['GET', '/admin/v1/Command-Center'],
    ];
    for (const [method, path] of probes) {
      const r = await send(port, method, path, headers);
      assert.equal(r.status, 404, `${method} ${path}: ${r.body}`);
    }
    assert.equal(rec.authorizations.length, 0);
    assert.equal(rec.reads.length, 0);
  });
});

test('the deployable app composes no command-center route', () => {
  const app = createApp({ readiness: createReadinessState() });
  const routes = app.locals.routes as ReadonlyArray<{ path: string }>;
  assert.ok(routes.length > 0, 'the deployable app has its operational routes');
  assert.deepEqual(routes.filter((r) => /command-?center/i.test(r.path)), []);
});

// --- mapping (commandCenterView, pure) ------------------------------------------------------

const VALID_DATA: Record<SectionName, unknown> = { posture: { tenants: 1 }, attention: { items: [] }, governance: { signals: {} }, services: {} };

test('the view carries every section in order, and a plain object with a null prototype is accepted', () => {
  assert.deepEqual(commandCenterView(RAW, T0), EXPECTED);
  assert.deepEqual(Object.keys(commandCenterView({}, T0).sections), [...SECTIONS]);
  assert.deepEqual(commandCenterView(Object.assign(Object.create(null) as object, RAW), T0), EXPECTED);
});

test('a raw value that is not a plain object, or a hostile one, leaves every section unavailable', () => {
  const trap = (): never => { throw new Error('trap'); };
  class Holder { posture = RAW.posture; }
  const raws: unknown[] = [
    undefined, null, 0, 'posture', true, [], [RAW], new Map(Object.entries(RAW)), new Holder(),
    new Proxy({ ...RAW }, { get: trap, getOwnPropertyDescriptor: trap, has: trap }),
    new Proxy({ ...RAW }, { getPrototypeOf: trap }),
  ];
  // Labels by index: stringifying a hostile proxy would itself hit its traps.
  for (const [i, raw] of raws.entries()) {
    assert.deepEqual(commandCenterView(raw, T0), { schemaVersion: 1, generatedAt: ISO(T0), sections: ALL_UNAVAILABLE }, `raw #${i}`);
  }
});

test('an unusable server clock leaves every section unavailable instead of throwing', () => {
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1, 8.64e15 + 1]) {
    assert.deepEqual(commandCenterView(RAW, now), { schemaVersion: 1, generatedAt: ISO(0), sections: ALL_UNAVAILABLE }, String(now));
  }
  for (const now of [1, 8.64e15]) assert.equal(commandCenterView(RAW, now).generatedAt, ISO(now), `the clock bound ${now} is usable`);
});

test('an inherited key or array slot never reads as data, even from a polluted prototype', () => {
  // Each view is computed inside the pollution window and asserted after it is closed.
  const objectProto = Object.prototype as Record<string, unknown>;
  const arrayProto = Array.prototype as unknown as Record<number, unknown>;
  let section: unknown;
  let metrics: unknown;
  let hole: unknown;
  objectProto.posture = at({ tenants: 1 });
  objectProto.tenants = 5;
  arrayProto[0] = { severity: 'info', area: 'billing', count: 1 };
  try {
    section = commandCenterView({}, T0).sections.posture;
    metrics = only('posture', at({}));
    hole = only('attention', at({ items: new Array(1) }));
  } finally {
    delete objectProto.posture;
    delete objectProto.tenants;
    delete arrayProto[0];
  }
  assert.deepEqual(section, UNAVAILABLE, 'an inherited section is missing');
  assert.deepEqual(metrics, avail({ metrics: [] }), 'an inherited count is absent');
  assert.deepEqual(hole, UNAVAILABLE, 'an array hole never inherits an item');
});

test('a missing section is unavailable; only an explicit not_configured reading is not configured', () => {
  assert.deepEqual(commandCenterView({}, T0).sections, ALL_UNAVAILABLE);
  assert.deepEqual(commandCenterView({ postrue: at({ tenants: 1 }) }, T0).sections.posture, UNAVAILABLE, 'a mistyped key never reads as not configured');
  const cases: Array<[unknown, unknown]> = [
    [undefined, UNAVAILABLE],
    [{ status: 'unavailable' }, UNAVAILABLE],
    [{ status: 'not_configured' }, NOT_CONFIGURED],
    [{ status: 'unavailable', asOf: T0, data: { tenants: 1 } }, UNAVAILABLE],
    [{ status: 'not_configured', asOf: T0, data: {} }, NOT_CONFIGURED],
    [{ status: 'available' }, UNAVAILABLE],
    [{ status: 'Available', asOf: T0, data: {} }, UNAVAILABLE],
    [{ status: 'Not_Configured' }, UNAVAILABLE],
    [{ status: 'stale', asOf: T0, data: {} }, UNAVAILABLE],
    [{ asOf: T0, data: {} }, UNAVAILABLE],
    [null, UNAVAILABLE], ['not_configured', UNAVAILABLE], [[], UNAVAILABLE], [1, UNAVAILABLE],
  ];
  for (const name of SECTIONS) {
    for (const [reading, expected] of cases) assert.deepEqual(only(name, reading), expected, `${name}: ${JSON.stringify(reading)}`);
  }
});

test('an available reading needs a positive safe-integer asOf, at most 60 s ahead and at most 24 h old', () => {
  const bad: unknown[] = [
    undefined, null, 0, -1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, String(T0),
    T0 + 60_001, T0 - MAX_AGE_MS - 1, Number.MAX_SAFE_INTEGER + 2,
  ];
  for (const name of SECTIONS) {
    // Built inline: at()'s default would turn an explicit undefined back into T0.
    for (const asOf of bad) assert.deepEqual(only(name, { status: 'available', asOf, data: VALID_DATA[name] }), UNAVAILABLE, `${name}: ${String(asOf)}`);
  }
  assert.deepEqual(only('posture', at({ tenants: 1 }, T0 + 60_000)), avail({ metrics: [{ key: 'tenants', value: 1 }] }, T0 + 60_000));
  assert.deepEqual(only('posture', at({ tenants: 1 }, T0 - MAX_AGE_MS)),
    { status: 'available', asOf: ISO(T0 - MAX_AGE_MS), stale: true, metrics: [{ key: 'tenants', value: 1 }] }, 'exactly 24 h old is still shown, as stale');
});

test('a section is stale only when it is more than 15 minutes older than generatedAt', () => {
  const cases: Array<[number, boolean]> = [
    [T0 - STALE_AFTER_MS, false], [T0 - STALE_AFTER_MS - 1, true], [T0, false], [T0 + 60_000, false], [T0 - MAX_AGE_MS, true],
  ];
  for (const [asOf, stale] of cases) {
    for (const name of SECTIONS) {
      const section = only(name, at(VALID_DATA[name], asOf)) as Record<string, unknown>;
      assert.equal(section.status, 'available', name);
      assert.equal(section.asOf, ISO(asOf), name);
      assert.equal(section.stale, stale, `${name} at T0-${T0 - asOf}ms`);
    }
  }
});

test('posture emits its counts in the fixed order for present keys only; one bad count voids the section', () => {
  const posture = (data: unknown): unknown => only('posture', at(data));
  assert.deepEqual(posture({ critical_alerts: 4, extra: 'x', stores: 2, pending_approvals: 3, tenants: 1 }), avail({
    metrics: [
      { key: 'tenants', value: 1 }, { key: 'stores', value: 2 },
      { key: 'pending_approvals', value: 3 }, { key: 'critical_alerts', value: 4 },
    ],
  }));
  assert.deepEqual(posture({ stores: 0 }), avail({ metrics: [{ key: 'stores', value: 0 }] }));
  assert.deepEqual(posture({}), avail({ metrics: [] }));
  assert.deepEqual(posture({ tenants: 1_000_000_000 }), avail({ metrics: [{ key: 'tenants', value: 1_000_000_000 }] }));
  // An own key holding undefined is a value the source failed to give, never an absent metric.
  for (const count of [-1, 1.5, 1_000_000_001, '5', null, undefined, Number.NaN, true, {}]) {
    assert.deepEqual(posture({ tenants: 1, critical_alerts: count }), UNAVAILABLE, String(count));
  }
  for (const data of [undefined, null, [], 'tenants', 12]) assert.deepEqual(posture(data), UNAVAILABLE, String(data));
});

test('attention emits unique per-area severity counts sorted by severity then area; 16 entries are unavailable', () => {
  const attention = (items: unknown): unknown => only('attention', at({ items }));
  assert.deepEqual(attention([]), avail({ items: [] }), 'zero items: nothing needs attention');
  assert.deepEqual(attention([
    { severity: 'info', area: 'tenants', count: 1 }, { severity: 'critical', area: 'platform', count: 2 },
    { severity: 'warning', area: 'billing', count: 3 }, { severity: 'critical', area: 'tenants', count: 4 },
    { severity: 'info', area: 'security', count: 5 },
  ]), avail({
    items: [
      { severity: 'critical', area: 'tenants', count: 4 }, { severity: 'critical', area: 'platform', count: 2 },
      { severity: 'warning', area: 'billing', count: 3 },
      { severity: 'info', area: 'tenants', count: 1 }, { severity: 'info', area: 'security', count: 5 },
    ],
  }));
  const fifteen = SEVERITY_ORDER.flatMap((severity) => AREA_ORDER.map((area) => ({ severity, area, count: 1 })));
  assert.deepEqual(attention([...fifteen].reverse()), avail({ items: fifteen }), 'all fifteen pairs are kept, none truncated');
  assert.deepEqual(attention([...fifteen, { severity: 'info', area: 'platform', count: 1 }]), UNAVAILABLE, '16 entries');
  assert.deepEqual(attention([{ severity: 'warning', area: 'billing', count: 1 }, { severity: 'warning', area: 'billing', count: 2 }]), UNAVAILABLE,
    'a duplicate (severity, area) pair');
  for (const count of [0, -1, 1.5, 1_000_000_001, '3', null, undefined, Number.NaN]) {
    assert.deepEqual(attention([{ severity: 'info', area: 'billing', count }]), UNAVAILABLE, `count ${String(count)}`);
  }
  assert.deepEqual(attention([{ severity: 'info', area: 'billing', count: 1_000_000_000 }]),
    avail({ items: [{ severity: 'info', area: 'billing', count: 1_000_000_000 }] }));
  for (const items of [undefined, null, {}, 'x', [null], ['x'], [[]], [1]]) {
    assert.deepEqual(attention(items), UNAVAILABLE, JSON.stringify(items) ?? 'undefined');
  }
  assert.deepEqual(attention([{ severity: 'info', area: 'billing', count: 1, summary: 'free text', id: 'row-1' }]),
    avail({ items: [{ severity: 'info', area: 'billing', count: 1 }] }), 'unknown item fields are dropped');
});

test('an unknown enum value voids its section', () => {
  const cases: Array<[SectionName, unknown]> = [
    ['attention', { items: [{ severity: 'fatal', area: 'platform', count: 1 }] }],
    ['attention', { items: [{ severity: 'info', area: 'Billing', count: 1 }] }],
    ['attention', { items: [{ severity: 'info', count: 1 }] }],
    ['governance', { signals: { production_locked: 'OK' } }],
    ['governance', { signals: { audit_recording: true } }],
    ['governance', { signals: { approvals_enforced: undefined } }],
    ['services', { auth: undefined }],
    ...['operational', 'degraded', 'outage', 'disabled', 'Healthy', 'down'].map((state): [SectionName, unknown] => ['services', { auth: state }]),
    ['services', { worker: null }],
  ];
  for (const [name, data] of cases) assert.deepEqual(only(name, at(data)), UNAVAILABLE, `${name}: ${JSON.stringify(data)}`);
});

test('governance emits only its signals, in the fixed order and for present keys only', () => {
  const governance = (data: unknown): unknown => only('governance', at(data));
  assert.deepEqual(governance({ signals: { audit_recording: 'attention', extra: 'x', production_locked: 'ok', approvals_enforced: 'unknown' } }), avail({
    signals: [
      { key: 'production_locked', state: 'ok' }, { key: 'approvals_enforced', state: 'unknown' },
      { key: 'audit_recording', state: 'attention' },
    ],
  }));
  assert.deepEqual(governance({ signals: { approvals_enforced: 'ok' } }), avail({ signals: [{ key: 'approvals_enforced', state: 'ok' }] }));
  assert.deepEqual(governance({ signals: {} }), avail({ signals: [] }));
  assert.deepEqual(governance({ signals: { production_locked: 'ok' }, auditEvents24h: 42 }),
    avail({ signals: [{ key: 'production_locked', state: 'ok' }] }), 'no 24-hour audit count is part of the view');
  for (const data of [{}, { signals: null }, { signals: [] }, { signals: 'ok' }, null]) {
    assert.deepEqual(governance(data), UNAVAILABLE, JSON.stringify(data));
  }
});

test('services are emitted in the fixed order for present keys only, in the BCP health vocabulary', () => {
  const services = (data: unknown): unknown => only('services', at(data));
  assert.deepEqual(services({
    worker: 'off', audit: 'healthy', identity_link: 'warning', inventory: 'healthy',
    repairs: 'healthy', pos: 'warning', auth: 'healthy', payroll: 'down',
  }), avail({
    services: [
      { key: 'auth', state: 'healthy' }, { key: 'pos', state: 'warning' }, { key: 'repairs', state: 'healthy' },
      { key: 'inventory', state: 'healthy' }, { key: 'identity_link', state: 'warning' },
      { key: 'audit', state: 'healthy' }, { key: 'worker', state: 'off' },
    ],
  }), 'an unknown service is ignored');
  assert.deepEqual(services({ pos: 'off' }), avail({ services: [{ key: 'pos', state: 'off' }] }));
  assert.deepEqual(services({}), avail({ services: [] }));
  for (const data of [null, [], 'auth']) assert.deepEqual(services(data), UNAVAILABLE, String(data));
});

test('the view is deeply frozen and never freezes or shares the reader value', () => {
  const view = commandCenterView(RAW, T0);
  const frozenDeep = (value: unknown): boolean =>
    typeof value !== 'object' || value === null || (Object.isFrozen(value) && Object.values(value).every(frozenDeep));
  assert.ok(frozenDeep(view), 'every object and array in the view is frozen');
  assert.ok(!Object.isFrozen(RAW.attention.data.items[0]), 'the reader value is left untouched');
  const attention = view.sections.attention as { readonly items: readonly unknown[] };
  assert.ok(attention.items.every((item) => !(RAW.attention.data.items as unknown[]).includes(item)), 'no reader object is reused');
});
