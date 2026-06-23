// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
// Global shell: top safety bar, 23-module sidebar navigation, content region,
// optional module-info drawer, and bottom safety footer.
//
// All interactivity is LOCAL UI STATE ONLY (active module, environment display,
// read-only/elevated visual toggle, drawer open/close). No backend action, no
// fetch, no mutation, no DB. Dangerous actions live in screens as disabled buttons.

import React from 'react';
import { ENVIRONMENTS, MODULES, NAV_GROUP_ORDER } from './mockData';
import type { BcpModule, EnvLabel } from './types';
import { ScreenRouter } from './screens';
import { ActionChipView, DeferToneBadge, LockIcon, Monogram, Panel, ShieldIcon, StateChipView, cx } from './ui';

const PENDING_APPROVALS = 4;
const CRITICAL_ALERTS = 1;

function TopBar({
  env,
  setEnv,
  elevated,
  setElevated,
  onToggleDrawer,
}: {
  env: EnvLabel;
  setEnv: (e: EnvLabel) => void;
  elevated: boolean;
  setElevated: (v: boolean) => void;
  onToggleDrawer: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-gradient-to-b from-slate-950 to-slate-950/80 shadow-lg shadow-black/30 backdrop-blur supports-[backdrop-filter]:bg-slate-950/70">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 shadow-sm shadow-emerald-500/10">
            <ShieldIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-black tracking-tight text-slate-100">Backend Control Plane</div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Separate Secure Workspace</div>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1 ring-1 ring-white/5">
            {ENVIRONMENTS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEnv(e)}
                aria-pressed={e === env}
                className={cx(
                  'rounded-md px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                  e === env ? 'bg-slate-700 text-slate-100 shadow-sm ring-1 ring-inset ring-white/10' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {e}
              </button>
            ))}
          </div>

          <DeferToneBadge tone="neutral">{env}</DeferToneBadge>
          <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Production Locked</DeferToneBadge>
          <ActionChipView action="Read Only" />

          <button
            type="button"
            onClick={() => setElevated(!elevated)}
            title="Visual indicator only — no elevated capability is granted"
            className={cx(
              'rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
              elevated
                ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                : 'border-slate-700 bg-slate-900/60 text-slate-400',
            )}
          >
            {elevated ? 'Elevated (visual)' : 'Read-Only Mode'}
          </button>

          <DeferToneBadge tone="warning">Approvals {PENDING_APPROVALS}</DeferToneBadge>
          <DeferToneBadge tone="blocked">Alerts {CRITICAL_ALERTS}</DeferToneBadge>
          <DeferToneBadge tone="healthy"><ShieldIcon className="h-3 w-3" /> Secure Session</DeferToneBadge>

          <button
            type="button"
            onClick={onToggleDrawer}
            className="rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-300 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            Module Info
          </button>
        </div>
      </div>
    </header>
  );
}

function Sidebar({
  activeId,
  setActiveId,
}: {
  activeId: string;
  setActiveId: (id: string) => void;
}) {
  return (
    <nav className="hidden w-64 shrink-0 overflow-y-auto border-r border-slate-800/80 bg-slate-950/40 px-3 py-4 md:block">
      {NAV_GROUP_ORDER.map((group) => {
        const items = MODULES.filter((m) => m.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="mb-4">
            <div className="flex items-center gap-2 px-2 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">
              <span>{group}</span>
              <span className="h-px flex-1 bg-slate-800/70" aria-hidden="true" />
            </div>
            <div className="space-y-0.5">
              {items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setActiveId(m.id)}
                  aria-current={m.id === activeId ? 'page' : undefined}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
                    m.id === activeId
                      ? 'border-emerald-500/20 bg-gradient-to-r from-slate-800 to-slate-800/30 text-slate-100 shadow-sm ring-1 ring-inset ring-white/10'
                      : 'border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200',
                  )}
                >
                  <Monogram label={m.name} tone={m.status === 'blocked' ? 'blocked' : m.status === 'included' ? 'healthy' : 'neutral'} />
                  <span className="flex-1 truncate">{m.name}</span>
                  {m.id === activeId && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

// Mobile / tablet navigation. The sidebar is hidden below `md`, so this grouped
// selector gives full 23-module navigation on small screens. It only updates the
// same local UI state (active module) — no backend action.
function MobileNav({ activeId, setActiveId }: { activeId: string; setActiveId: (id: string) => void }) {
  return (
    <div className="border-b border-slate-800 bg-slate-950/80 px-4 py-2 md:hidden">
      <label htmlFor="bcp-mobile-nav" className="sr-only">Select Backend Control Plane module</label>
      <select
        id="bcp-mobile-nav"
        value={activeId}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setActiveId(e.target.value)}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      >
        {NAV_GROUP_ORDER.map((group) => {
          const items = MODULES.filter((m) => m.group === group);
          if (items.length === 0) return null;
          return (
            <optgroup key={group} label={group}>
              {items.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}

function ModuleDrawer({ module, onClose }: { module: BcpModule; onClose: () => void }) {
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-950/80 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-100">Module Info</h3>
        <button type="button" onClick={onClose} className="rounded-sm text-xs text-slate-400 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">Close</button>
      </div>
      <Panel title={module.name}>
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <StateChipView state={module.state} />
            <DeferToneBadge tone="neutral">{module.status}</DeferToneBadge>
          </div>
          <p className="text-slate-300">{module.purpose}</p>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Future milestone</div>
            <p className="mt-1 text-slate-400">{module.futureMilestone}</p>
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Blocked actions</div>
            <ul className="mt-1 space-y-1">
              {module.blockedActions.map((b) => (
                <li key={b} className="flex items-center gap-2 text-slate-400">
                  <LockIcon className="h-3 w-3 text-rose-300" />
                  {b}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>
    </aside>
  );
}

function SafetyFooter() {
  const items = ['Separate Secure Workspace', 'RLS Protected', 'Masked Connection', 'No Client Access', 'Read-Only Foundation'];
  return (
    <footer className="border-t border-slate-800/80 bg-gradient-to-t from-slate-950 to-slate-950/80 px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        {items.map((t, i) => (
          <span key={t} className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500/60" aria-hidden="true" />
            {t}
            {i < items.length - 1 && <span className="ml-2 text-slate-700">·</span>}
          </span>
        ))}
      </div>
    </footer>
  );
}

export default function Shell() {
  const [activeId, setActiveId] = React.useState('command-center');
  const [env, setEnv] = React.useState('DEV');
  const [elevated, setElevated] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const activeModule: BcpModule = MODULES.find((m) => m.id === activeId) || MODULES[1];

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar
        env={env}
        setEnv={setEnv}
        elevated={elevated}
        setElevated={setElevated}
        onToggleDrawer={() => setDrawerOpen((v: boolean) => !v)}
      />
      <MobileNav activeId={activeId} setActiveId={setActiveId} />
      <div className="flex flex-1">
        <Sidebar activeId={activeId} setActiveId={setActiveId} />
        <main className="min-w-0 flex-1 overflow-y-auto bg-[radial-gradient(60rem_30rem_at_70%_-10%,rgba(16,185,129,0.05),transparent)] px-4 py-5 sm:px-6">
          <ScreenRouter module={activeModule} env={env} />
        </main>
        {drawerOpen && <ModuleDrawer module={activeModule} onClose={() => setDrawerOpen(false)} />}
      </div>
      <SafetyFooter />
    </div>
  );
}
