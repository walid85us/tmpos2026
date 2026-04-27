import { useMemo, useState } from 'react';
import type { Shipment, SlaPolicy } from '../../types';
import {
  computeCarrierScorecards,
  formatCurrency,
  formatDurationMs,
  targetLabel,
  DEFAULT_SCORECARD_FILTERS,
  MIN_SAMPLE_SIZE,
  type CarrierScorecard,
  type ScorecardDateRangePreset,
  type ScorecardDirectionFilter,
  type ScorecardFilters,
  type ScorecardModeFilter,
} from '../../shipping/carrierScorecards';

/**
 * Phase 3 — Carrier Scorecards Foundation (read-only surface)
 *
 * This surface is the operator's per-carrier / per-service / per-provider
 * comparison view. It consumes the deterministic helper
 * `computeCarrierScorecards` and renders the result with explicit
 * data-quality language so an operator can never mistake "no data" for
 * "good performance".
 *
 * Invariants:
 *   - Plan + permission are gated by ShippingCenter BEFORE this component
 *     mounts. As a defensive belt this surface still prop-checks the
 *     two flags so a stale render after downgrade does not leak data.
 *   - Cost rows render only when the operator has `view_shipping_costs`.
 *   - SLA rows render only when the SLA Optimization plan feature is
 *     live AND the operator has `view_shipping_sla` AND we received a
 *     non-undefined SLA policy. Otherwise the SLA section explicitly
 *     shows "SLA Optimization not available".
 *   - Below MIN_SAMPLE_SIZE shipments a card is tagged "Limited data"
 *     and ratios render with the caveat instead of bare percentages.
 *   - No combined numeric grade. We surface metric scorecards only.
 */

export interface CarrierScorecardsProps {
  shipments: Shipment[];
  slaPolicy?: SlaPolicy;
  // Plan + permission gates (also enforced by parent before mounting)
  planAllowsCarrierScorecards: boolean;
  hasViewPermission: boolean;
  // Cost / SLA sub-gates — render the per-section caveat truthfully
  canViewCosts: boolean;
  slaFeatureEnabled: boolean;
  canViewSla: boolean;
}

function PercentBar({ pct, tone = 'slate' }: { pct: number; tone?: 'slate' | 'emerald' | 'amber' | 'rose' }) {
  const safe = Math.max(0, Math.min(100, Math.round(pct)));
  const fill =
    tone === 'emerald' ? 'bg-emerald-500' :
    tone === 'amber' ? 'bg-amber-500' :
    tone === 'rose' ? 'bg-rose-500' :
    'bg-slate-400';
  return (
    <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
      <div className={`${fill} h-full`} style={{ width: `${safe}%` }} />
    </div>
  );
}

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mt-4 mb-2">
      <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500">{title}</h4>
      {hint && <span className="text-[10px] text-slate-400">{hint}</span>}
    </div>
  );
}

function MetricCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-lg font-black text-slate-900 leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const tone =
    provider === 'manual' ? 'bg-slate-100 text-slate-600 border-slate-200' :
    provider === 'easypost' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' :
    provider === 'shippo' ? 'bg-sky-50 text-sky-700 border-sky-200' :
    provider === 'shipstation' ? 'bg-violet-50 text-violet-700 border-violet-200' :
    'bg-slate-50 text-slate-700 border-slate-200';
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${tone}`}>
      {provider}
    </span>
  );
}

function CoverageStrip({ card }: { card: CarrierScorecard }) {
  const cov = card.coverage;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
      <div>
        <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span className="font-bold uppercase tracking-wider">Cost data</span>
          <span>{cov.costCoveragePct}%</span>
        </div>
        <PercentBar pct={cov.costCoveragePct} tone={cov.costCoveragePct >= 80 ? 'emerald' : cov.costCoveragePct >= 50 ? 'amber' : 'rose'} />
        <div className="text-[10px] text-slate-400 mt-0.5">{cov.costCovered} of {cov.shipmentCount} priced</div>
      </div>
      <div>
        <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span className="font-bold uppercase tracking-wider">Provider events</span>
          <span>{cov.providerCoveragePct}%</span>
        </div>
        <PercentBar pct={cov.providerCoveragePct} tone={cov.providerCoveragePct >= 80 ? 'emerald' : cov.providerCoveragePct >= 50 ? 'amber' : 'slate'} />
        <div className="text-[10px] text-slate-400 mt-0.5">Provider-backed share</div>
      </div>
      <div>
        <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span className="font-bold uppercase tracking-wider">Delivery timestamps</span>
          <span>{cov.deliveryCoveragePct}%</span>
        </div>
        <PercentBar pct={cov.deliveryCoveragePct} tone={cov.deliveryCoveragePct >= 80 ? 'emerald' : cov.deliveryCoveragePct >= 50 ? 'amber' : 'slate'} />
        <div className="text-[10px] text-slate-400 mt-0.5">{cov.deliveredCount} delivered</div>
      </div>
      <div>
        <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span className="font-bold uppercase tracking-wider">SLA applicable</span>
          <span>{cov.slaCoveragePct}%</span>
        </div>
        <PercentBar pct={cov.slaCoveragePct} tone={cov.slaCoveragePct >= 80 ? 'emerald' : cov.slaCoveragePct >= 50 ? 'amber' : 'slate'} />
        <div className="text-[10px] text-slate-400 mt-0.5">{cov.slaApplicableCount} with SLA targets</div>
      </div>
    </div>
  );
}

interface ScorecardCardProps {
  card: CarrierScorecard;
  canViewCosts: boolean;
  showSla: boolean;
  // React 19 + this project's TS setup doesn't auto-strip `key` from
  // function-component props at the call site, so we declare it as an
  // optional, never-read prop. React still treats it as the list-key at
  // runtime — this is purely a typing accommodation.
  key?: string | number;
}

function ScorecardCard({
  card,
  canViewCosts,
  showSla,
}: ScorecardCardProps) {
  const u = card.usage;
  const c = card.cost;
  const t = card.transit;
  const p = card.pickup;
  const x = card.exception;
  const s = card.sla;
  const limited = card.coverage.limitedSample;

  // SLA per-card miss rate is only a defensible percentage when there are
  // applicable shipments AND the cohort is above the sample threshold.
  const slaApplicable = s.applicableShipments;
  const totalSlaIssues = s.shipmentsWithMissed + s.shipmentsWithOverdue;
  const slaMissRatePct = slaApplicable > 0 ? Math.round((totalSlaIssues / slaApplicable) * 100) : 0;
  const slaMissTone = slaMissRatePct >= 25 ? 'rose' : slaMissRatePct >= 10 ? 'amber' : 'emerald';

  // Per-target rollup — show only the targets that actually had any
  // recorded met/missed counts so we don't render empty rows.
  const perTargetRows = (Object.keys(s.perTargetMet) as Array<keyof typeof s.perTargetMet>)
    .map(k => ({ key: k as any, met: s.perTargetMet[k], missed: s.perTargetMissed[k] }))
    .filter(row => row.met > 0 || row.missed > 0);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-black text-slate-900">{card.carrierLabel}</h3>
            <span className="text-slate-300">·</span>
            <span className="text-sm font-semibold text-slate-700">{card.serviceLabel}</span>
            <ProviderBadge provider={card.providerLabel} />
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {u.totalShipments} shipment{u.totalShipments === 1 ? '' : 's'} in cohort
            {u.outboundShipments > 0 && u.returnShipments > 0 && (
              <> · {u.outboundShipments} outbound · {u.returnShipments} return</>
            )}
          </div>
        </div>
        {limited && (
          <span className="px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
            <span className="material-symbols-outlined text-xs">info</span>
            Limited data (&lt; {MIN_SAMPLE_SIZE})
          </span>
        )}
      </div>

      {/* Usage */}
      <SectionHeader title="Usage" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MetricCell label="Total" value={String(u.totalShipments)} sub={`${u.providerShipments} provider · ${u.manualShipments} manual`} />
        <MetricCell label="Labels" value={String(u.labelPurchasedCount)} sub="label-created events" />
        <MetricCell label="Delivered" value={String(u.deliveredCount)} sub="with delivered timestamp" />
        <MetricCell label="Cancelled" value={String(u.cancelledCount)} />
      </div>

      {/* Cost */}
      <SectionHeader title="Cost" hint={canViewCosts ? undefined : 'requires View Shipping Costs'} />
      {canViewCosts ? (
        c.costedShipments === 0 ? (
          <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 border border-slate-100">
            No cost data recorded for this group.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCell
              label="Avg label cost"
              value={formatCurrency(c.averageCost)}
              sub={limited ? `${c.costedShipments} sample${c.costedShipments === 1 ? '' : 's'} · limited` : `${c.costedShipments} sample${c.costedShipments === 1 ? '' : 's'}`}
            />
            <MetricCell label="Min" value={formatCurrency(c.minCost)} />
            <MetricCell label="Max" value={formatCurrency(c.maxCost)} />
            <MetricCell label="Total spend" value={formatCurrency(c.totalSpend)} />
          </div>
        )
      ) : (
        <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 border border-slate-100">
          Cost metrics are hidden — operator does not have <span className="font-mono">view_shipping_costs</span>.
        </div>
      )}

      {/* SLA */}
      <SectionHeader title="SLA" hint={showSla ? undefined : 'SLA Optimization not available'} />
      {showSla ? (
        slaApplicable === 0 ? (
          <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 border border-slate-100">
            No SLA-applicable shipments in this group — lifecycle data is missing or the policy disables every target.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <MetricCell
                label="Miss rate"
                value={limited ? `${slaMissRatePct}%*` : `${slaMissRatePct}%`}
                sub={`${totalSlaIssues} of ${slaApplicable} applicable`}
              />
              <MetricCell label="At risk" value={String(s.shipmentsWithAtRisk)} />
              <MetricCell label="Paused" value={String(s.shipmentsPaused)} />
              <MetricCell label="All targets met" value={String(s.shipmentsAllMet)} />
            </div>
            <div className="mt-2">
              <PercentBar pct={slaMissRatePct} tone={slaMissTone as any} />
            </div>
            {perTargetRows.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Per-target breakdown</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                  {perTargetRows.map(row => (
                    <div key={row.key} className="flex items-center justify-between text-[11px] bg-slate-50 rounded-lg px-3 py-1.5 border border-slate-100">
                      <span className="font-semibold text-slate-700">{targetLabel(row.key)}</span>
                      <span className="text-slate-500">
                        <span className="text-emerald-600 font-bold">{row.met}</span> met · <span className="text-rose-600 font-bold">{row.missed}</span> missed
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )
      ) : (
        <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 border border-slate-100">
          SLA metrics are hidden — the SLA Optimization feature is not active for this plan or operator.
        </div>
      )}

      {/* Transit */}
      <SectionHeader title="Transit timing" hint="averages render only when ≥ 3 valid timestamp pairs exist" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <MetricCell
          label="Label → Dispatch"
          value={formatDurationMs(t.avgLabelToDispatchMs)}
          sub={`${t.labelToDispatchSamples} sample${t.labelToDispatchSamples === 1 ? '' : 's'}`}
        />
        <MetricCell
          label="Dispatch → Delivery"
          value={formatDurationMs(t.avgDispatchToDeliveryMs)}
          sub={`${t.dispatchToDeliverySamples} sample${t.dispatchToDeliverySamples === 1 ? '' : 's'}`}
        />
        <MetricCell
          label="Label → Delivery"
          value={formatDurationMs(t.avgLabelToDeliveryMs)}
          sub={`${t.labelToDeliverySamples} sample${t.labelToDeliverySamples === 1 ? '' : 's'}`}
        />
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <MetricCell label="Dispatched" value={String(t.dispatchedCount)} sub="distinct from in-transit" />
        <MetricCell label="In transit" value={String(t.inTransitCount)} />
        <MetricCell label="Exception" value={String(t.exceptionCount)} />
      </div>

      {/* Pickup */}
      <SectionHeader title="Pickup execution" />
      {p.requested === 0 ? (
        <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 border border-slate-100">
          No pickups requested for this group.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <MetricCell label="Requested" value={String(p.requested)} />
          <MetricCell label="Provider-confirmed" value={String(p.providerConfirmed)} />
          <MetricCell label="Local-only" value={String(p.localOnly)} sub="not provider-confirmed" />
          <MetricCell label="Cancelled" value={String(p.cancelled)} />
          <MetricCell label="Failed" value={String(p.failed)} />
        </div>
      )}

      {/* Exceptions */}
      <SectionHeader title="Exceptions" />
      <div className="grid grid-cols-3 gap-2">
        <MetricCell label="Shipment exceptions" value={String(x.shipmentExceptionCount)} />
        <MetricCell label="Cancellations" value={String(x.cancelledCount)} />
        <MetricCell label="Unresolved SLA" value={showSla ? String(x.unresolvedSlaExceptionCount) : '—'} sub={showSla ? 'missed/overdue not resolved' : 'requires SLA Optimization'} />
      </div>

      {/* Coverage strip */}
      <SectionHeader title="Data coverage" hint="ratios are only as defensible as the underlying data" />
      <CoverageStrip card={card} />
    </div>
  );
}

export default function CarrierScorecards(props: CarrierScorecardsProps) {
  const {
    shipments,
    slaPolicy,
    planAllowsCarrierScorecards,
    hasViewPermission,
    canViewCosts,
    slaFeatureEnabled,
    canViewSla,
  } = props;

  const [filters, setFilters] = useState<ScorecardFilters>(DEFAULT_SCORECARD_FILTERS);

  // Defensive plan/permission gating — the parent already gates the tab,
  // but a stale render after a downgrade should not leak data.
  if (!planAllowsCarrierScorecards) {
    return (
      <div className="bg-white rounded-2xl border border-amber-200 p-6 text-center">
        <span className="material-symbols-outlined text-amber-500 text-3xl">workspace_premium</span>
        <p className="text-sm font-black text-slate-700 mt-2">Carrier Scorecards are not included in your current plan</p>
        <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Scorecards require a plan with the <span className="font-mono">Carrier Scorecards</span> feature.</p>
      </div>
    );
  }
  if (!hasViewPermission) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
        <span className="material-symbols-outlined text-slate-400 text-3xl">lock</span>
        <p className="text-sm font-black text-slate-700 mt-2">You don't have permission to view Carrier Scorecards</p>
        <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Ask an administrator to grant the <span className="font-mono">view_carrier_scorecards</span> permission.</p>
      </div>
    );
  }

  // The SLA section is only meaningful when the SLA plan feature, the
  // view permission, AND a policy are all present. We check all three
  // here so the parent can stay simple.
  const showSla = slaFeatureEnabled && canViewSla && slaPolicy != null;

  const result = useMemo(
    () => computeCarrierScorecards(shipments, filters, showSla ? slaPolicy : undefined, Date.now()),
    [shipments, filters, slaPolicy, showSla]
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-50 to-white rounded-2xl border border-indigo-100 p-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-indigo-500">leaderboard</span>
          <div>
            <h2 className="text-base font-black text-slate-900">Carrier Scorecards</h2>
            <p className="text-[11px] text-slate-600 mt-0.5 max-w-3xl">
              Per-carrier / service / provider performance derived from your recorded shipment, event, pickup and SLA data.
              Cards below the {MIN_SAMPLE_SIZE}-shipment threshold are tagged <span className="font-bold">Limited data</span> so a small sample is not mistaken for a confident signal.
              No combined numeric grade is shown — compare the metric scorecards directly.
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-slate-200 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Date range</div>
            <select
              value={filters.range}
              onChange={e => setFilters(f => ({ ...f, range: e.target.value as ScorecardDateRangePreset }))}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Mode</div>
            <select
              value={filters.mode}
              onChange={e => setFilters(f => ({ ...f, mode: e.target.value as ScorecardModeFilter }))}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="all">All</option>
              <option value="provider">Provider</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Direction</div>
            <select
              value={filters.direction}
              onChange={e => setFilters(f => ({ ...f, direction: e.target.value as ScorecardDirectionFilter }))}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="all">All</option>
              <option value="outbound">Outbound</option>
              <option value="return">Return</option>
            </select>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Carrier</div>
            <select
              value={filters.carrier}
              onChange={e => setFilters(f => ({ ...f, carrier: e.target.value }))}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="all">All carriers</option>
              {result.availableCarriers.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Service</div>
            <select
              value={filters.serviceLevel}
              onChange={e => setFilters(f => ({ ...f, serviceLevel: e.target.value }))}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="all">All services</option>
              {result.availableServiceLevels.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Provider</div>
            <select
              value={filters.provider}
              onChange={e => setFilters(f => ({ ...f, provider: e.target.value }))}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="all">All providers</option>
              {result.availableProviders.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="ml-auto text-[11px] text-slate-500">
            <span className="font-bold text-slate-800">{result.cohortShipmentCount}</span> shipments ·
            <span className="font-bold text-slate-800"> {result.cohortCarrierCount}</span> carriers ·
            <span className="font-bold text-slate-800"> {result.cohortServiceCount}</span> services ·
            <span className="font-bold text-slate-800"> {result.scorecards.length}</span> cards
          </div>
        </div>
      </div>

      {/* Scorecards */}
      {result.scorecards.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
          <span className="material-symbols-outlined text-slate-400 text-3xl">inbox</span>
          <p className="text-sm font-black text-slate-700 mt-2">No shipments match the current filters</p>
          <p className="text-xs text-slate-500 mt-1">Adjust the date range or filters above to see scorecards.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {result.scorecards.map((card: CarrierScorecard) => (
            <ScorecardCard
              key={card.key}
              card={card}
              canViewCosts={canViewCosts}
              showSla={showSla}
            />
          ))}
        </div>
      )}

      {/* Definitions footer */}
      <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Metric definitions</h3>
        <ul className="text-[11px] text-slate-600 space-y-1.5 list-disc pl-4">
          <li><span className="font-bold">Sample threshold:</span> a card with fewer than {MIN_SAMPLE_SIZE} cohort shipments is tagged "Limited data". Per-card ratios are still shown but with the caveat — small samples are not a confident signal.</li>
          <li><span className="font-bold">Mode:</span> a shipment is "provider" when it has a selected rate, otherwise "manual" — same rule used by the rest of Shipping Center.</li>
          <li><span className="font-bold">Provider label:</span> derived from <span className="font-mono">providerShipmentId</span> ("easypost" / "shippo" / "shipstation"), or "manual" for non-provider shipments.</li>
          <li><span className="font-bold">Cost data:</span> uses the recorded <span className="font-mono">shippingCost</span>; falls back to the operator-accepted selected rate. Shipments without either are counted as "missing", never as zero. Hidden entirely when the operator lacks View Shipping Costs.</li>
          <li><span className="font-bold">Transit averages:</span> render only when at least 3 valid timestamp pairs exist; otherwise the cell shows "—". Dispatched and In Transit are always counted distinctly.</li>
          <li><span className="font-bold">Pickup:</span> "Provider-confirmed" requires <span className="font-mono">live_provider</span> source AND a confirmed/completed status. Other intents are reported as "local-only".</li>
          <li><span className="font-bold">SLA:</span> reuses the canonical SLA engine (<span className="font-mono">summarizeShipmentSla</span>). A shipment counts as missed when the worst target is missed or overdue at evaluation time. Per-target met/missed counts are summed across applicable shipments. Hidden entirely when the SLA Optimization feature is off or the operator lacks View Shipping SLA.</li>
          <li><span className="font-bold">Coverage strip:</span> shows the share of shipments whose underlying data exists for each metric family — a low coverage means the per-card numbers are partial.</li>
          <li><span className="font-bold">No combined score:</span> this foundation deliberately does not produce an overall numeric grade. Compare the metric scorecards directly.</li>
        </ul>
      </div>
    </div>
  );
}
