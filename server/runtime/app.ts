// Phase 4.0 M3/M4/M6 — deny-by-default application factory and the shared enforced chain.
//
// Every request runs ONE fixed chain, and no route reaches a handler any other way:
//   frame   — correlation ID, the bounded request log, the closed security-header
//             policy (locked at writeHead, so refusals, 404s, 500s and handlers all
//             carry it and no handler can drop it), and the header-count guard (431).
//             HSTS joins that policy only when built with `hsts` (server.ts: production).
//   enforce — 1. client and rate limit: every request but the two operational probes
//                (GET /health, GET /readiness, which never touch the limiter). The client is
//                resolved by the one trusted-proxy contract (clientAddress.ts) -> 400 when a
//                trusted proxy's chain is missing or malformed; then its namespace's request
//                limit is spent on the distributed limiter (rateLimit.ts) -> 429 + Retry-After
//                (an unavailable or overrunning limiter -> 503; there is no fallback);
//             2. Expect: no expectation is supported -> 417, never a 100 Continue
//                (an HTTP/1.0 request's Expect is ignored, RFC 9110 §10.1.1);
//             3. admission: exact METHOD + literal path in the closed route table
//                (routes.ts); a miss falls through to the terminal 404 WITHOUT
//                reading anything;
//             4. body headers: the route's declared body policy judged from headers
//                alone (admitBody) -> 400 / 413 / 415; no body byte is read;
//             5. pre-session CSRF/origin: POST/PUT/PATCH/DELETE only, against the
//                route's own boundary's origins for a login or session route
//                (requestSecurity.ts) -> 403;
//             6. access, by the route's policy — no port is ever handed `req` or `res`, and
//                every port call runs under the port deadline with its AbortSignal
//                (deadline.ts): a port that throws or overruns is an outage, a bounded
//                503, never a credential or authorization verdict:
//                authenticated: the Bearer credential view -> authenticator (401),
//                  then authorizer (403) (access.ts);
//                login: the boundary's login client limit (429), the credential view
//                  -> the boundary's verifier (401; an outage is a 503), its evidence
//                  policy (401: the admin login needs a provider-verified second factor and
//                  a recent authentication), then its account limit keyed by the verified
//                  principal's digest alone (429) — so neither a verifier outage nor a
//                  credential the policy refuses spends account budget; the handler asks admission (401) and issues
//                  the session; every refusal short of a limit or an outage is one
//                  generic 401 (sessions.ts);
//                session: the boundary's own cookie -> its session store, re-asking
//                  admission when due (401, or 503 when the store or admission is
//                  unavailable), the session-bound CSRF token on an unsafe method (403),
//                  then the authorizer when the route declares a requirement (403) — and
//                  only such a route's 2xx slides the session's idle window;
//             7. body: only now is a declared JSON body read, capped on the bytes
//                actually streamed (readBoundedBody), and parsed as strict UTF-8
//                JSON -> 413 / 400 (trailer fields -> 400);
//             8. idempotency, on a route that requires it (idempotency.ts): exactly one
//                valid Idempotency-Key (400), then the durable store under its own deadline —
//                a completed operation replays its recorded response, another request under
//                the key is a 422, one still in progress a 409, a store that cannot answer a
//                503 — and only an acquisition goes on;
//             9. the operation: a `required` route's `perform` once for its acquired lease (it can
//                run again only after that lease expires and is reclaimed — idempotency.ts: the
//                crash window), under the port deadline, handed its IdempotentContext only, its
//                outcome recorded before it is sent (a malformed outcome -> 500, an overrun or a
//                store that cannot record -> 503; neither is recorded); any other route's handler
//                exactly once, with the principal, the session view and the parsed value as
//                ctx.body; a throw or rejection -> bounded 500.
//   notFoundHandler / errorHandler — the terminal bounded 404 / 500;
//   abortStartedResponse — cuts a response that failed after it had started.
// createBoundedServer refuses any request-target that is not origin-form (bounded
// 400) before Express runs: Express would otherwise skip every layer above. It
// routes Expect requests into the chain (Node would otherwise answer 100 Continue or
// a headerless 417 itself), and holds a pipelined request until the response ahead
// of it is done, so nothing queued behind a connection-closing refusal is processed.
// The header-count guard (431) runs in `frame`, ahead of the limiter, and closes its
// connection. Every refusal is a bounded `{ error, requestId }` body and logs one
// bounded reason code; refusing a request that declared a body also closes the
// connection, so no unread byte is ever parsed as a next request. The production
// table holds only the public, body-free operational routes; each composed session
// boundary adds its login, current-session and logout routes, and `routes` adds more,
// all through the SAME table and chain. Startup fails closed (EnforcementSetupError)
// if any route lacks a valid access, body or idempotency policy, a public route is not
// GET, an authenticated route has no authenticator or authorizer, a login or session
// route's boundary is not composed with every port, a route requires idempotency with
// no durable store and key composed, the port deadline is not a whole number of
// milliseconds up to its cap, or an unsafe route has no trusted origin.
//
// There is NO body parser: a body reaches a handler only through its route's declared
// policy, and the parsed value stays untrusted input for route-specific validation.
// No body byte, parser message, credential, cookie, CSRF token or idempotency key is ever
// logged or echoed. No HTML error page, no stack/secret leakage, no route-existence disclosure.
// Express derives nothing from forwarding headers (`trust proxy` is off): X-Forwarded-For is read
// only by the trusted-proxy contract, and only from a configured trusted proxy. Startup refuses
// any route but the two probes without the distributed limiter (`rate_limit_required`).
import express from 'express';
import type { Express, Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { RequestListener } from 'node:http';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { REQUEST_ID_HEADER, resolveRequestId } from './correlation.js';
import { emitLog } from './logging.js';
import type { LogSink } from './logging.js';
import { applySecurityHeaders, lockSecurityHeaders } from './securityHeaders.js';
import { limiterSubjectOf, resolveClientAddress } from './clientAddress.js';
import { LIMITER_DEADLINE_MS, RATE_LIMITS, consumeRateLimit, createRequestLimits } from './rateLimit.js';
import type { RateLimitDimension, RateLimitNamespace, RateLimitPolicy, RequestLimitDeps } from './rateLimit.js';
import { UNSAFE_METHODS, evaluateRequestSecurity, parseTrustedOrigins } from './requestSecurity.js';
import { authenticate, authorize } from './access.js';
import type { RequestAuthenticator, RouteAuthorizer, RouteView } from './access.js';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { createSessionBoundaries, principalKeyOf, sessionCsrfRefusal } from './sessions.js';
import type { SessionBoundary, SessionDeps } from './sessions.js';
import {
  IDEMPOTENCY_DEADLINE_MS, IDEMPOTENCY_POLICY, acquireIdempotency, completeIdempotency, createIdempotency, envelopeFromOutcome, readIdempotencyKey,
} from './idempotency.js';
import type { Idempotency, IdempotencyDeps, IdempotencyRefusal, ReplayEnvelope } from './idempotency.js';
import { sameKeyMaterial } from './keyMaterial.js';
import { EnforcementSetupError, defineRoutes, sessionPaths } from './routes.js';
import type { BodyPolicy, RouteDefinition, RouteHandler, SessionAudience, SessionContext, VerifiedPrincipal } from './routes.js';

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

// The routes whose literal path may be logged: the operational and session endpoints (fixed,
// non-secret). Everything else logs as a single bounded class, so a raw path is never emitted.
const KNOWN_ROUTES = new Set<string>([
  '/health', '/readiness',
  ...(['tenant', 'admin'] as const).flatMap((audience) => Object.values(sessionPaths(audience))),
]);

export function classifyRoute(path: string): string {
  return KNOWN_ROUTES.has(path) ? path : 'other';
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
  // Pipelined requests one connection may hold waiting behind a pending response.
  maxQueuedRequests: 16,
} as const;

// The longest chains make eight sequential bounded calls: a login presenting a session (the
// request and login client limits, the verifier, the account limit, admission, revoke, create),
// and an idempotency-required session route (the request limit, the session read, admission,
// the session update, authorization, acquisition, the operation itself, completion). The
// socket's inactivity timeout runs through all of them, so a port deadline is capped at one
// eighth of that timeout: however slow every port is, the request ends in a bounded 503, never a reset.
const MAX_SEQUENTIAL_PORT_CALLS = 8;
const MAX_PORT_DEADLINE_MS = Math.floor(HTTP_SERVER_LIMITS.socketTimeoutMs / MAX_SEQUENTIAL_PORT_CALLS);

/** Construct the production HTTP server with explicit bounded limits (never binds). */
export function createBoundedServer(handler: RequestListener, options: { hsts?: boolean } = {}): http.Server {
  // Origin-form request-targets only ("/..."). For a target with no pathname (e.g.
  // absolute-form "a://b") Express's router skips EVERY middleware — the whole
  // enforced chain — and answers with its default HTML handler, so any other form
  // is refused here: bounded 400, the header policy, connection closed.
  const dispatch: RequestListener = (req, res) => {
    if (typeof req.url === 'string' && req.url.startsWith('/')) {
      handler(req, res);
      return;
    }
    applySecurityHeaders(res, options.hsts === true);
    res.setHeader('Connection', 'close');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_request' }));
  };
  // One request at a time per connection, and none after its last response (RFC 9112
  // §9.6). Node emits a pipelined request while the response ahead of it is pending,
  // queueing only its RESPONSE (no socket yet): the request waits here until that
  // response is given the socket, which never happens behind a connection-closing
  // response. A request Node parses once that closing response has finished finds the
  // socket already ending: it is never dispatched, and the socket closes as soon as
  // the refusal has flushed (destroying it here could reset away the refusal). A
  // waiting request writes nothing, so Node's own pipeline backpressure never engages:
  // past maxQueuedRequests waiting on one connection, the connection is cut.
  const waiting = new WeakMap<import('node:net').Socket, number>();
  const onRequest: RequestListener = (req, res) => {
    const socket = req.socket;
    if (res.socket === null) {
      const depth = (waiting.get(socket) ?? 0) + 1;
      if (depth > HTTP_SERVER_LIMITS.maxQueuedRequests) {
        socket.destroy();
        return;
      }
      waiting.set(socket, depth);
      res.once('socket', () => {
        waiting.set(socket, (waiting.get(socket) ?? 1) - 1);
        onRequest(req, res);
      });
      return;
    }
    if (!res.socket.writable) return;
    dispatch(req, res);
  };
  const server = http.createServer({ maxHeaderSize: HTTP_SERVER_LIMITS.maxHeaderSizeBytes }, onRequest);
  // Expect requests take the same path into the chain, which refuses every expectation
  // with a bounded 417. Without these listeners Node itself would answer `100 Continue`
  // (inviting the body before any check) or a 417 without the header policy.
  server.on('checkContinue', onRequest);
  server.on('checkExpectation', onRequest);
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
// not a body. Decides body presence for the body policy and for closeIfBody.
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
// undrained body would otherwise desync keep-alive (request smuggling), and a hostile
// body is never drained to its end. Sets Connection: close when a body exists.
function closeIfBody(req: Request, res: Response): void {
  if (hasDeclaredBody(req)) res.setHeader('Connection', 'close');
}

interface Refusal { readonly status: number; readonly error: string; readonly reason: string }

const invalid = (reason: string): Refusal => ({ status: 400, error: 'invalid_request', reason });
const unsupported = (reason: string): Refusal => ({ status: 415, error: 'unsupported_media_type', reason });

// The one deliberately supported media type: application/json, optionally with a
// single charset=utf-8 parameter (RFC 9110 §8.3.1 grammar, case-insensitive).
const JSON_MEDIA_TYPE_RE = /^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i;

/** How many header lines named `name` arrived (Node keeps only the first of some). */
function headerLines(req: Request, name: string): number {
  let lines = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) lines++;
  return lines;
}

/**
 * The route's body policy judged from headers alone — no body byte is read.
 * true: a JSON body follows, to be read after authorization; false: there is none.
 */
function admitBody(req: Request, policy: BodyPolicy): boolean | Refusal {
  const declared = hasDeclaredBody(req);
  if (policy.kind === 'none') return declared ? invalid('body_not_allowed') : false;
  // No content coding is supported, so none may be declared, with or without a body.
  if (headerLines(req, 'content-encoding') > 0) return unsupported('content_encoding_unsupported');
  if (!declared) return policy.required ? invalid('body_required') : false;
  // Chunked only, and only on HTTP/1.1: in an HTTP/1.0 message any Transfer-Encoding
  // means the framing is faulty (RFC 9112 §6.1).
  const te = req.headers['transfer-encoding'];
  if (te !== undefined && (te.toLowerCase() !== 'chunked' || req.httpVersion !== '1.1')) {
    return invalid('transfer_encoding_unsupported');
  }
  if (Number(req.headers['content-length'] ?? 0) > policy.maxBytes) {
    return { status: 413, error: 'content_too_large', reason: 'body_declared_too_large' };
  }
  const types = headerLines(req, 'content-type');
  if (types === 0) return unsupported('media_type_missing');
  if (types > 1 || !JSON_MEDIA_TYPE_RE.test(req.headers['content-type'] ?? '')) return unsupported('media_type_unsupported');
  return true;
}

export type BodyRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'body_streamed_too_large' | 'body_incomplete' };

/**
 * Read a body under a cap on the bytes actually streamed — never the declared
 * Content-Length. Settles exactly once: ok at a clean end with at most `maxBytes`
 * bytes; too large the moment the running total passes the cap (nothing is kept after
 * that, but the stream drains on so the refusal can flush before the connection
 * closes); incomplete on an error, or a close before the end. The server's request
 * and socket timeouts end a stalled stream, so it always settles.
 */
export function readBoundedBody(stream: Readable, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    let kept: Buffer[] | null = [];
    let size = 0;
    const settle = (read: BodyRead): void => {
      if (kept === null) return;
      kept = null;
      resolve(read);
    };
    if (stream.destroyed || stream.readableEnded) return settle({ ok: false, reason: 'body_incomplete' });
    // inv: until settled, `kept` holds exactly the `size` bytes streamed so far, and size <= maxBytes.
    stream.on('data', (chunk: Buffer) => {
      if (kept === null) return; // settled: drain, keep nothing
      size += chunk.length;
      if (size > maxBytes) settle({ ok: false, reason: 'body_streamed_too_large' });
      else kept.push(chunk);
    });
    stream.on('end', () => { if (kept !== null) settle({ ok: true, bytes: Buffer.concat(kept, size) }); });
    stream.on('error', () => settle({ ok: false, reason: 'body_incomplete' }));
    stream.on('close', () => settle({ ok: false, reason: 'body_incomplete' }));
  });
}

// Strict UTF-8: a malformed sequence throws, and a byte-order mark is kept so that
// JSON.parse rejects it (RFC 8259 §8.1: JSON text carries none).
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The parsed value, or undefined when the bytes are not strict UTF-8 JSON; the error text is discarded. */
function parseJson(bytes: Buffer): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(UTF8.decode(bytes)) as unknown };
  } catch {
    return undefined;
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  applySecurityHeaders(res);
  closeIfBody(req, res); // deny before parsing; never drain an unread body
  res.status(404).json({ error: 'not_found', requestId: requestIdOf(res) });
};

// 4-arg signature required for Express to recognise this as error-handling
// middleware. Never emits a message, stack, or whether an internal route exists.
// Every body refusal is decided inside the chain, so the errors reaching here are
// genuine internal faults (a throwing handler or chain step) -> bounded 500.
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // If a response was already started, delegate to the default handler rather
  // than throwing on a second write (matters once real routes stream output).
  if (res.headersSent) {
    next(err);
    return;
  }
  applySecurityHeaders(res);
  (res.locals as Record<string, unknown>).refusal = 'internal_error'; // fixed code, never the error itself
  // A 500 returned keep-alive over an undrained body would desync the connection.
  closeIfBody(req as Request, res);
  res.status(500).json({ error: 'internal_error', requestId: requestIdOf(res) });
};

/** A bounded refusal: fixed error word + correlation ID; the reason code goes to the log only. */
function refuse(req: Request, res: Response, status: number, error: string, reason: string): void {
  (res.locals as Record<string, unknown>).refusal = reason;
  closeIfBody(req, res); // never keep a connection alive over an unread body
  res.status(status).json({ error, requestId: requestIdOf(res) });
}

/** A port that could not answer — `*_unavailable` or `*_timeout` — rather than a verdict. */
const isOutage = (reason: string): boolean => reason.endsWith('_unavailable') || reason.endsWith('_timeout');

/** An outage is a bounded 503, never a verdict; otherwise the verdict's own 401 or 403. */
function verdict(req: Request, res: Response, reason: string, status: 401 | 403): void {
  if (isOutage(reason)) return refuse(req, res, 503, 'service_unavailable', reason);
  refuse(req, res, status, status === 401 ? 'unauthenticated' : 'forbidden', reason);
}

/** A 401 for an absent or refused Bearer credential, with its challenge — or an outage's 503. */
function challenge(req: Request, res: Response, reason: string): void {
  if (!isOutage(reason)) res.setHeader('WWW-Authenticate', 'Bearer');
  verdict(req, res, reason, 401);
}

function refusalOf(res: Response): string | undefined {
  const reason = (res.locals as Record<string, unknown>).refusal;
  return typeof reason === 'string' ? reason : undefined;
}

/** A durable store's refusal: one still in progress 409, another request under the key 422, anything else a 503. */
function idempotencyRefusal(req: Request, res: Response, reason: IdempotencyRefusal): void {
  if (reason === 'idempotency_in_progress') return refuse(req, res, 409, 'request_in_progress', reason);
  if (reason === 'idempotency_conflict') return refuse(req, res, 422, 'idempotency_key_reused', reason);
  refuse(req, res, 503, 'service_unavailable', reason);
}

/**
 * Send a recorded response exactly as recorded — its status, the approved content type, the
 * allowlisted Location and the body — beside the request's own security headers and fresh
 * X-Request-Id from the frame. A replay is marked so, and carries nothing else.
 */
function sendRecorded(res: Response, envelope: ReplayEnvelope, replayed: boolean): void {
  if (envelope.headers.location !== undefined) res.setHeader('Location', envelope.headers.location);
  if (replayed) {
    res.setHeader('Idempotent-Replayed', 'true');
    (res.locals as Record<string, unknown>).refusal = 'idempotency_replayed'; // the request log's reason marks a replay
  }
  res.setHeader('Content-Type', envelope.contentType);
  res.status(envelope.status).end(envelope.body);
}

/** A boundary's routes are limited in its own namespace; everything else, unknown paths included, in `runtime`. */
const requestNamespace = (route: RouteDefinition | undefined): RateLimitNamespace =>
  route !== undefined && (route.policy.access === 'login' || route.policy.access === 'session') ? route.policy.audience : 'runtime';

/** Each boundary's login exchange is limited in a namespace of its own. */
const LOGIN_NAMESPACES: Readonly<Record<SessionAudience, RateLimitNamespace>> = Object.freeze({ tenant: 'tenant-login', admin: 'admin-login' });

// How long one store probe answers readiness for an instance (createApp).
const PROBE_REUSE_MS = 1_000;

const NO_BYTES = Buffer.alloc(0);

/** X-Forwarded-For as its one line's value, undefined when absent, or every line's value when repeated. */
function forwardedForOf(req: Request): string | string[] | undefined {
  const lines: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-for') lines.push(req.rawHeaders[i + 1]);
  return lines.length > 1 ? lines : lines[0];
}

/** The frozen route view an authorizer is handed: never the request or the response. */
const viewOf = (route: RouteDefinition, audience: SessionAudience | null): RouteView =>
  Object.freeze({ method: route.method, path: route.path, audience });

export interface AppDeps {
  readiness: ReadinessState;
  log?: LogSink;
  now?: () => number;
  // Injectable for later slices; the skeleton mounts no real dependency. Each check runs
  // under the port deadline and is handed its AbortSignal.
  dependencyChecks?: Array<(signal: AbortSignal) => boolean | Promise<boolean>>;
  /** Further routes, admitted only through the same table and chain as the operational ones. */
  routes?: readonly RouteDefinition[];
  /** Required once any route is `authenticated`; startup refuses otherwise. */
  authenticator?: RequestAuthenticator;
  authorizer?: RouteAuthorizer;
  /** Exact origins allowed to send unsafe requests; required once any unsafe route exists. */
  trustedOrigins?: readonly string[];
  /**
   * The distributed limiter, its keyed-hash secret and the trusted proxies (rateLimit.ts). Required
   * once any route but the two probes exists: no default, no per-process stand-in, no fallback.
   */
  limits?: RequestLimitDeps;
  /**
   * The durable idempotency store and its own keyed-hash secret (idempotency.ts). Required once any
   * route requires idempotency: no default, no per-process stand-in, no fallback.
   */
  idempotency?: IdempotencyDeps;
  /** The session boundaries composed, each from its own ports (sessions.ts). */
  sessions?: SessionDeps;
  /** The bound on every port call in ms (deadline.ts): a whole number up to MAX_PORT_DEADLINE_MS. */
  portDeadlineMs?: number;
  /** Send HSTS on every response; only at the TLS production boundary (server.ts). */
  hsts?: boolean;
}

const PUBLIC = { access: 'public' } as const;
const NO_BODY = { kind: 'none' } as const;

export function createApp(deps: AppDeps): Express {
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.portDeadlineMs ?? PORT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }

  // Liveness: answers only whether the process is alive. No dependency call.
  const health: RouteHandler = (_req, res) => {
    res.status(200).json({ status: 'alive' });
  };

  // Validated first: a malformed limiter, secret, proxy list or idempotency store refuses startup.
  const limits = deps.limits === undefined ? null : createRequestLimits(deps.limits);
  const idempotency = deps.idempotency === undefined ? null : createIdempotency(deps.idempotency);
  // The idempotency secret is its own — never the limiter's, however either is padded (keyMaterial.ts).
  if (idempotency !== null && limits !== null
    && sameKeyMaterial((deps.idempotency as IdempotencyDeps).keySecret, (deps.limits as RequestLimitDeps).keySecret)) {
    throw new EnforcementSetupError('idempotency_key_shared');
  }

  // Readiness: ready only after local init completes, every injected dependency check passes and
  // every composed store — the limiter's and, when composed, the idempotency store — answers its
  // probe with exactly `true`, so readiness says whether protected traffic can be served. Each
  // check runs under the port deadline, and no probe touches a client bucket or record.
  // However many readiness requests arrive, an instance asks each store at most once per
  // PROBE_REUSE_MS: concurrent and repeated requests share one probe, so a flood of probes never
  // becomes a flood of store calls. A shared probe runs under its store's own deadline, never a
  // request's, so an answer that arrives late is no answer; a store that fails just after a good
  // probe reads as ready for at most PROBE_REUSE_MS — the price of the bound, accepted.
  const sharedProbe = (probe: (signal: AbortSignal) => unknown, storeDeadlineMs: number): (() => Promise<boolean>) => {
    let last: { readonly at: number; readonly ready: Promise<boolean> } | null = null;
    return () => {
      const t = now();
      if (last === null || t < last.at || t - last.at >= PROBE_REUSE_MS) {
        last = { at: t, ready: withDeadline(Math.min(deadlineMs, storeDeadlineMs), probe).then((v) => v === true, () => false) };
      }
      return last.ready;
    };
  };
  const readinessChecks: Array<(signal: AbortSignal) => unknown> = [
    ...(deps.dependencyChecks ?? []),
    ...(limits === null ? [] : [sharedProbe((signal) => limits.limiter.probe(signal), LIMITER_DEADLINE_MS)]),
    ...(idempotency === null ? [] : [sharedProbe((signal) => idempotency.store.probe(signal), IDEMPOTENCY_DEADLINE_MS)]),
  ];
  const readinessHandler: RouteHandler = async (_req, res) => {
    try {
      // Local readiness FIRST: once shutdown flips this to unavailable, respond 503
      // immediately without running (and possibly hanging on) dependency probes.
      if (!deps.readiness.isReady()) {
        res.status(503).json({ status: 'unavailable' });
        return;
      }
      for (const check of readinessChecks) {
        // A check that throws or overruns the deadline is unavailable too (the catch below).
        if (!(await withDeadline(deadlineMs, (signal) => check(signal)))) {
          res.status(503).json({ status: 'unavailable' });
          return;
        }
      }
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  };

  // The two operational probes, known by the handlers this factory owns — never by path text —
  // answer without the limiter: a limiter-store outage neither hangs nor limits them, and they
  // spend no bucket.
  const isProbe = (route: RouteDefinition): boolean =>
    route.idempotency === 'none' && (route.handler === health || route.handler === readinessHandler);

  const boundaries = createSessionBoundaries(deps.sessions, { now, deadlineMs });
  const table = defineRoutes([
    { method: 'GET', path: '/health', policy: PUBLIC, body: NO_BODY, idempotency: 'none', handler: health },
    { method: 'GET', path: '/readiness', policy: PUBLIC, body: NO_BODY, idempotency: 'none', handler: readinessHandler },
    ...Object.values(boundaries).flatMap((boundary) => boundary?.routes ?? []),
    ...(deps.routes ?? []),
  ]);
  const routes = table.list();
  const trustedOrigins = parseTrustedOrigins(deps.trustedOrigins);
  const { authenticator, authorizer } = deps;
  if (routes.some((r) => r.policy.access === 'authenticated')) {
    if (typeof authenticator?.verify !== 'function') throw new EnforcementSetupError('authenticator_required');
    if (typeof authorizer?.authorize !== 'function') throw new EnforcementSetupError('authorizer_required');
  }
  // A login or session route runs only on a boundary composed with every one of its ports.
  if (routes.some((r) => (r.policy.access === 'login' || r.policy.access === 'session') && boundaries[r.policy.audience] === undefined)) {
    throw new EnforcementSetupError('session_boundary_unconfigured');
  }
  // A boundary's routes answer its own origins (sessions.ts); every other unsafe route needs these.
  if (routes.some((r) => UNSAFE_METHODS.has(r.method) && r.policy.access !== 'login' && r.policy.access !== 'session')
    && trustedOrigins.size === 0) {
    throw new EnforcementSetupError('trusted_origins_required');
  }
  // Protected traffic is never served unlimited: every route but the probes needs the limiter.
  if (limits === null && routes.some((r) => !isProbe(r))) throw new EnforcementSetupError('rate_limit_required');
  // An operation that requires idempotency never runs without its durable store and key.
  if (idempotency === null && routes.some((r) => r.idempotency === 'required')) throw new EnforcementSetupError('idempotency_required');

  const app = express();
  app.disable('x-powered-by');
  // Express derives nothing from forwarding headers: the trusted-proxy contract alone reads them.
  app.set('trust proxy', false);
  // Non-secret inventory of the admitted surface: method, literal path, access, body and idempotency class.
  app.locals.routes = Object.freeze(
    routes.map((r) => Object.freeze({ method: r.method, path: r.path, access: r.policy.access, body: r.body.kind, idempotency: r.idempotency })),
  );

  // Correlation ID + locked security headers + bounded request log (all responses).
  app.use(function frame(req: Request, res: Response, next: NextFunction) {
    const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    (res.locals as Record<string, unknown>).requestId = id;
    res.setHeader('X-Request-Id', id);
    lockSecurityHeaders(res, deps.hsts === true);
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
    res.on('finish', () => logRequest(res.statusCode, refusalOf(res)));
    res.on('close', () => { if (!res.writableFinished) logRequest(0, 'aborted'); });
    // Reject an over-limit header count BEFORE admission: Node silently truncates
    // req.headers at maxHeadersCount, so a body-framing header placed beyond the
    // limit would be invisible to hasDeclaredBody and a body-bearing request could
    // be served 200 keep-alive. rawHeaders is [name, value, ...]; length/2 is the
    // delivered header-line count. Close the connection (an unread body may follow).
    if (req.rawHeaders.length / 2 > HTTP_SERVER_LIMITS.maxHeaderLines) {
      (res.locals as Record<string, unknown>).refusal = 'request_header_fields_too_large';
      res.setHeader('Connection', 'close');
      res.status(431).json({ error: 'request_header_fields_too_large', requestId: id });
      return;
    }
    next();
  });

  // The fixed enforcement order (see the header). Every step fails closed, and any
  // unexpected throw — limiter, port or handler — reaches the bounded 500.
  app.use(async function enforce(req: Request, res: Response, next: NextFunction) {
    // Spend one unit of `subject`'s bucket: false when the request may go on; otherwise it is
    // refused — 429 with Retry-After at the limit, 503 when the limiter cannot answer.
    const limited = async (
      namespace: RateLimitNamespace, dimension: RateLimitDimension, subject: string, policy: RateLimitPolicy, reason: string,
      clearing: string | null = null,
    ): Promise<boolean> => {
      const { limiter, keyring } = limits as NonNullable<typeof limits>;
      const key = keyring.keyOf(namespace, dimension, subject);
      const verdict = await consumeRateLimit(limiter, Object.freeze({ namespace, dimension, key, ...policy, cost: 1 }), deadlineMs);
      if (verdict === 'allowed') return false;
      if (typeof verdict === 'string') {
        // A logout the limiter cannot serve still clears its cookie, as one the store cannot serve
        // does: a shared terminal keeps nothing, and the 503 says nothing was revoked.
        if (clearing !== null) res.setHeader('Set-Cookie', clearing);
        refuse(req, res, 503, 'service_unavailable', verdict);
        return true;
      }
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      refuse(req, res, 429, 'rate_limited', reason);
      return true;
    };
    // A logout route's clearing cookie, when the request passes that boundary's pre-session checks.
    const logoutClearing = (route: RouteDefinition | undefined): string | null => {
      if (route === undefined || route.policy.access !== 'session' || route.method !== 'POST'
        || route.path !== sessionPaths(route.policy.audience).logout) return null;
      const boundary = boundaries[route.policy.audience] as SessionBoundary;
      return evaluateRequestSecurity(req.headers, boundary.trustedOrigins) === null ? boundary.clearingCookie : null;
    };
    try {
      const route = table.lookup(req.method, req.path); // a map lookup: nothing is read or parsed
      // The client's limiter subject. The probes never resolve one and never touch the limiter.
      let client = '';
      if (limits !== null && (route === undefined || !isProbe(route))) {
        const address = resolveClientAddress(req.socket.remoteAddress, forwardedForOf(req), limits.trustedProxies);
        if (typeof address === 'string') return refuse(req, res, 400, 'invalid_request', address);
        client = limiterSubjectOf(address);
        if (await limited(requestNamespace(route), 'client', client, RATE_LIMITS.request, 'rate_limited', logoutClearing(route))) return;
      }
      // No expectation is supported, so a body is never invited ahead of the checks.
      // RFC 9110 §10.1.1: a 100-continue in an HTTP/1.0 request is ignored, not refused.
      if (req.headers.expect !== undefined && req.httpVersion !== '1.0') {
        return refuse(req, res, 417, 'expectation_failed', 'expect_unsupported');
      }
      if (route === undefined) return next(); // terminal bounded 404; nothing parsed or drained
      const body = admitBody(req, route.body);
      if (typeof body === 'object') return refuse(req, res, body.status, body.error, body.reason);
      if (UNSAFE_METHODS.has(route.method)) {
        // A boundary's routes answer only that boundary's own origins, never the other's.
        const origins = route.policy.access === 'login' || route.policy.access === 'session'
          ? (boundaries[route.policy.audience] as SessionBoundary).trustedOrigins
          : trustedOrigins;
        const csrf = evaluateRequestSecurity(req.headers, origins);
        if (csrf !== null) return refuse(req, res, 403, 'forbidden', csrf);
      }
      let principal: VerifiedPrincipal | null = null;
      let session: SessionContext | null = null;
      const { policy } = route;
      if (policy.access === 'authenticated') {
        // Both ports are proven present at startup for any authenticated route.
        const authn = await authenticate(req, authenticator as RequestAuthenticator, deadlineMs);
        if (typeof authn === 'string') return challenge(req, res, authn);
        const denied = await authorize(authorizer as RouteAuthorizer, authn.principal, policy.authorization, viewOf(route, null), deadlineMs);
        if (denied !== null) return verdict(req, res, denied, 403);
        principal = authn.principal;
      } else if (policy.access === 'login') {
        // Startup proved this boundary composed. The client limit is spent before any
        // credential is examined. The account limit is keyed by the verified principal's
        // digest alone and spent after the evidence policy — a local check, so a verified
        // credential the policy refuses (an old admin token without a recent second factor)
        // spends no account budget and cannot lock the owner out — and before admission, so
        // neither an unverified claim nor a 429 speaks for an account's admission. The
        // handler then asks admission and issues the session.
        const boundary = boundaries[policy.audience] as SessionBoundary;
        // Startup proved the limiter composed, so `client` is this request's resolved subject.
        const namespace = LOGIN_NAMESPACES[policy.audience];
        if (await limited(namespace, 'client', client, RATE_LIMITS.loginClient, 'login_client_limited')) return;
        const authn = await authenticate(req, boundary.verifier, deadlineMs);
        if (typeof authn === 'string') return challenge(req, res, authn);
        const evidence = boundary.loginEvidence(authn.evidence);
        if (evidence !== null) return challenge(req, res, evidence); // indistinguishable from a bad credential
        if (await limited(namespace, 'account', principalKeyOf(authn.principal), RATE_LIMITS.loginAccount, 'login_account_limited')) return;
        principal = authn.principal;
      } else if (policy.access === 'session') {
        const boundary = boundaries[policy.audience] as SessionBoundary;
        // Logout needs no fresh admission decision: revoking a session is always allowed.
        const logout = route.method === 'POST' && route.path === sessionPaths(policy.audience).logout;
        const active = await boundary.authenticate(req.headers.cookie, !logout);
        if (typeof active === 'string') {
          // A logout the store cannot serve still clears the cookie (its origin and intent passed
          // above), so a shared terminal keeps nothing; the 503 reports that nothing was revoked.
          if (logout && isOutage(active)) res.setHeader('Set-Cookie', boundary.clearingCookie);
          return verdict(req, res, active, 401);
        }
        if (UNSAFE_METHODS.has(route.method)) {
          const csrf = sessionCsrfRefusal(req, active.context.csrfToken);
          if (csrf !== null) return refuse(req, res, 403, 'forbidden', csrf);
        }
        if (policy.authorization !== null) {
          const denied = await authorize(boundary.authorizer, active.principal, policy.authorization, viewOf(route, policy.audience), deadlineMs);
          if (denied !== null) return verdict(req, res, denied, 403);
          // The idle window slides only when an authorized route answers 2xx — never on a
          // refusal, a failure, the current-session read or logout. A refresh that cannot be
          // stored cannot fail the request it follows; the session then lapses sooner.
          res.once('finish', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            boundary.refresh(active).catch(() => {
              emitLog('warn', { event: 'session_refresh_failed', requestId: requestIdOf(res) }, deps.log);
            });
          });
        }
        principal = active.principal;
        session = active.context;
      }
      let parsed: unknown;
      let bytes: Buffer = NO_BYTES;
      if (body && route.body.kind === 'json') {
        // Every check has passed and no port was handed the request, so the stream is
        // untouched: only now is a byte read.
        const read = await readBoundedBody(req, route.body.maxBytes);
        if (read.ok === false) {
          return read.reason === 'body_streamed_too_large'
            ? refuse(req, res, 413, 'content_too_large', read.reason)
            : refuse(req, res, 400, 'invalid_request', read.reason);
        }
        // Trailer fields would reach the handler outside the header checks and the cap.
        if (req.rawTrailers.length > 0) return refuse(req, res, 400, 'invalid_request', 'body_trailers_unsupported');
        bytes = read.bytes;
        if (read.bytes.length > 0) {
          const json = parseJson(read.bytes);
          if (json === undefined) return refuse(req, res, 400, 'invalid_request', 'body_malformed');
          parsed = json.value;
        } else if (route.body.required) {
          return refuse(req, res, 400, 'invalid_request', 'body_required'); // an empty chunked body
        }
      }
      if (route.idempotency === 'required') {
        // Startup proved the store and key composed, and registration that this route has a
        // verified principal (`authenticated`, or a session with a declared authorization).
        const store = idempotency as Idempotency;
        const key = readIdempotencyKey(req.rawHeaders);
        if (typeof key === 'string') return refuse(req, res, 400, 'invalid_request', key);
        const audience = policy.access === 'session' ? policy.audience : null;
        const operation = store.keyring.operationOf(key.key, principal as VerifiedPrincipal, {
          method: route.method, path: route.path, audience, tenant: null, store: null, body: bytes,
        });
        const lease = randomBytes(32).toString('base64url');
        const acquired = await acquireIdempotency(store, Object.freeze({ ...operation, lease, ...IDEMPOTENCY_POLICY }), deadlineMs);
        if (typeof acquired === 'string') return idempotencyRefusal(req, res, acquired);
        if (acquired.outcome === 'replay') return sendRecorded(res, acquired.response, true);
        if (acquired.reclaimed) emitLog('warn', { event: 'idempotency_reclaimed', requestId: requestIdOf(res) }, deps.log);
        let outcome: unknown;
        try {
          outcome = await withDeadline(deadlineMs, (signal) => route.perform(Object.freeze({
            principal: principal as VerifiedPrincipal, audience, body: parsed, attempt: Object.freeze({ reclaimed: acquired.reclaimed }), signal,
          })));
        } catch (err) {
          // Nothing is recorded: the reservation waits out its lease (idempotency.ts: the crash window).
          const failure = outage('idempotent_operation', err);
          if (failure === 'idempotent_operation_timeout') return refuse(req, res, 503, 'service_unavailable', failure);
          return refuse(req, res, 500, 'internal_error', 'idempotent_operation_failed');
        }
        const envelope = envelopeFromOutcome(outcome);
        if (envelope === null) return refuse(req, res, 500, 'internal_error', 'idempotent_outcome_invalid');
        // Completion runs under the runtime's own deadline, whatever the client's connection does,
        // and the response is sent only once the store has recorded it.
        const unrecorded = await completeIdempotency(store, Object.freeze({ scope: operation.scope, lease, response: store.keyring.seal(envelope, operation) }), deadlineMs);
        if (unrecorded !== null) return refuse(req, res, 503, 'service_unavailable', unrecorded);
        return sendRecorded(res, envelope, false);
      }
      await route.handler(req, res, Object.freeze({ requestId: requestIdOf(res), principal, session, body: parsed }));
    } catch (err) {
      next(err); // bounded 500; the error itself is never logged or echoed
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  // Reached only when errorHandler defers because the response had already started:
  // cut the connection rather than let Express's default handler print the raw error.
  // One turn later, so bytes the handler already wrote flush before the cut.
  app.use(function abortStartedResponse(_err: unknown, _req: Request, res: Response, _next: NextFunction) {
    setImmediate(() => res.destroy());
  });
  return app;
}
