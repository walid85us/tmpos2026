// Phase 3 Pass #15 — SLA Optimization Foundation
//
// Deterministic, side-effect-free SLA calculation surface for Shipping
// Center. Targets are derived purely from existing lifecycle timestamps
// (createdAt, packedAt, label.purchasedAt, dispatchedAt, deliveredAt) and
// the active SLA policy. Missing source timestamps produce 'unknown'
// states — never invented data, never fake calculations.
//
// Persistence layer: SLA policy is stored as JSON in sessionStorage under
// the `sla_policy` key, mirroring the `features_data` pattern used by
// plan-feature overrides. Per-shipment artifacts (delay reasons, pause
// state, resolution notes, audit history) live on the Shipment record
// itself — see types.ts SlaPauseInfo / SlaDelayReason / SlaResolutionNote
// / SlaHistoryEntry.

import type { Shipment, SlaPolicy, SlaStatus, SlaTarget, SlaTargetType } from '../types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const SLA_POLICY_STORAGE_KEY = 'sla_policy';

// Default SLA windows. Practical, conservative starting values — operators
// can tighten/loosen via the policy editor without code changes. Pack/label/
// dispatch are intra-day operations measured in hours; delivery and return-
// receive are multi-day measured in days.
export function getDefaultSlaPolicy(): SlaPolicy {
  return {
    windows: {
      pack_by: 4 * HOUR,
      label_by: 2 * HOUR,
      dispatch_by: 4 * HOUR,
      deliver_by: 5 * DAY,
      return_receive_by: 7 * DAY,
    },
    atRiskThresholdPct: 25,
  };
}

// Read the current SLA policy from sessionStorage with safe defaulting.
// Mirrors isPlanFeatureLiveFor's pattern in accessConfig.ts: any parse /
// shape error falls back to defaults so a corrupted storage entry never
// breaks the app.
export function loadSlaPolicy(): SlaPolicy {
  const defaults = getDefaultSlaPolicy();
  if (typeof window === 'undefined' || !window.sessionStorage) return defaults;
  try {
    const raw = window.sessionStorage.getItem(SLA_POLICY_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<SlaPolicy>;
    if (!parsed || typeof parsed !== 'object') return defaults;
    const windows = { ...defaults.windows, ...(parsed.windows || {}) };
    const atRiskThresholdPct = typeof parsed.atRiskThresholdPct === 'number'
      ? Math.max(1, Math.min(99, parsed.atRiskThresholdPct))
      : defaults.atRiskThresholdPct;
    return {
      windows,
      atRiskThresholdPct,
      updatedAt: parsed.updatedAt,
      updatedBy: parsed.updatedBy,
    };
  } catch {
    return defaults;
  }
}

export function saveSlaPolicy(policy: SlaPolicy): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(SLA_POLICY_STORAGE_KEY, JSON.stringify(policy));
    // Custom event so listeners (Shipping Center) can recompute summaries
    // without needing a page reload.
    window.dispatchEvent(new CustomEvent('sla-policy-changed'));
  } catch {
    // sessionStorage write failure is non-fatal — policy reverts to defaults
    // on next read. Surface to console for ops visibility.
    console.warn('[sla] saveSlaPolicy: sessionStorage write failed');
  }
}

// Tenant-level audit log for policy changes. Per-shipment SLA actions
// write to shipment.slaHistory; policy changes are tenant-wide and live in
// their own log so the matrix-edit story stays clean.
export interface SlaPolicyAuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  before: SlaPolicy;
  after: SlaPolicy;
}

const SLA_POLICY_AUDIT_STORAGE_KEY = 'sla_policy_audit_log';

export function appendPolicyAudit(entry: SlaPolicyAuditEntry): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    const raw = window.sessionStorage.getItem(SLA_POLICY_AUDIT_STORAGE_KEY);
    const log: SlaPolicyAuditEntry[] = raw ? JSON.parse(raw) : [];
    log.push(entry);
    // Keep last 100 entries to avoid unbounded growth.
    const trimmed = log.slice(-100);
    window.sessionStorage.setItem(SLA_POLICY_AUDIT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* non-fatal */
  }
}

export function loadPolicyAudit(): SlaPolicyAuditEntry[] {
  if (typeof window === 'undefined' || !window.sessionStorage) return [];
  try {
    const raw = window.sessionStorage.getItem(SLA_POLICY_AUDIT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SlaPolicyAuditEntry[]) : [];
  } catch {
    return [];
  }
}

// Canonical SLA-mode derivation. Intentionally does NOT consult the stored
// `shipment.shipmentMode` field, which is a UI/cached value that can drift
// out of sync with the operational state (e.g. a manual shipment that later
// has a provider rate selected but never has shipmentMode rewritten). We
// always derive from the canonical operational fields:
//   - if selectedRate exists → provider (a rate has been chosen, label
//     purchase is the next step)
//   - else if carrier && serviceLevel → manual (operator-entered, no
//     provider label step)
//   - else → provider (default: an in-flight outbound shipment that hasn't
//     yet selected a rate or set manual carrier/service is treated as
//     provider mode so label_by surfaces as 'unknown' rather than being
//     silently suppressed)
// Same precedence as the existing getShipmentMode helper in
// ShippingCenter.tsx — kept private to sla.ts so the SLA surface owns its
// own mode determination and cannot be regressed by changes elsewhere.
function deriveSlaShipmentMode(shipment: Shipment): 'provider' | 'manual' {
  if (shipment.selectedRate) return 'provider';
  if (shipment.carrier && shipment.serviceLevel) return 'manual';
  return 'provider';
}

// Map a target type to the (sourceTimestamp, actualTimestamp) pair on a
// shipment. Returns undefined for either side when the timestamp is
// missing — caller decides whether that means 'unknown' (in-flight) or
// 'not_applicable' (target doesn't apply to this shipment yet).
function getTargetTimestamps(
  shipment: Shipment,
  type: SlaTargetType,
): { source?: string; actual?: string } {
  switch (type) {
    case 'pack_by':
      // Source: shipment creation. Actual: packing completion.
      return { source: shipment.createdAt, actual: shipment.packedAt };
    case 'label_by':
      // Source: packing completion (packed shipments are eligible for label
      // purchase). Actual: label artifact purchase timestamp. Only applies
      // to provider-mode shipments — manual shipments skip the label step
      // (filtered out in getApplicableTargetTypes). Returning source without
      // actual when packing isn't done yields 'unknown' which is correct
      // (we can't measure label-by without a packed-at baseline).
      return { source: shipment.packedAt, actual: shipment.label?.purchasedAt };
    case 'dispatch_by': {
      // Source depends on mode and is strictly truthful: provider shipments
      // require a real label.purchasedAt before the dispatch SLA clock can
      // start (otherwise the dispatch deadline would silently fall back to
      // packedAt and surface as at_risk/overdue/missed prematurely). Manual
      // shipments skip the label step entirely so packing completion IS
      // the dispatch baseline. When the required source isn't present,
      // returning undefined yields 'unknown' downstream — never an
      // invented countdown.
      const mode = deriveSlaShipmentMode(shipment);
      if (mode === 'provider') {
        return { source: shipment.label?.purchasedAt, actual: shipment.dispatchedAt };
      }
      return { source: shipment.packedAt, actual: shipment.dispatchedAt };
    }
    case 'deliver_by':
      // Source: dispatch. Actual: delivery.
      return { source: shipment.dispatchedAt, actual: shipment.deliveredAt };
    case 'return_receive_by':
      // Source: dispatch (return shipments). Actual: delivery (return
      // arrived). Same shape as deliver_by but only applicable to return
      // shipments; the surface caller filters for shipment.returnInfo.
      return { source: shipment.dispatchedAt, actual: shipment.deliveredAt };
  }
}

// Which target types apply to a given shipment. Outbound shipments use
// pack_by / label_by / dispatch_by / deliver_by. Returns use return_receive_by
// instead of deliver_by. Manual shipments skip label_by (no provider label
// step). Cancelled / Rejected shipments have no live SLA — they appear as
// 'not_applicable'. Mode derivation goes through deriveSlaShipmentMode so
// stale shipment.shipmentMode cannot silently suppress label_by.
export function getApplicableTargetTypes(shipment: Shipment): SlaTargetType[] {
  if (shipment.status === 'Cancelled' || shipment.status === 'Rejected') return [];
  const isReturn = !!shipment.returnInfo?.isReturn;
  const mode = deriveSlaShipmentMode(shipment);
  const types: SlaTargetType[] = ['pack_by'];
  if (mode === 'provider') types.push('label_by');
  types.push('dispatch_by');
  if (isReturn) types.push('return_receive_by');
  else types.push('deliver_by');
  return types;
}

// Compute a single SLA target's status + explanation. Pure: no side effects,
// no I/O. `nowMs` makes time injection explicit so callers can pass a
// stable timestamp for batch computations / tests.
export function computeSlaTarget(
  shipment: Shipment,
  type: SlaTargetType,
  policy: SlaPolicy,
  nowMs: number,
): SlaTarget {
  const windowMs = policy.windows[type];
  const { source, actual } = getTargetTimestamps(shipment, type);

  // Paused shipments report all targets as paused, with reason in the
  // explanation. Source/actual still surface for transparency.
  if (shipment.slaPaused && !shipment.slaPaused.resumedAt) {
    return {
      type,
      status: 'paused',
      sourceTimestamp: source,
      actualTimestamp: actual,
      windowMs,
      explanation: `SLA paused — ${shipment.slaPaused.reason}`,
    };
  }

  if (!source) {
    return {
      type,
      status: 'unknown',
      windowMs,
      explanation: explanationForUnknown(type),
    };
  }

  const sourceMs = Date.parse(source);
  if (Number.isNaN(sourceMs)) {
    return {
      type,
      status: 'unknown',
      sourceTimestamp: source,
      windowMs,
      explanation: 'Invalid source timestamp — SLA cannot be calculated.',
    };
  }
  const deadlineMs = sourceMs + windowMs;
  const deadline = new Date(deadlineMs).toISOString();

  if (actual) {
    const actualMs = Date.parse(actual);
    if (Number.isNaN(actualMs)) {
      return {
        type,
        status: 'unknown',
        sourceTimestamp: source,
        deadline,
        actualTimestamp: actual,
        windowMs,
        explanation: 'Invalid actual timestamp — SLA cannot be calculated.',
      };
    }
    const variance = deadlineMs - actualMs; // positive = met, negative = missed
    if (variance >= 0) {
      return {
        type,
        status: 'met',
        sourceTimestamp: source,
        deadline,
        actualTimestamp: actual,
        varianceMs: variance,
        windowMs,
        explanation: `${labelForTarget(type)} met ${formatDuration(variance)} before deadline`,
      };
    }
    return {
      type,
      status: 'missed',
      sourceTimestamp: source,
      deadline,
      actualTimestamp: actual,
      varianceMs: variance,
      windowMs,
      explanation: `${labelForTarget(type)} missed by ${formatDuration(-variance)}`,
    };
  }

  // No actual yet — live status based on now vs. deadline.
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) {
    return {
      type,
      status: 'overdue',
      sourceTimestamp: source,
      deadline,
      varianceMs: remainingMs,
      windowMs,
      explanation: `${labelForTarget(type)} overdue by ${formatDuration(-remainingMs)}`,
    };
  }
  const atRiskCutoffMs = (windowMs * policy.atRiskThresholdPct) / 100;
  if (remainingMs <= atRiskCutoffMs) {
    return {
      type,
      status: 'at_risk',
      sourceTimestamp: source,
      deadline,
      varianceMs: remainingMs,
      windowMs,
      explanation: `${labelForTarget(type)} due in ${formatDuration(remainingMs)} (at risk)`,
    };
  }
  return {
    type,
    status: 'on_track',
    sourceTimestamp: source,
    deadline,
    varianceMs: remainingMs,
    windowMs,
    explanation: `${labelForTarget(type)} due ${formatAbsoluteDeadline(deadlineMs, nowMs)}`,
  };
}

// Compute every applicable target for a shipment. Returns an empty array
// for terminal-cancelled / rejected shipments (no SLA to track).
export function computeSlaTargets(
  shipment: Shipment,
  policy: SlaPolicy,
  nowMs: number,
): SlaTarget[] {
  const applicable = getApplicableTargetTypes(shipment);
  return applicable.map(t => computeSlaTarget(shipment, t, policy, nowMs));
}

// Severity ordering used by summarizeShipmentSla to pick the worst status
// across multiple targets. missed > overdue > at_risk > paused > on_track
// > met > unknown > not_applicable.
const STATUS_SEVERITY: Record<SlaStatus, number> = {
  missed: 60,
  overdue: 50,
  at_risk: 40,
  paused: 30,
  on_track: 20,
  met: 10,
  unknown: 5,
  not_applicable: 0,
};

export interface SlaShipmentSummary {
  worst: SlaStatus;
  applicable: boolean;
  paused: boolean;
  atRiskCount: number;
  overdueCount: number;
  missedCount: number;
  metCount: number;
  unknownCount: number;
  targets: SlaTarget[];
}

export function summarizeShipmentSla(
  shipment: Shipment,
  policy: SlaPolicy,
  nowMs: number,
): SlaShipmentSummary {
  const targets = computeSlaTargets(shipment, policy, nowMs);
  if (targets.length === 0) {
    return {
      worst: 'not_applicable',
      applicable: false,
      paused: false,
      atRiskCount: 0,
      overdueCount: 0,
      missedCount: 0,
      metCount: 0,
      unknownCount: 0,
      targets: [],
    };
  }
  let worst: SlaStatus = 'not_applicable';
  let atRiskCount = 0;
  let overdueCount = 0;
  let missedCount = 0;
  let metCount = 0;
  let unknownCount = 0;
  let paused = false;
  for (const t of targets) {
    if (STATUS_SEVERITY[t.status] > STATUS_SEVERITY[worst]) worst = t.status;
    if (t.status === 'at_risk') atRiskCount++;
    else if (t.status === 'overdue') overdueCount++;
    else if (t.status === 'missed') missedCount++;
    else if (t.status === 'met') metCount++;
    else if (t.status === 'unknown') unknownCount++;
    else if (t.status === 'paused') paused = true;
  }
  return {
    worst,
    applicable: true,
    paused,
    atRiskCount,
    overdueCount,
    missedCount,
    metCount,
    unknownCount,
    targets,
  };
}

// Human label for each target type — surfaced in explanations and the UI.
export function labelForTarget(type: SlaTargetType): string {
  switch (type) {
    case 'pack_by': return 'Pack';
    case 'label_by': return 'Label';
    case 'dispatch_by': return 'Dispatch';
    case 'deliver_by': return 'Delivery';
    case 'return_receive_by': return 'Return receive';
  }
}

function explanationForUnknown(type: SlaTargetType): string {
  switch (type) {
    case 'pack_by': return 'Pack SLA unknown — no creation timestamp';
    case 'label_by': return 'Label SLA unknown — no packing timestamp';
    case 'dispatch_by': return 'Dispatch SLA unknown — no label / packing timestamp';
    case 'deliver_by': return 'Delivery SLA unknown — no dispatch timestamp';
    case 'return_receive_by': return 'Return receive SLA unknown — no dispatch timestamp';
  }
}

// Format a millisecond duration as a short human-readable string. Picks
// the largest natural unit ≥ 1; falls back to seconds for sub-minute.
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY) {
    const hours = ms / HOUR;
    return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
  }
  const days = ms / DAY;
  return days >= 10 ? `${Math.round(days)}d` : `${days.toFixed(1)}d`;
}

// Compose an absolute deadline phrase relative to now: "today at 3:00 PM",
// "tomorrow at 9:30 AM", or "Apr 28 at 2:15 PM" for further out. Short and
// scannable in the SLA card. Falls back to ISO if Intl is unavailable.
export function formatAbsoluteDeadline(deadlineMs: number, nowMs: number): string {
  try {
    const deadline = new Date(deadlineMs);
    const now = new Date(nowMs);
    const dayDiff = Math.floor((deadline.setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
    const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const d = new Date(deadlineMs);
    if (dayDiff === 0) return `today at ${fmtTime(d)}`;
    if (dayDiff === 1) return `tomorrow at ${fmtTime(d)}`;
    if (dayDiff > 1 && dayDiff < 7) {
      return `${d.toLocaleDateString(undefined, { weekday: 'short' })} at ${fmtTime(d)}`;
    }
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${fmtTime(d)}`;
  } catch {
    return new Date(deadlineMs).toISOString();
  }
}

// UI tone mapping — single source of truth for badge colors so the list
// chip / detail card / filter chip stay consistent.
export function toneForStatus(status: SlaStatus): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  switch (status) {
    case 'on_track':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', label: 'On Track' };
    case 'at_risk':
      return { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', label: 'At Risk' };
    case 'overdue':
      return { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', label: 'Overdue' };
    case 'met':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', label: 'Met' };
    case 'missed':
      return { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', label: 'Missed' };
    case 'paused':
      return { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200', label: 'Paused' };
    case 'unknown':
      return { bg: 'bg-slate-50', text: 'text-slate-500', border: 'border-slate-200', label: 'Unknown' };
    case 'not_applicable':
    default:
      return { bg: 'bg-slate-50', text: 'text-slate-400', border: 'border-slate-200', label: 'N/A' };
  }
}

// Convert a millisecond window into a friendly editor label like "4 hours"
// or "5 days". Used by the policy editor.
export function formatWindowMs(ms: number): string {
  if (ms < HOUR) return `${Math.round(ms / 60_000)} minutes`;
  if (ms < DAY) {
    const h = ms / HOUR;
    return h === 1 ? '1 hour' : `${Number.isInteger(h) ? h : h.toFixed(1)} hours`;
  }
  const d = ms / DAY;
  return d === 1 ? '1 day' : `${Number.isInteger(d) ? d : d.toFixed(1)} days`;
}

// Parse hours / days editor input back to ms. Returns null on invalid input.
export function parseWindowInput(value: number, unit: 'hours' | 'days'): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return unit === 'hours' ? value * HOUR : value * DAY;
}
