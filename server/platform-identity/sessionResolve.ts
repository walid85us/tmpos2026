// Phase 1.5 M7 — Default-off, dev-only /auth/session/resolve prototype handler.
//
// Production-safe-SHAPED session resolution, but NOT production-enabled. Flow:
//   gate(platform-identity flag) → gate(session-resolve flag + non-prod) →
//   verify Supabase token (M3 VerifiedSupabaseAuthAdapter) →
//   resolve-or-create the app-owned internal_user_id (M1, FAIL-CLOSED) →
//   emit advisory audit envelope (M2) → return the M6 contract DTO.
//
// BINDING INVARIANTS:
//   - `authorization` is null UNLESS the M11.5 live flag is enabled
//     (ENABLE_LIVE_SESSION_AUTHORIZATION=true, non-production) AND the M11.4 service
//     returns an `allow` that it durably AUDITED. Default-off behaviour, deny,
//     fail-closed audit failure, and any error all keep `authorization: null`.
//   - A verified token with NO resolved internal_user_id is 'token-verified'
//     (503 identity_resolution_error) — NEVER 'authenticated' (fail-closed).
//   - The ONLY authority input is `Authorization: Bearer <token>`. The request
//     body is NEVER read for authority — any role/tenant/store/permission/
//     user_metadata/internalUserId on it is ignored entirely. Live authorization is
//     derived SERVER-SIDE from the durable identity key only.
//   - No Firebase verifier. No schema/RLS. No production path. Durable audit is
//     written ONLY by the M11.4 service when the live flag is enabled.
//
// SAFETY: never logs/returns the raw token, JWT payload, JWKS keys, DB URL,
// service-role key, connection string, or raw DB errors (sanitized summaries
// only). Reuses the M3/M1/M2/M6 modules WITHOUT modifying them.
// Server-side only. Never imported by src/ (the client bundle).

import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import {
  isPlatformIdentityEnabled,
  isSessionResolveEnabled,
  isServerConfigComplete,
  isLiveSessionAuthorizationEnabled,
} from './config';
import { safeLog, sanitizeError } from '../safe-log';
import type { AuthAdapter } from './authAdapter';
import type { ActorAssertion, RequestScope } from './requestContext';
import { verifiedSupabaseAuthAdapter, SupabaseTokenError } from './supabaseAuthAdapter';
import { upsertIdentity } from './identityRepository';
import { buildAuditEnvelope, emitAuditEnvelope } from './auditEnvelope';
// M11.5 — the ONLY composition seam the route uses for live authorization. The
// route NEVER imports the repository, the audit writer, or the resolver directly.
import {
  resolveDefaultSessionAuthorization,
  type SessionAuthorizationResult,
} from './sessionAuthorizationService';
import {
  SESSION_RESOLVE_ACTION_ID,
  SESSION_RESOLVE_EVALUATED_BY,
  SESSION_RESOLVE_SOURCE_OF_TRUTH,
  SESSION_RESOLVE_MATRIX,
  SESSION_RESOLVE_REASON_CODES,
  type SessionResolveResponseDTO,
  type SessionResolveReasonCode,
  type SessionResolveAuthorization,
} from './sessionResolveContract';

const R = SESSION_RESOLVE_REASON_CODES;
const NO_SCOPE: RequestScope = { scopeType: 'none', tenantId: null, storeId: null, platformScope: false };
const REQUIRED_PERMISSION = 'session:resolve';

// =============================================================================
// Phase 1.6 M16.2 — SAFE, NON-SECRET route-execution breadcrumbs.
//
// PURPOSE: make the /auth/session/resolve outcome ATTRIBUTABLE from the identity
// API console WITHOUT exposing any secret. Each breadcrumb carries ONLY: a stable
// marker, the public route name, the requestId (an opaque UUID), a phase tag, and —
// where applicable — the HTTP status, the contract reason code, an authorization
// PRESENCE boolean (success only), and a sanitized error class + error code
// (exception path only, derived via sanitizeError()).
//
// LEAK-PROOF BY CONSTRUCTION: the helper accepts NO Request, NO assertion, and NO
// identity object — only a requestId string, a phase, and a small fixed-key fields
// object of primitives. It therefore can NEVER receive or log a token / Authorization
// header / request headers / request body / raw response body / raw authorization
// DTO / identity fields (internalUserId, authProviderUid, email, displayName) /
// tenant or store id / permission key or level. Values flow through the redaction-
// applying safe logger as a final defense.
// =============================================================================

/** Public route name (non-secret literal) used only as a breadcrumb label. */
const SESSION_RESOLVE_ROUTE = '/auth/session/resolve';

/** Stable, greppable breadcrumb marker. */
const SR_BREADCRUMB = '[platform-identity] session-resolve';

/** The honest, allow-listed execution phases a breadcrumb may report. */
type SessionResolveBreadcrumbPhase =
  | 'received'
  | 'feature_disabled'
  | 'denied_unauthenticated'
  | 'token_rejected'
  | 'identity_resolution_threw'
  | 'identity_unresolved'
  | 'authenticated'
  | 'unexpected_error';

/** Phases logged at error level (a real failure, even when fail-closed). */
const SR_ERROR_PHASES: ReadonlySet<SessionResolveBreadcrumbPhase> = new Set([
  'identity_resolution_threw',
  'unexpected_error',
]);

/** The ONLY non-secret primitive fields a breadcrumb may carry. */
interface SessionResolveBreadcrumbFields {
  status?: number;
  reasonCode?: string;
  authorizationPresent?: boolean;
  errorClass?: string;
  errorCode?: string;
}

/**
 * Emit a SAFE, NON-SECRET breadcrumb. By construction it can carry no secret: it
 * takes only a requestId string, a phase, and a small primitive fields object, and
 * forwards them through the redaction-applying safe logger. No Request / assertion /
 * identity is accepted here.
 */
function sessionResolveBreadcrumb(
  requestId: string,
  phase: SessionResolveBreadcrumbPhase,
  fields: SessionResolveBreadcrumbFields = {},
): void {
  const payload = { route: SESSION_RESOLVE_ROUTE, requestId, phase, ...fields };
  if (SR_ERROR_PHASES.has(phase)) {
    safeLog.error(`${SR_BREADCRUMB} exit:${phase}`, payload);
  } else if (phase === 'received') {
    safeLog.info(`${SR_BREADCRUMB} received`, payload);
  } else {
    safeLog.info(`${SR_BREADCRUMB} exit:${phase}`, payload);
  }
}

/** Resolves a verified actor to its durable, app-owned internal_user_id (or null). */
export type ResolveIdentityFn = (assertion: ActorAssertion) => Promise<string | null>;

/**
 * M11.5 — resolves live, server-derived authorization for the durable identity key
 * (platform-first default context). Defaults to the M11.4 service; injectable so
 * the route diagnostic can prove fail-closed handling WITHOUT a real DB failure
 * and WITHOUT modifying the M11.4 service.
 */
export type ResolveSessionAuthorizationFn = (
  identityKey: { authProvider: string; authProviderUid: string },
) => Promise<SessionAuthorizationResult>;

/** Safe, non-leaking human-readable reason per code (never includes secrets). */
const HUMAN_READABLE: Record<SessionResolveReasonCode, string> = {
  verified_supabase: 'Supabase token verified and mapped to app identity.',
  denied_unauthenticated: 'No bearer token presented.',
  supabase_token_invalid: 'Supabase token verification failed.',
  supabase_token_expired: 'Supabase token verification failed.',
  supabase_token_wrong_issuer: 'Supabase token verification failed.',
  supabase_token_wrong_audience: 'Supabase token verification failed.',
  jwks_unavailable: 'Token verification temporarily unavailable.',
  identity_resolution_error:
    'Supabase token verified, but no app identity (internal_user_id) was established — no authenticated actor.',
  account_disabled: 'Account is disabled.', // RESERVED/FUTURE — not emitted in M7
  account_suspended: 'Account is suspended.', // RESERVED/FUTURE — not emitted in M7
  session_resolve_error: 'Session resolution failed unexpectedly.',
};

/**
 * Default identity resolver: resolve-or-create the app-owned internal_user_id via
 * the M1 mapping (auth_provider='supabase'). FAIL-CLOSED: returns null when the
 * durable store is unreachable/unconfigured or no id is produced. A thrown DB
 * error propagates to the caller, which treats it as identity_resolution_error.
 * Never returns or logs a raw DB error / connection string. (Mirrors the M3
 * whoami resolver; only maps a provider sub → app id — NOT business/role data.)
 */
async function defaultResolveIdentity(assertion: ActorAssertion): Promise<string | null> {
  if (!isServerConfigComplete()) return null; // cannot reach the durable identity store
  const identity = await upsertIdentity({
    authProvider: 'supabase',
    authProviderUid: assertion.authProviderUid,
    email: assertion.email,
    displayName: assertion.displayName ?? null,
  });
  const id = identity?.internalUserId;
  return typeof id === 'string' && id.trim() ? id : null;
}

export interface SessionResolveHandlerOptions {
  /** Injectable adapter (QA harness supplies a mock adapter; no live Supabase). */
  adapter?: AuthAdapter;
  /** Injectable resolver (QA harness simulates success / null / throw). */
  resolveIdentity?: ResolveIdentityFn;
  /** Injectable live-authorization resolver (defaults to the M11.4 service). */
  resolveSessionAuthorization?: ResolveSessionAuthorizationFn;
}

/** Emit the advisory audit envelope for a session-resolve decision. */
function emitSessionAudit(
  requestId: string,
  actorId: string | null,
  reasonCode: SessionResolveReasonCode,
): void {
  const row = SESSION_RESOLVE_MATRIX[reasonCode];
  emitAuditEnvelope(buildAuditEnvelope({
    requestId,
    actionId: SESSION_RESOLVE_ACTION_ID,
    actorId, // app-owned UUID on success; null on every failure/deferred path
    scope: NO_SCOPE,
    requiredPermission: REQUIRED_PERMISSION,
    decision: row.decision,
    reasonCode,
    humanReadableReason: HUMAN_READABLE[reasonCode],
    sourceOfTruth: SESSION_RESOLVE_SOURCE_OF_TRUTH,
    evaluatedBy: SESSION_RESOLVE_EVALUATED_BY,
  }));
}

/** Build a safe failure DTO (identity null, authorization null) for a reason code. */
function failureDTO(requestId: string, reasonCode: SessionResolveReasonCode): SessionResolveResponseDTO {
  const row = SESSION_RESOLVE_MATRIX[reasonCode];
  return {
    status: row.status,
    requestId,
    authState: row.authState,
    decision: row.decision,
    reasonCode,
    error: { code: reasonCode, message: HUMAN_READABLE[reasonCode] },
    identity: null,
    authorization: null,
  };
}

/**
 * Build the default-off, dev-only /auth/session/resolve Express handler. Adapter
 * + resolver are injectable so the QA harness can exercise every path without a
 * live Supabase project or DB.
 */
export function createSessionResolveHandler(options: SessionResolveHandlerOptions = {}) {
  const adapter = options.adapter ?? verifiedSupabaseAuthAdapter;
  const resolveIdentity = options.resolveIdentity ?? defaultResolveIdentity;
  const resolveSessionAuthorization =
    options.resolveSessionAuthorization ?? resolveDefaultSessionAuthorization;

  return async (req: Request, res: Response): Promise<void> => {
    // Phase 1.6 M16.2 — correlate every breadcrumb for this request. The id is an
    // opaque UUID (no secret); generating it before the gates is behavior-neutral
    // (the gate 404s do not embed it and their bodies are unchanged).
    const requestId = randomUUID();
    sessionResolveBreadcrumb(requestId, 'received');

    // --- Gate 1: platform-identity feature flag (default OFF) ---
    if (!isPlatformIdentityEnabled()) {
      sessionResolveBreadcrumb(requestId, 'feature_disabled', { status: 404, reasonCode: 'platform_identity_disabled' });
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Platform identity is disabled.' } });
      return;
    }
    // --- Gate 2: session-resolve opt-in + non-production (default OFF) ---
    if (!isSessionResolveEnabled()) {
      sessionResolveBreadcrumb(requestId, 'feature_disabled', { status: 404, reasonCode: 'session_resolve_disabled' });
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Session resolve is disabled.' } });
      return;
    }

    try {
      // --- Step 1: verify the Supabase token (deny-by-default) ---
      let assertion: ActorAssertion | null;
      try {
        assertion = await adapter.verify(req);
      } catch (err) {
        if (err instanceof SupabaseTokenError) {
          const reasonCode = err.code as SessionResolveReasonCode;
          emitSessionAudit(requestId, null, reasonCode);
          const dto = failureDTO(requestId, reasonCode);
          sessionResolveBreadcrumb(requestId, 'token_rejected', { status: dto.status, reasonCode });
          res.status(dto.status!).json(dto);
          return;
        }
        // Non-typed/unexpected verify error ⇒ unexpected handler error (catch-all 500).
        throw err;
      }

      // No bearer token presented ⇒ unauthenticated.
      if (!assertion) {
        emitSessionAudit(requestId, null, R.DENIED_UNAUTHENTICATED);
        const dto = failureDTO(requestId, R.DENIED_UNAUTHENTICATED);
        sessionResolveBreadcrumb(requestId, 'denied_unauthenticated', { status: dto.status, reasonCode: R.DENIED_UNAUTHENTICATED });
        res.status(dto.status!).json(dto);
        return;
      }

      // --- Step 2: resolve the durable app actor (FAIL-CLOSED) ---
      // A verified token is NOT an authenticated app actor until it maps to a
      // durable internal_user_id. Any failure (null OR thrown) ⇒ token-verified.
      let internalUserId: string | null = null;
      try {
        internalUserId = await resolveIdentity(assertion);
      } catch (err) {
        // Never surface raw DB errors / connection strings — sanitized class+code only.
        const safe = sanitizeError(err);
        sessionResolveBreadcrumb(requestId, 'identity_resolution_threw', { errorClass: safe.name, errorCode: safe.code });
        internalUserId = null;
      }

      if (!internalUserId) {
        emitSessionAudit(requestId, null, R.IDENTITY_RESOLUTION_ERROR);
        const dto = failureDTO(requestId, R.IDENTITY_RESOLUTION_ERROR);
        sessionResolveBreadcrumb(requestId, 'identity_unresolved', { status: dto.status, reasonCode: R.IDENTITY_RESOLUTION_ERROR });
        res.status(dto.status!).json(dto);
        return;
      }

      // --- Step 2.5: OPTIONAL live server-derived authorization (DEV-flagged) ---
      // DEFAULT OFF. Only when ENABLE_LIVE_SESSION_AUTHORIZATION=true (and the
      // process is non-production) do we derive authorization, via the M11.4 service
      // using the SERVER-DERIVED platform-first default context. The verified token
      // is identity proof ONLY — we pass the durable (auth_provider, auth_provider_uid)
      // key and NEVER read the request body / user_metadata / any client-asserted
      // role/tenant/store/permission. FAIL-CLOSED: authorization is returned ONLY for
      // an `allow` that the service durably AUDITED. On any deny/forced-deny/audit
      // failure/repository error we keep `authorization: null` and NEVER downgrade the
      // authenticated identity. No token/JWT/auth header/cookie is read or logged.
      let authorization: SessionResolveAuthorization = null;
      if (isLiveSessionAuthorizationEnabled()) {
        try {
          const authzResult = await resolveSessionAuthorization({
            authProvider: 'supabase',
            authProviderUid: assertion.authProviderUid,
          });
          if (authzResult.decision === 'allow' && authzResult.audited && authzResult.authorization) {
            authorization = authzResult.authorization;
          }
        } catch (err) {
          // Sanitized summary only; never leak. Identity success is preserved.
          safeLog.error('[platform-identity] M11.5 live authorization failed', sanitizeError(err));
          authorization = null;
        }
      }

      // --- Step 3: authenticated app actor established ---
      emitSessionAudit(requestId, internalUserId, R.VERIFIED_SUPABASE);
      const dto: SessionResolveResponseDTO = {
        status: 200,
        requestId,
        authState: 'authenticated',
        internalUserId,
        authProvider: 'supabase',
        authProviderUid: assertion.authProviderUid,
        email: assertion.email ?? undefined,
        displayName: assertion.displayName ?? null,
        decision: 'allow',
        reasonCode: R.VERIFIED_SUPABASE,
        sourceOfTruth: SESSION_RESOLVE_SOURCE_OF_TRUTH,
        identity: {
          internalUserId,
          authProvider: 'supabase',
          authProviderUid: assertion.authProviderUid,
          email: assertion.email,
          displayName: assertion.displayName ?? null,
        },
        authorization, // live server-derived authz (DEV-flagged allow+audited) or null
      };
      // PRESENCE boolean only — never the raw authorization object or identity fields.
      sessionResolveBreadcrumb(requestId, 'authenticated', {
        status: 200,
        reasonCode: R.VERIFIED_SUPABASE,
        authorizationPresent: authorization !== null,
      });
      res.status(200).json(dto);
    } catch (err) {
      // Catch-all: unexpected handler error. Sanitized error CLASS + CODE only — never
      // the raw error, the stack, the request body/headers, the token, or identity.
      const safe = sanitizeError(err);
      sessionResolveBreadcrumb(requestId, 'unexpected_error', {
        status: SESSION_RESOLVE_MATRIX[R.SESSION_RESOLVE_ERROR].status,
        reasonCode: R.SESSION_RESOLVE_ERROR,
        errorClass: safe.name,
        errorCode: safe.code,
      });
      emitSessionAudit(requestId, null, R.SESSION_RESOLVE_ERROR);
      const dto = failureDTO(requestId, R.SESSION_RESOLVE_ERROR);
      res.status(dto.status!).json(dto);
    }
  };
}
