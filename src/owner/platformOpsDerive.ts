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
  // Phase 1.1.3A — match audit rows whose `action` starts with this
  // prefix. Used by the new "Escalation Lifecycle" saved view to
  // capture every support_case_escalat* action id.
  actionPrefix?: string;
}

export interface SupportViewFilters {
  status?: 'all' | SupportCaseStatus | 'open_group' | 'resolved_group';
  severity?: 'all' | SupportCaseSeverity;
  sla?: 'any' | 'overdue' | 'at_risk';
  sort?: 'updated_desc' | 'opened_desc';
  // Phase 1.1.3A — escalation queue tokens. Active escalations are
  // status in {escalated, acknowledged, in_review}. "overdue_ack" requires
  // status='escalated' AND now > acknowledgementDueAt. "mine"/"team" rely
  // on the optional ctx passed to countCasesForSupportView /
  // applyEscalationFilter.
  escalation?:
    | 'active'
    | 'unacknowledged'
    | 'overdue_ack'
    | 'critical'
    | 'unassigned'
    | 'deescalated'
    | 'resolved'
    | 'mine'
    | 'team';
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
  // Phase 1.1.3A — escalation lifecycle saved view. Filters audit
  // events by the support escalation action ids (legacy + new).
  { id: 'escalation_lifecycle', label: 'Escalation Lifecycle', filters: { actionPrefix: 'support_case_escalat' } },
];

export const predefinedSupportViews: SavedView<SupportViewFilters>[] = [
  { id: 'all_open', label: 'All Open', filters: { status: 'open_group' } },
  { id: 'critical', label: 'Critical', filters: { severity: 'urgent' } },
  { id: 'overdue', label: 'Overdue', filters: { sla: 'overdue' } },
  { id: 'waiting_customer', label: 'Waiting Customer', filters: { status: 'waiting_customer' } },
  { id: 'recent', label: 'Recently Updated', filters: { sort: 'updated_desc' } },
  { id: 'resolved', label: 'Resolved / Closed', filters: { status: 'resolved_group' } },
  // Phase 1.1.3A — escalation queues. All purely advisory; "mine"/"team"
  // resolve against the in-app advisory operator/team context (no real
  // RBAC). Counts come from countCasesForSupportView.
  { id: 'esc_active', label: 'Escalated Active', filters: { escalation: 'active' } },
  { id: 'esc_unack', label: 'Unacknowledged Escalations', filters: { escalation: 'unacknowledged' } },
  { id: 'esc_overdue_ack', label: 'Escalation Ack Overdue', filters: { escalation: 'overdue_ack' } },
  { id: 'esc_critical', label: 'Critical Escalations', filters: { escalation: 'critical' } },
  { id: 'esc_mine', label: 'Assigned to Me', filters: { escalation: 'mine' } },
  { id: 'esc_team', label: 'Assigned to My Team', filters: { escalation: 'team' } },
  { id: 'esc_unassigned', label: 'Unassigned Escalations', filters: { escalation: 'unassigned' } },
  { id: 'esc_deescalated', label: 'De-escalated', filters: { escalation: 'deescalated' } },
  { id: 'esc_resolved', label: 'Escalation Resolved', filters: { escalation: 'resolved' } },
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
  const escalated = openCases.filter(c => isActiveEscalation(c));
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
    | 'pending_actions'
    // Phase 1.1.3A — escalation lifecycle pulse cells (additive). The
    // legacy `escalated` cell is preserved unchanged for back-compat;
    // these add visibility into unacknowledged / overdue-ack /
    // unassigned escalations so operators can route work.
    | 'unacknowledged_escalations'
    | 'overdue_ack'
    | 'unassigned_escalations';
  label: string;
  value: number;
  hint: string;
  tone: 'ok' | 'info' | 'warn' | 'critical';
}

export function deriveOperationalPulse(input: PulseInputs): PulseMetric[] {
  const now = input.now || new Date();
  const openCases = input.cases.filter(c => c.status !== 'resolved' && c.status !== 'closed');
  const overdue = openCases.filter(c => deriveSlaStatus(c, now).status === 'overdue').length;
  const escalated = openCases.filter(c => isActiveEscalation(c)).length;
  // Phase 1.1.3A — escalation lifecycle counters. We use the
  // effectiveEscalationStatus helper so legacy `escalated:true` cases
  // (no structured status yet) still count, then sub-segment by
  // unacknowledged / overdue-ack / unassigned.
  const activeEscalations = openCases.filter(c => effectiveEscalationStatus(c).active);
  const unacknowledgedEscalations = activeEscalations.filter(
    c => effectiveEscalationStatus(c).status === 'escalated'
  ).length;
  const overdueAck = activeEscalations.filter(c => isEscalationAckOverdue(c, now)).length;
  const unassignedEscalations = activeEscalations.filter(
    c => !((c.escalationOwnerName || '').trim())
  ).length;
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
    // Phase 1.1.3A — additive escalation pulse cells.
    { id: 'unacknowledged_escalations', label: 'Unacked Escalations', value: unacknowledgedEscalations, hint: 'Active escalations not yet acknowledged by an operator.', tone: unacknowledgedEscalations > 0 ? 'warn' : 'ok' },
    { id: 'overdue_ack', label: 'Overdue Ack', value: overdueAck, hint: 'Active escalations past their acknowledgement-due time.', tone: overdueAck > 0 ? 'critical' : 'ok' },
    { id: 'unassigned_escalations', label: 'Unassigned Escalations', value: unassignedEscalations, hint: 'Active escalations without an assigned owner.', tone: unassignedEscalations > 0 ? 'warn' : 'ok' },
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
    .filter(c => isActiveEscalation(c))
    .forEach(c => out.push({
      id: `nba_es_${c.id}`,
      priority: c.severity === 'urgent' ? 'critical' : 'high',
      title: `Review escalated case · ${c.subject}`,
      reason: c.escalationReason ? `Escalated: ${c.escalationReason}` : 'Manually escalated.',
      tenant: input.tenantNameById.get(c.tenantId) || c.tenantId,
      ctaLabel: 'Open case',
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    }));

  // Phase 1.1.3A — escalation lifecycle NBAs (additive). Each rule
  // surfaces a structured escalation gap operators should close. None
  // duplicate the existing #2 rule above because they target a more
  // specific lifecycle defect (no owner / unacknowledged / ack overdue
  // / critical level / SLA breach concurrent / level mismatch).
  openCases.forEach(c => {
    const eff = effectiveEscalationStatus(c);
    if (!eff.active) return;
    const ackOverdue = isEscalationAckOverdue(c, now);
    const critical = isEscalationCritical(c);
    const owner = (c.escalationOwnerName || '').trim();
    const sla = deriveSlaStatus(c, now).status;
    const tenant = input.tenantNameById.get(c.tenantId) || c.tenantId;
    const href = `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`;
    // a) Ack overdue — critical priority.
    if (ackOverdue) {
      out.push({
        id: `nba_eack_${c.id}`,
        priority: 'critical',
        title: `Acknowledge overdue escalation · ${c.subject}`,
        reason: 'Escalation past its acknowledgement-due time.',
        tenant,
        ctaLabel: 'Open case',
        href,
      });
    }
    // b) Unacknowledged but not yet overdue.
    else if (eff.status === 'escalated') {
      out.push({
        id: `nba_eunack_${c.id}`,
        priority: critical ? 'critical' : 'high',
        title: `Acknowledge escalation · ${c.subject}`,
        reason: critical ? 'Critical escalation awaiting acknowledgement.' : 'Escalation awaiting acknowledgement.',
        tenant,
        ctaLabel: 'Open case',
        href,
      });
    }
    // c) Active escalation with no owner.
    if (!owner) {
      out.push({
        id: `nba_enown_${c.id}`,
        priority: critical ? 'high' : 'medium',
        title: `Assign owner for escalation · ${c.subject}`,
        reason: 'Active escalation without an assigned owner.',
        tenant,
        ctaLabel: 'Open case',
        href,
      });
    }
    // d) Critical-level escalation — emphasize review.
    if (critical && eff.status !== 'in_review') {
      out.push({
        id: `nba_ecrit_${c.id}`,
        priority: 'critical',
        title: `Review critical escalation · ${c.subject}`,
        reason: `Level: ${c.escalationLevel || 'urgent'}. Critical lifecycle review required.`,
        tenant,
        ctaLabel: 'Open case',
        href,
      });
    }
    // e) Active escalation that is also SLA-overdue.
    if (sla === 'overdue') {
      out.push({
        id: `nba_eslad_${c.id}`,
        priority: 'critical',
        title: `Resolve SLA-breached escalation · ${c.subject}`,
        reason: 'Active escalation past resolution SLA.',
        tenant,
        ctaLabel: 'Open case',
        href,
      });
    }
    // f) Acknowledged but stalled (no resolution after 48h).
    if (eff.status === 'acknowledged' && c.acknowledgedAt) {
      const ackedMs = new Date(c.acknowledgedAt).getTime();
      if (Number.isFinite(ackedMs) && now.getTime() - ackedMs > 48 * 36e5) {
        out.push({
          id: `nba_estall_${c.id}`,
          priority: 'high',
          title: `Drive escalation to resolution · ${c.subject}`,
          reason: 'Acknowledged > 48h without resolution.',
          tenant,
          ctaLabel: 'Open case',
          href,
        });
      }
    }
  });

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
  /** Phase 1.1.3A correction — actively escalated cases for this tenant.
   *  Uses the shared `isActiveEscalation` predicate so Tenant 360
   *  agrees with Command Center counts/lists, Needs Attention, and
   *  Support Tools surfaces. */
  activeEscalations: SupportCaseRecord[];
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
    if (isActiveEscalation(c)) return true;
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
  // Phase 1.1.3A — escalation pulse routing. Each filters the Needs
  // Attention queue by the corresponding new attention item type.
  unacknowledged_escalations: {
    filterLabel: 'Unacked escalations',
    filtersAttention: it => it.type === 'Unacknowledged escalation',
  },
  overdue_ack: {
    filterLabel: 'Overdue ack',
    filtersAttention: it => it.type === 'Overdue escalation acknowledgement',
  },
  unassigned_escalations: {
    filterLabel: 'Unassigned escalations',
    filtersAttention: it => it.type === 'Escalation without owner',
  },
};

export function deriveTenant360(input: Tenant360Inputs): Tenant360Result {
  const now = input.now || new Date();
  const tenantCases = input.cases.filter(c => c.tenantId === input.tenantId);
  const openCases = tenantCases.filter(c => c.status !== 'resolved' && c.status !== 'closed');
  const activeEscalations = openCases.filter(c => isActiveEscalation(c));
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
    activeEscalations,
    overdueOrAtRiskCases,
    recentAudits,
    domainIssues,
    notesPreview: input.notes.slice(0, 3),
  };
}

// ===========================================================================
// Phase 1.1.2 — Competitive Ops Console Maturity helpers
// ===========================================================================
// Strictly additive on Phase 1.1.1. No signature changes to existing exports.
// All helpers are pure, deterministic, rule-based — no AI, no live checks,
// no external network call.

// --- Truth label (shared across surfaces) ---------------------------------

export const PHASE_112_TRUTH_LABEL =
  'Operational state is derived from support, audit, domain, and workflow signals — not infrastructure uptime monitoring.';

// --- Support saved-view counts (queue feel) -------------------------------
//
// Mirrors the predicate logic used by SupportToolsPage `applyView` so each
// chip can render a count badge. We accept the raw view definition + the full
// support-cases array; we do not consider tenant search or unrelated filters
// because the chip count should reflect "how many cases match this lens",
// not how many match the operator's current ad-hoc search.

export function countCasesForSupportView(
  view: SavedView<SupportViewFilters>,
  cases: SupportCaseRecord[],
  now: Date = new Date(),
  ctx?: SupportViewCtx
): number {
  const f = view.filters;
  return cases.filter(c => {
    if (f.status === 'open_group') {
      if (c.status === 'resolved' || c.status === 'closed') return false;
    } else if (f.status === 'resolved_group') {
      if (c.status !== 'resolved' && c.status !== 'closed') return false;
    } else if (f.status && f.status !== 'all') {
      if (c.status !== f.status) return false;
    }
    if (f.severity && f.severity !== 'all') {
      if (c.severity !== f.severity) return false;
    }
    if (f.sla === 'overdue' || f.sla === 'at_risk') {
      const s = deriveSlaStatus(c, now).status;
      if (s !== f.sla) return false;
    }
    if (f.escalation) {
      if (!matchesEscalationFilter(c, f.escalation, now, ctx)) return false;
    }
    return true;
  }).length;
}

// --- Operational widget metadata (helper text, empty state, click-through) -

export type WidgetId =
  | 'cases-by-severity'
  | 'sla-pressure'
  | 'tenant-risk'
  | 'audit-by-severity'
  | 'domain-snapshot'
  | 'high-risk-stream'
  | 'escalated-cases'
  | 'commercial-attention';

export interface WidgetMeta {
  title: string;
  helper: string;
  emptyMessage: string;
  // Optional whole-widget deep-link (header chevron). Bucket-level deep-links
  // are handled by `BUCKET_NAVIGATION` so cards can both link the title and
  // each segment.
  navigateTo?: string;
}

export const WIDGET_META: Record<WidgetId, WidgetMeta> = {
  'cases-by-severity': {
    title: 'Cases by Severity',
    helper: 'Open support cases grouped by severity. Click a band to filter the queue.',
    emptyMessage: 'No open cases in range.',
    navigateTo: '/owner/support-tools',
  },
  'sla-pressure': {
    title: 'SLA Pressure',
    helper: 'Derived from each case\'s resolution due time. Click Overdue / At-risk to triage.',
    emptyMessage: 'No SLA-tracked cases in range.',
    navigateTo: '/owner/support-tools',
  },
  'tenant-risk': {
    title: 'Tenant Risk Distribution',
    helper: 'Tenants by derived risk band. Click a band to scan that cohort.',
    emptyMessage: 'No tenants in this view.',
  },
  'audit-by-severity': {
    title: 'Audit by Severity',
    helper: 'Audit events grouped by severity. Click a band to open the audit lens.',
    emptyMessage: 'No audit events in range.',
    navigateTo: '/owner/audit-security',
  },
  'domain-snapshot': {
    title: 'Domain Snapshot',
    helper: 'Current domain status counts. Click Failed to investigate.',
    emptyMessage: 'No domains configured.',
    navigateTo: '/owner/domains',
  },
  'high-risk-stream': {
    title: 'High-Risk Stream',
    helper: 'Audit events flagged critical or high-risk in the active range.',
    emptyMessage: 'No high-risk events in range.',
    navigateTo: '/owner/audit-security',
  },
  'escalated-cases': {
    title: 'Escalated Cases',
    helper: 'Open cases manually escalated by an operator.',
    emptyMessage: 'No escalated cases.',
    navigateTo: '/owner/support-tools',
  },
  'commercial-attention': {
    title: 'Add-on / Commercial Attention',
    helper: 'Non-active activations + billing-related cases.',
    emptyMessage: 'No commercial issues to review.',
  },
};

// Distribution bucket → deep link. Keyed by `${widgetId}:${bucketKey}`.
// Returning undefined means "not navigable" (e.g. healthy/met/info segments
// where there is nothing to investigate).
export function bucketNavigateTo(widget: WidgetId, bucketKey: string): string | undefined {
  if (widget === 'cases-by-severity') {
    if (bucketKey === 'urgent' || bucketKey === 'high' || bucketKey === 'normal' || bucketKey === 'low')
      return `/owner/support-tools?severity=${encodeURIComponent(bucketKey)}`;
  }
  if (widget === 'sla-pressure') {
    if (bucketKey === 'overdue' || bucketKey === 'at_risk')
      return `/owner/support-tools?sla=${encodeURIComponent(bucketKey)}`;
  }
  if (widget === 'audit-by-severity') {
    if (bucketKey === 'warning' || bucketKey === 'critical' || bucketKey === 'notice' || bucketKey === 'info')
      return `/owner/audit-security?severity=${encodeURIComponent(bucketKey)}`;
  }
  if (widget === 'domain-snapshot') {
    if (bucketKey === 'failed' || bucketKey === 'pending' || bucketKey === 'verifying')
      return `/owner/domains?status=${encodeURIComponent(bucketKey)}`;
  }
  // tenant-risk segments do not have a single canonical filtered destination
  // in this phase — operators use the Tenant 360 drawer instead.
  return undefined;
}

// --- NBA deterministic tier --------------------------------------------------

export type NbaTier = 'p1' | 'p2' | 'p3';

export const NBA_TIER_LABEL: Record<NbaTier, string> = {
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
};

export const NBA_TIER_STYLES: Record<NbaTier, string> = {
  p1: 'bg-red-500/10 text-red-700 border-red-500/30',
  p2: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  p3: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
};

export function tierForPriority(priority: NbaPriority): NbaTier {
  if (priority === 'critical') return 'p1';
  if (priority === 'high') return 'p2';
  return 'p3';
}

// ===========================================================================
// Phase 1.1.3A — Operating Model + Permission-Aware Escalation
// ===========================================================================
// Strictly additive on Phase 1.1 / 1.1.1 / 1.1.2. All helpers below are
// pure, deterministic, and rule-based. There is no real RBAC enforcement,
// no real notifications, no on-call routing, no PagerDuty / Slack / SMS /
// email, no AI. Roles + can() are advisory governance controls used to
// shape which buttons appear in the UI; they do not gate any persisted
// data, server endpoint, or external service.

export const PHASE_113A_TRUTH_LABEL =
  'Escalation is an internal workflow — assignment, acknowledgement, level changes, and resolution are tracked and audited in-app. No paging, on-call routing, or external notifications are wired in this phase.';

export const PHASE_113A_PERMISSION_LABEL =
  'Permission checks are advisory governance controls — buttons gate the UI to make ownership and approval flows obvious, but no persisted RBAC is enforced server-side in this phase.';

// --- Advisory roles --------------------------------------------------------

export type PlatformOpsRole =
  | 'platform_owner'
  | 'platform_admin'
  | 'platform_lead'
  | 'platform_operator'
  | 'platform_security'
  | 'platform_billing'
  | 'platform_readonly';

export const PLATFORM_OPS_ROLE_LABEL: Record<PlatformOpsRole, string> = {
  platform_owner: 'Platform Owner',
  platform_admin: 'Platform Admin',
  platform_lead: 'Support Lead',
  platform_operator: 'Operator',
  platform_security: 'Security Reviewer',
  platform_billing: 'Billing Reviewer',
  platform_readonly: 'Read-only',
};

export const PLATFORM_OPS_ROLE_DESCRIPTION: Record<PlatformOpsRole, string> = {
  platform_owner: 'Full operating-model authority across every escalation lifecycle action.',
  platform_admin: 'Day-to-day escalation governance — escalate, assign, acknowledge, level, de-escalate, resolve, close.',
  platform_lead: 'Triage + acknowledgement + assignment authority for the support queue. Cannot close cases that still have an active escalation.',
  platform_operator: 'Frontline operator — can escalate and acknowledge / de-escalate items they own. Cannot reassign or change level.',
  platform_security: 'Security-routed acknowledgement, level changes, and resolution.',
  platform_billing: 'Billing-routed acknowledgement and de-escalation.',
  platform_readonly: 'Read-only — every escalation lifecycle button is disabled with a reason.',
};

// Sample team for "Assigned to My Team" mapping. Pure advisory.
export const ROLE_TEAM_BY_ROLE: Record<PlatformOpsRole, string | null> = {
  platform_owner: 'Engineering / Platform Ops',
  platform_admin: 'Engineering / Platform Ops',
  platform_lead: 'Support Tier 2',
  platform_operator: 'Support Tier 1',
  platform_security: 'Security Review',
  platform_billing: 'Billing Operations',
  platform_readonly: null,
};

// --- Escalation labels / styles -------------------------------------------

export type EscalationStatus = NonNullable<SupportCaseRecord['escalationStatus']>;
export type EscalationLevel = NonNullable<SupportCaseRecord['escalationLevel']>;
export type EscalationReasonCode = NonNullable<SupportCaseRecord['escalationReasonCode']>;
export type EscalationTargetTeam = NonNullable<SupportCaseRecord['escalationTargetTeam']>;

export const ESCALATION_STATUS_LABEL: Record<EscalationStatus, string> = {
  none: 'Not escalated',
  escalated: 'Escalated',
  acknowledged: 'Acknowledged',
  in_review: 'In Review',
  deescalated: 'De-escalated',
  resolved: 'Escalation Resolved',
};

export const ESCALATION_STATUS_STYLES: Record<EscalationStatus, string> = {
  none: 'bg-slate-100 text-slate-500 border-slate-200',
  escalated: 'bg-red-500/10 text-red-700 border-red-500/30',
  acknowledged: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  in_review: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  deescalated: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  resolved: 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
};

export const ESCALATION_LEVEL_LABEL: Record<EscalationLevel, string> = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  'Manager Review': 'Manager Review',
  'Security Review': 'Security Review',
  'Critical Incident Review': 'Critical Incident Review',
};

export const ESCALATION_LEVEL_STYLES: Record<EscalationLevel, string> = {
  L1: 'bg-slate-100 text-slate-700 border-slate-200',
  L2: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  L3: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  'Manager Review': 'bg-red-500/10 text-red-700 border-red-500/30',
  'Security Review': 'bg-red-500/10 text-red-700 border-red-500/30',
  'Critical Incident Review': 'bg-red-600/10 text-red-800 border-red-600/40',
};

export const ESCALATION_LEVEL_OPTIONS: EscalationLevel[] = [
  'L1',
  'L2',
  'L3',
  'Manager Review',
  'Security Review',
  'Critical Incident Review',
];

export const ESCALATION_REASON_LABEL: Record<EscalationReasonCode, string> = {
  sla_breach: 'SLA breach',
  sla_at_risk: 'SLA at risk',
  customer_impact: 'Customer impact',
  security_concern: 'Security concern',
  billing_risk: 'Billing risk',
  domain_issue: 'Domain / DNS issue',
  product_defect: 'Product defect',
  repeated_failure: 'Repeated failure',
  manual: 'Manual / other',
};

export const ESCALATION_REASON_OPTIONS: EscalationReasonCode[] = [
  'sla_breach',
  'sla_at_risk',
  'customer_impact',
  'security_concern',
  'billing_risk',
  'domain_issue',
  'product_defect',
  'repeated_failure',
  'manual',
];

export const ESCALATION_TARGET_TEAM_OPTIONS: EscalationTargetTeam[] = [
  'Support Tier 1',
  'Support Tier 2',
  'Engineering / Platform Ops',
  'Security Review',
  'Billing Operations',
  'Customer Success',
  'Executive Review',
];

const CRITICAL_ESCALATION_LEVELS = new Set<EscalationLevel>([
  'Manager Review',
  'Security Review',
  'Critical Incident Review',
]);

// --- Effective status (back-compat with legacy `escalated:true`) ----------

export interface EffectiveEscalation {
  status: EscalationStatus;
  level: EscalationLevel | null;
  active: boolean;
  isLegacyOnly: boolean;
}

export function effectiveEscalationStatus(
  c: Pick<
    SupportCaseRecord,
    'escalated' | 'escalationStatus' | 'escalationLevel'
  >
): EffectiveEscalation {
  const explicit = c.escalationStatus;
  if (explicit && explicit !== 'none') {
    const active =
      explicit === 'escalated' || explicit === 'acknowledged' || explicit === 'in_review';
    return {
      status: explicit,
      level: c.escalationLevel ?? null,
      active,
      isLegacyOnly: false,
    };
  }
  if (c.escalated === true) {
    return {
      status: 'escalated',
      level: c.escalationLevel ?? null,
      active: true,
      isLegacyOnly: !c.escalationStatus,
    };
  }
  return {
    status: 'none',
    level: c.escalationLevel ?? null,
    active: false,
    isLegacyOnly: false,
  };
}

// Phase 1.1.3A correction — single source of truth predicate. Use this
// instead of the legacy `c.escalated === true` boolean across every
// surface (Support Tools banner / card / pills, Command Center counts +
// lists + rollups, Needs Attention, NBAs, Tenant Risk, Tenant 360,
// focus-mode source filters). Keeps the legacy boolean working (cases
// that only set `escalated:true` without a structured status still
// count as active) while routing all visibility / count / list
// decisions through `effectiveEscalationStatus().active`.
export function isActiveEscalation(
  c: Pick<SupportCaseRecord, 'escalated' | 'escalationStatus' | 'escalationLevel'>
): boolean {
  return effectiveEscalationStatus(c).active;
}

// Convenience: filter to only open cases that are actively escalated.
// Mirrors the predicate used by every count/list surface so they cannot
// drift apart. Open = not resolved/closed (terminal support statuses).
export function getActiveEscalatedCases<T extends SupportCaseRecord>(
  cases: T[]
): T[] {
  return cases.filter(
    c => c.status !== 'resolved' && c.status !== 'closed' && isActiveEscalation(c)
  );
}

export function isEscalationAckOverdue(
  c: Pick<SupportCaseRecord, 'escalationStatus' | 'escalated' | 'acknowledgementDueAt'>,
  now: Date = new Date()
): boolean {
  const eff = effectiveEscalationStatus(c as SupportCaseRecord);
  if (eff.status !== 'escalated') return false;
  if (!c.acknowledgementDueAt) return false;
  const due = new Date(c.acknowledgementDueAt);
  if (isNaN(due.getTime())) return false;
  return now.getTime() > due.getTime();
}

export function isEscalationCritical(
  c: Pick<SupportCaseRecord, 'severity' | 'escalated' | 'escalationStatus' | 'escalationLevel'>
): boolean {
  const eff = effectiveEscalationStatus(c as SupportCaseRecord);
  if (!eff.active) return false;
  if (eff.level && CRITICAL_ESCALATION_LEVELS.has(eff.level)) return true;
  if (c.severity === 'urgent') return true;
  return false;
}

// Phase 1.1.3A correction — single escalation VIEW MODEL for the Support
// case detail. The red banner, header "Escalated" pill, escalation detail
// card, reviewer card, rejected pill, and the De-escalate button MUST all
// read from this one object so they can never drift apart. Invariant:
// `canShowEscalationBanner === isActive`, and the De-escalate action is
// only offered when `isActive` is true. Because it wraps the same
// `effectiveEscalationStatus`, a case escalated via the structured status
// OR the legacy `escalated:true` boolean resolves identically everywhere.
export interface EscalationViewModel {
  isActive: boolean;
  isTerminal: boolean;
  status: EscalationStatus;
  statusLabel: string;
  level: EscalationLevel | null;
  levelLabel: string | null;
  ownerOrTeam: string | null;
  reason: string | null;
  escalatedBy: string | null;
  escalatedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  pendingDeescalationRequest: boolean;
  canShowEscalationBanner: boolean;
  canShowEscalationCard: boolean;
}

export function buildEscalationViewModel(c: SupportCaseRecord): EscalationViewModel {
  const eff = effectiveEscalationStatus(c);
  const isActive = eff.active;
  const isTerminal = eff.status === 'deescalated' || eff.status === 'resolved';
  return {
    isActive,
    isTerminal,
    status: eff.status,
    statusLabel: ESCALATION_STATUS_LABEL[eff.status],
    level: eff.level,
    levelLabel: eff.level ? ESCALATION_LEVEL_LABEL[eff.level] : null,
    ownerOrTeam: c.escalationOwnerName || c.escalationOwnerId || c.escalationTargetTeam || null,
    reason: c.escalationReason || c.escalationReasonNote || null,
    escalatedBy: c.escalatedBy || null,
    escalatedAt: c.escalatedAt || null,
    acknowledgedBy: c.acknowledgedBy || null,
    acknowledgedAt: c.acknowledgedAt || null,
    pendingDeescalationRequest: c.deescalationRequestStatus === 'pending',
    // The card always renders (it shows lifecycle metadata even when not
    // escalated); the banner is the active-only surface. Both flags are
    // derived here so any future change can only move them together.
    canShowEscalationBanner: isActive,
    canShowEscalationCard: true,
  };
}

// Phase 1.1.3A correction — ONE escalation signal object used by Command
// Center for the escalated pulse COUNT, the escalated widget LIST, and the
// Needs Attention "Escalated case" filter, so count and list cannot drift.
// Callers MUST pass the SAME (focus/time-filtered) case slice that feeds
// the Operational Pulse so the displayed count equals the filtered list.
export interface EscalationSignal {
  activeEscalatedCases: SupportCaseRecord[];
  unacknowledgedEscalatedCases: SupportCaseRecord[];
  overdueEscalatedCases: SupportCaseRecord[];
  unassignedEscalatedCases: SupportCaseRecord[];
}

export function deriveEscalationSignal(
  cases: SupportCaseRecord[],
  now: Date = new Date()
): EscalationSignal {
  const activeEscalatedCases = getActiveEscalatedCases(cases);
  return {
    activeEscalatedCases,
    unacknowledgedEscalatedCases: activeEscalatedCases.filter(
      c => effectiveEscalationStatus(c).status === 'escalated'
    ),
    overdueEscalatedCases: activeEscalatedCases.filter(c => isEscalationAckOverdue(c, now)),
    unassignedEscalatedCases: activeEscalatedCases.filter(
      c => !((c.escalationOwnerName || '').trim())
    ),
  };
}

// --- Saved-view ctx + escalation filter matcher ---------------------------

export interface SupportViewCtx {
  /** Display name used to resolve `escalation: 'mine'` queues. */
  operatorName?: string | null;
  /** Team name used to resolve `escalation: 'team'` queues. */
  teamName?: string | null;
}

function matchesEscalationFilter(
  c: SupportCaseRecord,
  token: NonNullable<SupportViewFilters['escalation']>,
  now: Date,
  ctx?: SupportViewCtx
): boolean {
  const eff = effectiveEscalationStatus(c);
  if (token === 'active') return eff.active;
  if (token === 'unacknowledged') return eff.status === 'escalated';
  if (token === 'overdue_ack') return isEscalationAckOverdue(c, now);
  if (token === 'critical') return eff.active && isEscalationCritical(c);
  if (token === 'unassigned') {
    return eff.active && !((c.escalationOwnerName || c.escalationOwnerId || '').trim());
  }
  if (token === 'deescalated') return eff.status === 'deescalated';
  if (token === 'resolved') return eff.status === 'resolved';
  if (token === 'mine') {
    if (!eff.active) return false;
    const me = (ctx?.operatorName || '').trim();
    if (!me) return false;
    return (c.escalationOwnerName || '').trim() === me;
  }
  if (token === 'team') {
    if (!eff.active) return false;
    const team = (ctx?.teamName || '').trim();
    if (!team) return false;
    return (
      (c.escalationTargetTeam || '').trim() === team ||
      (c.assignedTeamName || '').trim() === team
    );
  }
  return true;
}

// --- can() — advisory permission helper ----------------------------------

export type EscalationAction =
  | 'escalate'
  | 'assign_owner'
  | 'acknowledge'
  | 'change_level'
  | 'deescalate'
  | 'resolve_escalation'
  | 'close_with_active_escalation'
  | 'edit_assignment';

export interface CanCtx {
  /** Optional escalation target team — used to scope security/billing roles. */
  targetTeam?: EscalationTargetTeam | null;
  /** Whether the acting role currently owns the case escalation. */
  isOwner?: boolean;
}

export interface CanResult {
  allowed: boolean;
  reason: string;
}

const ROLE_TEAM_SCOPE: Partial<Record<PlatformOpsRole, EscalationTargetTeam[]>> = {
  platform_security: ['Security Review'],
  platform_billing: ['Billing Operations'],
};

function teamInScope(
  role: PlatformOpsRole,
  ctx?: CanCtx
): boolean {
  const scope = ROLE_TEAM_SCOPE[role];
  if (!scope) return true;
  if (!ctx?.targetTeam) return false;
  return scope.includes(ctx.targetTeam);
}

const CAN_MATRIX: Record<EscalationAction, Partial<Record<PlatformOpsRole, true>>> = {
  escalate: {
    platform_owner: true,
    platform_admin: true,
    platform_lead: true,
    platform_operator: true,
    platform_security: true,
    platform_billing: true,
  },
  assign_owner: {
    platform_owner: true,
    platform_admin: true,
    platform_lead: true,
    platform_security: true,
    platform_billing: true,
  },
  acknowledge: {
    platform_owner: true,
    platform_admin: true,
    platform_lead: true,
    platform_operator: true,
    platform_security: true,
    platform_billing: true,
  },
  change_level: {
    platform_owner: true,
    platform_admin: true,
    platform_lead: true,
    platform_security: true,
  },
  deescalate: {
    platform_owner: true,
    platform_admin: true,
    platform_lead: true,
    platform_operator: true,
    platform_security: true,
    platform_billing: true,
  },
  resolve_escalation: {
    platform_owner: true,
    platform_admin: true,
    platform_lead: true,
    platform_security: true,
    platform_billing: true,
  },
  close_with_active_escalation: {
    platform_owner: true,
    platform_admin: true,
  },
  edit_assignment: {
    platform_owner: true,
    platform_admin: true,
    platform_lead: true,
  },
};

export function can(
  role: PlatformOpsRole,
  action: EscalationAction,
  ctx?: CanCtx
): CanResult {
  if (role === 'platform_readonly') {
    return {
      allowed: false,
      reason: 'Read-only role cannot run escalation lifecycle actions.',
    };
  }
  const allowedRoles = CAN_MATRIX[action];
  if (!allowedRoles[role]) {
    return {
      allowed: false,
      reason: `${PLATFORM_OPS_ROLE_LABEL[role]} cannot ${action.replace(/_/g, ' ')} in this phase.`,
    };
  }
  // Operator restriction — operators may only acknowledge / de-escalate
  // cases they own.
  if (
    role === 'platform_operator' &&
    (action === 'acknowledge' || action === 'deescalate')
  ) {
    if (ctx && ctx.isOwner === false) {
      return {
        allowed: false,
        reason: 'Operators can only acknowledge / de-escalate cases they own.',
      };
    }
  }
  // Security / billing scoping — they only act on team-scoped escalations.
  if (!teamInScope(role, ctx)) {
    const scope = ROLE_TEAM_SCOPE[role];
    return {
      allowed: false,
      reason: `${PLATFORM_OPS_ROLE_LABEL[role]} can only act on ${(scope || []).join(' / ') || 'their team'} escalations.`,
    };
  }
  return { allowed: true, reason: '' };
}

// =====================================================================
// PHASE 1.1.3B — ADVANCED COMMAND CENTER INTELLIGENCE
// ---------------------------------------------------------------------
// All helpers below are deterministic and rule-based, derived ONLY from
// current app / session data (support cases, escalations, SLA status,
// audit/security events, domains, tenant plan/status, commercial /
// billing signals). They are NOT AI/ML, NOT predictive, NOT live
// infrastructure/uptime, NOT real DNS/SSL, and NOT Firestore real-time.
// Every surface that renders these signals must carry the truth label.
// Types use optional fields + safe defaults so nothing existing breaks.
// =====================================================================

export const INTELLIGENCE_TRUTH_LABEL =
  'Rule-based from current app / session data. Not AI prediction, live infrastructure uptime, real DNS/SSL, or Firestore real-time.';
export const CORRELATION_TRUTH_LABEL =
  'Rule-based correlation by shared tenant / actor / category — not AI prediction.';

export type SignalConfidence = 'High' | 'Medium' | 'Low';
export type AttentionPriority = 'critical' | 'high' | 'medium' | 'low';
export type SignalSource =
  | 'support_cases'
  | 'escalations'
  | 'sla'
  | 'audit_security'
  | 'domains'
  | 'commercial'
  | 'tenant'
  | 'security_notes';

export const SIGNAL_SOURCE_LABEL: Record<SignalSource, string> = {
  support_cases: 'Support cases',
  escalations: 'Escalations',
  sla: 'SLA status',
  audit_security: 'Audit & security',
  domains: 'Domains',
  commercial: 'Commercial / billing',
  tenant: 'Tenant plan / status',
  security_notes: 'Security notes',
};

export const ATTENTION_PRIORITY_LABEL: Record<AttentionPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const ATTENTION_RANK: Record<AttentionPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function maxAttention(a: AttentionPriority, b: AttentionPriority): AttentionPriority {
  return ATTENTION_RANK[a] <= ATTENTION_RANK[b] ? a : b;
}

// Generic explainable insight envelope (Part A canonical shape).
export interface IntelligenceInsight {
  id: string;
  title: string;
  priority: AttentionPriority;
  category: SignalSource | 'tenant_risk' | 'correlation';
  tenantId?: string | null;
  tenant?: string | null;
  relatedIds: string[];
  reason: string;
  evidence: string;
  source: SignalSource[];
  confidence: SignalConfidence;
  recommendedAction: string;
  href: string;
  truthLabel: string;
}

export interface SignalFreshness {
  lastUpdated: string;
  source: SignalSource[];
  label: string;
}

export interface OperationalTrend {
  direction: 'up' | 'down' | 'flat';
  delta: number;
  label: string;
}

// --- COMMERCIAL BLOCKERS ---------------------------------------------------

export type CommercialBlockerKind =
  | 'subscription_overdue'
  | 'subscription_suspended'
  | 'activation_incomplete'
  | 'payment_failed';

export interface CommercialBlocker {
  id: string;
  tenantId: string;
  tenantName: string;
  kind: CommercialBlockerKind;
  label: string;
  reason: string;
  priority: AttentionPriority;
  confidence: SignalConfidence;
  href: string;
}

export interface CommercialBlockerInput {
  tenants: { id: string; name: string; status?: string; activationStatus?: string }[];
  billing?: {
    id?: string;
    tenantId: string;
    status: string;
    type?: string;
    invoiceNo?: string;
    amount?: number;
  }[];
}

export function deriveCommercialBlockers(input: CommercialBlockerInput): CommercialBlocker[] {
  const out: CommercialBlocker[] = [];
  input.tenants.forEach(t => {
    if (t.status === 'overdue') {
      out.push({
        id: `cb_over_${t.id}`,
        tenantId: t.id,
        tenantName: t.name,
        kind: 'subscription_overdue',
        label: 'Subscription overdue',
        reason: 'Tenant billing status is overdue.',
        priority: 'high',
        confidence: 'High',
        href: `/owner/tenants/${t.id}`,
      });
    }
    if (t.status === 'suspended') {
      out.push({
        id: `cb_susp_${t.id}`,
        tenantId: t.id,
        tenantName: t.name,
        kind: 'subscription_suspended',
        label: 'Subscription suspended',
        reason: 'Tenant account is suspended.',
        priority: 'high',
        confidence: 'High',
        href: `/owner/tenants/${t.id}`,
      });
    }
    if (t.activationStatus && t.activationStatus !== 'active') {
      out.push({
        id: `cb_act_${t.id}`,
        tenantId: t.id,
        tenantName: t.name,
        kind: 'activation_incomplete',
        label: 'Activation incomplete',
        reason: `Activation status: ${t.activationStatus.replace(/_/g, ' ')}.`,
        priority: 'medium',
        confidence: 'Medium',
        href: `/owner/tenants/${t.id}`,
      });
    }
  });
  (input.billing || [])
    .filter(b => b.status === 'failed')
    .forEach(b => {
      const t = input.tenants.find(x => x.id === b.tenantId);
      out.push({
        id: `cb_pay_${b.id || b.tenantId}`,
        tenantId: b.tenantId,
        tenantName: t?.name || b.tenantId,
        kind: 'payment_failed',
        label: 'Payment failed',
        reason: `Failed ${b.type || 'payment'}${b.invoiceNo ? ` · ${b.invoiceNo}` : ''}.`,
        priority: 'high',
        confidence: 'High',
        href: `/owner/tenants/${b.tenantId}`,
      });
    });
  return out.sort((a, b) => ATTENTION_RANK[a.priority] - ATTENTION_RANK[b.priority]);
}

// --- COMMAND SIGNALS (atomic normalized signals) ---------------------------
// One flat list of every active operational signal. Drives correlation,
// the ribbon, drilldown drawers and the snapshot engine so every surface
// counts / lists from the SAME source and cannot drift.

export type CommandSignalKind =
  | 'escalation'
  | 'unack_escalation'
  | 'overdue_sla'
  | 'at_risk_sla'
  | 'critical_case'
  | 'high_risk_audit'
  | 'failed_domain'
  | 'pending_domain'
  | 'commercial_blocker';

export interface CommandSignal {
  id: string;
  kind: CommandSignalKind;
  category: SignalSource;
  priority: AttentionPriority;
  tenantId: string | null;
  tenant: string | null;
  caseId?: string | null;
  domainId?: string | null;
  actor?: string | null;
  severity?: string | null;
  at?: string | null;
  label: string;
  reason: string;
  href: string;
  confidence: SignalConfidence;
}

export interface CommandSignalInput {
  cases: SupportCaseRecord[];
  audits: AuditEventLike[];
  domains: { id: string; tenantId: string; hostname: string; status: string; ssl?: string }[];
  commercialBlockers?: CommercialBlocker[];
  tenantNameById: Map<string, string>;
  now?: Date;
}

export function deriveCommandSignals(input: CommandSignalInput): CommandSignal[] {
  const now = input.now || new Date();
  const out: CommandSignal[] = [];
  const tname = (id: string | null | undefined) =>
    id ? input.tenantNameById.get(id) || id : null;
  const openCases = input.cases.filter(
    c => c.status !== 'resolved' && c.status !== 'closed'
  );

  openCases.forEach(c => {
    const tenant = tname(c.tenantId);
    const href = `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`;
    const eff = effectiveEscalationStatus(c);
    if (eff.active) {
      out.push({
        id: `sig_esc_${c.id}`,
        kind: 'escalation',
        category: 'escalations',
        priority: c.severity === 'urgent' ? 'critical' : 'high',
        tenantId: c.tenantId,
        tenant,
        caseId: c.id,
        severity: c.severity,
        at: c.escalatedAt || c.openedAt,
        label: `Escalated · ${c.subject}`,
        reason: c.escalationReason ? `Escalated — ${c.escalationReason}` : 'Active escalation.',
        href,
        confidence: 'High',
      });
      if (eff.status === 'escalated') {
        out.push({
          id: `sig_unack_${c.id}`,
          kind: 'unack_escalation',
          category: 'escalations',
          priority: isEscalationCritical(c) || isEscalationAckOverdue(c, now) ? 'critical' : 'high',
          tenantId: c.tenantId,
          tenant,
          caseId: c.id,
          at: c.escalatedAt || c.openedAt,
          label: `Unacknowledged escalation · ${c.subject}`,
          reason: isEscalationAckOverdue(c, now)
            ? 'Escalation past acknowledgement-due time.'
            : 'Escalation awaiting acknowledgement.',
          href,
          confidence: 'High',
        });
      }
    }
    const sla = deriveSlaStatus(c, now);
    if (sla.status === 'overdue') {
      out.push({
        id: `sig_sla_${c.id}`,
        kind: 'overdue_sla',
        category: 'sla',
        priority: c.severity === 'urgent' ? 'critical' : 'high',
        tenantId: c.tenantId,
        tenant,
        caseId: c.id,
        severity: c.severity,
        at: c.openedAt,
        label: `Overdue SLA · ${c.subject}`,
        reason: sla.label,
        href,
        confidence: 'High',
      });
    } else if (sla.status === 'at_risk') {
      out.push({
        id: `sig_slar_${c.id}`,
        kind: 'at_risk_sla',
        category: 'sla',
        priority: 'medium',
        tenantId: c.tenantId,
        tenant,
        caseId: c.id,
        severity: c.severity,
        at: c.openedAt,
        label: `SLA at risk · ${c.subject}`,
        reason: sla.label,
        href,
        confidence: 'Medium',
      });
    }
    if (c.severity === 'urgent') {
      out.push({
        id: `sig_crit_${c.id}`,
        kind: 'critical_case',
        category: 'support_cases',
        priority: 'critical',
        tenantId: c.tenantId,
        tenant,
        caseId: c.id,
        severity: c.severity,
        at: c.openedAt,
        label: `Urgent case · ${c.subject}`,
        reason: 'Case severity is urgent.',
        href,
        confidence: 'High',
      });
    }
  });

  input.audits.slice(0, 60).forEach(a => {
    const flag = deriveHighRiskFlag(a).flag;
    if (flag !== 'critical' && flag !== 'high_risk') return;
    out.push({
      id: `sig_aud_${a.id}`,
      kind: 'high_risk_audit',
      category: 'audit_security',
      priority: flag === 'critical' ? 'critical' : 'high',
      tenantId: a.tenantId || null,
      tenant: tname(a.tenantId),
      actor: a.actor || null,
      severity: a.severity || null,
      at: a.date,
      label: a.action,
      reason: `${a.target}${a.severity ? ` · ${a.severity}` : ''}`,
      href: '/owner/audit-security',
      confidence: 'High',
    });
  });

  input.domains.forEach(d => {
    if (d.status === 'failed') {
      out.push({
        id: `sig_dmf_${d.id}`,
        kind: 'failed_domain',
        category: 'domains',
        priority: 'high',
        tenantId: d.tenantId,
        tenant: tname(d.tenantId),
        domainId: d.id,
        at: null,
        label: `Failed domain · ${d.hostname}`,
        reason: 'Domain verification failed.',
        href: '/owner/domains',
        confidence: 'High',
      });
    } else if (d.status === 'pending' || d.status === 'verifying') {
      out.push({
        id: `sig_dmp_${d.id}`,
        kind: 'pending_domain',
        category: 'domains',
        priority: 'medium',
        tenantId: d.tenantId,
        tenant: tname(d.tenantId),
        domainId: d.id,
        at: null,
        label: `Pending domain · ${d.hostname}`,
        reason: `Domain status: ${d.status}.`,
        href: '/owner/domains',
        confidence: 'Medium',
      });
    }
  });

  (input.commercialBlockers || []).forEach(b => {
    out.push({
      id: `sig_com_${b.id}`,
      kind: 'commercial_blocker',
      category: 'commercial',
      priority: b.priority,
      tenantId: b.tenantId,
      tenant: b.tenantName,
      at: null,
      label: b.label,
      reason: b.reason,
      href: b.href,
      confidence: b.confidence,
    });
  });

  return out.sort((a, b) => ATTENTION_RANK[a.priority] - ATTENTION_RANK[b.priority]);
}

// --- TENANT HEALTH SIGNALS (heatmap / priority matrix) ---------------------

export interface TenantHealthReason {
  code: string;
  label: string;
}

export interface TenantHealthSignal {
  tenantId: string;
  tenantName: string;
  plan?: string;
  status?: string;
  tier: RiskStatus;
  score: number;
  reasons: TenantHealthReason[];
  confidence: SignalConfidence;
  source: SignalSource[];
  recommendedAction: string;
  href: string;
}

export interface TenantHealthInput {
  tenants: { id: string; name: string; plan?: string; status?: string; activationStatus?: string }[];
  cases: SupportCaseRecord[];
  audits: AuditEventLike[];
  domains: { tenantId: string; status: string; ssl: string }[];
  commercialBlockers?: CommercialBlocker[];
  now?: Date;
}

export function deriveTenantHealthSignals(input: TenantHealthInput): TenantHealthSignal[] {
  const now = input.now || new Date();
  const blockersByTenant = new Map<string, CommercialBlocker[]>();
  (input.commercialBlockers || []).forEach(b => {
    const arr = blockersByTenant.get(b.tenantId) || [];
    arr.push(b);
    blockersByTenant.set(b.tenantId, arr);
  });

  return input.tenants
    .map(t => {
      const base = deriveTenantRisk(t.id, {
        cases: input.cases,
        audits: input.audits,
        domains: input.domains,
      });
      let score = base.score;
      const reasons: TenantHealthReason[] = [];
      const source = new Set<SignalSource>();

      const openCases = input.cases.filter(
        c => c.tenantId === t.id && c.status !== 'resolved' && c.status !== 'closed'
      );
      const escalated = openCases.filter(c => isActiveEscalation(c));
      if (escalated.length) {
        score += escalated.length * 3;
        reasons.push({
          code: 'active_escalation',
          label: `${escalated.length} active escalation${escalated.length > 1 ? 's' : ''}`,
        });
        source.add('escalations');
      }
      const overdue = openCases.filter(c => deriveSlaStatus(c, now).status === 'overdue');
      if (overdue.length) {
        reasons.push({
          code: 'overdue_sla',
          label: `${overdue.length} overdue SLA case${overdue.length > 1 ? 's' : ''}`,
        });
        source.add('sla');
      }
      // Carry the base risk signal text as explainable reasons.
      base.signals.forEach(s => {
        reasons.push({ code: 'risk', label: s });
        source.add('support_cases');
        source.add('audit_security');
        source.add('domains');
      });
      const blockers = blockersByTenant.get(t.id) || [];
      if (blockers.length) {
        score += blockers.length * 2;
        reasons.push({
          code: 'commercial_blocker',
          label: blockers.map(b => b.label).join(', '),
        });
        source.add('commercial');
      }
      if (t.status === 'overdue' || t.status === 'suspended') {
        source.add('tenant');
      }

      const tier: RiskStatus =
        score >= 8 ? 'critical' : score >= 5 ? 'at_risk' : score >= 2 ? 'watch' : 'healthy';
      const confidence: SignalConfidence =
        escalated.length || tier === 'critical'
          ? 'High'
          : reasons.length >= 2
            ? 'Medium'
            : reasons.length
              ? 'Medium'
              : 'Low';
      const recommendedAction =
        tier === 'critical'
          ? 'Open Tenant 360 and triage immediately.'
          : tier === 'at_risk'
            ? 'Review tenant signals in Tenant 360.'
            : tier === 'watch'
              ? 'Monitor — minor signals present.'
              : 'No action needed — tenant healthy.';

      return {
        tenantId: t.id,
        tenantName: t.name,
        plan: t.plan,
        status: t.status,
        tier,
        score,
        reasons,
        confidence,
        source: Array.from(source),
        recommendedAction,
        href: `/owner/tenants/${t.id}`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

// --- CORRELATED SIGNALS / OPERATIONAL EPISODES -----------------------------

export interface CorrelatedRiskGroup {
  id: string;
  title: string;
  tenantId: string | null;
  tenant: string | null;
  severity: AttentionPriority;
  signalCount: number;
  signals: CommandSignal[];
  categories: SignalSource[];
  whyGrouped: string;
  recommendedAction: string;
  href: string;
  confidence: SignalConfidence;
  truthLabel: string;
}

export function deriveCorrelatedRiskGroups(signals: CommandSignal[]): CorrelatedRiskGroup[] {
  const groups: CorrelatedRiskGroup[] = [];

  // 1) Same-tenant correlation: >=2 signals spanning >=2 categories.
  const byTenant = new Map<string, CommandSignal[]>();
  signals.forEach(s => {
    if (!s.tenantId) return;
    const arr = byTenant.get(s.tenantId) || [];
    arr.push(s);
    byTenant.set(s.tenantId, arr);
  });
  byTenant.forEach((arr, tenantId) => {
    const cats = Array.from(new Set(arr.map(s => s.category)));
    if (arr.length < 2 || cats.length < 2) return;
    const severity = arr.reduce<AttentionPriority>((p, s) => maxAttention(p, s.priority), 'low');
    const tenant = arr[0].tenant;
    groups.push({
      id: `epi_t_${tenantId}`,
      title: `${tenant} — ${arr.length} correlated signals`,
      tenantId,
      tenant,
      severity,
      signalCount: arr.length,
      signals: arr,
      categories: cats,
      whyGrouped: `Same tenant with signals across ${cats.map(c => SIGNAL_SOURCE_LABEL[c]).join(', ')}.`,
      recommendedAction: 'Open Tenant 360 to review the combined risk picture.',
      href: `/owner/tenants/${tenantId}`,
      confidence: arr.length >= 3 ? 'High' : 'Medium',
      truthLabel: CORRELATION_TRUTH_LABEL,
    });
  });

  // 2) Same-actor correlation: repeated high-risk audit events (>=2).
  const byActor = new Map<string, CommandSignal[]>();
  signals
    .filter(s => s.kind === 'high_risk_audit' && s.actor)
    .forEach(s => {
      const arr = byActor.get(s.actor as string) || [];
      arr.push(s);
      byActor.set(s.actor as string, arr);
    });
  byActor.forEach((arr, actor) => {
    if (arr.length < 2) return;
    const severity = arr.reduce<AttentionPriority>((p, s) => maxAttention(p, s.priority), 'low');
    groups.push({
      id: `epi_a_${actor.replace(/\s+/g, '_')}`,
      title: `${actor} — ${arr.length} high-risk audit events`,
      tenantId: null,
      tenant: null,
      severity,
      signalCount: arr.length,
      signals: arr,
      categories: ['audit_security'],
      whyGrouped: `Same actor produced ${arr.length} high-risk audit events.`,
      recommendedAction: 'Investigate actor activity in Audit & Security.',
      href: '/owner/audit-security',
      confidence: 'Medium',
      truthLabel: CORRELATION_TRUTH_LABEL,
    });
  });

  return groups.sort((a, b) => ATTENTION_RANK[a.severity] - ATTENTION_RANK[b.severity]);
}

// --- SNAPSHOT + DELTA ENGINE (what changed / getting worse) ----------------

export interface SnapshotEntry {
  id: string;
  label: string;
  tenant: string | null;
  href: string;
}

export interface CommandCenterSnapshot {
  takenAt: string;
  escalations: SnapshotEntry[];
  unackEscalations: SnapshotEntry[];
  unassignedEscalations: SnapshotEntry[];
  overdueSla: SnapshotEntry[];
  highRiskAudits: SnapshotEntry[];
  failedDomains: SnapshotEntry[];
  commercialBlockers: SnapshotEntry[];
  tenantTiers: Record<string, RiskStatus>;
  caseSeverity: Record<string, string>;
}

const SEVERITY_RANK: Record<string, number> = { low: 0, normal: 1, medium: 1, high: 2, urgent: 3 };
const TIER_RANK: Record<RiskStatus, number> = { healthy: 0, watch: 1, at_risk: 2, critical: 3 };

function signalEntries(signals: CommandSignal[], kind: CommandSignalKind): SnapshotEntry[] {
  return signals
    .filter(s => s.kind === kind)
    .map(s => ({ id: s.id, label: s.label, tenant: s.tenant, href: s.href }));
}

export function buildCommandCenterSnapshot(input: {
  signals: CommandSignal[];
  tenantHealth: TenantHealthSignal[];
  cases: SupportCaseRecord[];
  now?: Date;
}): CommandCenterSnapshot {
  const now = input.now || new Date();
  const tenantTiers: Record<string, RiskStatus> = {};
  input.tenantHealth.forEach(t => {
    tenantTiers[t.tenantId] = t.tier;
  });
  const caseSeverity: Record<string, string> = {};
  input.cases
    .filter(c => c.status !== 'resolved' && c.status !== 'closed')
    .forEach(c => {
      caseSeverity[c.id] = c.severity;
    });
  const unassignedEscalations: SnapshotEntry[] = input.cases
    .filter(
      c =>
        c.status !== 'resolved' &&
        c.status !== 'closed' &&
        isActiveEscalation(c) &&
        !(c.escalationOwnerName || '').trim()
    )
    .map(c => ({
      id: `sig_unown_${c.id}`,
      label: `Unassigned escalation · ${c.subject}`,
      tenant: c.tenantId,
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    }));
  return {
    takenAt: now.toISOString(),
    escalations: signalEntries(input.signals, 'escalation'),
    unackEscalations: signalEntries(input.signals, 'unack_escalation'),
    unassignedEscalations,
    overdueSla: signalEntries(input.signals, 'overdue_sla'),
    highRiskAudits: signalEntries(input.signals, 'high_risk_audit'),
    failedDomains: signalEntries(input.signals, 'failed_domain'),
    commercialBlockers: signalEntries(input.signals, 'commercial_blocker'),
    tenantTiers,
    caseSeverity,
  };
}

export interface SnapshotDeltaItem {
  id: string;
  kind: string;
  label: string;
  tenant?: string | null;
  href: string;
  direction: 'new' | 'worse';
}

export interface SnapshotDelta {
  hasBaseline: boolean;
  baselineAt?: string;
  newlyActive: SnapshotDeltaItem[];
  gettingWorse: SnapshotDeltaItem[];
  summary: string;
}

function diffEntryList(
  prev: SnapshotEntry[],
  curr: SnapshotEntry[],
  kind: string
): SnapshotDeltaItem[] {
  const prevIds = new Set(prev.map(e => e.id));
  return curr
    .filter(e => !prevIds.has(e.id))
    .map(e => ({
      id: e.id,
      kind,
      label: e.label,
      tenant: e.tenant,
      href: e.href,
      direction: 'new' as const,
    }));
}

export function diffCommandCenterSnapshots(
  prev: CommandCenterSnapshot | null,
  curr: CommandCenterSnapshot
): SnapshotDelta {
  if (!prev) {
    return {
      hasBaseline: false,
      newlyActive: [],
      gettingWorse: [],
      summary: 'No previous snapshot yet — mark this review to start tracking changes.',
    };
  }
  const newlyActive: SnapshotDeltaItem[] = [
    ...diffEntryList(prev.escalations, curr.escalations, 'New escalation'),
    ...diffEntryList(prev.unackEscalations, curr.unackEscalations, 'New unacknowledged escalation'),
    ...diffEntryList(prev.unassignedEscalations, curr.unassignedEscalations, 'Newly unassigned escalation'),
    ...diffEntryList(prev.overdueSla, curr.overdueSla, 'Newly overdue SLA'),
    ...diffEntryList(prev.highRiskAudits, curr.highRiskAudits, 'New high-risk audit'),
    ...diffEntryList(prev.failedDomains, curr.failedDomains, 'Newly failed domain'),
    ...diffEntryList(prev.commercialBlockers, curr.commercialBlockers, 'New commercial blocker'),
  ];

  const gettingWorse: SnapshotDeltaItem[] = [];
  Object.entries(curr.tenantTiers).forEach(([tenantId, tier]) => {
    const before = prev.tenantTiers[tenantId];
    if (before && TIER_RANK[tier] > TIER_RANK[before]) {
      gettingWorse.push({
        id: `worse_tier_${tenantId}`,
        kind: 'Tenant risk increased',
        label: `${tenantId}: ${RISK_STATUS_LABEL[before]} → ${RISK_STATUS_LABEL[tier]}`,
        tenant: tenantId,
        href: `/owner/tenants/${tenantId}`,
        direction: 'worse',
      });
    }
  });
  Object.entries(curr.caseSeverity).forEach(([caseId, sev]) => {
    const before = prev.caseSeverity[caseId];
    if (before && (SEVERITY_RANK[sev] ?? 0) > (SEVERITY_RANK[before] ?? 0)) {
      gettingWorse.push({
        id: `worse_sev_${caseId}`,
        kind: 'Case severity increased',
        label: `Case ${caseId}: ${before} → ${sev}`,
        href: `/owner/support-tools?caseId=${encodeURIComponent(caseId)}`,
        direction: 'worse',
      });
    }
  });

  const total = newlyActive.length + gettingWorse.length;
  const summary =
    total === 0
      ? 'No changes since your last review — signals are stable.'
      : `${newlyActive.length} new signal${newlyActive.length === 1 ? '' : 's'}, ${gettingWorse.length} getting worse since last review.`;

  return {
    hasBaseline: true,
    baselineAt: prev.takenAt,
    newlyActive,
    gettingWorse,
    summary,
  };
}

// --- OPERATIONAL INTELLIGENCE RIBBON ---------------------------------------

export type RibbonTone = 'ok' | 'info' | 'warn' | 'critical';
export type CommandDrawerId =
  | 'escalations'
  | 'sla'
  | 'audits'
  | 'domains'
  | 'commercial'
  | 'tenant_risk';

export interface RibbonCard {
  id: string;
  label: string;
  value: string;
  numeric: number;
  reason: string;
  tone: RibbonTone;
  confidence: SignalConfidence;
  source: string;
  drawer?: CommandDrawerId;
  href?: string;
  trend?: 'up' | 'down' | 'flat' | null;
  trendLabel?: string | null;
}

export interface RibbonInput {
  signals: CommandSignal[];
  tenantHealth: TenantHealthSignal[];
  delta?: SnapshotDelta | null;
}

function countKind(signals: CommandSignal[], ...kinds: CommandSignalKind[]): number {
  return signals.filter(s => kinds.includes(s.kind)).length;
}

function deltaTrend(
  delta: SnapshotDelta | null | undefined,
  kindLabels: string[]
): { trend: 'up' | 'flat' | null; trendLabel: string | null } {
  if (!delta || !delta.hasBaseline) return { trend: null, trendLabel: null };
  const added = delta.newlyActive.filter(d => kindLabels.includes(d.kind)).length;
  if (added > 0) return { trend: 'up', trendLabel: `+${added} since last review` };
  return { trend: 'flat', trendLabel: 'No change' };
}

export function deriveIntelligenceRibbon(input: RibbonInput): RibbonCard[] {
  const { signals, tenantHealth, delta } = input;
  const cards: RibbonCard[] = [];

  // 1) Highest risk tenant (always shown).
  const top = tenantHealth.find(t => t.tier !== 'healthy');
  cards.push({
    id: 'ribbon_top_tenant',
    label: 'Highest Risk Tenant',
    value: top ? top.tenantName : 'All healthy',
    numeric: top ? top.score : 0,
    reason: top
      ? `${RISK_STATUS_LABEL[top.tier]} · ${top.reasons[0]?.label || 'multiple signals'}`
      : 'No tenant currently above the healthy threshold.',
    tone: top ? (top.tier === 'critical' ? 'critical' : top.tier === 'at_risk' ? 'warn' : 'info') : 'ok',
    confidence: top ? top.confidence : 'High',
    source: SIGNAL_SOURCE_LABEL.tenant,
    drawer: 'tenant_risk',
  });

  // 2) Active escalations.
  const esc = countKind(signals, 'escalation');
  const escTrend = deltaTrend(delta, ['New escalation']);
  cards.push({
    id: 'ribbon_escalations',
    label: 'Active Escalations',
    value: String(esc),
    numeric: esc,
    reason: esc ? 'Cases currently escalated and active.' : 'No active escalations.',
    tone: esc ? 'critical' : 'ok',
    confidence: 'High',
    source: SIGNAL_SOURCE_LABEL.escalations,
    drawer: 'escalations',
    trend: escTrend.trend,
    trendLabel: escTrend.trendLabel,
  });

  // 3) SLA pressure.
  const sla = countKind(signals, 'overdue_sla', 'at_risk_sla');
  const overdue = countKind(signals, 'overdue_sla');
  const slaTrend = deltaTrend(delta, ['Newly overdue SLA']);
  cards.push({
    id: 'ribbon_sla',
    label: 'SLA Pressure',
    value: String(sla),
    numeric: sla,
    reason: sla ? `${overdue} overdue, ${sla - overdue} at risk.` : 'All SLAs healthy.',
    tone: overdue ? 'critical' : sla ? 'warn' : 'ok',
    confidence: overdue ? 'High' : 'Medium',
    source: SIGNAL_SOURCE_LABEL.sla,
    drawer: 'sla',
    trend: slaTrend.trend,
    trendLabel: slaTrend.trendLabel,
  });

  // 4) High-risk audit events.
  const aud = countKind(signals, 'high_risk_audit');
  const audTrend = deltaTrend(delta, ['New high-risk audit']);
  cards.push({
    id: 'ribbon_audits',
    label: 'High-Risk Audit Events',
    value: String(aud),
    numeric: aud,
    reason: aud ? 'Critical / high-risk audit events flagged.' : 'No high-risk audit events.',
    tone: aud ? 'warn' : 'ok',
    confidence: 'High',
    source: SIGNAL_SOURCE_LABEL.audit_security,
    drawer: 'audits',
    trend: audTrend.trend,
    trendLabel: audTrend.trendLabel,
  });

  // 5) Domain issues.
  const dom = countKind(signals, 'failed_domain', 'pending_domain');
  const failedDom = countKind(signals, 'failed_domain');
  const domTrend = deltaTrend(delta, ['Newly failed domain']);
  cards.push({
    id: 'ribbon_domains',
    label: 'Domain Issues',
    value: String(dom),
    numeric: dom,
    reason: dom ? `${failedDom} failed, ${dom - failedDom} pending.` : 'No domain issues.',
    tone: failedDom ? 'critical' : dom ? 'warn' : 'ok',
    confidence: failedDom ? 'High' : 'Medium',
    source: SIGNAL_SOURCE_LABEL.domains,
    drawer: 'domains',
    trend: domTrend.trend,
    trendLabel: domTrend.trendLabel,
  });

  // 6) Commercial blockers.
  const com = countKind(signals, 'commercial_blocker');
  const comTrend = deltaTrend(delta, ['New commercial blocker']);
  cards.push({
    id: 'ribbon_commercial',
    label: 'Commercial Blockers',
    value: String(com),
    numeric: com,
    reason: com ? 'Overdue / suspended / failed-payment / incomplete activation.' : 'No commercial blockers.',
    tone: com ? 'warn' : 'ok',
    confidence: 'Medium',
    source: SIGNAL_SOURCE_LABEL.commercial,
    drawer: 'commercial',
    trend: comTrend.trend,
    trendLabel: comTrend.trendLabel,
  });

  return cards;
}

// --- NEXT BEST ACTIONS ENRICHMENT ------------------------------------------
// Additive wrapper around deriveNextBestActions — never mutates the base
// shape. Adds action type, topical category, confidence, time sensitivity,
// owner/team and source so the upgraded queue can sort + filter
// deterministically. Review / click-through only — no automation.

export type NbaActionType =
  | 'Review'
  | 'Assign'
  | 'Acknowledge'
  | 'Resolve'
  | 'Investigate'
  | 'Configure'
  | 'Follow up';

export type NbaCategory =
  | 'escalations'
  | 'sla'
  | 'audit_security'
  | 'domains'
  | 'commercial'
  | 'tenant_risk';

export interface EnrichedNba extends NextBestAction {
  actionType: NbaActionType;
  category: NbaCategory;
  confidence: SignalConfidence;
  timeSensitivity: string;
  ownerTeam: string | null;
  source: string;
}

export const NBA_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'critical', label: 'Critical' },
  { id: 'escalations', label: 'Escalations' },
  { id: 'sla', label: 'SLA' },
  { id: 'audit_security', label: 'Audit & Security' },
  { id: 'domains', label: 'Domains' },
  { id: 'commercial', label: 'Commercial' },
  { id: 'tenant_risk', label: 'Tenant Risk' },
];

const NBA_CATEGORY_RANK: Record<NbaCategory, number> = {
  escalations: 0,
  sla: 1,
  audit_security: 2,
  domains: 3,
  commercial: 4,
  tenant_risk: 5,
};

function nbaCategoryFor(id: string): NbaCategory {
  if (id.startsWith('nba_aud') || id.includes('audit')) return 'audit_security';
  if (id.startsWith('nba_dom') || id.includes('domain')) return 'domains';
  if (id.startsWith('nba_com')) return 'commercial';
  if (id.startsWith('nba_tr') || id.includes('risk')) return 'tenant_risk';
  if (id.startsWith('nba_co') || id.includes('sla')) return 'sla';
  if (id.startsWith('nba_e') || id.includes('esc')) return 'escalations';
  return 'tenant_risk';
}

function nbaActionTypeFor(id: string, category: NbaCategory): NbaActionType {
  if (id.includes('ack')) return 'Acknowledge';
  if (id.includes('own') || id.includes('assign')) return 'Assign';
  if (id.includes('slad') || id.startsWith('nba_co')) return 'Resolve';
  if (category === 'audit_security') return 'Investigate';
  if (category === 'domains') return 'Configure';
  if (category === 'commercial') return 'Follow up';
  if (category === 'escalations') return 'Review';
  return 'Review';
}

function nbaTimeSensitivity(priority: NbaPriority): string {
  return priority === 'critical'
    ? 'Act now'
    : priority === 'high'
      ? 'Today'
      : priority === 'medium'
        ? 'This week'
        : 'When possible';
}

export function enrichNextBestActions(actions: NextBestAction[]): EnrichedNba[] {
  const enriched = actions.map(a => {
    const category = nbaCategoryFor(a.id);
    const actionType = nbaActionTypeFor(a.id, category);
    const confidence: SignalConfidence =
      category === 'tenant_risk' ? 'Medium' : a.priority === 'low' ? 'Medium' : 'High';
    return {
      ...a,
      actionType,
      category,
      confidence,
      timeSensitivity: nbaTimeSensitivity(a.priority),
      ownerTeam: null,
      source: SIGNAL_SOURCE_LABEL[
        category === 'audit_security'
          ? 'audit_security'
          : category === 'domains'
            ? 'domains'
            : category === 'commercial'
              ? 'commercial'
              : category === 'sla'
                ? 'sla'
                : category === 'tenant_risk'
                  ? 'tenant'
                  : 'escalations'
      ],
    } as EnrichedNba;
  });
  return enriched.sort((a, b) => {
    const pr =
      (a.priority === 'critical' ? 0 : a.priority === 'high' ? 1 : a.priority === 'medium' ? 2 : 3) -
      (b.priority === 'critical' ? 0 : b.priority === 'high' ? 1 : b.priority === 'medium' ? 2 : 3);
    if (pr !== 0) return pr;
    return NBA_CATEGORY_RANK[a.category] - NBA_CATEGORY_RANK[b.category];
  });
}

export function nbaMatchesFilter(action: EnrichedNba, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'critical') return action.priority === 'critical';
  return action.category === filter;
}

// Commercial blockers → Next Best Actions (review / follow-up only).
export function deriveCommercialNbas(blockers: CommercialBlocker[]): NextBestAction[] {
  return blockers.map(b => ({
    id: `nba_com_${b.id}`,
    priority: (b.priority === 'critical'
      ? 'critical'
      : b.priority === 'high'
        ? 'high'
        : b.priority === 'medium'
          ? 'medium'
          : 'low') as NbaPriority,
    title: `Follow up on ${b.label.toLowerCase()} · ${b.tenantName}`,
    reason: b.reason,
    tenant: b.tenantName,
    ctaLabel: 'Open tenant',
    href: b.href,
  }));
}

// ===========================================================================
// Phase 1.1.3C — Support Queue / SLA / Macro maturity
// ---------------------------------------------------------------------------
// Everything below is deterministic and rule-based. There is no AI, no
// business-hours calendar, no external notification, and no server-side
// enforcement. SLA timers are derived purely from each case's seeded due
// dates; queues are pure predicates over the in-app case list; macros only
// insert internal notes. These truth labels are surfaced verbatim in the UI.
// ===========================================================================

export const PHASE_113C_SLA_LABEL =
  'SLA timers are internal indicators derived from each case\u2019s seeded due dates. Business-hours calendars are not applied, and an SLA breach never triggers any external alert or notification.';

export const PHASE_113C_QUEUE_LABEL =
  'Queues are deterministic, rule-based filters over the current in-app case list. Each card\u2019s count and the rows it opens come from one shared predicate, so the count and the list can never drift.';

export const PHASE_113C_MACRO_LABEL =
  'Macros insert internal notes only. Placeholders are filled from in-app case context \u2014 no email, SMS, or external message is ever sent.';

// --- Response SLA ----------------------------------------------------------
// Mirror of deriveSlaStatus (which tracks the RESOLUTION SLA) but for the
// first-response commitment. Returns the shared SlaStatus vocabulary so the
// existing SLA label/style maps can be reused.

export function deriveResponseSlaStatus(
  c: SlaCaseLike,
  now: Date = new Date()
): { status: SlaStatus; label: string } {
  const due = c.firstResponseDueAt ? new Date(c.firstResponseDueAt) : null;
  if (!due || isNaN(due.getTime())) return { status: 'unknown', label: 'No response SLA' };

  // Once a first response is recorded the response SLA is settled.
  if (c.firstRespondedAt) {
    const responded = new Date(c.firstRespondedAt);
    if (isNaN(responded.getTime())) return { status: 'unknown', label: 'No response time' };
    return responded <= due
      ? { status: 'met', label: 'First response met' }
      : { status: 'missed', label: 'First response late' };
  }

  // No response yet. Terminal cases that were never responded to are not
  // actionable as a response queue item.
  if (c.status === 'resolved' || c.status === 'closed')
    return { status: 'unknown', label: 'Closed without recorded response' };
  if (c.status === 'waiting_customer')
    return { status: 'paused', label: 'Paused \u2014 awaiting customer' };

  const hours = (due.getTime() - now.getTime()) / 36e5;
  if (hours < 0) return { status: 'overdue', label: `Response overdue by ${formatSlaDuration(-hours)}` };
  if (hours <= 4) return { status: 'at_risk', label: `Respond within ${formatSlaDuration(hours)}` };
  return { status: 'on_track', label: `Respond within ${formatSlaDuration(hours)}` };
}

function formatSlaDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// --- SLA Policy Preview (read-only reference) ------------------------------
// Illustrative reference targets. These are NOT enforced and do not drive the
// seeded due dates on existing cases; they document the intent operators
// should aim for. Editing/persisting a live policy is future work.

export interface SlaPolicyRow {
  severity: SupportCaseSeverity;
  firstResponseTarget: string;
  resolutionTarget: string;
}

export const SLA_POLICY_PREVIEW: SlaPolicyRow[] = [
  { severity: 'urgent', firstResponseTarget: '1 hour', resolutionTarget: '8 hours' },
  { severity: 'high', firstResponseTarget: '4 hours', resolutionTarget: '1 day' },
  { severity: 'normal', firstResponseTarget: '8 hours', resolutionTarget: '3 days' },
  { severity: 'low', firstResponseTarget: '1 day', resolutionTarget: '5 days' },
];

export const SLA_POLICY_PREVIEW_LABEL =
  'Reference targets shown for context only. They are not enforced and do not change the due dates already stored on existing cases. A live, editable SLA policy is planned for a later phase.';

// --- Support Queue Center --------------------------------------------------
// Each queue is a single predicate. Queue counts and the rows a queue opens
// are both produced from `matchesSupportQueue`, so a count can never disagree
// with the list it drills into (the "no drift" invariant).

export type SupportQueueId =
  | 'needs_response'
  | 'response_overdue'
  | 'resolution_overdue'
  | 'resolution_at_risk'
  | 'active_escalations'
  | 'unassigned_open'
  | 'waiting_customer'
  | 'critical_open';

export interface SupportQueueMeta {
  id: SupportQueueId;
  label: string;
  helper: string;
}

export const SUPPORT_QUEUES: SupportQueueMeta[] = [
  { id: 'needs_response', label: 'Needs First Response', helper: 'Open cases with no first response recorded yet.' },
  { id: 'response_overdue', label: 'Response Overdue', helper: 'Open cases past their first-response due time.' },
  { id: 'resolution_overdue', label: 'Resolution Overdue', helper: 'Active cases past their resolution due time.' },
  { id: 'resolution_at_risk', label: 'Resolution At Risk', helper: 'Active cases due within the at-risk window.' },
  { id: 'active_escalations', label: 'Active Escalations', helper: 'Cases with an active escalation lifecycle.' },
  { id: 'unassigned_open', label: 'Unassigned Open', helper: 'Open cases with no assignee.' },
  { id: 'waiting_customer', label: 'Waiting on Customer', helper: 'Cases paused pending a customer reply.' },
  { id: 'critical_open', label: 'Critical Open', helper: 'Urgent-severity cases that are still open.' },
];

const isOpenGroupCase = (c: SupportCaseRecord): boolean =>
  c.status !== 'resolved' && c.status !== 'closed';

export function matchesSupportQueue(
  c: SupportCaseRecord,
  id: SupportQueueId,
  now: Date = new Date()
): boolean {
  switch (id) {
    case 'needs_response':
      return isOpenGroupCase(c) && !c.firstRespondedAt;
    case 'response_overdue':
      return isOpenGroupCase(c) && deriveResponseSlaStatus(c, now).status === 'overdue';
    case 'resolution_overdue':
      return deriveSlaStatus(c, now).status === 'overdue';
    case 'resolution_at_risk':
      return deriveSlaStatus(c, now).status === 'at_risk';
    case 'active_escalations':
      return effectiveEscalationStatus(c).active;
    case 'unassigned_open':
      return isOpenGroupCase(c) && !(c.assignee && c.assignee.trim());
    case 'waiting_customer':
      return c.status === 'waiting_customer';
    case 'critical_open':
      return isOpenGroupCase(c) && c.severity === 'urgent';
    default:
      return false;
  }
}

export interface SupportQueueSummary extends SupportQueueMeta {
  count: number;
  urgentCount: number;
  oldestDays: number | null;
}

export function deriveSupportQueues(
  cases: SupportCaseRecord[],
  now: Date = new Date()
): SupportQueueSummary[] {
  return SUPPORT_QUEUES.map(q => {
    const matched = cases.filter(c => matchesSupportQueue(c, q.id, now));
    let oldestDays: number | null = null;
    for (const c of matched) {
      const opened = new Date(c.openedAt);
      if (isNaN(opened.getTime())) continue;
      const days = Math.floor((now.getTime() - opened.getTime()) / 864e5);
      if (oldestDays === null || days > oldestDays) oldestDays = days;
    }
    return {
      ...q,
      count: matched.length,
      urgentCount: matched.filter(c => c.severity === 'urgent').length,
      oldestDays,
    };
  });
}

// --- Per-case operations signal (Case Detail Operations panel) -------------

export interface SupportCaseSignal {
  responseSla: { status: SlaStatus; label: string };
  resolutionSla: { status: SlaStatus; label: string };
  escalation: { active: boolean; status: EscalationStatus; label: string };
  ageDays: number;
  lastUpdateDays: number;
  attentionFlags: string[];
  recommendedActions: string[];
}

export function deriveSupportCaseSignal(
  c: SupportCaseRecord,
  now: Date = new Date()
): SupportCaseSignal {
  const responseSla = deriveResponseSlaStatus(c, now);
  const resolutionSla = deriveSlaStatus(c, now);
  const eff = effectiveEscalationStatus(c);

  const opened = new Date(c.openedAt);
  const updated = new Date(c.updatedAt);
  const ageDays = isNaN(opened.getTime())
    ? 0
    : Math.max(0, Math.floor((now.getTime() - opened.getTime()) / 864e5));
  const lastUpdateDays = isNaN(updated.getTime())
    ? 0
    : Math.max(0, Math.floor((now.getTime() - updated.getTime()) / 864e5));

  const attentionFlags: string[] = [];
  const recommendedActions: string[] = [];

  if (isOpenGroupCase(c)) {
    if (!c.firstRespondedAt) {
      attentionFlags.push('No first response recorded');
      recommendedActions.push('Add a first response note to start the case clock.');
    }
    if (responseSla.status === 'overdue') {
      attentionFlags.push('Response SLA overdue');
    } else if (responseSla.status === 'at_risk') {
      attentionFlags.push('Response SLA at risk');
    }
    if (resolutionSla.status === 'overdue') {
      attentionFlags.push('Resolution SLA overdue');
      recommendedActions.push('Resolution is overdue \u2014 consider escalating or re-prioritising.');
    } else if (resolutionSla.status === 'at_risk') {
      attentionFlags.push('Resolution SLA at risk');
    }
    if (!(c.assignee && c.assignee.trim())) {
      attentionFlags.push('Unassigned');
      recommendedActions.push('Assign an owner so the case is not unattended.');
    }
    if (c.severity === 'urgent') {
      attentionFlags.push('Critical severity');
    }
  }

  if (eff.active) {
    attentionFlags.push('Active escalation');
    if (eff.status === 'escalated') {
      recommendedActions.push('Acknowledge the escalation to confirm ownership.');
    }
    if (isEscalationAckOverdue(c, now)) {
      attentionFlags.push('Escalation acknowledgement overdue');
    }
    if (!((c.escalationOwnerName || c.escalationOwnerId || '').trim())) {
      attentionFlags.push('Escalation has no owner');
      recommendedActions.push('Assign an escalation owner.');
    }
  }

  if (c.status === 'waiting_customer') {
    recommendedActions.push('Awaiting customer \u2014 follow up if the reply window lapses.');
  }

  return {
    responseSla,
    resolutionSla,
    escalation: { active: eff.active, status: eff.status, label: ESCALATION_STATUS_LABEL[eff.status] },
    ageDays,
    lastUpdateDays,
    attentionFlags,
    recommendedActions,
  };
}

// --- Workload view ---------------------------------------------------------
// Read-only rollup of open work by assignee. Pure aggregation over the
// current case list; no assignment is performed here.

export interface SupportWorkloadRow {
  owner: string;
  total: number;
  open: number;
  escalated: number;
  overdueSla: number;
  urgent: number;
}

export function deriveSupportWorkload(
  cases: SupportCaseRecord[],
  now: Date = new Date()
): SupportWorkloadRow[] {
  const rows = new Map<string, SupportWorkloadRow>();
  const ensure = (owner: string): SupportWorkloadRow => {
    let r = rows.get(owner);
    if (!r) {
      r = { owner, total: 0, open: 0, escalated: 0, overdueSla: 0, urgent: 0 };
      rows.set(owner, r);
    }
    return r;
  };
  for (const c of cases) {
    if (!isOpenGroupCase(c)) continue;
    const owner = (c.assignee && c.assignee.trim()) ? c.assignee.trim() : 'Unassigned';
    const r = ensure(owner);
    r.total += 1;
    r.open += 1;
    if (effectiveEscalationStatus(c).active) r.escalated += 1;
    if (deriveSlaStatus(c, now).status === 'overdue') r.overdueSla += 1;
    if (c.severity === 'urgent') r.urgent += 1;
  }
  return Array.from(rows.values()).sort((a, b) => {
    // Unassigned floats to the top, then by total descending.
    if (a.owner === 'Unassigned' && b.owner !== 'Unassigned') return -1;
    if (b.owner === 'Unassigned' && a.owner !== 'Unassigned') return 1;
    return b.total - a.total;
  });
}

// --- Macro placeholders ----------------------------------------------------
// Placeholders are filled from in-app case context. Unresolved placeholders
// are reported so the operator can see exactly what was (and was not) filled
// before the macro is inserted as an internal note.

export interface MacroPlaceholderMeta {
  key: string;
  label: string;
  description: string;
}

export const MACRO_PLACEHOLDERS: MacroPlaceholderMeta[] = [
  { key: 'tenant_name', label: 'Tenant name', description: 'Display name of the case tenant.' },
  { key: 'case_id', label: 'Case ID', description: 'The support case identifier.' },
  { key: 'case_subject', label: 'Case subject', description: 'The case subject line.' },
  { key: 'severity', label: 'Severity', description: 'Current case severity.' },
  { key: 'status', label: 'Status', description: 'Current case status.' },
  { key: 'operator_name', label: 'Operator name', description: 'The signed-in operator.' },
  { key: 'date', label: 'Today\u2019s date', description: 'Current date (ISO).' },
];

export type MacroPlaceholderCtx = Partial<Record<string, string | null | undefined>>;

export interface ResolvedMacro {
  text: string;
  resolved: string[];
  unresolved: string[];
}

export function resolveMacroPlaceholders(
  body: string,
  ctx: MacroPlaceholderCtx
): ResolvedMacro {
  const resolved = new Set<string>();
  const unresolved = new Set<string>();
  const text = body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, rawKey: string) => {
    const key = rawKey.toLowerCase();
    const value = ctx[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      resolved.add(key);
      return String(value);
    }
    unresolved.add(key);
    return `{{${key}}}`;
  });
  return {
    text,
    resolved: Array.from(resolved),
    unresolved: Array.from(unresolved),
  };
}
