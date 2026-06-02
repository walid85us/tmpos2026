// Phase 1.1.1 — Interactive Command Center / Mission Control
//
// This is the operational home for Platform Operations & Security. It is
// strictly additive on top of accepted Phase 1.1 behavior:
//   - Mission Control header (overall state, time range, focus mode,
//     last-refreshed, refresh, truth label).
//   - Operational Pulse Strip (7 metrics).
//   - Widget grid (8 widgets — distributions and small streams).
//   - Next Best Actions (deterministic rule-based; NO AI).
//   - Tenant 360 drawer (read-only summary panel).
//   - Existing Needs Attention queue, Tenant Risk Summary, Workflow Health,
//     Quick Actions and high-risk legend are preserved unchanged.
//
// Important truth boundaries enforced everywhere on this page:
//   - Risk is *derived* from existing in-memory signals — never invented.
//   - There is no real DNS / SSL / SSO / notifications / AI / uptime
//     monitoring. Everything below is computed from seeded mock data and
//     in-session sessionStorage.
//   - Audit events are pushed only on meaningful operator actions
//     (refresh, mode change, drawer open) — never on hover or every
//     keystroke.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  tenants,
  tenantDomains,
  supportCases as supportCasesSeed,
  billingTransactions,
  type SupportCaseRecord,
} from './mockData';
import {
  deriveHighRiskFlag,
  deriveTenantRisk,
  deriveSlaStatus,
  deriveOverallPlatformState,
  deriveOperationalPulse,
  deriveWidgetDistributions,
  deriveNextBestActions,
  deriveTenant360,
  filterByTimeRange,
  filterByFocusMode,
  applyFocusModeToCases,
  applyFocusModeToAudits,
  applyFocusModeToDomains,
  PULSE_ROUTING,
  type PulseFilterId,
  RISK_STATUS_LABEL,
  RISK_STATUS_STYLES,
  SLA_STATUS_STYLES,
  SLA_STATUS_LABEL,
  HIGH_RISK_FLAG_STYLES,
  HIGH_RISK_FLAG_LABEL,
  PLATFORM_STATE_LABEL,
  PLATFORM_STATE_STYLES,
  TIME_RANGE_LABEL,
  FOCUS_MODE_LABEL,
  FOCUS_MODE_DESCRIPTION,
  type AuditEventLike,
  type RiskStatus,
  type HighRiskFlag,
  type TimeRange,
  type FocusMode,
  type PulseMetric,
  type DistributionBucket,
  type NextBestAction,
  type Tenant360Result,
  // Phase 1.1.2 — competitive maturity helpers (additive).
  WIDGET_META,
  bucketNavigateTo,
  tierForPriority,
  NBA_TIER_LABEL,
  NBA_TIER_STYLES,
  PHASE_112_TRUTH_LABEL,
  type WidgetId,
  // Phase 1.1.3A — escalation lifecycle helpers (additive).
  effectiveEscalationStatus,
  isActiveEscalation,
  deriveEscalationSignal,
  isEscalationAckOverdue,
  isEscalationCritical,
  ESCALATION_STATUS_LABEL,
  ESCALATION_LEVEL_LABEL,
  PHASE_113A_TRUTH_LABEL,
  // Phase 1.1.3B — advanced command center intelligence (additive).
  INTELLIGENCE_TRUTH_LABEL,
  CORRELATION_TRUTH_LABEL,
  SIGNAL_SOURCE_LABEL,
  ATTENTION_PRIORITY_LABEL,
  deriveCommercialBlockers,
  deriveCommandSignals,
  deriveTenantHealthSignals,
  deriveCorrelatedRiskGroups,
  buildCommandCenterSnapshot,
  diffCommandCenterSnapshots,
  deriveIntelligenceRibbon,
  enrichNextBestActions,
  deriveCommercialNbas,
  nbaMatchesFilter,
  NBA_FILTERS,
  type CommercialBlocker,
  type CommandSignal,
  type TenantHealthSignal,
  type CorrelatedRiskGroup,
  type CommandCenterSnapshot,
  type SnapshotDelta,
  type RibbonCard,
  type RibbonTone,
  type CommandDrawerId,
  type EnrichedNba,
  type AttentionPriority,
} from './platformOpsDerive';
import { pushPlatformAudit } from './platformOpsAudit';
import { useAccess } from '../context/AccessContext';
import {
  hasPlatformPermission,
} from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';

const CASES_KEY = 'support_cases_v1';
const NOTES_KEY = 'platform_security_notes';
const DOMAINS_KEY = 'tenant_domains_v1';
// Phase 1.1.3B — what-changed baseline snapshot persists across sessions.
const SNAPSHOT_KEY = 'cc_intel_snapshot_v1';

// Phase 1.1.3B — intelligence ribbon tone styling (card chrome only).
const RIBBON_TONE_STYLES: Record<RibbonTone, string> = {
  ok: 'border-emerald-200 bg-emerald-50/60',
  info: 'border-sky-200 bg-sky-50/60',
  warn: 'border-amber-200 bg-amber-50/60',
  critical: 'border-red-200 bg-red-50/70',
};
const ATTENTION_PILL_STYLES: Record<AttentionPriority, string> = {
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
  high: 'bg-orange-500/10 text-orange-700 border-orange-500/30',
  medium: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  low: 'bg-slate-500/10 text-slate-600 border-slate-300',
};
const CONFIDENCE_PILL_STYLES: Record<'High' | 'Medium' | 'Low', string> = {
  High: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  Medium: 'bg-sky-500/10 text-sky-700 border-sky-500/30',
  Low: 'bg-slate-500/10 text-slate-600 border-slate-300',
};
const COMMAND_DRAWER_LABEL: Record<CommandDrawerId, string> = {
  escalations: 'Active Escalations',
  sla: 'SLA Pressure',
  audits: 'High-Risk Audit Events',
  domains: 'Domain Health',
  commercial: 'Commercial Blockers',
  tenant_risk: 'Tenant Risk',
};

function readLocal<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

type SecurityNote = { id: string; body: string; author: string; createdAt: string };

function readSession<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return fallback;
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

type AttentionItem = {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  type: string;
  tenantId: string | null;
  tenant: string | null;
  title: string;
  reason: string;
  age?: string;
  href: string;
};

const PRIORITY_STYLES: Record<AttentionItem['priority'], string> = {
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
  high: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  medium: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  low: 'bg-slate-100 text-slate-600 border-slate-200',
};

const TONE_BAR: Record<DistributionBucket['tone'], string> = {
  ok: 'bg-emerald-500',
  info: 'bg-blue-500',
  warn: 'bg-orange-500',
  critical: 'bg-red-500',
  muted: 'bg-slate-300',
};

const TONE_TEXT: Record<DistributionBucket['tone'], string> = {
  ok: 'text-emerald-700',
  info: 'text-blue-700',
  warn: 'text-orange-700',
  critical: 'text-red-700',
  muted: 'text-slate-500',
};

// Mission Control hero styling per state (Phase 1.1.1 UX Correction).
// `deriveOverallPlatformState` returns one of 4 states — keep the maps in sync.
// Backgrounds use very-soft tints so the rest of the page stays calm.
type MissionState = 'healthy' | 'watch' | 'at_risk' | 'critical';
const MISSION_HERO_STYLES: Record<MissionState, string> = {
  healthy: 'bg-gradient-to-br from-emerald-50 via-white to-white border-emerald-200',
  watch: 'bg-gradient-to-br from-amber-50 via-white to-white border-amber-200',
  at_risk: 'bg-gradient-to-br from-orange-50 via-white to-white border-orange-300',
  critical: 'bg-gradient-to-br from-red-50 via-white to-white border-red-300',
};
const MISSION_HERO_GLOW: Record<MissionState, string> = {
  healthy: 'bg-emerald-200/40',
  watch: 'bg-amber-200/40',
  at_risk: 'bg-orange-300/40',
  critical: 'bg-red-300/40',
};
const MISSION_HERO_ICON: Record<MissionState, string> = {
  healthy: '🟢',
  watch: '🟡',
  at_risk: '🟠',
  critical: '🔴',
};
const FOCUS_MODE_BANNER_STYLES: Record<FocusMode, string> = {
  normal: 'bg-slate-50 text-slate-700 border-slate-200',
  watch: 'bg-amber-50 text-amber-800 border-amber-300',
  incident: 'bg-red-50 text-red-800 border-red-300',
};

function formatRelative(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

const CommandCenterPage: React.FC = () => {
  const navigate = useNavigate();
  // Phase 1.1.3A correction — derive active platform role from the Dev
  // Session and gate Quick Actions / Tenant 360 / NBA click-throughs via
  // the platform permissions catalog. Pulse cells remain visible at the
  // View level and only their click-throughs are disabled.
  const { session } = useAccess();
  const sessionRole = (session?.role as Role | undefined) || null;
  const viewPageGate = hasPlatformPermission(sessionRole, 'view_command_center');
  const viewPulseGate = hasPlatformPermission(sessionRole, 'view_operational_pulse');
  const viewNeedsAttentionGate = hasPlatformPermission(sessionRole, 'view_needs_attention');
  const viewTenant360Gate = hasPlatformPermission(sessionRole, 'view_tenant_360');
  const useQuickActionsGate = hasPlatformPermission(sessionRole, 'use_command_quick_actions');
  // Pre-QA correction: canonical key is `view_next_best_actions`. Legacy
  // `view_nba_recommendations` still resolves via PLATFORM_SUB_PERMISSION_ALIASES.
  const viewNbaGate = hasPlatformPermission(sessionRole, 'view_next_best_actions');
  const actNbaGate = hasPlatformPermission(sessionRole, 'act_on_nba_recommendations');
  const [cases, setCases] = useState<SupportCaseRecord[]>([]);
  const [audits, setAudits] = useState<AuditEventLike[]>([]);
  const [domains, setDomains] = useState<typeof tenantDomains>([]);
  const [notes, setNotes] = useState<SecurityNote[]>([]);

  // Mission Control state. Default to 'all' so Needs Attention preserves
  // the Phase 1.1 baseline (no items hidden by an implicit 7-day window).
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [focusMode, setFocusMode] = useState<FocusMode>('normal');
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [drawerTenantId, setDrawerTenantId] = useState<string | null>(null);
  // Phase 1.1.1 UX Correction — interactive pulse filter for Needs Attention.
  const [activePulseFilter, setActivePulseFilter] = useState<PulseFilterId | null>(null);
  // Phase 1.1.3B — intelligence surfaces state.
  const [commandDrawer, setCommandDrawer] = useState<CommandDrawerId | null>(null);
  const [nbaFilter, setNbaFilter] = useState<string>('all');
  const [reviewBaseline, setReviewBaseline] = useState<CommandCenterSnapshot | null>(
    () => readLocal<CommandCenterSnapshot | null>(SNAPSHOT_KEY, null)
  );
  // Tick to make the "Updated Xm ago" label feel live without a second state.
  const [, setTick] = useState(0);
  useEffect(() => {
    const i = window.setInterval(() => setTick(x => (x + 1) % 1000), 30_000);
    return () => window.clearInterval(i);
  }, []);

  // Live data load + change subscriptions ---------------------------------
  const reloadAll = useCallback(() => {
    setCases(readSession<SupportCaseRecord[]>(CASES_KEY, supportCasesSeed));
    setAudits(readSession<AuditEventLike[]>('audit_logs', []));
    setDomains(readSession<typeof tenantDomains>(DOMAINS_KEY, tenantDomains));
    setNotes(readSession<SecurityNote[]>(NOTES_KEY, []));
    setLastRefreshed(new Date());
  }, []);

  useEffect(() => {
    reloadAll();
    const onAny = () => reloadAll();
    window.addEventListener('audit_logs:changed', onAny);
    window.addEventListener('storage', onAny);
    window.addEventListener('support_cases:changed', onAny);
    window.addEventListener('tenant_domains:changed', onAny);
    window.addEventListener('platform_security_notes:changed', onAny);
    return () => {
      window.removeEventListener('audit_logs:changed', onAny);
      window.removeEventListener('storage', onAny);
      window.removeEventListener('support_cases:changed', onAny);
      window.removeEventListener('tenant_domains:changed', onAny);
      window.removeEventListener('platform_security_notes:changed', onAny);
    };
  }, [reloadAll]);

  const tenantById = useMemo(() => {
    const m = new Map<string, string>();
    tenants.forEach(t => m.set(t.id, t.name));
    return m;
  }, []);

  // --- Time-range filtered slices ----------------------------------------
  const filteredAudits = useMemo(
    () => filterByTimeRange(audits, timeRange),
    [audits, timeRange]
  );
  const filteredCases = useMemo(
    () => filterByTimeRange(cases, timeRange),
    [cases, timeRange]
  );

  // --- Focus-mode source slices (Phase 1.1.1 UX Correction) -------------
  // These narrow widgets / pulse / NBA so Focus Mode visibly changes the
  // entire Operational Pulse + widget grid + recommendations.
  const focusedCases = useMemo(
    () => applyFocusModeToCases(filteredCases, focusMode),
    [filteredCases, focusMode]
  );
  const focusedAudits = useMemo(
    () => applyFocusModeToAudits(filteredAudits, focusMode),
    [filteredAudits, focusMode]
  );
  const focusedDomains = useMemo(
    () => applyFocusModeToDomains(domains, focusMode),
    [domains, focusMode]
  );

  // --- Open / overdue / escalated --------------------------------------
  const openCases = filteredCases.filter(c => c.status !== 'resolved' && c.status !== 'closed');
  const criticalCases = openCases.filter(c => c.severity === 'urgent');
  const overdueCases = openCases.filter(c => deriveSlaStatus(c).status === 'overdue');
  // Phase 1.1.3A correction — shared active-escalation predicate so this
  // count agrees with the focused escalated-cases list rendered below
  // (and with Support Tools, Tenant 360, Needs Attention, NBA).
  const escalatedCases = openCases.filter(c => isActiveEscalation(c));
  // Phase 1.1.3A correction — ONE escalation signal derived from the SAME
  // focus/time-filtered slice that feeds the Operational Pulse, so the
  // escalated pulse COUNT and the Needs Attention "Escalated case" LIST
  // (built from `escalationSignal.activeEscalatedCases` below) are read
  // from one source and can never disagree. Previously the escalated
  // attention items were derived from `escalatedCases` AND skipped when a
  // case was already queued as Critical/Overdue, so the count (e.g. 3)
  // disagreed with the filtered list (0).
  const escalationSignal = deriveEscalationSignal(focusedCases);
  const elevatedAuditCount = filteredAudits.filter(a => {
    const sev = (a.severity || '').toLowerCase();
    return sev === 'critical' || sev === 'warning';
  }).length;
  const failedDomains = domains.filter(d => d.status === 'failed').length;
  const pendingDomains = domains.filter(
    d => d.status === 'pending' || d.status === 'verifying'
  ).length;
  const sslMissing = domains.filter(d => d.ssl !== 'active' && d.status === 'verified').length;

  // --- Tenant risk -------------------------------------------------------
  // Tenant risk uses the *unfocused* slices so the tenant-level risk band
  // doesn't artificially flip green when an operator switches into Watch /
  // Incident mode. Mode only changes what surfaces, not the underlying
  // tenant truth.
  const tenantRisk = useMemo(
    () => tenants.map(t => ({
      tenant: t,
      risk: deriveTenantRisk(t.id, { audits: filteredAudits, cases: filteredCases, domains }),
    })),
    [filteredAudits, filteredCases, domains]
  );
  // Focus-mode-aware tenant risk slice for widgets / pulse "tenants_at_risk".
  const focusedTenantRisk = useMemo(() => {
    if (focusMode === 'normal') return tenantRisk;
    if (focusMode === 'watch') {
      return tenantRisk.filter(r => r.risk.status !== 'healthy');
    }
    return tenantRisk.filter(r => r.risk.status === 'critical' || r.risk.status === 'at_risk');
  }, [tenantRisk, focusMode]);
  const tenantsAtRisk = tenantRisk.filter(
    r => r.risk.status === 'at_risk' || r.risk.status === 'critical'
  );

  // --- Needs attention queue (preserved from Phase 1.1, dedup retained) -
  const attention: AttentionItem[] = [];
  criticalCases.forEach(c => {
    attention.push({
      id: `cc_${c.id}`, priority: 'critical', type: 'Critical support case',
      tenantId: c.tenantId, tenant: tenantById.get(c.tenantId) || c.tenantId,
      title: c.subject, reason: 'Severity = urgent', age: c.openedAt,
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    });
  });
  overdueCases.forEach(c => {
    attention.push({
      id: `oc_${c.id}`, priority: c.severity === 'urgent' || c.severity === 'high' ? 'high' : 'medium',
      type: 'Overdue support case', tenantId: c.tenantId,
      tenant: tenantById.get(c.tenantId) || c.tenantId,
      title: c.subject, reason: deriveSlaStatus(c).label, age: c.openedAt,
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    });
  });
  // Phase 1.1.3A correction — emit exactly one "Escalated support case"
  // attention item for EVERY active escalated case in the same focus-
  // filtered slice the pulse counts (escalationSignal.activeEscalatedCases).
  // The previous dedup-skip (suppressing escalation items when the case was
  // already queued as Critical/Overdue) made the escalated COUNT disagree
  // with the escalated FILTER list. Count and list now share one source.
  escalationSignal.activeEscalatedCases.forEach(c => {
    const reasonText = (c.escalationReason || '').trim();
    attention.push({
      id: `ec_${c.id}`, priority: c.severity === 'urgent' ? 'critical' : 'high',
      type: 'Escalated support case',
      tenantId: c.tenantId,
      tenant: c.tenantId ? (tenantById.get(c.tenantId) || c.tenantId) : 'Unknown tenant',
      title: c.subject,
      reason: reasonText ? `Escalated: ${reasonText}` : 'Escalated (no reason provided)',
      age: c.openedAt,
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    });
  });

  // Phase 1.1.3A — structured escalation lifecycle attention items.
  // Each is a distinct lifecycle defect (unack / overdue ack / critical
  // / no owner / SLA breached). Items are pushed in addition to the
  // legacy "Escalated support case" entry so operators see the
  // *reason* the escalation needs hands-on attention.
  // Phase 1.1.3A correction — iterate the SAME active-escalation slice the
  // pulse counts (escalationSignal.activeEscalatedCases) so lifecycle
  // attention items cannot reference cases excluded from the count. The
  // inner `!eff.active` guard is now always satisfied but kept defensively.
  escalationSignal.activeEscalatedCases.forEach(c => {
    const eff = effectiveEscalationStatus(c);
    if (!eff.active) return;
    const tenant = c.tenantId ? (tenantById.get(c.tenantId) || c.tenantId) : 'Unknown tenant';
    const ackOverdue = isEscalationAckOverdue(c);
    const critical = isEscalationCritical(c);
    const owner = (c.escalationOwnerName || '').trim();
    const sla = deriveSlaStatus(c).status;
    // a) Overdue acknowledgement — critical priority.
    if (ackOverdue) {
      attention.push({
        id: `eack_${c.id}`,
        priority: 'critical',
        type: 'Overdue escalation acknowledgement',
        tenantId: c.tenantId,
        tenant,
        title: c.subject,
        reason: `Ack due ${c.acknowledgementDueAt ? new Date(c.acknowledgementDueAt).toLocaleString() : '—'}`,
        age: c.escalatedAt || c.openedAt,
        href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
      });
    } else if (eff.status === 'escalated') {
      // b) Unacknowledged but not yet overdue.
      attention.push({
        id: `eunack_${c.id}`,
        priority: critical ? 'critical' : 'high',
        type: 'Unacknowledged escalation',
        tenantId: c.tenantId,
        tenant,
        title: c.subject,
        reason: `${eff.level ? `${ESCALATION_LEVEL_LABEL[eff.level]} · ` : ''}awaiting acknowledgement`,
        age: c.escalatedAt || c.openedAt,
        href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
      });
    }
    // c) Critical-level escalation (regardless of ack state).
    if (critical) {
      attention.push({
        id: `ecrit_${c.id}`,
        priority: 'critical',
        type: 'Critical escalation',
        tenantId: c.tenantId,
        tenant,
        title: c.subject,
        reason: `${eff.level ? ESCALATION_LEVEL_LABEL[eff.level] : 'Urgent severity'} · ${ESCALATION_STATUS_LABEL[eff.status]}`,
        age: c.escalatedAt || c.openedAt,
        href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
      });
    }
    // d) Active escalation without an assigned owner.
    if (!owner) {
      attention.push({
        id: `enown_${c.id}`,
        priority: critical ? 'high' : 'medium',
        type: 'Escalation without owner',
        tenantId: c.tenantId,
        tenant,
        title: c.subject,
        reason: c.escalationTargetTeam ? `Team: ${c.escalationTargetTeam}` : 'No owner or team assigned',
        age: c.escalatedAt || c.openedAt,
        href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
      });
    }
    // e) Active escalation with SLA-breach concurrency.
    if (sla === 'overdue') {
      attention.push({
        id: `eslad_${c.id}`,
        priority: 'critical',
        type: 'Escalation with SLA breach',
        tenantId: c.tenantId,
        tenant,
        title: c.subject,
        reason: `${ESCALATION_STATUS_LABEL[eff.status]} · resolution SLA overdue`,
        age: c.escalatedAt || c.openedAt,
        href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
      });
    }
  });
  filteredAudits.slice(0, 50).forEach(a => {
    const { flag } = deriveHighRiskFlag(a);
    if (flag === 'critical') {
      attention.push({
        id: `ae_${a.id}`, priority: 'critical', type: 'High-risk audit event',
        tenantId: a.tenantId || null,
        tenant: a.tenantId ? tenantById.get(a.tenantId) || a.tenantId : null,
        title: a.action, reason: `${a.target} · ${a.severity}`, age: a.date,
        href: `/owner/audit-security?event=${encodeURIComponent(a.id)}`,
      });
    } else if (flag === 'high_risk') {
      attention.push({
        id: `ae_${a.id}`, priority: 'high', type: 'High-risk audit event',
        tenantId: a.tenantId || null,
        tenant: a.tenantId ? tenantById.get(a.tenantId) || a.tenantId : null,
        title: a.action, reason: `${a.target}`, age: a.date,
        href: `/owner/audit-security?event=${encodeURIComponent(a.id)}`,
      });
    }
  });
  domains.forEach(d => {
    if (d.status === 'failed') {
      attention.push({
        id: `df_${d.id}`, priority: 'high', type: 'Failed domain verification',
        tenantId: d.tenantId, tenant: tenantById.get(d.tenantId) || d.tenantId,
        title: d.hostname, reason: 'Verification failed', age: d.createdAt,
        href: `/owner/domains?domain=${d.id}`,
      });
    } else if (d.status === 'pending' || d.status === 'verifying') {
      attention.push({
        id: `dp_${d.id}`, priority: 'medium', type: 'Pending domain verification',
        tenantId: d.tenantId, tenant: tenantById.get(d.tenantId) || d.tenantId,
        title: d.hostname, reason: `Status: ${d.status}`, age: d.createdAt,
        href: `/owner/domains?domain=${d.id}`,
      });
    }
  });
  notes.slice(0, 5).forEach(n => {
    attention.push({
      id: `sn_${n.id}`, priority: 'low', type: 'Open security note',
      tenantId: null, tenant: null,
      title: n.body.length > 80 ? `${n.body.slice(0, 80)}…` : n.body,
      reason: 'Security posture note', age: n.createdAt.slice(0, 10),
      href: '/owner/audit-security',
    });
  });
  attention.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  const focusedAttention = filterByFocusMode(attention, focusMode) as AttentionItem[];
  // Phase 1.1.1 UX Correction — apply the active pulse filter on top of
  // focus-mode filtering so clicking a pulse visibly narrows the queue.
  const pulseFilteredAttention = activePulseFilter
    ? focusedAttention.filter(item => {
        const pred = PULSE_ROUTING[activePulseFilter].filtersAttention;
        return pred ? pred(item) : true;
      })
    : focusedAttention;

  // --- Workflow health (truthful labels) -------------------------------
  const workflowHealth = [
    { label: 'Support cases — open', value: openCases.length },
    { label: 'Support cases — overdue', value: overdueCases.length },
    { label: 'Support cases — escalated', value: escalatedCases.length },
    { label: 'Audit events — elevated', value: elevatedAuditCount },
    { label: 'Domains — pending verification', value: pendingDomains },
    { label: 'Domains — failed', value: failedDomains },
    { label: 'Security notes — unresolved', value: notes.length },
  ];

  // --- Mission Control derivations -------------------------------------
  const overall = useMemo(
    () => deriveOverallPlatformState({ cases: filteredCases, audits: filteredAudits, domains }),
    [filteredCases, filteredAudits, domains]
  );
  const pulse: PulseMetric[] = useMemo(
    () => deriveOperationalPulse({
      cases: focusedCases, audits: focusedAudits, domains: focusedDomains,
      tenantRisks: focusedTenantRisk.map(t => ({ status: t.risk.status })),
      // Phase 1.1.1 UX Correction — keep pulse Pending Actions consistent with
      // the focus-mode-narrowed Needs Attention queue so the strip and the
      // queue cannot disagree.
      attentionCount: focusedAttention.length,
    }),
    [focusedCases, focusedAudits, focusedDomains, focusedTenantRisk, focusedAttention.length]
  );
  const widgets = useMemo(
    () => deriveWidgetDistributions({
      cases: focusedCases, audits: focusedAudits, domains: focusedDomains,
      tenantRisks: focusedTenantRisk.map(t => ({ status: t.risk.status })),
    }),
    [focusedCases, focusedAudits, focusedDomains, focusedTenantRisk]
  );
  const nba: NextBestAction[] = useMemo(
    () => deriveNextBestActions({
      cases: focusedCases, audits: focusedAudits, domains: focusedDomains,
      tenantRisks: focusedTenantRisk.map(t => ({
        tenantId: t.tenant.id, tenantName: t.tenant.name,
        status: t.risk.status, signals: t.risk.signals,
      })),
      notes,
      tenantNameById: tenantById,
    }),
    [focusedCases, focusedAudits, focusedDomains, focusedTenantRisk, notes, tenantById]
  );

  // High-risk audit stream + escalated cases for compact widgets — also
  // narrow with the focus-mode audit slice so Watch / Incident visibly
  // changes the stream.
  const highRiskStream = useMemo(
    () => focusedAudits
      .map(a => ({ a, flag: deriveHighRiskFlag(a).flag }))
      .filter(x => x.flag === 'critical' || x.flag === 'high_risk')
      .slice(0, 5),
    [focusedAudits]
  );
  const focusedEscalatedCases = useMemo(
    // Phase 1.1.3A correction — shared `isActiveEscalation` so the
    // widget list cannot disagree with the Mission Control rollup,
    // Operational Pulse, Needs Attention, or the escalated count.
    () => focusedCases.filter(c => isActiveEscalation(c)).slice(0, 5),
    [focusedCases]
  );

  // Add-on / Commercial attention: tenants whose activation is not 'active'
  // OR open cases whose subject mentions billing / invoice / payment.
  const commercialAttention = useMemo(() => {
    const billingCases = openCases.filter(c =>
      /billing|invoice|payment|charge|refund|subscription/i.test(c.subject) ||
      /billing|invoice|payment|charge|refund|subscription/i.test(c.description || '')
    );
    type CommercialItem = {
      kind: 'tenant' | 'case'; id: string; label: string; sublabel: string;
      tone: DistributionBucket['tone']; href: string; tenantId?: string;
    };
    const items: CommercialItem[] = [];
    tenants.forEach(t => {
      if (t.activationStatus && t.activationStatus !== 'active') {
        items.push({
          kind: 'tenant', id: `ct_${t.id}`,
          label: t.name,
          sublabel: `Activation: ${t.activationStatus}`,
          tone: 'warn',
          href: `/owner/tenants/${t.id}`,
          tenantId: t.id,
        });
      }
    });
    billingCases.slice(0, 5).forEach(c => {
      items.push({
        kind: 'case', id: `cb_${c.id}`,
        label: c.subject,
        sublabel: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.severity}`,
        tone: c.severity === 'urgent' ? 'critical' : 'info',
        href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
        tenantId: c.tenantId,
      });
    });
    return items.slice(0, 6);
  }, [openCases, tenantById]);

  // --- Operator handlers (audited) -------------------------------------
  const onRefresh = () => {
    reloadAll();
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_refreshed',
      target: 'Mission Control',
      category: 'configuration',
      severity: 'info',
    });
  };
  const onTimeRange = (r: TimeRange) => {
    if (r === timeRange) return;
    setTimeRange(r);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_time_range_changed',
      target: TIME_RANGE_LABEL[r],
      category: 'configuration',
      severity: 'info',
    });
  };
  const onFocus = (m: FocusMode) => {
    if (m === focusMode) return;
    setFocusMode(m);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_focus_mode_changed',
      target: FOCUS_MODE_LABEL[m],
      category: 'configuration',
      severity: 'info',
    });
  };
  const onOpenTenant360 = (tenantId: string | null | undefined) => {
    if (!tenantId) return;
    // Guard: if the same tenant drawer is already open, don't re-fire the
    // audit event (avoids spam when the user clicks the same tenant twice).
    if (drawerTenantId === tenantId) return;
    setDrawerTenantId(tenantId);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_tenant360_opened',
      target: tenantById.get(tenantId) || tenantId,
      category: 'configuration',
      severity: 'info',
      tenantId,
    });
  };
  const onCloseTenant360 = () => setDrawerTenantId(null);

  // Phase 1.1.1 UX Correction — pulse click router.
  const onPulseClick = (id: PulseFilterId, value: number) => {
    if (value === 0) return;
    const route = PULSE_ROUTING[id];
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_pulse_filter_applied',
      target: route.filterLabel,
      category: 'configuration',
      severity: 'info',
    });
    if (route.filtersAttention) {
      // Toggle: clicking the active pulse clears the filter.
      setActivePulseFilter(curr => (curr === id ? null : id));
      // Scroll Needs Attention into view so the filter effect is obvious.
      requestAnimationFrame(() => {
        document
          .querySelector('[data-testid="needs-attention-section"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } else if (route.navigateTo) {
      navigate(route.navigateTo);
    }
  };
  const onClearPulseFilter = () => setActivePulseFilter(null);

  const onQuickAction = (label: string, href: string) => {
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_quick_action_used',
      target: label,
      category: 'configuration',
      severity: 'info',
    });
    navigate(href);
  };

  const tenant360: Tenant360Result | null = useMemo(() => {
    if (!drawerTenantId) return null;
    const t = tenants.find(x => x.id === drawerTenantId);
    if (!t) return null;
    return deriveTenant360({
      tenantId: t.id,
      tenantName: t.name,
      plan: t.plan,
      status: t.status,
      cases, audits, domains, notes,
    });
  }, [drawerTenantId, cases, audits, domains, notes]);

  // --- Phase 1.1.3B — advanced command center intelligence -------------
  // Everything below is deterministic and derived from the SAME focus/
  // time-filtered slices that feed the Operational Pulse, so the new
  // intelligence surfaces (ribbon, heatmap, episodes, what-changed,
  // upgraded NBA) never disagree with the existing counts/lists.
  const commercialBlockers: CommercialBlocker[] = useMemo(
    () => deriveCommercialBlockers({ tenants, billing: billingTransactions }),
    []
  );
  const commandSignals: CommandSignal[] = useMemo(
    () => deriveCommandSignals({
      cases: focusedCases,
      audits: focusedAudits,
      domains: focusedDomains,
      commercialBlockers,
      tenantNameById: tenantById,
    }),
    [focusedCases, focusedAudits, focusedDomains, commercialBlockers, tenantById]
  );
  const tenantHealth: TenantHealthSignal[] = useMemo(
    () => deriveTenantHealthSignals({
      tenants,
      cases: filteredCases,
      audits: filteredAudits,
      domains,
      commercialBlockers,
    }),
    [filteredCases, filteredAudits, domains, commercialBlockers]
  );
  const correlatedGroups: CorrelatedRiskGroup[] = useMemo(
    () => deriveCorrelatedRiskGroups(commandSignals),
    [commandSignals]
  );
  const currentSnapshot: CommandCenterSnapshot = useMemo(
    () => buildCommandCenterSnapshot({ signals: commandSignals, tenantHealth, cases: focusedCases }),
    [commandSignals, tenantHealth, focusedCases]
  );
  const snapshotDelta: SnapshotDelta = useMemo(
    () => diffCommandCenterSnapshots(reviewBaseline, currentSnapshot),
    [reviewBaseline, currentSnapshot]
  );
  const ribbon: RibbonCard[] = useMemo(
    () => deriveIntelligenceRibbon({ signals: commandSignals, tenantHealth, delta: snapshotDelta }),
    [commandSignals, tenantHealth, snapshotDelta]
  );
  const enrichedNba: EnrichedNba[] = useMemo(
    () => enrichNextBestActions([...nba, ...deriveCommercialNbas(commercialBlockers)]),
    [nba, commercialBlockers]
  );
  const filteredNba: EnrichedNba[] = useMemo(
    () => enrichedNba.filter(a => nbaMatchesFilter(a, nbaFilter)),
    [enrichedNba, nbaFilter]
  );

  // --- Phase 1.1.3B handlers (audited) ---------------------------------
  const onMarkReviewed = () => {
    setReviewBaseline(currentSnapshot);
    try {
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(currentSnapshot));
    } catch { /* storage unavailable — baseline stays in-memory only */ }
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_snapshot_saved',
      target: 'Command Center intelligence baseline',
      category: 'configuration',
      severity: 'info',
    });
  };
  const onOpenCommandDrawer = (id: CommandDrawerId) => {
    if (commandDrawer === id) { setCommandDrawer(null); return; }
    setCommandDrawer(id);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'command_center_intelligence_drawer_opened',
      target: id,
      category: 'configuration',
      severity: 'info',
    });
  };
  const onCloseCommandDrawer = () => setCommandDrawer(null);
  const onNbaFilter = (id: string) => setNbaFilter(id);

  const drawerSignals = useMemo<CommandSignal[]>(() => {
    if (!commandDrawer) return [];
    // Tenant risk drawer is sourced from tenantHealth (not the atomic signal
    // stream), so synthesize CommandSignal-shaped rows for the at-risk tenants.
    if (commandDrawer === 'tenant_risk') {
      return tenantHealth
        .filter(t => t.tier !== 'healthy')
        .map<CommandSignal>(t => ({
          id: `tenantrisk_${t.tenantId}`,
          kind: 'critical_case',
          category: 'tenant',
          priority: t.tier === 'critical' ? 'critical' : t.tier === 'at_risk' ? 'high' : 'medium',
          tenantId: t.tenantId,
          tenant: t.tenantName,
          label: `${RISK_STATUS_LABEL[t.tier]} · Score ${t.score}`,
          reason: t.recommendedAction,
          href: t.href,
          confidence: t.confidence,
        }));
    }
    // Each filter mirrors EXACTLY the kinds counted by its ribbon card so the
    // card count and the drawer row count stay reconciled (one source).
    const byDrawer: Record<Exclude<CommandDrawerId, 'tenant_risk'>, (s: CommandSignal) => boolean> = {
      escalations: s => s.kind === 'escalation',
      sla: s => s.kind === 'overdue_sla' || s.kind === 'at_risk_sla',
      audits: s => s.kind === 'high_risk_audit',
      domains: s => s.kind === 'failed_domain' || s.kind === 'pending_domain',
      commercial: s => s.kind === 'commercial_blocker',
    };
    return commandSignals.filter(byDrawer[commandDrawer]);
  }, [commandDrawer, commandSignals, tenantHealth]);

  return (
    <div className="space-y-8">
      {/* ============== MISSION CONTROL HEADER (Phase 1.1.1 UX Correction) ============== */}
      {/* Section-level gate: Mission Control hero is the page-level overview.
          When parent view_command_center is None and only a child section is
          permitted (e.g. view_needs_attention=View Only), this header MUST
          stay hidden so only the explicitly granted child section renders. */}
      {viewPageGate.allowed && (
      <section
        className={`relative overflow-hidden rounded-[2.5rem] border shadow-sm ${MISSION_HERO_STYLES[overall.state]}`}
        data-testid="mission-control-hero"
      >
        {/* Decorative state-tinted glow */}
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className={`absolute -top-24 -right-24 w-96 h-96 rounded-full blur-3xl ${MISSION_HERO_GLOW[overall.state]}`} />
        </div>

        <div className="relative p-6 lg:p-8 space-y-6">
          {/* Top row: state pill + title + refresh column */}
          <div className="flex items-start justify-between flex-wrap gap-6">
            <div className="flex items-start gap-5 min-w-0">
              {/* Big state hero block */}
              <div
                className={`shrink-0 w-20 h-20 rounded-3xl border-2 flex flex-col items-center justify-center shadow-md ${PLATFORM_STATE_STYLES[overall.state]}`}
                aria-hidden="true"
              >
                <span className="text-3xl leading-none" role="img" aria-label={PLATFORM_STATE_LABEL[overall.state]}>
                  {MISSION_HERO_ICON[overall.state]}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Platform Operations</p>
                <h2 className="text-3xl lg:text-4xl font-black text-primary tracking-tight mt-0.5">Mission Control</h2>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span
                    className={`px-3 py-1.5 rounded-xl border text-[11px] font-black uppercase tracking-widest ${PLATFORM_STATE_STYLES[overall.state]}`}
                    data-testid="mission-control-state"
                  >
                    {PLATFORM_STATE_LABEL[overall.state]}
                  </span>
                  <span className="text-sm text-slate-700 font-bold">{overall.summary}</span>
                </div>
                {overall.signals.length > 0 && (
                  <p className="text-xs text-slate-600 mt-2 max-w-2xl">
                    <span className="font-black uppercase tracking-widest text-[10px] text-slate-400 mr-2">Active signals:</span>
                    {overall.signals.join(' · ')}
                  </p>
                )}
                {/* Phase 1.1.2 — "what needs attention now" rollup.
                    Pulled from focused* slices so it respects focus mode. */}
                <div
                  data-testid="mission-control-rollup"
                  className="mt-3 flex items-center gap-3 flex-wrap text-[11px] font-bold text-slate-600"
                >
                  <span className="font-black uppercase tracking-widest text-[10px] text-slate-400">Now:</span>
                  <RollupChip label="Open" value={focusedCases.filter(c => c.status !== 'resolved' && c.status !== 'closed').length} tone="info" />
                  <RollupChip label="Overdue" value={focusedCases.filter(c => deriveSlaStatus(c).status === 'overdue').length} tone="critical" />
                  <RollupChip label="Escalated" value={focusedCases.filter(c => c.status !== 'resolved' && c.status !== 'closed' && isActiveEscalation(c)).length} tone="critical" />
                  <RollupChip label="High-risk audits" value={focusedAudits.filter(a => { const f = deriveHighRiskFlag(a).flag; return f === 'critical' || f === 'high_risk'; }).length} tone="warn" />
                  <RollupChip label="Domain issues" value={focusedDomains.filter(d => d.status === 'failed' || d.status === 'pending' || d.status === 'verifying').length} tone="warn" />
                </div>
              </div>
            </div>

            {/* Right column: refresh + range + mode (compact) */}
            <div className="flex flex-col items-end gap-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-500" data-testid="mission-control-updated">
                  Updated {formatRelative(lastRefreshed.toISOString())}
                </span>
                <button
                  onClick={onRefresh}
                  data-testid="mission-control-refresh"
                  className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-primary text-white rounded-xl hover:bg-primary/90 transition-colors shadow-sm"
                >
                  Refresh
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3 justify-end">
                <ChipGroup
                  testId="mission-control-time-range"
                  label="Range"
                  options={(['today', '7d', '30d', 'all'] as TimeRange[]).map(r => ({ value: r, label: TIME_RANGE_LABEL[r] }))}
                  value={timeRange}
                  onChange={v => onTimeRange(v as TimeRange)}
                />
                <ChipGroup
                  testId="mission-control-focus-mode"
                  label="Focus"
                  options={(['normal', 'watch', 'incident'] as FocusMode[]).map(m => ({ value: m, label: FOCUS_MODE_LABEL[m] }))}
                  value={focusMode}
                  onChange={v => onFocus(v as FocusMode)}
                />
              </div>
            </div>
          </div>

          {/* Active focus-mode banner ribbon (only visible when not normal) */}
          {focusMode !== 'normal' && (
            <div
              data-testid="focus-mode-banner"
              className={`flex items-center gap-3 px-4 py-3 rounded-2xl border-2 ${FOCUS_MODE_BANNER_STYLES[focusMode]}`}
            >
              <span className="text-xl" aria-hidden="true">{focusMode === 'watch' ? '👁️' : '🚨'}</span>
              <div className="min-w-0">
                <p className="text-sm font-black uppercase tracking-widest">
                  {focusMode === 'watch' ? 'Watch Mode Active' : 'Incident Review Active'}
                </p>
                <p className="text-[11px] font-medium opacity-80">
                  {FOCUS_MODE_DESCRIPTION[focusMode]} · Pulse, widgets and recommendations narrowed accordingly.
                </p>
              </div>
              <button
                onClick={() => onFocus('normal')}
                className="ml-auto shrink-0 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-white/70 hover:bg-white border border-current/30 rounded-xl transition-colors"
              >
                Exit
              </button>
            </div>
          )}

          {/* Phase 1.1.2 — visible truth label (verbatim, shared across surfaces). */}
          <p
            data-testid="mission-control-truth"
            className="text-[11px] font-medium text-slate-500 border-t border-slate-200/70 pt-3"
          >
            {focusMode === 'normal' && (
              <>
                {FOCUS_MODE_DESCRIPTION[focusMode]}{' '}
              </>
            )}
            <span className="text-slate-400">{PHASE_112_TRUTH_LABEL}</span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-400" data-testid="cc-phase-113a-truth-label">{PHASE_113A_TRUTH_LABEL}</span>
          </p>
          <p className="mt-1 text-[10px] font-medium text-slate-500">
            Quick actions and Tenant 360 follow the Global Permissions Matrix.
          </p>
        </div>
      </section>
      )}

      {/* ============== INTELLIGENCE RIBBON + WHAT-CHANGED (Phase 1.1.3B) ============== */}
      {/* Section-level gate: the intelligence ribbon and what-changed delta
          are page-overview content gated by the parent view_command_center
          permission, like the widget grid and Mission Control hero. */}
      {viewPageGate.allowed && (
      <section className="space-y-4" data-testid="intelligence-ribbon-section">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-black text-primary uppercase tracking-widest">Operational Intelligence</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Click any card to drill into the underlying signals.
            </p>
          </div>
          <span
            data-testid="intelligence-ribbon-truth"
            className="text-[10px] font-medium text-slate-400 max-w-md text-right"
          >
            {INTELLIGENCE_TRUTH_LABEL}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3" data-testid="intelligence-ribbon">
          {ribbon.map(card => (
            <RibbonCardView
              key={card.id}
              card={card}
              onOpen={card.drawer ? () => onOpenCommandDrawer(card.drawer as CommandDrawerId) : undefined}
            />
          ))}
        </div>

        {/* What changed / getting worse since last review */}
        <div
          className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 shadow-sm p-6"
          data-testid="what-changed-panel"
        >
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div className="min-w-0">
              <h4 className="text-sm font-black text-primary uppercase tracking-widest">What Changed</h4>
              <p className="text-xs text-slate-500 mt-1" data-testid="what-changed-summary">
                {snapshotDelta.summary}
                {snapshotDelta.hasBaseline && snapshotDelta.baselineAt && (
                  <span className="text-slate-400"> · Baseline {formatRelative(snapshotDelta.baselineAt)}</span>
                )}
              </p>
            </div>
            <button
              onClick={onMarkReviewed}
              data-testid="what-changed-mark-reviewed"
              className="shrink-0 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-primary text-white rounded-xl hover:bg-primary/90 transition-colors shadow-sm"
            >
              Mark reviewed
            </button>
          </div>
          {(snapshotDelta.newlyActive.length > 0 || snapshotDelta.gettingWorse.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div data-testid="what-changed-new">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
                  Newly active ({snapshotDelta.newlyActive.length})
                </p>
                {snapshotDelta.newlyActive.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No new signals.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {snapshotDelta.newlyActive.slice(0, 6).map(d => (
                      <li key={d.id} className="text-xs text-slate-600 flex items-start gap-2">
                        <span className="shrink-0 px-1.5 py-0.5 rounded-md border bg-sky-500/10 text-sky-700 border-sky-500/30 text-[9px] font-black uppercase tracking-wide">{d.kind}</span>
                        <Link to={d.href} className="hover:text-primary truncate">{d.label}</Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div data-testid="what-changed-worse">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
                  Getting worse ({snapshotDelta.gettingWorse.length})
                </p>
                {snapshotDelta.gettingWorse.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">Nothing escalating since last review.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {snapshotDelta.gettingWorse.slice(0, 6).map(d => (
                      <li key={d.id} className="text-xs text-slate-600 flex items-start gap-2">
                        <span className="shrink-0 px-1.5 py-0.5 rounded-md border bg-amber-500/10 text-amber-700 border-amber-500/30 text-[9px] font-black uppercase tracking-wide">{d.kind}</span>
                        <Link to={d.href} className="hover:text-primary truncate">{d.label}</Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
      )}

      {/* ============== OPERATIONAL PULSE STRIP ============== */}
      {viewPulseGate.allowed && (
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-black text-primary uppercase tracking-widest">Operational Pulse</h3>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Click any pulse to filter Needs Attention or jump to its surface.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3" data-testid="operational-pulse">
          {pulse.map(m => {
            const route = PULSE_ROUTING[m.id as PulseFilterId];
            const isActive = activePulseFilter === m.id;
            return (
              <PulseCard
                key={m.id}
                metric={m}
                active={isActive}
                onClick={() => onPulseClick(m.id as PulseFilterId, m.value)}
                actionHint={
                  m.value === 0
                    ? 'No items'
                    : route.filtersAttention
                      ? isActive ? 'Click to clear filter' : `Filter: ${route.filterLabel}`
                      : `Open ${route.filterLabel}`
                }
              />
            );
          })}
        </div>
      </section>
      )}

      {/* ============== WIDGET GRID (8 widgets) ============== */}
      {/* Section-level gate: widgets are part of the page overview, gated by
          the parent view_command_center permission. Hidden when the page is
          only reachable via an unrelated child grant. */}
      {viewPageGate.allowed && (
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-black text-primary uppercase tracking-widest">Operational Widgets</h3>
          {focusMode !== 'normal' && (
            <span
              data-testid="widgets-focus-ribbon"
              className={`px-3 py-1 rounded-xl border text-[10px] font-black uppercase tracking-widest ${FOCUS_MODE_BANNER_STYLES[focusMode]}`}
            >
              {focusMode === 'watch' ? '👁️ Watch Mode — narrowed to actionable items' : '🚨 Incident Review — narrowed to severe items'}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <DistributionWidget widgetId="cases-by-severity" buckets={widgets.casesBySeverity} testId="widget-cases-by-severity" />
          <DistributionWidget widgetId="sla-pressure" buckets={widgets.slaPressure} testId="widget-sla-pressure" />
          <DistributionWidget widgetId="tenant-risk" buckets={widgets.tenantRisk} testId="widget-tenant-risk" />
          <DistributionWidget widgetId="audit-by-severity" buckets={widgets.auditsBySeverity} testId="widget-audit-by-severity" />
          <DistributionWidget widgetId="domain-snapshot" buckets={widgets.domainsByStatus} testId="widget-domain-snapshot" />

          {/* High-risk audit stream */}
          <ListWidget widgetId="high-risk-stream" testId="widget-high-risk-stream">
            {highRiskStream.map(({ a, flag }) => (
              <li key={a.id} className="py-2 first:pt-0 last:pb-0 border-b border-slate-100 last:border-0 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={`/owner/audit-security?event=${encodeURIComponent(a.id)}`} className="text-xs font-bold text-slate-800 hover:text-primary truncate block">{a.action}</Link>
                  <p className="text-[11px] text-slate-500 truncate">
                    {a.target}{a.tenantId ? ` · ${tenantById.get(a.tenantId) || a.tenantId}` : ''}
                  </p>
                </div>
                {flag && (
                  <span className={`shrink-0 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded-md border ${HIGH_RISK_FLAG_STYLES[flag]}`}>
                    {HIGH_RISK_FLAG_LABEL[flag]}
                  </span>
                )}
              </li>
            ))}
          </ListWidget>

          {/* Escalated cases */}
          <ListWidget widgetId="escalated-cases" testId="widget-escalated-cases">
            {focusedEscalatedCases.map(c => (
              <li key={c.id} className="py-2 first:pt-0 last:pb-0 border-b border-slate-100 last:border-0 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={`/owner/support-tools?caseId=${encodeURIComponent(c.id)}`} className="text-xs font-bold text-slate-800 hover:text-primary truncate block">{c.subject}</Link>
                  <p className="text-[11px] text-slate-500 truncate">
                    {tenantById.get(c.tenantId) || c.tenantId}
                    {c.escalationReason ? ` · ${c.escalationReason}` : ''}
                  </p>
                </div>
                <span className="shrink-0 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded-md border bg-red-500/10 text-red-700 border-red-500/30">
                  Escalated
                </span>
              </li>
            ))}
          </ListWidget>

          {/* Add-on / Commercial Attention */}
          <ListWidget widgetId="commercial-attention" testId="widget-commercial-attention">
            {commercialAttention.map(item => (
              <li key={item.id} className="py-2 first:pt-0 last:pb-0 border-b border-slate-100 last:border-0 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={item.href} className="text-xs font-bold text-slate-800 hover:text-primary truncate block">{item.label}</Link>
                  <p className={`text-[11px] truncate ${TONE_TEXT[item.tone]}`}>{item.sublabel}</p>
                </div>
                <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-slate-400">{item.kind}</span>
              </li>
            ))}
          </ListWidget>
        </div>
      </section>
      )}

      {/* ============== TENANT RISK HEATMAP + CORRELATED EPISODES (Phase 1.1.3B) ============== */}
      {viewPageGate.allowed && (
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4" data-testid="intelligence-grid">
        {/* Tenant risk heatmap */}
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-100">
            <h3 className="text-lg font-black text-primary tracking-tight">Tenant Risk Heatmap</h3>
            <p className="text-xs text-slate-500 font-medium">
              Tenants ranked by derived risk — escalations, SLA, audit, domain and commercial signals.
            </p>
          </div>
          <div className="p-5 grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="tenant-risk-heatmap">
            {tenantHealth.map(t => (
              <button
                key={t.tenantId}
                onClick={() => { if (viewTenant360Gate.allowed) onOpenTenant360(t.tenantId); }}
                disabled={!viewTenant360Gate.allowed}
                title={viewTenant360Gate.allowed ? t.recommendedAction : viewTenant360Gate.reason}
                data-testid={`heatmap-tile-${t.tenantId}`}
                className={`text-left p-3 rounded-2xl border-2 transition-all disabled:cursor-not-allowed disabled:opacity-70 hover:shadow-md ${RISK_STATUS_STYLES[t.tier]}`}
              >
                <p className="text-xs font-black text-slate-900 truncate">{t.tenantName}</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[9px] font-black uppercase tracking-widest">{RISK_STATUS_LABEL[t.tier]}</span>
                  <span className="text-[10px] font-bold text-slate-500">Score {t.score}</span>
                </div>
                <p className="text-[10px] text-slate-500 mt-1 truncate">
                  {t.reasons[0]?.label || 'No active signals'}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Correlated operational episodes */}
        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-100">
            <h3 className="text-lg font-black text-primary tracking-tight">Correlated Episodes</h3>
            <p className="text-xs text-slate-500 font-medium">{CORRELATION_TRUTH_LABEL}</p>
          </div>
          {correlatedGroups.length === 0 ? (
            <div className="p-10 text-center text-slate-400 text-sm font-bold" data-testid="correlated-episodes-empty">
              No correlated signal clusters right now.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="correlated-episodes">
              {correlatedGroups.slice(0, 6).map(g => (
                <li key={g.id} className="px-6 py-4" data-testid={`episode-${g.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{g.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{g.whyGrouped}</p>
                      <p className="text-[11px] text-slate-500 mt-1">{g.recommendedAction}</p>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${ATTENTION_PILL_STYLES[g.severity]}`}>
                        {ATTENTION_PRIORITY_LABEL[g.severity]}
                      </span>
                      <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${CONFIDENCE_PILL_STYLES[g.confidence]}`}>
                        {g.confidence}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {g.categories.map(c => (
                      <span key={c} className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[9px] font-black uppercase tracking-wide">
                        {SIGNAL_SOURCE_LABEL[c]}
                      </span>
                    ))}
                    <Link
                      to={g.href}
                      className="ml-auto text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-primary transition-colors"
                    >
                      Open {g.tenant ? 'tenant' : 'audit'} →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      )}

      {/* ============== NEXT BEST ACTIONS (Phase 1.1.2 — tiered) ============== */}
      {viewNbaGate.allowed && (
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Next Best Actions</h3>
            <p className="text-xs text-slate-500 font-medium">
              Deterministic rule-based recommendations
              <span className="ml-1 px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[9px] font-black uppercase tracking-widest">Rule-based · not AI</span>
              <span className="ml-2">Each action links to its source surface.</span>
            </p>
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            {filteredNba.length} of {enrichedNba.length} action{enrichedNba.length !== 1 ? 's' : ''}
          </span>
        </div>
        {/* Phase 1.1.3B — NBA filter chips (deterministic, by action type) */}
        <div className="px-8 py-3 border-b border-slate-100 flex items-center gap-2 flex-wrap" data-testid="nba-filters">
          {NBA_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => onNbaFilter(f.id)}
              data-testid={`nba-filter-${f.id}`}
              className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-xl border transition-colors ${
                nbaFilter === f.id
                  ? 'bg-primary text-white border-primary'
                  : 'bg-white text-slate-500 border-slate-200 hover:text-primary hover:border-primary/40'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {filteredNba.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm font-bold" data-testid="next-best-actions-empty">
            {enrichedNba.length === 0
              ? (focusMode === 'normal'
                  ? 'No recommended actions right now.'
                  : `No actions surface in ${FOCUS_MODE_LABEL[focusMode]} mode — try Normal to see all signals.`)
              : 'No actions match the active filter.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="next-best-actions">
            {filteredNba.slice(0, 12).map(action => {
              const tier = tierForPriority(action.priority);
              return (
                <li key={action.id} className="px-8 py-4 flex items-center justify-between gap-4 hover:bg-slate-50/70" data-testid={`nba-row-${action.id}`}>
                  <div className="flex items-start gap-3 min-w-0">
                    <span
                      data-testid={`nba-tier-${action.id}`}
                      title={`Tier ${NBA_TIER_LABEL[tier]} (priority: ${action.priority})`}
                      className={`shrink-0 inline-flex items-center justify-center w-9 h-9 text-xs font-black uppercase tracking-widest rounded-xl border-2 ${NBA_TIER_STYLES[tier]}`}
                    >
                      {NBA_TIER_LABEL[tier]}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{action.title}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {action.tenant ? `${action.tenant} · ` : ''}{action.reason}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[9px] font-black uppercase tracking-wide" data-testid={`nba-type-${action.id}`}>
                          {action.actionType}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wide border ${CONFIDENCE_PILL_STYLES[action.confidence]}`}>
                          {action.confidence}
                        </span>
                      </div>
                    </div>
                  </div>
                  {actNbaGate.allowed ? (
                  <Link to={action.href} className="shrink-0 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary transition-colors">
                    {action.ctaLabel}
                  </Link>
                  ) : (
                  <span className="shrink-0 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-slate-50 text-slate-400 border border-slate-100 rounded-xl cursor-not-allowed" title={actNbaGate.reason}>
                    {action.ctaLabel}
                  </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      )}

      {/* ============== QUICK ACTIONS (preserved) ============== */}
      {/* Section-level gate: hides the entire quick-action bar when
          use_command_quick_actions is None. Per-button checks remain as a
          defense-in-depth so destination feature permissions still apply. */}
      {useQuickActionsGate.allowed && (
      <div className="bg-white/80 backdrop-blur-xl p-4 rounded-[2rem] border border-slate-200 shadow-sm flex flex-wrap gap-2 items-center">
        <span className="px-3 py-1 text-[10px] font-black uppercase tracking-widest text-slate-400">
          Quick actions
        </span>
        {(() => {
          // Phase 1.1.3A correction — quick action visibility / interactivity
          // is gated by `use_command_quick_actions` plus the destination
          // feature's view permission. Disabled buttons keep the same
          // layout but show a tooltip explaining the gap.
          const gates = [
            { label: 'Create Support Case', path: '/owner/support-tools', target: 'create_support_case', highlight: true },
            { label: 'Open Audit & Security', path: '/owner/audit-security', target: 'view_audit_security', highlight: false },
            { label: 'Open Support Tools', path: '/owner/support-tools', target: 'view_support_tools', highlight: false },
            { label: 'Open Domains', path: '/owner/domains', target: 'view_domains', highlight: false },
            { label: 'Open Platform Settings', path: '/owner/platform-settings', target: 'view_platform_settings', highlight: false },
            { label: 'Open Team Management', path: '/owner/team-management', target: 'view_team', highlight: false },
          ];
          return gates.map(g => {
            const targetGate = hasPlatformPermission(sessionRole, g.target);
            const allowed = useQuickActionsGate.allowed && targetGate.allowed;
            const reason = !useQuickActionsGate.allowed ? useQuickActionsGate.reason : targetGate.reason;
            return (
              <QuickActionButton
                key={g.label}
                label={g.label}
                disabled={!allowed}
                title={allowed ? '' : reason}
                onClick={() => { if (allowed) onQuickAction(g.label, g.path); }}
                highlight={g.highlight}
              />
            );
          });
        })()}
      </div>
      )}

      {/* ============== NEEDS ATTENTION (preserved) ============== */}
      {viewNeedsAttentionGate.allowed && (
      <section
        data-testid="needs-attention-section"
        className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm"
      >
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Needs Attention</h3>
            <p className="text-xs text-slate-500 font-medium">
              Prioritized queue of items that require System Owner action.
              {focusMode !== 'normal' && (
                <span className="ml-2 text-slate-400">Filtered by focus mode: {FOCUS_MODE_LABEL[focusMode]}.</span>
              )}
            </p>
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            {pulseFilteredAttention.length} of {attention.length} item{attention.length !== 1 ? 's' : ''}
          </span>
        </div>
        {activePulseFilter && PULSE_ROUTING[activePulseFilter].filtersAttention && (
          <div
            data-testid="needs-attention-pulse-filter"
            className="px-8 py-3 bg-primary/5 border-b border-primary/10 flex items-center gap-3 flex-wrap"
          >
            <span className="text-[10px] font-black uppercase tracking-widest text-primary/70">Pulse filter active:</span>
            <span className="px-3 py-1 rounded-xl bg-white border border-primary/30 text-[11px] font-black text-primary">
              {PULSE_ROUTING[activePulseFilter].filterLabel}
            </span>
            <button
              onClick={onClearPulseFilter}
              className="ml-auto text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-primary transition-colors"
            >
              Clear filter ✕
            </button>
          </div>
        )}
        {pulseFilteredAttention.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm font-bold">
            {activePulseFilter ? 'No items match the active pulse filter.' : 'No active issues.'}
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Priority</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Type</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Title</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Reason</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Age</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {pulseFilteredAttention.slice(0, 20).map(item => (
                <tr key={item.id} data-testid={`needs-attention-row-${item.id}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5">
                    <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${PRIORITY_STYLES[item.priority]}`}>
                      {item.priority}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-700">{item.type}</td>
                  <td className="px-6 py-3.5 text-sm text-slate-600">
                    {item.tenant && item.tenantId ? (
                      <button
                        onClick={() => { if (viewTenant360Gate.allowed) onOpenTenant360(item.tenantId); }}
                        disabled={!viewTenant360Gate.allowed}
                        title={viewTenant360Gate.allowed ? '' : viewTenant360Gate.reason}
                        className="hover:text-primary hover:underline disabled:no-underline disabled:opacity-60 disabled:cursor-not-allowed"
                        data-testid={`tenant360-open-${item.tenantId}`}
                      >
                        {item.tenant}
                      </button>
                    ) : (item.tenant || '—')}
                  </td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900 max-w-[260px] truncate">{item.title}</td>
                  <td className="px-6 py-3.5 text-xs text-slate-500">{item.reason}</td>
                  <td className="px-6 py-3.5 text-xs text-slate-500 whitespace-nowrap">{formatRelative(item.age)}</td>
                  <td className="px-6 py-3.5 text-right">
                    <Link to={item.href} className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary transition-colors">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      )}

      {/* ============== TENANT RISK SUMMARY (preserved + Tenant 360 link) ============== */}
      {/* Section-level gate: tenant risk summary is page-overview content
          and contains tenant data. Visible when the operator has parent
          Command Center access OR has the explicit `view_tenant_360`
          child grant (the table is the primary Tenant 360 launchpad, so
          revealing it for that explicit child is required for the
          minimal Tenant 360 surface). Pre-QA correction. */}
      {(viewPageGate.allowed || viewTenant360Gate.allowed) && (
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Tenant Risk Summary</h3>
            <p className="text-xs text-slate-500 font-medium">
              Risk is derived from support, audit, and domain signals available in this system.{' '}
              {tenantsAtRisk.length > 0 && <span className="text-orange-600">{tenantsAtRisk.length} tenant(s) need attention.</span>}
            </p>
          </div>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Plan</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Risk</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Signals</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Open</th>
            </tr>
          </thead>
          <tbody>
            {tenantRisk
              .slice()
              .sort((a, b) => b.risk.score - a.risk.score)
              .slice(0, 8)
              .map(({ tenant, risk }) => (
                <tr key={tenant.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900">
                    <button
                      onClick={() => { if (viewTenant360Gate.allowed) onOpenTenant360(tenant.id); }}
                      disabled={!viewTenant360Gate.allowed}
                      title={viewTenant360Gate.allowed ? '' : viewTenant360Gate.reason}
                      className="hover:text-primary hover:underline"
                      data-testid={`tenant360-open-${tenant.id}-row`}
                    >
                      {tenant.name}
                    </button>
                  </td>
                  <td className="px-6 py-3.5 text-xs text-slate-500 uppercase font-bold">{tenant.plan}</td>
                  <td className="px-6 py-3.5 text-xs text-slate-500">{tenant.status}</td>
                  <td className="px-6 py-3.5">
                    <RiskBadge status={risk.status} />
                  </td>
                  <td className="px-6 py-3.5 text-xs text-slate-500">
                    {risk.signals.length === 0 ? (
                      <span className="text-slate-400">No active signals</span>
                    ) : (
                      risk.signals.join(' · ')
                    )}
                  </td>
                  <td className="px-6 py-3.5 text-right">
                    <Link to={`/owner/tenants/${tenant.id}`} className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary transition-colors">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      )}

      {/* ============== WORKFLOW HEALTH (preserved) ============== */}
      {/* Section-level gate: workflow health is page-overview content. */}
      {viewPageGate.allowed && (
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Workflow Health</h3>
            <p className="text-xs text-slate-500 font-medium">
              Operational workflow health — not infrastructure uptime monitoring.
            </p>
          </div>
        </div>
        <div className="p-6 grid grid-cols-2 md:grid-cols-3 gap-3">
          {workflowHealth.map(w => (
            <div key={w.label} className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{w.label}</p>
              <p className="text-2xl font-black text-primary mt-1">{w.value}</p>
            </div>
          ))}
        </div>
      </section>
      )}

      {/* ============== HOW RISK IS DERIVED (preserved) ============== */}
      {/* Section-level gate: explanatory legend lives with the page overview. */}
      {viewPageGate.allowed && (
      <section className="bg-white/60 backdrop-blur-xl rounded-2xl border border-slate-200 p-6">
        <h3 className="text-xs font-black text-primary uppercase tracking-widest mb-3">
          How risk &amp; flags are derived
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-600">
          <RiskRule
            label="High-risk audit flags"
            body="critical severity, security category, team role/permission/status changes, destructive actions, billing/payment activity, domain failed/disabled, and support escalations."
          />
          <RiskRule
            label="Tenant risk score"
            body="weighted sum of open / critical cases, failed / pending domains, recent warning + critical audit events. Healthy < 2 · Watch < 5 · At Risk < 8 · Critical ≥ 8."
          />
          <RiskRule
            label="SLA status"
            body="derived from each case's resolution due time and current status. Awaiting customer pauses the timer; resolved cases compare resolved time vs due time."
          />
        </div>
      </section>
      )}

      {/* ============== LEGEND ============== */}
      {/* Section-level gate: legend explains page-overview metrics. */}
      {viewPageGate.allowed && (
      <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest flex flex-wrap gap-3 items-center">
        <span>Legend:</span>
        {(['critical', 'high_risk', 'needs_review'] as Exclude<HighRiskFlag, null>[]).map(f => (
          <span key={f} className={`px-2 py-0.5 rounded-md border ${HIGH_RISK_FLAG_STYLES[f]}`}>
            {HIGH_RISK_FLAG_LABEL[f]}
          </span>
        ))}
        {(['on_track', 'at_risk', 'overdue', 'paused'] as const).map(s => (
          <span key={s} className={`px-2 py-0.5 rounded-md border ${SLA_STATUS_STYLES[s]}`}>
            SLA {SLA_STATUS_LABEL[s]}
          </span>
        ))}
      </div>
      )}

      {/* ============== TENANT 360 DRAWER ============== */}
      {tenant360 && (
        <Tenant360Drawer t={tenant360} onClose={onCloseTenant360} />
      )}

      {/* ============== COMMAND SIGNAL DRILLDOWN DRAWER (Phase 1.1.3B) ============== */}
      {commandDrawer && (
        <CommandSignalDrawer
          drawerId={commandDrawer}
          signals={drawerSignals}
          onClose={onCloseCommandDrawer}
        />
      )}
    </div>
  );
};

// --- Sub-components --------------------------------------------------------

// Phase 1.1.3B — intelligence ribbon card.
const RibbonCardView: React.FC<{ card: RibbonCard; onOpen?: () => void }> = ({ card, onOpen }) => {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-widest opacity-70">{card.label}</span>
        {card.trend && (
          <span className="text-[10px] font-black" title={`Trend vs last review: ${card.trend}`}>
            {card.trend === 'up' ? '▲' : card.trend === 'down' ? '▼' : '■'}
          </span>
        )}
      </div>
      <p className="text-2xl font-black mt-1 tabular-nums">{card.value}</p>
      <p className="text-[10px] font-medium opacity-70 mt-0.5 truncate">{card.reason}</p>
    </>
  );
  const cls = `block w-full text-left p-4 rounded-2xl border-2 transition-all ${RIBBON_TONE_STYLES[card.tone]}`;
  if (onOpen) {
    return (
      <button onClick={onOpen} data-testid={`ribbon-card-${card.id}`} className={`${cls} hover:shadow-md`}>
        {body}
      </button>
    );
  }
  return (
    <div data-testid={`ribbon-card-${card.id}`} className={cls}>
      {body}
    </div>
  );
};

// Phase 1.1.3B — command signal drilldown drawer.
const CommandSignalDrawer: React.FC<{
  drawerId: CommandDrawerId;
  signals: CommandSignal[];
  onClose: () => void;
}> = ({ drawerId, signals, onClose }) => (
  <div className="fixed inset-0 z-50 flex justify-end" data-testid="command-signal-drawer">
    <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
    <div className="relative w-full max-w-md bg-white shadow-2xl h-full overflow-y-auto">
      <div className="sticky top-0 bg-white/90 backdrop-blur-xl border-b border-slate-100 px-6 py-5 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-black text-primary tracking-tight">{COMMAND_DRAWER_LABEL[drawerId]}</h3>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {signals.length} signal{signals.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      {signals.length === 0 ? (
        <div className="p-10 text-center text-slate-400 text-sm font-bold">No active signals in this category.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {signals.map(s => (
            <li key={s.id} className="px-6 py-4" data-testid={`command-signal-${s.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{s.label}</p>
                  {s.tenant && <p className="text-xs text-slate-500 mt-0.5">{s.tenant}</p>}
                  <p className="text-[11px] text-slate-500 mt-1">{s.reason}</p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${ATTENTION_PILL_STYLES[s.priority]}`}>
                  {ATTENTION_PRIORITY_LABEL[s.priority]}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[9px] font-black uppercase tracking-wide">
                  {SIGNAL_SOURCE_LABEL[s.category]}
                </span>
                <Link to={s.href} className="ml-auto text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-primary transition-colors">
                  Open source →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  </div>
);

const ChipGroup: React.FC<{
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  testId?: string;
}> = ({ label, options, value, onChange, testId }) => (
  <div className="flex items-center gap-2 flex-wrap" data-testid={testId}>
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <div className="flex gap-1 p-1 bg-slate-100 rounded-xl border border-slate-200">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          data-testid={`${testId}-${o.value}`}
          className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-colors ${
            value === o.value
              ? 'bg-white text-primary shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  </div>
);

const PulseCard: React.FC<{
  metric: PulseMetric;
  active?: boolean;
  onClick?: () => void;
  actionHint?: string;
}> = ({ metric, active, onClick, actionHint }) => {
  const tone = metric.tone;
  const styles =
    tone === 'critical' ? 'border-red-500/30 bg-red-500/5'
    : tone === 'warn' ? 'border-orange-400/30 bg-orange-400/5'
    : tone === 'info' ? 'border-blue-400/30 bg-blue-400/5'
    : 'border-slate-200 bg-white';
  const numStyles =
    tone === 'critical' ? 'text-red-700'
    : tone === 'warn' ? 'text-orange-700'
    : tone === 'info' ? 'text-blue-700'
    : 'text-primary';
  const disabled = metric.value === 0;
  const activeRing = active ? 'ring-2 ring-primary/60 ring-offset-1 ring-offset-white' : '';
  const interactive = disabled
    ? 'cursor-default opacity-70'
    : 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition-all';
  const titleAttr = `${metric.hint}${actionHint ? ` · ${actionHint}` : ''}`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={titleAttr}
      aria-pressed={active}
      data-testid={`pulse-${metric.id}`}
      data-active={active ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      className={`text-left p-4 rounded-2xl border shadow-sm w-full focus:outline-none focus:ring-2 focus:ring-primary/30 ${styles} ${activeRing} ${interactive} disabled:cursor-not-allowed`}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{metric.label}</p>
        {active && (
          <span className="text-[9px] font-black uppercase tracking-widest text-primary bg-primary/10 px-1.5 py-0.5 rounded-md">
            On
          </span>
        )}
      </div>
      <p className={`text-2xl font-black ${numStyles} mt-1`}>{metric.value}</p>
      <p className="text-[10px] text-slate-500 mt-1 leading-tight line-clamp-2">{metric.hint}</p>
      {actionHint && (
        <p className={`mt-1.5 text-[9px] font-black uppercase tracking-widest ${disabled ? 'text-slate-300' : 'text-primary/70'}`}>
          {actionHint} {!disabled && '→'}
        </p>
      )}
    </button>
  );
};

// Phase 1.1.2 — small chip used by the Mission Control "what needs attention now" rollup.
const ROLLUP_TONE: Record<'info' | 'warn' | 'critical', string> = {
  info: 'bg-slate-100 text-slate-700 border-slate-200',
  warn: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
};
const RollupChip: React.FC<{ label: string; value: number; tone: 'info' | 'warn' | 'critical' }> = ({ label, value, tone }) => (
  <span
    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-black uppercase tracking-widest ${value > 0 ? ROLLUP_TONE[tone] : 'bg-slate-50 text-slate-400 border-slate-200'}`}
    title={`${label}: ${value}`}
    data-testid={`mission-rollup-${label.toLowerCase().replace(/\s+/g, '-')}`}
  >
    <span>{label}</span>
    <span className="font-black">{value}</span>
  </span>
);

// Phase 1.1.2 — DistributionWidget: now takes a widgetId and uses
// `WIDGET_META` for title/helper/empty + `bucketNavigateTo` so each bucket can
// deep-link to its filtered surface (e.g. severity → support queue, severity →
// audit lens). Header shows an "Open all" link when a navigateTo exists.
const DistributionWidget: React.FC<{
  widgetId: WidgetId;
  buckets: DistributionBucket[];
  testId: string;
}> = ({ widgetId, buckets, testId }) => {
  const meta = WIDGET_META[widgetId];
  const total = buckets.reduce((s, b) => s + b.value, 0);
  return (
    <div className="bg-white/80 backdrop-blur-xl rounded-3xl border border-slate-200 shadow-sm p-5" data-testid={testId}>
      <div className="flex items-start justify-between mb-2 gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-black text-primary tracking-tight">{meta.title}</h4>
          <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{meta.helper}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{total}</span>
          {meta.navigateTo && total > 0 && (
            <Link
              to={meta.navigateTo}
              data-testid={`${testId}-open-all`}
              className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline"
            >
              Open →
            </Link>
          )}
        </div>
      </div>
      {total === 0 ? (
        <p className="text-xs text-slate-400 italic mt-4" data-testid={`${testId}-empty`}>{meta.emptyMessage}</p>
      ) : (
        <ul className="space-y-2 mt-3">
          {buckets.map(b => {
            const pct = total ? Math.round((b.value / total) * 100) : 0;
            const navTo = b.value > 0 ? bucketNavigateTo(widgetId, b.key) : undefined;
            const inner = (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className={`font-bold ${TONE_TEXT[b.tone]}`}>{b.label}</span>
                  <span className="font-bold text-slate-700">{b.value} <span className="text-slate-400 font-medium">· {pct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full ${TONE_BAR[b.tone]} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
              </>
            );
            return (
              <li key={b.key} className="text-xs">
                {navTo ? (
                  <Link
                    to={navTo}
                    data-testid={`${testId}-bucket-${b.key}`}
                    className="block rounded-lg -mx-1 px-1 py-1 hover:bg-primary/5 transition-colors"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div data-testid={`${testId}-bucket-${b.key}`}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const ListWidget: React.FC<{
  widgetId: WidgetId;
  testId: string;
  children: React.ReactNode;
}> = ({ widgetId, testId, children }) => {
  const meta = WIDGET_META[widgetId];
  const arr = React.Children.toArray(children);
  return (
    <div className="bg-white/80 backdrop-blur-xl rounded-3xl border border-slate-200 shadow-sm p-5" data-testid={testId}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-black text-primary tracking-tight">{meta.title}</h4>
          <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{meta.helper}</p>
        </div>
        {meta.navigateTo && arr.length > 0 && (
          <Link
            to={meta.navigateTo}
            data-testid={`${testId}-open-all`}
            className="shrink-0 text-[10px] font-black uppercase tracking-widest text-primary hover:underline"
          >
            Open →
          </Link>
        )}
      </div>
      {arr.length === 0 ? (
        <p className="text-xs text-slate-400 italic" data-testid={`${testId}-empty`}>{meta.emptyMessage}</p>
      ) : (
        <ul className="text-xs">{children}</ul>
      )}
    </div>
  );
};

const Tenant360Drawer: React.FC<{ t: Tenant360Result; onClose: () => void }> = ({ t, onClose }) => (
  <div className="fixed inset-0 z-50 flex" data-testid="tenant360-drawer">
    <div className="flex-1 bg-slate-900/30 backdrop-blur-sm" onClick={onClose} />
    <div className="w-full max-w-xl bg-white shadow-2xl overflow-y-auto p-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Tenant 360</p>
          <h3 className="text-xl font-black text-primary tracking-tight mt-1">{t.tenantName}</h3>
          <p className="text-xs text-slate-500 mt-1">
            {t.plan && <>Plan: <span className="font-bold uppercase">{t.plan}</span> · </>}
            {t.status && <>Status: <span className="font-bold">{t.status}</span></>}
          </p>
        </div>
        <button
          onClick={onClose}
          data-testid="tenant360-close"
          className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 rounded-xl hover:bg-slate-200"
        >
          Close
        </button>
      </div>

      <div className="p-4 rounded-2xl border bg-slate-50">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Derived Risk</p>
        <div className="flex items-center gap-3 mt-2">
          <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${RISK_STATUS_STYLES[t.risk.status]}`}>
            {RISK_STATUS_LABEL[t.risk.status]}
          </span>
          <span className="text-xs text-slate-500">Score {t.risk.score}</span>
        </div>
        {t.risk.signals.length > 0 && (
          <p className="text-xs text-slate-600 mt-2">{t.risk.signals.join(' · ')}</p>
        )}
      </div>

      {/* Phase 1.1.3A correction — Active Escalations card for the tenant.
          Uses the same shared `isActiveEscalation` predicate (via
          `deriveTenant360.activeEscalations`) so the count + click-through
          here agree with Command Center's Escalated widget, Operational
          Pulse, Needs Attention, NBA, and Support Tools. Click-through
          opens the exact case in Support Tools. Rendered before Open
          Cases so escalations get visual priority. */}
      <Tenant360Block
        title={`Active Escalations (${t.activeEscalations.length})`}
        empty="No active escalations."
      >
        {t.activeEscalations.slice(0, 5).map(c => {
          const eff = effectiveEscalationStatus(c);
          return (
            <li
              key={c.id}
              className="py-2 border-b border-slate-100 last:border-0"
              data-testid={`tenant360-escalation-${c.id}`}
            >
              <Link
                to={`/owner/support-tools?caseId=${encodeURIComponent(c.id)}`}
                className="text-xs font-bold text-slate-800 hover:text-primary block truncate"
                data-testid={`tenant360-escalation-open-${c.id}`}
              >
                {c.subject}
              </Link>
              <p className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-1">
                <span className="px-1.5 py-0.5 rounded-md border bg-red-500/10 text-red-700 border-red-500/30 font-bold uppercase tracking-wide">
                  {ESCALATION_STATUS_LABEL[eff.status]}
                </span>
                {eff.level && (
                  <span className="px-1.5 py-0.5 rounded-md border bg-slate-100 text-slate-600 border-slate-200 font-bold uppercase tracking-wide">
                    {ESCALATION_LEVEL_LABEL[eff.level]}
                  </span>
                )}
                {c.escalationOwnerName ? (
                  <span>Owner: <span className="font-bold">{c.escalationOwnerName}</span></span>
                ) : c.escalationTargetTeam ? (
                  <span>Team: <span className="font-bold">{c.escalationTargetTeam}</span></span>
                ) : (
                  <span className="text-amber-700">Unassigned</span>
                )}
                {c.escalationReason && (
                  <span className="truncate">· {c.escalationReason}</span>
                )}
              </p>
            </li>
          );
        })}
      </Tenant360Block>

      <Tenant360Block title={`Open Cases (${t.openCases.length})`} empty="No open cases.">
        {t.openCases.slice(0, 5).map(c => {
          const sla = deriveSlaStatus(c);
          return (
            <li key={c.id} className="py-2 border-b border-slate-100 last:border-0">
              <Link to={`/owner/support-tools?caseId=${encodeURIComponent(c.id)}`} className="text-xs font-bold text-slate-800 hover:text-primary block truncate">{c.subject}</Link>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Severity: {c.severity} · <span className={`px-1.5 py-0.5 rounded-md border ${SLA_STATUS_STYLES[sla.status]}`}>SLA {SLA_STATUS_LABEL[sla.status]}</span>
                {isActiveEscalation(c) && <span className="ml-1 px-1.5 py-0.5 rounded-md border bg-red-500/10 text-red-700 border-red-500/30">Escalated</span>}
              </p>
            </li>
          );
        })}
      </Tenant360Block>

      {/* Phase 1.1.2 — render unconditionally so the truthful empty-state
          ("No SLA pressure.") shows when the tenant has none. */}
      <Tenant360Block title={`SLA Pressure (${t.overdueOrAtRiskCases.length})`} empty="No SLA pressure.">
        {t.overdueOrAtRiskCases.map(c => (
          <li key={c.id} className="py-1.5 border-b border-slate-100 last:border-0 text-xs text-slate-600 truncate">{c.subject} — {deriveSlaStatus(c).label}</li>
        ))}
      </Tenant360Block>

      <Tenant360Block title={`Recent Audit Events (${t.recentAudits.length})`} empty="No recent audit events.">
        {t.recentAudits.map(a => {
          const flag = deriveHighRiskFlag(a).flag;
          return (
            <li key={a.id} className="py-1.5 border-b border-slate-100 last:border-0 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-700 truncate">{a.action}</span>
              {flag && (
                <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-black uppercase rounded-md border ${HIGH_RISK_FLAG_STYLES[flag]}`}>
                  {HIGH_RISK_FLAG_LABEL[flag]}
                </span>
              )}
            </li>
          );
        })}
      </Tenant360Block>

      <Tenant360Block title={`Domain Issues (${t.domainIssues.length})`} empty="No domain issues.">
        {t.domainIssues.map(d => (
          <li key={d.id} className="py-1.5 border-b border-slate-100 last:border-0 text-xs text-slate-600 flex items-center justify-between gap-2">
            <span className="truncate">{d.hostname}</span>
            <span className="shrink-0 text-[10px] font-bold text-slate-500 uppercase">{d.status} · SSL {d.ssl}</span>
          </li>
        ))}
      </Tenant360Block>

      {/* Phase 1.1.2 — Quick Links: jump straight to filtered Audit + Support
          for this tenant so the operator does not page-hop. */}
      <div className="pt-4 border-t border-slate-100" data-testid="tenant360-quick-links">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Quick Links</p>
        <div className="grid grid-cols-2 gap-2">
          <Link
            to={`/owner/audit-security?tenant=${encodeURIComponent(t.tenantId)}`}
            onClick={onClose}
            className="text-center px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-white text-slate-700 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary hover:border-primary/30 transition-colors"
          >
            Audit (this tenant)
          </Link>
          <Link
            to={`/owner/support-tools?tenant=${encodeURIComponent(t.tenantId)}`}
            onClick={onClose}
            className="text-center px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-white text-slate-700 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary hover:border-primary/30 transition-colors"
          >
            Support (this tenant)
          </Link>
        </div>
        <Link
          to={`/owner/tenants/${t.tenantId}`}
          onClick={onClose}
          className="block mt-2 w-full text-center px-4 py-2.5 text-xs font-black uppercase tracking-widest bg-primary text-white rounded-xl hover:bg-primary/90"
        >
          Open full tenant page
        </Link>
      </div>
      <p className="text-[10px] text-slate-400 text-center">{PHASE_112_TRUTH_LABEL}</p>
    </div>
  </div>
);

const Tenant360Block: React.FC<{ title: string; empty: string; children: React.ReactNode }> = ({ title, empty, children }) => {
  const arr = React.Children.toArray(children);
  return (
    <div>
      <h4 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-2">{title}</h4>
      {arr.length === 0 ? (
        <p className="text-xs text-slate-400 italic">{empty}</p>
      ) : (
        <ul className="bg-slate-50 rounded-2xl border border-slate-200 px-4 py-2">{children}</ul>
      )}
    </div>
  );
};

const QuickActionButton: React.FC<{ label: string; onClick: () => void; highlight?: boolean; disabled?: boolean; title?: string }> = ({ label, onClick, highlight, disabled, title }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed ${highlight ? 'bg-primary text-white shadow-md hover:bg-primary/90' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
  >
    {label}
  </button>
);

const RiskBadge: React.FC<{ status: RiskStatus }> = ({ status }) => (
  <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${RISK_STATUS_STYLES[status]}`}>
    {RISK_STATUS_LABEL[status]}
  </span>
);

const RiskRule: React.FC<{ label: string; body: string }> = ({ label, body }) => (
  <div>
    <p className="font-black text-slate-700">{label}</p>
    <p className="text-slate-500 mt-1 leading-relaxed">{body}</p>
  </div>
);

export default CommandCenterPage;
