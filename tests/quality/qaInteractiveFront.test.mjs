// QA-INTERACTIVE-P1 — the interactive QA front and its launch configuration.
//
// Everything runs on loopback with ephemeral ports: fake upstreams made with node:http stand in for the
// tenant runtime and both emulators, so each assertion is about what a caller observes (status, body,
// what the upstream received, whether the socket was answered at all). Token-shaped values are built at
// run time so no secret-looking literal sits in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  QA_CSP, QA_FIRESTORE_LISTEN, QA_IDENTITY_ROUTES, createFaults, createQaFront,
} from '../qa/interactive/front.mjs';
import {
  QA_PROJECT_ID, QaRefusal, assertMemoryHeadroom, findLiveConfigLeaks, javaMajor, resolveLaunchConfig,
} from '../qa/interactive/config.mjs';
import { lookupToken } from '../qa/interactive/emulators.mjs';
import { postgresOn, readPostmasterPid } from '../qa/interactive/ownership.mjs';
import { createTokenLedger } from '../qa/interactive/tokens.mjs';
import { createQaVerifier } from '../qa/interactive/verifier.mjs';

const HOST = 'qa-front.example.test';
const DATABASE = `projects/${QA_PROJECT_ID}/databases/(default)`;
const SIGN_IN = QA_IDENTITY_ROUTES[0][1];
const LOOKUP = QA_IDENTITY_ROUTES[1][1];
const TOKEN = QA_IDENTITY_ROUTES[2][1];
const STORE = 'store-1';
const INVOICE = 'inv-1';
const VOID_PATH = `/api/v1/stores/${STORE}/invoices/${INVOICE}/void`;
const INDEX_HTML = '<!doctype html><title>qa</title>';
const OUTSIDE_SECRET_TEXT = ['outside', 'bytes', process.pid].join('-');
const API_ROUTES = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/readiness' },
  { method: 'GET', path: '/api/v1/customers' },
  { method: 'POST', path: '/api/v1/customers' },
  { method: 'POST', path: '/api/v1/stores/{storeId}/invoices/{id}/void' },
];

let tmp;
let staticDir;
let api;
let auth;
let firestore;
let frontPort;
let frontServer;
let faults;
let tokens;
let ready = true;
let issued = 0;
/** A token-shaped value the fake Auth emulator "issues"; built at run time. */
const issue = (kind = 'issued') => [kind, process.pid, Date.now(), (issued += 1)].join('.');
const logLines = [];

/**
 * A fake upstream that records every request it receives in full and answers with `reply`; `arrived` counts requests
 * whose headers came in and `settled` those whose body ended or was cut, so a negative check can wait on state.
 */
function fakeUpstream(reply) {
  const received = [];
  const up = { server: null, received, port: 0, arrived: 0, settled: 0 };
  up.server = http.createServer((req, res) => {
    up.arrived += 1;
    const chunks = [];
    let counted = false;
    const settle = () => { if (!counted) { counted = true; up.settled += 1; } };
    req.on('data', (c) => chunks.push(c));
    req.on('error', settle);
    req.on('close', settle);
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      settle();
      reply(req, res);
    });
  });
  return up;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

/** One request over its own connection; resolves { status, headers, body } or { error }. */
function send({ method = 'GET', target = '/', headers = { host: HOST }, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: frontPort, method, path: target, headers, agent: false, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => resolve({ error }));
    });
    req.on('error', (error) => resolve({ error }));
    req.end(body);
  });
}

/** Raw bytes over a socket, for requests node:http would not send (no Host, oversized Content-Length). */
function sendRaw(text) {
  return new Promise((resolve) => {
    const socket = net.connect(frontPort, '127.0.0.1');
    let data = '';
    socket.on('data', (c) => { data += c.toString('utf8'); });
    socket.on('end', () => resolve(data));
    socket.on('error', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.write(text);
    setTimeout(() => socket.end(), 500);
  });
}

const waitFor = async (predicate, ms = 5000) => {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const json = (status, body, extra = {}) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
};

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpos-qa-front-'));
  staticDir = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(staticDir, 'assets', 'x.js.map'), '{"map":true}');
  fs.writeFileSync(path.join(staticDir, 'assets', '.hidden.js'), OUTSIDE_SECRET_TEXT);
  fs.writeFileSync(path.join(tmp, 'package.json'), OUTSIDE_SECRET_TEXT);
  fs.writeFileSync(path.join(tmp, 'outside.txt'), OUTSIDE_SECRET_TEXT);
  fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(staticDir, 'leak.txt'));

  api = fakeUpstream((req, res) => {
    if (req.url.startsWith(VOID_PATH)) return json(200, { voided: true })(req, res);
    if (req.url.endsWith('?hop=1')) {
      return json(200, { ok: true }, { connection: 'x-foo', 'x-foo': 'listed', 'keep-alive': 'timeout=77', 'set-cookie': ['a=1; Path=/'] })(req, res);
    }
    json(200, { ok: true }, { 'set-cookie': ['__Host-tmpos_session=s1; Path=/; Secure; HttpOnly; SameSite=Strict'] })(req, res);
  });
  // The fake Auth emulator issues fresh ID and refresh tokens on sign-in and on refresh, as the real one does; for
  // `unrecordable@` it answers 200 with an ID token too long for the ledger and no refresh token.
  auth = fakeUpstream((req, res) => {
    const p = req.url.split('?')[0];
    if (p === SIGN_IN) {
      if (auth.received.at(-1).body.includes('unrecordable@')) return json(200, { idToken: 'u'.repeat(9000) })(req, res);
      return json(200, { idToken: issue(), refreshToken: issue('refresh') })(req, res);
    }
    if (p === TOKEN) {
      const t = issue();
      return json(200, { id_token: t, access_token: t, refresh_token: issue('refresh') })(req, res);
    }
    json(200, { users: [{ localId: 'u1' }] })(req, res);
  });
  firestore = fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end('fs-ok');
  });
  api.port = await listen(api.server);
  auth.port = await listen(auth.server);
  firestore.port = await listen(firestore.server);

  faults = createFaults();
  tokens = createTokenLedger();
  frontServer = createQaFront({
    publicHost: HOST,
    staticDir,
    apiRoutes: API_ROUTES,
    targets: {
      api: { host: '127.0.0.1', port: api.port },
      auth: { host: '127.0.0.1', port: auth.port },
      firestore: { host: '127.0.0.1', port: firestore.port },
    },
    firestoreDatabase: DATABASE,
    faults,
    tokens,
    isReady: () => ready,
    log: (line) => logLines.push(line),
  });
  frontPort = await listen(frontServer);
});

test.after(async () => {
  await faults.disarm();
  for (const s of [frontServer, api.server, auth.server, firestore.server]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('host: wrong name, a port, a trailing dot and a missing Host are refused with host_not_served', async () => {
  for (const host of ['evil.example.test', `${HOST}:5000`, `${HOST}.`, 'localhost']) {
    const r = await send({ target: '/', headers: { host } });
    assert.equal(r.status, 404, host);
    assert.deepEqual(JSON.parse(r.body), { error: 'host_not_served' });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  const raw = await sendRaw('GET / HTTP/1.1\r\nConnection: close\r\n\r\n');
  assert.match(raw, /^HTTP\/1\.1 404 /);
  assert.match(raw, /host_not_served/);
});

test('host: X-Forwarded-Host is ignored; the upstream sees host = publicHost', async () => {
  const before = api.received.length;
  const r = await send({ target: '/api/v1/customers', headers: { host: HOST, 'x-forwarded-host': 'evil.example.test' } });
  assert.equal(r.status, 200);
  const seen = api.received[before];
  assert.equal(seen.headers.host, HOST);
  assert.equal(seen.headers['x-forwarded-host'], undefined);
});

test('api: allowlisted route forwards with host rewritten, client forwarding and x-replit-* headers dropped, cookies, CSRF and Set-Cookie intact', async () => {
  const before = api.received.length;
  const cookie = ['__Host-tmpos_session', ['c', process.pid].join('')].join('=');
  const r = await send({
    method: 'POST',
    target: '/api/v1/customers?x=1',
    headers: {
      host: HOST,
      cookie,
      'x-csrf-token': 'csrf-value',
      'x-requested-with': 'tmpos',
      'content-type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-proto': 'https',
      forwarded: 'for=1.2.3.4',
      'x-real-ip': '1.2.3.4',
      'x-replit-user-name': 'someone',
      'x-replit-user-id': '42',
      connection: 'keep-alive, x-drop-me',
      'x-drop-me': 'yes',
    },
    body: JSON.stringify({ name: 'A' }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers['set-cookie'], ['__Host-tmpos_session=s1; Path=/; Secure; HttpOnly; SameSite=Strict']);
  const seen = api.received[before];
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/v1/customers?x=1');
  assert.equal(seen.headers.host, HOST);
  assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(seen.headers.cookie, cookie);
  assert.equal(seen.headers['x-csrf-token'], 'csrf-value');
  assert.equal(seen.headers['x-requested-with'], 'tmpos');
  assert.equal(seen.body, JSON.stringify({ name: 'A' }));
  for (const gone of ['x-forwarded-proto', 'forwarded', 'x-real-ip', 'x-replit-user-name', 'x-replit-user-id', 'x-drop-me']) {
    assert.equal(seen.headers[gone], undefined, gone);
  }
});

test('api: unknown path, wrong method, OPTIONS, HEAD and /health never reach the upstream', async () => {
  const before = api.received.length;
  const cases = [
    ['GET', '/api/v1/nope'], ['DELETE', '/api/v1/customers'], ['OPTIONS', '/api/v1/customers'],
    ['HEAD', '/api/v1/customers'], ['GET', '/api/v1/stores//invoices/x/void'], ['GET', '/api'],
    ['POST', '/api/v1/stores/s/invoices/i/void/extra'],
  ];
  for (const [method, target] of cases) {
    const r = await send({ method, target });
    assert.equal(r.status, 404, `${method} ${target}`);
    if (method !== 'HEAD') assert.deepEqual(JSON.parse(r.body), { error: 'not_found' });
  }
  const health = await send({ target: '/health' });
  assert.notEqual(health.body, JSON.stringify({ ok: true }));
  assert.equal(api.received.length, before);
});

test('api: a body over 128 KiB is refused with 413 before the upstream is contacted', async () => {
  const before = api.received.length;
  const raw = await sendRaw(`POST /api/v1/customers HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: ${128 * 1024 + 1}\r\n\r\n`);
  assert.match(raw, /^HTTP\/1\.1 413 /);
  assert.match(raw, /payload_too_large/);
  assert.equal(api.received.length, before);
});

test('api and identity: not ready answers 503 qa_unavailable with Retry-After and nothing is forwarded', async () => {
  const before = api.received.length + auth.received.length;
  ready = 'resetting';
  try {
    const r = await send({ target: '/api/v1/customers' });
    assert.equal(r.status, 503);
    assert.deepEqual(JSON.parse(r.body), { error: 'qa_unavailable', state: 'resetting' });
    assert.equal(r.headers['retry-after'], '5');
    const id = await send({ method: 'POST', target: SIGN_IN, headers: { host: HOST, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(id.status, 503);
  } finally {
    ready = true;
  }
  assert.equal(api.received.length + auth.received.length, before);
});

test('upstreams down: api 502; held-void 502 with committed unknown (null); released stalled-reauth 502 with upstreamStatus null', async () => {
  // A port that was just free: nothing listens there.
  const probe = net.createServer();
  const port = await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
  await new Promise((r) => probe.close(r));
  const downFaults = createFaults();
  const f = createQaFront({
    publicHost: HOST, staticDir, apiRoutes: API_ROUTES, firestoreDatabase: DATABASE, faults: downFaults, tokens: createTokenLedger(), isReady: () => true,
    targets: { api: { host: '127.0.0.1', port }, auth: { host: '127.0.0.1', port }, firestore: { host: '127.0.0.1', port } },
  });
  const fPort = await listen(f);
  const at = (opts) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: fPort, agent: false, ...opts, headers: { host: HOST, 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (error) => resolve({ error }));
    req.end(opts.body);
  });
  try {
    const r = await at({ method: 'GET', path: '/api/v1/customers' });
    assert.equal(r.status, 502);
    assert.deepEqual(JSON.parse(r.body), { error: 'qa_upstream_unavailable' });

    downFaults.arm({ kind: 'held-void', storeId: STORE, invoiceId: INVOICE, label: 'void-down' });
    const v = await at({ method: 'POST', path: VOID_PATH, body: '{}' });
    assert.equal(v.status, 502);
    const voidEntry = downFaults.snapshot().entries.at(-1);
    assert.equal(voidEntry.label, 'void-down');
    const { committed, upstreamStatus, upstreamError } = voidEntry;
    assert.deepEqual({ committed, upstreamStatus, upstreamError }, { committed: null, upstreamStatus: null, upstreamError: 'unavailable' });

    downFaults.arm({ kind: 'stalled-reauth', email: 'owner@example.test', label: 'reauth-down' });
    const pending = at({ method: 'POST', path: SIGN_IN, body: JSON.stringify({ email: 'owner@example.test' }) });
    await waitFor(() => downFaults.snapshot().held !== null);
    const record = await downFaults.release();
    assert.equal(record.upstreamStatus, null);
    assert.equal(record.deliveredToBrowser, true);
    const s = await pending;
    assert.equal(s.status, 502);
    assert.deepEqual(JSON.parse(s.body), { error: 'qa_upstream_unavailable' });
    assert.equal(downFaults.snapshot().entries.at(-1).upstreamStatus, null);
  } finally {
    await downFaults.disarm();
    f.closeAllConnections?.();
    await new Promise((r2) => f.close(r2));
  }
});

test('identity: the three exact routes forward with cookie, authorization stripped, identity encoding and the emulator host; others are 404', async () => {
  let recorded = null;
  let recordedRefresh = null;
  for (const [method, route] of QA_IDENTITY_ROUTES) {
    const before = auth.received.length;
    const r = await send({
      method,
      target: `${route}?key=fake-key`,
      headers: {
        host: HOST, cookie: 'a=b', 'content-type': 'application/json', 'x-replit-user-name': 'someone',
        authorization: ['Bearer', issue()].join(' '), 'accept-encoding': 'gzip, br',
      },
      // accounts:lookup and the token route are forwarded only for recorded tokens: the sign-in answer just recorded them.
      body: JSON.stringify(route === LOOKUP ? { idToken: recorded }
        : route === TOKEN ? { grant_type: 'refresh_token', refresh_token: recordedRefresh } : { email: 'other@example.test' }),
    });
    assert.equal(r.status, 200, route);
    if (route === SIGN_IN) ({ idToken: recorded, refreshToken: recordedRefresh } = JSON.parse(r.body));
    const seen = auth.received[before];
    assert.equal(seen.url, `${route}?key=fake-key`);
    assert.equal(seen.headers.host, `127.0.0.1:${auth.port}`);
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers['accept-encoding'], 'identity');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers['x-replit-user-name'], undefined);
  }
  const before = auth.received.length;
  for (const [method, target] of [
    ['POST', '/identitytoolkit.googleapis.com/v1/accounts:update'],
    ['GET', SIGN_IN],
    ['POST', '/securetoken.googleapis.com/v1/other'],
  ]) {
    const r = await send({ method, target, body: '{}' });
    assert.equal(r.status, 404, target);
    assert.deepEqual(JSON.parse(r.body), { error: 'not_found' });
  }
  assert.equal(auth.received.length, before);
});

test('firestore: only the Listen channel for the configured database forwards', async () => {
  const before = firestore.received.length;
  const wrong = await send({ target: `${QA_FIRESTORE_LISTEN}?database=${encodeURIComponent('projects/live-project/databases/(default)')}` });
  assert.equal(wrong.status, 404);
  const other = await send({ target: `/google.firestore.v1.Firestore/Write/channel?database=${encodeURIComponent(DATABASE)}` });
  assert.equal(other.status, 404);
  const twice = await send({ target: `${QA_FIRESTORE_LISTEN}?database=${encodeURIComponent(DATABASE)}&database=${encodeURIComponent(DATABASE)}` });
  assert.equal(twice.status, 404);
  assert.equal(firestore.received.length, before);
  const ok = await send({ method: 'POST', target: `${QA_FIRESTORE_LISTEN}?database=${encodeURIComponent(DATABASE)}&VER=8`, headers: { host: HOST, cookie: 'a=b' }, body: 'count=1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'fs-ok');
  const seen = firestore.received[before];
  assert.equal(seen.headers.host, `127.0.0.1:${firestore.port}`);
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.body, 'count=1');
});

test('static: / and SPA routes serve index.html with the CSP and no-store; assets get no-cache', async () => {
  for (const target of ['/', '/customers/directory', '/index.html']) {
    const r = await send({ target });
    assert.equal(r.status, 200, target);
    assert.equal(r.body, INDEX_HTML);
    assert.equal(r.headers['content-security-policy'], QA_CSP);
    assert.match(r.headers['content-security-policy'], /connect-src 'self';/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-frame-options'], undefined);
  }
  const js = await send({ target: '/assets/app.js' });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['cache-control'], 'no-cache');
  assert.equal(js.headers['content-security-policy'], undefined);
  const post = await send({ method: 'POST', target: '/' });
  assert.equal(post.status, 404);
});

test('static: traversal, dotfiles, sources, maps, /__ and symlink escapes are 404 and never leak bytes', async () => {
  const targets = [
    '/../package.json', '/%2e%2e/package.json', '/%2E%2E/package.json', '/assets/..%2fpackage.json',
    '/.env', '/.git/config', '/src/main.tsx', '/assets/x.js.map', '/__qa/status', '/leak.txt',
    '/assets/%5c..%5cpackage.json', '/assets/missing.js', '/a%00b', '/assets/.hidden.js',
  ];
  for (const target of targets) {
    const r = await send({ target });
    assert.equal(r.status, 404, target);
    assert.ok(!r.body.includes(OUTSIDE_SECRET_TEXT), target);
    assert.ok(!r.body.includes(INDEX_HTML), target);
  }
  const absolute = await sendRaw(`GET http://${HOST}/ HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
  assert.match(absolute, /^HTTP\/1\.1 400 /);
  assert.match(absolute, /bad_request/);
});

test('log lines carry the path but never the query string or headers', async () => {
  logLines.length = 0;
  await send({ target: '/api/v1/customers?token=abc123', headers: { host: HOST, cookie: 'k=cookie-value' } });
  await waitFor(() => logLines.length > 0);
  const line = logLines.join('\n');
  assert.match(line, /^GET api 200 \d+ms \/api\/v1\/customers$/m);
  assert.ok(!line.includes('abc123') && !line.includes('cookie-value'));
});

test('fault held-void: the upstream commits, the browser socket is destroyed, then one shot only', async () => {
  faults.arm({ kind: 'held-void', storeId: STORE, invoiceId: INVOICE, label: 'void-1' });
  assert.throws(() => faults.arm({ kind: 'held-void', storeId: STORE, invoiceId: INVOICE, label: 'again' }));
  const other = await send({ target: '/api/v1/customers' });
  assert.equal(other.status, 200, 'other requests are unaffected');
  const before = api.received.length;
  const first = await send({ method: 'POST', target: VOID_PATH, headers: { host: HOST, 'content-type': 'application/json' }, body: '{"reason":"x"}' });
  assert.ok(first.error, 'no response at all');
  assert.equal(first.status, undefined);
  assert.equal(api.received.length, before + 1);
  assert.equal(api.received[before].body, '{"reason":"x"}');
  const snap = faults.snapshot();
  assert.equal(snap.armed, null);
  const entry = snap.entries.at(-1);
  assert.equal(entry.kind, 'held-void');
  assert.equal(entry.label, 'void-1');
  assert.equal(entry.upstreamStatus, 200);
  assert.equal(entry.committed, true);
  const second = await send({ method: 'POST', target: VOID_PATH, headers: { host: HOST, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(second.body), { voided: true });
});

const signIn = (email) => send({
  method: 'POST',
  target: `${SIGN_IN}?key=fake-key`,
  headers: { host: HOST, 'content-type': 'application/json' },
  body: JSON.stringify({ email, password: ['pw', process.pid, Date.now()].join('-'), returnSecureToken: true }),
});

test('fault stalled-reauth: held until release(), which delivers the emulator answer', async () => {
  faults.arm({ kind: 'stalled-reauth', email: 'owner@example.test', label: 'reauth-1' });
  const before = auth.received.length;
  const arrivedBefore = auth.arrived;
  const pending = signIn('Owner@Example.test');
  await waitFor(() => faults.snapshot().held !== null);
  // Barrier: a later sign-in completes a full round trip; the held one, opened first, has still not arrived.
  const later = await signIn('clerk@example.test');
  assert.equal(later.status, 200);
  assert.equal(auth.arrived, arrivedBefore + 1, 'not forwarded while held');
  assert.equal(auth.received.length, before + 1);
  assert.throws(() => faults.arm({ kind: 'held-void', storeId: STORE, invoiceId: INVOICE, label: 'x' }));
  const record = await faults.release();
  assert.equal(record.upstreamStatus, 200);
  assert.equal(record.deliveredToBrowser, true);
  const r = await pending;
  assert.equal(r.status, 200);
  assert.ok(tokens.has(JSON.parse(r.body).idToken), 'the released sign-in answer was recorded');
  assert.equal(auth.received.length, before + 2);
  const snap = faults.snapshot();
  assert.equal(snap.held, null);
  assert.ok(!JSON.stringify(snap).includes('"pw-'), 'no password recorded');
  assert.deepEqual(await faults.release(), { released: false });
});

test('fault stalled-reauth: a browser that leaves is recorded and gets nothing on release', async () => {
  faults.arm({ kind: 'stalled-reauth', email: 'owner@example.test', label: 'reauth-2' });
  const before = auth.received.length;
  const req = http.request({ host: '127.0.0.1', port: frontPort, method: 'POST', path: SIGN_IN, agent: false, setHost: false, headers: { host: HOST, 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ email: 'owner@example.test', password: ['pw', process.pid].join('-') }));
  await waitFor(() => faults.snapshot().held !== null);
  req.destroy();
  await waitFor(() => faults.snapshot().held?.browserLeftAt);
  const record = await faults.release();
  assert.equal(record.upstreamStatus, 200);
  assert.equal(record.deliveredToBrowser, false);
  assert.equal(auth.received.length, before + 1);
  const entry = faults.snapshot().entries.at(-1);
  assert.equal(entry.label, 'reauth-2');
  assert.ok(entry.browserLeftAt);
  assert.equal(entry.deliveredToBrowser, false);
});

test('fault stalled-reauth: a different email passes straight through; disarm clears the fault', async () => {
  faults.arm({ kind: 'stalled-reauth', email: 'owner@example.test', label: 'reauth-3' });
  const before = auth.received.length;
  const r = await signIn('clerk@example.test');
  assert.equal(r.status, 200);
  assert.equal(auth.received.length, before + 1);
  assert.equal(faults.snapshot().armed.kind, 'stalled-reauth');
  await faults.disarm();
  assert.equal(faults.snapshot().armed, null);
  const after = await signIn('owner@example.test');
  assert.equal(after.status, 200);
});

const refusalCode = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof QaRefusal);
    return err.code;
  }
  return null;
};

test('ownership: postmaster.pid is read strictly and a database server must name exactly its data directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmpos-qa-pm-'));
  const dataDir = path.join(dir, 'data');
  // A stand-in with a postgres server's argv shape: `<bin>/postgres … -D <dataDir>`.
  const stand = (args) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', ...args], { argv0: '/opt/pg/bin/postgres', stdio: 'ignore' });
  const child = stand(['-D', dataDir]);
  const twice = stand(['-D', dataDir, '-D', `${dir}/elsewhere`]); // postgres would honour the later -D
  try {
    assert.equal(readPostmasterPid(dir), null, 'missing file');
    // pg_ctl reads a numeric prefix into a C long, so anything but a plain in-range decimal pid must not read as one.
    for (const [text, want] of [['4242\n/x/data\n', 4242], [' 4242 \r\n', 4242], ['4194304\n', 4194304], ['4242junk\n', undefined], ['0x7b\n', undefined], ['1e3\n', undefined], ['\n', undefined], ['1\n', undefined], ['-5\n', undefined], ['4194305\n', undefined], ['4294967297\n', undefined]]) {
      fs.writeFileSync(path.join(dir, 'postmaster.pid'), text);
      assert.equal(readPostmasterPid(dir), want, JSON.stringify(text));
    }
    fs.rmSync(path.join(dir, 'postmaster.pid'));
    fs.mkdirSync(path.join(dir, 'postmaster.pid')); // present but unreadable as a file: not "missing"
    assert.equal(readPostmasterPid(dir), undefined, 'unreadable file');
    for (const p of [child, twice]) {
      for (const until = Date.now() + 5000; Date.now() < until && !fs.readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').includes(dataDir);) await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(postgresOn(child.pid, dataDir), true);
    assert.equal(postgresOn(child.pid, `${dataDir}-other`), false, 'a longer directory');
    assert.equal(postgresOn(child.pid, dir), false, 'the parent directory');
    assert.equal(postgresOn(twice.pid, dataDir), false, 'a second -D');
    assert.equal(postgresOn(process.pid, dataDir), false, 'not a postgres server');
  } finally {
    child.kill();
    twice.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: every refusal code', () => {
  const env = { REPLIT_DEV_DOMAIN: 'abc.worf.replit.dev' };
  const dbUrl = ['postgres', '://u:p@h/db'].join('');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env, args: ['--database-url', dbUrl] })), 'unknown_option');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env, args: [`--database-url=${dbUrl}`] })), 'unknown_option');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env, args: ['--project'] })), 'unknown_option');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env: { ...env, TM_POS_TEST_DATABASE_URL: dbUrl }, args: [] })), 'ambient_database');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env, args: ['--project', 'tmpos-prod'] })), 'not_demo_project');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env, args: ['--project=demo-'] })), 'not_demo_project');
  for (const origin of ['http://abc.worf.replit.dev', 'https://u@abc.worf.replit.dev', 'https://abc.worf.replit.dev:8443',
    'https://abc.worf.replit.dev/x', 'https://abc.worf.replit.dev/?q', 'https://abc.worf.replit.dev/#h', 'not a url', 'https://1.2.3.4']) {
    assert.equal(refusalCode(() => resolveLaunchConfig({ env: {}, args: ['--origin', origin] })), 'origin_invalid', origin);
  }
  assert.equal(refusalCode(() => resolveLaunchConfig({ env: { REPLIT_DEV_DOMAIN: 'bad_host' }, args: [] })), 'origin_invalid');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env, args: ['--origin', 'https://other.replit.dev'] })), 'origin_mismatch');
  assert.equal(refusalCode(() => resolveLaunchConfig({ env: {}, args: [] })), 'origin_missing');
  const leaked = refusalCode(() => resolveLaunchConfig({ env, args: [`--database-url=${dbUrl}`] }));
  assert.equal(leaked, 'unknown_option');
  try {
    resolveLaunchConfig({ env, args: [`--database-url=${dbUrl}`] });
  } catch (err) {
    assert.ok(!err.message.includes(dbUrl), 'an unknown option value is never echoed');
  }
});

test('config: a valid REPLIT_DEV_DOMAIN yields the https origin; a matching --origin is accepted', () => {
  const cfg = resolveLaunchConfig({ env: { REPLIT_DEV_DOMAIN: '  ABC.worf.Replit.dev ' }, args: [] });
  assert.deepEqual({ ...cfg }, { publicHost: 'abc.worf.replit.dev', publicOrigin: 'https://abc.worf.replit.dev', projectId: QA_PROJECT_ID });
  const both = resolveLaunchConfig({ env: { REPLIT_DEV_DOMAIN: 'abc.worf.replit.dev' }, args: ['--origin=https://abc.worf.replit.dev/', '--project', 'demo-other'] });
  assert.equal(both.publicOrigin, 'https://abc.worf.replit.dev');
  assert.equal(both.projectId, 'demo-other');
  const onlyArg = resolveLaunchConfig({ env: {}, args: ['--origin', 'https://abc.worf.replit.dev'] });
  assert.equal(onlyArg.publicHost, 'abc.worf.replit.dev');
});

test('config: javaMajor reads the major version, the legacy 1.x form included', () => {
  const table = [
    ['openjdk version "21.0.9" 2025-10-21', 21],
    ['openjdk version "17.0.2" 2022-01-18', 17],
    ['java version "1.8.0_401"', 8],
    ['garbage', null],
    ['', null],
  ];
  for (const [text, major] of table) assert.equal(javaMajor(text), major, text);
});

test('config: assertMemoryHeadroom reads MemAvailable and fails closed', () => {
  const meminfo = (kb) => `MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:    ${kb} kB\n`;
  assert.equal(assertMemoryHeadroom(meminfo(2048 * 1024)), 2048);
  assert.equal(refusalCode(() => assertMemoryHeadroom(meminfo(1000 * 1024))), 'low_memory');
  assert.equal(refusalCode(() => assertMemoryHeadroom('MemTotal: 1 kB\n')), 'low_memory');
  assert.equal(assertMemoryHeadroom(meminfo(600 * 1024), 500), 600);
});

test('config: findLiveConfigLeaks names the file with a planted value and never echoes it', () => {
  const planted = ['live', 'value', process.pid, Date.now()].join('-');
  const files = [
    { name: 'clean.txt', text: 'nothing here' },
    { name: 'dirty.txt', text: `prefix ${planted} suffix` },
  ];
  const found = findLiveConfigLeaks(files, [planted, '', 'ab']);
  assert.deepEqual(found, ['dirty.txt']);
  assert.ok(!JSON.stringify(found).includes(planted));
  assert.deepEqual(findLiveConfigLeaks({ 'a.txt': planted }, [planted]), ['a.txt']);
  assert.deepEqual(findLiveConfigLeaks(files, []), []);
});

// ---- issued-token ledger, emulator credentials, request hygiene ----

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** An unsigned (alg 'none') token shaped like the Auth emulator's, for `uid`. */
function emulatorShaped(uid, { lifetime = 3600, iatAhead = 0 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://securetoken.google.com/${QA_PROJECT_ID}`, aud: QA_PROJECT_ID, sub: uid, user_id: uid,
    iat: now + iatAhead, auth_time: now, exp: now + iatAhead + lifetime, firebase: { sign_in_provider: 'password' },
  };
  return [b64({ alg: 'none', typ: 'JWT' }), b64(claims), ''].join('.');
}

test('verifier: a forged token for a seeded uid is refused without any lookup; a recorded one reaches lookup; over one hour is refused', async () => {
  const ledger = createTokenLedger();
  const lookups = [];
  const { verifier } = createQaVerifier({
    projectId: QA_PROJECT_ID, apiKey: 'k', accepts: (uid) => uid === 'u1', tokens: ledger,
    lookup: async (_key, token) => { lookups.push(token); return 'u1'; },
  });
  const forged = emulatorShaped('u1');
  await assert.rejects(verifier.verify(forged), { code: 'auth/invalid-id-token' });
  assert.equal(lookups.length, 0, 'the forged token never reached the emulator');

  ledger.record(forged);
  const ok = await verifier.verify(forged);
  assert.equal(ok.uid, 'u1');
  assert.deepEqual(lookups, [forged]);

  const long = emulatorShaped('u1', { lifetime: 3601 });
  ledger.record(long);
  await assert.rejects(verifier.verify(long), { code: 'auth/invalid-id-token' });
  assert.equal(lookups.length, 1, 'refused before lookup');

  // A future iat inside the one-hour bound would still stretch exp past it.
  const ahead = emulatorShaped('u1', { iatAhead: 3000 });
  ledger.record(ahead);
  await assert.rejects(verifier.verify(ahead), { code: 'auth/invalid-id-token' });
  assert.equal(lookups.length, 1, 'future iat refused before lookup');
  assert.equal(ledger.has(forged, 'refresh'), false, 'an ID token is not a refresh token');
  assert.throws(() => createQaVerifier({ projectId: QA_PROJECT_ID, apiKey: 'k', accepts: () => true }), TypeError);
});

test('verifier: an emulator outage (lookup 5xx) is not a credential verdict; a 4xx is no account', async () => {
  const ledger = createTokenLedger();
  const token = emulatorShaped('u1');
  ledger.record(token);
  const notVerdict = (err) => {
    assert.notEqual(err.code, 'auth/invalid-id-token');
    return true;
  };
  const stubbed = createQaVerifier({
    projectId: QA_PROJECT_ID, apiKey: 'k', accepts: () => true, tokens: ledger,
    lookup: async () => { throw new Error('accounts:lookup: emulator answered 503'); },
  });
  await assert.rejects(stubbed.verifier.verify(token), notVerdict);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(lookupToken('k', token), /answered 503/);
    const { verifier } = createQaVerifier({ projectId: QA_PROJECT_ID, apiKey: 'k', accepts: () => true, tokens: ledger });
    await assert.rejects(verifier.verify(token), notVerdict);
    globalThis.fetch = async () => new Response('{}', { status: 400 });
    assert.equal(await lookupToken('k', token), null);
    await assert.rejects(verifier.verify(token), { code: 'auth/invalid-id-token' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** A token-route request as the SDK sends it: a form body. */
const refresh = (fields, query = '') => ({
  method: 'POST', target: `${TOKEN}?key=fake-key${query}`,
  headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});

test('ledger: sign-in and token-refresh 200s through the front are recorded, refresh tokens included', async () => {
  const s = await signIn('ledger@example.test');
  assert.equal(s.status, 200);
  const signedIn = JSON.parse(s.body);
  assert.ok(tokens.has(signedIn.idToken));
  assert.ok(tokens.has(signedIn.refreshToken, 'refresh'));
  const before = auth.arrived;
  const t = await send(refresh({ grant_type: 'refresh_token', refresh_token: signedIn.refreshToken }));
  assert.equal(t.status, 200);
  assert.equal(auth.arrived, before + 1, 'the sign-in refresh token was forwarded');
  const refreshed = JSON.parse(t.body);
  assert.ok(tokens.has(refreshed.id_token));
  // The refresh token in a token answer is recorded too: the next refresh uses it.
  const again = await send(refresh({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token }));
  assert.equal(again.status, 200);
  assert.equal(tokens.has(issue()), false, 'an unissued value is not in the ledger');
});

test('refresh: hand-made, ID-token, query-borne, doubled and oddly spelt refresh tokens never reach the emulator', async () => {
  const { idToken, refreshToken } = JSON.parse((await signIn('refresh@example.test')).body);
  // Shaped like the emulator's own refresh token record (base64 JSON naming the project and a seeded account).
  const handMade = Buffer.from(JSON.stringify({ projectId: QA_PROJECT_ID, localId: 'u1', provider: 'password' })).toString('base64');
  const grant = { grant_type: 'refresh_token' };
  const before = auth.arrived;
  const cases = [
    refresh({ ...grant, refresh_token: handMade }),
    refresh({ ...grant, refresh_token: idToken }),
    refresh({ ...grant, refresh_token: refreshToken }, `&refresh_token=${encodeURIComponent(refreshToken)}`),
    refresh({ refresh_token: refreshToken }, '&grant_type=refresh_token'),
    refresh([['grant_type', 'refresh_token'], ['refresh_token', refreshToken], ['refresh_token', refreshToken]]),
    refresh({ ...grant, refresh_token: refreshToken, refreshToken: handMade }),
    refresh({ ...grant, refresh_token: refreshToken, 'Refresh-Token': handMade }),
    refresh(grant),
    { ...refresh({ ...grant, refresh_token: refreshToken }), headers: { host: HOST, 'content-type': 'text/plain' } },
    { method: 'POST', target: `${TOKEN}?key=k`, headers: { host: HOST, 'content-type': 'application/json' }, body: JSON.stringify({ grantType: 'refresh_token', refreshToken: idToken }) },
    { method: 'POST', target: `${TOKEN}?key=k`, headers: { host: HOST, 'content-type': 'application/json' }, body: '[]' },
    // A refresh token is not an ID token either.
    { method: 'POST', target: `${LOOKUP}?key=k`, headers: { host: HOST, 'content-type': 'application/json' }, body: JSON.stringify({ idToken: refreshToken }) },
  ];
  for (const [i, c] of cases.entries()) {
    const r = await send(c);
    assert.equal(r.status, 404, `case ${i}`);
    assert.deepEqual(JSON.parse(r.body), { error: 'not_found' });
  }
  assert.equal(auth.arrived, before);
  const asJson = await send({
    method: 'POST', target: `${TOKEN}?key=k`, headers: { host: HOST, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grantType: 'refresh_token', refreshToken }),
  });
  assert.equal(asJson.status, 200, 'a JSON body with a recorded refresh token is forwarded');
  assert.equal(auth.arrived, before + 1);
  assert.equal(auth.received.at(-1).url, `${TOKEN}?key=k`);
});

test('ledger: a 200 sign-in with no recordable token is logged without the token', async () => {
  logLines.length = 0;
  const r = await signIn('unrecordable@example.test');
  assert.equal(r.status, 200);
  const { idToken } = JSON.parse(r.body);
  assert.equal(tokens.has(idToken), false);
  assert.ok(logLines.includes(`identity 200 without a recordable token (${SIGN_IN})`), logLines.join('\n'));
  assert.ok(!logLines.some((l) => l.includes(idToken)));
});

test('credentials: Bearer owner, unrecorded lookups, Listen overrides and stray $httpHeaders never reach an emulator', async () => {
  const owner = ['Bearer', 'owner'].join(' ');
  const listen = (extra = '') => `${QA_FIRESTORE_LISTEN}?database=${encodeURIComponent(DATABASE)}${extra}`;
  const override = (line) => `&$httpHeaders=${encodeURIComponent(line)}`;
  const authBefore = auth.arrived;
  const fsBefore = firestore.arrived;
  const apiBefore = api.arrived;
  const refusedCases = [
    { method: 'POST', target: `${LOOKUP}?key=k`, headers: { host: HOST, authorization: owner }, body: JSON.stringify({ idToken: issue() }) },
    { method: 'POST', target: `${LOOKUP}?key=k`, headers: { host: HOST, 'content-type': 'application/json' }, body: JSON.stringify({ idToken: issue() }) },
    { method: 'POST', target: `${LOOKUP}?key=k`, headers: { host: HOST, 'content-type': 'application/json' }, body: '{}' },
    { method: 'POST', target: listen(override(`Authorization: ${owner}\r\n`)), body: 'count=1' },
    { method: 'POST', target: listen(override(`authorization:Bearer ${issue()}`)), body: 'count=1' },
    { method: 'POST', target: listen(), headers: { host: HOST, authorization: owner }, body: 'count=1' },
    { method: 'GET', target: listen(), headers: { host: HOST, authorization: ['Bearer', issue()].join(' ') } },
    { method: 'GET', target: `/api/v1/customers${override('X-A: b').replace('&', '?')}` },
    { method: 'POST', target: `${SIGN_IN}${override('X-A: b').replace('&', '?')}`, body: '{}' },
    { method: 'GET', target: '/api/v1/customers', headers: { host: HOST, authorization: owner } },
    { method: 'GET', target: `/api/v1/customers?$HTTPHEADERS=${encodeURIComponent('X-A: b')}` },
    // Listen: a literal ';', another spelling of $httpHeaders, a bare CR hiding a header line.
    { method: 'POST', target: listen('&x=a;b'), body: 'count=1' },
    { method: 'POST', target: listen(`&$HttpHeaders=${encodeURIComponent(`Authorization: Bearer ${issue()}`)}`), body: 'count=1' },
    { method: 'POST', target: listen(`&%24httpheaders=${encodeURIComponent(`Authorization: Bearer ${issue()}`)}`), body: 'count=1' },
    { method: 'POST', target: listen(override(`X-A: b\rAuthorization: Bearer ${issue()}`)), body: 'count=1' },
  ];
  for (const c of refusedCases) {
    const r = await send(c);
    assert.equal(r.status, 404, `${c.method} ${c.target}`);
    assert.deepEqual(JSON.parse(r.body), { error: 'not_found' });
  }
  assert.equal(auth.arrived, authBefore);
  assert.equal(firestore.arrived, fsBefore);
  assert.equal(api.arrived, apiBefore);

  const s = await signIn('creds@example.test');
  const recorded = JSON.parse(s.body).idToken;
  const lookup = await send({ method: 'POST', target: `${LOOKUP}?key=k`, headers: { host: HOST, 'content-type': 'application/json' }, body: JSON.stringify({ idToken: recorded }) });
  assert.equal(lookup.status, 200);
  assert.equal(auth.received.at(-1).url, `${LOOKUP}?key=k`);
  const ok = await send({ method: 'POST', target: listen(override(`X-Goog-Api-Client: x\r\nAuthorization: Bearer ${recorded}\r\n`)), body: 'count=1' });
  assert.equal(ok.status, 200);
  const bare = await send({ method: 'POST', target: listen(), body: 'count=1' });
  assert.equal(bare.status, 200, 'the SDK before sign-in carries no Authorization');
  assert.equal(firestore.arrived, fsBefore + 2);
});

test('hygiene: GET with a chunked body or a content-length is 400 and reaches nothing', async () => {
  const before = api.arrived + firestore.arrived;
  const chunked = await sendRaw(`GET /api/v1/customers HTTP/1.1\r\nHost: ${HOST}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n`);
  assert.match(chunked, /^HTTP\/1\.1 400 /);
  assert.match(chunked, /bad_request/);
  const sized = await sendRaw(`GET ${QA_FIRESTORE_LISTEN}?database=${encodeURIComponent(DATABASE)} HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`);
  assert.match(sized, /^HTTP\/1\.1 400 /);
  const head = await sendRaw(`HEAD / HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc`);
  assert.match(head, /^HTTP\/1\.1 400 /);
  assert.equal(api.arrived + firestore.arrived, before);
});

test('api: a chunked body over 128 KiB is refused and the upstream never receives a complete body', async () => {
  const arrivedBefore = api.arrived;
  const settledBefore = api.settled;
  const receivedBefore = api.received.length;
  const r = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: frontPort, method: 'POST', path: '/api/v1/customers', agent: false, setHost: false,
      headers: { host: HOST, 'content-type': 'application/json' }, // no length: node sends it chunked
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
      res.on('error', (error) => resolve({ error }));
    });
    req.on('error', (error) => resolve({ error }));
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    for (let i = 0; i < 9; i += 1) req.write(chunk);
    req.end();
  });
  assert.ok(r.status === 413 || r.error, `413 or a cut connection, got ${r.status}`);
  // Every request the upstream saw begin has ended or been cut; none of them completed.
  await waitFor(() => api.settled - settledBefore === api.arrived - arrivedBefore);
  assert.equal(api.received.length, receivedBefore);
});

test('host: the upper-case public host is served; a comma list is refused', async () => {
  const upper = await send({ target: '/', headers: { host: HOST.toUpperCase() } });
  assert.equal(upper.status, 200);
  assert.equal(upper.body, INDEX_HTML);
  const listed = await send({ target: '/', headers: { host: `${HOST}, evil.example.test` } });
  assert.equal(listed.status, 404);
  assert.deepEqual(JSON.parse(listed.body), { error: 'host_not_served' });
});

test('api: encoded separators and dot segments are 404 with no upstream call', async () => {
  const before = api.arrived;
  for (const target of ['/api/v1/customers%2f..%2fx', '/api%2Fv1/customers', '/api/v1/%2e%2e/health', '/api/v1/%2E%2E/customers']) {
    const r = await send({ target });
    assert.equal(r.status, 404, target);
  }
  assert.equal(api.arrived, before);
});

test('api: response hop-by-hop headers (Connection-listed, Keep-Alive) are stripped; Set-Cookie passes', async () => {
  const r = await send({ target: '/api/v1/customers?hop=1' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-foo'], undefined);
  assert.notEqual(r.headers['keep-alive'], 'timeout=77');
  assert.notEqual(r.headers.connection, 'x-foo');
  assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/']);
});

test('identity: lookup bodies name idToken alone; content types are exact and re-sent bare; compressed bodies are refused', async () => {
  const { idToken, refreshToken } = JSON.parse((await signIn('types@example.test')).body);
  const other = JSON.parse((await signIn('types-other@example.test')).body).idToken;
  const post = (target, type, body, extra = {}) => ({
    method: 'POST', target: `${target}?key=k`, headers: { host: HOST, 'content-type': type, ...extra }, body,
  });
  const form = (fields) => new URLSearchParams(fields).toString();
  const grant = { grant_type: 'refresh_token', refresh_token: refreshToken };
  const before = auth.arrived;
  const cases = [
    // The emulator camel-cases every key, last wins: `id_token` would be the token it looks up.
    post(LOOKUP, 'application/json', JSON.stringify({ idToken, id_token: other })),
    post(LOOKUP, 'application/json', JSON.stringify({ idToken, IdToken: other })),
    post(LOOKUP, 'application/json', JSON.stringify({ idToken, extra: 1 })),
    post(LOOKUP, 'application/json', JSON.stringify([{ idToken }])),
    post(LOOKUP, 'application/x-www-form-urlencoded', form({ idToken })),
    post(LOOKUP, 'application/json; charset=latin1', JSON.stringify({ idToken })),
    post(TOKEN, 'application/x-www-form-urlencoded; encoding=utf16le', form(grant)),
    post(TOKEN, 'application/x-www-form-urlencoded; charset=latin1', form(grant)),
    post(TOKEN, 'application/x-www-form-urlencoded; charset=utf-8; encoding=utf16le', form(grant)),
    post(TOKEN, 'text/plain', form(grant)),
    post(SIGN_IN, 'application/json', JSON.stringify({ email: 'types@example.test' }), { 'content-encoding': 'gzip' }),
    post(SIGN_IN, 'application/json; encoding=utf16le', JSON.stringify({ email: 'types@example.test' })),
    post(SIGN_IN, 'text/plain', JSON.stringify({ email: 'types@example.test' })),
    { method: 'POST', target: `${SIGN_IN}?key=k`, headers: { host: HOST }, body: '{}' },
  ];
  for (const [i, c] of cases.entries()) {
    const r = await send(c);
    assert.equal(r.status, 404, `case ${i}`);
    assert.deepEqual(JSON.parse(r.body), { error: 'not_found' });
  }
  assert.equal(auth.arrived, before, 'no refused request reached the emulator');

  const lookup = await send(post(LOOKUP, 'Application/JSON; Charset=UTF-8', JSON.stringify({ idToken }), { 'content-encoding': 'identity' }));
  assert.equal(lookup.status, 200);
  assert.equal(auth.received.at(-1).headers['content-type'], 'application/json', 'the forwarded type is rebuilt bare');
  const refreshed = await send(post(TOKEN, 'application/x-www-form-urlencoded; charset=utf-8', form(grant)));
  assert.equal(refreshed.status, 200);
  assert.equal(auth.received.at(-1).headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(auth.arrived, before + 2);
});
