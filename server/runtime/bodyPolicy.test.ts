// Phase 4.0 M3 — bounded per-route request-body and media-type policy: real-socket contract.
//
// Every route declares its body policy: `none`, or bounded JSON (a source-defined byte
// cap, required or optional). Synthetic routes and identities cross a real loopback
// socket into createApp and pin the policy against the shared chain:
//   - header-level body checks (400/413/415) and Expect (417) never read a body byte;
//   - CSRF, authentication and authorization all pass BEFORE a body byte is read;
//   - the cap counts the bytes actually streamed, whatever Content-Length says;
//   - an early refusal of a body-bearing request closes its connection, and nothing
//     it carries or queues behind it on that connection is processed;
//   - no body byte or parser message reaches a response, the log or stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createApp, createReadinessState, createBoundedServer, readBoundedBody, HTTP_SERVER_LIMITS } from './app.js';
import { testRequestLimits } from './rateLimiter.testkit.js';
import type { BearerTokenView } from './access.js';
import { SECURITY_HEADERS } from './securityHeaders.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from './requestSecurity.js';
import type { RouteContext, RouteDefinition, VerifiedPrincipal } from './routes.js';

const TRUSTED = 'http://pos.trusted.test';
const CAP = 64;
const CANARY = 'SECRET-CANARY-7f3a';

// --- synthetic identities, ports and routes ------------------------------------------

const PRINCIPALS: Record<string, unknown> = {
  'tok-writer': { authProvider: 'synthetic', authProviderUid: 'uid-writer', verified: true },
  'tok-reader': { authProvider: 'synthetic', authProviderUid: 'uid-reader', verified: true },
};

const WRITE = { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.write' } } as const;
const NONE = { kind: 'none' } as const;
const JSON_REQUIRED = { kind: 'json', maxBytes: CAP, required: true } as const;
const JSON_OPTIONAL = { kind: 'json', maxBytes: CAP, required: false } as const;

interface Seen { calls: Record<string, number>; order: string[]; bodies: unknown[]; streamBytes: number[]; ctx: RouteContext[] }

function probeRoutes(seen: Seen): RouteDefinition[] {
  const slow = (close: boolean) => async (_req: Request, res: Response): Promise<void> => {
    seen.order.push('slow start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (close) res.setHeader('Connection', 'close');
    seen.order.push('slow end');
    res.status(200).json({ ok: true });
  };
  const record = (name: string) => async (req: Request, res: Response, ctx: RouteContext): Promise<void> => {
    seen.calls[name] = (seen.calls[name] ?? 0) + 1;
    seen.order.push(name);
    seen.bodies.push(ctx.body);
    seen.ctx.push(ctx);
    // Any byte the policy left unread would surface here: the raw stream is no bypass.
    let unread = 0;
    for await (const chunk of req) unread += (chunk as Buffer).length;
    seen.streamBytes.push(unread);
    res.status(200).json({ ok: true });
  };
  return [
    { method: 'POST', path: '/v1/json-required', policy: WRITE, body: JSON_REQUIRED, idempotency: 'none', handler: record('required') },
    { method: 'POST', path: '/v1/json-optional', policy: WRITE, body: JSON_OPTIONAL, idempotency: 'none', handler: record('optional') },
    { method: 'POST', path: '/v1/no-body', policy: WRITE, body: NONE, idempotency: 'none', handler: record('noBody') },
    { method: 'GET', path: '/v1/smuggled', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: record('smuggled') },
    { method: 'GET', path: '/v1/slow-keep', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: slow(false) },
    { method: 'GET', path: '/v1/slow-close', policy: { access: 'public' }, body: NONE, idempotency: 'none', handler: slow(true) },
  ];
}

interface Ports { tokenViews: unknown[]; authorizations: unknown[][] }
interface Harness { port: number; logs: string[]; seen: Seen; calls: { authn: number; authz: number }; ports: Ports }

/** Serve createApp on 127.0.0.1:<ephemeral> for `fn`; always closes server and sockets. */
async function withBodyApp(fn: (h: Harness) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  const seen: Seen = { calls: {}, order: [], bodies: [], streamBytes: [], ctx: [] };
  const calls = { authn: 0, authz: 0 };
  const ports: Ports = { tokenViews: [], authorizations: [] };
  const readiness = createReadinessState();
  readiness.setReady();
  const app = createApp({
    readiness,
    log: { log: (line: string) => { logs.push(line); } },
    routes: probeRoutes(seen),
    trustedOrigins: [TRUSTED],
    limits: testRequestLimits(),
    // The ports record exactly what they are handed: frozen views, never the request.
    authenticator: {
      async verify(tokenView: BearerTokenView): Promise<unknown> {
        calls.authn++;
        ports.tokenViews.push(tokenView);
        return PRINCIPALS[tokenView.bearerToken] ?? null;
      },
    },
    authorizer: {
      authorize(principal: VerifiedPrincipal, ...rest: unknown[]): boolean {
        calls.authz++;
        ports.authorizations.push([principal, ...rest]);
        return principal.authProviderUid === 'uid-writer';
      },
    },
  });
  const server = createBoundedServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ port: (server.address() as AddressInfo).port, logs, seen, calls, ports });
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

// --- raw transport -------------------------------------------------------------------

type Headers = Record<string, string | string[]>;

/** A raw HTTP/1.1 request: the head (an array value becomes repeated lines) plus body bytes. */
function raw(method: string, path: string, headers: Headers, body: string | Buffer = ''): Buffer {
  const lines = [`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1'];
  for (const [name, value] of Object.entries(headers)) for (const v of [value].flat()) lines.push(`${name}: ${v}`);
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), Buffer.from(body)]);
}

const WRITER: Headers = { origin: TRUSTED, [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: 'Bearer tok-writer' };

/** A credentialed, CSRF-valid JSON request framed by Content-Length. */
function jsonPost(path: string, body: string | Buffer, headers: Headers = {}): Buffer {
  return raw('POST', path, {
    ...WRITER, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers,
  }, body);
}

/** Chunked framing: each part one chunk, then the terminator (omitted when `open`). */
const chunks = (parts: string[], open = false): string =>
  parts.map((p) => `${Buffer.byteLength(p).toString(16)}\r\n${p}\r\n`).join('') + (open ? '' : '0\r\n\r\n');

const chunkedPost = (path: string, parts: string[], headers: Headers = {}, open = false): Buffer =>
  raw('POST', path, { ...WRITER, 'content-type': 'application/json', 'transfer-encoding': 'chunked', ...headers }, chunks(parts, open));

interface Exchange { text: string; closed: boolean }

/**
 * Write raw bytes (then half-close, when `halfClose`); collect the reply until the server
 * closes the connection or `waitMs` passes.
 */
function exchange(port: number, payload: Buffer, waitMs = 1500, halfClose = false): Promise<Exchange> {
  return new Promise((resolve) => {
    const received: Buffer[] = [];
    let closed = false;
    const socket = net.connect(port, '127.0.0.1', () => (halfClose ? socket.end(payload) : socket.write(payload)));
    const timer = setTimeout(() => socket.destroy(), waitMs);
    socket.on('data', (d: Buffer) => { received.push(d); });
    socket.on('end', () => { closed = true; });
    socket.on('error', () => { closed = true; }); // a reset from the server also ends the exchange
    socket.on('close', () => { clearTimeout(timer); resolve({ text: Buffer.concat(received).toString('latin1'), closed }); });
  });
}

interface Reply { status: number; headers: Record<string, string>; body: string }

/** Every response on the wire, in order (interim 1xx included), bodies framed by Content-Length. */
function replies(text: string): Reply[] {
  const out: Reply[] = [];
  let rest = text;
  while (rest.startsWith('HTTP/1.1 ')) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) break;
    const [statusLine, ...lines] = rest.slice(0, end).split('\r\n');
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const length = Number(headers['content-length'] ?? 0);
    out.push({ status: Number(statusLine.slice(9, 12)), headers, body: rest.slice(end + 4, end + 4 + length) });
    rest = rest.slice(end + 4 + length);
  }
  return out;
}

/** A bounded refusal carrying the full security-header policy and no request material. */
function assertRefused(r: Reply | undefined, status: number, error: string, label: string): void {
  assert.ok(r, `${label}: no response`);
  assert.equal(r.status, status, `${label}: ${r.body}`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(r.headers[name.toLowerCase()], value, `${label}: ${name}`);
  }
  const body = JSON.parse(r.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], label);
  assert.equal(body.error, error, label);
}

/** Exactly one bounded refusal on the wire, then the server closes the connection. */
async function assertOneRefusal(port: number, payload: Buffer, status: number, error: string, label: string): Promise<Reply> {
  const { text, closed } = await exchange(port, payload);
  const all = replies(text);
  assert.equal(all.length, 1, `${label}: exactly one response\n${text}`);
  assertRefused(all[0], status, error, label);
  assert.equal(all[0].headers.connection, 'close', `${label}: Connection: close`);
  assert.ok(closed, `${label}: the server closed the connection`);
  return all[0];
}

async function served(port: number, payload: Buffer, label: string): Promise<void> {
  const [r] = replies((await exchange(port, payload)).text);
  assert.equal(r?.status, 200, `${label}: ${r?.body}`);
}

/** The request-log reason codes once `count` records have flushed. */
async function reasons(logs: string[], count: number): Promise<unknown[]> {
  for (let i = 0; i < 200 && logs.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  return logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.event === 'request').map((r) => r.reason);
}

// --- body-free routes -----------------------------------------------------------------

test('a body-free route is served without a body, and its handler finds nothing in the request stream', async () => {
  await withBodyApp(async ({ port, seen }) => {
    await served(port, raw('GET', '/health', { connection: 'close' }), 'GET /health');
    await served(port, raw('POST', '/v1/no-body', { ...WRITER, connection: 'close' }), 'no framing header');
    await served(port, raw('POST', '/v1/no-body', { ...WRITER, 'content-length': '0', connection: 'close' }), 'Content-Length: 0');
    assert.equal(seen.calls.noBody, 2);
    assert.deepEqual(seen.bodies, [undefined, undefined]);
    assert.deepEqual(seen.streamBytes, [0, 0]);
    assert.deepEqual(Object.keys(seen.ctx[0]).sort(), ['body', 'principal', 'requestId', 'session']);
    assert.equal(seen.ctx[0].session, null, 'a route outside the session boundaries carries no session');
    assert.ok(Object.isFrozen(seen.ctx[0]));
  });
});

test('a body-free route refuses a Content-Length or chunked body with a bounded 400, before authentication', async () => {
  await withBodyApp(async ({ port, logs, seen, calls }) => {
    const cases: Array<[string, Buffer]> = [
      ['GET /health with Content-Length', raw('GET', '/health', { 'content-length': '5' }, 'hello')],
      ['GET /readiness chunked', raw('GET', '/readiness', { 'transfer-encoding': 'chunked' }, chunks(['hello']))],
      ['Content-Length body', raw('POST', '/v1/no-body', { ...WRITER, 'content-length': '2' }, '{}')],
      ['chunked body', raw('POST', '/v1/no-body', { ...WRITER, 'transfer-encoding': 'chunked' }, chunks(['{}']))],
      ['typed JSON body', raw('POST', '/v1/no-body', { ...WRITER, 'content-type': 'application/json', 'content-length': '2' }, '{}')],
    ];
    for (const [label, payload] of cases) await assertOneRefusal(port, payload, 400, 'invalid_request', label);
    assert.equal(seen.calls.noBody, undefined);
    assert.equal(calls.authn, 0, 'refused at the header level, before any credential is examined');
    assert.deepEqual(await reasons(logs, cases.length), cases.map(() => 'body_not_allowed'));
  });
});

// --- accepted JSON --------------------------------------------------------------------

test('valid bounded JSON reaches an authorized handler exactly once, as the parsed value only', async () => {
  const exact = `{"pad":"${'x'.repeat(CAP - 10)}"}`;
  assert.equal(Buffer.byteLength(exact), CAP);
  await withBodyApp(async ({ port, seen, calls }) => {
    const close = { connection: 'close' };
    await served(port, jsonPost('/v1/json-required', '{"sku":"A-1","qty":2}', close), 'Content-Length framed');
    await served(port, chunkedPost('/v1/json-required', ['{"sku":', '"A-2"}'], close), 'chunked');
    await served(port, jsonPost('/v1/json-required', exact, close), 'exactly the cap');
    for (const type of ['application/json; charset=utf-8', 'application/json;charset=utf-8', 'Application/JSON; Charset=UTF-8', 'application/json ; charset=utf-8']) {
      await served(port, jsonPost('/v1/json-required', '[1,2]', { ...close, 'content-type': type }), type);
    }
    assert.equal(seen.calls.required, 7, 'each accepted request ran its handler exactly once');
    assert.deepEqual(seen.bodies.slice(0, 3), [{ sku: 'A-1', qty: 2 }, { sku: 'A-2' }, { pad: 'x'.repeat(CAP - 10) }]);
    assert.deepEqual(seen.streamBytes, [0, 0, 0, 0, 0, 0, 0], 'the handler finds no unread byte in the request stream');
    assert.deepEqual(seen.ctx[0].principal, { authProvider: 'synthetic', authProviderUid: 'uid-writer' });
    assert.equal(calls.authn, 7);
    assert.equal(calls.authz, 7);
  });
});

test('a required body must be present; an optional body may be absent', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    const close = { connection: 'close' };
    const typed = { ...WRITER, 'content-type': 'application/json', ...close };
    await assertOneRefusal(port, raw('POST', '/v1/json-required', typed), 400, 'invalid_request', 'required, no framing');
    await assertOneRefusal(port, raw('POST', '/v1/json-required', { ...typed, 'content-length': '0' }), 400, 'invalid_request', 'required, empty');
    await assertOneRefusal(port, chunkedPost('/v1/json-required', []), 400, 'invalid_request', 'required, empty chunked');
    assert.equal(seen.calls.required, undefined);
    assert.deepEqual(await reasons(logs, 3), ['body_required', 'body_required', 'body_required']);

    await served(port, raw('POST', '/v1/json-optional', typed), 'optional, no framing');
    await served(port, raw('POST', '/v1/json-optional', { ...typed, 'content-length': '0' }), 'optional, empty');
    await served(port, chunkedPost('/v1/json-optional', [], close), 'optional, empty chunked');
    await served(port, jsonPost('/v1/json-optional', 'null', close), 'optional, JSON null');
    await served(port, jsonPost('/v1/json-optional', '{"a":1}', close), 'optional, present');
    assert.equal(seen.calls.optional, 5);
    assert.deepEqual(seen.bodies, [undefined, undefined, undefined, null, { a: 1 }]);
  });
});

// --- media type, content coding, framing -----------------------------------------------

test('a body without exactly application/json (UTF-8) is 415, before authentication', async () => {
  await withBodyApp(async ({ port, logs, seen, calls }) => {
    const refused: Array<[string, Buffer]> = [
      ['missing', raw('POST', '/v1/json-required', { ...WRITER, 'content-length': '2' }, '{}')],
      ['duplicated', jsonPost('/v1/json-required', '{}', { 'content-type': ['application/json', 'application/json'] })],
    ];
    for (const type of [
      '', 'text/plain', 'text/json', 'application/jsonx', 'application/json-patch+json', 'application/problem+json',
      'application/json;', 'application/json; charset=utf-16', 'application/json; charset=utf8',
      'application/json; charset="utf-8"', 'application/json; charset=iso-8859-1', 'application/json; charset = utf-8',
      'application/json; foo=bar', 'application/json; charset=utf-8; charset=utf-8',
      'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded',
    ]) {
      refused.push([`Content-Type: ${type}`, jsonPost('/v1/json-required', '{}', { 'content-type': type })]);
    }
    for (const [label, payload] of refused) await assertOneRefusal(port, payload, 415, 'unsupported_media_type', label);
    assert.equal(seen.calls.required, undefined);
    assert.equal(calls.authn, 0);
    const codes = await reasons(logs, refused.length);
    assert.equal(codes[0], 'media_type_missing');
    assert.deepEqual(codes.slice(1), refused.slice(1).map(() => 'media_type_unsupported'));
  });
});

test('any Content-Encoding is 415, with or without a body', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    const encodings = ['gzip', 'deflate', 'br', 'identity', 'gzip, identity'];
    for (const encoding of encodings) {
      await assertOneRefusal(port, jsonPost('/v1/json-required', '{}', { 'content-encoding': encoding }), 415, 'unsupported_media_type', encoding);
    }
    const bodiless = raw('POST', '/v1/json-optional', { ...WRITER, 'content-encoding': 'gzip', connection: 'close' });
    await assertOneRefusal(port, bodiless, 415, 'unsupported_media_type', 'no body');
    assert.equal((seen.calls.required ?? 0) + (seen.calls.optional ?? 0), 0);
    assert.deepEqual(await reasons(logs, encodings.length + 1), [...encodings, 'x'].map(() => 'content_encoding_unsupported'));
  });
});

test('a transfer coding other than chunked is refused with a bounded 400', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    const payload = raw('POST', '/v1/json-required', {
      ...WRITER, 'content-type': 'application/json', 'transfer-encoding': 'gzip, chunked',
    }, chunks(['{}']));
    await assertOneRefusal(port, payload, 400, 'invalid_request', 'gzip, chunked');
    assert.equal(seen.calls.required, undefined);
    assert.deepEqual(await reasons(logs, 1), ['transfer_encoding_unsupported']);
  });
});

test('an HTTP/1.0 request framed by Transfer-Encoding is refused as faulty framing', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    // RFC 9112 §6.1: Transfer-Encoding in an HTTP/1.0 message means the framing is faulty.
    const payload = Buffer.from(
      `POST /v1/json-required HTTP/1.0\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${chunks(['{}'])}`, 'latin1');
    await assertOneRefusal(port, payload, 400, 'invalid_request', 'HTTP/1.0 chunked');
    assert.equal(seen.calls.required, undefined);
    assert.deepEqual(await reasons(logs, 1), ['transfer_encoding_unsupported']);
  });
});

test('a chunked body carrying trailer fields is refused with a bounded 400', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    // Trailers would reach the handler outside every header check and the byte cap.
    const payload = raw('POST', '/v1/json-required', {
      ...WRITER, 'content-type': 'application/json', 'transfer-encoding': 'chunked',
    }, '2\r\n{}\r\n0\r\nContent-Encoding: gzip\r\n\r\n');
    await assertOneRefusal(port, payload, 400, 'invalid_request', 'trailer');
    assert.equal(seen.calls.required, undefined);
    assert.deepEqual(await reasons(logs, 1), ['body_trailers_unsupported']);
  });
});

test('a request framed by both Content-Length and Transfer-Encoding never reaches the chain', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    // The classic CL.TE smuggling pair: Node's strict parser refuses it with its own bare
    // 400 before the app runs, which holds only while the lenient parser stays disabled.
    const payload = raw('POST', '/v1/json-required', {
      ...WRITER, 'content-type': 'application/json', 'content-length': '2', 'transfer-encoding': 'chunked',
    }, chunks(['{}']));
    const { text, closed } = await exchange(port, payload);
    assert.equal(replies(text)[0]?.status, 400);
    assert.ok(closed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.calls.required, undefined);
    assert.equal(logs.length, 0, 'the chain never saw the request');
  });
});

// --- malformed bodies and disclosure -----------------------------------------------------

test('malformed JSON is 400 and neither the body nor the parser message escapes', async () => {
  const bodies: Array<string | Buffer> = [
    `{"card":"${CANARY}"`,
    CANARY,
    `{"a":1} ${CANARY}`,
    `'${CANARY}'`,
    `﻿{"a":"${CANARY}"}`,
    Buffer.concat([Buffer.from(`{"a":"${CANARY}`), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
    '   ',
  ];
  const printed: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => { printed.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await withBodyApp(async ({ port, logs, seen }) => {
      const seenText: string[] = [];
      for (const [i, body] of bodies.entries()) {
        const r = await assertOneRefusal(port, jsonPost('/v1/json-required', body), 400, 'invalid_request', `body ${i}`);
        seenText.push(r.body);
      }
      assert.equal(seen.calls.required, undefined);
      assert.deepEqual(await reasons(logs, bodies.length), bodies.map(() => 'body_malformed'));
      const escaped = `${seenText.join('\n')}\n${logs.join('\n')}\n${printed.join('')}`;
      for (const leak of [CANARY, 'card', 'Unexpected', 'SyntaxError', 'position', 'JSON', 'token']) {
        assert.ok(!escaped.includes(leak), `leaked ${leak}`);
      }
    });
  } finally {
    process.stderr.write = write;
  }
});

// --- the byte cap ------------------------------------------------------------------------

test('a declared Content-Length over the cap is 413 before a body byte is read or a credential examined', async () => {
  await withBodyApp(async ({ port, logs, seen, calls }) => {
    const headOnly = (length: string): Buffer =>
      raw('POST', '/v1/json-required', { ...WRITER, 'content-type': 'application/json', 'content-length': length });
    // Heads only: a server that waited for the declared body would never answer.
    await assertOneRefusal(port, headOnly(String(CAP + 1)), 413, 'content_too_large', 'cap + 1');
    await assertOneRefusal(port, headOnly('9007199254740993'), 413, 'content_too_large', 'beyond a safe integer');
    assert.equal(seen.calls.required, undefined);
    assert.equal(calls.authn, 0);
    assert.deepEqual(await reasons(logs, 2), ['body_declared_too_large', 'body_declared_too_large']);
  });
});

test('a chunked body is refused 413 as soon as the streamed bytes pass the cap', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    const over = 'x'.repeat(CAP + 1);
    await assertOneRefusal(port, chunkedPost('/v1/json-required', [over]), 413, 'content_too_large', 'one chunk');
    await assertOneRefusal(port, chunkedPost('/v1/json-required', Array.from({ length: CAP + 1 }, () => 'y')), 413, 'content_too_large', 'many chunks');
    // Never terminated: the refusal must not wait for the end of the body.
    await assertOneRefusal(port, chunkedPost('/v1/json-required', [over], {}, true), 413, 'content_too_large', 'unterminated');
    assert.equal(seen.calls.required, undefined);
    assert.deepEqual(await reasons(logs, 3), ['body_streamed_too_large', 'body_streamed_too_large', 'body_streamed_too_large']);
  });
});

test('the reader counts streamed bytes, never a declared length, and settles once', { timeout: 10_000 }, async () => {
  const stream = (...parts: string[]): PassThrough => {
    const s = new PassThrough();
    for (const p of parts) s.write(p);
    s.end();
    return s;
  };
  assert.deepEqual(await readBoundedBody(stream(), 4), { ok: true, bytes: Buffer.alloc(0) });
  assert.deepEqual(await readBoundedBody(stream('ab', 'cd'), 4), { ok: true, bytes: Buffer.from('abcd') });
  assert.deepEqual(await readBoundedBody(stream('ab', 'cde'), 4), { ok: false, reason: 'body_streamed_too_large' });
  assert.deepEqual(await readBoundedBody(stream('x'.repeat(1_000_000)), 4), { ok: false, reason: 'body_streamed_too_large' });

  const failing = new PassThrough();
  failing.write('ab');
  setImmediate(() => failing.destroy(new Error('reset')));
  assert.deepEqual(await readBoundedBody(failing, 4), { ok: false, reason: 'body_incomplete' });
  const cut = new PassThrough();
  cut.write('ab');
  setImmediate(() => cut.destroy());
  assert.deepEqual(await readBoundedBody(cut, 4), { ok: false, reason: 'body_incomplete' });
  const gone = new PassThrough();
  gone.destroy();
  assert.deepEqual(await readBoundedBody(gone, 4), { ok: false, reason: 'body_incomplete' }, 'an already-closed stream still settles');

  // After the cap is passed the stream keeps draining (so a refusal can flush) without being kept.
  const flooding = new PassThrough();
  flooding.write('abcde');
  assert.deepEqual(await readBoundedBody(flooding, 4), { ok: false, reason: 'body_streamed_too_large' });
  flooding.write('more');
  flooding.end();
  await new Promise((resolve) => flooding.on('end', resolve));
});

test('a misleading Content-Length never changes what the handler receives', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    // Overstated: 10 bytes declared, 5 sent, then the client closes. The 5 are valid JSON
    // on their own, so only the reader stands between a truncated body and the handler.
    await exchange(port, jsonPost('/v1/json-required', '12345', { 'content-length': '10' }), 1500, true);
    await reasons(logs, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.calls.required, undefined, 'a truncated body is never delivered');
    // Understated: bytes past the declared length are framed as the next request, never as body.
    const payload = Buffer.concat([jsonPost('/v1/json-required', '{}'), raw('GET', '/v1/smuggled', { connection: 'close' })]);
    assert.deepEqual(replies((await exchange(port, payload)).text).map((r) => r.status), [200, 200]);
    assert.deepEqual(seen.bodies, [{}, undefined]);
    assert.equal(seen.calls.required, 1);
  });
});

// --- ordering against CSRF, authentication and authorization ------------------------------------

test('CSRF, authentication and authorization refuse before a single body byte is read', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    // Unterminated chunked malformed JSON: a chain that read the body first would hang or 400.
    const partial = (headers: Headers): Buffer => chunkedPost('/v1/json-required', ['{"a":'], headers, true);
    await assertOneRefusal(port, partial({ origin: 'http://evil.test' }), 403, 'forbidden', 'CSRF');
    await assertOneRefusal(port, partial({ authorization: [] }), 401, 'unauthenticated', 'no credential');
    await assertOneRefusal(port, partial({ authorization: 'Bearer tok-unknown' }), 401, 'unauthenticated', 'rejected credential');
    await assertOneRefusal(port, partial({ authorization: 'Bearer tok-reader' }), 403, 'forbidden', 'not authorized');
    // A complete malformed body with a failing credential is still 401: parsing comes last.
    await assertOneRefusal(port, jsonPost('/v1/json-required', CANARY, { authorization: 'Bearer tok-unknown' }), 401, 'unauthenticated', 'complete body');
    assert.equal(seen.calls.required, undefined);
    assert.deepEqual(await reasons(logs, 5),
      ['csrf_origin_mismatch', 'authn_missing', 'authn_rejected', 'authz_denied', 'authn_rejected']);
  });
});

test('the authenticator and authorizer receive frozen views only, so the body reaches the policy read intact', async () => {
  await withBodyApp(async ({ port, seen, ports }) => {
    await served(port, jsonPost('/v1/json-required', '{"a":1}', { connection: 'close' }), 'a valid body');
    assert.equal(ports.tokenViews.length, 1);
    const [tokenView] = ports.tokenViews;
    assert.ok(Object.isFrozen(tokenView));
    assert.equal(Object.getPrototypeOf(tokenView), Object.prototype, 'a plain view, not the request stream');
    assert.deepEqual(tokenView, { bearerToken: 'tok-writer' });
    const [args] = ports.authorizations;
    assert.equal(args.length, 4, 'principal, requirement, route view and the deadline signal only');
    for (const arg of args.slice(0, 3)) {
      assert.ok(Object.isFrozen(arg));
      assert.equal(Object.getPrototypeOf(arg), Object.prototype);
    }
    assert.deepEqual(args[2], { method: 'POST', path: '/v1/json-required', audience: null });
    assert.ok(args[3] instanceof AbortSignal, 'the last argument is the deadline signal, never the request');
    assert.deepEqual(seen.bodies, [{ a: 1 }], 'the whole body reached the handler through the policy read');
    assert.deepEqual(seen.streamBytes, [0]);
  });
});

// --- connection disposal --------------------------------------------------------------------

test('a refused body cannot poison the connection: nothing it carries or queues behind it is processed', async () => {
  const SMUGGLED = 'GET /v1/smuggled HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n';
  const typed = { ...WRITER, 'content-type': 'application/json' };
  const cases: Array<[string, Buffer, number, string]> = [
    ['400 body on a body-free route', raw('POST', '/v1/no-body', { ...WRITER, 'content-length': String(SMUGGLED.length) }, SMUGGLED), 400, 'invalid_request'],
    ['415 media type', jsonPost('/v1/json-required', SMUGGLED, { 'content-type': 'text/plain' }), 415, 'unsupported_media_type'],
    ['413 declared', jsonPost('/v1/json-required', SMUGGLED.padEnd(CAP + 1, ' ')), 413, 'content_too_large'],
    ['403 CSRF', jsonPost('/v1/json-required', SMUGGLED, { origin: 'http://evil.test' }), 403, 'forbidden'],
    ['401 credential', jsonPost('/v1/json-required', SMUGGLED, { authorization: 'Bearer tok-unknown' }), 401, 'unauthenticated'],
    ['400 malformed after a full read', jsonPost('/v1/json-required', SMUGGLED), 400, 'invalid_request'],
    ['413 streamed', raw('POST', '/v1/json-required', { ...typed, 'transfer-encoding': 'chunked' }, chunks([SMUGGLED, SMUGGLED])), 413, 'content_too_large'],
  ];
  await withBodyApp(async ({ port, seen }) => {
    for (const [label, refused, status, error] of cases) {
      // The refused body itself holds a request, and a correctly framed request follows it.
      await assertOneRefusal(port, Buffer.concat([refused, Buffer.from(SMUGGLED)]), status, error, label);
    }
    assert.equal(seen.calls.smuggled, undefined, 'neither the embedded nor the pipelined request ran');
    assert.equal(seen.calls.required, undefined);

    // Control: an ACCEPTED body leaves the connection usable, and the next request runs in order.
    const accepted = Buffer.concat([jsonPost('/v1/json-required', '{"ok":true}'), raw('GET', '/v1/smuggled', { connection: 'close' })]);
    const { text, closed } = await exchange(port, accepted);
    assert.deepEqual(replies(text).map((r) => r.status), [200, 200]);
    assert.ok(closed);
    assert.equal(seen.calls.required, 1);
    assert.equal(seen.calls.smuggled, 1);
  });
});

test('a pipelined request waits for the response ahead of it, and never runs behind one that closes', async () => {
  await withBodyApp(async ({ port, seen }) => {
    const next = raw('GET', '/v1/smuggled', { connection: 'close' });
    const kept = await exchange(port, Buffer.concat([raw('GET', '/v1/slow-keep', {}), next]));
    assert.deepEqual(replies(kept.text).map((r) => r.status), [200, 200]);
    assert.deepEqual(seen.order, ['slow start', 'slow end', 'smuggled'], 'processed strictly one at a time, in order');
    seen.order.length = 0;
    const closing = await exchange(port, Buffer.concat([raw('GET', '/v1/slow-close', {}), next]));
    assert.deepEqual(replies(closing.text).map((r) => r.status), [200]);
    assert.ok(closing.closed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen.order, ['slow start', 'slow end'], 'nothing runs behind a response that closes the connection');
  });
});

test('a connection may hold only a bounded number of pipelined requests waiting', async () => {
  const cap = HTTP_SERVER_LIMITS.maxQueuedRequests;
  const tiny = (last: boolean): Buffer => raw('GET', '/v1/smuggled', last ? { connection: 'close' } : {});
  const flood = (n: number): Buffer => Buffer.concat([raw('GET', '/v1/slow-keep', {}), ...Array.from({ length: n }, (_, i) => tiny(i === n - 1))]);
  await withBodyApp(async ({ port, seen }) => {
    const atCap = await exchange(port, flood(cap));
    assert.equal(replies(atCap.text).length, cap + 1, 'up to the cap, every waiting request is served in order');
    assert.equal(seen.calls.smuggled, cap);
    seen.calls.smuggled = 0;
    const over = await exchange(port, flood(cap + 1));
    assert.ok(over.closed, 'one past the cap cuts the connection');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(seen.calls.smuggled, 0, 'and no waiting request ever runs');
  });
});

// --- Expect -------------------------------------------------------------------------------

test('an Expect header is refused with a bounded 417 and the body is never invited', async () => {
  await withBodyApp(async ({ port, logs, seen }) => {
    const typed = { ...WRITER, 'content-type': 'application/json', 'content-length': '2' };
    // Heads only: exactly one response means no interim 100 Continue was sent first.
    await assertOneRefusal(port, raw('POST', '/v1/json-required', { ...typed, expect: '100-continue' }), 417, 'expectation_failed', '100-continue');
    await assertOneRefusal(port, raw('POST', '/v1/json-required', { ...typed, expect: 'x-custom' }), 417, 'expectation_failed', 'unknown expectation');
    await assertOneRefusal(port, raw('GET', '/health', { expect: '100-continue' }), 417, 'expectation_failed', 'bodiless');
    assert.equal(seen.calls.required, undefined);
    assert.deepEqual(await reasons(logs, 3), ['expect_unsupported', 'expect_unsupported', 'expect_unsupported']);
    // RFC 9110 §10.1.1: a 100-continue expectation in an HTTP/1.0 request is ignored.
    const legacy = replies((await exchange(port, Buffer.from('GET /health HTTP/1.0\r\nExpect: 100-continue\r\n\r\n'))).text);
    assert.equal(legacy[0]?.status, 200);
  });
});

