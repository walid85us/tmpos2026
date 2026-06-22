// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
// Shared presentational primitives (dark command-center theme via Tailwind v4).
// No data fetching, no mutation, no backend calls. Buttons are visual-only / disabled.

import React from 'react';
import type { ActionChip, Health, StateChip } from './types';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const STATE_CHIP_STYLE: Record<StateChip, string> = {
  Current: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  Planned: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  Future: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
  Dormant: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  'Read-Only First': 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  'Production Blocked': 'bg-rose-500/10 text-rose-300 border-rose-500/30',
};

const ACTION_CHIP_STYLE: Record<ActionChip, string> = {
  'Read Only': 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  'Request Only': 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  'Approval Required': 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  'Owner Approval': 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  'Separation of Duties': 'bg-violet-500/10 text-violet-300 border-violet-500/30',
  'DEV Only': 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  'Production Blocked': 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  'Audit Required': 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  'Default OFF': 'bg-slate-500/10 text-slate-300 border-slate-500/30',
};

const HEALTH_DOT: Record<Health, string> = {
  healthy: 'bg-emerald-400',
  warning: 'bg-amber-400',
  blocked: 'bg-rose-400',
  neutral: 'bg-slate-400',
};

const HEALTH_TEXT: Record<Health, string> = {
  healthy: 'text-emerald-300',
  warning: 'text-amber-300',
  blocked: 'text-rose-300',
  neutral: 'text-slate-300',
};

const chipBase =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider';

export function StateChipView({ state }: { state: StateChip }) {
  return <span className={cx(chipBase, STATE_CHIP_STYLE[state])}>{state}</span>;
}

export function ActionChipView({ action }: { action: ActionChip }) {
  return <span className={cx(chipBase, ACTION_CHIP_STYLE[action])}>{action}</span>;
}

export function HealthDot({ tone }: { tone: Health }) {
  return <span className={cx('inline-block h-2 w-2 rounded-full', HEALTH_DOT[tone])} aria-hidden="true" />;
}

export function HealthLabel({ tone, children }: { tone: Health; children: React.ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-2 text-xs font-semibold', HEALTH_TEXT[tone])}>
      <HealthDot tone={tone} />
      {children}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  right,
  children,
  className,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-2xl border border-slate-800 bg-slate-900/60 shadow-lg shadow-black/20 backdrop-blur',
        className,
      )}
    >
      {(title || right) && (
        <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-bold tracking-wide text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function KpiCardView({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: Health;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/80 to-slate-900/40 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
        <HealthDot tone={tone} />
      </div>
      <div className="mt-2 text-2xl font-black text-slate-100">{value}</div>
      <div className={cx('mt-1 text-[11px] font-medium', HEALTH_TEXT[tone])}>{hint}</div>
    </div>
  );
}

/**
 * A guarded action button. It is ALWAYS disabled and performs NO action.
 * It exists only to communicate that a governed action would live here.
 */
export function GuardedButton({ label, hint }: { label: string; hint?: string }) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title={hint || 'Disabled — read-only foundation'}
      className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-semibold text-slate-400 opacity-70"
    >
      <LockIcon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export function DataTable({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-800">
            {columns.map((c) => (
              <th
                key={c}
                className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-slate-800/60 hover:bg-slate-800/30">
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-2.5 align-middle text-slate-200">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Monogram({ label, tone = 'neutral' }: { label: string; tone?: Health }) {
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  const ring: Record<Health, string> = {
    healthy: 'border-emerald-500/40 text-emerald-300',
    warning: 'border-amber-500/40 text-amber-300',
    blocked: 'border-rose-500/40 text-rose-300',
    neutral: 'border-slate-600 text-slate-300',
  };
  return (
    <span
      className={cx(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-slate-800/60 text-[10px] font-black',
        ring[tone],
      )}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9.5 12l2 2 3.5-4" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={className} aria-hidden="true">
      <path d="M5 12l5 5 9-11" />
    </svg>
  );
}

export function DeferToneBadge({ children, tone }: { children: React.ReactNode; tone: Health }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold',
        tone === 'healthy' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
        tone === 'warning' && 'border-amber-500/30 bg-amber-500/10 text-amber-300',
        tone === 'blocked' && 'border-rose-500/30 bg-rose-500/10 text-rose-300',
        tone === 'neutral' && 'border-slate-600 bg-slate-800/60 text-slate-300',
      )}
    >
      {children}
    </span>
  );
}
