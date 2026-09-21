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
//   - each boundary's own durable session store, admission and route authorizer: the approved
//     production adapters below. None exists yet, and an absent adapter is a blocker — never a
//     default, a fallback or an in-process stand-in;
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
//   - the distributed limiter: the approved shared-store adapter below.
// Durable idempotency and the command-transaction port — IDEMPOTENCY_KEY, APP_DATABASE_URL and the
// M6 PostgreSQL store — are not this root's: the transaction root (productionTransactions.ts) is
// their one production authority, and composes them only for a route that requires them.
// Composition is all or nothing: a refusal names every blocker (bounded codes, never
// configuration content), and nothing is composed while any blocker remains. The deployable
// runtime entry (server/runtime/server.ts) serves the operational routes only; making this root
// the deployed entry is gated on the same blockers and on an owner-approved build of it.
import { IdentityCompositionError, createRuntimeIdentityVerifier } from '../platform-identity/firebaseAdminAuthAdapter.js';
import type { RequestAuthenticator, RouteAuthorizer } from '../runtime/access.js';
import { parseTrustedProxies } from '../runtime/clientAddress.js';
import { parseRateLimitKey } from '../runtime/rateLimit.js';
import type { DistributedRateLimiter, RequestLimitDeps } from '../runtime/rateLimit.js';
import { normalizeOrigin } from '../runtime/requestSecurity.js';
import { EnforcementSetupError } from '../runtime/routes.js';
import type { SessionAudience } from '../runtime/routes.js';
import { sharesHost } from '../runtime/sessions.js';
import type { SessionAdmission, SessionBoundaryDeps, SessionDeps, SessionStore } from '../runtime/sessions.js';
import type { TenantAdmissionPort } from '../runtime/principals.js';
import { createTenantRouteAuthorizer, createTenantSessionAdmission } from './tenantAuthorization.js';

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
  readonly origins: Readonly<Record<SessionAudience, readonly string[]>> | CompositionBlocker;
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

// The approved production adapters for the ports the identity verifier does not cover. None is
// approved yet:
//   - the durable, shared session store (docs/phase-4/03 §2 #18): no backing store is chosen, and
//     a Postgres-backed one needs a session schema (a new migration) and the non-owner runtime
//     database role that migration 005 introduces (G-DBROLE; migration 005 is unexecuted);
//   - admin admission and the M4→M5 interim admin authorizer (the pilot guard: system_owner by
//     exact equality, permission floor manage): the canonical platform authorization reads
//     through the owner database connection (G-DBROLE), and the pilot guard hard-denies in
//     production;
//   - tenant/store admission and authorization: the tenant plane (migration 005) and M5;
//   - the distributed rate limiter (G-IDEMPOT, M6): no repository decision approves a shared
//     backing store (docs/phase-4/02 §8 names one only as an example; every ADR is proposed), so
//     none is bound and there is no per-process limiter to fall back to. An adapter must pass the
//     port's conformance suite (assertRateLimiterContract) before it is approved here.
// The durable idempotency store and the command-transaction port are not in this table: the
// transaction root (productionTransactions.ts) composes both from the M6 PostgreSQL store, together,
// for a route that requires them. No root composes the outbox delivery store or a worker (M8).
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
   * The canonical platform route authorizer that root also builds — the ADMIN boundary's authorizer.
   * Supplying it removes one blocker; the admin boundary's own admission adapter still does not exist,
   * so that boundary, and therefore the whole composition, still refuses.
   */
  readonly adminAuthorizer?: RouteAuthorizer;
  /**
   * The tenant routes EXPLICITLY classified as reads, as `${method} ${path}` — the only ones a read-only
   * actor may reach. Absent means none is, which is the closed default.
   */
  readonly tenantReads?: ReadonlySet<string>;
}

/**
 * The adapter table for a composition handed the durable adapters: the tenant boundary's three slots are
 * filled from them, and the admin boundary keeps every slot it has no adapter for. Nothing here is a
 * fallback — an absent adapter stays null and is named as a blocker.
 */
function adaptersFrom(durable: DurableSessionAdapters): Pick<SessionParts, 'store' | 'admission' | 'authorizer' | 'limiter'> {
  return Object.freeze({
    store: Object.freeze({ tenant: durable.store, admin: durable.store }),
    admission: Object.freeze({
      tenant: createTenantSessionAdmission({ admission: durable.tenantAdmission }),
      admin: null,
    }),
    authorizer: Object.freeze({
      tenant: createTenantRouteAuthorizer({ admission: durable.tenantAdmission, reads: durable.tenantReads }),
      admin: durable.adminAuthorizer ?? null,
    }),
    limiter: null,
  });
}

/** Each boundary's exact https origins, or why the configuration is refused. */
function sessionOrigins(env: Readonly<Record<string, string | undefined>>): SessionParts['origins'] {
  const tenant = env.SESSION_TENANT_ORIGINS;
  const admin = env.SESSION_ADMIN_ORIGINS;
  if (typeof tenant !== 'string' || tenant === '' || typeof admin !== 'string' || admin === '') return 'session_origins_missing';
  const origins = { tenant: tenant.split(','), admin: admin.split(',') };
  const all = [...origins.tenant, ...origins.admin];
  // Exact canonical https origins only: the session cookies are Secure, so http cannot carry them.
  if (all.some((origin) => normalizeOrigin(origin) !== origin || !origin.startsWith('https://'))) return 'session_origins_invalid';
  if (new Set(all).size !== all.length || sharesHost(origins.tenant, origins.admin)) return 'session_origins_ambiguous';
  return Object.freeze({ tenant: Object.freeze(origins.tenant), admin: Object.freeze(origins.admin) });
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

/**
 * Bind `parts` to both boundaries and their limits, all or nothing: every missing or refused part
 * is named, and nothing is composed while any remains.
 */
export function assembleSessions(parts: SessionParts): ProductionSessions {
  const { origins, verifier, store, admission, authorizer, trustedProxies: proxies, keySecret, limiter } = parts;
  const blockers: CompositionBlocker[] = [];
  if (typeof origins === 'string') blockers.push(origins);
  if (verifier === null) blockers.push('identity_verifier_unconfigured');
  if (typeof proxies === 'string') blockers.push(proxies);
  if (typeof keySecret === 'string') blockers.push(keySecret);
  if (limiter === null) blockers.push('rate_limit_store_unavailable');
  const boundaries: { [A in SessionAudience]?: SessionBoundaryDeps } = {};
  for (const audience of AUDIENCES) {
    const sessions = store[audience];
    const admit = admission[audience];
    const authorize = authorizer[audience];
    if (sessions === null) blockers.push(`${audience}_session_store_unavailable`);
    if (admit === null) blockers.push(`${audience}_admission_unavailable`);
    if (authorize === null) blockers.push(`${audience}_authorizer_unavailable`);
    if (typeof origins !== 'string' && verifier !== null && sessions !== null && admit !== null && authorize !== null) {
      boundaries[audience] = { verifier, admission: admit, authorizer: authorize, store: sessions, trustedOrigins: origins[audience] };
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
export function composeProductionSessions(
  env: Readonly<Record<string, string | undefined>>,
  // Defaulted, not merely optional, so the CONFIGURATION remains this root's one required argument —
  // the guarantee productionSessions.test.ts asserts on this function's arity.
  durable: DurableSessionAdapters | undefined = undefined,
): ProductionSessions {
  let verifier: RequestAuthenticator | null = null;
  try {
    verifier = createRuntimeIdentityVerifier(env);
  } catch (err) {
    if (!(err instanceof IdentityCompositionError)) throw err;
  }
  const adapters = durable === undefined ? PRODUCTION_ADAPTERS : adaptersFrom(durable);
  return assembleSessions({
    origins: sessionOrigins(env), verifier, trustedProxies: trustedProxies(env), keySecret: rateLimitKey(env), ...adapters,
  });
}
