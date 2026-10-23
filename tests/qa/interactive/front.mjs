// QA-INTERACTIVE-P1 — the only public listener of an interactive QA session.
//
// A refuse-by-default reverse proxy in front of loopback-only upstreams: the real tenant runtime
// (/api/v1, allowlisted routes only), the Firebase Auth emulator (three exact REST routes) and the
// Firestore emulator (the Listen channel for one database). Everything else is the static QA bundle
// or a bounded refusal. Upstream targets are fixed by the supervisor and never derived from a request.
// The two one-shot fault hooks are armed only through `createFaults()` (the supervisor's private
// control channel); nothing over HTTP can arm, read or release them.
// Emulator credentials: every ID and refresh token the Auth emulator issues through the front is
// recorded in the run's ledger (`tokens`, tokens.mjs); accounts:lookup and the Listen channel accept
// only recorded ID tokens, the token route only a recorded refresh token, no Authorization header
// reaches the Auth emulator, and the emulators' admin literal (`Bearer owner`) passes no route. Identity bodies are
// read as raw bytes, so they must be uncompressed and of an exact content type, re-sent without parameters.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import querystring from 'node:querystring';
import { Transform, pipeline } from 'node:stream';

export const QA_IDENTITY_ROUTES = Object.freeze([
  Object.freeze(['POST', '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword']),
  Object.freeze(['POST', '/identitytoolkit.googleapis.com/v1/accounts:lookup']),
  Object.freeze(['POST', '/securetoken.googleapis.com/v1/token']),
]);
export const QA_FIRESTORE_LISTEN = '/google.firestore.v1.Firestore/Listen/channel';
export const QA_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https://i.pravatar.cc https://picsum.photos https://fastly.picsum.photos; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; worker-src 'self' blob:";

const SIGN_IN_PATH = QA_IDENTITY_ROUTES[0][1];
const LOOKUP_PATH = QA_IDENTITY_ROUTES[1][1];
const TOKEN_PATH = QA_IDENTITY_ROUTES[2][1];
// The emulator decodes a body by any `charset`/`encoding` parameter of its content type, so only these bare types (with
// at most `charset=utf-8`) are accepted, and the type forwarded is rebuilt without parameters.
const IDENTITY_TYPES = new Map([
  [SIGN_IN_PATH, ['application/json']],
  [LOOKUP_PATH, ['application/json']],
  [TOKEN_PATH, ['application/x-www-form-urlencoded', 'application/json']],
]);
const ADMIN_BEARER = /^\s*bearer\s+owner\s*$/i;
const IDENTITY_PREFIXES = ['/identitytoolkit.googleapis.com/', '/securetoken.googleapis.com/'];
const FIRESTORE_PREFIX = '/google.firestore.v1.Firestore/';
const API_CAP = 128 * 1024;
const IDENTITY_CAP = 64 * 1024;
const FIRESTORE_CAP = 256 * 1024;
const API_TIMEOUT_MS = 30_000;
const IDENTITY_TIMEOUT_MS = 30_000;
const FIRESTORE_TIMEOUT_MS = 70_000;
const MAX_ENTRIES = 50;
// The token route's body may name only these (the SDK sends grant_type and refresh_token); the emulator camel-cases
// every key, so any other spelling could carry a second refresh token past the ledger check.
const REFRESH_KEYS = new Set(['refresh_token', 'refreshToken']);
const GRANT_KEYS = new Set(['grant_type', 'grantType']);
const REFRESH_QUERY = /^(refresh[_-]?token|grant[_-]?type)$/i;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);
const BASE_HEADERS = Object.freeze({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});
const HOST_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const LABEL_SHAPE = /^[A-Za-z0-9 ._:-]{1,80}$/;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

// The front reaches the fault state through this symbol; the returned object's public surface
// stays arm/disarm/release/snapshot.
const HOOKS = Symbol('qaFaultHooks');

const nowIso = () => new Date().toISOString();

export function createFaults() {
  let armed = null;
  let held = null; // { entry, label, heldAt, deliver: async () => record }
  const entries = [];

  const push = (entry) => {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    return entry;
  };

  async function release() {
    if (!held) return { released: false };
    const current = held;
    held = null;
    return current.deliver();
  }

  const faults = {
    arm(spec) {
      if (armed || held) throw new Error('a fault is already armed or a sign-in is held');
      if (!spec || typeof spec !== 'object') throw new TypeError('fault spec required');
      const label = spec.label;
      if (typeof label !== 'string' || !LABEL_SHAPE.test(label)) throw new TypeError('label must be 1-80 plain characters');
      if (spec.kind === 'held-void') {
        if (!ID_SHAPE.test(String(spec.storeId ?? '')) || !ID_SHAPE.test(String(spec.invoiceId ?? ''))) {
          throw new TypeError('storeId and invoiceId must be plain ids');
        }
        armed = Object.freeze({ kind: 'held-void', storeId: spec.storeId, invoiceId: spec.invoiceId, label });
      } else if (spec.kind === 'stalled-reauth') {
        const email = typeof spec.email === 'string' ? spec.email.trim().toLowerCase() : '';
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) throw new TypeError('email required');
        armed = Object.freeze({ kind: 'stalled-reauth', email, label });
      } else {
        throw new TypeError('unknown fault kind');
      }
      return { ...armed };
    },
    async disarm() {
      armed = null;
      return release();
    },
    release,
    snapshot() {
      return {
        armed: armed ? { ...armed } : null,
        held: held ? { label: held.label, heldAt: held.heldAt, browserLeftAt: held.entry.browserLeftAt } : null,
        entries: entries.map((e) => ({ ...e })),
      };
    },
  };

  Object.defineProperty(faults, HOOKS, {
    value: Object.freeze({
      // One shot: the matching request takes the fault.
      takeVoid(method, rawPath) {
        if (!armed || armed.kind !== 'held-void' || method !== 'POST') return null;
        if (rawPath !== `/api/v1/stores/${armed.storeId}/invoices/${armed.invoiceId}/void`) return null;
        const taken = armed;
        armed = null;
        return {
          // committed: true for a 200, false for another real status, null (unknown) when no answer came.
          record(upstreamStatus, upstreamError = null) {
            const committed = upstreamStatus === null ? null : upstreamStatus === 200;
            push({ kind: taken.kind, label: taken.label, at: nowIso(), upstreamStatus, committed, upstreamError });
          },
        };
      },
      takeReauth(email) {
        if (!armed || armed.kind !== 'stalled-reauth' || typeof email !== 'string') return null;
        if (email.trim().toLowerCase() !== armed.email) return null;
        const taken = armed;
        armed = null;
        return taken;
      },
      hold(taken, deliver) {
        const entry = push({ kind: taken.kind, label: taken.label, heldAt: nowIso(), browserLeftAt: null });
        held = { entry, label: taken.label, heldAt: entry.heldAt, deliver: () => deliver(entry) };
        return entry;
      },
    }),
  });
  return faults;
}

export function createQaFront(options) {
  const { publicHost, staticDir, apiRoutes, targets, firestoreDatabase, faults, isReady, tokens } = options ?? {};
  const logTo = typeof options?.log === 'function' ? options.log : () => {};
  const log = (line) => {
    try {
      logTo(line);
    } catch { /* a broken logger must not take the front down */ }
  };
  if (typeof publicHost !== 'string' || !HOST_SHAPE.test(publicHost)) throw new TypeError('publicHost must be a lower-case hostname');
  if (typeof staticDir !== 'string' || !path.isAbsolute(staticDir)) throw new TypeError('staticDir must be absolute');
  if (!Array.isArray(apiRoutes)) throw new TypeError('apiRoutes must be an array');
  for (const name of ['api', 'auth', 'firestore']) {
    const t = targets?.[name];
    if (!t || t.host !== '127.0.0.1' || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535) {
      throw new TypeError(`targets.${name} must be { host: '127.0.0.1', port }`);
    }
  }
  if (typeof firestoreDatabase !== 'string' || !firestoreDatabase) throw new TypeError('firestoreDatabase required');
  if (typeof isReady !== 'function') throw new TypeError('isReady must be a function');
  const hooks = faults?.[HOOKS];
  if (!hooks) throw new TypeError('faults must come from createFaults()');
  if (!tokens || typeof tokens.has !== 'function' || typeof tokens.record !== 'function') {
    throw new TypeError('tokens must be the issued-token ledger (createTokenLedger())');
  }

  const realRoot = fs.realpathSync(staticDir);
  const routes = compileRoutes(apiRoutes);

  const server = http.createServer({ requireHostHeader: false }, (req, res) => {
    const started = Date.now();
    const ctx = { cls: 'refused', logPath: '-' };
    res.on('close', () => {
      const status = res.headersSent ? res.statusCode : 0;
      log(`${req.method} ${ctx.cls} ${status} ${Date.now() - started}ms ${ctx.logPath}`);
    });
    try {
      handle(req, res, ctx);
    } catch (err) {
      log(`internal error: ${err?.message ?? err}`);
      if (!res.headersSent) refuse(res, 500, { error: 'internal_error' });
      else res.destroy();
    }
  });
  return server;

  function handle(req, res, ctx) {
    const target = req.url;
    // Origin-form only; '//x' would parse as an authority.
    if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
      return refuse(res, 400, { error: 'bad_request' });
    }
    const qIndex = target.indexOf('?');
    const rawPath = qIndex === -1 ? target : target.slice(0, qIndex);
    ctx.logPath = rawPath;
    let url;
    try {
      url = new URL(target, 'http://x');
    } catch {
      return refuse(res, 400, { error: 'bad_request' });
    }
    if (url.host !== 'x') return refuse(res, 400, { error: 'bad_request' });

    const host = req.headers.host;
    if (typeof host !== 'string' || host.toLowerCase() !== publicHost) {
      return refuse(res, 404, { error: 'host_not_served' });
    }

    // No body on GET/HEAD: one would be smuggled into the single-port emulator as a second request.
    if ((req.method === 'GET' || req.method === 'HEAD')
      && (req.headers['transfer-encoding'] !== undefined
        || (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== 0))) {
      return refuse(res, 400, { error: 'bad_request' });
    }
    if (ADMIN_BEARER.test(String(req.headers.authorization ?? ''))) return refuse(res, 404, { error: 'not_found' });
    // Only the Listen channel may carry header overrides, spelt exactly so (the ledger check reads that key only).
    for (const key of url.searchParams.keys()) {
      if (key.toLowerCase() === '$httpheaders' && (key !== '$httpHeaders' || rawPath !== QA_FIRESTORE_LISTEN)) {
        return refuse(res, 404, { error: 'not_found' });
      }
    }

    const decoded = unsafePath(rawPath);
    if (decoded === null) return refuse(res, 404, { error: 'not_found' });

    if (rawPath === '/api' || rawPath.startsWith('/api/')) return handleApi(req, res, ctx, rawPath);
    if (IDENTITY_PREFIXES.some((p) => rawPath.startsWith(p))) return handleIdentity(req, res, ctx, rawPath, url);
    if (rawPath.startsWith(FIRESTORE_PREFIX)) return handleFirestore(req, res, ctx, rawPath, url);
    return handleStatic(req, res, ctx, decoded);
  }

  function handleApi(req, res, ctx, rawPath) {
    if (!routes.some((r) => r.method === req.method && r.pattern.test(rawPath))) {
      return refuse(res, 404, { error: 'not_found' });
    }
    if (!readyOr503(res)) return;
    if (declaredTooLarge(req, API_CAP)) return refuse(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
    ctx.cls = 'api';
    const voidFault = hooks.takeVoid(req.method, rawPath);
    if (voidFault) ctx.cls = 'fault';
    const headers = forwardHeaders(req, publicHost, { keepCookie: true });
    streamThrough(req, res, targets.api, headers, API_CAP, API_TIMEOUT_MS, voidFault
      ? (upRes) => {
        // The real transaction ran; the browser gets no answer at all.
        let done = false;
        const drop = () => {
          if (done) return;
          done = true;
          voidFault.record(upRes.statusCode);
          req.socket.destroy();
        };
        upRes.on('end', drop);
        upRes.on('error', drop);
        upRes.resume();
      }
      : null, voidFault ? (failure) => voidFault.record(null, failure) : null);
  }

  function handleIdentity(req, res, ctx, rawPath, url) {
    if (!QA_IDENTITY_ROUTES.some(([m, p]) => m === req.method && p === rawPath)) {
      return refuse(res, 404, { error: 'not_found' });
    }
    // The refresh token is read from the body only.
    if (rawPath === TOKEN_PATH && [...url.searchParams.keys()].some((k) => REFRESH_QUERY.test(k))) {
      return refuse(res, 404, { error: 'not_found' });
    }
    const type = identityType(req, IDENTITY_TYPES.get(rawPath));
    const encoding = req.headers['content-encoding'];
    if (type === null || (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity')) {
      return refuse(res, 404, { error: 'not_found' });
    }
    if (!readyOr503(res)) return;
    if (declaredTooLarge(req, IDENTITY_CAP)) return refuse(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
    ctx.cls = 'identity';
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > IDENTITY_CAP) {
        over = true;
        refuse(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (over) return;
      const body = Buffer.concat(chunks);
      // accounts:lookup answers for any token naming an existing account; only issued ones are asked about.
      if (rawPath === LOOKUP_PATH && !tokens.has(soleIdToken(body))) return refuse(res, 404, { error: 'not_found' });
      // The token route mints a real ID token for any refresh token naming an existing account; only issued ones pass.
      if (rawPath === TOKEN_PATH && !tokens.has(soleRefreshToken(type, body), 'refresh')) return refuse(res, 404, { error: 'not_found' });
      const headers = forwardHeaders(req, `${targets.auth.host}:${targets.auth.port}`, { keepCookie: false, keepAuthorization: false });
      headers['content-type'] = type;
      headers['content-length'] = String(body.length);
      // The answer is parsed to record issued tokens; a compressed one would silently record nothing.
      headers['accept-encoding'] = 'identity';
      const send = () => bufferedThrough(targets.auth, req.method, req.url, headers, body, IDENTITY_TIMEOUT_MS)
        .then((outcome) => {
          recordIssued(rawPath, outcome);
          return outcome;
        });

      const taken = rawPath === SIGN_IN_PATH ? hooks.takeReauth(jsonField(body, 'email')) : null;
      if (!taken) {
        send().then((outcome) => deliver(res, outcome), () => res.destroy());
        return;
      }
      ctx.cls = 'fault';
      const entry = hooks.hold(taken, async (heldEntry) => {
        const outcome = await send().catch(() => ({ error: 'unavailable' }));
        const open = heldEntry.browserLeftAt === null && !res.destroyed && !res.writableEnded;
        if (open) deliver(res, outcome);
        heldEntry.releasedAt = nowIso();
        heldEntry.upstreamStatus = outcome.status ?? null;
        heldEntry.deliveredToBrowser = open;
        return { releasedAt: heldEntry.releasedAt, upstreamStatus: heldEntry.upstreamStatus, deliveredToBrowser: open };
      });
      res.on('close', () => {
        if (!res.writableFinished && entry.browserLeftAt === null) entry.browserLeftAt = nowIso();
      });
    });
  }

  function handleFirestore(req, res, ctx, rawPath, url) {
    const dbs = url.searchParams.getAll('database');
    if (rawPath !== QA_FIRESTORE_LISTEN || (req.method !== 'GET' && req.method !== 'POST')
      || dbs.length !== 1 || dbs[0] !== firestoreDatabase) {
      return refuse(res, 404, { error: 'not_found' });
    }
    // A literal ';' may separate parameters for the Java emulator, hiding one from the checks here.
    if (req.url.includes(';') || !listenCredentialOk(req, url)) return refuse(res, 404, { error: 'not_found' });
    if (!readyOr503(res)) return;
    if (declaredTooLarge(req, FIRESTORE_CAP)) return refuse(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
    ctx.cls = 'firestore';
    const headers = forwardHeaders(req, `${targets.firestore.host}:${targets.firestore.port}`, { keepCookie: false });
    streamThrough(req, res, targets.firestore, headers, FIRESTORE_CAP, FIRESTORE_TIMEOUT_MS, null, null);
  }

  function handleStatic(req, res, ctx, decoded) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 404, { error: 'not_found' });
    ctx.cls = 'static';
    const last = decoded.slice(decoded.lastIndexOf('/') + 1);
    const ext = path.extname(last).toLowerCase();
    if (last === '') return serveIndex(req, res);
    if (ext && !CONTENT_TYPES[ext]) return notFound(res);
    const found = resolveInside(path.join(realRoot, decoded));
    if (found === 'missing') return ext ? notFound(res) : serveIndex(req, res);
    if (!found || !ext) return notFound(res);
    return serveFile(req, res, found, CONTENT_TYPES[ext]);
  }

  function serveIndex(req, res) {
    const found = resolveInside(path.join(realRoot, 'index.html'));
    if (!found || found === 'missing') return notFound(res);
    return serveFile(req, res, found, CONTENT_TYPES['.html']);
  }

  /** The real path of a regular file inside the bundle, 'missing', or null (refused). */
  function resolveInside(candidate) {
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch (err) {
      return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'missing' : null;
    }
    if (!real.startsWith(realRoot + path.sep)) return null;
    try {
      return fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  function serveFile(req, res, file, type) {
    let fd;
    let size;
    try {
      fd = fs.openSync(file, 'r');
      size = fs.fstatSync(fd).size;
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      return notFound(res);
    }
    const isIndex = file === path.join(realRoot, 'index.html');
    const headers = {
      ...BASE_HEADERS,
      'content-type': type,
      'content-length': String(size),
      'cache-control': isIndex ? 'no-store' : 'no-cache',
    };
    if (type.startsWith('text/html')) headers['content-security-policy'] = QA_CSP;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      fs.closeSync(fd);
      res.end();
      return;
    }
    pipeline(fs.createReadStream(null, { fd }), res, () => {});
  }

  /** Records the ID and refresh tokens in a 200 answer of the Auth emulator's sign-in or token-refresh route. */
  function recordIssued(rawPath, outcome) {
    const fields = rawPath === SIGN_IN_PATH ? [['idToken', 'id'], ['refreshToken', 'refresh']]
      : rawPath === TOKEN_PATH ? [['id_token', 'id'], ['access_token', 'id'], ['refresh_token', 'refresh']] : null;
    if (outcome.status !== 200 || !fields) return;
    let answer = null;
    try {
      answer = JSON.parse(outcome.body.toString('utf8'));
    } catch { /* reported below */ }
    const recorded = fields.map(([field, kind]) => tokens.record(answer?.[field], kind));
    // The browser's next lookup, Listen or refresh with it would be refused; the value itself is never logged.
    if (!recorded.every(Boolean)) log(`identity 200 without a recordable token (${rawPath})`);
  }

  /** No Authorization header; each `$httpHeaders` Authorization line must be `Bearer <issued token>`. */
  function listenCredentialOk(req, url) {
    if (req.headers.authorization !== undefined) return false;
    for (const value of url.searchParams.getAll('$httpHeaders')) {
      // A bare CR may end a header line upstream, hiding a line from the split below.
      if (/\r(?!\n)/.test(value)) return false;
      for (const line of value.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        const colon = line.indexOf(':');
        if (colon === -1) return false;
        if (line.slice(0, colon).trim().toLowerCase() !== 'authorization') continue;
        const bearer = /^Bearer ([^\s]+)$/i.exec(line.slice(colon + 1).trim());
        if (!bearer || !tokens.has(bearer[1])) return false;
      }
    }
    return true;
  }

  function readyOr503(res) {
    let state;
    try {
      state = isReady();
    } catch {
      state = 'unavailable';
    }
    if (state === true) return true;
    const shown = typeof state === 'string' && /^[a-z_-]{1,32}$/.test(state) ? state : 'unavailable';
    refuse(res, 503, { error: 'qa_unavailable', state: shown }, { 'retry-after': '5' });
    return false;
  }
}

/** Decoded path, or null when the raw or decoded form is refused by the hygiene rules. */
function unsafePath(rawPath) {
  if (rawPath.includes('#')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  for (const p of [rawPath, decoded]) {
    if (/%2e|%2f|%5c/i.test(p) || p.includes('\\') || p.includes('\0') || p.startsWith('/__')) return null;
    if (p.split('/').some((seg) => seg.startsWith('.'))) return null;
  }
  return decoded;
}

function compileRoutes(apiRoutes) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return apiRoutes
    .filter((r) => r && typeof r.method === 'string' && typeof r.path === 'string' && r.path.startsWith('/api/v1/'))
    .map((r) => ({
      method: r.method.toUpperCase(),
      pattern: new RegExp('^' + r.path.split('/').map((seg) => (/^\{[^/{}]+\}$/.test(seg) ? '[^/]+' : escape(seg))).join('/') + '$'),
    }));
}

function forwardHeaders(req, hostValue, { keepCookie, keepAuthorization = true }) {
  const listed = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const k = name.toLowerCase();
    if (HOP_BY_HOP.has(k) || listed.has(k) || k === 'host' || k === 'forwarded' || k === 'x-real-ip') continue;
    // The Replit edge adds x-forwarded-* and x-replit-* (user identity); none of it is passed on.
    if (k.startsWith('x-forwarded-') || k.startsWith('x-replit-')) continue;
    if (!keepCookie && k === 'cookie') continue;
    if (!keepAuthorization && k === 'authorization') continue;
    out[k] = value;
  }
  out.host = hostValue;
  out['x-forwarded-for'] = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return out;
}

function responseHeaders(upHeaders) {
  const listed = new Set(String(upHeaders.connection ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const out = {};
  for (const [k, v] of Object.entries(upHeaders)) {
    if (HOP_BY_HOP.has(k) || listed.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function declaredTooLarge(req, cap) {
  const len = req.headers['content-length'];
  return len !== undefined && !(Number(len) <= cap);
}

/** Opens one upstream request; `done(errorCode | null, upRes)` is called exactly once. */
function openUpstream(target, method, url, headers, timeoutMs, done) {
  let settled = false;
  const finish = (code, upRes) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(code, upRes);
  };
  const upReq = http.request({
    host: target.host, port: target.port, method, path: url, headers,
    localAddress: '127.0.0.1', agent: false,
  }, (upRes) => finish(null, upRes));
  const timer = setTimeout(() => {
    finish('timeout');
    upReq.destroy();
  }, timeoutMs);
  upReq.on('error', () => finish('unavailable'));
  return upReq;
}

const UPSTREAM_REFUSAL = Object.freeze({
  unavailable: [502, { error: 'qa_upstream_unavailable' }],
  timeout: [504, { error: 'qa_upstream_timeout' }],
});

/** Body and answer streamed in both directions; `onResponse` replaces the normal relay and `onFailure(kind)` hears of no answer (faults). */
function streamThrough(req, res, target, headers, cap, timeoutMs, onResponse, onFailure) {
  let answered = false;
  const upReq = openUpstream(target, req.method, req.url, headers, timeoutMs, (code, upRes) => {
    if (answered) {
      upRes?.resume();
      return;
    }
    answered = true;
    if (code) {
      onFailure?.(code);
      const [status, body] = UPSTREAM_REFUSAL[code];
      if (!res.headersSent) refuse(res, status, body);
      else res.destroy();
      return;
    }
    if (onResponse) return onResponse(upRes);
    res.writeHead(upRes.statusCode, responseHeaders(upRes.headers));
    pipeline(upRes, res, () => {});
  });
  // A browser that leaves before the answer frees the upstream (never for a fault: it must complete).
  if (!onResponse) res.on('close', () => { if (!answered) upReq.destroy(); });
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > cap) return cb(Object.assign(new Error('payload too large'), { code: 'too_large' }));
      cb(null, chunk);
    },
  });
  pipeline(req, counter, upReq, (err) => {
    if (!err || err.code !== 'too_large') return;
    if (!answered) {
      answered = true;
      onFailure?.('too_large');
      refuse(res, 413, { error: 'payload_too_large' }, { connection: 'close' });
    } else {
      res.destroy();
    }
  });
}

/** A small buffered exchange; resolves { status, headers, body } or { error }. */
function bufferedThrough(target, method, url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const upReq = openUpstream(target, method, url, headers, timeoutMs, (code, upRes) => {
      if (code) return resolve({ error: code });
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => resolve({ status: upRes.statusCode, headers: responseHeaders(upRes.headers), body: Buffer.concat(chunks) }));
      upRes.on('error', () => resolve({ error: 'unavailable' }));
    });
    upReq.end(body);
  });
}

function deliver(res, outcome) {
  if (res.destroyed || res.writableEnded) return;
  if (outcome.error) {
    const [status, body] = UPSTREAM_REFUSAL[outcome.error] ?? UPSTREAM_REFUSAL.unavailable;
    return refuse(res, status, body);
  }
  const headers = { ...outcome.headers, 'content-length': String(outcome.body.length) };
  res.writeHead(outcome.status, headers);
  res.end(outcome.body);
}

/** The bare media type of an identity request when it is one of `allowed` with no parameter but `charset=utf-8`, or null. */
function identityType(req, allowed) {
  const [type, ...params] = String(req.headers['content-type'] ?? '').split(';').map((s) => s.trim().toLowerCase());
  return allowed.includes(type) && params.length <= 1 && params.every((p) => p === 'charset=utf-8') ? type : null;
}

/** The ID token of an accounts:lookup body that is a JSON object whose only key is exactly `idToken`, or null. */
function soleIdToken(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  // The emulator camel-cases every key (last wins), so `id_token` or `IdToken` beside it could swap the token looked up.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  return keys.length === 1 && keys[0] === 'idToken' && typeof parsed.idToken === 'string' ? parsed.idToken : null;
}

/**
 * The one refresh token a token-route body names, or null: the body is parsed as the emulator parses it (by its
 * bare content type `type`; node:querystring for a form), may hold only REFRESH_KEYS and GRANT_KEYS, and must name exactly one.
 */
function soleRefreshToken(type, body) {
  let pairs;
  if (type === 'application/x-www-form-urlencoded') {
    pairs = Object.entries(querystring.parse(body.toString('utf8'), '&', '=', { maxKeys: 0 }))
      .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((one) => [k, one]));
  } else if (type === 'application/json') {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      pairs = Object.entries(parsed);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const found = [];
  for (const [k, v] of pairs) {
    if (REFRESH_KEYS.has(k)) found.push(v);
    else if (!GRANT_KEYS.has(k)) return null;
  }
  return found.length === 1 && typeof found[0] === 'string' ? found[0] : null;
}

/** A string field of a small JSON body, or null. */
function jsonField(body, field) {
  try {
    const value = JSON.parse(body.toString('utf8'))?.[field];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function refuse(res, status, body, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
    ...extra,
  });
  res.end(payload);
}

function notFound(res) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(404, {
    ...BASE_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': '9',
  });
  res.end('Not found');
}
