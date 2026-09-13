// Phase 3.0 M3 Gate 1 — server-only Firebase Admin ID-token verification adapter (built for the DEV pilot;
// Phase 4.0 M4 adapts it to the runtime's authenticator port through createRuntimeIdentityVerifier, which also
// reports the verified token's sign-in time and second factor as login evidence).
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
import { createHash, createPrivateKey } from 'node:crypto';

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
/** The runtime authenticator's own Admin app, so it never shares the DEV pilot's configuration. */
const RUNTIME_APP_NAME = 'tmpos-runtime-verifier';

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

/**
 * Injectable verifier seam. Resolves the decoded UID — plus the token's verified `auth_time` (seconds) and
 * `firebase.sign_in_second_factor` — or throws (Firebase `auth/*` / `app/*` code, or our unavailable).
 */
export interface FirebaseIdTokenVerifier {
  verify(idToken: string): Promise<{ uid: string; authTime?: unknown; secondFactor?: unknown }>;
}

function unavailable(): Error { const e: any = new Error('firebase_admin_unavailable'); e.code = 'firebase_admin_unavailable'; return e; }

/** Lazily init (or reuse) the isolated, named Admin app. Parses the secret ONLY here, at first real use. */
function initOrGetAdminApp(appName: string, serviceAccountJson: string | undefined): App {
  const existing = getApps().find((a) => a.name === appName);
  if (existing) return existing; // reuse across hot-reload / repeated calls (singleton)
  const parsed = parseServiceAccountJson(serviceAccountJson);
  if (!parsed.ok || !parsed.serviceAccount) throw unavailable();
  const sa = parsed.serviceAccount;
  // cert() takes only the credential; projectId pins the audience/issuer. Options are NEVER logged.
  return initializeApp(
    { credential: cert({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey }), projectId: sa.projectId },
    appName,
  );
}

/**
 * The DEFAULT verifier: real firebase-admin, lazy-initialized, checkRevoked=true. With no source it is the
 * DEV pilot's app over the process environment; the runtime passes its own app name and exactly the
 * service-account JSON its composition validated.
 */
export function getDefaultFirebaseVerifier(source: { appName?: string; serviceAccountJson?: string } = {}): FirebaseIdTokenVerifier {
  return {
    async verify(idToken: string): Promise<{ uid: string; authTime: unknown; secondFactor: unknown }> {
      let app: App;
      try {
        app = initOrGetAdminApp(source.appName ?? ADMIN_APP_NAME, source.serviceAccountJson ?? process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON);
      } catch { throw unavailable(); } // init/config failure ⇒ unavailable
      const decoded = await getAuth(app).verifyIdToken(idToken, true);   // signature+aud+iss+exp+revoked+disabled
      // Claims of the verified token only: when the user signed in, and with which second factor.
      return { uid: decoded.uid, authTime: decoded.auth_time, secondFactor: decoded.firebase?.sign_in_second_factor };
    },
  };
}

// The credential verdicts verifyIdToken(token, checkRevoked=true) can reach: an expired, revoked, malformed
// or foreign-tenant token, or a disabled or deleted user. Anything else — a network failure or timeout, an
// Admin credential the provider will not honour, an internal error, a code this SDK version does not list —
// is an outage or a fault, never a verdict on the credential; both fail closed.
const VERDICTS: ReadonlyMap<string, FirebaseAuthErrorCode> = new Map<string, FirebaseAuthErrorCode>([
  ['auth/id-token-expired', 'authentication_expired'],
  ['auth/id-token-revoked', 'authentication_revoked'],
  ['auth/user-disabled', 'authentication_disabled'],
  ['auth/argument-error', 'authentication_invalid'],
  ['auth/invalid-id-token', 'authentication_invalid'],
  ['auth/mismatching-tenant-id', 'authentication_invalid'],
  ['auth/user-not-found', 'authentication_invalid'],
]);
// firebase-admin 13 folds a failure to fetch its signing keys into auth/argument-error — the code a
// malformed token gets — distinguishable only by the SDK's own message prefixes (pinned by the adapter test).
const KEY_FETCH_PREFIXES: readonly string[] = ['Error fetching public keys', 'Error while making request'];

function mapFirebaseError(e: unknown): FirebaseAuthErrorCode {
  const code = e && typeof e === 'object' && typeof (e as any).code === 'string' ? ((e as any).code as string) : '';
  const message = e instanceof Error ? e.message : '';
  if (code === 'auth/argument-error' && KEY_FETCH_PREFIXES.some((prefix) => message.startsWith(prefix))) return 'authentication_unavailable';
  return VERDICTS.get(code) ?? 'authentication_unavailable';
}

/** Whether `pem` parses as a private key (node:crypto, in memory, no network). */
function isPrivateKey(pem: string): boolean {
  try { createPrivateKey(pem); return true; } catch { return false; }
}

/** Composition refusal. Carries a bounded code only — never configuration content. */
export class IdentityCompositionError extends Error {
  readonly code = 'identity_verifier_unconfigured';
  constructor() {
    super('identity verifier composition refused: identity_verifier_unconfigured');
    this.name = 'IdentityCompositionError';
  }
}

/** The runtime's header-only credential view (server/runtime/access.ts BearerTokenView), structurally. */
export interface RuntimeCredential { readonly bearerToken: string; }
/** A verified identity key and the token's verified evidence (null wherever absent or malformed). */
export interface RuntimeVerifiedIdentity {
  readonly verified: true;
  readonly authProvider: 'firebase';
  readonly authProviderUid: string;
  /** The token's `auth_time`, in epoch milliseconds. */
  readonly authenticatedAt: number | null;
  /** The token's `firebase.sign_in_second_factor`, e.g. `totp` or `phone`. */
  readonly secondFactor: string | null;
}

/**
 * Phase 4.0 M4 — this adapter as the runtime's PRODUCTION authenticator, in its port shape
 * (server/runtime/access.ts RequestAuthenticator): the frozen credential view in, a verified identity key
 * out, or null on any failure. Composition refuses (IdentityCompositionError) when the service-account
 * configuration is absent or invalid, so no session boundary can start without it, and there is no
 * fallback — never a DEV or diagnostic adapter. Verification is verifyFirebaseBearer below, unchanged
 * (checkRevoked=true, sanitized codes, nothing logged). `env` is injected (this function never reads the
 * process environment), and the default verifier runs on the runtime's own named Admin app over exactly
 * the service-account JSON validated here — never the DEV pilot's app or another configuration. The verified
 * token's sign-in time and second factor travel with the identity as login evidence, which the runtime's
 * boundary policy judges; nothing the client asserts does. A call whose deadline signal has already fired is
 * refused before the provider is consulted; one in flight cannot be cancelled (verifyIdToken takes no signal),
 * so the runtime's deadline bounds it instead.
 */
export function createRuntimeIdentityVerifier(
  env: Record<string, string | undefined>,
  deps: { verifier?: FirebaseIdTokenVerifier } = {},
): { verify(credential: RuntimeCredential, signal?: AbortSignal): Promise<RuntimeVerifiedIdentity | null> } {
  const serviceAccountJson = env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON;
  const parsed = parseServiceAccountJson(serviceAccountJson);
  // The key is parsed now, locally: a truncated or corrupt key refuses composition instead of passing it
  // and failing every login later as an outage.
  if (!parsed.ok || !parsed.serviceAccount || !isPrivateKey(parsed.serviceAccount.privateKey)) throw new IdentityCompositionError();
  // One Admin app per validated configuration, so a composition with another configuration never reuses
  // this one's app. The name carries a digest of the configuration, never the configuration itself.
  const appName = `${RUNTIME_APP_NAME}-${createHash('sha256').update(serviceAccountJson as string).digest('hex').slice(0, 16)}`;
  const verifier = deps.verifier ?? getDefaultFirebaseVerifier({ appName, serviceAccountJson });
  return {
    async verify(credential: RuntimeCredential, signal?: AbortSignal): Promise<RuntimeVerifiedIdentity | null> {
      if (signal?.aborted) throw unavailable();
      const result = await verifyFirebaseIdentity(`Bearer ${credential.bearerToken}`, { verifier });
      if (result.ok && result.firebaseUid) {
        const { authTime, secondFactor } = result;
        return {
          verified: true, authProvider: 'firebase', authProviderUid: result.firebaseUid,
          authenticatedAt: typeof authTime === 'number' && Number.isSafeInteger(authTime) && authTime > 0 ? authTime * 1000 : null,
          secondFactor: typeof secondFactor === 'string' ? secondFactor : null,
        };
      }
      // An outage must not read as a bad credential: it throws (the runtime answers a bounded 503 and logs
      // `authn_unavailable`), while every credential failure is a plain null (a 401, `authn_rejected`).
      if (result.code === 'authentication_unavailable') throw unavailable();
      return null;
    },
  };
}

// One interface with optional fields, like FirebaseVerifyResult: this file compiles non-strict,
// where narrowing a union on its boolean tag is lossy.
interface IdentityResult { ok: boolean; firebaseUid?: string; authTime?: unknown; secondFactor?: unknown; code?: FirebaseAuthErrorCode; }

/** The one verification path: a sanitized code on failure; the UID and the token's evidence on success. */
async function verifyFirebaseIdentity(
  headerValue: string | string[] | undefined,
  deps: { verifier?: FirebaseIdTokenVerifier },
): Promise<IdentityResult> {
  const extracted = extractBearerCredential(headerValue);
  if (!extracted.ok || !extracted.token) return { ok: false, code: extracted.code ?? 'authentication_invalid' };
  const verifier = deps.verifier ?? getDefaultFirebaseVerifier();
  try {
    const decoded = await verifier.verify(extracted.token);
    if (!decoded || typeof decoded.uid !== 'string' || decoded.uid.length === 0) return { ok: false, code: 'authentication_invalid' };
    return { ok: true, firebaseUid: decoded.uid, authTime: decoded.authTime, secondFactor: decoded.secondFactor };
  } catch (e) {
    return { ok: false, code: mapFirebaseError(e) };
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
  const result = await verifyFirebaseIdentity(headerValue, deps);
  return result.ok && result.firebaseUid ? { ok: true, firebaseUid: result.firebaseUid } : { ok: false, code: result.code ?? 'authentication_invalid' };
}
