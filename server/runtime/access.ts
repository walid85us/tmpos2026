// Phase 4.0 M3/M4 — the authentication and authorization steps of the shared chain, each bounded.
//
// The runtime may not import the identity modules (production-runtime contract), so the
// production authenticator plugs in at the composition boundary as a port, and no port ever
// receives the raw request or response:
//   - RequestAuthenticator.verify is handed a frozen, header-only credential view — exactly
//     `{ bearerToken }` — and the port deadline's AbortSignal. It cannot read, consume or mutate
//     the body stream, cannot touch a response, and sees no other header. The existing
//     identity-provider adapter is adapted to this port outside the runtime
//     (createRuntimeIdentityVerifier) and composed only by the provider-aware composition root
//     (server/composition).
//   - A principal is accepted only as a verified, IdentityKey-shaped value: `verified === true`,
//     a bounded provider token, and the provider's UID treated as opaque — any string of 1–128
//     UTF-16 code units (the identity provider's own UID contract) that is well-formed Unicode,
//     so its digest is one-to-one. Everything downstream receives a fresh frozen
//     { authProvider, authProviderUid } — never the email, scope or permission snapshot asserted
//     alongside it. The UID is never logged or rendered; where a storage key is needed it is
//     digested (sessions.ts: principalKeyOf).
//   - The verifier may also report provider-verified evidence of the authentication — when it
//     happened, and with which second factor — which a boundary's login policy judges
//     (sessions.ts). A malformed value is no evidence, and nothing the client asserts is.
//   - RouteAuthorizer is handed that principal, the route's declared requirement, a frozen route
//     view { method, path, audience } and the deadline signal. Only an exact `true` allows — or, from
//     an authorizer that resolved the principal to its app-owned actor (M5-GIAM-D1-P1), a
//     `{ granted: true, context }` whose context is a TrustedScope at exactly the requirement's scope
//     (principals.ts): the scope the canonical decision was made on, handed to the command so the
//     transaction revalidates and audits that same actor. Anything else denies.
// Before the authenticator runs, the request must carry exactly ONE Authorization line of the
// form `Bearer <b64token>` (RFC 6750) of bounded length, so absent, malformed, duplicated or
// oversized evidence is refused without ever reaching verifier code. Every port call is bounded
// by the port deadline (deadline.ts): a verdict — a rejected credential, a denied authorization
// — is a 401 / 403, while a port that throws or overruns is an outage (`authn_unavailable`,
// `authn_timeout`, `authz_unavailable`, `authz_timeout`), a bounded 503 and never a verdict. No
// port text ever leaves here.
import type { Request } from 'express';
import { outage, withDeadline } from './deadline.js';
import { isTrustedScope } from './principals.js';
import type { TrustedScope } from './principals.js';
import type { AuthorizationRequirement, SessionAudience, VerifiedPrincipal } from './routes.js';

/** The header-only credential view: the one field an authenticator needs, frozen. */
export interface BearerTokenView {
  readonly bearerToken: string;
}

export interface RequestAuthenticator {
  verify(tokenView: BearerTokenView, signal: AbortSignal): Promise<unknown>;
}

/** What an authorizer learns of the route: its method, literal path and session audience. */
export interface RouteView {
  readonly method: string;
  readonly path: string;
  readonly audience: SessionAudience | null;
}

export interface RouteAuthorizer {
  authorize(principal: VerifiedPrincipal, requirement: AuthorizationRequirement, route: RouteView, signal: AbortSignal): unknown;
}

/** Provider-verified evidence of the authentication itself; null wherever absent or malformed. */
export interface AuthenticationEvidence {
  /** When the identity authenticated at the provider, in epoch milliseconds. */
  readonly authenticatedAt: number | null;
  /** The provider-verified second factor the authentication used, e.g. `totp`. */
  readonly secondFactor: string | null;
}

export interface VerifiedIdentity {
  readonly principal: VerifiedPrincipal;
  readonly evidence: AuthenticationEvidence;
}

export type AccessRefusal =
  | 'authn_missing'
  | 'authn_contradictory'
  | 'authn_malformed'
  | 'authn_rejected'
  | 'authn_unavailable'
  | 'authn_timeout'
  | 'authz_denied'
  | 'authz_unavailable'
  | 'authz_timeout';

// RFC 6750 b64token; the scheme is case-insensitive (RFC 7235).
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;
const MAX_TOKEN_LENGTH = 4096;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// The identity provider's UID bound: any string of 1–128 characters (UTF-16 code units).
const MAX_UID_LENGTH = 128;
// A lone surrogate is not Unicode: it would encode to the same UTF-8 bytes (U+FFFD) as another,
// so two UIDs could share one digest. No provider issues one; it is refused as malformed.
const LONE_SURROGATE_RE = /\p{Cs}/u;
// A second factor is a short lowercase provider token, e.g. `totp` or `phone`.
const FACTOR_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** A fresh frozen principal when the provider is a bounded token and the UID a valid opaque one; else null. */
export function asPrincipal(authProvider: unknown, authProviderUid: unknown): VerifiedPrincipal | null {
  if (typeof authProvider !== 'string' || typeof authProviderUid !== 'string') return null;
  if (!PROVIDER_RE.test(authProvider) || authProviderUid.length === 0 || authProviderUid.length > MAX_UID_LENGTH
    || LONE_SURROGATE_RE.test(authProviderUid)) return null;
  return Object.freeze({ authProvider, authProviderUid });
}

function evidenceOf(authenticatedAt: unknown, secondFactor: unknown): AuthenticationEvidence {
  return Object.freeze({
    authenticatedAt: typeof authenticatedAt === 'number' && Number.isSafeInteger(authenticatedAt) && authenticatedAt > 0 ? authenticatedAt : null,
    secondFactor: typeof secondFactor === 'string' && FACTOR_RE.test(secondFactor) ? secondFactor : null,
  });
}

function toVerifiedIdentity(value: unknown): VerifiedIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  // Read once each: a replaceable verifier cannot validate one value and hand back another.
  const { verified, authProvider, authProviderUid, authenticatedAt, secondFactor } = value as Record<string, unknown>;
  const principal = verified === true ? asPrincipal(authProvider, authProviderUid) : null;
  return principal === null ? null : Object.freeze({ principal, evidence: evidenceOf(authenticatedAt, secondFactor) });
}

/** The verified identity, or the refusal code: a verdict for a 401, an outage for a 503. */
export async function authenticate(
  req: Request,
  authenticator: RequestAuthenticator,
  deadlineMs: number,
): Promise<VerifiedIdentity | AccessRefusal> {
  let lines = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'authorization') lines++;
  }
  if (lines === 0) return 'authn_missing';
  if (lines > 1) return 'authn_contradictory'; // Node keeps only the first line; never guess which was meant
  const match = BEARER_RE.exec(req.headers.authorization ?? '');
  if (match === null || match[1].length > MAX_TOKEN_LENGTH) return 'authn_malformed';
  const tokenView: BearerTokenView = Object.freeze({ bearerToken: match[1] });
  let verified: unknown;
  try {
    verified = await withDeadline(deadlineMs, (signal) => authenticator.verify(tokenView, signal));
  } catch (err) {
    return outage('authn', err);
  }
  return toVerifiedIdentity(verified) ?? 'authn_rejected';
}

/** An allowed request: the trusted scope its authorizer decided on, or null when the authorizer named none. */
export interface AuthorizedAccess {
  readonly context: TrustedScope | null;
}

const NO_CONTEXT: AuthorizedAccess = Object.freeze({ context: null });

/**
 * The trusted scope a granted decision carries, as a frozen copy with each field read once, or undefined
 * when the answer is not exactly `{ granted: true, context }` with a TrustedScope at `scope`.
 */
function grantedContextOf(decision: unknown, scope: AuthorizationRequirement['scope']): TrustedScope | undefined {
  if (typeof decision !== 'object' || decision === null || Object.getPrototypeOf(decision) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(decision);
  if (keys.length !== 2 || !keys.includes('granted') || !keys.includes('context')) return undefined;
  const { granted, context } = decision as Record<string, unknown>;
  if (granted !== true || typeof context !== 'object' || context === null) return undefined;
  // Each field read exactly once into a frozen copy; only the copy is checked and only the copy travels, so a
  // getter cannot answer one way to the check and another way to the command.
  const { actor, securityVersion, scope: selected, tenant, store, membershipId, roleId, limitation } = context as Record<string, unknown>;
  const copy = Object.freeze({ actor, securityVersion, scope: selected, tenant, store, membershipId, roleId, limitation });
  return isTrustedScope(copy) && copy.scope === scope ? copy : undefined;
}

/**
 * The allowed access when the authorizer returns exactly `true` (no context) or a granted decision with a
 * trusted scope at the requirement's own scope; else the refusal: a denial (403) or an outage (503).
 */
export async function authorize(
  authorizer: RouteAuthorizer,
  principal: VerifiedPrincipal,
  requirement: AuthorizationRequirement,
  route: RouteView,
  deadlineMs: number,
): Promise<AccessRefusal | AuthorizedAccess> {
  let decision: unknown;
  try {
    decision = await withDeadline(deadlineMs, (signal) => authorizer.authorize(principal, requirement, route, signal));
  } catch (err) {
    return outage('authz', err);
  }
  if (decision === true) return NO_CONTEXT;
  try {
    const context = grantedContextOf(decision, requirement.scope);
    return context === undefined ? 'authz_denied' : Object.freeze({ context });
  } catch {
    return 'authz_denied'; // a hostile answer is no grant
  }
}
