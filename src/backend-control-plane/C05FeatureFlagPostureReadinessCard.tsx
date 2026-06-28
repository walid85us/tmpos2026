// Phase 2.0 M17 — DEV-only Backend CP C-05 Feature Flag / Environment Posture Readiness preview card.
//
// Presentational card that loads the C-05 feature-flag-posture lens from the isolated M17 route (via the
// same-origin dev proxy) on explicit button click, and renders ONLY safe bounded labels / enums / bounded
// counts and ONLY the 6 allow-listed Backend CP feature flag NAMES. Mirrors the frozen C-04 card.
//
// SAFETY (binding):
//   - DEV-only; rendered ONLY inside the DEV-gated Backend Control Plane shell.
//   - Read-only: the only effect is a GET fetch on button click (no auto-fetch, no useEffect fetch).
//   - Renders ONLY safe labels from bcpC05Client (which strips anything unsafe / non-allow-listed).
//   - NEVER renders a raw environment VALUE, runtime enabled/disabled state, env inventory, value-oracle
//     field, raw ids/secrets/tokens/DB URLs/emails, permission/RBAC keys, raw JSON objects, raw server
//     errors, or stack traces. Only approved flag NAMES + bounded posture labels.
//   - An empty registry is shown HONESTLY as a safe empty state, not as an error.

import React from 'react';
import { cx, DeferToneBadge, LockIcon, Panel, ShieldIcon } from './ui';
import { fetchC05FeatureFlagPostureReadiness, type C05Result } from './bcpC05Client';

const STATE_NOTE: Record<Exclude<C05Result['kind'], 'success'>, { title: string; note: string }> = {
  feature_disabled: {
    title: 'C-05 disabled',
    note: 'The C-05 flag is OFF. Set ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS=true on the DEV identity API, then reload.',
  },
  dev_only: { title: 'DEV-only', note: 'C-05 is DEV-only and is unavailable outside a development environment.' },
  unauthorized: { title: 'Not authorized', note: 'The server-derived principal is not authorized for C-05. (Authority is server-side only.)' },
  parity_blocked: { title: 'Parity blocked', note: 'Parity is not ready, so C-05 is blocked (fail-closed).' },
  method_not_allowed: { title: 'Method not allowed', note: 'C-05 is GET-only. Mutating methods are rejected (read-only).' },
  error: { title: 'Safe error', note: 'The C-05 API returned a safe error. No details are exposed.' },
  unavailable: {
    title: 'C-05 API unavailable',
    note: 'Could not reach the C-05 API through the dev proxy. Start it with `npm run identity:api` and ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS=true, then retry.',
  },
  unexpected: { title: 'Unexpected response', note: 'The response shape was not recognized. Nothing is rendered from it (fail-safe).' },
};

function SafetyBadges() {
  return (
    <div className="flex flex-wrap gap-2">
      <DeferToneBadge tone="healthy">DEV Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Read-Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Code/Config</DeferToneBadge>
      <DeferToneBadge tone="neutral">Flag Names Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Values Never Shown</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Env Values</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Secret Values</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Value Oracle</DeferToneBadge>
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

function SuccessView({ result }: { result: Extract<C05Result, { kind: 'success' }> }) {
  const c = result.summaryCounts;
  return (
    <div>
      <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        Only approved Backend CP feature flag names and posture labels are shown. Runtime values are never displayed.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip k="schema" v={result.schemaVersion} />
        <Chip k="source" v={result.sourceMode} />
        <Chip k="freshness" v={result.freshness} />
        {result.generatedAt && <Chip k="generated" v={result.generatedAt} />}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <DeferToneBadge tone="neutral">total {c.total}</DeferToneBadge>
        <DeferToneBadge tone="healthy">dev-only {c.devOnly}</DeferToneBadge>
        <DeferToneBadge tone="blocked">prod-disabled {c.productionDisabled}</DeferToneBadge>
        <DeferToneBadge tone="neutral">default-off {c.defaultOff}</DeferToneBadge>
        <DeferToneBadge tone="neutral">value-hidden {c.valueHidden}</DeferToneBadge>
        <DeferToneBadge tone="neutral">no-value-oracle {c.noValueOracle}</DeferToneBadge>
        <DeferToneBadge tone="neutral">internal-only {c.internalOnly}</DeferToneBadge>
        <DeferToneBadge tone="warning">unknown {c.unknown}</DeferToneBadge>
      </div>

      {result.emptyState.isEmpty ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <DeferToneBadge tone="neutral">emptyState: {result.emptyState.reason}</DeferToneBadge>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-400">
            No feature flag posture entries available from a server-owned provider. This is not an error —
            the lens is wired and returns a safe empty state.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {result.items.map((it, i) => (
            <div key={`${it.flagKey}:${i}`} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-slate-300">{it.flagName}</span>
                <DeferToneBadge tone="neutral">{it.devGatePosture}</DeferToneBadge>
              </div>
              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-500">
                <span>{it.flagPurpose}</span>
                <span>· owner {it.ownerSurface}</span>
                <span>· {it.defaultPosture}</span>
                <span>· {it.productionPosture}</span>
                <span>· {it.exposurePosture}</span>
                <span>· {it.dataSourcePosture}</span>
                <span>· {it.valueExposurePosture}</span>
                <span>· {it.mutationPosture}</span>
                <span>· {it.evidenceStatus}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <DeferToneBadge tone="blocked">prod: {result.productionPosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">exposure: {result.exposurePosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">mutation: {result.mutationPosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">value: {result.valueExposurePosture}</DeferToneBadge>
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
        Safe posture labels for the six allow-listed Backend CP feature flag names only — never a runtime
        value, env inventory, secret, token, DB/Supabase read, or tenant/store/customer data.
      </p>
    </div>
  );
}

function StateView({ kind }: { kind: Exclude<C05Result['kind'], 'success'> }) {
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

export default function C05FeatureFlagPostureReadinessCard() {
  const [result, setResult] = React.useState<C05Result | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchC05FeatureFlagPostureReadiness();
      setResult(r);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Panel
      title="C-05 Feature Flag Posture Readiness (live code/config)"
      subtitle="DEV-only · read-only · bounded posture labels for the six allow-listed Backend CP feature flag names — flag names only, runtime values are never shown"
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
          {loading ? 'Loading…' : result ? 'Reload C-05' : 'Load C-05 Feature Flag Posture'}
        </button>
      }
    >
      <div className="mb-4">
        <SafetyBadges />
      </div>

      {result === null && !loading && (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-300">
            <ShieldIcon className="h-4 w-4 text-sky-300" /> Idle — click “Load C-05 Feature Flag Posture”
          </span>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Reads the isolated DEV C-05 code/config feature-flag posture via the same-origin dev proxy.
            Requires <span className="font-mono">npm run identity:api</span> with the C-05 flag on;
            otherwise a safe unavailable state is shown. Only flag names + posture labels are shown — never a value.
          </p>
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-sm text-slate-400">
          Loading C-05 feature flag posture…
        </div>
      )}

      {!loading && result !== null && (
        result.kind === 'success' ? <SuccessView result={result} /> : <StateView kind={result.kind} />
      )}
    </Panel>
  );
}
