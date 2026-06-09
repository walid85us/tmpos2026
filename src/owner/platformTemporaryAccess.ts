// =============================================================================
// Phase 1.3 — Milestone 3: Temporary Access / PIM Foundation
//   (LOCAL · ADVISORY · NON-ENFORCING)
//
// This module turns the Milestone 1 ADVISORY `TemporaryAccessGrant` type +
// derived/lazy status helpers into a usable FOUNDATION: a session-scoped store
// of temporary-access grants and pure, reason-required lifecycle transition
// helpers (request → approve/grant → revoke, plus deny and cancel).
//
// TRUTHFUL LIMITATIONS — what this module is NOT, today:
//   - It does NOT change any current permission behavior. It never writes
//     platform permission overrides, never calls the resolver, and is NOT
//     applied to the live `explainAccessDecision` / `getPlatformFeatureLevel`
//     decision path. A grant is a documented RECORD with a derived status —
//     it grants no real elevated access.
//   - It does NOT enforce anything server-side. There is no backend, no
//     middleware, no Firestore rule, and no production PIM/PAM.
//   - There is NO scheduler. Expiration is DERIVED / LAZY only — a grant only
//     *appears* expired when something reads it after `expiresAt` (see
//     `getTemporaryAccessStatus` in platformTeamGovernance). There is NO
//     automatic permission escalation and NO automatic permission revocation.
//   - Persistence is SESSION-SCOPED only (sessionStorage) — not durable
//     backend state. Clearing the session clears all grants.
//   - Every lifecycle transition REQUIRES a reason and is captured in an
//     append-only local history trail. This is an audit-style record only.
//
// Built on the Milestone 1 model: src/owner/platformTeamGovernance.ts.
// =============================================================================

import {
  PLATFORM_ROLE_CATALOG,
  getTemporaryAccessStatus,
  type PlatformRoleId,
  type TemporaryAccessGrant,
  type TemporaryAccessStatus,
} from './platformTeamGovernance';

// ---------------------------------------------------------------------------
// Storage + change-event wiring (mirrors the platform_permissions_v1 pattern:
// sessionStorage + a custom 'changed' event so open views can refresh).
// ---------------------------------------------------------------------------

export const TEMPORARY_ACCESS_STORAGE_KEY = 'platform_temporary_access_v1';
export const TEMPORARY_ACCESS_CHANGED_EVENT = 'platform_temporary_access:changed';

/** Standing truth label reused by the docs and the UI. */
export const TEMPORARY_ACCESS_MODEL_STATUS =
  'Temporary access is an advisory, non-enforcing PIM foundation. Granting it does NOT change a ' +
  "member's real permissions — current platform access stays UI/client-gated and is resolved by the " +
  'unchanged permissions matrix. Expiration is derived/lazy (no scheduler, no automatic revocation), ' +
  'persistence is session-scoped, and there is no server-side enforcement.';

// ---------------------------------------------------------------------------
// Lifecycle actions + the local audit-style trail event shape.
// ---------------------------------------------------------------------------

export type TemporaryAccessLifecycleAction =
  | 'request'
  | 'approve'
  | 'deny'
  | 'revoke'
  | 'cancel';

export const TEMPORARY_ACCESS_ACTION_LABEL: Record<TemporaryAccessLifecycleAction, string> = {
  request: 'Requested',
  approve: 'Approved / Granted',
  deny: 'Denied',
  revoke: 'Revoked',
  cancel: 'Cancelled',
};

/** One append-only, reason-captured entry in a grant's local lifecycle trail. */
export interface TemporaryAccessEvent {
  id: string;
  action: TemporaryAccessLifecycleAction;
  actor: string;
  reason: string;
  at: string; // ISO timestamp
  fromStatus?: TemporaryAccessStatus;
  toStatus: TemporaryAccessStatus;
}

/**
 * Stored record = the Milestone 1 `TemporaryAccessGrant` (kept pristine) plus
 * local, additive display/trail fields. The extra fields never leak into the
 * resolver model — they only drive this foundation's UI and audit-style trail.
 */
export interface StoredTemporaryAccessGrant extends TemporaryAccessGrant {
  /** Advisory label for the requested elevation target (display only — NOT applied). */
  elevatedRoleLabel?: string;
  /** Requested window length in ms; the clock is (re)anchored to approval time. */
  requestedDurationMs: number;
  /** Append-only local lifecycle trail — one reason-captured entry per transition. */
  history: TemporaryAccessEvent[];
}

// ---------------------------------------------------------------------------
// Pure id / time helpers (local app code — Date.now/Math.random are fine here).
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeEvent(
  action: TemporaryAccessLifecycleAction,
  actor: string,
  reason: string,
  toStatus: TemporaryAccessStatus,
  nowIso: string,
  fromStatus?: TemporaryAccessStatus
): TemporaryAccessEvent {
  return { id: genId('tae'), action, actor, reason, at: nowIso, toStatus, fromStatus };
}

// ---------------------------------------------------------------------------
// Storage helpers (safe; session-scoped; dispatch a change event on write).
// ---------------------------------------------------------------------------

export function readTemporaryAccessGrants(): StoredTemporaryAccessGrant[] {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return [];
    const raw = window.sessionStorage.getItem(TEMPORARY_ACCESS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredTemporaryAccessGrant[]) : [];
  } catch {
    return [];
  }
}

export function writeTemporaryAccessGrants(grants: StoredTemporaryAccessGrant[]): void {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    window.sessionStorage.setItem(TEMPORARY_ACCESS_STORAGE_KEY, JSON.stringify(grants.slice(0, 500)));
    window.dispatchEvent(new Event(TEMPORARY_ACCESS_CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// Transition result type (functions never throw on a domain rejection — they
// return a structured ok/error so the UI can surface a truthful message).
// ---------------------------------------------------------------------------

export interface TemporaryAccessTransitionResult {
  ok: boolean;
  error?: string;
  grant?: StoredTemporaryAccessGrant;
}

function reasonError(reason: string): string | null {
  return reason && reason.trim().length >= 3
    ? null
    : 'A reason of at least 3 characters is required for every temporary-access action.';
}

// ---------------------------------------------------------------------------
// Duration presets offered at request time (advisory windows only).
// ---------------------------------------------------------------------------

export interface TemporaryAccessDurationPreset {
  id: string;
  label: string;
  ms: number;
}

const HOUR = 60 * 60 * 1000;
export const TEMPORARY_ACCESS_DURATION_PRESETS: TemporaryAccessDurationPreset[] = [
  { id: '1h', label: '1 hour', ms: 1 * HOUR },
  { id: '4h', label: '4 hours', ms: 4 * HOUR },
  { id: '8h', label: '8 hours', ms: 8 * HOUR },
  { id: '24h', label: '24 hours', ms: 24 * HOUR },
  { id: '72h', label: '72 hours', ms: 72 * HOUR },
];

// ---------------------------------------------------------------------------
// 1. Request — create a new grant in the 'requested' state (reason required).
// ---------------------------------------------------------------------------

export interface TemporaryAccessRequestInput {
  subjectUserId: string;
  subjectName: string;
  subjectEmail: string;
  baseRoleId: PlatformRoleId;
  /** Advisory elevation target (catalog role id). System Owner is not allowed. */
  elevatedRoleId?: PlatformRoleId;
  elevatedRoleLabel?: string;
  elevatedPermissionScope?: string;
  requestedBy: string;
  reason: string;
  durationMs: number;
  now?: number;
}

export function createTemporaryAccessRequest(
  input: TemporaryAccessRequestInput
): TemporaryAccessTransitionResult {
  const rErr = reasonError(input.reason);
  if (rErr) return { ok: false, error: rErr };

  // System Owner is system-protected — never eligible for temporary elevation,
  // and never a valid elevation TARGET (mirrors the Milestone 1 catalog).
  if (!PLATFORM_ROLE_CATALOG[input.baseRoleId]?.eligibleForTemporaryElevation) {
    return {
      ok: false,
      error: `${PLATFORM_ROLE_CATALOG[input.baseRoleId]?.displayLabel || input.baseRoleId} is not eligible for temporary elevation (system-protected).`,
    };
  }
  if (input.elevatedRoleId === 'system_owner') {
    return { ok: false, error: 'System Owner cannot be a temporary-elevation target.' };
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    return { ok: false, error: 'A positive duration is required.' };
  }

  const nowMs = input.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // Proposed window starts now; it is RE-anchored to approval time on approve.
  const startsAt = nowIso;
  const expiresAt = new Date(nowMs + input.durationMs).toISOString();

  const grant: StoredTemporaryAccessGrant = {
    id: genId('tag'),
    subjectUserId: input.subjectUserId,
    subjectName: input.subjectName,
    subjectEmail: input.subjectEmail,
    baseRoleId: input.baseRoleId,
    elevatedRoleId: input.elevatedRoleId,
    elevatedRoleLabel: input.elevatedRoleLabel,
    elevatedPermissionScope: input.elevatedPermissionScope,
    requestedBy: input.requestedBy,
    reason: input.reason.trim(),
    startsAt,
    expiresAt,
    status: 'requested',
    createdAt: nowIso,
    updatedAt: nowIso,
    source: 'team_management_ui',
    requestedDurationMs: input.durationMs,
    history: [makeEvent('request', input.requestedBy, input.reason.trim(), 'requested', nowIso)],
  };
  return { ok: true, grant };
}

// ---------------------------------------------------------------------------
// 2. Approve / grant — 'requested' → 'active'. Re-anchors the window to NOW so
//    the time-box clock starts at approval (reason required).
// ---------------------------------------------------------------------------

export function approveTemporaryAccess(
  grant: StoredTemporaryAccessGrant,
  actor: string,
  reason: string,
  now: number = Date.now()
): TemporaryAccessTransitionResult {
  const rErr = reasonError(reason);
  if (rErr) return { ok: false, error: rErr };
  const derived = getTemporaryAccessStatus(grant, now);
  if (derived !== 'requested') {
    return { ok: false, error: `Only a requested grant can be approved (current status: ${derived}).` };
  }
  const nowIso = new Date(now).toISOString();
  const startsAt = nowIso;
  const expiresAt = new Date(now + grant.requestedDurationMs).toISOString();
  const next: StoredTemporaryAccessGrant = {
    ...grant,
    status: 'active',
    approvedBy: actor,
    startsAt,
    expiresAt,
    updatedAt: nowIso,
    history: [...grant.history, makeEvent('approve', actor, reason.trim(), 'active', nowIso, 'requested')],
  };
  return { ok: true, grant: next };
}

// ---------------------------------------------------------------------------
// 3. Deny — 'requested' → 'denied' (terminal; reason required).
// ---------------------------------------------------------------------------

export function denyTemporaryAccess(
  grant: StoredTemporaryAccessGrant,
  actor: string,
  reason: string,
  now: number = Date.now()
): TemporaryAccessTransitionResult {
  const rErr = reasonError(reason);
  if (rErr) return { ok: false, error: rErr };
  const derived = getTemporaryAccessStatus(grant, now);
  if (derived !== 'requested') {
    return { ok: false, error: `Only a requested grant can be denied (current status: ${derived}).` };
  }
  const nowIso = new Date(now).toISOString();
  const next: StoredTemporaryAccessGrant = {
    ...grant,
    status: 'denied',
    updatedAt: nowIso,
    history: [...grant.history, makeEvent('deny', actor, reason.trim(), 'denied', nowIso, 'requested')],
  };
  return { ok: true, grant: next };
}

// ---------------------------------------------------------------------------
// 4. Revoke — an ACTIVE grant → 'revoked' (terminal; reason required). This is
//    a MANUAL, operator-initiated action — there is no automatic revocation.
// ---------------------------------------------------------------------------

export function revokeTemporaryAccess(
  grant: StoredTemporaryAccessGrant,
  actor: string,
  reason: string,
  now: number = Date.now()
): TemporaryAccessTransitionResult {
  const rErr = reasonError(reason);
  if (rErr) return { ok: false, error: rErr };
  const derived = getTemporaryAccessStatus(grant, now);
  if (derived !== 'active') {
    return { ok: false, error: `Only an active grant can be revoked (current status: ${derived}).` };
  }
  const nowIso = new Date(now).toISOString();
  const next: StoredTemporaryAccessGrant = {
    ...grant,
    status: 'revoked',
    updatedAt: nowIso,
    history: [...grant.history, makeEvent('revoke', actor, reason.trim(), 'revoked', nowIso, 'active')],
  };
  return { ok: true, grant: next };
}

// ---------------------------------------------------------------------------
// 5. Cancel — a non-terminal grant (requested OR active) → 'cancelled'
//    (reason required). Distinct from deny/revoke: a self-service withdrawal.
// ---------------------------------------------------------------------------

export function cancelTemporaryAccess(
  grant: StoredTemporaryAccessGrant,
  actor: string,
  reason: string,
  now: number = Date.now()
): TemporaryAccessTransitionResult {
  const rErr = reasonError(reason);
  if (rErr) return { ok: false, error: rErr };
  const derived = getTemporaryAccessStatus(grant, now);
  if (derived !== 'requested' && derived !== 'active') {
    return { ok: false, error: `Only a requested or active grant can be cancelled (current status: ${derived}).` };
  }
  const nowIso = new Date(now).toISOString();
  const next: StoredTemporaryAccessGrant = {
    ...grant,
    status: 'cancelled',
    updatedAt: nowIso,
    history: [...grant.history, makeEvent('cancel', actor, reason.trim(), 'cancelled', nowIso, derived)],
  };
  return { ok: true, grant: next };
}

// ---------------------------------------------------------------------------
// Which actions are available for a grant's CURRENT derived status (UI gating
// helper — the transition functions re-validate, so this never bypasses them).
// ---------------------------------------------------------------------------

export function availableTemporaryAccessActions(
  grant: StoredTemporaryAccessGrant,
  now: number = Date.now()
): TemporaryAccessLifecycleAction[] {
  const derived = getTemporaryAccessStatus(grant, now);
  if (derived === 'requested') return ['approve', 'deny', 'cancel'];
  if (derived === 'active') return ['revoke', 'cancel'];
  return []; // expired / revoked / denied / cancelled are terminal for actions
}

// ---------------------------------------------------------------------------
// Derived summary counts (single source — same getTemporaryAccessStatus over
// the same list, so the header counts can never drift from the visible rows).
// ---------------------------------------------------------------------------

export interface TemporaryAccessSummary {
  total: number;
  requested: number;
  active: number;
  expired: number;
  revoked: number;
  denied: number;
  cancelled: number;
}

export function summarizeTemporaryAccess(
  grants: StoredTemporaryAccessGrant[],
  now: number = Date.now()
): TemporaryAccessSummary {
  const summary: TemporaryAccessSummary = {
    total: grants.length,
    requested: 0,
    active: 0,
    expired: 0,
    revoked: 0,
    denied: 0,
    cancelled: 0,
  };
  for (const g of grants) {
    const s = getTemporaryAccessStatus(g, now);
    summary[s] += 1;
  }
  return summary;
}
