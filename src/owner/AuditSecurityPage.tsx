import React, { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  auditLogs,
  tenants,
  tenantDomains,
  supportCases as supportCasesSeed,
  type SupportCaseRecord,
  type SupportCaseSeverity,
} from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';
import { useAccess } from '../context/AccessContext';
import {
  hasPlatformPermission,
} from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import {
  deriveHighRiskFlag,
  HIGH_RISK_FLAG_LABEL,
  HIGH_RISK_FLAG_STYLES,
  AUDIT_CSV_COLUMNS,
  toCsv,
  downloadCsv,
} from './platformOpsDerive';
import {
  toInvestigationEvent,
  applyAuditSearch,
  countForLens,
  getAuditLens,
  isDefaultAuditQuery,
  readAuditReviewState,
  deriveAuditRiskSignals,
  deriveAuditActorProfile,
  deriveEntityTimeline,
  deriveCorrelatedGroups,
  AUDIT_INVESTIGATION_LENSES,
  AUDIT_INVESTIGATION_TRUTH_LABEL,
  AUDIT_CORRELATION_TRUTH_LABEL,
  AUDIT_REVIEW_STATUS_LABEL,
  EMPTY_AUDIT_SEARCH_QUERY,
  type AuditInvestigationEvent,
  type AuditActorProfile,
  type AuditEntityTimeline,
  type AuditRelatedEventGroup,
  type AuditSearchQueryState,
  type AuditSearchContext,
  type AuditSourceSurface,
  type AuditReviewStatus,
  type AuditReviewState,
} from './platformOpsInvestigation';

type Severity = 'info' | 'notice' | 'warning' | 'critical';

type AuditRow = {
  id: string;
  date: string;
  actor: string;
  action: string;
  target: string;
  severity: string;
  category?: string;
  tenantId?: string | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
};

type SecurityNote = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  linkedEventId?: string | null;
};

const NOTES_KEY = 'platform_security_notes';
const CASES_KEY = 'support_cases_v1';

const SEVERITY_TO_AUDIT_CASE: Record<SupportCaseSeverity, Severity> = {
  low: 'info',
  normal: 'info',
  high: 'warning',
  urgent: 'critical',
};

const SEVERITY_STYLES: Record<Severity, string> = {
  info: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  notice: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  warning: 'bg-orange-400/10 text-orange-700 border-orange-400/20',
  critical: 'bg-red-500/10 text-red-700 border-red-500/30',
};

const normalizeSeverity = (s: string): Severity => {
  if (s === 'notice' || s === 'warning' || s === 'critical') return s;
  return 'info';
};

const AuditSecurityPage: React.FC = () => {
  // Phase 1.1.3A correction — pull active platform role from the Dev Session
  // and use it to gate sensitive actions (CSV export, security note add /
  // delete, "Create Support Case from Event") via the platform permissions
  // catalog. The page is read-accessible to all platform roles by default
  // (controlled in the Global Permissions Matrix).
  const { session } = useAccess();
  const sessionRole = (session?.role as Role | undefined) || null;
  const viewAuditLogsGate = hasPlatformPermission(sessionRole, 'view_audit_logs');
  const exportGate = hasPlatformPermission(sessionRole, 'export_audit_csv');
  const addNoteGate = hasPlatformPermission(sessionRole, 'add_security_note');
  const deleteNoteGate = hasPlatformPermission(sessionRole, 'delete_security_note');
  const createCaseFromAuditGate = hasPlatformPermission(sessionRole, 'create_support_case_from_audit');
  const createCaseGate = hasPlatformPermission(sessionRole, 'create_support_case');
  // Pre-QA correction — wire 4 Audit & Security sub-permissions explicitly.
  const viewActorProfileGate = hasPlatformPermission(sessionRole, 'view_actor_profile');
  const viewRelatedEventTimelineGate = hasPlatformPermission(sessionRole, 'view_related_event_timeline');
  const viewRestrictedDetailsGate = hasPlatformPermission(sessionRole, 'view_restricted_audit_details');
  const viewEscalationLifecycleGate = hasPlatformPermission(sessionRole, 'view_escalation_lifecycle_audit');

  // Mirrored cross-cutting audit entries (commercial + platform ops).
  const [mirrored, setMirrored] = useState<AuditRow[]>([]);
  useEffect(() => {
    const read = () => {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return;
        const raw = window.sessionStorage.getItem('audit_logs');
        if (!raw) { setMirrored([]); return; }
        const arr = JSON.parse(raw) as AuditRow[];
        setMirrored(Array.isArray(arr) ? arr : []);
      } catch { setMirrored([]); }
    };
    read();
    window.addEventListener('audit_logs:changed', read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener('audit_logs:changed', read);
      window.removeEventListener('storage', read);
    };
  }, []);

  // Persistent platform security notes (sessionStorage).
  const [notes, setNotes] = useState<SecurityNote[]>([]);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(NOTES_KEY);
      if (raw) setNotes(JSON.parse(raw));
    } catch { /* noop */ }
  }, []);
  const persistNotes = (next: SecurityNote[]) => {
    setNotes(next);
    try { window.sessionStorage.setItem(NOTES_KEY, JSON.stringify(next)); } catch { /* noop */ }
  };

  // Filters — Phase 1.1.3D consolidates all audit filters into a single
  // AuditSearchQueryState so one predicate drives both counts and the list
  // (no drift, no invisible filters). The active investigation lens is a
  // separate scope applied on top of (and shown alongside) these filters.
  const [query, setQuery] = useState<AuditSearchQueryState>({ ...EMPTY_AUDIT_SEARCH_QUERY });
  const [activeLens, setActiveLens] = useState<string>('all');
  const patchQuery = (patch: Partial<AuditSearchQueryState>) => setQuery(q => ({ ...q, ...patch }));
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [newNoteBody, setNewNoteBody] = useState('');
  const [drawerTab, setDrawerTab] = useState<'detail' | 'related' | 'timeline' | 'actor'>('detail');
  // Expanded correlated-event group (page-level Correlated Event Groups panel).
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [showCreateCase, setShowCreateCase] = useState(false);
  const [linkedNoteEventId, setLinkedNoteEventId] = useState<string | null>(null);
  const [pendingDeleteNoteId, setPendingDeleteNoteId] = useState<string | null>(null);

  // Persisted support cases (so we can show "linked support case" badges
  // when an event has been used as the source of a case).
  const [cases, setCases] = useState<SupportCaseRecord[]>([]);
  useEffect(() => {
    const read = () => {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) {
          setCases(supportCasesSeed);
          return;
        }
        const raw = window.sessionStorage.getItem(CASES_KEY);
        setCases(raw ? (JSON.parse(raw) as SupportCaseRecord[]) : supportCasesSeed);
      } catch {
        setCases(supportCasesSeed);
      }
    };
    read();
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, []);

  const linkedCaseByEvent = useMemo(() => {
    const m = new Map<string, SupportCaseRecord>();
    cases.forEach(c => { if (c.sourceAuditEventId) m.set(c.sourceAuditEventId, c); });
    return m;
  }, [cases]);

  // Read-only investigation review overlay (review status). Writes land in
  // the review milestone; here it only powers the Needs Review lens + review
  // filter (events with no record default to "needs review").
  const [reviewState, setReviewState] = useState<Record<string, AuditReviewState>>({});
  useEffect(() => {
    const read = () => setReviewState(readAuditReviewState());
    read();
    window.addEventListener('audit_investigation:changed', read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener('audit_investigation:changed', read);
      window.removeEventListener('storage', read);
    };
  }, []);

  const allRows = useMemo<AuditRow[]>(() => {
    const seedIds = new Set(auditLogs.map(l => l.id));
    const merged: AuditRow[] = [
      ...mirrored.filter(m => !seedIds.has(m.id)),
      ...auditLogs.map(l => ({ ...l })),
    ];
    return merged.sort((a, b) =>
      a.date === b.date ? b.id.localeCompare(a.id) : a.date < b.date ? 1 : -1
    );
  }, [mirrored]);

  // Normalized, derived investigation events (1:1 with allRows by id). Used
  // for all filtering, lens counts, and search so counts and the visible list
  // can never disagree.
  const investigationEvents = useMemo<AuditInvestigationEvent[]>(
    () => allRows.map(toInvestigationEvent),
    [allRows]
  );

  // Map id → raw row so derived investigation events can resolve back to the
  // AuditRow the drawer/table use as their selection unit.
  const rowById = useMemo(() => {
    const m = new Map<string, AuditRow>();
    allRows.forEach(r => m.set(r.id, r));
    return m;
  }, [allRows]);

  // The selected event as a normalized investigation event — drives actor
  // profile, entity timeline, and rule-based risk signals.
  const selectedInvEvent = useMemo<AuditInvestigationEvent | null>(
    () => (selected ? investigationEvents.find(e => e.id === selected.id) ?? toInvestigationEvent(selected) : null),
    [selected, investigationEvents]
  );

  const linkedCaseEventIds = useMemo(
    () => new Set(linkedCaseByEvent.keys()),
    [linkedCaseByEvent]
  );

  const actorEventCounts = useMemo(() => {
    const m = new Map<string, number>();
    investigationEvents.forEach(e => m.set(e.actor, (m.get(e.actor) || 0) + 1));
    return m;
  }, [investigationEvents]);

  const searchCtx = useMemo<AuditSearchContext>(
    () => ({
      linkedCaseEventIds,
      reviewState,
      actorEventCounts,
      nowDayIndex: Math.floor(Date.now() / 86_400_000),
    }),
    [linkedCaseEventIds, reviewState, actorEventCounts]
  );

  const activeLensDef = useMemo(() => getAuditLens(activeLens), [activeLens]);

  // Single source of truth for the visible set: apply the search query, then
  // the active lens predicate. visibleRows maps back to raw rows by id so the
  // existing table/drawer keep working unchanged.
  const visibleEvents = useMemo(
    () =>
      applyAuditSearch(investigationEvents, query, searchCtx).filter(e =>
        activeLensDef.predicate(e, searchCtx)
      ),
    [investigationEvents, query, searchCtx, activeLensDef]
  );

  const visibleRows = useMemo(() => {
    const ids = new Set(visibleEvents.map(e => e.id));
    return allRows.filter(r => ids.has(r.id));
  }, [allRows, visibleEvents]);

  // Distinct option lists for the filter selects (truthful — derived from the
  // events actually present in the current stream).
  const actorOptions = useMemo(
    () => Array.from(new Set<string>(investigationEvents.map(e => e.actor))).sort((a, b) => a.localeCompare(b)),
    [investigationEvents]
  );
  const actionTypeOptions = useMemo(
    () => Array.from(new Set<string>(investigationEvents.map(e => e.action))).sort((a, b) => a.localeCompare(b)),
    [investigationEvents]
  );
  const sourceSurfaceOptions = useMemo(
    () => Array.from(new Set<AuditSourceSurface>(investigationEvents.map(e => e.sourceSurface))).sort((a, b) => a.localeCompare(b)),
    [investigationEvents]
  );

  const selectLens = (id: string) => {
    setActiveLens(id);
    // Reset ad-hoc filters so the visible list matches the lens card count
    // exactly when a lens is chosen (no hidden residual filters).
    setQuery({ ...EMPTY_AUDIT_SEARCH_QUERY });
  };

  const clearAllFilters = () => {
    setActiveLens('all');
    setQuery({ ...EMPTY_AUDIT_SEARCH_QUERY });
  };

  const hasActiveFilters = !isDefaultAuditQuery(query) || activeLens !== 'all';

  const tenantNameById = useMemo(() => {
    const m = new Map<string, string>();
    tenants.forEach(t => m.set(t.id, t.name));
    return m;
  }, []);

  // CSV export — whitelisted, safe-fields only.
  const exportCsv = () => {
    if (!exportGate.allowed) return;
    const rows = visibleRows.map(r => {
      const { flag } = deriveHighRiskFlag(r);
      return {
        timestamp: r.date,
        severity: normalizeSeverity(r.severity),
        category: r.category || '',
        action: r.action,
        actor: r.actor,
        tenant: r.tenantId ? tenantNameById.get(r.tenantId) || r.tenantId : '',
        target: r.target,
        flag: flag || '',
        note: r.note || '',
      };
    });
    const csv = toCsv(rows, AUDIT_CSV_COLUMNS as unknown as string[]);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadCsv(`platform-audit-${stamp}.csv`, csv);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'audit_view_exported',
      target: `${rows.length} row${rows.length !== 1 ? 's' : ''}${activeLens !== 'all' ? ` · lens=${activeLens}` : ''}`,
      category: 'configuration',
    });
  };

  // Related events for the open drawer (same tenant + same target + same actor).
  const relatedEvents = useMemo<AuditRow[]>(() => {
    if (!selected) return [];
    return allRows
      .filter(r => r.id !== selected.id)
      .filter(r =>
        (selected.tenantId && r.tenantId === selected.tenantId) ||
        (selected.target && r.target === selected.target) ||
        (selected.actor && r.actor === selected.actor)
      )
      .slice(0, 12);
  }, [allRows, selected]);

  // Actor profile — rule-based derivation over the normalized investigation
  // events so the actor tab and the detail actor-context block share one source.
  const actorProfile = useMemo<AuditActorProfile | null>(() => {
    if (!selectedInvEvent) return null;
    return deriveAuditActorProfile(selectedInvEvent.actor, investigationEvents, selectedInvEvent);
  }, [investigationEvents, selectedInvEvent]);

  // Rule-based "why this matters" signals for the selected event.
  const selectedRiskSignals = useMemo(
    () => (selectedInvEvent ? deriveAuditRiskSignals(selectedInvEvent, investigationEvents) : []),
    [selectedInvEvent, investigationEvents]
  );

  // Related entity timeline (same tenant/target) sorted chronologically with the
  // selected event highlighted. UI gated by view_related_event_timeline.
  const entityTimeline = useMemo<AuditEntityTimeline | null>(
    () => (selectedInvEvent ? deriveEntityTimeline(selectedInvEvent, investigationEvents, tenantNameById) : null),
    [selectedInvEvent, investigationEvents, tenantNameById]
  );

  // Rule-based correlated event groups across the current audit data. Each
  // group's count and member list both derive from group.eventIds (no drift).
  const correlatedGroups = useMemo<AuditRelatedEventGroup[]>(
    () => deriveCorrelatedGroups(investigationEvents),
    [investigationEvents]
  );

  // Create-from-event modal draft state.
  const [caseDraft, setCaseDraft] = useState({
    tenantId: '',
    subject: '',
    description: '',
    severity: 'normal' as SupportCaseSeverity,
  });
  useEffect(() => {
    if (!selected || !showCreateCase) return;
    setCaseDraft({
      tenantId: selected.tenantId || '',
      subject: `[Audit] ${selected.action} — ${selected.target}`,
      description: `Auto-prefilled from audit event ${selected.id} on ${selected.date}.\nActor: ${selected.actor}\nSeverity: ${normalizeSeverity(selected.severity)}\nCategory: ${selected.category || '—'}${selected.note ? `\nNote: ${selected.note}` : ''}`,
      severity:
        normalizeSeverity(selected.severity) === 'critical' ? 'urgent'
        : normalizeSeverity(selected.severity) === 'warning' ? 'high'
        : 'normal',
    });
  }, [selected, showCreateCase]);

  const persistCases = (next: SupportCaseRecord[]) => {
    setCases(next);
    try { window.sessionStorage.setItem(CASES_KEY, JSON.stringify(next)); } catch { /* noop */ }
  };

  const createCaseFromEvent = () => {
    if (!selected) return;
    if (!caseDraft.tenantId || !caseDraft.subject.trim()) return;
    const now = new Date();
    const newCase: SupportCaseRecord = {
      id: `case_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: caseDraft.tenantId,
      subject: caseDraft.subject.trim(),
      description: caseDraft.description.trim(),
      status: 'open',
      severity: caseDraft.severity,
      assignee: null,
      openedAt: now.toISOString().slice(0, 10),
      updatedAt: now.toISOString().slice(0, 10),
      notes: [],
      sourceAuditEventId: selected.id,
    };
    persistCases([newCase, ...cases]);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_created_from_audit',
      target: `${tenantNameById.get(caseDraft.tenantId) || caseDraft.tenantId} · ${newCase.subject}`,
      category: 'support',
      tenantId: caseDraft.tenantId,
      severity: SEVERITY_TO_AUDIT_CASE[caseDraft.severity],
      note: `From event ${selected.id}`,
    });
    setShowCreateCase(false);
  };

  const sslCoverage = useMemo(() => {
    const total = tenantDomains.length;
    const active = tenantDomains.filter(d => d.ssl === 'active').length;
    return { total, active, pct: total ? Math.round((active / total) * 100) : 0 };
  }, []);

  const openCases = useMemo(
    () => cases.filter(c => c.status !== 'closed' && c.status !== 'resolved').length,
    [cases]
  );

  const recentCritical = useMemo(
    () => allRows.filter(r => normalizeSeverity(r.severity) === 'critical' || normalizeSeverity(r.severity) === 'warning').slice(0, 5).length,
    [allRows]
  );

  // Phase 1.1.1 — severity summary strip (visual polish, no filter change).
  const severitySummary = useMemo(() => {
    const counts = { info: 0, notice: 0, warning: 0, critical: 0 };
    allRows.forEach(r => {
      const s = normalizeSeverity(r.severity);
      if (s in counts) counts[s as keyof typeof counts]++;
    });
    const total = counts.info + counts.notice + counts.warning + counts.critical;
    return { counts, total };
  }, [allRows]);

  const addNote = (linkedEventIdOverride?: string | null) => {
    if (!addNoteGate.allowed) return;
    const body = newNoteBody.trim();
    if (!body) return;
    const note: SecurityNote = {
      id: `sn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      body,
      author: 'System Owner',
      createdAt: new Date().toISOString(),
      linkedEventId: linkedEventIdOverride ?? linkedNoteEventId ?? null,
    };
    persistNotes([note, ...notes]);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'security_note_added',
      target: body.length > 60 ? `${body.slice(0, 60)}…` : body,
      category: 'security',
      severity: 'notice',
      note: note.linkedEventId ? `Linked event: ${note.linkedEventId}` : undefined,
    });
    setNewNoteBody('');
    setLinkedNoteEventId(null);
  };

  const requestDeleteNote = (id: string) => setPendingDeleteNoteId(id);

  const cancelDeleteNote = () => setPendingDeleteNoteId(null);

  const confirmDeleteNote = () => {
    const id = pendingDeleteNoteId;
    if (!id) return;
    if (!deleteNoteGate.allowed) { setPendingDeleteNoteId(null); return; }
    const target = notes.find(n => n.id === id);
    persistNotes(notes.filter(n => n.id !== id));
    if (target) {
      pushPlatformAudit({
        actor: 'System Owner',
        action: 'security_note_deleted',
        target: target.body.length > 60 ? `${target.body.slice(0, 60)}…` : target.body,
        category: 'security',
      });
    }
    setPendingDeleteNoteId(null);
  };

  const pendingDeleteNote = useMemo(
    () => (pendingDeleteNoteId ? notes.find(n => n.id === pendingDeleteNoteId) || null : null),
    [pendingDeleteNoteId, notes]
  );

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Audit & Security</h2>
        <p className="text-slate-500 font-medium">Monitor platform activity, security posture, and recent events.</p>
        <p className="mt-1 text-[10px] font-medium text-slate-500">
          Sensitive actions are gated by the Global Permissions Matrix.
        </p>
      </div>

      {/* Posture cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Auth Governance</p>
          <p className="text-2xl font-black text-primary mb-1">Directory only</p>
          <p className="text-xs font-medium text-slate-500">SSO / MFA not enforced by app — see Platform Settings.</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">SSL Coverage</p>
          <p className="text-2xl font-black text-primary mb-1">{sslCoverage.active}/{sslCoverage.total} <span className="text-sm text-slate-400">({sslCoverage.pct}%)</span></p>
          <p className="text-xs font-medium text-slate-500">Domains with active SSL — manual workflow.</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Open Support Cases</p>
          <p className="text-2xl font-black text-primary mb-1">{openCases}</p>
          <p className="text-xs font-medium text-slate-500">Cases not yet resolved or closed.</p>
        </div>
        <div className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Elevated Events (recent)</p>
          <p className="text-2xl font-black text-primary mb-1">{recentCritical}</p>
          <p className="text-xs font-medium text-slate-500">Warning + critical entries in audit stream.</p>
        </div>
      </div>

      {/* Phase 1.1.1 — Severity Summary Strip (visual; informational only) */}
      <div className="bg-white/80 backdrop-blur-xl p-5 rounded-[2rem] border border-slate-200 shadow-sm" data-testid="audit-severity-summary">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Audit Severity Summary</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Distribution across the full audit stream — informational, does not change current filters.</p>
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{severitySummary.total} events</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['info', 'notice', 'warning', 'critical'] as const).map(sev => {
            const v = severitySummary.counts[sev];
            const pct = severitySummary.total ? Math.round((v / severitySummary.total) * 100) : 0;
            const tone =
              sev === 'critical' ? 'text-red-700 bg-red-500'
              : sev === 'warning' ? 'text-amber-700 bg-amber-500'
              : sev === 'notice' ? 'text-blue-700 bg-blue-500'
              : 'text-slate-700 bg-slate-400';
            const [textTone, barTone] = tone.split(' ');
            return (
              <div key={sev} data-testid={`audit-severity-strip-${sev}`}>
                <div className="flex items-baseline justify-between mb-1">
                  <span className={`text-[10px] font-black uppercase tracking-widest ${textTone}`}>{sev}</span>
                  <span className="text-sm font-black text-slate-900">{v} <span className="text-xs text-slate-400 font-medium">· {pct}%</span></span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full ${barTone} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm space-y-4">
        {/* Phase 1.1.3D — investigation lens cards. Each card's count and the
            list it produces share one predicate (no drift). Selecting a lens
            resets ad-hoc filters so the list matches the card count exactly. */}
        <div className="space-y-2" data-testid="audit-saved-views">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Investigation Lenses</p>
            <p className="text-[10px] font-bold text-slate-400">Tap a lens to scope the stream · counts and list use one predicate.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {AUDIT_INVESTIGATION_LENSES.map(lens => {
              const count = countForLens(lens, investigationEvents, searchCtx);
              const isActive = activeLens === lens.id;
              return (
                <button
                  key={lens.id}
                  data-testid={`audit-saved-view-${lens.id}`}
                  data-active={isActive ? 'true' : 'false'}
                  onClick={() => selectLens(lens.id)}
                  title={lens.description}
                  className={`text-left p-3 rounded-2xl border transition-all hover:-translate-y-0.5 active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                    isActive
                      ? 'border-primary ring-2 ring-primary/30 bg-primary/5 shadow-md'
                      : 'border-slate-200 bg-white hover:border-primary/30 hover:bg-primary/5'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className={`material-symbols-outlined text-base ${isActive ? 'text-primary' : 'text-slate-500'}`}>
                      {lens.icon}
                    </span>
                    <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-md ${isActive ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600'}`}>
                      {count}
                    </span>
                  </div>
                  <p className={`text-[11px] font-black uppercase tracking-widest leading-tight ${isActive ? 'text-primary' : 'text-slate-700'}`}>
                    {lens.label}
                  </p>
                  <p className="text-[9px] font-semibold text-slate-400 leading-tight mt-1 normal-case tracking-normal">
                    {lens.description}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            value={query.keyword}
            onChange={e => patchQuery({ keyword: e.target.value })}
            placeholder="Search action, target, actor, note…"
            data-testid="audit-search-input"
            className="flex-1 min-w-[200px] px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-700"
          />
          <button onClick={exportCsv} disabled={!exportGate.allowed} title={exportGate.allowed ? '' : exportGate.reason} data-testid="audit-export-csv-top" className="px-4 py-2.5 bg-white border border-slate-200 text-slate-700 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/5 hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            Export CSV ({visibleRows.length})
          </button>
        </div>
        <p className="text-[10px] font-semibold text-slate-400 -mt-1">{AUDIT_INVESTIGATION_TRUTH_LABEL}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <select value={query.severity} onChange={e => patchQuery({ severity: e.target.value as AuditSearchQueryState['severity'] })} data-testid="audit-filter-severity" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">All severities</option>
            <option value="info">Info</option>
            <option value="notice">Notice</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select value={query.timeRange} onChange={e => patchQuery({ timeRange: e.target.value as AuditSearchQueryState['timeRange'] })} data-testid="audit-filter-timerange" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <select value={query.tenantId} onChange={e => patchQuery({ tenantId: e.target.value })} data-testid="audit-filter-tenant" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">All tenants</option>
            {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={query.actor} onChange={e => patchQuery({ actor: e.target.value })} data-testid="audit-filter-actor" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">All actors</option>
            {actorOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={query.actionType} onChange={e => patchQuery({ actionType: e.target.value })} data-testid="audit-filter-action" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">All actions</option>
            {actionTypeOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={query.sourceSurface} onChange={e => patchQuery({ sourceSurface: e.target.value as AuditSearchQueryState['sourceSurface'] })} data-testid="audit-filter-source" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">All sources (derived)</option>
            {sourceSurfaceOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={query.review} onChange={e => patchQuery({ review: e.target.value as AuditSearchQueryState['review'] })} data-testid="audit-filter-review" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">All review states</option>
            <option value="needs_review">{AUDIT_REVIEW_STATUS_LABEL.needs_review}</option>
            <option value="reviewed">{AUDIT_REVIEW_STATUS_LABEL.reviewed}</option>
            <option value="dismissed">{AUDIT_REVIEW_STATUS_LABEL.dismissed}</option>
          </select>
          <select value={query.linkedCase} onChange={e => patchQuery({ linkedCase: e.target.value as AuditSearchQueryState['linkedCase'] })} data-testid="audit-filter-linked" className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-600">
            <option value="all">Linked &amp; unlinked</option>
            <option value="linked">Linked to a case</option>
            <option value="unlinked">Not linked</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-600 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer">
            <input type="checkbox" checked={query.highRiskOnly} onChange={e => patchQuery({ highRiskOnly: e.target.checked })} data-testid="audit-filter-highrisk" />
            High-risk only
          </label>
          <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-600 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer">
            <input type="checkbox" checked={query.restricted === 'restricted_only'} onChange={e => patchQuery({ restricted: e.target.checked ? 'restricted_only' : 'all' })} data-testid="audit-filter-restricted" />
            Restricted details only
          </label>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Category</span>
          {(['all', 'commercial', 'security', 'support', 'configuration', 'domains', 'team', 'other'] as const).map(c => (
            <button
              key={c}
              onClick={() => patchQuery({ category: c })}
              className={`px-3.5 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all ${query.category === c ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Phase 1.1.3D — Audit Command Bar. Every active filter is shown as a
          removable chip (no invisible filters); the active lens shows its
          "why included" description. Reset all clears lens + filters. */}
      {(() => {
        type Chip = { key: string; label: string; clear: () => void };
        const chips: Chip[] = [];
        if (activeLens !== 'all') {
          chips.push({ key: 'lens', label: `Lens · ${activeLensDef.label}`, clear: () => setActiveLens('all') });
        }
        if (query.keyword.trim()) {
          chips.push({ key: 'keyword', label: `Search · "${query.keyword.trim()}"`, clear: () => patchQuery({ keyword: '' }) });
        }
        if (query.severity !== 'all') {
          chips.push({ key: 'severity', label: `Severity · ${query.severity}`, clear: () => patchQuery({ severity: 'all' }) });
        }
        if (query.timeRange !== 'all') {
          chips.push({ key: 'timeRange', label: `Time · ${query.timeRange}`, clear: () => patchQuery({ timeRange: 'all' }) });
        }
        if (query.category !== 'all') {
          chips.push({ key: 'category', label: `Category · ${query.category}`, clear: () => patchQuery({ category: 'all' }) });
        }
        if (query.tenantId !== 'all') {
          chips.push({ key: 'tenant', label: `Tenant · ${tenants.find(t => t.id === query.tenantId)?.name || query.tenantId}`, clear: () => patchQuery({ tenantId: 'all' }) });
        }
        if (query.actor !== 'all') {
          chips.push({ key: 'actor', label: `Actor · ${query.actor}`, clear: () => patchQuery({ actor: 'all' }) });
        }
        if (query.actionType !== 'all') {
          chips.push({ key: 'action', label: `Action · ${query.actionType}`, clear: () => patchQuery({ actionType: 'all' }) });
        }
        if (query.sourceSurface !== 'all') {
          chips.push({ key: 'source', label: `Source · ${query.sourceSurface}`, clear: () => patchQuery({ sourceSurface: 'all' }) });
        }
        if (query.review !== 'all') {
          chips.push({ key: 'review', label: `Review · ${AUDIT_REVIEW_STATUS_LABEL[query.review as AuditReviewStatus]}`, clear: () => patchQuery({ review: 'all' }) });
        }
        if (query.linkedCase !== 'all') {
          chips.push({ key: 'linked', label: `Case · ${query.linkedCase === 'linked' ? 'linked' : 'not linked'}`, clear: () => patchQuery({ linkedCase: 'all' }) });
        }
        if (query.restricted !== 'all') {
          chips.push({ key: 'restricted', label: 'Restricted details only', clear: () => patchQuery({ restricted: 'all' }) });
        }
        if (query.highRiskOnly) {
          chips.push({ key: 'highRisk', label: 'High-risk only', clear: () => patchQuery({ highRiskOnly: false }) });
        }
        return (
          <div
            data-testid="audit-command-bar"
            className="bg-gradient-to-br from-primary/5 to-white p-5 rounded-[2rem] border border-primary/15 shadow-sm flex flex-wrap items-center gap-3"
          >
            <div className="flex items-center gap-3 pr-4 border-r border-slate-200">
              <span className="material-symbols-outlined text-primary">monitoring</span>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Visible</p>
                <p className="text-lg font-black text-primary leading-none">
                  {visibleRows.length}
                  <span className="text-xs font-bold text-slate-500"> / {allRows.length}</span>
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Active:</span>
                {chips.length === 0 && (
                  <span className="text-[10px] text-slate-400 italic">No filters — showing all events</span>
                )}
                {chips.map(chip => (
                  <button
                    key={chip.key}
                    onClick={chip.clear}
                    data-testid={`audit-chip-${chip.key}`}
                    title="Remove this filter"
                    className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-black text-slate-700 uppercase tracking-widest hover:border-red-300 hover:text-red-600 transition-colors"
                  >
                    {chip.label}
                    <span className="material-symbols-outlined text-xs text-slate-400 group-hover:text-red-500">close</span>
                  </button>
                ))}
              </div>
              {activeLens !== 'all' && (
                <p className="text-[10px] font-semibold text-slate-400">{activeLensDef.description}</p>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <button
                onClick={clearAllFilters}
                disabled={!hasActiveFilters}
                data-testid="audit-command-reset"
                className="px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center gap-1 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Clear the active lens and all filters."
              >
                <span className="material-symbols-outlined text-sm">filter_alt_off</span>
                Reset all
              </button>
              <button
                onClick={exportCsv}
                disabled={!exportGate.allowed}
                title={exportGate.allowed ? '' : exportGate.reason}
                data-testid="audit-command-export"
                className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 transition-colors flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-sm">download</span>
                Export CSV ({visibleRows.length})
              </button>
            </div>
          </div>
        );
      })()}

      {/* Table */}
      {viewAuditLogsGate.allowed ? (
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Actor</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Target</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Severity</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Flag</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(log => {
              const sev = normalizeSeverity(log.severity);
              const { flag } = deriveHighRiskFlag(log);
              const linkedCase = linkedCaseByEvent.get(log.id);
              return (
                <tr key={log.id} onClick={() => { setSelected(log); setDrawerTab('detail'); }} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors cursor-pointer">
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-600 whitespace-nowrap">{log.date}</td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900">{log.actor}</td>
                  <td className="px-6 py-3.5 text-sm text-slate-600">
                    {log.action}
                    {linkedCase && (
                      <Link
                        to={`/owner/support-tools?caseId=${encodeURIComponent(linkedCase.id)}`}
                        onClick={e => e.stopPropagation()}
                        data-testid={`audit-linked-case-${log.id}`}
                        title={`Open linked support case ${linkedCase.id}`}
                        className="ml-2 inline-flex px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-blue-400/10 text-blue-700 border border-blue-400/20 hover:bg-blue-400/20"
                      >
                        linked case
                      </Link>
                    )}
                  </td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-900">{log.target}</td>
                  <td className="px-6 py-3.5">
                    {log.category ? (
                      <span className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg bg-slate-100 text-slate-600 border border-slate-200">{log.category}</span>
                    ) : (
                      <span className="text-[10px] text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-3.5">
                    <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SEVERITY_STYLES[sev]}`}>{sev}</span>
                  </td>
                  <td className="px-6 py-3.5">
                    {flag ? (
                      <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${HIGH_RISK_FLAG_STYLES[flag]}`}>{HIGH_RISK_FLAG_LABEL[flag]}</span>
                    ) : (
                      <span className="text-[10px] text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr><td colSpan={7} className="px-8 py-12 text-center">
                <span className="material-symbols-outlined text-3xl text-slate-300 mb-2 block">search_off</span>
                <p className="text-slate-500 text-sm font-bold">No audit events match the current lens and filters.</p>
                {hasActiveFilters ? (
                  <p className="text-slate-400 text-xs font-semibold mt-1">
                    Active:{' '}
                    {[
                      activeLens !== 'all' && `lens "${activeLensDef.label}"`,
                      query.keyword.trim() && `search "${query.keyword.trim()}"`,
                      query.severity !== 'all' && `severity ${query.severity}`,
                      query.timeRange !== 'all' && `time ${query.timeRange}`,
                      query.category !== 'all' && `category ${query.category}`,
                      query.tenantId !== 'all' && `tenant ${tenants.find(t => t.id === query.tenantId)?.name || query.tenantId}`,
                      query.actor !== 'all' && `actor ${query.actor}`,
                      query.actionType !== 'all' && `action ${query.actionType}`,
                      query.sourceSurface !== 'all' && `source ${query.sourceSurface}`,
                      query.review !== 'all' && `review ${AUDIT_REVIEW_STATUS_LABEL[query.review as AuditReviewStatus]}`,
                      query.linkedCase !== 'all' && `${query.linkedCase === 'linked' ? 'linked' : 'not linked'} to case`,
                      query.restricted !== 'all' && 'restricted details only',
                      query.highRiskOnly && 'high-risk only',
                    ].filter(Boolean).join(' · ')}
                    . Use “Reset all” to clear.
                  </p>
                ) : (
                  <p className="text-slate-400 text-xs font-semibold mt-1">No audit events are present in the current app/session stream.</p>
                )}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      ) : (
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm p-12 text-center">
        <span className="material-symbols-outlined text-4xl text-slate-300 mb-3 block">lock</span>
        <p className="text-sm font-bold text-slate-500">Audit log access restricted</p>
        <p className="text-xs text-slate-400 mt-1">{viewAuditLogsGate.reason}</p>
      </div>
      )}

      {/* Security Notes panel */}
      <div className="bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-end justify-between mb-4">
          <div>
            <h3 className="text-lg font-black text-primary tracking-tight">Security Notes</h3>
            <p className="text-xs text-slate-500 font-medium">Internal posture / incident notes. Persisted per browser session and audited.</p>
          </div>
        </div>
        <div className="flex gap-2 mb-4">
          <input
            value={newNoteBody}
            onChange={e => setNewNoteBody(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addNote(); }}
            placeholder={linkedNoteEventId ? `Add a security note linked to event ${linkedNoteEventId}…` : 'Add a security note…'}
            className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-700"
          />
          {linkedNoteEventId && (
            <button onClick={() => setLinkedNoteEventId(null)} className="px-3 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-2xl hover:bg-slate-50">Unlink</button>
          )}
          <button onClick={() => addNote()} disabled={!newNoteBody.trim() || !addNoteGate.allowed} title={addNoteGate.allowed ? '' : addNoteGate.reason} data-testid="security-note-save" className="px-5 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-all">Add Note</button>
        </div>
        <div className="space-y-2">
          {notes.length === 0 && <p className="text-xs text-slate-400 font-bold py-4 text-center">No security notes yet.</p>}
          {notes.map(n => (
            <div key={n.id} className="flex items-start justify-between gap-4 p-4 bg-slate-50 rounded-2xl">
              <div className="flex-1">
                <p className="text-sm text-slate-700 font-medium">{n.body}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                  {n.author} · {new Date(n.createdAt).toLocaleString()}
                  {n.linkedEventId && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-400/10 text-blue-700 border border-blue-400/20">linked event {n.linkedEventId}</span>
                  )}
                </p>
              </div>
              <button data-testid={`security-note-delete-${n.id}`} onClick={() => { if (deleteNoteGate.allowed) requestDeleteNote(n.id); }} disabled={!deleteNoteGate.allowed} title={deleteNoteGate.allowed ? '' : deleteNoteGate.reason} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-slate-400">Delete</button>
            </div>
          ))}
        </div>
      </div>

      {/* Phase 1.1.3D — Correlated Event Groups (Part H). Rule-based grouping of
          the current audit data. Each group's count and member list both derive
          from group.eventIds so they cannot drift. */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 mb-6" data-testid="audit-correlated-groups">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-primary">Correlated Event Groups</h2>
            <p className="text-[10px] text-slate-400 font-semibold mt-0.5">{AUDIT_CORRELATION_TRUTH_LABEL}</p>
          </div>
          <span className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg bg-slate-100 text-slate-600 border border-slate-200">
            {correlatedGroups.length} group{correlatedGroups.length === 1 ? '' : 's'}
          </span>
        </div>
        {correlatedGroups.length === 0 ? (
          <p className="text-xs text-slate-400 font-bold py-8 text-center bg-slate-50 rounded-2xl mt-4">
            No correlated event groups in the current audit data under the present rules.
          </p>
        ) : (
          <div className="grid gap-3 mt-4 md:grid-cols-2">
            {correlatedGroups.map(g => {
              const isOpen = expandedGroup === g.id;
              return (
                <div key={g.id} data-testid={`audit-corr-group-${g.kind}`} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
                  <p className="text-sm font-bold text-slate-800">{g.title}</p>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${SEVERITY_STYLES[g.severity]}`}>{g.severity}</span>
                    <span className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border bg-white text-slate-500 border-slate-200">Confidence · {g.confidence}</span>
                    <span className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border bg-white text-slate-500 border-slate-200">{g.count} events</span>
                  </div>
                  <p className="text-xs text-slate-600 mt-2"><span className="font-bold text-slate-700">Why grouped:</span> {g.reason}</p>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {g.actor && <span>Actor: <span className="font-bold text-slate-700">{g.actor}</span>{g.tenantId ? ' · ' : ''}</span>}
                    {g.tenantId && <span>Tenant: <span className="font-bold text-slate-700">{tenantNameById.get(g.tenantId) || g.tenantId}</span></span>}
                    {!g.actor && !g.tenantId && <span>Platform-wide</span>}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1"><span className="font-bold text-slate-700">Recommended:</span> {g.recommendedAction}</p>
                  <button
                    onClick={() => setExpandedGroup(isOpen ? null : g.id)}
                    data-testid={`audit-corr-group-toggle-${g.kind}`}
                    className="mt-3 text-[10px] font-black uppercase tracking-widest text-primary hover:underline"
                  >
                    {isOpen ? 'Hide events' : `Show ${g.count} events`}
                  </button>
                  {isOpen && (
                    <div className="mt-3 space-y-2" data-testid={`audit-corr-group-events-${g.kind}`}>
                      {g.eventIds.map(id => {
                        const row = rowById.get(id);
                        if (!row) return null;
                        const { flag } = deriveHighRiskFlag(row);
                        return (
                          <button
                            key={id}
                            onClick={() => { setSelected(row); setDrawerTab('detail'); }}
                            className="w-full text-left p-2.5 bg-white hover:bg-slate-100 rounded-xl border border-slate-100 transition-colors"
                          >
                            <div className="flex justify-between items-start gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold text-slate-700 truncate">{row.action}</p>
                                <p className="text-[10px] text-slate-500 mt-0.5 truncate">{row.target} · {row.actor} · {row.date}</p>
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${SEVERITY_STYLES[normalizeSeverity(row.severity)]}`}>{normalizeSeverity(row.severity)}</span>
                                {flag && <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${HIGH_RISK_FLAG_STYLES[flag]}`}>{HIGH_RISK_FLAG_LABEL[flag]}</span>}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      <AnimatePresence>
        {selected && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelected(null)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-lg h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <div className="p-7 border-b border-slate-100 flex justify-between items-start">
                <div className="flex-1 pr-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Audit Event</p>
                  <h3 className="text-lg font-black text-primary mt-1">{selected.action}</h3>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${SEVERITY_STYLES[normalizeSeverity(selected.severity)]}`}>
                      {normalizeSeverity(selected.severity)}
                    </span>
                    {(() => {
                      const { flag } = deriveHighRiskFlag(selected);
                      return flag ? (
                        <span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${HIGH_RISK_FLAG_STYLES[flag]}`}>
                          {HIGH_RISK_FLAG_LABEL[flag]}
                        </span>
                      ) : null;
                    })()}
                    {linkedCaseByEvent.get(selected.id) && (
                      <Link
                        to={`/owner/support-tools?caseId=${encodeURIComponent(linkedCaseByEvent.get(selected.id)!.id)}`}
                        data-testid="audit-drawer-linked-case"
                        className="px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded bg-blue-400/10 text-blue-700 border border-blue-400/20 hover:bg-blue-400/20"
                      >
                        Linked case · {linkedCaseByEvent.get(selected.id)!.id}
                      </Link>
                    )}
                  </div>
                </div>
                <button onClick={() => setSelected(null)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>

              {/* Tabs — Pre-QA correction: 'related' tab gated by
                  view_related_event_timeline, 'actor' tab gated by
                  view_actor_profile (separate sub-permissions per spec). */}
              <div className="px-7 pt-4 flex gap-2 border-b border-slate-100">
                {(['detail', 'related', 'timeline', 'actor'] as const)
                  .filter(t => t === 'detail'
                    || (t === 'related' && viewRelatedEventTimelineGate.allowed)
                    || (t === 'timeline' && viewRelatedEventTimelineGate.allowed)
                    || (t === 'actor' && viewActorProfileGate.allowed))
                  .map(t => (
                  <button
                    key={t}
                    onClick={() => setDrawerTab(t)}
                    data-testid={`audit-drawer-tab-${t}`}
                    className={`px-3 pb-3 text-[10px] font-black uppercase tracking-widest border-b-2 ${drawerTab === t ? 'border-primary text-primary' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                  >
                    {t === 'detail' ? 'Detail' : t === 'related' ? `Related (${relatedEvents.length})` : t === 'timeline' ? `Timeline${entityTimeline ? ` (${entityTimeline.events.length})` : ''}` : 'Actor profile'}
                  </button>
                ))}
              </div>

              {drawerTab === 'detail' && (
                <div className="p-7 space-y-4">
                  {/* Phase 1.1.2 — actor context block: avatar circle (initials),
                      role hint, recent-actions count. Reads from the same
                      derived `actorProfile` so it stays consistent with the
                      Actor profile tab. */}
                  {actorProfile && (
                    <div
                      data-testid="audit-drawer-actor-context"
                      className="flex items-center gap-3 p-3 rounded-2xl bg-slate-50 border border-slate-100"
                    >
                      <span className="shrink-0 w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-black uppercase tracking-widest">
                        {selected.actor.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '?'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-800 truncate">{selected.actor}</p>
                        <p className="text-[10px] text-slate-500 font-bold mt-0.5">
                          {actorProfile.total} recent action{actorProfile.total === 1 ? '' : 's'}
                          {actorProfile.severityBreakdown.critical > 0 && <span className="text-red-700"> · {actorProfile.severityBreakdown.critical} critical</span>}
                          {actorProfile.severityBreakdown.warning > 0 && <span className="text-amber-700"> · {actorProfile.severityBreakdown.warning} warning</span>}
                        </p>
                      </div>
                      <button
                        onClick={() => setDrawerTab('actor')}
                        data-testid="audit-drawer-actor-context-open"
                        className="shrink-0 text-[10px] font-black uppercase tracking-widest text-primary hover:underline"
                      >
                        Profile →
                      </button>
                    </div>
                  )}
                  <Row label="Date" value={selected.date} />
                  <Row label="Actor" value={selected.actor} />
                  <Row label="Target" value={selected.target} />
                  <Row label="Category" value={selected.category || '—'} />
                  {selected.tenantId && <Row label="Tenant" value={tenantNameById.get(selected.tenantId) || selected.tenantId} />}
                  {selected.oldValue != null && <Row label="From" value={String(selected.oldValue)} />}
                  {selected.newValue != null && <Row label="To" value={String(selected.newValue)} />}
                  {/* Phase 1.1.3A — escalation lifecycle before/after card.
                      Renders for any support_case_escalat* action so
                      reviewers see the structured transition (status,
                      level, owner/team) without needing to open the
                      support case. */}
                  {/* Pre-QA correction: escalation transition card gated by
                      view_escalation_lifecycle_audit. */}
                  {viewEscalationLifecycleGate.allowed && (selected.action || '').startsWith('support_case_escalat') && (selected.oldValue != null || selected.newValue != null) && (
                    <div
                      className="rounded-2xl border border-slate-100 bg-slate-50/40 p-4 space-y-1.5"
                      data-testid="audit-drawer-escalation-diff"
                    >
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Escalation Transition</p>
                      <div className="flex items-center gap-2 text-xs font-bold text-slate-700 flex-wrap">
                        <span className="px-2 py-1 rounded-lg bg-white border border-slate-200" data-testid="audit-drawer-esc-old">
                          {selected.oldValue != null ? String(selected.oldValue) : '—'}
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className="px-2 py-1 rounded-lg bg-primary/10 border border-primary/20 text-primary" data-testid="audit-drawer-esc-new">
                          {selected.newValue != null ? String(selected.newValue) : '—'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 italic">Action: <span className="font-mono">{selected.action}</span></p>
                    </div>
                  )}
                  {selected.note && (
                    <div data-testid="audit-drawer-note">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Note</p>
                      {/* Pre-QA correction: free-form note may contain restricted
                          context. For high-risk events (any deriveHighRiskFlag
                          reasons), require view_restricted_audit_details to
                          read the note body. */}
                      {(() => {
                        const { reasons } = deriveHighRiskFlag(selected);
                        const isRestricted = reasons.length > 0;
                        if (isRestricted && !viewRestrictedDetailsGate.allowed) {
                          return (
                            <p
                              className="text-xs italic text-slate-400 bg-slate-50 p-4 rounded-2xl"
                              data-testid="audit-drawer-note-restricted"
                              title={viewRestrictedDetailsGate.reason}
                            >
                              Restricted — requires View Restricted Audit Details.
                            </p>
                          );
                        }
                        return (
                          <p className="text-sm text-slate-700 bg-slate-50 p-4 rounded-2xl">{selected.note}</p>
                        );
                      })()}
                    </div>
                  )}
                  {(() => {
                    const { reasons } = deriveHighRiskFlag(selected);
                    if (!reasons.length) return null;
                    // Pre-QA correction: "Why flagged" reasons are restricted
                    // detail and require view_restricted_audit_details.
                    if (!viewRestrictedDetailsGate.allowed) {
                      return (
                        <div data-testid="audit-drawer-why-flagged-restricted">
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Why flagged</p>
                          <p className="text-xs italic text-slate-400" title={viewRestrictedDetailsGate.reason}>
                            Restricted — requires View Restricted Audit Details.
                          </p>
                        </div>
                      );
                    }
                    return (
                      <div data-testid="audit-drawer-why-flagged">
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Why flagged</p>
                        <ul className="text-xs text-slate-600 list-disc pl-5 space-y-0.5">
                          {reasons.map(r => <li key={r}>{r}</li>)}
                        </ul>
                      </div>
                    );
                  })()}
                  {/* Phase 1.1.3D — "Why this matters": rule-based investigation
                      signals derived from the event + current audit data. These
                      are categorical explanations (not sensitive bodies), so they
                      are visible to anyone with audit access. */}
                  <div data-testid="audit-drawer-why-matters">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Why this matters</p>
                    {selectedRiskSignals.length === 0 ? (
                      <p className="text-xs text-slate-500 italic bg-slate-50 p-3 rounded-2xl">No additional risk signal from current rules.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {selectedRiskSignals.map(s => (
                          <li key={s.code} className="flex items-start gap-2 text-xs text-slate-600">
                            <span className={`mt-0.5 shrink-0 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${SEVERITY_STYLES[s.severity]}`}>{s.severity}</span>
                            <span><span className="font-bold text-slate-700">{s.label}.</span> {s.detail}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-[10px] text-slate-400 italic mt-2">{AUDIT_INVESTIGATION_TRUTH_LABEL}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
                    {!linkedCaseByEvent.get(selected.id) && (
                      <button
                        onClick={() => {
                          if (!createCaseFromAuditGate.allowed || !createCaseGate.allowed) return;
                          setShowCreateCase(true);
                        }}
                        disabled={!createCaseFromAuditGate.allowed || !createCaseGate.allowed}
                        title={
                          !createCaseFromAuditGate.allowed
                            ? createCaseFromAuditGate.reason
                            : !createCaseGate.allowed ? createCaseGate.reason : ''
                        }
                        data-testid="audit-create-case-from-event"
                        className="px-4 py-2 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Create Support Case from this Event
                      </button>
                    )}
                    <button onClick={() => { setLinkedNoteEventId(selected.id); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }} className="px-4 py-2 bg-white text-slate-700 border border-slate-200 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-50 transition-colors">
                      Save as Security Note
                    </button>
                    <button onClick={() => setDrawerTab('related')} className="px-4 py-2 bg-white text-slate-700 border border-slate-200 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-50 transition-colors">
                      View Related ({relatedEvents.length})
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono pt-4 border-t border-slate-100">id: {selected.id}</div>
                </div>
              )}

              {drawerTab === 'related' && (
                <div className="p-7 space-y-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                    Related events (same tenant / target / actor)
                  </p>
                  {relatedEvents.length === 0 ? (
                    <p className="text-xs text-slate-400 font-bold py-6 text-center bg-slate-50 rounded-2xl">No related events.</p>
                  ) : (
                    // Phase 1.1.2 — group related events by Today / Yesterday /
                    // Earlier headers so investigation reads chronologically.
                    (() => {
                      const groups: Array<{ label: string; items: typeof relatedEvents }> = [];
                      const today = new Date();
                      const yest = new Date(); yest.setDate(yest.getDate() - 1);
                      const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
                      const labelFor = (iso: string): string => {
                        const d = new Date(iso);
                        if (Number.isNaN(d.getTime())) return 'Earlier';
                        if (sameDay(d, today)) return 'Today';
                        if (sameDay(d, yest)) return 'Yesterday';
                        return 'Earlier';
                      };
                      for (const r of relatedEvents) {
                        const label = labelFor(r.date);
                        const last = groups[groups.length - 1];
                        if (last && last.label === label) last.items.push(r);
                        else groups.push({ label, items: [r] });
                      }
                      return groups.map((g, gi) => (
                        <div key={`${g.label}-${gi}`} data-testid={`audit-related-group-${g.label.toLowerCase()}`} className="space-y-2">
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-1">{g.label} <span className="text-slate-400">· {g.items.length}</span></p>
                          {g.items.map(r => {
                            const { flag } = deriveHighRiskFlag(r);
                            return (
                              <button
                                key={r.id}
                                onClick={() => { setSelected(r); setDrawerTab('detail'); }}
                                className="w-full text-left p-3 bg-slate-50 hover:bg-slate-100 rounded-xl border border-slate-100 transition-colors"
                              >
                                <div className="flex justify-between items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-slate-700 truncate">{r.action}</p>
                                    <p className="text-[10px] text-slate-500 font-bold mt-0.5 truncate">{r.target}</p>
                                  </div>
                                  <div className="flex flex-col items-end gap-1">
                                    <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${SEVERITY_STYLES[normalizeSeverity(r.severity)]}`}>
                                      {normalizeSeverity(r.severity)}
                                    </span>
                                    {flag && (
                                      <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${HIGH_RISK_FLAG_STYLES[flag]}`}>
                                        {HIGH_RISK_FLAG_LABEL[flag]}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1">{r.actor} · {r.date}</p>
                              </button>
                            );
                          })}
                        </div>
                      ));
                    })()
                  )}
                </div>
              )}

              {/* Phase 1.1.3D — Related Entity Timeline (Part G). Same
                  tenant/target, sorted chronologically, selected highlighted.
                  Gated by view_related_event_timeline. */}
              {drawerTab === 'timeline' && viewRelatedEventTimelineGate.allowed && entityTimeline && (
                <div className="p-7 space-y-3" data-testid="audit-drawer-timeline">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                    Related entity timeline · {entityTimeline.entityLabel}
                  </p>
                  {entityTimeline.events.length === 0 ? (
                    <p className="text-xs text-slate-400 font-bold py-6 text-center bg-slate-50 rounded-2xl">No related entity events.</p>
                  ) : (
                    <div className="relative pl-4 space-y-2 before:absolute before:left-1 before:top-1 before:bottom-1 before:w-px before:bg-slate-200">
                      {entityTimeline.events.map(e => {
                        const isSel = e.id === selected.id;
                        const row = rowById.get(e.id);
                        return (
                          <button
                            key={e.id}
                            onClick={() => { if (row) { setSelected(row); setDrawerTab('detail'); } }}
                            data-testid={`audit-timeline-event${isSel ? '-selected' : ''}`}
                            className={`relative w-full text-left p-3 rounded-xl border transition-colors ${isSel ? 'bg-primary/5 border-primary/30 ring-1 ring-primary/20' : 'bg-slate-50 hover:bg-slate-100 border-slate-100'}`}
                          >
                            <span className={`absolute -left-[13px] top-4 w-2 h-2 rounded-full ${isSel ? 'bg-primary' : 'bg-slate-300'}`} />
                            <div className="flex justify-between items-start gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-slate-700 truncate">
                                  {e.action}
                                  {isSel && <span className="ml-2 text-[9px] font-black uppercase tracking-widest text-primary">Selected</span>}
                                </p>
                                <p className="text-[10px] text-slate-500 font-bold mt-0.5 truncate">{e.target || '—'}</p>
                                {row && (row.oldValue != null || row.newValue != null) && (
                                  <p className="text-[10px] text-slate-400 mt-1">
                                    <span className="font-mono">{row.oldValue != null ? String(row.oldValue) : '—'}</span>
                                    <span className="mx-1">→</span>
                                    <span className="font-mono">{row.newValue != null ? String(row.newValue) : '—'}</span>
                                  </p>
                                )}
                              </div>
                              <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${SEVERITY_STYLES[e.severity]}`}>{e.severity}</span>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-1">{e.actor} · {e.date}</p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-[10px] text-slate-400 italic">{AUDIT_INVESTIGATION_TRUTH_LABEL} Sorted oldest → newest.</p>
                </div>
              )}

              {drawerTab === 'actor' && viewActorProfileGate.allowed && actorProfile && (
                <div className="p-7 space-y-4" data-testid="audit-drawer-actor">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Actor profile · {selected.actor}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <ProfileStat label="Total events" value={actorProfile.total} />
                    <ProfileStat label="High-risk" value={actorProfile.highRiskCount} />
                    <ProfileStat label="Critical" value={actorProfile.severityBreakdown.critical} />
                    <ProfileStat label="Warning" value={actorProfile.severityBreakdown.warning} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-slate-50 rounded-2xl border border-slate-100">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Tenants touched</p>
                      <p className="text-sm font-bold text-slate-700 mt-0.5">{actorProfile.tenantsTouched.length}</p>
                    </div>
                    <div className="p-3 bg-slate-50 rounded-2xl border border-slate-100">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Last activity</p>
                      <p className="text-sm font-bold text-slate-700 mt-0.5">{actorProfile.lastActivity || '—'}</p>
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Activity signals</p>
                    <ul className="space-y-1" data-testid="audit-actor-signals">
                      {actorProfile.signals.map((s, i) => (
                        <li key={i} className="text-xs text-slate-600 flex items-start gap-2">
                          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Top categories</p>
                    <div className="flex flex-wrap gap-2">
                      {actorProfile.categoryBreakdown.length === 0 && <span className="text-xs text-slate-400">—</span>}
                      {actorProfile.categoryBreakdown.map(([c, n]) => (
                        <span key={c} className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg bg-slate-100 text-slate-600 border border-slate-200">
                          {c} · {n}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Recent activity</p>
                    <div className="space-y-2">
                      {actorProfile.recent.map(e => (
                        <button
                          key={e.id}
                          onClick={() => { const row = rowById.get(e.id); if (row) { setSelected(row); setDrawerTab('detail'); } }}
                          className="w-full text-left p-2.5 bg-slate-50 hover:bg-slate-100 rounded-xl border border-slate-100 transition-colors"
                        >
                          <p className="text-xs font-bold text-slate-700">{e.action}</p>
                          <p className="text-[10px] text-slate-500 mt-0.5">{e.target || '—'} · {e.date}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400 italic">{AUDIT_INVESTIGATION_TRUTH_LABEL}</p>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Create case from event modal */}
      <AnimatePresence>
        {showCreateCase && selected && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCreateCase(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-lg bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100 flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-black text-primary tracking-tight">Create Support Case from Event</h3>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">Source event {selected.id}</p>
                </div>
                <button onClick={() => setShowCreateCase(false)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tenant</label>
                  <select value={caseDraft.tenantId} onChange={e => setCaseDraft(d => ({ ...d, tenantId: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="">Select tenant…</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Subject</label>
                  <input value={caseDraft.subject} onChange={e => setCaseDraft(d => ({ ...d, subject: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Severity</label>
                  <select value={caseDraft.severity} onChange={e => setCaseDraft(d => ({ ...d, severity: e.target.value as SupportCaseSeverity }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Description (auto-prefilled)</label>
                  <textarea value={caseDraft.description} onChange={e => setCaseDraft(d => ({ ...d, description: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-700 h-32 resize-none" />
                </div>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setShowCreateCase(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button onClick={createCaseFromEvent} disabled={!caseDraft.tenantId || !caseDraft.subject.trim()} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90 disabled:opacity-40">Create Case</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Security note delete confirmation */}
      <AnimatePresence>
        {pendingDeleteNote && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="confirm-delete-note">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={cancelDeleteNote} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Delete security note?</h3>
                <p className="text-xs text-slate-500 font-medium mt-1">This will permanently remove the note from this browser session and write a `security_note_deleted` audit entry.</p>
              </div>
              <div className="p-7">
                <p className="text-sm text-slate-700 bg-slate-50 p-4 rounded-2xl whitespace-pre-wrap">{pendingDeleteNote.body}</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-2">{pendingDeleteNote.author} · {new Date(pendingDeleteNote.createdAt).toLocaleString()}</p>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={cancelDeleteNote} data-testid="confirm-delete-note-cancel" className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button onClick={confirmDeleteNote} data-testid="confirm-delete-note-confirm" className="px-6 py-2.5 bg-red-500/90 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-red-500">Delete note</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ProfileStat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="p-3 bg-slate-50 rounded-2xl border border-slate-100">
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className="text-xl font-black text-primary mt-0.5">{value}</p>
  </div>
);

const Row: React.FC<{ label: string; value?: string; children?: React.ReactNode }> = ({ label, value, children }) => (
  <div className="flex justify-between items-start gap-4">
    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest pt-1">{label}</span>
    {children ?? <span className="text-sm font-bold text-slate-700 text-right break-words max-w-[60%]">{value}</span>}
  </div>
);

export default AuditSecurityPage;
