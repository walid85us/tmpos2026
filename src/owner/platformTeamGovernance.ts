// =============================================================================
// Phase 1.3 — Milestone 1: Platform Team Governance Model (ADDITIVE / NON-ENFORCING)
//
// This module is a PURE, additive governance MODEL. It introduces types,
// constants, and deterministic helper functions that LATER Phase 1.3 milestones
// (Directory + Role Matrix UI, Temporary Access / PIM, Access Review, Command
// Center / Audit integration) can build on.
//
// TRUTHFUL LIMITATIONS — what this module is NOT, today:
//   - It does NOT change any current permission behavior. It reuses the
//     resolver model in `platformPermissionsConfig.ts` (never forks it) and
//     touches none of its functions.
//   - It does NOT enforce anything. Every output here is an ADVISORY LABEL or
//     RECOMMENDATION — it must never block an action or alter access.
//   - Current platform access remains UI/client-gated only. Server-side
//     enforcement remains future work.
//   - There is NO persistence, NO UI, NO workflow, NO scheduler, NO automatic
//     revocation, and NO automatic expiration. Temporary-access and
//     access-review status are DERIVED / LAZY only (computed from inputs).
//   - Future role concepts (Read-only Auditor, Platform Admin) are documented
//     as future/deferred concepts only — they are NOT active roles and are NOT
//     wired into the resolver, defaults, or any matrix.
//
// See docs/phase-1.3-platform-team-governance-model.md for the model narrative
// and docs/phase-1.3-platform-access-inventory.md for the Milestone 0 source.
// =============================================================================

import type { PermissionLevel } from '../types';
import type { Role } from '../context/accessConfig';
import { PLATFORM_ROLE_DISPLAY_LABEL } from './platformPermissionsConfig';

// ---------------------------------------------------------------------------
// Model status banner (advisory copy reused by docs / future surfaces).
// ---------------------------------------------------------------------------

export const PLATFORM_GOVERNANCE_MODEL_STATUS =
  'Advisory governance model only — non-enforcing. Current platform access is UI/client-gated; ' +
  'server-side enforcement, PIM, access-review workflows, and automatic expiration are future/deferred work. ' +
  'No persistence, no scheduler, no workflow active in this milestone.';

// ---------------------------------------------------------------------------
// 1. Platform role ids (subset of the shared Role union — NOT a new role set).
// ---------------------------------------------------------------------------

/** The five CURRENT platform roles. Subset of `Role`; introduces no new roles. */
export type PlatformRoleId =
  | 'system_owner'
  | 'support_admin'
  | 'billing_admin'
  | 'operations_admin'
  | 'security_admin';

const PLATFORM_ROLE_IDS: PlatformRoleId[] = [
  'system_owner',
  'support_admin',
  'billing_admin',
  'operations_admin',
  'security_admin',
];

/** Type guard: is this `Role` one of the current platform roles? */
export function isPlatformRoleId(role: Role | string | null | undefined): role is PlatformRoleId {
  return !!role && (PLATFORM_ROLE_IDS as string[]).includes(role);
}

// ---------------------------------------------------------------------------
// 2. Governance categories (LABELS ONLY — never alter access behavior).
// ---------------------------------------------------------------------------

export type GovernanceCategory =
  | 'system_owner'
  | 'platform_admin_ops'
  | 'support_operations'
  | 'billing_operations'
  | 'security_audit'
  | 'future_read_only_audit'
  | 'future_temporary_elevation';

export const GOVERNANCE_CATEGORY_LABEL: Record<GovernanceCategory, string> = {
  system_owner: 'System Owner',
  platform_admin_ops: 'Platform Admin / Operations',
  support_operations: 'Support Operations',
  billing_operations: 'Billing Operations',
  security_audit: 'Security & Audit',
  future_read_only_audit: 'Read-only Audit (future / deferred)',
  future_temporary_elevation: 'Temporary Elevation (future / deferred)',
};

// ---------------------------------------------------------------------------
// 3. Risk posture + review cadence labels.
// ---------------------------------------------------------------------------

export type RiskPosture = 'critical' | 'high' | 'elevated' | 'moderate';

export const RISK_POSTURE_LABEL: Record<RiskPosture, string> = {
  critical: 'Critical',
  high: 'High',
  elevated: 'Elevated',
  moderate: 'Moderate',
};

export type ReviewCadence =
  | 'continuous_high_assurance'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

export const REVIEW_CADENCE_LABEL: Record<ReviewCadence, string> = {
  continuous_high_assurance: 'Continuous / high-assurance',
  quarterly: 'Quarterly',
  semiannual: 'Semi-annual',
  annual: 'Annual',
};

/** Advisory window (ms) used only for DERIVED overdue hints — not a scheduler. */
const REVIEW_CADENCE_WINDOW_MS: Record<ReviewCadence, number> = {
  continuous_high_assurance: 30 * 24 * 60 * 60 * 1000,
  quarterly: 90 * 24 * 60 * 60 * 1000,
  semiannual: 182 * 24 * 60 * 60 * 1000,
  annual: 365 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// 4. Current role catalog metadata (documents current roles; changes nothing).
// ---------------------------------------------------------------------------

export interface PlatformRoleGovernanceMeta {
  id: PlatformRoleId;
  displayLabel: string;
  purpose: string;
  governanceCategory: GovernanceCategory;
  /** System Owner is system-protected and must never be downgraded/reconciled. */
  systemProtected: boolean;
  includeInAccessReview: boolean;
  /** Future eligibility only — no temporary-elevation workflow exists today. */
  eligibleForTemporaryElevation: boolean;
  reviewCadence: ReviewCadence;
  riskPosture: RiskPosture;
  notes: string;
}

export const PLATFORM_ROLE_CATALOG: Record<PlatformRoleId, PlatformRoleGovernanceMeta> = {
  system_owner: {
    id: 'system_owner',
    displayLabel: PLATFORM_ROLE_DISPLAY_LABEL.system_owner,
    purpose:
      'Unrestricted platform super-administrator. Locked at Full Access across every feature group; ' +
      'the resolver short-circuits to allow and reconciliation never touches it.',
    governanceCategory: 'system_owner',
    systemProtected: true,
    includeInAccessReview: true,
    eligibleForTemporaryElevation: false,
    reviewCadence: 'continuous_high_assurance',
    riskPosture: 'critical',
    notes:
      'Never downgrade, reconcile, or temporarily impersonate. Highest-privilege account — review focuses on ' +
      'existence/ownership rather than level changes.',
  },
  operations_admin: {
    id: 'operations_admin',
    displayLabel: PLATFORM_ROLE_DISPLAY_LABEL.operations_admin,
    purpose:
      'Broad platform operations: full tenant management, provisioning, and tenant web address; manage on ' +
      'command center / support / feature matrix; edit platform settings.',
    governanceCategory: 'platform_admin_ops',
    systemProtected: false,
    includeInAccessReview: true,
    eligibleForTemporaryElevation: true,
    reviewCadence: 'quarterly',
    riskPosture: 'high',
    notes:
      'Broadest non-owner role. Provisioning + tenant lifecycle make it a strong future PIM candidate.',
  },
  support_admin: {
    id: 'support_admin',
    displayLabel: PLATFORM_ROLE_DISPLAY_LABEL.support_admin,
    purpose:
      'Front-line support operations. Owns Support Tools; broad read access elsewhere.',
    governanceCategory: 'support_operations',
    systemProtected: false,
    includeInAccessReview: true,
    eligibleForTemporaryElevation: true,
    reviewCadence: 'quarterly',
    riskPosture: 'elevated',
    notes:
      'Future temporary-elevation candidate for escalate-any / manage-macros during incidents.',
  },
  billing_admin: {
    id: 'billing_admin',
    displayLabel: PLATFORM_ROLE_DISPLAY_LABEL.billing_admin,
    purpose:
      'Billing & commercial operations. Owns Billing & Subscriptions; manage on Feature Matrix and Add-on Governance.',
    governanceCategory: 'billing_operations',
    systemProtected: false,
    includeInAccessReview: true,
    eligibleForTemporaryElevation: true,
    reviewCadence: 'quarterly',
    riskPosture: 'high',
    notes:
      'Financial-impact role. Reason capture + audit recommended for refund / override actions in future milestones.',
  },
  security_admin: {
    id: 'security_admin',
    displayLabel: PLATFORM_ROLE_DISPLAY_LABEL.security_admin,
    purpose:
      'Security, audit, and platform-governance oversight. Full Audit & Security; manage Team Management and Platform Settings.',
    governanceCategory: 'security_audit',
    systemProtected: false,
    includeInAccessReview: true,
    eligibleForTemporaryElevation: true,
    reviewCadence: 'quarterly',
    riskPosture: 'high',
    notes:
      'Can manage team + platform settings. Separation-of-duties reviews recommended in future milestones.',
  },
};

// ---------------------------------------------------------------------------
// Future role concepts — DOCUMENTED ONLY. Not active roles, not wired anywhere.
// ---------------------------------------------------------------------------

export interface FutureRoleConcept {
  id: string;
  displayLabel: string;
  purpose: string;
  governanceCategory: GovernanceCategory;
  status: 'future_deferred';
}

export const FUTURE_ROLE_CONCEPTS: FutureRoleConcept[] = [
  {
    id: 'read_only_auditor',
    displayLabel: 'Read-only Auditor',
    purpose:
      'Future concept: read-only visibility into audit/security surfaces with no mutation rights. Not implemented.',
    governanceCategory: 'future_read_only_audit',
    status: 'future_deferred',
  },
  {
    id: 'platform_admin',
    displayLabel: 'Platform Admin',
    purpose:
      'Future concept: a formalized broad platform-admin tier distinct from operations_admin. Not implemented.',
    governanceCategory: 'platform_admin_ops',
    status: 'future_deferred',
  },
];

// ---------------------------------------------------------------------------
// 5. Server-side enforcement boundary labels (advisory; mirror Milestone 0 tiers).
// ---------------------------------------------------------------------------

export type ServerEnforcementBoundaryLabel =
  | 'ui_only_currently'
  | 'future_server_validation_recommended'
  | 'future_server_validation_strongly_required'
  | 'future_privileged_pim_controlled_server_action';

export const SERVER_ENFORCEMENT_BOUNDARY_LABEL: Record<ServerEnforcementBoundaryLabel, string> = {
  ui_only_currently: 'UI/client-gated only (acceptable for now)',
  future_server_validation_recommended: 'Future server validation recommended',
  future_server_validation_strongly_required: 'Future server validation strongly required before production',
  future_privileged_pim_controlled_server_action: 'Future privileged / PIM-controlled server action',
};

// ---------------------------------------------------------------------------
// 6. Privileged / sensitive action categories (typed catalog from Milestone 0).
// ---------------------------------------------------------------------------

export type PrivilegedActionCategory =
  | 'platform_role_change'
  | 'platform_sub_permission_override'
  | 'platform_feature_level_override'
  | 'temporary_access_grant'
  | 'temporary_access_expiry'
  | 'access_review_completion'
  | 'tenant_lifecycle_change'
  | 'billing_subscription_change'
  | 'addon_governance_change'
  | 'platform_settings_change'
  | 'provisioning_lifecycle_change'
  | 'support_admin_intervention'
  | 'audit_security_sensitive_action'
  | 'paid_override_action';

/** Truthful current-state of a category's tooling (audit/workflow may exist; enforcement does not). */
export type PrivilegedActionImplementationStatus = 'future_deferred' | 'partially_active_today';

export interface PrivilegedActionMeta {
  category: PrivilegedActionCategory;
  displayLabel: string;
  description: string;
  futureEnforcementTier: ServerEnforcementBoundaryLabel;
  reasonRequiredRecommended: boolean;
  auditRecommended: boolean;
  pimRecommended: boolean;
  futureServerValidationNeed: string;
  implementationStatus: PrivilegedActionImplementationStatus;
  /** Honest note on what (if anything) is real today vs. deferred. */
  currentReality: string;
}

export const PRIVILEGED_ACTION_CATALOG: Record<PrivilegedActionCategory, PrivilegedActionMeta> = {
  platform_role_change: {
    category: 'platform_role_change',
    displayLabel: 'Platform Role Change',
    description: 'Assigning or changing a platform team member’s role.',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server must authorize and audit role changes; System Owner protected.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; matrix changes emit an audit row today, but no server enforcement exists.',
  },
  platform_sub_permission_override: {
    category: 'platform_sub_permission_override',
    displayLabel: 'Sub-permission Override',
    description: 'Overriding a single platform sub-permission for a role.',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-validated write reusing the resolver + reconcile rules.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; session override + audit only. Reconcile is write-time, client-side.',
  },
  platform_feature_level_override: {
    category: 'platform_feature_level_override',
    displayLabel: 'Feature-level Override',
    description: 'Overriding a platform feature-group level for a role.',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-validated write reusing the resolver + reconcile rules.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; session override + audit only.',
  },
  temporary_access_grant: {
    category: 'temporary_access_grant',
    displayLabel: 'Temporary Access Grant',
    description: 'Granting time-boxed elevated access to a platform user.',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-issued, time-boxed, reason-required, audited; derived expiry until a scheduler exists.',
    implementationStatus: 'future_deferred',
    currentReality: 'Not implemented. No workflow, no persistence, no scheduler.',
  },
  temporary_access_expiry: {
    category: 'temporary_access_expiry',
    displayLabel: 'Temporary Access Expiry',
    description: 'Expiration of a temporary access grant.',
    futureEnforcementTier: 'future_server_validation_strongly_required',
    reasonRequiredRecommended: false,
    auditRecommended: true,
    pimRecommended: false,
    futureServerValidationNeed: 'Server-side expiry enforcement; today expiry is derived/lazy only — no scheduler.',
    implementationStatus: 'future_deferred',
    currentReality: 'Not implemented. Derived/lazy status only; no automatic revocation.',
  },
  access_review_completion: {
    category: 'access_review_completion',
    displayLabel: 'Access Review Completion',
    description: 'Recording the outcome of a platform access review.',
    futureEnforcementTier: 'future_server_validation_strongly_required',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: false,
    futureServerValidationNeed: 'Server-recorded reviewer + timestamp; rule-based stale flag.',
    implementationStatus: 'future_deferred',
    currentReality: 'Not implemented. No review workflow exists.',
  },
  tenant_lifecycle_change: {
    category: 'tenant_lifecycle_change',
    displayLabel: 'Tenant Lifecycle Change',
    description: 'Suspending, reactivating, or otherwise changing tenant state.',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-validated, audited tenant-state mutation.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; audited today, but no server enforcement.',
  },
  billing_subscription_change: {
    category: 'billing_subscription_change',
    displayLabel: 'Billing / Subscription Change',
    description: 'Editing subscriptions or approving billing actions (refunds, credits, write-offs).',
    futureEnforcementTier: 'future_server_validation_strongly_required',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-validated, audited financial approval.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; financial actions audited today, but no server enforcement.',
  },
  addon_governance_change: {
    category: 'addon_governance_change',
    displayLabel: 'Add-on Governance Change',
    description: 'Catalog / override changes in Commercial Controls (excluding paid overrides).',
    futureEnforcementTier: 'future_server_validation_strongly_required',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: false,
    futureServerValidationNeed: 'Server-validated, audited commercial governance writes.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; audited today, but no server enforcement.',
  },
  platform_settings_change: {
    category: 'platform_settings_change',
    displayLabel: 'Platform Settings Change',
    description: 'Saving platform-wide configuration.',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-validated, audited platform-wide config writes.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; one audit row per group save today, but nothing enforced at runtime.',
  },
  provisioning_lifecycle_change: {
    category: 'provisioning_lifecycle_change',
    displayLabel: 'Provisioning Lifecycle Change',
    description: 'Running provisioning / environment seeding.',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-validated, privileged provisioning operations.',
    implementationStatus: 'future_deferred',
    currentReality: 'UI-gated; no server enforcement.',
  },
  support_admin_intervention: {
    category: 'support_admin_intervention',
    displayLabel: 'Support / Admin Intervention',
    description: 'Escalation overrides, ownership reassignment, override-close, impersonation links.',
    futureEnforcementTier: 'future_server_validation_strongly_required',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: false,
    futureServerValidationNeed: 'Server-validated, audited intervention actions.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; escalation lifecycle is audited today, but no server enforcement.',
  },
  audit_security_sensitive_action: {
    category: 'audit_security_sensitive_action',
    displayLabel: 'Sensitive Audit / Security Action',
    description: 'Audit export, restricted-detail access, security-note deletion.',
    futureEnforcementTier: 'future_server_validation_strongly_required',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: false,
    futureServerValidationNeed: 'Server-side authorization for restricted reads + destructive writes.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; append-only audit overlay today, but no server enforcement.',
  },
  paid_override_action: {
    category: 'paid_override_action',
    displayLabel: 'Paid Override Action',
    description: 'Granting / revoking paid commercial overrides (ties to the locked paid-override invoice workflow).',
    futureEnforcementTier: 'future_privileged_pim_controlled_server_action',
    reasonRequiredRecommended: true,
    auditRecommended: true,
    pimRecommended: true,
    futureServerValidationNeed: 'Server-validated, audited financial override; invoice workflow integrity preserved.',
    implementationStatus: 'partially_active_today',
    currentReality: 'UI-gated; paid-override invoice workflow + audit exist today, but no server enforcement.',
  },
};

// ---------------------------------------------------------------------------
// 7. Temporary Access types (FUTURE USE ONLY — derived/lazy, no persistence).
// ---------------------------------------------------------------------------

export type TemporaryAccessStatus =
  | 'requested'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'denied'
  | 'cancelled';

export const TEMPORARY_ACCESS_STATUS_LABEL: Record<TemporaryAccessStatus, string> = {
  requested: 'Requested',
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

export interface TemporaryAccessGrant {
  id: string;
  subjectUserId: string;
  subjectName: string;
  subjectEmail: string;
  baseRoleId: PlatformRoleId;
  /** Either an elevated role or an explicit permission scope (future use). */
  elevatedRoleId?: PlatformRoleId;
  elevatedPermissionScope?: string;
  requestedBy: string;
  approvedBy?: string;
  reason: string;
  startsAt: string;
  expiresAt: string;
  /** Stored status; the DERIVED status (see getTemporaryAccessStatus) wins for display. */
  status: TemporaryAccessStatus;
  createdAt: string;
  updatedAt: string;
  source: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// 8. Access Review types (FUTURE USE ONLY — no workflow, no persistence).
// ---------------------------------------------------------------------------

export type AccessReviewStatus =
  | 'pending'
  | 'reviewed_no_change'
  | 'reviewed_change_required'
  | 'escalated'
  | 'overdue'
  | 'deferred';

export const ACCESS_REVIEW_STATUS_LABEL: Record<AccessReviewStatus, string> = {
  pending: 'Pending Review',
  reviewed_no_change: 'Reviewed — No Change',
  reviewed_change_required: 'Reviewed — Change Required',
  escalated: 'Escalated',
  overdue: 'Overdue',
  deferred: 'Deferred',
};

export interface AccessReviewRecord {
  id: string;
  reviewPeriod: string;
  reviewerId: string;
  reviewerName: string;
  reviewedSubjectId: string;
  reviewedSubjectName: string;
  reviewedRoleId: Role;
  reviewStatus: AccessReviewStatus;
  reviewedAt?: string;
  findings?: string;
  actionRequired?: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal time helper (pure).
// ---------------------------------------------------------------------------

type TimeInput = string | number | Date;

function toMs(t: TimeInput | null | undefined): number {
  if (t == null) return NaN;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  return Date.parse(t);
}

function relativeFromNow(targetMs: number, nowMs: number): string {
  if (!Number.isFinite(targetMs)) return '';
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  let mag: string;
  if (abs >= day) mag = `${Math.round(abs / day)}d`;
  else if (abs >= hour) mag = `${Math.round(abs / hour)}h`;
  else mag = '<1h';
  return diff >= 0 ? `in ${mag}` : `${mag} ago`;
}

// ---------------------------------------------------------------------------
// 9. Temporary-access derivation helpers (pure; status is derived/lazy only).
// ---------------------------------------------------------------------------

/**
 * Derives the effective temporary-access status WITHOUT any side effects.
 * Terminal stored states (revoked/denied/cancelled) win; otherwise the window
 * [startsAt, expiresAt) is evaluated against `now`. There is no scheduler and
 * no automatic revocation — this is a read-time computation only.
 */
export function getTemporaryAccessStatus(
  grant: TemporaryAccessGrant,
  now: number = Date.now()
): TemporaryAccessStatus {
  if (grant.status === 'revoked' || grant.status === 'denied' || grant.status === 'cancelled') {
    return grant.status;
  }
  const end = toMs(grant.expiresAt);
  if (Number.isFinite(end) && now >= end) return 'expired';
  if (grant.status === 'requested') return 'requested';
  const start = toMs(grant.startsAt);
  if (Number.isFinite(start) && now < start) return 'requested';
  return 'active';
}

export function isTemporaryAccessActive(grant: TemporaryAccessGrant, now: number = Date.now()): boolean {
  return getTemporaryAccessStatus(grant, now) === 'active';
}

export function isTemporaryAccessExpired(grant: TemporaryAccessGrant, now: number = Date.now()): boolean {
  return getTemporaryAccessStatus(grant, now) === 'expired';
}

/** Advisory display label, e.g. "Active — expires in 3d". Pure. */
export function getTemporaryAccessDisplayLabel(
  grant: TemporaryAccessGrant,
  now: number = Date.now()
): string {
  const status = getTemporaryAccessStatus(grant, now);
  const base = TEMPORARY_ACCESS_STATUS_LABEL[status];
  if (status === 'active') {
    const rel = relativeFromNow(toMs(grant.expiresAt), now);
    return rel ? `${base} — expires ${rel}` : base;
  }
  if (status === 'requested') {
    const start = toMs(grant.startsAt);
    if (Number.isFinite(start) && now < start) {
      const rel = relativeFromNow(start, now);
      return rel ? `${base} — starts ${rel}` : base;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// 10. Access-review derivation helpers (pure; advisory only).
// ---------------------------------------------------------------------------

/**
 * Derives whether a review is overdue based on the reviewed role's recommended
 * cadence window. Completed reviews are never overdue. Advisory only — there is
 * no scheduler and nothing is enforced.
 */
export function isAccessReviewOverdue(record: AccessReviewRecord, now: number = Date.now()): boolean {
  if (record.reviewStatus === 'overdue') return true;
  // Only an open 'pending' review ages into overdue. Every other status is an
  // explicit, label-preserving state — completed (reviewed_*), escalated, and
  // deferred must NEVER auto-flip to overdue ("terminal/explicit states win").
  if (record.reviewStatus !== 'pending') return false;
  const base = Number.isFinite(toMs(record.reviewedAt)) ? toMs(record.reviewedAt) : toMs(record.createdAt);
  if (!Number.isFinite(base)) return false;
  const cadence: ReviewCadence = isPlatformRoleId(record.reviewedRoleId)
    ? PLATFORM_ROLE_CATALOG[record.reviewedRoleId].reviewCadence
    : 'annual';
  return now > base + REVIEW_CADENCE_WINDOW_MS[cadence];
}

export function getAccessReviewStatusLabel(record: AccessReviewRecord, now: number = Date.now()): string {
  // isAccessReviewOverdue only returns true for an explicit 'overdue' status or
  // an aged 'pending' review, so this override never clobbers escalated/deferred/reviewed_*.
  if (isAccessReviewOverdue(record, now)) return ACCESS_REVIEW_STATUS_LABEL.overdue;
  return ACCESS_REVIEW_STATUS_LABEL[record.reviewStatus];
}

export function shouldIncludeRoleInAccessReview(roleId: Role | PlatformRoleId): boolean {
  return isPlatformRoleId(roleId) ? PLATFORM_ROLE_CATALOG[roleId].includeInAccessReview : false;
}

/** Returns the recommended review cadence LABEL for a role (advisory). */
export function getRecommendedReviewCadence(roleId: Role | PlatformRoleId): string {
  if (!isPlatformRoleId(roleId)) return REVIEW_CADENCE_LABEL.annual;
  return REVIEW_CADENCE_LABEL[PLATFORM_ROLE_CATALOG[roleId].reviewCadence];
}

// ---------------------------------------------------------------------------
// 11. Role risk / governance summary helpers (pure; labels only).
// ---------------------------------------------------------------------------

/** Returns the role's risk-posture LABEL (advisory). */
export function getRoleRiskPosture(roleId: Role | PlatformRoleId): string {
  if (!isPlatformRoleId(roleId)) return RISK_POSTURE_LABEL.moderate;
  return RISK_POSTURE_LABEL[PLATFORM_ROLE_CATALOG[roleId].riskPosture];
}

export interface RoleGovernanceSummary {
  id: PlatformRoleId;
  displayLabel: string;
  governanceCategoryLabel: string;
  riskPostureLabel: string;
  reviewCadenceLabel: string;
  systemProtected: boolean;
  includeInAccessReview: boolean;
  eligibleForTemporaryElevation: boolean;
  summary: string;
}

export function getRoleGovernanceSummary(roleId: PlatformRoleId): RoleGovernanceSummary {
  const meta = PLATFORM_ROLE_CATALOG[roleId];
  return {
    id: meta.id,
    displayLabel: meta.displayLabel,
    governanceCategoryLabel: GOVERNANCE_CATEGORY_LABEL[meta.governanceCategory],
    riskPostureLabel: RISK_POSTURE_LABEL[meta.riskPosture],
    reviewCadenceLabel: REVIEW_CADENCE_LABEL[meta.reviewCadence],
    systemProtected: meta.systemProtected,
    includeInAccessReview: meta.includeInAccessReview,
    eligibleForTemporaryElevation: meta.eligibleForTemporaryElevation,
    summary:
      `${meta.displayLabel} · ${GOVERNANCE_CATEGORY_LABEL[meta.governanceCategory]} · ` +
      `risk ${RISK_POSTURE_LABEL[meta.riskPosture]} · review ${REVIEW_CADENCE_LABEL[meta.reviewCadence]}` +
      (meta.systemProtected ? ' · system-protected' : ''),
  };
}

// ---------------------------------------------------------------------------
// 12. Privileged-action recommendation helpers (pure; advisory only — never block).
// ---------------------------------------------------------------------------

export function shouldRequireReasonForPrivilegedAction(category: PrivilegedActionCategory): boolean {
  return PRIVILEGED_ACTION_CATALOG[category].reasonRequiredRecommended;
}

export function shouldAuditPrivilegedAction(category: PrivilegedActionCategory): boolean {
  return PRIVILEGED_ACTION_CATALOG[category].auditRecommended;
}

export function shouldRecommendPimForAction(category: PrivilegedActionCategory): boolean {
  return PRIVILEGED_ACTION_CATALOG[category].pimRecommended;
}

/** Returns the future server-enforcement boundary LABEL for an action category. */
export function getFutureServerEnforcementRecommendation(category: PrivilegedActionCategory): string {
  return SERVER_ENFORCEMENT_BOUNDARY_LABEL[PRIVILEGED_ACTION_CATALOG[category].futureEnforcementTier];
}
