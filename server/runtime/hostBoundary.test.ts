// Phase 4.0 M6-ENTRY-P1 — createApp's `hosts` allowlist (app.ts): the deployable entry serves its
// administrative host alone, before the limiter or anything else, indistinguishable from an unknown
// route to a foreign Host.
//
// Every assertion crosses a real loopback socket into createApp/createBoundedServer, exactly as
// enforcement.test.ts does for the rest of the chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp, createBoundedServer, createReadinessState } from './app.js';
import type { AppDeps } from './app.js';
import { createMemoryRateLimiter, testRequestLimits } from './rateLimiter.testkit.js';
import type { DistributedRateLimiter } from './rateLimit.js';
import { EnforcementSetupError } from './routes.js';
import type { RouteDefinition } from './routes.js';

const silent = { log: (): void => {} };
const HOST = 'admin.example.test';
const NONE = { kind: 'none' } as const;
const READ = { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.read' } } as const;

// --- transport helpers (self-contained: mirrors enforcement.test.ts's send/rawExchange/withApp) ---

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Bound applied to every helper below: destroys the socket and rejects rather than hanging a test forever. */
const HELPER_TIMEOUT_MS = 5_000;

/** One request on its own connection (agent: false) so no socket outlives it. Bounded: never hangs a test. */
function send(port: number, method: string, path: string, headers: Record<string, string | string[]> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: headers as http.OutgoingHttpHeaders, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => { settled = true; clearTimeout(timer); resolve({ status: res.statusCode ?? 0, headers: res.headers, body }); });
    });
    const timer = setTimeout(() => { settled = true; req.destroy(); reject(new Error('send: bounded timeout exceeded')); }, HELPER_TIMEOUT_MS);
    req.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    req.end();
  });
}

/** Raw loopback exchange for a request a well-behaved client (and Node's own http.request) will not send.
 * Bounded: destroys the socket and rejects rather than resolving with a silently-truncated answer. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    let timedOut = false;
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    const timer = setTimeout(() => { timedOut = true; socket.destroy(); reject(new Error('rawExchange: bounded timeout exceeded')); }, HELPER_TIMEOUT_MS);
    socket.on('data', (d) => { text += d.toString('latin1'); });
    socket.on('close', () => { clearTimeout(timer); if (!timedOut) resolve(text); });
    socket.on('error', () => {});
  });
}

/** Status and body parsed from a raw HTTP response head + payload (only used for small JSON bodies). */
function rawStatusAndBody(text: string): { status: number; body: string } {
  const [head, ...rest] = text.split('\r\n\r\n');
  const statusLine = head.split('\r\n')[0];
  return { status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0), body: rest.join('\r\n\r\n') };
}

/** `work`, or a rejection naming `what` once HELPER_TIMEOUT_MS passes: bind and close never hang a test either. */
function bounded<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: bounded timeout exceeded`)), HELPER_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

interface Harness { port: number; logs: string[] }

/** Serve createApp on 127.0.0.1:<ephemeral> for `fn`; always closes server and sockets, bind and close both bounded. */
async function withApp(deps: Partial<AppDeps>, fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({ readiness, log: { log: (line: string) => { logs.push(line); } }, ...deps });
  const server = createBoundedServer(app);
  try {
    await bounded('listen', new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)));
    await fn({ port: (server.address() as AddressInfo).port, logs });
  } finally {
    await bounded('close', new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  }
}

/** Request-log records once `count` have flushed ('finish' may trail the reply slightly): polls the FILTERED
 * count itself, not the raw log array's length, since other event lines interleave with 'request' ones. Gives up
 * at the same HELPER_TIMEOUT_MS deadline as every other helper, returning what has flushed by then. */
async function requestLogs(logs: string[], count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + HELPER_TIMEOUT_MS;
  let records: Array<Record<string, unknown>> = [];
  for (;;) {
    records = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.event === 'request');
    if (records.length >= count || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return records;
}

function bodyOf(r: Reply): Record<string, unknown> {
  return JSON.parse(r.body) as Record<string, unknown>;
}

/** A refusal's body is exactly the unknown-route literal: { error: 'not_found', requestId: <non-empty string> }. */
function assertNotFoundBody(body: Record<string, unknown>, label: string): void {
  assert.equal(typeof body.requestId, 'string', `${label}: requestId must be a string`);
  assert.notEqual(body.requestId, '', `${label}: requestId must be non-empty`);
  assert.deepEqual(body, { error: 'not_found', requestId: body.requestId }, `${label}: exactly error and requestId`);
}

/** A distributed limiter over the testkit's in-memory one, counting every `consume` call it is asked to serve. */
function countingLimiter(): { limiter: DistributedRateLimiter; consumes: () => number } {
  const base = createMemoryRateLimiter();
  let consumes = 0;
  const limiter: DistributedRateLimiter = {
    consume: (request, signal) => { consumes += 1; return base.consume(request, signal); },
    probe: (signal) => base.probe(signal),
  };
  return { limiter, consumes: () => consumes };
}

interface Hits { open: number; secret: number }
function newHits(): Hits { return { open: 0, secret: 0 }; }

/** A public and an authenticated route: enough to exercise the chain without a session boundary. */
function hostRoutes(hits: Hits): RouteDefinition[] {
  return [
    { method: 'GET', path: '/v1/open', policy: { access: 'public' }, body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: (_req, res) => { hits.open++; res.status(200).json({ ok: true }); } },
    { method: 'GET', path: '/v1/secret', policy: READ, body: NONE, idempotency: 'none', trustedContext: 'none', recentAuth: 'none', handler: (_req, res) => { hits.secret++; res.status(200).json({ ok: true }); } },
  ];
}

function chainDeps(hits: Hits, limiter: DistributedRateLimiter, hosts: readonly string[] | undefined): Partial<AppDeps> {
  return {
    hosts,
    routes: hostRoutes(hits),
    authenticator: { verify: async () => ({ verified: true, authProvider: 'test', authProviderUid: 'uid-1' }) },
    authorizer: { authorize: () => true },
    limits: testRequestLimits({ limiter }),
  };
}

// --- served: exact match, case-insensitivity, the probes ---------------------------------------

test('an exact-match Host is served, a Host that differs only in case is served (DNS names compare case-insensitively), and the two probes answer on any host', async () => {
  const hits = newHits();
  const { limiter, consumes } = countingLimiter();
  await withApp(chainDeps(hits, limiter, [HOST]), async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open', { host: HOST })).status, 200, 'exact match');
    assert.equal(hits.open, 1);
    assert.equal((await send(port, 'GET', '/v1/open', { host: HOST.toUpperCase() })).status, 200, 'uppercase Host');
    assert.equal((await send(port, 'GET', '/v1/open', { host: 'Admin.Example.Test' })).status, 200, 'mixed-case Host');
    assert.equal(hits.open, 3);
    assert.ok(consumes() >= 3, 'served requests reach the limiter: positive control for the refusal tests below');

    // The probes are host-exempt AND spend no limiter quota: however many answer, on any host, consume is never asked.
    const beforeProbes = consumes();
    for (const path of ['/health', '/readiness']) {
      for (const host of [HOST, 'evil.test', 'ADMIN.EXAMPLE.TEST']) {
        assert.equal((await send(port, 'GET', path, { host })).status, 200, `${path} on Host: ${host}`);
      }
    }
    assert.equal(consumes(), beforeProbes, 'no probe request ever reached the limiter');
  });
});

// --- refused: every authority variant the design names, identical to an unknown route's 404 ------

test('a foreign, suffix, prefix, substring, ported, trailing-dot or userinfo authority is refused exactly like an unknown route, before the limiter, and X-Forwarded-Host never changes the decision', async () => {
  const hits = newHits();
  const { limiter, consumes } = countingLimiter();
  await withApp(chainDeps(hits, limiter, [HOST]), async ({ port, logs }) => {
    const unknownRoute = await send(port, 'GET', '/v1/does-not-exist', { host: HOST });
    assert.equal(unknownRoute.status, 404);
    assertNotFoundBody(bodyOf(unknownRoute), 'unknown route');

    const badHosts = [
      'evil.test', // foreign
      `${HOST}.evil`, // suffix
      `evil.${HOST}`, // prefix
      `xx${HOST}xx`, // substring
      `${HOST}:443`, // explicit port, none configured
      `${HOST}:8443`, // explicit port, none configured
      `${HOST}.`, // trailing dot
      `user@${HOST}`, // userinfo
    ];
    const before = consumes();
    for (const host of badHosts) {
      const r = await send(port, 'GET', '/v1/open', { host });
      assert.equal(r.status, 404, host);
      assertNotFoundBody(bodyOf(r), host);
    }
    assert.equal(hits.open, 0, 'no refused request ever reached the handler');
    assert.equal(consumes(), before, 'no refused request ever reached the limiter');

    const records = await requestLogs(logs, badHosts.length + 1);
    assert.ok(records.filter((r) => r.reason === 'host_not_served').length >= badHosts.length, 'each refusal logs host_not_served');

    // X-Forwarded-Host is never read: a correct Host with a forged XFH is served, and a wrong Host with a
    // "correct" XFH is still refused.
    assert.equal((await send(port, 'GET', '/v1/open', { host: HOST, 'x-forwarded-host': 'evil.test' })).status, 200,
      'a forged X-Forwarded-Host never overrides a served Host');

    const beforeSpoofed = consumes();
    const spoofed = await send(port, 'GET', '/v1/open', { host: 'evil.test', 'x-forwarded-host': HOST });
    assert.equal(spoofed.status, 404, 'a spoofed X-Forwarded-Host never stands in for the Host header');
    assert.equal(consumes(), beforeSpoofed, 'a wrong Host with a spoofed X-Forwarded-Host never reaches the limiter either');
    assertNotFoundBody(bodyOf(spoofed), 'spoofed X-Forwarded-Host');
    assert.equal(spoofed.headers['set-cookie'], undefined, 'no Set-Cookie on a refused request');
  });
});

/** Whether the raw response's headers (before the blank line) carry a Set-Cookie line, case-insensitively. */
function hasSetCookie(rawResponseText: string): boolean {
  const [head] = rawResponseText.split('\r\n\r\n');
  return /^set-cookie:/im.test(head);
}

test('duplicated Host lines and a missing Host on an HTTP/1.0 request are refused the same way', async () => {
  const hits = newHits();
  const { limiter, consumes } = countingLimiter();
  await withApp(chainDeps(hits, limiter, [HOST]), async ({ port }) => {
    const beforeDuplicated = consumes();
    const duplicated = await rawExchange(port,
      `GET /v1/open HTTP/1.1\r\nHost: ${HOST}\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
    const duplicatedParsed = rawStatusAndBody(duplicated);
    assert.equal(duplicatedParsed.status, 404, 'two Host lines, even if both name the served authority');
    assert.equal(consumes(), beforeDuplicated, 'a duplicate-Host refusal never reaches the limiter');
    assertNotFoundBody(JSON.parse(duplicatedParsed.body) as Record<string, unknown>, 'duplicated Host');
    assert.ok(!hasSetCookie(duplicated), 'no Set-Cookie on a refused request (duplicate Host)');

    const beforeMissing = consumes();
    const missing = await rawExchange(port, 'GET /v1/open HTTP/1.0\r\n\r\n');
    const missingParsed = rawStatusAndBody(missing);
    assert.equal(missingParsed.status, 404, 'no Host line at all (HTTP/1.0)');
    assert.equal(consumes(), beforeMissing, 'a missing-Host refusal never reaches the limiter');
    assertNotFoundBody(JSON.parse(missingParsed.body) as Record<string, unknown>, 'missing Host');
    assert.ok(!hasSetCookie(missing), 'no Set-Cookie on a refused request (missing Host)');

    assert.equal(hits.open, 0);
  });
});

// --- an explicit port in the served authority --------------------------------------------------

test('a served authority with an explicit port requires that exact port', async () => {
  const hits = newHits();
  const { limiter } = countingLimiter();
  await withApp(chainDeps(hits, limiter, [`${HOST}:8443`]), async ({ port }) => {
    assert.equal((await send(port, 'GET', '/v1/open', { host: `${HOST}:8443` })).status, 200, 'the exact configured port');
    for (const [host, label] of [[HOST, 'no port at all'], [`${HOST}:443`, 'a different port']]) {
      const r = await send(port, 'GET', '/v1/open', { host });
      assert.equal(r.status, 404, label);
      assertNotFoundBody(bodyOf(r), label);
    }
    assert.equal(hits.open, 1);
  });
});

// --- absent: unchanged behaviour ------------------------------------------------------------------

test('with no hosts configured, every Host is served — unchanged from before the host boundary existed', async () => {
  const hits = newHits();
  const { limiter } = countingLimiter();
  await withApp(chainDeps(hits, limiter, undefined), async ({ port }) => {
    for (const host of [HOST, 'evil.test', 'ANYTHING.test', `${HOST}:9999`]) {
      assert.equal((await send(port, 'GET', '/v1/open', { host })).status, 200, host);
    }
    assert.equal(hits.open, 4);
  });
});

// --- setup refusal ---------------------------------------------------------------------------------

test('setup refuses with EnforcementSetupError host_invalid for every malformed hosts list, and accepts a well-formed one', () => {
  const setupCode = (hosts: unknown): string | undefined => {
    try {
      createApp({ readiness: createReadinessState(), log: silent, hosts: hosts as readonly string[] });
    } catch (err) {
      return err instanceof EnforcementSetupError ? err.code : 'unexpected_error_type';
    }
    return undefined;
  };
  const invalid: unknown[] = [
    [], ['*.x.test'], ['A.test'], ['x.test:0'], ['x.test:65536'], ['user@x.test'], ['x.test.'], [' x.test'],
    ['x.test', 'x.test'], // duplicates
    'x.test', // a non-array
    [123], // a non-string entry
  ];
  for (const hosts of invalid) assert.equal(setupCode(hosts), 'host_invalid', JSON.stringify(hosts));
  assert.equal(setupCode([HOST]), undefined, 'a single well-formed authority is accepted');
  assert.equal(setupCode([HOST, 'other.example.test']), undefined, 'several distinct well-formed authorities are accepted');
  assert.equal(setupCode(undefined), undefined, 'absent is accepted: every host is served');
});

// --- the strict HTTP parser is pinned -------------------------------------------------------------

/** Ambiguous framing: both Transfer-Encoding: chunked and Content-Length (a request-smuggling shape). */
const AMBIGUOUS_FRAMING = `POST /v1/open HTTP/1.1\r\nHost: ${HOST}\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\nConnection: close\r\n\r\n0\r\n\r\n`;

test('createBoundedServer pins the strict parser: insecureHTTPParser is false, and ambiguous framing is refused 400', async () => {
  const server = createBoundedServer(createApp({ readiness: createReadinessState(), log: silent }));
  // Node stores the option on the server (not in @types/node's Server type): false, never undefined (the global flag).
  assert.equal((server as unknown as { insecureHTTPParser?: boolean }).insecureHTTPParser, false, 'pinned explicitly, never left to the process-wide flag');
  const hits = newHits();
  const { limiter } = countingLimiter();
  await withApp(chainDeps(hits, limiter, [HOST]), async ({ port }) => {
    assert.equal(rawStatusAndBody(await rawExchange(port, AMBIGUOUS_FRAMING)).status, 400);
  });
  assert.equal(hits.open, 0);
});

test('under a process-wide --insecure-http-parser (as NODE_OPTIONS could set it), a server built by createBoundedServer still refuses ambiguous framing 400', () => {
  // The flag is process-wide and read once, so it is set on a child: only PATH is inherited (nothing of this process's
  // environment), and the child builds the server through the same createBoundedServer, binds loopback, sends the
  // request and prints the status line. Positive control: a plain http.createServer in the same child accepts it.
  const script = `
    import http from 'node:http';
    import net from 'node:net';
    import { createApp, createBoundedServer, createReadinessState } from './server/runtime/app.ts';
    const exchange = (server) => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        let text = '';
        const socket = net.connect(server.address().port, '127.0.0.1', () => socket.write(${JSON.stringify(AMBIGUOUS_FRAMING)}));
        socket.on('data', (d) => { text += d.toString('latin1'); });
        socket.on('error', () => {});
        socket.on('close', () => { server.close(); resolve(text.split('\\r\\n')[0]); });
      });
    });
    const bounded = createBoundedServer(createApp({ readiness: createReadinessState(), log: { log: () => {} } }));
    const lenient = http.createServer((_req, res) => { res.end('ok'); });
    console.log('bounded=' + await exchange(bounded));
    console.log('plain=' + await exchange(lenient));
  `;
  const run = spawnSync(process.execPath, ['--insecure-http-parser', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(run.signal, null, `must not be killed by the bound\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(run.status, 0, `the child must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stdout, /^plain=HTTP\/1\.1 200 /m, `positive control: the lenient flag is in force in the child\n${run.stdout}`);
  assert.match(run.stdout, /^bounded=HTTP\/1\.1 400 /m, `createBoundedServer must refuse ambiguous framing despite the flag\n${run.stdout}`);
});
