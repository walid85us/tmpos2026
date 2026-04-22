import { useMemo, useState } from 'react';
import type { Shipment, ShipmentSourceType, PickupRequestStatus } from '../../types';

/**
 * Phase 2 — Carrier Analytics Foundation
 *
 * This is a deterministic, read-only analytics surface inside Shipping
 * Center. All metrics are derived from already-stored shipment / pickup /
 * event data — nothing is invented. When the underlying data is
 * insufficient, the metric renders an explicit unknown / insufficient-data
 * state instead of a fabricated number.
 *
 * Derivation rules (single source of truth — also documented in replit.md):
 * --------------------------------------------------------------------------
 * Source data:
 *   - shipments[]                  → src/types.ts Shipment
 *   - shipments[i].events[]        → ShipmentEvent.status string values
 *                                     'Label Created', 'Dispatched',
 *                                     'In Transit', 'Delivered',
 *                                     'Exception', 'Cancelled',
 *                                     'Pickup Cancelled' (typed as any
 *                                     in a couple of legacy paths)
 *   - shipments[i].pickupRequest   → PickupRequest object (optional)
 *
 * Per-shipment derived signals:
 *   labelCreatedAt   = first event with status === 'Label Created'
 *                       .timestamp; otherwise undefined.
 *   dispatchedAt     = shipment.dispatchedAt (preferred) ||
 *                      first event with status === 'Dispatched'
 *                       .timestamp; otherwise undefined.
 *   deliveredAt      = shipment.deliveredAt (preferred) ||
 *                      first event with status === 'Delivered'
 *                       .timestamp; otherwise undefined.
 *   isReturn         = shipment.returnInfo?.isReturn === true.
 *   isProviderMode   = shipment.shipmentMode === 'provider'.
 *   carrierLabel     = shipment.carrier || 'Unknown'.
 *   serviceLabel     = shipment.serviceLevel || 'Unknown'.
 *   providerLabel    = shipment.providerShipmentId
 *                       ? (derived first segment, see resolveProviderLabel)
 *                       : 'manual'.
 *
 * Filter window:
 *   We filter shipments by createdAt within the active date range. This
 *   keeps the cohort stable regardless of subsequent state changes.
 *   "All time" disables the date filter entirely.
 *
 * Counts (always truthful — explicit definitions):
 *   shipmentCount             = filtered.length
 *   providerShipmentCount     = count where shipmentMode === 'provider'
 *   manualShipmentCount       = count where shipmentMode === 'manual'
 *   labelPurchasedCount       = count where any event.status === 'Label Created'
 *                                (proxy for "label exists" — labels can also
 *                                exist without an event row in early
 *                                provider-bypass paths; we ONLY count when
 *                                there is a real event row, to stay truthful)
 *   pickupRequestedCount      = count where pickupRequest exists
 *   pickupConfirmedCount      = count where pr.status === 'confirmed' OR
 *                                'completed' AND source === 'live_provider'
 *                                (we explicitly require live_provider so
 *                                 local-only intents are NOT silently
 *                                 inflated into "provider-confirmed" — they
 *                                 are surfaced separately as
 *                                 pickupLocalOnlyCount)
 *   pickupLocalOnlyCount      = count where pr exists AND
 *                                source !== 'live_provider'
 *   pickupCancelledCount      = count where pr.status === 'cancelled'
 *   pickupFailedCount         = count where pr.status in
 *                                ['failed','rejected','partial_failed']
 *   deliveredCount            = count where derived deliveredAt exists
 *   inTransitCount            = count where shipment.status in
 *                                ['Dispatched','In Transit']
 *   exceptionCount            = count where shipment.status === 'Exception'
 *   cancelledShipmentCount    = count where shipment.status === 'Cancelled'
 *
 * Cost metrics (only when `canViewCosts === true`):
 *   shipmentsWithCost         = count where typeof shippingCost === 'number'
 *   shippingSpend             = sum of shippingCost
 *   avgShippingCost           = shippingSpend / shipmentsWithCost
 *   coverageRatio (cost)      = shipmentsWithCost / shipmentCount
 *   We surface the coverage ratio next to the spend so the operator knows
 *   the average is "real over N samples", not a magic number.
 *
 * Lifecycle timing (only when ≥3 valid samples):
 *   avgLabelToDelivered       = avg(deliveredAt - labelCreatedAt) over
 *                                shipments where BOTH timestamps exist.
 *   avgDispatchedToDelivered  = avg(deliveredAt - dispatchedAt) over
 *                                shipments where BOTH timestamps exist.
 *   If sample size < 3 we render an "Insufficient data" badge instead of
 *   a number. We never extrapolate or infer missing timestamps.
 *
 * Distributions:
 *   carrier distribution      = groupBy(carrierLabel)
 *   service-level distribution= groupBy(serviceLabel)
 *   We always include an "Unknown" bucket (never silently hide rows
 *   missing carrier / service data) so coverage is visible.
 *
 * Coverage / data-quality signals (rendered as a row of chips):
 *   coverage.carrier          = % shipments with non-empty carrier
 *   coverage.serviceLevel     = % shipments with non-empty serviceLevel
 *   coverage.dispatchTs       = % shipments with derived dispatchedAt
 *   coverage.deliveredTs      = % shipments with derived deliveredAt
 *   coverage.cost             = % shipments with shippingCost (only when
 *                                 canViewCosts)
 *
 * What this surface explicitly is NOT (yet):
 *   - carrier scorecards / SLA grading
 *   - lane / route analytics
 *   - automation-rule recommendations
 *   - exception-reporting workflows
 *   - customs-docs analytics
 *   - insurance-rules analytics
 *   These are deferred. The foundation deliberately exposes deterministic
 *   counts + coverage so future scorecards can build on top without
 *   rewriting the metric layer.
 */

type DateRangePreset = '7d' | '30d' | '90d' | 'all' | 'custom';
type ModeFilter = 'all' | 'provider' | 'manual';
type DirectionFilter = 'all' | 'outbound' | 'return';

interface CarrierAnalyticsProps {
  shipments: Shipment[];
  canViewCosts: boolean;
  /** When false the entire surface renders a plan-gated state. */
  planAllowsCarrierAnalytics: boolean;
  /** When false the surface renders a permission-gated state. */
  hasViewPermission: boolean;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function presetRange(preset: DateRangePreset): { from: string; to: string } | null {
  if (preset === 'all' || preset === 'custom') return null;
  const now = new Date();
  const to = ymd(now);
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const fromDate = new Date(now.getTime() - (days - 1) * 86400000);
  return { from: ymd(fromDate), to };
}

function parseTs(s?: string): number | null {
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

function eventTs(s: Shipment, status: string): number | null {
  for (const ev of s.events || []) {
    if ((ev.status as unknown as string) === status) {
      const t = parseTs(ev.timestamp);
      if (t != null) return t;
    }
  }
  return null;
}

function deriveLabelCreatedAt(s: Shipment): number | null { return eventTs(s, 'Label Created'); }
function deriveDispatchedAt(s: Shipment): number | null {
  return parseTs(s.dispatchedAt) ?? eventTs(s, 'Dispatched');
}
function deriveDeliveredAt(s: Shipment): number | null {
  return parseTs(s.deliveredAt) ?? eventTs(s, 'Delivered');
}

function resolveProviderLabel(s: Shipment): string {
  if (s.shipmentMode !== 'provider') return 'manual';
  const id = s.providerShipmentId || '';
  // EasyPost ids start with `shp_`, Shippo with `shippo_`, ShipStation numeric, etc.
  if (id.startsWith('shp_')) return 'easypost';
  if (id.startsWith('shippo_') || id.startsWith('adr_') && id.length > 8) return 'shippo';
  if (/^[0-9]{6,}$/.test(id)) return 'shipstation';
  return 'provider';
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

function fmtPct(num: number, den: number): string {
  if (den <= 0) return '—';
  const pct = (num / den) * 100;
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

function MetricCard({ label, value, sub, tone = 'slate', help }: { label: string; value: string; sub?: string; tone?: 'slate' | 'primary' | 'emerald' | 'amber' | 'rose' | 'sky'; help?: string }) {
  const toneCls: Record<string, string> = {
    slate: 'border-slate-200 bg-white',
    primary: 'border-primary/30 bg-primary/5',
    emerald: 'border-emerald-200 bg-emerald-50',
    amber: 'border-amber-200 bg-amber-50',
    rose: 'border-rose-200 bg-rose-50',
    sky: 'border-sky-200 bg-sky-50',
  };
  return (
    <div className={`rounded-2xl border ${toneCls[tone]} p-3`}>
      <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">{label}</p>
      <p className="text-2xl font-black text-slate-800 mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p>}
      {help && <p className="text-[10px] text-slate-400 mt-1 italic leading-snug">{help}</p>}
    </div>
  );
}

function InsufficientBadge({ samples, min = 3 }: { samples: number; min?: number }) {
  return (
    <span className="text-[9px] font-mono font-black text-amber-700 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded">
      insufficient-data: {samples}/{min}
    </span>
  );
}

function CoverageChip({ label, num, den, tone }: { label: string; num: number; den: number; tone: 'good' | 'partial' | 'poor' }) {
  const cls = tone === 'good' ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
    : tone === 'partial' ? 'bg-amber-50 text-amber-700 border-amber-300'
    : 'bg-rose-50 text-rose-700 border-rose-300';
  return (
    <span className={`text-[10px] font-mono font-black px-1.5 py-0.5 rounded border ${cls}`}>
      {label}: <span className="tabular-nums">{num}/{den}</span> ({fmtPct(num, den)})
    </span>
  );
}

function coverageTone(num: number, den: number): 'good' | 'partial' | 'poor' {
  if (den === 0) return 'poor';
  const r = num / den;
  if (r >= 0.9) return 'good';
  if (r >= 0.5) return 'partial';
  return 'poor';
}

export function CarrierAnalytics({ shipments, canViewCosts, planAllowsCarrierAnalytics, hasViewPermission }: CarrierAnalyticsProps) {
  // ------ Filter state ------
  const [datePreset, setDatePreset] = useState<DateRangePreset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [carrierFilter, setCarrierFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<ShipmentSourceType | 'all'>('all');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');

  // ------ Resolve effective date range ------
  // NOTE: All useMemo / useState calls must be declared above any early
  // return to honor the Rules of Hooks. Plan/permission gating renders are
  // performed AFTER all hooks have been registered.
  const effectiveRange = useMemo(() => {
    if (datePreset === 'custom') {
      if (!customFrom || !customTo) return null;
      return { from: customFrom, to: customTo };
    }
    return presetRange(datePreset);
  }, [datePreset, customFrom, customTo]);

  // ------ Discover available filter options from data (truthful, never invented) ------
  const allCarriers = useMemo(() => {
    const set = new Set<string>();
    shipments.forEach(s => set.add((s.carrier || '').trim() || 'Unknown'));
    return Array.from(set).sort();
  }, [shipments]);
  const allProviders = useMemo(() => {
    const set = new Set<string>();
    shipments.forEach(s => set.add(resolveProviderLabel(s)));
    return Array.from(set).sort();
  }, [shipments]);

  // ------ Apply filters ------
  const filtered = useMemo(() => {
    const fromMs = effectiveRange ? Date.parse(`${effectiveRange.from}T00:00:00.000Z`) : null;
    const toMs = effectiveRange ? Date.parse(`${effectiveRange.to}T23:59:59.999Z`) : null;
    return shipments.filter(s => {
      const created = parseTs(s.createdAt);
      if (fromMs != null && (created == null || created < fromMs)) return false;
      if (toMs != null && (created == null || created > toMs)) return false;
      if (modeFilter !== 'all' && s.shipmentMode !== modeFilter) return false;
      if (providerFilter !== 'all' && resolveProviderLabel(s) !== providerFilter) return false;
      const carrierLabel = (s.carrier || '').trim() || 'Unknown';
      if (carrierFilter !== 'all' && carrierLabel !== carrierFilter) return false;
      if (sourceFilter !== 'all' && s.sourceType !== sourceFilter) return false;
      const isReturn = !!s.returnInfo?.isReturn;
      if (directionFilter === 'return' && !isReturn) return false;
      if (directionFilter === 'outbound' && isReturn) return false;
      return true;
    });
  }, [shipments, effectiveRange, modeFilter, providerFilter, carrierFilter, sourceFilter, directionFilter]);

  // ------ Metric derivation ------
  const m = useMemo(() => {
    const out = {
      shipmentCount: filtered.length,
      providerShipmentCount: 0,
      manualShipmentCount: 0,
      labelPurchasedCount: 0,
      pickupRequestedCount: 0,
      pickupConfirmedCount: 0,
      pickupLocalOnlyCount: 0,
      pickupCancelledCount: 0,
      pickupFailedCount: 0,
      deliveredCount: 0,
      inTransitCount: 0,
      exceptionCount: 0,
      cancelledShipmentCount: 0,
      shipmentsWithCost: 0,
      shipmentsWithCarrier: 0,
      shipmentsWithService: 0,
      shipmentsWithDispatch: 0,
      shipmentsWithDelivered: 0,
      shippingSpend: 0,
      labelToDeliveredSamples: [] as number[],
      dispatchedToDeliveredSamples: [] as number[],
      carrierDist: new Map<string, number>(),
      serviceDist: new Map<string, number>(),
      pickupBreakdown: new Map<PickupRequestStatus, number>(),
    };
    for (const s of filtered) {
      if (s.shipmentMode === 'provider') out.providerShipmentCount++;
      else if (s.shipmentMode === 'manual') out.manualShipmentCount++;
      const labelTs = deriveLabelCreatedAt(s);
      if (labelTs != null) out.labelPurchasedCount++;
      const pr = s.pickupRequest;
      if (pr) {
        out.pickupRequestedCount++;
        const isLive = pr.source === 'live_provider';
        if ((pr.status === 'confirmed' || pr.status === 'completed') && isLive) out.pickupConfirmedCount++;
        if (!isLive) out.pickupLocalOnlyCount++;
        if (pr.status === 'cancelled') out.pickupCancelledCount++;
        if (pr.status === 'failed' || pr.status === 'rejected' || pr.status === 'partial_failed') out.pickupFailedCount++;
        out.pickupBreakdown.set(pr.status, (out.pickupBreakdown.get(pr.status) || 0) + 1);
      }
      const deliveredTs = deriveDeliveredAt(s);
      const dispatchedTs = deriveDispatchedAt(s);
      if (deliveredTs != null) { out.deliveredCount++; out.shipmentsWithDelivered++; }
      if (dispatchedTs != null) out.shipmentsWithDispatch++;
      if (s.status === 'Dispatched' || s.status === 'In Transit') out.inTransitCount++;
      if (s.status === 'Exception') out.exceptionCount++;
      if (s.status === 'Cancelled') out.cancelledShipmentCount++;
      if (typeof s.shippingCost === 'number') {
        out.shipmentsWithCost++;
        out.shippingSpend += s.shippingCost;
      }
      const carrierLabel = (s.carrier || '').trim();
      if (carrierLabel) out.shipmentsWithCarrier++;
      out.carrierDist.set(carrierLabel || 'Unknown', (out.carrierDist.get(carrierLabel || 'Unknown') || 0) + 1);
      const serviceLabel = (s.serviceLevel || '').trim();
      if (serviceLabel) out.shipmentsWithService++;
      out.serviceDist.set(serviceLabel || 'Unknown', (out.serviceDist.get(serviceLabel || 'Unknown') || 0) + 1);
      if (labelTs != null && deliveredTs != null && deliveredTs > labelTs) out.labelToDeliveredSamples.push(deliveredTs - labelTs);
      if (dispatchedTs != null && deliveredTs != null && deliveredTs > dispatchedTs) out.dispatchedToDeliveredSamples.push(deliveredTs - dispatchedTs);
    }
    return out;
  }, [filtered]);

  const avgLabelToDelivered = m.labelToDeliveredSamples.length >= 3
    ? m.labelToDeliveredSamples.reduce((a, b) => a + b, 0) / m.labelToDeliveredSamples.length
    : null;
  const avgDispatchedToDelivered = m.dispatchedToDeliveredSamples.length >= 3
    ? m.dispatchedToDeliveredSamples.reduce((a, b) => a + b, 0) / m.dispatchedToDeliveredSamples.length
    : null;
  const avgShippingCost = m.shipmentsWithCost > 0 ? m.shippingSpend / m.shipmentsWithCost : null;

  // ------ Plan / permission gates (AFTER all hooks have run) ------
  if (!hasViewPermission) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
        <span className="material-symbols-outlined text-slate-300 text-4xl">lock</span>
        <p className="text-sm font-black text-slate-700 mt-2">Carrier Analytics is not enabled for your role</p>
        <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Ask a store administrator to grant the <span className="font-mono">View Carrier Analytics</span> sub-permission under Shipping. Cost-related metrics additionally require <span className="font-mono">View Shipping Costs</span>.</p>
      </div>
    );
  }
  if (!planAllowsCarrierAnalytics) {
    return (
      <div className="bg-white rounded-2xl border border-amber-200 p-8 text-center">
        <span className="material-symbols-outlined text-amber-500 text-4xl">workspace_premium</span>
        <p className="text-sm font-black text-slate-700 mt-2">Carrier Analytics is not included in your current plan</p>
        <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">Carrier Analytics is available on Growth and Advanced plans. Contact your account owner to upgrade.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header + truthful scope chip */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5"><span className="material-symbols-outlined text-sm">analytics</span>Carrier Analytics</p>
            <h2 className="text-lg font-black text-slate-800 mt-0.5">Operational shipping intelligence</h2>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">All metrics are derived deterministically from your real shipment, pickup, and event records. Where the data is incomplete, the metric is shown as an honest unknown / insufficient-data state — never extrapolated. Carrier scorecards, lane analytics, customs-docs analytics, and insurance-rule analytics are <span className="font-bold">deferred for future improvement</span> and are not included in this foundation pass.</p>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[9px] font-mono font-black text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">analytics: foundation</span>
            <span className="text-[9px] font-mono font-black text-slate-600 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">scope: shipments + pickups + events</span>
            {!canViewCosts && <span className="text-[9px] font-mono font-black text-amber-700 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded">cost-metrics: hidden (no permission)</span>}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Filters</p>
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Date range</label>
            <select value={datePreset} onChange={e => setDatePreset(e.target.value as DateRangePreset)} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs">
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="all">All time</option>
              <option value="custom">Custom…</option>
            </select>
          </div>
          {datePreset === 'custom' && (
            <>
              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">From</label>
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">To</label>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
              </div>
            </>
          )}
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Mode</label>
            <select value={modeFilter} onChange={e => setModeFilter(e.target.value as ModeFilter)} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs">
              <option value="all">All modes</option>
              <option value="provider">Provider only</option>
              <option value="manual">Manual only</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Provider</label>
            <select value={providerFilter} onChange={e => setProviderFilter(e.target.value)} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs">
              <option value="all">All providers</option>
              {allProviders.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Carrier</label>
            <select value={carrierFilter} onChange={e => setCarrierFilter(e.target.value)} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs">
              <option value="all">All carriers</option>
              {allCarriers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Source</label>
            <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value as ShipmentSourceType | 'all')} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs">
              <option value="all">All sources</option>
              <option value="invoice">Invoice</option>
              <option value="repair">Repair</option>
              <option value="transfer">Transfer</option>
              <option value="rma">RMA</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Direction</label>
            <select value={directionFilter} onChange={e => setDirectionFilter(e.target.value as DirectionFilter)} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs">
              <option value="all">All directions</option>
              <option value="outbound">Outbound only</option>
              <option value="return">Returns only</option>
            </select>
          </div>
        </div>
        <div className="mt-3 text-[10px] text-slate-500 flex items-center gap-2 flex-wrap">
          <span className="font-mono font-black text-slate-600 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">cohort: {filtered.length} of {shipments.length} shipments</span>
          {effectiveRange && <span className="font-mono text-slate-500">window: {effectiveRange.from} → {effectiveRange.to}</span>}
          {!effectiveRange && datePreset === 'custom' && <span className="text-amber-700 font-bold">Pick a custom from/to to apply the date filter.</span>}
          {!effectiveRange && datePreset === 'all' && <span className="text-slate-500 italic">Date filter disabled (all time).</span>}
        </div>
      </div>

      {/* Empty cohort state */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <span className="material-symbols-outlined text-slate-300 text-5xl">inbox</span>
          <p className="text-sm font-black text-slate-600 mt-2">No shipments match the current filters</p>
          <p className="text-xs text-slate-500 mt-1">Widen the date range or relax filter criteria. We do not estimate metrics from an empty cohort.</p>
        </div>
      ) : (
        <>
          {/* Core counts */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Shipment volume</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard tone="primary" label="Shipments" value={String(m.shipmentCount)} sub={`${m.providerShipmentCount} provider · ${m.manualShipmentCount} manual`} />
              <MetricCard label="Labels purchased" value={String(m.labelPurchasedCount)} sub={`${fmtPct(m.labelPurchasedCount, m.shipmentCount)} of cohort`} help="Counts shipments with a 'Label Created' event row." />
              <MetricCard tone="emerald" label="Delivered" value={String(m.deliveredCount)} sub={`${fmtPct(m.deliveredCount, m.shipmentCount)} of cohort`} />
              <MetricCard tone="sky" label="In transit" value={String(m.inTransitCount)} sub="Dispatched + In Transit" />
              <MetricCard tone="amber" label="Exceptions" value={String(m.exceptionCount)} sub={`${fmtPct(m.exceptionCount, m.shipmentCount)} of cohort`} />
              <MetricCard tone="rose" label="Cancelled" value={String(m.cancelledShipmentCount)} sub={`${fmtPct(m.cancelledShipmentCount, m.shipmentCount)} of cohort`} />
              {canViewCosts ? (
                <>
                  <MetricCard label="Shipping spend" value={`$${m.shippingSpend.toFixed(2)}`} sub={`${m.shipmentsWithCost}/${m.shipmentCount} have cost data`} help={m.shipmentsWithCost === 0 ? 'No cost data available in this cohort.' : undefined} />
                  <MetricCard label="Avg shipping cost" value={avgShippingCost != null ? `$${avgShippingCost.toFixed(2)}` : '—'} sub={`over ${m.shipmentsWithCost} sample(s)`} help={m.shipmentsWithCost < 3 ? 'Average shown as-is — sample size below 3 may not be representative.' : undefined} />
                </>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 col-span-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Cost metrics</p>
                  <p className="text-xs text-slate-500 mt-1">Hidden — your role does not have <span className="font-mono">View Shipping Costs</span>.</p>
                </div>
              )}
            </div>
          </div>

          {/* Pickup analytics */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Pickup analytics</p>
              <span className="text-[9px] font-mono font-black text-slate-600 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">live-provider vs local-only kept distinct</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <MetricCard tone="primary" label="Pickup requested" value={String(m.pickupRequestedCount)} sub={`${fmtPct(m.pickupRequestedCount, m.shipmentCount)} of cohort`} />
              <MetricCard tone="emerald" label="Provider-confirmed" value={String(m.pickupConfirmedCount)} sub="status confirmed/completed AND source=live_provider" />
              <MetricCard tone="amber" label="Local-only" value={String(m.pickupLocalOnlyCount)} sub="No live provider confirmation" help="These pickups are operational records only — the carrier has not confirmed them." />
              <MetricCard tone="slate" label="Cancelled" value={String(m.pickupCancelledCount)} sub="includes locally-resolved orphans" />
              <MetricCard tone="rose" label="Failed / rejected / partial" value={String(m.pickupFailedCount)} sub="failed + rejected + partial_failed" />
            </div>
            {m.pickupBreakdown.size > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Array.from(m.pickupBreakdown.entries()).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
                  <span key={status} className="text-[10px] font-mono font-black text-slate-600 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">{status}: <span className="tabular-nums">{count}</span></span>
                ))}
              </div>
            )}
          </div>

          {/* Lifecycle timing */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Lifecycle timing</p>
              <span className="text-[9px] font-mono font-black text-slate-600 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">requires ≥3 paired timestamps</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Avg label → delivered</p>
                {avgLabelToDelivered != null ? (
                  <>
                    <p className="text-2xl font-black text-slate-800 mt-1 tabular-nums">{fmtMs(avgLabelToDelivered)}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">over {m.labelToDeliveredSamples.length} sample(s)</p>
                  </>
                ) : (
                  <div className="mt-2"><InsufficientBadge samples={m.labelToDeliveredSamples.length} /></div>
                )}
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Avg dispatched → delivered</p>
                {avgDispatchedToDelivered != null ? (
                  <>
                    <p className="text-2xl font-black text-slate-800 mt-1 tabular-nums">{fmtMs(avgDispatchedToDelivered)}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">over {m.dispatchedToDeliveredSamples.length} sample(s)</p>
                  </>
                ) : (
                  <div className="mt-2"><InsufficientBadge samples={m.dispatchedToDeliveredSamples.length} /></div>
                )}
              </div>
            </div>
            <p className="text-[10px] text-slate-400 mt-2 italic">We never infer missing timestamps. Provider event coverage is partial today — these averages reflect only shipments with both endpoints recorded.</p>
          </div>

          {/* Distributions */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DistributionCard title="Carrier distribution" entries={m.carrierDist} total={m.shipmentCount} />
            <DistributionCard title="Service-level distribution" entries={m.serviceDist} total={m.shipmentCount} />
          </div>

          {/* Coverage / data-quality */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Data-quality coverage</p>
            <p className="text-xs text-slate-500 mb-3">How much of this cohort actually has each underlying signal. Low coverage = the related metric should be read with care.</p>
            <div className="flex flex-wrap gap-1.5">
              <CoverageChip label="carrier" num={m.shipmentsWithCarrier} den={m.shipmentCount} tone={coverageTone(m.shipmentsWithCarrier, m.shipmentCount)} />
              <CoverageChip label="service-level" num={m.shipmentsWithService} den={m.shipmentCount} tone={coverageTone(m.shipmentsWithService, m.shipmentCount)} />
              <CoverageChip label="dispatch-ts" num={m.shipmentsWithDispatch} den={m.shipmentCount} tone={coverageTone(m.shipmentsWithDispatch, m.shipmentCount)} />
              <CoverageChip label="delivered-ts" num={m.shipmentsWithDelivered} den={m.shipmentCount} tone={coverageTone(m.shipmentsWithDelivered, m.shipmentCount)} />
              {canViewCosts && <CoverageChip label="cost" num={m.shipmentsWithCost} den={m.shipmentCount} tone={coverageTone(m.shipmentsWithCost, m.shipmentCount)} />}
            </div>
            <p className="text-[10px] text-slate-400 mt-3 italic">Coverage chips are computed deterministically from real fields (no provider event polling here). When provider event coverage improves, lifecycle timing samples will grow automatically and the insufficient-data badges will disappear.</p>
          </div>
        </>
      )}
    </div>
  );
}

function DistributionCard({ title, entries, total }: { title: string; entries: Map<string, number>; total: number }) {
  const sorted = Array.from(entries.entries()).sort((a, b) => b[1] - a[1]);
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">{title}</p>
      {sorted.length === 0 ? (
        <p className="text-xs text-slate-500 italic">No data.</p>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map(([label, count]) => {
            const pct = total > 0 ? (count / total) * 100 : 0;
            const isUnknown = label === 'Unknown';
            return (
              <li key={label} className="text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-black ${isUnknown ? 'text-amber-700' : 'text-slate-700'}`}>{label}{isUnknown && <span className="ml-1 text-[9px] font-mono font-normal text-amber-600">(missing data)</span>}</span>
                  <span className="font-mono tabular-nums text-slate-600">{count} · {pct.toFixed(pct >= 10 ? 0 : 1)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full ${isUnknown ? 'bg-amber-300' : 'bg-primary/60'}`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
