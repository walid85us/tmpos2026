// Phase 2.0 M7C — BCP DEV-only read-only pilot: SYNTHETIC C-01 Readiness Summary DTO + mapper harness.
//
// WHAT THIS IS: a PURE, NO-THROW response builder for the FUTURE C-01 readiness summary. It takes a
// guard decision (from bcpAuthorizationGuard) plus a SYNTHETIC posture source and returns the M3
// already-redacted DTO envelope. It reads NOTHING live: no DB, no Supabase, no provider, no real data.
//
// BINDING SAFETY:
//   - Redaction happens BEFORE return; the mapper never passes a raw source object through.
//   - Forbidden fields (raw ids, secrets, tokens, DB URLs, emails, identity_link rows, permission/
//     entitlement keys, mismatch lists) are BLOCKED — stripped and reported as omitted CATEGORIES
//     (generic category labels, never the raw field name or value).
//   - Allow-listed label strings (category/status) are CONTENT-VALIDATED: any value that is not a
//     safe bounded label (e.g. contains '@', '://', or out-of-charset chars) is replaced with a
//     'redacted_label' sentinel, so a forbidden value cannot leak through an allowed field.
//   - Fail closed: any non-'allow' guard decision yields a safe denied/blocked empty envelope (no data).
//   - Empty input yields a safe empty-state envelope (empty indistinguishable from hidden).
//
// No-throw for well-typed inputs (the TypeScript types are the contract). Server-side only. Never
// imported by src/. Inert/dormant in M7C (imported only by the harness/tests).

import type { GuardResult } from './bcpAuthorizationGuard';

export const BCP_READINESS_SCHEMA_VERSION = 'bcp.c01.readiness.v0-synthetic';

export type EnvLabel = 'DEV' | 'STAGING';
export type RedactionLevel = 'none' | 'standard' | 'strict';
export type EmptyStateReason =
  | 'none'
  | 'no_visible_records'
  | 'blocked_by_phase'
  | 'blocked_by_schema'
  | 'not_authorized'
  | 'redacted';

export interface BcpReadinessCategory {
  /** Safe posture label only — never a raw id/name. */
  category: string;
  status: string;
  severity: 'low' | 'medium' | 'high';
}

export interface BcpDtoRedaction {
  redactionApplied: boolean;
  redactionLevel: RedactionLevel;
  /** Categories (not field names) that were omitted because they were forbidden/sensitive. */
  omittedCategories: string[];
  /** Categories that were masked (none expected for C-01 posture labels). */
  maskedCategories: string[];
}

export interface BcpDtoFreshness {
  generatedAt: string;
  lastSuccessfulReadLabel: string;
}

/** Posture labels ONLY — never raw role/user/tenant/store ids. */
export interface BcpDtoAuthorizationContext {
  visibilityClass: string;
  scopeType: string;
  environment: EnvLabel;
  parityState: string;
}

export interface BcpDtoEmptyState {
  isEmpty: boolean;
  reason: EmptyStateReason;
}

export interface BcpReadinessSummaryEnvelope {
  schemaVersion: string;
  environment: EnvLabel;
  generatedAt: string;
  data: { categories: BcpReadinessCategory[] } | null;
  redaction: BcpDtoRedaction;
  freshness: BcpDtoFreshness;
  authorizationContext: BcpDtoAuthorizationContext;
  emptyState: BcpDtoEmptyState;
  warnings: string[];
}

/** Posture-label context the caller supplies (safe labels only; no raw ids). */
export interface ReadinessAuthLabels {
  visibilityClass: string;
  scopeType: string;
  parityState: string;
}

/**
 * SYNTHETIC posture source. In M7C this is only ever built by the test harness. It is deliberately
 * permissive (Record) so tests can inject FORBIDDEN keys and prove the mapper strips them.
 */
export type SyntheticReadinessSource = Record<string, unknown> & {
  categories?: Array<Record<string, unknown>>;
};

/**
 * Keys that must NEVER appear in output. Presence ⇒ stripped, and reported only as a GENERIC
 * CATEGORY (never the raw field name or value), per the M4 §8 redaction-metadata rule.
 */
const FORBIDDEN_KEY_CATEGORY: Record<string, string> = {
  rawId: 'raw_identifier',
  internalUserId: 'raw_identifier',
  tenantId: 'tenant_scope_id',
  storeId: 'tenant_scope_id',
  customerId: 'tenant_scope_id',
  email: 'pii',
  providerUid: 'provider_identity',
  authProviderUid: 'provider_identity',
  identityLinkRow: 'identity_internal',
  secret: 'secret_material',
  token: 'secret_material',
  accessToken: 'secret_material',
  refreshToken: 'secret_material',
  dbUrl: 'connection_string',
  databaseUrl: 'connection_string',
  paymentId: 'payment_identifier',
  cardNumber: 'payment_identifier',
  permissionKeys: 'authorization_keys',
  entitlementKeys: 'authorization_keys',
  mismatchList: 'mismatch_detail',
  rawAuditEvent: 'raw_audit',
};

const SAFE_SEVERITIES = new Set(['low', 'medium', 'high']);

/** A safe bounded label: short, conservative charset, and free of '@' / '://' / whitespace tricks. */
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Returns a safe label, or the 'redacted_label' sentinel when the value is unsafe to emit. */
function safeLabel(value: unknown): { value: string; safe: boolean } {
  if (typeof value !== 'string') return { value: 'unknown', safe: true };
  if (!SAFE_LABEL_RE.test(value)) return { value: 'redacted_label', safe: false };
  return { value, safe: true };
}

const baseRedaction = (level: RedactionLevel, omitted: string[]): BcpDtoRedaction => ({
  redactionApplied: true,
  redactionLevel: level,
  omittedCategories: omitted,
  maskedCategories: [],
});

/**
 * Build the C-01 readiness summary envelope. PURE + FAIL-CLOSED + redaction-before-return.
 *
 * @param guard      decision from authorizeBcpRead(); anything other than 'allow' ⇒ safe empty.
 * @param source     SYNTHETIC posture source (test-only). May contain forbidden keys; they are stripped.
 * @param authLabels safe posture labels for the authorizationContext block.
 * @param generatedAt safe server-time placeholder string (no sensitive timing).
 */
export function buildReadinessSummaryEnvelope(
  guard: GuardResult,
  source: SyntheticReadinessSource,
  authLabels: ReadinessAuthLabels,
  generatedAt: string,
  environment: EnvLabel = 'DEV',
): BcpReadinessSummaryEnvelope {
  // Validate caller-supplied timestamp; never echo an arbitrary unbounded string.
  const safeGeneratedAt = ISO_TS_RE.test(generatedAt) ? generatedAt : 'redacted-timestamp';
  // authorizationContext carries posture labels ONLY — each is content-validated.
  const authorizationContext: BcpDtoAuthorizationContext = {
    visibilityClass: safeLabel(authLabels.visibilityClass).value,
    scopeType: safeLabel(authLabels.scopeType).value,
    environment,
    parityState: safeLabel(authLabels.parityState).value,
  };
  const freshness: BcpDtoFreshness = {
    generatedAt: safeGeneratedAt,
    lastSuccessfulReadLabel: 'synthetic-no-live-read',
  };

  // FAIL CLOSED: never emit data unless the guard explicitly allowed.
  if (guard.decision !== 'allow') {
    const reason: EmptyStateReason = guard.decision === 'blocked' ? 'blocked_by_phase' : 'not_authorized';
    return {
      schemaVersion: BCP_READINESS_SCHEMA_VERSION,
      environment,
      generatedAt: safeGeneratedAt,
      data: null,
      redaction: baseRedaction('strict', []),
      freshness,
      authorizationContext,
      emptyState: { isEmpty: true, reason },
      warnings: ['synthetic'],
    };
  }

  // Detect + strip forbidden source keys (top level and per-category). Report only GENERIC
  // categories (never the raw key name or value).
  const omitted = new Set<string>();
  const scanForbidden = (obj: Record<string, unknown>) => {
    for (const k of Object.keys(FORBIDDEN_KEY_CATEGORY)) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) omitted.add(FORBIDDEN_KEY_CATEGORY[k]);
    }
  };
  scanForbidden(source);

  const rawCategories = Array.isArray(source.categories) ? source.categories : [];
  const categories: BcpReadinessCategory[] = [];
  for (const rc of rawCategories) {
    scanForbidden(rc);
    // Copy ONLY the safe, allow-listed fields — never spread the raw source object — and
    // content-validate each label so a forbidden value embedded in an allowed field cannot leak.
    const cat = safeLabel(rc.category);
    const st = safeLabel(rc.status);
    if (!cat.safe || !st.safe) omitted.add('sensitive_label_content');
    const severityRaw = typeof rc.severity === 'string' ? rc.severity : 'low';
    const severity = (SAFE_SEVERITIES.has(severityRaw) ? severityRaw : 'low') as 'low' | 'medium' | 'high';
    categories.push({ category: cat.value, status: st.value, severity });
  }

  const omittedList = [...omitted];
  const isEmpty = categories.length === 0;

  return {
    schemaVersion: BCP_READINESS_SCHEMA_VERSION,
    environment,
    generatedAt: safeGeneratedAt,
    data: isEmpty ? null : { categories },
    redaction: baseRedaction(omittedList.length > 0 ? 'strict' : 'standard', omittedList),
    freshness,
    authorizationContext,
    emptyState: isEmpty
      ? { isEmpty: true, reason: 'no_visible_records' }
      : { isEmpty: false, reason: 'none' },
    warnings: ['synthetic'],
  };
}
