// Phase 4.0 M4 — the console's Firebase client sign-in (docs/phase-4/03 §2 #3, #9, #12).
//
// Its own named Firebase app, initialised with IN-MEMORY persistence: nothing the provider
// holds (the user, its refresh token, its ID token) reaches IndexedDB, localStorage or
// sessionStorage, and the tenant application's persisted instance (src/firebase.ts) is never
// touched. Exactly one ID token leaves this module per sign-in, and the provider session is
// signed out as soon as that token is read, so nothing here can mint another.

import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  getAuth,
  getMultiFactorResolver,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  TotpMultiFactorGenerator,
  type Auth,
  type MultiFactorError,
  type MultiFactorResolver,
  type UserCredential,
} from 'firebase/auth';
import firebaseConfig from '../../../firebase-applet-config.json';
import type { AdminIdentityProvider, IdentityFailure, IdentityOutcome } from './adminIdentity';

export const ADMIN_FIREBASE_APP = 'tmpos-admin-console';

const codeOf = (err: unknown): string =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '';

let auth: Auth | null = null;

function adminAuth(): Auth {
  if (auth !== null) return auth;
  const app = getApps().some((a) => a.name === ADMIN_FIREBASE_APP) ? getApp(ADMIN_FIREBASE_APP) : initializeApp(firebaseConfig, ADMIN_FIREBASE_APP);
  try {
    auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  } catch (err) {
    // Only an instance this module already initialised (in memory) may be reused; anything else
    // would fall back to the default persisted configuration.
    if (codeOf(err) !== 'auth/already-initialized') throw err;
    auth = getAuth(app);
  }
  return auth;
}

const RATE_LIMITED: ReadonlySet<string> = new Set(['auth/too-many-requests', 'auth/quota-exceeded']);
const CANCELLED: ReadonlySet<string> = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled', 'auth/popup-blocked']);
const UNAVAILABLE: ReadonlySet<string> = new Set([
  'auth/network-request-failed', 'auth/internal-error', 'auth/timeout', 'auth/web-storage-unsupported',
  'auth/operation-not-allowed', 'auth/unauthorized-domain', 'auth/invalid-api-key', 'auth/app-not-authorized',
  'auth/configuration-not-found',
]);

/** Coarse on purpose: every credential, account or code problem is 'rejected'; a fault without a provider code is 'unavailable'. */
export function failureOf(err: unknown): IdentityFailure {
  const code = codeOf(err);
  if (RATE_LIMITED.has(code)) return 'rate-limited';
  if (CANCELLED.has(code)) return 'cancelled';
  if (UNAVAILABLE.has(code) || !code.startsWith('auth/')) return 'unavailable';
  return 'rejected';
}

const discard = (a: Auth): Promise<void> => signOut(a).catch(() => undefined);

async function tokenOf(a: Auth, credential: UserCredential): Promise<IdentityOutcome> {
  try {
    return { kind: 'token', idToken: await credential.user.getIdToken() };
  } catch (err) {
    return { kind: 'failed', failure: failureOf(err) };
  } finally {
    await discard(a);
  }
}

// Authenticator-app (TOTP) codes only. A text-message code needs Firebase's reCAPTCHA verifier,
// whose script hosts the admin CSP refuses (server/runtime/adminWeb.ts; docs/phase-4/08
// G-WEBHARDEN), so an account whose only factor is a phone is refused like any other failure.
const SUPPORTED: ReadonlySet<string> = new Set([TotpMultiFactorGenerator.FACTOR_ID]);

function challengeOf(a: Auth, resolver: MultiFactorResolver): IdentityOutcome {
  const hints = resolver.hints.filter((hint) => SUPPORTED.has(hint.factorId));
  if (hints.length === 0) {
    void discard(a);
    return { kind: 'failed', failure: 'rejected' };
  }
  return {
    kind: 'second-factor',
    challenge: {
      factors: hints.map(() => 'totp' as const),
      async verify(index, code) {
        const hint = hints[index];
        if (hint === undefined) {
          await discard(a);
          return { kind: 'failed', failure: 'rejected' };
        }
        try {
          return await tokenOf(a, await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code)));
        } catch (err) {
          await discard(a);
          return { kind: 'failed', failure: failureOf(err) };
        }
      },
      cancel: () => discard(a),
    },
  };
}

export const firebaseAdminIdentity: AdminIdentityProvider = {
  async signIn(first) {
    let a: Auth;
    try {
      a = adminAuth();
    } catch {
      return { kind: 'failed', failure: 'unavailable' };
    }
    try {
      const credential =
        first.method === 'password'
          ? await signInWithEmailAndPassword(a, first.email, first.password)
          : await signInWithPopup(a, new GoogleAuthProvider());
      return await tokenOf(a, credential);
    } catch (err) {
      if (codeOf(err) === 'auth/multi-factor-auth-required') {
        try {
          return challengeOf(a, getMultiFactorResolver(a, err as MultiFactorError));
        } catch (resolverErr) {
          await discard(a);
          return { kind: 'failed', failure: failureOf(resolverErr) };
        }
      }
      await discard(a);
      return { kind: 'failed', failure: failureOf(err) };
    }
  },
};
