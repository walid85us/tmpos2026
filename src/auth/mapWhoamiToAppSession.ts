// Phase 1.5 M5 — Pure whoami → AppSession mapper (Option B, inert).
//
// Maps the SAFE response shape of the existing M3/M4 verified whoami diagnostic
// (POST /diagnostics/supabase-whoami; see src/pilot/identityDiagnosticClient.ts
// and server/platform-identity/verifiedWhoami.ts) into the provider-agnostic
// `AppSession` shape. It is a PURE function:
//   - no network, no env reads, no token reads, no browser storage;
//   - no Firebase / Supabase / AccessContext imports;
//   - no runtime adoption (imported only by the M5 diagnostic + this slice).
//
// FAIL-CLOSED + TRUSTLESS (binding):
//   - Authorization is NEVER derived here — `authorization` is ALWAYS `null`.
//   - 'authenticated' is emitted ONLY when the server said 'authenticated' AND a
//     non-empty `internalUserId` is present. Anything weaker degrades safely.
//   - 'token-verified' is preserved and NEVER upgraded to 'authenticated'.
//   - Client-asserted role/tenant/store/permission fields are IGNORED entirely
//     (this mapper does not even read them). Provider user_metadata is not read.
//   - No raw token or JWT is consumed, parsed, rendered, or stored.

import type { AppSession, AuthProvider } from './appSession';

/**
 * Safe whoami response fields (a superset of what the M3 server returns and what
 * the M4 client surfaces). Only these non-secret fields are consumed. Any extra
 * fields on the object (e.g. a forged `role`/`tenantId`/`permissions`) are
 * deliberately NOT read.
 */
export interface WhoamiResponseInput {
  /** HTTP status, when the call reached the server (0 ⇒ never reached it). */
  status?: number;
  requestId?: string;
  authState?: string;
  internalUserId?: string;
  authProvider?: string;
  authProviderUid?: string;
  email?: string;
  displayName?: string | null;
  decision?: string;
  reasonCode?: string;
  sourceOfTruth?: string;
  /** Structured error body `{ code }` from a non-200 response. */
  error?: { code?: string; message?: string } | null;
}

function cleanString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Only the two known providers are honored; anything else ⇒ null. */
function normalizeProvider(v: unknown): AuthProvider | null {
  return v === 'firebase' || v === 'supabase' ? v : null;
}

/** Build an identity-less, authorization-less session in the given state. */
function emptySession(
  authState: AppSession['authState'],
  reasonCode: string | null,
  requestId: string | null,
  sourceOfTruth: string | null,
): AppSession {
  return {
    identity: null,
    authorization: null, // never derived in this inert slice
    authState,
    sourceOfTruth,
    requestId,
    reasonCode,
  };
}

/**
 * Map a safe whoami response to an `AppSession`. Pure and fail-closed.
 *
 * Authorization is ALWAYS `null`. Identity is populated ONLY for a genuinely
 * authenticated server result with a resolved internal_user_id.
 */
export function mapWhoamiToAppSession(input: WhoamiResponseInput | null | undefined): AppSession {
  const w = input ?? {};

  const requestId = cleanString(w.requestId);
  const sourceOfTruth = cleanString(w.sourceOfTruth);
  // Prefer the explicit reasonCode; fall back to a structured error code.
  const reasonCode = cleanString(w.reasonCode) ?? cleanString(w.error?.code);
  const internalUserId = cleanString(w.internalUserId);

  // Server's honest auth state drives the mapping. Unknown/absent ⇒ treat as
  // unauthenticated (deny-by-default).
  const serverAuthState = cleanString(w.authState);

  // 'authenticated' requires BOTH the server saying so AND a resolved bridge key.
  // A missing internalUserId here is the fail-closed case: never fabricate it.
  if (serverAuthState === 'authenticated') {
    if (!internalUserId) {
      return emptySession(
        'unauthenticated',
        reasonCode ?? 'identity_resolution_error',
        requestId,
        sourceOfTruth,
      );
    }
    return {
      identity: {
        internalUserId,
        // Provider is reference-only; default to 'supabase' is NOT assumed —
        // an unrecognized/absent provider falls back to 'supabase' only because
        // the verified whoami path is Supabase-only today, but we still validate.
        authProvider: normalizeProvider(w.authProvider) ?? 'supabase',
        authProviderUid: cleanString(w.authProviderUid),
        email: cleanString(w.email),
        displayName: cleanString(w.displayName),
      },
      authorization: null, // SERVER-DERIVED authz deferred — never produced here
      authState: 'authenticated',
      sourceOfTruth,
      requestId,
      reasonCode,
    };
  }

  // Preserve 'token-verified' exactly — token proven, no app identity. Never
  // upgrade to 'authenticated', even if an internalUserId somehow appears.
  if (serverAuthState === 'token-verified') {
    return emptySession('token-verified', reasonCode, requestId, sourceOfTruth);
  }

  // Everything else (explicit 'unauthenticated', an error body, a transport
  // failure with status 0, or an unrecognized state) maps to unauthenticated.
  return emptySession('unauthenticated', reasonCode, requestId, sourceOfTruth);
}
