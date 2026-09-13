// Phase 4.0 M4 — the console sign-in: the provider's first factor, its second-factor challenge
// when the account requires one, then the server login exchange. Every refusal reads the same,
// whatever caused it (docs/phase-4/03 §2 #11): the page never says whether an account exists,
// lacks admission or a role, failed its second factor, or is suspended.

import React from 'react';
import { cx } from '../ui';
import type { FirstFactor, IdentityOutcome, SecondFactorChallenge, SecondFactorKind } from './adminIdentity';
import type { SessionNotice } from './adminSessionClient';
import { useConsole, useSessionState } from './consoleContext';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Brand, FOCUS_RING, Spinner } from './ConsolePages';

type Notice = SessionNotice | 'cancelled';

const NOTICES: Readonly<Record<Notice, { readonly text: string; readonly tone: 'error' | 'warning' | 'info' }>> = {
  denied: { text: 'Sign-in failed. Check your details and try again.', tone: 'error' },
  'rate-limited': { text: 'Too many attempts. Wait a few minutes, then try again.', tone: 'warning' },
  unavailable: { text: 'Sign-in is temporarily unavailable.', tone: 'warning' },
  expired: { text: 'Your session has ended. Sign in again to continue.', tone: 'info' },
  'logged-out': { text: 'You have signed out.', tone: 'info' },
  'logged-out-unconfirmed': {
    text: 'You have signed out on this device. The server did not confirm it, so the session ends on its own within 15 minutes.',
    tone: 'info',
  },
  cancelled: { text: 'Sign-in was cancelled.', tone: 'info' },
};

const TONES = {
  error: 'border-rose-800 bg-rose-950 text-rose-100',
  warning: 'border-amber-800 bg-amber-950 text-amber-100',
  info: 'border-sky-800 bg-sky-950 text-sky-100',
} as const;

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

function NoticeBanner({ notice, action }: { notice: Notice; action: React.ReactNode }) {
  const { text, tone } = NOTICES[notice];
  return (
    <div
      id="console-notice"
      role={tone === 'info' ? 'status' : 'alert'}
      className={cx('mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm', TONES[tone])}
    >
      <p>{text}</p>
      {action}
    </div>
  );
}

export default function SignInScreen() {
  const { client, identity, screens } = useConsole();
  const state = useSessionState();
  const [factors, setFactors] = React.useState<readonly SecondFactorKind[] | null>(null); // null: the first-factor step
  const [factor, setFactor] = React.useState(0);
  const [working, setWorking] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [localNotice, setLocalNotice] = React.useState<Notice | null>(null);
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
  const heading = React.useRef<HTMLHeadingElement>(null);
  const lastStep = React.useRef<string | null>(null);
  const arrived = React.useRef<boolean | null>(null);
  if (arrived.current === null) arrived.current = screens.shown;

  React.useEffect(() => {
    alive.current = true;
    screens.shown = true;
    document.title = 'Sign in · Control Plane';
    return () => {
      alive.current = false;
      // Leaving mid-challenge discards the provider session.
      const pending = challenge.current;
      challenge.current = null;
      void pending?.cancel();
    };
  }, []);

  // Arriving from another console screen, or moving between the two steps, puts focus on the
  // heading, which also reads out any notice; the document's first screen keeps the natural order.
  const step = factors === null ? 'first' : 'second';
  React.useEffect(() => {
    const first = lastStep.current === null;
    const changed = !first && lastStep.current !== step; // false for React's dev re-run of this effect
    lastStep.current = step;
    if (changed || (first && arrived.current)) heading.current?.focus();
  }, [step]);

  const sessionNotice = state.phase === 'signed-out' ? state.notice : null;
  const notice = localNotice ?? sessionNotice;
  const serviceDown = localNotice === null && sessionNotice === 'unavailable';
  const busy = working || state.phase === 'signing-in' || state.phase === 'signing-out';

  function toFirstStep(next: Notice | null): void {
    challenge.current = null;
    setFactors(null);
    setFactor(0);
    setCodeError(false);
    setLocalNotice(next);
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
    await client.exchange(outcome.idToken); // the token's only destination
  }

  async function guarded(task: () => Promise<void>): Promise<void> {
    if (attempt.current) return; // one attempt at a time: a double submit is dropped
    attempt.current = true;
    setWorking(true);
    setLocalNotice(null);
    try {
      await task();
    } finally {
      attempt.current = false;
      if (alive.current) setWorking(false);
    }
  }

  function submitFirstFactor(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || serviceDown) return;
    const typedEmail = emailInput.current?.value ?? '';
    const field = passwordInput.current;
    const first: FirstFactor = { method: 'password', email: typedEmail.trim(), password: field?.value ?? '' };
    if (field) field.value = '';
    submittedEmail.current = typedEmail;
    void guarded(async () => settle(await identity.signIn(first)));
  }

  function continueWithGoogle() {
    if (busy || serviceDown) return;
    void guarded(async () => settle(await identity.signIn({ method: 'google' })));
  }

  function submitSecondFactor(event: React.SyntheticEvent<HTMLFormElement>) {
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

  async function useDifferentAccount() {
    const pending = challenge.current;
    toFirstStep(null);
    await pending?.cancel();
  }

  async function retry() {
    setRetrying(true);
    await client.bootstrap();
    if (!alive.current) return;
    setRetrying(false);
    emailInput.current?.focus(); // the retry button may be gone now
  }

  const progress = working && factors !== null ? 'Verifying…' : 'Signing in…';

  return (
    <main id="main-content" className="min-h-screen bg-slate-950 px-4 py-12 sm:py-20">
      <div className="mx-auto w-full max-w-[26rem]">
        <Brand />
        <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/40 sm:p-8">
          {state.phase === 'checking' ? (
            <p role="status" className="flex items-center gap-3 text-sm text-slate-300">
              <Spinner className="h-5 w-5 text-emerald-300" />
              Checking your session…
            </p>
          ) : factors === null ? (
            // Keyed so the two steps never share DOM nodes: a reused uncontrolled field would carry
            // the email into the code field.
            <React.Fragment key="first-factor">
              <h1
                ref={heading}
                tabIndex={-1}
                aria-describedby={notice !== null ? 'console-notice' : undefined}
                className="text-xl font-bold tracking-tight text-white focus:outline-none"
              >
                Sign in to the Control Plane
              </h1>
              <p className="mt-2 text-sm text-slate-400">
                Signing in at <span className="font-semibold text-slate-200">{window.location.host}</span>
              </p>
              {notice !== null ? (
                <NoticeBanner
                  notice={notice}
                  action={
                    serviceDown ? (
                      <button
                        type="button"
                        onClick={retry}
                        disabled={retrying}
                        className={cx('rounded-md bg-amber-300 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-200 disabled:cursor-not-allowed', FOCUS_RING)}
                      >
                        {retrying ? 'Checking…' : 'Try again'}
                      </button>
                    ) : null
                  }
                />
              ) : null}
              <form className="mt-6 space-y-4" onSubmit={submitFirstFactor} aria-busy={busy}>
                <Field id="console-email" label="Email">
                  <input
                    ref={attachEmail}
                    id="console-email"
                    type="email"
                    autoComplete="username"
                    required
                    disabled={busy}
                    className={FIELD}
                  />
                </Field>
                <Field id="console-password" label="Password">
                  <input
                    id="console-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    ref={passwordInput}
                    disabled={busy}
                    className={FIELD}
                  />
                </Field>
                <button type="submit" disabled={busy || serviceDown} className={BUTTON_PRIMARY}>
                  Sign in
                </button>
              </form>
              <div className="my-5 flex items-center gap-3 text-xs text-slate-400" aria-hidden="true">
                <span className="h-px flex-1 bg-slate-800" />
                or
                <span className="h-px flex-1 bg-slate-800" />
              </div>
              <button type="button" onClick={continueWithGoogle} disabled={busy || serviceDown} className={BUTTON_SECONDARY}>
                Continue with Google
              </button>
            </React.Fragment>
          ) : (
            <React.Fragment key="second-factor">
              <h1 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight text-white focus:outline-none">
                Two-step verification
              </h1>
              <p className="mt-2 text-sm text-slate-400">Enter the 6-digit code from your authenticator app.</p>
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
                        name="console-factor"
                        value={index}
                        checked={index === factor}
                        onChange={() => {
                          setFactor(index);
                          if (codeInput.current) codeInput.current.value = '';
                          setCodeError(false);
                        }}
                        disabled={busy}
                        className="h-4 w-4 accent-emerald-400"
                      />
                      {FACTOR_LABELS[kind]}
                    </label>
                  ))}
                </div>
              ) : null}
              <form className="mt-5 space-y-4" onSubmit={submitSecondFactor} noValidate aria-busy={busy}>
                <Field id="console-code" label="Verification code" error={codeError ? 'Enter the 6-digit code.' : null}>
                  <input
                    ref={codeInput}
                    id="console-code"
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
                    aria-describedby={codeError ? 'console-code-error' : undefined}
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
                onClick={useDifferentAccount}
                disabled={busy}
                className={cx('mt-5 rounded-md text-sm font-medium text-slate-300 underline-offset-4 hover:text-white hover:underline', FOCUS_RING)}
              >
                Use a different account
              </button>
            </React.Fragment>
          )}
          {/* A live region present from the start, so its progress text is announced when it appears. */}
          <p role="status" className={cx('mt-4 items-center gap-2 text-sm text-slate-300', busy && state.phase !== 'checking' ? 'flex' : 'sr-only')}>
            {busy && state.phase !== 'checking' ? (
              <>
                <Spinner className="h-4 w-4 text-emerald-300" />
                {progress}
              </>
            ) : null}
          </p>
        </div>
        <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">Administrator sessions end after 15 minutes of inactivity.</p>
      </div>
    </main>
  );
}
