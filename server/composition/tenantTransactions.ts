// M7A-CUSTOMERS-P2 — the tenant transaction root: the tenant entry's one route inventory, composed over the shared
// transaction kernel (transactionKernel.ts composeReadTransactions), never over the administrative root.
//
// What it serves beyond the boundary's own session routes: GET /api/v1/customers (customerDirectory.ts), bound to the
// production customer directory over migration 018's session-bound read (postgresCustomerDirectory.ts) on the kernel's one
// client, explicitly a read, so a read-only tenant actor reaches it (tenantAuthorization.ts step 6). Nothing else can be
// served: the inventory below is the whole list, the entry refuses any served table but its own, and nothing — a store,
// an adapter, a factory or another inventory — can be handed to this root. The kernel's constructor is its one input
// beside the configuration, with no default: the tenant entry's construction boundary (server/entry/tenantEntry.ts)
// always hands one.
//
// M7A-CUSTOMERS-P3 UPDATE. Its write slot holds the first tenant command, POST /api/v1/customers (customerCreate.ts), and
// its one mutator over migration 019's session-bound routine (postgresCustomerCreate.ts): the kernel composes the tenant
// store for it, over IDEMPOTENCY_KEY, and re-proves each command's tenant authority inside its own transaction. It is
// never classified as a read, so no read-only actor reaches it; it enqueues nothing.
//
// M7A-CUSTOMERS-P3-R1 UPDATE. The write slot holds a second command, PUT /api/v1/roles/levels (roleLevelUpdate.ts): an
// owner's durable edit of a built-in role's Customers level, over its one mutator into migration 020 (postgresRoleLevels.ts).
// The inventory also hands the kernel the role-level reads every tenant route decision needs — the authorizer's over the
// kernel's client and the revalidator's on the committing transaction — so the customer routes are decided on each role's
// current definition, and the customer create and read now call 020's routines (postgresCustomerCreate.ts,
// postgresCustomerDirectory.ts), which re-decide on the same stored level.
//
// M7A-CUSTOMERS-P3-R2 UPDATE. A second read, GET /api/v1/roles/levels (roleLevelDirectory.ts): the owner's read-back of the
// built-in roles' Customers levels, over the role levels' one-snapshot read (postgresRoleLevels.ts) on the kernel's client.
// Its port is the one place the catalog meets it: the owner role first at its fixed level, and every role's default, from
// the tenant authorizer's own materializer (permissionCatalog.ts materializeTenantPermissions, called as
// m5CanonicalPermissions.ts calls it) — never a second table. It requires the owner rule, so no read-only actor reaches it
// although it is classified as a read. It adds no dependency to readiness: 020's read is the one every tenant route decision
// already makes.
//
// M7A-CUSTOMERS-P4 UPDATE. The edit is conditional (DA-125): its mutator calls migration 021's set, which writes only while the
// session's tenant and the role's version are the ones the owner's draft asserts, and the read-back hands each editable
// role's version (021's one-snapshot read) beside its level — the owner's record carries none. Nothing is added to the
// inventory: the same routes, mutators and reads, over 021's routines.
//
// M7A-CUSTOMERS-P4 UPDATE (detail). A third read, GET /api/v1/customers/{id} (customerDirectory.ts createCustomerDetailRoute):
// one customer by id over migration 022's session-bound routine (postgresCustomerDirectory.ts createPostgresCustomerDetail)
// on the kernel's client, explicitly a read like the list, so a read-only tenant actor reaches it. Its readiness joins the
// directory's: the one reads probe asks the directory's routine and then the detail routine, each for its refusal of an
// absent key, and is ready only when both refuse.
//
// M7A-CUSTOMERS-P6 UPDATE (contacts). A fourth read, GET /api/v1/customers/{id}/profile (customerDirectory.ts
// createCustomerProfileRoute): one customer's contact record over migration 023's session-bound routine
// (postgresCustomerDirectory.ts createPostgresCustomerProfile) on the kernel's client, explicitly a read like the detail, so a
// read-only tenant actor reaches it. The create's mutator calls 023's create (postgresCustomerCreate.ts): the same route,
// contract kind and mutator, the change set now carrying the contacts. Readiness: the reads probe asks the profile routine
// last, after the detail's, and is ready only when all three refuse an absent key.
//
// M7A-CUSTOMERS-P7 UPDATE (edit). A third command, PATCH /api/v1/customers/{id} (customerUpdate.ts): a versioned edit of one
// customer's name and contacts over its one mutator into migration 024's session-bound routine (postgresCustomerUpdate.ts),
// requiring edit_customers. It is never classified as a read, so no read-only actor reaches it; it enqueues nothing. The
// profile read now asks 024's versioned routine (the profile probe with it); nothing else is added to readiness.
//
// M7A-CUSTOMERS-P8 UPDATE (search). No route is added: GET /api/v1/customers takes an optional name search, and the same
// directory adapter (postgresCustomerDirectory.ts) asks migration 025's session-bound search routine for it on the kernel's
// client. Readiness: the reads probe asks the search routine last, after the profile's (probeCustomerSearch), and is
// ready only when all four refuse an absent key.
//
// M5-INVOICES-AUTH-P1 UPDATE (invoices levels). A fifth read, GET /api/v1/roles/levels/invoices (roleLevelDirectory.ts
// createInvoiceRoleLevelDirectoryRoute): the owner's read-back of the built-in roles' INVOICES levels, over migration 026's
// one-snapshot read (postgresRoleLevels.ts) on the kernel's client, requiring the owner rule like its Customers sibling. Its
// port is its own (invoiceRoleLevels) and takes each role's default from the same materializer, on the 'invoices' domain.
// The PUT's mutator now dispatches by domain inside the persistence layer; nothing else is added. As this stage first wrote
// it, Invoices was configuration only, no invoice business route was served; since M7B-INVOICES-P1 (below) the three invoice
// DRAFT operations — a store's list, one draft's reopen and the save — consume the Invoices level, and, since
// M7B-INVOICES-P1-R2, the save's creation eligibility; nothing else does. No
// readiness probe is added for the read-back (it fails closed itself).
//
// M7B-INVOICES-P1 UPDATE (store directory). A sixth read, GET /api/v1/stores (storeDirectory.ts createStoreDirectoryRoute):
// the stores the presenting session's actor may act at, over migration 027's session-bound routine (postgresStoreDirectory.ts)
// on the kernel's client. It is the route table's one closed authorization-free business route (routes.ts): no authorizer
// runs, the routine derives every store from the session key, and it is listed with the reads (a read-only actor's session
// reads its stores, marked read-only). Readiness: the reads probe asks 027's routine last (probeStoreDirectory), after the
// search's, and is ready only when all five refuse an absent key.
//
// M7B-INVOICES-P1 UPDATE (invoice drafts). Two more reads — a store's drafts and one draft (invoiceDrafts.ts
// createInvoiceDraftListRoute, createInvoiceDraftDetailRoute), STORE-scope routes over migration 028's session-bound reads
// (postgresInvoiceDrafts.ts createPostgresInvoiceDrafts), listed with the reads so a read-only actor reaches them — and one
// more write: the draft save (INVOICE_DRAFT_CREATE_ROUTE) over its mutator (INVOICE_DRAFT_CREATE_MUTATOR), both declaring
// STORE context scope, which the kernel's write slot requires to equal the route's requirement scope. Readiness: the reads
// probe asks 028's two reads last (probeInvoiceDrafts). Its one event contract is the entry's to compose (tenantEntry.ts):
// this root names none.
//
// M7B-INVOICES-P1-R2 UPDATE (draft creation eligibility). One more read, GET /api/v1/stores/{storeId}/invoice-drafts/eligibility
// (invoiceDrafts.ts createInvoiceDraftEligibilityRoute), declared under the save's own requirement and listed with the
// reads. It takes no port, adds no readiness probe and writes no business row (no draft, line, audit record, outbox event,
// lease, idempotency completion or role-level row): the chain's authorizer decides it before the handler answers. Like every
// authorized read, a 200 refreshes the session's lastSeenAt, and each request spends the request limit.
//
// M7B-INVOICES-P2 UPDATE (draft edit). The edit, PATCH /api/v1/stores/{storeId}/invoice-drafts/{id}, over its store-scope
// mutator (migration 030's v2 routine), in `writes`; its edit eligibility, GET …/invoice-drafts/{id}/edit-eligibility, a
// portless store-scope read under the edit's own requirement, in `reads` (a read-only actor reaches it and is denied Edit,
// the same 403). Neither adds a readiness probe; the edit's event contract (invoice_draft.updated) is the entry's to compose
// (tenantEntry.ts), like the save's.
//
// M7B-INVOICES-DISCARD-P1 UPDATE (draft discard). The discard, POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard,
// over its store-scope mutator (migration 033's routine), in `writes`, last; its discard eligibility, GET
// …/invoice-drafts/{id}/discard-eligibility, a portless store-scope read under the discard's own requirement, in `reads`,
// last (a read-only actor reaches it and is denied Manage, the same 403). Neither adds a readiness probe, and the discard
// declares no event, so the entry's event contracts are unchanged. The drafts' two reads, and their probe, now call
// migration 033's open-only routines (postgresInvoiceDrafts.ts).
//
// Its readiness is the adapters' own probes (probeCustomerDirectory, probeCustomerDetail, probeCustomerProfile, probeCustomerSearch, probeStoreDirectory, then probeInvoiceDrafts), answered over the same kernel. The routes are
// declared over a port that answers nothing before any client exists, so the permission census and the table check run
// with nothing to close.
import { CUSTOMER_CREATE_MUTATOR } from '../persistence/postgresCustomerCreate.js';
import { CUSTOMER_UPDATE_MUTATOR } from '../persistence/postgresCustomerUpdate.js';
import {
  createPostgresCustomerDetail, createPostgresCustomerDirectory, createPostgresCustomerProfile, probeCustomerDetail, probeCustomerDirectory,
  probeCustomerProfile, probeCustomerSearch,
} from '../persistence/postgresCustomerDirectory.js';
import {
  ROLE_LEVEL_UPDATE_MUTATOR, createPostgresRoleLevelDirectory, createPostgresRoleLevels, readRoleLevels,
} from '../persistence/postgresRoleLevels.js';
import type { StoredRoleLevel } from '../persistence/postgresRoleLevels.js';
import { createPostgresStoreDirectory, probeStoreDirectory } from '../persistence/postgresStoreDirectory.js';
import {
  INVOICE_DRAFT_CREATE_MUTATOR, INVOICE_DRAFT_DISCARD_MUTATOR, INVOICE_DRAFT_UPDATE_MUTATOR, createPostgresInvoiceDrafts, probeInvoiceDrafts,
} from '../persistence/postgresInvoiceDrafts.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { RuntimeDatabaseEndpoint } from '../platform-identity/databaseEndpoint.js';
import { TENANT_OWNER_ROLE_ID, materializeTenantPermissions } from '../platform-identity/permissionCatalog.js';
import { CUSTOMER_CREATE_ROUTE } from '../runtime/customerCreate.js';
import { CUSTOMER_UPDATE_ROUTE } from '../runtime/customerUpdate.js';
import { createCustomerDetailRoute, createCustomerDirectoryRoute, createCustomerProfileRoute } from '../runtime/customerDirectory.js';
import type { CustomerDetailPorts, CustomerDirectoryPorts, CustomerProfilePorts } from '../runtime/customerDirectory.js';
import { createInvoiceRoleLevelDirectoryRoute, createRoleLevelDirectoryRoute } from '../runtime/roleLevelDirectory.js';
import type { InvoiceRoleLevelDirectoryPorts, RoleLevelDirectoryPort, RoleLevelDirectoryPorts } from '../runtime/roleLevelDirectory.js';
import { ROLE_LEVEL_UPDATE_ROUTE } from '../runtime/roleLevelUpdate.js';
import { createStoreDirectoryRoute } from '../runtime/storeDirectory.js';
import type { StoreDirectoryPorts } from '../runtime/storeDirectory.js';
import {
  INVOICE_DRAFT_CREATE_ROUTE, INVOICE_DRAFT_DISCARD_ROUTE, INVOICE_DRAFT_UPDATE_ROUTE, createInvoiceDraftDetailRoute, createInvoiceDraftDiscardEligibilityRoute,
  createInvoiceDraftEditEligibilityRoute, createInvoiceDraftEligibilityRoute, createInvoiceDraftListRoute,
} from '../runtime/invoiceDrafts.js';
import type { InvoiceDraftPorts } from '../runtime/invoiceDrafts.js';
import type { RouteDefinition } from '../runtime/routes.js';
import { TransactionCompositionError, composeReadTransactions, uncataloguedRoutePermissions } from './transactionKernel.js';
import type { ReadInventory, ReadTransactions } from './transactionKernel.js';

/**
 * The tenant reads' ports: the customer directory's, the customer detail's (M7A-CUSTOMERS-P4), the customer profile's
 * (M7A-CUSTOMERS-P6), the role levels' read-backs (Customers, M7A-CUSTOMERS-P3-R2; Invoices, M5-INVOICES-AUTH-P1), the
 * store directory's and the invoice drafts' (M7B-INVOICES-P1).
 */
type TenantReadPorts = CustomerDirectoryPorts & CustomerDetailPorts & CustomerProfilePorts & RoleLevelDirectoryPorts & InvoiceRoleLevelDirectoryPorts
  & StoreDirectoryPorts & InvoiceDraftPorts;

const notComposed = (): never => { throw new Error('read port not composed'); };
/** A port that answers nothing: the routes' declarations are built over it, before any client exists. */
const INERT: TenantReadPorts = Object.freeze({
  customers: Object.freeze({ page: notComposed }),
  customerDetail: Object.freeze({ get: notComposed }),
  customerProfile: Object.freeze({ get: notComposed }),
  roleLevels: Object.freeze({ levels: notComposed }),
  invoiceRoleLevels: Object.freeze({ levels: notComposed }),
  stores: Object.freeze({ stores: notComposed }),
  invoiceDrafts: Object.freeze({ page: notComposed, get: notComposed }),
});

/** A role's catalog default on `domain`: the tenant authorizer's own materializer, with no edit, unlimited. */
const catalogDefault = (domain: string, roleId: string): string | undefined => materializeTenantPermissions(roleId, {}, false)[domain];

/** The read-back's port: the stored levels and versions, each beside its catalog default, the owner first at its fixed level, unversioned. */
function withCatalogDefaults(domain: string, stored: (tenant: string, signal: AbortSignal) => Promise<readonly StoredRoleLevel[]>): RoleLevelDirectoryPort {
  return Object.freeze({
    levels: async (tenant: string, signal: AbortSignal): Promise<unknown> => [
      { roleId: TENANT_OWNER_ROLE_ID, stored: null, defaultLevel: catalogDefault(domain, TENANT_OWNER_ROLE_ID), version: null },
      ...(await stored(tenant, signal)).map((entry) => ({
        roleId: entry.roleId, stored: entry.stored, defaultLevel: catalogDefault(domain, entry.roleId), version: entry.version,
      })),
    ],
  });
}

/**
 * The reads' one readiness probe: the directory's routine, then — only once it has refused — the detail's (M7A-CUSTOMERS-P4),
 * then — only once that has refused — the profile's (M7A-CUSTOMERS-P6), then — only once that has refused — the name
 * search's (M7A-CUSTOMERS-P8), then — only once that has refused — the store directory's, then — only once that has
 * refused — the invoice drafts' two reads (M7B-INVOICES-P1).
 */
const probeTenantReads = async (client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> =>
  (await probeCustomerDirectory(client, signal)) && (await probeCustomerDetail(client, signal)) && (await probeCustomerProfile(client, signal))
  && (await probeCustomerSearch(client, signal)) && (await probeStoreDirectory(client, signal)) && probeInvoiceDrafts(client, signal);

// The tenant route inventory, added to here and only here: the customer directory over its production adapter, the
// customer create over its mutator (M7A-CUSTOMERS-P3), the role-level edit over its mutator and the role-level reads
// (M7A-CUSTOMERS-P3-R1), the role levels' read-back over its one-snapshot read (M7A-CUSTOMERS-P3-R2), the customer
// detail over its session-bound read (M7A-CUSTOMERS-P4), the customer profile over its session-bound read
// (M7A-CUSTOMERS-P6), the customer edit over its mutator (M7A-CUSTOMERS-P7), the Invoices role levels' read-back
// (M5-INVOICES-AUTH-P1), the store directory over its session-bound read, the invoice drafts' two store-scope reads and
// their save over its store-scope mutator (M7B-INVOICES-P1), and the drafts' creation eligibility, a portless store-scope
// read under the save's own requirement (M7B-INVOICES-P1-R2), and the drafts' edit over its store-scope mutator and its edit
// eligibility, a portless store-scope read under the edit's own requirement (M7B-INVOICES-P2), and the drafts' discard over
// its store-scope mutator and its discard eligibility, a portless store-scope read under the discard's own requirement
// (M7B-INVOICES-DISCARD-P1). Every read is in `reads`, so a read-only actor reaches the three eligibility routes too — and
// the evaluator denies it create, edit and discard, the same 403.
export const TENANT_INVENTORY: ReadInventory<TenantReadPorts> = Object.freeze({
  reads: Object.freeze([createCustomerDirectoryRoute, createCustomerDetailRoute, createCustomerProfileRoute, createRoleLevelDirectoryRoute, createInvoiceRoleLevelDirectoryRoute, createStoreDirectoryRoute, createInvoiceDraftListRoute, createInvoiceDraftDetailRoute, createInvoiceDraftEligibilityRoute, createInvoiceDraftEditEligibilityRoute, createInvoiceDraftDiscardEligibilityRoute]),
  writes: Object.freeze({ routes: Object.freeze([CUSTOMER_CREATE_ROUTE, CUSTOMER_UPDATE_ROUTE, ROLE_LEVEL_UPDATE_ROUTE, INVOICE_DRAFT_CREATE_ROUTE, INVOICE_DRAFT_UPDATE_ROUTE, INVOICE_DRAFT_DISCARD_ROUTE]), mutators: Object.freeze([CUSTOMER_CREATE_MUTATOR, CUSTOMER_UPDATE_MUTATOR, ROLE_LEVEL_UPDATE_MUTATOR, INVOICE_DRAFT_CREATE_MUTATOR, INVOICE_DRAFT_UPDATE_MUTATOR, INVOICE_DRAFT_DISCARD_MUTATOR]) }),
  ports: (client: SupervisedPgClient) => Object.freeze({ customers: createPostgresCustomerDirectory({ client }), customerDetail: createPostgresCustomerDetail({ client }), customerProfile: createPostgresCustomerProfile({ client }), roleLevels: withCatalogDefaults('customers', createPostgresRoleLevelDirectory({ client }, 'customers')), invoiceRoleLevels: withCatalogDefaults('invoices', createPostgresRoleLevelDirectory({ client }, 'invoices')), stores: createPostgresStoreDirectory({ client }), invoiceDrafts: createPostgresInvoiceDrafts({ client }) }),
  inert: INERT,
  probe: probeTenantReads,
  roleLevels: Object.freeze({ read: (client: SupervisedPgClient) => createPostgresRoleLevels({ client }), held: readRoleLevels }),
});

/** Every route the tenant inventory would serve — its reads, then its commands — as declared over a port that answers nothing. */
export function tenantRouteDeclarations(): readonly RouteDefinition[] {
  return Object.freeze([...TENANT_INVENTORY.reads.map((build) => build(INERT)), ...(TENANT_INVENTORY.writes?.routes ?? [])]);
}

/**
 * The tenant entry's transaction boundary: configuration and the kernel's constructor in, the tenant boundary's durable
 * adapters and the served routes over one kernel out — or a refusal naming every blocker before any client exists.
 */
export function composeTenantTransactions(
  env: Readonly<Record<string, string | undefined>>,
  client: (endpoint: RuntimeDatabaseEndpoint) => SupervisedPgClient,
): ReadTransactions {
  const uncatalogued = uncataloguedRoutePermissions(tenantRouteDeclarations());
  if (uncatalogued.length > 0) throw new TransactionCompositionError(uncatalogued);
  return composeReadTransactions(TENANT_INVENTORY, env, client);
}
