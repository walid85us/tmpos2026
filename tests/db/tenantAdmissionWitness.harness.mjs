// Phase 4.0 M5-GIAM-D1-P2-R1 — the TENANT ADMISSION WITNESS: a protected tenant route that exists
// ONLY in this integration harness (owner decision, M5-GIAM-D1-P2-R1 §E, Option 1).
//
// WHY IT IS HERE AND NOT IN THE PRODUCT. Proving that suspension is enforced needs a protected
// TENANT request to enforce it on, and this repository has no tenant business route yet: every
// tenant- and store-scope permission is undecidable until owner decision D1 (GAP-11), and the
// production inventory refuses to start while any route in it declares one
// (productionTransactions.ts uncataloguedRoutePermissions). Shipping a route to make a test possible
// would be inventing product semantics no document has decided. So the route is declared HERE, handed
// to a real runtime instance the test builds, and never exported to production:
//   * it is not in PRODUCTION_INVENTORY and no production module imports this file;
//   * its permission is an EXISTING canonical tenant key — evidence plumbing, not a product claim
//     that this key governs this route, and no shipping route acquires it;
//   * tests/quality/production-runtime-contract.test.mjs asserts that neither this path nor this
//     module reaches the production source inventory or the compiled artifact.
//
// WHAT IT THEREFORE PROVES, AND WHAT IT DOES NOT. It exercises the REAL composed path — the real
// session boundary, the real PostgreSQL session store, the real PostgreSQL admission over migration
// 011, the real tenant authorizer and the one lifecycle decision — so suspension, reactivation and
// the store's inheritance of its tenant's state are proved against a real database over real
// sockets. It does NOT prove that any SHIPPED tenant functionality exists: none does yet.
//
// M7B-INVOICES-P1 — THE STORE WITNESS IS THE REAL DRAFT LIST NOW. Store scope became real: a store-scope requirement
// registers only on one of the closed store templates (three; four since M7B-INVOICES-P1-R2), whose path names the store (routes.ts), and the tenant
// authorizer denies a store requirement whose view names no store instead of picking the actor's one store grant
// (tenantAuthorization.ts). So the literal-path store witness this harness once served is exactly what both now refuse:
// STORE_WITNESS_ROUTE is kept, never served, so the suites can assert that registering it is refused (route_path_invalid).
// For one commit (aedbee2) the store witness was served on the store template GET /api/v1/stores/{storeId}/invoice-drafts,
// which nothing shipped yet. The drafts commit ships that template as the REAL draft list (server/runtime/invoiceDrafts.ts,
// in the tenant inventory, view_invoice_drafts at store scope, session-bound), so the harness no longer serves it:
//   * a harness handler there would give a production path a second meaning — a context echo under a permission no shipped
//     route declares (WITNESS_PERMISSION) where production serves the store's drafts under view_invoice_drafts;
//   * any route table that also composes the tenant inventory would refuse the duplicate method and path at registration,
//     and the tenant inventory is pinned exactly (tests/quality/production-runtime-contract.test.mjs), so the template can
//     belong to the production route alone.
// The lifecycle witnesses therefore request the REAL list at the actor's own store, through the suite's real tenant
// authorizer and over the real 028 read (a 200 is then the store's draft list — empty, since these suites save no draft),
// and the EXACT trusted scope [tenant, store, roleId] each 200 was served under is read from recordingAuthorizer below: a
// pass-through that records what the real authorizer decided and returns that very decision — it adds, removes and alters
// nothing (no test-only key, no bypass). A tenant grant at a store route, and a store grant at another store of its own
// tenant or of another tenant, are the authorizer's 403 on that same real route. The real route is session-bound, so a
// witness request carries the session CSRF header (as the shop does); a 401 is decided before that header is read.
//
// WHY THE TENANT WITNESS STAYS. No shipped tenant route grants on membership and lifecycle alone with no role-level read,
// and the suites' tenant-scope lifecycle episodes are about exactly that decision; WITNESS_PATH, STORE_WITNESS_PATH and this
// module's name remain the containment scan's harness-only markers, and the scan proves none reaches production.

import { INVOICE_DRAFTS_PATH } from '../../server/runtime/invoiceDrafts.ts';

/** The tenant-scope witness. Classified as a read, so a read-only tenant may still reach it. */
export const WITNESS_PATH = '/api/v1/harness/tenant-admission-witness';
/** The store-scope witness's former literal path. Never served since M7B-INVOICES-P1 (above); still kept out of production. */
export const STORE_WITNESS_PATH = '/api/v1/harness/store-admission-witness';
/** The REAL draft list's request path at `store`: the store lifecycle witness since the drafts commit (above). */
export const storeDraftsPath = (store) => INVOICE_DRAFTS_PATH.replace('{storeId}', store);

/**
 * An existing canonical tenant permission (m5CanonicalPermissions.ts). The authorizer requires the
 * key to NAME something the catalog defines; whether a role holds it is not decided anywhere yet
 * (GAP-11), so this names a real key and claims nothing about who may use it.
 */
export const WITNESS_PERMISSION = 'view_shipping_costs';

/**
 * The routes the composition classifies as reads — the only ones a read-only actor may reach: the tenant witness, and the
 * real draft list exactly as production classifies it (tenantTransactions.ts: its reads slot).
 */
export const WITNESS_READS = new Set([`GET ${WITNESS_PATH}`, `GET ${INVOICE_DRAFTS_PATH}`]);

/** What the handler answers with: the trusted scope the authorizer decided, and nothing it was sent. */
const answer = (res, ctx) => {
  res.status(200).json({
    actor: ctx.trusted.actor,
    tenant: ctx.trusted.tenant,
    store: ctx.trusted.store,
    roleId: ctx.trusted.roleId,
    limitation: ctx.trusted.limitation,
    securityVersion: ctx.trusted.securityVersion,
  });
};

const route = (path, scope) => Object.freeze({
  method: 'GET',
  path,
  policy: Object.freeze({
    access: 'session',
    audience: 'tenant',
    authorization: Object.freeze({ scope, permission: WITNESS_PERMISSION }),
  }),
  body: Object.freeze({ kind: 'none' }),
  idempotency: 'none',
  // The handler reads ctx.trusted, so the chain must refuse the request before it whenever no actor
  // was resolved — which is what makes a 403 here evidence and not an empty answer.
  trustedContext: 'required',
  recentAuth: 'none',
  handler: (_req, res, ctx) => { answer(res, ctx); },
});

/** The one witness route a suite serves: the tenant scope's (the store scope's is the real draft list, above). */
export const WITNESS_ROUTES = Object.freeze([route(WITNESS_PATH, 'tenant')]);

/**
 * The store-scope witness on its literal path: a definition the route table REFUSES (route_path_invalid) since
 * M7B-INVOICES-P1, because a store-scope requirement registers only on a store template. Exported so the suites assert
 * that refusal; never served.
 */
export const STORE_WITNESS_ROUTE = route(STORE_WITNESS_PATH, 'store');

/**
 * A pass-through around a REAL tenant route authorizer that records every decision it answers — the principal's provider
 * uid, the view's path and store target, and the trusted scope it granted (null when it denied) — and returns that very
 * decision, unchanged. Evidence plumbing only: the suites read from it the exact [tenant, store, roleId] a 200 on the real
 * draft list was served under, which that route's body (the store's drafts) does not echo.
 */
export function recordingAuthorizer(inner) {
  if (typeof inner?.authorize !== 'function') throw new TypeError('recordingAuthorizer: an authorizer is required');
  const decisions = [];
  return Object.freeze({
    decisions,
    authorizer: Object.freeze({
      async authorize(principal, requirement, view, signal, admitted) {
        const decision = await inner.authorize(principal, requirement, view, signal, admitted);
        const context = typeof decision === 'object' && decision !== null && decision.granted === true ? decision.context : null;
        decisions.push(Object.freeze({ uid: principal?.authProviderUid ?? null, path: view?.path ?? null, storeTarget: view?.storeTarget ?? null, context }));
        return decision;
      },
    }),
    /** [tenant, store, roleId] of the last decision for `uid` at `store` (a store target), or null when none was granted. */
    lastScopeAt(uid, store) {
      const last = decisions.filter((d) => d.uid === uid && d.storeTarget === store).at(-1);
      return last === undefined || last.context === null ? null : [last.context.tenant, last.context.store, last.context.roleId];
    },
  });
}
