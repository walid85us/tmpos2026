// M7A-CUSTOMERS-P2 — the transaction kernel both production roots share: the one production authority for the runtime
// database's configuration, the kernel built over it and every adapter both entries compose over that kernel.
//
// Two roots compose over it, each in its own executable:
//   - the administrative transaction root (productionTransactions.ts) — its command inventory, the store and the
//     administrative admission — for the administrative entry (server/entry/productionEntry.ts);
//   - the tenant transaction root (tenantTransactions.ts) — the customer directory's read and, since M7A-CUSTOMERS-P3, the
//     customer create in its write slot — for the tenant entry (server/entry/tenantEntry.ts), through composeReadTransactions.
// This module names no route, mutator or administrative adapter, so the tenant executable ships none of them; each root
// hands in only its own inventory. It reads, and classifies before any client exists:
//   - APP_DATABASE_URL: the runtime principal's connection (platform-identity/databaseEndpoint.ts), classified here for both
//     roots — the one composition module that reads it; the kernel is built over the classified endpoint by the caller's
//     constructor, a TLS refusal mapped to a bounded code;
//   - TENANT_SESSION_ISSUER_KEY (the tenant root alone): the tenant entry's minting secret, which the database owner
//     installs in migration 018's tmpos_mint.issuer_key. The session store mints tenant sessions under it and the database
//     is asked only for its fingerprint (probeIssuerKey). It is never RATE_LIMIT_KEY and never a key HMAC would treat as the
//     recorded test vector, and a key of fewer than 16 distinct byte values is refused as guessable;
//   - IDEMPOTENCY_KEY (the tenant root's write slot alone, M7A-CUSTOMERS-P3): the tenant process's own keyed-hash secret for
//     idempotency records (keyMaterial.ts), never RATE_LIMIT_KEY or the issuer key. Every tenant instance must hold the same
//     one, which no process can check (ADR-34); the administrative process holds its own under the same name.
// A refusal names every blocker as a bounded code before any client exists — never configuration content.
//
// M7A-CUSTOMERS-P3 UPDATE. The tenant root's write slot composes the M6 PostgreSQL store over the SAME kernel, scoped to
// tenant contexts (`contextScope: 'tenant'`) and re-proved in each command's transaction by the tenant revalidator
// (tenantAuthorization.ts createTenantContextRevalidator) over the session store's tenant reads and 016's hold and read. It
// hands back the idempotency store with its key and the command port — never a delivery port, and no event contract.
//
// M7A-CUSTOMERS-P3-R1 UPDATE. A tenant inventory also hands in the owner's durable role edits as two reads (RoleLevelReads):
// the kernel binds one to its client for the tenant route authorizer (ReadTransactions.roleLevels, which the entry passes to
// the session root) and composes the other into the tenant revalidator, with the recent-authentication check on the
// database's clock. The adapter behind both is the tenant root's, so this module names none and ships none to the
// administrative artifact.
import { APP_DATABASE_URL_VAR } from '../platform-identity/config.js';
import { classifyRuntimeDatabaseUrl } from '../platform-identity/databaseEndpoint.js';
import type { RuntimeDatabaseEndpoint, RuntimeDatabaseRefusal } from '../platform-identity/databaseEndpoint.js';
import { DatabaseTlsRefusal, createRuntimeStoreClient } from '../platform-identity/db.js';
import { canonicalPermission, isDecidablePermission } from '../platform-identity/m5CanonicalPermissions.js';
import { createPostgresRateLimiter, probeRateLimitKey } from '../persistence/postgresRateLimiter.js';
import type { RateLimitKeyStatus } from '../persistence/postgresRateLimiter.js';
import { createPostgresStartupPreflight } from '../persistence/postgresStartupPreflight.js';
import type { StartupPreflight } from '../persistence/postgresStartupPreflight.js';
import {
  authenticationFresh, createPostgresSessionStore, holdTenantSession, probeIssuerKey, probeSessionMint, readTenantSession,
} from '../persistence/postgresSessionStore.js';
import type { IssuerKeyProbe, SessionStandingCheck } from '../persistence/postgresSessionStore.js';
import { createPostgresTenantAdmission, holdTenantStanding, readTenantAdmission } from '../persistence/postgresTenantAdmission.js';
import type { PgTransactionScope, SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import { createPostgresTransactionalStore } from '../persistence/postgresTransactionalStore.js';
import type { AggregateMutator } from '../persistence/postgresTransactionalStore.js';
import type { CommandTransactionDeps } from '../runtime/commandTransaction.js';
import type { IdempotencyDeps } from '../runtime/idempotency.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { defineRoutes } from '../runtime/routes.js';
import type { RouteDefinition } from '../runtime/routes.js';
import type { TenantAdmissionPort } from '../runtime/principals.js';
import type { DistributedRateLimiter } from '../runtime/rateLimit.js';
import type { SessionStore } from '../runtime/sessions.js';
import { createTenantContextRevalidator, createTenantEstablishCheck, readKey } from './tenantAuthorization.js';
import type { TenantRoleLevelsHeld, TenantRoleLevelsRead } from './tenantAuthorization.js';

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
  | 'route_permission_undecidable'
  /** The inventory has read routes but no route that requires idempotency, so no kernel exists to serve them over. */
  | 'read_route_without_boundary'
  | TenantIssuerKeyRefusal;

/** Why TENANT_SESSION_ISSUER_KEY is refused. */
export type TenantIssuerKeyRefusal =
  | 'tenant_issuer_key_missing'
  | 'tenant_issuer_key_invalid'
  | 'tenant_issuer_key_shared'
  | 'tenant_issuer_key_weak';

/** Composition refusal: every blocker, as bounded codes only. */
export class TransactionCompositionError extends Error {
  readonly blockers: readonly TransactionCompositionBlocker[];

  constructor(blockers: readonly TransactionCompositionBlocker[]) {
    super(`production transaction composition refused: ${blockers.join(',')}`);
    this.name = 'TransactionCompositionError';
    this.blockers = Object.freeze([...blockers]);
  }
}

/** The startup preflight over the kernel, with the limiter key's boot check over the same kernel (postgresRateLimiter.ts). */
export interface TransactionPreflight extends StartupPreflight {
  /** m6_rate_limit_probe's answer for `keySecret` — registering its fingerprint when none is registered. */
  rateLimitKey(keySecret: Uint8Array, signal: AbortSignal): Promise<RateLimitKeyStatus>;
}

/** How the kernel and the adapters both roots compose over it are built. */
export interface KernelFactories {
  readonly client: (endpoint: RuntimeDatabaseEndpoint) => SupervisedPgClient;
  /**
   * The session store over the kernel, with the login's standing check (M5-ADMIN-REVOKE-P1, M5-TENANT-SESSION-P1) — which
   * the root builds once and a factory must forward: a store built without it establishes no session — and, for the tenant
   * root alone, the issuer key it mints tenant sessions under (M7A-CUSTOMERS-P2). The administrative root passes none.
   */
  readonly sessionStore: (client: SupervisedPgClient, standing: SessionStandingCheck, issuerKey?: Uint8Array) => SessionStore;
  readonly tenantAdmission: (client: SupervisedPgClient) => TenantAdmissionPort;
  /** The distributed rate limiter over migration 014, bound to a RATE_LIMIT_KEY. */
  readonly rateLimiter: (client: SupervisedPgClient, keySecret: Uint8Array) => DistributedRateLimiter;
  /** The deployable entry's startup preflight over the kernel; a harness composing no entry may leave it out. */
  readonly preflight?: (client: SupervisedPgClient) => TransactionPreflight;
}

// The approved production factories: the runtime principal's kernel over the classified endpoint, and the adapters over it.
export const KERNEL_FACTORIES: Required<KernelFactories> = Object.freeze({
  client: createRuntimeStoreClient,
  sessionStore: (client: SupervisedPgClient, standing: SessionStandingCheck, issuerKey?: Uint8Array) =>
    createPostgresSessionStore({ client, standing, ...(issuerKey === undefined ? {} : { issuerKey }) }),
  tenantAdmission: (client: SupervisedPgClient) => createPostgresTenantAdmission({ client }),
  rateLimiter: (client: SupervisedPgClient, keySecret: Uint8Array) => createPostgresRateLimiter({ client, keySecret }),
  preflight: (client: SupervisedPgClient): TransactionPreflight => Object.freeze({
    ...createPostgresStartupPreflight({ client }),
    rateLimitKey: (keySecret: Uint8Array, signal: AbortSignal) => probeRateLimitKey(client, keySecret, signal),
  }),
});

/** APP_DATABASE_URL classified (platform-identity/databaseEndpoint.ts): the endpoint, or why it is refused. */
export function runtimeEndpoint(env: Readonly<Record<string, string | undefined>>): RuntimeDatabaseEndpoint | RuntimeDatabaseRefusal {
  return classifyRuntimeDatabaseUrl(env[APP_DATABASE_URL_VAR]);
}

/** The kernel over a classified endpoint, through `client`: a TLS configuration the client refuses is a bounded blocker. */
export function kernelOver(client: KernelFactories['client'], endpoint: RuntimeDatabaseEndpoint): SupervisedPgClient {
  try {
    return client(endpoint);
  } catch (err) {
    if (err instanceof DatabaseTlsRefusal) throw new TransactionCompositionError(['database_tls_invalid']);
    throw err;
  }
}

/**
 * The blockers a route inventory earns for the permissions it declares (M5-ID-P1; docs/phase-4/04
 * §2-§3, 03 §6). Every permission a DEPLOYED route requires must be one canonical catalog entry,
 * matched exactly and case-sensitively: a key the catalog does not define is a typo or an invented
 * permission, and a catalogued key the catalog cannot DECIDE — every tenant- or store-scope key except the route
 * permissions owner decisions fixed (the tenant ones since view_customers, M7A-CUSTOMERS-P1, and the two store draft keys,
 * M7B-INVOICES-P1, which a route may declare only on a store template — routes.ts refuses a store-scope requirement anywhere
 * else, so defineRoutes below throws for such a route before any key is judged; m5CanonicalPermissions.ts isDecidablePermission)
 * — is undecidable until D1 defines a specific route and its authoritative product rules (M5-GAP11-P5). Either way the
 * deployment refuses to start rather than denying at run time
 * — or, worse, allowing on a comparison whose meaning has not been settled.
 *
 * It is exported, and applied to each PRODUCTION inventory rather than inside the assembly, so
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
    else if (!isDecidablePermission(requirement.scope, requirement.permission)) blockers.push('route_permission_undecidable');
  }
  return blockers;
}

/** The recorded test-vector key (M7A-CUSTOMERS-P2 design B §4): bytes 0x00..0x1f, published with its proofs. */
const TEST_VECTOR_ISSUER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
/** Below this many distinct byte values a key is guessable whatever its length: a repeated byte, a zero-padded short key. */
const ISSUER_KEY_MIN_DISTINCT_BYTES = 16;

/**
 * TENANT_SESSION_ISSUER_KEY as bytes, or why it is refused: absent; not canonical base64url of 32–64 bytes (keyMaterial.ts);
 * the same HMAC key as RATE_LIMIT_KEY, however padded; or weak — the recorded test vector (as HMAC sees it) or fewer than
 * 16 distinct byte values. A fresh 32-byte CSPRNG key has about 30. Pure: the value never leaves as anything but the bytes.
 */
export function parseTenantIssuerKey(env: Readonly<Record<string, string | undefined>>): Buffer | TenantIssuerKeyRefusal {
  const raw = env.TENANT_SESSION_ISSUER_KEY;
  if (raw === undefined || raw === '') return 'tenant_issuer_key_missing';
  const key = parseKeyMaterial(raw);
  if (key === null) return 'tenant_issuer_key_invalid';
  const limiterKey = parseKeyMaterial(env.RATE_LIMIT_KEY);
  if (limiterKey !== null && sameKeyMaterial(key, limiterKey)) return 'tenant_issuer_key_shared';
  if (sameKeyMaterial(key, TEST_VECTOR_ISSUER_KEY) || new Set(key).size < ISSUER_KEY_MIN_DISTINCT_BYTES) return 'tenant_issuer_key_weak';
  return key;
}

/** A read route over the kernel: its factory, built by the root once the ports exist. Building it runs nothing. */
export type ReadRouteFactory<P> = (ports: P) => RouteDefinition;

/** The tenant root's command routes and the mutator each commits through (M7A-CUSTOMERS-P3): trusted source. */
export interface WriteInventory {
  readonly routes: readonly RouteDefinition[];
  readonly mutators: readonly AggregateMutator[];
}

/**
 * The owner's durable role edits (M7A-CUSTOMERS-P3-R1, migration 020), read two ways, handed in by the tenant root that owns
 * the adapter so this shared module — and the administrative artifact it ships in — names no role-level module: on the
 * kernel's own client for the tenant route authorizer, and on the committing transaction for the command revalidator.
 */
export interface RoleLevelReads {
  readonly read: (client: SupervisedPgClient) => TenantRoleLevelsRead;
  readonly held: TenantRoleLevelsHeld<PgTransactionScope>;
}

/**
 * A tenant inventory: read routes over the kernel (M7A-CUSTOMERS-P2) and, in its write slot (M7A-CUSTOMERS-P3), command
 * routes committed through the tenant store. Without a write slot it is read-only — no key, store or port, as before.
 * Since M7A-CUSTOMERS-P3-R1 it also carries the role-level reads every tenant route decision needs.
 */
export interface ReadInventory<P> {
  readonly reads: readonly ReadRouteFactory<P>[];
  /** The command routes and their mutators; absent, nothing is written. Never a read: no read-only actor reaches one. */
  readonly writes?: WriteInventory;
  /** The read ports, built once over the root's kernel. */
  readonly ports: (client: SupervisedPgClient) => P;
  /** Ports that answer nothing, for validating the declared table before any client exists. */
  readonly inert: P;
  /** The reads' readiness over the kernel: true only when they can be served. */
  readonly probe: (client: SupervisedPgClient, signal: AbortSignal) => Promise<boolean>;
  /** The selected role's durable edits (M7A-CUSTOMERS-P3-R1): the authorizer's read and the revalidator's. */
  readonly roleLevels: RoleLevelReads;
}

/** What the tenant composition hands its entry: the tenant boundary's durable adapters, the served routes and probes. */
export interface ReadTransactions {
  /** The session store, minting tenant sessions under the issuer key; an administrative record's standing throws. */
  readonly sessionStore: SessionStore;
  readonly tenantAdmission: TenantAdmissionPort;
  /** The routes explicitly classified as reads, from the inventory's `reads` alone: never a route of its write slot. */
  readonly tenantReads: ReadonlySet<string>;
  readonly rateLimiter: (keySecret: Uint8Array) => DistributedRateLimiter;
  readonly routes: readonly RouteDefinition[];
  readonly preflight: TransactionPreflight;
  /** Whether the database holds the issuer key: its fingerprint alone is sent, one of four words comes back. */
  readonly issuerKey: (signal: AbortSignal) => Promise<IssuerKeyProbe>;
  /** Whether the login can call 018's mint, which every login needs: true only for its answer to all-null arguments. */
  readonly mintProbe: (signal: AbortSignal) => Promise<boolean>;
  readonly readsProbe: (signal: AbortSignal) => Promise<boolean>;
  /** The selected role's durable edits over the kernel, for the tenant route authorizer (M7A-CUSTOMERS-P3-R1). */
  readonly roleLevels: TenantRoleLevelsRead;
  /** Ends the kernel: transactions in flight get RETIRED_POOL_GRACE_S, then every pool is closed. */
  readonly close: () => Promise<void>;
  /** createApp's `idempotency` and `transactions`, together, only for an inventory with a write slot (M7A-CUSTOMERS-P3). */
  readonly idempotency?: IdempotencyDeps;
  readonly transactions?: CommandTransactionDeps;
}

/**
 * The tenant composition over the kernel (M7A-CUSTOMERS-P2), for the tenant root alone: configuration and the kernel's
 * constructor in, the tenant boundary's adapters and `inventory`'s routes over one kernel out — and, for a write slot
 * (M7A-CUSTOMERS-P3), the tenant store's idempotency and command ports over that same kernel — or a refusal naming every
 * blocker before any client exists. A fault after the kernel is built ends it before rethrowing: the caller holds nothing
 * to close yet.
 */
export function composeReadTransactions<P>(
  inventory: ReadInventory<P>,
  env: Readonly<Record<string, string | undefined>>,
  client: KernelFactories['client'],
): ReadTransactions {
  if (typeof client !== 'function') throw new TypeError('database client constructor invalid');
  // The whole table, as declared over ports that answer nothing, is validated before any client exists: its reads, then
  // its write slot's commands, one table — so a command can never shadow a read or register twice.
  const declared = inventory.reads.map((build) => build(inventory.inert));
  const writes = inventory.writes;
  defineRoutes([...declared, ...(writes?.routes ?? [])]);
  const blockers: TransactionCompositionBlocker[] = [];
  const endpoint = runtimeEndpoint(env);
  if (typeof endpoint === 'string') blockers.push(endpoint);
  const issuerKey = parseTenantIssuerKey(env);
  if (typeof issuerKey === 'string') blockers.push(issuerKey);
  // A write slot requires this process's own idempotency key — present, canonical and never RATE_LIMIT_KEY or the issuer
  // key — and each command route committing through exactly one mutator of its contract's kind, mode and aggregate type:
  // the administrative root's rules (productionTransactions.ts), applied to the tenant root's commands.
  // ponytail: copied from assembleTransactions, which stays byte-identical; share one helper when a third root appears.
  const rawKey = writes === undefined ? undefined : env.IDEMPOTENCY_KEY;
  const keySecret = rawKey === undefined || rawKey === '' ? null : parseKeyMaterial(rawKey);
  if (writes !== undefined) {
    if (rawKey === undefined || rawKey === '') blockers.push('idempotency_key_missing');
    else if (keySecret === null) blockers.push('idempotency_key_invalid');
    else {
      const limiterKey = parseKeyMaterial(env.RATE_LIMIT_KEY);
      if ((limiterKey !== null && sameKeyMaterial(keySecret, limiterKey)) || (typeof issuerKey !== 'string' && sameKeyMaterial(keySecret, issuerKey))) {
        blockers.push('idempotency_key_shared');
      }
    }
    const commands = writes.routes.flatMap((route) => (route.idempotency === 'required' && 'command' in route ? [route.command.contract] : []));
    if (commands.length !== writes.routes.length || commands.some((contract) => {
      const matching = writes.mutators.filter((mutator) => mutator.kind === contract.kind);
      return matching.length !== 1 || matching[0].mode !== contract.mode || matching[0].aggregateType !== contract.aggregateType;
    })) blockers.push('command_mutator_unavailable');
  }
  if (blockers.length > 0) throw new TransactionCompositionError(blockers);
  const key = issuerKey as Buffer;
  const kernel = kernelOver(client, endpoint as RuntimeDatabaseEndpoint);
  try {
    // The tenant login's standing check alone: an administrative record is a wiring fault here, a throw.
    const standing = createTenantEstablishCheck({ hold: holdTenantStanding, read: readTenantAdmission });
    const served = defineRoutes([...inventory.reads.map((build) => build(inventory.ports(kernel))), ...(writes?.routes ?? [])]).list();
    // The write slot's store over the SAME kernel, admitting tenant contexts alone, each re-proved inside its command's
    // transaction: the presenting tenant session held and the actor's standing held and re-read (ADR-34 lock order).
    // M7A-CUSTOMERS-P3-R1: the permission is re-decided on the role's current definition read on that transaction, and a
    // recent-authentication deadline judged on the database's clock.
    const store = writes === undefined ? null : createPostgresTransactionalStore({
      client: kernel, mutators: writes.mutators, contextScope: 'tenant',
      revalidate: createTenantContextRevalidator<PgTransactionScope>({
        hold: holdTenantStanding, read: readTenantAdmission,
        peek: (sql, sessionKey) => readTenantSession(sql, sessionKey, Date.now()),
        session: (sql, sessionKey) => holdTenantSession(sql, sessionKey, Date.now()),
        levels: inventory.roleLevels.held,
        fresh: authenticationFresh,
      }),
    });
    return Object.freeze({
      sessionStore: KERNEL_FACTORIES.sessionStore(kernel, standing, key),
      tenantAdmission: KERNEL_FACTORIES.tenantAdmission(kernel),
      tenantReads: new Set(declared.map((route) => readKey(route.method, route.path))),
      rateLimiter: (limiterKey: Uint8Array) => KERNEL_FACTORIES.rateLimiter(kernel, limiterKey),
      routes: Object.freeze(served),
      preflight: KERNEL_FACTORIES.preflight(kernel),
      issuerKey: (signal: AbortSignal) => probeIssuerKey(kernel, key, signal),
      mintProbe: (signal: AbortSignal) => probeSessionMint(kernel, signal),
      readsProbe: (signal: AbortSignal) => inventory.probe(kernel, signal),
      roleLevels: inventory.roleLevels.read(kernel),
      close: () => kernel.end(),
      ...(store === null ? {} : {
        idempotency: Object.freeze({ store: store.idempotency, keySecret: keySecret as Uint8Array }),
        transactions: Object.freeze({ port: store.transactions }),
      }),
    });
  } catch (err) {
    void kernel.end(); // nothing opened yet: the kernel connects only when a transaction runs
    throw err;
  }
}
