// ===========================================================================
// Phase 1.2F Strategic Replacement — Tenant Web Address helper layer.
//
// This is a PURE, DETERMINISTIC presentation layer over the existing
// `tenant_domains_v1` records. It repositions the accepted domain model around
// the product concept that matters for a repair/POS SaaS: each tenant's
// platform-managed web address (tenantSlug.repairplatform.com) and the
// customer-facing links derived from it.
//
// It does NOT mutate any store, does NOT perform any real DNS / SSL / registrar
// work, and does NOT replace the raw status/ssl/kind fields (the source of
// truth). The advanced DNS/SSL/registrar/security helpers in
// `platformOpsDomainModel.ts` remain dormant / future / support-assisted.
// ===========================================================================

import { PLATFORM_ROOT_SUFFIX } from './platformOpsDomains';
import type { TenantDomainRecord, DomainStatus } from './mockData';

// No live hosting / routing in this phase. Copy actions are always allowed;
// Open actions stay disabled (Future / Not active) because the customer-facing
// routes are not really served by this app yet.
export const WEB_ADDRESS_LIVE_HOSTING = false;

export const WEB_ADDRESS_TRUTH_LABELS = {
  platformManaged: 'Platform subdomains are managed by this app. Tenant-owned domains are external in this phase.',
  customFuture: 'Custom domain hosting is future / support-assisted.',
  noLiveDns: 'No live DNS lookup in this phase.',
  pathsFuture: 'Customer-facing paths may be future / not active if their module route does not exist yet.',
  externalConfig: 'DNS and registrar configuration remain outside this app.',
  platformSubdomain: 'Platform subdomain is managed by this app.',
  externalSubdomain: 'External website / redirect — DNS and registrar configuration remain outside this app.',
} as const;

// ---------------------------------------------------------------------------
// Web address kind + status vocabulary (web-address-centric, not DNS-centric).
// ---------------------------------------------------------------------------

export type WebAddressKind = 'platform' | 'external';

export const WEB_ADDRESS_KIND_LABELS: Record<WebAddressKind, string> = {
  platform: 'Platform Web Address',
  external: 'External Website / Redirect',
};

export type WebAddressStatus =
  | 'active'
  | 'reserved'
  | 'needs_setup'
  | 'disabled'
  | 'external_only';

export const WEB_ADDRESS_STATUS_LABELS: Record<WebAddressStatus, string> = {
  active: 'Active',
  reserved: 'Reserved',
  needs_setup: 'Needs Setup',
  disabled: 'Disabled',
  external_only: 'External Only',
};

// ---------------------------------------------------------------------------
// Context — tenant name + slug lookups and the full domain set (so an external
// record can find its tenant's platform web address for redirect guidance).
// ---------------------------------------------------------------------------

export interface WebAddressContext {
  tenantNameById?: Record<string, string>;
  tenantSlugById?: Record<string, string>; // tenant.subdomain
  domains?: TenantDomainRecord[];
}

// ---------------------------------------------------------------------------
// Customer-facing links. Each derives from the platform web address. `live` is
// false this phase (no real routes), so Open is disabled but Copy is allowed.
// Going forward the Tenant Web Address should be the canonical URL source for
// the customer profile, booking, repair tracking, invoice payment links,
// mail-in repair, and the public portal.
// ---------------------------------------------------------------------------

export interface CustomerFacingLink {
  key: string;
  label: string;
  path: string; // '' for the main app root
  url: string;
  live: boolean;
  statusLabel: string;
}

interface CustomerLinkDef {
  key: string;
  label: string;
  path: string;
}

const CUSTOMER_LINK_DEFS: CustomerLinkDef[] = [
  { key: 'portal', label: 'Customer Portal', path: '/portal' },
  { key: 'book', label: 'Book Appointment', path: '/book' },
  { key: 'track', label: 'Track Repair', path: '/track' },
  { key: 'pay', label: 'Pay Invoice', path: '/pay' },
  { key: 'mailin', label: 'Mail-In Repair', path: '/mail-in' },
];

// deriveCustomerFacingLinks(platformWebAddress) — the portal/book/track/pay/
// mail-in links for a tenant's platform web address. Returns [] when there is
// no platform web address to build them from.
export function deriveCustomerFacingLinks(platformWebAddress: string | null): CustomerFacingLink[] {
  if (!platformWebAddress) return [];
  return CUSTOMER_LINK_DEFS.map(def => ({
    key: def.key,
    label: def.label,
    path: def.path,
    url: `https://${platformWebAddress}${def.path}`,
    live: WEB_ADDRESS_LIVE_HOSTING,
    statusLabel: WEB_ADDRESS_LIVE_HOSTING ? 'Active' : 'Future / Not active',
  }));
}

// ---------------------------------------------------------------------------
// Slug / platform-web-address derivation.
// ---------------------------------------------------------------------------

// deriveTenantSlug — for a platform subdomain the slug is the first hostname
// label; for an external record it comes from the tenant's `subdomain` slug.
export function deriveTenantSlug(domain: TenantDomainRecord, ctx?: WebAddressContext): string | null {
  if (domain.kind === 'subdomain') return domain.hostname.split('.')[0] || null;
  return ctx?.tenantSlugById?.[domain.tenantId] ?? null;
}

// derivePlatformWebAddress — the tenant's primary platform web address. For a
// platform subdomain it is the record's own hostname. For an external record it
// is the tenant's platform subdomain (so we can show a redirect target), found
// among the sibling domains or rebuilt from the slug.
export function derivePlatformWebAddress(
  domain: TenantDomainRecord,
  ctx: WebAddressContext | undefined,
  slug: string | null,
): string | null {
  if (domain.kind === 'subdomain') return domain.hostname;
  const sibling = (ctx?.domains ?? []).find(d => d.tenantId === domain.tenantId && d.kind === 'subdomain');
  if (sibling) return sibling.hostname;
  if (slug) return `${slug}.${PLATFORM_ROOT_SUFFIX}`;
  return null;
}

// ---------------------------------------------------------------------------
// Status + next action (web-address-centric, derived from the raw record).
// ---------------------------------------------------------------------------

export function deriveTenantWebAddressStatus(domain: TenantDomainRecord): WebAddressStatus {
  if (domain.status === 'disabled') return 'disabled';
  if (domain.kind === 'custom') return 'external_only';
  if (domain.status === 'verified') return 'active';
  return 'needs_setup'; // pending / verifying / failed platform subdomain
}

export function deriveTenantWebAddressNextAction(domain: TenantDomainRecord, status?: WebAddressStatus): string {
  const s = status ?? deriveTenantWebAddressStatus(domain);
  switch (s) {
    case 'disabled':
      return 'Re-enable the web address to restore tenant and customer access.';
    case 'external_only':
      return 'Redirect this external website to the platform web address (configured outside this app).';
    case 'needs_setup':
      return 'Finish setup — confirm the platform web address so customer-facing links go live.';
    case 'reserved':
      return 'Assign this reserved web address to activate it.';
    case 'active':
    default:
      return 'No action needed — the platform web address is active.';
  }
}

// ---------------------------------------------------------------------------
// External website / redirect guidance (custom records only).
// ---------------------------------------------------------------------------

export interface ExternalRedirectGuidance {
  hasExternal: boolean;
  externalWebsite: string | null;
  redirectTarget: string | null;
  explanation: string;
  customDomainSupport: string;
}

export function deriveExternalRedirectGuidance(
  domain: TenantDomainRecord,
  ctx: WebAddressContext | undefined,
  platformWebAddress: string | null,
): ExternalRedirectGuidance {
  const hasExternal = domain.kind === 'custom';
  return {
    hasExternal,
    externalWebsite: hasExternal ? domain.hostname : null,
    redirectTarget: platformWebAddress,
    explanation:
      'Tenant-owned websites and domains are configured outside this app. For now, redirect the tenant\u2019s website or root domain to the platform web address.',
    customDomainSupport: WEB_ADDRESS_TRUTH_LABELS.customFuture,
  };
}

// ---------------------------------------------------------------------------
// Setup checklist (manual, read-only guidance — no automation).
// ---------------------------------------------------------------------------

export type WebAddressChecklistState = 'done' | 'todo' | 'not_applicable';

export interface WebAddressChecklistItem {
  key: string;
  label: string;
  state: WebAddressChecklistState;
  hint?: string;
}

// ---------------------------------------------------------------------------
// The derived Tenant Web Address — the single source for the dashboard cards,
// table rows, saved-view counts, filter chips and the selected overview.
// ---------------------------------------------------------------------------

export interface TenantWebAddress {
  domainId: string;
  tenantId: string;
  tenant: string;
  kind: WebAddressKind;
  tenantSlug: string | null;
  platformWebAddress: string | null;
  mainAppUrl: string;
  rawHostname: string;
  rawStatus: DomainStatus;
  status: WebAddressStatus;
  statusLabel: string;
  externalWebsite: string | null;
  redirectTarget: string | null;
  hasExternalRedirect: boolean;
  customerLinks: CustomerFacingLink[];
  customerLinksAvailable: boolean;
  redirectGuidance: ExternalRedirectGuidance;
  checklist: WebAddressChecklistItem[];
  nextAction: string;
  truthLabels: string[];
}

function deriveChecklist(
  status: WebAddressStatus,
  slug: string | null,
  platformWebAddress: string | null,
  customerLinksAvailable: boolean,
  hasExternalRedirect: boolean,
): WebAddressChecklistItem[] {
  const linkState: WebAddressChecklistState = customerLinksAvailable ? 'done' : 'todo';
  return [
    { key: 'slug', label: 'Tenant slug assigned', state: slug ? 'done' : 'todo' },
    { key: 'web_address', label: 'Platform web address generated', state: platformWebAddress ? 'done' : 'todo' },
    { key: 'portal', label: 'Customer portal link available', state: linkState, hint: 'Copyable now; the live route is future / not active.' },
    { key: 'book', label: 'Booking link available', state: linkState },
    { key: 'track', label: 'Repair tracking link available', state: linkState },
    { key: 'pay', label: 'Payment link available', state: linkState },
    {
      key: 'external',
      label: 'External redirect guidance reviewed',
      state: hasExternalRedirect ? (status === 'disabled' ? 'todo' : 'done') : 'not_applicable',
      hint: hasExternalRedirect ? 'Redirect the external website to the platform web address.' : 'No external website on file.',
    },
  ];
}

// deriveTenantWebAddress(domain, ctx) — the pure per-record derivation.
export function deriveTenantWebAddress(domain: TenantDomainRecord, ctx?: WebAddressContext): TenantWebAddress {
  const kind: WebAddressKind = domain.kind === 'subdomain' ? 'platform' : 'external';
  const tenant = ctx?.tenantNameById?.[domain.tenantId] ?? domain.tenantId;
  const slug = deriveTenantSlug(domain, ctx);
  const platformWebAddress = derivePlatformWebAddress(domain, ctx, slug);
  const status = deriveTenantWebAddressStatus(domain);
  const customerLinks = deriveCustomerFacingLinks(platformWebAddress);
  const customerLinksAvailable = !!platformWebAddress && status !== 'disabled';
  const redirectGuidance = deriveExternalRedirectGuidance(domain, ctx, platformWebAddress);
  const hasExternalRedirect = redirectGuidance.hasExternal;
  return {
    domainId: domain.id,
    tenantId: domain.tenantId,
    tenant,
    kind,
    tenantSlug: slug,
    platformWebAddress,
    mainAppUrl: platformWebAddress ? `https://${platformWebAddress}` : '',
    rawHostname: domain.hostname,
    rawStatus: domain.status,
    status,
    statusLabel: WEB_ADDRESS_STATUS_LABELS[status],
    externalWebsite: redirectGuidance.externalWebsite,
    redirectTarget: redirectGuidance.redirectTarget,
    hasExternalRedirect,
    customerLinks,
    customerLinksAvailable,
    redirectGuidance,
    checklist: deriveChecklist(status, slug, platformWebAddress, customerLinksAvailable, hasExternalRedirect),
    nextAction: deriveTenantWebAddressNextAction(domain, status),
    truthLabels: [
      WEB_ADDRESS_TRUTH_LABELS.platformManaged,
      WEB_ADDRESS_TRUTH_LABELS.customFuture,
    ],
  };
}

// deriveTenantWebAddresses(domains, ctx) — the full list (one entry per record).
export function deriveTenantWebAddresses(domains: TenantDomainRecord[], ctx?: WebAddressContext): TenantWebAddress[] {
  return domains.map(d => deriveTenantWebAddress(d, ctx));
}
