// Phase 2.0 M7L — DEV-only Backend CP C-01 Readiness Summary preview card.
//
// Presentational card that loads the C-01 readiness posture from the EXISTING M7K code/config route
// (via the same-origin dev proxy) on explicit button click, and renders ONLY safe posture LABELS.
//
// SAFETY (binding):
//   - DEV-only: rendered ONLY inside the DEV-gated Backend Control Plane shell.
//   - Read-only: no mutation, no action; the only effect is a GET fetch on button click.
//   - Renders ONLY safe bounded labels from bcpC01Client (which strips anything unsafe to 'redacted').
//   - NEVER renders raw ids/internal_user_id/secrets/tokens/DB URLs/emails/tenant/store/customer rows.
//   - Every transport/feature/error state renders a safe message — no stack trace, no raw error object.

import React from 'react';
import { cx, DeferToneBadge, LockIcon, Panel, ShieldIcon } from './ui';
import { fetchC01Readiness, type C01Result } from './bcpC01Client';

// Safe, human-readable note for each non-success state (no raw error data, no secrets).
const STATE_NOTE: Record<Exclude<C01Result['kind'], 'success'>, { title: string; note: string }> = {
  feature_disabled: {
    title: 'C-01 disabled',
    note: 'The read model flag is OFF. Set ENABLE_BCP_DEV_READONLY_PILOT=true on the DEV identity API, then reload.',
  },
  dev_only: {
    title: 'DEV-only',
    note: 'C-01 is DEV-only and is unavailable outside a development environment.',
  },
  unauthorized: {
    title: 'Not authorized',
    note: 'The server-derived principal is not authorized for C-01. (Authority is server-side only.)',
  },
  parity_blocked: {
    title: 'Parity blocked',
    note: 'Parity is not ready, so C-01 is blocked (fail-closed). Parity remains a static/deferred posture.',
  },
  error: {
    title: 'Safe error',
    note: 'The C-01 API returned a safe error. No details are exposed.',
  },
  unavailable: {
    title: 'C-01 API unavailable',
    note: 'Could not reach the C-01 API through the dev proxy. Start it with `npm run identity:api` and ENABLE_BCP_DEV_READONLY_PILOT=true, then retry.',
  },
  unexpected: {
    title: 'Unexpected response',
    note: 'The response shape was not recognized. Nothing is rendered from it (fail-safe).',
  },
};

function SafetyBadges() {
  return (
    <div className="flex flex-wrap gap-2">
      <DeferToneBadge tone="healthy">DEV Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Read-Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Code/Config Posture</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Tenant / Customer Data</DeferToneBadge>
      <DeferToneBadge tone="neutral">No DB / Supabase</DeferToneBadge>
      <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Production Disabled</DeferToneBadge>
    </div>
  );
}

function SuccessView({ result }: { result: Extract<C01Result, { kind: 'success' }> }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1">source: <span className="font-mono text-slate-300">{result.sourceMode}</span></span>
        <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1">parity: <span className="font-mono text-slate-300">{result.parity}</span></span>
        {result.environment && result.environment !== 'redacted' && (
          <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1">env: <span className="font-mono text-slate-300">{result.environment}</span></span>
        )}
        {result.generatedAt && (
          <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1">generated: <span className="font-mono text-slate-300">{result.generatedAt}</span></span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {result.rows.map((r, i) => (
          // Composite key with index: hostile/duplicate payloads can repeat labels (e.g. multiple 'redacted').
          <div key={`${r.label}:${r.status}:${i}`} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <span className="font-mono text-xs text-slate-300">{r.label}</span>
            <DeferToneBadge tone={r.tone}>{r.status}</DeferToneBadge>
          </div>
        ))}
      </div>
      {result.warnings.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {result.warnings.map((w, i) => (
            <span key={`${w}:${i}`}><DeferToneBadge tone="neutral">{w}</DeferToneBadge></span>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Posture labels only — no tenant/store/customer data, raw IDs, secrets, or DB/Supabase reads.
      </p>
    </div>
  );
}

function StateView({ kind }: { kind: Exclude<C01Result['kind'], 'success'> }) {
  const tone = kind === 'feature_disabled' || kind === 'dev_only' || kind === 'unavailable' ? 'neutral'
    : kind === 'parity_blocked' || kind === 'unauthorized' || kind === 'error' ? 'blocked'
    : 'warning';
  const { title, note } = STATE_NOTE[kind];
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
      <DeferToneBadge tone={tone}>{title}</DeferToneBadge>
      <p className="mx-auto mt-2 max-w-md text-xs text-slate-400">{note}</p>
    </div>
  );
}

export default function C01ReadinessCard() {
  const [result, setResult] = React.useState<C01Result | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchC01Readiness();
      setResult(r);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Panel
      title="C-01 Readiness Summary (live code/config)"
      subtitle="DEV-only · read-only · posture labels from the M7K code/config read model — not tenant data"
      right={
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className={cx(
            'rounded-md border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
            loading
              ? 'cursor-wait border-slate-700 bg-slate-900/60 text-slate-500'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20',
          )}
        >
          {loading ? 'Loading…' : result ? 'Reload C-01' : 'Load C-01 Readiness'}
        </button>
      }
    >
      <div className="mb-4">
        <SafetyBadges />
      </div>

      {result === null && !loading && (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-300">
            <ShieldIcon className="h-4 w-4 text-sky-300" /> Idle — click “Load C-01 Readiness”
          </span>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Reads the isolated DEV C-01 code/config posture via the same-origin dev proxy. Requires
            <span className="font-mono"> npm run identity:api</span> with the flag on; otherwise a safe unavailable state is shown.
          </p>
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-sm text-slate-400">
          Loading C-01 readiness posture…
        </div>
      )}

      {!loading && result !== null && (
        result.kind === 'success' ? <SuccessView result={result} /> : <StateView kind={result.kind} />
      )}
    </Panel>
  );
}
