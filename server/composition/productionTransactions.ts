// Phase 4.0 M6-PG-P7-R1 — the production transaction boundary: durable idempotency and the command-transaction port, composed
// from the M6 PostgreSQL store (server/persistence) only for a route that requires them.
//
// One authority. This is the one production module that composes the store and IDEMPOTENCY_KEY, over the transaction kernel
// both production roots share (transactionKernel.ts, M7A-CUSTOMERS-P2: the one reader of APP_DATABASE_URL, the kernel over it
// and the adapters both entries compose over it); the sessions root (productionSessions.ts) composes the session boundaries
// and the request limits, and nothing else. It is driven by the production route inventory below, validated by the runtime's
// own route table (defineRoutes):
//   - no route declares `idempotency: 'required'`, so nothing is read, built or probed: not APP_DATABASE_URL, not IDEMPOTENCY_KEY,
//     no client, kernel, store or readiness probe. The answer is null, and createApp keeps serving the probes and the bounded
//     fallback exactly as before;
//   - at least one does — the production inventory's does since M5-GIAM-D1-P1 (the tenant display-name command) — so the
//     runtime database configuration and the idempotency key are required and validated first; only
//     then is the kernel built over the classified endpoint, and the store over the kernel, each once. The idempotency store
//     and the command-transaction port are returned together, never one alone. Anything absent, invalid or unsupported refuses
//     with every blocker it names as a bounded code, before any client exists; nothing is composed while one remains, and there
//     is no in-memory, test, local or fail-open alternative.
// Configuration, never content in a refusal:
//   - APP_DATABASE_URL: the runtime principal's connection — never SUPABASE_DATABASE_URL, the migration applier's, which is not
//     read here. Classified before any client exists (platform-identity/databaseEndpoint.ts): a direct or session-pooler endpoint
//     on 5432 only; a transaction pooler is refused, because the kernel's reset before reuse needs one connection to stay one
//     session. A deployment provisions it only once G-DBROLE has created the runtime login and chosen that endpoint;
//   - IDEMPOTENCY_KEY: the dedicated keyed-hash secret for idempotency records (keyMaterial.ts), never RATE_LIMIT_KEY (an equal
//     key refuses, however padded);
//   - DATABASE_CA_CERT: the shared transport policy's trust anchor (db.ts), read from the process environment, as the driver reads
//     its own.
// What crosses. The composition hands back the two ports, the key, the session boundaries' durable adapters (the session store,
// the tenant admission and — M5-GIAM-D1-P4 — the platform admission the administrative boundary is admitted and authorized
// through), the distributed rate limiter's binding (M6-RATE-P2, migration 014: the limiter over this kernel, awaiting the
// RATE_LIMIT_KEY the session root parses — this root never reads that key for the limiter), the routes as served, the
// deployable entry's read-only startup preflight over the same kernel (M6-ENTRY-P1: connect, the runtime login's standing,
// the migration ledger and the limiter key's boot check — postgresStartupPreflight.ts) and `close` — never the kernel, a
// pool, the driver, a statement function, the URL or its credential. createApp probes both ports, each the store's
// read-only probe routine under the established readiness deadline and sharing, only because they are composed. `close`
// ends the kernel within its bounded grace (RETIRED_POOL_GRACE_S); the deployable entry (server/entry/productionEntry.ts)
// runs it as a shutdown hook.
// The kernel's constructor. Configuration is this root's one required input; the one other it takes is how the kernel is
// constructed over the classified endpoint — the deployable entry's construction boundary, defaulted to the production
// client (createRuntimeStoreClient: verified TLS, the sealed target). A disposable-database harness hands a client over its
// own cluster; nothing else — no store, adapter, factory or inventory — can be handed to it.
import type { RuntimeDatabaseEndpoint } from '../platform-identity/databaseEndpoint.js';
import { createPostgresPlatformAdmission, readPlatformAdmission } from '../persistence/postgresPlatformAdmission.js';
import { lockPlatformAuthority, revalidatePlatformAuthority } from '../persistence/postgresPrincipalResolver.js';
import { holdAdministrativeSession } from '../persistence/postgresSessionStore.js';
import type { SessionStandingCheck } from '../persistence/postgresSessionStore.js';
import { holdTenantStanding, readTenantAdmission } from '../persistence/postgresTenantAdmission.js';
import { createPostgresTenantDirectory } from '../persistence/postgresTenantDirectory.js';
import { createPostgresTransactionalStore } from '../persistence/postgresTransactionalStore.js';
import { TENANT_DISPLAY_NAME_MUTATOR } from '../persistence/tenantDisplayNameMutator.js';
import { TENANT_STATUS_MUTATOR } from '../persistence/tenantStatusMutator.js';
import { TENANT_DISPLAY_NAME_ROUTE } from '../runtime/tenantDisplayName.js';
import { TENANT_STATUS_ROUTE } from '../runtime/tenantStatus.js';
import { createTenantDirectoryRoute } from '../runtime/tenantDirectory.js';
import type { TenantDirectoryPort, TenantDirectoryPorts } from '../runtime/tenantDirectory.js';
import { createPlatformContextRevalidator, createPlatformEstablishCheck, createPlatformPermits } from './platformAuthorization.js';
import { createTenantEstablishCheck } from './tenantAuthorization.js';
import { KERNEL_FACTORIES, TransactionCompositionError, kernelOver, runtimeEndpoint, uncataloguedRoutePermissions } from './transactionKernel.js';
import type { KernelFactories, ReadRouteFactory, TransactionCompositionBlocker, TransactionPreflight } from './transactionKernel.js';
import type { AggregateMutator, TransactionalStore, TransactionalStoreOptions } from '../persistence/postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { CommandTransactionDeps } from '../runtime/commandTransaction.js';
import type { IdempotencyDeps } from '../runtime/idempotency.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { defineRoutes } from '../runtime/routes.js';
import type { RouteDefinition } from '../runtime/routes.js';
import type { PlatformAdmissionPort, TenantAdmissionPort } from '../runtime/principals.js';
import type { DistributedRateLimiter } from '../runtime/rateLimit.js';
import type { SessionStore } from '../runtime/sessions.js';

// The kernel's composition refusal and permission census, as this root has always exported them.
export { TransactionCompositionError, uncataloguedRoutePermissions } from './transactionKernel.js';

/** The routes a deployment serves beyond the probes, and the mutator each command kind commits through: trusted source. */
export interface TransactionInventory {
  readonly routes: readonly RouteDefinition[];
  readonly mutators: readonly AggregateMutator[];
  /**
   * The read routes (M5-GIAM-D1-P3). A definition holds its port, and the port exists only once the kernel does, so the
   * inventory names each route's FACTORY and this root builds it — once, over the same client as the store — from the read
   * ports it composed; none when absent. They are composed with the command boundary.
   */
  readonly reads?: readonly ReadRouteFactory<TenantDirectoryPorts>[];
}

/** createApp's `idempotency` and `transactions`, always together, and the kernel's shutdown. */
export interface ProductionTransactions {
  readonly idempotency: IdempotencyDeps;
  readonly transactions: CommandTransactionDeps;
  /**
   * The administrative boundary's admission over that same kernel (migration 013, M5-GIAM-D1-P4): the read that decides
   * whether an administrative session may continue, on which platform grant and at which witness. The session root binds
   * it, and builds the canonical platform authorizer that decides on the scope it selects (platformAuthorization.ts).
   */
  readonly platformAdmission: PlatformAdmissionPort;
  /**
   * The durable session store over that same kernel (M5-GIAM-D1-P2-R1, migration 011): the store the
   * session boundaries have always required and never had. It is built HERE, not in the session root,
   * because the runtime database's configuration is read by the transaction kernel alone (transactionKernel.ts) — a
   * second root reading it would be a second credential and a second classification of the same endpoint.
   */
  readonly sessionStore: SessionStore;
  /**
   * The tenant boundary's admission over that same kernel (migration 011): the read that decides
   * whether a tenant session may continue, and at which witness. The session root binds it.
   */
  readonly tenantAdmission: TenantAdmissionPort;
  /**
   * The distributed rate limiter over that same kernel (migration 014, M6-RATE-P2), awaiting its key: called with
   * RATE_LIMIT_KEY's bytes, it answers the PostgreSQL limiter bound to that key's fingerprint. The session root calls it
   * with the key it parsed itself, so the limits' secret and the store's fingerprint are one key. Calling it opens nothing.
   */
  readonly rateLimiter: (keySecret: Uint8Array) => DistributedRateLimiter;
  /**
   * Every route the inventory serves, as served: its commands, and its read routes bound to the read ports this root
   * composed over that same kernel (M5-GIAM-D1-P3) — the list an entry hands createApp as `routes`.
   */
  readonly routes: readonly RouteDefinition[];
  /**
   * The deployable entry's read-only startup questions over that same kernel (M6-ENTRY-P1), asked before any listener opens.
   * null only when the factories built none — a harness that composes no entry; the production factories always build it.
   */
  readonly preflight: TransactionPreflight | null;
  /** Ends the store's kernel: transactions in flight get RETIRED_POOL_GRACE_S, then every pool is closed. */
  readonly close: () => Promise<void>;
}

/**
 * How the boundary is built: the kernel's factories (the client over a classified endpoint, the session store — one standing
 * check for both audiences here, dispatching on the record's, and no issuer key — the tenant admission, the limiter and the
 * preflight), then the store and the administrative adapters over that client.
 */
export interface TransactionFactories extends KernelFactories {
  readonly store: (options: TransactionalStoreOptions) => TransactionalStore;
  readonly platformAdmission: (client: SupervisedPgClient) => PlatformAdmissionPort;
  /** The platform tenant directory's read over migration 012, for the inventory's read routes. */
  readonly tenantDirectory: (client: SupervisedPgClient) => TenantDirectoryPort;
}

// The production route inventory, added to here and only here. Its first business route (owner decision D1, M5-GIAM-D1-P1) is
// PATCH /admin/v1/tenants/display-name with its one mutator over migration 009's fixed operation, so a deployment serving it
// requires the whole boundary below — the database, the idempotency key and the store — and refuses to start without it. The
// entry that composes it also hands createApp the route's own contracts (tenantDisplayName.ts); none is deployed yet.
// The second (M5-GIAM-D1-P2) is PATCH /admin/v1/tenants/status over migration 010's fixed operation: the tenant lifecycle
// command, which additionally requires a recent trusted authentication and moves the tenant access version that tenant and
// store sessions are admitted against. Both declare `trustedContext: 'required'`, so neither can be served by a deployment
// whose authorizer resolves no actor, and both take their permission from the canonical catalog.
// The first read route (M5-GIAM-D1-P3) is GET /admin/v1/tenants over migration 012's one bounded read: the platform
// tenant directory the Tenant Management page lists tenants through, under view_tenants and a resolved trusted scope,
// built here over the SAME kernel as the store (ReadRouteFactory). It is platform-scoped like both commands.
export const PRODUCTION_INVENTORY: TransactionInventory = Object.freeze({
  routes: Object.freeze([TENANT_DISPLAY_NAME_ROUTE, TENANT_STATUS_ROUTE]),
  mutators: Object.freeze([TENANT_DISPLAY_NAME_MUTATOR, TENANT_STATUS_MUTATOR]),
  reads: Object.freeze([createTenantDirectoryRoute]),
});

// The approved production factories: the kernel's (transactionKernel.ts), and the M6 PostgreSQL store with the administrative
// adapters over it.
const PRODUCTION_FACTORIES: TransactionFactories = Object.freeze({
  ...KERNEL_FACTORIES,
  store: createPostgresTransactionalStore,
  platformAdmission: (client: SupervisedPgClient) => createPostgresPlatformAdmission({ client }),
  tenantDirectory: (client: SupervisedPgClient) => createPostgresTenantDirectory({ client }),
});

/**
 * Compose the transaction boundary `inventory` needs from `env` through `factories`: null when no route requires idempotency
 * (nothing is read), otherwise both ports together — or a refusal naming every blocker, before anything is built.
 */
export function assembleTransactions(
  inventory: TransactionInventory,
  env: Readonly<Record<string, string | undefined>>,
  factories: TransactionFactories,
): ProductionTransactions | null {
  const reads = inventory.reads ?? [];
  // The whole table the root would serve, as declared over ports that answer nothing, is validated before any client
  // exists: a read route that collides with a command or fails its own setup refuses here, with nothing to close.
  defineRoutes([...inventory.routes, ...reads.map((build) => build(INERT_READ_PORTS))]);
  const routes = defineRoutes(inventory.routes).list();
  const required = routes.filter((route) => route.idempotency === 'required');
  // Read routes ride the command boundary's kernel; with no command there is none, and dropping them silently would
  // turn a declared route into a 404, so that refuses instead.
  if (required.length === 0) {
    if (reads.length > 0) throw new TransactionCompositionError(['read_route_without_boundary']);
    return null;
  }

  const blockers: TransactionCompositionBlocker[] = [];
  const endpoint = runtimeEndpoint(env);
  if (typeof endpoint === 'string') blockers.push(endpoint);
  const rawKey = env.IDEMPOTENCY_KEY;
  const keySecret = rawKey === undefined || rawKey === '' ? null : parseKeyMaterial(rawKey);
  if (rawKey === undefined || rawKey === '') blockers.push('idempotency_key_missing');
  else if (keySecret === null) blockers.push('idempotency_key_invalid');
  else {
    const limiterKey = parseKeyMaterial(env.RATE_LIMIT_KEY);
    if (limiterKey !== null && sameKeyMaterial(keySecret, limiterKey)) blockers.push('idempotency_key_shared');
  }
  // Each command route commits through exactly one mutator of its contract's kind, mode and aggregate type — never a same-kind
  // mutator that would fail every command at run time.
  const commands = required.flatMap((route) => ('command' in route ? [route.command.contract] : []));
  if (commands.some((contract) => {
    const matching = inventory.mutators.filter((mutator) => mutator.kind === contract.kind);
    // M7B-INVOICES-ISSUE-P1: and both opt into the issuing refusal pair, or neither (transactionKernel.ts's tenant rule, here too).
    return matching.length !== 1 || matching[0].mode !== contract.mode || matching[0].aggregateType !== contract.aggregateType
      || (matching[0].issuingRefusals === true) !== (contract.issuingRefusals === true);
  })) blockers.push('command_mutator_unavailable');
  // M7B-INVOICES-P1 (design R4): each command route's requirement scope, its contract's DECLARED context scope and its
  // mutator's are one scope, and this root's store admits platform contexts alone — none defaulted: a contract or mutator
  // without a declaration (an untyped caller) is a mismatch. A `perform` route carries no contract and is not a command.
  else if (required.some((route) => {
    if (!('command' in route)) return false;
    const requirement = route.policy.access === 'session' || route.policy.access === 'authenticated' ? route.policy.authorization : null;
    const contract = route.command.contract;
    const mutator = inventory.mutators.find((candidate) => candidate.kind === contract.kind);
    return requirement === null || requirement.scope !== 'platform' || contract.contextScope !== 'platform' || mutator?.contextScope !== 'platform';
  })) blockers.push('command_scope_mismatch');
  if (blockers.length > 0) throw new TransactionCompositionError(blockers);

  const client = kernelOver(factories.client, endpoint as RuntimeDatabaseEndpoint);
  // The two in-transaction checks that order administrative requests against revocation (M5-ADMIN-REVOKE-P1), each built
  // once over the persistence layer's plain functions on the caller's own handle: the command revalidator — 009's
  // freshness and locks, the presenting session held, then 013's read of that session's standing — and the login's
  // standing check — 013's read, 009's locks through the lock that THROWS on a fault (never the catch-all above it, which
  // would turn a fault into a 401), then 013 again. The ONE session store serves both audiences, so its standing check
  // dispatches on the record's (M5-TENANT-SESSION-P1): a tenant login holds its actor's standing (016's hold, which
  // throws on a fault) and re-reads 016's admission there; any other audience is a wiring fault, a throw.
  const hold = (sql: PgTransactionScope, key: string) => holdAdministrativeSession(sql, key, Date.now());
  const revalidate = createPlatformContextRevalidator({ authority: revalidatePlatformAuthority, session: hold, read: readPlatformAdmission });
  const adminStanding = createPlatformEstablishCheck({ read: readPlatformAdmission, authority: lockPlatformAuthority });
  const tenantStanding = createTenantEstablishCheck({ hold: holdTenantStanding, read: readTenantAdmission });
  const standing: SessionStandingCheck = async (sql, record) => {
    if (record.audience === 'admin') return adminStanding(sql, record);
    if (record.audience === 'tenant') return tenantStanding(sql, record);
    throw new Error('session standing unavailable');
  };
  let store: TransactionalStore;
  try {
    // The revalidator the store runs inside each command transaction, over the same client and the
    // same governed endpoint: one credential, one boundary, no second connection. It re-decides exactly
    // what the authorizer below decided — the very grant and role, then the permission on the same role
    // definitions — on the committing transaction (M5-GIAM-D1-P1-R1), while the presenting session is live.
    store = factories.store({ client, mutators: inventory.mutators, revalidate });
  } catch (err) {
    void client.end(); // nothing opened yet: the kernel connects only when a transaction runs
    throw err;
  }
  // The read routes, over the SAME kernel (M5-GIAM-D1-P3): the tenant directory's port, and the canonical permission
  // decision its `actions` are presented from — the same rule and role definitions as the authorizer below. The whole
  // served set is validated once more as one table, so a read route can never shadow a command or register twice.
  const readPorts: TenantDirectoryPorts = Object.freeze({ tenantDirectory: factories.tenantDirectory(client), permits: createPlatformPermits() });
  const served = defineRoutes([...inventory.routes, ...reads.map((build) => build(readPorts))]).list();
  // The session boundaries' durable adapters, over the SAME kernel and the same classified endpoint
  // (M5-GIAM-D1-P2-R1, -P4). Built here, with the store, so a deployment can never hold one without the
  // others and never reaches a session or an admission through a client this composition did not
  // classify. The session root binds them; it reads no connection string of its own.
  return Object.freeze({
    idempotency: Object.freeze({ store: store.idempotency, keySecret: keySecret as Uint8Array }),
    transactions: Object.freeze({ port: store.transactions }),
    platformAdmission: factories.platformAdmission(client),
    sessionStore: factories.sessionStore(client, standing),
    tenantAdmission: factories.tenantAdmission(client),
    rateLimiter: (limiterKey: Uint8Array) => factories.rateLimiter(client, limiterKey),
    routes: served,
    preflight: factories.preflight === undefined ? null : factories.preflight(client),
    close: () => client.end(),
  });
}

/**
 * The production transaction boundary for the production inventory: configuration in, both ports or null out — or a refusal
 * naming every missing or refused part. Configuration is the one required input. `client` is the kernel's constructor over the
 * classified endpoint, defaulted to the production client (verified TLS over the sealed target); it is the deployable entry's
 * construction boundary (server/entry/productionEntry.ts), and no store, adapter, factory or inventory can be handed in.
 */
export function composeProductionTransactions(
  env: Readonly<Record<string, string | undefined>>,
  // Defaulted, not merely optional, so the configuration stays this root's one required argument (its arity is asserted).
  client: TransactionFactories['client'] = PRODUCTION_FACTORIES.client,
): ProductionTransactions | null {
  if (typeof client !== 'function') throw new TypeError('database client constructor invalid');
  const uncatalogued = uncataloguedRoutePermissions(productionRouteDeclarations());
  if (uncatalogued.length > 0) throw new TransactionCompositionError(uncatalogued);
  return assembleTransactions(PRODUCTION_INVENTORY, env, { ...PRODUCTION_FACTORIES, client });
}

/**
 * Ports that answer nothing, for building the inventory's read routes BEFORE any client exists — a definition is inert
 * until served, so its declared permission can be checked here and refused before anything is composed.
 */
const INERT_READ_PORTS: TenantDirectoryPorts = Object.freeze({
  tenantDirectory: Object.freeze({ page: (): never => { throw new Error('read port not composed'); } }),
  permits: () => false,
});

/**
 * Every route the production inventory would serve — its commands and its read routes — as declared, for the
 * permission check. Nothing is composed: the read routes are built over ports that answer nothing.
 */
export function productionRouteDeclarations(): readonly RouteDefinition[] {
  return Object.freeze([...PRODUCTION_INVENTORY.routes, ...(PRODUCTION_INVENTORY.reads ?? []).map((build) => build(INERT_READ_PORTS))]);
}
