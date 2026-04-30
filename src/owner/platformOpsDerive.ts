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
