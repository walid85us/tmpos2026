// Phase 4.0 M6-PG-P7-R1 — the production transaction boundary: durable idempotency and the command-transaction port, composed
// from the M6 PostgreSQL store (server/persistence) only for a route that requires them.
//
// One authority. This is the one production module that composes the store, its transaction kernel and IDEMPOTENCY_KEY; the
// sessions root (productionSessions.ts) composes the session boundaries and the request limits, and nothing else. It is driven
// by the production route inventory below, validated by the runtime's own route table (defineRoutes):
//   - no route declares `idempotency: 'required'` — today's inventory is empty — so nothing is read, built or probed: not
//     APP_DATABASE_URL, not IDEMPOTENCY_KEY, no client, kernel, store or readiness probe. The answer is null, and createApp keeps
//     serving the probes and the bounded fallback exactly as before;
//   - at least one does, so the runtime database configuration and the idempotency key are required and validated first; only
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
// What crosses. The composition hands back the two ports, the key and `close` — never the kernel, a pool, the driver, a statement
// function, the URL or its credential. createApp probes both ports, each the store's read-only probe routine under the established
// readiness deadline and sharing, only because they are composed. `close` ends the kernel within its bounded grace
// (RETIRED_POOL_GRACE_S); the entry that composes this runs it as a shutdown hook.
import { APP_DATABASE_URL_VAR } from '../platform-identity/config.js';
import { classifyRuntimeDatabaseUrl } from '../platform-identity/databaseEndpoint.js';
import type { RuntimeDatabaseEndpoint, RuntimeDatabaseRefusal } from '../platform-identity/databaseEndpoint.js';
import { DatabaseTlsRefusal, createRuntimeStoreClient } from '../platform-identity/db.js';
import { canonicalPermission } from '../platform-identity/m5CanonicalPermissions.js';
import { createPostgresPrincipalResolver, revalidateTrustedScope } from '../persistence/postgresPrincipalResolver.js';
import { createPostgresTransactionalStore } from '../persistence/postgresTransactionalStore.js';
import type { AggregateMutator, TransactionalStore, TransactionalStoreOptions } from '../persistence/postgresTransactionalStore.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { CommandTransactionDeps } from '../runtime/commandTransaction.js';
import type { IdempotencyDeps } from '../runtime/idempotency.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { defineRoutes } from '../runtime/routes.js';
import type { RouteDefinition } from '../runtime/routes.js';
import type { PrincipalResolutionPort } from '../runtime/principals.js';

export type TransactionCompositionBlocker =
  | RuntimeDatabaseRefusal
  | 'database_tls_invalid'
  | 'idempotency_key_missing'
  | 'idempotency_key_invalid'
  | 'idempotency_key_shared'
  | 'command_mutator_unavailable'
  /** A route requires a permission no canonical catalog entry defines, at its declared scope. */
  | 'route_permission_uncatalogued'
  /** A route requires a tenant- or store-scope permission, which GAP-11 leaves undecidable. */
  | 'route_permission_undecidable';

/** Composition refusal: every blocker, as bounded codes only. */
export class TransactionCompositionError extends Error {
  readonly blockers: readonly TransactionCompositionBlocker[];

  constructor(blockers: readonly TransactionCompositionBlocker[]) {
    super(`production transaction composition refused: ${blockers.join(',')}`);
    this.name = 'TransactionCompositionError';
    this.blockers = Object.freeze([...blockers]);
  }
}

/** The routes a deployment serves beyond the probes, and the mutator each command kind commits through: trusted source. */
export interface TransactionInventory {
  readonly routes: readonly RouteDefinition[];
  readonly mutators: readonly AggregateMutator[];
}

/** createApp's `idempotency` and `transactions`, always together, and the kernel's shutdown. */
export interface ProductionTransactions {
  readonly idempotency: IdempotencyDeps;
  readonly transactions: CommandTransactionDeps;
  /** The trusted principal resolver over the same kernel (M5-ID-P1), for the chain that resolves an actor. */
  readonly principals: PrincipalResolutionPort;
  /** Ends the store's kernel: transactions in flight get RETIRED_POOL_GRACE_S, then every pool is closed. */
  readonly close: () => Promise<void>;
}

/** How the boundary is built: the client over a classified endpoint, then the store over that client. */
export interface TransactionFactories {
  readonly client: (endpoint: RuntimeDatabaseEndpoint) => SupervisedPgClient;
  readonly store: (options: TransactionalStoreOptions) => TransactionalStore;
  readonly principals: (client: SupervisedPgClient) => PrincipalResolutionPort;
}

// The production route inventory. No business route is roadmapped into it yet, so no route requires idempotency and nothing
// below is composed; the first real business route and its mutators are added here, and only here.
export const PRODUCTION_INVENTORY: TransactionInventory = Object.freeze({ routes: Object.freeze([]), mutators: Object.freeze([]) });

// The approved production factories: the runtime principal's kernel over the classified endpoint, and the M6 PostgreSQL store.
const PRODUCTION_FACTORIES: TransactionFactories = Object.freeze({
  client: createRuntimeStoreClient,
  store: createPostgresTransactionalStore,
  principals: (client: SupervisedPgClient) => createPostgresPrincipalResolver({ client }),
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
  const routes = defineRoutes(inventory.routes).list();
  const required = routes.filter((route) => route.idempotency === 'required');
  if (required.length === 0) return null;

  const blockers: TransactionCompositionBlocker[] = [];
  const endpoint = classifyRuntimeDatabaseUrl(env[APP_DATABASE_URL_VAR]);
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
    return matching.length !== 1 || matching[0].mode !== contract.mode || matching[0].aggregateType !== contract.aggregateType;
  })) blockers.push('command_mutator_unavailable');
  if (blockers.length > 0) throw new TransactionCompositionError(blockers);

  let client: SupervisedPgClient;
  try {
    client = factories.client(endpoint as RuntimeDatabaseEndpoint);
  } catch (err) {
    if (err instanceof DatabaseTlsRefusal) throw new TransactionCompositionError(['database_tls_invalid']);
    throw err;
  }
  let store: TransactionalStore;
  try {
    // The revalidator the store runs inside each command transaction, over the same client and the
    // same governed endpoint: one credential, one boundary, no second connection.
    store = factories.store({ client, mutators: inventory.mutators, revalidate: revalidateTrustedScope });
  } catch (err) {
    void client.end(); // nothing opened yet: the kernel connects only when a transaction runs
    throw err;
  }
  return Object.freeze({
    idempotency: Object.freeze({ store: store.idempotency, keySecret: keySecret as Uint8Array }),
    transactions: Object.freeze({ port: store.transactions }),
    // The trusted principal resolver over the SAME kernel. It is built here, with the store, so a
    // deployment can never hold one without the other, and never resolves an identity through a client
    // this composition did not classify.
    principals: factories.principals(client),
    close: () => client.end(),
  });
}

/**
 * The production transaction boundary for the production inventory: configuration in, both ports or null out — or a refusal
 * naming every missing or refused part. Configuration is the only input; no store, client or factory can be handed to it.
 */
export function composeProductionTransactions(env: Readonly<Record<string, string | undefined>>): ProductionTransactions | null {
  const uncatalogued = uncataloguedRoutePermissions(PRODUCTION_INVENTORY.routes);
  if (uncatalogued.length > 0) throw new TransactionCompositionError(uncatalogued);
  return assembleTransactions(PRODUCTION_INVENTORY, env, PRODUCTION_FACTORIES);
}

/**
 * The blockers a route inventory earns for the permissions it declares (M5-ID-P1; docs/phase-4/04
 * §2-§3, 03 §6). Every permission a DEPLOYED route requires must be one canonical catalog entry,
 * matched exactly and case-sensitively: a key the catalog does not define is a typo or an invented
 * permission, and a tenant- or store-scope key is undecidable until owner decision D1 defines a specific
 * route and its authoritative product rules (M5-GAP11-P5). Either way the deployment refuses to start rather than denying at run time
 * — or, worse, allowing on a comparison whose meaning has not been settled.
 *
 * It is exported, and applied to the PRODUCTION inventory rather than inside assembleTransactions, so
 * a conformance harness may still drive the boundary with a synthetic route while every route that
 * could actually be served is checked. Empty means every declared permission is canonical.
 */
export function uncataloguedRoutePermissions(routes: readonly RouteDefinition[]): TransactionCompositionBlocker[] {
  const blockers: TransactionCompositionBlocker[] = [];
  for (const route of defineRoutes(routes).list()) {
    const requirement = route.policy.access === 'authenticated' || route.policy.access === 'session'
      ? route.policy.authorization : null;
    if (requirement === null) continue;
    if (canonicalPermission(requirement.scope, requirement.permission) === null) blockers.push('route_permission_uncatalogued');
    else if (requirement.scope !== 'platform') blockers.push('route_permission_undecidable');
  }
  return blockers;
}
