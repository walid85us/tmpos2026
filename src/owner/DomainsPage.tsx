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
  deriveDomainSslWorkspace,
  deriveDomainTroubleshooting,
  formatDnsRecord,
  formatAllDnsRecords,
  DOMAIN_LIFECYCLE_LABELS,
  DOMAIN_ROLE_LABELS,
  DOMAIN_SSL_READINESS_LABELS,
  DOMAIN_DNS_READINESS_DETAIL,
  DOMAIN_DNS_READINESS_LABELS,
  DOMAIN_PROPAGATION_STEPS,
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
import {
  deriveDomainPortfolioSignals,
  deriveDomainControlPanelOverview,
  SSL_VIEW_STATUS_LABELS,
  DOMAIN_MODEL_TRUTH_LABELS,
  type DomainPortfolioSignal,
  type DomainPortfolioType,
  type PortfolioRisk,
  type SslViewStatus,
  type EmailDnsStatus,
  type SecurityReadinessLevel,
  type DomainControlPanelOverview,
} from './platformOpsDomainModel';

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

// ---------------------------------------------------------------------------
// Phase 1.2F Milestone 1 — Domain Portfolio dashboard + table model.
// Every summary card, filter, saved view, chip and count derives from ONE
// signal array (deriveDomainPortfolioSignals, from the M0 object model) and ONE
// predicate (matchesPortfolioFilter), so a number can never drift from the rows
// it represents (locked no-drift rule).
// ---------------------------------------------------------------------------

const PORTFOLIO_TYPE_LABELS: Record<DomainPortfolioType, string> = {
  root: 'Root',
  subdomain: 'Subdomain',
  platform: 'Platform',
  legacy: 'Legacy',
};

const PORTFOLIO_TYPE_TONE: Record<DomainPortfolioType, string> = {
  root: 'bg-indigo-500/10 text-indigo-700 border-indigo-500/20',
  subdomain: 'bg-slate-100 text-slate-600 border-slate-200',
  platform: 'bg-violet-400/10 text-violet-700 border-violet-400/20',
  legacy: 'bg-slate-200 text-slate-500 border-slate-300',
};

const SSL_VIEW_TONE: Record<SslViewStatus, ReadinessTone> = {
  not_started: 'neutral',
  pending_manual_validation: 'pending',
  manual_ready: 'ready',
  failed: 'failed',
  not_applicable: 'neutral',
};

const EMAIL_DNS_LABELS: Record<EmailDnsStatus, string> = {
  ready: 'Ready',
  partial: 'Partial',
  missing: 'Missing',
  pending_manual_review: 'Needs manual review',
  not_applicable: 'Not applicable',
};

const EMAIL_DNS_TONE: Record<EmailDnsStatus, ReadinessTone> = {
  ready: 'ready',
  partial: 'pending',
  missing: 'failed',
  pending_manual_review: 'pending',
  not_applicable: 'neutral',
};

const SECURITY_LEVEL_LABELS: Record<SecurityReadinessLevel, string> = {
  ready: 'Ready',
  partial: 'Partial',
  attention: 'Attention',
  future: 'Future',
  not_applicable: 'Not applicable',
};

const SECURITY_LEVEL_TONE: Record<SecurityReadinessLevel, ReadinessTone> = {
  ready: 'ready',
  partial: 'pending',
  attention: 'failed',
  future: 'future',
  not_applicable: 'neutral',
};

const RISK_LABELS: Record<PortfolioRisk, string> = {
  critical: 'High risk',
  warn: 'Watch',
  ok: 'OK',
};

const RISK_TONE: Record<PortfolioRisk, ReadinessTone> = {
  critical: 'failed',
  warn: 'pending',
  ok: 'ready',
};

// Presentation-only split of the registrar string into a primary name and a
// short muted context, so the portfolio cell stays two lines tall instead of
// wrapping a long " — platform apex (host)" tail across many rows. The full
// string is preserved in a tooltip; the underlying signal value is unchanged.
const splitRegistrar = (registrar: string): { name: string; context: string | null } => {
  const [namePart, ...rest] = registrar.split('—');
  const name = namePart.trim();
  if (rest.length === 0) return { name, context: null };
  const context = rest.join('—').replace(/\([^)]*\)/g, '').trim();
  return { name, context: context || null };
};

type PortfolioSavedView =
  | 'all'
  | 'needs_action'
  | 'failed_verification'
  | 'ssl_attention'
  | 'email_incomplete'
  | 'security_review'
  | 'legacy_unlinked';

const SAVED_VIEW_LABELS: Record<PortfolioSavedView, string> = {
  all: 'All Domains',
  needs_action: 'Needs Action',
  failed_verification: 'Failed Verification',
  ssl_attention: 'SSL Attention',
  email_incomplete: 'Email DNS Incomplete',
  security_review: 'Security Review',
  legacy_unlinked: 'Legacy / Unlinked',
};

const SAVED_VIEW_ORDER: PortfolioSavedView[] = [
  'all', 'needs_action', 'failed_verification', 'ssl_attention', 'email_incomplete', 'security_review', 'legacy_unlinked',
];

// Saved-view membership predicates (shared by the saved-view counts and the
// table predicate so they cannot diverge).
const portfolioNeedsAction = (s: DomainPortfolioSignal): boolean =>
  s.risk !== 'ok'
  || (s.sslReadiness !== 'manual_ready' && s.sslReadiness !== 'not_applicable')
  || (s.emailDnsReadiness !== 'ready' && s.emailDnsReadiness !== 'not_applicable')
  || s.securityReadiness === 'attention' || s.securityReadiness === 'partial';

const portfolioSslAttention = (s: DomainPortfolioSignal): boolean =>
  s.sslReadiness === 'failed' || s.sslReadiness === 'pending_manual_validation' || s.sslReadiness === 'not_started';

const portfolioEmailIncomplete = (s: DomainPortfolioSignal): boolean =>
  s.emailDnsReadiness === 'partial' || s.emailDnsReadiness === 'missing' || s.emailDnsReadiness === 'pending_manual_review';

const portfolioSecurityReview = (s: DomainPortfolioSignal): boolean =>
  s.securityReadiness === 'attention' || s.securityReadiness === 'partial';

// `failed_verification` reads the underlying persisted DomainStatus (date-granular
// truth from the base record), not a derived field.
const matchesSavedView = (s: DomainPortfolioSignal, view: PortfolioSavedView, statusById: Map<string, DomainStatus>): boolean => {
  switch (view) {
    case 'all': return true;
    case 'needs_action': return portfolioNeedsAction(s);
    case 'failed_verification': return statusById.get(s.domainId) === 'failed';
    case 'ssl_attention': return portfolioSslAttention(s);
    case 'email_incomplete': return portfolioEmailIncomplete(s);
    case 'security_review': return portfolioSecurityReview(s);
    case 'legacy_unlinked': return s.domainType === 'legacy';
    default: return true;
  }
};

interface PortfolioFilters {
  search: string;
  tenantId: string;                       // 'all' or a tenant id
  domainType: 'all' | DomainPortfolioType;
  dnsReadiness: 'all' | DomainDnsReadiness;
  sslReadiness: 'all' | SslViewStatus;
  emailDns: 'all' | EmailDnsStatus;
  security: 'all' | SecurityReadinessLevel;
  risk: 'all' | PortfolioRisk;
  // Raw persisted status — set only via Command Center deep-links (?status=...).
  // It has no dropdown of its own but ALWAYS renders a visible, clearable chip.
  rawStatus: 'all' | DomainStatus;
  savedView: PortfolioSavedView;
}

const EMPTY_PORTFOLIO_FILTERS: PortfolioFilters = {
  search: '', tenantId: 'all', domainType: 'all', dnsReadiness: 'all',
  sslReadiness: 'all', emailDns: 'all', security: 'all', risk: 'all',
  rawStatus: 'all', savedView: 'all',
};

// THE single predicate — drives the visible table, every card count, every
// saved-view count and every chip. Counts and rows can never diverge.
const matchesPortfolioFilter = (
  s: DomainPortfolioSignal,
  f: PortfolioFilters,
  statusById: Map<string, DomainStatus>,
): boolean => {
  if (!matchesSavedView(s, f.savedView, statusById)) return false;
  if (f.tenantId !== 'all' && s.tenantId !== f.tenantId) return false;
  if (f.domainType !== 'all' && s.domainType !== f.domainType) return false;
  if (f.dnsReadiness !== 'all' && s.dnsReadiness !== f.dnsReadiness) return false;
  if (f.sslReadiness !== 'all' && s.sslReadiness !== f.sslReadiness) return false;
  if (f.emailDns !== 'all' && s.emailDnsReadiness !== f.emailDns) return false;
  if (f.security !== 'all' && s.securityReadiness !== f.security) return false;
  if (f.risk !== 'all' && s.risk !== f.risk) return false;
  if (f.rawStatus !== 'all' && statusById.get(s.domainId) !== f.rawStatus) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${s.hostname} ${s.tenant} ${s.registrar} ${s.nextAction}`.toLowerCase();
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
  const [pFilters, setPFilters] = useState<PortfolioFilters>(EMPTY_PORTFOLIO_FILTERS);
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
        setPFilters(f => ({ ...f, rawStatus: statusParam as DomainStatus }));
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

  const tenantNameRecord = useMemo(() => {
    const r: Record<string, string> = {};
    tenants.forEach(t => { r[t.id] = t.name; });
    return r;
  }, []);

  const signals = useMemo(() => deriveDomainReadinessList(domains), [domains]);

  const signalById = useMemo(() => {
    const m = new Map<string, DomainReadinessSignal>();
    signals.forEach(s => m.set(s.id, s));
    return m;
  }, [signals]);

  const selected = useMemo(() => domains.find(d => d.id === selectedId) || null, [domains, selectedId]);
  const selectedSignal = selectedId ? signalById.get(selectedId) || null : null;

  // Phase 1.2F M1 — the portfolio dashboard + table run off the richer M0
  // portfolio signal. Built from the SAME `domains` store as the readiness
  // signals above, so the two views can never describe different domains.
  const portfolioSignals = useMemo(
    () => deriveDomainPortfolioSignals(domains, { domains, tenantNameById: tenantNameRecord }),
    [domains, tenantNameRecord],
  );

  // Underlying persisted DomainStatus by id — used by the raw-status deep-link
  // filter and the "Failed Verification" saved view (date-granular truth).
  const statusById = useMemo(() => {
    const m = new Map<string, DomainStatus>();
    domains.forEach(d => m.set(d.id, d.status));
    return m;
  }, [domains]);

  const visiblePortfolio = useMemo(
    () => portfolioSignals.filter(s => matchesPortfolioFilter(s, pFilters, statusById)),
    [portfolioSignals, pFilters, statusById],
  );

  // Locked no-drift contract: EVERY clickable card count, saved-view count and
  // the visible table all flow through the one `matchesPortfolioFilter`
  // predicate. `countWithFilters` counts the rows a given filter preset reveals,
  // so a card's number can never disagree with the table it produces on click.
  const countWithFilters = (partial: Partial<PortfolioFilters>) =>
    portfolioSignals.filter(s => matchesPortfolioFilter(s, { ...EMPTY_PORTFOLIO_FILTERS, ...partial }, statusById)).length;
  const countView = (view: PortfolioSavedView) => countWithFilters({ savedView: view });

  // Dashboard summary metrics. Clickable cards derive from `countWithFilters`
  // with the SAME preset they apply on click (Total, SSL Attention, Email DNS,
  // Security). Paired metrics (Root/Sub, Pending/Failed) are informational only
  // and never filter, so they carry no drift risk.
  const totalCount = countWithFilters({});
  const rootCount = countWithFilters({ domainType: 'root' });
  const subCount = countWithFilters({ domainType: 'subdomain' });
  const pendingCount = portfolioSignals.filter(s => { const st = statusById.get(s.domainId); return st === 'pending' || st === 'verifying'; }).length;
  const failedCount = countWithFilters({ rawStatus: 'failed' });
  const sslApplicable = portfolioSignals.filter(s => s.sslReadiness !== 'not_applicable');
  const sslReadyCount = sslApplicable.filter(s => s.sslReadiness === 'manual_ready').length;
  const sslReadyPct = sslApplicable.length === 0 ? 100 : Math.round((sslReadyCount / sslApplicable.length) * 100);
  const sslAttentionCount = countView('ssl_attention');
  const emailIncompleteCount = countView('email_incomplete');
  const securityAttentionCount = countWithFilters({ security: 'attention' });

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

  // Phase 1.2F M2 — the selected-domain Overview workspace runs off the SAME M0
  // derivation that produces the portfolio row (`deriveDomainPortfolioSignal`),
  // built from the SAME `domains` store and the SAME context shape (seed DNS /
  // registrar / security overlays). This is the no-drift contract: the DNS, SSL,
  // Email DNS, Security and Risk a row shows can never contradict the Overview it
  // opens. `auditRows` (mirrored + seed, category `domains`) feed the recent
  // activity / audit summary; the dependency on `auditTick` keeps it fresh after
  // a lifecycle mutation writes a new audit row.
  const selectedOverview = useMemo<DomainControlPanelOverview | null>(() => {
    if (!selected) return null;
    void auditTick;
    const auditRows = [...readMirroredAuditRows(), ...auditLogs]
      .filter(r => r.category === 'domains')
      .map(r => ({ id: r.id, date: r.date, actor: r.actor, action: r.action, target: r.target, tenantId: r.tenantId ?? null }));
    return deriveDomainControlPanelOverview(selected, { domains, tenantNameById: tenantNameRecord, auditRows });
  }, [selected, domains, tenantNameRecord, auditTick]);

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

  const patchFilter = (patch: Partial<PortfolioFilters>) => setPFilters(f => ({ ...f, ...patch }));
  const clearAll = () => setPFilters(EMPTY_PORTFOLIO_FILTERS);
  // Selecting a saved view resets the dimension filters so the view's standalone
  // count equals exactly what the table then shows (no invisible carry-over).
  const selectSavedView = (view: PortfolioSavedView) => setPFilters({ ...EMPTY_PORTFOLIO_FILTERS, savedView: view });

  const isDefaultView =
    pFilters.savedView === 'all' && !pFilters.search.trim() && pFilters.tenantId === 'all' &&
    pFilters.domainType === 'all' && pFilters.dnsReadiness === 'all' && pFilters.sslReadiness === 'all' &&
    pFilters.emailDns === 'all' && pFilters.security === 'all' && pFilters.risk === 'all' && pFilters.rawStatus === 'all';

  // Every active filter renders as a visible, clearable chip — no invisible
  // filters can ever hide rows (locked rule).
  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  if (pFilters.savedView !== 'all') activeChips.push({ key: 'savedView', label: `View: ${SAVED_VIEW_LABELS[pFilters.savedView]}`, clear: () => patchFilter({ savedView: 'all' }) });
  if (pFilters.search.trim()) activeChips.push({ key: 'search', label: `Search: "${pFilters.search.trim()}"`, clear: () => patchFilter({ search: '' }) });
  if (pFilters.tenantId !== 'all') activeChips.push({ key: 'tenantId', label: `Tenant: ${tenantName(pFilters.tenantId)}`, clear: () => patchFilter({ tenantId: 'all' }) });
  if (pFilters.domainType !== 'all') activeChips.push({ key: 'domainType', label: `Type: ${PORTFOLIO_TYPE_LABELS[pFilters.domainType]}`, clear: () => patchFilter({ domainType: 'all' }) });
  if (pFilters.dnsReadiness !== 'all') activeChips.push({ key: 'dns', label: `DNS: ${DOMAIN_DNS_READINESS_LABELS[pFilters.dnsReadiness]}`, clear: () => patchFilter({ dnsReadiness: 'all' }) });
  if (pFilters.sslReadiness !== 'all') activeChips.push({ key: 'ssl', label: `SSL: ${SSL_VIEW_STATUS_LABELS[pFilters.sslReadiness]}`, clear: () => patchFilter({ sslReadiness: 'all' }) });
  if (pFilters.emailDns !== 'all') activeChips.push({ key: 'email', label: `Email DNS: ${EMAIL_DNS_LABELS[pFilters.emailDns]}`, clear: () => patchFilter({ emailDns: 'all' }) });
  if (pFilters.security !== 'all') activeChips.push({ key: 'security', label: `Security: ${SECURITY_LEVEL_LABELS[pFilters.security]}`, clear: () => patchFilter({ security: 'all' }) });
  if (pFilters.risk !== 'all') activeChips.push({ key: 'risk', label: `Risk: ${RISK_LABELS[pFilters.risk]}`, clear: () => patchFilter({ risk: 'all' }) });
  if (pFilters.rawStatus !== 'all') activeChips.push({ key: 'rawStatus', label: `Status: ${STATUS_LABELS[pFilters.rawStatus]}`, clear: () => patchFilter({ rawStatus: 'all' }) });

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
          <h2 className="text-2xl font-black text-primary tracking-tight">Domain Portfolio</h2>
          <p className="text-slate-500 font-medium">Multi-tenant domain operations — registrar, DNS, SSL, email and security readiness at a glance.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <TruthLabel text={DOMAIN_MODEL_TRUTH_LABELS.noLiveDns} tone="amber" />
            <TruthLabel text={DOMAIN_MODEL_TRUTH_LABELS.sslManual} tone="slate" />
            <TruthLabel text={DOMAIN_MODEL_TRUTH_LABELS.registrarExternal} tone="slate" />
          </div>
        </div>
        {canManage ? (
          <button onClick={() => { setCreateError(null); resetDraft(); setShowCreate(true); }} className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl uppercase tracking-widest shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all cursor-pointer active:scale-95">+ Add Domain</button>
        ) : (
          <span className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 border border-slate-200 rounded-xl">Read-only — Manage Domain Lifecycle required</span>
        )}
      </div>

      {/* Portfolio summary cards — clickable cards apply the matching filter so
          a card's number always equals the rows it reveals (locked no-drift). */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard label="Total Managed Domains" value={totalCount} active={isDefaultView} onClick={clearAll} />
        <SummaryCard label="Root / Subdomains" value={`${rootCount} / ${subCount}`} sub="Root / Subdomain" />
        <SummaryCard label="Pending / Failed" value={`${pendingCount} / ${failedCount}`} sub="Verification status" tint="amber" />
        <SummaryCard label="SSL Needs Attention" value={sslAttentionCount} sub={`${sslReadyPct}% manual ready (${sslReadyCount}/${sslApplicable.length})`} tint={sslAttentionCount > 0 ? 'amber' : 'lime'} active={pFilters.savedView === 'ssl_attention'} onClick={() => selectSavedView('ssl_attention')} />
        <SummaryCard label="Email DNS Incomplete" value={emailIncompleteCount} tint="amber" active={pFilters.savedView === 'email_incomplete'} onClick={() => selectSavedView('email_incomplete')} />
        <SummaryCard label="Security Attention" value={securityAttentionCount} tint="red" active={pFilters.security === 'attention'} onClick={() => setPFilters({ ...EMPTY_PORTFOLIO_FILTERS, security: 'attention' })} />
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

      {/* Portfolio table — saved views, search, filters and chips all derive
          from ONE predicate over ONE signal array (locked no-drift). */}
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        {/* Saved views */}
        <div className="px-6 pt-5 flex flex-wrap gap-2">
          {SAVED_VIEW_ORDER.map(v => {
            const active = pFilters.savedView === v;
            return (
              <button key={v} onClick={() => selectSavedView(v)} className={`px-3 py-1.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all cursor-pointer inline-flex items-center gap-1.5 active:scale-95 ${active ? 'bg-primary text-white shadow-sm shadow-primary/20' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 hover:text-slate-700'}`}>
                {SAVED_VIEW_LABELS[v]}
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
                value={pFilters.search}
                onChange={e => patchFilter({ search: e.target.value })}
                placeholder="Search hostname, tenant, registrar…"
                className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-700 placeholder:text-slate-400 placeholder:font-medium"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <FilterSelect label="Tenant" value={pFilters.tenantId} onChange={v => patchFilter({ tenantId: v })} options={[['all', 'All tenants'], ...tenants.map(t => [t.id, t.name] as [string, string])]} />
            <FilterSelect label="Type" value={pFilters.domainType} onChange={v => patchFilter({ domainType: v as PortfolioFilters['domainType'] })} options={[['all', 'All types'], ...(Object.keys(PORTFOLIO_TYPE_LABELS) as DomainPortfolioType[]).map(k => [k, PORTFOLIO_TYPE_LABELS[k]] as [string, string])]} />
            <FilterSelect label="DNS" value={pFilters.dnsReadiness} onChange={v => patchFilter({ dnsReadiness: v as PortfolioFilters['dnsReadiness'] })} options={[['all', 'All DNS'], ...(Object.keys(DOMAIN_DNS_READINESS_LABELS) as DomainDnsReadiness[]).map(k => [k, DOMAIN_DNS_READINESS_LABELS[k]] as [string, string])]} />
            <FilterSelect label="SSL" value={pFilters.sslReadiness} onChange={v => patchFilter({ sslReadiness: v as PortfolioFilters['sslReadiness'] })} options={[['all', 'All SSL'], ...(Object.keys(SSL_VIEW_STATUS_LABELS) as SslViewStatus[]).map(k => [k, SSL_VIEW_STATUS_LABELS[k]] as [string, string])]} />
            <FilterSelect label="Email" value={pFilters.emailDns} onChange={v => patchFilter({ emailDns: v as PortfolioFilters['emailDns'] })} options={[['all', 'All email'], ...(Object.keys(EMAIL_DNS_LABELS) as EmailDnsStatus[]).map(k => [k, EMAIL_DNS_LABELS[k]] as [string, string])]} />
            <FilterSelect label="Security" value={pFilters.security} onChange={v => patchFilter({ security: v as PortfolioFilters['security'] })} options={[['all', 'All security'], ...(Object.keys(SECURITY_LEVEL_LABELS) as SecurityReadinessLevel[]).map(k => [k, SECURITY_LEVEL_LABELS[k]] as [string, string])]} />
            <FilterSelect label="Risk" value={pFilters.risk} onChange={v => patchFilter({ risk: v as PortfolioFilters['risk'] })} options={[['all', 'All risk'], ...(Object.keys(RISK_LABELS) as PortfolioRisk[]).map(k => [k, RISK_LABELS[k]] as [string, string])]} />
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
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Domain Portfolio</span>
          <span className="text-[10px] font-bold text-slate-400">{visiblePortfolio.length} matching</span>
        </div>

        {visiblePortfolio.length === 0 ? (
          <div className="px-8 py-16 text-center">
            <span className="material-symbols-outlined text-4xl text-slate-300">{portfolioSignals.length === 0 ? 'dns' : 'filter_alt_off'}</span>
            <p className="mt-3 text-sm font-black text-slate-600 uppercase tracking-widest">{portfolioSignals.length === 0 ? 'No domain records yet' : 'No domains match the active filters'}</p>
            <p className="mt-1 text-xs font-bold text-slate-400">{portfolioSignals.length === 0 ? 'Add a domain to start building the portfolio.' : 'Adjust or clear the filters above to widen the view.'}</p>
            {portfolioSignals.length > 0 && (
              <button onClick={clearAll} className="mt-4 px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-primary border border-primary/20 bg-primary/5 rounded-xl hover:bg-primary/10 transition-all cursor-pointer">Clear all filters</button>
            )}
          </div>
        ) : (
          // The table flows in the page (no nested vertical scroll). Horizontal
          // scroll is a graceful fallback only below the xl breakpoint; on desktop
          // the compacted columns fit without a horizontal scrollbar.
          <div className="overflow-x-auto xl:overflow-x-visible">
            <table className="w-full text-left border-collapse table-fixed">
              <colgroup>
                <col className="w-[15%]" />
                <col className="w-[7%]" />
                <col className="w-[9%]" />
                <col className="w-[11%]" />
                <col className="w-[7%]" />
                <col className="w-[7%]" />
                <col className="w-[6%]" />
                <col className="w-[7%]" />
                <col className="w-[8%]" />
                <col className="w-[6%]" />
                <col className="w-[10%]" />
                <col className="w-[7%]" />
              </colgroup>
              <thead className="bg-white">
                <tr className="text-[9px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-100 align-bottom">
                  <th className="px-3 py-3">Domain</th>
                  <th className="px-2 py-3">Type</th>
                  <th className="px-2 py-3">Tenant</th>
                  <th className="px-2 py-3">Registrar</th>
                  <th className="px-2 py-3">DNS</th>
                  <th className="px-2 py-3">SSL</th>
                  <th className="px-2 py-3">Email</th>
                  <th className="px-2 py-3">Security</th>
                  <th className="px-2 py-3">Renewal</th>
                  <th className="px-2 py-3">Risk</th>
                  <th className="px-2 py-3">Next Action</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visiblePortfolio.map(s => {
                  const isSel = selectedId === s.domainId;
                  return (
                    <tr key={s.domainId} onClick={() => setSelectedId(s.domainId)} className={`cursor-pointer transition-colors align-top ${isSel ? 'bg-primary/5' : 'hover:bg-slate-50/70'}`}>
                      <td className="px-3 py-3"><span className="text-[12px] font-bold text-slate-900 break-words leading-tight">{s.hostname}</span></td>
                      <td className="px-2 py-3"><span className={`inline-flex px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${PORTFOLIO_TYPE_TONE[s.domainType]}`}>{PORTFOLIO_TYPE_LABELS[s.domainType]}</span></td>
                      <td className="px-2 py-3"><span className="text-[11px] font-bold text-slate-600 break-words leading-tight">{s.tenant}</span></td>
                      <td className="px-2 py-3" title={s.registrar}>
                        {(() => {
                          const { name, context } = splitRegistrar(s.registrar);
                          return (
                            <>
                              <span className="block text-[11px] font-bold text-slate-700 leading-tight truncate">{name}</span>
                              {context && <span className="block text-[9px] font-bold text-slate-400 leading-tight truncate">{context}</span>}
                            </>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3"><PBadge tone={DNS_READINESS_TONE[s.dnsReadiness]}>{s.dnsReadinessLabel}</PBadge></td>
                      <td className="px-2 py-3"><PBadge tone={SSL_VIEW_TONE[s.sslReadiness]}>{SSL_VIEW_STATUS_LABELS[s.sslReadiness]}</PBadge></td>
                      <td className="px-2 py-3"><PBadge tone={EMAIL_DNS_TONE[s.emailDnsReadiness]}>{EMAIL_DNS_LABELS[s.emailDnsReadiness]}</PBadge></td>
                      <td className="px-2 py-3"><PBadge tone={SECURITY_LEVEL_TONE[s.securityReadiness]}>{SECURITY_LEVEL_LABELS[s.securityReadiness]}</PBadge></td>
                      <td className="px-2 py-3">
                        {s.renewalExpiryPlaceholder
                          ? <span className="block text-[11px] font-bold text-slate-600 leading-tight">{s.renewalExpiryPlaceholder}</span>
                          : <span className="block text-[12px] font-bold text-slate-400 leading-tight">—</span>}
                        <span className="mt-0.5 inline-flex px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-slate-400 bg-slate-100 rounded">Auto-renew future</span>
                      </td>
                      <td className="px-2 py-3"><PBadge tone={RISK_TONE[s.risk]}>{RISK_LABELS[s.risk]}</PBadge></td>
                      <td className="px-2 py-3"><span className="text-[11px] font-medium text-slate-500 break-words leading-tight">{s.nextAction}</span></td>
                      <td className="px-2 py-3 text-right">
                        <button onClick={e => { e.stopPropagation(); setSelectedId(s.domainId); }} className="inline-flex items-center gap-1 px-2 py-1.5 text-[9px] font-black uppercase tracking-widest text-primary border border-primary/20 bg-primary/5 rounded-lg hover:bg-primary/10 transition-all cursor-pointer whitespace-nowrap">
                          <span className="material-symbols-outlined text-[13px] leading-none">open_in_new</span>Open
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

      {/* Detail control panel — slide-over opened from a portfolio row */}
      <AnimatePresence>
        {selected && selectedSignal && selectedOverview && (
          <div className="fixed inset-0 z-50 flex justify-end">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedId(null)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 280 }} className="relative w-full max-w-xl h-full bg-white shadow-2xl border-l border-slate-200 overflow-y-auto">
              <DomainControlPanel
                selected={selected}
                signal={selectedSignal}
                overview={selectedOverview}
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

// Control panel (slide-over) for the selected domain.
// Renders the full operator surface: next action, root/subdomain relationships,
// readiness signals, security, checklist, registrar note, manual status/SSL
// workflow, required DNS records, quick actions, history, and metadata.
interface DomainControlPanelProps {
  selected: TenantDomainRecord;
  signal: DomainReadinessSignal;
  overview: DomainControlPanelOverview;
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

type DomainWorkspaceTab = 'overview' | 'dns' | 'ssl' | 'security' | 'troubleshoot';

const DOMAIN_WORKSPACE_TABS: { id: DomainWorkspaceTab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'dns', label: 'DNS', icon: 'dns' },
  { id: 'ssl', label: 'SSL/TLS', icon: 'lock' },
  { id: 'security', label: 'Security', icon: 'security' },
  { id: 'troubleshoot', label: 'Help', icon: 'help' },
];

// Phase 1.2F M2 — a single manual-readiness summary card (DNS / SSL / Email DNS
// / Security). Status, explanation, next action and the truth label all come
// from the M0 overview derivation, so a card can never claim a posture the
// portfolio row disagrees with.
const OverviewReadinessCard: React.FC<{
  icon: string;
  title: string;
  statusLabel: string;
  tone: ReadinessTone;
  explanation: string;
  nextAction: string;
  truthLabel: string;
}> = ({ icon, title, statusLabel, tone, explanation, nextAction, truthLabel }) => (
  <div className="rounded-2xl border border-slate-200 bg-white p-4 flex flex-col">
    <div className="flex items-start justify-between gap-2">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
        <span className="material-symbols-outlined text-sm text-slate-400">{icon}</span>{title}
      </p>
      <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[tone]}`}>{statusLabel}</span>
    </div>
    <p className="mt-2 text-[11px] font-medium text-slate-600 leading-snug">{explanation}</p>
    <div className="mt-2 pt-2 border-t border-slate-100">
      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Next action</p>
      <p className="text-[11px] font-bold text-slate-700 leading-snug mt-0.5">{nextAction}</p>
    </div>
    <p className="mt-2 text-[9px] font-medium text-slate-400 leading-tight">{truthLabel}</p>
  </div>
);

const DomainControlPanel: React.FC<DomainControlPanelProps> = ({
  selected, signal, overview, domains, canManage, tenantName, history, copied,
  onCopy, onSelect, onSetStatus, onSetSsl, onReenable, onConfirmDisable, onClose,
}) => {
  // Workspace tab is panel-local presentation state. It resets to Overview when
  // a different domain is selected so the operator always lands on the summary.
  const [activeTab, setActiveTab] = useState<DomainWorkspaceTab>('overview');
  useEffect(() => { setActiveTab('overview'); }, [selected.id]);

  // M2 workspace derivations — computed for the SELECTED domain only (kept out
  // of the shared readiness signal so posture/list/no-drift stay untouched).
  const sslWorkspace = deriveDomainSslWorkspace(selected);
  const troubleshooting = deriveDomainTroubleshooting(selected);
  const isCustom = selected.kind === 'custom';

  return (
  <>
    <div className="p-7 border-b border-slate-100 flex justify-between items-start">
      <div className="flex-1 pr-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Domain</p>
        <h3 className="text-lg font-black text-primary mt-1 break-all">{selected.hostname}</h3>
        <p className="text-xs text-slate-500 font-bold mt-1">{tenantName(selected.tenantId)} · {selected.kind}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${signal.role === 'root' ? 'bg-indigo-500/10 text-indigo-700 border-indigo-500/20' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>{DOMAIN_ROLE_LABELS[signal.role]}</span>
          <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${PORTFOLIO_TYPE_TONE[overview.domainType]}`}>{PORTFOLIO_TYPE_LABELS[overview.domainType]}</span>
          <span className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${LIFECYCLE_STYLES[signal.lifecycle]}`}>{signal.lifecycleLabel}</span>
        </div>
        {/* Manual readiness summary — DNS / SSL / Email DNS / Security, derived
            from the SAME M0 overview as the portfolio row (no drift). */}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[DNS_READINESS_TONE[overview.dnsReadiness]]}`}>DNS: {overview.dnsReadinessLabel}</span>
          <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[SSL_VIEW_TONE[overview.sslView.status]]}`}>SSL: {SSL_VIEW_STATUS_LABELS[overview.sslView.status]}</span>
          <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[EMAIL_DNS_TONE[overview.emailDns.overall]]}`}>Email: {EMAIL_DNS_LABELS[overview.emailDns.overall]}</span>
          <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[SECURITY_LEVEL_TONE[overview.security.overall]]}`}>Security: {SECURITY_LEVEL_LABELS[overview.security.overall]}</span>
        </div>
        <p className="mt-1.5 text-[9px] font-medium text-slate-400 leading-tight">{DOMAIN_MODEL_TRUTH_LABELS.noLiveDns}</p>
      </div>
      {onClose && (
        <button onClick={onClose} className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 shrink-0 cursor-pointer">
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      )}
    </div>

    {/* Workspace tab bar — Overview holds every mutation; the DNS / SSL /
        Security / Help workspaces are informational, copy, and guidance only. */}
    <div className="px-7 pt-4 border-b border-slate-100">
      <div className="flex flex-wrap gap-x-1 gap-y-0 -mb-px">
        {DOMAIN_WORKSPACE_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-1.5 px-2.5 py-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 whitespace-nowrap transition-colors cursor-pointer ${activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <span className="material-symbols-outlined text-sm">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
    </div>

    {activeTab === 'overview' && (
    <div className="p-7 space-y-6">
      {/* Next action — single recommended next step, derived by the M0 overview
          from the same DNS / SSL / Email / Security / Risk posture the portfolio
          row shows, so the two can never recommend contradictory actions. */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Next recommended action</p>
        <p className="text-sm font-black text-slate-800">{overview.nextAction}</p>
      </div>

      {/* Manual readiness summary cards — DNS / SSL / Email DNS / Security. Each
          card's status, explanation, next action and truth label come from the
          M0 overview derivation (intended-state / manual only; no live DNS, no
          SSL automation, no registrar integration). */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Manual readiness summary</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <OverviewReadinessCard
            icon="dns"
            title="DNS"
            statusLabel={overview.dnsReadinessLabel}
            tone={DNS_READINESS_TONE[overview.dnsReadiness]}
            explanation={DOMAIN_DNS_READINESS_DETAIL[overview.dnsReadiness]}
            nextAction={overview.troubleshooting.recommendedNextAction}
            truthLabel={DOMAIN_MODEL_TRUTH_LABELS.intendedState}
          />
          <OverviewReadinessCard
            icon="lock"
            title="SSL / TLS"
            statusLabel={SSL_VIEW_STATUS_LABELS[overview.sslView.status]}
            tone={SSL_VIEW_TONE[overview.sslView.status]}
            explanation={overview.sslView.issueReason ?? 'Manual SSL readiness is tracked here. Certificate issuance and renewal automation are future.'}
            nextAction={overview.sslView.nextAction}
            truthLabel={overview.sslView.truthLabel}
          />
          <OverviewReadinessCard
            icon="mail"
            title="Email DNS"
            statusLabel={EMAIL_DNS_LABELS[overview.emailDns.overall]}
            tone={EMAIL_DNS_TONE[overview.emailDns.overall]}
            explanation="Derived from the intended-state email records (MX / SPF / DKIM / DMARC). Sending and deliverability are not checked live."
            nextAction={overview.emailDns.nextAction}
            truthLabel={overview.emailDns.truthLabel}
          />
          <OverviewReadinessCard
            icon="security"
            title="Security"
            statusLabel={SECURITY_LEVEL_LABELS[overview.security.overall]}
            tone={SECURITY_LEVEL_TONE[overview.security.overall]}
            explanation="Manual security posture (CAA + registrar controls). DNSSEC, domain lock and transfer protection are future / not active."
            nextAction={overview.security.nextAction}
            truthLabel={overview.security.truthLabel}
          />
        </div>
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
            // Related subdomains come from the M0 overview so the count and the
            // lifecycle label per child match the portfolio view exactly.
            const children = overview.relatedSubdomains;
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
                    <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${LIFECYCLE_STYLES[c.lifecycle]}`}>{c.lifecycleLabel}</span>
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

      {/* Risk assessment — overall risk plus the contributing readiness signals,
          all from the M0 overview (same risk the portfolio row reflects). */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Risk assessment</p>
        {overview.riskReasons.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-lime-400/20 bg-lime-400/10 text-[11px] font-bold text-lime-700">
            <span className="material-symbols-outlined text-sm">check_circle</span>
            No outstanding readiness risks for this domain.
          </div>
        ) : (
          <div className="space-y-1.5">
            {overview.riskReasons.map(r => (
              <div key={r.code} className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[11px] font-bold ${r.tone === 'critical' ? 'bg-red-500/10 text-red-700 border-red-500/20' : r.tone === 'warn' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                <span className="material-symbols-outlined text-sm">{r.tone === 'critical' ? 'error' : r.tone === 'warn' ? 'warning' : 'info'}</span>
                {r.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual action checklist — read-only guidance, no automation */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Action checklist</p>
        <div className="space-y-1.5">
          {overview.manualChecklist.map(item => (
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

      {/* Recent activity — recorded domain lifecycle events (date-granular) */}
      <div className="pt-2 border-t border-slate-100">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Recent activity</p>
        {history.length === 0 ? (
          <p className="text-[11px] font-bold text-slate-400">No recorded activity for this domain.</p>
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
        <p className="text-[9px] text-slate-400 font-medium mt-2 leading-tight">Recorded domain lifecycle events for this exact hostname. Audit is date-granular — no sub-day timestamp.</p>
      </div>

      <div className="text-[10px] text-slate-400 grid grid-cols-2 gap-2 pt-4 border-t border-slate-100">
        <div>Created: <span className="font-bold text-slate-600">{selected.createdAt}</span></div>
        <div>Verified: <span className="font-bold text-slate-600">{selected.verifiedAt || '—'}</span></div>
        <div className="col-span-2">Last checked: <span className="font-bold text-slate-600">{selected.lastCheckedAt || '—'}</span></div>
        <div className="col-span-2 font-mono">id: {selected.id}</div>
        <div className="col-span-2 text-slate-400 font-medium">{signal.truthLabel}</div>
      </div>
    </div>
    )}

    {activeTab === 'dns' && (
    <div className="p-7 space-y-6">
      {/* DNS readiness banner */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">DNS readiness</p>
        <div className="px-3 py-2.5 rounded-xl border border-slate-100 bg-slate-50/60 flex items-start justify-between gap-3">
          <p className="text-[11px] font-medium text-slate-500 flex-1">{DOMAIN_DNS_READINESS_DETAIL[signal.dnsReadiness]}</p>
          <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[DNS_READINESS_TONE[signal.dnsReadiness]]}`}>{signal.dnsReadinessLabel}</span>
        </div>
      </div>

      {/* Required DNS records workspace */}
      {signal.requiredRecords.length > 0 ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Required DNS records</p>
            <button onClick={() => onCopy(formatAllDnsRecords(signal.requiredRecords), 'dns-all')} className="text-[10px] font-black uppercase tracking-widest text-primary hover:opacity-80 transition-opacity cursor-pointer">{copied === 'dns-all' ? 'Copied!' : 'Copy all'}</button>
          </div>
          <p className="text-[11px] text-amber-700 font-bold mb-3">Configure these at the customer's DNS provider, then mark the domain verified from Overview once you've manually confirmed propagation. <span className="font-medium text-slate-500">{DOMAIN_TRUTH_LABELS.manual}</span></p>
          <div className="space-y-2">
            {signal.requiredRecords.map((rec, i) => (
              <DnsBlock key={i} type={rec.type} host={rec.host} value={rec.value} purpose={rec.purpose} onCopy={() => onCopy(formatDnsRecord(rec), `rec${i}`)} copied={copied === `rec${i}`} />
            ))}
          </div>
        </div>
      ) : (
        <div className="px-3 py-3 rounded-xl bg-slate-50 border border-dashed border-slate-200">
          <p className="text-[11px] font-bold text-slate-500">{selected.status === 'disabled' ? 'This domain is disabled — DNS configuration is not applicable.' : 'No customer DNS records are required. This subdomain is provisioned automatically under the platform apex.'}</p>
        </div>
      )}

      {/* Propagation guidance (manual, custom domains only) */}
      {isCustom && selected.status !== 'disabled' && (
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Propagation guidance</p>
          <ol className="space-y-1.5">
            {DOMAIN_PROPAGATION_STEPS.map((step, i) => (
              <li key={i} className="flex items-start gap-2.5 px-3 py-2 rounded-xl border border-slate-100 bg-slate-50/60">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-black flex items-center justify-center">{i + 1}</span>
                <span className="text-[11px] font-medium text-slate-600 flex-1">{step}</span>
              </li>
            ))}
          </ol>
          <p className="text-[10px] text-slate-400 font-medium mt-2">{DOMAIN_TRUTH_LABELS.ruleBased}</p>
        </div>
      )}

      {/* Registrar vs. app configuration explanation */}
      <div className="px-3 py-2.5 rounded-xl bg-amber-400/5 border border-amber-400/20">
        <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1 flex items-center gap-1"><span className="material-symbols-outlined text-[13px]">dns</span> Registrar &amp; DNS provider</p>
        <p className="text-[11px] font-bold text-slate-600">{DOMAIN_TRUTH_LABELS.registrarExternal}</p>
      </div>
    </div>
    )}

    {activeTab === 'ssl' && (
    <div className="p-7 space-y-6">
      {/* SSL/TLS readiness state */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">SSL / TLS readiness</p>
        <div className="px-3 py-2.5 rounded-xl border border-slate-100 bg-slate-50/60 flex items-start justify-between gap-3">
          <p className="text-[11px] font-medium text-slate-500 flex-1">{sslWorkspace.explanation}</p>
          <span className={`shrink-0 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${SSL_READINESS_STYLES[sslWorkspace.readiness]}`}>{sslWorkspace.readinessLabel}</span>
        </div>
      </div>

      {/* SSL/TLS manual steps */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Path to SSL ready</p>
        <div className="space-y-1.5">
          {sslWorkspace.steps.map(step => (
            <div key={step.key} className="flex items-start gap-2.5 px-3 py-2 rounded-xl border border-slate-100 bg-slate-50/60">
              <span className={`material-symbols-outlined text-base mt-px ${CHECKLIST_TONE[step.state].icon}`}>{CHECKLIST_TONE[step.state].symbol}</span>
              <p className={`text-[11px] font-bold flex-1 ${step.state === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{step.label}</p>
              {step.state === 'current' && <span className="text-[9px] font-black uppercase tracking-widest text-primary shrink-0 mt-0.5">Now</span>}
            </div>
          ))}
        </div>
        {canManage && selected.status !== 'disabled' && (
          <p className="text-[10px] font-medium text-slate-400 mt-2">Set the SSL state from <span className="font-bold text-slate-500">Overview</span> once the certificate is confirmed.</p>
        )}
        <p className="text-[10px] text-slate-400 font-medium mt-1">{sslWorkspace.truthLabel}</p>
      </div>
    </div>
    )}

    {activeTab === 'security' && (
    <div className="p-7 space-y-6">
      {/* Security readiness panel — DNS readiness + SSL (live), plus future
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

      {/* Registrar vs. app configuration explanation */}
      <div className="px-3 py-2.5 rounded-xl bg-amber-400/5 border border-amber-400/20">
        <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest mb-1 flex items-center gap-1"><span className="material-symbols-outlined text-[13px]">dns</span> Registrar &amp; DNS provider</p>
        <p className="text-[11px] font-bold text-slate-600">{DOMAIN_TRUTH_LABELS.registrarExternal}</p>
      </div>
    </div>
    )}

    {activeTab === 'troubleshoot' && (
    <div className="p-7 space-y-6">
      {/* Troubleshooting — rule-based symptom/guidance for the current state */}
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Troubleshooting</p>
        <div className="space-y-2">
          {troubleshooting.map(item => (
            <div key={item.key} className={`px-3 py-2.5 rounded-xl border ${item.tone === 'critical' ? 'bg-red-500/5 border-red-500/20' : item.tone === 'warn' ? 'bg-amber-400/5 border-amber-400/20' : 'bg-slate-50/60 border-slate-100'}`}>
              <p className={`text-[11px] font-black flex items-center gap-1.5 ${item.tone === 'critical' ? 'text-red-700' : item.tone === 'warn' ? 'text-amber-700' : 'text-slate-700'}`}>
                <span className="material-symbols-outlined text-sm">{item.tone === 'critical' ? 'error' : item.tone === 'warn' ? 'warning' : 'info'}</span>
                {item.symptom}
              </p>
              <p className="text-[11px] font-medium text-slate-500 mt-1">{item.guidance}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Propagation guidance recap (manual, custom domains only) */}
      {isCustom && selected.status !== 'disabled' && (
        <div>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">How to confirm propagation</p>
          <ol className="space-y-1.5">
            {DOMAIN_PROPAGATION_STEPS.map((step, i) => (
              <li key={i} className="flex items-start gap-2.5 px-3 py-2 rounded-xl border border-slate-100 bg-slate-50/60">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-black flex items-center justify-center">{i + 1}</span>
                <span className="text-[11px] font-medium text-slate-600 flex-1">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="text-[10px] text-slate-400 font-medium">{DOMAIN_TRUTH_LABELS.manual}</p>
    </div>
    )}
  </>
  );
};

const TruthLabel: React.FC<{ text: string; tone: 'amber' | 'slate' }> = ({ text, tone }) => (
  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold border ${tone === 'amber' ? 'bg-amber-400/10 text-amber-700 border-amber-400/20' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
    <span className="material-symbols-outlined text-[12px]">info</span>
    {text}
  </span>
);

// Phase 1.2F M1 — portfolio summary card (single or paired metric). Clickable
// when an onClick is supplied; otherwise renders as a static metric.
const SummaryCard: React.FC<{ label: string; value: React.ReactNode; sub?: string; tint?: 'lime' | 'amber' | 'red'; active?: boolean; onClick?: () => void }> = ({ label, value, sub, tint, active, onClick }) => {
  const tintCls = tint === 'lime' ? 'text-lime-700' : tint === 'amber' ? 'text-amber-700' : tint === 'red' ? 'text-red-700' : 'text-primary';
  const clickable = !!onClick;
  return (
    <button onClick={onClick} disabled={!clickable} className={`text-left bg-white/80 backdrop-blur-xl p-5 rounded-3xl border shadow-sm transition-all ${clickable ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 active:scale-[0.98]' : 'cursor-default'} ${active ? 'border-primary ring-2 ring-primary/20' : 'border-slate-200'}`}>
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-2xl font-black mt-1 ${tintCls}`}>{value}</p>
      {sub && <p className="text-[10px] font-bold text-slate-400 mt-0.5">{sub}</p>}
    </button>
  );
};

// Small readiness badge used across the portfolio table cells.
const PBadge: React.FC<{ tone: ReadinessTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-flex px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md border ${READINESS_TONE_STYLES[tone]}`}>{children}</span>
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
