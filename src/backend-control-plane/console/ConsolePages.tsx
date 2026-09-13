// Phase 4.0 M4 — the console's pages and shared presentation: the workspace directory, the
// placeholder workspaces, and the loading, unavailable and wrong-address states. Placeholders show
// no data and offer no action: every workspace is "Coming later" until its server capability ships.
// The console home is the Command Center (CommandCenterPage.tsx).

import React from 'react';
import { Link } from 'react-router-dom';
import { ShieldIcon, cx } from '../ui';
import { useConsole } from './consoleContext';
import { CONSOLE_GROUPS, CONSOLE_HOME, modulePath, type ConsoleModule } from './navigation';

export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900';

export const BUTTON_PRIMARY = cx(
  'inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300',
  FOCUS_RING,
);

export const BUTTON_SECONDARY = cx(
  'inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-100 transition-colors hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-400',
  FOCUS_RING,
);

/** A 24×24 stroked icon drawn from one path; decorative, so hidden from assistive technology. */
export function Icon({ d, className = 'h-5 w-5' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cx('motion-safe:animate-spin', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-emerald-400/40 bg-emerald-400/10 text-emerald-300">
        <ShieldIcon className="h-5 w-5" />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-bold tracking-tight text-white">Control Plane</span>
        <span className="block text-xs text-slate-400">TM POS platform administration</span>
      </span>
    </div>
  );
}

export function ComingLater() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-slate-700 bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-200">
      Coming later
    </span>
  );
}

export function LoadingScreen() {
  React.useEffect(() => {
    document.title = 'Control Plane';
  }, []);
  return (
    <main id="main-content" className="grid min-h-screen place-items-center bg-slate-950 px-4">
      <p role="status" className="flex items-center gap-3 text-sm text-slate-300">
        <Spinner className="h-5 w-5 text-emerald-300" />
        Checking your session…
      </p>
    </main>
  );
}

export function HostRefused() {
  React.useEffect(() => {
    document.title = 'Not available · Control Plane';
  }, []);
  return (
    <main id="main-content" className="grid min-h-screen place-items-center bg-slate-950 px-4 py-16">
      <div className="max-w-md text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-slate-700 bg-slate-900 text-slate-300">
          <ShieldIcon className="h-6 w-6" />
        </span>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-white">Not available on this address</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">
          The Control Plane opens only on its dedicated administration address. Use the address you were given for platform administration.
        </p>
      </div>
    </main>
  );
}

/** Shown in place of workspace content while the server has not confirmed the session. */
export function UnavailablePanel() {
  const { client } = useConsole();
  const [retrying, setRetrying] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function retry() {
    setRetrying(true);
    await client.bootstrap();
    if (alive.current) setRetrying(false);
  }
  return (
    <section role="alert" aria-labelledby="console-unavailable" className="rounded-2xl border border-amber-800 bg-amber-950 p-6">
      <h2 id="console-unavailable" className="text-base font-semibold text-amber-100">
        Control plane unavailable
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-amber-100">
        The server did not confirm your session, so workspace content is hidden until it does.
      </p>
      <button
        type="button"
        onClick={retry}
        disabled={retrying}
        className={cx(
          'mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200 disabled:cursor-not-allowed',
          FOCUS_RING,
        )}
      >
        {retrying ? <><Spinner /> Checking…</> : 'Try again'}
      </button>
    </section>
  );
}

/** Every workspace, grouped as in the navigation, each "Coming later" until its server capability ships. */
export function WorkspaceDirectory() {
  return (
    <section aria-labelledby="workspace-directory">
      <h2 id="workspace-directory" className="text-base font-semibold text-white">
        Workspaces
      </h2>
      <p className="mt-1 max-w-prose text-sm text-slate-400">
        None is open yet. Each one opens here when its server capability ships.
      </p>
      <div className="mt-5 space-y-6">
        {CONSOLE_GROUPS.map((group) => (
          <div key={group.label}>
            <h3 className="text-sm font-semibold text-slate-300">{group.label}</h3>
            <ul className="mt-2 divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
              {group.modules.map((module) => (
                <li key={module.slug}>
                  <Link
                    to={modulePath(module)}
                    className={cx(
                      'flex flex-col gap-1 px-4 py-3.5 transition-colors hover:bg-slate-800 sm:flex-row sm:items-center sm:gap-4',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400',
                    )}
                  >
                    <span className="w-52 shrink-0 text-sm font-semibold text-white">{module.label}</span>
                    <span className="flex-1 text-sm text-slate-400">{module.summary}</span>
                    <ComingLater />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ModulePage({ module }: { module: ConsoleModule }) {
  return (
    <section aria-labelledby={`module-${module.slug}`} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
      <ComingLater />
      <h2 id={`module-${module.slug}`} className="mt-4 text-lg font-semibold text-white">
        This workspace isn't open yet
      </h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-300">
        It opens when its server capability ships. Until then there is nothing to view or change here.
      </p>
      <Link
        to={CONSOLE_HOME}
        className={cx('mt-6 inline-flex rounded-md text-sm font-semibold text-emerald-300 underline-offset-4 hover:underline', FOCUS_RING)}
      >
        Back to the Command Center
      </Link>
    </section>
  );
}
