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
} from './mockData';

export type { DomainStatus, DomainSslStatus, DomainKind };

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
  rawStatus: DomainStatus;
  rawSsl: DomainSslStatus;
  lifecycle: DomainLifecycleStatus;
  lifecycleLabel: string;
  sslReadiness: DomainSslReadiness;
  sslReadinessLabel: string;
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
    rawStatus: d.status,
    rawSsl: d.ssl,
    lifecycle,
    lifecycleLabel: DOMAIN_LIFECYCLE_LABELS[lifecycle],
    sslReadiness,
    sslReadinessLabel: DOMAIN_SSL_READINESS_LABELS[sslReadiness],
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
