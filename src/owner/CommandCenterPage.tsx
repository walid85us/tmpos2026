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
} from './platformOpsDerive';
import { pushPlatformAudit } from './platformOpsAudit';

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
  const tenantRisk = useMemo(
    () => tenants.map(t => ({
      tenant: t,
      risk: deriveTenantRisk(t.id, { audits: filteredAudits, cases: filteredCases, domains }),
    })),
    [filteredAudits, filteredCases, domains]
  );
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
      cases: filteredCases, audits: filteredAudits, domains,
      tenantRisks: tenantRisk.map(t => ({ status: t.risk.status })),
      attentionCount: attention.length,
    }),
    [filteredCases, filteredAudits, domains, tenantRisk, attention.length]
  );
  const widgets = useMemo(
    () => deriveWidgetDistributions({
      cases: filteredCases, audits: filteredAudits, domains,
      tenantRisks: tenantRisk.map(t => ({ status: t.risk.status })),
    }),
    [filteredCases, filteredAudits, domains, tenantRisk]
  );
  const nba: NextBestAction[] = useMemo(
    () => deriveNextBestActions({
      cases: filteredCases, audits: filteredAudits, domains,
      tenantRisks: tenantRisk.map(t => ({
        tenantId: t.tenant.id, tenantName: t.tenant.name,
        status: t.risk.status, signals: t.risk.signals,
      })),
      notes,
      tenantNameById: tenantById,
    }),
    [filteredCases, filteredAudits, domains, tenantRisk, notes, tenantById]
  );

  // High-risk audit stream + escalated cases for compact widgets
  const highRiskStream = useMemo(
    () => filteredAudits
      .map(a => ({ a, flag: deriveHighRiskFlag(a).flag }))
      .filter(x => x.flag === 'critical' || x.flag === 'high_risk')
      .slice(0, 5),
    [filteredAudits]
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
      {/* ============== MISSION CONTROL HEADER ============== */}
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 shadow-sm p-6 lg:p-8 space-y-5">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-start gap-4">
            <div className={`px-4 py-2 rounded-2xl border ${PLATFORM_STATE_STYLES[overall.state]} text-xs font-black uppercase tracking-widest`} data-testid="mission-control-state">
              {PLATFORM_STATE_LABEL[overall.state]}
            </div>
            <div>
              <h2 className="text-2xl font-black text-primary tracking-tight">Mission Control</h2>
              <p className="text-sm text-slate-600 font-medium mt-0.5">{overall.summary}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Updated {formatRelative(lastRefreshed.toISOString())}
            </span>
            <button
              onClick={onRefresh}
              data-testid="mission-control-refresh"
              className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-primary text-white rounded-xl hover:bg-primary/90 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {overall.signals.length > 0 && (
          <div className="text-xs text-slate-600">
            <span className="font-black uppercase tracking-widest text-[10px] text-slate-400 mr-2">Active signals:</span>
            {overall.signals.join(' · ')}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-6">
          <ChipGroup
            testId="mission-control-time-range"
            label="Time range"
            options={(['today', '7d', '30d', 'all'] as TimeRange[]).map(r => ({ value: r, label: TIME_RANGE_LABEL[r] }))}
            value={timeRange}
            onChange={v => onTimeRange(v as TimeRange)}
          />
          <ChipGroup
            testId="mission-control-focus-mode"
            label="Focus mode"
            options={(['normal', 'watch', 'incident'] as FocusMode[]).map(m => ({ value: m, label: FOCUS_MODE_LABEL[m] }))}
            value={focusMode}
            onChange={v => onFocus(v as FocusMode)}
          />
        </div>
        <p className="text-[11px] font-medium text-slate-500">
          {FOCUS_MODE_DESCRIPTION[focusMode]}{' '}
          <span className="text-slate-400">
            All values are derived from in-session signals — no live infrastructure or AI.
          </span>
        </p>
      </section>

      {/* ============== OPERATIONAL PULSE STRIP ============== */}
      <section className="space-y-3">
        <h3 className="text-sm font-black text-primary uppercase tracking-widest">Operational Pulse</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3" data-testid="operational-pulse">
          {pulse.map(m => (
            <PulseCard key={m.id} metric={m} />
          ))}
        </div>
      </section>

      {/* ============== WIDGET GRID (8 widgets) ============== */}
      <section className="space-y-3">
        <h3 className="text-sm font-black text-primary uppercase tracking-widest">Operational Widgets</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <DistributionWidget title="Cases by Severity" hint="Open support cases grouped by severity." buckets={widgets.casesBySeverity} testId="widget-cases-by-severity" />
          <DistributionWidget title="SLA Pressure" hint="Derived from each case's resolution due time." buckets={widgets.slaPressure} testId="widget-sla-pressure" />
          <DistributionWidget title="Tenant Risk Distribution" hint="Tenants by derived risk band." buckets={widgets.tenantRisk} testId="widget-tenant-risk" />
          <DistributionWidget title="Audit by Severity" hint={`Audit events in ${TIME_RANGE_LABEL[timeRange].toLowerCase()}.`} buckets={widgets.auditsBySeverity} testId="widget-audit-by-severity" />
          <DistributionWidget title="Domain Snapshot" hint="Current domain status counts." buckets={widgets.domainsByStatus} testId="widget-domain-snapshot" />

          {/* High-risk audit stream */}
          <ListWidget
            title="High-Risk Stream"
            hint="Audit events flagged critical or high-risk."
            empty="No high-risk events in range."
            testId="widget-high-risk-stream"
          >
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
          <ListWidget
            title="Escalated Cases"
            hint="Open cases manually escalated by an operator."
            empty="No escalated cases."
            testId="widget-escalated-cases"
          >
            {escalatedCases.slice(0, 5).map(c => (
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
          <ListWidget
            title="Add-on / Commercial Attention"
            hint="Non-active activations + billing-related cases."
            empty="No commercial issues to review."
            testId="widget-commercial-attention"
          >
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

      {/* ============== NEXT BEST ACTIONS ============== */}
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Next Best Actions</h3>
            <p className="text-xs text-slate-500 font-medium">
              Deterministic rule-based recommendations — no AI. Each action links to its source surface.
            </p>
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            {nba.length} action{nba.length !== 1 ? 's' : ''}
          </span>
        </div>
        {nba.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm font-bold">No recommended actions right now.</div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="next-best-actions">
            {nba.slice(0, 12).map(action => (
              <li key={action.id} className="px-8 py-4 flex items-center justify-between gap-4 hover:bg-slate-50/70">
                <div className="flex items-start gap-3 min-w-0">
                  <span className={`shrink-0 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${PRIORITY_STYLES[action.priority]}`}>
                    {action.priority}
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
            ))}
          </ul>
        )}
      </section>

      {/* ============== QUICK ACTIONS (preserved) ============== */}
      <div className="bg-white/80 backdrop-blur-xl p-4 rounded-[2rem] border border-slate-200 shadow-sm flex flex-wrap gap-2 items-center">
        <span className="px-3 py-1 text-[10px] font-black uppercase tracking-widest text-slate-400">
          Quick actions
        </span>
        <QuickActionButton label="Create Support Case" onClick={() => onQuickAction('Create Support Case', '/owner/support-tools')} highlight />
        <QuickActionButton label="Open Audit & Security" onClick={() => onQuickAction('Open Audit & Security', '/owner/audit-security')} />
        <QuickActionButton label="Open Support Tools" onClick={() => onQuickAction('Open Support Tools', '/owner/support-tools')} />
        <QuickActionButton label="Open Domains" onClick={() => onQuickAction('Open Domains', '/owner/domains')} />
        <QuickActionButton label="Open Platform Settings" onClick={() => onQuickAction('Open Platform Settings', '/owner/platform-settings')} />
        <QuickActionButton label="Open Team Management" onClick={() => onQuickAction('Open Team Management', '/owner/team-management')} />
      </div>

      {/* ============== NEEDS ATTENTION (preserved) ============== */}
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
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
            {focusedAttention.length} of {attention.length} item{attention.length !== 1 ? 's' : ''}
          </span>
        </div>
        {focusedAttention.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm font-bold">No active issues.</div>
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
              {focusedAttention.slice(0, 20).map(item => (
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
                        onClick={() => onOpenTenant360(item.tenantId)}
                        className="hover:text-primary hover:underline"
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
                      onClick={() => onOpenTenant360(tenant.id)}
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

const PulseCard: React.FC<{ metric: PulseMetric }> = ({ metric }) => {
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
  return (
    <div className={`p-4 rounded-2xl border shadow-sm ${styles}`} title={metric.hint} data-testid={`pulse-${metric.id}`}>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{metric.label}</p>
      <p className={`text-2xl font-black ${numStyles} mt-1`}>{metric.value}</p>
      <p className="text-[10px] text-slate-500 mt-1 leading-tight">{metric.hint}</p>
    </div>
  );
};

const DistributionWidget: React.FC<{
  title: string;
  hint: string;
  buckets: DistributionBucket[];
  testId: string;
}> = ({ title, hint, buckets, testId }) => {
  const total = buckets.reduce((s, b) => s + b.value, 0);
  return (
    <div className="bg-white/80 backdrop-blur-xl rounded-3xl border border-slate-200 shadow-sm p-5" data-testid={testId}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <h4 className="text-sm font-black text-primary tracking-tight">{title}</h4>
          <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>
        </div>
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{total}</span>
      </div>
      {total === 0 ? (
        <p className="text-xs text-slate-400 italic mt-4">No data in range.</p>
      ) : (
        <ul className="space-y-2 mt-3">
          {buckets.map(b => {
            const pct = total ? Math.round((b.value / total) * 100) : 0;
            return (
              <li key={b.key} className="text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className={`font-bold ${TONE_TEXT[b.tone]}`}>{b.label}</span>
                  <span className="font-bold text-slate-700">{b.value} <span className="text-slate-400 font-medium">· {pct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full ${TONE_BAR[b.tone]} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const ListWidget: React.FC<{
  title: string;
  hint: string;
  empty: string;
  testId: string;
  children: React.ReactNode;
}> = ({ title, hint, empty, testId, children }) => {
  const arr = React.Children.toArray(children);
  return (
    <div className="bg-white/80 backdrop-blur-xl rounded-3xl border border-slate-200 shadow-sm p-5" data-testid={testId}>
      <div className="mb-3">
        <h4 className="text-sm font-black text-primary tracking-tight">{title}</h4>
        <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>
      </div>
      {arr.length === 0 ? (
        <p className="text-xs text-slate-400 italic">{empty}</p>
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

      {t.overdueOrAtRiskCases.length > 0 && (
        <Tenant360Block title={`SLA Pressure (${t.overdueOrAtRiskCases.length})`} empty="No SLA pressure.">
          {t.overdueOrAtRiskCases.map(c => (
            <li key={c.id} className="py-1.5 border-b border-slate-100 last:border-0 text-xs text-slate-600 truncate">{c.subject} — {deriveSlaStatus(c).label}</li>
          ))}
        </Tenant360Block>
      )}

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

      <div className="pt-4 border-t border-slate-100">
        <Link
          to={`/owner/tenants/${t.tenantId}`}
          onClick={onClose}
          className="inline-block w-full text-center px-4 py-2.5 text-xs font-black uppercase tracking-widest bg-primary text-white rounded-xl hover:bg-primary/90"
        >
          Open full tenant page
        </Link>
      </div>
      <p className="text-[10px] text-slate-400 text-center">All values are derived in-session — not live.</p>
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

const QuickActionButton: React.FC<{ label: string; onClick: () => void; highlight?: boolean }> = ({ label, onClick, highlight }) => (
  <button
    onClick={onClick}
    className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${highlight ? 'bg-primary text-white shadow-md hover:bg-primary/90' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
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
