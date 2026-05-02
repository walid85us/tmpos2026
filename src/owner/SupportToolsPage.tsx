import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  tenants,
  tenantDomains as tenantDomainsSeed,
  supportCases as supportCasesSeed,
  supportMacros,
  type SupportCaseRecord,
  type SupportCaseStatus,
  type SupportCaseSeverity,
  type SupportCaseNote,
  type SupportMacro,
} from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';
import {
  deriveSlaStatus,
  deriveTenantRisk,
  predefinedSupportViews,
  SLA_STATUS_LABEL,
  SLA_STATUS_STYLES,
  RISK_STATUS_LABEL,
  RISK_STATUS_STYLES,
  type AuditEventLike,
  type SupportViewFilters,
} from './platformOpsDerive';

const CASES_KEY = 'support_cases_v1';
const DOMAINS_KEY = 'tenant_domains_v1';

const STATUS_LABELS: Record<SupportCaseStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting_customer: 'Waiting Customer',
  resolved: 'Resolved',
  closed: 'Closed',
};

const STATUS_STYLES: Record<SupportCaseStatus, string> = {
  open: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  in_progress: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  waiting_customer: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  resolved: 'bg-emerald-400/10 text-emerald-700 border-emerald-400/20',
  closed: 'bg-slate-200 text-slate-600 border-slate-300',
};

const SEVERITY_STYLES: Record<SupportCaseSeverity, string> = {
  low: 'bg-slate-100 text-slate-600 border-slate-200',
  normal: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  high: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  urgent: 'bg-red-500/10 text-red-700 border-red-500/30',
};

const SEVERITY_TO_AUDIT: Record<SupportCaseSeverity, 'info' | 'notice' | 'warning' | 'critical'> = {
  low: 'info',
  normal: 'info',
  high: 'warning',
  urgent: 'critical',
};

const loadCases = (): SupportCaseRecord[] => {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [...supportCasesSeed];
    const raw = window.sessionStorage.getItem(CASES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SupportCaseRecord[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* noop */ }
  return [...supportCasesSeed];
};

const saveCases = (cases: SupportCaseRecord[]) => {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(CASES_KEY, JSON.stringify(cases));
      // Notify any mounted listener (e.g. Command Center) that the canonical
      // support-cases store has changed. The native 'storage' event does not
      // fire in the same tab, so a custom event is needed for live sync.
      window.dispatchEvent(new Event('support_cases:changed'));
    }
  } catch { /* noop */ }
};

const SupportToolsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [cases, setCases] = useState<SupportCaseRecord[]>(() => loadCases());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SupportCaseStatus>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missingCaseId, setMissingCaseId] = useState<string | null>(null);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<string>('all');
  const [slaFilter, setSlaFilter] = useState<'any' | 'overdue' | 'at_risk'>('any');
  const [severityViewFilter, setSeverityViewFilter] = useState<'all' | SupportCaseSeverity>('all');
  const [sortMode, setSortMode] = useState<'opened_desc' | 'updated_desc'>('opened_desc');
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateReason, setEscalateReason] = useState('');

  // Live audit + domain mirrors so we can derive related entities + tenant risk.
  const [audits, setAudits] = useState<AuditEventLike[]>([]);
  const [domains, setDomains] = useState(tenantDomainsSeed);
  useEffect(() => {
    const read = () => {
      try {
        const rawA = window.sessionStorage?.getItem('audit_logs');
        setAudits(rawA ? (JSON.parse(rawA) as AuditEventLike[]) : []);
        const rawD = window.sessionStorage?.getItem(DOMAINS_KEY);
        setDomains(rawD ? JSON.parse(rawD) : tenantDomainsSeed);
      } catch {
        /* noop */
      }
    };
    read();
    window.addEventListener('audit_logs:changed', read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener('audit_logs:changed', read);
      window.removeEventListener('storage', read);
    };
  }, []);

  const applyView = (id: string) => {
    setActiveView(id);
    const v = predefinedSupportViews.find(x => x.id === id);
    if (!v) return;
    const f: SupportViewFilters = v.filters;
    if (f.status === 'open_group') setStatusFilter('all');
    else if (f.status === 'resolved_group') setStatusFilter('resolved');
    else if (f.status) setStatusFilter(f.status as SupportCaseStatus | 'all');
    else setStatusFilter('all');
    setSlaFilter(f.sla === 'overdue' ? 'overdue' : f.sla === 'at_risk' ? 'at_risk' : 'any');
    setSeverityViewFilter(f.severity && f.severity !== 'all' ? (f.severity as SupportCaseSeverity) : 'all');
    setSortMode(f.sort === 'updated_desc' ? 'updated_desc' : 'opened_desc');
  };

  const [draft, setDraft] = useState({
    tenantId: '',
    subject: '',
    description: '',
    severity: 'normal' as SupportCaseSeverity,
  });

  useEffect(() => { saveCases(cases); }, [cases]);

  // Linked-case deep-link: ?caseId=… opens the drawer; ?new=1 opens the create modal.
  useEffect(() => {
    const wantsNew = searchParams.get('new');
    if (wantsNew === '1') {
      setShowCreate(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
      return;
    }
    const cid = searchParams.get('caseId');
    if (!cid) {
      if (missingCaseId) setMissingCaseId(null);
      return;
    }
    const found = cases.find(c => c.id === cid);
    if (found) {
      setSelectedId(cid);
      setMissingCaseId(null);
    } else {
      setSelectedId(null);
      setMissingCaseId(cid);
    }
  }, [searchParams, cases, setSearchParams, missingCaseId]);

  const closeDrawer = () => {
    setSelectedId(null);
    if (searchParams.get('caseId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('caseId');
      setSearchParams(next, { replace: true });
    }
  };

  const dismissMissingCase = () => {
    setMissingCaseId(null);
    if (searchParams.get('caseId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('caseId');
      setSearchParams(next, { replace: true });
    }
  };

  const tenantById = useMemo(() => {
    const m = new Map<string, string>();
    tenants.forEach(t => m.set(t.id, t.name));
    return m;
  }, []);

  const filteredCases = useMemo(() => {
    const filtered = cases.filter(c => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (severityViewFilter !== 'all' && c.severity !== severityViewFilter) return false;
      if (slaFilter !== 'any') {
        const sla = deriveSlaStatus(c);
        if (slaFilter === 'overdue' && sla.status !== 'overdue') return false;
        if (slaFilter === 'at_risk' && sla.status !== 'at_risk') return false;
      }
      if (search.trim()) {
        const tenantName = tenantById.get(c.tenantId) || '';
        const hay = `${c.subject} ${c.description} ${tenantName} ${c.id}`.toLowerCase();
        if (!hay.includes(search.trim().toLowerCase())) return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
      const aKey = sortMode === 'updated_desc' ? a.updatedAt : a.openedAt;
      const bKey = sortMode === 'updated_desc' ? b.updatedAt : b.openedAt;
      return aKey < bKey ? 1 : -1;
    });
  }, [cases, statusFilter, severityViewFilter, slaFilter, search, tenantById, sortMode]);

  const tenantSearchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return tenants.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q) ||
      t.subdomain.toLowerCase().includes(q) ||
      (t.customDomain || '').toLowerCase().includes(q)
    ).slice(0, 5);
  }, [search]);

  const selected = useMemo(
    () => cases.find(c => c.id === selectedId) || null,
    [cases, selectedId]
  );

  const handleImpersonate = (tenantId: string) => {
    setImpersonating(tenantId);
    setTimeout(() => setImpersonating(null), 1800);
  };

  const handleCreate = () => {
    if (!draft.tenantId || !draft.subject.trim()) return;
    const now = new Date();
    const newCase: SupportCaseRecord = {
      id: `case_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: draft.tenantId,
      subject: draft.subject.trim(),
      description: draft.description.trim(),
      status: 'open',
      severity: draft.severity,
      assignee: null,
      openedAt: now.toISOString().slice(0, 10),
      updatedAt: now.toISOString().slice(0, 10),
      notes: [],
    };
    setCases(prev => [newCase, ...prev]);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_created',
      target: `${tenantById.get(draft.tenantId) || draft.tenantId} · ${newCase.subject}`,
      category: 'support',
      tenantId: draft.tenantId,
      severity: SEVERITY_TO_AUDIT[draft.severity],
      note: newCase.description || undefined,
    });
    setDraft({ tenantId: '', subject: '', description: '', severity: 'normal' });
    setShowCreate(false);
    setSelectedId(newCase.id);
  };

  const updateCase = (id: string, patch: Partial<SupportCaseRecord>, audit?: () => void) => {
    setCases(prev => prev.map(c => c.id === id ? { ...c, ...patch, updatedAt: new Date().toISOString().slice(0, 10) } : c));
    if (audit) audit();
  };

  const addNote = (id: string, body: string) => {
    if (!body.trim()) return;
    const note: SupportCaseNote = {
      id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: body.trim(),
      createdAt: new Date().toISOString(),
      kind: 'note',
    };
    updateCase(id, {
      notes: [...(cases.find(c => c.id === id)?.notes || []), note],
    });
    const c = cases.find(x => x.id === id);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_note_added',
      target: `${c ? tenantById.get(c.tenantId) || c.tenantId : '—'} · ${id}`,
      category: 'support',
      tenantId: c?.tenantId,
      severity: 'info',
      note: note.body,
    });
  };

  const changeStatus = (c: SupportCaseRecord, next: SupportCaseStatus) => {
    if (c.status === next) return;
    const transitionNote: SupportCaseNote = {
      id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: `Status: ${c.status} → ${next}`,
      createdAt: new Date().toISOString(),
      kind: 'status_change',
    };
    updateCase(c.id, { status: next, notes: [...(c.notes || []), transitionNote] });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_status_changed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.status,
      newValue: next,
      severity: next === 'closed' || next === 'resolved' ? 'info' : 'notice',
    });
  };

  const changeSeverity = (c: SupportCaseRecord, next: SupportCaseSeverity) => {
    if (c.severity === next) return;
    updateCase(c.id, { severity: next });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_severity_changed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.severity,
      newValue: next,
      severity: SEVERITY_TO_AUDIT[next],
    });
  };

  const changeAssignee = (c: SupportCaseRecord, next: string) => {
    const assignee = next.trim() || null;
    if (assignee === c.assignee) return;
    updateCase(c.id, { assignee });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_assignee_changed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.assignee || '—',
      newValue: assignee || '—',
      severity: 'info',
    });
  };

  const flaggedTenants = tenants.filter(t => t.flags.length > 0);

  // Phase 1.1 — escalation, macro insertion, close/reopen.
  const escalateCase = (c: SupportCaseRecord, reason: string) => {
    const now = new Date();
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: `Escalated: ${reason || '(no reason)'}`,
      createdAt: now.toISOString(),
      kind: 'status_change',
    };
    updateCase(c.id, {
      escalated: true,
      escalationReason: reason || null,
      escalatedAt: now.toISOString(),
      escalatedBy: 'System Owner',
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_escalated',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      severity: 'warning',
      note: reason || undefined,
    });
  };

  const deescalateCase = (c: SupportCaseRecord) => {
    const now = new Date();
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: 'De-escalated',
      createdAt: now.toISOString(),
      kind: 'status_change',
    };
    updateCase(c.id, {
      escalated: false,
      escalationReason: null,
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_deescalated',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      severity: 'notice',
    });
  };

  const insertMacro = (id: string, macro: SupportMacro, currentDraft: string, setNoteDraft: (s: string) => void) => {
    const c = cases.find(x => x.id === id);
    setNoteDraft(currentDraft ? `${currentDraft}\n\n${macro.body}` : macro.body);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_macro_inserted',
      target: `${c ? tenantById.get(c.tenantId) || c.tenantId : '—'} · ${id}`,
      category: 'support',
      tenantId: c?.tenantId,
      severity: 'info',
      note: `Template: ${macro.label}`,
    });
  };

  const closeCase = (c: SupportCaseRecord) => {
    if (c.status === 'closed') return;
    const now = new Date();
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: `Status: ${c.status} → closed`,
      createdAt: now.toISOString(),
      kind: 'status_change',
    };
    updateCase(c.id, {
      status: 'closed',
      resolvedAt: c.resolvedAt || now.toISOString(),
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_closed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      severity: 'info',
    });
  };

  const reopenCase = (c: SupportCaseRecord) => {
    const now = new Date();
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: `Status: ${c.status} → open (reopened)`,
      createdAt: now.toISOString(),
      kind: 'status_change',
    };
    updateCase(c.id, {
      status: 'open',
      resolvedAt: null,
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_reopened',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      severity: 'notice',
    });
  };

  // Related entities for the open case (tenant audits + tenant domains).
  const relatedForSelected = useMemo(() => {
    if (!selected) return { audits: [] as AuditEventLike[], domains: [] as typeof tenantDomainsSeed, sourceEvent: null as AuditEventLike | null };
    const sourceEvent = selected.sourceAuditEventId
      ? audits.find(a => a.id === selected.sourceAuditEventId) || null
      : null;
    const tenantAudits = audits.filter(a => a.tenantId === selected.tenantId).slice(0, 8);
    const tenantDom = domains.filter(d => d.tenantId === selected.tenantId);
    return { audits: tenantAudits, domains: tenantDom, sourceEvent };
  }, [selected, audits, domains]);

  const tenantRiskForSelected = useMemo(() => {
    if (!selected) return null;
    return deriveTenantRisk(selected.tenantId, { audits, cases, domains });
  }, [selected, audits, cases, domains]);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Support Tools</h2>
          <p className="text-slate-500 font-medium">Tenant search, case management, and operational helpers.</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all">+ New Case</button>
      </div>

      {/* Tenant search */}
      <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm">
        <h3 className="text-sm font-black text-primary uppercase tracking-widest mb-3">Tenant Search</h3>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by tenant name, ID, subdomain, or custom domain…"
          className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-700"
        />
        {tenantSearchHits.length > 0 && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
            {tenantSearchHits.map(t => (
              <div key={t.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-2xl border border-slate-100">
                <div>
                  <p className="text-sm font-bold text-slate-900">{t.name}</p>
                  <p className="text-[10px] text-slate-500 font-bold">{t.id} · {t.subdomain}{t.customDomain ? ` · ${t.customDomain}` : ''}</p>
                </div>
                <button
                  onClick={() => { setDraft(d => ({ ...d, tenantId: t.id })); setShowCreate(true); }}
                  className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-primary/5 hover:text-primary transition-colors"
                >
                  Open Case
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cases */}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between gap-4 flex-wrap">
          <h3 className="text-lg font-black text-primary tracking-tight">Support Cases</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {(['all', 'open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const).map(s => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setActiveView('custom'); }}
                className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${statusFilter === s ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
              >
                {s === 'all' ? 'All' : STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="px-8 py-3 border-b border-slate-100 bg-slate-50/40 flex items-center gap-2 flex-wrap" data-testid="support-saved-views">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Saved views:</span>
          {predefinedSupportViews.map(v => (
            <button
              key={v.id}
              data-testid={`support-saved-view-${v.id}`}
              data-active={activeView === v.id ? 'true' : 'false'}
              onClick={() => applyView(v.id)}
              className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${activeView === v.id ? 'bg-primary text-white shadow-md ring-2 ring-primary/20' : 'bg-white text-slate-600 border border-slate-200 hover:bg-primary/5 hover:text-primary hover:border-primary/30'}`}
            >
              {v.label}
            </button>
          ))}
          {activeView === 'custom' && (
            <span className="px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest bg-amber-400/10 text-amber-700 border border-amber-400/20">
              Custom filters
            </span>
          )}
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Case</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Severity</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">SLA</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Assignee</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filteredCases.map(c => {
              const sla = deriveSlaStatus(c);
              return (
                <tr key={c.id} data-testid={`support-case-row-${c.id}`} onClick={() => setSelectedId(c.id)} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors cursor-pointer">
                  <td className="px-6 py-3.5">
                    <p className="text-sm font-bold text-slate-900 truncate max-w-[260px]">
                      {c.subject}
                      {c.escalated && <span className="ml-2 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-red-500/10 text-red-700 border border-red-500/20">escalated</span>}
                      {c.sourceAuditEventId && <span className="ml-2 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-blue-400/10 text-blue-700 border border-blue-400/20">from audit</span>}
                    </p>
                    <p className="text-[10px] text-slate-400 font-mono">{c.id}</p>
                  </td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-700">{tenantById.get(c.tenantId) || c.tenantId}</td>
                  <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_STYLES[c.status]}`}>{STATUS_LABELS[c.status]}</span></td>
                  <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SEVERITY_STYLES[c.severity]}`}>{c.severity}</span></td>
                  <td className="px-6 py-3.5">
                    {/* Phase 1.1.1 UX Correction — bigger SLA pill with state-colored bar + microcopy. */}
                    <div className="flex items-center gap-2" data-testid={`support-sla-${c.id}`}>
                      <div
                        className={`w-1 h-9 rounded-full ${
                          sla.status === 'overdue' ? 'bg-red-500'
                          : sla.status === 'at_risk' ? 'bg-orange-400'
                          : sla.status === 'on_track' ? 'bg-emerald-500'
                          : 'bg-slate-300'
                        }`}
                      />
                      <div className="min-w-0">
                        <span
                          className={`inline-block px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border-2 ${SLA_STATUS_STYLES[sla.status]}`}
                          title={sla.label}
                        >
                          {SLA_STATUS_LABEL[sla.status]}
                        </span>
                        <p className="text-[10px] text-slate-500 font-bold mt-0.5 truncate">{sla.label}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-600">{c.assignee || '—'}</td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-500 whitespace-nowrap">{c.updatedAt}</td>
                </tr>
              );
            })}
            {filteredCases.length === 0 && (
              <tr><td colSpan={7} className="px-8 py-12 text-center text-slate-400 text-sm font-bold">No support cases match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Active Support Flags */}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-8 py-5 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-lg font-black text-primary tracking-tight">Active Support Flags</h3>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Impersonate is a dev-only stub — no real session is started.</span>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Flag</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {flaggedTenants.map(tenant => (
              <tr key={tenant.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-4 font-bold text-slate-900">{tenant.name}</td>
                <td className="px-8 py-4 text-sm font-bold text-red-600">{tenant.flags.join(', ')}</td>
                <td className="px-8 py-4 text-right">
                  <button
                    onClick={() => handleImpersonate(tenant.id)}
                    className={`px-4 py-2 font-black text-[10px] rounded-xl uppercase tracking-widest transition-all active:scale-95 ${impersonating === tenant.id ? 'bg-emerald-500 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
                  >
                    {impersonating === tenant.id ? 'Stub Acknowledged' : 'Impersonate (stub)'}
                  </button>
                </td>
              </tr>
            ))}
            {flaggedTenants.length === 0 && (
              <tr><td colSpan={3} className="px-8 py-8 text-center text-slate-400 text-sm font-bold">No tenants currently flagged.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create Case modal */}
      <AnimatePresence>
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCreate(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-xl font-black text-primary tracking-tight">New Support Case</h3>
                <button onClick={() => setShowCreate(false)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tenant</label>
                  <select value={draft.tenantId} onChange={e => setDraft(d => ({ ...d, tenantId: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="">Select tenant…</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Subject</label>
                  <input value={draft.subject} onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" placeholder="Short summary…" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Severity</label>
                  <select value={draft.severity} onChange={e => setDraft(d => ({ ...d, severity: e.target.value as SupportCaseSeverity }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Description</label>
                  <textarea value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-700 h-28 resize-none" placeholder="Provide context, repro steps, contacts…" />
                </div>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white transition-all">Cancel</button>
                <button onClick={handleCreate} disabled={!draft.tenantId || !draft.subject.trim()} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 disabled:opacity-40 transition-all">Create Case</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Case-not-found empty state (deep-link to a stale id) */}
      <AnimatePresence>
        {missingCaseId && (
          <div className="fixed inset-0 z-[55] flex items-center justify-center p-4" data-testid="case-not-found">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={dismissMissingCase} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Case not found</h3>
                <p className="text-xs text-slate-500 font-medium mt-1">No support case matches <span className="font-mono">{missingCaseId}</span> in this browser session. It may have been closed or pruned.</p>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end">
                <button onClick={dismissMissingCase} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90">Close</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Detail drawer */}
      <AnimatePresence>
        {selected && (
          <div className="fixed inset-0 z-50 flex justify-end" data-testid="support-case-detail">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDrawer} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-lg h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              {/* Phase 1.1.1 UX Correction — widened escalation banner with reason, who/when, De-escalate. */}
              {selected.escalated && (
                <div
                  className="px-7 py-4 bg-gradient-to-r from-red-600 to-red-500 text-white border-b-2 border-red-700 flex items-start gap-3"
                  data-testid="support-case-escalation-banner"
                >
                  <span className="material-symbols-outlined text-2xl mt-0.5">priority_high</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs font-black uppercase tracking-widest">Incident Escalated</p>
                      {selected.escalatedAt && (
                        <span className="text-[10px] font-bold bg-white/15 px-2 py-0.5 rounded">
                          {new Date(selected.escalatedAt).toLocaleString()} · by {selected.escalatedBy || '—'}
                        </span>
                      )}
                    </div>
                    {selected.escalationReason && (
                      <p className="text-xs font-bold mt-1.5 leading-snug">{selected.escalationReason}</p>
                    )}
                  </div>
                  <button
                    onClick={() => deescalateCase(selected)}
                    className="px-3 py-1.5 bg-white/15 hover:bg-white/25 text-[10px] font-black uppercase tracking-widest rounded-lg backdrop-blur-sm transition-colors whitespace-nowrap"
                    data-testid="support-case-deescalate-banner"
                  >
                    De-escalate
                  </button>
                </div>
              )}
              <div className="p-7 border-b border-slate-100 flex justify-between items-start">
                <div className="flex-1 pr-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{selected.id}</p>
                  <h3 className="text-lg font-black text-primary mt-1">{selected.subject}</h3>
                  <p className="text-xs text-slate-500 font-bold mt-1">{tenantById.get(selected.tenantId) || selected.tenantId}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {(() => {
                      const sla = deriveSlaStatus(selected);
                      return (
                        <span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${SLA_STATUS_STYLES[sla.status]}`} title={sla.label}>
                          SLA · {SLA_STATUS_LABEL[sla.status]}
                        </span>
                      );
                    })()}
                    {selected.escalated && (
                      <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded bg-red-500/10 text-red-700 border border-red-500/20">
                        Escalated
                      </span>
                    )}
                    {selected.sourceAuditEventId && (
                      <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded bg-blue-400/10 text-blue-700 border border-blue-400/20">
                        From audit · {selected.sourceAuditEventId}
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={closeDrawer} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Status</label>
                    <select value={selected.status} onChange={e => changeStatus(selected, e.target.value as SupportCaseStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                      {(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as SupportCaseStatus[]).map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Severity</label>
                    <select value={selected.severity} onChange={e => changeSeverity(selected, e.target.value as SupportCaseSeverity)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                      {(['low', 'normal', 'high', 'urgent'] as SupportCaseSeverity[]).map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Assignee</label>
                    <input
                      defaultValue={selected.assignee || ''}
                      onBlur={e => changeAssignee(selected, e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                      placeholder="Unassigned"
                    />
                  </div>
                </div>

                {selected.description && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Description</p>
                    <p className="text-sm text-slate-700 bg-slate-50 p-4 rounded-2xl whitespace-pre-wrap">{selected.description}</p>
                  </div>
                )}

                {/* Escalation row */}
                <div className="p-4 rounded-2xl border border-slate-100 bg-slate-50/40">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Escalation</p>
                      {selected.escalated ? (
                        <>
                          <p className="text-sm font-bold text-red-700 mt-1">Escalated</p>
                          {selected.escalationReason && (
                            <p className="text-xs text-slate-600 mt-0.5">Reason: {selected.escalationReason}</p>
                          )}
                          {selected.escalatedAt && (
                            <p className="text-[10px] text-slate-400 mt-0.5">at {new Date(selected.escalatedAt).toLocaleString()} by {selected.escalatedBy || '—'}</p>
                          )}
                        </>
                      ) : (
                        <p className="text-sm font-bold text-slate-600 mt-1">Not escalated</p>
                      )}
                    </div>
                    {selected.escalated ? (
                      <button onClick={() => deescalateCase(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">De-escalate</button>
                    ) : (
                      <button onClick={() => { setEscalateReason(''); setEscalateOpen(true); }} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white bg-red-500/90 rounded-xl hover:bg-red-500">Escalate</button>
                    )}
                  </div>
                </div>

                {/* Tenant Health mini-card */}
                {tenantRiskForSelected && (
                  <div className="p-4 rounded-2xl border border-slate-100 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Tenant Health</p>
                      <span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${RISK_STATUS_STYLES[tenantRiskForSelected.status]}`}>
                        {RISK_STATUS_LABEL[tenantRiskForSelected.status]} · score {tenantRiskForSelected.score}
                      </span>
                    </div>
                    <ul className="text-xs text-slate-600 list-disc pl-5 space-y-0.5">
                      {(tenantRiskForSelected.signals || []).length === 0 && <li>No active risk signals.</li>}
                      {(tenantRiskForSelected.signals || []).map(r => <li key={r}>{r}</li>)}
                    </ul>
                    <p className="text-[9px] text-slate-400 mt-2 italic">Risk derived from support/audit/domain signals available in this system.</p>
                  </div>
                )}

                {/* Phase 1.1.1 UX Correction — Related Entities grouped into 3 cards (Source / Audits / Domains). */}
                <div className="space-y-3" data-testid="support-related-entities">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Related Entities</p>

                  {/* Source audit event */}
                  <div
                    className="rounded-2xl border border-blue-400/20 bg-white overflow-hidden"
                    data-testid="support-related-source-event"
                  >
                    <div className="px-4 py-2 bg-blue-400/10 border-b border-blue-400/20 flex items-center gap-2">
                      <span className="material-symbols-outlined text-base text-blue-700">history</span>
                      <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">Source Audit Event</p>
                    </div>
                    <div className="p-4">
                      {relatedForSelected.sourceEvent ? (
                        <>
                          <p className="text-xs font-bold text-slate-700">{relatedForSelected.sourceEvent.action}</p>
                          <p className="text-[10px] text-slate-500 mt-0.5">
                            {relatedForSelected.sourceEvent.target} · {relatedForSelected.sourceEvent.date}
                          </p>
                        </>
                      ) : (
                        <p className="text-[11px] text-slate-400 font-bold">No source audit event linked.</p>
                      )}
                    </div>
                  </div>

                  {/* Recent tenant audits */}
                  <div
                    className="rounded-2xl border border-slate-200 bg-white overflow-hidden"
                    data-testid="support-related-audits"
                  >
                    <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-base text-slate-600">fact_check</span>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">Recent Tenant Audits</p>
                      </div>
                      <span className="text-[10px] font-black text-slate-500 bg-white px-1.5 py-0.5 rounded-md border border-slate-200">
                        {relatedForSelected.audits.length}
                      </span>
                    </div>
                    <div className="p-4">
                      {relatedForSelected.audits.length === 0 ? (
                        <p className="text-[11px] text-slate-400 font-bold">No recent audits for this tenant.</p>
                      ) : (
                        <ul className="space-y-1">
                          {relatedForSelected.audits.map(a => (
                            <li key={a.id} className="text-xs text-slate-600">
                              <span className="font-bold">{a.action}</span> · {a.target}{' '}
                              <span className="text-slate-400">({a.date})</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {/* Tenant domains */}
                  <div
                    className="rounded-2xl border border-emerald-400/20 bg-white overflow-hidden"
                    data-testid="support-related-domains"
                  >
                    <div className="px-4 py-2 bg-emerald-400/10 border-b border-emerald-400/20 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-base text-emerald-700">dns</span>
                        <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Tenant Domains</p>
                      </div>
                      <span className="text-[10px] font-black text-emerald-700/80 bg-white px-1.5 py-0.5 rounded-md border border-emerald-400/20">
                        {relatedForSelected.domains.length}
                      </span>
                    </div>
                    <div className="p-4">
                      {relatedForSelected.domains.length === 0 ? (
                        <p className="text-[11px] text-slate-400 font-bold">No domains configured for this tenant.</p>
                      ) : (
                        <ul className="space-y-1">
                          {relatedForSelected.domains.map(d => (
                            <li key={d.id} className="text-xs text-slate-600">
                              <span className="font-bold">{d.hostname}</span> · {d.kind} · status {d.status} · SSL {d.ssl}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Timeline ({(selected.notes || []).length})</p>
                  <NotesTimeline notes={selected.notes || []} />
                </div>

                <NoteComposer
                  caseId={selected.id}
                  macros={supportMacros}
                  onAdd={body => addNote(selected.id, body)}
                  onInsertMacro={(macro, currentDraft, setDraft) => insertMacro(selected.id, macro, currentDraft, setDraft)}
                />

                {/* Close / Reopen */}
                <div className="flex gap-2 pt-3 border-t border-slate-100">
                  {selected.status !== 'closed' ? (
                    <button onClick={() => closeCase(selected)} className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">Close case</button>
                  ) : (
                    <button onClick={() => reopenCase(selected)} className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white bg-primary rounded-xl hover:bg-primary/90">Reopen case</button>
                  )}
                </div>

                <div className="text-[10px] text-slate-400 pt-4 border-t border-slate-100 grid grid-cols-2 gap-2">
                  <div>Opened: <span className="font-bold text-slate-600">{selected.openedAt}</span></div>
                  <div>Updated: <span className="font-bold text-slate-600">{selected.updatedAt}</span></div>
                  {selected.firstResponseDueAt && <div>First response due: <span className="font-bold text-slate-600">{selected.firstResponseDueAt.slice(0, 10)}</span></div>}
                  {selected.resolutionDueAt && <div>Resolution due: <span className="font-bold text-slate-600">{selected.resolutionDueAt.slice(0, 10)}</span></div>}
                  {selected.firstRespondedAt && <div>First responded: <span className="font-bold text-slate-600">{selected.firstRespondedAt.slice(0, 10)}</span></div>}
                  {selected.resolvedAt && <div>Resolved: <span className="font-bold text-slate-600">{selected.resolvedAt.slice(0, 10)}</span></div>}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Escalate modal */}
      <AnimatePresence>
        {escalateOpen && selected && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setEscalateOpen(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Escalate Case</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{selected.id} · {selected.subject}</p>
              </div>
              <div className="p-7">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Reason</label>
                <textarea value={escalateReason} onChange={e => setEscalateReason(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-700 h-28 resize-none" placeholder="Why is this being escalated?" />
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setEscalateOpen(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button onClick={() => { escalateCase(selected, escalateReason.trim()); setEscalateOpen(false); }} className="px-6 py-2.5 bg-red-500/90 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-red-500">Escalate</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const NotesTimeline: React.FC<{ notes: SupportCaseNote[] }> = ({ notes }) => {
  if (notes.length === 0) return <p className="text-xs text-slate-400 font-bold py-4 text-center bg-slate-50 rounded-2xl">No notes yet.</p>;
  return (
    <div className="space-y-2">
      {notes.map(n => (
        <div key={n.id} className={`p-3 rounded-xl border ${n.kind === 'status_change' ? 'bg-blue-400/5 border-blue-400/20' : 'bg-slate-50 border-slate-100'}`}>
          <p className="text-sm text-slate-700">{n.body}</p>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">{n.author} · {new Date(n.createdAt).toLocaleString()}</p>
        </div>
      ))}
    </div>
  );
};

interface NoteComposerProps {
  caseId: string;
  macros: SupportMacro[];
  onAdd: (body: string) => void;
  onInsertMacro: (macro: SupportMacro, currentDraft: string, setDraft: (s: string) => void) => void;
}
const NoteComposer: React.FC<NoteComposerProps> = ({ caseId, macros, onAdd, onInsertMacro }) => {
  const [body, setBody] = useState('');
  const [macroId, setMacroId] = useState('');
  // Reset draft when switching to a different case.
  useEffect(() => { setBody(''); setMacroId(''); }, [caseId]);
  // Phase 1.1.1 UX Correction — 2-step macro UX: pick → preview → Insert Template.
  const previewMacro = macros.find(m => m.id === macroId);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Templates</span>
        <select
          value={macroId}
          onChange={e => setMacroId(e.target.value)}
          data-testid="support-macro-picker"
          className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
        >
          <option value="">Select template…</option>
          {macros.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span className="text-[10px] text-slate-400 italic">Internal template only — no external message sent.</span>
      </div>
      {previewMacro && (
        <div
          className="p-3 rounded-xl border border-blue-400/20 bg-blue-400/5 space-y-2"
          data-testid="support-macro-preview"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">
              Preview · {previewMacro.label}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMacroId('')}
                className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-lg hover:bg-white"
              >
                Cancel
              </button>
              <button
                onClick={() => { onInsertMacro(previewMacro, body, setBody); setMacroId(''); }}
                data-testid="support-macro-insert"
                className="px-3 py-1.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-lg hover:bg-primary/90"
              >
                Insert Template
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-700 whitespace-pre-wrap line-clamp-4">{previewMacro.body}</p>
        </div>
      )}
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Add internal note…"
        className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 h-24 resize-none"
      />
      <div className="flex justify-end">
        <button
          onClick={() => { onAdd(body); setBody(''); setMacroId(''); }}
          disabled={!body.trim()}
          className="px-4 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 disabled:opacity-40 transition-all"
        >
          Add Note
        </button>
      </div>
    </div>
  );
};

export default SupportToolsPage;
