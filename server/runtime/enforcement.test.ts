// Phase 4.0 M3 — shared enforced runtime middleware: real-socket chain contract.
//
// Every assertion crosses a real loopback socket (127.0.0.1, ephemeral port) into
// createApp. Synthetic routes are mounted through the SAME route table and chain
// the production entry uses; the production table itself stays operational-only.
// Identities are synthetic and the ports are in-process fakes, except where an
// EXISTING abstraction is wired in — the DEV AuthAdapter seams (handed only the
// header-only credential view, so they fail closed) and the unchanged trusted-scope
// membership gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Response } from 'express';
import { createApp, createReadinessState, createBoundedServer } from './app.js';
import type { AppDeps } from './app.js';
import type { BearerTokenView, RequestAuthenticator } from './access.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import type { DistributedRateLimiter, RateLimitRequest } from './rateLimit.js';
import { createMemoryRateLimiter, testRequestLimits } from './rateLimiter.testkit.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import { EnforcementSetupError } from './routes.js';
import type { AuthorizationRequirement, RouteDefinition, VerifiedPrincipal } from './routes.js';
import { stubFirebaseAuthAdapter, devDiagnosticAuthAdapter } from '../platform-identity/authAdapter.js';
import { isScopeBackedByActiveMembership } from '../platform-identity/authorizationRepository.js';
import type { MembershipSnapshot } from '../platform-identity/authorizationResolver.js';

const silent = { log: (): void => {} };
const TRUSTED = 'http://pos.trusted.test';
const CSRF_OK = { origin: TRUSTED, [CSRF_HEADER]: CSRF_HEADER_VALUE, 'sec-fetch-site': 'same-origin' };
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// --- transport helpers --------------------------------------------------------

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** One request on its own connection (agent: false) so no socket outlives it. */
function send(port: number, method: string, path: string, headers: Record<string, string | string[]> = {}): Promise<Reply> {
  // An explicit zero length keeps a bodyless unsafe request from being sent chunked.
  const framed = method === 'GET' || method === 'HEAD' ? headers : { 'content-length': '0', ...headers };
  return new Promise((resolve, reject) => {
    // Cast: @types/node narrows `authorization` to a single string, but a duplicated
    // header line (sent as an array) is exactly what one test must put on the wire.
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: framed as http.OutgoingHttpHeaders, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw loopback exchange for a request a well-behaved client will not send. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.on('data', (d) => { text += d.toString('latin1'); });
    socket.on('close', () => { clearTimeout(timer); resolve(text); });
    socket.on('error', () => {});
  });
}

/** Status and lower-cased headers parsed from a raw HTTP/1.1 response head. */
function rawHead(text: string): { status: number; headers: Record<string, string> } {
  const [statusLine, ...lines] = text.split('\r\n\r\n')[0].split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1] ?? 0), headers };
}

interface Harness { port: number; logs: string[] }

/** Serve createApp on 127.0.0.1:<ephemeral> for `fn`; always closes server and sockets. */
async function withApp(deps: Partial<AppDeps>, fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: { log: (line: string) => { logs.push(line); } }, ...deps });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ port: (server.address() as AddressInfo).port, logs });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** Request-log records once `count` have flushed ('finish' may trail the reply slightly). */
async function requestLogs(logs: string[], count: number): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 200 && logs.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.event === 'request');
}

function assertRefusal(r: Reply, status: number, error: string, label = ''): void {
  assert.equal(r.status, status, `${label} ${r.body}`);
  const body = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], label);
  assert.equal(body.error, error, label);
  assert.equal(body.requestId, r.headers['x-request-id'], label);
}

function assertPolicyHeaders(headers: Record<string, unknown>, label: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(headers[name.toLowerCase()], value, `${label}: ${name}`);
  }
  assert.equal(headers['x-powered-by'], undefined, `${label}: X-Powered-By`);
}

// --- synthetic identities, memberships and ports ---------------------------------

const IDENTITIES: Record<string, unknown> = {
  'tok-platform-admin': {
    authProvider: 'supabase', authProviderUid: 'uid-platform-admin', verified: true,
    email: 'admin@example.test', scope: { scopeType: 'platform' },
  },
  'tok-tenant-member': { authProvider: 'supabase', authProviderUid: 'uid-tenant-member', verified: true },
  'tok-suspended-admin': { authProvider: 'firebase', authProviderUid: 'uid-suspended-admin', verified: true },
  'tok-unverified': { authProvider: 'supabase', authProviderUid: 'uid-platform-admin' },
  'tok-verified-false': { authProvider: 'supabase', authProviderUid: 'uid-platform-admin', verified: false },
  // A provider UID is opaque (any 1–128 characters), so only an oversized one is malformed.
  'tok-bad-uid': { authProvider: 'supabase', authProviderUid: 'u'.repeat(129), verified: true },
  'tok-empty-uid': { authProvider: 'supabase', authProviderUid: '', verified: true },
  // The chain checks the provider is a bounded token, not a named allowlist: provider
  // names may not appear in the runtime artifact (production-runtime contract), and the
  // identity lookup behind the authorizer is keyed by provider + subject anyway.
  'tok-bad-provider': { authProvider: 'Not A Provider', authProviderUid: 'uid-platform-admin', verified: true },
  'tok-no-provider': { authProviderUid: 'uid-platform-admin', verified: true },
  'tok-not-object': 'uid-platform-admin',
};

const membership = (
  uid: string,
  scope_type: MembershipSnapshot['scope_type'],
  status: MembershipSnapshot['status'],
  tenant_id: string | null = null,
): MembershipSnapshot => ({
  membership_id: `m-${uid}`, internal_user_id: `iu-${uid}`, tenant_id, store_id: null,
  scope_type, role_id: 'synthetic_role', status,
});

const MEMBERSHIPS: Record<string, MembershipSnapshot[]> = {
  'uid-platform-admin': [membership('uid-platform-admin', 'platform', 'active')],
  'uid-tenant-member': [membership('uid-tenant-member', 'tenant', 'active', 'tenant-1')],
  'uid-suspended-admin': [membership('uid-suspended-admin', 'platform', 'suspended')],
};

function tokenAuthenticator(): { calls: number; verify(tokenView: BearerTokenView): Promise<unknown> } {
  const a = {
    calls: 0,
    async verify(tokenView: BearerTokenView): Promise<unknown> {
      a.calls++;
      return IDENTITIES[tokenView.bearerToken] ?? null;
    },
  };
  return a;
}

/** The EXISTING trusted-scope gate, fed synthetic memberships instead of the database. */
function membershipAuthorizer(): { calls: number; authorize(p: VerifiedPrincipal, r: AuthorizationRequirement): boolean } {
  const a = {
    calls: 0,
    authorize(principal: VerifiedPrincipal, requirement: AuthorizationRequirement): boolean {
      a.calls++;
      return isScopeBackedByActiveMembership({ scopeType: requirement.scope }, MEMBERSHIPS[principal.authProviderUid] ?? []);
    },
  };
  return a;
}

// --- synthetic routes (test-only; never part of the production table) -------------

const READ = { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.read' } } as const;
const WRITE = { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.write' } } as const;
const NONE = { kind: 'none' } as const;

interface Hits { open: number; secret: number; secureSubmit: number; principal: unknown }
const newHits = (): Hits => ({ open: 0, secret: 0, secureSubmit: 0, principal: undefined });

function probeRoutes(hits: Hits, extra: RouteDefinition[] = []): RouteDefinition[] {
  const ok = (res: Response): void => { res.status(200).json({ ok: true }); };
  return [
    { method: 'GET', path: '/v1/open', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: (_q, res, ctx) => { hits.open++; hits.principal = ctx.principal; ok(res); } },
    { method: 'GET', path: '/v1/open/secret', policy: READ, body: NONE, idempotency: 'none', handler: (_q, res, ctx) => { hits.secret++; hits.principal = ctx.principal; ok(res); } },
    { method: 'POST', path: '/v1/secure-submit', policy: WRITE, body: NONE, idempotency: 'none', handler: (_q, res) => { hits.secureSubmit++; ok(res); } },
    ...extra,
  ];
}

function chain(hits: Hits, over: Partial<AppDeps> = {}, extra: RouteDefinition[] = []) {
  const authenticator = tokenAuthenticator();
  const authorizer = membershipAuthorizer();
  const deps: Partial<AppDeps> = {
    routes: probeRoutes(hits, extra), authenticator, authorizer, trustedOrigins: [TRUSTED], limits: testRequestLimits(), ...over,
  };
  return { authenticator, authorizer, deps };
}

// --- authentication ----------------------------------------------------------------

test('a public route is reachable without authentication and never receives a principal', async () => {
  const hits = newHits();
  const { authenticator, deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    assert.equal((await send(port, 'GET', '/health')).status, 200);
    assert.equal((await send(port, 'GET', '/v1/open')).status, 200);
    assert.equal((await send(port, 'GET', '/v1/open', bearer('tok-platform-admin'))).status, 200);
    assert.equal(hits.open, 2);
    assert.equal(hits.principal, null, 'a public route ignores any credential');
    assert.equal(authenticator.calls, 0, 'a public route never consults the authenticator');
  });
});

test('a protected route without credentials is 401 and never reaches its handler', async () => {
  const hits = newHits();
  const { authenticator, deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    const r = await send(port, 'GET', '/v1/open/secret');
    assertRefusal(r, 401, 'unauthenticated');
    assert.equal(r.headers['www-authenticate'], 'Bearer');
    assert.equal(hits.secret, 0);
    assert.equal(authenticator.calls, 0);
  });
});

test('malformed or contradictory credentials are 401 before the authenticator runs', async () => {
  const hits = newHits();
  const { authenticator, deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    for (const authorization of [
      'Basic dXNlcjpwYXNz', 'Bearer', 'Token tok-platform-admin', 'Bearer  tok-platform-admin',
      'Bearer tok-platform-admin extra', 'Bearer tok"platform', `Bearer ${'a'.repeat(4097)}`,
      ['Bearer tok-platform-admin', 'Bearer tok-platform-admin'],
      ['Bearer tok-platform-admin', 'Bearer tok-tenant-member'],
    ]) {
      assertRefusal(await send(port, 'GET', '/v1/open/secret', { authorization }), 401, 'unauthenticated', String(authorization).slice(0, 40));
    }
    assert.equal(hits.secret, 0);
    assert.equal(authenticator.calls, 0, 'structurally invalid evidence never reaches the authenticator');
  });
});

test('a credential that does not yield a verified, well-formed principal is 401', async () => {
  const hits = newHits();
  const { authenticator, deps } = chain(hits);
  const tokens = [
    'tok-unknown', 'tok-unverified', 'tok-verified-false', 'tok-bad-uid', 'tok-empty-uid',
    'tok-bad-provider', 'tok-no-provider', 'tok-not-object',
  ];
  await withApp(deps, async ({ port }) => {
    for (const token of tokens) {
      assertRefusal(await send(port, 'GET', '/v1/open/secret', bearer(token)), 401, 'unauthenticated', token);
    }
    assert.equal(hits.secret, 0);
    assert.equal(authenticator.calls, tokens.length, 'each well-formed credential is verified exactly once');
  });
});

test('the DEV AuthAdapter seams, handed only the credential view, fail closed without leaking', async () => {
  // The stub throws, which is an unavailable verifier (503); the DEV adapter finds no asserted
  // actor in the credential view, which is a rejected credential (401).
  const seams = [[stubFirebaseAuthAdapter, 503, 'service_unavailable'], [devDiagnosticAuthAdapter, 401, 'unauthenticated']] as const;
  for (const [adapter, status, error] of seams) {
    const hits = newHits();
    // Cast: these seams read the raw request, but a port is only ever handed the header-only
    // credential view and the deadline signal.
    const { deps } = chain(hits, { authenticator: adapter as unknown as RequestAuthenticator });
    await withApp(deps, async ({ port, logs }) => {
      const r = await send(port, 'GET', '/v1/open/secret', bearer('tok-platform-admin'));
      assertRefusal(r, status, error, adapter.name);
      assert.equal(hits.secret, 0);
      await requestLogs(logs, 1);
      const seen = `${r.body}\n${logs.join('\n')}`;
      for (const leak of ['not implemented', 'Firebase', 'firebase_verification', 'tok-platform-admin']) {
        assert.ok(!seen.includes(leak), `${adapter.name} leaked ${leak}`);
      }
    });
  }
});

// --- authorization -----------------------------------------------------------------

test('an authenticated principal the trusted-scope gate does not back is 403 and never reaches its handler', async () => {
  const hits = newHits();
  const { authorizer, deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    assertRefusal(await send(port, 'GET', '/v1/open/secret', bearer('tok-tenant-member')), 403, 'forbidden', 'tenant-only member');
    assertRefusal(await send(port, 'GET', '/v1/open/secret', bearer('tok-suspended-admin')), 403, 'forbidden', 'suspended membership');
    assert.equal(hits.secret, 0);
    assert.equal(authorizer.calls, 2);
  });
});

test('only an authorizer result of exactly true allows; any other value is 403, and a failing authorizer a bounded 503', async () => {
  const decisions: Array<[() => unknown, number, string]> = [
    [() => 'true', 403, 'forbidden'], [() => 1, 403, 'forbidden'], [() => ({}), 403, 'forbidden'],
    [() => Promise.resolve('yes'), 403, 'forbidden'],
    [() => { throw new Error('authz-backend-secret-detail'); }, 503, 'service_unavailable'],
    [() => Promise.reject(new Error('authz-backend-secret-detail')), 503, 'service_unavailable'],
  ];
  for (const [decide, status, error] of decisions) {
    const hits = newHits();
    const { deps } = chain(hits, { authorizer: { authorize: decide } });
    await withApp(deps, async ({ port, logs }) => {
      const r = await send(port, 'GET', '/v1/open/secret', bearer('tok-platform-admin'));
      assertRefusal(r, status, error);
      assert.equal(hits.secret, 0);
      await requestLogs(logs, 1);
      assert.ok(!`${r.body}${logs.join('')}`.includes('secret-detail'), 'no authorizer error text escapes');
    });
  }
  const allowed = newHits();
  const { deps } = chain(allowed, { authorizer: { authorize: () => Promise.resolve(true) } });
  await withApp(deps, async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open/secret', bearer('tok-platform-admin'))).status, 200, 'an async exact true allows');
    assert.equal(allowed.secret, 1);
  });
});

test('an authorized request reaches its handler exactly once with a minimal, frozen principal', async () => {
  const hits = newHits();
  const { authenticator, authorizer, deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open/secret', bearer('tok-platform-admin'))).status, 200);
    assert.equal(hits.secret, 1);
    assert.deepEqual(hits.principal, { authProvider: 'supabase', authProviderUid: 'uid-platform-admin' },
      'asserted email/scope never reach the handler');
    assert.ok(Object.isFrozen(hits.principal));
    assert.equal(authenticator.calls, 1);
    assert.equal(authorizer.calls, 1);
    // RFC 7235: the auth-scheme is case-insensitive.
    assert.equal((await send(port, 'GET', '/v1/open/secret', { authorization: 'bearer tok-platform-admin' })).status, 200);
    assert.equal(hits.secret, 2);
  });
});

// --- CSRF / origin --------------------------------------------------------------------

test('an unsafe request without valid CSRF evidence is 403, and CSRF runs before authentication', async () => {
  const hits = newHits();
  const { authenticator, deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    const admin = bearer('tok-platform-admin');
    for (const headers of [
      {}, { origin: TRUSTED }, { origin: TRUSTED, [CSRF_HEADER]: '0' },
      { ...CSRF_OK, [CSRF_HEADER]: [CSRF_HEADER_VALUE, CSRF_HEADER_VALUE] },
    ]) {
      assertRefusal(await send(port, 'POST', '/v1/secure-submit', { ...headers, ...admin }), 403, 'forbidden', JSON.stringify(headers));
    }
    assert.equal(hits.secureSubmit, 0);
    assert.equal(authenticator.calls, 0, 'a CSRF refusal happens before any credential is examined');
    assertRefusal(await send(port, 'POST', '/v1/secure-submit', CSRF_OK), 401, 'unauthenticated', 'CSRF ok, no token');
    assert.equal((await send(port, 'POST', '/v1/secure-submit', { ...CSRF_OK, ...admin })).status, 200);
    assert.equal(hits.secureSubmit, 1);
  });
});

test('an unsafe request from an untrusted, malformed or cross-site origin is 403', async () => {
  const hits = newHits();
  const { deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    for (const origin of ['http://evil.test', 'http://pos.trusted.test.evil.test', `${TRUSTED}/`, 'null', 'https://pos.trusted.test']) {
      assertRefusal(await send(port, 'POST', '/v1/secure-submit', { ...CSRF_OK, origin, ...bearer('tok-platform-admin') }), 403, 'forbidden', origin);
    }
    const crossSite = { ...CSRF_OK, 'sec-fetch-site': 'cross-site', ...bearer('tok-platform-admin') };
    assertRefusal(await send(port, 'POST', '/v1/secure-submit', crossSite), 403, 'forbidden', 'cross-site');
    assert.equal(hits.secureSubmit, 0);
  });
});

test('safe methods are CSRF-exempt by policy: a cross-site GET still goes through authentication and authorization', async () => {
  const hits = newHits();
  const { deps } = chain(hits);
  const crossSite = { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' };
  await withApp(deps, async ({ port }) => {
    assertRefusal(await send(port, 'GET', '/v1/open/secret', crossSite), 401, 'unauthenticated', 'reaches authN, not a CSRF 403');
    assert.equal((await send(port, 'GET', '/v1/open/secret', { ...crossSite, ...bearer('tok-platform-admin') })).status, 200);
    assert.equal(hits.secret, 1);
  });
});

// --- rate limiting --------------------------------------------------------------------

/** A distributed limiter tightened to `limit` per bucket (default clock, or an injected one). */
const tight = (limit: number, now?: () => number): DistributedRateLimiter => {
  const m = createMemoryRateLimiter(now ? { now } : {});
  return { consume: (r: RateLimitRequest, s: AbortSignal) => m.consume({ ...r, limit }, s), probe: () => true };
};

test('the rate limit refuses with 429 and a bounded Retry-After, and never runs the handler', async () => {
  const hits = newHits();
  const { deps } = chain(hits, { limits: testRequestLimits({ limiter: tight(2) }) });
  await withApp(deps, async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open')).status, 200);
    assert.equal((await send(port, 'GET', '/v1/open')).status, 200);
    const r = await send(port, 'GET', '/v1/open');
    assertRefusal(r, 429, 'rate_limited');
    const retryAfter = String(r.headers['retry-after']);
    assert.match(retryAfter, /^[1-9][0-9]*$/);
    assert.ok(Number(retryAfter) <= 60, retryAfter);
    assert.equal(hits.open, 2);
  });
});

test('the rate-limit window resets on the injected clock', async () => {
  let clock = 5_000_000;
  const hits = newHits();
  const { deps } = chain(hits, { limits: testRequestLimits({ limiter: tight(1, () => clock) }) });
  await withApp(deps, async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open')).status, 200);
    const refused = await send(port, 'GET', '/v1/open');
    assert.equal(refused.status, 429);
    assert.equal(refused.headers['retry-after'], '60');
    clock += 45_000;
    assert.equal((await send(port, 'GET', '/v1/open')).headers['retry-after'], '15');
    clock += 15_000;
    assert.equal((await send(port, 'GET', '/v1/open')).status, 200, 'the next window admits again');
  });
});

test('one limit covers protected, unsafe and unknown paths, ahead of admission, CSRF and authentication, and never the probes', async () => {
  const hits = newHits();
  const { deps } = chain(hits, { limits: testRequestLimits({ limiter: tight(1) }) });
  await withApp(deps, async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open')).status, 200, 'spend the one unit');
    assertRefusal(await send(port, 'GET', '/v1/open/secret', bearer('tok-platform-admin')), 429, 'rate_limited', 'protected');
    assertRefusal(await send(port, 'POST', '/v1/secure-submit', { ...CSRF_OK, ...bearer('tok-platform-admin') }), 429, 'rate_limited', 'unsafe');
    assertRefusal(await send(port, 'GET', '/nope'), 429, 'rate_limited', 'unknown path');
    assert.equal((await send(port, 'GET', '/health')).status, 200, 'the health probe never touches the limiter');
    assert.equal((await send(port, 'GET', '/readiness')).status, 200, 'the readiness probe never touches the limiter');
    assert.equal(hits.secret + hits.secureSubmit, 0);
  });
});

test('forwarding headers from an untrusted peer cannot evade the limit', async () => {
  const { deps } = chain(newHits(), { limits: testRequestLimits({ limiter: tight(2) }) });
  await withApp(deps, async ({ port }) => {
    const statuses: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const spoof = `198.51.100.${i}`;
      statuses.push((await send(port, 'GET', '/v1/open', {
        'x-forwarded-for': spoof, forwarded: `for=${spoof}`, 'x-real-ip': spoof,
        'true-client-ip': spoof, 'cf-connecting-ip': spoof,
      })).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

// --- security headers and failure handling ------------------------------------------

test('every response class carries the full, closed security-header policy', async () => {
  assert.ok(Object.isFrozen(SECURITY_HEADERS));
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-|\*|data:|blob:/, 'no unsafe CSP directive');

  let limited = false;
  const asyncLimiter: DistributedRateLimiter = {
    async consume(r: RateLimitRequest) { return limited ? { outcome: 'limited', retryAfterMs: 6_500 } : { outcome: 'allowed', remaining: r.limit - 1 }; },
    probe: () => true,
  };
  const boom: RouteDefinition = { method: 'GET', path: '/v1/boom', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: () => { throw new Error('boom'); } };
  const { deps } = chain(newHits(), { limits: testRequestLimits({ limiter: asyncLimiter }) }, [boom]);
  await withApp(deps, async ({ port }) => {
    const cases: Array<[string, number, () => Promise<Reply>]> = [
      ['operational 200', 200, () => send(port, 'GET', '/health')],
      ['route 200', 200, () => send(port, 'GET', '/v1/open')],
      ['401', 401, () => send(port, 'GET', '/v1/open/secret')],
      ['403 authz', 403, () => send(port, 'GET', '/v1/open/secret', bearer('tok-tenant-member'))],
      ['403 csrf', 403, () => send(port, 'POST', '/v1/secure-submit', bearer('tok-platform-admin'))],
      ['404 unknown', 404, () => send(port, 'GET', '/nope')],
      ['404 method', 404, () => send(port, 'POST', '/health', CSRF_OK)],
      ['500', 500, () => send(port, 'GET', '/v1/boom')],
    ];
    for (const [label, status, run] of cases) {
      const r = await run();
      assert.equal(r.status, status, label);
      assertPolicyHeaders(r.headers, label);
    }
    const bodiedText = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello');
    const bodied = rawHead(bodiedText);
    assert.equal(bodied.status, 400);
    assertPolicyHeaders(bodied.headers, '400');
    assert.match(bodiedText, /"error":"invalid_request"/);
    limited = true;
    const r = await send(port, 'GET', '/v1/open');
    assert.equal(r.status, 429, 'an async (replaceable) limiter is awaited');
    assert.equal(r.headers['retry-after'], '7');
    assertPolicyHeaders(r.headers, '429');
  });
});

test('a handler cannot remove or override a mandatory security header', async () => {
  const tamper: RouteDefinition[] = [
    { method: 'GET', path: '/v1/tamper-object', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: (_q, res) => {
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', 'default-src *');
      res.writeHead(200, { 'X-Frame-Options': 'ALLOWALL', 'content-security-policy': "script-src 'unsafe-inline'", 'x-probe': 'kept' });
      res.end('{}');
    } },
    { method: 'GET', path: '/v1/tamper-array', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: (_q, res) => {
      res.writeHead(200, ['X-Content-Type-Options', 'sniff', 'Cache-Control', 'public, max-age=86400', 'x-probe', 'kept']);
      res.end('{}');
    } },
    { method: 'GET', path: '/v1/tamper-trailing', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: (_q, res) => {
      // Node takes the header map from the SECOND argument when the third is undefined.
      (res.writeHead as unknown as (...args: unknown[]) => void)(200, { 'X-Frame-Options': 'ALLOWALL', 'x-probe': 'kept' }, undefined);
      res.end('{}');
    } },
    { method: 'GET', path: '/v1/tamper-message', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: (_q, res) => {
      (res.writeHead as unknown as (...args: unknown[]) => void)(200, 'OK', { 'Referrer-Policy': 'unsafe-url', 'x-probe': 'kept' }, undefined);
      res.end('{}');
    } },
    { method: 'GET', path: '/v1/tamper-json', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: (_q, res) => {
      for (const name of Object.keys(SECURITY_HEADERS)) res.removeHeader(name);
      res.setHeader('x-probe', 'kept');
      res.status(200).json({ ok: true });
    } },
  ];
  const { deps } = chain(newHits(), {}, tamper);
  await withApp(deps, async ({ port }) => {
    for (const { path } of tamper) {
      const r = await send(port, 'GET', path);
      assert.equal(r.status, 200, path);
      assertPolicyHeaders(r.headers, path);
      assert.equal(r.headers['x-probe'], 'kept', `${path}: a non-mandatory header is untouched`);
    }
  });
});

test('a throwing or rejecting handler fails closed with a bounded 500 and no leak', async () => {
  const boom: RouteDefinition[] = [
    { method: 'GET', path: '/v1/boom-sync', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: () => { throw new Error('secret-internal-detail'); } },
    { method: 'GET', path: '/v1/boom-async', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: async () => { throw new Error('secret-internal-detail'); } },
  ];
  const { deps } = chain(newHits(), {}, boom);
  await withApp(deps, async ({ port, logs }) => {
    for (const { path } of boom) {
      const r = await send(port, 'GET', path);
      assertRefusal(r, 500, 'internal_error', path);
      assertPolicyHeaders(r.headers, path);
    }
    const records = await requestLogs(logs, 2);
    assert.deepEqual(records.map((r) => r.reason), ['internal_error', 'internal_error'], 'a 500 logs its bounded reason');
    assert.ok(!logs.join('\n').includes('secret-internal-detail'));
  });
});

test('an unavailable limiter fails closed with a bounded 503 and never runs the handler', async () => {
  const limiters: Array<[string, DistributedRateLimiter]> = [
    ['throwing', { consume: () => { throw new Error('limiter-store-secret-detail'); }, probe: () => true }],
    ['unavailable outcome', { consume: async () => ({ outcome: 'unavailable' }), probe: () => true }],
  ];
  for (const [label, limiter] of limiters) {
    const hits = newHits();
    const { deps } = chain(hits, { limits: testRequestLimits({ limiter }) });
    await withApp(deps, async ({ port, logs }) => {
      const r = await send(port, 'GET', '/v1/open');
      assertRefusal(r, 503, 'service_unavailable', label);
      assertPolicyHeaders(r.headers, 'limiter 503');
      assert.equal(hits.open, 0);
      const records = await requestLogs(logs, 1);
      assert.deepEqual(records.map((rec) => rec.reason), ['rate_limit_unavailable'], label);
      assert.ok(!`${r.body}${logs.join('')}`.includes('secret-detail'), label);
      assert.equal((await send(port, 'GET', '/health')).status, 200, `${label}: the health probe still answers during the outage`);
    });
  }
});

test('a hanging authenticator, authorizer or limiter is cut off at the port deadline with a bounded 503', async () => {
  const signals: AbortSignal[] = [];
  const hang = (...args: unknown[]): Promise<never> => {
    signals.push(args[args.length - 1] as AbortSignal);
    return new Promise(() => {});
  };
  const cases: Array<[string, Partial<AppDeps>, string]> = [
    ['authenticator', { authenticator: { verify: hang } }, 'authn_timeout'],
    ['authorizer', { authorizer: { authorize: hang } }, 'authz_timeout'],
    ['limiter', { limits: testRequestLimits({ limiter: { consume: hang, probe: () => true } }) }, 'rate_limit_timeout'],
  ];
  for (const [label, over, reason] of cases) {
    const hits = newHits();
    const { deps } = chain(hits, { ...over, portDeadlineMs: 50 });
    await withApp(deps, async ({ port, logs }) => {
      const started = Date.now();
      const r = await send(port, 'GET', '/v1/open/secret', bearer('tok-platform-admin'));
      assertRefusal(r, 503, 'service_unavailable', label);
      assert.ok(Date.now() - started < 2_000, `${label}: bounded by the deadline, not the port`);
      assert.equal(signals.at(-1)?.aborted, true, `${label}: the port is told to cancel`);
      assert.equal(hits.secret, 0);
      const records = await requestLogs(logs, 1);
      assert.deepEqual(records.map((rec) => rec.reason), [reason], label);
    });
  }
});

test('an out-of-contract limiter answer is a 503, never an allowance or a guessed wait', async () => {
  const badAnswers: unknown[] = [
    { allowed: true }, { outcome: 'allowed', remaining: -1 }, { outcome: 'limited', retryAfterMs: 0 },
    { outcome: 'limited', retryAfterMs: 60_001 }, { outcome: 'limited', retryAfterMs: Number.NaN },
    { outcome: 'Allowed', remaining: 1 }, undefined, null,
  ];
  for (const answer of badAnswers) {
    const hits = newHits();
    const { deps } = chain(hits, { limits: testRequestLimits({ limiter: { consume: async () => answer, probe: () => true } }) });
    await withApp(deps, async ({ port, logs }) => {
      const r = await send(port, 'GET', '/v1/open');
      assertRefusal(r, 503, 'service_unavailable', JSON.stringify(answer));
      assert.equal(r.headers['retry-after'], undefined, JSON.stringify(answer));
      assert.equal(hits.open, 0);
      const records = await requestLogs(logs, 1);
      assert.deepEqual(records.map((rec) => rec.reason), ['rate_limit_outcome_invalid'], JSON.stringify(answer));
    });
  }
  const limited: Array<[number, string]> = [[1, '1'], [60_000, '60']];
  for (const [retryAfterMs, retryAfter] of limited) {
    const hits = newHits();
    const { deps } = chain(hits, {
      limits: testRequestLimits({ limiter: { consume: async () => ({ outcome: 'limited', retryAfterMs }), probe: () => true } }),
    });
    await withApp(deps, async ({ port }) => {
      const r = await send(port, 'GET', '/v1/open');
      assertRefusal(r, 429, 'rate_limited', String(retryAfterMs));
      assert.equal(r.headers['retry-after'], retryAfter, String(retryAfterMs));
      assert.equal(hits.open, 0);
    });
  }
});

test('a handler that fails after its response started is cut off without printing raw error text', async () => {
  const partial: RouteDefinition = { method: 'GET', path: '/v1/partial', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    throw new Error('secret-partial-detail');
  } };
  const { deps } = chain(newHits(), {}, [partial]);
  const printed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  try {
    await withApp(deps, async ({ port }) => {
      const text = await rawExchange(port, 'GET /v1/partial HTTP/1.1\r\nHost: x\r\n\r\n');
      assert.equal(rawHead(text).status, 200, 'the head was already on the wire');
      assert.ok(!text.includes('secret-partial-detail'));
    });
  } finally {
    console.error = original;
  }
  assert.ok(!printed.join('\n').includes('secret-partial-detail'), 'no raw error text reaches stderr');
});

test('a request-target that is not origin-form is refused before Express could skip the chain', async () => {
  await withApp({}, async ({ port }) => {
    for (const target of ['a://b', 'http://x/health']) {
      const text = await rawExchange(port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
      const head = rawHead(text);
      assert.equal(head.status, 400, target);
      assertPolicyHeaders(head.headers, target);
      assert.equal(head.headers.connection, 'close', target);
      assert.match(text, /"error":"invalid_request"/, target);
      assert.doesNotMatch(text, /Cannot GET|<html|<pre/i, target);
    }
    assert.equal((await send(port, 'GET', '/health')).status, 200, 'origin-form targets are still served');
  });
});

test('refusals log one bounded reason code, never a credential, principal or error text', async () => {
  const { deps } = chain(newHits());
  await withApp(deps, async ({ port, logs }) => {
    await send(port, 'GET', '/v1/open/secret');
    await send(port, 'GET', '/v1/open/secret', { authorization: 'Basic c2VjcmV0' });
    await send(port, 'GET', '/v1/open/secret', bearer('tok-leaky-secret-value'));
    await send(port, 'GET', '/v1/open/secret', bearer('tok-tenant-member'));
    await send(port, 'POST', '/v1/secure-submit', { ...CSRF_OK, origin: 'http://evil.test' });
    // Host goes first: Node keeps only the first 101 header lines, and a truncated-away
    // Host would draw Node's own transport 400 before the app ever saw the request.
    const padded = { host: `127.0.0.1:${port}`, ...Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`x-pad-${i}`, '1'])) };
    assert.equal((await send(port, 'GET', '/v1/open', padded)).status, 431);
    const records = await requestLogs(logs, 6);
    assert.deepEqual(records.map((r) => r.reason),
      ['authn_missing', 'authn_malformed', 'authn_rejected', 'authz_denied', 'csrf_origin_mismatch', 'request_header_fields_too_large']);
    const joined = logs.join('\n');
    for (const leak of ['tok-', 'c2VjcmV0', 'uid-', 'Bearer', 'evil.test', 'tenant-1']) {
      assert.ok(!joined.includes(leak), `log leaked ${leak}`);
    }
  });
});

// --- registration, admission and inventory -----------------------------------------------

test('startup fails closed on a route without policy metadata or an unconfigured chain', () => {
  const startupCode = (deps: Partial<AppDeps>): string | undefined => {
    try {
      createApp({ readiness: createReadinessState(), log: silent, ...deps });
    } catch (err) {
      return err instanceof EnforcementSetupError ? err.code : 'unexpected_error_type';
    }
    return undefined;
  };
  const guarded = { method: 'GET', path: '/v1/p', policy: READ, body: NONE, idempotency: 'none', handler: () => {} } as RouteDefinition;
  const unsafe = { method: 'POST', path: '/v1/u', policy: WRITE, body: NONE, idempotency: 'none', handler: () => {} } as RouteDefinition;
  const publicWrite = { method: 'POST', path: '/v1/u', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: () => {} } as RouteDefinition;
  assert.equal(startupCode({ routes: [publicWrite], trustedOrigins: [TRUSTED] }), 'route_public_unsafe');
  assert.equal(startupCode({ routes: [{ method: 'GET', path: '/v1/x', handler: () => {} } as unknown as RouteDefinition] }), 'route_policy_missing');
  assert.equal(startupCode({ routes: [{ method: 'GET', path: '/v1/x', policy: { access: 'public' }, handler: () => {} } as unknown as RouteDefinition] }), 'route_body_policy_missing');
  assert.equal(startupCode({ routes: [guarded] }), 'authenticator_required');
  assert.equal(startupCode({ routes: [guarded], authenticator: {} as never, authorizer: membershipAuthorizer() }), 'authenticator_required');
  assert.equal(startupCode({ routes: [guarded], authenticator: tokenAuthenticator() }), 'authorizer_required');
  assert.equal(startupCode({ routes: [guarded], authenticator: tokenAuthenticator(), authorizer: {} as never }), 'authorizer_required');
  assert.equal(startupCode({ routes: [unsafe], authenticator: tokenAuthenticator(), authorizer: membershipAuthorizer() }), 'trusted_origins_required');
  assert.equal(startupCode({ trustedOrigins: ['*'] }), 'trusted_origin_invalid');
  for (const portDeadlineMs of [0, -1, 1.5, 30_001, Number.NaN]) {
    assert.equal(startupCode({ portDeadlineMs }), 'port_deadline_invalid', `port deadline ${portDeadlineMs}`);
  }
  assert.equal(startupCode({ routes: [{ method: 'GET', path: '/health', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: () => {} }] }), 'route_duplicate');
  assert.equal(startupCode({
    routes: [guarded, unsafe], authenticator: tokenAuthenticator(), authorizer: membershipAuthorizer(), trustedOrigins: [TRUSTED],
  }), 'rate_limit_required');
  assert.equal(startupCode({
    routes: [guarded, unsafe], authenticator: tokenAuthenticator(), authorizer: membershipAuthorizer(), trustedOrigins: [TRUSTED],
    limits: testRequestLimits(),
  }), undefined);
});

test('similar prefixes, other methods, encodings and slash variants never inherit a public classification', async () => {
  const hits = newHits();
  const { deps } = chain(hits);
  await withApp(deps, async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open')).status, 200);
    assert.equal((await send(port, 'GET', '/v1/open/secret')).status, 401);
    for (const path of [
      '/v1/open/', '/V1/open', '/v1/openx', '/v1/ope', '//v1/open', '/v1//open', '/v1/open;x', '/v1/%6fpen',
      '/v1/open%2F', '/v1/open%2Fsecret', '/v1/open/./secret', '/v1/open/../open/secret', '/v1/./open',
      '/v1/open/secret/', '/v1/open/Secret', '/v1/open/secret%00',
    ]) {
      assert.equal((await send(port, 'GET', path)).status, 404, `GET ${path}`);
    }
    assert.equal((await send(port, 'GET', '/v1/open/secret?x=/v1/open')).status, 401, 'a query never changes the matched route');
    for (const method of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await send(port, method, '/v1/open', CSRF_OK)).status, 404, `${method} /v1/open`);
    }
    assert.equal(hits.open, 1, 'only the exact public request ran the public handler');
    assert.equal(hits.secret, 0);
  });
});

test('route inventory: the production table is operational-only and every route runs the shared chain', async () => {
  const app = createApp({ readiness: createReadinessState(), log: silent });
  const stack = (app as unknown as { _router: { stack: Array<{ name: string; route?: unknown }> } })._router.stack;
  assert.equal(stack.filter((layer) => layer.route !== undefined).length, 0, 'no Express route layer may bypass the chain');
  assert.deepEqual(stack.map((layer) => layer.name),
    ['query', 'expressInit', 'frame', 'enforce', 'notFoundHandler', 'errorHandler', 'abortStartedResponse']);
  const routes = app.locals.routes as Array<{ method: string; path: string; access: string; body: string; idempotency: string }>;
  assert.deepEqual(routes, [
    { method: 'GET', path: '/health', access: 'public', body: 'none', idempotency: 'none' },
    { method: 'GET', path: '/readiness', access: 'public', body: 'none', idempotency: 'none' },
  ]);
  for (const { method, path } of routes) {
    const refusals: Array<[string, DistributedRateLimiter['consume']]> = [
      ['always-limited', async () => ({ outcome: 'limited', retryAfterMs: 1 })],
      ['throwing', () => { throw new Error('limiter-secret-detail'); }],
    ];
    for (const [label, consume] of refusals) {
      let calls = 0;
      const limiter: DistributedRateLimiter = { consume: (...args) => { calls++; return consume(...args); }, probe: () => true };
      await withApp({ limits: testRequestLimits({ limiter }) }, async ({ port }) => {
        const first = await send(port, method, path);
        assert.equal(first.status, 200, `${label}: ${method} ${path}`);
        assertPolicyHeaders(first.headers, `${label}: ${path} 200`);
        const second = await send(port, method, path);
        assert.equal(second.status, 200, `${label}: ${method} ${path} (again)`);
        assertPolicyHeaders(second.headers, `${label}: ${path} 200 again`);
      });
      assert.equal(calls, 0, `${label}: ${method} ${path} never consults the limiter`);
    }
  }
});

test('the removed identity routes stay absent from the runtime', async () => {
  await withApp({ trustedOrigins: [TRUSTED] }, async ({ port }) => {
    assert.equal((await send(port, 'POST', '/identity/resolve', CSRF_OK)).status, 404);
    assert.equal((await send(port, 'GET', '/identity/by-uid?authProviderUid=synthetic-uid')).status, 404);
  });
  const app = createApp({ readiness: createReadinessState(), log: silent });
  const paths = (app.locals.routes as Array<{ path: string }>).map((r) => r.path);
  assert.ok(!paths.some((p) => p.startsWith('/identity')), 'no identity route is registered');
});
