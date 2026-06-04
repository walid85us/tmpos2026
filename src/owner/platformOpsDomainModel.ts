// ===========================================================================
// Phase 1.2F — Milestone 0: Domain Object Model Foundation (helpers + storage)
// ===========================================================================
//
// Deterministic, rule-based helpers and LOCAL/SESSION storage for the richer
// domain object model (DNS zone mirror, SSL/TLS readiness, Email DNS, Security
// readiness, Registrar readiness, Portfolio signals, Control Panel overview,
// Troubleshooting guide, Audit summary). These power FUTURE Domain Control
// Panel screens — Milestone 0 adds NO UI and wires nothing into the existing
// Domains page.
//
// This module is SEPARATE from `platformOpsDomains.ts` (the existing accepted
// derivations) and REUSES those helpers so counts/labels cannot drift. It is
// the same discipline already used for the Audit Investigation Center
// (`platformOpsInvestigation.ts`).
//
// TRUTH CONSTRAINTS (do not violate):
//   - No live DNS lookup in this phase. No real SSL automation, no certificate
//     issuance, no registrar/provider API integration, no DNSSEC/domain-lock/
//     transfer-protection activation, no traffic/geolocation analytics, no
//     external notifications, no runtime enforcement.
//   - Everything is an INTENDED-STATE mirror + MANUAL readiness. Verification is
//     "Operator manually marked verified", never "System automatically verified".
//   - Everything below is PURE: helpers take records/context and return derived
//     data. No mutation, no audit emission (M0).
// ===========================================================================

import type {
  TenantDomainRecord,
  DnsRecord,
  DnsRecordType,
  DomainRegistrarInfo,
  DomainSecurityRecord,
  RegistrarFeatureState,
  DomainManualSslReadiness,
  DomainSslValidationMethod,
} from './mockData';
import {
  tenantDnsRecords,
  tenantDomainRegistrar,
  tenantDomainSecurity,
  tenantDomains as tenantDomainsSeed,
  tenantDomainHistory,
} from './mockData';
import type {
  DomainRole,
  DomainLifecycleStatus,
  DomainDnsReadiness,
  DomainChecklistState,
  DomainChecklistItem,
  DomainRiskReason,
} from './platformOpsDomains';
import {
  deriveDomainRole,
  deriveDomainLifecycle,
  DOMAIN_LIFECYCLE_LABELS,
  deriveDomainDnsReadiness,
  DOMAIN_DNS_READINESS_LABELS,
  deriveDomainChecklist,
  deriveDomainRiskReasons,
  deriveParentRootHostname,
  PLATFORM_ROOT_SUFFIX,
  DOMAIN_PROXY_TARGET,
  DOMAIN_TXT_PREFIX,
} from './platformOpsDomains';

// ---------------------------------------------------------------------------
// Truth labels (final design-freeze wording — do not soften).
// ---------------------------------------------------------------------------
export const DOMAIN_MODEL_TRUTH_LABELS = {
  noLiveDns: 'No live DNS lookup in this phase.',
  intendedState: 'Intended-state only — this mirrors what should be configured at the DNS provider, not a live zone.',
  manualPropagation: 'Manual propagation confirmation.',
  sslManual: 'SSL automation is future. Current SSL readiness is manually tracked.',
  autoRenew: 'Auto-renew: Future / Not active.',
  registrarExternal: 'Registrar/provider configuration external in this phase.',
  futureTelemetry: 'Future telemetry — not active in this phase.',
  notRuntimeEnforced: 'Policy Baseline — Not Runtime Enforced.',
  auditRecord: 'Audit record (not an immutable record).',
} as const;

// ---------------------------------------------------------------------------
// Future audit action constants — DEFINED ONLY, not emitted in Milestone 0.
// Milestone 1 will wire these through the existing pushPlatformAudit channel.
// ---------------------------------------------------------------------------
export const FUTURE_DOMAIN_MODEL_AUDIT_ACTIONS = [
  'dns_record_intended_added',
  'dns_record_intended_updated',
  'dns_record_intended_deleted',
  'dns_record_manual_verification_recorded',
  'registrar_info_updated',
  'email_dns_readiness_updated',
  'domain_security_readiness_updated',
  'ssl_manual_readiness_updated',
] as const;
export type FutureDomainModelAuditAction = typeof FUTURE_DOMAIN_MODEL_AUDIT_ACTIONS[number];

// ===========================================================================
// LOCAL / SESSION STORAGE — sibling stores (mirrors the existing
// `tenant_domains_v1` sessionStorage pattern in DomainsPage). The base domain
// store is NOT migrated or touched.
// ===========================================================================

export const DNS_RECORDS_KEY = 'tenant_dns_records_v1';
export const DOMAIN_REGISTRAR_KEY = 'tenant_domain_registrar_v1';
export const DOMAIN_SECURITY_KEY = 'tenant_domain_security_v1';

function safeLoad<T>(key: string, seed: T[]): T[] {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [...seed];
    const raw = window.sessionStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as T[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* noop */ }
  return [...seed];
}

function safeSave<T>(key: string, value: T[]): void {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    }
  } catch { /* noop */ }
}

export const loadDnsRecords = (): DnsRecord[] => safeLoad(DNS_RECORDS_KEY, tenantDnsRecords);
export const saveDnsRecords = (r: DnsRecord[]): void => safeSave(DNS_RECORDS_KEY, r);
export const loadDomainRegistrar = (): DomainRegistrarInfo[] => safeLoad(DOMAIN_REGISTRAR_KEY, tenantDomainRegistrar);
export const saveDomainRegistrar = (r: DomainRegistrarInfo[]): void => safeSave(DOMAIN_REGISTRAR_KEY, r);
export const loadDomainSecurity = (): DomainSecurityRecord[] => safeLoad(DOMAIN_SECURITY_KEY, tenantDomainSecurity);
export const saveDomainSecurity = (r: DomainSecurityRecord[]): void => safeSave(DOMAIN_SECURITY_KEY, r);

// ===========================================================================
// CONTEXT — what the aggregate helpers need. All fields optional; helpers fall
// back to the seed so a caller can use them with no wiring (M0 convenience).
// ===========================================================================

export interface DomainModelContext {
  dnsRecords?: DnsRecord[];
  registrar?: DomainRegistrarInfo[];
  security?: DomainSecurityRecord[];
  domains?: TenantDomainRecord[];
  tenantNameById?: Record<string, string>;
  auditRows?: { id: string; date: string; actor: string; action: string; target: string; tenantId?: string | null }[];
}

function ctxDnsRecords(ctx?: DomainModelContext): DnsRecord[] {
  return ctx?.dnsRecords ?? tenantDnsRecords;
}
function ctxRegistrar(ctx?: DomainModelContext): DomainRegistrarInfo[] {
  return ctx?.registrar ?? tenantDomainRegistrar;
}
function ctxSecurity(ctx?: DomainModelContext): DomainSecurityRecord[] {
  return ctx?.security ?? tenantDomainSecurity;
}
function ctxDomains(ctx?: DomainModelContext): TenantDomainRecord[] {
  return ctx?.domains ?? tenantDomainsSeed;
}

// ===========================================================================
// Concept helper — DNS zone (intended-state mirror)
// ===========================================================================

// Stable ordering for a zone view.
const DNS_TYPE_ORDER: DnsRecordType[] = ['NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SPF', 'DKIM', 'DMARC', 'CAA'];

function dnsSort(a: DnsRecord, b: DnsRecord): number {
  const ta = DNS_TYPE_ORDER.indexOf(a.type);
  const tb = DNS_TYPE_ORDER.indexOf(b.type);
  if (ta !== tb) return ta - tb;
  return a.host.localeCompare(b.host);
}

// deriveDnsZoneRecords(domain, records) — the intended-state zone for one domain.
// Merges any required platform record that is not yet present as an `intended`
// row so the zone always shows what the platform needs. No live lookup.
export function deriveDnsZoneRecords(domain: TenantDomainRecord, records?: DnsRecord[]): DnsRecord[] {
  const all = records ?? tenantDnsRecords;
  const own = all.filter(r => r.domainId === domain.id);
  const required = deriveRequiredPlatformDnsRecords(domain);
  const merged = [...own];
  required.forEach(req => {
    const exists = own.some(r => r.type === req.type && r.host.toLowerCase() === req.host.toLowerCase());
    if (!exists) merged.push(req);
  });
  return merged.sort(dnsSort);
}

// deriveRequiredPlatformDnsRecords(domain) — the platform-required intended
// records (CNAME route + ownership TXT). Custom domains only; platform
// subdomains are auto-managed by the apex.
export function deriveRequiredPlatformDnsRecords(domain: TenantDomainRecord): DnsRecord[] {
  if (domain.kind !== 'custom') return [];
  const now = domain.lastCheckedAt ?? domain.createdAt;
  return [
    {
      id: `req_${domain.id}_cname`,
      domainId: domain.id,
      type: 'CNAME',
      host: domain.hostname,
      value: DOMAIN_PROXY_TARGET,
      ttl: 3600,
      source: 'platform_required',
      status: 'intended',
      purpose: 'Routes the custom domain to the platform edge.',
      lastEditedAt: now,
    },
    {
      id: `req_${domain.id}_txt`,
      domainId: domain.id,
      type: 'TXT',
      host: `${DOMAIN_TXT_PREFIX}.${domain.hostname}`,
      value: `verify=${domain.id}`,
      ttl: 300,
      source: 'platform_required',
      status: 'intended',
      purpose: 'Proves domain ownership for manual verification.',
      lastEditedAt: now,
    },
  ];
}

// ===========================================================================
// Concept 3 — EmailDnsReadiness
// ===========================================================================

export type EmailDnsStatus = 'ready' | 'partial' | 'missing' | 'pending_manual_review' | 'not_applicable';

export interface EmailDnsReadiness {
  mx: EmailDnsStatus;
  spf: EmailDnsStatus;
  dkim: EmailDnsStatus;
  dmarc: EmailDnsStatus;
  overall: EmailDnsStatus;
  nextAction: string;
  missingRecords: DnsRecordType[];
  requiredRecords: DnsRecordType[];
  truthLabel: string;
}

const EMAIL_REQUIRED: DnsRecordType[] = ['MX', 'SPF', 'DKIM', 'DMARC'];

function recordStatusToReadiness(r: DnsRecord | undefined): EmailDnsStatus {
  if (!r) return 'missing';
  switch (r.status) {
    case 'manually_verified':
    case 'manual_ready':
      return 'ready';
    case 'conflict':
    case 'pending_manual_review':
    case 'intended':
      return 'pending_manual_review';
    case 'not_applicable':
      return 'not_applicable';
    default:
      return 'pending_manual_review';
  }
}

// deriveEmailDnsReadiness(domain, records) — derived ONLY from the intended-state
// zone records. No live MX/SPF/DKIM/DMARC lookup.
export function deriveEmailDnsReadiness(domain: TenantDomainRecord, records?: DnsRecord[]): EmailDnsReadiness {
  const base: Omit<EmailDnsReadiness, 'mx' | 'spf' | 'dkim' | 'dmarc' | 'overall' | 'nextAction' | 'missingRecords'> = {
    requiredRecords: EMAIL_REQUIRED,
    truthLabel: DOMAIN_MODEL_TRUTH_LABELS.intendedState,
  };
  if (domain.status === 'disabled' || domain.kind !== 'custom') {
    const na: EmailDnsStatus = 'not_applicable';
    return {
      ...base,
      mx: na, spf: na, dkim: na, dmarc: na, overall: na,
      nextAction: domain.kind !== 'custom'
        ? 'Email DNS is managed by the platform apex for platform subdomains — no tenant action.'
        : 'Domain is disabled — email DNS is not applicable.',
      missingRecords: [],
    };
  }
  const own = (records ?? tenantDnsRecords).filter(r => r.domainId === domain.id);
  const find = (t: DnsRecordType) => own.find(r => r.type === t);
  const mx = recordStatusToReadiness(find('MX'));
  const spf = recordStatusToReadiness(find('SPF'));
  const dkim = recordStatusToReadiness(find('DKIM'));
  const dmarc = recordStatusToReadiness(find('DMARC'));
  const parts: EmailDnsStatus[] = [mx, spf, dkim, dmarc];
  const missingRecords = EMAIL_REQUIRED.filter(t => !find(t));
  const allReady = parts.every(p => p === 'ready');
  const anyMissing = parts.some(p => p === 'missing');
  const anyPending = parts.some(p => p === 'pending_manual_review');
  const allMissing = parts.every(p => p === 'missing');
  let overall: EmailDnsStatus;
  if (allReady) overall = 'ready';
  else if (allMissing) overall = 'missing';
  else if (anyPending && !anyMissing) overall = 'pending_manual_review';
  else overall = 'partial';
  const nextAction =
    overall === 'ready' ? 'Email DNS records are in place. No action needed.'
    : overall === 'missing' ? 'Add MX, SPF, DKIM and DMARC records, then mark them reviewed.'
    : overall === 'pending_manual_review' ? 'Confirm the pending email records at the provider, then mark records reviewed.'
    : `Add the missing email records (${missingRecords.join(', ') || 'none'}), then mark records reviewed.`;
  return { ...base, mx, spf, dkim, dmarc, overall, nextAction, missingRecords };
}

// ===========================================================================
// Concept 4 — SslCertificateView
// ===========================================================================

export type SslViewStatus =
  | 'not_started'
  | 'pending_manual_validation'
  | 'manual_ready'
  | 'failed'
  | 'not_applicable';

export const SSL_VIEW_STATUS_LABELS: Record<SslViewStatus, string> = {
  not_started: 'Not started',
  pending_manual_validation: 'Pending manual validation',
  manual_ready: 'Manual ready',
  failed: 'Failed',
  not_applicable: 'Not applicable',
};

export interface SslCertificateView {
  status: SslViewStatus;
  validationMethod: DomainSslValidationMethod;
  issueReason: string | null;
  certificateAuthority: string;   // placeholder — not tracked live
  expiryAt: string | null;        // placeholder — not tracked live
  autoRenew: string;              // always the future/not-active label
  requiredValidationRecord?: DnsRecord | null;
  nextAction: string;
  manualChecklist: { key: string; label: string; state: DomainChecklistState }[];
  truthLabel: string;
}

// Maps the manual security overlay (preferred) or the raw `ssl` field to an SSL
// view status. Never claims an automated check happened.
function deriveSslViewStatus(domain: TenantDomainRecord, security?: DomainSecurityRecord): SslViewStatus {
  if (domain.status === 'disabled') return 'not_applicable';
  if (security) return security.manualSslReadiness;
  switch (domain.ssl) {
    case 'active': return 'manual_ready';
    case 'pending': return 'pending_manual_validation';
    case 'failed': return 'failed';
    case 'none':
    default: return 'not_started';
  }
}

// deriveSslCertificateView(domain, records, security) — manual SSL readiness view.
export function deriveSslCertificateView(
  domain: TenantDomainRecord,
  records?: DnsRecord[],
  security?: DomainSecurityRecord,
): SslCertificateView {
  const sec = security ?? tenantDomainSecurity.find(s => s.domainId === domain.id);
  const status = deriveSslViewStatus(domain, sec);
  const validationMethod: DomainSslValidationMethod = sec?.sslValidationMethod ?? 'unknown';
  const own = (records ?? tenantDnsRecords).filter(r => r.domainId === domain.id);
  const requiredValidationRecord =
    own.find(r => r.type === 'TXT' && r.host.startsWith(DOMAIN_TXT_PREFIX)) ?? null;

  const issueReason =
    status === 'failed' ? (sec?.securityNote ?? 'SSL marked failed — re-validate after confirming DNS.')
    : status === 'not_applicable' ? 'Domain is disabled — SSL is not applicable.'
    : null;

  const nextAction =
    status === 'manual_ready' ? 'SSL is manually marked ready. No action needed.'
    : status === 'pending_manual_validation' ? 'Confirm the certificate validation out-of-band, then record manual verification.'
    : status === 'failed' ? 'Resolve the validation issue, then record manual verification.'
    : status === 'not_applicable' ? 'Re-enable the domain to resume SSL readiness.'
    : 'Verify the domain, then begin manual SSL validation.';

  const done = (s: SslViewStatus[]): DomainChecklistState => (s.includes(status) ? 'done' : 'todo');
  const manualChecklist: { key: string; label: string; state: DomainChecklistState }[] =
    status === 'not_applicable'
      ? [{ key: 'na', label: 'SSL is not applicable while the domain is disabled', state: 'not_applicable' }]
      : [
          { key: 'verify_domain', label: 'Verify the domain (DNS confirmed manually)', state: done(['pending_manual_validation', 'manual_ready']) },
          { key: 'validate', label: 'Complete manual SSL validation at the provider', state: status === 'manual_ready' ? 'done' : status === 'pending_manual_validation' ? 'current' : 'todo' },
          { key: 'record', label: 'Record manual verification once the certificate is active', state: status === 'manual_ready' ? 'done' : 'todo' },
        ];

  return {
    status,
    validationMethod,
    issueReason,
    certificateAuthority: 'Manual / not tracked (future: provider-issued).',
    expiryAt: null,
    autoRenew: DOMAIN_MODEL_TRUTH_LABELS.autoRenew,
    requiredValidationRecord,
    nextAction,
    manualChecklist,
    truthLabel: DOMAIN_MODEL_TRUTH_LABELS.sslManual,
  };
}

// ===========================================================================
// Concept — RegistrarReadiness
// ===========================================================================

export type RegistrarReadinessLevel = 'documented' | 'partial' | 'unknown' | 'external';

export interface RegistrarReadiness {
  registrarName: string;
  ownershipNote: string;
  level: RegistrarReadinessLevel;
  autoRenew: RegistrarFeatureState;
  transferLock: RegistrarFeatureState;
  domainLock: RegistrarFeatureState;
  dnssec: RegistrarFeatureState;
  expiryAt: string | null;
  nameservers: string[];
  nextAction: string;
  truthLabel: string;
}

// deriveRegistrarReadiness(domain, registrarInfo) — describes registrar/ownership
// readiness from local placeholders only.
export function deriveRegistrarReadiness(
  domain: TenantDomainRecord,
  registrarInfo?: DomainRegistrarInfo,
): RegistrarReadiness {
  const info = registrarInfo ?? tenantDomainRegistrar.find(r => r.domainId === domain.id);
  if (!info) {
    return {
      registrarName: 'Unknown',
      ownershipNote: 'No registrar information recorded yet.',
      level: 'unknown',
      autoRenew: 'unknown',
      transferLock: 'unknown',
      domainLock: 'unknown',
      dnssec: 'unknown',
      expiryAt: null,
      nameservers: [],
      nextAction: 'Record registrar/ownership details for this domain.',
      truthLabel: DOMAIN_MODEL_TRUTH_LABELS.registrarExternal,
    };
  }
  const states: RegistrarFeatureState[] = [info.autoRenew, info.transferLock, info.domainLock, info.dnssec];
  const anyUnknown = states.some(s => s === 'unknown');
  const allKnown = states.every(s => s === 'enabled' || s === 'disabled');
  const level: RegistrarReadinessLevel =
    domain.kind !== 'custom' ? 'external'
    : allKnown ? 'documented'
    : anyUnknown ? 'partial'
    : 'partial';
  const nextAction =
    domain.kind !== 'custom' ? 'Registrar/DNS is managed by the platform apex — no tenant action.'
    : anyUnknown ? 'Confirm the unknown registrar controls (auto-renew / locks / DNSSEC) out-of-band.'
    : 'Registrar controls are documented. Review periodically.';
  return {
    registrarName: info.registrarName,
    ownershipNote: info.ownershipNote,
    level,
    autoRenew: info.autoRenew,
    transferLock: info.transferLock,
    domainLock: info.domainLock,
    dnssec: info.dnssec,
    expiryAt: info.expiryAt,
    nameservers: info.nameservers ?? [],
    nextAction,
    truthLabel: DOMAIN_MODEL_TRUTH_LABELS.registrarExternal,
  };
}

// ===========================================================================
// Concept 5 — DomainSecurityReadiness
// ===========================================================================

export type CaaReadiness = 'present' | 'missing' | 'not_applicable' | 'pending_manual_review';
export type SecurityReadinessLevel = 'ready' | 'partial' | 'attention' | 'future' | 'not_applicable';

export interface DomainSecurityReadiness {
  sslReadiness: SslViewStatus;
  caaReadiness: CaaReadiness;
  dnssecReadiness: RegistrarFeatureState;            // future / not active
  domainLockReadiness: RegistrarFeatureState;        // future / not active
  transferProtectionReadiness: RegistrarFeatureState; // future / not active
  registrarSecurityNote: string;
  overall: SecurityReadinessLevel;
  nextAction: string;
  riskReasons: DomainRiskReason[];
  truthLabel: string;
}

// deriveDomainSecurityReadiness(domain, records, registrarInfo, security)
export function deriveDomainSecurityReadiness(
  domain: TenantDomainRecord,
  records?: DnsRecord[],
  registrarInfo?: DomainRegistrarInfo,
  security?: DomainSecurityRecord,
): DomainSecurityReadiness {
  const sec = security ?? tenantDomainSecurity.find(s => s.domainId === domain.id);
  const reg = registrarInfo ?? tenantDomainRegistrar.find(r => r.domainId === domain.id);
  const sslReadiness = deriveSslViewStatus(domain, sec);
  const own = (records ?? tenantDnsRecords).filter(r => r.domainId === domain.id);

  let caaReadiness: CaaReadiness;
  if (domain.status === 'disabled') caaReadiness = 'not_applicable';
  else {
    const caa = own.find(r => r.type === 'CAA');
    caaReadiness = !caa
      ? (domain.kind === 'custom' ? 'missing' : 'not_applicable')
      : caa.status === 'manually_verified' || caa.status === 'manual_ready'
        ? 'present'
        : 'pending_manual_review';
  }

  const dnssecReadiness: RegistrarFeatureState = reg?.dnssec ?? 'unknown';
  const domainLockReadiness: RegistrarFeatureState = reg?.domainLock ?? 'unknown';
  const transferProtectionReadiness: RegistrarFeatureState = reg?.transferLock ?? 'unknown';

  const riskReasons = deriveDomainRiskReasons(domain);

  let overall: SecurityReadinessLevel;
  if (domain.status === 'disabled') overall = 'not_applicable';
  else if (riskReasons.some(r => r.tone === 'critical') || sslReadiness === 'failed') overall = 'attention';
  else if (sslReadiness === 'manual_ready' && (caaReadiness === 'present' || caaReadiness === 'not_applicable')) overall = 'ready';
  else overall = 'partial';

  const nextAction =
    overall === 'not_applicable' ? 'Domain is disabled — security readiness is not applicable.'
    : overall === 'attention' ? 'Resolve the flagged SSL/verification issues, then re-review security readiness.'
    : overall === 'ready' ? 'Security posture is documented. DNSSEC / domain lock / transfer protection remain future.'
    : caaReadiness === 'missing' ? 'Consider adding a CAA record and documenting registrar controls.'
    : 'Complete manual SSL readiness and document registrar controls.';

  return {
    sslReadiness,
    caaReadiness,
    dnssecReadiness,
    domainLockReadiness,
    transferProtectionReadiness,
    registrarSecurityNote: reg?.providerNotes ?? sec?.securityNote ?? DOMAIN_MODEL_TRUTH_LABELS.registrarExternal,
    overall,
    nextAction,
    riskReasons,
    truthLabel: `${DOMAIN_MODEL_TRUTH_LABELS.notRuntimeEnforced} DNSSEC, domain lock and transfer protection are future / not active in this phase.`,
  };
}

// ===========================================================================
// Concept 6 — DomainPortfolioSignal
// ===========================================================================

export type DomainPortfolioType = 'root' | 'subdomain' | 'platform' | 'legacy';
export type PortfolioRisk = 'critical' | 'warn' | 'ok';

export interface DomainPortfolioSignal {
  domainId: string;
  hostname: string;
  domainType: DomainPortfolioType;
  tenantId: string;
  tenant: string;
  registrar: string;
  dnsReadiness: DomainDnsReadiness;
  dnsReadinessLabel: string;
  sslReadiness: SslViewStatus;
  emailDnsReadiness: EmailDnsStatus;
  securityReadiness: SecurityReadinessLevel;
  registrarReadiness: RegistrarReadinessLevel;
  renewalExpiryPlaceholder: string | null;
  risk: PortfolioRisk;
  nextAction: string;
  truthLabels: string[];
}

export function deriveDomainPortfolioType(domain: TenantDomainRecord): DomainPortfolioType {
  if (domain.status === 'disabled') return 'legacy';
  if (domain.kind !== 'custom') return 'platform';
  return deriveDomainRole(domain) === 'subdomain' ? 'subdomain' : 'root';
}

// deriveDomainPortfolioSignal(domain, ctx)
export function deriveDomainPortfolioSignal(domain: TenantDomainRecord, ctx?: DomainModelContext): DomainPortfolioSignal {
  const records = ctxDnsRecords(ctx);
  const reg = ctxRegistrar(ctx).find(r => r.domainId === domain.id);
  const sec = ctxSecurity(ctx).find(s => s.domainId === domain.id);
  const dnsReadiness = deriveDomainDnsReadiness(domain);
  const sslReadiness = deriveSslViewStatus(domain, sec);
  const email = deriveEmailDnsReadiness(domain, records);
  const security = deriveDomainSecurityReadiness(domain, records, reg, sec);
  const registrar = deriveRegistrarReadiness(domain, reg);
  const riskReasons = deriveDomainRiskReasons(domain);
  const risk: PortfolioRisk =
    riskReasons.some(r => r.tone === 'critical') || sslReadiness === 'failed' ? 'critical'
    : riskReasons.some(r => r.tone === 'warn') || security.overall === 'partial' || email.overall === 'partial' ? 'warn'
    : 'ok';
  const nextAction =
    risk === 'critical' ? security.nextAction
    : sslReadiness !== 'manual_ready' && sslReadiness !== 'not_applicable' ? 'Complete manual SSL readiness.'
    : email.overall !== 'ready' && email.overall !== 'not_applicable' ? email.nextAction
    : 'No action needed.';
  return {
    domainId: domain.id,
    hostname: domain.hostname,
    domainType: deriveDomainPortfolioType(domain),
    tenantId: domain.tenantId,
    tenant: ctx?.tenantNameById?.[domain.tenantId] ?? domain.tenantId,
    registrar: registrar.registrarName,
    dnsReadiness,
    dnsReadinessLabel: DOMAIN_DNS_READINESS_LABELS[dnsReadiness],
    sslReadiness,
    emailDnsReadiness: email.overall,
    securityReadiness: security.overall,
    registrarReadiness: registrar.level,
    renewalExpiryPlaceholder: registrar.expiryAt,
    risk,
    nextAction,
    truthLabels: [DOMAIN_MODEL_TRUTH_LABELS.noLiveDns, DOMAIN_MODEL_TRUTH_LABELS.sslManual],
  };
}

export function deriveDomainPortfolioSignals(domains?: TenantDomainRecord[], ctx?: DomainModelContext): DomainPortfolioSignal[] {
  const list = domains ?? ctxDomains(ctx);
  return list.map(d => deriveDomainPortfolioSignal(d, ctx));
}

// ===========================================================================
// Concept 9 — DomainAuditSummary (history + mirrored audit rows, read-only)
// ===========================================================================

export interface DomainAuditEntry {
  id: string;
  eventType: string;
  details: string;
  actor: string;
  timestamp: string;
  auditId: string | null;
}

export interface DomainAuditSummary {
  domainId: string;
  hostname: string;
  entries: DomainAuditEntry[];
  truthLabel: string;
}

// deriveDomainAuditSummary(domain, ctx) — combines the seeded domain history and
// any mirrored audit rows whose target references the hostname. Read-only.
export function deriveDomainAuditSummary(domain: TenantDomainRecord, ctx?: DomainModelContext): DomainAuditSummary {
  const fromHistory: DomainAuditEntry[] = tenantDomainHistory
    .filter(h => h.domain === domain.hostname)
    .map(h => ({
      id: h.id,
      eventType: h.action,
      details: `${h.action} — ${h.domain}`,
      actor: h.actor,
      timestamp: h.date,
      auditId: null,
    }));
  const fromAudit: DomainAuditEntry[] = (ctx?.auditRows ?? [])
    .filter(r => r.target && r.target.includes(domain.hostname))
    .map(r => ({
      id: r.id,
      eventType: r.action,
      details: r.target,
      actor: r.actor,
      timestamp: r.date,
      auditId: r.id,
    }));
  const entries = [...fromAudit, ...fromHistory].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    domainId: domain.id,
    hostname: domain.hostname,
    entries,
    truthLabel: DOMAIN_MODEL_TRUTH_LABELS.auditRecord,
  };
}

// ===========================================================================
// Concept 8 — DomainTroubleshooting (guide). Renamed `...Guide` to avoid a
// collision with the existing `deriveDomainTroubleshooting` in
// platformOpsDomains.ts (which returns symptom/guidance items and is unchanged).
// ===========================================================================

export interface DomainTroubleshootingGuide {
  pendingDnsExplanation: string;
  failedVerificationExplanation: string;
  propagationGuidance: string[];
  commonMistakes: string[];
  registrarVsProviderVsApp: string;
  recommendedNextAction: string;
  truthLabel: string;
}

export function deriveDomainTroubleshootingGuide(domain: TenantDomainRecord, ctx?: DomainModelContext): DomainTroubleshootingGuide {
  const records = ctxDnsRecords(ctx);
  const hasConflict = records.some(r => r.domainId === domain.id && r.status === 'conflict');
  const recommendedNextAction =
    domain.status === 'disabled' ? 'Re-enable the domain to resume routing and readiness.'
    : domain.status === 'failed' ? 'Re-check the DNS records at the provider, then record manual verification.'
    : hasConflict ? 'Resolve the conflicting record (remove the legacy entry) before verifying.'
    : domain.kind !== 'custom' ? 'No action — this platform subdomain is auto-managed by the apex.'
    : 'Confirm DNS propagation out-of-band, then record manual verification.';
  return {
    pendingDnsExplanation: 'Pending DNS means the required records have not yet been confirmed at the provider. This app does not look up DNS live — readiness is intended-state only.',
    failedVerificationExplanation: 'Failed verification means the expected records were not found when last reviewed. Re-check the host and value at the provider for typos or a wrong host, then record manual verification.',
    propagationGuidance: [
      'Confirm each required record exists at the DNS provider exactly as shown (host and value).',
      'Use an external DNS lookup (dig / nslookup or a public propagation checker) to confirm records resolve globally.',
      'Allow time for propagation — DNS changes can take minutes to 48 hours depending on the record TTL.',
      'Once records resolve externally, record manual verification here (manual propagation confirmation).',
    ],
    commonMistakes: [
      'Adding the record at the wrong host (e.g. including the domain twice).',
      'A conflicting A record left in place when a CNAME is required.',
      'Forgetting SPF/DKIM/DMARC for email, or a missing CAA for certificate issuance control.',
      'Editing DNS at the wrong provider when the nameservers point elsewhere.',
    ],
    registrarVsProviderVsApp:
      'Registrar = where the domain is owned/renewed (e.g. Cloudflare, GoDaddy, Namecheap, Route 53). DNS provider = where the zone/records live (often the registrar, sometimes separate). This app = where you track the intended state and record manual readiness. ' + DOMAIN_MODEL_TRUTH_LABELS.registrarExternal,
    recommendedNextAction,
    truthLabel: DOMAIN_MODEL_TRUTH_LABELS.noLiveDns,
  };
}

// ===========================================================================
// Concept 7 — DomainControlPanelOverview (selected-domain overview)
// ===========================================================================

export interface RelatedSubdomainRef {
  id: string;
  hostname: string;
  lifecycle: DomainLifecycleStatus;
  lifecycleLabel: string;
}

export interface DomainControlPanelOverview {
  domainId: string;
  hostname: string;
  tenantId: string;
  tenant: string;
  domainType: DomainPortfolioType;
  role: DomainRole;
  parentRootHostname: string | null;
  registrar: RegistrarReadiness;
  lifecycle: DomainLifecycleStatus;
  lifecycleLabel: string;
  dnsReadiness: DomainDnsReadiness;
  dnsReadinessLabel: string;
  zone: DnsRecord[];
  sslView: SslCertificateView;
  emailDns: EmailDnsReadiness;
  security: DomainSecurityReadiness;
  relatedSubdomains: RelatedSubdomainRef[];
  nextAction: string;
  manualChecklist: DomainChecklistItem[];
  riskReasons: DomainRiskReason[];
  recentActivity: DomainAuditEntry[];
  troubleshooting: DomainTroubleshootingGuide;
  truthLabels: string[];
}

// deriveDomainControlPanelOverview(domain, ctx)
export function deriveDomainControlPanelOverview(domain: TenantDomainRecord, ctx?: DomainModelContext): DomainControlPanelOverview {
  const records = ctxDnsRecords(ctx);
  const reg = ctxRegistrar(ctx).find(r => r.domainId === domain.id);
  const sec = ctxSecurity(ctx).find(s => s.domainId === domain.id);
  const allDomains = ctxDomains(ctx);
  const lifecycle = deriveDomainLifecycle(domain);
  const dnsReadiness = deriveDomainDnsReadiness(domain);
  const security = deriveDomainSecurityReadiness(domain, records, reg, sec);
  const sslView = deriveSslCertificateView(domain, records, sec);
  const emailDns = deriveEmailDnsReadiness(domain, records);
  const registrar = deriveRegistrarReadiness(domain, reg);
  const relatedSubdomains: RelatedSubdomainRef[] = allDomains
    .filter(d => d.parentDomainId === domain.id)
    .map(d => {
      const lc = deriveDomainLifecycle(d);
      return { id: d.id, hostname: d.hostname, lifecycle: lc, lifecycleLabel: DOMAIN_LIFECYCLE_LABELS[lc] };
    });
  const audit = deriveDomainAuditSummary(domain, ctx);
  const riskReasons = deriveDomainRiskReasons(domain);
  const nextAction =
    riskReasons.some(r => r.tone === 'critical') ? security.nextAction
    : sslView.status !== 'manual_ready' && sslView.status !== 'not_applicable' ? sslView.nextAction
    : emailDns.overall !== 'ready' && emailDns.overall !== 'not_applicable' ? emailDns.nextAction
    : 'No action needed.';
  return {
    domainId: domain.id,
    hostname: domain.hostname,
    tenantId: domain.tenantId,
    tenant: ctx?.tenantNameById?.[domain.tenantId] ?? domain.tenantId,
    domainType: deriveDomainPortfolioType(domain),
    role: deriveDomainRole(domain),
    parentRootHostname: domain.parentDomainId
      ? (allDomains.find(d => d.id === domain.parentDomainId)?.hostname ?? deriveParentRootHostname(domain))
      : (deriveDomainRole(domain) === 'subdomain' ? `${PLATFORM_ROOT_SUFFIX}` : null),
    registrar,
    lifecycle,
    lifecycleLabel: DOMAIN_LIFECYCLE_LABELS[lifecycle],
    dnsReadiness,
    dnsReadinessLabel: DOMAIN_DNS_READINESS_LABELS[dnsReadiness],
    zone: deriveDnsZoneRecords(domain, records),
    sslView,
    emailDns,
    security,
    relatedSubdomains,
    nextAction,
    manualChecklist: deriveDomainChecklist(domain),
    riskReasons,
    recentActivity: audit.entries.slice(0, 8),
    troubleshooting: deriveDomainTroubleshootingGuide(domain, ctx),
    truthLabels: [
      DOMAIN_MODEL_TRUTH_LABELS.noLiveDns,
      DOMAIN_MODEL_TRUTH_LABELS.intendedState,
      DOMAIN_MODEL_TRUTH_LABELS.sslManual,
      DOMAIN_MODEL_TRUTH_LABELS.registrarExternal,
    ],
  };
}
