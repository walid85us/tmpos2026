// ===========================================================================
// Phase 1.2 — Domains Maturity Foundation (Milestone 1)
// ===========================================================================
//
// Deterministic, rule-based domain lifecycle / readiness / posture helpers for
// the System Owner Domains surface. This module is intentionally SEPARATE from
// `platformOpsDerive.ts` (the locked Advanced Command Center Intelligence
// source of truth) — the same discipline used for the Audit Investigation
// Center (`platformOpsInvestigation.ts`). It reuses the existing domain data
// model (`TenantDomainRecord` + `DomainStatus` / `DomainSslStatus` /
// `DomainKind`) from `mockData.ts` and never mutates state or pushes audit.
//
// TRUTH CONSTRAINTS (do not violate):
//   - There is NO real DNS lookup, NO real SSL/TLS issuance, NO real domain
//     provisioning, and NO external provider API. Every "readiness" value here
//     is RULE-BASED from the current app/session domain records only.
//   - Verification is MANUAL. A System Owner manually flips status/SSL after
//     confirming propagation out-of-band. These helpers only describe what the
//     stored record implies — they never claim a live check happened.
//   - Required DNS records are TEMPLATES the operator copies to a DNS provider,
//     not records this app reads back.
//   - Real provider integrations (auto DNS verification, ACM-style SSL issue)
//     are future Phase 2.
//
// Everything below is pure: helpers take records and return derived data.
// ===========================================================================

import type {
  TenantDomainRecord,
  DomainStatus,
  DomainSslStatus,
  DomainKind,
  DomainRole,
} from './mockData';

export type { DomainStatus, DomainSslStatus, DomainKind, DomainRole };

// ---------------------------------------------------------------------------
// Hierarchy role — root/apex vs subdomain. Derived, never replacing the raw
// persisted fields. `domainRole`/`parentDomainId` (when present) win; legacy
// records fall back to `kind` (a platform `subdomain` is a subdomain of the
// platform apex; a `custom` record with no parent is treated as a root).
// ---------------------------------------------------------------------------

export const DOMAIN_ROLE_LABELS: Record<DomainRole, string> = {
  root: 'Root / Main',
  subdomain: 'Subdomain',
};

// The platform apex that auto-provisioned `kind: 'subdomain'` records live
// under. There is NO managed record for this apex — it is the platform's own
// root, shown as the (non-clickable) parent of platform subdomains.
export const PLATFORM_ROOT_SUFFIX = 'repairplatform.com';

export function deriveDomainRole(d: TenantDomainRecord): DomainRole {
  if (d.domainRole) return d.domainRole;
  if (d.parentDomainId) return 'subdomain';
  // Platform-provisioned subdomains are subdomains of the platform apex.
  if (d.kind === 'subdomain') return 'subdomain';
  // A custom record with no parent is an apex/root domain.
  return 'root';
}

// For a subdomain, returns the parent root hostname DERIVED from the hostname
// (everything after the first DNS label). Used as a display fallback when the
// parent is the platform apex (no managed record) or the managed parent is
// missing. Returns null when the hostname has no parent label.
export function deriveParentRootHostname(d: TenantDomainRecord): string | null {
  const parts = d.hostname.split('.');
  // <=2 labels means it is itself an apex (e.g. techrepair.pro) — no parent.
  if (parts.length <= 2) return null;
  return parts.slice(1).join('.');
}

// ---------------------------------------------------------------------------
// Normalized lifecycle — a DISPLAY-LEVEL view derived from the raw
// (status, ssl, kind) triple. The raw `DomainStatus` / `DomainSslStatus` stay
// the persisted source of truth (consumed by Command Center intelligence and
// the audit trail); this normalization never replaces them.
// ---------------------------------------------------------------------------

export type DomainLifecycleStatus =
  | 'draft'                // reserved: explicit pre-DNS draft (see note below)
  | 'pending_dns'          // custom domain awaiting DNS records being added
  | 'pending_verification' // records added, awaiting manual verification
  | 'verified'             // verified, SSL not started yet
  | 'ssl_pending'          // verified, SSL issuance/renewal still pending
  | 'ssl_ready'            // verified + SSL active = fully ready
  | 'failed'               // verification failed
  | 'disabled';            // intentionally disabled

export const DOMAIN_LIFECYCLE_LABELS: Record<DomainLifecycleStatus, string> = {
  draft: 'Draft',
  pending_dns: 'Pending DNS',
  pending_verification: 'Pending Verification',
  verified: 'Verified',
  ssl_pending: 'SSL Pending',
  ssl_ready: 'SSL Ready',
  failed: 'Failed',
  disabled: 'Disabled',
};

// Ordered for board columns / status tabs (M2 consumes this).
export const DOMAIN_LIFECYCLE_ORDER: DomainLifecycleStatus[] = [
  'draft',
  'pending_dns',
  'pending_verification',
  'verified',
  'ssl_pending',
  'ssl_ready',
  'failed',
  'disabled',
];

// NOTE on 'draft': the current persistence model has no explicit pre-DNS draft
// flag, so `deriveDomainLifecycle` does not currently emit 'draft'. It is kept
// in the union + label/order maps so the documented lifecycle vocabulary is
// complete and a future explicit-draft state has a home with no model churn.

export function deriveDomainLifecycle(d: TenantDomainRecord): DomainLifecycleStatus {
  if (d.status === 'disabled') return 'disabled';
  if (d.status === 'failed') return 'failed';
  if (d.status === 'pending') {
    // Subdomains are auto-provisioned and rarely sit at 'pending'; when they do
    // there are no DNS records to add, so it's a verification wait.
    return d.kind === 'custom' ? 'pending_dns' : 'pending_verification';
  }
  if (d.status === 'verifying') return 'pending_verification';
  // status === 'verified'
  if (d.ssl === 'active') return 'ssl_ready';
  if (d.ssl === 'pending' || d.ssl === 'failed') return 'ssl_pending';
  // ssl === 'none'
  return 'verified';
}

// ---------------------------------------------------------------------------
// SSL/TLS readiness — normalized, rule-based.
// ---------------------------------------------------------------------------

export type DomainSslReadiness =
  | 'not_applicable' // disabled domain — SSL not relevant
  | 'not_started'    // verified but SSL never started
  | 'pending'        // SSL issuance/renewal pending
  | 'failed'         // SSL marked failed
  | 'ready';         // SSL active

export const DOMAIN_SSL_READINESS_LABELS: Record<DomainSslReadiness, string> = {
  not_applicable: 'Not applicable',
  not_started: 'Not started',
  pending: 'Pending',
  failed: 'Failed',
  ready: 'Ready',
};

export function deriveDomainSslReadiness(d: TenantDomainRecord): DomainSslReadiness {
  if (d.status === 'disabled') return 'not_applicable';
  switch (d.ssl) {
    case 'active': return 'ready';
    case 'pending': return 'pending';
    case 'failed': return 'failed';
    case 'none':
    default:
      // Only meaningful once a domain is verified; before that SSL hasn't begun.
      return d.status === 'verified' ? 'not_started' : 'not_started';
  }
}

// ---------------------------------------------------------------------------
// DNS readiness — a SEPARATE concept from SSL readiness, describing how far the
// domain's DNS configuration has progressed. Rule-based from the persisted
// status/kind; never a live DNS lookup. Platform subdomains are managed by the
// platform apex (no customer DNS action), custom domains move through
// not-configured → propagating → confirmed.
// ---------------------------------------------------------------------------

export type DomainDnsReadiness =
  | 'managed'         // platform subdomain — DNS handled by the platform apex
  | 'not_configured'  // custom, pending — required records not yet added
  | 'propagating'     // custom, verifying — records added, awaiting confirmation
  | 'confirmed'       // custom, verified+ — manually confirmed propagated
  | 'failed'          // custom, failed — verification failed
  | 'not_applicable'; // disabled domain

export const DOMAIN_DNS_READINESS_LABELS: Record<DomainDnsReadiness, string> = {
  managed: 'Managed',
  not_configured: 'Not configured',
  propagating: 'Propagating',
  confirmed: 'Confirmed',
  failed: 'Failed',
  not_applicable: 'Not applicable',
};

export function deriveDomainDnsReadiness(d: TenantDomainRecord): DomainDnsReadiness {
  if (d.status === 'disabled') return 'not_applicable';
  if (d.kind !== 'custom') return 'managed';
  switch (d.status) {
    case 'failed': return 'failed';
    case 'pending': return 'not_configured';
    case 'verifying': return 'propagating';
    case 'verified': return 'confirmed';
    default: return 'not_configured';
  }
}

// ---------------------------------------------------------------------------
// Security & readiness indicators — the Domain Control Panel surface. SSL maps
// to the LIVE recorded readiness; DNSSEC, domain lock, and transfer protection
// are FUTURE/registrar-level concepts shown as readiness placeholders only.
// There is NO real DNSSEC, no registrar lock, and no transfer integration —
// these never claim a live check happened.
// ---------------------------------------------------------------------------

export type SecurityReadinessState =
  | 'ready'
  | 'pending'
  | 'failed'
  | 'not_started'
  | 'not_applicable'
  | 'future';

export const SECURITY_READINESS_LABELS: Record<SecurityReadinessState, string> = {
  ready: 'Ready',
  pending: 'Pending',
  failed: 'Failed',
  not_started: 'Not started',
  not_applicable: 'Not applicable',
  future: 'Future',
};

export interface DomainSecurityIndicator {
  key: 'ssl' | 'dnssec' | 'domain_lock' | 'transfer_protection';
  label: string;
  state: SecurityReadinessState;
  detail: string;
  /** True when this is a future/registrar-level placeholder, not a live signal. */
  future: boolean;
}

export function deriveDomainSecurityIndicators(d: TenantDomainRecord): DomainSecurityIndicator[] {
  const ssl = deriveDomainSslReadiness(d);
  const sslState: SecurityReadinessState =
    ssl === 'ready' ? 'ready'
    : ssl === 'pending' ? 'pending'
    : ssl === 'failed' ? 'failed'
    : ssl === 'not_applicable' ? 'not_applicable'
    : 'not_started';
  return [
    {
      key: 'ssl',
      label: 'SSL / TLS certificate',
      state: sslState,
      detail: 'Reflects the recorded SSL status. Manual — no real certificate is issued or checked.',
      future: false,
    },
    {
      key: 'dnssec',
      label: 'DNSSEC',
      state: 'future',
      detail: 'DNSSEC signing is a future readiness indicator — not configured or checked by this app.',
      future: true,
    },
    {
      key: 'domain_lock',
      label: 'Domain lock',
      state: 'future',
      detail: 'Registrar-level domain lock is managed outside this app — future readiness indicator only.',
      future: true,
    },
    {
      key: 'transfer_protection',
      label: 'Transfer protection',
      state: 'future',
      detail: 'Transfer protection is a registrar control — future readiness indicator only.',
      future: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Manual action checklist — derived, read-only guidance for moving a domain
// through its lifecycle. Each step maps to a manual operator action (or an
// existing quick action). NOTHING here performs a real check, DNS lookup, or
// provider call; steps are truth-labeled as manual.
// ---------------------------------------------------------------------------

export type DomainChecklistState = 'done' | 'current' | 'todo' | 'future' | 'not_applicable';

export interface DomainChecklistItem {
  key: string;
  label: string;
  state: DomainChecklistState;
  hint?: string;
}

export function deriveDomainChecklist(d: TenantDomainRecord): DomainChecklistItem[] {
  if (d.status === 'disabled') {
    return [
      { key: 'reenable', label: 'Re-enable the domain to resume routing', state: 'current', hint: 'Disabled domains are excluded from routing until re-enabled.' },
    ];
  }
  // Platform subdomains are auto-provisioned — no customer DNS action.
  if (d.kind !== 'custom') {
    return [
      { key: 'provisioned', label: 'Platform subdomain provisioned automatically', state: 'done' },
      { key: 'ssl', label: 'SSL active on the shared platform certificate', state: d.ssl === 'active' ? 'done' : 'current' },
    ];
  }
  if (d.status === 'failed') {
    return [
      { key: 'resolve', label: 'Resolve the failed verification, then re-check DNS', state: 'current', hint: 'Re-confirm the DNS records at the provider before re-attempting verification.' },
      { key: 'verify', label: 'Mark verified once DNS is confirmed', state: 'todo' },
      { key: 'ssl_ready', label: 'Review SSL readiness and mark SSL ready', state: 'todo' },
    ];
  }
  const lifecycle = deriveDomainLifecycle(d);
  const dnsAdded = lifecycle !== 'pending_dns';
  const verified = lifecycle === 'verified' || lifecycle === 'ssl_pending' || lifecycle === 'ssl_ready';
  const sslReady = lifecycle === 'ssl_ready';
  return [
    { key: 'add_dns', label: 'Add the required DNS records at the provider', state: dnsAdded ? 'done' : 'current' },
    { key: 'propagate', label: 'Confirm DNS has propagated externally', state: verified ? 'done' : dnsAdded ? 'current' : 'todo', hint: 'Use an external DNS lookup — this app does not check propagation.' },
    { key: 'verify', label: 'Mark the domain verified', state: verified ? 'done' : dnsAdded ? 'current' : 'todo' },
    { key: 'ssl_review', label: 'Review SSL readiness', state: sslReady ? 'done' : verified ? 'current' : 'todo' },
    { key: 'ssl_ready', label: 'Mark SSL ready when the certificate is active', state: sslReady ? 'done' : verified ? 'current' : 'todo' },
  ];
}

// ---------------------------------------------------------------------------
// Required DNS records — TEMPLATES the operator copies to a DNS provider.
// These mirror the values the Domains drawer already displays so M2 can render
// from one source instead of re-deriving inline.
// ---------------------------------------------------------------------------

export type DomainRecordType = 'CNAME' | 'TXT' | 'A';

export interface DomainRequiredRecord {
  type: DomainRecordType;
  host: string;
  value: string;
  purpose: string;
}

// Centralized DNS targets (kept here so the page and helpers cannot drift).
export const DOMAIN_PROXY_TARGET = 'proxy.repairplatform.com';
export const DOMAIN_TXT_PREFIX = '_repairplatform';

export function deriveDomainRequiredRecords(d: TenantDomainRecord): DomainRequiredRecord[] {
  // Platform subdomains are auto-provisioned; no customer DNS action is needed.
  if (d.kind !== 'custom') return [];
  return [
    {
      type: 'CNAME',
      host: d.hostname,
      value: DOMAIN_PROXY_TARGET,
      purpose: 'Routes the custom domain to the platform edge.',
    },
    {
      type: 'TXT',
      host: `${DOMAIN_TXT_PREFIX}.${d.hostname}`,
      value: `verify=${d.id}`,
      purpose: 'Proves domain ownership for manual verification.',
    },
  ];
}

export function formatDnsRecord(r: DomainRequiredRecord): string {
  return `${r.host} ${r.type} ${r.value}`;
}

// ---------------------------------------------------------------------------
// Risk reasons — rule-based explanations of why a domain needs attention.
// ---------------------------------------------------------------------------

export type DomainRiskReasonCode =
  | 'verification_failed'
  | 'ssl_failed'
  | 'pending_dns'
  | 'awaiting_verification'
  | 'ssl_pending'
  | 'disabled';

export interface DomainRiskReason {
  code: DomainRiskReasonCode;
  label: string;
  tone: 'critical' | 'warn' | 'info';
}

export function deriveDomainRiskReasons(d: TenantDomainRecord): DomainRiskReason[] {
  const reasons: DomainRiskReason[] = [];
  if (d.status === 'failed') {
    reasons.push({ code: 'verification_failed', label: 'Verification failed', tone: 'critical' });
  }
  if (d.status !== 'disabled' && d.ssl === 'failed') {
    reasons.push({ code: 'ssl_failed', label: 'SSL marked failed', tone: 'critical' });
  }
  if (d.status === 'pending' && d.kind === 'custom') {
    reasons.push({ code: 'pending_dns', label: 'DNS records not yet added', tone: 'warn' });
  }
  if (d.status === 'verifying' || (d.status === 'pending' && d.kind === 'subdomain')) {
    reasons.push({ code: 'awaiting_verification', label: 'Awaiting manual verification', tone: 'warn' });
  }
  if (d.status === 'verified' && d.ssl === 'pending') {
    reasons.push({ code: 'ssl_pending', label: 'SSL issuance pending', tone: 'info' });
  }
  if (d.status === 'disabled') {
    reasons.push({ code: 'disabled', label: 'Domain disabled', tone: 'info' });
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Next recommended action + truth labels.
// ---------------------------------------------------------------------------

export function getDomainActionLabel(d: TenantDomainRecord): string {
  const lifecycle = deriveDomainLifecycle(d);
  switch (lifecycle) {
    case 'pending_dns': return 'Add DNS records, then mark verified';
    case 'pending_verification': return 'Confirm DNS propagation, then mark verified';
    case 'failed': return 'Re-check DNS and re-attempt verification';
    case 'verified': return 'Issue SSL, then mark SSL active';
    case 'ssl_pending': return d.ssl === 'failed' ? 'Re-issue SSL, then mark SSL active' : 'Confirm SSL issuance, then mark SSL active';
    case 'disabled': return 'Re-enable if the tenant is active again';
    case 'ssl_ready': return 'No action needed';
    case 'draft': return 'Add DNS records to begin verification';
    default: return 'No action needed';
  }
}

export const DOMAIN_TRUTH_LABELS = {
  manual: 'Manual verification only — no real DNS lookup or SSL automation.',
  ruleBased: 'DNS/SSL readiness is rule-based from current app/session records.',
  futureProvider: 'Provider integrations are future Phase 2.',
  registrarExternal: 'Registrar ownership and DNS provider configuration are managed outside this app in this phase.',
  futureSecurity: 'DNSSEC, domain lock, and transfer protection are future readiness indicators — not configured or checked by this app.',
} as const;

export function getDomainTruthLabel(d: TenantDomainRecord): string {
  // Custom domains carry the most "this is manual" weight; subdomains are
  // auto-provisioned but still rule-based, never live-checked.
  return d.kind === 'custom' ? DOMAIN_TRUTH_LABELS.manual : DOMAIN_TRUTH_LABELS.ruleBased;
}

// ---------------------------------------------------------------------------
// Per-domain readiness signal — the unit M2's list/drawer/cards consume.
// ---------------------------------------------------------------------------

export interface DomainReadinessSignal {
  id: string;
  tenantId: string;
  hostname: string;
  kind: DomainKind;
  role: DomainRole;
  parentDomainId: string | null;
  rawStatus: DomainStatus;
  rawSsl: DomainSslStatus;
  lifecycle: DomainLifecycleStatus;
  lifecycleLabel: string;
  sslReadiness: DomainSslReadiness;
  sslReadinessLabel: string;
  dnsReadiness: DomainDnsReadiness;
  dnsReadinessLabel: string;
  securityIndicators: DomainSecurityIndicator[];
  checklist: DomainChecklistItem[];
  requiredRecords: DomainRequiredRecord[];
  riskReasons: DomainRiskReason[];
  issueCount: number;
  // True when the domain needs operator attention (not fully ready / disabled).
  needsAction: boolean;
  nextAction: string;
  truthLabel: string;
  createdAt: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
}

export function deriveDomainReadiness(d: TenantDomainRecord): DomainReadinessSignal {
  const lifecycle = deriveDomainLifecycle(d);
  const sslReadiness = deriveDomainSslReadiness(d);
  const riskReasons = deriveDomainRiskReasons(d);
  const needsAction = lifecycle !== 'ssl_ready' && lifecycle !== 'disabled';
  return {
    id: d.id,
    tenantId: d.tenantId,
    hostname: d.hostname,
    kind: d.kind,
    role: deriveDomainRole(d),
    parentDomainId: d.parentDomainId ?? null,
    rawStatus: d.status,
    rawSsl: d.ssl,
    lifecycle,
    lifecycleLabel: DOMAIN_LIFECYCLE_LABELS[lifecycle],
    sslReadiness,
    sslReadinessLabel: DOMAIN_SSL_READINESS_LABELS[sslReadiness],
    dnsReadiness: deriveDomainDnsReadiness(d),
    dnsReadinessLabel: DOMAIN_DNS_READINESS_LABELS[deriveDomainDnsReadiness(d)],
    securityIndicators: deriveDomainSecurityIndicators(d),
    checklist: deriveDomainChecklist(d),
    requiredRecords: deriveDomainRequiredRecords(d),
    riskReasons,
    issueCount: riskReasons.filter(r => r.tone !== 'info').length,
    needsAction,
    nextAction: getDomainActionLabel(d),
    truthLabel: getDomainTruthLabel(d),
    createdAt: d.createdAt,
    verifiedAt: d.verifiedAt,
    lastCheckedAt: d.lastCheckedAt,
  };
}

export function deriveDomainReadinessList(domains: TenantDomainRecord[]): DomainReadinessSignal[] {
  return domains.map(deriveDomainReadiness);
}

// ---------------------------------------------------------------------------
// Posture rollup — drives M2 posture cards. Counts derive from the SAME
// readiness signals the list uses, so card counts and filtered lists cannot
// drift (the locked Command Center "no drift" rule applies here too).
// ---------------------------------------------------------------------------

export interface DomainPosture {
  total: number;
  byLifecycle: Record<DomainLifecycleStatus, number>;
  verifiedOrReady: number; // verified + ssl_pending + ssl_ready
  sslReady: number;
  pendingAction: number;   // needsAction === true
  failed: number;
  disabled: number;
  atRisk: number;          // any critical risk reason
  totalIssues: number;     // sum of issueCount across domains
}

export function deriveDomainPosture(domains: TenantDomainRecord[]): DomainPosture {
  const signals = deriveDomainReadinessList(domains);
  const byLifecycle = DOMAIN_LIFECYCLE_ORDER.reduce((acc, l) => {
    acc[l] = 0;
    return acc;
  }, {} as Record<DomainLifecycleStatus, number>);
  signals.forEach(s => { byLifecycle[s.lifecycle] += 1; });

  return {
    total: signals.length,
    byLifecycle,
    verifiedOrReady: byLifecycle.verified + byLifecycle.ssl_pending + byLifecycle.ssl_ready,
    sslReady: byLifecycle.ssl_ready,
    pendingAction: signals.filter(s => s.needsAction).length,
    failed: byLifecycle.failed,
    disabled: byLifecycle.disabled,
    atRisk: signals.filter(s => s.riskReasons.some(r => r.tone === 'critical')).length,
    totalIssues: signals.reduce((sum, s) => sum + s.issueCount, 0),
  };
}
