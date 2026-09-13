// Phase 4.0 M4/M6 — the provider-aware production composition root: the two session boundaries and
// the request limits they are served with.
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
//     believes, comma-separated, or the literal `none` when clients connect directly (never under
//     NODE_ENV=production, where the platform's proxies always sit in front). Trust is
//     never inferred: absent or empty refuses, and so does anything the trusted-proxy contract
//     rejects (clientAddress.ts: a universal or near-universal range, host bits, a zone, a
//     duplicate, more than 32 ranges). Behind a proxy, trusting none would put every client in
//     the proxy's one bucket;
//   - RATE_LIMIT_KEY: the keyed-hash secret that turns client addresses and account digests into
//     pseudonymous limiter keys — unpadded base64url of 32–64 random bytes from the secrets store,
//     the same on every instance. Absent or malformed refuses;
//   - the distributed limiter: the approved shared-store adapter below.
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
  /** Each boundary's own store: the two trust boundaries share no store (docs/phase-4/03 §1a). */
  readonly store: Readonly<Record<SessionAudience, SessionStore | null>>;
  readonly admission: Readonly<Record<SessionAudience, SessionAdmission | null>>;
  readonly authorizer: Readonly<Record<SessionAudience, RouteAuthorizer | null>>;
  /** The trusted proxies' exact CIDRs (empty: clients connect directly), or why they are refused. */
  readonly trustedProxies: readonly string[] | CompositionBlocker;
  /** The limiter's keyed-hash secret, or why it is refused. */
  readonly keySecret: Uint8Array | CompositionBlocker;
  /** The approved distributed limiter; null is a blocker, never a fallback. */
  readonly limiter: DistributedRateLimiter | null;
}

/** One composition: both boundaries and the limits they are served with (createApp's `sessions` and `limits`). */
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
const PRODUCTION_ADAPTERS: Pick<SessionParts, 'store' | 'admission' | 'authorizer' | 'limiter'> = Object.freeze({
  store: Object.freeze({ tenant: null, admin: null }),
  admission: Object.freeze({ tenant: null, admin: null }),
  authorizer: Object.freeze({ tenant: null, admin: null }),
  limiter: null,
});

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

/** The trusted proxies' exact CIDRs, or why the configuration is refused; `none` states a direct deployment. */
function trustedProxies(env: Readonly<Record<string, string | undefined>>): SessionParts['trustedProxies'] {
  const raw = env.TRUSTED_PROXY_CIDRS;
  if (typeof raw !== 'string' || raw === '') return 'trusted_proxies_missing';
  // `none` states a direct deployment; production always sits behind the platform's proxies.
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
 * refusal naming every missing dependency. Configuration is the only input; nothing else can be
 * injected.
 */
export function composeProductionSessions(env: Readonly<Record<string, string | undefined>>): ProductionSessions {
  let verifier: RequestAuthenticator | null = null;
  try {
    verifier = createRuntimeIdentityVerifier(env);
  } catch (err) {
    if (!(err instanceof IdentityCompositionError)) throw err;
  }
  return assembleSessions({
    origins: sessionOrigins(env), verifier, trustedProxies: trustedProxies(env), keySecret: rateLimitKey(env), ...PRODUCTION_ADAPTERS,
  });
}
