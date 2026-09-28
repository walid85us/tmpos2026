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
// Its readiness is the adapter's own probe (probeCustomerDirectory), answered over the same kernel. The routes are
// declared over a port that answers nothing before any client exists, so the permission census and the table check run
// with nothing to close.
import { CUSTOMER_CREATE_MUTATOR } from '../persistence/postgresCustomerCreate.js';
import { createPostgresCustomerDirectory, probeCustomerDirectory } from '../persistence/postgresCustomerDirectory.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { RuntimeDatabaseEndpoint } from '../platform-identity/databaseEndpoint.js';
import { CUSTOMER_CREATE_ROUTE } from '../runtime/customerCreate.js';
import { createCustomerDirectoryRoute } from '../runtime/customerDirectory.js';
import type { CustomerDirectoryPorts } from '../runtime/customerDirectory.js';
import type { RouteDefinition } from '../runtime/routes.js';
import { TransactionCompositionError, composeReadTransactions, uncataloguedRoutePermissions } from './transactionKernel.js';
import type { ReadInventory, ReadTransactions } from './transactionKernel.js';

/** A port that answers nothing: the routes' declarations are built over it, before any client exists. */
const INERT: CustomerDirectoryPorts = Object.freeze({
  customers: Object.freeze({ page: (): never => { throw new Error('read port not composed'); } }),
});

// The tenant route inventory, added to here and only here: the customer directory over its production adapter, and the
// customer create over its mutator (M7A-CUSTOMERS-P3).
export const TENANT_INVENTORY: ReadInventory<CustomerDirectoryPorts> = Object.freeze({
  reads: Object.freeze([createCustomerDirectoryRoute]),
  writes: Object.freeze({ routes: Object.freeze([CUSTOMER_CREATE_ROUTE]), mutators: Object.freeze([CUSTOMER_CREATE_MUTATOR]) }),
  ports: (client: SupervisedPgClient) => Object.freeze({ customers: createPostgresCustomerDirectory({ client }) }),
  inert: INERT,
  probe: probeCustomerDirectory,
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
