// Phase 4.0 M3/M4/M6 — the central, closed route table: the ONLY way a route reaches the runtime.
//
// Every definition declares exactly one access policy, exactly one body policy — `none`, or
// bounded JSON with a source-defined byte cap (at most MAX_JSON_BODY_BYTES) that is required or
// optional — and exactly one idempotency policy — `none`, or `required` (idempotency.ts), which
// only a state-changing route with a verified principal and a declared authorization may take —
// plus an allowed method, a literal path and its operation, and nothing else: a missing,
// unknown, partial or contradictory field fails startup with a bounded EnforcementSetupError code
// (never the offending input). The operation matches the idempotency policy: a `none` route's
// handler writes its own response; a `required` route has exactly one of a `perform`, handed only its
// IdempotentContext, whose outcome the runtime records before sending (idempotency.ts: the crash
// window, so never a production route), or a `command` — its command contract and a synchronous
// planner, whose plan the runtime commits atomically with its completion, audit record and outbox
// events (commandTransaction.ts). No route has two operations. The access policies are:
//   public        — GET only, so no unauthenticated state-changing route can register (G-UNAUTH);
//   authenticated — a Bearer credential verified per request, plus the authorization it requires;
//   login         — the one pre-session exchange of a session boundary (M4): only that
//                   boundary's exact bodiless POST login path, whose handler the runtime owns
//                   (sessions.ts), so it is no general unauthenticated-write escape;
//   session       — a server session of one boundary, plus the authorization it requires;
//                   only that boundary's current-session and logout endpoints may omit it.
// The two session boundaries own reserved namespaces: tenant/store routes live under /api/v1
// and administrative routes under /admin/v1. A path under either prefix must carry that
// boundary's own login or session policy, a session policy must sit under its own boundary's
// prefix, and nothing at all registers elsewhere under /api or /admin — so no route beside a
// boundary, and no route of the other boundary, can inherit or bypass its session.
// A JSON body registers only on POST, PUT or PATCH: GET and DELETE content has no defined
// semantics and is a smuggling vector (RFC 9110 §9.3.1, §9.3.5). Paths are literal
// lowercase segments with no parameter, wildcard, encoding, dot segment, empty segment or
// trailing slash, and lookup is an exact METHOD + path string match, so no prefix, case,
// slash or encoding variant can inherit another route's policy. Definitions are copied and
// frozen at registration; the table cannot change afterwards. Handlers receive
// (req, res, ctx) and no `next`: dispatch belongs to the chain alone, and a body reaches a
// handler only as the parsed ctx.body. A `perform` or a planner receives no request or response at all.
import type { Request, Response } from 'express';
import type { CommandContract } from './commandTransaction.js';

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type AuthorizationScope = 'platform' | 'tenant' | 'store';
/** The two server session boundaries: tenant/store (/api/v1) and administrative (/admin/v1). */
export type SessionAudience = 'tenant' | 'admin';

export interface AuthorizationRequirement {
  readonly scope: AuthorizationScope;
  readonly permission: string;
}

export type RoutePolicy =
  | { readonly access: 'public' }
  | { readonly access: 'authenticated'; readonly authorization: AuthorizationRequirement }
  | { readonly access: 'login'; readonly audience: SessionAudience }
  | { readonly access: 'session'; readonly audience: SessionAudience; readonly authorization: AuthorizationRequirement | null };

/** The request body a route accepts: none at all, or one JSON value of at most `maxBytes`. */
export type BodyPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'json'; readonly maxBytes: number; readonly required: boolean };

/** Whether a route's requests run under a durable Idempotency-Key (idempotency.ts): never, or always. */
export type IdempotencyPolicy = 'none' | 'required';

/** The largest byte cap any route may declare for a JSON body (1 MiB). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * A server-verified identity key: the only principal data a handler ever receives. The provider
 * UID is opaque: a handler never logs, renders or parses it (sessions.ts digests it for storage).
 */
export interface VerifiedPrincipal {
  readonly authProvider: string;
  readonly authProviderUid: string;
}

/**
 * What a handler learns of its session: the audience and CSRF token — never the identifier,
 * and no capability over it (only the runtime's own logout handler can revoke a session).
 */
export interface SessionContext {
  readonly audience: SessionAudience;
  readonly csrfToken: string;
}

export interface RouteContext {
  readonly requestId: string;
  readonly principal: VerifiedPrincipal | null;
  /** The session the request authenticated with, on a `session` route; otherwise null. */
  readonly session: SessionContext | null;
  /** The parsed JSON body — still untrusted input — or undefined when none was taken. */
  readonly body: unknown;
}

export type RouteHandler = (req: Request, res: Response, ctx: RouteContext) => void | Promise<void>;

/**
 * What an idempotency-required operation learns — and nothing else, so nothing outside its
 * fingerprint (a header, the query, a CSRF token, the request ID) can shape a response that is
 * recorded and replayed.
 */
export interface IdempotentContext {
  readonly principal: VerifiedPrincipal;
  /** The session boundary the request came through; null on a Bearer-authenticated route. */
  readonly audience: SessionAudience | null;
  /** The parsed JSON body — still untrusted input — or undefined when none was taken. */
  readonly body: unknown;
  /** `reclaimed`: an earlier attempt's lease expired unfinished, so its business write may or may not have happened. */
  readonly attempt: Readonly<{ reclaimed: boolean }>;
  /** Aborts at the operation's deadline: stop, and commit nothing, once it fires. */
  readonly signal: AbortSignal;
}

/** What an idempotency-required operation returns; the runtime validates, records and sends it (idempotency.ts). */
export interface IdempotentOutcome {
  readonly status: number;
  /** A JSON value, serialized once and replayed byte for byte. */
  readonly body: unknown;
  /** Allowlisted response headers only: `location`. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type IdempotentOperation = (ctx: IdempotentContext) => IdempotentOutcome | Promise<IdempotentOutcome>;

/** What a command's planner learns — no principal, key, credential, cookie, CSRF token or request ID. */
export interface CommandContext {
  /** The session boundary the request came through; null on a Bearer-authenticated route. */
  readonly audience: SessionAudience | null;
  /** The parsed JSON body — still untrusted input — or undefined when none was taken. */
  readonly body: unknown;
  /** A UUID the runtime generated for this attempt: the only aggregate ID a create may name. */
  readonly newAggregateId: string;
}

type PlanRecord = Readonly<Record<string, string | number | boolean>>;

/** A command's plan: one aggregate's change, the events it enqueues and the response to send once committed. */
export interface CommandPlan {
  /** For a create (expectedVersion null) exactly ctx.newAggregateId; for an update the aggregate's UUID. */
  readonly aggregateId: string;
  readonly expectedVersion: number | null;
  readonly changes: PlanRecord;
  readonly events: readonly Readonly<{ type: string; payload: PlanRecord }>[];
  /** 200 or 201 only. */
  readonly response: IdempotentOutcome;
}

/** Plans from the body alone: synchronous, no I/O, no write — the runtime commits the plan. */
export type CommandPlanner = (ctx: CommandContext) => CommandPlan;

/** A command operation: its contract (validated at startup against the event contracts) and its planner. */
export interface CommandRoute {
  readonly contract: CommandContract;
  readonly plan: CommandPlanner;
}

interface RouteDefinitionBase {
  readonly method: RouteMethod;
  readonly path: string;
  readonly policy: RoutePolicy;
  readonly body: BodyPolicy;
}

export type RouteDefinition =
  | (RouteDefinitionBase & { readonly idempotency: 'none'; readonly handler: RouteHandler })
  | (RouteDefinitionBase & { readonly idempotency: 'required'; readonly perform: IdempotentOperation })
  | (RouteDefinitionBase & { readonly idempotency: 'required'; readonly command: CommandRoute });

export interface RouteTable {
  lookup(method: string, path: string): RouteDefinition | undefined;
  list(): readonly RouteDefinition[];
}

export type EnforcementSetupCode =
  | 'route_definition_invalid'
  | 'route_method_invalid'
  | 'route_path_invalid'
  | 'route_policy_missing'
  | 'route_policy_invalid'
  | 'route_body_policy_missing'
  | 'route_body_policy_invalid'
  | 'route_handler_invalid'
  | 'route_duplicate'
  | 'route_public_unsafe'
  | 'route_audience_mismatch'
  | 'route_session_endpoint_invalid'
  | 'authenticator_required'
  | 'authorizer_required'
  | 'trusted_origins_required'
  | 'trusted_origin_invalid'
  | 'rate_limit_invalid'
  | 'rate_limit_required'
  | 'rate_limit_key_invalid'
  | 'trusted_proxies_invalid'
  | 'session_boundary_invalid'
  | 'session_boundary_unconfigured'
  | 'session_verifier_required'
  | 'session_admission_required'
  | 'session_store_required'
  | 'session_authorizer_required'
  | 'session_origins_shared'
  | 'port_deadline_invalid'
  | 'route_idempotency_policy_missing'
  | 'route_idempotency_policy_invalid'
  | 'idempotency_required'
  | 'idempotency_invalid'
  | 'idempotency_key_invalid'
  | 'idempotency_key_shared'
  | 'command_transaction_required'
  | 'command_transaction_invalid'
  | 'command_registry_invalid'
  | 'outbox_registry_invalid'
  | 'outbox_delivery_invalid';

/** Startup refusal. Carries a bounded code only — never the rejected input. */
export class EnforcementSetupError extends Error {
  readonly code: EnforcementSetupCode;

  constructor(code: EnforcementSetupCode) {
    super(`enforcement setup refused: ${code}`);
    this.name = 'EnforcementSetupError';
    this.code = code;
  }
}

// Each boundary's reserved namespace and versioned prefix. The endpoint names are this
// slice's choice: the M4 blueprint (docs/phase-4/03 §3) sketches unversioned
// /admin/session/{login,whoami,logout}, while the same document (§1a) and the roadmap (09 M4)
// put the admin session under /admin/v1/* — so each boundary takes one consistent versioned
// set: POST <prefix>/session/login, GET <prefix>/session, POST <prefix>/session/logout.
const BOUNDARIES: Readonly<Record<SessionAudience, { readonly namespace: string; readonly prefix: string }>> = Object.freeze({
  tenant: Object.freeze({ namespace: '/api', prefix: '/api/v1' }),
  admin: Object.freeze({ namespace: '/admin', prefix: '/admin/v1' }),
});
const AUDIENCES: readonly SessionAudience[] = ['tenant', 'admin'];
/** Every versioned API prefix: a frontend server never answers under one with a document (adminWeb.ts). */
export const API_PREFIXES: readonly string[] = Object.freeze(AUDIENCES.map((audience) => BOUNDARIES[audience].prefix));

export interface SessionPaths {
  readonly login: string;
  readonly current: string;
  readonly logout: string;
}

/** A boundary's login, current-session and logout paths. */
export function sessionPaths(audience: SessionAudience): SessionPaths {
  const { prefix } = BOUNDARIES[audience];
  return Object.freeze({ login: `${prefix}/session/login`, current: `${prefix}/session`, logout: `${prefix}/session/logout` });
}

/** The boundary whose prefix holds `path`; 'reserved' elsewhere in its namespace; null outside both. */
function boundaryOf(path: string): SessionAudience | 'reserved' | null {
  for (const audience of AUDIENCES) {
    const { namespace, prefix } = BOUNDARIES[audience];
    if (path.startsWith(`${prefix}/`)) return audience;
    if (path === namespace || path.startsWith(`${namespace}/`)) return 'reserved';
  }
  return null;
}

const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);
const SCOPES: ReadonlySet<string> = new Set(['platform', 'tenant', 'store']);
const NO_BODY: BodyPolicy = Object.freeze({ kind: 'none' });
// One or more `/segment`, each starting [a-z0-9] then [a-z0-9_-]*.
const PATH_RE = /^(?:\/[a-z0-9][a-z0-9_-]*)+$/;
const MAX_PATH_LENGTH = 256;
// Lowercase tokens joined by `.`, `:` or `-`, e.g. `bcp.readiness:read`.
const PERMISSION_RE = /^[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/;
const MAX_PERMISSION_LENGTH = 64;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hasOnlyKeys = (obj: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(obj).every((key) => allowed.includes(key));

const isAudience = (v: unknown): v is SessionAudience => v === 'tenant' || v === 'admin';

function parseRequirement(raw: unknown): AuthorizationRequirement | null {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ['scope', 'permission'])) return null;
  const { scope, permission } = raw;
  if (typeof scope === 'string' && SCOPES.has(scope) && typeof permission === 'string'
    && permission.length <= MAX_PERMISSION_LENGTH && PERMISSION_RE.test(permission)) {
    return Object.freeze({ scope: scope as AuthorizationScope, permission });
  }
  return null;
}

function parsePolicy(raw: unknown): RoutePolicy {
  if (raw === undefined || raw === null) throw new EnforcementSetupError('route_policy_missing');
  if (isPlainObject(raw)) {
    // Every field is read exactly once, so the value validated is the value frozen.
    const { access, audience } = raw;
    if (access === 'public' && hasOnlyKeys(raw, ['access'])) return Object.freeze({ access: 'public' });
    if (access === 'authenticated' && hasOnlyKeys(raw, ['access', 'authorization'])) {
      const authorization = parseRequirement(raw.authorization);
      if (authorization !== null) return Object.freeze({ access: 'authenticated', authorization });
    }
    if (access === 'login' && hasOnlyKeys(raw, ['access', 'audience']) && isAudience(audience)) {
      return Object.freeze({ access: 'login', audience });
    }
    if (access === 'session' && hasOnlyKeys(raw, ['access', 'audience', 'authorization']) && isAudience(audience)) {
      const requirement = raw.authorization;
      if (requirement === null) return Object.freeze({ access: 'session', audience, authorization: null });
      const authorization = parseRequirement(requirement);
      if (authorization !== null) return Object.freeze({ access: 'session', audience, authorization });
    }
  }
  throw new EnforcementSetupError('route_policy_invalid');
}

function parseBody(raw: unknown, method: string): BodyPolicy {
  if (raw === undefined || raw === null) throw new EnforcementSetupError('route_body_policy_missing');
  if (isPlainObject(raw)) {
    // Read once each, as in parsePolicy: the cap validated is the cap enforced.
    const { kind, maxBytes, required } = raw;
    if (kind === 'none' && hasOnlyKeys(raw, ['kind'])) return NO_BODY;
    if (kind === 'json' && hasOnlyKeys(raw, ['kind', 'maxBytes', 'required']) && BODY_METHODS.has(method)
      && typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes > 0
      && maxBytes <= MAX_JSON_BODY_BYTES && typeof required === 'boolean') {
      return Object.freeze({ kind: 'json', maxBytes, required });
    }
  }
  throw new EnforcementSetupError('route_body_policy_invalid');
}

/**
 * The idempotency policy. Only a state-changing request of a verified principal under a declared
 * platform-scope authorization runs under a key: never a read, a public or login route, or a
 * session's own current-session and logout endpoints (whose authorization is null). A tenant- or
 * store-scoped route may not require one until the runtime has server-derived tenant and store
 * context to bind into the operation's fingerprint (M5): without it, one tenant's recorded
 * response could replay in another's context.
 */
function parseIdempotency(raw: unknown, method: string, policy: RoutePolicy): IdempotencyPolicy {
  if (raw === undefined || raw === null) throw new EnforcementSetupError('route_idempotency_policy_missing');
  if (raw === 'none') return 'none';
  const requirement = policy.access === 'authenticated' || policy.access === 'session' ? policy.authorization : null;
  if (raw === 'required' && method !== 'GET' && requirement !== null && requirement.scope === 'platform') return 'required';
  throw new EnforcementSetupError('route_idempotency_policy_invalid');
}

/** The session-boundary rules in the header: a path's namespace and its policy's audience agree. */
function checkBoundary(method: string, path: string, policy: RoutePolicy, body: BodyPolicy): void {
  const audience = policy.access === 'login' || policy.access === 'session' ? policy.audience : null;
  if (boundaryOf(path) !== audience) throw new EnforcementSetupError('route_audience_mismatch');
  if (audience === null) return;
  const paths = sessionPaths(audience);
  const login = method === 'POST' && path === paths.login;
  const endpoint = (method === 'GET' && path === paths.current) || (method === 'POST' && path === paths.logout);
  // Each session endpoint takes exactly its own policy and no body, whatever the registration
  // order, and no route but the current-session and logout endpoints omits its requirement.
  const valid = policy.access === 'login'
    ? login
    : policy.access === 'session' && !login && endpoint === (policy.authorization === null);
  // The three session paths carry only their own endpoints: no other method may borrow one.
  const reserved = path === paths.login || path === paths.current || path === paths.logout;
  if (!valid || (reserved && !login && !endpoint) || ((login || endpoint) && body.kind !== 'none')) {
    throw new EnforcementSetupError('route_session_endpoint_invalid');
  }
}

/** A command operation's shape; its contract is validated in createApp against the event contracts. */
function parseCommand(raw: unknown): CommandRoute {
  if (isPlainObject(raw) && hasOnlyKeys(raw, ['contract', 'plan'])) {
    const { contract, plan } = raw;
    // The contract as declared; createApp validates it against the event contracts before any request,
    // and the runtime reads only that validated copy.
    if (isPlainObject(contract) && typeof plan === 'function') return Object.freeze({ contract: contract as unknown as CommandContract, plan: plan as CommandPlanner });
  }
  throw new EnforcementSetupError('route_handler_invalid');
}

function parseDefinition(raw: unknown): RouteDefinition {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ['method', 'path', 'policy', 'body', 'idempotency', 'handler', 'perform', 'command'])) {
    throw new EnforcementSetupError('route_definition_invalid');
  }
  const { method, path, handler, perform, command } = raw;
  if (typeof method !== 'string' || !METHODS.has(method)) throw new EnforcementSetupError('route_method_invalid');
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !PATH_RE.test(path)) {
    throw new EnforcementSetupError('route_path_invalid');
  }
  const policy = parsePolicy(raw.policy);
  if (policy.access === 'public' && method !== 'GET') throw new EnforcementSetupError('route_public_unsafe');
  const body = parseBody(raw.body, method);
  checkBoundary(method, path, policy, body);
  const idempotency = parseIdempotency(raw.idempotency, method, policy);
  // The operation matches the policy: a handler for `none`; a `perform` or a `command` for `required` — exactly one.
  if (idempotency === 'none') {
    if (typeof handler !== 'function' || 'perform' in raw || 'command' in raw) throw new EnforcementSetupError('route_handler_invalid');
    return Object.freeze({ method: method as RouteMethod, path, policy, body, idempotency, handler: handler as RouteHandler });
  }
  if ('handler' in raw || ('perform' in raw) === ('command' in raw)) throw new EnforcementSetupError('route_handler_invalid');
  if ('command' in raw) return Object.freeze({ method: method as RouteMethod, path, policy, body, idempotency, command: parseCommand(command) });
  if (typeof perform !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  return Object.freeze({ method: method as RouteMethod, path, policy, body, idempotency, perform: perform as IdempotentOperation });
}

/** Validate every definition and build the closed, frozen table (key: `METHOD path`). */
export function defineRoutes(defs: readonly unknown[]): RouteTable {
  const table = new Map<string, RouteDefinition>();
  for (const raw of defs) {
    const def = parseDefinition(raw);
    const key = `${def.method} ${def.path}`;
    if (table.has(key)) throw new EnforcementSetupError('route_duplicate');
    table.set(key, def);
  }
  const list = Object.freeze([...table.values()]);
  return Object.freeze({
    lookup: (method: string, path: string) => table.get(`${method} ${path}`),
    list: () => list,
  });
}
