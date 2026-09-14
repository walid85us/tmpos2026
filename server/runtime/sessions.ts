// Phase 4.0 M4 — the two server session boundaries: tenant/store (/api/v1) and administrative
// (/admin/v1), with their lifecycle.
//
// Each boundary is composed from its own ports — an identity verifier, an admission policy, a
// route authorizer and a session store — plus its own trusted origins, and owns its own cookie,
// audience, login policy and endpoints (routes.ts: sessionPaths). Its login limits are spent by
// the chain on the runtime's distributed limiter, in the boundary's own login namespace (app.ts,
// rateLimit.ts). A missing or malformed port fails startup closed; no port has a default or a
// fallback. The two boundaries may not share an origin host: a distinct
// admin origin is mandatory (docs/phase-4/03 §2 #1, 09 M4), and cookies are scoped by host, not
// port. The runtime cannot tell a durable store from any other and does not try: the in-memory
// store is test support outside the deployable artifact, and only the provider-aware
// composition root (server/composition) binds production ports. The boundaries share no cookie,
// identifier, origin or session record: a session records its audience, and one boundary never
// reads the other's cookie or accepts its identifier — no replay across boundaries, no promotion.
//
// Session identifiers are 256-bit random values (base64url, 43 characters). The store holds
// only their SHA-256 digest, so a store read never yields a usable cookie. The identifier lives
// only in its cookie: `__Host-` prefixed (host-locked, Path=/, no Domain), Secure, HttpOnly,
// SameSite=Strict, with Max-Age equal to the server's absolute lifetime; Path=/ is the narrowest
// path the `__Host-` prefix permits. It is never read from a URL, a parameter or a body. A record
// also holds its principal's digest (principalKeyOf — the UID is never a key) and the security
// version its admission reported.
//
// Lifetimes. A session ends at its absolute lifetime and after its idle timeout. The idle window
// slides ONLY when an authorized session route (one that declares a requirement) answers 2xx:
// the current-session read (passive polling), logout, a refused or failed request and the
// operational probes never slide it. Admission is asked again once a session's last decision is
// older than its boundary's interval (ADMISSION_REVALIDATE_MS: admin 1 min, tenant 5 min). A
// denial — there, or at login — revokes every session of the principal in that boundary
// (revokePrincipal); a changed security version revokes the presented session, since one issued
// after the change carries the new version. Either is a 401, and the reason records a revocation
// that failed. An unavailable admission fails closed (503) and revokes nothing. Logout skips the
// re-check: revoking is always allowed. A record that is unknown, malformed, inconsistent, dated
// beyond the clock-skew allowance into the future, of the other audience, or expired is refused.
//
// Login. The chain (app.ts) spends the client limit, verifies the credential, applies the
// boundary's evidence policy (LOGIN_POLICIES: the administrative login needs a provider-verified
// second factor and an authentication at most five minutes old; the tenant login needs neither),
// and only then spends the account limit keyed by the principal's digest — so a verified
// credential the policy refuses spends no account budget and cannot lock the account's owner out.
// The login handler then asks admission and issues the session. Login never adopts a presented identifier: it
// always issues a fresh one, and revokes a well-formed session presented to it (rotation, so
// fixation cannot plant a session). Logout revokes the session and clears its cookie with
// matching attributes; only the logout handler holds that capability, never a business handler.
//
// Every port call is bounded by the port deadline and handed its AbortSignal (deadline.ts). A
// denial is a 401; an unavailable or overrunning store or admission is a 503 — nothing is issued
// or read; a logout whose revocation failed still clears the cookie (a shared terminal must not
// keep the session) but answers 503, never a success.
//
// Session CSRF is a synchronizer token derived from the session itself: HMAC-SHA256 keyed by the
// session identifier over a fixed per-audience label. It rotates with the session, differs per
// audience, reveals nothing of the identifier, needs no storage, and is compared in fixed time.
// The chain checks it on every unsafe session request after the session authenticates and before
// authorization — on top of the pre-session origin/intent check against the boundary's own
// origins (requestSecurity.ts), never instead of it.
//
// No identifier, digest, UID, CSRF token or port error is logged or echoed: refusals carry
// bounded reason codes to the log only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { asPrincipal } from './access.js';
import type { AuthenticationEvidence, RequestAuthenticator, RouteAuthorizer } from './access.js';
import { outage, withDeadline } from './deadline.js';
import { parseTrustedOrigins } from './requestSecurity.js';
import { EnforcementSetupError, sessionPaths } from './routes.js';
import type { RouteContext, RouteDefinition, SessionAudience, SessionContext, VerifiedPrincipal } from './routes.js';

export const SESSION_COOKIES: Readonly<Record<SessionAudience, string>> = Object.freeze({
  tenant: '__Host-tmpos_tenant_session',
  admin: '__Host-tmpos_admin_session',
});

/** Source-defined lifetimes; the administrative session is the shorter-lived, higher-privilege one. */
export const SESSION_TTL: Readonly<Record<SessionAudience, { readonly absoluteMs: number; readonly idleMs: number }>> = Object.freeze({
  tenant: Object.freeze({ absoluteMs: 8 * 60 * 60_000, idleMs: 30 * 60_000 }),
  admin: Object.freeze({ absoluteMs: 60 * 60_000, idleMs: 15 * 60_000 }),
});

/** How long an admission decision stands before the session's next request asks again: admin is tighter. */
export const ADMISSION_REVALIDATE_MS: Readonly<Record<SessionAudience, number>> = Object.freeze({
  tenant: 5 * 60_000,
  admin: 60_000,
});

export interface LoginPolicy {
  /** The provider-verified second factors a login may present; null when none is required. */
  readonly secondFactors: readonly string[] | null;
  /** The oldest provider authentication a login may present; null when no recency is required. */
  readonly maxAuthAgeMs: number | null;
}

/** Each boundary's own login evidence policy (docs/phase-4/03 §2 #9: MFA for the admin login). */
export const LOGIN_POLICIES: Readonly<Record<SessionAudience, LoginPolicy>> = Object.freeze({
  tenant: Object.freeze({ secondFactors: null, maxAuthAgeMs: null }),
  // TOTP only: phone MFA needs reCAPTCHA script hosts outside the admin CSP, so the console never offers it.
  admin: Object.freeze({ secondFactors: Object.freeze(['totp']), maxAuthAgeMs: 5 * 60_000 }),
});

/** The header carrying the session-bound CSRF token on an unsafe session request. */
export const SESSION_CSRF_HEADER = 'x-tmpos-session-csrf';

// Instances sharing a store, or a provider and this server, may disagree slightly on the time;
// a value dated no further ahead than this is not taken as tampered.
const MAX_CLOCK_SKEW_MS = 5_000;

/** What the store keeps per session, keyed by the identifier's digest — never the identifier. */
export interface SessionRecord {
  readonly audience: SessionAudience;
  readonly authProvider: string;
  readonly authProviderUid: string;
  /** principalKeyOf(the principal): the key per-principal revocation finds its sessions by. */
  readonly principalKey: string;
  /** The security version admission reported when it last admitted this session. */
  readonly securityVersion: string;
  readonly createdAt: number;
  /** The last activity: slid only by a successful authorized request. */
  readonly lastSeenAt: number;
  /** The last admission decision. */
  readonly validatedAt: number;
}

/** The only fields an update may change, one at a time. */
export type SessionUpdate = Readonly<{ lastSeenAt: number }> | Readonly<{ validatedAt: number }>;

/**
 * The replaceable storage boundary. Every operation is handed the port deadline's AbortSignal and
 * may return a Promise; a throw, a rejection or an overrun is "unavailable" and fails closed. A
 * production store must be durable and shared across instances (docs/phase-4/03 §2 #18), expire
 * each record at its absolute lifetime, and meet the store contract (memorySessionStore.testkit.ts:
 * assertSessionStoreContract): `update` changes an existing record only — never recreating an
 * absent or revoked one — and `revokePrincipal` ends every session of one principal in one
 * audience and nothing else.
 */
export interface SessionStore {
  create(key: string, record: SessionRecord, signal: AbortSignal): unknown;
  get(key: string, signal: AbortSignal): unknown;
  update(key: string, fields: SessionUpdate, signal: AbortSignal): unknown;
  revoke(key: string, signal: AbortSignal): unknown;
  revokePrincipal(audience: SessionAudience, principalKey: string, signal: AbortSignal): unknown;
}

/**
 * A boundary's admission policy. Only `{ admitted: true, securityVersion }` admits, the version a
 * printable token of at most 128 characters that changes whenever the principal's standing
 * changes (the revocation witness a session is re-checked against). Any other value is a denial;
 * a throw or an overrun is an outage.
 */
export interface SessionAdmission {
  admit(principal: VerifiedPrincipal, audience: SessionAudience, signal: AbortSignal): unknown;
}

export interface SessionBoundaryDeps {
  verifier: RequestAuthenticator;
  admission: SessionAdmission;
  authorizer: RouteAuthorizer;
  store: SessionStore;
  /** The exact origins this boundary's login, logout and session writes may come from; never another boundary's host. */
  trustedOrigins: readonly string[];
}

export interface SessionDeps {
  tenant?: SessionBoundaryDeps;
  admin?: SessionBoundaryDeps;
}

export type SessionRefusal =
  | 'session_missing'
  | 'session_cookie_duplicate'
  | 'session_cookie_malformed'
  | 'session_unknown'
  | 'session_record_invalid'
  | 'session_wrong_audience'
  | 'session_expired'
  | 'session_idle_expired'
  | 'session_admission_denied'
  | 'session_admission_denied_unrevoked'
  | 'session_version_mismatch'
  | 'session_version_mismatch_unrevoked'
  | 'session_unavailable'
  | 'session_timeout'
  | 'admission_unavailable'
  | 'admission_timeout';

export type LoginEvidenceRefusal =
  | 'login_mfa_missing'
  | 'login_mfa_unsupported'
  | 'login_auth_time_missing'
  | 'login_auth_time_future'
  | 'login_auth_stale';

export interface ActiveSession {
  readonly principal: VerifiedPrincipal;
  readonly context: SessionContext;
  /** The record's key (the identifier's digest) and last activity: what an idle refresh needs. */
  readonly key: string;
  readonly lastSeenAt: number;
}

export interface SessionBoundary {
  readonly audience: SessionAudience;
  readonly routes: readonly RouteDefinition[];
  readonly trustedOrigins: ReadonlySet<string>;
  readonly verifier: RequestAuthenticator;
  readonly authorizer: RouteAuthorizer;
  /** The Set-Cookie line clearing this boundary's cookie, with the attributes it is issued with. */
  readonly clearingCookie: string;
  /** Why this boundary's login policy refuses `evidence`, or null when it satisfies it. */
  loginEvidence(evidence: AuthenticationEvidence): LoginEvidenceRefusal | null;
  /**
   * The live session named by this boundary's cookie in `cookieHeader`, or why there is none.
   * With `revalidate`, an admission decision older than the boundary's interval is asked again.
   */
  authenticate(cookieHeader: string | undefined, revalidate: boolean): Promise<ActiveSession | SessionRefusal>;
  /** Slide the session's idle window to now: only after a successful authorized request. */
  refresh(session: ActiveSession): Promise<void>;
}

// The revocation of each live session context, reachable only by the logout handler below:
// a business handler holding ctx.session cannot end the session.
const REVOKERS = new WeakMap<SessionContext, () => Promise<void>>();

// 32 random bytes in base64url: the shape of every session identifier and CSRF token.
const OPAQUE_RE = /^[A-Za-z0-9_-]{43}$/;
// An admission security version: 1–128 printable ASCII characters, no space.
const VERSION_RE = /^[\x21-\x7e]{1,128}$/;

const digestOf = (id: string): string => createHash('sha256').update(id).digest('base64url');
const csrfTokenOf = (id: string, audience: SessionAudience): string =>
  createHmac('sha256', id).update(`tmpos-session-csrf:v1:${audience}`).digest('base64url');

/**
 * The storage-safe key of a principal: SHA-256 over its provider and UID. asPrincipal guarantees
 * the provider is a newline-free token and the UID well-formed Unicode, so distinct principals
 * never share a key — and the UID itself is never a key, an index or a log field.
 */
export function principalKeyOf(principal: VerifiedPrincipal): string {
  return createHash('sha256').update(`${principal.authProvider}\n${principal.authProviderUid}`).digest('base64url');
}

/** Whether two origin lists share a host: cookies are scoped by host, never by scheme or port. */
export function sharesHost(a: Iterable<string>, b: Iterable<string>): boolean {
  // A trailing dot spells the same host as an absolute name, so it is no separation either.
  const hostOf = (origin: string): string => new URL(origin).hostname.replace(/\.$/, '');
  const hosts = new Set([...a].map(hostOf));
  return [...b].some((origin) => hosts.has(hostOf(origin)));
}

const cookieHeader = (name: string, value: string, maxAgeSeconds: number): string =>
  `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;

type CookieRead = { readonly id: string } | 'session_missing' | 'session_cookie_duplicate' | 'session_cookie_malformed';

/** This boundary's one session identifier in the Cookie header (Node joins repeated lines). */
function readSessionCookie(header: string | undefined, name: string): CookieRead {
  let value: string | undefined;
  let count = 0;
  for (const pair of (header ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    count++;
    value = pair.slice(eq + 1).trim();
  }
  if (count === 0) return 'session_missing';
  if (count > 1) return 'session_cookie_duplicate'; // never guess which one was meant
  return value !== undefined && OPAQUE_RE.test(value) ? { id: value } : 'session_cookie_malformed';
}

interface LiveRecord {
  readonly principal: VerifiedPrincipal;
  readonly lastSeenAt: number;
  readonly validatedAt: number;
  readonly securityVersion: string;
}

/** The record's principal and state while its session is live for `audience`, or why it is not. */
function liveSession(raw: unknown, audience: SessionAudience, now: number): LiveRecord | SessionRefusal {
  if (raw === undefined || raw === null) return 'session_unknown';
  if (typeof raw !== 'object') return 'session_record_invalid';
  // Read once each: a replaceable store cannot validate one value and hand back another.
  const {
    audience: owner, authProvider, authProviderUid, principalKey, securityVersion, createdAt, lastSeenAt, validatedAt,
  } = raw as Record<string, unknown>;
  const principal = asPrincipal(authProvider, authProviderUid);
  // A stamp is no earlier than the record's creation and no later than now plus the skew allowance.
  const stamped = (t: unknown, since: number): t is number => typeof t === 'number' && since <= t && t <= now + MAX_CLOCK_SKEW_MS;
  if (principal === null || principalKey !== principalKeyOf(principal) || typeof securityVersion !== 'string'
    || !VERSION_RE.test(securityVersion) || typeof createdAt !== 'number'
    || !stamped(lastSeenAt, createdAt) || !stamped(validatedAt, createdAt)) return 'session_record_invalid';
  if (owner !== audience) return 'session_wrong_audience';
  const { absoluteMs, idleMs } = SESSION_TTL[audience];
  if (now - createdAt >= absoluteMs) return 'session_expired';
  if (now - lastSeenAt >= idleMs) return 'session_idle_expired';
  return { principal, lastSeenAt, validatedAt, securityVersion };
}

// A per-boundary limiter is no port: a stale composition that passes one is refused as unknown.
const PORTS: readonly string[] = ['verifier', 'admission', 'authorizer', 'store', 'trustedOrigins'];
const STORE_OPERATIONS = ['create', 'get', 'update', 'revoke', 'revokePrincipal'] as const;
const NO_BODY = Object.freeze({ kind: 'none' } as const);

const hasMethod = (v: unknown, name: string): boolean =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)[name] === 'function';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The bounded 503 of a runtime-owned session handler; the reason goes to the log only. */
function unavailable(res: Response, ctx: RouteContext, reason: string): void {
  (res.locals as Record<string, unknown>).refusal = reason;
  res.status(503).json({ error: 'service_unavailable', requestId: ctx.requestId });
}

/** The login handler's 401 for a denied admission: exactly the chain's bad-credential refusal. */
function challenged(res: Response, ctx: RouteContext, reason: string): void {
  (res.locals as Record<string, unknown>).refusal = reason;
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.status(401).json({ error: 'unauthenticated', requestId: ctx.requestId });
}

type AdmissionDecision = { readonly securityVersion: string } | 'admission_denied' | 'admission_unavailable' | 'admission_timeout';

function createBoundary(audience: SessionAudience, raw: unknown, now: () => number, deadlineMs: number): SessionBoundary {
  if (!isPlainObject(raw) || !Object.keys(raw).every((key) => PORTS.includes(key))) {
    throw new EnforcementSetupError('session_boundary_invalid');
  }
  const { verifier, admission, authorizer, store, trustedOrigins } = raw;
  if (!hasMethod(verifier, 'verify')) throw new EnforcementSetupError('session_verifier_required');
  if (!hasMethod(admission, 'admit')) throw new EnforcementSetupError('session_admission_required');
  if (!STORE_OPERATIONS.every((op) => hasMethod(store, op))) throw new EnforcementSetupError('session_store_required');
  if (!hasMethod(authorizer, 'authorize')) throw new EnforcementSetupError('session_authorizer_required');
  if (!Array.isArray(trustedOrigins) || trustedOrigins.length === 0) throw new EnforcementSetupError('trusted_origins_required');
  const origins = parseTrustedOrigins(trustedOrigins); // a non-canonical entry fails startup
  const sessions = store as SessionStore;
  const admitter = admission as SessionAdmission;
  const policy = LOGIN_POLICIES[audience];
  const cookieName = SESSION_COOKIES[audience];
  const maxAgeSeconds = SESSION_TTL[audience].absoluteMs / 1000;
  const paths = sessionPaths(audience);
  const call = (op: (signal: AbortSignal) => unknown): Promise<unknown> => withDeadline(deadlineMs, op);
  // Whether a revocation took effect: the refusal it follows stands either way, and its reason says which.
  const revoked = (op: (signal: AbortSignal) => unknown): Promise<boolean> => call(op).then(() => true, () => false);
  const revokeAllOf = (principal: VerifiedPrincipal): Promise<boolean> =>
    revoked((signal) => sessions.revokePrincipal(audience, principalKeyOf(principal), signal));

  const contextOf = (id: string, key: string): SessionContext => {
    const context: SessionContext = Object.freeze({ audience, csrfToken: csrfTokenOf(id, audience) });
    REVOKERS.set(context, async () => { await call((signal) => sessions.revoke(key, signal)); });
    return context;
  };

  /** Admission's decision: the security version it admits at, or why it did not admit. */
  async function admissionOf(principal: VerifiedPrincipal): Promise<AdmissionDecision> {
    let decision: unknown;
    try {
      decision = await call((signal) => admitter.admit(principal, audience, signal));
    } catch (err) {
      return outage('admission', err);
    }
    if (typeof decision !== 'object' || decision === null) return 'admission_denied';
    // Read once each, as with a store record.
    const { admitted, securityVersion } = decision as Record<string, unknown>;
    return admitted === true && typeof securityVersion === 'string' && VERSION_RE.test(securityVersion)
      ? Object.freeze({ securityVersion })
      : 'admission_denied';
  }

  function loginEvidence(evidence: AuthenticationEvidence): LoginEvidenceRefusal | null {
    if (policy.secondFactors !== null) {
      if (evidence.secondFactor === null) return 'login_mfa_missing';
      if (!policy.secondFactors.includes(evidence.secondFactor)) return 'login_mfa_unsupported';
    }
    if (policy.maxAuthAgeMs !== null) {
      const t = now();
      if (evidence.authenticatedAt === null) return 'login_auth_time_missing';
      if (evidence.authenticatedAt > t + MAX_CLOCK_SKEW_MS) return 'login_auth_time_future';
      if (t - evidence.authenticatedAt > policy.maxAuthAgeMs) return 'login_auth_stale';
    }
    return null;
  }

  async function authenticate(header: string | undefined, revalidate: boolean): Promise<ActiveSession | SessionRefusal> {
    const read = readSessionCookie(header, cookieName);
    if (typeof read === 'string') return read;
    const key = digestOf(read.id);
    const t = now();
    let live: LiveRecord | SessionRefusal;
    try {
      live = liveSession(await call((signal) => sessions.get(key, signal)), audience, t);
    } catch (err) {
      return outage('session', err);
    }
    if (typeof live === 'string') return live;
    if (revalidate && t - live.validatedAt >= ADMISSION_REVALIDATE_MS[audience]) {
      const decision = await admissionOf(live.principal);
      if (decision === 'admission_unavailable' || decision === 'admission_timeout') return decision; // fail closed; revoke nothing
      if (decision === 'admission_denied') {
        // The principal is no longer admitted here: every one of its sessions in this boundary ends.
        return (await revokeAllOf(live.principal)) ? 'session_admission_denied' : 'session_admission_denied_unrevoked';
      }
      if (decision.securityVersion !== live.securityVersion) {
        // This session only: one issued since the change already carries the new version.
        return (await revoked((signal) => sessions.revoke(key, signal))) ? 'session_version_mismatch' : 'session_version_mismatch_unrevoked';
      }
      try {
        await call((signal) => sessions.update(key, { validatedAt: t }, signal));
      } catch (err) {
        return outage('session', err);
      }
    }
    return Object.freeze({ principal: live.principal, context: contextOf(read.id, key), key, lastSeenAt: live.lastSeenAt });
  }

  async function refresh(session: ActiveSession): Promise<void> {
    // Never backwards: instances sharing a store may disagree slightly on the time.
    await call((signal) => sessions.update(session.key, { lastSeenAt: Math.max(now(), session.lastSeenAt) }, signal));
  }

  const active = (res: Response, csrfToken: string): void => { res.status(200).json({ status: 'active', csrfToken }); };

  // Reached only once the chain's login steps have all passed: ctx.principal is verified and its
  // evidence meets this boundary's policy. Admission decides, then the session is issued.
  const login = async (req: Request, res: Response, ctx: RouteContext): Promise<void> => {
    const principal = ctx.principal as VerifiedPrincipal;
    const decision = await admissionOf(principal);
    if (decision === 'admission_denied') {
      // A principal admission refuses keeps no session here either; the refusal reads as a bad credential.
      return challenged(res, ctx, (await revokeAllOf(principal)) ? 'login_admission_denied' : 'login_admission_denied_unrevoked');
    }
    if (typeof decision === 'string') return unavailable(res, ctx, decision);
    const presented = readSessionCookie(req.headers.cookie, cookieName);
    const presentedKey = typeof presented === 'string' ? null : digestOf(presented.id);
    const id = randomBytes(32).toString('base64url');
    const t = now();
    const record: SessionRecord = Object.freeze({
      audience, authProvider: principal.authProvider, authProviderUid: principal.authProviderUid,
      principalKey: principalKeyOf(principal), securityVersion: decision.securityVersion,
      createdAt: t, lastSeenAt: t, validatedAt: t,
    });
    try {
      // Rotation: a well-formed session presented at login never outlives it.
      if (presentedKey !== null) await call((signal) => sessions.revoke(presentedKey, signal));
      await call((signal) => sessions.create(digestOf(id), record, signal));
    } catch (err) {
      return unavailable(res, ctx, outage('session', err));
    }
    res.setHeader('Set-Cookie', cookieHeader(cookieName, id, maxAgeSeconds));
    active(res, csrfTokenOf(id, audience));
  };

  const current = (_req: Request, res: Response, ctx: RouteContext): void => {
    active(res, (ctx.session as SessionContext).csrfToken);
  };

  const logout = async (_req: Request, res: Response, ctx: RouteContext): Promise<void> => {
    let failure: string | null = null;
    try {
      // The chain authenticated ctx.session, so its revoker exists; were it missing, the call throws: a 503.
      await (REVOKERS.get(ctx.session as SessionContext) as () => Promise<void>)();
    } catch (err) {
      failure = outage('session', err);
    }
    // Cleared either way, so a shared terminal never keeps the session; the 503 still reports
    // that the server-side revocation did not happen (the record then lapses at its idle timeout).
    res.setHeader('Set-Cookie', cookieHeader(cookieName, '', 0));
    if (failure !== null) return unavailable(res, ctx, failure);
    res.status(204).end();
  };

  const routes: RouteDefinition[] = [
    { method: 'POST', path: paths.login, policy: { access: 'login', audience }, body: NO_BODY, idempotency: 'none', handler: login },
    { method: 'GET', path: paths.current, policy: { access: 'session', audience, authorization: null }, body: NO_BODY, idempotency: 'none', handler: current },
    { method: 'POST', path: paths.logout, policy: { access: 'session', audience, authorization: null }, body: NO_BODY, idempotency: 'none', handler: logout },
  ];
  return Object.freeze({
    audience,
    routes: Object.freeze(routes),
    trustedOrigins: origins,
    verifier: verifier as RequestAuthenticator,
    authorizer: authorizer as RouteAuthorizer,
    clearingCookie: cookieHeader(cookieName, '', 0),
    loginEvidence,
    authenticate,
    refresh,
  });
}

/** Validate and build every composed boundary; startup fails closed on anything malformed. */
export function createSessionBoundaries(
  raw: unknown,
  options: { now: () => number; deadlineMs: number },
): Partial<Record<SessionAudience, SessionBoundary>> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw) || !Object.keys(raw).every((key) => key === 'tenant' || key === 'admin')) {
    throw new EnforcementSetupError('session_boundary_invalid');
  }
  const boundaries: Partial<Record<SessionAudience, SessionBoundary>> = {};
  for (const audience of ['tenant', 'admin'] as const) {
    const deps = raw[audience];
    if (deps !== undefined) boundaries[audience] = createBoundary(audience, deps, options.now, options.deadlineMs);
  }
  const { tenant, admin } = boundaries;
  if (tenant !== undefined && admin !== undefined && sharesHost(tenant.trustedOrigins, admin.trustedOrigins)) {
    throw new EnforcementSetupError('session_origins_shared');
  }
  return Object.freeze(boundaries);
}

export type SessionCsrfRefusal = 'csrf_session_missing' | 'csrf_session_duplicate' | 'csrf_session_invalid';

/** null when the request carries exactly one token, and it is this session's; else the refusal. */
export function sessionCsrfRefusal(req: Request, expected: string): SessionCsrfRefusal | null {
  let lines = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === SESSION_CSRF_HEADER) lines++;
  if (lines === 0) return 'csrf_session_missing';
  if (lines > 1) return 'csrf_session_duplicate';
  const supplied = req.headers[SESSION_CSRF_HEADER];
  // The pattern fixes the length, so timingSafeEqual compares equal-length buffers in fixed time.
  if (typeof supplied !== 'string' || !OPAQUE_RE.test(supplied)) return 'csrf_session_invalid';
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? null : 'csrf_session_invalid';
}
