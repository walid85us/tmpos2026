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

/** The tenant-scope witness. Classified as a read, so a read-only tenant may still reach it. */
export const WITNESS_PATH = '/api/v1/harness/tenant-admission-witness';
/** The store-scope witness. Deliberately NOT classified as a read (see WITNESS_READS). */
export const STORE_WITNESS_PATH = '/api/v1/harness/store-admission-witness';

/**
 * An existing canonical tenant permission (m5CanonicalPermissions.ts). The authorizer requires the
 * key to NAME something the catalog defines; whether a role holds it is not decided anywhere yet
 * (GAP-11), so this names a real key and claims nothing about who may use it.
 */
export const WITNESS_PERMISSION = 'view_shipping_costs';

/** The routes the composition classifies as reads — the only ones a read-only actor may reach. */
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

/** The two witness routes: one at tenant scope, one at store scope. */
export const WITNESS_ROUTES = Object.freeze([route(WITNESS_PATH, 'tenant'), route(STORE_WITNESS_PATH, 'store')]);
