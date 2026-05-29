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
  type SupportCaseEscalationEntry,
  type SupportCaseAssignmentEntry,
  type SupportMacro,
} from './mockData';
import { pushPlatformAudit } from './platformOpsAudit';
import { useAccess } from '../context/AccessContext';
import {
  hasPlatformPermission,
  PLATFORM_ROLE_DISPLAY_LABEL,
} from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import {
  deriveSlaStatus,
  deriveTenantRisk,
  predefinedSupportViews,
  countCasesForSupportView,
  PHASE_112_TRUTH_LABEL,
  PHASE_113A_TRUTH_LABEL,
  PHASE_113A_PERMISSION_LABEL,
  SLA_STATUS_LABEL,
  SLA_STATUS_STYLES,
  RISK_STATUS_LABEL,
  RISK_STATUS_STYLES,
  ESCALATION_STATUS_LABEL,
  ESCALATION_STATUS_STYLES,
  ESCALATION_LEVEL_LABEL,
  ESCALATION_LEVEL_STYLES,
  ESCALATION_LEVEL_OPTIONS,
  ESCALATION_REASON_LABEL,
  ESCALATION_REASON_OPTIONS,
  ESCALATION_TARGET_TEAM_OPTIONS,
  PLATFORM_OPS_ROLE_LABEL,
  PLATFORM_OPS_ROLE_DESCRIPTION,
  ROLE_TEAM_BY_ROLE,
  effectiveEscalationStatus,
  buildEscalationViewModel,
  isEscalationAckOverdue,
  isEscalationCritical,
  can,
  type AuditEventLike,
  type SupportViewFilters,
  type SupportViewCtx,
  type PlatformOpsRole,
  type EscalationLevel,
  type EscalationReasonCode,
  type EscalationTargetTeam,
  type EscalationAction,
  type CanResult,
} from './platformOpsDerive';

const CASES_KEY = 'support_cases_v1';
const DOMAINS_KEY = 'tenant_domains_v1';

// Phase 1.1.3A correction — the local Acting-As selector has been removed.
// The active platform role is now sourced exclusively from the Dev Session /
// AccessContext (`useAccess().session.role`). To preserve the existing
// advisory `can()` matrix in `platformOpsDerive.ts` (which is keyed by the
// older `PlatformOpsRole` taxonomy used during Phase 1.1.3A development), we
// map the AccessContext `Role` to the closest `PlatformOpsRole` here. New
// permission checks should use `hasPlatformPermission(session.role, …)` from
// `platformPermissionsConfig.ts` directly — this map exists only for the
// existing escalation lifecycle gates that were already wired with `can()`.
const PLATFORM_ROLE_TO_OPS_ROLE: Record<Role, PlatformOpsRole> = {
  system_owner: 'platform_owner',
  operations_admin: 'platform_admin',
  support_admin: 'platform_lead',
  security_admin: 'platform_security',
  billing_admin: 'platform_billing',
  // Tenant-side roles never operate Support Tools — surface as read-only.
  store_owner: 'platform_readonly',
  manager: 'platform_readonly',
  technician: 'platform_readonly',
  sales_staff: 'platform_readonly',
};

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
  const { session } = useAccess();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cases, setCases] = useState<SupportCaseRecord[]>(() => loadCases());
  const [search, setSearch] = useState('');
  // Phase 1.1.2 — extended to support saved-view group tokens so the visible
  // list and the saved-view count badge always agree (e.g. "Resolved / Closed"
  // saved view counts both statuses and the table shows both).
  const [statusFilter, setStatusFilter] = useState<'all' | SupportCaseStatus | 'open_group' | 'resolved_group'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missingCaseId, setMissingCaseId] = useState<string | null>(null);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<string>('all');
  const [slaFilter, setSlaFilter] = useState<'any' | 'overdue' | 'at_risk'>('any');
  const [severityViewFilter, setSeverityViewFilter] = useState<'all' | SupportCaseSeverity>('all');
  const [sortMode, setSortMode] = useState<'opened_desc' | 'updated_desc'>('opened_desc');
  // Phase 1.1.3A correction — operator identity + acting role are now
  // sourced from the active Dev Session / AccessContext. The page no
  // longer exposes an "Acting as" selector and no longer persists role
  // or operator name to localStorage. The Global Permissions Matrix in
  // Team Management governs what each role can do here; switching roles
  // for testing is done from the Dev Session role switcher.
  const sessionRole: Role | null = (session?.role as Role | undefined) || null;
  const currentRole: PlatformOpsRole = sessionRole
    ? PLATFORM_ROLE_TO_OPS_ROLE[sessionRole]
    : 'platform_readonly';
  const operatorName: string = session?.user?.name || '';

  // Pre-QA correction — wire 9 Support Tools sub-permissions explicitly.
  // These are read once per render so handlers and section gates share
  // the same source of truth (the Global Permissions Matrix).
  const closeSupportCaseGate = hasPlatformPermission(sessionRole, 'close_support_case');
  const reopenSupportCaseGate = hasPlatformPermission(sessionRole, 'reopen_support_case');
  // `edit_support_case` is declared in the catalog as a reserved umbrella
  // sub-permission for future case-detail edit surfaces (e.g. inline
  // description editing). It is intentionally not bound to existing
  // mutation handlers because each existing field already has its own
  // specific sub-permission (change_support_status, change_support_severity,
  // assign_support_case, add_internal_support_note, close_support_case,
  // reopen_support_case). Adding an umbrella AND-gate here would tighten
  // existing roles unexpectedly. When a generic edit surface is added,
  // wire `hasPlatformPermission(sessionRole, 'edit_support_case')` here.
  const assignSupportCaseGate = hasPlatformPermission(sessionRole, 'assign_support_case');
  const addInternalNoteGate = hasPlatformPermission(sessionRole, 'add_internal_support_note');
  const useSupportMacroGate = hasPlatformPermission(sessionRole, 'use_support_macro');
  const viewSupportSlaGate = hasPlatformPermission(sessionRole, 'view_support_sla');
  const viewSupportTenantHealthGate = hasPlatformPermission(sessionRole, 'view_support_tenant_health');
  const viewSupportRelatedEntitiesGate = hasPlatformPermission(sessionRole, 'view_support_related_entities');

  // Saved-view escalation token + ctx for queue counts.
  const [escalationFilter, setEscalationFilter] =
    useState<NonNullable<SupportViewFilters['escalation']> | 'any'>('any');

  // Phase 1.1.3A — escalation lifecycle modals.
  const [escalateModal, setEscalateModal] = useState<SupportCaseRecord | null>(null);
  const [assignModal, setAssignModal] = useState<SupportCaseRecord | null>(null);
  const [levelModal, setLevelModal] = useState<SupportCaseRecord | null>(null);
  const [resolveModal, setResolveModal] = useState<SupportCaseRecord | null>(null);
  const [deescalateModal, setDeescalateModal] = useState<SupportCaseRecord | null>(null);
  const [closeWarnModal, setCloseWarnModal] = useState<SupportCaseRecord | null>(null);
  // Request De-escalation (lightweight) — for operators who can view + add
  // notes but cannot perform an actual de-escalation. Posts an internal
  // note + audit row; never mutates escalation status.
  const [requestDeescModal, setRequestDeescModal] = useState<SupportCaseRecord | null>(null);
  const [requestDeescDraft, setRequestDeescDraft] = useState<{ note: string }>({ note: '' });
  // Phase 1.1.3A correction — pending-review lifecycle. Reviewers with
  // deescalate_support_case permission see a pending request card and can
  // approve (→ actual de-escalate, marks approved) or reject (→ marks
  // rejected with reason; never mutates escalation status).
  const [rejectDeescModal, setRejectDeescModal] = useState<SupportCaseRecord | null>(null);
  const [rejectDeescDraft, setRejectDeescDraft] = useState<{ reason: string }>({ reason: '' });
  // When set, the De-escalate confirm flow will additionally mark the
  // pending request as approved + emit the request-approved audit row.
  const [approvingRequestForCaseId, setApprovingRequestForCaseId] = useState<string | null>(null);
  const [escalateDraft, setEscalateDraft] = useState<{
    reasonCode: EscalationReasonCode;
    reasonNote: string;
    level: EscalationLevel;
    targetTeam: EscalationTargetTeam;
    ownerName: string;
    ackHours: number;
  }>({
    reasonCode: 'manual',
    reasonNote: '',
    level: 'L2',
    targetTeam: 'Support Tier 2',
    ownerName: '',
    ackHours: 4,
  });
  const [assignDraft, setAssignDraft] = useState<{
    ownerName: string;
    team: EscalationTargetTeam;
    reason: string;
  }>({ ownerName: '', team: 'Support Tier 2', reason: '' });
  const [levelDraft, setLevelDraft] = useState<{ level: EscalationLevel; reason: string }>({
    level: 'L2',
    reason: '',
  });
  const [resolveDraft, setResolveDraft] = useState<{ note: string }>({ note: '' });
  const [deescalateDraft, setDeescalateDraft] = useState<{ note: string }>({ note: '' });

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

  // Phase 1.1.3A correction (Part F) — keep this page's case list in sync
  // with the canonical sessionStorage store after a mutation here or on
  // another platform surface (e.g. Command Center). `selected` re-derives
  // from `cases` by id, so the open drawer never shows stale escalation
  // state. The identity guard prevents the self-dispatched
  // 'support_cases:changed' (fired by saveCases) from causing a
  // reload → save → dispatch loop. Truth label: operational signals
  // refresh from current app/session state — Firestore real-time
  // listeners are future live-backend work.
  useEffect(() => {
    const reload = () => {
      const latest = loadCases();
      setCases(prev =>
        JSON.stringify(prev) === JSON.stringify(latest) ? prev : latest
      );
    };
    window.addEventListener('support_cases:changed', reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener('support_cases:changed', reload);
      window.removeEventListener('storage', reload);
    };
  }, []);

  const applyView = (id: string) => {
    setActiveView(id);
    const v = predefinedSupportViews.find(x => x.id === id);
    if (!v) return;
    const f: SupportViewFilters = v.filters;
    // Phase 1.1.2 — preserve group tokens so list filtering matches the
    // count badge produced by `countCasesForSupportView`.
    if (f.status === 'open_group') setStatusFilter('open_group');
    else if (f.status === 'resolved_group') setStatusFilter('resolved_group');
    else if (f.status) setStatusFilter(f.status as SupportCaseStatus | 'all');
    else setStatusFilter('all');
    setSlaFilter(f.sla === 'overdue' ? 'overdue' : f.sla === 'at_risk' ? 'at_risk' : 'any');
    setSeverityViewFilter(f.severity && f.severity !== 'all' ? (f.severity as SupportCaseSeverity) : 'all');
    setSortMode(f.sort === 'updated_desc' ? 'updated_desc' : 'opened_desc');
    // Phase 1.1.3A — saved-view escalation token. Defaults to 'any' for
    // non-escalation lenses so the existing queues stay unchanged.
    setEscalationFilter(f.escalation || 'any');
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

  const teamForCurrentRole = ROLE_TEAM_BY_ROLE[currentRole] || '';
  const supportViewCtx: SupportViewCtx = useMemo(
    () => ({ operatorName, teamName: teamForCurrentRole }),
    [operatorName, teamForCurrentRole]
  );

  const filteredCases = useMemo(() => {
    const now = new Date();
    const filtered = cases.filter(c => {
      // Phase 1.1.2 — group tokens mirror the same predicates used by
      // `countCasesForSupportView` so list and saved-view counts agree.
      if (statusFilter === 'open_group') {
        if (c.status === 'resolved' || c.status === 'closed') return false;
      } else if (statusFilter === 'resolved_group') {
        if (c.status !== 'resolved' && c.status !== 'closed') return false;
      } else if (statusFilter !== 'all' && c.status !== statusFilter) {
        return false;
      }
      if (severityViewFilter !== 'all' && c.severity !== severityViewFilter) return false;
      if (slaFilter !== 'any') {
        const sla = deriveSlaStatus(c);
        if (slaFilter === 'overdue' && sla.status !== 'overdue') return false;
        if (slaFilter === 'at_risk' && sla.status !== 'at_risk') return false;
      }
      // Phase 1.1.3A — escalation queue token. Mirrors the predicates in
      // `matchesEscalationFilter` (platformOpsDerive.ts) so the visible
      // list matches the saved-view chip count exactly.
      if (escalationFilter !== 'any') {
        const eff = effectiveEscalationStatus(c);
        const ownerName = (c.escalationOwnerName || '').trim();
        const team = (c.escalationTargetTeam || c.assignedTeamName || '').trim();
        if (escalationFilter === 'active') {
          if (!eff.active) return false;
        } else if (escalationFilter === 'unacknowledged') {
          if (eff.status !== 'escalated') return false;
        } else if (escalationFilter === 'overdue_ack') {
          if (!isEscalationAckOverdue(c, now)) return false;
        } else if (escalationFilter === 'critical') {
          if (!eff.active || !isEscalationCritical(c)) return false;
        } else if (escalationFilter === 'unassigned') {
          if (!eff.active || ownerName) return false;
        } else if (escalationFilter === 'deescalated') {
          if (eff.status !== 'deescalated') return false;
        } else if (escalationFilter === 'resolved') {
          if (eff.status !== 'resolved') return false;
        } else if (escalationFilter === 'mine') {
          if (!eff.active || !operatorName || ownerName !== operatorName) return false;
        } else if (escalationFilter === 'team') {
          if (!eff.active || !teamForCurrentRole || team !== teamForCurrentRole) return false;
        }
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
  }, [cases, statusFilter, severityViewFilter, slaFilter, escalationFilter, search, tenantById, sortMode, operatorName, teamForCurrentRole]);

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

  // Phase 1.1.3A correction — SHARED escalation view model. The red banner,
  // header "Escalated" pill, reviewer card, rejected pill, escalation detail
  // card, and the De-escalate button all read from this single object so
  // "De-escalate visible" implies "banner/card visible" by construction.
  // `selected` is re-derived from the latest `cases` list by id (above), so
  // this view model never reflects a stale escalation state.
  const escVm = useMemo(
    () => (selected ? buildEscalationViewModel(selected) : null),
    [selected]
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
    // Pre-QA correction: handler-level matrix check.
    const perm = hasPlatformPermission(sessionRole, 'add_internal_support_note');
    if (!perm.allowed) { console.warn("[support-tools] permission denied:", perm.reason); return; }
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
    // Handler-level matrix check: status changes require change_support_status
    // (Edit threshold). Stale UI / dropdown selection cannot bypass.
    const perm = hasPlatformPermission(sessionRole, 'change_support_status');
    if (!perm.allowed) { console.warn("[support-tools] permission denied:", perm.reason); return; }
    const nowIso = new Date().toISOString();
    const notes: SupportCaseNote[] = [...(c.notes || []), {
      id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      author: 'System Owner',
      body: `Status: ${c.status} → ${next}`,
      createdAt: nowIso,
      kind: 'status_change',
    }];
    // Phase 1.1.3A — when the case moves to a terminal state (resolved /
    // closed), auto-resolve any active escalation so Command Center pulse
    // counters and Needs-Attention queues do not show "ghost" escalations
    // for already-closed cases. Emits a paired escalation_resolved audit
    // + history entry for traceability.
    const patch: Partial<SupportCaseRecord> = { status: next, notes };
    const isTerminal = next === 'resolved' || next === 'closed';
    const eff = effectiveEscalationStatus(c);
    const escWasActive = eff.active;
    if (isTerminal && escWasActive) {
      const histEntry: SupportCaseEscalationEntry = {
        at: nowIso,
        by: operatorName,
        byRole: currentRole,
        action: 'resolved',
        oldValue: eff.status,
        newValue: 'resolved',
        note: `Auto-resolved on case ${next}`,
      };
      patch.escalationStatus = 'resolved';
      patch.escalated = false;
      patch.escalationHistory = [...(c.escalationHistory || []), histEntry];
      notes.push({
        id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 5)}_esc`,
        author: 'System Owner',
        body: `Escalation auto-resolved (case ${next})`,
        createdAt: nowIso,
        kind: 'escalation',
      });
    }
    updateCase(c.id, patch);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'support_case_status_changed',
      target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.status,
      newValue: next,
      severity: isTerminal ? 'info' : 'notice',
    });
    if (isTerminal && escWasActive) {
      pushPlatformAudit({
        actor: 'System Owner',
        action: 'support_case_escalation_resolved',
        target: `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`,
        category: 'support',
        tenantId: c.tenantId,
        oldValue: eff.status,
        newValue: 'resolved',
        severity: 'info',
        note: `Auto-resolved on case ${next}`,
      });
    }
  };

  const changeSeverity = (c: SupportCaseRecord, next: SupportCaseSeverity) => {
    if (c.severity === next) return;
    // Handler-level matrix check: severity changes require
    // change_support_severity (Edit threshold).
    const perm = hasPlatformPermission(sessionRole, 'change_support_severity');
    if (!perm.allowed) { console.warn("[support-tools] permission denied:", perm.reason); return; }
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
    // Handler-level matrix check: assignment requires assign_support_case.
    const perm = hasPlatformPermission(sessionRole, 'assign_support_case');
    if (!perm.allowed) { console.warn("[support-tools] permission denied:", perm.reason); return; }
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

  // Phase 1.1.3A — escalation lifecycle handlers. Each transition writes
  // exactly one audit row + one timeline note + one escalationHistory
  // entry. Legacy `escalated:true/false` is kept in sync so existing
  // CommandCenter pulse / Needs-Attention / NBA logic continues to work
  // without changes (back-compat).
  const buildTarget = (c: SupportCaseRecord) =>
    `${tenantById.get(c.tenantId) || c.tenantId} · ${c.subject}`;

  const gatedCan = (action: EscalationAction, _ctx: { targetTeam?: EscalationTargetTeam | string | null; isOwner?: boolean }): CanResult => {
    const MATRIX_SUB_KEY: Record<EscalationAction, string> = {
      escalate: 'escalate_assigned_case',
      assign_owner: 'assign_escalation_owner_team',
      acknowledge: 'acknowledge_escalation',
      change_level: 'change_escalation_level',
      deescalate: 'deescalate_support_case',
      resolve_escalation: 'resolve_escalation',
      close_with_active_escalation: 'close_with_active_escalation',
      edit_assignment: 'assign_support_case',
    };
    const subKey = MATRIX_SUB_KEY[action];
    const matrixResult = hasPlatformPermission(sessionRole, subKey);
    return {
      allowed: matrixResult.allowed,
      reason: matrixResult.reason,
    };
  };

  const escalateCaseStructured = (c: SupportCaseRecord) => {
    const draft = escalateDraft;
    const check = gatedCan('escalate', { targetTeam: draft.targetTeam });
    if (!check.allowed) return;
    const now = new Date();
    const ackDue = new Date(now.getTime() + Math.max(1, draft.ackHours) * 36e5);
    const escDue = new Date(now.getTime() + 72 * 36e5);
    const reasonLabel = ESCALATION_REASON_LABEL[draft.reasonCode];
    const reasonText = draft.reasonNote.trim()
      ? `${reasonLabel} — ${draft.reasonNote.trim()}`
      : reasonLabel;
    const historyEntry: SupportCaseEscalationEntry = {
      at: now.toISOString(),
      by: operatorName,
      byRole: currentRole,
      action: 'escalated',
      newValue: draft.level,
      note: reasonText,
    };
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: operatorName,
      body: `Escalated · ${draft.level} · ${draft.targetTeam} · ${reasonText}`,
      createdAt: now.toISOString(),
      kind: 'escalation',
    };
    updateCase(c.id, {
      escalated: true,
      escalationStatus: 'escalated',
      escalationLevel: draft.level,
      escalationReasonCode: draft.reasonCode,
      escalationReasonNote: draft.reasonNote.trim() || null,
      escalationReason: reasonText,
      escalationOwnerName: draft.ownerName.trim() || null,
      escalationOwnerId: draft.ownerName.trim()
        ? `op_${draft.ownerName.trim().toLowerCase().replace(/\s+/g, '_')}`
        : null,
      escalationTargetTeam: draft.targetTeam,
      assignedTeamName: draft.targetTeam,
      escalatedAt: now.toISOString(),
      escalatedBy: operatorName,
      escalatedByRole: currentRole,
      acknowledgementDueAt: ackDue.toISOString(),
      escalationDueAt: escDue.toISOString(),
      escalationHistory: [...(c.escalationHistory || []), historyEntry],
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: operatorName,
      action: 'support_case_escalated',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      severity: 'warning',
      newValue: draft.level,
      note: `${draft.targetTeam} · ${reasonText}`,
    });
  };

  const acknowledgeEscalation = (c: SupportCaseRecord) => {
    const isOwner = !!c.escalationOwnerName && c.escalationOwnerName === operatorName;
    const check = gatedCan('acknowledge', {
      targetTeam: c.escalationTargetTeam,
      isOwner,
    });
    if (!check.allowed) return;
    const now = new Date();
    const historyEntry: SupportCaseEscalationEntry = {
      at: now.toISOString(),
      by: operatorName,
      byRole: currentRole,
      action: 'acknowledged',
    };
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: operatorName,
      body: `Acknowledged escalation`,
      createdAt: now.toISOString(),
      kind: 'escalation',
    };
    updateCase(c.id, {
      escalationStatus: 'acknowledged',
      acknowledgedAt: now.toISOString(),
      acknowledgedBy: operatorName,
      acknowledgedByRole: currentRole,
      escalationHistory: [...(c.escalationHistory || []), historyEntry],
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: operatorName,
      action: 'support_case_escalation_acknowledged',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      severity: 'notice',
    });
  };

  const assignEscalation = (c: SupportCaseRecord) => {
    const owner = assignDraft.ownerName.trim();
    const team = assignDraft.team;
    const reason = assignDraft.reason.trim();
    const check = gatedCan('assign_owner', { targetTeam: team });
    if (!check.allowed) return;
    const isReassign = !!(c.escalationOwnerName || c.assignedTeamName);
    const now = new Date();
    const historyEntry: SupportCaseEscalationEntry = {
      at: now.toISOString(),
      by: operatorName,
      byRole: currentRole,
      action: isReassign ? 'reassigned' : 'assigned',
      oldValue: c.escalationOwnerName || c.assignedTeamName || null,
      newValue: `${owner || '—'} · ${team}`,
      note: reason || null,
    };
    const assnEntry: SupportCaseAssignmentEntry = {
      at: now.toISOString(),
      by: operatorName,
      oldOwnerName: c.escalationOwnerName || null,
      newOwnerName: owner || null,
      oldTeamName: c.assignedTeamName || null,
      newTeamName: team,
      reason: reason || null,
    };
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: operatorName,
      body: `${isReassign ? 'Reassigned' : 'Assigned'} · ${owner || '—'} · ${team}${
        reason ? ` — ${reason}` : ''
      }`,
      createdAt: now.toISOString(),
      kind: 'escalation',
    };
    updateCase(c.id, {
      escalationOwnerName: owner || null,
      escalationOwnerId: owner
        ? `op_${owner.toLowerCase().replace(/\s+/g, '_')}`
        : null,
      escalationTargetTeam: team,
      assignedTeamName: team,
      assignmentReason: reason || null,
      assignmentHistory: [...(c.assignmentHistory || []), assnEntry],
      escalationHistory: [...(c.escalationHistory || []), historyEntry],
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: operatorName,
      action: isReassign
        ? 'support_case_escalation_reassigned'
        : 'support_case_escalation_assigned',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.escalationOwnerName || c.assignedTeamName || '—',
      newValue: `${owner || '—'} · ${team}`,
      severity: 'notice',
      note: reason || undefined,
    });
  };

  const changeEscalationLevel = (c: SupportCaseRecord) => {
    const level = levelDraft.level;
    const reason = levelDraft.reason.trim();
    const check = gatedCan('change_level', { targetTeam: c.escalationTargetTeam });
    if (!check.allowed) return;
    if (c.escalationLevel === level) return;
    const now = new Date();
    const historyEntry: SupportCaseEscalationEntry = {
      at: now.toISOString(),
      by: operatorName,
      byRole: currentRole,
      action: 'level_changed',
      oldValue: c.escalationLevel || null,
      newValue: level,
      note: reason || null,
    };
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: operatorName,
      body: `Escalation level: ${c.escalationLevel || '—'} → ${level}${
        reason ? ` — ${reason}` : ''
      }`,
      createdAt: now.toISOString(),
      kind: 'escalation',
    };
    const eff = effectiveEscalationStatus(c);
    const nextStatus =
      eff.status === 'deescalated' || eff.status === 'resolved'
        ? 'in_review'
        : eff.status === 'none'
          ? 'in_review'
          : eff.status;
    updateCase(c.id, {
      escalated: true,
      escalationStatus: nextStatus,
      escalationLevel: level,
      escalationHistory: [...(c.escalationHistory || []), historyEntry],
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: operatorName,
      action: 'support_case_escalation_level_changed',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      oldValue: c.escalationLevel || '—',
      newValue: level,
      severity: 'warning',
      note: reason || undefined,
    });
  };

  const resolveEscalation = (c: SupportCaseRecord) => {
    const note = resolveDraft.note.trim();
    const check = gatedCan('resolve_escalation', {
      targetTeam: c.escalationTargetTeam,
    });
    if (!check.allowed) return;
    const now = new Date();
    const historyEntry: SupportCaseEscalationEntry = {
      at: now.toISOString(),
      by: operatorName,
      byRole: currentRole,
      action: 'resolved',
      note: note || null,
    };
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: operatorName,
      body: `Escalation resolved${note ? ` — ${note}` : ''}`,
      createdAt: now.toISOString(),
      kind: 'escalation',
    };
    updateCase(c.id, {
      escalated: false,
      escalationStatus: 'resolved',
      resolvedEscalationAt: now.toISOString(),
      resolvedEscalationBy: operatorName,
      escalationHistory: [...(c.escalationHistory || []), historyEntry],
      notes: [...(c.notes || []), transitionNote],
    });
    pushPlatformAudit({
      actor: operatorName,
      action: 'support_case_escalation_resolved',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      severity: 'notice',
      note: note || undefined,
    });
  };

  const deescalateCase = (c: SupportCaseRecord) => {
    const note = deescalateDraft.note.trim();
    const isOwner = !!c.escalationOwnerName && c.escalationOwnerName === operatorName;
    const check = gatedCan('deescalate', {
      targetTeam: c.escalationTargetTeam,
      isOwner,
    });
    if (!check.allowed) return;
    const now = new Date();
    const historyEntry: SupportCaseEscalationEntry = {
      at: now.toISOString(),
      by: operatorName,
      byRole: currentRole,
      action: 'deescalated',
      note: note || null,
    };
    const transitionNote: SupportCaseNote = {
      id: `cn_${now.getTime()}_${Math.random().toString(36).slice(2, 5)}`,
      author: operatorName,
      body: `De-escalated${note ? ` — ${note}` : ''}`,
      createdAt: now.toISOString(),
      kind: 'escalation',
    };
    // Phase 1.1.3A correction — if this de-escalation is approving a
    // pending request, mark the request approved and emit the paired
    // request-approved audit row alongside the deescalated audit.
    const isApprovingRequest =
      approvingRequestForCaseId === c.id && c.deescalationRequestStatus === 'pending';
    const patch: Partial<SupportCaseRecord> = {
      escalated: false,
      escalationStatus: 'deescalated',
      deescalatedAt: now.toISOString(),
      deescalatedBy: operatorName,
      escalationReason: null,
      escalationHistory: [...(c.escalationHistory || []), historyEntry],
      notes: [...(c.notes || []), transitionNote],
    };
    if (isApprovingRequest) {
      patch.deescalationRequestStatus = 'approved';
      patch.deescalationRequestReviewedAt = now.toISOString();
      patch.deescalationRequestReviewedBy = operatorName;
      patch.deescalationRequestDecisionReason = note || null;
    }
    updateCase(c.id, patch);
    if (isApprovingRequest) {
      pushPlatformAudit({
        actor: operatorName,
        action: 'support_case_deescalation_request_approved',
        target: buildTarget(c),
        category: 'support',
        tenantId: c.tenantId,
        severity: 'notice',
        note: note || undefined,
      });
      setApprovingRequestForCaseId(null);
    }
    pushPlatformAudit({
      actor: operatorName,
      action: 'support_case_deescalated',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      severity: 'notice',
      note: note || undefined,
    });
  };

  // Phase 1.1.3A correction — reject a pending de-escalation request.
  // Requires reason. Never mutates escalation status. Emits one audit row
  // and a timeline note for traceability.
  const rejectDeescalationRequest = (c: SupportCaseRecord) => {
    const reason = rejectDeescDraft.reason.trim();
    if (!reason) return;
    if (c.deescalationRequestStatus !== 'pending') {
      setRejectDeescModal(null);
      return;
    }
    // Reviewer must hold the de-escalate permission to act on the request.
    const recheck = hasPlatformPermission(sessionRole, 'deescalate_support_case');
    if (!recheck.allowed) {
      console.warn('[support-tools] reject-request denied at confirm:', recheck.reason);
      setRejectDeescModal(null);
      return;
    }
    const nowIso = new Date().toISOString();
    const rejectionNote: SupportCaseNote = {
      id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      author: operatorName,
      body: `De-escalation request rejected by ${operatorName} (${currentRole}): ${reason}`,
      createdAt: nowIso,
      kind: 'note',
    };
    updateCase(c.id, {
      deescalationRequestStatus: 'rejected',
      deescalationRequestReviewedAt: nowIso,
      deescalationRequestReviewedBy: operatorName,
      deescalationRequestDecisionReason: reason,
      notes: [...(c.notes || []), rejectionNote],
    });
    pushPlatformAudit({
      actor: operatorName,
      action: 'support_case_deescalation_request_rejected',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      severity: 'notice',
      note: reason,
    });
    setRejectDeescDraft({ reason: '' });
    setRejectDeescModal(null);
  };

  const confirmCloseWithActiveEscalation = (c: SupportCaseRecord) => {
    pushPlatformAudit({
      actor: operatorName,
      action: 'support_case_close_with_active_escalation_warning',
      target: buildTarget(c),
      category: 'support',
      tenantId: c.tenantId,
      severity: 'warning',
      note: `Closed while escalation status was ${
        c.escalationStatus || (c.escalated ? 'escalated' : 'none')
      }.`,
    });
    closeCase(c);
    setCloseWarnModal(null);
  };

  const handleCloseCaseClick = (c: SupportCaseRecord) => {
    const eff = effectiveEscalationStatus(c);
    if (eff.active) {
      setCloseWarnModal(c);
      return;
    }
    closeCase(c);
  };

  const insertMacro = (id: string, macro: SupportMacro, currentDraft: string, setNoteDraft: (s: string) => void) => {
    // Pre-QA correction: macro insertion requires use_support_macro.
    const perm = hasPlatformPermission(sessionRole, 'use_support_macro');
    if (!perm.allowed) { console.warn("[support-tools] permission denied:", perm.reason); return; }
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
    // Pre-QA correction: closing a case requires close_support_case.
    const perm = hasPlatformPermission(sessionRole, 'close_support_case');
    if (!perm.allowed) { console.warn("[support-tools] permission denied:", perm.reason); return; }
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
    // Pre-QA correction: reopening a case requires reopen_support_case.
    const perm = hasPlatformPermission(sessionRole, 'reopen_support_case');
    if (!perm.allowed) { console.warn("[support-tools] permission denied:", perm.reason); return; }
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
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-black text-primary tracking-tight">Support Tools</h2>
          <p className="text-slate-500 font-medium">Tenant search, case management, and operational helpers.</p>
          {/* Phase 1.1.3A — visible truth labels (escalation = internal
              workflow + advisory permissions). */}
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="support-truth-labels">
            <span className="text-[10px] font-bold text-slate-500 italic">{PHASE_113A_TRUTH_LABEL}</span>
            <span className="text-[10px] font-bold text-slate-400 italic">·</span>
            <span className="text-[10px] font-bold text-slate-500 italic">{PHASE_113A_PERMISSION_LABEL}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {(() => {
            const createGate = hasPlatformPermission(sessionRole, 'create_support_case');
            return (
              <button
                onClick={() => { if (createGate.allowed) setShowCreate(true); }}
                disabled={!createGate.allowed}
                title={createGate.allowed ? '' : createGate.reason}
                data-testid="support-create-case-button"
                className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                + New Case
              </button>
            );
          })()}
        </div>
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
          {predefinedSupportViews.map(v => {
            // Phase 1.1.2 — saved view "queue" count from shared helper.
            // Phase 1.1.3A — pass operator/team ctx so the new "Assigned
            // to Me" / "My Team" escalation queues count correctly.
            const count = countCasesForSupportView(v, cases, undefined, supportViewCtx);
            const active = activeView === v.id;
            return (
              <button
                key={v.id}
                data-testid={`support-saved-view-${v.id}`}
                data-active={active ? 'true' : 'false'}
                onClick={() => applyView(v.id)}
                className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all inline-flex items-center gap-2 ${active ? 'bg-primary text-white shadow-md ring-2 ring-primary/20' : 'bg-white text-slate-600 border border-slate-200 hover:bg-primary/5 hover:text-primary hover:border-primary/30'}`}
              >
                <span>{v.label}</span>
                <span
                  data-testid={`support-saved-view-${v.id}-count`}
                  className={`px-1.5 py-0.5 rounded-md text-[9px] font-black ${active ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-500'}`}
                >
                  {count}
                </span>
              </button>
            );
          })}
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
                      {c.sourceAuditEventId && <span className="ml-2 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-blue-400/10 text-blue-700 border border-blue-400/20">from audit</span>}
                    </p>
                    <p className="text-[10px] text-slate-400 font-mono">{c.id}</p>
                    {(() => {
                      const eff = effectiveEscalationStatus(c);
                      if (eff.status === 'none') return null;
                      const ackOverdue = isEscalationAckOverdue(c);
                      const owner = (c.escalationOwnerName || '').trim();
                      const team = (c.escalationTargetTeam || c.assignedTeamName || '').trim();
                      return (
                        <div
                          className="flex flex-wrap gap-1 mt-1.5"
                          data-testid={`support-case-row-escalation-${c.id}`}
                        >
                          <span
                            className={`px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${ESCALATION_STATUS_STYLES[eff.status]}`}
                            title={ESCALATION_STATUS_LABEL[eff.status]}
                            data-testid={`support-case-row-esc-status-${c.id}`}
                          >
                            {ESCALATION_STATUS_LABEL[eff.status]}
                          </span>
                          {eff.level && (
                            <span
                              className={`px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border ${ESCALATION_LEVEL_STYLES[eff.level]}`}
                              data-testid={`support-case-row-esc-level-${c.id}`}
                            >
                              {ESCALATION_LEVEL_LABEL[eff.level]}
                            </span>
                          )}
                          {eff.active && ackOverdue && (
                            <span
                              className="px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-red-500/10 text-red-700 border border-red-500/30"
                              data-testid={`support-case-row-esc-overdue-${c.id}`}
                            >
                              Ack Overdue
                            </span>
                          )}
                          {eff.active && !owner && (
                            <span
                              className="px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-amber-400/10 text-amber-700 border border-amber-400/20"
                              data-testid={`support-case-row-esc-unassigned-${c.id}`}
                            >
                              Unassigned
                            </span>
                          )}
                          {eff.active && (owner || team) && (
                            <span
                              className="px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-slate-100 text-slate-600 border border-slate-200"
                              data-testid={`support-case-row-esc-owner-${c.id}`}
                              title={team ? `Team: ${team}` : undefined}
                            >
                              {owner || team}
                            </span>
                          )}
                          {eff.isLegacyOnly && (
                            <span
                              className="px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-slate-100 text-slate-500 border border-slate-200 italic"
                              title="Legacy escalated:true with no structured lifecycle yet."
                            >
                              Legacy
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-6 py-3.5 text-sm font-bold text-slate-700">{tenantById.get(c.tenantId) || c.tenantId}</td>
                  <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_STYLES[c.status]}`}>{STATUS_LABELS[c.status]}</span></td>
                  <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SEVERITY_STYLES[c.severity]}`}>{c.severity}</span></td>
                  <td className="px-6 py-3.5">
                    {/* Phase 1.1.1 UX Correction — bigger SLA pill with state-colored bar + microcopy.
                        Pre-QA correction: pill content gated by view_support_sla. */}
                    {viewSupportSlaGate.allowed ? (
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
                    ) : (
                      <span className="text-xs text-slate-300" data-testid={`support-sla-${c.id}-hidden`}>—</span>
                    )}
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
              {/* Phase 1.1.1 UX Correction — widened escalation banner with reason, who/when, De-escalate.
                  Phase 1.1.3A correction — banner visibility now follows the
                  shared `isActiveEscalation` predicate so a case escalated via
                  the structured `escalationStatus` (without flipping the legacy
                  `escalated` boolean) still shows the red banner. Keeps banner,
                  escalation detail card, and De-escalate button in lock-step. */}
              {escVm?.canShowEscalationBanner && (
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
                  {(() => {
                    // De-escalate banner button: opens the confirmation
                    // modal (which now also re-checks the permission at
                    // confirm-time so a stale UI cannot bypass the gate).
                    //
                    // Lightweight Request De-escalation fallback: when the
                    // operator cannot de-escalate but CAN add internal
                    // notes, surface a "Request De-escalation" affordance
                    // that posts an internal note + audit row WITHOUT
                    // mutating escalation status. This gives front-line
                    // staff a documented escalation-review path.
                    //
                    // Phase 1.1.3A correction — pending-review lifecycle:
                    // when a request is currently pending, the request
                    // affordance is replaced by a non-actionable status
                    // pill so the requester cannot fire duplicate requests
                    // (one active pending request per case). Reviewers
                    // still see the De-escalate button alongside (the
                    // pending card below adds approve/reject).
                    const deescPerm = hasPlatformPermission(sessionRole, 'deescalate_support_case');
                    const requestPending = selected.deescalationRequestStatus === 'pending';
                    if (deescPerm.allowed) {
                      return (
                        <button
                          onClick={() => { setApprovingRequestForCaseId(null); setDeescalateModal(selected); }}
                          className="px-3 py-1.5 bg-white/15 hover:bg-white/25 text-[10px] font-black uppercase tracking-widest rounded-lg backdrop-blur-sm transition-colors whitespace-nowrap"
                          data-testid="support-case-deescalate-banner"
                        >
                          De-escalate
                        </button>
                      );
                    }
                    if (requestPending) {
                      // Requester (or any non-reviewer) sees the pending
                      // pill — request button is intentionally not shown.
                      return (
                        <span
                          data-testid="support-case-deesc-request-pending-pill"
                          title={selected.deescalationRequestReason || 'De-escalation request pending review by a permitted operator.'}
                          className="px-3 py-1.5 bg-white/20 text-[10px] font-black uppercase tracking-widest rounded-lg backdrop-blur-sm whitespace-nowrap cursor-default opacity-90"
                        >
                          De-escalation Request Submitted
                        </span>
                      );
                    }
                    if (addInternalNoteGate.allowed) {
                      return (
                        <button
                          onClick={() => { setRequestDeescDraft({ note: '' }); setRequestDeescModal(selected); }}
                          title="You don't have permission to de-escalate. This will post an internal note and audit row requesting review by a permitted operator."
                          className="px-3 py-1.5 bg-white/15 hover:bg-white/25 text-[10px] font-black uppercase tracking-widest rounded-lg backdrop-blur-sm transition-colors whitespace-nowrap"
                          data-testid="support-case-request-deescalation"
                        >
                          Request De-escalation
                        </button>
                      );
                    }
                    return null;
                  })()}
                </div>
              )}

              {/* Phase 1.1.3A correction — Pending De-escalation Request card.
                  Visible only for reviewers who can actually de-escalate
                  AND when a pending request exists. Provides approve
                  (→ existing De-escalate confirmation flow, also flips
                  request to approved on confirm) and reject (→ requires
                  reason; never mutates escalation status). */}
              {escVm?.isActive &&
                selected.deescalationRequestStatus === 'pending' &&
                hasPlatformPermission(sessionRole, 'deescalate_support_case').allowed && (
                  <div
                    className="px-7 py-4 bg-amber-50 border-b border-amber-200 flex items-start gap-3"
                    data-testid="support-case-deesc-request-reviewer-card"
                  >
                    <span className="material-symbols-outlined text-amber-700 text-2xl mt-0.5">rule</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-black uppercase tracking-widest text-amber-800">
                        Pending De-escalation Request
                      </p>
                      <p className="text-[11px] font-bold text-amber-900 mt-1.5">
                        {selected.deescalationRequestedBy || '—'}
                        {selected.deescalationRequestedByRole ? ` (${selected.deescalationRequestedByRole})` : ''}
                        {selected.deescalationRequestedAt ? ` · ${new Date(selected.deescalationRequestedAt).toLocaleString()}` : ''}
                      </p>
                      {selected.deescalationRequestReason && (
                        <p className="text-[11px] text-amber-900/80 font-medium mt-1 leading-snug">
                          “{selected.deescalationRequestReason}”
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => {
                          // Use the existing De-escalate confirmation flow
                          // (which re-checks the permission at confirm).
                          // The deescalateCase handler will detect this
                          // flag and emit the request-approved audit row.
                          setApprovingRequestForCaseId(selected.id);
                          setDeescalateModal(selected);
                        }}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-black uppercase tracking-widest rounded-lg whitespace-nowrap transition-colors"
                        data-testid="support-case-deesc-request-approve"
                      >
                        Approve & De-escalate
                      </button>
                      <button
                        onClick={() => { setRejectDeescDraft({ reason: '' }); setRejectDeescModal(selected); }}
                        className="px-3 py-1.5 bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 text-[10px] font-black uppercase tracking-widest rounded-lg whitespace-nowrap transition-colors"
                        data-testid="support-case-deesc-request-reject"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

              {/* Status echo for requester / others when the request was
                  resolved (approved or rejected) and the case is still
                  open — quiet, single-line transparency. */}
              {escVm?.isActive &&
                (selected.deescalationRequestStatus === 'rejected') && (
                  <div
                    className="px-7 py-2.5 bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-600 flex items-center gap-2"
                    data-testid="support-case-deesc-request-rejected-pill"
                  >
                    <span className="material-symbols-outlined text-sm text-slate-500">cancel</span>
                    De-escalation request rejected
                    {selected.deescalationRequestReviewedBy ? ` by ${selected.deescalationRequestReviewedBy}` : ''}
                    {selected.deescalationRequestReviewedAt ? ` · ${new Date(selected.deescalationRequestReviewedAt).toLocaleString()}` : ''}
                    {selected.deescalationRequestDecisionReason ? ` — ${selected.deescalationRequestDecisionReason}` : ''}
                  </div>
                )}
              {/* Phase 1.1.2 — case detail header summary band: SLA + escalation
                  + tenant-risk pills surfaced at-a-glance. */}
              <div className="p-7 border-b border-slate-100 flex justify-between items-start" data-testid="support-case-header">
                <div className="flex-1 pr-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{selected.id}</p>
                  <h3 className="text-lg font-black text-primary mt-1">{selected.subject}</h3>
                  <p className="text-xs text-slate-500 font-bold mt-1">{tenantById.get(selected.tenantId) || selected.tenantId}</p>
                  <div className="flex flex-wrap gap-2 mt-2" data-testid="support-case-header-pills">
                    {(() => {
                      const sla = deriveSlaStatus(selected);
                      return (
                        <span className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${SLA_STATUS_STYLES[sla.status]}`} title={sla.label}>
                          SLA · {SLA_STATUS_LABEL[sla.status]}
                        </span>
                      );
                    })()}
                    {escVm?.isActive && (
                      <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded bg-red-500/10 text-red-700 border border-red-500/20">
                        Escalated
                      </span>
                    )}
                    {tenantRiskForSelected && (
                      <span
                        data-testid="support-case-header-risk"
                        title={tenantRiskForSelected.signals.join(' · ') || 'No active risk signals'}
                        className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${RISK_STATUS_STYLES[tenantRiskForSelected.status]}`}
                      >
                        Risk · {RISK_STATUS_LABEL[tenantRiskForSelected.status]}
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
                  {(() => {
                    // Section/UI-level matrix gates for status & severity.
                    // Selects render disabled (with reason tooltip) when the
                    // matching child sub-permission is not satisfied; the
                    // handlers above also re-check the permission so a stale
                    // DOM cannot bypass the gate.
                    const statusPerm = hasPlatformPermission(sessionRole, 'change_support_status');
                    const severityPerm = hasPlatformPermission(sessionRole, 'change_support_severity');
                    return (
                      <>
                        <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Status</label>
                          <select
                            value={selected.status}
                            onChange={e => changeStatus(selected, e.target.value as SupportCaseStatus)}
                            disabled={!statusPerm.allowed}
                            title={statusPerm.allowed ? '' : statusPerm.reason}
                            data-testid="support-case-status-select"
                            className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 ${!statusPerm.allowed ? 'opacity-60 cursor-not-allowed' : ''}`}
                          >
                            {(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as SupportCaseStatus[]).map(s => (
                              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Severity</label>
                          <select
                            value={selected.severity}
                            onChange={e => changeSeverity(selected, e.target.value as SupportCaseSeverity)}
                            disabled={!severityPerm.allowed}
                            title={severityPerm.allowed ? '' : severityPerm.reason}
                            data-testid="support-case-severity-select"
                            className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 ${!severityPerm.allowed ? 'opacity-60 cursor-not-allowed' : ''}`}
                          >
                            {(['low', 'normal', 'high', 'urgent'] as SupportCaseSeverity[]).map(s => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </div>
                      </>
                    );
                  })()}
                  <div className="col-span-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Assignee</label>
                    <input
                      defaultValue={selected.assignee || ''}
                      onBlur={e => changeAssignee(selected, e.target.value)}
                      disabled={!assignSupportCaseGate.allowed}
                      title={assignSupportCaseGate.allowed ? '' : assignSupportCaseGate.reason}
                      data-testid="support-case-assignee-input"
                      className={`w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 ${!assignSupportCaseGate.allowed ? 'opacity-60 cursor-not-allowed' : ''}`}
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

                {/* Phase 1.1.3A — Escalation Card (full lifecycle metadata
                    + role-gated buttons via can()). Replaces the simple
                    Phase 1.1 escalation row. */}
                {(() => {
                  // Phase 1.1.3A correction — derive the card's active /
                  // status / level from the SHARED escalation view model so
                  // the card and its De-escalate button cannot drift from the
                  // banner / header pill (which read the same `escVm`).
                  const eff = { status: escVm!.status, level: escVm!.level, active: escVm!.isActive };
                  const ackOverdue = isEscalationAckOverdue(selected);
                  const isOwner = !!selected.escalationOwnerName && selected.escalationOwnerName === operatorName;
                  const ctx = { targetTeam: selected.escalationTargetTeam ?? null, isOwner };
                  const checks: Record<EscalationAction, CanResult> = {
                    escalate: gatedCan('escalate', ctx),
                    assign_owner: gatedCan('assign_owner', ctx),
                    acknowledge: gatedCan('acknowledge', ctx),
                    change_level: gatedCan('change_level', ctx),
                    deescalate: gatedCan('deescalate', ctx),
                    resolve_escalation: gatedCan('resolve_escalation', ctx),
                    close_with_active_escalation: gatedCan('close_with_active_escalation', ctx),
                    edit_assignment: gatedCan('edit_assignment', ctx),
                  };
                  const Btn: React.FC<{
                    action: EscalationAction;
                    label: string;
                    onClick: () => void;
                    variant?: 'primary' | 'ghost' | 'danger';
                    testId: string;
                  }> = ({ action, label, onClick, variant = 'ghost', testId }) => {
                    const r = checks[action];
                    const base = 'px-3 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all';
                    const styles = !r.allowed
                      ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                      : variant === 'primary'
                        ? 'bg-primary text-white hover:bg-primary/90'
                        : variant === 'danger'
                          ? 'bg-red-500/90 text-white hover:bg-red-500'
                          : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50';
                    return (
                      <button
                        type="button"
                        onClick={r.allowed ? onClick : undefined}
                        disabled={!r.allowed}
                        title={r.allowed ? PLATFORM_OPS_ROLE_DESCRIPTION[currentRole] : r.reason}
                        data-testid={testId}
                        data-allowed={r.allowed ? 'true' : 'false'}
                        className={`${base} ${styles}`}
                      >
                        {label}
                      </button>
                    );
                  };
                  return (
                    <div
                      className="p-4 rounded-2xl border border-slate-100 bg-slate-50/40 space-y-3"
                      data-testid="support-case-escalation-card"
                    >
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Escalation</p>
                            <span
                              className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${ESCALATION_STATUS_STYLES[eff.status]}`}
                              data-testid="support-case-esc-status-pill"
                            >
                              {ESCALATION_STATUS_LABEL[eff.status]}
                            </span>
                            {eff.level && (
                              <span
                                className={`px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded border ${ESCALATION_LEVEL_STYLES[eff.level]}`}
                                data-testid="support-case-esc-level-pill"
                              >
                                {ESCALATION_LEVEL_LABEL[eff.level]}
                              </span>
                            )}
                            {eff.active && ackOverdue && (
                              <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded bg-red-500/10 text-red-700 border border-red-500/30" data-testid="support-case-esc-ack-overdue">
                                Ack Overdue
                              </span>
                            )}
                            {eff.active && isEscalationCritical(selected) && (
                              <span className="px-2 py-0.5 text-[10px] font-black uppercase tracking-widest rounded bg-red-600/10 text-red-800 border border-red-600/30">
                                Critical
                              </span>
                            )}
                          </div>
                          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-slate-600">
                            {selected.escalationReasonCode && (
                              <div>
                                <span className="text-slate-400 font-bold">Reason:</span>{' '}
                                <span className="font-bold">{ESCALATION_REASON_LABEL[selected.escalationReasonCode]}</span>
                              </div>
                            )}
                            {selected.escalationTargetTeam && (
                              <div>
                                <span className="text-slate-400 font-bold">Team:</span>{' '}
                                <span className="font-bold">{selected.escalationTargetTeam}</span>
                              </div>
                            )}
                            {(selected.escalationOwnerName || selected.escalationOwnerId) && (
                              <div>
                                <span className="text-slate-400 font-bold">Owner:</span>{' '}
                                <span className="font-bold" data-testid="support-case-esc-owner">
                                  {selected.escalationOwnerName || selected.escalationOwnerId}
                                </span>
                              </div>
                            )}
                            {selected.escalatedAt && (
                              <div>
                                <span className="text-slate-400 font-bold">Escalated:</span>{' '}
                                <span className="font-bold">{new Date(selected.escalatedAt).toLocaleString()}</span>
                                {selected.escalatedBy && (
                                  <span className="text-slate-400"> by {selected.escalatedBy}</span>
                                )}
                              </div>
                            )}
                            {selected.acknowledgementDueAt && eff.status === 'escalated' && (
                              <div>
                                <span className="text-slate-400 font-bold">Ack due:</span>{' '}
                                <span className={`font-bold ${ackOverdue ? 'text-red-700' : 'text-slate-700'}`}>
                                  {new Date(selected.acknowledgementDueAt).toLocaleString()}
                                </span>
                              </div>
                            )}
                            {selected.acknowledgedAt && (
                              <div>
                                <span className="text-slate-400 font-bold">Acknowledged:</span>{' '}
                                <span className="font-bold">{new Date(selected.acknowledgedAt).toLocaleString()}</span>
                                {selected.acknowledgedBy && (
                                  <span className="text-slate-400"> by {selected.acknowledgedBy}</span>
                                )}
                              </div>
                            )}
                            {selected.deescalatedAt && (
                              <div>
                                <span className="text-slate-400 font-bold">De-escalated:</span>{' '}
                                <span className="font-bold">{new Date(selected.deescalatedAt).toLocaleString()}</span>
                                {selected.deescalatedBy && (
                                  <span className="text-slate-400"> by {selected.deescalatedBy}</span>
                                )}
                              </div>
                            )}
                            {selected.resolvedEscalationAt && (
                              <div>
                                <span className="text-slate-400 font-bold">Resolved:</span>{' '}
                                <span className="font-bold">{new Date(selected.resolvedEscalationAt).toLocaleString()}</span>
                                {selected.resolvedEscalationBy && (
                                  <span className="text-slate-400"> by {selected.resolvedEscalationBy}</span>
                                )}
                              </div>
                            )}
                          </div>
                          {selected.escalationReasonNote && (
                            <p className="text-xs text-slate-700 mt-1.5 bg-white border border-slate-100 rounded-xl p-2">
                              {selected.escalationReasonNote}
                            </p>
                          )}
                          {!eff.active && eff.status === 'none' && (
                            <p className="text-sm font-bold text-slate-600 mt-1">Not escalated</p>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100" data-testid="support-case-esc-actions">
                        {!eff.active && (
                          <Btn
                            action="escalate"
                            label="Escalate"
                            variant="danger"
                            testId="support-case-esc-btn-escalate"
                            onClick={() => {
                              setEscalateDraft({
                                reasonCode: 'manual',
                                reasonNote: '',
                                level: selected.severity === 'urgent' ? 'L3' : 'L2',
                                targetTeam: ROLE_TEAM_BY_ROLE[currentRole] as EscalationTargetTeam || 'Support Tier 2',
                                ownerName: '',
                                ackHours: selected.severity === 'urgent' ? 1 : 4,
                              });
                              setEscalateModal(selected);
                            }}
                          />
                        )}
                        {eff.status === 'escalated' && (
                          <Btn
                            action="acknowledge"
                            label="Acknowledge"
                            variant="primary"
                            testId="support-case-esc-btn-ack"
                            onClick={() => acknowledgeEscalation(selected)}
                          />
                        )}
                        {eff.active && (
                          <Btn
                            action="assign_owner"
                            label={selected.escalationOwnerName ? 'Reassign' : 'Assign'}
                            testId="support-case-esc-btn-assign"
                            onClick={() => {
                              setAssignDraft({
                                ownerName: selected.escalationOwnerName || '',
                                team: (selected.escalationTargetTeam as EscalationTargetTeam) || 'Support Tier 2',
                                reason: '',
                              });
                              setAssignModal(selected);
                            }}
                          />
                        )}
                        {eff.active && (
                          <Btn
                            action="change_level"
                            label="Change Level"
                            testId="support-case-esc-btn-level"
                            onClick={() => {
                              setLevelDraft({
                                level: selected.escalationLevel || 'L2',
                                reason: '',
                              });
                              setLevelModal(selected);
                            }}
                          />
                        )}
                        {eff.active && (
                          <Btn
                            action="deescalate"
                            label="De-escalate"
                            testId="support-case-esc-btn-deesc"
                            onClick={() => {
                              setApprovingRequestForCaseId(null);
                              setDeescalateDraft({ note: '' });
                              setDeescalateModal(selected);
                            }}
                          />
                        )}
                        {eff.active && (
                          <Btn
                            action="resolve_escalation"
                            label="Resolve Escalation"
                            testId="support-case-esc-btn-resolve"
                            onClick={() => {
                              setResolveDraft({ note: '' });
                              setResolveModal(selected);
                            }}
                          />
                        )}
                      </div>
                      <p className="text-[10px] text-slate-400 italic">
                        Escalation actions follow the Global Permissions Matrix.
                      </p>
                    </div>
                  );
                })()}

                {/* Tenant Health mini-card — gated by view_support_tenant_health. */}
                {viewSupportTenantHealthGate.allowed && tenantRiskForSelected && (
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

                {/* Phase 1.1.1 UX Correction — Related Entities grouped into 3 cards (Source / Audits / Domains).
                    Pre-QA correction: gated by view_support_related_entities. */}
                {viewSupportRelatedEntitiesGate.allowed && (
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
                )}

                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Timeline ({(selected.notes || []).length})</p>
                  <NotesTimeline notes={selected.notes || []} />
                </div>

                {/* Pre-QA correction: Note Composer gated by add_internal_support_note;
                    Macro picker gated by use_support_macro (passed via prop). */}
                {addInternalNoteGate.allowed && (
                  <NoteComposer
                    caseId={selected.id}
                    macros={supportMacros}
                    canUseMacros={useSupportMacroGate.allowed}
                    onAdd={body => addNote(selected.id, body)}
                    onInsertMacro={(macro, currentDraft, setDraft) => insertMacro(selected.id, macro, currentDraft, setDraft)}
                  />
                )}

                {/* Close / Reopen — close is guarded when an active
                    escalation is present (Phase 1.1.3A).
                    Pre-QA correction: Close gated by close_support_case,
                    Reopen gated by reopen_support_case. */}
                <div className="flex gap-2 pt-3 border-t border-slate-100">
                  {selected.status !== 'closed' ? (
                    <button
                      onClick={() => handleCloseCaseClick(selected)}
                      disabled={!closeSupportCaseGate.allowed}
                      title={closeSupportCaseGate.allowed ? '' : closeSupportCaseGate.reason}
                      data-testid="support-case-close-btn"
                      className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 ${!closeSupportCaseGate.allowed ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      Close case
                    </button>
                  ) : (
                    <button
                      onClick={() => reopenCase(selected)}
                      disabled={!reopenSupportCaseGate.allowed}
                      title={reopenSupportCaseGate.allowed ? '' : reopenSupportCaseGate.reason}
                      data-testid="support-case-reopen-btn"
                      className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white bg-primary rounded-xl hover:bg-primary/90 ${!reopenSupportCaseGate.allowed ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >Reopen case</button>
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

      {/* Phase 1.1.3A — Escalate modal (full lifecycle form). */}
      <AnimatePresence>
        {escalateModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-escalate-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setEscalateModal(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-lg bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Escalate Case</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{escalateModal.id} · {escalateModal.subject}</p>
                <p className="text-[10px] font-bold text-slate-400 italic mt-1">{PHASE_113A_TRUTH_LABEL}</p>
              </div>
              <div className="p-6 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Reason</label>
                    <select
                      value={escalateDraft.reasonCode}
                      onChange={e => setEscalateDraft(d => ({ ...d, reasonCode: e.target.value as EscalationReasonCode }))}
                      data-testid="support-escalate-reason-code"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                    >
                      {ESCALATION_REASON_OPTIONS.map(r => (
                        <option key={r} value={r}>{ESCALATION_REASON_LABEL[r]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Level</label>
                    <select
                      value={escalateDraft.level}
                      onChange={e => setEscalateDraft(d => ({ ...d, level: e.target.value as EscalationLevel }))}
                      data-testid="support-escalate-level"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                    >
                      {ESCALATION_LEVEL_OPTIONS.map(l => (
                        <option key={l} value={l}>{ESCALATION_LEVEL_LABEL[l]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Target Team</label>
                    <select
                      value={escalateDraft.targetTeam}
                      onChange={e => setEscalateDraft(d => ({ ...d, targetTeam: e.target.value as EscalationTargetTeam }))}
                      data-testid="support-escalate-team"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                    >
                      {ESCALATION_TARGET_TEAM_OPTIONS.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Ack Due (hours)</label>
                    <input
                      type="number"
                      min={1}
                      max={72}
                      value={escalateDraft.ackHours}
                      onChange={e => setEscalateDraft(d => ({ ...d, ackHours: Math.max(1, Number(e.target.value) || 1) }))}
                      data-testid="support-escalate-ack-hours"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Owner (optional)</label>
                    <input
                      value={escalateDraft.ownerName}
                      onChange={e => setEscalateDraft(d => ({ ...d, ownerName: e.target.value }))}
                      data-testid="support-escalate-owner"
                      placeholder="Leave blank to keep unassigned"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Reason note (optional)</label>
                    <textarea
                      value={escalateDraft.reasonNote}
                      onChange={e => setEscalateDraft(d => ({ ...d, reasonNote: e.target.value }))}
                      data-testid="support-escalate-reason-note"
                      placeholder="Add operator context for the audit trail…"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 h-20 resize-none"
                    />
                  </div>
                </div>
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setEscalateModal(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button
                  onClick={() => { escalateCaseStructured(escalateModal); setEscalateModal(null); }}
                  data-testid="support-escalate-confirm"
                  className="px-6 py-2.5 bg-red-500/90 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-red-500"
                >
                  Escalate
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Phase 1.1.3A — Assign / Reassign modal. */}
      <AnimatePresence>
        {assignModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-assign-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setAssignModal(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">{assignModal.escalationOwnerName ? 'Reassign Owner' : 'Assign Owner'}</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{assignModal.id} · {assignModal.subject}</p>
              </div>
              <div className="p-6 space-y-3">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Owner</label>
                  <input
                    value={assignDraft.ownerName}
                    onChange={e => setAssignDraft(d => ({ ...d, ownerName: e.target.value }))}
                    data-testid="support-assign-owner"
                    placeholder="Operator display name"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Team</label>
                  <select
                    value={assignDraft.team}
                    onChange={e => setAssignDraft(d => ({ ...d, team: e.target.value as EscalationTargetTeam }))}
                    data-testid="support-assign-team"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                  >
                    {ESCALATION_TARGET_TEAM_OPTIONS.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Reason (optional)</label>
                  <textarea
                    value={assignDraft.reason}
                    onChange={e => setAssignDraft(d => ({ ...d, reason: e.target.value }))}
                    data-testid="support-assign-reason"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 h-20 resize-none"
                  />
                </div>
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setAssignModal(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button
                  onClick={() => { assignEscalation(assignModal); setAssignModal(null); }}
                  data-testid="support-assign-confirm"
                  className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90"
                >
                  {assignModal.escalationOwnerName ? 'Reassign' : 'Assign'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Phase 1.1.3A — Change Level modal. */}
      <AnimatePresence>
        {levelModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-level-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setLevelModal(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Change Escalation Level</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{levelModal.id} · {levelModal.subject}</p>
              </div>
              <div className="p-6 space-y-3">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">New Level</label>
                  <select
                    value={levelDraft.level}
                    onChange={e => setLevelDraft(d => ({ ...d, level: e.target.value as EscalationLevel }))}
                    data-testid="support-level-select"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                  >
                    {ESCALATION_LEVEL_OPTIONS.map(l => (
                      <option key={l} value={l}>{ESCALATION_LEVEL_LABEL[l]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Reason (optional)</label>
                  <textarea
                    value={levelDraft.reason}
                    onChange={e => setLevelDraft(d => ({ ...d, reason: e.target.value }))}
                    data-testid="support-level-reason"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 h-20 resize-none"
                  />
                </div>
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setLevelModal(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button
                  onClick={() => { changeEscalationLevel(levelModal); setLevelModal(null); }}
                  data-testid="support-level-confirm"
                  className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/90"
                >
                  Update Level
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Phase 1.1.3A — Resolve Escalation modal. */}
      <AnimatePresence>
        {resolveModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-resolve-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setResolveModal(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Resolve Escalation</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{resolveModal.id} · {resolveModal.subject}</p>
                <p className="text-[10px] font-bold text-slate-400 italic mt-1">Marks the escalation as resolved. The case itself remains in its current status.</p>
              </div>
              <div className="p-6 space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Resolution note (optional)</label>
                <textarea
                  value={resolveDraft.note}
                  onChange={e => setResolveDraft({ note: e.target.value })}
                  data-testid="support-resolve-note"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 h-24 resize-none"
                />
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setResolveModal(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                {/* Pre-QA correction: confirm-time re-check of resolve_escalation
                    so a stale UI state (e.g. role changed mid-modal) cannot
                    bypass the matrix gate. Mirrors close-warn modal pattern. */}
                {(() => {
                  const r = gatedCan('resolve_escalation', { targetTeam: resolveModal.escalationTargetTeam });
                  return (
                <button
                  onClick={() => {
                    if (!r.allowed) return;
                    resolveEscalation(resolveModal);
                    setResolveModal(null);
                  }}
                  disabled={!r.allowed}
                  title={r.allowed ? '' : r.reason}
                  data-testid="support-resolve-confirm"
                  className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl ${r.allowed ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'}`}
                >
                  Resolve Escalation
                </button>
                  );
                })()}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Phase 1.1.3A — De-escalate modal (with reason). */}
      <AnimatePresence>
        {deescalateModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-deesc-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setDeescalateModal(null); setApprovingRequestForCaseId(null); }} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">De-escalate</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{deescalateModal.id} · {deescalateModal.subject}</p>
              </div>
              <div className="p-6 space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">
                  Reason <span className="text-red-500">*</span> required
                </label>
                <textarea
                  value={deescalateDraft.note}
                  onChange={e => setDeescalateDraft({ note: e.target.value })}
                  data-testid="support-deesc-note"
                  placeholder="Describe why this case is being de-escalated…"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 h-24 resize-none"
                />
                {!deescalateDraft.note.trim() && (
                  <p className="text-[10px] font-bold text-slate-400">Confirm is disabled until a reason is provided.</p>
                )}
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => { setDeescalateModal(null); setApprovingRequestForCaseId(null); }} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button
                  onClick={() => {
                    // Confirm-time matrix re-check: mirrors the close-warn /
                    // resolve-modal patterns so a stale UI (e.g. an open
                    // modal after the permission was revoked mid-session)
                    // cannot bypass the gate. Always clear the approval-
                    // intent flag on any exit path so it cannot leak into
                    // a later non-approval De-escalate flow.
                    const recheck = hasPlatformPermission(sessionRole, 'deescalate_support_case');
                    if (!recheck.allowed) {
                      console.warn('[support-tools] de-escalate denied at confirm:', recheck.reason);
                      setDeescalateModal(null);
                      setApprovingRequestForCaseId(null);
                      return;
                    }
                    deescalateCase(deescalateModal);
                    setDeescalateModal(null);
                  }}
                  disabled={!deescalateDraft.note.trim()}
                  data-testid="support-deesc-confirm"
                  className="px-6 py-2.5 bg-violet-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-violet-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
                >
                  De-escalate
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Request De-escalation (lightweight) — posts internal note + audit row
          requesting review by a permitted operator. Never mutates escalation
          status. Confirm-time re-checks add_internal_support_note. */}
      <AnimatePresence>
        {requestDeescModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-request-deesc-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setRequestDeescModal(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Request De-escalation</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{requestDeescModal.id} · {requestDeescModal.subject}</p>
                <p className="text-[10px] font-medium text-slate-500 mt-2 leading-snug">
                  You don't have permission to de-escalate directly. This will post an internal note and audit row asking a permitted operator to review. Escalation status will not change.
                </p>
              </div>
              <div className="p-6 space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">
                  Reason <span className="text-red-500">*</span> required
                </label>
                <textarea
                  value={requestDeescDraft.note}
                  onChange={e => setRequestDeescDraft({ note: e.target.value })}
                  data-testid="support-request-deesc-note"
                  placeholder="Explain why this case should be reviewed for de-escalation…"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 h-24 resize-none"
                />
                {!requestDeescDraft.note.trim() && (
                  <p className="text-[10px] font-bold text-slate-400">Confirm is disabled until a reason is provided.</p>
                )}
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setRequestDeescModal(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button
                  onClick={() => {
                    // Confirm-time recheck of the underlying note permission.
                    const recheck = hasPlatformPermission(sessionRole, 'add_internal_support_note');
                    if (!recheck.allowed) {
                      console.warn('[support-tools] request-deesc denied at confirm:', recheck.reason);
                      setRequestDeescModal(null);
                      return;
                    }
                    const reason = requestDeescDraft.note.trim();
                    if (!reason) return;
                    const target = requestDeescModal;
                    // Guard: one active pending request per case.
                    if (target.deescalationRequestStatus === 'pending') {
                      console.warn('[support-tools] de-escalation request already pending');
                      setRequestDeescModal(null);
                      return;
                    }
                    const nowIso = new Date().toISOString();
                    // Post internal note via existing addNote handler so the
                    // case-timeline shape stays consistent.
                    addNote(target.id, `De-escalation requested by ${operatorName} (${currentRole}): ${reason}`);
                    // Persist pending-review lifecycle state on the case so
                    // the requester sees a "Submitted" pill and reviewers
                    // with deescalate_support_case see the approve/reject
                    // card. Never mutates escalation status.
                    updateCase(target.id, {
                      deescalationRequestStatus: 'pending',
                      deescalationRequestedAt: nowIso,
                      deescalationRequestedBy: operatorName,
                      deescalationRequestedByRole: currentRole,
                      deescalationRequestReason: reason,
                      deescalationRequestReviewedAt: null,
                      deescalationRequestReviewedBy: null,
                      deescalationRequestDecisionReason: null,
                    });
                    pushPlatformAudit({
                      actor: operatorName,
                      action: 'support_case_deescalation_requested',
                      target: `${tenantById.get(target.tenantId) || target.tenantId} · ${target.subject}`,
                      category: 'support',
                      tenantId: target.tenantId,
                      severity: 'notice',
                      note: reason,
                    });
                    setRequestDeescModal(null);
                  }}
                  disabled={!requestDeescDraft.note.trim()}
                  data-testid="support-request-deesc-confirm"
                  className="px-6 py-2.5 bg-violet-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-violet-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
                >
                  Submit Request
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Phase 1.1.3A correction — Reject pending de-escalation request.
          Reviewer-only. Requires reason. Never mutates escalation status.
          Confirm-time re-checks deescalate_support_case (the reviewer
          gate) so a stale UI cannot bypass the gate. */}
      <AnimatePresence>
        {rejectDeescModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-reject-deesc-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setRejectDeescModal(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-primary tracking-tight">Reject De-escalation Request</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{rejectDeescModal.id} · {rejectDeescModal.subject}</p>
                <p className="text-[10px] font-medium text-slate-500 mt-2 leading-snug">
                  This will mark the pending request as rejected. Escalation status is NOT changed. The rejection (with your reason) is added to the case timeline and audit log.
                </p>
              </div>
              <div className="p-6 space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">
                  Rejection Reason <span className="text-red-500">*</span> required
                </label>
                <textarea
                  value={rejectDeescDraft.reason}
                  onChange={e => setRejectDeescDraft({ reason: e.target.value })}
                  data-testid="support-reject-deesc-reason"
                  placeholder="Explain why this de-escalation request is being rejected…"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 h-24 resize-none"
                />
                {!rejectDeescDraft.reason.trim() && (
                  <p className="text-[10px] font-bold text-slate-400">Confirm is disabled until a reason is provided.</p>
                )}
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setRejectDeescModal(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                <button
                  onClick={() => rejectDeescModal && rejectDeescalationRequest(rejectDeescModal)}
                  disabled={!rejectDeescDraft.reason.trim()}
                  data-testid="support-reject-deesc-confirm"
                  className="px-6 py-2.5 bg-amber-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
                >
                  Reject Request
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Phase 1.1.3A — Close-with-active-escalation warning. */}
      <AnimatePresence>
        {closeWarnModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" data-testid="support-close-warn-modal">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setCloseWarnModal(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-slate-100">
                <h3 className="text-lg font-black text-red-700 tracking-tight">Close with active escalation?</h3>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mt-1">{closeWarnModal.id} · {closeWarnModal.subject}</p>
              </div>
              <div className="p-6 space-y-2 text-xs text-slate-600">
                <p>This case still has an active escalation ({ESCALATION_STATUS_LABEL[effectiveEscalationStatus(closeWarnModal).status]}). Closing now will write a warning audit row.</p>
                {(() => {
                  const r = gatedCan('close_with_active_escalation', { targetTeam: closeWarnModal.escalationTargetTeam });
                  if (!r.allowed) {
                    return (
                      <p className="text-red-700 font-bold pt-1" data-testid="support-close-warn-blocked">{r.reason}</p>
                    );
                  }
                  return null;
                })()}
              </div>
              <div className="p-5 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setCloseWarnModal(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white">Cancel</button>
                {(() => {
                  const r = gatedCan('close_with_active_escalation', { targetTeam: closeWarnModal.escalationTargetTeam });
                  return (
                    <button
                      disabled={!r.allowed}
                      onClick={() => confirmCloseWithActiveEscalation(closeWarnModal)}
                      data-testid="support-close-warn-confirm"
                      title={r.allowed ? '' : r.reason}
                      className={`px-6 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl ${r.allowed ? 'bg-red-500/90 text-white hover:bg-red-500' : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'}`}
                    >
                      Close anyway
                    </button>
                  );
                })()}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Phase 1.1.2 — Timeline maturity: group by date heading + small icon per kind.
const NOTE_KIND_ICON: Record<string, string> = {
  status_change: 'sync',
  escalation: 'priority_high',
  resolution: 'task_alt',
  internal: 'sticky_note_2',
  reply: 'reply',
};
const dateBucketLabel = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  const today = new Date();
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
const NotesTimeline: React.FC<{ notes: SupportCaseNote[] }> = ({ notes }) => {
  if (notes.length === 0) return <p className="text-xs text-slate-400 font-bold py-4 text-center bg-slate-50 rounded-2xl">No notes yet.</p>;
  // Preserve original render order; just group sequential same-date entries.
  const groups: Array<{ label: string; items: SupportCaseNote[] }> = [];
  for (const n of notes) {
    const label = dateBucketLabel(n.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return (
    <div className="space-y-3" data-testid="support-timeline">
      {groups.map((g, gi) => (
        <div key={`${g.label}-${gi}`} data-testid={`support-timeline-group-${g.label.toLowerCase().replace(/\s+/g, '-')}`}>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 px-1">{g.label}</p>
          <div className="space-y-2">
            {g.items.map(n => {
              const icon = NOTE_KIND_ICON[n.kind || 'internal'] || 'sticky_note_2';
              return (
                <div key={n.id} className={`p-3 rounded-xl border flex items-start gap-2.5 ${n.kind === 'status_change' ? 'bg-blue-400/5 border-blue-400/20' : 'bg-slate-50 border-slate-100'}`}>
                  <span className={`material-symbols-outlined text-base mt-0.5 ${n.kind === 'status_change' ? 'text-blue-700' : 'text-slate-400'}`} title={n.kind || 'internal'}>{icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700">{n.body}</p>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">{n.author} · {new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

interface NoteComposerProps {
  caseId: string;
  macros: SupportMacro[];
  canUseMacros?: boolean;
  onAdd: (body: string) => void;
  onInsertMacro: (macro: SupportMacro, currentDraft: string, setDraft: (s: string) => void) => void;
}
const NoteComposer: React.FC<NoteComposerProps> = ({ caseId, macros, canUseMacros = true, onAdd, onInsertMacro }) => {
  const [body, setBody] = useState('');
  const [macroId, setMacroId] = useState('');
  // Reset draft when switching to a different case.
  useEffect(() => { setBody(''); setMacroId(''); }, [caseId]);
  // Phase 1.1.1 UX Correction — 2-step macro UX: pick → preview → Insert Template.
  const previewMacro = macros.find(m => m.id === macroId);
  return (
    <div className="space-y-2">
      {/* Pre-QA correction: macro picker only renders when canUseMacros=true. */}
      {canUseMacros && (
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
      )}
      {canUseMacros && previewMacro && (
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
