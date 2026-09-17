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
import { createPostgresTransactionalStore } from '../persistence/postgresTransactionalStore.js';
import type { AggregateMutator, TransactionalStore, TransactionalStoreOptions } from '../persistence/postgresTransactionalStore.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import type { CommandTransactionDeps } from '../runtime/commandTransaction.js';
import type { IdempotencyDeps } from '../runtime/idempotency.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { defineRoutes } from '../runtime/routes.js';
import type { RouteDefinition } from '../runtime/routes.js';

export type TransactionCompositionBlocker =
  | RuntimeDatabaseRefusal
  | 'database_tls_invalid'
  | 'idempotency_key_missing'
  | 'idempotency_key_invalid'
  | 'idempotency_key_shared'
  | 'command_mutator_unavailable';

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
  /** Ends the store's kernel: transactions in flight get RETIRED_POOL_GRACE_S, then every pool is closed. */
  readonly close: () => Promise<void>;
}

/** How the boundary is built: the client over a classified endpoint, then the store over that client. */
export interface TransactionFactories {
  readonly client: (endpoint: RuntimeDatabaseEndpoint) => SupervisedPgClient;
  readonly store: (options: TransactionalStoreOptions) => TransactionalStore;
}

// The production route inventory. No business route is roadmapped into it yet, so no route requires idempotency and nothing
// below is composed; the first real business route and its mutators are added here, and only here.
export const PRODUCTION_INVENTORY: TransactionInventory = Object.freeze({ routes: Object.freeze([]), mutators: Object.freeze([]) });

// The approved production factories: the runtime principal's kernel over the classified endpoint, and the M6 PostgreSQL store.
const PRODUCTION_FACTORIES: TransactionFactories = Object.freeze({ client: createRuntimeStoreClient, store: createPostgresTransactionalStore });

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
    store = factories.store({ client, mutators: inventory.mutators });
  } catch (err) {
    void client.end(); // nothing opened yet: the kernel connects only when a transaction runs
    throw err;
  }
  return Object.freeze({
    idempotency: Object.freeze({ store: store.idempotency, keySecret: keySecret as Uint8Array }),
    transactions: Object.freeze({ port: store.transactions }),
    close: () => client.end(),
  });
}

/**
 * The production transaction boundary for the production inventory: configuration in, both ports or null out — or a refusal
 * naming every missing or refused part. Configuration is the only input; no store, client or factory can be handed to it.
 */
export function composeProductionTransactions(env: Readonly<Record<string, string | undefined>>): ProductionTransactions | null {
  return assembleTransactions(PRODUCTION_INVENTORY, env, PRODUCTION_FACTORIES);
}
