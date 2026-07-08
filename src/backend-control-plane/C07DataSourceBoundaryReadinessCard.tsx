// Phase 2.0 M48 — DEV-only Backend CP C-07 Data-Source-Boundary Readiness preview card.
//
// Presentational card that loads the C-07 data-source-boundary lens from the isolated route (via the
// same-origin dev proxy) on explicit button click, and renders ONLY the accepted C-07 client's safe view
// model: closed-enum posture labels, bounded counts, and safe boundary/item labels. Mirrors the frozen C-06
// card STRUCTURALLY, but renders C-07's own field set — NOT C-06's. In particular C-07 has no `generatedAt`
// chip, and its empty-state is a FLAT `emptyState` (boolean) + `emptyStateReason` (string), unlike C-06.
//
// SAFETY (binding):
//   - DEV-only; rendered ONLY inside the DEV-gated Backend Control Plane shell (this card is NOT registered
//     in screens.tsx — it is unreachable until a separate, owner-authorized registration milestone).
//   - Read-only: the only effect is a GET fetch on button click (no auto-fetch, no useEffect fetch).
//   - Renders ONLY safe values from bcpC07Client, whose closed allow-list normalizes anything unsafe/unknown
//     to the closed member `redacted`. The card invents no field the client does not emit.
//   - NEVER renders a raw log, command output, stdout/stderr, stack trace, raw error, raw JSON/response object,
//     file path, package/dependency/version detail, runtime diagnostic, DB/Supabase/live-provider detail, env
//     value, secret/token/credential, value-oracle content, the client URL / route path / VITE_IDENTITY_API_BASE,
//     `generatedAt`/timestamp, or a production-readiness / browser / real-socket claim.
//   - No dangerouslySetInnerHTML, no arbitrary HTML, no mutation/approval/override controls, no navigation.
//   - An empty boundary set is shown HONESTLY as a safe empty state, not as an error.

import React from 'react';
import { cx, DeferToneBadge, LockIcon, Panel, ShieldIcon } from './ui';
import { fetchC07DataSourceBoundaryReadiness, type C07Result } from './bcpC07Client';

const STATE_NOTE: Record<Exclude<C07Result['kind'], 'success'>, { title: string; note: string }> = {
  feature_disabled: {
    title: 'C-07 disabled',
    note: 'The C-07 flag is OFF on the DEV identity API. Enable the C-07 data-source-boundary readiness flag, then reload.',
  },
  dev_only: { title: 'DEV-only', note: 'C-07 is DEV-only and is unavailable outside a development environment.' },
  unauthorized: { title: 'Not authorized', note: 'The server-derived principal is not authorized for C-07. (Authority is server-side only.)' },
  parity_blocked: { title: 'Parity blocked', note: 'Parity is not ready, so C-07 is blocked (fail-closed).' },
  method_not_allowed: { title: 'Method not allowed', note: 'C-07 is GET-only. Mutating methods are rejected (read-only).' },
  error: { title: 'Safe error', note: 'The C-07 API returned a safe error. No details are exposed.' },
  unavailable: {
    title: 'C-07 API unavailable',
    note: 'Could not reach the C-07 API through the dev proxy. Start the DEV identity API with the C-07 flag on, then retry.',
  },
  unexpected: { title: 'Unexpected response', note: 'The response shape was not recognized. Nothing is rendered from it (fail-safe).' },
};

function SafetyBadges() {
  return (
    <div className="flex flex-wrap gap-2">
      <DeferToneBadge tone="healthy">DEV Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Read-Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">Code/Config</DeferToneBadge>
      <DeferToneBadge tone="neutral">Boundary Labels Only</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Timestamps</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Raw Logs</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Diagnostics</DeferToneBadge>
      <DeferToneBadge tone="neutral">No File Paths</DeferToneBadge>
      <DeferToneBadge tone="neutral">No DB / Supabase</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Live Provider</DeferToneBadge>
      <DeferToneBadge tone="neutral">No Value Oracle</DeferToneBadge>
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

function SuccessView({ result }: { result: Extract<C07Result, { kind: 'success' }> }) {
  const c = result.summaryCounts;
  return (
    <div>
      <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        Declared code/config posture only — a design-time self-attestation, not live verification. Raw logs,
        diagnostics, DB/Supabase/live-provider detail, timestamps, and production-readiness claims are never shown.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip k="schema" v={result.schemaVersion} />
        <Chip k="self-attestation" v={result.selfAttestation} />
        <Chip k="source" v={result.sourceMode} />
        <Chip k="freshness" v={result.freshness} />
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <DeferToneBadge tone="neutral">total {c.total}</DeferToneBadge>
        <DeferToneBadge tone="neutral">code-config {c.codeConfigOnly}</DeferToneBadge>
        <DeferToneBadge tone="neutral">synthetic {c.syntheticOnly}</DeferToneBadge>
        <DeferToneBadge tone="healthy">no-db {c.noDb}</DeferToneBadge>
        <DeferToneBadge tone="healthy">no-sql {c.noSql}</DeferToneBadge>
        <DeferToneBadge tone="healthy">no-supabase {c.noSupabase}</DeferToneBadge>
        <DeferToneBadge tone="healthy">no-live-provider {c.noLiveProvider}</DeferToneBadge>
        <DeferToneBadge tone="healthy">no-env-values {c.noRuntimeEnvValues}</DeferToneBadge>
        <DeferToneBadge tone="healthy">no-diagnostics {c.noRawDiagnostics}</DeferToneBadge>
        <DeferToneBadge tone="healthy">no-command-output {c.noCommandOutput}</DeferToneBadge>
        <DeferToneBadge tone="blocked">production-disabled {c.productionDisabled}</DeferToneBadge>
        <DeferToneBadge tone="neutral">read-only {c.readOnly}</DeferToneBadge>
        <DeferToneBadge tone="neutral">mutation-blocked {c.mutationBlocked}</DeferToneBadge>
        <DeferToneBadge tone="neutral">value-oracle-blocked {c.valueOracleBlocked}</DeferToneBadge>
        <DeferToneBadge tone="neutral">customer-exposure-blocked {c.customerExposureBlocked}</DeferToneBadge>
        <DeferToneBadge tone="warning">unknown-redacted {c.unknownRedacted}</DeferToneBadge>
      </div>

      {result.emptyState ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <DeferToneBadge tone="neutral">emptyState: {result.emptyStateReason}</DeferToneBadge>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-400">
            No data-source-boundary items available from a server-owned provider. This is not an error — the
            lens is wired and returns a safe empty state.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {result.items.map((it, i) => (
            <div key={`${it.boundaryKey}:${i}`} className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-slate-300">{it.boundaryLabel}</span>
                <DeferToneBadge tone="neutral">{it.evidenceStatus}</DeferToneBadge>
              </div>
              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-slate-500">
                <span>{it.boundaryKey}</span>
                <span>· owner {it.ownerSurface}</span>
                <span>· {it.boundaryPurpose}</span>
                <span>· source {it.sourceMode}</span>
                <span>· data {it.dataSourcePosture}</span>
                <span>· db {it.dbPosture}</span>
                <span>· sql {it.sqlPosture}</span>
                <span>· supabase {it.supabasePosture}</span>
                <span>· provider {it.liveProviderPosture}</span>
                <span>· env {it.runtimeEnvPosture}</span>
                <span>· command {it.commandOutputPosture}</span>
                <span>· diagnostics {it.diagnosticsPosture}</span>
                <span>· raw-evidence {it.rawEvidencePosture}</span>
                <span>· value-oracle {it.valueOraclePosture}</span>
                <span>· {it.productionPosture}</span>
                <span>· {it.mutationPosture}</span>
                <span>· {it.customerExposurePosture}</span>
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
        <DeferToneBadge tone="neutral">value-oracle: {result.valueOraclePosture}</DeferToneBadge>
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
        Safe closed-enum boundary-posture labels only — a declared design-time code/config self-attestation. This
        is not live verification, not production readiness, not browser evidence, and not real-socket/live
        transport evidence. Never a raw log, command output, diagnostic, file path, package detail, DB/Supabase
        read, live-provider detail, secret, token, timestamp, or tenant/store/customer datum.
      </p>
    </div>
  );
}

function StateView({ kind }: { kind: Exclude<C07Result['kind'], 'success'> }) {
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

export default function C07DataSourceBoundaryReadinessCard() {
  const [result, setResult] = React.useState<C07Result | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchC07DataSourceBoundaryReadiness();
      setResult(r);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Panel
      title="C-07 Data Source Boundary Readiness (live code/config)"
      subtitle="DEV-only · read-only · closed-enum boundary-posture labels — a declared design-time code/config self-attestation, not live verification; raw logs, diagnostics, DB/Supabase/live-provider detail, timestamps, and production-readiness claims are never shown"
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
          {loading ? 'Loading…' : result ? 'Reload C-07' : 'Load C-07 Boundary Readiness'}
        </button>
      }
    >
      <div className="mb-4">
        <SafetyBadges />
      </div>

      {result === null && !loading && (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-4 py-6 text-center">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-300">
            <ShieldIcon className="h-4 w-4 text-sky-300" /> Idle — click “Load C-07 Boundary Readiness”
          </span>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Reads the isolated DEV C-07 data-source-boundary readiness posture via the same-origin dev proxy.
            Requires the DEV identity API with the C-07 flag on; otherwise a safe unavailable state is shown.
            Only closed-enum boundary-posture labels are shown — never raw logs, diagnostics, DB/Supabase/live
            reads, timestamps, or a production-readiness claim.
          </p>
        </div>
      )}

      {loading && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-sm text-slate-400">
          Loading C-07 data-source-boundary readiness…
        </div>
      )}

      {!loading && result !== null && (
        result.kind === 'success' ? <SuccessView result={result} /> : <StateView kind={result.kind} />
      )}
    </Panel>
  );
}
