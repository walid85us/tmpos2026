// Phase 4.0 M4 — the console frame: a sidebar on wide screens, an off-canvas drawer on narrow
// ones, a sticky header with the session indicator and account menu, and the page title and
// breadcrumb. It renders only inside a confirmed session (AdminConsoleApp's RequireSession) and
// holds no authority: navigation entries are destinations, never grants.

import React from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { cx } from '../ui';
import { useConsole, useSessionState } from './consoleContext';
import { Brand, FOCUS_RING, Icon, Spinner, UnavailablePanel } from './ConsolePages';
import { CONSOLE_GROUPS, CONSOLE_HOME, CONSOLE_HOME_LABEL, CONSOLE_HOME_SUMMARY, CONSOLE_MODULES, modulePath } from './navigation';

const WIDE = '(min-width: 64rem)'; // exactly Tailwind v4's `lg`: from here the sidebar replaces the drawer

const MENU = 'M4 6h16M4 12h16M4 18h16';
const CLOSE = 'M6 6l12 12M18 6L6 18';
const CHEVRON = 'M9 6l6 6-6 6';
const PERSON = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0';

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  cx(
    'flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
    FOCUS_RING,
    isActive ? 'bg-slate-800 font-semibold text-white shadow-[inset_3px_0_0_#34d399]' : 'text-slate-300 hover:bg-slate-900 hover:text-white',
  );

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const base = React.useId();
  return (
    <nav aria-label="Control plane" className="flex-1 overflow-y-auto px-3 py-4">
      <NavLink to={CONSOLE_HOME} end onClick={onNavigate} className={linkClass}>
        {CONSOLE_HOME_LABEL}
      </NavLink>
      {CONSOLE_GROUPS.map((group, index) => (
        <div key={group.label} className="mt-6">
          <p id={`${base}-${index}`} className="px-3 text-xs font-semibold text-slate-400">
            {group.label}
          </p>
          <ul aria-labelledby={`${base}-${index}`} className="mt-2 space-y-0.5">
            {group.modules.map((module) => (
              <li key={module.slug}>
                <NavLink to={modulePath(module)} onClick={onNavigate} className={linkClass}>
                  <span className="truncate">{module.label}</span>
                  <span className="shrink-0 text-[11px] font-medium text-slate-400" aria-hidden="true">
                    Soon
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function AccountMenu() {
  const { client } = useConsole();
  const state = useSessionState();
  const [open, setOpen] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();
  const signingOut = state.phase === 'signing-out';
  const failed = state.phase === 'active' && state.signOutFailed;

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    // A pointer or keyboard focus leaving the menu closes it (the drawer opening, for one).
    const onOutside = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, [open]);

  // A sign-out that did not complete is shown even if the menu was closed meanwhile.
  React.useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);

  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        aria-label="Account menu"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cx('grid h-9 w-9 place-items-center rounded-full border border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-600 hover:text-white', FOCUS_RING)}
      >
        <Icon d={PERSON} className="h-4 w-4" />
      </button>
      <div id={panelId} hidden={!open} className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl shadow-black/50">
        <p className="text-sm font-semibold text-white">Administrator session</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">Ends after 15 minutes of inactivity.</p>
        {failed ? (
          <p role="alert" className="mt-3 rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-xs text-rose-100">
            Sign-out didn't complete. Try again.
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void client.logout()}
          disabled={signingOut}
          className={cx(
            'mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed',
            FOCUS_RING,
          )}
        >
          {signingOut ? <><Spinner />Signing out…</> : 'Sign out'}
        </button>
      </div>
    </div>
  );
}

function Drawer({ onClose, onNavigate }: { onClose: () => void; onNavigate: () => void }) {
  const panel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-slate-950/80" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        id="console-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-slate-800 bg-slate-950 shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-5">
          <Brand />
          <button type="button" onClick={onClose} aria-label="Close navigation" className={cx('rounded-lg p-2 text-slate-300 hover:bg-slate-900 hover:text-white', FOCUS_RING)}>
            <Icon d={CLOSE} />
          </button>
        </div>
        <NavLinks onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function skipToMain(event: React.MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  document.getElementById('main-content')?.focus();
}

export default function ConsoleShell() {
  const { client, screens } = useConsole();
  const state = useSessionState();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const menuButton = React.useRef<HTMLButtonElement>(null);
  const afterClose = React.useRef<'menu' | 'title' | null>(null);
  const lastPath = React.useRef<string | null>(null);
  // Arriving from another console screen (sign-in, say) moves focus to the title; the document's
  // first screen keeps the natural order, so the skip link stays the first stop.
  const arrived = React.useRef<boolean | null>(null);
  if (arrived.current === null) arrived.current = screens.shown;

  // The router matches case-insensitively and tolerates a trailing slash; so does the title.
  const pathname = location.pathname.replace(/\/+$/, '').toLowerCase();
  const current = CONSOLE_MODULES.find((module) => modulePath(module) === pathname) ?? null;
  const title = current?.label ?? CONSOLE_HOME_LABEL;
  const interrupted = state.phase === 'active' && state.interrupted;
  const sessionLabel = state.phase === 'signing-out' ? 'Signing out' : interrupted ? 'Session unconfirmed' : 'Session active';

  React.useEffect(() => {
    document.title = `${title} · Control Plane`;
  }, [title]);

  // Every in-console navigation re-reads the session, and so does every return to the tab. The
  // read never extends the session (only an authorized request slides the idle window,
  // docs/phase-4/03 §2a); it surfaces an expiry or an outage promptly. Focus moves to the new
  // page's title — once the drawer, which makes the rest of the page inert, has closed.
  React.useEffect(() => {
    const first = lastPath.current === null;
    const navigated = !first && lastPath.current !== pathname; // false for React's dev re-run of this effect
    lastPath.current = pathname;
    screens.shown = true;
    if (navigated) void client.bootstrap(); // the first render was confirmed by the read that admitted it
    if (!(navigated || (first && arrived.current))) return;
    if (drawerOpen) {
      afterClose.current = 'title';
      setDrawerOpen(false);
    } else {
      document.getElementById('page-title')?.focus({ preventScroll: true });
    }
    // `drawerOpen` is read at the moment of navigation, not tracked.
  }, [pathname, client, screens]);

  React.useEffect(() => {
    if (drawerOpen) return;
    const target = afterClose.current;
    afterClose.current = null;
    if (target === 'menu') menuButton.current?.focus();
    else if (target === 'title') document.getElementById('page-title')?.focus();
  }, [drawerOpen]);

  React.useEffect(() => {
    if (!drawerOpen || typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia(WIDE);
    const onChange = () => {
      if (!wide.matches) return;
      afterClose.current = 'title'; // the menu button is hidden from here on
      setDrawerOpen(false);
    };
    onChange();
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [drawerOpen]);

  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void client.bootstrap();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [client]);

  const closeDrawer = React.useCallback(() => {
    afterClose.current = 'menu';
    setDrawerOpen(false);
  }, []);
  const navigateFromDrawer = React.useCallback(() => {
    afterClose.current = 'title';
    setDrawerOpen(false);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <a
        href="#main-content"
        onClick={skipToMain}
        inert={drawerOpen}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-emerald-400 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950 focus:outline-none focus:ring-2 focus:ring-white"
      >
        Skip to main content
      </a>

      <aside aria-label="Console sidebar" inert={drawerOpen} className="hidden border-r border-slate-800 bg-slate-950 lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col">
        <div className="px-6 pb-2 pt-6">
          <Brand />
        </div>
        <NavLinks />
        <div className="border-t border-slate-800 px-6 py-4 text-xs leading-relaxed text-slate-400">
          <p className="font-semibold text-slate-300">Administration address</p>
          <p className="truncate">{window.location.host}</p>
        </div>
      </aside>

      <div inert={drawerOpen} className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 sm:px-6 lg:px-10">
          <button
            ref={menuButton}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="console-drawer"
            className={cx('rounded-lg p-2 text-slate-300 hover:bg-slate-900 hover:text-white lg:hidden', FOCUS_RING)}
          >
            <Icon d={MENU} />
          </button>
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-4">
            <p className="hidden items-center gap-2 text-sm text-slate-300 sm:flex">
              <span className={cx('h-2 w-2 rounded-full', sessionLabel === 'Session active' ? 'bg-emerald-400' : 'bg-amber-300')} aria-hidden="true" />
              {sessionLabel}
            </p>
            <AccountMenu />
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="px-4 pb-16 pt-8 focus:outline-none sm:px-6 lg:px-10">
          <div className="mx-auto max-w-5xl">
            <nav aria-label="Breadcrumb">
              <ol className="flex flex-wrap items-center gap-1.5 text-sm text-slate-400">
                <li>
                  <Link to={CONSOLE_HOME} className={cx('rounded hover:text-white', FOCUS_RING)}>
                    Control Plane
                  </Link>
                </li>
                <li aria-hidden="true">
                  <Icon d={CHEVRON} className="h-3.5 w-3.5" />
                </li>
                <li>
                  <span aria-current="page" className="font-medium text-slate-200">
                    {title}
                  </span>
                </li>
              </ol>
            </nav>
            <h1 id="page-title" tabIndex={-1} className="mt-3 text-2xl font-bold tracking-tight text-white focus:outline-none sm:text-3xl">
              {title}
            </h1>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-slate-400">
              {current?.summary ?? CONSOLE_HOME_SUMMARY}
            </p>
            {/* Workspace content is for a confirmed session only — not an unconfirmed one, nor one being signed out. */}
            <div className="mt-8">{state.phase !== 'active' ? null : state.interrupted ? <UnavailablePanel /> : <Outlet />}</div>
          </div>
        </main>
      </div>

      {drawerOpen ? <Drawer onClose={closeDrawer} onNavigate={navigateFromDrawer} /> : null}
    </div>
  );
}
