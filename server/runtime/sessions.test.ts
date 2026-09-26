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
//   - admission revalidation on EVERY protected request of either boundary (never on logout, with
//     no validatedAt stamp), revocation on denial or a changed security version, per-principal
//     revocation, and the admitted scope handed to the same request's route authorizer;
//   - each boundary's admission probe as part of readiness, shared per reuse window;
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
  ADMISSION_REVALIDATE_MS, LOGIN_POLICIES, RECENT_AUTH_MAX_AGE_MS, REAUTHENTICATE_HEADER, REAUTHENTICATE_VALUE, SESSION_COOKIES,
  SESSION_CSRF_HEADER, SESSION_TTL, principalKeyOf,
} from './sessions.js';
import type { SessionBoundaryDeps, SessionRecord, SessionStore } from './sessions.js';
import { assertSessionStoreContract, createMemorySessionStore } from './memorySessionStore.testkit.js';
import type { MemorySessionStore } from './memorySessionStore.testkit.js';
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
/** An admin route that requires a recent authentication (routes.ts `recentAuth`). */
const RECENT_ROUTE = '/admin/v1/probe/recent';
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
  // A second administrator, and the first one's token refreshed without a new sign-in (its auth_time stays old).
  'tok-peer': { uid: 'uid-peer', secondFactor: 'totp' },
  'tok-owner-refreshed': { uid: 'uid-owner', secondFactor: 'totp', authAgeMs: 6 * 60_000 },
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
  admin: new Set(['uid-owner', 'uid-peer']),
};
/** The internal user the tenant admission resolves (synthetic): its audited login records it (M5-TENANT-SESSION-P1). */
const TENANT_ACTOR = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const ADMIT = Object.freeze({ admitted: true, securityVersion: 'v1', actor: TENANT_ACTOR });
/** A platform TrustedScope as the administrative admission selects it: the actor's one platform grant (synthetic ids). */
const PLATFORM_SCOPE = Object.freeze({
  actor: '0b6f1c2e-4d5a-4e3b-9c8d-7a6b5c4d3e2f', securityVersion: 'v7', scope: 'platform', tenant: null, store: null,
  membershipId: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170', roleId: 'platform_admin', limitation: 'none',
});
// The administrative login requires its admission to name the scope it attributes the session to (M6-ADMIN-AUDIT-P1).
const ADMIT_PLATFORM = Object.freeze({ admitted: true, securityVersion: 'v1', context: PLATFORM_SCOPE });
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
        if (!ADMITTED[a].has(p.authProviderUid)) return { admitted: false };
        return a === 'admin' ? ADMIT_PLATFORM : ADMIT;
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
    { method: 'POST', path: '/api/v1/probe', body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: handle('tenantWrite'), policy: tenant('probe.write') },
    { method: 'GET', path: '/api/v1/probe', body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: handle('tenantRead'), policy: tenant('probe.read') },
    { method: 'GET', path: '/api/v1/probe/denied', body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: handle('tenantDenied'), policy: tenant('probe.denied') },
    { method: 'GET', path: '/api/v1/probe/fail', body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: () => { throw new Error('handler-secret-detail'); }, policy: tenant('probe.read') },
    { method: 'POST', path: '/admin/v1/probe', body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: handle('adminWrite'), policy: admin('probe.admin') },
    { method: 'GET', path: '/admin/v1/probe', body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: handle('adminRead'), policy: admin('probe.admin') },
    // The step-up gate the chain applies to any route that declares it, the tenant status command included.
    { method: 'GET', path: RECENT_ROUTE, body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'required', handler: handle('adminRecent'), policy: admin('probe.admin') },
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
 * the operation, or each of the operations, `failing` names. Its audited operations' entries are
 * the base store's (`audits`).
 */
function instrumented(ops: string[], failing: { op?: string | readonly string[] } = {}): MemorySessionStore {
  const base = createMemorySessionStore();
  const run = (op: string, act: () => unknown): Promise<unknown> => {
    ops.push(op);
    const fails = failing.op === op || (Array.isArray(failing.op) && failing.op.includes(op));
    return fails ? Promise.reject(new Error(`store-secret-detail-${op}`)) : Promise.resolve(act());
  };
  return {
    audits: base.audits,
    create: (key, record, signal) => run('create', () => base.create(key, record, signal)),
    get: (key, signal) => run('get', () => base.get(key, signal)),
    update: (key, fields, signal) => run(`update:${Object.keys(fields).join(',')}`, () => base.update(key, fields, signal)),
    revoke: (key, signal) => run('revoke', () => base.revoke(key, signal)),
    revokePrincipal: (audience, key, signal) => run('revokePrincipal', () => base.revokePrincipal(audience, key, signal)),
    establish: (key, record, replaces, audit, signal) => run('establish', () => base.establish(key, record, replaces, audit, signal)),
    end: (key, audit, signal) => run('end', () => base.end(key, audit, signal)),
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
    // The tenant boundary revalidates on EVERY protected request (M5-GIAM-D1-P2), so the read after login asks again.
    assert.deepEqual(probe.admissions.map(([, audience]) => audience), ['tenant', 'tenant']);
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
    // The admin boundary re-asks on EVERY protected request too (M5-GIAM-D1-P4), so the read after login asks again.
    assert.deepEqual(probe.admissions.map(([p, audience]) => [(p as VerifiedPrincipal).authProviderUid, audience]),
      [['uid-member', 'admin'], ['uid-owner', 'admin'], ['uid-owner', 'admin']]);
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
  // Only an exact { admitted: true, securityVersion } admits, and only false or { admitted: false } denies: a denial
  // ends every session the principal holds, so any other answer is the adapter's fault — an outage, never a verdict.
  const malformed: Array<() => unknown> = [
    () => true, () => 'true', () => null, () => undefined, () => 0, () => ({ admitted: 'true', securityVersion: 'v1' }), () => ({ admitted: true }),
    () => ({ admitted: true, securityVersion: 1 }),
    () => ({ admitted: true, securityVersion: '' }), () => ({ admitted: true, securityVersion: 'x'.repeat(129) }),
    () => ({ admitted: true, securityVersion: 'has space' }),
  ];
  for (const decide of malformed) {
    await withSessions({ tenant: { admission: { admit: decide } } }, async ({ port, logs }) => {
      assertRefusal(await login(port, 'tenant', 'tok-member'), 503, 'service_unavailable', String(decide));
      assert.ok(await logged(logs, 'admission_unavailable'), `${String(decide)} is an outage`);
      assert.ok(!logs.some((line) => line.includes('"login_admission_denied"')), `${String(decide)} is no denial`);
    });
  }
  for (const decide of [() => false, () => ({ admitted: false }), () => Promise.resolve({ admitted: false })]) {
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
      routes: [{ method: 'POST', path: TENANT.login, policy: { access: 'login', audience: 'tenant' }, body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: () => {} }],
    }, 'route_duplicate'],
    ['a session route whose boundary is not composed', { routes: probeRoutes(newProbe()) }, 'session_boundary_unconfigured'],
    ['a business route borrowing the logout path with another method', {
      sessions: { tenant: full },
      routes: [{
        method: 'GET', path: TENANT.logout, body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: () => {},
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
    // M5-TENANT-SESSION-P1: the tenant boundary too issues and ends its sessions only through the audited pair.
    ['a tenant store without the audited pair', { sessions: { tenant: { ...full, store: supplied } } }, 'session_store_audit_required'],
    ['a tenant store without end', { sessions: { tenant: { ...full, store: { ...supplied, establish: () => undefined } } } }, 'session_store_audit_required'],
    ['a supplied store with the audited pair', { sessions: { tenant: { ...full, store: { ...supplied, establish: () => undefined, end: () => undefined } } } }, undefined],
    // M6-ADMIN-AUDIT-P1: the administrative boundary issues and ends sessions only through the audited pair.
    ['an admin store without the audited pair', { sessions: { admin: admin({ store: supplied }) } }, 'session_store_audit_required'],
    ['an admin store without end', { sessions: { admin: admin({ store: { ...supplied, establish: () => undefined } }) } }, 'session_store_audit_required'],
    ['an admin store without establish', { sessions: { admin: admin({ store: { ...supplied, end: () => undefined } }) } }, 'session_store_audit_required'],
    ['an admin store with the audited pair', { sessions: { admin: admin({ store: { ...supplied, establish: () => undefined, end: () => undefined } }) } }, undefined],
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
  const admission = { admit: (p: VerifiedPrincipal): unknown => (p.authProvider === 'firebase' && p.authProviderUid === 'fb-uid-owner' ? ADMIT_PLATFORM : { admitted: false }) };
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
        for (const detail of ['uid-owner', 'synthetic', 'platform', 'permission', 'audience', 'totp', id]) {
          assert.ok(!reply.body.includes(detail), `${audience} ${label} disclosed ${detail}`);
        }
        // The CSRF token is random base64url and contains 'v1' about once in a hundred tokens, so that one short detail
        // is looked for outside the token only; every other detail above is looked for in the whole body, token included.
        assert.ok(!reply.body.split(csrf).join('').includes('v1'), `${audience} ${label} disclosed v1`);
      }
    }
  });
});

test('an unavailable session store fails closed: nothing is issued, read or half-revoked', async () => {
  const ops: string[] = [];
  const failing: { op?: string | readonly string[] } = {};
  await withSessions({ tenant: { store: instrumented(ops, failing) } }, async ({ port, logs, clock }) => {
    failing.op = 'establish';
    assertRefusal(await login(port, 'tenant', 'tok-member'), 503, 'service_unavailable', 'establish fails');
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
    // A revalidation that cannot be RECORDED could fail closed only on a boundary that records one, and none
    // does: neither boundary has a window (tenant M5-GIAM-D1-P2, admin M5-GIAM-D1-P4), so neither writes
    // validatedAt nor reads it to skip a re-check. A failing write is not a dependency of the request at all,
    // and the admission it just asked — which this store's failure does not touch — is what decides.
    failing.op = 'update:validatedAt';
    clock.t += ADMISSION_REVALIDATE_MS.tenant;
    assert.equal((await current(port, 'tenant', s.id)).status, 200,
      'the tenant boundary stores no validatedAt, so a failing write cannot fail the request');
    failing.op = undefined;
    assert.equal((await current(port, 'tenant', s.id)).status, 200, 'the session outlived the outage');
    // A refresh that cannot be stored never fails the request it follows; it is logged.
    failing.op = 'update:lastSeenAt';
    assert.equal((await send(port, 'POST', '/api/v1/probe', unsafe('tenant', s))).status, 200);
    assert.ok(await loggedWith(logs, 'event', 'session_refresh_failed'));
    failing.op = ['end', 'revoke'];
    // A logout whose audited end AND fallback revocation failed answers 503, yet still clears the cookie: a shared
    // terminal keeps nothing.
    const failedLogout = await send(port, 'POST', TENANT.logout, unsafe('tenant', s));
    assert.equal(failedLogout.status, 503);
    assert.equal((JSON.parse(failedLogout.body) as { error: string }).error, 'service_unavailable');
    assert.equal(setCookieOf(failedLogout).value, '', 'the cookie is cleared although the revocation failed');
    // A rotation is ONE audited step (M5-TENANT-SESSION-P1): one that fails leaves the presented session as it was,
    // and no cookie is issued for the lost one.
    failing.op = 'establish';
    assertRefusal(await login(port, 'tenant', 'tok-member', cookie('tenant', s.id)), 503, 'service_unavailable', 'establish fails at rotation');
    failing.op = undefined;
    assert.equal((await current(port, 'tenant', s.id)).status, 200, 'a failed logout or rotation left the session exactly as it was');
    assert.ok(await logged(logs, 'session_unavailable'));
    assert.ok(!logs.join('').includes('store-secret-detail'));
  });
});

test('a hanging verifier, admission, store, authorizer or limiter is cut off at the deadline and told to cancel', async () => {
  const signals: AbortSignal[] = [];
  const hanging = { verifier: false, admission: false, establish: false, get: false, authorizer: false, limiter: false };
  const hang = (signal: AbortSignal): Promise<never> => { signals.push(signal); return new Promise(() => {}); };
  const base = createMemorySessionStore();
  const store: SessionStore = {
    ...base,
    establish: (key, record, replaces, audit, signal) => (hanging.establish ? hang(signal) : base.establish(key, record, replaces, audit, signal)),
    get: (key, signal) => (hanging.get ? hang(signal) : base.get(key, signal)),
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
      ['establish', () => login(port, 'tenant', 'tok-member'), 'session_timeout'],
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

test('M5PR-01 both boundaries re-ask admission on every protected request, never on logout, and store no validatedAt stamp', async () => {
  // M5-GIAM-D1-P2 (GAP-13) abolished the tenant window: a suspended tenant loses access on its people's NEXT
  // request. M5-GIAM-D1-P4 abolishes the administrative one: the admin witness (migration 013,
  // platformAuthorization.ts) moves with the actor's platform grant, role, account standing and authority
  // version, so a withdrawn or re-roled grant must end the session on its next request — the current-session
  // read included, which a 60 s window used to answer without asking. With no window nothing reads
  // validatedAt to skip a re-check, so nothing writes it: that write would be a per-request dependency for
  // no benefit.
  assert.deepEqual({ ...ADMISSION_REVALIDATE_MS }, { tenant: 0, admin: 0 }, 'neither boundary has a revalidation window');
  assert.ok(Object.isFrozen(ADMISSION_REVALIDATE_MS));
  const ops: Record<SessionAudience, string[]> = { tenant: [], admin: [] };
  await withSessions({ tenant: { store: instrumented(ops.tenant) }, admin: { store: instrumented(ops.admin) } }, async ({ port, probe }) => {
    const asked = (audience: SessionAudience): number => probe.admissions.filter(([, a]) => a === audience).length;
    for (const audience of ['tenant', 'admin'] as const) {
      const s = await signIn(port, audience, 'tok-owner');
      const a0 = asked(audience);
      // No time passes at all, and every protected request still asks: the current-session read...
      for (let i = 1; i <= 3; i++) {
        assert.equal((await current(port, audience, s.id)).status, 200);
        assert.equal(asked(audience), a0 + i, `${audience}: current-session read ${i} asked again`);
      }
      // ...and an authorized route, safe or unsafe.
      assert.equal((await send(port, 'GET', READ_ROUTE[audience], cookie(audience, s.id))).status, 200);
      assert.equal((await send(port, 'POST', READ_ROUTE[audience], unsafe(audience, s))).status, 200);
      assert.equal(asked(audience), a0 + 5, `${audience}: once per protected request, with no window to wait out`);
      // Logout never asks: revoking a session is always allowed.
      assert.equal((await send(port, 'POST', sessionPaths(audience).logout, unsafe(audience, s))).status, 204);
      assert.equal(asked(audience), a0 + 5, `${audience}: logout asked nothing`);
      assertRefusal(await current(port, audience, s.id), 401, 'unauthenticated', `${audience}: logged out`);
    }
    await tick();
    for (const audience of ['tenant', 'admin'] as const) {
      assert.ok(ops[audience].includes('update:lastSeenAt'), `${audience}: the control — the store saw the idle refresh`);
      assert.ok(!ops[audience].some((op) => op.includes('validatedAt')), `${audience}: no validatedAt stamp is ever written`);
    }
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
  const admission = { admit: (): unknown => (denied ? { admitted: false } : { ...ADMIT, securityVersion: version }) };
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
  const admission = { admit: (): unknown => ({ ...ADMIT, securityVersion: version }) };
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
  const adminAdmission = { admit: (): unknown => (adminDenied ? { admitted: false } : ADMIT_PLATFORM) };
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

// --- the admitted scope and the admission probe (M5-GIAM-D1-P4) -------------------------------------

/** What a readiness request answers, as a status alone. */
const readinessOf = async (port: number): Promise<number> => (await send(port, 'GET', '/readiness')).status;
/** app.ts PROBE_REUSE_MS: advancing the clock this far makes the next readiness request probe afresh. */
const PROBE_REUSE_MS = 1_000;

test('M5PR-02 the scope admin admission selects reaches THIS request\'s route authorizer as a frozen copy; no scope is null', async () => {
  let answer: unknown = ADMIT_PLATFORM;
  const ops: string[] = [];
  await withSessions({ admin: { admission: { admit: (): unknown => answer }, store: instrumented(ops) } }, async ({ port, probe }) => {
    const s = await signIn(port, 'admin', 'tok-owner');
    const lastHanded = (): unknown => (probe.authorizations.at(-1) as unknown[])[4];
    assert.equal((await send(port, 'GET', '/admin/v1/probe', cookie('admin', s.id))).status, 200);
    assert.equal((await send(port, 'POST', '/admin/v1/probe', unsafe('admin', s))).status, 200);
    assert.equal(probe.authorizations.length, 2);
    for (const [i, args] of probe.authorizations.entries()) {
      assert.equal(args.length, 5, `request ${i}: the authorizer gets exactly its five arguments`);
      assert.deepEqual(args[4], PLATFORM_SCOPE, `request ${i}: the admitted scope, field for field`);
      assert.notEqual(args[4], PLATFORM_SCOPE, `request ${i}: a checked copy, never the adapter's own object`);
      assert.ok(Object.isFrozen(args[4]), `request ${i}: the copy is frozen`);
    }
    assert.notEqual(probe.authorizations[0][4], probe.authorizations[1][4], "each request carries its own admission's copy");
    // THIS request's admission decides: a grant re-roled at an unchanged witness reaches the very next request.
    answer = { ...ADMIT_PLATFORM, context: { ...PLATFORM_SCOPE, roleId: 'platform_support' } };
    assert.equal((await send(port, 'GET', '/admin/v1/probe', cookie('admin', s.id))).status, 200);
    assert.deepEqual(lastHanded(), { ...PLATFORM_SCOPE, roleId: 'platform_support' });
    // An admission that names no scope — the field absent, or null — hands the authorizer null.
    for (const [label, admitted] of [['absent', { admitted: true, securityVersion: 'v1' }], ['null', { ...ADMIT_PLATFORM, context: null }]] as const) {
      answer = admitted;
      assert.equal((await send(port, 'GET', '/admin/v1/probe', cookie('admin', s.id))).status, 200, label);
      assert.equal(lastHanded(), null, `a context ${label}: the authorizer receives null`);
    }
    // The current-session read declares no requirement: admission is asked there, the authorizer is not.
    answer = ADMIT_PLATFORM;
    const authorized = probe.authorizations.length;
    assert.equal((await current(port, 'admin', s.id)).status, 200);
    assert.equal(probe.authorizations.length, authorized, 'no authorizer behind the current-session read');
    assert.deepEqual([probe.handled.adminRead, probe.handled.adminWrite], [4, 1]);
    assert.ok(!ops.some((op) => op === 'revoke' || op === 'revokePrincipal'), 'nothing was revoked');
  });
});

test('M5PR-03 an admitted scope that is not one, or an answer whose getter throws, is an outage: a 503 that revokes nothing', async () => {
  let answer: unknown = ADMIT_PLATFORM;
  const ops: string[] = [];
  const secret = (): never => { throw new Error('admission-getter-secret'); };
  const getterThrows = <T extends object>(base: T, field: string): T =>
    Object.defineProperty({ ...base }, field, { get: secret, enumerable: true });
  const contexts: Array<[string, unknown]> = [
    ['a string', 'platform'], ['a number', 42], ['false', false], ['an array', [PLATFORM_SCOPE]],
    ['an actor that is no UUID', { ...PLATFORM_SCOPE, actor: 'uid-owner' }],
    ['no membership', { ...PLATFORM_SCOPE, membershipId: undefined }],
    ['a role outside the catalogue pattern', { ...PLATFORM_SCOPE, roleId: 'Platform Admin' }],
    ['an unknown limitation', { ...PLATFORM_SCOPE, limitation: 'full' }],
    ['an unknown scope', { ...PLATFORM_SCOPE, scope: 'global' }],
    ['a platform scope naming a tenant', { ...PLATFORM_SCOPE, tenant: PLATFORM_SCOPE.membershipId }],
    ['a tenant scope without its tenant', { ...PLATFORM_SCOPE, scope: 'tenant' }],
    ['a security version with a space', { ...PLATFORM_SCOPE, securityVersion: 'v 7' }],
    ['a scope field whose getter throws', getterThrows(PLATFORM_SCOPE, 'roleId')],
  ];
  const answers: Array<[string, unknown]> = [
    ...contexts.map(([label, context]): [string, unknown] => [label, { ...ADMIT_PLATFORM, context }]),
    ['a throwing context getter', getterThrows(ADMIT_PLATFORM, 'context')],
    ['a throwing admitted getter', getterThrows(ADMIT_PLATFORM, 'admitted')],
    ['a throwing securityVersion getter', getterThrows(ADMIT_PLATFORM, 'securityVersion')],
  ];
  await withSessions({ admin: { admission: { admit: (): unknown => answer }, store: instrumented(ops) } }, async ({ port, probe, logs }) => {
    const s = await signIn(port, 'admin', 'tok-owner');
    ops.length = 0;
    for (const [label, admitted] of answers) {
      answer = admitted;
      assertRefusal(await send(port, 'GET', '/admin/v1/probe', cookie('admin', s.id)), 503, 'service_unavailable', `${label}: a read`);
      assertRefusal(await send(port, 'POST', '/admin/v1/probe', unsafe('admin', s)), 503, 'service_unavailable', `${label}: a write`);
      assertRefusal(await current(port, 'admin', s.id), 503, 'service_unavailable', `${label}: the current-session read`);
      // At login the same answer issues nothing — and, being no denial, ends none of the principal's sessions.
      assertRefusal(await login(port, 'admin', 'tok-owner-again'), 503, 'service_unavailable', `${label}: a login`);
    }
    assert.equal(probe.authorizations.length, 0, 'the authorizer is never asked behind an outage');
    assert.deepEqual([probe.handled.adminRead, probe.handled.adminWrite], [undefined, undefined], 'no handler ran');
    assert.ok(ops.every((op) => op === 'get'), `the store was only read — nothing revoked, created or stamped: ${ops.join(' ')}`);
    assert.ok(await logged(logs, 'admission_unavailable'));
    assert.ok(!await logged(logs, 'session_admission_denied'), 'never read as a denial');
    assert.ok(!logs.join('').includes('admission-getter-secret'), 'no getter text escapes');
    answer = ADMIT_PLATFORM;
    assert.equal((await send(port, 'GET', '/admin/v1/probe', cookie('admin', s.id))).status, 200, 'the session outlived every outage');
  });
});

test('M5PR-04 a changed admin witness revokes the presented session before its authorizer is asked, whatever scope it names', async () => {
  let version = 'v1';
  const admission = { admit: (): unknown => ({ ...ADMIT_PLATFORM, securityVersion: version }) };
  await withSessions({ admin: { admission } }, async ({ port, probe, logs }) => {
    const stale = await signIn(port, 'admin', 'tok-owner');
    const sibling = await signIn(port, 'admin', 'tok-owner-again');
    version = 'v2';
    assertRefusal(await send(port, 'GET', '/admin/v1/probe', cookie('admin', stale.id)), 401, 'unauthenticated', 'a moved witness');
    assert.equal(probe.authorizations.length, 0, 'the authorizer is never asked on a stale witness');
    assert.equal(probe.handled.adminRead, undefined);
    assert.ok(await logged(logs, 'session_version_mismatch'));
    version = 'v1';
    assertRefusal(await current(port, 'admin', stale.id), 401, 'unauthenticated', 'the mismatched session stays revoked');
    // Only the presented session is revoked: a mismatch is no denial of the principal.
    assert.equal((await send(port, 'GET', '/admin/v1/probe', cookie('admin', sibling.id))).status, 200);
    assert.equal(probe.authorizations.length, 1);
    assert.deepEqual(probe.authorizations[0][4], PLATFORM_SCOPE, 'the scope reaches the authorizer once the witness holds');
  });
});

test('M5PR-05 each boundary\'s admission probe joins readiness through one shared probe per reuse window; health never depends on it', async () => {
  const answers: Record<SessionAudience, () => unknown> = { tenant: () => true, admin: () => true };
  const calls: Record<SessionAudience, unknown[]> = { tenant: [], admin: [] };
  const probing = (audience: SessionAudience): SessionBoundaryDeps['admission'] => ({
    admit: (p: VerifiedPrincipal, a: SessionAudience): unknown => (ADMITTED[a].has(p.authProviderUid) ? ADMIT : { admitted: false }),
    probe: (...args: unknown[]): unknown => { calls[audience].push(args); return answers[audience](); },
  });
  await withSessions({ tenant: { admission: probing('tenant') }, admin: { admission: probing('admin') } }, async ({ port, clock }) => {
    assert.deepEqual([await readinessOf(port), await readinessOf(port), await readinessOf(port)], [200, 200, 200]);
    assert.deepEqual([calls.tenant.length, calls.admin.length], [1, 1], 'one shared probe per boundary answers every request inside the window');
    for (const audience of ['tenant', 'admin'] as const) {
      const [args] = calls[audience] as unknown[][];
      assert.equal(args.length, 1, `${audience}: the probe is handed exactly one argument`);
      assert.ok(args[0] instanceof AbortSignal, `${audience}: its deadline signal`);
    }
    // Admission is a dependency of every protected request, so an admission that cannot answer makes the instance unready.
    const failures: Array<[string, () => unknown]> = [
      ['false', () => false], ['a truthy value that is not true', () => 'true'], ['a resolved false', () => Promise.resolve(false)],
      ['a throw', () => { throw new Error('admission-probe-secret'); }], ['a rejection', () => Promise.reject(new Error('admission-probe-secret'))],
    ];
    for (const audience of ['tenant', 'admin'] as const) {
      for (const [label, answer] of failures) {
        answers[audience] = answer;
        clock.t += PROBE_REUSE_MS;
        assert.equal(await readinessOf(port), 503, `${audience} admission probe answering ${label}`);
        assert.equal((await send(port, 'GET', '/health')).status, 200, `${audience} ${label}: liveness never depends on admission`);
      }
      answers[audience] = () => true;
      assert.equal(await readinessOf(port), 503, `${audience}: a failed answer is reused inside its window`);
      clock.t += PROBE_REUSE_MS;
      assert.equal(await readinessOf(port), 200, `${audience}: ready again once its admission answers`);
    }
  });
  // An admission without probe adds no check: the harness default offers none, and readiness answers as before.
  await withSessions({}, async ({ port }) => {
    assert.equal(await readinessOf(port), 200);
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
    securityVersion: 'v1', authenticatedAt: T0 - 2000, createdAt: T0 - 1000, lastSeenAt: T0 - 1000, validatedAt: T0 - 1000,
  };
  const records: unknown[] = [
    'a string', 42, [], { ...base, authProviderUid: '' }, { ...base, authProviderUid: 'x'.repeat(129) }, { ...base, authProvider: undefined },
    { ...base, principalKey: principalKeyOf(principal('uid-owner')) }, { ...base, principalKey: undefined },
    { ...base, securityVersion: undefined }, { ...base, securityVersion: 'has space' }, { ...base, securityVersion: 'x'.repeat(129) },
    { ...base, createdAt: '0' }, { ...base, lastSeenAt: Number.NaN }, { ...base, createdAt: T0, lastSeenAt: T0 - 1, validatedAt: T0 },
    { ...base, lastSeenAt: T0 + 60_000 }, { ...base, validatedAt: T0 + 60_000 }, { ...base, validatedAt: T0 - 2000 },
    { ...base, validatedAt: undefined }, { ...base, createdAt: T0 + 60_000, lastSeenAt: T0 + 60_000, validatedAt: T0 + 60_000 },
    // The trusted authentication time is read exactly as strictly (M5-GIAM-D1-P2): a record that omits it
    // is malformed, and one dated past the skew allowance, at zero or not a whole number is no evidence.
    { ...base, authenticatedAt: undefined }, { ...base, authenticatedAt: T0 + 60_000 }, { ...base, authenticatedAt: 0 },
    { ...base, authenticatedAt: -1 }, { ...base, authenticatedAt: 1.5 }, { ...base, authenticatedAt: '1' },
  ];
  let served: unknown;
  const store: SessionStore = {
    create: () => undefined, get: () => served, update: () => undefined, revoke: () => undefined, revokePrincipal: () => undefined,
    establish: () => undefined, end: () => undefined,
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
    // Login admits once; the protected request that follows re-asks, since the tenant boundary keeps no
    // revalidation window (M5-GIAM-D1-P2). Both calls receive the same frozen view.
    assert.equal(probe.admissions.length, 2);
    const [admitted, audience, admissionSignal, ...restA] = probe.admissions[0];
    assert.equal(restA.length, 0, 'admission gets exactly its three arguments');
    frozenPlain(admitted, ['authProvider', 'authProviderUid'], 'the admitted principal');
    assert.deepEqual(admitted, principal('uid-member'));
    assert.equal(audience, 'tenant');
    assert.ok(admissionSignal instanceof AbortSignal, 'a deadline signal, never the request');
    assert.equal(probe.authorizations.length, 1);
    const [authorized, requirement, route, authzSignal, admittedScope, ...rest] = probe.authorizations[0];
    assert.equal(rest.length, 0, 'the authorizer gets exactly its five arguments');
    // The fifth is the scope THIS request's admission selected (M5-GIAM-D1-P4); this admission names none.
    assert.equal(admittedScope, null, 'an admission that names no scope hands the authorizer null');
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

// --- reauthentication (M5-ADMIN-STEPUP-P1) ------------------------------------------------

/** A reauthentication login: the ordinary admin login, presenting `id`, with the opt-in header. */
const reauth = (port: number, token: string, id: string | null, header: string | string[] = REAUTHENTICATE_VALUE): Promise<Reply> =>
  send(port, 'POST', ADMIN.login, {
    ...pre('admin'), authorization: `Bearer ${token}`, ...(id === null ? {} : cookie('admin', id)), [REAUTHENTICATE_HEADER]: header,
  });
const recent = (port: number, id: string): Promise<Reply> => send(port, 'GET', RECENT_ROUTE, cookie('admin', id));
const keyOf = (id: string): string => createHash('sha256').update(id).digest('base64url');
/** The store operations that create or end a session: none may run when a reauthentication is refused. */
const writes = (ops: string[]): string[] => ops.filter((op) => ['create', 'revoke', 'revokePrincipal', 'establish', 'end'].includes(op));
const recordOf = async (store: SessionStore, id: string): Promise<SessionRecord | undefined> =>
  (await store.get(keyOf(id), aSignal())) as SessionRecord | undefined;

test('reauthentication by the same administrator rotates the presented session and binds the NEW provider authentication; the old cookie is refused', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  await withSessions({ admin: { store } }, async ({ port, clock }) => {
    const old = await signIn(port, 'admin', 'tok-owner');
    const firstAuth = T0 - 60_000;
    clock.t += RECENT_AUTH_MAX_AGE_MS; // the provider authentication is now eleven minutes old
    assertRefusal(await recent(port, old.id), 403, 'step_up_required', 'the stale session before reauthentication');
    ops.length = 0;
    const r = await reauth(port, 'tok-owner-again', old.id);
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(ops, ['get', 'establish'], 'read the presented session, then end it and create the new one in ONE audited call — no update of the old');
    const renewed = setCookieOf(r);
    // Its record: a reauthentication by the actor admission selected, binding the new sign-in, replacing the presented session.
    const [recorded] = store.audits;
    assert.equal(store.audits.length, 2, 'the first sign-in and the reauthentication');
    assert.deepEqual({ ...store.audits[1], entry: { ...store.audits[1].entry, operationId: '-' } }, {
      entry: { action: 'reauthenticate', operationId: '-', actor: PLATFORM_SCOPE.actor, authenticatedAt: clock.t - 60_000 },
      key: keyOf(renewed.value), replaced: keyOf(old.id),
    });
    assert.equal(recorded.entry.action, 'login', 'the first sign-in was an ordinary login');
    assert.equal(renewed.name, SESSION_COOKIES.admin);
    assert.deepEqual(renewed.attributes, ['HttpOnly', 'Max-Age=3600', 'Path=/', 'SameSite=Strict', 'Secure']);
    assert.notEqual(renewed.value, old.id, 'a fresh identifier');
    const body = JSON.parse(r.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['csrfToken', 'status'], 'the answer is an ordinary login answer');
    assert.notEqual(body.csrfToken, old.csrf, 'the CSRF token rotates with the session');
    const record = await recordOf(store, renewed.value);
    assert.equal(record?.authenticatedAt, clock.t - 60_000, 'the new record carries the new sign-in\'s verified time');
    assert.notEqual(record?.authenticatedAt, firstAuth);
    assert.equal(await recordOf(store, old.id), undefined, 'the superseded record is revoked, never updated');
    assertRefusal(await current(port, 'admin', old.id), 401, 'unauthenticated', 'the old cookie');
    assertRefusal(await recent(port, old.id), 401, 'unauthenticated', 'the old cookie cannot borrow the new evidence');
    assert.equal((await recent(port, renewed.value)).status, 200, 'the renewed session passes the step-up gate');
  });
});

test('reauthentication by a DIFFERENT administrator is a generic 401 that creates and revokes nothing', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  await withSessions({ admin: { store } }, async ({ port, clock, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    clock.t += RECENT_AUTH_MAX_AGE_MS;
    const before = await recordOf(store, owner.id);
    ops.length = 0;
    const r = await reauth(port, 'tok-peer', owner.id);
    assertRefusal(r, 401, 'unauthenticated', 'a different administrator');
    assert.equal(r.headers['www-authenticate'], 'Bearer', 'exactly a bad credential\'s answer');
    assert.deepEqual(writes(ops), [], 'nothing created, nothing revoked');
    assert.ok(await logged(logs, 'login_reauth_mismatch'));
    assert.deepEqual(await recordOf(store, owner.id), before, 'the prior administrator\'s record is exactly as it was');
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'and still active');
    assertRefusal(await recent(port, owner.id), 403, 'step_up_required', 'and still stale for step-up');
    // The ordinary login (no header) is unchanged: it rotates whatever it is presented, which is why the console must opt in.
    const plain = await login(port, 'admin', 'tok-peer', cookie('admin', owner.id));
    assert.equal(plain.status, 200, plain.body);
    assertRefusal(await current(port, 'admin', owner.id), 401, 'unauthenticated', 'an ordinary login still rotates the presented session');
  });
});

test('reauthentication without a live presented session is a generic 401 that creates and revokes nothing', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  await withSessions({ admin: { store } }, async ({ port, clock, logs }) => {
    const ended = await signIn(port, 'admin', 'tok-owner');
    assert.equal((await send(port, 'POST', ADMIN.logout, unsafe('admin', ended))).status, 204);
    const idle = await signIn(port, 'admin', 'tok-owner');
    const tenantSession = await signIn(port, 'tenant', 'tok-owner');
    clock.t += SESSION_TTL.admin.idleMs; // `idle` has now lapsed; every token below still verifies as a fresh sign-in
    const unknown = 'A'.repeat(43);
    const cases: Array<[string, Record<string, string>]> = [
      ['no cookie', {}],
      ['a malformed cookie', { cookie: `${SESSION_COOKIES.admin}=not-an-id` }],
      ['an unknown identifier', cookie('admin', unknown)],
      ['a duplicated cookie', { cookie: `${SESSION_COOKIES.admin}=${unknown}; ${SESSION_COOKIES.admin}=${unknown}` }],
      ['a logged-out session', cookie('admin', ended.id)],
      ['an idle-expired session', cookie('admin', idle.id)],
      ['the tenant boundary\'s session', cookie('admin', tenantSession.id)],
      ['only the tenant cookie', cookie('tenant', tenantSession.id)],
    ];
    for (const [label, presented] of cases) {
      ops.length = 0;
      const r = await send(port, 'POST', ADMIN.login, {
        ...pre('admin'), authorization: 'Bearer tok-owner', ...presented, [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE,
      });
      assertRefusal(r, 401, 'unauthenticated', label);
      assert.deepEqual(writes(ops), [], `${label}: nothing created, nothing revoked (not even the unknown identifier)`);
    }
    assert.ok(await logged(logs, 'login_reauth_no_session'));
    assert.equal((await current(port, 'tenant', tenantSession.id)).status, 200, 'the tenant session was not touched');
  });
});

test('a reauthentication header with any value but exactly "1", or on two lines, fails closed and is never an ordinary login', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  await withSessions({ admin: { store } }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    for (const header of ['0', 'true', 'yes', '11', '1, 1', '', ['1', '1'], ['1', '0']] as Array<string | string[]>) {
      const label = JSON.stringify(header);
      ops.length = 0;
      // The same administrator, a fresh sign-in and a live presented session: only the header is wrong.
      assertRefusal(await reauth(port, 'tok-owner-again', owner.id, header), 401, 'unauthenticated', label);
      assert.deepEqual(writes(ops), [], `${label}: nothing created, nothing revoked`);
    }
    assert.ok(await logged(logs, 'login_reauth_header_invalid'));
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'the presented session is untouched');
  });
});

test('a session store that cannot read the presented session answers 503 and issues nothing', async () => {
  const ops: string[] = [];
  const failing: { op?: string } = {};
  const store = instrumented(ops, failing);
  await withSessions({ admin: { store } }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    failing.op = 'get';
    ops.length = 0;
    const r = await reauth(port, 'tok-owner-again', owner.id);
    assertRefusal(r, 503, 'service_unavailable', 'the presented session cannot be read');
    assert.equal(r.headers['www-authenticate'], undefined, 'an outage is no credential challenge');
    assert.deepEqual(writes(ops), [], 'nothing created, nothing revoked');
    assert.ok(await logged(logs, 'session_unavailable'));
    assert.ok(!logs.join('').includes('store-secret-detail'));
    failing.op = undefined;
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'the session outlived the outage');
  });
});

test('a reauthentication admission refuses ends every session of that administrator, exactly as a login admission denial does', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  const gate = { admit: true };
  await withSessions({
    admin: { store, admission: { admit: () => (gate.admit ? ADMIT_PLATFORM : { admitted: false }) } },
  }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    gate.admit = false;
    ops.length = 0;
    assertRefusal(await reauth(port, 'tok-owner-again', owner.id), 401, 'unauthenticated', 'admission refused');
    assert.deepEqual(ops, ['revokePrincipal'],
      'admission decides before the presented session is even read: the principal\'s sessions end, nothing is read or created');
    assert.ok(await logged(logs, 'login_admission_denied'));
    gate.admit = true;
    assert.equal(await recordOf(store, owner.id), undefined, 'the prior session is gone');
    assertRefusal(await current(port, 'admin', owner.id), 401, 'unauthenticated', 'even once admission would admit again');
  });
});

// This proves the login auth-age policy (LOGIN_POLICIES.admin, applied by the chain before any login handler runs),
// not the reauthentication guard: there is no new evidence without a new sign-in, whatever header the login carries.
test('no new evidence without a new sign-in: a refreshed token is refused by the login auth-age policy, and the stale session stays unable to pass the step-up gate', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  await withSessions({ admin: { store } }, async ({ port, clock, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    clock.t += RECENT_AUTH_MAX_AGE_MS;
    const before = await recordOf(store, owner.id);
    ops.length = 0;
    // A refresh keeps the provider's auth_time: here it is six minutes old, past the admin login policy's five.
    assertRefusal(await reauth(port, 'tok-owner-refreshed', owner.id), 401, 'unauthenticated', 'a refreshed token');
    assert.deepEqual(ops, [], 'refused by the evidence policy before any session is read, created or revoked');
    assert.ok(await logged(logs, 'login_auth_stale'));
    assert.deepEqual(await recordOf(store, owner.id), before, 'no evidence was carried into the session');
    assertRefusal(await recent(port, owner.id), 403, 'step_up_required', 'the stale session after the refused attempt');
  });
});

test('the reauthentication header name is case-insensitive: a mixed-case spelling is a reauthentication, with its same-principal check', async () => {
  await withSessions({}, async ({ port }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    const mixed = (token: string): Promise<Reply> => send(port, 'POST', ADMIN.login, {
      ...pre('admin'), authorization: `Bearer ${token}`, ...cookie('admin', owner.id), 'X-TMPOS-Reauthenticate': REAUTHENTICATE_VALUE,
    });
    assertRefusal(await mixed('tok-peer'), 401, 'unauthenticated', 'a different administrator, mixed-case header');
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'so the presented session was not rotated away');
    const renewed = await mixed('tok-owner-again');
    assert.equal(renewed.status, 200, renewed.body);
    assertRefusal(await current(port, 'admin', owner.id), 401, 'unauthenticated', 'the same administrator rotated it');
  });
});

test('the tenant boundary shares the code: a same-principal reauthentication rotates, a different principal is refused with nothing written, and a login without the header is unchanged', async () => {
  const ops: string[] = [];
  await withSessions({ tenant: { store: instrumented(ops) } }, async ({ port, logs }) => {
    const tenantReauth = (token: string, id: string): Promise<Reply> =>
      login(port, 'tenant', token, { ...cookie('tenant', id), [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE });
    const member = await signIn(port, 'tenant', 'tok-member');
    ops.length = 0;
    assertRefusal(await tenantReauth('tok-owner', member.id), 401, 'unauthenticated', 'a different tenant principal');
    assert.deepEqual(writes(ops), [], 'nothing created, nothing revoked');
    assert.ok(await logged(logs, 'login_reauth_mismatch'));
    assert.equal((await current(port, 'tenant', member.id)).status, 200, 'the member\'s session is untouched');
    ops.length = 0;
    const renewed = await tenantReauth('tok-member-again', member.id);
    assert.equal(renewed.status, 200, renewed.body);
    assert.deepEqual(ops, ['get', 'establish'], 'the presented session read, then ONE audited step (M5-TENANT-SESSION-P1)');
    assertRefusal(await current(port, 'tenant', member.id), 401, 'unauthenticated', 'the rotated tenant session');
    const next = setCookieOf(renewed).value;
    assert.equal((await current(port, 'tenant', next)).status, 200);
    // Without the header the tenant login is exactly today's: it rotates whatever it is presented.
    ops.length = 0;
    const plain = await login(port, 'tenant', 'tok-owner', cookie('tenant', next));
    assert.equal(plain.status, 200, plain.body);
    assert.deepEqual(ops, ['establish'], 'no presented-session read, no principal check');
    assertRefusal(await current(port, 'tenant', next), 401, 'unauthenticated', 'an ordinary tenant login rotated the presented session');
  });
});

test('a same-principal reauthentication whose admission now reports a different security version is refused, writes nothing, and the old session then ends as today', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  const version = { current: 'v1' };
  await withSessions({
    admin: { store, admission: { admit: (p: VerifiedPrincipal) => (ADMITTED.admin.has(p.authProviderUid) ? { ...ADMIT_PLATFORM, securityVersion: version.current } : { admitted: false }) } },
  }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    version.current = 'v2'; // a grant or role changed since the session was issued
    ops.length = 0;
    assertRefusal(await reauth(port, 'tok-owner-again', owner.id), 401, 'unauthenticated', 'a stale-version session');
    assert.deepEqual(writes(ops), [], 'nothing created, nothing revoked');
    assert.ok(await logged(logs, 'login_reauth_stale_version'));
    assert.notEqual(await recordOf(store, owner.id), undefined, 'the record is left for the ordinary path');
    assertRefusal(await current(port, 'admin', owner.id), 401, 'unauthenticated', 'the next session request');
    assert.ok(await logged(logs, 'session_version_mismatch'), 'refused and revoked by the existing version check');
    assert.equal(await recordOf(store, owner.id), undefined);
  });
});

// --- administrative session audit (M6-ADMIN-AUDIT-P1) ------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The request log lines for `path`, once at least `count` have been written (a line may trail its reply slightly). */
async function linesOf(logs: string[], path: string, count: number): Promise<Array<Record<string, unknown>>> {
  let lines: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 200; i++) {
    lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.event === 'request' && r.route === path);
    if (lines.length >= count) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return lines;
}
const warningsOf = (logs: string[]): Array<Record<string, unknown>> =>
  logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.event === 'session_logout_audit_unconfirmed');
/** An audit record with its random operation id masked, for a whole-value comparison. */
const masked = ({ entry, key, replaced }: MemorySessionStore['audits'][number]): unknown => ({ entry: { ...entry, operationId: '-' }, key, replaced });

test('M6AA-01 an administrative login is ONE audited establish attributed to the admitted actor, and its log line carries the record\'s server id', async () => {
  const ops: Record<SessionAudience, string[]> = { tenant: [], admin: [] };
  const admin = instrumented(ops.admin);
  const tenant = instrumented(ops.tenant);
  await withSessions({ admin: { store: admin }, tenant: { store: tenant } }, async ({ port, logs, clock }) => {
    const first = await signIn(port, 'admin', 'tok-owner');
    const second = await signIn(port, 'admin', 'tok-owner-again', cookie('admin', first.id));
    assert.deepEqual(ops.admin, ['establish', 'establish'], 'no create and no revoke: rotation is inside the one audited call');
    assert.deepEqual(admin.audits.map(masked), [
      { entry: { action: 'login', operationId: '-', actor: PLATFORM_SCOPE.actor, authenticatedAt: clock.t - 60_000 }, key: keyOf(first.id), replaced: null },
      { entry: { action: 'login', operationId: '-', actor: PLATFORM_SCOPE.actor, authenticatedAt: clock.t - 60_000 }, key: keyOf(second.id), replaced: keyOf(first.id) },
    ], 'a login presenting a session is still a login: only the verified reauthentication path records otherwise');
    assertRefusal(await current(port, 'admin', first.id), 401, 'unauthenticated', 'the rotated-away session');
    const ids = admin.audits.map(({ entry }) => entry.operationId);
    assert.ok(ids.every((id) => UUID_V4.test(id)) && ids[0] !== ids[1], 'a fresh server UUID per operation');
    assert.deepEqual((await linesOf(logs, ADMIN.login, 2)).map((line) => line.operationId), ids, "each login's log line carries its record's id");
    // A client's request id is a correlator only: it is never the record's id, and the record's id is never in a reply.
    const chosen = 'client-chosen-request-id';
    const r = await login(port, 'admin', 'tok-owner', { 'x-request-id': chosen });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers['x-request-id'], chosen);
    const third = admin.audits[2].entry.operationId;
    assert.ok(UUID_V4.test(third) && third !== chosen);
    assert.ok(!`${r.body}${JSON.stringify(r.headers)}`.includes(third), 'the operation id reaches the log alone');
    // M5-TENANT-SESSION-P1: the tenant boundary goes through the same pair, attributed to its admission's actor.
    const t1 = await signIn(port, 'tenant', 'tok-member');
    const t2 = await signIn(port, 'tenant', 'tok-member-again', cookie('tenant', t1.id));
    assert.equal((await send(port, 'POST', TENANT.logout, unsafe('tenant', t2))).status, 204);
    assert.deepEqual(ops.tenant.filter((op) => op !== 'get'), ['establish', 'establish', 'end']);
    assert.deepEqual(tenant.audits.map(masked), [
      { entry: { action: 'login', operationId: '-', actor: TENANT_ACTOR, authenticatedAt: clock.t - 60_000 }, key: keyOf(t1.id), replaced: null },
      { entry: { action: 'login', operationId: '-', actor: TENANT_ACTOR, authenticatedAt: clock.t - 60_000 }, key: keyOf(t2.id), replaced: keyOf(t1.id) },
      { entry: { action: 'logout', operationId: '-', actor: null, authenticatedAt: null }, key: keyOf(t2.id), replaced: null },
    ]);
    const tenantLines = [...await linesOf(logs, TENANT.login, 2), ...await linesOf(logs, TENANT.logout, 1)];
    assert.deepEqual(tenantLines.map((line) => line.operationId), tenant.audits.map(({ entry }) => entry.operationId), 'each line carries its record\'s id');
  });
});

test('M6AA-02 an administrative admission naming no scope is a 503 that reads, creates and revokes nothing; no refusal writes a record', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  let answer: unknown = ADMIT_PLATFORM;
  await withSessions({ admin: { store, admission: { admit: () => answer } } }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    ops.length = 0;
    for (const [label, admitted] of [['absent', ADMIT], ['null', { ...ADMIT_PLATFORM, context: null }]] as const) {
      answer = admitted;
      for (const r of [await login(port, 'admin', 'tok-owner-again', cookie('admin', owner.id)), await reauth(port, 'tok-owner-again', owner.id)]) {
        assertRefusal(r, 503, 'service_unavailable', `a context ${label}`);
        assert.equal(r.headers['www-authenticate'], undefined, 'a faulty adapter is an outage, not a credential verdict');
      }
    }
    assert.deepEqual(ops, [], 'nothing read, created or revoked');
    assert.ok(await logged(logs, 'admission_unavailable'));
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'a session request is served on it as before: only a login attributes');
    answer = ADMIT_PLATFORM;
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'the presented session was never touched');
    // Refusals before a trusted actor exists record nothing: a different administrator's reauthentication, a denied admission.
    assertRefusal(await reauth(port, 'tok-peer', owner.id), 401, 'unauthenticated', 'a different administrator');
    answer = { admitted: false };
    assertRefusal(await login(port, 'admin', 'tok-owner-again'), 401, 'unauthenticated', 'admission denied');
    assert.equal(store.audits.length, 1, 'only the first sign-in was recorded');
    const refused = (await linesOf(logs, ADMIN.login, 7)).filter((line) => line.status !== 200);
    assert.ok(refused.length === 6 && refused.every((line) => !('operationId' in line)), 'no refused login ran an operation');
  });
});

test('M6AA-03 an administrative login whose audited establish fails answers 503 with no cookie and keeps the presented session', async () => {
  const ops: string[] = [];
  const failing: { op?: string } = {};
  const store = instrumented(ops, failing);
  await withSessions({ admin: { store } }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    failing.op = 'establish';
    for (const [label, r] of [['login', await login(port, 'admin', 'tok-owner-again', cookie('admin', owner.id))],
      ['reauthentication', await reauth(port, 'tok-owner-again', owner.id)]] as const) {
      assertRefusal(r, 503, 'service_unavailable', `${label}: establish fails`);
    }
    failing.op = undefined;
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'the presented session outlived both failures');
    assert.equal(store.audits.length, 1, 'nothing recorded');
    assert.ok(await logged(logs, 'session_unavailable'));
    // The 503's line still carries the operation's id: a commit whose answer was lost may have left its record.
    const failed = (await linesOf(logs, ADMIN.login, 3)).filter((line) => line.status === 503);
    assert.ok(failed.length === 2 && failed.every((line) => typeof line.operationId === 'string' && UUID_V4.test(line.operationId)));
    assert.ok(!logs.join('').includes('store-secret-detail'));
  });
});

test('M5AR-L1 the store decides where it writes: session_ended and standing_changed are a generic 401 that ends, creates and records nothing; any other answer is a 503', async () => {
  const ops: string[] = [];
  const base = instrumented(ops);
  // The store's answer, scripted: what a durable store says when a logout, a revocation or an authority change
  // committed between this login's reads and its establish (M5-ADMIN-REVOKE-P1).
  const scripted: { answer?: unknown; on: boolean } = { on: false };
  const store: MemorySessionStore = {
    ...base,
    establish: (key, record, replaces, audit, signal) => {
      if (!scripted.on) return base.establish(key, record, replaces, audit, signal);
      ops.push('establish');
      return Promise.resolve(scripted.answer);
    },
  };
  await withSessions({ admin: { store } }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    const before = await recordOf(store, owner.id);
    scripted.on = true;
    const cases: Array<[string, unknown, () => Promise<Reply>, number, string]> = [
      ['a reauthentication whose presented session was ended first', 'session_ended', () => reauth(port, 'tok-owner-again', owner.id), 401, 'login_reauth_no_session'],
      ['a login whose standing moved', 'standing_changed', () => login(port, 'admin', 'tok-owner-again', cookie('admin', owner.id)), 401, 'login_standing_changed'],
      ['a reauthentication whose standing moved', 'standing_changed', () => reauth(port, 'tok-owner-again', owner.id), 401, 'login_standing_changed'],
      // The port answers session_ended to a reauthentication only: at an ordinary login it is a broken store.
      ['an ordinary login answered session_ended', 'session_ended', () => login(port, 'admin', 'tok-owner-again', cookie('admin', owner.id)), 503, 'session_unavailable'],
      ['no answer', undefined, () => login(port, 'admin', 'tok-owner-again'), 503, 'session_unavailable'],
      ['an unknown word', 'ESTABLISHED', () => login(port, 'admin', 'tok-owner-again'), 503, 'session_unavailable'],
      ['an object', { outcome: 'established' }, () => reauth(port, 'tok-owner-again', owner.id), 503, 'session_unavailable'],
    ];
    for (const [label, answer, attempt, status, reason] of cases) {
      scripted.answer = answer;
      ops.length = 0;
      const r = await attempt();
      if (status === 401) {
        assertRefusal(r, 401, 'unauthenticated', label);
        assert.equal(r.headers['www-authenticate'], 'Bearer', `${label}: exactly a bad credential's answer`);
      } else {
        assertRefusal(r, 503, 'service_unavailable', label);
      }
      assert.equal(r.headers['set-cookie'], undefined, `${label}: no cookie issued`);
      assert.deepEqual(writes(ops), ['establish'], `${label}: the one store step, which wrote nothing — and no revocation of the principal`);
      assert.ok(await logged(logs, reason), `${label}: ${reason}`);
    }
    scripted.on = false;
    assert.equal(store.audits.length, 1, 'nothing recorded beyond the first sign-in');
    assert.deepEqual(await recordOf(store, owner.id), before, 'the presented session is exactly as it was');
    assert.equal((await current(port, 'admin', owner.id)).status, 200, 'and still active: the next request is judged afresh');
  });
});

test('M5AR-L2 a recent sign-in whose presented session is ended after the handler read it creates nothing: the store refuses where it writes (R1)', async () => {
  const memory = createMemorySessionStore();
  // A logout (or a revocation) that takes effect between the handler's read of the presented session and the store's step.
  const race: { on: boolean } = { on: false };
  const store: MemorySessionStore = {
    ...memory,
    establish: (key, record, replaces, audit, signal) => {
      if (race.on && replaces !== null) memory.revoke(replaces, signal);
      return memory.establish(key, record, replaces, audit, signal);
    },
  };
  await withSessions({ admin: { store } }, async ({ port, logs }) => {
    const owner = await signIn(port, 'admin', 'tok-owner');
    race.on = true;
    const r = await reauth(port, 'tok-owner-again', owner.id);
    assertRefusal(r, 401, 'unauthenticated', 'the presented session ended first');
    assert.equal(r.headers['set-cookie'], undefined, 'no session issued');
    assert.ok(await logged(logs, 'login_reauth_no_session'));
    assert.equal(memory.audits.length, 1, 'no reauthentication recorded: only the first sign-in');
    assertRefusal(await current(port, 'admin', owner.id), 401, 'unauthenticated', 'and the ended session stays ended');
  });
});

test('M6AA-04 an administrative logout ends the session and records it in one call, attributed to no actor, and answers 204', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  await withSessions({ admin: { store } }, async ({ port, logs }) => {
    const s = await signIn(port, 'admin', 'tok-owner');
    ops.length = 0;
    const out = await send(port, 'POST', ADMIN.logout, unsafe('admin', s));
    assert.equal(out.status, 204);
    assert.equal(setCookieOf(out).value, '');
    assert.deepEqual(ops, ['get', 'end'], 'the session read, then one audited call — no plain revoke');
    const ended = store.audits[1];
    assert.deepEqual(masked(ended), { entry: { action: 'logout', operationId: '-', actor: null, authenticatedAt: null }, key: keyOf(s.id), replaced: null });
    assert.equal(store.audits[0].key, ended.key, 'the logout names the session its login record created');
    assertRefusal(await current(port, 'admin', s.id), 401, 'unauthenticated', 'logged out');
    const [line] = await linesOf(logs, ADMIN.logout, 1);
    assert.equal(line.operationId, ended.entry.operationId);
    assert.equal(line.reason, undefined, 'a confirmed logout carries no reason');
    assert.deepEqual(warningsOf(logs), []);
  });
});

test('M6AA-05 a logout whose audited end fails falls back to the plain revocation: 204, the record unconfirmed in the log and warned; both failing is the existing 503, still warned', async () => {
  const ops: string[] = [];
  const failing: { op?: string | readonly string[] } = {};
  const store = instrumented(ops, failing);
  await withSessions({ admin: { store } }, async ({ port, logs }) => {
    const s = await signIn(port, 'admin', 'tok-owner');
    failing.op = 'end';
    ops.length = 0;
    const out = await send(port, 'POST', ADMIN.logout, unsafe('admin', s));
    assert.equal(out.status, 204, 'revocation outranks the record');
    assert.equal(setCookieOf(out).value, '');
    assert.deepEqual(ops, ['get', 'end', 'revoke']);
    assertRefusal(await current(port, 'admin', s.id), 401, 'unauthenticated', 'the session is ended all the same');
    assert.equal(store.audits.length, 1, 'no logout record');
    const [line] = await linesOf(logs, ADMIN.logout, 1);
    assert.equal(line.status, 204);
    assert.equal(line.reason, 'logout_audit_unconfirmed');
    const [warning, ...more] = warningsOf(logs);
    assert.equal(more.length, 0);
    assert.deepEqual([warning.level, warning.reason, warning.operationId, warning.requestId],
      ['warn', 'session_unavailable', line.operationId, line.requestId], 'one warning, joined to the request by both ids');
    // Both failing: nothing is known to be ended — the existing 503 and the cookie cleared all the same. The warning is
    // written before the fallback runs, so why the audited end failed is not lost with it.
    const t = await signIn(port, 'admin', 'tok-owner');
    failing.op = ['end', 'revoke'];
    const down = await send(port, 'POST', ADMIN.logout, unsafe('admin', t));
    assert.equal(down.status, 503);
    assert.equal((JSON.parse(down.body) as { error: string }).error, 'service_unavailable');
    assert.equal(setCookieOf(down).value, '', 'a shared terminal keeps nothing');
    failing.op = undefined;
    assert.equal((await current(port, 'admin', t.id)).status, 200, 'nothing was ended');
    const warnings = warningsOf(logs);
    assert.equal(warnings.length, 2);
    const [, lastLine] = await linesOf(logs, ADMIN.logout, 2);
    assert.deepEqual([warnings[1].reason, warnings[1].operationId], ['session_unavailable', lastLine.operationId], 'the audited end\'s reason survives');
    assert.ok(!logs.join('').includes('store-secret-detail'));
  });
});

test('M6AA-06 end answering that nothing was live is a 204 that revokes and records nothing; an answer that is neither word takes the fallback', async () => {
  const cases: Array<[unknown, string, boolean]> = [
    ['absent', 'logout_session_absent', false], ['maybe', 'logout_audit_unconfirmed', true], [undefined, 'logout_audit_unconfirmed', true],
  ];
  for (const [answer, reason, fallback] of cases) {
    const base = createMemorySessionStore();
    const revokes: string[] = [];
    const store: SessionStore = { ...base, end: () => answer, revoke: (key, signal) => { revokes.push(key); return base.revoke(key, signal); } };
    await withSessions({ admin: { store } }, async ({ port, logs }) => {
      const s = await signIn(port, 'admin', 'tok-owner');
      const out = await send(port, 'POST', ADMIN.logout, unsafe('admin', s));
      assert.equal(out.status, 204, String(answer));
      assert.equal(setCookieOf(out).value, '');
      assert.equal((await linesOf(logs, ADMIN.logout, 1))[0].reason, reason, String(answer));
      assert.deepEqual(revokes, fallback ? [keyOf(s.id)] : [], `${String(answer)}: the plain revocation ran only as the fallback`);
      assert.equal(warningsOf(logs).length, fallback ? 1 : 0);
      if (fallback) assert.equal(warningsOf(logs)[0].reason, 'session_answer_invalid');
    });
  }
});

/** Start an unsafe request and hand back a way to drop its connection before any reply arrives. */
function abandoned(port: number, path: string, headers: Record<string, string | string[]>): () => void {
  const req = http.request({
    host: '127.0.0.1', port, method: 'POST', path, agent: false, headers: { 'content-length': '0', ...headers } as http.OutgoingHttpHeaders,
  });
  req.on('error', () => undefined);
  req.end();
  return () => { req.destroy(); };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), 'the server reached the step under test');
}

test('M6AA-C1 a client gone before the audited step: a login issues nothing; a logout still ends the session, and one line joins its record to the request', async () => {
  // Login: the client leaves while admission is still deciding.
  let admit!: () => void;
  const decided = new Promise<void>((resolve) => { admit = resolve; });
  let asked = false;
  const ops: string[] = [];
  const store = instrumented(ops);
  const admission = { admit: async (): Promise<unknown> => { asked = true; await decided; return ADMIT_PLATFORM; } };
  await withSessions({ admin: { store, admission } }, async ({ port, logs }) => {
    const drop = abandoned(port, ADMIN.login, { ...pre('admin'), authorization: 'Bearer tok-owner' });
    await until(() => asked);
    drop();
    assert.ok(await logged(logs, 'aborted'));
    admit();
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual(ops, [], 'no session nobody can receive, and no record');
    assert.equal(store.audits.length, 0);
  });
  // Pipelined: a login queued behind another on one connection is dispatched only once its response owns the socket
  // (app.ts), so one queued behind a dropped connection never reaches the handler; the first returns as above.
  let admitBoth!: () => void;
  const bothDecided = new Promise<void>((resolve) => { admitBoth = resolve; });
  let waiting = 0;
  const pipelinedOps: string[] = [];
  const pipelinedStore = instrumented(pipelinedOps);
  const slow = { admit: async (): Promise<unknown> => { waiting += 1; await bothDecided; return ADMIT_PLATFORM; } };
  await withSessions({ admin: { store: pipelinedStore, admission: slow } }, async ({ port }) => {
    const head = Object.entries({ host: `127.0.0.1:${port}`, ...pre('admin'), authorization: 'Bearer tok-owner', 'content-length': '0' })
      .map(([name, value]) => `${name}: ${String(value)}\r\n`).join('');
    const request = `POST ${ADMIN.login} HTTP/1.1\r\n${head}\r\n`;
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.write(request + request);
    await until(() => waiting === 1);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    admitBoth();
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(waiting, 1, 'the queued login was never dispatched');
    assert.deepEqual(pipelinedOps, [], 'neither login issues a session');
    assert.equal(pipelinedStore.audits.length, 0);
  });
  // Logout: the client leaves while the chain is reading its session.
  const base = instrumented([]);
  let gate: Promise<void> | null = null;
  let release!: () => void;
  let reading = false;
  const gated: MemorySessionStore = {
    ...base,
    get: async (key, signal) => {
      if (gate !== null) { reading = true; await gate; }
      return base.get(key, signal);
    },
  };
  await withSessions({ admin: { store: gated } }, async ({ port, logs }) => {
    const s = await signIn(port, 'admin', 'tok-owner');
    gate = new Promise<void>((resolve) => { release = resolve; });
    const drop = abandoned(port, ADMIN.logout, unsafe('admin', s));
    await until(() => reading);
    drop();
    assert.ok(await logged(logs, 'aborted'));
    gate = null;
    release();
    assert.ok(await loggedWith(logs, 'event', 'session_logout_after_close'), 'revocation does not wait on a listener');
    assert.equal(logs.filter((l) => (JSON.parse(l) as Record<string, unknown>).event === 'session_logout_after_close').length, 1, 'exactly one');
    const [line] = await linesOf(logs, ADMIN.logout, 1);
    const join = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.event === 'session_logout_after_close');
    const record = gated.audits.at(-1);
    assert.equal(record?.entry.action, 'logout');
    assert.equal(line.operationId, undefined, 'the request line was written at the close, before the id existed');
    assert.deepEqual([join?.level, join?.requestId, join?.operationId], ['info', line.requestId, record?.entry.operationId], 'one line joins them');
    assertRefusal(await current(port, 'admin', s.id), 401, 'unauthenticated', 'the session is ended all the same');
  });
});

// --- the tenant session, ordered and audited (M5-TENANT-SESSION-P1) ---------------------------------

const tenantReauth = (port: number, token: string, id: string): Promise<Reply> =>
  login(port, 'tenant', token, { ...cookie('tenant', id), [REAUTHENTICATE_HEADER]: REAUTHENTICATE_VALUE });

test('M5T-L1 a tenant login records the actor its admission names: none, or one that is not a lowercase UUID, is a 503 before anything is read or written', async () => {
  const ops: string[] = [];
  const store = instrumented(ops);
  let answer: unknown = ADMIT;
  await withSessions({ tenant: { store, admission: { admit: () => answer } } }, async ({ port, logs }) => {
    const member = await signIn(port, 'tenant', 'tok-member');
    assert.equal(store.audits[0].entry.actor, TENANT_ACTOR, 'the control: the named actor is recorded');
    ops.length = 0;
    const invalid: Array<[string, unknown]> = [
      ['an uppercase UUID', TENANT_ACTOR.toUpperCase()], ['a provider uid', 'uid-member'], ['a number', 7], ['an object', { actor: TENANT_ACTOR }],
    ];
    for (const [label, actor] of [['absent', undefined], ['null', null], ...invalid] as Array<[string, unknown]>) {
      answer = { admitted: true, securityVersion: 'v1', ...(actor === undefined ? {} : { actor }) };
      for (const r of [await login(port, 'tenant', 'tok-member-again', cookie('tenant', member.id)), await tenantReauth(port, 'tok-member-again', member.id)]) {
        assertRefusal(r, 503, 'service_unavailable', `an actor ${label}`);
        assert.equal(r.headers['www-authenticate'], undefined, `${label}: a faulty adapter is an outage, not a credential verdict`);
      }
    }
    assert.deepEqual(ops, [], 'nothing read, created, ended or revoked');
    assert.equal(store.audits.length, 1, 'nothing recorded');
    assert.ok(await logged(logs, 'admission_unavailable'));
    // Only a login attributes: a session request is served on an admission naming no actor, but one naming a malformed
    // actor is a faulty adapter there too — a 503 that revokes nothing.
    answer = { admitted: true, securityVersion: 'v1' };
    assert.equal((await current(port, 'tenant', member.id)).status, 200, 'no actor named');
    for (const [label, actor] of invalid) {
      answer = { ...ADMIT, actor };
      assertRefusal(await current(port, 'tenant', member.id), 503, 'service_unavailable', `a session request, an actor ${label}`);
    }
    assert.ok(!ops.some((op) => op === 'revoke' || op === 'revokePrincipal'), 'nothing revoked');
    answer = ADMIT;
    assert.equal((await current(port, 'tenant', member.id)).status, 200, 'the presented session was never touched');
  });
});

test('M5T-L2 a tenant login is judged where it writes: session_ended and standing_changed are a generic 401 writing nothing; any other answer a 503', async () => {
  const ops: string[] = [];
  const base = instrumented(ops);
  const scripted: { answer?: unknown; on: boolean } = { on: false };
  const store: MemorySessionStore = {
    ...base,
    establish: (key, record, replaces, audit, signal) => {
      if (!scripted.on) return base.establish(key, record, replaces, audit, signal);
      ops.push('establish');
      return Promise.resolve(scripted.answer);
    },
  };
  await withSessions({ tenant: { store } }, async ({ port, logs }) => {
    const member = await signIn(port, 'tenant', 'tok-member');
    const before = await recordOf(store, member.id);
    scripted.on = true;
    const cases: Array<[string, unknown, () => Promise<Reply>, number, string]> = [
      ['a recent sign-in whose presented session was ended first', 'session_ended', () => tenantReauth(port, 'tok-member-again', member.id), 401, 'login_reauth_no_session'],
      ['a login whose standing moved', 'standing_changed', () => login(port, 'tenant', 'tok-member-again', cookie('tenant', member.id)), 401, 'login_standing_changed'],
      ['a recent sign-in whose standing moved', 'standing_changed', () => tenantReauth(port, 'tok-member-again', member.id), 401, 'login_standing_changed'],
      ['an ordinary login answered session_ended', 'session_ended', () => login(port, 'tenant', 'tok-member-again'), 503, 'session_unavailable'],
      ['an unknown word', 'ESTABLISHED', () => login(port, 'tenant', 'tok-member-again'), 503, 'session_unavailable'],
    ];
    for (const [label, answer, attempt, status, reason] of cases) {
      scripted.answer = answer;
      ops.length = 0;
      const r = await attempt();
      assertRefusal(r, status, status === 401 ? 'unauthenticated' : 'service_unavailable', label);
      assert.equal(r.headers['www-authenticate'], status === 401 ? 'Bearer' : undefined, label);
      assert.deepEqual(writes(ops), ['establish'], `${label}: the one store step, and no revocation of the principal`);
      assert.ok(await logged(logs, reason), `${label}: ${reason}`);
    }
    scripted.on = false;
    assert.equal(store.audits.length, 1, 'nothing recorded beyond the first sign-in');
    assert.deepEqual(await recordOf(store, member.id), before, 'the presented session is exactly as it was');
  });
  // A logout that takes effect between the handler's read of the presented session and the store's step: the recent
  // sign-in creates nothing (F1/K3), because the store must end what it presents.
  const memory = createMemorySessionStore();
  const race = { on: false };
  const racing: MemorySessionStore = {
    ...memory,
    establish: (key, record, replaces, audit, signal) => {
      if (race.on && replaces !== null) memory.revoke(replaces, signal);
      return memory.establish(key, record, replaces, audit, signal);
    },
  };
  await withSessions({ tenant: { store: racing } }, async ({ port, logs }) => {
    const member = await signIn(port, 'tenant', 'tok-member');
    race.on = true;
    const r = await tenantReauth(port, 'tok-member-again', member.id);
    assertRefusal(r, 401, 'unauthenticated', 'the presented session ended first');
    assert.ok(await logged(logs, 'login_reauth_no_session'));
    assert.equal(memory.audits.length, 1, 'no recent sign-in recorded');
  });
});

test('M5T-L3 a tenant logout ends the session with its record; nothing live is logout_session_absent; a failed record takes the plain revocation', async () => {
  const ops: string[] = [];
  const failing: { op?: string | readonly string[] } = {};
  const store = instrumented(ops, failing);
  await withSessions({ tenant: { store } }, async ({ port, logs }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    ops.length = 0;
    const out = await send(port, 'POST', TENANT.logout, unsafe('tenant', s));
    assert.equal(out.status, 204);
    assert.deepEqual(ops, ['get', 'end'], 'one audited call — no plain revoke');
    assert.deepEqual(masked(store.audits[1]), { entry: { action: 'logout', operationId: '-', actor: null, authenticatedAt: null }, key: keyOf(s.id), replaced: null });
    // The audited end fails: revocation outranks the record, and the log says so.
    const t = await signIn(port, 'tenant', 'tok-member');
    failing.op = 'end';
    ops.length = 0;
    const fallback = await send(port, 'POST', TENANT.logout, unsafe('tenant', t));
    assert.equal(fallback.status, 204);
    assert.equal(setCookieOf(fallback).value, '');
    assert.deepEqual(ops, ['get', 'end', 'revoke']);
    failing.op = undefined;
    assertRefusal(await current(port, 'tenant', t.id), 401, 'unauthenticated', 'ended all the same');
    const lines = await linesOf(logs, TENANT.logout, 2);
    assert.equal(lines[1].reason, 'logout_audit_unconfirmed');
    assert.equal(warningsOf(logs).length, 1);
    assert.equal(store.audits.length, 3, 'two logins and one logout recorded');
  });
  // Nothing live to end (another logout or a revocation got there first): 204, recorded nothing (F2/K4).
  const base = createMemorySessionStore();
  await withSessions({ tenant: { store: { ...base, end: () => 'absent' } } }, async ({ port, logs }) => {
    const s = await signIn(port, 'tenant', 'tok-member');
    assert.equal((await send(port, 'POST', TENANT.logout, unsafe('tenant', s))).status, 204);
    assert.equal((await linesOf(logs, TENANT.logout, 1))[0].reason, 'logout_session_absent');
    assert.equal(base.audits.length, 1);
  });
});
