import React, { useEffect, useMemo, useState } from 'react';
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
  RISK_STATUS_LABEL,
  RISK_STATUS_STYLES,
  SLA_STATUS_STYLES,
  SLA_STATUS_LABEL,
  HIGH_RISK_FLAG_STYLES,
  HIGH_RISK_FLAG_LABEL,
  type AuditEventLike,
  type RiskStatus,
  type HighRiskFlag,
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

const CommandCenterPage: React.FC = () => {
  const navigate = useNavigate();
  const [cases, setCases] = useState<SupportCaseRecord[]>([]);
  const [audits, setAudits] = useState<AuditEventLike[]>([]);
  const [domains, setDomains] = useState<typeof tenantDomains>([]);
  const [notes, setNotes] = useState<SecurityNote[]>([]);

  // Live data load + change subscriptions ---------------------------------
  const reloadAll = () => {
    setCases(readSession<SupportCaseRecord[]>(CASES_KEY, supportCasesSeed));
    setAudits(readSession<AuditEventLike[]>('audit_logs', []));
    setDomains(readSession<typeof tenantDomains>(DOMAINS_KEY, tenantDomains));
    setNotes(readSession<SecurityNote[]>(NOTES_KEY, []));
  };

  useEffect(() => {
    reloadAll();
    const onAudit = () => reloadAll();
    const onStorage = () => reloadAll();
    window.addEventListener('audit_logs:changed', onAudit);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('audit_logs:changed', onAudit);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const tenantById = useMemo(() => {
    const m = new Map<string, string>();
    tenants.forEach(t => m.set(t.id, t.name));
    return m;
  }, []);

  // --- Health overview ---------------------------------------------------
  const openCases = cases.filter(c => c.status !== 'resolved' && c.status !== 'closed');
  const criticalCases = openCases.filter(c => c.severity === 'urgent');
  const overdueCases = openCases.filter(
    c => deriveSlaStatus(c).status === 'overdue'
  );
  const elevatedAuditCount = audits.filter(a => {
    const sev = (a.severity || '').toLowerCase();
    return sev === 'critical' || sev === 'warning';
  }).length;
  const failedDomains = domains.filter(d => d.status === 'failed').length;
  const pendingDomains = domains.filter(
    d => d.status === 'pending' || d.status === 'verifying'
  ).length;
  const sslMissing = domains.filter(d => d.ssl !== 'active' && d.status === 'verified').length;

  // --- Tenant risk -------------------------------------------------------
  const tenantRisk = tenants.map(t => ({
    tenant: t,
    risk: deriveTenantRisk(t.id, { audits, cases, domains }),
  }));
  const tenantsAtRisk = tenantRisk.filter(
    r => r.risk.status === 'at_risk' || r.risk.status === 'critical'
  );

  // --- Needs attention queue --------------------------------------------
  const attention: AttentionItem[] = [];

  criticalCases.forEach(c => {
    attention.push({
      id: `cc_${c.id}`,
      priority: 'critical',
      type: 'Critical support case',
      tenant: tenantById.get(c.tenantId) || c.tenantId,
      title: c.subject,
      reason: 'Severity = urgent',
      age: c.openedAt,
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    });
  });
  overdueCases.forEach(c => {
    attention.push({
      id: `oc_${c.id}`,
      priority: c.severity === 'urgent' || c.severity === 'high' ? 'high' : 'medium',
      type: 'Overdue support case',
      tenant: tenantById.get(c.tenantId) || c.tenantId,
      title: c.subject,
      reason: deriveSlaStatus(c).label,
      age: c.openedAt,
      href: `/owner/support-tools?caseId=${encodeURIComponent(c.id)}`,
    });
  });
  audits.slice(0, 50).forEach(a => {
    const { flag } = deriveHighRiskFlag(a);
    if (flag === 'critical') {
      attention.push({
        id: `ae_${a.id}`,
        priority: 'critical',
        type: 'High-risk audit event',
        tenant: a.tenantId ? tenantById.get(a.tenantId) || a.tenantId : null,
        title: a.action,
        reason: `${a.target} · ${a.severity}`,
        age: a.date,
        href: '/owner/audit-security',
      });
    } else if (flag === 'high_risk') {
      attention.push({
        id: `ae_${a.id}`,
        priority: 'high',
        type: 'High-risk audit event',
        tenant: a.tenantId ? tenantById.get(a.tenantId) || a.tenantId : null,
        title: a.action,
        reason: `${a.target}`,
        age: a.date,
        href: '/owner/audit-security',
      });
    }
  });
  domains.forEach(d => {
    if (d.status === 'failed') {
      attention.push({
        id: `df_${d.id}`,
        priority: 'high',
        type: 'Failed domain verification',
        tenant: tenantById.get(d.tenantId) || d.tenantId,
        title: d.hostname,
        reason: 'Verification failed',
        age: d.createdAt,
        href: '/owner/domains',
      });
    } else if (d.status === 'pending' || d.status === 'verifying') {
      attention.push({
        id: `dp_${d.id}`,
        priority: 'medium',
        type: 'Pending domain verification',
        tenant: tenantById.get(d.tenantId) || d.tenantId,
        title: d.hostname,
        reason: `Status: ${d.status}`,
        age: d.createdAt,
        href: '/owner/domains',
      });
    }
  });
  notes.slice(0, 5).forEach(n => {
    attention.push({
      id: `sn_${n.id}`,
      priority: 'low',
      type: 'Open security note',
      tenant: null,
      title: n.body.length > 80 ? `${n.body.slice(0, 80)}…` : n.body,
      reason: 'Security posture note',
      age: n.createdAt.slice(0, 10),
      href: '/owner/audit-security',
    });
  });

  attention.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  // --- Workflow health (truthful) ---------------------------------------
  const workflowHealth = [
    { label: 'Support cases — open', value: openCases.length },
    { label: 'Support cases — overdue', value: overdueCases.length },
    { label: 'Audit events — elevated', value: elevatedAuditCount },
    { label: 'Domains — pending verification', value: pendingDomains },
    { label: 'Domains — failed', value: failedDomains },
    { label: 'Security notes — unresolved', value: notes.length },
  ];

  // --- Quick actions -----------------------------------------------------
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

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Command Center</h2>
        <p className="text-slate-500 font-medium">
          The operational home for Platform Operations &amp; Security. Risk is derived from the
          support, audit, domain, and operational signals available in this system — nothing is
          invented.
        </p>
      </div>

      {/* Quick actions */}
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

      {/* Platform Health Overview */}
      <section className="space-y-3">
        <h3 className="text-sm font-black text-primary uppercase tracking-widest">Platform Health Overview</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <HealthCard label="Critical Support" value={criticalCases.length} hint="Urgent cases not yet resolved" tone={criticalCases.length > 0 ? 'critical' : 'ok'} />
          <HealthCard label="Overdue Support" value={overdueCases.length} hint="Past resolution SLA" tone={overdueCases.length > 0 ? 'warn' : 'ok'} />
          <HealthCard label="Elevated Audit" value={elevatedAuditCount} hint="Warning + critical events" tone={elevatedAuditCount > 5 ? 'warn' : 'info'} />
          <HealthCard label="Tenants Needing Attention" value={tenantsAtRisk.length} hint="At-risk + critical" tone={tenantsAtRisk.length > 0 ? 'warn' : 'ok'} />
          <HealthCard label="Failed Domains" value={failedDomains} hint="Verification failed" tone={failedDomains > 0 ? 'warn' : 'ok'} />
          <HealthCard label="Pending Domains" value={pendingDomains} hint="Pending / verifying" tone={pendingDomains > 0 ? 'info' : 'ok'} />
          <HealthCard label="SSL Gaps" value={sslMissing} hint="Verified domains without active SSL" tone={sslMissing > 0 ? 'warn' : 'ok'} />
          <HealthCard label="Open Security Notes" value={notes.length} hint="Unresolved posture notes" tone={notes.length > 0 ? 'info' : 'ok'} />
        </div>
      </section>

      {/* Needs Attention */}
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Needs Attention</h3>
            <p className="text-xs text-slate-500 font-medium">
              Prioritized queue of items that require System Owner action.
            </p>
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            {attention.length} item{attention.length !== 1 ? 's' : ''}
          </span>
        </div>
        {attention.length === 0 ? (
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
              {attention.slice(0, 20).map(item => (
                <tr key={item.id} data-testid={`needs-attention-row-${item.id}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5">
                    <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${PRIORITY_STYLES[item.priority]}`}>
                      {item.priority}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-700">{item.type}</td>
                  <td className="px-6 py-3.5 text-sm text-slate-600">{item.tenant || '—'}</td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900 max-w-[260px] truncate">{item.title}</td>
                  <td className="px-6 py-3.5 text-xs text-slate-500">{item.reason}</td>
                  <td className="px-6 py-3.5 text-xs text-slate-500 whitespace-nowrap">{item.age || '—'}</td>
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

      {/* Tenant Risk Summary */}
      <section className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Tenant Risk Summary</h3>
            <p className="text-xs text-slate-500 font-medium">
              Risk is derived from support, audit, and domain signals available in this system.
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
              .sort((a, b) => b.risk.score - a.risk.score)
              .slice(0, 8)
              .map(({ tenant, risk }) => (
                <tr key={tenant.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900">{tenant.name}</td>
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

      {/* Workflow Health */}
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

      {/* High-risk legend (deterministic rules) */}
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

      {/* Legend pills (so the badges match what users see elsewhere) */}
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

const HealthCard: React.FC<{ label: string; value: number; hint: string; tone: 'ok' | 'info' | 'warn' | 'critical' }> = ({ label, value, hint, tone }) => {
  const toneStyles =
    tone === 'critical' ? 'border-red-500/30 bg-red-500/5'
    : tone === 'warn' ? 'border-orange-400/30 bg-orange-400/5'
    : tone === 'info' ? 'border-blue-400/30 bg-blue-400/5'
    : 'border-slate-200 bg-white';
  return (
    <div className={`p-5 rounded-3xl border shadow-sm ${toneStyles}`}>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">{label}</p>
      <p className="text-2xl font-black text-primary">{value}</p>
      <p className="text-[11px] font-medium text-slate-500 mt-1">{hint}</p>
    </div>
  );
};

const RiskBadge: React.FC<{ status: RiskStatus }> = ({ status }) => (
  <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${RISK_STATUS_STYLES[status]}`}>
    {RISK_STATUS_LABEL[status]}
  </span>
);

const RiskRule: React.FC<{ label: string; body: string }> = ({ label, body }) => (
  <div>
    <p className="font-black text-slate-700">{label}</p>
    <p className="text-slate-500 mt-1 leading-relaxed" dangerouslySetInnerHTML={{ __html: body }} />
  </div>
);

export default CommandCenterPage;
