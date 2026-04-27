// Phase 3 — Carrier Scorecards Foundation
//
// A truthful, deterministic, data-quality-aware carrier/service performance
// derivation layer. Pure functions only — no React, no I/O, no invented
// data. Every metric is derived from already-recorded shipment / pickup /
// event / SLA data. When data is missing we surface an explicit
// "insufficient data" state instead of fabricating zero or extrapolating.
//
// This is a foundation pass:
//   - We expose per-carrier-and-service scorecards (the basic comparison
//     unit operators reason about). Operators can group higher-level by
//     filtering, but the canonical unit is (provider, carrier, serviceLevel).
//   - We do NOT compute a single combined numeric grade. We surface the
//     metric scorecards transparently and let the operator compare. A
//     combined score would require defensible weights and a stable
//     coverage model that we are not building in this foundation.
//   - Sample-size awareness: a carrier+service group with fewer than
//     MIN_SAMPLE_SIZE filtered shipments is flagged "limited data" so a
//     single sample does not look like a confident performance signal.
//   - Manual vs provider-backed coverage is kept distinct: pickup
//     "confirmed" is split into provider-confirmed vs local-only;
//     transit timings are only shown when both endpoint timestamps exist;
//     SLA stats reuse the canonical engine (`summarizeShipmentSla`)
//     instead of re-implementing SLA logic.
//
// Out of scope (intentionally — see replit.md):
//   - AI carrier optimization / predictive ranking / refunds-claims
//   - Automatic carrier switching
//   - External carrier benchmarking
//   - Customs / Insurance scoring
//   - Editable scorecard settings (definitions are fixed in this pass)

import type {
  Shipment,
  ShipmentSourceType,
  SlaPolicy,
  SlaTargetType,
} from '../types';
import { summarizeShipmentSla } from '../utils/sla';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

// Minimum number of in-cohort shipments required before a per-carrier
// scorecard is considered to have a defensible sample. Below this we still
// render the card (operators want to see the row exists) but every
// derived rate is annotated with a "limited data" caveat so a 1-of-2 SLA
// miss does not look like a 50% miss rate.
export const MIN_SAMPLE_SIZE = 5;

// Minimum number of valid endpoint pairs required before transit
// averages render as a number. Mirrors the existing rule in
// CarrierAnalytics.tsx so the two surfaces stay consistent.
export const MIN_TIMING_SAMPLES = 3;

// ---------------------------------------------------------------------------
// Filters & grouping
// ---------------------------------------------------------------------------

export type ScorecardDateRangePreset = '7d' | '30d' | '90d' | 'all';
export type ScorecardModeFilter = 'all' | 'provider' | 'manual';
export type ScorecardDirectionFilter = 'all' | 'outbound' | 'return';

export interface ScorecardFilters {
  range: ScorecardDateRangePreset;
  mode: ScorecardModeFilter;
  direction: ScorecardDirectionFilter;
  carrier: string | 'all';
  provider: string | 'all';
  serviceLevel: string | 'all';
  sourceType: ShipmentSourceType | 'all';
}

export const DEFAULT_SCORECARD_FILTERS: ScorecardFilters = {
  range: '30d',
  mode: 'all',
  direction: 'all',
  carrier: 'all',
  provider: 'all',
  serviceLevel: 'all',
  sourceType: 'all',
};

// ---------------------------------------------------------------------------
// Per-shipment derivation helpers (kept consistent with CarrierAnalytics)
// ---------------------------------------------------------------------------

export type ShipmentMode = 'provider' | 'manual';

export function deriveMode(s: Shipment): ShipmentMode {
  if ((s as any).selectedRate) return 'provider';
  if (s.carrier && s.serviceLevel) return 'manual';
  return 'provider';
}

export function resolveProviderLabel(s: Shipment): string {
  if (deriveMode(s) !== 'provider') return 'manual';
  const id = s.providerShipmentId || '';
  if (id.startsWith('shp_')) return 'easypost';
  if (id.startsWith('shippo_') || (id.startsWith('adr_') && id.length > 8)) return 'shippo';
  if (/^[0-9]{6,}$/.test(id)) return 'shipstation';
  return 'provider';
}

function parseTs(s?: string | null): number | null {
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

export function deriveLabelCreatedAt(s: Shipment): number | null { return eventTs(s, 'Label Created'); }
export function deriveDispatchedAt(s: Shipment): number | null {
  return parseTs(s.dispatchedAt) ?? eventTs(s, 'Dispatched');
}
export function deriveDeliveredAt(s: Shipment): number | null {
  return parseTs(s.deliveredAt) ?? eventTs(s, 'Delivered');
}

function isReturnShipment(s: Shipment): boolean {
  return (s as any).returnInfo?.isReturn === true;
}

function shippingCostOf(s: Shipment): number | null {
  const c: any = (s as any).shippingCost;
  if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c;
  // Fall back to the selected rate's cost when available — the operator
  // already accepted that price, so it is a defensible per-shipment cost.
  const rateCost: any = (s as any).selectedRate?.rate;
  if (typeof rateCost === 'number' && Number.isFinite(rateCost) && rateCost >= 0) return rateCost;
  return null;
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function presetRange(preset: ScorecardDateRangePreset, nowMs: number): { fromMs: number; toMs: number } | null {
  if (preset === 'all') return null;
  const now = new Date(nowMs);
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const fromDate = new Date(now.getTime() - (days - 1) * 86400000);
  // Inclusive UTC day boundaries to mirror CarrierAnalytics.
  const fromMs = Date.parse(`${ymd(fromDate)}T00:00:00Z`);
  const toMs = Date.parse(`${ymd(now)}T23:59:59Z`);
  return { fromMs, toMs };
}

function passesFilters(s: Shipment, filters: ScorecardFilters, range: { fromMs: number; toMs: number } | null): boolean {
  if (range) {
    const created = parseTs(s.createdAt as any);
    if (created == null) return false;
    if (created < range.fromMs || created > range.toMs) return false;
  }
  if (filters.mode !== 'all' && deriveMode(s) !== filters.mode) return false;
  if (filters.direction === 'outbound' && isReturnShipment(s)) return false;
  if (filters.direction === 'return' && !isReturnShipment(s)) return false;
  if (filters.carrier !== 'all' && (s.carrier || 'Unknown') !== filters.carrier) return false;
  if (filters.serviceLevel !== 'all' && (s.serviceLevel || 'Unknown') !== filters.serviceLevel) return false;
  if (filters.provider !== 'all' && resolveProviderLabel(s) !== filters.provider) return false;
  if (filters.sourceType !== 'all' && s.sourceType !== filters.sourceType) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Scorecard shape
// ---------------------------------------------------------------------------

export interface ScorecardCoverage {
  // The denominator behind every per-card derived rate is the shipment
  // count after filters. Sample size below MIN_SAMPLE_SIZE flips
  // limitedSample = true.
  shipmentCount: number;
  limitedSample: boolean;
  // Costs — coverage is the share of shipments whose cost we can
  // truthfully read from the record (shippingCost or selectedRate.rate).
  costCoveragePct: number; // 0..100
  costCovered: number;
  costMissing: number;
  // Provider event coverage — share of shipments whose mode resolves to
  // 'provider'. Manual shipments are not provider-event-rich, so a low
  // ratio means downstream timing/pickup metrics are partial.
  providerCoveragePct: number;
  // Delivered timestamp coverage — share of shipments with a derivable
  // delivered timestamp. Below this threshold transit averages render
  // as "insufficient data".
  deliveryCoveragePct: number;
  deliveredCount: number;
  // SLA coverage — share of shipments where the SLA engine returns
  // applicable=true. SLA rates only render when this ratio is real.
  slaCoveragePct: number;
  slaApplicableCount: number;
  // Pickup coverage — provider-confirmed vs local-only split. Local-only
  // intents are NEVER counted as provider-confirmed.
  pickupRequestedCount: number;
  pickupProviderConfirmedCount: number;
  pickupLocalOnlyCount: number;
}

export interface ScorecardUsageMetrics {
  totalShipments: number;
  providerShipments: number;
  manualShipments: number;
  outboundShipments: number;
  returnShipments: number;
  labelPurchasedCount: number;
  deliveredCount: number;
  cancelledCount: number;
}

export interface ScorecardCostMetrics {
  totalSpend: number; // sum across shipments with a defensible cost
  averageCost: number | null; // null when no covered samples
  minCost: number | null;
  maxCost: number | null;
  costedShipments: number;
}

export interface ScorecardSlaMetrics {
  // applicable = SLA engine had targets (i.e. lifecycle data exists).
  applicableShipments: number;
  // Per-shipment worst-status counts derived from `summarizeShipmentSla`.
  shipmentsWithMissed: number;
  shipmentsWithOverdue: number;
  shipmentsWithAtRisk: number;
  shipmentsPaused: number;
  shipmentsAllMet: number; // applicable, no at_risk/overdue/missed/paused
  shipmentsUnknown: number; // applicable but engine reports unknown for at least one target
  // Per-target counts (sum across applicable shipments) — useful when an
  // operator wants to see "this carrier missed dispatch targets the most".
  perTargetMissed: Record<SlaTargetType, number>;
  perTargetMet: Record<SlaTargetType, number>;
}

export interface ScorecardTransitMetrics {
  // null when sample size below MIN_TIMING_SAMPLES
  avgLabelToDispatchMs: number | null;
  avgDispatchToDeliveryMs: number | null;
  avgLabelToDeliveryMs: number | null;
  // sample sizes for the three averages — exposed so the UI can show
  // "based on N samples" next to each number
  labelToDispatchSamples: number;
  dispatchToDeliverySamples: number;
  labelToDeliverySamples: number;
  // status snapshot
  inTransitCount: number;
  dispatchedCount: number; // distinct from in-transit per Phase 2 invariant
  exceptionCount: number;
}

export interface ScorecardPickupMetrics {
  requested: number;
  providerConfirmed: number;
  localOnly: number;
  cancelled: number;
  failed: number;
}

export interface ScorecardExceptionMetrics {
  shipmentExceptionCount: number; // status === 'Exception'
  cancelledCount: number; // status === 'Cancelled'
  unresolvedSlaExceptionCount: number; // missed/overdue at evaluation time
}

export interface CarrierScorecard {
  // Stable group key — used as React list key + the canonical comparison id.
  key: string;
  carrierLabel: string;
  serviceLabel: string;
  providerLabel: string;
  coverage: ScorecardCoverage;
  usage: ScorecardUsageMetrics;
  cost: ScorecardCostMetrics;
  sla: ScorecardSlaMetrics;
  transit: ScorecardTransitMetrics;
  pickup: ScorecardPickupMetrics;
  exception: ScorecardExceptionMetrics;
}

export interface ScorecardComputationResult {
  // Carrier+service+provider scorecards, sorted descending by total
  // shipment count so the most-used groups surface first.
  scorecards: CarrierScorecard[];
  // Cohort-wide totals — handy for the surface header (filter narrowed
  // to N shipments across M carriers) and for the "no data" empty state.
  cohortShipmentCount: number;
  cohortCarrierCount: number;
  cohortServiceCount: number;
  // Distinct values in the filtered cohort so the filter dropdowns can
  // be populated without re-iterating shipments in the component.
  availableCarriers: string[];
  availableServiceLevels: string[];
  availableProviders: string[];
  availableSourceTypes: ShipmentSourceType[];
  // Sample threshold used so the surface can say "Limited data (< N)".
  minSampleSize: number;
}

// ---------------------------------------------------------------------------
// Empty metric factories — keep zero-state truthful & easy to fold into
// ---------------------------------------------------------------------------

const TARGET_TYPES: SlaTargetType[] = [
  'pack_by',
  'label_by',
  'dispatch_by',
  'deliver_by',
  'return_receive_by',
];

function emptyTargetCounts(): Record<SlaTargetType, number> {
  const o = {} as Record<SlaTargetType, number>;
  for (const t of TARGET_TYPES) o[t] = 0;
  return o;
}

// ---------------------------------------------------------------------------
// Per-shipment fold into a scorecard accumulator
// ---------------------------------------------------------------------------

interface Accumulator {
  carrierLabel: string;
  serviceLabel: string;
  providerLabel: string;
  shipments: Shipment[]; // raw shipments — small per-group; we keep them so
                          // we can compute coverage/timing in one pass.
}

function accumulatorKey(carrier: string, service: string, provider: string): string {
  return `${provider}|${carrier}|${service}`;
}

function buildScorecard(
  acc: Accumulator,
  slaPolicy: SlaPolicy | undefined,
  nowMs: number,
): CarrierScorecard {
  const { shipments, carrierLabel, serviceLabel, providerLabel } = acc;
  const total = shipments.length;

  // ---- Usage ----------------------------------------------------------
  let providerCount = 0;
  let manualCount = 0;
  let outboundCount = 0;
  let returnCount = 0;
  let labelPurchasedCount = 0;
  let deliveredCount = 0;
  let cancelledCount = 0;

  // ---- Cost -----------------------------------------------------------
  let costedCount = 0;
  let totalSpend = 0;
  let minCost: number | null = null;
  let maxCost: number | null = null;

  // ---- Transit --------------------------------------------------------
  let labelToDispatchSum = 0, labelToDispatchN = 0;
  let dispatchToDeliverySum = 0, dispatchToDeliveryN = 0;
  let labelToDeliverySum = 0, labelToDeliveryN = 0;
  let inTransitCount = 0;
  let dispatchedCount = 0;
  let exceptionCount = 0;

  // ---- Pickup ---------------------------------------------------------
  let pickupRequested = 0, pickupProviderConfirmed = 0, pickupLocalOnly = 0,
      pickupCancelled = 0, pickupFailed = 0;

  // ---- SLA ------------------------------------------------------------
  let slaApplicable = 0;
  let withMissed = 0, withOverdue = 0, withAtRisk = 0, paused = 0,
      allMet = 0, withUnknown = 0;
  let unresolvedSlaExceptions = 0;
  const perTargetMissed = emptyTargetCounts();
  const perTargetMet = emptyTargetCounts();

  for (const s of shipments) {
    // Usage
    const mode = deriveMode(s);
    if (mode === 'provider') providerCount++; else manualCount++;
    if (isReturnShipment(s)) returnCount++; else outboundCount++;
    if (eventTs(s, 'Label Created') != null) labelPurchasedCount++;
    if (s.status === 'Cancelled') { cancelledCount++; }

    // Cost
    const cost = shippingCostOf(s);
    if (cost != null) {
      costedCount++;
      totalSpend += cost;
      minCost = minCost == null ? cost : Math.min(minCost, cost);
      maxCost = maxCost == null ? cost : Math.max(maxCost, cost);
    }

    // Transit
    const labelAt = deriveLabelCreatedAt(s);
    const dispatchAt = deriveDispatchedAt(s);
    const deliveredAt = deriveDeliveredAt(s);
    if (deliveredAt != null) deliveredCount++;
    if (s.status === 'Dispatched') dispatchedCount++;
    if (s.status === 'In Transit') inTransitCount++;
    if (s.status === 'Exception') exceptionCount++;
    if (labelAt != null && dispatchAt != null && dispatchAt >= labelAt) {
      labelToDispatchSum += dispatchAt - labelAt;
      labelToDispatchN++;
    }
    if (dispatchAt != null && deliveredAt != null && deliveredAt >= dispatchAt) {
      dispatchToDeliverySum += deliveredAt - dispatchAt;
      dispatchToDeliveryN++;
    }
    if (labelAt != null && deliveredAt != null && deliveredAt >= labelAt) {
      labelToDeliverySum += deliveredAt - labelAt;
      labelToDeliveryN++;
    }

    // Pickup — preserve provider-state truthfulness. A pickupRequest with
    // source !== 'live_provider' is a local-only intent and must NEVER
    // be counted as provider-confirmed.
    const pr: any = (s as any).pickupRequest;
    if (pr) {
      pickupRequested++;
      const status = pr.status;
      const source = pr.source;
      if ((status === 'confirmed' || status === 'completed') && source === 'live_provider') {
        pickupProviderConfirmed++;
      } else if (source !== 'live_provider') {
        pickupLocalOnly++;
      }
      if (status === 'cancelled') pickupCancelled++;
      if (status === 'failed' || status === 'rejected' || status === 'partial_failed') pickupFailed++;
    }

    // SLA — reuse the canonical engine. If no policy is supplied we
    // skip SLA aggregation entirely and let the surface render an
    // explicit "SLA Optimization not available" caveat.
    if (slaPolicy) {
      const summary = summarizeShipmentSla(s, slaPolicy, nowMs);
      if (summary.applicable) {
        slaApplicable++;
        if (summary.missedCount > 0) { withMissed++; unresolvedSlaExceptions++; }
        else if (summary.overdueCount > 0) { withOverdue++; unresolvedSlaExceptions++; }
        else if (summary.atRiskCount > 0) { withAtRisk++; }
        else if (summary.paused) { paused++; }
        else if (summary.unknownCount > 0) { withUnknown++; }
        else { allMet++; }
        for (const t of summary.targets) {
          if (t.status === 'missed') perTargetMissed[t.type]++;
          if (t.status === 'met') perTargetMet[t.type]++;
        }
      }
    }
  }

  const limitedSample = total < MIN_SAMPLE_SIZE;
  const costCoveragePct = total > 0 ? Math.round((costedCount / total) * 100) : 0;
  const providerCoveragePct = total > 0 ? Math.round((providerCount / total) * 100) : 0;
  const deliveryCoveragePct = total > 0 ? Math.round((deliveredCount / total) * 100) : 0;
  const slaCoveragePct = total > 0 ? Math.round((slaApplicable / total) * 100) : 0;

  return {
    key: accumulatorKey(carrierLabel, serviceLabel, providerLabel),
    carrierLabel,
    serviceLabel,
    providerLabel,
    coverage: {
      shipmentCount: total,
      limitedSample,
      costCoveragePct,
      costCovered: costedCount,
      costMissing: total - costedCount,
      providerCoveragePct,
      deliveryCoveragePct,
      deliveredCount,
      slaCoveragePct,
      slaApplicableCount: slaApplicable,
      pickupRequestedCount: pickupRequested,
      pickupProviderConfirmedCount: pickupProviderConfirmed,
      pickupLocalOnlyCount: pickupLocalOnly,
    },
    usage: {
      totalShipments: total,
      providerShipments: providerCount,
      manualShipments: manualCount,
      outboundShipments: outboundCount,
      returnShipments: returnCount,
      labelPurchasedCount,
      deliveredCount,
      cancelledCount,
    },
    cost: {
      totalSpend,
      averageCost: costedCount > 0 ? totalSpend / costedCount : null,
      minCost,
      maxCost,
      costedShipments: costedCount,
    },
    sla: {
      applicableShipments: slaApplicable,
      shipmentsWithMissed: withMissed,
      shipmentsWithOverdue: withOverdue,
      shipmentsWithAtRisk: withAtRisk,
      shipmentsPaused: paused,
      shipmentsAllMet: allMet,
      shipmentsUnknown: withUnknown,
      perTargetMissed,
      perTargetMet,
    },
    transit: {
      avgLabelToDispatchMs: labelToDispatchN >= MIN_TIMING_SAMPLES ? labelToDispatchSum / labelToDispatchN : null,
      avgDispatchToDeliveryMs: dispatchToDeliveryN >= MIN_TIMING_SAMPLES ? dispatchToDeliverySum / dispatchToDeliveryN : null,
      avgLabelToDeliveryMs: labelToDeliveryN >= MIN_TIMING_SAMPLES ? labelToDeliverySum / labelToDeliveryN : null,
      labelToDispatchSamples: labelToDispatchN,
      dispatchToDeliverySamples: dispatchToDeliveryN,
      labelToDeliverySamples: labelToDeliveryN,
      inTransitCount,
      dispatchedCount,
      exceptionCount,
    },
    pickup: {
      requested: pickupRequested,
      providerConfirmed: pickupProviderConfirmed,
      localOnly: pickupLocalOnly,
      cancelled: pickupCancelled,
      failed: pickupFailed,
    },
    exception: {
      shipmentExceptionCount: exceptionCount,
      cancelledCount,
      unresolvedSlaExceptionCount: unresolvedSlaExceptions,
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function computeCarrierScorecards(
  shipments: Shipment[],
  filters: ScorecardFilters,
  slaPolicy: SlaPolicy | undefined,
  nowMs: number,
): ScorecardComputationResult {
  const range = presetRange(filters.range, nowMs);
  const filtered = shipments.filter(s => passesFilters(s, filters, range));

  // Group by (provider, carrier, serviceLevel). Unknown carrier/service
  // are kept as their own group so coverage gaps are visible.
  const groups = new Map<string, Accumulator>();
  for (const s of filtered) {
    const carrierLabel = s.carrier || 'Unknown';
    const serviceLabel = s.serviceLevel || 'Unknown';
    const providerLabel = resolveProviderLabel(s);
    const key = accumulatorKey(carrierLabel, serviceLabel, providerLabel);
    let acc = groups.get(key);
    if (!acc) {
      acc = { carrierLabel, serviceLabel, providerLabel, shipments: [] };
      groups.set(key, acc);
    }
    acc.shipments.push(s);
  }

  const scorecards = Array.from(groups.values())
    .map(acc => buildScorecard(acc, slaPolicy, nowMs))
    .sort((a, b) => b.usage.totalShipments - a.usage.totalShipments);

  // Distinct value lists from the FILTERED cohort drive the dropdown
  // populations. We intentionally compute these from the filtered set so
  // the operator sees only the values that exist in their current view —
  // matches the pattern used by CarrierAnalytics.
  const carriers = new Set<string>();
  const services = new Set<string>();
  const providers = new Set<string>();
  const sources = new Set<ShipmentSourceType>();
  for (const s of filtered) {
    carriers.add(s.carrier || 'Unknown');
    services.add(s.serviceLevel || 'Unknown');
    providers.add(resolveProviderLabel(s));
    if (s.sourceType) sources.add(s.sourceType);
  }

  return {
    scorecards,
    cohortShipmentCount: filtered.length,
    cohortCarrierCount: carriers.size,
    cohortServiceCount: services.size,
    availableCarriers: Array.from(carriers).sort(),
    availableServiceLevels: Array.from(services).sort(),
    availableProviders: Array.from(providers).sort(),
    availableSourceTypes: Array.from(sources).sort(),
    minSampleSize: MIN_SAMPLE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function formatDurationMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  if (h < 24) return h >= 10 ? `${Math.round(h)} hr` : `${h.toFixed(1)} hr`;
  const d = h / 24;
  return d >= 10 ? `${Math.round(d)} days` : `${d.toFixed(1)} days`;
}

export function formatCurrency(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export function targetLabel(t: SlaTargetType): string {
  switch (t) {
    case 'pack_by': return 'Pack';
    case 'label_by': return 'Label';
    case 'dispatch_by': return 'Dispatch';
    case 'deliver_by': return 'Delivery';
    case 'return_receive_by': return 'Return Receive';
  }
}
