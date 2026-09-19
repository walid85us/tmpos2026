// Phase 4.0 M5 — the canonical platform route authorizer (owner decision D1, M5-GIAM-D1-P1; G-IAM,
// G-CPLOGIN; docs/phase-4/04 §2-§5, docs/phase-4/10 ADR-20).
//
// The server-side decision behind a platform-scope route: the runtime's RouteAuthorizer port
// (server/runtime/access.ts), bound in trusted source. For each request it
//   1. resolves the session's verified principal to its app-owned actor through the trusted principal
//      resolver (migration 007 via postgresPrincipalResolver.ts) — never a UID, role, permission, tenant
//      or actor the request names;
//   2. selects the actor's one active PLATFORM grant (principals.ts selectScope with no selector): none,
//      or more than one, is a denial;
//   3. decides the route's declared permission for that grant's role on the canonical catalog
//      (m5CanonicalPermissions.ts evaluateCanonicalPermission), which reads the role through its
//      definition — so no role name is a shortcut, System Owner is granted by the same rule as every
//      role, and a custom platform role with sufficient authority is granted like a built-in one — and
//      applies the read-only cap, so a read-only actor holds no write permission;
// and answers `{ granted: true, context }`, handing the chain the trusted scope it decided on, which the
// command transaction revalidates after the idempotency fence and audits. Every denial is one value,
// `false` — the chain's generic 403 — whatever failed: an unresolved actor, a missing or ambiguous grant,
// a role the catalog does not define, a permission it does not grant. A resolver that cannot answer is
// an outage, a throw the chain turns into a bounded 503, never a verdict.
//
// PLATFORM SCOPE ONLY. A tenant- or store-scope requirement is refused here: the catalog answers it
// 'undecidable' (GAP-11), and the composition refuses such a route at startup anyway
// (productionTransactions.ts uncataloguedRoutePermissions). The target of a command — the tenant whose
// name it changes — is a resource, never a scope, and never reaches this decision.
//
// NOTHING IS LOGGED OR KEPT. No principal, actor, role or decision leaves this file except as the answer.
import type { RouteAuthorizer, RouteView } from '../runtime/access.js';
import { isTrustedPrincipal, selectScope } from '../runtime/principals.js';
import type { PrincipalResolutionPort } from '../runtime/principals.js';
import type { AuthorizationRequirement, VerifiedPrincipal } from '../runtime/routes.js';
import { BUILT_IN_PLATFORM_ROLES, evaluateCanonicalPermission } from '../platform-identity/m5CanonicalPermissions.js';
import type { PlatformRoleDefinition } from '../platform-identity/m5CanonicalPermissions.js';

export interface PlatformAuthorizerDeps {
  /** The trusted principal resolver: in production the one the transaction root builds over its own client. */
  readonly principals: PrincipalResolutionPort;
  /**
   * The role definitions the decision reads. A deployment has the built-in ones only — the server holds no
   * custom platform role (migration 003 admits the five built-in ids; no durable role store exists) — and
   * a harness may supply others to prove the rule is the definition's, not the name's.
   */
  readonly roles?: ReadonlyMap<string, PlatformRoleDefinition>;
}

/** The one outage message: a resolver that could not answer, and nothing about why. */
const UNAVAILABLE = 'platform authorization unavailable';

export function createPlatformRouteAuthorizer(deps: PlatformAuthorizerDeps): RouteAuthorizer {
  const principals = deps?.principals;
  const roles = deps?.roles ?? BUILT_IN_PLATFORM_ROLES;
  if (typeof principals !== 'object' || principals === null || typeof principals.resolve !== 'function' || !(roles instanceof Map)) {
    throw new TypeError('platform authorizer dependencies invalid');
  }
  return Object.freeze({
    async authorize(principal: VerifiedPrincipal, requirement: AuthorizationRequirement, _route: RouteView, signal: AbortSignal): Promise<unknown> {
      if (requirement.scope !== 'platform') return false;
      const resolution: unknown = await principals.resolve(principal, signal);
      if (typeof resolution !== 'object' || resolution === null) throw new Error(UNAVAILABLE);
      // Read once each: a resolver cannot answer one way here and another way below.
      const { outcome, principal: resolved } = resolution as Record<string, unknown>;
      if (outcome === 'refused') return false;
      if (outcome !== 'resolved' || !isTrustedPrincipal(resolved)) throw new Error(UNAVAILABLE);
      const selection = selectScope(resolved, 'platform', { tenant: null, store: null });
      if (selection.outcome !== 'selected') return false;
      const { scope } = selection;
      const decision = evaluateCanonicalPermission({
        scope: 'platform', roleId: scope.roleId, permission: requirement.permission, limitation: scope.limitation, roles,
      });
      return decision === 'granted' ? Object.freeze({ granted: true, context: scope }) : false;
    },
  });
}
