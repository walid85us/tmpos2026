// Phase 4.0 M3 — deny-by-default application factory.
//
// Mounts ONLY liveness, readiness, and the bounded terminal 404/error path.
// No business route, no credential store, no label-proxy, no identity or
// controlled-action route, no DEV route. Every response is bounded JSON with
// baseline security headers and a correlation ID; no HTML error page, no
// stack/secret leakage, no route-existence disclosure. Forwarded headers are
// ignored unless a trusted-proxy contract is explicitly enabled.
//
// Admission BEFORE parsing (owner ruling): there is NO global body parser. Exact
// route + method admission happens first; every non-GET / unknown-path request
// returns the bounded 404 WITHOUT parsing, decompressing, or draining any body.
// The operational GET routes are bodyless: a declared/transfer-encoded body is
// rejected with a bounded 400 and the connection is closed (never parsed). Body
// parsing / media-type validation / 4xx envelopes arrive route-by-route with the
// authenticated business routes in a later M3 slice.
import express from 'express';
import type { Express, Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import http from 'node:http';
import type { RequestListener } from 'node:http';
import { REQUEST_ID_HEADER, resolveRequestId } from './correlation.js';
import { emitLog } from './logging.js';
import type { LogSink } from './logging.js';

export interface ReadinessState {
  isReady(): boolean;
  setReady(): void;
  setUnavailable(): void;
}

export function createReadinessState(): ReadinessState {
  let ready = false;
  return {
    isReady: () => ready,
    setReady: () => { ready = true; },
    setUnavailable: () => { ready = false; },
  };
}

// The only routes this skeleton knows. Everything else logs as a single bounded
// class so a raw path/query is never emitted.
const KNOWN_ROUTES = new Set<string>(['/health', '/readiness']);

export function classifyRoute(path: string): string {
  return KNOWN_ROUTES.has(path) ? path : 'other';
}

function applySecurityHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
}

function requestIdOf(res: Response): string {
  const id = (res.locals as Record<string, unknown>).requestId;
  return typeof id === 'string' ? id : '';
}

// Conservative, finite, bounded HTTP-server limits. Node leaves these implicit;
// setting every one makes idle/slowloris/oversized behavior deterministic.
// Ordering invariant proven in tests: keepAlive (5s) < headers (15s) <= request
// (30s). headersTimeout/requestTimeout are enforced only by Node's coarse
// connection checker (a ~30s tick), so `socketTimeout` (socket-inactivity, which
// Node disables by default = 0) is set as the DETERMINISTIC backstop that promptly
// closes a stalled/incomplete/idle half-open socket — the slowloris case.
// Malformed/oversized/early requests are rejected by Node's own bounded transport
// response (a fixed 4xx status line, socket closed, no echo of request bytes); we
// deliberately do NOT override `clientError`, which would only trade Node's
// accurate 431/408 for a blanket 400 and add fragile socket code.
export const HTTP_SERVER_LIMITS = {
  maxHeaderSizeBytes: 16 * 1024,
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  socketTimeoutMs: 30_000,
  maxHeaderLines: 100,
} as const;

/** Construct the production HTTP server with explicit bounded limits (never binds). */
export function createBoundedServer(handler: RequestListener): http.Server {
  const server = http.createServer({ maxHeaderSize: HTTP_SERVER_LIMITS.maxHeaderSizeBytes }, handler);
  server.headersTimeout = HTTP_SERVER_LIMITS.headersTimeoutMs;
  server.requestTimeout = HTTP_SERVER_LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = HTTP_SERVER_LIMITS.keepAliveTimeoutMs;
  // ONE ABOVE the policy limit: Node silently TRUNCATES req.headers at
  // maxHeadersCount, which could hide a body-framing header (Content-Length /
  // Transfer-Encoding) from hasDeclaredBody. Truncating one above the limit lets
  // the app-layer count check (in createApp) detect and REJECT an over-limit
  // request rather than serve it with a hidden body.
  server.maxHeadersCount = HTTP_SERVER_LIMITS.maxHeaderLines + 1;
  // Socket-inactivity backstop: deterministically closes an idle/stalled socket
  // (no read/write for the interval) — active requests reset it per chunk.
  server.timeout = HTTP_SERVER_LIMITS.socketTimeoutMs;
  // Deny-by-default at the transport layer: no CONNECT tunnels and no protocol
  // upgrades (WebSocket etc.). Destroy the socket rather than let a tunnel be
  // established or an upgrade request be reprocessed as an ordinary request. The
  // socket is DETACHED from the server's error handling here, so attach a no-op
  // 'error' listener BEFORE destroying: a peer RST racing the destroy would
  // otherwise emit 'error' with no listener -> uncaughtException -> process exit.
  const refuse = (_req: unknown, socket: import('node:net').Socket): void => {
    socket.on('error', () => {});
    socket.destroy();
  };
  server.on('connect', refuse);
  server.on('upgrade', refuse);
  return server;
}

// A request carries a body when it declares a non-empty Content-Length or ANY
// Transfer-Encoding (e.g. chunked). Content-Encoding alone (no length/framing) is
// not a body. Used to reject bodies on bodyless routes and to close the socket on
// any rejection that leaves an unread body, so it cannot desync keep-alive.
function hasDeclaredBody(req: Request): boolean {
  const te = req.headers['transfer-encoding'];
  if (typeof te === 'string' && te.trim() !== '') return true;
  const cl = req.headers['content-length'];
  if (typeof cl === 'string') {
    const n = Number(cl);
    if (Number.isInteger(n) && n > 0) return true;
  }
  return false;
}

// Rejecting a request that carries an unread body must close the connection: the
// undrained body would otherwise desync keep-alive (request smuggling), and we
// refuse to drain a large hostile body. Sets Connection: close when a body exists.
function closeIfBody(req: Request, res: Response): void {
  if (hasDeclaredBody(req)) res.setHeader('Connection', 'close');
}

export const notFoundHandler: RequestHandler = (req, res) => {
  applySecurityHeaders(res);
  closeIfBody(req, res); // deny before parsing; never drain an unread body
  res.status(404).json({ error: 'not_found', requestId: requestIdOf(res) });
};

// 4-arg signature required for Express to recognise this as error-handling
// middleware. Never emits a message, stack, or whether an internal route exists.
// Admission precedes parsing and NO global body parser is mounted, so the only
// errors reaching here are genuine internal faults -> bounded 500. Per-route body
// and media-type validation (and its 4xx envelopes) arrive with the authenticated
// business routes in a later M3 slice.
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // If a response was already started, delegate to the default handler rather
  // than throwing on a second write (matters once real routes stream output).
  if (res.headersSent) {
    next(err);
    return;
  }
  applySecurityHeaders(res);
  // Defense-in-depth for future business routes that can throw mid-request: a 500
  // returned keep-alive over an undrained body would desync the connection.
  closeIfBody(req as Request, res);
  res.status(500).json({ error: 'internal_error', requestId: requestIdOf(res) });
};

export interface AppDeps {
  readiness: ReadinessState;
  log?: LogSink;
  now?: () => number;
  // Injectable for later slices; the skeleton mounts no real dependency.
  dependencyChecks?: Array<() => boolean | Promise<boolean>>;
  trustProxy?: boolean;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Match the declared routes EXACTLY: no case-insensitive (/Health) or
  // trailing-slash (/health/) variant may reach an endpoint, so the reachable
  // surface equals the contract.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  // Default to NO trusted proxy: X-Forwarded-* is ignored unless explicitly enabled.
  app.set('trust proxy', deps.trustProxy === true ? 1 : false);
  const now = deps.now ?? Date.now;

  // Correlation ID + baseline security headers + bounded request log (all responses).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    (res.locals as Record<string, unknown>).requestId = id;
    res.setHeader('X-Request-Id', id);
    applySecurityHeaders(res);
    const start = now();
    let logged = false;
    const logRequest = (status: number, reason?: string): void => {
      if (logged) return;
      logged = true;
      emitLog('info', {
        event: 'request',
        requestId: id,
        method: req.method,
        route: classifyRoute(req.path),
        status,
        durationMs: now() - start,
        reason,
      }, deps.log);
    };
    // 'finish' = the response was fully flushed. 'close' without a finished write
    // = the client aborted before the response completed (slowloris/timeout/mid-
    // response error) — the class most worth logging. Exactly one bounded entry.
    res.on('finish', () => logRequest(res.statusCode));
    res.on('close', () => { if (!res.writableFinished) logRequest(0, 'aborted'); });
    // Reject an over-limit header count BEFORE admission: Node silently truncates
    // req.headers at maxHeadersCount, so a body-framing header placed beyond the
    // limit would be invisible to hasDeclaredBody and a body-bearing request could
    // be served 200 keep-alive. rawHeaders is [name, value, ...]; length/2 is the
    // delivered header-line count. Close the connection (an unread body may follow).
    if (req.rawHeaders.length / 2 > HTTP_SERVER_LIMITS.maxHeaderLines) {
      res.setHeader('Connection', 'close');
      res.status(431).json({ error: 'request_header_fields_too_large', requestId: id });
      return;
    }
    next();
  });

  // Liveness: answers only whether the process is alive. No dependency call.
  const health: RequestHandler = (_req, res) => {
    res.status(200).json({ status: 'alive' });
  };

  // Readiness: ready only after local init completes; dependency checks are
  // injectable for later slices. This skeleton mounts none, so it does not
  // pretend a provider was checked.
  const readinessHandler: RequestHandler = async (_req, res) => {
    try {
      // Local readiness FIRST: once shutdown flips this to unavailable, respond 503
      // immediately without running (and possibly hanging on) dependency probes.
      if (!deps.readiness.isReady()) {
        res.status(503).json({ status: 'unavailable' });
        return;
      }
      for (const check of deps.dependencyChecks ?? []) {
        if (!(await check())) {
          res.status(503).json({ status: 'unavailable' });
          return;
        }
      }
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  };

  // Deny-by-default dispatch, ADMISSION BEFORE PARSING: EXACTLY method GET on
  // EXACTLY the declared path. No body parser runs before this — HEAD, OPTIONS,
  // every other method, and all case / trailing-slash / unknown-path variants fall
  // through to the terminal 404 regardless of body, encoding, or size, and their
  // bodies are never parsed, decompressed, or drained. An admitted operational GET
  // is bodyless: a declared/transfer-encoded body is rejected with a bounded 400
  // and the socket closed (never parsed).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    if (req.path !== '/health' && req.path !== '/readiness') return next();
    if (hasDeclaredBody(req)) {
      applySecurityHeaders(res);
      res.setHeader('Connection', 'close');
      res.status(400).json({ error: 'invalid_request', requestId: requestIdOf(res) });
      return;
    }
    return req.path === '/health' ? health(req, res, next) : readinessHandler(req, res, next);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
