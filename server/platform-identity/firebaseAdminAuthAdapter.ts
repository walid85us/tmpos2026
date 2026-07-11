// Phase 3.0 M3 Gate 1 — DEV-only, server-only Firebase Admin ID-token verification adapter.
//
// PURPOSE: the ONE place that verifies a Firebase ID token server-side and returns the minimum verified
// identity material (the Firebase UID) for a downstream read-only internal-identity lookup. It is the ONLY
// module permitted to import `firebase-admin/app` + `firebase-admin/auth` (enforced by the route-registration
// boundary test). It imports NO other firebase-admin service (no firestore/database/storage/messaging/
// remote-config/app-check) and NEVER writes to Firebase.
//
// SAFETY (binding):
//   - Firebase remains authoritative; verification is cryptographic via Firebase Admin `verifyIdToken(token, true)`
//     (checkRevoked=true ⇒ also rejects revoked tokens and disabled users through read-only Auth access).
//   - LAZY: module import parses NO secret and initializes NO Admin app. Initialization happens only on the
//     first real verification call. A missing/invalid credential fails closed as `authentication_unavailable`.
//   - The service-account JSON is read ONLY from the runtime env, parsed ONLY in memory, and NEVER logged,
//     returned to a caller, written to disk, or cached to a file. No token, decoded claim, email, UID, or key
//     material is ever logged or returned beyond the in-process `firebaseUid` needed for the next step.
//   - Dependency-injectable verifier seam so unit tests are deterministic and touch no real Firebase/network.
//   - No Supabase import or fallback.
//
// Never imported by src/ (the client bundle).

import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/** Sanitized, closed set of verification outcomes. NEVER leaks provider detail. */
export type FirebaseAuthErrorCode =
  | 'authentication_required'
  | 'authentication_invalid'
  | 'authentication_expired'
  | 'authentication_revoked'
  | 'authentication_disabled'
  | 'authentication_unavailable';

/** Generous upper bound on a Bearer credential length (Firebase ID tokens are ~1-2KB; claims can enlarge). */
export const FIREBASE_ID_TOKEN_MAX_LEN = 8192;

/** Isolated named Admin app so we never collide with any other firebase-admin init. */
const ADMIN_APP_NAME = 'bcp-action-verifier';

export interface ParsedServiceAccount { projectId: string; clientEmail: string; privateKey: string; }
export interface ParseResult { ok: boolean; serviceAccount?: ParsedServiceAccount; reason?: string; }

/**
 * Pure, in-memory validation of the service-account JSON. NO firebase-admin call, NO network, NO logging.
 * `reason` is an internal label (never surfaced to a client). Returns the parsed fields for `cert()` on success.
 */
export function parseServiceAccountJson(raw: string | undefined, expectedProjectId?: string): ParseResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'missing' };
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'malformed_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed_json' };
  if (parsed.type !== 'service_account') return { ok: false, reason: 'wrong_type' };
  const projectId = typeof parsed.project_id === 'string' ? parsed.project_id : '';
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email : '';
  const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
  if (!projectId || !clientEmail || !privateKey) return { ok: false, reason: 'missing_field' };
  if (expectedProjectId && projectId !== expectedProjectId) return { ok: false, reason: 'project_mismatch' };
  return { ok: true, serviceAccount: { projectId, clientEmail, privateKey } };
}

export interface BearerExtractResult { ok: boolean; token?: string; code?: FirebaseAuthErrorCode; }

/**
 * Extract EXACTLY ONE Bearer credential. Rejects missing (→required), and empty/malformed/multiple/oversized
 * (→invalid). Never logs the token.
 */
export function extractBearerCredential(headerValue: string | string[] | undefined): BearerExtractResult {
  if (Array.isArray(headerValue)) return { ok: false, code: 'authentication_invalid' }; // multiple header values
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) return { ok: false, code: 'authentication_required' };
  const m = /^Bearer\s+(.*)$/i.exec(headerValue.trim());
  if (!m) return { ok: false, code: 'authentication_invalid' };          // missing/other scheme
  const rest = m[1].trim();
  if (rest.length === 0) return { ok: false, code: 'authentication_invalid' };        // empty token
  if (/\s/.test(rest)) return { ok: false, code: 'authentication_invalid' };          // >1 token
  if (rest.length > FIREBASE_ID_TOKEN_MAX_LEN) return { ok: false, code: 'authentication_invalid' }; // oversized
  return { ok: true, token: rest };
}

/** In-process verification result. `firebaseUid` is for the next in-process step ONLY; never surfaced/logged. */
export interface FirebaseVerifyResult { ok: boolean; firebaseUid?: string; code?: FirebaseAuthErrorCode; }

/** Injectable verifier seam. Resolves the decoded UID or throws (Firebase `auth/*` code, or our unavailable). */
export interface FirebaseIdTokenVerifier { verify(idToken: string): Promise<{ uid: string }>; }

function unavailable(): Error { const e: any = new Error('firebase_admin_unavailable'); e.code = 'firebase_admin_unavailable'; return e; }

/** Lazily init (or reuse) the isolated Admin app. Parses the secret ONLY here, at first real use. */
function initOrGetAdminApp(): App {
  const existing = getApps().find((a) => a.name === ADMIN_APP_NAME);
  if (existing) return existing; // reuse across hot-reload / repeated calls (singleton)
  const parsed = parseServiceAccountJson(process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON);
  if (!parsed.ok || !parsed.serviceAccount) throw unavailable();
  const sa = parsed.serviceAccount;
  // cert() takes only the credential; projectId pins the audience/issuer. Options are NEVER logged.
  return initializeApp(
    { credential: cert({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey }), projectId: sa.projectId },
    ADMIN_APP_NAME,
  );
}

/** The DEFAULT runtime verifier: real firebase-admin, lazy-initialized, checkRevoked=true. */
export function getDefaultFirebaseVerifier(): FirebaseIdTokenVerifier {
  return {
    async verify(idToken: string): Promise<{ uid: string }> {
      let app: App;
      try { app = initOrGetAdminApp(); } catch { throw unavailable(); } // init/config failure ⇒ unavailable
      const decoded = await getAuth(app).verifyIdToken(idToken, true);   // signature+aud+iss+exp+revoked+disabled
      return { uid: decoded.uid };
    },
  };
}

function mapFirebaseError(e: unknown): FirebaseAuthErrorCode {
  const code = e && typeof e === 'object' && typeof (e as any).code === 'string' ? ((e as any).code as string) : '';
  if (code === 'firebase_admin_unavailable') return 'authentication_unavailable';
  switch (code) {
    case 'auth/id-token-expired': return 'authentication_expired';
    case 'auth/id-token-revoked': return 'authentication_revoked';
    case 'auth/user-disabled': return 'authentication_disabled';
    case 'auth/internal-error':
    case 'auth/network-error': return 'authentication_unavailable';
    default: return 'authentication_invalid'; // any other verification failure fails closed as invalid
  }
}

/**
 * Verify a Firebase Bearer credential. FAIL-CLOSED. Returns ONLY `{ ok, firebaseUid }` or `{ ok:false, code }`.
 * The raw token, decoded token, claims, and email are NEVER returned or logged.
 */
export async function verifyFirebaseBearer(
  headerValue: string | string[] | undefined,
  deps: { verifier?: FirebaseIdTokenVerifier } = {},
): Promise<FirebaseVerifyResult> {
  const extracted = extractBearerCredential(headerValue);
  if (!extracted.ok || !extracted.token) return { ok: false, code: extracted.code ?? 'authentication_invalid' };
  const verifier = deps.verifier ?? getDefaultFirebaseVerifier();
  try {
    const decoded = await verifier.verify(extracted.token);
    if (!decoded || typeof decoded.uid !== 'string' || decoded.uid.length === 0) return { ok: false, code: 'authentication_invalid' };
    return { ok: true, firebaseUid: decoded.uid };
  } catch (e) {
    return { ok: false, code: mapFirebaseError(e) };
  }
}
