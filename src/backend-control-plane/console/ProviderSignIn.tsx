// Phase 4.0 M5-ADMIN-STEPUP-P1 — the provider sign-in steps, shared by the console sign-in (SignInScreen.tsx) and the
// recent sign-in a lifecycle action asks for (TenantManagementPage.tsx): the provider's first factor (password or
// Google), its second-factor challenge when the account requires one, and then one ID token handed to the caller.
// Nothing here talks to the server: the caller decides where the token goes (the login exchange, or the
// re-authentication of the administrator already signed in), and the server decides what it proves.

import React from 'react';
import { cx } from '../ui';
import type { FirstFactor, IdentityOutcome, SecondFactorChallenge, SecondFactorKind } from './adminIdentity';
import { useConsole } from './consoleContext';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FOCUS_RING } from './ConsolePages';

/** Why the provider produced no token, as the page says it; deliberately coarse (docs/phase-4/03 §2 #11). */
export type ProviderNotice = 'denied' | 'rate-limited' | 'unavailable' | 'cancelled';

export const PROVIDER_NOTICE_TEXT: Readonly<Record<ProviderNotice, string>> = {
  denied: 'Sign-in failed. Check your details and try again.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try again.',
  unavailable: 'Sign-in is temporarily unavailable.',
  cancelled: 'Sign-in was cancelled.',
};

const FACTOR_LABELS: Readonly<Record<SecondFactorKind, string>> = { totp: 'Authenticator app' };
const CODE_RE = /^\d{6}$/;

const FIELD = cx(
  'block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder:text-slate-400',
  'focus-visible:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 disabled:opacity-60',
);

function Field({ id, label, error, children }: { id: string; label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-200">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type ProviderSignIn = ReturnType<typeof useProviderSignIn>;

/**
 * The provider steps of one sign-in. `busy` is the caller's own work (a login exchange, a sign-out) that also holds the
 * controls; `onToken` is the token's only destination, called once per provider sign-in.
 */
export function useProviderSignIn({ busy: external, onToken }: { busy: boolean; onToken: (idToken: string) => Promise<void> }) {
  const { identity } = useConsole();
  const [factors, setFactors] = React.useState<readonly SecondFactorKind[] | null>(null); // null: the first-factor step
  const [factor, setFactor] = React.useState(0);
  const [working, setWorking] = React.useState(false);
  const [notice, setNotice] = React.useState<ProviderNotice | null>(null);
  // Every credential field is uncontrolled on purpose: React mirrors a controlled input's value into
  // its value attribute, which would put the email, the password or a code in the markup. Each is
  // read from its field on submit. None has a name either, so a native submission (an extension
  // calling form.submit(), which skips onSubmit) would carry none of them into the URL.
  const emailInput = React.useRef<HTMLInputElement | null>(null);
  const passwordInput = React.useRef<HTMLInputElement>(null);
  const codeInput = React.useRef<HTMLInputElement>(null);
  const [codeError, setCodeError] = React.useState(false);
  // The email last submitted, put back into its field (as the value, never an attribute) when the
  // first step returns after a second-factor step.
  const submittedEmail = React.useRef('');
  const attachEmail = React.useCallback((node: HTMLInputElement | null) => {
    emailInput.current = node;
    if (node !== null) node.value = submittedEmail.current;
  }, []);
  const alive = React.useRef(true);
  const attempt = React.useRef(false);
  const challenge = React.useRef<SecondFactorChallenge | null>(null);
  const deliver = React.useRef(onToken);
  deliver.current = onToken;

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Leaving mid-challenge discards the provider session.
      const pending = challenge.current;
      challenge.current = null;
      void pending?.cancel();
    };
  }, []);

  const busy = working || external;

  function toFirstStep(next: ProviderNotice | null): void {
    challenge.current = null;
    setFactors(null);
    setFactor(0);
    setCodeError(false);
    setNotice(next);
  }

  async function settle(outcome: IdentityOutcome): Promise<void> {
    if (!alive.current) {
      // The page is gone: a pending challenge is discarded and a token is never exchanged.
      if (outcome.kind === 'second-factor') void outcome.challenge.cancel();
      return;
    }
    if (outcome.kind === 'second-factor') {
      challenge.current = outcome.challenge;
      setFactor(0);
      setCodeError(false);
      setFactors(outcome.challenge.factors);
      return;
    }
    if (outcome.kind === 'failed') return toFirstStep(outcome.failure === 'rejected' ? 'denied' : outcome.failure);
    toFirstStep(null);
    await deliver.current(outcome.idToken); // the token's only destination
  }

  async function guarded(task: () => Promise<void>): Promise<void> {
    if (attempt.current) return; // one attempt at a time: a double submit is dropped
    attempt.current = true;
    setWorking(true);
    setNotice(null);
    try {
      await task();
    } finally {
      attempt.current = false;
      if (alive.current) setWorking(false);
    }
  }

  /** `closed`: the caller keeps the first step shut (the service is known to be down). */
  function submitFirstFactor(event: React.SyntheticEvent<HTMLFormElement>, closed: boolean): void {
    event.preventDefault();
    if (busy || closed) return;
    const typedEmail = emailInput.current?.value ?? '';
    const field = passwordInput.current;
    const first: FirstFactor = { method: 'password', email: typedEmail.trim(), password: field?.value ?? '' };
    if (field) field.value = '';
    submittedEmail.current = typedEmail;
    void guarded(async () => settle(await identity.signIn(first)));
  }

  function continueWithGoogle(closed: boolean): void {
    if (busy || closed) return;
    void guarded(async () => settle(await identity.signIn({ method: 'google' })));
  }

  function submitSecondFactor(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const pending = challenge.current;
    const field = codeInput.current;
    if (pending === null || field === null || busy) return;
    const entered = field.value;
    if (!CODE_RE.test(entered)) {
      setCodeError(true);
      return;
    }
    field.value = '';
    setCodeError(false);
    challenge.current = null; // single use: a failed code ends the challenge
    void guarded(async () => settle(await pending.verify(factor, entered)));
  }

  async function differentAccount(): Promise<void> {
    const pending = challenge.current;
    toFirstStep(null);
    await pending?.cancel();
  }

  function chooseFactor(index: number): void {
    setFactor(index);
    if (codeInput.current) codeInput.current.value = '';
    setCodeError(false);
  }

  return {
    factors, factor, working, busy, notice, codeError, attachEmail, passwordInput, codeInput,
    step: factors === null ? ('first' as const) : ('second' as const),
    setNotice, submitFirstFactor, continueWithGoogle, submitSecondFactor, differentAccount, chooseFactor,
    focusEmail: (): void => emailInput.current?.focus(),
  };
}

/** The first step: email and password, or Google. `prefix` keeps the field ids unique to their screen. */
export function FirstFactorForm({ flow, prefix, closed = false }: { flow: ProviderSignIn; prefix: string; closed?: boolean }) {
  const { busy } = flow;
  return (
    <>
      <form className="mt-6 space-y-4" onSubmit={(event) => flow.submitFirstFactor(event, closed)} aria-busy={busy}>
        <Field id={`${prefix}-email`} label="Email">
          <input
            ref={flow.attachEmail}
            id={`${prefix}-email`}
            type="email"
            autoComplete="username"
            required
            disabled={busy}
            className={FIELD}
          />
        </Field>
        <Field id={`${prefix}-password`} label="Password">
          <input
            id={`${prefix}-password`}
            type="password"
            autoComplete="current-password"
            required
            ref={flow.passwordInput}
            disabled={busy}
            className={FIELD}
          />
        </Field>
        <button type="submit" disabled={busy || closed} className={BUTTON_PRIMARY}>
          Sign in
        </button>
      </form>
      <div className="my-5 flex items-center gap-3 text-xs text-slate-400" aria-hidden="true">
        <span className="h-px flex-1 bg-slate-800" />
        or
        <span className="h-px flex-1 bg-slate-800" />
      </div>
      <button type="button" onClick={() => flow.continueWithGoogle(closed)} disabled={busy || closed} className={BUTTON_SECONDARY}>
        Continue with Google
      </button>
    </>
  );
}

/** The second step: the provider's challenge, answered with a code from the chosen factor. */
export function SecondFactorForm({ flow, prefix }: { flow: ProviderSignIn; prefix: string }) {
  const { busy, factors, factor, codeError } = flow;
  if (factors === null) return null;
  return (
    <>
      {factors.length > 1 ? (
        <div role="radiogroup" aria-label="Verification method" className="mt-5 grid gap-2">
          {factors.map((kind, index) => (
            <label
              key={`${kind}-${index}`}
              className={cx(
                'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm',
                index === factor ? 'border-emerald-400 bg-slate-950 text-white' : 'border-slate-700 text-slate-200 hover:border-slate-600',
              )}
            >
              <input
                type="radio"
                name={`${prefix}-factor`}
                value={index}
                checked={index === factor}
                onChange={() => flow.chooseFactor(index)}
                disabled={busy}
                className="h-4 w-4 accent-emerald-400"
              />
              {FACTOR_LABELS[kind]}
            </label>
          ))}
        </div>
      ) : null}
      <form className="mt-5 space-y-4" onSubmit={flow.submitSecondFactor} noValidate aria-busy={busy}>
        <Field id={`${prefix}-code`} label="Verification code" error={codeError ? 'Enter the 6-digit code.' : null}>
          <input
            ref={flow.codeInput}
            id={`${prefix}-code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            // Digits only, at most six. No maxLength: it would cut a pasted "123 456" to
            // six characters before the space is stripped, losing a digit.
            onInput={(event) => {
              const field = event.currentTarget;
              const digits = field.value.replace(/\D/g, '').slice(0, 6);
              if (digits !== field.value) field.value = digits;
            }}
            aria-invalid={codeError}
            aria-describedby={codeError ? `${prefix}-code-error` : undefined}
            disabled={busy}
            className={cx(FIELD, 'tracking-[0.3em]')}
          />
        </Field>
        <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
          Verify
        </button>
      </form>
      <button
        type="button"
        onClick={() => void flow.differentAccount()}
        disabled={busy}
        className={cx('mt-5 rounded-md text-sm font-medium text-slate-300 underline-offset-4 hover:text-white hover:underline', FOCUS_RING)}
      >
        Use a different account
      </button>
    </>
  );
}
