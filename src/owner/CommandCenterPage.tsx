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
  isEscalationAckOverdue,
  isEscalationCritical,
  ESCALATION_STATUS_LABEL,
  ESCALATION_LEVEL_LABEL,
  PHASE_113A_TRUTH_LABEL,
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
  const viewTenant360Gate = hasPlatformPermission(sessionRole, 'view_tenant_360');
  const useQuickActionsGate = hasPlatformPermission(sessionRole, 'use_command_quick_actions');
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
  const escalatedCases = openCases.filter(c => c.escalated === true);
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
  const alreadyQueuedCaseIds = new Set<string>([
    ...criticalCases.map(c => c.id),
    ...overdueCases.map(c => c.id),
  ]);
  escalatedCases.forEach(c => {
    if (alreadyQueuedCaseIds.has(c.id)) return;
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
    alreadyQueuedCaseIds.add(c.id);
  });

  // Phase 1.1.3A — structured escalation lifecycle attention items.
  // Each is a distinct lifecycle defect (unack / overdue ack / critical
  // / no owner / SLA breached). Items are pushed in addition to the
  // legacy "Escalated support case" entry so operators see the
  // *reason* the escalation needs hands-on attention.
  openCases.forEach(c => {
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
        href: '/owner/audit-security',
      });
    } else if (flag === 'high_risk') {
      attention.push({
        id: `ae_${a.id}`, priority: 'high', type: 'High-risk audit event',
        tenantId: a.tenantId || null,
        tenant: a.tenantId ? tenantById.get(a.tenantId) || a.tenantId : null,
        title: a.action, reason: `${a.target}`, age: a.date,
        href: '/owner/audit-security',
      });
    }
  });
  domains.forEach(d => {
    if (d.status === 'failed') {
      attention.push({
        id: `df_${d.id}`, priority: 'high', type: 'Failed domain verification',
        tenantId: d.tenantId, tenant: tenantById.get(d.tenantId) || d.tenantId,
        title: d.hostname, reason: 'Verification failed', age: d.createdAt,
        href: '/owner/domains',
      });
    } else if (d.status === 'pending' || d.status === 'verifying') {
      attention.push({
        id: `dp_${d.id}`, priority: 'medium', type: 'Pending domain verification',
        tenantId: d.tenantId, tenant: tenantById.get(d.tenantId) || d.tenantId,
        title: d.hostname, reason: `Status: ${d.status}`, age: d.createdAt,
        href: '/owner/domains',
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
    () => focusedCases.filter(c => c.escalated === true).slice(0, 5),
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

  return (
    <div className="space-y-8">
      {/* ============== MISSION CONTROL HEADER (Phase 1.1.1 UX Correction) ============== */}
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
                  <RollupChip label="Escalated" value={focusedCases.filter(c => c.escalated === true && c.status !== 'resolved' && c.status !== 'closed').length} tone="critical" />
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

      {/* ============== OPERATIONAL PULSE STRIP ============== */}
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

      {/* ============== WIDGET GRID (8 widgets) ============== */}
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
                  <p className="text-xs font-bold text-slate-800 truncate">{a.action}</p>
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

      {/* ============== NEXT BEST ACTIONS (Phase 1.1.2 — tiered) ============== */}
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
            {nba.length} action{nba.length !== 1 ? 's' : ''}
          </span>
        </div>
        {nba.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm font-bold" data-testid="next-best-actions-empty">
            {focusMode === 'normal'
              ? 'No recommended actions right now.'
              : `No actions surface in ${FOCUS_MODE_LABEL[focusMode]} mode — try Normal to see all signals.`}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="next-best-actions">
            {nba.slice(0, 12).map(action => {
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
                    </div>
                  </div>
                  <Link to={action.href} className="shrink-0 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary transition-colors">
                    {action.ctaLabel}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ============== QUICK ACTIONS (preserved) ============== */}
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

      {/* ============== NEEDS ATTENTION (preserved) ============== */}
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

      {/* ============== TENANT RISK SUMMARY (preserved + Tenant 360 link) ============== */}
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

      {/* ============== WORKFLOW HEALTH (preserved) ============== */}
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

      {/* ============== HOW RISK IS DERIVED (preserved) ============== */}
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

      {/* ============== LEGEND ============== */}
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

      {/* ============== TENANT 360 DRAWER ============== */}
      {tenant360 && (
        <Tenant360Drawer t={tenant360} onClose={onCloseTenant360} />
      )}
    </div>
  );
};

// --- Sub-components --------------------------------------------------------

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

      <Tenant360Block title={`Open Cases (${t.openCases.length})`} empty="No open cases.">
        {t.openCases.slice(0, 5).map(c => {
          const sla = deriveSlaStatus(c);
          return (
            <li key={c.id} className="py-2 border-b border-slate-100 last:border-0">
              <Link to={`/owner/support-tools?caseId=${encodeURIComponent(c.id)}`} className="text-xs font-bold text-slate-800 hover:text-primary block truncate">{c.subject}</Link>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Severity: {c.severity} · <span className={`px-1.5 py-0.5 rounded-md border ${SLA_STATUS_STYLES[sla.status]}`}>SLA {SLA_STATUS_LABEL[sla.status]}</span>
                {c.escalated && <span className="ml-1 px-1.5 py-0.5 rounded-md border bg-red-500/10 text-red-700 border-red-500/30">Escalated</span>}
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
