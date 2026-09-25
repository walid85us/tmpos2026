// Phase 4.0 M4 — the console sign-in: the provider's first factor, its second-factor challenge
// when the account requires one, then the server login exchange. Every refusal reads the same,
// whatever caused it (docs/phase-4/03 §2 #11): the page never says whether an account exists,
// lacks admission or a role, failed its second factor, or is suspended.

import React from 'react';
import { cx } from '../ui';
import type { SessionNotice } from './adminSessionClient';
import { useConsole, useSessionState } from './consoleContext';
import { Brand, FOCUS_RING, Spinner } from './ConsolePages';
import { FirstFactorForm, PROVIDER_NOTICE_TEXT, SecondFactorForm, useProviderSignIn, type ProviderNotice } from './ProviderSignIn';

type Notice = SessionNotice | ProviderNotice;

const NOTICES: Readonly<Record<Notice, { readonly text: string; readonly tone: 'error' | 'warning' | 'info' }>> = {
  denied: { text: PROVIDER_NOTICE_TEXT.denied, tone: 'error' },
  'rate-limited': { text: PROVIDER_NOTICE_TEXT['rate-limited'], tone: 'warning' },
  unavailable: { text: PROVIDER_NOTICE_TEXT.unavailable, tone: 'warning' },
  expired: { text: 'Your session has ended. Sign in again to continue.', tone: 'info' },
  'logged-out': { text: 'You have signed out.', tone: 'info' },
  'logged-out-unconfirmed': {
    text: 'You have signed out on this device. The server did not confirm it, so the session ends on its own within 15 minutes.',
    tone: 'info',
  },
  cancelled: { text: PROVIDER_NOTICE_TEXT.cancelled, tone: 'info' },
};

const TONES = {
  error: 'border-rose-800 bg-rose-950 text-rose-100',
  warning: 'border-amber-800 bg-amber-950 text-amber-100',
  info: 'border-sky-800 bg-sky-950 text-sky-100',
} as const;

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
  const { client, screens } = useConsole();
  const state = useSessionState();
  const [retrying, setRetrying] = React.useState(false);
  // The provider steps (ProviderSignIn.tsx); the token they produce goes to the login exchange and nowhere else.
  const flow = useProviderSignIn({
    busy: state.phase === 'signing-in' || state.phase === 'signing-out',
    onToken: (idToken) => client.exchange(idToken),
  });
  const { factors, working, busy } = flow;
  const heading = React.useRef<HTMLHeadingElement>(null);
  const lastStep = React.useRef<string | null>(null);
  const arrived = React.useRef<boolean | null>(null);
  if (arrived.current === null) arrived.current = screens.shown;
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    screens.shown = true;
    document.title = 'Sign in · Control Plane';
    return () => {
      alive.current = false;
    };
  }, []);

  // Arriving from another console screen, or moving between the two steps, puts focus on the
  // heading, which also reads out any notice; the document's first screen keeps the natural order.
  const step = flow.step;
  React.useEffect(() => {
    const first = lastStep.current === null;
    const changed = !first && lastStep.current !== step; // false for React's dev re-run of this effect
    lastStep.current = step;
    if (changed || (first && arrived.current)) heading.current?.focus();
  }, [step]);

  const sessionNotice = state.phase === 'signed-out' ? state.notice : null;
  const notice = flow.notice ?? sessionNotice;
  const serviceDown = flow.notice === null && sessionNotice === 'unavailable';

  async function retry() {
    setRetrying(true);
    await client.bootstrap();
    if (!alive.current) return;
    setRetrying(false);
    flow.focusEmail(); // the retry button may be gone now
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
              <FirstFactorForm flow={flow} prefix="console" closed={serviceDown} />
            </React.Fragment>
          ) : (
            <React.Fragment key="second-factor">
              <h1 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight text-white focus:outline-none">
                Two-step verification
              </h1>
              <p className="mt-2 text-sm text-slate-400">Enter the 6-digit code from your authenticator app.</p>
              <SecondFactorForm flow={flow} prefix="console" />
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
