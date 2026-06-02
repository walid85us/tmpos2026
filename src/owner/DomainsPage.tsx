import React, { useEffect, useMemo, useState } from 'react';
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
} from './mockData';
import { pushPlatformAudit, readMirroredAuditRows } from './platformOpsAudit';
import { useAccess } from '../context/AccessContext';
import { hasPlatformPermission } from './platformPermissionsConfig';
import type { Role } from '../context/accessConfig';
import {
  deriveDomainReadinessList,
  formatDnsRecord,
  DOMAIN_LIFECYCLE_LABELS,
  DOMAIN_SSL_READINESS_LABELS,
  DOMAIN_TRUTH_LABELS,
  type DomainLifecycleStatus,
  type DomainSslReadiness,
  type DomainReadinessSignal,
} from './platformOpsDomains';

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

interface DomainFilters {
  search: string;
  lifecycle: LifecycleFilter;
  kind: KindFilter;
  ssl: SslFilter;
  risk: RiskFilter;
}

const EMPTY_FILTERS: DomainFilters = {
  search: '',
  lifecycle: 'all',
  kind: 'all',
  ssl: 'all',
  risk: 'all',
};

// Single predicate — used for BOTH the visible list and every count, so card /
// tab counts can never drift from the filtered list (locked no-drift rule).
const matchesDomain = (s: DomainReadinessSignal, f: DomainFilters, tenantName: string): boolean => {
  if (f.lifecycle !== 'all' && s.lifecycle !== f.lifecycle) return false;
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
  const [draft, setDraft] = useState({ tenantId: '', hostname: '', kind: 'subdomain' as DomainKind });
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<TenantDomainRecord | null>(null);
  const [auditTick, setAuditTick] = useState(0);

  useEffect(() => { saveDomains(domains); }, [domains]);

  useEffect(() => {
    const h = () => setAuditTick(t => t + 1);
    window.addEventListener('audit_logs:changed', h);
    return () => window.removeEventListener('audit_logs:changed', h);
  }, []);

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

  const handleCreate = () => {
    if (!canManage) return;
    if (!draft.tenantId || !draft.hostname.trim()) return;
    const hostname = draft.hostname.trim().toLowerCase();
    if (domains.some(d => d.hostname === hostname)) {
      setCreateError('A domain record with that hostname already exists.');
      return;
    }
    const next: TenantDomainRecord = {
      id: `dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: draft.tenantId,
      hostname,
      kind: draft.kind,
      status: draft.kind === 'subdomain' ? 'verified' : 'pending',
      ssl: draft.kind === 'subdomain' ? 'active' : 'none',
      createdAt: today,
      verifiedAt: draft.kind === 'subdomain' ? today : null,
      lastCheckedAt: today,
      notes: '',
    };
    setDomains(prev => [next, ...prev]);
    pushPlatformAudit({
      actor: 'System Owner',
      action: 'domain_created',
      target: `${tenantName(draft.tenantId)} · ${hostname}`,
      category: 'domains',
      tenantId: draft.tenantId,
      severity: 'info',
      newValue: hostname,
      note: `Kind: ${draft.kind}; initial status: ${next.status}`,
    });
    setDraft({ tenantId: '', hostname: '', kind: 'subdomain' });
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
          <button onClick={() => { setCreateError(null); setShowCreate(true); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all">+ Add Domain</button>
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

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
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
                <button key={c.key} onClick={() => clearChip(c.key)} className="group inline-flex items-center gap-1.5 px-3 py-1 bg-primary/10 text-primary border border-primary/20 rounded-full text-[10px] font-black uppercase tracking-widest hover:bg-primary/20 transition-all">
                  {c.label}
                  <span className="material-symbols-outlined text-[13px] group-hover:scale-110 transition-transform">close</span>
                </button>
              ))}
              <button onClick={clearAll} className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 underline">Clear all</button>
            </div>
          )}
        </div>

        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Hostname</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Tenant</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Kind</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Lifecycle</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">SSL</th>
              <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Next action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(s => (
              <tr key={s.id} onClick={() => setSelectedId(s.id)} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors cursor-pointer">
                <td className="px-6 py-3.5 text-sm font-bold text-slate-900">
                  <div className="flex items-center gap-2">
                    {s.hostname}
                    {s.issueCount > 0 && <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500/15 text-red-700 text-[9px] font-black">{s.issueCount}</span>}
                  </div>
                </td>
                <td className="px-6 py-3.5 text-sm font-bold text-slate-700">{tenantName(s.tenantId)}</td>
                <td className="px-6 py-3.5"><span className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg bg-slate-100 text-slate-600 border border-slate-200">{s.kind}</span></td>
                <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${LIFECYCLE_STYLES[s.lifecycle]}`}>{s.lifecycleLabel}</span></td>
                <td className="px-6 py-3.5"><span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SSL_READINESS_STYLES[s.sslReadiness]}`}>{s.sslReadinessLabel}</span></td>
                <td className="px-6 py-3.5 text-xs font-bold text-slate-500">{s.nextAction}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={6} className="px-8 py-12 text-center text-slate-400 text-sm font-bold">
                {signals.length === 0 ? 'No domain records yet.' : 'No domain records match the active filters.'}
              </td></tr>
            )}
          </tbody>
        </table>
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
              <div className="p-7 space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tenant</label>
                  <select value={draft.tenantId} onChange={e => setDraft(d => ({ ...d, tenantId: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="">Select tenant…</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Kind</label>
                  <select value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value as DomainKind }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700">
                    <option value="subdomain">Platform Subdomain</option>
                    <option value="custom">Custom Domain</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Hostname</label>
                  <input value={draft.hostname} onChange={e => { setDraft(d => ({ ...d, hostname: e.target.value })); setCreateError(null); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700" placeholder={draft.kind === 'subdomain' ? 'tenant.repairplatform.com' : 'shop.example.com'} />
                </div>
                {createError && <p className="text-[11px] font-bold text-red-600">{createError}</p>}
                <p className="text-[10px] text-slate-500 font-bold">Custom domains start as <span className="text-amber-700">Pending DNS</span> and require manual verification using the DNS instructions in the detail view. {DOMAIN_TRUTH_LABELS.manual}</p>
              </div>
              <div className="p-7 border-t border-slate-100 bg-slate-50/40 flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 border border-slate-200 rounded-xl hover:bg-white transition-all">Cancel</button>
                <button onClick={handleCreate} disabled={!draft.tenantId || !draft.hostname.trim()} className="px-6 py-2.5 bg-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 disabled:opacity-40 transition-all">Add Domain</button>
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

      {/* Detail drawer */}
      <AnimatePresence>
        {selected && selectedSignal && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedId(null)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-md h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <div className="p-7 border-b border-slate-100 flex justify-between items-start">
                <div className="flex-1 pr-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Domain</p>
                  <h3 className="text-lg font-black text-primary mt-1 break-all">{selected.hostname}</h3>
                  <p className="text-xs text-slate-500 font-bold mt-1">{tenantName(selected.tenantId)} · {selected.kind}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${LIFECYCLE_STYLES[selectedSignal.lifecycle]}`}>{selectedSignal.lifecycleLabel}</span>
                    <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${SSL_READINESS_STYLES[selectedSignal.sslReadiness]}`}>SSL: {selectedSignal.sslReadinessLabel}</span>
                  </div>
                </div>
                <button onClick={() => setSelectedId(null)} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>

              <div className="p-7 space-y-6">
                {/* Next action */}
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Next recommended action</p>
                  <p className="text-sm font-black text-slate-800">{selectedSignal.nextAction}</p>
                </div>

                {/* Risk reasons */}
                {selectedSignal.riskReasons.length > 0 && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Readiness signals</p>
                    <div className="space-y-1.5">
                      {selectedSignal.riskReasons.map(r => (
                        <div key={r.code} className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[11px] font-bold ${r.tone === 'critical' ? 'bg-red-500/10 text-red-700 border-red-500/20' : r.tone === 'warn' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          <span className="material-symbols-outlined text-sm">{r.tone === 'critical' ? 'error' : r.tone === 'warn' ? 'warning' : 'info'}</span>
                          {r.label}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

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
                      <select disabled={!canManage} value={selected.status} onChange={e => setStatus(selected, e.target.value as DomainStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 disabled:opacity-50">
                        {(['pending', 'verifying', 'verified', 'failed'] as DomainStatus[]).map(s => (
                          <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">SSL</label>
                    <select disabled={!canManage} value={selected.ssl} onChange={e => setSsl(selected, e.target.value as DomainSslStatus)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 disabled:opacity-50">
                      {(['none', 'pending', 'active', 'failed'] as DomainSslStatus[]).map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>

                {/* Required DNS records */}
                {selectedSignal.requiredRecords.length > 0 && (
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Required DNS records</p>
                    <p className="text-[11px] text-amber-700 font-bold mb-3">Configure these at the customer's DNS provider, then mark this record verified once you've manually confirmed propagation. <span className="font-medium text-slate-500">{DOMAIN_TRUTH_LABELS.manual}</span></p>
                    <div className="space-y-2">
                      {selectedSignal.requiredRecords.map((rec, i) => (
                        <DnsBlock key={i} type={rec.type} host={rec.host} value={rec.value} purpose={rec.purpose} onCopy={() => copy(formatDnsRecord(rec), `rec${i}`)} copied={copied === `rec${i}`} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Quick actions */}
                {canManage && (
                  <div className="space-y-2 pt-2 border-t border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Quick actions</p>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setStatus(selected, 'verified')} disabled={selected.status === 'verified'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-lime-400/10 text-lime-700 border border-lime-400/20 rounded-xl disabled:opacity-40 hover:bg-lime-400/20 transition-all">Mark Verified</button>
                      <button onClick={() => setStatus(selected, 'verifying')} disabled={selected.status === 'verifying'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-blue-400/10 text-blue-700 border border-blue-400/20 rounded-xl disabled:opacity-40 hover:bg-blue-400/20 transition-all">Mark Pending</button>
                      <button onClick={() => setStatus(selected, 'failed')} disabled={selected.status === 'failed'} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-red-500/10 text-red-700 border border-red-500/30 rounded-xl disabled:opacity-40 hover:bg-red-500/20 transition-all">Mark Failed</button>
                      {selected.status !== 'disabled' ? (
                        <button onClick={() => setConfirmDisable(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-200 transition-all">Disable</button>
                      ) : (
                        <button onClick={() => reenable(selected)} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest bg-blue-400/10 text-blue-700 border border-blue-400/20 rounded-xl hover:bg-blue-400/20 transition-all">Re-enable</button>
                      )}
                    </div>
                  </div>
                )}

                {/* History */}
                <div className="pt-2 border-t border-slate-100">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">History</p>
                  {selectedHistory.length === 0 ? (
                    <p className="text-[11px] font-bold text-slate-400">No recorded history for this domain.</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedHistory.map((e, i) => (
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
                  <div className="col-span-2 text-slate-400 font-medium">{selectedSignal.truthLabel}</div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const TruthLabel: React.FC<{ text: string; tone: 'amber' | 'slate' }> = ({ text, tone }) => (
  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${tone === 'amber' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
    <span className="material-symbols-outlined text-[12px]">info</span>
    {text}
  </span>
);

const PostureCard: React.FC<{ label: string; value: number; tint?: 'lime' | 'amber' | 'red'; active?: boolean; onClick?: () => void }> = ({ label, value, tint, active, onClick }) => {
  const tintCls = tint === 'lime' ? 'text-lime-700' : tint === 'amber' ? 'text-amber-700' : tint === 'red' ? 'text-red-700' : 'text-primary';
  return (
    <button onClick={onClick} className={`text-left bg-white/80 backdrop-blur-xl p-5 rounded-3xl border shadow-sm transition-all hover:shadow-md ${active ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200'}`}>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-2xl font-black mt-1 ${tintCls}`}>{value}</p>
    </button>
  );
};

const Tab: React.FC<{ label: string; count: number; active: boolean; onClick: () => void }> = ({ label, count, active, onClick }) => (
  <button onClick={onClick} className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all inline-flex items-center gap-1.5 ${active ? 'bg-primary text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'}`}>
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
