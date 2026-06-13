// Phase 1.5 M3-Revised — Verified Supabase "whoami" diagnostic handler (dev-only).
//
// Flow:
//   gate(feature flag) → gate(verified diagnostics + non-prod) →
//   verify Supabase token (VerifiedSupabaseAuthAdapter) →
//   resolve-or-create platform_identity (auth_provider='supabase') [FAIL-CLOSED] →
//   emit advisory verified audit envelope → safe whoami response.
//
// FAIL-CLOSED IDENTITY (binding): a cryptographically verified token is NOT a
// fully authenticated app actor on its own. The actor is "authenticated" ONLY
// after it resolves to a durable, app-owned internal_user_id via M1. If identity
// resolution is unavailable/unconfigured, the upsert fails, or no id is produced,
// the endpoint returns 503 `identity_resolution_error` and authState is NOT
// 'authenticated'. We never claim an authenticated actor with a null id.
//
// SAFETY: never returns/logs the raw token, full JWT payload, JWKS keys, raw DB
// errors, or any secret. The audit actorId is the app-owned internal_user_id,
// never the raw sub; the failure envelope is labelled as a failure (no
// authenticated actor) and carries a null actorId by design.
// Server-side only. Never imported by src/.

import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import {
  isPlatformIdentityEnabled,
  isVerifiedDiagnosticsEnabled,
  isServerConfigComplete,
} from './config';
import { safeLog, sanitizeError } from '../safe-log';
import type { AuthAdapter } from './authAdapter';
import type { ActorAssertion, RequestScope } from './requestContext';
import { verifiedSupabaseAuthAdapter, SupabaseTokenError } from './supabaseAuthAdapter';
import { upsertIdentity } from './identityRepository';
import { buildAuditEnvelope, emitAuditEnvelope, VERIFIED_EVALUATED_BY } from './auditEnvelope';

export const WHOAMI_ACTION_ID = 'platform.diagnostic.supabase-whoami';

const NO_SCOPE: RequestScope = { scopeType: 'none', tenantId: null, storeId: null, platformScope: false };

/** Resolves a verified actor to its durable, app-owned internal_user_id (or null). */
export type ResolveIdentityFn = (assertion: ActorAssertion) => Promise<string | null>;

/** jwks_unavailable + identity_resolution_error are infra/transient (503); auth failures are 401. */
function statusForReason(reason: string): number {
  return reason === 'jwks_unavailable' || reason === 'identity_resolution_error' ? 503 : 401;
}

function emitWhoamiAudit(
  requestId: string,
  actorId: string | null,
  decision: 'allow' | 'deny' | 'deferred',
  reasonCode: string,
  humanReadableReason: string,
): void {
  emitAuditEnvelope(buildAuditEnvelope({
    requestId,
    actionId: WHOAMI_ACTION_ID,
    actorId, // app-owned UUID on success; null ONLY on a failure-labelled envelope
    scope: NO_SCOPE,
    requiredPermission: 'identity:verify',
    decision,
    reasonCode,
    humanReadableReason,
    sourceOfTruth: 'supabase_verified_token',
    evaluatedBy: VERIFIED_EVALUATED_BY,
  }));
}

/**
 * Default identity resolver: resolve-or-create the app-owned internal_user_id via
 * M1 (auth_provider='supabase'). FAIL-CLOSED: returns null when the durable store
 * is unreachable/unconfigured or no id is produced. A thrown DB error propagates
 * to the caller, which treats it as identity_resolution_error. Never returns or
 * logs a raw DB error / connection string.
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

export interface WhoamiHandlerOptions {
  /** Injectable adapter (QA harness supplies a mock-JWKS adapter). */
  adapter?: AuthAdapter;
  /** Injectable identity resolver (QA harness simulates success / failure / null). */
  resolveIdentity?: ResolveIdentityFn;
}

/**
 * Build the verified-whoami Express handler. Adapter + resolver are injectable so
 * the QA harness can exercise every path without a live Supabase project or DB.
 */
export function createSupabaseWhoamiHandler(options: WhoamiHandlerOptions = {}) {
  const adapter = options.adapter ?? verifiedSupabaseAuthAdapter;
  const resolveIdentity = options.resolveIdentity ?? defaultResolveIdentity;

  return async (req: Request, res: Response): Promise<void> => {
    // --- Gate 1: platform-identity feature flag (default OFF) ---
    if (!isPlatformIdentityEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Platform identity is disabled.' } });
      return;
    }
    // --- Gate 2: verified-diagnostics opt-in + non-production (default OFF) ---
    if (!isVerifiedDiagnosticsEnabled()) {
      res.status(404).json({ error: { code: 'FEATURE_DISABLED', message: 'Verified diagnostics are disabled.' } });
      return;
    }

    const requestId = randomUUID();

    // --- Step 1: verify the Supabase token (deny-by-default) ---
    let assertion: ActorAssertion | null;
    try {
      assertion = await adapter.verify(req);
    } catch (err) {
      const reasonCode = err instanceof SupabaseTokenError ? err.code : 'supabase_token_invalid';
      if (!(err instanceof SupabaseTokenError)) {
        // Unexpected (non-typed) error — log a sanitized summary only (never the token).
        safeLog.error('[platform-identity] M3 verify unexpected error', sanitizeError(err));
      }
      const decision = reasonCode === 'jwks_unavailable' ? 'deferred' : 'deny';
      emitWhoamiAudit(requestId, null, decision, reasonCode, 'Supabase token verification failed.');
      res.status(statusForReason(reasonCode)).json({
        requestId,
        actionId: WHOAMI_ACTION_ID,
        authProvider: 'supabase',
        authState: 'unauthenticated',
        decision,
        reasonCode,
      });
      return;
    }

    // No bearer token presented ⇒ unauthenticated.
    if (!assertion) {
      emitWhoamiAudit(requestId, null, 'deny', 'denied_unauthenticated', 'No bearer token presented.');
      res.status(401).json({
        requestId,
        actionId: WHOAMI_ACTION_ID,
        authProvider: 'supabase',
        authState: 'unauthenticated',
        decision: 'deny',
        reasonCode: 'denied_unauthenticated',
      });
      return;
    }

    // --- Step 2: resolve the durable app actor (FAIL-CLOSED) ---
    // A verified token is NOT an authenticated app actor until it maps to a
    // durable, app-owned internal_user_id. Any failure ⇒ 503, NOT 'authenticated'.
    let internalUserId: string | null = null;
    try {
      internalUserId = await resolveIdentity(assertion);
    } catch (err) {
      // Never surface raw DB errors / connection strings — sanitized summary only.
      safeLog.error('[platform-identity] M3 identity resolution failed', sanitizeError(err));
      internalUserId = null;
    }

    if (!internalUserId) {
      // Failure-labelled envelope — explicitly NOT an authenticated-actor claim.
      safeLog.warn('[platform-identity] M3 no app identity established for a verified token (fail-closed)');
      emitWhoamiAudit(
        requestId,
        null,
        'deferred',
        'identity_resolution_error',
        'Supabase token verified, but no app identity (internal_user_id) was established — no authenticated actor.',
      );
      res.status(503).json({
        requestId,
        actionId: WHOAMI_ACTION_ID,
        authProvider: 'supabase',
        authState: 'unauthenticated',
        decision: 'deferred',
        reasonCode: 'identity_resolution_error',
      });
      return;
    }

    // --- Step 3: authenticated app actor established ---
    emitWhoamiAudit(requestId, internalUserId, 'allow', 'verified_supabase', 'Supabase token verified and mapped to app identity.');

    // Safe whoami response (no token, no full payload, no secrets).
    res.status(200).json({
      requestId,
      actionId: WHOAMI_ACTION_ID,
      decision: 'allow',
      authProvider: 'supabase',
      authProviderUid: assertion.authProviderUid,
      internalUserId,
      email: assertion.email,
      displayName: assertion.displayName ?? null,
      authState: 'authenticated',
      identityResolution: 'resolved_or_created',
      sourceOfTruth: 'supabase_verified_token',
      evaluatedBy: VERIFIED_EVALUATED_BY,
    });
  };
}
