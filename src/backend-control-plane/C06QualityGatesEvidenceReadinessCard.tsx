// Phase 2.0 M20 — DEV-only Backend CP C-06 Quality Gates / Evidence Coverage Posture Readiness preview card.
//
// Presentational card that loads the C-06 evidence-coverage lens from the isolated M20 route (via the
// same-origin dev proxy) on explicit button click, and renders ONLY safe bounded labels / enums / bounded
// counts and ONLY the 12 allow-listed evidence categories. Mirrors the frozen C-05 card.
//
// SAFETY (binding):
//   - DEV-only; rendered ONLY inside the DEV-gated Backend Control Plane shell.
//   - Read-only: the only effect is a GET fetch on button click (no auto-fetch, no useEffect fetch).
//   - Renders ONLY safe labels from bcpC06Client (which strips anything unsafe / non-allow-listed).
//   - NEVER renders a raw log, command output, stdout/stderr, stack trace, raw error, file path, source
//     filename, package/dependency/version detail, screenshot/trace/video/report, runtime diagnostic, build
//     internal, production-readiness claim, secret/token/DB URL/email, permission/RBAC key, raw JSON object,
//     or raw server error. Only approved evidence categories + bounded posture labels.
//   - An empty registry is shown HONESTLY as a safe empty state, not as an error.

import React from 'react';
import { cx, DeferToneBadge, LockIcon, Panel, ShieldIcon } from './ui';
import { fetchC06QualityGatesEvidenceReadiness, type C06Result } from './bcpC06Client';

const STATE_NOTE: Record<Exclude<C06Result['kind'], 'success'>, { title: string; note: string }> = {
  feature_disabled: {
    title: 'C-06 disabled',
    note: 'The C-06 flag is OFF. Set ENABLE_BCP_DEV_C06_QUALITY_GATES_EVIDENCE_COVERAGE_READINESS=true on the DEV identity API, then reload.',
  },
  dev_only: { title: 'DEV-only', note: 'C-06 is DEV-only and is unavailable outside a development environment.' },
  unauthorized: { title: 'Not authorized', note: 'The server-derived principal is not authorized for C-06. (Authority is server-side only.)' },
  parity_blocked: { title: 'Parity blocked', note: 'Parity is not ready, so C-06 is blocked (fail-closed).' },
  method_not_allowed: { title: 'Method not allowed', note: 'C-06 is GET-only. Mutating methods are rejected (read-only).' },
  error: { title: 'Safe error', note: 'The C-06 API returned a safe error. No details are exposed.' },
  unavailable: {
    title: 'C-06 API unavailable',
    note: 'Could not reach the C-06 API through the dev proxy. Start it with `npm run identity:api` and ENABLE_BCP_DEV_C06_QUALITY_GATES_EVIDENCE_COVERAGE_READINESS=true, then retry.',
  },
  unexpected: { title: 'Unexpected response', note: 'The response shape was not recognized. Nothing is rendered from it (fail-safe).' },
};

function SafetyBadges() {
  return (
    <div className="flex flex-wrap gap-2">
      <DeferToneBadge tone="healthy">DEV Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Read-Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Code/Config</DeferToneBadge>
      <DeferToneBadge tone="neutral">Evidence Labels Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Raw Logs</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Command Output</DeferToneBadge>
      <DeferToneBadge tone="neutral">No File Paths</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Package Details</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Runtime Diagnostics</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Production Claim</DeferToneBadge>
      <DeferToneBadge tone="neutral">No DB / Supabase</DeferToneBadge>
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

function SuccessView({ result }: { result: Extract<C06Result, { kind: 'success' }> }) {
  const c = result.summaryCounts;
  return (
    <div>
      <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        Only approved evidence categories and posture labels are shown. Raw logs, command output, file paths,
        package details, and production-readiness claims are never shown.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip k="schema" v={result.schemaVersion} />
        <Chip k="source" v={result.sourceMode} />
        <Chip k="freshness" v={result.freshness} />
        {result.generatedAt && <Chip k="generated" v={result.generatedAt} />}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <DeferToneBadge tone="neutral">total {c.total}</DeferToneBadge>
        <DeferToneBadge tone="healthy">documented {c.documented}</DeferToneBadge>
        <DeferToneBadge tone="neutral">code-config {c.codeConfigOnly}</DeferToneBadge>
        <DeferToneBadge tone="neutral">no-raw-logs {c.noRawLogs}</DeferToneBadge>
        <DeferToneBadge tone="neutral">no-command-output {c.noCommandOutput}</DeferToneBadge>
        <DeferToneBadge tone="blocked">no-prod-claim {c.noProductionClaim}</DeferToneBadge>
        <DeferToneBadge tone="neutral">internal-only {c.internalOnly}</DeferToneBadge>
        <DeferToneBadge tone="warning">unknown {c.unknown}</DeferToneBadge>
      </div>

      {result.emptyState.isEmpty ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <DeferToneBadge tone="neutral">emptyState: {result.emptyState.reason}</DeferToneBadge>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-400">
            No quality-gate evidence entries available from a server-owned provider. This is not an error —
            the lens is wired and returns a safe empty state.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {result.items.map((it, i) => (
            <div key={`${it.evidenceKey}:${i}`} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-slate-300">{it.evidenceLabel}</span>
                <DeferToneBadge tone="neutral">{it.evidenceStatus}</DeferToneBadge>
              </div>
              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-500">
                <span>{it.evidenceKey}</span>
                <span>· owner {it.ownerSurface}</span>
                <span>· {it.evidencePurpose}</span>
                <span>· expected {it.expectedCoveragePosture}</span>
                <span>· test {it.testCoveragePosture}</span>
                <span>· typecheck {it.typecheckPosture}</span>
                <span>· scan {it.staticScanPosture}</span>
                <span>· transport {it.transportPosture}</span>
                <span>· browser {it.browserEvidencePosture}</span>
                <span>· regression {it.regressionPosture}</span>
                <span>· source {it.sourceScopePosture}</span>
                <span>· {it.productionPosture}</span>
                <span>· {it.mutationPosture}</span>
                <span>· {it.dataSourcePosture}</span>
                <span>· {it.logExposurePosture}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <DeferToneBadge tone="blocked">prod: {result.productionPosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">logs: {result.logExposurePosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">mutation: {result.mutationPosture}</DeferToneBadge>
        <DeferToneBadge tone="neutral">source: {result.dataSourcePosture}</DeferToneBadge>
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
        Safe coverage-posture labels for the twelve allow-listed evidence categories only — never a raw log,
        command output, test/typecheck/static-scan output, file path, package detail, runtime diagnostic,
        build internal, production-readiness claim, secret, token, DB/Supabase read, or tenant/store/customer data.
      </p>
    </div>
  );
}

function StateView({ kind }: { kind: Exclude<C06Result['kind'], 'success'> }) {
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

export default function C06QualityGatesEvidenceReadinessCard() {
  const [result, setResult] = React.useState<C06Result | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchC06QualityGatesEvidenceReadiness();
      setResult(r);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Panel
      title="C-06 Quality Gates Evidence Posture (live code/config)"
      subtitle="DEV-only · read-only · bounded coverage-posture labels for the twelve allow-listed evidence categories — evidence labels only; raw logs, command output, file paths, package details, and production-readiness claims are never shown"
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
          {loading ? 'Loading…' : result ? 'Reload C-06' : 'Load C-06 Evidence Posture'}
        </button>
      }
    >
      <div className="mb-4">
        <SafetyBadges />
      </div>

      {result === null && !loading && (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-300">
            <ShieldIcon className="h-4 w-4 text-sky-300" /> Idle — click “Load C-06 Evidence Posture”
          </span>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Reads the isolated DEV C-06 code/config evidence-coverage posture via the same-origin dev proxy.
            Requires <span className="font-mono">npm run identity:api</span> with the C-06 flag on;
            otherwise a safe unavailable state is shown. Only evidence categories + posture labels are shown —
            never raw logs, command output, file paths, package details, or a production-readiness claim.
          </p>
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-sm text-slate-400">
          Loading C-06 quality gates evidence posture…
        </div>
      )}

      {!loading && result !== null && (
        result.kind === 'success' ? <SuccessView result={result} /> : <StateView kind={result.kind} />
      )}
    </Panel>
  );
}
