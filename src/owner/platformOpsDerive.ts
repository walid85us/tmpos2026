// Phase 1.1 — Shared derivation helpers for the Platform Operations &
// Security command-center, audit, and support workstreams.
//
// All helpers are pure, deterministic, and do not perform IO. They are
// the single source of truth for:
//   - high-risk audit event classification
//   - tenant risk scoring (Healthy / Watch / At Risk / Critical)
//   - SLA status derivation (on_track / at_risk / overdue / met / missed
//     / paused / unknown)
//   - predefined saved views (audit + support)
//   - CSV export safe-field whitelist + download
//
// These helpers must not log PII. Risk is *derived* from existing
// signals — never invented. SLA dates come from seeded mock data only;
// no real time-based enforcement happens anywhere.

import type {
  SupportCaseRecord,
  SupportCaseSeverity,
  SupportCaseStatus,
} from './mockData';

export type RiskStatus = 'healthy' | 'watch' | 'at_risk' | 'critical';
export type SlaStatus =
  | 'on_track'
  | 'at_risk'
  | 'overdue'
  | 'met'
  | 'missed'
  | 'paused'
  | 'unknown';
export type HighRiskFlag = null | 'critical' | 'high_risk' | 'needs_review';

export interface AuditEventLike {
  id: string;
  date: string;
  action: string;
  actor: string;
  target: string;
  severity: string;
  category?: string;
  tenantId?: string | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
}

// --- HIGH-RISK FLAG --------------------------------------------------------

export function deriveHighRiskFlag(event: AuditEventLike): {
  flag: HighRiskFlag;
  reasons: string[];
} {
  const reasons: string[] = [];
  const sev = (event.severity || '').toLowerCase();
  const cat = (event.category || '').toLowerCase();
  const action = (event.action || '').toLowerCase();

  if (sev === 'critical') reasons.push('Critical severity');
  if (cat === 'security') reasons.push('Security category');
  if (cat === 'team' && /(role|permission|status)/.test(action))
    reasons.push('Platform team role / permission / status change');
  if (/(archive|delete|block)/.test(action))
    reasons.push('Destructive action (archive / delete / block)');
  if (cat === 'billing' && /(failed|activation|payment|charge)/.test(action))
    reasons.push('Billing / payment activity');
  if (cat === 'domains' && /(failed|disabled)/.test(action))
    reasons.push('Domain failed / disabled');
  if (cat === 'support' && /(escalated|critical)/.test(action))
    reasons.push('Support escalation');

  if (sev === 'critical') return { flag: 'critical', reasons };
  if (reasons.length >= 2) return { flag: 'high_risk', reasons };
  if (reasons.length === 1) return { flag: 'needs_review', reasons };
  if (sev === 'warning') return { flag: 'needs_review', reasons: ['Warning severity'] };
  return { flag: null, reasons: [] };
}

export const HIGH_RISK_FLAG_LABEL: Record<Exclude<HighRiskFlag, null>, string> = {
  critical: 'Critical',
  high_risk: 'High Risk',
  needs_review: 'Needs Review',
};

export const HIGH_RISK_FLAG_STYLES: Record<Exclude<HighRiskFlag, null>, string> = {
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
  high_risk: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  needs_review: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
};

// --- TENANT RISK -----------------------------------------------------------

export interface TenantRiskInputs {
  audits: AuditEventLike[];
  cases: Pick<SupportCaseRecord, 'tenantId' | 'status' | 'severity'>[];
  domains: { tenantId: string; status: string; ssl: string }[];
}

export function deriveTenantRisk(
  tenantId: string,
  input: TenantRiskInputs
): { status: RiskStatus; score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  const openCases = input.cases.filter(
    c => c.tenantId === tenantId && c.status !== 'resolved' && c.status !== 'closed'
  );
  const criticalCases = openCases.filter(c => c.severity === 'urgent' || c.severity === 'high');
  if (openCases.length) {
    score += openCases.length;
    signals.push(`${openCases.length} open case${openCases.length > 1 ? 's' : ''}`);
  }
  if (criticalCases.length) {
    score += criticalCases.length * 2;
    signals.push(`${criticalCases.length} high / urgent case${criticalCases.length > 1 ? 's' : ''}`);
  }

  const tenantDomainList = input.domains.filter(d => d.tenantId === tenantId);
  const failed = tenantDomainList.filter(d => d.status === 'failed').length;
  const pending = tenantDomainList.filter(
    d => d.status === 'pending' || d.status === 'verifying'
  ).length;
  if (failed) {
    score += failed * 3;
    signals.push(`${failed} failed domain${failed > 1 ? 's' : ''}`);
  }
  if (pending) {
    score += pending;
    signals.push(`${pending} pending domain${pending > 1 ? 's' : ''}`);
  }

  const tenantAudits = input.audits.filter(a => a.tenantId === tenantId);
  const recentWarn = tenantAudits.filter(a => (a.severity || '').toLowerCase() === 'warning').length;
  const recentCrit = tenantAudits.filter(a => (a.severity || '').toLowerCase() === 'critical').length;
  if (recentCrit) {
    score += recentCrit * 4;
    signals.push(`${recentCrit} recent critical event${recentCrit > 1 ? 's' : ''}`);
  }
  if (recentWarn) {
    score += recentWarn;
    signals.push(`${recentWarn} recent warning${recentWarn > 1 ? 's' : ''}`);
  }

  const status: RiskStatus =
    score >= 8 ? 'critical' : score >= 5 ? 'at_risk' : score >= 2 ? 'watch' : 'healthy';
  return { status, score, signals };
}

export const RISK_STATUS_LABEL: Record<RiskStatus, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At Risk',
  critical: 'Critical',
};

export const RISK_STATUS_STYLES: Record<RiskStatus, string> = {
  healthy: 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
  watch: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  at_risk: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
};

// --- SLA -------------------------------------------------------------------

export interface SlaCaseLike {
  status: SupportCaseStatus;
  firstResponseDueAt?: string | null;
  resolutionDueAt?: string | null;
  firstRespondedAt?: string | null;
  resolvedAt?: string | null;
}

export function deriveSlaStatus(
  c: SlaCaseLike,
  now: Date = new Date()
): { status: SlaStatus; label: string } {
  const due = c.resolutionDueAt ? new Date(c.resolutionDueAt) : null;
  if (!due || isNaN(due.getTime())) return { status: 'unknown', label: 'No SLA' };

  if (c.status === 'resolved' || c.status === 'closed') {
    const resolvedAt = c.resolvedAt ? new Date(c.resolvedAt) : null;
    if (!resolvedAt || isNaN(resolvedAt.getTime()))
      return { status: 'unknown', label: 'No resolution time' };
    return resolvedAt <= due
      ? { status: 'met', label: 'SLA met' }
      : { status: 'missed', label: 'SLA missed' };
  }
  if (c.status === 'waiting_customer')
    return { status: 'paused', label: 'Paused — awaiting customer' };

  const diffMs = due.getTime() - now.getTime();
  const hours = diffMs / 36e5;
  if (hours < 0) return { status: 'overdue', label: `Overdue by ${formatDuration(-hours)}` };
  if (hours <= 8) return { status: 'at_risk', label: `Due in ${formatDuration(hours)}` };
  return { status: 'on_track', label: `Due in ${formatDuration(hours)}` };
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export const SLA_STATUS_LABEL: Record<SlaStatus, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  overdue: 'Overdue',
  met: 'Met',
  missed: 'Missed',
  paused: 'Paused',
  unknown: 'Unknown',
};

export const SLA_STATUS_STYLES: Record<SlaStatus, string> = {
  on_track: 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
  at_risk: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  overdue: 'bg-red-500/10 text-red-700 border-red-500/30',
  met: 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
  missed: 'bg-red-500/10 text-red-700 border-red-500/30',
  paused: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
};

// --- SAVED VIEWS -----------------------------------------------------------

export interface AuditViewFilters {
  severity?: 'all' | 'info' | 'notice' | 'warning' | 'critical';
  category?: 'all' | string;
  highRiskOnly?: boolean;
}

export interface SupportViewFilters {
  status?: 'all' | SupportCaseStatus | 'open_group' | 'resolved_group';
  severity?: 'all' | SupportCaseSeverity;
  sla?: 'any' | 'overdue' | 'at_risk';
  sort?: 'updated_desc' | 'opened_desc';
}

export interface SavedView<F> {
  id: string;
  label: string;
  filters: F;
}

export const predefinedAuditViews: SavedView<AuditViewFilters>[] = [
  { id: 'all', label: 'All Events', filters: {} },
  { id: 'critical_warning', label: 'Critical / Warning', filters: { severity: 'critical' } },
  { id: 'high_risk', label: 'High-Risk Only', filters: { highRiskOnly: true } },
  { id: 'support', label: 'Support Activity', filters: { category: 'support' } },
  { id: 'domains', label: 'Domain Activity', filters: { category: 'domains' } },
  { id: 'team', label: 'Team Management', filters: { category: 'team' } },
  { id: 'configuration', label: 'Platform Settings', filters: { category: 'configuration' } },
  { id: 'security', label: 'Security Notes', filters: { category: 'security' } },
  { id: 'billing', label: 'Billing / Invoice', filters: { category: 'billing' } },
  { id: 'addon', label: 'Add-on Governance', filters: { category: 'addon' } },
];

export const predefinedSupportViews: SavedView<SupportViewFilters>[] = [
  { id: 'all_open', label: 'All Open', filters: { status: 'open_group' } },
  { id: 'critical', label: 'Critical', filters: { severity: 'urgent' } },
  { id: 'overdue', label: 'Overdue', filters: { sla: 'overdue' } },
  { id: 'waiting_customer', label: 'Waiting Customer', filters: { status: 'waiting_customer' } },
  { id: 'recent', label: 'Recently Updated', filters: { sort: 'updated_desc' } },
  { id: 'resolved', label: 'Resolved / Closed', filters: { status: 'resolved_group' } },
];

// --- CSV -------------------------------------------------------------------

// Whitelist of audit fields that are safe to export. Notes/payloads are
// included but secrets, raw payloads, and server-only fields are not.
export const AUDIT_CSV_COLUMNS = [
  'timestamp',
  'severity',
  'category',
  'action',
  'actor',
  'tenant',
  'target',
  'flag',
  'note',
] as const;

export function toCsv(
  rows: Record<string, unknown>[],
  columns: ReadonlyArray<string>
): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.join(',');
  const body = rows.map(r => columns.map(c => escape(r[c])).join(',')).join('\n');
  return `${header}\n${body}`;
}

export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined') return;
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* noop — download is best-effort in non-browser contexts */
  }
}

// ===========================================================================
// Phase 1.1.1 — Mission Control derivations
// ===========================================================================
// All helpers below are pure, deterministic, and rule-based. There is no AI,
// no live infrastructure check, no external network call. Their only inputs
// are the same in-memory snapshots the rest of Phase 1.1 already uses.

// --- TIME RANGE / FOCUS MODE ----------------------------------------------

export type TimeRange = 'today' | '7d' | '30d' | 'all';
export type FocusMode = 'normal' | 'watch' | 'incident';

export const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  all: 'All',
};

export const FOCUS_MODE_LABEL: Record<FocusMode, string> = {
  normal: 'Normal',
  watch: 'Watch',
  incident: 'Incident Review',
};

export const FOCUS_MODE_DESCRIPTION: Record<FocusMode, string> = {
  normal: 'Show all operational signals.',
  watch: 'Prioritize medium-and-up severity, at-risk SLAs, and warnings.',
  incident: 'Critical, overdue, escalated, failed, and high-risk only.',
};

function rangeStartMs(range: TimeRange, now: Date = new Date()): number | null {
  if (range === 'all') return null;
  const ms = now.getTime();
  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (range === '7d') return ms - 7 * 24 * 36e5;
  if (range === '30d') return ms - 30 * 24 * 36e5;
  return null;
}

export function filterByTimeRange<T extends { date?: string; createdAt?: string; openedAt?: string }>(
  rows: T[],
  range: TimeRange,
  now: Date = new Date()
): T[] {
  const start = rangeStartMs(range, now);
  if (start === null) return rows;
  return rows.filter(r => {
    const stamp = r.date || r.createdAt || r.openedAt;
    if (!stamp) return true; // keep rows we can't classify rather than silently drop
    const t = new Date(stamp).getTime();
    if (isNaN(t)) return true;
    return t >= start;
  });
}

// --- OVERALL PLATFORM STATE -----------------------------------------------

export type PlatformState = 'healthy' | 'watch' | 'at_risk' | 'critical';

export const PLATFORM_STATE_LABEL: Record<PlatformState, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At Risk',
  critical: 'Critical',
};

export const PLATFORM_STATE_STYLES: Record<PlatformState, string> = {
  healthy: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  watch: 'bg-blue-500/10 text-blue-700 border-blue-500/30',
  at_risk: 'bg-orange-500/10 text-orange-700 border-orange-500/30',
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
};

export interface PlatformStateInputs {
  cases: SupportCaseRecord[];
  audits: AuditEventLike[];
  domains: { status: string; ssl: string }[];
  now?: Date;
}

export function deriveOverallPlatformState(input: PlatformStateInputs): {
  state: PlatformState;
  summary: string;
  signals: string[];
} {
  const now = input.now || new Date();
  const openCases = input.cases.filter(c => c.status !== 'resolved' && c.status !== 'closed');
  const criticalOpen = openCases.filter(c => c.severity === 'urgent');
  const overdue = openCases.filter(c => deriveSlaStatus(c, now).status === 'overdue');
  const atRisk = openCases.filter(c => deriveSlaStatus(c, now).status === 'at_risk');
  const escalated = openCases.filter(c => c.escalated === true);
  const criticalAudits = input.audits.filter(a => deriveHighRiskFlag(a).flag === 'critical').length;
  const failedDomains = input.domains.filter(d => d.status === 'failed').length;
  const warningAudits = input.audits.filter(a => (a.severity || '').toLowerCase() === 'warning').length;

  const signals: string[] = [];
  if (criticalOpen.length) signals.push(`${criticalOpen.length} critical support case${criticalOpen.length > 1 ? 's' : ''}`);
  if (overdue.length) signals.push(`${overdue.length} overdue SLA case${overdue.length > 1 ? 's' : ''}`);
  if (escalated.length) signals.push(`${escalated.length} escalated case${escalated.length > 1 ? 's' : ''}`);
  if (criticalAudits) signals.push(`${criticalAudits} critical audit event${criticalAudits > 1 ? 's' : ''}`);
  if (failedDomains) signals.push(`${failedDomains} failed domain${failedDomains > 1 ? 's' : ''}`);
  if (atRisk.length) signals.push(`${atRisk.length} SLA at-risk case${atRisk.length > 1 ? 's' : ''}`);
  if (warningAudits) signals.push(`${warningAudits} warning audit event${warningAudits > 1 ? 's' : ''}`);

  let state: PlatformState = 'healthy';
  if (criticalOpen.some(c => deriveSlaStatus(c, now).status === 'overdue') || criticalAudits > 0) {
    state = 'critical';
  } else if (overdue.length || failedDomains || escalated.length) {
    state = 'at_risk';
  } else if (atRisk.length || warningAudits) {
    state = 'watch';
  }

  const summary =
    state === 'critical'
      ? 'Critical signals are active. Triage now.'
      : state === 'at_risk'
        ? 'Operational risk is elevated. Review the queue.'
        : state === 'watch'
          ? 'Some workflows need a closer look.'
          : 'No active risk signals — operations look clean.';

  return { state, summary, signals };
}

// --- FOCUS MODE FILTER -----------------------------------------------------

export function filterByFocusMode(
  attention: { priority: 'critical' | 'high' | 'medium' | 'low' }[],
  mode: FocusMode
): typeof attention {
  if (mode === 'normal') return attention;
  if (mode === 'watch') return attention.filter(a => a.priority !== 'low');
  return attention.filter(a => a.priority === 'critical' || a.priority === 'high');
}

// --- OPERATIONAL PULSE -----------------------------------------------------

export interface PulseInputs {
  cases: SupportCaseRecord[];
  audits: AuditEventLike[];
  domains: { status: string; ssl: string }[];
  tenantRisks: { status: RiskStatus }[];
  attentionCount: number;
  now?: Date;
}

export interface PulseMetric {
  id:
    | 'open_cases'
    | 'overdue_sla'
    | 'escalated'
    | 'high_risk_audits'
    | 'domain_issues'
    | 'tenants_at_risk'
    | 'pending_actions';
  label: string;
  value: number;
  hint: string;
  tone: 'ok' | 'info' | 'warn' | 'critical';
}

export function deriveOperationalPulse(input: PulseInputs): PulseMetric[] {
  const now = input.now || new Date();
  const openCases = input.cases.filter(c => c.status !== 'resolved' && c.status !== 'closed');
  const overdue = openCases.filter(c => deriveSlaStatus(c, now).status === 'overdue').length;
  const escalated = openCases.filter(c => c.escalated === true).length;
  const highRisk = input.audits.filter(a => {
    const f = deriveHighRiskFlag(a).flag;
    return f === 'critical' || f === 'high_risk';
  }).length;
  const domainIssues = input.domains.filter(d =>
    d.status === 'failed' || d.status === 'pending' || d.status === 'verifying'
  ).length;
  const tenantsAtRisk = input.tenantRisks.filter(r => r.status === 'at_risk' || r.status === 'critical').length;

  return [
    { id: 'open_cases', label: 'Open Cases', value: openCases.length, hint: 'Support cases not yet resolved or closed.', tone: openCases.length > 0 ? 'info' : 'ok' },
    { id: 'overdue_sla', label: 'Overdue SLA', value: overdue, hint: 'Open cases past their resolution due time.', tone: overdue > 0 ? 'critical' : 'ok' },
    { id: 'escalated', label: 'Escalated', value: escalated, hint: 'Open cases manually escalated by an operator.', tone: escalated > 0 ? 'warn' : 'ok' },
    { id: 'high_risk_audits', label: 'High-Risk Audits', value: highRisk, hint: 'Audit events flagged critical or high-risk by the rule engine.', tone: highRisk > 5 ? 'critical' : highRisk > 0 ? 'warn' : 'ok' },
    { id: 'domain_issues', label: 'Domain Issues', value: domainIssues, hint: 'Domains failed, pending, or verifying. Verification is manual.', tone: domainIssues > 0 ? 'warn' : 'ok' },
    { id: 'tenants_at_risk', label: 'Tenants At Risk', value: tenantsAtRisk, hint: 'Tenants whose derived risk is At Risk or Critical.', tone: tenantsAtRisk > 0 ? 'warn' : 'ok' },
    { id: 'pending_actions', label: 'Pending Actions', value: input.attentionCount, hint: 'Total items in the Needs Attention queue.', tone: input.attentionCount > 5 ? 'warn' : input.attentionCount > 0 ? 'info' : 'ok' },
  ];
}

// --- WIDGET DISTRIBUTIONS --------------------------------------------------

export interface DistributionBucket {
  key: string;
  label: string;
  value: number;
  tone: 'ok' | 'info' | 'warn' | 'critical' | 'muted';
}

export interface WidgetDistributions {
  casesBySeverity: DistributionBucket[];
  slaPressure: DistributionBucket[];
  tenantRisk: DistributionBucket[];
  auditsBySeverity: DistributionBucket[];
  domainsByStatus: DistributionBucket[];
}

export function deriveWidgetDistributions(input: {
  cases: SupportCaseRecord[];
  audits: AuditEventLike[];
  domains: { status: string }[];
  tenantRisks: { status: RiskStatus }[];
  now?: Date;
}): WidgetDistributions {
  const now = input.now || new Date();
  const openCases = input.cases.filter(c => c.status !== 'resolved' && c.status !== 'closed');

  const casesBySeverity: DistributionBucket[] = [
    { key: 'low', label: 'Low', value: openCases.filter(c => c.severity === 'low').length, tone: 'muted' },
    { key: 'normal', label: 'Normal', value: openCases.filter(c => c.severity === 'normal').length, tone: 'info' },
    { key: 'high', label: 'High', value: openCases.filter(c => c.severity === 'high').length, tone: 'warn' },
    { key: 'urgent', label: 'Urgent', value: openCases.filter(c => c.severity === 'urgent').length, tone: 'critical' },
  ];

  const slaCounts: Record<SlaStatus, number> = {
    on_track: 0, at_risk: 0, overdue: 0, met: 0, missed: 0, paused: 0, unknown: 0,
  };
  input.cases.forEach(c => { slaCounts[deriveSlaStatus(c, now).status]++; });
  const slaPressure: DistributionBucket[] = [
    { key: 'on_track', label: 'On track', value: slaCounts.on_track, tone: 'ok' },
    { key: 'at_risk', label: 'At risk', value: slaCounts.at_risk, tone: 'warn' },
    { key: 'overdue', label: 'Overdue', value: slaCounts.overdue, tone: 'critical' },
    { key: 'paused', label: 'Paused', value: slaCounts.paused, tone: 'info' },
    { key: 'met', label: 'Met', value: slaCounts.met, tone: 'ok' },
    { key: 'missed', label: 'Missed', value: slaCounts.missed, tone: 'critical' },
    { key: 'unknown', label: 'Unknown', value: slaCounts.unknown, tone: 'muted' },
  ];

  const tenantRisk: DistributionBucket[] = [
    { key: 'healthy', label: 'Healthy', value: input.tenantRisks.filter(r => r.status === 'healthy').length, tone: 'ok' },
    { key: 'watch', label: 'Watch', value: input.tenantRisks.filter(r => r.status === 'watch').length, tone: 'info' },
    { key: 'at_risk', label: 'At Risk', value: input.tenantRisks.filter(r => r.status === 'at_risk').length, tone: 'warn' },
    { key: 'critical', label: 'Critical', value: input.tenantRisks.filter(r => r.status === 'critical').length, tone: 'critical' },
  ];

  const sevCount = (sev: string) => input.audits.filter(a => (a.severity || '').toLowerCase() === sev).length;
  const auditsBySeverity: DistributionBucket[] = [
    { key: 'info', label: 'Info', value: sevCount('info'), tone: 'muted' },
    { key: 'notice', label: 'Notice', value: sevCount('notice'), tone: 'info' },
    { key: 'warning', label: 'Warning', value: sevCount('warning'), tone: 'warn' },
    { key: 'critical', label: 'Critical', value: sevCount('critical'), tone: 'critical' },
  ];

  const domainCount = (status: string) => input.domains.filter(d => d.status === status).length;
  const domainsByStatus: DistributionBucket[] = [
    { key: 'pending', label: 'Pending', value: domainCount('pending'), tone: 'info' },
    { key: 'verifying', label: 'Verifying', value: domainCount('verifying'), tone: 'info' },
    { key: 'verified', label: 'Verified', value: domainCount('verified'), tone: 'ok' },
    { key: 'failed', label: 'Failed', value: domainCount('failed'), tone: 'critical' },
    { key: 'disabled', label: 'Disabled', value: domainCount('disabled'), tone: 'muted' },
  ];

  return { casesBySeverity, slaPressure, tenantRisk, auditsBySeverity, domainsByStatus };
}

// --- NEXT BEST ACTIONS -----------------------------------------------------

export type NbaPriority = 'critical' | 'high' | 'medium' | 'low';

export interface NextBestAction {
  id: string;
  priority: NbaPriority;
  title: string;
  reason: string;
  tenant: string | null;
  ctaLabel: string;
  href: string;
}

export interface NbaInputs {
  cases: SupportCaseRecord[];
  audits: AuditEventLike[];
  domains: { id: string; tenantId: string; hostname: string; status: string }[];
  tenantRisks: { tenantId: string; tenantName: string; status: RiskStatus; signals: string[] }[];
  notes: { id: string; body: string }[];
  tenantNameById: Map<string, string>;
  now?: Date;
}

export function deriveNextBestActions(input: NbaInputs): NextBestAction[] {
  const now = input.now || new Date();
  const out: NextBestAction[] = [];
  const openCases = input.cases.filter(c => c.status !== 'resolved' && c.status !== 'closed');

  // 1) Critical overdue support cases first.
  openCases
    .filter(c => c.severity === 'urgent' && deriveSlaStatus(c, now).status === 'overdue')
    .forEach(c => out.push({
      id: `nba_co_${c.id}`,
      priority: 'critical',
      title: `Resolve overdue urgent case · ${c.subject}`,
      reason: 'Urgent case past resolution SLA.',
      tenant: input.tenantNameById.get(c.tenantId) || c.tenantId,
      ctaLabel: 'Open case',
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    }));

  // 2) Active escalated cases.
  openCases
    .filter(c => c.escalated === true)
    .forEach(c => out.push({
      id: `nba_es_${c.id}`,
      priority: c.severity === 'urgent' ? 'critical' : 'high',
      title: `Review escalated case · ${c.subject}`,
      reason: c.escalationReason ? `Escalated: ${c.escalationReason}` : 'Manually escalated.',
      tenant: input.tenantNameById.get(c.tenantId) || c.tenantId,
      ctaLabel: 'Open case',
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    }));

  // 3) Critical or high-risk audit events.
  input.audits.slice(0, 25).forEach(a => {
    const flag = deriveHighRiskFlag(a).flag;
    if (flag !== 'critical' && flag !== 'high_risk') return;
    out.push({
      id: `nba_au_${a.id}`,
      priority: flag === 'critical' ? 'critical' : 'high',
      title: `Investigate audit event · ${a.action}`,
      reason: `${a.target}${a.severity ? ` · ${a.severity}` : ''}`,
      tenant: a.tenantId ? (input.tenantNameById.get(a.tenantId) || a.tenantId) : null,
      ctaLabel: 'Open audit',
      href: '/owner/audit-security',
    });
  });

  // 4) Failed domains.
  input.domains.filter(d => d.status === 'failed').forEach(d => out.push({
    id: `nba_dm_${d.id}`,
    priority: 'high',
    title: `Verify failed domain · ${d.hostname}`,
    reason: 'Verification failed. Domain operations are manual.',
    tenant: input.tenantNameById.get(d.tenantId) || d.tenantId,
    ctaLabel: 'Open domains',
    href: '/owner/domains',
  }));

  // 5) At-risk SLAs (not already overdue / urgent).
  openCases
    .filter(c => c.severity !== 'urgent' && deriveSlaStatus(c, now).status === 'at_risk')
    .slice(0, 10)
    .forEach(c => out.push({
      id: `nba_ar_${c.id}`,
      priority: 'medium',
      title: `Triage SLA-at-risk case · ${c.subject}`,
      reason: deriveSlaStatus(c, now).label,
      tenant: input.tenantNameById.get(c.tenantId) || c.tenantId,
      ctaLabel: 'Open case',
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    }));

  // 6) Tenant risk watch items.
  input.tenantRisks
    .filter(t => t.status === 'critical' || t.status === 'at_risk')
    .slice(0, 10)
    .forEach(t => out.push({
      id: `nba_tr_${t.tenantId}`,
      priority: t.status === 'critical' ? 'high' : 'medium',
      title: `Review tenant · ${t.tenantName}`,
      reason: t.signals.slice(0, 2).join(' · ') || 'Elevated derived risk.',
      tenant: t.tenantName,
      ctaLabel: 'Open tenant',
      href: `/owner/tenants/${t.tenantId}`,
    }));

  // 7) Unresolved security notes (newest first, capped).
  input.notes.slice(0, 5).forEach(n => out.push({
    id: `nba_sn_${n.id}`,
    priority: 'low',
    title: `Review security note`,
    reason: n.body.length > 100 ? `${n.body.slice(0, 100)}…` : n.body,
    tenant: null,
    ctaLabel: 'Open audit & security',
    href: '/owner/audit-security',
  }));

  const order: Record<NbaPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => order[a.priority] - order[b.priority]);
}

// --- TENANT 360 ------------------------------------------------------------

export interface Tenant360Inputs {
  tenantId: string;
  tenantName: string;
  plan?: string;
  status?: string;
  cases: SupportCaseRecord[];
  audits: AuditEventLike[];
  domains: { id: string; tenantId: string; hostname: string; status: string; ssl: string }[];
  notes: { id: string; body: string }[];
  now?: Date;
}

export interface Tenant360Result {
  tenantId: string;
  tenantName: string;
  plan?: string;
  status?: string;
  risk: { status: RiskStatus; score: number; signals: string[] };
  openCases: SupportCaseRecord[];
  overdueOrAtRiskCases: SupportCaseRecord[];
  recentAudits: AuditEventLike[];
  domainIssues: { id: string; hostname: string; status: string; ssl: string }[];
  notesPreview: { id: string; body: string }[];
}

// --- FOCUS MODE — SOURCE-LEVEL FILTERS (Phase 1.1.1 UX Correction) ---------
//
// `filterByFocusMode` (above) only narrows the Needs Attention queue.
// To make Focus Mode visibly affect widget distributions, the Pulse strip,
// and child widgets, we also need to narrow the source slices that feed
// those derivations. These helpers do so without mutating inputs and
// remain pure / deterministic.

export function applyFocusModeToCases(
  cases: SupportCaseRecord[],
  mode: FocusMode,
  now: Date = new Date()
): SupportCaseRecord[] {
  if (mode === 'normal') return cases;
  if (mode === 'watch') {
    // Watch — only open / in-progress / waiting that have any signal.
    return cases.filter(c => {
      if (c.status === 'resolved' || c.status === 'closed') return false;
      if (c.severity === 'low') return false;
      return true;
    });
  }
  // Incident Review — urgent OR overdue OR escalated, open only.
  return cases.filter(c => {
    if (c.status === 'resolved' || c.status === 'closed') return false;
    if (c.severity === 'urgent') return true;
    if (c.escalated === true) return true;
    if (deriveSlaStatus(c, now).status === 'overdue') return true;
    return false;
  });
}

export function applyFocusModeToAudits(
  audits: AuditEventLike[],
  mode: FocusMode
): AuditEventLike[] {
  if (mode === 'normal') return audits;
  if (mode === 'watch') {
    return audits.filter(a => {
      const sev = (a.severity || '').toLowerCase();
      if (sev === 'warning' || sev === 'critical' || sev === 'notice') return true;
      const flag = deriveHighRiskFlag(a).flag;
      return flag === 'critical' || flag === 'high_risk' || flag === 'needs_review';
    });
  }
  // Incident Review — critical + warning OR critical/high-risk flag only.
  return audits.filter(a => {
    const sev = (a.severity || '').toLowerCase();
    if (sev === 'critical' || sev === 'warning') return true;
    const flag = deriveHighRiskFlag(a).flag;
    return flag === 'critical' || flag === 'high_risk';
  });
}

export function applyFocusModeToDomains<
  T extends { status: string; ssl?: string }
>(domains: T[], mode: FocusMode): T[] {
  if (mode === 'normal') return domains;
  if (mode === 'watch') {
    return domains.filter(d =>
      d.status === 'failed' ||
      d.status === 'pending' ||
      d.status === 'verifying' ||
      (d.status === 'verified' && d.ssl !== undefined && d.ssl !== 'active')
    );
  }
  // Incident Review — failed only.
  return domains.filter(d => d.status === 'failed');
}

// --- PULSE ROUTING (Phase 1.1.1 UX Correction) -----------------------------
//
// Each pulse metric maps to either a navigation target or an in-place
// "filter Needs Attention" action. Mission Control consumes this map to
// make pulse cards interactive without hard-coding routes inline.

export type PulseFilterId = PulseMetric['id'];

export interface PulseRouting {
  // If non-empty, clicking the pulse navigates to this route.
  navigateTo?: string;
  // Short label shown in the active-filter chip when this pulse filters
  // Needs Attention in place.
  filterLabel: string;
  // When provided, Mission Control filters the Needs Attention queue
  // using this predicate instead of (or in addition to) navigating.
  filtersAttention?: (item: {
    type: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
  }) => boolean;
}

export const PULSE_ROUTING: Record<PulseFilterId, PulseRouting> = {
  open_cases: {
    navigateTo: '/owner/support-tools',
    filterLabel: 'Open cases',
  },
  overdue_sla: {
    filterLabel: 'Overdue SLA',
    filtersAttention: it => it.type === 'Overdue support case',
  },
  escalated: {
    filterLabel: 'Escalated cases',
    filtersAttention: it => it.type === 'Escalated support case',
  },
  high_risk_audits: {
    navigateTo: '/owner/audit-security',
    filterLabel: 'High-risk audits',
    filtersAttention: it => it.type === 'High-risk audit event',
  },
  domain_issues: {
    navigateTo: '/owner/domains',
    filterLabel: 'Domain issues',
    filtersAttention: it =>
      it.type === 'Failed domain verification' ||
      it.type === 'Pending domain verification',
  },
  tenants_at_risk: {
    filterLabel: 'At-risk tenants',
    filtersAttention: it =>
      it.priority === 'critical' || it.priority === 'high',
  },
  pending_actions: {
    filterLabel: 'All pending actions',
    filtersAttention: () => true,
  },
};

export function deriveTenant360(input: Tenant360Inputs): Tenant360Result {
  const now = input.now || new Date();
  const tenantCases = input.cases.filter(c => c.tenantId === input.tenantId);
  const openCases = tenantCases.filter(c => c.status !== 'resolved' && c.status !== 'closed');
  const overdueOrAtRiskCases = openCases.filter(c => {
    const s = deriveSlaStatus(c, now).status;
    return s === 'overdue' || s === 'at_risk';
  });
  const recentAudits = input.audits.filter(a => a.tenantId === input.tenantId).slice(0, 8);
  const tenantDomainsForCard = input.domains.filter(d => d.tenantId === input.tenantId);
  const domainIssues = tenantDomainsForCard
    .filter(d => d.status === 'failed' || d.status === 'pending' || d.status === 'verifying' || (d.status === 'verified' && d.ssl !== 'active'))
    .map(d => ({ id: d.id, hostname: d.hostname, status: d.status, ssl: d.ssl }));
  const risk = deriveTenantRisk(input.tenantId, {
    audits: input.audits,
    cases: input.cases,
    domains: input.domains,
  });
  return {
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    plan: input.plan,
    status: input.status,
    risk,
    openCases,
    overdueOrAtRiskCases,
    recentAudits,
    domainIssues,
    notesPreview: input.notes.slice(0, 3),
  };
}
