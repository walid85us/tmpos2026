// Phase 4.0 M4/M6 — the provider-aware production composition root: the two session boundaries
// and the request limits they are served with.
//
// The runtime (server/runtime) is provider-independent: it defines the ports and may import no
// identity provider, database or other adapter (tests/quality/production-runtime-contract). This
// module is the one place that binds production adapters to those ports. It takes configuration
// only — never an adapter, a store or a test double — and composes every boundary from:
//   - trusted origins: SESSION_TENANT_ORIGINS and SESSION_ADMIN_ORIGINS, each a comma-separated
//     list of exact https origins. The two boundaries may not share a host: a dedicated admin
//     hostname is mandatory (docs/phase-4/03 §2 #1, 09 M4), and cookies are scoped by host, so a
//     second port on one host is no separation. Missing, malformed or ambiguous configuration
//     refuses;
//   - the identity verifier: the existing Firebase adapter (createRuntimeIdentityVerifier), which
//     refuses without a valid service-account configuration;
//   - each boundary's own durable session store, admission and route authorizer: the PostgreSQL
//     adapters the transaction root builds and hands over (DurableSessionAdapters below; migrations
//     011 and 013). An absent adapter is a blocker — never a default, a fallback or an in-process
//     stand-in;
// and the request limits every protected route is served with (server/runtime/rateLimit.ts):
//   - TRUSTED_PROXY_CIDRS: the exact CIDRs of the proxies whose X-Forwarded-For the runtime
//     believes, comma-separated. Trust is never inferred: absent or empty refuses, and so does
//     anything the trusted-proxy contract rejects (clientAddress.ts: a universal or near-universal
//     range, host bits, a zone, a duplicate, more than 32 ranges). The literal `none` — clients
//     connect directly — is accepted only outside NODE_ENV=production, for development and test
//     compositions: production always sits behind the platform's proxies and refuses `none`
//     (`trusted_proxies_missing`), so it has no supported direct configuration. Behind a proxy,
//     trusting none would put every client in the proxy's one bucket;
//   - RATE_LIMIT_KEY: the keyed-hash secret that turns client addresses and account digests into
//     pseudonymous limiter keys — unpadded base64url of 32–64 random bytes from the secrets store,
//     the same on every instance. Absent or malformed refuses;
//   - the distributed limiter: the PostgreSQL adapter over migration 014 (M6-RATE-P2, ADR-26). The
//     transaction root builds it over its one kernel and hands over a binding; this root binds it to
//     the RATE_LIMIT_KEY bytes it parsed itself, so the keyring the runtime keys pseudonyms with and
//     the fingerprint the store checks every instance's key against are one key, never two.
// Durable idempotency and the command-transaction port — IDEMPOTENCY_KEY, APP_DATABASE_URL and the
// M6 PostgreSQL store — are not this root's: the transaction root (productionTransactions.ts) is
// their one production authority, and composes them only for a route that requires them.
// Composition is all or nothing: a refusal names every blocker (bounded codes, never
// configuration content), and nothing is composed while any blocker remains.
// Which boundaries (M6-ENTRY-P1). Both, unless the caller names fewer: the deployable entry
// (server/entry/productionEntry.ts) composes the administrative boundary alone — it serves no
// tenant or store route — so SESSION_TENANT_ORIGINS is then neither read nor required, and the
// tenant boundary's routes are never registered. The two hosts must still differ whenever both
// are composed, and when the tenant boundary is composed alone (the tenant entry,
// server/entry/tenantEntry.ts, M7A-CUSTOMERS-P2) SESSION_ADMIN_ORIGINS is required and read for that
// comparison only. The entry is also this root's construction boundary for the provider: it may hand
// the Firebase adapter the token verifier a disposable-database harness substitutes for the
// identity provider (tokenVerifier); production hands none, and the adapter verifies through the
// Firebase Admin SDK. Nothing in the configuration can select either.
import { IdentityCompositionError, createRuntimeIdentityVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import type { FirebaseIdTokenVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import type { RequestAuthenticator, RouteAuthorizer } from '../runtime/access.js';
import { parseTrustedProxies } from '../runtime/clientAddress.js';
import { parseRateLimitKey } from '../runtime/rateLimit.js';
import type { DistributedRateLimiter, RequestLimitDeps } from '../runtime/rateLimit.js';
import { normalizeOrigin } from '../runtime/requestSecurity.js';
import { EnforcementSetupError } from '../runtime/routes.js';
import type { SessionAudience } from '../runtime/routes.js';
import { sharesHost } from '../runtime/sessions.js';
import type { SessionAdmission, SessionBoundaryDeps, SessionDeps, SessionStore } from '../runtime/sessions.js';
import type { PlatformAdmissionPort, TenantAdmissionPort } from '../runtime/principals.js';
import { createAdmittedPlatformAuthorizer, createPlatformSessionAdmission } from './platformAuthorization.js';
import { createTenantRouteAuthorizer, createTenantSessionAdmission } from './tenantAuthorization.js';
import type { TenantRoleLevelsRead } from './tenantAuthorization.js';

export type CompositionBlocker =
  | 'session_origins_missing'
  | 'session_origins_invalid'
  | 'session_origins_ambiguous'
  | 'identity_verifier_unconfigured'
  | 'trusted_proxies_missing'
  | 'trusted_proxies_invalid'
  | 'rate_limit_key_missing'
  | 'rate_limit_key_invalid'
  | 'rate_limit_store_unavailable'
  | `${SessionAudience}_session_store_unavailable`
  | `${SessionAudience}_admission_unavailable`
  | `${SessionAudience}_authorizer_unavailable`;

/** Composition refusal: every blocker, as bounded codes only. */
export class ProductionCompositionError extends Error {
  readonly blockers: readonly CompositionBlocker[];

  constructor(blockers: readonly CompositionBlocker[]) {
    super(`production session composition refused: ${blockers.join(',')}`);
    this.name = 'ProductionCompositionError';
    this.blockers = Object.freeze([...blockers]);
  }
}

/** The parts one composition binds to the runtime's ports; a null or refused part is a blocker. */
export interface SessionParts {
  /** Each composed boundary's exact origins; a boundary not composed needs none. */
  readonly origins: Readonly<Partial<Record<SessionAudience, readonly string[]>>> | CompositionBlocker;
  readonly verifier: RequestAuthenticator | null;
  /**
   * The store each boundary is bound to. The two boundaries keep distinct cookies, origins and
   * audiences, and neither ever reads the other's record (sessions.ts refuses one stamped with
   * another audience) — but they are NOT given distinct stores today: the durable adapter is
   * audience-agnostic by the port's own contract, so both are bound to one instance over one table
   * and one runtime role. That residual is recorded as doc 08 DA-37, not hidden here.
   */
  readonly store: Readonly<Record<SessionAudience, SessionStore | null>>;
  readonly admission: Readonly<Record<SessionAudience, SessionAdmission | null>>;
  readonly authorizer: Readonly<Record<SessionAudience, RouteAuthorizer | null>>;
  /** The trusted proxies' exact CIDRs (empty: a direct, non-production deployment), or why they are refused. */
  readonly trustedProxies: readonly string[] | CompositionBlocker;
  /** The limiter's keyed-hash secret, or why it is refused. */
  readonly keySecret: Uint8Array | CompositionBlocker;
  /** The approved distributed limiter; null is a blocker, never a fallback. */
  readonly limiter: DistributedRateLimiter | null;
}

/** One composition: createApp's `sessions` and `limits`. */
export interface ProductionSessions {
  readonly sessions: SessionDeps;
  readonly limits: RequestLimitDeps;
}

const AUDIENCES: readonly SessionAudience[] = ['tenant', 'admin'];

// The adapter table when NO durable bundle is handed over: every slot null, so the composition refuses and
// names each one. The durable session store, the tenant boundary's admission and authorizer, the
// administrative boundary's admission and authorizer, and the distributed rate limiter are PostgreSQL
// adapters the TRANSACTION root builds over its one classified kernel (migrations 011, 013 and 014) and
// hands to this root (DurableSessionAdapters below); none exists without that root, and none has an
// in-process stand-in. The limiter is the one approved adapter of its port (M6-RATE-P2, ADR-26): it passes
// the port's conformance suite (assertRateLimiterContract) against real shared PostgreSQL state, and it is
// bound only to this root's own parsed RATE_LIMIT_KEY — with no bundle, or with the key refused, its slot
// stays null and `rate_limit_store_unavailable` stays a blocker. There is no per-process limiter to fall
// back to, and an unreachable or differently keyed store answers every consume unavailable and fails
// readiness rather than allowing. The durable idempotency store and the command-transaction port are not in
// this table: the transaction root composes both from the M6 PostgreSQL store, together, for a route that
// requires them. No root composes the outbox delivery store or a worker (M8).
const PRODUCTION_ADAPTERS: Pick<SessionParts, 'store' | 'admission' | 'authorizer' | 'limiter'> = Object.freeze({
  store: Object.freeze({ tenant: null, admin: null }),
  admission: Object.freeze({ tenant: null, admin: null }),
  authorizer: Object.freeze({ tenant: null, admin: null }),
  limiter: null,
});

/**
 * The durable adapters the TRANSACTION root builds over its one kernel (productionTransactions.ts), handed
 * to this root rather than rebuilt here (M5-GIAM-D1-P2-R1). This root still takes CONFIGURATION only: it
 * reads no connection string, opens nothing and classifies no endpoint — that root remains the single
 * production authority for the runtime database connection, so a deployment can never hold two clients
 * or two credentials for the same database.
 *
 * Omitting it leaves every adapter slot null and the composition refuses exactly as before, naming each
 * missing one. It is optional because a deployment whose inventory requires no transaction boundary has
 * no kernel to build these over, and must then refuse rather than invent one.
 */
export interface DurableSessionAdapters {
  /** The PostgreSQL session store. One store serves both boundaries; each row carries its own audience. */
  readonly store: SessionStore;
  /** The tenant boundary's PostgreSQL admission (migration 011). */
  readonly tenantAdmission: TenantAdmissionPort;
  /**
   * The administrative boundary's PostgreSQL admission (migration 013, M5-GIAM-D1-P4). It fills BOTH of that
   * boundary's slots: the admission decision over it, and the canonical platform authorizer that decides on the
   * scope that admission selected — the one cannot work without the other, so neither is bound alone. Absent,
   * both stay null and the composition names both.
   */
  readonly platformAdmission?: PlatformAdmissionPort;
  /**
   * The tenant routes EXPLICITLY classified as reads, as `${method} ${path}` — the only ones a read-only
   * actor may reach. Absent means none is, which is the closed default.
   */
  readonly tenantReads?: ReadonlySet<string>;
  /**
   * The owner's durable role edits over that same kernel (M7A-CUSTOMERS-P3-R1, migration 020): the tenant route authorizer
   * decides every tenant route permission on the selected role's current definition, so it is built only over this read.
   * Absent — the administrative entry, which composes no tenant boundary — the tenant authorizer slot stays null and a
   * composition of the tenant boundary names it.
   */
  readonly roleLevels?: TenantRoleLevelsRead;
  /**
   * The distributed rate limiter over that same kernel (migration 014, M6-RATE-P2), awaiting its key: called
   * with RATE_LIMIT_KEY's bytes, it answers the limiter bound to that key's fingerprint. This root calls it
   * with the key it parsed itself and nothing else. Absent, the limiter slot stays null and is named.
   */
  readonly rateLimiter?: (keySecret: Uint8Array) => DistributedRateLimiter;
}

/**
 * The adapter table for a composition handed the durable adapters: each boundary's slots are filled from them,
 * and a slot with no adapter stays null and is named as a blocker. Nothing here is a fallback. The limiter slot
 * is filled only from the bundle's own binding AND a key — `keySecret`, the bytes the caller also composes as
 * the limits' secret; with either absent it stays null. Exported so a disposable-database harness can compose
 * exactly this table with a synthetic identity verifier; it reads no configuration and builds nothing but these
 * decisions and the limiter the bundle's own binding makes from that key (which opens no connection).
 */
export function durableSessionAdapters(
  durable: DurableSessionAdapters,
  keySecret: Uint8Array | undefined = undefined,
): Pick<SessionParts, 'store' | 'admission' | 'authorizer' | 'limiter'> {
  const platform = durable.platformAdmission;
  const bindLimiter = durable.rateLimiter;
  if (bindLimiter !== undefined && typeof bindLimiter !== 'function') throw new TypeError('rate limiter binding invalid');
  const limiter = bindLimiter === undefined || keySecret === undefined ? null : bindLimiter(keySecret);
  return Object.freeze({
    store: Object.freeze({ tenant: durable.store, admin: durable.store }),
    admission: Object.freeze({
      tenant: createTenantSessionAdmission({ admission: durable.tenantAdmission }),
      admin: platform === undefined ? null : createPlatformSessionAdmission({ admission: platform }),
    }),
    authorizer: Object.freeze({
      tenant: durable.roleLevels === undefined
        ? null : createTenantRouteAuthorizer({ admission: durable.tenantAdmission, reads: durable.tenantReads, levels: durable.roleLevels }),
      admin: platform === undefined ? null : createAdmittedPlatformAuthorizer(),
    }),
    limiter,
  });
}

/** The configuration variable each boundary's origins are read from. */
const ORIGIN_VARIABLES: Readonly<Record<SessionAudience, string>> = Object.freeze({
  tenant: 'SESSION_TENANT_ORIGINS',
  admin: 'SESSION_ADMIN_ORIGINS',
});

/** Each composed boundary's exact https origins, or why the configuration is refused. A boundary not composed is not read. */
function sessionOrigins(env: Readonly<Record<string, string | undefined>>, audiences: readonly SessionAudience[]): SessionParts['origins'] {
  const raw = audiences.map((audience) => env[ORIGIN_VARIABLES[audience]]);
  if (raw.some((value) => typeof value !== 'string' || value === '')) return 'session_origins_missing';
  const origins: Partial<Record<SessionAudience, string[]>> = {};
  audiences.forEach((audience, i) => { origins[audience] = (raw[i] as string).split(','); });
  const all = audiences.flatMap((audience) => origins[audience] as string[]);
  // Exact canonical https origins only: the session cookies are Secure, so http cannot carry them.
  if (all.some((origin) => normalizeOrigin(origin) !== origin || !origin.startsWith('https://'))) return 'session_origins_invalid';
  if (new Set(all).size !== all.length) return 'session_origins_ambiguous';
  if (origins.tenant !== undefined && origins.admin !== undefined && sharesHost(origins.tenant, origins.admin)) return 'session_origins_ambiguous';
  // A tenant boundary composed WITHOUT the administrative one (the tenant entry) must still prove the hosts differ. It reads
  // SESSION_ADMIN_ORIGINS for that comparison alone and refuses without it. The administrative entry never reads the tenant's.
  if (origins.tenant !== undefined && origins.admin === undefined) {
    const admin = env.SESSION_ADMIN_ORIGINS;
    if (typeof admin !== 'string' || admin === '') return 'session_origins_missing';
    const adminOrigins = admin.split(',');
    if (adminOrigins.some((origin) => normalizeOrigin(origin) !== origin || !origin.startsWith('https://'))) return 'session_origins_invalid';
    if (sharesHost(origins.tenant, adminOrigins)) return 'session_origins_ambiguous';
  }
  const frozen: Partial<Record<SessionAudience, readonly string[]>> = {};
  for (const audience of audiences) frozen[audience] = Object.freeze(origins[audience] as string[]);
  return Object.freeze(frozen);
}

/** The trusted proxies' exact CIDRs, or why the configuration is refused; `none` is a non-production direct deployment. */
function trustedProxies(env: Readonly<Record<string, string | undefined>>): SessionParts['trustedProxies'] {
  const raw = env.TRUSTED_PROXY_CIDRS;
  if (typeof raw !== 'string' || raw === '') return 'trusted_proxies_missing';
  // `none` states a direct deployment, which production never is: it always sits behind the platform's proxies.
  if (raw === 'none' && env.NODE_ENV === 'production') return 'trusted_proxies_missing';
  const cidrs = raw === 'none' ? [] : raw.split(',');
  try {
    parseTrustedProxies(cidrs); // the runtime's own contract judges them (and again at startup)
  } catch (err) {
    if (err instanceof EnforcementSetupError) return 'trusted_proxies_invalid';
    throw err;
  }
  return Object.freeze(cidrs);
}

/** The limiter's keyed-hash secret, or why the configuration is refused. */
function rateLimitKey(env: Readonly<Record<string, string | undefined>>): SessionParts['keySecret'] {
  const raw = env.RATE_LIMIT_KEY;
  if (typeof raw !== 'string' || raw === '') return 'rate_limit_key_missing';
  return parseRateLimitKey(raw) ?? 'rate_limit_key_invalid';
}

/** The boundaries to compose: a non-empty list of distinct audiences, or the call is a defect. */
function audiencesOf(audiences: unknown): readonly SessionAudience[] {
  if (!Array.isArray(audiences) || audiences.length === 0 || new Set(audiences).size !== audiences.length
    || audiences.some((audience) => !AUDIENCES.includes(audience))) throw new TypeError('session audiences invalid');
  return Object.freeze([...audiences] as SessionAudience[]);
}

/**
 * Bind `parts` to the named boundaries (both unless fewer are named) and their limits, all or nothing:
 * every missing or refused part is named, and nothing is composed while any remains.
 */
export function assembleSessions(parts: SessionParts, audiences: readonly SessionAudience[] = AUDIENCES): ProductionSessions {
  const composed = audiencesOf(audiences);
  const { origins, verifier, store, admission, authorizer, trustedProxies: proxies, keySecret, limiter } = parts;
  const blockers: CompositionBlocker[] = [];
  if (typeof origins === 'string') blockers.push(origins);
  else if (composed.some((audience) => origins[audience] === undefined)) blockers.push('session_origins_missing');
  if (verifier === null) blockers.push('identity_verifier_unconfigured');
  if (typeof proxies === 'string') blockers.push(proxies);
  if (typeof keySecret === 'string') blockers.push(keySecret);
  if (limiter === null) blockers.push('rate_limit_store_unavailable');
  const boundaries: { [A in SessionAudience]?: SessionBoundaryDeps } = {};
  for (const audience of composed) {
    const sessions = store[audience];
    const admit = admission[audience];
    const authorize = authorizer[audience];
    const trustedOrigins = typeof origins === 'string' ? undefined : origins[audience];
    if (sessions === null) blockers.push(`${audience}_session_store_unavailable`);
    if (admit === null) blockers.push(`${audience}_admission_unavailable`);
    if (authorize === null) blockers.push(`${audience}_authorizer_unavailable`);
    if (trustedOrigins !== undefined && verifier !== null && sessions !== null && admit !== null && authorize !== null) {
      boundaries[audience] = { verifier, admission: admit, authorizer: authorize, store: sessions, trustedOrigins };
    }
  }
  if (blockers.length > 0) throw new ProductionCompositionError(blockers);
  return Object.freeze({
    sessions: Object.freeze(boundaries),
    limits: Object.freeze({
      limiter: limiter as DistributedRateLimiter,
      keySecret: keySecret as Uint8Array,
      trustedProxies: proxies as readonly string[],
    }),
  });
}

/**
 * The production composition: configuration in, both boundaries and their limits out — or a
 * refusal naming every missing dependency. Configuration is the only REQUIRED input. The one other
 * input is the durable adapter bundle the TRANSACTION root builds over its own classified endpoint
 * (productionTransactions.ts); it is typed, not opaque, so nothing but review stops a caller handing
 * this root a different bundle — which is why the composition that would pass it is the transaction
 * root alone, and why an adapter smuggled in through the configuration composes nothing.
 */
/**
 * How one composition is built beyond its configuration (M6-ENTRY-P1): which boundaries, and — for a disposable-database
 * harness only — the identity provider's token verifier the Firebase adapter verifies through. Production names the
 * boundaries it serves and hands no verifier.
 */
export interface SessionCompositionOptions {
  /** The boundaries composed; both unless named. One left out is neither configured nor required, and serves no route. */
  readonly audiences?: readonly SessionAudience[];
  /** The provider-side token verification the Firebase adapter delegates to; the Firebase Admin SDK's when absent. */
  readonly tokenVerifier?: FirebaseIdTokenVerifier;
}

export function composeProductionSessions(
  env: Readonly<Record<string, string | undefined>>,
  // Defaulted, not merely optional, so the CONFIGURATION remains this root's one required argument —
  // the guarantee productionSessions.test.ts asserts on this function's arity.
  durable: DurableSessionAdapters | undefined = undefined,
  options: SessionCompositionOptions = {},
): ProductionSessions {
  const audiences = audiencesOf(options.audiences ?? AUDIENCES);
  const { tokenVerifier } = options;
  if (tokenVerifier !== undefined && typeof tokenVerifier?.verify !== 'function') throw new TypeError('token verifier invalid');
  let verifier: RequestAuthenticator | null = null;
  try {
    // The adapter's own configuration check and verification path either way; only the provider call is substituted.
    verifier = createRuntimeIdentityVerifier(env, tokenVerifier === undefined ? {} : { verifier: tokenVerifier });
  } catch (err) {
    if (!(err instanceof IdentityCompositionError)) throw err;
  }
  // One parse of RATE_LIMIT_KEY feeds both the limits' secret and the limiter's binding: never two keys.
  const keySecret = rateLimitKey(env);
  const adapters = durable === undefined
    ? PRODUCTION_ADAPTERS
    : durableSessionAdapters(durable, typeof keySecret === 'string' ? undefined : keySecret);
  return assembleSessions({
    origins: sessionOrigins(env, audiences), verifier, trustedProxies: trustedProxies(env), keySecret, ...adapters,
  }, audiences);
}
