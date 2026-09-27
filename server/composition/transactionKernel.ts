// M7A-CUSTOMERS-P2 — the transaction kernel both production roots share: the one production authority for the runtime
// database's configuration, the kernel built over it and every adapter both entries compose over that kernel.
//
// Two roots compose over it, each in its own executable:
//   - the administrative transaction root (productionTransactions.ts) — its command inventory, the store and the
//     administrative admission — for the administrative entry (server/entry/productionEntry.ts);
//   - the tenant transaction root (tenantTransactions.ts) — a read-only inventory, the customer directory — for the tenant
//     entry (server/entry/tenantEntry.ts), through composeReadTransactions below.
// This module names no route, mutator or administrative adapter, so the tenant executable ships none of them; each root
// hands in only its own inventory. It reads, and classifies before any client exists:
//   - APP_DATABASE_URL: the runtime principal's connection (platform-identity/databaseEndpoint.ts), classified here for both
//     roots — the one composition module that reads it; the kernel is built over the classified endpoint by the caller's
//     constructor, a TLS refusal mapped to a bounded code;
//   - TENANT_SESSION_ISSUER_KEY (the read-only path alone): the tenant entry's minting secret, which the database owner
//     installs in migration 018's tmpos_mint.issuer_key. The session store mints tenant sessions under it and the database
//     is asked only for its fingerprint (probeIssuerKey). It is never RATE_LIMIT_KEY and never a key HMAC would treat as the
//     recorded test vector, and a key of fewer than 16 distinct byte values is refused as guessable.
// A refusal names every blocker as a bounded code before any client exists — never configuration content.
import { APP_DATABASE_URL_VAR } from '../platform-identity/config.js';
import { classifyRuntimeDatabaseUrl } from '../platform-identity/databaseEndpoint.js';
import type { RuntimeDatabaseEndpoint, RuntimeDatabaseRefusal } from '../platform-identity/databaseEndpoint.js';
import { DatabaseTlsRefusal, createRuntimeStoreClient } from '../platform-identity/db.js';
import { canonicalPermission, isDecidablePermission } from '../platform-identity/m5CanonicalPermissions.js';
import { createPostgresRateLimiter, probeRateLimitKey } from '../persistence/postgresRateLimiter.js';
import type { RateLimitKeyStatus } from '../persistence/postgresRateLimiter.js';
import { createPostgresStartupPreflight } from '../persistence/postgresStartupPreflight.js';
import type { StartupPreflight } from '../persistence/postgresStartupPreflight.js';
import { createPostgresSessionStore, probeIssuerKey, probeSessionMint } from '../persistence/postgresSessionStore.js';
import type { IssuerKeyProbe, SessionStandingCheck } from '../persistence/postgresSessionStore.js';
import { createPostgresTenantAdmission, holdTenantStanding, readTenantAdmission } from '../persistence/postgresTenantAdmission.js';
import type { SupervisedPgClient } from '../persistence/supervisedPgClient.js';
import { parseKeyMaterial, sameKeyMaterial } from '../runtime/keyMaterial.js';
import { defineRoutes } from '../runtime/routes.js';
import type { RouteDefinition } from '../runtime/routes.js';
import type { TenantAdmissionPort } from '../runtime/principals.js';
import type { DistributedRateLimiter } from '../runtime/rateLimit.js';
import type { SessionStore } from '../runtime/sessions.js';
import { createTenantEstablishCheck, readKey } from './tenantAuthorization.js';

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
 * permission, and a catalogued key the catalog cannot DECIDE — every tenant- or store-scope key except the tenant route
 * permissions owner decision D1 fixed (view_customers, M7A-CUSTOMERS-P1; m5CanonicalPermissions.ts isDecidablePermission)
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

/** A read-only inventory (M7A-CUSTOMERS-P2): read routes over the kernel and nothing that writes — no key, store or port. */
export interface ReadInventory<P> {
  readonly reads: readonly ReadRouteFactory<P>[];
  /** The read ports, built once over the root's kernel. */
  readonly ports: (client: SupervisedPgClient) => P;
  /** Ports that answer nothing, for validating the declared table before any client exists. */
  readonly inert: P;
  /** The reads' readiness over the kernel: true only when they can be served. */
  readonly probe: (client: SupervisedPgClient, signal: AbortSignal) => Promise<boolean>;
}

/** What a read-only composition hands its entry: the tenant boundary's durable adapters, the served routes and probes. */
export interface ReadTransactions {
  /** The session store, minting tenant sessions under the issuer key; an administrative record's standing throws. */
  readonly sessionStore: SessionStore;
  readonly tenantAdmission: TenantAdmissionPort;
  /** The routes explicitly classified as reads, from the inventory's declaration: here, every one. */
  readonly tenantReads: ReadonlySet<string>;
  readonly rateLimiter: (keySecret: Uint8Array) => DistributedRateLimiter;
  readonly routes: readonly RouteDefinition[];
  readonly preflight: TransactionPreflight;
  /** Whether the database holds the issuer key: its fingerprint alone is sent, one of four words comes back. */
  readonly issuerKey: (signal: AbortSignal) => Promise<IssuerKeyProbe>;
  /** Whether the login can call 018's mint, which every login needs: true only for its answer to all-null arguments. */
  readonly mintProbe: (signal: AbortSignal) => Promise<boolean>;
  readonly readsProbe: (signal: AbortSignal) => Promise<boolean>;
  /** Ends the kernel: transactions in flight get RETIRED_POOL_GRACE_S, then every pool is closed. */
  readonly close: () => Promise<void>;
}

/**
 * The read-only composition over the kernel (M7A-CUSTOMERS-P2), for the tenant root alone: configuration and the kernel's
 * constructor in, the tenant boundary's adapters and `inventory`'s routes over one kernel out — or a refusal naming every
 * blocker before any client exists. A fault after the kernel is built ends it before rethrowing: the caller holds nothing
 * to close yet.
 */
export function composeReadTransactions<P>(
  inventory: ReadInventory<P>,
  env: Readonly<Record<string, string | undefined>>,
  client: KernelFactories['client'],
): ReadTransactions {
  if (typeof client !== 'function') throw new TypeError('database client constructor invalid');
  // The table, as declared over ports that answer nothing, is validated before any client exists; every route in it is a read.
  const declared = defineRoutes(inventory.reads.map((build) => build(inventory.inert))).list();
  const blockers: TransactionCompositionBlocker[] = [];
  const endpoint = runtimeEndpoint(env);
  if (typeof endpoint === 'string') blockers.push(endpoint);
  const issuerKey = parseTenantIssuerKey(env);
  if (typeof issuerKey === 'string') blockers.push(issuerKey);
  if (blockers.length > 0) throw new TransactionCompositionError(blockers);
  const key = issuerKey as Buffer;
  const kernel = kernelOver(client, endpoint as RuntimeDatabaseEndpoint);
  try {
    // The tenant login's standing check alone: an administrative record is a wiring fault here, a throw.
    const standing = createTenantEstablishCheck({ hold: holdTenantStanding, read: readTenantAdmission });
    const served = defineRoutes(inventory.reads.map((build) => build(inventory.ports(kernel)))).list();
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
      close: () => kernel.end(),
    });
  } catch (err) {
    void kernel.end(); // nothing opened yet: the kernel connects only when a transaction runs
    throw err;
  }
}
