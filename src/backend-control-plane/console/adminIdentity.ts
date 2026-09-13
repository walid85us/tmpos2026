// Phase 4.0 M4 — the console's view of the identity provider (Firebase, ADR-03): a first
// factor, then — when the account requires it — the provider's second-factor challenge, and
// finally one short-lived ID token for the server login exchange. The implementation
// (firebaseAdminIdentity.ts) loads only when someone signs in, so opening the console
// contacts no provider.

export type FirstFactor =
  | { readonly method: 'password'; readonly email: string; readonly password: string }
  | { readonly method: 'google' };

/** Authenticator-app codes only; the text-message factor is not offered (firebaseAdminIdentity.ts SUPPORTED). */
export type SecondFactorKind = 'totp';

/** Why no token was produced; deliberately coarse, because the page shows one generic denial. */
export type IdentityFailure = 'rejected' | 'rate-limited' | 'unavailable' | 'cancelled';

export type IdentityOutcome =
  | { readonly kind: 'token'; readonly idToken: string }
  | { readonly kind: 'second-factor'; readonly challenge: SecondFactorChallenge }
  | { readonly kind: 'failed'; readonly failure: IdentityFailure };

export interface SecondFactorChallenge {
  /** The enrolled factors the console supports, in the provider's order. */
  readonly factors: readonly SecondFactorKind[];
  /** Finish signing in with a code; the result is a token or a failure, never another challenge. */
  verify(index: number, code: string): Promise<IdentityOutcome>;
  /** Abandon the challenge and discard the provider session. */
  cancel(): Promise<void>;
}

export interface AdminIdentityProvider {
  signIn(first: FirstFactor): Promise<IdentityOutcome>;
}

/** The Firebase provider, fetched on first use; a failure to load reads as the provider being unavailable. */
export const lazyFirebaseIdentity: AdminIdentityProvider = {
  async signIn(first) {
    let provider: AdminIdentityProvider;
    try {
      provider = (await import('./firebaseAdminIdentity')).firebaseAdminIdentity;
    } catch {
      return { kind: 'failed', failure: 'unavailable' };
    }
    return provider.signIn(first);
  },
};
