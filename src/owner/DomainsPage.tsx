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
  deriveDomainRole,
  PLATFORM_ROOT_SUFFIX,
} from './platformOpsDomains';
import {
  deriveTenantWebAddresses,
  WEB_ADDRESS_TRUTH_LABELS,
  WEB_ADDRESS_STATUS_LABELS,
  WEB_ADDRESS_KIND_LABELS,
  WEB_ADDRESS_LIVE_HOSTING,
  type TenantWebAddress,
  type WebAddressStatus,
  type WebAddressKind,
  type WebAddressChecklistState,
} from './tenantWebAddress';

// ---------------------------------------------------------------------------
// Phase 1.2F Strategic Replacement — "Domains" is repositioned as the
// "Tenant Web Address" module. The dashboard, table, saved views, filters and
// the selected overview all run off ONE derived source
// (`deriveTenantWebAddresses`, from the accepted `tenant_domains_v1` model) and
// ONE predicate (`matchesWebAddressFilter`), so a number can never drift from
// the rows it represents (locked no-drift rule, carried over from M1/M2).
//
// The advanced DNS / SSL / registrar / security helpers (M0/M2) remain in place
// but are now surfaced read-only under "Advanced Custom Domain Support —
// Future / Support-Assisted", de-emphasised per the strategic pivot.
// ---------------------------------------------------------------------------

const DOMAINS_KEY = 'tenant_domains_v1';

const STATUS_TONE: Record<WebAddressStatus, string> = {
  active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
  reserved: 'bg-blue-400/10 text-blue-700 border-blue-400/20',
  needs_setup: 'bg-amber-400/10 text-amber-700 border-amber-400/20',
  disabled: 'bg-slate-200 text-slate-600 border-slate-300',
  external_only: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
};

const KIND_TONE: Record<WebAddressKind, string> = {
  platform: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  external: 'bg-slate-100 text-slate-600 border-slate-200',
};

const CHECKLIST_TONE: Record<WebAddressChecklistState, { symbol: string; icon: string }> = {
  done: { symbol: 'check_circle', icon: 'text-lime-600' },
  todo: { symbol: 'radio_button_unchecked', icon: 'text-slate-300' },
  not_applicable: { symbol: 'remove_circle_outline', icon: 'text-slate-300' },
};

// Raw status labels — used only by the advanced "Raw status" deep-link filter chip.
const RAW_STATUS_LABELS: Record<DomainStatus, string> = {
  pending: 'Pending',
  verifying: 'Verifying',
  verified: 'Verified',
  failed: 'Failed',
  disabled: 'Disabled',
};

// The Manage controls expose only the Tenant Web Address operator statuses
// (Active / Needs Setup / Disabled). Raw lifecycle values are unchanged for safe
// compatibility but map down to this set: anything not Active/Disabled reads as
// "Needs Setup". `disabled` is handled by a separate read-only branch.
const MANAGE_STATUS_OPTIONS: { value: DomainStatus; label: string }[] = [
  { value: 'verified', label: 'Active' },
  { value: 'pending', label: 'Needs Setup' },
];
const manageSelectValue = (s: DomainStatus): DomainStatus => (s === 'verified' ? 'verified' : 'pending');

// Recent Activity display-label mapping (display only — audit storage and event
// IDs are untouched). Covers both raw audit action keys and the legacy seeded
// domain-history labels, mapped to Tenant Web Address vocabulary.
const ACTIVITY_LABELS: Record<string, string> = {
  domain_created: 'Web Address Created',
  domain_status_changed: 'Web Address Status Changed',
  domain_disabled: 'Web Address Disabled',
  domain_reenabled: 'Web Address Re-enabled',
  domain_ssl_changed: 'Security State Updated',
  'Subdomain Created': 'Platform Web Address Created',
  'Domain Created': 'Web Address Created',
  'Custom Domain Added': 'External Website Recorded',
  'External domain recorded': 'External Website Recorded',
  'DNS Verified': 'External Website Reviewed',
  'SSL Provisioned': 'Security State Updated',
  'SSL Renewed': 'Security State Updated',
};
const activityLabel = (action: string): string => ACTIVITY_LABELS[action] ?? action;

// Validation patterns for the Add flow (carried over from Phase 1.2).
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ROOT_DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

// The three ways an operator can add a web-address record (relabeled, same
// underlying persistence as the accepted flow).
type CreateType = 'platform_subdomain' | 'root' | 'subdomain';

const CREATE_TYPE_LABELS: Record<CreateType, string> = {
  platform_subdomain: 'Platform Web Address',
  root: 'External Website / Redirect Record',
  subdomain: 'Subdomain under an external website',
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

// ---------------------------------------------------------------------------
// Saved views + filters (web-address-centric).
// ---------------------------------------------------------------------------

type WebAddressView =
  | 'all'
  | 'active_platform'
  | 'needs_setup'
  | 'disabled'
  | 'external_redirects'
  | 'custom_future';

const VIEW_LABELS: Record<WebAddressView, string> = {
  all: 'All Web Addresses',
  active_platform: 'Active Platform URLs',
  needs_setup: 'Needs Setup',
  disabled: 'Disabled',
  external_redirects: 'External Redirects',
  custom_future: 'Custom Domain Future',
};

const VIEW_ORDER: WebAddressView[] = [
  'all', 'active_platform', 'needs_setup', 'disabled', 'external_redirects', 'custom_future',
];

const matchesView = (w: TenantWebAddress, view: WebAddressView): boolean => {
  switch (view) {
    case 'all': return true;
    case 'active_platform': return w.kind === 'platform' && w.status === 'active';
    case 'needs_setup': return w.status === 'needs_setup';
    case 'disabled': return w.status === 'disabled';
    case 'external_redirects': return w.hasExternalRedirect;
    case 'custom_future': return w.kind === 'external';
    default: return true;
  }
};

interface WebAddressFilters {
  search: string;
  tenantId: string;                 // 'all' or a tenant id
  status: 'all' | WebAddressStatus;
  externalRedirect: 'all' | 'yes' | 'no';
  // Raw persisted status — set only via Command Center deep-links (?status=...).
  // No dropdown of its own, but ALWAYS renders a visible, clearable chip.
  rawStatus: 'all' | DomainStatus;
  view: WebAddressView;
}

const EMPTY_FILTERS: WebAddressFilters = {
  search: '', tenantId: 'all', status: 'all', externalRedirect: 'all', rawStatus: 'all', view: 'all',
};

// THE single predicate — drives the table, every card count, every saved-view
// count and every chip. Counts and rows can never diverge.
const matchesWebAddressFilter = (w: TenantWebAddress, f: WebAddressFilters): boolean => {
  if (!matchesView(w, f.view)) return false;
  if (f.tenantId !== 'all' && w.tenantId !== f.tenantId) return false;
  if (f.status !== 'all' && w.status !== f.status) return false;
  if (f.externalRedirect === 'yes' && !w.hasExternalRedirect) return false;
  if (f.externalRedirect === 'no' && w.hasExternalRedirect) return false;
  if (f.rawStatus !== 'all' && w.rawStatus !== f.rawStatus) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${w.tenant} ${w.platformWebAddress ?? ''} ${w.externalWebsite ?? ''} ${w.nextAction}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
};

const DomainsPage: React.FC = () => {
  const { session } = useAccess();
  const sessionRole = (session?.role as Role | undefined) || null;
  const viewGate = hasPlatformPermission(sessionRole, 'view_domains');
  const manageGate = hasPlatformPermission(sessionRole, 'manage_domain_lifecycle');
  const canManage = manageGate.allowed;

  const [domains, setDomains] = useState<TenantDomainRecord[]>(() => loadDomains());
  const [showCreate, setShowCreate] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<WebAddressFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<{ tenantId: string; type: CreateType; label: string; hostname: string; parentDomainId: string }>(
    { tenantId: '', type: 'platform_subdomain', label: '', hostname: '', parentDomainId: '' }
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

  // Command Center deep-linking. `?domain=<id>` opens the matching record
  // overview (or shows a dismissible stale notice); `?status=<rawStatus>`
  // applies a visible, clearable raw-status filter. Params are stripped after
  // applying so refresh / back never re-triggers them. (Preserved from M1.)
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
        setDeepLinkNotice(`Web address "${domainParam}" was not found — it may have been deleted or belongs to a different record set.`);
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

  const tenantNameRecord = useMemo(() => {
    const r: Record<string, string> = {};
    tenants.forEach(t => { r[t.id] = t.name; });
    return r;
  }, []);

  const tenantSlugRecord = useMemo(() => {
    const r: Record<string, string> = {};
    tenants.forEach(t => { if (t.subdomain) r[t.id] = t.subdomain; });
    return r;
  }, []);

  // The single derived source for the whole module (no-drift). Built from the
  // SAME `domains` store the deep-link, create and mutation handlers read.
  const webAddresses = useMemo(
    () => deriveTenantWebAddresses(domains, { domains, tenantNameById: tenantNameRecord, tenantSlugById: tenantSlugRecord }),
    [domains, tenantNameRecord, tenantSlugRecord],
  );

  const visible = useMemo(
    () => webAddresses.filter(w => matchesWebAddressFilter(w, filters)),
    [webAddresses, filters],
  );

  // Presentation-only grouping (no-drift safe): the cards and saved-view counts
  // keep deriving from the flat `webAddresses` array; only the table collapses
  // each tenant's platform web address + sibling external/redirect records into
  // ONE visual row. A tenant with two distinct platform web addresses still
  // gets two rows; an external-only tenant still appears as its own row.
  const tableRows = useMemo(() => {
    const rows: { primary: TenantWebAddress; externals: TenantWebAddress[] }[] = [];
    const platformRowIndexByTenant: Record<string, number> = {};
    const tenantsWithPlatform = new Set(visible.filter(w => w.kind === 'platform').map(w => w.tenantId));
    // Pass 1 — one row per platform web address, in visible order.
    for (const w of visible) {
      if (w.kind !== 'platform') continue;
      rows.push({ primary: w, externals: [] });
      if (platformRowIndexByTenant[w.tenantId] === undefined) {
        platformRowIndexByTenant[w.tenantId] = rows.length - 1;
      }
    }
    // Pass 2 — attach externals to the tenant's first platform row, or group
    // external-only tenants into their own single row.
    const externalOnlyRowIndexByTenant: Record<string, number> = {};
    for (const w of visible) {
      if (w.kind !== 'external') continue;
      if (tenantsWithPlatform.has(w.tenantId)) {
        rows[platformRowIndexByTenant[w.tenantId]].externals.push(w);
      } else if (externalOnlyRowIndexByTenant[w.tenantId] !== undefined) {
        rows[externalOnlyRowIndexByTenant[w.tenantId]].externals.push(w);
      } else {
        rows.push({ primary: w, externals: [] });
        externalOnlyRowIndexByTenant[w.tenantId] = rows.length - 1;
      }
    }
    return rows;
  }, [visible]);

  // Locked no-drift contract: every clickable card count and saved-view count
  // flows through the SAME predicate as the visible table.
  const countWith = (partial: Partial<WebAddressFilters>) =>
    webAddresses.filter(w => matchesWebAddressFilter(w, { ...EMPTY_FILTERS, ...partial })).length;
  const countView = (view: WebAddressView) => countWith({ view });

  const totalCount = countWith({});
  const activePlatformCount = countView('active_platform');
  const needsSetupCount = countView('needs_setup');
  const disabledCount = countView('disabled');
  const externalRedirectCount = countView('external_redirects');
  const customFutureCount = countView('custom_future');

  const today = new Date().toISOString().slice(0, 10);

  const selected = useMemo(() => domains.find(d => d.id === selectedId) || null, [domains, selectedId]);
  const selectedWa = useMemo(
    () => (selectedId ? webAddresses.find(w => w.domainId === selectedId) || null : null),
    [webAddresses, selectedId],
  );

  // The selected tenant's other external/redirect records. Because the table now
  // groups a tenant's platform web address + external records into one row (and no
  // longer has an External Website column), the overview is the single place those
  // sibling externals stay reachable/manageable from the list workflow.
  const selectedSiblingExternals = useMemo(
    () =>
      selectedWa
        ? webAddresses.filter(w => w.tenantId === selectedWa.tenantId && w.kind === 'external' && w.domainId !== selectedWa.domainId)
        : [],
    [webAddresses, selectedWa],
  );

  const selectedHistory = useMemo(() => {
    if (!selected) return [] as { id: string; date: string; actor: string; action: string }[];
    const host = selected.hostname;
    void auditTick;
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
    const seen = new Set<string>();
    return [...fromAudit, ...fromHistory]
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [selected, auditTick]);

  // Add-flow helpers (unchanged persistence).
  const rootDomainsForTenant = useMemo(
    () => domains.filter(d => deriveDomainRole(d) === 'root' && d.status !== 'disabled' && d.tenantId === draft.tenantId),
    [domains, draft.tenantId]
  );
  const draftParentRoot = rootDomainsForTenant.find(d => d.id === draft.parentDomainId) || null;
  const draftLabel = draft.label.trim().toLowerCase();
  const computedHostname = (() => {
    if (draft.type === 'root') return draft.hostname.trim().toLowerCase();
    if (draft.type === 'platform_subdomain') return draftLabel ? `${draftLabel}.${PLATFORM_ROOT_SUFFIX}` : '';
    return draftLabel && draftParentRoot ? `${draftLabel}.${draftParentRoot.hostname}` : '';
  })();
  const draftSlugDefault = tenantSlugRecord[draft.tenantId] || '';

  const resetDraft = () => setDraft({ tenantId: '', type: 'platform_subdomain', label: '', hostname: '', parentDomainId: '' });

  const handleCreate = () => {
    if (!canManage) return;
    if (!draft.tenantId) { setCreateError('Select a tenant first.'); return; }

    let hostname = '';
    let kind: DomainKind;
    let role: DomainRole;
    let parentDomainId: string | null = null;

    if (draft.type === 'root') {
      hostname = draft.hostname.trim().toLowerCase();
      if (!hostname) { setCreateError('Enter the external website / root domain (e.g. example.com).'); return; }
      if (!ROOT_DOMAIN_RE.test(hostname)) { setCreateError('Enter a valid root domain, e.g. example.com.'); return; }
      kind = 'custom'; role = 'root';
    } else if (draft.type === 'subdomain') {
      if (!draft.parentDomainId || !draftParentRoot) { setCreateError('Select the parent external website.'); return; }
      if (!draftLabel) { setCreateError('Enter the subdomain label.'); return; }
      if (!DNS_LABEL_RE.test(draftLabel)) { setCreateError('Label may use a–z, 0–9 and hyphens only (no leading/trailing hyphen).'); return; }
      hostname = `${draftLabel}.${draftParentRoot.hostname}`;
      kind = 'custom'; role = 'subdomain'; parentDomainId = draftParentRoot.id;
    } else {
      if (!draftLabel) { setCreateError('Enter the tenant slug for the platform web address.'); return; }
      if (!DNS_LABEL_RE.test(draftLabel)) { setCreateError('Slug may use a–z, 0–9 and hyphens only (no leading/trailing hyphen).'); return; }
      hostname = `${draftLabel}.${PLATFORM_ROOT_SUFFIX}`;
      kind = 'subdomain'; role = 'subdomain'; parentDomainId = null;
    }

    if (domains.some(d => d.hostname === hostname)) {
      setCreateError('A web-address record with that hostname already exists.');
      return;
    }

    // Platform web addresses are active immediately; external website / redirect
    // records start as needs-setup (manual, outside this app).
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
    const typeLabel = draft.type === 'platform_subdomain' ? 'platform web address' : draft.type === 'root' ? 'external website / redirect record' : 'subdomain';
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

  const patchFilter = (patch: Partial<WebAddressFilters>) => setFilters(f => ({ ...f, ...patch }));
  const clearAll = () => setFilters(EMPTY_FILTERS);
  // Selecting a saved view resets the dimension filters so the view's standalone
  // count equals exactly what the table then shows (no invisible carry-over).
  const selectView = (view: WebAddressView) => setFilters({ ...EMPTY_FILTERS, view });

  const isDefaultView =
    filters.view === 'all' && !filters.search.trim() && filters.tenantId === 'all' &&
    filters.status === 'all' && filters.externalRedirect === 'all' && filters.rawStatus === 'all';

  // Every active filter renders as a visible, clearable chip — no invisible
  // filters can ever hide rows (locked rule).
  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.view !== 'all') activeChips.push({ key: 'view', label: `View: ${VIEW_LABELS[filters.view]}`, clear: () => patchFilter({ view: 'all' }) });
  if (filters.search.trim()) activeChips.push({ key: 'search', label: `Search: "${filters.search.trim()}"`, clear: () => patchFilter({ search: '' }) });
  if (filters.tenantId !== 'all') activeChips.push({ key: 'tenantId', label: `Tenant: ${tenantName(filters.tenantId)}`, clear: () => patchFilter({ tenantId: 'all' }) });
  if (filters.status !== 'all') activeChips.push({ key: 'status', label: `Status: ${WEB_ADDRESS_STATUS_LABELS[filters.status]}`, clear: () => patchFilter({ status: 'all' }) });
  if (filters.externalRedirect !== 'all') activeChips.push({ key: 'ext', label: `External redirect: ${filters.externalRedirect === 'yes' ? 'Yes' : 'No'}`, clear: () => patchFilter({ externalRedirect: 'all' }) });
  if (filters.rawStatus !== 'all') activeChips.push({ key: 'rawStatus', label: `Raw status: ${RAW_STATUS_LABELS[filters.rawStatus]}`, clear: () => patchFilter({ rawStatus: 'all' }) });

  if (!viewGate.allowed) {
    return (
      <div className="space-y-8">
        <div>
          <h2 className="text-2xl font-black text-primary tracking-tight">Tenant Web Address</h2>
        </div>
        <div className="bg-white/80 backdrop-blur-xl rounded-[2rem] border border-slate-200 p-12 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-slate-300">lock</span>
          <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">No access</p>
          <p className="mt-1 text-xs font-bold text-slate-400">{viewGate.reason || 'You do not have permission to view Tenant Web Address.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Command header */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-black text-primary tracking-tight">Tenant Web Address</h2>
          <p className="text-slate-500 font-medium">Manage tenant platform URLs, customer-facing links, and optional external redirect guidance.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <TruthLabel text={WEB_ADDRESS_TRUTH_LABELS.platformManaged} tone="amber" />
            <TruthLabel text={WEB_ADDRESS_TRUTH_LABELS.customFuture} tone="slate" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowHelp(true)} className="px-4 py-3 bg-white text-slate-600 font-black text-xs rounded-2xl uppercase tracking-widest border border-slate-200 hover:bg-slate-50 transition-all cursor-pointer inline-flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">help</span>Help &amp; Redirect Guidance
          </button>
          {canManage ? (
            <button onClick={() => { setCreateError(null); resetDraft(); setShowCreate(true); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all cursor-pointer active:scale-95">+ Add Web Address</button>
          ) : (
            <span className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 border border-slate-200 rounded-xl">Read-only — Manage Tenant Web Address required</span>
          )}
        </div>
      </div>

      {/* Dashboard summary cards — clickable cards apply the matching view so a
          card's number always equals the rows it reveals (locked no-drift). */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard label="Total Tenant Web Addresses" value={totalCount} active={isDefaultView} onClick={clearAll} />
        <SummaryCard label="Active Platform Subdomains" value={activePlatformCount} tint="lime" active={filters.view === 'active_platform'} onClick={() => selectView('active_platform')} />
        <SummaryCard label="Needs Setup" value={needsSetupCount} tint="amber" active={filters.view === 'needs_setup'} onClick={() => selectView('needs_setup')} />
        <SummaryCard label="Disabled Web Addresses" value={disabledCount} active={filters.view === 'disabled'} onClick={() => selectView('disabled')} />
        <SummaryCard label="External Redirects on File" value={externalRedirectCount} tint="amber" active={filters.view === 'external_redirects'} onClick={() => selectView('external_redirects')} />
        <SummaryCard label="Custom Domain — Future" value={customFutureCount} sub="Support-assisted" tint="future" active={filters.view === 'custom_future'} onClick={() => selectView('custom_future')} />
      </div>

      {/* Deep-link stale-id notice */}
      {deepLinkNotice && (
        <div className="flex items-start gap-3 px-5 py-4 bg-amber-50 border border-amber-200 rounded-2xl">
          <span className="material-symbols-outlined text-amber-600 text-lg">link_off</span>
          <p className="flex-1 text-[12px] font-bold text-amber-800">{deepLinkNotice}</p>
          <button onClick={() => setDeepLinkNotice(null)} className="text-amber-500 hover:text-amber-700 transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-base">close</span>
          </button>
        </div>
      )}

      {/* Web address table — saved views, search, filters and chips all derive
          from ONE predicate over ONE signal array (locked no-drift). */}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        {/* Saved views */}
        <div className="px-6 pt-5 flex flex-wrap gap-2">
          {VIEW_ORDER.map(v => {
            const active = filters.view === v;
            return (
              <button key={v} onClick={() => selectView(v)} className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all cursor-pointer inline-flex items-center gap-1.5 active:scale-95 ${active ? 'bg-primary text-white shadow-sm shadow-primary/20' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-700'}`}>
                {VIEW_LABELS[v]}
                <span className={`px-1.5 py-0.5 rounded-md text-[9px] ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{countView(v)}</span>
              </button>
            );
          })}
        </div>

        {/* Toolbar: search + filters */}
        <div className="px-6 py-5 space-y-4 border-b border-slate-100">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">search</span>
              <input
                value={filters.search}
                onChange={e => patchFilter({ search: e.target.value })}
                placeholder="Search tenant, platform web address, external website…"
                className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 placeholder:text-slate-400 placeholder:font-medium"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <FilterSelect label="Tenant" value={filters.tenantId} onChange={v => patchFilter({ tenantId: v })} options={[['all', 'All tenants'], ...tenants.map(t => [t.id, t.name] as [string, string])]} />
            <FilterSelect label="Status" value={filters.status} onChange={v => patchFilter({ status: v as WebAddressFilters['status'] })} options={[['all', 'All statuses'], ...(Object.keys(WEB_ADDRESS_STATUS_LABELS) as WebAddressStatus[]).map(k => [k, WEB_ADDRESS_STATUS_LABELS[k]] as [string, string])]} />
            <FilterSelect label="External redirect" value={filters.externalRedirect} onChange={v => patchFilter({ externalRedirect: v as WebAddressFilters['externalRedirect'] })} options={[['all', 'All'], ['yes', 'Has external redirect'], ['no', 'Platform only']]} />
          </div>

          {/* Active filter chips — no invisible filters */}
          {activeChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Active:</span>
              {activeChips.map(c => (
                <button key={c.key} onClick={c.clear} className="group inline-flex items-center gap-1.5 px-3 py-1 bg-primary/10 text-primary border border-primary/20 rounded-full text-[10px] font-black uppercase tracking-widest hover:bg-primary/20 transition-all cursor-pointer">
                  {c.label}
                  <span className="material-symbols-outlined text-[13px] group-hover:scale-110 transition-transform">close</span>
                </button>
              ))}
              <button onClick={clearAll} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 underline cursor-pointer">Clear all</button>
            </div>
          )}
        </div>

        {/* Table header strip */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-100">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Tenant Web Addresses</span>
          <span className="text-[10px] font-bold text-slate-400">{visible.length} matching</span>
        </div>

        {visible.length === 0 ? (
          <div className="px-8 py-16 text-center">
            <span className="material-symbols-outlined text-4xl text-slate-300">{webAddresses.length === 0 ? 'public' : 'filter_alt_off'}</span>
            <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">{webAddresses.length === 0 ? 'No tenant web addresses yet' : 'No web addresses match the active filters'}</p>
            <p className="mt-1 text-xs font-bold text-slate-400">{webAddresses.length === 0 ? 'Add a platform web address to get started.' : 'Adjust or clear the filters above to widen the view.'}</p>
            {webAddresses.length > 0 && (
              <button onClick={clearAll} className="mt-4 px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-primary border border-primary/20 bg-primary/5 rounded-xl hover:bg-primary/10 transition-all cursor-pointer">Clear all filters</button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto xl:overflow-x-visible">
            <table className="w-full text-left border-collapse table-fixed">
              <colgroup>
                <col className="w-[34%]" />
                <col className="w-[40%]" />
                <col className="w-[14%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead className="bg-white">
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 align-bottom">
                  <th className="px-3 py-3">Tenant</th>
                  <th className="px-2 py-3">Platform Web Address</th>
                  <th className="px-2 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tableRows.map(row => {
                  const p = row.primary;
                  const isExternalOnly = p.kind === 'external';
                  const platformAddr = isExternalOnly ? null : p.platformWebAddress;
                  const mainUrl = isExternalOnly ? '' : p.mainAppUrl;
                  const rowIds = [p.domainId, ...row.externals.map(e => e.domainId)];
                  const isSel = selectedId !== null && rowIds.includes(selectedId);
                  return (
                    <tr key={p.domainId} onClick={() => setSelectedId(p.domainId)} className={`cursor-pointer transition-colors align-top ${isSel ? 'bg-primary/5' : 'hover:bg-slate-50/70'}`}>
                      <td className="px-3 py-3">
                        <span className="block text-[12px] font-bold text-slate-900 break-words leading-tight">{p.tenant}</span>
                        {isExternalOnly && <span className="mt-1 inline-flex px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border border-slate-200 bg-slate-50 text-slate-500">External Only</span>}
                      </td>
                      <td className="px-2 py-3">
                        {platformAddr ? (
                          <div className="flex items-start gap-1.5">
                            <span className="text-[12px] font-bold text-slate-700 break-all leading-tight">{platformAddr}</span>
                            <button onClick={e => { e.stopPropagation(); copy(mainUrl, `${p.domainId}-main`); }} title="Copy main URL" className="shrink-0 mt-0.5 text-slate-400 hover:text-primary transition-colors cursor-pointer">
                              <span className="material-symbols-outlined text-[14px] leading-none">{copied === `${p.domainId}-main` ? 'check' : 'content_copy'}</span>
                            </button>
                          </div>
                        ) : <span className="text-[12px] font-bold text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-3"><span className={`inline-flex px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${STATUS_TONE[p.status]}`}>{p.statusLabel}</span></td>
                      <td className="px-3 py-3 text-right">
                        <button onClick={e => { e.stopPropagation(); setSelectedId(p.domainId); }} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-primary border border-primary/20 bg-primary/5 rounded-lg hover:bg-primary/10 transition-all cursor-pointer whitespace-nowrap">
                          <span className="material-symbols-outlined text-[13px] leading-none">open_in_new</span>Manage
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add modal */}
      <AnimatePresence>
        {showCreate && canManage && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowCreate(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-xl font-black text-primary tracking-tight">Add Tenant Web Address</h3>
                <button onClick={() => setShowCreate(false)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-4 max-h-[70vh] overflow-y-auto">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tenant</label>
                  <select value={draft.tenantId} onChange={e => { const tid = e.target.value; setDraft(d => ({ ...d, tenantId: tid, parentDomainId: '', label: d.type === 'platform_subdomain' ? (tenantSlugRecord[tid] || d.label) : d.label })); setCreateError(null); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 cursor-pointer">
                    <option value="">Select a tenant…</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Record type</label>
                  <div className="grid grid-cols-1 gap-2">
                    {(['platform_subdomain', 'root', 'subdomain'] as CreateType[]).map(t => (
                      <button key={t} onClick={() => { setDraft(d => ({ ...d, type: t, label: t === 'platform_subdomain' ? (tenantSlugRecord[d.tenantId] || '') : '', hostname: '', parentDomainId: '' })); setCreateError(null); }} className={`text-left px-4 py-3 rounded-2xl border text-sm font-bold transition-all cursor-pointer ${draft.type === t ? 'bg-primary/5 border-primary text-primary' : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                        <span className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-base">{t === 'platform_subdomain' ? 'public' : t === 'root' ? 'language' : 'subdirectory_arrow_right'}</span>
                          {CREATE_TYPE_LABELS[t]}
                          {t === 'platform_subdomain' && <span className="ml-auto px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md bg-lime-400/10 text-lime-700 border border-lime-400/20">Recommended</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {draft.type === 'platform_subdomain' && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tenant slug</label>
                    <input value={draft.label} onChange={e => { setDraft(d => ({ ...d, label: e.target.value })); setCreateError(null); }} placeholder={draftSlugDefault || 'tenant-slug'} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
                    <p className="mt-1.5 text-[10px] font-medium text-slate-400">Generated platform web address: <span className="font-bold text-slate-600">{computedHostname || `slug.${PLATFORM_ROOT_SUFFIX}`}</span></p>
                  </div>
                )}

                {draft.type === 'root' && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">External website / root domain</label>
                    <input value={draft.hostname} onChange={e => { setDraft(d => ({ ...d, hostname: e.target.value })); setCreateError(null); }} placeholder="example.com" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
                    <p className="mt-1.5 text-[10px] font-medium text-slate-400">Recorded for redirect guidance only. {WEB_ADDRESS_TRUTH_LABELS.externalConfig}</p>
                  </div>
                )}

                {draft.type === 'subdomain' && (
                  <>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Parent external website</label>
                      <select value={draft.parentDomainId} onChange={e => { setDraft(d => ({ ...d, parentDomainId: e.target.value })); setCreateError(null); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 cursor-pointer">
                        <option value="">{rootDomainsForTenant.length ? 'Select a parent…' : 'No external root on file for this tenant'}</option>
                        {rootDomainsForTenant.map(r => <option key={r.id} value={r.id}>{r.hostname}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Subdomain label</label>
                      <input value={draft.label} onChange={e => { setDraft(d => ({ ...d, label: e.target.value })); setCreateError(null); }} placeholder="portal" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" />
                      <p className="mt-1.5 text-[10px] font-medium text-slate-400">Result: <span className="font-bold text-slate-600">{computedHostname || 'label.example.com'}</span></p>
                    </div>
                  </>
                )}

                {createError && <p className="text-[11px] font-bold text-red-600">{createError}</p>}
                <p className="text-[10px] font-medium text-slate-400 leading-relaxed">{WEB_ADDRESS_TRUTH_LABELS.platformManaged} {WEB_ADDRESS_TRUTH_LABELS.customFuture}</p>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white transition-all cursor-pointer">Cancel</button>
                <button onClick={handleCreate} disabled={!draft.tenantId || !computedHostname} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer">Add Web Address</button>
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
                <h3 className="text-lg font-black text-primary tracking-tight">Disable web address?</h3>
                <p className="text-sm font-bold text-slate-600">This marks <span className="text-slate-900">{confirmDisable.hostname}</span> as disabled and records an audit entry. Customer-facing links should be considered off until re-enabled.</p>
              </div>
              <div className="p-7 pt-0 flex justify-end gap-2">
                <button onClick={() => setConfirmDisable(null)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all">Cancel</button>
                <button onClick={() => { setStatus(confirmDisable, 'disabled'); setConfirmDisable(null); }} className="px-6 py-2.5 bg-red-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-red-600/20 hover:bg-red-700 transition-all">Disable</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Help / Redirect Guidance */}
      <AnimatePresence>
        {showHelp && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowHelp(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="relative w-full max-w-lg bg-white rounded-[2.5rem] shadow-2xl overflow-hidden">
              <div className="p-7 border-b border-slate-100 flex justify-between items-center">
                <h3 className="text-xl font-black text-primary tracking-tight">Help &amp; Redirect Guidance</h3>
                <button onClick={() => setShowHelp(false)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
              <div className="p-7 space-y-4 max-h-[70vh] overflow-y-auto text-sm">
                {HELP_TOPICS.map(topic => (
                  <div key={topic.q}>
                    <p className="font-black text-slate-800">{topic.q}</p>
                    <p className="mt-0.5 font-medium text-slate-500 leading-relaxed">{topic.a}</p>
                  </div>
                ))}
                <div className="pt-2 border-t border-slate-100 space-y-1.5">
                  <TruthLabel text={WEB_ADDRESS_TRUTH_LABELS.platformManaged} tone="amber" />
                  <TruthLabel text={WEB_ADDRESS_TRUTH_LABELS.noLiveDns} tone="slate" />
                  <TruthLabel text={WEB_ADDRESS_TRUTH_LABELS.customFuture} tone="slate" />
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Selected web address overview — slide-over */}
      <AnimatePresence>
        {selected && selectedWa && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedId(null)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-xl h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <WebAddressOverview
                wa={selectedWa}
                siblingExternals={selectedSiblingExternals}
                onOpenWebAddress={setSelectedId}
                selected={selected}
                canManage={canManage}
                history={selectedHistory}
                copied={copied}
                onCopy={copy}
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

const HELP_TOPICS: { q: string; a: string }[] = [
  { q: 'What is a platform web address?', a: `A platform-managed URL for each tenant in the form tenant.${PLATFORM_ROOT_SUFFIX}. It is the tenant's primary, app-managed base URL.` },
  { q: 'How should tenants use it?', a: 'It is the base for the main app and customer-facing links — customer portal, booking, repair tracking, invoice payment, and mail-in repair intake.' },
  { q: 'How do they link it from their existing website?', a: 'Add buttons or links on the tenant\u2019s own website (e.g. "Book a repair", "Track my repair") that point to the platform web address and its paths.' },
  { q: 'How do they redirect a root/custom domain?', a: 'Tenant-owned domains are configured outside this app. For now, redirect the tenant\u2019s website or root domain to the platform web address at their own DNS/registrar.' },
  { q: 'Why aren\u2019t DNS/SSL managed inside the app?', a: 'This is a repair/POS platform, not a DNS host or certificate authority. No live DNS lookup or SSL automation runs in this phase.' },
  { q: 'When might custom-domain support apply?', a: 'Full custom domain hosting, DNS verification, and SSL automation are future / support-assisted capabilities, handled with platform support when introduced.' },
];

// ---------------------------------------------------------------------------
// Selected Tenant Web Address overview (slide-over).
// ---------------------------------------------------------------------------

interface WebAddressOverviewProps {
  wa: TenantWebAddress;
  siblingExternals: TenantWebAddress[];
  onOpenWebAddress: (domainId: string) => void;
  selected: TenantDomainRecord;
  canManage: boolean;
  history: { id: string; date: string; actor: string; action: string }[];
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  onSetStatus: (d: TenantDomainRecord, next: DomainStatus) => void;
  onSetSsl: (d: TenantDomainRecord, next: DomainSslStatus) => void;
  onReenable: (d: TenantDomainRecord) => void;
  onConfirmDisable: (d: TenantDomainRecord) => void;
  onClose?: () => void;
}

const WebAddressOverview: React.FC<WebAddressOverviewProps> = ({
  wa, siblingExternals, onOpenWebAddress, selected, canManage, history, copied, onCopy, onSetStatus, onSetSsl, onReenable, onConfirmDisable, onClose,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  // No live hosting this phase: Open stays disabled (Future / Not active) while
  // Copy is always allowed. A disabled web address marks every access point off.
  const isDisabled = wa.status === 'disabled';
  const openLive = WEB_ADDRESS_LIVE_HOSTING && !isDisabled;
  const accessPointStatus = isDisabled ? 'Disabled' : (WEB_ADDRESS_LIVE_HOSTING ? 'Active' : 'Future / Not active');

  // Customer access points — the Main App plus the derived customer-facing links,
  // shown as one clean, scannable list (no DNS/registrar/SSL anywhere).
  const accessPoints = wa.platformWebAddress
    ? [
        { key: 'main', label: 'Main App', preview: '/', url: wa.mainAppUrl },
        ...wa.customerLinks.map(l => ({ key: l.key, label: l.label, preview: l.path || '/', url: l.url })),
      ]
    : [];

  const CopyBtn: React.FC<{ text: string; k: string; label?: string }> = ({ text, k, label }) => (
    <button onClick={() => onCopy(text, k)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-primary border border-primary/20 bg-primary/5 rounded-lg hover:bg-primary/10 transition-all cursor-pointer whitespace-nowrap">
      <span className="material-symbols-outlined text-[13px] leading-none">{copied === k ? 'check' : 'content_copy'}</span>{copied === k ? 'Copied' : (label ?? 'Copy')}
    </button>
  );

  return (
    <>
      {/* 1 — Workspace header + primary actions */}
      <div className="p-6 border-b border-slate-100 bg-gradient-to-br from-white to-slate-50/60">
        <div className="flex justify-between items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-primary/60">Tenant Web Address Workspace</p>
            <h3 className="text-lg font-black text-primary mt-1 truncate">{wa.tenant}</h3>
            <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
              <span className="material-symbols-outlined text-[15px] text-slate-400 shrink-0">language</span>
              <p className="text-[12px] font-bold text-slate-600 break-all">{wa.platformWebAddress ?? wa.rawHostname}</p>
              {wa.platformWebAddress && (
                <button onClick={() => onCopy(wa.platformWebAddress!, 'hdr-host')} title="Copy platform web address" className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-primary hover:bg-primary/10 transition-all cursor-pointer">
                  <span className="material-symbols-outlined text-[14px]">{copied === 'hdr-host' ? 'check' : 'content_copy'}</span>
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${KIND_TONE[wa.kind]}`}>{WEB_ADDRESS_KIND_LABELS[wa.kind]}</span>
              <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_TONE[wa.status]}`}>{wa.statusLabel}</span>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 shrink-0 cursor-pointer">
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          )}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => wa.mainAppUrl && onCopy(wa.mainAppUrl, 'hdr-link')}
            disabled={!wa.mainAppUrl}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white bg-primary rounded-xl shadow-sm shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px] leading-none">{copied === 'hdr-link' ? 'check' : 'link'}</span>{copied === 'hdr-link' ? 'Copied' : 'Copy Link'}
          </button>
          <button
            disabled={!openLive}
            title={openLive ? 'Open site' : 'Future / Not active — no live hosting in this phase'}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border border-slate-200 bg-white text-slate-400 disabled:cursor-not-allowed cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px] leading-none">open_in_new</span>{openLive ? 'Open Site' : 'Open Site (Future)'}
          </button>
        </div>
        <p className="mt-2.5 text-[9px] font-medium text-slate-400 leading-tight">{wa.kind === 'external' ? WEB_ADDRESS_TRUTH_LABELS.externalSubdomain : WEB_ADDRESS_TRUTH_LABELS.platformSubdomain}</p>
      </div>

      <div className="p-6 space-y-6">
        {/* Next recommended action */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Next recommended action</p>
          <p className="text-sm font-black text-slate-800">{wa.nextAction}</p>
        </div>

        {/* 2 — Customer Access Points */}
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Customer access points</p>
          {accessPoints.length === 0 ? (
            <p className="text-[11px] font-bold text-slate-400 px-3 py-2.5 bg-slate-50 border border-dashed border-slate-200 rounded-xl">Not configured — set the platform web address to generate customer access points.</p>
          ) : (
            <div className="space-y-1.5">
              {accessPoints.map(ap => (
                <AccessPointRow key={ap.key} label={ap.label} preview={ap.preview} url={ap.url} statusLabel={accessPointStatus} live={openLive} copyKey={`ap-${ap.key}`} copied={copied} onCopy={onCopy} />
              ))}
            </div>
          )}
          <p className="text-[9px] font-medium text-slate-400 leading-tight mt-2">{WEB_ADDRESS_TRUTH_LABELS.pathsFuture}</p>
        </div>

        {/* 3 — External Presence / Redirect Guidance */}
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">External presence</p>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
            {wa.redirectGuidance.externalWebsite ? (
              <Row label="External website" value={wa.redirectGuidance.externalWebsite} />
            ) : (
              <div>
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">External website</p>
                <p className="text-[12px] font-bold text-slate-400">No external website recorded.</p>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Redirect target</p>
                <p className="text-[12px] font-bold text-slate-700 break-all">{wa.redirectGuidance.redirectTarget ?? '—'}</p>
              </div>
              {wa.redirectGuidance.redirectTarget && <CopyBtn text={wa.redirectGuidance.redirectTarget} k="ov-redirect" label="Copy target" />}
            </div>
            <p className="text-[11px] font-medium text-slate-500 leading-relaxed">{wa.redirectGuidance.explanation}</p>
            {siblingExternals.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Other external records for this tenant</p>
                {siblingExternals.map(s => (
                  <div key={s.domainId} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-slate-100 bg-slate-50/60">
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-bold text-slate-700 break-all leading-tight">{s.externalWebsite ?? s.rawHostname}</p>
                      <p className="text-[9px] font-medium text-slate-400 leading-tight mt-0.5">{s.statusLabel} · redirect externally to platform URL</p>
                    </div>
                    <button onClick={() => onOpenWebAddress(s.domainId)} className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-primary border border-primary/20 bg-primary/5 rounded-lg hover:bg-primary/10 transition-all cursor-pointer whitespace-nowrap">
                      <span className="material-symbols-outlined text-[13px] leading-none">open_in_new</span>Manage
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="px-3 py-2 rounded-xl bg-violet-400/5 border border-violet-400/20">
              <p className="text-[10px] font-black text-violet-700 uppercase tracking-widest">Custom domain support</p>
              <p className="text-[11px] font-bold text-slate-600">Future / Support-Assisted</p>
            </div>
          </div>
        </div>

        {/* 4 — Configuration Progress */}
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Configuration progress</p>
          <div className="space-y-1.5">
            {wa.checklist.map(item => (
              <div key={item.key} className="flex items-start gap-2.5 px-3 py-2 rounded-xl border border-slate-100 bg-slate-50/60">
                <span className={`material-symbols-outlined text-base mt-px ${CHECKLIST_TONE[item.state].icon}`}>{CHECKLIST_TONE[item.state].symbol}</span>
                <div className="flex-1">
                  <p className={`text-[11px] font-bold ${item.state === 'done' ? 'text-slate-500' : item.state === 'not_applicable' ? 'text-slate-400' : 'text-slate-700'}`}>{item.label}</p>
                  {item.hint && <p className="text-[10px] font-medium text-slate-400 mt-0.5">{item.hint}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Manage (gated) — lifecycle actions, audited exactly as before */}
        {canManage && (
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Manage web address</p>
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Status</label>
              {selected.status === 'disabled' ? (
                <div className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-xs font-black uppercase tracking-widest text-slate-500">Disabled</div>
              ) : (
                <select value={manageSelectValue(selected.status)} onChange={e => onSetStatus(selected, e.target.value as DomainStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                  {MANAGE_STATUS_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => onSetStatus(selected, 'verified')} disabled={selected.status === 'verified'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-lime-400/10 text-lime-700 border border-lime-400/20 rounded-xl disabled:opacity-40 hover:bg-lime-400/20 transition-all cursor-pointer">Mark Active</button>
              <button onClick={() => onSetStatus(selected, 'pending')} disabled={selected.status === 'pending'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-blue-400/10 text-blue-700 border border-blue-400/20 rounded-xl disabled:opacity-40 hover:bg-blue-400/20 transition-all cursor-pointer">Mark Needs Setup</button>
              {selected.status !== 'disabled' ? (
                <button onClick={() => onConfirmDisable(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-200 transition-all cursor-pointer">Disable</button>
              ) : (
                <button onClick={() => onReenable(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-blue-400/10 text-blue-700 border border-blue-400/20 rounded-xl hover:bg-blue-400/20 transition-all cursor-pointer">Re-enable</button>
              )}
            </div>
          </div>
        )}

        {/* 5 — Recent Activity */}
        <div className="pt-2 border-t border-slate-100">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Recent activity</p>
          {history.length === 0 ? (
            <p className="text-[11px] font-bold text-slate-400">No recorded activity for this web address.</p>
          ) : (
            <div className="space-y-2">
              {history.map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <span className="font-mono text-slate-400 whitespace-nowrap">{e.date}</span>
                  <div><span className="font-black text-slate-700">{activityLabel(e.action)}</span><span className="text-slate-400"> · {e.actor}</span></div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[9px] text-slate-400 font-medium mt-2 leading-tight">Recorded lifecycle events for this exact hostname. Audit is date-granular — no sub-day timestamp.</p>
        </div>

        {/* Advanced Custom Domain Support — Future / Support-Assisted (collapsed).
            De-technicalised per the strategic pivot: no DNS/SSL readiness grid is
            shown; only a support-assisted explanation plus the manual,
            support-assisted SSL-state control (gated + audited as before). */}
        <div className="pt-2 border-t border-slate-100">
          <button onClick={() => setShowAdvanced(s => !s)} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50/60 hover:bg-slate-100 transition-all cursor-pointer">
            <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500">
              <span className="material-symbols-outlined text-sm text-violet-500">tune</span>
              Advanced Custom Domain Support
              <span className="px-1.5 py-0.5 rounded-md text-[8px] bg-violet-400/10 text-violet-700 border border-violet-400/20">Future / Support-Assisted</span>
            </span>
            <span className="material-symbols-outlined text-base text-slate-400">{showAdvanced ? 'expand_less' : 'expand_more'}</span>
          </button>
          {showAdvanced && (
            <div className="mt-3 space-y-3">
              <p className="text-[11px] font-medium text-slate-500 leading-relaxed">Custom domain hosting is not self-serve in this phase. Tenant-owned websites and domains remain external. Support-assisted setup may be considered in a future phase.</p>
              <p className="text-[10px] font-medium text-slate-400 leading-relaxed">{WEB_ADDRESS_TRUTH_LABELS.noLiveDns} {WEB_ADDRESS_TRUTH_LABELS.externalConfig}</p>
              {canManage && selected.status !== 'disabled' && (
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">SSL state (manual / support-assisted)</label>
                  <select value={selected.ssl} onChange={e => onSetSsl(selected, e.target.value as DomainSslStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                    {(['none', 'pending', 'active', 'failed'] as DomainSslStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="text-[10px] text-slate-400 grid grid-cols-2 gap-2 pt-4 border-t border-slate-100">
          <div>Created: <span className="font-bold text-slate-600">{selected.createdAt}</span></div>
          <div>Status reviewed: <span className="font-bold text-slate-600">{selected.verifiedAt || '—'}</span></div>
          <div className="col-span-2">Last reviewed: <span className="font-bold text-slate-600">{selected.lastCheckedAt || '—'}</span></div>
          <div className="col-span-2 font-mono">id: {selected.id}</div>
        </div>
      </div>
    </>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className="text-[12px] font-bold text-slate-700 break-all">{value}</p>
  </div>
);

const ACCESS_POINT_STATUS_TONE: Record<string, string> = {
  Active: 'bg-lime-400/10 text-lime-700 border-lime-400/20',
  'Future / Not active': 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  Disabled: 'bg-slate-200 text-slate-600 border-slate-300',
};

const AccessPointRow: React.FC<{
  label: string;
  preview: string;
  url: string;
  statusLabel: string;
  live: boolean;
  copyKey: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}> = ({ label, preview, url, statusLabel, live, copyKey, copied, onCopy }) => (
  <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl border border-slate-100 bg-white hover:border-slate-200 transition-all">
    <div className="flex-1 min-w-0">
      <p className="text-[12px] font-black text-slate-700 truncate">{label}</p>
      <p className="text-[10px] font-mono text-slate-400 break-all mt-0.5">{preview}</p>
    </div>
    <div className="flex items-center gap-1.5 shrink-0">
      <span className={`hidden sm:inline px-2 py-0.5 rounded-md text-[8px] font-black uppercase tracking-widest border ${ACCESS_POINT_STATUS_TONE[statusLabel] ?? ACCESS_POINT_STATUS_TONE.Disabled}`}>{statusLabel}</span>
      <button onClick={() => onCopy(url, copyKey)} title="Copy link" className="w-7 h-7 rounded-lg flex items-center justify-center text-primary border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-all cursor-pointer">
        <span className="material-symbols-outlined text-[14px] leading-none">{copied === copyKey ? 'check' : 'content_copy'}</span>
      </button>
      <button disabled={!live} title={live ? 'Open' : 'Future / Not active'} className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 border border-slate-200 bg-slate-50 disabled:cursor-not-allowed cursor-pointer">
        <span className="material-symbols-outlined text-[14px] leading-none">open_in_new</span>
      </button>
    </div>
  </div>
);

const TruthLabel: React.FC<{ text: string; tone: 'amber' | 'slate' }> = ({ text, tone }) => (
  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${tone === 'amber' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
    <span className="material-symbols-outlined text-[12px]">info</span>
    {text}
  </span>
);

const SummaryCard: React.FC<{ label: string; value: React.ReactNode; sub?: string; tint?: 'lime' | 'amber' | 'red' | 'future'; active?: boolean; onClick?: () => void }> = ({ label, value, sub, tint, active, onClick }) => {
  const tintCls = tint === 'lime' ? 'text-lime-700' : tint === 'amber' ? 'text-amber-700' : tint === 'red' ? 'text-red-700' : tint === 'future' ? 'text-violet-700' : 'text-primary';
  const clickable = !!onClick;
  return (
    <button onClick={onClick} disabled={!clickable} className={`text-left bg-white/80 backdrop-blur-xl p-5 rounded-3xl border shadow-sm transition-all ${clickable ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 active:scale-[0.98]' : 'cursor-default'} ${active ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200'}`}>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-2xl font-black mt-1 ${tintCls}`}>{value}</p>
      {sub && <p className="text-[10px] font-bold text-slate-400 mt-0.5">{sub}</p>}
    </button>
  );
};

const FilterSelect: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: [string, string][] }> = ({ label, value, onChange, options }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <select value={value} onChange={e => onChange(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </div>
);

export default DomainsPage;
