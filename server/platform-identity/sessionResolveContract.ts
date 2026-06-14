// Phase 1.5 M6 — Inert contract foundation for a FUTURE /auth/session/resolve.
//
// PURPOSE: declare the SHAPE of a future, production-safe, provider-agnostic
// session-resolution endpoint that will:
//   verify a provider token → resolve the app-owned internal_user_id →
//   return a SAFE, M5-AppSession-aligned response.
//
// This file is INERT (Option B — contract-only):
//   - It contains TypeScript TYPES and const data ONLY — no functions, no runtime
//     values that do work, no side effects.
//   - It registers NO route and adds NO runtime endpoint behavior.
//   - It is imported by NOTHING at runtime — only by the M6 diagnostic script
//     and referenced by the M6 doc. It does NOT touch the M3 whoami endpoint,
//     the M4 pilot, AccessContext, Login, AccessGuard, App routing, Firebase,
//     Supabase, the DB, or any business/server-route module.
//
// SECURITY (binding): imports NOTHING (no Express, DB, Supabase, Firebase, jose).
// Reads NO env. Parses NO token. Emits NO audit. Handles NO secret. References
// NO service-role key, DB URL, JWT secret, raw token, JWKS, or connection string.
//
// BOUNDARY (binding):
//   - IDENTITY is proven SERVER-SIDE only (a verified token mapped to an
//     app-owned internal_user_id). A provider token is NOT an authenticated app
//     actor until it resolves to a non-empty internalUserId (FAIL-CLOSED).
//   - AUTHORIZATION (role/scope/tenant/store/permissions) is SERVER-DERIVED and
//     is DEFERRED: in this era it is ALWAYS `null`. Client-asserted authority is
//     NEVER trusted (the future endpoint will not even read it).

// =============================================================================
// Route identity (FUTURE — declared, NOT registered anywhere)
// =============================================================================

/** The future endpoint path. Declared for documentation/alignment only — NO
 *  route is registered by this milestone. */
export const SESSION_RESOLVE_PATH = '/auth/session/resolve' as const;

/** Audit action id for the future endpoint (mirrors the M2/M3 actionId style). */
export const SESSION_RESOLVE_ACTION_ID = 'platform.auth.session-resolve' as const;

/** Evaluator label for the future endpoint's audit envelopes. */
export const SESSION_RESOLVE_EVALUATED_BY = 'session_resolve@v0' as const;

/** Provenance label for a Supabase-verified session (mirrors M3 whoami). */
export const SESSION_RESOLVE_SOURCE_OF_TRUTH = 'supabase_verified_token' as const;

// =============================================================================
// Vocabulary
// =============================================================================

/**
 * Identity providers the future contract can describe. Supabase is the initial
 * (and only implemented-direction) provider; the shape stays provider-neutral so
 * a future adapter can plug in. NO Firebase verifier is implemented here.
 */
export type SessionAuthProvider = 'supabase' | 'firebase';

/**
 * Honest auth states (aligned with the M5 AppSession model and the backend
 * request-context vocabulary):
 *   - 'authenticated'   → verified token AND a resolved app-owned internal_user_id.
 *   - 'token-verified'  → token proven, but NO resolved internal_user_id (FAIL-CLOSED).
 *   - 'unauthenticated' → no proven identity (or an auth/transport failure).
 */
export type SessionAuthState = 'authenticated' | 'token-verified' | 'unauthenticated';

/** Decision outcomes surfaced by the future endpoint. */
export type SessionDecision = 'allow' | 'deny' | 'deferred';

// =============================================================================
// Reason codes (stable, safe, non-leaking)
// =============================================================================

/**
 * Stable reason codes for the future endpoint. Reused verbatim from the M3
 * verified-whoami path where applicable, plus session-resolution-specific and
 * RESERVED/FUTURE account-status codes.
 */
export const SESSION_RESOLVE_REASON_CODES = {
  /** Verified Supabase token AND resolved internal_user_id ⇒ authenticated. */
  VERIFIED_SUPABASE: 'verified_supabase',
  /** No/blank/non-bearer Authorization header. */
  DENIED_UNAUTHENTICATED: 'denied_unauthenticated',
  /** Token signature/format invalid (or no subject). */
  SUPABASE_TOKEN_INVALID: 'supabase_token_invalid',
  /** Token expired. */
  SUPABASE_TOKEN_EXPIRED: 'supabase_token_expired',
  /** Token issuer claim did not match. */
  SUPABASE_TOKEN_WRONG_ISSUER: 'supabase_token_wrong_issuer',
  /** Token audience claim did not match. */
  SUPABASE_TOKEN_WRONG_AUDIENCE: 'supabase_token_wrong_audience',
  /** JWKS endpoint unavailable / unconfigured (infra/transient). */
  JWKS_UNAVAILABLE: 'jwks_unavailable',
  /** Token verified, but no app identity (internal_user_id) was established
   *  (no id, DB unavailable, or upsert failed) — FAIL-CLOSED, NOT authenticated. */
  IDENTITY_RESOLUTION_ERROR: 'identity_resolution_error',
  /** RESERVED/FUTURE — verified+resolved user is disabled. Requires durable
   *  account-status persistence (not built in M6). */
  ACCOUNT_DISABLED: 'account_disabled',
  /** RESERVED/FUTURE — verified+resolved user is suspended. Requires durable
   *  account-status persistence (not built in M6). */
  ACCOUNT_SUSPENDED: 'account_suspended',
  /** Unexpected handler error (deny-by-default, no detail leaked). */
  SESSION_RESOLVE_ERROR: 'session_resolve_error',
} as const;

/** Union of every reason-code string value. */
export type SessionResolveReasonCode =
  (typeof SESSION_RESOLVE_REASON_CODES)[keyof typeof SESSION_RESOLVE_REASON_CODES];

/** Reason codes that are RESERVED for a FUTURE milestone (not emitted in M6's era). */
export const SESSION_RESOLVE_RESERVED_REASON_CODES: readonly SessionResolveReasonCode[] = [
  SESSION_RESOLVE_REASON_CODES.ACCOUNT_DISABLED,
  SESSION_RESOLVE_REASON_CODES.ACCOUNT_SUSPENDED,
] as const;

// =============================================================================
// Status / decision / authState matrix (declarative)
// =============================================================================

/** One row of the contract matrix: what each reason code maps to. */
export interface SessionResolveMatrixRow {
  /** HTTP status the future endpoint returns. */
  status: number;
  decision: SessionDecision;
  authState: SessionAuthState;
  /** True for codes reserved for a future milestone (not emitted in M6's era). */
  reserved: boolean;
}

/**
 * The authoritative status/decision/authState matrix, keyed by reason code.
 * Declarative DATA only — no behavior. The future endpoint and its tests assert
 * against this single source of truth.
 *
 * Note: `identity_resolution_error` is honestly `token-verified` (token proven,
 * no app identity) — NEVER `authenticated`. Both "no id" and "DB unavailable
 * during resolve" map here. This is the FAIL-CLOSED case.
 */
export const SESSION_RESOLVE_MATRIX: Record<SessionResolveReasonCode, SessionResolveMatrixRow> = {
  verified_supabase: { status: 200, decision: 'allow', authState: 'authenticated', reserved: false },
  denied_unauthenticated: { status: 401, decision: 'deny', authState: 'unauthenticated', reserved: false },
  supabase_token_invalid: { status: 401, decision: 'deny', authState: 'unauthenticated', reserved: false },
  supabase_token_expired: { status: 401, decision: 'deny', authState: 'unauthenticated', reserved: false },
  supabase_token_wrong_issuer: { status: 401, decision: 'deny', authState: 'unauthenticated', reserved: false },
  supabase_token_wrong_audience: { status: 401, decision: 'deny', authState: 'unauthenticated', reserved: false },
  jwks_unavailable: { status: 503, decision: 'deferred', authState: 'unauthenticated', reserved: false },
  // FAIL-CLOSED: token proven, no app identity ⇒ token-verified, never authenticated.
  identity_resolution_error: { status: 503, decision: 'deferred', authState: 'token-verified', reserved: false },
  // RESERVED/FUTURE — identity is real (authenticated) but access is denied.
  account_disabled: { status: 403, decision: 'deny', authState: 'authenticated', reserved: true },
  account_suspended: { status: 403, decision: 'deny', authState: 'authenticated', reserved: true },
  session_resolve_error: { status: 500, decision: 'deferred', authState: 'unauthenticated', reserved: false },
};

// =============================================================================
// Identity + authorization shapes (M5-AppSession-aligned)
// =============================================================================

/**
 * Server-verified identity. Present ONLY for a genuinely authenticated result
 * (verified token AND resolved internal_user_id). Field shape mirrors the M5
 * `AppIdentity`. `authProviderUid`/`email`/`displayName` are reference-only and
 * are NEVER authority.
 */
export interface SessionResolveIdentity {
  /** App-owned bridge key. Non-empty ONLY when identity is server-resolved. */
  internalUserId: string;
  authProvider: SessionAuthProvider;
  authProviderUid: string | null;
  email: string | null;
  displayName: string | null;
}

/**
 * Future, SERVER-DERIVED authorization. Its shape is reserved for a later,
 * separately-approved milestone. In THIS era the contract's `authorization` is
 * ALWAYS `null` — no authorization is ever produced or returned here.
 */
export type SessionResolveAuthorization = null;

// =============================================================================
// Wire response DTO
// =============================================================================

/**
 * The safe wire response of the future `/auth/session/resolve`.
 *
 * The FLAT fields (status..error) are intentionally a SUPERSET that is
 * assignment-compatible with the M5 mapper input (`WhoamiResponseInput`) so the
 * existing `mapWhoamiToAppSession` remains the single client-side normalization
 * seam — there is no second mapping to maintain. The STRUCTURED fields
 * (`identity`, `authorization`) mirror the resulting `AppSession` view.
 *
 * INVARIANTS:
 *   - `authorization` is ALWAYS `null`.
 *   - `identity` is non-null ONLY on an authenticated success.
 *   - `token-verified` is NEVER represented as `authenticated`.
 *   - NO secret/token field ever appears (no accessToken, refreshToken, rawJwt,
 *     jwtPayload, jwks, serviceRoleKey, databaseUrl, connectionString).
 */
export interface SessionResolveResponseDTO {
  // --- flat fields (M5 mapper-input compatible) ---
  /** HTTP status, when the call reached the server (0 ⇒ never reached it). */
  status?: number;
  requestId?: string;
  authState?: SessionAuthState;
  /** Present (non-empty) ONLY on an authenticated success. */
  internalUserId?: string;
  authProvider?: SessionAuthProvider;
  authProviderUid?: string;
  email?: string;
  displayName?: string | null;
  decision?: SessionDecision;
  reasonCode?: SessionResolveReasonCode;
  sourceOfTruth?: string;
  /** Structured error body for a non-200 response. */
  error?: { code?: string; message?: string } | null;

  // --- structured fields (AppSession-shaped view) ---
  /** Server-verified identity, or null when no identity was established. */
  identity: SessionResolveIdentity | null;
  /** Server-derived authorization — ALWAYS null in this era. */
  authorization: SessionResolveAuthorization;
}

/**
 * Compile-time guard: field names that MUST NEVER appear on the wire DTO. Used
 * by the M6 diagnostic to assert no secret/token field can be present. (Type-level
 * documentation only — no runtime value.)
 */
export type SessionResolveForbiddenField =
  | 'accessToken'
  | 'refreshToken'
  | 'rawJwt'
  | 'jwtPayload'
  | 'jwks'
  | 'serviceRoleKey'
  | 'databaseUrl'
  | 'connectionString';
