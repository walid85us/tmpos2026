// Phase 1.5 M7 — Default-off, dev-only /auth/session/resolve prototype handler.
//
// Production-safe-SHAPED session resolution, but NOT production-enabled. Flow:
//   gate(platform-identity flag) → gate(session-resolve flag + non-prod) →
//   verify Supabase token (M3 VerifiedSupabaseAuthAdapter) →
//   resolve-or-create the app-owned internal_user_id (M1, FAIL-CLOSED) →
//   emit advisory audit envelope (M2) → return the M6 contract DTO.
//
// BINDING INVARIANTS:
//   - `authorization` is ALWAYS null (server-derived authz deferred).
//   - A verified token with NO resolved internal_user_id is 'token-verified'
//     (503 identity_resolution_error) — NEVER 'authenticated' (fail-closed).
//   - The ONLY authority input is `Authorization: Bearer <token>`. The request
//     body is NEVER read for authority — any role/tenant/store/permission/
//     user_metadata/internalUserId on it is ignored entirely.
//   - No Firebase verifier. No durable audit. No schema/RLS. No production path.
//
// SAFETY: never logs/returns the raw token, JWT payload, JWKS keys, DB URL,
// service-role key, connection string, or raw DB errors (sanitized summaries
// only). Reuses the M3/M1/M2/M6 modules WITHOUT modifying them.
// Server-side only. Never imported by src/ (the client bundle).

import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { isPlatformIdentityEnabled, isSessionResolveEnabled, isServerConfigComplete } from './config';
import { safeLog, sanitizeError } from '../safe-log';
import type { AuthAdapter } from './authAdapter';
import type { ActorAssertion, RequestScope } from './requestContext';
import { verifiedSupabaseAuthAdapter, SupabaseTokenError } from './supabaseAuthAdapter';
import { upsertIdentity } from './identityRepository';
import { buildAuditEnvelope, emitAuditEnvelope } from './auditEnvelope';
import {
  SESSION_RESOLVE_ACTION_ID,
  SESSION_RESOLVE_EVALUATED_BY,
  SESSION_RESOLVE_SOURCE_OF_TRUTH,
  SESSION_RESOLVE_MATRIX,
  SESSION_RESOLVE_REASON_CODES,
  type SessionResolveResponseDTO,
  type SessionResolveReasonCode,
} from './sessionResolveContract';

const R = SESSION_RESOLVE_REASON_CODES;
const NO_SCOPE: RequestScope = { scopeType: 'none', tenantId: null, storeId: null, platformScope: false };
const REQUIRED_PERMISSION = 'session:resolve';

/** Resolves a verified actor to its durable, app-owned internal_user_id (or null). */
export type ResolveIdentityFn = (assertion: ActorAssertion) => Promise<string | null>;

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

  return async (req: Request, res: Response): Promise<void> => {
    // --- Gate 1: platform-identity feature flag (default OFF) ---
    if (!isPlatformIdentityEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Platform identity is disabled.' } });
      return;
    }
    // --- Gate 2: session-resolve opt-in + non-production (default OFF) ---
    if (!isSessionResolveEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Session resolve is disabled.' } });
      return;
    }

    const requestId = randomUUID();

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
          res.status(dto.status!).json(dto);
          return;
        }
        // Non-typed/unexpected verify error ⇒ unexpected handler error.
        throw err;
      }

      // No bearer token presented ⇒ unauthenticated.
      if (!assertion) {
        emitSessionAudit(requestId, null, R.DENIED_UNAUTHENTICATED);
        const dto = failureDTO(requestId, R.DENIED_UNAUTHENTICATED);
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
        // Never surface raw DB errors / connection strings — sanitized summary only.
        safeLog.error('[platform-identity] M7 session-resolve identity resolution failed', sanitizeError(err));
        internalUserId = null;
      }

      if (!internalUserId) {
        emitSessionAudit(requestId, null, R.IDENTITY_RESOLUTION_ERROR);
        const dto = failureDTO(requestId, R.IDENTITY_RESOLUTION_ERROR);
        res.status(dto.status!).json(dto);
        return;
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
        authorization: null, // SERVER-DERIVED authz deferred — never produced here
      };
      res.status(200).json(dto);
    } catch (err) {
      // Catch-all: unexpected handler error. Sanitized summary only; never leak.
      safeLog.error('[platform-identity] M7 session-resolve unexpected error', sanitizeError(err));
      emitSessionAudit(requestId, null, R.SESSION_RESOLVE_ERROR);
      const dto = failureDTO(requestId, R.SESSION_RESOLVE_ERROR);
      res.status(dto.status!).json(dto);
    }
  };
}
