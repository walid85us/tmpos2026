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
// slash or encoding variant can inherit another route's policy. ONE exception, closed
// (M7A-CUSTOMERS-P4, -P6, -P7): the three declared templates GET /api/v1/customers/{id},
// GET /api/v1/customers/{id}/profile and PATCH /api/v1/customers/{id} — no other method, path or
// template registers. A templated GET takes no idempotency; the one templated PATCH (a closed set of
// exactly that route) must be an idempotency-required `command`, and the runtime binds its validated
// id into the idempotency fingerprint and hands it to the planner as ctx.targetId (app.ts,
// idempotency.ts). Every other templated combination is refused. {id} matches
// exactly one raw, undecoded, non-empty segment of at most 128 characters without '/'; the first
// template ends there, and the second requires exactly its one literal suffix segment after it,
// and nothing else (no empty segment, trailing slash, other suffix or extra segment). Lookup is
// an exact literal first, then the template ending in {id}, then the template with {id} before its
// suffix. The route's own handler (for the PATCH, the runtime) judges the id segment only after the
// chain has authenticated and authorized the request, so an unauthenticated caller learns nothing
// about an id's shape;
// no literal route may sit anywhere below a template's prefix.
// M7B-INVOICES-P1 — A SECOND CLOSED TEMPLATE SET, THE STORE TEMPLATES: exactly
// GET /api/v1/stores/{storeId}/invoice-drafts, POST /api/v1/stores/{storeId}/invoice-drafts,
// GET /api/v1/stores/{storeId}/invoice-drafts/{id} and — M7B-INVOICES-P1-R2 — GET
// /api/v1/stores/{storeId}/invoice-drafts/eligibility, whose literal last segment is matched before the {id} template's, so
// it is never read as a draft id. {storeId} is a SELECTOR segment separate from the {id} target and matches
// what {id} matches (one raw segment, 1-128 characters, no '/'); each must be a tenant-session route requiring a STORE-scope
// permission, the POST alone an idempotency-required `command`, the three GETs taking none — and no other route may require a
// store-scope permission at all, so no store is ever selected without a path naming it. The chain hands the store segment
// to the authorizer as RouteView.storeTarget — the canonical lowercase uuid, or null for any other spelling, which then
// selects no grant (a 403 like a missing or foreign store) — and nothing else ever reads it. A path outside that grammar is
// no route (the terminal 404). No literal route may sit below /api/v1/stores/.
// M7B-INVOICES-P2 adds PATCH /api/v1/stores/{storeId}/invoice-drafts/{id} (a second idempotency-required `command`) and GET
// /api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility; M7B-INVOICES-DISCARD-P1 adds POST
// /api/v1/stores/{storeId}/invoice-drafts/{id}/discard (a third, the first command with a literal segment after {id}: the
// chain reads its target before the matched route's own suffix, app.ts) and GET
// /api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility — eight store templates, three of them commands.
// M7B-INVOICES-P1 — ONE CLOSED SESSION-ROUTE EXCEPTION, THE STORE DIRECTORY: GET /api/v1/stores is the only session route
// beside the current-session and logout endpoints that declares no authorization. It must declare the session binding (its
// handler receives the presenting session's session key, RouteContext.sessionKey, and nothing else that names authority,
// and the client must name the session it checked in the session CSRF header), no trusted context, no recent sign-in, no
// body and no idempotency: its database routine derives every store the session's actor may act at from that key alone. No
// other path may take that shape, and that path may take no other bodiless authorization-free shape. Definitions are copied and
// frozen at registration; the table cannot change afterwards. Handlers receive
// (req, res, ctx) and no `next`: dispatch belongs to the chain alone, and a body reaches a
// handler only as the parsed ctx.body. A `perform` or a planner receives no request or response at all.
import type { Request, Response } from 'express';
import type { CommandContract } from './commandTransaction.js';
import type { TrustedScope } from './principals.js';

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

/**
 * Whether a route may execute only once the chain has a RESOLVED trusted authorization context for it —
 * the app-owned actor and the one grant its authorizer decided on (principals.ts TrustedScope), not merely
 * a verified principal (M5-GIAM-D1-P2, closing docs/phase-4/08 DA-31). Every route that requires
 * idempotency must declare `required`: those are the state-changing business routes, and startup refuses
 * one that could reach its operation without a context, whichever boundary it sits on. An authorizer that
 * answers a bare `true` resolves no actor, so such a route is refused at run time (403) before its body is
 * read, its key acquired or its operation entered — a `perform` and a `command` alike.
 */
export type TrustedContextPolicy = 'none' | 'required';

/**
 * Whether a route requires TRUSTED RECENT AUTHENTICATION — a provider-verified authentication time bound to
 * the session at login and no older than RECENT_AUTH_MAX_AGE_MS (sessions.ts, app.ts). Only a session route
 * with a declared authorization may require it: a Bearer-authenticated request carries no session, so no
 * trusted authentication time is bound to it, and nothing a request supplies may stand in for one.
 */
export type RecentAuthPolicy = 'none' | 'required';

/**
 * Whether a route's handler receives the presenting session's session key (M7A-CUSTOMERS-P2): never, or always. Only a
 * session route with a declared authorization, a required trusted context and no idempotency may require it — a read
 * whose database routine binds the read to the very minted session that presented it, and derives its authority from
 * that session rather than from the scope a caller could name. Since M7A-CUSTOMERS-P5-R1 such a read, though a GET,
 * also requires the session CSRF header (app.ts), so it is bound to the session its client checked as well: a request
 * whose cookie is another session's is refused before anything is read (DA-138). M7B-INVOICES-P1: the store directory,
 * GET /api/v1/stores, is the one route that must require it with NO authorization (and so no trusted context): its routine
 * derives every store from the session key alone (parseSessionBinding).
 */
export type SessionBindingPolicy = 'none' | 'required';

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
  /**
   * The provider-verified authentication time (epoch ms) of the credential a LOGIN request presented, for
   * the runtime's own login handler to bind into the session it issues (sessions.ts) — null on every other
   * route, so no business handler ever receives one. It is never read from a request body or header.
   */
  readonly authenticatedAt: number | null;
  /**
   * The TRUSTED SCOPE the route's authorizer decided on — the app-owned actor, the tenant and store it
   * selected, the grant and role behind that decision — or null when the route declared no
   * authorization or its authorizer resolved no actor (M5-GIAM-D1-P2-R1).
   *
   * It is the ONLY tenant or store a handler may treat as authority. A route that needs one declares
   * `trustedContext: 'required'`, and the chain refuses the request before the handler when none was
   * resolved, so such a handler never sees null. It is what the command path has always received
   * through CommandContext; a read route needs the same, and had no way to reach it.
   */
  readonly trusted: TrustedScope | null;
  /**
   * The presenting session's session key, only on a route declaring `sessionBinding: 'required'`; a SQL parameter,
   * never logged, echoed or stored. Null on every other route.
   */
  readonly sessionKey: string | null;
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
  /**
   * The canonical lowercase uuid the request path names, set by the runtime ONLY for a templated command route
   * (M7A-CUSTOMERS-P7: PATCH /api/v1/customers/{id}) after the chain has authenticated and authorized the request; the
   * same id is bound into the idempotency fingerprint. Absent on every literal route. Still untrusted as a target: the
   * planner validates it and the store's mutator decides whether it names anything. For the store template's command
   * (M7B-INVOICES-P1: POST /api/v1/stores/{storeId}/invoice-drafts) it is the store the path selects — the one the
   * authorizer selected the actor's grant at — so one key and body at two stores never replay each other's answer. For a
   * store template's command that also carries {id} (M7B-INVOICES-P2: PATCH /api/v1/stores/{storeId}/invoice-drafts/{id};
   * M7B-INVOICES-DISCARD-P1: POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard, read before the matched route's own
   * suffix) it is that {id} — the draft — and the store is `storeId` below.
   */
  readonly targetId?: string;
  /**
   * Set by the runtime ONLY for a store template's command that carries {id} (M7B-INVOICES-P2): the canonical lowercase uuid
   * of the path's store segment, which the runtime has already proven is the trusted scope's store. It is not a second
   * fingerprint target: the trusted store is bound into the fingerprint already. Absent on every other route.
   */
  readonly storeId?: string;
}

type PlanRecord = Readonly<Record<string, string | number | boolean>>;
/** A plan's change set: scalars, and for a contract's rows field (M7B-INVOICES-P1, outbox.ts) a list of flat records. */
type PlanChanges = Readonly<Record<string, string | number | boolean | readonly PlanRecord[]>>;

/** A command's plan: one aggregate's change, the events it enqueues and the response to send once committed. */
export interface CommandPlan {
  /** For a create (expectedVersion null) exactly ctx.newAggregateId; for an update the aggregate's UUID. */
  readonly aggregateId: string;
  readonly expectedVersion: number | null;
  readonly changes: PlanChanges;
  readonly events: readonly Readonly<{ type: string; payload: PlanRecord }>[];
  /** 200 or 201 only. */
  readonly response: IdempotentOutcome;
  /**
   * An update contract only, and optional: the 200 to send when the store finds the changes already in
   * place at the expected version — nothing is written but the idempotency completion, so no version
   * moves and no audit record or event exists. Without it such an answer is a fault (503).
   */
  readonly unchanged?: IdempotentOutcome;
  /**
   * A sensitive command's audit annex, and optional (M5-GIAM-D1-P2): the bounded reason pair the durable
   * audit row already carries — `reasonCode`, a closed lowercase token naming what the action did, and
   * `reason`, the operator's own bounded words, validated by the planner's own contract. It reaches the
   * audit record and nothing else: never the aggregate, never an event payload, never a response. Identity,
   * scope, action and permission are NOT here and never will be — those stay the runtime's own, taken from
   * the route and the trusted context (commandTransaction.ts).
   */
  readonly audit?: Readonly<{ reasonCode: string; reason: string }>;
}

/**
 * A planner's answer for a body that is not a valid request: a bounded 400 invalid_request. It is decided
 * once the idempotency record is acquired and, like a conflict, commits and records nothing — the attempt's
 * lease waits out its time, so the key stays bound to this request's fingerprint. A symbol, so no parsed
 * body can spell it.
 */
export const COMMAND_REQUEST_INVALID: unique symbol = Symbol('command_request_invalid');

/**
 * Plans from the body alone: synchronous, no I/O, no write — the runtime commits the plan. It runs once
 * the idempotency record is acquired (never for a replay), validates the body first and answers
 * COMMAND_REQUEST_INVALID for anything its contract refuses.
 */
export type CommandPlanner = (ctx: CommandContext) => CommandPlan | typeof COMMAND_REQUEST_INVALID;

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
  /** Declared, never defaulted for a route that requires idempotency: startup refuses one that omits it. */
  readonly trustedContext: TrustedContextPolicy;
  readonly recentAuth: RecentAuthPolicy;
  /** Optional: an undeclared binding is 'none'. */
  readonly sessionBinding?: SessionBindingPolicy;
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
  | 'session_store_audit_required'
  | 'session_authorizer_required'
  | 'session_origins_shared'
  | 'port_deadline_invalid'
  | 'route_idempotency_policy_missing'
  | 'route_idempotency_policy_invalid'
  | 'route_trusted_context_invalid'
  | 'route_recent_auth_invalid'
  | 'route_session_binding_invalid'
  | 'idempotency_required'
  | 'idempotency_invalid'
  | 'idempotency_key_invalid'
  | 'idempotency_key_shared'
  | 'command_transaction_required'
  | 'command_transaction_invalid'
  | 'command_registry_invalid'
  | 'outbox_registry_invalid'
  | 'host_invalid'
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

/**
 * The one path parameter: `/{id}`, final or followed by exactly one literal segment, on a template the table admits by
 * name (M7A-CUSTOMERS-P4, -P6, -P7).
 */
export const PATH_ID_SEGMENT = '/{id}';
/** The ONLY templated routes, as `METHOD path`: any other template is refused at registration. */
const TEMPLATED_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/customers/{id}', 'GET /api/v1/customers/{id}/profile', 'PATCH /api/v1/customers/{id}',
]);
/**
 * The templated routes that are idempotency-required COMMANDS (M7A-CUSTOMERS-P7), as `METHOD path`: a closed set of
 * exactly one. Such a route must require idempotency and declare a `command` (never a `perform`, which is handed no
 * target); every other template must be a GET that takes no idempotency.
 */
const IDEMPOTENT_TEMPLATED_ROUTES: ReadonlySet<string> = new Set(['PATCH /api/v1/customers/{id}']);
/** The store selector segment of the store templates (M7B-INVOICES-P1). */
export const STORE_SEGMENT = '/{storeId}';
/** The store templates' common prefix; the store directory (below) is exactly this literal path. */
export const STORE_DIRECTORY_PATH = '/api/v1/stores';
/**
 * The ONLY store-templated routes, as `METHOD path` (M7B-INVOICES-P1; the eligibility read since M7B-INVOICES-P1-R2; the edit
 * and its eligibility read since M7B-INVOICES-P2; the discard and its eligibility read since M7B-INVOICES-DISCARD-P1): any
 * other {storeId} template is refused.
 */
const STORE_TEMPLATED_ROUTES: ReadonlySet<string> = new Set([
  `GET ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts`, `POST ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts`,
  `GET ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts${PATH_ID_SEGMENT}`,
  `GET ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts/eligibility`,
  `PATCH ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts${PATH_ID_SEGMENT}`,
  `GET ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts${PATH_ID_SEGMENT}/edit-eligibility`,
  `POST ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts${PATH_ID_SEGMENT}/discard`,
  `GET ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts${PATH_ID_SEGMENT}/discard-eligibility`,
]);
/**
 * The store templates that are idempotency-required COMMANDS: a closed set of exactly the draft create, the draft edit and
 * (M7B-INVOICES-DISCARD-P1) the draft discard.
 */
const IDEMPOTENT_STORE_TEMPLATED_ROUTES: ReadonlySet<string> = new Set([
  `POST ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts`, `PATCH ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts${PATH_ID_SEGMENT}`,
  `POST ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}/invoice-drafts${PATH_ID_SEGMENT}/discard`,
]);
/** Every template's path before its `/{id}` (or, for a store template, its `/{storeId}`): no literal path may sit anywhere below one. */
const TEMPLATE_PREFIXES: ReadonlySet<string> = new Set([
  ...[...TEMPLATED_ROUTES].map((key) => key.slice(key.indexOf(' ') + 1, key.indexOf(PATH_ID_SEGMENT))), STORE_DIRECTORY_PATH,
]);
/** The longest raw segment a template matches; a longer one is no route (the terminal 404). */
export const MAX_PATH_ID_SEGMENT_LENGTH = 128;
/** Any uuid in PostgreSQL's canonical lowercase text form (customerDirectory.ts: 017 accepts every uuid). */
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The canonical lowercase uuid a path ends with as its own final segment, or null. Fixed-length slices, no backtracking.
 * A templated route's handler asks this of the same req.path the table matched: null is a malformed id.
 */
export function pathIdOf(path: string): string | null {
  return typeof path === 'string' && path.startsWith('/') && path.length > 37 && path[path.length - 37] === '/'
    && CANONICAL_UUID_RE.test(path.slice(-36)) ? path.slice(-36) : null;
}

/**
 * The canonical lowercase uuid a path names as the segment directly before its final `suffix` (e.g. '/profile'), or null:
 * pathIdOf of the path without that suffix. A suffix-templated route's handler asks this of the req.path the table matched.
 */
export function pathIdBeforeSuffixOf(path: string, suffix: string): string | null {
  return typeof path === 'string' && path.endsWith(suffix) ? pathIdOf(path.slice(0, path.length - suffix.length)) : null;
}

/**
 * The store a request path under a STORE template names (M7B-INVOICES-P1): the canonical lowercase uuid of the segment
 * directly after /api/v1/stores/, followed by '/', or null for any other spelling. The chain asks this of the req.path the
 * table matched to a store template and hands it to the authorizer as RouteView.storeTarget: a selector among the actor's
 * own store grants, never proof of access. Fixed-length slices, no backtracking.
 */
export function storeTargetOf(path: string): string | null {
  const prefix = `${STORE_DIRECTORY_PATH}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.length < prefix.length + 37) return null;
  const segment = path.slice(prefix.length, prefix.length + 36);
  return path[prefix.length + 36] === '/' && CANONICAL_UUID_RE.test(segment) ? segment : null;
}
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
 * authorization runs under a key: never a read, a public or login route, or a session's own
 * current-session and logout endpoints (whose authorization is null). The requirement is at platform
 * scope, or — M7A-CUSTOMERS-P3 — at tenant scope on a TENANT-SESSION `command` route only: app.ts binds
 * the authorizer's trusted tenant and actor into the operation's fingerprint, so one tenant's recorded
 * response never replays in another's context, and the tenant store re-proves both inside the committing
 * transaction while holding the presenting session — which a Bearer-authenticated tenant route does not
 * have, and a `perform` never reaches. A store-scoped route may require one only as a store command decided
 * (M7B-INVOICES-P1, M7B-INVOICES-P2, M7B-INVOICES-DISCARD-P1): a tenant-session `command` on the closed store POST, PATCH
 * or discard POST template, whose
 * fingerprint binds the trusted tenant, store and actor the same way; every other store-scoped route may not.
 */
function parseIdempotency(raw: unknown, method: string, path: string, policy: RoutePolicy, command: boolean): IdempotencyPolicy {
  if (raw === undefined || raw === null) throw new EnforcementSetupError('route_idempotency_policy_missing');
  if (raw === 'none') return 'none';
  const requirement = requirementOf(policy);
  const tenantSessionCommand = command && policy.access === 'session' && policy.audience === 'tenant';
  if (raw === 'required' && method !== 'GET' && requirement !== null && (requirement.scope === 'platform'
    || (requirement.scope === 'tenant' && tenantSessionCommand)
    || (requirement.scope === 'store' && tenantSessionCommand && IDEMPOTENT_STORE_TEMPLATED_ROUTES.has(`${method} ${path}`)))) return 'required';
  throw new EnforcementSetupError('route_idempotency_policy_invalid');
}

/** The requirement a policy declares, or null: an authenticated or session route's, and nothing else. */
function requirementOf(policy: RoutePolicy): AuthorizationRequirement | null {
  return policy.access === 'authenticated' || policy.access === 'session' ? policy.authorization : null;
}

/**
 * The trusted-context policy (M5-GIAM-D1-P2; docs/phase-4/08 DA-31). `required` needs a declared
 * authorization — without one no authorizer runs and no context could ever be resolved — and EVERY route
 * that requires idempotency must declare it: a state-changing business route that could reach its `perform`
 * or `command` with a verified principal alone fails startup rather than committing under no actor.
 */
function parseTrustedContext(raw: unknown, idempotency: IdempotencyPolicy, policy: RoutePolicy): TrustedContextPolicy {
  const declared = raw === undefined || raw === null ? 'none' : raw;
  if (declared === 'required' && requirementOf(policy) !== null) return 'required';
  if (declared === 'none' && idempotency === 'none') return 'none';
  throw new EnforcementSetupError('route_trusted_context_invalid');
}

/**
 * The recent-authentication policy. `required` only on a session route with a declared authorization: the
 * trusted authentication time is bound to a session record at login, so a public, login, Bearer or
 * requirement-less route has none to present and may not claim one.
 */
function parseRecentAuth(raw: unknown, policy: RoutePolicy): RecentAuthPolicy {
  const declared = raw === undefined || raw === null ? 'none' : raw;
  if (declared === 'none') return 'none';
  if (declared === 'required' && policy.access === 'session' && policy.authorization !== null) return 'required';
  throw new EnforcementSetupError('route_recent_auth_invalid');
}

/**
 * The session-binding policy (M7A-CUSTOMERS-P2). `required` only on a session route with a declared authorization, a
 * required trusted context and no idempotency: the key exists only on a session route, and the one route that needs it
 * is a read resolved under a trusted scope. M7B-INVOICES-P1: the store directory (`directory`, the header's one closed
 * exception) MUST declare it, with no authorization and so no trusted context — its routine derives everything from the key.
 */
function parseSessionBinding(raw: unknown, policy: RoutePolicy, trustedContext: TrustedContextPolicy, idempotency: IdempotencyPolicy, directory: boolean): SessionBindingPolicy {
  const declared = raw === undefined || raw === null ? 'none' : raw;
  if (declared === 'none' && !directory) return 'none';
  if (declared === 'required' && policy.access === 'session' && idempotency === 'none'
    && (directory ? trustedContext === 'none' : policy.authorization !== null && trustedContext === 'required')) return 'required';
  throw new EnforcementSetupError('route_session_binding_invalid');
}

/**
 * Whether a definition is the store directory's one closed shape (M7B-INVOICES-P1): GET /api/v1/stores, a TENANT session
 * route declaring no authorization. Only that path may be a session route without one beside the session endpoints.
 */
const isStoreDirectory = (method: string, path: string, policy: RoutePolicy): boolean =>
  method === 'GET' && path === STORE_DIRECTORY_PATH && policy.access === 'session' && policy.audience === 'tenant' && policy.authorization === null;

/** The session-boundary rules in the header: a path's namespace and its policy's audience agree. */
function checkBoundary(method: string, path: string, policy: RoutePolicy, body: BodyPolicy): void {
  const audience = policy.access === 'login' || policy.access === 'session' ? policy.audience : null;
  if (boundaryOf(path) !== audience) throw new EnforcementSetupError('route_audience_mismatch');
  if (audience === null) return;
  const paths = sessionPaths(audience);
  const login = method === 'POST' && path === paths.login;
  const endpoint = (method === 'GET' && path === paths.current) || (method === 'POST' && path === paths.logout);
  // Each session endpoint takes exactly its own policy and no body, whatever the registration
  // order, and no route but the current-session and logout endpoints — and the store directory's one closed shape
  // (M7B-INVOICES-P1) — omits its requirement.
  const valid = policy.access === 'login'
    ? login
    : policy.access === 'session' && !login && (endpoint === (policy.authorization === null) || isStoreDirectory(method, path, policy));
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
  if (!isPlainObject(raw) || !hasOnlyKeys(raw,
    ['method', 'path', 'policy', 'body', 'idempotency', 'trustedContext', 'recentAuth', 'sessionBinding', 'handler', 'perform', 'command'])) {
    throw new EnforcementSetupError('route_definition_invalid');
  }
  const { method, path, handler, perform, command } = raw;
  if (typeof method !== 'string' || !METHODS.has(method)) throw new EnforcementSetupError('route_method_invalid');
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH) throw new EnforcementSetupError('route_path_invalid');
  // A template registers only as itself — one declared (method, path) — and a literal path never anywhere below one. A
  // store template (M7B-INVOICES-P1) is one of exactly eight declared strings (M7B-INVOICES-DISCARD-P1), so its grammar is that set's.
  const key = `${method} ${path}`;
  const storeTemplated = path.includes(STORE_SEGMENT);
  const templated = !storeTemplated && path.includes(PATH_ID_SEGMENT);
  if (storeTemplated ? !STORE_TEMPLATED_ROUTES.has(key)
    : templated ? !TEMPLATED_ROUTES.has(key) || templateOf(path) === null
    : !PATH_RE.test(path) || [...TEMPLATE_PREFIXES].some((prefix) => path.startsWith(`${prefix}/`))) {
    throw new EnforcementSetupError('route_path_invalid');
  }
  const policy = parsePolicy(raw.policy);
  if (policy.access === 'public' && method !== 'GET') throw new EnforcementSetupError('route_public_unsafe');
  const body = parseBody(raw.body, method);
  checkBoundary(method, path, policy, body);
  const idempotency = parseIdempotency(raw.idempotency, method, path, policy, 'command' in raw);
  // A templated GET takes no idempotency; the closed set of templated commands takes nothing else — app.ts binds their
  // validated path id into the fingerprint (idempotency.ts `target`) and the planner context. Every other combination
  // (a templated GET under a key, a templated write without one, a templated `perform`) is refused. A store template must
  // also be a tenant-session route requiring a STORE-scope permission: its {storeId} selects among store grants only. And a
  // STORE-scope requirement sits on a store template and nowhere else: on any other path nothing names the store, and a
  // store may never be chosen implicitly (the tenant authorizer denies a store requirement without a target, too).
  if (storeTemplated
    ? policy.access !== 'session' || policy.audience !== 'tenant' || policy.authorization?.scope !== 'store'
    : requirementOf(policy)?.scope === 'store') {
    throw new EnforcementSetupError('route_path_invalid');
  }
  if ((templated || storeTemplated) && (IDEMPOTENT_TEMPLATED_ROUTES.has(key) || IDEMPOTENT_STORE_TEMPLATED_ROUTES.has(key)
    ? idempotency !== 'required' || !('command' in raw) || 'perform' in raw
    : method !== 'GET' || idempotency !== 'none')) {
    throw new EnforcementSetupError('route_path_invalid');
  }
  const trustedContext = parseTrustedContext(raw.trustedContext, idempotency, policy);
  const recentAuth = parseRecentAuth(raw.recentAuth, policy);
  const sessionBinding = parseSessionBinding(raw.sessionBinding, policy, trustedContext, idempotency, isStoreDirectory(method, path, policy));
  const declared = { method: method as RouteMethod, path, policy, body, idempotency, trustedContext, recentAuth, sessionBinding };
  // The operation matches the policy: a handler for `none`; a `perform` or a `command` for `required` — exactly one.
  if (idempotency === 'none') {
    if (typeof handler !== 'function' || 'perform' in raw || 'command' in raw) throw new EnforcementSetupError('route_handler_invalid');
    return Object.freeze({ ...declared, idempotency, handler: handler as RouteHandler });
  }
  if ('handler' in raw || ('perform' in raw) === ('command' in raw)) throw new EnforcementSetupError('route_handler_invalid');
  if ('command' in raw) return Object.freeze({ ...declared, idempotency, command: parseCommand(command) });
  if (typeof perform !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  return Object.freeze({ ...declared, idempotency, perform: perform as IdempotentOperation });
}

/** A template path split around its `/{id}`: a literal prefix and '' or one literal `/segment` after it — or null. */
function templateOf(path: string): { readonly prefix: string; readonly suffix: string } | null {
  const at = path.indexOf(PATH_ID_SEGMENT);
  const prefix = path.slice(0, at);
  const suffix = path.slice(at + PATH_ID_SEGMENT.length);
  return at > 0 && PATH_RE.test(prefix) && (suffix === '' || (PATH_RE.test(suffix) && suffix.lastIndexOf('/') === 0))
    ? Object.freeze({ prefix, suffix }) : null;
}

/** Whether `segment` is one an `{id}` matches: raw, 1-128 characters, no '/'. */
const isIdSegment = (segment: string): boolean =>
  segment.length >= 1 && segment.length <= MAX_PATH_ID_SEGMENT_LENGTH && !segment.includes('/');

/**
 * Validate every definition and build the closed, frozen table: literal routes and templates alike keyed `METHOD path`,
 * a template by its declared path. A literal path always matches exactly. Otherwise a request path matches the template
 * ending in {id} when it is that prefix, '/', and one id segment (raw, 1-128 characters, no '/'); failing that, the
 * template with {id} before a suffix when it is that prefix, '/', one id segment, and exactly that suffix. A request
 * literally spelling a template's path is such a segment ('{id}'), never the template itself. Failing all of those, a path
 * below /api/v1/stores/ matches a STORE template (M7B-INVOICES-P1) when the segment after that prefix is an id segment (the
 * store selector) and the rest is exactly the template's own rest — its literal segments, then, for the one ending in {id},
 * one more id segment. A rest that is exactly a store template's literal rest matches that template first, so
 * /invoice-drafts/eligibility (M7B-INVOICES-P1-R2) is never the {id} template's. The store selector is never part of any
 * other lookup. M7B-INVOICES-P2: failing those, the store template with {id} before one literal last segment matches when
 * the segment before the last is an id segment and the rest is exactly that template's (the edit eligibility's GET and,
 * since M7B-INVOICES-DISCARD-P1, the discard's POST and its eligibility's GET are declared, so another method or any other
 * suffix there matches nothing).
 */
export function defineRoutes(defs: readonly unknown[]): RouteTable {
  const table = new Map<string, RouteDefinition>();
  const templates = new Map<string, RouteDefinition>();
  const storeTemplates = new Map<string, RouteDefinition>();
  const ordered: RouteDefinition[] = [];
  for (const raw of defs) {
    const def = parseDefinition(raw);
    const map = def.path.includes(STORE_SEGMENT) ? storeTemplates : def.path.includes(PATH_ID_SEGMENT) ? templates : table;
    const key = `${def.method} ${def.path}`;
    if (map.has(key)) throw new EnforcementSetupError('route_duplicate');
    map.set(key, def);
    ordered.push(def);
  }
  const list = Object.freeze(ordered);
  const storePrefix = `${STORE_DIRECTORY_PATH}/`;
  /**
   * A store template for `path`: its store segment replaced by {storeId}, then its last segment by {id} if that is what
   * matches, then (M7B-INVOICES-P2) the segment before its last by {id}.
   */
  const storeLookup = (method: string, path: string): RouteDefinition | undefined => {
    if (storeTemplates.size === 0 || !path.startsWith(storePrefix)) return undefined;
    const end = path.indexOf('/', storePrefix.length);
    if (end < 0 || !isIdSegment(path.slice(storePrefix.length, end))) return undefined;
    const rest = path.slice(end);
    const literal = storeTemplates.get(`${method} ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}${rest}`);
    if (literal !== undefined) return literal;
    const last = rest.lastIndexOf('/');
    if (last <= 0) return undefined;
    const final = isIdSegment(rest.slice(last + 1))
      ? storeTemplates.get(`${method} ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}${rest.slice(0, last)}${PATH_ID_SEGMENT}`) : undefined;
    if (final !== undefined) return final;
    const before = rest.lastIndexOf('/', last - 1);
    return before > 0 && isIdSegment(rest.slice(before + 1, last))
      ? storeTemplates.get(`${method} ${STORE_DIRECTORY_PATH}${STORE_SEGMENT}${rest.slice(0, before)}${PATH_ID_SEGMENT}${rest.slice(last)}`) : undefined;
  };
  return Object.freeze({
    lookup: (method: string, path: string) => {
      const exact = table.get(`${method} ${path}`);
      if (exact !== undefined || typeof path !== 'string') return exact;
      if (templates.size === 0) return storeLookup(method, path);
      // prefix/{id}: the last segment is the id.
      const last = path.lastIndexOf('/');
      if (last <= 0) return undefined;
      const final = isIdSegment(path.slice(last + 1)) ? templates.get(`${method} ${path.slice(0, last)}${PATH_ID_SEGMENT}`) : undefined;
      if (final !== undefined) return final;
      // prefix/{id}/suffix: the segment before the last is the id, and the last is the template's own literal suffix.
      const before = path.lastIndexOf('/', last - 1);
      const suffixed = before > 0 && isIdSegment(path.slice(before + 1, last))
        ? templates.get(`${method} ${path.slice(0, before)}${PATH_ID_SEGMENT}${path.slice(last)}`) : undefined;
      return suffixed ?? storeLookup(method, path);
    },
    list: () => list,
  });
}
