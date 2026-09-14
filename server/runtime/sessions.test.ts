// Phase 4.0 M4 — login and session boundaries: real-socket contract for the two session boundaries.
//
// Synthetic credentials, principals, admission, authorizers, clocks and session stores cross a
// real loopback socket (127.0.0.1, ephemeral port) into createApp. Each boundary — tenant/store
// (/api/v1/*) and administrative (/admin/v1/*) — has its own cookie, audience, admission,
// authorizer, store, login policy and limits. The suite pins:
//   - login: an exact bodiless POST; the pre-session origin, Sec-Fetch-Site and intent checks;
//     the client limit BEFORE verification; the account limit keyed by the verified principal's
//     digest alone; the boundary's evidence policy (admin: a provider-verified second factor and
//     a recent authentication); boundary admission; and a fresh session only once every step
//     has passed;
//   - the host-locked cookie and its attributes, rotation and fixation, absolute and idle
//     expiry (slid only by a successful authorized request), and logout revocation with a
//     matching clearing cookie;
//   - admission revalidation at each boundary's own interval, revocation on denial or a changed
//     security version, and per-principal revocation;
//   - every port call bounded by the deadline and cancelled through its signal, an outage a 503
//     and a rejection a 401;
//   - opaque provider UIDs, cross-boundary isolation, session-bound CSRF and fail-closed storage;
//   - ports see frozen views only, and no credential, UID, cookie, CSRF token or adapter text
//     reaches a response or the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createApp, createReadinessState, createBoundedServer } from './app.js';
import type { AppDeps } from './app.js';
import type { BearerTokenView } from './access.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { createLimiterKeyring } from './rateLimit.js';
import type { DistributedRateLimiter, RateLimitRequest } from './rateLimit.js';
import { TEST_RATE_LIMIT_KEY, createMemoryRateLimiter, testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError, sessionPaths } from './routes.js';
import type { AuthorizationRequirement, RouteContext, RouteDefinition, SessionAudience, VerifiedPrincipal } from './routes.js';
import {
  ADMISSION_REVALIDATE_MS, LOGIN_POLICIES, SESSION_COOKIES, SESSION_CSRF_HEADER, SESSION_TTL, principalKeyOf,
} from './sessions.js';
import type { SessionBoundaryDeps, SessionRecord, SessionStore } from './sessions.js';
import { assertSessionStoreContract, createMemorySessionStore } from './memorySessionStore.testkit.js';
import { devDiagnosticAuthAdapter, stubFirebaseAuthAdapter } from '../platform-identity/authAdapter.js';
import { createRuntimeIdentityVerifier, IdentityCompositionError } from '../platform-identity/firebaseAdminAuthAdapter.js';
import type { FirebaseIdTokenVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';

const silent = { log: (): void => {} };
// Each boundary's own trusted origin, on its own host (docs/phase-4/03 §2 #1).
const ORIGINS: Record<SessionAudience, string> = { tenant: 'http://pos.trusted.test', admin: 'http://admin.trusted.test' };
const TRUSTED = ORIGINS.tenant;
/** The pre-session evidence for an unsafe request to a boundary: its own origin, same-origin, intent header. */
const pre = (audience: SessionAudience): Record<string, string> =>
  ({ origin: ORIGINS[audience], 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE });
const PRE_SESSION = pre('tenant');
const TENANT = sessionPaths('tenant');
const ADMIN = sessionPaths('admin');
const OPAQUE_RE = /^[A-Za-z0-9_-]{43}$/;
const NONE = { kind: 'none' } as const;
const T0 = 1_700_000_000_000;
/** The authorized read route behind each boundary: a successful request there is real activity. */
const READ_ROUTE: Record<SessionAudience, string> = { tenant: '/api/v1/probe', admin: '/admin/v1/probe' };
const aSignal = (): AbortSignal => new AbortController().signal;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// --- transport ---------------------------------------------------------------------------

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One request on its own connection; an unsafe request is framed with an explicit length. */
function send(port: number, method: string, path: string, headers: Record<string, string | string[]> = {}, body = ''): Promise<Reply> {
  const framed = method === 'GET' || method === 'HEAD'
    ? headers
    : { 'content-length': String(Buffer.byteLength(body)), ...(body ? { 'content-type': 'application/json' } : {}), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: framed as http.OutgoingHttpHeaders, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function assertPolicyHeaders(headers: http.IncomingHttpHeaders, label: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers[name.toLowerCase()], value, `${label}: ${name}`);
}

/** A bounded refusal: the status, `{ error, requestId }` only, the header policy, and no cookie. */
function assertRefusal(r: Reply, status: number, error: string, label: string): void {
  assert.equal(r.status, status, `${label}: ${r.body}`);
  const body = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], label);
  assert.equal(body.error, error, label);
  assertPolicyHeaders(r.headers, label);
  assert.equal(r.headers['set-cookie'], undefined, `${label}: a refusal never sets a cookie`);
}

interface SetCookie { name: string; value: string; attributes: string[] }

/** The reply's single Set-Cookie line: its name, value and sorted attributes. */
function setCookieOf(r: Reply): SetCookie {
  const lines = r.headers['set-cookie'] ?? [];
  assert.equal(lines.length, 1, 'exactly one Set-Cookie line');
  const [pair, ...attributes] = lines[0].split('; ');
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes: attributes.sort() };
}

const cookie = (audience: SessionAudience, id: string): Record<string, string> => ({ cookie: `${SESSION_COOKIES[audience]}=${id}` });

/** A raw exchange for a request head the test writes itself (repeated header lines stay repeated). */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(head));
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.on('data', (d: Buffer) => { text += d.toString('latin1'); });
    socket.on('close', () => { clearTimeout(timer); resolve(text); });
    socket.on('error', () => {});
  });
}

/** Whether a log record with this field value is present (records may trail the reply slightly). */
async function loggedWith(logs: string[], field: 'reason' | 'event', value: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (logs.some((line) => (JSON.parse(line) as Record<string, unknown>)[field] === value)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}
const logged = (logs: string[], reason: string): Promise<boolean> => loggedWith(logs, 'reason', reason);

// --- synthetic identities, ports and routes ------------------------------------------------

/** A synthetic provider identity: its UID and the evidence the provider would have verified. */
interface Identity {
  uid: unknown;
  verified?: unknown;
  secondFactor?: unknown;
  /** How long before the verification the identity authenticated (default one minute). */
  authAgeMs?: number;
  /** A literal authentication time, overriding authAgeMs (for malformed-evidence cases). */
  authenticatedAt?: unknown;
}

const IDENTITIES: Record<string, Identity> = {
  'tok-member': { uid: 'uid-member' },
  'tok-member-again': { uid: 'uid-member' },
  'tok-member-mfa': { uid: 'uid-member', secondFactor: 'totp' },
  'tok-owner': { uid: 'uid-owner', secondFactor: 'totp' },
  'tok-owner-again': { uid: 'uid-owner', secondFactor: 'totp' },
  'tok-stranger': { uid: 'uid-stranger', secondFactor: 'totp' },
  'tok-unverified': { uid: 'uid-member', verified: false },
};

/** What a verifier returns for `identity` when it verifies at time `t`. */
function verifiedIdentity(identity: Identity, t: number): unknown {
  return {
    verified: identity.verified ?? true,
    authProvider: 'synthetic',
    authProviderUid: identity.uid,
    authenticatedAt: 'authenticatedAt' in identity ? identity.authenticatedAt : t - (identity.authAgeMs ?? 60_000),
    secondFactor: identity.secondFactor ?? null,
  };
}

// Admission is explicit per boundary: a cryptographically valid identity alone admits nowhere.
const ADMITTED: Record<SessionAudience, ReadonlySet<string>> = {
  tenant: new Set(['uid-member', 'uid-owner']),
  admin: new Set(['uid-owner']),
};
const ADMIT = Object.freeze({ admitted: true, securityVersion: 'v1' });
const principal = (uid: string): VerifiedPrincipal => ({ authProvider: 'synthetic', authProviderUid: uid });

interface Probe {
  tokenViews: unknown[];
  verifySignals: unknown[];
  admissions: unknown[][];
  authorizations: unknown[][];
  handled: Record<string, number>;
  contexts: RouteContext[];
}

const newProbe = (): Probe => ({ tokenViews: [], verifySignals: [], admissions: [], authorizations: [], handled: {}, contexts: [] });

/** A limiter that always allows: the default when a test supplies no `setup.limiter` of its own. */
const generous = (): DistributedRateLimiter => ({
  consume: (r: RateLimitRequest) => ({ outcome: 'allowed', remaining: r.limit - r.cost }),
  probe: () => true,
});

/** Records every consume request while delegating to `base`. */
function recording(requests: RateLimitRequest[], base: DistributedRateLimiter): DistributedRateLimiter {
  return {
    consume: (r: RateLimitRequest, signal: AbortSignal) => { requests.push(r); return base.consume(r, signal); },
    probe: (signal: AbortSignal) => base.probe(signal),
  };
}

/** A recording limiter: always allowed everywhere, except where `rule` names a tighter, really-tracked limit. */
function tightened(requests: RateLimitRequest[], rule: (r: RateLimitRequest) => number | undefined): DistributedRateLimiter {
  const m = createMemoryRateLimiter();
  return recording(requests, {
    consume: (r: RateLimitRequest, s: AbortSignal) => {
      const limit = rule(r);
      return limit === undefined ? { outcome: 'allowed', remaining: r.limit - r.cost } : m.consume({ ...r, limit }, s);
    },
    probe: (s: AbortSignal) => m.probe(s),
  });
}

function boundary(
  audience: SessionAudience,
  probe: Probe,
  over: Partial<SessionBoundaryDeps> = {},
  clock: { t: number } = { t: T0 },
  identities: Record<string, Identity> = IDENTITIES,
): SessionBoundaryDeps {
  return {
    trustedOrigins: [ORIGINS[audience]],
    verifier: {
      async verify(tokenView: BearerTokenView, signal: AbortSignal): Promise<unknown> {
        probe.tokenViews.push(tokenView);
        probe.verifySignals.push(signal);
        const identity = identities[tokenView.bearerToken];
        return identity === undefined ? null : verifiedIdentity(identity, clock.t);
      },
    },
    admission: {
      admit(p: VerifiedPrincipal, a: SessionAudience, signal: AbortSignal): unknown {
        probe.admissions.push([p, a, signal]);
        return ADMITTED[a].has(p.authProviderUid) ? ADMIT : { admitted: false };
      },
    },
    authorizer: {
      authorize(...args: unknown[]): boolean {
        probe.authorizations.push(args);
        return (args[1] as AuthorizationRequirement).permission !== 'probe.denied';
      },
    },
    store: createMemorySessionStore(),
    ...over,
  };
}

/** Synthetic business routes behind each boundary (test-only; never in the production table). */
function probeRoutes(probe: Probe): RouteDefinition[] {
  const handle = (name: string) => (_req: Request, res: Response, ctx: RouteContext): void => {
    probe.handled[name] = (probe.handled[name] ?? 0) + 1;
    probe.contexts.push(ctx);
    res.status(200).json({ ok: true });
  };
  const tenant = (permission: string) => ({ access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission } }) as const;
  const admin = (permission: string) => ({ access: 'session', audience: 'admin', authorization: { scope: 'platform', permission } }) as const;
  return [
    { method: 'POST', path: '/api/v1/probe', body: NONE, idempotency: 'none', handler: handle('tenantWrite'), policy: tenant('probe.write') },
    { method: 'GET', path: '/api/v1/probe', body: NONE, idempotency: 'none', handler: handle('tenantRead'), policy: tenant('probe.read') },
    { method: 'GET', path: '/api/v1/probe/denied', body: NONE, idempotency: 'none', handler: handle('tenantDenied'), policy: tenant('probe.denied') },
    { method: 'GET', path: '/api/v1/probe/fail', body: NONE, idempotency: 'none', handler: () => { throw new Error('handler-secret-detail'); }, policy: tenant('probe.read') },
    { method: 'POST', path: '/admin/v1/probe', body: NONE, idempotency: 'none', handler: handle('adminWrite'), policy: admin('probe.admin') },
    { method: 'GET', path: '/admin/v1/probe', body: NONE, idempotency: 'none', handler: handle('adminRead'), policy: admin('probe.admin') },
  ];
}

interface Harness { port: number; logs: string[]; probe: Probe; clock: { t: number } }
interface Setup {
  tenant?: Partial<SessionBoundaryDeps>;
  admin?: Partial<SessionBoundaryDeps>;
  identities?: Record<string, Identity>;
  deadlineMs?: number;
  limiter?: DistributedRateLimiter;
}

/** Serve both boundaries on 127.0.0.1:<ephemeral> for `fn`; always closes server and sockets. */
async function withSessions(setup: Setup, fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const probe = newProbe();
  const clock = { t: T0 };
  const identities = { ...IDENTITIES, ...setup.identities };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness,
    now: () => clock.t,
    log: { log: (line: string) => { logs.push(line); } },
    trustedOrigins: [TRUSTED],
    routes: probeRoutes(probe),
    ...(setup.deadlineMs === undefined ? {} : { portDeadlineMs: setup.deadlineMs }),
    limits: testRequestLimits({ limiter: setup.limiter ?? generous() }),
    sessions: {
      tenant: boundary('tenant', probe, setup.tenant, clock, identities),
      admin: boundary('admin', probe, setup.admin, clock, identities),
    },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ port: (server.address() as AddressInfo).port, logs, probe, clock });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const login = (port: number, audience: SessionAudience, token: string, headers: Record<string, string> = {}): Promise<Reply> =>
  send(port, 'POST', sessionPaths(audience).login, { ...pre(audience), authorization: `Bearer ${token}`, ...headers });

interface Session { id: string; csrf: string }

async function signIn(port: number, audience: SessionAudience, token: string, headers: Record<string, string> = {}): Promise<Session> {
  const r = await login(port, audience, token, headers);
  assert.equal(r.status, 200, `${audience} login ${token}: ${r.body}`);
  return { id: setCookieOf(r).value, csrf: (JSON.parse(r.body) as { csrfToken: string }).csrfToken };
}

const current = (port: number, audience: SessionAudience, id: string): Promise<Reply> =>
  send(port, 'GET', sessionPaths(audience).current, cookie(audience, id));

/** Headers for an unsafe session request: the pre-session checks, the cookie and a CSRF token. */
const unsafe = (audience: SessionAudience, s: Session, csrf: string | string[] = s.csrf): Record<string, string | string[]> =>
  ({ ...pre(audience), ...cookie(audience, s.id), [SESSION_CSRF_HEADER]: csrf });

/**
 * An in-memory store that records each operation (`update:<fields>` for an update) and rejects
 * the one operation `failing` names.
 */
function instrumented(ops: string[], failing: { op?: string } = {}): SessionStore {
  const base = createMemorySessionStore();
  const run = (op: string, act: () => unknown): Promise<unknown> => {
    ops.push(op);
    return failing.op === op ? Promise.reject(new Error(`store-secret-detail-${op}`)) : Promise.resolve(act());
  };
  return {
    create: (key, record, signal) => run('create', () => base.create(key, record, signal)),
    get: (key, signal) => run('get', () => base.get(key, signal)),
    update: (key, fields, signal) => run(`update:${Object.keys(fields).join(',')}`, () => base.update(key, fields, signal)),
    revoke: (key, signal) => run('revoke', () => base.revoke(key, signal)),
    revokePrincipal: (audience, key, signal) => run('revokePrincipal', () => base.revokePrincipal(audience, key, signal)),
  };
}

// --- login ---------------------------------------------------------------------------------

test('tenant login issues a fresh host-locked session cookie and CSRF token, and the session is then active', async () => {
  await withSessions({}, async ({ port, probe }) => {
    const r = await login(port, 'tenant', 'tok-member');
    assert.equal(r.status, 200, r.body);
    assertPolicyHeaders(r.headers, 'login');
    const c = setCookieOf(r);
    assert.equal(c.name, '__Host-tmpos_tenant_session');
    assert.match(c.value, OPAQUE_RE);
    assert.deepEqual(c.attributes, ['HttpOnly', 'Max-Age=28800', 'Path=/', 'SameSite=Strict', 'Secure']);
    assert.equal(28800 * 1000, SESSION_TTL.tenant.absoluteMs, 'the cookie lives exactly as long as the server session');
    const { csrfToken } = JSON.parse(r.body) as { csrfToken: string };
    assert.match(csrfToken, OPAQUE_RE);
    assert.notEqual(csrfToken, c.value, 'the CSRF token is not the session identifier');
    const active = await current(port, 'tenant', c.value);
    assert.equal(active.status, 200);
    assert.equal(active.headers['set-cookie'], undefined, 'reading the session never re-issues its cookie');
    assert.equal((JSON.parse(active.body) as { csrfToken: string }).csrfToken, csrfToken);
    assert.deepEqual(probe.admissions.map(([, audience]) => audience), ['tenant']);
  });
});

test('an administrative session is issued only to an identity the admin admission explicitly admits', async () => {
  await withSessions({}, async ({ port, probe }) => {
    // A tenant member, even with a verified second factor, is refused: there is no promotion to admin.
    assertRefusal(await login(port, 'admin', 'tok-member-mfa'), 401, 'unauthenticated', 'tenant member at the admin login');
    const owner = await login(port, 'admin', 'tok-owner');
    assert.equal(owner.status, 200, owner.body);
    const c = setCookieOf(owner);
    assert.equal(c.name, '__Host-tmpos_admin_session');
    assert.match(c.value, OPAQUE_RE);
    assert.deepEqual(c.attributes, ['HttpOnly', 'Max-Age=3600', 'Path=/', 'SameSite=Strict', 'Secure']);
    assert.equal(3600 * 1000, SESSION_TTL.admin.absoluteMs);
    assert.equal((await current(port, 'admin', c.value)).status, 200);
    assert.deepEqual(probe.admissions.map(([p, audience]) => [(p as VerifiedPrincipal).authProviderUid, audience]),
      [['uid-member', 'admin'], ['uid-owner', 'admin']]);
  });
});

test('a valid identity without boundary admission gets exactly the refusal a bad credential gets', async () => {
  await withSessions({}, async ({ port, logs }) => {
    const unadmitted = await login(port, 'tenant', 'tok-stranger');
    const rejected = await login(port, 'tenant', 'tok-nobody');
    for (const [label, r] of [['unadmitted', unadmitted], ['rejected', rejected]] as const) {
      assertRefusal(r, 401, 'unauthenticated', label);
      assert.equal(r.headers['www-authenticate'], 'Bearer', label);
    }
    const shape = (r: Reply): string => JSON.stringify({ ...(JSON.parse(r.body) as object), requestId: undefined });
    assert.equal(shape(unadmitted), shape(rejected), 'nothing distinguishes a missing admission from a bad credential');
    assert.ok(await logged(logs, 'login_admission_denied'), 'the log alone tells them apart');
    assert.ok(await logged(logs, 'authn_rejected'));
  });
  // Only an exact { admitted: true, securityVersion } admits; every other value is a denial.
  const denials: Array<() => unknown> = [
    () => true, () => 'true', () => ({ admitted: 'true', securityVersion: 'v1' }), () => ({ admitted: true }),
    () => ({ admitted: true, securityVersion: '' }), () => ({ admitted: true, securityVersion: 'x'.repeat(129) }),
    () => ({ admitted: true, securityVersion: 'has space' }), () => Promise.resolve({ admitted: false }),
  ];
  for (const decide of denials) {
    await withSessions({ tenant: { admission: { admit: decide } } }, async ({ port, logs }) => {
      assertRefusal(await login(port, 'tenant', 'tok-member'), 401, 'unauthenticated', String(decide));
      assert.ok(await logged(logs, 'login_admission_denied'), `${String(decide)} is a denial`);
    });
  }
  // A failing admission source is an outage, never a credential verdict: a bounded 503.
  for (const decide of [() => { throw new Error('admission-backend-secret'); }, () => Promise.reject(new Error('admission-backend-secret'))]) {
    await withSessions({ tenant: { admission: { admit: decide } } }, async ({ port, logs }) => {
      const r = await login(port, 'tenant', 'tok-member');
      assertRefusal(r, 503, 'service_unavailable', String(decide));
      assert.equal(r.headers['www-authenticate'], undefined, 'an outage is no credential challenge');
      assert.ok(await logged(logs, 'admission_unavailable'));
      assert.ok(!`${r.body}${logs.join('')}`.includes('admission-backend-secret'), 'no admission error text escapes');
    });
  }
});

test('malformed, duplicate and oversized credentials never reach the verifier; unverifiable ones are refused by it', async () => {
  await withSessions({}, async ({ port, probe }) => {
    const shapes: Array<string | string[] | undefined> = [
      undefined, 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer  tok-member', 'Bearer tok-member extra', 'Bearer tok"member',
      `Bearer ${'a'.repeat(4097)}`, ['Bearer tok-member', 'Bearer tok-member'], ['Bearer tok-member', 'Bearer tok-owner'],
    ];
    for (const authorization of shapes) {
      const headers = authorization === undefined ? PRE_SESSION : { ...PRE_SESSION, authorization };
      const r = await send(port, 'POST', TENANT.login, headers);
      assertRefusal(r, 401, 'unauthenticated', String(authorization).slice(0, 40));
      assert.equal(r.headers['www-authenticate'], 'Bearer');
    }
    assert.equal(probe.tokenViews.length, 0, 'structurally invalid evidence never reaches the verifier');
    for (const token of ['tok-nobody', 'tok-unverified']) assertRefusal(await login(port, 'tenant', token), 401, 'unauthenticated', token);
    assert.equal(probe.tokenViews.length, 2, 'each well-formed credential is verified exactly once');
    assert.equal(probe.admissions.length, 0, 'an unverified identity is never offered for admission');
  });
});

test('a rejected credential is a 401 and a verifier outage a 503, and neither spends an account bucket', async () => {
  const requests: RateLimitRequest[] = [];
  const accountRequests = (): RateLimitRequest[] => requests.filter((r) => r.namespace === 'tenant-login' && r.dimension === 'account');
  let outage = false;
  await withSessions({
    tenant: {
      verifier: {
        async verify(tokenView: BearerTokenView): Promise<unknown> {
          if (outage) throw new Error('provider-secret-detail');
          return tokenView.bearerToken === 'tok-member' ? verifiedIdentity(IDENTITIES['tok-member'], T0) : null;
        },
      },
    },
    limiter: tightened(requests, () => undefined),
  }, async ({ port, logs }) => {
    const rejected = await login(port, 'tenant', 'tok-nobody');
    assertRefusal(rejected, 401, 'unauthenticated', 'a rejected credential');
    assert.equal(rejected.headers['www-authenticate'], 'Bearer');
    outage = true;
    const down = await login(port, 'tenant', 'tok-member');
    assertRefusal(down, 503, 'service_unavailable', 'a verifier outage');
    assert.equal(down.headers['www-authenticate'], undefined, 'an outage is no credential challenge');
    assert.deepEqual(accountRequests(), [], 'neither a rejected credential nor an outage spent an account bucket');
    outage = false;
    assert.equal((await login(port, 'tenant', 'tok-member')).status, 200, 'the provider back, the same credential signs in');
    assert.equal(accountRequests().length, 1);
    assert.ok(await logged(logs, 'authn_rejected'));
    assert.ok(await logged(logs, 'authn_unavailable'));
    assert.ok(!logs.join('').includes('provider-secret-detail'));
  });
});

// --- administrative MFA and recent authentication -----------------------------------------------

test('an administrative login needs a provider-verified second factor and a recent authentication', async () => {
  const policy = LOGIN_POLICIES.admin;
  assert.ok(policy.maxAuthAgeMs !== null && policy.secondFactors !== null, 'the admin boundary has an evidence policy');
  const maxAge = policy.maxAuthAgeMs;
  assert.deepEqual([...policy.secondFactors], ['totp'], 'TOTP is the only administrative second factor');
  const accepted: Record<string, Identity> = {
    'tok-totp': { uid: 'uid-owner', secondFactor: 'totp' },
    'tok-at-the-limit': { uid: 'uid-owner', secondFactor: 'totp', authAgeMs: maxAge },
    'tok-within-skew': { uid: 'uid-owner', secondFactor: 'totp', authAgeMs: -4_000 },
  };
  const refused: Record<string, [Identity, string]> = {
    'tok-no-factor': [{ uid: 'uid-owner' }, 'login_mfa_missing'],
    'tok-factor-number': [{ uid: 'uid-owner', secondFactor: 42 }, 'login_mfa_missing'],
    'tok-factor-upper': [{ uid: 'uid-owner', secondFactor: 'TOTP' }, 'login_mfa_missing'],
    'tok-factor-email': [{ uid: 'uid-owner', secondFactor: 'email' }, 'login_mfa_unsupported'],
    // Phone MFA is refused: its reCAPTCHA needs script hosts outside the admin CSP (G-WEBHARDEN).
    'tok-phone': [{ uid: 'uid-owner', secondFactor: 'phone' }, 'login_mfa_unsupported'],
    'tok-no-auth-time': [{ uid: 'uid-owner', secondFactor: 'totp', authenticatedAt: undefined }, 'login_auth_time_missing'],
    'tok-auth-time-string': [{ uid: 'uid-owner', secondFactor: 'totp', authenticatedAt: String(T0) }, 'login_auth_time_missing'],
    'tok-auth-time-fraction': [{ uid: 'uid-owner', secondFactor: 'totp', authenticatedAt: T0 - 0.5 }, 'login_auth_time_missing'],
    'tok-stale': [{ uid: 'uid-owner', secondFactor: 'totp', authAgeMs: maxAge + 1 }, 'login_auth_stale'],
    'tok-future': [{ uid: 'uid-owner', secondFactor: 'totp', authAgeMs: -60_000 }, 'login_auth_time_future'],
  };
  const identities = { ...accepted, ...Object.fromEntries(Object.entries(refused).map(([token, [identity]]) => [token, identity])) };
  await withSessions({ identities }, async ({ port, logs, probe }) => {
    for (const token of Object.keys(accepted)) assert.equal((await login(port, 'admin', token)).status, 200, token);
    const admitted = probe.admissions.length;
    for (const [token, [, reason]] of Object.entries(refused)) {
      const r = await login(port, 'admin', token);
      assertRefusal(r, 401, 'unauthenticated', token);
      assert.equal(r.headers['www-authenticate'], 'Bearer', token);
      assert.ok(await logged(logs, reason), `${token} logs ${reason}`);
    }
    assert.equal(probe.admissions.length, admitted, 'refused evidence is never offered for admission');
    // A claim the client asserts is never evidence: only what the verifier reports counts.
    const claimed = await login(port, 'admin', 'tok-no-factor', { 'x-tmpos-second-factor': 'totp', 'x-auth-time': String(T0), amr: 'mfa' });
    assertRefusal(claimed, 401, 'unauthenticated', 'client-asserted MFA');
    // The tenant boundary keeps its own policy: no second factor or recency is required there.
    assert.equal((await login(port, 'tenant', 'tok-no-factor')).status, 200, 'tenant login without a second factor');
  });
  await withSessions({ identities: { 'tok-days-old': { uid: 'uid-member', authAgeMs: 2 * 24 * 3_600_000 } } }, async ({ port }) => {
    assert.equal((await login(port, 'tenant', 'tok-days-old')).status, 200, 'tenant login with a long-lived provider session');
  });
});

// --- provider identifiers ------------------------------------------------------------------------

test('a provider UID is opaque and bounded: any valid one signs in, a malformed or oversized one never does', async () => {
  const valid = ['user/with/slashes', 'name with spaces', 'ünïcödé-ユーザー', 'emoji-😀-uid', `quote'"<>&;=`, 'x'.repeat(128)];
  const invalid: unknown[] = ['', 'x'.repeat(129), '\uD800-lone-surrogate', 42, null];
  const identities: Record<string, Identity> = Object.fromEntries([
    ...valid.map((uid, i) => [`tok-valid-${i}`, { uid }]),
    ...invalid.map((uid, i) => [`tok-invalid-${i}`, { uid }]),
  ]);
  const requests: RateLimitRequest[] = [];
  await withSessions({
    identities, tenant: { admission: { admit: () => ADMIT } }, limiter: tightened(requests, () => undefined),
  }, async ({ port, logs }) => {
    const bodies: string[] = [];
    for (let i = 0; i < valid.length; i++) {
      const r = await login(port, 'tenant', `tok-valid-${i}`);
      assert.equal(r.status, 200, `valid UID ${i}: ${r.body}`);
      const reply = await current(port, 'tenant', setCookieOf(r).value);
      assert.equal(reply.status, 200);
      bodies.push(r.body, reply.body);
    }
    for (let i = 0; i < invalid.length; i++) {
      assertRefusal(await login(port, 'tenant', `tok-invalid-${i}`), 401, 'unauthenticated', `malformed UID ${i}`);
    }
    assert.ok(await logged(logs, 'authn_rejected'));
    const keys = requests.filter((r) => r.namespace === 'tenant-login' && r.dimension === 'account').map((r) => r.key);
    const keyring = createLimiterKeyring(TEST_RATE_LIMIT_KEY);
    const expected = valid.map((uid) => keyring.keyOf('tenant-login', 'account', principalKeyOf(principal(uid))));
    assert.deepEqual(keys, expected, 'each valid UID has its own keyring-derived account key');
    assert.ok(keys.every((k) => OPAQUE_RE.test(k)), 'a bucket is keyed by a fixed-size digest, never the UID');
    const seen = `${bodies.join('\n')}\n${logs.join('\n')}`;
    for (const uid of valid.slice(0, -1)) assert.ok(!seen.includes(uid), `UID ${uid} reached a response or the log`);
  });
  // The storage key is a digest over the provider and the whole UID: no two UIDs share one.
  const keyOf = (uid: string): string => principalKeyOf(principal(uid));
  assert.notEqual(keyOf('a b'), keyOf('a_b'));
  assert.notEqual(keyOf('a:b'), keyOf('a-b'));
  assert.notEqual(principalKeyOf({ authProvider: 'synthetic', authProviderUid: 'x' }), principalKeyOf({ authProvider: 'synthetix', authProviderUid: 'x' }));
  assert.match(keyOf('ünïcödé'), OPAQUE_RE);
});

// --- composition ---------------------------------------------------------------------------

test('a session boundary cannot start without every port, a distinct host or a bounded port deadline', () => {
  const code = (deps: Partial<AppDeps>): string | undefined => {
    try {
      createApp({ readiness: createReadinessState(), log: silent, trustedOrigins: [TRUSTED], limits: testRequestLimits(), ...deps });
    } catch (err) {
      return err instanceof EnforcementSetupError ? err.code : 'unexpected_error_type';
    }
    return undefined;
  };
  const full = boundary('tenant', newProbe());
  const without = (key: keyof SessionBoundaryDeps): SessionBoundaryDeps => {
    const copy: Partial<SessionBoundaryDeps> = { ...full };
    delete copy[key];
    return copy as SessionBoundaryDeps;
  };
  const supplied: SessionStore = {
    create: () => undefined, get: () => undefined, update: () => undefined, revoke: () => undefined, revokePrincipal: () => undefined,
  };
  const admin = (over: Partial<SessionBoundaryDeps> = {}): SessionBoundaryDeps => boundary('admin', newProbe(), over);
  const cases: Array<[string, Partial<AppDeps>, string | undefined]> = [
    ['no verifier', { sessions: { tenant: without('verifier') } }, 'session_verifier_required'],
    ['a verifier without verify', { sessions: { tenant: { ...full, verifier: {} as never } } }, 'session_verifier_required'],
    ['no admission', { sessions: { admin: without('admission') } }, 'session_admission_required'],
    ['an admission without admit', { sessions: { admin: { ...full, admission: {} as never } } }, 'session_admission_required'],
    ['an authorizer without authorize', { sessions: { tenant: { ...full, authorizer: {} as never } } }, 'session_authorizer_required'],
    ['no store', { sessions: { tenant: without('store') } }, 'session_store_required'],
    ['a partial store', { sessions: { tenant: { ...full, store: { get: () => undefined } as never } } }, 'session_store_required'],
    ['a store without principal revocation', { sessions: { tenant: { ...full, store: { ...supplied, revokePrincipal: undefined } as never } } }, 'session_store_required'],
    ['no authorizer', { sessions: { admin: without('authorizer') } }, 'session_authorizer_required'],
    ['a per-boundary login limiter is no longer a port', { sessions: { tenant: { ...full, loginClientLimiter: {} } as never } }, 'session_boundary_invalid'],
    ['an unknown port', { sessions: { tenant: { ...full, fallbackVerifier: full.verifier } as never } }, 'session_boundary_invalid'],
    ['an unknown boundary', { sessions: { partner: full } as never }, 'session_boundary_invalid'],
    ['a boundary that is not an object', { sessions: { tenant: 'enabled' } as never }, 'session_boundary_invalid'],
    ['no boundary origins', { sessions: { tenant: without('trustedOrigins') } }, 'trusted_origins_required'],
    ['an empty boundary origin list', { sessions: { tenant: { ...full, trustedOrigins: [] } } }, 'trusted_origins_required'],
    ['a boundary origin that is not a list', { sessions: { tenant: { ...full, trustedOrigins: ORIGINS.tenant as never } } }, 'trusted_origins_required'],
    ['a non-canonical boundary origin', { sessions: { tenant: { ...full, trustedOrigins: ['*'] } } }, 'trusted_origin_invalid'],
    ['boundaries sharing an origin', { sessions: { tenant: full, admin: admin({ trustedOrigins: [ORIGINS.admin, ORIGINS.tenant] }) } }, 'session_origins_shared'],
    ['boundaries sharing a host on another port', {
      sessions: { tenant: full, admin: admin({ trustedOrigins: ['http://pos.trusted.test:8443'] }) },
    }, 'session_origins_shared'],
    ['a route standing in for a session endpoint', {
      sessions: { tenant: full },
      routes: [{ method: 'POST', path: TENANT.login, policy: { access: 'login', audience: 'tenant' }, body: NONE, idempotency: 'none', handler: () => {} }],
    }, 'route_duplicate'],
    ['a session route whose boundary is not composed', { routes: probeRoutes(newProbe()) }, 'session_boundary_unconfigured'],
    ['a business route borrowing the logout path with another method', {
      sessions: { tenant: full },
      routes: [{
        method: 'GET', path: TENANT.logout, body: NONE, idempotency: 'none', handler: () => {},
        policy: { access: 'session', audience: 'tenant', authorization: { scope: 'tenant', permission: 'probe.read' } },
      }],
    }, 'route_session_endpoint_invalid'],
    ['a zero port deadline', { portDeadlineMs: 0 }, 'port_deadline_invalid'],
    ['a port deadline past the request timeout', { portDeadlineMs: 30_001 }, 'port_deadline_invalid'],
    ['a port deadline the longest chain would outlast the socket with', { portDeadlineMs: 3_751 }, 'port_deadline_invalid'],
    ['the largest port deadline', { portDeadlineMs: 3_750 }, undefined],
    ['boundaries sharing a host spelled with a trailing dot', {
      sessions: { tenant: full, admin: admin({ trustedOrigins: ['http://pos.trusted.test.'] }) },
    }, 'session_origins_shared'],
    ['sessions composed but no limits', { sessions: { tenant: full }, limits: undefined }, 'rate_limit_required'],
    ['a supplied store', { sessions: { tenant: { ...full, store: supplied } } }, undefined],
    ['both boundaries on distinct hosts', { sessions: { tenant: full, admin: admin() } }, undefined],
  ];
  for (const [label, deps, expected] of cases) assert.equal(code(deps), expected, label);
});

test('the test store meets the session-store contract a durable production store must meet', async () => {
  await assertSessionStoreContract(createMemorySessionStore());
});

const SYNTHETIC_FIREBASE_ENV = {
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'demo-synthetic', client_email: 'verifier@demo-synthetic.test',
    // A freshly generated key (never a real credential): composition parses the key locally.
    private_key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }),
};

test('the existing Firebase adapter is the production authenticator, and it will not compose without configuration', async () => {
  for (const env of [{}, { FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: '' }, { FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: '{"type":"authorized_user"}' }]) {
    assert.throws(() => createRuntimeIdentityVerifier(env), (err: unknown) =>
      err instanceof IdentityCompositionError && err.code === 'identity_verifier_unconfigured' && !err.message.includes('authorized_user'));
  }
  const seen: string[] = [];
  const authTime = Math.floor(T0 / 1000) - 60;
  const firebase: FirebaseIdTokenVerifier = {
    async verify(idToken: string) {
      seen.push(idToken);
      if (idToken === 'fb.outage.token') throw Object.assign(new Error('firebase-secret-detail'), { code: 'app/network-error' });
      if (idToken === 'fb.nomfa.token') return { uid: 'fb-uid-owner', authTime };
      if (idToken !== 'fb.good.token') throw Object.assign(new Error('firebase-secret-detail'), { code: 'auth/id-token-revoked' });
      return { uid: 'fb-uid-owner', authTime, secondFactor: 'totp' };
    },
  };
  const verifier = createRuntimeIdentityVerifier(SYNTHETIC_FIREBASE_ENV, { verifier: firebase });
  const admission = { admit: (p: VerifiedPrincipal): unknown => (p.authProvider === 'firebase' && p.authProviderUid === 'fb-uid-owner' ? ADMIT : { admitted: false }) };
  await withSessions({ admin: { verifier, admission } }, async ({ port, logs }) => {
    const ok = await login(port, 'admin', 'fb.good.token');
    assert.equal(ok.status, 200, ok.body);
    // The adapter's verified sign-in time and second factor are the admin evidence.
    assertRefusal(await login(port, 'admin', 'fb.nomfa.token'), 401, 'unauthenticated', 'a verified token without a second factor');
    const revoked = await login(port, 'admin', 'fb.revoked.token');
    assertRefusal(revoked, 401, 'unauthenticated', 'a revoked token');
    // An outage is no credential verdict: a bounded 503, and a distinct reason in the log.
    const outage = await login(port, 'admin', 'fb.outage.token');
    assertRefusal(outage, 503, 'service_unavailable', 'a verifier outage');
    assert.deepEqual(seen, ['fb.good.token', 'fb.nomfa.token', 'fb.revoked.token', 'fb.outage.token'], 'the adapter receives exactly the bearer token');
    assert.ok(await logged(logs, 'login_mfa_missing'));
    assert.ok(await logged(logs, 'authn_rejected'));
    assert.ok(await logged(logs, 'authn_unavailable'));
    assert.ok(!`${revoked.body}${outage.body}${logs.join('')}`.includes('firebase-secret-detail'));
  });
});

test('no DEV or diagnostic adapter can stand in for the production authenticator', async () => {
  // The stub throws (an unavailable verifier, 503); the DEV adapter finds no actor in the credential view (401).
  const seams = [[devDiagnosticAuthAdapter, 401, 'unauthenticated'], [stubFirebaseAuthAdapter, 503, 'service_unavailable']] as const;
  for (const [adapter, status, error] of seams) {
    // Cast: these seams read the raw request; the runtime hands every verifier the credential view only.
    await withSessions({ tenant: { verifier: adapter as unknown as SessionBoundaryDeps['verifier'] } }, async ({ port, logs }) => {
      assertRefusal(await login(port, 'tenant', 'tok-member'), status, error, adapter.name);
      // The DEV adapter's actor would live in a request body, and the login exchange takes none.
      const asserted = JSON.stringify({ devActor: { authProviderUid: 'uid-owner', actorType: 'platform_user' } });
      const r = await send(port, 'POST', TENANT.login, { ...PRE_SESSION, authorization: 'Bearer tok-member' }, asserted);
      assertRefusal(r, 400, 'invalid_request', `${adapter.name} with an asserted actor`);
      assert.ok(await logged(logs, 'body_not_allowed'));
      assert.ok(!logs.join('').includes('not implemented'));
    });
  }
});

test('each boundary accepts login and session writes only from its own origin', async () => {
  await withSessions({}, async ({ port, probe }) => {
    assertRefusal(await login(port, 'admin', 'tok-owner', { origin: ORIGINS.tenant }), 403, 'forbidden', 'admin login from the tenant origin');
    assertRefusal(await login(port, 'tenant', 'tok-owner', { origin: ORIGINS.admin }), 403, 'forbidden', 'tenant login from the admin origin');
    assert.equal(probe.tokenViews.length, 0, 'a foreign-origin login never reaches the verifier');
    const admin = await signIn(port, 'admin', 'tok-owner');
    assertRefusal(await send(port, 'POST', ADMIN.logout, { ...unsafe('admin', admin), origin: ORIGINS.tenant }), 403, 'forbidden', 'admin logout from the tenant origin');
    assertRefusal(await send(port, 'POST', '/admin/v1/probe', { ...unsafe('admin', admin), origin: ORIGINS.tenant }), 403, 'forbidden', 'admin write from the tenant origin');
    assert.equal(probe.handled.adminWrite, undefined);
    assert.equal((await current(port, 'admin', admin.id)).status, 200, 'the refused requests changed nothing');
  });
});

// --- session lifecycle ---------------------------------------------------------------------

test('login never adopts a presented identifier and rotates away the previous session', async () => {
  await withSessions({}, async ({ port }) => {
    const planted = 'A'.repeat(43); // attacker-chosen and well-formed, but never issued
    const first = await signIn(port, 'tenant', 'tok-member', cookie('tenant', planted));
    assert.notEqual(first.id, planted);
    assertRefusal(await current(port, 'tenant', planted), 401, 'unauthenticated', 'the planted identifier');
    // A failed login leaves the presented session alone...
    assertRefusal(await login(port, 'tenant', 'tok-nobody', cookie('tenant', first.id)), 401, 'unauthenticated', 'a failed login');
    assert.equal((await current(port, 'tenant', first.id)).status, 200);
    // ...and a successful one issues a new identifier and revokes the one presented.
    const second = await signIn(port, 'tenant', 'tok-member', cookie('tenant', first.id));
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.csrf, first.csrf);
    assertRefusal(await current(port, 'tenant', first.id), 401, 'unauthenticated', 'the rotated-away identifier');
    assert.equal((await current(port, 'tenant', second.id)).status, 200);
    // A session another principal left on the same client is revoked as well.
    const owner = await signIn(port, 'tenant', 'tok-owner');
    await signIn(port, 'tenant', 'tok-member', cookie('tenant', owner.id));
    assertRefusal(await current(port, 'tenant', owner.id), 401, 'unauthenticated', "another principal's leftover session");
  });
});

test('logout revokes the server session and clears only its own cookie; a repeat changes nothing', async () => {
  await withSessions({}, async ({ port, logs }) => {
    const tenant = await signIn(port, 'tenant', 'tok-owner');
    const admin = await signIn(port, 'admin', 'tok-owner');
    const out = await send(port, 'POST', TENANT.logout, unsafe('tenant', tenant));
    assert.equal(out.status, 204);
    assert.equal(out.body, '');
    assertPolicyHeaders(out.headers, 'logout');
    const cleared = setCookieOf(out);
    assert.equal(cleared.name, SESSION_COOKIES.tenant);
    assert.equal(cleared.value, '');
    assert.deepEqual(cleared.attributes, ['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Strict', 'Secure'], 'the clearing cookie matches the issued one');
    assertRefusal(await current(port, 'tenant', tenant.id), 401, 'unauthenticated', 'the revoked session');
    assertRefusal(await send(port, 'POST', TENANT.logout, unsafe('tenant', tenant)), 401, 'unauthenticated', 'a repeated logout');
    assert.ok(await logged(logs, 'session_unknown'));
    // The administrative session is untouched, and its cookie cannot log the tenant boundary out.
    assert.equal((await current(port, 'admin', admin.id)).status, 200);
    const cross = await send(port, 'POST', TENANT.logout, { ...PRE_SESSION, ...cookie('admin', admin.id), [SESSION_CSRF_HEADER]: admin.csrf });
    assertRefusal(cross, 401, 'unauthenticated', "the other boundary's cookie");
    assert.equal((await current(port, 'admin', admin.id)).status, 200);
    // Logout itself needs the session's own CSRF token; a refused logout revokes nothing.
    const member = await signIn(port, 'tenant', 'tok-member');
    assertRefusal(await send(port, 'POST', TENANT.logout, { ...PRE_SESSION, ...cookie('tenant', member.id) }), 403, 'forbidden', 'no session CSRF');
    assert.equal((await current(port, 'tenant', member.id)).status, 200);
  });
});

test('a session ends at its idle timeout and, however active, at its absolute lifetime', async () => {
  await withSessions({}, async ({ port, clock, logs }) => {
    for (const audience of ['tenant', 'admin'] as const) {
      const { idleMs, absoluteMs } = SESSION_TTL[audience];
      assert.ok(idleMs < absoluteMs, `${audience}: the idle timeout is shorter than the absolute lifetime`);
      const work = (s: Session): Promise<Reply> => send(port, 'GET', READ_ROUTE[audience], cookie(audience, s.id));
      const quiet = await signIn(port, audience, 'tok-owner');
      clock.t += idleMs - 1;
      assert.equal((await work(quiet)).status, 200, `${audience}: inside the idle window`);
      clock.t += idleMs - 1;
      assert.equal((await work(quiet)).status, 200, `${audience}: activity slides the idle window`);
      clock.t += idleMs;
      assertRefusal(await work(quiet), 401, 'unauthenticated', `${audience}: idle expiry`);

      const busy = await signIn(port, audience, 'tok-owner');
      const issued = clock.t;
      while (clock.t + idleMs / 2 < issued + absoluteMs) {
        clock.t += idleMs / 2;
        assert.equal((await work(busy)).status, 200, `${audience}: active at +${clock.t - issued}ms`);
      }
      clock.t = issued + absoluteMs;
      assertRefusal(await work(busy), 401, 'unauthenticated', `${audience}: absolute expiry`);
    }
    assert.ok(await logged(logs, 'session_idle_expired'));
    assert.ok(await logged(logs, 'session_expired'));
  });
});

test('only a successful authorized request slides the idle window; polling, refusals, failures and probes never do', async () => {
  const ops: string[] = [];
  await withSessions({ tenant: { store: instrumented(ops) } }, async ({ port, clock, logs }) => {
    const { idleMs } = SESSION_TTL.tenant;
    const refreshes = (): number => ops.filter((op) => op === 'update:lastSeenAt').length;
    // Passive polling of the current session never keeps it alive.
    const polled = await signIn(port, 'tenant', 'tok-owner');
    for (let i = 1; i <= 3; i++) {
      clock.t += idleMs / 3 - 1;
      assert.equal((await current(port, 'tenant', polled.id)).status, 200, `poll ${i}`);
    }
    clock.t += 3;
    assertRefusal(await current(port, 'tenant', polled.id), 401, 'unauthenticated', 'polled but never active');
    assert.ok(await logged(logs, 'session_idle_expired'));

    // Refused and failed requests, and the operational probes, never slide it either.
    const idle = await signIn(port, 'tenant', 'tok-owner');
    clock.t += idleMs - 1;
    const before = refreshes();
    const attempts: Array<[string, () => Promise<Reply>, number]> = [
      ['a wrong CSRF token', () => send(port, 'POST', '/api/v1/probe', unsafe('tenant', idle, 'D'.repeat(43))), 403],
      ['an untrusted origin', () => send(port, 'POST', '/api/v1/probe', { ...unsafe('tenant', idle), origin: 'http://evil.test' }), 403],
      ['a denied authorization', () => send(port, 'GET', '/api/v1/probe/denied', cookie('tenant', idle.id)), 403],
      ['a failing handler', () => send(port, 'GET', '/api/v1/probe/fail', cookie('tenant', idle.id)), 500],
      ['the current-session read', () => current(port, 'tenant', idle.id), 200],
      ['the liveness probe', () => send(port, 'GET', '/health', cookie('tenant', idle.id)), 200],
      ['the readiness probe', () => send(port, 'GET', '/readiness', cookie('tenant', idle.id)), 200],
    ];
    for (const [label, run, status] of attempts) assert.equal((await run()).status, status, label);
    await tick();
    assert.equal(refreshes(), before, 'none of them slid the idle window');
    clock.t += 1;
    assertRefusal(await current(port, 'tenant', idle.id), 401, 'unauthenticated', 'idle despite all of them');

    // A successful authorized request is activity: it, and only it, slides the window.
    const active = await signIn(port, 'tenant', 'tok-owner');
    clock.t += idleMs - 1;
    assert.equal((await send(port, 'GET', '/api/v1/probe', cookie('tenant', active.id))).status, 200);
    await tick();
    assert.equal(refreshes(), before + 1, 'one successful request, one refresh');
    clock.t += idleMs - 1;
    assert.equal((await current(port, 'tenant', active.id)).status, 200, 'the window runs from the last activity');
    clock.t += 1;
    assertRefusal(await current(port, 'tenant', active.id), 401, 'unauthenticated', 'idle since the last activity');
    assert.ok(!logs.join('').includes('handler-secret-detail'));
  });
});

test('duplicate, malformed and URL- or body-borne session identifiers are refused before the store is read', async () => {
  const ops: string[] = [];
  await withSessions({ tenant: { store: instrumented(ops) } }, async ({ port }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    const name = SESSION_COOKIES.tenant;
    const before = ops.length;
    for (const header of [
      `${name}=${s.id}; ${name}=${s.id}`,
      `${name}=${s.id}; theme=dark; ${name}=${'B'.repeat(43)}`,
      `${name}=`, `${name}=${s.id.slice(1)}`, `${name}=${s.id}A`, `${name}="${s.id}"`,
      `${name}=${s.id.slice(0, 42)}+`, `${name}=${s.id.slice(0, 42)}=`, `${name}=${s.id.slice(0, 21)} ${s.id.slice(22)}`,
    ]) {
      assertRefusal(await send(port, 'GET', TENANT.current, { cookie: header }), 401, 'unauthenticated', header.slice(0, 70));
    }
    // Two Cookie lines each naming the session (Node joins them) are a duplicate too, never a guess.
    const twoLines = await rawRequest(port,
      `GET ${TENANT.current} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nCookie: ${name}=${s.id}\r\nCookie: ${name}=${'F'.repeat(43)}\r\n\r\n`);
    assert.match(twoLines, /^HTTP\/1\.1 401 /, 'two Cookie lines naming the session are refused');
    assert.equal(ops.length, before, 'a malformed or duplicate cookie never reaches the store');
    for (const path of [`${TENANT.current}?${name}=${s.id}`, `${TENANT.current}?session=${s.id}`]) {
      assertRefusal(await send(port, 'GET', path), 401, 'unauthenticated', 'an identifier in the URL');
    }
    const inBody = await send(port, 'POST', TENANT.logout, { ...PRE_SESSION, [SESSION_CSRF_HEADER]: s.csrf }, JSON.stringify({ [name]: s.id }));
    assertRefusal(inBody, 400, 'invalid_request', 'an identifier in a body');
    assert.equal((await current(port, 'tenant', s.id)).status, 200, 'the session itself is unaffected');
  });
});

test('a tenant session never reaches an administrative route, nor an admin session a tenant route', async () => {
  // One store shared by both boundaries: only the audience bound into each record keeps them apart.
  const shared = createMemorySessionStore();
  await withSessions({ tenant: { store: shared }, admin: { store: shared } }, async ({ port, probe, logs }) => {
    const tenant = await signIn(port, 'tenant', 'tok-owner');
    // The admin boundary never reads the tenant cookie...
    assertRefusal(await send(port, 'GET', ADMIN.current, cookie('tenant', tenant.id)), 401, 'unauthenticated', 'tenant cookie, admin current');
    assertRefusal(await send(port, 'POST', '/admin/v1/probe', { ...pre('admin'), ...cookie('tenant', tenant.id), [SESSION_CSRF_HEADER]: tenant.csrf }),
      401, 'unauthenticated', 'tenant cookie, admin route');
    // ...and a tenant identifier replayed under the admin cookie name is refused by audience.
    assertRefusal(await current(port, 'admin', tenant.id), 401, 'unauthenticated', 'tenant id as the admin cookie');
    assertRefusal(await send(port, 'POST', '/admin/v1/probe', unsafe('admin', tenant)), 401, 'unauthenticated', 'tenant id, admin route');
    assert.ok(await logged(logs, 'session_missing'));
    assert.ok(await logged(logs, 'session_wrong_audience'));
    // An admin session is confined to its own boundary in the same way.
    const admin = await signIn(port, 'admin', 'tok-owner');
    assertRefusal(await send(port, 'GET', TENANT.current, cookie('admin', admin.id)), 401, 'unauthenticated', 'admin cookie, tenant current');
    assertRefusal(await current(port, 'tenant', admin.id), 401, 'unauthenticated', 'admin id as the tenant cookie');
    assertRefusal(await send(port, 'POST', '/api/v1/probe', unsafe('tenant', admin)), 401, 'unauthenticated', 'admin id, tenant route');
    assert.equal(probe.handled.adminWrite, undefined);
    assert.equal(probe.handled.tenantWrite, undefined);
    // Each boundary accepts only the session issued for it; both may be active side by side.
    assert.equal((await send(port, 'POST', '/api/v1/probe', unsafe('tenant', tenant))).status, 200);
    assert.equal((await send(port, 'POST', '/admin/v1/probe', unsafe('admin', admin))).status, 200);
    const both = { cookie: `${SESSION_COOKIES.tenant}=${tenant.id}; ${SESSION_COOKIES.admin}=${admin.id}` };
    assert.equal((await send(port, 'GET', TENANT.current, both)).status, 200);
    assert.equal((await send(port, 'GET', ADMIN.current, both)).status, 200);
  });
});

test('login and current-session disclose only a status and the CSRF token, no identity or authorization detail', async () => {
  await withSessions({}, async ({ port }) => {
    for (const audience of ['tenant', 'admin'] as const) {
      const issued = await login(port, audience, 'tok-owner');
      const id = setCookieOf(issued).value;
      const csrf = (JSON.parse(issued.body) as { csrfToken: string }).csrfToken;
      for (const [label, reply] of [['login', issued], ['current', await current(port, audience, id)]] as const) {
        const body = JSON.parse(reply.body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).sort(), ['csrfToken', 'status'], `${audience} ${label}`);
        assert.equal(body.status, 'active');
        assert.equal(body.csrfToken, csrf);
        for (const detail of ['uid-owner', 'synthetic', 'platform', 'permission', 'audience', 'totp', 'v1', id]) {
          assert.ok(!reply.body.includes(detail), `${audience} ${label} disclosed ${detail}`);
        }
      }
    }
  });
});

test('an unavailable session store fails closed: nothing is issued, read or half-revoked', async () => {
  const ops: string[] = [];
  const failing: { op?: string } = {};
  await withSessions({ tenant: { store: instrumented(ops, failing) } }, async ({ port, logs, clock }) => {
    failing.op = 'create';
    assertRefusal(await login(port, 'tenant', 'tok-member'), 503, 'service_unavailable', 'create fails');
    failing.op = undefined;
    const s = await signIn(port, 'tenant', 'tok-member');
    failing.op = 'get';
    assertRefusal(await current(port, 'tenant', s.id), 503, 'service_unavailable', 'get fails at current-session');
    assertRefusal(await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s)), 503, 'service_unavailable', 'get fails on a route');
    const unreadLogout = await send(port, 'POST', TENANT.logout, unsafe('tenant', s));
    assert.equal(unreadLogout.status, 503, 'a logout the store cannot read');
    assert.equal(setCookieOf(unreadLogout).value, '', 'still clears the cookie');
    // A GET on the logout path is no logout: it neither clears the cookie nor skips a check.
    assert.equal((await send(port, 'GET', TENANT.logout, cookie('tenant', s.id))).status, 404);
    // A due revalidation that cannot be recorded fails closed as well.
    failing.op = 'update:validatedAt';
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assertRefusal(await current(port, 'tenant', s.id), 503, 'service_unavailable', 'the revalidation cannot be recorded');
    failing.op = undefined;
    assert.equal((await current(port, 'tenant', s.id)).status, 200, 'the session outlived the outage');
    // A refresh that cannot be stored never fails the request it follows; it is logged.
    failing.op = 'update:lastSeenAt';
    assert.equal((await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s))).status, 200);
    assert.ok(await loggedWith(logs, 'event', 'session_refresh_failed'));
    failing.op = 'revoke';
    // A logout whose revocation failed answers 503, yet still clears the cookie: a shared terminal keeps nothing.
    const failedLogout = await send(port, 'POST', TENANT.logout, unsafe('tenant', s));
    assert.equal(failedLogout.status, 503);
    assert.equal((JSON.parse(failedLogout.body) as { error: string }).error, 'service_unavailable');
    assert.equal(setCookieOf(failedLogout).value, '', 'the cookie is cleared although the revocation failed');
    assertRefusal(await login(port, 'tenant', 'tok-member', cookie('tenant', s.id)), 503, 'service_unavailable', 'revoke fails at rotation');
    failing.op = undefined;
    assert.equal((await current(port, 'tenant', s.id)).status, 200, 'a failed logout or rotation left the session exactly as it was');
    // A rotation whose new session cannot be stored leaves none: the presented session is revoked
    // first, so it never outlives a rotation attempt, and no cookie is issued for the lost one.
    failing.op = 'create';
    assertRefusal(await login(port, 'tenant', 'tok-member', cookie('tenant', s.id)), 503, 'service_unavailable', 'create fails at rotation');
    failing.op = undefined;
    assertRefusal(await current(port, 'tenant', s.id), 401, 'unauthenticated', 'the presented session after a failed rotation');
    assert.ok(await logged(logs, 'session_unavailable'));
    assert.ok(!logs.join('').includes('store-secret-detail'));
  });
});

test('a hanging verifier, admission, store, authorizer or limiter is cut off at the deadline and told to cancel', async () => {
  const signals: AbortSignal[] = [];
  const hanging = { verifier: false, admission: false, create: false, get: false, authorizer: false, limiter: false };
  const hang = (signal: AbortSignal): Promise<never> => { signals.push(signal); return new Promise(() => {}); };
  const base = createMemorySessionStore();
  const store: SessionStore = {
    create: (key, record, signal) => (hanging.create ? hang(signal) : base.create(key, record, signal)),
    get: (key, signal) => (hanging.get ? hang(signal) : base.get(key, signal)),
    update: (key, fields, signal) => base.update(key, fields, signal),
    revoke: (key, signal) => base.revoke(key, signal),
    revokePrincipal: (audience, key, signal) => base.revokePrincipal(audience, key, signal),
  };
  const limiter = createMemoryRateLimiter();
  await withSessions({
    deadlineMs: 50,
    tenant: {
      store,
      verifier: {
        verify: (c: BearerTokenView, signal: AbortSignal) =>
          (hanging.verifier ? hang(signal) : Promise.resolve(verifiedIdentity(IDENTITIES[c.bearerToken], T0))),
      },
      admission: { admit: (_p: VerifiedPrincipal, _a: SessionAudience, signal: AbortSignal) => (hanging.admission ? hang(signal) : ADMIT) },
      authorizer: { authorize: (_p: unknown, _r: unknown, _v: unknown, signal: AbortSignal) => (hanging.authorizer ? hang(signal) : true) },
    },
    limiter: {
      consume: (r: RateLimitRequest, signal: AbortSignal) => (hanging.limiter ? hang(signal) : limiter.consume(r, signal)),
      probe: (signal: AbortSignal) => limiter.probe(signal),
    },
  }, async ({ port, logs, probe }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    const cases: Array<[keyof typeof hanging, () => Promise<Reply>, string]> = [
      ['limiter', () => login(port, 'tenant', 'tok-member'), 'rate_limit_timeout'],
      ['verifier', () => login(port, 'tenant', 'tok-member'), 'authn_timeout'],
      ['admission', () => login(port, 'tenant', 'tok-member'), 'admission_timeout'],
      ['create', () => login(port, 'tenant', 'tok-member'), 'session_timeout'],
      ['get', () => current(port, 'tenant', s.id), 'session_timeout'],
      ['authorizer', () => send(port, 'POST', '/api/v1/probe', unsafe('tenant', s)), 'authz_timeout'],
    ];
    for (const [name, run, reason] of cases) {
      hanging[name] = true;
      const before = signals.length;
      const started = Date.now();
      const r = await run();
      hanging[name] = false;
      assertRefusal(r, 503, 'service_unavailable', name);
      assert.ok(Date.now() - started < 2_000, `${name}: bounded by the deadline, not the port`);
      assert.equal(signals.length, before + 1, `${name}: the port was called once`);
      assert.equal(signals[signals.length - 1].aborted, true, `${name}: the port is told to cancel`);
      assert.ok(await logged(logs, reason), `${name} logs ${reason}`);
    }
    assert.equal(probe.handled.tenantWrite, undefined, 'no handler runs behind a timed-out port');
    assert.equal((await current(port, 'tenant', s.id)).status, 200, 'the session outlived every timeout');
  });
});

// --- admission revalidation and revocation -----------------------------------------------------

test('admission is re-checked at each boundary\'s own bounded interval, the administrative one stricter', async () => {
  assert.ok(ADMISSION_REVALIDATE_MS.admin < ADMISSION_REVALIDATE_MS.tenant, 'admin revalidates more often');
  for (const audience of ['tenant', 'admin'] as const) {
    assert.ok(ADMISSION_REVALIDATE_MS[audience] < SESSION_TTL[audience].idleMs, `${audience}: revalidation inside the idle window`);
  }
  await withSessions({}, async ({ port, probe, clock }) => {
    const tenant = await signIn(port, 'tenant', 'tok-owner');
    const admin = await signIn(port, 'admin', 'tok-owner');
    const asked = (audience: SessionAudience): number => probe.admissions.filter(([, a]) => a === audience).length;
    const [t0, a0] = [asked('tenant'), asked('admin')];
    clock.t += ADMISSION_REVALIDATE_MS.admin - 1;
    for (const [audience, s] of [['tenant', tenant], ['admin', admin]] as const) assert.equal((await current(port, audience, s.id)).status, 200);
    assert.deepEqual([asked('tenant'), asked('admin')], [t0, a0], 'inside both intervals, admission stands');
    clock.t += 1;
    assert.equal((await current(port, 'admin', admin.id)).status, 200);
    assert.equal((await current(port, 'tenant', tenant.id)).status, 200);
    assert.deepEqual([asked('tenant'), asked('admin')], [t0, a0 + 1], 'the admin interval passed; the tenant one has not');
    clock.t += ADMISSION_REVALIDATE_MS.tenant - ADMISSION_REVALIDATE_MS.admin;
    assert.equal((await current(port, 'tenant', tenant.id)).status, 200);
    assert.equal((await current(port, 'tenant', tenant.id)).status, 200);
    assert.equal(asked('tenant'), t0 + 1, 'once per tenant interval');
  });
});

test('a suspension discovered at revalidation or at login revokes every session of the principal there', async () => {
  const suspended = new Set<string>();
  const admission = { admit: (p: VerifiedPrincipal): unknown => (suspended.has(p.authProviderUid) ? { admitted: false } : ADMIT) };
  await withSessions({ tenant: { admission } }, async ({ port, clock, logs, probe }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    const other = await signIn(port, 'tenant', 'tok-member-again');
    const owner = await signIn(port, 'tenant', 'tok-owner');
    assert.equal((await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s))).status, 200);
    suspended.add('uid-member');
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assertRefusal(await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s)), 401, 'unauthenticated', 'suspended at revalidation');
    assert.equal(probe.handled.tenantWrite, 1, 'the handler never ran for the suspended principal');
    assert.ok(await logged(logs, 'session_admission_denied'));
    suspended.delete('uid-member');
    // Reinstated at once, yet every session of the principal already ended with the denial.
    assertRefusal(await current(port, 'tenant', s.id), 401, 'unauthenticated', 'the denied session');
    assertRefusal(await current(port, 'tenant', other.id), 401, 'unauthenticated', "the principal's other session");
    assert.ok(await logged(logs, 'session_unknown'));
    assert.equal((await current(port, 'tenant', owner.id)).status, 200, 'another principal is untouched');
    // A login that admission denies ends the principal's sessions too, before any of them is re-checked.
    const fresh = await signIn(port, 'tenant', 'tok-member');
    suspended.add('uid-member');
    assertRefusal(await login(port, 'tenant', 'tok-member-again'), 401, 'unauthenticated', 'a denied login');
    suspended.delete('uid-member');
    assertRefusal(await current(port, 'tenant', fresh.id), 401, 'unauthenticated', 'ended by the denied login');
    assert.equal((await login(port, 'tenant', 'tok-member')).status, 200, 'a reinstated principal signs in afresh');
  });
});

test('a refusal whose revocation fails still refuses, and its reason says so', async () => {
  const ops: string[] = [];
  const failing: { op?: string } = {};
  let version = 'v1';
  let denied = false;
  const admission = { admit: (): unknown => (denied ? { admitted: false } : { admitted: true, securityVersion: version }) };
  await withSessions({ tenant: { store: instrumented(ops, failing), admission } }, async ({ port, clock, logs }) => {
    const a = await signIn(port, 'tenant', 'tok-member');
    const b = await signIn(port, 'tenant', 'tok-owner');
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    failing.op = 'revokePrincipal';
    denied = true;
    assertRefusal(await current(port, 'tenant', a.id), 401, 'unauthenticated', 'denied; the revocation failed');
    assert.ok(await logged(logs, 'session_admission_denied_unrevoked'));
    assertRefusal(await current(port, 'tenant', a.id), 401, 'unauthenticated', 'the unrevoked session is refused again');
    denied = false;
    failing.op = 'revoke';
    version = 'v2';
    assertRefusal(await current(port, 'tenant', b.id), 401, 'unauthenticated', 'version changed; the revocation failed');
    assert.ok(await logged(logs, 'session_version_mismatch_unrevoked'));
    assert.ok(!logs.join('').includes('store-secret-detail'));
  });
});

test('an idle refresh never moves a session backwards when the clock steps back', async () => {
  const store = createMemorySessionStore();
  await withSessions({ tenant: { store } }, async ({ port, clock }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    const key = createHash('sha256').update(s.id).digest('base64url');
    const work = (): Promise<Reply> => send(port, 'GET', '/api/v1/probe', cookie('tenant', s.id));
    clock.t += 10_000;
    assert.equal((await work()).status, 200);
    await tick();
    clock.t -= 4_000; // an instance whose clock runs behind, within the skew allowance
    assert.equal((await work()).status, 200);
    await tick();
    assert.equal(((await store.get(key, aSignal())) as SessionRecord).lastSeenAt, T0 + 10_000, 'the later activity stands');
  });
});

test('a changed security version revokes the session at revalidation; a fresh login carries the new version', async () => {
  let version = 'v1';
  const admission = { admit: (): unknown => ({ admitted: true, securityVersion: version }) };
  await withSessions({ tenant: { admission } }, async ({ port, clock, logs }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    version = 'v2';
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assertRefusal(await current(port, 'tenant', s.id), 401, 'unauthenticated', 'version mismatch');
    assert.ok(await logged(logs, 'session_version_mismatch'));
    version = 'v1';
    assertRefusal(await current(port, 'tenant', s.id), 401, 'unauthenticated', 'the mismatched session stays revoked');
    version = 'v2';
    const renewed = await signIn(port, 'tenant', 'tok-member');
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assert.equal((await current(port, 'tenant', renewed.id)).status, 200, 'the new session matches the current version');
  });
});

test('an admission outage at revalidation fails closed with a 503 but revokes nothing', async () => {
  let mode: 'ok' | 'throw' | 'hang' = 'ok';
  const signals: AbortSignal[] = [];
  const admission = {
    admit: (_p: VerifiedPrincipal, _a: SessionAudience, signal: AbortSignal): unknown => {
      if (mode === 'throw') throw new Error('admission-backend-secret');
      if (mode === 'hang') { signals.push(signal); return new Promise(() => {}); }
      return ADMIT;
    },
  };
  await withSessions({ deadlineMs: 50, tenant: { admission } }, async ({ port, clock, logs, probe }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    mode = 'throw';
    assertRefusal(await current(port, 'tenant', s.id), 503, 'service_unavailable', 'admission unavailable');
    assertRefusal(await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s)), 503, 'service_unavailable', 'admission unavailable on a route');
    mode = 'hang';
    assertRefusal(await current(port, 'tenant', s.id), 503, 'service_unavailable', 'admission timed out');
    assert.equal(signals[0]?.aborted, true, 'the hanging admission is told to cancel');
    mode = 'ok';
    assert.equal((await current(port, 'tenant', s.id)).status, 200, 'the session survived the outage');
    assert.equal(probe.handled.tenantWrite, undefined);
    assert.ok(await logged(logs, 'admission_unavailable'));
    assert.ok(await logged(logs, 'admission_timeout'));
    assert.ok(!logs.join('').includes('admission-backend-secret'));
  });
});

test('logout never waits on admission: an overdue revalidation cannot keep a session alive', async () => {
  const admission = { admit: (): unknown => { throw new Error('admission-down'); } };
  await withSessions({}, async ({ port, clock }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    await withSessions({ tenant: { admission } }, async () => {}); // a second harness never shares state
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assert.equal((await send(port, 'POST', TENANT.logout, unsafe('tenant', s))).status, 204);
    assertRefusal(await current(port, 'tenant', s.id), 401, 'unauthenticated', 'logged out');
  });
  let down = false;
  const flaky = { admit: (): unknown => { if (down) throw new Error('admission-down'); return ADMIT; } };
  await withSessions({ tenant: { admission: flaky } }, async ({ port, clock }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    down = true;
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assertRefusal(await current(port, 'tenant', s.id), 503, 'service_unavailable', 'admission down');
    assert.equal((await send(port, 'POST', TENANT.logout, unsafe('tenant', s))).status, 204, 'logout still revokes');
    down = false;
    assertRefusal(await current(port, 'tenant', s.id), 401, 'unauthenticated', 'revoked while admission was down');
  });
});

test('tenant and admin revalidation are separate: an admin denial ends only the admin session', async () => {
  let adminDenied = false;
  const adminAdmission = { admit: (): unknown => (adminDenied ? { admitted: false } : ADMIT) };
  await withSessions({ admin: { admission: adminAdmission } }, async ({ port, clock }) => {
    const tenant = await signIn(port, 'tenant', 'tok-owner');
    const admin = await signIn(port, 'admin', 'tok-owner');
    adminDenied = true;
    clock.t += ADMISSION_REVALIDATE_MS.admin;
    assertRefusal(await current(port, 'admin', admin.id), 401, 'unauthenticated', 'admin admission withdrawn');
    assert.equal((await current(port, 'tenant', tenant.id)).status, 200, 'the tenant session of the same principal stands');
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assert.equal((await current(port, 'tenant', tenant.id)).status, 200, 'the tenant admission still admits');
  });
});

test('revoking a principal ends every one of its sessions in that audience, and nothing else', async () => {
  const shared = createMemorySessionStore();
  await withSessions({ tenant: { store: shared }, admin: { store: shared } }, async ({ port }) => {
    const first = await signIn(port, 'tenant', 'tok-owner');
    const second = await signIn(port, 'tenant', 'tok-owner-again');
    const admin = await signIn(port, 'admin', 'tok-owner');
    const other = await signIn(port, 'tenant', 'tok-member');
    await shared.revokePrincipal('tenant', principalKeyOf(principal('uid-owner')), aSignal());
    for (const [label, s] of [['first', first], ['second', second]] as const) {
      assertRefusal(await current(port, 'tenant', s.id), 401, 'unauthenticated', `${label} tenant session of the revoked principal`);
    }
    assert.equal((await current(port, 'admin', admin.id)).status, 200, 'the same principal in the other audience is untouched');
    assert.equal((await current(port, 'tenant', other.id)).status, 200, 'another principal is untouched');
    assert.equal((await login(port, 'tenant', 'tok-owner')).status, 200, 'revocation ends sessions, not the account');
  });
});

// --- login limits --------------------------------------------------------------------------

test('the login client limit refuses before any credential is verified', async () => {
  const requests: RateLimitRequest[] = [];
  const limiter = tightened(requests, (r) => (r.namespace === 'tenant-login' && r.dimension === 'client' ? 2 : undefined));
  await withSessions({ limiter }, async ({ port, probe, logs }) => {
    assert.equal((await login(port, 'tenant', 'tok-member')).status, 200);
    assertRefusal(await login(port, 'tenant', 'tok-nobody'), 401, 'unauthenticated', 'second attempt');
    const limited = await login(port, 'tenant', 'tok-member');
    assertRefusal(limited, 429, 'rate_limited', 'third attempt');
    assert.match(String(limited.headers['retry-after']), /^[1-9][0-9]*$/);
    assert.equal(probe.tokenViews.length, 2, 'the limited attempt never reached the verifier');
    assert.ok(await logged(logs, 'login_client_limited'));
    // The limit belongs to one boundary's login exchange only.
    assert.equal((await login(port, 'admin', 'tok-owner')).status, 200);
    assert.equal((await send(port, 'GET', '/health')).status, 200);
  });
});

test('the login account limit is keyed by the verified principal\'s digest alone, never by unverified claims', async () => {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  // A JWT-shaped token whose unverified payload names the member; the verifier rejects it.
  const forged = `${b64({ alg: 'none' })}.${b64({ sub: 'uid-member', user_id: 'uid-member', email: 'member@example.test' })}.x`;
  const requests: RateLimitRequest[] = [];
  const limiter = tightened(requests, (r) => (r.namespace === 'tenant-login' && r.dimension === 'account' ? 1 : undefined));
  await withSessions({ limiter }, async ({ port, logs }) => {
    for (let i = 0; i < 3; i++) assertRefusal(await login(port, 'tenant', forged), 401, 'unauthenticated', `forged claims #${i}`);
    assert.equal((await login(port, 'tenant', 'tok-member')).status, 200, "unverified claims never spent the member's bucket");
    assertRefusal(await login(port, 'tenant', 'tok-member-again'), 429, 'rate_limited', 'a new token for the same verified principal');
    assert.ok(await logged(logs, 'login_account_limited'));
    assert.equal((await login(port, 'tenant', 'tok-owner')).status, 200, 'another verified principal has its own bucket');
    // The bucket is spent before admission, so a 429 is no evidence of admission either.
    assertRefusal(await login(port, 'tenant', 'tok-stranger'), 401, 'unauthenticated', 'unadmitted, first attempt');
    assertRefusal(await login(port, 'tenant', 'tok-stranger'), 429, 'rate_limited', 'unadmitted, second attempt');
  });
  const keys = requests.filter((r) => r.namespace === 'tenant-login' && r.dimension === 'account').map((r) => r.key);
  const keyring = createLimiterKeyring(TEST_RATE_LIMIT_KEY);
  assert.deepEqual([...new Set(keys)], ['uid-member', 'uid-owner', 'uid-stranger'].map((uid) => keyring.keyOf('tenant-login', 'account', principalKeyOf(principal(uid)))),
    'each bucket is the digest of one verified principal');
  assert.ok(keys.every((k) => OPAQUE_RE.test(k) && !k.includes('uid-')), 'no UID in a limiter key');
});

test('the tenant login account limit never touches the admin login', async () => {
  const requests: RateLimitRequest[] = [];
  const limiter = tightened(requests, (r) => (r.namespace === 'tenant-login' && r.dimension === 'account' ? 1 : undefined));
  await withSessions({ limiter }, async ({ port }) => {
    assert.equal((await login(port, 'tenant', 'tok-owner')).status, 200);
    assertRefusal(await login(port, 'tenant', 'tok-owner-again'), 429, 'rate_limited', "uid-owner's tenant account bucket is spent");
    // The same verified principal, at the admin login's own account bucket, is untouched.
    assert.equal((await login(port, 'admin', 'tok-owner')).status, 200, 'the admin login has its own account bucket');
  });
});

test('the shipped login limits apply: ten attempts per client, five logins per account', async () => {
  await withSessions({ limiter: createMemoryRateLimiter() }, async ({ port, logs }) => {
    // Five logins per verified principal per window...
    for (let i = 1; i <= 5; i++) assert.equal((await login(port, 'tenant', 'tok-member')).status, 200, `member login ${i}`);
    assertRefusal(await login(port, 'tenant', 'tok-member'), 429, 'rate_limited', 'the sixth login of one principal');
    assert.ok(await logged(logs, 'login_account_limited'));
    // ...and ten attempts per client address per window, counted before any verification.
    for (let i = 7; i <= 10; i++) assert.equal((await login(port, 'tenant', 'tok-owner')).status, 200, `attempt ${i}`);
    assertRefusal(await login(port, 'tenant', 'tok-owner'), 429, 'rate_limited', 'the eleventh attempt from one client');
    assert.ok(await logged(logs, 'login_client_limited'));
  });
});

test('a verified credential the evidence policy refuses spends no account budget, so a stale admin token cannot lock the admin out', async () => {
  const identities: Record<string, Identity> = {
    'tok-stale-admin': { uid: 'uid-owner', secondFactor: 'totp', authAgeMs: 10 * 60_000 },
    'tok-no-mfa-admin': { uid: 'uid-owner' },
    'tok-fresh-admin': { uid: 'uid-owner', secondFactor: 'totp' },
  };
  const requests: RateLimitRequest[] = [];
  await withSessions({ identities, limiter: recording(requests, createMemoryRateLimiter()) }, async ({ port }) => {
    // Six replays total (three of each), comfortably inside the real ten-per-client login limit.
    for (let i = 0; i < 3; i++) {
      assertRefusal(await login(port, 'admin', 'tok-stale-admin'), 401, 'unauthenticated', `stale attempt ${i}`);
      assertRefusal(await login(port, 'admin', 'tok-no-mfa-admin'), 401, 'unauthenticated', `no-MFA attempt ${i}`);
    }
    const accountRequests = requests.filter((r) => r.namespace === 'admin-login' && r.dimension === 'account');
    assert.deepEqual(accountRequests, [], 'the evidence policy refused every attempt before any account budget was spent');
    assert.equal((await login(port, 'admin', 'tok-fresh-admin')).status, 200, 'a fresh TOTP login is not locked out');
  });
});

test('a logout the limiter cannot serve still clears its cookie, but only for its own origin', async () => {
  let down = false;
  const limiter: DistributedRateLimiter = {
    consume: (r: RateLimitRequest) => (down ? { outcome: 'unavailable' } : { outcome: 'allowed', remaining: r.limit - r.cost }),
    probe: () => true,
  };
  await withSessions({ limiter }, async ({ port }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    down = true;
    const own = await send(port, 'POST', TENANT.logout, unsafe('tenant', s));
    assert.equal(own.status, 503, own.body);
    assert.equal((JSON.parse(own.body) as { error: string }).error, 'service_unavailable');
    assertPolicyHeaders(own.headers, "logout, limiter down, its own origin");
    const cleared = setCookieOf(own);
    assert.equal(cleared.name, SESSION_COOKIES.tenant);
    assert.equal(cleared.value, '');
    assert.deepEqual(cleared.attributes, ['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Strict', 'Secure'], 'exactly the clearing cookie');
    assertRefusal(await send(port, 'POST', TENANT.logout, { ...unsafe('tenant', s), origin: 'http://evil.test' }),
      503, 'service_unavailable', 'a foreign origin gets no clearing cookie');
  });
});

test('a malformed, inconsistent or future-dated store record is refused, never trusted', async () => {
  const member = principal('uid-member');
  const base = {
    audience: 'tenant', authProvider: 'synthetic', authProviderUid: 'uid-member', principalKey: principalKeyOf(member),
    securityVersion: 'v1', createdAt: T0 - 1000, lastSeenAt: T0 - 1000, validatedAt: T0 - 1000,
  };
  const records: unknown[] = [
    'a string', 42, [], { ...base, authProviderUid: '' }, { ...base, authProviderUid: 'x'.repeat(129) }, { ...base, authProvider: undefined },
    { ...base, principalKey: principalKeyOf(principal('uid-owner')) }, { ...base, principalKey: undefined },
    { ...base, securityVersion: undefined }, { ...base, securityVersion: 'has space' }, { ...base, securityVersion: 'x'.repeat(129) },
    { ...base, createdAt: '0' }, { ...base, lastSeenAt: Number.NaN }, { ...base, createdAt: T0, lastSeenAt: T0 - 1, validatedAt: T0 },
    { ...base, lastSeenAt: T0 + 60_000 }, { ...base, validatedAt: T0 + 60_000 }, { ...base, validatedAt: T0 - 2000 },
    { ...base, validatedAt: undefined }, { ...base, createdAt: T0 + 60_000, lastSeenAt: T0 + 60_000, validatedAt: T0 + 60_000 },
  ];
  let served: unknown;
  const store: SessionStore = {
    create: () => undefined, get: () => served, update: () => undefined, revoke: () => undefined, revokePrincipal: () => undefined,
  };
  const id = 'E'.repeat(43);
  await withSessions({ tenant: { store } }, async ({ port, logs }) => {
    for (const record of records) {
      served = record;
      assertRefusal(await current(port, 'tenant', id), 401, 'unauthenticated', String(JSON.stringify(record)));
    }
    assert.ok(await logged(logs, 'session_record_invalid'));
    served = base;
    assert.equal((await current(port, 'tenant', id)).status, 200, 'the well-formed record is the control');
    for (const withinSkew of [{ ...base, lastSeenAt: T0 + 4_000 }, { ...base, validatedAt: T0 + 4_000 }]) {
      served = withinSkew;
      assert.equal((await current(port, 'tenant', id)).status, 200, 'a stamp within the clock-skew allowance is accepted');
    }
  });
});

// --- session-bound CSRF and the ports ------------------------------------------------------

test("an unsafe session request needs the current session's own CSRF token", async () => {
  await withSessions({}, async ({ port, probe, logs }) => {
    const a = await signIn(port, 'tenant', 'tok-member');
    const b = await signIn(port, 'tenant', 'tok-owner');
    const admin = await signIn(port, 'admin', 'tok-owner');
    const flip = (t: string): string => t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const { [CSRF_HEADER]: _intent, ...withoutIntent } = unsafe('tenant', a);
    const refused: Array<[string, Record<string, string | string[]>]> = [
      ['no token', { ...PRE_SESSION, ...cookie('tenant', a.id) }],
      ['an empty token', unsafe('tenant', a, '')],
      ['the pre-session intent value', unsafe('tenant', a, CSRF_HEADER_VALUE)],
      ["another session's token", unsafe('tenant', a, b.csrf)],
      ["another audience's token", unsafe('tenant', a, admin.csrf)],
      ['the session identifier itself', unsafe('tenant', a, a.id)],
      ['one character off', unsafe('tenant', a, flip(a.csrf))],
      ['a duplicated token', unsafe('tenant', a, [a.csrf, a.csrf])],
      ['no pre-session intent header', withoutIntent],
      ['cross-site', { ...unsafe('tenant', a), 'sec-fetch-site': 'cross-site' }],
      ['an untrusted origin', { ...unsafe('tenant', a), origin: 'http://evil.test' }],
    ];
    for (const [label, headers] of refused) assertRefusal(await send(port, 'POST', '/api/v1/probe', headers), 403, 'forbidden', label);
    assert.equal(probe.handled.tenantWrite, undefined);
    assert.equal(probe.authorizations.length, 0, 'authorization never runs behind a refused CSRF check');
    assert.ok(await logged(logs, 'csrf_session_invalid'));
    assert.ok(await logged(logs, 'csrf_session_missing'));
    assert.ok(await logged(logs, 'csrf_session_duplicate'));
    assert.equal((await send(port, 'POST', '/api/v1/probe', unsafe('tenant', a))).status, 200);
    assert.equal(probe.handled.tenantWrite, 1, 'the handler ran exactly once');
    assert.equal((await send(port, 'GET', '/api/v1/probe', cookie('tenant', a.id))).status, 200, 'a safe request needs no token');
    // Rotation retires the previous session's token together with the session.
    const rotated = await signIn(port, 'tenant', 'tok-member', cookie('tenant', a.id));
    assertRefusal(await send(port, 'POST', '/api/v1/probe', unsafe('tenant', rotated, a.csrf)), 403, 'forbidden', "the rotated-away session's token");
    assertRefusal(await send(port, 'POST', '/api/v1/probe', unsafe('tenant', a)), 401, 'unauthenticated', 'the rotated-away session');
    assert.equal((await send(port, 'POST', '/api/v1/probe', unsafe('tenant', rotated))).status, 200);
    assert.equal(probe.handled.tenantWrite, 2);
  });
});

test('login and session ports receive frozen views and a deadline signal, never the request, the response or the body stream', async () => {
  await withSessions({}, async ({ port, probe }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    assert.equal((await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s))).status, 200);
    const frozenPlain = (v: unknown, keys: string[], label: string): void => {
      assert.ok(typeof v === 'object' && v !== null && Object.isFrozen(v), `${label} is frozen`);
      assert.equal(Object.getPrototypeOf(v), Object.prototype, `${label} is a plain object, not a request or stream`);
      assert.deepEqual(Object.keys(v as object).sort(), keys, label);
    };
    assert.equal(probe.tokenViews.length, 1);
    frozenPlain(probe.tokenViews[0], ['bearerToken'], 'the credential view');
    assert.ok(probe.verifySignals[0] instanceof AbortSignal, "the verifier's other argument is the deadline signal");
    assert.equal(probe.admissions.length, 1);
    const [admitted, audience, admissionSignal, ...restA] = probe.admissions[0];
    assert.equal(restA.length, 0, 'admission gets exactly its three arguments');
    frozenPlain(admitted, ['authProvider', 'authProviderUid'], 'the admitted principal');
    assert.deepEqual(admitted, principal('uid-member'));
    assert.equal(audience, 'tenant');
    assert.ok(admissionSignal instanceof AbortSignal, 'a deadline signal, never the request');
    assert.equal(probe.authorizations.length, 1);
    const [authorized, requirement, route, authzSignal, ...rest] = probe.authorizations[0];
    assert.equal(rest.length, 0, 'the authorizer gets exactly its four arguments');
    frozenPlain(authorized, ['authProvider', 'authProviderUid'], 'the authorized principal');
    assert.deepEqual(requirement, { scope: 'tenant', permission: 'probe.write' });
    assert.ok(Object.isFrozen(requirement));
    frozenPlain(route, ['audience', 'method', 'path'], 'the route view');
    assert.deepEqual(route, { method: 'POST', path: '/api/v1/probe', audience: 'tenant' });
    assert.ok(authzSignal instanceof AbortSignal, 'a deadline signal, never the request');
    // The handler runs once, with the session principal and a session view that holds no identifier.
    assert.equal(probe.handled.tenantWrite, 1);
    const ctx = probe.contexts[0];
    assert.deepEqual(ctx.principal, principal('uid-member'));
    assert.equal(ctx.session?.audience, 'tenant');
    assert.equal(ctx.session?.csrfToken, s.csrf);
    assert.ok(!JSON.stringify(ctx).includes(s.id), 'the handler context never carries the session identifier');
  });
});

test('session refusals are bounded and never echo a credential, UID, cookie, CSRF token or adapter text', async () => {
  const CANARY_TOKEN = 'tok-canary-7f3a';
  const CANARY_UID = 'canary uid/ü-7f3a';
  const throwing = { async verify(): Promise<unknown> { throw new Error('adapter-secret-detail'); } };
  const identities = { 'tok-canary-uid': { uid: CANARY_UID } };
  await withSessions({ admin: { verifier: throwing }, identities, tenant: { admission: { admit: () => ADMIT } } }, async ({ port, logs }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    const canary = await signIn(port, 'tenant', 'tok-canary-uid');
    const unknownId = 'C'.repeat(43);
    const badCsrf = 'D'.repeat(43);
    const replies = [
      await login(port, 'tenant', CANARY_TOKEN),
      await login(port, 'admin', 'tok-member'),
      await current(port, 'tenant', unknownId),
      await current(port, 'tenant', canary.id),
      await send(port, 'GET', TENANT.current, { cookie: `${SESSION_COOKIES.tenant}=canary-cookie-value` }),
      await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s, badCsrf)),
      await login(port, 'tenant', CANARY_TOKEN, { origin: 'http://evil.test' }),
    ];
    for (const r of replies) assert.ok(r.body.length < 128, `bounded body: ${r.body}`);
    assert.ok(await logged(logs, 'csrf_origin_mismatch'));
    const seen = `${replies.map((r) => `${r.body}\n${JSON.stringify(r.headers)}`).join('\n')}\n${logs.join('\n')}`;
    for (const leak of [CANARY_TOKEN, CANARY_UID, 'canary-cookie-value', unknownId, badCsrf, s.id, s.csrf, 'adapter-secret-detail', 'uid-member', 'synthetic', 'Bearer tok']) {
      assert.ok(!seen.includes(leak), `leaked ${leak}`);
    }
  });
});

test('session endpoints keep the chain order: body and pre-session checks run before any store or port', async () => {
  const ops: string[] = [];
  await withSessions({ tenant: { store: instrumented(ops) } }, async ({ port, probe }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    const verified = probe.tokenViews.length;
    ops.length = 0;
    const cases: Array<[string, () => Promise<Reply>, number, string]> = [
      ['a body on logout', () => send(port, 'POST', TENANT.logout, unsafe('tenant', s), '{}'), 400, 'invalid_request'],
      ['a body on login', () => send(port, 'POST', TENANT.login, { ...PRE_SESSION, authorization: 'Bearer tok-member' }, '{}'), 400, 'invalid_request'],
      ['a cross-site logout', () => send(port, 'POST', TENANT.logout, { ...unsafe('tenant', s), 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
      ['a cross-site login', () => login(port, 'tenant', 'tok-member', { 'sec-fetch-site': 'cross-site' }), 403, 'forbidden'],
      ['a login without the intent header', () => send(port, 'POST', TENANT.login, { origin: TRUSTED, authorization: 'Bearer tok-member' }), 403, 'forbidden'],
      ['a login from an untrusted origin', () => login(port, 'tenant', 'tok-member', { origin: 'http://evil.test' }), 403, 'forbidden'],
    ];
    for (const [label, run, status, error] of cases) assertRefusal(await run(), status, error, label);
    assert.deepEqual(ops, [], 'no refused request touched the session store');
    assert.equal(probe.tokenViews.length, verified, 'no refused login reached the verifier');
    for (const [method, path] of [['HEAD', TENANT.current], ['GET', `${TENANT.current}/`], ['GET', TENANT.login], ['PUT', TENANT.logout], ['GET', '/api/v1/session/Login']]) {
      assert.equal((await send(port, method, path, cookie('tenant', s.id))).status, 404, `${method} ${path}`);
    }
  });
});
