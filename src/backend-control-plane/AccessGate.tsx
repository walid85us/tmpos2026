// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
// Separate access gate (mock / read-only). It does NOT authenticate, authorize,
// call any API, read any secret, or mutate anything. The single "Enter Control
// Plane" action only flips LOCAL UI state to reveal the shell.

import React from 'react';
import { ROLES } from './mockData';
import { CheckIcon, DeferToneBadge, LockIcon, ShieldIcon } from './ui';

const GATE_POINTS = [
  'Backend Control Plane is a separate secure workspace',
  'Owner-granted access is required',
  'Second-factor posture is visual only (mock)',
  'Production actions are locked',
  'All write actions require approval',
  'Entry is mock / read-only',
];

export default function AccessGate({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 px-4 py-10">
      <div className="w-full max-w-4xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
            <ShieldIcon className="h-7 w-7" />
          </span>
          <h1 className="text-2xl font-black tracking-tight text-slate-100">Backend Control Plane</h1>
          <p className="mt-1 text-sm text-slate-400">Separate Secure Workspace — Read-Only Foundation</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <DeferToneBadge tone="neutral">DEV</DeferToneBadge>
            <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Production Locked</DeferToneBadge>
            <DeferToneBadge tone="warning">Owner-Granted Access</DeferToneBadge>
            <DeferToneBadge tone="healthy">Mock / Read-Only</DeferToneBadge>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="text-sm font-bold text-slate-100">Access Conditions</h2>
            <ul className="mt-3 space-y-2">
              {GATE_POINTS.map((t) => (
                <li key={t} className="flex items-center gap-2 text-sm text-slate-300">
                  <CheckIcon className="h-4 w-4 text-emerald-300" />
                  {t}
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="text-sm font-bold text-slate-100">Role Profiles</h2>
            <p className="mt-1 text-xs text-slate-500">Mock role cards — no real users or grants</p>
            <div className="mt-3 grid max-h-56 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
              {ROLES.map((r) => (
                <div key={r.name} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <ShieldIcon className="h-3.5 w-3.5 text-sky-300" />
                    <span className="text-xs font-bold text-slate-200">{r.name}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{r.access}</div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="mt-6 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onEnter}
            className="rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-6 py-2.5 text-sm font-bold text-emerald-200 transition hover:bg-emerald-500/25"
          >
            Enter Control Plane
          </button>
          <p className="text-[11px] text-slate-500">
            Mock entry only — no authentication, authorization, API call, or mutation occurs.
          </p>
        </div>
      </div>
    </div>
  );
}
