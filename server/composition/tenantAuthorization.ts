// Phase 4.0 M5 — the tenant session boundary's two decisions: admission and route authorization
// (M5-GIAM-D1-P2-R1; G-IAM, GAP-13, DA-32; docs/phase-4/04 §2-§5).
//
// This file binds the PostgreSQL tenant admission (postgresTenantAdmission.ts, migration 011) to the
// two runtime ports the tenant boundary declares, and adds no authority of its own.
//
// ADMISSION (sessions.ts SessionAdmission) answers the question the boundary asks at login and again
// on EVERY protected request, because the tenant boundary keeps no revalidation window: may this
// verified reference hold a tenant session, at what version, and as which actor? The version is the
// database-derived witness that moves whenever a tenant the actor holds is suspended or reactivated, so a
// session admitted before such a transition is refused after it and the boundary revokes it; the actor is
// the internal user the session's audit records name (M5-TENANT-SESSION-P1). A denial ends every session
// that principal holds on this boundary; an outage is a throw, which the boundary turns into a bounded 503
// and never into a verdict. Its readiness probe is the port's own (M7A-CUSTOMERS-P2), forwarded as the
// platform sibling forwards its own, so readiness asks the admission every protected request depends on.
//
// THE LOGIN'S STANDING CHECK (createTenantEstablishCheck, M5-TENANT-SESSION-P1) is that same admission asked
// once more where a tenant login writes: first on establish's own transaction the actor's standing rows are
// held until its COMMIT (016's hold), then the admission is re-read there and must still answer the witness
// the new session carries. A change committed before the re-read refuses the login; one not yet committed
// waits for its COMMIT, and the next protected request judges it.
//
// ROUTE AUTHORIZATION (access.ts RouteAuthorizer) decides one request against the actor's trusted
// standing. It re-reads admission rather than trusting the session, so the decision is made on what
// the database says now:
//   1. the route's declared scope must be tenant or store — a platform requirement belongs to the
//      platform authorizer and is refused here;
//   2. admission must admit; a refusal is a denial, an outage a throw;
//   3. the SELECTOR is derived from the actor's own grants, never from the request: exactly one grant
//      at the route's scope selects it, and none or several is a denial — there is no authoritative
//      rule for choosing between two, so this file chooses neither;
//   4. selectScope (principals.ts) applies the ONE lifecycle decision again — a suspended tenant, a
//      suspended store, a status this runtime does not recognise, or a store whose parent tenant
//      denies, all refuse — and narrows the actor to read-only where the account or the scope is;
//   5. the route's permission must be one the canonical catalog defines for that scope; an invented
//      or misspelled key is a denial, never a weaker permission;
//   6. a read-only actor may reach only a route EXPLICITLY classified as a read. The classification is
//      supplied, never inferred from the method: a GET that changes state would otherwise be treated
//      as safe because of its verb;
//   7. where the catalog decides the permission, the selected grant's role must hold it (below).
//
// THE ROLE DECISION, AND WHERE IT IS NOT MADE. For a key the canonical catalog DECIDES — the tenant
// route permissions owner decision D1 fixed: view_customers for GET /api/v1/customers (M7A-CUSTOMERS-P1)
// and create_customers for POST /api/v1/customers (M7A-CUSTOMERS-P3, ADR-34), and edit_customers for
// PATCH /api/v1/customers/{id} (M7A-CUSTOMERS-P7) — the selected grant's role must hold it (step 7 below), by the catalog's own rule.
// Every other tenant- and store-scope key is 'undecidable' until D1 defines its route and authoritative
// product rules (m5CanonicalPermissions.ts GAP_11_TENANT_ORDERING_UNRESOLVED, GAP-11), and deciding it
// here would be exactly the comparison-of-unsettled-meaning that gate exists to prevent. For those the
// consequence is stated rather than worked around: the production route inventory REFUSES to start
// while any route in it DECLARES such a requirement — `uncataloguedRoutePermissions`
// (productionTransactions.ts) answers `route_permission_undecidable` for a catalogued key it cannot
// decide and `route_permission_uncatalogued` for a key the catalog does not define, and a route whose
// requirement is null is skipped. So no deployment serves a route decided on membership and lifecycle
// alone; the witness harnesses that prove that enforcement over real sockets use such keys.
//
// M7A-CUSTOMERS-P3 UPDATE. THE COMMAND'S REVALIDATOR (createTenantContextRevalidator) asks the same questions
// again inside the tenant command's own transaction, where the write commits: the presenting tenant session held,
// 016's hold of the actor's standing, the admission re-read at the session's witness, the SAME selection (scopeOf)
// compared field by field with the scope the authorizer handed out, and the route's permission decided again. It
// adds no authority either: every answer is the database's, every rule this file's.
//
// M7A-CUSTOMERS-P3-R1 UPDATE. A role is decided on its CURRENT definition. Both decisions read the owner's durable edits
// of the selected grant's role — keyed by that grant's tenant and role, which come from the admission answer and never
// from the request (migration 020, tmpos_role.m7a_role_levels) — and hand them to the canonical decision, which requires
// them: the authorizer on the composition's own client (`levels`; a read fault is a throw, a bounded 503), the revalidator
// on the committing transaction after the standing is held and re-read. So an owner who narrows a role denies that role's
// next request, an already-issued session included, with no re-login. The owner-only edit_role_levels route declares a
// recent authentication; the revalidator judges that deadline on the database's clock, exactly as the administrative
// revalidation does (postgresPrincipalResolver.ts), and it still refuses a deadline on a route whose permission is not
// sensitive — no such route declares one — so neither kind can commit under the other's evidence.
//
// EVERY DENIAL IS ONE VALUE, `false` — the chain's generic 403 — whatever failed: no actor, no grant,
// an ambiguous grant, a suspended tenant, a stale witness, an uncatalogued permission, a read-only
// actor on a route that is not a read. A caller cannot tell which, so none of them is a probe.
//
// NOTHING IS LOGGED OR KEPT. No principal, actor, role or decision leaves this file except as the answer.
import type { RouteAuthorizer, RouteView } from '../runtime/access.js';
import { isTrustedPrincipal, selectScope } from '../runtime/principals.js';
import type { TenantAdmissionPort, TrustedPrincipal, TrustedScope } from '../runtime/principals.js';
import type { AuthorizationRequirement, AuthorizationScope, SessionAudience, VerifiedPrincipal } from '../runtime/routes.js';
import type { SessionAdmission, SessionRecord } from '../runtime/sessions.js';
import { canonicalPermission, evaluateCanonicalPermission, isDecidablePermission } from '../platform-identity/m5CanonicalPermissions.js';

/** The one outage message: an admission that could not answer, and nothing about why. */
const UNAVAILABLE = 'tenant admission unavailable';

/**
 * The exact shape the session boundary will carry as a version (sessions.ts VERSION_RE). Restated
 * here rather than imported because the boundary keeps it private; the two must agree, and the
 * consequence of disagreeing is stated where it is enforced below.
 */
const VERSION_RE = /^[\x21-\x7e]{1,128}$/;

/** The scopes this boundary decides. A platform requirement is the other authorizer's. */
const TENANT_SCOPES: ReadonlySet<AuthorizationScope> = new Set<AuthorizationScope>(['tenant', 'store']);

/** An admitted answer as this file reads it: the standing, and the witness to bind. */
type Admitted =
  | { readonly admitted: false }
  | { readonly admitted: true; readonly principal: TrustedPrincipal; readonly securityVersion: string };

const DENIED: Admitted = Object.freeze({ admitted: false });

export interface TenantAdmissionDeps {
  /** The trusted admission port: in production the PostgreSQL one over the composition's own client. */
  readonly admission: TenantAdmissionPort;
}

function checked(deps: TenantAdmissionDeps | undefined): TenantAdmissionPort {
  const admission = deps?.admission;
  if (typeof admission !== 'object' || admission === null || typeof admission.admit !== 'function') {
    throw new TypeError('tenant admission dependencies invalid');
  }
  return admission;
}

/**
 * An admission answer, read once. A shape this file does not recognise is an OUTAGE, never a denial: a
 * denial would revoke every session the principal holds, and an adapter answering nonsense is not
 * evidence that anyone's access was withdrawn.
 */
function admittedOf(answer: unknown): Admitted {
  if (typeof answer !== 'object' || answer === null) throw new Error(UNAVAILABLE);
  const { outcome, principal: resolved, securityVersion } = answer as Record<string, unknown>;
  if (outcome === 'refused') return DENIED;
  if (outcome !== 'admitted') throw new Error(UNAVAILABLE);
  // The SHAPE, not merely the type. The boundary carries a version only if it matches its own
  // VERSION_RE (sessions.ts), and maps anything else to a DENIAL — which revokes every session that
  // principal holds. So an adapter answering a version the boundary cannot carry would cause a
  // silent, continuous mass logout rather than the outage this file promises. Refusing it here keeps
  // that promise: the one witness this repository's adapter derives is `t2:` plus 43 base64url
  // characters, well inside the bound, and a replaceable adapter that strays outside it is an outage.
  if (typeof securityVersion !== 'string' || !VERSION_RE.test(securityVersion)) throw new Error(UNAVAILABLE);
  // Checked HERE, not merely upstream. The adapter validates the same shape, but a replaceable adapter
  // is exactly what this boundary must not take on trust: without this, the only thing standing between
  // a malformed standing and a decision is that today's callers happen to re-validate it inside
  // selectScope. The platform sibling makes the same check at the same place.
  if (!isTrustedPrincipal(resolved)) throw new Error(UNAVAILABLE);
  return Object.freeze({ admitted: true, principal: resolved, securityVersion });
}

async function admitted(admission: TenantAdmissionPort, principal: VerifiedPrincipal, signal: AbortSignal): Promise<Admitted> {
  return admittedOf(await admission.admit(principal, signal));
}

/**
 * The tenant boundary's SessionAdmission. `{ admitted: true, securityVersion, actor }` admits — `actor` the
 * resolved internal user, which the boundary's audited login records; anything else denies; a throw is an
 * outage the boundary fails closed on.
 */
export function createTenantSessionAdmission(deps: TenantAdmissionDeps): SessionAdmission {
  const admission = checked(deps);
  return Object.freeze({
    async admit(principal: VerifiedPrincipal, audience: SessionAudience, signal: AbortSignal): Promise<unknown> {
      // This adapter answers for the TENANT boundary alone, and being asked about another is a WIRING
      // FAULT, never a request. It THROWS rather than denying, and the difference is large: the
      // boundary treats a denial as "this principal may hold no session here" and revokes every
      // session it holds — at login too. So composing this adapter on the ADMIN boundary by mistake
      // would, if this denied, 401 every administrator AND destroy their live sessions on every
      // device, silently and continuously, until someone noticed. A throw is an outage instead: a
      // bounded 503 that revokes nothing and is loud enough to find.
      if (audience !== 'tenant') throw new Error(UNAVAILABLE);
      const answer = await admitted(admission, principal, signal);
      if (!answer.admitted) return false;
      return Object.freeze({ admitted: true, securityVersion: answer.securityVersion, actor: answer.principal.actor });
    },
    // The port declares it (principals.ts); a port without one throws here, which readiness reads as not ready.
    probe(signal: AbortSignal): unknown {
      return admission.probe(signal);
    },
  });
}

/**
 * Migration 016's hold on the caller's own handle (in production postgresTenantAdmission.ts holdTenantStanding): true
 * once the actor's standing rows are locked until that transaction ends, false when the reference names no account; a
 * THROW for anything else.
 */
export type TenantStandingHold<Handle> = (sql: Handle, principal: VerifiedPrincipal) => Promise<boolean>;

/** The tenant admission on the caller's own handle (in production postgresTenantAdmission.ts readTenantAdmission). A fault throws. */
export type TenantStandingRead<Handle> = (sql: Handle, principal: VerifiedPrincipal) => Promise<unknown>;

export interface TenantEstablishCheckDeps<Handle> {
  readonly hold: TenantStandingHold<Handle>;
  readonly read: TenantStandingRead<Handle>;
}

/**
 * The tenant login's standing check (M5-TENANT-SESSION-P1; ADR-31), which the session store runs FIRST on establish's
 * own transaction: true only when the standing `record` was admitted at still holds there. It holds the record's actor
 * (016's hold), then re-reads the admission on that transaction and requires it to admit at exactly the record's
 * witness. False when the reference names no account any more, or the standing moved or no longer admits (the login
 * is refused, nothing written). A record of another audience, a fault or an answer this file does not recognise
 * THROWS and is never caught here: an outage (a 503 that ends and records nothing), never a changed standing.
 */
export function createTenantEstablishCheck<Handle>(deps: TenantEstablishCheckDeps<Handle>): (sql: Handle, record: SessionRecord) => Promise<boolean> {
  const hold = deps?.hold;
  const read = deps?.read;
  if (typeof hold !== 'function' || typeof read !== 'function') throw new TypeError('tenant establish check dependencies invalid');
  return async (sql: Handle, record: SessionRecord): Promise<boolean> => {
    // A wiring fault, never a verdict: the administrative record has its own check (platformAuthorization.ts).
    if (record.audience !== 'tenant') throw new Error(UNAVAILABLE);
    const principal: VerifiedPrincipal = Object.freeze({ authProvider: record.authProvider, authProviderUid: record.authProviderUid });
    const held = await hold(sql, principal);
    if (held === false) return false;
    if (held !== true) throw new Error(UNAVAILABLE);
    const answer = admittedOf(await read(sql, principal));
    return answer.admitted && answer.securityVersion === record.securityVersion;
  };
}

/**
 * The owner's durable edits of one tenant's role (M7A-CUSTOMERS-P3-R1; in production postgresRoleLevels.ts over the
 * composition's own client): the stored levels by domain — {} when nothing is stored — for the canonical decision to
 * judge. A fault THROWS: an outage, never an answer of "no edits".
 */
export type TenantRoleLevelsRead = (tenantId: string, roleId: string, signal: AbortSignal) => Promise<unknown>;

/** The same read on the caller's own handle — the committing transaction (in production postgresRoleLevels.ts readRoleLevels). */
export type TenantRoleLevelsHeld<Handle> = (sql: Handle, tenantId: string, roleId: string) => Promise<unknown>;

/**
 * Whether trusted authentication evidence that goes stale at `authNotAfter` (epoch ms) is still fresh by the DATABASE's
 * clock on the caller's handle (in production postgresSessionStore.ts authenticationFresh). A fault throws.
 */
export type TenantAuthenticationFresh<Handle> = (sql: Handle, authNotAfter: number) => Promise<boolean>;

export interface TenantAuthorizerDeps extends TenantAdmissionDeps {
  /**
   * The routes EXPLICITLY classified as reads, as `${method} ${path}` — the only ones a read-only
   * actor may reach. Absent means none is: a read-only actor then reaches nothing, which is the
   * closed default.
   */
  readonly reads?: ReadonlySet<string>;
  /** The selected role's durable edits, read for every permission the catalog decides. Required. */
  readonly levels: TenantRoleLevelsRead;
}

/** The route's classification key: exactly the method and literal path the table registered. */
export function readKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * The ONE selection both the authorizer and the command revalidator make: the actor's own grants at `scope` — exactly
 * one, never a choice between several — through selectScope's lifecycle decision. The selected scope, or null.
 */
function scopeOf(resolved: TrustedPrincipal, scope: AuthorizationScope): TrustedScope | null {
  const atScope = resolved.memberships.filter((m) => m.scopeType === scope);
  if (atScope.length !== 1) return null;
  const selection = selectScope(resolved, scope, { tenant: atScope[0].tenant, store: atScope[0].store });
  return selection.outcome === 'selected' ? selection.scope : null;
}

/** The eight fields of a trusted scope, compared one by one (platformAuthorization.ts's rule, restated for this plane). */
const sameScope = (a: TrustedScope, b: TrustedScope): boolean =>
  a.scope === b.scope && a.actor === b.actor && a.securityVersion === b.securityVersion && a.membershipId === b.membershipId
  && a.roleId === b.roleId && a.limitation === b.limitation && a.tenant === b.tenant && a.store === b.store;

/** A tenant session on the caller's own handle (in production postgresSessionStore.ts readTenantSession / holdTenantSession). */
export type TenantSessionRead<Handle> = (sql: Handle, key: string) => Promise<SessionRecord | undefined>;

export interface TenantRevalidatorDeps<Handle> {
  /** 016's hold of the actor's standing rows (postgresTenantAdmission.ts holdTenantStanding). */
  readonly hold: TenantStandingHold<Handle>;
  /** 016's v2 admission, re-read under that hold (postgresTenantAdmission.ts readTenantAdmission). */
  readonly read: TenantStandingRead<Handle>;
  /** The presenting session, read WITHOUT a lock, only for the reference its standing is held by (readTenantSession). */
  readonly peek: TenantSessionRead<Handle>;
  /** The presenting session, read again and held until COMMIT (holdTenantSession). */
  readonly session: TenantSessionRead<Handle>;
  /** The selected role's durable edits, read on the committing transaction (M7A-CUSTOMERS-P3-R1). */
  readonly levels: TenantRoleLevelsHeld<Handle>;
  /** The recent-authentication deadline, judged on the database's clock (M7A-CUSTOMERS-P3-R1). */
  readonly fresh: TenantAuthenticationFresh<Handle>;
}

/**
 * The tenant store's ContextRevalidator (postgresTransactionalStore.ts, `contextScope: 'tenant'`; M7A-CUSTOMERS-P3, ADR-34):
 * exactly true only when the scope is one this authorizer could have handed out — tenant, not read-only — the tenant
 * session that presented the command is still live and now held by the committing transaction, the standing it is bound
 * to still admits it at its own witness and selects exactly this scope, and `permission` is still granted to that role.
 *
 * ORDERED AGAINST REVOCATION, on the committing transaction after the store's fence (ADR-31's establish order): the
 * session read unlocked (`peek`, for its provider reference alone), 016's hold of that actor's standing — the account FOR
 * UPDATE, then its links, grants, tenants and stores FOR SHARE — then the session row held (`session`: a logout or a
 * revocation committed first leaves nothing to hold, one not yet committed waits for this COMMIT), then 016's admission
 * re-read under those locks. So a suspension, a grant change or an account change committed before the hold refuses the
 * command, and one attempted after it waits. The mutator's definer routine then re-holds the same rows and re-derives
 * the tenant from the same session key (migration 019; since M7A-CUSTOMERS-P3-R1 its successors in migration 020).
 *
 * THE PERMISSION, ON THE ROLE'S CURRENT DEFINITION (M7A-CUSTOMERS-P3-R1): after those reads, the owner's durable edits of the
 * selected role are read on this transaction (`levels`) and the permission is decided with them. An edit that committed
 * first is read and decides; one racing this command orders on the role row the mutator's definer routine locks
 * (migration 020), which re-decides on the locked value.
 *
 * RECENT AUTHENTICATION: required exactly for a SENSITIVE tenant route permission — edit_role_levels, whose route declares
 * `recentAuth: 'required'` — and judged by `fresh` on the database's clock (clock_timestamp(), the administrative path's
 * rule), so evidence that expired between the chain's check and this point commits nothing. A non-sensitive permission's
 * route declares none, so `authNotAfter` set on one is refused; a sensitive one without it is refused too. A command with
 * no session key is refused. A refusal is false; a hold, read, session, levels or clock fault THROWS, and the store's
 * kernel rolls back either way — nothing commits.
 */
export function createTenantContextRevalidator<Handle>(
  deps: TenantRevalidatorDeps<Handle>,
): (sql: Handle, scope: TrustedScope, permission: string, authNotAfter: number | null, sessionKey: string | null) => Promise<boolean> {
  const hold = deps?.hold;
  const read = deps?.read;
  const peek = deps?.peek;
  const session = deps?.session;
  const levels = deps?.levels;
  const fresh = deps?.fresh;
  if (typeof hold !== 'function' || typeof read !== 'function' || typeof peek !== 'function' || typeof session !== 'function'
    || typeof levels !== 'function' || typeof fresh !== 'function') {
    throw new TypeError('tenant revalidator dependencies invalid');
  }
  return async (sql: Handle, scope: TrustedScope, permission: string, authNotAfter: number | null, sessionKey: string | null): Promise<boolean> => {
    if (scope.scope !== 'tenant' || scope.limitation !== 'none' || scope.tenant === null || sessionKey === null) return false;
    // A deadline exactly when the permission is sensitive: the route that requires it declares a recent authentication.
    const sensitive = canonicalPermission('tenant', permission)?.sensitive === true;
    if (sensitive ? !(typeof authNotAfter === 'number' && Number.isSafeInteger(authNotAfter) && authNotAfter > 0) : authNotAfter !== null) return false;
    const seen = await peek(sql, sessionKey);
    if (seen === undefined) return false;
    const principal: VerifiedPrincipal = Object.freeze({ authProvider: seen.authProvider, authProviderUid: seen.authProviderUid });
    const held = await hold(sql, principal);
    if (held === false) return false;
    if (held !== true) throw new Error(UNAVAILABLE);
    // The session row, now held: still live, and still the same principal's (a key never changes its reference).
    const live = await session(sql, sessionKey);
    if (live === undefined || live.authProvider !== seen.authProvider || live.authProviderUid !== seen.authProviderUid) return false;
    // The standing, read again under every lock above: admitted at the session's own witness, selecting exactly the scope
    // the command was authorized on — the actor, the very grant, its role and tenant — and the permission decided again.
    const answer = admittedOf(await read(sql, principal));
    if (!answer.admitted || answer.securityVersion !== live.securityVersion) return false;
    const selected = scopeOf(answer.principal, 'tenant');
    if (selected === null || !sameScope(selected, scope)) return false;
    // The recent authentication, when the permission requires one, on the database's clock — after every lock above.
    if (authNotAfter !== null && (await fresh(sql, authNotAfter)) !== true) return false;
    // The role's current definition, on this transaction, for exactly the grant the database just confirmed.
    const edits = await levels(sql, scope.tenant, scope.roleId);
    return evaluateCanonicalPermission({ scope: 'tenant', roleId: scope.roleId, permission, limitation: 'none', levels: edits }) === 'granted';
  };
}

export function createTenantRouteAuthorizer(deps: TenantAuthorizerDeps): RouteAuthorizer {
  const admission = checked(deps);
  // Required, like the port: an authorizer that could decide a role without its current definition would decide on the
  // defaults an owner may have narrowed (M7A-CUSTOMERS-P3-R1).
  const readLevels = deps.levels;
  if (typeof readLevels !== 'function') throw new TypeError('tenant authorizer role levels invalid');
  // Validated at CONSTRUCTION, like the port beside it, and COPIED. A classification that is not a
  // real Set — an array, a string, or an object whose `has` answers true for anything — would otherwise
  // either fail only when a read-only actor first reached a route (a 500, for some actors and not
  // others) or, worse, classify every write as a read. Holding the caller's own Set would let a later
  // mutation of it widen what a read-only actor reaches after startup; a private copy cannot move.
  const declared: unknown = deps?.reads;
  if (declared !== undefined && (!(declared instanceof Set) || ![...declared].every((key) => typeof key === 'string'))) {
    throw new TypeError('tenant authorizer read classification invalid');
  }
  const reads: ReadonlySet<string> = new Set<string>(declared === undefined ? [] : (declared as Set<string>));
  return Object.freeze({
    async authorize(principal: VerifiedPrincipal, requirement: AuthorizationRequirement, route: RouteView, signal: AbortSignal): Promise<unknown> {
      if (!TENANT_SCOPES.has(requirement.scope)) return false;
      const answer = await admitted(admission, principal, signal);
      if (!answer.admitted) return false;
      const resolved = answer.principal;

      // The selector is the ACTOR's, not the request's: the grants the database says they hold at the
      // route's scope. Exactly one names the tenant (and store) this request may act under; none is
      // unauthorized and several are ambiguous, and no authoritative document says which to prefer.
      //
      // ITS COST, STATED. No route path carries a tenant or store segment, so there is nothing a
      // request could legitimately narrow WITH. An actor holding grants on two stores is therefore
      // denied EVERY store route, and one holding only a tenant grant is denied every store route as
      // well. Both fail closed, which is the right direction, but a genuine multi-store operator
      // cannot use a store route under this rule. Settling that is part of owner decision D1, which
      // also gates the first such route, so nothing is blocked by it today.
      const scope = scopeOf(resolved, requirement.scope);
      if (scope === null) return false;

      // The permission must NAME something: a key the catalog does not define is a typo or an
      // invention, never a weaker permission. Where the catalog DECIDES the key — the tenant route
      // permissions owner decision D1 fixed (view_customers, M7A-CUSTOMERS-P1; create_customers,
      // M7A-CUSTOMERS-P3, ADR-34; edit_customers, M7A-CUSTOMERS-P7; the owner-only edit_role_levels, M7A-CUSTOMERS-P3-R1) — the selected grant's ROLE must
      // hold it, on the scope's limitation and the role's current definition: the owner's durable edits of that role in
      // that tenant, read now (a fault throws — a 503, never a decision on the defaults). Any other catalogued key stays
      // undecidable and is not decided here (see the header: the production inventory refuses such a route at startup).
      if (canonicalPermission(requirement.scope, requirement.permission) === null) return false;
      if (isDecidablePermission(requirement.scope, requirement.permission)) {
        if (scope.tenant === null) return false; // a decided key is tenant scope, which always names its tenant
        const levels = await readLevels(scope.tenant, scope.roleId, signal);
        if (evaluateCanonicalPermission({
          scope: requirement.scope, roleId: scope.roleId, permission: requirement.permission, limitation: scope.limitation, levels,
        }) !== 'granted') return false;
      }

      // A read-only actor — read-only account, read-only tenant, or an overdue one — may reach only a
      // route classified as a read. The classification is the table's, supplied by the composition,
      // never inferred from the HTTP method.
      if (scope.limitation === 'read_only' && !reads.has(readKey(route.method, route.path))) return false;

      return Object.freeze({ granted: true, context: scope });
    },
  });
}
