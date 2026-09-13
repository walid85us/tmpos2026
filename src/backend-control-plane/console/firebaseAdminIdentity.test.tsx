// Phase 4.0 M4 — the console's Firebase sign-in, with the Firebase SDK replaced at the module
// boundary: its own in-memory instance, one token out, the provider session discarded, and every
// provider error reduced to a coarse outcome that is never logged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fb = vi.hoisted(() => ({
  credential: (token: string) => ({ user: { getIdToken: vi.fn(async () => token) } }),
  initializeApp: vi.fn((_config: unknown, name: string) => ({ name })),
  getApps: vi.fn((): Array<{ name: string }> => []),
  getApp: vi.fn(),
  initializeAuth: vi.fn((_app: unknown, _deps: unknown) => ({ instance: 'admin-auth' })),
  getAuth: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(async () => undefined),
  getMultiFactorResolver: vi.fn(),
  assertionForSignIn: vi.fn((enrolment: string, code: string) => ({ enrolment, code })),
  inMemoryPersistence: { type: 'NONE' },
  recaptchaCreated: vi.fn(),
}));

vi.mock('firebase/app', () => ({ initializeApp: fb.initializeApp, getApps: fb.getApps, getApp: fb.getApp }));
vi.mock('firebase/auth', () => ({
  initializeAuth: fb.initializeAuth,
  getAuth: fb.getAuth,
  inMemoryPersistence: fb.inMemoryPersistence,
  browserPopupRedirectResolver: { kind: 'popup-resolver' },
  signInWithEmailAndPassword: fb.signInWithEmailAndPassword,
  signInWithPopup: fb.signInWithPopup,
  signOut: fb.signOut,
  getMultiFactorResolver: fb.getMultiFactorResolver,
  GoogleAuthProvider: class GoogleAuthProvider {},
  TotpMultiFactorGenerator: { FACTOR_ID: 'totp', assertionForSignIn: fb.assertionForSignIn },
  // Only a text-message sign-in constructs one; the console offers none.
  RecaptchaVerifier: class RecaptchaVerifier {
    constructor() {
      fb.recaptchaCreated();
    }
  },
}));
vi.mock('../../../firebase-applet-config.json', () => ({ default: { projectId: 'demo-synthetic', apiKey: 'synthetic-key' } }));

import { firebaseAdminIdentity } from './firebaseAdminIdentity';

const PASSWORD = { method: 'password', email: 'ops@tmpos.test', password: 'pw' } as const;
const providerError = (code: string) => Object.assign(new Error(`Firebase: Error (${code}). uid-synthetic-7f3a`), code ? { code } : {});

let logged: unknown[][];

beforeEach(() => {
  vi.clearAllMocks();
  fb.getApps.mockReturnValue([]);
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});

afterEach(() => {
  expect(logged).toEqual([]); // no provider error, token or UID ever reaches the console
  vi.restoreAllMocks();
});

describe('admin Firebase sign-in', () => {
  it('signs in on its own named app with in-memory persistence, initialised once', async () => {
    vi.resetModules();
    const { firebaseAdminIdentity: fresh } = await import('./firebaseAdminIdentity');
    fb.signInWithEmailAndPassword.mockResolvedValueOnce(fb.credential('token-1')).mockResolvedValueOnce(fb.credential('token-1'));
    await fresh.signIn(PASSWORD);
    await fresh.signIn(PASSWORD);
    expect(fb.initializeApp).toHaveBeenCalledTimes(1);
    expect(fb.initializeApp.mock.calls[0][1]).toBe('tmpos-admin-console');
    expect(fb.initializeAuth).toHaveBeenCalledTimes(1);
    expect(fb.initializeAuth.mock.calls[0][1]).toMatchObject({ persistence: fb.inMemoryPersistence });
    expect(fb.getAuth).not.toHaveBeenCalled(); // never the default, persisted configuration
  });

  it('returns exactly one token and signs the provider session out as soon as it is read', async () => {
    const credential = fb.credential('token-2');
    fb.signInWithEmailAndPassword.mockResolvedValueOnce(credential);
    expect(await firebaseAdminIdentity.signIn(PASSWORD)).toEqual({ kind: 'token', idToken: 'token-2' });
    expect(credential.user.getIdToken).toHaveBeenCalledTimes(1);
    expect(fb.signOut).toHaveBeenCalledTimes(1);
    expect(fb.signOut.mock.invocationCallOrder[0]).toBeGreaterThan(credential.user.getIdToken.mock.invocationCallOrder[0]);
  });

  it('uses the existing Google popup flow for the Google sign-in', async () => {
    fb.signInWithPopup.mockResolvedValueOnce(fb.credential('token-3'));
    expect(await firebaseAdminIdentity.signIn({ method: 'google' })).toEqual({ kind: 'token', idToken: 'token-3' });
    expect(fb.signInWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it('turns the provider MFA requirement into a challenge over the supported factors, then one token', async () => {
    const resolver = {
      hints: [
        { factorId: 'totp', uid: 'enrolment-1' },
        { factorId: 'phone', uid: 'enrolment-phone' },
        { factorId: 'unsupported-factor', uid: 'enrolment-2' },
      ],
      session: { pending: true },
      resolveSignIn: vi.fn(async () => fb.credential('token-4')),
    };
    fb.signInWithEmailAndPassword.mockRejectedValueOnce(providerError('auth/multi-factor-auth-required'));
    fb.getMultiFactorResolver.mockReturnValueOnce(resolver);
    const outcome = await firebaseAdminIdentity.signIn(PASSWORD);
    if (outcome.kind !== 'second-factor') throw new Error(`expected a challenge, got ${outcome.kind}`);
    expect(outcome.challenge.factors).toEqual(['totp']);
    expect(fb.signOut).not.toHaveBeenCalled();
    expect(await outcome.challenge.verify(0, '123456')).toEqual({ kind: 'token', idToken: 'token-4' });
    expect(fb.assertionForSignIn).toHaveBeenCalledWith('enrolment-1', '123456');
    expect(fb.signOut).toHaveBeenCalledTimes(1);
  });

  it('ends the challenge and discards the provider session when a code is wrong', async () => {
    const resolver = {
      hints: [{ factorId: 'totp', uid: 'enrolment-1' }],
      session: {},
      resolveSignIn: vi.fn(async () => {
        throw providerError('auth/invalid-verification-code');
      }),
    };
    fb.signInWithEmailAndPassword.mockRejectedValueOnce(providerError('auth/multi-factor-auth-required'));
    fb.getMultiFactorResolver.mockReturnValueOnce(resolver);
    const outcome = await firebaseAdminIdentity.signIn(PASSWORD);
    if (outcome.kind !== 'second-factor') throw new Error('expected a challenge');
    expect(await outcome.challenge.verify(0, '000000')).toEqual({ kind: 'failed', failure: 'rejected' });
    expect(fb.signOut).toHaveBeenCalledTimes(1);
  });

  it('refuses an account whose only factors the console does not support', async () => {
    fb.signInWithEmailAndPassword.mockRejectedValueOnce(providerError('auth/multi-factor-auth-required'));
    fb.getMultiFactorResolver.mockReturnValueOnce({ hints: [{ factorId: 'unsupported-factor', uid: 'e' }], session: {}, resolveSignIn: vi.fn() });
    expect(await firebaseAdminIdentity.signIn(PASSWORD)).toEqual({ kind: 'failed', failure: 'rejected' });
    expect(fb.signOut).toHaveBeenCalledTimes(1);
  });

  it('never adopts another app and falls back only to its own already-initialised instance', async () => {
    vi.resetModules();
    fb.getApps.mockReturnValue([{ name: '[DEFAULT]' }]);
    fb.initializeAuth.mockImplementationOnce(() => {
      throw Object.assign(new Error('initialised'), { code: 'auth/already-initialized' });
    });
    fb.getAuth.mockReturnValueOnce({ instance: 'admin-auth' });
    fb.signInWithEmailAndPassword.mockResolvedValueOnce(fb.credential('token-5'));
    const { firebaseAdminIdentity: fresh } = await import('./firebaseAdminIdentity');
    expect(await fresh.signIn(PASSWORD)).toEqual({ kind: 'token', idToken: 'token-5' });
    expect(fb.initializeApp.mock.calls[0][1]).toBe('tmpos-admin-console');
    expect(fb.getApp).not.toHaveBeenCalled();
    expect(fb.getAuth).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than fall back to the default persisted configuration on any other initialisation error', async () => {
    vi.resetModules();
    fb.initializeAuth.mockImplementationOnce(() => {
      throw Object.assign(new Error('bad'), { code: 'auth/argument-error' });
    });
    const { firebaseAdminIdentity: fresh } = await import('./firebaseAdminIdentity');
    expect(await fresh.signIn(PASSWORD)).toEqual({ kind: 'failed', failure: 'unavailable' });
    expect(fb.getAuth).not.toHaveBeenCalled();
    expect(fb.signInWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it('refuses a phone-only account generically and never creates a reCAPTCHA verifier', async () => {
    fb.signInWithEmailAndPassword.mockRejectedValueOnce(providerError('auth/multi-factor-auth-required'));
    fb.getMultiFactorResolver.mockReturnValueOnce({ hints: [{ factorId: 'phone', uid: 'enrolment-phone' }], session: {}, resolveSignIn: vi.fn() });
    expect(await firebaseAdminIdentity.signIn(PASSWORD)).toEqual({ kind: 'failed', failure: 'rejected' });
    expect(fb.recaptchaCreated).not.toHaveBeenCalled();
    expect(fb.signOut).toHaveBeenCalledTimes(1);
  });

  it('rejects a code for a factor the challenge does not offer, and cancelling discards the provider session', async () => {
    const resolver = { hints: [{ factorId: 'totp', uid: 'enrolment-1' }], session: {}, resolveSignIn: vi.fn() };
    fb.signInWithEmailAndPassword.mockRejectedValueOnce(providerError('auth/multi-factor-auth-required'));
    fb.getMultiFactorResolver.mockReturnValueOnce(resolver);
    const early = await firebaseAdminIdentity.signIn(PASSWORD);
    if (early.kind !== 'second-factor') throw new Error('expected a challenge');
    expect(await early.challenge.verify(1, '123456')).toEqual({ kind: 'failed', failure: 'rejected' });
    expect(resolver.resolveSignIn).not.toHaveBeenCalled();
    fb.signInWithEmailAndPassword.mockRejectedValueOnce(providerError('auth/multi-factor-auth-required'));
    fb.getMultiFactorResolver.mockReturnValueOnce(resolver);
    const later = await firebaseAdminIdentity.signIn(PASSWORD);
    if (later.kind !== 'second-factor') throw new Error('expected a challenge');
    await later.challenge.cancel();
    expect(fb.signOut).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['auth/invalid-credential', 'rejected'],
    ['auth/wrong-password', 'rejected'],
    ['auth/user-not-found', 'rejected'],
    ['auth/user-disabled', 'rejected'],
    ['auth/too-many-requests', 'rate-limited'],
    ['auth/network-request-failed', 'unavailable'],
    ['auth/internal-error', 'unavailable'],
    ['auth/popup-closed-by-user', 'cancelled'],
    ['', 'unavailable'],
  ])('reduces provider error %s to %s and discards the provider session', async (code, failure) => {
    fb.signInWithEmailAndPassword.mockRejectedValueOnce(providerError(code));
    expect(await firebaseAdminIdentity.signIn(PASSWORD)).toEqual({ kind: 'failed', failure });
    expect(fb.signOut).toHaveBeenCalledTimes(1);
  });
});
