// Phase 2.0 M12 — DEV-only Backend CP C-03 UI Coverage / Screen Readiness preview card.
//
// Presentational card that loads the C-03 UI coverage lens from the isolated M12 route (via the
// same-origin dev proxy) on explicit button click, and renders ONLY safe bounded labels / enums /
// bounded counts. Mirrors the frozen C-02 card.
//
// SAFETY (binding):
//   - DEV-only: rendered ONLY inside the DEV-gated Backend Control Plane shell.
//   - Read-only: no mutation, no action; the only effect is a GET fetch on button click (no auto-fetch).
//   - Renders ONLY safe labels from bcpC03Client (which strips anything unsafe to 'redacted').
//   - NEVER renders raw ids/secrets/tokens/DB URLs/emails/tenant/store/customer rows, permission/RBAC
//     keys, raw component names, raw JSON objects, raw server errors, or stack traces.
//   - An empty registry is shown HONESTLY as a safe empty state, not as an error.

import React from 'react';
import { cx, DeferToneBadge, LockIcon, Panel, ShieldIcon } from './ui';
import { fetchC03UiCoverageReadiness, type C03Result } from './bcpC03Client';

const STATE_NOTE: Record<Exclude<C03Result['kind'], 'success'>, { title: string; note: string }> = {
  feature_disabled: {
    title: 'C-03 disabled',
    note: 'The C-03 flag is OFF. Set ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS=true on the DEV identity API, then reload.',
  },
  dev_only: {
    title: 'DEV-only',
    note: 'C-03 is DEV-only and is unavailable outside a development environment.',
  },
  unauthorized: {
    title: 'Not authorized',
    note: 'The server-derived principal is not authorized for C-03. (Authority is server-side only.)',
  },
  parity_blocked: {
    title: 'Parity blocked',
    note: 'Parity is not ready, so C-03 is blocked (fail-closed).',
  },
  method_not_allowed: {
    title: 'Method not allowed',
    note: 'C-03 is GET-only. Mutating methods are rejected (read-only).',
  },
  error: {
    title: 'Safe error',
    note: 'The C-03 API returned a safe error. No details are exposed.',
  },
  unavailable: {
    title: 'C-03 API unavailable',
    note: 'Could not reach the C-03 API through the dev proxy. Start it with `npm run identity:api` and ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS=true, then retry.',
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
      <DeferToneBadge tone="neutral">Code/Config</DeferToneBadge>
      <DeferToneBadge tone="neutral">No DB / Supabase</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Live Source</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Mutation</DeferToneBadge>
      <DeferToneBadge tone="neutral">Backend CP Internal</DeferToneBadge>
      <DeferToneBadge tone="blocked"><LockIcon className="h-3 w-3" /> Production Disabled</DeferToneBadge>
    </div>
  );
}

function Chip({ k, v }: { k: string; v: string }) {
  return (
    <span className="rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1 text-xs text-slate-400">
      {k}: <span className="font-mono text-slate-300">{v}</span>
    </span>
  );
}

function SuccessView({ result }: { result: Extract<C03Result, { kind: 'success' }> }) {
  const c = result.summaryCounts;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip k="schema" v={result.schemaVersion} />
        <Chip k="source" v={result.sourceMode} />
        <Chip k="freshness" v={result.freshness} />
        {result.generatedAt && <Chip k="generated" v={result.generatedAt} />}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <DeferToneBadge tone="neutral">total {c.total}</DeferToneBadge>
        <DeferToneBadge tone="healthy">implemented {c.implemented}</DeferToneBadge>
        <DeferToneBadge tone="warning">preview {c.preview}</DeferToneBadge>
        <DeferToneBadge tone="warning">placeholder {c.placeholder}</DeferToneBadge>
        <DeferToneBadge tone="warning">deferred {c.deferred}</DeferToneBadge>
        <DeferToneBadge tone="blocked">blocked {c.blocked}</DeferToneBadge>
        <DeferToneBadge tone="warning">unknown {c.unknown}</DeferToneBadge>
      </div>

      {result.emptyState.isEmpty ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <DeferToneBadge tone="neutral">emptyState: {result.emptyState.reason}</DeferToneBadge>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-400">
            No UI coverage entries available from a server-owned provider. This is not an error — the lens
            is wired and returns a safe empty state.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {result.items.map((it, i) => (
            <div key={`${it.screenKey}:${i}`} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-slate-300">{it.screenLabel}</span>
                <DeferToneBadge tone="neutral">{it.screenStatus}</DeferToneBadge>
              </div>
              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-500">
                <span className="font-mono">{it.screenKey}</span>
                <span>· {it.coverageClass}</span>
                <span>· preview: {it.previewCardStatus}</span>
                <span>· client: {it.clientStatus}</span>
                <span>· route: {it.routeStatus}</span>
                <span>· {it.exposurePosture}</span>
                <span>· {it.evidenceStatus}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <DeferToneBadge tone="neutral">route: {result.routePosture}</DeferToneBadge>
        <DeferToneBadge tone="blocked">prod: {result.productionPosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">mutation: {result.mutationPosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">redaction: {result.redactionPosture}</DeferToneBadge>
      </div>

      {result.evidenceLabels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {result.evidenceLabels.map((e, i) => (
            <span key={`${e}:${i}`}><DeferToneBadge tone="neutral">{e}</DeferToneBadge></span>
          ))}
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {result.warnings.map((w, i) => (
            <span key={`${w}:${i}`}><DeferToneBadge tone="warning">{w}</DeferToneBadge></span>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Safe posture labels and bounded counts only — no tenant/store/customer data, raw IDs, secrets,
        permission keys, or DB/Supabase reads.
      </p>
    </div>
  );
}

function StateView({ kind }: { kind: Exclude<C03Result['kind'], 'success'> }) {
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

export default function C03UiCoverageReadinessCard() {
  const [result, setResult] = React.useState<C03Result | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchC03UiCoverageReadiness();
      setResult(r);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Panel
      title="C-03 UI Coverage Readiness (live code/config)"
      subtitle="DEV-only · read-only · bounded posture labels from the C-03 code/config UI coverage read model — not tenant data"
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
          {loading ? 'Loading…' : result ? 'Reload C-03' : 'Load C-03 UI Coverage'}
        </button>
      }
    >
      <div className="mb-4">
        <SafetyBadges />
      </div>

      {result === null && !loading && (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-300">
            <ShieldIcon className="h-4 w-4 text-sky-300" /> Idle — click “Load C-03 UI Coverage”
          </span>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Reads the isolated DEV C-03 code/config UI coverage posture via the same-origin dev proxy.
            Requires <span className="font-mono">npm run identity:api</span> with the C-03 flag on;
            otherwise a safe unavailable state is shown.
          </p>
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-sm text-slate-400">
          Loading C-03 UI coverage readiness posture…
        </div>
      )}

      {!loading && result !== null && (
        result.kind === 'success' ? <SuccessView result={result} /> : <StateView kind={result.kind} />
      )}
    </Panel>
  );
}
