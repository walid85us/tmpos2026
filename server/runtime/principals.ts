// Phase 4.0 M5 — the trusted principal: the port that turns a verified provider reference into an
// app-owned actor, and the pure scope selection that decides which of that actor's grants a request
// may act under (M5 phase (i); G-DBROLE, G-CPLOGIN; docs/phase-4/04 §5).
//
// PURE AND PORTABLE. This module holds the CONTRACT and the DECISION, never an implementation: no
// database, no driver, no environment, no Express, no logging, no clock, no randomness. It is part of
// the emitted runtime artifact, so it may import nothing outside server/runtime.
//
// WHAT AUTHORITY IS, HERE. A request carries a verified provider reference and, at most, a SELECTOR —
// a tenant id, a store id — copied from the request. A selector is not authority: it can only pick
// among grants the database already says this actor holds, and a selector that matches none is
// refused. Nothing in this module reads a role, a permission, a tenant or a store from a request
// body, and there is no path by which a caller supplies its own internal_user_id: the actor only ever
// arrives inside a TrustedPrincipal, which only the resolver port produces.
//
// NO DEFAULT IS INVENTED. No authoritative document defines which tenant or store to pick when an
// actor holds several eligible grants, so this module picks none: an ambiguous selection is refused,
// exactly like an absent one. A platform scope is never inferred from a missing selector either —
// the scope comes from the route's own declared requirement, never from the shape of the request.
//
// EVERY REFUSAL IS ONE VALUE. 'refused' does not say whether the actor, the tenant, the store or the
// grant was the problem, so a caller cannot probe for the existence of any of them.
import type { AuthorizationScope, VerifiedPrincipal } from './routes.js';

/** Whether the account, tenant or store status limits this context to reads (docs/phase-4/04 §2). */
export type AccountLimitation = 'none' | 'read_only';

/** A UUID in any version, lowercase or upper — the shape every identifier below must have. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The admission security version's shape, identical to sessions.ts: 1-128 printable ASCII, no space. */
const VERSION_RE = /^[\x21-\x7e]{1,128}$/;
/** A durable status value: short, printable, no space — the six values 002's CHECK constraints allow. */
const STATUS_RE = /^[a-z_]{1,32}$/;
/** A role id as migration 003 pins it. */
const ROLE_RE = /^[a-z_]{1,64}$/;
/** More grants than any real principal holds; the resolver refuses beyond it and so does this. */
const MAX_MEMBERSHIPS = 200;

/** The statuses that limit a context to reads — authorizationConstants.ts, mirrored for the runtime. */
const READ_ONLY_STATUSES: ReadonlySet<string> = new Set(['read_only', 'overdue']);

/** One usable grant: this actor holds `roleId` at this scope, and the scope itself is whole. */
export interface TrustedMembership {
  readonly membershipId: string;
  readonly scopeType: AuthorizationScope;
  readonly tenant: string | null;
  readonly store: string | null;
  readonly roleId: string;
  /** The tenant's durable status, or null at platform scope. */
  readonly tenantStatus: string | null;
  /** The store's durable status, or null above store scope. */
  readonly storeStatus: string | null;
}

/** An actor as durable state describes it. Carries no provider reference, token, cookie or email. */
export interface TrustedPrincipal {
  /** The app-owned internal_user_id — the only actor identity anything downstream ever sees. */
  readonly actor: string;
  readonly accountStatus: string;
  readonly limitation: AccountLimitation;
  /** Opaque: compared for equality, never parsed. */
  readonly securityVersion: string;
  readonly memberships: readonly TrustedMembership[];
}

/**
 * What the port answers. `refused` is a decision — this reference names no actor that may act;
 * `unavailable` is an outage — nothing was decided, and a caller must not read it as a denial it can
 * cache, nor as permission.
 */
export type PrincipalResolution =
  | { readonly outcome: 'resolved'; readonly principal: TrustedPrincipal }
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'unavailable' };

/** The closed port. Each call is handed its deadline's AbortSignal and may return a Promise. */
export interface PrincipalResolutionPort {
  resolve(principal: VerifiedPrincipal, signal: AbortSignal): unknown;
  probe(signal: AbortSignal): unknown;
}

/** The selector a request may carry. Both absent is the only shape a platform-scope route accepts. */
export interface ScopeSelector {
  readonly tenant: string | null;
  readonly store: string | null;
}

/**
 * A selected scope: the actor, the version to revalidate against, the scope tuple and the role the
 * database says is granted there. This is what a command transaction carries — never a principal,
 * a provider reference or a request.
 */
export interface TrustedScope {
  readonly actor: string;
  readonly securityVersion: string;
  readonly scope: AuthorizationScope;
  readonly tenant: string | null;
  readonly store: string | null;
  readonly roleId: string;
  readonly limitation: AccountLimitation;
}

export type ScopeSelection =
  | { readonly outcome: 'selected'; readonly scope: TrustedScope }
  | { readonly outcome: 'refused' };

const REFUSED: ScopeSelection = Object.freeze({ outcome: 'refused' });

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * True when `value` is a TrustedPrincipal in every field — the guard the adapter applies to what the
 * database hands back, so a malformed row becomes an outage rather than an authority.
 */
export function isTrustedPrincipal(value: unknown): value is TrustedPrincipal {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (!isUuid(p.actor) || typeof p.securityVersion !== 'string' || !VERSION_RE.test(p.securityVersion)) return false;
  if (typeof p.accountStatus !== 'string' || !STATUS_RE.test(p.accountStatus)) return false;
  if (p.limitation !== 'none' && p.limitation !== 'read_only') return false;
  if (!Array.isArray(p.memberships) || p.memberships.length > MAX_MEMBERSHIPS) return false;
  const seen = new Set<string>();
  // inv: every membership below i is well formed and its id is distinct; term: i rises to the array's length.
  for (let i = 0; i < p.memberships.length; i++) {
    const m: unknown = p.memberships[i];
    if (typeof m !== 'object' || m === null) return false;
    const g = m as Record<string, unknown>;
    if (!isUuid(g.membershipId) || seen.has(g.membershipId as string)) return false;
    seen.add(g.membershipId as string);
    if (typeof g.roleId !== 'string' || !ROLE_RE.test(g.roleId)) return false;
    if (g.tenantStatus !== null && (typeof g.tenantStatus !== 'string' || !STATUS_RE.test(g.tenantStatus))) return false;
    if (g.storeStatus !== null && (typeof g.storeStatus !== 'string' || !STATUS_RE.test(g.storeStatus))) return false;
    // The scope tuple must be exactly what migration 002's scope-consistency CHECK allows.
    if (g.scopeType === 'platform') { if (g.tenant !== null || g.store !== null || g.tenantStatus !== null || g.storeStatus !== null) return false; }
    else if (g.scopeType === 'tenant') { if (!isUuid(g.tenant) || g.store !== null || g.storeStatus !== null) return false; }
    else if (g.scopeType === 'store') { if (!isUuid(g.tenant) || !isUuid(g.store)) return false; }
    else return false;
  }
  return true;
}

/**
 * Pick the one grant this request may act under, or refuse.
 *
 * `required` is the ROUTE's declared authorization scope, not something derived from the request.
 * `selector` is what the request asked for, and only ever narrows: a selector that names a tenant or
 * store the actor does not hold an active grant on is refused, and so is a selector that is absent
 * where the scope needs one, present where it must not be, or ambiguous — two grants at the same
 * scope tuple are two different answers, and this module does not choose between them.
 *
 * The limitation is the WIDEST of the account's and the selected scope's: an active user in a
 * read-only tenant is read-only there, and a read-only user is read-only everywhere.
 */
export function selectScope(
  principal: TrustedPrincipal,
  required: AuthorizationScope,
  selector: ScopeSelector,
): ScopeSelection {
  if (!isTrustedPrincipal(principal)) return REFUSED;
  const tenant = selector.tenant;
  const store = selector.store;
  if (tenant !== null && !isUuid(tenant)) return REFUSED;
  if (store !== null && !isUuid(store)) return REFUSED;

  // The selector's shape must be exactly the one the scope takes. A missing selector never falls back
  // to platform, and a platform route never accepts one.
  if (required === 'platform' && (tenant !== null || store !== null)) return REFUSED;
  if (required === 'tenant' && (tenant === null || store !== null)) return REFUSED;
  if (required === 'store' && (tenant === null || store === null)) return REFUSED;

  const matches = principal.memberships.filter((m) =>
    m.scopeType === required && m.tenant === tenant && m.store === store);
  if (matches.length !== 1) return REFUSED; // none is unauthorized; more than one is ambiguous
  const grant = matches[0];

  const limited = principal.limitation === 'read_only'
    || (grant.tenantStatus !== null && READ_ONLY_STATUSES.has(grant.tenantStatus))
    || (grant.storeStatus !== null && READ_ONLY_STATUSES.has(grant.storeStatus));

  return Object.freeze({
    outcome: 'selected',
    scope: Object.freeze({
      actor: principal.actor,
      securityVersion: principal.securityVersion,
      scope: required,
      tenant,
      store,
      roleId: grant.roleId,
      limitation: limited ? 'read_only' : 'none',
    }),
  });
}

/** True when `value` is a TrustedScope in every field — the guard the store applies before it locks. */
export function isTrustedScope(value: unknown): value is TrustedScope {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  if (!isUuid(s.actor) || typeof s.securityVersion !== 'string' || !VERSION_RE.test(s.securityVersion)) return false;
  if (typeof s.roleId !== 'string' || !ROLE_RE.test(s.roleId)) return false;
  if (s.limitation !== 'none' && s.limitation !== 'read_only') return false;
  if (s.scope === 'platform') return s.tenant === null && s.store === null;
  if (s.scope === 'tenant') return isUuid(s.tenant) && s.store === null;
  if (s.scope === 'store') return isUuid(s.tenant) && isUuid(s.store);
  return false;
}
