// Phase 4.0 M3 — application-factory contract tests.
//
// The skeleton mounts ONLY liveness, readiness, and the bounded terminal
// 404/error path. Every response is bounded JSON with baseline security
// headers; no business route, no HTML error page, no stack/secret leakage.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  createApp, createReadinessState, createBoundedServer, HTTP_SERVER_LIMITS,
  classifyRoute, notFoundHandler, errorHandler,
} from './app.js';
import { EnforcementSetupError } from './routes.js';
import type { RouteDefinition } from './routes.js';
import type { DistributedRateLimiter } from './rateLimit.js';
import { testRequestLimits, TEST_RATE_LIMIT_KEY } from './rateLimiter.testkit.js';
import { createLifecycle } from './lifecycle.js';

const silent = { log: () => {} };

/** The baseline security headers every application-layer response must carry. */
const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/** Boot the app on an ephemeral loopback port for the duration of `fn`. */
async function withServer(
  app: http.RequestListener,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /health reports liveness as bounded, uncached JSON', async () => {
  const app = createApp({ readiness: createReadinessState(), log: silent });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const body = await res.json();
    assert.deepEqual(body, { status: 'alive' });
  });
});

test('GET /readiness is 503 before init and 200 after', async () => {
  const readiness = createReadinessState();
  const app = createApp({ readiness, log: silent });
  await withServer(app, async (base) => {
    const before = await fetch(`${base}/readiness`);
    assert.equal(before.status, 503);
    assert.deepEqual(await before.json(), { status: 'unavailable' });

    readiness.setReady();
    const after = await fetch(`${base}/readiness`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), { status: 'ready' });
  });
});

test('GET /readiness becomes unavailable again during shutdown', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/readiness`)).status, 200);
    readiness.setUnavailable();
    assert.equal((await fetch(`${base}/readiness`)).status, 503);
  });
});

test('an injected failing dependency check makes readiness 503', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent, dependencyChecks: [() => false] });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/readiness`)).status, 503);
  });
});

test('a dependency check that throws yields 503, not a 500 leak', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent, dependencyChecks: [() => { throw new Error('probe boom'); }] });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/readiness`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'unavailable' });
  });
});

test('a hanging dependency check is cut off at the port deadline and cancelled: readiness answers 503', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  let signal: AbortSignal | undefined;
  const app = createApp({
    readiness, log: silent, portDeadlineMs: 50,
    dependencyChecks: [(s?: AbortSignal) => { signal = s; return new Promise<boolean>(() => {}); }],
  });
  await withServer(app, async (base) => {
    const started = Date.now();
    const res = await fetch(`${base}/readiness`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'unavailable' });
    assert.ok(Date.now() - started < 2_000, 'the deadline, not the probe, ended the check');
    assert.equal(signal?.aborted, true, 'the probe is told to cancel');
  });
});

test('when unavailable, readiness returns 503 without awaiting a hanging dependency check', async () => {
  // Local readiness is checked FIRST: during shutdown (not ready) a hanging probe
  // must NOT delay the 503. The check below would never resolve if it were run.
  const readiness = createReadinessState(); // starts NOT ready
  let checkRan = false;
  const app = createApp({
    readiness, log: silent,
    dependencyChecks: [() => { checkRan = true; return new Promise<boolean>(() => {}); }],
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/readiness`); // resolves promptly -> proves no hang
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: 'unavailable' });
    assert.equal(checkRan, false, 'the dependency check must be short-circuited when not ready');
  });
});

test('HEAD on a declared route does NOT receive the GET success contract (404)', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent });
  await withServer(app, async (base) => {
    for (const path of ['/health', '/readiness']) {
      const res = await fetch(`${base}${path}`, { method: 'HEAD' });
      assert.equal(res.status, 404, `HEAD ${path} must be denied, not served as GET`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
    // The exact GET contract still works.
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test('method containment: only GET on the exact path succeeds; all else is a bounded 404', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent });
  await withServer(app, async (base) => {
    for (const path of ['/health', '/readiness']) {
      for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 404, `${method} ${path} must not succeed`);
        assert.equal(res.headers.get('allow'), null, `${method} ${path} must not disclose an Allow header`);
        if (method !== 'HEAD') {
          const body = await res.json();
          assert.equal(body.error, 'not_found', `${method} ${path} must be the bounded 404 contract`);
        }
      }
    }
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/readiness`)).status, 200);
  });
});

test('an aborted connection still emits exactly one bounded log entry', async () => {
  const logs: string[] = [];
  let arrived: () => void = () => {};
  const arrivedP = new Promise<void>((r) => { arrived = r; });
  const hang = new Promise<boolean>(() => {}); // dependency check never resolves
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness,
    log: { log: (l: string) => logs.push(l) },
    dependencyChecks: [() => { arrived(); return hang; }],
  });
  await withServer(app, async (base) => {
    const ac = new AbortController();
    const p = fetch(`${base}/readiness`, { signal: ac.signal }).catch(() => {});
    await arrivedP;      // the request has parked on the hanging dependency check
    ac.abort();
    await p;
    // Wait (bounded) for the server 'close' event to fire and log the abort.
    for (let i = 0; i < 300 && !logs.some((l) => l.includes('"reason":"aborted"')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  const reqLogs = logs.map((l) => JSON.parse(l)).filter((r) => r.event === 'request');
  assert.equal(reqLogs.length, 1, 'exactly one entry for the aborted request');
  assert.equal(reqLogs[0].reason, 'aborted');
  assert.equal(reqLogs[0].status, 0);
});

test('unknown routes and unsupported methods return a bounded JSON 404 (no HTML)', async () => {
  const app = createApp({ readiness: createReadinessState(), log: silent });
  await withServer(app, async (base) => {
    for (const req of [
      fetch(`${base}/does-not-exist`),
      fetch(`${base}/health`, { method: 'DELETE' }),
      fetch(`${base}/admin/secret`),
    ]) {
      const res = await req;
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = await res.json();
      assert.equal(body.error, 'not_found');
      assert.ok('requestId' in body);
    }
  });
});

test('case and trailing-slash route variants do not reach the endpoints', async () => {
  const app = createApp({ readiness: createReadinessState(), log: silent });
  await withServer(app, async (base) => {
    for (const path of ['/Health', '/HEALTH', '/health/', '/Readiness', '/readiness/']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, `${path} must not match a declared route`);
      assert.equal((await res.json()).error, 'not_found');
    }
    assert.equal((await fetch(`${base}/health`)).status, 200, 'the exact route still works');
  });
});

test('every response carries a correlation ID; a valid inbound one is echoed', async () => {
  const app = createApp({ readiness: createReadinessState(), log: silent });
  await withServer(app, async (base) => {
    const generated = await fetch(`${base}/health`);
    assert.match(generated.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);

    const echoed = await fetch(`${base}/health`, { headers: { 'x-request-id': 'inbound-req-0001' } });
    assert.equal(echoed.headers.get('x-request-id'), 'inbound-req-0001');
  });
});

// NOTE: the former global-body-parser tests (malformed JSON -> 400, oversized ->
// 413, unsupported-encoding -> 415) were REMOVED with the global parser. Under the
// owner's admission-before-parsing ruling, a body on a disallowed method / unknown
// path is a bounded 404 (proven in the raw-socket precedence suite below), and an
// operational GET body is rejected 400 without any parsing.

test('security headers apply to every application-layer response class', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent });
  await withServer(app, async (base) => {
    const cases = [
      ['health 200', () => fetch(`${base}/health`)],
      ['readiness 200', () => fetch(`${base}/readiness`)],
      ['unknown 404', () => fetch(`${base}/nope`)],
      ['method mismatch 404', () => fetch(`${base}/health`, { method: 'DELETE' })],
    ] as const;
    for (const [label, run] of cases) {
      const res = await run();
      for (const [h, v] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(res.headers.get(h), v, `${label}: header ${h}`);
      }
      assert.match(res.headers.get('permissions-policy') ?? '', /geolocation=\(\)/, `${label}: restrictive permissions-policy`);
      assert.equal(res.headers.get('x-powered-by'), null, `${label}: X-Powered-By must be absent`);
    }
    // The operational-GET-with-body 400 and the centralized 500 carry the same
    // headers — asserted in the raw-socket operational-body test and the live-500
    // test respectively (fetch cannot send a GET body / force a 500).
  });
});

test('the centralized 500 response carries security headers and no leak (live socket)', async () => {
  // createApp has no throwing route by design; wire the REAL exported errorHandler
  // behind a route that throws to prove a 500 on the wire is bounded + headered.
  const app = express();
  app.disable('x-powered-by');
  app.get('/boom', () => { throw new Error('secret internal detail'); });
  app.use(errorHandler);
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    for (const [h, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(h), v);
    const body = await res.json();
    assert.equal(body.error, 'internal_error');
    assert.ok(!JSON.stringify(body).includes('secret internal detail'), 'must not leak the error message');
  });
});

test('trust proxy is disabled by default and forwarded headers cannot alter identity/logging', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const logs: string[] = [];
  const app = createApp({ readiness, log: { log: (l: string) => logs.push(l) } });
  // The Express setting itself is off.
  assert.equal(app.get('trust proxy'), false, 'trust proxy must default to false');

  await withServer(app, async (base) => {
    const forged = '203.0.113.7';
    // Only forwarded headers present -> the request ID is GENERATED, never derived
    // from X-Forwarded-For, and the forwarded value is never logged.
    const r1 = await fetch(`${base}/health`, {
      headers: { 'x-forwarded-for': forged, 'x-forwarded-proto': 'https', forwarded: 'for=203.0.113.7;proto=https' },
    });
    assert.match(r1.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/, 'id must be generated, not from XFF');
    assert.notEqual(r1.headers.get('x-request-id'), forged);

    // A valid X-Request-Id wins; a forged XFF does not override it.
    const r2 = await fetch(`${base}/health`, { headers: { 'x-request-id': 'valid-req-000001', 'x-forwarded-for': forged } });
    assert.equal(r2.headers.get('x-request-id'), 'valid-req-000001');

    for (let i = 0; i < 100 && logs.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    const joined = logs.join('\n');
    assert.ok(!joined.includes(forged), 'the forwarded client value must never appear in logs');
  });
});

// --- transport-layer (http.Server) hardening: bounded limits + raw sockets ---

test('createBoundedServer sets explicit, finite, coherent limits', () => {
  const server = createBoundedServer((_req, res) => res.end());
  try {
    assert.equal(server.headersTimeout, HTTP_SERVER_LIMITS.headersTimeoutMs);
    assert.equal(server.requestTimeout, HTTP_SERVER_LIMITS.requestTimeoutMs);
    assert.equal(server.keepAliveTimeout, HTTP_SERVER_LIMITS.keepAliveTimeoutMs);
    // One above the policy limit so the app-layer count check can detect truncation.
    assert.equal(server.maxHeadersCount, HTTP_SERVER_LIMITS.maxHeaderLines + 1);
    assert.equal(server.timeout, HTTP_SERVER_LIMITS.socketTimeoutMs);
    for (const v of Object.values(HTTP_SERVER_LIMITS)) {
      assert.ok(Number.isInteger(v) && v > 0, `limit ${v} must be a finite positive integer`);
    }
    // Coherent ordering: keepAlive < headers <= request; no unlimited timeout; the
    // socket-inactivity backstop is bounded and >= the keep-alive window.
    assert.ok(HTTP_SERVER_LIMITS.keepAliveTimeoutMs < HTTP_SERVER_LIMITS.headersTimeoutMs);
    assert.ok(HTTP_SERVER_LIMITS.headersTimeoutMs <= HTTP_SERVER_LIMITS.requestTimeoutMs);
    assert.ok(HTTP_SERVER_LIMITS.socketTimeoutMs >= HTTP_SERVER_LIMITS.keepAliveTimeoutMs);
  } finally {
    server.close();
  }
});

test('a CONNECT/upgrade socket error is swallowed — no uncaughtException, no process crash', () => {
  // The detached socket owns its errors. A peer RST racing socket.destroy() would
  // emit 'error'; without a listener that throws -> uncaughtException -> exit(1).
  // Each refuse handler must attach a no-op 'error' listener before destroying.
  const server = createBoundedServer((_req, res) => res.end());
  try {
    for (const ev of ['connect', 'upgrade']) {
      const handler = server.listeners(ev)[0] as (...a: unknown[]) => void;
      assert.ok(typeof handler === 'function', `${ev} must have a refuse handler`);
      const sock = new EventEmitter() as EventEmitter & { destroy: () => void };
      // destroy() emulates the RST race: it emits 'error' on the detached socket.
      sock.destroy = () => { sock.emit('error', new Error('ECONNRESET')); };
      assert.doesNotThrow(() => handler.call(server, {}, sock, Buffer.alloc(0)),
        `${ev}: a socket error must be swallowed, not become an uncaughtException`);
    }
  } finally {
    server.close();
  }
});

/** Open a raw loopback socket, send `payload`, return the raw response text. */
function rawExchange(port: number, payload: string, timeoutMs = 2000): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    let text = '';
    let closed = false;
    c.on('data', (d) => { text += d.toString('latin1'); });
    c.on('close', () => { closed = true; resolve({ text, closed }); });
    c.on('error', () => resolve({ text, closed }));
    setTimeout(() => { c.destroy(); resolve({ text, closed }); }, timeoutMs);
  });
}

const rawStatus = (text: string): number => { const m = /^HTTP\/1\.1 (\d{3})/.exec(text); return m ? Number(m[1]) : 0; };
const rawHasConnClose = (text: string): boolean => /\r\nconnection:\s*close\r\n/i.test(text);
const noLeak = (text: string): boolean => !/Error|at Object|node_modules|\/home\/|NODE_ENV|PORT=|internal_error/.test(text);

/** Boot a bounded server for the duration of `fn`; ready by default. */
async function withBoundedServer(
  fn: (port: number) => Promise<void>, appOverride?: http.RequestListener, options?: { hsts?: boolean },
): Promise<void> {
  const readiness = createReadinessState(); readiness.setReady();
  const app = appOverride ?? createApp({ readiness, log: silent });
  const server = createBoundedServer(app, options);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try { await fn(port); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

// Phase 4.0 M4 — HSTS is a deployment-boundary flag: absent unless the app and server are
// built with `hsts: true` (server.ts: the production classification, behind TLS termination),
// then present on every response class — the chain's lock and the pre-Express 400 alike.
test('HSTS is absent by default and present on 200, 404, refusal, 500 and the absolute-form 400 with hsts: true', async () => {
  // A handler can neither add HSTS outside production nor weaken it inside, by setHeader or inline.
  const sts: RouteDefinition = {
    method: 'GET', path: '/sts', policy: { access: 'public' }, body: { kind: 'none' }, idempotency: 'none',
    handler: (_req, res) => {
      res.setHeader('Strict-Transport-Security', 'max-age=1');
      res.writeHead(200, { 'Strict-Transport-Security': 'max-age=2', 'Content-Type': 'application/json' });
      res.end('{}');
    },
  };
  const boom: RouteDefinition = {
    method: 'GET', path: '/boom', policy: { access: 'public' }, body: { kind: 'none' }, idempotency: 'none', handler: () => { throw new Error('boom'); },
  };
  const exchanges: Array<[string, number, string]> = [
    ['health 200', 200, 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['unknown 404', 404, 'GET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['body refusal 400', 400, 'GET /health HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n\r\nx'],
    ['handler 500', 500, 'GET /boom HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['absolute-form 400', 400, 'GET http://x/health HTTP/1.1\r\nHost: x\r\n\r\n'],
    ['handler-set HSTS 200', 200, 'GET /sts HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
  ];
  for (const hsts of [undefined, false, true]) {
    const readiness = createReadinessState(); readiness.setReady();
    const app = createApp({ readiness, log: silent, routes: [boom, sts], limits: testRequestLimits(), ...(hsts === undefined ? {} : { hsts }) });
    await withBoundedServer(async (port) => {
      for (const [label, status, payload] of exchanges) {
        const { text } = await rawExchange(port, payload);
        assert.equal(rawStatus(text), status, `${label} (hsts=${hsts})`);
        const sent = [...text.matchAll(/\r\nstrict-transport-security: ([^\r]*)/gi)].map((m) => m[1]);
        assert.deepEqual(sent, hsts === true ? ['max-age=31536000; includeSubDomains'] : [], `${label}: HSTS (hsts=${hsts})`);
      }
    }, app, hsts === undefined ? undefined : { hsts });
  }
});

test('operational GET body policy: absent/zero-length allowed; declared/transfer-encoded body -> bounded 400 + closed', async () => {
  await withBoundedServer(async (port) => {
    const noBody = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.equal(rawStatus(noBody.text), 200, 'GET with no body -> 200');

    const zero = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    assert.equal(rawStatus(zero.text), 200, 'GET with Content-Length: 0 -> 200');

    const withBody = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello');
    assert.equal(rawStatus(withBody.text), 400, 'GET with a declared body -> bounded 400');
    assert.ok(rawHasConnClose(withBody.text), 'a rejected body must close the connection');
    assert.equal(withBody.closed, true);
    assert.match(withBody.text, /cache-control: no-store/i, 'the 400 carries security headers');
    assert.match(withBody.text, /x-content-type-options: nosniff/i);
    assert.ok(!withBody.text.includes('hello'), 'must not reflect body bytes');

    const chunked = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n');
    assert.equal(rawStatus(chunked.text), 400, 'GET with chunked transfer-encoding -> 400');
    assert.ok(rawHasConnClose(chunked.text));

    const ce = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: x\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n');
    assert.equal(rawStatus(ce.text), 200, 'GET with Content-Encoding but no body -> 200 (never decompressed)');

    for (const r of [withBody, chunked]) assert.ok(noLeak(r.text), 'no stack/env/path leak on a rejected body');
  });
});

test('admission before parsing: any non-GET / unknown-path body -> bounded 404, never parsed or decompressed', async () => {
  await withBoundedServer(async (port) => {
    // Malformed JSON on a disallowed method -> 404 (NOT the old parser 400).
    const malformed = await rawExchange(port, 'POST /health HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\n{bad');
    assert.equal(rawStatus(malformed.text), 404, 'malformed JSON on POST /health -> 404');
    assert.ok(rawHasConnClose(malformed.text), 'a denied request carrying a body must close the connection');

    // A bad gzip body -> 404 proves NO decompressor executed (a gunzip would 400/500).
    const badGzip = await rawExchange(port, 'POST /readiness HTTP/1.1\r\nHost: x\r\nContent-Encoding: gzip\r\nContent-Length: 8\r\n\r\nnotgzip!');
    assert.equal(rawStatus(badGzip.text), 404, 'bad-gzip body on a denied route -> 404 (no decompressor ran)');

    // An oversized declared body on a denied route -> 404 without reading the body.
    const huge = await rawExchange(port, 'PUT /health HTTP/1.1\r\nHost: x\r\nContent-Length: 5000000\r\n\r\nZZZ');
    assert.equal(rawStatus(huge.text), 404, 'oversized declared body on PUT /health -> 404');
    assert.equal(huge.closed, true, 'must not wait to drain the oversized body');

    // Unknown path with a body -> 404.
    const unknown = await rawExchange(port, 'DELETE /admin/secret HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\n{bad');
    assert.equal(rawStatus(unknown.text), 404, 'unknown path with a body -> 404');

    for (const r of [malformed, badGzip, huge, unknown]) {
      assert.ok(noLeak(r.text), 'a denied body must not produce a 500 or leak (no parser/decompressor ran)');
    }
    // Server remains serviceable.
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200);
  });
});

const count = (text: string, code: number): number => (text.match(new RegExp(` ${code} `, 'g')) ?? []).length;

test('a denied body-bearing request closes the connection and never processes a pipelined second request', async () => {
  await withBoundedServer(async (port) => {
    // Each payload denies a body-bearing request AND pipelines a valid GET /health
    // behind it on the SAME connection. The valid GET must NOT be processed (no
    // 200), the body must not be parsed/decompressed/reflected, and the socket
    // must close with a bounded JSON 404 + Connection: close.
    const trailingGet = 'GET /health HTTP/1.1\r\nHost: x\r\n\r\n';
    const cases: Array<[string, string]> = [
      ['POST /health + Content-Length', `POST /health HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello${trailingGet}`],
      ['POST /health + chunked', `POST /health HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n${trailingGet}`],
      ['unknown path + Content-Length', `DELETE /admin/secret HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello${trailingGet}`],
      ['unknown path + chunked', `PUT /nope HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n${trailingGet}`],
    ];
    for (const [label, payload] of cases) {
      const r = await rawExchange(port, payload);
      // The core pipelining guarantee first, so its signal is independently visible:
      // exactly one 404 and ZERO 200s (the pipelined GET must NOT be processed).
      assert.equal(count(r.text, 200), 0, `${label}: the pipelined second request must NOT be processed`);
      assert.equal(count(r.text, 404), 1, `${label}: exactly one response`);
      assert.equal(rawStatus(r.text), 404, `${label}: bounded JSON 404`);
      assert.match(r.text, /application\/json/i, `${label}: JSON content-type`);
      assert.match(r.text, /"error":"not_found"/, `${label}: bounded 404 envelope`);
      assert.ok(rawHasConnClose(r.text), `${label}: Connection: close`);
      assert.equal(r.closed, true, `${label}: the socket must close`);
      assert.ok(!r.text.includes('hello'), `${label}: the body must not be reflected`);
      assert.ok(noLeak(r.text), `${label}: no parser/decompressor 500 or leak`);
    }
    // The SAME server instance survived all four pipelining attempts and still serves.
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'the server remains serviceable after all pipelining attempts');
  });
});

test('a fresh connection remains serviceable after a denied body-bearing request; a mid-body abort does not crash the server', async () => {
  await withBoundedServer(async (port) => {
    // A denied body-bearing request, then a client that aborts mid-body.
    await rawExchange(port, 'POST /health HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello');
    await new Promise<void>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write('POST /health HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npart');
        c.destroy(); // abrupt client teardown mid-body
      });
      c.on('error', () => resolve());
      c.on('close', () => resolve());
      setTimeout(resolve, 1000);
    });
    // The server survived both and serves a fresh connection.
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'a fresh connection succeeds after denied/aborted body-bearing requests');
    assert.deepEqual(await ok.json(), { status: 'alive' });
  });
});

test('an over-limit header COUNT is rejected 431 — a body-framing header cannot hide behind truncation', async () => {
  await withBoundedServer(async (port) => {
    // >100 headers with Content-Length placed AFTER the limit. Node truncates
    // req.headers at maxHeadersCount, so without the count check hasDeclaredBody
    // would miss the Content-Length and serve a body-bearing GET 200 keep-alive.
    let pad = '';
    for (let i = 0; i < 130; i++) pad += `X-H${i}: v\r\n`;
    const r = await rawExchange(port, `GET /health HTTP/1.1\r\nHost: x\r\n${pad}Content-Length: 5\r\n\r\nhello`);
    assert.equal(rawStatus(r.text), 431, 'an over-limit header count must be rejected, not served 200');
    assert.ok(rawHasConnClose(r.text), 'the connection must close (an unread body may follow)');
    assert.ok(noLeak(r.text), 'no leak on the 431 path');
    assert.ok(!r.text.includes('hello'), 'must not reflect the body');
    // A legitimate small-header request still succeeds.
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'server survives + a normal request succeeds');
  });
});

test('an Expect is refused by the chain with a bounded 417 and leaves the server healthy', async () => {
  await withBoundedServer(async (port) => {
    // No expectation is supported (bodyPolicy.test.ts holds the full contract): the
    // chain answers a bounded JSON 417 with the header policy — never Node's bare 417,
    // and never a 100 Continue, which would invite a body before any check.
    for (const expect of ['weird-thing', '100-continue']) {
      const r = await rawExchange(port, `GET /health HTTP/1.1\r\nHost: x\r\nExpect: ${expect}\r\nConnection: close\r\n\r\n`);
      assert.match(r.text, /^HTTP\/1\.1 417 /, `${expect}: a 417 and no interim 100 Continue`);
      assert.match(r.text, /\r\nContent-Security-Policy: default-src 'none'/i, `${expect}: the header policy`);
      assert.match(r.text, /"error":"expectation_failed"/, expect);
      assert.ok(r.text.length < 1024, `${expect}: the refusal is bounded`);
      assert.ok(noLeak(r.text), 'no stack/env/path/secret leak');
    }
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'server remains healthy');
  });
});

test('an oversized header is rejected with a bounded 4xx (431), closed, no echo, server survives', async () => {
  await withBoundedServer(async (port) => {
    const bigValue = 'A'.repeat(20000); // exceeds the 16 KiB maxHeaderSize
    const r = await rawExchange(port, `GET /health HTTP/1.1\r\nHost: x\r\nX-Pad: ${bigValue}\r\n\r\n`);
    assert.match(r.text, /^HTTP\/1\.1 4\d\d/, 'oversized header -> a bounded 4xx (normally 431)');
    assert.ok(r.text.length < 512, 'the response must be strictly bounded');
    assert.ok(!r.text.includes('AAAA'), 'the oversized header value must not be echoed');
    assert.ok(noLeak(r.text), 'no stack/parser/env/path/secret/identifier leak');
    assert.equal(r.closed, true, 'the socket must close');
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'a subsequent valid request succeeds');
  });
});

test('a CONNECT request establishes no tunnel: socket closed, no data, server healthy', async () => {
  await withBoundedServer(async (port) => {
    const r = await rawExchange(port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    assert.equal(r.closed, true, 'the socket must close');
    assert.ok(!/Connection established|101/i.test(r.text), 'no tunnel established, no upgrade');
    assert.ok(r.text.length < 512, 'no data disclosure beyond a bounded denial');
    assert.ok(noLeak(r.text));
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'server remains healthy');
  });
});

test('a WebSocket-style Upgrade is refused: no 101 Switching Protocols, socket closed, server healthy', async () => {
  await withBoundedServer(async (port) => {
    const r = await rawExchange(port,
      'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    assert.ok(!/101 Switching Protocols/i.test(r.text), 'must not switch protocols');
    assert.equal(r.closed, true, 'the socket must close');
    assert.ok(r.text.length < 512);
    assert.ok(noLeak(r.text));
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'server remains healthy');
  });
});

test('a malformed transport request gets a bounded 4xx, closes, and never leaks', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent });
  const server = createBoundedServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const { text, closed } = await rawExchange(port, 'GET / HTTP/1.1 \r\nHost: x\r\nBADHEADER\r\n\r\n');
    assert.match(text, /^HTTP\/1\.1 4\d\d/, 'a bounded 4xx transport response');
    assert.ok(text.length < 512, 'transport response must be small/bounded');
    assert.ok(!/Error|at Object|node_modules|NODE_ENV|PORT=|\/home\//.test(text), 'no stack/env/path leak');
    assert.equal(closed, true, 'the connection must be closed');
    // The server survived and still serves a subsequent valid request.
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200, 'server remains serviceable after a malformed client');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('an incomplete/idle request is bounded by the socket-inactivity backstop (short timing)', async () => {
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: silent });
  const server = createBoundedServer(app);
  // Inject a SHORT socket-inactivity timeout so the test never waits a
  // production-length deadline. (headersTimeout/requestTimeout are enforced by
  // Node's coarse ~30s connection checker; server.timeout is the deterministic one.)
  server.timeout = 300;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    // Send request line + one header but NEVER the terminating blank line, then idle.
    const { text, closed } = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: x\r\n', 4000);
    assert.equal(closed, true, 'an incomplete/idle request must be closed by the backstop');
    assert.ok(text.length < 512, 'no unbounded response to an incomplete request');
    assert.ok(!/Error|node_modules|\/home\/|NODE_ENV/.test(text), 'no leak on the timeout path');
    // Process/server survived and still serves a subsequent valid request.
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(ok.status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// --- unit coverage of the terminal handlers, independent of a live socket ---

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body: unknown;
  const res = {
    headersSent: false,
    locals: { requestId: 'req-unit-0001' } as Record<string, unknown>,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    status(c: number) { statusCode = c; return res; },
    json(b: unknown) { body = b; return res; },
    get _status() { return statusCode; },
    get _body() { return body; },
    get _headers() { return headers; },
  };
  return res;
}

test('errorHandler maps a generic thrown error to a bounded 500', () => {
  const res = mockRes();
  errorHandler(new Error('boom with secret detail'), { headers: {} } as never, res as never, () => {});
  assert.equal(res._status, 500);
  assert.deepEqual(res._body, { error: 'internal_error', requestId: 'req-unit-0001' });
  assert.ok(!JSON.stringify(res._body).includes('secret detail'), 'error message must not leak');
  assert.equal(res._headers['x-content-type-options'], 'nosniff');
  assert.equal(res._headers['cache-control'], 'no-store');
});

test('a 500 over an unread body closes the connection (defense-in-depth)', () => {
  const res = mockRes();
  errorHandler(new Error('x'), { headers: { 'content-length': '10' } } as never, res as never, () => {});
  assert.equal(res._status, 500);
  assert.equal(res._headers['connection'], 'close', 'a 500 with an undrained body must close the connection');
});

test('errorHandler defers to next when a response was already started', () => {
  const res = mockRes();
  res.headersSent = true;
  let forwarded: unknown;
  errorHandler(new Error('late'), {} as never, res as never, (e?: unknown) => { forwarded = e; });
  assert.ok(forwarded instanceof Error, 'must delegate to the default handler');
  assert.equal(res._status, 0, 'must not write a second response');
});

test('notFoundHandler returns a bounded JSON 404 that never reveals internal routes', () => {
  const res = mockRes();
  notFoundHandler({ headers: {} } as never, res as never, () => {});
  assert.equal(res._status, 404);
  assert.deepEqual(res._body, { error: 'not_found', requestId: 'req-unit-0001' });
});

test('notFoundHandler closes the connection when a denied request carries a body', () => {
  const res = mockRes();
  notFoundHandler({ headers: { 'content-length': '10' } } as never, res as never, () => {});
  assert.equal(res._status, 404);
  assert.equal(res._headers['connection'], 'close', 'an unread body must force connection close');
});

test('classifyRoute collapses unknown paths to a single bounded class', () => {
  assert.equal(classifyRoute('/health'), '/health');
  assert.equal(classifyRoute('/readiness'), '/readiness');
  assert.equal(classifyRoute('/secret/tenant/42?token=abc'), 'other');
  assert.equal(classifyRoute('/'), 'other');
});

// --- Phase 4.0 M6: the rate-limit port composed into createApp ------------------------------

const NO_TRUSTED_PROXIES: readonly string[] = [];

test('GET /health is prompt and independent of the limiter store', async () => {
  const counts = { consume: 0, probe: 0 };
  const hangingLimiter: DistributedRateLimiter = {
    consume: () => { counts.consume++; return new Promise(() => {}); },
    probe: () => { counts.probe++; return new Promise(() => {}); },
  };
  const readiness1 = createReadinessState(); readiness1.setReady();
  const app1 = createApp({ readiness: readiness1, log: silent, limits: { limiter: hangingLimiter, keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: NO_TRUSTED_PROXIES } });
  await withServer(app1, async (base) => {
    const started = Date.now();
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 1_000, 'a hanging limiter must not delay /health');
    assert.equal(counts.consume, 0);
    assert.equal(counts.probe, 0);
  });

  const throwingLimiter: DistributedRateLimiter = {
    consume: () => { counts.consume++; throw new Error('limiter boom'); },
    probe: () => { counts.probe++; throw new Error('limiter boom'); },
  };
  const readiness2 = createReadinessState(); readiness2.setReady();
  const app2 = createApp({ readiness: readiness2, log: silent, limits: { limiter: throwingLimiter, keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: NO_TRUSTED_PROXIES } });
  await withServer(app2, async (base) => {
    const started = Date.now();
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 1_000, 'a throwing limiter must not fail /health');
    assert.equal(counts.consume, 0, 'the limiter is never called for a probe');
    assert.equal(counts.probe, 0);
  });
});

test('GET /readiness is honest about protected traffic and never spends the limiter', async () => {
  const makeApp = (probe: (signal: AbortSignal) => unknown, extra: { portDeadlineMs?: number } = {}) => {
    const consumeCalls = { n: 0 };
    const limiter: DistributedRateLimiter = { consume: () => { consumeCalls.n++; return { outcome: 'allowed', remaining: 1 }; }, probe };
    const readiness = createReadinessState(); readiness.setReady();
    const app = createApp({
      readiness, log: silent, limits: { limiter, keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: NO_TRUSTED_PROXIES }, ...extra,
    });
    return { app, consumeCalls };
  };

  {
    const { app, consumeCalls } = makeApp(() => true);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/readiness`);
      assert.equal(res.status, 200);
      assert.equal(consumeCalls.n, 0, 'readiness never spends the limiter');
    });
  }
  for (const bad of [() => false, () => 'true', (): never => { throw new Error('probe boom'); }]) {
    const { app, consumeCalls } = makeApp(bad);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/readiness`);
      assert.equal(res.status, 503, String(bad));
      assert.equal(consumeCalls.n, 0);
    });
  }
  {
    let signal: AbortSignal | undefined;
    const { app, consumeCalls } = makeApp((s) => { signal = s; return new Promise(() => {}); }, { portDeadlineMs: 50 });
    await withServer(app, async (base) => {
      const started = Date.now();
      const res = await fetch(`${base}/readiness`);
      assert.equal(res.status, 503);
      assert.ok(Date.now() - started < 2_000, 'the deadline, not the probe, ended the check');
      assert.equal(signal?.aborted, true, 'the hanging probe is cancelled');
      assert.equal(consumeCalls.n, 0);
    });
  }
});

test('readiness shares one limiter probe for 1000ms of the injected clock', async () => {
  let probeCalls = 0;
  let clock = 0;
  const limiter: DistributedRateLimiter = {
    consume: () => ({ outcome: 'allowed', remaining: 1 }),
    probe: () => { probeCalls++; return true; },
  };
  const readiness = createReadinessState(); readiness.setReady();
  const app = createApp({
    readiness, log: silent, now: () => clock,
    limits: { limiter, keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: NO_TRUSTED_PROXIES },
  });
  await withServer(app, async (base) => {
    const results = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/readiness`)));
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(probeCalls, 1, '20 concurrent readiness requests share one probe call');

    clock += 1_000;
    const res = await fetch(`${base}/readiness`);
    assert.equal(res.status, 200);
    assert.equal(probeCalls, 2, 'once the reuse window has passed, the next readiness request probes again');
  });
});

test('startup: limits are required once a route exists beyond the two probes, and malformed limits fail closed', () => {
  assert.doesNotThrow(() => createApp({ readiness: createReadinessState() }), 'a probe-only app starts without limits');

  const publicRoute: RouteDefinition = {
    method: 'GET', path: '/m6-probe-route', policy: { access: 'public' }, body: { kind: 'none' }, idempotency: 'none',
    handler: (_req, res) => { res.status(200).json({ ok: true }); },
  };
  const assertSetupCode = (deps: Record<string, unknown>, code: string): void => {
    assert.throws(() => createApp(deps as never),
      (err: unknown) => err instanceof EnforcementSetupError && err.code === code, code);
  };
  assertSetupCode({ readiness: createReadinessState(), routes: [publicRoute] }, 'rate_limit_required');

  const good = testRequestLimits();
  assertSetupCode({ readiness: createReadinessState(), routes: [publicRoute], limits: { ...good, limiter: {} } }, 'rate_limit_invalid');
  assertSetupCode({ readiness: createReadinessState(), routes: [publicRoute], limits: { ...good, limiter: { consume: () => {} } } }, 'rate_limit_invalid');
  assertSetupCode(
    { readiness: createReadinessState(), routes: [publicRoute], limits: { ...good, keySecret: new Uint8Array(10) } },
    'rate_limit_key_invalid',
  );
  assertSetupCode(
    { readiness: createReadinessState(), routes: [publicRoute], limits: { ...good, trustedProxies: ['0.0.0.0/0'] } },
    'trusted_proxies_invalid',
  );
});

test('a limiter timeout blocks neither socket cleanup nor shutdown', async () => {
  const hangingLimiter: DistributedRateLimiter = { consume: () => new Promise(() => {}), probe: () => true };
  const publicRoute: RouteDefinition = {
    method: 'GET', path: '/m6-slow-limited', policy: { access: 'public' }, body: { kind: 'none' }, idempotency: 'none',
    handler: (_req, res) => { res.status(200).json({ ok: true }); },
  };
  const logs: string[] = [];
  const readiness = createReadinessState(); readiness.setReady();
  const app = createApp({
    readiness, log: { log: (l: string) => logs.push(l) }, routes: [publicRoute],
    limits: { limiter: hangingLimiter, keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: NO_TRUSTED_PROXIES },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  let exitCode: number | undefined;
  const lifecycle = createLifecycle({
    server, readiness, proc: new EventEmitter(), exit: (code) => { exitCode = code; }, forceTimeoutMs: 10_000,
  });
  try {
    const exchangePromise = rawExchange(port, 'GET /m6-slow-limited HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', 4000);
    // Give the request time to reach and park on the limiter before shutting down.
    await new Promise((r) => setTimeout(r, 20));
    const shutdownPromise = lifecycle.shutdown('signal_sigterm', 0);
    const { text } = await exchangePromise;
    assert.equal(rawStatus(text), 503, 'the timed-out limiter call ends the in-flight request');

    const started = Date.now();
    for (let i = 0; i < 300 && exitCode === undefined; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(Date.now() - started < 3_000, 'exit(0) arrives well inside the force timeout');
    assert.equal(exitCode, 0);
    assert.equal(readiness.isReady(), false, 'readiness becomes unavailable during shutdown');
    await shutdownPromise;
  } finally {
    if (server.listening) await new Promise<void>((r) => server.close(() => r()));
  }
  const reqLog = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.event === 'request');
  assert.equal(reqLog?.reason, 'rate_limit_timeout');
});

test('the probe exemption holds only for the exact GET /health and GET /readiness routes', async () => {
  let consumeCalls = 0;
  const limiter: DistributedRateLimiter = {
    consume: () => { consumeCalls++; return { outcome: 'allowed', remaining: 1 }; },
    probe: () => true,
  };
  const readiness = createReadinessState(); readiness.setReady();
  const app = createApp({ readiness, log: silent, limits: { limiter, keySecret: TEST_RATE_LIMIT_KEY, trustedProxies: NO_TRUSTED_PROXIES } });
  await withServer(app, async (base) => {
    for (const [method, path] of [['HEAD', '/health'], ['GET', '/health/'], ['GET', '/HEALTH']] as const) {
      consumeCalls = 0;
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(consumeCalls, 1, `${method} ${path} must spend the limiter`);
    }
    consumeCalls = 0;
    const ok = await fetch(`${base}/health`);
    assert.equal(ok.status, 200);
    assert.equal(consumeCalls, 0, 'the exact GET /health probe never spends the limiter');
  });
});
