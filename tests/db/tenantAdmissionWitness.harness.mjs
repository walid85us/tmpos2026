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
// M7B-INVOICES-P1 — THE STORE WITNESS MOVED ONTO A STORE TEMPLATE. Store scope became real: a store-scope requirement
// registers only on one of the three closed store templates, whose path names the store (routes.ts), and the tenant
// authorizer denies a store requirement whose view names no store instead of picking the actor's one store grant
// (tenantAuthorization.ts). So the literal-path store witness this harness once served is exactly what both now refuse:
// STORE_WITNESS_ROUTE is kept, never served, so the suites can assert that registering it is refused (route_path_invalid).
// The store-scope witness is served instead on the closed store template GET /api/v1/stores/{storeId}/invoice-drafts,
// through the route table's ordinary store-template rule — no test-only key, no bypass. Its permission is still
// WITNESS_PERMISSION: a key the catalog defines at store scope but does not decide, so the real authorizer grants it on
// the actor's one store grant AT the path's store and the lifecycle decision alone, with no role-level read. A request to
// /api/v1/stores/<store>/invoice-drafts therefore exercises, over real sockets, the real store-grant selection on the
// store the path names (tenant, store and role answered from the trusted scope), its denial for a tenant grant (no
// inheritance) and for a store the actor holds no grant at, and admission's refusals before any of it.
//
// WHY THIS PATH MAY APPEAR HERE. The template is a PRODUCTION path (routes.ts declares it in its closed set) that no
// shipped route serves yet: the tenant inventory carries no store-scope route (production-runtime-contract pins it exactly), so
// the harness may serve it beside that inventory without colliding. The template string is therefore not one of the
// containment scan's harness-only markers (it legitimately exists in routes.ts); WITNESS_PATH, STORE_WITNESS_PATH and this
// module's name remain those markers. The change that ships the real draft list on this template must drop the harness
// route and carry these lifecycle assertions on the real route.

/** The tenant-scope witness. Classified as a read, so a read-only tenant may still reach it. */
export const WITNESS_PATH = '/api/v1/harness/tenant-admission-witness';
/** The store-scope witness's former literal path. Never served since M7B-INVOICES-P1 (above); still kept out of production. */
export const STORE_WITNESS_PATH = '/api/v1/harness/store-admission-witness';
/** The store-scope witness's route path since M7B-INVOICES-P1: the closed store template the draft list will take. */
export const STORE_TEMPLATE_WITNESS_PATH = '/api/v1/stores/{storeId}/invoice-drafts';
/** The request path of the store-scope witness at `store`: the template with its {storeId} selector filled in. */
export const storeWitnessPath = (store) => STORE_TEMPLATE_WITNESS_PATH.replace('{storeId}', store);

/**
 * An existing canonical tenant permission (m5CanonicalPermissions.ts). The authorizer requires the
 * key to NAME something the catalog defines; whether a role holds it is not decided anywhere yet
 * (GAP-11), so this names a real key and claims nothing about who may use it.
 */
export const WITNESS_PERMISSION = 'view_shipping_costs';

/**
 * The routes the composition classifies as reads — the only ones a read-only actor may reach. The store witness is
 * deliberately NOT one, as before M7B-INVOICES-P1.
 */
export const WITNESS_READS = new Set([`GET ${WITNESS_PATH}`]);

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

/** The two witness routes a suite serves: one at tenant scope, one at store scope on the store template (M7B-INVOICES-P1). */
export const WITNESS_ROUTES = Object.freeze([route(WITNESS_PATH, 'tenant'), route(STORE_TEMPLATE_WITNESS_PATH, 'store')]);

/**
 * The store-scope witness on its literal path: a definition the route table REFUSES (route_path_invalid) since
 * M7B-INVOICES-P1, because a store-scope requirement registers only on a store template. Exported so the suites assert
 * that refusal; never served (the served store witness is WITNESS_ROUTES[1]).
 */
export const STORE_WITNESS_ROUTE = route(STORE_WITNESS_PATH, 'store');
