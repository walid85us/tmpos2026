// =============================================================================
// Phase 1.3 — Milestone 4: Access Review + Sensitive Action Reason Capture
//   (LOCAL · ADVISORY · NON-ENFORCING)
//
// This module turns the Milestone 1 ADVISORY `AccessReviewRecord` type +
// access-review derivation helpers into a usable FOUNDATION: a session-scoped
// store of access-review records with reason-required completion outcomes and a
// per-record append-only trail, plus a parallel session-scoped log of
// reason-captured SENSITIVE GOVERNANCE ACTIONS.
//
// TRUTHFUL LIMITATIONS — what this module is NOT, today:
//   - It does NOT change any current permission behavior. Recording an access
//     review outcome (even "change required") NEVER alters a role, a
//     permission, the resolver, role defaults, thresholds, or dependency
//     auto-sync. A review record is a documented governance RECORD only.
//   - It does NOT enforce anything server-side. There is no backend, no
//     middleware, no Firestore rule, and no production compliance-evidence
//     automation. These are NOT compliance certification evidence.
//   - There is NO scheduler. The "overdue / stale" label is DERIVED / LAZY only
//     (computed from the reviewed role's recommended cadence window against a
//     caller-supplied `now` — see `isAccessReviewOverdue` in
//     platformTeamGovernance). There are NO automatic reminders, NO automatic
//     review completion, and NO automatic access revocation.
//   - Persistence is SESSION-SCOPED only (sessionStorage) — not durable backend
//     state. Clearing the session clears all records.
//   - Completion / escalation / deferral / change-required outcomes REQUIRE a
//     reason and are captured in an append-only local trail. This is an
//     audit-style record only.
//   - System Owner is system-protected: a review outcome can be recorded for it
//     (it is in-scope for review of existence/ownership) but it is NEVER
//     downgraded and NO permission change is ever applied.
//
// Built on the Milestone 1 model: src/owner/platformTeamGovernance.ts.
// =============================================================================

import type { Role } from '../context/accessConfig';
import {
  PLATFORM_ROLE_CATALOG,
  ACCESS_REVIEW_STATUS_LABEL,
  isAccessReviewOverdue,
  isPlatformRoleId,
  getRecommendedReviewCadence,
  type AccessReviewRecord,
  type AccessReviewStatus,
  type PrivilegedActionCategory,
} from './platformTeamGovernance';

// ---------------------------------------------------------------------------
// Storage + change-event wiring (mirrors the platform_temporary_access_v1
// pattern: sessionStorage + a custom 'changed' event so open views refresh).
// ---------------------------------------------------------------------------

export const ACCESS_REVIEW_STORAGE_KEY = 'platform_access_review_v1';
export const ACCESS_REVIEW_CHANGED_EVENT = 'platform_access_review:changed';

export const SENSITIVE_ACTION_REASON_STORAGE_KEY = 'platform_sensitive_action_reason_v1';
export const SENSITIVE_ACTION_REASON_CHANGED_EVENT = 'platform_sensitive_action_reason:changed';

/** Standing truth label reused by the docs and the UI (Access Review). */
export const ACCESS_REVIEW_MODEL_STATUS =
  'Access review records in this phase are local/advisory governance records. They help document review ' +
  'decisions but do not automatically change roles, permissions, or server-side access. Overdue/stale labels ' +
  'are derived (no scheduler, no automatic reminders, no automatic revocation), persistence is session-scoped, ' +
  'and backend enforcement and compliance evidence automation are future/deferred.';

/** Standing truth label reused by the docs and the UI (Sensitive Action Reason Capture). */
export const SENSITIVE_ACTION_REASON_ADVISORY_LABEL =
  'Reason captured locally/advisory. This does not represent server-side enforcement or compliance certification.';

export const SENSITIVE_ACTION_REASON_MODEL_STATUS =
  'Sensitive action reason capture documents WHY an existing sensitive governance action was taken. It does NOT ' +
  'change the permission result, broaden who can act, or add server-side enforcement — it adds a local/advisory ' +
  'reason record and activity entry around an action that already happens. Not compliance certification evidence.';

// ---------------------------------------------------------------------------
// Access Review outcomes + the local trail event shape.
//
// `overdue` is a DERIVED label only (see deriveAccessReviewStatus) — it is never
// a stored outcome a reviewer selects. A reviewer chooses one of the four
// terminal outcomes below, each of which REQUIRES a reason.
// ---------------------------------------------------------------------------

export type AccessReviewOutcome =
  | 'reviewed_no_change'
  | 'reviewed_change_required'
  | 'escalated'
  | 'deferred';

export const ACCESS_REVIEW_OUTCOMES: AccessReviewOutcome[] = [
  'reviewed_no_change',
  'reviewed_change_required',
  'escalated',
  'deferred',
];

export const ACCESS_REVIEW_OUTCOME_LABEL: Record<AccessReviewOutcome, string> = {
  reviewed_no_change: 'Reviewed — No Change',
  reviewed_change_required: 'Reviewed — Change Required',
  escalated: 'Escalated',
  deferred: 'Deferred',
};

/** One append-only, reason-captured entry in a review record's local trail. */
export interface AccessReviewEvent {
  id: string;
  action: 'created' | AccessReviewOutcome;
  actor: string;
  reason: string; // findings/notes captured at this transition (created may be blank)
  at: string; // ISO timestamp
  fromStatus?: AccessReviewStatus;
  toStatus: AccessReviewStatus;
}

/**
 * Stored record = the Milestone 1 `AccessReviewRecord` (kept pristine) plus
 * local, additive display/trail fields. The extra fields never leak into the
 * resolver model — they only drive this foundation's UI and audit-style trail.
 */
export interface StoredAccessReviewRecord extends AccessReviewRecord {
  /** Raw display label for the reviewed role (truthful fallback for custom/unknown roles). */
  reviewedRoleLabel: string;
  /** Whether `reviewedRoleId` resolved to a known platform-governance catalog role. */
  reviewedRoleKnown: boolean;
  /** True only when the reviewed role is the system-protected System Owner. */
  systemProtected: boolean;
  /** Actor who created the review record (may differ from the completing reviewer). */
  createdBy: string;
  /** Advisory recommended-cadence label (display only; drives derived overdue window). */
  recommendedCadenceLabel: string;
  /** Append-only local lifecycle trail — one reason-captured entry per transition. */
  history: AccessReviewEvent[];
}

// ---------------------------------------------------------------------------
// Sensitive Action Reason Capture record (local/advisory).
// ---------------------------------------------------------------------------

export interface SensitiveActionReasonCapture {
  id: string;
  actor: string;
  /** Maps onto the Milestone 1 privileged-action catalog category. */
  actionCategory: PrivilegedActionCategory;
  actionLabel: string;
  reason: string;
  targetSubject?: string;
  targetPermission?: string;
  beforeSummary?: string;
  afterSummary?: string;
  at: string; // ISO timestamp
  /** Standing advisory/non-enforcement label, copied so a stored record reads truthfully. */
  advisoryLabel: string;
}

// ---------------------------------------------------------------------------
// Pure id / time helpers (local app code — Date.now/Math.random are fine here).
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function reasonError(reason: string | undefined | null, minLen = 3): string | null {
  return reason && reason.trim().length >= minLen
    ? null
    : `A reason of at least ${minLen} characters is required for this action.`;
}

function requiredText(value: string | undefined | null): boolean {
  return !!value && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Transition result type (functions never throw on a domain rejection — they
// return a structured ok/error so the UI can surface a truthful message).
// ---------------------------------------------------------------------------

export interface AccessReviewTransitionResult {
  ok: boolean;
  error?: string;
  record?: StoredAccessReviewRecord;
}

export interface SensitiveActionCaptureResult {
  ok: boolean;
  error?: string;
  record?: SensitiveActionReasonCapture;
}

// ---------------------------------------------------------------------------
// Storage helpers (safe; session-scoped; dispatch a change event on write).
// ---------------------------------------------------------------------------

export function readAccessReviewRecords(): StoredAccessReviewRecord[] {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [];
    const raw = window.sessionStorage.getItem(ACCESS_REVIEW_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredAccessReviewRecord[]) : [];
  } catch {
    return [];
  }
}

export function writeAccessReviewRecords(records: StoredAccessReviewRecord[]): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(ACCESS_REVIEW_STORAGE_KEY, JSON.stringify(records.slice(0, 500)));
    window.dispatchEvent(new Event(ACCESS_REVIEW_CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

export function readSensitiveActionReasons(): SensitiveActionReasonCapture[] {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [];
    const raw = window.sessionStorage.getItem(SENSITIVE_ACTION_REASON_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SensitiveActionReasonCapture[]) : [];
  } catch {
    return [];
  }
}

export function writeSensitiveActionReasons(records: SensitiveActionReasonCapture[]): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(SENSITIVE_ACTION_REASON_STORAGE_KEY, JSON.stringify(records.slice(0, 500)));
    window.dispatchEvent(new Event(SENSITIVE_ACTION_REASON_CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// 1. Create — a new review record in the 'pending' state.
//
// Validation: reviewed subject, reviewed role, review period, and reviewer/
// createdBy are required. Notes/findings are optional at creation (a reason is
// only mandatory at the completion/escalation/deferral/change-required step).
// ---------------------------------------------------------------------------

export interface AccessReviewCreateInput {
  reviewPeriod: string;
  reviewedSubjectId: string;
  reviewedSubjectName: string;
  /** Resolved platform-governance catalog role id, or null for a custom/unknown role. */
  reviewedRoleId: Role | null;
  /** Raw display label from the directory (always shown; truthful for custom roles). */
  reviewedRoleLabel: string;
  reviewerId: string;
  reviewerName: string;
  createdBy: string;
  findings?: string;
  notes?: string;
  now?: number;
}

export function createAccessReviewRecord(input: AccessReviewCreateInput): AccessReviewTransitionResult {
  if (!requiredText(input.reviewedSubjectId) || !requiredText(input.reviewedSubjectName)) {
    return { ok: false, error: 'A reviewed subject (team member) is required.' };
  }
  if (!requiredText(input.reviewedRoleLabel)) {
    return { ok: false, error: 'A reviewed role is required.' };
  }
  if (!requiredText(input.reviewPeriod)) {
    return { ok: false, error: 'A review period is required (e.g. "Q2 2026").' };
  }
  if (!requiredText(input.reviewerName) || !requiredText(input.createdBy)) {
    return { ok: false, error: 'A reviewer / createdBy is required.' };
  }

  const knownRole = input.reviewedRoleId != null && isPlatformRoleId(input.reviewedRoleId);
  // For helper consumption, fall back to the raw label cast as Role for unknown
  // roles — the M1 helpers guard with isPlatformRoleId and treat anything
  // non-catalog as the safe 'annual' cadence, so this never mis-derives.
  const reviewedRoleId: Role = (input.reviewedRoleId ?? (input.reviewedRoleLabel as Role));
  const systemProtected = knownRole && PLATFORM_ROLE_CATALOG[input.reviewedRoleId as keyof typeof PLATFORM_ROLE_CATALOG]?.systemProtected === true;

  const nowMs = input.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const record: StoredAccessReviewRecord = {
    id: genId('arr'),
    reviewPeriod: input.reviewPeriod.trim(),
    reviewerId: input.reviewerId.trim() || input.createdBy.trim(),
    reviewerName: input.reviewerName.trim(),
    reviewedSubjectId: input.reviewedSubjectId,
    reviewedSubjectName: input.reviewedSubjectName,
    reviewedRoleId,
    reviewStatus: 'pending',
    reviewedAt: undefined,
    findings: input.findings?.trim() || undefined,
    actionRequired: false,
    notes: input.notes?.trim() || undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
    reviewedRoleLabel: input.reviewedRoleLabel.trim(),
    reviewedRoleKnown: knownRole,
    systemProtected,
    createdBy: input.createdBy.trim(),
    recommendedCadenceLabel: getRecommendedReviewCadence(reviewedRoleId),
    history: [
      {
        id: genId('are'),
        action: 'created',
        actor: input.createdBy.trim(),
        reason: input.notes?.trim() || 'Review record created (pending).',
        at: nowIso,
        toStatus: 'pending',
      },
    ],
  };
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// 2. Complete — record a terminal outcome on a 'pending' (incl. derived-overdue)
//    review. Reason is REQUIRED for every outcome — no silent completion.
//
// Outcomes never change a role or permission. For System Owner the outcome is
// recorded for documentation only — it is system-protected, never downgraded,
// and no permission change is applied (the record carries that note).
// ---------------------------------------------------------------------------

export interface AccessReviewCompleteInput {
  outcome: AccessReviewOutcome;
  actor: string;
  reason: string;
  findings?: string;
  now?: number;
}

export function completeAccessReview(
  record: StoredAccessReviewRecord,
  input: AccessReviewCompleteInput
): AccessReviewTransitionResult {
  const rErr = reasonError(input.reason);
  if (rErr) return { ok: false, error: rErr };
  if (!ACCESS_REVIEW_OUTCOMES.includes(input.outcome)) {
    return { ok: false, error: `Unsupported review outcome: ${input.outcome}.` };
  }
  // Only an open review can be completed. A derived-overdue review is still a
  // stored 'pending' record (overdue is a label, not a stored state), so it
  // remains completable. Every other stored status is terminal/advisory and
  // must NOT be re-completed or auto-flipped.
  if (record.reviewStatus !== 'pending') {
    return {
      ok: false,
      error: `Only a pending review can be completed (current status: ${ACCESS_REVIEW_STATUS_LABEL[record.reviewStatus]}).`,
    };
  }

  const nowMs = input.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const actionRequired = input.outcome === 'reviewed_change_required';

  // System Owner protection note prepended to the captured findings so the
  // record always reads truthfully (no downgrade / no permission change).
  const protectionNote = record.systemProtected
    ? 'System Owner is system-protected — reviewed carefully; no automatic downgrade and no permission change applied. '
    : '';
  const advisoryNote = actionRequired
    ? 'Action required — advisory only; no permission change applied. '
    : '';

  const next: StoredAccessReviewRecord = {
    ...record,
    reviewStatus: input.outcome,
    reviewedAt: nowIso,
    actionRequired,
    reviewerId: input.actor.trim() || record.reviewerId,
    reviewerName: input.actor.trim() || record.reviewerName,
    findings: `${protectionNote}${advisoryNote}${input.findings?.trim() || record.findings || ''}`.trim() || undefined,
    notes: input.reason.trim(),
    updatedAt: nowIso,
    history: [
      ...record.history,
      {
        id: genId('are'),
        action: input.outcome,
        actor: input.actor.trim() || 'System Owner',
        reason: input.reason.trim(),
        at: nowIso,
        fromStatus: 'pending',
        toStatus: input.outcome,
      },
    ],
  };
  return { ok: true, record: next };
}

// ---------------------------------------------------------------------------
// 3. Sensitive Action Reason Capture — build a reason-captured record for an
//    EXISTING sensitive governance action. Pure: never writes; never changes
//    the permission result. The UI persists + audits the returned record.
// ---------------------------------------------------------------------------

export interface SensitiveActionCaptureInput {
  actor: string;
  actionCategory: PrivilegedActionCategory;
  actionLabel: string;
  reason: string;
  targetSubject?: string;
  targetPermission?: string;
  beforeSummary?: string;
  afterSummary?: string;
  now?: number;
}

export function captureSensitiveActionReason(input: SensitiveActionCaptureInput): SensitiveActionCaptureResult {
  const rErr = reasonError(input.reason);
  if (rErr) return { ok: false, error: rErr };
  if (!requiredText(input.actor)) return { ok: false, error: 'An actor is required.' };
  if (!requiredText(input.actionLabel)) return { ok: false, error: 'An action label is required.' };

  const nowMs = input.now ?? Date.now();
  const record: SensitiveActionReasonCapture = {
    id: genId('sar'),
    actor: input.actor.trim(),
    actionCategory: input.actionCategory,
    actionLabel: input.actionLabel.trim(),
    reason: input.reason.trim(),
    targetSubject: input.targetSubject?.trim() || undefined,
    targetPermission: input.targetPermission?.trim() || undefined,
    beforeSummary: input.beforeSummary?.trim() || undefined,
    afterSummary: input.afterSummary?.trim() || undefined,
    at: new Date(nowMs).toISOString(),
    advisoryLabel: SENSITIVE_ACTION_REASON_ADVISORY_LABEL,
  };
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Derived status / overdue (advisory only — reuses the Milestone 1 helper, so
// terminal/explicit states never auto-flip and only an aged 'pending' ages into
// 'overdue'). There is no scheduler — derivation is read-time only.
// ---------------------------------------------------------------------------

/** Effective derived status key: 'overdue' for an aged pending review, else the stored status. */
export function deriveAccessReviewStatus(
  record: StoredAccessReviewRecord,
  now: number = Date.now()
): AccessReviewStatus {
  return isAccessReviewOverdue(record, now) ? 'overdue' : record.reviewStatus;
}

/** Which outcomes are available for a record's CURRENT derived status (UI gating). */
export function availableAccessReviewActions(
  record: StoredAccessReviewRecord,
  now: number = Date.now()
): AccessReviewOutcome[] {
  const derived = deriveAccessReviewStatus(record, now);
  // pending OR derived-overdue (still a stored 'pending') can be acted on.
  return derived === 'pending' || derived === 'overdue' ? [...ACCESS_REVIEW_OUTCOMES] : [];
}

// ---------------------------------------------------------------------------
// Derived summary counts (single source — same deriveAccessReviewStatus over
// the same list, so header counts can never drift from the visible rows).
// ---------------------------------------------------------------------------

export interface AccessReviewSummary {
  total: number;
  pending: number;
  overdue: number;
  reviewed_no_change: number;
  reviewed_change_required: number;
  escalated: number;
  deferred: number;
  /** Records flagged action-required (advisory; no permission change applied). */
  actionRequired: number;
}

export function summarizeAccessReviews(
  records: StoredAccessReviewRecord[],
  now: number = Date.now()
): AccessReviewSummary {
  const summary: AccessReviewSummary = {
    total: records.length,
    pending: 0,
    overdue: 0,
    reviewed_no_change: 0,
    reviewed_change_required: 0,
    escalated: 0,
    deferred: 0,
    actionRequired: 0,
  };
  for (const r of records) {
    const s = deriveAccessReviewStatus(r, now);
    // Each derived status maps to exactly one summary bucket (no drift).
    switch (s) {
      case 'pending': summary.pending += 1; break;
      case 'overdue': summary.overdue += 1; break;
      case 'reviewed_no_change': summary.reviewed_no_change += 1; break;
      case 'reviewed_change_required': summary.reviewed_change_required += 1; break;
      case 'escalated': summary.escalated += 1; break;
      case 'deferred': summary.deferred += 1; break;
    }
    if (r.actionRequired) summary.actionRequired += 1;
  }
  return summary;
}
