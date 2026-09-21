// Phase 4.0 M5 — the administrative session boundary's two decisions: durable admission and the canonical
// platform route authorizer (owner decision D1, M5-GIAM-D1-P1, -P4; G-IAM, G-CPLOGIN; docs/phase-4/04 §2-§5,
// docs/phase-4/10 ADR-20).
//
// ADMISSION (sessions.ts SessionAdmission; M5-GIAM-D1-P4) answers the question the administrative boundary asks
// at login and again on EVERY protected request: may this verified reference hold an administrative session, on
// which grant, and at what witness? It reads migration 013's admission (postgresPlatformAdmission.ts) — one
// snapshot of the actor, its platform grants and its platform authority version — and admits only when:
//   1. the database resolves the reference to an actor (007) — else a denial;
//   2. the account is eligible: its status one that neither denies nor limits ('active', 'trialing'), so a
//      suspended, pending, read-only or overdue account holds no administrative session at all;
//   3. the actor holds EXACTLY ONE active platform grant (principals.ts selectScope): none is unauthorized and
//      two are ambiguous — there is no first match, and a tenant or store grant is never considered, whatever
//      role id it carries;
//   4. that grant's role is a platform role the canonical catalog defines — a role that is not is no authority.
// It answers the witness the session is bound to — a digest over the actor, the account status and its cap,
// 007's security version (account status and identity links), the grant, its role and the platform authority
// version (every change to the actor's platform grants, migration 013) — and the scope it selected, which the
// boundary hands to the same request's authorizer. The witness moves on every change to any of those and, since
// the authority version only increases, never returns to a value it held: a grant withdrawn and restored, or a
// role changed and changed back, does not revive a session admitted before. A denial ends every administrative
// session the principal holds; an outage is a throw, which the boundary turns into a bounded 503 and never into
// a verdict. Nothing it reads comes from the request: the cookie names a session, the database says the rest.
//
// ROUTE AUTHORIZATION (access.ts RouteAuthorizer) decides one request on the scope THAT request's admission
// selected — never a second, independent read that could disagree with it (M5-GIAM-D1-P4). It decides the
// route's declared permission for that grant's role on the canonical catalog (m5CanonicalPermissions.ts
// evaluateCanonicalPermission), which reads the role through its CURRENT definition — so no role name is a
// shortcut, System Owner is granted by the same rule as every role — and applies the read-only cap, so a
// read-only actor holds no write permission. It answers `{ granted: true, context }`, handing the chain the
// trusted scope it decided on, which the command transaction revalidates after the idempotency fence and audits.
// Every denial is one value, `false` — the chain's generic 403 — whatever failed. A request that reaches it
// without an admitted scope is a wiring fault, a throw the chain turns into a bounded 503, never a verdict.
//
// PLATFORM SCOPE ONLY. A tenant- or store-scope requirement is refused here: the catalog answers it
// 'undecidable' (GAP-11), and the composition refuses such a route at startup anyway
// (productionTransactions.ts uncataloguedRoutePermissions). The target of a command — the tenant whose
// name it changes — is a resource, never a scope, and never reaches this decision.
//
// THE SAME DECISION, AGAIN, INSIDE THE TRANSACTION (M5-GIAM-D1-P1-R1). createPlatformContextRevalidator
// is the store's revalidator for the scope this authorizer hands a command: after the idempotency fence the
// database confirms that EXACTLY that authority still holds — the account neither denied nor read-only,
// the security version, one active platform grant and it the very membership and role selected (migration
// 009, postgresPrincipalResolver.ts revalidatePlatformAuthority) — and the route's permission is then
// decided again, by the same canonical rule over the same role definitions, on that role. Both halves fail
// closed identically: whatever would deny here denies there, and nothing commits.
//
// NOTHING IS LOGGED OR KEPT. No principal, actor, role or decision leaves this file except as the answer.
import { createHash } from 'node:crypto';
import type { RouteAuthorizer, RouteView } from '../runtime/access.js';
import { isTrustedPrincipal, isTrustedScope, selectScope, trustedScopeOf } from '../runtime/principals.js';
import type { PlatformAdmissionPort, TrustedScope } from '../runtime/principals.js';
import type { AuthorizationRequirement, SessionAudience, VerifiedPrincipal } from '../runtime/routes.js';
import type { SessionAdmission } from '../runtime/sessions.js';
import type { PlatformPermits } from '../runtime/tenantDirectory.js';
import { BUILT_IN_PLATFORM_ROLES, evaluateCanonicalPermission } from '../platform-identity/m5CanonicalPermissions.js';
import type { PlatformRoleDefinition } from '../platform-identity/m5CanonicalPermissions.js';

/** The role definitions the decisions read, when a caller supplies none: the built-in ones. */
interface RoleDeps {
  /**
   * A deployment has the built-in definitions only — the server holds no custom platform role (migration 003
   * admits the five built-in ids; no durable role store exists) — and a harness may supply others to prove the
   * rule is the definition's, not the name's.
   */
  readonly roles?: ReadonlyMap<string, PlatformRoleDefinition>;
}

export interface PlatformAdmissionDeps extends RoleDeps {
  /** The durable admission port: in production the PostgreSQL one over the transaction root's own client. */
  readonly admission: PlatformAdmissionPort;
}

/** The one outage message of each decision: nothing about why. */
const ADMISSION_UNAVAILABLE = 'platform admission unavailable';
const UNAVAILABLE = 'platform authorization unavailable';

/**
 * The account statuses that admit an administrative session: those that neither deny ('suspended',
 * 'pending_activation') nor limit to reads ('read_only', 'overdue') under 007's policy. Named, not derived by
 * exclusion, so a status a later migration adds admits nothing until it is classified here.
 */
const ELIGIBLE_ACCOUNT: ReadonlySet<string> = new Set(['active', 'trialing']);
/** The platform authority version as the port renders it (postgresPlatformAdmission.ts). */
const AUTHORITY_VERSION_RE = /^[0-9]{1,19}$/;
/** The witness's prefix: it names the derivation, so a later one is never mistaken for this one. */
const WITNESS_PREFIX = 'p1';

/**
 * The session witness over one admitted standing. Every field is printable and newline-free by its own
 * constraint — a UUID, one of 002's status words, 'none', 007's security version (printable ASCII, no space), a
 * role id migration 003 pins, a decimal version — so joining with newlines is injective: no two different
 * standings produce one string. `p1:` plus 43 base64url characters: inside the boundary's 1-128 bound.
 */
function witnessOf(scope: TrustedScope, accountStatus: string, authorityVersion: string): string {
  const lines = [WITNESS_PREFIX, scope.actor, accountStatus, scope.limitation, scope.securityVersion, scope.membershipId, scope.roleId, authorityVersion];
  return `${WITNESS_PREFIX}:${createHash('sha256').update(lines.join('\n')).digest('base64url')}`;
}

/**
 * The administrative boundary's SessionAdmission. `{ admitted: true, securityVersion, context }` admits — the
 * witness and the one platform scope selected; `false` denies; a throw is an outage the boundary fails closed on
 * without revoking anything.
 */
export function createPlatformSessionAdmission(deps: PlatformAdmissionDeps): SessionAdmission {
  const admission = deps?.admission;
  const roles = deps?.roles ?? BUILT_IN_PLATFORM_ROLES;
  if (typeof admission !== 'object' || admission === null || typeof admission.admit !== 'function'
    || typeof admission.probe !== 'function' || !(roles instanceof Map)) {
    throw new TypeError('platform admission dependencies invalid');
  }
  return Object.freeze({
    async admit(principal: VerifiedPrincipal, audience: SessionAudience, signal: AbortSignal): Promise<unknown> {
      // This adapter answers for the ADMINISTRATIVE boundary alone. Being asked about another is a wiring fault:
      // it THROWS rather than denying, because the boundary treats a denial as "this principal may hold no session
      // here" and revokes every session it holds — composed on the tenant boundary by mistake, a denial would
      // silently sign every tenant user out, where an outage is a bounded 503 that is loud enough to find.
      if (audience !== 'admin') throw new Error(ADMISSION_UNAVAILABLE);
      const answer: unknown = await admission.admit(principal, signal);
      if (typeof answer !== 'object' || answer === null) throw new Error(ADMISSION_UNAVAILABLE);
      // Read once each: the port cannot answer one way here and another way below.
      const { outcome, principal: resolved, authorityVersion } = answer as Record<string, unknown>;
      if (outcome === 'refused') return false;
      if (outcome !== 'resolved') throw new Error(ADMISSION_UNAVAILABLE);
      // A malformed standing is the adapter's fault, not a fact about the principal: an outage, never a denial,
      // because a denial would end every session the principal holds.
      if (!isTrustedPrincipal(resolved) || typeof authorityVersion !== 'string' || !AUTHORITY_VERSION_RE.test(authorityVersion)
        || !resolved.memberships.every((m) => m.scopeType === 'platform')) {
        throw new Error(ADMISSION_UNAVAILABLE);
      }
      if (!ELIGIBLE_ACCOUNT.has(resolved.accountStatus) || resolved.limitation !== 'none') return false;
      // Exactly one active platform grant, whatever the order: none is unauthorized, two are ambiguous.
      const selection = selectScope(resolved, 'platform', { tenant: null, store: null });
      if (selection.outcome !== 'selected') return false;
      const { scope } = selection;
      // A role the canonical catalog does not define holds no platform authority at all.
      if (!roles.has(scope.roleId)) return false;
      return Object.freeze({ admitted: true, securityVersion: witnessOf(scope, resolved.accountStatus, authorityVersion), context: scope });
    },
    probe(signal: AbortSignal): unknown {
      return admission.probe(signal);
    },
  });
}

/**
 * The canonical platform route authorizer: it decides on the scope the request's own admission selected, with
 * the role's current definition (see the header). `admitted` absent is a wiring fault and fails closed as an
 * outage.
 */
export function createAdmittedPlatformAuthorizer(deps: RoleDeps = {}): RouteAuthorizer {
  const roles = deps?.roles ?? BUILT_IN_PLATFORM_ROLES;
  if (!(roles instanceof Map)) throw new TypeError('platform authorizer dependencies invalid');
  return Object.freeze({
    async authorize(
      _principal: VerifiedPrincipal, requirement: AuthorizationRequirement, _route: RouteView, _signal: AbortSignal, admitted: TrustedScope | null,
    ): Promise<unknown> {
      if (requirement.scope !== 'platform') return false;
      // Checked again here, and copied: the scope is the runtime's frozen copy of what admission selected, but this
      // decision must not rest on a caller having done that.
      const scope = trustedScopeOf(admitted);
      if (scope === null || scope.scope !== 'platform') throw new Error(UNAVAILABLE);
      const decision = evaluateCanonicalPermission({
        scope: 'platform', roleId: scope.roleId, permission: requirement.permission, limitation: scope.limitation, roles,
      });
      return decision === 'granted' ? Object.freeze({ granted: true, context: scope }) : false;
    },
  });
}

/**
 * Whether a scope this authorizer already selected holds `permission`, by the SAME canonical rule over the same role
 * definitions (M5-GIAM-D1-P3). It exists for one purpose: the tenant directory's `actions`, which tell the console which
 * controls to show (server/runtime/tenantDirectory.ts). That answer is presentation and grants nothing — every command is
 * authorized again, from the beginning, by the chain that serves it. Only a platform scope can hold a platform
 * permission; the read-only cap applies exactly as it does in the authorizer; anything else is false.
 */
export function createPlatformPermits(deps: { readonly roles?: ReadonlyMap<string, PlatformRoleDefinition> } = {}): PlatformPermits {
  const roles = deps?.roles ?? BUILT_IN_PLATFORM_ROLES;
  if (!(roles instanceof Map)) throw new TypeError('platform permits dependencies invalid');
  return (scope: TrustedScope, permission: string): boolean =>
    isTrustedScope(scope) && scope.scope === 'platform'
      && evaluateCanonicalPermission({ scope: 'platform', roleId: scope.roleId, permission, limitation: scope.limitation, roles }) === 'granted';
}

/**
 * The database half of the transaction-time check: exactly the authority `scope` was selected under still holds, read on
 * the committing transaction's own statement handle — which this file never touches, so it names it only as a type
 * parameter (the transaction root alone imports the persistence layer).
 */
export type PlatformAuthorityCheck<Handle> = (sql: Handle, scope: TrustedScope, authNotAfter: number | null) => Promise<boolean>;

export interface PlatformRevalidatorDeps<Handle> {
  /** In production postgresPrincipalResolver.ts revalidatePlatformAuthority (migration 009). */
  readonly authority: PlatformAuthorityCheck<Handle>;
  /** The same role definitions the authorizer decides over: a deployment has the built-in ones only. */
  readonly roles?: ReadonlyMap<string, PlatformRoleDefinition>;
}

/**
 * The store's ContextRevalidator (postgresTransactionalStore.ts) for a platform command: exactly true only when the scope is the one the
 * authorizer could have handed out (platform, not read-only), the database confirms that exact authority
 * still holds on the committing transaction, and the route's `permission` is still granted to that role by
 * its current definition. Anything else — a throw included, which the store's kernel turns into a rollback
 * — commits nothing.
 */
export function createPlatformContextRevalidator<Handle>(deps: PlatformRevalidatorDeps<Handle>): (sql: Handle, scope: TrustedScope, permission: string, authNotAfter: number | null) => Promise<boolean> {
  const authority = deps?.authority;
  const roles = deps?.roles ?? BUILT_IN_PLATFORM_ROLES;
  if (typeof authority !== 'function' || !(roles instanceof Map)) throw new TypeError('platform revalidator dependencies invalid');
  return async (sql: Handle, scope: TrustedScope, permission: string, authNotAfter: number | null): Promise<boolean> => {
    if (scope.scope !== 'platform' || scope.limitation !== 'none') return false;
    // The authority AND, when the route required one, the recent-authentication deadline — both decided on
    // the committing transaction by the database (M5-GIAM-D1-P2): stale evidence denies exactly as a
    // withdrawn grant does, with the same one value.
    if ((await authority(sql, scope, authNotAfter)) !== true) return false;
    // The database confirmed the very grant and its role; the permission is decided on that role again.
    return evaluateCanonicalPermission({ scope: 'platform', roleId: scope.roleId, permission, limitation: 'none', roles }) === 'granted';
  };
}
