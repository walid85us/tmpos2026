import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  tenants,
  tenantDomains as tenantDomainsSeed,
  tenantDomainHistory,
  auditLogs,
  type TenantDomainRecord,
  type DomainStatus,
  type DomainSslStatus,
  type DomainKind,
  type DomainRole,
} from './mockData';
import { pushPlatformAudit, readMirroredAuditRows } from './platformOpsAudit';
import { useAccess } from '../context/AccessContext';
import { hasPlatformPermission } from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import {
  deriveDomainReadinessList,
  deriveDomainRole,
  deriveParentRootHostname,
  formatDnsRecord,
  DOMAIN_LIFECYCLE_LABELS,
  DOMAIN_ROLE_LABELS,
  DOMAIN_SSL_READINESS_LABELS,
  DOMAIN_TRUTH_LABELS,
  SECURITY_READINESS_LABELS,
  PLATFORM_ROOT_SUFFIX,
  type DomainLifecycleStatus,
  type DomainSslReadiness,
  type DomainDnsReadiness,
  type SecurityReadinessState,
  type DomainChecklistState,
  type DomainReadinessSignal,
} from './platformOpsDomains';

// Tone vocabulary shared by the Domain Control Panel readiness rows.
type ReadinessTone = 'ready' | 'pending' | 'failed' | 'neutral' | 'future';

const READINESS_TONE_STYLES: Record<ReadinessTone, string> = {
  ready: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
  pending: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  failed: 'bg-red-500/10 text-red-700 border-red-500/30',
  neutral: 'bg-slate-100 text-slate-500 border-slate-200',
  future: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
};

const DNS_READINESS_TONE: Record<DomainDnsReadiness, ReadinessTone> = {
  managed: 'ready',
  confirmed: 'ready',
  propagating: 'pending',
  not_configured: 'neutral',
  failed: 'failed',
  not_applicable: 'neutral',
};

const SECURITY_STATE_TONE: Record<SecurityReadinessState, ReadinessTone> = {
  ready: 'ready',
  pending: 'pending',
  failed: 'failed',
  not_started: 'neutral',
  not_applicable: 'neutral',
  future: 'future',
};

const CHECKLIST_TONE: Record<DomainChecklistState, { symbol: string; icon: string }> = {
  done: { symbol: 'check_circle', icon: 'text-lime-600' },
  current: { symbol: 'radio_button_checked', icon: 'text-primary' },
  todo: { symbol: 'radio_button_unchecked', icon: 'text-slate-300' },
  future: { symbol: 'schedule', icon: 'text-violet-500' },
  not_applicable: { symbol: 'remove_circle_outline', icon: 'text-slate-300' },
};

// Validation patterns for the Add Domain flow (Phase 1.2 acceptance correction).
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ROOT_DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

// The three ways an operator can add a domain record.
type DomainCreateType = 'root' | 'subdomain' | 'platform_subdomain';

const DOMAINS_KEY = 'tenant_domains_v1';

// Lifecycle tabs shown in the UF. 'draft' is intentionally excluded (Milestone
// 1 approval: it stays in the vocabulary for completeness but must not surface
// in the UI until a real draft persistence state exists).
const LIFECYCLE_TABS: DomainLifecycleStatus[] = [
  'pending_dns',
  'pending_verification',
  'verified',
  'ssl_pending',
  'ssl_ready',
  'failed',
  'disabled',
];

const LIFECYCLE_STYLES: Record<DomainLifecycleStatus, string> = {
  draft: 'bg-slate-100 text-slate-500 border-slate-200',
  pending_dns: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  pending_verification: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  verified: 'bg-teal-400/10 text-teal-700 border-teal-400/20',
  ssl_pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  ssl_ready: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
  failed: 'bg-red-500/10 text-red-700 border-red-500/30',
  disabled: 'bg-slate-200 text-slate-600 border-slate-300',
};

const SSL_READINESS_STYLES: Record<DomainSslReadiness, string> = {
  not_applicable: 'bg-slate-100 text-slate-500 border-slate-200',
  not_started: 'bg-slate-100 text-slate-500 border-slate-200',
  pending: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  failed: 'bg-red-500/10 text-red-700 border-red-500/30',
  ready: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
};

const STATUS_LABELS: Record<DomainStatus, string> = {
  pending: 'Pending',
  verifying: 'Verifying',
  verified: 'Verified',
  failed: 'Failed',
  disabled: 'Disabled',
};

const loadDomains = (): TenantDomainRecord[] => {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [...tenantDomainsSeed];
    const raw = window.sessionStorage.getItem(DOMAINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TenantDomainRecord[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* noop */ }
  return [...tenantDomainsSeed];
};

const saveDomains = (d: TenantDomainRecord[]) => {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(DOMAINS_KEY, JSON.stringify(d));
    }
  } catch { /* noop */ }
};

type RiskFilter = 'all' | 'needs_action' | 'at_risk';
type KindFilter = 'all' | DomainKind;
type SslFilter = 'all' | DomainSslReadiness;
type LifecycleFilter = 'all' | DomainLifecycleStatus;
// Raw persisted status filter — set only via Command Center deep-links
// (?status=...). It has no dropdown control of its own, but it ALWAYS renders a
// visible, clearable chip, so it never becomes an invisible filter.
type RawStatusFilter = 'all' | DomainStatus;

interface DomainFilters {
  search: string;
  lifecycle: LifecycleFilter;
  kind: KindFilter;
  ssl: SslFilter;
  risk: RiskFilter;
  rawStatus: RawStatusFilter;
}

const EMPTY_FILTERS: DomainFilters = {
  search: '',
  lifecycle: 'all',
  kind: 'all',
  ssl: 'all',
  risk: 'all',
  rawStatus: 'all',
};

// Single predicate — used for BOTH the visible list and every count, so card /
// tab counts can never drift from the filtered list (locked no-drift rule).
const matchesDomain = (s: DomainReadinessSignal, f: DomainFilters, tenantName: string): boolean => {
  if (f.lifecycle !== 'all' && s.lifecycle !== f.lifecycle) return false;
  if (f.rawStatus !== 'all' && s.rawStatus !== f.rawStatus) return false;
  if (f.kind !== 'all' && s.kind !== f.kind) return false;
  if (f.ssl !== 'all' && s.sslReadiness !== f.ssl) return false;
  if (f.risk === 'needs_action' && !s.needsAction) return false;
  if (f.risk === 'at_risk' && !s.riskReasons.some(r => r.tone === 'critical')) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${s.hostname} ${tenantName}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
};

// Portfolio grouping (Milestone 1 — Domains Control Panel layout). Roots act as
// parent records with their subdomains nested beneath; platform-provisioned and
// orphan/legacy subdomains get their own groups. A root may be shown as muted
// "context" when it does not itself match the filters but one of its children
// does, so the relationship stays understandable without an invisible filter.
type PortfolioGroupKind = 'root' | 'platform' | 'unlinked';
interface PortfolioRowData {
  signal: DomainReadinessSignal;
  nested: boolean;
  context: boolean;
}
interface PortfolioGroupData {
  key: string;
  kind: PortfolioGroupKind;
  title?: string;
  icon?: string;
  note?: string;
  rows: PortfolioRowData[];
}

const DomainsPage: React.FC = () => {
  const { session } = useAccess();
  const sessionRole = (session?.role as Role | undefined) || null;
  const viewGate = hasPlatformPermission(sessionRole, 'view_domains');
  const manageGate = hasPlatformPermission(sessionRole, 'manage_domain_lifecycle');
  const canManage = manageGate.allowed;

  const [domains, setDomains] = useState<TenantDomainRecord[]>(() => loadDomains());
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<DomainFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<{ tenantId: string; type: DomainCreateType; label: string; hostname: string; parentDomainId: string }>(
    { tenantId: '', type: 'root', label: '', hostname: '', parentDomainId: '' }
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<TenantDomainRecord | null>(null);
  const [auditTick, setAuditTick] = useState(0);

  useEffect(() => { saveDomains(domains); }, [domains]);

  useEffect(() => {
    const h = () => setAuditTick(t => t + 1);
    window.addEventListener('audit_logs:changed', h);
    return () => window.removeEventListener('audit_logs:changed', h);
  }, []);

  // Command Center deep-linking (item F). `?domain=<id>` opens the matching
  // record drawer (or shows a dismissible stale notice if it no longer exists);
  // `?status=<rawStatus>` applies a visible, clearable raw-status filter. After
  // applying, the params are stripped so refresh / back never re-triggers them.
  useEffect(() => {
    const domainParam = searchParams.get('domain');
    const statusParam = searchParams.get('status');
    if (!domainParam && !statusParam) return;

    if (statusParam) {
      const validStatuses: DomainStatus[] = ['pending', 'verifying', 'verified', 'failed', 'disabled'];
      if ((validStatuses as string[]).includes(statusParam)) {
        setFilters(f => ({ ...f, rawStatus: statusParam as DomainStatus }));
      }
    }
    if (domainParam) {
      if (domains.some(d => d.id === domainParam)) {
        setSelectedId(domainParam);
        setDeepLinkNotice(null);
      } else {
        setDeepLinkNotice(`Domain "${domainParam}" was not found — it may have been deleted or belongs to a different record set.`);
      }
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('domain');
    nextParams.delete('status');
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, domains, setSearchParams]);

  const tenantById = useMemo(() => {
    const m = new Map<string, string>();
    tenants.forEach(t => m.set(t.id, t.name));
    return m;
  }, []);
  const tenantName = (id: string) => tenantById.get(id) || id;

  const signals = useMemo(() => deriveDomainReadinessList(domains), [domains]);

  const signalById = useMemo(() => {
    const m = new Map<string, DomainReadinessSignal>();
    signals.forEach(s => m.set(s.id, s));
    return m;
  }, [signals]);

  const visible = useMemo(
    () => signals.filter(s => matchesDomain(s, filters, tenantName(s.tenantId))),
    [signals, filters, tenantById]
  );

  // Every tab / card count is computed from the SAME matchesDomain predicate as
  // the visible list — merging the control's own dimension overrides onto the
  // currently-active filters. This guarantees the number on any control always
  // equals what the list shows when that control is selected (locked no-drift).
  const countWith = (overrides: Partial<DomainFilters>) =>
    signals.filter(s => matchesDomain(s, { ...filters, ...overrides }, tenantName(s.tenantId))).length;

  const selected = useMemo(() => domains.find(d => d.id === selectedId) || null, [domains, selectedId]);
  const selectedSignal = selectedId ? signalById.get(selectedId) || null : null;

  // Grouped portfolio (root → nested subdomains, platform, unlinked/legacy).
  // Built from the SAME filtered `visible` set, so the leaf (non-context) rows
  // sum exactly to `visible.length` (no-drift); context roots are clearly muted.
  const portfolioGroups = useMemo<PortfolioGroupData[]>(() => {
    const visibleSet = new Set(visible.map(s => s.id));
    const groups: PortfolioGroupData[] = [];

    const roots = signals.filter(s => s.role === 'root').sort((a, b) => a.hostname.localeCompare(b.hostname));
    const rootIds = new Set(roots.map(r => r.id));

    roots.forEach(root => {
      const children = signals
        .filter(s => s.role === 'subdomain' && s.parentDomainId === root.id)
        .sort((a, b) => a.hostname.localeCompare(b.hostname));
      const matchingChildren = children.filter(c => visibleSet.has(c.id));
      const rootVisible = visibleSet.has(root.id);
      if (!rootVisible && matchingChildren.length === 0) return;
      const rows: PortfolioRowData[] = [{ signal: root, nested: false, context: !rootVisible }];
      matchingChildren.forEach(c => rows.push({ signal: c, nested: true, context: false }));
      const hidden = children.length - matchingChildren.length;
      groups.push({
        key: `root_${root.id}`,
        kind: 'root',
        note: hidden > 0 ? `${hidden} subdomain${hidden === 1 ? '' : 's'} hidden by active filters` : undefined,
        rows,
      });
    });

    const platform = signals
      .filter(s => s.role === 'subdomain' && s.kind === 'subdomain' && visibleSet.has(s.id))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
    if (platform.length > 0) {
      groups.push({
        key: 'platform',
        kind: 'platform',
        title: 'Platform Domains',
        icon: 'dns',
        note: `Auto-provisioned under ${PLATFORM_ROOT_SUFFIX}.`,
        rows: platform.map(s => ({ signal: s, nested: false, context: false })),
      });
    }

    const unlinked = signals
      .filter(s => s.role === 'subdomain' && s.kind === 'custom' && (!s.parentDomainId || !rootIds.has(s.parentDomainId)) && visibleSet.has(s.id))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
    if (unlinked.length > 0) {
      groups.push({
        key: 'unlinked',
        kind: 'unlinked',
        title: 'Unlinked / Legacy Subdomains',
        icon: 'link_off',
        note: 'No resolvable parent root on record.',
        rows: unlinked.map(s => ({ signal: s, nested: false, context: false })),
      });
    }

    // Safety net — any matching signal not yet placed (defensive against unusual
    // role/kind combinations) so a match can never be silently dropped.
    const placed = new Set<string>();
    groups.forEach(g => g.rows.forEach(r => { if (!r.context) placed.add(r.signal.id); }));
    const leftover = visible.filter(s => !placed.has(s.id)).sort((a, b) => a.hostname.localeCompare(b.hostname));
    if (leftover.length > 0) {
      groups.push({
        key: 'other',
        kind: 'unlinked',
        title: 'Other Domains',
        icon: 'help',
        rows: leftover.map(s => ({ signal: s, nested: false, context: false })),
      });
    }

    return groups;
  }, [signals, visible]);

  const today = new Date().toISOString().slice(0, 10);

  const selectedHistory = useMemo(() => {
    if (!selected) return [] as { id: string; date: string; actor: string; action: string }[];
    const host = selected.hostname;
    void auditTick;
    // Match the exact domain only — audit targets are either the bare hostname
    // (seed rows) or "<tenant> · <hostname>" (mirrored rows). Compare the last
    // "·"-delimited segment so a hostname that is a substring of another never
    // pulls in unrelated rows.
    const matchesHost = (target: unknown) => {
      const t = String(target).trim();
      if (t === host) return true;
      const parts = t.split('·').map(p => p.trim());
      return parts[parts.length - 1] === host;
    };
    const fromAudit = [...readMirroredAuditRows(), ...auditLogs]
      .filter(r => r.category === 'domains' && matchesHost(r.target))
      .map(r => ({ id: r.id, date: r.date, actor: r.actor, action: r.action }));
    const fromHistory = tenantDomainHistory
      .filter(h => h.domain === host)
      .map(h => ({ id: h.id, date: h.date, actor: h.actor, action: h.action }));
    // Dedupe by stable event id so distinct same-day events are preserved.
    const seen = new Set<string>();
    return [...fromAudit, ...fromHistory]
      .filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [selected, auditTick]);

  // Managed root domains the operator can attach a new subdomain to. Scoped to
  // the selected tenant (a subdomain lives under its own tenant's root) and
  // excludes disabled roots.
  const rootDomainsForTenant = useMemo(
    () => domains.filter(d => deriveDomainRole(d) === 'root' && d.status !== 'disabled' && d.tenantId === draft.tenantId),
    [domains, draft.tenantId]
  );
  const draftParentRoot = rootDomainsForTenant.find(d => d.id === draft.parentDomainId) || null;

  // Live hostname preview, mirrors exactly what handleCreate will persist.
  const draftLabel = draft.label.trim().toLowerCase();
  const computedHostname = (() => {
    if (draft.type === 'root') return draft.hostname.trim().toLowerCase();
    if (draft.type === 'platform_subdomain') return draftLabel ? `${draftLabel}.${PLATFORM_ROOT_SUFFIX}` : '';
    return draftLabel && draftParentRoot ? `${draftLabel}.${draftParentRoot.hostname}` : '';
  })();

  const resetDraft = () => setDraft({ tenantId: '', type: 'root', label: '', hostname: '', parentDomainId: '' });

  const handleCreate = () => {
    if (!canManage) return;
    if (!draft.tenantId) { setCreateError('Select a tenant first.'); return; }

    let hostname = '';
    let kind: DomainKind;
    let role: DomainRole;
    let parentDomainId: string | null = null;

    if (draft.type === 'root') {
      hostname = draft.hostname.trim().toLowerCase();
      if (!hostname) { setCreateError('Enter the root domain (e.g. example.com).'); return; }
      if (!ROOT_DOMAIN_RE.test(hostname)) { setCreateError('Enter a valid root domain, e.g. example.com.'); return; }
      kind = 'custom'; role = 'root';
    } else if (draft.type === 'subdomain') {
      if (!draft.parentDomainId || !draftParentRoot) { setCreateError('Select a parent root domain.'); return; }
      if (!draftLabel) { setCreateError('Enter the subdomain label.'); return; }
      if (!DNS_LABEL_RE.test(draftLabel)) { setCreateError('Subdomain label may use a–z, 0–9 and hyphens only (no leading/trailing hyphen).'); return; }
      hostname = `${draftLabel}.${draftParentRoot.hostname}`;
      kind = 'custom'; role = 'subdomain'; parentDomainId = draftParentRoot.id;
    } else {
      if (!draftLabel) { setCreateError('Enter the subdomain label.'); return; }
      if (!DNS_LABEL_RE.test(draftLabel)) { setCreateError('Subdomain label may use a–z, 0–9 and hyphens only (no leading/trailing hyphen).'); return; }
      hostname = `${draftLabel}.${PLATFORM_ROOT_SUFFIX}`;
      kind = 'subdomain'; role = 'subdomain'; parentDomainId = null;
    }

    if (domains.some(d => d.hostname === hostname)) {
      setCreateError('A domain record with that hostname already exists.');
      return;
    }

    // Platform subdomains are auto-provisioned (verified + active SSL); custom
    // roots and custom subdomains start pending and require manual verification.
    const isPlatform = draft.type === 'platform_subdomain';
    const next: TenantDomainRecord = {
      id: `dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: draft.tenantId,
      hostname,
      kind,
      domainRole: role,
      parentDomainId,
      status: isPlatform ? 'verified' : 'pending',
      ssl: isPlatform ? 'active' : 'none',
      createdAt: today,
      verifiedAt: isPlatform ? today : null,
      lastCheckedAt: today,
      notes: '',
    };
    setDomains(prev => [next, ...prev]);
    const typeLabel = draft.type === 'root' ? 'root domain' : isPlatform ? 'platform subdomain' : 'subdomain';
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'domain_created',
      target: `${tenantName(draft.tenantId)} · ${hostname}`,
      category: 'domains',
      tenantId: draft.tenantId,
      severity: 'info',
      newValue: hostname,
      note: `Type: ${typeLabel}${parentDomainId && draftParentRoot ? ` (parent ${draftParentRoot.hostname})` : ''}; initial status: ${next.status}`,
    });
    resetDraft();
    setCreateError(null);
    setShowCreate(false);
    setSelectedId(next.id);
  };

  const updateDomain = (id: string, patch: Partial<TenantDomainRecord>) => {
    setDomains(prev => prev.map(d => d.id === id ? { ...d, ...patch, lastCheckedAt: today } : d));
  };

  const setStatus = (d: TenantDomainRecord, next: DomainStatus) => {
    if (!canManage || d.status === next) return;
    const patch: Partial<TenantDomainRecord> = { status: next };
    if (next === 'verified' && !d.verifiedAt) patch.verifiedAt = today;
    updateDomain(d.id, patch);
    pushPlatformAudit({
      actor: 'System Owner',
      action: next === 'disabled' ? 'domain_disabled' : 'domain_status_changed',
      target: `${tenantName(d.tenantId)} · ${d.hostname}`,
      category: 'domains',
      tenantId: d.tenantId,
      oldValue: d.status,
      newValue: next,
      severity: next === 'failed' || next === 'disabled' ? 'warning' : 'notice',
    });
  };

  const setSsl = (d: TenantDomainRecord, next: DomainSslStatus) => {
    if (!canManage || d.ssl === next) return;
    updateDomain(d.id, { ssl: next });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'domain_ssl_changed',
      target: `${tenantName(d.tenantId)} · ${d.hostname}`,
      category: 'domains',
      tenantId: d.tenantId,
      oldValue: d.ssl,
      newValue: next,
      severity: next === 'failed' ? 'warning' : 'notice',
    });
  };

  const reenable = (d: TenantDomainRecord) => {
    if (!canManage) return;
    const restored: DomainStatus = d.kind === 'subdomain' ? 'verified' : 'pending';
    updateDomain(d.id, { status: restored });
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'domain_reenabled',
      target: `${tenantName(d.tenantId)} · ${d.hostname}`,
      category: 'domains',
      tenantId: d.tenantId,
      oldValue: 'disabled',
      newValue: restored,
      severity: 'notice',
    });
  };

  const copy = (text: string, key: string) => {
    try {
      navigator.clipboard?.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch { /* noop */ }
  };

  const patchFilter = (patch: Partial<DomainFilters>) => setFilters(f => ({ ...f, ...patch }));
  const clearAll = () => setFilters(EMPTY_FILTERS);

  const activeChips: { key: keyof DomainFilters; label: string }[] = [];
  if (filters.search.trim()) activeChips.push({ key: 'search', label: `Search: "${filters.search.trim()}"` });
  if (filters.rawStatus !== 'all') activeChips.push({ key: 'rawStatus', label: `Status: ${STATUS_LABELS[filters.rawStatus]}` });
  if (filters.lifecycle !== 'all') activeChips.push({ key: 'lifecycle', label: `Lifecycle: ${DOMAIN_LIFECYCLE_LABELS[filters.lifecycle]}` });
  if (filters.kind !== 'all') activeChips.push({ key: 'kind', label: `Kind: ${filters.kind}` });
  if (filters.ssl !== 'all') activeChips.push({ key: 'ssl', label: `SSL: ${DOMAIN_SSL_READINESS_LABELS[filters.ssl]}` });
  if (filters.risk !== 'all') activeChips.push({ key: 'risk', label: filters.risk === 'at_risk' ? 'At risk' : 'Needs action' });

  const clearChip = (key: keyof DomainFilters) => {
    if (key === 'search') patchFilter({ search: '' });
    else patchFilter({ [key]: 'all' } as Partial<DomainFilters>);
  };

  if (!viewGate.allowed) {
    return (
      <div className="space-y-8">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Domains</h2>
        </div>
        <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 p-12 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-slate-300">lock</span>
          <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">No access</p>
          <p className="mt-1 text-xs font-bold text-slate-400">{viewGate.reason || 'You do not have permission to view Domains.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Command header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-black text-primary tracking-tight">Domains</h2>
          <p className="text-slate-500 font-medium">Tenant subdomains &amp; custom domains — lifecycle, DNS, and SSL readiness.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <TruthLabel text={DOMAIN_TRUTH_LABELS.manual} tone="amber" />
            <TruthLabel text={DOMAIN_TRUTH_LABELS.ruleBased} tone="slate" />
            <TruthLabel text={DOMAIN_TRUTH_LABELS.futureProvider} tone="slate" />
          </div>
        </div>
        {canManage ? (
          <button onClick={() => { setCreateError(null); resetDraft(); setShowCreate(true); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all cursor-pointer active:scale-95">+ Add Domain</button>
        ) : (
          <span className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 border border-slate-200 rounded-xl">Read-only — Manage Domain Lifecycle required</span>
        )}
      </div>

      {/* Posture cards — each maps to one predicate, so the count equals the
          filtered list when that card is active (no drift). */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <PostureCard label="Total" value={signals.length} active={filters.lifecycle === 'all' && filters.risk === 'all' && filters.kind === 'all' && filters.ssl === 'all' && !filters.search.trim()} onClick={clearAll} />
        <PostureCard label="Needs Action" value={countWith({ risk: 'needs_action', lifecycle: 'all' })} tint="amber" active={filters.risk === 'needs_action'} onClick={() => patchFilter({ risk: 'needs_action', lifecycle: 'all' })} />
        <PostureCard label="At Risk" value={countWith({ risk: 'at_risk', lifecycle: 'all' })} tint="red" active={filters.risk === 'at_risk'} onClick={() => patchFilter({ risk: 'at_risk', lifecycle: 'all' })} />
        <PostureCard label="SSL Ready" value={countWith({ lifecycle: 'ssl_ready', risk: 'all' })} tint="lime" active={filters.lifecycle === 'ssl_ready'} onClick={() => patchFilter({ lifecycle: 'ssl_ready', risk: 'all' })} />
        <PostureCard label="Failed" value={countWith({ lifecycle: 'failed', risk: 'all' })} tint="red" active={filters.lifecycle === 'failed'} onClick={() => patchFilter({ lifecycle: 'failed', risk: 'all' })} />
        <PostureCard label="Disabled" value={countWith({ lifecycle: 'disabled', risk: 'all' })} active={filters.lifecycle === 'disabled'} onClick={() => patchFilter({ lifecycle: 'disabled', risk: 'all' })} />
      </div>

      {/* Deep-link stale-id notice (item F) */}
      {deepLinkNotice && (
        <div className="flex items-start gap-3 px-5 py-4 bg-amber-50 border border-amber-200 rounded-2xl">
          <span className="material-symbols-outlined text-amber-600 text-lg">link_off</span>
          <p className="flex-1 text-[12px] font-bold text-amber-800">{deepLinkNotice}</p>
          <button onClick={() => setDeepLinkNotice(null)} className="text-amber-500 hover:text-amber-700 transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-base">close</span>
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left — Domain Portfolio */}
        <div className="lg:col-span-7 bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
          {/* Toolbar: search + filters */}
          <div className="px-6 py-5 border-b border-slate-100 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">search</span>
                <input
                  value={filters.search}
                  onChange={e => patchFilter({ search: e.target.value })}
                  placeholder="Search hostname or tenant…"
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 placeholder:text-slate-400 placeholder:font-medium"
                />
              </div>
              <FilterSelect label="Kind" value={filters.kind} onChange={v => patchFilter({ kind: v as KindFilter })} options={[['all', 'All kinds'], ['subdomain', 'Subdomain'], ['custom', 'Custom']]} />
              <FilterSelect label="SSL" value={filters.ssl} onChange={v => patchFilter({ ssl: v as SslFilter })} options={[['all', 'All SSL'], ...(Object.keys(DOMAIN_SSL_READINESS_LABELS) as DomainSslReadiness[]).map(k => [k, DOMAIN_SSL_READINESS_LABELS[k]] as [string, string])]} />
              <FilterSelect label="Risk" value={filters.risk} onChange={v => patchFilter({ risk: v as RiskFilter })} options={[['all', 'All'], ['needs_action', 'Needs action'], ['at_risk', 'At risk']]} />
            </div>

            {/* Lifecycle tabs */}
            <div className="flex flex-wrap gap-2">
              <Tab label="All" count={countWith({ lifecycle: 'all' })} active={filters.lifecycle === 'all'} onClick={() => patchFilter({ lifecycle: 'all' })} />
              {LIFECYCLE_TABS.map(lc => (
                <Tab key={lc} label={DOMAIN_LIFECYCLE_LABELS[lc]} count={countWith({ lifecycle: lc })} active={filters.lifecycle === lc} onClick={() => patchFilter({ lifecycle: lc })} />
              ))}
            </div>

            {/* Active filter chips — no invisible filters */}
            {activeChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Active:</span>
                {activeChips.map(c => (
                  <button key={c.key} onClick={() => clearChip(c.key)} className="group inline-flex items-center gap-1.5 px-3 py-1 bg-primary/10 text-primary border border-primary/20 rounded-full text-[10px] font-black uppercase tracking-widest hover:bg-primary/20 transition-all cursor-pointer">
                    {c.label}
                    <span className="material-symbols-outlined text-[13px] group-hover:scale-110 transition-transform">close</span>
                  </button>
                ))}
                <button onClick={clearAll} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 underline cursor-pointer">Clear all</button>
              </div>
            )}
          </div>

          {/* Grouped portfolio — roots as parents, subdomains nested */}
          <div className="px-4 py-4">
            <div className="flex items-center justify-between px-2 pb-3">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Domain Portfolio</span>
              <span className="text-[10px] font-bold text-slate-400">{visible.length} matching</span>
            </div>
            {portfolioGroups.length === 0 ? (
              <div className="px-8 py-12 text-center text-slate-400 text-sm font-bold">
                {signals.length === 0 ? 'No domain records yet.' : 'No domain records match the active filters.'}
              </div>
            ) : (
              <div className="space-y-5 max-h-[calc(100vh-22rem)] overflow-y-auto pr-1">
                {portfolioGroups.map(group => (
                  <div key={group.key} className="space-y-2">
                    {group.title && (
                      <div className="flex items-center gap-2 px-1">
                        <span className="material-symbols-outlined text-sm text-slate-400">{group.icon}</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">{group.title}</span>
                        {group.note && <span className="text-[10px] font-medium text-slate-400">· {group.note}</span>}
                      </div>
                    )}
                    <div className="space-y-2">
                      {group.rows.map(r => (
                        <PortfolioRow
                          key={r.signal.id}
                          s={r.signal}
                          tenant={tenantName(r.signal.tenantId)}
                          selected={selectedId === r.signal.id}
                          nested={r.nested}
                          context={r.context}
                          onSelect={() => setSelectedId(r.signal.id)}
                        />
                      ))}
                      {/* Note renders in exactly one slot by construction: the
                          header above when the group is titled, here when it is
                          not (root groups have no title) — never both. */}
                      {!group.title && group.note && (
                        <p className="ml-5 px-2 text-[10px] font-medium text-slate-400">{group.note}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right — Domain Control Panel (desktop persistent pane) */}
        <div className="hidden lg:block lg:col-span-5 lg:sticky lg:top-6 self-start">
          {selected && selectedSignal ? (
            <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden max-h-[calc(100vh-6rem)] overflow-y-auto">
              <DomainControlPanel
                selected={selected}
                signal={selectedSignal}
                domains={domains}
                canManage={canManage}
                tenantName={tenantName}
                history={selectedHistory}
                copied={copied}
                onCopy={copy}
                onSelect={setSelectedId}
                onSetStatus={setStatus}
                onSetSsl={setSsl}
                onReenable={reenable}
                onConfirmDisable={setConfirmDisable}
                onClose={() => setSelectedId(null)}
              />
            </div>
          ) : (
            <div className="bg-white/60 backdrop-blur-xl rounded-[2.5rem] border border-dashed border-slate-300 p-12 text-center shadow-sm">
              <span className="material-symbols-outlined text-4xl text-slate-300">dns</span>
              <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">No domain selected</p>
              <p className="mt-2 text-xs font-bold text-slate-400 max-w-xs mx-auto">Select a domain to manage DNS readiness, SSL readiness, relationships, checklist, and history.</p>
            </div>
          )}
        </div>
      </div>

      {/* Add modal */}
      <AnimatePresence>
        {showCreate && canManage && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCreate(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-xl font-black text-primary tracking-tight">Add Domain</h3>
                <button onClick={() => setShowCreate(false)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-4 max-h-[70vh] overflow-y-auto">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tenant</label>
                  <select value={draft.tenantId} onChange={e => { setDraft(d => ({ ...d, tenantId: e.target.value, parentDomainId: '' })); setCreateError(null); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 cursor-pointer">
                    <option value="">Select tenant…</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>

                {/* Create type — root vs subdomain vs platform subdomain */}
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block">Domain Type</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ['root', 'Root', 'Custom apex (example.com)'],
                      ['subdomain', 'Subdomain', 'Under a managed root'],
                      ['platform_subdomain', 'Platform', `*.${PLATFORM_ROOT_SUFFIX}`],
                    ] as [DomainCreateType, string, string][]).map(([val, title, hint]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => { setDraft(d => ({ ...d, type: val, label: '', hostname: '', parentDomainId: '' })); setCreateError(null); }}
                        className={`text-left p-3 rounded-2xl border transition-all cursor-pointer active:scale-[0.98] ${draft.type === val ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'border-slate-200 hover:border-slate-300 bg-white'}`}
                      >
                        <p className={`text-[11px] font-black uppercase tracking-widest ${draft.type === val ? 'text-primary' : 'text-slate-600'}`}>{title}</p>
                        <p className="text-[9px] font-bold text-slate-400 mt-0.5 leading-tight">{hint}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Root: full apex hostname */}
                {draft.type === 'root' && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Root Domain</label>
                    <input value={draft.hostname} onChange={e => { setDraft(d => ({ ...d, hostname: e.target.value })); setCreateError(null); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" placeholder="example.com" />
                    <p className="text-[10px] text-slate-400 font-bold mt-1">Apex/root domain the tenant owns. Subdomains can later be attached under it.</p>
                  </div>
                )}

                {/* Subdomain: parent root dropdown + label */}
                {draft.type === 'subdomain' && (
                  <>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Parent Root Domain</label>
                      {!draft.tenantId ? (
                        <div className="px-4 py-3 bg-slate-50 border border-dashed border-slate-200 rounded-2xl text-[11px] font-bold text-slate-400">Select a tenant first.</div>
                      ) : rootDomainsForTenant.length === 0 ? (
                        <div className="px-4 py-3 bg-amber-50 border border-dashed border-amber-200 rounded-2xl text-[11px] font-bold text-amber-700">No managed root domain for this tenant yet. Add a <span className="underline cursor-pointer" onClick={() => { setDraft(d => ({ ...d, type: 'root', label: '', hostname: '', parentDomainId: '' })); setCreateError(null); }}>Root domain</span> first, or use a Platform subdomain.</div>
                      ) : (
                        <select value={draft.parentDomainId} onChange={e => { setDraft(d => ({ ...d, parentDomainId: e.target.value })); setCreateError(null); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 cursor-pointer">
                          <option value="">Select parent root…</option>
                          {rootDomainsForTenant.map(r => <option key={r.id} value={r.id}>{r.hostname}</option>)}
                        </select>
                      )}
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Subdomain Label</label>
                      <input value={draft.label} onChange={e => { setDraft(d => ({ ...d, label: e.target.value })); setCreateError(null); }} disabled={!draftParentRoot} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 disabled:opacity-50" placeholder="shop" />
                    </div>
                  </>
                )}

                {/* Platform subdomain: label only */}
                {draft.type === 'platform_subdomain' && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Subdomain Label</label>
                    <input value={draft.label} onChange={e => { setDraft(d => ({ ...d, label: e.target.value })); setCreateError(null); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" placeholder="tenant" />
                    <p className="text-[10px] text-slate-400 font-bold mt-1">Auto-provisioned under the shared platform root — starts Verified with active SSL.</p>
                  </div>
                )}

                {/* Live hostname preview */}
                <div className="px-4 py-3 bg-slate-900/90 rounded-2xl">
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Full Hostname Preview</p>
                  <p className="text-sm font-black text-lime-300 mt-1 break-all font-mono">{computedHostname || <span className="text-slate-500 font-bold">…</span>}</p>
                </div>

                {createError && <p className="text-[11px] font-bold text-red-600">{createError}</p>}
                <p className="text-[10px] text-slate-500 font-bold">
                  {draft.type === 'platform_subdomain'
                    ? <>Platform subdomains are provisioned immediately. {DOMAIN_TRUTH_LABELS.manual}</>
                    : <>Custom roots and subdomains start as <span className="text-amber-700">Pending DNS</span> and require manual verification using the DNS instructions in the detail view. {DOMAIN_TRUTH_LABELS.manual}</>}
                </p>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white transition-all cursor-pointer">Cancel</button>
                <button onClick={handleCreate} disabled={!draft.tenantId || !computedHostname} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer">Add Domain</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Disable confirmation */}
      <AnimatePresence>
        {confirmDisable && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirmDisable(null)} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl overflow-hidden">
              <div className="p-7 space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-red-600">block</span>
                </div>
                <h3 className="text-lg font-black text-primary tracking-tight">Disable domain?</h3>
                <p className="text-sm font-bold text-slate-600">This marks <span className="text-slate-900">{confirmDisable.hostname}</span> as disabled and records an audit entry. Customer-facing routing for this domain should be considered off until re-enabled. No real DNS/SSL changes are made.</p>
              </div>
              <div className="p-7 pt-0 flex justify-end gap-2">
                <button onClick={() => setConfirmDisable(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all">Cancel</button>
                <button onClick={() => { setStatus(confirmDisable, 'disabled'); setConfirmDisable(null); }} className="px-6 py-2.5 bg-red-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-red-600/20 hover:bg-red-700 transition-all">Disable Domain</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Detail control panel — mobile slide-over (desktop uses the right pane) */}
      <AnimatePresence>
        {selected && selectedSignal && (
          <div className="fixed inset-0 z-50 flex justify-end lg:hidden">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedId(null)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-md h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <DomainControlPanel
                selected={selected}
                signal={selectedSignal}
                domains={domains}
                canManage={canManage}
                tenantName={tenantName}
                history={selectedHistory}
                copied={copied}
                onCopy={copy}
                onSelect={setSelectedId}
                onSetStatus={setStatus}
                onSetSsl={setSsl}
                onReenable={reenable}
                onConfirmDisable={setConfirmDisable}
                onClose={() => setSelectedId(null)}
              />
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Left-pane portfolio row — compact summary of one domain (hostname, role,
// lifecycle, SSL, risk, next action). `context` renders a muted parent root that
// is only shown to keep a matching child's relationship understandable.
const PortfolioRow: React.FC<{
  s: DomainReadinessSignal;
  tenant: string;
  selected: boolean;
  nested: boolean;
  context: boolean;
  onSelect: () => void;
}> = ({ s, tenant, selected, nested, context, onSelect }) => (
  <button
    onClick={onSelect}
    className={`w-full text-left rounded-2xl border px-4 py-3 transition-all cursor-pointer active:scale-[0.99] ${nested ? 'ml-5' : ''} ${
      selected
        ? 'border-primary ring-2 ring-primary/20 bg-primary/5'
        : context
        ? 'border-dashed border-slate-200 bg-slate-50/50 opacity-70 hover:opacity-100'
        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70'
    }`}
  >
    <div className="flex items-center gap-2">
      {nested && <span className="material-symbols-outlined text-sm text-slate-300">subdirectory_arrow_right</span>}
      <span className="text-sm font-bold text-slate-900 break-all flex-1">{s.hostname}</span>
      {context && <span className="px-1.5 py-0.5 rounded-md text-[8px] font-black uppercase tracking-widest bg-slate-200 text-slate-500">Context</span>}
      {s.issueCount > 0 && <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500/15 text-red-700 text-[9px] font-black">{s.issueCount}</span>}
    </div>
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${s.role === 'root' ? 'bg-indigo-500/10 text-indigo-700 border-indigo-500/20' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>{DOMAIN_ROLE_LABELS[s.role]}</span>
      <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${LIFECYCLE_STYLES[s.lifecycle]}`}>{s.lifecycleLabel}</span>
      <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${SSL_READINESS_STYLES[s.sslReadiness]}`}>SSL: {s.sslReadinessLabel}</span>
      {s.needsAction && <span className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border bg-amber-400/10 text-amber-700 border-amber-400/20">Needs action</span>}
      <span className="text-[10px] font-bold text-slate-400">· {tenant}</span>
    </div>
    <p className="mt-1 text-[10px] font-bold text-slate-400 truncate">{s.nextAction}</p>
  </button>
);

// Right-pane (and mobile slide-over) control panel for the selected domain.
// Renders the full operator surface: next action, root/subdomain relationships,
// readiness signals, security, checklist, registrar note, manual status/SSL
// workflow, required DNS records, quick actions, history, and metadata.
interface DomainControlPanelProps {
  selected: TenantDomainRecord;
  signal: DomainReadinessSignal;
  domains: TenantDomainRecord[];
  canManage: boolean;
  tenantName: (id: string) => string;
  history: { id: string; date: string; actor: string; action: string }[];
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  onSelect: (id: string) => void;
  onSetStatus: (d: TenantDomainRecord, next: DomainStatus) => void;
  onSetSsl: (d: TenantDomainRecord, next: DomainSslStatus) => void;
  onReenable: (d: TenantDomainRecord) => void;
  onConfirmDisable: (d: TenantDomainRecord) => void;
  onClose?: () => void;
}

const DomainControlPanel: React.FC<DomainControlPanelProps> = ({
  selected, signal, domains, canManage, tenantName, history, copied,
  onCopy, onSelect, onSetStatus, onSetSsl, onReenable, onConfirmDisable, onClose,
}) => (
  <>
    <div className="p-7 border-b border-slate-100 flex justify-between items-start">
      <div className="flex-1 pr-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Domain</p>
        <h3 className="text-lg font-black text-primary mt-1 break-all">{selected.hostname}</h3>
        <p className="text-xs text-slate-500 font-bold mt-1">{tenantName(selected.tenantId)} · {selected.kind}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${signal.role === 'root' ? 'bg-indigo-500/10 text-indigo-700 border-indigo-500/20' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>{DOMAIN_ROLE_LABELS[signal.role]}</span>
          <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${LIFECYCLE_STYLES[signal.lifecycle]}`}>{signal.lifecycleLabel}</span>
          <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SSL_READINESS_STYLES[signal.sslReadiness]}`}>SSL: {signal.sslReadinessLabel}</span>
        </div>
      </div>
      {onClose && (
        <button onClick={onClose} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 shrink-0 cursor-pointer">
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      )}
    </div>

    <div className="p-7 space-y-6">
      {/* Next action */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Next recommended action</p>
        <p className="text-sm font-black text-slate-800">{signal.nextAction}</p>
      </div>

      {/* Root Domain Management / Subdomain Management — root shows its managed
          children; subdomain shows its parent + the inherited relationship. */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">{signal.role === 'root' ? 'Root Domain Management' : 'Subdomain Management'}</p>
        {signal.role === 'subdomain' && (
          <div className="mb-2 px-3 py-2.5 rounded-xl bg-indigo-500/5 border border-indigo-500/15">
            <p className="text-[11px] font-bold text-indigo-700">Subdomain hostname is generated from an editable label plus a locked root domain.</p>
            <p className="text-[10px] font-medium text-slate-500 mt-1">It inherits routing and SSL handling from its root — the root domain cannot be edited here.</p>
          </div>
        )}
        {signal.role === 'root' ? (
          (() => {
            const children = domains.filter(c => c.parentDomainId === selected.id);
            if (children.length === 0) {
              return <p className="text-[11px] font-bold text-slate-400 px-3 py-2 bg-slate-50 border border-dashed border-slate-200 rounded-xl">No subdomains attached to this root domain yet.</p>;
            }
            return (
              <div className="space-y-1.5">
                <p className="text-[10px] font-bold text-slate-500">{children.length} managed subdomain{children.length === 1 ? '' : 's'}:</p>
                {children.map(c => (
                  <button key={c.id} onClick={() => onSelect(c.id)} className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:border-primary/40 hover:bg-primary/5 transition-all cursor-pointer">
                    <span className="material-symbols-outlined text-sm text-slate-400">subdirectory_arrow_right</span>
                    <span className="text-[11px] font-bold text-slate-700 break-all flex-1">{c.hostname}</span>
                    <span className="material-symbols-outlined text-sm text-slate-300">chevron_right</span>
                  </button>
                ))}
              </div>
            );
          })()
        ) : (() => {
          const managedParent = selected.parentDomainId ? domains.find(p => p.id === selected.parentDomainId) || null : null;
          if (managedParent) {
            return (
              <button onClick={() => onSelect(managedParent.id)} className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:border-primary/40 hover:bg-primary/5 transition-all cursor-pointer">
                <span className="material-symbols-outlined text-sm text-indigo-500">arrow_upward</span>
                <span className="text-[11px] font-bold text-slate-700 break-all flex-1">Parent root: {managedParent.hostname}</span>
                <span className="material-symbols-outlined text-sm text-slate-300">chevron_right</span>
              </button>
            );
          }
          const platformRoot = deriveParentRootHostname(selected);
          if (platformRoot) {
            return (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50">
                <span className="material-symbols-outlined text-sm text-slate-400">arrow_upward</span>
                <span className="text-[11px] font-bold text-slate-600 break-all flex-1">Platform root: {platformRoot}</span>
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Shared</span>
              </div>
            );
          }
          return <p className="text-[11px] font-bold text-slate-400 px-3 py-2 bg-slate-50 border border-dashed border-slate-200 rounded-xl">No managed parent root on record for this subdomain.</p>;
        })()}
      </div>

      {/* Risk reasons */}
      {signal.riskReasons.length > 0 && (
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Readiness signals</p>
          <div className="space-y-1.5">
            {signal.riskReasons.map(r => (
              <div key={r.code} className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[11px] font-bold ${r.tone === 'critical' ? 'bg-red-500/10 text-red-700 border-red-500/20' : r.tone === 'warn' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                <span className="material-symbols-outlined text-sm">{r.tone === 'critical' ? 'error' : r.tone === 'warn' ? 'warning' : 'info'}</span>
                {r.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Security & readiness — DNS readiness + SSL (live), plus future
          registrar-level indicators shown as placeholders only. */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Security &amp; readiness</p>
        <div className="space-y-1.5">
          <ReadinessRow label="DNS configuration" state={DNS_READINESS_TONE[signal.dnsReadiness]} valueLabel={signal.dnsReadinessLabel} />
          {signal.securityIndicators.map(ind => (
            <ReadinessRow
              key={ind.key}
              label={ind.label}
              state={SECURITY_STATE_TONE[ind.state]}
              valueLabel={SECURITY_READINESS_LABELS[ind.state]}
              detail={ind.detail}
              future={ind.future}
            />
          ))}
        </div>
        <p className="text-[10px] text-slate-400 font-medium mt-2">{DOMAIN_TRUTH_LABELS.futureSecurity}</p>
      </div>

      {/* Manual action checklist — read-only guidance, no automation */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Action checklist</p>
        <div className="space-y-1.5">
          {signal.checklist.map(item => (
            <div key={item.key} className="flex items-start gap-2.5 px-3 py-2 rounded-xl border border-slate-100 bg-slate-50/60">
              <span className={`material-symbols-outlined text-base mt-px ${CHECKLIST_TONE[item.state].icon}`}>{CHECKLIST_TONE[item.state].symbol}</span>
              <div className="flex-1">
                <p className={`text-[11px] font-bold ${item.state === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{item.label}</p>
                {item.hint && <p className="text-[10px] font-medium text-slate-400 mt-0.5">{item.hint}</p>}
              </div>
              {item.state === 'current' && <span className="text-[9px] font-black uppercase tracking-widest text-primary shrink-0 mt-0.5">Now</span>}
            </div>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 font-medium mt-2">{DOMAIN_TRUTH_LABELS.manual}</p>
      </div>

      {/* Registrar vs. app configuration explanation */}
      <div className="px-3 py-2.5 rounded-xl bg-amber-400/5 border border-amber-400/20">
        <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1 flex items-center gap-1"><span className="material-symbols-outlined text-[13px]">dns</span> Registrar &amp; DNS provider</p>
        <p className="text-[11px] font-bold text-slate-600">{DOMAIN_TRUTH_LABELS.registrarExternal}</p>
      </div>

      {/* Manual status workflow */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Status</label>
          {selected.status === 'disabled' ? (
            // Disabling and re-enabling are confirmed/explicit actions, never a
            // silent select change — so a disabled record shows a static badge
            // and is restored only via the Re-enable quick action.
            <div className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-xs font-black uppercase tracking-widest text-slate-500">Disabled</div>
          ) : (
            <select disabled={!canManage} value={selected.status} onChange={e => onSetStatus(selected, e.target.value as DomainStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 disabled:opacity-50">
              {(['pending', 'verifying', 'verified', 'failed'] as DomainStatus[]).map(s => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">SSL</label>
          <select disabled={!canManage} value={selected.ssl} onChange={e => onSetSsl(selected, e.target.value as DomainSslStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 disabled:opacity-50">
            {(['none', 'pending', 'active', 'failed'] as DomainSslStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* Required DNS records */}
      {signal.requiredRecords.length > 0 && (
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Required DNS records</p>
          <p className="text-[11px] text-amber-700 font-bold mb-3">Configure these at the customer's DNS provider, then mark this record verified once you've manually confirmed propagation. <span className="font-medium text-slate-500">{DOMAIN_TRUTH_LABELS.manual}</span></p>
          <div className="space-y-2">
            {signal.requiredRecords.map((rec, i) => (
              <DnsBlock key={i} type={rec.type} host={rec.host} value={rec.value} purpose={rec.purpose} onCopy={() => onCopy(formatDnsRecord(rec), `rec${i}`)} copied={copied === `rec${i}`} />
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      {canManage && (
        <div className="space-y-2 pt-2 border-t border-slate-100">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Quick actions</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => onSetStatus(selected, 'verified')} disabled={selected.status === 'verified'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-lime-400/10 text-lime-700 border border-lime-400/20 rounded-xl disabled:opacity-40 hover:bg-lime-400/20 transition-all cursor-pointer">Mark Verified</button>
            <button onClick={() => onSetStatus(selected, 'verifying')} disabled={selected.status === 'verifying'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-blue-400/10 text-blue-700 border border-blue-400/20 rounded-xl disabled:opacity-40 hover:bg-blue-400/20 transition-all cursor-pointer">Mark Pending</button>
            <button onClick={() => onSetStatus(selected, 'failed')} disabled={selected.status === 'failed'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-red-500/10 text-red-700 border border-red-500/30 rounded-xl disabled:opacity-40 hover:bg-red-500/20 transition-all cursor-pointer">Mark Failed</button>
            {selected.status !== 'disabled' ? (
              <button onClick={() => onConfirmDisable(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-200 transition-all cursor-pointer">Disable</button>
            ) : (
              <button onClick={() => onReenable(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-blue-400/10 text-blue-700 border border-blue-400/20 rounded-xl hover:bg-blue-400/20 transition-all cursor-pointer">Re-enable</button>
            )}
          </div>
        </div>
      )}

      {/* History */}
      <div className="pt-2 border-t border-slate-100">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">History</p>
        {history.length === 0 ? (
          <p className="text-[11px] font-bold text-slate-400">No recorded history for this domain.</p>
        ) : (
          <div className="space-y-2">
            {history.map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px]">
                <span className="font-mono text-slate-400 whitespace-nowrap">{e.date}</span>
                <div>
                  <span className="font-black text-slate-700">{e.action}</span>
                  <span className="text-slate-400"> · {e.actor}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-[10px] text-slate-400 grid grid-cols-2 gap-2 pt-4 border-t border-slate-100">
        <div>Created: <span className="font-bold text-slate-600">{selected.createdAt}</span></div>
        <div>Verified: <span className="font-bold text-slate-600">{selected.verifiedAt || '—'}</span></div>
        <div className="col-span-2">Last checked: <span className="font-bold text-slate-600">{selected.lastCheckedAt || '—'}</span></div>
        <div className="col-span-2 font-mono">id: {selected.id}</div>
        <div className="col-span-2 text-slate-400 font-medium">{signal.truthLabel}</div>
      </div>
    </div>
  </>
);

const TruthLabel: React.FC<{ text: string; tone: 'amber' | 'slate' }> = ({ text, tone }) => (
  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${tone === 'amber' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
    <span className="material-symbols-outlined text-[12px]">info</span>
    {text}
  </span>
);

const PostureCard: React.FC<{ label: string; value: number; tint?: 'lime' | 'amber' | 'red'; active?: boolean; onClick?: () => void }> = ({ label, value, tint, active, onClick }) => {
  const tintCls = tint === 'lime' ? 'text-lime-700' : tint === 'amber' ? 'text-amber-700' : tint === 'red' ? 'text-red-700' : 'text-primary';
  return (
    <button onClick={onClick} className={`text-left bg-white/80 backdrop-blur-xl p-5 rounded-3xl border shadow-sm transition-all cursor-pointer hover:shadow-md hover:-translate-y-0.5 active:scale-[0.98] ${active ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200 hover:border-slate-300'}`}>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-2xl font-black mt-1 ${tintCls}`}>{value}</p>
    </button>
  );
};

const Tab: React.FC<{ label: string; count: number; active: boolean; onClick: () => void }> = ({ label, count, active, onClick }) => (
  <button onClick={onClick} className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all cursor-pointer inline-flex items-center gap-1.5 active:scale-95 ${active ? 'bg-primary text-white shadow-sm shadow-primary/20' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-700'}`}>
    {label}
    <span className={`px-1.5 py-0.5 rounded-md text-[9px] ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{count}</span>
  </button>
);

const FilterSelect: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: [string, string][] }> = ({ label, value, onChange, options }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </div>
);

const ReadinessRow: React.FC<{ label: string; state: ReadinessTone; valueLabel: string; detail?: string; future?: boolean }> = ({ label, state, valueLabel, detail, future }) => (
  <div className="flex items-start justify-between gap-3 px-3 py-2 rounded-xl border border-slate-100 bg-slate-50/60">
    <div className="flex-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-slate-700">{label}</span>
        {future && <span className="px-1.5 py-0.5 rounded-md text-[8px] font-black uppercase tracking-widest bg-violet-400/10 text-violet-700 border border-violet-400/20">Future</span>}
      </div>
      {detail && <p className="text-[10px] font-medium text-slate-400 mt-0.5">{detail}</p>}
    </div>
    <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[state]}`}>{valueLabel}</span>
  </div>
);

const DnsBlock: React.FC<{ type: string; host: string; value: string; purpose: string; onCopy: () => void; copied: boolean }> = ({ type, host, value, purpose, onCopy, copied }) => (
  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 font-mono text-[11px] text-slate-700">
    <div className="flex justify-between items-center mb-2">
      <span className="font-black uppercase tracking-widest text-[10px] text-slate-500">{type}</span>
      <button onClick={onCopy} className="text-[10px] font-black uppercase tracking-widest text-primary hover:opacity-80 transition-opacity">{copied ? 'Copied!' : 'Copy'}</button>
    </div>
    <div>Host: <span className="break-all">{host}</span></div>
    <div>Value: <span className="break-all">{value}</span></div>
    <div className="mt-1.5 font-sans text-[10px] text-slate-400 font-medium">{purpose}</div>
  </div>
);

export default DomainsPage;
