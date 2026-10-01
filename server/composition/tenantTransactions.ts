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
// Its readiness is the adapters' own probes (probeCustomerDirectory, probeCustomerDetail, then probeCustomerProfile), answered over the same kernel. The routes are
// declared over a port that answers nothing before any client exists, so the permission census and the table check run
// with nothing to close.
import { CUSTOMER_CREATE_MUTATOR } from '../persistence/postgresCustomerCreate.js';
import {
  createPostgresCustomerDetail, createPostgresCustomerDirectory, createPostgresCustomerProfile, probeCustomerDetail, probeCustomerDirectory,
  probeCustomerProfile,
} from '../persistence/postgresCustomerDirectory.js';
import {
  ROLE_LEVEL_UPDATE_MUTATOR, createPostgresRoleLevelDirectory, createPostgresRoleLevels, readRoleLevels,
} from '../persistence/postgresRoleLevels.js';
import type { StoredRoleLevel } from '../persistence/postgresRoleLevels.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { RuntimeDatabaseEndpoint } from '../platform-identity/databaseEndpoint.js';
import { TENANT_OWNER_ROLE_ID, materializeTenantPermissions } from '../platform-identity/permissionCatalog.js';
import { CUSTOMER_CREATE_ROUTE } from '../runtime/customerCreate.js';
import { createCustomerDetailRoute, createCustomerDirectoryRoute, createCustomerProfileRoute } from '../runtime/customerDirectory.js';
import type { CustomerDetailPorts, CustomerDirectoryPorts, CustomerProfilePorts } from '../runtime/customerDirectory.js';
import { createRoleLevelDirectoryRoute } from '../runtime/roleLevelDirectory.js';
import type { RoleLevelDirectoryPort, RoleLevelDirectoryPorts } from '../runtime/roleLevelDirectory.js';
import { ROLE_LEVEL_DOMAINS, ROLE_LEVEL_UPDATE_ROUTE } from '../runtime/roleLevelUpdate.js';
import type { RouteDefinition } from '../runtime/routes.js';
import { TransactionCompositionError, composeReadTransactions, uncataloguedRoutePermissions } from './transactionKernel.js';
import type { ReadInventory, ReadTransactions } from './transactionKernel.js';

/**
 * The tenant reads' ports: the customer directory's, the customer detail's (M7A-CUSTOMERS-P4), the customer profile's
 * (M7A-CUSTOMERS-P6) and the role levels' read-back (M7A-CUSTOMERS-P3-R2).
 */
type TenantReadPorts = CustomerDirectoryPorts & CustomerDetailPorts & CustomerProfilePorts & RoleLevelDirectoryPorts;

const notComposed = (): never => { throw new Error('read port not composed'); };
/** A port that answers nothing: the routes' declarations are built over it, before any client exists. */
const INERT: TenantReadPorts = Object.freeze({
  customers: Object.freeze({ page: notComposed }),
  customerDetail: Object.freeze({ get: notComposed }),
  customerProfile: Object.freeze({ get: notComposed }),
  roleLevels: Object.freeze({ levels: notComposed }),
});

/** A role's catalog default on the one decided domain: the tenant authorizer's own materializer, with no edit, unlimited. */
const catalogDefault = (roleId: string): string | undefined => materializeTenantPermissions(roleId, {}, false)[ROLE_LEVEL_DOMAINS[0]];

/** The read-back's port: the stored levels and versions, each beside its catalog default, the owner first at its fixed level, unversioned. */
function withCatalogDefaults(stored: (tenant: string, signal: AbortSignal) => Promise<readonly StoredRoleLevel[]>): RoleLevelDirectoryPort {
  return Object.freeze({
    levels: async (tenant: string, signal: AbortSignal): Promise<unknown> => [
      { roleId: TENANT_OWNER_ROLE_ID, stored: null, defaultLevel: catalogDefault(TENANT_OWNER_ROLE_ID), version: null },
      ...(await stored(tenant, signal)).map((entry) => ({
        roleId: entry.roleId, stored: entry.stored, defaultLevel: catalogDefault(entry.roleId), version: entry.version,
      })),
    ],
  });
}

/**
 * The reads' one readiness probe: the directory's routine, then — only once it has refused — the detail's (M7A-CUSTOMERS-P4),
 * then — only once that has refused — the profile's (M7A-CUSTOMERS-P6).
 */
const probeTenantReads = async (client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> =>
  (await probeCustomerDirectory(client, signal)) && (await probeCustomerDetail(client, signal)) && probeCustomerProfile(client, signal);

// The tenant route inventory, added to here and only here: the customer directory over its production adapter, the
// customer create over its mutator (M7A-CUSTOMERS-P3), the role-level edit over its mutator and the role-level reads
// (M7A-CUSTOMERS-P3-R1), the role levels' read-back over its one-snapshot read (M7A-CUSTOMERS-P3-R2), the customer
// detail over its session-bound read (M7A-CUSTOMERS-P4), and the customer profile over its session-bound read
// (M7A-CUSTOMERS-P6).
export const TENANT_INVENTORY: ReadInventory<TenantReadPorts> = Object.freeze({
  reads: Object.freeze([createCustomerDirectoryRoute, createCustomerDetailRoute, createCustomerProfileRoute, createRoleLevelDirectoryRoute]),
  writes: Object.freeze({ routes: Object.freeze([CUSTOMER_CREATE_ROUTE, ROLE_LEVEL_UPDATE_ROUTE]), mutators: Object.freeze([CUSTOMER_CREATE_MUTATOR, ROLE_LEVEL_UPDATE_MUTATOR]) }),
  ports: (client: SupervisedPgClient) => Object.freeze({ customers: createPostgresCustomerDirectory({ client }), customerDetail: createPostgresCustomerDetail({ client }), customerProfile: createPostgresCustomerProfile({ client }), roleLevels: withCatalogDefaults(createPostgresRoleLevelDirectory({ client })) }),
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
